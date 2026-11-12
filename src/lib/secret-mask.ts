/**
 * AN ERROR'S WORDS, AS MASON REPEATS THEM (issue 599: the engine's error repeated the connection string, `password='…'`
 * included, into the log, the ledger, `mason status` and the web page).
 *
 * WHERE THE PASSWORD CAN STILL REACH AN ERROR decides how wide this is. The engine is given the password in ONE
 * statement, the TEMPORARY SECRET (src/duck/sync.ts `sourceSecretSql`), whose own error is never repeated (its code
 * alone); the ATTACH's path holds no credential (`attachPath`), so the extension's `Unable to connect to Postgres at
 * "<path>"` cannot hold it; the sync's own Postgres client sends it only inside its auth messages (src/cdc/pg-wire.ts),
 * never in a string. So no error the sync meets holds the password, and the one form a regression would bring back is
 * the one the old string leaked: a libpq `password=` keyword's value. That alone is masked.
 *
 * NEVER A SUBSTRING OF THE PASSWORD (the reviews of PR 620): an error's words carry identifiers — a table's name, the
 * user's, the database's, a slot's, a row's value — and a mask that cut the password out of them showed where it sat
 * (`public.****_archive` under `orders2024`, `for user "****"` under a password equal to the user's name), while a
 * branch matching the words flipped (a catch-up's wider numeric, a ROLLBACK's `no transaction is active`). A
 * `password=` value is no identifier, so masking it shows nothing of the password and changes no word a branch reads;
 * and no branch reads these words at all: a decision reads `messageOf`, the raw words, which are never shown.
 * tests/secret-mask.test.ts holds both rules over src/duck/sync.ts and src/duck/stream.ts.
 */
import { withDiskWayOut } from "./disk-full.ts";

/** What a masked value reads as. */
export const MASKED = "****";

/** libpq's `password=` keyword and its value: quoted (`'…'`, a `\` escaping the next character, to the closing quote
 *  or the text's end, a `\` that ends the text included: issue 621, a text cut there was returned whole) or bare (to the
 *  next space or quote); any case, spaces allowed around the `=` as libpq allows */
const PASSWORD_KEYWORD = /\b(password\s*=\s*)(?:'(?:[^'\\]|\\[\s\S]?)*(?:'|$)|[^\s'"]+)/gi;

/** `text` with every `password=` keyword's value masked, and nothing else changed: the leaked form alone, safe for any
 *  stored free text (an error's words, the ledger read back, the scrub at open). */
export function maskPasswordKeyword(text: string): string {
  return text.replace(PASSWORD_KEYWORD, (_m, key: string) => `${key}${MASKED}`);
}

/** The keyword with its value not begun at the text's end (`password`, `password =`): what follows on the next line may
 *  be its value, as libpq allows a newline among the spaces around the `=` */
const KEYWORD_OPEN = /\bpassword\s*(?:=\s*)?$/i;

/** Whether a quoted value (its opening `'` first) has its closing quote, by the keyword's own escapes */
function closed(value: string): boolean {
  let escaped = false;
  for (let i = 1; i < value.length; i++) {
    const c = value[i];
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === "'") return true;
  }
  return false;
}

/**
 * A TEXT READ A LINE AT A TIME, MASKED AS `maskPasswordKeyword` MASKS IT WHOLE (issue 621: a log file an older Mason
 * wrote, read by `mason logs`, holds the leaked form in its lines): the same keyword, the same value, masked the same way,
 * and nothing else changed — never a substring of the password (the reviews of PR 620: an identifier holding it is
 * structure, and a mask cut into it showed where the password sat).
 *
 * A LINE IS ITS UNIT, AND AN ENTRY ITS BOUND. A log entry is a line at the margin and the indented lines under it
 * (src/lib/log.ts `textEntry`), so a value can run on past its line only inside its entry: a quote open at a line's end
 * masks the next indented lines to its closing quote (a password holding a newline), and a keyword at a line's end
 * (`password`, `password =`) takes its value from the next indented line. A line at the margin, or a blank one, starts
 * afresh: a quote an older Mason's line left open (a message cut off) masks its own entry, never the rest of the file.
 * Each line's answer is decided by it and the lines before it, so a reader releases a line as soon as it has it whole,
 * whatever its own chunks (src/lib/log-read.ts), and the answer is the same for every way the file is cut.
 */
