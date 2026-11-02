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
import { APART, SHARDS, UNIT_WEIGHTS_FILE, coverageProblems, needsProblems, partition, shardCommand, shardFiles, testFiles, weightOf, type ShardRecord } from "../scripts/ci-shards.ts";
// a namespace for the docs path's names (issue 339): a tree without them still loads, and their tests fail by name
import * as shards from "../scripts/ci-shards.ts";
import { ORACLE } from "../scripts/gate.ts";
import { fileOf } from "../scripts/test-times.ts";
// a namespace, not a named import: a tree whose gate.ts lacks the constant still loads, and the test fails by name
import * as gate from "../scripts/gate.ts";
import { reportName } from "../scripts/ci-layout.ts";
import { PHASES, STAGES, statementId, WEIGHTS_FILE, type LegReport } from "../scripts/oracle-legs.ts";
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
  const weight = weightOf("unit", ROOT);
  const now = partition(files, 3, weight);
  const newFile = ["tests", "new.test.ts"].join("/");   // built, as the convention holds a path written here to the tree
  const added = partition([...files, newFile], 3, weight);
  assert.equal(added.flat().filter((f) => f === newFile).length, 1);
  assert.deepEqual(added.flat().sort(), [...files, newFile].sort());
  assert.deepEqual(partition([...files].reverse(), 3, weight), now, "the same list in another order");
  // the heaviest goes first, each into the lightest shard
  assert.deepEqual(partition(["a", "b", "c", "d"], 2, (f) => ({ a: 5, b: 4, c: 3, d: 3 })[f]!), [["a", "d"], ["b", "c"]]);
});

test("a shard with no file is an error: `node --test` alone would run every test in the tree", () => {
  assert.throws(() => shardCommand("unit", 1, [], "o"), /has no file/);
  // CI never runs `npm test`: a unit shard carries the per-test pair itself, before its files (issue 139)
  assert.deepEqual(gate.TEST_BOUND_ARGS, ["--test-timeout=300000", "--test-force-exit"]);
  // and reports twice: spec on stdout as before, each file's time into the shard's folder
  assert.deepEqual(shardCommand("unit", 1, ["a"], "o"), { args: ["--test", ...gate.TEST_BOUND_ARGS, "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${path.join(ROOT, "scripts", "test-times.ts")}`, `--test-reporter-destination=${path.join("o", "test-times-unit-1.json")}`, "a"], env: {} });
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
  const ok = { changes: { result: "success", outputs: { docs: "false" } }, build: { result: "success" }, unit: { result: "success" } };
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
  const gates: Array<[string, string[]]> = [["checks", ["changes", "build", "unit", "docs"]], ["integration-oracle", ["changes", "oracle"]], ["integration-rest", ["changes", "rest"]]];
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
  // --weights: the same, and the tree's weights untouched
  const weights = fs.readFileSync(path.join(ROOT, WEIGHTS_FILE), "utf8");
  for (const args of [["--weights"], ["--weights", dir, "--above"], ["--weights", dir, "--above", "x"], ["--weights", dir, "--below", "5"], ["--weights", dir, "--above", "5", "extra"]]) assert.equal(program("oracle-legs.ts", args).status, 2, args.join(" "));
  const unweighed = program("oracle-legs.ts", ["--weights", dir, "--above", "500"]);
  assert.equal(unweighed.status, 1, unweighed.out);
  assert.match(unweighed.out, /the reports are of leg\(s\) none[\s\S]*nothing written/);
  assert.equal(fs.readFileSync(path.join(ROOT, WEIGHTS_FILE), "utf8"), weights);
});

test("scripts/oracle-legs.ts run as CI runs it says the legs' balance after the verdict, warns past the target, and never moves the exit code", (t) => {
  const { dir, reports } = legsFolder(t);
  write(dir, reports);
  const untimed = program("oracle-legs.ts", [dir]);
  assert.equal(untimed.status, 0, untimed.out);
  assert.match(untimed.out, /oracle legs: balance: not measured: the report of leg\(s\) 1, 2 has no times/);
  assert.doesNotMatch(untimed.out, /::warning/);
  // 120 s apart on alike runners: warned, naming this run's --weights, and still 0
  const timed = reports.map((r, i) => ({ ...r, times: { fixed: { setup: 68000 }, stages: {}, statements: { [`k${i}`]: { ms: i === 0 ? 750000 : 630000, name: `statement ${i + 1}` } }, cpu: "c × 4" } }));
  write(dir, timed);
  const apart = program("oracle-legs.ts", [dir], { GITHUB_RUN_ID: "123" });
  assert.equal(apart.status, 0, apart.out);
  assert.match(apart.out, /oracle legs: 1 \+ 1 = 2 statements[\s\S]*oracle leg 1: balance: setup 68\.0 s; statements and stages 750\.0 s as run, 750\.0 s in one machine's seconds; runner: c × 4\n[\s\S]*oracle legs: balance: 120\.0 s apart as run, 120\.0 s in one machine's seconds/);
  assert.match(apart.out, /^::warning title=oracle legs::the legs are 120\.0 s apart in one machine's seconds, past the target of 60\.0 s: rebalance with `node scripts\/oracle-legs\.ts --weights 123`/m);
  // the imbalance and a statement left out: 1, by the coverage line, and the warning beside it
  timed[1]!.asked[PHASES[2]] = [];
  write(dir, timed);
  const both = program("oracle-legs.ts", [dir], { GITHUB_RUN_ID: "123" });
  assert.equal(both.status, 1, both.out);
  assert.match(both.out, /no leg asked "statement 2"/);
  assert.match(both.out, /::warning title=oracle legs::/);
});

test("scripts/ci-shards.ts run as CI runs it: files, needs and verify each end with their exit code", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-shards-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const files = program("ci-shards.ts", ["files", "unit", "1"]);
  assert.equal(files.status, 0, files.out);
  assert.ok(files.out.split("\n").includes(shardFiles("unit", 1, ROOT)[0]!), files.out);
  const full = { changes: { result: "success", outputs: { docs: "false" } } };
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ ...full, a: { result: "success" } }) }).status, 0);
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ ...full, a: { result: "skipped" } }) }).status, 1);
  assert.equal(program("ci-shards.ts", ["verify", "rest", dir]).status, 1, "no records");
  for (let shard = 1; shard <= SHARDS.rest; shard++) fs.writeFileSync(path.join(dir, `ran-rest-${shard}.json`), JSON.stringify({ kind: "rest", shard, files: shardFiles("rest", shard, ROOT), exit: 0 }));
  const verified = program("ci-shards.ts", ["verify", "rest", dir]);
  assert.equal(verified.status, 0, verified.out);
  assert.equal(program("ci-shards.ts", ["nothing"]).status, 2);
});

