/**
 * ONE OF TWO TABLES WHOSE NAMES DIFFER ONLY IN CASE, REMOVED (issue 1071; src/duck/sync.ts `dropRemoved`, `forgetMissing`,
 * `catalogTypes`). A Mason before issue 1019 synced `orders` and `"Orders"` into ONE table of the synced data, each with
 * ledger rows of its own. Removing either entry, as a start after issue 1019 says to, dropped that one table, and the
 * kept entry's ledger still said it was synced: every poll of it failed, the catalog failed on it and started with no
 * table at all, so an unrelated table went unserved too, and a restart kept it so.
 *
 * Now the removal takes the kept entry's ledger with the table and syncs it again from the source, whole, said; a table
 * the ledger says is synced with no table under it is synced again whole at the open, and when the catalog meets it;
 * and one table the catalog cannot read never unserves another.
 *
 * The state an older Mason left is made here with the engine itself, which takes both names (the sources file's check
 * is issue 1019's, at `mason start`).
 *
 * What it needs: IT_POSTGRES_URL (any wal_level) and psql on PATH. It writes only inside databases it creates,
 * `it_casrm_<random>…`, and drops each at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import type { SyncEventInput } from "../../src/duck/events.ts";
import { parseSource } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";
const tag = `it_casrm_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-case-remove-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** a database of the test's own, dropped at the end whatever happens */
function database(suffix: string): string {
  const db = `${tag}_${suffix}`;
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  const u = new URL(adminUrl!);
  u.pathname = `/${db}`;
  return u.toString();
}

const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
const entry = (t: string, other: string): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows: 3, foreignKeys: [], columns: [col("id", "integer"), col(other, "text")] });
const LOWER = entry("orders", "b");
const UPPER = entry("Orders", "a");
const PLAIN = entry("plain", "v");
/** each table's rows as the source holds them, as `read` gives them */
const ROWS: Record<string, string> = { "public.orders": "1\tlower\n2\ttwo", "public.Orders": "1\tupper", "public.plain": "1\tp1\n2\tp2\n3\tp3" };

function seed(url: string): void {
  psql(url, `CREATE TABLE orders (id int PRIMARY KEY, b text); INSERT INTO orders VALUES (1, 'lower'), (2, 'two');
    CREATE TABLE "Orders" (id int PRIMARY KEY, a text); INSERT INTO "Orders" VALUES (1, 'upper');
    CREATE TABLE plain (id int PRIMARY KEY, v text); INSERT INTO plain VALUES (1, 'p1'), (2, 'p2'), (3, 'p3')`);
}

interface World {
  sync: Sync; logged: string[]; events: SyncEventInput[];
  read: (sql: string) => Promise<string>;
  until: (ok: () => boolean | Promise<boolean>, what: string, ms?: number) => Promise<void>;
  close: () => Promise<void>;
}

