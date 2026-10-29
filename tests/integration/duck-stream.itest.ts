/**
 * THE DUCKDB COPY KEPT CURRENT BY LOGICAL REPLICATION, AGAINST A REAL POSTGRES (src/duck/stream.ts, src/duck/sync.ts
 * replication mode; `mason start --replication` on Mason).
 *
 * DuckDB's `<schema>.<table>` must equal the source after every kind of change an app makes, as the stream brings it: an
 * insert, an update, a delete, a primary-key change, an UPDATE that leaves a large (TOASTed) value unchanged, a savepoint,
 * a transaction open while others commit, a TRUNCATE, a restart (the slot resumes; nothing is copied again), a table
 * added while streaming, and a project that polled before (caught up by one poll, never copied again). Every type of
 * the copy arrives through the stream as the copy stores it: a table of them streamed is held equal, value for value,
 * to a fresh copy of it. A numeric wider than its copy's DECIMAL copies the table again, wider.
 *
 * What it needs: IT_POSTGRES_URL with wal_level = logical, psql on PATH, DuckDB's postgres extension. It writes only
 * inside databases it creates, `it_dstream_<random>*`, and drops them and its slots at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable, type StreamStatus } from "../../src/duck/sync.ts";
import { parseLsn } from "../../src/cdc/pg-wire.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { addedTables, entryName, newSourceText, readSource, sourcesDir, withTable, type ProjectSource } from "../../src/cli/sources.ts";
import { heldCopy } from "./held-copy.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_dstream_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-dstream-"));
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skip = !adminUrl ? "IT_POSTGRES_URL is not set" : !logical ? "IT_POSTGRES_URL's server has no wal_level = logical" : false;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl || !logical) return;
  // a database with a slot on it cannot be dropped: the slots first (each test's sync is stopped by then)
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

/** the source's tables as `mason start` reads them (preflight's catalog read), by name */
async function tablesOf(source: Source, names: readonly string[]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return names.map((n) => { const t = facts.tables.find((x) => x.source === n); if (!t) throw new Error(`no table ${n}`); return t; });
  } finally { c.pg.close(); }
}

