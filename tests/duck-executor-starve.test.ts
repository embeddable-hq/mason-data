/**
 * THE EXECUTOR'S STARVATION STRESS (src/duck/executor.ts; tests/duck-executor.test.ts has the worker's story): a file of its
 * own so CI's unit shards can place it apart from the executor's other long tests (scripts/ci-shards.ts).
 *
 * WHAT THESE TESTS TIME BY (issue 984): never the wall clock against a fixed bound or a fraction of the heavy statement's
 * time. A slow or loaded runner slowed one side and not the other: a small statement once waited 192 ms of a 451 ms
 * statement, and a statement of 6 M rows ran past its test's limit. A test that holds a FUNCTION-CALLING statement times
 * the small ones in that statement's own vectors (`vectorClock`): how many vectors of Mason functions the executor ran
 * while a small statement waited. A load slows the calls and the small statements alike, so the count stays put. Without
 * the turn (src/duck/functions.ts `registerTurn`) the executor's loop runs 1,000 calls before it turns, and a small
 * statement needs about eight turns, so it waits thousands of vectors. With the turn it waits tens. And no heavy
 * statement runs to its end for the test's sake: each is cancelled once its test has seen enough of its vectors.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { TURN_FUNCTION } from "../src/duck/functions.ts";
import { CALLING, JWIDE_ROWS, api, client, jwideBuild, ping, store, timed, useServer } from "./duck-executor-harness.ts";

useServer({ wide: true, jwide: true });

/**
 * A HEAVY STATEMENT THAT ENDS WITH ITS TEST (issue 651): one left running past its test (the test's timeout fired, or
 * an assertion threw before its `await`) kept the engine's threads busy for minutes, and its loop of small statements
 * spinning, so on a loaded CI runner every file beside this one starved (a generated table took 15 s to build) and this
 * file's next test counted the last one's function calls as its own. So `heavy` sends `sql` on `c` and cancels it
 * (`api.cancel`, as `mason cancel` does, again every 100 ms until it ends, since a cancel that lands while it is planned
 * finds nothing running) at its own bound, short of the test's timeout, or when the test is cancelled (`t.signal`), or
 * when the test has seen enough (`stop`). `end`, in the test's `finally`, cancels it and waits for its answer and then
 * for a `SELECT 1` on its session, which waits for the statement's release: no heavy statement outlives its test, pass
 * or fail. `stopped` says whether it was cancelled (by the test or its bound) before it answered.
 */
function heavy(t: TestContext, c: pg.Client, sql: string, boundMs: number): { answer: Promise<pg.QueryResult | Error>; running: () => boolean; stopped: () => boolean; stop: () => void; end: () => Promise<void> } {
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
    answer, running: () => running, stopped: () => ticker !== undefined, stop,
    end: async () => {
      clearTimeout(bound);
      t.signal.removeEventListener("abort", stop);
      stop();
      await answer;
      await c.query("SELECT 1");
    },
  };
}

/** the vectors of Mason functions the executor has run so far, the turn's own left out (src/duck/functions.ts
 *  FUNCTION_CALLS counts a call per vector): the clock of a function-calling statement */
const vectorsSoFar = async (): Promise<number> => {
  let n = 0;
  for (const [name, calls] of await store.functionCalls()) if (name !== TURN_FUNCTION) n += calls;
  return n;
};
/**
 * THE HEAVY STATEMENT'S OWN CLOCK: `vectorClock` waits until `q` runs Mason functions (its first vector counted), and
 * `timed(f)` then times `f` in vectors: how many the executor ran from the end of the last reading to the end of this
 * one, `f`'s wait and the reading's own included. `ran` is every vector since the first.
 */
