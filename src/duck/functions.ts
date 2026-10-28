/**
 * POSTGRES'S FUNCTIONS WHERE DUCKDB'S ANSWER DIFFERENTLY (docs/DESIGN.md "Postgres decides, DuckDB computes"):
 * what the rewrite (src/duck/rewrite.ts) calls in place of a DuckDB function that gives another answer, or of a
 * Postgres function DuckDB has none of. Two kinds:
 *  - SCALAR FUNCTIONS in JavaScript (`registerFunctions`, once per DuckDB instance: a registered function is the
 *    instance's, every connection sees it). JSON is the main one: DuckDB's JSON functions parse a value and write it
 *    again (`7.00` comes back `7.0`, `{"a" : 1}` as `{"a":1}`), where Postgres's `json` keeps the text it was given and
 *    `jsonb` writes it canonically (src/duck/jsonb.ts) — so every read of a json value is done here, on its text;
 *  - and the array functions a lambda would build from DuckDB's (the deparser cannot print a lambda, and DuckDB 2.0
 *    binds a lambda MACRO's constant arguments wrongly once its postgres extension is loaded: no macro is used).
 * Every name is `__mason_*`, which no Postgres function has.
 */
import { BIGINT, BLOB, BOOLEAN, DATE, DOUBLE, DuckDBBlobValue, DuckDBDateValue, DuckDBIntervalValue, DuckDBScalarFunction, DuckDBTimestampTZValue, DuckDBTimestampValue, INTEGER, INTERVAL, LIST, TIMESTAMP, TIMESTAMPTZ, VARCHAR, listValue, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { pgEvalSync, PgEvalError } from "./pg-eval.ts";
import { libcKept, libcKey, type LibcOrder } from "./libc-order.ts";
import { formatFloat } from "../api/postgres/encode.ts";
import { floatAsNumeric } from "./types.ts";
import { intervalText } from "./types.ts";
import { jsonbText, parseJson, writeJson, quoteJson, type Json } from "./jsonb.ts";
import { jsonbKey, jsonbLibcKept, jsonbStrings } from "./jsonb-order.ts";
import { compare, div, evaluateText, NumericError, numericText, parseNumeric, type NumericProgram } from "../lib/pg-numeric.ts";
import { toCharNumber, toCharTime } from "./to-char.ts";
import { atTimeZoneOf } from "../lib/timezone.ts";
import { gapMark } from "./gaps.ts";
import { CANCEL_SLOTS, cancelTable, isCancelled, slotOf } from "./cancel.ts";

/** How the source database changes a letter's case: glibc's (towupper per character), ICU's (full mappings: `ß` is
 *  `SS`), or the C locale's (ASCII letters only). */
export type CaseMode = "libc" | "icu" | "ascii";

// ------------------------------------------------------------------------------------------------- case mapping

/** one character's simple mapping, as towupper / towlower give it: a character whose full mapping is several (`ß`,
 *  `ŉ`) keeps itself */
function simple(ch: string, upper: boolean): string {
  const m = upper ? ch.toUpperCase() : ch.toLowerCase();
  return [...m].length === 1 ? m : ch;
}

const ASCII_ALNUM = /^[A-Za-z0-9]$/;
const ALNUM = /^[\p{L}\p{N}]$/u;

/** upper() / lower() as Postgres computes them under that mode (libc's upper is the rewrite's SQL, not this) */
export function pgCase(s: string, upper: boolean, mode: CaseMode): string {
  if (mode === "icu") return upper ? s.toUpperCase() : s.toLowerCase();
  if (mode === "ascii") return s.replace(upper ? /[a-z]+/g : /[A-Z]+/g, (x) => upper ? x.toUpperCase() : x.toLowerCase());
  let out = "";
  for (const ch of s) out += simple(ch, upper);
  return out;
}

/** initcap(): a letter after a letter or a digit is lowered, every other is raised (Postgres's str_initcap) */
export function initcap(s: string, mode: CaseMode): string {
  let out = "", was = false;
  for (const ch of s) {
    if (mode === "ascii") out += was ? ch.replace(/[A-Z]/, (c) => c.toLowerCase()) : ch.replace(/[a-z]/, (c) => c.toUpperCase());
    else if (mode === "icu") out += was ? ch.toLowerCase() : ch.toUpperCase();
    else out += simple(ch, !was);
    was = (mode === "ascii" ? ASCII_ALNUM : ALNUM).test(ch);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- json reads

/** A step of a json read: a key of an object, or an index of an array (negative from the end); `either` is a `#>`
 *  path's element, which is a key of an object and, read as an integer, an index of an array. */
type Step = { key: string } | { index: number } | { either: string };

/**
 * A `#>` PATH ELEMENT AS AN ARRAY INDEX, as Postgres reads one (jsonfuncs.c get_path_all and jsonb_get_element: `strtoint`
 * in base 10, nothing after the digits): white space before it, a sign (`+` or `-`), digits — `' 1'` and `'+1'` are 1,
 * `'1 '` is no index (on an array its read is NULL; on an object every element is a key); a number outside int4 is none.
 * null where the element is not an index. THE ONE DEFINITION: the function's step reads it, and the native read
 * (src/duck/rewrite.ts jsonGet) leaves to the function every element that is one (tests/conventions.test.ts).
 */
export function pathIndex(element: string): number | null {
  if (!/^[ \t\n\v\f\r]*[+-]?[0-9]+$/.test(element)) return null;
  const n = Number(element.trim());
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

function step(v: Json, s: Step): Json | null {
  if ("key" in s || ("either" in s && v.t === "obj")) {
    if (v.t !== "obj") return null;
    const k = "key" in s ? s.key : s.either;
    // a duplicate key: its LAST value (jsonb keeps only that one; json's -> reads the last)
    for (let i = v.v.length - 1; i >= 0; i--) if (v.v[i]![0] === k) return v.v[i]![1];
    return null;
  }
  if (v.t !== "arr") return null;
  let i: number;
  if ("index" in s) i = s.index;
  else { const n = pathIndex(s.either); if (n === null) return null; i = n; }
  if (i < 0) i += v.v.length;
  return i >= 0 && i < v.v.length ? v.v[i]! : null;
}

/** a json value as text: `->>`'s (a string unquoted, a JSON null is SQL NULL), else its json text — jsonb's
 *  canonical one, or json's as the document has it */
function valueText(source: string, v: Json, canonical: boolean, asText: boolean): string | null {
  if (asText) {
    if (v.t === "null") return null;
    if (v.t === "str") return v.v;
    if (v.t === "num" && canonical) return numericText(parseNumeric(v.text));
  }
  return canonical ? writeJson(v) : source.slice(v.start, v.end);
}

/** `->` / `->>` / `#>` / `#>>` / json(b)_extract_path(_text): the value at the steps, or null */
export function jsonGet(text: string, steps: readonly Step[], canonical: boolean, asText: boolean): string | null {
  let v: Json | null = parseJson(text);
  for (const s of steps) {
    // a jsonb scalar is stored as a one-element array: `'"s"'::jsonb -> 0` (and `-> -1`) is the scalar itself
    if (canonical && "index" in s && v.t !== "arr" && v.t !== "obj" && (s.index === 0 || s.index === -1)) continue;
    v = step(v, s);
    if (v === null) return null;
  }
  return valueText(text, v, canonical, asText);
}

/**
 * A STORED JSON PATH'S VALUE (src/duck/kept.ts): what `jsonGet` answers for the path's `->` read (the value's JSON
 * text), computed once when the row is written, `KEPT_NULL` where that answer is NULL, or `KEPT_RECOMPUTE` where it
 * cannot stand in for the read — `jsonGet` raised (the read raises it again, as the statement without the stored value
 * would), or the answer begins with a NUL (never a JSON text's first character; kept for any other caller). The
 * column's own NULL is a row not stored yet (its default: an ADD COLUMN that writes no value, src/duck/kept.ts `keep`),
 * so a NULL answer is the mark, and SQL turns a NULL document's answer into it (`keptValueSql`). Never throws: a write
 * of the copy (the stream's, the poll's) must not fail over one row's JSON.
 */
export const KEPT_NULL = "\u0000";
export const KEPT_RECOMPUTE = "\u0000!";
export function keptJsonValue(text: string, steps: readonly Step[], canonical: boolean, asText: boolean): string {
  let v: string | null;
  try { v = jsonGet(text, steps, canonical, asText); }
  catch { return KEPT_RECOMPUTE; }   // the read raises it, with its own words: nothing to store but the mark
  return v === null ? KEPT_NULL : v.startsWith(KEPT_NULL) ? KEPT_RECOMPUTE : v;
}

/** json(b)_array_elements(_text): each element's text; an array only (Postgres refuses a scalar or an object) */
export function jsonElements(text: string, canonical: boolean, asText: boolean): Array<string | null> {
  const v = parseJson(text);
  if (v.t !== "arr") throw new Error(v.t === "obj" ? "cannot extract elements from an object" : "cannot extract elements from a scalar");
  return v.v.map((x) => valueText(text, x, canonical, asText));
}

/** json(b)_each(_text): each member's key and value text, in the document's order (jsonb's is its canonical one) */
export function jsonMembers(text: string, canonical: boolean, asText: boolean): Array<[string, string | null]> {
  const v = parseJson(canonical ? jsonbText(text) : text);
  if (v.t !== "obj") throw new Error(v.t === "arr" ? "cannot call json_each on an array" : "cannot deconstruct a scalar");
  const src = canonical ? jsonbText(text) : text;
  return v.v.map(([k, x]) => [k, valueText(src, x, canonical, asText)]);
}

/** jsonb's `-` of a key: an object without it, an array without its string elements equal to it */
export function jsonbDelete(text: string, key: string): string {
  const v = parseJson(text);
  if (v.t === "obj") return writeJson({ t: "obj", v: v.v.filter(([k]) => k !== key) } as Json);
  if (v.t === "arr") return writeJson({ t: "arr", v: v.v.filter((x) => !(x.t === "str" && x.v === key)) } as Json);
  throw new Error("cannot delete from scalar");
}

/** jsonb's `||`: two objects merged (the right's keys win), else both as arrays, concatenated (jsonb_concat) */
export function jsonbConcat(a: string, b: string): string {
  const x = parseJson(a), y = parseJson(b);
  if (x.t === "obj" && y.t === "obj") return writeJson({ t: "obj", v: [...x.v, ...y.v] } as Json);
  const items = (j: Json): Json[] => j.t === "arr" ? j.v : [j];
  return writeJson({ t: "arr", v: [...items(x), ...items(y)] } as Json);
}

/** jsonb_strip_nulls: every object member whose value is null, removed, at every depth (an array's nulls stay) */
export function jsonbStripNulls(text: string): string {
  const strip = (j: Json): Json => j.t === "obj" ? { t: "obj", v: j.v.filter(([, x]) => x.t !== "null").map(([k, x]) => [k, strip(x)]) } as Json
    : j.t === "arr" ? { t: "arr", v: j.v.map(strip) } as Json : j;
  return writeJson(strip(parseJson(text)));
}

/** quote_literal: the text as a string literal, `E'…'` with each backslash doubled where it holds one */
/**
 * A float cast to numeric, as Postgres writes the numeric (float8_numeric: `%.15g` of the value, float4_numeric
 * `%.6g`, read by numeric_in): `25`, never `25.0`; `20000001.279999997` is `20000001.28`; a -0 is `0`; NaN and the
 * infinities are numeric's. The wire's `floatAsNumeric` (src/duck/types.ts) is the one rule.
 */
export function floatNumericText(x: number, float4: boolean): string {
  return floatAsNumeric(float4 ? Math.fround(x) : x, float4 ? 6 : 15);
}

export function quoteLiteral(text: string): string {
  const q = text.replaceAll("'", "''");
  return text.includes("\\") ? `E'${q.replaceAll("\\", "\\\\")}'` : `'${q}'`;
}

/** array_to_string: the elements' text joined, a NULL element skipped, or written as `nulls` when it is given */
export function arrayToString(items: ReadonlyArray<string | null>, sep: string, nulls: string | null): string {
  return items.flatMap((x) => x !== null ? [x] : nulls !== null ? [nulls] : []).join(sep);
}

// ------------------------------------------------------------------------------------------------- intervals

/**
 * extract(field FROM interval), as Postgres 18 computes it (interval_part_common): the interval's parts each truncated
 * toward zero — years and months of its months, its days, hours, minutes, seconds and micros of its time — as numeric
 * text (a second with 6 decimals, a millisecond with 3, an epoch with 6: a year is 365.25 days, a month 30).
 */
export function intervalPart(field: string, months: number, days: number, micros: bigint): string {
  const year = Math.trunc(months / 12), mon = months % 12;
  const hour = micros / 3_600_000_000n, minute = (micros / 60_000_000n) % 60n, usec = micros % 60_000_000n;
  const fixed = (v: bigint, scale: number): string => {
    const neg = v < 0n, a = neg ? -v : v, d = 10n ** BigInt(scale);
    const text = scale === 0 ? `${a}` : `${a / d}.${`${a % d}`.padStart(scale, "0")}`;
    return neg ? `-${text}` : text;
  };
  switch (field) {
    case "microsecond": case "microseconds": return fixed(usec, 0);
    case "millisecond": case "milliseconds": return fixed(usec, 3);
    case "second": case "seconds": return fixed(usec, 6);
    case "minute": case "minutes": return `${minute}`;
    case "hour": case "hours": return `${hour}`;
    case "day": case "days": return `${days}`;
    case "week": case "weeks": return `${Math.trunc(days / 7)}`;
    case "month": case "months": return `${mon}`;
    case "quarter": return `${months >= 0 ? Math.trunc(mon / 3) + 1 : -(Math.trunc(-mon / 3) + 1)}`;
    case "year": case "years": return `${year}`;
    case "decade": case "decades": return `${Math.trunc(year / 10)}`;
    case "century": case "centuries": return `${Math.trunc(year / 100)}`;
    case "millennium": case "millennia": return `${Math.trunc(year / 1000)}`;
    case "epoch":
      return fixed(micros + (31_557_600n * BigInt(year) + 2_592_000n * BigInt(mon) + 86_400n * BigInt(days)) * 1_000_000n, 6);
    default: throw new Error(`unit "${field}" not supported for type interval`);
  }
}

/** justify_days / justify_hours / justify_interval (Postgres's interval_justify_*): 30 days a month, 24 hours a day,
 *  the parts given one sign */
export function justify(kind: string, months: number, days: number, micros: bigint): [number, number, bigint] {
  let m = months, d = days, t = micros;
  if (kind === "hours" || kind === "interval") { d += Number(t / 86_400_000_000n); t %= 86_400_000_000n; }
  if (kind === "days" || kind === "interval") { m += Math.trunc(d / 30); d %= 30; }
  if (kind === "interval") {
    if (m > 0 && (d < 0 || (d === 0 && t < 0))) { d += 30; m--; } else if (m < 0 && (d > 0 || (d === 0 && t > 0))) { d -= 30; m++; }
  }
  if (kind === "days" && ((m > 0 && d < 0) || (m < 0 && d > 0))) { d += m > 0 ? 30 : -30; m += m > 0 ? -1 : 1; }
  if (kind === "hours" || kind === "interval") {
    if (d > 0 && t < 0) { t += 86_400_000_000n; d--; } else if (d < 0 && t > 0) { t -= 86_400_000_000n; d++; }
  }
  return [m, d, t];
}

// ------------------------------------------------------------------------------------------------- json writes

/**
 * How a value is written into json (Postgres's datum_to_json), by its Postgres type — the rewrite says which:
 * `s` a string (quoted), `r` its text as is (a number, a boolean, a json value), `k` a jsonb's (canonical), `z` / `t`
 * a timestamp with / without a zone (ISO 8601, `T` between the date and the time, a zone as `+HH:MM`).
 */
export type JsonKind = "s" | "r" | "n" | "k" | "z" | "t";

/** DuckDB's text of a timestamp (`2026-01-01 10:00:00.5+01`) as Postgres's json writes it (`2026-01-01T10:00:00.5+01:00`) */
function isoTime(text: string, zoned: boolean): string {
  if (/infinity/i.test(text)) return text.toLowerCase();
  const t = text.replace(" ", "T");
  if (!zoned) return t;
  return t.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

export function jsonValue(kind: JsonKind, text: string | null): string {
  if (text === null) return "null";
  switch (kind) {
    case "s": return quoteJson(text);
    case "r": return text;
    // a number: as written where JSON can carry it, a string where not (NaN, Infinity: datum_to_json's IsValidJsonNumber)
    case "n": return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? text : quoteJson(text);
    case "k": return jsonbText(text);
    case "z": case "t": return quoteJson(isoTime(text, kind === "z"));
  }
}

/** an array as to_json / array_to_json write it (Postgres's array_dim_to_json): `[v,v]`, no space between elements, each
 *  written as its element type's json — a jsonb or json element embedded as json, never quoted as a string */
export function jsonArray(kind: JsonKind, items: ReadonlyArray<string | null>): string {
  return `[${items.map((x) => jsonValue(kind, x)).join(",")}]`;
}

/** json_build_object / json_build_array / to_json, written as Postgres's json functions write them: `{"k" : v, …}`,
 *  `[v, …]`, the value alone. `shape` is the style and then one kind per argument (`o:sr` an object of one string key
 *  and one raw value). */
export function jsonBuild(shape: string, args: ReadonlyArray<string | null>): string | null {
  const [style, kinds = ""] = shape.split(":") as [string, string?];
  if (kinds.length !== args.length) throw new Error(`a json build of ${args.length} argument(s) was described as ${shape}: report it (Mason's rewrite)`);
  const values = args.map((a, i) => jsonValue(kinds[i] as JsonKind, a));
  switch (style) {
    // to_json is strict: NULL in, NULL out
    case "v": return args[0] === null || args[0] === undefined ? null : values[0]!;
    case "a": return `[${values.join(", ")}]`;
    // a row as row_to_json writes it: no space anywhere, a NULL row is NULL
    case "r": {
      const members: string[] = [];
      for (let i = 0; i < args.length; i += 2) members.push(`${quoteJson(args[i]!)}:${values[i + 1]}`);
      return `{${members.join(",")}}`;
    }
    case "o": {
      if (args.length % 2 !== 0) throw new Error("argument list must have even number of elements");
      const members: string[] = [];
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] === null) throw new Error(`argument ${i + 1}: key must not be null`);
        members.push(`${quoteJson(args[i]!)} : ${values[i + 1]}`);
      }
      return `{${members.join(", ")}}`;
    }
    default: throw new Error(`a json build style ${style} is unknown: report it (Mason's rewrite)`);
  }
}

/** encode(bytea, format) as Postgres writes it: base64 in lines of 76, escape with a byte outside printable ASCII
 *  as its octal and a backslash doubled */
export function byteaEncode(bytes: Buffer, format: string): string {
  if (format === "base64") return (bytes.toString("base64").match(/.{1,76}/g) ?? []).join("\n");
  let out = "";
  for (const b of bytes) out += b === 0x5c ? "\\\\" : b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b);
  return out;
}

/** decode(text, format), Postgres's readings and its errors (22023) */
export function byteaDecode(text: string, format: string): Buffer {
  if (format === "hex") {
    const digits = text.replace(/[ \t\n\r]/g, "");
    const bad = /[^0-9a-fA-F]/.exec(digits);
    if (bad !== null) throw new PgEvalError("22023", `invalid hexadecimal digit: "${bad[0]}"`);
    if (digits.length % 2 !== 0) throw new PgEvalError("22023", "invalid hexadecimal data: odd number of digits");
    return Buffer.from(digits, "hex");
  }
  if (format === "base64") {
    const s = text.replace(/[ \t\n\r]/g, "");
    const bad = /[^A-Za-z0-9+/=]/.exec(s);
    if (bad !== null) throw new PgEvalError("22023", `invalid symbol "${bad[0]}" found while decoding base64 sequence`);
    if (/=[^=]/.test(s) || s.length % 4 !== 0) throw new PgEvalError("22023", "invalid base64 end sequence");
    return Buffer.from(s, "base64");
  }
  // escape: `\\` a backslash, `\ooo` an octal byte, anything else its own UTF-8 bytes
  const out: number[] = [];
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x5c) { out.push(bytes[i]!); continue; }
    if (bytes[i + 1] === 0x5c) { out.push(0x5c); i++; continue; }
    const oct = bytes.subarray(i + 1, i + 4).toString("latin1");
    if (!/^[0-3][0-7][0-7]$/.test(oct)) throw new PgEvalError("22P02", "invalid input syntax for type bytea");
    out.push(parseInt(oct, 8)); i += 3;
  }
  return Buffer.from(out);
}

