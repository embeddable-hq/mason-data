/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review round 12,
 * alone, the longest test: a text read as a numeric keeps the form of what it was made from. Each test runs its own
 * world (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import { COUNTS, served } from "./duck-generated-world.ts";
import { overLedger, typed, TEXT_JSON, R11_DIVIDES, R11_PER_VALUE, R11_NODES } from "./duck-generated-ledger.ts";

after(() => stopParser());

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
