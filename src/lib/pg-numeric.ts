/**
 * POSTGRES'S `numeric`, EXACTLY: the one place the Postgres API decides when a value is a `numeric` (oid 1700) and
 * computes its digits as Postgres would (the Cube replay on #499, finding 4: `avg(bigint)` came back as a JSON
 * number missing its last digits where Postgres sends `21.8594916280008069`; what is said to be supported must return
 * the numbers, formats and results Postgres does). Read by the copy's path (src/duck/) and the
 * wire encoder (src/api/postgres/encode.ts); in the ClickHouse stack this was cut from, also by its HTTP body path's
 * metric types and averages and its unrouted SQL path's aggregates and arithmetic.
 *
 * WHEN A VALUE IS EXACT: its inputs are integers (a count, a sum, an integer column, integer arithmetic — ClickHouse
 * computes those exactly and the API carries a 64-bit one as digits) or numeric literals, combined by `+ - * /`,
 * `round`, a cast to `numeric`, `avg` and `sum`. Then the digits are knowable, and this module computes them with
 * Postgres's own rules, in BigInt arithmetic: a sum and a product keep every digit (the result's scale is the larger,
 * or the sum, of the inputs' scales), a quotient is rounded HALF AWAY FROM ZERO at the scale `select_div_scale`
 * (numeric.c) picks — at least 16 significant digits, never fewer decimals than either input shows — and `round(x, n)`
 * rounds half away from zero to n decimals and shows exactly n. An average is the sum divided by the count, as
 * Postgres's `int8_avg` / `numeric_poly_avg` divide them. A value with a float input — a `double precision` column, a
 * source `numeric` column (Mason reads every one as Float64, CLAUDE.md) — is NOT exact, stays `double precision`, and
 * keeps the divergence docs/POSTGRES-API.md declares.
 *
 * THE TEXT FORM is `numeric_out`'s: every digit of the scale written, trailing zeros kept (`avg(1)` is
 * `1.00000000000000000000`), no exponent, `-` for a negative value and never for zero. THE BINARY FORM is
 * `numeric_send`'s: base-10000 digit groups with a weight, a sign and the display scale, leading and trailing zero
 * groups stripped as `make_result` strips them.
 *
 * Pure and dependency-free: tests/pg-numeric.test.ts holds every operation to PGlite's own numeric over generated values.
 */
import { Buffer } from "node:buffer";
import { gapMark, type GapId } from "../duck/gaps.ts";

/** A numeric value: `unscaled × 10^-scale`, with `scale` its display scale (`dscale`: the decimals `numeric_out` writes). */
export interface PgNumeric { unscaled: bigint; scale: number }

/** A value this module cannot compute as Postgres does, or an operation Postgres refuses: with Postgres's SQLSTATE. */
export class NumericError extends Error {
  readonly sqlstate: string;
  /** the registry entry that refused it (src/duck/gaps.ts): the request log's `gap`; null for Postgres's own error */
  readonly gap: GapId | null;
  /** Postgres's DETAIL, apart from its message, as Postgres sends them (`numeric field overflow` and its field's limit) */
  readonly detail: string | null;
  constructor(message: string, sqlstate: string, gap: GapId | null = null, detail: string | null = null) { super(message); this.sqlstate = sqlstate; this.gap = gap; this.detail = detail; }
}

/**
 * A NUMERIC FIELD OVERFLOW IN POSTGRES'S WORDS (22003), the one place they are written: its message, and its DETAIL as
 * `apply_typmod` gives it, for every path that raises one (this module's typmod, the engine's DECIMAL cast in
 * src/duck/store.ts `postgresWording`). An infinite value has its own DETAIL (Postgres 14+).
 */
