/**
 * A TABLE REWRITTEN ON THE DATABASE WHILE MASON READS IT IS NEVER SERVED EMPTY OR PARTIAL (issue 1025; src/duck/sync.ts
 * `heldFile`, `RewriteWait`, the poll's file check; src/cdc/poll.ts `fileFactsSql`).
 *
 * A rewrite (an ALTER TABLE that rewrites, a TRUNCATE and a load, VACUUM FULL, CLUSTER, pg_repack) gives the table a
 * new file and is not MVCC-safe: a snapshot taken before it commits reads the new file once its read gets the lock, and
 * an ALTER's or a TRUNCATE's rows there are invisible to it. And a whole sync keeps only the rows written before its
 * first snapshot's xmin, so a rewrite after the oldest transaction still open began leaves it none. Each test reads
 * DuckDB's count of the table all through (what the Postgres API serves) and holds it never under the source's:
 *  - a whole sync whose snapshot was taken while a rewrite waited for its lock starts over, never swapped in empty;
 *  - a whole sync of a table rewritten after an open transaction began waits for that transaction, the old data
 *    serving, and syncs once it ends (an ALTER TABLE on a sync again, a TRUNCATE and a load on a first sync); a VACUUM
 *    FULL or CLUSTER keeps each row's xmin, and syncs at once;
 *  - a poll whose snapshot was taken while a rewrite waited for its lock writes nothing, never deleting every row.
 * In poll and replication modes. What it needs: IT_POSTGRES_URL (replication's tests: wal_level = logical), psql on
 * PATH. It writes only inside databases it creates, `it_rewrite_<random>_*`, and drops them and its slots at the end.
 */
import { test, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, SOURCE_APPLICATION_NAME, type AddedTable, type ChunkEvent, type CopyState } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { syncStateOf } from "../../src/cli/readiness.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_rewrite_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-rewrite-"));
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skipPoll = adminUrl ? false : "IT_POSTGRES_URL is not set";
const skipStream = !adminUrl ? "IT_POSTGRES_URL is not set" : !logical ? "IT_POSTGRES_URL's server has no wal_level = logical" : false;
const ROWS = 3_000;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// no slot is left for the next test (CI keeps max_replication_slots = 10), verified gone
afterEach(async () => {
  if (!adminUrl || !logical) return;
  const active = (): string => psql(adminUrl, `SELECT count(*) FILTER (WHERE active) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%'`);
  for (const until = Date.now() + 10_000; active() !== "0" && Date.now() < until;) await sleep(100);
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  assert.equal(psql(adminUrl, `SELECT string_agg(slot_name, ', ') FROM pg_replication_slots WHERE slot_name LIKE '${tag}%'`), "", "every slot a test made is dropped after it");
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  if (logical) psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

/**
 * A TRANSACTION THE TEST HOLDS OPEN in a psql session of its own: `sql` run in it (its last statement's answer read
 * before this returns), then COMMIT at `commit()`. Closed in a `finally` (`end`), committed or not.
 */
async function openTransaction(url: string, sql: string): Promise<{ commit: () => Promise<void>; end: () => void; xid: () => string }> {
  const p: ChildProcessWithoutNullStreams = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url]);
  let out = "", err = "";
  p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>((r) => p.on("close", (code) => r(code)));
  p.stdin.write(`BEGIN;\n${sql};\nSELECT 'open-' || 'now';\n`);
  for (const until = Date.now() + 30_000; !out.includes("open-now");) {
    if (Date.now() > until || p.exitCode !== null) { p.kill(); throw new Error(`the held transaction did not begin: ${err.trim()}`); }
    await sleep(20);
  }
  return {
    commit: async () => {
      p.stdin.end("COMMIT;\n");
      const code = await exited;
      if (code !== 0) throw new Error(`the held transaction did not commit: ${err.trim()}`);
    },
    end: () => { if (p.exitCode === null) p.kill(); },
    // its id, when `sql` was `SELECT txid_current()` (its first line of output)
    xid: () => out.split("\n")[0]!.trim(),
  };
}

/** waits until a backend of the sync in `db` waits for a lock (the rewrite's, held open) */
async function syncWaitsForALock(db: string, logged: readonly string[]): Promise<void> {
  const sql = `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = '${db}' AND a.application_name = '${SOURCE_APPLICATION_NAME}'`;
  for (const until = Date.now() + 60_000; psql(adminUrl!, sql) === "0";) {
    if (Date.now() > until) throw new Error(`the sync never waited for the rewrite's lock\n${logged.join("\n")}`);
    await sleep(20);
  }
}

/** A TRANSACTION OPEN ON THE TEST CLUSTER (another session's) holds every snapshot's xmin back, so a first sync of rows
 *  just written reads none (they are its catch-up's): waits until `table`'s rows are older than every snapshot's xmin */
async function rowsOlderThanEverySnapshot(url: string, table: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (psql(url, `SELECT (SELECT max(xmin::text::bigint) FROM ${table}) < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`) !== "t") {
    if (Date.now() > deadline) throw new Error(`a transaction on the test cluster has been open since before ${table} was written, for 2 minutes`);
    await sleep(200);
  }
}

