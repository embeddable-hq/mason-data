#!/usr/bin/env node
/**
 * HOW CI SPLITS THE TESTS (.github/workflows/ci.yml; tests/ci-shards.test.ts). A shard is a job of its own on a runner of
 * its own; a required check (`checks`, `integration (rest)`, `integration (oracle)`) is a final job that `needs` its
 * shards. Nothing lists a test file by hand: a shard's files are computed from the tree, so a new file lands in a shard
 * by itself, and the weights only balance them: the unit files' are each file's time MEASURED in a CI run
 * (tests/fixtures/unit-weights.json), the integration files' a hand table (`REST_WEIGHTS`).
 *
 *   node scripts/ci-shards.ts run <kind> <n>       run shard n of unit, rest or oracle, and record what it ran in CI_SHARD_DIR
 *   node scripts/ci-shards.ts files <kind> <n>     print its files
 *   node scripts/ci-shards.ts verify <kind> <dir>  every file ran in exactly one shard, by the records in <dir>
 *   node scripts/ci-shards.ts needs                every job in NEEDS (`toJSON(needs)`) succeeded, or was skipped by a docs-only run
 *   node scripts/ci-shards.ts weights <run-id | folder>   write tests/fixtures/unit-weights.json from a run's unit shards
 *   node scripts/ci-shards.ts changes              whether the pull request checked out changes nothing but docs: docs=true
 *                                                  or docs=false into GITHUB_OUTPUT
 *   node scripts/ci-shards.ts docs                 the docs job: the unit tests that read a doc (DOCS_TESTS)
 *
 * Exit 0 when it holds (`run`: the tests' own exit), 1 when not, 2 on a bad argument.
 *
 * `verify` reads the records the shards wrote, never the partition again: a matrix that lost a shard, or a shard that
 * ran something else, is caught, where recomputing `partition` here would only agree with itself. `needs` takes `success`
 * alone, but for a job the run's mode skips (THE DOCS PATH, below): a job that was skipped or cancelled counts as passing
 * a required check on GitHub, so nothing else may pass.
 *
 * THE UNIT SHARDS' BALANCE. A unit shard's run gives `node --test` a second reporter beside the spec one
 * (scripts/test-times.ts: each file's wall time, as the runner itself reports it), and its record carries those times,
 * its own wall time and its runner's CPU. `weights` writes the fixture from a finished run's `ran-unit-*` records, as
 * `scripts/oracle-legs.ts --weights` writes the oracle's (the run check, the download and the fixture's text are
 * ci-layout.ts's, shared). `verify unit` then says how far apart the shards ran and warns past UNIT_APART_MS, naming
 * that command, or the one file no split can help (`balanceLines`): balance is a cost, never coverage, so it never moves
 * the exit code. A file whose test runs near the per-test bound runs by itself after the shard's others (`ALONE`), and
 * `verify unit` warns of one not listed (`nearBoundLines`). This file never imports
 * scripts/oracle-legs.ts, which reaches the engine's gaps and the oracle's decisions.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ORACLE, TEST_BOUND_ARGS, TEST_TIMEOUT_MS } from "./gate.ts";
import { SHARDS, entriesText, reportName, runArtifacts } from "./ci-layout.ts";
import type { FileTimes } from "./test-times.ts";

export { SHARDS };
export type Kind = keyof typeof SHARDS;
export const isKind = (k: string | undefined): k is Kind => k === "unit" || k === "rest" || k === "oracle";

/**
 * Seconds of test time on CI's runner, to balance the REST shards: each file's top-level tests summed from the rest
 * shards' logs of run 42469071319 (7769438). Only the files that matter are here: a stale number costs balance, never
 * coverage, and a file not listed counts as `REST_UNLISTED`, so a new one lands in the lightest shard. The unit shards
 * are weighed by tests/fixtures/unit-weights.json.
 */
