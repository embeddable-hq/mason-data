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
  // and runs four files side by side, said before its files (issue 338: Node's default is 3 on CI's 4 vCPUs), and reports
  // twice: spec on stdout as before, each file's time into the shard's folder
  assert.deepEqual(shardCommand("unit", 1, ["a"], "o"), { args: ["--test", ...gate.TEST_BOUND_ARGS, "--test-concurrency=4", "--test-reporter=spec", "--test-reporter-destination=stdout",
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
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ a: { result: "success" } }) }).status, 0);
  assert.equal(program("ci-shards.ts", ["needs"], { NEEDS: JSON.stringify({ a: { result: "skipped" } }) }).status, 1);
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
