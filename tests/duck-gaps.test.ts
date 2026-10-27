/**
 * THE LIST OF WHAT THE DUCKDB ENDPOINT DOES NOT DO AS POSTGRES DOES IS KEPT TRUE (src/duck/gaps.ts):
 *  - docs/SQL-SUPPORT.md is rendered from the registry and the verified list (src/duck/verified.ts), and must be what
 *    they render now (`UPDATE_FIXTURE=1 npm test` rewrites it; read the diff);
 *  - every `Mason gap <id>` the code writes names an entry, every `refused` entry is one the code refuses with, and a
 *    `heldBy` test names the entry it holds.
 * The oracle (tests/integration/duck-oracle.itest.ts) holds the rest against a real Postgres: a refusal where Postgres
 * answers must name a `refused` entry, and an entry none of its statements meets is dead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GAPS, type Gap } from "../src/duck/gaps.ts";
import { VERIFIED } from "../src/duck/verified.ts";

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
 * THE README'S TABLE (a table at its end listing which Postgres features are supported and which are known
 * differences): what a reader deciding whether to point a tool at Mason needs on one screen — the shapes of
 * SQL answered, every type, the counts of what the oracle verified (docs/SQL-SUPPORT.md names each), what is refused,
 * then every known difference and limit as the registry has them. The feature rows are written here; the types, the
 * counts and the differences come from the code, so the table cannot say more than the oracle holds.
 */
/** the oracle's DuckDB-alone tallies (tests/integration/duck-oracle.itest.ts `duckdbAlone`), as the fixture holds them */
export interface AloneTallies {
  statements: number;
  mason: { exact: number; decided: number; refused: number; differs: number };
  duckdb: { exact: number; name: number; refused: number; value: number; rows: number; text: number; other: number };
}
export const ALONE_FIXTURE = path.join(ROOT, "tests/fixtures/oracle-duckdb-alone.json");
const readAlone = (): AloneTallies => JSON.parse(fs.readFileSync(ALONE_FIXTURE, "utf8")) as AloneTallies;

export function renderReadmeSupport(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies = readAlone()): string {
  const of = (kind: Gap["kind"]): Array<[string, Gap]> => Object.entries(gaps).filter(([, g]) => g.kind === kind);
  const count = (prefix: string): number => [...verified.keys()].filter((k) => k.startsWith(`${prefix}:`)).length;
  const typeNames = [...verified].filter(([k]) => k.startsWith("type:")).map(([, v]) => v.replace(/^a value of type /, ""));
  const scalars = typeNames.filter((n) => !n.endsWith("[]") && !n.includes("(an extension's)") && n !== "unknown" && n !== "a table's row type" && n !== "record").sort();
  const arrays = typeNames.filter((n) => n.endsWith("[]")).map((n) => n.slice(0, -2)).sort();
  const rows: Array<[string, string]> = [
    ["A `SELECT` over the copied tables (and the source's views over them): joins, subqueries, WITH queries, UNION / INTERSECT / EXCEPT, GROUP BY and grouping sets, HAVING, DISTINCT, ORDER BY under the database's collation, LIMIT / OFFSET / FETCH FIRST, window functions, CASE, COALESCE / NULLIF / GREATEST / LEAST, IN and ANY / ALL, parameters, EXPLAIN",
      `answered exactly as Postgres answers it: ${count("node")} constructs and ${count("field")} forms of them verified`],
    [`The types: ${scalars.join(", ")}; arrays of ${arrays.join(", ")}; the source's enums and citext; a table's row`, `answered (${count("type")} types verified)`],
    ["Functions, operators, aggregates, window functions and casts", `answered exactly: ${count("function")} functions, ${count("operator")} operators, ${count("aggregate")} aggregates, ${count("window")} window functions and ${count("cast")} casts verified; [docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md) names each`],
    ["Transactions, SET, SHOW, the catalog (`pg_catalog`, `information_schema`) and the protocol a tool uses", "answered: what a BI tool asks at connection and before a query"],
    [`Anything else: ${of("refused").length} shapes known not to answer as Postgres does (SQL-SUPPORT.md "Refused"), and any function, operator or cast the oracle has not verified`, "refused by name (SQLSTATE 0A000), the error saying what to write instead; never answered differently"],
  ];
  const cell = (s: string): string => s.replace(/\|/g, "\\|");
  const known = (kind: Gap["kind"]): string => ["| What | Postgres | Mason | Instead |", "|---|---|---|---|",
    ...of(kind).map(([, g]) => `| ${cell(g.what)} | ${cell(g.postgres)} | ${cell(g.mason)} | ${cell(g.wayOut)} |`)].join("\n");
  const pct = (n: number): string => `${Math.round(100 * n / alone.statements)}%`;
  const m = alone.mason, d = alone.duckdb;
  return `${README_START}
> **The list is the code; the sentences are a template.** \`tests/duck-gaps.test.ts\` renders this section from
> \`src/duck/gaps.ts\` and \`src/duck/verified.ts\`, and CI holds it equal to what they render, so it is as current as the
> commit you are reading. To change the wording, edit the renderer; to change what is answered or refused, change the
> source; an edit made here is undone by the next \`UPDATE_FIXTURE=1 npm test\`.

Mason is a drop-in replacement for a Postgres read replica: the SQL a tool sends Postgres is answered as Postgres
answers it — the same columns, types, values, text and order — or refused by name, never answered differently. Every
piece a statement is made of is verified against a real Postgres by the oracle ([docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md),
rendered from the code, names each). The copy is read-only.

### Why not DuckDB by itself

DuckDB reads most of Postgres's SQL, but does not answer it as Postgres does. The oracle's ${alone.statements.toLocaleString("en-US")} statements,
each sent as written to Mason and to a plain DuckDB connection over the same copied tables (tests/integration/duck-oracle.itest.ts):

| Of ${alone.statements.toLocaleString("en-US")} statements | Mason | DuckDB alone |
|---|---|---|
| answered exactly as Postgres: the rows, their text, the column names | ${pct(m.exact)} | ${pct(d.exact)} |
| answered differently by a decision the registry lists (the known differences below) | ${pct(m.decided)} | — |
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

| Postgres | Mason |
|---|---|
${rows.map(([p, m]) => `| ${cell(p)} | ${cell(m)} |`).join("\n")}

### Known differences (${of("differs").length})

Answered, but not as Postgres answers: each is a decided difference the oracle checks still differs.

${known("differs")}

### Limits (${of("limit").length})

Not about one statement: what Mason does not do yet.

${known("limit")}
`;
}

