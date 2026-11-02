/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: stage 3 (issue 175): a
 * numeric, an enum and a citext stored as the engine answers them; PR 202's review rounds 1 and 2. Each test runs its
 * own world (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import type { GeneratedStatus } from "../src/duck/generated.ts";
import { COUNTS, refusedAt, served } from "./duck-generated-world.ts";
import { NUMS, SUMS, KINDS, overLedger, typed } from "./duck-generated-ledger.ts";

after(() => stopParser());

test("a numeric output is stored and read back exactly, across a restart: its scale's trailing zeros, its sign, a NULL, digits past a double's", async () => {
  await overLedger({ nums: NUMS }, async (w) => {
    const r = await typed(w, "SELECT id, amount, big FROM nums ORDER BY id");
    assert.deepEqual(r.fields, [["id", 20, -1], ["amount", 1700, (12 << 16) + 2 + 4], ["big", 1700, -1]]);
    assert.deepEqual(r.rows, [["1", "1.10", "12345678901234567890.123456789"], ["3", null, null], ["9223372036854775806", "-2.50", "-0.000000001"], ["9223372036854775807", "4.00", "1.100000000"]]);
    assert.deepEqual((await typed(w, "SELECT round(amount, 1) AS r FROM nums WHERE amount < 2 AND big = 12345678901234567890.123456789 ORDER BY amount DESC NULLS LAST")).rows, [["1.1"]]);
  });
});

test("the sum forms' stored types: sum(int2) and sum(int4) as bigint, sum(int8) and sum(numeric) as numeric, past bigint's range", async () => {
  await overLedger({ sums: SUMS }, async (w, restarted) => {
    const r = await typed(w, "SELECT * FROM sums ORDER BY mood");
    assert.deepEqual(r.fields.map(([n, oid]) => [n, oid]).slice(1), [["s2", 20], ["s4", 20], ["s8", 1700], ["sa", 1700], ["mb", 1700]]);
    assert.deepEqual(r.rows, [["sad", "32769", "4294967294", "18446744073709551613", "1.50", "1.100000000"], ["ok", "3", null, "3", null, null], ["happy", "1", "10", "1", "1.10", "12345678901234567890.123456789"]]);
    if (restarted) return;
    const stored = await w.rows("SELECT column_name, data_type FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = 'sums' AND column_name <> 'mood' ORDER BY column_index");
    assert.deepEqual(stored, [["s2", "BIGINT"], ["s4", "BIGINT"], ["s8", "HUGEINT"], ["sa", "DECIMAL(38,2)"], ["mb", "DECIMAL(38,9)"]]);
  });
});

test("an enum and a citext are stored and read back: the enum's declared order and type, the citext's case-blind equality", async () => {
  await overLedger({ kinds: KINDS }, async (w) => {
    const r = await typed(w, "SELECT id, mood, name FROM kinds ORDER BY mood, id");
    const oids = (await typed(w, "SELECT 'mood'::regtype::oid::int, 'citext'::regtype::oid::int")).rows[0];
    assert.deepEqual([r.fields[1]![1], r.fields[2]![1]], oids, "the catalog's own types");
    assert.deepEqual(r.rows.map((x) => x[1]), ["sad", "sad", "ok", "happy"], "the declared order, not the alphabet's");
    assert.deepEqual((await typed(w, "SELECT count(*) FROM kinds WHERE mood = 'sad'")).rows, [["2"]]);
    assert.deepEqual((await typed(w, "SELECT id FROM kinds WHERE name = 'ALICE' ORDER BY id")).rows, [["1"], ["9223372036854775806"]]);
  });
});

// review round 1 of PR 202 (docs/the PR's "Review round"): ONE source of an enum's labels, the synced table's
test("a value added to a base's enum is the synced table's at once, whatever a generated table built before it stored, which answers as a stale table", async () => {
  await overLedger({ kinds: KINDS }, async (w, restarted) => {
    if (restarted) return;
    // as a re-copy after ALTER TYPE mood ADD VALUE 'meh' BEFORE 'ok' leaves it: the synced ENUM with the new label, and a row of it
    await w.store.writer.run("CREATE OR REPLACE TABLE public.ledger AS SELECT id, n, small, amount, big, wide, CAST(CAST(mood AS VARCHAR) AS ENUM('sad', 'meh', 'ok', 'happy')) AS mood, name FROM public.ledger");
    await w.store.writer.run("INSERT INTO public.ledger VALUES (7, 1, 1, 1.00, 1.000000000, 1.00, 'meh', 'Mia')");
    await (w.sync as unknown as { rebuildSchema(): Promise<void> }).rebuildSchema();
    const stored = await w.rows("SELECT data_type FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = 'kinds' AND column_name = 'mood'");
    assert.doesNotMatch(String(stored[0]![0]), /meh/, "the generated table holds the ENUM it was built with: declared after the synced table, it does not decide the labels");
    assert.deepEqual((await typed(w, "SELECT count(*) FROM ledger WHERE mood = 'meh'")).rows, [["1"]]);
    assert.deepEqual((await typed(w, "SELECT 'meh'::mood AS m")).rows, [["meh"]]);
    assert.deepEqual((await typed(w, "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'mood'::regtype ORDER BY enumsortorder")).rows, [["sad"], ["meh"], ["ok"], ["happy"]]);
    assert.deepEqual((await typed(w, "SELECT id FROM kinds WHERE mood = 'meh'")).rows, [], "stale, as Postgres over a table built before the change");
    assert.deepEqual((await typed(w, "SELECT mood FROM kinds ORDER BY mood, id")).rows.map((x) => x[0]), ["sad", "sad", "ok", "happy"]);
  });
});

const COMPUTED = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, -amount AS neg, amount + 1 AS plus, abs(amount) AS size, amount::numeric(10,3) AS widened FROM ledger\norder_by: id\n";
const TOTALS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT sum(amount) * 2 AS twice, round(sum(amount), 1) AS r, floor(sum(amount)) AS f, round(sum(wide), 2) AS w FROM ledger\n";

test("a numeric whose scale the types fix is stored with Postgres's digits: negated, added to, multiplied, rounded, cast to a typmod", async () => {
  await overLedger({ computed: COMPUTED, totals: TOTALS }, async (w) => {
    const r = await typed(w, "SELECT * FROM computed ORDER BY id");
    assert.deepEqual(r.fields.map(([n, oid, mod]) => [n, oid, n === "widened" ? mod : null]), [["id", 20, null], ["neg", 1700, null], ["plus", 1700, null], ["size", 1700, null], ["widened", 1700, (10 << 16) + 3 + 4]]);
    assert.deepEqual(r.rows, [["1", "-1.10", "2.10", "1.10", "1.100"], ["3", null, null, null, null], ["9223372036854775806", "2.50", "-1.50", "2.50", "-2.500"], ["9223372036854775807", "-4.00", "5.00", "4.00", "4.000"]]);
    assert.deepEqual((await typed(w, "SELECT * FROM totals")).rows, [["5.20", "2.6", "2", "2.75"]]);
  });
});

test("a numeric the types don't fix is refused with its own reason: a division, a variance, a scale past 18, a scale the rows or a picked value decide, a double's", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  const refusedFiles: Record<string, string> = {
    mean: "SELECT avg(n) AS mean FROM ledger",
    wide: "SELECT sum(wide) AS total FROM ledger",
    texts: "SELECT sum((payload ->> 'a')::numeric) AS total FROM events",
    larger: "SELECT greatest(amount, 1) AS top FROM ledger",
    spread: "SELECT stddev(amount) AS sd FROM ledger",
    varied: "SELECT variance(amount) AS v FROM ledger",
    // review round 2, finding 2: an integer's scale is 0, never "unknown", so the 30 decimals are seen
    idwide: "SELECT sum(id) + sum(wide) AS a FROM ledger",
    bigwide: "SELECT sum(big) + sum(wide) AS b FROM ledger",
    timeswide: "SELECT sum(wide) * sum(id) AS m FROM ledger",
    negwide: "SELECT -sum(wide) AS n FROM ledger",
    floated: "SELECT sum(n::float8)::numeric AS d FROM ledger",
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, sql] of Object.entries(refusedFiles)) w.write(name, `${lag}sql: ${sql}\n`);
    w.write("mixed", `${lag}sql: SELECT sum(amount) + sum(big) AS combined FROM ledger\n`);
    w.write("spreadout", `${lag}sql: SELECT stddev(amount)::double precision AS sd FROM ledger\n`);
    w.write("picked", `${lag}sql: SELECT round(sum(id) + sum(wide), 2) AS a, greatest(sum(amount), 1)::numeric(12,2) AS g FROM ledger\n`);
    // each file read and planned, under load too: a review already in flight when they were written may not have read them
    for (const name of Object.keys(refusedFiles)) await w.until((s) => s.state === "refused", `public.${name}`);
    const r = (name: string): GeneratedStatus => w.status(`public.${name}`);
    const says = (name: string, message: RegExp, option: string): void => {
      refusedAt(r(name).refusals, "sql", message);
      assert.ok(r(name).refusals[0]!.options.some((o) => o.includes(option)), `${name}: ${JSON.stringify(r(name).refusals)}`);
    };
    says("mean", /^column mean divides a numeric, which the engine computes as a double$/, "CAST(avg(n) AS double precision) AS mean");
    says("wide", /^column total has 30 decimals, more than the 18 a stored numeric keeps$/, "round(");
    says("texts", /^column total sums values Postgres keeps at differing scales, so the rows decide its decimals$/, "sum(CAST(payload ->> 'a' AS numeric(20, 4))) AS total");
    says("larger", /^column top is whichever value a GREATEST, LEAST, COALESCE or CASE takes, at that value's own decimals, and its values have differing ones$/, "CAST(GREATEST(amount, 1) AS numeric(38, 2)) AS top");
    says("spread", /^column sd is a stddev, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double$/, "CAST(stddev(amount) AS double precision) AS sd");
    says("varied", /^column v is a variance, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double/, "CAST(variance(amount) AS double precision) AS v");
    for (const [name, col] of [["idwide", "a"], ["bigwide", "b"], ["timeswide", "m"], ["negwide", "n"]]) says(name!, new RegExp(`^column ${col} has 30 decimals, more than the 18`), "round(");
    says("floated", /^column d is a numeric cast from a double precision value/, "store the double it is: sum(n::float8) AS d");
    for (const name of Object.keys(refusedFiles)) assert.doesNotMatch(JSON.stringify(r(name).refusals), name === "mean" ? /no fixed scale|can't store exactly yet/ : /no fixed scale|can't store exactly yet|divides a numeric/, name);
    // each refusal's way out is stored: a sum of an unconstrained numeric's synced column is one cell at the scale its
    // DECIMAL holds; a stddev as a double; the 30 decimals rounded; a picked value given one scale (#205: `served`, not `built`)
    for (const name of ["mixed", "spreadout", "picked"]) await w.until(served(w.logged), `public.${name}`);
    assert.deepEqual((await typed(w, "SELECT combined FROM mixed")).rows, [["12345678901234567893.823456788"]]);
    assert.equal((await typed(w, "SELECT sd FROM spreadout")).fields[0]![1], 701);
    assert.deepEqual((await typed(w, "SELECT a, g FROM picked")).rows, [["18446744073709551619.75", "2.60"]]);
  });
});

