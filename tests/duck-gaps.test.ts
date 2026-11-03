/**
 * THE LIST OF WHAT THE DUCKDB ENDPOINT DOES NOT DO AS POSTGRES DOES IS KEPT TRUE (src/duck/gaps.ts):
 *  - docs/SQL-SUPPORT.md is rendered from the registry and the verified list (src/duck/verified.ts), and must be what
 *    they render now (`UPDATE_FIXTURE=1 npm run check` rewrites it; read the diff); the renderers are tests/sql-support.ts,
 *    which `node scripts/oracle-legs.ts --write` renders both files through too;
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
import { README_END, README_START, renderGaps, renderReadmeSupport, spliceReadme, type AloneTallies } from "./sql-support.ts";
import { countGap, emptyTally, fixtureText, gapSummary, rankedGaps, totalOf, type GapCount, type GapCounts, type GapTally } from "./integration/oracle/gap-tally.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC = path.join(ROOT, "docs/SQL-SUPPORT.md");
const README = path.join(ROOT, "README.md");
const UPDATE = process.env.UPDATE_FIXTURE === "1";

/** the oracle's DuckDB-alone tallies as the committed fixture holds them: what the docs below are held to */
export const ALONE_FIXTURE = path.join(ROOT, "tests/fixtures/oracle-duckdb-alone.json");
const readAlone = (): AloneTallies => JSON.parse(fs.readFileSync(ALONE_FIXTURE, "utf8")) as AloneTallies;

test("README.md's counts of what is answered, refused and known to differ are what the registry renders", () => {
  const was = fs.readFileSync(README, "utf8");
  const out = spliceReadme(was, renderReadmeSupport(GAPS, VERIFIED, readAlone()));
  assert.ok(out !== null, `README.md has the lines ${README_START} … ${README_END}`);
  if (UPDATE) { fs.writeFileSync(README, out); console.log(`UPDATE_FIXTURE=1: wrote ${README}`); return; }
  assert.equal(was, out, "README.md's block is not what the registry renders: regenerate with `UPDATE_FIXTURE=1 npm run check` and read the diff");
});

test("the README's block is in its body, before License, and says each count docs/SQL-SUPPORT.md lists in full", () => {
  const readme = fs.readFileSync(README, "utf8");
  const block = readme.indexOf(README_START), license = readme.indexOf("\n## License\n");
  assert.ok(block >= 0 && license > block, "the block comes before ## License");
  assert.doesNotMatch(readme.slice(license + 1), /\n## /, "nothing follows License");
  const text = renderReadmeSupport(GAPS, VERIFIED, readAlone()).replace(/\s+/g, " ");
  const doc = renderGaps(GAPS, VERIFIED, readAlone());
  const kinds = ["refused", "differs", "limit"] as const;
  const n = Object.fromEntries(kinds.map((k) => [k, Object.values(GAPS).filter((g) => g.kind === k).length]));
  assert.ok(text.includes(`the ${VERIFIED.size.toLocaleString("en-US")} verified pieces (types, functions, operators, aggregates, window functions, casts, constructs and their forms). It also lists the ${n.refused} refused shapes, the ${n.differs} that are answered differently and the ${n.limit} limits`), text);
  for (const heading of [`## What is verified (${VERIFIED.size})`, `## Refused (${n.refused})`, "## Answered differently", `## Limits of the prototype (${n.limit})`, "## At a glance", "## Why not DuckDB by itself"]) {
    assert.ok(doc.includes(`\n${heading}\n`), `docs/SQL-SUPPORT.md has ${heading}`);
  }
  assert.ok(doc.includes(`\n${n.differs} cases are answered, but not as Postgres answers.`), "docs/SQL-SUPPORT.md says how many are answered differently");
});

test("docs/SQL-SUPPORT.md is what src/duck/gaps.ts and src/duck/verified.ts render", () => {
  const out = renderGaps(GAPS, VERIFIED, readAlone());
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
  assert.ok(fixture.gaps !== undefined, `${ALONE_FIXTURE} has no gaps: regenerate it with node scripts/oracle-legs.ts --write <run-id>`);
  return fixture as GapFixture;
};
const sum = (c: GapCount): number => c.planted + c.natural;

test("the oracle's fixture counts by gap sum to the tallies they refine", () => {
  const { mason, statements, gaps: { copyPhase, everyAsk } } = readGaps();
  assert.equal(sum(totalOf(copyPhase.refused)), mason.refused, "the copy phase's refusals by gap: regenerate with node scripts/oracle-legs.ts --write <run-id>");
  assert.equal(sum(totalOf(copyPhase.decided)), mason.decided, "the copy phase's decided differences by gap: regenerate with node scripts/oracle-legs.ts --write <run-id>");
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
  assert.deepEqual(wrong, [], "the fixture names a gap src/duck/gaps.ts does not have, or of another kind: regenerate with node scripts/oracle-legs.ts --write <run-id>");
});

test("the oracle's fixture says what it was measured on, and it is what CI measures on: the shapes, a libc collation, a Linux Postgres", () => {
  // a regeneration under IT_ORACLE_SHAPES=0, or against a C or ICU database, writes a `gaps` block that looks the same
  const { measured } = readGaps();
  assert.equal(typeof measured?.machine, "string", "the fixture does not say its machine: regenerate it from a CI run's oracle legs, node scripts/oracle-legs.ts --write <run-id>");
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
