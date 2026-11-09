/**
 * A CLIENT OF A HOSTED MASON SERVICE: the requests `mason login` and `mason logout` make, as docs/HOSTED-API.md
 * documents them (the device authorization grant of RFC 8628, a revoke of RFC 7009, and `GET /v1/me`). Nothing here
 * knows how a service is built; it speaks the documented API to the base URL it is given.
 *
 * WHERE: `MASON_CLOUD_URL`, else `DEFAULT_SERVICE_URL`, read by ONE function (`serviceOf`). HTTPS only, the certificate
 * verified (fetch's own, never turned off); plain http only to this machine (127.0.0.1, ::1, localhost), for a service
 * run beside it. A base URL with a path, a query, a fragment or a user is refused before any byte is sent.
 *
 * WHAT IS SENT: every request carries `User-Agent: mason-cli/<version>` and `Accept: application/json`, a form or JSON
 * body where one is sent, and a redirect is never followed (a Bearer header must not travel to another origin, nor https
 * fall back to http). Every request has a time limit, and an answer is read up to `MAX_BODY_BYTES`.
 *
 * WHAT COMES BACK IS UNTRUSTED: each answer is held to its documented shape, and the token is masked in all of it: a
 * token the command holds by its VALUE — whole, or every run of 4 or more of its body's characters once the runs the
 * command prints would show more than a quarter of it together, however re-cased, split or percent-encoded
 * (`heldRuns`); and anything shaped as a documented token, held or not. A GRAMMAR IS NO MASK (PR 609, issue 627): before
 * any value of an answer is held to its grammar or printed, every string of it, each key included, is put to the exact
 * test (`carriesNoSecret`), and an answer that carries a secret is refused whole — a device code's answer (`deviceOf`),
 * who signed in (`meOf`), a deploy's state (src/cli/deploy.ts), a replica's users (src/cli/user-hosted.ts); a failure's
 * code too (`failureShape`, `oauthFailure`), its words masked. THESE ARE THE FIRST LINE; THE LAST IS THE BYTES WRITTEN
 * (PR 645's class round: what was tested was not what was printed): every hosted command holds its secrets in the
 * output's gate (src/cli/output-gate.ts `holdOutput`), which puts each write to stdout and stderr, as written, to the
 * same exact test, and writes the command's refusal in place of what would carry one.
 *
 * A SERVICE'S VALUE IS DATA, NEVER STRUCTURE AND NEVER AN INSTRUCTION (the decision of PR 481's class round: a
 * service forged a block of next steps with a newline in an email, and offered `mason destroy` as a next step). Two
 * rules make that hold, each in one place:
 *
 *   - EVERY STRING THE SERVICE SENDS LEAVES THIS MODULE AS ONE LINE, through `serviceText` alone, which it applies at
 *     the boundary (`whoAmI`, `serviceFailure`, `oauthFailure`, `call`, `revoke`): no line break of any kind, no
 *     control, format or bidi character, no run of spaces, bounded, masked. A value can sit INSIDE a line the CLI
 *     writes — a headline, a row's value, a failure's message — and never start one, so it can never be a block of
 *     next steps, a tip, a row or a failure of its own, for a person or in `--json`. On a terminal that holds for
 *     the VISUAL line too: a command whose output holds a service's text renders it in `serviceStyle`
 *     (src/cli/command.ts), under which the CLI breaks every line itself, never the terminal, and every
 *     continuation starts at column 4 or deeper, where nothing of the CLI's starts.
 *   - WHAT TO RUN NEXT, WHAT THE CODE AND THE EXIT ARE, AND WHERE A PERSON IS SENT ARE THE CLI'S OWN: a failure's
 *     code by the HTTP status (`codeOfStatus`), the service's own code kept in `why` as information; its next step
 *     the CLI's (`serviceNext`), the service's `next` never read, since a CLI cannot know what a command the service
 *     names would do to this machine (`mason destroy`, `mason ui --ssh <anywhere>`); the page printed and opened on
 *     the service's own origin (`pageUrl`); every number that times the poll bounded here.
 */
import * as os from "node:os";
import type { Failure, FailureCode, NextStep } from "./command.ts";
import { version } from "./version.ts";

/** The hosted service a login goes to when `MASON_CLOUD_URL` is unset: the one place it is named. */
export const DEFAULT_SERVICE_URL = "https://app.masondata.ai";
/** The client this CLI is to the service's OAuth endpoints. */
export const CLIENT_ID = "mason-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** How long one request may take, and how much of an answer is read. */
const REQUEST_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

/** The service as a base URL: its origin (`https://host[:port]`), the key a login is saved under. */
export interface Service { base: string }

/** The documented token shapes (docs/HOSTED-API.md), masked wherever they appear in what is printed. */
const TOKEN_SHAPE = /\bmasondata_(pat|ci)_[A-Za-z0-9_-]{43}/g;
/**
 * A Mason user's password (src/duck/users.ts `userPassword`), masked wherever it appears in what is printed of the
 * service's text: a password is printed by `mason user add`'s own rows alone, from its one answer, held to its grammar
 * (src/cli/user-hosted.ts), never by a message, a note or a row of anything else. Matched whatever precedes it (a
 * letter, a digit or `_` before `mason_` is no boundary a password needs: `user_mason_…`) and in any case. A SHAPE
 * MASK HAS A LIMIT: a password split (by a space, a dash), percent-encoded or written without its `mason_` prefix has
 * no shape to match, and outside add's answer the CLI holds no password to mask by its value.
 */
const PASSWORD_SHAPE = /mason_[0-9a-f]{16}_[0-9a-f]{32}/gi;
/**
 * WHAT OF A HELD SECRET MAY BE PRINTED (`heldRuns`): a run of its body is any `HELD_RUN` or more of its characters in a
 * row, and what every run the process prints shows TOGETHER — across fields, strings and passes — is at most a quarter
 * of the body (`HELD_SHOWN`), else each run is masked. A quarter of a 43-character body is 10 characters, about 60
 * bits, leaving at least 33 (about 198 bits) unknown, so no run, nor any number of runs together, puts the token in
 * reach; any run of a body shorter than 16 is masked (a quarter of it rounds below a run): fail closed. Four, because a
 * 4-character window of ordinary text matches one of a body's 40 windows about once in 40,000 (36^4 / 40), and runs
 * that cover 11 of its characters are three such chances in one command (no text a service words is masked by
 * chance); and a run of 3 or fewer between other characters is no echo but an encoding, which a service that holds
 * the token can make in any form it likes, out of reach of any mask (the note of PR 591).
 */