async function world(url: string, file: string): Promise<World> {
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const events: SyncEventInput[] = [];
  const store = await DuckStore.open(path.join(dir, file), (l) => logged.push(l), { memoryLimit: "256MB" });
  const sync = new Sync(store, parsed.source, parsed.source.database, (l) => logged.push(l), 3_600_000, "poll", null, { onEvent: (e) => { events.push(e); } });
  // read on a connection of the test's own: the sync's writer may be inside a transaction
  const reader = await store.instance.connect();
  const read = async (sql: string): Promise<string> => ((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 60_000): Promise<void> => {
    const t0 = Date.now();
    while (!await ok()) {
      if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms / 1000} s\n${logged.slice(-20).join("\n")}`);
      await sleep(50);
    }
  };
  await sync.open();
  return { sync, logged, events, read, until, close: async () => { reader.closeSync(); await sync.stop(); await store.close(); } };
}

/** a sync by hand of `source`, once its catch-up is over (a poll asked during it is refused, and says so) */
async function pollWhenFree(w: World, source: string): Promise<void> {
  await w.until(async () => {
    try { await w.sync.pollNow([source]); return true; }
    catch (e) { if (/caught up by one poll|being/.test((e as Error).message)) return false; throw e; }
  }, `a sync by hand of ${source}`);
}

const phase = (w: World, source: string): string | undefined => w.sync.state().find((s) => s.source === source)?.phase;
/** the tables the catalog serves, by their names as the source spells them */
const served = (w: World): string[] => w.sync.schema().tables.map((t) => `${t.schema}.${t.name}`).sort();
const rowsOf = async (w: World, t: AddedTable): Promise<string> => {
  try { return await w.read(`SELECT * FROM "public"."${t.table}" ORDER BY id`); } catch (e) { return `(${(e as Error).message.split("\n")[0]})`; }
};

/** a table served with its own rows: in the catalog, synced, and holding what the source holds */
async function servedAsSource(w: World, t: AddedTable, what: string): Promise<void> {
  await w.until(async () => phase(w, t.source) === "copied" && served(w).includes(t.source) && await rowsOf(w, t) === ROWS[t.source], `${what}: ${t.source} served with its own rows`);
}

/** both entries synced into one table of the synced data, as a Mason before issue 1019 left them, beside plain */
async function oldStore(url: string, file: string): Promise<World> {
  const w = await world(url, file);
  await w.sync.setTables([LOWER, UPPER, PLAIN]);
  await w.until(() => [LOWER, UPPER, PLAIN].every((t) => phase(w, t.source) === "copied"), "the three first syncs");
  assert.equal(await w.read("SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'public' AND lower(table_name) = 'orders'"), "1", "the synced data holds one table for both names");
  return w;
}

for (const [removed, kept] of [[UPPER, LOWER], [LOWER, UPPER]] as const) {
  test(`removing ${removed.source} beside ${kept.source} syncs ${kept.source} again whole, never leaves it or plain unserved, and a restart serves both (issue 1071)`, { skip, timeout: 300_000 }, async () => {
    const url = database(removed.table === "Orders" ? "keeplower" : "keepupper");
    seed(url);
    const file = `${kept.table}.db`;
    const w = await oldStore(url, file);
    try {
      const from = w.logged.length;
      await w.sync.setTables([kept, PLAIN]);
      await servedAsSource(w, kept, "after the removal");
      await servedAsSource(w, PLAIN, "after the removal");
      assert.deepEqual(served(w), [kept.source, "public.plain"].sort());
      const said = w.logged.slice(from).join("\n");
      assert.ok(w.logged.slice(from).includes(`${kept.source}: its synced data was the same table as ${removed.source}'s (the synced data holds names that differ only in case as one table), so it is dropped with ${removed.source}'s and synced again from the source, whole`), said);
      assert.ok(w.events.some((e) => e.kind === "sync_stopped" && e.table === kept.source), JSON.stringify(w.events));
      assert.equal(await w.read(`SELECT count(*) FROM _mason.copy_state WHERE source = '${removed.source}'`), "0", "no ledger row of the removed entry is left");
      // kept current: a change on the source reaches it at its next sync
      psql(url, `INSERT INTO "${kept.table}" VALUES (9, 'nine')`);
      await pollWhenFree(w, kept.source);
      assert.equal(await rowsOf(w, kept), `${ROWS[kept.source]}\n9\tnine`);
      psql(url, `DELETE FROM "${kept.table}" WHERE id = 9`);
      await pollWhenFree(w, kept.source);
    } finally { await w.close(); }

    // A RESTART serves both at once, from what is synced: nothing synced again, nothing said missing
    const again = await world(url, file);
    try {
      await again.sync.setTables([kept, PLAIN]);
      assert.deepEqual(served(again), [kept.source, "public.plain"].sort(), again.logged.join("\n"));
      assert.equal(await rowsOf(again, kept), ROWS[kept.source]);
      assert.equal(await rowsOf(again, PLAIN), ROWS["public.plain"]);
      assert.ok(!again.logged.some((l) => /missing|synced again|left out of the catalog/.test(l)), again.logged.join("\n"));
    } finally { await again.close(); }
  });
}

test("a store an older Mason left stuck (orders recorded as synced, no table under it) syncs orders again at its next start, and plain is served at once (issue 1071)", { skip, timeout: 300_000 }, async () => {
  const url = database("stuck");
  seed(url);
  const w = await world(url, "stuck.db");
  try {
    await w.sync.setTables([LOWER, PLAIN]);
    await servedAsSource(w, LOWER, "the first sync");
    await servedAsSource(w, PLAIN, "the first sync");
    // what the older Mason's drop of "Orders" left: orders' table gone, its ledger rows saying it is synced
    await w.read("DROP TABLE public.orders");
  } finally { await w.close(); }

  const again = await world(url, "stuck.db");
  try {
    assert.ok(again.logged.includes("public.orders: its synced data is missing (the record says it was synced, and no table is there), so it is synced again from the source, whole"), again.logged.join("\n"));
    await again.sync.setTables([LOWER, PLAIN]);
    // plain is served the moment the tables are set, never held behind orders
    assert.ok(served(again).includes("public.plain"), `plain served at once: ${served(again).join(", ")}\n${again.logged.join("\n")}`);
    await servedAsSource(again, LOWER, "after the stuck start");
    await servedAsSource(again, PLAIN, "after the stuck start");
  } finally { await again.close(); }
});

test("a synced table lost under a running sync never unserves the others: it is left out of the catalog, said, and synced again whole (issue 1071)", { skip, timeout: 300_000 }, async () => {
  const url = database("live");
  seed(url);
  const w = await world(url, "live.db");
  try {
    await w.sync.setTables([LOWER, PLAIN]);
    await servedAsSource(w, LOWER, "the first sync");
    await servedAsSource(w, PLAIN, "the first sync");
    const from = w.logged.length;
    await w.read("DROP TABLE public.orders");
    // the next rebuild of the catalog meets it
    await w.sync.setTables([LOWER, PLAIN]);
    assert.ok(served(w).includes("public.plain"), `plain still served: ${served(w).join(", ")}\n${w.logged.slice(from).join("\n")}`);
    await servedAsSource(w, LOWER, "after its table was lost");
    await servedAsSource(w, PLAIN, "after orders' table was lost");
    const said = w.logged.slice(from);
    assert.ok(said.some((l) => l.startsWith("public.orders is left out of the catalog, as its synced data could not be read (every other table is served): ")), said.join("\n"));
    assert.ok(said.includes("public.orders: its synced data is missing (the record says it was synced, and no table is there), so it is synced again from the source, whole"), said.join("\n"));
  } finally { await w.close(); }
});
