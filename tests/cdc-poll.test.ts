/**
 * The poll's SQL (src/cdc/poll.ts), pure parts: the watermark read from a snapshot, a row's 64-bit transaction id
 * across a wraparound, a copy's chunk held to its first snapshot as the complement of what the catch-up poll reads,
 * and the backoff. The ordering against live transactions is the integration suite's
 * (tests/integration/duck-poll.itest.ts).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { nextPollDelayMs, snapshotXmin, xmin8Sql } from "../src/cdc/poll.ts";
import * as pollModule from "../src/cdc/poll.ts";

test("the watermark is the snapshot's xmin: the oldest transaction still running at the poll", () => {
  assert.equal(snapshotXmin("742:755:742,750"), 742n);
  assert.equal(snapshotXmin("8589934600:8589934600:"), 8589934600n);
  assert.throws(() => snapshotXmin("not a snapshot"), /not a pg_snapshot/);
});

/** What xmin8Sql's expression computes, in JS, for a 32-bit xmin: the 64-bit id it stands for. */
function xmin8(current: bigint, xmin: bigint): bigint {
  const m = /^\(\((-?\d+)::bigint - \(xmin::text::bigint > (\d+)\)::int\) << 32 \| xmin::text::bigint\)$/.exec(xmin8Sql(current));
  assert.ok(m, xmin8Sql(current));
  const epoch = BigInt(m[1]!), low = BigInt(m[2]!);
  return ((epoch - (xmin > low ? 1n : 0n)) << 32n) | xmin;
}

test("a row's xmin becomes its 64-bit transaction id, the epoch before when the counter wrapped since", () => {
  // epoch 0: ids are what they are
  assert.equal(xmin8(1000n, 990n), 990n);
  // epoch 2, current low bits 100: an xmin of 50 is this epoch's, one of 4,294,967,000 the last epoch's
  const current = (2n << 32n) | 100n;
  assert.equal(xmin8(current, 50n), (2n << 32n) | 50n);
  assert.equal(xmin8(current, 4_294_967_000n), (1n << 32n) | 4_294_967_000n);
});

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { xminBeforeHolds, xminBeforeSql } = pollModule as unknown as { xminBeforeHolds: (current: bigint, watermark: bigint) => boolean; xminBeforeSql: (watermark: bigint) => string };

/** What xminBeforeSql's expression keeps, in JS: Postgres's `age(x)` is the int32 distance from the transaction's
 *  stable latest id `latest` (the next id) to x, INT_MAX for a special id (0, 1, 2) */
function keptBefore(watermark: bigint, latest: bigint, xmin: bigint): boolean {
  const m = /^\(age\(xmin\) > \(SELECT age\('(\d+)'::xid\)\) OR age\(xmin\) < 0\)$/.exec(xminBeforeSql(watermark));
  assert.ok(m, xminBeforeSql(watermark));
  const age = (x: bigint): bigint => x < 3n ? 2_147_483_647n : BigInt.asIntN(32, (latest & 0xffffffffn) - x);
  return age(xmin) > age(BigInt(m[1]!)) || age(xmin) < 0n;
}

// A COPY IN SEVERAL SOURCE TRANSACTIONS HELD TO ITS FIRST SNAPSHOT (src/duck/sync.ts `copy`): every chunk keeps the rows
// written before the first snapshot's xmin, and the catch-up poll from that watermark reads every row written at or past
// it. Nothing may be in neither (a gap), and within 2^31 of the reading transaction nothing may be in both.
test("a chunk keeps exactly the rows older than the watermark: the complement of what the catch-up poll reads", () => {
  const cases: Array<{ what: string; watermark: bigint; latest: bigint; catchUp: bigint }> = [
    { what: "epoch 0", watermark: 1_000n, latest: 1_200n, catchUp: 1_500n },
    { what: "an epoch past 0", watermark: (3n << 32n) | 500_000n, latest: (3n << 32n) | 600_000n, catchUp: (3n << 32n) | 900_000n },
    { what: "the counter wrapped between the watermark and the chunk", watermark: (1n << 32n) | 4_294_967_000n, latest: (2n << 32n) | 400n, catchUp: (2n << 32n) | 900n },
    { what: "the counter wrapped between the chunk and the catch-up", watermark: (1n << 32n) | 4_294_960_000n, latest: (1n << 32n) | 4_294_966_000n, catchUp: (2n << 32n) | 300n },
  ];
  for (const { what, watermark, latest, catchUp } of cases) {
    assert.ok(xminBeforeHolds(latest, watermark), what);
    // every 32-bit xmin, sampled densely near the watermark and the latest id, and across the whole space
    const near = (c: bigint): bigint[] => Array.from({ length: 41 }, (_, i) => (c + BigInt(i) - 20n) & 0xffffffffn);
    const xmins = [0n, 1n, 2n, 3n, ...near(watermark), ...near(latest), ...near(catchUp), ...Array.from({ length: 4096 }, (_, i) => BigInt(i) * 1_048_573n & 0xffffffffn)];
    for (const x of xmins) {
      const kept = keptBefore(watermark, latest, x);
      const readByCatchUp = xmin8(catchUp, x) >= watermark;
      assert.ok(kept || readByCatchUp, `${what}: xmin ${x} is in neither the copy nor the catch-up`);
      // a row within 2^31 of the chunk's transaction: its true id is the one xmin8 gives, and kept means older than the watermark
      const id = xmin8(latest, x);
      if (x >= 3n && latest - id < 2n ** 31n) assert.equal(kept, id < watermark, `${what}: xmin ${x} (id ${id})`);
    }
  }
  // past a billion transactions since the watermark the age arithmetic is not trusted: the copy starts over
  assert.equal(xminBeforeHolds(1_000n + 2n ** 30n, 1_000n), false);
  assert.equal(xminBeforeHolds(999n, 1_000n), false, "a reading transaction before the watermark: a Mason bug, never trusted");
  // a watermark whose low bits are below the first normal id keeps the same rows as one at 3
  assert.equal(xminBeforeSql(1n << 32n), xminBeforeSql((1n << 32n) | 3n));
});

test("a slow poll stretches the interval to four times its own length; a table's interval is never shortened", () => {
  assert.equal(nextPollDelayMs(1000, 50), 1000);
  assert.equal(nextPollDelayMs(1000, 800), 3200);
  assert.equal(nextPollDelayMs(1000, 20_000), 80_000, "a 20 s poll is a fifth of the time, never a third");
  assert.equal(nextPollDelayMs(3_600_000, 15_000), 3_600_000, "an hour asked for is an hour");
});