const REST_WEIGHTS: Readonly<Record<string, number>> = {
  "tests/integration/duck-generated.itest.ts": 316,
  "tests/integration/duck-pool.itest.ts": 219,
  "tests/integration/duck-poll.itest.ts": 160,
  "tests/integration/duck-secret.itest.ts": 141,
  "tests/integration/duck-stream.itest.ts": 136,
  "tests/integration/duck-libc-read.itest.ts": 129,
  "tests/integration/cli-upgrade.itest.ts": 123,
  "tests/integration/cli-sources.itest.ts": 82,
  "tests/integration/duck-serve.itest.ts": 74,
  "tests/integration/duck-json-paths.itest.ts": 14,
  "tests/integration/cli-source-role.itest.ts": 14,
};
const REST_UNLISTED = 3;
/** The executor's stress tests fill every core they get: one to a shard, before anything else is placed. */
export const APART: readonly string[] = ["tests/duck-executor-slow-vector.test.ts", "tests/duck-executor-starve.test.ts", "tests/duck-executor-cancel-stress.test.ts"];
/**
 * A TEST NEAR ITS BOUND RUNS BY ITSELF (issue 338). A unit shard runs its files SIDE_BY_SIDE at once on 4 vCPUs, so a
 * CPU-bound test's time is its neighbours' as much as its own: the generated tables' round 12 took 79-125 s in the one
 * file of the base, beside light files, and 151-300 s in a file of its own beside other generated-world files, where 300 s
 * is the per-test bound (TEST_TIMEOUT_MS) that cancelled it (run 41440605532). A file whose longest top-level test has
 * run past NEAR_BOUND_MS on CI is listed here (round 12; round 6, 157 s in 41431771794; round 7, 158 s in 41440605532;
 * run alone in 41444899410 and 41447115368: round 12 90-143 s, round 6 100-102 s, round 7 95-96 s): its shard runs it
 * after its other files, one ALONE file at a time (`aloneCommand`), so nothing runs beside it, and `partition` counts it
 * SIDE_BY_SIDE times over, the shard's wall it takes. `verify unit` warns of a file not listed whose longest test ran
 * past NEAR_BOUND_MS (`nearBoundLines`); the bound itself is never loosened. With four unit shards (issue 757, run
 * 42477046051) cli-share's longest test took 269.9 s, cli-replica-password's 267.8 s and cli-state-matrix's 201.3 s beside
 * their shards' other files: listed too.
 */
export const ALONE: readonly string[] = ["tests/duck-generated-round12.test.ts", "tests/duck-generated-round6.test.ts", "tests/duck-generated-round7-8.test.ts",
  "tests/cli-share.test.ts", "tests/cli-replica-password.test.ts", "tests/cli-state-matrix.test.ts"];
/** Half the per-test bound: a test past it on one runner's draw is one draw from the bound on a slower one */
export const NEAR_BOUND_MS = TEST_TIMEOUT_MS / 2;
/** The files a unit shard runs at once: Node's default, os.availableParallelism() - 1, on CI's 4-vCPU runners */
export const SIDE_BY_SIDE = 3;

/** tests/fixtures/unit-weights.json: each unit file's wall time in ms, as a CI run's unit shards measured it */
export interface UnitWeights {
  /** the run (or folder) it was measured on */
  from?: string;
  /** the weight of a file not listed: the median listed file's, a guess for one new file until a run measures it */
  default: number;
  files: Record<string, number>;
}
export const UNIT_WEIGHTS_FILE = "tests/fixtures/unit-weights.json";
export const WEIGHTS_COMMAND = (runId: string | undefined): string => `node scripts/ci-shards.ts weights ${runId ?? "<run-id>"}`;
/** THE UNIT SHARDS' BALANCE TARGET: how far apart the slowest and fastest unit shard may run, in ms as run, before
 *  `verify unit` warns to rebalance. Issue 78 asked for the shards "within a minute or so". As run, not scaled: no work is
 *  alike across unit shards to scale by (the oracle legs scale by their setup, PR 332), so a gap is read beside each
 *  shard's CPU, which its record carries. */
export const UNIT_APART_MS = 60_000;