export class PasswordLineMask {
  /** what the previous line left open: a quoted value (to its closing quote), or the keyword with its value not begun */
  private open: { quote: true } | { keyword: string } | null = null;

  /** A line not ended yet, masked as it stands, the state left as it was: what a follow shows of a line still being
   *  written (src/lib/log-read.ts `follow`), the whole line read by `line` once its newline comes. */
  peek(raw: string): string {
    const open = this.open;
    try { return this.line(raw); } finally { this.open = open; }
  }

  /** One line (no newline), masked. */
  line(raw: string): string {
    if (raw.trim() === "" || /^\S/.test(raw)) this.open = null;   // a new entry: nothing carries into it
    const open = this.open;
    this.open = null;
    if (open !== null && "quote" in open) {
      // the value runs on from the line before: masked to its closing quote (the newline ended any escape), the rest read as any line
      const indent = /^\s*/.exec(raw)![0];
      let escaped = false;
      for (let i = indent.length; i < raw.length; i++) {
        const c = raw[i];
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "'") return `${indent}${MASKED}${this.alone(raw.slice(i + 1))}`;
      }
      this.open = { quote: true };
      return `${indent}${MASKED}`;
    }
    if (open !== null) {
      // the keyword ended the line before: read with it, and its own text taken off again (the key is kept as written)
      return this.alone(`${open.keyword}\n${raw}`).slice(open.keyword.length + 1);
    }
    return this.alone(raw);
  }

  /** `text` masked whole, and what it leaves open at its end noted for the next line */
  private alone(text: string): string {
    let atEnd: string | null = null;   // the value of a match that runs to the text's end
    const masked = text.replace(PASSWORD_KEYWORD, (match: string, key: string, index: number) => {
      if (index + match.length === text.length) atEnd = match.slice(key.length);
      return `${key}${MASKED}`;
    });
    const value = atEnd as string | null;
    if (value !== null) {
      if (value.startsWith("'") && !closed(value)) this.open = { quote: true };
    } else {
      const k = KEYWORD_OPEN.exec(text);
      if (k !== null) this.open = { keyword: text.slice(k.index) };
    }
    return masked;
  }
}

/** An error's code: a Postgres SQLSTATE or a system error's (`ECONNREFUSED`), the kind the engine names its error by
 *  (`IO Error`), else none — what is said of an error whose words are never repeated (the secret's statement). */
export function errorCode(e: unknown): string | null {
  if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code !== "") return (e as { code: string }).code;
  const m = e instanceof Error ? /^([A-Z][A-Za-z]*(?: [A-Za-z]+)* Error):/.exec(e.message) : null;
  return m?.[1] ?? null;
}

/** A CAUGHT ERROR'S WORDS, AS MASON REPEATS THEM (a log line, an event, a table's `error`, an answer): its message (or,
 *  `stack`, its stack), every `password=` value masked, and a write under `.mason/` that failed for disk space given the
 *  disk's way out (src/lib/disk-full.ts, issue 847). Never matched by a branch: that reads `messageOf`. */
export function errorText(e: unknown, o: { stack?: boolean } = {}): string {
  return withDiskWayOut(maskPasswordKeyword(e instanceof Error ? (o.stack === true ? e.stack ?? e.message : e.message) : String(e)));
}

/** A CAUGHT ERROR'S RAW WORDS, FOR A DECISION ALONE (which failure it is: a wider numeric, a transaction already ended):
 *  never shown — said, logged or stored, an error's words are `errorText`'s. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
