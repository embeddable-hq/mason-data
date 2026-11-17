/**
 * HEAVY STATEMENTS TAKE A TURN (issue 1132; src/duck/admission.ts). Ten joins at once spilled 48.7 GB and took 659 s
 * where four at a time took 40.7 s: a statement whose plan keeps many rows in memory waits for one of a few turns, and
 * every other statement runs at once.
 *  - what is heavy is read from the engine's own plan (its EXPLAIN's estimates): a join's build side, a group by's
 *    groups, a sort's rows; a lookup, a filter and a group by into a few groups keep almost nothing;
 *  - the turns come from the memory limit and the engine's threads, and MASON_HEAVY_QUERIES sets them;
 *  - over the wire: a light statement never waits; a heavy one waits, its cancel and its statement_timeout end the wait
 *    with 57014; it runs once the turn is released; its request-log row has its wait (`waited_ms`).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { planNodes } from "../src/duck/explain.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import { SERVE } from "../src/cli/serve.ts";
import type { ApiLogRow } from "../src/api/request-log.ts";
import type { BackendMessage } from "../src/api/postgres/protocol.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import * as wire from "./postgres-api/wire.ts";

// WHAT THIS CHANGE ADDS, read when a test runs: the file loads without it, so each test fails by its name where it is missing
type AdmissionModule = typeof import("../src/duck/admission.ts");
const admission = await import("../src/duck/admission.ts" as string).catch((e: unknown) => {
  if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
  return null;
}) as AdmissionModule | null;
const mod = (): AdmissionModule => { assert.ok(admission !== null, "src/duck/admission.ts: the heavy statements' turns"); return admission; };

const GiB = 2 ** 30, MiB = 2 ** 20;

// ------------------------------------------------------------------------------------------------- the engine's plan

test("what a plan keeps is read from the engine's estimates: a join's build side, a group by's groups, a sort's rows; a lookup, a filter and a few groups keep almost nothing", async () => {
  const { keptRows } = mod();
  const db = await DuckDBInstance.create(":memory:", { threads: "2" });
  const c = await db.connect();
  try {
    await c.run("CREATE TABLE customers AS SELECT i AS id, i % 97 AS region FROM range(20000) t(i)");
    await c.run("CREATE TABLE orders AS SELECT i AS id, (i * 7919) % 20000 AS customer_id, ['new','paid','shipped','done','cancelled'][1 + i % 5] AS status, (i * 31) % 1000 AS amount FROM range(200000) t(i)");
    const kept = async (sql: string): Promise<number> => keptRows(planNodes(JSON.parse(String((await c.runAndReadAll(`EXPLAIN (FORMAT JSON) ${sql}`)).getRowsJS()[0]![1]))));
    // keeps nothing however many rows it reads
    assert.equal(await kept("SELECT * FROM orders WHERE id = 7"), 0, "a lookup");
    assert.equal(await kept("SELECT count(*), sum(amount) FROM orders WHERE amount > 10"), 0, "an aggregate of no group");
    assert.ok(await kept("SELECT status, count(*) FROM orders GROUP BY status") <= 10, "a group by into a few groups");
    assert.ok(await kept("SELECT * FROM orders ORDER BY amount DESC LIMIT 10") <= 100, "a top N, the table joined back to its own top rows");
    // keeps its rows
    assert.ok(await kept("SELECT o.status, c.region FROM orders o JOIN customers c ON c.id = o.customer_id") >= 20000, "a join: its build side");
    assert.ok(await kept("SELECT * FROM orders ORDER BY amount") >= 200000, "a sort: every row");
    assert.ok(await kept("SELECT customer_id, sum(amount) FROM orders GROUP BY customer_id") >= 5000, "a group by into many groups");
    assert.ok(await kept("SELECT count(DISTINCT customer_id) FROM orders") >= 5000, "a distinct count");
    assert.ok(await kept("SELECT median(amount) FROM orders") >= 200000, "an aggregate that holds every value");
    assert.ok(await kept("SELECT id, row_number() OVER (PARTITION BY customer_id ORDER BY amount) FROM orders") >= 200000, "a window");
  } finally { c.closeSync(); db.closeSync(); }
});

test("a statement that only scans and filters is light without asking the engine: no join, group, sort, window or aggregate that keeps rows", async () => {
  const { mayKeepRows } = mod();
  const { parseSql } = await import("../src/api/postgres/parser.ts");
  const keeps = async (sql: string): Promise<boolean> => mayKeepRows((await parseSql(sql)).stmts?.[0]?.stmt);
  for (const sql of ["SELECT * FROM orders WHERE id = $1", "SELECT count(*), sum(amount), max(id) FROM orders WHERE status = 'paid'", "SELECT id FROM orders LIMIT 10",
    "SELECT * FROM (SELECT id, amount * 2 AS a FROM orders WHERE amount > 1) s WHERE a < 9", "SELECT 1"]) {
    assert.equal(await keeps(sql), false, sql);
  }
  for (const sql of ["SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id", "SELECT * FROM orders o, customers c WHERE c.id = o.customer_id",
    "SELECT status, count(*) FROM orders GROUP BY status", "SELECT DISTINCT status FROM orders", "SELECT * FROM orders ORDER BY amount LIMIT 10",
    "SELECT row_number() OVER (ORDER BY id) FROM orders", "SELECT count(DISTINCT customer_id) FROM orders", "SELECT string_agg(status, ',') FROM orders",
    "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) FROM orders", "SELECT median(amount) FROM orders", "SELECT id FROM orders UNION SELECT id FROM customers",
    "SELECT * FROM orders WHERE customer_id IN (SELECT id FROM customers)", "WITH x AS (SELECT * FROM orders) SELECT count(*) FROM x"]) {
    assert.equal(await keeps(sql), true, sql);
  }
});

test("the turns come from the memory limit and the engine's threads, one a GiB, at most one a thread, at least one; MASON_HEAVY_QUERIES sets them", () => {
  const { heavyTurns, heavyQueriesOf, heavyRowsFor } = mod();
  assert.equal(heavyTurns(4 * GiB, 4, null), 4, "the published machine: the four at once that took 40.7 s with nothing spilled");
  assert.equal(heavyTurns(4 * GiB, 2, null), 2, "at most one a thread");
  assert.equal(heavyTurns(16 * GiB, 4, null), 4);
  assert.equal(heavyTurns(16 * GiB, 16, null), 16);
  assert.equal(heavyTurns(512 * MiB, 8, null), 1, "at least one");
  assert.equal(heavyTurns(4 * GiB, Number.NaN, null), 1, "threads that cannot be read: one");
  assert.equal(heavyTurns(4 * GiB, 4, 9), 9, "the setting");
  assert.equal(heavyQueriesOf({}), null);
  assert.equal(heavyQueriesOf({ MASON_HEAVY_QUERIES: "" }), null);
  assert.equal(heavyQueriesOf({ MASON_HEAVY_QUERIES: " 3 " }), 3);
  for (const bad of ["0", "-1", "2.5", "abc", "1025"]) {
    assert.throws(() => heavyQueriesOf({ MASON_HEAVY_QUERIES: bad }), (e: Error) => e.message.startsWith(`MASON_HEAVY_QUERIES=${JSON.stringify(bad)} is not a whole number from 1 to 1024`), bad);
  }
  // heavy: what would take more than its share if 32 statements at once kept as much, from the memory limit
  assert.equal(heavyRowsFor(4 * GiB), 4 * GiB / 32 / 64);
  assert.equal(heavyRowsFor(512 * MiB), 512 * MiB / 32 / 64);
  assert.match(SERVE.usage, /MASON_HEAVY_QUERIES\s+how many heavy queries run at once/, "mason serve --help says it");
});

test("a turn is given first come, first served; a waiter whose signal aborts takes none; a release is said once", async () => {
  const { Admission } = mod();
  const a = new Admission(2, 1);
  const order: string[] = [];
  const first = await a.admit(new AbortController().signal), second = await a.admit(new AbortController().signal);
  assert.ok(first !== null && second !== null);
  assert.equal(a.running, 2);
  const gone = new AbortController();
  const third = a.admit(new AbortController().signal).then((r) => { order.push("third"); return r; });
  const fourth = a.admit(gone.signal).then((r) => { order.push("fourth"); return r; });
  const fifth = a.admit(new AbortController().signal).then((r) => { order.push("fifth"); return r; });
  assert.equal(a.waiting, 3);
  gone.abort();
  assert.equal(await fourth, null, "aborted: no turn");
  assert.equal(a.waiting, 2);
  first();
  first();
  const t3 = await third;
  assert.equal(a.running, 2, "a release said twice hands on one turn");
  assert.equal(a.waiting, 1);
  second();
  const t5 = await fifth;
  assert.deepEqual(order, ["fourth", "third", "fifth"]);
  t3!(); t5!();
  assert.equal(a.running, 0);
  assert.equal(await a.admit(AbortSignal.abort()), null, "an aborted signal takes none");
});

// ------------------------------------------------------------------------------------------------- over the wire

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-admission-"));
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;
const recorded: ApiLogRow[] = [];
/** the engine's log lines */
const engineLog: string[] = [];
const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "customers", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "region", type: "int8" }] },
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "customer_id", type: "int8" }, { name: "status", type: "text" }, { name: "amount", type: "int8" }] },
  ],
};
/** heavy: a join whose build side is every customer, 20,000 rows, past the store's 5,000 */
const HEAVY = "SELECT o.id, c.region FROM orders o JOIN customers c ON c.id = o.customer_id";

