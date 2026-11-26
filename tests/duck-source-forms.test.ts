/**
 * A SOURCE WHOSE TEXT FORM FOR A TYPE DIFFERS FROM THE CATALOG POSTGRES'S (issue 1198; src/duck/held-types.ts
 * `SourceForms`). Postgres 19 writes a pg_lsn's low half as 8 hex digits (`0/016B3748`), where 18, and the catalog
 * Postgres (PGlite 18), write `0/16B3748`. The copy holds the source's text, so on a 19 source a literal or a parameter
 * written in the catalog's form found no row for `=` and every row for `<>`, and a literal printed in 18's form.
 *
 * CI's Postgres is 18, so a 19 source is simulated: a store holds the rows as Postgres 19 writes them, and its listener
 * is told the source's version (190000). Each expected answer is what a real Postgres 19.0 answered for the same rows.
 * The same statements over a store of 18's text, told 180000, are held to PGlite (an 18): main's answers, kept.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-source-forms-"));
const truth = new PGlite();

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "l", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "lsn", type: "text", spelled: "pg_lsn" }, { name: "la", type: "text", spelled: "pg_lsn[]" }] },
    { name: "m", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "lsn", type: "text", spelled: "pg_lsn" }] },
  ],
};
/** the rows, as Postgres 18 writes them (and PGlite, the truth) */
const L18: Array<[number, string | null, string[] | null]> = [[1, "0/16B3748", ["0/16B3748", "1/0"]], [2, "1/0", ["1/0"]], [3, null, null], [4, "0/16B3748", []],
  [5, "FFFFFFFF/FFFFFFFF", ["0/0"]], [6, "0/0", null]];
const M18: Array<[number, string]> = [[10, "0/16B3748"], [11, "0/0"], [12, "2/ABC"]];
/** a pg_lsn as Postgres 19 writes it */
const as19 = (v: string): string => v.replace(/^([0-9A-F]+)\/([0-9A-F]+)$/, (_, hi: string, lo: string) => `${hi}/${lo.padStart(8, "0")}`);

interface Served { store: DuckStore; api: PgApiServer }
let s18: Served, s19: Served, s19v: Served;

async function serve(name: string, write: (v: string) => string, sourceVersion: number, verified?: null): Promise<Served> {
  const store = await DuckStore.open(path.join(dir, `${name}.db`), () => undefined);
  const q = (v: string | null): string => v === null ? "NULL" : `'${write(v)}'`;
  await store.writer.run("CREATE TABLE public.l (id INTEGER, lsn VARCHAR, la VARCHAR[]); CREATE TABLE public.m (id INTEGER, lsn VARCHAR)");
  await store.writer.run(`INSERT INTO public.l VALUES ${L18.map(([id, v, a]) => `(${id}, ${q(v)}, ${a === null ? "NULL" : `[${a.map(q).join(", ")}]::VARCHAR[]`})`).join(", ")}`);
  await store.writer.run(`INSERT INTO public.m VALUES ${M18.map(([id, v]) => `(${id}, ${q(v)})`).join(", ")}`);
  const api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const problem = tokenProblem(API_KEY, password); if (problem !== null) throw new Error(problem); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined,
    // (null: the allowlist off, as the oracle runs: what is answered is the rewrite's, an IN list of pg_lsn included;
    // undefined: on, as mason start runs)
    duck: await store.listener(undefined, verified, undefined, () => [], undefined, { sourceVersion }),
  });
  return { store, api };
}

