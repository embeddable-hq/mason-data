/**
 * `MASON_UI_TITLE_FILE` (mason serve; issue 1181): THE LABEL IN THE WEB PAGE'S HEADER BOX, read from a file. The box
 * (src/web/app.js `renderWhere`) names the database and the sources file. An operator who runs several deployments can
 * name each in their own words ("Production analytics (EU)") and change it with no restart: the file's first line is
 * shown in the box in place of the database.
 *
 * WHEN IT IS READ (`TitleFile`): once at the start, then again each time the page's document is loaded (`GET /`) and
 * each time a command asks the run's whole state (`/api/state?columns=1`: `mason status`). The page's polls of
 * `/api/state` (every 2 s on the Overview) answer what was read last, so an edit shows at the next load of the page and
 * at the next `mason status`, and a poll never touches the file.
 *
 * WHAT IS READ (`readTitleFile`, `titleOf`): at most `TITLE_BYTES_MAX` bytes, from a regular file only (a folder, a pipe
 * or a device is refused before a byte is read, and the file is opened without blocking, so a pipe cannot hang it). The
 * first line (up to `\n`, `\r\n` or `\r`), strict UTF-8. A control character or a line or paragraph separator becomes a
 * space; an invisible format character is dropped (a bidi control, which could reorder the page's text around it, a
 * zero-width space, a BOM), but for the two joiners (U+200C, U+200D) that some scripts and emoji need; runs of white
 * space become one; it is trimmed. A line over `TITLE_CHARS_MAX` characters is cut on a whole character (never inside a
 * UTF-8 sequence, and never inside a character a person reads as one, an emoji with its modifier) and ends with "…".
 * The page escapes it where it writes it (`esc`): it is text, never HTML.
 *
 * A FAILURE NEVER BREAKS THE PAGE: a file missing, a folder, no permission, bad UTF-8 or an empty first line leave the
 * box as it was without the setting. Why is said where an operator looks: `mason status` (its Web UI label row) and
 * `--json`'s `pageTitle.problem`, a stable `code` and a message, and the run's log once per reason. Nothing says the
 * file's path: `/api/state` and the log are read by the web page too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { didYouMean } from "../lib/did-you-mean.ts";

export const UI_TITLE_FILE_SETTING = "MASON_UI_TITLE_FILE";
/** The most of the file read, in bytes: the first line within it, never the whole file. */
export const TITLE_BYTES_MAX = 1024;
/** The longest label shown, in characters (code points), its "…" included. */
export const TITLE_CHARS_MAX = 80;

/** Why the file gave no label: a stable code, as `mason status --json` says it. */
export type TitleProblemCode = "missing" | "not_a_file" | "no_permission" | "not_utf8" | "empty" | "unreadable";

/** What `/api/state` `pageTitle` says: the label shown, or null and why. */
export interface PageTitle {
  label: string | null;
  problem: { code: TitleProblemCode; message: string } | null;
}

/** The names an operator may reach for that are not the setting: refused, with a `did you mean`. */
const TITLE_PREFIX = "MASON_UI_TITLE";

/** Each `MASON_UI_TITLE*` set that is no setting (`MASON_UI_TITLE`, `MASON_UI_TITLE_PATH`), as a problem. */
export const notTitleSettings = (env: Readonly<Record<string, string | undefined>>): string[] =>
  Object.keys(env).filter((k) => k.startsWith(TITLE_PREFIX) && k !== UI_TITLE_FILE_SETTING && (env[k] ?? "") !== "").sort()
    .map((k) => `${k} is not a setting${didYouMean(k, [UI_TITLE_FILE_SETTING])}: the web page's label is read from a file, named by ${UI_TITLE_FILE_SETTING}`);

/**
 * The file as the environment names it: null when unset (or set empty), else its absolute path (relative to `cwd`), or
 * what is wrong. The file itself is never read here: it may be written after the start, and its problems never refuse it.
 */
export function uiTitleFileSetting(env: Readonly<Record<string, string | undefined>>, cwd: string): string | null | { problem: string } {
  const wrong = notTitleSettings(env);
  if (wrong.length > 0) return { problem: wrong.join("; ") };
  const set = env[UI_TITLE_FILE_SETTING] ?? "";
  return set === "" ? null : path.resolve(cwd, set);
}

/** Which of its names a start was given (the setting, or a name that is not one): what `mason start` refuses. */
export const titleSettingsSet = (env: Readonly<Record<string, string | undefined>>): string[] =>
  Object.keys(env).filter((k) => k.startsWith(TITLE_PREFIX) && (env[k] ?? "") !== "").sort();

const problem = (code: TitleProblemCode, message: string): PageTitle => ({ label: null, problem: { code, message } });

