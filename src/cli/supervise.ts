#!/usr/bin/env node
/**
 * THE RUN'S SUPERVISOR (a run that crashed — `SELECT *` of 23 M rows ran it out of V8's heap — stayed dead,
 * and the sync, the listener and every client's session with it). `mason start` in the background (src/cli/
 * background.ts) starts THIS, detached, and this starts the run (`mason start … --attach`), its terminal the
 * run's `dev.log` as before, and starts it again when it dies:
 * - only AFTER IT WAS READY: a start that fails (a wrong password, a port held) is said and exits, as before;
 * - only while its config still says it runs: `mason stop` sends SIGTERM and the run records `running: null` before it
 *   exits, so a stop is never undone; neither is a run that exits 0 on its own;
 * - never after a stop BETWEEN restarts (the Fable review of #517: the run is dead while it waits, so `mason stop` said
 *   "not running" and the run came back seconds later): it records its pid in `.mason/supervisor.json`, `mason stop` and
 *   `mason destroy` signal it when no run answers (`stopSupervisor`), and the config is read again after the wait;
 * - never over a run `mason stop` KILLED because it did not answer (on the test server the kill was recorded
 *   as a crash, "often the system out of memory"): stop signals the supervisor FIRST (`signalSupervisor`, no wait: the
 *   supervisor is waiting for the run, which is hung), then ends the run, then waits for the supervisor (`supervisorGone`),
 *   and the run's exit is a stop. The packaged CLI runs this file as `supervise.js` (cli/build.ts), and the supervisor is
 *   known by EITHER name (`isSupervisorCommand`): known by `.ts` alone, no packaged stop ever found it;
 * - never in a loop: after RESTART_LIMIT restarts within RESTART_WINDOW_MS it gives up, and says so;
 * - never ended by a full disk (issue 847): a note or a record it cannot write is held until it can be (the record
 *   written whole or not at all), a crash with no word of its own on a full disk is said as the disk's, and a run
 *   started again that cannot get ready there is started again once there is room (`ROOM_BYTES`), a stop ending the wait;
 * - on the same Postgres port, so a tool's saved connection still reaches it (the run chose it, or MASON_PG_PORT).
 * Each restart is a line in the run's log and an entry in `.mason/restarts.json` (why, when, after how long up), which
 * mason status shows. DuckDB recovers the copy from its write-ahead log: a restart costs seconds, never a fresh copy.
 *
 *   node supervise.ts <project's .mason dir> <dev.log> <the run's command…>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitWhenWritten } from "../lib/exit-when-written.ts";
import { LogReader } from "../lib/log-read.ts";
import { DISK_WAY_OUT, replaceFile, writeFailureText } from "../lib/disk-full.ts";

export const READY_LINE = "mason start: ready";
export const RESTARTS_FILE = "restarts.json";
export const SUPERVISOR_FILE = "supervisor.json";
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** the wait before each restart, by how many came before it in the window */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/** a restart as `.mason/restarts.json` records it: the shape is the events' (src/duck/events.ts), which merge them */
export type { Restart } from "../duck/events.ts";
import type { Restart } from "../duck/events.ts";

/** The restarts recorded for a project's run, oldest first ([] when none; a file that cannot be read throws: said by
 *  its reader, never hidden). */
export function readRestarts(home: string): Restart[] {
  const file = path.join(home, RESTARTS_FILE);
  if (!fs.existsSync(file)) return [];
  const v = JSON.parse(fs.readFileSync(file, "utf8")) as { restarts?: Restart[] };
  return Array.isArray(v.restarts) ? v.restarts : [];
}

/**
 * THE RUN'S RESTARTS AS ONE FACT (`/api/state` `engine.restarts`, mason status's `Restarts` line, with Mason up or
 * stopped): how many its supervisor recorded (it keeps the last 20) and the last one — when, why, after how long up —
 * or why the record could not be read (said, never taken as none).
 */
export type RestartsFact = { count: number; last: { at: string; why: string; upSeconds: number } | null } | { error: string };

