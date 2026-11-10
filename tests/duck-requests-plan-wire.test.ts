/**
 * THE PLAN OF A SLOW STATEMENT, WITH ITS REQUEST-LOG ROW (issue 825; src/api/postgres/slow-plan.ts → src/duck/requests.ts).
 * A real Postgres listener over a throwaway DuckStore, its `record` the ledger as `mason start` wires it: a statement
 * that took SLOW_MS or more has Mason's plain EXPLAIN of it on its row (the tables, the SQL sent to the engine, the
 * engine's operators with their estimates), recorded once it ended and never before its answer; a fast one, a refused
 * one and a cancelled one have none; a plan past the cap is cut and says so; at most one is recorded at a time (a
 * second slow statement meanwhile has none, said once in the log); a statement bound with values has its operators
 * without their details; and the role is held as it is when the plan is recorded.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type DuckOptions, type DuckRunner, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { ApiLogRow, StoredPlan } from "../src/api/request-log.ts";
import { SLOW_MS } from "../src/cli/request-filter.ts";
// what this change adds, read when a test runs: the file loads without it, so each test fails by its name where it is missing
const requestLog = await import("../src/api/request-log.ts") as unknown as { MAX_STORED_PLAN_BYTES: number; storedPlan: (text: string) => StoredPlan };
const explainModule = await import("../src/duck/explain.ts") as unknown as { DETAILS_HIDDEN: string };
import type { PgSchema } from "../src/api/postgres/schema.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-requests-plan-"));
let store: DuckStore;
let ledger: RequestLedger;
const said: string[] = [];
/** while set, the plan recorder's EXPLAIN waits for it (the sessions never EXPLAIN here): a plan held in flight */
let gate: Promise<void> | null = null;
/** how many EXPLAINs the recorder's connection was asked */
let explains = 0;
const servers: PgApiServer[] = [];

const BIG_ROWS = 20_000;
const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }, { name: "qty", type: "int4" }] },
    { name: "big", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "v", type: "int8" }] },
  ],
};

/** the run's listener options, its `open` wrapped so the recorder's EXPLAIN can be held (`gate`) and counted */
async function duck(): Promise<DuckOptions> {
  const real = await store.listener(undefined);
  return { ...real, open: async (): Promise<DuckRunner> => {
    const r = await real.open();
    return { run: (...a) => r.run(...a), close: () => r.close(),
      explain: async (...a) => { explains++; if (gate !== null) await gate; return r.explain(...a); } };
  } };
}

/** a listener over the store, the ledger its record; `slowMs` the time from which a statement's plan is recorded */
async function listener(slowMs?: number, rows: ApiLogRow[] = []): Promise<PgApiServer> {
  const api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: (row) => { rows.push(row); ledger.record(row); }, log: (l) => said.push(l), duck: await duck(),
    ...(slowMs !== undefined ? { slowMs } : {}),
  });
  servers.push(api);
  return api;
}

const client = async (api: PgApiServer): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token, application_name: "plan-test" });
  await c.connect();
  return c;
};

