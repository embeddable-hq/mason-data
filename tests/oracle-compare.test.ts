/**
 * The oracle's comparison of two values by what they mean (tests/integration/oracle/compare.ts), which tells a wrong
 * value from another text of the same value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, same } from "./integration/oracle/compare.ts";

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

test("normalise: a text column's value is text, whatever its digits", () => {
  assert.equal(same(normalise("01", true), normalise("1", true)), false);
  assert.equal(same(normalise("01"), normalise("1")), true);
});