const rowsOf = async (store: DuckStore, sql: string): Promise<string> =>
  ((await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd();

test("the copy and the stream keep DuckDB equal to the source through every kind of change", { skip }, async () => {
  const db = `${tag}_a`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  // `big` is stored out of line and uncompressed: an UPDATE of another column sends it as unchanged TOAST
  psql(url, "CREATE TABLE items (id int PRIMARY KEY, v text, n numeric(10,2), meta jsonb, big text); ALTER TABLE items ALTER COLUMN big SET STORAGE EXTERNAL; " +
    "CREATE SCHEMA shop; CREATE TABLE shop.lines (order_id bigint, line int, qty int, PRIMARY KEY (order_id, line)); CREATE TABLE later (id int PRIMARY KEY, v text); " +
    "INSERT INTO items SELECT g, 'v' || g, g * 1.25, jsonb_build_object('g', g), repeat(md5(g::text), 200) FROM generate_series(1, 50) g; " +
    "INSERT INTO shop.lines SELECT g / 3, g % 3, g FROM generate_series(1, 30) g; INSERT INTO later VALUES (1, 'one')");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [ITEMS, LINES, LATER] = await tablesOf(parsed.source, ["public.items", "shop.lines", "public.later"]);
  const names = { slot: `${tag}_a`, publication: `${tag}_a`, owned: true };
  const logged: string[] = [];
  const file = path.join(dir, "a.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names);
  const same = async (step: string): Promise<void> => {
    await sync.caughtUp();
    const said = `\n${logged.slice(-8).join("\n")}`;
    assert.equal(await rowsOf(store, "SELECT id, v, n::VARCHAR, meta::VARCHAR, md5(big) FROM public.items ORDER BY 1"),
      psql(url, "SELECT id, v, n::text, meta::text, md5(big) FROM items ORDER BY 1"), `items after ${step}${said}`);
    assert.equal(await rowsOf(store, "SELECT order_id, line, qty FROM shop.lines ORDER BY 1, 2"), psql(url, "SELECT order_id, line, qty FROM shop.lines ORDER BY 1, 2"), `shop.lines after ${step}${said}`);
  };
  try {
    await sync.open();
    sync.setTables([ITEMS!, LINES!]);
    await sync.once();
    await same("the first copy");
    // no index on a copy: every write below is by key without one
    assert.deepEqual(await rowsOf(store, "SELECT count(*) FROM duckdb_constraints() WHERE schema_name <> '_mason'"), "0", "no constraint on any copy");
    assert.equal(psql(url, `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${names.slot}'`), "1", "the slot is made");
    assert.equal(psql(url, `SELECT string_agg(schemaname || '.' || tablename, ',' ORDER BY 1) FROM pg_publication_tables WHERE pubname = '${names.publication}'`), "public.items,shop.lines");

    psql(url, "INSERT INTO items VALUES (51, 'new', 9.99, NULL, 'small'); UPDATE items SET v = 'changed', n = NULL WHERE id = 2; DELETE FROM items WHERE id = 3; " +
      "UPDATE shop.lines SET qty = -1 WHERE order_id = 1; DELETE FROM shop.lines WHERE order_id = 2");
    await same("an insert, an update to NULL, a delete");

    psql(url, "UPDATE items SET id = 1000 WHERE id = 4; UPDATE shop.lines SET line = 9 WHERE order_id = 3 AND line = 0");
    await same("a primary-key change");

    // the large value is not in the stream's update: DuckDB's row keeps it; a row DuckDB lacks reads it from the source
    psql(url, "UPDATE items SET v = 'toast kept' WHERE id = 5; BEGIN; DELETE FROM items WHERE id = 6; INSERT INTO items SELECT 6, 'back', 1, NULL, repeat('z', 9000); COMMIT; UPDATE items SET v = 'toast again' WHERE id = 6; " +
      // many rows carrying the same columns: one UPDATE for them all
      "UPDATE items SET v = 'toast kept ' || id WHERE id BETWEEN 11 AND 20");
    await same("an update that leaves a TOASTed value unchanged");

    psql(url, "BEGIN; INSERT INTO items VALUES (60, 'outer', 1, NULL, NULL); SAVEPOINT s; INSERT INTO items VALUES (61, 'savepoint', 2, NULL, NULL); ROLLBACK TO SAVEPOINT s; " +
      "INSERT INTO items VALUES (62, 'after the rollback', 3, NULL, NULL); COMMIT");
    await same("a savepoint rolled back");

    // a transaction open while others commit: it arrives at its commit, in commit order
    const open = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", url], { stdio: ["pipe", "ignore", "pipe"] });
    after(() => { if (open.exitCode === null) open.kill(); });
    open.stdin.write("BEGIN; INSERT INTO items VALUES (70, 'late', 7, NULL, NULL); UPDATE items SET v = 'late update' WHERE id = 10; SELECT pg_sleep(0);\n");
    await new Promise((r) => setTimeout(r, 500));
    psql(url, "INSERT INTO items VALUES (71, 'meanwhile', 8, NULL, NULL)");
    await same("a commit while a transaction is open");
    open.stdin.end("COMMIT;\n");
    await new Promise<void>((resolve, reject) => open.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`psql exited ${code}`))));
    await same("its commit");

    psql(url, "TRUNCATE shop.lines; INSERT INTO shop.lines VALUES (7, 1, 70)");
    await same("a TRUNCATE and an insert after it");

    // A RESTART: the slot resumes where DuckDB's record says; nothing is copied or caught up again
    await sync.stop();
    store.close();
    psql(url, "INSERT INTO items VALUES (80, 'while stopped', 8, NULL, NULL); DELETE FROM items WHERE id = 1; INSERT INTO shop.lines VALUES (5, 1, 1)");
    store = await DuckStore.open(file, (l) => logged.push(l));
    sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names);
    await sync.open();
    let before = logged.length;
    sync.setTables([ITEMS!, LINES!]);
    await sync.once();
    await same("a restart");
    assert.ok(!logged.slice(before).some((l) => /^(copied|caught up) /.test(l)), `nothing is copied or caught up at a restart:\n${logged.slice(before).join("\n")}`);

    // A TABLE ADDED while streaming: the publication carries it before it is copied, and its changes follow
    before = logged.length;
    sync.setTables([ITEMS!, LINES!, LATER!]);
    await sync.once();
    psql(url, "INSERT INTO later VALUES (2, 'two'); UPDATE items SET v = 'beside it' WHERE id = 7");
    await same("a table added");
    assert.equal(await rowsOf(store, "SELECT id, v FROM public.later ORDER BY 1"), psql(url, "SELECT id, v FROM later ORDER BY 1"));
    assert.ok(logged.slice(before).some((l) => /^re-pointed publication .* at public\.items, shop\.lines, public\.later: the tables whose sync is replication$/.test(l)), logged.slice(before).join("\n"));
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.items", "copied", null], ["shop.lines", "copied", null], ["public.later", "copied", null]]);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("a project that polled is caught up by one poll when it starts replicating: nothing is copied again", { skip }, async () => {
  const db = `${tag}_b`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 20) g");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [T] = await tablesOf(parsed.source, ["public.t"]);
  const logged: string[] = [];
  const file = path.join(dir, "b.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    sync.setTables([T!]);
    await sync.once();
  } finally { await sync.stop(); store.close(); }
  // changed while nothing reads it, before any slot exists: only a poll can see these
  psql(url, "UPDATE t SET v = 'before the slot' WHERE id = 1; DELETE FROM t WHERE id = 2; INSERT INTO t VALUES (21, 'new')");
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_b`, publication: `${tag}_b`, owned: true });
  try {
    await sync.open();
    const before = logged.length;
    sync.setTables([T!]);
    await sync.once();
    await sync.caughtUp();
    assert.equal(await rowsOf(store, "SELECT id, v FROM public.t ORDER BY 1"), psql(url, "SELECT id, v FROM t ORDER BY 1"), logged.slice(before).join("\n"));
    assert.ok(logged.slice(before).some((l) => /^caught up public\.t by one poll after the slot was made: it joins the stream at [0-9A-F]+\/[0-9A-F]+, which carries what follows$/.test(l)), logged.slice(before).join("\n"));
    assert.ok(!logged.slice(before).some((l) => /^copied /.test(l)), "not copied again");
    psql(url, "UPDATE t SET v = 'streamed' WHERE id = 3");
    await sync.caughtUp();
    assert.equal(await rowsOf(store, "SELECT id, v FROM public.t ORDER BY 1"), psql(url, "SELECT id, v FROM t ORDER BY 1"));
  } finally { await sync.stop(); store.close(); }
});

test("every type arrives through the stream as the copy stores it; a numeric wider than its copy copies the table again", { skip }, async () => {
  const db = `${tag}_c`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  const cols = "id int PRIMARY KEY, i2 smallint, i8 bigint, n10 numeric(10,2), nu numeric, r real, d double precision, b boolean, t text, vc varchar(20), " +
    "c5 char(5), by bytea, dt date, ts timestamp, tz timestamptz, tm time, ttz timetz, iv interval, u uuid, j json, jb jsonb, ia int[], ta text[], " +
    "m mood, ip inet, jba jsonb[]";
  psql(url, `CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy'); CREATE TABLE typed (${cols})`);
  const row = (id: number): string => `(${id}, ${id}, ${id} * 10000000000, ${id}.25, ${id}.125, ${id}.5, ${id}.0625, ${id % 2 === 0}, 'a ''quoted'' ${id}', 'v${id}', ` +
    `'ab', '\\x00ff${id.toString(16).padStart(2, "0")}', '2026-01-${String(id % 28 + 1).padStart(2, "0")}', '2026-01-02 03:04:05.${id}', '2026-01-02 03:04:05.123456+02', ` +
    `'12:34:56', '12:34:56+05:30', '1 year 2 mons 3 days 04:05:06.789', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a${String(id).padStart(2, "0")}', ` +
    `'{"a": [1, 2], "b": "x"}', '{"b": "x", "a": [1, 2]}', '{1,NULL,${id}}', '{"a,b","with \\"quote\\"",NULL,""}', ` +
    `'${["sad", "ok", "happy"][id % 3]}', '10.0.0.${id}/24', ARRAY['{"k": 1}'::jsonb, NULL])`;
  // the first rows before the copy (they set an unconstrained numeric's scale), with the extremes a type has
  psql(url, `INSERT INTO typed VALUES ${[1, 2, 3].map(row).join(", ")}; ` +
    "INSERT INTO typed (id, r, d, dt, ts, tz, ta, ia) VALUES (4, 'NaN', '-Infinity', 'infinity', '-infinity', 'infinity', '{}', '{}'), (5, NULL, NULL, NULL, NULL, NULL, NULL, NULL)");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [TYPED] = await tablesOf(parsed.source, ["public.typed"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "c.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_c`, publication: `${tag}_c`, owned: true });
  const fresh = async (): Promise<string> => {
    // a fresh copy of the table as it is now, in a file of its own: what the stream's rows must equal
    const f = path.join(dir, `c-copy-${Date.now()}.db`);
    const s2 = await DuckStore.open(f, () => undefined);
    const y = new Sync(s2, parsed.source, db, () => undefined, 3_600_000, "poll");
    try { await y.open(); y.setTables([TYPED!]); await y.once(); return await rowsOf(s2, "SELECT COLUMNS(*)::VARCHAR FROM public.typed ORDER BY id"); }
    finally { await y.stop(); s2.close(); }
  };
  try {
    await sync.open();
    sync.setTables([TYPED!]);
    await sync.once();
    // every row now arrives by the stream: inserted, and the copied ones updated in every column
    psql(url, `INSERT INTO typed VALUES ${[11, 12, 13].map(row).join(", ")}; ` +
      `UPDATE typed SET (${cols.split(", ").slice(1).map((c) => c.split(" ")[0]).join(", ")}) = (SELECT ${cols.split(", ").slice(1).map((c) => `x.${c.split(" ")[0]}`).join(", ")} FROM typed x WHERE x.id = 12) WHERE id = 1; ` +
      "INSERT INTO typed (id, r, d, dt, ts, tz, ta, ia) VALUES (14, 'Infinity', 'NaN', '-infinity', 'infinity', '-infinity', '{}', '{{}}')");
    await sync.caughtUp();
    const streamed = await rowsOf(store, "SELECT COLUMNS(*)::VARCHAR FROM public.typed ORDER BY id");
    assert.equal(streamed.split("\n").length, 9);
    assert.equal(streamed, await fresh(), "the streamed rows equal a fresh copy, value for value");

    // more decimals than the copy's DECIMAL holds: the table is copied again, wider, and the stream goes on
    psql(url, "UPDATE typed SET nu = 1.123456 WHERE id = 2");
    // the stream stops on it, and the copy again runs as a pass of its own: waited for, then the stream again
    const until = Date.now() + 30_000;
    const recopied = (): boolean => { const w = logged.findIndex((x) => /wider than its copy's DECIMAL/.test(x)); return w >= 0 && logged.slice(w).some((l) => /^copied public\.typed/.test(l)); };
    while (!recopied() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await sync.caughtUp();
    assert.ok(logged.some((l) => l === "replication: public.typed has a numeric value wider than its copy's DECIMAL: it is copied again, then streamed"), logged.slice(-10).join("\n"));
    assert.equal(await rowsOf(store, "SELECT nu::VARCHAR FROM public.typed WHERE id = 2"), "1.123456");
    psql(url, "UPDATE typed SET vc = 'still streamed' WHERE id = 3");
    await sync.caughtUp();
    assert.equal(await rowsOf(store, "SELECT vc FROM public.typed WHERE id = 3"), "still streamed");
  } finally { await sync.stop(); store.close(); }
});

// A BULK CHANGE ON A BIG TABLE (a migration's UPDATE over tens of millions of rows, one Postgres
// transaction). The stream folded a whole transaction in Node's heap before applying it at its commit, and applied it
// in one DuckDB transaction; it is now applied in committed pieces of `PIECE_CHANGES`, its position recorded with the
// last. The sync runs in a process of its own (tests/integration/duck-stream-child.ts) under a V8 heap far below what
// the transaction's changes take folded: without the pieces it runs out of heap.
test("a transaction changing every row of a big table is applied in committed pieces, within a small heap", { skip }, async () => {
  const db = `${tag}_d`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  const ROWS = 600_000;
  psql(url, `CREATE TABLE bulk (id uuid PRIMARY KEY, n int); INSERT INTO bulk SELECT md5(g::text)::uuid, g FROM generate_series(1, ${ROWS}) g`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [BULK] = await tablesOf(parsed.source, ["public.bulk"]);
  const args = {
    url, file: path.join(dir, "d.db"), memoryLimit: "256MB", slot: `${tag}_d`, publication: `${tag}_d`, table: BULK!,
    // ONE transaction: every row updated, a few deleted and inserted
    sql: "BEGIN; UPDATE bulk SET n = -n; DELETE FROM bulk WHERE n % 100 = 0; INSERT INTO bulk SELECT md5((-g)::text)::uuid, g FROM generate_series(1, 1000) g; COMMIT",
    checksum: "SELECT count(*), sum(n), sum(('0x' || substr(md5(id::VARCHAR), 1, 8))::UBIGINT) FROM public.bulk",
  };
  const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, path.join(import.meta.dirname, "duck-stream-child.ts"), JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, `the sync's process ended ${code} under a ${HEAP_MB} MB heap:\n${err.split("\n").filter((l) => /heap|memory|Error/i.test(l)).slice(0, 5).join("\n")}`);
  const r = JSON.parse(out.trim().split("\n").pop()!) as { checksum?: string; error?: string; logged: string[] };
  const said = r.logged.slice(-6).join("\n");
  assert.equal(r.error, undefined, said);
  assert.equal(r.checksum, psql(url, "SELECT count(*), sum(n), sum(('x' || substr(md5(id::text), 1, 8))::bit(32)::bigint) FROM bulk"), `DuckDB equals the source\n${said}`);
  assert.ok(r.logged.some((l) => /^replication: public\.bulk: 607,000 change\(s\) in one transaction, applied in 61 pieces$/.test(l)), said);
});
/** the sync's V8 heap in the bulk-change test: with the pieces it ran in 48 MB; without them, 607,000
 *  changes folded ran out of 96 */
const HEAP_MB = Number(process.env.IT_BULK_HEAP_MB ?? 96);

/** waits for `ok`, failing with what was logged after `ms` */
async function until(ok: () => boolean | Promise<boolean>, what: string, logged: readonly string[], ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await ok()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms\n${logged.slice(-12).join("\n")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A COPY RUNS BESIDE THE STREAM (adding a 195 M-row table stopped every other table's freshness, and
// held the slot's WAL, for the 35 minutes of its copy). While a large table copies, a change to a table already streamed
// is in DuckDB before the copy ends and the slot's confirmed position moves; the changes to the copying table committed
// after its snapshot are in it once it is caught up (one poll from that snapshot, the stream holding its changes
// meanwhile: src/duck/stream.ts "why replaying is safe"); and the stream is never stopped or started again.
test("a table copies beside the stream: the others stay current and the slot moves meanwhile, and what changed during the copy is in it once caught up", { skip }, async () => {
  const db = `${tag}_x`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  const ROWS = 400_000;
  // a store at the tests' memory limit: a copy of several seconds
  psql(url, `CREATE TABLE small (id int PRIMARY KEY, v text); INSERT INTO small VALUES (1, 'a'); ` +
    `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 16) FROM generate_series(1, ${ROWS}) g ORDER BY (g::bigint * 7919) % ${ROWS}`);
  // big's rows older than every snapshot's xmin: the copy reads them (a copy keeps only rows written before its first
  // snapshot's xmin, src/duck/sync.ts copy), so its scan is in flight for seconds — another session's open transaction
  // on the shared test cluster would leave them all to the catch-up (duck-poll.itest.ts rowsOlderThanEverySnapshot)
  const deadline = Date.now() + 120_000;
  while (psql(url, "SELECT (SELECT max(xmin::text::bigint) FROM big) < pg_snapshot_xmin(pg_current_snapshot())::text::bigint") !== "t") {
    if (Date.now() > deadline) throw new Error("a transaction on the test cluster has been open since before big was written, for 2 minutes");
    await new Promise((r) => setTimeout(r, 200));
  }
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [SMALL, BIG] = await tablesOf(parsed.source, ["public.small", "public.big"]);
  const names = { slot: `${tag}_x`, publication: `${tag}_x`, owned: true };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "x.db"), (l) => logged.push(l), { memoryLimit: "64MB" });
  // the copy's chunks are HELD inside their transactions (`heldCopy`) until the stream's work beside it is seen: the
  // copy's speed decides nothing here (strings stored ZSTD took this copy from seconds to 0.6 s, and the test raced)
  const big = heldCopy("public.big");
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names, { onChunk: big.onChunk });
  // read on a connection of the test's own: the sync's writer may be inside a transaction
  const reader = await store.instance.connect();
  const read = async (sql: string): Promise<string> => ((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  const flushed = (): bigint => BigInt(psql(url, `SELECT pg_wal_lsn_diff(confirmed_flush_lsn, '0/0')::bigint FROM pg_replication_slots WHERE slot_name = '${names.slot}'`));
  const sum = "count(*), count(DISTINCT id), sum(('x' || substr(md5(id::text || v), 1, 8))::bit(32)::bigint)";
  const duckSum = "count(*), count(DISTINCT id), sum(('0x' || substr(md5(id::VARCHAR || v), 1, 8))::UBIGINT)";
  try {
    await sync.open();
    sync.setTables([SMALL!]);
    await sync.once();
    await sync.caughtUp();
    const from = logged.length;
    void sync.setTables([SMALL!, BIG!]);
    // the copy's snapshot is pinned, so what changes now is after it, and its scan of several seconds is ahead
    await until(() => logged.slice(from).some((l) => /^copying public\.big as of the source's snapshot /.test(l)), "big's snapshot pinned", logged);
    const before = flushed();
    psql(url, "INSERT INTO small VALUES (2, 'during the copy'); UPDATE big SET v = 'changed during its copy' WHERE id = 7; DELETE FROM big WHERE id = 8; INSERT INTO big VALUES (0, 'new during its copy')");
    await sync.caughtUp();
    const copied = logged.slice(from).some((l) => /^copied public\.big/.test(l));
    assert.equal(await read("SELECT id, v FROM public.small ORDER BY 1"), "1\ta\n2\tduring the copy", `small is current while big copies\n${logged.slice(from).join("\n")}`);
    assert.ok(!copied, `the change to small was in DuckDB BEFORE big's copy ended (the stream went on beside it)\n${logged.slice(from).join("\n")}`);
    assert.ok(flushed() > before, "the slot's confirmed position moved during the copy: it does not hold the database's WAL for it");
    assert.ok(logged.slice(from).some((l) => /^copying public\.big: .*beside the stream, which goes on keeping the other tables current/.test(l)), "the copy's start says the stream goes on");

    big.release();
    await sync.once();
    await sync.caughtUp();
    assert.ok(logged.slice(from).some((l) => /^caught up public\.big by one poll after its copy: it joins the stream at [0-9A-F]+\/[0-9A-F]+, which carries what follows$/.test(l)), logged.slice(from).join("\n"));
    assert.equal(await read(`SELECT ${duckSum} FROM public.big`), psql(url, `SELECT ${sum} FROM big`), `big equals the source once caught up\n${logged.slice(from).join("\n")}`);
    assert.equal(await read("SELECT id, v FROM public.big WHERE id IN (0, 7, 8) ORDER BY 1"), "0\tnew during its copy\n7\tchanged during its copy", "the changes made during its copy");
    // streamed from then on, and the stream started once in the whole run
    psql(url, "UPDATE big SET v = 'streamed after' WHERE id = 9; INSERT INTO small VALUES (3, 'c')");
    await sync.caughtUp();
    assert.equal(await read("SELECT v FROM public.big WHERE id = 9"), "streamed after");
    assert.equal(logged.filter((l) => /^streaming /.test(l)).length, 1, `the stream was never stopped and started again:\n${logged.filter((l) => /^streaming /.test(l)).join("\n")}`);
  } finally {
    big.release();
    reader.closeSync();
    await sync.stop();
    store.close();
  }
});

// A PUBLICATION THE OPERATOR NAMED (`mason start --replication --publication <name>`; src/duck/publication.ts)
// is read as it is: verified, never created, altered or dropped — on a read replica Mason could not make one, and on a
// customer's primary the one object Mason creates is its slot. A table it does not carry is refused on its own line, the
// stream going on for the others; `--poll` drops the slot alone.
test("a NAMED publication is read as it is, never altered: a table it lacks is refused with the way out, the others stream on; --poll drops only the slot", { skip }, async () => {
  const db = `${tag}_p`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text, extra text); CREATE TABLE b (id int PRIMARY KEY, v text); CREATE TABLE c (id int PRIMARY KEY, v text); " +
    "INSERT INTO a SELECT g, 'a' || g, 'x' FROM generate_series(1, 10) g; INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 10) g; INSERT INTO c VALUES (1, 'c1'); " +
    "CREATE PUBLICATION app_pub FOR TABLE a (id, v, extra), b WITH (publish = 'insert, update, delete')");
  // the publication's whole definition, its catalog rows' versions (xmin) included: an ALTER, even one to the same, moves them
  const definition = (): string => psql(url, "SELECT p.xmin, p.oid, p.pubname, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate FROM pg_publication p WHERE pubname = 'app_pub'") +
    "\n" + psql(url, "SELECT r.xmin, r.prrelid::regclass, r.prattrs::text, pg_get_expr(r.prqual, r.prrelid) FROM pg_publication_rel r JOIN pg_publication p ON p.oid = r.prpubid WHERE p.pubname = 'app_pub' ORDER BY 2");
  const tables = (): string => psql(url, "SELECT schemaname, tablename, attnames::text, rowfilter FROM pg_publication_tables WHERE pubname = 'app_pub' ORDER BY 1, 2");
  const [defined, published] = [definition(), tables()];
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [A, B, C] = await tablesOf(parsed.source, ["public.a", "public.b", "public.c"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "p.db"), (l) => logged.push(l));
  const repl = { slot: `${tag}_p`, publication: "app_pub", owned: false };
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", repl);
  const same = async (step: string): Promise<void> => {
    await sync.caughtUp();
    const said = `\n${logged.slice(-8).join("\n")}`;
    assert.equal(await rowsOf(store, "SELECT id, v, extra FROM public.a ORDER BY 1"), psql(url, "SELECT id, v, extra FROM a ORDER BY 1"), `a after ${step}${said}`);
    assert.equal(await rowsOf(store, "SELECT id, v FROM public.b ORDER BY 1"), psql(url, "SELECT id, v FROM b ORDER BY 1"), `b after ${step}${said}`);
  };
  try {
    await sync.open();
    sync.setTables([A!, B!]);
    await sync.once();
    await same("the first copy");
    assert.equal(definition(), defined, "no ALTER PUBLICATION ran at the first pass: the definition is byte-equal");
    assert.equal(psql(url, `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${repl.slot}'`), "1", "the slot is made");
    assert.equal(logged.filter((l) => /^publication app_pub does not publish truncate: a TRUNCATE on the database does not reach the copy/.test(l)).length, 1, logged.join("\n"));
    psql(url, "INSERT INTO a VALUES (11, 'new', 'y'); UPDATE b SET v = 'changed' WHERE id = 2; DELETE FROM a WHERE id = 3");
    await same("an insert, an update, a delete");

    // a table added while streaming that the publication does not carry: refused by name with the ADD TABLE its owner
    // runs, never altered in; the others go on streaming
    sync.setTables([A!, B!, C!]);
    await sync.once();
    const c = sync.state().find((s) => s.source === "public.c")!;
    assert.equal(c.phase, "failed");
    assert.match(c.error!, /^replication: publication app_pub does not carry what Mason's copy of the table holds\.\n\n {2}missing: public\.c \(read by Mason's copy\)\n/);
    assert.match(c.error!, /\n {2}ALTER PUBLICATION app_pub ADD TABLE\n {4}public\.c \(id, v\);\n\nFound: publication app_pub \(publish = 'insert, update, delete'\)\n {4}public\.a \(id, v, extra\),\n {4}public\.b \(id, v\)\n/);
    assert.match(c.error!, /never altering it/);
    assert.equal(await rowsOf(store, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'c'"), "0", "not copied");
    psql(url, "UPDATE a SET v = 'beside the refusal' WHERE id = 4; INSERT INTO b VALUES (12, 'b12'); INSERT INTO c VALUES (2, 'c2')");
    await same("a refused table beside them");
    assert.deepEqual(sync.state().filter((s) => s.source !== "public.c").map((s) => [s.source, s.phase, s.error]), [["public.a", "copied", null], ["public.b", "copied", null]]);
  } finally { await sync.stop(); store.close(); }

  assert.equal(definition(), defined, "no CREATE, ALTER or DROP PUBLICATION ran: the definition is byte-equal");
  assert.equal(tables(), published, "pg_publication_tables is unchanged");
  assert.ok(!logged.some((l) => /(made|re-pointed) publication/.test(l)), logged.join("\n"));

  // mason start --poll (and mason destroy): the slot goes, verified; the publication is its owner's and stays as it was
  const { dropOwnReplication } = await import("../../src/cli/replication-mode.ts");
  assert.deepEqual(await dropOwnReplication(parsed.source, repl), [`replication slot ${repl.slot}`]);
  assert.equal(psql(url, `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${repl.slot}'`), "0");
  assert.equal(definition(), defined, "the publication is left as it was");
});

test("a named publication that cannot carry the copy is refused in the developer's words with the way out: a narrower column list, no delete, a typo", { skip }, async () => {
  const db = `${tag}_q`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text, extra text); CREATE TABLE b (id int PRIMARY KEY, v text); " +
    "INSERT INTO a VALUES (1, 'a', 'x'); INSERT INTO b VALUES (1, 'b'); " +
    "CREATE PUBLICATION narrow FOR TABLE a (id, v), b; CREATE PUBLICATION nodel FOR TABLE a, b WITH (publish = 'insert, update'); CREATE PUBLICATION everything FOR ALL TABLES");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [A, B] = await tablesOf(parsed.source, ["public.a", "public.b"]);
  const run = async (publication: string, slot: string): Promise<{ states: ReturnType<Sync["state"]>; logged: string[] }> => {
    const logged: string[] = [];
    const store = await DuckStore.open(path.join(dir, `q-${slot}.db`), (l) => logged.push(l));
    const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_${slot}`, publication, owned: false });
    try {
      await sync.open(); sync.setTables([A!, B!]); await sync.once();
      // a refused run has no stream to wait for
      if (sync.state().some((s) => s.phase === "copied")) await sync.caughtUp();
      return { states: sync.state(), logged };
    }
    finally { await sync.stop(); store.close(); }
  };
  const before = psql(url, "SELECT pubname, xmin FROM pg_publication ORDER BY 1") + psql(url, "SELECT prpubid, prrelid, xmin FROM pg_publication_rel ORDER BY 1, 2");

  // a column list without a copied column: that table is refused, naming the column, with the statements that widen it
  const narrow = await run("narrow", "q1");
  const a = narrow.states.find((s) => s.source === "public.a")!;
  assert.equal(a.phase, "failed");
  assert.match(a.error!, /\n {2}missing: public\.a columns extra \(read by Mason's copy\)\n/);
  assert.match(a.error!, /\n {2}BEGIN;\n {2}ALTER PUBLICATION narrow DROP TABLE public\.a;\n {2}ALTER PUBLICATION narrow ADD TABLE\n {4}public\.a \(id, v, extra\);\n {2}COMMIT;\n/);
  assert.deepEqual(narrow.states.filter((s) => s.source === "public.b").map((s) => [s.phase, s.error]), [["copied", null]], "the other table is copied and streamed");

  // no delete published: the run is refused by name before any slot is made
  const nodel = await run("nodel", "q2");
  for (const s of nodel.states) {
    assert.equal(s.phase, "failed");
    assert.match(s.error!, /^replication: publication nodel does not carry what Mason's copy of the table holds\./);
    assert.match(s.error!, /it publishes insert, update; the change reader needs insert, update and delete/);
    assert.match(s.error!, /\n {2}ALTER PUBLICATION nodel SET \(publish = 'insert, update, delete'\);\n/);
  }
  assert.equal(psql(url, `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${tag}_q2'`), "0", "refused before the slot");

  // a publication that does not exist: refused, listing the database's publications (a typo)
  const typo = await run("narow", "q3");
  assert.match(typo.states[0]!.error!, /Found: no publication named narow\. Publications on this database: everything, narrow, nodel\./);

  // FOR ALL TABLES carries every table
  const all = await run("everything", "q4");
  assert.deepEqual(all.states.map((s) => [s.source, s.phase, s.error]), [["public.a", "copied", null], ["public.b", "copied", null]], all.logged.join("\n"));
  assert.equal(psql(url, "SELECT pubname, xmin FROM pg_publication ORDER BY 1") + psql(url, "SELECT prpubid, prrelid, xmin FROM pg_publication_rel ORDER BY 1, 2"), before, "no publication was altered");
});

// THE STREAM IS VISIBLE WHILE IT RUNS (the test server's first replication run printed one stream line in 35 minutes,
// "streaming no table yet … applied through 0/0", and mason status showed no position, lag or count). A table's join is
// said with the position it joins at, and its leaving with why; the stream's state (what mason status and wait render)
// moves with each change, its lag right after one is the change's age, and its counts are the changes made; a periodic
// line says what moved, and nothing while idle.
test("the stream says where it is: a table joins and leaves on a line with its position, and its state counts what it applied", { skip }, async () => {
  const db = `${tag}_v`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text); INSERT INTO a SELECT g, 'a' || g FROM generate_series(1, 10) g; " +
    "CREATE TABLE b (id int PRIMARY KEY, v text); INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 5) g");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [A, B] = await tablesOf(parsed.source, ["public.a", "public.b"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "v.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_v`, publication: `${tag}_v`, owned: true }, { streamReportMs: 300 });
  const status = async (): Promise<StreamStatus> => { const s = await sync.streamStatus(); assert.ok(s !== null, "replication mode has a stream status"); return s; };
  const table = (s: StreamStatus, source: string): StreamStatus["tables"][number] => s.tables.find((t) => t.table === source)!;
  const LSN = "[0-9A-F]+\\/[0-9A-F]+";
  try {
    await sync.open();
    sync.setTables([A!]);
    await sync.once();
    await sync.caughtUp();
    // THE JOIN, after the catch-up, with the position it joins at
    assert.ok(logged.some((l) => new RegExp(`^caught up public\\.a by one poll after its copy: it joins the stream at ${LSN}, which carries what follows$`).test(l)), logged.join("\n"));
    const s0 = await status();
    assert.equal(s0.running, true);
    assert.deepEqual([table(s0, "public.a").state, table(s0, "public.a").applied], ["streamed", { inserts: 0, updates: 0, deletes: 0, truncates: 0 }]);
    assert.ok("lsn" in s0.database, `the database's position is read: ${JSON.stringify(s0.database)}`);

    // THE CHANGES MADE are what the state counts, the position moves, and the lag right after them is their age
    psql(url, "INSERT INTO a VALUES (11, 'x'), (12, 'y'), (13, 'z'); UPDATE a SET v = 'changed' WHERE id IN (1, 2); DELETE FROM a WHERE id = 3");
    await sync.caughtUp();
    const s1 = await status();
    assert.deepEqual(table(s1, "public.a").applied, { inserts: 3, updates: 2, deletes: 1, truncates: 0 }, "the changes made, as the database made them");
    assert.ok(parseLsn(s1.position) > parseLsn(s0.position), `the position moved: ${s0.position} → ${s1.position}`);
    assert.ok(parseLsn(s1.applied) > parseLsn(s0.applied), `the position applied (_mason.stream_state) moved: ${s0.applied} → ${s1.applied}`);
    assert.ok(s1.lastBatch !== null && s1.lag.seconds !== null && s1.lag.seconds < 3, `the newest change applied is seconds old: ${JSON.stringify(s1.lag)}`);
    assert.ok(Date.parse(s1.lastBatch.appliedAt) >= Date.parse(s1.lastBatch.committedAt), "applied after its commit");
    assert.equal(typeof s1.lag.bytes, "number");

    // THE PERIODIC LINE says what moved since the last one, and nothing while idle
    await until(() => logged.some((l) => new RegExp(`^replication: applied through ${LSN} · in the last [\\d.]+ s: public\\.a 6 changes \\(3 inserts, 2 updates, 1 delete\\) · [\\d,]+ bytes behind the database; the newest change applied was committed`).test(l)),
      "the periodic line", logged, 5_000);
    const idleFrom = logged.length;
    await new Promise((r) => setTimeout(r, 1_200));
    assert.deepEqual(logged.slice(idleFrom).filter((l) => /^replication: applied through /.test(l)), [], "silent while idle");

    // A TABLE ADDED joins after its catch-up; a TRUNCATE is counted
    sync.setTables([A!, B!]);
    await sync.once();
    await sync.caughtUp();
    assert.ok(logged.some((l) => new RegExp(`^caught up public\\.b by one poll after its copy: it joins the stream at ${LSN}, which carries what follows$`).test(l)), logged.join("\n"));
    psql(url, "TRUNCATE b; INSERT INTO b VALUES (1, 'again')");
    await sync.caughtUp();
    assert.deepEqual(table(await status(), "public.b").applied, { inserts: 1, updates: 0, deletes: 0, truncates: 1 });

    // A TABLE REMOVED leaves the stream, said with why
    const from = logged.length;
    sync.setTables([B!]);
    await sync.once();
    assert.ok(logged.slice(from).some((l) => new RegExp(`^public\\.a leaves the stream at ${LSN}: it is no longer added`).test(l)), logged.slice(from).join("\n"));
    assert.deepEqual((await status()).tables.map((t) => [t.table, t.state]), [["public.b", "streamed"]]);
    assert.equal(logged.filter((l) => / (joins|leaves) the stream /.test(l)).length, 3, `a line per join and leave, never per batch:\n${logged.join("\n")}`);
  } finally {
    await sync.stop();
    store.close();
  }
});

/**
 * THE PROJECT AFTER `mason add <table> --columns …` (null: every column): its sources file written as the CLI writes it
 * (one entry per table, spliced in) and read back as `mason start` reads it (`readSource`, then `addedTables`).
 */
async function pick(source: Source, folder: string, picks: ReadonlyArray<readonly [string, readonly string[] | null]>): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  let facts;
  try { facts = await readSourceFacts(c.pg); } finally { c.pg.close(); }
  // every table this file streams is replicated: the file's top sync: says so (a polled or off table is written so)
  let text = newSourceText(source.url, [], { mode: "replication" });
  for (const [n, cols] of picks) {
    const r = withTable(text, { name: entryName(n), table: n, columns: cols === null ? null : [...cols], exclude: [], key: null });
    if ("problem" in r) throw new Error(r.problem);
    text = r.text;
  }
  fs.rmSync(sourcesDir(folder), { recursive: true, force: true });
  fs.mkdirSync(sourcesDir(folder), { recursive: true });
  fs.writeFileSync(path.join(sourcesDir(folder), "app.yml"), text);
  const read = readSource(folder, folder, {});
  if (!("tables" in read)) throw new Error(read.message);
  const added = addedTables(read as ProjectSource, facts.tables, source.database, folder);
  if (!Array.isArray(added)) throw new Error(`${added.message}\n${added.why ?? ""}`);
  return added;
}

// A STREAM CHANGE IS WRITTEN AS THE COPY'S COLUMNS, NEVER THE PUBLICATION'S OR THE SOURCES FILE'S OF THE MOMENT (the
// box: a column was removed from a streamed table's entry in the sources file and restored while its re-copy ran; the changes held during the
// catch-up were written naming a column the new copy did not have — `Binder Error: Referenced column … not found` — and
// the table was then neither streamed nor copied again, for good). A publication carrying every column streams a table
// whose entry copies fewer: the copy's own column list decides every write. And an entry that changed while its table was
// copied is copied again at once, never left for a pass that may not come (replication runs one only when kicked).
test("a table's columns changed in the sources file while its table copies: copied again at once; narrowed, every change is written as the copy's columns", { skip }, async () => {
  const db = `${tag}_n`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  // its size decides nothing: each step that must land WHILE a copy runs holds that copy (`hold` below); `big` out of
  // line: an UPDATE of another column leaves it unchanged-TOAST in the stream. The publication carries EVERY column,
  // whatever the sources file copies
  const ROWS = 20_000;
  psql(url, "CREATE TABLE t (id int PRIMARY KEY, v text, big text, dropme text); ALTER TABLE t ALTER COLUMN big SET STORAGE EXTERNAL; CREATE TABLE stop_writing (x int); " +
    `INSERT INTO t SELECT g, repeat(md5(g::text), 16), CASE WHEN g <= 20 THEN repeat(md5(g::text), 200) END, 'd' || g FROM generate_series(1, ${ROWS}) g ORDER BY (g::bigint * 7919) % ${ROWS}; ` +
    "CREATE PUBLICATION every_column FOR TABLE t");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const folder = path.join(dir, "n-project");
  const FULL = ["id", "v", "big", "dropme"], NARROW = ["id", "v", "big"];
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "n.db"), (l) => logged.push(l), { memoryLimit: "64MB" });
  // A COPY HELD BY THE TEST (`heldCopy`, armed only when a step needs it): from `copyOfT.hold()` to `copyOfT.release()`
  // every chunk of public.t's copy waits inside its transaction, so what the test does meanwhile lands DURING the copy
  // whatever the machine's speed (a narrowed copy that ended first left the restored entry nothing to copy again)
  const copyOfT = heldCopy("public.t", false);
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_n`, publication: "every_column", owned: false }, { onChunk: copyOfT.onChunk });
  const reader = await store.instance.connect();
  const read = async (sql: string): Promise<string> => ((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  const since = (from: number, re: RegExp): number => logged.slice(from).filter((l) => re.test(l)).length;
  // the source projected to the columns the sources file copies, against DuckDB's copy (which holds no other)
  const same = async (cols: readonly string[], step: string, from: number): Promise<void> => {
    await sync.caughtUp();
    const list = cols.map((c) => c === "id" ? c : `coalesce(md5(${c}), '-')`).join(", ");
    assert.equal(await read(`SELECT column_name FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = 'public' AND table_name = 't' ORDER BY ordinal_position`), cols.join("\n"), `the copy holds the sources file's columns, no other (${step})`);
    assert.equal(await read(`SELECT count(*), count(DISTINCT id) FROM public.t`), psql(url, "SELECT count(*), count(DISTINCT id) FROM t"), `${step}\n${logged.slice(from).join("\n")}`);
    // the rows the changes touched, by key: each one DuckDB and the source disagree on, both ways
    const where = `id <= 40 OR id > ${ROWS} OR v LIKE 'changed%' OR v LIKE 'trickle%'`;
    const duck = (await read(`SELECT ${list} FROM public.t WHERE ${where} ORDER BY id`)).split("\n"), pg = psql(url, `SELECT ${list} FROM t WHERE ${where} ORDER BY id`).split("\n");
    assert.deepEqual({ onlyInDuckDB: duck.filter((l) => !pg.includes(l)), onlyInTheSource: pg.filter((l) => !duck.includes(l)) }, { onlyInDuckDB: [], onlyInTheSource: [] }, `${step}\n${logged.slice(from).join("\n")}`);
  };
  // the app writing all along: one committed UPDATE every 50 ms (so some are held while a catch-up polls), until told
  const trickle = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", url, "-c",
    `DO $$ BEGIN FOR i IN 1..2400 LOOP EXIT WHEN EXISTS (SELECT 1 FROM stop_writing); UPDATE t SET v = 'trickle ' || i, dropme = 'td ' || i WHERE id = 21 + (i * 7919) % ${ROWS - 21}; COMMIT; PERFORM pg_sleep(0.05); END LOOP; END $$`],
    { stdio: ["ignore", "ignore", "pipe"] });
  const trickled = new Promise<void>((resolve, reject) => trickle.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`the writing app exited ${code}`))));
  after(() => { if (trickle.exitCode === null) trickle.kill(); });
  try {
    await sync.open();
    void sync.setTables(await pick(parsed.source, folder, [["public.t", FULL]]));
    await sync.once();
    await sync.caughtUp();

    // THE TEST SERVER'S SEQUENCE: a column removed from the sources file, and restored while the narrowed copy runs
    let from = logged.length;
    copyOfT.hold();
    void sync.setTables(await pick(parsed.source, folder, [["public.t", NARROW]]));
    await until(copyOfT.held, "the narrowed copy held in its chunks", logged);
    // restored while the narrowed copy is held: it cannot have ended first
    void sync.setTables(await pick(parsed.source, folder, [["public.t", FULL]]));
    copyOfT.release();
    await until(() => since(from, /^caught up public\.t by one poll after its copy/) > 0, "copied again and caught up", logged, 120_000);
    assert.equal(since(from, /^copied public\.t:/), 2, `the narrowed copy, then the restored one at once\n${logged.slice(from).join("\n")}`);
    assert.equal(since(from, /could not be applied|failed/), 0, logged.slice(from).join("\n"));
    psql(url, "INSERT INTO stop_writing VALUES (1)");
    await trickled;
    await same(FULL, "a column removed and restored while its table copied", from);

    // NARROWED, under a publication that still sends the column: what changes during the copy, and after it
    from = logged.length;
    copyOfT.hold();
    void sync.setTables(await pick(parsed.source, folder, [["public.t", NARROW]]));
    // the narrowed copy's snapshot is pinned and its chunks wait: the changes below are made DURING it
    await until(copyOfT.held, "the narrowed copy held in its chunks", logged);
    const changes = (n: number): string => `INSERT INTO t VALUES (${ROWS + n}, 'new ${n}', NULL, 'dn'); ` +
      // one touching only the column the copy lacks, one leaving the TOASTed value unchanged, a delete
      `UPDATE t SET dropme = 'only the dropped column ${n}' WHERE id = ${n}; UPDATE t SET v = 'changed ${n}' WHERE id = ${n + 1}; DELETE FROM t WHERE id = ${n + 2}`;
    psql(url, changes(3));
    copyOfT.release();
    await until(() => since(from, /^caught up public\.t by one poll after its copy/) > 0, "the narrowed copy caught up", logged, 120_000);
    await same(NARROW, "narrowed, the changes during its copy caught up", from);
    psql(url, changes(7));
    await same(NARROW, "narrowed, the next batch", from);
    assert.equal(since(from, /could not be applied|failed/), 0, logged.slice(from).join("\n"));
  } finally {
    // first: a stop interrupts DuckDB's statements, never the test's hold
    copyOfT.release();
    // a test that failed early stops the writing app too; its own exit code is that failure's to explain, not this one's
    if (trickle.exitCode === null) { psql(url, "INSERT INTO stop_writing VALUES (1)"); await trickled.catch((e: unknown) => { console.error(`the writing app: ${String(e)}`); }); }
    reader.closeSync();
    await sync.stop();
    store.close();
  }
});

