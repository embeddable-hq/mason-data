/**
 * THE DUCKDB PROTOTYPE'S COPY AND SYNC AGAINST A REAL POSTGRES (src/duck/sync.ts, docs/DESIGN.md step 1).
 *
 * DuckDB's `<schema>.<table>` must equal the source, row for row, after every kind of change an app makes: an insert,
 * an update, a delete, a primary-key change, a row written inside a SAVEPOINT (its xmin is a subtransaction's), a
 * transaction OPEN across several polls that commits late (its rows' xmin is below the next poll's snapshot xmax but at
 * or past the watermark), a TRUNCATE, and a restart of the sync over the same file (the watermarks are kept). A
 * composite key and a schema of its own are exercised by the second table. Nothing is created on the source.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, and DuckDB's postgres extension (downloaded once per
 * machine). It writes only inside a database it creates, `it_duck_<random>`, and drops it at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { DuckConnection } from "../../src/duck/executor.ts";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import * as syncModule from "../../src/duck/sync.ts";
import { parseSource, type Source } from "../../src/cli/preflight.ts";
import { heldCopy } from "./held-copy.ts";

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { PollRefused } = syncModule as unknown as { PollRefused: typeof import("../../src/duck/sync.ts").PollRefused };

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_duck_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-duck-"));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

/**
 * WAITS UNTIL `table`'S ROWS ARE OLDER THAN EVERY SNAPSHOT'S XMIN on the cluster. A copy keeps only the rows written
 * before its first snapshot's xmin and leaves the rest to its catch-up (src/duck/sync.ts `copy`), and on the SHARED test
 * cluster another session's open transaction holds every snapshot's xmin back: a copy started then reads none of a
 * table just written (seen: "synced public.big: 0 row(s)", all 200,000 caught up) — correct, and nothing a test of the
 * copy's chunks or its stop can prove anything with.
 */
async function rowsOlderThanEverySnapshot(url: string, table: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  // the test cluster is in its first epoch: a 32-bit xmin and the snapshot's 64-bit one compare as they are
  while (psql(url, `SELECT (SELECT max(xmin::text::bigint) FROM ${table}) < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`) !== "t") {
    if (Date.now() > deadline) {
      throw new Error(`a transaction on the test cluster has been open since before ${table} was written, for 2 minutes: ` +
        psql(url, "SELECT string_agg(datname || ' pid ' || pid || ': ' || left(query, 60), '; ') FROM pg_stat_activity WHERE backend_xmin IS NOT NULL AND pid <> pg_backend_pid()"));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const ITEMS: AddedTable = {
  source: "public.items", schema: "public", table: "items", key: ["id"], bytes: 0, rows: null, foreignKeys: [],
  columns: [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null },
    { name: "n", type: "numeric(10,2)", notNull: false, comment: null }, { name: "meta", type: "jsonb", notNull: false, comment: null }],
};
const LINES: AddedTable = {
  source: "shop.lines", schema: "shop", table: "lines", key: ["order_id", "line"], bytes: 0, rows: null, foreignKeys: [],
  columns: [{ name: "order_id", type: "bigint", notNull: true, comment: null }, { name: "line", type: "integer", notNull: true, comment: null },
    { name: "qty", type: "integer", notNull: false, comment: null }],
};

test("the copy and the xmin poll keep DuckDB equal to the source through every kind of change", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE items (id int PRIMARY KEY, v text, n numeric(10,2), meta jsonb); CREATE SCHEMA shop; " +
    "CREATE TABLE shop.lines (order_id bigint, line int, qty int, PRIMARY KEY (order_id, line)); " +
    // each heap out of its key's order, as an app's table is after years of writes: the copy stores it in heap order
    "INSERT INTO items SELECT g, 'v' || g, g * 1.25, jsonb_build_object('g', g) FROM generate_series(1, 50) g ORDER BY (g * 37) % 101; " +
    "INSERT INTO shop.lines SELECT g / 3, g % 3, g FROM generate_series(1, 30) g ORDER BY (g * 13) % 31");
  const parsed = parseSource(dbUrl);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "duck.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, tag, (l) => logged.push(l), 3_600_000, "poll");
  await sync.open();
  sync.setTables([ITEMS, LINES]);

  const pgRows = (t: string, cols: string): string => psql(dbUrl, `SELECT ${cols} FROM ${t} ORDER BY 1, 2`);
  const duckRows = async (t: string, cols: string): Promise<string> =>
    ((await store.writer.runAndReadAll(`SELECT ${cols} FROM ${t} ORDER BY 1, 2`)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd();   // as psql's output is trimmed
  const same = async (step: string): Promise<void> => {
    await sync.once();
    assert.equal(await duckRows("public.items", "id, v, n::VARCHAR, meta::VARCHAR"), pgRows("items", "id, v, n::text, meta::text"), `items after ${step}\n${logged.slice(-5).join("\n")}`);
    assert.equal(await duckRows("shop.lines", "order_id, line, qty"), pgRows("shop.lines", "order_id, line, qty"), `shop.lines after ${step}`);
  };

  // a failed assertion must not leave the sync's timer running (it holds the test process open)
  try {
    await same("the first copy");
    // STORED IN THE SOURCE'S HEAP ORDER, WITH NO INDEX: DuckDB's rowid is its storage order, Postgres's ctid its heap's
    // (nothing moves a row in this database)
    const stored = async (t: string, key: string): Promise<string> =>
      ((await store.writer.runAndReadAll(`SELECT ${key} FROM ${t} ORDER BY rowid`)).getRowsJS() as unknown[][]).map((r) => r.join(",")).join(" ");
    const heap = (t: string, key: string): string => psql(dbUrl, `SELECT string_agg(concat_ws(',', ${key}), ' ' ORDER BY ctid) FROM ${t}`);
    assert.equal(await stored("public.items", "id"), heap("items", "id"), "items is stored as the source's scan delivered it");
    assert.equal(await stored("shop.lines", "order_id, line"), heap("shop.lines", "order_id, line"), "a composite key's table too");
    assert.notEqual(heap("items", "id"), psql(dbUrl, "SELECT string_agg(id::text, ' ' ORDER BY id) FROM items"), "the source's heap is not in key order (else this proves nothing)");
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_constraints() WHERE schema_name <> '_mason'")).getRowsJS(), [[0n]], "no PRIMARY KEY, UNIQUE or other constraint on a copy");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.rows]), [["public.items", "copied", 50], ["shop.lines", "copied", 30]]);
    // between passes the source is not attached: its path is the connection string, password included (the in-memory
    // catalog of the copies' visible columns, src/duck/kept-route.ts VISIBLE_CATALOG, is always there)
    assert.deepEqual((await store.writer.runAndReadAll("SELECT database_name FROM duckdb_databases() WHERE NOT internal AND database_name <> '__mason_visible' ORDER BY 1")).getRowsJS(), [["duck"]]);

    psql(dbUrl, "INSERT INTO items VALUES (51, 'new', 9.99, NULL); UPDATE items SET v = 'changed', n = NULL WHERE id = 2; DELETE FROM items WHERE id = 3; " +
      "UPDATE shop.lines SET qty = -1 WHERE order_id = 1; DELETE FROM shop.lines WHERE order_id = 2");
    // each copy's last sync: after its copy, the one poll that caught it up; once polled, that table's own poll
    // (src/duck/sync.ts Synced), and its rows the copy's after it
    const lastSync = (): unknown[] => sync.state().map((s) => { const x = (s as { synced?: { by: string; seconds: number | null } }).synced; return [s.source, x?.by, typeof x?.seconds]; });
    assert.deepEqual(lastSync(), [["public.items", "catch-up", "number"], ["shop.lines", "catch-up", "number"]]);
    const syncedBefore = (sync.state()[0] as { synced?: { at: string } }).synced?.at ?? "";
    await same("an insert, an update to NULL, a delete");
    assert.deepEqual(lastSync(), [["public.items", "poll", "number"], ["shop.lines", "poll", "number"]]);
    assert.ok(((sync.state()[0] as { synced?: { at: string } }).synced?.at ?? "") > syncedBefore, "a poll moves it");
    assert.deepEqual(sync.state().map((s) => s.rows), [50, 27], "the rows after the poll: 50 + 1 - 1, 30 - 3");

    psql(dbUrl, "UPDATE items SET id = 1000 WHERE id = 4; UPDATE shop.lines SET line = 9 WHERE order_id = 3 AND line = 0");
    await same("a primary-key change");

    psql(dbUrl, "BEGIN; INSERT INTO items VALUES (60, 'outer', 1, NULL); SAVEPOINT s; INSERT INTO items VALUES (61, 'savepoint', 2, NULL); RELEASE SAVEPOINT s; COMMIT");
    await same("a savepoint's row");

    // A TRANSACTION OPEN ACROSS POLLS: its insert and its update are invisible to the polls it spans, and arrive at the
    // first poll after its commit (its xid is at or past the watermark those polls recorded)
    const open = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", dbUrl], { stdio: ["pipe", "ignore", "pipe"] });
    // a failure below must not leave the transaction open (the DROP DATABASE in after() would wait on it)
    after(() => { if (open.exitCode === null) open.kill(); });
    open.stdin.write("BEGIN; INSERT INTO items VALUES (70, 'late', 7, NULL); UPDATE items SET v = 'late update' WHERE id = 10; SELECT pg_sleep(0);\n");
    await new Promise((r) => setTimeout(r, 500));
    psql(dbUrl, "INSERT INTO items VALUES (71, 'meanwhile', 8, NULL)");
    await same("a poll while a transaction is open");
    await same("a second poll while it is open");
    open.stdin.end("COMMIT;\n");
    await new Promise<void>((resolve, reject) => open.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`psql exited ${code}`))));
    await same("its commit");
    assert.equal(await duckRows("public.items", "id, v").then((r) => r.split("\n").find((l) => l.startsWith("10\t"))), "10\tlate update", "the late transaction's UPDATE arrived");

    psql(dbUrl, "TRUNCATE shop.lines");
    await same("a TRUNCATE");

    // A RESTART over the same file: the copy is not taken again, the watermarks are read back, and a change made while
    // nothing ran arrives
    await sync.stop();
    store.close();
    psql(dbUrl, "INSERT INTO items VALUES (80, 'while stopped', 8, NULL); INSERT INTO shop.lines VALUES (5, 1, 1)");
    store = await DuckStore.open(file, (l) => logged.push(l));
    sync = new Sync(store, parsed.source, tag, (l) => logged.push(l), 3_600_000, "poll");
    await sync.open();
    const before = logged.length;
    sync.setTables([ITEMS, LINES]);
    await same("a restart");
    assert.ok(!logged.slice(before).some((l) => /^synced /.test(l)), `no table is copied again at a restart:\n${logged.slice(before).join("\n")}`);
    assert.ok(logged.some((l) => /^poll: snapshot \d+ ms; public\.items \d+ changed in \d+ ms, counted in \d+ ms/.test(l)), "each poll's cost on the source is logged");
  } finally {
    await sync.stop();
    store.close();
  }
});

// A NUMERIC THE EXTENSION READS AS A DOUBLE (no precision, or more than 38 digits) is copied EXACTLY, as DECIMAL(38, s)
// from its text (src/duck/sync.ts NUMERIC_TYPE): every digit of 12.345678901234567890 and of a Prisma numeric(65,30)
// survives, where the extension's double keeps 15; a column whose values do not fit 38 digits, or hold a NaN, stays a
// double and the log says so; a later value with more decimals than the copy holds copies the table again, wider.
const AMOUNTS: AddedTable = {
  source: "public.amounts", schema: "public", table: "amounts", key: ["id"], bytes: 0, rows: null, foreignKeys: [],
  columns: [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "a", type: "numeric", notNull: false, comment: null },
    { name: "p", type: "numeric(65,30)", notNull: false, comment: null }, { name: "huge", type: "numeric", notNull: false, comment: null },
    { name: "odd", type: "numeric", notNull: false, comment: null }, { name: "q", type: "numeric(65,30)", notNull: false, comment: null }],
};

