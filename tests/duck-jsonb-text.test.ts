/**
 * A JSONB'S TEXT AS POSTGRES WRITES IT REFUSES WHAT POSTGRES REFUSES (src/duck/jsonb.ts `jsonbText`): a generated table's
 * build writes every jsonb it stores through it (issue 461), and a text cast to jsonb is read by it, so a text that is no
 * JSON is refused, never turned into a document. The round-5 and round-6 reviews of #950 met a faster reader that read
 * a number in a key's place as a key, kept a document whose invalid value a later duplicate key replaced, and closed a
 * string a stray backslash left open: each input here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbText } from "../src/duck/jsonb.ts";

const BAD = ["", "{", '{"a": 1,}', "[1, 2", "nul", "01", "1.", '{"a" 1}', "{'a': 1}", "[1] x", '"\\x"', "NaN",
  // a number in a key's place: plain, nested, in an array, after an escaped key, between other keys
  "{1: 2}", "{1.5: 2}", "{-0: 1}", "{12345678901234567890: 1}", "{1e2: 3}", "[1e2: 3]", '{"a": {2.5: 1}}', '[{"x": 1, 1e3: 2}]',
  '{"a\\"b": 1, 0.5: 2}', '{"k": [1, {7.0: 1}]}', '{"a": 1, -1.25: 2, "b": 3}',
  // an invalid value a later duplicate key replaces: still no JSON
  '{"a": {1.5: 2}, "a": 1}', '{"a": {-0: 2}, "a": 1}', '[{"k": {1.5: true}, "k": 2}]',
  // a stray backslash before a number in a string never closed
  '["\\1.5]', '{"\\1.5: 2}', '{"a": "\\1e2}', '["\\-0]'];

test("jsonbText refuses a text that is no JSON, whatever a number in it stands beside", () => {
  for (const b of BAD) assert.throws(() => jsonbText(b), /invalid input syntax for type json/, b);
});

test("jsonbText writes a document as jsonb_out does: keys by length then bytes, a key held twice kept last, at every depth", () => {
  assert.equal(jsonbText(' { "z" : { "bb" : 1 , "a" : 2 , "bb" : 3 } , "arr" : [ { "y" : 1 , "x" : 2 , "y" : 3 } ] } '), '{"z": {"a": 2, "bb": 3}, "arr": [{"x": 2, "y": 3}]}');
  assert.equal(jsonbText('{"n": 2.50, "e": 1e2, "m": -0, "é": 1, "b": 1}'), '{"b": 1, "e": 100, "m": 0, "n": 2.50, "é": 1}');
});