/** the source's table as `mason start` reads it (preflight's catalog read) */
async function tableOf(source: Source, name: string): Promise<AddedTable> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const t = (await readSourceFacts(c.pg)).tables.find((x) => x.source === name);
    if (!t) throw new Error(`no table ${name}`);
    return t;
  } finally { c.pg.close(); }
}

type Mode = "poll" | "replication";
interface Fixture {
  db: string; url: string; store: DuckStore; sync: Sync; logged: string[]; table: AddedTable;
  /** the table with `w` too, read before any test holds a lock on it (the catalog's read waits for one) */
  whole: AddedTable;
  /** the least count of public.t DuckDB served since the watch began (null: the table was not there) */
  served: () => { least: number | null; reads: number };
  stop: () => Promise<void>;
}

/**
 * A DATABASE OF ITS OWN with `t` (ROWS rows: `id`, `v`, and `w`, which the first sync leaves out so that adding it syncs
 * the table again whole), its rows older than every snapshot, and a sync of it in `mode` — synced first unless `first`
 * is false. DuckDB's count of public.t is read every few ms on a connection of its own from then on (`served`).
 */
async function fixture(name: string, mode: Mode, o: { first?: boolean; onChunk?: (e: ChunkEvent) => Promise<void> } = {}): Promise<Fixture> {
  const db = `${tag}_${name}`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE t (id int PRIMARY KEY, v int, w int); INSERT INTO t SELECT g, g, g FROM generate_series(1, ${ROWS}) g`);
  await rowsOlderThanEverySnapshot(url, "t");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const whole = await tableOf(parsed.source, "public.t");
  const table = { ...whole, columns: whole.columns.filter((c) => c.name !== "w") };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, `${name}.db`), (l) => logged.push(l));
  const options = { rewriteRecheckMs: 300, copyChunkRows: 1_000, ...(o.onChunk ? { onChunk: o.onChunk } : {}) };
  const sync = mode === "poll" ? new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll", null, options)
    : new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_${name}`, publication: `${tag}_${name}`, owned: true }, options);
  await sync.open();
  // what the Postgres API serves of public.t: DuckDB's count, read on a connection of its own all through
  const reader = await store.instance.connect();
  let least: number | null = null, reads = 0, watching = true;
  const watch = (async () => {
    while (watching) {
      try {
        const n = Number((await reader.runAndReadAll("SELECT count(*) FROM public.t")).getRowsJS()[0]![0]);
        least = least === null ? n : Math.min(least, n);
        reads++;
      } catch (e) {
        // the table is not there before its first sync (a first sync's test): nothing served, so nothing to count
        if (!/does not exist/.test(String(e))) throw e;
      }
      await sleep(2);
    }
  })();
  if (o.first !== false) {
    await sync.setTables([table]);
    await sync.once();
    if (mode === "replication") await sync.caughtUp();
    const n = await store.writer.runAndReadAll("SELECT count(*) FROM public.t").then((r) => Number(r.getRowsJS()[0]![0]), (e: unknown) => String(e));
    assert.equal(n, ROWS, `the first sync\n${logged.join("\n")}`);
  }
  return {
    db, url, store, sync, logged, table, whole,
    served: () => ({ least, reads }),
    stop: async () => { watching = false; await watch; reader.closeSync(); await sync.stop(); await store.close(); },
  };
}

/** the table equal to the source, its every column the source's */
async function equalToSource(f: Fixture, columns: string): Promise<void> {
  const digest = `count(*) || ' ' || md5(string_agg(concat_ws(':', ${columns}), ',' ORDER BY id))`;
  assert.equal(String((await f.store.writer.runAndReadAll(`SELECT ${digest} FROM public.t`)).getRowsJS()[0]![0]), psql(f.url, `SELECT ${digest} FROM t`),
    `public.t differs from the source\n${f.logged.join("\n")}`);
}

/** syncs again until the table holds `columns` and equals the source (a transaction left open elsewhere on a shared
 *  test cluster may hold the sync back a while) */
async function syncedWith(f: Fixture, mode: Mode, columns: string): Promise<void> {
  for (const until = Date.now() + 90_000; ;) {
    await sleep(350);
    await f.sync.once();
    const st = f.sync.state().find((s) => s.source === "public.t");
    if (st?.phase === "copied" && st.error === null && st.behind === undefined && (st.syncedColumns ?? []).join(", ") === columns) break;
    if (Date.now() > until) throw new Error(`public.t was not synced with ${columns}\n${f.logged.join("\n")}`);
  }
  if (mode === "replication") await f.sync.caughtUp();
  await equalToSource(f, columns);
}

const emptied = (f: Fixture): string[] => f.logged.filter((l) => /^synced public\.t: 0 row\(s\)/.test(l));

