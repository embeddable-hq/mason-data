/**
 * TWO FLOATS ARE THE SAME VALUE WITHIN FLOAT_TOLERANCE (found by the `mason init demo` spike). A source
 * `numeric` was read as Float64 by the ClickHouse stack this was cut from, and a Float64 sum depends on the ORDER
 * its terms were added in: a rollup that sums per customer and then per day, and a recompute that sums the day in one
 * pass, differ in the last bits — 316522.5499999999 against 316522.5500000003 over the same 1,042 orders. Both detectors
 * that compare a stored value with a recomputed one called that a difference: bootstrap's `no_drift_in_clean_batch`
 * failed every apply of a project with a `sum` over a money column, and run.ts's verification marked the routed answer
 * `verified_different`, so the loop never reported clean. Every `mason add` writes such a metric (`sum_<column>` for each
 * numeric column), so this was any project's first rollup.
 *
 * The same class as an approximate sketch (CLAUDE.md "An APPROXIMATE aggregate state cannot be compared for equality"):
 * a value whose bits depend on how it was built. A t-digest is skipped, being a percent apart by design; a float is
 * compared within a relative 1e-9 OR an absolute FLOAT_FLOOR, whichever is larger:
 *   - the RELATIVE bound is far above the noise of a sum of terms of one sign (n terms add at most n x 2^-53 of their
 *     magnitude: 1e-9 is 10 M terms of it) and far below any difference a row makes — one order in a day's revenue is
 *     1e-3 of it. What it cannot see is a difference no Float64 can carry either: a cent in a total of ten million.
 *   - the ABSOLUTE floor is for a sum that CANCELS (a refund, a credit: money columns have negative amounts). The noise
 *     is relative to the terms' magnitudes, not to the result's, so a total near zero keeps it: 19.99 + 5.01 - 25 is 0
 *     in one order and -1.8e-15 in another, and no relative bound calls those one value (the review of #460). Measured
 *     on 26.8, alternating +/- amounts summed per customer then in one pass: 6e-14 apart over 1,042 terms, 8e-10 over
 *     200,000, 4.8e-8 over 2,000,000 (2e8 of magnitude). 1e-6 holds that with a margin of twenty, and is a
 *     ten-thousandth of a cent: below any amount a row of money carries. A float column whose rows differ by less
 *     than 1e-6 (a sum of probabilities near zero) would compare as one value; none of the examples has one.
 *
 * Only FLOATS are compared this way: an integer (a count, an id) is exact on both sides, and a count of 2,000,000,000
 * against 2,000,000,001 is 5e-10 apart — a difference, which a tolerance on every number would hide. A DECIMAL is exact
 * in SQL (`differsSql` takes the float branch on a Float type only), but ClickHouse's JSON writes it as a bare number
 * (`output_format_json_quote_decimals` is 0), so `sameJsonValue`, which sees no type, takes a non-integer Decimal for a
 * float: two Decimals within the tolerance are one value there. The translator reads `numeric` as Float64, so only a
 * `::numeric(p,s)` cast in a query makes a Decimal, and a difference that small is a millionth of its unit.
 */
export const FLOAT_TOLERANCE = 1e-9;
export const FLOAT_FLOOR = 1e-6;

/** Whether two finite floats are one value: within FLOAT_TOLERANCE of the larger's magnitude, or FLOAT_FLOOR. */
export function floatsClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(FLOAT_TOLERANCE * Math.max(Math.abs(a), Math.abs(b)), FLOAT_FLOOR);
}

/**
 * Whether two values from a JSON result are one value: equal as text, or two numbers at least one of which is not an
 * integer (a Float64 in ClickHouse's JSON; its 64-bit integers arrive quoted, or as integers) and floatsClose. A
 * float that sums to a whole number on one side only is still a float.
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (String(a) === String(b)) return true;
  return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) &&
    (!Number.isInteger(a) || !Number.isInteger(b)) && floatsClose(a, b);
}

/**
 * The SQL condition that two expressions DIFFER, NULL-safe, a float within FLOAT_TOLERANCE (or FLOAT_FLOOR) counting as
 * the same. It is
 * written for any column type — a picked UUID, a string, a time, an integer, a finalized state — so it never takes the
 * difference of the values themselves: the float branch reads each through its text (ClickHouse prints the shortest
 * text that round-trips, so a Float64 reads back exactly), and only a column whose type is Float32 or Float64 takes it.
 * A NULL beside a value fails the float branch (coalesce to false) and is a difference, as isNotDistinctFrom says.
 */
export function differsSql(a: string, b: string): string {
  const fa = `toFloat64OrNull(toString(${a}))`, fb = `toFloat64OrNull(toString(${b}))`;
  return `(NOT isNotDistinctFrom(${a}, ${b}) AND NOT coalesce(match(toTypeName(${a}), '^(Nullable\\\\()?Float(32|64)') ` +
    `AND abs(${fa} - ${fb}) <= greatest(${FLOAT_TOLERANCE} * greatest(abs(${fa}), abs(${fb})), ${FLOAT_FLOOR}), false))`;
}

/**
 * What `differsSql` tolerates, said IN the statement it is written into (CLAUDE.md: "when a check skips something, say
 * so IN THE ARTEFACT"): a reader of a generated drift test sees why every column carries a float branch.
 */
export const FLOAT_RULE_COMMENT = [
  `-- A Float32/Float64 column is one value within a relative ${FLOAT_TOLERANCE} or an absolute ${FLOAT_FLOOR}: a sum's`,
  `-- last bits depend on the order it was added in. Any other type is compared exactly (src/lib/float-equal.ts).`,
];
