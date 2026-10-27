/**
 * src/lib/pg-numeric.ts HELD TO POSTGRES: every operation, over generated values, against PGlite's own numeric
 * (Postgres 18) — the text `numeric_out` writes, digit for digit, trailing zeros included. A quotient's scale depends on
 * the VALUES (select_div_scale reads the first base-10000 group of each), so the values span every group boundary:
 * 1, 9999, 10000, 10001, a 1 at each decimal place, numbers past 2^63, negatives, zero. An average is held to
 * Postgres's `avg` of integer rows of every width. Offline, in `npm test`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  add, aggregateType, ceil, div, divScale, evaluate, evaluateText, floor, mod, mul, numericBinary, numericText, parseNumeric, round, stddev, sub, trunc, withTypmod,
  wholeNumberOf, NumericError, type NumericProgram, type PgNumeric,
} from "../src/lib/pg-numeric.ts";

const db = new PGlite();
await db.waitReady;
after(() => db.close());

/** the values every operation is asked about, as numeric literals */
const VALUES: string[] = (() => {
  const v = new Set<string>(["0", "1", "-1", "2", "3", "7", "-7", "9", "10", "99", "100", "9999", "10000", "10001", "12345", "-12345",
    "99999999", "100000000", "123456789012", "9007199254740993", "-9007199254740993", "9223372036854775807", "-9223372036854775808",
    "92233720368547758070", "0.5", "-0.5", "0.1", "0.01", "0.001", "0.0001", "0.00001", "0.00009999", "1.5", "2.675", "-2.675",
    "100.0", "100.00", "0.0", "0.000", "3.14159", "1.25", "-1.25", "0.3333", "22101699", "2210.1699", "21.859491628", "1e3", "1.5e-3",
    "1000000.000001", "0.0000000000000000001", "123456.789", "-0.0001", "4999.9999", "5000.0001"]);
  return [...v];
})();

