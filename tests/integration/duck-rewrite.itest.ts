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
import { Sync, SOURCE_APPLICATION_NAME, type AddedTable } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";

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
async function openTransaction(url: string, sql: string): Promise<{ commit: () => Promise<void>; end: () => void }> {
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
async function fixture(name: string, mode: Mode, o: { first?: boolean } = {}): Promise<Fixture> {
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
  const options = { rewriteRecheckMs: 300, copyChunkRows: 1_000 };
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
      const whole = f.sync.setTables([f.whole]).then(() => f.sync.once());
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
      await f.sync.setTables([f.whole]);
      await f.sync.once();
      await sleep(400);
      await f.sync.once();
      const text = f.logged.join("\n");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      assert.equal(f.logged.filter((l) => /^sync of public\.t waits: the database rewrote public\.t after a transaction that is still open on the database began .*, so a sync now would read none of its rows\. Its sync waits for that transaction \d+ \(pid \d+ in pg_stat_activity\) to end, and checks again every 300 ms; the synced data serves as it was until then$/.test(l)).length, 1, `said once, though checked again\n${text}`);
      const st = f.sync.state().find((s) => s.source === "public.t")!;
      assert.equal(st.phase, "copied", "it serves its copy");
      assert.match(st.error ?? "", /^the database rewrote public\.t after a transaction that is still open/, "said on its line (mason status)");
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
      psql(f.url, "CREATE TABLE kept (id int PRIMARY KEY, v int); INSERT INTO kept SELECT g, g FROM generate_series(1, 500) g; " +
        "CREATE TABLE anchor (id int PRIMARY KEY); INSERT INTO anchor VALUES (1)");
      await rowsOlderThanEverySnapshot(f.url, "kept");
      const source = parseSourceOf(f.url);
      const [kept, anchor] = [await tableOf(source, "public.kept"), await tableOf(source, "public.anchor")];
      // another table synced first: in replication mode its first sync makes the slot, which waits for every
      // transaction with an id to end (the one held open below would hold it)
      await f.sync.setTables([anchor]);
      await f.sync.once();
      holder = await openTransaction(f.url, "SELECT txid_current()");
      psql(f.url, `BEGIN; TRUNCATE t; INSERT INTO t SELECT g, g, g FROM generate_series(1, ${ROWS}) g; COMMIT`);
      psql(f.url, "VACUUM FULL kept");
      psql(f.url, "CLUSTER kept USING kept_pkey");
      await f.sync.setTables([anchor, f.table, kept]);
      await f.sync.once();
      const text = f.logged.join("\n");
      assert.deepEqual(emptied(f), [], `never swapped in empty\n${text}`);
      assert.equal(f.served().reads, 0, "public.t is not served before its first sync");
      const st = f.sync.state().find((s) => s.source === "public.t")!;
      assert.match(st.error ?? "", /^the database rewrote public\.t after a transaction that is still open on the database began .* Its sync waits for that transaction \d+/, `said on its line\n${text}`);
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

function parseSourceOf(url: string): Source {
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return parsed.source;
}
