/**
 * A DUCKDB RESULT COLUMN ON THE POSTGRES WIRE (the prototype, docs/DESIGN.md): the OID a column of a DuckDB
 * type is sent as, and its cells' bytes. Where the type is one of the Postgres API's own (src/api/postgres/encode.ts:
 * integers, floats, numeric, text, bool, uuid, date, timestamp, timestamptz, jsonb) the value is handed to THAT encoder,
 * text and binary, so a float, a numeric and a timestamptz are written exactly as the ClickHouse path writes them —
 * Postgres's own text. The rest (time, interval, bytea, arrays) are written here, text always, binary where it is
 * cheap; a binary request for one this file cannot write is refused naming it.
 *
 * A DuckDB type with no Postgres twin is sent as the nearest one and is a DIVERGENCE (decision 6 of the prototype's
 * design): HUGEINT (DuckDB's `sum` of an integer, where Postgres's is bigint or numeric) as numeric, a STRUCT / MAP /
 * UNION as its text. Each column that diverges carries the reason, and the runner logs it once per statement.
 */
import { Buffer } from "node:buffer";
import {
  DuckDBTypeId, type DuckDBType, type DuckDBValue, DuckDBDateValue, DuckDBTimestampValue, DuckDBTimestampTZValue,
  DuckDBDecimalValue, DuckDBUUIDValue, DuckDBListValue, DuckDBArrayValue, DuckDBIntervalValue, DuckDBBlobValue, DuckDBTimeValue,
  DuckDBListType, DuckDBArrayType, DuckDBTimestampSecondsValue, DuckDBTimestampMillisecondsValue, DuckDBTimestampNanosecondsValue,
} from "@duckdb/node-api";
import { jsonbText } from "./jsonb.ts";
import { EncodeError, encodeValue, OID, TIMESTAMP, type ApiValue, type PgSession, type WireType } from "../api/postgres/encode.ts";

/** One result column as the wire describes it, and how its cells are written. */
export interface WireColumn {
  name: string;
  oid: number;
  /** `pg_type.typlen` */
  size: number;
  /** the cell's bytes in the format asked, null for NULL */
  encode(value: DuckDBValue, format: 0 | 1, session: PgSession): Buffer | null;
  /** why this column's type is not what Postgres would send for the same SQL; null when it is the same */
  divergence: string | null;
}

const MICROS_PER_DAY = 86_400_000_000n;
const DATE_INFINITY = 2_147_483_647, DATE_NEG_INFINITY = -2_147_483_647;

const pad = (n: number | bigint, w = 2): string => String(n).padStart(w, "0");

