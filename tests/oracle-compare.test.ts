/**
 * The oracle's comparison of two values by what they mean (tests/integration/oracle/compare.ts), which tells a wrong
 * value from another text of the same value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { askedAs, normalise, same } from "./integration/oracle/compare.ts";
import { TYPE_MATRIX } from "./integration/oracle/type-matrix.ts";
import { everyRowOnce, withinWhole } from "./integration/oracle/unordered-limit.ts";

test("same: integers compare by their digits, exactly; a non-integer to one part in 10^12", () => {
  // Found in review of #389: a 1e-9 relative tolerance on every number let a 13-digit id be off by 1,000, and an
  // Int64 past 2^53 that JSON.parse rounded (2^53 + 1 read as 2^53) pass at any size.
  assert.equal(same(normalise("9007199254740993"), normalise("9007199254740992")), false);
  assert.equal(same(normalise("1000000000000"), normalise(1000000000999)), false);
  assert.equal(same(normalise("1000000000000"), normalise(1000000000000)), true);
  assert.equal(same(normalise(120), normalise("120.00")), true, "an integer against the same value with decimals");
  assert.equal(same(normalise("1000000000.00"), normalise(1000000000.01)), false, "a lost cent on a billion is seen");
  assert.equal(same(normalise("0.3"), normalise(0.30000000000000004)), true, "a double's last digit is not");
  assert.equal(same(normalise("-0"), normalise(0)), true);
  // a time is its instant in either spelling; a boolean its letter
  assert.equal(same(normalise("2026-09-15T00:00:00Z"), normalise("2026-09-15 00:00:00+00")), true);
  assert.equal(same(normalise(true), normalise("t")), true);
  assert.equal(same(normalise(null), normalise(0)), false);
});

test("same: a double printed with an exponent is a number, its last digit another text of the same value", () => {
  // CI's x86_64 runner (PR #3's run 40593841513): a float8 variance's 17th digit, read as text, was a wrong VALUE
  assert.equal(same(normalise("1.6935087641981325e+15"), normalise("1.6935087641981328e+15")), true);
  assert.equal(same(normalise("1.5e+15"), normalise("1500000000000000")), true);
  assert.equal(same(normalise("-2.5e-05"), normalise("-0.000025")), true);
  assert.equal(same(normalise("1.6935087641981325e+15"), normalise("1.6935087e+15")), false, "a wrong value is still one");
  assert.equal(same(normalise("1e+400"), normalise("Infinity")), false, "past a double: text, not a number");
});

test("normalise: a text column's value is text, whatever its digits", () => {
  assert.equal(same(normalise("01", true), normalise("1", true)), false);
  assert.equal(same(normalise("01"), normalise("1")), true);
});

test("a LIMIT with no ORDER BY is held to what is defined of it: its count, rows of the whole join, each as often as the join holds it", () => {
  const fields = { names: ["a", "b"], oids: [23, 25] };
  const whole: (string | null)[][] = [["1", "x"], ["1", "x"], ["2", null], ["3", "z"]];
  const want = { ...fields, rows: [["1", "x"], ["2", null]] };
  assert.equal(withinWhole(want, whole, { ...fields, rows: [["3", "z"], ["1", "x"]] }), null, "any rows of the join, in any order");
  assert.equal(withinWhole(want, whole, { ...fields, rows: [["1", "x"], ["1", "x"]] }), null, "a row the join repeats, as often as it does");
  assert.match(withinWhole(want, [["1", "x"], ["2", null]], { ...fields, rows: [["1", "x"], ["1", "x"]] })!, /more often/);
  assert.match(withinWhole(want, whole, { ...fields, rows: [["1", "x"], ["2", "x"]] })!, /no row of the whole join/, "two rows' columns mixed");
  assert.match(withinWhole(want, whole, { ...fields, rows: [["1", "x"], ["3", "1.50"]] })!, /no row of the whole join/, "another text of a value");
  assert.match(withinWhole(want, whole, { ...fields, rows: [["1", "x"]] })!, /1 row\(s\) where Postgres has 2/);
  assert.match(withinWhole(want, whole, { names: ["a", "c"], oids: [23, 25], rows: want.rows })!, /fields/);
  assert.match(withinWhole(want, whole, { names: ["a", "b"], oids: [20, 25], rows: want.rows })!, /fields/);
  assert.equal(everyRowOnce([["3", "z"], ["1", "x"], ["2", null], ["1", "x"]], whole), null);
  assert.match(everyRowOnce([["3", "z"], ["1", "x"], ["2", null]], whole)!, /in no page/);
  assert.match(everyRowOnce([["3", "z"], ["3", "z"], ["1", "x"], ["2", null]], whole)!, /more often/);
});

// AN OPTION DECLARED ON AN ORACLE STATEMENT REACHES verdict() (PR 233: the runner copied a type-matrix statement's name,
// text and zone, and dropped its `inOrder: false`, so a WITH TIES statement's ties were compared in order)
test("askedAs: an oracle statement is asked with its whole declared shape, its order and its zone among it", () => {
  const unordered = TYPE_MATRIX.filter((q) => q.inOrder === false);
  assert.ok(unordered.length > 0, "the type matrix declares statements compared as sets");
  for (const q of TYPE_MATRIX) assert.deepEqual(askedAs("type matrix", q), { ...q, group: "type matrix" }, q.name);
  assert.deepEqual(askedAs("g", { name: "n", sql: "SELECT 1", zone: "UTC", inOrder: false }), { group: "g", name: "n", sql: "SELECT 1", zone: "UTC", inOrder: false });
  // the runner asks every declared statement through `askedAs`, and compares each by its declared order
  const runner = fs.readFileSync(new URL("./integration/duck-oracle.itest.ts", import.meta.url), "utf8");
  for (const source of ["TYPE_MATRIX", "BI_SHAPES"]) assert.match(runner, new RegExp(`\\.\\.\\.${source}\\.map\\(\\(q\\) => askedAs\\(`), source);
  assert.doesNotMatch(runner, /name: q\.name, sql: q\.sql, \.\.\.\(q\.zone/, "a statement's fields copied one by one drop the rest");
  const verdicts = runner.match(/verdict\(want, [^;]*q\.inOrder[^;]*\)/g) ?? [];
  assert.equal(verdicts.length, 2, "the statements of all() are compared by their declared order, alone and through the listener");
  // (a statement list that declares an order of its own is one `all()` asks, or its runner reads it: none other does yet)
  const dir = new URL("./integration/oracle/", import.meta.url);
  const declaring = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && /\binOrder\b/.test(fs.readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(declaring.sort(), ["compare.ts", "shapes.ts", "type-matrix.ts"], "a new list declaring inOrder: ask it through `askedAs`, or read its order where it is compared");
});
