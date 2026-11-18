/**
 * A JOIN ON A DECLARED REFERENCE READS HIDDEN INTEGER KEYS, AND ANSWERS AS POSTGRES DOES (issue 1144,
 * src/duck/reference-keys.ts). The sources file's `references:` of a UUID key, a text key, a key of two columns and a
 * sparse 64-bit key are numbered in hidden columns of both tables; a dense integer key is not. A join on each answers
 * what Postgres answers: an order whose customer is missing, an order with no customer (NULL), a customer with no
 * order, a referenced key that is not unique. And it stays right through every write: the first sync, the poll
 * (inserts, a key updated, a customer deleted and inserted again), the stream, and a table synced again whole. A row the
 * numbering has not reached yet is never read as a number: the statement runs on the keys themselves. A table with a
 * reference and a timestamptz holds both hidden columns, each written by every write (src/duck/bucket-column.ts).
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the stream's test, skipped otherwise), psql on PATH. It
 * writes only inside the databases it creates, `it_refkeys_<random>_*`, and drops them at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable, type SyncMode } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";
import { hiddenColumns } from "../../src/duck/hidden-columns.ts";
import { bucketColumn, bucketSql } from "../../src/duck/bucket-column.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_refkeys_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-refkeys-"));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const logical = adminUrl !== undefined && psql(adminUrl, "SHOW wal_level") === "logical";
const skip = adminUrl === undefined ? "IT_POSTGRES_URL is not set" : false;

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

/** a synthetic shop: customers by UUID, accounts by a text code, a key of two columns, a sparse 64-bit id and a dense
 *  serial, each with the rows that reference it */
const SCHEMA = `
CREATE TABLE customers (pk serial PRIMARY KEY, id uuid, name text, region text);
CREATE TABLE orders (id int PRIMARY KEY, customer_id uuid, amount numeric(10,2));
CREATE TABLE accounts (code text PRIMARY KEY, plan text);
CREATE TABLE events (id int PRIMARY KEY, account_code varchar(20), kind text);
CREATE TABLE seats (tenant_id int, id int, label text, PRIMARY KEY (tenant_id, id));
CREATE TABLE bookings (id int PRIMARY KEY, tenant_id int, seat_id int, nights int);
CREATE TABLE devices (id bigint PRIMARY KEY, model text);
CREATE TABLE pings (id int PRIMARY KEY, device_id bigint, ms int, seen_at timestamptz);
CREATE TABLE stores (id serial PRIMARY KEY, city text);
CREATE TABLE sales (id int PRIMARY KEY, store_id int, total int);
CREATE TABLE staff (id uuid PRIMARY KEY, boss_id uuid, name text);
INSERT INTO customers (id, name, region) SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, 'c' || i, (ARRAY['north','south','east'])[1 + i % 3] FROM generate_series(1, 40) i;
-- a referenced key that is not unique: two customers share one id
INSERT INTO customers (id, name, region) VALUES ('00000000-0000-4000-8000-000000000007', 'c7 twin', 'west');
INSERT INTO orders SELECT i, ('00000000-0000-4000-8000-' || lpad(to_hex(1 + i % 37), 12, '0'))::uuid, (i * 3.25)::numeric(10,2) FROM generate_series(1, 300) i;
-- an order whose customer is missing, and one with no customer
INSERT INTO orders VALUES (301, '00000000-0000-4000-8000-0000000fffff', 9.99), (302, NULL, 1.00);
INSERT INTO accounts SELECT 'acct-' || i, (ARRAY['free','team','pro'])[1 + i % 3] FROM generate_series(1, 25) i;
INSERT INTO events SELECT i, CASE WHEN i % 41 = 0 THEN NULL WHEN i % 43 = 0 THEN 'gone' ELSE 'acct-' || (1 + i % 27) END, (ARRAY['open','click'])[1 + i % 2] FROM generate_series(1, 400) i;
INSERT INTO seats SELECT t, s, 't' || t || 's' || s FROM generate_series(1, 4) t, generate_series(1, 6) s;
INSERT INTO bookings SELECT i, CASE WHEN i % 29 = 0 THEN NULL ELSE 1 + i % 5 END, 1 + i % 7, i % 4 FROM generate_series(1, 200) i;
INSERT INTO devices SELECT 7000000000000000000 + i::int8 * 104729 * 1000003, 'm' || (i % 5) FROM generate_series(1, 30) i;
INSERT INTO pings SELECT i, 7000000000000000000 + (1 + i % 33)::int8 * 104729 * 1000003, i % 90, CASE WHEN i % 17 = 0 THEN NULL ELSE timestamptz '2024-03-01 00:00+00' + i * interval '37 minutes' END
  FROM generate_series(1, 250) i;
INSERT INTO stores (city) SELECT 'city' || i FROM generate_series(1, 12) i;
INSERT INTO sales SELECT i, 1 + i % 14, i * 2 FROM generate_series(1, 150) i;
-- a table that references itself: each one's boss, none, or one who is gone
INSERT INTO staff SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(i), 12, '0'))::uuid, CASE WHEN i = 1 THEN NULL WHEN i % 11 = 0 THEN '00000000-0000-4000-9000-0000000fffff'::uuid
  ELSE ('00000000-0000-4000-9000-' || lpad(to_hex(1 + i / 4), 12, '0'))::uuid END, 's' || i FROM generate_series(1, 60) i;
`;

