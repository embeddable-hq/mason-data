#!/usr/bin/env node
/**
 * THE ORACLE IN LEGS (.github/workflows/ci.yml; tests/integration/README.md). CI runs tests/integration/duck-oracle.itest.ts
 * as two jobs, `IT_ORACLE_LEG=1/2` and `2/2` (`scripts/ci-shards.ts run oracle <n>`), each with its own Postgres, its own copy and both rounds of changes, each
 * asking the statements `legOf` gives it. A statement that no leg asks is a statement nobody holds to Postgres, and a
 * green run would never say so; and what a whole run asserts at its end (no stale decision, no dead gap, the allowlist
 * exactly what was verified, the tallies the fixture's) is false of a part. So a leg asserts neither, and writes a
 * report instead (`duck-oracle-leg-<n>.json`, at IT_ORACLE_LEG_REPORT); `integration (oracle)` runs this file over the
 * reports:
 *
 *   node scripts/oracle-legs.ts <folder>    exit 0: the legs are the whole, and hold what a whole run holds; exit 1: not
 *
 * WHAT A WHOLE RUN REGENERATES COMES FROM THE LEGS TOO, since no session runs the whole oracle locally (CLAUDE.md "Local
 * gates"): each leg reports its part of src/duck/verified.ts (the keys and what each names) and of the fixture's
 * tallies, and
 *
 *   node scripts/oracle-legs.ts --write <run-id | folder>
 *
 * downloads that CI run's `ran-oracle-*` artifacts (`gh run download`), once the run has finished and only when it is
 * of the commit checked out (`runProblems`), or reads a folder of them (whose commit nothing checks), and writes both
 * files as a whole run's UPDATE_VERIFIED=1 and UPDATE_FIXTURE=1 would, through the same two writers (`verifiedText`,
 * `fixtureOf`) and in the same order (`writeFromLegs`): exit 0 when what the legs measured now holds, 1 when anything
 * else is wrong (nothing is written when the legs are not the whole, or are another commit's), 2 on a usage error.
 *
 * WHICH LEG ASKS WHAT IS SPLIT BY MEASURED COST (`partition`): every distinct statement text, the unordered limits'
 * too, goes to one leg, heaviest first into the lightest, with leg 1 starting from what its stages cost. The costs are
 * tests/fixtures/oracle-weights.json, written from a finished CI run's legs (each times every statement it asks, its
 * stages and its fixed costs, `times` in its report), never by hand:
 *
 *   node scripts/oracle-legs.ts --weights <run-id | folder> [--above <ms>]
 *
 * lists each text that took `--above` ms or more (WEIGHTS_ABOVE_MS when not given) by `weightKey`, and gives every
 * other the mean of those it left out. A stale or missing weight costs balance, never coverage: the check below holds
 * every statement to exactly one ask per phase whatever the partition.
 *
 * The statements are named by what each leg ASKED, recorded where it asks, against the whole list each leg computed
 * before filtering: the check does not trust `partition`. A whole run, and everything that regenerates a file
 * (`UPDATE_VERIFIED=1`, `UPDATE_FIXTURE=1`), stays one process without IT_ORACLE_LEG; a leg refuses to run under them.
 * So does a leg with no IT_ORACLE_LEG_REPORT: nothing would hold its report to the whole, and half the statements
 * passing with no end-of-run assertion must never read as the oracle passing.
 *
 * THIS FILE AND scripts/ci-shards.ts RUN WITH NO `npm ci`, in the final jobs: what they import reaches only Node's
 * builtins (tests/conventions.test.ts).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARDS, reportName } from "./ci-layout.ts";
import { GAPS, type GapId } from "../src/duck/gaps.ts";
import { VERIFIED } from "../src/duck/verified.ts";
import { decisionKey, staleDecisions } from "../tests/integration/oracle/known.ts";
import { fixtureTally, fixtureText, type GapCounts, type GapTally } from "../tests/integration/oracle/gap-tally.ts";
import { shapeProblems, sumShapeTallies, type ShapeTally } from "../tests/integration/oracle/shape-names.ts";

/** the three times every statement is asked; the shapes and the DuckDB-alone pass belong to the first */
export const PHASES = ["after the copy", "after changes round 1", "after changes round 2"] as const;
/** the oracle's stages of one session each, whose statements are asked IN ORDER (a SET moves what every later one
 *  reads), so a stage is never divided: each runs whole, in leg 1. A stage that reports nothing ran nowhere. */
