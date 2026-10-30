/**
 * THE LIST OF WHAT THE DUCKDB ENDPOINT DOES NOT DO AS POSTGRES DOES IS KEPT TRUE (src/duck/gaps.ts):
 *  - docs/SQL-SUPPORT.md is rendered from the registry and the verified list (src/duck/verified.ts), and must be what
 *    they render now (`UPDATE_FIXTURE=1 npm run check` rewrites it; read the diff);
 *  - every `Mason gap <id>` the code writes names an entry, every `refused` entry is one the code refuses with, and a
 *    `heldBy` test names the entry it holds.
 * The oracle (tests/integration/duck-oracle.itest.ts) holds the rest against a real Postgres: a refusal where Postgres
 * answers must name a `refused` entry, and an entry none of its statements meets is dead. What each entry accounts for
 * is its fixture's `gaps` (tests/integration/oracle/gap-tally.ts), held here to the tallies it refines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GAPS, type Gap } from "../src/duck/gaps.ts";
import { VERIFIED } from "../src/duck/verified.ts";
import { GAP_CASES } from "./integration/oracle/gap-cases.ts";
import { countGap, emptyTally, fixtureText, gapSummary, rankedGaps, totalOf, type GapCount, type GapCounts, type GapTally } from "./integration/oracle/gap-tally.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC = path.join(ROOT, "docs/SQL-SUPPORT.md");
const README = path.join(ROOT, "README.md");
const UPDATE = process.env.UPDATE_FIXTURE === "1";

const cell = (s: string): string => s.replace(/\|/g, "\\|");
const table = (rows: Array<[string, Gap]>): string => [
  "| Gap | What | Postgres | Mason | Instead |",
  "|---|---|---|---|---|",
  ...rows.map(([id, g]) => `| \`${id}\` | ${cell(g.what)} | ${cell(g.postgres)} | ${cell(g.mason)} | ${cell(g.wayOut)} |`),
].join("\n");

const KINDS: Array<[string, string]> = [
  ["type", "Types"], ["function", "Functions"], ["operator", "Operators"], ["aggregate", "Aggregates"], ["window", "Window functions"],
  ["cast", "Casts"], ["node", "Constructs"], ["field", "Forms of a construct"],
];

/**
 * DOCS/SQL-SUPPORT.MD'S "AT A GLANCE" (a table listing which Postgres features are supported, and the oracle's
 * comparison with DuckDB alone): what a reader deciding whether to point a tool at Mason needs on one screen — the
 * shapes of SQL answered, every type, the counts of what the oracle verified (named further down the doc), what is
 * refused. The feature rows are written here; the types, the counts and the tallies come from the code and the
 * oracle's fixture, so the table cannot say more than the oracle holds. The README carries the counts alone
 * (`renderReadmeSupport`), in its body, and links the doc.
 */
/** the oracle's DuckDB-alone tallies (tests/integration/duck-oracle.itest.ts `duckdbAlone`), as the fixture holds them */
export interface AloneTallies {
  statements: number;
  mason: { exact: number; decided: number; refused: number; differs: number };
  duckdb: { exact: number; name: number; refused: number; value: number; rows: number; text: number; other: number };
}
export const ALONE_FIXTURE = path.join(ROOT, "tests/fixtures/oracle-duckdb-alone.json");
const readAlone = (): AloneTallies => JSON.parse(fs.readFileSync(ALONE_FIXTURE, "utf8")) as AloneTallies;

/** the counts the README and the doc both say, from the registry, the verified list and the oracle's tallies */
const percentOf = (alone: AloneTallies) => (n: number): string => `${Math.round(100 * n / alone.statements)}%`;

