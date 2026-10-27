/**
 * LOG LINES, AS TEXT OR AS JSON. `MASON_LOG_FORMAT` is `text` (the default: `[component] message`,
 * what a person reads in `docker compose logs`) or `json`: one object per line, which a log collector parses
 * without a pattern of its own —
 *
 *   {"ts":"2026-10-02T10:41:07.512Z","level":"error","component":"cdc","msg":"…","service":"mason","deployment":"app","version":"1.4.0"}
 *
 * `level` is `info`, `warn` or `error`. A message that spans lines (a stack) is ONE entry, its newlines escaped.
 *
 * EVERY LINE IS JSON under `json`, not only the ones written through `logger()`: the service starts its children
 * with their output piped, and `JsonLines` turns any line that is not an entry already into one — the component
 * from its `[prefix]` (else the child's name), the level from an `ERROR` / `WARNING` marker after the prefix, else
 * from the stream (stderr is `error`). An indented line, or one that continues a stack, joins the entry before it.
 */

export type Level = "info" | "warn" | "error";
export type LogFormat = "text" | "json";

/** MASON_LOG_FORMAT, or a problem naming what it accepts. */
export function logFormatOf(env: NodeJS.ProcessEnv): { format: LogFormat; problem: string | null } {
  const v = env.MASON_LOG_FORMAT;
  if (v === undefined || v === "" || v === "text") return { format: "text", problem: null };
  if (v === "json") return { format: "json", problem: null };
  return { format: "text", problem: `MASON_LOG_FORMAT=${v} is not a log format: text (the default) or json` };
}

export interface LogEntry { ts: string; level: Level; component: string; msg: string; service: "mason"; deployment?: string; version?: string }

export function entry(level: Level, component: string, msg: string, env: NodeJS.ProcessEnv = process.env, at = new Date()): LogEntry {
  return {
    ts: at.toISOString(), level, component, msg, service: "mason",
    ...(env.DEPLOYMENT ? { deployment: env.DEPLOYMENT } : {}),
    ...(env.MASON_VERSION ? { version: env.MASON_VERSION } : {}),
  };
}

/**
 * ONE ENTRY AS TEXT: `head` (the time, a `[component]`, a marker) then the message, whose every further line — a DuckDB
 * error's `LINE 1: …` and candidates, a stack's frames — is INDENTED, its blank lines dropped. A reader takes a line that
 * starts at the margin as an entry and an indented one as the entry's continuation (`JsonLines`, `mason logs`), so a
 * multi-line reason is never cut to its first line, nor its rest read as entries of their own (the test server: a
 * failed catch-up's Binder Error was logged as its first line). The DuckDB run's mason.log is written through it
 * (src/cli/dev.ts); the ClickHouse service's `logger()` prints a statement listing as it always has (bootstrap's dry run
 * is read line by line), and its JSON form keeps a message whole.
 */
export function textEntry(head: string, msg: string): string {
  const [first = "", ...rest] = msg.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  return [`${head}${first}`, ...rest.filter((l) => l.trim() !== "").map((l) => `    ${l.trimEnd()}`)].join("\n") + "\n";
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** the level a message's own `WARNING:` / `ERROR:` marker names (the marker dropped), else info */
  log(msg: string): void;
}

/** A message that begins with `ERROR` / `FATAL` / `WARNING` / `WARN` (and a colon), in capitals: that level, the marker dropped. */
export function markedLevel(msg: string): { level: Level | null; msg: string } {
  // upper case only: this repo's markers are, and `Error: …` is an exception's own text, which keeps its word
  const mark = /^(ERROR|FATAL|WARNING|WARN)\b:? ?/.exec(msg);
  if (!mark) return { level: null, msg };
  return { level: mark[1] === "ERROR" || mark[1] === "FATAL" ? "error" : "warn", msg: msg.slice(mark[0].length) };
}

/**
 * A component's logger. As text, `[component] message`, with `WARNING: ` / `ERROR: ` before a warning's or an
 * error's message — the lines this repo has always printed — and the time first when `timestamp` (the runtime's).
 * Warnings and errors go to stderr, as before. As JSON every entry goes to stdout: the level is the field.
 */
