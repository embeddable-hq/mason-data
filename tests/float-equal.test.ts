/**
 * A float is one value within FLOAT_TOLERANCE (src/lib/float-equal.ts): a Float64 sum's last bits depend on the order
 * it was added in, and both detectors that compare a stored value with a recomputed one called that a difference.
 * The SQL form's (`differsSql`) behaviour in ClickHouse, for every type it may meet, was held by an integration test of
 * the ClickHouse stack this was cut from; nothing here runs it against a database.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { FLOAT_FLOOR, FLOAT_RULE_COMMENT, FLOAT_TOLERANCE, differsSql, floatsClose, sameJsonValue } from "../src/lib/float-equal.ts";

test("floats close within the tolerance are one value, and one cent in a day's revenue is not", () => {
  assert.ok(floatsClose(316522.5499999999, 316522.5500000003));
  assert.ok(!floatsClose(316522.55, 316522.56));
  assert.ok(floatsClose(0, 0));
  assert.ok(!floatsClose(0, 0.01));   // a cent beside nothing is a cent
  assert.equal(FLOAT_TOLERANCE, 1e-9);
  assert.equal(FLOAT_FLOOR, 1e-6);
});

test("a sum that cancels is one value however it was added: a refund's total is near zero, and so is its noise", () => {
  // the review of #460: an order refunded, added in two orders, is 0 one way and -1.8e-15 the other
  const oneWay = 19.99 + 5.01 + -25, other = 19.99 + -25 + 5.01;
  assert.notEqual(oneWay, other, "the two orders must differ in their last bits, or this case proves nothing");
  assert.ok(floatsClose(oneWay, other));
  assert.ok(sameJsonValue(oneWay, other));
  // the noise 2,000,000 alternating amounts left on 26.8 (the header): still one value
  assert.ok(floatsClose(5.4569682106375694e-11, 4.80586095363833e-8));
});

test("a JSON value: equal text, or two numbers one of which is a float and close; integers are exact", () => {
  assert.ok(sameJsonValue("acme", "acme"));
  assert.ok(sameJsonValue(5, "5"));
  assert.ok(sameJsonValue(316522.5499999999, 316522.5500000003));
  assert.ok(!sameJsonValue(2_000_000_000, 2_000_000_001));
  assert.ok(!sameJsonValue("316522.5499999999", "316522.5500000003"));   // text is never read as a number
  assert.ok(!sameJsonValue(null, 0));
  assert.ok(!sameJsonValue(1.5, Number.POSITIVE_INFINITY));
});

test("the SQL form is NULL-safe and takes the float branch on a float type only", () => {
  const sql = differsSql("r.x", "s.x");
  assert.match(sql, /^\(NOT isNotDistinctFrom\(r\.x, s\.x\) AND NOT coalesce\(/);
  assert.match(sql, /match\(toTypeName\(r\.x\), '\^\(Nullable\\\\\(\)\?Float\(32\|64\)'\)/);
  assert.match(sql, /<= greatest\(1e-9 \* greatest\(abs\(.*\), abs\(.*\)\), 0\.000001\)/);
  // said in the statement: every line a comment, naming both bounds
  assert.ok(FLOAT_RULE_COMMENT.every((l) => l.startsWith("-- ")));
  assert.match(FLOAT_RULE_COMMENT.join(" "), /relative 1e-9 or an absolute 0\.000001/);
  assert.match(sql, /, false\)\)$/);
});
