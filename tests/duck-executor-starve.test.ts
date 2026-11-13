/**
 * THE EXECUTOR'S STARVATION STRESS (src/duck/executor.ts; tests/duck-executor.test.ts has the worker's story): a file of its
 * own so CI's unit shards can place it apart from the executor's other long tests (scripts/ci-shards.ts).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { CALLING, JWIDE_ROWS, ROWS, api, client, jwideBuild, logged, ping, released, store, timed, useServer } from "./duck-executor-harness.ts";

useServer({ wide: true, jwide: true });

/**
 * A HEAVY STATEMENT THAT ENDS WITH ITS TEST (issue 651): one left running past its test (the test's timeout fired, or
 * an assertion threw before its `await`) kept the engine's threads busy for minutes, and its loop of small statements
 * spinning, so on a loaded CI runner every file beside this one starved (a generated table took 15 s to build) and this
 * file's next test counted the last one's function calls as its own. So `heavy` sends `sql` on `c` and cancels it
 * (`api.cancel`, as `mason cancel` does, again every 100 ms until it ends, since a cancel that lands while it is planned
 * finds nothing running) at its own bound, short of the test's timeout, or when the test is cancelled (`t.signal`).
 * `end`, in the test's `finally`, cancels it and waits for its answer and then for a `SELECT 1` on its session, which
 * waits for the statement's release: no heavy statement outlives its test, pass or fail.
 */
function heavy(t: TestContext, c: pg.Client, sql: string, boundMs: number): { answer: Promise<pg.QueryResult | Error>; running: () => boolean; end: () => Promise<void> } {
  const session = (c as unknown as { processID: number }).processID;
  let running = true;
  let ticker: NodeJS.Timeout | undefined;
  const answer = c.query(sql).then((r) => r, (e: Error) => e).finally(() => { running = false; clearInterval(ticker); });
  const stop = (): void => {
    if (!running || ticker !== undefined) return;
    api.cancel(session);
    ticker = setInterval(() => { if (running) api.cancel(session); }, 100);
  };
  const bound = setTimeout(stop, boundMs);
  t.signal.addEventListener("abort", stop, { once: true });
  return {
    answer, running: () => running,
    end: async () => {
      clearTimeout(bound);
      t.signal.removeEventListener("abort", stop);
      stop();
      await answer;
      await c.query("SELECT 1");
    },
  };
}
/** the heavy statement's rows, or a failure naming why it has none (cancelled at its bound, or its own error) */
const rowsOf = (r: pg.QueryResult | Error, sql: string): pg.QueryResult["rows"] => {
  if (r instanceof Error) assert.fail(`${sql}: ${r.message}`);
  return r.rows;
};

test("a statement calling a Mason function on every row starves no one but its thread: another session, a new login and the command server answer within a second", { timeout: 120_000 }, async (t) => {
  const a = await client();
  const login = (): Promise<number> => (async () => { const c = await client(); try { return (await c.query("SELECT 1 AS one")).rows[0].one as number; } finally { await c.end(); } })();
  let slow: ReturnType<typeof heavy> | undefined;
  try {
    const idle = await timed(login);
    const from = logged.length;
    const t0 = Date.now();
    slow = heavy(t, a, CALLING, 90_000);
    await sleep(500);
    assert.ok(!released(from), "the calling statement is still running when the others ask (make ROWS larger if this machine is faster)");
    const other = await timed(login);
    const pinged = await timed(ping);
    t.diagnostic(`login + SELECT 1: ${Math.round(idle.ms)} ms idle, ${Math.round(other.ms)} ms during the calling statement; /api/ping ${Math.round(pinged.ms)} ms`);
    assert.ok(other.ms < 1000, `a new session's login and SELECT 1 took ${Math.round(other.ms)} ms during the calling statement`);
    assert.ok(pinged.ms < 1000, `the command server's /api/ping took ${Math.round(pinged.ms)} ms during the calling statement`);
    assert.equal(other.value, 1);
    assert.equal(pinged.value, 200);
    // a statement over a copied table is a request to the engine's thread: held by the test below, said here
    const copied = await timed(async () => { const c = await client(); try { return (await c.query("SELECT count(*) AS n FROM small")).rows[0].n as string; } finally { await c.end(); } });
    t.diagnostic(`a statement over a copied table: ${Math.round(copied.ms)} ms (the calling statement had run ${Date.now() - t0} ms when it was answered)`);
    assert.equal(copied.value, "10");
    assert.equal(String(rowsOf(await slow.answer, CALLING)[0].count), String(ROWS), "and the calling statement answers");
  } finally { try { await slow?.end(); } finally { await a.end(); } }
});

