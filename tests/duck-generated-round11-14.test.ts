/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review rounds 11
 * to 14: the analysis is the authority, through a cast and a text step; a check off the run's connection; a deep
 * definition within the bound. Each test runs its own world (tests/duck-generated-world.ts). What Postgres answers from
 * the same SQL is tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import type { GeneratedHost } from "../src/duck/generated.ts";
import { planDefinition, type EngineTypes } from "../src/duck/generated-plan.ts";
import { built, COUNTS, served, withWorld } from "./duck-generated-world.ts";
import { DEEP_DEPTHS, deepChains } from "./deep-chains.ts";
import { scheduled, overLedger, typed, TEXT_JSON } from "./duck-generated-ledger.ts";

after(() => stopParser());

// review round 11 of PR 202: a stddev under a typmod cast was stored from the engine's double, because storing read
// whether the rewrite made a program (PR 207's `programNeeded`, which makes none for `stddev(x)::numeric(p,s)`) where the
// analysis said "a variance". The class: one fact with two authorities. The decision: storing reads the analysis alone,
// so every node it says the engine computes as a double, bare, under a bare `::numeric` and under a typmod, over an input
// with a typmod and without, is refused by round 6's reason, whatever the rewrite made of it (no exact program carries any)
type R11Node = { fn: string; agg: boolean; sql: (x: string) => string; reason: (column: string, fixed: boolean) => RegExp };
const R11_VARIANCE = (fn: string): R11Node => ({ fn, agg: true, sql: (x) => `${fn}(${x})`,
  reason: (c) => new RegExp(`^column ${c} is a ${fn}, which Postgres computes as an exact numeric at decimals it picks`) });
const R11_DIVIDES = (fn: string, agg: boolean, sql: (x: string) => string): R11Node => ({ fn, agg, sql,
  reason: (c) => new RegExp(`^column ${c} divides a numeric, which the engine computes as a double$`) });
const R11_PER_VALUE = (fn: string, sql: (x: string) => string): R11Node => ({ fn, agg: false, sql,
  reason: (c, fixed) => fixed ? new RegExp(`^column ${c} rounds or casts a numeric Postgres computes for each row at decimals it picks \\(${fn}\\)`)
    : new RegExp(`^column ${c} is a numeric whose decimals Postgres picks by the size of each value \\(${fn}\\)`) });
const R11_NODES: R11Node[] = [
  ...["stddev", "stddev_samp", "stddev_pop", "variance", "var_samp", "var_pop"].map(R11_VARIANCE),
  R11_DIVIDES("avg", true, (x) => `avg(${x})`), R11_DIVIDES("quotient", false, (x) => `${x} / 3`),
  R11_PER_VALUE("sqrt", (x) => `sqrt(abs(${x}))`), R11_PER_VALUE("exp", (x) => `exp(${x})`), R11_PER_VALUE("ln", (x) => `ln(abs(${x}))`),
  R11_PER_VALUE("log", (x) => `log(abs(${x}))`), R11_PER_VALUE("power", (x) => `power(${x}, 2)`),
];
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

// review round 12 of PR 202: a cast through text stored the engine's double under a numeric's name.
// `((stddev(wide))::text)::numeric(38,18)` was stored as 1.282900359861721000 where Postgres has …721035, because the walk
// made every text read as a numeric "a text" and threw the form beneath it away, and a typmod over that text was "no
// form", so storing fell back to the engine type. The class is round 11's: the analysis is the authority, and its form
// forgot the node at a text boundary. The decision: a value's form survives every conversion, so a text read as a numeric
// keeps the form of what the text was made from, through every spelling of the text step. Each node the engine computes
// as a double, over an input with a typmod and without, inside the text bare, under `::numeric` and under a typmod, read
// back by a typmod (and, bare, by a bare `::numeric`), is refused by its node's reason, and its way out stores a double
type R12Node = { fn: string; agg: boolean; sql: (x: string) => string; reason: (column: string, fixed: boolean) => RegExp };
const R12_DOUBLE: R12Node = { fn: "float8", agg: false, sql: (x) => `${x}::float8`, reason: (c) => new RegExp(`^column ${c} is a numeric cast from a double precision value`) };
const R12_NODES: R12Node[] = [
  ...R11_NODES.filter((n) => n.agg),
  R11_DIVIDES("sum3", true, (x) => `sum(${x}) / 3`), { ...R11_PER_VALUE("sqrt", (x) => `sqrt(abs(sum(${x})))`), agg: true, fn: "sqrtsum" },
  R11_DIVIDES("quotient", false, (x) => `${x} / 3`), R11_PER_VALUE("sqrt", (x) => `sqrt(abs(${x}))`), R11_PER_VALUE("exp", (x) => `exp(${x})`),
  R11_PER_VALUE("ln", (x) => `ln(abs(${x}) + 1)`), R11_PER_VALUE("log", (x) => `log(abs(${x}) + 1)`), R11_PER_VALUE("power", (x) => `power(${x}, 2)`), R12_DOUBLE,
];
/** each spelling of the text step, over a value `e`; a WITH column's is its CTE's (`with`) */
const R12_SPELLINGS: Record<string, (e: string) => string> = {
  text: (e) => `(${e})::text`, varchar: (e) => `(${e})::varchar`, varchar40: (e) => `(${e})::varchar(40)`,
  concat: (e) => `((${e})::text || '')`, json: (e) => `(jsonb_build_object('s', ${e}) ->> 's')`, with: (e) => `(${e})::text`,
};
const R12_INPUTS: Record<string, string> = { amount: "numeric(20,4)", wide: "numeric(38,20)" };
/** inside the text: the node bare, under `::numeric`, under a typmod; then read back by `::numeric(38,18)`, or (`r`) the
 *  node bare read back by a bare `::numeric` */