// A RELATION THAT NO LONGER CARRIES A COLUMN THE COPY HOLDS (a DDL on the database while Mason streams) refuses THAT
// table by name, with the way out, and the other tables stream on; the sources file narrowed to what the table has copies it
// again at once. The stream used to read the missing column from the source, which failed the whole stream.
test("a column dropped on the database while streaming refuses that table by name with the way out; the others stream on", { skip }, async () => {
  const db = `${tag}_k`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text, x text); CREATE TABLE b (id int PRIMARY KEY, v text); " +
    "INSERT INTO a SELECT g, 'a' || g, 'x' || g FROM generate_series(1, 10) g; INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 10) g; " +
    "CREATE PUBLICATION app_pub FOR TABLE a, b");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const folder = path.join(dir, "k-project");
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "k.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", { slot: `${tag}_k`, publication: "app_pub", owned: false });
  const reader = await store.instance.connect();
  const read = async (sql: string): Promise<string> => ((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  try {
    await sync.open();
    void sync.setTables(await pick(parsed.source, folder, [["public.a", null], ["public.b", null]]));
    await sync.once();
    await sync.caughtUp();
    const from = logged.length;
    psql(url, "ALTER TABLE a DROP COLUMN x; INSERT INTO a VALUES (11, 'after the drop'); INSERT INTO b VALUES (11, 'b after the drop')");
    // the other table streams on
    await until(async () => await read("SELECT v FROM public.b WHERE id = 11") === "b after the drop", "b is current", logged, 20_000);
    const refused = logged.slice(from).filter((l) => l.startsWith("public.a: replication: the stream no longer carries"));
    assert.equal(refused.length, 1, logged.slice(from).join("\n"));
    assert.match(refused[0]!, /^public\.a: replication: the stream no longer carries public\.a's x, which its copy holds \(a column dropped or renamed on the database, or the publication's column list narrowed\), so its changes are not applied: it is caught up by one poll again after \d\d:\d\d UTC \(failure 1 in a row\), or at once when Mason starts again or its columns or key change\. The way out: remove x from its columns in the sources file \(mason add public\.a --columns … picks the columns it has; it is copied again at once\), or publish it again \(ALTER PUBLICATION app_pub …\)$/);
    assert.ok(logged.slice(from).some((l) => /^public\.a leaves the stream at /.test(l)), logged.slice(from).join("\n"));
    // mason status: its error, and its catch-up's next attempt
    assert.equal(sync.state().find((x) => x.source === "public.a")?.error, refused[0]!.slice("public.a: ".length));
    const a = (await sync.streamStatus())!.tables.find((x) => x.table === "public.a")!;
    assert.equal(a.state, "catching-up");
    assert.match(a.why ?? "", /^caught up by one poll after the stream stopped carrying x — its last catch-up failed, tried again after \d\d:\d\d UTC$/);
    assert.match(a.catchUp?.retryAt ?? "", /^\d{4}-\d\d-\d\dT/);
    psql(url, "INSERT INTO b VALUES (12, 'b still')");
    await until(async () => await read("SELECT v FROM public.b WHERE id = 12") === "b still", "b stays current", logged, 20_000);

    // THE WAY OUT: the sources file without x — copied again at once, caught up, streamed
    void sync.setTables(await pick(parsed.source, folder, [["public.a", ["id", "v"]], ["public.b", null]]));
    await until(() => logged.slice(from).some((l) => /^caught up public\.a by one poll after its copy/.test(l)), "a copied again and caught up", logged, 60_000);
    psql(url, "UPDATE a SET v = 'streamed again' WHERE id = 1");
    await sync.caughtUp();
    assert.equal(await read("SELECT id, v FROM public.a ORDER BY id"), psql(url, "SELECT id, v FROM a ORDER BY id"));
    assert.equal(sync.state().find((x) => x.source === "public.a")?.error, null);
  } finally {
    reader.closeSync();
    await sync.stop();
    store.close();
  }
});

