// src/lib/instant.ts: the session's instant in microseconds (GitHub issues 372, 363) — one clock that follows Date.now
// to the millisecond and fills the microseconds inside it, one formatter for the DuckDB path, and the wall clock
// PGlite reads back as exactly that microsecond.
import assert from "node:assert/strict";
import { test } from "node:test";
import { instantText, instantWallMs, nowMicros } from "../src/lib/instant.ts";

const AT = Date.UTC(2026, 0, 2, 20, 0, 0) * 1000;

test("microsecond clock: follows Date.now to its millisecond, fills the microseconds, never goes back", () => {
  const seen = new Set<number>();
  let last = -Infinity;
  for (let i = 0; i < 20_000; i++) {
    const before = Date.now();
    const us = nowMicros();
    const after = Date.now();
    assert.ok(Number.isSafeInteger(us), `an integer: ${us}`);
    assert.ok(us >= before * 1000 && us <= after * 1000 + 999, `within Date.now's millisecond: ${us} against ${before}..${after}`);
    assert.ok(us >= last, `non-decreasing: ${us} after ${last}`);
    last = us;
    seen.add(us % 1000);
  }
  // microsecond resolution: the readings fill the millisecond, not only its first microsecond
  assert.ok(seen.size > 10, `the sub-millisecond digits vary (${seen.size} seen)`);
});

test("microsecond clock: a wall clock that parts from the monotonic one is followed, in either direction", () => {
  // the wall clock jumps an hour ahead, then back to where it was: the reading is that millisecond's, at once
  let wall = Date.now();
  const ahead = nowMicros(() => wall + 3_600_000);
  assert.ok(ahead >= (wall + 3_600_000) * 1000 && ahead <= (wall + 3_600_000) * 1000 + 999, String(ahead));
  wall = Date.now();
  const back = nowMicros(() => wall);
  assert.ok(back >= wall * 1000 && back <= wall * 1000 + 999, String(back));
});

test("microsecond clock: the formatter writes six fraction digits, the edges included", () => {
  assert.equal(instantText(AT), "2026-01-02T20:00:00.000000Z");
  assert.equal(instantText(AT + 1), "2026-01-02T20:00:00.000001Z");
  assert.equal(instantText(AT + 123_456), "2026-01-02T20:00:00.123456Z");
  assert.equal(instantText(AT + 500_000), "2026-01-02T20:00:00.500000Z");
  assert.equal(instantText(AT + 999_999), "2026-01-02T20:00:00.999999Z");
  assert.equal(instantText(-1), "1969-12-31T23:59:59.999999Z");
  assert.throws(() => instantText(AT + 0.5), /whole number of microseconds/);
});

test("microsecond clock: the wall clock handed to PGlite reads back as exactly the microsecond, as emscripten and musl read it", () => {
  // emscripten's clock_time_get: Math.round(Date.now() * 1e3 * 1e3) nanoseconds; musl's gettimeofday: truncated to µs
  const readBack = (ms: number): number => Number(BigInt(Math.round(ms * 1e3 * 1e3)) / 1000n);
  for (const tail of [0, 1, 123_456, 499_999, 500_000, 999_999]) assert.equal(readBack(instantWallMs(AT + tail)), AT + tail, `.${String(tail).padStart(6, "0")}`);
  // the naive millisecond lands a microsecond low at some of them, which is why it is not used
  assert.ok([0, 1, 123_456, 499_999, 500_000, 999_999].some((t) => readBack((AT + t) / 1000) !== AT + t));
  for (let i = 0; i < 100_000; i++) {
    const us = AT + Math.floor(Math.random() * 1e13);
    assert.equal(readBack(instantWallMs(us)), us);
  }
});