// ── the unit shards split by measured time (issue 337) ──────────────────────────────────────────────────────────────
// A path is built, never written whole: the path guard (tests/conventions.test.ts) holds a written one to the tree.
const T = (name: string): string => ["tests", name].join("/");
const SCRIPTS = ["ci-shards.ts", "ci-layout.ts", "gate.ts", "test-times.ts"];

/** A tree of its own: the shard scripts copied, synthetic test files, and the unit weights given (none when null) */
function tree(t: { after(f: () => void): void }, tests: Record<string, string>, weights: object | null): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ci-shards-tree-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "scripts"));
  for (const s of SCRIPTS) fs.copyFileSync(path.join(ROOT, "scripts", s), path.join(root, "scripts", s));
  fs.mkdirSync(path.join(root, "tests", "fixtures"), { recursive: true });
  for (const [name, text] of Object.entries(tests)) fs.writeFileSync(path.join(root, name), text);
  if (weights !== null) fs.writeFileSync(path.join(root, UNIT_WEIGHTS_FILE), JSON.stringify(weights));
  return root;
}
const SLEEP = 'import { test } from "node:test";\nimport { setTimeout as sleep } from "node:timers/promises";\n';
// a `node --test` started from inside a test runs no file while NODE_TEST_CONTEXT says it is one: the shard's own run has none
const { NODE_TEST_CONTEXT: _context, ...outsideTests } = process.env;
const node = (args: string[], cwd: string, env: Record<string, string> = {}): { status: number | null; stdout: string; out: string } => {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd, env: { ...outsideTests, ...env } });
  return { status: r.status, stdout: r.stdout, out: r.stdout + r.stderr };
};

test("the timing reporter gives each file its whole time, load and top-level awaits counted, and never a test's", (t) => {
  const root = tree(t, {
    [T("a.test.ts")]: `${SLEEP}await sleep(300);\ntest("a1", async () => { await sleep(200); });\ntest("a2", async (t) => { await t.test("a2 sub", async () => { await sleep(100); }); });\n` +
      `test("a.test.ts", () => {});\ntest(${JSON.stringify(T("a.test.ts"))}, () => {});\n`,
    [T("b.test.ts")]: `${SLEEP}test("b1", async () => { await sleep(500); });\n`,
  }, null);
  const out = fs.mkdirSync(path.join(root, "out"), { recursive: true })!;
  const files = [T("a.test.ts"), T("b.test.ts")];
  const r = node(shardCommand("unit", 1, files, out).args, root);
  assert.equal(r.status, 0, r.out);
  const times = JSON.parse(fs.readFileSync(path.join(out, "test-times-unit-1.json"), "utf8")) as Record<string, number>;
  assert.deepEqual(Object.keys(times).sort(), files, "a key a file, spelt as testFiles spells it, and no test's name");
  assert.ok(times[T("a.test.ts")]! >= 600, `a.test.ts took its load, its 300 ms await and its tests: ${times[T("a.test.ts")]} ms`);
  assert.ok(times[T("b.test.ts")]! >= 500, `b.test.ts: ${times[T("b.test.ts")]} ms`);
  // the spec reporter is on stdout, and ci.yml's `slowest tests` still reads its lines
  const sed = /sed -nE 's\/(.*)\/\\2 \\1\/p'/.exec(workflow.jobs.unit!.steps!.find((s) => s.name === "slowest tests")!.run!)![1]!;
  const slowest = r.stdout.split("\n").flatMap((l) => { const m = new RegExp(sed).exec(l); return m === null ? [] : [`${m[2]} ${m[1]}`]; });
  assert.ok(slowest.some((l) => /^\d+(\.\d+)? b1$/.test(l)), slowest.join("\n"));
});

test("the file's own event is told by its shape: a top-level test named like its file is never it", () => {
  const file = path.join("/r", T("a.test.ts"));
  const ev = (name: string, line: number, column = 1, nesting = 0) => ({ name, nesting, line, column, file, details: { duration_ms: 1 } });
  assert.equal(fileOf(ev(T("a.test.ts"), 1), "/r"), T("a.test.ts"), "named by the path as given");
  assert.equal(fileOf(ev("a.test.ts", 1), "/r"), T("a.test.ts"), "or by its basename");
  for (const [what, e] of [["at another line", ev(T("a.test.ts"), 6)], ["basename at another line", ev("a.test.ts", 6)], ["another column", ev(T("a.test.ts"), 1, 9)],
    ["a subtest", ev(T("a.test.ts"), 1, 1, 1)], ["another name", ev("a1", 1)]] as const) assert.equal(fileOf(e, "/r"), null, what);
});

test("the timing reporter times a file that cannot load and a file whose test fails, and the shard fails", (t) => {
  const root = tree(t, { [T("c.test.ts")]: 'throw new Error("cannot load");\n', [T("d.test.ts")]: `${SLEEP}test("d1", () => { throw new Error("no"); });\n` }, null);
  const out = fs.mkdirSync(path.join(root, "out"), { recursive: true })!;
  const r = node(shardCommand("unit", 2, [T("c.test.ts"), T("d.test.ts")], out).args, root);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(out, "test-times-unit-2.json"), "utf8")) as object).sort(), [T("c.test.ts"), T("d.test.ts")]);
});

test("a unit shard's record carries its files' times, its wall time and its CPU, and only its own files", (t) => {
  const names = ["x.test.ts", "y.test.ts", "z.test.ts"].map(T);
  const root = tree(t, Object.fromEntries(names.map((f) => [f, `${SLEEP}test("t", async () => { await sleep(50); });\n`])), { default: 1000, files: {} });
  const out = path.join(root, "ran");
  const r = node([path.join(root, "scripts", "ci-shards.ts"), "run", "unit", "1"], root, { CI_SHARD_DIR: out });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /unit shard 1 of 3: 1 file\(s\), about 1\.0 s of test time/);
  const record = JSON.parse(fs.readFileSync(path.join(out, "ran-unit-1.json"), "utf8")) as ShardRecord;
  assert.deepEqual(record.files, [names[0]]);
  assert.deepEqual(Object.keys(record.times ?? {}), [names[0]]);
  assert.ok(record.times![names[0]!]! >= 50 && record.wallMs! >= record.times![names[0]!]!, JSON.stringify(record));
  assert.match(record.cpu ?? "", / × \d+$/);
  assert.deepEqual(fs.readdirSync(out), ["ran-unit-1.json"], "the reporter's file is read into the record, and only the record is left");
});

