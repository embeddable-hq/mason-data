/**
 * A LOOKUP BY A SCATTERED KEY THROUGH ITS SIDE TABLE (issue 1148; src/duck/key-lookup.ts). Each lookup is held to
 * Postgres (PGlite, the same rows) and to the plan that reads the side table, through every write that moves what the
 * side table covers: rows inserted, updated (a delete and an insert, as the sync writes them), deleted, a key deleted
 * and inserted again, the rows at the table's end deleted and their row ids given again after a checkpoint (to an
 * insert, and to an UPDATE DuckDB writes as a delete and an insert), a rebuild with such writes during it, and the
 * table replaced whole. And which tables get one: measured from their own row groups, never from the key's type.
 *
 * The module is imported where it is used, not at the top, so this file loads with src/ as it was before it
 * (scripts/fails-without.ts), where these tests fail by name.
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
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { CopyState } from "../src/duck/sync.ts";

type Lookup = typeof import("../src/duck/key-lookup.ts");
const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-key-lookup-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;
let client: pg.Client;
/** the tables whose side table is built, as the sync says them (`CopyState.lookup`) */
const built = new Map<string, string>();

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "uuid" }, { name: "n", type: "int4" }, { name: "note", type: "text" }] },
    { name: "codes", primaryKey: ["code"], joins: [], columns: [{ name: "code", type: "text" }, { name: "n", type: "int4" }] },
    // the same names in other schemas (a bare name is the first schema's on the search path that holds one): `a.orders`
    // has a key of two columns, so no side table; `items` is in `public` without one and in `b` with one
    { name: "orders", schema: "a", primaryKey: ["id", "k"], joins: [], columns: [{ name: "id", type: "uuid" }, { name: "k", type: "int4" }, { name: "n", type: "int4" }] },
    { name: "items", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "uuid" }, { name: "n", type: "int4" }] },
    { name: "items", schema: "b", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "uuid" }, { name: "n", type: "int4" }] },
  ],
  views: [{ schema: "v", name: "items", definition: "SELECT items.id, items.n FROM public.items WHERE (items.n < 1000)" }],
};
/** three row groups and a part, so the table's end can be deleted whole */
const ROWS = 400_000;

