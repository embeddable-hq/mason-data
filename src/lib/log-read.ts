/**
 * THE RUN'S LOG FILES, AND THEIR ONE READER (issue 621: `mason logs` showed lines an older Mason wrote with the source's
 * password in a `password=` value, because it read the file as it was).
 *
 * `.mason/mason.log` (the run's log) and `.mason/dev.log` (the run's terminal, `mason start`'s) are named here alone, and
 * every reader of either reads it through `LogReader`, which masks each line as it is read (`PasswordLineMask`,
 * src/lib/secret-mask.ts): `mason logs` (whole, `--start`, `-f`), `mason start`'s own watch of the run's terminal and the
 * supervisor's scan of it after a run exits (src/cli/background.ts, src/cli/supervise.ts). The run's memory of its log
 * (src/lib/log-buffer.ts, `GET /api/logs`) is the same mask, applied as an entry is kept. So a line an older Mason wrote
 * is shown masked wherever it is shown, and the file itself is never rewritten: a log a person or a collector already
 * read cannot be unread (the release notes of 599 say to rotate the password and delete the old files).
 *
 * WHAT IS MASKED is #620's decision, kept: a libpq `password=` value, the one form the old string leaked, and never a
 * substring of the password now, which a table's, a user's or a slot's name may hold (docs/DESIGN.md "How wide the mask
 * is, and why").
 *
 * A LINE IS RELEASED ONLY WHOLE, AND READ ONCE MORE AT MOST. The reader reads the file in chunks (a log with every
 * statement traced runs to hundreds of MB), and a chunk ends anywhere — inside a `password='…'`, inside a character's
 * bytes. So it decodes and masks only the bytes up to a chunk's last newline, a line at a time, and keeps NOTHING of the
 * line after it but where it starts in the file: when a later chunk ends that line, its bytes are read again from there,
 * once, and decoded whole (the review of PR 641: a line held as text and joined to every chunk cost a line of L bytes
 * L²/chunk, and twice the base's memory). A newline byte is never inside a UTF-8 character, so a line's bytes decode as
 * the whole file's would. A value that runs on past its line is the mask's to carry (`PasswordLineMask`). What is read is
 * the same however the file is cut; tests/log-read.test.ts holds it, and the reader's work to a count of the bytes it
 * reads; tests/conventions.test.ts refuses a log file read in src/ any other way.
 *
 * A FOLLOW SHOWS THE LINE NOT ENDED YET (`follow`, `mason logs -f`): a run killed mid-write leaves its last words with
 * no newline, so at the file's end the follow shows that line as it stands, masked, and then only what more of it adds.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PasswordLineMask } from "./secret-mask.ts";

/** The run's log, in the project's `.mason/`: `mason logs`. */
export const RUN_LOG = "mason.log";
/** The run's terminal, in the project's `.mason/`: `mason logs --start`. */
export const START_LOG = "dev.log";

/** A log file's path in a project's `.mason/` folder: the run's log, or its terminal (`start`). */
export function logPath(home: string, which: "run" | "start"): string {
  return path.join(home, which === "run" ? RUN_LOG : START_LOG);
}

/** How much of the file one read takes, at most. */
const CHUNK = 1 << 20;

/** A log file read from an offset on, its lines masked as they are read. */
export class LogReader {
  readonly file: string;
  /** the next byte a read takes */
  private at: number;
  /** where the line not ended yet starts: the bytes from here to `at` are read, and not yet released */
  private lineStart: number;
  private readonly chunk: number;
  private mask = new PasswordLineMask();
  /** what `follow` has shown of the line not ended yet, masked */
  private shown = "";
  /** the file was begun again under a line `follow` had shown part of: the next it shows starts a line */
  private broken = false;
  /** the offset `follow` last showed the unended line at: unchanged, it is not read again */
  private peeked = -1;
  private readBytes = 0;
  private searchedBytes = 0;

  /** `from`: the byte to start at (default the file's start); `chunk`: the most one read takes (a test's to set). */
  constructor(file: string, o: { from?: number; chunk?: number } = {}) {
    this.file = file;
    this.at = o.from ?? 0;
    this.lineStart = this.at;
    this.chunk = o.chunk ?? CHUNK;
  }

  /** The bytes read so far: the file's offset the next read starts at. */
  get offset(): number { return this.at; }

  /** The reader's own work, for a test to hold linear: the bytes it read from the file (a line's again once it ends) and
   *  those it searched for a newline, whatever the lines' lengths and the chunks. */
  get work(): { read: number; searched: number } { return { read: this.readBytes, searched: this.searchedBytes }; }

