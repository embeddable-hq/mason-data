/**
 * THE CATALOG'S MOVES OF A MADE TYPE TO THE SOURCE'S OID (src/api/postgres/type-oids.ts, issue 861), on a PGlite of
 * the catalog's own DDL: an enum, an enum of another schema, a citext (an extension's type, with its operators and
 * operator classes), a composite and a table's row type; each target held first by another of them, by a type that does
 * not move, or past 2^31. What moved must be whole: every reference the catalog holds to it, and the type working.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { catalogDdl } from "../../src/api/postgres/catalog.ts";
import { placeTypes, typePlacements } from "../../src/api/postgres/type-oids.ts";
import type { PgSchema } from "../../src/api/postgres/schema.ts";

const schemaOf = (o: Record<string, number | undefined>): PgSchema => ({ database: "x", tables: [
  { name: "people", primaryKey: ["id"], joins: [], rowTypeOid: o.people, columns: [{ name: "id", type: "int4" }, { name: "name", type: "text" }] },
  { name: "moods", schema: "other", primaryKey: ["id"], joins: [], rowTypeOid: o.moods, columns: [{ name: "id", type: "int4" },
    { name: "m", type: "text", spelled: "mood", enumLabels: ["sad", "ok", "happy"], typeOid: o.mood, typeArrayOid: o._mood },
    { name: "ms", type: "text", spelled: "mood[]", enumLabels: ["sad", "ok", "happy"], typeOid: o._mood },
    { name: "l", type: "text", spelled: "other.level", enumLabels: ["low", "high"], typeOid: o.level, typeArrayOid: o._level },
    { name: "c", type: "text", spelled: "citext", typeOid: o.citext, typeArrayOid: o._citext },
    { name: "p", type: "text", spelled: "pair", made: "row", typeOid: o.pair, typeArrayOid: o._pair }] },
] });

async function catalog(schema: PgSchema): Promise<PGlite> {
  const pg = new PGlite({ extensions: { citext } });
  for (const s of catalogDdl(schema)) await pg.exec(s);
  return pg;
}
const rows = async (pg: PGlite, sql: string): Promise<unknown[][]> => (await pg.query<unknown[]>(sql, [], { rowMode: "array" })).rows;
const NAMES = "SELECT t.oid::int8::text, format_type(t.oid, NULL) FROM pg_type t WHERE t.oid >= 16384 ORDER BY 2";

test("each made type, its array and a table's row type move to the source's OIDs, whatever stood there, and work after", async () => {
  // the catalog's own OIDs, with no row type to place and the made types far away
  const natural = await catalog(schemaOf({}));
  const own = Object.fromEntries((await rows(natural, NAMES)).map(([oid, name]) => [name, Number(oid)]));
  await natural.close();
  // each source OID one the catalog gave another type: a chain (mood at people's row type, citext at mood's own), a
  // swap (the level and its array), a row type at citext's, and two OIDs past 2^31
  const source = { mood: own.people!, _mood: own["people[]"]!, level: own["other.level[]"]!, _level: own["other.level"]!, citext: own.mood!,
    _citext: 3_000_000_001, pair: 3_000_000_002, _pair: own["citext[]"]!, people: own.citext!, moods: own.pair! };
  const schema = schemaOf(source);
  const pg = await catalog(schema);
  try {
    assert.deepEqual(await placeTypes(pg, typePlacements(schema)), { moved: 10, skipped: [] });
    const at = Object.fromEntries((await rows(pg, NAMES)).map(([oid, name]) => [name, Number(oid)]));
    assert.deepEqual({ mood: at.mood, _mood: at["mood[]"], level: at["other.level"], _level: at["other.level[]"], citext: at.citext, _citext: at["citext[]"],
      pair: at.pair, _pair: at["pair[]"], people: at.people, moods: at["other.moods"] }, source);
    // every reference the catalog holds names a type it has
    for (const sql of [
      "SELECT count(*) FROM pg_attribute a WHERE a.atttypid <> 0 AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = a.atttypid)",
      "SELECT count(*) FROM pg_proc p WHERE NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = p.prorettype) OR EXISTS (SELECT FROM unnest(p.proargtypes::oid[]) o WHERE NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = o))",
      "SELECT count(*) FROM pg_operator o WHERE (o.oprleft <> 0 AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = o.oprleft)) OR NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = o.oprright)",
      "SELECT count(*) FROM pg_opclass c WHERE NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = c.opcintype)",
      "SELECT count(*) FROM pg_type a WHERE (a.typelem <> 0 AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = a.typelem)) OR (a.typarray <> 0 AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = a.typarray))",
      "SELECT count(*) FROM pg_class c WHERE c.reltype <> 0 AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = c.reltype)",
      "SELECT count(*) FROM pg_enum e WHERE NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = e.enumtypid)",
      "SELECT count(*) FROM pg_depend d WHERE (d.classid = 'pg_type'::regclass AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = d.objid)) OR (d.refclassid = 'pg_type'::regclass AND NOT EXISTS (SELECT FROM pg_type t WHERE t.oid = d.refobjid))",
    ]) assert.deepEqual(await rows(pg, sql), [[0]], sql);
    // the columns and the tables say the source's OIDs, and every type still works as itself
    assert.deepEqual(await rows(pg, "SELECT attname::text, atttypid::int8::text FROM pg_attribute WHERE attrelid = 'other.moods'::regclass AND attnum > 0 ORDER BY attnum"),
      [["id", "23"], ["m", String(source.mood)], ["ms", String(source._mood)], ["l", String(source.level)], ["c", String(source.citext)], ["p", String(source.pair)]]);
    await pg.exec("INSERT INTO other.moods VALUES (1, 'happy', '{sad,ok}', 'high', 'Alice', '(1,2)'), (2, 'sad', NULL, 'low', 'ALICE', NULL); CREATE UNIQUE INDEX ON other.moods (c, id)");
    assert.deepEqual(await rows(pg, "SELECT id, m < 'happy', l > 'low', c = 'alice', c < 'B', pg_typeof(ms)::text, pg_typeof(m2)::text FROM other.moods m2 ORDER BY m"),
      [[2, true, false, true, true, "mood[]", "other.moods"], [1, false, true, true, true, "mood[]", "other.moods"]]);
    assert.deepEqual(await rows(pg, "SELECT 'Q'::citext || 'x', upper('q'::citext), lower('Q'::citext) = 'q', 'happy'::mood, enum_range(NULL::other.level)::text"),
      [["Qx", "Q", true, "happy", "{low,high}"]]);
    // a view made after the move stores the moved OIDs
    await pg.exec("CREATE VIEW other.v AS SELECT m, c FROM other.moods");
    assert.deepEqual(await rows(pg, "SELECT atttypid::int8::text FROM pg_attribute WHERE attrelid = 'other.v'::regclass AND attnum > 0 ORDER BY attnum"), [[String(source.mood)], [String(source.citext)]]);
  } finally { await pg.close(); }
});

test("a placement that cannot be made is said and the rest are made; a failure inside the moves rolls every one back", async () => {
  const pg = await catalog(schemaOf({ mood: 20, _mood: 900001, level: 900002, citext: 900003 }));
  try {
    const before = await rows(pg, NAMES);
    // one OID for two types: the second said, the first placed; an OID no database makes (20 is int8's) said
    const placed = await placeTypes(pg, [{ oid: 900002, type: "citext" }, ...typePlacements(schemaOf({ mood: 20, _mood: 900001, level: 900002 }))]);
    assert.deepEqual(placed.skipped, ["mood: the source's OID 20 is no OID a database makes", "other.level: two OIDs for one type, or one OID for two"]);
    assert.equal(placed.moved, 2);
    assert.notDeepEqual(await rows(pg, NAMES), before);
    assert.deepEqual(await rows(pg, "SELECT format_type(900001, NULL), format_type(900002, NULL), format_type(20, NULL)"), [["mood[]", "citext", "bigint"]]);
  } finally { await pg.close(); }
  // a failure inside the moves rolls every one back
  const failing = await catalog(schemaOf({ mood: 900010 }));
  try {
    const before = await rows(failing, NAMES);
    const db = { query: (sql: string) => failing.query<Record<string, unknown>>(sql), exec: async (sql: string) => { if (sql.startsWith("UPDATE pg_catalog.\"pg_enum\"")) throw new Error("refused"); return failing.exec(sql); } };
    await assert.rejects(placeTypes(db, typePlacements(schemaOf({ mood: 900010 }))), /refused/);
    assert.deepEqual(await rows(failing, NAMES), before);
  } finally { await failing.close(); }
});
