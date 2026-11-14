/**
 * A PLAIN NUMERIC PRINTED WITH EACH VALUE'S OWN SCALE (issue 946, src/duck/scale-column.ts): a column declared `numeric`
 * with no precision is held as DECIMAL(38, s), s the most decimals any value has, beside a hidden UTINYINT of each value's
 * own scale (as the sync writes it: tests/integration/duck-plain-numeric.itest.ts). Every reader that prints a value is
 * held to Postgres (PGlite, the same rows): the wire in text and in binary, `::text`, arithmetic, CASE, coalesce,
 * NULLIF, the aggregates and windows that pick or sum a value, a subquery, a CTE and a UNION ALL; the keys, filters and
 * groups stay the engine's own. A set operation that compares rows keeps the column's scale (the listed
 * `mixed-scale-numeric`), and never splits 12.5 from 12.50.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import * as net from "node:net";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import * as wire from "./postgres-api/wire.ts";

// the hidden column's name as src/duck/scale-column.ts makes it, spelled here so the file loads at a commit without that
// module (scripts/fails-without.ts), where the hidden column is never read and the answers differ
const scaleColumn = (column: string): string => `__mason_scale_${createHash("sha256").update(column).digest("hex").slice(0, 12)}`;
const hidden = scaleColumn("u");

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-plain-numeric-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;

// each value's text as Postgres holds it, and the copy's DECIMAL(38, 2) of it with that scale beside it
const P = ["(1, 1, 0)", "(2, 1, 12.5)", "(3, 1, 12.49)", "(4, 2, -12.5)", "(5, 2, 0.01)", "(6, 2, 9999999999.99)", "(7, 3, 7.77)", "(8, 3, 0.30)", "(9, 3, 12.50)", "(10, 3, NULL)"];
const Q = ["(1, 2, 1.5, 100)", "(2, 2, 2.25, 0.000)", "(3, 4, 3, 7.1)", "(4, 9, 0.10, NULL)"];
const scaleOf = (row: string): string => { const v = row.slice(1, -1).split(", ").at(-1)!; return v === "NULL" ? "NULL" : String(v.includes(".") ? v.length - v.indexOf(".") - 1 : 0); };
// the readers that turn one into text (issue 946's second part): each value's text as Postgres holds it, 0 beside 0.000,
// 12.5 beside 12.50, a NULL and a value of 20 decimals, so the copy is DECIMAL(38, 20)
const R: Array<[number, number, string | null]> = [[1, 1, "12.5"], [2, 1, "12.50"], [3, 1, "0"], [4, 2, "0.000"], [5, 2, "-1.10"], [6, 2, "0.00000000000000000001"], [7, 3, null], [8, 3, "7"], [9, 3, "0.30"]];
const qScales = (row: string): [string, string] => {
  const [, , u, v] = row.slice(1, -1).split(", ");
  const s = (x: string): string => x === "NULL" ? "NULL" : String(x.includes(".") ? x.length - x.indexOf(".") - 1 : 0);
  return [s(u!), s(v!)];
};

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "p", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "g", type: "int4" }, { name: "u", type: "numeric", spelled: "numeric", scaled: hidden }] },
    // (its row type, so a whole row of r is the source's: any OID the source would give it)
    { name: "r", primaryKey: ["id"], joins: [], rowTypeOid: 99001, columns: [{ name: "id", type: "int4" }, { name: "g", type: "int4" }, { name: "u", type: "numeric", spelled: "numeric", scaled: hidden }] },
    { name: "z", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "t", type: "text" }] },
    { name: "q", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "p_id", type: "int4" }, { name: "u", type: "numeric", spelled: "numeric", scaled: hidden },
      { name: "v", type: "numeric", spelled: "numeric", scaled: scaleColumn("v") }] },
  ],
};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const db = String((await store.writer.runAndReadAll("SELECT current_database()")).getRowsJS()[0]![0]);
  const w = store.writer;
  await w.run(`CREATE TABLE public.p (id INTEGER, g INTEGER, u DECIMAL(38,2), "${hidden}" UTINYINT)`);
  await w.run(`INSERT INTO public.p VALUES ${P.map((r) => `${r.slice(0, -1)}, ${scaleOf(r)})`).join(", ")}`);
  await w.run(`CREATE TABLE public.q (id INTEGER, p_id INTEGER, u DECIMAL(38,2), v DECIMAL(38,3), "${hidden}" UTINYINT, "${scaleColumn("v")}" UTINYINT)`);
  await w.run(`INSERT INTO public.q VALUES ${Q.map((r) => `${r.slice(0, -1)}, ${qScales(r).join(", ")})`).join(", ")}`);
  await w.run(`CREATE TABLE public.r (id INTEGER, g INTEGER, u DECIMAL(38,20), "${hidden}" UTINYINT)`);
  await w.run(`INSERT INTO public.r VALUES ${R.map(([id, g, u]) => `(${id}, ${g}, ${u === null ? "NULL" : `'${u}'`}, ${u === null ? "NULL" : u.includes(".") ? u.length - u.indexOf(".") - 1 : 0})`).join(", ")}`);
  // each copy's view of its visible columns, as the sync makes it (src/duck/kept.ts `view`)
  await w.run("ATTACH IF NOT EXISTS ':memory:' AS __mason_visible");
  await w.run("CREATE SCHEMA IF NOT EXISTS __mason_visible.public");
  await w.run(`CREATE VIEW __mason_visible.public.p AS SELECT id, g, u FROM "${db}".public.p`);
  await w.run(`CREATE VIEW __mason_visible.public.q AS SELECT id, p_id, u, v FROM "${db}".public.q`);
  await w.run(`CREATE VIEW __mason_visible.public.r AS SELECT id, g, u FROM "${db}".public.r`);
  // a text column whose value looks like a hidden scale column's name: data, quoted as it is in an error
  await w.run("CREATE TABLE public.z (id INTEGER, t VARCHAR); INSERT INTO public.z VALUES (6, '__mason_scale_0123456789ab')");
  await w.run(`CREATE VIEW __mason_visible.public.z AS SELECT id, t FROM "${db}".public.z`);
  await truth.exec("CREATE TABLE z (id integer PRIMARY KEY, t text); INSERT INTO z VALUES (6, '__mason_scale_0123456789ab')");
  await truth.exec("CREATE TABLE p (id integer PRIMARY KEY, g integer, u numeric); CREATE TABLE q (id integer PRIMARY KEY, p_id integer, u numeric, v numeric)");
  await truth.exec(`INSERT INTO p VALUES ${P.join(", ")}; INSERT INTO q VALUES ${Q.join(", ")}`);
  await truth.exec(`CREATE TABLE r (id integer PRIMARY KEY, g integer, u numeric); INSERT INTO r VALUES ${R.map(([id, g, u]) => `(${id}, ${g}, ${u ?? "NULL"})`).join(", ")}`);
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
const TEXT_PARSERS = Object.fromEntries([16, 20, 21, 23, 25, 114, 1043, 1231, 1700, 3802].map((o) => [o, (v: string) => v]));

/** the statements whose answers (names, types, text, order) differ between Mason and Postgres */
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

