/**
 * A PLAIN NUMERIC'S OWN SCALE (issue 946; docs/DESIGN.md "Wide numerics are copied exactly"). A column declared
 * `numeric` with no precision (Rails' `t.decimal`) is synced as DECIMAL(38, s), s the most decimals any of its values
 * has, so the engine's text of `12.5` is `12.50`. Postgres keeps each value's own scale. So beside such a column the
 * copy holds one more, hidden, a UTINYINT per row: the decimals Postgres wrote for that value. The value itself stays
 * the engine's exact DECIMAL, so every comparison, key, filter and aggregate is native; only a reader that PRINTS a
 * value reads the scale (src/duck/rewrite.ts `scaleOf`).
 *
 * The one module that names the hidden column and computes its value, from the source's text, in the engine
 * (`scaleSql`: the copy's chunks, the poll's stage) or here (`scaleOfText`: the stream's rows).
 */
import { createHash } from "node:crypto";

/** the hidden column's name prefix; never a name a source column is given in practice, and never listed (`SCALE_RE`) */
export const SCALE_PREFIX = "__mason_scale_";
/** a hidden scale column's name, and nothing else */
export const SCALE_RE = /^__mason_scale_[0-9a-f]{12}$/;

/** the hidden column holding `column`'s scale: its name hashed, so any column name gives one plain identifier, and hashed
 *  again with a count where the table (`columns`, the source's column names) holds a column of that name itself — a
 *  table may name one anything, and two columns of one name fail the copy for good. Every reader computes it the same
 *  way from the same columns (the copy's own, as recorded) */
export function scaleColumn(column: string, columns: readonly string[]): string {
  // (compared as the engine compares names: case-insensitively)
  const taken = new Set(columns.map((c) => c.toLowerCase()));
  for (let n = 0; ; n++) {
    const name = `${SCALE_PREFIX}${createHash("sha256").update(n === 0 ? column : `${column}\u0000${n}`).digest("hex").slice(0, 12)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** the scale of a numeric's text `text` (a SQL expression of the engine's VARCHAR, as Postgres's numeric_out wrote it:
 *  never an exponent), as the engine computes it: the digits after its point, 0 with none; NULL for NULL */
export const scaleSql = (text: string): string =>
  `CAST(CASE WHEN strpos(${text}, '.') = 0 THEN 0 ELSE length(${text}) - strpos(${text}, '.') END AS UTINYINT)`;

/** the scale of a numeric's text as Postgres's numeric_out wrote it, the stream's (`scaleSql`'s rule) */
export function scaleOfText(text: string | null): number | null {
  if (text === null) return null;
  const at = text.indexOf(".");
  return at < 0 ? 0 : text.length - at - 1;
}

/** how the listener tells the plan a column holds its own scales (`userTypes`, src/api/postgres/server.ts): this prefix,
 *  then the JSON of [schema, table, column, its hidden scale column's name] (`scaledKey`, `scaledOf`) */
export const SCALED_KEY = "scaled:";
export const scaledKey = (schema: string, table: string, column: string, hidden: string): string => `${SCALED_KEY}${JSON.stringify([schema, table, column, hidden])}`;
/** a `scaledKey`'s parts, or null for any other key */
export function scaledOf(key: string): { schema: string; table: string; column: string; hidden: string } | null {
  if (!key.startsWith(SCALED_KEY)) return null;
  const parts = JSON.parse(key.slice(SCALED_KEY.length)) as unknown;
  if (!Array.isArray(parts) || parts.length !== 4 || !parts.every((x) => typeof x === "string")) return null;
  const [schema, table, column, hidden] = parts as [string, string, string, string];
  return { schema, table, column, hidden };
}