export const STAGES = ["roles", "row filters", "settings", "setting scripts"] as const;
export const FIRST_LEG_RUNS_STAGES = 1;

export type Tallies = { statements: number; mason: Record<string, number>; duckdb: Record<string, number> };
/** a decided difference as a leg met it; `shape` and `kind`: a group's, its shapes joined (oracle/known.ts decisionKey keys it apart) */
export interface Decision { sql: string; shape?: string; kind?: string; issue?: number; why: string; machineFloat?: true; differed: boolean; decided: boolean }
/** what the fixture says the DuckDB-alone tallies were measured on */
export interface Measured { what: string; machine: string; postgres: string; collation: string; shapes: boolean }
export interface LegReport {
  leg: number;
  of: number;
  /** every statement of the oracle, before any leg's filter: an id each, and its name to say it by. `apart`: asked in
   *  every phase like the rest and held by a verdict of its own (oracle/unordered-limit.ts), so in no tally */
  whole: Array<{ id: string; name: string; apart?: true }>;
  /** the statements' ids as they were asked, by phase */
  asked: Record<string, string[]>;
  stages: Partial<Record<(typeof STAGES)[number], number>>;
  shaped: number;
  /** what each shape met (oracle/shape-names.ts): absent only in a report from before the tally */
  shapeTally?: ShapeTally;
  tallies: Tallies;
  copyPhase: GapTally;
  everyAsk: GapTally;
  decisions: Decision[];
  verified: string[];
  /** what each of `verified` names, in SQL's words (src/duck/resolved.ts describeKeys): src/duck/verified.ts's values */
  names: Record<string, string>;
  /** every ask of the leg, the three phases and the shapes: the fixture's `gaps.everyAsk.asked` is the legs' sum */
  asks: number;
  measured: Measured;
  differences: number;
  /** what the leg's time went on, in ms (`Clock`): absent in a report from before the timing, which `--weights` refuses */
  times?: Times;
}

/** What a leg's time went on, in ms: each statement text it asked by `weightKey` (every ask of it in every phase, the
 *  DuckDB-alone ask and the shapes; an unordered limit's pages too) with the name it was first asked by, each stage of
 *  one session, and what every leg pays alike (the setup, the first sync, each round of changes) */
export interface Times { fixed: Record<string, number>; stages: Partial<Record<(typeof STAGES)[number], number>>; statements: Record<string, { ms: number; name: string }> }

/** tests/fixtures/oracle-weights.json: what `partition` balances by, written by `--weights` from a run's `times` */
export interface Weights {
  /** the run (or folder) it was measured on, and the threshold it listed above */
  from?: string;
  above?: number;
  /** leg FIRST_LEG_RUNS_STAGES's head start: the stages' total */
  stages: number;
  /** the weight of a text not listed */
  default: number;
  /** each text listed by `weightKey`, its cost and the name it was asked by */
  statements: Record<string, { ms: number; name: string }>;
}
export const WEIGHTS_FILE = "tests/fixtures/oracle-weights.json";
/** what a text must have cost to be listed by name, when `--weights` is given no `--above` */
export const WEIGHTS_ABOVE_MS = 1000;

const sha = (text: string): Buffer => createHash("sha256").update(text).digest();

/** a statement's identity: two of one text and one name are one id, and are counted as two */
export const statementId = (q: { group: string; name: string; sql: string }): string => sha(`${q.group}\0${q.name}\0${q.sql}`).toString("hex").slice(0, 16);

/** THE ONE KEY of a statement's text in `times` and in the weights: what the leg measures and what the partition reads
 *  are one spelling */
export const weightKey = (sql: string): string => sha(sql).toString("hex").slice(0, 16);

/** The leg of every distinct statement text, by measured cost: heaviest first (then by key, then by text, so the list's
 *  order decides nothing) into the leg whose load is lightest (the lowest on a tie), leg FIRST_LEG_RUNS_STAGES starting
 *  from the stages' cost. It depends only on the set of texts and the weights, so every leg computes the same split; a
 *  text asked under two names is one leg's, since what a whole run decides by text (`unproven`, `resolvedOf`, KNOWN)
 *  must be decided in one leg. */