// A SMALL STATEMENT NEVER WAITS FOR A HEAVY ONE'S CALLS (issue 127, src/duck/functions.ts `registerTurn`): `select count(*)`
// on a small table rose from 0.6 s to 57 s. Held as a RATIO, never a time, so a slow machine slows both sides alike: a
// statement of about 2,400 vectors holds the executor's loop 1,000 calls at a time without the turn, so a small statement
// waits for at least 40 % of it; with the turn the loop turns every few calls, and the small statement's eight turns are
// about 3 %. A count alone would not do: small statements are answered before the calls reach their full rate.
for (const [shape, sql, rows] of [
  // (of a cast to numeric, as a JSON number is binned: a bin of a column of a bounded type is the engine's own arithmetic,
  // src/duck/rewrite.ts nativeBin, and calls nothing)
  ["a numeric bin", "SELECT floor(n::numeric / 0.05) * 0.05 AS bin, count(*) FROM wide GROUP BY 1", 1000],
  ["a week of the year, as a BI tool writes it", "SELECT ceil((extract(doy FROM ts)::integer + 6) / 7.0) AS week, count(*) FROM wide GROUP BY 1", 54],
  ["to_char", "SELECT to_char(ts, 'YYYY-MM') AS month, count(*) FROM wide GROUP BY 1", 24],
  // (an array in the template: the function's by construction, where a template of scalars is DuckDB's own SQL)
  ["jsonb @> of an array", "SELECT count(*) FROM wide WHERE j @> '{\"a\": [1]}'", 1],
] as const) {
  test(`small statements go on being answered beside ${shape}`, { timeout: 180_000 }, async (t) => {
    const a = await client(), b = await client();
    const t0 = Date.now();
    const q = heavy(t, a, sql, 150_000);
    try {
      let answered = 0, slowest = 0;
      while (q.running()) {
        const small = await timed(() => b.query("SELECT 1 FROM small LIMIT 1"));
        if (!q.running()) break;
        answered++;
        slowest = Math.max(slowest, small.ms);
      }
      const r = await q.answer;
      t.diagnostic(`${answered} small statements in the ${Date.now() - t0} ms of ${shape}, the slowest ${Math.round(slowest)} ms`);
      assert.equal(rowsOf(r, sql).length, rows, "and the heavy statement answers");
      assert.ok(answered >= 5, `${answered} small statements were answered in the ${Date.now() - t0} ms of ${shape}: it held the executor's loop`);
      assert.ok(slowest < (Date.now() - t0) * 0.2, `a small statement waited ${Math.round(slowest)} ms of the ${Date.now() - t0} ms of ${shape}: it held the executor's loop`);
    } finally { try { await q.end(); } finally { await a.end(); await b.end(); } }
  });
}

// NO HOP FOR A BI TOOL'S JSON FILTER OVER WIDE DOCUMENTS (issue 130, Tom's decision (c) on issue 127): each Mason
// function's vector is a hop to the executor's loop, and a loop turn runs one vector per calling DuckDB thread, so over
// 20 kB documents (~200 ms a vector) a small statement of another session waited 10.3 s median, 15.2 s at worst, beside
// `count(*) … WHERE j @> '{"a": 1}'` over 1 M rows (11.4 s / 12.5 s beside `(j -> 'a') IS NOT NULL`), against ~9 ms
// idle. No turn can bound that; only no call can: a template of scalars and a read's nullness are DuckDB's own SQL
// (src/duck/rewrite.ts nativeContains, jsonNullTest). Held two ways: DETERMINISTIC, no function at all (the turn
// counted too) across the statement; and an ABSOLUTE BOUND on the small statement beside it, looped on a second
// session (median 500 ms, worst 2 s). The loop is bounded: past the worst bound, or 30 s, it stops, and the heavy
// statement is ended by its own statement_timeout, so main fails in seconds, not after its whole run.
test("a small statement is not held by a native @> or -> over wide jsonb documents", { timeout: 240_000 }, async (t) => {
  t.diagnostic(`jwide: ${JWIDE_ROWS} rows of 20 kB documents built in ${Math.round(jwideBuild.ms)} ms`);
  const calls = async (): Promise<number> => [...(await store.functionCalls()).values()].reduce((x, y) => x + y, 0);
  const median = (xs: number[]): number => { const s = [...xs].sort((x, y) => x - y); return s.length === 0 ? Infinity : s[Math.floor((s.length - 1) / 2)]!; };
  for (const [sql, want] of [
    [`SELECT count(*) FROM jwide WHERE j @> '{"a": 1}'`, JWIDE_ROWS / 50],
    ["SELECT count(*) FROM jwide WHERE (j -> 'a') IS NOT NULL", JWIDE_ROWS],
    [`SELECT count(*) FROM jwide WHERE j @> '{"b": "v3"}'`, Math.floor((JWIDE_ROWS - 4) / 7) + 1],
  ] as const) {
    const a = await client(), b = await client();
    let q: ReturnType<typeof heavy> | undefined;
    try {
      await a.query("SET statement_timeout = 30000");
      const before = await calls();
      const t0 = Date.now();
      q = heavy(t, a, sql, 45_000);
      const waits: number[] = [];
      while (q.running()) {
        const small = await timed(() => b.query("SELECT 1 FROM small LIMIT 1"));
        if (!q.running() && waits.length > 0) break;
        waits.push(small.ms);
        if (small.ms > 2000 || Date.now() - t0 > 30_000) break;
      }
      const r = await q.answer;
      const count = r instanceof Error ? `failed: ${r.message}` : String(r.rows[0].count);
      const heavyMs = Date.now() - t0;
      const hops = (await calls()) - before;
      t.diagnostic(`${sql}: ${heavyMs} ms, ${hops} function calls; ${waits.length} small statements beside it, median ${Math.round(median(waits))} ms, worst ${Math.round(Math.max(...waits))} ms`);
      assert.equal(hops, 0, `${sql} reached a function ${hops} times (the turn's included)`);
      assert.equal(count, String(want), `${sql} answers`);
      assert.ok(waits.length >= 5, `${waits.length} small statements were answered beside ${sql} in ${heavyMs} ms`);
      assert.ok(median(waits) <= 500, `the small statement's median wait beside ${sql} was ${Math.round(median(waits))} ms`);
      assert.ok(Math.max(...waits) <= 2000, `a small statement waited ${Math.round(Math.max(...waits))} ms beside ${sql}`);
    } finally { try { await q?.end(); } finally { await a.end(); await b.end(); } }
  }
});
