/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review rounds 5
 * and 6: every reason against every wrapper, and a run's failure as Postgres's error. Each test runs its own world
 * (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser, parseSql } from "../src/api/postgres/parser.ts";
import { deparseSync } from "pgsql-deparser";
import { COUNTS, served } from "./duck-generated-world.ts";
import { overLedger, typed, VAR, PER, PERFIX, TEXT, DIV, SCALE, HELD, ROWS, PICKS, DOUBLE } from "./duck-generated-ledger.ts";

after(() => stopParser());

// review round 5 of PR 202, class A: a refusal's reason and way out come from the form the walk carried up, through any
// wrapper (an operator, a coalesce, a round or trunc, a cast with a typmod, an aggregate), never from the engine type,
// the outermost node or a constant: every reason against every wrapper that reaches it, the way out naming the user's
// own function, and each way out built and stored

const REASONS: Record<string, [string, RegExp, string]> = {
  // (the variance family, sqrt and its kin, and a cast from a double: round 6's table, which holds each way out whole)
  tbare: ["SELECT (payload ->> 'a')::numeric AS x FROM events", TEXT, "CAST(payload ->> 'a' AS numeric(20, 4)) AS x"],
  top: ["SELECT (payload ->> 'a')::numeric + 1 AS x FROM events", TEXT, "CAST(payload ->> 'a' AS numeric(20, 4)) + 1 AS x"],
  tco: ["SELECT coalesce((payload ->> 'a')::numeric, 0) AS x FROM events", TEXT, "COALESCE(CAST(payload ->> 'a' AS numeric(20, 4)), 0) AS x"],
  tround: ["SELECT trunc((payload ->> 'a')::numeric, 2) AS x FROM events", TEXT, "trunc(CAST(payload ->> 'a' AS numeric(20, 4)), 2) AS x"],
  tmax: ["SELECT max((payload ->> 'a')::numeric) AS x FROM events", TEXT, "max(CAST(payload ->> 'a' AS numeric(20, 4))) AS x"],
  tmin: ["SELECT min((payload ->> 'a')::numeric) AS x FROM events", TEXT, "min(CAST(payload ->> 'a' AS numeric(20, 4))) AS x"],
  tsum: ["SELECT sum((payload ->> 'a')::numeric) AS x FROM events", ROWS, "sum(CAST(payload ->> 'a' AS numeric(20, 4))) AS x"],
  dbare: ["SELECT amount / 3 AS x FROM ledger", DIV, "AS double precision)"],
  dop: ["SELECT amount / 3 + 1 AS x FROM ledger", DIV, "AS double precision)"],
  dco: ["SELECT coalesce(amount / 3, 0) AS x FROM ledger", DIV, "AS double precision)"],
  dround: ["SELECT round(amount / 3, 2) AS x FROM ledger", DIV, "AS double precision)"],
  dtyp: ["SELECT (amount / 3)::numeric(10,2) AS x FROM ledger", DIV, "AS double precision)"],
  dsum: ["SELECT sum(amount / 3) AS x FROM ledger", DIV, "AS double precision)"],
  dmax: ["SELECT max(amount / 3) AS x FROM ledger", DIV, "AS double precision)"],
  davg: ["SELECT avg(amount) AS x FROM ledger", DIV, "AS double precision)"],
  sop: ["SELECT wide + 1 AS x FROM ledger", SCALE(30), "round("],
  sco: ["SELECT coalesce(wide * 1, wide) AS x FROM ledger", SCALE(30), "round("],
  styp: ["SELECT (wide + 1)::numeric(40,20) AS x FROM ledger", SCALE(20), "round("],
  ssum: ["SELECT sum(wide) AS x FROM ledger", SCALE(30), "round("],
  rop: ["SELECT sum((payload ->> 'a')::numeric) + 1 AS x FROM events", ROWS, "AS numeric(20, 4))"],
  rco: ["SELECT coalesce(sum((payload ->> 'a')::numeric), 0) AS x FROM events", ROWS, "AS numeric(20, 4))"],
  rround: ["SELECT round(sum((payload ->> 'a')::numeric), 2) AS x FROM events", HELD(36), "AS numeric(20, 4))"],
  kbare: ["SELECT greatest(amount, 1) AS x FROM ledger", PICKS, "AS numeric(38, 2)) AS x"],
  kop: ["SELECT greatest(amount, 1) + 1 AS x FROM ledger", PICKS, "AS numeric(38, 2)) AS x"],
  kco: ["SELECT coalesce(amount, 0) AS x FROM ledger", PICKS, "AS numeric(38, 2)) AS x"],
};
// each way out, written over the same columns as the user would: stored
const WAYS_OUT: Record<string, string> = {
  wtext: "SELECT max((payload ->> 'a')::numeric(20,4)) AS x, min((payload ->> 'a')::numeric(20,4)) AS y FROM events",
  wtextop: "SELECT id, (payload ->> 'a')::numeric(20,4) + 1 AS x, coalesce((payload ->> 'a')::numeric(20,4), 0.0000) AS y FROM events",
  wdiv: "SELECT sum(amount) AS total, count(amount) AS n FROM ledger",
  wscale: "SELECT round(sum(wide), 2) AS x FROM ledger",
  wrows: "SELECT sum((payload ->> 'a')::numeric(20,4)) + 1 AS x FROM events",
  wpicks: "SELECT greatest(amount, 1)::numeric(12,2) AS x FROM ledger",
};
// every function a way out may name: one the user did not write is never named
const FUNCTIONS = ["stddev", "var_pop", "var_samp", "variance", "sqrt", "exp", "ln", "log", "power", "max", "min"];
test("round 5: every reason against every wrapper says the form's reason and a way out naming the user's own function, and each way out is stored", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(REASONS)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const [name, sql] of Object.entries(WAYS_OUT)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(REASONS)) await w.until((s) => s.state === "refused" || s.serving, `public.${name}`);
    const wrong: string[] = [];
    for (const [name, [sql, reason, way]] of Object.entries(REASONS)) {
      const refusals = w.status(`public.${name}`).refusals;
      const said = refusals.map((r) => `${r.message} | ${r.options.join(" | ")}`).join(" || ");
      const strays = FUNCTIONS.filter((f) => !sql.includes(`${f}(`) && new RegExp(`\\b${f}\\(`).test(said));
      if (refusals.length !== 1 || !reason.test(refusals[0]!.message) || !refusals[0]!.options.some((o) => o.includes(way)) || strays.length > 0
        || /engine computes as a double \(|\(…\)|holds as a double/.test(said)) wrong.push(`${name}: ${sql}\n    ${said || "(not refused)"}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    for (const name of Object.keys(WAYS_OUT)) await w.until(served(w.logged), `public.${name}`);
    assert.deepEqual((await typed(w, "SELECT x, y FROM wtext")).rows, [["2.0000", "1.0000"]]);
  });
});

// review round 5 of PR 202, class B: a run's failure is said through the ONE mapping a statement on the wire gets
// (src/duck/store.ts `pgErrorOf`): Postgres's message and SQLSTATE, never the engine's words or Mason's own marker
test("round 5: a run's failure is Postgres's error, by the wire's one mapping: an integer's overflow, a division by zero, a text that is not a number", async () => {
  const files: Record<string, [string, RegExp]> = {
    i8: ["SELECT id * 2 AS x FROM ledger", /^bigint out of range \(SQLSTATE 22003\)/],
    i4: ["SELECT n * 2 AS x FROM ledger", /^integer out of range \(SQLSTATE 22003\)/],
    zero: ["SELECT 10 / (id - 1) AS x FROM ledger", /^division by zero \(SQLSTATE 22012\)/],
    tnum: ["SELECT kind::numeric(10,3) AS x FROM events", /^invalid input syntax for type numeric: … \(SQLSTATE 22P02\)/],
    tint: ["SELECT kind::int AS x FROM events", /^invalid input syntax for type integer: … \(SQLSTATE 22P02\)/],
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(files)) w.write(name, `kind: scheduled\ntarget_lag: 1h\nsql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "failed", `public.${name}`);
    for (const [name, [, words]] of Object.entries(files)) {
      const error = w.status(`public.${name}`).error ?? "";
      assert.match(error, words, name);
      assert.doesNotMatch(error, /Overflow in|INT64|INT32|TRY\(|error_on_division|mason\[|Invalid Input|Conversion Error|DECIMAL|__mason_|query/, `${name}: ${error}`);
    }
  });
});

