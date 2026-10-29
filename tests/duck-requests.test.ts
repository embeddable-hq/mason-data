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
  ledger.record(row({ requestId: "a1", at: new Date(t0), session: 4, rows: 20, payload: "SELECT id FROM public.orders LIMIT 20" }));
  ledger.record(row({ requestId: "a2", at: new Date(t0 + 1000), session: 4, method: "EXECUTE", status: 400, sqlstate: "42P01", error: 'relation "nope" does not exist',
    detail: "the detail", hint: "the hint", durationMs: 3, payload: "SELECT * FROM nope", client: "postgres:unnamed", tokenName: "bi-tool" }));
  ledger.record(row({ requestId: "a3", at: new Date(t0 + 2000), status: 500, sqlstate: "XX000", error: "it broke\nsecond line", payload: "x".repeat(10), payloadTruncated: true }));
  assert.deepEqual(await ledger.recent({ limit: 10 }), [], "nothing is read before its batch commits");
  await ledger.flush();
  const all = await ledger.recent({ limit: 10 });
  assert.deepEqual(all.map((r) => r.requestId), ["a1", "a2", "a3"], "newest last");
  assert.deepEqual(all[0], { requestId: "a1", startedAt: new Date(t0).toISOString(), session: 4, applicationName: "Metabase", tokenName: "", user: "", role: "", method: "QUERY", outcome: "ok",
    sqlstate: null, message: null, detail: null, hint: null, rows: 20, durationMs: 12, query: "SELECT id FROM public.orders LIMIT 20", queryTruncated: false });
  assert.deepEqual(all[1], { requestId: "a2", startedAt: new Date(t0 + 1000).toISOString(), session: 4, applicationName: "", tokenName: "bi-tool", user: "", role: "", method: "EXECUTE", outcome: "refused",
    sqlstate: "42P01", message: 'relation "nope" does not exist', detail: "the detail", hint: "the hint", rows: null, durationMs: 3, query: "SELECT * FROM nope", queryTruncated: false },
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

test("an outcome is the SQLSTATE's: failed for Mason's or the machine's (XX, 53, 57, 58), refused for the statement's own", () => {
  assert.deepEqual([null, "42P01", "0A000", "22012", "XX000", "53200", "57014", "58030"].map(outcomeOf),
    ["ok", "refused", "refused", "refused", "failed", "failed", "failed", "failed"]);
});