/** each referencing table's `references:` as the sources file names them (src/cli/sources.ts `addedTables`) */
const REFERENCES: Record<string, Array<{ columns: string[]; table: string; targetColumns: string[] }>> = {
  "public.orders": [{ columns: ["customer_id"], table: "public.customers", targetColumns: ["id"] }],
  "public.events": [{ columns: ["account_code"], table: "public.accounts", targetColumns: ["code"] }],
  "public.bookings": [{ columns: ["tenant_id", "seat_id"], table: "public.seats", targetColumns: ["tenant_id", "id"] }],
  "public.pings": [{ columns: ["device_id"], table: "public.devices", targetColumns: ["id"] }],
  "public.sales": [{ columns: ["store_id"], table: "public.stores", targetColumns: ["id"] }],
  "public.staff": [{ columns: ["boss_id"], table: "public.staff", targetColumns: ["id"] }],
};
const TABLES = ["customers", "orders", "accounts", "events", "seats", "bookings", "devices", "pings", "stores", "sales", "staff"].map((t) => `public.${t}`);
/** the references numbered: every one but the dense serial's */
const NUMBERED = 5;

/** the statements a test asks of both: each a join on a reference, written as BI tools and ORMs write them */
const JOINS = [
  "SELECT c.region, count(*), sum(o.amount) FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY 1 ORDER BY 1",
  "SELECT c.name, count(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY 1 ORDER BY 1",
  "SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id > 295 ORDER BY 1, 2",
  "SELECT count(*) FROM orders o, customers c WHERE o.customer_id = c.id AND c.region = 'north'",
  "SELECT o.id FROM orders o FULL JOIN customers c ON o.customer_id = c.id WHERE c.id IS NULL OR o.id IS NULL ORDER BY 1",
  "SELECT count(*) FROM orders o JOIN customers c ON o.customer_id = c.id AND o.amount > 100",
  "SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.amount > 900) ORDER BY 1",
  "SELECT a.plan, count(*) FROM events e JOIN accounts a ON e.account_code = a.code GROUP BY 1 ORDER BY 1",
  "SELECT count(*), count(a.code) FROM events e LEFT JOIN accounts a ON a.code = e.account_code",
  "SELECT s.label, sum(b.nights) FROM bookings b JOIN seats s ON b.tenant_id = s.tenant_id AND b.seat_id = s.id GROUP BY 1 ORDER BY 1",
  "SELECT count(*) FROM bookings b LEFT JOIN seats s ON s.id = b.seat_id AND s.tenant_id = b.tenant_id WHERE s.label IS NULL",
  "SELECT count(*) FROM bookings b JOIN seats s ON b.seat_id = s.id",
  "SELECT d.model, count(*), sum(p.ms) FROM pings p JOIN devices d ON p.device_id = d.id GROUP BY 1 ORDER BY 1",
  "SELECT st.city, sum(sa.total) FROM sales sa JOIN stores st ON sa.store_id = st.id GROUP BY 1 ORDER BY 1",
  "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.id, c.name LIMIT 5",
  "SELECT * FROM orders ORDER BY id LIMIT 3",
  "SELECT o.id FROM orders o JOIN customers c ON NOT (o.customer_id <> c.id) WHERE o.id < 4 ORDER BY 1",
  "SELECT b.name, count(*) FROM staff e LEFT JOIN staff b ON e.boss_id = b.id GROUP BY 1 ORDER BY 1",
];
/** the joins whose engine SQL reads the numbers (the rest: a column of an outer query, a key of two columns joined on
 *  one, a dense key, a `*` of a synced table, a comparison that is not a conjunct `=`) */