/** the README's block, in its body ("What of Postgres is answered"): the oracle's verdict and the registry's counts, and where each is named */
export function renderReadmeSupport(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies = readAlone()): string {
  const of = (kind: Gap["kind"]): number => Object.values(gaps).filter((g) => g.kind === kind).length;
  const pct = percentOf(alone);
  const m = alone.mason;
  const wrong = m.differs === 0 ? "none was answered with a wrong value" : `${m.differs.toLocaleString("en-US")} were answered with a wrong value`;
  return `${README_START}
To show what Mason adds over DuckDB by itself, the oracle also sends ${alone.statements.toLocaleString("en-US")} of its queries to a plain DuckDB connection,
over the same tables. **DuckDB alone answers only ${pct(alone.duckdb.exact)} of them exactly as Postgres does. Mason answers ${pct(m.exact)}.**
It answers ${pct(m.decided)} differently, each by a decision it lists, and it refuses ${pct(m.refused)} with an error that says what to write
instead. ${wrong[0]!.toUpperCase() + wrong.slice(1)}.

[docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md) is generated from the code. It lists the ${verified.size.toLocaleString("en-US")} verified pieces (types, functions,
operators, aggregates, window functions, casts, constructs and their forms). It also lists the ${of("refused")} refused shapes, the
${of("differs")} that are answered differently and the ${of("limit")} limits, each with what to write instead.
`;
}

/** docs/SQL-SUPPORT.md's first sections: what is answered, at a glance, and why not DuckDB by itself */
function renderAtAGlance(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies): string {
  const of = (kind: Gap["kind"]): Array<[string, Gap]> => Object.entries(gaps).filter(([, g]) => g.kind === kind);
  const count = (prefix: string): number => [...verified.keys()].filter((k) => k.startsWith(`${prefix}:`)).length;
  const typeNames = [...verified].filter(([k]) => k.startsWith("type:")).map(([, v]) => v.replace(/^a value of type /, ""));
  const scalars = typeNames.filter((n) => !n.endsWith("[]") && !n.includes("(an extension's)") && n !== "unknown" && n !== "a table's row type" && n !== "record").sort();
  const arrays = typeNames.filter((n) => n.endsWith("[]")).map((n) => n.slice(0, -2)).sort();
  const rows: Array<[string, string]> = [
    ["A `SELECT` over the copied tables (and the source's views over them): joins, subqueries, WITH queries, UNION / INTERSECT / EXCEPT, GROUP BY and grouping sets, HAVING, DISTINCT, ORDER BY under the database's collation, LIMIT / OFFSET / FETCH FIRST, window functions, CASE, COALESCE / NULLIF / GREATEST / LEAST, IN and ANY / ALL, parameters, EXPLAIN",
      `answered exactly as Postgres answers it: ${count("node")} constructs and ${count("field")} forms of them verified`],
    [`The types: ${scalars.join(", ")}; arrays of ${arrays.join(", ")}; the source's enums and citext; a table's row`, `answered (${count("type")} types verified)`],
    ["Functions, operators, aggregates, window functions and casts", `answered exactly: ${count("function")} functions, ${count("operator")} operators, ${count("aggregate")} aggregates, ${count("window")} window functions and ${count("cast")} casts verified; "What is verified" below names each`],
    ["Transactions, SET, SHOW, the catalog (`pg_catalog`, `information_schema`) and the protocol a tool uses", "answered: what a BI tool asks at connection and before a query"],
    [`Anything else: ${of("refused").length} shapes known not to answer as Postgres does ("Refused" below), and any function, operator or cast the oracle has not verified`, "refused by name (SQLSTATE 0A000), the error saying what to write instead; never answered differently"],
  ];
  const cell = (s: string): string => s.replace(/\|/g, "\\|");
  const pct = percentOf(alone);
  const m = alone.mason, d = alone.duckdb;
  return `## At a glance

Mason is a drop-in replacement for a Postgres read replica: the SQL a tool sends Postgres is answered as Postgres
answers it — the same columns, types, values, text and order — or refused by name, never answered differently. Every
piece a statement is made of is verified against a real Postgres by the oracle ("What is verified" below names
each). The copy is read-only.

| Postgres | Mason |
|---|---|
${rows.map(([p, m]) => `| ${cell(p)} | ${cell(m)} |`).join("\n")}

## Why not DuckDB by itself

DuckDB reads most of Postgres's SQL, but does not answer it as Postgres does. The oracle's ${alone.statements.toLocaleString("en-US")} statements,
each sent as written to Mason and to a plain DuckDB connection over the same copied tables (tests/integration/duck-oracle.itest.ts):

| Of ${alone.statements.toLocaleString("en-US")} statements | Mason | DuckDB alone |
|---|---|---|
| answered exactly as Postgres: the rows, their text, the column names | ${pct(m.exact)} | ${pct(d.exact)} |
| answered differently by a decision the registry lists ("Answered differently" below) | ${pct(m.decided)} | — |
| refused, naming what to write instead (SQLSTATE 0A000, \`Mason gap <id>\`) | ${pct(m.refused)} | — |
| the right rows under DuckDB's own column names (\`count_star()\` for \`count\`, the expression's text for an unnamed column) | — | ${pct(d.name)} |
| refused with DuckDB's own error (a function it lacks, syntax it does not read) | — | ${pct(d.refused)} |
| a wrong value (\`7 / 2\` is 3.5, LIKE's backslash escape, a float4 beside a literal, a numeric's rounding) | ${pct(m.differs)} | ${pct(d.value)} |
| wrong rows, or the rows in another order | — | ${pct(d.rows)} |
| the same value in other text (\`1.0\` for \`1\`, a numeric's scale, a timestamptz without its offset) | — | ${pct(d.text)} |
| another error than Postgres's, or answered where Postgres refuses | — | ${pct(d.other)} |

A tool that reads Postgres reads the first row's answers; the rest it would have to work around, statement by
statement. The oracle's statements are adversarial by design (NULL beside '', ties, every type's edge values), so
plain reports fare better on DuckDB alone than this table says — and still not as Postgres.
`;
}

