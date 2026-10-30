/**
 * scripts/fails-without.ts runs in a COPY of the working tree, and its verdicts stay what they were. Each test makes a
 * small repository of its own in a temp folder, with the script copied in (it finds the repository from its own path),
 * and runs it as a person does; a run's temp folder is private to the test, so what it leaves behind is seen.
 *
 * The script is run from this tree's `scripts/`, so a tree that swaps in place fails these tests by name, which is how
 * they were proved: `scripts/fails-without.ts <base> tests/fails-without.test.ts --paths scripts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "fails-without.ts");

/** What the repository's module exports at the base commit, and in the working tree (the fix, uncommitted). */
const BUGGY = `export const double = (n: number): number => n + n + 1;\n`;
const FIXED = `export const double = (n: number): number => n + n;\n`;
/** A test file, whose imports are read at load: `add` exists only in the fix. */
const FILE = path.join("tests", "double.test.ts");
const MODULE = path.join("src", "double.ts");
const TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { double } from "../src/double.ts";
test("double doubles", () => { assert.equal(double(2), 4); });
test("double doubles zero", () => { assert.equal(double(0), 0); });
test("the sky is up", () => { assert.equal(1, 1); });
`;

interface Repo { dir: string; tmp: string; commit: string; git: (...a: string[]) => string; env: NodeJS.ProcessEnv }

function repo(t: { after: (fn: () => void) => void }): Repo {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fails-without-test-")));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const dir = path.join(top, "repo"), tmp = path.join(top, "tmp");
  fs.mkdirSync(tmp);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "tests"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "fails-without.ts"));
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "linked, not committed\n");
  fs.writeFileSync(path.join(dir, MODULE), BUGGY);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base");
  const commit = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(dir, MODULE), FIXED);
  fs.writeFileSync(path.join(dir, FILE), TEST);
  // NODE_TEST_CONTEXT: this file runs under the test runner, and a runner that inherits it reports to a parent, not as spec
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return { dir, tmp, commit, git, env: { ...env, TMPDIR: tmp } };
}

function run(r: Repo, ...args: string[]): { code: number | null; out: string } {
  const x = spawnSync(process.execPath, ["scripts/fails-without.ts", r.commit, ...args], { cwd: r.dir, env: r.env, encoding: "utf8" });
  return { code: x.status, out: `${x.stdout}${x.stderr}` };
}

/** Nothing of a run is left: no temp folder, no registered worktree. */
function assertClean(r: Repo): void {
  assert.deepEqual(fs.readdirSync(r.tmp), [], "the run's temp folder is gone");
  assert.equal(r.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "only the repository itself is registered");
}

test("a detector is PROVED with the fix uncommitted, by name, and the tree is left as it was", (t) => {
  const r = repo(t);
  const before = r.git("status", "--porcelain");
  const { code, out } = run(r, FILE);
  assert.equal(code, 0, out);
  assert.match(out, /PROVED: 2 test\(s\)/);
  assert.match(out, /- double doubles\n/);
  assert.match(out, /- double doubles zero/);
  assert.doesNotMatch(out, /- the sky is up/);
  assert.equal(fs.readFileSync(path.join(r.dir, MODULE), "utf8"), FIXED);
  assert.equal(r.git("status", "--porcelain"), before);
  assertClean(r);
});

test("the working tree is never swapped: a test that reads it while the commit's src runs sees the fix", (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, "tests", "watch.test.ts"), `import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
test("the tree is still the fix", () => { assert.equal(fs.readFileSync(process.env.WATCHED!, "utf8"), ${JSON.stringify(FIXED)}); });
`);
  r.env.WATCHED = path.join(r.dir, MODULE);
  const { code, out } = run(r, FILE, path.join("tests", "watch.test.ts"));
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /✖ the tree is still the fix/, "the commit's src was put in the working tree itself");
});

test("a test reads .git in the copy as it would here: its files, its HEAD, what is uncommitted", (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, "staged.txt"), "staged, not committed\n");
  r.git("add", "staged.txt");
  fs.writeFileSync(path.join(r.dir, "tests", "git.test.ts"), `import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
