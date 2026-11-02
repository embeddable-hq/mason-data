/**
 * THE SESSION'S INSTANT IS MICROSECONDS (GitHub issues 372, 363): Postgres's transaction start is gettimeofday's
 * microseconds, so `now()`, the clock keywords and a relative word (`'now'`) carry six fraction digits, and a prepared
 * statement's `'now'` and its run's `now()` differ whenever their transactions do, even inside one millisecond. A
 * JavaScript millisecond made them equal there (the flaky oracle of issue 372). So the instant is an integer count of
 * microseconds since the Unix epoch (exact below 2^53, until the year 2255), read from ONE clock (`nowMicros`), written
 * for DuckDB by ONE formatter (`instantText`), and handed to the catalog's PGlite as the wall clock that reads back as
 * exactly that microsecond (`instantWallMs`).
 */

/** where the monotonic clock stood at the last re-anchoring, and the microsecond it was read as */
let anchor: { us: number; mono: number } | null = null;

/**
 * The wall clock in microseconds since the epoch. `wall` (Date.now) decides the millisecond, so the reading never
 * drifts from the clock an operator sets; the monotonic clock (`performance.now()`) only fills the microseconds inside
 * it. The reading is clamped into that millisecond and re-anchored there when the monotonic clock has parted from it
 * (`performance.timeOrigin + performance.now()` alone drifts from the wall clock over a long uptime), so it is
 * non-decreasing while the wall clock is. `wall`: the worker that replaces `Date.now` passes the real one.
 */
export function nowMicros(wall: () => number = Date.now): number {
  const ms = wall();
  const mono = performance.now();
  const lo = ms * 1000, hi = lo + 999;
  anchor ??= { us: Math.floor((performance.timeOrigin + mono) * 1000), mono };
  let us = anchor.us + Math.floor((mono - anchor.mono) * 1000);
  if (us < lo || us > hi) {
    us = us < lo ? lo : hi;
    anchor = { us, mono };
  }
  return us;
}

const integral = (us: number): number => {
  if (!Number.isSafeInteger(us)) throw new Error(`an instant is a whole number of microseconds, not ${us}`);
  return us;
};

/** An instant as the text DuckDB binds as a TIMESTAMPTZ: ISO 8601 in UTC with six fraction digits,
 *  `2026-01-02T20:00:00.123456Z` (Date's own text stops at the millisecond). */
export function instantText(us: number): string {
  const ms = Math.floor(integral(us) / 1000);
  return `${new Date(ms).toISOString().slice(0, -1)}${String(us - ms * 1000).padStart(3, "0")}Z`;
}

/**
 * The `Date.now()` value PGlite reads back as exactly the microsecond `us`. Emscripten's `clock_time_get` takes
 * `Math.round(Date.now() * 1e3 * 1e3)` nanoseconds, a product past 2^53 and so off by up to ~256 ns, and musl's
 * gettimeofday truncates that to microseconds: `us / 1000` lands one microsecond low about half the time. The
 * half-microsecond point lands inside `us` whatever that rounding does (tests/postgres-api/catalog.test.ts).
 */
export function instantWallMs(us: number): number {
  return (integral(us) + 0.5) / 1000;
}
