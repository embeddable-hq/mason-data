/**
 * COLOUR AND WIDTH, for a person at a terminal only (a little colour makes output easier to read and scan). One
 * palette everywhere:
 *
 *   bold     a step's heading, the Next heading, a command's one-line headline
 *   cyan     what you can type (a command, under Next and in `mason --help`)
 *   dim      a description, a tip, a secondary fact
 *   green / red / yellow   a state only: ok and ready, failed, under way or unsure
 *
 * and lines wrapped at the terminal's width with a hanging indent, so a long description continues under its own
 * column instead of under the command names.
 *
 * Styled only when the stream is a terminal and NO_COLOR is unset (https://no-color.org); FORCE_COLOR forces it.
 * Piped, redirected, under --json, or read by a coding agent, every command prints plain, unwrapped text — what an agent
 * parses never changes. tests/conventions.test.ts refuses a colour code written anywhere else in src/cli.
 */

import * as fs from "node:fs";
import { Worker } from "node:worker_threads";

export interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  /** the terminal's width to wrap at; null: never wrap (not a terminal) */
  width: number | null;
}

const sgr = (on: number, off: number) => (s: string): string => s === "" ? s : `\x1b[${on}m${s}\x1b[${off}m`;
const plainText = (s: string): string => s;

/** No colour, no wrapping: what a pipe, a file, a test and a coding agent read. */
export const PLAIN: Style = { bold: plainText, dim: plainText, cyan: plainText, green: plainText, red: plainText, yellow: plainText, width: null };

const COLOUR: Omit<Style, "width"> = {
  bold: sgr(1, 22), dim: sgr(2, 22), cyan: sgr(36, 39), green: sgr(32, 39), red: sgr(31, 39), yellow: sgr(33, 39),
};

/** The stream a style is for: its being a terminal, and its width. */
export interface Stream { isTTY?: boolean; columns?: number }

/** Whether to colour `stream`: FORCE_COLOR (not "0") forces it, NO_COLOR (any value) or a non-terminal turns it off. */
export function colourOn(stream: Stream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return stream.isTTY === true;
}

/** The style for a stream: colour when colourOn, and its width when it is a terminal that says one. */
export function styleFor(stream: Stream, env: NodeJS.ProcessEnv = process.env): Style {
  const width = stream.isTTY === true && stream.columns !== undefined && stream.columns >= 40 ? stream.columns : null;
  return colourOn(stream, env) ? { ...COLOUR, width } : { ...PLAIN, width };
}

/** stdout's style (what a command prints) and stderr's (its progress), read when first asked. */
export const out = (): Style => styleFor(process.stdout);
export const err = (): Style => styleFor(process.stderr);

/** A string's length as the terminal shows it: without its colour codes. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * `text` wrapped at `width`, every line after the first indented by `indent` spaces — the first line's own prefix is the
 * caller's (`  mason init      ` before a description). A word longer than a line is left whole. Null width: unwrapped.
 */
