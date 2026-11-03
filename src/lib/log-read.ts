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
 * A LINE IS RELEASED ONLY WHOLE. The reader reads the file in chunks (a log with every statement traced runs to hundreds
 * of MB), and a chunk ends anywhere — inside a `password='…'`, inside a character's bytes — so it keeps what follows the
 * chunk's last newline until the rest of that line is read, decodes the bytes as UTF-8 across the cut, and masks a line
 * only once it has it whole; a value that runs on past its line is the mask's to carry (`PasswordLineMask`). What is read
 * is the same however the file is cut. tests/log-read.test.ts holds it, and tests/conventions.test.ts refuses a log file
 * read in src/ any other way.
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
  private at: number;
  private readonly chunk: number;
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private mask = new PasswordLineMask();

  /** `from`: the byte to start at (default the file's start); `chunk`: the most one read takes (a test's to set). */
  constructor(file: string, o: { from?: number; chunk?: number } = {}) {
    this.file = file;
    this.at = o.from ?? 0;
    this.chunk = o.chunk ?? CHUNK;
  }

  /** The bytes read so far: the file's offset the next read starts at. */
  get offset(): number { return this.at; }

  /**
   * The lines the next chunk completes, each masked and ending in its newline ("" when the chunk completed none); null
   * once the file has no byte more now. A file shorter than what was read was begun again (a new run's log): it is
   * read from its start, nothing kept of the old.
   */
  read(): string | null {
    const size = fs.statSync(this.file).size;
    if (size < this.at) {
      this.at = 0;
      this.decoder = new StringDecoder("utf8");
      this.partial = "";
      this.mask = new PasswordLineMask();
    }
    if (size === this.at) return null;
    const buf = Buffer.alloc(Math.min(this.chunk, size - this.at));
    const fd = fs.openSync(this.file, "r");
    let n: number;
    try { n = fs.readSync(fd, buf, 0, buf.length, this.at); } finally { fs.closeSync(fd); }
    if (n === 0) return null;
    this.at += n;
    const lines = (this.partial + this.decoder.write(buf.subarray(0, n))).split("\n");
    this.partial = lines.pop() ?? "";
    return lines.map((l) => `${this.mask.line(l)}\n`).join("");
  }

  /** Every line completed from where the reader is to the file's end now, masked. */
  readAll(): string {
    let out = "";
    for (let t = this.read(); t !== null; t = this.read()) out += t;
    return out;
  }

  /** The last line, which no newline ended yet, masked: read once the reader is done with the file ("" when none). */
  rest(): string {
    const last = this.partial + this.decoder.end();
    this.partial = "";
    return last === "" ? "" : this.mask.line(last);
  }
}
