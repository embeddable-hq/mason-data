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
 *   node scripts/ci-shards.ts needs                every job in NEEDS (`toJSON(needs)`) succeeded
 *   node scripts/ci-shards.ts weights <run-id | folder>   write tests/fixtures/unit-weights.json from a run's unit shards
 *
 * Exit 0 when it holds (`run`: the tests' own exit), 1 when not, 2 on a bad argument.
 *
 * `verify` reads the records the shards wrote, never the partition again: a matrix that lost a shard, or a shard that
 * ran something else, is caught, where recomputing `partition` here would only agree with itself. `needs` takes `success`
 * alone: a job that was skipped or cancelled counts as passing a required check on GitHub, so nothing else may pass.
 *
 * THE UNIT SHARDS' BALANCE. A unit shard's run gives `node --test` a second reporter beside the spec one
 * (scripts/test-times.ts: each file's wall time, as the runner itself reports it), and its record carries those times,
 * its own wall time and its runner's CPU. `weights` writes the fixture from a finished run's `ran-unit-*` records, as
 * `scripts/oracle-legs.ts --weights` writes the oracle's (the run check, the download and the fixture's text are
 * ci-layout.ts's, shared). `verify unit` then says how far apart the shards ran and warns past UNIT_APART_MS, naming
 * that command, or the one file no split can help (`balanceLines`): balance is a cost, never coverage, so it never moves
 * the exit code. This file never imports
 * scripts/oracle-legs.ts, which reaches the engine's gaps and the oracle's decisions.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ORACLE, TEST_BOUND_ARGS } from "./gate.ts";
import { SHARDS, entriesText, reportName, runArtifacts } from "./ci-layout.ts";

export { SHARDS };
export type Kind = keyof typeof SHARDS;
export const isKind = (k: string | undefined): k is Kind => k === "unit" || k === "rest" || k === "oracle";

/**
 * Seconds of test time on CI's runner, about (`slowest tests` in a job's log), to balance the REST shards. Only the
 * files that matter are here: a stale number costs balance, never coverage, and a file not listed counts as
 * `REST_UNLISTED`, so a new one lands in the lightest shard. The unit shards are weighed by tests/fixtures/unit-weights.json.
 */
const REST_WEIGHTS: Readonly<Record<string, number>> = {
  "tests/integration/duck-stream.itest.ts": 90,
  "tests/integration/duck-poll.itest.ts": 77,
  "tests/integration/cli-upgrade.itest.ts": 73,
  "tests/integration/cli-sources.itest.ts": 30,
  "tests/integration/duck-serve.itest.ts": 23,
  "tests/integration/duck-json-paths.itest.ts": 11,
};
const REST_UNLISTED = 3;
/** The executor's stress tests fill every core they get: one to a shard, before anything else is placed. */
export const APART: readonly string[] = ["tests/duck-executor-slow-vector.test.ts", "tests/duck-executor-starve.test.ts", "tests/duck-executor-cancel-stress.test.ts"];

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

/** A shard's files. Every oracle shard is a leg of the one file (scripts/oracle-legs.ts), told apart by IT_ORACLE_LEG. */
export function shardFiles(kind: Kind, shard: number, root: string): string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARDS[kind]) throw new RangeError(`${kind} has shards 1 to ${SHARDS[kind]}, not ${shard}`);
  if (kind === "oracle") return [ORACLE];
  return partition(testFiles(kind, root), SHARDS[kind], weightOf(kind, root), APART)[shard - 1]!;
}

/** The reporter that times each file of a unit shard, and where its shard has it write */
export const TIMES_REPORTER = fileURLToPath(new URL("./test-times.ts", import.meta.url));
export const timesName = (shard: number): string => `test-times-unit-${shard}.json`;

/** The `node` arguments of a shard. Integration files run one at a time (tests/integration/README.md); `--test` with no
 *  file would run every test in the tree, so an empty shard is an error, not a pass. A unit shard carries the per-test
 *  bound before its files (TEST_BOUND_ARGS, scripts/gate.ts): CI never runs `npm test`, so this is where CI holds it. It
 *  reports twice: spec on stdout, as before (ci.yml's `slowest tests` reads those lines), and each file's time into `out`. */
