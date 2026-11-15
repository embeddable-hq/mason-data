/**
 * WHETHER THE DATABASE STILL ENFORCES THE KEY A TABLE IS SYNCED BY (issue 1027: a `key:` whose columns were not unique
 * lost synced rows at each poll). The poll writes by key: it deletes every synced row with a key it read, then inserts
 * the rows it read. When two rows of the database share a key and only one of them changed, the other is deleted from
 * the synced data and never inserted again. So a key is safe only while the database itself keeps its rows apart:
 * every key column NOT NULL, and a VALID unique index that is not partial and not over an expression, whose key columns
 * are all among the key's. A primary key is such an index.
 *
 * The sources file is checked against the catalog when it is read (src/cli/sources.ts `keyProblems`), but an index can
 * be dropped while Mason runs. So the sync asks again before every read that writes by key: inside each poll's own
 * source snapshot, where the index the snapshot sees holds for the rows it reads (src/duck/sync.ts `poll`), and before
 * a whole read (`copy`). Read from `pg_attribute`, `pg_index` and `pg_class` alone: index lookups of the catalog by the
 * table's oid, no lock taken and no row of the table read.
 */
import { pgLiteral } from "./pg-wire.ts";
import { regclassName } from "./shape.ts";

/** An index (SQL alias `i`, a `pg_index` row) that keeps rows apart on its key columns: unique, valid (a failed
 *  CREATE UNIQUE INDEX CONCURRENTLY leaves an invalid one, its duplicates still in the table), over the whole table
 *  and over columns only. The catalog's read narrows it further (src/cli/preflight.ts `TABLES_SQL` `unique_keys`). */
export const enforcingIndexSql = (i: string): string =>
  `${i}.indisunique AND ${i}.indisvalid AND ${i}.indpred IS NULL AND ${i}.indexprs IS NULL`;

/** The key columns of index `i` (never its INCLUDE columns), as text[] in their order. */
const indexColumnsSql = (i: string): string =>
  `(SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(${i}.indkey) WITH ORDINALITY AS k(attnum, n) ` +
  `JOIN pg_attribute a ON a.attrelid = ${i}.indrelid AND a.attnum = k.attnum WHERE k.n <= ${i}.indnkeyatts)`;

/**
 * One row about the table `schema.table` and its key `key`: `found` (false when the table is gone, whose read fails as
 * it always did), `nullable` the key's columns that may hold NULL (JSON text), `held` whether an enforcing index is over
 * some of the key's columns, and `usable` the key columns of every enforcing index over NOT NULL columns (JSON text),
 * the way out a refusal names.
 */
export function keyHeldSql(schema: string, table: string, key: readonly string[]): string {
  const names = `ARRAY[${key.map(pgLiteral).join(", ")}]::text[]`;
  const notNullIndex = `NOT EXISTS (SELECT FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n) JOIN pg_attribute a ON a.attrelid = i.indrelid ` +
    "AND a.attnum = k.attnum WHERE k.n <= i.indnkeyatts AND NOT a.attnotnull)";
  return `SELECT r.oid IS NOT NULL AS found, ` +
    `(SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]'::json)::text FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attnum > 0 ` +
    `AND NOT a.attisdropped AND NOT a.attnotnull AND a.attname::text = ANY (${names})) AS nullable, ` +
    `EXISTS (SELECT FROM pg_index i WHERE i.indrelid = r.oid AND ${enforcingIndexSql("i")} AND ${indexColumnsSql("i")} <@ ${names}) AS held, ` +
    `(SELECT coalesce(json_agg(u.cols ORDER BY u.name), '[]'::json)::text FROM (SELECT ic.relname AS name, ${indexColumnsSql("i")} AS cols ` +
    `FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = r.oid AND ${enforcingIndexSql("i")} AND ${notNullIndex}) u) AS usable ` +
    `FROM (SELECT to_regclass(${regclassName(schema, table)}) AS oid) r`;
}

/** The row `keyHeldSql` answers, as read back. */
export interface KeyHeldRow { found: boolean; nullable: string | null; held: boolean; usable: string | null }

const jsonList = <T>(text: string | null): T[] => {
  try {
    const v = text === null ? [] : JSON.parse(text) as unknown;
    return Array.isArray(v) ? v as T[] : [];
  } catch (e) {
    // written by `keyHeldSql` alone, so text that is not JSON is a bug: read as none, which never un-refuses a key
    if (e instanceof SyntaxError) return [];
    throw e;
  }
};

/**
 * Why the sync must not write a table by its key now, in the developer's words, or null when the key is safe (or the
 * table is gone: its read fails as it always did). `at` is where the sources file names the table
 * (`mason/sources/app.yml: tables.logs`); `own` says whether that entry names the key (`key:`) or the table's primary
 * key is used.
 */
export function keyHeldProblem(row: KeyHeldRow, o: { source: string; key: readonly string[]; at: string; own: boolean }): string | null {
  if (!row.found) return null;
  const nullable = jsonList<string>(row.nullable);
  if (row.held && nullable.length === 0) return null;
  const keyText = o.key.join(", ");
  const where = o.own ? `${o.at}.key` : o.at;
  const what: string[] = [];
  if (!row.held) {
    what.push(o.own ? `${o.source} has no unique index over (${keyText}) on the database now, so two of its rows can share a key.`
      : `${o.source} no longer has its primary key (${keyText}) on the database, so two of its rows can share it.`);
  }
  if (nullable.length) what.push(`${nullable.join(", ")} can be NULL in ${o.source} now, and rows with NULL there cannot be told apart.`);
  const usable = jsonList<string[]>(row.usable).filter((c) => Array.isArray(c) && c.length > 0);
  const way = usable.length
    ? `Name the columns of one of its unique indexes in key: (${usable.map((c) => `key: [${c.join(", ")}]`).join(" or ")}), or ask the database's owner to ${o.own ? "add a unique index over the key" : "restore the primary key"}.`
    : `Ask the database's owner to ${o.own ? "add a unique index over NOT NULL columns, or a primary key" : "restore the primary key"}.`;
  return `${where}: ${what.join(" ")} Mason does not sync it until that is fixed, so that no synced row is lost. ${way}`;
}
