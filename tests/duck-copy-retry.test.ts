/**
 * HOW LONG A FAILED COPY WAITS (src/duck/sync.ts copyRetryDelayMs: a copy failing for good read a
 * production replica whole for 20 minutes at every pass): four times the attempt, at least 5 minutes, doubled for each
 * failure in a row, at most 6 hours. tests/integration/duck-poll.itest.ts holds the sync to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyRetryDelayMs, streamRetryDelayMs } from "../src/duck/sync.ts";

test("a failed copy waits four times its attempt, at least 5 minutes, doubled for each failure in a row, at most 6 hours", () => {
  const min = 60_000;
  assert.equal(copyRetryDelayMs(1, 1_000), 5 * min, "a quick failure waits 5 minutes");
  assert.equal(copyRetryDelayMs(2, 1_000), 10 * min);
  assert.equal(copyRetryDelayMs(1, 20 * min), 80 * min, "a 20-minute attempt waits 80 minutes: the source is read a fifth of the time at most");
  assert.equal(copyRetryDelayMs(2, 20 * min), 160 * min);
  assert.equal(copyRetryDelayMs(3, 20 * min), 320 * min);
  assert.equal(copyRetryDelayMs(4, 20 * min), 6 * 60 * min, "never more than 6 hours");
  assert.equal(copyRetryDelayMs(60, 1_000), 6 * 60 * min, "however many failures");
});

test("a failed replication stream starts again after the interval, doubled for each failure in a row, at most 5 minutes", () => {
  assert.equal(streamRetryDelayMs(1_000, 1), 1_000);
  assert.equal(streamRetryDelayMs(1_000, 2), 2_000);
  assert.equal(streamRetryDelayMs(1_000, 5), 16_000);
  assert.equal(streamRetryDelayMs(1_000, 12), 300_000, "never more than 5 minutes");
  assert.equal(streamRetryDelayMs(600_000, 1), 300_000);
});