export function renderGaps(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies = readAlone()): string {
  const of = (kind: Gap["kind"]): Array<[string, Gap]> => Object.entries(gaps).filter(([, g]) => g.kind === kind);
  const groups = KINDS.map(([prefix, title]) => {
    const names = [...verified].filter(([k]) => k.startsWith(`${prefix}:`)).map(([, v]) => v).sort();
    return names.length === 0 ? "" : `### ${title} (${names.length})\n\n${names.map((n) => `- ${n}`).join("\n")}\n`;
  }).filter((s) => s !== "");
  return `<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts: never edit by hand.
     UPDATE_FIXTURE=1 npm run check rewrites it. -->
# What Mason answers as Postgres does, and what it does not

> **The list is the code; the sentences are a template.** \`tests/duck-gaps.test.ts\` renders this file from
> \`src/duck/gaps.ts\` and \`src/duck/verified.ts\`, and CI holds it equal to what they render, so it is as current as the
> commit you are reading. To change the wording, edit the renderer; to change what is answered or refused, change the
> source; an edit made here is undone by the next \`UPDATE_FIXTURE=1 npm run check\`.

${renderAtAGlance(gaps, verified, alone)}
## How a statement is decided

Mason answers a statement on DuckDB only when it can give **exactly** the answer Postgres gives: the same columns,
types, values, text and order (docs/DESIGN.md). Everything a statement is made of — each
function, operator, aggregate, cast, type and construct Postgres resolved it to — must be on the **verified** list at
the end: pieces a statement of tests/integration/duck-oracle.itest.ts used, which Mason answered exactly as a real
Postgres did, after a copy and after two rounds of changes. A statement using anything else is refused
(SQLSTATE 0A000, \`Mason gap unverified\`), and the error names each piece.

What is known **beyond** that list is below. A refusal names its gap in the error's detail (\`Mason gap <id>\`) and
says what to write instead in its hint.

## Refused (${of("refused").length})

A statement using one of these is refused with SQLSTATE 0A000, where Postgres would answer it.

${table(of("refused"))}

## Answered differently

${of("differs").length} cases are answered, but not as Postgres answers. Each is a decided difference the oracle checks still differs.

${table(of("differs"))}

## Limits of the prototype (${of("limit").length})

Not about one statement: what the prototype cannot do yet.

${table(of("limit"))}

## What is verified (${verified.size})

${groups.join("\n")}`;
}