before(async () => {
  s18 = await serve("pg18", (v) => v, 180006, null);
  s19 = await serve("pg19", as19, 190000, null);
  s19v = await serve("pg19v", as19, 190000);
  await truth.exec("CREATE TABLE l (id int PRIMARY KEY, lsn pg_lsn, la pg_lsn[]); CREATE TABLE m (id int PRIMARY KEY, lsn pg_lsn)");
  const q = (v: string | null): string => v === null ? "NULL" : `'${v}'`;
  await truth.exec(`INSERT INTO l VALUES ${L18.map(([id, v, a]) => `(${id}, ${q(v)}, ${a === null ? "NULL" : `'{${a.join(",")}}'`})`).join(", ")}`);
  await truth.exec(`INSERT INTO m VALUES ${M18.map(([id, v]) => `(${id}, ${q(v)})`).join(", ")}`);
});
after(async () => {
  for (const s of [s18, s19, s19v]) { await s?.api.close(); await s?.store.close(); }
  await truth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = { getTypeParser: () => (v: string) => v };
type Answer = { fields: Array<[string, number]>; rows: Array<Array<string | null>> } | string;

async function ask(s: Served, sql: string, values?: unknown[]): Promise<Answer> {
  const c = new pg.Client({ host: "127.0.0.1", port: s.api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  try {
    return await c.query({ text: sql, rowMode: "array", types: raw, ...(values === undefined ? {} : { values }) } as pg.QueryConfig)
      .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID] as [string, number]), rows: r.rows.map((x: unknown[]) => x.map((v) => v === null ? null : String(v))) }),
        (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
  } finally { await c.end(); }
}
async function known(sql: string, values?: unknown[]): Promise<Answer> {
  return truth.query<unknown[]>(sql, values ?? [], { rowMode: "array", parsers: Object.fromEntries([16, 20, 21, 23, 25, 114, 1009, 1700, 3220, 3221, 3802].map((o) => [o, (v: string) => v])) })
    .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID] as [string, number]), rows: r.rows.map((x) => x.map((v) => v === null ? null : String(v))) }),
      (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
}
const ids = (...n: number[]): Answer => ({ fields: [["id", 23]], rows: n.map((i) => [String(i)]) });