const git = (...a: string[]): string => execFileSync("git", a, { encoding: "utf8" });
test("git reads a repository of its own", () => {
  assert.notEqual(git("rev-parse", "--show-toplevel").trim(), process.env.ORIGINAL);
  assert.equal(git("rev-parse", "HEAD").trim(), process.env.HEAD_THERE);
});
test("its tracked files are the tree's, the staged one too", () => {
  assert.deepEqual(git("ls-files").trim().split("\\n"), [".gitignore", "scripts/fails-without.ts", "src/double.ts", "staged.txt"]);
});
test("what is uncommitted reads as uncommitted", () => {
  assert.match(git("status", "--porcelain"), /^\\?\\? tests\\/$/m);
  assert.match(git("status", "--porcelain"), /^A  staged\\.txt$/m);
});
test("what git ignores is there", () => { assert.equal(fs.readFileSync("ignored.txt", "utf8"), "linked, not committed\\n"); });
`);
  r.env.ORIGINAL = r.dir;
  r.env.HEAD_THERE = r.commit;
  const index = fs.readFileSync(path.join(r.dir, ".git", "index"));
  const { code, out } = run(r, FILE, path.join("tests", "git.test.ts"));
  assert.equal(code, 0, out);
  for (const name of ["git reads a repository of its own", "its tracked files are the tree's, the staged one too", "what is uncommitted reads as uncommitted", "what git ignores is there"]) {
    assert.doesNotMatch(out, new RegExp(`✖ ${name}`));
  }
  assert.ok(fs.readFileSync(path.join(r.dir, ".git", "index")).equals(index), "the tree's own index is not written");
  assertClean(r);
});

test("a nested repository stays out of the copy (a main checkout's .claude/worktrees)", (t) => {
  const r = repo(t);
  fs.mkdirSync(path.join(r.dir, "nested"));
  execFileSync("git", ["init", "--quiet"], { cwd: path.join(r.dir, "nested") });
  fs.writeFileSync(path.join(r.dir, "nested", "file.txt"), "x");
  r.git("worktree", "add", "--quiet", "--detach", path.join(r.dir, "linked"), "HEAD");
  fs.writeFileSync(path.join(r.dir, "tests", "nested.test.ts"), `import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
test("no nested repository came along", () => { assert.equal(fs.existsSync("nested"), false); assert.equal(fs.existsSync("linked"), false); });
`);
  const { code, out } = run(r, FILE, path.join("tests", "nested.test.ts"));
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /✖ no nested repository came along/);
});

test("a file the tree deleted is absent from the copy, and a file mode comes along", (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, "run.sh"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
  fs.rmSync(path.join(r.dir, ".gitignore"));
  fs.writeFileSync(path.join(r.dir, "tests", "tree.test.ts"), `import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