// EACH TABLE KEPT CURRENT AS ITS SYNC SAYS, ONE PROJECT (issue 33, PR 2): `off`, `poll <interval>` and `replication` side
// by side — the stream through the project's one slot and its own publication, which carries the replicated tables
// alone; the polled table polled beside the stream; the off one read only when asked.
const cols2 = [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null }];
const tableOf = (name: string, sync: AddedTable["sync"]): AddedTable =>
  ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], bytes: 0, rows: null, foreignKeys: [], columns: cols2, ...(sync ? { sync } : {}) });
const OFF = { mode: "off" } as const;
const REPL = { mode: "replication" } as const;
const POLL = (every: string, seconds: number) => ({ mode: "poll", every, seconds }) as const;
const keptOf = (sync: Sync, source: string) => sync.state().find((s) => s.source === source)?.kept;
/** copied, caught up and kept as its sync says: a polled or off table with nothing pending, a replicated one streamed */
const settled = (sync: Sync, sources: readonly string[]) => () => sources.every((s) => {
  const k = keptOf(sync, s);
  return k?.by === "poll" ? k.pending === undefined && k.syncedAt !== null : k?.by === "replication" && k.state === "streamed";
});
const carried = (url: string, pub: string): string => psql(url, `SELECT string_agg(schemaname || '.' || tablename, ',' ORDER BY 1) FROM pg_publication_tables WHERE pubname = '${pub}'`);
const slotThere = (url: string, slot: string): boolean => psql(url, `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${slot}'`) === "1";
const pubThere = (url: string, pub: string): boolean => psql(url, `SELECT count(*) FROM pg_publication WHERE pubname = '${pub}'`) === "1";
/** the polls of `source` the log says ran after `from` (each poll's line names the tables it read) */
const pollsOf = (logged: readonly string[], from: number, source: string): number => logged.slice(from).filter((l) => l.startsWith("poll: ") && l.includes(` ${source} `)).length;

