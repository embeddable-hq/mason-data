/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review round 6:
 * a numeric's reason is the type each node computes, and a numeric field overflow says Postgres's DETAIL on every path.
 * Each test runs its own world (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser, parseSql } from "../src/api/postgres/parser.ts";
import { deparseSync } from "pgsql-deparser";
import { COUNTS, served } from "./duck-generated-world.ts";
import { overLedger, typed, VAR, PER, PERFIX, DIV, DOUBLE } from "./duck-generated-ledger.ts";

after(() => stopParser());

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
