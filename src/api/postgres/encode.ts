/**
 * HOW A VALUE CROSSES THE POSTGRES WIRE: the `pg_type` OIDs of the types this API sends (src/api/postgres/schema.ts
 * `PG_API_TYPES`) and ONE encoder per type, text and binary, held to what Postgres itself writes byte for byte by
 * tests/postgres-api/encode.test.ts. A value arrives as Mason's Query
 * API carries it in JSON — a number, a boolean, or a string: a 64-bit integer past 2^53 as decimal digits, a time as an
 * ISO instant (`2026-09-24T23:58:01.412Z`), a date as `2026-09-24`, a UUID, text, a JSON column's text — and leaves as
 * the bytes a client expects of that Postgres type. Nothing here reads a table, a schema or a socket; the server
 * chooses the type from the catalog and the format from the client's Bind.
 *
 * THE RULES THIS EMBODIES:
 *  - A value the type cannot take THROWS, naming the value and the type (`1.5` for int8, `2026-02-30`, a UUID with a
 *    letter past f, a time with nanoseconds): a best effort would be a wrong number a client believes. A NULL is not
 *    an encoder's: the DataRow writes it as -1 (`encodeValue` answers null for it).
 *  - FLOATS ARE PRINTED AS POSTGRES PRINTS THEM, not as JavaScript does. Postgres's `float8out` (at the default
 *    `extra_float_digits = 1`) is its Ryu port, src/common/d2s.c: the SHORTEST decimal that reads back as the same
 *    double, in a `%g`-shaped layout — fixed notation when the decimal exponent is in [-4, 15) (`100`, `0.0001`,
 *    `123456789012345`), else `d[.ddd]e±XX` with the sign always written and at least two exponent digits (`1e+15`,
 *    `1e-05`, `5e-324`, `1.7976931348623157e+308`); `-0`, `NaN`, `Infinity`, `-Infinity`. JavaScript's `String(x)`
 *    has the same digits but another layout (`1e21` / `100000000000000000000` where Postgres writes `1e+21` / `1e+20`).
 *    One difference is in the DIGITS: Postgres compiles d2s.c without STRICTLY_SHORTEST, so its `acceptBounds` is
 *    false and a decimal sitting EXACTLY on the half-ulp boundary of the double is never printed, where JavaScript
 *    prints it when the mantissa is even (round-half-even reads it back). So `1e23` is `9.999999999999999e+22` in
 *    Postgres and `1.25e22` is `1.2499999999999999e+22` (verified on PGlite with the same 64 bits sent in binary).
 *    `shortestInside` below does what d2s.c does: the shortest decimal STRICTLY inside the interval, the closest one
 *    when two of that length are, with exact BigInt arithmetic. A `float4` is the same over the float's own interval
 *    with the fixed range [-4, 6) (f2s.c: FLT_DIG), its digits the shortest that read back as the same FLOAT, which
 *    JavaScript has no function for — the search runs from one digit.
 *  - A `timestamptz` is rendered in the SESSION'S ZONE (§4.6: `SET TimeZone` is the request's `timezone`), as
 *    `YYYY-MM-DD HH:MM:SS[.ffffff]±HH[:MM[:SS]]` with the fraction's trailing zeros trimmed and the offset spelled as
 *    Postgres spells it: hours alone when the minutes are zero (`+00`, `-04`), with the minutes otherwise
 *    (`+05:30`), and with the seconds for the local-mean-time offsets tzdata holds before standard time
 *    (`+05:53:28` for Kolkata in 1800). The zone's rules come from `Intl.DateTimeFormat` (ICU's copy of tzdata: no
 *    dependency), which agrees with Postgres to the second on every case the harness runs. A year past 9999 is
 *    written with five digits as Postgres writes it; a wall-clock year before 1 (an instant Postgres would print with
 *    ` BC`) is refused: no ClickHouse time reaches it.
 *  - A `numeric` is EXACT or it is not sent as one (src/lib/pg-numeric.ts decides which values are): it arrives as its
 *    decimal text, computed with Postgres's own scale and rounding, and leaves as `numeric_out` writes it (every digit
 *    of its scale, trailing zeros kept) or as `numeric_send`'s base-10000 groups. A fractional JavaScript number has no
 *    scale and is refused: a value read as a float is a `float8`.
 *  - A `timestamp` WITHOUT time zone (OID 1114) is sent for ONE thing: a bucket of a zone's wall clock
 *    (`date_trunc('<unit>', t AT TIME ZONE '<zone>')`, Cube's granularity; translate.ts `ResultColumn.wallClock`). No
 *    copied column is one. The server hands it the wall clock the body's bucket is in its zone (server.ts
 *    `wallClockOf`: `2026-10-08T00:00:00`, with no zone marker — a value with one is refused, it would be an instant),
 *    rendered as Postgres renders a timestamp, `YYYY-MM-DD HH:MM:SS[.ffffff]` with no offset, in every session zone
 *    alike; the binary is the wall clock's microseconds from 2000-01-01 as if it were UTC, which is how Postgres counts
 *    a timestamp (`timestamp_send`).
 *  - A `jsonb`'s text is sent AS STORED, and that is a DECLARED DIVERGENCE: Postgres's `jsonb` canonicalises its
 *    text on input (keys sorted shortest-first then bytewise, duplicates dropped, one space after `:` and `,`,
 *    an escape such as `\u00e9` written as the character, `1e2` written `100`; the number's own scale is kept, `2.50` stays `2.50`), so `$1::jsonb`
 *    answers `{"a": 2, "b": 1}` for `{"b":1,"a":2}`. A column that was `jsonb` at the source replicates in that
 *    canonical form already (Postgres wrote it), so it IS byte-equal; a `json` column's text is the application's
 *    own, and is sent as such — the harness asserts both: byte-equal for canonical text, and that non-canonical
 *    text is what Postgres would NOT write. The binary format is a version byte 0x01 and the text.
 */
