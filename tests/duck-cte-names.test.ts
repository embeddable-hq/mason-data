/**
 * WHAT A NAME IN A FROM READS, AS POSTGRES BINDS IT, WHERE THE ENGINE BINDS NAMES WITHOUT CASE (issue 981, the review
 * of PR 1093; src/duck/cte-names.ts). Postgres tells `"Small"` from `small` and `"__MASON_WITH0"` from `__mason_with0`;
 * DuckDB does not. So a WITH query whose name differs from a table's only in case is renamed apart as one of the same
 * name is, and the name it is given is one the statement holds in no case. A WITH query's column list names its
 * columns in a whole row of it. Each statement is held to Postgres (PGlite, the same rows).
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-cte-names-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;

const int4 = (name: string) => ({ name, type: "int4" as const });
const schema: PgSchema = {
  database: "app",
  tables: [
    // (the engine holds no two tables whose names differ only in case, so the lower-case table has another name)
    { name: "orders", primaryKey: ["id"], joins: [], columns: [int4("id"), int4("tenant"), { name: "v", type: "text" }] },
    { name: "Big", primaryKey: ["id"], joins: [], columns: [int4("id"), int4("x"), int4("tenant")] },
    { name: "Small", primaryKey: ["id"], joins: [], columns: [int4("id"), { name: "w", type: "text" }] },
    // a name the rewrite's own renaming once gave a WITH query, in the other case
    { name: "__MASON_WITH0", primaryKey: ["id"], joins: [], columns: [int4("id"), int4("z")] },
  ],
};
// the same rows on both sides: orders 400 rows (100 a tenant), "Big" 40 (10 a tenant), "Small" 50, "__MASON_WITH0" 3
const ROWS = [
  ["orders", "SELECT i, i % 4, 'v' || i FROM generate_series(1, 400) i", "SELECT i, i % 4, 'v' || i FROM range(1, 401) t(i)"],
  ["Big", "SELECT i, i * 10, i % 4 FROM generate_series(1, 40) i", "SELECT i, i * 10, i % 4 FROM range(1, 41) t(i)"],
  ["Small", "SELECT i, 'w' || i FROM generate_series(1, 50) i", "SELECT i, 'w' || i FROM range(1, 51) t(i)"],
  ["__MASON_WITH0", "SELECT i, i FROM generate_series(1, 3) i", "SELECT i, i FROM range(1, 4) t(i)"],
] as const;

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const w = store.writer;
  await w.run('CREATE TABLE public.orders (id INTEGER, tenant INTEGER, v VARCHAR); CREATE TABLE public."Big" (id INTEGER, x INTEGER, tenant INTEGER)');
  await w.run('CREATE TABLE public."Small" (id INTEGER, w VARCHAR); CREATE TABLE public."__MASON_WITH0" (id INTEGER, z INTEGER)');
  await truth.exec('CREATE TABLE orders (id integer PRIMARY KEY, tenant integer, v text); CREATE TABLE "Big" (id integer PRIMARY KEY, x integer, tenant integer)');
  await truth.exec('CREATE TABLE "Small" (id integer PRIMARY KEY, w text); CREATE TABLE "__MASON_WITH0" (id integer PRIMARY KEY, z integer)');
  for (const [table, pgRows, duckRows] of ROWS) {
    await w.run(`INSERT INTO public."${table}" ${duckRows}`);
    await truth.exec(`INSERT INTO "${table}" ${pgRows}`);
  }
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const problem = tokenProblem(API_KEY, password); if (problem !== null) throw new Error(problem); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, () => []),
  });
});
after(async () => {
  await api.close();
  await store.close();
  await truth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = { getTypeParser: () => (v: string) => v };
const TEXT_PARSERS = Object.fromEntries([16, 20, 21, 23, 25, 114, 1043, 2249].map((o) => [o, (v: string) => v]));

/** the statements whose answers (names, types, text, order, or the error) differ between Mason and Postgres */
async function unlike(statements: readonly string[]): Promise<string[]> {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  const differ: string[] = [];
  try {
    for (const sql of statements) {
      const got = await c.query({ text: sql, rowMode: "array", types: raw } as pg.QueryConfig)
        .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x: unknown[]) => x.map((v) => v === null ? null : String(v))) }), (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
      const want = await truth.query<unknown[]>(sql, [], { rowMode: "array", parsers: TEXT_PARSERS })
        .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x) => x.map((v) => v === null ? null : String(v))) }), (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
      if (!util.isDeepStrictEqual(got, want)) differ.push(`${sql}\n    mason:    ${JSON.stringify(got).slice(0, 400)}\n    postgres: ${JSON.stringify(want).slice(0, 400)}`);
    }
  } finally { await c.end(); }
  return differ;
}

test("a WITH query whose name differs from a table's only in case reads as Postgres binds it, never the other in the engine", async () => {
  assert.deepEqual(await unlike([
    // the WITH query small is not the table "Small"
    `WITH small AS (SELECT * FROM orders WHERE tenant = 0) SELECT count(*) FROM "Small"`,
    `WITH small AS (SELECT * FROM orders WHERE tenant = 0) SELECT (SELECT count(*) FROM small) AS s, (SELECT count(*) FROM "Small") AS t`,
    // the WITH query big reads the table "Big", and the statement reads both
    `WITH big AS (SELECT * FROM "Big" WHERE tenant = 0) SELECT (SELECT count(*) FROM big) AS b, (SELECT count(*) FROM "Big") AS t`,
    // the WITH query "Orders" reads the table orders: the same, the other way round in case
    `WITH "Orders" AS (SELECT * FROM orders WHERE tenant = 0) SELECT (SELECT count(*) FROM "Orders") AS o, (SELECT count(*) FROM orders) AS t`,
    `WITH "BIG" AS (SELECT * FROM "Big" WHERE tenant = 1) SELECT count(*), (SELECT count(*) FROM "Big") FROM "BIG"`,
  ]), []);
});

test("the name a WITH query is renamed to is one the statement holds in no case: a table \"__MASON_WITH0\" is still the table", async () => {
  assert.deepEqual(await unlike([
    `WITH orders AS (SELECT * FROM orders WHERE tenant = 0) SELECT count(*), (SELECT count(*) FROM "__MASON_WITH0") FROM orders`,
    `WITH orders AS (SELECT * FROM orders WHERE tenant = 0) SELECT o.id, m.z FROM orders o JOIN "__MASON_WITH0" m ON m.id = o.id / 4 ORDER BY 1`,
  ]), []);
});

test("a whole row of a WITH query with a column list is read by the list's names (the review of PR 1093: 42703)", async () => {
  assert.deepEqual(await unlike([
    "WITH q(a, b) AS (SELECT id, tenant FROM orders WHERE tenant = 1) SELECT q.a, q FROM q ORDER BY a LIMIT 3",
    "WITH q(a, b) AS (SELECT id, tenant FROM orders WHERE tenant = 1) SELECT x.a, x, row_to_json(x) FROM q AS x ORDER BY a LIMIT 3",
    "WITH orders(a, b) AS (SELECT id, tenant FROM orders WHERE tenant = 1) SELECT orders.a, orders FROM orders ORDER BY a LIMIT 3",
  ]), []);
});