/** The unit weights under `root`; a missing fixture refuses, since no shard runs on a split nobody wrote */
export function readUnitWeights(root: string): UnitWeights {
  const file = path.join(root, UNIT_WEIGHTS_FILE);
  if (!fs.existsSync(file)) throw new Error(`${UNIT_WEIGHTS_FILE} is missing: the unit shards are split by the file times it lists. Write it from a finished CI run's unit shards with \`${WEIGHTS_COMMAND(undefined)}\`, read the diff, and commit it`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as UnitWeights;
}

/** What `partition` balances a kind by, in ms: the unit files' measured times (a file not listed weighs the fixture's
 *  `default`, and an entry for a file gone moves nothing), the integration files' hand table */
export function weightOf(kind: "unit" | "rest", root: string): (file: string) => number {
  if (kind === "rest") return (file) => (REST_WEIGHTS[file] ?? REST_UNLISTED) * 1000;
  const w = readUnitWeights(root);
  return (file) => w.files[file] ?? w.default;
}

/** The files of a kind, as `npm test` and `npm run test:integration` find them: the oracle is its own kind. */
export function testFiles(kind: Kind, root: string): string[] {
  if (kind === "oracle") return [ORACLE];
  const found = fs.globSync(kind === "unit" ? "tests/**/*.test.ts" : "tests/integration/**/*.itest.ts", { cwd: root }).map((f) => f.split(path.sep).join("/"));
  return found.filter((f) => f !== ORACLE).sort();
}

/**
 * The files in `n` shards of about equal weight: `apart` one to a shard, then each `alone` file, heaviest first, into
 * the lightest shard so far, counted SIDE_BY_SIDE times over (it runs with nothing beside it, so it takes that much of
 * its shard's wall), then the rest the same way, heaviest first. It is a function of the list alone, ties going to the
 * lower shard, so every shard's job computes the same partition.
 */
export function partition(files: readonly string[], n: number, weight: (file: string) => number, apart: readonly string[] = [], alone: readonly string[] = []): string[][] {
  const shards = Array.from({ length: n }, () => ({ files: [] as string[], total: 0 }));
  const seeded = apart.filter((f) => files.includes(f));
  seeded.forEach((file, i) => { const s = shards[i % n]!; s.files.push(file); s.total += weight(file); });
  const heaviest = (a: string, b: string): number => weight(b) - weight(a) || (a < b ? -1 : 1);
  const place = (file: string, cost: number): void => {
    const lightest = shards.reduce((best, s) => s.total < best.total ? s : best);
    lightest.files.push(file);
    lightest.total += cost;
  };
  const by = alone.filter((f) => files.includes(f) && !seeded.includes(f)).sort(heaviest);
  for (const file of by) place(file, weight(file) * SIDE_BY_SIDE);
  for (const file of files.filter((f) => !seeded.includes(f) && !by.includes(f)).sort(heaviest)) place(file, weight(file));
  return shards.map((s) => s.files.sort());
}

/** A shard's files. Every oracle shard is a leg of the one file (scripts/oracle-legs.ts), told apart by IT_ORACLE_LEG. */
export function shardFiles(kind: Kind, shard: number, root: string): string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARDS[kind]) throw new RangeError(`${kind} has shards 1 to ${SHARDS[kind]}, not ${shard}`);
  if (kind === "oracle") return [ORACLE];
  return partition(testFiles(kind, root), SHARDS[kind], weightOf(kind, root), APART, kind === "unit" ? ALONE : [])[shard - 1]!;
}

/** The reporter that times each file of a unit shard, and where its shard has it write (`alone`: its ALONE files' run) */
export const TIMES_REPORTER = fileURLToPath(new URL("./test-times.ts", import.meta.url));
export const timesName = (shard: number, alone = false): string => `test-times-unit-${shard}${alone ? "-alone" : ""}.json`;
const unitReporters = (dest: string): string[] => ["--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${TIMES_REPORTER}`, `--test-reporter-destination=${dest}`];

/** The `node` arguments of a unit shard's ALONE files, run after its others: one file at a time, so nothing runs beside
 *  it, under the same per-test bound and the same two reporters, its times written apart */
export function aloneCommand(shard: number, files: readonly string[], out: string): { args: string[]; env: Record<string, string> } {
  if (files.length === 0) throw new Error(`unit shard ${shard} has no ALONE file: \`node --test\` would run every test in the tree`);
  return { args: ["--test", ...TEST_BOUND_ARGS, "--test-concurrency=1", ...unitReporters(path.join(out, timesName(shard, true))), ...files], env: {} };
}

/** The `node` arguments of a shard. Integration files run one at a time (tests/integration/README.md); `--test` with no
 *  file would run every test in the tree, so an empty shard is an error, not a pass. A unit shard carries the per-test
 *  bound before its files (TEST_BOUND_ARGS, scripts/gate.ts): CI never runs `npm test`, so this is where CI holds it. It
 *  reports twice: spec on stdout, as before (ci.yml's `slowest tests` reads those lines), and each file's time into `out`. */
export function shardCommand(kind: Kind, shard: number, files: readonly string[], out: string): { args: string[]; env: Record<string, string> } {
  if (files.length === 0) throw new Error(`${kind} shard ${shard} has no file: \`node --test\` would run every test in the tree`);
  return { args: ["--test", ...(kind === "unit" ? [...TEST_BOUND_ARGS, ...unitReporters(path.join(out, timesName(shard)))] : ["--test-concurrency=1"]), ...files], env: kind === "oracle" ? { IT_ORACLE_LEG: `${shard}/${SHARDS.oracle}`, IT_ORACLE_LEG_REPORT: path.join(out, reportName(shard)) } : {} };
}

/** What a shard wrote of itself. A unit shard's carries its files' times, each file's longest top-level test, its wall
 *  time (its ALONE files' run included) and its runner's CPU; a record
 *  from before the timing has none of them, and `verify` still decides its coverage */
export interface ShardRecord { kind: Kind; shard: number; files: string[]; exit: number; times?: Record<string, number>; longest?: Record<string, number>; wallMs?: number; cpu?: string }
export const recordName = (kind: Kind, shard: number): string => `ran-${kind}-${shard}.json`;

/** The records of a kind in a folder, or in its folders one deep (`gh run download` puts each artifact in one of its own) */
export function readRecords(dir: string, kind: Kind): ShardRecord[] {
  if (!fs.existsSync(dir)) return [];
  const isRecord = (f: string): boolean => f === recordName(kind, Number(/(\d+)\.json$/.exec(f)?.[1]));
  const found = fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? fs.readdirSync(path.join(dir, e.name)).filter(isRecord).map((f) => path.join(dir, e.name, f))
    : isRecord(e.name) ? [path.join(dir, e.name)] : []);
  return found.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as ShardRecord);
}

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

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** `verify unit`'s balance lines, after its coverage verdict: one a shard (its wall time as run, its files' times summed,
 *  its CPU) and one of the gap between the slowest and the fastest, and past UNIT_APART_MS a GitHub warning naming what
 *  closes it: the command that rebalances (`runId`: GITHUB_RUN_ID, in CI this run), or, when the slowest shard's longest
 *  file alone is past the target from the fastest shard, that file (no split runs a shard faster than its longest file;
 *  PR 346's runs: tests/duck-generated.test.ts, 744 s and 853 s, until #338 split it into tests/duck-generated*.test.ts,
 *  no piece past the slowest APART file). A cost, never coverage: nothing here moves the exit code; a shard with no wall
 *  time is "not measured", never a gap of 0. */
