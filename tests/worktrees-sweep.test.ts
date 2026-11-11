/**
 * scripts/worktrees-sweep.ts and its PostToolUse hook scripts/hooks/worktrees-sweep-after-merge.ts (issue 852), over a
 * temporary repository with a bare origin (`<tmp>/acme/widgets.git`, so the PRs are looked up in acme/widgets) and a
 * worktree under `.claude/worktrees/` in each state, with a fake `gh` first on PATH that answers each branch's PRs from
 * a file. Never the repository's own worktrees: other agents work in them.
 *
 * The scripts are spawned, not imported, so a tree without them fails each test by name (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = path.join(ROOT, "scripts", "worktrees-sweep.ts");
const HOOK = path.join(ROOT, "scripts", "hooks", "worktrees-sweep-after-merge.ts");
const linux = fs.existsSync("/proc/self/stat");

interface Pull { number: number; state: "open" | "closed"; merged_at: string | null; head: { sha: string } }

class Fixture {
  readonly tmp: string;
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly pullsFile: string;
  private pulls: Record<string, Pull[] | "error"> = {};
  private next = 1;

  constructor(t: { after: (fn: () => void) => void }) {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-sweep-test-")));
    t.after(() => fs.rmSync(this.tmp, { recursive: true, force: true }));
    this.repo = path.join(this.tmp, "repo");
    this.pullsFile = path.join(this.tmp, "pulls.json");
    const bin = path.join(this.tmp, "bin");
    fs.mkdirSync(bin);
    const fake = path.join(this.tmp, "fake-gh.mjs");
    fs.writeFileSync(fake, `
import * as fs from "node:fs";
const [api, route] = process.argv.slice(2);
const m = /^repos\\/acme\\/widgets\\/pulls\\?head=([^&]+)&state=all$/.exec(route ?? "");
if (api !== "api" || m === null) { process.stderr.write("fake gh: unexpected " + process.argv.slice(2).join(" ")); process.exit(9); }
const branch = decodeURIComponent(m[1]).replace(/^acme:/, "");
const answer = JSON.parse(fs.readFileSync(${JSON.stringify(this.pullsFile)}, "utf8"))[branch] ?? [];
if (answer === "error") { process.stderr.write("gh: Server Error (HTTP 502)\\n"); process.exit(1); }
process.stdout.write(JSON.stringify(answer));
`);
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    this.env = {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    };
    this.savePulls();
    const origin = path.join(this.tmp, "acme", "widgets.git");
    this.git(this.tmp, "init", "-q", "--bare", "-b", "main", origin);
    this.git(this.tmp, "init", "-q", "-b", "main", this.repo);
    fs.writeFileSync(path.join(this.repo, "README.md"), "hello\n");
    this.git(this.repo, "add", "README.md");
    this.git(this.repo, "commit", "-q", "-m", "first");
    this.git(this.repo, "remote", "add", "origin", origin);
    this.git(this.repo, "push", "-q", "-u", "origin", "main");
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  private savePulls(): void { fs.writeFileSync(this.pullsFile, JSON.stringify(this.pulls)); }

  /** A worktree on branch b-<name>, under .claude/worktrees/ unless `at` says where, with one commit of its own unless `commit` is false. */
  worktree(name: string, opts: { commit?: boolean; at?: string } = {}): { dir: string; branch: string; head: () => string } {
    const dir = opts.at ?? path.join(this.repo, ".claude", "worktrees", name);
    const branch = `b-${name}`;
    this.git(this.repo, "worktree", "add", "-q", "-b", branch, dir, "main");
    if (opts.commit !== false) {
      fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
      this.git(dir, "add", `${name}.txt`);
      this.git(dir, "commit", "-q", "-m", name);
    }
    return { dir, branch, head: () => this.git(dir, "rev-parse", "HEAD").trim() };
  }

  /** Pushes the branch, records its PR at HEAD, and, once merged, deletes the branch on origin as `--delete-branch` does. */
  pr(wt: { dir: string; branch: string; head: () => string }, state: "merged" | "closed" | "open"): void {
    this.git(wt.dir, "push", "-q", "origin", wt.branch);
    this.pulls[wt.branch] = [{
      number: this.next++, state: state === "open" ? "open" : "closed",
      merged_at: state === "merged" ? "2026-11-11T00:00:00Z" : null, head: { sha: wt.head() },
    }];
    this.savePulls();
    if (state === "merged") this.git(wt.dir, "push", "-q", "origin", "--delete", wt.branch);
  }

  apiErrs(branch: string): void { this.pulls[branch] = "error"; this.savePulls(); }

  branches(): string[] { return this.git(this.repo, "branch", "--format=%(refname:short)").trim().split("\n"); }
}

