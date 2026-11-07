/**
 * A SECRET READ FROM THE PERSON OR THE PIPE, NEVER FROM A FLAG, AN ARGUMENT OR A FILE (`mason replica create`'s database
 * URL, issue 720): on a terminal a hidden prompt, otherwise stdin read whole. Node's own TTY handling, no dependency.
 *
 *   - THE PROMPT (stdin a terminal): the question on stderr, stdin in raw mode, so the terminal echoes nothing and keeps
 *     no line of it; each key is read here. Enter ends it; Ctrl-C, or Ctrl-D or Enter on an empty line, cancels; Backspace
 *     and Ctrl-U edit; a terminal's escape sequences (a bracketed paste's markers, an arrow) are dropped. The terminal is
 *     put back as it was on EVERY way out — the answer, a cancel, an error of the stream, its end, a signal (SIGINT,
 *     SIGTERM, SIGHUP while raw mode keeps Ctrl-C from being one), and the process's exit.
 *   - THE PIPE (stdin not a terminal): read whole, bounded at `max` bytes and by a time limit (a pipe left open and
 *     silent never holds the command), one trailing newline (`\n` or `\r\n`) trimmed; more than one line is refused.
 *
 * Nothing read is ever written anywhere by this module: what went wrong is said by kind, never by value.
 */
import { StringDecoder } from "node:string_decoder";

/** What was read, or why nothing was: never the value in a refusal. */
export type SecretRead =
  | { value: string }
  | { none: "cancelled" | "empty" | "too_long" | "lines" | "timeout" | "closed" };

/** The few members of a stream this module uses, so a test hands it a fake terminal or pipe. */
export interface SecretInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (on: boolean) => unknown;
  on(event: "data", f: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", f: () => void): unknown;
  on(event: "error", f: (e: Error) => void): unknown;
  // the listener of any `on` above
  removeListener(event: string, f: (...a: any[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}
export interface SecretOutput { write(s: string): unknown }
/** What raises a signal and an exit: `process`, or a test's own emitter. */
export interface SignalSource {
  on(event: string, f: () => void): unknown;
  removeListener(event: string, f: () => void): unknown;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * THE HIDDEN PROMPT: `question` on `output` (stderr), a line read from `input` (a terminal) in raw mode, echoing nothing.
 * At most `max` characters are kept; a longer line is read to its end (so nothing of it is left for the shell to echo)
 * and refused.
 */
export function readHidden(input: SecretInput, output: SecretOutput, question: string, max: number, signals: SignalSource = process): Promise<SecretRead> {
  return new Promise<SecretRead>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    const decoder = new StringDecoder("utf8");
    let line: string[] = [];
    let tooLong = false;
    let escape: "" | "esc" | "csi" | "osc" = "";
    let ended = false;
    const restore = (): void => { if (!wasRaw) input.setRawMode?.(false); };
    const finish = (r: SecretRead | Error): void => {
      if (ended) return;
      ended = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onError);
      for (const s of SIGNALS) signals.removeListener(s, onSignal);
      signals.removeListener("exit", restore);
      try { restore(); } finally {
        input.pause();
        // the person's Enter was not echoed: the next line starts on a line of its own
        output.write("\n");
        line = [];
        if (r instanceof Error) reject(r); else resolve(r);
      }
    };
    const onSignal = (): void => finish({ none: "cancelled" });
    const onEnd = (): void => finish({ none: line.length ? "closed" : "cancelled" });
    const onError = (e: Error): void => finish(e);
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const c of text) {
        if (ended) return;
        // a terminal's escape sequence (an arrow, a bracketed paste's markers, a title report): dropped whole
        if (escape === "esc") { escape = c === "[" ? "csi" : c === "]" ? "osc" : ""; continue; }
        if (escape === "csi") { if (c >= "@" && c <= "~") escape = ""; continue; }
        if (escape === "osc") { if (c === "\x07" || c === "\x1b") escape = ""; continue; }
        if (c === "\x1b") { escape = "esc"; continue; }
        if (c === "\r" || c === "\n") {
          finish(tooLong ? { none: "too_long" } : line.length === 0 ? { none: "empty" } : { value: line.join("") });
          return;
        }
        if (c === "\x03") { finish({ none: "cancelled" }); return; }
        if (c === "\x04") { if (line.length === 0 && !tooLong) { finish({ none: "cancelled" }); return; } continue; }
        if (c === "\x7f" || c === "\b") { line.pop(); continue; }
        if (c === "\x15") { line = []; tooLong = false; continue; }
        if (c < " ") continue;
        if (line.length >= max) { tooLong = true; continue; }
        line.push(c);
      }
    };
    try {
      if (input.setRawMode === undefined) throw new Error("stdin is a terminal that cannot turn its echo off");
      // the question first, then echo off: nothing typed before it is shown as asked
      output.write(question);
      input.setRawMode(true);
      for (const s of SIGNALS) signals.on(s, onSignal);
      signals.on("exit", restore);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      input.on("error", onError);
      input.resume();
    } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
  });
}

/**
 * THE PIPE: `input` read whole, at most `max` bytes after one trailing newline is trimmed, within `timeoutMs`. Empty,
 * more than one line, longer than `max`, or nothing by the time limit, each said by kind.
 */
export function readPiped(input: SecretInput, max: number, timeoutMs: number): Promise<SecretRead> {
  return new Promise<SecretRead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let ended = false;
    const finish = (r: SecretRead | Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.pause();
      if (r instanceof Error) reject(r); else resolve(r);
    };
    const timer = setTimeout(() => finish({ none: "timeout" }), timeoutMs);
    // the newline a shell's echo or a file ends with is not the URL's: room for it, then the bound
    const most = max + 2;
    const onData = (chunk: Buffer | string): void => {
      const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += b.length;
      if (bytes > most) { finish({ none: "too_long" }); return; }
      chunks.push(b);
    };
    const onEnd = (): void => {
      let text = Buffer.concat(chunks).toString("utf8");
      chunks.length = 0;
      if (text.endsWith("\r\n")) text = text.slice(0, -2); else if (text.endsWith("\n")) text = text.slice(0, -1);
      if (text === "") return finish({ none: "empty" });
      if (/[\r\n]/.test(text)) return finish({ none: "lines" });
      if (Buffer.byteLength(text, "utf8") > max) return finish({ none: "too_long" });
      finish({ value: text });
    };
    const onError = (e: Error): void => finish(e);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}
