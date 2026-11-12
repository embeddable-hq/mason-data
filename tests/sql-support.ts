/**
 * README.md'S GENERATED BLOCK AND docs/SQL-SUPPORT.md, RENDERED from src/duck/gaps.ts, the verified list and the oracle's
 * DuckDB-alone tallies. One module, two callers: tests/duck-gaps.test.ts holds both files to what it renders (and
 * rewrites them under UPDATE_FIXTURE=1), and `node scripts/oracle-legs.ts --write` renders them from the very values it
 * has just written, so the counts and the docs that say them have one writer (issue 516). Every input is a parameter,
 * never a file read here: a caller rendering a temp root's numbers cannot get the repo's by default.
 *
 * Not a test file: it imports no node:test (a script importing a test would register and run its tests), and it reaches
 * no node_modules package, since scripts/oracle-legs.ts runs in CI's final jobs with no `npm ci` (tests/conventions.test.ts).
 */
import type { Gap } from "../src/duck/gaps.ts";

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

/** the counts the README and the doc both say, from the registry, the verified list and the oracle's tallies */
const percentOf = (alone: AloneTallies) => (n: number): string => `${Math.round(100 * n / alone.statements)}%`;

/** the README's block, in its body ("What of Postgres is answered"): the oracle's verdict and the registry's counts, and where each is named */
export function renderReadmeSupport(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies): string {
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
export function renderAtAGlance(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies): string {
  const of = (kind: Gap["kind"]): Array<[string, Gap]> => Object.entries(gaps).filter(([, g]) => g.kind === kind);
  const count = (prefix: string): number => [...verified.keys()].filter((k) => k.startsWith(`${prefix}:`)).length;
  const typeNames = [...verified].filter(([k]) => k.startsWith("type:")).map(([, v]) => v.replace(/^a value of type /, ""));
  const scalars = typeNames.filter((n) => !n.endsWith("[]") && !n.includes("(an extension's)") && n !== "unknown" && n !== "a table's row type" && n !== "record").sort();
  const arrays = typeNames.filter((n) => n.endsWith("[]")).map((n) => n.slice(0, -2)).sort();
  const rows: Array<[string, string]> = [
    ["A `SELECT` over the synced tables (and the source's views over them): joins, subqueries, WITH queries, UNION / INTERSECT / EXCEPT, GROUP BY and grouping sets, HAVING, DISTINCT, ORDER BY under the database's collation, LIMIT / OFFSET / FETCH FIRST, window functions, CASE, COALESCE / NULLIF / GREATEST / LEAST, IN and ANY / ALL, parameters, EXPLAIN",
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
each). The synced data is read-only.

| Postgres | Mason |
|---|---|
${rows.map(([p, m]) => `| ${cell(p)} | ${cell(m)} |`).join("\n")}

## Why not DuckDB by itself

DuckDB reads most of Postgres's SQL, but does not answer it as Postgres does. The oracle's ${alone.statements.toLocaleString("en-US")} statements,
each sent as written to Mason and to a plain DuckDB connection over the same synced tables (tests/integration/duck-oracle.itest.ts):

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

export function renderGaps(gaps: Record<string, Gap>, verified: ReadonlyMap<string, string>, alone: AloneTallies): string {
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
Postgres did, after the first sync and after two rounds of changes. A statement using anything else is refused
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

/** README.md's text with the block between README_START and README_END replaced by `block` (which carries README_START
 *  itself, as renderReadmeSupport's does), every byte outside it kept; null when the README has no such block */
export function spliceReadme(readme: string, block: string): string | null {
  const a = readme.indexOf(README_START), z = readme.indexOf(README_END, a);
  return a >= 0 && z > a ? readme.slice(0, a) + block + readme.slice(z) : null;
}