const ON_NUMBERS = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 12, 17]);

/** the source's tables as `mason start` reads them, each with its `references:` (none: as a Mason before them read them) */
async function tablesOf(source: Source, references = true): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return TABLES.map((n) => {
      const t = facts.tables.find((x) => x.source === n);
      if (!t) throw new Error(`no table ${n}`);
      return { ...t, ...(references && REFERENCES[n] ? { fileReferences: REFERENCES[n] } : {}) } as AddedTable;
    });
  } finally { c.pg.close(); }
}

/** the Postgres API over the store, as `mason start` serves it */
async function listen(store: DuckStore, sync: Sync, db: string): Promise<{ ask: (sql: string) => Promise<string>; close: () => Promise<void> }> {
  const server = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, null, undefined, () => sync.state(), sync.kept.enabled ? sync.kept : undefined) });
  const client = new pg.Client({ host: "127.0.0.1", port: server.port, database: db, user: "test", password: "x" });
  await client.connect();
  return {
    ask: async (sql) => (await client.query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows
      .map((r: unknown[]) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd(),
    close: async () => { await client.end(); await server.close(); },
  };
}

/** until every numbered reference is served (the schema names it once both its tables are numbered), or 30 s */
async function numbered(sync: Sync, logged: readonly string[]): Promise<void> {
  for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if ((sync.schema().references ?? []).length === NUMBERED) return;
  }
  assert.fail(`the references were not numbered in 30 s: ${JSON.stringify(sync.schema().references)}\n${logged.slice(-10).join("\n")}`);
}

/** every row of each hidden column of `table` numbered (none NULL) */
async function unnumbered(store: DuckStore, table: string): Promise<number> {
  const cols = (await store.writer.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = '${table}' AND starts_with(column_name, '__mason_ref_')`)).getRowsJS().map((r) => String(r[0]));
  let n = 0;
  for (const c of cols) n += Number((await store.writer.runAndReadAll(`SELECT count(*) FROM public.${table} WHERE "${c}" IS NULL`)).getRowsJS()[0]![0]);
  return n;
}

/** a table with a reference and a timestamptz (`pings`): both its hidden columns there, each told apart by its kind
 *  (src/duck/hidden-columns.ts), and every row's bucket the one its value has (its key's number: `unnumbered`) */
async function bothHidden(store: DuckStore, when: string): Promise<void> {
  const own = ["id", "device_id", "ms", "seen_at"];
  const physical = (await store.writer.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = 'pings' ORDER BY column_index`)).getRowsJS().map((r) => String(r[0]));
  const kinds = hiddenColumns(physical, own).map((h) => h.kind).sort();
  assert.deepEqual(kinds, ["bucket", "number"], `pings holds a bucket and a number, ${when}: ${JSON.stringify(hiddenColumns(physical, own))}`);
  const bucket = bucketColumn("seen_at", own);
  const wrong = (await store.writer.runAndReadAll(`SELECT count(*) FROM public.pings WHERE "${bucket}" IS DISTINCT FROM ${bucketSql("seen_at")}`)).getRowsJS()[0]![0];
  assert.equal(wrong, 0n, `every row of pings has its value's bucket, ${when}`);
}

/** each join answered as Postgres answers it, and read on the numbers where it is one of `ON_NUMBERS` (`plainNow`:
 *  none is, a row not numbered yet) */
async function sameAnswers(api: Awaited<ReturnType<typeof listen>>, url: string, logged: string[], when: string, plainNow = false): Promise<void> {
  for (const [i, sql] of JOINS.entries()) {
    const before = logged.length;
    assert.equal(await api.ask(sql), psql(url, sql), `${sql}, ${when}`);
    const ran = logged.slice(before).filter((l) => l.startsWith("statement:")).join("\n");
    assert.equal(ran.includes("__mason_ref_"), ON_NUMBERS.has(i) && !plainNow, `${sql}, ${when}: ${ON_NUMBERS.has(i) && !plainNow ? "joins" : "does not join"} on the numbers:\n${ran}`);
  }
}