async function vectorClock(q: ReturnType<typeof heavy>, what: string): Promise<{ timed: <T>(f: () => Promise<T>) => Promise<{ ms: number; vectors: number; value: T }>; ran: () => number }> {
  const zero = await vectorsSoFar();
  let last = zero;
  while (q.running() && last === zero) { await sleep(10); last = await vectorsSoFar(); }
  if (last === zero) { const r = await q.answer; assert.fail(`${what} ended before it called a Mason function: ${r instanceof Error ? r.message : `${r.rowCount} row(s)`}`); }
  const first = last;
  return {
    timed: async (f) => {
      const r = await timed(f);
      const now = await vectorsSoFar();
      const vectors = now - last;
      last = now;
      return { ms: r.ms, vectors, value: r.value };
    },
    ran: () => last - first,
  };
}
const median = (xs: readonly number[]): number => { const s = [...xs].sort((x, y) => x - y); return s.length === 0 ? Infinity : s[Math.floor((s.length - 1) / 2)]!; };
/** a heavy statement's answer: its rows where it ran to its end, else null, and never a failure but its cancel */
const endedWell = async (q: ReturnType<typeof heavy>, sql: string): Promise<pg.QueryResult["rows"] | null> => {
  const r = await q.answer;
  if (r instanceof Error) {
    assert.ok(q.stopped() && /cancel/i.test(r.message), `${sql}: ${r.message}`);
    return null;
  }
  return r.rows;
};
/**
 * The most vectors a small request may wait for, as a median. With the turn the executor's loop turns after one call
 * per DuckDB thread: a small statement on an open session waited 25 to 40 vectors here, and a new session's statement,
 * with its open and close, 70 to 90. Without the turn the loop runs whole queues of 1,000 calls between two turns, and a
 * small statement waits thousands of vectors (as does a request of the main thread, wherever a call holds that).
 */
const MOST_VECTORS = 300;
/** how many small statements are timed beside a heavy statement that calls nothing, and with nothing running */
const SAMPLES = 40;
/** a small statement's median time on `b` with nothing else running: the baseline of the same session on the same
 *  machine under the same load, measured just before the heavy statement */
const idleMedian = async (b: pg.Client): Promise<number> => {
  const idle: number[] = [];
  for (let i = 0; i < SAMPLES; i++) idle.push((await timed(() => b.query("SELECT 1 FROM small LIMIT 1"))).ms);
  return median(idle);
};
/** small statements on `b` beside `q`, timed, until `SAMPLES` of them or `q`'s end */
const smallsBeside = async (q: ReturnType<typeof heavy>, b: pg.Client): Promise<number[]> => {
  const waits: number[] = [];
  while (q.running() && waits.length < SAMPLES) {
    const small = await timed(() => b.query("SELECT 1 FROM small LIMIT 1"));
    if (!q.running() && waits.length > 0) break;
    waits.push(small.ms);
  }
  return waits;
};
/**
 * The most a small statement may wait, as a median, beside a heavy statement that calls nothing, against its median
 * idle: the engine's own work beside it was 3 to 6 times idle here, loaded or not. A Mason function per vector, even
 * with the turn, is about 75 times idle (300 ms against 4), and over 20 kB documents a thousand times. The floor keeps a
 * fast machine's idle of a millisecond from making the bound smaller than a scheduler's slice.
 */
const mostBeside = (idleMs: number): number => Math.max(25 * idleMs, 100);
/**
 * THE EXECUTOR'S LOOP ITSELF, beside a heavy statement that calls nothing: a request that touches no engine (the
 * function counts, `store.functionCalls`) is answered by the worker's loop alone, so its time is how long that loop was
 * held, never DuckDB's work beside it. Asked again and again, side by side with the small statements, so a single hold
 * meets a request in flight (a hold as a statement starts met none of the small statements' own waits). Its median idle
 * is a millisecond or less; beside the engine's own work, loaded or not, its worst was WORST_LOOP_SEEN here. A small
 * statement's own worst is no bound: the engine's work beside it once held one 889 ms against 3 ms idle.
 */
const loopIdle = async (): Promise<number> => {
  const idle: number[] = [];
  for (let i = 0; i < SAMPLES; i++) idle.push((await timed(() => store.functionCalls())).ms);
  return median(idle);
};
const loopBeside = async (q: ReturnType<typeof heavy>, done: () => boolean): Promise<number[]> => {
  const waits: number[] = [];
  // (5 ms apart: a hold of the loop longer than that still meets a request in flight)
  while (q.running() && !done()) { waits.push((await timed(() => store.functionCalls())).ms); await sleep(5); }
  return waits;
};
/** small statements beside `q` (`smallsBeside`) and the executor's loop beside them (`loopBeside`), until the first end */
const besideNative = async (q: ReturnType<typeof heavy>, b: pg.Client): Promise<{ waits: number[]; loop: number[] }> => {
  let done = false;
  const [waits, loop] = await Promise.all([smallsBeside(q, b).finally(() => { done = true; }), loopBeside(q, () => done)]);
  return { waits, loop };
};
/** The most the executor's loop may be held once beside a heavy statement that calls nothing, against its median idle:
 *  looser than a median's bound, since a scheduler under load parks a thread now and then. */