export function partition(statements: Iterable<{ sql: string }>, of: number, weights: Weights): Map<string, number> {
  const texts = [...new Set([...statements].map((q) => q.sql))].map((sql) => {
    const key = weightKey(sql);
    return { sql, key, w: weights.statements[key]?.ms ?? weights.default };
  });
  texts.sort((a, b) => b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.sql < b.sql ? -1 : a.sql > b.sql ? 1 : 0));
  const load = Array.from({ length: of }, (_, i) => i + 1 === FIRST_LEG_RUNS_STAGES ? weights.stages : 0);
  const legs = new Map<string, number>();
  for (const t of texts) {
    let lightest = 0;
    for (let i = 1; i < of; i++) if (load[i]! < load[lightest]!) lightest = i;
    load[lightest]! += t.w;
    legs.set(t.sql, lightest + 1);
  }
  return legs;
}

/** the committed weights (a missing file throws: no leg runs on a split nobody wrote) */
export const readWeights = (root: string): Weights => JSON.parse(fs.readFileSync(path.join(root, WEIGHTS_FILE), "utf8")) as Weights;

/** Where a leg's time goes: `lap(key, name)` closes the open entry and opens one for `key`, so the time between two
 *  laps is the first's, whatever its loop body `continue`d past; `stop()` closes the last. Laps of one key add up. */
export class Clock {
  readonly spent = new Map<string, { ms: number; name: string }>();
  private open: { key: string; name: string; at: number } | null = null;
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  lap(key: string, name: string): void {
    const at = this.now();
    this.close(at);
    this.open = { key, name, at };
  }
  stop(): void { this.close(this.now()); this.open = null; }
  /** the time `fn` takes, under `key` */
  async time<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const at = this.now();
    try { return await fn(); } finally { this.add(key, key, this.now() - at); }
  }
  private close(at: number): void { if (this.open !== null) this.add(this.open.key, this.open.name, at - this.open.at); }
  private add(key: string, name: string, ms: number): void {
    const was = this.spent.get(key);
    this.spent.set(key, { ms: (was?.ms ?? 0) + ms, name: was?.name ?? name });
  }
}

/** one line of what a run's time went on: the fixed costs, the stages, the statements and the slowest of them */
export function timesLine(t: Times, slowest = 8): string {
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const all = Object.values(t.statements).sort((a, b) => b.ms - a.ms);
  return `fixed: ${Object.entries(t.fixed).map(([k, ms]) => `${k} ${s(ms)}`).join(", ") || "none"}; ` +
    `stages: ${Object.entries(t.stages).map(([k, ms]) => `${k} ${s(ms!)}`).join(", ") || "none"}; ` +
    `statements: ${s(all.reduce((n, x) => n + x.ms, 0))} over ${all.length} texts; slowest: ${all.slice(0, slowest).map((x) => `${JSON.stringify(x.name)} ${s(x.ms)}`).join(", ") || "none"}`;
}

/** `--weights`: the weights from the legs' `times`, or why the reports cannot give them. `from` names the run or folder. */
export function weightsFromLegs(reports: readonly LegReport[], want: number, from: string, above: number): { weights: Weights } | { problems: string[] } {
  const partitioned = partitionProblems(reports, want);
  if (partitioned.length > 0) return { problems: partitioned };
  const untimed = reports.filter((r) => r.times === undefined).map((r) => r.leg);
  if (untimed.length > 0) return { problems: [`the report of leg(s) ${untimed.join(", ")} of ${from} has no times: the run predates the timing. Use a run of a commit that times its statements`] };
  const spent = reports.flatMap((r) => Object.entries(r.times!.statements));
  const listed = spent.filter(([, x]) => x.ms >= above).sort(([a, x], [b, y]) => y.ms - x.ms || (a < b ? -1 : 1));
  const rest = spent.filter(([, x]) => x.ms < above);
  const mean = rest.length === 0 ? above : rest.reduce((n, [, x]) => n + x.ms, 0) / rest.length;
  const stages = reports.reduce((n, r) => n + Object.values(r.times!.stages).reduce((m, ms) => m + (ms ?? 0), 0), 0);
  return { weights: { from, above, stages: Math.round(stages), default: Math.max(1, Math.round(mean)), statements: Object.fromEntries(listed.map(([k, x]) => [k, { ms: Math.round(x.ms), name: x.name }])) } };
}