export function restartsFact(home: string, read: () => Restart[] = () => readRestarts(home)): RestartsFact {
  let r: Restart[];
  try { r = read(); }
  // unreadable (cut short by an older Mason on a full disk, issue 847; edited): said as such, and the rest of the status
  // goes on; the supervisor writes it whole again at its next restart
  catch (e) { return { error: `${path.join(home, RESTARTS_FILE)} is unreadable (${(e as Error).message}): its supervisor writes it again at the next restart` }; }
  const last = r[r.length - 1];
  return { count: r.length, last: last === undefined ? null : { at: last.at, why: last.reason, upSeconds: last.upSeconds } };
}

/** under this many bytes free, the disk that holds .mason/ is read as full: a run that died then without a word of its
 *  own (its FATAL line itself could not be written) is said as the disk's */
export const FULL_DISK_BYTES = 1024 * 1024;
/** the room a run started again waits for when it could not get ready with less than this free (its start writes its
 *  config, the engine its write-ahead log: one that fails again with less free waits again, one that fails with more
 *  is given up on, its cause not the disk), and how often it is looked at */
export const ROOM_BYTES = 8 * 1024 * 1024;
export const DISK_WAIT_MS = 10_000;

/** Why a run died, in the words a person reads: V8's own fatal line when it printed one; with none, the disk's when
 *  `freeBytes` (the disk that holds .mason/, as read just after it died; null when it could not be read) says it is full */
export function crashReason(code: number | null, signal: NodeJS.Signals | null, fatal: string | null, freeBytes: number | null = null): string {
  if (fatal === null && freeBytes !== null && freeBytes < FULL_DISK_BYTES) {
    return `${crashReason(code, signal, null)}, with ${freeBytes} bytes free where .mason/ is: ${DISK_WAY_OUT}`;
  }
  // Mason's own fatal line (src/cli/dev.ts: the engine stopped) is said as Mason said it
  if (fatal !== null) return /heap out of memory/i.test(fatal) && !fatal.startsWith("Mason: ") ? "it ran out of JavaScript heap (V8: heap out of memory)"
    : fatal.startsWith("Mason: ") ? fatal.slice("Mason: ".length) : `V8: ${fatal}`;
  if (signal === "SIGKILL") return "it was killed (SIGKILL: often the system out of memory)";
  if (signal !== null) return `it crashed (${signal})`;
  return `it exited with code ${code}`;
}

interface Running { pid: number; postgresUrl?: string }

/** Whether a process's command line (ps) is a run's supervisor: this file, by its checkout name or its packaged one. */
export function isSupervisorCommand(command: string): boolean {
  return /supervise\.[tj]s\b/.test(command);
}

/** The supervisor recorded for a project's run, when it is still alive and is a supervisor (a pid alone is no proof:
 *  after a reboot the number is another process's, src/cli/runs.ts), else null. */
export function supervisorOf(home: string): number | null {
  const file = path.join(home, SUPERVISOR_FILE);
  if (!fs.existsSync(file)) return null;
  let pid: unknown;
  // a file that cannot be read names no process: nothing is signalled over it (ps below is what decides, never the file)
  try { pid = (JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown }).pid; } catch { return null; }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  // ps exits 1 for a pid that is gone; its command line names this file for a supervisor (background.ts starts it so)
  return ps.status === 0 && isSupervisorCommand(ps.stdout) ? pid : null;
}

/** Tells the project's supervisor to stop (SIGTERM: it passes it to the run and starts nothing after); its pid, or
 *  null when there is none. It does not wait: a supervisor over a hung run leaves only once the run is ended. */
export function signalSupervisor(home: string): number | null {
  const pid = supervisorOf(home);
  if (pid === null) return null;
  process.kill(pid, "SIGTERM");
  return pid;
}

