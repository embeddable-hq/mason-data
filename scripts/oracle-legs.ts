#!/usr/bin/env node
/**
 * THE ORACLE IN LEGS (.github/workflows/ci.yml; tests/integration/README.md). CI runs tests/integration/duck-oracle.itest.ts
 * as two jobs, `IT_ORACLE_LEG=1/2` and `2/2`, each with its own Postgres, its own copy and both rounds of changes, each
 * asking the statements `legOf` gives it. A statement that no leg asks is a statement nobody holds to Postgres, and a
 * green run would never say so; and what a whole run asserts at its end (no stale decision, no dead gap, the allowlist
 * exactly what was verified, the tallies the fixture's) is false of a part. So a leg asserts neither, and writes a
 * report instead (`duck-oracle-leg-<n>.json`, in IT_LOG_DIR); `integration (oracle)` runs this file over the reports:
 *
 *   node scripts/oracle-legs.ts <folder>    exit 0: the legs are the whole, and hold what a whole run holds; exit 1: not
 *
 * The statements are named by what each leg ASKED, recorded where it asks, against the whole list each leg computed
 * before filtering: the check does not trust `legOf`. A whole run, and everything that regenerates a file
 * (`UPDATE_VERIFIED=1`, `UPDATE_FIXTURE=1`), stays one process without IT_ORACLE_LEG; a leg refuses to run under them.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GAPS, type GapId } from "../src/duck/gaps.ts";
import { VERIFIED } from "../src/duck/verified.ts";
import { staleDecisions } from "../tests/integration/oracle/known.ts";
import type { GapCounts, GapTally } from "../tests/integration/oracle/gap-tally.ts";

/** the three times every statement is asked; the shapes and the DuckDB-alone pass belong to the first */
export const PHASES = ["after the copy", "after changes round 1", "after changes round 2"] as const;
/** the oracle's stages of one session each, whose statements are asked IN ORDER (a SET moves what every later one
 *  reads), so a stage is never divided: each runs whole, in leg 1. A stage that reports nothing ran nowhere. */
export const STAGES = ["roles", "row filters", "settings", "setting scripts"] as const;
export const FIRST_LEG_RUNS_STAGES = 1;

export type Tallies = { statements: number; mason: Record<string, number>; duckdb: Record<string, number> };
export interface Decision { sql: string; why: string; machineFloat?: true; differed: boolean; decided: boolean }
export interface LegReport {
  leg: number;
  of: number;
  /** every statement of the oracle, before any leg's filter: an id each, and its name to say it by */
  whole: Array<{ id: string; name: string }>;
  /** the statements' ids as they were asked, by phase */
  asked: Record<string, string[]>;
  stages: Partial<Record<(typeof STAGES)[number], number>>;
  shaped: number;
  tallies: Tallies;
  copyPhase: GapTally;
  everyAsk: GapTally;
  decisions: Decision[];
  verified: string[];
  differences: number;
}

export const reportName = (leg: number): string => `duck-oracle-leg-${leg}.json`;
const sha = (text: string): Buffer => createHash("sha256").update(text).digest();

/** a statement's identity: two of one text and one name are one id, and are counted as two */
export const statementId = (q: { group: string; name: string; sql: string }): string => sha(`${q.group}\0${q.name}\0${q.sql}`).toString("hex").slice(0, 16);

/** The leg that asks a statement, from its text alone: a text asked twice under two names is one leg's, so what a whole
 *  run decides by text (`unproven`, `resolvedOf`) is decided the same in that leg. */
export const legOf = (sql: string, of: number): number => sha(sql).readUInt32BE(0) % of + 1;

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
  return named.length === 0 ? null : `IT_ORACLE_LEG=${env.IT_ORACLE_LEG} with ${named.join(", ")}: these read or rewrite the whole oracle. Unset IT_ORACLE_LEG`;
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
  if (counted !== first.whole.length) problems.push(`the legs' tallies count ${counted} statements, where the whole has ${first.whole.length}`);
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

/** What a whole run asserts at its end, of the legs together. A decision differed, or decided a statement, in any leg. */
export function wholeRunProblems(reports: readonly LegReport[], fixture: Pick<Tallies, "mason" | "duckdb">, listed: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const decisions = new Map<string, Decision>();
  for (const r of reports) for (const d of r.decisions) {
    const was = decisions.get(d.sql);
    decisions.set(d.sql, was === undefined ? { ...d } : { ...was, differed: was.differed || d.differed, decided: was.decided || d.decided });
  }
  const all = [...decisions.values()];
  problems.push(...staleDecisions(all, new Set(all.filter((d) => d.differed)), new Set(all.filter((d) => d.decided))).map((s) => `a decided difference that no longer differs: ${s}`));
  const dead = deadGaps(sumTally(reports.map((r) => r.everyAsk)));
  if (dead.length > 0) problems.push(`src/duck/gaps.ts entries no oracle statement meets: ${dead.join(", ")}. Add a statement that does (oracle/gap-cases.ts), or remove the entry`);
  const { added, dropped } = verifiedDiff(new Set(reports.flatMap((r) => r.verified)), listed);
  if (added.length + dropped.length > 0) problems.push(`src/duck/verified.ts is not what the legs verified: added ${JSON.stringify(added.slice(0, 20))}, dropped ${JSON.stringify(dropped.slice(0, 20))}. Regenerate with a whole run's UPDATE_VERIFIED=1 and read the diff`);
  const moved = movedTallies(sumTallies(reports.map((r) => r.tallies)), fixture);
  if (moved.length > 0) problems.push(`tests/fixtures/oracle-duckdb-alone.json is not what the legs measured: ${moved.join(", ")}. Regenerate with a whole run's UPDATE_FIXTURE=1 and read the diff`);
  return problems;
}

/** Every problem of the reports in a folder. A leg that wrote none is one of them: its statements were held by nobody. */
export function foldProblems(reports: readonly LegReport[], want: number, fixture: Pick<Tallies, "mason" | "duckdb">, listed: ReadonlyMap<string, string>): string[] {
  const partition = partitionProblems(reports, want);
  // of a part, what a whole run asserts says nothing: a gap met only by the missing statements would be called dead
  return partition.length > 0 ? partition : wholeRunProblems(reports, fixture, listed);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined) { console.error("usage: scripts/oracle-legs.ts <folder of duck-oracle-leg-<n>.json>"); process.exit(2); }
  const { SHARDS } = await import("./ci-shards.ts");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const reports = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^duck-oracle-leg-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as LegReport);
  const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/oracle-duckdb-alone.json"), "utf8")) as Pick<Tallies, "mason" | "duckdb">;
  const problems = foldProblems(reports, SHARDS.oracle, fixture, VERIFIED);
  for (const r of reports) console.log(`oracle leg ${r.leg}: ${r.tallies.statements} of ${r.whole.length} statements, ${r.shaped} in other shapes, ${r.differences} differ; stages: ${Object.keys(r.stages).join(", ") || "none"}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`oracle legs: ${p}`);
    process.exit(1);
  }
  console.log(`oracle legs: ${reports.map((r) => r.tallies.statements).join(" + ")} = ${reports[0]!.whole.length} statements, each asked in all ${PHASES.length} phases by exactly one leg; ` +
    `${reports.reduce((n, r) => n + r.shaped, 0)} in other shapes; no stale decision, no dead gap, src/duck/verified.ts and the fixture's tallies hold`);
}