before(async () => {
  // ONE TURN, and heavy from 5,000 rows kept (a run's are derived: tested above)
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => engineLog.push(l), { memoryLimit: "1GiB", heavyQueries: 1, heavyRows: 5000 } as Parameters<typeof DuckStore.open>[2]);
  await store.writer.run("CREATE TABLE public.customers AS SELECT i::BIGINT AS id, (i % 97)::BIGINT AS region FROM range(20000) t(i)");
  await store.writer.run("CREATE TABLE public.orders AS SELECT i::BIGINT AS id, ((i * 7919) % 20000)::BIGINT AS customer_id, ['new','paid','shipped','done','cancelled'][1 + i % 5] AS status, ((i * 31) % 1000)::BIGINT AS amount FROM range(200000) t(i)");
  const conn = await store.instance.connect();
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000, insert: async (sql, values) => { await conn.run(sql, values); } });
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: (row) => { recorded.push(row); ledger.record(row); }, log: () => undefined, duck: await store.listener(undefined),
  });
});
after(async () => {
  await api?.close();
  await ledger?.close();
  await store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = async (): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token, application_name: "admission-test" });
  await c.connect();
  return c;
};

/** a raw session: frames written, replies read up to each ReadyForQuery */
async function rawSession(): Promise<{ socket: net.Socket; pid: number; secret: number; untilReady(): Promise<BackendMessage[]>; end(): void }> {
  const socket = net.connect(api.port, "127.0.0.1");
  await new Promise<void>((r) => socket.once("connect", () => r()));
  let chunks: Buffer[] = [];
  let tail = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  socket.on("data", (d: Buffer) => { chunks.push(d); tail = Buffer.concat([tail, d]).subarray(-6); wake?.(); });
  const ready = (): boolean => tail.length === 6 && tail[0] === 0x5a && tail.readInt32BE(1) === 5;
  const untilReady = async (): Promise<BackendMessage[]> => {
    while (!ready()) await new Promise<void>((r) => { wake = r; });
    const ms = wire.replies(Buffer.concat(chunks));
    chunks = []; tail = Buffer.alloc(0);
    return ms;
  };
  socket.write(wire.startup({ user: "mason", database: "app" }));
  while (chunks.length === 0) await new Promise<void>((r) => { wake = r; });
  chunks = [];
  socket.write(wire.password(mintToken(API_KEY, 600).token));
  const key = (await untilReady()).find((m) => m.type === "BackendKeyData") as Extract<BackendMessage, { type: "BackendKeyData" }>;
  return { socket, pid: key.pid, secret: key.secret, untilReady, end: () => { socket.destroy(); } };
}

