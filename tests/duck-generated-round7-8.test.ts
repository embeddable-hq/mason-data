/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review rounds 7
 * and 8: the walk follows a sublink, a CTE, a set operation and a subquery; every definition reaches a verdict. Each
 * test runs its own world (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import { readGenerated } from "../src/cli/generated-files.ts";
import { COUNTS, served } from "./duck-generated-world.ts";
import { overLedger, typed, VAR, PER, DIV, ROWS, PICKS, DOUBLE, TEXT_JSON } from "./duck-generated-ledger.ts";

after(() => stopParser());

// review round 7 of PR 202, class A: the walk follows a column's value wherever the analysis says it comes from (a scalar
// sublink's subselect, a CTE's query, each arm of a set operation, a subquery in FROM under any node), and a way out never
// names the output column as if its source had it: the column's own expression with the cast moved, or the query of the
// statement the cast belongs in, named in the user's words and given whole. Class B: the text, divides and picks forms,
// and the rows over a text form, give the user's own expression too, never a placeholder; a numeric read from text says
// what the analysis typed the text as. Each case: the reason, every option exactly, and each way out built and stored
const DBL = "store it as a double if it need not be exact: ", ORDBL = `or ${DBL}`;
const AT_READ = "or compute it in the statement that reads the synced table";
const DIV_READ = "or store what it divides, and divide in the statement that reads the table";
const ONE = "give it one scale: ";
const TEXT_DOUBLE = /^column x is a numeric read from text \(the text of a double precision value, cast to numeric\), which keeps the decimals each value's text has$/;
const TEXT_TEXT = /^column x is a numeric read from text \(a text value cast to numeric\), which keeps the decimals each value's text has$/;

// [the definition, its reason, its options exactly, the statements its ways out describe where they are not the column's
// own expression (`SELECT <way> AS x FROM <its table>` otherwise)]
const R7: Record<string, [string, RegExp, [string, string], string[]?]> = {
  asub: ["SELECT (SELECT stddev(big) FROM ledger) AS x FROM ledger", VAR("stddev"),
    [`${DBL}(SELECT CAST(stddev(big) AS double precision) FROM ledger) AS x`, AT_READ]],
  anested: ["SELECT (SELECT (SELECT stddev(big) FROM ledger) FROM ledger LIMIT 1) AS x FROM ledger", VAR("stddev"),
    [`${DBL}(SELECT (SELECT CAST(stddev(big) AS double precision) FROM ledger) FROM ledger LIMIT 1) AS x`, AT_READ]],
  acte: ["WITH t AS (SELECT sqrt(abs(amount)) AS v FROM ledger) SELECT sum(v) AS x FROM t", PER("sqrt"),
    [`${DBL}write the WITH query t as SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger`, AT_READ],
    ["WITH t AS (SELECT sqrt(abs(amount))::double precision AS v FROM ledger) SELECT sum(v) AS x FROM t"]],
  avar: ["WITH t AS (SELECT stddev(big) AS v FROM ledger) SELECT v AS x FROM t", VAR("stddev"),
    [`${DBL}write the WITH query t as SELECT CAST(stddev(big) AS double precision) AS v FROM ledger`, AT_READ],
    ["WITH t AS (SELECT stddev(big)::double precision AS v FROM ledger) SELECT v AS x FROM t"]],
  avarround: ["WITH t AS (SELECT var_samp(amount) AS v FROM ledger) SELECT round(v, 2) AS x FROM t", VAR("var_samp"),
    [`${DBL}CAST(round(v, 2) AS double precision) AS x`, AT_READ],
    ["WITH t AS (SELECT var_samp(amount) AS v FROM ledger) SELECT round(v, 2)::double precision AS x FROM t"]],
  afrom: ["SELECT sum(v) AS x FROM (SELECT sqrt(abs(amount)) AS v FROM ledger) AS s", PER("sqrt"),
    [`${DBL}write the subquery s as SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger`, AT_READ],
    ["SELECT sum(v) AS x FROM (SELECT sqrt(abs(amount))::double precision AS v FROM ledger) AS s"]],
  aunion: ["SELECT sqrt(abs(amount)) AS x FROM ledger UNION ALL SELECT amount FROM ledger", PER("sqrt"),
    [`${DBL}write the UNION ALL as SELECT CAST(sqrt(abs(amount)) AS double precision) AS x FROM ledger UNION ALL SELECT amount FROM ledger`, AT_READ],
    ["SELECT sqrt(abs(amount))::double precision AS x FROM ledger UNION ALL SELECT amount FROM ledger"]],
  ajson: ["SELECT (payload ->> 'a')::numeric AS x FROM events UNION ALL SELECT (payload ->> 'b')::numeric FROM events", TEXT_JSON,
    [`${ONE}write the UNION ALL as SELECT CAST(payload ->> 'a' AS numeric(20, 4)) AS x FROM events UNION ALL SELECT CAST(payload ->> 'b' AS numeric(20, 4)) FROM events`,
      `${ORDBL}write the UNION ALL as SELECT CAST(payload ->> 'a' AS double precision) AS x FROM events UNION ALL SELECT CAST(payload ->> 'b' AS double precision) FROM events`],
    ["SELECT (payload ->> 'a')::numeric(20,4) AS x FROM events UNION ALL SELECT (payload ->> 'b')::numeric(20,4) FROM events",
      "SELECT (payload ->> 'a')::double precision AS x FROM events UNION ALL SELECT (payload ->> 'b')::double precision FROM events"]],
  tjson: ["SELECT (payload ->> 'a')::numeric + 1 AS x FROM events", TEXT_JSON,
    [`${ONE}CAST(payload ->> 'a' AS numeric(20, 4)) + 1 AS x`, `${ORDBL}CAST(payload ->> 'a' AS double precision) + 1 AS x`]],
  tjsonmax: ["SELECT max((payload ->> 'a')::numeric) AS x FROM events", TEXT_JSON,
    [`${ONE}max(CAST(payload ->> 'a' AS numeric(20, 4))) AS x`, `${ORDBL}max(CAST(payload ->> 'a' AS double precision)) AS x`]],
  // a double the statement computes keeps its form through the text (round 12); a stored double's text is a text's
  tdouble: ["SELECT (amount::float8::numeric)::text::numeric AS x FROM ledger", DOUBLE,
    ["store the double it is: CAST(CAST(CAST(amount::float8 AS numeric) AS text) AS double precision) AS x", AT_READ]],
  tdoublestored: ["SELECT ('1.5'::float8)::text::numeric AS x FROM ledger", TEXT_DOUBLE,
    [`${ONE}CAST(CAST('1.5'::float8 AS text) AS numeric(20, 4)) AS x`, `${ORDBL}CAST(CAST('1.5'::float8 AS text) AS double precision) AS x`]],
  ttext: ["SELECT n::numeric AS x FROM events", TEXT_TEXT,
    [`${ONE}CAST(n AS numeric(20, 4)) AS x`, `${ORDBL}CAST(n AS double precision) AS x`]],
  rjson: ["SELECT sum((payload ->> 'a')::numeric) AS x FROM events", ROWS,
    ["give the values one scale first: sum(CAST(payload ->> 'a' AS numeric(20, 4))) AS x", `${ORDBL}sum(CAST(payload ->> 'a' AS double precision)) AS x`]],
  djson: ["SELECT avg((payload ->> 'a')::numeric) AS x FROM events", DIV,
    [`${DBL}CAST(avg(CAST(payload ->> 'a' AS numeric)) AS double precision) AS x`, DIV_READ]],
  dbare: ["SELECT amount / 3 AS x FROM ledger", DIV, [`${DBL}CAST(amount / 3 AS double precision) AS x`, DIV_READ]],
  dround: ["SELECT round(avg(amount), 2) AS x FROM ledger", DIV, [`${DBL}CAST(round(avg(amount), 2) AS double precision) AS x`, DIV_READ]],
  kbare: ["SELECT greatest(amount, 1) + 1 AS x FROM ledger", PICKS,
    [`${ONE}CAST(GREATEST(amount, 1) + 1 AS numeric(38, 2)) AS x`, `${ORDBL}CAST(GREATEST(amount, 1) + 1 AS double precision) AS x`]],
  kjson: ["SELECT coalesce((payload ->> 'a')::numeric(20,4), 0) AS x FROM events", PICKS,
    [`${ONE}CAST(COALESCE(CAST(payload ->> 'a' AS numeric(20, 4)), 0) AS numeric(38, 4)) AS x`, `${ORDBL}CAST(COALESCE(CAST(payload ->> 'a' AS numeric(20, 4)), 0) AS double precision) AS x`]],
};
test("round 7: the walk follows a sublink, a CTE, a set operation's arms and a subquery, and every form's way out is the user's own expression, and stores", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  // each way out as a statement: the ones given, else the column's own expression over the definition's table
  const builds = Object.entries(R7).flatMap(([name, [sql, , options, given]]) => (given ?? options.flatMap((o) => {
    const way = /: (.+ AS x)$/.exec(o)?.[1];
    return way === undefined ? [] : [`SELECT ${way} FROM ${/FROM (\w+)$/.exec(sql)![1]}`];
  })).map((b, i) => [`w${name}${i}`, b] as const));
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(R7)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(R7)) await w.until((s) => s.state === "refused" || s.serving, `public.${name}`);
    const wrong: string[] = [];
    for (const [name, [sql, reason, options]] of Object.entries(R7)) {
      const refusals = w.status(`public.${name}`).refusals;
      const said = refusals.map((r) => `${r.message}\n      ${r.options.join("\n      ")}`).join(" || ");
      if (refusals.length !== 1 || !reason.test(refusals[0]!.message) || JSON.stringify(refusals[0]!.options) !== JSON.stringify(options)) wrong.push(`${name}: ${sql}\n    ${said || "(not refused)"}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    // one at a time: 26 files written at once once left a run "stuck inside the engine" (#224), and one at a time is faster
    for (const [name, sql] of builds) { w.write(name, `${lag}sql: ${sql}\n`); await w.until(served(w.logged), `public.${name}`); }
    for (const [name, sql] of builds) assert.deepEqual((await typed(w, `SELECT x FROM ${name}`)).fields.map(([, oid]) => oid), [/double precision/.test(sql) ? 701 : 1700], `${name}: ${sql}`);
  });
});

// review round 8 of PR 202: a definition that crashed the review instead of reaching a verdict. A UNION ALL whose arm
// reads a CTE built a program whose arms had different column counts, the engine threw, the review threw and ran again
// for ever, and the table stayed `building` with no reason. The class: no definition leaves the review without a verdict
const R8_CTE_UNION = "WITH t AS (SELECT sqrt(abs(amount)) AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT sqrt(abs(amount)) FROM ledger";
test("round 8: a numeric over a UNION ALL arm that reads a CTE reaches a verdict, refused by its own reason, never left building", async () => {
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    w.write("cteunion", `kind: scheduled\ntarget_lag: 1h\nsql: ${R8_CTE_UNION}\n`);
    w.write("cteplain", "kind: scheduled\ntarget_lag: 1h\nsql: WITH t AS (SELECT amount AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT amount FROM ledger\n");
    const s = await w.until((x) => x.state === "refused" || x.serving, "public.cteunion");
    assert.equal(s.refusals.length, 1, JSON.stringify(s.refusals));
    assert.match(s.refusals[0]!.message, PER("sqrt"));
    assert.deepEqual(s.refusals[0]!.options, [`${DBL}write the WITH query t as SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger; and write the UNION ALL as ` +
      "WITH t AS (SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT CAST(sqrt(abs(amount)) AS double precision) FROM ledger", AT_READ]);
    assert.ok(!w.logged.some((l) => /review failed/.test(l)), w.logged.join("\n"));
    // the statement on the wire, whose plan the definition's is: every arm as wide as the others
    assert.equal((await typed(w, R8_CTE_UNION)).rows.length, 8);
    await w.until(served(w.logged), "public.cteplain");
    assert.deepEqual((await typed(w, "SELECT x FROM cteplain ORDER BY x")).rows, [["-2.50"], ["-2.50"], ["1.10"], ["1.10"], ["4.00"], ["4.00"], [null], [null]]);
    // its way out is built and stored as a double
    w.write("cteway", "kind: scheduled\ntarget_lag: 1h\nsql: WITH t AS (SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT CAST(sqrt(abs(amount)) AS double precision) FROM ledger\n");
    await w.until(served(w.logged), "public.cteway");
    const way = await typed(w, "SELECT x FROM cteway WHERE x = 2 ORDER BY x");
    assert.deepEqual([way.fields.map(([, oid]) => oid), way.rows], [[701], [[2], [2]]]);
  });
});

test("round 8: a definition whose check throws unexpectedly is refused in readable words, and the other tables of the review are still built", async () => {
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    const real = w.api.planner();
    const planner: typeof real = { ...real, plan: (text, stmt, relations) => /boom/.test(text) ? Promise.reject(new Error("Binder Error: something the engine said")) : real.plan(text, stmt, relations) };
    // the throwing table first in the review, so a review that stops at it never reaches the other
    w.write("aboom", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id AS boom FROM ledger\n");
    w.write("zfine", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id FROM ledger\n");
    await w.sync.generated.start(() => readGenerated(w.folder, w.dir), planner);
    const s = await w.until((x) => x.state === "refused" || x.serving, "public.aboom");
    assert.equal(s.state, "refused");
    assert.equal(s.refusals.length, 1, JSON.stringify(s.refusals));
    const r = s.refusals[0]!;
    assert.doesNotMatch(`${r.message} ${r.why ?? ""} ${r.options.join(" ")}`, /Binder|engine|duck/i);
    assert.match(r.message, /Mason could not check/);
    assert.ok(r.options.length > 0);
    await w.until(served(w.logged), "public.zfine");
    assert.equal(w.status("public.zfine").refusals.length, 0);
  });
});