/** the weights file's text: one listed text a line, so its diff can be read */
export function weightsText(w: Weights): string {
  const head = Object.entries({ from: w.from, above: w.above, stages: w.stages, default: w.default }).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join("");
  const listed = Object.entries(w.statements).map(([k, x]) => `    ${JSON.stringify(k)}: ${JSON.stringify(x)}`);
  return `{\n${head}  "statements": {${listed.length === 0 ? "" : `\n${listed.join(",\n")}\n  `}}\n}\n`;
}

/** `--weights`: tests/fixtures/oracle-weights.json under `root` from the reports in `dir`, and what to say; nothing is
 *  written when a report has no times or the legs are not the whole */
export function writeWeights(dir: string, root: string, from: string, above: number): { code: 0 | 1; out: string[]; err: string[] } {
  const got = weightsFromLegs(readReports(dir), SHARDS.oracle, from, above);
  if ("problems" in got) return { code: 1, out: [], err: [...got.problems.map((p) => `oracle legs: ${p}`), "oracle legs: nothing written"] };
  const w = got.weights;
  fs.writeFileSync(path.join(root, WEIGHTS_FILE), weightsText(w));
  return { code: 0, out: [`oracle legs: wrote ${WEIGHTS_FILE}: ${Object.keys(w.statements).length} text(s) of ${above} ms or more listed, every other ${w.default} ms, the stages ${w.stages} ms; read the diff, then commit it`], err: [] };
}

/** `1/2` → { leg: 1, of: 2 }; absent → null; anything else refuses, or a typo would run the whole oracle unasked */
export function parseLeg(text: string | undefined): { leg: number; of: number } | null {
  if (text === undefined) return null;
  const m = /^(\d+)\/(\d+)$/.exec(text);
  if (m === null || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`IT_ORACLE_LEG=${text}: write <leg>/<legs>, such as 1/2`);
  return { leg: Number(m[1]), of: Number(m[2]) };
}

/** Why IT_ORACLE_LEG cannot run with these settings, or null: each needs the whole run */
export function legRefused(env: NodeJS.ProcessEnv): string | null {
  if (env.IT_ORACLE_LEG === undefined) return null;
  const named = ["IT_ORACLE_ONLY", "UPDATE_VERIFIED", "UPDATE_FIXTURE"].filter((k) => k === "IT_ORACLE_ONLY" ? env[k] !== undefined : env[k] === "1");
  if (named.length > 0) return `IT_ORACLE_LEG=${env.IT_ORACLE_LEG} with ${named.join(", ")}: these read or rewrite the whole oracle. Unset IT_ORACLE_LEG`;
  return env.IT_ORACLE_LEG_REPORT === undefined ? `IT_ORACLE_LEG=${env.IT_ORACLE_LEG} with no IT_ORACLE_LEG_REPORT: a leg is part of the oracle, its statements and none of its end-of-run assertions, and only CI's check holds its report to the whole. Unset IT_ORACLE_LEG to run the oracle` : null;
}

/** The legs against the whole: every leg present once, the same list, and in every phase each statement asked exactly
 *  as often as the whole has it. Each problem names what is wrong; none means the legs are the whole. */