/** Waits for a signalled supervisor to leave; one still there after `ms` is said, never reported gone. */
export async function supervisorGone(home: string, pid: number, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (supervisorOf(home) === pid && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (supervisorOf(home) === pid) throw new Error(`the supervisor of Mason's run (pid ${pid}) is still running after ${ms / 1000} s: kill ${pid}`);
}

/** Stops the project's supervisor when one is waiting to start the run again; its pid, or null when there was none. */
export async function stopSupervisor(home: string, ms = 10_000): Promise<number | null> {
  const pid = signalSupervisor(home);
  if (pid === null) return null;
  await supervisorGone(home, pid, ms);
  return pid;
}

/** whether the run's config still says it runs (a stop records null first) */
function stillRunning(home: string, note: (line: string) => void): Running | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { running?: Running | null };
    return c.running ?? null;
  } catch (e) {
    // a config that cannot be read is no run that claims to be up: nothing is restarted over it, and it is said
    note(`.mason/config.json could not be read (${(e as Error).message}): not starting the run again`);
    return null;
  }
}

/** What the run wrote to the log from `from` on: whether it said it was ready, and V8's fatal line if it printed one.
 *  Read after it exits, in chunks, through the one reader (src/lib/log-read.ts: each line whole, masked): a run's log
 *  with every statement traced (MASON_PG_TRACE) runs to hundreds of MB. */
export function scanLog(file: string, from: number): { ready: boolean; fatal: string | null } {
  let ready = false;
  let fatal: string | null = null;
  const reader = new LogReader(file, { from });
  const scan = (text: string): void => {
    for (const l of text.split("\n")) {
      if (l === READY_LINE) ready = true;
      const f = /^FATAL ERROR: (.*)$/.exec(l.trim());
      if (f) fatal = f[1]!;
    }
  };
  for (let text = reader.read(); text !== null; text = reader.read()) scan(text);
  scan(reader.rest());
  return { ready, fatal };
}

export interface SuperviseOptions {
  home: string;
  /** the run's terminal: the run writes to it directly (a pipe on macOS is written asynchronously, and a run that
   *  aborts — V8 out of heap — would lose what it had queued), and so does every line of the supervisor's */
  logFile: string;
  /** starts the run once, its stdout and stderr the log's `fd`, with these extra variables */
  start: (env: Record<string, string>, fd: number) => ChildProcess;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** the supervisor's own writes (a test's that fail for disk space): a note to the log's descriptor, a record replaced
   *  whole (src/lib/disk-full.ts replaceFile), and the bytes free where .mason/ is */
  io?: { note?: (fd: number, text: string) => void; replace?: (file: string, text: string) => void; freeBytes?: (dir: string) => number };
}

/** how many notes the supervisor holds while the log cannot be written (the oldest go first past it) */
const HELD_NOTES = 50;

