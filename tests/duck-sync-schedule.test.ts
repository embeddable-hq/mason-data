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
