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

export const READY_LINE = "mason start: ready";
export const RESTARTS_FILE = "restarts.json";
export const SUPERVISOR_FILE = "supervisor.json";
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** the wait before each restart, by how many came before it in the window */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export interface Restart { at: string; reason: string; upSeconds: number }

/** The restarts recorded for a project's run, oldest first ([] when none; a file that cannot be read is said, not hidden). */
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
  catch (e) { return { error: `${path.join(home, RESTARTS_FILE)} could not be read: ${(e as Error).message}` }; }
  const last = r[r.length - 1];
  return { count: r.length, last: last === undefined ? null : { at: last.at, why: last.reason, upSeconds: last.upSeconds } };
}

/** Why a run died, in the words a person reads: V8's own fatal line when it printed one */
export function crashReason(code: number | null, signal: NodeJS.Signals | null, fatal: string | null): string {
  // Mason's own fatal line (src/cli/dev.ts: the copy's thread stopped) is said as Mason said it
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
 *  Read after it exits, in chunks: a run's log with every statement traced (MASON_PG_TRACE) runs to hundreds of MB. */
export function scanLog(file: string, from: number): { ready: boolean; fatal: string | null } {
  let ready = false;
  let fatal: string | null = null;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let partial = "";
    for (let at = from; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      const lines = (partial + buf.toString("utf8", 0, n)).split("\n");
      partial = n === 0 ? "" : lines.pop() ?? "";
      for (const l of lines) {
        if (l === READY_LINE) ready = true;
        const f = /^FATAL ERROR: (.*)$/.exec(l.trim());
        if (f) fatal = f[1]!;
      }
      if (n === 0) break;
      at += n;
    }
  } finally { fs.closeSync(fd); }
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
}

/** Runs the run until it stops for good; the exit code is the last run's (a start that failed: its own). */
export async function supervise(o: SuperviseOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fd = fs.openSync(o.logFile, "a", 0o600);
  const note = (line: string): void => { fs.writeSync(fd, `mason supervisor: ${line}\n`); };
  let stopping = false;
  let child: ChildProcess | null = null;
  let wake = (): void => undefined;
  const stopped = new Promise<void>((r) => { wake = r; });
  // a signal to the supervisor (a shutdown, the terminal's group, mason stop between restarts) is the run's: passed on,
  // the wait before a restart cut short, and nothing restarted after
  const pass = (s: NodeJS.Signals) => (): void => { stopping = true; child?.kill(s); wake(); };
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((s) => [s, pass(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  const recent: number[] = [];
  let env: Record<string, string> = {};
  const mine = path.join(o.home, SUPERVISOR_FILE);
  fs.writeFileSync(mine, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
  try {
    for (;;) {
      const started = now();
      const from = fs.fstatSync(fd).size;
      child = o.start(env, fd);
      const c = child;
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => c.once("exit", (code, signal) => resolve({ code, signal })));
      const { ready, fatal } = scanLog(o.logFile, from);
      if (stopping || !ready || (code === 0 && signal === null)) return code ?? 1;
      const running = stillRunning(o.home, note);
      if (running === null) return code ?? 1;
      // died after it was ready, while its config says it runs: a crash
      const reason = crashReason(code, signal, fatal);
      const upSeconds = Math.round((now() - started) / 1000);
      while (recent.length > 0 && now() - recent[0]! > RESTART_WINDOW_MS) recent.shift();
      if (recent.length >= RESTART_LIMIT) {
        note(`the run stopped (${reason}) after ${upSeconds} s, its ${RESTART_LIMIT + 1}th crash in ${RESTART_WINDOW_MS / 60_000} minutes: not restarting again. mason logs --start shows why; mason start starts it`);
        return code ?? 1;
      }
      const wait = BACKOFF_MS[Math.min(recent.length, BACKOFF_MS.length - 1)]!;
      recent.push(now());
      let before: Restart[] = [];
      // the record is for mason status; one that cannot be read (cut short, edited) never costs the run its restart:
      // said in the log, and the record starts again from this restart
      try { before = readRestarts(o.home); }
      catch (e) { note(`${RESTARTS_FILE} could not be read (${(e as Error).message}): it is written again from this restart`); }
      const restarts = [...before, { at: new Date(now()).toISOString(), reason, upSeconds }].slice(-20);
      fs.writeFileSync(path.join(o.home, RESTARTS_FILE), `${JSON.stringify({ restarts }, null, 2)}\n`, { mode: 0o600 });
      note(`the run stopped (${reason}) after ${upSeconds} s: starting it again in ${wait / 1000} s (mason status shows each restart)`);
      // the same Postgres port, so a client's saved connection reaches the new run
      const port = running.postgresUrl === undefined ? "" : new URL(running.postgresUrl.replace(/^postgres(ql)?:/, "http:")).port;
      env = port !== "" && !process.env.MASON_PG_PORT ? { MASON_PG_PORT: port } : {};
      await Promise.race([sleep(wait), stopped]);
      // a stop while it waited (a signal), or a config that no longer says it runs (mason destroy cleared it)
      if (stopping || stillRunning(o.home, note) === null) return code ?? 1;
    }
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
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
