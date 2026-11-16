/**
 * A TABLE REMOVED WHILE ITS SYNC RUNS (issue 1034; src/duck/sync.ts `cutShort`): its first sync, its catch-up or a sync
 * by hand stops at once. The chunks in flight roll back, every backend it held on the source is free, what it read is
 * dropped, and the rebuild queue moves on to the next table within seconds. Before, a removed table's first sync ran to
 * its end (hours, for a large one) while every table queued behind it waited, and the source scanned a table nobody
 * wanted.
 *
 * The read is held IN THE SOURCE: a session of the test's own holds `ACCESS EXCLUSIVE` on the table, so each chunk's
 * SELECT waits on Postgres, as a slow scan would, until something cancels it. Without the cut the queue never moves
 * while the lock is held, so each bound below fails at once rather than racing a copy's speed.
 *
 * What it needs: IT_POSTGRES_URL and psql on PATH. It writes only inside databases it creates, `it_rm_<random>…`, and
 * drops each at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, SOURCE_APPLICATION_NAME, type AddedTable, type ChunkEvent } from "../../src/duck/sync.ts";
import type { SyncEventInput } from "../../src/duck/events.ts";
import { parseSource } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";
const tag = `it_rm_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-remove-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** what `p` settles to within `ms`, else the words "not within …": a wait that never ends fails the test instead */
async function within<T>(p: Promise<T>, ms: number): Promise<T | string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((r) => { timer = setTimeout(() => r(`not within ${ms / 1000} s`), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/** a database of the test's own, dropped at the end whatever happens */
function database(suffix: string): string {
  const db = `${tag}_${suffix}`;
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  const u = new URL(adminUrl!);
  u.pathname = `/${db}`;
  return u.toString();
}

/** waits until `table`'s rows are older than every snapshot's xmin on the cluster: else a copy reads none of them and
 *  leaves all to its catch-up (duck-poll.itest.ts `rowsOlderThanEverySnapshot`) */
async function rowsOlderThanEverySnapshot(url: string, table: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (psql(url, `SELECT (SELECT max(xmin::text::bigint) FROM ${table}) < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`) !== "t") {
    if (Date.now() > deadline) throw new Error(`a transaction on the test cluster has been open since before ${table} was written, for 2 minutes`);
    await sleep(200);
  }
}

/**
 * A LOCK ON THE SOURCE TABLE, HELD BY A SESSION OF THE TEST'S OWN until `release()`: every read of the table waits on
 * Postgres meanwhile. `take()` resolves once Postgres granted it.
 */
function sourceLock(url: string, table: string): { take: () => Promise<void>; release: () => void } {
  const name = `it-lock-${tag}`;
  let child: ChildProcess | null = null;
  return {
    take: async () => {
      child = spawn("psql", ["-X", "-q", url, "-c", `BEGIN; LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(600)`],
        { env: { ...process.env, PGAPPNAME: name }, stdio: "ignore" });
      const deadline = Date.now() + 60_000;
      while (psql(url, `SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = '${table}' AND l.mode = 'AccessExclusiveLock' AND l.granted`) !== "1") {
        if (Date.now() > deadline) throw new Error(`the test's lock on ${table} was not granted within 60 s`);
        await sleep(20);
      }
    },
    release: () => {
      if (child === null) return;
      psql(url, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${name}'`);
      child = null;
    },
  };
}

/** Mason's backends on the source still busy with big: a query of it running or waiting, or a transaction open that
 *  holds or waits for a lock on it */
const busyBackends = (url: string): string =>
  psql(url, `SELECT string_agg(state || ' ' || coalesce(wait_event_type, '-') || ': ' || left(query, 80), '; ') FROM pg_stat_activity ` +
    `WHERE datname = current_database() AND application_name = '${SOURCE_APPLICATION_NAME}' AND state <> 'idle' AND pid <> pg_backend_pid() ` +
    `AND (query LIKE '%"big"%' OR pid IN (SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'big'))`);

const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
const table = (t: string, rows: number): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows, foreignKeys: [], columns: [col("id", "integer"), col("v", "text")] });
const ROWS = 60_000;
const BIG = table("big", ROWS);
const SMALL = table("small", 2);

function seed(url: string): void {
  psql(url, `CREATE TABLE small (id int PRIMARY KEY, v text); INSERT INTO small VALUES (1, 'a'), (2, 'b'); ` +
    `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, ${ROWS}) g`);
}

interface World {
  sync: Sync; store: DuckStore; logged: string[]; events: SyncEventInput[];
  read: (sql: string) => Promise<string>;
  until: (ok: () => boolean | Promise<boolean>, what: string, ms?: number) => Promise<number>;
  close: () => Promise<void>;
}

async function world(url: string, file: string, onChunk: (e: ChunkEvent) => Promise<void>, copyParallel = 3): Promise<World> {
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const events: SyncEventInput[] = [];
  const store = await DuckStore.open(path.join(dir, file), (l) => logged.push(l), { memoryLimit: "256MB" });
  const sync = new Sync(store, parsed.source, parsed.source.database, (l) => logged.push(l), 3_600_000, "poll", null,
    { copyChunkRows: 5_000, copyParallel, onChunk, onEvent: (e) => { events.push(e); } });
  // read on a connection of the test's own: the sync's writer may be inside a transaction
  const reader = await store.instance.connect();
  const read = async (sql: string): Promise<string> => ((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 60_000): Promise<number> => {
    const t0 = Date.now();
    while (!await ok()) {
      if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms / 1000} s\n${logged.slice(-15).join("\n")}`);
      await sleep(20);
    }
    return Date.now() - t0;
  };
  await sync.open();
  return { sync, store, logged, events, read, until, close: async () => { reader.closeSync(); await sync.stop(); await store.close(); } };
}

/** nothing of public.big is left in the synced data: its table, its side table, its ledger rows */
async function nothingOfBig(w: World): Promise<void> {
  assert.equal(await w.read("SELECT string_agg(table_name, ',') FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'public' AND table_name LIKE 'big%'"), "", `no table and no side table of big is left\n${w.logged.slice(-12).join("\n")}`);
  for (const ledger of ["copy_state", "poll_state", "catch_up", "copy_progress", "copy_chunks"]) {
    assert.equal(await w.read(`SELECT count(*) FROM _mason.${ledger} WHERE source = 'public.big'`), "0", `no ${ledger} row of big is left\n${w.logged.slice(-20).join("\n")}`);
  }
  assert.equal(w.sync.state().some((s) => s.source === "public.big"), false, "the sync holds no state of big");
}

test("a table removed during its first sync stops it at once: its reads on the source cancelled, what it read dropped, and the next table's first sync starts", { skip }, async () => {
  const url = database("first");
  seed(url);
  await rowsOlderThanEverySnapshot(url, "big");
  const lock = sourceLock(url, "big");
  // once big's first chunk committed, the source holds every later read of it
  let locked: Promise<void> | null = null;
  const onChunk = async (e: ChunkEvent): Promise<void> => { if (e.source === "public.big" && e.phase === "committed") await (locked ??= lock.take()); };
  const w = await world(url, "first.db", onChunk);
  try {
    void w.sync.setTables([BIG]);
    // big's readers wait on the source, each one backend; small is added behind it, and waits for the queue
    await w.until(() => /Lock/.test(busyBackends(url)), "big's readers wait on the source");
    void w.sync.setTables([BIG, SMALL]);
    await sleep(500);
    assert.equal(w.sync.state().find((s) => s.source === "public.small")?.phase, "waiting", "small waits behind big's first sync");
    const from = w.logged.length;
    // REMOVED: the queue moves on within seconds, the lock still held
    void w.sync.setTables([SMALL]);
    const ms = await w.until(() => w.sync.state().find((s) => s.source === "public.small")?.phase === "copied", "small's first sync, after big was removed", 15_000);
    const said = w.logged.slice(from).join("\n");
    assert.ok(ms < 10_000, `small synced ${ms} ms after big's removal\n${said}`);
    assert.equal(await w.read("SELECT count(*) FROM public.small"), "2");
    await w.until(() => w.logged.some((l) => l.startsWith("dropped public.big's synced data")), "big dropped", 10_000);
    await nothingOfBig(w);
    // nothing is left reading big on the source: every backend its chunks held is cancelled or idle
    assert.equal(busyBackends(url), "", "no backend of Mason's is busy on the source");
    // said as a stop, never a failure or a retry
    assert.ok(w.logged.slice(from).some((l) => l === "public.big: its first sync stopped, as the table was removed: what it had read is dropped"), said);
    assert.ok(!/failed|tried again/.test(w.logged.slice(from).join("\n")), said);
    const stopped = w.events.filter((e) => e.table === "public.big");
    assert.deepEqual(stopped.map((e) => e.kind), ["sync_stopped"], JSON.stringify(stopped));
  } finally { lock.release(); await w.close(); }
});

test("a table removed between two chunks of its first sync takes no further chunk, and the queue moves on", { skip }, async () => {
  const url = database("between");
  seed(url);
  await rowsOlderThanEverySnapshot(url, "big");
  let w: World | null = null;
  let removedAt: number | null = null;
  const chunks: ChunkEvent[] = [];
  // ONE reader: removed as its first chunk commits, so the next chunk would be taken right after
  const onChunk = async (e: ChunkEvent): Promise<void> => {
    if (e.source !== "public.big") return;
    chunks.push(e);
    if (e.phase === "committed" && removedAt === null) { removedAt = chunks.length; void w!.sync.setTables([SMALL]); }
  };
  w = await world(url, "between.db", onChunk, 1);
  try {
    void w.sync.setTables([BIG, SMALL]);
    // small first (smallest first), then big, removed between its chunks
    await w.until(() => w!.logged.some((l) => l.startsWith("dropped public.big's synced data")), "big dropped", 30_000);
    assert.ok(removedAt !== null);
    assert.deepEqual(chunks.slice(removedAt).filter((e) => e.phase === "committed"), [], "no chunk of big committed after its removal");
    assert.equal(w.sync.state().find((s) => s.source === "public.small")?.phase, "copied");
    await nothingOfBig(w);
    assert.ok(w.logged.some((l) => l === "public.big: its first sync stopped, as the table was removed: what it had read is dropped"), w.logged.join("\n"));
  } finally { await w.close(); }
});

test("a table removed during its first sync and added again before its sync stopped starts a fresh first sync, never the removed one's", { skip }, async () => {
  const url = database("again");
  seed(url);
  await rowsOlderThanEverySnapshot(url, "big");
  const lock = sourceLock(url, "big");
  let locked: Promise<void> | null = null;
  const onChunk = async (e: ChunkEvent): Promise<void> => { if (e.source === "public.big" && e.phase === "committed") await (locked ??= lock.take()); };
  const w = await world(url, "again.db", onChunk);
  try {
    void w.sync.setTables([BIG]);
    await w.until(() => /Lock/.test(busyBackends(url)), "big's readers wait on the source");
    assert.ok(Number(await w.read("SELECT count(*) FROM _mason.copy_chunks WHERE source = 'public.big'")) >= 1, "a chunk of big committed before the removal");
    const from = w.logged.length;
    // removed and added again at once: before its interrupted read has dropped anything
    void w.sync.setTables([]);
    void w.sync.setTables([BIG]);
    await w.until(() => w.logged.slice(from).some((l) => /^dropped what public\.big held when it was removed: it is added again/.test(l)), "the removed sync's partial data dropped", 15_000);
    // the source free, the new first sync reads it from page 0
    lock.release();
    await w.until(() => w.logged.slice(from).some((l) => /^caught up public\.big /.test(l)), "big's fresh first sync, caught up");
    const said = w.logged.slice(from).join("\n");
    assert.ok(!w.logged.slice(from).some((l) => /resuming|resumed at page/.test(l)), `never resumed from the removed sync's chunks\n${said}`);
    assert.ok(w.logged.slice(from).some((l) => /^syncing public\.big: /.test(l)), `a new first sync began\n${said}`);
    assert.equal(await w.read("SELECT count(*), count(DISTINCT id) FROM public.big"), `${ROWS}\t${ROWS}`, said);
    assert.equal(w.sync.state().find((s) => s.source === "public.big")?.phase, "copied");
    assert.ok(w.events.some((e) => e.table === "public.big" && e.kind === "sync_stopped"), JSON.stringify(w.events));
    assert.ok(!w.events.some((e) => e.table === "public.big" && /failed/.test(e.kind)), JSON.stringify(w.events));
  } finally { lock.release(); await w.close(); }
});

test("a table removed during its catch-up stops it at once: rolled back, dropped, and the queue moves on", { skip }, async () => {
  const url = database("catchup");
  seed(url);
  await rowsOlderThanEverySnapshot(url, "big");
  const lock = sourceLock(url, "big");
  // ONE reader: once its last chunk (open-ended) committed, the source holds the catch-up's read of big, which comes
  // before its swap (issue 1066: a whole read is served only together with its catch-up)
  const onChunk = async (e: ChunkEvent): Promise<void> => { if (e.source === "public.big" && e.phase === "committed" && e.end === null) await lock.take(); };
  const w = await world(url, "catchup.db", onChunk, 1);
  try {
    void w.sync.setTables([BIG]);
    await w.until(() => /Lock/.test(busyBackends(url)), "big's catch-up waits on the source");
    assert.ok(!w.logged.some((l) => /^synced public\.big: /.test(l)), `never served before its catch-up\n${w.logged.join("\n")}`);
    void w.sync.setTables([BIG, SMALL]);
    const from = w.logged.length;
    void w.sync.setTables([SMALL]);
    const ms = await w.until(() => w.sync.state().find((s) => s.source === "public.small")?.phase === "copied", "small's first sync, after big was removed", 15_000);
    const said = w.logged.slice(from).join("\n");
    assert.ok(ms < 10_000, `small synced ${ms} ms after big's removal\n${said}`);
    await w.until(() => w.logged.some((l) => l.startsWith("dropped public.big's synced data")), "big dropped", 10_000);
    await nothingOfBig(w);
    assert.equal(busyBackends(url), "", "no backend of Mason's is busy on the source");
    assert.ok(w.logged.slice(from).some((l) => l === "catch-up of public.big stopped: it is no longer added (rolled back)"), said);
    assert.ok(w.logged.slice(from).some((l) => l === "public.big: its first sync stopped, as the table was removed: what it had read is dropped"), said);
    assert.ok(!/failed|tried again/.test(said), said);
    // its catch-up is part of its first sync, which never ended: never swapped in, never said synced
    assert.deepEqual(w.events.filter((e) => e.table === "public.big").map((e) => e.kind), ["sync_stopped"]);
  } finally { lock.release(); await w.close(); }
});

test("a table removed during its sync by hand stops that sync at once: rolled back, answered as removed, and dropped", { skip }, async () => {
  const url = database("hand");
  seed(url);
  const lock = sourceLock(url, "big");
  const w = await world(url, "hand.db", async () => undefined);
  try {
    void w.sync.setTables([BIG, SMALL]);
    await w.sync.once();
    assert.deepEqual(w.sync.state().map((s) => [s.source, s.phase]).sort(), [["public.big", "copied"], ["public.small", "copied"]]);
    // its sync by hand waits on the source
    await lock.take();
    // its answer, held as a value: it settles while the test waits for other things
    const asked = w.sync.pollNow(["public.big"]).then((): unknown => "answered", (e: unknown) => e);
    await w.until(() => /Lock/.test(busyBackends(url)), "the sync by hand waits on the source");
    const from = w.logged.length;
    void w.sync.setTables([SMALL]);
    const t0 = Date.now();
    // bounded: without the cut it waits for the lock, so it fails here rather than hanging
    const answer = await within(asked, 10_000) as Error & { code?: string };
    assert.ok(answer instanceof Error && answer.code === "not_found" && answer.message === "public.big was removed while it was synced by hand, so that sync stopped (rolled back)", String(answer));
    assert.ok(Date.now() - t0 < 10_000, `answered ${Date.now() - t0} ms after the removal`);
    await w.until(() => w.logged.some((l) => l.startsWith("dropped public.big's synced data")), "big dropped", 10_000);
    await nothingOfBig(w);
    assert.equal(busyBackends(url), "", "no backend of Mason's is busy on the source");
    const said = w.logged.slice(from).join("\n");
    assert.ok(!/failed|tried again/.test(said), said);
    assert.deepEqual(w.events.filter((e) => e.table === "public.big" && e.kind !== "full_sync").map((e) => [e.kind, e.message]),
      [["sync_stopped", "its sync by hand stopped, as the table was removed (rolled back)"]]);
  } finally { lock.release(); await w.close(); }
});

test("a stop while a removed table's first sync is being stopped ends promptly, and the next start drops what it left", { skip }, async () => {
  const url = database("stop");
  seed(url);
  await rowsOlderThanEverySnapshot(url, "big");
  const lock = sourceLock(url, "big");
  let locked: Promise<void> | null = null;
  const onChunk = async (e: ChunkEvent): Promise<void> => { if (e.source === "public.big" && e.phase === "committed") await (locked ??= lock.take()); };
  let w = await world(url, "stop.db", onChunk);
  try {
    void w.sync.setTables([BIG]);
    await w.until(() => /Lock/.test(busyBackends(url)), "big's readers wait on the source");
    void w.sync.setTables([]);
    // bounded: a stop that waits for the source's lock fails here, and the lock is let go so it can end
    const stopped = await within(w.sync.stop().then(() => "stopped"), 10_000);
    if (stopped !== "stopped") lock.release();
    assert.equal(stopped, "stopped", `the stop did not end within 10 s\n${w.logged.join("\n")}`);
    assert.equal(busyBackends(url), "", "no backend of Mason's is busy on the source");
    await w.close();
    // the next start: big is not added, so whatever is left of it is dropped
    lock.release();
    w = await world(url, "stop.db", async () => undefined);
    void w.sync.setTables([]);
    await w.sync.once();
    await nothingOfBig(w);
  } finally { lock.release(); await w.close(); }
});