// review round 2 of PR 202, finding 1: a numeric Postgres types from integers, under any function, is stored from the
// engine type DuckDB says it computes (a sum of int8 is a HUGEINT, whose floor is a double's), never an assumed one
const INTEGRAL = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT floor(sum(id)) AS f, ceil(sum(id)) AS c, floor(sum(id) + sum(n)) AS fn, abs(-sum(id)) AS a, " +
  "round(sum(id), -1) AS r, sum(id) * 2 AS m, mod(sum(id), 10) AS md, trunc(sum(id), -2) AS t, greatest(sum(id), 1) AS g FROM ledger\n";

test("an integer Postgres types as numeric is stored with its digits under any function: floor, ceil, abs, round, mod, trunc, greatest of sum(int8)", async () => {
  await overLedger({ integral: INTEGRAL }, async (w) => {
    const r = await typed(w, "SELECT * FROM integral");
    assert.deepEqual(r.fields.map(([, oid]) => oid), Array(9).fill(1700));
    assert.deepEqual(r.rows, [["18446744073709551617", "18446744073709551617", "18446744078004518921", "18446744073709551617", "18446744073709551620",
      "36893488147419103234", "7", "18446744073709551600", "18446744073709551617"]]);
  });
});

// review round 2 of PR 202, finding 3: each form stored, or refused for its own reason (the PR's "Review round 2" table)
const FORMS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, round(amount * 10, -1) AS r1, round(amount, -1) AS r0, trunc(amount, 1) AS t, trunc(amount * 10, -1) AS t1, " +
  "amount::numeric(40,2) AS w, mod(amount, 3) AS md, coalesce(amount, 0.00) AS co, greatest(amount, 1.00) AS g, CASE WHEN amount > 0 THEN amount ELSE 0.00 END AS k, " +
  "greatest(amount, 1)::numeric(12,2) AS gc, -amount * n AS mi FROM ledger\norder_by: id\n";