/** A row's text as record_out writes it: `(1,"a b",,t)`, a column quoted when it is empty or holds a quote, a
 *  backslash, a parenthesis, a comma or white space (a quote and a backslash doubled inside), NULL as nothing. */
export function recordText(cols: ReadonlyArray<string | null>): string {
  return `(${cols.map((c) => c === null ? "" : c === "" || /["\\(),\s]/.test(c) ? `"${c.replace(/(["\\])/g, "$1$1")}"` : c).join(",")})`;
}

// ------------------------------------------------------------------------------------------------- arrays

/** An array's text as array_out writes it: `{a,"b c",NULL}`, an element quoted when it is empty, NULL's word, or holds
 *  a brace, a comma, a quote, a backslash or white space. `bool` elements are `t` and `f`. */
export function arrayText(items: ReadonlyArray<string | null>, bool: boolean): string {
  return `{${items.map((x) => {
    if (x === null) return "NULL";
    const t = bool ? (x === "true" ? "t" : x === "false" ? "f" : x) : x;
    return t === "" || /^null$/i.test(t) || /[{},"\\\s]/.test(t) ? `"${t.replace(/["\\]/g, (c) => `\\${c}`)}"` : t;
  }).join(",")}}`;
}

// ------------------------------------------------------------------------------------------------- jsonb's tests

/** a jsonb document at its root as Postgres's containment reads it: a scalar is an array of one (JB_ROOT_IS_SCALAR) */
const root = (j: Json): Json => j.t === "arr" || j.t === "obj" ? j : { t: "arr", v: [j] } as Json;

/** two jsonb scalars equal as equalsJsonbScalarValue says: a number by its value (1.0 = 1), the rest exactly */
function sameScalar(a: Json, b: Json): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "null": return true;
    case "bool": return a.v === (b as typeof a).v;
    case "str": return a.v === (b as typeof a).v;
    case "num": return compare(parseNumeric(a.text), parseNumeric((b as typeof a).text)) === 0;
    default: return false;
  }
}

/** JsonbDeepContains: an object holds each of the template's keys with a value that contains the template's; an array
 *  holds, for each template element, an equal scalar or a container that contains it — of the same kind */
function contains(a: Json, b: Json): boolean {
  if (a.t === "obj" && b.t === "obj") {
    return b.v.every(([k, bv]) => {
      // a duplicate key reads its last value, as jsonb keeps it
      const av = [...a.v].reverse().find(([ak]) => ak === k)?.[1];
      if (av === undefined) return false;
      if ((av.t === "obj" || av.t === "arr") !== (bv.t === "obj" || bv.t === "arr")) return false;
      return av.t === "obj" || av.t === "arr" ? av.t === bv.t && contains(av, bv) : sameScalar(av, bv);
    });
  }
  if (a.t === "arr" && b.t === "arr") {
    return b.v.every((bv) => bv.t === "obj" || bv.t === "arr"
      ? a.v.some((av) => av.t === bv.t && contains(av, bv))
      : a.v.some((av) => sameScalar(av, bv)));
  }
  return false;
}

/** `a @> b` on jsonb (jsonb_contains): their roots must both be objects or both not, then JsonbDeepContains */
export function jsonbContains(a: string, b: string): boolean {
  const x = root(parseJson(a)), y = root(parseJson(b));
  return (x.t === "obj") === (y.t === "obj") && contains(x, y);
}

/** `j ? key` on jsonb (jsonb_exists): an object's top-level key, or a string element of an array (a string scalar's own) */
export function jsonbExists(j: string, key: string): boolean {
  const x = root(parseJson(j));
  return x.t === "obj" ? x.v.some(([k]) => k === key) : x.t === "arr" && x.v.some((e) => e.t === "str" && e.v === key);
}

/** json(b)_array_length: an array's element count, Postgres's error for anything else */
export function jsonArrayLength(j: string): number {
  const x = parseJson(j);
  if (x.t === "arr") return x.v.length;
  throw new Error(x.t === "obj" ? "cannot get array length of a non-array" : "cannot get array length of a scalar");
}

/** string_to_array(text, delimiter [, null_string]) as Postgres splits: '' is no element, a NULL delimiter splits into
 *  characters, an empty one keeps the text whole, and an element equal to null_string is NULL */
export function stringToArray(s: string, delimiter: string | null, nullString: string | null): Array<string | null> {
  if (s === "") return [];
  const parts = delimiter === null ? [...s] : delimiter === "" ? [s] : s.split(delimiter);
  return parts.map((p) => nullString !== null && p === nullString ? null : p);
}

const itemsOf = (v: DuckDBValue): Array<string | null> => (v as { items: DuckDBValue[] }).items.map((x) => x === null ? null : String(x));

// ------------------------------------------------------------------------------------------------- registration

const text = (v: DuckDBValue | undefined): string | null => v === null || v === undefined ? null : String(v);

/** a scalar function over VARCHAR (and BOOLEAN) arguments, one call per row; a thrown error is the statement's */
function scalar(conn: DuckDBConnection, name: string, params: Array<typeof VARCHAR | typeof BOOLEAN | typeof INTEGER | typeof DOUBLE | typeof INTERVAL | ReturnType<typeof LIST>>, returns: typeof VARCHAR | typeof BOOLEAN | typeof INTEGER | typeof DOUBLE | typeof INTERVAL | typeof BLOB | ReturnType<typeof LIST>,
  body: (args: DuckDBValue[]) => unknown, opts: { nulls?: "skip" | "pass"; varargs?: boolean } = {}): void {
  conn.registerScalarFunction(DuckDBScalarFunction.create({
    name, returnType: returns,
    // the session first (`cancelled` above), then the function's own arguments
    ...(opts.varargs ? { varArgsType: VARCHAR } : { parameterTypes: [VARCHAR, ...params] }),
    // every NULL is handled here: the session's is a connection without the variable, and a NULL argument is the
    // function's to decide under `nulls: "pass"` (json_build_object writes `null`), else the answer is NULL
    specialHandling: true,
    mainFunction: (info, input, out) => {
      FUNCTION_CALLS.set(name, (FUNCTION_CALLS.get(name) ?? 0) + 1);
      const all = Array.from({ length: input.columnCount }, (_, c) => input.getColumnVector(c));
      if (cancelled(info, all, input.rowCount)) return;
      const vectors = all.slice(1);
      try {
        for (let r = 0; r < input.rowCount; r++) {
          const args = vectors.map((v) => v.getItem(r) as DuckDBValue);
          out.setItem(r, opts.nulls !== "pass" && args.some((a) => a === null) ? null : body(args) as DuckDBValue);
        }
        out.flush();
      } catch (e) {
        // Postgres's own message where the function raises one (src/duck/store.ts postgresWording reads the prefix), and
        // its SQLSTATE where the function says it
        info.setError(e instanceof PgEvalError ? `mason[${e.code}]: ${e.message}` : `mason: ${(e as Error).message}`);
      }
    },
  }));
}

// ------------------------------------------------------------------- Postgres's own functions (src/duck/pg-eval.ts)

/** what each `__mason_pg_*` function's answer is, and how the worker's Postgres writes it for DuckDB to take whole: a
 *  time as its microseconds (days, for a date), an interval as its three fields, ±infinity by name */
export const PG_KINDS = {
  text: { returns: VARCHAR, sql: (x: string) => `(${x})::text`, read: (t: string): DuckDBValue => t },
  bool: { returns: BOOLEAN, sql: (x: string) => `(${x})::text`, read: (t: string): DuckDBValue => t === "true" },
  int8: { returns: BIGINT, sql: (x: string) => `(${x})::int8::text`, read: (t: string): DuckDBValue => BigInt(t) },
  date: {
    returns: DATE, sql: (x: string) => `CASE WHEN isfinite(${x}) THEN (${x} - date '1970-01-01')::text ELSE (${x})::text END`,
    read: (t: string): DuckDBValue => t === "infinity" ? DuckDBDateValue.PosInf : t === "-infinity" ? DuckDBDateValue.NegInf : new DuckDBDateValue(Number(t)),
  },
  timestamp: {
    returns: TIMESTAMP, sql: (x: string) => `CASE WHEN isfinite(${x}) THEN (extract(epoch FROM ${x}) * 1000000)::int8::text ELSE (${x})::text END`,
    read: (t: string): DuckDBValue => t === "infinity" ? DuckDBTimestampValue.PosInf : t === "-infinity" ? DuckDBTimestampValue.NegInf : new DuckDBTimestampValue(BigInt(t)),
  },
  timestamptz: {
    returns: TIMESTAMPTZ, sql: (x: string) => `CASE WHEN isfinite(${x}) THEN (extract(epoch FROM ${x}) * 1000000)::int8::text ELSE (${x})::text END`,
    read: (t: string): DuckDBValue => t === "infinity" ? DuckDBTimestampTZValue.PosInf : t === "-infinity" ? DuckDBTimestampTZValue.NegInf : new DuckDBTimestampTZValue(BigInt(t)),
  },
  // an infinite interval (Postgres 17+) has no DuckDB value: refused by name where one is met
  interval: {
    returns: INTERVAL,
    sql: (x: string) => `CASE WHEN isfinite(${x}) THEN concat_ws(' ', (extract(year FROM ${x}) * 12 + extract(month FROM ${x}))::int, extract(day FROM ${x})::int, ` +
      `(extract(hour FROM ${x}) * 3600000000 + extract(minute FROM ${x}) * 60000000 + extract(microseconds FROM ${x}))::int8) ELSE (${x})::text END`,
    read: (t: string): DuckDBValue => {
      const parts = t.split(" ");
      if (parts.length !== 3) throw new PgEvalError("0A000", `an infinite interval (${t}) is not supported by Mason (Mason gap infinite-interval)`);
      return new DuckDBIntervalValue(Number(parts[0]), Number(parts[1]), BigInt(parts[2]!));
    },
  },
  list: { returns: LIST(VARCHAR), sql: (x: string) => `(${x})::text[]`, read: (t: string): DuckDBValue => listValue((JSON.parse(t) as Array<string | null>)) },
} as const;
export type PgKind = keyof typeof PG_KINDS;

/** a relative time read from a value at run time means the transaction's start, which the worker's Postgres does not
 *  share: refused by name (a literal is the session's, src/duck/rewrite.ts) */
const RELATIVE = /\b(now|today|tomorrow|yesterday)\b/i;
const READS_TIME = /::\s*(date|timestamp|timestamptz|timestamp with(out)? time zone)\b/i;

/**
 * Postgres's answer for a chunk: `template` an expression over a1…an (each the argument's text), applied by the
 * worker's Postgres to the chunk's distinct argument tuples in one statement, under the zone DuckDB's session has. A
 * NULL argument answers NULL (every function sent here is strict); Postgres's error is the statement's, in its SQLSTATE.
 */
function viaPostgres(conn: DuckDBConnection, kind: PgKind): void {
  const k = PG_KINDS[kind];
  conn.registerScalarFunction(DuckDBScalarFunction.create({
    name: `__mason_pg_${kind}`, returnType: k.returns, varArgsType: VARCHAR,
    mainFunction: (info, input, out) => {
      try {
        const all = Array.from({ length: input.columnCount }, (_, c) => input.getColumnVector(c));
        if (cancelled(info, all, input.rowCount)) return;
        const vectors = all.slice(1);
        const rows = Array.from({ length: input.rowCount }, (_, r) => vectors.map((v) => text(v.getItem(r) as DuckDBValue)));
        // the zone and the template are the rewrite's constants, the same on every row; grouped by them all the same
        const groups = new Map<string, { zone: string; template: string; tuples: Map<string, Array<string | null>> }>();
        for (const [zone = null, template = null, ...args] of rows) {
          if (zone === null || template === null || args.some((a) => a === null)) continue;
          const g = groups.get(`${zone}\u0000${template}`) ?? { zone, template, tuples: new Map() };
          groups.set(`${zone}\u0000${template}`, g);
          g.tuples.set(JSON.stringify(args), args);
        }
        const answers = new Map<string, string | null>();
        for (const [key, g] of groups) {
          const tuples = [...g.tuples.values()];
          if (kind === "date" || kind === "timestamp" || kind === "timestamptz" || READS_TIME.test(g.template)) {
            const relative = tuples.flat().find((a) => a !== null && RELATIVE.test(a));
            if (relative !== undefined) throw new PgEvalError("0A000", `the text '${relative}' read as a time is not supported by Mason: it means the transaction's start (Mason gap relative-time-literal)`);
          }
          const n = tuples[0]!.length;
          const cols = Array.from({ length: n }, (_, i) => `a${i + 1}`);
          const sql = `SELECT ${k.sql("mason_x")} FROM unnest(${cols.map((_, i) => `$${i + 1}::text[]`).join(", ")}) WITH ORDINALITY AS mason_u(${cols.join(", ")}, mason_n) ` +
            `CROSS JOIN LATERAL (SELECT ${g.template} AS mason_x) AS mason_s ORDER BY mason_n`;
          const got = pgEvalSync(sql, cols.map((_, i) => tuples.map((t) => t[i])), g.zone);
          got.forEach(([v], i) => answers.set(`${key}\u0000${JSON.stringify(tuples[i])}`, v ?? null));
        }
        rows.forEach(([zone = null, template = null, ...args], r) => {
          const v = zone === null || template === null || args.some((a) => a === null) ? null : answers.get(`${zone}\u0000${template}\u0000${JSON.stringify(args)}`) ?? null;
          out.setItem(r, v === null ? null : k.read(v));
        });
        out.flush();
      } catch (e) {
        // Postgres's SQLSTATE and words (src/duck/store.ts postgresWording reads them back)
        info.setError(e instanceof PgEvalError ? `mason[${e.code}]: ${e.message}` : `mason: ${(e as Error).message}`);
      }
    },
  }));
}