/** an answer Mason refuses by name on a 19 source, where Postgres 19 answers */
const REFUSED = "refused: source-text-form";
/** each statement, its parameters, and Postgres 19.0's answer over the same rows */
const CASES: Array<[string, unknown[] | undefined, Answer]> = [
  ["SELECT id, lsn FROM l ORDER BY id", undefined, { fields: [["id", 23], ["lsn", 3220]], rows: [["1", "0/016B3748"], ["2", "1/00000000"], ["3", null], ["4", "0/016B3748"], ["5", "FFFFFFFF/FFFFFFFF"], ["6", "0/00000000"]] }],
  ["SELECT id FROM l WHERE lsn = '0/16B3748' ORDER BY id", undefined, ids(1, 4)],
  ["SELECT id FROM l WHERE lsn = '0/016B3748' ORDER BY id", undefined, ids(1, 4)],
  ["SELECT id FROM l WHERE lsn = 'ffffffff/ffffffff' ORDER BY id", undefined, ids(5)],
  ["SELECT id FROM l WHERE lsn <> '0/16B3748' ORDER BY id", undefined, ids(2, 5, 6)],
  ["SELECT id FROM l WHERE lsn IN ('0/16B3748', '1/0') ORDER BY id", undefined, ids(1, 2, 4)],
  ["SELECT id FROM l WHERE lsn IN ('0/016B3748', '1/00000000') ORDER BY id", undefined, ids(1, 2, 4)],
  ["SELECT id FROM l WHERE lsn NOT IN ('0/16B3748', '0/0') ORDER BY id", undefined, ids(2, 5)],
  ["SELECT id FROM l WHERE lsn = ANY (ARRAY['0/16B3748'::pg_lsn, '0/00000000']) ORDER BY id", undefined, ids(1, 4, 6)],
  ["SELECT id FROM l WHERE lsn = CAST('0/016B3748' AS pg_lsn) ORDER BY id", undefined, ids(1, 4)],
  ["SELECT id FROM l WHERE lsn = pg_lsn '1/0' ORDER BY id", undefined, ids(2)],
  ["SELECT id FROM l WHERE lsn IS DISTINCT FROM '0/16B3748' ORDER BY id", undefined, ids(2, 3, 5, 6)],
  ["SELECT id, CASE lsn WHEN '0/16B3748' THEN 'a' WHEN '1/0' THEN 'b' ELSE 'c' END AS k FROM l ORDER BY id", undefined,
    { fields: [["id", 23], ["k", 25]], rows: [["1", "a"], ["2", "b"], ["3", "c"], ["4", "a"], ["5", "c"], ["6", "c"]] }],
  ["SELECT id, coalesce(lsn, '0/1') AS c FROM l WHERE id IN (1, 3) ORDER BY id", undefined, { fields: [["id", 23], ["c", 3220]], rows: [["1", "0/016B3748"], ["3", "0/00000001"]] }],
  // a parameter, bare and cast, in both spellings
  ["SELECT id FROM l WHERE lsn = $1 ORDER BY id", ["0/16B3748"], ids(1, 4)],
  ["SELECT id FROM l WHERE lsn = $1::pg_lsn ORDER BY id", ["0/016B3748"], ids(1, 4)],
  ["SELECT id FROM l WHERE lsn <> $1 ORDER BY id", ["1/0"], ids(1, 4, 5, 6)],
  ["SELECT id FROM l WHERE lsn IN ($1, $2) ORDER BY id", ["0/0", "1/0"], ids(2, 6)],
  // a join, DISTINCT and GROUP BY
  ["SELECT l.id, m.id AS mid FROM l JOIN m ON l.lsn = m.lsn ORDER BY 1, 2", undefined, { fields: [["id", 23], ["mid", 23]], rows: [["1", "10"], ["4", "10"], ["6", "11"]] }],
  ["SELECT x FROM (VALUES ('0/16B3748'::pg_lsn)) v(x) JOIN l ON l.lsn = v.x", undefined, { fields: [["x", 3220]], rows: [["0/016B3748"], ["0/016B3748"]] }],
  ["SELECT DISTINCT lsn::text AS t FROM l ORDER BY 1", undefined, { fields: [["t", 25]], rows: [["0/00000000"], ["0/016B3748"], ["1/00000000"], ["FFFFFFFF/FFFFFFFF"], [null]] }],
  ["SELECT lsn::text AS t, count(*) FROM l GROUP BY lsn ORDER BY 1", undefined, { fields: [["t", 25], ["count", 20]], rows: [["0/00000000", "1"], ["0/016B3748", "2"], ["1/00000000", "1"], ["FFFFFFFF/FFFFFFFF", "1"], [null, "1"]] }],
  ["SELECT id FROM l WHERE lsn::text = '0/16B3748' ORDER BY id", undefined, ids()],
  // a literal in a list, a VALUES and a set operation's arm: the source's text
  ["SELECT id, '0/16B3748'::pg_lsn AS k FROM l WHERE id < 3 ORDER BY id", undefined, { fields: [["id", 23], ["k", 3220]], rows: [["1", "0/016B3748"], ["2", "0/016B3748"]] }],
  ["SELECT id, lsn FROM l WHERE id = 1 UNION ALL SELECT 0, '0/16B3748'::pg_lsn ORDER BY 1", undefined, { fields: [["id", 23], ["lsn", 3220]], rows: [["0", "0/016B3748"], ["1", "0/016B3748"]] }],
  ["SELECT lsn FROM l INTERSECT SELECT '0/16B3748'::pg_lsn", undefined, { fields: [["lsn", 3220]], rows: [["0/016B3748"]] }],
  ["SELECT lsn::text AS t FROM l EXCEPT SELECT '0/16B3748'::pg_lsn::text ORDER BY 1", undefined, { fields: [["t", 25]], rows: [["0/00000000"], ["1/00000000"], ["FFFFFFFF/FFFFFFFF"], [null]] }],
  ["SELECT id, ARRAY['0/16B3748'::pg_lsn]::text AS a FROM l WHERE id = 1", undefined, { fields: [["id", 23], ["a", 25]], rows: [["1", "{0/016B3748}"]] }],
  // a statement of no table is the catalog's (Postgres 18): one that would print a short pg_lsn in 18's form is
  // refused by name (Mason gap source-text-form), and the rest are answered as Postgres 19 does
  ["SELECT '0/16B3748'::pg_lsn", undefined, REFUSED],
  ["VALUES ('0/16B3748'::pg_lsn), ('1/0')", undefined, REFUSED],
  ["SELECT '0/016B3748'::pg_lsn AS a, '1/0'::pg_lsn::text AS b", undefined, REFUSED],
  ["SELECT '{0/1,1/0}'::pg_lsn[] AS a", undefined, REFUSED],
  ["SELECT '0/1'::pg_lsn UNION SELECT '0/00000001'::pg_lsn", undefined, REFUSED],
  ["SELECT x FROM (VALUES ('0/1'::pg_lsn), ('16/B374D848')) v(x) WHERE x > '0/0'", undefined, REFUSED],
  ["SELECT min(x) FROM (VALUES ('0/1'::pg_lsn), ('16/B374D848')) v(x)", undefined, REFUSED],
  ["SELECT greatest('0/1'::pg_lsn, '0/2') AS g", undefined, REFUSED],
  ["SELECT to_json('0/1'::pg_lsn) AS j", undefined, REFUSED],
  ["SELECT CASE WHEN true THEN '0/1'::pg_lsn END AS c", undefined, REFUSED],
  ["SELECT pg_lsn '0/2' - pg_lsn '0/1' AS d, pg_lsn '0/2' > pg_lsn '0/01' AS g", undefined, { fields: [["d", 1700], ["g", 16]], rows: [["1", "t"]] }],
  ["SELECT '0/1'::pg_lsn = '0/00000001' AS e, '0/1'::pg_lsn IN ('0/01', '0/2') AS i", undefined, { fields: [["e", 16], ["i", 16]], rows: [["t", "t"]] }],
  ["SELECT x > '0/0' AS b FROM (VALUES ('0/1'::pg_lsn)) v(x)", undefined, { fields: [["b", 16]], rows: [["t"]] }],
  ["SELECT '0/1'::pg_lsn + 268435455 AS l", undefined, { fields: [["l", 3220]], rows: [["0/10000000"]] }],
  ["SELECT pg_typeof('0/1'::pg_lsn) AS t, pg_column_size('0/1'::pg_lsn) AS n", undefined, { fields: [["t", 2206], ["n", 23]], rows: [["pg_lsn", "8"]] }],
  ["SELECT CASE '0/1'::pg_lsn WHEN '0/01' THEN 'a' END AS c", undefined, { fields: [["c", 25]], rows: [["a"]] }],
  ["SELECT CASE x WHEN '0/01' THEN 'a' END AS c FROM (VALUES ('0/1'::pg_lsn)) v(x)", undefined, { fields: [["c", 25]], rows: [["a"]] }],
  ["SELECT '16/B374D848'::pg_lsn AS l, '{16/B374D848,NULL}'::pg_lsn[] AS a", undefined, { fields: [["l", 3220], ["a", 3221]], rows: [["16/B374D848", "{16/B374D848,NULL}"]] }],
];