test("a mixed project: an off table unchanged, a poll 1s table polled beside the stream, two replicated tables streamed; the publication carries those two alone", { skip }, async () => {
  const db = `${tag}_mx`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, ["manual", "polled", "ra", "rb"].map((t) => `CREATE TABLE ${t} (id int PRIMARY KEY, v text); INSERT INTO ${t} SELECT g, '${t}' || g FROM generate_series(1, 5) g;`).join(" "));
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const names = { slot: `${tag}_mx`, publication: `${tag}_mx`, owned: true };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "mx.db"), (l) => logged.push(l));
  // the run's own mode is the poll's: each table names its own sync, the replicated ones through `names`
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "poll", names);
  const all = ["public.manual", "public.polled", "public.ra", "public.rb"];
  const same = async (t: string): Promise<boolean> => await rowsOf(store, `SELECT id, v FROM public.${t} ORDER BY 1`) === psql(url, `SELECT id, v FROM ${t} ORDER BY 1`);
  try {
    await sync.open();
    await sync.setTables([tableOf("manual", OFF), tableOf("polled", POLL("1s", 1)), tableOf("ra", REPL), tableOf("rb", REPL)]);
    sync.start();
    await until(settled(sync, all), "every table copied, caught up and kept as its sync says", logged);
    assert.equal(carried(url, names.publication), "public.ra,public.rb", "Mason's own publication carries the replicated tables alone");
    assert.ok(slotThere(url, names.slot));
    assert.equal(sync.streams(), true);
    // the stream's status names the replicated tables alone; each table's kept is its own sync's
    assert.deepEqual((await sync.streamStatus())!.tables.map((t) => [t.table, t.state]), [["public.ra", "streamed"], ["public.rb", "streamed"]]);
    assert.deepEqual(all.map((s) => keptOf(sync, s)?.by), ["poll", "poll", "replication", "replication"]);
    const manualSynced = (keptOf(sync, "public.manual") as { syncedAt: string }).syncedAt;

    // an INSERT, an UPDATE and a DELETE on each kind
    psql(url, ["manual", "polled", "ra", "rb"].map((t) => `INSERT INTO ${t} VALUES (6, 'new'); UPDATE ${t} SET v = 'changed' WHERE id = 2; DELETE FROM ${t} WHERE id = 3;`).join(" "));
    await sync.caughtUp();
    assert.ok(await same("ra") && await same("rb"), "the replicated tables streamed");
    await until(() => same("polled"), "the poll 1s table polled beside the stream", logged, 10_000);
    // the off table: as its copy left it, though every other kind moved
    assert.equal(await rowsOf(store, "SELECT id, v FROM public.manual ORDER BY 1"), ["1\tmanual1", "2\tmanual2", "3\tmanual3", "4\tmanual4", "5\tmanual5"].join("\n"), "an off table does not change");
    assert.equal((keptOf(sync, "public.manual") as { syncedAt: string }).syncedAt, manualSynced);
    // a replicated table is polled once, by its catch-up after its copy; the stream keeps it current from then on
    assert.deepEqual([pollsOf(logged, 0, "public.ra"), pollsOf(logged, 0, "public.rb")], [1, 1], logged.join("\n"));
    // a replicated table's kept: the stream's position, and its copy's age
    const ra = keptOf(sync, "public.ra");
    assert.ok(ra?.by === "replication" && /^[0-9A-F]+\/[0-9A-F]+$/.test(ra.position) && ra.syncedAt !== null && ra.notRunning === null, JSON.stringify(ra));

    // mason sync: the off table polled, the replicated one answered with the stream's position
    const asked = await sync.pollNow(["public.manual", "public.ra"]);
    assert.deepEqual(asked.tables.map((t) => [t.table, t.rows]), [["public.manual", 5]]);
    assert.deepEqual(asked.streamed?.map((t) => [t.table, t.state]), [["public.ra", "streamed"]]);
    assert.ok(await same("manual"), "mason sync syncs the off table");
  } finally { await sync.stop(); store.close(); }
});

