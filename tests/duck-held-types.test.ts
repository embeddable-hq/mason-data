/**
 * WHAT THE COPY HOLDS FOR EACH POSTGRES TYPE (src/duck/held-types.ts, issues 126 and 129): the list held to pg_type, so a
 * type Postgres adds, or one nobody decided, fails here, and the wire's and the catalog's reading of it.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { VARCHAR } from "@duckdb/node-api";
import { CATALOG_LSN_PADDED, HELD, holdOf, isNative, sourceForms, ZONED_HELD } from "../src/duck/held-types.ts";
import { pgTypedColumn } from "../src/duck/types.ts";
import { catalogDdl } from "../src/api/postgres/catalog.ts";
import type { PgSession } from "../src/api/postgres/encode.ts";

/** Postgres's internal types, which no column is declared with */
const NOT_A_COLUMN = new Set(["unknown", "gtsvector", "pg_node_tree", "pg_ndistinct", "pg_dependencies", "pg_mcv_list", "pg_ddl_command", "pg_brin_bloom_summary", "pg_brin_minmax_multi_summary"]);

test("every type of Postgres's is decided: the copy holds it as itself or as its text, with its OIDs and typlen as pg_type says", async () => {
  const db = new PGlite();
  const types = (await db.query<{ typname: string; spelled: string; oid: number; typarray: number; typlen: number }>(
    `SELECT typname, format_type(oid, NULL) AS spelled, oid::int AS oid, typarray::int AS typarray, typlen::int AS typlen FROM pg_type
     WHERE typnamespace = 'pg_catalog'::regnamespace AND typtype IN ('b', 'r', 'm') AND typarray <> 0 AND typisdefined`)).rows;
  await db.close();
  assert.ok(types.length > 60, `pg_type's list came back short: ${types.length}`);
  const undecided = types.filter((t) => !NOT_A_COLUMN.has(t.typname) && !isNative(t.spelled) && HELD[t.typname] === undefined).map((t) => t.typname);
  assert.deepEqual(undecided, [], "a Postgres type neither NATIVE nor HELD: decide it in src/duck/held-types.ts, and add its column to the oracle's MAPPED");
  for (const t of types) {
    const h = HELD[t.typname];
    if (h === undefined) continue;
    assert.deepEqual({ oid: h.oid, array: h.array, size: h.size }, { oid: t.oid, array: t.typarray, size: t.typlen }, t.typname);
  }
  for (const name of Object.keys(HELD)) assert.ok(types.some((t) => t.typname === name), `HELD names ${name}, which pg_type has not`);
});

test("what the copy holds: a type nobody named is its text, an enum and the native types themselves", () => {
  for (const [spelled, kind, hold] of [
    ["time with time zone", "b", "same"], ["time(3) with time zone", "b", "same"], ["time with time zone[]", "b", "same"], ["interval year to month", "b", "same"], ["interval(3)", "b", "same"],
    ["numeric(12,2)", "b", "same"], ["character varying(5)[]", "b", "same"], ["oid", "b", "same"], ["mood", "e", "same"], ["mood[]", "e", "same"], ["citext", "b", "same"],
    ["point", "b", "text"], ["bit(8)", "b", "text"], ["bit varying", "b", "text"], ["money", "b", "text"], ["int4range", "r", "text"], ["pair", "c", "text"], ["vector(3)", "b", "text"], ["a_type_from_the_future", "b", "text"],
    ["point[]", "b", "text[]"], ["macaddr[]", "b", "text[]"], ["oid[]", "b", "text[]"], ["pair[]", "c", "text[]"],
  ] as const) assert.equal(holdOf(spelled, kind), hold, spelled);
});