test("the unit weights are the fixture's: a file it lists weighs its ms, any other its default, and none means no shard runs", (t) => {
  const root = tree(t, {}, { default: 4000, files: { [T("x.test.ts")]: 400000 } });
  assert.equal(weightOf("unit", root)(T("x.test.ts")), 400000);
  assert.equal(weightOf("unit", root)(T("new.test.ts")), 4000);
  const bare = tree(t, { [T("x.test.ts")]: "" }, null);
  assert.throws(() => shardFiles("unit", 1, bare), (e: Error) => e.message.includes(UNIT_WEIGHTS_FILE) && e.message.includes("node scripts/ci-shards.ts weights <run-id>"));
  const r = node([path.join(bare, "scripts", "ci-shards.ts"), "run", "unit", "1"], bare, { CI_SHARD_DIR: path.join(bare, "ran") });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /unit-weights\.json is missing/);
  assert.equal(fs.existsSync(path.join(bare, "ran")), false, "no shard ran, and none recorded");
});

test("a stale entry for a file gone moves nothing, and the heaviest files each lead a shard", (t) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, UNIT_WEIGHTS_FILE), "utf8")) as { default: number; files: Record<string, number> };
  const stale = tree(t, {}, { ...fixture, files: { ...fixture.files, [T("gone.test.ts")]: 900000 } });
  const files = testFiles("unit", ROOT);
  const split = partition(files, SHARDS.unit, weightOf("unit", stale), APART);
  assert.deepEqual(split, Array.from({ length: SHARDS.unit }, (_, i) => shardFiles("unit", i + 1, ROOT)));
  assert.deepEqual(split.flat().sort(), files);
  const w: Record<string, number> = { a: 500, b: 300, c: 300, d: 100, e: 100 };
  const shards = partition(Object.keys(w), 3, (f) => w[f]!);
  assert.equal(new Set(["a", "b", "c"].map((f) => shards.findIndex((s) => s.includes(f)))).size, 3);
  const totals = shards.map((s) => s.reduce((n, f) => n + w[f]!, 0));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 500, totals.join());
});

test("the rest shards keep their hand weights: the integration files' partition is the base's", () => {
  const rest = weightOf("rest", ROOT);
  const hand: Array<[string, number]> = [["duck-stream", 90], ["duck-poll", 77], ["cli-upgrade", 73], ["cli-sources", 30], ["duck-serve", 23], ["duck-json-paths", 11], ["not-listed", 3]];
  assert.deepEqual(hand.map(([f]) => rest(T(`integration/${f}.itest.ts`)) / 1000), hand.map(([, s]) => s));
});

/** the records of three unit shards over the tree's files, with what each is given */
function unitRecords(dir: string, each: (shard: number) => Partial<ShardRecord>): void {
  for (let shard = 1; shard <= SHARDS.unit; shard++) fs.writeFileSync(path.join(dir, `ran-unit-${shard}.json`), JSON.stringify({ kind: "unit", shard, files: shardFiles("unit", shard, ROOT), exit: 0, ...each(shard) }));
}
const tmp = (t: { after(f: () => void): void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-shards-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
};

test("verify unit says each shard's wall time and CPU and the gap, warns past a minute, and never moves the exit code", (t) => {
  const near = tmp(t);
  unitRecords(near, (n) => ({ wallMs: [540000, 560000, 580000][n - 1]!, cpu: `cpu ${n} × 4` }));
  const ok = program("ci-shards.ts", ["verify", "unit", near], { GITHUB_RUN_ID: "123" });
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /unit shard 1: balance: 540\.0 s as run, \d+ file\(s\); runner: cpu 1 × 4\n/);
  assert.match(ok.out, /unit shards: balance: 40\.0 s apart as run, shard 3 the slowest and 1 the fastest \(the target: 60\.0 s or less\)/);
  assert.doesNotMatch(ok.out, /::warning/);
  const far = tmp(t);
  unitRecords(far, (n) => ({ wallMs: [220000, 1090000, 310000][n - 1]! }));
  const apart = program("ci-shards.ts", ["verify", "unit", far], { GITHUB_RUN_ID: "123" });
  assert.equal(apart.status, 0, apart.out);
  assert.match(apart.out, /^::warning title=unit shards::the unit shards ran 870\.0 s apart, past the target of 60\.0 s: rebalance with `node scripts\/ci-shards\.ts weights 123`/m);
  const { GITHUB_RUN_ID: _, ...noRun } = process.env;
  const unnamed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "ci-shards.ts"), "verify", "unit", far], { encoding: "utf8", cwd: ROOT, env: noRun });
  assert.match(unnamed.stdout, /weights <run-id>`/);
  // one file's floor (PR 346's second run): the slowest shard's longest file alone is past the target from the fastest,
  // so the warning names that file, never a rebalance that cannot close it
  const floor = tmp(t);
  unitRecords(floor, (n) => ({ wallMs: [351600, 376100, 860000][n - 1]!, times: Object.fromEntries(shardFiles("unit", n, ROOT).map((f, i) => [f, n === 3 && i === 0 ? 852800 : 4000])) }));
  const held = program("ci-shards.ts", ["verify", "unit", floor], { GITHUB_RUN_ID: "123" });
  assert.equal(held.status, 0, held.out);
  const first3 = shardFiles("unit", 3, ROOT)[0]!;
  assert.ok(held.out.includes(`::warning title=unit shards::the unit shards ran 508.4 s apart, past the target of 60.0 s, and no split closes it: ${first3} alone took 852.8 s of shard 3's 860.0 s, where the fastest shard took 351.6 s`), held.out);
  assert.doesNotMatch(held.out, /weights 123/);
  // within the target of the fastest, the longest file is no floor: rebalance
  unitRecords(floor, (n) => ({ wallMs: [351600, 376100, 860000][n - 1]!, times: Object.fromEntries(shardFiles("unit", n, ROOT).map((f, i) => [f, n === 3 && i === 0 ? 400000 : 4000])) }));
  assert.match(program("ci-shards.ts", ["verify", "unit", floor], { GITHUB_RUN_ID: "123" }).out, /::warning title=unit shards::.*rebalance with `node scripts\/ci-shards\.ts weights 123`/);
  // a file left out: 1 by coverage, the warning beside it
  const record1 = path.join(far, "ran-unit-1.json");
  const r1 = JSON.parse(fs.readFileSync(record1, "utf8")) as ShardRecord;
  fs.writeFileSync(record1, JSON.stringify({ ...r1, files: r1.files.slice(1) }));
  const both = program("ci-shards.ts", ["verify", "unit", far], { GITHUB_RUN_ID: "123" });
  assert.equal(both.status, 1, both.out);
  assert.ok(both.out.includes(`${r1.files[0]} ran in no unit shard`), both.out);
  assert.match(both.out, /::warning title=unit shards::/);
});

