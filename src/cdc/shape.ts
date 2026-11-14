/**
 * A TABLE'S COLUMNS AS ONE TEXT, its SHAPE (issue 977: a running Mason never saw a column added, renamed or dropped on the
 * database): each live column's name, type oid and type modifier, in their order, as a JSON array of
 * `[name, oid, typmod]` — never `format_type`'s words, which name a type by the session's search_path. Read from
 * `pg_attribute` alone: an index lookup of the catalog by the table's oid, no lock taken and no row of the table read.
 *
 * ONE fragment for both readers, so the two are equal by construction: the catalog's read (src/cli/preflight.ts
 * `TABLES_SQL` `shape`, carried on `SourceTable.shape`) and the sync's check before a poll and after a stream's relation
 * message (src/duck/sync.ts `shapesNow`). The ORDER BY is the aggregate's, over the catalog's rows of one table: never a
 * sort of a table's rows.
 */
import { pgIdent, pgLiteral } from "./pg-wire.ts";

/** The shape of the table whose oid is `rel` (SQL: `c.oid`, or `to_regclass(…)`, which is null for a table gone, and
 *  so is its shape). */
export const shapeSql = (rel: string): string => "(SELECT coalesce(json_agg(json_build_array(a.attname, a.atttypid, a.atttypmod) ORDER BY a.attnum), '[]'::json)::text " +
  `FROM pg_attribute a WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped)`;

/** A table's name as `to_regclass` reads it, as an SQL literal: quoted, so a name of any case or character is the table
 *  it names. */
export const regclassName = (schema: string, table: string): string => pgLiteral(`${pgIdent(schema)}.${pgIdent(table)}`);

/** The column names a shape holds, in order: a shape this module did not write reads as none. */
export function shapeColumns(shape: string): string[] {
  try {
    const cols = JSON.parse(shape) as unknown;
    return Array.isArray(cols) ? cols.flatMap((c) => Array.isArray(c) && typeof c[0] === "string" ? [c[0]] : []) : [];
  } catch (e) {
    // a shape is written by `shapeSql` alone, so a text that is not JSON is a bug: said by its caller as no columns
    if (e instanceof SyntaxError) return [];
    throw e;
  }
}
