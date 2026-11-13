/**
 * A SYNCED TABLE COMPACTED BY MASON ITSELF, AGAINST A REAL POSTGRES (issue 851; src/duck/sync.ts `compact`,
 * src/duck/compact.ts). The checkpoint merges no row groups (issue 371), so a table the poll or the stream writes by key
 * keeps its dead rows and a row group per checkpoint; the sync's check finds it due (here at a low threshold) and
 * rewrites it from the synced data alone. A polled table churned through many polls and checkpoints stays within the
 * bound and equal to the source; a streamed table's changes that arrive WHILE it is compacted are spilled beside it
 * and applied after its swap, never lost; a compaction stopped half way keeps the table as it was, and the next start
 * catches it up by one poll.
 *
 * What it needs: IT_POSTGRES_URL (the streamed tests: wal_level = logical), psql on PATH, DuckDB's postgres
 * extension. It writes only inside databases it creates, `it_dcompact_<random>*`, and drops them and its slots.
 */
import { test, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable, type CompactOptions } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_dcompact_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-dcompact-"));
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skip = !adminUrl ? "IT_POSTGRES_URL is not set" : false;
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

async function tableOf(source: Source, name: string): Promise<AddedTable> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const t = (await readSourceFacts(c.pg)).tables.find((x) => x.source === name);
    if (!t) throw new Error(`no table ${name}`);
    return t;
  } finally { c.pg.close(); }
}