// review round 6 of PR 202, class A: the reason is what each node computes AS POSTGRES TYPES IT (a node over a double is a
// double, whatever its kind; a name the statement resolves only to a double-returning function is one), and the way out
// is the user's own expression with only the cast moved, every aggregate and wrapper kept: each case's reason, its way
// out exactly (compared as Postgres reads it back), and each way out written as a table and held stored (round 5's
// variance, sqrt-and-kin and double rows moved here, where the way out is held whole)
const R6: Record<string, [string, RegExp, string | null]> = {
  // a double carried up from below: whatever the node's own kind, Postgres computes a double, and the numeric is its cast
  davg: ["avg(amount::float8)::numeric", DOUBLE, "avg(amount::float8)"],
  ddiv: ["(amount::float8 / 2)::numeric", DOUBLE, "amount::float8 / 2"],
  dsqrt: ["sqrt(amount::float8)::numeric", DOUBLE, "sqrt(amount::float8)"],
  dresolved: ["sqrt(n)::numeric", DOUBLE, "sqrt(n)"],
  dstddev: ["stddev(big)::float8::numeric", DOUBLE, "stddev(big)::float8"],
  dvariance: ["variance(amount::float8)::numeric(20,4)", DOUBLE, "variance(amount::float8)"],
  dround: ["round(exp(amount::float8)::numeric, 2)", DOUBLE, "round(exp(amount::float8)::numeric, 2)::double precision"],
  dsum: ["sum(ln(abs(amount))::float8)::numeric", DOUBLE, "sum(ln(abs(amount))::float8)"],
  dgreatest: ["greatest(amount / 3, amount::float8)::numeric", DOUBLE, "greatest(amount / 3, amount::float8)"],
  dcoalesce: ["coalesce(stddev(big), max(amount)::float8)::numeric", DOUBLE, "coalesce(stddev(big), max(amount)::float8)"],
  // a count over a double is a bigint, and what divides it is an exact division (round 7: its way out, the user's own)
  dcount: ["count(amount::float8)::numeric / 3", DIV, "(count(amount::float8)::numeric / 3)::double precision"],
  // sqrt and its kin over an exact numeric: the cast on the function, the aggregate and the wrapper kept
  psum: ["sum(sqrt(abs(amount)))", PER("sqrt"), "sum(sqrt(abs(amount))::double precision)"],
  pmax: ["max(ln(abs(amount)))", PER("ln"), "max(ln(abs(amount))::double precision)"],
  psumround: ["round(sum(sqrt(abs(amount))), 2)", PERFIX("sqrt"), "round(sum(sqrt(abs(amount))), 2)::double precision"],
  pbare: ["sqrt(abs(amount))", PER("sqrt"), "sqrt(abs(amount))::double precision"],
  pexp: ["exp(amount)", PER("exp"), "exp(amount)::double precision"],
  pop: ["ln(abs(amount)) + 1", PER("ln"), "ln(abs(amount))::double precision + 1"],
  pco: ["coalesce(sqrt(abs(amount)), 0)", PER("sqrt"), "coalesce(sqrt(abs(amount))::double precision, 0)"],
  ppow: ["power(amount, 2)", PER("power"), "power(amount, 2)::double precision"],
  plog: ["log(10, abs(amount))", PER("log"), "log(10, abs(amount))::double precision"],
  pround: ["round(log(abs(amount)), 2)", PERFIX("log"), "round(log(abs(amount)), 2)::double precision"],
  ptyp: ["exp(amount)::numeric(10,2)", PERFIX("exp"), "exp(amount)::double precision"],
  // the variance family over an exact numeric
  vbare: ["stddev(big)", VAR("stddev"), "stddev(big)::double precision"],
  vop: ["stddev(big) * 2", VAR("stddev"), "stddev(big)::double precision * 2"],
  vco: ["coalesce(stddev(big), 0)", VAR("stddev"), "coalesce(stddev(big)::double precision, 0)"],
  vround: ["round(stddev(big), 2)", VAR("stddev"), "round(stddev(big), 2)::double precision"],
  vtyp: ["stddev(big)::numeric(20,4)", VAR("stddev"), "stddev(big)::double precision"],
  vop2: ["var_pop(amount) + 1", VAR("var_pop"), "var_pop(amount)::double precision + 1"],
  vco2: ["coalesce(var_samp(amount), 0)", VAR("var_samp"), "coalesce(var_samp(amount)::double precision, 0)"],
  // a numeric cast from a double: the cast taken away, a round over it kept with the cast to double above it
  fbare: ["amount::float8::numeric", DOUBLE, "amount::float8"],
  fop: ["amount::float8::numeric + 1", DOUBLE, "amount::float8 + 1"],
  fco: ["coalesce(amount::float8::numeric, 0)", DOUBLE, "coalesce(amount::float8, 0)"],
  fround: ["round(amount::float8::numeric, 2)", DOUBLE, "round(amount::float8::numeric, 2)::double precision"],
  ftyp: ["amount::float8::numeric(10,2)", DOUBLE, "amount::float8"],
  fsum: ["sum(n::float8)::numeric", DOUBLE, "sum(n::float8)"],
  fmax: ["max(amount::float8::numeric)", DOUBLE, "max(amount::float8)"],
};
/** an expression as Postgres reads it back: one spelling for `::float8`, `CAST(… AS double precision)` and the rest; a
 *  text that is not SQL is itself, and so never equal to the way out */