test("an unconstrained or wide numeric is copied and polled exactly, and copied again when a value outgrows it", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_n`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TABLE amounts (id int PRIMARY KEY, a numeric, p numeric(65,30), huge numeric, odd numeric, q numeric(65,30)); " +
    "INSERT INTO amounts VALUES (1, 12.345678901234567890, 19.99, 1e40, 'NaN', 19.99), (2, -0.5, 1234567.123456789012345678901234567891, 1, 2, 123456789012.5), (3, NULL, NULL, NULL, NULL, NULL)");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "numeric.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  await sync.open();
  sync.setTables([AMOUNTS]);
  const duck = async (sql: string): Promise<string[][]> =>
    ((await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)));
  const typesOf = async (): Promise<string> => (await duck("SELECT column_name || ' ' || data_type FROM information_schema.columns WHERE table_catalog = current_database() AND table_name = 'amounts' ORDER BY ordinal_position")).map((r) => r[0]).join(", ");
  // each value as Postgres spells it at the copy's scale: the exact digits, compared as text
  const same = async (step: string, scale: number, q = 2): Promise<void> => {
    await sync.once();
    assert.deepEqual(await duck("SELECT id, a::VARCHAR, p::VARCHAR, q::VARCHAR FROM public.amounts ORDER BY id"),
      psql(url, `SELECT id, a::numeric(38,${scale})::text, p::numeric(38,30)::text, q::numeric(38,${q})::text FROM amounts ORDER BY id`).split("\n").map((l) => [...l.split("\t"), "", "", ""].slice(0, 4)),   // psql's trim drops a NULL row's tabs
      `amounts after ${step}\n${logged.slice(-6).join("\n")}`);
  };

  // a failed assertion must not leave the sync's timer holding the process open
  try {
    await same("the first copy", 18);
    // q is a numeric(65,30) whose values use 2 decimals: 12 digits do not fit at 30, they do at 2 (the wire writes 30)
  assert.equal(await typesOf(), "id INTEGER, a DECIMAL(38,18), p DECIMAL(38,30), huge DOUBLE, odd DOUBLE, q DECIMAL(38,2)");
    assert.ok(logged.some((l) => /public\.amounts\.huge: values of 41 digit\(s\) and 0 decimal\(s\) do not fit the synced table's DECIMAL\(38\): synced as a double/.test(l)), logged.join("\n"));
    assert.ok(logged.some((l) => /public\.amounts\.odd: 1 value\(s\) NaN or Infinity/.test(l)), logged.join("\n"));
    assert.ok(logged.some((l) => /public\.amounts\.a: values of 1 to 18 decimals: Mason answers each with 18, Postgres with its own/.test(l)), logged.join("\n"));

    psql(url, "INSERT INTO amounts VALUES (4, 0.1, 0.000000000000000000000000000001, 7, 8, 0.5); UPDATE amounts SET a = 99.25, q = 7 WHERE id = 2");
    await same("a change that fits", 18);

    // more decimals than the copy's 18: the poll refuses to round it, and the table is copied again at 22
    psql(url, "UPDATE amounts SET a = 1.1234567890123456789012 WHERE id = 3");
    await sync.once();
    assert.ok(logged.some((l) => /poll: public\.amounts has a numeric value wider than its synced DECIMAL column: it is read again whole at the next pass/.test(l)), logged.slice(-6).join("\n"));
    await same("the copy again, wider", 22);
    assert.match(await typesOf(), /a DECIMAL\(38,22\)/);
    psql(url, "UPDATE amounts SET a = a + 1 WHERE id = 1");
    await same("a poll at the new width", 22);
    // a declared scale's value using more of it: copied again at 3
    psql(url, "UPDATE amounts SET q = 1.125 WHERE id = 1");
    await sync.once();
    await same("q copied again, wider", 22, 3);
    assert.match(await typesOf(), /q DECIMAL\(38,3\)/);
  } finally {
    await sync.stop();
    store.close();
  }
});

// A COLUMN ADDED TO A TABLE'S LIST copies that table again, and the other tables stay polled (the poll is one
// transaction over every table: one table's statement failing stalled them all, with nothing in the ledger); A PASS
// WITH THE SOURCE AWAY leaves every synced table copied, serving and in the catalog, its error said — and when the
// source is back the tables are polled, not copied whole again (a review finding).
test("a changed column list copies that table again; a source away is an error on the copies, never a re-copy", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_c`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TABLE a (id int PRIMARY KEY, v text, w text); CREATE TABLE b (id int PRIMARY KEY, v text); " +
    "INSERT INTO a SELECT g, 'v' || g, 'w' || g FROM generate_series(1, 3) g; INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 3) g");
  const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
  const table = (t: string, columns: AddedTable["columns"]): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows: null, foreignKeys: [], columns });
  const A2 = table("a", [col("id", "integer"), col("v", "text")]);
  const A3 = table("a", [col("id", "integer"), col("v", "text"), col("w", "text")]);
  const B = table("b", [col("id", "integer"), col("v", "text")]);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "columns.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  const count = async (t: string): Promise<number> => Number(((await store.writer.runAndReadAll(`SELECT count(*) FROM public.${t}`)).getRowsJS()[0] as [bigint])[0]);
  try {
    await sync.open();
    sync.setTables([A2, B]);
    await sync.once();
    psql(url, "INSERT INTO a VALUES (4, 'v4', 'w4'); INSERT INTO b VALUES (4, 'b4')");
    sync.setTables([A3, B]);
    await sync.once();
    assert.ok(logged.some((l) => /public\.a: its columns are not the ones it was synced with: it is read again whole/.test(l)), logged.join("\n"));
    assert.deepEqual((await store.writer.runAndReadAll("SELECT id, w FROM public.a ORDER BY id")).getRowsJS(), [[1, "w1"], [2, "w2"], [3, "w3"], [4, "w4"]]);
    assert.equal(await count("b"), 4, "b is polled beside a's new copy");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.a", "copied", null], ["public.b", "copied", null]]);
  } finally { await sync.stop(); store.close(); }

  // the source away: the same file, a port nothing listens on
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, { ...parsed.source, port: 1 }, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    sync.setTables([A3, B]);
    await sync.once();
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase]), [["public.a", "copied"], ["public.b", "copied"]]);
    assert.ok(sync.state().every((s) => /could not attach the database/.test(s.error ?? "")), JSON.stringify(sync.state()));
    assert.deepEqual(sync.schema().tables.map((t) => t.name).sort(), ["a", "b"], "the copies stay in the catalog");
    assert.equal(await count("a"), 4);
  } finally { await sync.stop(); store.close(); }

  // the source back: polled, not copied again; the error cleared
  psql(url, "INSERT INTO b VALUES (5, 'b5')");
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    const before = logged.length;
    sync.setTables([A3, B]);
    await sync.once();
    assert.ok(!logged.slice(before).some((l) => /^synced /.test(l)), logged.slice(before).join("\n"));
    assert.equal(await count("b"), 5);
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.a", "copied", null], ["public.b", "copied", null]]);
  } finally { await sync.stop(); store.close(); }
});

test("a stop interrupts a copy in flight: rolled back, said as stopped, never failed, nothing left beside the copy", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_s`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  // a store at the tests' memory limit: a copy of several seconds
  const ROWS = 400_000;
  psql(url, `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 16) FROM generate_series(1, ${ROWS}) g ORDER BY (g::bigint * 7919) % ${ROWS}`);
  // the copy reads them, so its scan is in flight when it is stopped
  await rowsOlderThanEverySnapshot(url, "big");
  const BIG: AddedTable = { source: "public.big", schema: "public", table: "big", key: ["id"], bytes: 0, rows: ROWS, foreignKeys: [],
    columns: [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null }] };
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "stop.db");
  // stopped once its snapshot is pinned: the scan of the source into the side table is in flight
  {
    const store: DuckStore = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
    const sync: Sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
    try {
      await sync.open();
      const from = logged.length;
      sync.setTables([BIG]);
      const deadline = Date.now() + 60_000;
      while (!logged.slice(from).some((l) => /^syncing public\.big as of the source's snapshot /.test(l))) {
        if (Date.now() > deadline) throw new Error(`the copy never said it pinned its snapshot within 60 s\n${logged.slice(from).join("\n")}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      const t0 = Date.now();
      await sync.stop();
      const ms = Date.now() - t0;
      const said = logged.slice(from).join("\n");
      assert.ok(!logged.slice(from).some((l) => /^synced public\.big/.test(l)), `the copy was stopped, not finished\n${said}`);
      assert.ok(ms < 2_000, `stopped in ${ms} ms: the copy was waited for, not interrupted\n${said}`);
      assert.ok(logged.slice(from).some((l) => l === "sync of public.big stopped: Mason is stopping (rolled back; it is synced at the next start)"), said);
      assert.ok(!/failed/.test(said), said);
      assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.big", "waiting", null]]);
      assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_tables() WHERE schema_name = 'public'")).getRowsJS(), [[0n]], "no side table is left");
    } finally { await sync.stop(); store.close(); }
  }
  // the next start: copied whole, every row in its place
  const store = await DuckStore.open(file, (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    assert.deepEqual(sync.state(), [], "nothing is added until the project says so");
    void sync.setTables([BIG]);
    await sync.once();
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error, s.rows]), [["public.big", "copied", null, ROWS]]);
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*), count(DISTINCT id), min(id), max(id) FROM public.big")).getRowsJS(), [[BigInt(ROWS), BigInt(ROWS), 1, ROWS]]);
  } finally { await sync.stop(); store.close(); }
});

// A COPY IN CHUNKS THAT RESUMES (the test server: a copy that failed at 90 % started from zero, reading the
// customer's replica again, ~738 GB over a day's attempts). A copy stopped after its first chunks keeps them — the
// chunk in flight alone rolled back — and the next start continues at the recorded page.
const RESUMED_ROWS = 200_000;
const RESUMED: AddedTable = { source: "public.big", schema: "public", table: "big", key: ["id"], bytes: 0, rows: RESUMED_ROWS, foreignKeys: [],
  columns: [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null }] };
/** where a copy of public.big is (`_mason.copy_progress` and its committed `copy_chunks`): the page before which every
 *  page is read and its rows so far, or undefined when no copy is in progress */
async function progressOf(c: DuckConnection): Promise<[bigint, bigint] | undefined> {
  const begun = (await c.runAndReadAll("SELECT count(*) FROM _mason.copy_progress WHERE source = 'public.big'")).getRowsJS()[0]![0] as bigint;
  const chunks = (await c.runAndReadAll("SELECT first_page, end_page, \"rows\" FROM _mason.copy_chunks WHERE source = 'public.big' ORDER BY first_page")).getRowsJS() as Array<[bigint, bigint | null, bigint]>;
  if (begun === 0n && chunks.length === 0) return undefined;
  let page = 0n;
  for (const [first, end] of chunks) { if (first !== page || end === null) break; page = end; }
  return [page, chunks.reduce((n, ch) => n + ch[2], 0n)];
}

/** a database of its own with `big` (RESUMED_ROWS rows, ~14 a page: ~14,000 pages), whose copy in chunks of ~10,000 rows
 *  is stopped once three are committed; answers where the copy stopped (its next page, its rows) and how to resume it */