const AGGREGATES = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT min(amount) AS lo, max(amount) AS hi, sum(amount) AS s, round(sum(amount), 5) AS r5, round(max(big), 4) AS rb FROM ledger\n";

test("each numeric form whose scale the types fix is stored with Postgres's digits: round to tens, trunc, mod, a typmod past 38, COALESCE, GREATEST, CASE of one scale", async () => {
  await overLedger({ forms: FORMS, aggregates: AGGREGATES }, async (w) => {
    const r = await typed(w, "SELECT * FROM forms ORDER BY id");
    assert.equal(r.fields.find(([n]) => n === "w")![2], (40 << 16) + 2 + 4, "numeric(40,2) on the wire");
    assert.deepEqual(r.rows.map((x) => x.slice(1)), [
      ["10", "0", "1.1", "10", "1.10", "1.10", "1.10", "1.10", "1.10", "1.10", "-11.00"],
      [null, null, null, null, null, null, "0.00", "1.00", "0.00", "1.00", null],
      ["-30", "0", "-2.5", "-20", "-2.50", "-2.50", "-2.50", "1.00", "0.00", "1.00", "5368709117.50"],
      ["40", "0", "4.0", "40", "4.00", "1.00", "4.00", "4.00", "4.00", "4.00", "-8589934588.00"],
    ]);
    assert.deepEqual((await typed(w, "SELECT * FROM aggregates")).rows, [["-2.50", "4.00", "2.60", "2.60000", "12345678901234567890.1235"]]);
  });
});