test("a plain numeric's every reader prints each value with its own scale, as Postgres does", async () => {
  assert.deepEqual(await unlike([
    // the wire's text, a star, a cast to text and its readers
    "SELECT id, u FROM p ORDER BY id",
    "SELECT * FROM p ORDER BY id",
    "SELECT p.*, q.* FROM p JOIN q ON q.p_id = p.id ORDER BY p.id, q.id",
    "SELECT id, u::text, u::varchar, u::text = '12.5' FROM p ORDER BY id",
    "SELECT id FROM p WHERE u::text = '12.5' ORDER BY id",
    "SELECT string_agg(u::text, ',' ORDER BY id) FROM p",
    "SELECT u::text, count(*) FROM p GROUP BY u::text ORDER BY 1",
    "SELECT u::text, count(*) FROM p GROUP BY 1 ORDER BY 1",
    // arithmetic, a CASE, coalesce, NULLIF: Postgres's scale rules over each row's own
    "SELECT id, u + 1, u * 2, u - 0.5, -u, abs(u), u / 4, round(u, 1), trunc(u), floor(u), ceil(u) FROM p ORDER BY id",
    "SELECT id, coalesce(u, 0), CASE WHEN g = 1 THEN u ELSE 0 END, nullif(u, 0), greatest(u, 1), least(u, 0.5) FROM p ORDER BY id",
    "SELECT q.u + p.u, q.v * 2, q.v FROM p JOIN q ON q.p_id = p.id ORDER BY q.id",
    // aggregates: a sum at the most decimals its rows have, a min or max the row it picks
    "SELECT g, sum(u), avg(u) FROM p GROUP BY g ORDER BY g",
    "SELECT sum(u) FROM p WHERE id IN (2, 8)",
    "SELECT g, sum(u) FROM p WHERE id IN (2, 4, 9) GROUP BY g ORDER BY g",
    "SELECT g, sum(u * 2), sum(u + 1), sum(CASE WHEN g = 1 THEN u ELSE 0 END), sum(u) FILTER (WHERE id <> 6) FROM p GROUP BY g ORDER BY g",
    "SELECT u, count(*) FROM p GROUP BY u ORDER BY u",
    "SELECT g, u FROM p GROUP BY g, u HAVING count(*) > 0 ORDER BY g, u",
    "SELECT DISTINCT u FROM p ORDER BY u",
    "SELECT DISTINCT ON (g) g, u FROM p ORDER BY g, id",
    // windows
    "SELECT id, u, lag(u) OVER (ORDER BY id), lead(u, 1, 0) OVER (ORDER BY id), first_value(u) OVER (ORDER BY id), sum(u) OVER (ORDER BY id), sum(u) OVER (PARTITION BY g) FROM p ORDER BY id",
    // a subquery, a CTE, a scalar subquery, a UNION ALL, a sort and a limit
    "SELECT x FROM (SELECT u AS x, id FROM p) s ORDER BY id",
    "WITH w AS (SELECT id, u FROM p WHERE id < 6) SELECT u, id FROM w ORDER BY id",
    // a `*` over a WITH query lists its columns, never a table's: no view, the hidden scale read by name
    "WITH w AS (SELECT id, u FROM p) SELECT * FROM w ORDER BY id",
    "WITH w AS (SELECT g, sum(u) AS s FROM p GROUP BY g) SELECT * FROM w ORDER BY g",
    "SELECT * FROM (SELECT * FROM p) s ORDER BY id",
    "SELECT u FROM p WHERE id < 4 UNION ALL SELECT u FROM q ORDER BY 1",
    "SELECT id, u FROM p ORDER BY u DESC NULLS LAST LIMIT 3",
    "SELECT p.id, p.u, q.v FROM p LEFT JOIN q ON q.p_id = p.id ORDER BY p.u, p.id LIMIT 4",
    // the keys and filters stay the engine's own exact value
    "SELECT id FROM p WHERE u = 12.5 ORDER BY id",
    "SELECT count(DISTINCT u), count(u) FROM p",
  ]), []);
});

