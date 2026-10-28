/**
 * JSONB'S ORDER AND EQUALITY (src/duck/jsonb-order.ts, the rewrite's `jsonbKey`): Postgres orders and equates jsonb by
 * `compareJsonbContainers`, not by its text — by type, then size, then member by member, numbers as numerics, strings
 * under the database's collation, a top-level scalar as a one-element array that sorts above `[]`. Offline, held to
 * PGlite (a real Postgres, under C): the key's byte order over every shape and quirk, and every way a statement sorts,
 * groups or compares a jsonb through the wire, over values Postgres finds equal and writes apart (`1.0`, `1.00`, `1`).
 * Under ICU and a libc locale the wiring (each string's ICU key, through DuckDB) is held here against the same strings
 * sorted as text; that the orders are Postgres's under them is the oracle's (tests/integration/duck-oracle.itest.ts).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import { jsonbText } from "../src/duck/jsonb.ts";
// (imported where it is used: this file loads, and its every test runs, where the module does not exist yet)
const keyModule = (): Promise<typeof import("../src/duck/jsonb-order.ts")> => import("../src/duck/jsonb-order.ts");
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { LibcOrder } from "../src/duck/libc-order.ts";

const KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-jsonb-order-"));
const truth = new PGlite();

/** every shape and quirk: each type at the top and inside, sizes, key orders, numbers equal at other scales, strings
 *  apart only in case or bytes, a key held twice, nested empty containers */
const VALUES = [
  "null", "true", "false", "0", "-0", "0.0", "1", "1.0", "1.00", "10", "9.5", "-1", "-10", "-9.5", "-0.5", "-0.50", "1e2", "100", "1E+2",
  "0.001", "1e-3", "123456789012345678901234567890.5", "-123456789012345678901234567890", "2.5e-30",
  '""', '"a"', '"A"', '"b"', '"B"', '"ab"', '"a b"', '"é"', '"e"', '"\\u00e9"', '"z"', '"\\n"', '"\\"q\\""', '"\\ud83d\\ude00"', '"日本"',
  "[]", "[null]", "[1]", "[1.0]", "[2]", "[1, 2]", "[2, 1]", "[[]]", "[{}]", '["a"]', "[1, [2]]", "[[1], 1]", "[true, false]", "[[], []]", "[[[]]]",
  "{}", '{"a": 1}', '{"a": 1.0}', '{"a": 2}', '{"b": 1}', '{"A": 1}', '{"a": null}', '{"a": []}', '{"a": {}}', '{"a": "1"}',
  '{"a": 1, "b": 2}', '{"b": 1, "aa": 1}', '{"a": 1, "bb": 1}', '{"aa": 1}', '{"a": {"b": [1, "x"]}}', '{"a": 1, "a": 2}', '{"é": 1}', '{"e": 1}',
];