export function logger(component: string, opts: { timestamp?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Logger {
  const { format } = logFormatOf(env);
  const write = (level: Level, msg: string): void => {
    if (format === "json") { process.stdout.write(JSON.stringify(entry(level, component, msg, env)) + "\n"); return; }
    const out = level === "info" ? process.stdout : process.stderr;
    const mark = level === "error" ? "ERROR: " : level === "warn" ? "WARNING: " : "";
    out.write(`[${component}] ${opts.timestamp ? `${new Date().toISOString()} ` : ""}${mark}${msg}\n`);
  };
  return {
    info: (m) => write("info", m), warn: (m) => write("warn", m), error: (m) => write("error", m),
    log: (m) => { const { level, msg } = markedLevel(m); write(level ?? "info", msg); },
  };
}

// ------------------------------------------------------------------ a child's output as entries

const PREFIX = /^\[([A-Za-z][A-Za-z0-9_-]*)\] ?/;

/** Whether `line` is an entry already: what a child's `logger()` wrote under `json`. */
function isEntry(line: string): boolean {
  if (!line.startsWith("{")) return false;
  try {
    const o = JSON.parse(line) as Partial<LogEntry>;
    return typeof o === "object" && o !== null && typeof o.level === "string" && typeof o.msg === "string";
  } catch {
    // not JSON: an ordinary line that happens to start with a brace, wrapped like any other
    return false;
  }
}

/** One line a child printed, as an entry: its prefix as the component, its marker or stream as the level. */
export function lineEntry(line: string, stream: "stdout" | "stderr", fallbackComponent: string, env: NodeJS.ProcessEnv = process.env, at = new Date()): LogEntry {
  const m = PREFIX.exec(line);
  const component = m ? m[1]! : fallbackComponent;
  const marked = markedLevel(m ? line.slice(m[0].length) : line);
  return entry(marked.level ?? (stream === "stderr" ? "error" : "info"), component, marked.msg, env, at);
}

/** A line that belongs to the entry before it: indented (a listing's rows, a stack's `    at` frames) or a closing brace. */
const continues = (line: string): boolean => /^(\s|\}|\])/.test(line) && line.trim() !== "";

/**
 * A child's stdout and stderr, as entries, one JSON object per line on `write`, in the order they were printed.
 * Chunks are split into lines (a partial last line waits for the rest); a continuation line joins the entry before
 * it when that came from the same stream; an entry is written when the next one starts, after FLUSH_MS of quiet,
 * or at `end`.
 */
export class JsonLines {
  static readonly FLUSH_MS = 100;
  private readonly component: string;
  private readonly write: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly partial = { stdout: "", stderr: "" };
  private held: { stream: "stdout" | "stderr"; entry: LogEntry } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(component: string, write: (line: string) => void, env: NodeJS.ProcessEnv = process.env) {
    this.component = component; this.write = write; this.env = env;
  }

  push(stream: "stdout" | "stderr", chunk: string): void {
    const lines = (this.partial[stream] + chunk).split("\n");
    this.partial[stream] = lines.pop()!;
    for (const line of lines) this.line(stream, line);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), JsonLines.FLUSH_MS);
    this.timer.unref();
  }

  /** Everything held, written: the child exited. */
  end(): void {
    for (const s of ["stdout", "stderr"] as const) {
      if (this.partial[s]) { this.line(s, this.partial[s]); this.partial[s] = ""; }
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.release();
  }

  private line(stream: "stdout" | "stderr", raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (this.held?.stream === stream && continues(line)) { this.held.entry.msg += `\n${line}`; return; }
    this.release();
    if (line.trim() === "") return;
    if (isEntry(line)) { this.write(line); return; }
    this.held = { stream, entry: lineEntry(line, stream, this.component, this.env) };
  }

  private release(): void {
    if (this.held) { this.write(JSON.stringify(this.held.entry)); this.held = null; }
  }
}