const HELD_RUN = 4;
const HELD_SHOWN = (bodyLength: number): number => Math.floor(bodyLength / 4);
/** How many times a value is masked before it is given up: a mask joins what lay either side of it, so the value is
 *  read again; read a fifth time and still holding a run to mask, it is masked whole. */
const MASK_PASSES = 4;
/** What this process has printed of each held secret: the positions of its body every run shown covered (one command
 *  is one process, so this is what the command printed, in every field and stream). */
const SHOWN = new Map<string, Set<number>>();
/** The hosts plain http may name: this machine. */
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A URL the service may name, or the CLI may be pointed at: https, or http to this machine. The reason it is not one,
 * else null.
 */
export function urlProblem(u: URL): string | null {
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname) ? null : `http:// is taken only for this machine (127.0.0.1, ::1, localhost), and ${u.hostname} is not it: the login would travel unencrypted`;
  return `${u.protocol.replace(/:$/, "")}:// is not https://`;
}

/** THE SERVICE THIS COMMAND MEANS, from `MASON_CLOUD_URL` or the default; a Failure, before any byte is sent, when it is not one. */
export function serviceOf(env: NodeJS.ProcessEnv = process.env): Service | Failure {
  const raw = env.MASON_CLOUD_URL;
  if (raw === undefined) return { base: new URL(DEFAULT_SERVICE_URL).origin };
  const refuse = (message: string, why?: string): Failure => ({ message, code: "refused", ...(why ? { why } : {}),
    fix: `set MASON_CLOUD_URL to the service's address alone, such as ${DEFAULT_SERVICE_URL} (or http://127.0.0.1:<port> for one on this machine), or unset it for ${DEFAULT_SERVICE_URL}`,
    next: [["unset MASON_CLOUD_URL", `use ${DEFAULT_SERVICE_URL}`]] });
  if (raw.trim() === "") return refuse("MASON_CLOUD_URL is set, and empty");
  let u: URL;
  try { u = new URL(raw); }
  // never repeated: what is not a URL may be anything, a secret pasted in the wrong place included
  catch { return refuse("MASON_CLOUD_URL is not a URL", "it is written as https://<host>[:<port>]"); }
  if (u.username || u.password) return refuse(`MASON_CLOUD_URL carries a user or a password (${u.protocol}//****@${u.host})`, "a login is made by mason login, never written in the URL");
  const problem = urlProblem(u);
  if (problem) return refuse(`MASON_CLOUD_URL is not a URL Mason sends a login to: ${u.origin}`, problem);
  // the extra parts are named, never repeated: a query may carry a secret
  const extra = [u.pathname !== "/" ? "a path" : "", u.search ? "a query" : "", u.hash ? "a fragment" : ""].filter(Boolean);
  if (extra.length) return refuse(`MASON_CLOUD_URL has ${extra.join(" and ")} after the service's address (${u.origin})`, "it is the address alone: every path is the API's own (docs/HOSTED-API.md)");
  return { base: u.origin };
}

/**
 * TEXT FROM THE SERVICE, AS IT MAY BE PRINTED: ONE LINE (above: data, never structure) — every control character, the
 * newline and the carriage return included, and every line or paragraph separator, format or bidi mark replaced by
 * `?`, so none can end a line, move a cursor, clear a screen or reorder what a person reads; every run of white space
 * one space, none at either end; at most `max` characters; and every secret masked — the ones named (`secrets`, the
 * tokens this command holds) whole, and by the runs of their body that would show more than a quarter of it together
 * with what this process printed before (`heldRuns`, `shown`: the process's own record unless a test gives one), and
 * anything shaped as a documented token or a Mason user's password. The masks read the value as it came, before it is made one line and bounded,
 * so neither uncovers what they would have masked. On a terminal the line it sits in is broken by the CLI
 * (`serviceStyle`).
 */
export function serviceText(s: string, max: number, secrets: readonly string[] = [], shown: Map<string, Set<number>> = SHOWN): string {
  let t = maskSecrets(s, secrets, shown);
  // the value as masked, read as the exact test reads it (with and without its escapes), before a line is made of it
  if (echoesSecret(t, secrets)) return "****";
  t = oneLine(t);
  const chars = [...t];
  const line = chars.length > max ? `${chars.slice(0, max).join("")}…` : t;
  // and what is printed is what is tested (PR 645's review): the line as it leaves, put to the exact test too — its
  // changes replace a character by a separator or cut the end, which join nothing, so this holds what they keep so
  return echoesSecret(line, secrets) ? "****" : line;
}

/** `t` AS ONE LINE, as `serviceText` prints a value (pure: no secret read, nothing recorded): every character that would
 *  break or reorder a line replaced by `?`, and no run of spaces. A value equal to its `oneLine` prints as it is. */
export function oneLine(s: string): string {
  // C0 (newline, return and tab with it), DEL and C1 (NEL with it); the zero-width and directional marks; the line and
  // paragraph separators; the bidi embeddings, overrides and isolates; the byte-order mark
  let t = s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "?");
  // and a lone surrogate, which is no character: --json would write it as an escape (`\udc00`), whose letters and
  // digits a reader reads (PR 645's review, round 2)
  t = t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "?");
  // and no run of spaces: a value padded to a terminal's width aligns nothing, and leaves no gap to break at a column of
  // its choosing (src/cli/command.ts breaks every line that holds it: serviceStyle)
  return t.replace(/\s+/g, " ").trim();
}

/**
 * THE SECRET MASKS OF `serviceText`, ALONE, the one place a service's string is read for a secret: every secret named
 * (`secrets`, the tokens this command holds) whole, and by the runs of their body that would show more than a quarter
 * of it together with what `shown` records (`heldRuns`); anything shaped as a documented token; and, unless
 * `passwords` is false (the one answer that makes a password, src/cli/user-hosted.ts), anything shaped as a Mason
 * user's password. The value as it came, masked; unchanged when it carries none. For free text (a note, a refusal's
 * words): a value held to a grammar is put to the exact test instead (`carriesSecret`).
 */