before(async () => {
  await truth.exec(`CREATE TABLE v (id int, v jsonb); INSERT INTO v VALUES ${VALUES.map((v, i) => `(${i}, '${v.replace(/'/g, "''")}')`).join(", ")}`);
});
after(async () => { await truth.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("a jsonb's key orders and equates as Postgres's jsonb does, over every shape and quirk (PGlite's ORDER BY, under C)", async () => {
  const { jsonbKey, jsonbStrings, numberKey } = await keyModule();
  // Postgres's rank of each value (equal values share one), and the key's
  const pgRank = new Map((await truth.query<{ id: number; r: number }>("SELECT id, dense_rank() OVER (ORDER BY v) AS r FROM v")).rows.map((x) => [x.id, Number(x.r)]));
  const keys = VALUES.map((v) => jsonbKey(v, { kind: "bytes" }));
  const order = [...keys.keys()].sort((a, b) => Buffer.compare(keys[a]!, keys[b]!));
  let rank = 0;
  const keyRank = new Map<number, number>();
  order.forEach((id, i) => { if (i === 0 || Buffer.compare(keys[order[i - 1]!]!, keys[id]!) !== 0) rank++; keyRank.set(id, rank); });
  const mismatched = VALUES.map((v, id) => ({ v, pg: pgRank.get(id), key: keyRank.get(id) })).filter((x) => x.pg !== x.key);
  assert.deepEqual(mismatched, [], "each value's rank among the others: Postgres's and the key's");
  // and so the quirks, by name: a raw scalar between [] and [x]; every scalar below every object; 1.0 = 1.00 = 1
  const k = (v: string): Buffer => jsonbKey(v, { kind: "bytes" });
  assert.ok(Buffer.compare(k("[]"), k("null")) < 0 && Buffer.compare(k("null"), k("[null]")) < 0 && Buffer.compare(k("1"), k("[1, 2]")) < 0);
  assert.ok(Buffer.compare(k('"z"'), k("{}")) < 0 && Buffer.compare(k("[[]]"), k("{}")) < 0);
  assert.equal(Buffer.compare(k("1"), k("1.00")), 0);
  assert.equal(Buffer.compare(k('{"a": 1, "a": 2}'), k('{"a": 2.0}')), 0);
  // a number's key is its value's: the scale left out, nothing through a double, a long exponent read as written
  assert.deepEqual(numberKey("1e100000").slice(0, 6), [0x81, 0x80, 0x01, 0x86, 0xa1, "1".charCodeAt(0)]);
  assert.ok(Buffer.compare(Buffer.from(numberKey("0.1000000000000000055511")), Buffer.from(numberKey("0.1"))) > 0);
  // the strings ICU makes keys of, in the walk's order: an object's keys in storage order, each before its value
  assert.deepEqual(jsonbStrings('{"bb": "x", "a": ["y", {"c": "z"}], "a": "w"}'), ["a", "w", "bb", "x"]);
  assert.throws(() => jsonbKey('["a", "b"]', { kind: "icu", icuKeys: ["01"] }), /holds more strings than the 1 ICU keys handed in: a Mason bug/);
});

// ------------------------------------------------------------------------------------------------- through the wire

/** the rows each statement reads: values Postgres finds equal and writes apart, a NULL, every type */
const ROWS: Array<[number, string | null]> = [
  [1, '{"a": 1}'], [2, '{"a": 1.0}'], [3, '{"a": 1.00}'], [4, "1"], [5, "1.0"], [6, "[]"], [7, "null"], [8, null], [9, '"a"'], [10, '"B"'],
  [11, "[1, 2]"], [12, "[1]"], [13, '{"b": 1, "aa": 2}'], [14, '{"a": 1, "bb": 2}'], [15, "10"], [16, "9.5"], [17, "true"], [18, "{}"], [19, '{"a": [1, {"b": "x"}]}'], [20, "-0"], [21, "0"],
];
const DUCK_DDL = [
  "CREATE TABLE public.jo (id INTEGER PRIMARY KEY, j JSON, js JSON, ja JSON[])",
  // the copy holds Postgres's canonical text of a jsonb (jsonb_out: 1.0 stays 1.0) and a json's own text
  `INSERT INTO public.jo VALUES ${ROWS.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${jsonbText(v)}'`}, ${v === null ? "NULL" : `'${v}'`}, ${v === null ? "NULL" : `['${jsonbText(v)}']`})`).join(", ")}`,
];
const PG_DDL = `CREATE TABLE public.jo (id int PRIMARY KEY, j jsonb, js json, ja jsonb[]); INSERT INTO public.jo VALUES ${ROWS.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${v}'`}, ${v === null ? "NULL" : `'${v}'`}, ${v === null ? "NULL" : `ARRAY['${v}'::jsonb]`})`).join(", ")}`;
const SCHEMA: PgSchema = { database: "app", tables: [{ name: "jo", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "j", type: "jsonb" }, { name: "js", type: "jsonb", spelled: "json" }, { name: "ja", type: "jsonb", spelled: "jsonb[]" }] }] };

/** a listener over its own copy of `jo` under a collation (`undefined`: C), and a client of it */
async function served(name: string, collation?: { provider: string; collate: string; locale: string | null }, libc?: LibcOrder): Promise<{ rows(sql: string): Promise<unknown[][]>; refusal(sql: string): Promise<pg.DatabaseError>; close(): Promise<void> }> {
  const store = await DuckStore.open(path.join(dir, `${name}.db`), () => undefined);
  for (const s of DUCK_DDL) await store.writer.run(s);
  // (the allowlist off: what this file holds is the rewrite; what the oracle verified is src/duck/verified.ts's)
  const api: PgApiServer = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => SCHEMA, record: () => undefined, log: () => undefined,
    duck: await store.listener(collation, null, libc),
  });
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, user: "me", password: mintToken(KEY, 600).token, database: "app" });
  await c.connect();
  return {
    rows: async (sql) => (await c.query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows as unknown[][],
    refusal: async (sql) => { try { await c.query(sql); } catch (e) { return e as pg.DatabaseError; } throw new Error(`answered: ${sql}`); },
    close: async () => { await c.end(); await api.close(); await store.close(); },
  };
}