async function lookup(): Promise<Lookup> {
  try { return await import("../src/duck/key-lookup.ts"); }
  catch (e) { assert.fail(`src/duck/key-lookup.ts does not load: there is no lookup by key through a side table (${(e as Error).message})`); }
}

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const w = store.writer;
  // the synced orders also hold a list column the catalog does not show: an UPDATE of it is a delete and an insert
  await w.run("CREATE TABLE public.orders (id UUID NOT NULL, n INTEGER, note VARCHAR, tags VARCHAR[])");
  await w.run(`INSERT INTO public.orders SELECT md5(i::VARCHAR)::UUID, i, 'note ' || i, ['a'] FROM range(${ROWS}) r(i)`);
  await w.run(`CREATE TABLE public.codes (code VARCHAR NOT NULL, n INTEGER)`);
  await w.run(`INSERT INTO public.codes SELECT md5(i::VARCHAR), i FROM range(${ROWS}) r(i)`);
  await w.run("CREATE SCHEMA a");
  await w.run("CREATE TABLE a.orders (id UUID NOT NULL, k INTEGER NOT NULL, n INTEGER)");
  await w.run("INSERT INTO a.orders SELECT md5((i * 7)::VARCHAR)::UUID, 1, i + 1000 FROM range(1000) r(i)");
  await w.run("CREATE TABLE public.items (id UUID NOT NULL, n INTEGER)");
  await w.run("INSERT INTO public.items SELECT md5(i::VARCHAR)::UUID, i FROM range(2000) r(i) ORDER BY i");
  // in the other order, so a row id of one names another key's row in the other
  await w.run("CREATE SCHEMA b");
  await w.run("CREATE TABLE b.items (id UUID NOT NULL, n INTEGER)");
  await w.run("INSERT INTO b.items SELECT md5(i::VARCHAR)::UUID, -i FROM range(2000) r(i) ORDER BY i DESC");
  await w.run("CHECKPOINT");
  await truth.exec(`CREATE SCHEMA a; CREATE TABLE a.orders (id uuid, k integer, n integer, PRIMARY KEY (id, k));
    INSERT INTO a.orders SELECT md5((i * 7)::text)::uuid, 1, i + 1000 FROM generate_series(0, 999) i;
    CREATE TABLE items (id uuid PRIMARY KEY, n integer); INSERT INTO items SELECT md5(i::text)::uuid, i FROM generate_series(0, 1999) i;
    CREATE SCHEMA b; CREATE TABLE b.items (id uuid PRIMARY KEY, n integer); INSERT INTO b.items SELECT md5(i::text)::uuid, -i FROM generate_series(0, 1999) i;
    CREATE SCHEMA v; CREATE VIEW v.items AS SELECT items.id, items.n FROM public.items WHERE (items.n < 1000)`);
  await truth.exec(`CREATE TABLE orders (id uuid PRIMARY KEY, n integer, note text); CREATE TABLE codes (code text PRIMARY KEY, n integer)`);
  await truth.exec(`INSERT INTO orders SELECT md5(i::text)::uuid, i, 'note ' || i FROM generate_series(0, ${ROWS - 1}) i`);
  await truth.exec(`INSERT INTO codes SELECT md5(i::text), i FROM generate_series(0, ${ROWS - 1}) i`);
  const copies = (): CopyState[] => ["public.orders", "public.codes", "a.orders", "public.items", "b.items"].map((source) => ({ source, phase: "copied", rows: ROWS, bytes: null, seconds: null, copiedAt: null, error: null,
    ...(built.has(source) ? { lookup: { column: built.get(source)!, perKey: null, rowGroups: null, measuredAt: null, builtAt: null, seconds: null, entries: null } } : {}) }));
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const problem = tokenProblem(API_KEY, password); if (problem !== null) throw new Error(problem); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, copies),
  });
  client = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await client.connect();
});
after(async () => {
  await client.end();
  await api.close();
  await store.close();
  await truth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (source: string): string => source.split(".").map((p) => `"${p}"`).join(".");

/** a side table built for `source` over `column` as the sync builds it (src/duck/sync.ts `buildLookup`): begun on the
 *  writer's turn, filled on a connection of its own, swapped in. `during` runs between the fill's commit and the
 *  swap (no turn of the writer's holds them together): what the writer writes meanwhile */
async function build(source: string, column: string, during: () => Promise<void> = async () => undefined): Promise<void> {
  const l = await lookup();
  if (built.size === 0) await l.openLookups(store.writer);
  const c = await store.instance.connect();
  let open = false;
  try {
    open = true;
    await l.beginBuild(store.writer, c, source, target(source), column);
    const entries = await l.fillBuilt(c, source, target(source), column, async (sql) => { await c.run(sql); });
    open = false;
    await during();
    assert.notEqual(await l.swapBuilt(store.writer, source, { seconds: 0, entries, spread: null }), null);
  } catch (e) { await l.abandonBuild(c, source, open); throw e; }
  finally { c.closeSync(); }
  built.set(source, column);
}

/** a write as the sync makes one, to both sides: in a transaction, what the side table covers lowered first */
async function write(source: string, duck: readonly string[], postgres: string): Promise<void> {
  const l = await lookup();
  const w = store.writer;
  await w.run("BEGIN TRANSACTION");
  try {
    await l.lowerCovered(w, source, target(source));
    for (const s of duck) await w.run(s);
    await w.run("COMMIT");
  } catch (e) { await w.run("ROLLBACK"); throw e; }
  if (postgres !== "") await truth.exec(postgres);
}

/** THE TABLE'S END DELETED, every row at or past row id `from`, on both sides (the same keys) */
async function deleteEnd(from: number): Promise<void> {
  const ids = ((await store.writer.runAndReadAll(`SELECT id::VARCHAR FROM public.orders WHERE rowid >= ${from}`)).getRowsJS() as Array<[string]>).map(([k]) => k);
  await write("public.orders", [`DELETE FROM public.orders WHERE rowid >= ${from}`], "");
  await truth.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [ids]);
}

const asText = Object.fromEntries([16, 20, 21, 23, 25, 114, 1043, 2950, 1009].map((o) => [o, (v: string) => v]));
/** `sql` answered by Mason and by Postgres alike, row for row; answers whether Mason routed it through a side table */
async function same(sql: string, values: unknown[] = []): Promise<boolean> {
  const m = await client.query({ text: sql, values, rowMode: "array", types: { getTypeParser: () => (v: string) => v } });
  const p = await truth.query(sql, values, { rowMode: "array", parsers: asText });
  assert.deepEqual(m.rows, p.rows, `${sql} ${JSON.stringify(values)}`);
  const plan = await client.query({ text: `EXPLAIN (VERBOSE, COSTS off) ${sql}`, values });
  const sent = (plan.rows as Array<{ "QUERY PLAN": string }>).map((x) => x["QUERY PLAN"]).find((l) => l.includes("Sent to the engine")) ?? "";
  return sent.includes("key_lookup:");
}
const key = (i: number): string => `md5('${i}')::uuid`;
async function uuidOf(i: number): Promise<string> { return (await truth.query<{ k: string }>(`SELECT ${key(i)}::text AS k`)).rows[0]!.k; }

/** the lookups every step below is held to: by a literal, a parameter, a list, the other side, an alias, inside a
 *  subquery — each routed — and shapes that are not routed */
async function lookups(keys: readonly string[]): Promise<void> {
  for (const k of keys) {
    assert.ok(await same(`SELECT id, n, note FROM orders WHERE id = '${k}'`), "a literal key is routed");
    assert.ok(await same(`SELECT id, n, note FROM orders WHERE id = $1`, [k]), "a parameter is routed");
    assert.ok(await same(`SELECT n FROM orders o WHERE '${k}' = o.id AND n >= 0`), "the key on the right, under an alias, beside another conjunct, is routed");
    assert.ok(await same(`SELECT count(*) FROM (SELECT n FROM orders WHERE id = $1::uuid) s`, [k]), "a lookup in a subquery is routed");
    assert.ok(await same(`WITH x AS (SELECT n, note FROM orders WHERE id = $1) SELECT * FROM x`, [k]), "a lookup in a WITH query is routed");
    assert.ok(await same(`SELECT n FROM orders WHERE id = $1 UNION ALL SELECT n FROM orders WHERE id = '${keys[0]}' ORDER BY 1`, [k]), "each arm of a UNION is routed");
  }
  assert.ok(await same(`SELECT id, n FROM orders WHERE id IN (${keys.map((k) => `'${k}'`).join(", ")}, '${keys[0]}') ORDER BY n`), "a list of keys is routed");
  assert.ok(!await same(`SELECT count(*) FROM orders WHERE id = md5(n::text)::uuid`), "a key compared with a column is not routed");
  assert.ok(!await same(`SELECT count(*) FROM orders WHERE id = '${keys[0]}' OR n = 3`), "a key under an OR is not routed");
  assert.ok(!await same(`WITH orders AS (SELECT * FROM codes) SELECT n FROM orders WHERE code = 'x'`), "a WITH query of the table's name is not the table");
  assert.ok(!await same(`WITH orders AS (SELECT id, n FROM orders WHERE n < 100) SELECT n FROM orders WHERE id = $1`, [keys[0]]), "a WITH query of the table's name, keyed as the table, is not the table");
  assert.ok(!await same(`WITH orders AS (SELECT id, n FROM orders WHERE n < 100) SELECT n FROM orders WHERE id = $1 UNION ALL SELECT 1`, [keys[0]]), "nor in a UNION's arm under it");
}

test("a lookup by a scattered key reads its side table and answers as Postgres, through every write", async () => {
  await build("public.orders", "id");
  const ks = await Promise.all([0, 7, 12345, 399_999].map(uuidOf));
  await lookups(ks);
  // INSERTED (the tail, past what the side table covers), UPDATED as the sync writes it (deleted, then inserted at the
  // table's end), DELETED, and a key DELETED AND INSERTED AGAIN
  const fresh = await uuidOf(ROWS + 1);
  await write("public.orders", [`INSERT INTO public.orders VALUES (${key(ROWS + 1)}, -1, 'fresh', ['a'])`], `INSERT INTO orders VALUES (${key(ROWS + 1)}, -1, 'fresh')`);
  await write("public.orders", [`DELETE FROM public.orders WHERE id = ${key(7)}`, `INSERT INTO public.orders VALUES (${key(7)}, 70, 'updated', ['a'])`], `UPDATE orders SET n = 70, note = 'updated' WHERE id = ${key(7)}`);
  await write("public.orders", [`DELETE FROM public.orders WHERE id = ${key(12345)}`], `DELETE FROM orders WHERE id = ${key(12345)}`);
  await write("public.orders", [`DELETE FROM public.orders WHERE id = ${key(0)}`], `DELETE FROM orders WHERE id = ${key(0)}`);
  await write("public.orders", [`INSERT INTO public.orders VALUES (${key(0)}, 1000, 'again', ['a'])`], `INSERT INTO orders VALUES (${key(0)}, 1000, 'again')`);
  await lookups([...ks, fresh]);
  // BUILT AGAIN, sorted: the entries of deleted rows gone, the tail in it
  await build("public.orders", "id");
  await lookups([...ks, fresh]);
});

test("a row id given again after the table's end was deleted is found, inserted or moved by an UPDATE, and during a build", async () => {
  const l = await lookup();
  const w = store.writer;
  if (!built.has("public.orders")) await build("public.orders", "id");
  const covered = async (): Promise<bigint> => (await w.runAndReadAll(`SELECT covered FROM ${l.lookupLedger()} WHERE source = 'public.orders'`)).getRowsJS()[0]![0] as bigint;
  const rowidOf = async (i: number): Promise<bigint> => (await w.runAndReadAll(`SELECT rowid FROM public.orders WHERE id = ${key(i)}`)).getRowsJS()[0]![0] as bigint;
  // THE TABLE'S END DELETED WHOLE (every row past its first two row groups), and a checkpoint drops it: the next rows
  // written take its row ids again, below what the side table covers
  const was = await covered();
  await deleteEnd(245760);
  await w.run("CHECKPOINT");
  await write("public.orders", [`INSERT INTO public.orders VALUES (${key(ROWS + 10)}, 10, 'reused', ['a']), (${key(ROWS + 11)}, 11, 'reused', ['a'])`],
    `INSERT INTO orders VALUES (${key(ROWS + 10)}, 10, 'reused'), (${key(ROWS + 11)}, 11, 'reused')`);
  const taken = await rowidOf(ROWS + 10);
  assert.ok(taken < was, `the insert took a row id the side table covered (${taken}, it covered ${was})`);
  assert.ok(await covered() <= taken, "what the side table covers was lowered below the row ids given again");
  await lookups(await Promise.all([ROWS + 10, ROWS + 11, 5].map(uuidOf)));
  // AN UPDATE OF THE LIST COLUMN moves its row to the table's end (a delete and an insert): after the end is deleted
  // again, to a row id given again
  await build("public.orders", "id");
  await deleteEnd(245760);
  await w.run("CHECKPOINT");
  const before5 = await rowidOf(5);
  await write("public.orders", [`UPDATE public.orders SET tags = ['b', 'c'] WHERE id = ${key(5)}`], "");
  const moved = await rowidOf(5);
  assert.ok(moved !== before5 && moved < await covered() + 1n + 245760n, `the UPDATE moved the row (${before5} to ${moved})`);
  await lookups(await Promise.all([5, 6].map(uuidOf)));
  // DURING A BUILD: its snapshot taken, then the end deleted and its row ids given again before its swap — the build
  // covers only what nothing given again contradicts
  await build("public.orders", "id", async () => {
    await deleteEnd(200000);
    await w.run("CHECKPOINT");
    await write("public.orders", [`INSERT INTO public.orders VALUES (${key(ROWS + 20)}, 20, 'during', ['a'])`], `INSERT INTO orders VALUES (${key(ROWS + 20)}, 20, 'during')`);
  });
  await lookups(await Promise.all([ROWS + 20, 5, 199_999].map(uuidOf)));
});

test("a table replaced whole is looked up in itself until its side table is built again", async () => {
  const l = await lookup();
  const w = store.writer;
  if (!built.has("public.orders")) await build("public.orders", "id");
  // the table written again in another order (a copy's or a compaction's swap): every row at another row id
  await w.run(`CREATE TABLE public.orders_next AS SELECT * FROM public.orders ORDER BY n DESC`);
  await w.run("BEGIN TRANSACTION");
  await w.run("DROP TABLE public.orders");
  await w.run("ALTER TABLE public.orders_next RENAME TO orders");
  await l.coverNothing(w, "public.orders");
  await w.run("COMMIT");
  const ks = await Promise.all([1, 2, 150_000, 199_998].map(uuidOf));
  // a plan made before the swap still routes: it reads the table itself whole (nothing is covered)
  await lookups(ks);
  await build("public.orders", "id");
  await lookups(ks);
});

test("a text key is routed by DuckDB's own equality", async () => {
  await build("public.codes", "code");
  const k = (await truth.query<{ k: string }>(`SELECT md5('777') AS k`)).rows[0]!.k;
  assert.ok(await same(`SELECT code, n FROM codes WHERE code = '${k}'`));
  assert.ok(await same(`SELECT code, n FROM codes WHERE code = $1`, [k]));
  assert.ok(await same(`SELECT code, n FROM codes WHERE code IN ('${k}', 'nope', '') ORDER BY n`));
  assert.ok(await same(`SELECT code, n FROM codes WHERE code = 'nope'`));
});

test("a table is given a side table by how scattered its key is in its row groups, never by its type", async () => {
  const l = await lookup();
  const w = store.writer;
  const n = 1_500_000;
  // a serial key appended in order; the same key after a heavy update load (rows in no order deleted and appended, as
  // the sync writes an update); a uuid
  await w.run(`CREATE TABLE public.serial_kept AS SELECT i AS id FROM range(${n}) r(i)`);
  await w.run(`CREATE TABLE public.serial_updated AS SELECT i AS id FROM range(${n}) r(i)`);
  await w.run("CHECKPOINT");
  for (let round = 0; round < 4; round++) {
    await w.run(`CREATE OR REPLACE TEMP TABLE moved AS SELECT id FROM public.serial_updated WHERE hash(id + ${round}) % 12 = 0`);
    await w.run("DELETE FROM public.serial_updated WHERE id IN (SELECT id FROM moved)");
    await w.run("INSERT INTO public.serial_updated SELECT id FROM moved ORDER BY hash(id)");
    await w.run("CHECKPOINT");
  }
  await w.run(`CREATE TABLE public.uuids AS SELECT md5(i::VARCHAR)::UUID AS id FROM range(${n}) r(i)`);
  await w.run("CHECKPOINT");
  const kept = await l.keySpread(w, "public", "serial_kept", "id", "BIGINT");
  const updated = await l.keySpread(w, "public", "serial_updated", "id", "BIGINT");
  const uuids = await l.keySpread(w, "public", "uuids", "id", "UUID");
  assert.ok(kept !== null && kept.perKey < 2, `an append-only serial key lies in one row group: ${JSON.stringify(kept)}`);
  assert.ok(!l.spreadWanted(kept));
  assert.ok(updated !== null && updated.perKey >= l.LOOKUP_MIN_ROW_GROUPS, `a heavily updated serial key is scattered: ${JSON.stringify(updated)}`);
  assert.ok(l.spreadWanted(updated));
  assert.ok(uuids !== null && uuids.perKey >= uuids.rowGroups - 1, `a uuid lies in every row group: ${JSON.stringify(uuids)}`);
  assert.ok(l.spreadWanted(uuids));
});

test("a table read through its view of its visible columns is routed as a derived table of them, under its name", async () => {
  const l = await lookup();
  const { parseSql } = await import("../src/api/postgres/parser.ts");
  const { deparseSync } = await import("pgsql-deparser");
  const w = store.writer;
  if (!built.has("public.orders")) await build("public.orders", "id");
  // the view a copy with a hidden column is read through by a `*` (src/duck/kept-route.ts VISIBLE_CATALOG), as made
  const db = (await w.runAndReadAll("SELECT current_database()")).getRowsJS()[0]![0] as string;
  await w.run("ATTACH IF NOT EXISTS ':memory:' AS __mason_visible");
  await w.run("CREATE SCHEMA IF NOT EXISTS __mason_visible.public");
  await w.run(`CREATE OR REPLACE VIEW __mason_visible.public.orders AS SELECT id, n, note FROM "${db}".public.orders`);
  const [a, b] = ((await w.runAndReadAll("SELECT id::VARCHAR FROM public.orders ORDER BY n LIMIT 2 OFFSET 100")).getRowsJS() as Array<[string]>).map(([k]) => k);
  const ctx = { lookups: new Map([["public.orders", { column: "id", columns: ["id", "n", "note"] }]]), relations: new Set(["public.orders"]), visible: "__mason_visible", own: "__mason_", parse: parseSql };
  for (const sql of [`SELECT * FROM __mason_visible.public.orders WHERE id = '${a}'`, `SELECT * FROM __mason_visible.public.orders WHERE n >= 0 AND id = '${a}'`,
    `SELECT o.n, o.note FROM __mason_visible.public.orders AS o WHERE o.id IN ('${a}', '${b}') AND o.n > 0 AND o.note IS NOT NULL ORDER BY o.n`]) {
    const tree = (await parseSql(sql)).stmts![0]!.stmt;
    assert.ok(await l.routeLookups(tree, ctx), `${sql}: routed`);
    const routed = deparseSync(tree as never, { pretty: false });
    assert.match(routed, /key_lookup:public\.orders/);
    assert.doesNotMatch(routed, /__mason_visible/, `${routed}: the view is read no more`);
    const rows = async (q: string): Promise<string> => JSON.stringify((await w.runAndReadAll(q)).getRowsJS(), (_k, v: unknown) => typeof v === "bigint" ? String(v) : v);
    assert.equal(await rows(routed), await rows(sql), routed);
    assert.notEqual(await rows(sql), "[]");
  }
  // a column named by the table's schema (which a derived table binds no more), and column aliases: left as they are
  for (const sql of [`SELECT public.orders.n FROM __mason_visible.public.orders WHERE id = '${a}'`, `SELECT x FROM __mason_visible.public.orders AS o(i, x) WHERE i = '${a}'`]) {
    assert.ok(!await l.routeLookups((await parseSql(sql)).stmts![0]!.stmt, ctx), `${sql}: not routed`);
  }
});

test("a bare name is the relation Postgres resolved it to, never the first schema whose table has a side table", async () => {
  await build("b.items", "id");
  if (!built.has("public.orders")) await build("public.orders", "id");
  const items = new Map(await Promise.all([10, 1500].map(async (i) => [i, `'${await uuidOf(i)}'`] as const)));
  const item = (i: number): string => items.get(i)!;
  const order = await uuidOf(700);
  const under = async (path: string, sql: string, values: unknown[] = []): Promise<boolean> => {
    await client.query(`SET search_path = ${path}`);
    await truth.query(`SET search_path = ${path}`);
    try { return await same(sql, values); }
    finally { await client.query("RESET search_path"); await truth.query("RESET search_path"); }
  };
  // the first schema's table has no side table, a later one's has
  for (const sql of [`SELECT id, n FROM items WHERE id = ${item(10)}`, `SELECT n FROM items WHERE id IN (${item(10)}, ${item(1500)}) ORDER BY n`]) {
    assert.ok(!await under("public, b", sql), `${sql}: public.items has no side table`);
    assert.ok(await under("b, public", sql), `${sql}: b.items has one`);
  }
  assert.ok(!await under("a, public", "SELECT count(*) FROM orders WHERE id = $1", [order]), "a.orders has no side table");
  assert.ok(!await under("a, public", `SELECT id, n FROM orders WHERE id IN ($1, '${await uuidOf(0)}')`, [order]), "nor by a list");
  assert.ok(await under("public, a", `SELECT id, n FROM orders WHERE id IN ($1, '${await uuidOf(0)}')`, [order]), "public.orders by a list");
  assert.ok(await under("public, a", "SELECT count(*) FROM orders WHERE id = $1", [order]), "public.orders has one");
  // a view of that name in an earlier schema
  assert.ok(!await under("v, b", `SELECT id, n FROM items WHERE id = ${item(10)}`), "v.items is a view");
  // qualified: the relation named, wherever the search path points
  assert.ok(await under("public", `SELECT id, n FROM b.items WHERE id = ${item(10)}`), "b.items, qualified");
  assert.ok(!await under("b", `SELECT id, n FROM public.items WHERE id = ${item(10)}`), "public.items, qualified");
  assert.ok(!await under("public", "SELECT count(*) FROM a.orders WHERE id = $1", [order]), "a.orders, qualified");
  assert.ok(!await under("public", `SELECT id, n FROM v.items WHERE id = ${item(10)}`), "v.items, qualified");
  // both of one name in the statement: the bare one is the search path's, and each is routed as it resolves
  assert.ok(await same(`SELECT n FROM b.items WHERE id = ${item(10)} UNION ALL SELECT n FROM public.items WHERE id = ${item(10)} ORDER BY 1`));
});

test("an empty table's side table is not due again at every check; one that covers none of its rows is", async () => {
  const l = await lookup();
  const w = store.writer;
  await w.run("CREATE TABLE public.empty_one (id UUID NOT NULL)");
  try {
    await build("public.empty_one", "id");
    assert.equal((await l.lookupTail(w, "public.empty_one", target("public.empty_one"), 0, 0))?.due, false, "empty: nothing to cover");
    await write("public.empty_one", ["INSERT INTO public.empty_one VALUES (md5('1')::UUID)"], "");
    assert.equal((await l.lookupTail(w, "public.empty_one", target("public.empty_one"), 1, 0.01))?.due, true, "a row it does not cover");
  } finally {
    await l.dropLookup(w, "public.empty_one");
    built.delete("public.empty_one");
    await w.run("DROP TABLE public.empty_one");
  }
});