/** a refusal by name: `source-text-form` */
const isRefusal = (got: Answer): boolean => typeof got === "string" && got.startsWith("0A000: a pg_lsn whose part after the slash has fewer than 8 hex digits");

test("on a Postgres 19 source, a pg_lsn literal and parameter compare and print as the source writes them (issue 1198)", async () => {
  const differ: string[] = [];
  for (const [sql, values, want] of CASES) {
    const got = await ask(s19, sql, values);
    if (want === REFUSED ? !isRefusal(got) : !util.isDeepStrictEqual(got, want)) differ.push(`${sql}\n    mason:      ${JSON.stringify(got)}\n    postgres 19: ${JSON.stringify(want)}`);
  }
  assert.deepEqual(differ, []);
});

test("on a Postgres 18 source, the same statements answer as Postgres 18 does, as before (issue 1198)", async () => {
  const differ: string[] = [];
  for (const [sql, values] of CASES) {
    const [got, want] = [await ask(s18, sql, values), await known(sql, values)];
    if (!util.isDeepStrictEqual(got, want)) differ.push(`${sql}\n    mason:      ${JSON.stringify(got)}\n    postgres 18: ${JSON.stringify(want)}`);
  }
  assert.deepEqual(differ, []);
});

/**
 * A STATEMENT OF NO TABLE THAT NAMES A PG_LSN BESIDE ANYTHING ELSE (the reviews of PR 1201): the synced data passes
 * some constructs through untranslated (an inet, a jsonb, a numeric's type, a bpchar, `pg_catalog.length`,
 * `FROM (SELECT)`), answers some wrongly with no error (greatest of two pg_lsn by their text, `substr('abcdef', -1, 3)`,
 * a reversed combining mark, a two-dimensional array), and refuses what the catalog answers (a value of the server or
 * the session, an operator it has not verified). So every statement of no table is the catalog's, as on main. Its
 * pg_lsn's low half has 8 digits here, which Postgres 18 and 19 write alike: so each answer, on a 19 source, is held
 * to PGlite's, with the allowlist on and off.
 */