import { Buffer } from "node:buffer";
import type { PgApiType } from "./schema.ts";
import { numericBinary, numericOf, numericText, NumericError, type PgNumeric } from "../../lib/pg-numeric.ts";
import type { FieldDescription } from "./protocol.ts";
import type { GapId } from "../../duck/gaps.ts";

export interface PgOid {
  oid: number;
  /** `pg_type.typlen`: -1 for variable length */
  size: number;
  /** the OID of the array type, what a catalog's `typarray` says */
  arrayOid: number;
}

/** The real `pg_type` OIDs: a client maps them to its own types by number, never by name. */
export const OID: Record<PgApiType, PgOid> = {
  int2: { oid: 21, size: 2, arrayOid: 1005 },
  int4: { oid: 23, size: 4, arrayOid: 1007 },
  int8: { oid: 20, size: 8, arrayOid: 1016 },
  float4: { oid: 700, size: 4, arrayOid: 1021 },
  float8: { oid: 701, size: 8, arrayOid: 1022 },
  numeric: { oid: 1700, size: -1, arrayOid: 1231 },
  text: { oid: 25, size: -1, arrayOid: 1009 },
  bool: { oid: 16, size: 1, arrayOid: 1000 },
  uuid: { oid: 2950, size: 16, arrayOid: 2951 },
  date: { oid: 1082, size: 4, arrayOid: 1182 },
  timestamptz: { oid: 1184, size: 8, arrayOid: 1185 },
  jsonb: { oid: 3802, size: -1, arrayOid: 3807 },
};

/** `timestamp` without time zone: sent for a wall-clock bucket alone (the docblock), never a column's or a parameter's type. */
export const TIMESTAMP: PgOid = { oid: 1114, size: 8, arrayOid: 1115 };

/** A type a result column is sent as: a column's or a metric's own, or the wall-clock bucket's `timestamp`. */
export type WireType = PgApiType | "timestamp";

/** the OID entry of a wire type */
export const wireOid = (type: WireType): PgOid => type === "timestamp" ? TIMESTAMP : OID[type];

/** The RowDescription entry of a result column of `type`, in the format the client asked for. */
export function fieldOf(name: string, type: WireType, format: 0 | 1): FieldDescription {
  const o = wireOid(type);
  return { name, typeOid: o.oid, typeSize: o.size, typeModifier: -1, format };
}

/** What the encoders need of the session: the zone a timestamptz is displayed in. */
export interface PgSession {
  /** an IANA name, or `UTC` */
  timeZone: string;
}