async function copyStoppedPartWay(suffix: string): Promise<{ url: string; db: string; file: string; logged: string[]; stoppedAt: [bigint, bigint]; source: Source }> {
  const db = `${tag}_${suffix}`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 16) FROM generate_series(1, ${RESUMED_ROWS}) g ORDER BY (g::bigint * 7919) % ${RESUMED_ROWS}`);
  psql(url, "VACUUM ANALYZE big");
  await rowsOlderThanEverySnapshot(url, "big");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, `resume-${suffix}.db`);
  const store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
  // ONE READER: a copy that commits its chunks in page order (the readers N at a time have tests of their own)
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 1 });
  // read on a connection of the test's own: the copy's chunks commit on the sync's
  const reader = await store.instance.connect();
  try {
    await sync.open();
    const from = logged.length;
    sync.setTables([RESUMED]);
    // stopped once three chunks are committed: the next is in flight
    const deadline = Date.now() + 60_000;
    while (((await progressOf(reader))?.[1] ?? 0n) < 25_000n) {
      if (Date.now() > deadline) throw new Error(`three chunks were not committed within 60 s\n${logged.slice(from).join("\n")}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const t0 = Date.now();
    await sync.stop();
    const ms = Date.now() - t0;
    const said = logged.slice(from).join("\n");
    const stoppedAt = (await progressOf(reader))!;
    const [page, rows] = stoppedAt;
    assert.ok(ms < 2_000, `stopped in ${ms} ms: the chunk in flight was waited for, not interrupted\n${said}`);
    assert.ok(page > 0n && rows >= 25_000n && rows < BigInt(RESUMED_ROWS), `stopped part way: page ${page}, ${rows} rows\n${said}`);
    const stopLine = new RegExp(`^sync of public\\.big stopped: Mason is stopping \\(the chunks in flight rolled back; it continues at page ${page} of \\d+, ${rows} row\\(s\\) in at the next start\\)$`);
    assert.ok(logged.slice(from).some((l) => stopLine.test(l)), said);
    assert.ok(!/failed/.test(said), said);
    // only the committed chunks are in the side table: the one in flight rolled back whole
    assert.deepEqual((await reader.runAndReadAll(`SELECT count(*), count(DISTINCT id) FROM public.big${"__mason_copy"}`)).getRowsJS(), [[rows, rows]]);
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.big", "waiting", null]]);
    return { url, db, file, logged, stoppedAt, source: parsed.source };
  } finally { reader.closeSync(); await sync.stop(); store.close(); }
}

/** the resumed run (at the default memory limit: the comparison reads the table whole) to its catch-up, then `big` held
 *  equal to the source row for row, one row a key, nothing of the copy left beside it; answers what it said */
async function resumeToTheEnd(c: Awaited<ReturnType<typeof copyStoppedPartWay>>): Promise<string[]> {
  const store = await DuckStore.open(c.file, (l) => c.logged.push(l));
  const sync = new Sync(store, c.source, c.db, (l) => c.logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 1 });
  try {
    await sync.open();
    const from = c.logged.length;
    void sync.setTables([RESUMED]);
    await sync.once();
    const said = c.logged.slice(from);
    assert.ok(said.some((l) => l === "caught up public.big by one poll after its whole read: the poll keeps it current (polled every 1h)"), said.join("\n"));
    // a digest of every row in key order: 100 MB is past what psql hands back here
    const digest = "count(*) || ' ' || md5(string_agg(id::text || ':' || v, ',' ORDER BY id))";
    assert.equal(String((await store.writer.runAndReadAll(`SELECT ${digest} FROM public.big`)).getRowsJS()[0]![0]), psql(c.url, `SELECT ${digest} FROM big`),
      `public.big differs from the source after the resumed copy\n${said.join("\n")}`);
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) = count(DISTINCT id) FROM public.big")).getRowsJS(), [[true]]);
    assert.equal(await progressOf(store.writer), undefined, "the progress went with the swap");
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%__mason_copy'")).getRowsJS(), [[0n]]);
    return said;
  } finally { await sync.stop(); store.close(); }
}

// Held to the copy's FIRST snapshot: rows inserted, updated and deleted between the stop and the resume, on pages read
// before it and after it, are equal to the source once it is caught up, and no key is read twice (an update of a row
// already read writes its new version at the heap's end, past the stop: read under the new snapshot it would be the
// key's second row — without the hold, 250 keys of this test were).
test("a copy stopped after its first chunks resumes at its page, held to its first snapshot, and ends equal to the source", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const c = await copyStoppedPartWay("r");
  const { url, stoppedAt } = c;
  const ROWS = RESUMED_ROWS;
  // CHANGES BETWEEN THE STOP AND THE RESUME, on pages read before the stop and after it: the updated rows' new versions
  // are longer than the old, so they land at the heap's end (no page has room), which the resumed chunks read under a NEW
  // snapshot
  const [page] = stoppedAt;
  const early = psql(url, `SELECT string_agg(id::text, ',') FROM (SELECT id FROM big WHERE ctid < '(${page},0)'::tid ORDER BY ctid LIMIT 300) x`);
  const late = psql(url, `SELECT string_agg(id::text, ',') FROM (SELECT id FROM big WHERE ctid >= '(${page},0)'::tid ORDER BY ctid LIMIT 300) x`);
  psql(url, `UPDATE big SET v = 'updated after the stop ' || v WHERE id IN (${early}); DELETE FROM big WHERE id IN (SELECT id FROM big WHERE id IN (${early}) ORDER BY id LIMIT 50); ` +
    `UPDATE big SET v = 'updated late ' || v WHERE id IN (${late}); DELETE FROM big WHERE id IN (SELECT id FROM big WHERE id IN (${late}) ORDER BY id LIMIT 50); ` +
    `INSERT INTO big SELECT g, 'inserted after the stop' FROM generate_series(${ROWS + 1}, ${ROWS + 500}) g`);
  assert.ok(Number(psql(url, `SELECT count(*) FROM big WHERE v LIKE 'updated after the stop %' AND ctid >= '(${page},0)'::tid`)) > 0, "an early row's new version is past the stop (else this proves nothing)");
  const said = await resumeToTheEnd(c);
  const text = said.join("\n");
  assert.ok(said.some((l) => new RegExp(`^resuming the sync of public\\.big at page ${stoppedAt[0]} of \\d+, ${stoppedAt[1]} row\\(s\\) in, held to its first snapshot `).test(l)), text);
  assert.ok(!said.some((l) => /^syncing public\.big|over, from its first page/.test(l)), `not copied again from its first page\n${text}`);
  assert.ok(said.some((l) => new RegExp(`^synced public\\.big: .*resumed at page ${stoppedAt[0]} of \\d+ with ${stoppedAt[1]} row\\(s\\) in`).test(l)), text);
});

// A COPY THAT CANNOT BE HELD TO ITS FIRST SNAPSHOT STARTS OVER: a rewrite of the source table between the stop and the
// resume (VACUUM FULL here; CLUSTER, TRUNCATE and a column type change alike) moves its rows between pages, so the pages
// already read say nothing of the new file. The table's file is read after every chunk: the copy starts over, said.
test("a copy whose source table was rewritten since it began starts over from its first page, said, and ends equal to the source", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const c = await copyStoppedPartWay("w");
  psql(c.url, "DELETE FROM big WHERE id % 3 = 0");
  psql(c.url, "VACUUM FULL big");
  const said = await resumeToTheEnd(c);
  const text = said.join("\n");
  assert.ok(said.some((l) => /^resuming the sync of public\.big at page /.test(l)), text);
  assert.ok(said.some((l) => l === "starting the sync of public.big over, from its first page: the source rewrote public.big since its sync began (its file changed: a VACUUM FULL, CLUSTER, TRUNCATE or column type change), so its rows moved between pages"), text);
});

// CHUNKS READ N AT A TIME (the load kept on Mason's side; src/duck/sync.ts readChunks, COPY_PARALLEL):
// a copy's chunks are read by up to MASON_COPY_PARALLEL DuckDB connections at once, each one backend on the source,
// committing out of order, each recorded by its page range (`_mason.copy_chunks`).
const PARALLEL_ROWS = 200_000;

/** async psql: a test's read of the source while the sync's readers run on this event loop */
function psqlAsync(url: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql]);
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`psql: ${err.trim()}\n  in: ${sql}`)));
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** a database of its own with `big` (PARALLEL_ROWS rows, ~14 a page), copied in chunks of ~10,000 rows: ~20 chunks */
async function parallelDatabase(suffix: string): Promise<{ url: string; db: string; source: Source }> {
  const db = `${tag}_${suffix}`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 16) FROM generate_series(1, ${PARALLEL_ROWS}) g ORDER BY (g::bigint * 7919) % ${PARALLEL_ROWS}`);
  psql(url, "VACUUM ANALYZE big");
  await rowsOlderThanEverySnapshot(url, "big");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return { url, db, source: parsed.source };
}
const PARALLEL: AddedTable = { ...RESUMED, rows: PARALLEL_ROWS };
type Chunk = { first: number; end: number | null; reader: number; rows: number; phase: "read" | "committed" };
const committedOf = (events: readonly Chunk[]): Chunk[] => events.filter((e) => e.phase === "committed");
const overlaps = (a: Chunk, b: Chunk): boolean => a.first < (b.end ?? Infinity) && b.first < (a.end ?? Infinity);
/** the ranges tile the heap: from page 0, each starting where the one before ended, none twice, the last open-ended */
function assertTiles(ranges: readonly Chunk[], said: string): void {
  const sorted = [...ranges].sort((a, b) => a.first - b.first);
  assert.equal(sorted[0]?.first, 0, `the copy's chunks start at page 0\n${said}`);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i]!.first, sorted[i - 1]!.end, `every page in exactly one chunk: ${JSON.stringify(sorted.map((r) => [r.first, r.end]))}\n${said}`);
  assert.equal(sorted.at(-1)!.end, null, `the last chunk is open-ended\n${said}`);
}
/** the copy held equal to the source, a row for a key, nothing of it left beside it */
async function assertEqualToSource(store: DuckStore, url: string, said: string): Promise<void> {
  const digest = "count(*) || ' ' || md5(string_agg(id::text || ':' || v, ',' ORDER BY id))";
  assert.equal(String((await store.writer.runAndReadAll(`SELECT ${digest} FROM public.big`)).getRowsJS()[0]![0]), await psqlAsync(url, `SELECT ${digest} FROM big`),
    `public.big differs from the source\n${said}`);
  assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) = count(DISTINCT id) FROM public.big")).getRowsJS(), [[true]]);
  assert.deepEqual((await store.writer.runAndReadAll("SELECT (SELECT count(*) FROM _mason.copy_progress) + (SELECT count(*) FROM _mason.copy_chunks)")).getRowsJS(), [[0n]], "the progress went with the swap");
}

// Three readers at once — three backends on the source, each in its chunk's transaction, never more — and every
// chunk held to the copy's FIRST snapshot: rows updated, deleted and inserted while chunks are in flight, on pages read
// and not yet read, are equal to the source once the copy is caught up, one row a key.
test("a copy read three chunks at a time, on three backends, ends equal to the source after its catch-up", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const { url, db, source } = await parallelDatabase("p3");
  const logged: string[] = [];
  const events: Chunk[] = [];
  // the first three chunks read wait for each other inside their transactions: the source then holds three
  let reading = 0, backends = -1;
  let allIn!: () => void;
  const three = new Promise<void>((r) => { allIn = r; });
  const onChunk = async (e: Chunk): Promise<void> => {
    events.push(e);
    if (e.phase !== "read" || ++reading > 3) return;
    if (reading === 3) {
      backends = Number(await psqlAsync(url, `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}' AND application_name = '${syncModule.SOURCE_APPLICATION_NAME}' AND xact_start IS NOT NULL`));
      await psqlAsync(url, `UPDATE big SET v = 'changed mid-copy ' || v WHERE id % 97 = 0; DELETE FROM big WHERE id % 89 = 0; ` +
        `INSERT INTO big SELECT g, 'inserted mid-copy' FROM generate_series(${PARALLEL_ROWS + 1}, ${PARALLEL_ROWS + 500}) g`);
      allIn();
    }
    await Promise.race([three, sleep(10_000)]);
  };
  const store = await DuckStore.open(path.join(dir, "parallel.db"), (l) => logged.push(l));
  const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, onChunk });
  try {
    await sync.open();
    void sync.setTables([PARALLEL]);
    await sync.once();
    const said = logged.join("\n");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.big", "copied", null]], said);
    assert.equal(backends, 3, `three chunks in flight are three backends on the source\n${said}`);
    assert.deepEqual([...new Set(events.map((e) => e.reader))].sort(), [0, 1, 2], said);
    assert.ok(said.includes("3 at a time (MASON_COPY_PARALLEL), each a backend on the database"), said);
    assertTiles(committedOf(events), said);
    assert.equal(committedOf(events).length, events.filter((e) => e.phase === "read").length, "every chunk read was committed once");
    assert.ok(logged.includes("caught up public.big by one poll after its whole read: the poll keeps it current (polled every 1h)"), said);
    await assertEqualToSource(store, url, said);
  } finally { await sync.stop(); store.close(); }
});

