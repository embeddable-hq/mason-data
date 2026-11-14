/**
 * TWO VALUES COMPARED BY WHAT THEY MEAN (tests/integration/duck-oracle.itest.ts tells a wrong VALUE from a different
 * TEXT of the same value with it): a number is a number whether `120`, `"120"` or `120.00`; a time is its instant
 * whether `2026-09-15T00:00:00Z` or `2026-09-15 00:00:00+00` (and `1.5e+15` is `1500000000000000`); a boolean is `t` / `f`; NULL is NULL. An INTEGER on both
 * sides compares exactly, by its digits (a 2^53 + 1 that came back as 2^53 is a difference, as is 1,000 off on a
 * 13-digit id); every other number to one part in 10^12. A column both sides send as `numeric` is judged by the
 * owner's rule instead (`numericWithinRule`, below).
 */
import { compare, NumericError, numericOrderKey, numericText, parseNumeric, round, trunc, type PgNumeric } from "../../../src/lib/pg-numeric.ts";

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

/**
 * A NUMERIC JUDGED BY THE OWNER'S RULE (CLAUDE.md "Only these block a merge", docs/DESIGN.md "When a numeric is
 * right"), exactly, by src/lib/pg-numeric.ts, never a double. Mason's `numeric` is Postgres's when:
 *  1. its whole-number digits (left of the point) are Postgres's; and
 *  2. the two values are equal when both are rounded to 15 significant digits.
 * So `2.5` is `2.50`, and a digit past the 15th significant one may differ. A whole-number digit that changes only
 * because that rounding carries into it is within the rule (0.99999999999999999 beside 1): a value rounded at a
 * decimal (fewer than 15 whole-number digits) whose whole part is then the other's. NaN and ±Infinity are only
 * themselves, and a text that is no numeric is never within the rule. The oracle applies this to a column both sides
 * send as numeric (OID 1700) alone: a numeric inside a JSON, an array or a row's text is a string to the client, and is
 * held as one.
 */
export const NUMERIC_OID = 1700;
const SPECIAL = new Set(["NaN", "Infinity", "-Infinity"]);
const SIGNIFICANT = 15;

/** a finite numeric's decimal exponent: the value is 0.<digits> × 10^exponent (0 for zero) */
const exponentOf = (n: PgNumeric): number => n.unscaled === 0n ? 0 : (n.unscaled < 0n ? -n.unscaled : n.unscaled).toString().length - n.scale;
/** the value rounded to 15 significant digits, half away from zero, as Postgres's round() rounds */
const rounded = (n: PgNumeric): PgNumeric => round(n, SIGNIFICANT - exponentOf(n));
/** the whole-number part, toward zero */
const whole = (n: PgNumeric): bigint => trunc(n, 0).unscaled;

/** the numeric a text is, or its special value's name; undefined for a text no numeric reads as */
function numericOf(text: string): PgNumeric | string | undefined {
  if (SPECIAL.has(text)) return text;
  try { return parseNumeric(text); }
  catch (e) {
    // (a text no numeric reads as is a wrong value, never within the rule: the caller says so)
    if (e instanceof NumericError) return undefined;
    throw e;
  }
}

/** whether Mason's numeric text `got` is Postgres's `want` by the rule (two texts: NULL is the caller's) */
export function numericWithinRule(want: string, got: string): boolean {
  if (want === got) return true;
  const a = numericOf(want), b = numericOf(got);
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (compare(rounded(a), rounded(b)) !== 0) return false;
  if (whole(a) === whole(b)) return true;
  // the rounding's carry: one side, rounded at a decimal, has the other's whole-number part
  const carried = (x: PgNumeric, other: PgNumeric): boolean => exponentOf(x) < SIGNIFICANT && whole(rounded(x)) === whole(other);
  return carried(a, b) || carried(b, a);
}

type Row = (string | null)[];
type Cell = "same" | "text" | "value";

/** one cell of Postgres's against Mason's: the same, another text of the same value, or a wrong value */
function cellOf(a: string | null, b: string | null, numeric: boolean): Cell {
  if (a === b) return "same";
  if (numeric) return a !== null && b !== null && numericWithinRule(a, b) ? "same" : "value";
  return same(normalise(a), normalise(b)) ? "text" : "value";
}