const mostHeld = (idleMs: number): number => Math.max(50 * idleMs, 250);
/** the rounds of a login, a ping and a new session's statement asked beside the calling statement */
const ROUNDS = 5;

test("a statement calling a Mason function on every row starves no one but its thread: another session, a new login and the command server answer within a few of its vectors", { timeout: 120_000 }, async (t) => {
  const a = await client(), b = await client();
  const login = (): Promise<number> => (async () => { const c = await client(); try { return (await c.query("SELECT 1 AS one")).rows[0].one as number; } finally { await c.end(); } })();
  // a statement over a copied table is a request to the engine's thread
  const copied = (): Promise<string> => (async () => { const c = await client(); try { return (await c.query("SELECT count(*) AS n FROM small")).rows[0].n as string; } finally { await c.end(); } })();
  // A LOGIN AND THE COMMAND SERVER ARE THE MAIN THREAD'S, and never wait for the worker, so the calling statement's
  // vectors are the wrong clock for them (most of what they would count is the clock's own reading, a request to the
  // worker). They are timed in ms against a small statement's median idle on an open session, measured just before
  // on the same machine and load (`mostBeside`): the main thread held 1.5 s on each ping is caught, as main's fixed
  // second caught it, and a slow runner slows both sides.
  const idle = await idleMedian(b);
  const slow = heavy(t, a, CALLING, 90_000);
  try {
    const clock = await vectorClock(slow, CALLING);
    const logins: number[] = [], pings: number[] = [], copies: number[] = [];
    // only rounds answered wholly beside the calling statement are judged: a wait it ended is no wait beside it (the
    // round it ended is still said)
    let beside = 0;
    while (slow.running() && beside < ROUNDS) {
      const l = await clock.timed(login);
      const p = await clock.timed(ping);
      const s = await clock.timed(copied);
      assert.equal(l.value, 1);
      assert.equal(p.value, 200);
      assert.equal(s.value, "10");
      logins.push(Math.round(l.ms)); pings.push(Math.round(p.ms)); copies.push(s.vectors);
      if (slow.running()) beside++;
    }
    const said = `a login + SELECT 1 ${logins.join(", ")} ms; /api/ping ${pings.join(", ")} ms; a statement over a copied table ${copies.join(", ")} vectors; against ${Math.round(idle)} ms idle`;
    t.diagnostic(`beside the calling statement: ${said}`);
    // the rounds take seconds and the statement tens of them (6 M rows): only rounds held behind it see it end first
    assert.equal(beside, ROUNDS, `${beside} of ${ROUNDS} rounds were answered in the ${clock.ran()} vectors of the calling statement (${said}): they waited for it to end`);
    assert.ok(median(logins) <= mostBeside(idle), `a new session's login and SELECT 1 took ${logins.join(", ")} ms during the calling statement, against ${Math.round(idle)} ms idle`);
    assert.ok(median(pings) <= mostBeside(idle), `the command server's /api/ping took ${pings.join(", ")} ms during the calling statement, against ${Math.round(idle)} ms idle`);
    assert.ok(median(copies) <= MOST_VECTORS, `a statement over a copied table waited for ${copies.join(", ")} vectors of the calling statement`);
    slow.stop();
    await endedWell(slow, CALLING);
  } finally { try { await slow.end(); } finally { await a.end(); await b.end(); } }
});