export function wrap(text: string, width: number | null, indent: number, firstUsed = indent): string {
  if (width === null) return text;
  const room = (used: number): number => Math.max(20, width - used - 1);
  const lines: string[] = [];
  let line = "", used = firstUsed;
  for (const word of text.split(" ")) {
    if (line && visibleLength(line) + 1 + visibleLength(word) > room(used)) { lines.push(line); line = word; used = indent; }
    else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(indent)}`);
}

/** The spinner's frames, and how long a command may be quiet before it shows. */
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const SPIN_AFTER_MS = 300;

/**
 * A SPINNER WHILE A COMMAND IS QUIET (`mason list` took a couple of seconds to answer, with nothing on the screen; any
 * command that does not answer at once shows it is working): every command runs under
 * it (src/cli/main.ts), so none is left out. On a terminal (stderr), once the command has printed nothing for
 * SPIN_AFTER_MS, `⠋ mason tables …` turns until it prints anything — on stdout or stderr — or ends; the line is cleared
 * before the command's own output, so nothing it prints is ever beside a spinner. A command that answers at once shows
 * none, and a pipe, a file or a coding agent's shell never sees one. Returns the stop (idempotent).
 *
 * IT TURNS ON A THREAD OF ITS OWN (the first spinner never showed on `mason list`): `mason list` spent
 * its whole run inside `spawnSync("docker", …)`, which blocks the event loop, so a timer on the main thread never fired.
 * A worker thread has its own loop and writes to the terminal's file descriptor directly, so no command — a
 * synchronous one included — can starve it. Main and worker share one Int32 cell: 0 turning, 1 stop asked, 2 stopped;
 * `stop` asks, WAITS for the worker's last frame (Atomics.wait, which Node allows on the main thread), then clears the
 * line — so the command's first output never lands beside a frame.
 */
/** A stream the spinner watches: a terminal or not, and its write (replaced while the spinner turns, then restored). */
export interface Watched { isTTY?: boolean; columns?: number; write: (...a: never[]) => boolean }

export function spinUntilOutput(label: string, o: { delayMs?: number; out?: Watched; err?: Watched; env?: NodeJS.ProcessEnv; fd?: number } = {}): () => void {
  const out = o.out ?? process.stdout, err = o.err ?? process.stderr;
  if (err.isTTY !== true) return () => {};
  const s = styleFor(err, o.env);
  const fd = o.fd ?? 2;
  const writeOut = out.write, writeErr = err.write;
  // the shared cell: [0] 0 turning / 1 stop asked / 2 stopped; [1] 1 once a frame was drawn
  const state = new SharedArrayBuffer(8);
  const flag = new Int32Array(state);
  const frames = [...FRAMES].map((f) => `\r\x1b[2K${s.cyan(f)} ${s.dim(`${label} …`)}`);
  const worker = new Worker(SPINNER_WORKER, { eval: true, workerData: { fd, frames, delayMs: o.delayMs ?? SPIN_AFTER_MS, state } });
  worker.unref();   // the command's own end ends it: a worker never keeps mason alive
  // a frame that cannot be written (the terminal went away: EBADF, EPIPE) is a frame nobody sees; the command's own
  // output and exit code are untouched by it, so the worker's failure is logged nowhere and ends nothing
  worker.on("error", () => { Atomics.store(flag, 0, 2); Atomics.notify(flag, 0); });
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    out.write = writeOut;
    err.write = writeErr;
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    // the worker's last frame, if one is being written, lands before the clear: wait for it to say it stopped
    Atomics.wait(flag, 0, 1, 500);
    if (Atomics.load(flag, 1) === 1) fs.writeSync(fd, "\r\x1b[2K");
    void worker.terminate();
  };
  // the command's first output stops it: the line is cleared, then the output written as it was given
  const first = (write: Watched["write"], target: Watched): Watched["write"] =>
    ((...a: never[]): boolean => { stop(); return (write as (...b: never[]) => boolean).apply(target, a); });
  out.write = first(writeOut, out);
  err.write = first(writeErr, err);
  return stop;
}

/** The worker: waits the delay (a stop in the meantime ends it with nothing drawn), then a frame every 80 ms until
 *  asked to stop; it writes to the file descriptor it was given, never through a stream the main thread holds. */
const SPINNER_WORKER = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { fd, frames, delayMs, state } = workerData;
const flag = new Int32Array(state);
if (Atomics.wait(flag, 0, 0, delayMs) === "timed-out") {
  let i = 0;
  while (Atomics.load(flag, 0) === 0) {
    try { fs.writeSync(fd, frames[i++ % frames.length]); } catch { break; }   // the terminal went away: stop drawing
    Atomics.store(flag, 1, 1);
    Atomics.wait(flag, 0, 0, 80);
  }
}
Atomics.store(flag, 0, 2);
Atomics.notify(flag, 0);
`;

/** A step that failed: what its runner throws, carrying what to tell and the exit code (the step's line is already ✘). */
export class StepFailed extends Error {
  readonly exit: number;
  constructor(message: string, exit: number) { super(message); this.exit = exit; }
}

/**
 * STEPS AS THEY HAPPEN, drawn (the renderer under checklist, and what mason start's relay draws its run's steps with):
 * `begin` turns a spinner beside the step's label (a terminal only), `done` and `fail` replace it with the step's line,
 * `print` writes any other line above it without breaking the spinner. Anywhere but a terminal only the finished lines.
 */
export function stepRenderer(o: { line: (text: string) => void; live?: { write: (text: string) => void } | null; style?: Style }) {
  const s = o.style ?? PLAIN;
  const live = o.live ?? null;
  let label: string | null = null, frame = 0, timer: NodeJS.Timeout | undefined;
  const draw = (): void => { if (live && label !== null) live.write(`\r\x1b[2K${s.cyan(FRAMES[frame++ % FRAMES.length]!)} ${label} …`); };
  const clear = (): void => { if (live && label !== null) live.write("\r\x1b[2K"); };
  const end = (text: string): void => { if (timer) clearInterval(timer); timer = undefined; clear(); label = null; o.line(text); };
  return {
    begin(text: string): void {
      if (label !== null) end(`${s.green(live ? "✔" : "✓")} ${label}`);   // a step left open by the next one: it ended
      label = text;
      if (live) { draw(); timer = setInterval(draw, 80); timer.unref(); }
    },
    done(text?: string): void { end(`${s.green(live ? "✔" : "✓")} ${text ?? label ?? ""}`); },
    fail(text?: string): void { end(`${s.red(live ? "✘" : "✗")} ${text ?? label ?? ""}`); },
    print(text: string): void { clear(); o.line(text); draw(); },
    /** a step still turning: its label (null when none) */
    open: (): string | null => label,
  };
}

/**
 * A CHECKLIST OF WHAT A COMMAND DOES (first `mason init`'s: each item it is doing, with a spinner left of it that turns
 * into a checkmark when done, so it is seen working live, and the end result a checklist of what it did, all checked
 * off). On a terminal each step turns (`⠋ Connecting to …`) until it ends, then becomes
 * its line: `✔ Connected to …`, or `✘ Connecting to …` when it throws. Anywhere else only the finished lines are written
 * (`✓ Connected to …`), one each, so a log or a coding agent reads the same checklist without the animation.
 */
export function checklist(o: { line: (text: string) => void; live?: { write: (text: string) => void } | null; style?: Style }) {
  const r = stepRenderer(o);
  return {
    async step<T>(label: string, run: () => T | Promise<T>, done: (r: T) => string = () => label): Promise<T> {
      r.begin(label);
      try { const v = await run(); r.done(done(v)); return v; }
      catch (e) { r.fail(label); throw e; }
    },
  };
}