/** a session holding the one turn: a heavy statement's portal suspended after 10 rows, inside a transaction (released
 *  when the portal is closed) */
async function holdTheTurn(): Promise<{ release(): Promise<void>; end(): void }> {
  const s = await rawSession();
  s.socket.write(wire.query("BEGIN READ ONLY"));
  await s.untilReady();
  s.socket.write(Buffer.concat([wire.parse("", HEAVY), wire.bind("held", "", [], []), wire.execute("held", 10), wire.sync()]));
  const ms = await s.untilReady();
  assert.ok(ms.some((m) => m.type === "PortalSuspended"), `the heavy portal is suspended: ${ms.map((m) => m.type).join(", ")}`);
  return { release: async () => { s.socket.write(Buffer.concat([wire.close("P", "held"), wire.sync()])); await s.untilReady(); }, end: () => s.end() };
}

const rowOf = (sql: string): ApiLogRow | undefined => recorded.findLast((r) => r.payload === sql);

test("a light statement never waits for a heavy one's turn: a lookup and a group by into a few groups answer while the turn is held", async () => {
  const held = await holdTheTurn();
  const c = await client();
  try {
    const t = Date.now();
    assert.deepEqual((await c.query("SELECT id, status FROM orders WHERE id = 7")).rows, [{ id: "7", status: "shipped" }]);
    assert.equal((await c.query("SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status")).rows.length, 5);
    assert.ok(Date.now() - t < 5_000, `light statements took ${Date.now() - t} ms beside a held turn`);
    assert.equal(rowOf("SELECT id, status FROM orders WHERE id = 7")?.waitedMs, undefined, "a light statement's row says no wait: it takes no turn");
  } finally { await c.end(); await held.release(); held.end(); }
});

