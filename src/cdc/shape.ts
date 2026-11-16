/**
 * A TABLE'S COLUMNS AS ONE TEXT, its SHAPE (issue 977: a running Mason never saw a column added, renamed or dropped on the
 * database): each live column's name, type oid, type modifier, number and whether it is generated, in their order, as a
 * JSON array of `[name, oid, typmod, attnum, generated]` — never `format_type`'s words, which name a type by the
 * session's search_path. Read from `pg_attribute` alone: an index lookup of the catalog by the table's oid, no lock
 * taken and no row of the table read. The number is the column's identity (issue 1073: a swap of two names, or a drop
 * and an add of one name, changes no name list), so any change of which column holds which name changes the shape. It
 * begins with the table's oid and a colon (`16401:[…]`): a table dropped and made again under its name, or another
 * renamed into its place, is another table, whatever its columns, so its shape is another (the re-check of PR 1078: a
 * table made again with the same columns failed every poll, its shape read as the same).
 *
 * ONE fragment for both readers, so the two are equal by construction: the catalog's read (src/cli/preflight.ts
 * `TABLES_SQL` `shape`, carried on `SourceTable.shape`) and the sync's check before a poll and after a stream's relation
 * message (src/duck/sync.ts `shapesNow`). The ORDER BY is the aggregate's, over the catalog's rows of one table: never a
 * sort of a table's rows.
 */
import { pgIdent, pgLiteral } from "./pg-wire.ts";

/** The shape of the table whose oid is `rel` (SQL: `c.oid`, or `to_regclass(…)`, which is null for a table gone, and
 *  so is its shape). */
export const shapeSql = (rel: string): string => `(SELECT (${rel})::oid::text || ':' || ` +
  "coalesce(json_agg(json_build_array(a.attname, a.atttypid, a.atttypmod, a.attnum, a.attgenerated <> '') ORDER BY a.attnum), '[]'::json)::text " +
  `FROM pg_attribute a WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped)`;

/** A table's name as `to_regclass` reads it, as an SQL literal: quoted, so a name of any case or character is the table
 *  it names. */
export const regclassName = (schema: string, table: string): string => pgLiteral(`${pgIdent(schema)}.${pgIdent(table)}`);

/**
 * WHETHER THE COLUMNS A READ NAMED ARE STILL THE COLUMNS IT MEANT (issue 1073), asked in the read's own transaction
 * AFTER the read: true when `schema.table` is still the table `oid` and each `[attnum, name]` is still that column's
 * name. The read holds its lock on the table until its transaction ends, so no rename can commit between it and this.
 * It asks `pg_identify_object`, which reads the catalog as it is now, the names the read was bound to — never
 * `pg_attribute`, which a REPEATABLE READ transaction reads as of its snapshot, taken before the read and so before a
 * rename that committed between the two (measured on Postgres 16: after `a` and `salary` were swapped, `SELECT a` read the
 * salary, `pg_attribute` still said `a`, and `pg_identify_object` said `salary`).
 */
export function identitySql(schema: string, table: string, oid: number, columns: ReadonlyArray<{ attnum: number; name: string }>): string {
  const pairs = columns.map((c) => `(${Math.trunc(c.attnum)}, ${pgLiteral(c.name)})`).join(", ");
  const same = `(SELECT coalesce(bool_and((pg_identify_object('pg_class'::regclass, ${Math.trunc(oid)}::oid, v.n)).identity IS NOT DISTINCT FROM ` +
    `format('%I.%I.%I', ${pgLiteral(schema)}::text, ${pgLiteral(table)}::text, v.c)), true) FROM (VALUES ${pairs}) AS v(n, c))`;
  return `SELECT CASE WHEN to_regclass(${regclassName(schema, table)}) IS DISTINCT FROM ${Math.trunc(oid)}::oid THEN false ELSE ${columns.length ? same : "true"} END AS same`;
}

/** One column of a shape: its name, type oid, type modifier, number (`attnum`) and whether it is generated. */
export interface ShapeColumn { name: string; typeOid: number; typmod: number; attnum: number; generated: boolean }

/** The table's oid a shape begins with, or null for a shape without one (a test's). */
export function shapeOid(shape: string): number | null {
  const m = /^(\d+):/.exec(shape);
  return m === null ? null : Number(m[1]);
}

/** A shape's columns, in order, each its name, type oid, type modifier, number and whether it is generated (Postgres's
 *  JSON writes an oid as a string): a shape this module did not write reads as none. */
export function shapeTuples(shape: string): ShapeColumn[] {
  try {
    const cols = JSON.parse(shape.replace(/^\d+:/, "")) as unknown;
    return Array.isArray(cols) ? cols.flatMap((c) => Array.isArray(c) && typeof c[0] === "string"
      ? [{ name: c[0], typeOid: Number(c[1]), typmod: Number(c[2]), attnum: Number(c[3]), generated: c[4] === true }] : []) : [];
  } catch (e) {
    // a shape is written by `shapeSql` alone, so a text that is not JSON is a bug: said by its caller as no columns
    if (e instanceof SyntaxError) return [];
    throw e;
  }
}

/** The column names a shape holds, in order. */
export const shapeColumns = (shape: string): string[] => shapeTuples(shape).map((c) => c.name);