export function partitionProblems(reports: readonly LegReport[], want: number): string[] {
  const problems: string[] = [];
  const legs = reports.map((r) => r.leg).sort((a, b) => a - b);
  const expected = Array.from({ length: want }, (_, i) => i + 1);
  if (legs.join() !== expected.join()) problems.push(`the reports are of leg(s) ${legs.join(", ") || "none"}, where ${expected.join(", ")} must each report once`);
  for (const r of reports) if (r.of !== want) problems.push(`leg ${r.leg} ran as one of ${r.of}, where the oracle has ${want} legs`);
  const first = reports[0];
  if (first === undefined) return problems;
  for (const r of reports) if (JSON.stringify(r.whole) !== JSON.stringify(first.whole)) problems.push(`leg ${r.leg} and leg ${first.leg} list another whole (${r.whole.length} and ${first.whole.length} statements): they ran different trees`);
  const names = new Map(first.whole.map((s) => [s.id, s.name]));
  const say = (ids: string[]): string => ids.slice(0, 10).map((id) => JSON.stringify(names.get(id) ?? id)).join(", ") + (ids.length > 10 ? ` and ${ids.length - 10} more` : "");
  for (const phase of PHASES) {
    const asked = reports.flatMap((r) => r.asked[phase] ?? []);
    if (asked.length !== first.whole.length) problems.push(`${phase}: the legs asked ${reports.map((r) => (r.asked[phase] ?? []).length).join(" + ")} = ${asked.length} statements, where the whole has ${first.whole.length}`);
    const left = new Map<string, number>();
    for (const s of first.whole) left.set(s.id, (left.get(s.id) ?? 0) + 1);
    for (const id of asked) left.set(id, (left.get(id) ?? 0) - 1);
    const missing = [...left].filter(([, n]) => n > 0).map(([id]) => id), extra = [...left].filter(([, n]) => n < 0).map(([id]) => id);
    if (missing.length > 0) problems.push(`${phase}: no leg asked ${say(missing)}`);
    if (extra.length > 0) problems.push(`${phase}: asked more often than the whole has it: ${say(extra)}`);
  }
  for (const stage of STAGES) {
    const ran = reports.filter((r) => (r.stages[stage] ?? 0) > 0);
    if (ran.length !== 1) problems.push(`the stage ${stage} ran in ${ran.length} legs, where it runs whole in exactly one`);
  }
  const counted = reports.reduce((n, r) => n + r.tallies.statements, 0);
  const tallied = first.whole.filter((s) => s.apart !== true).length;
  if (counted !== tallied) problems.push(`the legs' tallies count ${counted} statements, where the whole has ${tallied}`);
  return problems;
}

const addCounts = (into: GapCounts, from: GapCounts): void => {
  for (const [id, c] of Object.entries(from) as Array<[GapId, { planted: number; natural: number }]>) {
    const t = into[id] ??= { planted: 0, natural: 0 };
    t.planted += c.planted;
    t.natural += c.natural;
  }
};
export function sumTally(tallies: readonly GapTally[]): GapTally {
  const sum: GapTally = { refused: {}, decided: {} };
  for (const t of tallies) { addCounts(sum.refused, t.refused); addCounts(sum.decided, t.decided); }
  return sum;
}
export function sumTallies(all: readonly Tallies[]): Tallies {
  const sum: Tallies = { statements: 0, mason: {}, duckdb: {} };
  for (const t of all) {
    sum.statements += t.statements;
    for (const side of ["mason", "duckdb"] as const) for (const [k, n] of Object.entries(t[side])) sum[side][k] = (sum[side][k] ?? 0) + n;
  }
  return sum;
}

/** the tallies that moved from the fixture by more than a percentage point of the statements */
export function movedTallies(now: Pick<Tallies, "statements" | "mason" | "duckdb">, was: Pick<Tallies, "mason" | "duckdb">): string[] {
  return (["mason", "duckdb"] as const).flatMap((side) => Object.entries(now[side]).filter(([k, n]) => Math.abs(n - was[side][k]!) > now.statements / 100)
    .map(([k, n]) => `${side}.${k}: ${n} where the fixture has ${was[side][k]}`));
}

/** a refused or decided entry of src/duck/gaps.ts no statement met */
export const deadGaps = (everyAsk: GapTally): GapId[] => (Object.entries(GAPS) as Array<[GapId, (typeof GAPS)[GapId]]>)
  .filter(([id, g]) => g.kind !== "limit" && !("heldBy" in g) && everyAsk.refused[id] === undefined && everyAsk.decided[id] === undefined).map(([id]) => id);

/** src/duck/verified.ts against what was verified */
export function verifiedDiff(verified: ReadonlySet<string>, listed: ReadonlyMap<string, string>): { added: string[]; dropped: string[] } {
  return { added: [...verified].filter((k) => !listed.has(k)).sort(), dropped: [...listed.keys()].filter((k) => !verified.has(k)).sort() };
}