/** the binary DataRows (result format 1) of `sql` over Mason's wire, as hex: Parse, Bind, Execute, Sync on a raw socket */
async function binaryRows(sql: string): Promise<string[][]> {
  const socket = net.connect(api.port, "127.0.0.1");
  await new Promise<void>((r) => socket.once("connect", () => r()));
  let got = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  socket.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); wake?.(); });
  const ready = async (): Promise<Buffer> => {
    while (!(got.length >= 6 && got[got.length - 6] === 0x5a && got.readInt32BE(got.length - 5) === 5)) await new Promise<void>((r) => { wake = r; });
    const all = got;
    got = Buffer.alloc(0);
    return all;
  };
  try {
    socket.write(wire.startup({ user: "mason", database: "app" }));
    while (got.length === 0) await new Promise<void>((r) => { wake = r; });
    got = Buffer.alloc(0);
    socket.write(wire.password(mintToken(API_KEY, 600).token));
    await ready();
    socket.write(wire.extended(sql, [], [1]));
    return rowsOf(await ready());
  } finally { socket.destroy(); }
}
const rowsOf = (bytes: Uint8Array): string[][] => wire.replies(bytes).flatMap((m) => m.type === "DataRow" ? [m.values.map((v) => v === null ? "NULL" : v.toString("hex"))] : []);

test("a plain numeric's own scale reaches a client that reads the wire in binary: Postgres's numeric_send bytes", async () => {
  for (const sql of ["SELECT u FROM p ORDER BY id", "SELECT g, sum(u) FROM p GROUP BY g ORDER BY g", "SELECT u + 1, u * 2 FROM p ORDER BY id"]) {
    assert.deepEqual(await binaryRows(sql), rowsOf(await truth.execProtocolRaw(wire.extended(sql, [], [1]))), sql);
  }
});