const steps = (json: string, either: boolean): Step[] => (JSON.parse(json) as Array<string | number>)
  .map((s) => typeof s === "number" ? { index: s } : either ? { either: s } : { key: s });

/** The libc order's two functions (src/duck/libc-order.ts), for the order the source was read with: the characters
 *  ICU's accent and case levels read, and the key (a value holding one not covered refuses, by name). */
export function registerLibcOrder(conn: DuckDBConnection, order: LibcOrder): void {
  scalar(conn, "__mason_libc_kept", [VARCHAR], VARCHAR, ([s]) => libcKept(order, String(s)));
  scalar(conn, "__mason_libc_key", [VARCHAR, VARCHAR], VARCHAR, ([s, icu]) => libcKey(order, String(s), String(icu)));
  // jsonb's order under it (src/duck/jsonb-order.ts): the characters of each string ICU's levels read, then the key
  // from ICU's keys of them (src/duck/rewrite.ts jsonbKey hands them in)
  scalar(conn, "__mason_jsonb_libc_kept", [VARCHAR], LIST(VARCHAR), ([j]) => listValue(jsonbLibcKept(order, String(j))));
  scalar(conn, "__mason_jsonb_key_libc", [VARCHAR, LIST(VARCHAR)], BLOB,
    ([j, keys]) => new DuckDBBlobValue(jsonbKey(String(j), { kind: "libc", order, icuKeys: icuKeysOf(keys!) })));
}

