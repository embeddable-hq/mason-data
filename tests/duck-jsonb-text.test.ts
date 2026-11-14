/**
 * A JSONB'S TEXT AS POSTGRES WRITES IT (src/duck/jsonb.ts `jsonbText`): the fast path through V8's own parser (issue 461:
 * a generated table's build writes every jsonb it stores through it) answers exactly what the slow path, `parseJson`
 * then `writeJson`, answers, over every shape: keys in jsonb's order (length, then bytes, unicode included), a key held
 * twice kept once with its last value, at every depth and in arrays of objects, every number spelling (`2.50`, `1e2`,
 * `-0`, past a double), every escape, spaces anywhere JSON allows them; and a text that is no JSON refused alike.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbText, parseJson, writeJson } from "../src/duck/jsonb.ts";

const slow = (t: string): string => writeJson(parseJson(t));

const DOCS = [
  '{"bb": 1, "a": 2, "bb": 3, "c": 4}', '{"b":1,"a":2}', ' { "z" : { "bb" : 1 , "a" : 2 , "bb" : 3 } , "arr" : [ { "y" : 1 , "x" : 2 , "y" : 3 } ] } ',
  '{"n": 2.50, "e": 1e2, "E": 1E+2, "m": -0, "z": 0, "neg": -12, "f": 0.1000000000000000055511, "big": 123456789012345678901234567890, "small": 1e-7, "d": -0.0}',
  '{"é": 1, "e": 2, "ü": 3, "ab": 4, "B": 5, "😀": 6, "Ä": 7, "": 8}', '{"q\\"k": "a\\"b", "back\\\\": "c\\\\d", "nl": "x\\ny", "tab": "\\t", "sl": "a\\/b", "ctl": "\\b\\f\\r"}',
  "[]", "{}", "[1, [2, [3, {\"b\": 1, \"a\": 1}]]]", '"just a string"', "17", "-0", "1.50", "true", "false", "null", '[null, true, false, "x", 1.0]',
  '{"a": {"a": {"a": {"b": 1, "a": 2, "b": 3}}}}', '{"__proto__": 1, "constructor": 2, "toString": 3}', '{"1": "a", "10": "b", "2": "c", "01": "d"}',
  '{"k": "\\u00e9"}', '{"\\u0041": 1, "A": 2}', '{"k": "\\ud83d\\ude00"}',
  // a raw control character in a string: V8 refuses it, the slow path reads it, so the slow path answers
  '"a\nb"', '{"t": "a\tb"}',
];
const BAD = ["", "{", '{"a": 1,}', "[1, 2", "nul", "01", "1.", '{"a" 1}', "{'a': 1}", "[1] x", '"\\x"', "NaN"];

test("jsonbText answers exactly what parseJson and writeJson answer, over every shape", () => {
  for (const d of DOCS) assert.equal(jsonbText(d), slow(d), d);
  // generated documents: random keys (ASCII and not, held twice), nesting, numbers and strings
  let seed = 461;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const keys = ["a", "b", "bb", "aa", "B", "é", "z", "ab", "ä", "Z", "😀", "k1", "10", "1"];
  const nums = ["0", "-0", "1", "-1", "2.50", "1e2", "1E-3", "123456789012345678901234567890.5", "0.10", "-7.000"];
  const strs = ['"x"', '""', '"a b"', '"q\\"t"', '"é"', '"\\n"'];
  const value = (depth: number): string => {
    const k = rnd(depth > 3 ? 3 : 6);
    if (k === 0) return nums[rnd(nums.length)]!;
    if (k === 1) return strs[rnd(strs.length)]!;
    if (k === 2) return ["true", "false", "null"][rnd(3)]!;
    if (k === 3) return `[${Array.from({ length: rnd(4) }, () => value(depth + 1)).join(rnd(2) ? "," : " , ")}]`;
    return `{${Array.from({ length: rnd(5) }, () => `"${keys[rnd(keys.length)]}"${rnd(2) ? ":" : " : "}${value(depth + 1)}`).join(",")}}`;
  };
  for (let i = 0; i < 2000; i++) { const d = value(0); assert.equal(jsonbText(d), slow(d), d); }
});

test("jsonbText refuses a text that is no JSON as parseJson does, in its words", () => {
  for (const b of BAD) {
    let want: string | null = null;
    try { slow(b); } catch (e) { want = (e as Error).message; }
    assert.ok(want !== null, `the slow path read ${JSON.stringify(b)}`);
    assert.throws(() => jsonbText(b), (e: Error) => e.message === want, b);
  }
});