test("a plain numeric turned into text is Postgres's text: JSON, a row's text, concat, format, ||, a min or max's text, a DISTINCT of its text", async () => {
  assert.deepEqual(await unlike([
    "SELECT id, to_json(u), to_jsonb(u), json_build_object('k', u)::text, jsonb_build_object('k', u)::text FROM r ORDER BY id",
    "SELECT json_agg(u ORDER BY id)::text, jsonb_agg(u ORDER BY id)::text, json_object_agg(id, u ORDER BY id)::text FROM r",
    "SELECT g, json_agg(u ORDER BY id)::text FROM r GROUP BY g ORDER BY g",
    "SELECT id, row(id, u)::text, row(u, g)::text FROM r ORDER BY id",
    "SELECT id, concat(u), concat_ws(',', u, id), format('%s|%s', u, u), u || 'x', 'x' || u FROM r ORDER BY id",
    "SELECT id, json_build_object('a', u, 'b', u + 1, 'c', u * 2, 'd', -u)::text, concat(coalesce(u, 0)) FROM r ORDER BY id",
    "SELECT g, string_agg(u::text, ',' ORDER BY id) FROM r GROUP BY g ORDER BY g",
    // a min or max's text: the row holding it (12.5 and 12.50, equal, are left out: Postgres keeps the last it reads)
    "SELECT max(u)::text, concat(min(u)), to_json(max(u))::text FROM r WHERE id <> 2",
    "SELECT g, max(u)::text, concat(min(u)), to_json(min(u))::text FROM r WHERE id <> 2 GROUP BY g ORDER BY g",
    // a GROUP BY key's text, and a DISTINCT of the text: 12.5 and 12.50 are two
    "SELECT DISTINCT u::text FROM r ORDER BY 1",
    "SELECT concat(u), count(*) FROM r WHERE id <> 2 GROUP BY u ORDER BY 2, 1",
    "SELECT r.id, concat(r.u, q.u) FROM r JOIN q ON q.p_id = r.id ORDER BY 1, 2",
    // a grouped expression's text: its group's own, never a row's scale outside the GROUP BY (42803)
    "SELECT id, (u * 1)::text FROM r GROUP BY id, u * 1 ORDER BY id",
  ]), []);
});

test("a plain numeric's text grouped by itself, spelled out, by number, by name or in a grouping set, and a whole row grouped by its key, is Postgres's (the review of PR 1004: 42803)", async () => {
  assert.deepEqual(await unlike([
    // a text expression as the key, spelled out: the list's and the key's read the scale alike
    "SELECT concat(u), count(*) FROM r GROUP BY concat(u) ORDER BY 1",
    "SELECT 'x' || u, count(*) FROM r GROUP BY 'x' || u ORDER BY 1",
    "SELECT format('%s', u), count(*) FROM r GROUP BY format('%s', u) ORDER BY 1",
    "SELECT to_json(u)::text, count(*) FROM r GROUP BY to_json(u)::text ORDER BY 1",
    "SELECT concat(u, 'a'), count(*) FROM r GROUP BY concat(u, 'a') ORDER BY 1",
    "SELECT g, concat(u), count(*) FROM r GROUP BY g, concat(u) HAVING concat(u) <> '' ORDER BY 1, concat(u)",
    "SELECT concat(u), count(*) FROM r GROUP BY 1 ORDER BY 1",
    "SELECT concat(u) AS c, count(*) FROM r GROUP BY c ORDER BY 1",
    "SELECT concat(u), count(*) FROM r GROUP BY ROLLUP (concat(u)) ORDER BY 1",
    // a cast of arithmetic to text as the key
    "SELECT (u * 1)::text, count(*) FROM r GROUP BY (u * 1)::text ORDER BY 1",
    "SELECT (u + 0)::text, (-u)::text, count(*) FROM r GROUP BY (u + 0)::text, (-u)::text ORDER BY 1",
    "SELECT (u * 2)::varchar, count(*) FROM r GROUP BY (u * 2)::varchar ORDER BY 1",
    "SELECT g, (u * 1)::text, count(*) FROM r GROUP BY g, (u * 1)::text ORDER BY 1, 2",
    "SELECT (u * 1)::text AS t, count(*) FROM r GROUP BY t ORDER BY 1",
    // a whole row and a column its key decides, grouped by the key
    "SELECT row_to_json(r)::text FROM r GROUP BY id ORDER BY 1",
    "SELECT r::text, count(*) FROM r GROUP BY r.id ORDER BY 1",
    "SELECT r.id, to_json(r)::text, count(q.id) FROM r LEFT JOIN q ON q.p_id = r.id GROUP BY r.id ORDER BY 1",
    "SELECT id, concat(u), to_json(u)::text, format('%s', u), row(u)::text FROM r GROUP BY id ORDER BY 1",
  ]), []);
});

test("an engine error quotes a value that looks like a hidden scale column's name as it is: the user's data, never masked (the review of PR 1004)", async () => {
  assert.deepEqual(await unlike([
    "SELECT t::int FROM z WHERE id = 6",
    "SELECT (u::text || '__mason_scale_abcdefabcdef')::int FROM r WHERE id = 1",
  ]), []);
});

test("a set operation that compares rows keeps a plain numeric's one scale (mixed-scale-numeric), never splitting equal values", async () => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  try {
    const r = await c.query({ text: "SELECT u FROM p UNION SELECT u FROM q ORDER BY 1", rowMode: "array", types: raw } as pg.QueryConfig);
    const want = await truth.query<unknown[]>("SELECT u FROM p UNION SELECT u FROM q ORDER BY 1", [], { rowMode: "array" });
    assert.equal(r.rows.length, want.rows.length, "as many rows as Postgres: 12.5 and 12.50 are one");
  } finally { await c.end(); }
});