test("a heavy statement waits for the turn: its statement_timeout and its cancel end the wait with 57014, and it runs once the turn is released, its wait on its row", async () => {
  const held = await holdTheTurn();
  try {
    // THE TIMEOUT counts the wait
    const timed = await client();
    try {
      await timed.query("SET statement_timeout = 300");
      const t = Date.now();
      await assert.rejects(timed.query(HEAVY), (e: pg.DatabaseError) => e.code === "57014" && e.message === "canceling statement due to statement timeout");
      assert.ok(Date.now() - t >= 250 && Date.now() - t < 5_000, `the timeout ended its wait after ${Date.now() - t} ms`);
      await timed.query("SET statement_timeout = 0");
      assert.deepEqual((await timed.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 200000 }], "the session goes on");
    } finally { await timed.end(); }
    const timedRow = rowOf(HEAVY);
    assert.equal(timedRow?.sqlstate, "57014");
    assert.ok((timedRow?.waitedMs ?? 0) >= 250, `the row has the wait: ${timedRow?.waitedMs}`);

    // THE CANCEL ends the wait
    const s = await rawSession();
    try {
      s.socket.write(wire.query(`${HEAVY} LIMIT 5`));
      await sleep(300);
      const cancel = net.connect(api.port, "127.0.0.1");
      await new Promise<void>((r) => cancel.once("connect", () => r()));
      cancel.end(wire.cancelRequest(s.pid, s.secret));
      const error = (await s.untilReady()).find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
      assert.equal(error?.fields.C, "57014");
      assert.equal(error?.fields.M, "canceling statement due to user request");
    } finally { s.end(); }

    // RELEASED, the next waiter runs
    const waiter = await client();
    try {
      const asked = Date.now();
      const answered = waiter.query(`SELECT count(*)::int AS n FROM (${HEAVY}) j`).then((r) => ({ at: Date.now(), rows: r.rows }));
      await sleep(400);
      const releasedAt = Date.now();
      await held.release();
      const a = await answered;
      assert.deepEqual(a.rows, [{ n: 200000 }]);
      assert.ok(a.at >= releasedAt, `answered ${releasedAt - a.at} ms before the turn was released`);
      const row = rowOf(`SELECT count(*)::int AS n FROM (${HEAVY}) j`);
      assert.ok(row !== undefined && row.waitedMs !== undefined && row.waitedMs >= 300 && row.waitedMs <= Date.now() - asked, `its wait: ${row?.waitedMs}`);
      // and the ledger keeps it
      await ledger.flush();
      const kept = (await ledger.recent({ limit: 100 })).find((r) => r.query === `SELECT count(*)::int AS n FROM (${HEAVY}) j`);
      assert.equal(kept?.waitedMs, Math.round(row!.waitedMs!));
      // a heavy statement whose turn was free waited 0, and says so
      assert.deepEqual((await waiter.query(`SELECT count(*)::int AS m FROM (${HEAVY}) j`)).rows, [{ m: 200000 }]);
      assert.ok((rowOf(`SELECT count(*)::int AS m FROM (${HEAVY}) j`)?.waitedMs ?? -1) >= 0);
    } finally { await waiter.end(); }
  } finally { held.end(); }
});

test("a statement is weighed under its own cancel: one after a cancelled statement that called a Mason function is weighed, not taken for cancelled", async () => {
  const c = await client();
  try {
    // A STATEMENT THAT CALLS A MASON FUNCTION ROW BY ROW, cancelled by its timeout: the session's cancel then names it
    await c.query("SET statement_timeout = 30");
    let cancelled = false;
    for (let i = 0; i < 5 && !cancelled; i++) {
      cancelled = await c.query("SELECT count(*) FROM orders a, customers b WHERE a.id < $1::numeric AND b.id::numeric < $1::numeric", ["150000.5"])
        .then(() => false, (e: pg.DatabaseError) => { assert.equal(e.code, "57014"); return true; });
    }
    assert.ok(cancelled, "the statement that calls a function per row was cancelled by its timeout");
    await c.query("SET statement_timeout = 0");
    // the next one folds a Mason function over a constant while the engine plans it, as it is weighed (an ORDER BY)
    const before = engineLog.length;
    assert.deepEqual((await c.query("SELECT id FROM orders WHERE id < $1::numeric ORDER BY id LIMIT 3", ["100"])).rows, [{ id: "0" }, { id: "1" }, { id: "2" }]);
    assert.deepEqual(engineLog.slice(before).filter((l) => /estimate of a statement could not be read/.test(l)), [], "weighed, not cancelled by the statement before");
  } finally { await c.end(); }
});