/** the README's block between these lines is rendered (`renderReadmeSupport`), the rest of the README written by hand */
export const README_START = "<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm run check rewrites it -->";
export const README_END = "<!-- END GENERATED -->";

test("README.md's counts of what is answered, refused and known to differ are what the registry renders", () => {
  const was = fs.readFileSync(README, "utf8");
  const a = was.indexOf(README_START), z = was.indexOf(README_END, a);
  assert.ok(a >= 0 && z > a, `README.md has the lines ${README_START} … ${README_END}`);
  const out = was.slice(0, a) + renderReadmeSupport(GAPS, VERIFIED) + was.slice(z);
  if (UPDATE) { fs.writeFileSync(README, out); console.log(`UPDATE_FIXTURE=1: wrote ${README}`); return; }
  assert.equal(was, out, "README.md's block is not what the registry renders: regenerate with `UPDATE_FIXTURE=1 npm run check` and read the diff");
});

test("the README's block is in its body, before License, and says each count docs/SQL-SUPPORT.md lists in full", () => {
  const readme = fs.readFileSync(README, "utf8");
  const block = readme.indexOf(README_START), license = readme.indexOf("\n## License\n");
  assert.ok(block >= 0 && license > block, "the block comes before ## License");
  assert.doesNotMatch(readme.slice(license + 1), /\n## /, "nothing follows License");
  const text = renderReadmeSupport(GAPS, VERIFIED).replace(/\s+/g, " ");
  const doc = renderGaps(GAPS, VERIFIED);
  const kinds = ["refused", "differs", "limit"] as const;
  const n = Object.fromEntries(kinds.map((k) => [k, Object.values(GAPS).filter((g) => g.kind === k).length]));
  assert.ok(text.includes(`the ${VERIFIED.size.toLocaleString("en-US")} verified pieces (types, functions, operators, aggregates, window functions, casts, constructs and their forms). It also lists the ${n.refused} refused shapes, the ${n.differs} that are answered differently and the ${n.limit} limits`), text);
  for (const heading of [`## What is verified (${VERIFIED.size})`, `## Refused (${n.refused})`, "## Answered differently", `## Limits of the prototype (${n.limit})`, "## At a glance", "## Why not DuckDB by itself"]) {
    assert.ok(doc.includes(`\n${heading}\n`), `docs/SQL-SUPPORT.md has ${heading}`);
  }
  assert.ok(doc.includes(`\n${n.differs} cases are answered, but not as Postgres answers.`), "docs/SQL-SUPPORT.md says how many are answered differently");
});

test("docs/SQL-SUPPORT.md is what src/duck/gaps.ts and src/duck/verified.ts render", () => {
  const out = renderGaps(GAPS, VERIFIED);
  if (UPDATE) { fs.writeFileSync(DOC, out); console.log(`UPDATE_FIXTURE=1: wrote ${DOC}`); return; }
  const was = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf8") : "";
  assert.equal(was, out, "docs/SQL-SUPPORT.md is not what the registry renders: regenerate with `UPDATE_FIXTURE=1 npm run check` and read the diff");
});

/** the product's source a refusal can be written in (src/lib: the exact numerics'), gaps.ts itself aside */
const sources = (): Array<{ file: string; text: string }> => ["src/duck", "src/api/postgres", "src/lib"].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts") && f !== "gaps.ts")
    .map((f) => ({ file: `${dir}/${f}`, text: fs.readFileSync(path.join(ROOT, dir, f), "utf8") })));

