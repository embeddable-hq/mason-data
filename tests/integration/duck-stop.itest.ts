/**
 * A STOP WHILE ONE OF MASON'S READS WAITS ON THE SOURCE (issue 1037; src/duck/sync.ts `stop`, `cancelBackends`): a first
 * sync's chunk, a catch-up or a poll waiting on a lock in the source Postgres. The stop ends within seconds, every read
 * rolls back, the first sync keeps its committed chunks to resume, and no backend of Mason's is left busy on the source.
 * Before, DuckDB's interrupt did not reach a query that waited on Postgres, so the stop waited until the lock was
 * released, which can be never.
 *
 * The read is held IN THE SOURCE: a session of the test's own holds `ACCESS EXCLUSIVE` on the table, so each read waits
 * on Postgres until something cancels it. Each stop is bounded, so a stop that waits for the lock fails the test rather
 * than hanging it.
 *
 * What it needs: IT_POSTGRES_URL and psql on PATH. It writes only inside databases it creates, `it_stop_<random>…`, and
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
import { parseSource } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";
const tag = `it_stop_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-stop-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** how long a stop may take while a read waits on the source: "within seconds" */
const STOP_BOUND_MS = 10_000;

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

/** A LOCK ON THE SOURCE TABLE, HELD BY A SESSION OF THE TEST'S OWN until `release()`: every read of the table waits on
 *  Postgres meanwhile. `take()` resolves once Postgres granted it. */
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

/** Mason's backends on the source that are not idle: a query running or waiting, or a transaction left open */
const busyBackends = (url: string): string =>
  psql(url, `SELECT string_agg(state || ' ' || coalesce(wait_event_type, '-') || ': ' || left(query, 80), '; ') FROM pg_stat_activity ` +
    `WHERE datname = current_database() AND application_name = '${SOURCE_APPLICATION_NAME}' AND state <> 'idle' AND pid <> pg_backend_pid()`);

/** Mason's backends waiting on a lock on the source */
const waitingOnLock = (url: string): number =>
  Number(psql(url, `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name = '${SOURCE_APPLICATION_NAME}' AND wait_event_type = 'Lock'`));

const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
const table = (t: string, rows: number): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows, foreignKeys: [], columns: [col("id", "integer"), col("v", "text")] });
const ROWS = 60_000;
const BIG = table("big", ROWS);

function seed(url: string): void {
  psql(url, `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, ${ROWS}) g`);
}

interface World {
  sync: Sync; store: DuckStore; logged: string[];
  read: (sql: string) => Promise<string>;
  until: (ok: () => boolean | Promise<boolean>, what: string, ms?: number) => Promise<number>;
  close: () => Promise<void>;
}

async function world(url: string, file: string, onChunk: (e: ChunkEvent) => Promise<void>, copyParallel = 3): Promise<World> {
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, file), (l) => logged.push(l), { memoryLimit: "256MB" });
  const sync = new Sync(store, parsed.source, parsed.source.database, (l) => logged.push(l), 3_600_000, "poll", null,
    { copyChunkRows: 5_000, copyParallel, onChunk });
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
  let closed = false;
  return { sync, store, logged, read, until, close: async () => {
    if (closed) return;
    closed = true;
    reader.closeSync(); await sync.stop(); await store.close();
  } };
}

/** the stop, bounded: one that waits for the source's lock fails here, and the lock is let go so it can end */
async function stopWithin(w: World, lock: { release: () => void }): Promise<number> {
  const t0 = Date.now();
  const stopped = await within(w.sync.stop().then(() => "stopped"), STOP_BOUND_MS);
  const ms = Date.now() - t0;
  if (stopped !== "stopped") lock.release();
  assert.equal(stopped, "stopped", `the stop did not end within ${STOP_BOUND_MS / 1000} s\n${w.logged.slice(-20).join("\n")}`);
  return ms;
}

/** nothing of Mason's is left busy on the source, the lock still held: each read was cancelled, never waited out */
async function nothingLeftOnSource(url: string): Promise<void> {
  // a cancelled backend's state turns to idle as its rollback ends, a moment after the stop
  const deadline = Date.now() + 5_000;
  while (busyBackends(url) !== "" && Date.now() < deadline) await sleep(50);
  assert.equal(busyBackends(url), "", "no backend of Mason's is busy on the source");
}