export function maskSecrets(s: string, secrets: readonly string[] = [], shown: Map<string, Set<number>> = SHOWN, o: { passwords?: boolean } = {}): string {
  let t = s;
  // each held secret whole, in every form the one reading reads as it (`canonicalMap`): each span of `t` it is found in
  for (const secret of secrets) t = maskWhole(t, secret);
  // a held secret by its value (`heldRuns`): a mask leaves `****`, a separator, so what lay either side of it is read
  // again as one run; read MASK_PASSES + 1 times and still holding a run to mask, the value is masked whole
  for (let pass = 0; ; pass++) {
    const found = heldRuns(t, secrets);
    const spans: Array<[number, number]> = [];
    for (const [secret, f] of found) {
      const seen = new Set([...(shown.get(secret) ?? []), ...f.covered]);
      if (seen.size > f.most) spans.push(...f.spans);
    }
    if (!spans.length) {
      // what is printed is recorded, so the next field's runs are counted with these
      for (const [secret, f] of found) shown.set(secret, new Set([...(shown.get(secret) ?? []), ...f.covered]));
      break;
    }
    if (pass === MASK_PASSES) return "****";
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const m of spans) {
      const last = merged[merged.length - 1];
      if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
      else merged.push([m[0], m[1]]);
    }
    for (const [from, to] of merged.reverse()) t = `${t.slice(0, from)}****${t.slice(to)}`;
  }
  t = t.replace(TOKEN_SHAPE, "masondata_$1_****");
  return o.passwords === false ? t : t.replace(PASSWORD_SHAPE, "mason_****");
}

/**
 * A HELD SECRET, BY ITS VALUE (issue 540: the shape alone let a token's body through, echoed without its prefix). The
 * body of a secret this command holds is the value after a documented prefix, else the whole value (a token is opaque).
 * The text is read as body characters (`bodyChars`): ASCII letters in lower case, digits, `-` and `_`, a `%XX` escape
 * as the character it encodes, any other character as its compatibility decomposition without its combining marks (a
 * full-width letter, an accented one, precomposed or not), and everything else skipped, as a separator. For each held
 * secret: the spans of `t` that are runs of its body (`HELD_RUN` or more in a row, read once keeping `-` and `_` and once
 * skipping them, so a body split by dashes is read too), with a `-` or `_` beside one; the positions of the body they
 * cover; and how many the process may show (`HELD_SHOWN`). Nothing for a secret none of `t` runs with.
 */
function heldRuns(t: string, secrets: readonly string[]): Map<string, { spans: Array<[number, number]>; covered: Set<number>; most: number }> {
  const found = new Map<string, { spans: Array<[number, number]>; covered: Set<number>; most: number }>();
  const views = [true, false].map((keep) => { const units = bodyChars(t, keep); return { keep, units, read: units.map((u) => u.c).join("") }; });
  for (const secret of secrets) {
    const raw = /^masondata_(?:pat|ci)_(.+)$/s.exec(secret)?.[1] ?? secret;
    const length = bodyChars(raw, true).length;
    // a body shorter than a run is masked whole alone (above), never by runs of ordinary words
    if (length < HELD_RUN) continue;
    const n = Math.min(HELD_RUN, length), spans: Array<[number, number]> = [], covered = new Set<number>();
    for (const { keep, units, read } of views) {
      // the secret read by the reading the text is read by (`readUnits`): one reading, both sides (PR 660's review, R2-B1)
      const body = bodyChars(raw, keep), text = body.map((u) => u.c).join("");
      const at = new Map<string, number[]>();
      for (let j = 0; j + n <= text.length; j++) { const w = text.slice(j, j + n); at.set(w, [...(at.get(w) ?? []), j]); }
      const marked = new Array<boolean>(units.length).fill(false);
      for (let i = 0; i + n <= units.length; i++) {
        const js = at.get(read.slice(i, i + n));
        if (!js) continue;
        for (let d = 0; d < n; d++) marked[i + d] = true;
        for (const j of js) for (let d = 0; d < n; d++) covered.add(body[j + d]!.from);
      }
      // the marked characters in a row are one span, the separators between them in it
      for (let i = 0; i < units.length; i++) {
        if (!marked[i]) continue;
        let e = i;
        while (e + 1 < units.length && marked[e + 1]) e++;
        const span: [number, number] = [units[i]!.from, units[e]!.to];
        // a `-` or `_` beside a run is the body's too (read skipping them, a body that begins or ends with one is a run
        // without it), and a combining mark after it is its last letter's: the mask takes them
        while (span[0] > 0 && /[-_]/.test(t[span[0] - 1]!)) span[0]--;
        while (span[1] < t.length && /[-_\p{M}]/u.test(t[span[1]]!)) span[1]++;
        spans.push(span);
        i = e;
      }
    }
    if (spans.length) found.set(secret, { spans, covered, most: HELD_SHOWN(length) });
  }
  return found;
}

/**
 * WHETHER A VALUE IS AN ECHO OF A HELD SECRET, exactly (PR 609's review, round 2: the quarter rule above bounds what a
 * command SHOWS of a token across what it prints, which is right for masking a few sentences; read across a 2000-user
 * answer of random identifiers, its chance runs of 4 refused up to a fifth of honest lists). A value is an echo when
 * ONE string holds `ECHO_RUN` or more of the secret's body in a row, read as the mask reads it (`bodyChars`: re-cased,
 * percent-decoded, in its compatibility form, with and without `-` and `_`), or the secret whole: never a count across
 * strings, so an answer's size cannot make an honest value one.
 *
 * WHY 11 (the bound it is derived from: an honest answer is refused with a probability under 1 in a million). An honest
 * answer is independent of the token, whose body is 43 random base64url characters: at a fixed place, a character of
 * the answer equals the body's re-cased with a probability of at most 2/62 = 1/31 whatever the answer holds (the last
 * character, of 16 values, at most 1/16, counted twice below). A run of n at one of the body's 43 places is then at
 * most 31^-n, and over W characters read in both views, P(refused) ≤ W × 43 × 2 × 31^-n. The largest answer read is
 * 1 MiB (src/cli/user-hosted.ts `MAX_LIST_BYTES`), each character read at most 18 times by its compatibility form, in
 * two views: W ≤ 2 × 18 × 2^20, and n = 11 gives P ≤ 1.3 × 10^-7 (an ASCII answer: 7 × 10^-9); n = 10 would give 4 ×
 * 10^-6. tests/cli-user-hosted-refusals.test.ts measures it with a fixed seed. WHAT IS LEFT: up to 10 of a body's
 * characters in a row in one string, in any number of strings; a body spread otherwise (a character between each two)
 * is an encoding, out of reach of any mask (the note of PR 591).
 */
