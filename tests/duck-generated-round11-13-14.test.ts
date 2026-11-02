/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review rounds
 * 11, 13 and 14: the analysis is the authority under any cast; a check off the run's connection; a deep definition
 * within the bound (round 12, the longest test, is tests/duck-generated-round12.test.ts). Each test runs its own world
 * (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import type { GeneratedHost } from "../src/duck/generated.ts";
import { planDefinition, type EngineTypes } from "../src/duck/generated-plan.ts";
import { built, COUNTS, withWorld } from "./duck-generated-world.ts";
import { DEEP_DEPTHS, deepChains } from "./deep-chains.ts";
import { scheduled, overLedger, type R11Node, R11_NODES } from "./duck-generated-ledger.ts";

after(() => stopParser());

// review round 11 of PR 202: a stddev under a typmod cast was stored from the engine's double, because storing read
// whether the rewrite made a program (PR 207's `programNeeded`, which makes none for `stddev(x)::numeric(p,s)`) where the
// analysis said "a variance". The class: one fact with two authorities. The decision: storing reads the analysis alone,
// so every node it says the engine computes as a double, bare, under a bare `::numeric` and under a typmod, over an input
// with a typmod and without, is refused by round 6's reason, whatever the rewrite made of it (no exact program carries any)

/** each input: `amount numeric(12,2)`, `big numeric` and `wide numeric(65,30)`, and the typmod a cast gives it */
const R11_INPUTS: Record<string, string> = { amount: "numeric(20,4)", big: "numeric(20,4)", wide: "numeric(38,20)" };
const R11_WRAPPERS: Record<string, (e: string, typmod: string) => string> = { bare: (e) => e, cast: (e) => `(${e})::numeric`, typmod: (e, t) => `(${e})::${t}` };
test("round 11: every node the analysis says the engine computes as a double is refused by its form's reason, under any cast, over any input's typmod", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  // a table per wrapper, input and kind (an aggregate and a value per row can't share a SELECT), a column per node
  const tables: Array<{ name: string; wrapper: string; input: string; nodes: R11Node[] }> = [];
  for (const wrapper of Object.keys(R11_WRAPPERS)) for (const input of Object.keys(R11_INPUTS)) for (const agg of [true, false]) {
    tables.push({ name: `r11_${wrapper}_${input}_${agg ? "agg" : "row"}`, wrapper, input, nodes: R11_NODES.filter((n) => n.agg === agg) });
  }
  const written = (t: (typeof tables)[number], n: R11Node): string => R11_WRAPPERS[t.wrapper]!(n.sql(t.input), R11_INPUTS[t.input]!);
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const t of tables) w.write(t.name, `${lag}sql: SELECT ${t.nodes.map((n) => `${written(t, n)} AS x_${n.fn}`).join(", ")} FROM ledger\n`);
    for (const t of tables) await w.until((s) => s.state === "refused" || s.state === "failed" || s.serving, `public.${t.name}`);
    const wrong: string[] = [];
    let cases = 0;
    for (const t of tables) {
      const s = w.status(`public.${t.name}`);
      for (const n of t.nodes) {
        cases++;
        const column = `x_${n.fn}`, said = s.refusals.filter((r) => r.message.startsWith(`column ${column} `));
        if (said.length !== 1 || !n.reason(column, t.wrapper === "typmod").test(said[0]!.message)) {
          wrong.push(`${written(t, n)}: ${said.map((r) => r.message).join(" || ") || `not refused (${s.state}${typeof s.error === "string" ? `: ${s.error}` : ""})`}`);
        }
      }
    }
    assert.equal(cases, 117, "13 nodes x 3 wrappers x 3 inputs");
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
  });
});