export function fieldOverflow(precision: number, scale: number, infinite = false): { message: string; detail: string } {
  const digits = precision - scale;
  return { message: "numeric field overflow", detail: infinite ? `A field with precision ${precision}, scale ${scale} cannot hold an infinite value.`
    : `A field with precision ${precision}, scale ${scale} must round to an absolute value less than ${digits === 0 ? "1" : `10^${digits}`}.` };
}

/** Postgres's limits on a numeric's scale (numeric.h): a quotient's scale is held between these */
const NUMERIC_MIN_SIG_DIGITS = 16;
const NUMERIC_MAX_DISPLAY_SCALE = 1000;
/** the decimal digits in one base-10000 group (numeric.c's DEC_DIGITS, NBASE = 10^DEC_DIGITS) */
const DEC_DIGITS = 4;

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const abs = (x: bigint): bigint => x < 0n ? -x : x;

/** `x / d` rounded half away from zero (d > 0): how numeric.c's `round_var` and `div_var(…, round = true)` round */
function divRound(x: bigint, d: bigint): bigint {
  const q = abs(x) / d;
  const r = abs(x) % d;
  const rounded = 2n * r >= d ? q + 1n : q;
  return x < 0n ? -rounded : rounded;
}

/** digits, an underscore allowed between two of them (Postgres 16: `1_000`) */
const DIGITS = String.raw`\d+(?:_\d+)*`;
const NUMERIC_TEXT = new RegExp(String.raw`^\s*([+-])?(${DIGITS})?(?:\.(${DIGITS})?)?(?:[eE]([+-]?${DIGITS}))?\s*$`);
/** Postgres 16's non-decimal integers: `0x1F`, `0o17`, `0b101`, an underscore before any digit (`0x_1F`) */
const NON_DECIMAL = /^\s*([+-])?0(?:[xX]((?:_?[0-9a-fA-F])+)|[oO]((?:_?[0-7])+)|[bB]((?:_?[01])+))\s*$/;

/** A numeric from its text, as `numeric_in` reads it (held to Postgres by tests/pg-numeric.test.ts): the scale is the
 *  decimals written, less the exponent (never below 0): `1.50` has scale 2, `1.5e3` is 1500 with scale 0, `1e-3` is
 *  0.001 with scale 3; `1_000` is 1000 and `0x1F` is 31 (scale 0). NaN and Infinity are no PgNumeric: refused here. */
export function parseNumeric(text: string): PgNumeric {
  const x = NON_DECIMAL.exec(text);
  if (x !== null) {
    const [prefix, digits] = x[2] !== undefined ? ["0x", x[2]] : x[3] !== undefined ? ["0o", x[3]] : ["0b", x[4]!];
    const v = BigInt(prefix + digits.replaceAll("_", ""));
    return { unscaled: x[1] === "-" ? -v : v, scale: 0 };
  }
  const m = NUMERIC_TEXT.exec(text);
  if (m === null || (m[2] === undefined && m[3] === undefined)) throw new NumericError(`invalid input syntax for type numeric: "${text}"`, "22P02");
  const frac = (m[3] ?? "").replaceAll("_", "");
  const exp = m[4] === undefined ? 0 : Number(m[4].replaceAll("_", ""));
  const digits = BigInt(`${(m[2] ?? "").replaceAll("_", "")}${frac}` || "0");
  const shift = frac.length - exp;   // the value is digits × 10^-shift
  const scale = Math.max(0, shift);
  const unscaled = digits * pow10(scale - shift);
  return { unscaled: m[1] === "-" ? -unscaled : unscaled, scale };
}

/** A text as Postgres's numeric reads it, written back as numeric_out writes it (`1_000.50` → `1000.50`, `0x1F` → `31`,
 *  `1.5e1` → `15`); null for a text it reads as no finite numeric (NaN, Infinity, or no numeric at all). */
export function numericLiteral(text: string): string | null {
  try { return numericText(parseNumeric(text)); }
  catch (e) { if (e instanceof NumericError) return null; throw e; }
}