export const ECHO_RUN = 11;
/**
 * A HELD SECRET THAT IS NOT A TOKEN (the database's password `mason replica create` sends, src/cli/replica-hosted.ts):
 * its body may be short, or made of characters a body reading skips (`!*!*…a1`), so it is read by its runs only when its
 * body is at least `MIN_BODY_RUN` characters (a run of fewer is met by ordinary words), and WHOLE always (`wholeIn`).
 * Both by THE ONE READING (`readUnits`), the secret and the text alike, at every boundary — the exact test of a value
 * (`echoesSecret`), the masks of free text (`maskSecrets`) and the output's gate (src/cli/output-gate.ts
 * `readingsCarry`) — so no boundary, and no side of a comparison, reads it by another rule (PR 660's review, B1, R2-B1).
 */
export const MIN_BODY_RUN = 8;

/** A terminal's control sequences (CSI, OSC, a two-character escape): a text is read with them and without them, since
 *  one between a secret's characters hides it from a reading that keeps them (`withoutEscapes`). */
export const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
/** `t` without its terminal escapes, the second reading of a text that holds one; else `t`. */
export const withoutEscapes = (t: string): string => t.includes("\x1b") ? t.replace(ESCAPES, "") : t;
const NO_TRACE = /[\p{M}\p{Cf}]/gu;
/** One character as the one reading reads it: its compatibility decomposition (NFKD: NFC, NFD and NFKC alike, a
 *  full-width or ligature form as its letters), its marks and format characters dropped (an accent, a zero-width or
 *  bidi mark), its case folded (upper then lower: `ß` and `SS` alike), any white space one space, any other control
 *  nothing. Its characters, in that reading. */
function readOne(s: string): string {
  const folded = s.normalize("NFKD").replace(NO_TRACE, "").toUpperCase().toLowerCase().normalize("NFKD").replace(NO_TRACE, "");
  return folded.replace(/\s/gu, " ").replace(/\p{Cc}/gu, "");
}

/** A piece of a text as the one reading reads it: what it reads as (`c`, maybe nothing or several characters) and the span
 *  of the text it was read from. */
export interface Unit { c: string; from: number; to: number }

/**
 * THE ONE READING OF A TEXT FOR A SECRET (PR 660's review, R2-B1: the secret and the text were read two ways, and no
 * Unicode form was one): each code point by `readOne`; a run of `%XX` escapes (unless `percent` is false) as what it
 * encodes, UTF-8 where it is, a byte each where it is not. Every comparison of a held secret with a text reads BOTH by
 * it: whole (`canonicalMap`), and by its body (`bodyChars`); a text with a terminal escape, with it and without it.
 */
export function readUnits(t: string, percent = true): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < t.length;) {
    if (percent && t[i] === "%") {
      const m = /^(?:%[0-9a-f]{2})+/i.exec(t.slice(i));
      if (m) {
        const run = m[0];
        let decoded: string;
        try { decoded = decodeURIComponent(run); }
        catch { decoded = run.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))); }   // not UTF-8: a byte each
        out.push({ c: [...decoded].map(readOne).join(""), from: i, to: i + run.length });
        i += run.length;
        continue;
      }
    }
    const code = t.charCodeAt(i);
    // ASCII, as readOne reads it, without the normalisations it would leave unchanged: a letter in lower case, white
    // space one space, a control nothing
    if (code < 0x80) {
      const c = code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : (code >= 9 && code <= 13) || code === 32 ? " " : code < 32 || code === 127 ? "" : t[i]!;
      out.push({ c, from: i, to: i + 1 });
      i += 1;
      continue;
    }
    const one = String.fromCodePoint(t.codePointAt(i)!);
    out.push({ c: readOne(one), from: i, to: i + one.length });
    i += one.length;
  }
  return out;
}

/** A text in the one reading, as one string (every run of spaces one), and for each of its characters the unit it was
 *  read from: what a secret is found whole in, and the span it is masked by. */
export function canonicalMap(t: string): { text: string; at: number[]; units: Unit[] } {
  const units = readUnits(t);
  let text = "";
  const at: number[] = [];
  units.forEach((u, k) => { for (const ch of u.c) { if (ch === " " && (text === "" || text.endsWith(" "))) continue; text += ch; at.push(k); } });
  return { text, at, units };
}

const CANON = new Map<string, string>();
/** A held secret in the one reading, as it is found whole: without white space at either end. */
export function canonicalSecret(secret: string): string {
  let c = CANON.get(secret);
  if (c === undefined) { c = canonicalMap(secret).text.trim(); CANON.set(secret, c); }
  return c;
}

/** Whether `s` holds `secret` whole, in the one reading: as written, re-cased, `%XX`-encoded, in any Unicode form,
 *  its accents dropped, its white space another, a format or control character or a terminal escape inside it. */
export function wholeIn(s: string, secret: string): boolean {
  return canonicalSecret(secret) !== "" && canonicalTexts(s).some((t) => wholeInCanonical(t, secret));
}
/** `s` in the one reading, with its terminal escapes and (when it has one) without them: what a secret is found whole in. */
export function canonicalTexts(s: string): string[] {
  const bare = withoutEscapes(s);
  return bare === s ? [canonicalMap(s).text] : [canonicalMap(s).text, canonicalMap(bare).text];
}
/** Whether a text already in the one reading (`canonicalTexts`) holds `secret` whole. */
export const wholeInCanonical = (canonical: string, secret: string): boolean => { const want = canonicalSecret(secret); return want !== "" && canonical.includes(want); };