/** One cell as JSON carries it: the form a value arrives in to be encoded (the header). */
export type ApiValue = string | number | boolean;

/** A value the type cannot take. The message names both; the server answers it as an error on the statement. */
export class EncodeError extends Error {
  /** the SQLSTATE Postgres raises for the same value (a timestamp past its range is 22008), else XX000: Mason's gap */
  readonly code: string;
  /** the registry entry that refused the value (src/duck/gaps.ts): the request log's `gap`; null for any other error */
  readonly gap: GapId | null;
  constructor(message: string, code = "XX000", gap: GapId | null = null) { super(message); this.code = code; this.gap = gap; }
}

const refuse = (type: WireType, value: unknown, why: string): never => {
  throw new EncodeError(`cannot send ${JSON.stringify(value)} as ${type}: ${why}`);
};

// ---------------------------------------------------------------------------------------------------------------------
// Integers

const INT_RANGE: Record<"int2" | "int4" | "int8", [bigint, bigint]> = {
  int2: [-(2n ** 15n), 2n ** 15n - 1n],
  int4: [-(2n ** 31n), 2n ** 31n - 1n],
  int8: [-(2n ** 63n), 2n ** 63n - 1n],
};

/** A number that is a safe integer, or a string of decimal digits (what the API carries past 2^53), within the type. */
function integerOf(type: "int2" | "int4" | "int8", value: ApiValue): bigint {
  let n: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return refuse(type, value, "not an integer the number can hold exactly (past 2^53 it is carried as a string)");
    n = BigInt(value);
  } else if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    n = BigInt(value);
  } else {
    return refuse(type, value, "not an integer");
  }
  const [lo, hi] = INT_RANGE[type];
  if (n < lo || n > hi) return refuse(type, value, `out of range (${lo} to ${hi})`);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Floats: Postgres's shortest-inside-the-interval digits, in its %g-shaped layout.

type FloatKind = "float4" | "float8";

/** A float as `m × 2^q` with the shape of its rounding interval: scaled by four, the interval is
 *  `(4m - lowGap, 4m + 2) × 2^(q-2)`, where the low gap is 1 (half the usual) at a power of two, whose lower
 *  neighbour is twice as close — Ryu's `mmShift`. */
interface Decomposed { m: bigint; q: number; lowGap: 1n | 2n }

function decompose(x: number, kind: FloatKind): Decomposed {
  if (kind === "float8") {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x);
    const bits = b.readBigUInt64BE();
    const E = Number((bits >> 52n) & 0x7ffn);
    const F = bits & ((1n << 52n) - 1n);
    if (E === 0) return { m: F, q: -1074, lowGap: 2n };
    return { m: F | (1n << 52n), q: E - 1075, lowGap: F !== 0n || E <= 1 ? 2n : 1n };
  }
  const b = Buffer.alloc(4);
  b.writeFloatBE(x);
  const bits = b.readUInt32BE();
  const E = (bits >>> 23) & 0xff;
  const F = BigInt(bits & 0x7fffff);
  if (E === 0) return { m: F, q: -149, lowGap: 2n };
  return { m: F | (1n << 23n), q: E - 150, lowGap: F !== 0n || E <= 1 ? 2n : 1n };
}

/** The sign of `D × 10^e − K × 2^s`, exactly. */
function cmpDecimalBinary(D: bigint, e: number, K: bigint, s: number): number {
  let a = D;
  let b = K;
  if (e >= 0) a *= 10n ** BigInt(e); else b *= 10n ** BigInt(-e);
  if (s >= 0) b <<= BigInt(s); else a <<= BigInt(-s);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A decimal `D × 10^e` with D of `p` digits: the closest such to x (`toExponential` is correctly rounded), and the
 *  one on the other side of x, when x is not that decimal exactly. */
function candidatesAt(x: number, p: number, d: Decomposed): { D: bigint; e: number }[] {
  const s = x.toExponential(p - 1);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) throw new Error(`toExponential gave ${JSON.stringify(s)} for ${x}`);
  const digits = m[1]! + (m[2] ?? "");
  const e = Number(m[3]) - (p - 1);
  const D = BigInt(digits);
  const side = cmpDecimalBinary(D, e, d.m, d.q);
  if (side === 0) return [{ D, e }];
  if (side < 0) return [{ D, e }, { D: D + 1n, e }];
  // D is above x. The p-digit decimal just below it is D - 1 at the same exponent, unless D is a power of ten:
  // below 100 the p-digit grid is finer (99.9, not 99).
  if (D === 10n ** BigInt(p - 1)) return [{ D: 10n ** BigInt(p) - 1n, e: e - 1 }, { D, e }];
  return [{ D: D - 1n, e }, { D, e }];
}

