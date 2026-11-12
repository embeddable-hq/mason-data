/**
 * A TYPE THE SOURCE MADE HAS THE SOURCE'S OID IN THE CATALOG TOO (issue 861): one OID space for the wire and the catalog.
 *
 * The wire sends a column of a type a database made (an enum, a citext, a composite, a table's whole row) with the
 * SOURCE's OID, which the source's own clients cached. The catalog Postgres (PGlite) made that type itself, and both
 * count from 16384, so its pg_type held the same number as another type (a table's row type): a client that names a
 * column by looking its RowDescription OID up in pg_type (JDBC's getColumnTypeName, npgsql, asyncpg) read the wrong
 * type, and a Parse naming the source's OID was read as that other type. So the catalog's own rows are MOVED to the
 * source's OIDs once its DDL ran, before a view or a default stores a tree that names one: what the wire sends, what
 * pg_type says, a Parse's parameter types and the analysis's own OIDs are then one number, with no map between two.
 *
 * A move is the catalog's own foreign keys to pg_type (`pg_get_catalog_foreign_keys()`: pg_attribute.atttypid,
 * pg_proc's argument and result types, pg_operator, pg_opclass, pg_amop, pg_cast, pg_enum, pg_class.reltype …) and its
 * polymorphic references (pg_depend, pg_shdepend, pg_description), all in one transaction, so an extension's type
 * (citext, with its operators and operator classes) moves whole. What stands at a target first moves out of the way,
 * to an OID nothing holds and no target is. Nothing is moved below 16384, nor onto it: a built-in type is never touched.
 * A placement that fails is rolled back whole, and the catalog keeps its own OIDs, which it then sends on the wire too
 * (src/duck/plan.ts reads the analysis's): one space still, said by the caller in the log.
 */
import type { PgSchema } from "./schema.ts";
import { madeTypeName } from "./schema.ts";

/** the first OID Postgres gives an object made after initdb (FirstNormalObjectId) */
const FIRST_NORMAL_OID = 16384;
const MAX_OID = 4294967295;

/** one of the catalog's types to be held at the source's OID: by its name (`to_regtype`), as its element's array, or
 *  as a table's row type */
export type TypePlacement = { oid: number } & ({ type: string } | { arrayOf: string } | { table: string });

/** the SQL a placement is read and made with (a PGlite instance, or any Postgres connection) */
export interface PlacementDb {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  exec(sql: string): Promise<unknown>;
}

const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** what the schema says of each made type's source OID: a column's type and its array type, a table's whole row */
export function typePlacements(schema: PgSchema): TypePlacement[] {
  const out: TypePlacement[] = [];
  for (const t of schema.tables) {
    if (t.rowTypeOid !== undefined) out.push({ oid: t.rowTypeOid, table: `${ident(t.schema ?? "public")}.${ident(t.name)}` });
    for (const c of t.columns) {
      if (c.typeOid === undefined || c.spelled === undefined) continue;
      // the element as the catalog declared it (catalogDdl): a made type under its name, its typmod left off
      const element = c.made !== undefined ? madeTypeName(c.spelled) : c.spelled.replace(/\[\]$/, "");
      // an array column's own OID is its array type's (pg_attribute.atttypid): its element's is not known
      if (c.spelled.endsWith("[]")) { out.push({ oid: c.typeOid, arrayOf: element }); continue; }
      out.push({ oid: c.typeOid, type: element });
      if (c.typeArrayOid !== undefined) out.push({ oid: c.typeArrayOid, arrayOf: element });
    }
  }
  return out;
}

/** what a placement did: how many types it moved, and what it could not place and why (said in the log) */
export interface Placed { moved: number; skipped: string[] }

const what = (p: TypePlacement): string => "type" in p ? p.type : "arrayOf" in p ? `${p.arrayOf}[]` : `the row type of ${p.table}`;

/**
 * Moves each placement's type to its OID, in ONE transaction: everything or nothing. Throws what Postgres refused,
 * the transaction rolled back.
 */
