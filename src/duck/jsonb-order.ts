/**
 * JSONB'S ORDER AND EQUALITY AS BYTES (a BI tool sorts any column a user clicks: `ORDER BY "e"."tags" DESC` over a jsonb
 * column was refused until this). Postgres orders and equates jsonb by `compareJsonbContainers` (jsonb_util.c), which
 * walks both values token by token and stops at the first difference:
 *  - by TYPE first, at any depth: null < string < number < boolean < array < object (jbvType's order);
 *  - an array with more elements sorts higher, an object with more pairs higher; of equal counts, element by element,
 *    pair by pair in STORAGE order (a key shorter in bytes first, then by its bytes; a key held twice keeps its LAST
 *    value), each pair's key then its value;
 *  - a number as a numeric (`10 > 9.5`, `1.0 = 1.00`, `1e2 = 100`, `-0 = 0`), a boolean false < true, a string — a
 *    key's too — under the DATABASE's default collation (`varstr_cmp(..., DEFAULT_COLLATION_OID)`), whatever a
 *    column's own collation, ties broken by the bytes;
 *  - THE RAW SCALAR: a scalar at the top is stored as a one-element array marked `rawScalar`, and the two are compared
 *    as arrays — the marks first (a raw scalar below an array), then, overriding that, the counts — so `[] < 1 < [1]`
 *    (the source's comment: "a mild anomaly that an empty top level array sorts less than null"), and every top-level
 *    scalar sorts below every object.
 * Equality is that comparison's 0 (`jsonb_eq`), so it is the same key, never the canonical text: `1.0` and `1.00` are
 * one jsonb written two ways.
 *
 * The key is one byte string whose plain byte order (DuckDB's BLOB comparison: bytes, then the shorter first) is that
 * order, and whose equality is that equality. Every value is prefix-free (it ends where its own encoding says), so a
 * container is its tag, its count and its members one after another, and the first differing byte is the first token
 * Postgres finds different:
 *  - a tag per type, in jbvType's order: null 0x10, string 0x20, number 0x30, boolean 0x40, array 0x50, object 0x60;
 *  - an array: its tag, its count (4 bytes, big-endian), then 0x00 for a raw scalar and 0x01 for an array (the count
 *    first: it decides before the mark), then each element; an object: its tag, its count, each pair's key and value;
 *  - a number: 0x80 for zero; else a sign byte (0x81 positive, 0x7f negative), the decimal exponent E of 0.d₁d₂… × 10^E
 *    (4 bytes, biased), the digits without leading or trailing zeros, a 0x00 — every byte after the sign inverted for a
 *    negative number, so a larger magnitude sorts lower;
 *  - a string: the collation's key of it, then a 0x00 (a jsonb string holds no NUL): its UTF-8 bytes under C (`bytes`);
 *    under ICU, ICU's sort key (DuckDB's `icu_sort_key`, which the rewrite hands in) and the bytes' hex; under a libc
 *    locale the measured key (src/duck/libc-order.ts `libcKey`) and the bytes' hex, as the rewrite sorts text
 *    (src/duck/rewrite.ts `libcKey`).
 * A string's collation key is computed by DuckDB's ICU for the ICU kind, which a JavaScript function cannot
 * call: the rewrite passes the document's strings' ICU keys as a list (`jsonbStrings` lists the strings, in the order
 * this walk meets them; `icuKeys` the list DuckDB made of them). Held to Postgres by tests/duck-jsonb-order.test.ts
 * (PGlite's order) and the oracle (tests/integration/duck-oracle.itest.ts, every collation it is run under).
 */
import { Buffer } from "node:buffer";
import { parseJson, storedPairs, type Json } from "./jsonb.ts";
import { libcKey, type LibcOrder } from "./libc-order.ts";

/** how a string's collation key is made: C's bytes, from the ICU key DuckDB made of it (`icu`), or from the order read
 *  of the source (`libc`) */
export type JsonbCollation = { kind: "bytes" } | { kind: "icu"; icuKeys: readonly string[] } | { kind: "libc"; order: LibcOrder };

const TAG = { null: 0x10, str: 0x20, num: 0x30, bool: 0x40, arr: 0x50, obj: 0x60 } as const;
const BIAS = 0x80000000;

/** every string of the value — each object's keys and every string value — in the order the key's walk meets them */
function eachString(v: Json, out: string[]): void {
  switch (v.t) {
    case "str": out.push(v.v); return;
    case "arr": for (const x of v.v) eachString(x, out); return;
    case "obj": for (const [k, x] of storedPairs(v.v)) { out.push(k); eachString(x, out); } return;
    default: return;
  }
}