/** `t` with every span the one reading finds `secret` whole in masked, `****`. */
function maskWhole(t: string, secret: string): string {
  const want = canonicalSecret(secret);
  if (want === "") return t;
  const m = canonicalMap(t), spans: Array<[number, number]> = [];
  for (let i = m.text.indexOf(want); i >= 0; i = m.text.indexOf(want, i + 1)) spans.push([m.units[m.at[i]!]!.from, m.units[m.at[i + want.length - 1]!]!.to]);
  if (!spans.length) return wholeIn(t, secret) ? "****" : t;
  const merged: Array<[number, number]> = [];
  for (const sp of spans) { const last = merged[merged.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([sp[0], sp[1]]); }
  let out = t;
  for (const [from, to] of merged.reverse()) out = `${out.slice(0, from)}****${out.slice(to)}`;
  // a terminal escape between its characters: found only without them, so the value is masked whole (fail closed)
  return wholeIn(out, secret) ? "****" : out;
}

const echoGrams = new Map<string, Array<{ keep: boolean; n: number; grams: Set<string> }>>();
/** A held secret's runs of `run` (each of its body's windows, read once keeping `-` and `_` and once skipping them):
 *  what an echo is matched against, here and by the output's gate (src/cli/output-gate.ts). */
export function echoViews(secret: string, run: number = ECHO_RUN): Array<{ keep: boolean; n: number; grams: Set<string> }> {
  const key = `${run}\u0000${secret}`;
  let views = echoGrams.get(key);
  if (views === undefined) {
    const raw = /^masondata_(?:pat|ci)_(.+)$/s.exec(secret)?.[1] ?? secret;
    views = [true, false].map((keep) => {
      const body = bodyChars(raw, keep).map((u) => u.c).join("");
      // a body too short to be told apart from words by its runs is read whole alone (`wholeIn`)
      const n = body.length < MIN_BODY_RUN ? 0 : Math.min(run, body.length), grams = new Set<string>();
      for (let j = 0; n > 0 && j + n <= body.length; j++) grams.add(body.slice(j, j + n));
      return { keep, n, grams };
    });
    echoGrams.set(key, views);
  }
  return views;
}
export function echoesSecret(s: string, secrets: readonly string[], run: number = ECHO_RUN): boolean {
  for (const secret of secrets) {
    if (!secret) continue;
    if (wholeIn(s, secret)) return true;
    const views = echoViews(secret, run);
    for (const text of new Set([s, withoutEscapes(s)])) for (const { keep, n, grams } of views) {
      if (n === 0) continue;
      const read = bodyChars(text, keep).map((u) => u.c).join("");
      for (let i = 0; i + n <= read.length; i++) if (grams.has(read.slice(i, i + n))) return true;
    }
  }
  return false;
}

/**
 * WHETHER A STRING THE SERVICE SENT CARRIES A SECRET, exactly: an echo of a held secret (`echoesSecret`), anything
 * shaped as a documented token, and — unless `passwords` is false (the one answer that makes a password) — anything
 * shaped as a Mason user's password. The one test a value held to a grammar is put to before it is printed (a grammar
 * alone is no mask: src/cli/user-hosted.ts `carriesNoSecret`, and a failure's code, `failureShape`).
 */
export function carriesSecret(s: string, secrets: readonly string[] = [], o: { passwords?: boolean } = {}): boolean {
  return echoesSecret(s, secrets) || shapedSecret(s, o);
}

/** Whether `s` holds anything shaped as a documented token, or (unless `passwords` is false) a Mason user's password. */
export function shapedSecret(s: string, o: { passwords?: boolean } = {}): boolean {
  return s.search(TOKEN_SHAPE) >= 0 || (o.passwords !== false && s.search(PASSWORD_SHAPE) >= 0);
}

/** `t` as a held secret is compared by (`bodyChars`), as one string: re-cased, in its compatibility form, `-` and `_`
 *  kept or not, a `%XX` escape read as what it encodes or (`percent` false) as the characters it is written with. */
export const bodyRead = (t: string, keepMarks: boolean, percent: boolean): string => bodyChars(t, keepMarks, percent).map((u) => u.c).join("");

/**
 * NO STRING OF AN ANSWER CARRIES A SECRET (PR 609's decision, the one point every hosted command's answer passes, issue
 * 627: a grammar alone is no mask — a deploy's id, a device code, a sign-in page, a user's name can each spell the token
 * and were printed as they came): EVERY string of the answer, each key included, is put to the exact test
 * (`carriesSecret`: an echo of a held secret, `ECHO_RUN` of its body in a row in that one string; a token's or a
 * password's shape), before any is held to its grammar or printed. An answer any string of which carries one is outside
 * the contract, refused whole: nothing of it is printed. The test is per string and exact, so an honest answer is
 * refused with a probability under 1 in a million whatever its size (`ECHO_RUN`'s derivation). `own`: the top-level
 * keys that carry the password this answer makes (src/cli/user-hosted.ts add's `password`, `url`, `psql`), read for the
 * token alone. A FAILURE'S WORDS (a message, a why, a fix) are free text the CLI prints as the service worded them,
 * masked (`serviceText`), never refused: a caller passes an answer without them, and its code is put to this test
 * (`failureShape`, `oauthFailure`).
 */
export function carriesNoSecret(json: unknown, secrets: readonly string[], own: readonly string[] = []): boolean {
  const clean = (v: string, passwords: boolean): boolean => !carriesSecret(v, secrets, { passwords });
  // the walk keeps its own stack, never the call stack (PR 645's review: an answer of 10 KB nested 3000 deep overflowed
  // it, a crash after login's token was granted), and an answer deeper than any documented shape is outside them all
  const stack: Array<{ v: unknown; depth: number; passwords: boolean }> = [{ v: json, depth: 0, passwords: true }];
  while (stack.length) {
    const { v, depth, passwords } = stack.pop()!;
    if (typeof v === "string") { if (!clean(v, passwords)) return false; continue; }
    if (typeof v !== "object" || v === null) continue;
    if (depth >= MAX_ANSWER_DEPTH) return false;
    if (Array.isArray(v)) { for (const x of v) stack.push({ v: x, depth: depth + 1, passwords }); continue; }
    for (const [k, x] of Object.entries(v)) {
      if (!clean(k, true)) return false;
      // `own` names top-level keys alone
      stack.push({ v: x, depth: depth + 1, passwords: depth === 0 ? !own.includes(k) : passwords });
    }
  }
  return true;
}

/** How deep an answer may nest (an object or an array in another): every documented answer is under 6 deep
 *  (docs/HOSTED-API.md; a replica's user list, the deepest, is 4), so 32 is room, and anything deeper is no answer of
 *  the contract's. The walk's size is bounded by the answer's bytes (`call`'s `maxBytes`). */
export const MAX_ANSWER_DEPTH = 32;

/** The characters of `t` a held secret is compared by, its BODY (letters, digits, and `-` and `_` unless `keepMarks` is
 *  false), in the one reading (`readUnits`), each with the span of `t` it was read from: the secret and the text alike. */
function bodyChars(t: string, keepMarks: boolean, percent = true): Unit[] {
  const kept = keepMarks ? /[a-z0-9_-]/ : /[a-z0-9]/;
  const out: Unit[] = [];
  for (const u of readUnits(t, percent)) for (const c of u.c) if (kept.test(c)) out.push({ c, from: u.from, to: u.to });
  return out;
}

/** This machine's name, as the service lists the login: printable ASCII, at most 64 characters, never empty (the
 *  service refuses any other `device_name` with 400 invalid_request). */
export function deviceName(hostname: string = os.hostname()): string {
  const name = hostname.replace(/[^\x20-\x7e]/g, "-").trim().slice(0, 64).trim();
  return name || "unknown";
}

/** An answer: its status, its JSON (undefined when it is not JSON), the request that drew it, and the seconds its
 *  `Retry-After` asks for (delta-seconds, 1 to 3600; null when it sent none, or one in another form). */
export interface Answer { status: number; json: unknown; what: string; retryAfter: number | null }

/** `Retry-After` as delta-seconds (RFC 9110 10.2.3), 1 to 3600; null for none, an HTTP date or anything else. */
export function retryAfterOf(v: string | null): number | null {
  if (v === null || !/^\d{1,4}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= 1 && n <= 3600 ? n : null;
}

/** A time the service sends: ISO 8601 with its zone, digits, `-`, `T`, `:` and `.` alone, and a time Date reads. */
export const isServiceTime = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * ONE REQUEST TO THE SERVICE: `form` as an urlencoded body or `json` as a JSON one, `token` as a Bearer header. The
 * answer, or a Failure when none came back whole: not reached, a redirect, larger than `maxBytes` (`MAX_BODY_BYTES`
 * unless the contract documents another bound for this request), no answer within `timeoutMs` (`REQUEST_MS` unless the
 * contract documents a longer wait: a replica's creation). A status is the caller's to read.
 */
export async function call(service: Service, method: "GET" | "POST" | "DELETE", path: string, o: { form?: Record<string, string>; json?: unknown; token?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<Answer | Failure> {
  const what = `${method} ${path}`;
  const secrets = o.token ? [o.token] : [];
  const headers: Record<string, string> = { "User-Agent": `mason-cli/${version()}`, Accept: "application/json" };
  if (o.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (o.json !== undefined) headers["Content-Type"] = "application/json";
  const body = o.form ? new URLSearchParams(o.form).toString() : o.json !== undefined ? JSON.stringify(o.json) : undefined;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let res: Response;
  try {
    res = await fetch(new URL(path, service.base), { method, headers, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? REQUEST_MS),
      ...(body !== undefined ? { body } : {}) });
  } catch (e) {
    return { message: `could not reach ${service.base}`, code: "failed", why: serviceText(reachError(e, o.timeoutMs ?? REQUEST_MS), 300, secrets),
      fix: `check this machine is online, and that MASON_CLOUD_URL names the service (it is ${service.base})`, next: [] };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return { message: `${service.base} answered ${what} with a redirect (${res.status})`, code: "failed",
      why: "Mason follows no redirect: a login must never travel to an address it was not given", fix: "set MASON_CLOUD_URL to the service's own address" };
  }
  const max = o.maxBytes ?? MAX_BODY_BYTES;
  const text = await boundedText(res, max);
  if (text === null || text === TOO_LARGE_TEXT) {
    const f: Failure = { message: `${service.base} answered ${what} with more than ${max / 1024} KiB`, code: "failed", why: "no documented answer is that large" };
    if (text === TOO_LARGE_TEXT) TOO_LARGE.add(f);
    return f;
  }
  let json: unknown;
  if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(res.headers.get("content-type") ?? "")) {
    try { json = JSON.parse(text); } catch { json = undefined; }
  }
  return { status: res.status, json, what, retryAfter: retryAfterOf(res.headers.get("retry-after")) };
}

/** Why a fetch did not get an answer, in a line: the system's code, a certificate's reason, or the time limit. */
function reachError(e: unknown, ms: number): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err.name === "TimeoutError") return `no answer within ${ms / 1000} s`;
  const cause = err.cause;
  if (cause?.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(cause.code)) return `its certificate could not be verified (${cause.code}): Mason sends a login only over a verified connection`;
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ""}`;
  return cause?.message ?? err.message ?? String(e);
}

/** The failures of `call` that are an answer past its bound, which came whole up to it: an answer, never a wait (a body
 *  cut off midway is no answer, and a caller may wait on it). */
const TOO_LARGE = new WeakSet<Failure>();
const TOO_LARGE_TEXT = Symbol("too large");
export const tooLarge = (f: Failure): boolean => TOO_LARGE.has(f);

/** The body as text; null when it was cut off midway; `TOO_LARGE_TEXT` past `max` bytes (the rest is not read). */
async function boundedText(res: Response, max: number): Promise<string | null | typeof TOO_LARGE_TEXT> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    let r: Awaited<ReturnType<typeof reader.read>>;
    try { r = await reader.read(); }
    catch { return null; }   // a body cut off midway is no answer: said as one the caller cannot read
    if (r.done) break;
    size += r.value.byteLength;
    if (size > max) { await reader.cancel(); return TOO_LARGE_TEXT; }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const isFailure = (a: unknown): a is Failure => typeof a === "object" && a !== null && "message" in a && "code" in a;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An answer outside the documented shape: said by its status alone, never its body (which may carry anything). */
export function unexpected(service: Service, a: Answer, step: string): Failure {
  return { message: `${service.base} answered ${a.what} with ${a.status}${a.json === undefined ? ", not JSON" : ""}, where ${step}`, code: "failed",
    why: "the answer is not the one docs/HOSTED-API.md documents for it", fix: "try again in a moment; if it persists, this Mason may be older than the service: upgrade it" };
}

/**
 * THE CLI'S CODE FOR A SERVICE'S FAILURE, by its HTTP status alone (the one place it is decided): the service refused
 * what was asked (401, 403, any other 4xx) is `refused`, a thing it does not have (404) `not_found`, anything else
 * (5xx) `failed`. Never `usage` or `timeout`, whose exit codes (2, 124) say something of THIS command line or wait:
 * the service's own word for it is information (`serviceFailure` keeps it in `why`), never the CLI's contract.
 */
export function codeOfStatus(status: number): FailureCode {
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "refused";
  return "failed";
}

/**
 * WHAT TO RUN AFTER A SERVICE'S FAILURE: the CLI's own step, by the HTTP status (the one place it is decided). The
 * service's `next` is never read: whatever it names, the CLI cannot know what it would do to this machine, and a coding
 * agent runs the step it is given.
 */
export function serviceNext(status: number): NextStep[] {
  return [status === 401 || status === 403 ? ["mason login", "sign in again"] : ["mason login", "try again in a moment"]];
}

/**
 * A `/v1/` FAILURE: `{ error: { code, message, why?, fix? }, next: [{ command, what? }] }`, its message, why and fix
 * said as the service worded them, each one line (`serviceText`); its CODE the CLI's own (`codeOfStatus`), the
 * service's kept in `why`; its next step the CLI's own (`serviceNext`, or the command's own `next` for the status, never
 * the service's). Null when the answer is not that shape.
 */
export function serviceFailure(a: Answer, secrets: readonly string[], next: (status: number) => NextStep[] = serviceNext): Failure | null {
  if (a.status < 400 || !obj(a.json)) return null;
  return failureShape(a.json.error, secrets, { code: codeOfStatus(a.status), said: (code) => `the service said ${code}, HTTP ${a.status}`, next: next(a.status) });
}

/**
 * A FAILURE'S WORDS AS THE SERVICE SENDS THEM, `{ code, message, why?, fix? }`: message, why and fix each one line
 * (`serviceText`); everything else the CLI's — the code `as.code`, the service's kept in `why` (`as.said`), the next
 * steps `as.next` (any `next` beside it is never read). Null when it is not that shape. A `/v1/` failure's `error`
 * (`serviceFailure`), and a refused or failed deploy's `failure` (src/cli/deploy.ts): one reader for both.
 */
export function failureShape(error: unknown, secrets: readonly string[], as: { code: FailureCode; said: (code: string) => string; next: NextStep[] }): Failure | null {
  if (!obj(error)) return null;
  const e = error;
  // the code is printed as it came (inside why), so it is held to its grammar AND carries no secret (`maskSecrets`)
  if (!str(e.code, 64) || !/^[a-z][a-z0-9_]*$/.test(e.code) || carriesSecret(e.code, secrets) || !str(e.message, 2000)) return null;
  const text = (v: unknown, max: number): string | undefined => typeof v === "string" && v ? serviceText(v, max, secrets) : undefined;
  const why = text(e.why, 2000);
  const said = as.said(e.code);
  return { message: serviceText(e.message, 2000, secrets), code: as.code, why: why ? `${why} (${said})` : said, fix: text(e.fix, 2000), next: as.next };
}

/** The device code the service gave: the code a person approves, where, and for how long. */
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; expiresIn: number; interval: number }

/**
 * A PAGE THE SERVICE SENDS A PERSON TO, which is printed and, on a terminal, opened: on the service's OWN origin (the
 * address MASON_CLOUD_URL named, or the default), as the URL parser writes it, with no user or password. A page
 * elsewhere would send the person, and their code, to an address nobody chose: `elsewhere` names it, as it is printed.
 * Null when it is not a URL, or when what would be printed carries a secret.
 *
 * WHAT IS PRINTED IS WHAT IS TESTED (PR 645's review: the answer's string passed the exact test, and the parser's
 * `href` printed the saved login's body whole, in pieces of 10 — `/x/../` between them is a dot segment the parser
 * removes — and nothing masked it; a host in Unicode labels is printed in its `xn--` form, which can spell the body):
 * the parser's own serialisation, the `href` or the `origin`, is what is tested, as it is printed — by the exact test
 * (`carriesSecret`), and by the held secrets' mask (`maskSecrets`), since a page is printed and opened whole, so a page
 * the mask would change is no page to send a person to: either refuses it. An honest page is refused by the mask with
 * a probability under 1 in a million (it must hold 3 runs of 4 of a 43-character body by chance).
 */
export function pageUrl(service: Service, v: unknown, secrets: readonly string[]): { href: string } | { elsewhere: string } | null {
  if (!str(v, 2048)) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  // and the line as it is printed, cut at `max` (PR 645's review, round 2: a cut inside a `%XX` escape left `%4…`, whose
  // 4 the whole page's reading had decoded away)
  const shown = (printed: string, max: number): string | null => {
    const line = serviceText(printed, max);
    return carriesSecret(printed, secrets) || carriesSecret(line, secrets) || maskSecrets(printed, secrets) !== printed ? null : line;
  };
  if (u.origin !== service.base) {
    const at = shown(u.protocol === "https:" || u.protocol === "http:" ? u.origin : `${u.protocol}//`, 300);
    return at === null ? null : { elsewhere: at };
  }
  if (u.username || u.password) return null;
  const href = shown(u.href, 2048);
  return href === null ? null : { href };
}