// issue 242: an integer column converted from a numeric holds the plan's SQL's value, which the rewrite's CAST reader
// computes exactly (rounded half away from zero, as numeric_int4) or refuses by name, never the engine's double's half to even
const scheduledH = (sql: string, orderBy?: string): string => `kind: scheduled\ntarget_lag: 1h\nsql: ${sql}\n${orderBy === undefined ? "" : `order_by: ${orderBy}\n`}`;
const ROUNDED = scheduledH("SELECT id, (amount / 1.6)::int AS q4, (amount / 1.6)::int8 AS q8, CAST(amount / 1.6 AS integer) AS c4, CAST(amount / 1.6 AS bigint) AS c8, " +
  "(amount / 1)::int AS half, sqrt(abs(amount) * 1.5625)::int AS sq, (n / 4.0)::int AS n4, nullif(amount / 1.6, 0)::int AS nz, nullif(amount / 1.6, 0)::int8 AS nz8, " +
  "nullif(amount / 1.6, 2.5)::int AS ne, (exp(ln(2.5)) * sign(amount))::int AS ex, sign(amount)::int AS sg, nullif(amount, 0)::int AS nd, (amount * 2)::int AS tw, " +
  "trunc(amount / 1.6)::int AS tr, round(amount / 1.6)::int AS ro, ((amount / 1.6)::float8)::int AS fl, (amount::float8 / 1.6)::int8 AS fd, " +
  "(lag(amount / 1.6) OVER (ORDER BY id))::int AS lg FROM ledger", "id");
const ROUNDED_TOTALS = scheduledH("SELECT (avg(amount) * 3 / 1.04)::int AS a, (max(amount / 1.6))::int AS mx, (min(amount / 1.6))::int AS mn, " +
  "(sum(amount) / nullif(count(*), 0))::int AS pc, round(100.0 * sum(amount) / nullif(sum(n), 0))::int AS r FROM ledger");
const ROUNDED_READS = {
  derived: scheduledH("SELECT id, x::int AS x FROM (SELECT id, amount / 1.6 AS x FROM ledger) s", "id"),
  ctes: scheduledH("WITH s AS (SELECT id, amount / 1.6 AS q FROM ledger) SELECT id, q::int AS x FROM s", "id"),
  unioned: scheduledH("SELECT id, (amount / 1.6)::int AS x FROM ledger UNION ALL SELECT id, (amount / 1)::int FROM ledger"),
  grouped: scheduledH("SELECT (amount / 1.6)::int AS x, count(*) AS c FROM ledger GROUP BY 1"),
  scalar: scheduledH("SELECT id, (SELECT nullif(l2.amount / 1.6, 0)::int FROM ledger l2 WHERE l2.id = ledger.id) AS x FROM ledger", "id"),
};