/**
 * THE FUNCTIONS A KEY IS MADE BY, per collation kind (src/duck/functions.ts registers them): the key's, and the one
 * listing the strings DuckDB makes ICU keys of (none under C). A statement's key (src/duck/rewrite.ts `jsonbKey`) and a
 * stored one (src/duck/kept.ts `orderKeySql`) both read this table, so the two are one computation by construction;
 * a stored key calls each name with `STORED_SUFFIX`, the same function answering NULL where this one raises.
 */
export const JSONB_KEY_FUNCTIONS = {
  bytes: { key: "__mason_jsonb_key", strings: null },
  icu: { key: "__mason_jsonb_key_icu", strings: "__mason_jsonb_strings" },
  libc: { key: "__mason_jsonb_key_libc" },
} as const;
export const STORED_SUFFIX = "_stored";
/**
 * THE KEY'S VERSION: a stored key (src/duck/kept.ts `orderId`) is this encoding's, so a release that changes a byte of
 * it — a tag, the number's form, a string's — bumps this, and a key stored by an earlier one is dropped at the start
 * and stored again (tests/duck-jsonb-order.test.ts holds the encoding; a change it catches is a change of this).
 */
export const KEY_VERSION = 1;

/** The strings of a jsonb's text in the key's order (what DuckDB's ICU makes the keys of). */
export function jsonbStrings(text: string): string[] {
  const out: string[] = [];
  eachString(parseJson(text), out);
  return out;
}

/** whether a jsonb's strings hold a character a libc order does not cover: what its key refuses by name
 *  (`libc-uncovered`, src/duck/libc-order.ts `libcKey`), told from any other failure of the key (src/duck/kept.ts) */
export function libcUncovered(order: LibcOrder, text: string): boolean {
  return jsonbStrings(text).some((s) => { if (order.unread) return true; for (const ch of s) if (order.uncovered[ch.codePointAt(0)!]) return true; return false; });
}

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/**
 * A JSON number's text as its key: zero, or its sign, exponent and digits (the value's, exactly: no rounding through a
 * double, and the scale left out — `1.0` and `1.00` are one number). Read from the text itself, never through a
 * BigInt of its digits (`1e100000` is one digit and an exponent).
 */
export function numberKey(text: string): number[] {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (m === null) throw new Error(`not a JSON number: ${JSON.stringify(text)}`);
  const fraction = m[3] ?? "";
  // the value is all × 10^(exponent - fraction's length), and so 0.<digits> × 10^E with E = all's length less that
  const all = (m[2]! + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  if (digits === "") return [0x80];
  const e = all.length - fraction.length + Number(m[4] ?? 0);
  const body = [...u32(e + BIAS), ...[...digits].map((d) => d.charCodeAt(0)), 0x00];
  return m[1] === "-" ? [0x7f, ...body.map((b) => 0xff - b)] : [0x81, ...body];
}

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

/** The key of a jsonb's text under the database's collation (the module's header says what it encodes). */
export function jsonbKey(text: string, c: JsonbCollation): Buffer {
  const out: number[] = [];
  let at = 0;
  const icuKey = (): string => {
    if (c.kind !== "icu") throw new Error("only ICU's key is handed in");
    const k = c.icuKeys[at++];
    if (k === undefined) throw new Error(`the jsonb holds more strings than the ${c.icuKeys.length} ICU keys handed in: a Mason bug (the rewrite's list and this walk disagree)`);
    return k;
  };
  const str = (s: string): void => {
    const key = c.kind === "bytes" ? s : c.kind === "icu" ? `${icuKey()} ${hex(s)}` : `${libcKey(c.order, s)} ${hex(s)}`;
    for (const b of Buffer.from(key, "utf8")) out.push(b);
    out.push(0x00);
  };
  const value = (v: Json): void => {
    switch (v.t) {
      case "null": out.push(TAG.null); return;
      case "bool": out.push(TAG.bool, v.v ? 1 : 0); return;
      case "num": out.push(TAG.num, ...numberKey(v.text)); return;
      case "str": out.push(TAG.str); str(v.v); return;
      case "arr": out.push(TAG.arr, ...u32(v.v.length), 0x01); for (const x of v.v) value(x); return;
      case "obj": {
        const pairs = storedPairs(v.v);
        out.push(TAG.obj, ...u32(pairs.length));
        for (const [k, x] of pairs) { str(k); value(x); }
        return;
      }
    }
  };
  const root = parseJson(text);
  // a scalar at the top is a raw scalar: a one-element array marked as one (0x00, below an array's 0x01)
  if (root.t !== "arr" && root.t !== "obj") out.push(TAG.arr, ...u32(1), 0x00);
  value(root);
  if (c.kind === "icu" && at !== c.icuKeys.length) throw new Error(`the jsonb holds ${at} strings, ${c.icuKeys.length} ICU keys were handed in: a Mason bug (the rewrite's list and this walk disagree)`);
  return Buffer.from(out);
}