  /**
   * The lines the next chunk completes, each masked and ending in its newline ("" when the chunk completed none); null
   * once the file has no byte more now. A file shorter than what was read was begun again (a new run's log): it is
   * read from its start, nothing kept of the old.
   */
  read(): string | null {
    const lines = this.next();
    if (lines === null) return null;
    let out = "";
    for (const l of lines) out += `${l}\n`;
    return out;
  }

  /** Every line completed from where the reader is to the file's end now, masked, each without its newline: `mason
   *  logs`' (src/lib/log-buffer.ts `entriesOfLines`), so a line of hundreds of MB is never copied again to be split. */
  readLines(): string[] {
    const out: string[] = [];
    for (let lines = this.next(); lines !== null; lines = this.next()) for (const l of lines) out.push(l);
    return out;
  }

  /** Every line completed from where the reader is to the file's end now, masked. */
  readAll(): string {
    let out = "";
    for (let t = this.read(); t !== null; t = this.read()) out += t;
    return out;
  }

  /** The last line, which no newline ended yet, masked: read once the reader is done with the file ("" when none). */
  rest(): string {
    const last = this.bytes(this.lineStart, this.at).toString("utf8");
    this.lineStart = this.at;
    return last === "" ? "" : this.mask.line(last);
  }

  /**
   * WHAT A FOLLOW PRINTS NEXT (`mason logs -f`): every line written since, and then, the file's end reached, the line not
   * ended yet as it stands, masked (the review of PR 641: a run killed mid-write leaves its last words unended, and a
   * follow that waited for their newline never showed them). Printed one after another, the answers are the masked
   * lines with the unended one's masked text so far; once more of it comes, only what its mask adds is printed, and
   * should its mask read differently with more of it (never seen: a mask of a prefix is the whole mask's prefix), the
   * line is shown again whole on a line of its own, never a byte unmasked. A character whose bytes are not all written
   * yet waits for them.
   */
  follow(): string {
    let out = "";
    const ended = this.readAll();
    if (this.broken) { out += "\n"; this.broken = false; }
    if (ended !== "") {
      out += this.after(ended);
      this.shown = "";
    }
    if (this.at !== this.peeked) {
      this.peeked = this.at;
      const unended = new StringDecoder("utf8").write(this.bytes(this.lineStart, this.at));
      const now = unended === "" ? "" : this.mask.peek(unended);
      if (now !== this.shown) { out += this.after(now); this.shown = now; }
    }
    return out;
  }

  /** `text` as it continues what `follow` has shown of the line: what it adds, or itself on a line of its own. */
  private after(text: string): string {
    if (this.shown === "") return text;
    return text.startsWith(this.shown) ? text.slice(this.shown.length) : `\n${text}`;
  }

  /** The lines the next chunk completes, masked, without their newlines; null once the file has no byte more now. */
  private next(): string[] | null {
    const size = fs.statSync(this.file).size;
    if (size < this.at) {
      this.at = 0;
      this.lineStart = 0;
      this.mask = new PasswordLineMask();
      if (this.shown !== "") this.broken = true;
      this.shown = "";
      this.peeked = -1;
    }
    if (size === this.at) return null;
    const buf = this.bytes(this.at, Math.min(this.at + this.chunk, size));
    if (buf.length === 0) return null;
    const from = this.at;
    this.at += buf.length;
    // the chunk alone is searched: of a line it does not end, nothing is kept but where it starts
    this.searchedBytes += buf.length;
    const last = buf.lastIndexOf(10);
    if (last === -1) return [];
    const end = from + last + 1;
    // the lines it ends, from the first one's start: read again from the file once when that start is in an earlier
    // chunk, so a line is had whole without being held
    const whole = this.lineStart === from ? buf.subarray(0, last + 1) : this.bytes(this.lineStart, end);
    this.lineStart = end;
    const lines = whole.toString("utf8").split("\n");
    lines.pop();   // the last newline ends its line, it does not start another
    return lines.map((l) => this.mask.line(l));
  }

  /** The file's bytes from `start` to `end` (fewer when it is shorter now), counted as read. */
  private bytes(start: number, end: number): Buffer {
    if (end <= start) return Buffer.alloc(0);
    const buf = Buffer.alloc(end - start);
    const fd = fs.openSync(this.file, "r");
    let n = 0;
    try {
      for (let got = -1; n < buf.length && got !== 0; n += got) got = fs.readSync(fd, buf, n, buf.length - n, start + n);
    } finally { fs.closeSync(fd); }
    this.readBytes += n;
    return n === buf.length ? buf : buf.subarray(0, n);
  }
}