test("issue 242: an integer cast of a numeric the engine holds as a double is stored rounded half away from zero, or refused at load by name", async () => {
  await overLedger({ rounded: ROUNDED, roundedtotals: ROUNDED_TOTALS, ...ROUNDED_READS }, async (w, restarted) => {
    const r = await typed(w, "SELECT * FROM rounded ORDER BY id");
    assert.deepEqual(r.fields.map(([n, oid]) => [n, oid]).slice(1, 5), [["q4", 23], ["q8", 20], ["c4", 23], ["c8", 20]]);
    const text = (v: unknown): unknown => v === null ? null : String(v);
    const byColumn = (name: string): unknown[] => r.rows.map((x) => text(x[r.fields.findIndex(([n]) => n === name)]));
    const want: Record<string, unknown[]> = {
      q4: ["1", null, "-2", "3"], q8: ["1", null, "-2", "3"], c4: ["1", null, "-2", "3"], c8: ["1", null, "-2", "3"],
      half: ["1", null, "-3", "4"], sq: ["1", null, "2", "3"], n4: ["3", null, "536870912", "536870912"],
      nz: ["1", null, "-2", "3"], nz8: ["1", null, "-2", "3"], ne: ["1", null, "-2", null], ex: ["3", null, "-3", "3"],
      sg: ["1", null, "-1", "1"], nd: ["1", null, "-3", "4"], tw: ["2", null, "-5", "8"], tr: ["0", null, "-1", "2"], ro: ["1", null, "-2", "3"],
      fl: ["1", null, "-2", "2"], fd: ["1", null, "-2", "2"], lg: [null, "1", null, "-2"],
    };
    for (const [name, values] of Object.entries(want)) assert.deepEqual(byColumn(name), values, `${name}${restarted ? ", after the restart" : ""}`);
    assert.deepEqual((await typed(w, "SELECT * FROM roundedtotals")).rows.map((x) => x.map(text)), [["3", "3", "-2", "1", "0"]]);
    for (const name of ["derived", "ctes", "scalar"]) assert.deepEqual((await typed(w, `SELECT id, x FROM ${name} ORDER BY id`)).rows.map((x) => text(x[1])), ["1", null, "-2", "3"], name);
    assert.deepEqual((await typed(w, "SELECT id, x FROM unioned ORDER BY id, x")).rows.map((x) => text(x[1])), ["1", "1", null, null, "-3", "-2", "3", "4"]);
    assert.deepEqual((await typed(w, "SELECT x, c FROM grouped ORDER BY x NULLS FIRST")).rows.map((x) => x.map(text)), [[null, "1"], ["-2", "1"], ["1", "1"], ["3", "1"]]);
    if (restarted) return;
    // no program computes it: refused at load, by the gap's words and its way out, never stored from the double
    w.write("pdisc", scheduledH("SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY amount / 1.6))::int AS x FROM ledger"));
    w.write("moded", scheduledH("SELECT (mode() WITHIN GROUP (ORDER BY amount / 1.6))::int AS x FROM ledger"));
    // a NULLIF's numeric, printed, is a division's column still
    w.write("nulled", scheduledH("SELECT id, nullif(amount / 1.6, 0) AS x FROM ledger"));
    for (const name of ["pdisc", "moded", "nulled"]) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const name of ["pdisc", "moded"]) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", /^a numeric Mason cannot compute exactly \(the engine holds it as a double\), cast to integer, is not supported by Mason/);
      assert.ok(refusals[0]!.options.some((o) => o.includes("ORDER BY (a / b)::int")), JSON.stringify(refusals));
    }
    refusedAt(w.status("public.nulled").refusals, "sql", /^column x divides a numeric, which the engine computes as a double$/);
    // its way out is stored
    w.write("pdiscint", scheduledH("SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY (amount / 1.6)::int) AS x FROM ledger"));
    await w.until(served(w.logged), "public.pdiscint");
    assert.deepEqual((await typed(w, "SELECT x FROM pdiscint")).rows.map((x) => x.map(text)), [["1"]]);
  });
});
