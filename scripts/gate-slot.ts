#!/usr/bin/env node
/**
 * A FEW HEAVY GATES AT ONCE ON ONE MACHINE (CLAUDE.md "Local gates"; docs/DESIGN.md "Local gates"). Several sessions
 * share one laptop, and every `node --test` already fills its cores: gates run side by side finish later than gates run
 * in turn, and load-sensitive tests fail, which causes more runs. So a heavy gate takes a slot first, and waits for one
 * in a queue that says who it waits for.
 *
 *   scripts/gate-slot.ts <command> [args...]     runs the command in a slot; exits with the command's code
 *
 *   MASON_GATE_SLOTS  how many gates run at once (default below; a positive integer, anything else refuses)
 *   MASON_GATE_DIR    the folder of the queue (default: /tmp/mason-gate-slots-<uid>)
 *
 * THE QUEUE is a folder of tickets, oldest first; the first MASON_GATE_SLOTS live tickets hold the slots. It is the
 * bakery algorithm, so that it needs no lock of its own:
 *   - `draft-<pid>` says "I am taking a number": written BEFORE the numbers are read, and removed only after the ticket
 *     exists. A run waits for every live draft before it believes its place, so a run that read the numbers before this
 *     one's ticket appeared (and so may hold the same number) cannot be missed: two runs cannot both think they are first.
 *   - `<n>-<pid>.ticket` is the draft hard-linked to its number: it appears whole or not at all, so a ticket that does
 *     not parse is damage, never a run halfway through writing it. Equal numbers are ordered by pid.
 *   - A ticket whose PID is dead is cleared by whoever sees it first. Its name carries that PID, so the removal can only
 *     ever hit the dead run's own ticket, never one a live run took in its place. "Could not tell" keeps the ticket.
 *
 * THE FOLDER IS /tmp, NOT os.tmpdir(): that follows $TMPDIR, which is per session in a sandbox, and each session would
 * then queue alone. One user's: another user's gates are not seen.
 *
 * THE COMMAND DOES NOT RUN WITHOUT A SLOT. A failure of the queue itself exits LOCK_FAILED, with the way out; it never
 * falls through to running unqueued, and never reports success, even when the command passed.
 *
 * A PID reused by an unrelated process keeps a stale ticket alive until that process ends: a wait that errs long, which
 * the waiting lines show (each names the ticket's PID, its age and its folder).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

/** Measured, docs/DESIGN.md "Local gates": the most gates at once before the machine does less work per hour. */
const DEFAULT_SLOTS = 2;
const LOOK_EVERY_MS = 250;
const SAY_EVERY_MS = 30_000;
/** The queue failed. Neither a command's code nor a test failure's: a caller's `&&` stops on it like any other. */
const LOCK_FAILED = 3;

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: scripts/gate-slot.ts <command> [args...]\n\nruns the command in one of MASON_GATE_SLOTS machine-wide slots, waiting for one if they are taken");
  process.exit(2);
}
const label = command.join(" ");
const DIR = process.env.MASON_GATE_DIR ?? path.join("/tmp", `mason-gate-slots-${process.getuid?.() ?? "user"}`);

interface Ticket { file: string; n: number; pid: number; started: number; cwd: string; command: string }

let mine: string | null = null;
let draft: string | null = null;
let child: ChildProcess | null = null;

function say(line: string): void { console.error(`[gate] ${line}`); }

/** The queue failed before the command ran: no verdict on the tree, and the two ways out. */
function failedBefore(what: string): never {
  say(`no slot, so nothing ran and this says nothing about the tree: ${what}`);
  say(`to go on: repair ${DIR} (MASON_GATE_DIR moves it), or run the command without a slot: ${label}`);
  process.exit(LOCK_FAILED);
}

function message(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function errno(e: unknown): string | undefined { return (e as NodeJS.ErrnoException).code; }

/** Is this PID running? Only ESRCH says no. EPERM is a process of another user's, so a yes; anything else is "could not tell". */
function pidState(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    if (errno(e) === "ESRCH") return "dead";
    return errno(e) === "EPERM" ? "alive" : "unknown";
  }
}

function readTicket(file: string, n: number, pidInName: number): Ticket | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return null; // released between the listing and this read: the normal case
    throw e;
  }
  let t: Partial<Ticket>;
  try {
    t = JSON.parse(text) as Partial<Ticket>;
  } catch (e) {
    throw new Error(`${file} is not a ticket (${message(e)})`, { cause: e });
  }
  if (t.pid !== pidInName || typeof t.started !== "number" || typeof t.cwd !== "string" || typeof t.command !== "string") {
    throw new Error(`${file} is not a ticket (its fields do not hold together)`);
  }
  return { file, n, pid: pidInName, started: t.started, cwd: t.cwd, command: t.command };
}

const NAME = /^(\d+)-([1-9]\d*)\.ticket$/;
const DRAFT = /^draft-([1-9]\d*)$/;