/** one Postgres numeric text per expression, in order: a batch is one statement */
async function pg(exprs: string[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (let i = 0; i < exprs.length; i += 400) {
    const batch = exprs.slice(i, i + 400);
    const r = await db.query<{ v: string | null }>(`SELECT v::text AS v FROM (VALUES ${batch.map((e, j) => `(${j}, (${e})::text)`).join(", ")}) AS t(i, v) ORDER BY i`);
    out.push(...r.rows.map((x) => x.v));
  }
  return out;
}

const lit = (s: string): string => `${s}::numeric`;

test("text: a numeric reads and writes as numeric_in / numeric_out do", async () => {
  const want = await pg(VALUES.map(lit));
  VALUES.forEach((v, i) => assert.equal(numericText(parseNumeric(v)), want[i], v));
});

/** every spelling numeric_in reads, and some it refuses (the Fable review of #517: `'1_000'::numeric` reached DuckDB as a
 *  text, read by a regex of its own; the reader is parseNumeric, everywhere) */
const SPELLINGS = ["1_000", "1__000", "_1", "1_", "1_000.5", "1.5_0", "1._5", "1_.5", "1e1_0", "1e_10", "1_0e1_0", "0x1F", "0x_1F",
  "0x1_F", "0X1f", "-0x10", "+0x10", "0o17", "0O17", "0b101", "0B_1", "0x", "0x1.5", "0x1__F", "0o8", "0b2", " +1.50 ", "-0", "-0.00", ".5",
  "1.", "1.50e1", "1e-2", "1E+2", "  ", "1 2", "+.e1", ".", "1e", "00012.30", "0x8000000000000000000000000000000000000000", "\t7\n"];

test("text: every spelling Postgres 16's numeric_in reads — underscores, 0x / 0o / 0b — is read as it reads it, and the rest refused", async () => {
  for (const v of SPELLINGS) {
    let want: string | null;
    try { want = (await db.query<{ v: string }>("SELECT $1::numeric::text AS v", [v])).rows[0]!.v; }
    catch (e) { assert.equal((e as { code?: string }).code, "22P02", v); want = null; }
    let got: string | null;
    try { got = numericText(parseNumeric(v)); }
    catch (e) { assert.ok(e instanceof NumericError && e.sqlstate === "22P02", `${JSON.stringify(v)}: ${String(e)}`); got = null; }
    assert.equal(got, want, JSON.stringify(v));
  }
});

test("addition, subtraction and multiplication keep every digit at Postgres's scale", async () => {
  const pairs = VALUES.flatMap((a) => VALUES.map((b) => [a, b] as const));
  for (const [op, fn] of [["+", add], ["-", sub], ["*", mul]] as const) {
    const want = await pg(pairs.map(([a, b]) => `${lit(a)} ${op} ${lit(b)}`));
    pairs.forEach(([a, b], i) => assert.equal(numericText(fn(parseNumeric(a), parseNumeric(b))), want[i], `${a} ${op} ${b}`));
  }
});

test("division: select_div_scale's scale, rounded half away from zero; a zero divisor is 22012", async () => {
  const pairs = VALUES.flatMap((a) => VALUES.filter((b) => Number(b) !== 0).map((b) => [a, b] as const));
  const want = await pg(pairs.map(([a, b]) => `${lit(a)} / ${lit(b)}`));
  pairs.forEach(([a, b], i) => assert.equal(numericText(div(parseNumeric(a), parseNumeric(b))), want[i], `${a} / ${b} (scale ${divScale(parseNumeric(a), parseNumeric(b))})`));
  assert.throws(() => div(parseNumeric("1"), parseNumeric("0.00")), (e: unknown) => e instanceof NumericError && e.sqlstate === "22012" && e.message === "division by zero");
  await assert.rejects(db.query("SELECT 1::numeric / 0.00"), /division by zero/);
});

test("round(numeric, n): half away from zero, shown with exactly n decimals (none for n < 0)", async () => {
  const cases = VALUES.flatMap((v) => [-3, -1, 0, 1, 2, 5, 20].map((n) => [v, n] as const));
  const want = await pg(cases.map(([v, n]) => `round(${lit(v)}, ${n})`));
  cases.forEach(([v, n], i) => assert.equal(numericText(round(parseNumeric(v), n)), want[i], `round(${v}, ${n})`));
});

test("trunc(numeric, n), floor, ceil and % (mod) as Postgres computes them, scale included", async () => {
  const cases = VALUES.flatMap((v) => [-3, -1, 0, 1, 2, 5, 20].map((n) => [v, n] as const));
  const want = await pg(cases.map(([v, n]) => `trunc(${lit(v)}, ${n})`));
  cases.forEach(([v, n], i) => assert.equal(numericText(trunc(parseNumeric(v), n)), want[i], `trunc(${v}, ${n})`));
  for (const [name, f] of [["floor", floor], ["ceil", ceil]] as const) {
    const w = await pg(VALUES.map((v) => `${name}(${lit(v)})`));
    VALUES.forEach((v, i) => assert.equal(numericText(f(parseNumeric(v))), w[i], `${name}(${v})`));
  }
  const pairs = VALUES.flatMap((a) => VALUES.filter((b) => Number(b) !== 0).slice(0, 30).map((b) => [a, b] as const));
  const m = await pg(pairs.map(([a, b]) => `${lit(a)} % ${lit(b)}`));
  pairs.forEach(([a, b], i) => assert.equal(numericText(mod(parseNumeric(a), parseNumeric(b))), m[i], `${a} % ${b}`));
});

test("GREATEST / LEAST keep the chosen value's own scale and skip NULLs; COALESCE the first that is not NULL", async () => {
  const triples: Array<[string | null, string | null, string | null]> = [["2.5", "1", null], ["1.50", "1.5", "1"], [null, null, null], ["-1", "-1.00", "0.0"], ["10", "9.999", null], [null, "0.000", "7"]];
  for (const op of ["greatest", "least", "coalesce"] as const) {
    const want = await pg(triples.map((t) => `${op}(${t.map((x) => x === null ? "NULL::numeric" : lit(x)).join(", ")})`));
    triples.forEach((t, i) => {
      const program = { op, args: t.map((_, j) => ({ op: "cell" as const, key: `c${j}` })) };
      const v = evaluate(program, Object.fromEntries(t.map((x, j) => [`c${j}`, x])));
      assert.equal(v === null ? null : numericText(v), want[i], `${op}(${t.join(", ")})`);
    });
  }
});

test("a cast to numeric(p, s) rounds as round does, and overflows as Postgres does", async () => {
  // a scale above the precision (Postgres 15+) holds a value below 10^(p - s): 0.05 fits numeric(2, 3), 0.5 overflows
  const cases = VALUES.flatMap((v) => [[10, 2], [5, 0], [20, 4], [3, 3], [2, 3], [1, 5], [3, 6]].map(([p, s]) => [v, p!, s!] as const));
  for (const [v, p, s] of cases) {
    let want: string | Error;
    try { want = (await db.query<{ v: string }>(`SELECT (${lit(v)})::numeric(${p}, ${s})::text AS v`)).rows[0]!.v; } catch (e) { want = e as Error; }
    if (want instanceof Error) {
      assert.throws(() => withTypmod(parseNumeric(v), p, s), (e: unknown) => e instanceof NumericError && e.sqlstate === "22003", `${v}::numeric(${p},${s}) overflows in Postgres`);
    } else assert.equal(numericText(withTypmod(parseNumeric(v), p, s)), want, `${v}::numeric(${p},${s})`);
  }
});

// a numeric PARAMETER that is a whole number is bound as one, on both paths (the review of #508): which texts are whole is
// Postgres's question — `v = trunc(v)` — and the integer is `trunc(v)`'s digits
test("a whole number among numerics is the one Postgres's trunc leaves unchanged", async () => {
  const want = await pg(VALUES.map((v) => `CASE WHEN ${lit(v)} = trunc(${lit(v)}) THEN trunc(${lit(v)})::text END`));
  VALUES.forEach((v, i) => assert.equal(wholeNumberOf(v)?.toString() ?? null, want[i], v));
  assert.equal(wholeNumberOf("abc"), null);
});

test("an average of integers is the sum divided by the count, as Postgres's avg answers it", async () => {
  const sets: number[][] = [[1], [1, 2], [1, 2, 2], [-1, -2, -2], [7, 7, 7], [0], [0, 0, 1], [10000, 1], [123456789, 987654321, 5],
    [2147483647, 2147483647, 1], [3, 3, 3, 3, 3, 3, 4], [-5, 5], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
  for (const type of ["smallint", "integer", "bigint"]) {
    for (const xs of sets) {
      if (type === "smallint" && xs.some((x) => Math.abs(x) > 32767)) continue;
      const r = await db.query<{ a: string; s: string; c: string }>(`SELECT avg(x)::text AS a, sum(x)::text AS s, count(x)::text AS c FROM unnest(ARRAY[${xs.join(",")}]::${type}[]) AS x`);
      const { a, s, c } = r.rows[0]!;
      assert.equal(evaluateText({ op: "div", args: [{ op: "cell", key: "s" }, { op: "cell", key: "c" }] }, { s, c }), a, `avg(${type}) of ${xs.join(",")}`);
    }
  }
  // an average needing more than 17 significant digits: Postgres keeps them, a double cannot
  const big = await db.query<{ a: string }>(`SELECT avg(x)::text AS a FROM unnest(ARRAY[9007199254740993, 9007199254740994, 1]::bigint[]) AS x`);
  assert.equal(numericText(div(parseNumeric("18014398509481988"), parseNumeric("3"))), big.rows[0]!.a);
  assert.ok(big.rows[0]!.a.replace(/[-.]/g, "").length > 17);
});

test("stddev and variance (sample and population) from N, Σx and Σx², as numeric_stddev_internal computes them", async () => {
  // every run of 1 to 6 consecutive values, every 3rd value, and all of them: one row, cancelling values, every scale
  const sets: string[][] = [];
  for (let n = 1; n <= 6; n++) for (let i = 0; i + n <= VALUES.length; i += 3) sets.push(VALUES.slice(i, i + n));
  sets.push(VALUES.filter((_, i) => i % 3 === 0), VALUES, ["5", "5", "5"], ["0.1", "0.1"], ["1", "-1"]);
  for (const set of sets) {
    const r = await db.query<Record<string, string | null>>(`SELECT stddev_samp(x)::text AS ss, stddev_pop(x)::text AS sp, var_samp(x)::text AS vs, var_pop(x)::text AS vp FROM (VALUES ${set.map((v) => `(${lit(v)})`).join(", ")}) AS t(x)`);
    const want = r.rows[0]!;
    const xs = set.map(parseNumeric);
    const n: PgNumeric = { unscaled: BigInt(xs.length), scale: 0 };
    const sumX = xs.reduce((a, b) => add(a, b));
    const sumX2 = xs.map((x) => mul(x, x)).reduce((a, b) => add(a, b));
    const got = (sample: boolean, variance: boolean): string | null => { const v = stddev(n, sumX, sumX2, sample, variance); return v === null ? null : numericText(v); };
    assert.deepEqual({ ss: got(true, false), sp: got(false, false), vs: got(true, true), vp: got(false, true) }, want, set.join(", "));
  }
});

test("binary: numeric_send's groups, weight, sign and scale", async () => {
  for (const v of VALUES) {
    const r = await db.query<{ b: Uint8Array }>(`SELECT numeric_send(${lit(v)}) AS b`);
    assert.equal(numericBinary(parseNumeric(v)).toString("hex"), Buffer.from(r.rows[0]!.b).toString("hex"), v);
  }
});

test("the aggregate types are Postgres's (pg_aggregate)", async () => {
  const types: Record<string, string> = { int2: "smallint", int4: "integer", int8: "bigint", float4: "real", float8: "double precision" };
  const oidName: Record<number, string> = { 20: "int8", 21: "int2", 23: "int4", 700: "float4", 701: "float8", 1700: "numeric" };
  for (const [api, pgName] of Object.entries(types)) {
    for (const [agg, fn] of [["sum", "sum"], ["average", "avg"], ["min", "min"], ["max", "max"], ["count", "count"]] as const) {
      const r = await db.query(`SELECT ${fn}(x) AS v FROM (SELECT NULL::${pgName} AS x) AS t`);
      assert.equal(aggregateType(agg, api), oidName[r.fields[0]!.dataTypeID], `${fn}(${pgName})`);
    }
  }
  // a percentile is a double precision in Postgres (percentile_cont)
  const r = await db.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) AS v FROM (SELECT 1::bigint AS x) AS t`);
  assert.equal(aggregateType("percentile", "int8"), oidName[r.fields[0]!.dataTypeID]);
  // an average of an argument whose type is unknown (a metric's `sql:` expression) is a float8: it may hold a float,
  // and a numeric would claim digits the answer does not have (the review of #508)
  assert.equal(aggregateType("average", null), "float8");
});

/** a sanity check of the generator: the cases cross the group boundaries the scale rule reads */
test("the values reach every weight the scale rule distinguishes", () => {
  const scales = new Set(VALUES.flatMap((a) => VALUES.filter((b) => Number(b) !== 0).map((b) => divScale(parseNumeric(a), parseNumeric(b)))));
  assert.ok(scales.size >= 8, `only ${scales.size} distinct quotient scales`);
  const n: PgNumeric = parseNumeric("0.000");
  assert.equal(numericText(n), "0.000");
});

test("pad: a value DuckDB holds with fewer decimals is written at Postgres's display scale, never rounded", () => {
  const pad = (key: string, scale: number) => ({ op: "pad" as const, arg: { op: "cell" as const, key }, scale });
  assert.equal(evaluateText(pad("v", 30), { v: "19.99" }), "19.990000000000000000000000000000");
  assert.equal(evaluateText(pad("v", 2), { v: "-7" }), "-7.00");
  assert.equal(evaluateText(pad("v", 2), { v: "1.125" }), "1.125");
  assert.equal(evaluateText(pad("v", 2), { v: null }), null);
  // a quotient's scale follows its dividend's display scale: padded first, Postgres's numeric(65,30) / 3
  assert.equal(evaluateText({ op: "div", args: [pad("v", 30), { op: "literal", text: "3" }] }, { v: "1" }), "0.333333333333333333333333333333");
});

test("pick: a CASE computes only the arm the row took; past the arms (no ELSE), NULL", () => {
  const p: NumericProgram = { op: "pick", index: { op: "cell", key: "i" }, args: [{ op: "literal", text: "0" }, { op: "div", args: [{ op: "cell", key: "a" }, { op: "literal", text: "3.0" }] }] };
  assert.equal(evaluateText(p, { i: "0", a: "0" }), "0", "the integer arm: 0, never the quotient's 0.00000000000000000000");
  assert.equal(evaluateText(p, { i: "1", a: "2" }), "0.66666666666666666667");
  assert.equal(evaluateText(p, { i: "2", a: "2" }), null);
  assert.equal(evaluateText(p, { i: null, a: "2" }), null);
  // the arm not taken is never computed: a division by zero there raises nothing
  assert.equal(evaluateText({ op: "pick", index: { op: "cell", key: "i" }, args: [{ op: "literal", text: "1" }, { op: "div", args: [{ op: "literal", text: "1" }, { op: "literal", text: "0" }] }] }, { i: "0" }), "1");
});