export function shardCommand(kind: Kind, shard: number, files: readonly string[], out: string): { args: string[]; env: Record<string, string> } {
  if (files.length === 0) throw new Error(`${kind} shard ${shard} has no file: \`node --test\` would run every test in the tree`);
  const reporters = ["--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${TIMES_REPORTER}`, `--test-reporter-destination=${path.join(out, timesName(shard))}`];
  return { args: ["--test", ...(kind === "unit" ? [...TEST_BOUND_ARGS, ...reporters] : ["--test-concurrency=1"]), ...files], env: kind === "oracle" ? { IT_ORACLE_LEG: `${shard}/${SHARDS.oracle}`, IT_ORACLE_LEG_REPORT: path.join(out, reportName(shard)) } : {} };
}

/** What a shard wrote of itself. A unit shard's carries its files' times, its wall time and its runner's CPU; a record
 *  from before the timing has none of them, and `verify` still decides its coverage */
export interface ShardRecord { kind: Kind; shard: number; files: string[]; exit: number; times?: Record<string, number>; wallMs?: number; cpu?: string }
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

/** The jobs of a required check that did not succeed; no job at all is one problem too. */
export function needsProblems(needsJson: string | undefined): string[] {
  const needs = JSON.parse(needsJson ?? "{}") as Record<string, { result?: string }>;
  const jobs = Object.entries(needs);
  if (jobs.length === 0) return ["the check has no job behind it: NEEDS is empty"];
  return jobs.filter(([, j]) => j.result !== "success").map(([name, j]) => `${name}: ${j.result ?? "no result"}`);
}

/** the files' times the timing reporter wrote, those of the shard's files alone; undefined when it wrote none */
function readTimes(file: string, files: readonly string[]): Record<string, number> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
  return Object.fromEntries(files.filter((f) => all[f] !== undefined).map((f) => [f, all[f]!]));
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
    console.error("usage: scripts/ci-shards.ts run|files <unit|rest|oracle> <shard>, verify <unit|rest|oracle> <dir>, weights <run-id | folder>, or needs");
    return 2;
  }
  if (what === "verify") {
    const records = readRecords(arg, kind);
    const files = testFiles(kind, root);
    const problems = coverageProblems(kind, records, files);
    for (const p of problems) console.error(p);
    if (problems.length === 0) console.log(`${kind}: ${files.length} file(s), each in exactly one of ${records.length} shards`);
    // the balance, after the verdict and whatever it was: a cost, said and warned of, never the exit code
    if (kind === "unit") for (const l of balanceLines(records, process.env.GITHUB_RUN_ID)) console.log(l);
    return problems.length === 0 ? 0 : 1;
  }
  const shard = Number(arg);
  let files: string[];
  try { files = shardFiles(kind, shard, root); } catch (e) { console.error((e as Error).message); return e instanceof RangeError ? 2 : 1; }
  if (what === "files") { for (const f of files) console.log(f); return 0; }
  const out = process.env.CI_SHARD_DIR;
  if (out === undefined) { console.error("set CI_SHARD_DIR: the folder of the shard's record"); return 2; }
  fs.mkdirSync(out, { recursive: true });
  const { args, env } = shardCommand(kind, shard, files, out);
  const weight = kind === "oracle" ? null : weightOf(kind, root);
  console.log(`${kind} shard ${shard} of ${SHARDS[kind]}: ${files.length} file(s)${weight === null ? "" : `, about ${seconds(files.reduce((n, f) => n + weight(f), 0))} of test time`}`);
  const started = performance.now();
  const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root, env: { ...process.env, ...env } });
  const wallMs = Math.round(performance.now() - started);
  // a signal leaves status null: never a pass
  const exit = r.status ?? 1;
  const record: ShardRecord = { kind, shard, files, exit };
  if (kind === "unit") {
    const timesFile = path.join(out, timesName(shard));
    const times = readTimes(timesFile, files);
    fs.rmSync(timesFile, { force: true });
    if (times === undefined) console.error(`unit shard ${shard}: the timing reporter wrote no times, so this shard's record has none and \`weights\` will refuse this run`);
    Object.assign(record, { ...(times === undefined ? {} : { times }), wallMs, cpu: `${os.cpus()[0]?.model.trim() ?? "unknown"} × ${os.cpus().length}` });
  }
  fs.writeFileSync(path.join(out, recordName(kind, shard)), JSON.stringify(record));
  return exit;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