/** `numeric_out`: the digits with exactly `scale` decimals, no exponent; zero is never negative. */
export function numericText(n: PgNumeric): string {
  const digits = abs(n.unscaled).toString().padStart(n.scale + 1, "0");
  const whole = digits.slice(0, digits.length - n.scale);
  const text = n.scale === 0 ? whole : `${whole}.${digits.slice(digits.length - n.scale)}`;
  return n.unscaled < 0n ? `-${text}` : text;
}

/** The value at a larger scale (more trailing zeros), unchanged. */
const atScale = (n: PgNumeric, scale: number): bigint => n.unscaled * pow10(scale - n.scale);

export const add = (a: PgNumeric, b: PgNumeric): PgNumeric => {
  const scale = Math.max(a.scale, b.scale);
  return { unscaled: atScale(a, scale) + atScale(b, scale), scale };
};
export const sub = (a: PgNumeric, b: PgNumeric): PgNumeric => add(a, { unscaled: -b.unscaled, scale: b.scale });
/** `numeric_mul`: exact, at the sum of the scales */
export const mul = (a: PgNumeric, b: PgNumeric): PgNumeric => ({ unscaled: a.unscaled * b.unscaled, scale: a.scale + b.scale });

/** The base-10000 groups of a value, most significant first, and the weight of the first (numeric.c's NumericVar:
 *  the group holding the units has weight 0, the four decimals after the point weight -1). Zero groups at either end
 *  are dropped, as `make_result` drops them; zero is no group at all, at weight 0. */
function groups(n: PgNumeric): { digits: number[]; weight: number } {
  if (n.unscaled === 0n) return { digits: [], weight: 0 };
  // align the decimal point on a group boundary: pad the decimals to a multiple of four
  const pad = (DEC_DIGITS - (n.scale % DEC_DIGITS)) % DEC_DIGITS;
  let u = abs(n.unscaled) * pow10(pad);
  const fracGroups = (n.scale + pad) / DEC_DIGITS;
  const lsFirst: number[] = [];
  while (u > 0n) { lsFirst.push(Number(u % 10000n)); u /= 10000n; }
  let low = 0;
  while (lsFirst[low] === 0) low++;
  const digits = lsFirst.slice(low).reverse();
  return { digits, weight: lsFirst.length - 1 - fracGroups };
}

/**
 * `select_div_scale` (numeric.c), faithfully: a quotient keeps at least NUMERIC_MIN_SIG_DIGITS significant digits —
 * the scale is read from the WEIGHTS and FIRST GROUPS of the two values, so it depends on the values, not only their
 * types — and never fewer decimals than either input shows, between 0 and NUMERIC_MAX_DISPLAY_SCALE.
 */
export function divScale(a: PgNumeric, b: PgNumeric): number {
  const ga = groups(a), gb = groups(b);
  const weight1 = ga.digits.length ? ga.weight : 0, first1 = ga.digits[0] ?? 0;
  const weight2 = gb.digits.length ? gb.weight : 0, first2 = gb.digits[0] ?? 0;
  // the quotient's weight; when the first groups are equal it may be either, and the smaller is assumed
  let qweight = weight1 - weight2;
  if (first1 <= first2) qweight--;
  let rscale = NUMERIC_MIN_SIG_DIGITS - qweight * DEC_DIGITS;
  rscale = Math.max(rscale, a.scale, b.scale, 0);
  return Math.min(rscale, NUMERIC_MAX_DISPLAY_SCALE);
}

/** `numeric_div`: rounded half away from zero at `divScale`; a zero divisor is Postgres's 22012. */
export function div(a: PgNumeric, b: PgNumeric): PgNumeric {
  if (b.unscaled === 0n) throw new NumericError("division by zero", "22012");
  const scale = divScale(a, b);
  // a / b × 10^scale = a.u × 10^(scale - a.s + b.s) / b.u
  const e = scale - a.scale + b.scale;
  let num = a.unscaled, den = b.unscaled;
  if (e >= 0) num *= pow10(e); else den *= pow10(-e);
  if (den < 0n) { num = -num; den = -den; }
  return { unscaled: divRound(num, den), scale };
}