for (const mode of ["poll", "replication"] as const) {
  const skip = mode === "poll" ? skipPoll : skipStream;

  // A REWRITE WAITING FOR ITS LOCK AS A WHOLE SYNC BEGINS: the sync's snapshot is taken before the rewrite commits, its
  // reads wait for the lock and then read the new file, whose rows that snapshot cannot see (the review of PR 995:
  // 0 rows swapped in, served about 6 s until the catch-up). The file it is held to is the one its snapshot sees, so it
  // starts over from a new snapshot, and the table serves its rows all through.
  test(`${mode}: a whole sync begun while a rewrite waits for its lock starts over, and the table is never served empty`, { skip }, async () => {
    const f = await fixture(`lock_${mode[0]}`, mode);
    let rewrite: Awaited<ReturnType<typeof openTransaction>> | null = null;
    try {
      // the ALTER rewrites the table (USING), and keeps its columns' types: only its file changes
      rewrite = await openTransaction(f.url, "ALTER TABLE t ALTER COLUMN v TYPE int USING v + 0");
      // w added: the table is synced again whole, and its reads wait for the ALTER
      // w added, as mason add adds it: its entry confirmed, so the column the first sync left out is synced again (src/duck/column-identity.ts)
      const whole = f.sync.setTables([f.whole], { confirmed: [{ table: "public.t", shape: f.whole.shape }] }).then(() => f.sync.once());
      await syncWaitsForALock(f.db, f.logged);
      await rewrite.commit();
      await whole;
      await syncedWith(f, mode, "id, v, w");
      const text = f.logged.join("\n");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      assert.ok(f.logged.some((l) => /^starting the sync of public\.t over, from its first page: the (source|database) rewrote public\.t /.test(l)), `started over, said\n${text}`);
      const served = f.served();
      assert.ok(served.reads > 0, "the count was read while it synced");
      assert.equal(served.least, ROWS, `served with ${served.least} rows at least, never fewer than the source's ${ROWS}\n${text}`);
    } finally {
      rewrite?.end();
      await f.stop();
    }
  });

  // A REWRITE AFTER AN OPEN TRANSACTION BEGAN: every row of the new file carries the rewrite's xmin, past the oldest
  // transaction still open, which every snapshot's xmin is held at, so a whole sync held to it reads none of them. It
  // waits for that transaction, said on the table's line, the old copy serving, and syncs once it ends.
  test(`${mode}: a table rewritten after a transaction still open began is synced again whole only once it ends, its old data served meanwhile`, { skip }, async () => {
    const f = await fixture(`open_${mode[0]}`, mode);
    let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
    try {
      // a transaction with an id, left open: every snapshot's xmin is held at it
      holder = await openTransaction(f.url, "SELECT txid_current()");
      psql(f.url, "ALTER TABLE t ALTER COLUMN v TYPE int USING v + 0");
      // w added, as mason add adds it: its entry confirmed, so the column the first sync left out is synced again (src/duck/column-identity.ts)
      await f.sync.setTables([f.whole], { confirmed: [{ table: "public.t", shape: f.whole.shape }] });
      await f.sync.once();
      await sleep(400);
      await f.sync.once();
      const text = f.logged.join("\n");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      const words = new RegExp(`^its sync waits for transaction ${holder.xid()} \\(pid \\d+ in pg_stat_activity\\) to end\\. It was open on the database before the table was rewritten \\(.*\\)\\. ` +
        "So a sync now would read none of its rows\\. Mason checks again every 300 ms\\. The synced data serves as it was until then\\.$");
      assert.equal(f.logged.filter((l) => l.startsWith("public.t: ") && words.test(l.slice("public.t: ".length))).length, 1, `said once, though checked again\n${text}`);
      // A WAIT, NEVER A FAILURE (issue 1066): no error on its line, its state waiting, its words the wait's
      const st = f.sync.state().find((s) => s.source === "public.t")!;
      assert.equal(st.phase, "copied", "it serves its copy");
      assert.equal(st.error, null, `no error: it only waits\n${text}`);
      assert.match(st.syncWaits?.why ?? "", words, "said on its line (mason status)");
      assert.equal(syncStateOf(st), "waiting", "mason status and the page say waiting");
      assert.equal(Number((await f.store.writer.runAndReadAll("SELECT count(*) FROM public.t")).getRowsJS()[0]![0]), ROWS, "its old data serves");
      await holder.commit();
      await syncedWith(f, mode, "id, v, w");
      const served = f.served();
      assert.equal(served.least, ROWS, `served with ${served.least} rows at least, never fewer than the source's ${ROWS}\n${f.logged.join("\n")}`);
    } finally {
      holder?.end();
      await f.stop();
    }
  });

  // THE SAME ON A FIRST SYNC, by a TRUNCATE and a load in one transaction (an app's nightly reload): never served empty;
  // the table is served once that transaction ends. A VACUUM FULL or a CLUSTER keeps each row's xmin: synced at once.
  test(`${mode}: a first sync of a table emptied and loaded again after a transaction still open began waits for it; a VACUUM FULL or CLUSTER does not`, { skip }, async () => {
    const f = await fixture(`first_${mode[0]}`, mode, { first: false });
    let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
    try {
      // and two tables whose first rows are gone after their rewrite (issue 1066: the check reads a sample of the rows a
      // scan meets first, so it must reach past pages emptied by deletes): rewritten by an ALTER, the sync waits; by a
      // CLUSTER, it syncs at once, as #1058's check of the whole table decided
      psql(f.url, "CREATE TABLE kept (id int PRIMARY KEY, v int); INSERT INTO kept SELECT g, g FROM generate_series(1, 500) g; " +
        "CREATE TABLE anchor (id int PRIMARY KEY); INSERT INTO anchor VALUES (1); " +
        `CREATE TABLE sparse_alter (id int PRIMARY KEY, v int); INSERT INTO sparse_alter SELECT g, g FROM generate_series(1, ${ROWS}) g; ` +
        `CREATE TABLE sparse_cluster (id int PRIMARY KEY, v int); INSERT INTO sparse_cluster SELECT g, g FROM generate_series(1, ${ROWS}) g`);
      await rowsOlderThanEverySnapshot(f.url, "kept");
      await rowsOlderThanEverySnapshot(f.url, "sparse_cluster");
      const source = parseSourceOf(f.url);
      const [kept, anchor] = [await tableOf(source, "public.kept"), await tableOf(source, "public.anchor")];
      const [sparseAlter, sparseCluster] = [await tableOf(source, "public.sparse_alter"), await tableOf(source, "public.sparse_cluster")];
      // another table synced first: in replication mode its first sync makes the slot, which waits for every
      // transaction with an id to end (the one held open below would hold it)
      await f.sync.setTables([anchor]);
      await f.sync.once();
      holder = await openTransaction(f.url, "SELECT txid_current()");
      psql(f.url, `BEGIN; TRUNCATE t; INSERT INTO t SELECT g, g, g FROM generate_series(1, ${ROWS}) g; COMMIT`);
      psql(f.url, "VACUUM FULL kept");
      psql(f.url, "CLUSTER kept USING kept_pkey");
      const front = Math.floor(ROWS * 0.8);
      psql(f.url, "ALTER TABLE sparse_alter ALTER COLUMN v TYPE int USING v + 0");
      psql(f.url, "CLUSTER sparse_cluster USING sparse_cluster_pkey");
      for (const s of ["sparse_alter", "sparse_cluster"]) {
        psql(f.url, `DELETE FROM ${s} WHERE id <= ${front}`);
        psql(f.url, `VACUUM ${s}`);
      }
      await f.sync.setTables([anchor, f.table, kept, sparseAlter, sparseCluster]);
      await f.sync.once();
      const text = f.logged.join("\n");
      assert.match(f.sync.state().find((s) => s.source === "public.sparse_alter")?.syncWaits?.why ?? "", /^its sync waits for transaction \d+ .* So a sync now would read none of its rows\./,
        `an ALTER's rows past pages emptied by deletes: it waits\n${text}`);
      assert.ok(f.logged.some((l) => new RegExp(`^synced public\\.sparse_cluster: ${ROWS - front} row\\(s\\)`).test(l)), `a CLUSTER's rows past pages emptied by deletes: synced at once\n${text}`);
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      assert.equal(f.served().reads, 0, "public.t is not served before its first sync");
      // A FIRST SYNC THAT WAITS IS WAITING, NEVER FAILED (issue 1066): `mason add t && mason wait` waits on, and exits 0
      // once it is synced
      const st = f.sync.state().find((s) => s.source === "public.t")!;
      assert.match(st.syncWaits?.why ?? "", new RegExp(`^its sync waits for transaction ${holder.xid()} \\(pid \\d+ in pg_stat_activity\\) to end\\. .* Mason checks again every 300 ms\\.$`), `said on its line\n${text}`);
      assert.deepEqual([st.phase, st.error, syncStateOf(st)], ["waiting", null, "waiting"], `a wait, not a failure\n${text}`);
      assert.ok(!f.logged.some((l) => /sync of public\.t failed/.test(l)), `never said as a failure\n${text}`);
      assert.ok(f.logged.some((l) => /^synced public\.kept: 500 row\(s\)/.test(l)), `a VACUUM FULL and a CLUSTER keep each row's xmin: synced at once, whole\n${text}`);
      await holder.commit();
      await syncedWith(f, mode, "id, v");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${f.logged.join("\n")}`);
      assert.equal(f.served().least, ROWS, "served whole from its first sync on");
    } finally {
      holder?.end();
      await f.stop();
    }
  });

  // A WHOLE SYNC IS SERVED ONLY ONCE IT IS WHOLE (issue 1066): a TRUNCATE, then a transaction that stays open, then the
  // reload committed. No rewrite happened after that transaction began, so nothing waits; and every row is past its
  // id, which every snapshot's xmin is held at, so the whole read's chunks keep none. The sync again was swapped in with
  // 0 rows and served so until its catch-up. Its catch-up runs into the side table first now: served whole at once,
  // the transaction still open, and never short meanwhile.
  test(`${mode}: a whole sync again of a table emptied, then loaded again after a transaction began that is still open, is served whole at once and never short (issue 1066)`, { skip }, async () => {
    const f = await fixture(`reload_${mode[0]}`, mode);
    let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
    try {
      psql(f.url, "TRUNCATE t");
      holder = await openTransaction(f.url, "SELECT txid_current()");
      psql(f.url, `INSERT INTO t SELECT g, g + 1, g FROM generate_series(1, ${ROWS + 500}) g`);
      // under replication the stream carries the source's own TRUNCATE to the table served, which the source then was:
      // its least count is the read's from here
      const before = f.served().least;
      await f.sync.setTables([f.whole]);
      await f.sync.once();
      const text = f.logged.join("\n");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      assert.ok(f.logged.some((l) => new RegExp(`^synced public\\.t: ${ROWS + 500} row\\(s\\), .* then the ${ROWS + 500} row\\(s\\) changed since its read began synced by one poll`).test(l)),
        `swapped in whole, the transaction still open\n${text}`);
      const st = f.sync.state().find((s) => s.source === "public.t")!;
      assert.deepEqual([st.phase, st.error, st.behind, st.syncWaits, st.rows], ["copied", null, undefined, undefined, ROWS + 500], `synced, caught up, nothing waits\n${text}`);
      await equalToSource(f, "id, v, w");
      if (mode === "poll") assert.equal(f.served().least, before, `served with ${f.served().least} rows at least, never fewer than before its whole read\n${text}`);
      await holder.commit();
      holder = null;
    } finally {
      holder?.end();
      await f.stop();
    }
  });

  // THE SAME ON A FIRST SYNC: the table is served first with every row, never 0 until its catch-up.
  test(`${mode}: a first sync of a table emptied, then loaded again after a transaction began that is still open, is served whole from its first read (issue 1066)`, { skip }, async () => {
    const f = await fixture(`reload_first_${mode[0]}`, mode, { first: false });
    let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
    try {
      psql(f.url, "CREATE TABLE anchor (id int PRIMARY KEY); INSERT INTO anchor VALUES (1)");
      const anchor = await tableOf(parseSourceOf(f.url), "public.anchor");
      // another table synced first: in replication mode its first sync makes the slot, which waits for every
      // transaction with an id to end (the one held open below would hold it)
      await f.sync.setTables([anchor]);
      await f.sync.once();
      psql(f.url, "TRUNCATE t");
      holder = await openTransaction(f.url, "SELECT txid_current()");
      psql(f.url, `INSERT INTO t SELECT g, g + 1, g FROM generate_series(1, ${ROWS + 500}) g`);
      await f.sync.setTables([anchor, f.table]);
      await f.sync.once();
      const text = f.logged.join("\n");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      assert.ok(f.logged.some((l) => new RegExp(`^synced public\\.t: ${ROWS + 500} row\\(s\\)`).test(l)), `swapped in whole, the transaction still open\n${text}`);
      await equalToSource(f, "id, v");
      assert.ok(f.served().reads > 0, "the count was read once it was served");
      assert.equal(f.served().least, ROWS + 500, `served whole from its first read\n${text}`);
      await holder.commit();
      holder = null;
    } finally {
      holder?.end();
      await f.stop();
    }
  });
}

// A SYNC THAT WAITS NAMES THE TRANSACTION IT WAITS FOR ONLY WHILE THAT IS OPEN (issue 1066): two transactions older than
// the rewrite, and the first ends. #1058's message kept naming the first, its id and its pid, which may be another
// session's by then; each check names the one open at that check.
test("poll: a whole sync that waits names the transaction it waits for only while it is open, never one that ended (issue 1066)", { skip: skipPoll }, async () => {
  const f = await fixture("holders", "poll");
  let first: Awaited<ReturnType<typeof openTransaction>> | null = null;
  let second: Awaited<ReturnType<typeof openTransaction>> | null = null;
  try {
    first = await openTransaction(f.url, "SELECT txid_current()");
    second = await openTransaction(f.url, "SELECT txid_current()");
    psql(f.url, "ALTER TABLE t ALTER COLUMN v TYPE int USING v + 0");
    await f.sync.setTables([f.whole]);
    await f.sync.once();
    const why = (): string => f.sync.state().find((s) => s.source === "public.t")?.syncWaits?.why ?? "";
    assert.match(why(), new RegExp(`^its sync waits for transaction ${first.xid()} \\(pid \\d+ in pg_stat_activity\\) to end\\.`), `the oldest open transaction, named\n${f.logged.join("\n")}`);
    const firstXid = first.xid();
    await first.commit();
    first = null;
    await sleep(400);
    await f.sync.once();
    const text = f.logged.join("\n");
    assert.doesNotMatch(why(), new RegExp(`transaction ${firstXid}\\b`), `never the transaction that ended\n${text}`);
    assert.match(why(), new RegExp(`^its sync waits for transaction ${second.xid()} \\(pid \\d+ in pg_stat_activity\\) to end\\.`), `the one open now\n${text}`);
    assert.ok(f.logged.some((l) => l.startsWith(`public.t: its sync waits for transaction ${second!.xid()} `)), `said again, with the new one\n${text}`);
    await second.commit();
    second = null;
    await syncedWith(f, "poll", "id, v, w");
  } finally {
    first?.end();
    second?.end();
    await f.stop();
  }
});

// A WAIT CLEARS ONLY ITS OWN ERROR (the review of PR 1084): a sync again whole that waits recorded `error: null`, so it
// erased any other error the table served carried — its stream's, a publication's gap, its poll's — for as long as it
// waited. It keeps them; an older Mason's wait, recorded as an error, is its own and is cleared.
test("poll: a sync again whole that waits keeps an error another flow recorded on its table, and clears a wait an older Mason recorded as one (issue 1066)", { skip: skipPoll }, async () => {
  const f = await fixture("own_error", "poll");
  let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
  try {
    // written into the ledger as the flow that owns it would (the sync's own state, never what `state()` derives)
    const hooks = f.sync as unknown as { record: (s: CopyState) => Promise<void>; states: Map<string, CopyState> };
    const own = (): CopyState => hooks.states.get("public.t")!;
    const now = (): CopyState => f.sync.state().find((s) => s.source === "public.t")!;
    const other = "its poll failed, and is tried again at the next one (the synced data serves as it was): connection reset";
    await hooks.record({ ...own(), error: other });
    holder = await openTransaction(f.url, "SELECT txid_current()");
    psql(f.url, "ALTER TABLE t ALTER COLUMN v TYPE int USING v + 0");
    await f.sync.setTables([f.whole]);
    await f.sync.once();
    assert.match(now().syncWaits?.why ?? "", /^its sync waits for transaction /, `it waits\n${f.logged.join("\n")}`);
    assert.equal(now().error, other, "the other flow's error is kept while it waits");
    // what #1058 recorded for a wait, read back from the ledger after an upgrade: the wait's own, so cleared
    await hooks.record({ ...own(), error: "the database rewrote public.t after a transaction that is still open on the database began (its file changed: …), so a sync now would read none of its rows. Its sync waits for that transaction 1 to end, and checks again every 30 s" });
    await sleep(400);
    await f.sync.once();
    assert.equal(now().error, null, "an older Mason's wait is the wait's own error");
    assert.equal(syncStateOf(now()), "waiting");
    await holder.commit();
    holder = null;
    await syncedWith(f, "poll", "id, v, w");
  } finally {
    holder?.end();
    await f.stop();
  }
});

// A SIDE TABLE'S CATCH-UP THAT FAILS NEVER LOSES WHAT THE STREAM HELD FOR A TABLE SERVED (the review of PR 1084): a
// sync again whole whose column change is reverted while it reads (issue 79) has its table back in the stream, served.
// Its side table's catch-up held the stream's changes, acknowledged as they were held; when that poll failed, they were
// dropped, and the table went on streamed, current by its line, short of them for good (a restart too: the slot was past
// them). Ended by the poll's own failure (a rewrite under it) and by its backend terminated, which also met changes
// decoded in the side table's columns written to the narrower table served. The table served is marked behind as its
// side table's catch-up begins, so one poll catches it up, and nothing decoded in the side's columns reaches it.
for (const ends of ["a rewrite under its read", "its backend terminated"] as const) {
  test(`replication: a sync again whole, its column change reverted while it reads and its side table's catch-up failing (${ends}), loses no change the stream held`, { skip: skipStream }, async () => {
    let revert = (): void => undefined;
    let armed = false;
    const f = await fixture(`revert_${ends === "a rewrite under its read" ? "rw" : "kill"}`, "replication", {
      // the column change reverted once its whole read has a chunk in: the table needs no sync again, and is streamed
      onChunk: async (e) => { if (armed && e.source === "public.t" && e.phase === "committed") { armed = false; revert(); } },
    });
    let locker: Awaited<ReturnType<typeof openTransaction>> | null = null;
    try {
      psql(f.url, "CREATE TABLE u (id int PRIMARY KEY, v int); INSERT INTO u VALUES (1, 1)");
      const u = await tableOf(parseSourceOf(f.url), "public.u");
      await f.sync.setTables([f.table, u]);
      await f.sync.once();
      await f.sync.caughtUp();
      revert = () => { void f.sync.setTables([f.table, u]); };
      const hooks = f.sync as unknown as { held: Map<string, { keys: Map<unknown, unknown> }>; poll: (lane: unknown, all: unknown, o?: { into?: unknown }) => Promise<unknown> };
      const poll = hooks.poll.bind(f.sync);
      let failing: Promise<void> | null = null;
      hooks.poll = async (lane, all, o = {}) => {
        if (o.into !== undefined && failing === null) {
          // changed while the side table's catch-up holds the table's changes, and decoded into what it holds
          psql(f.url, `UPDATE t SET v = v + 7 WHERE id % 3 = 0; DELETE FROM t WHERE id % 10 = 0; INSERT INTO t VALUES (${ROWS + 1}, 1, 1)`);
          for (const until = Date.now() + 30_000; (hooks.held.get("public.t")?.keys.size ?? 0) < 1201;) {
            if (Date.now() > until) throw new Error(`the stream never held the changes\n${f.logged.join("\n")}`);
            await sleep(50);
          }
          // the catch-up's read waits for a lock, then fails: under a rewrite, or its backend terminated
          locker = await openTransaction(f.url, ends === "a rewrite under its read" ? "ALTER TABLE t ALTER COLUMN v TYPE int USING v + 0" : "LOCK TABLE t IN ACCESS EXCLUSIVE MODE");
          const held = locker;
          failing = (async () => {
            await syncWaitsForALock(f.db, f.logged);
            if (ends === "a rewrite under its read") await held.commit();
            else {
              psql(adminUrl!, `SELECT pg_terminate_backend(a.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = '${f.db}' AND a.application_name = '${SOURCE_APPLICATION_NAME}'`);
              held.end();
            }
          })();
        }
        return poll(lane, all, o);
      };
      armed = true;
      await f.sync.setTables([f.whole, u]);
      await f.sync.once();
      await failing;
      // the stream goes on, past those changes, with another table's
      for (let i = 0; i < 3; i++) psql(f.url, "UPDATE u SET v = v + 1");
      // caught up by one poll from its own watermark (main's way too), however long it takes the passes to come to it
      for (const until = Date.now() + 60_000; Date.now() < until;) {
        await sleep(350);
        await f.sync.once();
        const st = f.sync.state().find((s) => s.source === "public.t");
        if (st?.behind === undefined && st?.error === null && st.kept?.by === "replication" && st.kept.state === "streamed") break;
      }
      await f.sync.caughtUp();
      const text = f.logged.join("\n");
      await equalToSource(f, "id, v");
      assert.ok(!/Cannot read properties|could not be applied/.test(text), `nothing decoded in the side table's columns was written to the table served\n${text}`);
    } finally {
      (locker as Awaited<ReturnType<typeof openTransaction>> | null)?.end();
      await f.stop();
    }
  });
}

// A REWRITE WAITING FOR ITS LOCK AS A POLL BEGINS: the poll's snapshot is taken before the TRUNCATE and its load commit,
// its read waits for the lock and then finds the new file, whose rows that snapshot cannot see — and its count found 0
// rows on the source and deleted every key the synced table held, served empty until the next poll. The poll writes
// nothing of it, said, and the next poll reads it again.
test("poll: a poll begun while a rewrite waits for its lock writes nothing, and the table is never served empty", { skip: skipPoll }, async () => {
  const f = await fixture("poll_lock", "poll");
  let rewrite: Awaited<ReturnType<typeof openTransaction>> | null = null;
  try {
    rewrite = await openTransaction(f.url, `TRUNCATE t; INSERT INTO t SELECT g, g, g FROM generate_series(1, ${ROWS}) g`);
    const polled = f.sync.once();
    await syncWaitsForALock(f.db, f.logged);
    await rewrite.commit();
    await polled;
    const text = f.logged.join("\n");
    assert.equal(Number((await f.store.writer.runAndReadAll("SELECT count(*) FROM public.t")).getRowsJS()[0]![0]), ROWS, `the poll deleted nothing\n${text}`);
    assert.ok(f.logged.some((l) => /^public\.t: the poll failed, and is tried again at the next one \(the synced data serves as it was\): .*the database rewrote public\.t while this poll read it /.test(l)), `said\n${text}`);
    await f.sync.once();
    await equalToSource(f, "id, v");
    assert.equal(f.sync.state().find((s) => s.source === "public.t")!.error, null, "current again");
    const served = f.served();
    assert.equal(served.least, ROWS, `served with ${served.least} rows at least, never fewer than the source's ${ROWS}\n${f.logged.join("\n")}`);
  } finally {
    rewrite?.end();
    await f.stop();
  }
});

/** the rows the source's sequential scans of `table` have read, from the statistics (`seq_tup_read`) */
const scanned = (url: string, table: string): number => Number(psql(url, `SELECT coalesce(seq_tup_read, 0) FROM pg_stat_user_tables WHERE relname = '${table}'`));

/** `scanned` once the sync's backends have reported their reads (a backend sends its statistics when it goes idle, at
 *  most every 10 s): it has moved from `before`, and stayed put for 1.5 s */
async function scannedSettled(url: string, table: string, before: number): Promise<number> {
  const deadline = Date.now() + 30_000;
  let now = scanned(url, table);
  while (now === before) {
    if (Date.now() > deadline) throw new Error(`the database never counted a read of ${table} (seq_tup_read stayed at ${before})`);
    await sleep(200);
    now = scanned(url, table);
  }
  for (;;) {
    await sleep(1_500);
    const again = scanned(url, table);
    if (again === now) return now;
    now = again;
  }
}

/** a first sync of `big` (BIG rows) over a fixture of its own in poll mode, its rows older than every snapshot */
const BIG = 20_000;
async function bigTable(name: string): Promise<{ f: Fixture; big: AddedTable }> {
  const f = await fixture(name, "poll", { first: false });
  psql(f.url, `CREATE TABLE big (id int PRIMARY KEY, v int); INSERT INTO big SELECT g, g FROM generate_series(1, ${BIG}) g`);
  await rowsOlderThanEverySnapshot(f.url, "big");
  // read before any test holds a lock on it (the catalog's read waits for one)
  return { f, big: await tableOf(parseSourceOf(f.url), "public.big") };
}

/** a first sync of `big` until it is synced, equal to the source in rows */
async function bigSynced(f: Fixture): Promise<void> {
  for (const until = Date.now() + 90_000; ;) {
    await f.sync.once();
    const st = f.sync.state().find((s) => s.source === "public.big");
    if (st?.phase === "copied" && st.error === null) break;
    if (Date.now() > until) throw new Error(`public.big was not synced\n${f.logged.join("\n")}`);
    await sleep(350);
  }
  assert.equal(Number((await f.store.writer.runAndReadAll("SELECT count(*) FROM public.big")).getRowsJS()[0]![0]), BIG, "synced whole");
}

// THE CHECK OF A REWRITTEN TABLE READS A SAMPLE, NEVER THE WHOLE TABLE (issue 1066): #1058's check of a table rewritten
// after an open transaction began read every row in one transaction, under AccessShareLock — minutes on a large table,
// with a migration's ALTER queued behind it and the application's queries behind the ALTER. It reads a few rows now, and
// decides as before: an ALTER wrote every row again, so the sync waits for the open transaction.
test("poll: the check of a table rewritten after a transaction still open began reads a sample of its rows, never the whole table", { skip: skipPoll }, async () => {
  const { f, big } = await bigTable("sample");
  let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
  try {
    holder = await openTransaction(f.url, "SELECT txid_current()");
    psql(f.url, "ALTER TABLE big ALTER COLUMN v TYPE int USING v + 0");
    // the ALTER's own read of the table, counted before the sync's
    let before = scanned(f.url, "big");
    for (;;) {
      await sleep(1_500);
      const again = scanned(f.url, "big");
      if (again === before) break;
      before = again;
    }
    await f.sync.setTables([big]);
    await f.sync.once();
    const text = f.logged.join("\n");
    assert.match(f.sync.state().find((s) => s.source === "public.big")?.syncWaits?.why ?? "", /^its sync waits for transaction \d+ .* So a sync now would read none of its rows\./, `it waits, as before\n${text}`);
    const read = (await scannedSettled(f.url, "big", before)) - before;
    assert.ok(read <= 1_000, `the check read ${read} of the table's ${BIG} rows: a sample of at most 1,000, never the whole table\n${text}`);
    await holder.commit();
    await bigSynced(f);
  } finally {
    holder?.end();
    await f.stop();
  }
});

// A CHECK QUEUED BEHIND ANOTHER SESSION'S LOCK GIVES UP SOON (issue 1066): a migration's ACCESS EXCLUSIVE lock held on
// the table; #1058's check waited behind it for as long as it was held (its transaction open, every ALTER after it
// queued behind it in turn). It stops at its lock_timeout now, says it could not tell, holds nothing on the database,
// and checks again later: once the lock and the open transaction are gone, the table syncs.
test("poll: the check of a rewritten table gives up soon behind another session's lock, holds nothing there, and syncs once it is gone", { skip: skipPoll }, async () => {
  const { f, big } = await bigTable("locked");
  let holder: Awaited<ReturnType<typeof openTransaction>> | null = null;
  let locker: Awaited<ReturnType<typeof openTransaction>> | null = null;
  try {
    holder = await openTransaction(f.url, "SELECT txid_current()");
    psql(f.url, "ALTER TABLE big ALTER COLUMN v TYPE int USING v + 0");
    locker = await openTransaction(f.url, "LOCK TABLE big IN ACCESS EXCLUSIVE MODE");
    await f.sync.setTables([big]);
    const started = Date.now();
    const pass = f.sync.once().then(() => "ended" as const);
    const ended = await Promise.race([pass, sleep(15_000).then(() => "waiting" as const)]);
    const text = f.logged.join("\n");
    assert.equal(ended, "ended", `the sync's pass ended while the lock was held, within 15 s (it waited ${Date.now() - started} ms)\n${text}`);
    assert.match(f.sync.state().find((s) => s.source === "public.big")?.syncWaits?.why ?? "", /^its sync waits for transaction \d+ .* A short read of its rows could not tell within \d+ s whether a sync now would read them\./,
      `said on its line\n${text}`);
    const waiting = psql(f.url, `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = '${f.db}' AND a.application_name = '${SOURCE_APPLICATION_NAME}' AND l.relation = 'big'::regclass`);
    assert.equal(waiting, "0", "no backend of the sync holds or waits for a lock on the table");
    await locker.commit();
    locker = null;
    await holder.commit();
    holder = null;
    await bigSynced(f);
  } finally {
    // the lock first, so a check still queued behind it (a regression) ends, and no ALTER or lock is left behind
    locker?.end();
    holder?.end();
    await f.stop();
  }
});

function parseSourceOf(url: string): Source {
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return parsed.source;
}