export function balanceLines(records: readonly ShardRecord[], runId: string | undefined): string[] {
  const shards = [...records].sort((a, b) => a.shard - b.shard);
  if (shards.length < 2) return [`unit shards: balance: not measured: ${shards.length} shard record(s), where a gap needs two`];
  const untimed = shards.filter((r) => r.wallMs === undefined).map((r) => r.shard);
  if (untimed.length > 0) return [`unit shards: balance: not measured: the record of unit shard(s) ${untimed.join(", ")} has no wall time (a record from before the timing, or a shard that never finished)`];
  const lines = shards.map((r) => `unit shard ${r.shard}: balance: ${seconds(r.wallMs!)} as run, ${r.files.length} file(s)` +
    `${r.times === undefined ? "" : `, their times summed ${seconds(Object.values(r.times).reduce((n, ms) => n + ms, 0))} (files run side by side)`}; runner: ${r.cpu ?? "not reported"}`);
  const slowest = shards.reduce((a, b) => b.wallMs! > a.wallMs! ? b : a), fastest = shards.reduce((a, b) => b.wallMs! < a.wallMs! ? b : a);
  const apart = slowest.wallMs! - fastest.wallMs!;
  lines.push(`unit shards: balance: ${seconds(apart)} apart as run, shard ${slowest.shard} the slowest and ${fastest.shard} the fastest (the target: ${seconds(UNIT_APART_MS)} or less)`);
  if (apart <= UNIT_APART_MS) return lines;
  // ONE FILE'S FLOOR: a shard runs no faster than its longest file, so when that file alone is past the target from the
  // fastest shard, no split closes the gap, and a warning to rebalance would send the reader to a command that cannot
  const longest = Object.entries(slowest.times ?? {}).reduce<[string, number] | null>((a, x) => a === null || x[1] > a[1] ? x : a, null);
  if (longest !== null && longest[1] - fastest.wallMs! > UNIT_APART_MS) {
    lines.push(`::warning title=unit shards::the unit shards ran ${seconds(apart)} apart, past the target of ${seconds(UNIT_APART_MS)}, and no split closes it: ${longest[0]} alone took ${seconds(longest[1])} of shard ${slowest.shard}'s ${seconds(slowest.wallMs!)}, where the fastest shard took ${seconds(fastest.wallMs!)}. Make that file faster, or split it into files`);
  } else {
    lines.push(`::warning title=unit shards::the unit shards ran ${seconds(apart)} apart, past the target of ${seconds(UNIT_APART_MS)}: rebalance with \`${WEIGHTS_COMMAND(runId)}\` (from this run's unit shards), read the diff of ${UNIT_WEIGHTS_FILE}, and commit it`);
  }
  return lines;
}

/** `verify unit`'s warnings of a test near its bound (ALONE): a file whose longest top-level test ran past NEAR_BOUND_MS,
 *  not listed in ALONE, is named with the way out (list it, so it runs with nothing beside it), and one listed that ran
 *  past it even alone is named too (make that test faster: nothing is left to take from beside it). A warning, never the
 *  exit code; the test that crossed the bound itself failed its shard already. */