function sweep(f: Fixture): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SWEEP], { cwd: f.repo, env: f.env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const line = (out: string, verb: "removed" | "kept", name: string): string | undefined =>
  out.split("\n").find((l) => l.startsWith(`${verb} ${name}: `));

test("worktrees-sweep: a done and clean worktree is removed with its branch; every other is kept, said with its reason", (t) => {
  const f = new Fixture(t);
  const merged = f.worktree("merged"); f.pr(merged, "merged");
  const closed = f.worktree("closed"); f.pr(closed, "closed");
  f.worktree("inmain", { commit: false });
  const dirty = f.worktree("dirty"); f.pr(dirty, "merged");
  fs.appendFileSync(path.join(dirty.dir, "README.md"), "an edit not committed\n");
  const unpushed = f.worktree("unpushed"); f.pr(unpushed, "merged");
  fs.writeFileSync(path.join(unpushed.dir, "more.txt"), "more\n");
  f.git(unpushed.dir, "add", "more.txt"); f.git(unpushed.dir, "commit", "-q", "-m", "after the PR");
  const live = f.worktree("live"); f.pr(live, "merged");
  fs.mkdirSync(path.join(live.dir, "sub"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path.join(live.dir, "sub"), stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const open = f.worktree("open"); f.pr(open, "open");
  const apiErr = f.worktree("apierr"); f.git(apiErr.dir, "push", "-q", "origin", apiErr.branch); f.apiErrs(apiErr.branch);
  const nopr = f.worktree("nopr"); f.git(nopr.dir, "push", "-q", "origin", nopr.branch);
  const outside = f.worktree("outside", { at: path.join(f.tmp, "elsewhere") }); f.pr(outside, "merged");

  const r = sweep(f);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  for (const [name, why] of [["merged", /its PR #1 is merged, branch b-merged deleted$/], ["closed", /its PR #2 is closed, branch b-closed deleted$/],
    ["inmain", /its HEAD \w{7} is in origin\/main, branch b-inmain deleted$/]] as const) {
    assert.match(line(r.stdout, "removed", name) ?? "", why, r.stdout);
    assert.equal(fs.existsSync(path.join(f.repo, ".claude", "worktrees", name)), false, name);
    assert.equal(f.branches().includes(`b-${name}`), false, `b-${name} deleted`);
  }
  for (const [name, why] of [
    ["dirty", /1 tracked file\(s\) with uncommitted changes/],
    ["unpushed", /1 commit\(s\) on no remote ref, and HEAD \w{7} is not its PR's head/],
    ["live", new RegExp(`a live process works in it \\(pid ${child.pid}\\)`)],
    ["open", /its PR #\d+ is open/],
    ["apierr", /the PR lookup failed: gh: Server Error \(HTTP 502\)/],
    ["nopr", /no PR for its branch b-nopr/],
  ] as const) {
    assert.match(line(r.stdout, "kept", name) ?? "", why, r.stdout);
    assert.equal(fs.existsSync(path.join(f.repo, ".claude", "worktrees", name)), true, name);
    assert.equal(f.branches().includes(`b-${name}`), true, `b-${name} kept`);
  }
  assert.equal(fs.existsSync(outside.dir), true, "a worktree outside .claude/worktrees/ is never looked at");
  assert.equal(r.stdout.includes("outside"), false, r.stdout);
  assert.match(r.stdout, /: 3 removed, 6 kept\n$/);
  assert.equal(fs.readFileSync(path.join(dirty.dir, "README.md"), "utf8"), "hello\nan edit not committed\n", "the dirty one untouched");
  assert.match(f.git(f.repo, "worktree", "list"), /dirty/);
});

test("worktrees-sweep: a lock of a running Claude Code agent or a person's keeps the worktree; a stale agent lock does not", { skip: linux ? false : "reads /proc" }, (t) => {
  const f = new Fixture(t);
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const myStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const lock = (wt: { dir: string }, reason: string): void => { f.git(f.repo, "worktree", "lock", "--reason", reason, wt.dir); };
  const running = f.worktree("running"); f.pr(running, "merged"); lock(running, `claude agent agent-r (pid ${process.pid} start ${myStart})`);
  const gone = f.worktree("gone"); f.pr(gone, "merged"); lock(gone, `claude agent agent-g (pid ${dead} start 1)`);
  const reused = f.worktree("reused"); f.pr(reused, "merged"); lock(reused, `claude agent agent-u (pid ${process.pid} start 1${myStart})`);
  const person = f.worktree("person"); f.pr(person, "merged"); lock(person, "kept for a bisect");

  const r = sweep(f);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(line(r.stdout, "kept", "running") ?? "", new RegExp(`locked by a running Claude Code agent \\(pid ${process.pid}\\)`), r.stdout);
  assert.match(line(r.stdout, "kept", "person") ?? "", /locked: kept for a bisect/, r.stdout);
  assert.match(line(r.stdout, "removed", "gone") ?? "", /its PR #\d+ is merged/, r.stdout);
  assert.match(line(r.stdout, "removed", "reused") ?? "", /its PR #\d+ is merged/, r.stdout);
  assert.equal(fs.existsSync(running.dir) && fs.existsSync(person.dir), true);
  assert.equal(fs.existsSync(gone.dir) || fs.existsSync(reused.dir), false);
});

// ------------------------------------------------------------------ the hook

function hook(f: Fixture, input: Record<string, unknown>): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: f.repo, ...input }),
    env: { ...f.env, CLAUDE_PROJECT_DIR: f.repo }, encoding: "utf8", timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ok = (stdout = ""): Record<string, unknown> => ({ stdout, stderr: "", interrupted: false, isImage: false });

/** Waits, bounded, for the sweep the hook started to write its total. */
function waitForSweep(log: string): string {
  const until = Date.now() + 90_000;
  for (;;) {
    const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    if (/swept .*: \d+ removed, \d+ kept/.test(text) || /nothing swept/.test(text)) return text;
    if (Date.now() > until) assert.fail(`no sweep ended in ${log}:\n${text}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

test("worktrees-sweep-after-merge: a merge that landed starts the sweep in the background, its output to .claude/worktrees-sweep.log", (t) => {
  const f = new Fixture(t);
  const log = path.join(f.repo, ".claude", "worktrees-sweep.log");
  const merged = f.worktree("merged"); f.pr(merged, "merged");

  const rest = hook(f, { tool_input: { command: "gh api -X PUT repos/acme/widgets/pulls/1/merge -f merge_method=squash -f sha=abc" },
    tool_response: ok('{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}') });
  assert.deepEqual([rest.code, rest.stdout], [0, ""], rest.stderr);
  const text = waitForSweep(log);
  assert.match(text, /a merge was seen \(gh api -X PUT repos\/acme\/widgets\/pulls\/1\/merge/);
  assert.match(text, /removed merged: its PR #1 is merged, branch b-merged deleted/);
  assert.equal(fs.existsSync(merged.dir), false);

  fs.rmSync(log);
  const gh = hook(f, { tool_input: { command: "cd /x && gh pr merge 7 --squash --delete-branch --match-head-commit abc" }, tool_response: ok() });
  assert.deepEqual([gh.code, gh.stdout], [0, ""], gh.stderr);
  assert.match(waitForSweep(log), /a merge was seen \(cd \/x && gh pr merge 7/);
});

test("worktrees-sweep-after-merge: other commands, a queued merge and a merge that failed start nothing, and exit 0", (t) => {
  const f = new Fixture(t);
  const log = path.join(f.repo, ".claude", "worktrees-sweep.log");
  const merged = f.worktree("merged"); f.pr(merged, "merged");
  for (const input of [
    { tool_input: { command: "gh pr view 7" }, tool_response: ok() },
    { tool_input: { command: "git merge origin/main" }, tool_response: ok() },
    { tool_input: { command: "gh api repos/acme/widgets/pulls/7/merge" }, tool_response: ok('{"merged":true}') }, // a GET: no merge
    { tool_input: { command: "gh pr merge 7 --squash --auto --match-head-commit abc" }, tool_response: ok() },
    { tool_input: { command: "gh pr merge 7 --disable-auto" }, tool_response: ok() },
    { tool_input: { command: "gh pr merge 7 --squash --match-head-commit abc; echo done" }, tool_response: ok("X Pull request acme/widgets#7 is not mergeable: the base branch policy prohibits the merge.\ndone\n") },
    { tool_input: { command: "gh pr merge 7 --squash --match-head-commit abc" }, tool_response: { ...ok(), interrupted: true } },
    { tool_input: { command: "gh api -X PUT repos/acme/widgets/pulls/7/merge || true" }, tool_response: ok('{"message":"Pull Request is not mergeable","status":"405"}') },
    { hook_event_name: "PostToolUseFailure", tool_input: { command: "gh pr merge 7 --squash --match-head-commit abc" }, error: "Exit code 1" },
    { tool_name: "Edit", tool_input: { file_path: "x" }, tool_response: ok() },
  ]) {
    const r = hook(f, input);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], JSON.stringify(input));
    assert.equal(fs.existsSync(log), false, `no sweep for ${JSON.stringify(input)}`);
  }
  for (const raw of ["", "not json"]) {
    const r = spawnSync(process.execPath, [HOOK], { input: raw, encoding: "utf8", timeout: 30_000 });
    assert.deepEqual([r.status, r.stdout], [0, ""], raw);
  }
  assert.equal(fs.existsSync(merged.dir), true);
});
