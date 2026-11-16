/**
 * THE ESTIMATE'S INPUTS, READ FROM A REAL POSTGRES (issue 1075; src/cli/preflight.ts TABLES_SQL, src/duck/disk-fit.ts):
 * each table's size without its indexes and its TOAST's, and each column's average width and whether it can be stored
 * out of line — sizes and statistics alone, never a read of the table — for a plain table, a partitioned one (its
 * leaves'), and one never analysed (no width). Then a table synced by the real sync: the estimate from its catalog is at
 * or above what the synced table takes on disk, and within the ratio's reach of it.
 *
 * What it needs: IT_POSTGRES_URL, psql on PATH. It writes only inside the database it creates, `it_fit_<random>`, and
 * drops it at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type SourceFacts } from "../../src/cli/preflight.ts";
import { syncedDataBytes } from "../../src/duck/file-bytes.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const db = `it_fit_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (d: string): string => { const u = new URL(adminUrl!); u.pathname = `/${d}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-fit-"));
const skip = adminUrl === undefined ? "IT_POSTGRES_URL is not set" : false;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

async function facts(url: string): Promise<SourceFacts> {
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const c = await connectSource(parsed.source);
  if ("failure" in c) throw new Error(c.failure.message);
  try { return await readSourceFacts(c.pg); } finally { c.pg.close(); }
}

test("the catalog reads each table's size without indexes, its TOAST's, and each column's width and out-of-line storage — a partitioned table's over its leaves, a table never analysed with no width; the estimate holds against a real sync", { skip }, async () => {
  const url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  // Autovacuum is off on every table whose size the test compares (issue 1098). Its first vacuum after the bulk insert
  // creates the table's visibility map, and then its TOAST's, a page each. pg_table_size counts both. When it ran
  // between Mason's read and the test's, the two sizes differed by a page. A TOAST table takes its table's setting.
  psql(url, `CREATE TABLE orders (id bigint PRIMARY KEY, customer_id int, email text, status text, total numeric(12,2), created_at timestamptz, meta jsonb, doc text) WITH (autovacuum_enabled = false);
    ALTER TABLE orders ALTER COLUMN doc SET STORAGE EXTERNAL;
    INSERT INTO orders SELECT g, g % 2000, 'user' || (g % 2000) || '@example.com', (ARRAY['new','paid','shipped'])[1 + g % 3], round((g % 5000)::numeric / 7, 2),
      timestamptz '2026-01-01' + g * interval '1 minute', jsonb_build_object('source', (ARRAY['web','app'])[1 + g % 2]),
      CASE WHEN g % 50 = 0 THEN repeat(md5(g::text), 100) END FROM generate_series(1, 60000) g;
    CREATE TABLE ticks (id bigint, at date NOT NULL, v int, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
    CREATE TABLE ticks_a PARTITION OF ticks FOR VALUES FROM ('2026-01-01') TO ('2026-02-01') WITH (autovacuum_enabled = false);
    CREATE TABLE ticks_b PARTITION OF ticks FOR VALUES FROM ('2026-02-01') TO ('2026-03-01') WITH (autovacuum_enabled = false);
    INSERT INTO ticks SELECT g, date '2026-01-01' + (g % 59), g FROM generate_series(1, 20000) g;
    ANALYZE orders; ANALYZE ticks;
    CREATE TABLE fresh (id bigint PRIMARY KEY, note text); INSERT INTO fresh VALUES (1, 'a')`);
  const f = await facts(url);
  const orders = f.tables.find((t) => t.source === "public.orders")!;
  const [tableBytes, toastBytes] = psql(url, "SELECT pg_table_size('orders'), pg_total_relation_size((SELECT reltoastrelid FROM pg_class WHERE oid = 'orders'::regclass))").split("\t").map(Number);
  assert.deepEqual([orders.tableBytes, orders.toastBytes], [tableBytes, toastBytes]);
  assert.ok(orders.bytes > orders.tableBytes!, "its size with its primary key's index is the larger");
  assert.ok(toastBytes! > 0, "the out-of-line values are in its TOAST");
  const widths = Object.fromEntries(psql(url, "SELECT attname, avg_width FROM pg_stats WHERE tablename = 'orders'").split("\n").map((l) => l.split("\t")).map(([a, w]) => [a!, Number(w)]));
  assert.deepEqual(Object.fromEntries(orders.columns.map((c) => [c.name, c.width])), widths, "each column's width as ANALYZE measured it");
  assert.deepEqual(orders.columns.filter((c) => c.toastable).map((c) => c.name), ["email", "status", "total", "meta", "doc"], "the variable-length columns can be stored out of line");
  // a partitioned table: its leaves' sizes, and the widths ANALYZE measured over the whole tree
  const ticks = f.tables.find((t) => t.source === "public.ticks")!;
  assert.equal(ticks.tableBytes, Number(psql(url, "SELECT sum(pg_table_size(relid)) FROM pg_partition_tree('ticks') WHERE isleaf")));
  assert.deepEqual(ticks.columns.map((c) => [c.name, typeof c.width]), [["id", "number"], ["at", "number"], ["v", "number"]]);
  // never analysed: no width, so the estimate shares by column count
  assert.deepEqual(f.tables.find((t) => t.source === "public.fresh")!.columns.map((c) => c.width), [null, null]);

  // THE ESTIMATE AGAINST A REAL SYNC of orders, every column
  const { syncedEstimate } = await import("../../src/duck/disk-fit.ts");
  const estimate = syncedEstimate(orders, null);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const file = path.join(dir, "fit.db");
  const store = await DuckStore.open(file, () => {});
  const sync = new Sync(store, parsed.source, db, () => {}, 3_600_000, "poll");
  try {
    await sync.open();
    const before = syncedDataBytes(file) ?? 0;
    sync.setTables([orders]);
    await sync.once();
    await store.writer.run("CHECKPOINT");
    const synced = (syncedDataBytes(file) ?? 0) - before;
    assert.ok(synced > 0, "the table was synced");
    assert.ok(estimate >= synced && estimate <= synced * 6, `the estimate ${estimate} is at or above the ${synced} bytes the synced table takes, and within reach of it`);
    // fewer columns: a smaller estimate
    assert.ok(syncedEstimate(orders, ["id", "status"]) < estimate / 4);
  } finally { await sync.stop(); await store.close(); }
});