const asRead = async (expr: string): Promise<string> => {
  try { return deparseSync((await parseSql(`SELECT ${expr} AS x`)).stmts![0]!.stmt!, { pretty: false }); }
  catch { return `not SQL: ${expr}`; }
};
test("round 6: a numeric's reason is the type each node computes as Postgres types it, and its way out is the user's own expression, aggregate kept, and stores", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(R6)) w.write(name, `${lag}sql: SELECT ${sql} AS x FROM ledger\n`);
    for (const name of Object.keys(R6)) await w.until((s) => s.state === "refused" || s.serving, `public.${name}`);
    const wrong: string[] = [];
    for (const [name, [sql, reason, way]] of Object.entries(R6)) {
      const refusals = w.status(`public.${name}`).refusals;
      const said = refusals.map((r) => `${r.message} | ${r.options.join(" | ")}`).join(" || ");
      const given = refusals[0]?.options.map((o) => /: (.+) AS x$/.exec(o)?.[1]).find((o) => o !== undefined);
      const ok = refusals.length === 1 && reason.test(refusals[0]!.message)
        && (way === null || (given !== undefined && await asRead(given) === await asRead(way)));
      if (!ok) wrong.push(`${name}: ${sql}\n    ${said || "(not refused)"}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    // each way out, as the refusal gives it: stored, as a double
    const ways = Object.entries(R6).filter(([, [, , way]]) => way !== null);
    for (const [name, [, , way]] of ways) w.write(`w${name}`, `${lag}sql: SELECT ${way} AS x FROM ledger\n`);
    for (const [name] of ways) await w.until(served(w.logged), `public.w${name}`);
    for (const [name] of ways) assert.deepEqual((await typed(w, `SELECT x FROM w${name}`)).fields.map(([, oid]) => oid), [701], name);
  });
});

// review round 6 of PR 202, class B: a numeric field overflow is ONE wording, Postgres's message and DETAIL, whichever path
// raises it: the engine's DECIMAL cast, and a Mason function's error carried as mason[22003]
test("round 6: a numeric field overflow says Postgres's DETAIL on every path: the engine's cast, and a cast a Mason function computes", async () => {
  const words = /^numeric field overflow \(SQLSTATE 22003\)\. A field with precision 10, scale 3 must round to an absolute value less than 10\^7\. Give the value/;
  const files: Record<string, string> = {
    oengine: "SELECT (id::text || '00000000000')::numeric(10,3) AS x FROM ledger",
    ofunction: "SELECT (id::text || '00000000000')::numeric(10,3)::double precision AS x FROM ledger",
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, sql] of Object.entries(files)) w.write(name, `kind: scheduled\ntarget_lag: 1h\nsql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "failed", `public.${name}`);
    for (const name of Object.keys(files)) assert.match(w.status(`public.${name}`).error ?? "", words, name);
  });
});
