/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review round 5:
 * every reason against every wrapper, and a run's failure as Postgres's error. Each test runs its own world
 * (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import { COUNTS, served } from "./duck-generated-world.ts";
import { overLedger, typed, TEXT, DIV, SCALE, HELD, ROWS, PICKS } from "./duck-generated-ledger.ts";

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