/**
 * TWO RESULTS' ROWS, of one count, as the oracle's verdict holds them (tests/integration/duck-oracle.itest.ts): a wrong
 * VALUE, the same rows in another ORDER, a different TEXT of the same values, or null when alike. `numeric[j]` is
 * whether both sides send column j as numeric, judged by the rule (`numericWithinRule`). Rows compared unordered are
 * sorted by a key the rule's equal values share, then paired: two rows of one key are swapped where that pairs them
 * alike, so `2.5` meets `2.50` whatever the order its texts would sort in.
 */
export function compareRows(want: Row[], got: Row[], names: string[], numeric: boolean[], inOrder: boolean): { kind: "value" | "rows" | "text"; detail: string } | null {
  const keyOf = (r: Row): string => JSON.stringify(r.map((c, j) => numeric[j] === true && c !== null ? numericSortKey(c) : c));
  const sorted = (rs: Row[]): { rows: Row[]; keys: string[] } => {
    const keyed = rs.map((r) => ({ r, k: keyOf(r), t: JSON.stringify(r) }));
    keyed.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
    return { rows: keyed.map((x) => x.r), keys: keyed.map((x) => x.k) };
  };
  const rowOf = (w: Row, g: Row): Cell => {
    let worst: Cell = "same";
    for (let j = 0; j < w.length; j++) { const c = cellOf(w[j] ?? null, g[j] ?? null, numeric[j] === true); if (c === "value") return c; if (c === "text") worst = c; }
    return worst;
  };
  /** both sorted, and the rows of one key paired where a swap pairs them better (alike first, else another text) */
  const paired = (): [Row[], Row[]] => {
    const w = sorted(want), g = sorted(got);
    for (let i = 0; i < w.rows.length; i++) {
      const now = rowOf(w.rows[i]!, g.rows[i]!);
      if (now === "same") continue;
      const goal: Cell[] = now === "value" ? ["same", "text"] : ["same"];
      let swap = -1;
      for (const aim of goal) {
        for (let j = i + 1; j < g.rows.length && g.keys[j]! <= w.keys[i]!; j++) {
          if (g.keys[j] === w.keys[i] && rowOf(w.rows[i]!, g.rows[j]!) === aim) { swap = j; break; }
        }
        if (swap >= 0) break;
      }
      if (swap >= 0) { [g.rows[i], g.rows[swap]] = [g.rows[swap]!, g.rows[i]!]; [g.keys[i], g.keys[swap]] = [g.keys[swap]!, g.keys[i]!]; }
    }
    return [w.rows, g.rows];
  };
  /** the first wrong value and the first other text, in this pairing */
  const differences = (w: Row[], g: Row[]): { value: string | null; text: string | null } => {
    let text: string | null = null;
    for (let i = 0; i < w.length; i++) {
      for (let j = 0; j < w[i]!.length; j++) {
        const a = w[i]![j]!, b = g[i]![j]!;
        const c = cellOf(a, b, numeric[j] === true);
        if (c === "same") continue;
        const loc = `row ${i + 1}, ${JSON.stringify(names[j])}: ${JSON.stringify(b)} where Postgres has ${JSON.stringify(a)}`;
        if (c === "value") return { value: loc, text };
        text ??= loc;
      }
    }
    return { value: null, text };
  };
  const found = inOrder ? differences(want, got) : differences(...paired());
  if (found.value !== null) {
    // the rows may be the same SET in another order: a sort difference, not a value
    if (inOrder) { const unordered = differences(...paired()); if (unordered.value === null && unordered.text === null) return { kind: "rows", detail: `the same rows in another ORDER (first at ${found.value})` }; }
    return { kind: "value", detail: found.value };
  }
  return found.text === null ? null : { kind: "text", detail: found.text };
}

/** a key every two numerics within the rule share (the value rounded to 15 significant digits, in numeric order), by
 *  which rows are sorted before they are paired; a text that is no numeric keys as itself, after every numeric */
export function numericSortKey(text: string): string {
  const n = numericOf(text);
  if (n === undefined) return `￿${text}`;
  return numericOrderKey(typeof n === "string" ? n : numericText(rounded(n)));
}
