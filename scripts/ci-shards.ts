#!/usr/bin/env node
/**
 * HOW CI SPLITS THE TESTS (.github/workflows/ci.yml; tests/ci-shards.test.ts). A shard is a job of its own on a runner of
 * its own; a required check (`checks`, `integration (rest)`, `integration (oracle)`) is a final job that `needs` its
 * shards. Nothing lists a test file by hand: a shard's files are computed from the tree, so a new file lands in a shard
 * by itself, and `WEIGHTS` only says which known files are slow.
 *
 *   node scripts/ci-shards.ts run <kind> <n>       run shard n of unit, rest or oracle, and record what it ran in CI_SHARD_DIR
 *   node scripts/ci-shards.ts files <kind> <n>     print its files
 *   node scripts/ci-shards.ts verify <kind> <dir>  every file ran in exactly one shard, by the records in <dir>
 *   node scripts/ci-shards.ts needs                every job in NEEDS (`toJSON(needs)`) succeeded
 *
 * Exit 0 when it holds (`run`: the tests' own exit), 1 when not, 2 on a bad argument.
 *
 * `verify` reads the records the shards wrote, never the partition again: a matrix that lost a shard, or a shard that
 * ran something else, is caught, where recomputing `partition` here would only agree with itself. `needs` takes `success`
 * alone: a job that was skipped or cancelled counts as passing a required check on GitHub, so nothing else may pass.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ORACLE } from "./gate.ts";

/** The shards of each kind; `.github/workflows/ci.yml`'s matrices say the same (tests/ci-shards.test.ts). */
export const SHARDS = { unit: 3, rest: 2, oracle: 2 } as const;
export type Kind = keyof typeof SHARDS;
export const isKind = (k: string | undefined): k is Kind => k === "unit" || k === "rest" || k === "oracle";

/**
 * Seconds of test time on CI's runner, about (`slowest tests` in a job's log), to balance the shards. Only the files
 * that matter are here: a stale number costs balance, never coverage, and a file not listed counts as `UNLISTED`, so a
 * new one lands in the lightest shard.
 */
const WEIGHTS: Readonly<Record<string, number>> = {
  "tests/duck-executor-slow-vector.test.ts": 142,
  // 130 s alone, after its shard's other files (`ALONE`), so it counts for what those would have done in the time
  "tests/duck-executor.test.ts": 300,
  "tests/cli-state-matrix.test.ts": 162,
  "tests/cli-commands.test.ts": 119,
  "tests/cli-share.test.ts": 89,
  "tests/duck-json-columns.test.ts": 85,
  "tests/duck-executor-starve.test.ts": 85,
  "tests/postgres-api/catalog.test.ts": 60,
  "tests/cli-demo-start.test.ts": 57,
  "tests/duck-roles-rows-wire.test.ts": 54,
  "tests/duck-executor-cancel-stress.test.ts": 50,
  "tests/postgres-api/tls.test.ts": 50,
  "tests/duck-plans.test.ts": 49,
  "tests/cli-help.test.ts": 49,
  "tests/duck-roles-wire.test.ts": 49,
  "tests/duck-wire.test.ts": 43,
  "tests/duck-users-wire.test.ts": 26,
  "tests/serve.test.ts": 26,
  "tests/demo-source.test.ts": 24,
  "tests/duck-jsonb-order.test.ts": 22,
  "tests/postgres-api/server.test.ts": 21,
  "tests/cli-mcp.test.ts": 19,
  "tests/fails-without.test.ts": 16,
  "tests/database-name.test.ts": 15,
  "tests/duck-sync-added.test.ts": 15,
  "tests/duck-roles-barrier-wire.test.ts": 13,
  "tests/cli-project.test.ts": 10,
  "tests/duck-requests-wire.test.ts": 9,
  "tests/gate.test.ts": 8,
  "tests/integration/duck-stream.itest.ts": 90,
  "tests/integration/duck-poll.itest.ts": 77,
  "tests/integration/cli-upgrade.itest.ts": 73,
  "tests/integration/cli-sources.itest.ts": 30,
  "tests/integration/duck-serve.itest.ts": 23,
  "tests/integration/duck-json-paths.itest.ts": 11,
};
const UNLISTED = 3;
/** The executor's stress tests fill every core they get: one to a shard, before anything else is placed. */
const APART: readonly string[] = ["tests/duck-executor-slow-vector.test.ts", "tests/duck-executor-starve.test.ts", "tests/duck-executor-cancel-stress.test.ts"];