test("a deleted file stays deleted", () => { assert.equal(fs.existsSync(".gitignore"), false); });
test("a script keeps its mode", () => { assert.equal(execFileSync("./run.sh", { encoding: "utf8" }), "ran\\n"); });
`);
  const { code, out } = run(r, FILE, path.join("tests", "tree.test.ts"));
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /✖ a deleted file stays deleted|✖ a script keeps its mode/);
});

test("from a linked worktree too, whose index git names by an absolute path", (t) => {
  const r = repo(t);
  const linked = path.join(path.dirname(r.dir), "linked");
  r.git("worktree", "add", "--quiet", "--detach", linked, "HEAD");
  fs.writeFileSync(path.join(linked, MODULE), FIXED);
  fs.mkdirSync(path.join(linked, "tests"));
  fs.writeFileSync(path.join(linked, FILE), TEST);
  const x = spawnSync(process.execPath, ["scripts/fails-without.ts", r.commit, FILE], { cwd: linked, env: r.env, encoding: "utf8" });
  assert.equal(x.status, 0, `${x.stdout}${x.stderr}`);
  assert.match(x.stdout, /PROVED: 2 test\(s\)/);
  assert.deepEqual(fs.readdirSync(r.tmp), []);
});

test("a test that passes on both is NOT A DETECTOR", (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, "tests", "any.test.ts"), `import { test } from "node:test";\ntest("the sky is up", () => {});\n`);
  const { code, out } = run(r, path.join("tests", "any.test.ts"));
  assert.equal(code, 1, out);
  assert.match(out, /NOT A DETECTOR: nothing that passes here fails/);
  assertClean(r);
});

test("a test that fails on the tree is NOT GREEN", (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, MODULE), BUGGY);
  const { code, out } = run(r, FILE);
  assert.equal(code, 1, out);
  assert.match(out, /NOT GREEN/);
  assertClean(r);
});

const NEEDS_EXPORT = `import { test } from "node:test";
import { triple } from "../src/double.ts";
test("triple triples", () => { if (triple(1) !== 3) throw new Error("no"); });
`;

test("a file that cannot load at the commit is DID NOT LOAD, never a proof", (t) => {
  const r = repo(t);
  fs.appendFileSync(path.join(r.dir, MODULE), `export const triple = (n: number): number => n * 3;\n`);
  fs.writeFileSync(path.join(r.dir, "tests", "triple.test.ts"), NEEDS_EXPORT);
  const { code, out } = run(r, path.join("tests", "triple.test.ts"));
  assert.equal(code, 1, out);
  assert.match(out, /DID NOT LOAD: tests.triple\.test\.ts cannot be loaded/);
  assertClean(r);
});

test("a name narrows the run to one test, and the proof to it", (t) => {
  const r = repo(t);
  const { code, out } = run(r, FILE, "--test-name-pattern", "^double doubles zero$");
  assert.equal(code, 0, out);
  assert.match(out, /PROVED: 1 test\(s\)/);
  assert.match(out, /- double doubles zero/);
  assert.doesNotMatch(out, /- double doubles\n/);
});

test("a name does not hide a file that cannot load: still DID NOT LOAD", (t) => {
  const r = repo(t);
  fs.appendFileSync(path.join(r.dir, MODULE), `export const triple = (n: number): number => n * 3;\n`);
  fs.writeFileSync(path.join(r.dir, "tests", "triple.test.ts"), NEEDS_EXPORT);
  const { code, out } = run(r, path.join("tests", "triple.test.ts"), "--test-name-pattern=triple");
  assert.equal(code, 1, out);
  assert.match(out, /DID NOT LOAD/);
});

test("a name of a test that does not detect is NOT A DETECTOR, and one that matches nothing says so", (t) => {
  const r = repo(t);
  const detected = run(r, FILE, "--test-name-pattern=sky");
  assert.equal(detected.code, 1, detected.out);
  assert.match(detected.out, /NOT A DETECTOR: nothing that passes here fails/);
  const nothing = run(r, FILE, "--test-name-pattern=no such test");
  assert.equal(nothing.code, 1, nothing.out);
  assert.match(nothing.out, /NOT A DETECTOR: --test-name-pattern matched no test/);
});

test("with --skip-now a named failure at the commit is still PROVED", (t) => {
  const r = repo(t);
  const { code, out } = run(r, FILE, "--skip-now");
  assert.equal(code, 0, out);
  assert.match(out, /PROVED: 2 test\(s\)/);
});

test("--paths takes a single file from the commit", (t) => {
  const r = repo(t);
  const { code, out } = run(r, FILE, "--paths", MODULE);
  assert.equal(code, 0, out);
  assert.match(out, /PROVED/);
  assertClean(r);
});

test("a failure of the run itself leaves nothing behind and is no verdict", (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, "new.txt"), "not at the commit\n");
  const { code, out } = run(r, FILE, "--paths", "new.txt");
  assert.notEqual(code, 0, out);
  assert.doesNotMatch(out, /PROVED|NOT A DETECTOR|DID NOT LOAD/);
  assert.equal(fs.readFileSync(path.join(r.dir, MODULE), "utf8"), FIXED);
  assertClean(r);
});

const SLOW = `import { test } from "node:test";
import * as fs from "node:fs";
test("waits to be killed", async () => { fs.writeFileSync(process.env.READY!, "x"); await new Promise((resolve) => setTimeout(resolve, 60_000)); });
`;

/** Runs the script over a test that never ends, and resolves once that test has started. */
async function started(r: Repo): Promise<{ pid: number; exit: Promise<{ code: number | null; signal: string | null; out: string }> }> {
  fs.writeFileSync(path.join(r.dir, "tests", "slow.test.ts"), SLOW);
  const ready = path.join(path.dirname(r.tmp), "ready");
  const c = spawn(process.execPath, ["scripts/fails-without.ts", r.commit, path.join("tests", "slow.test.ts"), "--skip-now"], { cwd: r.dir, env: { ...r.env, READY: ready }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { out += d; });
  const exit = new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => c.on("close", (code, signal) => resolve({ code, signal, out })));
  const until = Date.now() + 60_000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < until, `the slow test never started: ${out}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { pid: c.pid!, exit };
}

test("an interrupted run has no verdict and leaves nothing behind", async (t) => {
  const r = repo(t);
  const { pid, exit } = await started(r);
  process.kill(-pid, "SIGTERM");
  const { code, out } = await exit;
  assert.equal(code, 130, out);
  assert.doesNotMatch(out, /PROVED|NOT A DETECTOR|DID NOT LOAD|NOT GREEN/);
  assertClean(r);
});

test("a run killed outright leaves a copy, and the next run removes it", async (t) => {
  const r = repo(t);
  const { pid, exit } = await started(r);
  // its whole group: SIGKILL cannot be caught, so no cleanup runs, and the test runner under it goes too
  process.kill(-pid, "SIGKILL");
  const { signal } = await exit;
  assert.equal(signal, "SIGKILL");
  assert.equal(fs.readdirSync(r.tmp).filter((f) => f.startsWith("fails-without-")).length, 1, "the killed run's copy is there to be found");
  const next = run(r, FILE);
  assert.equal(next.code, 0, next.out);
  assert.match(next.out, /removed the copy a killed run left/);
  assertClean(r);
});

test("two runs at once in one tree each get their verdict, and another run's live copy is left alone", async (t) => {
  const r = repo(t);
  const once = (): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const c = spawn(process.execPath, ["scripts/fails-without.ts", r.commit, FILE], { cwd: r.dir, env: r.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  });
  const [a, b, c] = await Promise.all([once(), once(), once()]);
  for (const x of [a!, b!, c!]) {
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /PROVED: 2 test\(s\)/);
    assert.doesNotMatch(x.out, /removed the copy a killed run left/);
  }
  assertClean(r);
});