/**
 * `POST /oauth/device/code`: a device code, or a Failure. `secrets`: what the command holds that the service may echo (a
 * login saved for this service, which a new one replaces).
 */
export async function startDevice(service: Service, secrets: readonly string[] = []): Promise<DeviceCode | Failure> {
  const a = await call(service, "POST", "/oauth/device/code", { form: { client_id: CLIENT_ID, device_name: deviceName() } });
  if (isFailure(a)) return a;
  if (a.status === 429) {
    // the service's limit of sign-ins from this address: waiting is the way out, never a loop of retries
    return { message: `${service.base} is limiting sign-ins from this address (429)`, code: "failed", why: "too many sign-ins were asked for from here in a short time",
      fix: "try again in a few minutes", next: [["mason login", "in a few minutes"]] };
  }
  if (a.status !== 200) return oauthFailure(service, a, "a sign-in was asked for", secrets);
  return deviceOf(service, a, secrets);
}

/**
 * A DEVICE CODE'S ANSWER (200), held: every string of it, each key included, put to the exact test first
 * (`carriesNoSecret`: the device code, the user code, each page, a key outside the shape), then each to its grammar,
 * the pages on the service's own origin (`pageUrl`). The device code, or a Failure said by the status alone.
 */
export function deviceOf(service: Service, a: Answer, secrets: readonly string[]): DeviceCode | Failure {
  const j = a.json;
  if (!obj(j) || !carriesNoSecret(j, secrets)) return unexpected(service, a, "a device code was expected");
  const userCode = typeof j.user_code === "string" ? /^([A-Za-z]{4})-?([A-Za-z]{4})$/.exec(j.user_code) : null;
  const page = pageUrl(service, j.verification_uri, secrets);
  const completePage = j.verification_uri_complete === undefined ? null : pageUrl(service, j.verification_uri_complete, secrets);
  for (const p of [page, completePage]) {
    if (p && "elsewhere" in p) {
      return { message: `${service.base} named a sign-in page on another address: ${p.elsewhere}`, code: "refused",
        why: `a sign-in page is printed and opened only on the service's own address, ${service.base}: anything else would send you, and the code, to an address nobody chose`,
        fix: "check MASON_CLOUD_URL names the service you mean; if it does, the service is answering outside its documented API" };
    }
  }
  const verificationUri = page && "href" in page ? page.href : null;
  const complete = completePage && "href" in completePage ? completePage.href : null;
  const expiresIn = j.expires_in, interval = j.interval ?? 5;
  if (!str(j.device_code, 2048) || !/^[\x21-\x7e]+$/.test(j.device_code) || !userCode || !verificationUri
    || (j.verification_uri_complete !== undefined && complete === null)
    || !Number.isInteger(expiresIn) || (expiresIn as number) < 1 || (expiresIn as number) > 3600
    || !Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 300) return unexpected(service, a, "a device code was expected");
  // the user code as it is printed, put to the test as it is printed (8 letters and a dash: it cannot hold ECHO_RUN)
  const shownCode = `${userCode[1]}-${userCode[2]}`;
  if (carriesSecret(shownCode, secrets)) return unexpected(service, a, "a device code was expected");
  return { deviceCode: j.device_code, userCode: shownCode, verificationUri, verificationUriComplete: complete,
    expiresIn: expiresIn as number, interval: interval as number };
}