// A SMALL STATEMENT NEVER WAITS FOR A HEAVY ONE'S CALLS (issue 127, src/duck/functions.ts `registerTurn`): `select count(*)`
// on a small table rose from 0.6 s to 57 s, beside a `to_char`. A shape that CALLS a Mason function on every vector is
// timed in its own vectors (above): `VECTORS` of them, about a third of a statement over `wide`, hold fewer than one small
// statement without the turn, and dozens with it. A shape the engine computes itself (`calls: false`: `to_char` and the
// week's arithmetic are DuckDB's own today, with a call or two per group at most) is held as the jsonb test below holds
// one: the small statement's median wait beside it against its own median idle (`mostBeside`). Each shape says which it
// is, and is held to it: a shape that stopped calling would time nothing in vectors, and one that started calling would
// be timed by the wrong clock. The heavy statement is cancelled once the test has seen enough; where it ends before, its
// rows are checked.
const VECTORS = 800;
/** the most vectors a shape the engine computes itself may call in all: a call per group, never one per vector */
const FEW_VECTORS = 100;
for (const [shape, sql, rows, calls] of [
  // (of a cast to numeric, as a JSON number is binned: a bin of a column of a bounded type is the engine's own arithmetic,
  // src/duck/rewrite.ts nativeBin, and calls nothing)
  ["a numeric bin", "SELECT floor(n::numeric / 0.05) * 0.05 AS bin, count(*) FROM wide GROUP BY 1", 1000, true],
  ["a week of the year, as a BI tool writes it", "SELECT ceil((extract(doy FROM ts)::integer + 6) / 7.0) AS week, count(*) FROM wide GROUP BY 1", 54, false],
  ["to_char", "SELECT to_char(ts, 'YYYY-MM') AS month, count(*) FROM wide GROUP BY 1", 24, false],
  // (an array in the template: the function's by construction, where a template of scalars is DuckDB's own SQL)
  ["jsonb @> of an array", "SELECT count(*) FROM wide WHERE j @> '{\"a\": [1]}'", 1, true],
] as const) {
  test(`small statements go on being answered beside ${shape}`, { timeout: 180_000 }, async (t) => {
    const a = await client(), b = await client();
    let q: ReturnType<typeof heavy> | undefined;
    try {
      if (calls) {
        q = heavy(t, a, sql, 150_000);
        const clock = await vectorClock(q, sql);
        const waits: number[] = [], ms: number[] = [];
        while (q.running() && clock.ran() < VECTORS) {
          const small = await clock.timed(() => b.query("SELECT 1 FROM small LIMIT 1"));
          if (!q.running()) break;
          waits.push(small.vectors);
          ms.push(small.ms);
        }
        const ran = clock.ran();
        q.stop();
        const r = await endedWell(q, sql);
        t.diagnostic(`${waits.length} small statements in ${ran} vectors of ${shape}${r === null ? " (then cancelled)" : " (all of it)"}: a median wait of ${median(waits)} vectors, the most ${Math.max(...waits)}; ${Math.round(median(ms))} ms median, ${Math.round(Math.max(...ms))} ms the slowest`);
        if (r !== null) assert.equal(r.length, rows, "and the heavy statement answers");
        assert.ok(waits.length >= 5, `${waits.length} small statements were answered in ${ran} vectors of ${shape}: it held the executor's loop`);
        assert.ok(median(waits) <= MOST_VECTORS, `a small statement waited for a median of ${median(waits)} vectors of ${shape}: it held the executor's loop`);
      } else {
        const idle = await idleMedian(b), held = await loopIdle();
        const before = await vectorsSoFar();
        q = heavy(t, a, sql, 150_000);
        const { waits, loop } = await besideNative(q, b);
        q.stop();
        const r = await endedWell(q, sql);
        const ran = (await vectorsSoFar()) - before;
        t.diagnostic(`${waits.length} small statements beside ${shape}${r === null ? " (then cancelled)" : " (all of it)"}, ${ran} vectors of Mason functions: median ${Math.round(median(waits))} ms, worst ${Math.round(Math.max(...waits))} ms, against ${Math.round(idle)} ms idle; the executor's loop ${loop.length} times, worst ${Math.round(Math.max(...loop))} ms, against ${held.toFixed(1)} ms idle`);
        assert.ok(ran <= FEW_VECTORS, `${shape} called Mason functions for ${ran} vectors: it calls one per vector now, so give it \`calls: true\``);
        if (r !== null) assert.equal(r.length, rows, "and the heavy statement answers");
        assert.ok(waits.length >= 5, `${waits.length} small statements were answered beside ${shape}`);
        assert.ok(median(waits) <= mostBeside(idle), `the small statement's median wait beside ${shape} was ${Math.round(median(waits))} ms, against ${Math.round(idle)} ms idle`);
        assert.ok(Math.max(...loop) <= mostHeld(held), `the executor's loop was held ${Math.round(Math.max(...loop))} ms beside ${shape}, against ${held.toFixed(1)} ms idle`);
      }
    } finally { try { await q?.end(); } finally { await a.end(); await b.end(); } }
  });
}