/** the command that writes src/duck/verified.ts and the fixture from a CI run's legs (in CI, GITHUB_RUN_ID names this one) */
export const WRITE_COMMAND = `\`node scripts/oracle-legs.ts --write ${process.env.GITHUB_RUN_ID ?? "<run-id>"}\` (from this run's oracle legs; never a local whole run)`;

/** What a whole run asserts BEFORE it writes src/duck/verified.ts: no decided difference that no longer differs (a
 *  decision differed, or decided a statement, in any leg), and no gap that no statement meets */
export function staleOrDead(reports: readonly LegReport[]): string[] {
  const problems: string[] = [];
  const decisions = new Map<string, Decision>();
  for (const r of reports) for (const d of r.decisions) {
    const was = decisions.get(decisionKey(d));
    decisions.set(decisionKey(d), was === undefined ? { ...d } : { ...was, differed: was.differed || d.differed, decided: was.decided || d.decided });
  }
  const all = [...decisions.values()];
  problems.push(...staleDecisions(all, new Set(all.filter((d) => d.differed)), new Set(all.filter((d) => d.decided))).map((s) => `a decided difference that no longer differs: ${s}`));
  const dead = deadGaps(sumTally(reports.map((r) => r.everyAsk)));
  if (dead.length > 0) problems.push(`src/duck/gaps.ts entries no oracle statement meets: ${dead.join(", ")}. Add a statement that does (oracle/gap-cases.ts), or remove the entry`);
  // A DEAD OR MISSPELT SHAPE, of the legs' tallies summed, when the shapes ran (oracle/shape-names.ts shapeProblems). A
  // report with no tally predates it; one leg with and one without cannot be summed, and is said
  if (reports.some((r) => r.measured?.shapes === true)) {
    const without = reports.filter((r) => r.shapeTally === undefined).map((r) => r.leg);
    if (without.length > 0 && without.length < reports.length) problems.push(`the report of leg(s) ${without.join(", ")} has no shape tally where another has: the legs ran different trees`);
    else if (without.length === 0) problems.push(...shapeProblems(sumShapeTallies(reports.map((r) => r.shapeTally!))));
  }
  return problems;
}

/** What a whole run asserts at its end, of the legs together. */
export function wholeRunProblems(reports: readonly LegReport[], fixture: Pick<Tallies, "mason" | "duckdb">, listed: ReadonlyMap<string, string>): string[] {
  const problems = staleOrDead(reports);
  const { added, dropped } = verifiedDiff(new Set(reports.flatMap((r) => r.verified)), listed);
  if (added.length + dropped.length > 0) problems.push(`src/duck/verified.ts is not what the legs verified: added ${JSON.stringify(added.slice(0, 20))}, dropped ${JSON.stringify(dropped.slice(0, 20))}. Regenerate with ${WRITE_COMMAND} and read the diff`);
  const moved = movedTallies(sumTallies(reports.map((r) => r.tallies)), fixture);
  if (moved.length > 0) problems.push(`tests/fixtures/oracle-duckdb-alone.json is not what the legs measured: ${moved.join(", ")}. Regenerate with ${WRITE_COMMAND} and read the diff`);
  return problems;
}

/** Every problem of the reports in a folder. A leg that wrote none is one of them: its statements were held by nobody. */
export function foldProblems(reports: readonly LegReport[], want: number, fixture: Pick<Tallies, "mason" | "duckdb">, listed: ReadonlyMap<string, string>): string[] {
  const partition = partitionProblems(reports, want);
  // of a part, what a whole run asserts says nothing: a gap met only by the missing statements would be called dead
  return partition.length > 0 ? partition : wholeRunProblems(reports, fixture, listed);
}

/** src/duck/verified.ts's text: its head comment kept, then every key verified, sorted, with what it names. The one
 *  writer of the file, a whole run's UPDATE_VERIFIED=1 and `--write` alike. */
export function verifiedText(current: string, verified: Iterable<string>, names: ReadonlyMap<string, string>): string {
  const head = current.split("export const VERIFIED")[0]!;
  return `${head}export const VERIFIED: ReadonlyMap<string, string> = new Map([\n` +
    [...new Set(verified)].sort().map((k) => `  [${JSON.stringify(k)}, ${JSON.stringify(names.get(k) ?? k)}],\n`).join("") + "]);\n";
}