export function nearBoundLines(records: readonly ShardRecord[]): string[] {
  return [...records].sort((a, b) => a.shard - b.shard).flatMap((r) => Object.entries(r.longest ?? {}).filter(([, ms]) => ms > NEAR_BOUND_MS).sort((a, b) => b[1] - a[1]).map(([file, ms]) => ALONE.includes(file)
    ? `::warning title=unit shards::${file}'s longest test took ${seconds(ms)} in unit shard ${r.shard}, run alone, past half its bound of ${seconds(TEST_TIMEOUT_MS)}: nothing ran beside it, so make that test faster`
    : `::warning title=unit shards::${file}'s longest test took ${seconds(ms)} in unit shard ${r.shard}, past half its bound of ${seconds(TEST_TIMEOUT_MS)}, beside the shard's other files: add it to ALONE (scripts/ci-shards.ts), so it runs with nothing beside it`));
}

/** `weights`: the unit weights from the shards' records, or why they cannot give them: a shard missing or recorded twice,
 *  a shard that failed (a failed file's time is cut short), a record with no times, a file with no time. `from` names the
 *  run or folder. */
export function weightsFromShards(records: readonly ShardRecord[], from: string): { weights: UnitWeights } | { problems: string[] } {
  const ran = [...new Set(records.flatMap((r) => r.files))].sort();
  const problems = coverageProblems("unit", records, ran).map((p) => `${from}: ${p}`);
  for (const r of [...records].sort((a, b) => a.shard - b.shard)) {
    if (r.exit !== 0) problems.push(`unit shard ${r.shard} of ${from} exited ${r.exit}: a failed file's time is cut short. Use a run whose unit shards passed`);
    if (r.times === undefined) problems.push(`the record of unit shard ${r.shard} of ${from} has no times: the run predates the timing. Use a run of a commit that times its files`);
    else for (const f of r.files) if (r.times[f] === undefined) problems.push(`${f} ran in unit shard ${r.shard} of ${from} but has no time`);
  }
  if (problems.length > 0) return { problems };
  const files = Object.fromEntries(records.flatMap((r) => r.files.map((f): [string, number] => [f, Math.round(r.times![f]!)])).sort(([a], [b]) => a < b ? -1 : 1));
  const ms = Object.values(files).sort((a, b) => a - b);
  const median = ms.length % 2 === 1 ? ms[(ms.length - 1) / 2]! : (ms[ms.length / 2 - 1]! + ms[ms.length / 2]!) / 2;
  return { weights: { from, default: Math.max(1, Math.round(median)), files } };
}

/** the fixture's text: one file a line, so its diff can be read */
export const unitWeightsText = (w: UnitWeights): string => entriesText({ from: w.from, default: w.default }, "files", w.files);

/** `weights`: tests/fixtures/unit-weights.json under `root` from the records in `dir`, and what to say; nothing is
 *  written when the records cannot give it */
export function writeUnitWeights(dir: string, root: string, from: string): { code: 0 | 1; out: string[]; err: string[] } {
  const got = weightsFromShards(readRecords(dir, "unit"), from);
  if ("problems" in got) return { code: 1, out: [], err: [...got.problems.map((p) => `unit shards: ${p}`), "unit shards: nothing written"] };
  fs.writeFileSync(path.join(root, UNIT_WEIGHTS_FILE), unitWeightsText(got.weights));
  return { code: 0, out: [`unit shards: wrote ${UNIT_WEIGHTS_FILE}: ${Object.keys(got.weights.files).length} file(s) by their measured time, every other ${got.weights.default} ms; read the diff, then commit it`], err: [] };
}

/**
 * THE DOCS PATH (issue 339; ci.yml's `changes` and `docs` jobs). A pull request that changes nothing but docs runs the
 * unit tests that read a doc (DOCS_TESTS) in place of the build, the unit shards, the oracle legs and the rest shards
 * (DOCS_SKIPS), and every required check still reports by name. This file is the one place each fact is decided:
 * what a doc is (`docsPath`), what changed (`changesVerdict`, from git on the commit CI checked out), what a docs-only run
 * skips, and what passes a required check (`needsProblems`, which reads the mode from NEEDS itself). Whatever cannot be
 * told is never docs: the full run is the safe answer, and a gate that cannot tell the mode fails.
 */

/** The folders whose `.md` files are docs; every other folder is code, a new one included, until someone decides
 *  otherwise. `.claude/`, `.github/`, `src/` (its web page serves a README), `cli/` (the package's README), `tests/` and
 *  `scripts/` hold `.md` files that a test, a workflow, the package or the page reads. */
export const DOCS_FOLDERS: readonly string[] = ["docs", "deploy", "release-notes"];

/** A path (as git names it, from the root) is docs iff it ends in `.md`, case and all, it is not a CLAUDE.md at any depth
 *  (instructions, which the harness and its tests read), and it is a root file or under DOCS_FOLDERS. */
export function docsPath(p: string): boolean {
  const parts = p.split("/");
  if (!p.endsWith(".md") || parts.at(-1) === "CLAUDE.md") return false;
  return parts.length === 1 || DOCS_FOLDERS.includes(parts[0]!);
}

