/**
 * THE ONE MASK OF THE SOURCE'S PASSWORD in what Mason says (issue 599: the engine's error repeated the connection
 * string, `password='…'` included, into the log, the ledger, `mason status` and the web page). The decision that
 * makes that impossible is elsewhere — the engine is given the password through its secret manager, never in a string
 * it repeats (src/duck/sync.ts `attach`) — and this is the defence behind it: every message the sync lets out (its
 * log, its events, its ledger rows, its answers) passes through `maskSecret`, so a dependency that repeats a secret
 * one day repeats `****`.
 *
 * It masks the password in every form a message can carry it — raw; percent-encoded as `encodeURIComponent` and a
 * URL's userinfo encode it; quoted for libpq (`\'`, `\\`), SQL (`''`) and JSON — and, whatever the password, the value
 * of any `password=` keyword (quoted with libpq's escapes, or bare): the form the old string leaked, so a password
 * since rotated, which this run does not know, is masked as well. tests/secret-mask.test.ts holds every form.
 */

/** What a masked secret reads as. */
export const MASKED = "****";

/** libpq's `password=` keyword and its value: quoted (`'…'`, a `\` escaping the next character, to the closing quote
 *  or the text's end) or bare (to the next space or quote); any case, spaces allowed around the `=` as libpq allows */
const PASSWORD_KEYWORD = /\b(password\s*=\s*)(?:'(?:[^'\\]|\\[\s\S])*(?:'|$)|[^\s'"]+)/gi;

/** a URL's userinfo percent-encode set (WHATWG): what `new URL` encodes in a password, which `encodeURIComponent` does
 *  not quite match (it leaves `%`, `$`, `&`, `+`, `,` and `'` as they are) */
const userinfoEncoded = (s: string): string =>
  Array.from(s, (ch) => /^[A-Za-z0-9\-._~!$%&'()*+,]$/.test(ch) ? ch : encodeURIComponent(ch) === ch ? ch : [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")).join("");

/** Every form of `secret` a message may hold it in, longest first (so a longer form is masked whole, never in part). */
export function secretForms(secret: string): string[] {
  if (secret === "") return [];
  const forms = new Set<string>([
    secret,
    encodeURIComponent(secret),
    userinfoEncoded(secret),
    secret.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    secret.replace(/'/g, "''"),
    JSON.stringify(secret).slice(1, -1),
  ]);
  return [...forms].filter((f) => f !== "").sort((a, b) => b.length - a.length);
}

/**
 * `text` with the secret masked in every form (`secretForms`), and every `password=` keyword's value masked whatever
 * it is. `secret` null or empty masks the keyword form alone (a reader that knows no password: the ledger read back).
 */
export function maskSecret(text: string, secret: string | null | undefined): string {
  let out = text.replace(PASSWORD_KEYWORD, (_m, key: string) => `${key}${MASKED}`);
  for (const f of secretForms(secret ?? "")) out = out.split(f).join(MASKED);
  return out;
}

/** `value` with `maskSecret` applied to every string in it (an answer's objects and arrays, walked); anything else as it is. */
export function maskDeep<T>(value: T, secret: string | null | undefined): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskSecret(v, secret);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** An error with its message (and stack) masked, its class kept: what is rethrown to a caller that says it. */
export function maskError(e: unknown, secret: string | null | undefined): unknown {
  if (e instanceof Error) {
    e.message = maskSecret(e.message, secret);
    if (e.stack !== undefined) e.stack = maskSecret(e.stack, secret);
    return e;
  }
  return typeof e === "string" ? maskSecret(e, secret) : e;
}