test("every `Mason gap <id>` the code writes names an entry of src/duck/gaps.ts", () => {
  const unknown = sources().flatMap(({ file, text }) =>
    [...text.matchAll(/\bMason gap ([a-z0-9-]+)/g)].map((m) => m[1]!).filter((id) => !(id in GAPS)).map((id) => `${file}: Mason gap ${id}`));
  assert.deepEqual(unknown, [], "a refusal names a gap src/duck/gaps.ts does not have: add the entry, or name the right one");
});

test("every refused entry is one the code refuses with, and a heldBy test names the entry it holds", () => {
  const code = sources().map((s) => s.text).join("\n");
  const unused = Object.entries(GAPS).filter(([id, g]) => g.kind === "refused" && !code.includes(`"${id}"`) && !code.includes(`Mason gap ${id}`)).map(([id]) => id);
  assert.deepEqual(unused, [], "a refused entry no code refuses with: remove it, or refuse with it");
  const unheld = Object.entries(GAPS).flatMap(([id, g]) => {
    const by = (g as Gap).heldBy;
    if (by === undefined) return [];
    const file = path.join(ROOT, by);
    return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(`Mason gap ${id}`) ? [] : [`${id}: ${by}`];
  });
  assert.deepEqual(unheld, [], "a heldBy test that does not exist or does not name its gap (`Mason gap <id>`)");
});

test("what a refused statement is said to have used is in a developer's words: no internal name (the oracle, the engine, the catalog's)", () => {
  // `what` is the line mason status and the web page's Unsupported SQL say to the person who sent the statement
  // (unsupportedLines); the engine and the oracle are named in the docs' other columns only
  const internal = Object.entries(GAPS).filter(([, g]) => /\b(oracle|duckdb|pglite)\b/i.test(g.what)).map(([id, g]) => `${id}: ${g.what}`);
  assert.deepEqual(internal, []);
});

type GapFixture = Pick<AloneTallies, "statements" | "mason"> & {
  gaps: { copyPhase: GapTally; everyAsk: GapTally & { asked: number } };
  measured: { machine: string; postgres: string; collation: string; shapes: boolean };
};
const readGaps = (): GapFixture => {
  const fixture = JSON.parse(fs.readFileSync(ALONE_FIXTURE, "utf8")) as Partial<GapFixture>;
  assert.ok(fixture.gaps !== undefined, `${ALONE_FIXTURE} has no gaps: regenerate it with the oracle's UPDATE_FIXTURE=1`);
  return fixture as GapFixture;
};
const sum = (c: GapCount): number => c.planted + c.natural;

test("the oracle's fixture counts by gap sum to the tallies they refine", () => {
  const { mason, statements, gaps: { copyPhase, everyAsk } } = readGaps();
  assert.equal(sum(totalOf(copyPhase.refused)), mason.refused, "the copy phase's refusals by gap: regenerate with the oracle's UPDATE_FIXTURE=1");
  assert.equal(sum(totalOf(copyPhase.decided)), mason.decided, "the copy phase's decided differences by gap: regenerate with the oracle's UPDATE_FIXTURE=1");
  // no gap is counted for more statements than were planted for it, so no planted statement twice (one answered
  // exactly is counted for none): each gap has its gap case, and mixed-scale-numeric MIXED_SCALE besides
  const plantedFor = new Map<string, number>([["mixed-scale-numeric", 1]]);
  for (const c of GAP_CASES) plantedFor.set(c.gap, (plantedFor.get(c.gap) ?? 0) + 1);
  const counted = new Map<string, number>();
  for (const [id, c] of [...Object.entries(copyPhase.refused), ...Object.entries(copyPhase.decided)]) counted.set(id, (counted.get(id) ?? 0) + c.planted);
  assert.deepEqual([...counted].filter(([id, n]) => n > (plantedFor.get(id) ?? 0)).map(([id, n]) => `${id}: ${n}`), [], "a gap counted for more statements than were planted for it");
  assert.ok(everyAsk.asked >= 3 * statements, "every statement is asked in three phases, and the shapes beside them");
  // every ask holds the copy phase, by gap and by split: the two measures are not each other's by mistake
  const short = (["refused", "decided"] as const).flatMap((met) => (Object.entries(copyPhase[met]) as Array<[keyof GapCounts, GapCount]>)
    .filter(([id, c]) => (everyAsk[met][id]?.planted ?? 0) < c.planted || (everyAsk[met][id]?.natural ?? 0) < c.natural).map(([id]) => `${met} ${id}`));
  assert.deepEqual(short, []);
});