// A CHANGE OF A TABLE'S SYNC KEEPS ITS COPY in every direction, caught up by ONE poll, never copied again — live
// (`setTables`, as mason add --sync does) and by hand while Mason is down (the ledger's record of its sync). The slot is
// dropped, VERIFIED gone, when the last replicated table leaves, and made again when one returns.
test("a switch in each direction keeps the copy, caught up by one poll; the slot goes with the last replicated table and comes back with the next", { skip }, async () => {
  const db = `${tag}_sw`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text); CREATE TABLE b (id int PRIMARY KEY, v text); " +
    "INSERT INTO a SELECT g, 'a' || g FROM generate_series(1, 20) g; INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 20) g");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const names = { slot: `${tag}_sw`, publication: `${tag}_sw`, owned: true };
  const logged: string[] = [];
  const recorded: boolean[] = [];
  const file = path.join(dir, "sw.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  const open = (): Sync => new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "poll", names, { onReplication: (made) => recorded.push(made) });
  let sync = open();
  const same = async (t: string): Promise<boolean> => await rowsOf(store, `SELECT id, v FROM public.${t} ORDER BY 1`) === psql(url, `SELECT id, v FROM ${t} ORDER BY 1`);
  const copiedAt = (t: string): string | null => sync.state().find((s) => s.source === `public.${t}`)!.copiedAt;
  const both = ["public.a", "public.b"];
  /** one switch: the change on the source first, the new syncs, then the copy equal to the source after exactly ONE poll
   *  of each switched table and no copy */
  const switched = async (syncs: Record<"a" | "b", AddedTable["sync"]>, changed: readonly ("a" | "b")[], step: string): Promise<void> => {
    const copies = [copiedAt("a"), copiedAt("b")];
    psql(url, changed.map((t) => `UPDATE ${t} SET v = '${step}' WHERE id = 1; INSERT INTO ${t} VALUES ((SELECT max(id) + 1 FROM ${t}), '${step}'); DELETE FROM ${t} WHERE id = (SELECT min(id) + 1 FROM ${t});`).join(" "));
    const from = logged.length;
    await sync.setTables([tableOf("a", syncs.a), tableOf("b", syncs.b)]);
    // the stream may apply the step's changes before a table leaves it, so equal is not yet caught up: its poll is awaited
    await until(async () => settled(sync, both)() && changed.every((t) => pollsOf(logged, from, `public.${t}`) > 0) && await same("a") && await same("b"),
      `${step}: both caught up and kept as their syncs say`, logged, 20_000);
    for (const t of changed) assert.equal(pollsOf(logged, from, `public.${t}`), 1, `${step}: ${t} caught up by exactly one poll\n${logged.slice(from).join("\n")}`);
    assert.deepEqual([copiedAt("a"), copiedAt("b")], copies, `${step}: never copied again`);
    assert.equal(logged.slice(from).filter((l) => /^copied public\./.test(l)).length, 0, `${step}: nothing copied\n${logged.slice(from).join("\n")}`);
  };
  try {
    await sync.open();
    await sync.setTables([tableOf("a", POLL("1h", 3600)), tableOf("b", REPL)]);
    sync.start();
    await until(settled(sync, both), "both copied and caught up", logged);
    assert.equal(carried(url, names.publication), "public.b");
    assert.deepEqual(recorded, [true], "the slot's making is told to the run, which records it");

    // poll → replication and replication → poll at once: the publication follows, verified
    await switched({ a: REPL, b: POLL("1h", 3600) }, ["a", "b"], "a in, b out");
    assert.equal(carried(url, names.publication), "public.a", "the publication carries the replicated table alone after the change");
    assert.ok(logged.includes("public.a: sync: poll 1h → replication: its copy is kept, and caught up by one poll now, then streamed"), logged.join("\n"));
    assert.ok(logged.some((l) => /^public\.b leaves the stream at [0-9A-F]+\/[0-9A-F]+: its sync is poll 1h now, so it is caught up by one poll from its watermark, then polled$/.test(l)), logged.join("\n"));
    psql(url, "UPDATE a SET v = 'streamed' WHERE id = 5");
    await sync.caughtUp();
    assert.ok(await same("a"), "a is streamed");

    // replication → off, the last replicated table: the slot and Mason's own publication dropped, verified gone
    await switched({ a: OFF, b: POLL("1h", 3600) }, ["a"], "a off");
    await until(() => !slotThere(url, names.slot) && !pubThere(url, names.publication), "the slot and the publication gone", logged, 20_000);
    assert.equal(sync.streams(), false);
    assert.equal(await sync.streamStatus(), null);
    assert.ok(logged.some((l) => l === `no table's sync is replication now: dropped replication slot ${names.slot} and publication ${names.publication} from ${db}, verified gone (the slot held the database's WAL) — a table set to sync: replication makes the slot again`), logged.join("\n"));
    assert.deepEqual(recorded, [true, false]);

    // off → replication: the slot made again, the table caught up under it and streamed
    await switched({ a: REPL, b: POLL("1h", 3600) }, ["a"], "a back");
    assert.ok(slotThere(url, names.slot), "the slot is there again");
    assert.equal(carried(url, names.publication), "public.a");
    assert.deepEqual(recorded, [true, false, true]);
    psql(url, "UPDATE a SET v = 'streamed again' WHERE id = 6");
    await sync.caughtUp();
    assert.ok(await same("a"));
  } finally { await sync.stop(); store.close(); }

  // BY HAND, while Mason is down: a replication → poll, b poll → replication — each caught up at the start
  psql(url, "UPDATE a SET v = 'while down' WHERE id = 7; UPDATE b SET v = 'while down' WHERE id = 7; INSERT INTO a VALUES (100, 'down'); INSERT INTO b VALUES (100, 'down')");
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = open();
  try {
    await sync.open();
    const from = logged.length;
    await sync.setTables([tableOf("a", POLL("1h", 3600)), tableOf("b", REPL)]);
    const copies = [copiedAt("a"), copiedAt("b")];
    assert.ok(copies.every((c) => c !== null), "both copies kept across the restart");
    sync.start();
    await until(async () => settled(sync, both)() && both.every((t) => pollsOf(logged, from, t) > 0) && await same("a") && await same("b"), "both caught up at the start", logged, 30_000);
    for (const t of both) assert.equal(pollsOf(logged, from, t), 1, `${t} caught up by exactly one poll at the start\n${logged.slice(from).join("\n")}`);
    assert.ok(logged.slice(from).includes("public.a: sync: replication → poll 1h: its copy is kept, and caught up by one poll now"), logged.slice(from).join("\n"));
    assert.ok(logged.slice(from).includes("public.b: sync: poll 1h → replication: its copy is kept, and caught up by one poll now, then streamed"), logged.slice(from).join("\n"));
    assert.deepEqual([copiedAt("a"), copiedAt("b")], copies, "never copied again");
    assert.equal(carried(url, names.publication), "public.b");
    psql(url, "UPDATE b SET v = 'streamed after the restart' WHERE id = 8");
    await sync.caughtUp();
    assert.ok(await same("b"));
  } finally { await sync.stop(); store.close(); }
});

