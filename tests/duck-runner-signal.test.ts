/**
 * A STATEMENT'S SIGNAL, READ ONE WAY ON EVERY DUCKDB PATH (src/duck/store.ts `failureOf`): an abort whose reason is the
 * statement timeout (server.ts armTimeout) is that timeout, an abort without one is the client's cancel, and a signal
 * already aborted when DuckDB would start runs nothing. The Fable review of #517 found a plain EXPLAIN's interrupt
 * read as a user's cancel (its own catch, `pgErrorOf`); writing this test found the wider hole — a timeout that fired
 * between arming and DuckDB's start (the session's settle, the prepare) was never seen, and the statement ran unbounded.
 *
 * The statements are DuckDB's own text, cast past the planner: what is tested is the runner's handling of its signal,
 * which takes any statement alike (the planner is tests/duck-wire.test.ts's).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import { StatementError } from "../src/api/postgres/server.ts";
import { explainOptions } from "../src/api/postgres/explain.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-duck-signal-"));
const store = await DuckStore.open(path.join(dir, "signal.db"), () => undefined);
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const SESSION = { timeZone: "UTC", searchPath: "public" };
const SQL = { text: "SELECT 1 AS one", functions: [] } as never;   // see the header: the runner's signal handling, not the planner
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const HOW = (analyze: boolean) => ({ options: explainOptions(analyze ? [{ DefElem: { defname: "analyze" } }] : []), fields: null, exact: [], planning: { analysisMs: 0, rewriteMs: 0 } });

const aborted = (reason?: unknown): AbortSignal => { const c = new AbortController(); c.abort(reason); return c.signal; };
const is = (want: { code: string; message: string }) => (e: unknown): boolean =>
  e instanceof StatementError && e.fields.code === want.code && e.fields.message === want.message;

test("a statement whose timeout fired before DuckDB started is the timeout, on every path: run, EXPLAIN, EXPLAIN ANALYZE", async () => {
  const r = await store.runner();
  try {
    const timeout = (): AbortSignal => aborted(new StatementError(TIMEOUT, ""));
    await assert.rejects(r.run(SQL, [], SESSION, timeout()), is(TIMEOUT), "run");
    await assert.rejects(r.explain(SQL, [], SESSION, timeout(), HOW(false)), is(TIMEOUT), "EXPLAIN");
    await assert.rejects(r.explain(SQL, [], SESSION, timeout(), HOW(true)), is(TIMEOUT), "EXPLAIN ANALYZE");
    // the runner goes on: the next statement is answered
    assert.equal((await r.explain(SQL, [], SESSION, new AbortController().signal, HOW(false))).length > 0, true);
  } finally { r.close(); }
});

test("an abort with no reason of Mason's is the client's cancel, on every path", async () => {
  const r = await store.runner();
  const cancel = { code: "57014", message: "canceling statement due to user request" };
  try {
    await assert.rejects(r.run(SQL, [], SESSION, aborted()), is(cancel), "run");
    await assert.rejects(r.explain(SQL, [], SESSION, aborted(), HOW(false)), is(cancel), "EXPLAIN");
    await assert.rejects(r.explain(SQL, [], SESSION, aborted(), HOW(true)), is(cancel), "EXPLAIN ANALYZE");
  } finally { r.close(); }
});
