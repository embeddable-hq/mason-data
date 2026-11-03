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

/** What a masked value reads as. */
export const MASKED = "****";

/** libpq's `password=` keyword and its value: quoted (`'…'`, a `\` escaping the next character, to the closing quote
 *  or the text's end) or bare (to the next space or quote); any case, spaces allowed around the `=` as libpq allows */
const PASSWORD_KEYWORD = /\b(password\s*=\s*)(?:'(?:[^'\\]|\\[\s\S])*(?:'|$)|[^\s'"]+)/gi;

/** `text` with every `password=` keyword's value masked, and nothing else changed: the leaked form alone, safe for any
 *  stored free text (an error's words, the ledger read back, the scrub at open). */
export function maskPasswordKeyword(text: string): string {
  return text.replace(PASSWORD_KEYWORD, (_m, key: string) => `${key}${MASKED}`);
}

/** An error's code: a Postgres SQLSTATE or a system error's (`ECONNREFUSED`), the kind the engine names its error by
 *  (`IO Error`), else none — what is said of an error whose words are never repeated (the secret's statement). */
export function errorCode(e: unknown): string | null {
  if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code !== "") return (e as { code: string }).code;
  const m = e instanceof Error ? /^([A-Z][A-Za-z]*(?: [A-Za-z]+)* Error):/.exec(e.message) : null;
  return m?.[1] ?? null;
}

/** A CAUGHT ERROR'S WORDS, AS MASON REPEATS THEM (a log line, an event, a table's `error`, an answer): its message (or,
 *  `stack`, its stack), every `password=` value masked. Never matched by a branch: that reads `messageOf`. */
export function errorText(e: unknown, o: { stack?: boolean } = {}): string {
  return maskPasswordKeyword(e instanceof Error ? (o.stack === true ? e.stack ?? e.message : e.message) : String(e));
}

/** A CAUGHT ERROR'S RAW WORDS, FOR A DECISION ALONE (which failure it is: a wider numeric, a transaction already ended):
 *  never shown — said, logged or stored, an error's words are `errorText`'s. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