const rowsOf = async (store: DuckStore, sql: string): Promise<string> =>
  ((await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd();
const one = async (store: DuckStore, sql: string): Promise<number> => Number((await store.writer.runAndReadAll(sql)).getRowsJS()[0]![0]);

/** a database with `t` (id, v, n): `rows` rows */
function aSource(name: string, rows: number): { db: string; url: string; source: Source } {
  const db = `${tag}_${name}`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE t (id bigint PRIMARY KEY, v text, n int); INSERT INTO t SELECT g, md5(g::text), 0 FROM generate_series(1, ${rows}) g`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return { db, url, source: parsed.source };
}

// the threshold low and the check by hand: the rule is the test's, the rewrite and the swap the sync's
const LOW: CompactOptions = { firstCheckMs: 3_600_000, checkMs: 3_600_000, wasteShare: 0.3, minWasteBlocks: 1 };
/** waits until the stream has kept `n` changes aside for the table being compacted: `caughtUp` waits for them to be
 *  applied, which the held compaction never lets happen (issue 904) */
async function keptAside(store: DuckStore, n: number, logged: readonly string[]): Promise<void> {
  for (const until = Date.now() + 30_000; await one(store, "SELECT count(*) FROM _mason.compact_held") < n;) {
    if (Date.now() > until) throw new Error(`the stream did not keep ${n} change(s) aside in 30 s\n${logged.slice(-12).join("\n")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const same = async (store: DuckStore, url: string, step: string): Promise<void> =>
  assert.equal(await rowsOf(store, "SELECT id, v, n FROM public.t ORDER BY 1"), psql(url, "SELECT id, v, n FROM t ORDER BY 1"), `public.t after ${step}`);

test("a polled table churned through many polls and checkpoints: compacted from the synced data, within the bound, equal to the source", { skip }, async () => {
  const { db, url, source } = aSource("poll", 20_000);
  const T = { ...await tableOf(source, "public.t"), sync: { mode: "poll", every: "1s", seconds: 1 } as const };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "poll.db"), (l) => logged.push(l), { memoryLimit: "128MB" });
  const sync = new Sync(store, source, db, (l) => logged.push(l), 1_000, "poll", null, { compact: LOW });
  try {
    await sync.open();
    await sync.setTables([T]);
    await sync.once();
    await same(store, url, "the first sync");
    let most = 0, wrote = 0;
    const live = (r: number): number => 20_000 + r * 50;
    for (let r = 1; r <= 12; r++) {
      // a tenth of the rows updated, scattered, and a few new ones: ONE poll writes them by key (a poll reads again every
      // row past the database's oldest open transaction, so on a busy server it writes more: counted, not assumed)
      psql(url, `UPDATE t SET n = ${r}, v = md5(id::text || '${r}') WHERE (id * 7 + ${r}) % 10 = 0; INSERT INTO t SELECT g, md5(g::text), ${r} FROM generate_series(${20_000 + r * 50 - 49}, ${20_000 + r * 50}) g`);
      const polled = await sync.pollNow(["public.t"]);
      wrote = Math.max(wrote, polled.tables[0]!.changed + polled.tables[0]!.deleted);
      // the checkpoint DuckDB takes at 16 MiB of log, and at every stop
      await store.writer.run("CHECKPOINT");
      // what a scan reads: its stored rows, the deleted ones too — held to the threshold (0.3 of its space) and one
      // round's writes past it, before the check that compacts it
      const stored = await one(store, "SELECT estimated_size FROM duckdb_tables() WHERE table_name = 't'");
      most = Math.max(most, stored);
      assert.ok(stored <= live(r) / 0.7 + 2 * wrote, `round ${r}: ${stored} rows stored for ${live(r)} live and ${wrote} written a round\n${logged.filter((l) => /compact/.test(l)).join("\n")}`);
      await sync.checkCompaction();
      await (sync as unknown as { rebuilding: Promise<void> | null }).rebuilding;
      await same(store, url, `round ${r}`);
    }
    const compacted = logged.filter((l) => l.startsWith("compacted public.t in "));
    assert.ok(compacted.length >= 2, `compacted again and again:\n${logged.slice(-20).join("\n")}`);
    // without the compaction, 12 rounds of a tenth leave 2.2 times its live rows, growing
    assert.ok(most < 2.2 * live(12) || wrote > 5_000, `stored rows at most ${most} for ${live(12)} live`);
    const st = sync.state()[0]!;
    assert.ok(st.compaction?.at, JSON.stringify(st.compaction));
    assert.equal(st.error, null);
    assert.equal(st.rows, live(12));
    assert.equal(await one(store, "SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%mason_compact'"), 0, "no side table left");
  } finally { await sync.stop(); await store.close(); }
});

test("a streamed table's changes while it is compacted are spilled and applied after its swap, never lost", { skip: skipStream }, async () => {
  const { db, url, source } = aSource("stream", 20_000);
  const T = { ...await tableOf(source, "public.t"), sync: { mode: "replication" } as const };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "stream.db"), (l) => logged.push(l), { memoryLimit: "128MB" });
  // THE HOLD (as `heldCopy` holds a first sync): the compaction's first piece waits until the test releases it
  let release: () => void = () => undefined, holding = false;
  const held = new Promise<void>((r) => { release = r; });
  let reachedNow: () => void = () => undefined;
  const reached = new Promise<void>((r) => { reachedNow = r; });
  const sync = new Sync(store, source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_s`, publication: `${tag}_s`, owned: true },
    { compact: { ...LOW, beforePiece: async () => { if (!holding) { holding = true; reachedNow(); await held; } } } });
  try {
    await sync.open();
    await sync.setTables([T]);
    await sync.once();
    await sync.caughtUp();
    await same(store, url, "the first sync");
    // churned: half its rows written again by the stream, then a checkpoint
    psql(url, "UPDATE t SET n = 1 WHERE id % 2 = 0");
    await sync.caughtUp();
    await store.writer.run("CHECKPOINT");
    await sync.checkCompaction();
    await reached;
    assert.equal(sync.state()[0]!.rebuilding, "compact");
    const before = sync.state()[0]!;
    // CHANGES WHILE IT IS COMPACTED: an update, a delete, an insert — the stream holds them for the table
    psql(url, "UPDATE t SET n = 2, v = 'during' WHERE id <= 100; DELETE FROM t WHERE id BETWEEN 101 AND 150; INSERT INTO t VALUES (99999, 'new', 3)");
    await keptAside(store, 151, logged);
    assert.equal(await one(store, "SELECT count(*) FROM public.t WHERE v = 'during'"), 0, "spilled, not written under the compaction");
    assert.equal(await one(store, "SELECT count(*) FROM _mason.compact_held"), 151, "beside it: 100 updated, 50 deleted, 1 inserted");
    // NEVER SAID CURRENT PAST WHAT IT SERVES (issue 904): the batch that kept its changes aside moves neither its last sync
    // nor its kept time, its part in the stream says it is compacted, and caughtUp waits for what was kept aside
    const during = sync.state()[0]!;
    assert.equal(during.synced?.at, before.synced?.at, "its last sync is the one before its changes were kept aside");
    assert.ok(during.kept?.by === "replication" && during.kept.state === "compacting", JSON.stringify(during.kept));
    assert.equal(during.kept.syncedAt, before.kept?.by === "replication" ? before.kept.syncedAt : null, "kept current as of the moment its changes began to be kept aside");
    const part = (await sync.streamStatus())?.tables.find((x) => x.table === "public.t");
    assert.deepEqual([part?.state, part?.compacting], ["compacting", { held: 151 }]);
    await assert.rejects(sync.caughtUp(1_500), /public\.t \(being compacted/, "caughtUp waits for the changes kept aside");
    release();
    await sync.caughtUp();
    // right after caughtUp, with no wait for the compaction to end: every change is in the table
    await same(store, url, "the changes spilled during its compaction");
    const after = sync.state()[0]!;
    assert.ok(after.synced !== undefined && after.synced.by === "stream" && after.synced.at > before.synced!.at, `current as of the stream's position once applied: ${JSON.stringify(after.synced)}`);
    assert.ok(after.kept?.by === "replication" && after.kept.state === "streamed", JSON.stringify(after.kept));
    assert.ok(logged.some((l) => l.startsWith("compacted public.t in ")), logged.slice(-12).join("\n"));
    assert.equal(await one(store, "SELECT count(*) FROM _mason.catch_up"), 0, "its mark removed once its spilled changes are applied");
    assert.equal(await one(store, "SELECT count(*) FROM _mason.compact_held"), 0, "the spill applied and gone");
    // and the stream goes on writing it
    psql(url, "UPDATE t SET n = 4 WHERE id = 1");
    await sync.caughtUp();
    await same(store, url, "a change after it");
  } finally { release(); await sync.stop(); await store.close(); }
});

