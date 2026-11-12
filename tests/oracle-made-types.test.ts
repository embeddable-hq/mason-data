/**
 * THE ORACLE'S RULE FOR A TYPE A DATABASE MADE (tests/integration/oracle/made-types.ts, issue 861): a made OID is one type
 * on both sides only when each side's own pg_type names it alike, equal numbers included; a built-in OID by its number.
 * Held here so the rule cannot widen unnoticed: equal numbers naming two types were #861's own bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameType, sameTypes } from "./integration/oracle/made-types.ts";

const names = {
  source: new Map([[16745, "public.mood"], [16387, "public.citext"], [5899092, "public.mood"], [16390, "other.level"]]),
  mason: new Map([[16745, "public.moods"], [16490, "public.mood"], [16499, "other.level"]]),
};

test("a made OID is one type by the names each side gives it, never by its number, and never when a side lacks it", () => {
  assert.equal(sameType(16745, 16745, names), false, "the same number naming public.mood and public.moods");
  assert.equal(sameType(16387, 16387, names), false, "a number Mason's pg_type does not hold");
  assert.equal(sameType(16499, 16499, names), false, "a number the source's pg_type does not hold");
  assert.equal(sameType(16400, 16400, names), false, "a number neither side holds");
  assert.equal(sameType(5899092, 16490, names), true, "two numbers naming public.mood");
  assert.equal(sameType(16390, 16499, names), true, "two numbers naming other.level");
  assert.equal(sameType(5899092, 16499, names), false, "public.mood sent as other.level");
});

test("a built-in OID is one type by its number alone, and never a made one", () => {
  assert.equal(sameType(23, 23, names), true);
  assert.equal(sameType(23, 20, names), false);
  assert.equal(sameType(25, 16490, names), false, "text sent as a made type");
  assert.equal(sameType(16490, 25, names), false, "a made type sent as text");
  assert.equal(sameTypes([23, 5899092], [23, 16490], names), true);
  assert.equal(sameTypes([23, 16745], [23, 16745], names), false);
  assert.equal(sameTypes([23], [23, 25], names), false);
});
