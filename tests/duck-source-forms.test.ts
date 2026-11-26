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
let s18: Served, s19: Served;

async function serve(name: string, write: (v: string) => string, sourceVersion: number): Promise<Served> {
  const store = await DuckStore.open(path.join(dir, `${name}.db`), () => undefined);
  const q = (v: string | null): string => v === null ? "NULL" : `'${write(v)}'`;
  await store.writer.run("CREATE TABLE public.l (id INTEGER, lsn VARCHAR, la VARCHAR[]); CREATE TABLE public.m (id INTEGER, lsn VARCHAR)");
  await store.writer.run(`INSERT INTO public.l VALUES ${L18.map(([id, v, a]) => `(${id}, ${q(v)}, ${a === null ? "NULL" : `[${a.map(q).join(", ")}]::VARCHAR[]`})`).join(", ")}`);
  await store.writer.run(`INSERT INTO public.m VALUES ${M18.map(([id, v]) => `(${id}, ${q(v)})`).join(", ")}`);
  const api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const problem = tokenProblem(API_KEY, password); if (problem !== null) throw new Error(problem); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined,
    // (the allowlist off, as the oracle runs: what is answered is the rewrite's, an IN list of pg_lsn included)
    duck: await store.listener(undefined, null, undefined, () => [], undefined, { sourceVersion }),
  });
  return { store, api };
}

before(async () => {
  s18 = await serve("pg18", (v) => v, 180006);
  s19 = await serve("pg19", as19, 190000);
  await truth.exec("CREATE TABLE l (id int PRIMARY KEY, lsn pg_lsn, la pg_lsn[]); CREATE TABLE m (id int PRIMARY KEY, lsn pg_lsn)");
  const q = (v: string | null): string => v === null ? "NULL" : `'${v}'`;
  await truth.exec(`INSERT INTO l VALUES ${L18.map(([id, v, a]) => `(${id}, ${q(v)}, ${a === null ? "NULL" : `'{${a.join(",")}}'`})`).join(", ")}`);
  await truth.exec(`INSERT INTO m VALUES ${M18.map(([id, v]) => `(${id}, ${q(v)})`).join(", ")}`);
});
after(async () => {
  for (const s of [s18, s19]) { await s?.api.close(); await s?.store.close(); }
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
  return truth.query<unknown[]>(sql, values ?? [], { rowMode: "array", parsers: Object.fromEntries([16, 20, 21, 23, 25, 1700, 3220, 3221].map((o) => [o, (v: string) => v])) })
    .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID] as [string, number]), rows: r.rows.map((x) => x.map((v) => v === null ? null : String(v))) }),
      (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
}
const ids = (...n: number[]): Answer => ({ fields: [["id", 23]], rows: n.map((i) => [String(i)]) });

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
  // a statement of no table: the synced data's, which writes it as the source does
  ["SELECT '0/16B3748'::pg_lsn", undefined, { fields: [["pg_lsn", 3220]], rows: [["0/016B3748"]] }],
  ["VALUES ('0/16B3748'::pg_lsn), ('1/0')", undefined, { fields: [["column1", 3220]], rows: [["0/016B3748"], ["1/00000000"]] }],
  ["SELECT '0/016B3748'::pg_lsn AS a, '1/0'::pg_lsn::text AS b", undefined, { fields: [["a", 3220], ["b", 25]], rows: [["0/016B3748", "1/00000000"]] }],
  ["SELECT '{0/1,1/0}'::pg_lsn[] AS a", undefined, { fields: [["a", 3221]], rows: [["{0/00000001,1/00000000}"]] }],
  ["SELECT '0/1'::pg_lsn UNION SELECT '0/00000001'::pg_lsn", undefined, { fields: [["pg_lsn", 3220]], rows: [["0/00000001"]] }],
  // ... and one whose pg_lsn is read only by a boolean or a numeric: the catalog's where the synced data cannot
  ["SELECT pg_lsn '0/2' - pg_lsn '0/1' AS d, pg_lsn '0/2' > pg_lsn '0/01' AS g", undefined, { fields: [["d", 1700], ["g", 16]], rows: [["1", "t"]] }],
];

test("on a Postgres 19 source, a pg_lsn literal and parameter compare and print as the source writes them (issue 1198)", async () => {
  const differ: string[] = [];
  for (const [sql, values, want] of CASES) {
    const got = await ask(s19, sql, values);
    if (!util.isDeepStrictEqual(got, want)) differ.push(`${sql}\n    mason:      ${JSON.stringify(got)}\n    postgres 19: ${JSON.stringify(want)}`);
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