/** One poll of `POST /oauth/token`: the token, still pending, asked to slow down, or a Failure (denied, expired, refused). */
export type Poll = { token: string } | { pending: true } | { slowDown: true } | Failure;

/** `secrets`: as `startDevice`'s (the token this poll is answered with is the service's to send, never one it echoes). */
export async function pollToken(service: Service, code: DeviceCode, secrets: readonly string[] = []): Promise<Poll> {
  const a = await call(service, "POST", "/oauth/token", { form: { grant_type: DEVICE_GRANT, device_code: code.deviceCode, client_id: CLIENT_ID } });
  if (isFailure(a)) return a;
  if (a.status === 200) {
    const j = a.json;
    // a token is opaque, but it is sent back as a header: printable ASCII, no space, bounded
    if (!obj(j) || !str(j.access_token, 4096) || !/^[\x21-\x7e]+$/.test(j.access_token) || typeof j.token_type !== "string" || j.token_type.toLowerCase() !== "bearer") {
      return unexpected(service, a, "a token was expected");
    }
    return { token: j.access_token };
  }
  const error = obj(a.json) && typeof a.json.error === "string" ? a.json.error : null;
  if (a.status === 400 && error === "authorization_pending") return { pending: true };
  if (a.status === 400 && error === "slow_down") return { slowDown: true };
  const again: NextStep[] = [["mason login", "a new code, to approve"]];
  if (a.status === 400 && error === "access_denied") {
    return { message: `the sign-in with code ${code.userCode} was denied`, code: "refused", why: "the code was refused on the service's page",
      fix: "run mason login again and approve the code it shows, signed in as the account this machine should use", next: again };
  }
  if (a.status === 400 && error === "expired_token") return expired(code);
  return oauthFailure(service, a, "the sign-in was polled", secrets);
}

