/**
 * GENERATED TABLES AGAINST A REAL POSTGRES (src/duck/generated.ts, issue 124): every statement over a generated table is
 * held equal to what Postgres answers from the same SQL over the base (names, OIDs, text, order), and held again after
 * each way a change arrives: a poll, a stream batch, the changes a stream holds during a table's catch-up, and a copy made
 * again. A run racing a poll takes what its snapshot holds and the next run the rest; an idle base runs nothing. The truth
 * is a view of the definition's SQL, in the database the test made, with the generated table's name.
 *
 * What it needs: IT_POSTGRES_URL (wal_level = logical for the stream's test), psql on PATH. It writes only inside databases
 * it creates, `it_generated_<random>…`, and drops them at the end.
 */
import { after, afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable, type CopyState } from "../../src/duck/sync.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";
import { stopParser } from "../../src/api/postgres/parser.ts";
import { GENERATED_DIR, readGenerated } from "../../src/cli/generated-files.ts";
import type { GeneratedStatus, GeneratedStep } from "../../src/duck/generated.ts";
import { isLibcCollation } from "../../src/duck/rewrite.ts";
import { readLibcOrder, type LibcOrder } from "../../src/duck/libc-order.ts";
import { mintToken, tokenProblem } from "../../src/duck/token.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_generated_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-generated-"));
const API_KEY = "k".repeat(48);

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };

afterEach(async () => {
  if (!adminUrl || !logical) return;
  const held = (): string => psql(adminUrl, `SELECT count(*) FILTER (WHERE active) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%'`);
  for (const until = Date.now() + 10_000; held() !== "0" && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
});

after(async () => {
  await stopParser();
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
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

const SEED = "CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL, region text); " +
  "CREATE TABLE orders (id bigint PRIMARY KEY, tenant_id int, status text, quantity int, ratio double precision, paid boolean, created_at timestamptz, taken interval, ref uuid, payload jsonb); " +
  "INSERT INTO customers VALUES (1, 'Ada', 'eu'), (2, 'bob', NULL), (3, 'Cleo', 'us'); " +
  "INSERT INTO orders SELECT g, 1 + g % 3, (ARRAY['paid', 'Open', 'failed', NULL])[1 + g % 4], (g * 7) % 11, g / 8.0, g % 5 = 0, " +
  "timestamptz '2026-01-01 22:00:00+00' + g * interval '5 hours', g * interval '90 seconds', ('00000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, " +
  "CASE WHEN g % 6 = 0 THEN NULL ELSE jsonb_build_object('k', g % 2, 'name', 'x' || g) END FROM generate_series(1, 60) g ORDER BY (g * 37) % 101";

/** each file's SQL, and what is asked of the table: the truth is a view of that same SQL */
const DEFINITIONS: Array<{ name: string; schema: string; table: string; sql: string; orderBy: string | null; statements: string[] }> = [
  { name: "daily", schema: "public", table: "daily",
    sql: "SELECT tenant_id, date_trunc('day', created_at, 'UTC') AS day, count(*) AS orders, sum(quantity) AS units, min(status) AS first_status, max(created_at) AS last_at, bool_or(paid) AS any_paid FROM orders GROUP BY 1, 2",
    orderBy: "day, tenant_id",
    statements: [
      "SELECT * FROM daily ORDER BY day, tenant_id",
      "SELECT tenant_id, sum(orders) AS orders, sum(units) AS units FROM daily GROUP BY tenant_id ORDER BY tenant_id",
      "SELECT day, first_status FROM daily WHERE units > 3 ORDER BY first_status DESC, day, tenant_id",
      "SELECT d.day, c.name, d.orders FROM daily d JOIN customers c ON c.id = d.tenant_id ORDER BY d.day, c.name LIMIT 7",
      "SELECT count(*) AS days, min(day) AS first_day, max(last_at) AS last_at FROM daily",
    ] },
  { name: "joined", schema: "public", table: "joined",
    sql: "SELECT o.id, c.name, o.status, o.quantity::smallint AS quantity, o.ratio, o.paid, (o.created_at AT TIME ZONE 'UTC')::date AS on_day, o.created_at AT TIME ZONE 'UTC' AS utc, o.created_at, o.taken, o.ref, o.payload, o.payload ->> 'name' AS payload_name FROM orders o LEFT JOIN customers c ON c.id = o.tenant_id",
    orderBy: "on_day, id",
    statements: [
      "SELECT * FROM joined ORDER BY id",
      "SELECT name, count(*) AS n, sum(quantity) AS q, count(payload) AS with_payload FROM joined GROUP BY name ORDER BY name",
      "SELECT status, count(*) AS n FROM joined GROUP BY status ORDER BY status",
      "SELECT id, status FROM joined ORDER BY status NULLS FIRST, id LIMIT 9",
      "SELECT id, payload ->> 'k' AS k, payload_name FROM joined WHERE payload ->> 'k' = '1' ORDER BY id LIMIT 5",
      "SELECT on_day, utc::text AS utc, created_at::text AS created_at, taken::text AS taken, ref::text AS ref FROM joined WHERE id < 5 ORDER BY id",
    ] },
  { name: "reports.ranked", schema: "reports", table: "ranked",
    sql: "SELECT tenant_id, count(*) AS n, rank() OVER (ORDER BY count(*) DESC, tenant_id) AS position FROM orders GROUP BY tenant_id",
    orderBy: "position",
    statements: [
      "SELECT * FROM reports.ranked ORDER BY position",
      "SELECT position, n FROM reports.ranked WHERE position <= 2 ORDER BY position",
    ] },
];

interface Harness {
  store: DuckStore; sync: Sync; logged: string[]; reached: GeneratedStep[];
  status(name: string): GeneratedStatus;
  until(name: string, done: (s: GeneratedStatus) => boolean): Promise<GeneratedStatus>;
  /** every table's statements held to Postgres's answer */
  hold(step: string): Promise<void>;
  /** `name`'s definition added to the folder and the truth */
  define(file: string, schemaTable: string, sql: string): void;
  /** every table current: nothing behind, no run going */
  settled(): Promise<void>;
  gate: { step: GeneratedStep | null; wait: Promise<void> | null };
  ask(sql: string): Promise<unknown>;
  truthOf(sql: string): Promise<unknown>;
}

const yaml = (d: { sql: string; orderBy: string | null }): string => `kind: scheduled\ntarget_lag: 1s\nsql: |\n  ${d.sql}\n${d.orderBy === null ? "" : `order_by: ${d.orderBy}\n`}`;
const text = { getTypeParser: () => (v: unknown) => v };
const answer = async (c: pg.Client, sql: string): Promise<unknown> => {
  const r = await c.query({ text: sql, rowMode: "array", types: text as never });
  return { fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows };
};

async function withHarness(db: string, mode: "poll" | "replication", use: (h: Harness, url: string, source: Source) => Promise<void>): Promise<void> {
  const url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SEED}; CREATE SCHEMA reports`);
  for (const d of DEFINITIONS) psql(url, `CREATE VIEW ${d.schema}.${d.table} AS ${d.sql}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const source = parsed.source;
  const root = path.join(dir, db), folder = path.join(root, "mason"), generated = path.join(folder, GENERATED_DIR);
  fs.mkdirSync(generated, { recursive: true });
  for (const d of DEFINITIONS) fs.writeFileSync(path.join(generated, `${d.name}.yml`), yaml(d));
  const logged: string[] = [], reached: GeneratedStep[] = [];
  const gate: Harness["gate"] = { step: null, wait: null };
  const store = await DuckStore.open(path.join(root, "duck.db"), (l) => logged.push(l), { memoryLimit: "256MB" });
  const replication = mode === "replication" ? { slot: db, publication: db, owned: true } : null;
  const sync = new Sync(store, source, db, (l) => logged.push(l), mode === "poll" ? 3_600_000 : 1_000, mode, replication, {
    generated: { reviewMs: 0, onStep: async (s) => { reached.push(s); if (gate.step === s) await gate.wait; } },
  });
  let api: Awaited<ReturnType<typeof startPostgresApi>> | null = null;
  let mason: pg.Client | null = null;
  const truth = new pg.Client({ connectionString: url });
  await truth.connect();
  try {
    await sync.open();
    sync.setTables(await tablesOf(source, ["public.orders", "public.customers"]));
    await sync.once();
    if (mode === "replication") await sync.caughtUp();
    const copies = (): CopyState[] => [...sync.state(), ...sync.generated.copies()];
    // the database's text order, as `mason start` reads it
    const connected = await connectSource(source);
    if ("failure" in connected) throw new Error(connected.failure.message);
    let collation: Awaited<ReturnType<typeof readSourceFacts>>["collation"];
    let libc: LibcOrder | undefined;
    try {
      collation = (await readSourceFacts(connected.pg)).collation;
      const coll = collation;
      if (coll !== undefined && isLibcCollation(coll.provider, coll.collate)) {
        libc = (await store.libcOrder(coll.collate, coll.version ?? null, () => readLibcOrder(async (sql) => (await connected.pg.query(sql)).rows, coll.collate, coll.version ?? null))).order;
      }
    } finally { connected.pg.close(); }
    api = await startPostgresApi({
      port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test", product: "mason-data",
      authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
      schema: () => sync.schema(), record: () => undefined, log: () => undefined,
      duck: await store.listener(collation, undefined, libc, copies, sync.kept),
    });
    await sync.generated.start(() => readGenerated(folder, root), api.planner());
    mason = new pg.Client({ host: "127.0.0.1", port: api.port, database: db, user: "mason", password: mintToken(API_KEY, 3600).token });
    await mason.connect();
    const client = mason;
    const status = (name: string): GeneratedStatus => {
      const s = sync.generated.status().find((x) => x.table === name);
      assert.ok(s !== undefined, `no generated table ${name}`);
      return s;
    };
    const until = async (name: string, done: (s: GeneratedStatus) => boolean): Promise<GeneratedStatus> => {
      const end = Date.now() + 60_000;
      for (;;) {
        await sync.generated.review();
        const s = status(name);
        if (done(s)) return s;
        if (Date.now() > end) assert.fail(`${name} never got there: ${JSON.stringify(s)}\n${logged.slice(-12).join("\n")}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const settled = async (): Promise<void> => {
      for (const s of sync.generated.status()) await until(s.table, (x) => x.state === "current");
    };
    await use({
      store, sync, logged, reached, status, until, settled, gate,
      ask: (sql) => answer(client, sql), truthOf: (sql) => answer(truth, sql),
      define: (file, schemaTable, sql) => { psql(url, `CREATE VIEW ${schemaTable} AS ${sql}`); fs.writeFileSync(path.join(generated, `${file}.yml`), yaml({ sql, orderBy: null })); },
      hold: async (step) => {
        for (const d of DEFINITIONS) for (const sql of d.statements) {
          assert.deepEqual(await answer(client, sql), await answer(truth, sql), `${step}: ${sql}\n${logged.slice(-6).join("\n")}`);
        }
      },
    }, url, source);
  } finally {
    await mason?.end();
    await truth.end();
    await api?.close();
    await sync.stop();
    await store.close();
  }
}

/** every table current, then every statement held to Postgres */
const noneBehind = async (h: Harness, step: string): Promise<void> => {
  await h.settled();
  await h.hold(step);
};

test("over a poll: built, held to Postgres, re-run after each kind of change, idle over idle bases, and a copy made again marks it", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  await withHarness(`${tag}_p`, "poll", async (h, url, source) => {
    await h.until("public.daily", (s) => s.serving);
    await h.until("public.joined", (s) => s.serving);
    await h.until("reports.ranked", (s) => s.serving);
    await noneBehind(h, "the first build");
    assert.equal(h.status("public.daily").method, "whole");
    assert.equal(h.status("public.joined").targetLag, "1s");

    const built = h.status("public.daily").lastRun?.at;
    psql(url, "INSERT INTO orders VALUES (100, 2, 'Open', 3, 1.5, true, '2026-02-01 12:00:00+00', '1 hour', NULL, '{\"k\": 1}'); UPDATE orders SET status = NULL, quantity = 40 WHERE id = 7; " +
      "DELETE FROM orders WHERE id BETWEEN 10 AND 12; UPDATE orders SET id = 1007 WHERE id = 20; UPDATE customers SET name = 'Zed' WHERE id = 2");
    await h.sync.once();
    await h.until("public.daily", (s) => s.lastRun?.at !== built);
    await noneBehind(h, "an insert, an update, a delete, a key's change");

    // nothing runs over idle bases: a poll that found nothing leaves every table as it was
    const idle = h.sync.generated.status().map((s) => s.lastRun?.at);
    await h.sync.once();
    await new Promise((r) => setTimeout(r, 1_300));
    await h.sync.generated.review();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(h.sync.generated.status().map((s) => s.lastRun?.at), idle, "an idle base runs nothing");
    assert.ok(h.sync.generated.status().every((s) => s.behindSeconds === 0));

    psql(url, "TRUNCATE orders; INSERT INTO orders VALUES (1, 1, 'paid', 1, 0.5, false, '2026-03-01 00:00:00+00', '1 minute', NULL, NULL), (2, 3, NULL, 2, NULL, NULL, NULL, NULL, NULL, NULL)");
    await h.sync.once();
    await h.until("public.joined", (s) => s.lastRun?.rows === 2);
    await noneBehind(h, "a TRUNCATE");

    // A RUN RACING A POLL: held after its snapshot, a poll commits beside it; the run's table lacks that row and says
    // it is behind, and the next run has it
    h.reached.length = 0;
    let release = (): void => undefined;
    h.gate.step = "snapshot";
    h.gate.wait = new Promise<void>((r) => { release = r; });
    try {
      psql(url, "INSERT INTO orders VALUES (3, 1, 'paid', 1, 0.5, false, '2026-03-02 00:00:00+00', '1 minute', NULL, NULL)");
      await h.sync.pollNow(["public.orders"]);
      await h.until("public.joined", () => h.reached.includes("snapshot"));
      psql(url, "INSERT INTO orders VALUES (4, 1, 'paid', 1, 0.5, false, '2026-03-03 00:00:00+00', '1 minute', NULL, NULL)");
      await h.sync.pollNow(["public.orders"]);
      assert.ok(h.sync.generated.status().some((s) => s.state === "behind"), "the run in hand counts until its swap");
    } finally { h.gate.step = null; release(); }
    await h.until("public.joined", (s) => s.lastRun?.rows === 4);
    await noneBehind(h, "a run racing a poll");

    // A COPY MADE AGAIN marks what reads it, here because its columns changed
    psql(url, "ALTER TABLE customers ADD COLUMN tier text; INSERT INTO customers VALUES (4, 'Dee', 'eu', 'gold'); INSERT INTO orders VALUES (5, 4, 'paid', 2, 0.5, false, '2026-03-04 00:00:00+00', '1 minute', NULL, NULL)");
    const before = h.status("public.joined").lastRun?.at;
    h.sync.setTables(await tablesOf(source, ["public.orders", "public.customers"]));
    await h.sync.once();
    await h.sync.once();
    await h.until("public.joined", (s) => s.lastRun?.at !== before && s.lastRun?.rows === 5);
    await noneBehind(h, "a copy made again");
  });
});

test("over the stream: a batch marks what reads it, and the changes held during a table's catch-up do too", { skip: !adminUrl ? "IT_POSTGRES_URL is not set" : !logical ? "IT_POSTGRES_URL's server has no wal_level = logical" : false }, async () => {
  await withHarness(`${tag}_s`, "replication", async (h, url, source) => {
    await h.until("public.daily", (s) => s.serving);
    await h.until("public.joined", (s) => s.serving);
    await h.until("reports.ranked", (s) => s.serving);
    await noneBehind(h, "the first build");

    const built = h.status("public.daily").lastRun?.at;
    psql(url, "INSERT INTO orders VALUES (100, 2, 'Open', 3, 1.5, true, '2026-02-01 12:00:00+00', '1 hour', NULL, '{\"k\": 1}'); UPDATE orders SET status = 'paid' WHERE id = 7; DELETE FROM orders WHERE id = 11");
    await h.sync.caughtUp();
    await h.until("public.daily", (s) => s.lastRun?.at !== built);
    await noneBehind(h, "a stream batch");

    psql(url, "TRUNCATE customers");
    await h.sync.caughtUp();
    await h.until("public.joined", (s) => s.lastRun !== null && s.state === "current");
    await noneBehind(h, "a stream's TRUNCATE");
    psql(url, "INSERT INTO customers VALUES (1, 'Ada', 'eu')");
    await h.sync.caughtUp();
    await noneBehind(h, "a stream's insert after it");

    // A TABLE ADDED WITH THE APP WRITING: some of these changes are held while its catch-up polls, and a generated table
    // over it ends equal to Postgres whichever way each arrived
    psql(url, "CREATE TABLE later (id int PRIMARY KEY, v int); INSERT INTO later SELECT g, g FROM generate_series(1, 2000) g");
    h.define("later_totals", "public.later_totals", "SELECT v % 7 AS bucket, count(*) AS n, sum(v) AS total FROM later GROUP BY 1");
    const writing = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", url, "-c",
      "DO $$ BEGIN FOR i IN 1..60 LOOP UPDATE later SET v = v + 1 WHERE id = 1 + i; COMMIT; PERFORM pg_sleep(0.05); END LOOP; END $$"], { stdio: ["ignore", "ignore", "pipe"] });
    const ended = new Promise<number | null>((r) => { writing.on("close", r); });
    h.sync.setTables(await tablesOf(source, ["public.orders", "public.customers", "public.later"]));
    await h.sync.once();
    assert.equal(await ended, 0, "the app's writes ran");
    await h.sync.caughtUp();
    await h.until("public.later_totals", (s) => s.serving && s.state === "current");
    await noneBehind(h, "a table added with the app writing");
    const totals = "SELECT * FROM later_totals ORDER BY bucket";
    assert.deepEqual(await h.ask(totals), await h.truthOf(totals));
  });
});