/**
 * Files that run after their shard's others, by themselves. Their tests hold a statement of 6 M rows to a bound of a
 * second or two, and split from the stress tests they used to run strictly after, one in the same shard is the likely
 * reason one missed it (`a client leaving mid-statement`, PR 114's first run). The stress tests are not trimmed, so the
 * bound gets the machine.
 */
const ALONE: readonly string[] = ["tests/duck-executor.test.ts"];

/** The files of a kind, as `npm test` and `npm run test:integration` find them: the oracle is its own kind. */
export function testFiles(kind: Kind, root: string): string[] {
  if (kind === "oracle") return [ORACLE];
  const found = fs.globSync(kind === "unit" ? "tests/**/*.test.ts" : "tests/integration/**/*.itest.ts", { cwd: root }).map((f) => f.split(path.sep).join("/"));
  return found.filter((f) => f !== ORACLE).sort();
}

/**
 * The files in `n` shards of about equal weight: `apart` one to a shard, then the heaviest first, each into the
 * lightest shard so far. It is a function of the list alone, ties going to the lower shard, so every shard's job
 * computes the same partition.
 */
export function partition(files: readonly string[], n: number, weight: (file: string) => number, apart: readonly string[] = []): string[][] {
  const shards = Array.from({ length: n }, () => ({ files: [] as string[], total: 0 }));
  const seeded = apart.filter((f) => files.includes(f));
  seeded.forEach((file, i) => { const s = shards[i % n]!; s.files.push(file); s.total += weight(file); });
  for (const file of files.filter((f) => !seeded.includes(f)).sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((best, s) => s.total < best.total ? s : best);
    lightest.files.push(file);
    lightest.total += weight(file);
  }
  return shards.map((s) => s.files.sort());
}

export const weightOf = (file: string): number => WEIGHTS[file] ?? UNLISTED;

/** A shard's files. Every oracle shard is a leg of the one file (scripts/oracle-legs.ts), told apart by IT_ORACLE_LEG. */
export function shardFiles(kind: Kind, shard: number, root: string): string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARDS[kind]) throw new RangeError(`${kind} has shards 1 to ${SHARDS[kind]}, not ${shard}`);
  if (kind === "oracle") return [ORACLE];
  return partition(testFiles(kind, root), SHARDS[kind], weightOf, APART)[shard - 1]!;
}

/** The `node` commands of a shard, in turn: its files together, then each of `ALONE` by itself. Integration files run one
 *  at a time (tests/integration/README.md); `--test` with no file would run every test in the tree, so an empty shard
 *  is an error, not a pass. */
export function shardCommands(kind: Kind, shard: number, files: readonly string[]): Array<{ args: string[]; env: Record<string, string> }> {
  if (files.length === 0) throw new Error(`${kind} shard ${shard} has no file: \`node --test\` would run every test in the tree`);
  const env = kind === "oracle" ? { IT_ORACLE_LEG: `${shard}/${SHARDS.oracle}` } : {};
  const together = files.filter((f) => !ALONE.includes(f));
  return [...(together.length > 0 ? [together] : []), ...files.filter((f) => ALONE.includes(f)).map((f) => [f])]
    .map((group) => ({ args: ["--test", ...(kind === "unit" ? [] : ["--test-concurrency=1"]), ...group], env }));
}

/** What a shard wrote of itself */
export interface ShardRecord { kind: Kind; shard: number; files: string[]; exit: number }
export const recordName = (kind: Kind, shard: number): string => `ran-${kind}-${shard}.json`;

