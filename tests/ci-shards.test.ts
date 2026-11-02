/**
 * CI'S SHARDS AND ITS FOUR REQUIRED CHECKS (scripts/ci-shards.ts, .github/workflows/ci.yml): a new test file lands in a
 * shard by itself, a file left out or run twice fails `verify`, only `success` passes a check, and the workflow keeps the
 * names the ruleset on main requires, each behind every job it stands for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { SHARDS, coverageProblems, needsProblems, partition, shardCommand, shardFiles, testFiles, weightOf, type ShardRecord } from "../scripts/ci-shards.ts";
import { ORACLE } from "../scripts/gate.ts";
// a namespace, not a named import: a tree whose gate.ts lacks the constant still loads, and the test fails by name
import * as gate from "../scripts/gate.ts";
import { reportName } from "../scripts/ci-layout.ts";
import { PHASES, STAGES, statementId, type LegReport } from "../scripts/oracle-legs.ts";
import { GAPS } from "../src/duck/gaps.ts";
import { VERIFIED } from "../src/duck/verified.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every test file of the tree is in exactly one shard, the oracle in none but its own legs", () => {
  for (const kind of ["unit", "rest"] as const) {
    const files = testFiles(kind, ROOT);
    assert.ok(files.length > (kind === "unit" ? 50 : 5), `${kind} found ${files.length} files: has the glob moved?`);
    const shards = Array.from({ length: SHARDS[kind] }, (_, i) => shardFiles(kind, i + 1, ROOT));
    assert.deepEqual(shards.flat().sort(), files);
    assert.ok(shards.every((s) => s.length > 0), "no shard is empty");
    assert.ok(!files.includes(ORACLE));
  }
  assert.ok(testFiles("unit", ROOT).includes("tests/postgres-api/catalog.test.ts"), "a subfolder's files are found, as npm test finds them");
  assert.deepEqual([shardFiles("oracle", 1, ROOT), shardFiles("oracle", 2, ROOT)], [[ORACLE], [ORACLE]]);
  assert.throws(() => shardFiles("unit", SHARDS.unit + 1, ROOT), /has shards 1 to 3/);
});

test("the executor's three stress tests land in different shards", () => {
  const stress = ["tests/duck-executor-slow-vector.test.ts", "tests/duck-executor-starve.test.ts", "tests/duck-executor-cancel-stress.test.ts"];
  const shards = Array.from({ length: SHARDS.unit }, (_, i) => shardFiles("unit", i + 1, ROOT));
  assert.deepEqual(stress.map((f) => shards.filter((s) => s.includes(f)).length), [1, 1, 1]);
  assert.equal(new Set(stress.map((f) => shards.findIndex((s) => s.includes(f)))).size, 3);
});

test("a new file lands in a shard by itself, and the partition is a function of the list alone", () => {
  const files = testFiles("unit", ROOT);
  const now = partition(files, 3, weightOf);
  const newFile = ["tests", "new.test.ts"].join("/");   // built, as the convention holds a path written here to the tree
  const added = partition([...files, newFile], 3, weightOf);
  assert.equal(added.flat().filter((f) => f === newFile).length, 1);
  assert.deepEqual(added.flat().sort(), [...files, newFile].sort());
  assert.deepEqual(partition([...files].reverse(), 3, weightOf), now, "the same list in another order");
  // the heaviest goes first, each into the lightest shard
  assert.deepEqual(partition(["a", "b", "c", "d"], 2, (f) => ({ a: 5, b: 4, c: 3, d: 3 })[f]!), [["a", "d"], ["b", "c"]]);
});

test("a shard with no file is an error: `node --test` alone would run every test in the tree", () => {
  assert.throws(() => shardCommand("unit", 1, [], "o"), /has no file/);
  // CI never runs `npm test`: a unit shard carries the per-test pair itself, before its files (issue 139)
  assert.deepEqual(gate.TEST_BOUND_ARGS, ["--test-timeout=300000", "--test-force-exit"]);
  assert.deepEqual(shardCommand("unit", 1, ["a"], "o"), { args: ["--test", ...gate.TEST_BOUND_ARGS, "a"], env: {} });
  assert.deepEqual(shardCommand("rest", 2, ["a"], "o"), { args: ["--test", "--test-concurrency=1", "a"], env: {} });
  assert.deepEqual(shardCommand("oracle", 2, ["a"], "o").env, { IT_ORACLE_LEG: "2/2", IT_ORACLE_LEG_REPORT: path.join("o", "duck-oracle-leg-2.json") });
});

test("verify fails on a file in no shard, in two, on one not in the tree, and on a shard that left no record", () => {
  const rec = (shard: number, files: string[]): ShardRecord => ({ kind: "unit", shard, files, exit: 0 });
  const tree = ["a", "b", "c"];
  assert.deepEqual(coverageProblems("unit", [rec(1, ["a"]), rec(2, ["b"]), rec(3, ["c"])], tree), []);
  assert.deepEqual(coverageProblems("unit", [rec(1, ["a"]), rec(2, ["b"]), rec(3, [])], tree), ["c ran in no unit shard"]);
  assert.deepEqual(coverageProblems("unit", [rec(1, ["a", "c"]), rec(2, ["b"]), rec(3, ["c"])], tree), ["c ran in unit shards 1 and 3"]);
  assert.deepEqual(coverageProblems("unit", [rec(1, ["a", "z"]), rec(2, ["b"]), rec(3, ["c"])], tree), ["z ran in unit shard 1 but is not in the tree"]);
  assert.deepEqual(coverageProblems("unit", [rec(1, ["a", "b"]), rec(3, ["c"])], tree), ["unit: the records are of shard(s) 1,3, where 1,2,3 must each have run once"]);
  assert.deepEqual(coverageProblems("oracle", [{ kind: "oracle", shard: 1, files: ["o"], exit: 0 }], ["o"]), ["oracle: the records are of shard(s) 1, where 1,2 must each have run once"]);
});

test("only success passes: a failed, skipped or cancelled job, or none, fails the check", () => {
  const ok = { build: { result: "success" }, unit: { result: "success" } };
  assert.deepEqual(needsProblems(JSON.stringify(ok)), []);
  for (const result of ["failure", "skipped", "cancelled"]) assert.deepEqual(needsProblems(JSON.stringify({ ...ok, unit: { result } })), [`unit: ${result}`]);
  assert.deepEqual(needsProblems("{}"), ["the check has no job behind it: NEEDS is empty"]);
  assert.deepEqual(needsProblems(undefined), ["the check has no job behind it: NEEDS is empty"]);
});

interface Job { name?: string; needs?: string[]; if?: string; strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } }; steps?: Array<{ run?: string; env?: Record<string, string>; if?: string; name?: string; with?: Record<string, string> }> }
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"), { merge: true }) as { jobs: Record<string, Job> };

test("the four required checks are there by name, once each, and no shard can pass for one", () => {
  const names = Object.entries(workflow.jobs).map(([id, j]) => j.name ?? id);
  for (const required of ["checks", "image", "integration (oracle)", "integration (rest)"]) assert.equal(names.filter((n) => n === required).length, 1, required);
});

test("each required check runs always, passes only on success, and stands for every job but the image", () => {
  const gates: Array<[string, string[]]> = [["checks", ["build", "unit"]], ["integration-oracle", ["oracle"]], ["integration-rest", ["rest"]]];
  for (const [id, needs] of gates) {
    const gate = workflow.jobs[id]!;
    assert.deepEqual(gate.needs, needs, id);
    assert.equal(gate.if, "${{ always() }}", `${id}: a skipped or cancelled shard must reach this job`);
    const step = gate.steps!.find((s) => s.run === "node scripts/ci-shards.ts needs");
    assert.ok(step, `${id} reads every need's result`);
    assert.equal(step.env?.NEEDS, "${{ toJSON(needs) }}", id);
    assert.equal(step.if, undefined, `${id}: the verdict never has a condition of its own`);
    const verify = gate.steps!.find((s) => s.run?.startsWith("node scripts/ci-shards.ts verify "));
    assert.ok(verify, `${id} verifies what ran`);
    assert.notEqual(verify.if, undefined, `${id}: verify still reports beside a failed shard`);
  }
  assert.ok(workflow.jobs["integration-oracle"]!.steps!.some((s) => s.run === "node scripts/oracle-legs.ts ran"), "the oracle's check holds the legs to the whole");
  assert.deepEqual(Object.keys(workflow.jobs).filter((id) => id !== "image" && !gates.some(([gate, needs]) => gate === id || needs.includes(id))), [], "a job no required check stands for gates nothing");
});

test("the matrices are the shards scripts/ci-shards.ts counts, and no failure stops a sibling", () => {
  for (const [id, n] of [["unit", SHARDS.unit], ["oracle", SHARDS.oracle], ["rest", SHARDS.rest]] as const) {
    const job = workflow.jobs[id]!;
    assert.deepEqual(job.strategy?.matrix?.shard, Array.from({ length: n }, (_, i) => i + 1), id);
    assert.equal(job.strategy?.["fail-fast"], false, id);
  }
  // the build job's checks each run whatever failed before them
  const build = workflow.jobs.build!;
  const checked = build.steps!.filter((s) => s.name !== undefined);
  assert.ok(checked.length >= 4 && checked.every((s) => s.if === "${{ !cancelled() }}"), "every named check of build runs after a failure");
});

// CI's final jobs run these two as programs, and a fault of the program alone (a cycle's unsettled top-level await: Node's
// exit 13, nothing printed) passes every test that imports them: so they are run here as CI runs them.
const program = (script: string, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8", cwd: ROOT, env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
};

function legsFolder(t: { after(f: () => void): void }): { dir: string; reports: [LegReport, LegReport] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-legs-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/oracle-duckdb-alone.json"), "utf8")) as Pick<LegReport["tallies"], "mason" | "duckdb">;
  const statements = [1, 2].map((n) => ({ group: "g", name: `statement ${n}`, sql: `SELECT ${n}` }));
  const whole = statements.map((q) => ({ id: statementId(q), name: q.name }));
  const leg = (n: 1 | 2): LegReport => ({ leg: n, of: 2, whole, asked: Object.fromEntries(PHASES.map((p) => [p, [whole[n - 1]!.id]])), stages: n === 1 ? Object.fromEntries(STAGES.map((s) => [s, 1])) : {}, shaped: 0,
    tallies: { statements: 1, mason: n === 1 ? fixture.mason : {}, duckdb: n === 1 ? fixture.duckdb : {} }, copyPhase: { refused: {}, decided: {} },
    everyAsk: { refused: {}, decided: n === 1 ? Object.fromEntries(Object.keys(GAPS).map((id) => [id, { planted: 1, natural: 0 }])) : {} }, decisions: [], verified: n === 1 ? [...VERIFIED.keys()] : [], names: n === 1 ? Object.fromEntries(VERIFIED) : {}, asks: 3,
    measured: { what: "w", machine: "linux x64", postgres: "PostgreSQL 18 on x86_64-pc-linux-gnu", collation: "en_US.utf8 (c)", shapes: true }, differences: 0 });
  return { dir, reports: [leg(1), leg(2)] };
}
const write = (dir: string, reports: readonly LegReport[]): void => { for (const r of reports) fs.writeFileSync(path.join(dir, reportName(r.leg)), JSON.stringify(r)); };

test("scripts/oracle-legs.ts run as CI runs it: exit 0 on legs that are the whole, 1 on a statement left out, 2 with no folder", (t) => {
  const { dir, reports } = legsFolder(t);
  write(dir, reports);
  const good = program("oracle-legs.ts", [dir]);
  assert.equal(good.status, 0, good.out);
  assert.match(good.out, /oracle legs: 1 \+ 1 = 2 statements, each asked in all 3 phases by exactly one leg/);
  reports[1].asked[PHASES[2]] = [];
  write(dir, reports);
  const bad = program("oracle-legs.ts", [dir]);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /no leg asked "statement 2"/);
  fs.rmSync(path.join(dir, reportName(1)));
  fs.rmSync(path.join(dir, reportName(2)));
  const none = program("oracle-legs.ts", [dir]);
  assert.equal(none.status, 1, none.out);
  assert.match(none.out, /the reports are of leg\(s\) none/);
  assert.equal(program("oracle-legs.ts", []).status, 2);
  // --write: a usage error is 2; a folder with no legs writes nothing (the tree's files are untouched) and is 1
  assert.equal(program("oracle-legs.ts", ["--write"]).status, 2);
  assert.equal(program("oracle-legs.ts", ["--write", dir, "extra"]).status, 2);
  const nothing = program("oracle-legs.ts", ["--write", dir]);
  assert.equal(nothing.status, 1, nothing.out);
  assert.match(nothing.out, /the reports are of leg\(s\) none[\s\S]*nothing written/);
});

test("scripts/ci-shards.ts run as CI runs it: files, needs and verify each end with their exit code", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-shards-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const files = program("ci-shards.ts", ["files", "unit", "1"]);
  assert.equal(files.status, 0, files.out);
  assert.ok(files.out.split("\n").includes(shardFiles("unit", 1, ROOT)[0]!), files.out);
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ a: { result: "success" } }) }).status, 0);
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ a: { result: "skipped" } }) }).status, 1);
  assert.equal(program("ci-shards.ts", ["verify", "rest", dir]).status, 1, "no records");
  for (let shard = 1; shard <= SHARDS.rest; shard++) fs.writeFileSync(path.join(dir, `ran-rest-${shard}.json`), JSON.stringify({ kind: "rest", shard, files: shardFiles("rest", shard, ROOT), exit: 0 }));
  const verified = program("ci-shards.ts", ["verify", "rest", dir]);
  assert.equal(verified.status, 0, verified.out);
  assert.equal(program("ci-shards.ts", ["nothing"]).status, 2);
});