// A copy that would fill the disk fails before it does (copyDiskProjection; the test server's copy of a
// 194 M-row table was at 49 GB with 75 GB free and nothing to say so): once 1% of the pages is read, what the pages
// left would add is held to what is free where the file is; past it the copy fails with the way out, as a failed copy
// does (its chunks kept, tried again after a wait), and the next attempt with room continues where it was.
test("a copy projected past the disk's free space fails with the way out, its chunks kept, and continues when there is room", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const { url, db, source } = await parallelDatabase("pd");
  const logged: string[] = [];
  const file = path.join(dir, "parallel-disk.db");
  {
    const store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "256MB" });
    const reader = await store.instance.connect();
    // one byte free where the file is: the first projection is past it
    const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, diskFree: () => 1 });
    try {
      await sync.open();
      void sync.setTables([PARALLEL]);
      await sync.once();
      const said = logged.join("\n");
      const [state] = sync.state();
      assert.equal(state?.phase, "failed", said);
      assert.match(state?.error ?? "", /^the sync of public\.big would need about [\d.]+ [KMG]iB more on disk than is free \(1 B free where .*parallel-disk\.db is; \d+ of \d+ pages read, [\d.]+ [KMG]iB added\): free some disk, mason remove public\.big, or mason add public\.big --columns … with fewer columns \(tried again after \d\d:\d\d UTC \(failure 1 in a row\)/, said);
      const kept = Number((await reader.runAndReadAll("SELECT count(*) FROM _mason.copy_chunks")).getRowsJS()[0]![0]);
      assert.ok(kept >= 1, `the chunks committed before the projection are kept: ${kept}\n${said}`);
      assert.ok(kept < Math.ceil(PARALLEL_ROWS / 10_000), `the copy stopped before its end: ${kept} chunk(s)\n${said}`);
    } finally { reader.closeSync(); await sync.stop(); store.close(); }
  }
  // room again at the next start (a start skips the wait): it continues where it was (the default memory: the equality
  // check at the end sorts the table)
  const store = await DuckStore.open(file, (l) => logged.push(l));
  const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, diskFree: () => 2 ** 40 });
  const from = logged.length;
  try {
    await sync.open();
    void sync.setTables([PARALLEL]);
    await sync.once();
    const then = logged.slice(from).join("\n");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.big", "copied", null]], then);
    assert.ok(logged.slice(from).some((l) => /^resuming the sync of public\.big at page \d+ of \d+/.test(l)), then);
    await assertEqualToSource(store, url, then);
  } finally { await sync.stop(); store.close(); }
});

// `mason stop` mid-copy at N=3: every chunk in flight is interrupted and rolled back, the committed ones kept, and the
// next start reads only the ranges no chunk committed — no chunk read twice, none skipped.
test("a copy at three readers stopped mid-way resumes with the ranges no chunk committed, none read twice", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const { url, db, source } = await parallelDatabase("ps");
  const logged: string[] = [];
  const file = path.join(dir, "parallel-stop.db");
  const before: Chunk[] = [];
  {
    const store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "256MB" });
    const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, onChunk: (e) => { before.push(e); } });
    const reader = await store.instance.connect();
    try {
      await sync.open();
      const from = logged.length;
      sync.setTables([PARALLEL]);
      const deadline = Date.now() + 60_000;
      while (committedOf(before).length < 4) {
        if (Date.now() > deadline) throw new Error(`four chunks were not committed within 60 s\n${logged.slice(from).join("\n")}`);
        await sleep(5);
      }
      const t0 = Date.now();
      await sync.stop();
      const ms = Date.now() - t0;
      const said = logged.slice(from).join("\n");
      assert.ok(ms < 2_000, `stopped in ${ms} ms: the chunks in flight were waited for, not interrupted\n${said}`);
      assert.ok(logged.slice(from).some((l) => /^sync of public\.big stopped: Mason is stopping \(the chunks in flight rolled back; it continues at page \d+ of \d+/.test(l)), said);
      assert.ok(!/failed/.test(said), said);
      const kept = committedOf(before);
      // only the committed chunks are in the side table and the ledger: those in flight rolled back whole
      assert.deepEqual((await reader.runAndReadAll("SELECT count(*), count(DISTINCT id) FROM public.big__mason_copy")).getRowsJS(),
        [[BigInt(kept.reduce((n, c) => n + c.rows, 0)), BigInt(kept.reduce((n, c) => n + c.rows, 0))]]);
      assert.deepEqual((await reader.runAndReadAll("SELECT first_page, end_page FROM _mason.copy_chunks ORDER BY 1")).getRowsJS(),
        [...kept].sort((a, b) => a.first - b.first).map((c) => [BigInt(c.first), c.end === null ? null : BigInt(c.end)]));
    } finally { reader.closeSync(); await sync.stop(); store.close(); }
  }
  const after_: Chunk[] = [];
  const store = await DuckStore.open(file, (l) => logged.push(l));
  const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, onChunk: (e) => { after_.push(e); } });
  try {
    await sync.open();
    const from = logged.length;
    void sync.setTables([PARALLEL]);
    await sync.once();
    const said = logged.slice(from).join("\n");
    assert.ok(logged.slice(from).some((l) => /^resuming the sync of public\.big at page \d+ of \d+.*, held to its first snapshot /.test(l)), said);
    assert.ok(!logged.slice(from).some((l) => /^syncing public\.big as of|over, from its first page/.test(l)), `not begun again\n${said}`);
    // nothing read again: no chunk of the resumed run touches a page a committed chunk of the first held
    for (const r of after_.filter((e) => e.phase === "read")) for (const k of committedOf(before)) assert.ok(!overlaps(r, k), `pages ${r.first}–${r.end} were read again\n${said}`);
    assertTiles([...committedOf(before), ...committedOf(after_)], said);
    await assertEqualToSource(store, url, said);
  } finally { await sync.stop(); store.close(); }
});

// A READER THAT FAILS (a crash, simulated by a thrown error) while the others hold chunks in flight: none of them
// commits after it — the chunk held read and uncommitted rolls back — and the next start reads exactly the ranges
// no chunk committed.
test("a reader failing with the others' chunks in flight: none commits after it, and the resume reads only the uncommitted ranges", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const { url, db, source } = await parallelDatabase("pc");
  const logged: string[] = [];
  const file = path.join(dir, "parallel-crash.db");
  const before: Chunk[] = [];
  let reads = 0;
  // set by the readers, read once they are done
  const seen: { crashed: Chunk | null; held: Chunk | null } = { crashed: null, held: null };
  const onChunk = async (e: Chunk): Promise<void> => {
    before.push(e);
    if (e.phase !== "read") return;
    reads++;
    if (reads === 5) {
      seen.crashed = e;
      // fails once another reader holds a chunk read and not yet committed
      for (const until = Date.now() + 10_000; seen.held === null && Date.now() < until;) await sleep(5);
      throw new Error("a reader's simulated crash");
    }
    // the next chunk read is held, uncommitted, past the failure
    if (reads === 6) { seen.held = e; await sleep(500); }
  };
  {
    const store = await DuckStore.open(file, (l) => logged.push(l));
    const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, onChunk });
    const reader = await store.instance.connect();
    try {
      await sync.open();
      const from = logged.length;
      void sync.setTables([PARALLEL]);
      await sync.once();
      const said = logged.slice(from).join("\n");
      assert.ok(logged.slice(from).some((l) => /^sync of public\.big failed: a reader's simulated crash; tried again after \d\d:\d\d UTC \(failure 1 in a row\).*; it continues at page \d+ of \d+/.test(l)), said);
      assert.deepEqual(sync.state().map((s) => [s.source, s.phase]), [["public.big", "failed"]]);
      const kept = committedOf(before);
      const { crashed, held } = seen;
      assert.ok(held !== null && crashed !== null, `another reader held a chunk in flight when one failed\n${said}`);
      for (const c of [crashed!, held!]) assert.ok(!kept.some((k) => k.first === c.first), `pages ${c.first}–${c.end} committed after the failure\n${said}`);
      assert.deepEqual((await reader.runAndReadAll("SELECT first_page, end_page FROM _mason.copy_chunks ORDER BY 1")).getRowsJS(),
        [...kept].sort((a, b) => a.first - b.first).map((c) => [BigInt(c.first), c.end === null ? null : BigInt(c.end)]));
      assert.deepEqual((await reader.runAndReadAll("SELECT count(*) FROM public.big__mason_copy")).getRowsJS(), [[BigInt(kept.reduce((n, c) => n + c.rows, 0))]]);
    } finally { reader.closeSync(); await sync.stop(); store.close(); }
  }
  // a restart tries a failed copy at once: it continues with the uncommitted ranges, the failed and the held one among them
  const after_: Chunk[] = [];
  const store = await DuckStore.open(file, (l) => logged.push(l));
  const sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyChunkRows: 10_000, copyParallel: 3, onChunk: (e) => { after_.push(e); } });
  try {
    await sync.open();
    const from = logged.length;
    void sync.setTables([PARALLEL]);
    await sync.once();
    const said = logged.slice(from).join("\n");
    assert.ok(logged.slice(from).some((l) => /^resuming the sync of public\.big at page \d+ of \d+/.test(l)), said);
    const read = after_.filter((e) => e.phase === "read");
    for (const r of read) for (const k of committedOf(before)) assert.ok(!overlaps(r, k), `pages ${r.first}–${r.end} were read again\n${said}`);
    for (const c of [seen.crashed!, seen.held!]) assert.ok(read.some((r) => overlaps(r, c)), `pages ${c.first}–${c.end}, uncommitted, were read by the resume\n${said}`);
    assertTiles([...committedOf(before), ...committedOf(after_)], said);
    await assertEqualToSource(store, url, said);
  } finally { await sync.stop(); store.close(); }
});