test("verify unit over records from before the timing: coverage decides, the balance is not measured", (t) => {
  const old = tmp(t);
  unitRecords(old, () => ({}));
  const r = program("ci-shards.ts", ["verify", "unit", old]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /unit shards: balance: not measured: the record of unit shard\(s\) 1, 2, 3 has no wall time/);
  const one = tmp(t);
  unitRecords(one, (n) => (n === 2 ? {} : { wallMs: 500000 }));
  const r2 = program("ci-shards.ts", ["verify", "unit", one]);
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /not measured: the record of unit shard\(s\) 2 has no wall time/);
  assert.doesNotMatch(r2.out, /apart|::warning/);
});

/** three synthetic records as `gh run download` leaves them (a folder each), timed unless `each` says otherwise */
// (a field `each` sets to undefined is left out of the record, as JSON leaves it)
function timedRecords(dir: string, each: (shard: number) => Record<string, unknown> = () => ({})): Record<string, number> {
  const ms: Record<string, number> = { [T("a.test.ts")]: 300000, [T("b.test.ts")]: 120000, [T("c.test.ts")]: 2000, [T("d.test.ts")]: 5000, [T("e.test.ts")]: 9000, [T("f.test.ts")]: 40000 };
  const shards = [[T("a.test.ts")], [T("b.test.ts"), T("c.test.ts")], [T("d.test.ts"), T("e.test.ts"), T("f.test.ts")]];
  shards.forEach((files, i) => {
    const folder = path.join(dir, `ran-unit-${i + 1}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `ran-unit-${i + 1}.json`), JSON.stringify({ kind: "unit", shard: i + 1, files, exit: 0, times: Object.fromEntries(files.map((f) => [f, ms[f]! + 0.4])), wallMs: 1000, cpu: "c × 4", ...each(i + 1) }));
  });
  return ms;
}

test("weights <folder> writes the fixture from the shards' records: every file by path, the median the default", (t) => {
  const root = tree(t, {}, { default: 1, files: {} });
  const dir = tmp(t);
  const ms = timedRecords(dir);
  const r = node([path.join(root, "scripts", "ci-shards.ts"), "weights", dir], root);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /is a folder, not a run: nothing checks that its shards ran on this checkout's commit/);
  const text = fs.readFileSync(path.join(root, UNIT_WEIGHTS_FILE), "utf8");
  const sorted = Object.keys(ms).sort();
  // the median of 2, 5, 9, 40, 120 and 300 s: between 9 and 40
  assert.equal(text, `{\n  "from": ${JSON.stringify(dir)},\n  "default": 24500,\n  "files": {\n${sorted.map((f) => `    ${JSON.stringify(f)}: ${ms[f]}`).join(",\n")}\n  }\n}\n`);
});

test("weights refuses records that cannot give the fixture, and writes nothing", (t) => {
  const root = tree(t, {}, { default: 1, files: {} });
  const before = fs.readFileSync(path.join(root, UNIT_WEIGHTS_FILE), "utf8");
  const cases: Array<[string, (dir: string) => void, RegExp]> = [
    ["shard 3 missing", (dir) => { timedRecords(dir); fs.rmSync(path.join(dir, "ran-unit-3"), { recursive: true }); }, /the records are of shard\(s\) 1,2, where 1,2,3/],
    ["shard 2 twice", (dir) => { timedRecords(dir); fs.mkdirSync(path.join(dir, "again")); fs.copyFileSync(path.join(dir, "ran-unit-2", "ran-unit-2.json"), path.join(dir, "again", "ran-unit-2.json")); }, /shard\(s\) 1,2,2,3/],
    ["shard 2 untimed", (dir) => { timedRecords(dir, (n) => (n === 2 ? { times: undefined } : {})); }, /the record of unit shard 2 of .* has no times/],
    ["shard 3 failed", (dir) => { timedRecords(dir, (n) => (n === 3 ? { exit: 1 } : {})); }, /unit shard 3 of .* exited 1/],
    ["a file untimed", (dir) => { timedRecords(dir, (n) => (n === 1 ? { times: {} } : {})); }, /a\.test\.ts ran in unit shard 1 of .* but has no time/],
  ];
  for (const [what, make, says] of cases) {
    const dir = tmp(t);
    make(dir);
    const r = node([path.join(root, "scripts", "ci-shards.ts"), "weights", dir], root);
    assert.equal(r.status, 1, `${what}: ${r.out}`);
    assert.match(r.out, says, what);
    assert.match(r.out, /unit shards: nothing written/, what);
    assert.equal(fs.readFileSync(path.join(root, UNIT_WEIGHTS_FILE), "utf8"), before, what);
  }
  for (const args of [["weights"], ["weights", "1", "2"], ["weights", "1", "2", "3"]]) assert.equal(node([path.join(root, "scripts", "ci-shards.ts"), ...args], root).status, 2, args.join(" "));
});

test("weights <run-id> takes only a finished run of the commit checked out, and downloads nothing else", (t) => {
  const bin = tmp(t);
  const log = path.join(bin, "gh.log");
  fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\necho "$@" >> "$FAKE_GH_LOG"\nif [ "$1 $2" = "run view" ]; then printf "%s" "$FAKE_GH_VIEW"; exit 0; fi\nexit 3\n', { mode: 0o755 });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const fixture = fs.readFileSync(path.join(ROOT, UNIT_WEIGHTS_FILE), "utf8");
  for (const [view, says] of [[{ headSha: "b".repeat(40), status: "completed" }, /the run is of commit b{40}, where this checkout is at/], [{ headSha: head, status: "in_progress" }, /has not finished \(in_progress\)/]] as const) {
    const r = program("ci-shards.ts", ["weights", "4242"], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_GH_LOG: log, FAKE_GH_VIEW: JSON.stringify({ ...view, conclusion: null }) });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, says);
    assert.match(r.out, /unit shards: nothing written/);
  }
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /download/);
  assert.equal(fs.readFileSync(path.join(ROOT, UNIT_WEIGHTS_FILE), "utf8"), fixture);
});

test("ci-shards.ts reaches neither scripts/oracle-legs.ts nor the engine: the unit and final jobs load only the shard scripts", () => {
  const reached = new Set<string>();
  const walk = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const m of fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["'](\.[^"']+)["']/g)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]!)));
  };
  walk("scripts/ci-shards.ts");
  assert.deepEqual([...reached].sort(), ["scripts/ci-layout.ts", "scripts/ci-shards.ts", "scripts/gate.ts"]);
});

// ── the docs path (issue 339) ────────────────────────────────────────────────────────────────────────────────────────
// A pull request that changes nothing but docs runs the docs job in place of build, unit, oracle and rest, and the four
// required checks still report. The danger is two-sided: a required check that never reports blocks every docs PR for
// ever, and a gate that passes over shards skipped for any other reason lets a broken PR merge. Every path below that
// is not in the tree is built, never written whole (the path guard).
const P = (...parts: string[]): string => parts.join("/");
const FULL = { result: "success", outputs: { docs: "false" } }, DOCS = { result: "success", outputs: { docs: "true" } };

test("docs paths: a root .md file, or one under docs/, deploy/ or release-notes/, is docs", () => {
  assert.equal(shards.docsOnly(["README.md"]), true);
  assert.equal(shards.docsOnly(["docs/DESIGN.md", "docs/SQL-SUPPORT.md"]), true);
  assert.equal(shards.docsOnly([P("release-notes", "next.md")]), true);
  assert.equal(shards.docsOnly([P("release-notes", "v0.9.0.md")]), true);
  assert.equal(shards.docsOnly([P("deploy", "fly", "README.md"), "CONTRIBUTING.md", "SECURITY.md", P("docs", "sub", "notes.md"), P("docs", "a b.md")]), true);
});

test("docs paths: CLAUDE.md, .claude/, .github/, src/, cli/, tests/, scripts/, any other file or folder, and an empty list are not docs", () => {
  for (const p of ["CLAUDE.md", P("docs", "CLAUDE.md"), P(".claude", "rules", "cli.md"), P(".claude", "skills", "pr-persistent", "SKILL.md"), P(".claude", "workflows", "pr-loop.js"),
    "src/web/vendor/README.md", P("cli", "README.md"), "tests/integration/README.md", P(".github", "pull_request_template.md"), P("scripts", "x.md"),
    P("docs", "diagram.png"), P("docs", "DESIGN.mdx"), "README.md.orig", P("Docs", "README.md"), "README.MD", P("examples", "README.md")]) {
    assert.equal(shards.docsPath(p), false, p);
    assert.equal(shards.docsOnly([p]), false, p);
  }
  assert.equal(shards.docsOnly(["docs/DESIGN.md", "src/duck/plan.ts"]), false, "one code path makes the whole set code");
  assert.equal(shards.docsOnly([P("src", "x.ts"), P("docs", "x.md")]), false, "a rename src -> docs, listed with --no-renames as both paths");
  assert.equal(shards.docsOnly([]), false, "an empty diff is couldn't tell, never docs");
});

// ── `changes` against a real git merge, as CI's checkout of refs/pull/<n>/merge has it ──
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
/** A repository of its own: a base commit holding the shard scripts and `base`, a branch `pr` (never `head`, which a
 *  case-insensitive disk takes for HEAD) that changes `head`
 *  (a path to null removes it), and HEAD the two-parent merge of the head into the base, or the head itself (1). */
function mergeRepo(t: { after(f: () => void): void }, head: Record<string, string | null>, parents: 1 | 2, base: Record<string, string> = {}): string {
  const root = tree(t, {}, null);
  const git = (...args: string[]): void => { const r = spawnSync("git", [...GIT, ...args], { cwd: root, encoding: "utf8" }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); };
  const put = (files: Record<string, string | null>): void => {
    for (const [f, text] of Object.entries(files)) {
      if (text === null) { fs.rmSync(path.join(root, f)); continue; }
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
  };
  put(base);
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "base"); git("checkout", "-qb", "pr");
  put(head);
  git("add", "-A"); git("commit", "-qm", "head");
  if (parents === 2) { git("checkout", "-q", "main"); git("merge", "-q", "--no-ff", "-m", "merge", "pr"); }
  return root;
}
/** `node scripts/ci-shards.ts changes` in `root`, with exactly the event and output given (CI's own are dropped) */
function changes(root: string, event: string | undefined, withOutput = true): { status: number | null; out: string; output: string | null } {
  const { GITHUB_OUTPUT: _o, GITHUB_EVENT_NAME: _e, ...env } = outsideTests;
  const file = path.join(root, "github-output");
  const r = spawnSync(process.execPath, ["scripts/ci-shards.ts", "changes"], { encoding: "utf8", cwd: root,
    env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(root), ...(event === undefined ? {} : { GITHUB_EVENT_NAME: event }), ...(withOutput ? { GITHUB_OUTPUT: file } : {}) } });
  return { status: r.status, out: r.stdout + r.stderr, output: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
}

test("docs changes: a pull request's merge adding only docs says docs=true and names what it classified", (t) => {
  const got = changes(mergeRepo(t, { [P("docs", "x.md")]: "x", [P("docs", "a b.md")]: "y" }, 2), "pull_request");
  assert.equal(got.status, 0, got.out);
  assert.equal(got.output, "docs=true\n");
  assert.match(got.out, /docs {2}docs\/x\.md\n/);
  assert.match(got.out, /docs {2}docs\/a b\.md\n/, "a space read through -z");
  assert.match(got.out, /docs=true/);
});

test("docs changes: one code path, a rename out of src/, a one-parent HEAD, a push, a non-repository and no GITHUB_OUTPUT are never docs", (t) => {
  const mixed = changes(mergeRepo(t, { [P("docs", "x.md")]: "x", [P("src", "y.ts")]: "y" }, 2), "pull_request");
  assert.equal(mixed.status, 0, mixed.out);
  assert.equal(mixed.output, "docs=false\n");
  assert.match(mixed.out, /code {2}src\/y\.ts\n/);
  const renamed = changes(mergeRepo(t, { [P("src", "x.ts")]: null, [P("docs", "x.md")]: "same text" }, 2, { [P("src", "x.ts")]: "same text" }), "pull_request");
  assert.equal(renamed.output, "docs=false\n", renamed.out);
  assert.match(renamed.out, /code {2}src\/x\.ts\n/, "--no-renames lists the rename's old path");
  const single = changes(mergeRepo(t, { [P("docs", "x.md")]: "x" }, 1), "pull_request");
  assert.equal(single.status, 0, single.out);
  assert.equal(single.output, "docs=false\n");
  assert.match(single.out, /cannot tell that only docs changed: HEAD has 1 parent\(s\)/);
  const push = changes(mergeRepo(t, { [P("docs", "x.md")]: "x" }, 2), "push");
  assert.equal(push.output, "docs=false\n", push.out);
  assert.match(push.out, /the event is push, not pull_request/);
  assert.equal(changes(mergeRepo(t, { [P("docs", "x.md")]: "x" }, 2), undefined).output, "docs=false\n", "no event is no pull request");
  const notRepo = changes(tree(t, {}, null), "pull_request");
  assert.equal(notRepo.status, 0, notRepo.out);
  assert.equal(notRepo.output, "docs=false\n");
  assert.match(notRepo.out, /cannot tell that only docs changed: `git rev-list --parents -n 1 HEAD` exited/);
  const noOutput = changes(mergeRepo(t, { [P("docs", "x.md")]: "x" }, 2), "pull_request", false);
  assert.equal(noOutput.status, 2, noOutput.out);
  assert.match(noOutput.out, /GITHUB_OUTPUT/);
  assert.equal(noOutput.output, null, "nothing guessed");
});

// ── the gates, by the mode in their own NEEDS ──
test("docs needs: a docs-only run passes each gate over the jobs it skips, and only those, and only when docs succeeded", () => {
  const n = (o: object): string[] => needsProblems(JSON.stringify(o));
  assert.deepEqual(n({ changes: DOCS, build: { result: "skipped" }, unit: { result: "skipped" }, docs: { result: "success" } }), [], "checks on a docs-only run");
  assert.deepEqual(n({ changes: DOCS, oracle: { result: "skipped" } }), [], "integration (oracle) on a docs-only run");
  assert.deepEqual(n({ changes: DOCS, rest: { result: "skipped" } }), [], "integration (rest) on a docs-only run");
  assert.deepEqual(n({ changes: DOCS, build: { result: "skipped" }, unit: { result: "skipped" }, docs: { result: "failure" } }), ["docs: failure"]);
  assert.deepEqual(n({ changes: DOCS, build: { result: "skipped" }, unit: { result: "skipped" }, docs: { result: "skipped" } }), ["docs: skipped"], "the docs job never runs by skipping");
  for (const result of ["failure", "cancelled"]) assert.deepEqual(n({ changes: DOCS, build: { result: "skipped" }, unit: { result }, docs: { result: "success" } }), [`unit: ${result}`], `a job docs-only skips, ${result}`);
});

test("docs needs: a full run passes only when every job but docs succeeded", () => {
  const n = (o: object): string[] => needsProblems(JSON.stringify(o));
  assert.deepEqual(n({ changes: FULL, build: { result: "success" }, unit: { result: "success" }, docs: { result: "skipped" } }), [], "checks on a full run");
  assert.deepEqual(n({ changes: FULL, build: { result: "success" }, unit: { result: "skipped" }, docs: { result: "skipped" } }), ["unit: skipped"]);
  assert.deepEqual(n({ changes: FULL, oracle: { result: "skipped" } }), ["oracle: skipped"]);
  assert.deepEqual(n({ changes: FULL, rest: { result: "cancelled" } }), ["rest: cancelled"]);
});

test("docs needs: a mode that cannot be told fails the check: changes failed, skipped, cancelled, absent, or an output not exactly true or false", () => {
  const n = (o: object): string[] => needsProblems(JSON.stringify(o));
  for (const result of ["failure", "skipped", "cancelled"]) {
    const p = n({ changes: { result, outputs: {} }, build: { result: "skipped" }, unit: { result: "skipped" }, docs: { result: "skipped" } });
    assert.ok(p.some((x) => x.startsWith(`changes: ${result}`)), `${result}: ${p.join("; ")}`);
  }
  for (const outputs of [{}, { docs: "maybe" }, { docs: "TRUE" }, { docs: "" }]) {
    const p = n({ changes: { result: "success", outputs }, oracle: { result: "skipped" } });
    assert.ok(p.some((x) => /^changes: its output docs is .*cannot be told/.test(x)), `${JSON.stringify(outputs)}: ${p.join("; ")}`);
  }
  assert.ok(n({ build: { result: "skipped" }, unit: { result: "skipped" } }).includes("changes: not in NEEDS, so whether this run is docs-only cannot be told"), "a gate with no changes behind it never passes by docs mode");
  assert.deepEqual(n({ build: { result: "success" }, unit: { result: "success" } }), ["changes: not in NEEDS, so whether this run is docs-only cannot be told"]);
  assert.deepEqual(needsProblems("{}"), ["the check has no job behind it: NEEDS is empty"]);
  assert.deepEqual(needsProblems(undefined), ["the check has no job behind it: NEEDS is empty"]);
});

test("docs needs run as CI runs it: exit 0 on a docs-only run's skipped oracle, 1 on a full run's", () => {
  const ok = program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ changes: DOCS, oracle: { result: "skipped" } }) });
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /skipped, as a docs-only run skips it: oracle/);
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ changes: FULL, oracle: { result: "skipped" } }) }).status, 1);
  assert.equal(program("ci-shards.ts", ["changes", "extra"]).status, 2);
  assert.equal(program("ci-shards.ts", ["docs", "extra"]).status, 2);
});

// ── ci.yml, simulated: every job's `if` and every step a gate or the image runs, as GitHub decides them ──
type Result = "success" | "failure" | "skipped" | "cancelled";
interface SimJob { needs?: string[]; if?: string; outputs?: Record<string, string>; steps?: Array<{ run?: string; if?: string; name?: string; uses?: string; id?: string; with?: Record<string, unknown> }> }
const jobs = workflow.jobs as unknown as Record<string, SimJob>;
const DOCS_IS = /^needs\.changes\.outputs\.docs (==|!=) '(true|false)'$/;
/** One `if:` as GitHub evaluates it, in a run nobody cancelled: the terms the workflow uses joined by `&&`, and an
 *  implied success() when none is a status function. Any other expression throws: it cannot pass unevaluated. */
function evaluate(expr: string | undefined, job: SimJob, docs: string, okSoFar: boolean): boolean {
  if (expr === undefined) return okSoFar;
  const inner = /^\$\{\{ (.*) \}\}$/.exec(expr)?.[1];
  if (inner === undefined) throw new Error(`an if the simulation does not know: ${expr}`);
  let status = false;
  const terms = inner.split(" && ").map((term) => {
    if (term === "always()" || term === "!cancelled()") { status = true; return true; }
    const m = DOCS_IS.exec(term);
    if (m === null) throw new Error(`an if the simulation does not know: ${expr}`);
    if (!(job.needs ?? []).includes("changes")) throw new Error(`${expr} reads needs.changes in a job that does not need it, where GitHub gives ''`);
    return m[1] === "==" ? docs === m[2] : docs !== m[2];
  });
  return terms.every(Boolean) && (status || okSoFar);
}
/** A run of ci.yml: `changes` answers `changesResult` and `docs`, a job in `override` answers that, every other shard
 *  succeeds. A gate's steps run as GitHub runs them: its `needs` step is needsProblems over the NEEDS it would get, and a
 *  step that reads the shards' records fails unless every shard behind it succeeded. */
function simulate(changesResult: Result, docs: string, override: Record<string, Result> = {}): { results: Record<string, Result>; ran: Record<string, string[]> } {
  const results: Record<string, Result> = {}, ran: Record<string, string[]> = {};
  const pending = Object.keys(jobs);
  while (pending.length > 0) {
    const id = pending.find((j) => (jobs[j]!.needs ?? []).every((n) => n in results));
    assert.ok(id !== undefined, `a needs cycle or an unknown need among ${pending.join(", ")}`);
    pending.splice(pending.indexOf(id), 1);
    const job = jobs[id]!, needs = job.needs ?? [];
    if (id === "changes") { results[id] = changesResult; continue; }
    if (!evaluate(job.if, job, docs, needs.every((n) => results[n] === "success"))) { results[id] = "skipped"; continue; }
    if (override[id] !== undefined) { results[id] = override[id]; continue; }
    const NEEDS = JSON.stringify(Object.fromEntries(needs.map((n) => [n, { result: results[n], outputs: n === "changes" && changesResult === "success" ? { docs } : {} }])));
    const shardsOk = needs.filter((n) => n !== "changes" && n !== "docs").every((n) => results[n] === "success");
    let ok = true;
    ran[id] = [];
    for (const step of job.steps ?? []) {
      if (!evaluate(step.if, job, docs, ok)) continue;
      const label = step.name ?? step.run ?? step.uses ?? "?";
      ran[id].push(label);
      if (step.run === "node scripts/ci-shards.ts needs") ok &&= needsProblems(NEEDS).length === 0;
      else if (/^node scripts\/(ci-shards\.ts verify|oracle-legs\.ts) /.test(step.run ?? "")) ok &&= shardsOk;
    }
    results[id] = ok ? "success" : "failure";
  }
  return { results, ran };
}
const GATES = ["checks", "image", "integration-oracle", "integration-rest"];

test("docs ci.yml: every if is one the simulation knows, so none passes unevaluated", () => {
  let n = 0;
  for (const job of Object.values(jobs)) for (const expr of [job.if, ...(job.steps ?? []).map((s) => s.if)]) {
    if (expr === undefined) continue;
    n++;
    for (const docs of ["true", "false", ""]) evaluate(expr, job, docs, true);
  }
  assert.ok(n >= 20, `${n} ifs read: has the file moved?`);
  assert.throws(() => evaluate("${{ success() || needs.changes.outputs.docs }}", { needs: ["changes"] }, "true", true), /does not know/);
  assert.throws(() => evaluate("${{ needs.changes.outputs.docs == 'true' }}", {}, "true", true), /does not need it/);
});

test("docs ci.yml simulated, a docs-only run: the four required checks run and pass, build, unit, oracle and rest are skipped, docs runs, the image builds nothing", () => {
  const { results, ran } = simulate("success", "true");
  for (const g of GATES) assert.equal(results[g], "success", g);
  for (const j of shards.DOCS_SKIPS) assert.equal(results[j], "skipped", j);
  assert.equal(results.docs, "success");
  assert.ok(ran.image!.includes("a docs-only run builds no image") && !ran.image!.includes("build mason-data"), ran.image!.join(", "));
  for (const g of ["checks", "integration-oracle", "integration-rest"]) assert.deepEqual(ran[g]!.filter((s) => /verify|ran|whole|download/.test(s)), [], `${g} reads no shard's records on a docs-only run`);
  // and a docs job that failed fails checks alone
  const failed = simulate("success", "true", { docs: "failure" }).results;
  assert.equal(failed.checks, "failure");
  assert.equal(failed["integration-oracle"], "success");
});

test("docs ci.yml simulated, a full run: every job runs but docs, the image builds, and a shard skipped or failed fails its gate", () => {
  const { results, ran } = simulate("success", "false");
  for (const g of GATES) assert.equal(results[g], "success", g);
  for (const j of shards.DOCS_SKIPS) assert.equal(results[j], "success", j);
  assert.equal(results.docs, "skipped");
  assert.ok(ran.image!.includes("build mason-data") && !ran.image!.includes("a docs-only run builds no image"), ran.image!.join(", "));
  for (const [shard, gate] of [["build", "checks"], ["unit", "checks"], ["oracle", "integration-oracle"], ["rest", "integration-rest"]] as const) {
    for (const r of ["failure", "skipped", "cancelled"] as const) assert.equal(simulate("success", "false", { [shard]: r }).results[gate], "failure", `${shard} ${r}`);
  }
});

test("docs ci.yml simulated, changes failed or with no verdict: every gate fails and the image still builds", () => {
  for (const [result, docs] of [["failure", ""], ["cancelled", ""], ["success", ""], ["success", "maybe"]] as const) {
    const { results, ran } = simulate(result, docs);
    for (const g of ["checks", "integration-oracle", "integration-rest"]) assert.equal(results[g], "failure", `${g}, changes ${result} docs ${JSON.stringify(docs)}`);
    assert.equal(results.image, "success");
    assert.ok(ran.image!.includes("build mason-data"), "a failed changes still builds the image");
    for (const j of [...shards.DOCS_SKIPS, "docs"]) assert.equal(results[j], "skipped", `${j}: only an exact 'false' or 'true' runs it`);
  }
});

test("docs ci.yml: no paths filter, changes is builtins-only on Node 26 at depth 2, the docs job runs DOCS_TESTS, and the skipped jobs are DOCS_SKIPS", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(text.split("\n").filter((l) => /^\s*paths(-ignore)?\s*:/.test(l)), [], "a paths filter can leave a required check unreported for ever");
  const ch = jobs.changes!;
  assert.equal(ch.needs, undefined);
  assert.ok(!ch.steps!.some((s) => s.run === "npm ci"), "changes runs no npm ci: it reaches only Node's builtins");
  assert.ok(Number(ch.steps!.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]) >= 2, "the merge's parents are fetched");
  assert.equal(ch.steps!.find((s) => s.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"], "26");
  const classify = ch.steps!.find((s) => s.run === "node scripts/ci-shards.ts changes");
  assert.ok(classify?.id !== undefined, "changes runs the classifier, with an id");
  assert.deepEqual(ch.outputs, { docs: `\${{ steps.${classify.id}.outputs.docs }}` });
  const docs = jobs.docs!;
  assert.deepEqual(docs.needs, ["changes"]);
  assert.equal(docs.if, "${{ needs.changes.outputs.docs == 'true' }}");
  assert.ok(docs.steps!.some((s) => s.run === "npm ci"));
  assert.equal(docs.steps!.find((s) => s.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"], "26");
  assert.deepEqual(docs.steps!.filter((s) => s.run !== undefined && s.run !== "npm ci").map((s) => s.run), ["node scripts/ci-shards.ts docs"]);
  assert.deepEqual(Object.keys(jobs).filter((id) => jobs[id]!.if === "${{ needs.changes.outputs.docs == 'false' }}").sort(), [...shards.DOCS_SKIPS].sort());
  for (const id of shards.DOCS_SKIPS) assert.deepEqual(jobs[id]!.needs, ["changes"], id);
  for (const id of GATES) assert.ok(jobs[id]!.needs?.includes("changes"), `${id} needs changes`);
  assert.equal(jobs.image!.if, "${{ !cancelled() }}", "a plain skip of the image for a failed need would report success on a required check");
});

test("docs commands: the per-test bound before the files, the unpatterned files in one run, each pattern in a run of its own", () => {
  const got = shards.docsCommands([{ file: "a.test.ts" }, { file: "b.test.ts", pattern: "x y" }, { file: "c.test.ts" }]);
  assert.deepEqual(got, [["--test", ...gate.TEST_BOUND_ARGS, "a.test.ts", "c.test.ts"], ["--test", ...gate.TEST_BOUND_ARGS, "--test-name-pattern=x y", "b.test.ts"]]);
  assert.ok(gate.TEST_BOUND_ARGS.some((a) => a.startsWith("--test-timeout=")));
  const all = shards.docsCommands();
  assert.deepEqual(all.flatMap((a) => a.filter((x) => x.endsWith(".test.ts"))).sort(), shards.DOCS_TESTS.map((d) => d.file).sort(), "every DOCS_TESTS file runs, once");
});

// ── DOCS_TESTS is every unit test that reads a doc ──
/** The string literals of a TypeScript source, its comments and regular expressions skipped */
function literalsOf(src: string): string[] {
  const out: string[] = [];
  let i = 0, last = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2); if (i < 0) break; i += 2; continue; }
    if (c === "/" && (last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|of|in)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < src.length && (src[j] !== "/" || cls) && src[j] !== "\n") { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      i = j + 1; last = "x"; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { s += src[j + 1] ?? ""; j += 2; continue; } s += src[j]; j++; }
      out.push(s); i = j + 1; last = "x"; continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}
const docsLiteral = (s: string): boolean => shards.docsPath(s) || shards.DOCS_FOLDERS.some((f) => s === f || (s.startsWith(`${f}/`) && !/\s/.test(s)));
const READS = /\b(readFileSync|readdirSync|existsSync|globSync|statSync|readFile)\b|ls-files/;
/** Unit test files that read a doc and run in no docs job, by their text: a docs literal beside a file read */
function docsReadersLeftOut(files: Record<string, string>, listed: readonly string[], exempt: ReadonlyMap<string, string>): string[] {
  return Object.entries(files).filter(([f, src]) => !listed.includes(f) && !exempt.has(f) && READS.test(src.replace(/\/\/.*$/gm, "")) && literalsOf(src).some(docsLiteral)).map(([f]) => f);
}
/** Unit test files that name a doc and need not run in the docs job, each with why */
const DOCS_READ_EXEMPT: ReadonlyMap<string, string> = new Map([
  ["tests/ci-shards.test.ts", "its docs paths are the classifier's inputs and git fixtures; it reads no doc"],
  ["tests/cli-package.test.ts", "README.md is the npm package's file list (cli/README.md, code)"],
  ["tests/duck-json-columns.test.ts", "\"docs\" is a synthetic table's name; it reads no doc"],
  ["tests/duck-extensions.test.ts", "README.md is a platform package's file list (written by cli/extensions.ts)"],
  ["tests/web-page.test.ts", "reads src/web/vendor/README.md, which the page serves: under src/, so code"],
  ["tests/workflows.test.ts", "its docs paths are a PR's changed paths fed to the harness's evidence rules; it reads CLAUDE.md, which is code"],
]);

test("docs tests: every DOCS_TESTS file exists, every pattern names a test in it, and every unit test that reads a doc is listed or exempted", () => {
  for (const { file, pattern } of shards.DOCS_TESTS) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    if (pattern === undefined) continue;
    const titles = [...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
    assert.ok(titles.some((title) => new RegExp(pattern).test(title)), `${file}: --test-name-pattern=${pattern} names no test, so it would pass with 0 tests`);
  }
  const files = Object.fromEntries(testFiles("unit", ROOT).map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]));
  const listed = shards.DOCS_TESTS.map((d) => d.file);
  assert.deepEqual(docsReadersLeftOut(files, listed, DOCS_READ_EXEMPT), [], "a unit test that reads a doc: add it to DOCS_TESTS (scripts/ci-shards.ts), or to DOCS_READ_EXEMPT with why");
  for (const f of listed) assert.ok(docsReadersLeftOut({ [f]: files[f]! }, [], new Map()).length === 1, `${f} is in DOCS_TESTS but reads no doc by its text`);
  for (const f of DOCS_READ_EXEMPT.keys()) assert.deepEqual(docsReadersLeftOut({ [f]: files[f] ?? "" }, [], new Map()), [f], `${f} is exempted but names no doc: drop it from DOCS_READ_EXEMPT`);
});

