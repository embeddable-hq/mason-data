/**
 * AN ERROR'S WORDS, AS MASON REPEATS THEM, NEVER HOLDING THE SOURCE'S PASSWORD (issue 599: the engine's error repeated
 * the connection string, `password='…'` included, into the log, the ledger, `mason status` and the web page). The
 * decision that makes that impossible is elsewhere — the engine is given the password through its secret manager, never
 * in a string it repeats (src/duck/sync.ts `attach`) — and this is the defence behind it, applied where a dependency's
 * error ENTERS Mason: `errorText` is how the sync turns a caught engine or driver error into its own words (a log line,
 * an event, a table's `error`, an answer), once, so every later use is of the cleaned text.
 *
 * WHAT IS MASKED IS A DEPENDENCY'S FREE TEXT, NEVER STRUCTURE (the review of PR 620: a mask walked over whole answers
 * turned `public.devices` into `public.****ices` under the password `dev`, so `mason wait` never matched the table to
 * its synced data, and the answer showed where the password sat in a known name). Table names, phases, timestamps,
 * slot names, states, codes and counts are Mason's and are never rewritten.
 *
 * In an error's words it masks:
 * - always, the value of any `password=` keyword (quoted with libpq's escapes, or bare): the exact form the old string
 *   leaked, whatever the password (one since rotated, which this run does not know, too);
 * - a password that can be told from the words around it (`maskable`: 6 characters or more, not letters alone), in every
 *   form a message carries it — raw; percent-encoded as `encodeURIComponent` and a URL's userinfo encode it; quoted for
 *   libpq (`\'`, `\\`), SQL (`''`) and JSON;
 * - a password that cannot (`dev`, `secret`): any error whose words still hold it in any form is WITHHELD, its code kept
 *   and why said in Mason's words — a substring mask there would rewrite the words, and show where the password is.
 * tests/secret-mask.test.ts holds every form.
 */

/** What a masked value reads as. */
export const MASKED = "****";

/** libpq's `password=` keyword and its value: quoted (`'…'`, a `\` escaping the next character, to the closing quote
 *  or the text's end) or bare (to the next space or quote); any case, spaces allowed around the `=` as libpq allows */
const PASSWORD_KEYWORD = /\b(password\s*=\s*)(?:'(?:[^'\\]|\\[\s\S])*(?:'|$)|[^\s'"]+)/gi;

/** `text` with every `password=` keyword's value masked, and nothing else changed: the leaked form alone, safe for any
 *  stored free text (the ledger read back, the scrub at open). */
export function maskPasswordKeyword(text: string): string {
  return text.replace(PASSWORD_KEYWORD, (_m, key: string) => `${key}${MASKED}`);
}

/** Whether a password can be masked inside a message's words: long enough, and not a word itself. A shorter or
 *  letters-only one (`dev`, `secret`) may be part of a table's name or a word of the error, so its errors are withheld. */
export function maskable(secret: string): boolean {
  return secret.length >= 6 && !/^\p{L}+$/u.test(secret);
}

/** a URL's userinfo percent-encode set (WHATWG): what `new URL` encodes in a password, which `encodeURIComponent` does
 *  not quite match (it leaves `%`, `$`, `&`, `+`, `,` and `'` as they are) */
const userinfoEncoded = (s: string): string =>
  Array.from(s, (ch) => /^[A-Za-z0-9\-._~!$%&'()*+,]$/.test(ch) ? ch : [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")).join("");

/** the last password's forms, computed once (a run has one source) */
let formsOf: { secret: string; forms: string[] } | null = null;

/** Every form of `secret` a message may hold it in, longest first (so a longer form is masked whole, never in part). */
export function secretForms(secret: string): string[] {
  if (secret === "") return [];
  if (formsOf?.secret === secret) return formsOf.forms;
  const forms = [...new Set<string>([
    secret,
    encodeURIComponent(secret),
    userinfoEncoded(secret),
    secret.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    secret.replace(/'/g, "''"),
    JSON.stringify(secret).slice(1, -1),
  ])].filter((f) => f !== "").sort((a, b) => b.length - a.length);
  formsOf = { secret, forms };
  return forms;
}

/** An error's code, kept when its words are withheld: a Postgres SQLSTATE or a system error's (`ECONNREFUSED`), the
 *  kind the engine names its error by (`IO Error`), else none. */
export function errorCode(e: unknown): string | null {
  if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code !== "") return (e as { code: string }).code;
  const m = e instanceof Error ? /^([A-Z][A-Za-z]*(?: [A-Za-z]+)* Error):/.exec(e.message) : null;
  return m?.[1] ?? null;
}

/**
 * A CAUGHT ERROR'S WORDS, AS MASON REPEATS THEM: its message (or, `stack`, its stack), with any `password=` value
 * masked, and the source's password masked in every form when it can be (`maskable`); when it cannot and the words hold
 * it, the words are withheld and the error's code kept, said why. `secret` empty or absent: the keyword form alone.
 */
export function errorText(e: unknown, secret: string | null | undefined, o: { stack?: boolean } = {}): string {
  const raw = e instanceof Error ? (o.stack === true ? e.stack ?? e.message : e.message) : String(e);
  const keyed = maskPasswordKeyword(raw);
  if (!secret) return keyed;
  const forms = secretForms(secret);
  if (maskable(secret)) {
    let out = keyed;
    for (const f of forms) out = out.split(f).join(MASKED);
    return out;
  }
  if (!forms.some((f) => keyed.includes(f))) return keyed;
  const code = errorCode(e);
  return `${code === null ? "an error" : `an error (${code})`} whose words are not shown: they hold the database user's password, or a word equal to it, ` +
    `and a password under 6 characters or of letters alone cannot be told apart from the words around it (with a longer one, Mason masks it and shows the rest: ALTER ROLE … PASSWORD, then the URL in .env)`;
}