/** Every shard of the kind recorded once, and every file of the tree in exactly one, none that is not in the tree. */
export function coverageProblems(kind: Kind, records: readonly ShardRecord[], files: readonly string[]): string[] {
  const problems: string[] = [];
  const shards = records.map((r) => r.shard).sort((a, b) => a - b).join();
  const want = Array.from({ length: SHARDS[kind] }, (_, i) => i + 1).join();
  if (shards !== want) problems.push(`${kind}: the records are of shard(s) ${shards || "none"}, where ${want} must each have run once`);
  if (kind === "oracle") {
    for (const r of records) if (r.files.join() !== files.join()) problems.push(`oracle leg ${r.shard} ran ${r.files.join(", ")}, not ${files.join(", ")}`);
    return problems;
  }
  const ran = new Map<string, number[]>();
  for (const r of records) for (const f of r.files) ran.set(f, [...ran.get(f) ?? [], r.shard]);
  for (const f of files) if (!ran.has(f)) problems.push(`${f} ran in no ${kind} shard`);
  for (const [f, in_] of ran) {
    if (in_.length > 1) problems.push(`${f} ran in ${kind} shards ${in_.join(" and ")}`);
    if (!files.includes(f)) problems.push(`${f} ran in ${kind} shard ${in_.join(", ")} but is not in the tree`);
  }
  return problems;
}

/** The jobs of a required check that did not succeed; no job at all is one problem too. */
export function needsProblems(needsJson: string | undefined): string[] {
  const needs = JSON.parse(needsJson ?? "{}") as Record<string, { result?: string }>;
  const jobs = Object.entries(needs);
  if (jobs.length === 0) return ["the check has no job behind it: NEEDS is empty"];
  return jobs.filter(([, j]) => j.result !== "success").map(([name, j]) => `${name}: ${j.result ?? "no result"}`);
}

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [what, kind, arg] = argv;
  if (what === "needs") {
    const problems = needsProblems(process.env.NEEDS);
    for (const p of problems) console.error(`this check needs every job behind it to succeed: ${p}`);
    if (problems.length === 0) console.log(`every job behind this check succeeded: ${Object.keys(JSON.parse(process.env.NEEDS!) as object).join(", ")}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (!isKind(kind) || arg === undefined || !["run", "files", "verify"].includes(what ?? "")) {
    console.error("usage: scripts/ci-shards.ts run|files <unit|rest|oracle> <shard>, verify <unit|rest|oracle> <dir>, or needs");
    return 2;
  }
  if (what === "verify") {
    const records = (fs.existsSync(arg) ? fs.readdirSync(arg) : []).filter((f) => f.startsWith(`ran-${kind}-`))
      .map((f) => JSON.parse(fs.readFileSync(path.join(arg, f), "utf8")) as ShardRecord);
    const files = testFiles(kind, root);
    const problems = coverageProblems(kind, records, files);
    for (const p of problems) console.error(p);
    if (problems.length === 0) console.log(`${kind}: ${files.length} file(s), each in exactly one of ${records.length} shards`);
    return problems.length === 0 ? 0 : 1;
  }
  const shard = Number(arg);
  let files: string[];
  try { files = shardFiles(kind, shard, root); } catch (e) { console.error((e as Error).message); return 2; }
  if (what === "files") { for (const f of files) console.log(f); return 0; }
  const out = process.env.CI_SHARD_DIR;
  if (out === undefined) { console.error("set CI_SHARD_DIR: the folder of the shard's record"); return 2; }
  console.log(`${kind} shard ${shard} of ${SHARDS[kind]}: ${files.length} file(s), about ${files.reduce((n, f) => n + weightOf(f), 0)} s of test time`);
  // every command runs whatever the one before answered; a signal leaves status null, never a pass
  const exits = shardCommands(kind, shard, files).map(({ args, env }) => spawnSync(process.execPath, args, { stdio: "inherit", cwd: root, env: { ...process.env, ...env } }).status ?? 1);
  const exit = exits.find((code) => code !== 0) ?? 0;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, recordName(kind, shard)), JSON.stringify({ kind, shard, files, exit } satisfies ShardRecord));
  return exit;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