/** the rows recorded since `n` rows were, once every plan settled and the ledger wrote them */
async function since(n: number): Promise<Awaited<ReturnType<RequestLedger["recent"]>>> {
  await ledger.flush();
  return (await ledger.recent({ limit: 1000 })).slice(n);
}
const count = async (): Promise<number> => { await ledger.flush(); return (await ledger.recent({ limit: 1000 })).length; };

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR, qty INTEGER)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 'paid', 2), (2, 'paid', 1), (3, 'pending', 5)");
  await store.writer.run("CREATE TABLE public.big (id BIGINT, v BIGINT)");
  await store.writer.run(`INSERT INTO public.big SELECT i, (i * 7919) % 100003 FROM range(${BIG_ROWS}) t(i)`);
  const real = await store.instance.connect();
  ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7, flushMs: 60_000, insert: async (sql, values) => { await real.run(sql, values); } });
});
after(async () => {
  for (const s of servers) await s.close();
  await ledger.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a statement that took SLOW_MS or more has its plan on its row: the tables, the SQL sent to the engine, the operators with their estimates; a fast one has none", async () => {
  const api = await listener();
  // the catalog Postgres starts at a run's first statement, which is then slow: started first
  const warm = await client(api);
  try { await warm.query("SELECT id FROM orders LIMIT 1"); } finally { await warm.end(); }
  const n = await count();
  const c = await client(api);
  // SLOW BY CONSTRUCTION: a condition the engine can join by no key, so every pair of BIG_ROWS² is computed (about 2 s on
  // 4 cores), and on a machine where that is under SLOW_MS, the same times 3, then 9: the slow one is the last asked
  const slowOnes = ["", ", orders c", ", orders c, orders d"].map((more) => `SELECT count(*) AS n FROM big a, big b${more} WHERE (a.v * 31 + b.v) % 100003 = 7`);
  const asked: string[] = [];
  try {
    assert.equal((await c.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 3);
    for (const sql of slowOnes) {
      const t0 = Date.now();
      await c.query(sql);
      asked.push(sql);
      // its plan recorded before the next is asked: one at a time
      await ledger.flush();
      if (Date.now() - t0 >= SLOW_MS * 1.5) break;
    }
  } finally { await c.end(); }
  const rows = await since(n);
  assert.deepEqual(rows.map((r) => r.query), ["SELECT count(*)::int AS n FROM orders", ...asked]);
  const fast = rows[0]!, slow = rows[rows.length - 1]!;
  assert.ok(fast.durationMs < SLOW_MS);
  assert.deepEqual([fast.plan, fast.planTruncated], [null, false], "a fast statement costs nothing: no plan");
  assert.ok(slow.durationMs >= SLOW_MS, `the statement made slow took ${slow.durationMs} ms: the machine is faster than this test assumes`);
  for (const r of rows.slice(1)) assert.equal(r.plan !== null, r.durationMs >= SLOW_MS, `a plan exactly when it took SLOW_MS or more: ${r.durationMs} ms`);
  const plan = slow.plan ?? "";
  assert.match(plan, /^(Mason: answered from the synced table | {2})public\.big \(about 20,000 rows; how it is kept current is unknown: the sync has no record of it\)$/m, "the table and how it is kept current");
  assert.match(plan, /^ {2}Sent to the engine: SELECT count\(\*\) AS n FROM big AS a, big AS b/m, "the SQL sent to the engine");
  assert.match(plan, /\(rows=\d+\)/, "the engine's operators with their estimated rows");
  assert.match(plan, /Table Scan on public\.big/);
  assert.equal(slow.planTruncated, false);
  assert.ok(!said.some((l) => /request log:/.test(l)), `nothing said of the request log: ${said.join("\n")}`);
});

test("a refused statement, a cancelled one and an EXPLAIN have no plan, however long; one that reached the engine and failed there has its plan", async () => {
  const api = await listener(0);
  const n = await count();
  const c = await client(api);
  try {
    await assert.rejects(c.query("SELECT * FROM nope"), /relation "nope" does not exist/);
    await c.query("SET statement_timeout = 200");
    await assert.rejects(c.query("SELECT count(*) AS n FROM big a, big b WHERE (a.v * 31 + b.v) % 100003 = 7"), /statement timeout/);
    await c.query("SET statement_timeout = 0");
    await c.query("EXPLAIN SELECT id FROM orders");
    // reached the engine and failed in it: its plan is worth having
    await assert.rejects(c.query("SELECT id / (qty - qty) FROM orders"), /division by zero|divide by zero/i);
  } finally { await c.end(); }
  const rows = await since(n);
  assert.deepEqual(rows.map((r) => [r.outcome, r.plan === null]), [["refused", true], ["cancelled", true], ["ok", true], ["refused", false]]);
  assert.match(rows[3]!.plan ?? "", /Sent to the engine: SELECT id \/\/ \(qty - qty\)/);
});

test("a plan past the cap is cut at a line and says so", async () => {
  const cut = requestLog.storedPlan(Array.from({ length: 2000 }, (_, i) => `line ${i} ${"é".repeat(5)}`).join("\n"));
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text) <= requestLog.MAX_STORED_PLAN_BYTES);
  assert.match(cut.text, /line \d+ é{5}$/, "whole lines, never half a character");
  assert.deepEqual(requestLog.storedPlan("short"), { text: "short", truncated: false });
  // through the wire: a statement whose SQL sent to the engine alone is past the cap
  const api = await listener(0);
  const n = await count();
  const c = await client(api);
  const wide = `SELECT ${Array.from({ length: 600 }, (_, i) => `id + ${i} AS column_number_${i}`).join(", ")} FROM orders`;
  try { await c.query(wide); } finally { await c.end(); }
  const [row] = await since(n);
  assert.equal(row!.planTruncated, true);
  assert.ok(Buffer.byteLength(row!.plan ?? "") <= requestLog.MAX_STORED_PLAN_BYTES && (row!.plan ?? "").startsWith("Mason: answered from the synced table public.orders"));
});