test("a pg_lsn is written as the source writes it: Postgres 19 pads its low half to 8 hex digits, the catalog's 18 does not (issue 1198)", async () => {
  // the catalog Postgres's own form, held to the catalog
  const db = new PGlite();
  const catalog = (await db.query<{ t: string }>("SELECT '0/016B3748'::pg_lsn::text AS t")).rows[0]!.t;
  await db.close();
  assert.equal(catalog, CATALOG_LSN_PADDED ? "0/016B3748" : "0/16B3748");
  const v19 = sourceForms(190000), v18 = sourceForms(180006), unknown = sourceForms(null);
  assert.deepEqual([...v19.differs].sort(), [3220, 3221]);
  assert.deepEqual([v18.differs.size, unknown.differs.size], [0, 0]);
  for (const [catalogText, source19] of [["0/16B3748", "0/016B3748"], ["1/0", "1/00000000"], ["0/0", "0/00000000"], ["FFFFFFFF/FFFFFFFF", "FFFFFFFF/FFFFFFFF"],
    ["{0/1,NULL,1/ABC}", "{0/00000001,NULL,1/00000ABC}"]] as const) {
    assert.equal(v19.written(catalogText.startsWith("{") ? 3221 : 3220, catalogText), source19, catalogText);
    assert.equal(v18.written(3220, catalogText), catalogText);
  }
  // no other type's text is touched
  assert.equal(v19.written(829, "08:00:2b:01:02:03"), "08:00:2b:01:02:03");
  assert.equal(v19.written(25, "0/1"), "0/1");
  // a constant's bytes as the catalog holds them (little-endian): its text differs where its low half is short
  const lsn = (hi: number, lo: number): number[] => [lo, lo >>> 8, lo >>> 16, lo >>> 24, hi, hi >>> 8, hi >>> 16, hi >>> 24].map((x) => x & 255);
  assert.equal(v19.constDiffers(3220, lsn(0, 1)), true);
  assert.equal(v19.constDiffers(3220, lsn(0x16, 0xB374D848)), false);
  assert.equal(v19.constDiffers(3220, lsn(0, 0x10000000)), false);
  assert.equal(v19.constDiffers(3220, lsn(0, 0x0FFFFFFF)), true);
  assert.equal(v19.constDiffers(3220, null), true, "bytes it cannot read differ");
  assert.equal(v18.constDiffers(3220, lsn(0, 1)), false);
  // (an array's datum, as the catalog holds it, is held on the wire: tests/duck-source-forms.test.ts)
});

test("a time range is written again in the session's zone, by Postgres's own output", () => {
  const c = pgTypedColumn("c", [...ZONED_HELD.keys()][0]!, VARCHAR);
  const text = '["2026-01-01 00:00:00+00","2026-07-01 00:00:00+00")';
  assert.equal(c.encode(text, 0, { timeZone: "Asia/Kolkata" } as PgSession)!.toString(), '["2026-01-01 05:30:00+05:30","2026-07-01 05:30:00+05:30")');
  assert.equal(c.encode(text, 0, { timeZone: "UTC" } as PgSession)!.toString(), text);
});

test("the catalog declares a type the source made, under its own name, with nothing over it", async () => {
  const ddl = catalogDdl({ database: "d", tables: [{ name: "t", schema: "public", primaryKey: [], joins: [], columns: [
    { name: "a", type: "text", spelled: "pair", made: "row", typeOid: 20001 },
    { name: "b", type: "text", spelled: "vector(3)", made: true, typeOid: 20002 },
    { name: "c", type: "text", spelled: "other.tags[]", made: true, typeOid: 20003 },
    { name: "d", type: "text", spelled: "time with time zone" },
    { name: "e", type: "text", spelled: "point[]" },
  ] }] });
  const db = new PGlite();
  for (const s of ddl) await db.exec(s);
  const rows = (await db.query<{ column_name: string; data_type: string; udt_name: string }>("SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position")).rows;
  assert.deepEqual(rows.map((r) => [r.column_name, r.data_type, r.udt_name]), [
    ["a", "USER-DEFINED", "pair"], ["b", "USER-DEFINED", "vector"], ["c", "ARRAY", "_tags"], ["d", "time with time zone", "timetz"], ["e", "ARRAY", "_point"],
  ]);
  await db.exec("SELECT 'x'::pair::text");
  await assert.rejects(db.exec("SELECT 'x'::pair = 'x'::pair"), /operator does not exist/);
  await db.close();
});
