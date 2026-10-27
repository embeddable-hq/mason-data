/**
 * TWO VALUES COMPARED BY WHAT THEY MEAN (tests/integration/duck-oracle.itest.ts tells a wrong VALUE from a different
 * TEXT of the same value with it): a number is a number whether `120`, `"120"` or `120.00`; a time is its instant
 * whether `2026-09-15T00:00:00Z` or `2026-09-15 00:00:00+00` (and `1.5e+15` is `1500000000000000`); a boolean is `t` / `f`; NULL is NULL. An INTEGER on both
 * sides compares exactly, by its digits (a 2^53 + 1 that came back as 2^53 is a difference, as is 1,000 off on a
 * 13-digit id); every other number to one part in 10^12.
 */

export type Norm = null | { n: number; i?: string } | { t: string } | { s: string };

const TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00(?::00)?)?$/;

/** @param text — the value is a TEXT column's: never read as a number or a time, whatever its digits */
export function normalise(v: unknown, text = false): Norm {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return { s: v ? "t" : "f" };
  if (text) return { s: String(v) };
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 2 ** 53 ? { n: v, i: String(v) } : { n: v };
  const s = String(v);
  const t = TIME_RE.exec(s);
  if (t) return { t: `${t[1]} ${t[2]}${t[3] ? `.${t[3].replace(/0+$/, "")}`.replace(/\.$/, "") : ""}` };
  if (/^-?\d+$/.test(s)) return { n: Number(s), i: BigInt(s).toString() };
  // a non-integer, with an exponent too: a double past 1e15 or under 1e-4 is printed so (`1.6935087641981325e+15`),
  // and read as text its last digit was a wrong VALUE (CI's x86_64 runner, a float8 variance)
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s) && Number.isFinite(Number(s))) return { n: Number(s) };
  return { s };
}

export function same(a: Norm, b: Norm): boolean {
  if (a === null || b === null) return a === b;
  if ("n" in a && "n" in b) {
    // two integers: their digits, exactly (an Int64 past 2^53 rounded by JSON.parse is a difference)
    if (a.i !== undefined && b.i !== undefined) return a.i === b.i;
    if (a.n === b.n) return true;
    // a double's last digits: one part in 10^12 (a cent lost on a billion, 1e-11, is still seen)
    const scale = Math.max(Math.abs(a.n), Math.abs(b.n), 1);
    return Math.abs(a.n - b.n) / scale <= 1e-12;
  }
  if ("t" in a && "t" in b) return a.t === b.t;
  if ("s" in a && "s" in b) return a.s === b.s;
  // a number printed as text on one side (a bigint in JSON) — compare as what both parse to
  const x = "s" in a ? normalise(a.s) : a, y = "s" in b ? normalise(b.s) : b;
  if (x !== null && y !== null && "n" in x && "n" in y) return same(x, y);
  return false;
}
