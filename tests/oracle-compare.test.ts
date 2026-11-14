/**
 * The oracle's comparison of two values by what they mean (tests/integration/oracle/compare.ts), which tells a wrong
 * value from another text of the same value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRows, normalise, numericWithinRule, same } from "./integration/oracle/compare.ts";
import { withinWhole } from "./integration/oracle/unordered-limit.ts";

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
});

// ISSUE 997: a numeric is judged by the owner's rule, exactly (CLAUDE.md "Only these block a merge"): its whole-number
// digits are Postgres's, and the two are equal rounded to 15 significant digits. Never a double, never its text.
test("numericWithinRule: trailing zeros and digits past the 15th significant one are the same value", () => {
  assert.equal(numericWithinRule("2.5", "2.50"), true, "trailing zeros");
  assert.equal(numericWithinRule("12", "12.000000"), true);
  assert.equal(numericWithinRule("0.333333333333333333333", "0.333333333333333"), true, "past the 15th significant digit");
  assert.equal(numericWithinRule("1.23456789012345478", "1.23456789012345"), true);
  assert.equal(numericWithinRule("1.23456789012345678", "1.23456789012346"), true, "rounded at the 15th, both sides");
  assert.equal(numericWithinRule("1.23456789012345", "1.23456789012346"), false, "the 15th significant digit itself");
  assert.equal(numericWithinRule("1.234567890123", "1.234567890124"), false, "a 13th digit off: no longer one part in 10^12");
});

test("numericWithinRule: rounding at the 15th significant digit, half away from zero", () => {
  assert.equal(numericWithinRule("1.000000000000005", "1.00000000000001"), true, "5 at the 16th rounds up");
  assert.equal(numericWithinRule("1.0000000000000049", "1.00000000000001"), false, "below half rounds down");
  assert.equal(numericWithinRule("-1.000000000000005", "-1.00000000000001"), true, "away from zero, negative too");
});

test("numericWithinRule: a carry into a whole-number digit is within the rule, a whole-number digit off is not", () => {
  assert.equal(numericWithinRule("0.99999999999999999", "1"), true, "the carry");
  assert.equal(numericWithinRule("1", "0.99999999999999999"), true, "either side");
  assert.equal(numericWithinRule("-0.99999999999999999", "-1.000"), true, "a negative's carry");
  assert.equal(numericWithinRule("99999999999999.999", "100000000000000.00"), true, "14 whole-number digits carried to 15");
  assert.equal(numericWithinRule("0.9", "1"), false);
  assert.equal(numericWithinRule("17.5", "18.5"), false, "a whole-number digit off");
  assert.equal(numericWithinRule("100000000000000.4", "100000000000000.6"), false, "15 whole-number digits: the 15th rounds apart");
});

test("numericWithinRule: very large values hold every whole-number digit, tiny ones 15 significant digits", () => {
  assert.equal(numericWithinRule("123456789012345678901234", "123456789012345678901234.000"), true);
  assert.equal(numericWithinRule("123456789012345678901234", "123456789012345678901235"), false, "a 24-digit id off in its last digit");
  assert.equal(numericWithinRule("1234567890123456789", "1234567890123460000"), false, "equal to 15 digits, but the whole-number digits are not");
  assert.equal(numericWithinRule("99999999999999999.6", "100000000000000000"), false, "17 whole-number digits: no carry is taken past them");
  assert.equal(numericWithinRule("12345678901234567.123456", "12345678901234567.1"), true, "the decimals past the 15th digit of a big value");
  assert.equal(numericWithinRule("0.0000000000000000001234567890123456", "0.000000000000000000123456789012346"), true, "tiny, 15 significant digits");
  assert.equal(numericWithinRule("0.0000000000000000001", "0.0000000000000000002"), false, "tiny, its one digit off");
  assert.equal(numericWithinRule("0.0000000000000000001", "0"), false, "a tiny value is not zero");
  assert.equal(numericWithinRule("1.5e3", "1500.0"), true, "an exponent read as numeric_in reads it");
});

test("numericWithinRule: negatives, NaN and Infinity are only themselves, and a text no numeric reads is never within", () => {
  assert.equal(numericWithinRule("-2.5", "-2.500"), true);
  assert.equal(numericWithinRule("-2.5", "2.5"), false, "the sign");
  assert.equal(numericWithinRule("0", "-0.00"), true);
  assert.equal(numericWithinRule("NaN", "NaN"), true);
  assert.equal(numericWithinRule("NaN", "nan"), false, "the engine's double's text is not Postgres's");
  assert.equal(numericWithinRule("Infinity", "Infinity"), true);
  assert.equal(numericWithinRule("Infinity", "-Infinity"), false);
  assert.equal(numericWithinRule("Infinity", "1e400"), false);
  assert.equal(numericWithinRule("NaN", "0"), false);
  assert.equal(numericWithinRule("1.5", "abc"), false);
});

test("compareRows: a numeric column within the rule is no difference, a NULL or a value outside it is a wrong value", () => {
  const names = ["id", "n"], numeric = [false, true];
  assert.equal(compareRows([["1", "2.5"]], [["1", "2.50"]], names, numeric, true), null, "no KNOWN entry needed");
  assert.equal(compareRows([["1", "2.5"]], [["1", "2.6"]], names, numeric, true)?.kind, "value");
  assert.equal(compareRows([["1", "2.5"]], [["1", null]], names, numeric, true)?.kind, "value", "NULL is no value");
  assert.equal(compareRows([["1", null]], [["1", null]], names, numeric, true), null);
  assert.equal(compareRows([["1", "17.5"]], [["1", "18.5"]], names, numeric, false)?.kind, "value", "a whole-number digit off");
  // a column not sent as numeric keeps its comparison: another text of one value is a text difference
  assert.equal(compareRows([["1", "2.5"]], [["1", "2.50"]], names, [false, false], true)?.kind, "text");
  assert.equal(compareRows([["0.3"]], [["0.30000000000000004"]], ["f"], [false], true)?.kind, "text", "a float8's last digit, as before");
  // a numeric inside a JSON, an array or a row's text is a string to the client: held as one
  assert.equal(compareRows([["{2.5}"]], [["{2.50}"]], ["a"], [false], true)?.kind, "value");
});

test("compareRows: unordered rows are matched by the rule, whatever order their texts sort in", () => {
  const names = ["n", "b"], numeric = [true, false];
  // `"10"` sorts before `"9.50"` as text, `"10.0"` after `"1"`: matched by value, not by text
  const want = [["9.5", "x"], ["10", "y"], ["1", "z"]];
  assert.equal(compareRows(want, [["10.0", "y"], ["1.000", "z"], ["9.50", "x"]], names, numeric, false), null);
  assert.equal(compareRows(want, [["10.0", "y"], ["1.000", "z"], ["9.50", "w"]], names, numeric, false)?.kind, "value", "another row");
  // values equal to 15 digits whose whole-number digits differ are paired each with its own
  const big = [["123456789012345678", "a"], ["123456789012345679", "a"]];
  assert.equal(compareRows(big, [["123456789012345679", "a"], ["123456789012345678", "a"]], names, numeric, false), null);
  assert.equal(compareRows(big, [["123456789012345679", "a"], ["123456789012345679", "a"]], names, numeric, false)?.kind, "value", "one value twice is not the two");
  // ordered: the same rows by the rule in another order is an ORDER difference
  assert.equal(compareRows([["1"], ["2.5"]], [["2.50"], ["1.0"]], ["n"], [true], true)?.kind, "rows");
  assert.equal(compareRows([["1"], ["2.5"]], [["2.50"], ["1.5"]], ["n"], [true], true)?.kind, "value");
});