test("at most one plan at a time: a slow statement that ends while another's plan is recorded has none, said once, and counted when one is recorded again", async () => {
  const api = await listener(0);
  const n = await count();
  said.length = 0;
  let open!: () => void;
  gate = new Promise((resolve) => { open = resolve; });
  const c = await client(api);
  try {
    const first = Date.now();
    // the answers come at once: the plan held in flight delays none of them
    await c.query("SELECT id FROM orders WHERE id = 1");
    await c.query("SELECT id FROM orders WHERE id = 2");
    await c.query("SELECT id FROM orders WHERE id = 3");
    assert.ok(Date.now() - first < 5_000);
    assert.equal(said.filter((l) => /was not recorded: another slow statement's plan was being recorded/.test(l)).length, 1, `said once: ${said.join("\n")}`);
    gate = null;
    open();
    await ledger.flush();
    await c.query("SELECT id FROM orders WHERE id > 1");
  } finally { gate = null; open(); await c.end(); }
  const rows = await since(n);
  assert.deepEqual(rows.map((r) => [r.query, r.plan !== null]), [
    ["SELECT id FROM orders WHERE id = 1", true],
    ["SELECT id FROM orders WHERE id = 2", false],
    ["SELECT id FROM orders WHERE id = 3", false],
    ["SELECT id FROM orders WHERE id > 1", true],
  ]);
  assert.ok(said.some((l) => /recording slow statements' plans again; 2 slow statement\(s\) had none recorded/.test(l)), said.join("\n"));
});

test("a statement bound with values: its plan is the one its values made, its operators without their details, and no value in it", async () => {
  const api = await listener(0);
  const n = await count();
  const c = await client(api);
  try {
    await c.query("SELECT status, count(*) FROM orders WHERE qty > $1 GROUP BY status HAVING count(*) > $2 ORDER BY 2 DESC", [0, 987654]);
    // its plan recorded before the next ends: one at a time
    await ledger.flush();
    await c.query("SELECT id FROM orders WHERE status = $1 ORDER BY id", ["zz-secret-zz"]);
  } finally { await c.end(); }
  const rows = await since(n);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    const plan = r.plan ?? "";
    assert.ok(plan.includes(`Note: ${explainModule.DETAILS_HIDDEN}`), plan);
    assert.match(plan, /\(rows=\d+\)/, "the operators and their estimates are kept");
    assert.ok(!plan.includes("987654") && !plan.includes("zz-secret-zz"), `no bound value: ${plan}`);
  }
});

test("the listener closing abandons the plan in flight: its row is written without one, and nothing is left open", async () => {
  const api = await listener(0);
  const n = await count();
  said.length = 0;
  let open!: () => void;
  gate = new Promise((resolve) => { open = resolve; });
  const c = await client(api);
  try { await c.query("SELECT id FROM orders WHERE id = 1"); } finally { await c.end(); }
  const before = explains;
  const closing = api.close();
  // the EXPLAIN is interrupted by the abort once it runs: released, so the close can finish
  gate = null;
  open();
  await closing;
  servers.splice(servers.indexOf(api), 1);
  const rows = await since(n);
  assert.deepEqual(rows.map((r) => [r.query, r.plan]), [["SELECT id FROM orders WHERE id = 1", null]]);
  assert.ok(explains >= before);
  assert.ok(said.some((l) => /the plan of a slow statement \(session \d+\) was not recorded: the listener closed/.test(l)), said.join("\n"));
});

test("a refusal when the plan is recorded (the session's role as it is then) is the plan's words, never an error; a bound statement's keeps no message", async () => {
  const { SlowPlans } = await import("../src/api/postgres/slow-plan.ts");
  const lines: string[] = [];
  const runner: DuckRunner = { run: () => { throw new Error("not run"); }, explain: () => { throw new Error("not explained"); }, close: async () => undefined };
  const plans = new SlowPlans(async () => runner, (l) => lines.push(l));
  // the role checked as the plan is recorded: what the session's role reads now refuses it (src/api/postgres/server.ts heldToRole)
  const refusal = Object.assign(new Error("permission denied for table orders"), { fields: { code: "42501" } });
  assert.deepEqual(await plans.record("session 1", () => { throw refusal; }, false),
    { text: "the plan was not recorded: 42501 permission denied for table orders", truncated: false });
  const quoting = Object.assign(new Error('invalid input syntax for type integer: "zz-secret-zz"'), { fields: { code: "22P02" } });
  const kept = await plans.record("session 2", async () => { throw quoting; }, true);
  assert.equal(kept?.text, "the plan was not recorded: 22P02 (its message is not kept: it may quote a value the statement was bound with)");
  assert.deepEqual(lines, [], "the statement's own refusal is its row's to say, not the log's");
  await plans.close();
  assert.equal(plans.record("session 3", async () => ["x"], false), undefined, "nothing is asked once closed");
});