/** A change is docs-only iff it names at least one path and every one is docs: an empty list is "couldn't tell". */
export const docsOnly = (paths: readonly string[]): boolean => paths.length > 0 && paths.every(docsPath);

/** The jobs a docs-only run skips: ci.yml runs each only when `needs.changes.outputs.docs == 'false'`. */
export const DOCS_SKIPS: readonly string[] = ["build", "unit", "oracle", "collation", "rest"];

/**
 * THE DOCS JOB'S TESTS: every unit test file that reads a doc, so a docs-only change still meets each guard over it (the
 * links, the paths a doc names, the goldens a doc carries). An entry with a `pattern` runs only the tests whose name
 * matches it (`--test-name-pattern`), where the rest of the file is the engine's. tests/ci-shards.test.ts holds the list
 * to the tree: every file exists, every pattern names a test, and every unit test reading a doc is here or exempted there.
 */
export const DOCS_TESTS: ReadonlyArray<{ file: string; pattern?: string }> = [
  // the path guard, the link guard over the README and docs/, the recipes' files, the durations CONTRIBUTING.md states
  { file: "tests/conventions.test.ts" },
  // docs/SQL-SUPPORT.md and the README's counts are what the registry renders
  { file: "tests/duck-gaps.test.ts" },
  // the README's and docs/MEASUREMENTS.md's numbers are what the bench fixture renders
  { file: "tests/bench-replica.test.ts" },
  // docs/POSTGRES-API.md
  { file: "tests/postgres-api/docs.test.ts" },
  // the README's install and doctor lines
  { file: "tests/cli-doctor.test.ts" },
  // every test command a doc instructs (`git ls-files '*.md'`) is one the hook lets through; the file's others read no doc
  { file: "tests/hooks.test.ts", pattern: "test-timeout: every test command the docs instruct" },
  // release-notes/v0.9.0.md names the numeric forms; the file's other tests are the engine's
  { file: "tests/duck-generated.test.ts", pattern: "the guide, the rules file and the release note name the numeric forms" },
  // `--write` renders README.md's block and docs/SQL-SUPPORT.md, held byte for byte to the committed ones; the file's
  // other tests are the legs' partition and balance, which read no doc
  { file: "tests/oracle-legs.test.ts", pattern: "^--write" },
  // docs/WEB-UI.md "An operator's table edits" names every key of the contract; the file's other tests read no doc
  { file: "tests/cli-operator-tables.test.ts", pattern: "^the doc names every key of the contract" },
  // the Helm chart under deploy/, rendered: a change to the chart alone is a docs-only run
  { file: "tests/deploy-helm.test.ts" },
];

/** The `node` invocations of the docs job: the per-test bound before the files (CI never runs `npm test`), the files
 *  with no pattern in one, and each patterned file in one of its own, since `--test-name-pattern` applies to every file
 *  of an invocation. */
export function docsCommands(tests: ReadonlyArray<{ file: string; pattern?: string }> = DOCS_TESTS): string[][] {
  const whole = tests.filter((t) => t.pattern === undefined).map((t) => t.file);
  return [
    ...(whole.length > 0 ? [["--test", ...TEST_BOUND_ARGS, ...whole]] : []),
    ...tests.filter((t) => t.pattern !== undefined).map((t) => ["--test", ...TEST_BOUND_ARGS, `--test-name-pattern=${t.pattern!}`, t.file]),
  ];
}

/** `changes`: whether the commit checked out changes nothing but docs, and the lines that say what was classified and
 *  why. A `pull_request` run checks out GitHub's merge of the head into the base, so the merge's first parent is the base
 *  and `HEAD^1..HEAD` is the pull request's net change (`--no-renames`: a rename's both paths; `-z`: a path as is). Any
 *  other event (a push to main runs everything, and is the backstop), any other HEAD, a git failure, or no path at all is
 *  "couldn't tell", which is never docs. */
export function changesVerdict(root: string, event: string | undefined): { docs: boolean; lines: string[] } {
  const full = (why: string): { docs: false; lines: string[] } => ({ docs: false, lines: [`changes: cannot tell that only docs changed: ${why}`, "changes: docs=false: every job runs"] });
  if (event !== "pull_request") return full(`the event is ${event ?? "not set (GITHUB_EVENT_NAME)"}, not pull_request: a run on main always runs everything`);
  const git = (args: string[]): { out: string } | { err: string } => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return r.status === 0 ? { out: r.stdout } : { err: `\`git ${args.join(" ")}\` exited ${r.status ?? r.signal}: ${(r.stderr || r.error?.message || "").trim()}` };
  };
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]);
  if ("err" in parents) return full(parents.err);
  const n = parents.out.trim().split(/\s+/).length - 1;
  if (n !== 2) return full(`HEAD has ${n} parent(s), not the two of GitHub's merge of the pull request into its base`);
  const diff = git(["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"]);
  if ("err" in diff) return full(diff.err);
  const paths = diff.out.split("\0").filter((p) => p !== "");
  if (paths.length === 0) return full("the merge changes no path");
  const docs = docsOnly(paths);
  return { docs, lines: [...paths.map((p) => `changes: ${docsPath(p) ? "docs" : "code"}  ${p}`),
    docs ? `changes: docs=true: ${paths.length} path(s), every one docs: the docs job runs in place of ${DOCS_SKIPS.join(", ")}` : `changes: docs=false: ${paths.filter((p) => !docsPath(p)).length} of ${paths.length} path(s) are code: every job runs`] };
}