test("every id of the oracle's fixture counts is a gap of the kind counted: a refusal's refused, a decided one's differs", () => {
  const { gaps: { copyPhase, everyAsk } } = readGaps();
  const wrong = [copyPhase, everyAsk].flatMap((t) => ([["refused", "refused"], ["decided", "differs"]] as const).flatMap(([met, kind]) =>
    Object.keys(t[met]).filter((id) => !Object.hasOwn(GAPS, id) || (GAPS as Record<string, Gap>)[id]!.kind !== kind).map((id) => `${met}: ${id}`)));
  assert.deepEqual(wrong, [], "the fixture names a gap src/duck/gaps.ts does not have, or of another kind: regenerate with the oracle's UPDATE_FIXTURE=1");
});

test("the oracle's fixture says what it was measured on, and it is what CI measures on: the shapes, a libc collation, a Linux Postgres", () => {
  // a regeneration under IT_ORACLE_SHAPES=0, or against a C or ICU database, writes a `gaps` block that looks the same
  const { measured } = readGaps();
  assert.equal(typeof measured?.machine, "string", "the fixture does not say its machine: regenerate with the oracle's UPDATE_FIXTURE=1");
  assert.equal(measured.shapes, true, "the fixture was measured with the shapes off: regenerate it without IT_ORACLE_SHAPES=0");
  assert.match(measured.collation, /\(c\)$/, "the fixture was measured over another provider than libc: regenerate it against a Postgres as CI's (postgres:18)");
  assert.match(measured.postgres, /linux/, "the fixture was measured against a Postgres not on Linux, whose libc collation is not glibc's: regenerate it against a Postgres as CI's (postgres:18)");
});

test("a gap is counted apart for its planted statements, ranked by the rest, and the summary says both", () => {
  const t = emptyTally();
  for (const [gap, group] of [["jsonb-compare", "gap case"], ["sum-real", "gap case"], ["sum-real", "gap case"], ["inet-order", "type matrix"], ["inet-order", "BI shape"], ["sum-real", "dialect"]] as const) countGap(t, "refused", gap, group);
  countGap(t, "decided", "show-all", "gap case");
  assert.deepEqual(t.refused, { "jsonb-compare": { planted: 1, natural: 0 }, "sum-real": { planted: 2, natural: 1 }, "inet-order": { planted: 0, natural: 2 } });
  assert.deepEqual(rankedGaps(t.refused).map(([id]) => id), ["inet-order", "sum-real", "jsonb-compare"], "a gap the oracle only planted ranks last, whatever its planted count");
  assert.deepEqual(totalOf(t.refused), { planted: 3, natural: 3 });
  // MIXED_SCALE's group carries its decision as a gap case carries a refusal
  const d = emptyTally();
  countGap(d, "decided", "mixed-scale-numeric", "decided");
  countGap(d, "decided", "mixed-scale-numeric", "query case");
  assert.deepEqual(d.decided, { "mixed-scale-numeric": { planted: 1, natural: 1 } });
  const lines = gapSummary(t, 10, t, 40);
  assert.equal(lines[0], "duck oracle: 6 of 10 statements refused, by gap, natural+planted (3+3): inet-order 2+0, sum-real 1+2, jsonb-compare 0+1");
  assert.equal(lines[3], "duck oracle: 1 of 40 asks decided, by gap, natural+planted (0+1): show-all 0+1");
  assert.equal(fixtureText({ refused: { "sum-real": { planted: 2, natural: 1 } } }), '{\n  "refused": {\n    "sum-real": { "planted": 2, "natural": 1 }\n  }\n}\n');
});
