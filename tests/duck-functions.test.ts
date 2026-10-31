/**
 * The functions the DuckDB endpoint computes in JavaScript where DuckDB's answer differs from Postgres's
 * (src/duck/functions.ts, src/duck/to-char.ts, the rewrite's SIMILAR TO): each answer here is Postgres 18's own, read from
 * it (tests/integration/duck-oracle.itest.ts and duck-to-char.itest.ts hold every one to a live Postgres; this file pins
 * them offline).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { arrayText, floatNumericText, initcap, jsonArrayLength, jsonBuild, jsonbContains, jsonbExists, jsonElements, jsonGet, jsonMembers, jsonValue, pgCase, stringToArray } from "../src/duck/functions.ts";
import { toCharNumber, toCharTime } from "../src/duck/to-char.ts";
import { giveTurns, masonCalls, similarToRe2 } from "../src/duck/rewrite.ts";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import { deparseSync } from "pgsql-deparser";
import { padDecimals } from "../src/duck/types.ts";

test("json reads: json keeps the document's text, jsonb writes it canonically; a duplicate key reads its last value", () => {
  assert.equal(jsonGet('{"a":1,"a":2}', [{ key: "a" }], false, false), "2");
  assert.equal(jsonGet('{"a": [1,  2]}', [{ key: "a" }], false, false), "[1,  2]");
  assert.equal(jsonGet('{"a": [1,  2]}', [{ key: "a" }], true, false), "[1, 2]");
  // a number's digits as written (DuckDB's json_extract answers 7.0)
  assert.equal(jsonGet('{"n": 7.00}', [{ key: "n" }], true, true), "7.00");
  assert.equal(jsonGet('{"n": 1e2}', [{ key: "n" }], true, true), "100");
  assert.equal(jsonGet('{"n": 1e2}', [{ key: "n" }], false, true), "1e2");
  // ->> of a text key on an array is NULL; a #> path element indexes an array, from the end when negative
  assert.equal(jsonGet("[1,2]", [{ key: "0" }], false, true), null);
  assert.equal(jsonGet("[1,2]", [{ either: "-1" }], true, true), "2");
  assert.equal(jsonGet('{"s": "x\\"y"}', [{ key: "s" }], true, true), 'x"y');
  assert.equal(jsonGet('{"s": null}', [{ key: "s" }], true, true), null);
  assert.equal(jsonGet('{"s": null}', [{ key: "s" }], true, false), "null");
  assert.deepEqual(jsonElements('[7.00, "a", null, {"b":1}]', true, true), ["7.00", "a", null, '{"b": 1}']);
  assert.deepEqual(jsonMembers('{"bb": 1, "a": [2]}', true, false), [["a", "[2]"], ["bb", "1"]]);
  assert.throws(() => jsonElements('{"a":1}', true, false), /cannot extract elements from an object/);
});

test("json writes: json_build_object's spacing, a timestamp in ISO 8601, NULL as null", () => {
  assert.equal(jsonBuild("o:sssr", ["s", "paid", "a", "0.01"]), '{"s" : "paid", "a" : 0.01}');
  assert.equal(jsonBuild("a:rs", ["1", "a"]), '[1, "a"]');
  assert.equal(jsonBuild("v:r", [null]), null);
  assert.equal(jsonBuild("a:nn", ["NaN", "1.5"]), '["NaN", 1.5]');
  assert.equal(jsonValue("z", "2026-10-23 23:05:21+00"), '"2026-10-23T23:05:21+00:00"');
  assert.equal(jsonValue("z", "2026-01-01 11:00:00.5+05:30"), '"2026-01-01T11:00:00.5+05:30"');
  assert.equal(jsonValue("t", "2026-01-01 11:00:00"), '"2026-01-01T11:00:00"');
  assert.equal(jsonValue("k", '{"b":1,  "a":2}'), '{"a": 2, "b": 1}');
  assert.throws(() => jsonBuild("o:ss", [null, "x"]), /key must not be null/);
});

test("case: glibc keeps ß, ICU's full mapping makes it SS, the C locale changes ASCII only; initcap after a letter or digit", () => {
  assert.equal(pgCase("straße", true, "libc"), "STRAßE");
  assert.equal(pgCase("straße", true, "icu"), "STRASSE");
  assert.equal(pgCase("éa", true, "ascii"), "éA");
  assert.equal(initcap("hello wORLD-x2y straße", "libc"), "Hello World-X2y Straße");
  assert.equal(initcap("éa b", "ascii"), "éA B");
});

test("an array's text is array_out's: NULL's word, an element quoted where it must be", () => {
  assert.equal(arrayText(["a", null, "b c", "", 'x"y', "NULL", "a\\b"], false), '{a,NULL,"b c","","x\\"y","NULL","a\\\\b"}');
  assert.equal(arrayText(["true", "false", null], true), "{t,f,NULL}");
  assert.equal(arrayText([], false), "{}");
});

test("SIMILAR TO's pattern as RE2's: % and _, the escape, . ^ $ themselves", () => {
  assert.equal(similarToRe2("c%@example.test", "\\"), "c.*@example\\.test");
  assert.equal(similarToRe2("a_b|(c)", "\\"), "a.b|(?:c)");
  assert.equal(similarToRe2("100#%", "#"), "100\\%");
  assert.equal(similarToRe2("[a-c]%", "\\"), "[a-c].*");
});

test("to_char: Postgres's time patterns and number templates, read from Postgres 18", () => {
  assert.equal(toCharTime("2026-09-15 10:04:05", 'YYYY-"Q"Q'), "2026-Q3");
  assert.equal(toCharTime("2021-01-03 08:30:00", "IYYY-IW"), "2020-53");
  assert.equal(toCharTime("2026-09-15 10:04:05", "FMMonth YYYY"), "September 2026");
  assert.equal(toCharTime("2026-09-15 10:04:05", "Dy DD Mon"), "Tue 15 Sep");
  assert.equal(toCharTime("2026-09-15 10:04:05", "Month|"), "September|");
  assert.equal(toCharTime("2026-09-01 00:00:00", "FMDDth HH12:MI AM"), "1st 12:00 AM");
  assert.equal(toCharTime("infinity", "YYYY"), null);
  assert.equal(toCharNumber("89655199.68", "FM999,999,990.00"), "89,655,199.68");
  assert.equal(toCharNumber("0.5", "9.99"), "  .50");
  assert.equal(toCharNumber("-5", "9999PR"), "   <5>");
  assert.equal(toCharNumber("-0.5", "S9999"), "   -1");
  assert.equal(toCharNumber("12345", "999"), " ###");
  assert.equal(toCharNumber("0", "FM9.99"), "0.");
  assert.throws(() => toCharNumber("5", "9.99EEEE"), /EEEE is not supported/);
});

test("a numeric(p, s) column's text has s decimals, as Postgres writes it, whatever scale DuckDB stored", () => {
  assert.equal(padDecimals("19.99", 30), "19.990000000000000000000000000000");
  assert.equal(padDecimals("-5", 2), "-5.00");
  assert.equal(padDecimals("1.125", 2), "1.125");
  assert.equal(padDecimals("NaN", 2), "NaN");
  assert.equal(padDecimals("7", 0), "7");
});

test("a float cast to numeric writes Postgres's numeric: 15 digits (6 for a real), plainly, never a double's `.0`", () => {
  assert.deepEqual([25, -0, 20000001.279999997, 1e-7, 2e10, 1e20, NaN, -Infinity].map((x) => floatNumericText(x, false)),
    ["25", "0", "20000001.28", "0.0000001", "20000000000", "100000000000000000000", "NaN", "-Infinity"]);
  assert.deepEqual([0.1, 3.25, 123456789.123].map((x) => floatNumericText(x, true)), ["0.1", "3.25", "123457000"]);
});

test("jsonb's @> and ? as Postgres 18 answers them (DuckDB's json_contains / json_exists differ on arrays)", () => {
  // ? : an object's key, an array's string element, a string scalar itself
  assert.equal(jsonbExists('{"a": 1}', "a"), true);
  assert.equal(jsonbExists('["a", "b"]', "a"), true);
  assert.equal(jsonbExists('[1, ["a"]]', "a"), false);
  assert.equal(jsonbExists('"a"', "a"), true);
  assert.equal(jsonbExists('{"b": {"a": 1}}', "a"), false);
  // @> : nested arrays hold arrays, a top-level scalar is in an array, objects by key, numbers by value
  assert.equal(jsonbContains("[[1,2]]", "[1]"), false);
  assert.equal(jsonbContains("[[1,2]]", "[[1]]"), true);
  assert.equal(jsonbContains('["a", "b"]', '"a"'), true);
  assert.equal(jsonbContains('{"a": [1, 2]}', '{"a": 1}'), false);
  assert.equal(jsonbContains('{"a": [1, 2], "b": 3}', '{"a": [2]}'), true);
  assert.equal(jsonbContains('{"n": 1.50}', '{"n": 1.5}'), true);
  assert.equal(jsonbContains("[1, 2]", "[]"), true);
  assert.equal(jsonbContains('{"a": 1}', "[]"), false);
  assert.equal(jsonArrayLength("[1, [2, 3]]"), 2);
  assert.throws(() => jsonArrayLength('{"a": 1}'), /cannot get array length of a non-array/);
  assert.throws(() => jsonArrayLength("1"), /cannot get array length of a scalar/);
});

test("string_to_array as Postgres splits: '' is no element, a NULL delimiter splits characters, an empty one keeps it whole", () => {
  assert.deepEqual(stringToArray("", ",", null), []);
  assert.deepEqual(stringToArray("a,b,,c", ",", null), ["a", "b", "", "c"]);
  assert.deepEqual(stringToArray("abc", null, null), ["a", "b", "c"]);
  assert.deepEqual(stringToArray("abc", "", null), ["abc"]);
  assert.deepEqual(stringToArray("a,x,b", ",", "x"), ["a", null, "b"]);
});

// EVERY VECTOR PASSES THROUGH THE TURN (src/duck/rewrite.ts `giveTurns`; what it does is tests/duck-executor-starve.test.ts)
after(() => stopParser());
const S = "getvariable('__mason_session')";
const turned = async (select: string): Promise<string> => {
  const tree = (await parseSql(`SELECT ${select} FROM t`)).stmts?.[0]?.stmt;
  giveTurns(tree);
  return deparseSync(tree as never, { pretty: false }).replace(/^SELECT /, "").replace(/ FROM t$/, "");
};
test("the turn is taken by a call that reads a column, on its cheapest argument that may be repeated", async () => {
  assert.equal(await turned(`__mason_f(${S}, a, 'k')`), `__mason_f(__mason_turn(${S}, a), a, 'k')`);
  // the whole argument, or `f(a + b)` under GROUP BY a + b would not bind
  assert.equal(await turned(`__mason_f(${S}, a + b)`), `__mason_f(__mason_turn(${S}, a + b), a + b)`);
  assert.equal(await turned(`__mason_f(${S}, lower(a) || b, c)`), `__mason_f(__mason_turn(${S}, c), lower(a) || b, c)`);
  assert.equal(await turned(`__mason_f(${S}, sum(a))`), `__mason_f(__mason_turn(${S}, sum(a)), sum(a))`);
});
test("the turn is not taken over an argument that must not run twice, or by a call DuckDB folds", async () => {
  assert.equal(await turned(`__mason_f(${S}, 'k', 1)`), `__mason_f(${S}, 'k', 1)`);
  assert.equal(await turned(`__mason_f(${S}, $1)`), `__mason_f(${S}, $1)`);
  assert.equal(await turned(`__mason_f(${S}, a = $1)`), `__mason_f(${S}, a = $1)`);
  assert.equal(await turned(`__mason_f(${S}, (SELECT max(a) FROM u))`), `__mason_f(${S}, (SELECT max(a) FROM u))`);
  assert.equal(await turned(`__mason_f(${S}, sum(a) OVER ())`), `__mason_f(${S}, sum(a) OVER ())`);
  assert.equal(await turned(`__mason_f(${S}, unnest(a))`), `__mason_f(${S}, unnest(a))`);
  assert.equal(await turned(`__mason_f(${S}, t.*)`), `__mason_f(${S}, t.*)`);
  // a call of no session is no Mason function's call, and a function of Postgres's is left alone
  assert.equal(await turned("__mason_f(a), lower(a)"), "__mason_f(a), lower(a)");
});
test("a call over a Mason call relies on the turn of the call inside it, so nothing is computed twice", async () => {
  assert.equal(await turned(`__mason_f(${S}, __mason_g(${S}, a))`), `__mason_f(${S}, __mason_g(__mason_turn(${S}, a), a))`);
  // another argument of its own is a turn of its own, one hop more and no call more
  assert.equal(await turned(`__mason_f(${S}, __mason_g(${S}, a), b)`), `__mason_f(__mason_turn(${S}, b), __mason_g(__mason_turn(${S}, a), a), b)`);
});
test("the turn is no function a statement says it calls: a statement that calls none is not cancelled as if it did", async () => {
  const tree = (await parseSql(`SELECT __mason_turn(${S}, a), __mason_f(${S}, a) FROM t`)).stmts?.[0]?.stmt;
  assert.deepEqual(masonCalls(tree), ["__mason_f"]);
});