/** the ICU keys DuckDB made of a jsonb's strings (a NULL among them is a Mason bug: every string has one) */
function icuKeysOf(v: DuckDBValue): string[] {
  return itemsOf(v).map((k) => { if (k === null) throw new Error("an ICU key of a jsonb's string is NULL: a Mason bug"); return k; });
}

/**
 * EVERY CALL CARRIES ITS SESSION, FIRST (the test server: a client leaving mid-statement hung the process
 * for good). A scalar function runs on the thread that registered it — the executor worker (src/duck/executor.ts) —
 * while an executor thread waits for it, so that thread can never wait for the executor — and closing a result or a
 * connection does, to cancel the executor's tasks. An interrupt does not end those tasks (they run on until the close),
 * so a statement that calls one of these functions is cancelled another way: its session's cell of the CANCEL TABLE
 * (src/duck/cancel.ts) says it is cancelled, and the statement's next call raises. DuckDB may hand that error back
 * while another task of the query still waits for a call, so the result is closed only once the session's calls have
 * stopped (src/duck/store.ts `cleanUp`; a deadlock under load). The table is shared memory: the listener's thread writes it
 * while this one is busy with the statement's calls. The rewrite (src/duck/rewrite.ts `fn`) passes
 * `getvariable('__mason_session')` as every `__mason_*` function's first argument, which DuckDB folds to the session's
 * literal at bind time; the session runner sets the variable on its connection (its slot, `s<n>`). A connection without
 * it (the writer, a copy's) passes NULL: never cancelled this way.
 */