/** Postgres's (PGlite's) rows, as text */
async function postgres(sql: string): Promise<unknown[][]> {
  return (await truth.query<unknown[]>(sql, [], { rowMode: "array", parsers: Object.fromEntries([16, 20, 23, 25, 114, 1007, 1700, 3802].map((o) => [o, (v: string) => v])) })).rows;
}

test("every way a statement sorts, groups or compares a jsonb is answered as Postgres answers it (equal values written apart included)", async () => {
  await truth.exec(PG_DDL);
  const s = await served("bytes");
  try {
    const alike = [
      // the BI tool's click on a column (Trevor.io): its NULLs first or last, then the values
      `SELECT "e"."id" FROM "public"."jo" AS "e" ORDER BY ("e"."j") IS NULL ASC, "e"."j" DESC, "e"."id" LIMIT 100`,
      "SELECT id, j FROM jo ORDER BY j, id", "SELECT id FROM jo ORDER BY j DESC NULLS LAST, id", "SELECT id FROM jo ORDER BY 1 - id, j NULLS FIRST",
      "SELECT id, row_number() OVER (ORDER BY j, id), rank() OVER (ORDER BY j) FROM jo ORDER BY id",
      "SELECT string_agg(id::text, ',' ORDER BY j, id), jsonb_agg(j ORDER BY j DESC, id) FROM jo",
      // the order key of an expression, a subquery's column, an output name
      "SELECT id FROM jo ORDER BY j -> 'a', id", "SELECT x FROM (SELECT id AS x, j AS y FROM jo) s ORDER BY y, x", "SELECT id, j AS v FROM jo ORDER BY v, id",
      // comparisons: equality by value, the type order, a raw scalar against [] and [x]
      "SELECT id FROM jo WHERE j = '{\"a\": 1}' ORDER BY id", "SELECT id FROM jo WHERE j = '1.000' ORDER BY id", "SELECT id FROM jo WHERE j <> '1' ORDER BY id",
      "SELECT id FROM jo WHERE j < '[]' ORDER BY id", "SELECT id FROM jo WHERE j > '[1]' ORDER BY id", "SELECT id FROM jo WHERE j <= '\"a\"' ORDER BY id", "SELECT id FROM jo WHERE j >= '{}' ORDER BY id",
      "SELECT a.id, b.id FROM jo a JOIN jo b ON a.j = b.j AND a.id < b.id ORDER BY 1, 2",
      "SELECT a.id, count(*) FILTER (WHERE a.j < b.j), count(*) FILTER (WHERE a.j = b.j) FROM jo a, jo b GROUP BY a.id ORDER BY 1",
      "SELECT id FROM jo WHERE j IN ('1', '[]', '{\"a\": 1.0}') ORDER BY id", "SELECT id FROM jo WHERE j NOT IN ('1', '[]') ORDER BY id",
      "SELECT id FROM jo WHERE j BETWEEN '1' AND '10' ORDER BY id", "SELECT id FROM jo WHERE j NOT BETWEEN '[]' AND '{}' ORDER BY id",
      "SELECT id FROM jo WHERE j = ANY (ARRAY['1'::jsonb, '\"a\"']) ORDER BY id", "SELECT id FROM jo WHERE j <> ALL (ARRAY['1'::jsonb, '{}']) ORDER BY id",
      "SELECT id, j IS DISTINCT FROM '1', j IS NOT DISTINCT FROM '{\"a\": 1}' FROM jo ORDER BY id",
      "SELECT id, nullif(j, '1'), CASE j WHEN '1' THEN 'one' WHEN '{}' THEN 'empty' ELSE 'other' END FROM jo ORDER BY id",
      // groups, counted by Postgres's equality (the group's VALUE below)
      "SELECT count(*), min(id) FROM jo GROUP BY j ORDER BY 2", "SELECT count(*), min(id) FROM jo GROUP BY j -> 'a' ORDER BY 2", "SELECT count(DISTINCT j), count(DISTINCT j -> 'a') FROM jo",
      "SELECT count(*) FROM (SELECT DISTINCT j FROM jo) s", "SELECT count(*) FROM (SELECT DISTINCT ON (j) id FROM jo ORDER BY j, id) s", "SELECT DISTINCT ON (j) id FROM jo ORDER BY j, id",
      "SELECT id, count(*) OVER (PARTITION BY j) FROM jo ORDER BY id", "SELECT min(id) FROM jo GROUP BY j HAVING j = '1' OR count(*) > 2 ORDER BY 1",
      // json has no order and no equality: Postgres's own refusal
    ];
    for (const sql of alike) assert.deepEqual(await s.rows(sql), await postgres(sql), sql);
    // A GROUP'S VALUE: one of the texts its rows hold, as Postgres's is the one its plan meets first (Mason gap jsonb-equal-text)
    const texts = new Map(ROWS.map(([id, v]) => [id, v === null ? null : jsonbText(v)]));
    for (const sql of ["SELECT j, array_agg(id ORDER BY id) FROM jo GROUP BY j", "SELECT j, array_agg(id ORDER BY id) FROM jo GROUP BY 1", "SELECT DISTINCT j, (SELECT array_agg(b.id ORDER BY b.id) FROM jo b WHERE b.j = jo.j) FROM jo"]) {
      const got = await s.rows(sql), want = await postgres(sql);
      assert.equal(got.length, want.length, sql);
      for (const [v, ids] of got) {
        const members = ids === null ? [] : String(ids).replace(/[{}]/g, "").split(",").filter((x) => x !== "").map(Number);
        assert.ok(members.length === 0 ? v === null : members.some((m) => texts.get(m) === v), `${sql}: ${String(v)} is the text of one of its group's rows ${String(ids)}`);
      }
      assert.deepEqual(got.map((r) => r[1]).sort(), want.map((r) => r[1]).sort(), sql);
    }
    // A GROUPED VIEW, AS A BI TOOL SENDS IT: the GROUP BY is the key (keyedGroups), and the ORDER BY over the output
    // name — or its expression, or its ordinal, or the nulls idiom unfolded — is keyed again and must bind to that
    // group. The rows in Postgres's order, each group's value one of its texts (jsonb-equal-text): equal as jsonb to
    // Postgres's, row by row
    const grouped = [
      "SELECT j, count(*) FROM jo GROUP BY j ORDER BY j DESC, 2",
      `SELECT "e"."j" AS "e.j", count(*) AS "count" FROM "public"."jo" AS "e" GROUP BY 1 ORDER BY "e.j" DESC, "count" DESC LIMIT 100 OFFSET 0`,
      `SELECT "e"."j" AS "e.j", count(*) AS "count" FROM "public"."jo" AS "e" GROUP BY 1 ORDER BY ("e"."j") IS NULL ASC, "e"."j" DESC LIMIT 100 OFFSET 0`,
      `SELECT "e"."j" AS "e.j", count(*) AS "count" FROM "public"."jo" AS "e" GROUP BY "e"."j" ORDER BY ("e"."j") IS NULL ASC, "e"."j" DESC, "count" DESC LIMIT 100 OFFSET 0`,
      "SELECT j, count(*) FROM jo GROUP BY j ORDER BY 1", "SELECT j, count(*) FROM jo GROUP BY 1 ORDER BY 1 DESC NULLS LAST",
      `SELECT "e"."j" AS "e.j", count(*) AS "count" FROM "public"."jo" AS "e" GROUP BY "e.j" HAVING "e"."j" IS NOT NULL AND count(*) >= 1 ORDER BY "e.j" DESC`,
      "SELECT j AS v, count(*) AS n FROM jo GROUP BY v HAVING j <> '1' ORDER BY v, n",
    ];
    for (const sql of grouped) {
      const got = await s.rows(sql), want = await postgres(sql);
      assert.equal(got.length, want.length, sql);
      assert.deepEqual(got.map((r) => r.slice(1)), want.map((r) => r.slice(1)), `${sql}: the counts, in Postgres's order`);
      const pairs = got.map((r, i) => [r[0], want[i]![0]] as const);
      const unequal = (await truth.query<{ i: number }>("SELECT i FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS u(a, b, i) WHERE a::jsonb IS DISTINCT FROM b::jsonb",
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])])).rows;
      assert.deepEqual(unequal, [], `${sql}: each group's value equal to Postgres's, in its order`);
    }
    // an output name in HAVING is no column to Postgres (42703): refused as Postgres refuses it
    const aliased = "SELECT j AS v, count(*) FROM jo GROUP BY v HAVING v <> '1'";
    const pgError = await truth.query(aliased).then(() => null, (e: { code: string; message: string }) => e);
    assert.ok(pgError !== null, aliased);
    const ours = await s.refusal(aliased);
    assert.deepEqual([ours.code, ours.message], [pgError.code, pgError.message], aliased);
    // WHAT STAYS REFUSED, by name (gap jsonb-compare), each with its way out
    for (const sql of [
      "SELECT greatest(j, '1') FROM jo", "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY j) FROM jo", "SELECT id FROM jo WHERE j IN (SELECT j FROM jo WHERE id < 3)",
      "SELECT a.id FROM jo a JOIN jo b USING (j)", "SELECT j FROM jo UNION SELECT j FROM jo", "SELECT j FROM jo INTERSECT ALL SELECT j FROM jo", "SELECT DISTINCT * FROM (SELECT id, j FROM jo) s", "SELECT DISTINCT s.* FROM (SELECT j FROM jo) s",
      "SELECT j, count(*) FROM jo GROUP BY ROLLUP (j)", "SELECT array_agg(DISTINCT j) FROM jo", "SELECT id FROM jo ORDER BY ja", "SELECT id FROM jo WHERE ja = ARRAY['1'::jsonb]",
      "SELECT id FROM jo WHERE j = ANY (ja)", "SELECT id FROM jo WHERE j BETWEEN SYMMETRIC '10' AND '1'",
    ]) {
      const e = await s.refusal(sql);
      assert.equal(e.code, "0A000", sql);
      assert.match(`${e.message} ${e.detail ?? ""}`, /Mason gap jsonb-compare/, sql);
    }
    // a json has no order and no equality operator: Postgres's own refusal, word for word
    for (const sql of ["SELECT id FROM jo ORDER BY js", "SELECT js, count(*) FROM jo GROUP BY js", "SELECT DISTINCT js FROM jo", "SELECT id FROM jo WHERE js = js"]) {
      const want = await truth.query(sql).then(() => null, (e: { code: string; message: string }) => e);
      const e = await s.refusal(sql);
      assert.ok(want !== null, sql);
      assert.deepEqual([e.code, e.message], [want.code, want.message], sql);
    }
  } finally { await s.close(); }
});