test("a named publication is never altered by a sync change: a replicated table it lacks is refused with its ADD TABLE line, the polled table beside it goes on", { skip }, async () => {
  const db = `${tag}_np`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text); CREATE TABLE b (id int PRIMARY KEY, v text); CREATE TABLE c (id int PRIMARY KEY, v text); " +
    "INSERT INTO a SELECT g, 'a' || g FROM generate_series(1, 5) g; INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 5) g; INSERT INTO c SELECT g, 'c' || g FROM generate_series(1, 5) g; " +
    "CREATE PUBLICATION owners_pub FOR TABLE a");
  const definition = (): string => psql(url, "SELECT p.xmin, p.oid FROM pg_publication p WHERE pubname = 'owners_pub'") + "\n" + carried(url, "owners_pub");
  const defined = definition();
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "np.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "poll", { slot: `${tag}_np`, publication: "owners_pub", owned: false });
  const same = async (t: string): Promise<boolean> => await rowsOf(store, `SELECT id, v FROM public.${t} ORDER BY 1`) === psql(url, `SELECT id, v FROM ${t} ORDER BY 1`);
  try {
    await sync.open();
    await sync.setTables([tableOf("a", REPL), tableOf("b", REPL), tableOf("c", POLL("1s", 1))]);
    sync.start();
    await until(() => sync.state().find((s) => s.source === "public.b")?.error?.startsWith("replication: ") === true && settled(sync, ["public.a", "public.c"])(), "b refused, a and c kept", logged);
    const b = sync.state().find((s) => s.source === "public.b")!;
    assert.match(b.error!, /^replication: publication owners_pub does not carry what Mason's copy of the table holds\.\n/);
    assert.match(b.error!, /\n {2}ALTER PUBLICATION owners_pub ADD TABLE\n {4}public\.b \(id, v\);\n/);
    assert.match(b.error!, /give the table's entry sync: poll <interval> in the sources file/);
    psql(url, "UPDATE a SET v = 'streamed' WHERE id = 1; UPDATE c SET v = 'polled' WHERE id = 1");
    await sync.caughtUp();
    assert.ok(await same("a"), "the carried table streams on");
    await until(() => same("c"), "the polled table polled on", logged, 10_000);
  } finally { await sync.stop(); store.close(); }
  assert.equal(definition(), defined, "the named publication is never altered: byte-equal, its catalog row's version included");
});