test("a stop while a first sync's chunks wait on the source ends within seconds, keeps the committed chunks, and leaves nothing on the source", { skip }, async () => {
  const url = database("chunk");
  seed(url);
  await rowsOlderThanEverySnapshot(url, "big");
  const lock = sourceLock(url, "big");
  // once big's first chunk committed, the source holds every later read of it
  let locked: Promise<void> | null = null;
  const onChunk = async (e: ChunkEvent): Promise<void> => { if (e.source === "public.big" && e.phase === "committed") await (locked ??= lock.take()); };
  let w = await world(url, "chunk.db", onChunk);
  try {
    void w.sync.setTables([BIG]);
    await w.until(() => waitingOnLock(url) >= 1, "big's readers wait on the source");
    const committed = Number(await w.read("SELECT count(*) FROM _mason.copy_chunks WHERE source = 'public.big'"));
    assert.ok(committed >= 1, "a chunk of big committed before the stop");
    const from = w.logged.length;
    await stopWithin(w, lock);
    await nothingLeftOnSource(url);
    const said = w.logged.slice(from).join("\n");
    assert.ok(!/failed|tried again/.test(said), `a stop, never a failure\n${said}`);
    // the stop names no URL and no password (a password's value is masked where words repeat it, never searched for as
    // a substring: a common one is a word of any log line)
    assert.ok(!said.includes(url) && !/password=(?!\*)/.test(said), "the stop's lines name no URL and no password");
    await w.close();
    // the committed chunks are kept: the next start resumes from them, the lock let go
    lock.release();
    w = await world(url, "chunk.db", async () => undefined);
    assert.equal(Number(await w.read("SELECT count(*) FROM _mason.copy_chunks WHERE source = 'public.big'")), committed, "the committed chunks are kept to resume");
    void w.sync.setTables([BIG]);
    await w.until(() => w.sync.state().find((s) => s.source === "public.big")?.phase === "copied", "big's first sync, resumed");
    assert.ok(w.logged.some((l) => /resum/.test(l)), `the first sync resumed\n${w.logged.join("\n")}`);
    assert.equal(await w.read("SELECT count(*), count(DISTINCT id) FROM public.big"), `${ROWS}\t${ROWS}`);
  } finally { lock.release(); await w.close(); }
});

test("a stop while a catch-up waits on the source ends within seconds and leaves nothing on the source", { skip }, async () => {
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
    await w.until(() => waitingOnLock(url) >= 1, "big's catch-up waits on the source");
    assert.ok(!w.logged.some((l) => /^synced public\.big: /.test(l)), `never served before its catch-up\n${w.logged.join("\n")}`);
    const from = w.logged.length;
    await stopWithin(w, lock);
    await nothingLeftOnSource(url);
    const said = w.logged.slice(from).join("\n");
    assert.ok(w.logged.slice(from).some((l) => l.startsWith("catch-up of public.big stopped: Mason is stopping")), said);
    assert.ok(!/failed|tried again/.test(said), `a stop, never a failure\n${said}`);
    assert.ok(!w.logged.some((l) => /^synced public\.big: /.test(l)), `not swapped in by the stop\n${said}`);
  } finally { lock.release(); await w.close(); }
});

test("a stop while a poll waits on the source ends within seconds and leaves nothing on the source", { skip }, async () => {
  const url = database("poll");
  seed(url);
  const lock = sourceLock(url, "big");
  const w = await world(url, "poll.db", async () => undefined);
  try {
    void w.sync.setTables([BIG]);
    await w.sync.once();
    assert.equal(w.sync.state().find((s) => s.source === "public.big")?.phase, "copied");
    await lock.take();
    // a sync by hand: the writer's poll, waiting on the source; its answer held as a value
    const asked = w.sync.pollNow(["public.big"]).then((): unknown => "answered", (e: unknown) => e);
    await w.until(() => waitingOnLock(url) >= 1, "the poll waits on the source");
    const from = w.logged.length;
    await stopWithin(w, lock);
    await nothingLeftOnSource(url);
    const answer = await within(asked, 5_000);
    assert.ok(answer instanceof Error && answer.message === "Mason is stopping", `the poll ended as stopped: ${String(answer)}`);
    const said = w.logged.slice(from).join("\n");
    assert.ok(!/failed|tried again/.test(said), `a stop, never a failure\n${said}`);
  } finally { lock.release(); await w.close(); }
});