/** Runs the run until it stops for good; the exit code is the last run's (a start that failed: its own). */
export async function supervise(o: SuperviseOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fd = fs.openSync(o.logFile, "a", 0o600);
  // the whole line, or a throw: a write cut short on a disk that fills writes the rest, or meets the ENOSPC
  const writeNote = o.io?.note ?? ((d: number, text: string): void => { const b = Buffer.from(text); for (let at = 0; at < b.length;) at += fs.writeSync(d, b, at); });
  const replace = o.io?.replace ?? ((file: string, text: string): void => { replaceFile(file, text, 0o600); });
  const freeBytes = o.io?.freeBytes ?? ((dir: string): number => { const st = fs.statfsSync(dir); return st.bavail * st.bsize; });
  // A NOTE THAT CANNOT BE WRITTEN NEVER ENDS THE SUPERVISOR (issue 847: its log is dev.log, on the disk that holds
  // .mason/, and a full disk threw from here and left nothing to restart the run): held, with why, and written before
  // the next note once the log takes it — the supervisor has no other place to say it, stderr being the same file
  const held: string[] = [];
  /** why the log could not be written, said first once it can; and how many held notes were dropped meanwhile */
  let failure: string | null = null;
  let dropped = 0;
  const note = (line: string): void => {
    held.push(`mason supervisor: ${line}\n`);
    if (held.length > HELD_NOTES) { held.shift(); dropped++; }
    try {
      if (failure !== null) {
        writeNote(fd, `${failure}${dropped > 0 ? ` (${dropped} older one(s) dropped)` : ""}\n`);
        failure = null;
        dropped = 0;
      }
      while (held.length > 0) { writeNote(fd, held[0]!); held.shift(); }
    } catch (e) {
      failure ??= `mason supervisor: ${writeFailureText(o.logFile, e)}; the notes after this one were held until it could be`;
    }
  };
  let stopping = false;
  let child: ChildProcess | null = null;
  let wake = (): void => undefined;
  const stopped = new Promise<void>((r) => { wake = r; });
  // a signal to the supervisor (a shutdown, the terminal's group, mason stop between restarts) is the run's: passed on,
  // the wait before a restart cut short, and nothing restarted after
  const pass = (s: NodeJS.Signals) => (): void => { stopping = true; child?.kill(s); wake(); };
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((s) => [s, pass(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  /** waits until there is room where .mason/ is (true), or a stop (false: a signal, or a config that no longer says it
   *  runs); a disk that cannot be read is no room, said once, and waited on */
  const roomOrStop = async (): Promise<boolean> => {
    let unreadSaid = false;
    for (;;) {
      await Promise.race([sleep(DISK_WAIT_MS), stopped]);
      if (stopping || stillRunning(o.home, note) === null) return false;
      try {
        const free = freeBytes(o.home);
        if (free >= ROOM_BYTES) { note(`${Math.round(free / 1024 ** 2)} MiB are free where ${o.home} is: starting the run again`); return true; }
      } catch (e) {
        if (!unreadSaid) note(`the free disk where ${o.home} is could not be read (${(e as Error).message}): still waiting for room`);
        unreadSaid = true;
      }
    }
  };
  const recent: number[] = [];
  /** the restarts as this supervisor last recorded them: what it writes from when the file cannot be read */
  let kept: Restart[] = [];
  let keptAhead = false;
  let env: Record<string, string> = {};
  const mine = path.join(o.home, SUPERVISOR_FILE);
  // its pid, for mason stop between restarts; one that cannot be written (a full disk) is noted and the supervisor goes
  // on: a stop between restarts is still read from the config after the wait (`stillRunning`)
  try { replace(mine, `${JSON.stringify({ pid: process.pid })}\n`); }
  catch (e) { note(`${writeFailureText(mine, e)}; a mason stop between restarts is read from the config instead`); }
  // a restart its record missed (a full disk) is written at the next start of the run and as the supervisor ends: said
  // either way
  const writeMissed = (): void => {
    if (!keptAhead) return;
    const record = path.join(o.home, RESTARTS_FILE);
    try {
      replace(record, `${JSON.stringify({ restarts: kept }, null, 2)}\n`);
      keptAhead = false;
      note(`${RESTARTS_FILE} is written now, with the restart(s) it missed`);
    } catch (e) { note(`${writeFailureText(record, e)}: the restart(s) it missed are written when it can be`); }
  };
  try {
    for (;;) {
      writeMissed();
      const started = now();
      const from = fs.fstatSync(fd).size;
      child = o.start(env, fd);
      const c = child;
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => c.once("exit", (code, signal) => resolve({ code, signal })));
      const { ready, fatal } = scanLog(o.logFile, from);
      // why it ended. With no word of its own, the disk is read: a run on a full disk could not write its FATAL line (a
      // disk that cannot be read says nothing of it, and that is said)
      let free: number | null = null;
      const why = (): string => {
        if (fatal === null) {
          try { free = freeBytes(o.home); }
          catch (e) { note(`the free disk where ${o.home} is could not be read (${(e as Error).message}): why the run ended is said without it`); }
        }
        return crashReason(code, signal, fatal, free);
      };
      // a run started AGAIN that did not get ready (the synced data cannot be opened: a disk still full) is said here
      // too: nobody reads its own lines any more, mason start returned long ago
      if (!stopping && !ready && recent.length > 0) {
        const reason = why();
        // A FULL DISK IS WAITED OUT, never given up on (issue 847: the restart into it failed, the supervisor gave up,
        // and nothing it said could be written): the run is started again once there is room, the wait cut short by a stop
        if (free !== null && free < ROOM_BYTES) {
          note(`the run started again did not get ready (${reason}): it is started again once ${ROOM_BYTES / 1024 ** 2} MiB are free there, ` +
            `looked at every ${DISK_WAIT_MS / 1000} s (mason stop stops the wait)`);
          if (await roomOrStop()) continue;
          return code ?? 1;
        }
        note(`the run started again did not get ready (${reason}): not starting it again. mason logs --start shows why; mason start starts it`);
      }
      if (stopping || !ready || (code === 0 && signal === null)) return code ?? 1;
      const running = stillRunning(o.home, note);
      if (running === null) return code ?? 1;
      // died after it was ready, while its config says it runs: a crash
      const reason = why();
      const upSeconds = Math.round((now() - started) / 1000);
      while (recent.length > 0 && now() - recent[0]! > RESTART_WINDOW_MS) recent.shift();
      if (recent.length >= RESTART_LIMIT) {
        note(`the run stopped (${reason}) after ${upSeconds} s, its ${RESTART_LIMIT + 1}th crash in ${RESTART_WINDOW_MS / 60_000} minutes: not restarting again. mason logs --start shows why; mason start starts it`);
        return code ?? 1;
      }
      const wait = BACKOFF_MS[Math.min(recent.length, BACKOFF_MS.length - 1)]!;
      recent.push(now());
      // the record is for mason status; one that cannot be read (cut short, edited) never costs the run its restart:
      // said in the log, and the record starts again from what this supervisor recorded itself
      // (and while a write of it failed, the file is behind: what this supervisor kept is read instead)
      let before = kept;
      if (!keptAhead) {
        try { before = readRestarts(o.home); }
        catch (e) { note(`${RESTARTS_FILE} could not be read (${(e as Error).message}): it is written again from this restart`); }
      }
      // the same cause as the restart before it (a disk still full, issue 830): said, so a loop is never silent
      const again = before[before.length - 1]?.reason === reason ? ", the same as its last restart: what stopped it is still there" : "";
      kept = [...before, { at: new Date(now()).toISOString(), reason, upSeconds }].slice(-20);
      // written whole or not at all (issue 847: a full disk left it empty, and the supervisor died of the throw): one
      // that cannot be written is noted, kept here, and written with the next restart; the restart goes on
      const record = path.join(o.home, RESTARTS_FILE);
      let unrecorded = "";
      try { replace(record, `${JSON.stringify({ restarts: kept }, null, 2)}\n`); keptAhead = false; }
      catch (e) { keptAhead = true; unrecorded = `; ${writeFailureText(record, e)}, so mason status does not show this restart until it is (tried again as the run starts again, and as the supervisor ends)`; }
      note(`the run stopped (${reason}) after ${upSeconds} s${again}: starting it again in ${wait / 1000} s (mason status shows each restart)${unrecorded}`);
      // the same Postgres port, so a client's saved connection reaches the new run
      const port = running.postgresUrl === undefined ? "" : new URL(running.postgresUrl.replace(/^postgres(ql)?:/, "http:")).port;
      env = port !== "" && !process.env.MASON_PG_PORT ? { MASON_PG_PORT: port } : {};
      await Promise.race([sleep(wait), stopped]);
      // a stop while it waited (a signal), or a config that no longer says it runs (mason destroy cleared it)
      if (stopping || stillRunning(o.home, note) === null) return code ?? 1;
    }
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
    writeMissed();
    // only our own record goes: a new mason start may have started a supervisor of its own meanwhile
    try { if ((JSON.parse(fs.readFileSync(mine, "utf8")) as { pid?: unknown }).pid === process.pid) fs.rmSync(mine); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") note(`${SUPERVISOR_FILE} could not be removed (${(e as Error).message})`); }   // gone already: mason destroy emptied .mason/
    fs.closeSync(fd);
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }   // argv[1] names no file (node -e): not run as a script
}

if (isMain()) {
  const [home, logFile, command, ...args] = process.argv.slice(2);
  if (home === undefined || logFile === undefined || command === undefined) {
    process.stderr.write("usage: supervise.ts <.mason dir> <dev.log> <the run's command…>\n");
    exitWhenWritten(2);
  } else {
    exitWhenWritten(await supervise({ home, logFile,
      start: (env, fd) => spawn(command, args, { stdio: ["ignore", fd, fd], env: { ...process.env, ...env } }) }));
  }
}