const R12_WRAPPERS: Record<string, { inner: (e: string, typmod: string) => string; read: string; fixed: boolean }> = {
  b: { inner: (e) => e, read: "numeric(38,18)", fixed: true }, n: { inner: (e) => `(${e})::numeric`, read: "numeric(38,18)", fixed: true },
  t: { inner: (e, t) => `(${e})::${t}`, read: "numeric(38,18)", fixed: true }, r: { inner: (e) => e, read: "numeric", fixed: false },
};
test("round 12: a text read as a numeric keeps the form of what it was made from: every node the engine computes as a double, by every spelling of the text step, is refused by its node's reason, and its way out stores", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  type Column = { name: string; node: R12Node; fixed: boolean; text: string; read: string };
  const tables: Array<{ name: string; spelling: string; columns: Column[] }> = [];
  for (const spelling of Object.keys(R12_SPELLINGS)) for (const agg of [true, false]) {
    const columns: Column[] = [];
    for (const input of Object.keys(R12_INPUTS)) for (const [w, wrap] of Object.entries(R12_WRAPPERS)) {
      R12_NODES.filter((n) => n.agg === agg).forEach((node, i) => {
        const text = R12_SPELLINGS[spelling]!(wrap.inner(node.sql(input), R12_INPUTS[input]!));
        columns.push({ name: `c_${input}_${w}_${node.fn}_${i}`, node, fixed: wrap.fixed, text, read: wrap.read });
      });
    }
    tables.push({ name: `r12_${spelling}_${agg ? "agg" : "row"}`, spelling, columns });
  }
  // a WITH column: the text in the WITH query, read back in the outer one
  const statement = (t: (typeof tables)[number], select: (c: Column, i: number) => string): string => t.spelling === "with"
    ? `WITH t AS (SELECT ${t.columns.map((c, i) => `${c.text} AS v${i}`).join(", ")} FROM ledger) SELECT ${t.columns.map(select).join(", ")} FROM t`
    : `SELECT ${t.columns.map(select).join(", ")} FROM ledger`;
  const read = (t: (typeof tables)[number]) => (c: Column, i: number): string => `(${t.spelling === "with" ? `v${i}` : c.text})::${c.read} AS ${c.name}`;
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const t of tables) w.write(t.name, `${lag}sql: ${statement(t, read(t))}\n`);
    // the controls: a stored numeric column's text and a JSON number's text, each under a typmod, are stored (round 7)
    w.write("r12_column", `${lag}sql: SELECT id, amount::text::numeric(20,4) AS a, amount::varchar::numeric(20,4) AS b FROM ledger\n`);
    w.write("r12_json", `${lag}sql: SELECT id, (payload ->> 'a')::numeric(20,4) AS j FROM events\n`);
    w.write("r12_jsonbare", `${lag}sql: SELECT (payload ->> 'a')::numeric AS x FROM events\n`);
    for (const t of tables) await w.until((s) => s.state === "refused" || s.state === "failed" || s.serving, `public.${t.name}`);
    const wrong: string[] = [], ways = new Map<string, string[]>();
    let cases = 0;
    for (const t of tables) {
      const s = w.status(`public.${t.name}`), built: string[] = [];
      t.columns.forEach((c, i) => {
        cases++;
        const said = s.refusals.filter((r) => r.message.startsWith(`column ${c.name} `));
        const way = said[0]?.options.map((o) => new RegExp(`(?:double if it need not be exact|store the double it is): (.+ AS ${c.name})$`).exec(o)?.[1]).find((o) => o !== undefined);
        if (said.length !== 1 || !c.node.reason(c.name, c.fixed).test(said[0]!.message) || way === undefined) {
          wrong.push(`${read(t)(c, i)}: ${said.map((r) => `${r.message} | ${r.options.join(" | ")}`).join(" || ") || `not refused (${s.state}${typeof s.error === "string" ? `: ${s.error}` : ""})`}`);
        } else built.push(way);
      });
      ways.set(t.name, built);
    }
    assert.equal(cases, 6 * 2 * 4 * R12_NODES.length, "6 spellings x 2 inputs x 4 wrappers x every node");
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    const bare = await w.until((s) => s.state === "refused" || s.serving, "public.r12_jsonbare");
    assert.match(bare.refusals[0]?.message ?? "", TEXT_JSON);
    await w.until(served(w.logged), "public.r12_column");
    await w.until(served(w.logged), "public.r12_json");
    assert.deepEqual((await typed(w, "SELECT a, b FROM r12_column ORDER BY id")).rows, [["1.1000", "1.1000"], [null, null], ["-2.5000", "-2.5000"], ["4.0000", "4.0000"]]);
    assert.deepEqual((await typed(w, "SELECT j FROM r12_json WHERE j IS NOT NULL ORDER BY j LIMIT 1")).fields.map(([, oid]) => oid), [1700]);
    // each way out, as the refusals give it: a table per definition, every column stored as a double
    for (const t of tables) {
      const given = ways.get(t.name)!;
      w.write(`w${t.name}`, `${lag}sql: ${statement(t, (_c, i) => given[i]!)}\n`);
      await w.until(served(w.logged), `public.w${t.name}`);
      const fields = (await typed(w, `SELECT * FROM w${t.name}`)).fields.map(([, oid]) => oid);
      assert.deepEqual(fields, t.columns.map(() => 701), `w${t.name}: ${given.join(", ")}`);
    }
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
// carried through every level grows in the rewrite's exact program, as on main: issue 244, not this walk's)
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