// review round 13 of PR 202: the review's check ran its settle and its prepare on the RUN'S connection, unserialised with
// a build that holds that connection in a transaction across awaits (its snapshot, its writer's turn, its steps), so a
// check landed inside the build's transaction and between its statements; CI's stream test stalled, and a reviewer's
// unit world stuck in the engine from `SessionSetup.settle` under `GeneratedTables.check` (#224's class). The decision:
// the check has a connection of its own, so nothing a review asks reaches the connection a run holds
test("round 13: a check while a run holds its transaction open never touches the run's connection, and gives its verdict", async () => {
  let hold: Promise<void> | null = null;
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    let release = (): void => undefined;
    hold = new Promise<void>((r) => { release = r; });
    try {
      w.reached.length = 0;
      await w.store.writer.run("INSERT INTO public.events VALUES (11, 7, 'query', 'ok', '11', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
      w.sync.generated.changed("public.events");
      await w.sync.generated.review();
      for (const end = Date.now() + 10_000; !w.reached.includes("snapshot") && Date.now() < end;) { await new Promise((r) => setTimeout(r, 10)); await w.sync.generated.review(); }
      assert.ok(w.reached.includes("snapshot"), "the run holds its transaction open at its snapshot");
      // every call on the run's connection from here until the release is the check's, since the run is held
      const run = (w.sync as unknown as { generatedLane: { conn: Record<string, unknown> } }).generatedLane.conn;
      const touched: string[] = [];
      for (const m of ["run", "runAndReadAll", "prepare"]) {
        const f = run[m] as (...a: unknown[]) => unknown;
        run[m] = (...a: unknown[]) => { touched.push(`${m}: ${String(a[0]).slice(0, 60)}`); return f.apply(run, a); };
      }
      try {
        w.write("checked", scheduled("SELECT kind, count(*) AS n FROM events GROUP BY kind"));
        w.write("wrong", scheduled("SELECT nope FROM events"));
        // bounded: a check stuck behind the run is a failure here, never a hang
        let bound: NodeJS.Timeout | undefined;
        const said = await Promise.race([w.sync.generated.review().then(() => "reviewed"), new Promise((r) => { bound = setTimeout(() => r("stuck"), 20_000); })]);
        clearTimeout(bound);
        assert.equal(said, "reviewed");
        assert.equal(w.status("public.wrong").state, "refused", JSON.stringify(w.status("public.wrong")));
        assert.deepEqual(w.status("public.checked").refusals, []);
        assert.deepEqual(touched, [], "the check reached the run's connection");
      } finally { for (const m of ["run", "runAndReadAll", "prepare"]) delete run[m]; }
    } finally { hold = null; release(); }
    await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    await w.until(built, "public.checked");
  }, { onStep: (s, n) => s === "snapshot" && n === "public.counts" ? hold ?? undefined : undefined });
});

// review round 14 of PR 202: the walk of a column's analysed expression copied, into each column reference, the whole
// followed expression of the column it reads, so a statement whose levels each read the level below more than once grew
// 3^depth (depth 12 took 880 ms, 16 about 70 s), on the wire's plan of every statement and in a definition's check. The
// decision: the walk is linear in the analysed tree (a reference shares what it reads, each node's form and each text's
// making are found once), and only the generated planner asks for it. Each shape at depth 16 reaches its verdict within
// the bound: an int8 stored; a text read as a numeric at the top refused by the form the text was made from, sqrt's, met
// at the bottom of every path; and with no form below, every path walked to the bottom, refused as a text. (A numeric
// read through every level: its decisions are taken once per column since #483, tests/duck-wire.test.ts "issue 244";
// its program copied into each reference, the UNION ALL chain's and `c + c - c`'s, is #484's)
type R14Case = { bottom: string; op: string; top: (chain: string) => string; verdict: RegExp | null };
const R14_CASES: R14Case[] = [
  { bottom: "1::int8", op: "+", top: (c) => c, verdict: null },
  { bottom: "sqrt(2::numeric)::text", op: "||", top: (c) => `SELECT a::numeric AS a FROM (${c}) top`, verdict: /^column a is a numeric whose decimals Postgres picks by the size of each value \(sqrt\)/ },
  { bottom: "'1'::text", op: "||", top: (c) => `SELECT a::numeric AS a FROM (${c}) top`, verdict: /^column a is a numeric read from text \(a text value cast to numeric\), which keeps the decimals each value's text has/ },
];
test("round 14: a definition whose every level reads the level below three times is checked within the bound, nested, as a WITH chain and as a UNION ALL chain", async () => {
  await withWorld({}, async (w) => {
    const planner = w.api.planner();
    // the review's own check: its connection, set up, and the engine's types as DuckDB prepares the plan's SQL there
    // (src/duck/generated.ts `review`, `engineTypes`)
    const host = (w.sync.generated as unknown as { host: GeneratedHost }).host;
    const describe = async (sql: string): Promise<EngineTypes> => {
      const p = await host.checkConnection().prepare(sql);
      try { return new Map(Array.from({ length: p.columnCount }, (_, i) => { const type = p.columnType(i).toString(); return [[p.columnName(i), type], [`#${i}`, type]] as const; }).flat()); }
      finally { p.destroySync(); }
    };
    const check = async (sql: string) => { await host.settleCheck(); return planDefinition(planner, sql, null, undefined, describe); };
    // a first check pays the planner's start (the catalog, the parser): untimed
    assert.ok("definition" in await check("SELECT 1::numeric AS a"));
    for (const c of R14_CASES) for (const depth of DEEP_DEPTHS) for (const [shape, chain] of Object.entries(deepChains(c.bottom, depth, c.op))) {
      const sql = c.top(chain), started = performance.now();
      const r = await check(sql);
      const ms = performance.now() - started, at = `${shape} over ${c.bottom} at depth ${depth}`;
      assert.ok(ms < 500, `${at}: checked in ${ms.toFixed(0)} ms`);
      if (c.verdict === null) assert.ok("definition" in r, `${at}: ${JSON.stringify("refused" in r ? r.refused : null)}`);
      else {
        assert.ok("refused" in r, `${at}: stored`);
        assert.deepEqual(r.refused.map((x) => c.verdict!.test(x.message)), [true], `${at}: ${JSON.stringify(r.refused)}`);
        assert.ok(r.refused[0]!.options.length > 0, `${at}: no way out`);
      }
    }
  });
});