interface Need { result?: string; outputs?: Record<string, string> }

/**
 * The jobs of a required check that did not pass, by the mode `changes` decided, read from NEEDS itself (toJSON(needs)
 * carries each need's outputs). `changes` must be in NEEDS, succeed, and say docs exactly "true" or "false", or the mode
 * cannot be told and the check fails. A full run (docs=false): every job must succeed, but `docs`, which it skips. A
 * docs-only run (docs=true): a job in DOCS_SKIPS may be skipped, never failed or cancelled, and every other must succeed.
 * Only that: a skipped job counts as passing a required check on GitHub. No job at all is one problem too.
 */
export function needsProblems(needsJson: string | undefined): string[] {
  const needs = JSON.parse(needsJson ?? "{}") as Record<string, Need>;
  const jobs = Object.entries(needs);
  if (jobs.length === 0) return ["the check has no job behind it: NEEDS is empty"];
  const changes = needs.changes;
  const problems: string[] = [];
  let mode: string | undefined;
  if (changes === undefined) problems.push("changes: not in NEEDS, so whether this run is docs-only cannot be told");
  else if (changes.result !== "success") problems.push(`changes: ${changes.result ?? "no result"}, so whether this run is docs-only cannot be told`);
  else if (changes.outputs?.docs !== "true" && changes.outputs?.docs !== "false") problems.push(`changes: its output docs is ${JSON.stringify(changes.outputs?.docs) ?? "not set"}, not "true" or "false", so whether this run is docs-only cannot be told`);
  else mode = changes.outputs.docs;
  const mayBeSkipped = (name: string): boolean => mode === "true" ? DOCS_SKIPS.includes(name) : name === "docs";
  for (const [name, j] of jobs) {
    if (name === "changes" || j.result === "success" || (j.result === "skipped" && mayBeSkipped(name))) continue;
    problems.push(`${name}: ${j.result ?? "no result"}`);
  }
  return problems;
}

/** the files' times and longest tests the timing reporter wrote, those of the shard's files alone; undefined when it
 *  wrote none */
