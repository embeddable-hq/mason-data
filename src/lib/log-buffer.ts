/**
 * THE RUN'S LOG AS ENTRIES, kept in memory and read back from the file: ONE shape, `{ at, text }`, for both.
 *
 * An entry is what `textEntry` (src/lib/log.ts) writes: a head line (the ISO time, then `[component] message`) and the
 * message's further lines INDENTED under it. A line at the margin starts an entry, an indented one continues it, so a
 * multi-line reason (a stack, a DuckDB error's candidates) is ONE entry here, never its first line and a pile of
 * orphans. `at` is the head's time (null for a line that has none: `mason start`'s terminal, dev.log); `text` is the rest
 * as written, continuation lines included.
 *
 * `LogBuffer` is fed by the one place the run writes its log (src/cli/dev.ts `logLine`: mason.log under `mason start`,
 * stdout under `mason serve`), so both modes have it; the command server serves it (`GET /api/logs`). `mason logs` reads
 * the FILE with `logEntries`, the same parser, so a line is the same `{ at, text }` from either.
 */

/** One log entry: when (null when its line carries no time) and what, a multi-line message's further lines indented. */
export interface LogLine { at: string | null; text: string }

/**
 * How many entries the run keeps: a startup and a copy of a hundred tables log a few thousand lines, and an agent asking
 * "what just happened" wants the last minutes, not the file (which `mason logs` reads whole). 2000 entries at a few hundred
 * bytes is under a megabyte of memory, however long the run lives.
 */
export const LOG_KEPT = 2000;

const HEAD = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /;

/** Text (a file's, or one entry as `textEntry` wrote it) as entries: a margin line starts one, an indented line continues it. */
export function logEntries(text: string, o: { perLine?: boolean } = {}): LogLine[] {
  const out: LogLine[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const last = out[out.length - 1];
    if (!o.perLine && last !== undefined && /^\s/.test(line)) { last.text += `\n${line.trimEnd()}`; continue; }
    const m = HEAD.exec(line);
    out.push(m ? { at: m[1]!, text: line.slice(m[0].length).trimEnd() } : { at: null, text: line.trimEnd() });
  }
  return out;
}

/** An entry as the file has it: the time, a space, the text. */
export const logLineText = (l: LogLine): string => (l.at === null ? l.text : `${l.at} ${l.text}`);

/** The last `capacity` entries, oldest dropped first. */
export class LogBuffer {
  readonly capacity: number;
  private readonly kept: LogLine[] = [];

  constructor(capacity = LOG_KEPT) { this.capacity = capacity; }

  /** An entry as `textEntry` wrote it (one head line, the rest indented): kept as ONE entry. */
  push(entry: string): void {
    for (const l of logEntries(entry)) {
      this.kept.push(l);
      if (this.kept.length > this.capacity) this.kept.shift();
    }
  }

  /** The last `lines` entries, oldest first; with `since` (an ISO time) only those after it. */
  recent(o: { lines: number; since?: string }): LogLine[] {
    const from = o.since === undefined ? this.kept : this.kept.filter((l) => l.at !== null && l.at > o.since!);
    return o.lines <= 0 ? [] : from.slice(-o.lines);
  }
}