/** `round(numeric, n)`: half away from zero to n decimals, shown with exactly n (none when n < 0, which rounds to tens,
 *  hundreds …). Postgres clamps n to ±NUMERIC_MAX_RESULT_SCALE (2000). */
export function round(a: PgNumeric, n: number): PgNumeric {
  const s = Math.max(-2000, Math.min(2000, Math.trunc(n)));
  if (s >= a.scale) return { unscaled: atScale(a, s), scale: s };
  const unscaled = divRound(a.unscaled, pow10(a.scale - s));
  return s >= 0 ? { unscaled, scale: s } : { unscaled: unscaled * pow10(-s), scale: 0 };
}

/** `trunc(numeric, n)`: toward zero to n decimals, shown with exactly n (none when n < 0) */
export function trunc(a: PgNumeric, n: number): PgNumeric {
  const s = Math.max(-2000, Math.min(2000, Math.trunc(n)));
  if (s >= a.scale) return { unscaled: atScale(a, s), scale: s };
  const unscaled = a.unscaled / pow10(a.scale - s);   // BigInt division truncates toward zero
  return s >= 0 ? { unscaled, scale: s } : { unscaled: unscaled * pow10(-s), scale: 0 };
}

/** the integer square root of x ≥ 0, rounded down (Newton's method) */
function isqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let y = 1n << BigInt((x.toString(2).length >> 1) + 1);
  for (;;) { const z = (y + x / y) >> 1n; if (z >= y) return y; y = z; }
}

/** `sqrt_var` of a non-negative numeric at `rscale` decimals: the exact root rounded half up there (numeric.c computes
 *  it truncated past rscale, then round_var rounds) */
export function sqrt(a: PgNumeric, rscale: number): PgNumeric {
  // √(u / 10^s) × 10^(r+1) = √(u × 10^(2r + 2 - s))
  const e = 2 * rscale + 2 - a.scale;
  const tenths = e >= 0 ? isqrt(a.unscaled * pow10(e)) : isqrt(a.unscaled / pow10(-e));
  return { unscaled: (tenths + 5n) / 10n, scale: rscale };
}

/** `numeric_stddev_internal`: stddev or variance (sample or population) from N, Σx and Σx², each exact, as Postgres
 *  computes them — the numerator N·Σx² − (Σx)² at twice Σx's scale, zero when not positive; the quotient by N(N−1) or N²
 *  at the division's scale; its square root at that scale. Null for no row, or one row of a sample. */
export function stddev(n: PgNumeric, sumX: PgNumeric, sumX2: PgNumeric, sample: boolean, variance: boolean): PgNumeric | null {
  const count = n.unscaled / pow10(n.scale);
  if (count === 0n || (sample && count <= 1n)) return null;
  const rscale = sumX.scale * 2;
  const numerator = sub(round(mul(n, sumX2), rscale), round(mul(sumX, sumX), rscale));
  if (numerator.unscaled <= 0n) return { unscaled: 0n, scale: 0 };
  const denominator: PgNumeric = { unscaled: sample ? count * (count - 1n) : count * count, scale: 0 };
  const quotient = div(numerator, denominator);
  return variance ? quotient : sqrt(quotient, quotient.scale);
}

/** `numeric_mod`: the remainder of the quotient truncated to an integer, with the sign of the dividend, at the larger
 *  scale; a zero divisor is 22012 */
export function mod(a: PgNumeric, b: PgNumeric): PgNumeric {
  if (b.unscaled === 0n) throw new NumericError("division by zero", "22012");
  const scale = Math.max(a.scale, b.scale);
  return { unscaled: atScale(a, scale) % atScale(b, scale), scale };
}