// NO HOP FOR A BI TOOL'S JSON FILTER OVER WIDE DOCUMENTS (issue 130, Tom's decision (c) on issue 127): each Mason
// function's vector is a hop to the executor's loop, and a loop turn runs one vector per calling DuckDB thread, so over
// 20 kB documents (~200 ms a vector) a small statement of another session waited 10.3 s median, 15.2 s at worst, beside
// `count(*) … WHERE j @> '{"a": 1}'` over 1 M rows (11.4 s / 12.5 s beside `(j -> 'a') IS NOT NULL`), against ~9 ms
// idle. No turn can bound that; only no call can: a template of scalars and a read's nullness are DuckDB's own SQL
// (src/duck/rewrite.ts nativeContains, jsonNullTest). Held two ways: DETERMINISTIC, no function at all (the turn
// counted too) across the statement; and the small statement's median wait beside it against its own median idle
// (`mostBeside`). No vector clock here, since nothing calls: the samples stop at `SAMPLES` or the statement's end, and
// the heavy statement is cancelled then, so a slow runner cuts short nothing the test needs.
test("a small statement is not held by a native @> or -> over wide jsonb documents", { timeout: 240_000 }, async (t) => {
  t.diagnostic(`jwide: ${JWIDE_ROWS} rows of 20 kB documents built in ${Math.round(jwideBuild.ms)} ms`);
  const calls = async (): Promise<number> => [...(await store.functionCalls()).values()].reduce((x, y) => x + y, 0);
  for (const [sql, want] of [
    [`SELECT count(*) FROM jwide WHERE j @> '{"a": 1}'`, JWIDE_ROWS / 50],
    ["SELECT count(*) FROM jwide WHERE (j -> 'a') IS NOT NULL", JWIDE_ROWS],
    [`SELECT count(*) FROM jwide WHERE j @> '{"b": "v3"}'`, Math.floor((JWIDE_ROWS - 4) / 7) + 1],
  ] as const) {
    const a = await client(), b = await client();
    let q: ReturnType<typeof heavy> | undefined;
    try {
      const idle = await idleMedian(b), held = await loopIdle();
      const before = await calls();
      const t0 = Date.now();
      q = heavy(t, a, sql, 60_000);
      const { waits, loop } = await besideNative(q, b);
      q.stop();
      const r = await endedWell(q, sql);
      const heavyMs = Date.now() - t0;
      const hops = (await calls()) - before;
      t.diagnostic(`${sql}: ${heavyMs} ms${r === null ? " (then cancelled)" : " (all of it)"}, ${hops} function calls; ${waits.length} small statements beside it, median ${Math.round(median(waits))} ms, worst ${Math.round(Math.max(...waits))} ms, against ${Math.round(idle)} ms idle; the executor's loop ${loop.length} times, worst ${Math.round(Math.max(...loop))} ms, against ${held.toFixed(1)} ms idle`);
      assert.equal(hops, 0, `${sql} reached a function ${hops} times (the turn's included)`);
      if (r !== null) assert.equal(String(r[0].count), String(want), `${sql} answers`);
      assert.ok(waits.length >= 5, `${waits.length} small statements were answered beside ${sql} in ${heavyMs} ms`);
      assert.ok(median(waits) <= mostBeside(idle), `the small statement's median wait beside ${sql} was ${Math.round(median(waits))} ms, against ${Math.round(idle)} ms idle`);
      assert.ok(Math.max(...loop) <= mostHeld(held), `the executor's loop was held ${Math.round(Math.max(...loop))} ms beside ${sql}, against ${held.toFixed(1)} ms idle`);
    } finally { try { await q?.end(); } finally { await a.end(); await b.end(); } }
  }
});
