/**
 * WHEN EACH TABLE IS POLLED (src/duck/sync.ts `nextPollAt`, `passDelayMs`; GitHub issue 33): a table's next poll is its
 * own `sync: poll <interval>` after its last, stretched to four times that poll's time; the next pass waits for the first
 * table due, and at least four times the last pass — so the polls never take more than a fifth of the source's time,
 * per table and all together, whatever the intervals say.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as syncModule from "../src/duck/sync.ts";

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { nextPollAt, passDelayMs } = syncModule as unknown as {
  nextPollAt: (endedMs: number, intervalSeconds: number, pollMs: number) => number;
  passDelayMs: (earliestDueMs: number, nowMs: number, lastPassMs: number) => number;
};

test("a table's next poll is its own interval after its last, stretched to four times that poll's time", () => {
  assert.equal(nextPollAt(1_000_000, 30, 50), 1_030_000, "a quick poll: its interval");
  assert.equal(nextPollAt(1_000_000, 5, 20_000), 1_080_000, "a 20 s poll of a table set to poll 5s waits 80 s: a fifth of the source's time");
  assert.equal(nextPollAt(1_000_000, 3600, 15_000), 4_600_000, "an hour asked for is an hour");
  assert.equal(nextPollAt(0, 2, 600), 2_400, "poll 2s and a 0.6 s poll: 2.4 s");
});

test("the next pass waits for the first table due, at least four times the last pass, never below zero or past setTimeout's limit", () => {
  assert.equal(passDelayMs(10_000, 4_000, 100), 6_000, "the first table due in 6 s");
  assert.equal(passDelayMs(5_000, 4_000, 2_000), 8_000, "two seconds of polls in the last pass: eight seconds before the next");
  assert.equal(passDelayMs(1_000, 4_000, 0), 0, "a table overdue (its sync just changed): at once");
  assert.equal(passDelayMs(Number.MAX_SAFE_INTEGER, 0, 0), 2 ** 31 - 1, "a poll weeks away is waited for in steps");
});

// WHAT A TABLE'S `sync:` PROMISES (src/duck/sync.ts `keptPromise`, issue 106): the age past which it is behind, and why
// it would be late now — read from the module, so the file loads at a commit without it and fails by name
type Promised = { promisedSeconds: number | null; lateWhy: string | null };
const keptPromise = (o: Record<string, unknown>): Promised => {
  const f = (syncModule as unknown as { keptPromise?: (o: Record<string, unknown>) => Promised }).keptPromise;
  return f === undefined ? assert.fail("src/duck/sync.ts exports keptPromise") : f(o);
};
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const MIN = 60_000;
const polled = (o: Record<string, unknown>): Promised => keptPromise({ mode: "poll", intervalSeconds: 900, lastPollMs: 2_000, lastPassMs: 2_000, pending: null, notRunning: null,
  passFailed: false, dueMs: NOW + 5 * MIN, now: NOW, ...o });

test("the promise of sync: poll 15m behind a pass of 13 min: its interval plus the 60 s floor, late because Mason waits four times the pass", () => {
  const p = polled({ lastPassMs: 13 * MIN });
  assert.equal(p.promisedSeconds, 960, "900 + max(60, 2 × 2 s)");
  assert.equal(p.lateWhy, "every polled table's polls took 13 min in the last pass, and Mason waits four times that between passes to keep the database's load to a fifth");
});

test("the promise of a table whose own poll took 6 min: its interval plus twice its poll, late because Mason stretches it to four times its poll", () => {
  const p = polled({ lastPollMs: 6 * MIN, lastPassMs: 0 });
  assert.equal(p.promisedSeconds, 1620, "900 + max(60, 720)");
  assert.equal(p.lateWhy, "its own poll took 6 min, and Mason waits four times a table's poll before its next to keep the database's load to a fifth");
  // its poll was the whole pass: the pass's wait is the one said (the larger, or equal, of the two)
  assert.match(polled({ lastPollMs: 6 * MIN, lastPassMs: 6 * MIN }).lateWhy!, /^every polled table's polls took 6 min/);
});

test("the promise's floor, a restart with nothing measured, off, recopy and a stream", () => {
  assert.equal(polled({ intervalSeconds: 1, lastPollMs: 200 }).promisedSeconds, 61, "poll 1s: 1 + the 60 s floor");
  assert.deepEqual(polled({ lastPollMs: null, lastPassMs: 0 }), { promisedSeconds: 960, lateWhy: "it has not been polled since Mason started: it is polled at the next pass" },
    "nothing measured this run (a restart): the floor");
  assert.deepEqual(keptPromise({ mode: "off", intervalSeconds: 0, lastPollMs: 2_000, lastPassMs: 13 * MIN, pending: null, notRunning: null, passFailed: false, dueMs: null, now: NOW }),
    { promisedSeconds: null, lateWhy: null }, "off promises nothing");
  const recopy = keptPromise({ mode: "recopy", intervalSeconds: 3600, lastPollMs: null, lastPassMs: 5 * MIN, pending: null, notRunning: null, passFailed: false, dueMs: null, now: NOW });
  assert.equal(recopy.promisedSeconds, 4200, "1 h + max(60, 2 × 5 min)");
  assert.match(recopy.lateWhy!, /took 5 min/);
  const stream = (notRunning: string | null): Promised => keptPromise({ mode: "replication", intervalSeconds: 0, lastPollMs: null, lastPassMs: 0, pending: null, notRunning, passFailed: false, dueMs: null, now: NOW });
  assert.equal(stream(null).promisedSeconds, 120);
  assert.equal(stream("it has not started yet: it starts at the next pass").lateWhy, "the stream is not running: it has not started yet: it starts at the next pass");
  // a pending rebuild, a failed pass: said before the schedule
  assert.equal(polled({ pending: "it is caught up by one poll after its whole read first" }).lateWhy, "it is caught up by one poll after its whole read first");
  assert.match(polled({ passFailed: true }).lateWhy!, /^the sync's last pass failed/);
  assert.equal(polled({}).lateWhy, "its next poll is due 12:05 UTC");
});