/** tests/fixtures/oracle-duckdb-alone.json's content: its one shape, a whole run's UPDATE_FIXTURE=1 and `--write` alike
 *  (its text is gap-tally.ts fixtureText's) */
export const fixtureOf = (tallies: Tallies, copyPhase: GapTally, everyAsk: GapTally, asked: number, measured: Measured) =>
  ({ ...tallies, gaps: { copyPhase: fixtureTally(copyPhase), everyAsk: { asked, ...fixtureTally(everyAsk) } }, measured });

/** The two files a whole run regenerates, from the legs' reports; or why the reports cannot give them. */
export function filesFromLegs(reports: readonly LegReport[], want: number, verifiedNow: string): { verified: string; fixture: string } | { problems: string[] } {
  const partition = partitionProblems(reports, want);
  if (partition.length > 0) return { problems: partition };
  const old = reports.filter((r) => r.names === undefined || r.asks === undefined || r.measured === undefined).map((r) => r.leg);
  if (old.length > 0) return { problems: [`the report of leg(s) ${old.join(", ")} has no names, asks or measured: the run predates \`--write\`. Run CI again on a commit that has it`] };
  const measured = reports.map((r) => JSON.stringify(r.measured));
  if (new Set(measured).size > 1) return { problems: [`the legs measured on different machines or Postgres: ${measured.join(" and ")}`] };
  const names = new Map(reports.flatMap((r) => Object.entries(r.names)));
  const fixture = fixtureOf(sumTallies(reports.map((r) => r.tallies)), sumTally(reports.map((r) => r.copyPhase)), sumTally(reports.map((r) => r.everyAsk)),
    reports.reduce((n, r) => n + r.asks, 0), reports[0]!.measured);
  return { verified: verifiedText(verifiedNow, reports.flatMap((r) => r.verified), names), fixture: fixtureText(fixture) };
}

/** the legs' reports in a folder, or in its folders one deep (`gh run download` puts each artifact in one of its own) */
export function readReports(dir: string): LegReport[] {
  if (!fs.existsSync(dir)) return [];
  const isReport = (f: string): boolean => f === reportName(Number(/\d+/.exec(f)?.[0]));
  const found = fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? fs.readdirSync(path.join(dir, e.name)).filter(isReport).map((f) => path.join(dir, e.name, f))
    : isReport(e.name) ? [path.join(dir, e.name)] : []);
  return found.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as LegReport);
}

export const VERIFIED_FILE = "src/duck/verified.ts", FIXTURE_FILE = "tests/fixtures/oracle-duckdb-alone.json";

/** Why a run's legs are not this tree's, from `gh run view <id> --json headSha,status,conclusion`: a run of another
 *  commit (an earlier push, another branch) measured another tree, and a run still going may have no legs yet */
export function runProblems(view: { headSha?: string; status?: string; conclusion?: string | null }, headSha: string): string[] {
  const problems: string[] = [];
  if (view.headSha !== headSha) problems.push(`the run is of commit ${view.headSha ?? "unknown"}, where this checkout is at ${headSha}: use the run of this commit's push (gh run list --commit ${headSha}), or check out ${view.headSha ?? "its commit"}`);
  if (view.status !== "completed") problems.push(`the run has not finished (${view.status ?? "unknown"}): wait for it, then run this again`);
  return problems;
}

/** `--write`: the files under `root` from the reports in `dir`, in a whole run's order, and what to say. Nothing is
 *  written when the legs are not the whole. The fixture is written first, as a whole run writes it before its other
 *  assertions; then a stale decision or a dead gap writes no src/duck/verified.ts, as a whole run fails on them before
 *  it writes the file; a statement that differs is said after both, as a whole run fails on it after writing. */