export function renderGaps(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>): string {
  const of = (kind: Gap["kind"]): Array<[string, Gap]> => Object.entries(gaps).filter(([, g]) => g.kind === kind);
  const groups = KINDS.map(([prefix, title]) => {
    const names = [...verified].filter(([k]) => k.startsWith(`${prefix}:`)).map(([, v]) => v).sort();
    return names.length === 0 ? "" : `### ${title} (${names.length})\n\n${names.map((n) => `- ${n}`).join("\n")}\n`;
  }).filter((s) => s !== "");
  return `<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts: never edit by hand.
     UPDATE_FIXTURE=1 npm test rewrites it. -->
# What Mason answers as Postgres does, and what it does not

> **The list is the code; the sentences are a template.** \`tests/duck-gaps.test.ts\` renders this file from
> \`src/duck/gaps.ts\` and \`src/duck/verified.ts\`, and CI holds it equal to what they render, so it is as current as the
> commit you are reading. To change the wording, edit the renderer; to change what is answered or refused, change the
> source; an edit made here is undone by the next \`UPDATE_FIXTURE=1 npm test\`.

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

## Answered differently (${of("differs").length})

Answered, but not as Postgres answers. Each is a decided difference the oracle checks still differs.

${table(of("differs"))}

## Limits of the prototype (${of("limit").length})

Not about one statement: what the prototype cannot do yet.

${table(of("limit"))}

## What is verified (${verified.size})

${groups.join("\n")}`;
}

/** the README's section between these lines is rendered (`renderReadmeSupport`), the rest of the README written by hand */
export const README_START = "<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->";
export const README_END = "<!-- END GENERATED -->";

test("README.md's table of what is answered and the known differences is what the registry renders", () => {
  const was = fs.readFileSync(README, "utf8");
  const a = was.indexOf(README_START), z = was.indexOf(README_END);
  assert.ok(a >= 0 && z > a, `README.md has the lines ${README_START} … ${README_END}`);
  const out = was.slice(0, a) + renderReadmeSupport(GAPS, VERIFIED) + was.slice(z);
  if (UPDATE) { fs.writeFileSync(README, out); console.log(`UPDATE_FIXTURE=1: wrote ${README}`); return; }
  assert.equal(was, out, "README.md's table is not what the registry renders: regenerate with `UPDATE_FIXTURE=1 npm test` and read the diff");
});

test("docs/SQL-SUPPORT.md is what src/duck/gaps.ts and src/duck/verified.ts render", () => {
  const out = renderGaps(GAPS, VERIFIED);
  if (UPDATE) { fs.writeFileSync(DOC, out); console.log(`UPDATE_FIXTURE=1: wrote ${DOC}`); return; }
  const was = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf8") : "";
  assert.equal(was, out, "docs/SQL-SUPPORT.md is not what the registry renders: regenerate with `UPDATE_FIXTURE=1 npm test` and read the diff");
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