export const SESSION_VARIABLE = "__mason_session";
export const CANCELLED = "mason[57014]: canceling statement due to user request";
/** how many vectors each function was called with (a call is a hop to the main thread): what a test or a measurement
 *  reads to know whether a statement reached a function at all (the rewrite answers a `->>` natively where it can) */
export const FUNCTION_CALLS = new Map<string, number>();

/** the cancel table the calls read: the executor's, shared with the listener (`useCancelTable`), else one of this thread's own */
let cancels: Int32Array = cancelTable();
export function useCancelTable(t: Int32Array): void { cancels = t; }
export function cancelsTable(): Int32Array { return cancels; }

/** when each session's last call was answered (performance.now(), on this thread): what a session's runner reads to know
 *  that no task of a statement still waits for a call before it closes the statement's result (src/duck/store.ts
 *  `cleanUp`) */
const lastCallAt = new Float64Array(CANCEL_SLOTS);
export function msSinceCall(slot: number): number { return performance.now() - (lastCallAt[slot] ?? 0); }

/** the session's vector (the first argument, a constant): raises when the session's statement is cancelled */
function cancelled(info: { setError(message: string): void }, vectors: ReadonlyArray<{ getItem(i: number): unknown }>, rows: number): boolean {
  const slot = rows > 0 ? slotOf(text(vectors[0]?.getItem(0) as DuckDBValue)) : null;
  if (slot !== null) lastCallAt[slot] = performance.now();
  if (slot === null || !isCancelled(cancels, slot)) return false;
  info.setError(CANCELLED);
  return true;
}

