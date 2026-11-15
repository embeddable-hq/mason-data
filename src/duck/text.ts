/**
 * HOW MASON TURNS BYTES INTO TEXT, EXACTLY (issue 991). A default `TextDecoder` drops one leading U+FEFF (a byte-order
 * mark), so a value or a name that starts with one lost it: Postgres keeps it, and so must Mason.
 *
 * - DuckDB's strings. `@duckdb/node-api` decodes every VARCHAR it hands Mason with one decoder of its own,
 *   `dataAccessors.textDecoder`: an answer's values (`getRows`, `getRowsJS`, `getRowsJson`), the text inside a list, a
 *   struct, a map or a union (their children are VARCHAR vectors), a VARIANT's text, and every name Mason reads from
 *   its own catalog (a DESCRIBE, `duckdb_columns()`). Its `getString` reads that export at each call, so
 *   `keepLeadingBom` replaces it with `utf8`, and every one of those paths keeps the mark. Enum labels and an answer's
 *   column names come from the native binding, which never drops it.
 * - Mason's own decoders of a client's or a source's text use `utf8` or `utf8Fatal`, never a default `TextDecoder`.
 *
 * `openDuck` (src/duck/store.ts) calls `keepLeadingBom` before it opens the instance, and proves it on that instance:
 * a library that stopped reading the export would serve text without its mark, so the open refuses instead.
 */
import { createRequire } from "node:module";

/** UTF-8 that keeps a leading U+FEFF, and replaces bytes that are no UTF-8 */
export const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
/** UTF-8 that keeps a leading U+FEFF, and throws a TypeError on bytes that are no UTF-8 */
export const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** the text `openDuck` reads back to prove the decoder took: two marks, so a decoder that drops one shows */
export const BOM_PROBE = "\uFEFF\uFEFFa";

/** the part of `@duckdb/node-api/lib/vectors/dataAccessors.js` this reads (the package has no exports map) */
interface Accessors { textDecoder: unknown }

const require = createRequire(import.meta.url);

/** Makes `@duckdb/node-api` decode every string with `utf8` in this thread (each worker thread loads its own copy of
 *  the library, so each calls this). Idempotent. */
export function keepLeadingBom(): void {
  const accessors = require("@duckdb/node-api/lib/vectors/dataAccessors.js") as Accessors;
  if (accessors.textDecoder === utf8) return;
  if (!(accessors.textDecoder instanceof TextDecoder)) {
    throw new Error("Mason cannot read the synced data's text exactly: @duckdb/node-api no longer decodes strings the way this Mason expects. Install the @duckdb/node-api version package.json pins");
  }
  accessors.textDecoder = utf8;
}

/**
 * POSTGRES'S WHITE SPACE in an array's or a row's text: what array_in skips around an element, and what array_out and
 * record_out quote (scanner_isspace, and isspace in the C locale). Never JavaScript's `\s` or `trim()`, which also
 * take U+FEFF, U+00A0 and every other Unicode space: an element that starts with a byte-order mark was quoted, and the
 * stream read one without its mark.
 */
const PG_SPACE = " \\t\\n\\r\\v\\f";
const SPACE = new RegExp(`[${PG_SPACE}]`);
const SPACE_AT_ENDS = new RegExp(`^[${PG_SPACE}]+|[${PG_SPACE}]+$`, "g");
const ARRAY_QUOTED = new RegExp(`[{},"\\\\${PG_SPACE}]`);
const RECORD_QUOTED = new RegExp(`["\\\\(),${PG_SPACE}]`);
/** a character Postgres reads as white space in an array's text */
export const isPgSpace = (c: string): boolean => SPACE.test(c);
/** `s` without the white space Postgres skips at its ends */
export const pgTrim = (s: string): string => s.replace(SPACE_AT_ENDS, "");
/** an element array_out quotes: empty, NULL's word, or holding a brace, a comma, a quote, a backslash or white space */
export const arrayQuotes = (t: string): boolean => t === "" || /^null$/i.test(t) || ARRAY_QUOTED.test(t);
/** a column record_out quotes: empty, or holding a quote, a backslash, a parenthesis, a comma or white space */
export const recordQuotes = (c: string): boolean => c === "" || RECORD_QUOTED.test(c);
