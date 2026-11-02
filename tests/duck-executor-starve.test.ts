/**
 * THE EXECUTOR'S STARVATION STRESS (src/duck/executor.ts; tests/duck-executor.test.ts has the worker's story): a file of its
 * own so CI's unit shards can place it apart from the executor's other long tests (scripts/ci-shards.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { CALLING, JWIDE_ROWS, ROWS, client, jwideBuild, logged, ping, released, store, timed, useServer } from "./duck-executor-harness.ts";

useServer({ wide: true, jwide: true });

test("a statement calling a Mason function on every row starves no one but its thread: another session, a new login and the command server answer within a second", { timeout: 120_000 }, async (t) => {
  const a = await client();
  const login = (): Promise<number> => (async () => { const c = await client(); try { return (await c.query("SELECT 1 AS one")).rows[0].one as number; } finally { await c.end(); } })();
  try {
    const idle = await timed(login);
    const from = logged.length;
    const t0 = Date.now();
    const slow = a.query(CALLING);
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
    assert.equal(String((await slow).rows[0].count), String(ROWS), "and the calling statement answers");
  } finally { await a.end(); }
});

// A SMALL STATEMENT NEVER WAITS FOR A HEAVY ONE'S CALLS (issue 127, src/duck/functions.ts `registerTurn`): `select count(*)`
// on a small table rose from 0.6 s to 57 s. Held as a RATIO, never a time, so a slow machine slows both sides alike: a
// statement of about 2,400 vectors holds the executor's loop 1,000 calls at a time without the turn, so a small statement
// waits for at least 40 % of it; with the turn the loop turns every few calls, and the small statement's eight turns are
// about 3 %. A count alone would not do: small statements are answered before the calls reach their full rate.
for (const [shape, heavy, rows] of [
  ["a numeric bin", "SELECT floor(n / 0.05) * 0.05 AS bin, count(*) FROM wide GROUP BY 1", 1000],
  ["a week of the year, as a BI tool writes it", "SELECT ceil((extract(doy FROM ts)::integer + 6) / 7.0) AS week, count(*) FROM wide GROUP BY 1", 54],
  ["to_char", "SELECT to_char(ts, 'YYYY-MM') AS month, count(*) FROM wide GROUP BY 1", 24],
  // (an array in the template: the function's by construction, where a template of scalars is DuckDB's own SQL)
  ["jsonb @> of an array", "SELECT count(*) FROM wide WHERE j @> '{\"a\": [1]}'", 1],
] as const) {
  test(`small statements go on being answered beside ${shape}`, { timeout: 180_000 }, async (t) => {
    const a = await client(), b = await client();
    try {
      let running = true;
      const t0 = Date.now();
      const q = a.query(heavy).finally(() => { running = false; });
      let answered = 0, slowest = 0;
      while (running) {
        const small = await timed(() => b.query("SELECT 1 FROM small LIMIT 1"));
        if (!running) break;
        answered++;
        slowest = Math.max(slowest, small.ms);
      }
      const r = await q;
      t.diagnostic(`${answered} small statements in the ${Date.now() - t0} ms of ${shape}, the slowest ${Math.round(slowest)} ms`);
      assert.equal(r.rows.length, rows, "and the heavy statement answers");
      assert.ok(answered >= 5, `${answered} small statements were answered in the ${Date.now() - t0} ms of ${shape}: it held the executor's loop`);
      assert.ok(slowest < (Date.now() - t0) * 0.2, `a small statement waited ${Math.round(slowest)} ms of the ${Date.now() - t0} ms of ${shape}: it held the executor's loop`);
    } finally { await a.end(); await b.end(); }
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
  for (const [heavy, want] of [
    [`SELECT count(*) FROM jwide WHERE j @> '{"a": 1}'`, JWIDE_ROWS / 50],
    ["SELECT count(*) FROM jwide WHERE (j -> 'a') IS NOT NULL", JWIDE_ROWS],
    [`SELECT count(*) FROM jwide WHERE j @> '{"b": "v3"}'`, Math.floor((JWIDE_ROWS - 4) / 7) + 1],
  ] as const) {
    const a = await client(), b = await client();
    try {
      await a.query("SET statement_timeout = 30000");
      const before = await calls();
      let running = true;
      const t0 = Date.now();
      const q = a.query(heavy).then((r) => String(r.rows[0].count), (e: Error) => `failed: ${e.message}`).finally(() => { running = false; });
      const waits: number[] = [];
      while (running) {
        const small = await timed(() => b.query("SELECT 1 FROM small LIMIT 1"));
        if (!running && waits.length > 0) break;
        waits.push(small.ms);
        if (small.ms > 2000 || Date.now() - t0 > 30_000) break;
      }
      const count = await q;
      const heavyMs = Date.now() - t0;
      const hops = (await calls()) - before;
      t.diagnostic(`${heavy}: ${heavyMs} ms, ${hops} function calls; ${waits.length} small statements beside it, median ${Math.round(median(waits))} ms, worst ${Math.round(Math.max(...waits))} ms`);
      assert.equal(hops, 0, `${heavy} reached a function ${hops} times (the turn's included)`);
      assert.equal(count, String(want), `${heavy} answers`);
      assert.ok(waits.length >= 5, `${waits.length} small statements were answered beside ${heavy} in ${heavyMs} ms`);
      assert.ok(median(waits) <= 500, `the small statement's median wait beside ${heavy} was ${Math.round(median(waits))} ms`);
      assert.ok(Math.max(...waits) <= 2000, `a small statement waited ${Math.round(Math.max(...waits))} ms beside ${heavy}`);
    } finally { await a.end(); await b.end(); }
  }
});