/** The live tickets, oldest first, the dead ones cleared; and the drafts of the runs still taking a number. */
function look(): { tickets: Ticket[]; drafting: number[] } {
  // Drafts FIRST, in a listing of their own: a draft goes only once its ticket exists, so one gone from this listing
  // has its ticket in the next. One listing could miss both, the ticket before it appears and the draft after it goes.
  const drafting: number[] = [];
  for (const name of fs.readdirSync(DIR)) {
    const pid = DRAFT.exec(name)?.[1];
    if (pid === undefined || Number(pid) === process.pid) continue;
    if (pidState(Number(pid)) === "dead") fs.rmSync(path.join(DIR, name), { force: true });
    else drafting.push(Number(pid));
  }
  const tickets: Ticket[] = [];
  for (const name of fs.readdirSync(DIR)) {
    const m = NAME.exec(name);
    if (!m) continue;
    const t = readTicket(path.join(DIR, name), Number(m[1]), Number(m[2]));
    if (t === null) continue;
    if (pidState(t.pid) === "dead") {
      fs.rmSync(t.file, { force: true });
      say(`cleared a stale slot: pid ${t.pid} is dead (${t.command}, in ${t.cwd})`);
      continue;
    }
    tickets.push(t);
  }
  tickets.sort((a, b) => a.n - b.n || a.pid - b.pid);
  return { tickets, drafting };
}

function takeTicket(): string {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid: process.pid, started: Date.now(), cwd: process.cwd(), command: label });
  const d = path.join(DIR, `draft-${process.pid}`);
  fs.writeFileSync(d, body);
  draft = d;
  const n = Math.max(0, ...look().tickets.map((t) => t.n)) + 1;
  const file = path.join(DIR, `${n}-${process.pid}.ticket`);
  fs.linkSync(d, file);
  mine = file;
  fs.unlinkSync(d);
  draft = null;
  return file;
}

function ago(from: number): string {
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function sayWaiting(tickets: readonly Ticket[], place: number, slots: number, drafting: readonly number[], since: number): void {
  const holders = tickets.slice(0, Math.min(place, slots));
  const ahead = place - holders.length;
  say(`waiting for a slot for ${ago(since)}: ${holders.length} of ${slots} taken${ahead > 0 ? `, ${ahead} ahead in the queue` : ""}${drafting.length > 0 ? `, pid ${drafting.join(", ")} taking a number` : ""} (queue: ${DIR})`);
  for (const h of holders) say(`  pid ${h.pid} for ${ago(h.started)}: ${h.command} (in ${h.cwd})`);
}

async function waitForSlot(slots: number, file: string): Promise<void> {
  const since = Date.now();
  let said = 0;
  for (;;) {
    const { tickets, drafting } = look();
    const place = tickets.findIndex((t) => t.file === file);
    if (place < 0) throw new Error(`this run's ticket ${file} is gone from the queue: something else removed it`);
    if (place < slots && drafting.length === 0) {
      if (said > 0) say(`slot taken after ${ago(since)}`);
      return;
    }
    if (Date.now() - said >= SAY_EVERY_MS) {
      sayWaiting(tickets, place, slots, drafting, since);
      said = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

/** Gives the slot back. Says what went wrong instead of throwing: the caller decides what the exit is. */
function release(): string | null {
  if (mine === null) return null;
  const file = mine;
  mine = null;
  try {
    fs.unlinkSync(file);
    return null;
  } catch (e) {
    return errno(e) === "ENOENT" ? `its ticket ${file} was removed while it ran, so the limit did not hold` : message(e);
  }
}

function runCommand(): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
    child = c;
    c.once("error", (e) => {
      say(`${label}: could not start: ${e.message}`);
      resolve(127);
    });
    c.once("close", (code, signal) => {
      resolve(code ?? 128 + (signal === null ? 0 : os.constants.signals[signal]));
    });
  });
}

// the exit paths that skip release() (a refusal, a throw); removing nothing that is gone is what force says
process.on("exit", () => {
  for (const file of [mine, draft]) if (file !== null) fs.rmSync(file, { force: true });
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // running: the command is told and this exits with it, holding the slot until the load is really gone
    if (child !== null) child.kill(signal);
    else process.exit(128 + os.constants.signals[signal]);
  });
}

const raw = process.env.MASON_GATE_SLOTS;
if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) {
  failedBefore(`MASON_GATE_SLOTS is ${JSON.stringify(raw)}, and it must be a positive integer (leave it unset for ${DEFAULT_SLOTS})`);
}
const slots = raw === undefined ? DEFAULT_SLOTS : Number(raw);

try {
  await waitForSlot(slots, takeTicket());
} catch (e) {
  failedBefore(message(e));
}
const exit = await runCommand();
const lost = release();
if (lost !== null) {
  say(`the slot failed, so the exit is not the command's ${exit}: ${lost}`);
  process.exit(LOCK_FAILED);
}
process.exit(exit);