/** days from 1970 as YYYY-MM-DD (proleptic Gregorian, the year 1 and after) */
function dayText(days: number): string {
  const d = new Date(days * 86_400_000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** the first day of year 1 (0001-01-01) from 1970: a day before it is a BC day, which encode.ts does not write */
const FIRST_AD_DAY = -719_162, FIRST_AD_MICROS = BigInt(FIRST_AD_DAY) * 86_400_000_000n;
const PG_EPOCH_DAYS = 10_957, PG_EPOCH_MICROS = 946_684_800_000_000n;
/** a BC day as Postgres writes it: the year counted back from 1 (astronomical 0 is 1 BC), `4713-11-24 BC` */
function bcDay(days: number): string {
  const d = new Date(days * 86_400_000);
  return `${pad(1 - d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** a BC timestamp's text: its day, its time, ` BC` (a timestamptz's in UTC, `+00` before the era) */
function bcTimestampText(micros: bigint, zoned: boolean): string {
  const day = -((-micros + MICROS_PER_DAY - 1n) / MICROS_PER_DAY);
  const rest = micros - day * MICROS_PER_DAY;
  const secs = rest / 1_000_000n, frac = rest % 1_000_000n;
  const time = `${pad(secs / 3600n)}:${pad((secs % 3600n) / 60n)}:${pad(secs % 60n)}${frac === 0n ? "" : `.${pad(frac, 6).replace(/0+$/, "")}`}`;
  return `${bcDay(Number(day))} ${time}${zoned ? "+00" : ""} BC`;
}

/** micros from 1970 as the wall clock `YYYY-MM-DDTHH:MM:SS.ffffff` (what encode.ts reads for a timestamp) */
function wallText(micros: bigint): string {
  const day = micros >= 0n ? micros / MICROS_PER_DAY : -((-micros + MICROS_PER_DAY - 1n) / MICROS_PER_DAY);
  const rest = micros - day * MICROS_PER_DAY;
  const secs = rest / 1_000_000n, frac = rest % 1_000_000n;
  return `${dayText(Number(day))}T${pad(secs / 3600n)}:${pad((secs % 3600n) / 60n)}:${pad(secs % 60n)}${frac === 0n ? "" : `.${pad(frac, 6)}`}`;
}

/** A column sent through the Postgres API's own encoder: the DuckDB value turned into what that encoder reads. */
function viaApi(name: string, type: WireType, toApi: (v: DuckDBValue) => ApiValue | null, divergence: string | null = null): WireColumn {
  const o = type === "timestamp" ? TIMESTAMP : OID[type];
  return { name, oid: o.oid, size: o.size, divergence, encode: (v, format, s) => v === null ? null : encodeValue(type, toApi(v), format, s) };
}

const str = (v: DuckDBValue): string => typeof v === "string" ? v : String(v);
const bigintText = (v: DuckDBValue): string => String(v);

function dateApi(v: DuckDBValue): string {
  if (!(v instanceof DuckDBDateValue)) throw new EncodeError(`expected a date, got ${String(v)}`);
  return dayText(v.days);
}

/** A date: through encode.ts, but for ±infinity, which Postgres has and encode.ts refuses */
function dateColumn(name: string): WireColumn {
  const base = viaApi(name, "date", dateApi);
  return {
    ...base,
    encode: (v, format, s) => {
      if (v instanceof DuckDBDateValue && (v.days >= DATE_INFINITY || v.days <= DATE_NEG_INFINITY)) {
        const pos = v.days > 0;
        if (format === 0) return Buffer.from(pos ? "infinity" : "-infinity", "ascii");
        const b = Buffer.alloc(4); b.writeInt32BE(pos ? 2_147_483_647 : -2_147_483_648); return b;
      }
      if (v instanceof DuckDBDateValue && v.days < FIRST_AD_DAY) {
        if (format === 0) return Buffer.from(`${bcDay(v.days)} BC`, "ascii");
        const b = Buffer.alloc(4); b.writeInt32BE(v.days - PG_EPOCH_DAYS); return b;
      }
      return base.encode(v, format, s);
    },
  };
}

function timestampMicros(v: DuckDBValue): bigint {
  if (v instanceof DuckDBTimestampValue || v instanceof DuckDBTimestampTZValue) return v.micros;
  if (v instanceof DuckDBTimestampSecondsValue) return v.seconds * 1_000_000n;
  if (v instanceof DuckDBTimestampMillisecondsValue) return v.millis * 1000n;
  if (v instanceof DuckDBTimestampNanosecondsValue) return v.nanos / 1000n;
  throw new EncodeError(`expected a timestamp, got ${String(v)}`);
}

/** ±infinity of a timestamp: DuckDB's max/min micros, Postgres's 'infinity' */
const TS_INFINITY = 9_223_372_036_854_775_807n, TS_NEG_INFINITY = -9_223_372_036_854_775_807n;
/** Postgres's timestamp range in Unix micros (MIN_TIMESTAMP and END_TIMESTAMP count from 2000-01-01, 946,684,800 s
 *  after 1970-01-01) */
const TS_MIN = -211_813_488_000_000_000n + 946_684_800_000_000n, TS_END = 9_223_371_331_200_000_000n + 946_684_800_000_000n;

function timestampColumn(name: string, tz: boolean): WireColumn {
  const base = viaApi(name, tz ? "timestamptz" : "timestamp", (v) => tz ? `${wallText(timestampMicros(v))}Z` : wallText(timestampMicros(v)));
  return {
    ...base,
    encode: (v, format, s) => {
      if (v === null) return null;
      const m = timestampMicros(v);
      if (m >= TS_INFINITY || m <= TS_NEG_INFINITY) {
        if (format === 0) return Buffer.from(m > 0n ? "infinity" : "-infinity", "ascii");
        const b = Buffer.alloc(8); b.writeBigInt64BE(m > 0n ? TS_INFINITY : -TS_INFINITY - 1n); return b;
      }
      // DuckDB's range is wider than Postgres's (4714-11-24 BC to 294276 AD), where Postgres raises its error
      if (m < TS_MIN || m >= TS_END) throw new EncodeError("timestamp out of range", "22008");
      if (m < FIRST_AD_MICROS) {
        if (format === 1) { const b = Buffer.alloc(8); b.writeBigInt64BE(m - PG_EPOCH_MICROS); return b; }
        // a zone's offset before year 1 is its local mean time, which Mason does not compute
        if (tz && s.timeZone.toUpperCase() !== "UTC") throw new EncodeError(`Mason writes a timestamptz before year 1 only in UTC, not in ${s.timeZone} (Mason gap bc-timestamptz-zone)`, "0A000");
        return Buffer.from(bcTimestampText(m, tz), "ascii");
      }
      return base.encode(v, format, s);
    },
  };
}

/** `HH:MM:SS[.ffffff]` of micros since midnight */
function timeText(micros: bigint): string {
  const secs = micros / 1_000_000n, frac = micros % 1_000_000n;
  return `${pad(secs / 3600n)}:${pad((secs % 3600n) / 60n)}:${pad(secs % 60n)}${frac === 0n ? "" : `.${pad(frac, 6).replace(/0+$/, "")}`}`;
}

/** An interval as Postgres's `interval_out` writes it under IntervalStyle postgres: `1 year 2 mons 3 days 04:05:06.7` */
export function intervalText(months: number, days: number, micros: bigint): string {
  const parts: string[] = [];
  const years = Math.trunc(months / 12), mons = months % 12;
  // EncodeInterval: a field after a negative one says its sign, `-1 mons +1 day`
  let before = false;
  const unit = (n: number, one: string, many: string): void => {
    if (n !== 0) { parts.push(`${before && n > 0 ? "+" : ""}${n} ${n === 1 ? one : many}`); before = n < 0; }
  };
  unit(years, "year", "years"); unit(mons, "mon", "mons"); unit(days, "day", "days");
  if (micros !== 0n || parts.length === 0) {
    const neg = micros < 0n;
    const abs = neg ? -micros : micros;
    const t = timeText(abs);
    parts.push(neg ? `-${t}` : before ? `+${t}` : t);
  }
  return parts.join(" ");
}

/** An element of a Postgres array literal: quoted when array_out would quote it */
/** inet_out: `10.3.6.45` for `10.3.6.45/32`, `::1` for `::1/128`; a partial mask stays */
export function inetOut(text: string): string {
  const m = /^(.*)\/(\d+)$/.exec(text);
  if (m === null) return text;
  const full = m[1]!.includes(":") ? 128 : 32;
  return Number(m[2]) === full ? m[1]! : text;
}

/** inet_send: the family (2 IPv4, 3 IPv6), the mask's bits, is_cidr (0), the address's length, its bytes */
export function inetBytes(text: string): Buffer {
  const m = /^(.*?)(?:\/(\d+))?$/.exec(text)!;
  const addr = m[1]!, v6 = addr.includes(":");
  const bits = m[2] !== undefined ? Number(m[2]) : v6 ? 128 : 32;
  const ipv4 = (s: string): number[] => {
    const parts = s.split(".").map(Number);
    if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new EncodeError(`an inet Mason cannot read: ${JSON.stringify(text)}`);
    return parts;
  };
  let bytes: number[];
  if (!v6) bytes = ipv4(addr);
  else {
    const [head, tail] = addr.split("::") as [string, string | undefined];
    const words = (s: string): number[] => s === "" ? [] : s.split(":").flatMap((w, i, all) => {
      // an embedded IPv4 as the last group (`::ffff:10.3.6.45`)
      if (w.includes(".") && i === all.length - 1) { const b = ipv4(w); return [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!]; }
      if (!/^[0-9a-fA-F]{1,4}$/.test(w)) throw new EncodeError(`an inet Mason cannot read: ${JSON.stringify(text)}`);
      return [parseInt(w, 16)];
    });
    const h = words(head), t = tail === undefined ? [] : words(tail);
    if (h.length + t.length > 8 || (tail === undefined && h.length !== 8)) throw new EncodeError(`an inet Mason cannot read: ${JSON.stringify(text)}`);
    const all = [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
    bytes = all.flatMap((w) => [w >> 8, w & 255]);
  }
  return Buffer.from([v6 ? 3 : 2, bits, 0, bytes.length, ...bytes]);
}

function arrayElement(text: string | null): string {
  if (text === null) return "NULL";
  if (text === "" || /^null$/i.test(text) || /[{},"\\\s]/.test(text)) return `"${text.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  return text;
}

/** Postgres's array OIDs of the element OIDs this file sends */
const ARRAY_OID: Record<number, number> = {
  16: 1000, 17: 1001, 20: 1016, 21: 1005, 23: 1007, 25: 1009, 700: 1021, 701: 1022, 1082: 1182, 1083: 1183,
  1114: 1115, 1184: 1185, 1186: 1187, 1700: 1231, 2950: 2951, 3802: 3807,
};

function custom(name: string, oid: number, size: number, text: (v: DuckDBValue, s: PgSession) => string, binary: ((v: DuckDBValue, s: PgSession) => Buffer) | null, divergence: string | null = null): WireColumn {
  return {
    name, oid, size, divergence,
    encode: (v, format, s) => {
      if (v === null) return null;
      if (format === 0) return Buffer.from(text(v, s), "utf8");
      if (binary === null) throw new EncodeError(`column ${JSON.stringify(name)} (type OID ${oid}) cannot be sent in binary by Mason's prototype: ask for text`);
      return binary(v, s);
    },
  };
}

/**
 * An array in binary, as array_send writes it: its dimensions (none for an empty one), whether an element is NULL, the
 * element's OID, each dimension's length and lower bound (1), then each element as its length (-1 for NULL) and its own
 * binary form. pgjdbc asks for text[], int4[], float8[] … in binary once a statement has run prepareThreshold times.
 */
function arrayBinary(items: readonly DuckDBValue[], element: WireColumn, s: PgSession): Buffer {
  const parts = items.map((x) => x === null ? null : element.encode(x, 1, s));
  const head = Buffer.alloc(items.length === 0 ? 12 : 20);
  head.writeInt32BE(items.length === 0 ? 0 : 1, 0);
  head.writeInt32BE(parts.some((p) => p === null) ? 1 : 0, 4);
  head.writeInt32BE(element.oid, 8);
  if (items.length > 0) { head.writeInt32BE(items.length, 12); head.writeInt32BE(1, 16); }
  return Buffer.concat([head, ...parts.flatMap((p) => {
    const len = Buffer.alloc(4);
    len.writeInt32BE(p === null ? -1 : p.length);
    return p === null ? [len] : [len, p];
  })]);
}

/**
 * The wire column of a DuckDB result column. `session` is what an ELEMENT of an array is written in (a timestamptz
 * array's elements in the session's zone): the array column's encoder receives its own session at each call.
 */
export function wireColumn(name: string, t: DuckDBType): WireColumn {
  switch (t.typeId) {
    case DuckDBTypeId.BOOLEAN: return viaApi(name, "bool", (v) => v as boolean);
    case DuckDBTypeId.TINYINT: case DuckDBTypeId.SMALLINT: case DuckDBTypeId.UTINYINT: return viaApi(name, "int2", (v) => v as number);
    case DuckDBTypeId.INTEGER: case DuckDBTypeId.USMALLINT: return viaApi(name, "int4", (v) => v as number);
    case DuckDBTypeId.BIGINT: case DuckDBTypeId.UINTEGER: return viaApi(name, "int8", bigintText);
    case DuckDBTypeId.HUGEINT: case DuckDBTypeId.UHUGEINT: case DuckDBTypeId.UBIGINT: case DuckDBTypeId.BIGNUM:
      return viaApi(name, "numeric", bigintText, `DuckDB's ${t.toString()} (a sum of integers is one), sent as numeric: Postgres says bigint for a sum of int4 and numeric for a sum of int8`);
    case DuckDBTypeId.FLOAT: return viaApi(name, "float4", (v) => v as number);
    case DuckDBTypeId.DOUBLE: return viaApi(name, "float8", (v) => v as number);
    case DuckDBTypeId.DECIMAL: return viaApi(name, "numeric", (v) => (v as DuckDBDecimalValue).toString());
    case DuckDBTypeId.VARCHAR:
      return t.alias === "JSON" ? viaApi(name, "jsonb", str) : viaApi(name, "text", str);
    case DuckDBTypeId.ENUM: return viaApi(name, "text", str);
    case DuckDBTypeId.UUID: return viaApi(name, "uuid", (v) => (v as DuckDBUUIDValue).toString());
    case DuckDBTypeId.DATE: return dateColumn(name);
    case DuckDBTypeId.TIMESTAMP: case DuckDBTypeId.TIMESTAMP_S: case DuckDBTypeId.TIMESTAMP_MS: case DuckDBTypeId.TIMESTAMP_NS:
      return timestampColumn(name, false);
    case DuckDBTypeId.TIMESTAMP_TZ: return timestampColumn(name, true);
    case DuckDBTypeId.TIME:
      return custom(name, 1083, 8, (v) => timeText((v as DuckDBTimeValue).micros), (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE((v as DuckDBTimeValue).micros); return b; });
    case DuckDBTypeId.INTERVAL:
      return custom(name, 1186, 16, (v) => { const i = v as DuckDBIntervalValue; return intervalText(i.months, i.days, i.micros); },
        (v) => { const i = v as DuckDBIntervalValue; const b = Buffer.alloc(16); b.writeBigInt64BE(i.micros, 0); b.writeInt32BE(i.days, 8); b.writeInt32BE(i.months, 12); return b; });
    case DuckDBTypeId.BLOB:
      return custom(name, 17, -1, (v) => `\\x${Buffer.from((v as DuckDBBlobValue).bytes).toString("hex")}`, (v) => Buffer.from((v as DuckDBBlobValue).bytes));
    case DuckDBTypeId.LIST: case DuckDBTypeId.ARRAY: {
      const child = t instanceof DuckDBListType || t instanceof DuckDBArrayType ? t.valueType : null;
      if (child === null) break;
      const element = wireColumn(name, child);
      const oid = ARRAY_OID[element.oid];
      if (oid === undefined || child.typeId === DuckDBTypeId.LIST || child.typeId === DuckDBTypeId.ARRAY) break;
      const itemsOf = (v: DuckDBValue): readonly DuckDBValue[] => v instanceof DuckDBListValue || v instanceof DuckDBArrayValue ? v.items : [];
      // an array's elements, each as its own column would write it (a timestamptz in the session's zone)
      return custom(name, oid, -1,
        (v, s) => `{${itemsOf(v).map((x) => arrayElement(x === null ? null : element.encode(x, 0, s)!.toString("utf8"))).join(",")}}`,
        (v, s) => arrayBinary(itemsOf(v), element, s), element.divergence);
    }
    default: break;
  }
  return custom(name, 25, -1, (v) => String(v), null, `DuckDB's ${t.toString()} has no Postgres type here: sent as its text`);
}

// ---------------------------------------------------------------------------------------------------------------------
// A COLUMN OF POSTGRES'S TYPE (docs/DESIGN.md "Postgres decides, DuckDB computes"): the catalog Postgres's
// analysis says what each result column IS (its OID and typmod: `length()` is an integer, `extract` a numeric, a
// `varchar(20)` column a varchar), and DuckDB's value is written as THAT type — the digits of DuckDB's BIGINT as an
// int4, its DECIMAL as a numeric, its JSON as jsonb's canonical text. Where DuckDB's value cannot be written as
// Postgres's type (a timestamp where Postgres says date), DuckDB's own encoding stands and the column says why.

/** pg_type.typlen of the OIDs a result column may have */
const TYPLEN: Record<number, number> = { 16: 1, 18: 1, 19: 64, 20: 8, 21: 2, 23: 4, 26: 4, 700: 4, 701: 8, 1082: 4, 1083: 8, 1114: 8, 1184: 8, 1186: 16, 2950: 16 };
const PG_TEXT = new Set([25, 1043, 1042, 19, 18]);
const PG_INT: Record<number, "int2" | "int4" | "int8"> = { 21: "int2", 23: "int4", 20: "int8" };
const DUCK_EXACT = new Set<DuckDBTypeId>([DuckDBTypeId.TINYINT, DuckDBTypeId.SMALLINT, DuckDBTypeId.INTEGER, DuckDBTypeId.BIGINT, DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UTINYINT, DuckDBTypeId.USMALLINT, DuckDBTypeId.UINTEGER, DuckDBTypeId.UBIGINT, DuckDBTypeId.UHUGEINT, DuckDBTypeId.DECIMAL, DuckDBTypeId.BIGNUM]);
const DUCK_FLOAT = new Set<DuckDBTypeId>([DuckDBTypeId.FLOAT, DuckDBTypeId.DOUBLE]);

/** an exact DuckDB number's decimal text */
const exactText = (v: DuckDBValue): string => v instanceof DuckDBDecimalValue ? v.toString() : String(v);

/** a decimal's text with at least `scale` decimals (never rounded) */
export function padDecimals(text: string, scale: number): string {
  if (scale <= 0 || !/^-?\d+(\.\d*)?$/.test(text)) return text;
  const point = text.indexOf(".");
  const have = point < 0 ? 0 : text.length - point - 1;
  return have >= scale ? text : `${point < 0 ? `${text}.` : text}${"0".repeat(scale - have)}`;
}

/** a double as Postgres's float8 → numeric cast writes it: 15 significant digits (`float8_numeric`, DBL_DIG; a
 *  float4's is 6, FLT_DIG) */
export function floatAsNumeric(x: number, digits = 15): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
  const g = x.toPrecision(digits);
  // positional, trailing zeros of the fraction dropped as %g drops them
  const [mant, exp] = g.split("e");
  let s = mant!.includes(".") ? mant!.replace(/0+$/, "").replace(/\.$/, "") : mant!;
  if (exp !== undefined) {
    const e = Number(exp);
    const neg = s.startsWith("-");
    const digits = s.replace("-", "").replace(".", "");
    const point = s.replace("-", "").indexOf(".") < 0 ? s.replace("-", "").length : s.replace("-", "").indexOf(".");
    const at = point + e;
    s = at <= 0 ? `0.${"0".repeat(-at)}${digits}` : at >= digits.length ? digits + "0".repeat(at - digits.length) : `${digits.slice(0, at)}.${digits.slice(at)}`;
    s = (neg ? "-" : "") + s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  return s === "-0" ? "0" : s;
}

/** The wire column of a result column whose Postgres type the analysis gave, holding DuckDB values of type `t`. */
export function pgTypedColumn(name: string, oid: number, t: DuckDBType, typmod = -1): WireColumn {
  const own = wireColumn(name, t);
  const size = TYPLEN[oid] ?? -1;
  const retyped = (c: WireColumn): WireColumn => ({ ...c, name, oid, size, divergence: null });
  // a numeric(p, s) column's every value has s decimals in Postgres; DuckDB may hold it with fewer (src/duck/sync.ts
  // copies a numeric(65,30) at the decimals its values use)
  if (oid === 1700 && typmod >= 4 && DUCK_EXACT.has(t.typeId)) return retyped(viaApi(name, "numeric", (v) => padDecimals(exactText(v), (typmod - 4) & 0xffff)));
  if (own.oid === oid) return retyped(own);
  // an inet: stored as Postgres's text with its mask (`10.3.6.45/32`), sent as inet_out writes it (a full mask dropped)
  if (oid === 869 && own.oid === 25) return custom(name, 869, -1, (v) => inetOut(str(v)), (v) => inetBytes(str(v)));
  // a type an extension made that DuckDB holds as text (citext), or an array of one: its bytes, under the source's OID
  if (oid >= 16384 && (own.oid === 25 || own.oid === 1009)) return retyped(own);
  // an anonymous row (record) is its text, written by record_out's rules (src/duck/functions.ts recordText)
  if (oid === 2249 && own.oid === 25) return retyped(own);
  // an array of inet: each element as inet_out writes it
  if (oid === 1041 && own.oid === 1009) {
    const items = (v: DuckDBValue): readonly DuckDBValue[] => v instanceof DuckDBListValue || v instanceof DuckDBArrayValue ? v.items : [];
    return custom(name, 1041, -1, (v) => `{${items(v).map((x) => arrayElement(x === null ? null : inetOut(str(x)))).join(",")}}`, null);
  }
  // an array of varchar, char(n) or name is DuckDB's VARCHAR[]: the same elements, Postgres's array type
  if ((oid === 1015 || oid === 1014 || oid === 1003) && own.oid === 1009) return retyped(own);
  // an array of json: each element's text as it is; of jsonb: each element's canonical text
  if ((oid === 199 || oid === 3807) && (own.oid === 3807 || own.oid === 1009)) {
    const items = (v: DuckDBValue): readonly DuckDBValue[] => v instanceof DuckDBListValue || v instanceof DuckDBArrayValue ? v.items : [];
    return custom(name, oid, -1, (v) => `{${items(v).map((x) => arrayElement(x === null ? null : oid === 3807 ? jsonbText(str(x)) : str(x))).join(",")}}`, null);
  }
  if (PG_TEXT.has(oid)) {
    // any DuckDB value Postgres calls text: DuckDB's text of it (a varchar's bytes are the same in both formats)
    return { name, oid, size, divergence: null, encode: (v, format, s) => v === null ? null : own.oid === 25 ? own.encode(v, format, s) : own.encode(v, 0, s) };
  }
  if (oid === 3802 && (own.oid === 25 || own.oid === 3802)) return viaApi(name, "jsonb", (v) => jsonbText(str(v)));
  if (oid === 114 && (own.oid === 25 || own.oid === 3802)) return custom(name, 114, -1, str, (v) => Buffer.from(str(v), "utf8"));
  const pgInt = PG_INT[oid];
  if (pgInt !== undefined && (DUCK_EXACT.has(t.typeId) || DUCK_FLOAT.has(t.typeId))) return retyped(viaApi(name, pgInt, (v) => DUCK_FLOAT.has(t.typeId) ? Number(v) : exactText(v)));
  if ((oid === 700 || oid === 701) && DUCK_EXACT.has(t.typeId)) return retyped(viaApi(name, oid === 700 ? "float4" : "float8", (v) => Number(exactText(v))));
  if (oid === 1700 && DUCK_EXACT.has(t.typeId)) return retyped(viaApi(name, "numeric", exactText));
  if (oid === 1700 && DUCK_FLOAT.has(t.typeId)) {
    // a double that overflowed is Postgres's numeric overflow (its exact arithmetic raises it)
    return { ...retyped(viaApi(name, "numeric", (v) => { if (v === Infinity || v === -Infinity) throw new EncodeError("value overflows numeric format", "22003"); return floatAsNumeric(v as number); })), divergence: `Postgres computes this numeric exactly; DuckDB computed it as a double (${t.toString()}), sent with 15 significant digits` };
  }
  return { ...own, divergence: `Postgres says type OID ${oid}; DuckDB computed ${t.toString()}, sent as its own type` };
}

/** How a cell of an exact numeric (src/duck/rewrite.ts ExactColumn) reads as a decimal text, by DuckDB's type: an exact
 *  number's digits, a float as Postgres's cast to numeric writes it — or null where the cell needs digits DuckDB did not
 *  keep (a double where the program wants exact ones). */
export function cellText(t: DuckDBType, conv: "exact" | "float8" | "float4" | "text"): ((v: DuckDBValue) => string) | null {
  // a numeric's text as Postgres's numeric_out wrote it (a text read by numeric_in, src/duck/pg-eval.ts)
  if (conv === "text") return t.typeId === DuckDBTypeId.VARCHAR ? (v) => String(v) : null;
  if (DUCK_EXACT.has(t.typeId)) return exactText;
  if (DUCK_FLOAT.has(t.typeId) && conv !== "exact") return (v) => floatAsNumeric(Number(v), conv === "float4" ? 6 : 15);
  // a NULL-only cell (DuckDB types it as its own NULL type)
  if (t.typeId === DuckDBTypeId.SQLNULL) return exactText;
  return null;
}

/** A computed exact column: its value is the program's decimal text, written as Postgres's numeric or as text. */
export function exactColumn(name: string, oid: number): WireColumn {
  return oid === 1700 ? { ...viaApi(name, "numeric", str), name, size: -1 } : { ...viaApi(name, "text", str), name, oid, size: TYPLEN[oid] ?? -1 };
}

/** pg_type.typlen of a result column's OID (-1 for a variable-length one) */
export const pgTyplen = (oid: number): number => TYPLEN[oid] ?? -1;