function readTimes(file: string, files: readonly string[]): FileTimes | undefined {
  if (!fs.existsSync(file)) return undefined;
  const all = JSON.parse(fs.readFileSync(file, "utf8")) as FileTimes;
  const own = (m: Record<string, number>): Record<string, number> => Object.fromEntries(files.filter((f) => m[f] !== undefined).map((f) => [f, m[f]!]));
  return { files: own(all.files), longest: own(all.longest) };
}

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [what, kind, arg] = argv;
  if (what === "needs") {
    const problems = needsProblems(process.env.NEEDS);
    for (const p of problems) console.error(`this check needs every job behind it to succeed: ${p}`);
    if (problems.length === 0) {
      const needs = JSON.parse(process.env.NEEDS!) as Record<string, Need>;
      const skipped = Object.keys(needs).filter((n) => needs[n]!.result === "skipped");
      console.log(`every job behind this check succeeded: ${Object.keys(needs).filter((n) => !skipped.includes(n)).join(", ")}` +
        (skipped.length === 0 ? "" : `; skipped, as a ${needs.changes!.outputs!.docs === "true" ? "docs-only" : "full"} run skips it: ${skipped.join(", ")}`));
    }
    return problems.length === 0 ? 0 : 1;
  }
  if (what === "changes") {
    if (argv.length > 1) { console.error("usage: scripts/ci-shards.ts changes"); return 2; }
    const out = process.env.GITHUB_OUTPUT;
    if (out === undefined || out === "") { console.error("set GITHUB_OUTPUT: the file the docs=true or docs=false verdict is written to (GitHub Actions sets it)"); return 2; }
    const v = changesVerdict(root, process.env.GITHUB_EVENT_NAME);
    for (const l of v.lines) console.log(l);
    fs.appendFileSync(out, `docs=${v.docs}\n`);
    return 0;
  }
  if (what === "docs") {
    if (argv.length > 1) { console.error("usage: scripts/ci-shards.ts docs"); return 2; }
    let failed = 0;
    for (const args of docsCommands()) {
      console.log(`docs: node ${args.join(" ")}`);
      const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
      // a signal leaves status null: never a pass
      if (r.status !== 0) { failed++; console.error(`docs: \`node ${args.join(" ")}\` exited ${r.status ?? r.signal}`); }
    }
    return failed === 0 ? 0 : 1;
  }
  if (what === "weights") {
    const from = kind;
    if (from === undefined || argv.length > 2) { console.error("usage: scripts/ci-shards.ts weights <run-id | folder of the ran-unit-* artifacts>"); return 2; }
    const got = runArtifacts(from, "ran-unit-*", root, "unit shards", "shards");
    if ("err" in got) { for (const l of got.err) console.error(l); return 1; }
    for (const l of got.out) console.log(l);
    const r = writeUnitWeights(got.dir, root, from);
    for (const l of r.out) console.log(l);
    for (const l of r.err) console.error(l);
    return r.code;
  }
  if (!isKind(kind) || arg === undefined || !["run", "files", "verify"].includes(what ?? "")) {
    console.error("usage: scripts/ci-shards.ts run|files <unit|rest|oracle> <shard>, verify <unit|rest|oracle> <dir>, weights <run-id | folder>, needs, changes, or docs");
    return 2;
  }
  if (what === "verify") {
    const records = readRecords(arg, kind);
    const files = testFiles(kind, root);
    const problems = coverageProblems(kind, records, files);
    for (const p of problems) console.error(p);
    if (problems.length === 0) console.log(`${kind}: ${files.length} file(s), each in exactly one of ${records.length} shards`);
    // the balance, after the verdict and whatever it was: a cost, said and warned of, never the exit code
    if (kind === "unit") for (const l of [...balanceLines(records, process.env.GITHUB_RUN_ID), ...nearBoundLines(records)]) console.log(l);
    return problems.length === 0 ? 0 : 1;
  }
  const shard = Number(arg);
  let files: string[];
  try { files = shardFiles(kind, shard, root); } catch (e) { console.error((e as Error).message); return e instanceof RangeError ? 2 : 1; }
  if (what === "files") { for (const f of files) console.log(f); return 0; }
  const out = process.env.CI_SHARD_DIR;
  if (out === undefined) { console.error("set CI_SHARD_DIR: the folder of the shard's record"); return 2; }
  fs.mkdirSync(out, { recursive: true });
  // a unit shard's ALONE files run after its others, one at a time; every phase runs, whatever the one before it did
  const alone = kind === "unit" ? files.filter((f) => ALONE.includes(f)) : [];
  const together = files.filter((f) => !alone.includes(f));
  const phases = [...(together.length > 0 || alone.length === 0 ? [{ ...shardCommand(kind, shard, together, out), timesFile: path.join(out, timesName(shard)) }] : []),
    ...(alone.length > 0 ? [{ ...aloneCommand(shard, alone, out), timesFile: path.join(out, timesName(shard, true)) }] : [])];
  const weight = kind === "oracle" ? null : weightOf(kind, root);
  console.log(`${kind} shard ${shard} of ${SHARDS[kind]}: ${files.length} file(s)${weight === null ? "" : `, about ${seconds(files.reduce((n, f) => n + weight(f), 0))} of test time`}${alone.length === 0 ? "" : `, ${alone.length} of them run alone after the others: ${alone.join(", ")}`}`);
  const started = performance.now();
  // a signal leaves status null: never a pass
  const statuses = phases.map(({ args, env }) => spawnSync(process.execPath, args, { stdio: "inherit", cwd: root, env: { ...process.env, ...env } }).status ?? 1);
  const wallMs = Math.round(performance.now() - started);
  const exit = statuses.find((s) => s !== 0) ?? 0;
  const record: ShardRecord = { kind, shard, files, exit };
  if (kind === "unit") {
    const read = phases.map((p) => readTimes(p.timesFile, files));
    for (const p of phases) fs.rmSync(p.timesFile, { force: true });
    const complete = read.every((t) => t !== undefined);
    if (!complete) console.error(`unit shard ${shard}: the timing reporter wrote no times, so this shard's record has none and \`weights\` will refuse this run`);
    const merged = complete ? { times: Object.assign({}, ...read.map((t) => t!.files)) as Record<string, number>, longest: Object.assign({}, ...read.map((t) => t!.longest)) as Record<string, number> } : {};
    Object.assign(record, { ...merged, wallMs, cpu: `${os.cpus()[0]?.model.trim() ?? "unknown"} × ${os.cpus().length}` });
  }
  fs.writeFileSync(path.join(out, recordName(kind, shard)), JSON.stringify(record));
  return exit;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