test("a compaction stopped half way: the side table gone, the table as it was, caught up by one poll at the next start and equal to the source", { skip: skipStream }, async () => {
  const { db, url, source } = aSource("stop", 20_000);
  const T = { ...await tableOf(source, "public.t"), sync: { mode: "replication" } as const };
  const logged: string[] = [];
  const file = path.join(dir, "stop.db");
  let store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "128MB" });
  let release: () => void = () => undefined, holding = false;
  const held = new Promise<void>((r) => { release = r; });
  let reachedNow: () => void = () => undefined;
  const reached = new Promise<void>((r) => { reachedNow = r; });
  const names = { slot: `${tag}_t`, publication: `${tag}_t`, owned: true };
  let sync = new Sync(store, source, db, (l) => logged.push(l), 1_000, "replication", names,
    { compact: { ...LOW, beforePiece: async () => { if (!holding) { holding = true; reachedNow(); await held; } } } });
  try {
    await sync.open();
    await sync.setTables([T]);
    await sync.once();
    await sync.caughtUp();
    psql(url, "UPDATE t SET n = 1 WHERE id % 2 = 0");
    await sync.caughtUp();
    await store.writer.run("CHECKPOINT");
    await sync.checkCompaction();
    await reached;
    psql(url, "UPDATE t SET n = 5, v = 'held' WHERE id <= 10");
    await keptAside(store, 10, logged);
    // stopped while the compaction is held: its piece never starts; what was spilled is not applied at the stop (which
    // must not wait for it), and the mark stands
    const stopping = sync.stop();
    release();
    await stopping;
    assert.ok(logged.some((l) => l.startsWith("compaction of public.t stopped: Mason is stopping")), logged.slice(-12).join("\n"));
    // what was kept aside is not in the table: it is said to wait for its catch-up, never current (issue 904)
    assert.equal(sync.state()[0]!.behind, "after its compaction was cut short");
    assert.equal(await one(store, "SELECT count(*) FROM public.t WHERE v = 'held'"), 0, "the table as it was");
    assert.equal(await rowsOf(store, "SELECT why FROM _mason.catch_up WHERE source = 'public.t'"), "after its compaction was cut short", "marked, so the next start catches it up");
    await store.close();
    store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "128MB" });
    sync = new Sync(store, source, db, (l) => logged.push(l), 1_000, "replication", names, { compact: LOW });
    await sync.open();
    await sync.setTables([T]);
    await sync.once();
    await sync.caughtUp();
    await same(store, url, "a restart after a compaction stopped");
    assert.ok(logged.some((l) => l.startsWith("caught up public.t by one poll after its compaction was cut short")), logged.slice(-12).join("\n"));
    assert.equal(await one(store, "SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%mason_compact'"), 0, "no side table left");
  } finally { release(); await sync.stop(); await store.close(); }
});