export async function placeTypes(db: PlacementDb, placements: readonly TypePlacement[]): Promise<Placed> {
  const skipped: string[] = [];
  // each placement's type as the catalog holds it now
  const current = new Map<number, number>();   // the catalog's OID → the source's
  const wanted = new Map<number, number>();    // the source's OID → the catalog's
  for (const p of placements) {
    const sql = "type" in p ? `SELECT pg_catalog.to_regtype(${literal(p.type)})::oid::int8 AS oid`
      : "arrayOf" in p ? `SELECT t.typarray::int8 AS oid FROM pg_catalog.pg_type t WHERE t.oid = pg_catalog.to_regtype(${literal(p.arrayOf)})`
        : `SELECT c.reltype::int8 AS oid FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass(${literal(p.table)})`;
    const at = Number((await db.query(sql)).rows[0]?.oid ?? 0);
    if (!(at >= FIRST_NORMAL_OID)) { skipped.push(`${what(p)}: the catalog has no such type of its own`); continue; }
    if (!(Number.isInteger(p.oid) && p.oid >= FIRST_NORMAL_OID && p.oid <= MAX_OID)) { skipped.push(`${what(p)}: the source's OID ${p.oid} is no OID a database makes`); continue; }
    const before = current.get(at), other = wanted.get(p.oid);
    if (before === p.oid) continue;
    if (before !== undefined || (other !== undefined && other !== at)) { skipped.push(`${what(p)}: two OIDs for one type, or one OID for two`); continue; }
    current.set(at, p.oid);
    wanted.set(p.oid, at);
  }
  // the pairs whose two ends agree (a type given two OIDs, or two types one, kept its first and was said)
  const pairs = [...current].filter(([at, to]) => wanted.get(to) === at);
  const moving = pairs.filter(([at, to]) => at !== to);
  if (moving.length === 0) return { moved: 0, skipped };
  const targets = new Set(pairs.map(([, to]) => to));
  const inPlace = new Set(pairs.filter(([at, to]) => at === to).map(([at]) => at));
  // every OID the catalog's pg_type holds past initdb's: a free one is none of them and no target
  const taken = new Set((await db.query(`SELECT oid::int8 AS oid FROM pg_catalog.pg_type WHERE oid >= ${FIRST_NORMAL_OID}`)).rows.map((r) => Number(r.oid)));
  // what stands at a target and is not the type placed there: moved out of the way, for good
  const inTheWay = [...targets].filter((o) => taken.has(o) && !inPlace.has(o) && !current.has(o));
  let next = FIRST_NORMAL_OID;
  const free = (): number => {
    while (taken.has(next) || targets.has(next)) next++;
    if (next > MAX_OID) throw new Error("the catalog has no OID free to move a type through");
    taken.add(next);
    return next;
  };
  // first every type that moves and every type in the way, each to an OID of its own; then each to its target
  const aside = new Map(moving.map(([at]) => [at, free()]));
  const first = new Map<number, number>([...aside, ...inTheWay.map((o) => [o, free()] as const)]);
  const second = new Map(moving.map(([at, to]) => [aside.get(at)!, to]));
  const keys = (await db.query("SELECT fktable::text AS t, fkcols[1]::text AS c, is_array, (SELECT a.atttypid::regtype::text FROM pg_catalog.pg_attribute a " +
    "WHERE a.attrelid = k.fktable AND a.attname = k.fkcols[1]) AS type FROM pg_catalog.pg_get_catalog_foreign_keys() k " +
    "WHERE k.pktable = 'pg_catalog.pg_type'::regclass AND pg_catalog.cardinality(k.fkcols) = 1")).rows
    .map((r) => ({ table: String(r.t), column: String(r.c), array: r.is_array === true, type: String(r.type) }));
  await db.exec("BEGIN");
  try {
    for (const map of [first, second]) await move(db, map, keys);
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
  return { moved: moving.length, skipped };
}

/** every reference to each type, and the type's own row, from its OID to the map's: OIDs nothing holds, so one statement each */
async function move(db: PlacementDb, map: ReadonlyMap<number, number>, keys: ReadonlyArray<{ table: string; column: string; array: boolean; type: string }>): Promise<void> {
  if (map.size === 0) return;
  // every OID written as an oid: one past 2^31 is no int4
  const olds = [...map.keys()].map((o) => `${o}::oid`).join(", ");
  const scalar = (x: string): string => `CASE ${x} ${[...map].map(([a, b]) => `WHEN ${a}::oid THEN ${b}::oid`).join(" ")} ELSE ${x} END`;
  const pairs = `(VALUES ${[...map].map(([a, b]) => `(${a}::oid, ${b}::oid)`).join(", ")}) AS m(a, b)`;
  await db.exec(`UPDATE pg_catalog.pg_type SET oid = ${scalar("oid")} WHERE oid IN (${olds})`);
  for (const k of keys) {
    const col = ident(k.column), table = `pg_catalog.${ident(k.table)}`;
    if (!k.array) { await db.exec(`UPDATE ${table} SET ${col} = ${scalar(col)} WHERE ${col} IN (${olds})`); continue; }
    // an array of OIDs (oid[]) or an oidvector, element by element in its order
    const elements = `(SELECT pg_catalog.array_agg(coalesce(m.b, e.o) ORDER BY e.i) FROM pg_catalog.unnest(${col}::oid[]) WITH ORDINALITY AS e(o, i) LEFT JOIN ${pairs} ON m.a = e.o)`;
    const value = k.type === "oidvector" ? `pg_catalog.array_to_string(${elements}, ' ')::pg_catalog.oidvector` : elements;
    await db.exec(`UPDATE ${table} SET ${col} = ${value} WHERE ${col}::oid[] && ARRAY[${olds}]`);
  }
  // the references by class and object
  for (const [table, cls, obj] of [["pg_depend", "classid", "objid"], ["pg_depend", "refclassid", "refobjid"], ["pg_shdepend", "classid", "objid"],
    ["pg_description", "classoid", "objoid"]] as const) {
    await db.exec(`UPDATE pg_catalog.${table} SET ${obj} = ${scalar(obj)} WHERE ${cls} = 'pg_catalog.pg_type'::regclass AND ${obj} IN (${olds})`);
  }
}