/** a start of one database's sync in `mode`, served, the source's tables numbered */
async function started(name: string, mode: SyncMode, names?: { slot: string; publication: string; owned: boolean }) {
  const db = `${tag}_${name}`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, SCHEMA);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const tables = await tablesOf(parsed.source);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, `${name}.db`), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), mode === "replication" ? 1_000 : 3_600_000, mode, ...(names ? [names] : []));
  await sync.open();
  sync.setTables(tables);
  await sync.once();
  await numbered(sync, logged);
  const api = await listen(store, sync, db);
  return { db, url, source: parsed.source, logged, store, sync, api, close: async () => { await api.close(); await sync.stop(); await store.close(); } };
}

/** the writes each test makes on the source, between its checks */
const WRITES = [
  // new customers and their orders; an order's customer changed; a key updated on the referenced side
  "INSERT INTO customers (id, name, region) VALUES ('00000000-0000-4000-8000-0000000000aa', 'new a', 'north'), ('00000000-0000-4000-8000-0000000000bb', 'new b', 'east'); " +
    "INSERT INTO orders VALUES (400, '00000000-0000-4000-8000-0000000000aa', 50), (401, '00000000-0000-4000-8000-0000000000bb', 60), (402, '00000000-0000-4000-8000-0000000000cc', 70); " +
    "UPDATE orders SET customer_id = '00000000-0000-4000-8000-0000000000bb' WHERE id IN (1, 2); UPDATE orders SET customer_id = NULL WHERE id = 3; " +
    "UPDATE customers SET id = '00000000-0000-4000-8000-0000000000cc' WHERE name = 'c5'",
  // a customer deleted, and inserted again; an account code changed on both sides; a booking's seat changed
  "DELETE FROM customers WHERE name = 'c9'; INSERT INTO customers (id, name, region) VALUES ('00000000-0000-4000-8000-000000000009', 'c9 again', 'south'); " +
    "UPDATE accounts SET code = 'acct-new' WHERE code = 'acct-3'; UPDATE events SET account_code = 'acct-new' WHERE id < 20; INSERT INTO accounts VALUES ('gone', 'free'); " +
    "UPDATE bookings SET seat_id = 6, tenant_id = 4 WHERE id < 10; INSERT INTO devices VALUES (42, 'tiny'); INSERT INTO pings VALUES (900, 42, 5, '2025-01-01 10:20+00'); " +
    "UPDATE pings SET device_id = 42, seen_at = '2025-06-30 23:59+00' WHERE id < 5; UPDATE pings SET seen_at = NULL WHERE id = 6; " +
    "UPDATE staff SET boss_id = (SELECT id FROM staff WHERE name = 's7') WHERE name IN ('s2', 's3'); INSERT INTO staff VALUES ('00000000-0000-4000-9000-0000000fffff', NULL, 'back')",
];