/** Registers the scalar functions on the instance (once: every connection of it sees them). */
export function registerFunctions(conn: DuckDBConnection): void {
  for (const kind of Object.keys(PG_KINDS) as PgKind[]) viaPostgres(conn, kind);
  scalar(conn, "__mason_case", [VARCHAR, BOOLEAN, VARCHAR], VARCHAR, ([s, up, mode]) => pgCase(String(s), up === true, String(mode) as CaseMode));
  scalar(conn, "__mason_initcap", [VARCHAR, VARCHAR], VARCHAR, ([s, mode]) => initcap(String(s), String(mode) as CaseMode));
  // (json, steps as a JSON array, a #> path's, jsonb's canonical text, ->>'s text)
  scalar(conn, "__mason_json_get", [VARCHAR, VARCHAR, BOOLEAN, BOOLEAN, BOOLEAN], VARCHAR,
    ([j, s, either, canonical, asText]) => jsonGet(String(j), steps(String(s), either === true), canonical === true, asText === true));
  // the same, as a stored JSON path keeps it (keptJsonValue, src/duck/kept.ts): what the copy's writes compute
  scalar(conn, "__mason_json_kept", [VARCHAR, VARCHAR, BOOLEAN, BOOLEAN, BOOLEAN], VARCHAR,
    ([j, s, either, canonical, asText]) => keptJsonValue(String(j), steps(String(s), either === true), canonical === true, asText === true));
  scalar(conn, "__mason_json_elements", [VARCHAR, BOOLEAN, BOOLEAN], LIST(VARCHAR),
    ([j, canonical, asText]) => listValue(jsonElements(String(j), canonical === true, asText === true)));
  scalar(conn, "__mason_json_keys", [VARCHAR, BOOLEAN], LIST(VARCHAR), ([j, canonical]) => listValue(jsonMembers(String(j), canonical === true, false).map(([k]) => k)));
  scalar(conn, "__mason_json_values", [VARCHAR, BOOLEAN, BOOLEAN], LIST(VARCHAR),
    ([j, canonical, asText]) => listValue(jsonMembers(String(j), canonical === true, asText === true).map(([, v]) => v)));
  scalar(conn, "__mason_jsonb_text", [VARCHAR], VARCHAR, ([j]) => jsonbText(String(j)));
  // jsonb's order and equality as bytes (src/duck/jsonb-order.ts): under C, and under ICU from ICU's keys of the
  // document's strings, which the rewrite has DuckDB make of `__mason_jsonb_strings` (src/duck/rewrite.ts jsonbKey)
  scalar(conn, "__mason_jsonb_key", [VARCHAR], BLOB, ([j]) => new DuckDBBlobValue(jsonbKey(String(j), { kind: "bytes" })));
  scalar(conn, "__mason_jsonb_strings", [VARCHAR], LIST(VARCHAR), ([j]) => listValue(jsonbStrings(String(j))));
  scalar(conn, "__mason_jsonb_key_icu", [VARCHAR, LIST(VARCHAR)], BLOB, ([j, keys]) => new DuckDBBlobValue(jsonbKey(String(j), { kind: "icu", icuKeys: icuKeysOf(keys!) })));
  // jsonb's @>, ?, ?| and ?& (DuckDB's json_contains and json_exists answer otherwise on arrays), json(b)_array_length
  scalar(conn, "__mason_jsonb_contains", [VARCHAR, VARCHAR], BOOLEAN, ([a, b]) => jsonbContains(String(a), String(b)));
  scalar(conn, "__mason_jsonb_exists", [VARCHAR, VARCHAR], BOOLEAN, ([j, k]) => jsonbExists(String(j), String(k)));
  // ?| and ?&: a NULL key is skipped, as jsonb_exists_any / _all skip it
  scalar(conn, "__mason_jsonb_exists_any", [VARCHAR, LIST(VARCHAR)], BOOLEAN, ([j, ks]) => itemsOf(ks!).some((k) => k !== null && jsonbExists(String(j), k)));
  scalar(conn, "__mason_jsonb_exists_all", [VARCHAR, LIST(VARCHAR)], BOOLEAN, ([j, ks]) => itemsOf(ks!).every((k) => k === null || jsonbExists(String(j), k)));
  scalar(conn, "__mason_json_array_length", [VARCHAR], INTEGER, ([j]) => jsonArrayLength(String(j)));
  scalar(conn, "__mason_string_to_array", [VARCHAR, VARCHAR, VARCHAR], LIST(VARCHAR),
    ([s, d, n]) => s === null ? null : listValue(stringToArray(String(s), text(d), text(n))), { nulls: "pass" });
  scalar(conn, "__mason_json_value", [VARCHAR, VARCHAR], VARCHAR, ([kind, v]) => jsonValue(String(kind) as JsonKind, text(v)), { nulls: "pass" });
  scalar(conn, "__mason_json_array", [VARCHAR, LIST(VARCHAR)], VARCHAR, ([kind, a]) => jsonArray(String(kind) as JsonKind, itemsOf(a!)));
  scalar(conn, "__mason_json_build", [], VARCHAR, ([shape, ...args]) => jsonBuild(String(shape), args.map(text)), { nulls: "pass", varargs: true });
  // to_char, Postgres's template patterns (src/duck/to-char.ts): a time by its text in the session's zone, a number by its digits
  scalar(conn, "__mason_to_char_time", [VARCHAR, VARCHAR], VARCHAR, ([v, f]) => toCharTime(String(v), String(f)));
  scalar(conn, "__mason_to_char_number", [VARCHAR, VARCHAR], VARCHAR, ([v, f]) => toCharNumber(String(v), String(f)));
  // a value's text as Postgres's output function writes it, where DuckDB's cast to VARCHAR writes another: a float's
  // shortest digits (`0`, `NaN`, `Infinity`, `-0`; DuckDB's `0.0`, `nan`, `inf`), an interval's `1 mon` (DuckDB's `1 month`)
  scalar(conn, "__mason_float_text", [DOUBLE, BOOLEAN], VARCHAR, ([x, four]) => four === true ? formatFloat(Math.fround(Number(x)), "float4") : formatFloat(Number(x), "float8"));
  // a zone read from a row (AT TIME ZONE z, src/duck/rewrite.ts zoneArg): an IANA name, spelled as tzdata spells it;
  // an abbreviation or a POSIX zone, which Postgres reads with a fixed offset and DuckDB as another zone, refused
  scalar(conn, "__mason_zone", [VARCHAR], VARCHAR, ([z]) => {
    const read = atTimeZoneOf(String(z));
    if ("problem" in read) throw new PgEvalError(read.sqlstate, read.sqlstate === "0A000" ? `${read.problem} (${gapMark("zone-abbreviation")})` : read.problem);
    return read.zone;
  });
  // a division's divisor tested for zero (src/duck/rewrite.ts nonZero): Postgres's error, from a function DuckDB takes
  // as deterministic, where error() is volatile and refused in a DISTINCT aggregate's ORDER BY
  scalar(conn, "__mason_zero_divisor", [BOOLEAN], BOOLEAN, ([zero]) => { if (zero === true) throw new PgEvalError("22012", "division by zero"); return false; });
  // a numeric divided by a numeric (src/duck/rewrite.ts, `/`): Postgres's quotient, rounded at its scale (numeric_div),
  // as the nearest double, so two quotients Postgres finds equal (0.3 / 0.1 and 0.6 / 0.2) compare, group and count as
  // one, where DuckDB's double division gives each its own last bits. The text a client reads is the exact program's
  scalar(conn, "__mason_numeric_div", [VARCHAR, VARCHAR], DOUBLE, ([a, b]) => {
    const x = String(a), y = String(b);
    // an unconstrained numeric held as a double may be NaN or ±Infinity (DuckDB writes `nan`, `inf`): Postgres's
    // special values divide as a double's do, except by zero
    if (!/^[+-]?[\d.]/.test(x) || !/^[+-]?[\d.]/.test(y)) {
      if (Number(y) === 0 && !/nan/i.test(x)) throw new PgEvalError("22012", "division by zero");
      // a finite value over ±Infinity is 0, never a double's -0
      const q = Number(x.replace(/inf/i, "Infinity")) / Number(y.replace(/inf/i, "Infinity"));
      return q === 0 ? 0 : q;
    }
    try { return Number(numericText(div(parseNumeric(x), parseNumeric(y)))); }
    catch (e) { if (e instanceof NumericError) throw new PgEvalError(e.sqlstate, e.message); throw e; }
  });
  // a numeric Postgres's own function computed, summed (src/duck/rewrite.ts summed): numeric_out's text as two parts
  // DuckDB's DECIMAL(38,18) holds exactly — its integer digits and first 18 decimals (part 0), and its next 18 decimals
  // as the decimals of a value below 1 (part 1), each with the sign — refused, by name, past 20 integer digits or 36
  // decimals. NaN and ±Infinity are none (NULL): a sum holding one is the double's, which adds them as Postgres does
  // (__mason_numeric_special)
  scalar(conn, "__mason_numeric_exact", [VARCHAR, INTEGER], VARCHAR, ([t, part]) => {
    const s = String(t);
    if (!/^-?\d/.test(s)) return null;
    const sign = s.startsWith("-") ? "-" : "";
    const [whole, frac = ""] = s.replace(/^-/, "").split(".") as [string, string?];
    const kept = frac.replace(/0+$/, "");
    if (whole.replace(/^0+(?=\d)/, "").length > 20 || kept.length > 36) throw new PgEvalError("0A000", `the sum of the numeric ${s} is not supported by Mason (${gapMark("numeric-exact-sum")})`);
    return part === 0 ? `${sign}${whole}.${kept.slice(0, 18) || "0"}` : `${sign}0.${kept.slice(18) || "0"}`;
  });
  // a text read as an enum (src/duck/rewrite.ts enumValue): the label, or Postgres's error for one the type lacks
  scalar(conn, "__mason_enum_in", [VARCHAR, VARCHAR, LIST(VARCHAR)], VARCHAR, ([t, name, labels]) => {
    const label = String(t);
    if (!itemsOf(labels!).includes(label)) throw new PgEvalError("22P02", `invalid input value for enum ${String(name)}: "${label}"`);
    return label;
  });
  scalar(conn, "__mason_numeric_special", [VARCHAR], BOOLEAN, ([t]) => !/^-?\d/.test(String(t)));
  // a numeric program over a row's cells' texts (src/duck/rewrite.ts exactText): Postgres's exact value as numeric_out
  // writes it, where DuckDB computes a double (a quotient handed to ln)
  scalar(conn, "__mason_numeric_program", [], VARCHAR, ([program, ...cells]) => {
    const values = Object.fromEntries(cells.map((c, i) => [String(i), text(c)]));
    try { return evaluateText(JSON.parse(String(program)) as NumericProgram, values); }
    catch (e) { if (e instanceof NumericError) throw new PgEvalError(e.sqlstate, e.message); throw e; }
  }, { nulls: "pass", varargs: true });
  // the decimals of numeric_out's text: the value's display scale (`2.450` has 3)
  scalar(conn, "__mason_numeric_scale", [VARCHAR], INTEGER, ([t]) => { const at = String(t).indexOf("."); return at < 0 ? 0 : String(t).length - at - 1; });
  scalar(conn, "__mason_float_numeric_text", [DOUBLE, BOOLEAN], VARCHAR, ([x, four]) => floatNumericText(Number(x), four === true));
  scalar(conn, "__mason_interval_text", [INTERVAL], VARCHAR, ([v]) => { const i = v as DuckDBIntervalValue; return intervalText(i.months, i.days, i.micros); });
  scalar(conn, "__mason_interval_part", [VARCHAR, INTERVAL], VARCHAR, ([f, v]) => { const i = v as DuckDBIntervalValue; return intervalPart(String(f), i.months, i.days, i.micros); });
  scalar(conn, "__mason_justify", [VARCHAR, INTERVAL], INTERVAL, ([k, v]) => { const i = v as DuckDBIntervalValue; const [m, d, t] = justify(String(k), i.months, i.days, i.micros); return new DuckDBIntervalValue(m, d, t); });
  // jsonb's `-`, `||` and jsonb_strip_nulls (canonical text), quote_literal, array_to_string's NULLs
  scalar(conn, "__mason_jsonb_delete", [VARCHAR, VARCHAR], VARCHAR, ([j, k]) => jsonbDelete(String(j), String(k)));
  scalar(conn, "__mason_jsonb_concat", [VARCHAR, VARCHAR], VARCHAR, ([a, b]) => jsonbConcat(String(a), String(b)));
  scalar(conn, "__mason_jsonb_strip_nulls", [VARCHAR], VARCHAR, ([j]) => jsonbStripNulls(String(j)));
  scalar(conn, "__mason_quote_literal", [VARCHAR], VARCHAR, ([t]) => quoteLiteral(String(t)));
  // a bytea's encode / decode (its bytes as their hex, either way: DuckDB's hex and unhex carry them)
  scalar(conn, "__mason_bytea_encode", [VARCHAR, VARCHAR], VARCHAR, ([h, f]) => byteaEncode(Buffer.from(String(h), "hex"), String(f)));
  scalar(conn, "__mason_bytea_decode", [VARCHAR, VARCHAR], VARCHAR, ([t, f]) => byteaDecode(String(t), String(f)).toString("hex"));
  // a row's text as record_out writes it (each column its own text already)
  scalar(conn, "__mason_record_text", [], VARCHAR, (cols) => recordText(cols.map(text)), { nulls: "pass", varargs: true });
  scalar(conn, "__mason_array_to_string", [LIST(VARCHAR), VARCHAR, VARCHAR], VARCHAR,
    ([a, sep, n]) => a === null || sep === null ? null : arrayToString(itemsOf(a!), String(sep), text(n)), { nulls: "pass" });
  // arrays, as their elements' text (the rewrite casts an array to VARCHAR[] and the answer back to its type)
  scalar(conn, "__mason_array_text", [LIST(VARCHAR), BOOLEAN], VARCHAR, ([a, bool]) => arrayText(itemsOf(a!), bool === true));
  // array_remove(a, v): every element not v; a NULL v removes the NULLs
  scalar(conn, "__mason_array_remove", [LIST(VARCHAR), VARCHAR], LIST(VARCHAR),
    ([a, v]) => a === null ? null : listValue(itemsOf(a!).filter((x) => v === null ? x !== null : x !== String(v))), { nulls: "pass" });
}