// CHUNKS SIZED BY THE TIME THEY TAKE HERE, AND PROGRESS BETWEEN COMMITS (a laptop copying a 20 M-row table over the
// internet showed no progress, its first line waiting on 0 for ages and then jumping to 100%; src/duck/sync.ts
// nextChunkPages, nextRate, copyProgressNow). A reader slowed on purpose inside each chunk's
// read (onChunk, within its timed transaction), fast over the first half of the heap and eight times slower over the
// second: the chunks follow the measured rate down, so the second half has more of them, every chunk's size is the
// sizing function of the rate recorded before it, the copy's rows move at every commit, and while a chunk reads the
// copy's state says so (the chunks reading, for how long, what they have read by now).
test("a copy's chunks are sized by the rate measured on its connection, and its state moves while a chunk reads", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async (t) => {
  type Rate = { pagesPerSecond: number; rowsPerSecond: number; bytesPerSecond: number; chunks: number };
  type Event = Chunk & { pages?: number; ceiling?: number; sizedBy?: Rate | null; seconds?: number };
  type View = { chunksDone: number; chunksTotal: number; reading: number; readingSeconds: number | null; rowsReading: number; rowsPerSecond: number | null; secondsLeft: number | null; share: number };
  const { nextChunkPages, nextRate } = syncModule as unknown as {
    nextChunkPages?: (ceiling: number, rate: Rate | null, seconds: number) => number;
    nextRate?: (prev: Rate | null, m: { pages: number; rows: number; seconds: number; blockSize: number }) => Rate;
  };
  const { url, db, source } = await parallelDatabase("ts");
  const pages = Number(psql(url, "SELECT pg_relation_size('big') / current_setting('block_size')::int"));
  const blockSize = Number(psql(url, "SELECT current_setting('block_size')"));
  const SECONDS = 0.5;
  // a reader's link: 4,000 pages a second over the first half of the heap, 500 over the second
  const pagesPerSecond = (first: number): number => first < pages / 2 ? 4_000 : 500;
  const logged: string[] = [];
  const events: Event[] = [];
  const seen: Array<{ phase: string; rowsSoFar: number | null | undefined; progress: View | undefined; committed: number; waited: number }> = [];
  let committed = 0;
  let sync!: InstanceType<typeof Sync>;
  const stateOf = (): { rowsSoFar?: number | null; progress?: View } => sync.state().find((s) => s.source === "public.big") as { rowsSoFar?: number | null; progress?: View };
  const onChunk = async (e: Event): Promise<void> => {
    events.push(e);
    if (e.phase === "read") {
      const waited = Math.round(((e.end ?? pages) - e.first) / pagesPerSecond(e.first) * 1000);
      await sleep(waited);
      const st = stateOf();
      seen.push({ phase: "read", rowsSoFar: st.rowsSoFar, progress: st.progress, committed, waited });
    } else {
      committed += e.rows;
      const st = stateOf();
      seen.push({ phase: "committed", rowsSoFar: st.rowsSoFar, progress: st.progress, committed, waited: 0 });
    }
  };
  const store = await DuckStore.open(path.join(dir, "timed.db"), (l) => logged.push(l));
  // the row estimate's ceiling is the whole heap: only the measured rate cuts it
  sync = new Sync(store, source, db, (l) => logged.push(l), 3_600_000, "poll", null,
    { copyChunkRows: PARALLEL_ROWS, copyParallel: 1, copyChunkSeconds: SECONDS, onChunk });
  try {
    await sync.open();
    void sync.setTables([PARALLEL]);
    await sync.once();
    const said = logged.join("\n");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.big", "copied", null]], said);
    assert.ok(nextChunkPages && nextRate, "the sync sizes its chunks by the rate it measures (nextChunkPages, nextRate)");
    const done = committedOf(events) as Event[];
    assertTiles(done, said);
    const ceiling = done[0]!.ceiling!;
    assert.equal(ceiling, pages, "the estimate's ceiling is the heap");
    // EVERY CHUNK'S SIZE IS THE SIZING FUNCTION OF THE RATE RECORDED BEFORE IT (one reader: in order)
    let rate: Rate | null = null;
    for (const [i, e] of done.entries()) {
      assert.deepEqual(e.sizedBy, rate, `chunk ${i} was sized by the rate of the chunks before it`);
      if (i < done.length - 1) assert.equal(e.pages, nextChunkPages(ceiling, rate, SECONDS), `chunk ${i} at page ${e.first}`);
      assert.ok(e.seconds !== undefined && e.seconds * 1000 >= seen.filter((x) => x.phase === "read")[i]!.waited, `chunk ${i}'s seconds include its read`);
      rate = nextRate(rate, { pages: e.pages!, rows: e.rows, seconds: e.seconds!, blockSize });
    }
    const sizes = done.map((e) => `${e.first}+${e.pages}`).join(" ");
    t.diagnostic(`${pages} pages in ${done.length} chunks (page+pages): ${sizes}`);
    assert.ok(done[0]!.pages! < pages / 5, `a small first chunk, to measure: ${done[0]!.pages} of ${pages}`);
    // THE CHUNK COUNT GREW AS THE RATE FELL: the slow half of the heap took more, smaller chunks than the fast half
    const fast = done.slice(1).filter((e) => e.first + e.pages! <= pages / 2), slow = done.filter((e) => e.first >= pages / 2 + 2 * ceiling / 10);
    const median = (xs: Event[]): number => { const v = xs.map((e) => e.pages!).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]!; };
    assert.ok(fast.length >= 2 && slow.length >= 2, `chunks in each half: ${sizes}`);
    assert.ok(median(slow) < median(fast) / 2, `the slow half's chunks are smaller (median ${median(slow)} against ${median(fast)}): ${sizes}`);
    assert.ok(done.filter((e) => e.first >= pages / 2).length > done.filter((e) => e.first < pages / 2).length, `more chunks over the slow half: ${sizes}`);
    // THE ROWS MOVE AT EVERY COMMIT: the state's rows are the committed chunks' as each commit is told
    const commits = seen.filter((x) => x.phase === "committed");
    assert.equal(commits.length, done.length);
    for (const c of commits) assert.equal(c.rowsSoFar, c.committed, "rowsSoFar is every committed chunk's rows, at each commit");
    // WHILE A CHUNK READS, THE STATE SAYS SO: one chunk reading, for at least as long as it has slept, and once a rate
    // is measured, the rows it has read by now — under what it will commit
    const reads = seen.filter((x) => x.phase === "read");
    let share = -1, firstShare: number | null = null;
    for (const [i, r] of reads.entries()) {
      const p = r.progress;
      if (p === undefined) throw new Error(`chunk ${i}: the copy's state carries no progress while it reads`);
      assert.equal(p.reading, 1, `chunk ${i}: one chunk reading`);
      assert.ok(p.readingSeconds !== null && p.readingSeconds * 1000 >= r.waited - 5, `chunk ${i}: reading for ${p.readingSeconds} s, slept ${r.waited} ms`);
      assert.equal(p.chunksDone, i);
      assert.equal(r.rowsSoFar ?? 0, r.committed, `chunk ${i}: only committed rows are rowsSoFar`);
      // the share of the heap's pages read: exact ranges, never backwards — and below 1 until the copy is done, so
      // it is CAPPED at 0.99 (copyProgressNow) and the last chunks' readings are equal, never larger: not strictly
      // increasing (a flake at the 18th chunk or so, 2 of 3 runs alone)
      assert.ok(p.share >= share && p.share < 1, `chunk ${i}: a share of ${p.share} after ${share}`);
      share = p.share; firstShare ??= p.share;
      if (i === 0) assert.deepEqual([p.rowsPerSecond, p.rowsReading], [null, 0], "nothing measured during the first chunk");
      else {
        assert.ok(p.rowsPerSecond !== null && p.rowsPerSecond > 0 && p.secondsLeft !== null, `chunk ${i}: a measured rate and time left`);
        assert.ok(p.rowsReading > 0 && p.rowsReading < done[i]!.rows, `chunk ${i}: ${p.rowsReading} rows read by now, under its ${done[i]!.rows}`);
      }
    }
    assert.ok(firstShare !== null && share > firstShare, `the share moved while the chunks read: ${firstShare} to ${share}`);
    assert.ok(said.includes("in chunks sized to ~0.5 s of reading each at the rate measured here (MASON_COPY_CHUNK_SECONDS"), said);
    await assertEqualToSource(store, url, said);
  } finally { await sync.stop(); store.close(); }
});

// AN ENUM ARRAY THROUGH A PASSTHROUGH READ: every chunk of a copy, and every poll, reads the source through
// `postgres_query`, which hands an enum array over as one VARCHAR ('{sad,ok}') that DuckDB cannot cast to its
// ENUM(...)[] — the oracle's `moods` failed to copy once the copy was chunked, and a change to such a row had always
// failed its poll. Read as text[] (src/duck/sync.ts pgColumnSql), both arrive whole.
test("an enum array is copied and polled whole, a schema's own enum too", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_e`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TYPE mood AS ENUM ('sad', 'ok', 'it''s'); CREATE SCHEMA other; CREATE TYPE other.level AS ENUM ('low', 'high'); " +
    "CREATE TABLE moods (id int PRIMARY KEY, m mood, ms mood[], ls other.level[]); " +
    "INSERT INTO moods VALUES (1, 'sad', '{sad,it''s}', '{low}'), (2, NULL, '{}', NULL), (3, 'ok', '{ok,NULL}', '{high,low}')");
  const col = (name: string, type: string) => ({ name, type, notNull: name === "id", comment: null });
  const MOODS: AddedTable = { source: "public.moods", schema: "public", table: "moods", key: ["id"], bytes: 0, rows: 3, foreignKeys: [],
    columns: [col("id", "integer"), col("m", "mood"), col("ms", "mood[]"), col("ls", "other.level[]")] };
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "enums.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  const rows = async (): Promise<string> => ((await store.writer.runAndReadAll("SELECT id, m::VARCHAR, ms::VARCHAR, ls::VARCHAR FROM public.moods ORDER BY id")).getRowsJS() as unknown[][])
    .map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  try {
    await sync.open();
    void sync.setTables([MOODS]);
    await sync.once();
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.moods", "copied", null]], logged.join("\n"));
    assert.equal(await rows(), "1\tsad\t[sad, 'it\\'s']\t[low]\n2\t\t[]\t\n3\tok\t[ok, NULL]\t[high, low]");
    psql(url, "UPDATE moods SET ms = '{ok,sad}', ls = '{high}' WHERE id = 1; INSERT INTO moods VALUES (4, 'it''s', '{it''s}', '{}')");
    await sync.once();
    assert.ok(!logged.some((l) => /failed/.test(l)), logged.join("\n"));
    assert.equal(await rows(), "1\tsad\t[ok, sad]\t[high]\n2\t\t[]\t\n3\tok\t[ok, NULL]\t[high, low]\n4\tit's\t['it\\'s']\t[]");
  } finally { await sync.stop(); store.close(); }
});

// SMALLEST FIRST (the test server: three small tables waited the 23 minutes of a 196 M-row copy): tables
// added together are copied in the order of the catalog's row estimate, whatever order the project lists them in.
test("tables added together are copied smallest first by the catalog's estimate", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_o`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TABLE a_big (id int PRIMARY KEY); INSERT INTO a_big SELECT generate_series(1, 5000); " +
    "CREATE TABLE b_mid (id int PRIMARY KEY); INSERT INTO b_mid SELECT generate_series(1, 500); CREATE TABLE c_small (id int PRIMARY KEY); INSERT INTO c_small VALUES (1)");
  const table = (t: string, rows: number): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows, foreignKeys: [],
    columns: [{ name: "id", type: "integer", notNull: true, comment: null }] });
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "order.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    // listed biggest first, and in the order of their names
    void sync.setTables([table("a_big", 5000), table("b_mid", 500), table("c_small", 1)]);
    await sync.once();
    const copies = logged.flatMap((l) => /^syncing public\.(\w+): /.exec(l)?.[1] ?? []);
    assert.deepEqual(copies, ["c_small", "b_mid", "a_big"], logged.join("\n"));
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.rows]).sort(), [["public.a_big", "copied", 5000], ["public.b_mid", "copied", 500], ["public.c_small", "copied", 1]]);
  } finally { await sync.stop(); store.close(); }
});

