/**
 * A LOOKUP BY A SCATTERED KEY, AGAINST A REAL POSTGRES, AS THE SYNC KEEPS IT (issue 1148; src/duck/key-lookup.ts,
 * src/duck/sync.ts `buildLookup`). A table whose uuid key lies in every row group is given a side table after its first
 * sync, and every lookup by its key is held to the source's own answer through what the sync writes: the poll's and
 * the stream's inserts, updates (a delete and an insert), deletes and a key deleted and inserted again, an UPDATE of an
 * array column (DuckDB writes it as a delete and an insert), a rebuild of the side table, and a compaction that gives
 * every row a new row id. A serial key appended in order is not given one.
 *
 * What it needs: IT_POSTGRES_URL (the streamed test: wal_level = logical), psql on PATH, DuckDB's postgres extension.
 * It writes only inside databases it creates, `it_dlookup_<random>*`, and drops them and its slots.
 */
import { test, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable, type CompactOptions, type LookupOptions } from "../../src/duck/sync.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { checkpoint } from "./checkpoint.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_dlookup_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-dlookup-"));
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skipStream = !adminUrl ? "IT_POSTGRES_URL is not set" : !logical ? "IT_POSTGRES_URL's server has no wal_level = logical" : false;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };

afterEach(async () => {
  if (!adminUrl || !logical) return;
  const held = (): string => psql(adminUrl, `SELECT count(*) FILTER (WHERE active) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%'`);
  for (const until = Date.now() + 10_000; held() !== "0" && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  if (logical) psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

async function tablesOf(source: Source, names: readonly string[]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return names.map((n) => { const t = facts.tables.find((x) => x.source === n); if (!t) throw new Error(`no table ${n}`); return t; });
  } finally { c.pg.close(); }
}

const ROWS = 300_000;
/** a database with `orders` (a uuid key, scattered; an unconstrained numeric, which the synced data holds a hidden
 *  column of each value's scale beside, so a `*` reads its view of its visible columns) and `events` (a serial key,
 *  appended in order) */
function aSource(name: string): { db: string; url: string; source: Source } {
  const db = `${tag}_${name}`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE orders (id uuid PRIMARY KEY, n int, note text, tags text[], amount numeric DEFAULT 2.50); INSERT INTO orders SELECT md5(g::text)::uuid, g, 'note ' || g, ARRAY['a'], g * 0.10 FROM generate_series(1, ${ROWS}) g;
    CREATE TABLE events (id bigserial PRIMARY KEY, n int); INSERT INTO events (n) SELECT g FROM generate_series(1, ${ROWS}) g`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return { db, url, source: parsed.source };
}
const key = (i: number): string => `md5('${i}')::uuid`;

// a table of three row groups counts as scattered here (its key lies in all three), and a rebuild is due at any tail:
// the rule is the test's, the measure, the build, the writes and the route the sync's
const LOOKUP: LookupOptions = { minRowGroups: 2, tailShare: 0 };
const COMPACT: CompactOptions = { firstCheckMs: 3_600_000, checkMs: 3_600_000, wasteShare: 0.0001, minWasteBlocks: 0 };

/** the lookups by key held to the source, each routed through the side table; `keys` by their generator's number */
async function lookups(sync: Sync, store: DuckStore, db: string, url: string, keys: readonly number[], when: string): Promise<void> {
  const server = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, null, undefined, () => sync.state(), sync.kept.enabled ? sync.kept : undefined) });
  const mason = new pg.Client({ host: "127.0.0.1", port: server.port, database: db, user: "test", password: "x" });
  const source = new pg.Client({ connectionString: url });
  await mason.connect();
  await source.connect();
  const text = { getTypeParser: () => (v: string) => v };
  try {
    const ids = keys.map((i) => psql(url, `SELECT ${key(i)}`));
    const asks: Array<[string, unknown[]]> = [
      ...ids.flatMap((k): Array<[string, unknown[]]> => [[`SELECT id, n, note, tags FROM orders WHERE id = '${k}'`, []], [`SELECT id, n, note FROM orders WHERE id = $1`, [k]],
        [`SELECT * FROM orders WHERE id = $1`, [k]], [`SELECT o.*, o.amount * 2 AS twice FROM orders o WHERE o.n > -5 AND o.id = '${k}'`, []]]),
      [`SELECT id, n FROM orders WHERE id IN (${ids.map((k) => `'${k}'`).join(", ")}) ORDER BY n, id`, []],
    ];
    for (const [sql, values] of asks) {
      const want = (await source.query({ text: sql, values, rowMode: "array", types: text })).rows;
      const got = (await mason.query({ text: sql, values, rowMode: "array", types: text })).rows;
      assert.deepEqual(got, want, `${sql} ${JSON.stringify(values)} (${when})`);
      const plan = (await mason.query({ text: `EXPLAIN (VERBOSE, COSTS off) ${sql}`, values })).rows as Array<{ "QUERY PLAN": string }>;
      assert.ok(plan.some((r) => r["QUERY PLAN"].includes("key_lookup:public.orders")), `${sql}: routed through the side table (${when})\n${plan.map((r) => r["QUERY PLAN"]).join("\n")}`);
    }
    // the table whole, as text: nothing the side table routes differs from the table itself
    const all = "SELECT id, n, note, tags, amount FROM orders ORDER BY id";
    assert.deepEqual((await mason.query({ text: all, rowMode: "array", types: text })).rows, (await source.query({ text: all, rowMode: "array", types: text })).rows, `orders whole (${when})`);
  } finally {
    await mason.end();
    await source.end();
    await server.close();
  }
}

/** the changes an app makes, on the source: an insert, an update, a delete, a key deleted and inserted again, an
 *  update of the array column, and a run of updates scattered across the table */
function changes(url: string, round: number): void {
  const base = ROWS * 10 * round;
  psql(url, `INSERT INTO orders VALUES (${key(base + 1)}, -1, 'new', ARRAY['n']);
    UPDATE orders SET n = n + 1000000, note = 'updated ${round}' WHERE id = ${key(7)};
    DELETE FROM orders WHERE id = ${key(12345)};
    DELETE FROM orders WHERE id = ${key(1)}; INSERT INTO orders VALUES (${key(1)}, ${round}, 'again', ARRAY['x']);
    UPDATE orders SET tags = ARRAY['b', '${round}'] WHERE id = ${key(5)};
    UPDATE orders SET note = 'churn ${round}' WHERE n % 97 = ${round}`);
}
const KEYS = [1, 5, 7, 12345, 299_999];

/** the rebuilds the sync queued: awaited */
const settled = async (sync: Sync): Promise<void> => { await (sync as unknown as { rebuilding: Promise<void> | null }).rebuilding; };

/**
 * ROW IDS GIVEN AGAIN: the side table built again, then every row of the synced table's last row group deleted on the
 * source and synced (`synced`: the poll, or the stream caught up), a checkpoint dropping those row groups, and new rows
 * synced: they take the dropped rows' row ids, below what the side table covered, and are found all the same, as what
 * it covers was lowered in their write's transaction.
 */
async function givenAgain(sync: Sync, store: DuckStore, db: string, url: string, synced: () => Promise<void>): Promise<void> {
  await sync.checkCompaction();
  await settled(sync);
  const one = async (sql: string): Promise<bigint> => (await store.writer.runAndReadAll(sql)).getRowsJS()[0]![0] as bigint;
  const covered = await one("SELECT covered FROM _mason.key_lookups WHERE source = 'public.orders'");
  // where its last row group begins: the rows of the row groups before it (a compaction's pieces leave them uneven)
  const last = await one("WITH g AS (SELECT row_group_id, max(count) AS n FROM pragma_storage_info('public.orders') GROUP BY row_group_id) SELECT sum(n) FROM g WHERE row_group_id < (SELECT max(row_group_id) FROM g)");
  const groups = await one("SELECT max(row_group_id) FROM pragma_storage_info('public.orders')");
  const end = ((await store.writer.runAndReadAll(`SELECT id::VARCHAR FROM public.orders WHERE rowid >= ${last}`)).getRowsJS() as Array<[string]>).map(([k]) => k);
  assert.ok(end.length > 0 && covered > last, `${end.length} row(s) in its last row group from ${last}, ${covered} covered`);
  const writer = new pg.Client({ connectionString: url });
  await writer.connect();
  try { await writer.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [end]); } finally { await writer.end(); }
  await synced();
  // the checkpoint that drops the deleted row groups, on the writer's turn (between two of the stream's batches), taken
  // again while another transaction holds those rows back
  for (const until = Date.now() + 30_000; ;) {
    await checkpoint(sync, store);
    if (await one("SELECT max(row_group_id) FROM pragma_storage_info('public.orders')") < groups) break;
    if (Date.now() > until) throw new Error("the checkpoint dropped none of the table's end in 30 s");
    await new Promise((r) => setTimeout(r, 100));
  }
  psql(url, `INSERT INTO orders SELECT md5(g::text)::uuid, g, 'given again', ARRAY['r'] FROM generate_series(${ROWS * 40}, ${ROWS * 40 + 9}) g`);
  await synced();
  const taken = await one(`SELECT rowid FROM public.orders WHERE id = ${key(ROWS * 40)}`);
  assert.ok(taken < covered, `a new row took a row id the side table covered (${taken} < ${covered})`);
  await lookups(sync, store, db, url, [...KEYS, ROWS * 40, ROWS * 40 + 9], "row ids given again");
}

test("a polled table's lookups by key go through its side table, equal to the source, through the poll's writes, a rebuild and a compaction", { skip: "quarantined: #1192" }, async () => {
  const { db, url, source } = aSource("poll");
  const tables = (await tablesOf(source, ["public.orders", "public.events"])).map((t) => ({ ...t, sync: { mode: "poll", every: "1h", seconds: 3600 } as const }));
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "poll.db"), (l) => logged.push(l), { memoryLimit: "256MB" });
  const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { lookup: LOOKUP, compact: COMPACT });
  try {
    await sync.open();
    await sync.setTables(tables);
    await sync.once();
    const orders = sync.state().find((s) => s.source === "public.orders")!, events = sync.state().find((s) => s.source === "public.events")!;
    assert.equal(orders.lookup?.column, "id", `the scattered uuid key has a side table after its first sync\n${logged.slice(-10).join("\n")}`);
    assert.ok((orders.lookup?.perKey ?? 0) >= 2, JSON.stringify(orders.lookup));
    assert.equal(events.lookup?.column ?? null, null, `a serial key appended in order has none: ${JSON.stringify(events.lookup)}`);
    assert.ok((events.lookup?.perKey ?? 99) < 2, JSON.stringify(events.lookup));
    await lookups(sync, store, db, url, KEYS, "the first sync");
    for (let round = 1; round <= 2; round++) {
      changes(url, round);
      await sync.pollNow(["public.orders"]);
      await checkpoint(sync, store);
      await lookups(sync, store, db, url, [...KEYS, ROWS * 10 * round + 1], `poll round ${round}`);
    }
    // THE SIDE TABLE BUILT AGAIN (its tail is due), then the table COMPACTED (every row a new row id) and its side
    // table built again over it
    const before = sync.state().find((s) => s.source === "public.orders")!.lookup!.builtAt;
    await sync.checkCompaction();
    await settled(sync);
    assert.ok(logged.some((l) => l.startsWith("compacted public.orders")), `compacted\n${logged.slice(-10).join("\n")}`);
    const after = sync.state().find((s) => s.source === "public.orders")!.lookup!;
    assert.ok(after.column === "id" && after.builtAt !== before, `built again after the compaction: ${JSON.stringify(after)}`);
    await lookups(sync, store, db, url, [...KEYS, ROWS * 10 + 1, ROWS * 20 + 1], "after a rebuild and a compaction");
    changes(url, 3);
    await sync.pollNow(["public.orders"]);
    await lookups(sync, store, db, url, [...KEYS, ROWS * 30 + 1], "a poll after the compaction");
    await givenAgain(sync, store, db, url, () => sync.pollNow(["public.orders"]).then(() => undefined));
  } finally { await sync.stop(); await store.close(); }
});

test("a streamed table's lookups by key go through its side table, equal to the source, through the stream's writes", { skip: skipStream }, async () => {
  const { db, url, source } = aSource("stream");
  const tables = (await tablesOf(source, ["public.orders"])).map((t) => ({ ...t, sync: { mode: "replication" } as const }));
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "stream.db"), (l) => logged.push(l), { memoryLimit: "256MB" });
  const sync = new Sync(store, source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_s`, publication: `${tag}_s`, owned: true }, { lookup: LOOKUP, compact: COMPACT });
  try {
    await sync.open();
    await sync.setTables(tables);
    await sync.once();
    for (const until = Date.now() + 60_000; sync.state()[0]?.lookup?.column !== "id";) {
      if (Date.now() > until) throw new Error(`no side table built\n${logged.slice(-12).join("\n")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let round = 1; round <= 2; round++) {
      changes(url, round);
      await sync.caughtUp(60_000);
      await lookups(sync, store, db, url, [...KEYS, ROWS * 10 * round + 1], `stream round ${round}`);
    }
    await givenAgain(sync, store, db, url, () => sync.caughtUp(60_000));
  } finally { await sync.stop(); await store.close(); }
});