/** A control character, a line or a paragraph separator: a space. */
const SPACED = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/** An invisible format character (bidi controls, zero-width space, BOM, soft hyphen), but the two joiners: dropped. */
const INVISIBLE = /(?![‌‍])\p{Cf}/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The label of a line already decoded: cleaned, trimmed, cut to `TITLE_CHARS_MAX` on a whole character. */
export function cleanTitle(line: string): string {
  const text = line.replace(SPACED, " ").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  if ([...text].length <= TITLE_CHARS_MAX) return text;
  // room for the "…": whole graphemes while they fit, else (one grapheme longer than the room) whole code points
  const room = TITLE_CHARS_MAX - 1;
  let out = "";
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    const c = [...segment].length;
    if (n + c > room) break;
    out += segment;
    n += c;
  }
  if (out === "") out = [...text].slice(0, room).join("");
  return `${out.trimEnd()}…`;
}

/**
 * The label of the file's first bytes (`more`: the read stopped at the cap, so the file may go on, and a character
 * cut by the cap is left out rather than called bad UTF-8). Its first line only, strict UTF-8, cleaned (`cleanTitle`).
 */
export function titleOf(bytes: Uint8Array, more: boolean): PageTitle {
  let end = bytes.findIndex((b) => b === 0x0a || b === 0x0d);
  const ended = end >= 0;
  if (!ended) end = bytes.length;
  let line: string;
  // the first line only: what follows it is never decoded, so bad UTF-8 after it is not this line's
  try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end), { stream: more && !ended }); }
  catch { return problem("not_utf8", "its first line is not UTF-8 text"); }
  const label = cleanTitle(line);
  return label === "" ? problem("empty", "its first line is empty") : { label, problem: null };
}

/** Why the file could not be opened or read, by its error's code (never its message, which names the path). */
function failureOf(e: unknown): PageTitle {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return problem("missing", "the file does not exist");
  if (code === "EACCES" || code === "EPERM") return problem("no_permission", "Mason's user may not read it");
  if (code === "EISDIR") return problem("not_a_file", "it names a folder, not a file");
  return problem("unreadable", typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? `it could not be read (${code})` : "it could not be read");
}

/** O_NONBLOCK where the platform has it: a pipe opened to read waits for a writer without it. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** The label the file says now: at most `TITLE_BYTES_MAX` bytes of a regular file, never more. Never throws. */
export async function readTitleFile(file: string): Promise<PageTitle> {
  let h: fs.promises.FileHandle;
  try { h = await fs.promises.open(file, OPEN_FLAGS); } catch (e) { return failureOf(e); }
  try {
    const st = await h.stat();
    if (st.isDirectory()) return problem("not_a_file", "it names a folder, not a file");
    if (!st.isFile()) return problem("not_a_file", "it names something that is not a file (a pipe or a device)");
    const buf = Buffer.alloc(TITLE_BYTES_MAX);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await h.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return titleOf(buf.subarray(0, n), n === buf.length);
  } catch (e) {
    return failureOf(e);
  } finally {
    // a close that fails leaves nothing to undo: the read is done or said as failed above
    await h.close().catch((e: unknown) => { void e; });
  }
}

/**
 * THE FILE A RUN READS ITS LABEL FROM: `read()` reads it now (the page's load, a command's state), `last()` says what
 * was read last (the page's polls). The run's log is told each reason once, never again on each load.
 */
export class TitleFile {
  readonly #file: string;
  readonly #log: (line: string) => void;
  #last: PageTitle = { label: null, problem: null };
  #asked = 0;
  readonly #logged = new Set<string>();

  constructor(file: string, log: (line: string) => void) {
    this.#file = file;
    this.#log = log;
  }

  /** What was read last (before the first read: no label, no problem). */
  last(): PageTitle { return this.#last; }

  /** Read the file now. Reads that overlap keep the one asked last. Never throws. */
  async read(): Promise<PageTitle> {
    const asked = ++this.#asked;
    const t = await readTitleFile(this.#file);
    if (asked === this.#asked) this.#last = t;
    if (t.problem !== null && !this.#logged.has(t.problem.code + t.problem.message)) {
      this.#logged.add(t.problem.code + t.problem.message);
      this.#log(`${UI_TITLE_FILE_SETTING}: ${t.problem.message}, so the web page's header shows the database`);
    }
    return this.#last;
  }
}

/** mason status's row for it: the label, or why there is none. */
export function titleRow(t: PageTitle): string {
  return t.label !== null ? `${t.label}  (${UI_TITLE_FILE_SETTING}, read again each time the page loads)`
    : `none: ${UI_TITLE_FILE_SETTING}: ${t.problem?.message ?? "not read yet"}, so the page's header shows the database`;
}