test("docs tests: the coverage guard catches the real thing", () => {
  const z = P("tests", "z.test.ts");
  const reader = `import * as fs from "node:fs";\ntest("z", () => { fs.readFileSync(${JSON.stringify(P("docs", "NEW.md"))}, "utf8"); });\n`;
  assert.deepEqual(docsReadersLeftOut({ [z]: reader }, [], new Map()), [z]);
  assert.deepEqual(docsReadersLeftOut({ [z]: 'const doc = fs.readFileSync(path.join(ROOT, "docs", "X.md"));' }, [], new Map()), [z], "a folder and a file, joined");
  assert.deepEqual(docsReadersLeftOut({ [z]: 'fs.readFileSync(path.join(ROOT, "README.md"));' }, [], new Map()), [z]);
  assert.deepEqual(docsReadersLeftOut({ [z]: reader }, [z], new Map()), [], "listed");
  assert.deepEqual(docsReadersLeftOut({ [z]: `fs.readFileSync(path.join(ROOT, "CLAUDE.md")); // see "${P("docs", "X.md")}"` }, [], new Map()), [], "CLAUDE.md is code, and a comment is no read");
  assert.deepEqual(docsReadersLeftOut({ [z]: 'fs.readFileSync(path.join(ROOT, "src", "a.ts")); const re = /"docs"/;' }, [], new Map()), [], "a regular expression is no literal");
});