export function writeFromLegs(dir: string, root: string): { code: 0 | 1; out: string[]; err: string[] } {
  const reports = readReports(dir);
  const files = filesFromLegs(reports, SHARDS.oracle, fs.readFileSync(path.join(root, VERIFIED_FILE), "utf8"));
  if ("problems" in files) return { code: 1, out: [], err: [...files.problems.map((p) => `oracle legs: ${p}`), "oracle legs: nothing written"] };
  const out: string[] = [];
  const put = (file: string, text: string): void => {
    const was = fs.readFileSync(path.join(root, file), "utf8");
    if (was !== text) fs.writeFileSync(path.join(root, file), text);
    out.push(`oracle legs: ${was === text ? "unchanged" : "wrote"} ${file}`);
  };
  put(FIXTURE_FILE, files.fixture);
  const before = staleOrDead(reports);
  if (before.length > 0) return { code: 1, out, err: [...before.map((p) => `oracle legs: ${p}`), `oracle legs: ${VERIFIED_FILE} not written, as a whole run writes it only past these`] };
  put(VERIFIED_FILE, files.verified);
  const differ = reports.reduce((n, r) => n + r.differences, 0);
  if (differ > 0) return { code: 1, out, err: [`oracle legs: written, and still wrong: ${differ} statement(s) answered differently from Postgres in the legs: each leg's log lists them`] };
  out.push("oracle legs: read the diff, then commit both files");
  return { code: 0, out, err: [] };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  /** the folder of a run's `ran-oracle-*` artifacts, downloaded once the run is of this commit and finished; a folder as given */
  const legsOf = (from: string): string => {
    if (!/^\d+$/.test(from) || fs.existsSync(from)) { console.log(`oracle legs: ${from} is a folder, not a run: nothing checks that its legs ran on this checkout's commit`); return from; }
    const view = JSON.parse(execFileSync("gh", ["run", "view", from, "--json", "headSha,status,conclusion"], { cwd: root, encoding: "utf8" })) as Parameters<typeof runProblems>[0];
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const wrong = runProblems(view, head);
    if (wrong.length > 0) { for (const p of wrong) console.error(`oracle legs: run ${from}: ${p}`); console.error("oracle legs: nothing written"); process.exit(1); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-legs-"));
    console.log(`oracle legs: downloading the ran-oracle-* artifacts of run ${from} into ${dir}`);
    execFileSync("gh", ["run", "download", from, "--pattern", "ran-oracle-*", "--dir", dir], { cwd: root, stdio: "inherit" });
    return dir;
  };
  const say = (r: { code: 0 | 1; out: string[]; err: string[] }): never => {
    for (const l of r.out) console.log(l);
    for (const l of r.err) console.error(l);
    process.exit(r.code);
  };
  if (process.argv[2] === "--write") {
    const from = process.argv[3];
    if (from === undefined || process.argv.length > 4) { console.error("usage: scripts/oracle-legs.ts --write <run-id | folder of the ran-oracle-* artifacts>"); process.exit(2); }
    say(writeFromLegs(legsOf(from), root));
  }
  if (process.argv[2] === "--weights") {
    const [from, flag, ms] = process.argv.slice(3);
    const above = flag === undefined ? WEIGHTS_ABOVE_MS : Number(ms);
    if (from === undefined || (flag !== undefined && (flag !== "--above" || !(above > 0))) || process.argv.length > 6) {
      console.error("usage: scripts/oracle-legs.ts --weights <run-id | folder of the ran-oracle-* artifacts> [--above <ms>]");
      process.exit(2);
    }
    say(writeWeights(legsOf(from), root, from, above));
  }
  const dir = process.argv[2];
  if (dir === undefined) { console.error("usage: scripts/oracle-legs.ts <folder of duck-oracle-leg-<n>.json>, --write <run-id | folder>, or --weights <run-id | folder> [--above <ms>]"); process.exit(2); }
  const reports = readReports(dir);
  const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/oracle-duckdb-alone.json"), "utf8")) as Pick<Tallies, "mason" | "duckdb">;
  const problems = foldProblems(reports, SHARDS.oracle, fixture, VERIFIED);
  for (const r of reports) console.log(`oracle leg ${r.leg}: ${r.tallies.statements} tallied of ${r.whole.length} statements, ${r.shaped} in other shapes, ${r.differences} differ; stages: ${Object.keys(r.stages).join(", ") || "none"}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`oracle legs: ${p}`);
    process.exit(1);
  }
  console.log(`oracle legs: ${reports.map((r) => (r.asked[PHASES[0]] ?? []).length).join(" + ")} = ${reports[0]!.whole.length} statements, each asked in all ${PHASES.length} phases by exactly one leg; ` +
    `${reports.reduce((n, r) => n + r.shaped, 0)} in other shapes; no stale decision, no dead gap, src/duck/verified.ts and the fixture's tallies hold`);
}