// A COPY THAT FAILS (the test server: a copy failing for good read a production replica whole for 20 minutes at
// every pass) WAITS before it is tried again (`copyRetryDelayMs`), its error saying when, and leaves nothing beside the
// copy; a restart, or a change of the table's columns, tries at once. The failure here is a value DuckDB's scanner
// cannot read: a two-dimensional array in a column it reads as a list.
test("a failed copy waits before it is tried again, and a change of its columns tries it at once", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_f`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TABLE t (id int PRIMARY KEY, v text, grid int[]); INSERT INTO t SELECT g, 'v' || (g % 10), '{{1,2},{3,4}}' FROM generate_series(1, 100) g");
  const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
  const T = (grid: boolean): AddedTable => ({ source: "public.t", schema: "public", table: "t", key: ["id"], bytes: 0, rows: 100, foreignKeys: [],
    columns: [col("id", "integer"), col("v", "text"), ...(grid ? [col("grid", "integer[]")] : [])] });
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "failed.db");
  const since = (from: number, re: RegExp): number => logged.slice(from).filter((l) => re.test(l)).length;
  const tablesLeft = async (store: DuckStore): Promise<unknown> => (await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_tables() WHERE schema_name = 'public'")).getRowsJS();
  let store = await DuckStore.open(file, (l) => logged.push(l));
  // the sync's events (src/duck/events.ts): the failure is one, with the log's words
  const events: Array<{ kind: string; table: string | null; message: string }> = [];
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll", null, { onEvent: (e) => { events.push(e); } });
  try {
    await sync.open();
    let from = logged.length;
    void sync.setTables([T(true)]);
    await sync.once();
    assert.deepEqual(events.map((e) => [e.kind, e.table]), [["copy_failed", "public.t"]]);
    assert.equal(`sync of public.t failed: ${events[0]!.message}`, logged.find((l) => l.startsWith("sync of public.t failed: ")));
    assert.equal(since(from, /^syncing public\.t:/), 1, logged.slice(from).join("\n"));
    assert.equal(since(from, /^sync of public\.t failed: [\s\S]*; tried again after \d\d:\d\d UTC \(failure 1 in a row\)/), 1, logged.slice(from).join("\n"));
    const [st] = sync.state();
    assert.equal(st?.phase, "failed");
    assert.match(st?.error ?? "", /\(tried again after \d\d:\d\d UTC \(failure 1 in a row\), or at once when Mason starts again or its columns or key change\)$/);
    assert.deepEqual(await tablesLeft(store), [[0n]], "nothing is left beside the copy");
    // the next pass: not tried, it waits its turn
    from = logged.length;
    await sync.once();
    assert.equal(since(from, /public\.t/), 0, logged.slice(from).join("\n"));
  } finally { await sync.stop(); store.close(); }

  // a restart tries at once (and fails again); the columns changed (the fix): tried at once, and copied
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    let from = logged.length;
    void sync.setTables([T(true)]);
    await sync.once();
    assert.equal(since(from, /^sync of public\.t failed: [\s\S]* \(failure 1 in a row\)/), 1, logged.slice(from).join("\n"));
    from = logged.length;
    void sync.setTables([T(false)]);
    await sync.once();
    assert.equal(since(from, /^syncing public\.t:/), 1, logged.slice(from).join("\n"));
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error, s.rows]), [["public.t", "copied", null, 100]]);
  } finally { await sync.stop(); store.close(); }
});

// A FAILED CATCH-UP WAITS AS A FAILED COPY DOES, AND SAYS WHEN (the test server: a catch-up that failed was said as
// "tried again at the next pass" and, in replication mode, never was; in poll mode it was tried again at every pass,
// each reading the source). Its whole error and the time of its next attempt are in the log and in mason status; a
// change of its columns copies the table again at once. The failure here: a table copied, marked behind as a run that stopped
// between its swap and its catch-up leaves it (`_mason.catch_up`), whose source column changed type meanwhile.
test("a failed catch-up waits before it is tried again, said with its time; a change of its columns copies it again at once", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_c`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TABLE t (id int PRIMARY KEY, n int); INSERT INTO t SELECT g, g FROM generate_series(1, 20) g");
  const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
  const T = (n: string): AddedTable => ({ source: "public.t", schema: "public", table: "t", key: ["id"], bytes: 0, rows: 20, foreignKeys: [], columns: [col("id", "integer"), col("n", n)] });
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "catchup.db");
  const since = (from: number, re: RegExp): string[] => logged.slice(from).filter((l) => re.test(l));
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try { await sync.open(); void sync.setTables([T("integer")]); await sync.once(); }
  finally { await sync.stop(); store.close(); }
  // stopped between its swap and its catch-up; meanwhile the source's column becomes text no copy of it can hold
  store = await DuckStore.open(file, (l) => logged.push(l));
  await store.writer.run("INSERT OR REPLACE INTO _mason.catch_up VALUES ('public.t', 'after its whole read', now())");
  store.close();
  psql(url, "ALTER TABLE t ALTER COLUMN n TYPE text USING n::text; UPDATE t SET n = 'not a number' WHERE id = 1");
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    let from = logged.length;
    void sync.setTables([T("integer")]);
    await sync.once();
    const failed = since(from, /^public\.t: its catch-up poll failed/);
    assert.equal(failed.length, 1, logged.slice(from).join("\n"));
    assert.match(failed[0]!, /^public\.t: its catch-up poll failed \(the synced data serves as it was; it is caught up by one poll again after \d\d:\d\d UTC \(failure 1 in a row\), or at once when Mason starts again or its columns or key change\): \S/);
    // in mason status: the table's error says it, with the time
    assert.equal(sync.state()[0]?.error, failed[0]!.slice("public.t: ".length));
    // the next pass: not tried again, it waits its turn
    from = logged.length;
    await sync.once();
    assert.deepEqual(since(from, /public\.t/), [], "a failed catch-up is not tried at every pass");
    // the way out: its columns as the source has them, copied again at once
    from = logged.length;
    void sync.setTables([T("text")]);
    await sync.once();
    assert.equal(since(from, /^syncing public\.t:/).length, 1, logged.slice(from).join("\n"));
    assert.equal(since(from, /^caught up public\.t by one poll after its whole read/).length, 1, logged.slice(from).join("\n"));
    assert.deepEqual(sync.state().map((s) => [s.phase, s.error, s.rows]), [["copied", null, 20]]);
    assert.equal(((await store.writer.runAndReadAll("SELECT n FROM public.t WHERE id = 1")).getRowsJS() as unknown[][])[0]![0], "not a number");
  } finally { await sync.stop(); store.close(); }
});

// AFTER A RESTART THE COPIED TABLES ARE SERVED AT ONCE (the test server: the catalog was empty until the start's
// first pass ended, hours behind a large copy, and every synced table was "not added"): the catalog is rebuilt when
// the project's tables are set, on a connection of its own that a copy's transaction never holds. big's copy is HELD
// by the test (`heldCopy`) until the catalog is read, so "still copying" holds by construction, not by its size.
test("after a restart the copied tables are in the catalog at once, while another table is still copying", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_r`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  const ROWS = 20_000;
  psql(url, `CREATE TABLE small (id int PRIMARY KEY, v text); INSERT INTO small VALUES (1, 'a'), (2, 'b'); ` +
    `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 16) FROM generate_series(1, ${ROWS}) g ORDER BY (g::bigint * 7919) % ${ROWS}`);
  // the copy reads big's rows (not all left to its catch-up), so its chunks are read, and held
  await rowsOlderThanEverySnapshot(url, "big");
  const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
  const table = (t: string, rows: number): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows, foreignKeys: [], columns: [col("id", "integer"), col("v", "text")] });
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "restart.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    void sync.setTables([table("small", 2)]);
    await sync.once();
    assert.deepEqual(sync.schema().tables.map((t) => t.name), ["small"]);
  } finally { await sync.stop(); store.close(); }

  store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
  const big = heldCopy("public.big");
  sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll", null, { onChunk: big.onChunk });
  try {
    await sync.open();
    await sync.setTables([table("small", 2), table("big", ROWS)]);
    assert.notEqual(sync.state().find((s) => s.source === "public.big")?.phase, "copied", "the pass is still copying big");
    assert.deepEqual(sync.schema().tables.map((t) => t.name), ["small"], "small is served before the pass ends");
    // and while big's copy is in flight: held in its chunks
    const deadline = Date.now() + 60_000;
    while (!big.held()) {
      if (Date.now() > deadline) throw new Error(`big's copy never reached its first chunk within 60 s\n${logged.slice(-12).join("\n")}`);
      await sleep(20);
    }
    assert.equal(sync.state().find((s) => s.source === "public.big")?.phase, "copying", "big is copying");
    assert.deepEqual(sync.schema().tables.map((t) => t.name), ["small"], "small is served while big copies");
    big.release();
    await sync.once();
    assert.deepEqual(sync.schema().tables.map((t) => t.name).sort(), ["big", "small"]);
  } finally { big.release(); await sync.stop(); store.close(); }
});

// HEAP ORDER, NO INDEX (the test server's time-window queries each
// scanned all 195 M rows of a copy in uuid-key order). A table inserted in time order and out of key order is copied as
// the source's scan delivers it, in ONE transaction at the tests' 64 MB (src/duck/sync.ts `copy`): its rows in the
// heap's order, no constraint, nothing left beside it, and a filter on its time column reads a fraction of its row
// groups (the zonemaps prune).
test("a copy is stored in the source's heap order with no index, and a time window reads a fraction of its row groups", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_p`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  const ROWS = 400_000;
  // a random uuid key, rows inserted in time order, a wide payload, an interval DuckDB holds as its own
  psql(url, `CREATE TABLE events (id uuid PRIMARY KEY, created_at timestamptz NOT NULL, payload jsonb, i interval); ` +
    `INSERT INTO events SELECT md5(g::text)::uuid, timestamptz '2026-01-01' + g * interval '30 s', jsonb_build_object('g', g, 'pad', repeat(md5(g::text), 8)), make_interval(days => -g) FROM generate_series(1, ${ROWS}) g`);
  // the copy reads them (not its catch-up): its order is the one in question
  await rowsOlderThanEverySnapshot(url, "events");
  const col = (name: string, type: string, notNull = false) => ({ name, type, notNull, comment: null });
  const EVENTS: AddedTable = { source: "public.events", schema: "public", table: "events", key: ["id"], bytes: 0, rows: ROWS, foreignKeys: [],
    columns: [col("id", "uuid", true), col("created_at", "timestamp with time zone", true), col("payload", "jsonb"), col("i", "interval")] };
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "heap.db"), (l) => logged.push(l), { memoryLimit: "64MB" });
  // ONE READER: heap order is per chunk, and the chunks lie in their commit order ("Chunks read N at a time"); since
  // chunks are sized by time (a small first one to measure) this table is several, which N readers commit out of order
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll", null, { copyParallel: 1 });
  const rows = async (sql: string): Promise<unknown[][]> => (await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][];
  try {
    await sync.open();
    void sync.setTables([EVENTS]);
    await sync.once();
    const said = logged.join("\n");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error, s.rows]), [["public.events", "copied", null, ROWS]], said);
    // the source's rows, each once, as the heap holds them: the first 20 in rowid order are the heap's first 20, and no
    // row is earlier than the row before it
    assert.equal((await rows("SELECT id::VARCHAR FROM public.events ORDER BY rowid LIMIT 20")).map((r) => r[0]).join("\n"), psql(url, "SELECT id FROM events ORDER BY ctid LIMIT 20"), "the heap's order");
    assert.notEqual(psql(url, "SELECT string_agg(id::text, ' ') FROM (SELECT id FROM events ORDER BY ctid LIMIT 20) h"), psql(url, "SELECT string_agg(id::text, ' ') FROM (SELECT id FROM events ORDER BY id LIMIT 20) k"), "the heap is not in key order (else this proves nothing)");
    assert.deepEqual(await rows("SELECT count(*) FROM (SELECT created_at < lag(created_at) OVER (ORDER BY rowid) AS back FROM public.events) WHERE back"), [[0n]], "insertion order kept");
    assert.deepEqual(await rows("SELECT count(*), count(DISTINCT id), min(extract(day FROM i)), max(extract(day FROM i)) FROM public.events"), [[BigInt(ROWS), BigInt(ROWS), BigInt(-ROWS), -1n]], "every row once, every interval as it was");
    assert.deepEqual(await rows("SELECT count(*) FROM duckdb_constraints() WHERE schema_name = 'public'"), [[0n]], "no constraint, so no index");
    assert.deepEqual(await rows("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%__mason_copy'"), [[0n]], "no side table is left");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("heap.db.stage-")), [], "no stage beside the copy");
    // A TIME WINDOW PRUNES: one day of the table's 139 reads one row group or two of its four, by the zonemaps
    const plan = String((await rows("EXPLAIN ANALYZE SELECT count(*) FROM public.events WHERE created_at >= TIMESTAMPTZ '2026-02-01 00:00:00+00' AND created_at < TIMESTAMPTZ '2026-02-02 00:00:00+00'"))[0]![1]);
    const scanned = /Row Groups Scanned: (\d+) \/ (\d+)/.exec(plan);
    assert.ok(scanned !== null, `the plan says what it scanned\n${plan}`);
    const [read, all] = [Number(scanned[1]), Number(scanned[2])];
    assert.ok(all >= 3 && read < all / 2, `a day of the table read ${read} of its ${all} row groups\n${plan}`);
  } finally { await sync.stop(); store.close(); }
});

// A COPY IN THE OLD LAYOUT (sorted by its primary key, with the key's index; `_mason.copy_state`
// with the re-sort's `written` and `counted`) is a RETIRED LAYOUT (src/duck/sync.ts RETIRED_LAYOUT): said by name in the
// log and in the table's state, served as it was, and copied again through the normal path — never converted. Its
// stage file goes, said. The old file is made here as that code left it.
test("a copy stored in key order with an index is said as a retired layout and copied again in heap order", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_o`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, "CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 100) g ORDER BY (g * 37) % 101");
  const col = (name: string, type: string, notNull = false) => ({ name, type, notNull, comment: null });
  const T: AddedTable = { source: "public.t", schema: "public", table: "t", key: ["id"], bytes: 0, rows: 100, foreignKeys: [], columns: [col("id", "integer", true), col("v", "text")] };
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const file = path.join(dir, "old.db");
  // THE OLD FILE: the copy sorted by key under a PRIMARY KEY, its ledger row of the old shape, a stage left beside it
  let store = await DuckStore.open(file, () => undefined);
  const snapshot = psql(url, "SELECT pg_current_snapshot()");
  await store.writer.run(`CREATE TABLE _mason.copy_state (source VARCHAR PRIMARY KEY, phase VARCHAR, "rows" BIGINT, bytes BIGINT, seconds DOUBLE, copied_at TIMESTAMPTZ, error VARCHAR, columns JSON, written BIGINT DEFAULT 0, counted BIGINT); ` +
    `INSERT INTO _mason.copy_state VALUES ('public.t', 'copied', 99, 0, 0.1, now(), NULL, ${`'${JSON.stringify(T.columns)}'`}, 3, 99); ` +
    `CREATE TABLE _mason.poll_state (source VARCHAR PRIMARY KEY, snapshot VARCHAR, polled_at TIMESTAMPTZ); INSERT INTO _mason.poll_state VALUES ('public.t', '${snapshot}', now()); ` +
    `CREATE TABLE public.t (id INTEGER, v VARCHAR, PRIMARY KEY (id)); INSERT INTO public.t SELECT i, 'old' FROM range(1, 100) r(i) ORDER BY i`);
  store.close();
  fs.writeFileSync(`${file}.stage-public_t.db`, "a stage of the old copy");
  const logged: string[] = [];
  store = await DuckStore.open(file, (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  const RETIRED = (syncModule as unknown as { RETIRED_LAYOUT?: string }).RETIRED_LAYOUT;
  try {
    await sync.open();
    assert.equal(RETIRED, "stored in key order with an index, by an older Mason: read again whole, in heap order");
    assert.ok(logged.some((l) => l.startsWith(`public.t: it is ${RETIRED} — `)), `said by name at the start\n${logged.join("\n")}`);
    assert.ok(logged.some((l) => l.startsWith("removed old.db.stage-public_t.db: a sync's stage, from an older Mason")), logged.join("\n"));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("old.db.stage-")), [], "the old stage is removed");
    // served as it was, and said so on its line, until it is copied again
    void sync.setTables([T]);
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.retired]), [["public.t", "copied", RETIRED]]);
    const from = logged.length;
    await sync.once();
    const said = logged.slice(from).join("\n");
    assert.ok(logged.slice(from).some((l) => l.startsWith(`syncing public.t, again (it is ${RETIRED}): `)), said);
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.retired, s.rows, s.error]), [["public.t", "copied", undefined, 100, null]], said);
    // the source's rows in its heap's order, no constraint
    assert.equal(((await store.writer.runAndReadAll("SELECT id, v FROM public.t ORDER BY rowid")).getRowsJS() as unknown[][]).map((r) => r.join("\t")).join("\n"),
      psql(url, "SELECT id, v FROM t ORDER BY ctid"), "copied again from the source, in its heap order");
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_constraints() WHERE schema_name = 'public'")).getRowsJS(), [[0n]]);
    assert.deepEqual((await store.writer.runAndReadAll("SELECT column_name FROM duckdb_columns() WHERE schema_name = '_mason' AND table_name = 'copy_state' ORDER BY column_index")).getRowsJS().map((r) => r[0]),
      ["source", "phase", "rows", "bytes", "seconds", "copied_at", "error", "columns"], "the ledger's re-sort columns are gone");
    // and polled from then on
    psql(url, "UPDATE t SET v = 'polled' WHERE id = 5");
    await sync.once();
    assert.deepEqual((await store.writer.runAndReadAll("SELECT v FROM public.t WHERE id = 5")).getRowsJS(), [["polled"]]);
  } finally { await sync.stop(); store.close(); }
});

