/**
 * THE NAMES MASON INVENTS NEVER MEET A NAME OF THE STATEMENT'S (issue 1024; src/duck/own-names.ts). The rewrite writes
 * names of its own into what it sends the engine: the row number a top N over a join reads rows by, the kept rows'
 * columns, a lambda's parameter, a WITH query, an alias, the hidden cells. A source column, an alias, a table or a WITH
 * query of the same name, in any case, was read as Mason's or Mason's as it: NULLs for a table's columns, another row's
 * value, or the engine's error. Every statement here is held to Postgres (PGlite, the same rows).
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-own-names-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;

/** each table: its name, its columns (name, Postgres's type, the engine's), and its rows, the same on both sides */
const TABLES: Array<{ name: string; columns: Array<[string, string, string]>; rows: string }> = [
  // a column named like the row number a top N over a join reads rows by (src/duck/late.ts), and one in another case
  { name: "h", columns: [["id", "integer", "INTEGER"], ["__mason_rid", "integer", "INTEGER"], ["v", "text", "VARCHAR"]], rows: "(1, 30, 'a'), (2, 10, 'b'), (3, 20, 'c'), (4, NULL, 'd'), (5, 40, 'e')" },
  { name: "up", columns: [["id", "integer", "INTEGER"], ["__MASON_RID", "integer", "INTEGER"], ["v", "text", "VARCHAR"]], rows: "(1, 30, 'a'), (2, 10, 'b'), (3, 20, 'c'), (4, NULL, 'd')" },
  { name: "other", columns: [["id", "integer", "INTEGER"], ["v", "text", "VARCHAR"]], rows: "(1, 'x'), (3, 'z'), (5, 'y')" },
  // columns named like the kept rows and their columns (src/duck/late.ts)
  { name: "names", columns: [["id", "integer", "INTEGER"], ["__mason_late", "integer", "INTEGER"], ["__mason_c1", "integer", "INTEGER"], ["__mason_o1", "integer", "INTEGER"], ["__mason_r1", "integer", "INTEGER"]],
    rows: "(1, 11, 12, 33, 14), (2, 21, 22, 13, 24), (3, 31, 32, 23, 34)" },
  // jsonb columns named like the parameters of the lambdas a native json read binds (src/duck/rewrite.ts `bound`)
  { name: "jv", columns: [["id", "integer", "INTEGER"], ["__mason_v", "jsonb", "JSON"], ["__mason_x", "jsonb", "JSON"], ["__mason_k", "jsonb", "JSON"]],
    rows: `(1, '{"a": 1.50, "b": "s"}', '{"a": 1, "b": 2}', '{"p": 1, "q": 2}'), (2, '{"a": 7, "b": [1]}', '{"a": 2}', '{}'), (3, NULL, NULL, NULL)` },
  // a numeric named like the lambda's parameter that picks a mode() by its exact key (`pickedByExactKey`)
  { name: "nums", columns: [["id", "integer", "INTEGER"], ["__mason_e", "numeric(10,2)", "DECIMAL(10,2)"], ["a", "integer", "INTEGER"], ["b", "integer", "INTEGER"]],
    rows: "(1, 1.00, 1, 2), (2, 2.00, 3, 4), (3, 2.00, 5, 6), (4, NULL, NULL, NULL)" },
  // tables named like the kept rows, FETCH … WITH TIES's bound, an unnamed VALUES and a list function's step
  { name: "__mason_late", columns: [["id", "integer", "INTEGER"], ["w", "text", "VARCHAR"]], rows: "(1, 'L1'), (2, 'L2')" },
  { name: "__mason_ties_bound", columns: [["id", "integer", "INTEGER"], ["n", "integer", "INTEGER"]], rows: "(1, 100), (2, 200)" },
  { name: "__mason_values", columns: [["id", "integer", "INTEGER"], ["k", "integer", "INTEGER"]], rows: "(1, 100)" },
  { name: "__mason_arg1", columns: [["id", "integer", "INTEGER"], ["n", "integer", "INTEGER"]], rows: "(1, 100), (2, 200)" },
];
const quoted = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const API_TYPES: Record<string, string> = { integer: "int4", text: "text", jsonb: "jsonb" };
const schema: PgSchema = {
  database: "app",
  // (each table copied whole, so its whole row is the source's: `rowTypeOid`)
  tables: TABLES.map((t, i) => ({ name: t.name, rowTypeOid: 90_001 + i, primaryKey: ["id"], joins: [],
    columns: t.columns.map(([name, type]) => type.startsWith("numeric") ? { name, type: "numeric" as const, spelled: type } : { name, type: API_TYPES[type] as "int4" }) })),
};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  for (const t of TABLES) {
    await store.writer.run(`CREATE TABLE public.${quoted(t.name)} (${t.columns.map(([c, , duck]) => `${quoted(c)} ${duck}`).join(", ")})`);
    await store.writer.run(`INSERT INTO public.${quoted(t.name)} VALUES ${t.rows}`);
    await truth.exec(`CREATE TABLE ${quoted(t.name)} (${t.columns.map(([c, type]) => `${quoted(c)} ${type}`).join(", ")}, PRIMARY KEY (id))`);
    await truth.exec(`INSERT INTO ${quoted(t.name)} VALUES ${t.rows}`);
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
const TEXT_PARSERS = Object.fromEntries([16, 20, 21, 23, 25, 114, 1043, 1700, 2249, 3802].map((o) => [o, (v: string) => v]));

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

test("issue 1024: a table's column named like the row number a top N over a join reads rows by is the table's, through a *, a whole row and every side", async () => {
  // Before the fix every one answered NULLs for h's columns: `SELECT *, h.rowid AS __mason_rid` listed the table's own
  // column first, and the join read it as the row number.
  assert.deepEqual(await unlike([
    // the issue's statement, and the same rows by another key, by the column itself and descending
    `SELECT h.*, o.v FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h."__mason_rid" LIMIT 2`,
    "SELECT h.id, h.v, o.v FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h.id LIMIT 2",
    "SELECT h.id, h.__mason_rid, o.v FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h.__mason_rid DESC NULLS LAST, h.id LIMIT 3",
    // a * of the table, and its whole row
    "SELECT * FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h.v DESC LIMIT 3",
    "SELECT row_to_json(h), o.v FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h.id LIMIT 3",
    "SELECT h, o.v FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h.id LIMIT 3",
    // a derived side, an inner join, a DISTINCT ON, a grouped key, and no sort (every row: the order is the outer's)
    "SELECT s.*, o.v FROM (SELECT * FROM h WHERE id > 1) s LEFT JOIN other o ON o.id = s.id ORDER BY s.id LIMIT 3",
    "SELECT h.id, h.__mason_rid, o.v FROM h JOIN other o ON o.id = h.id ORDER BY o.v LIMIT 2",
    "SELECT DISTINCT ON (h.v) h.*, o.v FROM h LEFT JOIN other o ON o.id = h.id ORDER BY h.v, h.id LIMIT 3",
    "SELECT h.id, h.__mason_rid, h.v, count(o.id) FROM h LEFT JOIN other o ON o.id = h.id GROUP BY h.id ORDER BY h.id LIMIT 3",
    "SELECT * FROM (SELECT h.id, h.__mason_rid, o.v FROM h LEFT JOIN other o ON o.id = h.id LIMIT 10) s ORDER BY 1",
  ]), []);
});

test("issue 1024: a column named like the row number in another case (\"__MASON_RID\") is the table's: the engine binds a name without case", async () => {
  assert.deepEqual(await unlike([
    `SELECT u.*, o.v FROM up u LEFT JOIN other o ON o.id = u.id ORDER BY u."__MASON_RID" LIMIT 2`,
    "SELECT * FROM up u LEFT JOIN other o ON o.id = u.id ORDER BY u.id LIMIT 3",
    "SELECT row_to_json(u), o.v FROM up u LEFT JOIN other o ON o.id = u.id ORDER BY u.id DESC LIMIT 2",
  ]), []);
});

test("issue 1024: a column named like any other name Mason invents is the table's: the kept rows' columns, a lambda's parameter, a column renamed apart", async () => {
  assert.deepEqual(await unlike([
    // the kept rows and their columns (src/duck/late.ts)
    "SELECT n.*, o.v FROM names n LEFT JOIN other o ON o.id = n.id ORDER BY n.__mason_o1 DESC LIMIT 2",
    "SELECT n.__mason_late, n.__mason_r1, o.v FROM names n JOIN other o ON o.id = n.id ORDER BY n.__mason_c1 LIMIT 2",
    // a lambda's parameter: a bare name inside the lambda's body was read as the parameter (a native `->`, a native
    // `@>` and a native keys' read each fall back to the function on the column, written inside the lambda)
    "SELECT id, __mason_v -> 'a' AS a, __mason_v -> 'b' AS b FROM jv ORDER BY id",
    `SELECT id, __mason_x @> '{"a": 1}' FROM jv ORDER BY id`,
    "SELECT id, jsonb_object_keys(__mason_k) FROM jv ORDER BY 1, 2",
    "SELECT id, k FROM jv, jsonb_object_keys(__mason_k) k ORDER BY 1, 2",
    // a mode() picked by its exact key, in a lambda whose body reads the key (42803 in the engine's words)
    "SELECT mode() WITHIN GROUP (ORDER BY __mason_e / 3) FROM nums",
    // a subquery's columns of one name in two cases are renamed apart for the engine: never as a third column's name
    `SELECT s.t__mason_2, s.t FROM (SELECT a AS "T", b AS t, id AS t__mason_2 FROM nums) s ORDER BY 1`,
    `SELECT s."T__mason_1", s."T" FROM (SELECT a AS "T", b AS t, id AS "T__mason_1" FROM nums) s ORDER BY 1`,
    `WITH q AS (SELECT a AS "T", b AS t, id AS t__mason_2 FROM nums) SELECT t__mason_2, t FROM q ORDER BY 1`,
  ]), []);
});

test("issue 1024: a table or an alias named like a name Mason invents is the statement's: the kept rows, WITH TIES's bound, a VALUES's name, a list function's step", async () => {
  assert.deepEqual(await unlike([
    // the kept rows' derived table, as an alias and as a table the statement reads
    "SELECT __mason_late.id, o.v FROM h AS __mason_late LEFT JOIN other o ON o.id = __mason_late.id ORDER BY 1 LIMIT 2",
    "SELECT h.id, l.w FROM h LEFT JOIN __mason_late l ON l.id = h.id ORDER BY h.id LIMIT 3",
    // FETCH … WITH TIES's bound, a WITH query its rows' query sees
    "SELECT id, (SELECT count(*) FROM __mason_ties_bound) AS c FROM names ORDER BY id % 2 FETCH FIRST 1 ROWS WITH TIES",
    // the name an unnamed VALUES is given
    "SELECT * FROM (VALUES (1), (2)), __mason_values ORDER BY 1",
    // the step a list function's argument is computed by, beside a table of its name
    "SELECT * FROM (SELECT n.id, __mason_arg1.n, x FROM nums n JOIN __mason_arg1 ON __mason_arg1.id = n.id LEFT JOIN LATERAL unnest(ARRAY[n.a, n.b]) x ON true LIMIT 10) s ORDER BY 1, 3",
  ]), []);
});