test("under ICU and a libc locale a jsonb's strings sort by the collation's key of each, as the same strings sort as text", async () => {
  // the empty string (ICU's key of it is empty), and under ICU a string of characters ICU ignores (a zero-width space:
  // its key holds no primary weight); the hand-made libc order covers no U+200B, held apart below
  const zwsp = String.fromCodePoint(0x200b);
  const base = ["b", "B", "a", "A", "é", "e", "ab", "a b", "zebra", "Zürich", "$x", "@x", "10", "9", ""];
  for (const [name, collation, libc] of [
    ["icu", { provider: "i", collate: "en-US", locale: "en-US" }, undefined],
    ["libc", { provider: "c", collate: "en_US.utf8", locale: null }, smallLibcOrder()],
  ] as const) {
    const strings = name === "icu" ? [...base, zwsp, `a${zwsp}`] : base;
    const s = await served(name, collation, libc);
    try {
      const lits = strings.map((x) => `('${x}')`).join(", ");
      // an empty key, an empty member, an empty string at the top: answered, never "a Mason bug"
      const empties = ['{"": 1}', '[""]', '""', '{"": ""}', '["", "a"]'].map((x) => `('${x}')`).join(", ");
      assert.equal((await s.rows(`SELECT t FROM jo, (VALUES ${empties}) v(t) WHERE jo.id = 1 ORDER BY t::jsonb`)).length, 5, `${name}: empty strings`);
      // many strings in one document: the list of ICU keys has no size cliff (999 equal members, then the string)
      const many = (x: string): string => `'[${'"x", '.repeat(999)}"${x}"]'`;
      const asMany = (await s.rows(`SELECT t FROM jo, (VALUES ${strings.map((x) => `('${x}', ${many(x)})`).join(", ")}) v(t, d) WHERE jo.id = 1 ORDER BY d::jsonb, t`)).map((r) => r[0]);
      // the strings as text in the collation's order, and as jsonb scalars, inside arrays, as an object's keys
      const asText = (await s.rows(`SELECT t FROM jo, (VALUES ${lits}) v(t) WHERE jo.id = 1 ORDER BY t, t COLLATE "C"`)).map((r) => r[0]);
      const asJsonb = (await s.rows(`SELECT t FROM jo, (VALUES ${lits}) v(t) WHERE jo.id = 1 ORDER BY to_jsonb(t), t`)).map((r) => r[0]);
      const inArrays = (await s.rows(`SELECT t FROM jo, (VALUES ${lits}) v(t) WHERE jo.id = 1 ORDER BY jsonb_build_array(1, t), t`)).map((r) => r[0]);
      const asKeys = (await s.rows(`SELECT t FROM jo, (VALUES ${lits}) v(t) WHERE jo.id = 1 ORDER BY jsonb_build_object(t, 1), t`)).map((r) => r[0]);
      assert.deepEqual(asJsonb, asText, `${name}: jsonb strings`);
      assert.deepEqual(inArrays, asText, `${name}: inside an array`);
      assert.deepEqual(asKeys, asText, `${name}: as an object's keys (one each: compared by the collation, in storage order)`);
      assert.deepEqual(asMany, asText, `${name}: the 1,000th string of a 1,000-string array`);
      // the rest of jsonb's order is none of the collation's business: the types, the sizes, the numbers
      const stringless = "SELECT id FROM jo WHERE j IS NOT NULL AND NOT j::text ~ '\"' ORDER BY j, id";
      assert.deepEqual(await s.rows(stringless), await postgres(stringless), `${name}: values holding no string`);
      if (name === "libc") {
        // a string the libc order does not cover refuses inside a jsonb as it does as text: by name, never a guess
        const e = await s.refusal(`SELECT t FROM jo, (VALUES ('"a"'), ('{"k": ["x${String.fromCodePoint(0x0E40)}"]}')) v(t) WHERE jo.id = 1 ORDER BY t::jsonb`);
        assert.equal(e.code, "0A000");
        assert.match(e.message, /U\+0E40.*Mason gap libc-uncovered/);
        // a character the order does not cover (U+200B here) refuses as a jsonb's string exactly as it does as text
        const asTextZ = await s.refusal(`SELECT t FROM jo, (VALUES ('a'), ('${zwsp}')) v(t) WHERE jo.id = 1 ORDER BY t`);
        const asJsonbZ = await s.refusal(`SELECT t FROM jo, (VALUES ('a'), ('${zwsp}')) v(t) WHERE jo.id = 1 ORDER BY to_jsonb(t)`);
        assert.deepEqual([asJsonbZ.code, asJsonbZ.message], [asTextZ.code, asTextZ.message]);
      }
    } finally { await s.close(); }
  }
});

/** a libc order small enough to write by hand, as tests/duck-libc-order.test.ts writes one: letters with case and accents
 *  at ICU's levels, `$` with a first-level weight below the letters, `@`, `-` and the space with none */
function smallLibcOrder(): LibcOrder {
  const MAX = 0x110000;
  const l1 = new Uint32Array(MAX), l4 = new Uint32Array(MAX), uncovered = new Uint8Array(MAX).fill(1);
  const cp = (c: string): number => c.codePointAt(0)!;
  const letters = "abcdefghijklmnopqrstuvwxyz".split("").map((x) => x + x.toUpperCase() + (x === "e" ? "é" : x === "u" ? "ü" : ""));
  const first = ["$", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...letters];
  const ignored = [" ", "-", "@"];
  ignored.forEach((cls, i) => { for (const c of cls) { l4[cp(c)] = 2 * (i + 1); uncovered[cp(c)] = 0; } });
  first.forEach((cls, i) => { for (const c of cls) { l1[cp(c)] = i + 1; uncovered[cp(c)] = 0; l4[cp(c)] = 2 * ignored.length + 1; } });
  return { collate: "en_US.utf8", version: "2.41", l1, l4, uncovered, expansions: new Map() };
}