// EACH TABLE KEPT CURRENT AS ITS SYNC SAYS (the sources file's `sync:`, src/lib/table-sync.ts; GitHub issue 33): a mixed
// project — one table `off`, one `poll 2s`, one `poll 10s` — on the passes' own timer (`start`, never `once`, which takes
// every polled table as due). The `off` table is read again only when asked (`pollNow`, mason sync); each polled one at
// its own interval; and each table's `syncedAt` moves only when its own poll runs.
const cols2 = [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null }];
const tableOf = (name: string, sync: AddedTable["sync"]): AddedTable =>
  ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], bytes: 0, rows: null, foreignKeys: [], columns: cols2, ...(sync ? { sync } : {}) });
const OFF = { mode: "off" } as const;
const POLL = (every: string, seconds: number) => ({ mode: "poll", every, seconds }) as const;
/** a database of its own for one test, dropped after it */
function ownDatabase(suffix: string, sql: string): Source {
  const db = `${tag}_${suffix}`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, sql);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return parsed.source;
}
/** until `ok` holds, or `ms` passed (then the failure says what was waited for) */
async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const keptOf = (sync: Sync, source: string) => sync.state().find((s) => s.source === source)?.kept;
const syncedAt = (sync: Sync, source: string): string | null => { const k = keptOf(sync, source); return k?.by === "poll" ? k.syncedAt : null; };
/** every table copied, caught up, and kept as its sync says (nothing pending) */
const settled = (sync: Sync, sources: readonly string[]) => () => sources.every((s) => { const k = keptOf(sync, s); return k?.by === "poll" && k.pending === undefined && k.syncedAt !== null; });

test("a mixed project: an `off` table unchanged until mason sync, a `poll 2s` one current within its interval, a `poll 10s` one not polled before its own", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const source = ownDatabase("mixed", "CREATE TABLE manual (id int PRIMARY KEY, v text); CREATE TABLE fast (id int PRIMARY KEY, v text); CREATE TABLE slow (id int PRIMARY KEY, v text); " +
    "INSERT INTO manual SELECT g, 'm' || g FROM generate_series(1, 5) g; INSERT INTO fast SELECT g, 'f' || g FROM generate_series(1, 5) g; INSERT INTO slow SELECT g, 's' || g FROM generate_series(1, 5) g");
  const url = `postgres://${source.user}${source.password ? `:${encodeURIComponent(source.password)}` : ""}@${source.host}:${source.port}/${source.database}`;
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "mixed.db"), (l) => logged.push(l));
  // the sync's own interval (a table with no sync of its own) is never at work here: every table names one
  const sync = new Sync(store, source, source.database, (l) => logged.push(l), 3_600_000, "poll");
  await sync.open();
  const count = async (t: string): Promise<number> => Number((await store.writer.runAndReadAll(`SELECT count(*) FROM public.${t}`)).getRowsJS()[0]![0]);
  const all = ["public.manual", "public.fast", "public.slow"];
  try {
    await sync.setTables([tableOf("manual", OFF), tableOf("fast", POLL("2s", 2)), tableOf("slow", POLL("10s", 10))]);
    sync.start();
    await until("every table copied and caught up", settled(sync, all));
    const before = Object.fromEntries(all.map((s) => [s, syncedAt(sync, s)!]));
    assert.deepEqual(all.map((s) => keptOf(sync, s)?.by === "poll" ? (keptOf(sync, s) as { sync: unknown }).sync : null), [OFF, POLL("2s", 2), POLL("10s", 10)]);
    assert.equal((keptOf(sync, "public.manual") as { nextAt: string | null }).nextAt, null, "an off table has no next poll");

    psql(url, "INSERT INTO manual VALUES (6, 'new'); INSERT INTO fast VALUES (6, 'new'); INSERT INTO slow VALUES (6, 'new')");
    const changedAt = Date.now();
    // the 2s table: current within its interval (and a pass's own time)
    // its rows are visible a moment before its pass reads the ledger's polled_at again: both are waited for
    await until("the poll 2s table to have the new row, its syncedAt moved with its poll", async () => await count("fast") === 6 && syncedAt(sync, "public.fast")! > before["public.fast"]!, 8_000);
    const fastSeen = Date.now();
    // the 10s table: not polled before its interval, its syncedAt where its catch-up left it
    if (fastSeen < Date.parse(before["public.slow"]!) + 9_000) {
      assert.equal(await count("slow"), 5, "the poll 10s table is not polled before its interval");
      assert.equal(syncedAt(sync, "public.slow"), before["public.slow"], "its syncedAt moves only with its own poll");
    } else assert.fail(`the 2s table took ${(fastSeen - changedAt) / 1000} s: too late to tell the 10s table's interval apart`);
    // then it is, once its interval passed since its last poll
    await until("the poll 10s table to have the new row, its syncedAt moved", async () => await count("slow") === 6 && syncedAt(sync, "public.slow") !== before["public.slow"], 20_000);
    const slowPolled = Date.parse(syncedAt(sync, "public.slow")!);
    assert.ok(slowPolled - Date.parse(before["public.slow"]!) >= 9_500, `its next poll waited its interval: ${slowPolled - Date.parse(before["public.slow"]!)} ms`);
    // the off table: unchanged though rows changed on the source, its syncedAt as its copy left it
    assert.equal(await count("manual"), 5, "an off table is not polled by the passes");
    assert.equal(syncedAt(sync, "public.manual"), before["public.manual"], "nor is its syncedAt moved by them");
    assert.equal(logged.filter((l) => /^poll: .*public\.manual/.test(l)).length, 1, `only its copy's catch-up poll names it:\n${logged.join("\n")}`);

    // mason sync: an off table polled once, now; and a polled table now too, whatever its interval
    const asked = await sync.pollNow(["public.manual"]);
    assert.deepEqual(asked.tables.map((t) => [t.table, t.changed, t.rows]), [["public.manual", 1, 6]]);
    assert.equal(await count("manual"), 6);
    assert.ok(syncedAt(sync, "public.manual")! > before["public.manual"]!, "mason sync moves its syncedAt");
    assert.equal((keptOf(sync, "public.manual") as { nextAt: string | null }).nextAt, null, "and leaves it off: no next poll");
    psql(url, "DELETE FROM slow WHERE id = 1");
    const slowNow = await sync.pollNow(["public.slow"]);
    assert.deepEqual(slowNow.tables.map((t) => [t.table, t.deleted, t.rows]), [["public.slow", 1, 5]], "a poll 10s table synced now, before its interval");
    const next = Date.parse((keptOf(sync, "public.slow") as { nextAt: string }).nextAt);
    assert.ok(next - Date.parse(syncedAt(sync, "public.slow")!) >= 9_000, "its next poll is an interval from this one");
    // refused by name: a table not added, with the closest added one
    await assert.rejects(sync.pollNow(["public.fats"]), (e: Error) => e instanceof PollRefused && e.code === "not_found" && /^public\.fats is not added \(mason add adds it\) — did you mean `public\.fast`\?$/.test(e.message));
  } finally { await sync.stop(); store.close(); }

  // a replicated table is not polled: mason sync answers where the stream is
  const other = await DuckStore.open(path.join(dir, "mixed-repl.db"), (l) => logged.push(l));
  const repl = new Sync(other, source, source.database, (l) => logged.push(l), 3_600_000, "replication", { slot: "unused", publication: "unused", owned: true });
  try {
    // stopped first, as nothing here may make a slot: its tables set, no pass runs
    await repl.open();
    await repl.stop();
    await repl.setTables([tableOf("manual", { mode: "replication" }), tableOf("slow", OFF)]);
    const r = await repl.pollNow(["public.manual"]);
    assert.deepEqual([r.tables, r.streamed?.map((t) => t.table)], [[], ["public.manual"]]);
    assert.match(r.streamed![0]!.position, /^[0-9A-F]+\/[0-9A-F]+$/);
    // an off table beside it, in a project that streams, is POLLED by mason sync, never answered as streamed: this
    // sync is stopped, so the poll it owes is refused as stopping (a project that streamed every table said "streamed")
    await assert.rejects(repl.pollNow(["public.manual", "public.slow"]), (e: Error) => e.message === "Mason is stopping");
  } finally { await repl.stop(); other.close(); }
});

