/**
 * WHAT THE RUN WRITES WHILE IT RUNS, ON A DISK THAT CAN FILL (issue 847): its log (`.mason/mason.log`, `RunLog`) and its
 * terminal (stdout and stderr: `.mason/dev.log` under its supervisor, `terminalLine`), both on the disk that holds the
 * synced data. When that disk filled, the log stream's ENOSPC was an unhandled 'error' and ended the run — once with a
 * native abort (exit 134) — before anything said why.
 *
 * THE RUN GOES ON WHEN ITS LOG OR ITS TERMINAL CANNOT BE WRITTEN. A log line lost loses no synced row, and a run that
 * still answers serves every query that reads (a full disk fails writes, not reads): ending it would make a full disk
 * an outage of everything, and the restart would meet the same disk. What a full disk does to the synced data itself is
 * the engine's to say: a write that fails fails its own step (said with the disk's way out, src/lib/disk-full.ts), and a
 * checkpoint that cannot write invalidates the instance, which ends the run for its supervisor as #845 made it
 * (src/duck/executor.ts `invalidatedReason`). So a write here that fails is SAID ONCE (stderr, the log's memory, a
 * server's stdout) with the way out, the lines are counted, and the file is tried again: once there is room the log is
 * written again, its first line saying how many lines it missed.
 */
import * as fs from "node:fs";
import type { Writable } from "node:stream";
import { writeFailureText } from "../lib/disk-full.ts";

/** how long after a failed write the log's file is tried again */
export const LOG_RETRY_MS = 10_000;

export interface RunLogOptions {
  /** opens the file for appending (fs.createWriteStream; a test's stream that fails) */
  open?: (file: string) => Writable;
  /** says a failure, and the log written again: once each, never through this log */
  said: (text: string) => void;
  now?: () => number;
  retryMs?: number;
}

/**
 * THE RUN'S LOG FILE, whose failure to write never ends the run (above). Each entry is written as it comes; after a
 * failed write the stream is dropped, the entries until the next try counted, and the file opened again at the first
 * entry `retryMs` later.
 */
export class RunLog {
  readonly file: string;
  private readonly o: RunLogOptions;
  private stream: Writable | null = null;
  /** when the file is tried again, while it cannot be written */
  private retryAt = 0;
  /** the entries not written since it failed (at least: the ones queued on a stream that failed are not counted) */
  private lost = 0;
  /** from a failed write until a write is seen to succeed: said once */
  private outage = false;
  private ended = false;

  constructor(file: string, o: RunLogOptions) {
    this.file = file;
    this.o = o;
    this.stream = this.opened();
  }

  /** whether the log is being written now (false from a failed write until it is tried again) */
  get writing(): boolean { return this.stream !== null; }

  write(entry: string): void {
    if (this.ended) return;
    if (this.stream === null && (this.o.now ?? Date.now)() >= this.retryAt) {
      const s = this.opened();
      this.stream = s;
      // the gap said in the log itself, as its first line once it takes lines again; the outage is over only once that
      // line is seen written (a file that opens on a disk still full fails its first write)
      const lost = this.lost;
      s?.write(`${new Date().toISOString()} [log] ${this.file} is written again: at least ${lost} line(s) before this one were not written\n`, (e) => {
        if (e || this.stream !== s) return;   // its failure is the stream's 'error', handled there
        this.outage = false;
        this.lost -= lost;
        this.o.said(`${this.file} is written again (at least ${lost} line(s) were not written)`);
      });
    }
    if (this.stream === null) { this.lost++; return; }
    this.stream.write(entry);
  }

  /** ends the stream, its queued lines written first (or failed: said through its 'error' as any write's, never thrown);
   *  it settles once the file is closed */
  end(): Promise<void> {
    this.ended = true;
    const s = this.stream;
    if (s === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      s.once("close", () => resolve());
      s.end();
    });
  }

  /** a new stream on the file, its failure handled (null when even the open throws, said as a write's failure) */
  private opened(): Writable | null {
    let s: Writable;
    try { s = (this.o.open ?? ((f) => fs.createWriteStream(f, { flags: "a", mode: 0o600 })))(this.file); }
    catch (e) { this.failed(e, null); return null; }
    s.on("error", (e) => { this.failed(e, s); });
    return s;
  }

  /** a write (or the open) that failed: the stream dropped, said once an outage, tried again `retryMs` later */
  private failed(e: unknown, s: Writable | null): void {
    // a stream dropped already (or ended by the run's end): its later errors are the same outage, said once
    if (s !== null && this.stream !== s) return;
    this.stream = null;
    s?.destroy();
    this.retryAt = (this.o.now ?? Date.now)() + (this.o.retryMs ?? LOG_RETRY_MS);
    // the entry being written when it failed is one not written
    this.lost++;
    if (this.outage) return;
    this.outage = true;
    this.o.said(`${writeFailureText(`the run's log ${this.file}`, e)}; the run goes on, and its log is written again once it can be`);
  }
}

let guarded = false;
/** where the terminal's loss is said besides the other stream (the run's log, once it is open) */
let sink: (text: string) => void = () => undefined;
/** the streams whose loss was said, so it is said once */
const lostTerminal = new Set<"stdout" | "stderr">();

/**
 * THE RUN'S TERMINAL, WHOSE FAILURE TO WRITE NEVER ENDS THE RUN: a write to stdout or stderr that fails (dev.log on a
 * full disk: an 'error' on the stream, ENOSPC) is said once on the other stream and to `said` (the latest given), and
 * the stream is then written past (`terminalLine`). Its handlers are installed once.
 */
export function guardTerminal(said: (text: string) => void): void {
  sink = said;
  if (guarded) return;
  guarded = true;
  for (const which of ["stdout", "stderr"] as const) {
    process[which].on("error", (e: Error) => {
      if (lostTerminal.has(which)) return;
      lostTerminal.add(which);
      const text = `${writeFailureText(`the run's ${which} (mason logs --start)`, e)}; the run goes on`;
      sink(text);
      terminalLine(which === "stdout" ? "stderr" : "stdout", `${text}\n`);
    });
  }
}

/**
 * A line to the run's terminal. A file's stream (dev.log) that failed a write stays open, and its next write that
 * succeeds — once there is room — ends the outage, so a later one is said again; a stream Node ended (a pipe whose
 * reader left) is written past, to its descriptor directly, so the FATAL line its supervisor reads still has a way out.
 */
export function terminalLine(which: "stdout" | "stderr", text: string): void {
  const s = process[which];
  if (!s.destroyed) {
    // a failure is the stream's 'error' (`guardTerminal`); a success ends the outage
    s.write(text, (e) => { if (!e) lostTerminal.delete(which); });
    return;
  }
  try { fs.writeSync(which === "stdout" ? 1 : 2, text); lostTerminal.delete(which); }
  catch {
    // the disk still full (or the reader gone): this line is lost. Only a stream that failed a write is destroyed (the
    // run never ends its own), and that failure was said once (`guardTerminal`); each line after it is not said again
  }
}