/** `floor` / `ceil` of a numeric: an integer, scale 0 */
export function floor(a: PgNumeric): PgNumeric {
  const d = pow10(a.scale);
  const q = a.unscaled / d;
  return { unscaled: a.unscaled < 0n && q * d !== a.unscaled ? q - 1n : q, scale: 0 };
}
export function ceil(a: PgNumeric): PgNumeric {
  const d = pow10(a.scale);
  const q = a.unscaled / d;
  return { unscaled: a.unscaled > 0n && q * d !== a.unscaled ? q + 1n : q, scale: 0 };
}

/** the order of two numerics by value (`1.50` and `1.5` are equal) */
export function compare(a: PgNumeric, b: PgNumeric): number {
  const scale = Math.max(a.scale, b.scale);
  const x = atScale(a, scale), y = atScale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A cast to `numeric(p, s)`: rounded as `round` rounds, refused as Postgres refuses (22003) a value of absolute value
 *  10^(p - s) or more — `apply_typmod`'s count of the digits from the first significant one to the point, which is
 *  negative below 1, so a scale above the precision (Postgres 15+) is held too: `0.5::numeric(2, 3)` overflows. */
export function withTypmod(a: PgNumeric, precision: number, scale: number): PgNumeric {
  const r = round(a, scale);
  const maxDigits = precision - scale;
  const digits = r.unscaled === 0n ? null : abs(r.unscaled).toString().length - r.scale;
  if (digits !== null && digits > maxDigits) {
    const o = fieldOverflow(precision, scale);
    throw new NumericError(o.message, "22003", null, o.detail);
  }
  return r;
}

/** `numeric_send`: ndigits, weight, sign (0x0000 positive, 0x4000 negative), dscale, then each base-10000 group, all
 *  16-bit big-endian. */
export function numericBinary(n: PgNumeric): Buffer {
  const g = groups(n);
  const b = Buffer.alloc(8 + 2 * g.digits.length);
  b.writeInt16BE(g.digits.length, 0);
  b.writeInt16BE(g.weight, 2);
  b.writeUInt16BE(n.unscaled < 0n ? 0x4000 : 0x0000, 4);
  b.writeInt16BE(n.scale, 6);
  g.digits.forEach((d, i) => b.writeInt16BE(d, 8 + 2 * i));
  return b;
}

/** A binary-format `numeric` parameter (`numeric_recv`'s layout, the inverse of `numericBinary`), as its text. */
export function numericFromBinary(bytes: Buffer): string {
  if (bytes.length < 8) throw new NumericError(`incorrect binary data format: ${bytes.length} byte(s) for numeric`, "22P03");
  const ndigits = bytes.readInt16BE(0), weight = bytes.readInt16BE(2), sign = bytes.readUInt16BE(4), scale = bytes.readInt16BE(6);
  if (bytes.length !== 8 + 2 * ndigits || ndigits < 0 || scale < 0 || (sign !== 0 && sign !== 0x4000)) {
    throw new NumericError(`incorrect binary data format: ${bytes.length} byte(s), ${ndigits} digit group(s), sign 0x${sign.toString(16)} for numeric`, "22P03");
  }
  // the groups as one integer, then placed by the weight: the value is that integer × 10000^(weight - ndigits + 1)
  let u = 0n;
  for (let i = 0; i < ndigits; i++) {
    const d = bytes.readInt16BE(8 + 2 * i);
    if (d < 0 || d > 9999) throw new NumericError(`invalid digit group ${d} in a binary numeric`, "22P03");
    u = u * 10000n + BigInt(d);
  }
  const e = DEC_DIGITS * (weight - ndigits + 1);   // u × 10^e
  const unscaled = e + scale >= 0 ? u * pow10(e + scale) : divRound(u, pow10(-(e + scale)));
  return numericText({ unscaled: sign === 0x4000 ? -unscaled : unscaled, scale });
}

/** A numeric text that is a WHOLE NUMBER (`42`, `42.00`, `1e3`), as that integer; null for a fraction or a text that is
 *  no numeric. How a numeric parameter keeps its digits on both paths (a whole number is bound as one). */
export function wholeNumberOf(text: string): bigint | null {
  let n: PgNumeric;
  try { n = parseNumeric(text); } catch (e) { if (e instanceof NumericError) return null; throw e; }
  const unit = pow10(n.scale);
  return n.unscaled % unit === 0n ? n.unscaled / unit : null;
}

/** A value the answer carries as a numeric: a decimal text (a 64-bit integer as digits, a numeric's own text) or a safe
 *  integer; a fractional JavaScript number has no scale, so it is refused rather than guessed. */
export function numericOf(value: unknown): PgNumeric {
  if (typeof value === "string") return parseNumeric(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return { unscaled: BigInt(value), scale: 0 };
  throw new NumericError(`cannot read ${JSON.stringify(value)} as an exact numeric: not a decimal text or an integer the number holds exactly`, "XX000");
}

// ---------------------------------------------------------------------------------------------------------------------
// WHAT IS A NUMERIC: the one rule of a result's Postgres type, for both paths

/** The Postgres API's number types (src/api/postgres/schema.ts PgApiType, the subset a rule here reads or writes). */
export type PgNumberType = "int2" | "int4" | "int8" | "float4" | "float8" | "numeric";

const INTEGER: ReadonlySet<string> = new Set(["int2", "int4", "int8"]);
const FLOAT: ReadonlySet<string> = new Set(["float4", "float8"]);

/**
 * THE TYPE OF AN AGGREGATE, by its argument — Postgres's own table (pg_aggregate): `count` is a bigint; `sum` of a
 * smallint or an integer is a bigint, of a bigint a NUMERIC, of a real a real, of a double precision a double
 * precision; `avg` of any integer is a NUMERIC and of a float a double precision; a percentile is a double precision;
 * `min` / `max` the argument's own type. Null where Postgres has no such aggregate (a sum of a text). A float argument
 * here includes a source `numeric` column, which this API sends as double precision (the declared divergence): its
 * sum and average follow the column's type on this API.
 */
export function aggregateType(agg: "count" | "count_distinct" | "sum" | "average" | "min" | "max" | "percentile", arg: string | null): string | null {
  switch (agg) {
    case "count": case "count_distinct": return "int8";
    case "sum":
      if (arg === null) return null;
      if (arg === "int2" || arg === "int4") return "int8";
      if (arg === "int8" || arg === "numeric") return "numeric";
      return FLOAT.has(arg) ? arg : null;
    case "average":
      // an argument of no known type (a metric's `sql:` expression) may hold a float: a float8, whose digits nobody
      // claims, never a numeric the answer may not have the digits of
      if (arg === null) return "float8";
      if (INTEGER.has(arg) || arg === "numeric") return "numeric";
      return FLOAT.has(arg) ? "float8" : null;
    case "percentile": return arg === null || INTEGER.has(arg) || FLOAT.has(arg) || arg === "numeric" ? "float8" : null;
    case "min": case "max": return arg;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// AN EXACT VALUE, AS A PROGRAM OVER THE ANSWER'S CELLS

/**
 * HOW A RESULT COLUMN'S NUMERIC IS COMPUTED from the answer's row: the cells ClickHouse computes exactly (integers:
 * a sum, a count, integer arithmetic) and the literals of the statement, combined as Postgres combines numerics. The
 * body path's average is `div(cell sum, cell count)`; the unrouted path's `round(sum(x) / 100.0, 2)` is
 * `round(div(cell, literal 100.0), 2)`. A NULL cell makes the whole value NULL, as every numeric operator is strict.
 */
export type NumericProgram =
  | { op: "cell"; key: string }
  | { op: "literal"; text: string }
  | { op: "add" | "sub" | "mul" | "div"; args: [NumericProgram, NumericProgram] }
  | { op: "neg"; arg: NumericProgram }
  | { op: "round"; arg: NumericProgram; scale: number }
  | { op: "typmod"; arg: NumericProgram; precision: number; scale: number }
  | { op: "trunc"; arg: NumericProgram; scale: number }
  | { op: "mod"; args: [NumericProgram, NumericProgram] }
  | { op: "abs" | "floor" | "ceil"; arg: NumericProgram }
  /** at least `scale` decimals, never rounded: the display scale Postgres's types give a value DuckDB holds with fewer
   *  (a numeric(65,30) copied as DECIMAL(38,2), its sum) */
  | { op: "pad"; arg: NumericProgram; scale: number }
  /** the scale the ROWS decide, `scale` an integer program (a sum's: the most decimals a value summed has, numeric.c's
   *  add_var keeping the larger dscale): the value at it, padded, or its trailing zeros dropped — never a digit that is
   *  not zero (the value as it is then: a scale that would cut it is not this value's) */
  | { op: "rescale"; arg: NumericProgram; scale: NumericProgram }
  /** GREATEST / LEAST: the value itself (its own scale), NULLs skipped; COALESCE: the first that is not NULL */
  | { op: "greatest" | "least" | "coalesce"; args: NumericProgram[] }
  /** stddev / variance of an integer or a numeric from its count, sum and sum of squares (numeric_stddev_internal) */
  | { op: "stddev"; args: [NumericProgram, NumericProgram, NumericProgram]; sample: boolean; variance: boolean }
  /** CASE: `index` is the arm the row took (an integer), and only that arm is computed, as Postgres computes only it;
   *  an index past the arms (a CASE with no ELSE) is NULL */
  | { op: "pick"; index: NumericProgram; args: NumericProgram[] };

/** The cells a program reads. */
export function cellsOf(p: NumericProgram): string[] {
  switch (p.op) {
    case "cell": return [p.key];
    case "literal": return [];
    case "add": case "sub": case "mul": case "div": case "mod": return [...cellsOf(p.args[0]), ...cellsOf(p.args[1])];
    case "neg": case "round": case "typmod": case "trunc": case "abs": case "floor": case "ceil": case "pad": return cellsOf(p.arg);
    case "greatest": case "least": case "coalesce": case "stddev": return p.args.flatMap(cellsOf);
    case "pick": return [...cellsOf(p.index), ...p.args.flatMap(cellsOf)];
    case "rescale": return [...cellsOf(p.arg), ...cellsOf(p.scale)];
  }
}

/** The value of a program over one row, or null; throws NumericError where Postgres raises (a division by zero). */
export function evaluate(p: NumericProgram, row: Readonly<Record<string, unknown>>): PgNumeric | null {
  switch (p.op) {
    case "cell": {
      const v = row[p.key];
      return v === null || v === undefined ? null : numericOf(v);
    }
    case "literal": return parseNumeric(p.text);
    case "neg": { const a = evaluate(p.arg, row); return a === null ? null : { unscaled: -a.unscaled, scale: a.scale }; }
    case "round": { const a = evaluate(p.arg, row); return a === null ? null : round(a, p.scale); }
    case "typmod": { const a = evaluate(p.arg, row); return a === null ? null : withTypmod(a, p.precision, p.scale); }
    case "trunc": { const a = evaluate(p.arg, row); return a === null ? null : trunc(a, p.scale); }
    case "pad": { const a = evaluate(p.arg, row); return a === null || a.scale >= p.scale ? a : { unscaled: a.unscaled * pow10(p.scale - a.scale), scale: p.scale }; }
    case "rescale": {
      const a = evaluate(p.arg, row), s = evaluate(p.scale, row);
      if (a === null || s === null || s.scale !== 0 || s.unscaled < 0n) return a;
      const to = Number(s.unscaled);
      if (to >= a.scale) return { unscaled: a.unscaled * pow10(to - a.scale), scale: to };
      const by = pow10(a.scale - to);
      return a.unscaled % by === 0n ? { unscaled: a.unscaled / by, scale: to } : a;
    }
    case "abs": { const a = evaluate(p.arg, row); return a === null ? null : { unscaled: abs(a.unscaled), scale: a.scale }; }
    case "floor": { const a = evaluate(p.arg, row); return a === null ? null : floor(a); }
    case "ceil": { const a = evaluate(p.arg, row); return a === null ? null : ceil(a); }
    case "coalesce": { for (const x of p.args) { const v = evaluate(x, row); if (v !== null) return v; } return null; }
    case "greatest": case "least": {
      let best: PgNumeric | null = null;
      for (const x of p.args) {
        const v = evaluate(x, row);
        if (v !== null && (best === null || (p.op === "greatest" ? compare(v, best) > 0 : compare(v, best) < 0))) best = v;
      }
      return best;
    }
    case "mod": {
      const a = evaluate(p.args[0], row), b = evaluate(p.args[1], row);
      return a === null || b === null ? null : mod(a, b);
    }
    case "pick": {
      const i = evaluate(p.index, row);
      const arm = i === null || i.scale !== 0 ? undefined : p.args[Number(i.unscaled)];
      return arm === undefined ? null : evaluate(arm, row);
    }
    case "stddev": {
      const [n, x, x2] = p.args.map((a) => evaluate(a, row));
      return n === null || n === undefined || x === null || x === undefined || x2 === null || x2 === undefined ? null : stddev(n, x, x2, p.sample, p.variance);
    }
    default: {
      const a = evaluate(p.args[0], row), b = evaluate(p.args[1], row);
      if (a === null || b === null) return null;
      return p.op === "add" ? add(a, b) : p.op === "sub" ? sub(a, b) : p.op === "mul" ? mul(a, b) : div(a, b);
    }
  }
}

/** a numeric's special values, as numeric_out writes them (a text read by numeric_in may be one) */
const SPECIAL = /^(NaN|-?Infinity)$/;

/** A special value the program passes through whole (a cell, padded or under a typmod), else undefined; arithmetic on
 *  one is refused by name (Postgres's NaN and ±Infinity rules are not this module's). */
function specialOf(p: NumericProgram, row: Readonly<Record<string, unknown>>): string | undefined {
  if (p.op === "cell") { const v = row[p.key]; return typeof v === "string" && SPECIAL.test(v) ? v : undefined; }
  if (p.op === "pad" || p.op === "rescale") return specialOf(p.arg, row);
  // the arm the row took (a special value in another is never read, as Postgres computes only the taken arm)
  if (p.op === "pick") {
    const i = evaluate(p.index, row);
    const arm = i === null || i.scale !== 0 ? undefined : p.args[Number(i.unscaled)];
    return arm === undefined ? undefined : specialOf(arm, row);
  }
  if (p.op === "typmod") {
    const v = specialOf(p.arg, row);
    if (v !== undefined && v !== "NaN") { const o = fieldOverflow(p.precision, p.scale, true); throw new NumericError(o.message, "22003", null, o.detail); }
    return v;
  }
  for (const key of cellsOf(p)) {
    const v = row[key];
    if (typeof v === "string" && SPECIAL.test(v)) throw new NumericError(`arithmetic on a numeric NaN or Infinity is not supported by Mason (${gapMark("numeric-special")})`, "0A000", "numeric-special");
  }
  return undefined;
}

/** The program's value as `numeric_out` writes it, or null. */
export const evaluateText = (p: NumericProgram, row: Readonly<Record<string, unknown>>): string | null => {
  const special = specialOf(p, row);
  if (special !== undefined) return special;
  const v = evaluate(p, row);
  return v === null ? null : numericText(v);
};