/** The code ran out before it was approved: a timeout, its way out a new one. */
export function expired(code: DeviceCode): Failure {
  return { message: `the code ${code.userCode} expired before it was approved`, code: "timeout", why: `a code lasts ${Math.round(code.expiresIn / 60) || 1} min from mason login`,
    fix: "run mason login again, and approve the new code on the page it opens", next: [["mason login", "a new code, to approve"]] };
}

/**
 * An OAuth endpoint's refusal (`{ error, error_description? }`, RFC 6749), or anything else it answered, as a Failure.
 * Its code is printed as it came, so it is held to its grammar AND carries no secret (`carriesSecret`, as
 * `failureShape` holds a `/v1/` failure's); its description is free text, masked (`serviceText`).
 */
export function oauthFailure(service: Service, a: Answer, step: string, secrets: readonly string[]): Failure {
  const j = obj(a.json) ? a.json : null;
  if (j && str(j.error, 64) && /^[a-z_]+$/.test(j.error) && !carriesSecret(j.error, secrets)) {
    return { message: `${service.base} refused this sign-in (${j.error}) when ${step}`, code: "failed",
      why: typeof j.error_description === "string" && j.error_description ? serviceText(j.error_description, 1000, secrets) : undefined,
      fix: "run mason login again; if it is refused again, this Mason may be older than the service expects: upgrade it", next: [["mason login", "try again"]] };
  }
  return unexpected(service, a, step);
}

/** Who a token signs in as: `GET /v1/me`. */
export interface Me { email: string; name: string; orgs: Array<{ slug: string; name: string; role: string }> }

/** `held`: what else the command holds that the service may echo (the login this one replaces). */
export async function whoAmI(service: Service, token: string, held: readonly string[] = []): Promise<Me | Failure> {
  const a = await call(service, "GET", "/v1/me", { token });
  if (isFailure(a)) return a;
  const secrets = [token, ...held];
  if (a.status !== 200) return serviceFailure(a, secrets) ?? unexpected(service, a, "the account signed in was asked for");
  return meOf(service, a, secrets);
}

/**
 * `GET /v1/me`'s answer (200), held: every string of it, each key included, put to the exact test first
 * (`carriesNoSecret`: the email, the name, each organisation's slug, name and role, a key outside the shape), then to
 * its shape; each value then one line, masked (`serviceText`, with `secrets[0]`, the token it was asked with). Who
 * signed in, or a Failure said by the status alone.
 */
export function meOf(service: Service, a: Answer, secrets: readonly string[]): Me | Failure {
  const j = a.json;
  const orgs = obj(j) && Array.isArray(j.orgs) ? j.orgs : null;
  if (!obj(j) || !carriesNoSecret(j, secrets) || !str(j.email, 320) || typeof j.name !== "string" || j.name.length > 300 || orgs === null || orgs.length > 1000
    || !orgs.every((o) => obj(o) && str(o.slug, 200) && typeof o.name === "string" && o.name.length <= 300 && str(o.role, 32))) {
    return unexpected(service, a, "the account signed in was asked for");
  }
  // at the boundary: who signed in leaves here as one line each, the token masked in it (above), for every reader
  const line = (v: string, max: number): string => serviceText(v, max, secrets.slice(0, 1));
  return { email: line(j.email, 320), name: line(j.name, 300),
    orgs: (orgs as Array<Record<string, string>>).map((o) => ({ slug: line(o.slug!, 200), name: line(o.name!, 200), role: line(o.role!, 32) })) };
}

/** `POST /oauth/revoke` (RFC 7009): null once the service took it, else why it did not (a revoke is best effort). */
export async function revoke(service: Service, token: string): Promise<string | null> {
  const a = await call(service, "POST", "/oauth/revoke", { form: { token, token_type_hint: "access_token", client_id: CLIENT_ID } });
  if (isFailure(a)) return serviceText(`${a.message}${a.why ? ` (${a.why})` : ""}`, 400, [token]);
  if (a.status !== 200) return `${service.base} answered ${a.what} with ${a.status}`;
  return null;
}