const BESIDE: Array<[string, unknown[] | undefined]> = [
  // the second review's seven, each answered wrongly by the synced data with no error
  ["SELECT greatest('A/B374D848'::pg_lsn, '10/B374D848'::pg_lsn) AS g", undefined],
  ["SELECT least('A/B374D848'::pg_lsn, '10/B374D848'::pg_lsn) AS g", undefined],
  ["SELECT x FROM (VALUES ('A/B374D848'::pg_lsn), ('10/B374D848')) v(x) WHERE (x, 1) > ('B/B374D848'::pg_lsn, 0)", undefined],
  ["SELECT upper('abc') AS u, greatest('A/B374D848'::pg_lsn, '10/B374D848'::pg_lsn)::text AS g", undefined],
  ["SELECT substr('abcdef', -1, 3) AS r, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT reverse('e' || chr(769) || 'x') AS q, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT ARRAY[['a','b'],['c','d']] AS a, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT CASE WHEN 'A/B374D848'::pg_lsn > '10/B374D848'::pg_lsn THEN 'a' ELSE 'b' END AS c, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT '10/B374D848'::pg_lsn BETWEEN 'A/B374D848' AND 'FF/B374D848' AS b, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT 'A/B374D848'::pg_lsn < '10/B374D848'::pg_lsn AS b, '16/B374D848'::pg_lsn AS l", undefined],
  // a parameter has no value before its Bind: the catalog answers it, as on main (a short one in 18's form)
  ["SELECT $1::pg_lsn AS p, '16/B374D848'::pg_lsn AS l", ["0/1"]],
  // the first review's
  ["SELECT '10.0.0.1'::inet AS i, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT '2001:db8::1'::inet AS i, '16/B374D848'::pg_lsn AS l", undefined],
  [`SELECT '{"b":1,"a":2}'::jsonb AS j, '16/B374D848'::pg_lsn AS l`, undefined],
  ["SELECT 'NaN'::numeric AS n, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT char 'abc' AS c, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT n'abc' AS c, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT unknown 'abc' AS c, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT 'abc'::unknown AS c, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT 'ab'::character(4) AS c, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT x, '16/B374D848'::pg_lsn AS l FROM (VALUES (char 'abc')) v(x)", undefined],
  ["SELECT pg_catalog.length('abc') AS n, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT '16/B374D848'::pg_lsn AS l FROM (SELECT) s", undefined],
  ["SELECT '16/B374D848'::pg_lsn + 1 AS l", undefined],
  ["SELECT $1::pg_lsn + 1 AS l", ["16/B374D848"]],
  ["SELECT ('{16/B374D848}'::pg_lsn[])[1] AS l", undefined],
  ["SELECT ('{16/B374D848}'::pg_lsn[])::text AS l", undefined],
  ["SELECT 12.5::money AS m, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT host(inet '10.0.0.1/8') AS h, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT to_json('16/B374D848'::pg_lsn) AS j", undefined],
  ["SELECT min(x), max(x) FROM (VALUES ('16/B374D848'::pg_lsn), ('17/B374D848')) v(x)", undefined],
  ["SELECT x FROM (VALUES ('16/B374D848'::pg_lsn), ('17/B374D848')) v(x) ORDER BY 1", undefined],
  ["SELECT '16/B374D848'::pg_lsn::text::pg_lsn AS l", undefined],
  ["SELECT pg_lsn('16/B374D848') AS l", undefined],
  ["SELECT '16/B374D848'::pg_lsn AS l, version() IS NOT NULL AS v", undefined],
  ["SELECT current_database() = current_database() AS d, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT pg_lsn '16/B374D848' AS l, current_schema() AS s, session_user = session_user AS u", undefined],
  ["SELECT '16/B374D848'::pg_lsn AS l, has_table_privilege('l', 'SELECT') AS p", undefined],
  ["SELECT '16/B374D848'::pg_lsn AS l, txid_current() > 0 AS x", undefined],
  ["SELECT '16/B374D848'::pg_lsn AS l, inet '10.0.0.1' + 1 AS i", undefined],
  ["SELECT '10:20:10,14,15'::pg_snapshot AS s, '16/B374D848'::pg_lsn AS l", undefined],
  ["SELECT upper('abc') AS u, '16/B374D848'::pg_lsn AS l", undefined],
];

test("on a Postgres 19 source, a statement of no table that names a pg_lsn answers its other values as before (the review of PR 1201)", async () => {
  const differ: string[] = [];
  for (const s of [s19, s19v]) {
    for (const [sql, values] of BESIDE) {
      const [got, want] = [await ask(s, sql, values), await known(sql, values)];
      if (!util.isDeepStrictEqual(got, want)) differ.push(`${s === s19v ? "allowlist on" : "allowlist off"}: ${sql}\n    mason:      ${JSON.stringify(got)}\n    postgres: ${JSON.stringify(want)}`);
    }
    // a pg_lsn bound in binary (PGlite's client sends no binary parameter, so Postgres's answer is written here)
    const bound = await ask(s, "SELECT $1::pg_lsn AS l", [Buffer.from("00000016b374d848", "hex")]);
    if (!util.isDeepStrictEqual(bound, { fields: [["l", 3220]], rows: [["16/B374D848"]] })) differ.push(`a binary pg_lsn parameter: ${JSON.stringify(bound)}`);
  }
  assert.deepEqual(differ, []);
});