// A CHANGE OF A TABLE'S SYNC KEEPS ITS COPY AND CATCHES IT UP BY ONE POLL, never copies it again — by `mason add --sync`
// while the run is up (`setTables`), and by hand while it is down (the ledger's record of the sync it was polled under)
test("a table's sync switched off→poll and poll→off keeps its copy and is caught up by one poll, at once or at the next start", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const source = ownDatabase("switch", "CREATE TABLE a (id int PRIMARY KEY, v text); CREATE TABLE b (id int PRIMARY KEY, v text); " +
    "INSERT INTO a SELECT g, 'a' || g FROM generate_series(1, 5) g; INSERT INTO b SELECT g, 'b' || g FROM generate_series(1, 5) g");
  const url = `postgres://${source.user}${source.password ? `:${encodeURIComponent(source.password)}` : ""}@${source.host}:${source.port}/${source.database}`;
  const logged: string[] = [];
  const file = path.join(dir, "switch.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, source, source.database, (l) => logged.push(l), 3_600_000, "poll");
  await sync.open();
  const count = async (t: string): Promise<number> => Number((await store.writer.runAndReadAll(`SELECT count(*) FROM public.${t}`)).getRowsJS()[0]![0]);
  const copiedAt = (t: string): string | null => sync.state().find((s) => s.source === `public.${t}`)!.copiedAt;
  const both = ["public.a", "public.b"];
  try {
    await sync.setTables([tableOf("a", OFF), tableOf("b", POLL("1h", 3600))]);
    sync.start();
    await until("both copied and caught up", settled(sync, both));
    const copies = [copiedAt("a"), copiedAt("b")];
    psql(url, "INSERT INTO a VALUES (6, 'x'); INSERT INTO b VALUES (6, 'x')");
    // mason add a --sync "poll 1h", mason add b --sync off: each caught up by ONE poll, now
    await sync.setTables([tableOf("a", POLL("1h", 3600)), tableOf("b", OFF)]);
    await until("both caught up by one poll", async () => await count("a") === 6 && await count("b") === 6, 10_000);
    assert.ok(logged.includes("public.a: sync: off → poll 1h: its synced data is kept, and caught up by one poll now"), logged.join("\n"));
    assert.ok(logged.includes("public.b: sync: poll 1h → off: its synced data is kept, and caught up by one poll now"), logged.join("\n"));
    assert.deepEqual([copiedAt("a"), copiedAt("b")], copies, "never copied again");
    assert.equal(logged.filter((l) => /^synced public\.[ab]\b/.test(l)).length, 2, `one copy each, the first:\n${logged.join("\n")}`);
    // then each kept as it now says: neither due (poll 1h, off), so a change waits
    psql(url, "INSERT INTO a VALUES (7, 'y'); INSERT INTO b VALUES (7, 'y')");
    await new Promise((r) => setTimeout(r, 2_500));
    assert.deepEqual([await count("a"), await count("b")], [6, 6], "after the one poll, each kept as its new sync says");
  } finally { await sync.stop(); store.close(); }

  // BY HAND, while Mason is down: a's entry now says off (recorded: poll 1h), b's still off — a is caught up at the start
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, source, source.database, (l) => logged.push(l), 3_600_000, "poll");
  await sync.open();
  try {
    const seen = logged.length;
    await sync.setTables([tableOf("a", OFF), tableOf("b", OFF)]);
    sync.start();
    await until("a caught up at the start", async () => await count("a") === 7, 10_000);
    assert.ok(logged.slice(seen).includes("public.a: sync: poll 1h → off: its synced data is kept, and caught up by one poll now"), logged.slice(seen).join("\n"));
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(await count("b"), 6, "b's sync did not change: off, not polled at the start");
    assert.equal(logged.slice(seen).filter((l) => /^synced public\./.test(l)).length, 0, "nothing copied again");
  } finally { await sync.stop(); store.close(); }
});

// A BULK CHANGE ON A BIG TABLE (a migration's UPDATE over tens of millions of rows, one Postgres
// transaction): the poll wrote every changed row in ONE statement of one transaction, which ran out of memory at a
// fraction of the table (`POLL_PIECE_ROWS`). The changed rows are staged, the source's deletes applied in the
// snapshot's transaction, and the rows written in committed pieces, the watermark moving with the last.
test("a poll of a transaction that changed most of a big table writes it in committed pieces, within a small memory limit", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_b`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  const ROWS = 800_000;
  psql(url, `CREATE TABLE bulk (id uuid PRIMARY KEY, n int); INSERT INTO bulk SELECT md5(g::text)::uuid, g FROM generate_series(1, ${ROWS}) g`);
  const BULK: AddedTable = { source: "public.bulk", schema: "public", table: "bulk", key: ["id"], bytes: 0, rows: ROWS, foreignKeys: [],
    columns: [{ name: "id", type: "uuid", notNull: true, comment: null }, { name: "n", type: "integer", notNull: false, comment: null }] };
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "bulk.db");
  let store: DuckStore = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
  let sync: Sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  const checksum = async (): Promise<void> => assert.equal(
    ((await store.writer.runAndReadAll("SELECT count(*), sum(n), sum(('0x' || substr(md5(id::VARCHAR), 1, 8))::UBIGINT) FROM public.bulk")).getRowsJS() as unknown[][]).map((r) => r.join("\t")).join("\n"),
    psql(url, "SELECT count(*), sum(n), sum(('x' || substr(md5(id::text), 1, 8))::bit(32)::bigint) FROM bulk"), `DuckDB equals the source\n${logged.slice(-4).join("\n")}`);
  try {
    await sync.open();
    void sync.setTables([BULK]);
    await sync.once();
    // ONE transaction: nine rows in ten updated, a few deleted and inserted
    psql(url, "BEGIN; UPDATE bulk SET n = -n WHERE n % 10 <> 0; DELETE FROM bulk WHERE n % 100 = 0; " +
      "INSERT INTO bulk SELECT md5((-g)::text)::uuid, g FROM generate_series(1, 1000) g; COMMIT");
    const from = logged.length;
    await sync.once();
    const said = logged.slice(from).join("\n");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase, s.error]), [["public.bulk", "copied", null]], said);
    await checksum();
    assert.match(said, /^poll: snapshot \d+ ms; public\.bulk 721000 changed, staged in \d+ ms, 1000 new, counted in \d+ ms, 8000 deleted$/m, said);
    assert.match(said, /^poll: public\.bulk: 721,000 changed row\(s\), written in 15 pieces in \d+ ms$/m, said);
    // the watermark moved with the last piece: a restart polls nothing again of it
    await sync.stop(); store.close();
    store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
    sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
    await sync.open();
    const again = logged.length;
    void sync.setTables([BULK]);
    await sync.once();
    assert.match(logged.slice(again).join("\n"), /^poll: snapshot \d+ ms; public\.bulk 0 changed in/m, logged.slice(again).join("\n"));
    await checksum();
    // a statement that fails is named in the poll's error, not only the engine's words
    psql(url, "ALTER TABLE bulk RENAME TO bulk_gone");
    await sync.once();
    assert.match(sync.state()[0]?.error ?? "", /^the poll failed, .*: public\.bulk: reading its changed rows from the source into the poll's stage: .*bulk/, JSON.stringify(sync.state()));
  } finally { await sync.stop(); store.close(); }
});

// A COPY RUNS BESIDE THE POLLS (a large table's copy held every other table's freshness for its whole
// duration). While a large table copies, the passes go on polling the table already copied — a transaction of its own per
// table — so a change to it is in DuckDB before the copy ends; the changes to the copying table committed after its
// snapshot are in it once it is caught up, by one poll from that snapshot. The copy is HELD by the test (`heldCopy`)
// until small's change is polled in, so "beside" holds by construction: on a CI runner the 400,000-row copy this test
// once raced took 0.89 s, one pass ran beside it, and the change landed after it.
test("a table copies beside the polls: the other table is polled meanwhile, and what changed during the copy is in it once caught up", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_d`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  // its size decides nothing (the copy is held; the test passes at 50 rows): a few chunks, as a copy usually is
  const ROWS = 20_000;
  psql(url, `CREATE TABLE small (id int PRIMARY KEY, v text); INSERT INTO small VALUES (1, 'a'); ` +
    `CREATE TABLE big (id int PRIMARY KEY, v text); INSERT INTO big SELECT g, repeat(md5(g::text), 16) FROM generate_series(1, ${ROWS}) g ORDER BY (g::bigint * 7919) % ${ROWS}`);
  // the copy reads big's rows (not all left to its catch-up), so its chunks are read, and held
  await rowsOlderThanEverySnapshot(url, "big");
  const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
  const table = (t: string, rows: number): AddedTable => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], bytes: 0, rows, foreignKeys: [], columns: [col("id", "integer"), col("v", "text")] });
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "beside.db"), (l) => logged.push(l), { memoryLimit: "64MB" });
  // big's copy waits inside its chunks until the test has seen small's change polled in
  const big = heldCopy("public.big");
  // a pass every 100 ms: the polls the copy must not hold
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 100, "poll", null, { onChunk: big.onChunk });
  // read on a connection of the test's own: the sync's writer may be inside a poll's transaction
  const reader = await store.instance.connect();
  const read = async (sql: string): Promise<string> => ((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n");
  const until = async (ok: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!await ok()) {
      if (Date.now() > deadline) throw new Error(`${what}: not within 60 s\n${logged.slice(-12).join("\n")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    await sync.open();
    void sync.setTables([table("small", 1)]);
    await until(async () => (await read("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'small'")) === "1", "small copied");
    const from = logged.length;
    void sync.setTables([table("small", 1), table("big", ROWS)]);
    // a chunk of big's copy is read and waits uncommitted: the copy's snapshot is pinned, so what changes now is after
    // it, and the copy cannot end until the test releases it
    await until(big.held, "big's copy held in its first chunks");
    psql(url, "INSERT INTO small VALUES (2, 'during the copy'); UPDATE big SET v = 'changed during its copy' WHERE id = 7; DELETE FROM big WHERE id = 8; INSERT INTO big VALUES (0, 'new during its copy')");
    // THE PASSES GO ON BESIDE THE COPY: a poll that waited for the copy would never bring this in while it is held. Waited
    // for by the pass's line, said once its transaction has committed (the row is visible to a reader BEFORE the line)
    const smallPolled = (l: string): boolean => /^poll: .*; public\.small 1 changed /.test(l);
    await until(() => logged.slice(from).some(smallPolled), "small's change polled while big's copy is held (a poll waiting for the copy never comes)");
    assert.equal(await read("SELECT id, v FROM public.small ORDER BY 1"), "1\ta\n2\tduring the copy", "small's change is in DuckDB");
    // the sync's own lines, in order: big's copy began, a pass polled small's change, and big's copy had not ended
    const during = logged.slice(from);
    const pinned = during.findIndex((l) => /^syncing public\.big as of the source's snapshot /.test(l));
    const polled = during.findIndex(smallPolled);
    const copied = during.findIndex((l) => /^synced public\.big/.test(l));
    assert.ok(pinned >= 0 && polled > pinned && copied === -1, `small's change was polled by a pass after big's copy began and before it ended (the passes went on beside it)\n${during.join("\n")}`);
    assert.ok(during.some((l) => /^syncing public\.big: .*beside the other tables' polls/.test(l)), "the copy's start says the polls go on");

    big.release();
    await until(() => logged.slice(from).some((l) => /^caught up public\.big /.test(l)), "big caught up");
    const said = logged.slice(from).join("\n");
    assert.ok(logged.slice(from).some((l) => l.startsWith("caught up public.big by one poll after its whole read: the poll keeps it current (polled every ")), said);
    assert.equal(await read("SELECT id, v FROM public.big WHERE id IN (0, 7, 8) ORDER BY 1"), "0\tnew during its copy\n7\tchanged during its copy", `the changes made during its copy\n${said}`);
    assert.equal(await read("SELECT count(*), count(DISTINCT id) FROM public.big"), `${ROWS}\t${ROWS}`);
    // and polled by the passes from then on
    psql(url, "UPDATE big SET v = 'polled after' WHERE id = 9");
    await until(async () => (await read("SELECT v FROM public.big WHERE id = 9")) === "polled after", "big polled after its catch-up");
  } finally {
    big.release();
    reader.closeSync();
    await sync.stop();
    store.close();
  }
});