test("REPLICA IDENTITY NOTHING under sync: replication is refused at the file's read, with the line to write, and by the run should it change after", { skip }, async () => {
  const db = `${tag}_ri`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text); CREATE TABLE n (id int PRIMARY KEY, v text); ALTER TABLE n REPLICA IDENTITY NOTHING; " +
    "INSERT INTO a SELECT g, 'a' || g FROM generate_series(1, 5) g; INSERT INTO n SELECT g, 'n' || g FROM generate_series(1, 5) g");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [A, N] = await tablesOf(parsed.source, ["public.a", "public.n"]);
  assert.deepEqual([A!.replicaIdentity, N!.replicaIdentity], ["d", "n"], "the catalog read says each table's replica identity");
  // at the file's read: one report, the line to write
  const { parseSourceText } = await import("../../src/cli/sources.ts");
  const file = parseSourceText("kind: postgres\nurl: x\nsync: replication\ntables:\n  a: {}\n  n: {}\n", "app", "/p/mason/sources/app.yml");
  if ("problems" in file) throw new Error(file.problems.join("; "));
  const refused = addedTables(file, [A!, N!] as unknown as Parameters<typeof addedTables>[1], db, "/p");
  assert.ok(!Array.isArray(refused));
  assert.equal(refused.message, "mason/sources/app.yml: tables.n: public.n has REPLICA IDENTITY NOTHING, and a publication carrying it would make your app's own UPDATEs and DELETEs on it fail (sync: replication) — " +
    "give its entry sync: poll <interval> (poll 5m), or sync: off; or ALTER TABLE public.n REPLICA IDENTITY DEFAULT on the database");
  // by the run: an identity changed after the start refuses the replicated tables, by name, and the polled one goes on
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "ri.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "poll", { slot: `${tag}_ri`, publication: `${tag}_ri`, owned: true });
  try {
    await sync.open();
    await sync.setTables([{ ...N!, sync: REPL }, { ...A!, sync: POLL("1s", 1) }]);
    sync.start();
    await until(() => (sync.state().find((s) => s.source === "public.n")?.error ?? "").includes("REPLICA IDENTITY NOTHING") && settled(sync, ["public.a"])(), "n refused, a polled", logged);
    assert.match(sync.state().find((s) => s.source === "public.n")!.error!, /^replication: public\.n has REPLICA IDENTITY NOTHING: .* Give its entry sync: poll <interval> \(poll 5m\) in the sources file/);
    assert.equal(psql(url, `SELECT count(*) FROM pg_publication WHERE pubname = '${tag}_ri'`), "0", "no publication carries it");
    psql(url, "UPDATE a SET v = 'polled' WHERE id = 1");
    await until(async () => await rowsOf(store, "SELECT v FROM public.a WHERE id = 1") === "polled", "the polled table polled on", logged, 10_000);
  } finally { await sync.stop(); store.close(); }
});
