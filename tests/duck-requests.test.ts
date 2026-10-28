/**
 * THE DUCKDB RUN'S REQUEST LOG (src/duck/requests.ts, `_mason.requests`; a BI tool met an error on the test server
 * and nothing could be found afterwards): what the listener records is read back as it was written, newest last; the
 * rows past MASON_REQUEST_LOG_DAYS are deleted, said with their count; a write that fails is said once, never thrown,
 * and the next one that succeeds says so; the slow and refused statements are read in mason status's shapes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import { DEFAULT_REQUEST_LOG_DAYS, outcomeOf, RequestLedger, REQUESTS_TABLE, requestLogDays } from "../src/duck/requests.ts";
import type { ApiLogRow } from "../src/api/request-log.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-requests-"));
const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const row = (o: Partial<ApiLogRow> & { requestId: string }): ApiLogRow => ({
  at: new Date(), method: "QUERY", status: 200, durationMs: 12, client: "postgres:Metabase", payload: "SELECT 1", payloadTruncated: false, ...o,
});

test("every request is read back as the listener built it: the statement, the outcome and SQLSTATE, DETAIL and HINT, the rows, who; newest last", async () => {
  const said: string[] = [];
  const ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7 });
  const t0 = Date.now() - 60_000;
  ledger.record(row({ requestId: "a1", at: new Date(t0), session: 4, rows: 20, payload: "SELECT id FROM public.orders LIMIT 20", bytesSent: 812 }));
  ledger.record(row({ requestId: "a2", at: new Date(t0 + 1000), session: 4, method: "EXECUTE", status: 400, sqlstate: "42P01", error: 'relation "nope" does not exist',
    detail: "the detail", hint: "the hint", durationMs: 3, payload: "SELECT * FROM nope", client: "postgres:unnamed", tokenName: "bi-tool" }));
  ledger.record(row({ requestId: "a3", at: new Date(t0 + 2000), status: 500, sqlstate: "XX000", error: "it broke\nsecond line", payload: "x".repeat(10), payloadTruncated: true }));
  assert.deepEqual(await ledger.recent({ limit: 10 }), [], "nothing is read before its batch commits");
  await ledger.flush();
  const all = await ledger.recent({ limit: 10 });
  assert.deepEqual(all.map((r) => r.requestId), ["a1", "a2", "a3"], "newest last");
  assert.deepEqual(all[0], { requestId: "a1", startedAt: new Date(t0).toISOString(), session: 4, applicationName: "Metabase", tokenName: "", user: "", method: "QUERY", outcome: "ok", status: "completed",
    sqlstate: null, message: null, detail: null, hint: null, rows: 20, durationMs: 12, endedAt: new Date(t0 + 12).toISOString(), bytesSent: 812,
    query: "SELECT id FROM public.orders LIMIT 20", queryTruncated: false }, "ended: started + its duration; the bytes the listener counted");
  assert.deepEqual(all[1], { requestId: "a2", startedAt: new Date(t0 + 1000).toISOString(), session: 4, applicationName: "", tokenName: "bi-tool", user: "", method: "EXECUTE", outcome: "refused", status: "failed",
    sqlstate: "42P01", message: 'relation "nope" does not exist', detail: "the detail", hint: "the hint", rows: null, durationMs: 3, endedAt: new Date(t0 + 1003).toISOString(),
    bytesSent: null, query: "SELECT * FROM nope", queryTruncated: false },
    "a client with no application_name is '', never the log's placeholder");
  assert.deepEqual([all[2]!.outcome, all[2]!.queryTruncated], ["failed", true]);
  assert.deepEqual((await ledger.recent({ limit: 10, failed: true })).map((r) => r.requestId), ["a2", "a3"], "--failed: the refused and failed ones");
  assert.deepEqual((await ledger.recent({ limit: 2 })).map((r) => r.requestId), ["a2", "a3"], "-n: the newest n, still newest last");
  // mason status's shapes (src/cli/run-server.ts SlowQuery, RefusedQuery): the ones it renders for either run
  ledger.record(row({ requestId: "s1", at: new Date(t0 + 3000), durationMs: 900, payload: "SELECT count(*) FROM public.orders" }));
  ledger.record(row({ requestId: "s2", at: new Date(t0 + 4000), durationMs: 2500, payload: "SELECT count(*) FROM public.orders" }));
  ledger.record(row({ requestId: "a4", at: new Date(t0 + 5000), status: 400, sqlstate: "42P01", error: 'relation "nope" does not exist', payload: "SELECT * FROM nope" }));
  await ledger.flush();
  assert.deepEqual(await ledger.slow(1000), [{ route: "postgres", payload: "SELECT count(*) FROM public.orders", runs: 2, medianMs: 900, maxMs: 2500, latestMs: 2500,
    last: new Date(t0 + 4000).toISOString() }], "a statement whose LATEST answer took a second or more");
  assert.deepEqual(await ledger.refused(), { total: 3, refused: [
    { route: "postgres", payload: "SELECT * FROM nope", runs: 2, last: new Date(t0 + 5000).toISOString(), code: "42P01", message: 'relation "nope" does not exist' },
    { route: "postgres", payload: "x".repeat(10), runs: 1, last: new Date(t0 + 2000).toISOString(), code: "XX000", message: "it broke\nsecond line" },
  ] }, "each statement once, newest first, and how many in all");
  assert.deepEqual(said, [], "nothing to say: nothing failed and nothing was old");
  await ledger.close();
  await store.writer.run(`DELETE FROM ${REQUESTS_TABLE}`);
});

test("two requests recorded in one millisecond read back in the order the listener saw them, across a reopen too: never the UUID's", async () => {
  // `started_at` is a millisecond and request_id a random UUID: 25 rows at one instant are in arrival order 1 time in
  // 25! by the UUID; the ledger numbers each row as it is recorded (seq) and reads by start time, then that number
  const said: string[] = [];
  let ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7 });
  const at = new Date(Date.now() - 30_000);
  const ids = Array.from({ length: 25 }, () => crypto.randomUUID());
  for (const id of ids) ledger.record(row({ requestId: id, at }));
  await ledger.flush();
  assert.deepEqual((await ledger.recent({ limit: 100 })).map((r) => r.requestId), ids, "arrival order within the millisecond");
  assert.deepEqual((await ledger.recent({ limit: 3 })).map((r) => r.requestId), ids.slice(-3), "the newest n are the last recorded");
  await ledger.close();
  // reopened (a restart): the numbering continues, so the rows a new process records at the same instant sort after
  ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7 });
  const more = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const id of more) ledger.record(row({ requestId: id, at }));
  await ledger.flush();
  assert.deepEqual((await ledger.recent({ limit: 100 })).map((r) => r.requestId), [...ids, ...more]);
  assert.deepEqual(said, []);
  await ledger.close();
  await store.writer.run(`DELETE FROM ${REQUESTS_TABLE}`);
});

test("the requests older than MASON_REQUEST_LOG_DAYS are deleted at open and said with their count; the rest are kept", async () => {
  const day = 86_400_000;
  const said: string[] = [];
  const first = await RequestLedger.open(store, (l) => said.push(l), { days: 30 });
  first.record(row({ requestId: "old", at: new Date(Date.now() - 8 * day) }));
  first.record(row({ requestId: "older", at: new Date(Date.now() - 20 * day) }));
  first.record(row({ requestId: "new", at: new Date(Date.now() - day) }));
  await first.close();
  const ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7 });
  assert.deepEqual((await ledger.recent({ limit: 10 })).map((r) => r.requestId), ["new"]);
  assert.deepEqual(said, ["request log: deleted 2 request(s) older than 7 days (MASON_REQUEST_LOG_DAYS)"]);
  assert.equal(await ledger.trim(), 0);
  assert.equal(said.length, 1, "a trim that deletes nothing says nothing");
  await ledger.close();
  await store.writer.run(`DELETE FROM ${REQUESTS_TABLE}`);
});

test("a write that fails is said once with the rows it cost, never thrown; the next that succeeds says so; nothing else waits on it", async () => {
  const said: string[] = [];
  let failing = true;
  const real = await store.instance.connect();
  const ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7, flushMs: 5,
    insert: async (sql, values) => { if (failing) throw new Error("disk full"); await real.run(sql, values); } });
  ledger.record(row({ requestId: "f1" }));
  ledger.record(row({ requestId: "f2" }));
  await ledger.flush();   // resolves: a failed write fails no statement
  ledger.record(row({ requestId: "f3" }));
  await ledger.flush();
  assert.deepEqual(said, ["request log: could not record 2 request(s) in _mason.requests (f1 … f2): disk full; said once until a write succeeds"], "once per streak");
  failing = false;
  ledger.record(row({ requestId: "f4" }));
  // on its own timer, as the listener leaves it
  await new Promise((r) => setTimeout(r, 50));
  await ledger.flush();
  assert.deepEqual(said.slice(1), ["request log: recording again; 3 request(s) were not recorded"]);
  assert.deepEqual((await ledger.recent({ limit: 10 })).map((r) => r.requestId), ["f4"]);
  await ledger.close();
  real.closeSync();
  await store.writer.run(`DELETE FROM ${REQUESTS_TABLE}`);
});

test("a failed write fails nothing beside it: a statement on another connection answers while the ledger cannot write", async () => {
  const said: string[] = [];
  const ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7, insert: () => Promise.reject(new Error("no space left on device")) });
  ledger.record(row({ requestId: "w1" }));
  const session = await store.instance.connect();
  try {
    const flushing = ledger.flush();
    const answer = (await session.runAndReadAll("SELECT 41 + 1 AS answer")).getRowsJS();
    await flushing;
    assert.deepEqual(answer, [[42]], "the statement's row came back");
    assert.match(said[0] ?? "", /could not record 1 request\(s\) in _mason\.requests \(w1\): no space left on device/);
  } finally { session.closeSync(); await ledger.close(); }
});

test("MASON_REQUEST_LOG_DAYS: a whole number of days, 1 or more; unset, 7; anything else refuses the start, saying how to write it", () => {
  assert.equal(DEFAULT_REQUEST_LOG_DAYS, 7);
  assert.equal(requestLogDays(undefined), 7);
  assert.equal(requestLogDays(""), 7);
  assert.equal(requestLogDays("30"), 30);
  for (const bad of ["0", "-1", "1.5", "a week"]) {
    assert.deepEqual(requestLogDays(bad), { problem: `MASON_REQUEST_LOG_DAYS=${JSON.stringify(bad)} is not a number of days: write a whole number, 1 or more (unset, 7)` }, bad);
  }
});

test("an outcome is the SQLSTATE's: cancelled for 57014, failed for Mason's or the machine's (XX, 53, 57, 58), refused for the statement's own", () => {
  assert.deepEqual([null, "42P01", "0A000", "22012", "XX000", "53200", "57014", "57P01", "58030"].map(outcomeOf),
    ["ok", "refused", "refused", "refused", "failed", "failed", "cancelled", "failed", "failed"]);
});

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const requestLog = await import("../src/api/request-log.ts") as Record<string, unknown>;

test("the ledger's filters read the outcome by the listener's own rule: outcomeSql is outcomeOf, code for code", async () => {
  const outcomeSql = requestLog.outcomeSql as ((column: string) => string) | undefined;
  assert.equal(typeof outcomeSql, "function", "the rule as SQL");
  const codes = [null, "", "42P01", "0A000", "22012", "XX000", "53200", "57014", "57P01", "58030", "28P01", "25P02"];
  const r = await store.writer.runAndReadAll(`SELECT ${outcomeSql!("c")} FROM (VALUES ${codes.map((c) => c === null ? "(NULL)" : `('${c}')`).join(", ")}) t(c)`);
  assert.deepEqual(r.getRowsJS().map((x) => x[0]), codes.map(outcomeOf));
});

test("the request log read by filters and in pages: outcome (cancelled among them), since / until, user, client; a page's before reads the one before it", async () => {
  const ledger = await RequestLedger.open(store, () => undefined, { days: 7 });

  const base = Date.now() - 3_600_000;
  const at = (s: number): Date => new Date(base + s * 1000);
  ledger.record(row({ requestId: "ok1", at: at(0), user: "metabase", client: "postgres:Metabase" }));
  ledger.record(row({ requestId: "cx1", at: at(1), user: "metabase", client: "postgres:Metabase", status: 400, sqlstate: "57014", error: "canceling statement due to user request" }));
  ledger.record(row({ requestId: "ref", at: at(2), user: "grafana", client: "postgres:Grafana", status: 400, sqlstate: "42P01", error: "no" }));
  ledger.record(row({ requestId: "bad", at: at(3), user: "metabase", client: "postgres:psql", status: 500, sqlstate: "XX000", error: "broke" }));
  // two in one millisecond: the page boundary between them is the seq's
  ledger.record(row({ requestId: "ok2", at: at(4), user: "metabase", client: "postgres:Metabase" }));
  ledger.record(row({ requestId: "ok3", at: at(4), user: "metabase", client: "postgres:Metabase" }));
  await ledger.flush();
  const ids = async (q: Parameters<RequestLedger["recent"]>[0]): Promise<string[]> => (await ledger.recent(q)).map((r) => r.requestId);
  assert.deepEqual(await ids({ limit: 10, outcomes: ["cancelled"] }), ["cx1"], "cancelled is its own outcome");
  assert.deepEqual((await ledger.recent({ limit: 10, outcomes: ["cancelled"] }))[0]!.status, "cancelled");
  assert.deepEqual(await ids({ limit: 10, outcomes: ["failed", "refused"] }), ["ref", "bad"]);
  assert.deepEqual(await ids({ limit: 10, failed: true }), ["cx1", "ref", "bad"], "--failed: every one not answered");
  assert.deepEqual(await ids({ limit: 10, since: at(1).toISOString(), until: at(3).toISOString() }), ["cx1", "ref"], "since inclusive, until exclusive");
  assert.deepEqual(await ids({ limit: 10, user: "grafana" }), ["ref"]);
  assert.deepEqual(await ids({ limit: 10, client: "Metabase" }), ["ok1", "cx1", "ok2", "ok3"], "the client is its application_name, as the ledger keeps it");
  assert.deepEqual(await ids({ limit: 10, user: "metabase", outcomes: ["ok"] }), ["ok1", "ok2", "ok3"], "filters combine");
  // pages of two, newest first page first, each newest last; the last has no before
  const p1 = await ledger.page({ limit: 2 });
  assert.deepEqual(p1.requests.map((r) => r.requestId), ["ok2", "ok3"]);
  assert.ok(p1.before !== null);
  const parseCursor = (await import("../src/duck/requests.ts") as Record<string, unknown>).parseRequestCursor as (t: string) => { at: string; seq: number };
  ledger.record(row({ requestId: "later", at: at(9) }));
  await ledger.flush();
  const p2 = await ledger.page({ limit: 2, before: parseCursor(p1.before!) });
  assert.deepEqual(p2.requests.map((r) => r.requestId), ["ref", "bad"], "the page before, whatever was recorded since");
  const p3 = await ledger.page({ limit: 2, before: parseCursor(p2.before!) });
  assert.deepEqual([p3.requests.map((r) => r.requestId), p3.before], [["ok1", "cx1"], null], "the oldest page says there is none before it");
  const filtered = await ledger.page({ limit: 1, user: "metabase", outcomes: ["ok"], before: parseCursor(p1.before!) });
  assert.deepEqual([filtered.requests.map((r) => r.requestId), filtered.before], [["ok1"], null], "a page keeps its filters");
  await ledger.close();
  await store.writer.run(`DELETE FROM ${REQUESTS_TABLE}`);
});

test("the query summary: the last day's and week's statements, each outcome, the completed ones' times, rows and bytes, in one read; a short log says so", async () => {
  const day = 86_400_000;
  const ledger = await RequestLedger.open(store, () => undefined, { days: 7 });
  const now = Date.now();
  for (const [i, ms] of [10, 20, 30, 40, 1000].entries()) ledger.record(row({ requestId: `d${i}`, at: new Date(now - 60_000), durationMs: ms, rows: 2, bytesSent: 100 }));
  ledger.record(row({ requestId: "dc", at: new Date(now - 60_000), status: 400, sqlstate: "57014", error: "canceling statement due to user request", durationMs: 5000, bytesSent: 50 }));
  ledger.record(row({ requestId: "dr", at: new Date(now - 60_000), status: 400, sqlstate: "42P01", error: "no", durationMs: 1 }));
  ledger.record(row({ requestId: "w1", at: new Date(now - 3 * day), durationMs: 50, rows: 7, bytesSent: 1000 }));
  ledger.record(row({ requestId: "wf", at: new Date(now - 3 * day), status: 500, sqlstate: "XX000", error: "broke" }));
  // a refused login is not a statement
  ledger.record(row({ requestId: "login", at: new Date(now - 60_000), method: "CONNECT", status: 401, sqlstate: "28P01", error: "password authentication failed" }));
  await ledger.flush();
  const s = await ledger.summary();
  assert.deepEqual(s.day, { days: 1, covered: 1, statements: 7, completed: 5, refused: 1, failed: 0, cancelled: 1, rows: 10, bytesSent: 550,
    durationMs: { avg: 220, p50: 30, p95: 808 } }, "the completed ones' times only: a cancel's 5 s and a refusal's 1 ms are not a query's time");
  assert.deepEqual(s.week, { days: 7, covered: 7, statements: 9, completed: 6, refused: 1, failed: 1, cancelled: 1, rows: 17, bytesSent: 1550,
    durationMs: { avg: 192, p50: 35, p95: 763 } });
  assert.equal(s.keptDays, 7);
  await ledger.close();
  const short = await RequestLedger.open(store, () => undefined, { days: 2 });
  const t = await short.summary();
  assert.deepEqual([t.keptDays, t.day.covered, t.week.covered], [2, 1, 2], "a log kept 2 days covers 2 of the week, said");
  assert.equal(t.week.statements, 7, "what is older than the log keeps is gone");
  await short.close();
  await store.writer.run(`DELETE FROM ${REQUESTS_TABLE}`);
});

test("a ledger made before the bytes were counted gains the column; its old rows' bytes are null, never 0", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mason-requests-old-"));
  const old = await DuckStore.open(path.join(d2, "duck.db"), () => undefined);
  try {
    await old.writer.run("CREATE SCHEMA IF NOT EXISTS _mason");
    await old.writer.run(`CREATE TABLE ${REQUESTS_TABLE} (request_id VARCHAR, started_at TIMESTAMPTZ, session INTEGER, application_name VARCHAR, token_name VARCHAR, user_name VARCHAR, ` +
      `method VARCHAR, sqlstate VARCHAR, message VARCHAR, detail VARCHAR, hint VARCHAR, "rows" BIGINT, duration_ms INTEGER, query VARCHAR, query_truncated BOOLEAN, seq BIGINT, json_reads VARCHAR)`);
    await old.writer.run(`INSERT INTO ${REQUESTS_TABLE} (request_id, started_at, method, duration_ms, query, query_truncated, seq) VALUES ('old', now(), 'QUERY', 3, 'SELECT 1', false, 0)`);
    const ledger = await RequestLedger.open(old, () => undefined, { days: 7 });
    ledger.record(row({ requestId: "new", bytesSent: 64 }));
    await ledger.flush();
    assert.deepEqual((await ledger.recent({ limit: 10 })).map((r) => [r.requestId, r.bytesSent]), [["old", null], ["new", 64]]);
    await ledger.close();
  } finally { await old.close(); fs.rmSync(d2, { recursive: true, force: true }); }
});