/** The significant digits of JavaScript's own shortest spelling: where the search for a double starts, since the
 *  interval JavaScript searches contains Postgres's, so Postgres's answer is never shorter. */
function jsShortestLength(x: number): number {
  const s = String(x).replace(/^-/, "").replace(/e.*$/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return Math.max(1, s.length);
}

/** Postgres's digits for a finite, non-zero float: the shortest decimal strictly inside its rounding interval,
 *  the closest to it among those (ties to an even last digit), as `digits × 10^e` with no trailing zero. */
function shortestInside(x: number, kind: FloatKind): { digits: string; e: number } {
  const abs = Math.abs(x);
  const d = decompose(abs, kind);
  const X = 4n * d.m;
  const U = X + 2n;
  const L = X - d.lowGap;
  const inside = (c: { D: bigint; e: number }): boolean =>
    cmpDecimalBinary(c.D, c.e, L, d.q - 2) > 0 && cmpDecimalBinary(c.D, c.e, U, d.q - 2) < 0;
  const pMax = kind === "float8" ? 17 : 9;
  for (let p = kind === "float8" ? jsShortestLength(abs) : 1; p <= pMax; p++) {
    const fits = candidatesAt(abs, p, d).filter(inside);
    let pick: { D: bigint; e: number } | undefined;
    if (fits.length === 1) pick = fits[0];
    else if (fits.length === 2) {
      const [lo, hi] = fits as [{ D: bigint; e: number }, { D: bigint; e: number }];
      // Which is closer: compare the candidates' midpoint with x (2x = X × 2^(q-1)); exact, so a tie is a tie.
      const eMin = Math.min(lo.e, hi.e);
      const sum = lo.D * 10n ** BigInt(lo.e - eMin) + hi.D * 10n ** BigInt(hi.e - eMin);
      const mid = cmpDecimalBinary(sum, eMin, X, d.q - 1);
      pick = mid < 0 ? hi : mid > 0 ? lo : (lo.D % 2n === 0n ? lo : hi);
    }
    if (pick !== undefined) {
      let { D, e } = pick;
      while (D % 10n === 0n) { D /= 10n; e++; }
      return { digits: D.toString(), e };
    }
  }
  throw new Error(`no decimal of up to ${pMax} digits reads back as ${x}: the float decomposition is wrong`);
}

/** d2s.c's `to_chars`: fixed notation for a decimal exponent in [-4, DIG), else exponential with a signed,
 *  two-digit-minimum exponent. */
function floatLayout(neg: boolean, digits: string, e: number, kind: FloatKind): string {
  const olength = digits.length;
  const exp = e + olength - 1;
  const sign = neg ? "-" : "";
  if (exp >= -4 && exp < (kind === "float8" ? 15 : 6)) {
    if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
    if (olength <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - olength)}`;
    return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  const mantissa = olength > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const expAbs = String(Math.abs(exp)).padStart(2, "0");
  return `${sign}${mantissa}e${exp < 0 ? "-" : "+"}${expAbs}`;
}

/** What Postgres prints for a float, under the default `extra_float_digits` (1 since Postgres 12). */
export function formatFloat(x: number, kind: FloatKind): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const { digits, e } = shortestInside(x, kind);
  return floatLayout(x < 0, digits, e, kind);
}

const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const FLOAT_SPECIAL: Record<string, number> = {
  nan: NaN, inf: Infinity, "+inf": Infinity, "-inf": -Infinity, infinity: Infinity, "+infinity": Infinity, "-infinity": -Infinity,
};

/** A number, or a string Postgres's float input would read (digits, or NaN / Infinity in any case). A float4 is the
 *  value rounded to a float, as the column holds it. */
function floatOf(kind: FloatKind, value: ApiValue): number {
  let x: number;
  if (typeof value === "number") x = value;
  else if (typeof value === "string" && FLOAT_TEXT.test(value)) x = Number(value);
  else if (typeof value === "string" && value.toLowerCase() in FLOAT_SPECIAL) x = FLOAT_SPECIAL[value.toLowerCase()]!;
  else return refuse(kind, value, "not a number");
  return kind === "float4" ? Math.fround(x) : x;
}

/** a numeric's special values as numeric_out writes them, with numeric_send's sign word for each */
const NUMERIC_SPECIAL: ReadonlyMap<unknown, number> = new Map([["NaN", 0xC000], ["Infinity", 0xD000], ["-Infinity", 0xF000]]);

/** An exact numeric as the answer carries it — a decimal text (the value a program computed, src/lib/pg-numeric.ts, or a
 *  64-bit integer as digits) or a safe integer — at the scale its text shows. */
function exactOf(value: ApiValue): PgNumeric {
  try {
    return numericOf(value);
  } catch (err) {
    // numericOf throws exactly NumericError, naming the value: the encoder's refusal says the same
    if (err instanceof NumericError) return refuse("numeric", value, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates and times. Postgres counts a date in days and a timestamptz in microseconds from 2000-01-01 (UTC).

const PG_EPOCH_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86_400_000;

/** The UTC milliseconds of a wall clock, for any year (`Date.UTC` alone reads a year under 100 as 19xx). */
function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
}

/** Whether a wall clock is a real one: the components read back unchanged (no 31st of April, no 25th hour). */
function isRealClock(ms: number, y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const t = new Date(ms);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
}

/** the last year a JavaScript Date holds whole (Postgres's timestamps go to 294276; a year past 9999 is written with
 *  its digits, as Postgres writes it: `138921-05-09`) */
const LAST_YEAR = 275759;

const DATE_TEXT = /^(\d{4,6})-(\d{2})-(\d{2})$/;

function dateOf(value: ApiValue): { text: string; days: number } {
  const m = typeof value === "string" ? DATE_TEXT.exec(value) : null;
  if (!m) return refuse("date", value, "not a YYYY-MM-DD date");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return refuse("date", value, "there is no year 0");
  if (y > LAST_YEAR) return refuse("date", value, `after the year ${LAST_YEAR}, the last this server can write`);
  const ms = utcMs(y, mo, d);
  if (!isRealClock(ms, y, mo, d, 0, 0, 0)) return refuse("date", value, "not a day of the calendar");
  return { text: value as string, days: (ms - PG_EPOCH_MS) / MS_PER_DAY };
}

const INSTANT_TEXT = /^(\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|\+00(?::?00)?)?$/;

/** An ISO instant as the API writes it (`2026-09-24T23:58:01.412Z`), as UTC milliseconds and the microseconds past
 *  the millisecond. A naive one, or one at `+00:00`, is UTC too: every time on this API is (§4.8). */
function instantOf(value: ApiValue): { ms: number; micros: number } {
  const m = typeof value === "string" ? INSTANT_TEXT.exec(value) : null;
  if (!m) return refuse("timestamptz", value, "not an ISO instant (YYYY-MM-DDTHH:MM:SS[.ffffff]Z)");
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const frac = m[7] ?? "";
  if (frac.length > 6) return refuse("timestamptz", value, "finer than a microsecond, which Postgres cannot carry");
  if (y < 1) return refuse("timestamptz", value, "there is no year 0");
  if (y > LAST_YEAR) return refuse("timestamptz", value, `after the year ${LAST_YEAR}, the last this server can write`);
  const ms = utcMs(y, mo, d, h, mi, s);
  if (!isRealClock(ms, y, mo, d, h, mi, s)) return refuse("timestamptz", value, "not a time of the calendar");
  const micros = Number(frac.padEnd(6, "0"));
  return { ms: ms + Math.floor(micros / 1000), micros: micros % 1000 };
}

const WALL_CLOCK_TEXT = /^(\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/** A wall clock with no zone marker (`2026-10-08T00:00:00`, what `wallClockOf` makes of a bucket), as the milliseconds
 *  it would be as UTC and the microseconds past the millisecond: a timestamp's own count. */
function wallClockOf(value: ApiValue): { ms: number; micros: number } {
  const m = typeof value === "string" ? WALL_CLOCK_TEXT.exec(value) : null;
  if (!m) return refuse("timestamp", value, "not a wall clock with no zone (YYYY-MM-DDTHH:MM:SS[.ffffff]); an instant is a timestamptz");
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const frac = m[7] ?? "";
  if (frac.length > 6) return refuse("timestamp", value, "finer than a microsecond, which Postgres cannot carry");
  if (y < 1) return refuse("timestamp", value, "there is no year 0");
  if (y > LAST_YEAR) return refuse("timestamp", value, `after the year ${LAST_YEAR}, the last this server can write`);
  const ms = utcMs(y, mo, d, h, mi, s);
  if (!isRealClock(ms, y, mo, d, h, mi, s)) return refuse("timestamp", value, "not a time of the calendar");
  const micros = Number(frac.padEnd(6, "0"));
  return { ms: ms + Math.floor(micros / 1000), micros: micros % 1000 };
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff]`: a timestamp as `EncodeDateTime` writes one under DateStyle ISO, no offset. */
function timestampText(value: ApiValue): string {
  const { ms, micros } = wallClockOf(value);
  const t = new Date(ms);
  const fraction = String((ms - Math.floor(ms / 1000) * 1000) * 1000 + micros).padStart(6, "0").replace(/0+$/, "");
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
    + (fraction === "" ? "" : `.${fraction}`);
}

/** One formatter per zone: constructing `Intl.DateTimeFormat` costs milliseconds, formatting microseconds. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", era: "short", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch (err) {
      // The one RangeError Intl throws here is an unknown zone name; the session should have refused it at SET.
      if (err instanceof RangeError) throw new EncodeError(`cannot render a timestamptz in time zone ${JSON.stringify(timeZone)}: ${err.message}`);
      throw err;
    }
    zoneFormatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of an instant in a zone, with the zone's offset at that instant in whole seconds (to the second:
 *  the local-mean-time offsets before standard time have them, and Postgres prints them). */
function wallClock(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; offsetSeconds: number; bc: boolean } {
  const parts: Record<string, string> = {};
  for (const p of zoneFormatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const [y, mo, d, h, mi, s] = [Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)];
  const bc = parts.era === "BC";
  const localSeconds = utcMs(bc ? 1 - y : y, mo, d, h, mi, s) / 1000;
  return { y, mo, d, h, mi, s, bc, offsetSeconds: localSeconds - Math.floor(ms / 1000) };
}

/** `+00`, `-04`, `+05:30`, `+05:53:28`: as `EncodeDateTime` spells a zone offset under DateStyle ISO. */
function offsetText(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const abs = Math.abs(offsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = Math.floor((abs % 3600) / 60);
  const ss = abs % 60;
  if (ss !== 0) return `${sign}${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  if (mm !== 0) return `${sign}${hh}:${String(mm).padStart(2, "0")}`;
  return `${sign}${hh}`;
}

function timestamptzText(value: ApiValue, session: PgSession): string {
  const { ms, micros } = instantOf(value);
  const w = wallClock(ms, session.timeZone);
  if (w.bc) return refuse("timestamptz", value, `before year 1 in time zone ${session.timeZone}`);
  const fraction = String((ms - Math.floor(ms / 1000) * 1000) * 1000 + micros).padStart(6, "0").replace(/0+$/, "");
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(w.y).padStart(4, "0")}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`
    + (fraction === "" ? "" : `.${fraction}`) + offsetText(w.offsetSeconds);
}

// ---------------------------------------------------------------------------------------------------------------------
// The rest

const UUID_TEXT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The canonical lower-case spelling, as `uuid_out` writes it whatever case came in. */
function uuidOf(value: ApiValue): string {
  if (typeof value !== "string" || !UUID_TEXT.test(value)) return refuse("uuid", value, "not a UUID (8-4-4-4-12 hex digits)");
  return value.toLowerCase();
}

function boolOf(value: ApiValue): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  return refuse("bool", value, "not a boolean");
}

/** Postgres's text holds no NUL byte (`invalid byte sequence for encoding "UTF8": 0x00`); ClickHouse's String does. */
function textOf(value: ApiValue): string {
  if (typeof value !== "string") return refuse("text", value, "not a string");
  if (value.includes("\0")) return refuse("text", value, "holds a NUL byte, which Postgres text cannot");
  return value;
}

/** A JSON column's text, as stored (the divergence the module docblock declares); refused when it is not JSON. */
function jsonbOf(value: ApiValue): string {
  if (typeof value !== "string") return refuse("jsonb", value, "not a JSON text");
  if (value.includes("\0")) return refuse("jsonb", value, "holds a NUL byte, which Postgres jsonb cannot");
  try {
    JSON.parse(value);
  } catch (err) {
    // JSON.parse throws exactly one thing, a SyntaxError naming the position; it becomes the refusal's reason.
    return refuse("jsonb", value, `not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// The encoders

/** The text format of a value: what `SELECT` prints, what psql shows. */
export function encodeText(type: WireType, value: ApiValue, session: PgSession): Buffer {
  switch (type) {
    case "timestamp": return Buffer.from(timestampText(value), "ascii");
    case "int2":
    case "int4":
    case "int8": return Buffer.from(integerOf(type, value).toString(), "ascii");
    case "float4":
    case "float8": return Buffer.from(formatFloat(floatOf(type, value), type), "ascii");
    case "numeric": return Buffer.from(NUMERIC_SPECIAL.has(value as string) ? value as string : numericText(exactOf(value)), "ascii");
    case "bool": return Buffer.from(boolOf(value) ? "t" : "f", "ascii");
    case "uuid": return Buffer.from(uuidOf(value), "ascii");
    case "date": return Buffer.from(dateOf(value).text, "ascii");
    case "timestamptz": return Buffer.from(timestamptzText(value, session), "ascii");
    case "text": return Buffer.from(textOf(value), "utf8");
    case "jsonb": return Buffer.from(jsonbOf(value), "utf8");
  }
}

/** The binary format of a value: what a client asks for with a result format code of 1 (JDBC on a server-prepared
 *  statement). The session's zone does not change an instant's bytes, only its text. */
export function encodeBinary(type: WireType, value: ApiValue, _session: PgSession): Buffer {
  switch (type) {
    case "timestamp": {
      const { ms, micros } = wallClockOf(value);
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(ms - PG_EPOCH_MS) * 1000n + BigInt(micros));
      return b;
    }
    case "int2": { const b = Buffer.alloc(2); b.writeInt16BE(Number(integerOf(type, value))); return b; }
    case "int4": { const b = Buffer.alloc(4); b.writeInt32BE(Number(integerOf(type, value))); return b; }
    case "int8": { const b = Buffer.alloc(8); b.writeBigInt64BE(integerOf(type, value)); return b; }
    case "float4": { const b = Buffer.alloc(4); b.writeFloatBE(floatOf(type, value)); return b; }
    case "float8": { const b = Buffer.alloc(8); b.writeDoubleBE(floatOf(type, value)); return b; }
    case "numeric": {
      // NaN and ±Infinity: no digits, the sign word says which (numeric_send's NUMERIC_NAN / PINF / NINF)
      const special = NUMERIC_SPECIAL.get(value as string);
      if (special !== undefined) { const b = Buffer.alloc(8); b.writeUInt16BE(special, 4); return b; }
      return numericBinary(exactOf(value));
    }
    case "bool": return Buffer.from([boolOf(value) ? 1 : 0]);
    case "uuid": return Buffer.from(uuidOf(value).replaceAll("-", ""), "hex");
    case "date": { const b = Buffer.alloc(4); b.writeInt32BE(dateOf(value).days); return b; }
    case "timestamptz": {
      const { ms, micros } = instantOf(value);
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(ms - PG_EPOCH_MS) * 1000n + BigInt(micros));
      return b;
    }
    case "text": return Buffer.from(textOf(value), "utf8");
    case "jsonb": return Buffer.concat([Buffer.from([1]), Buffer.from(jsonbOf(value), "utf8")]);
  }
}

/** One cell for a DataRow: null for SQL NULL (the API's `null`), else the bytes in the requested format. */
export function encodeValue(type: WireType, value: ApiValue | null | undefined, format: 0 | 1, session: PgSession): Buffer | null {
  if (value === null || value === undefined) return null;
  return format === 1 ? encodeBinary(type, value, session) : encodeText(type, value, session);
}