test("a join on each declared reference answers as Postgres does through the first sync and the poll, on the numbers", { skip }, async () => {
  const s = await started("poll", "poll");
  try {
    await bothHidden(s.store, "after the first sync");
    await sameAnswers(s.api, s.url, s.logged, "after the first sync");
    for (const [i, w] of WRITES.entries()) {
      psql(s.url, w);
      await s.sync.pollNow(TABLES);
      for (const t of ["customers", "orders", "accounts", "events", "seats", "bookings", "devices", "pings", "staff"]) assert.equal(await unnumbered(s.store, t), 0, `${t}: every row the poll wrote is numbered with it`);
      await bothHidden(s.store, `after the poll's writes ${i + 1}`);
      await sameAnswers(s.api, s.url, s.logged, `after the poll's writes ${i + 1}`);
    }
    // a dense serial's reference gets no hidden key
    assert.deepEqual((await s.store.writer.runAndReadAll(`SELECT count(*) FROM duckdb_columns() WHERE table_name IN ('stores', 'sales') AND starts_with(column_name, '__mason_ref_')`)).getRowsJS(), [[0n]]);
    // a row not numbered yet (as a catch-up leaves one, before the writer's turn): the statement reads the keys
    const hidden = String((await s.store.writer.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE table_name = 'orders' AND starts_with(column_name, '__mason_ref_')`)).getRowsJS()[0]![0]);
    await s.store.writer.run(`UPDATE public.orders SET "${hidden}" = NULL WHERE id = 10`);
    const first = JOINS[0]!;
    const before = s.logged.length;
    assert.equal(await s.api.ask(first), psql(s.url, first), "a row not numbered: the keys' answer");
    assert.ok(!s.logged.slice(before).some((l) => l.startsWith("statement:") && l.includes("__mason_ref_")), "it ran on the keys");
  } finally { await s.close(); }
});

test("a table synced again whole keeps every join's answer, and its rows are numbered again", { skip }, async () => {
  const s = await started("resync", "poll");
  try {
    await sameAnswers(s.api, s.url, s.logged, "after the first sync");
    for (const [i, w] of WRITES.entries()) {
      // the writes, and a column added to each side: each table synced again whole (its new keys among them)
      psql(s.url, `${w}; ALTER TABLE orders ADD COLUMN note_${i} text; ALTER TABLE customers ADD COLUMN note_${i} text; ALTER TABLE bookings ADD COLUMN note_${i} text; ALTER TABLE staff ADD COLUMN note_${i} text`);
      const before = s.logged.length;
      s.sync.setTables(await tablesOf(s.source));
      await s.sync.once();
      for (const t of ["orders", "customers", "bookings", "staff"]) assert.ok(s.logged.slice(before).some((l) => l.startsWith(`synced public.${t}:`)), `public.${t} is synced again:\n${s.logged.slice(before).join("\n")}`);
      // each answer right, whether the numbering of the new keys is done or not yet
      for (const sql of JOINS) assert.equal(await s.api.ask(sql), psql(s.url, sql), `${sql}, after the sync again ${i + 1}`);
      for (let end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
        let left = 0;
        for (const t of ["customers", "orders", "seats", "bookings", "staff"]) left += await unnumbered(s.store, t);
        if (left === 0) break;
      }
      await numbered(s.sync, s.logged);
      await sameAnswers(s.api, s.url, s.logged, `after the sync again ${i + 1}, numbered`);
    }
  } finally { await s.close(); }
});

test("a store synced before its references were numbered is numbered at the next start, no table synced again", { skip }, async () => {
  const db = `${tag}_upgrade`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, SCHEMA);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const file = path.join(dir, "upgrade.db");
  const logged: string[] = [];
  // the first run: no references (a Mason before them)
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  await sync.open();
  sync.setTables(await tablesOf(parsed.source, false));
  await sync.once();
  await sync.stop();
  await store.close();
  // the next start, with them: numbered in place, nothing read again whole
  const before = logged.length;
  store = await DuckStore.open(file, (l) => logged.push(l));
  sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    sync.setTables(await tablesOf(parsed.source));
    await sync.once();
    await numbered(sync, logged);
    for (let end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      let left = 0;
      for (const t of ["customers", "orders", "accounts", "events", "seats", "bookings", "devices", "pings", "staff"]) left += await unnumbered(store, t);
      if (left === 0) break;
    }
    assert.ok(!logged.slice(before).some((l) => l.startsWith("synced ")), `no table is synced again:\n${logged.slice(before).filter((l) => l.startsWith("synced ")).join("\n")}`);
    const api = await listen(store, sync, db);
    try { await sameAnswers(api, url, logged, "after the start that numbered them"); } finally { await api.close(); }
  } finally {
    await sync.stop();
    await store.close();
  }
});

test("the stream numbers the rows it writes: a whole row, a key updated, a row deleted and inserted again", { skip: skip || (!logical && "the test server's wal_level is not logical") }, async () => {
  const s = await started("stream", "replication", { slot: `${tag}_s`, publication: `${tag}_s`, owned: true });
  try {
    await bothHidden(s.store, "after the first sync");
    await sameAnswers(s.api, s.url, s.logged, "after the first sync");
    for (const [i, w] of WRITES.entries()) {
      psql(s.url, w);
      await s.sync.caughtUp();
      for (const t of ["customers", "orders", "accounts", "events", "seats", "bookings", "devices", "pings", "staff"]) assert.equal(await unnumbered(s.store, t), 0, `${t}: every row the stream wrote is numbered with it`);
      await bothHidden(s.store, `after the stream's writes ${i + 1}`);
      await sameAnswers(s.api, s.url, s.logged, `after the stream's writes ${i + 1}`);
    }
  } finally { await s.close(); }
});
