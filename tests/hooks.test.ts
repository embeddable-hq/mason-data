/**
 * scripts/hooks/: the Claude Code hooks of .claude/settings.json, each fed the JSON Claude Code sends it on stdin and held
 * to its exit code and its message: a PreToolUse hook blocks with exit 2 and one line on stderr saying what to run
 * instead, and allows with exit 0 and nothing; the Stop hook never blocks, and warns with a `systemMessage`.
 *
 * The scripts are spawned, not imported, so a tree without them fails each test by name (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// a namespace, not a named import: a tree whose gate.ts lacks the constant still loads, and the test fails by name
import * as gate from "../scripts/gate.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = (name: string): string => path.join(ROOT, "scripts", "hooks", `${name}.ts`);

function run(name: string, input: unknown): { code: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, [hook(name)], { input: JSON.stringify(input), encoding: "utf8", timeout: 30_000 });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

const bash = (command: string): unknown => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

function assertBlocked(name: string, command: string, says: RegExp): void {
  const r = run(name, bash(command));
  assert.equal(r.code, 2, `${name} should block: ${command}\n${r.stderr}`);
  assert.match(r.stderr.trimEnd(), says, command);
  assert.equal(r.stderr.trimEnd().split("\n").length, 1, `one line: ${r.stderr}`);
}

function assertAllowed(name: string, command: string): void {
  const r = run(name, bash(command));
  assert.equal(r.code, 0, `${name} should allow: ${command}\n${r.stderr}`);
  assert.equal(r.stderr, "", command);
}

// ------------------------------------------------------------------ the test time limit

/** The way out both messages give: the constant of scripts/gate.ts, which the hook writes as a literal. */
const wayOut = (): string => `node --test --test-timeout=${gate.TEST_TIMEOUT_MS} --test-force-exit <files>`;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("test-timeout: node --test without --test-timeout and --test-force-exit before the files is blocked, in every shape a session types", () => {
  assert.equal(gate.TEST_TIMEOUT_MS, 300_000, "the default the hook suggests");
  const says = new RegExp(`^node --test needs --test-timeout=<ms> and --test-force-exit before the files.*: ${escape(wayOut())}`);
  for (const command of [
    "node --test tests/hooks.test.ts",
    "node --test tests/hooks.test.ts --test-timeout=120000",
    "node --test --test-name-pattern foo tests/hooks.test.ts",
    "node --test --test-name-pattern=foo tests/hooks.test.ts --test-timeout=60000",
    "cd /tmp/x && node --test tests/hooks.test.ts",
    "IT_ORACLE_ONLY='json' node --test tests/integration/duck-oracle.itest.ts",
    "env IT_ORACLE_ONLY=x node --test tests/hooks.test.ts 2>&1 | tail -20",
    "npm run typecheck; node --test tests/hooks.test.ts",
    "npm run typecheck && /usr/local/bin/node --test tests/hooks.test.ts",
    "sh -c 'node --test tests/hooks.test.ts'",
    "node --test",
    // one of the pair alone, or after the files, or a limit that is no bound
    "node --test --test-timeout=300000 tests/hooks.test.ts",
    "node --test --test-force-exit tests/hooks.test.ts",
    "node --test --test-timeout=300000 tests/hooks.test.ts --test-force-exit",
    "node --test --test-timeout=0 --test-force-exit tests/hooks.test.ts",
    "node --test --test-timeout=abc --test-force-exit tests/hooks.test.ts",
  ]) assertBlocked("test-timeout", command, says);
});

test("test-timeout: npm test with anything appended is blocked: it runs the whole suite and Node ignores what lands after the files", () => {
  const says = new RegExp(`^npm test runs the whole suite.*${escape(wayOut())}`);
  for (const command of [
    "npm test -- --test-name-pattern foo",
    "npm test -- tests/hooks.test.ts",
    "npm run test -- --test-timeout=1000",
    "npm test -- --test-timeout=1000",
    "cd x && npm run-script test -- x | tail",
  ]) assertBlocked("test-timeout", command, says);
});

test("test-timeout: a run with the pair before the files, npm test alone, the gates and the scripts that bound themselves are allowed", () => {
  for (const command of [
    "npm test",
    "npm run test",
    "npm t",
    "npm run-script test",
    "npm test 2>&1 | tail -40",
    "cd /tmp/x && npm test",
    "node --test --test-timeout=300000 --test-force-exit tests/hooks.test.ts tests/conventions.test.ts",
    "node --test --test-timeout 300000 --test-force-exit tests/hooks.test.ts",
    "node --test --test-force-exit --test-name-pattern foo --test-timeout=120000 tests/hooks.test.ts",
    "node --test --test-timeout=120000 --test-force-exit --test-name-pattern='a b' tests/hooks.test.ts",
    "cd /tmp/x && IT_ORACLE_ONLY=json node --test --test-timeout=600000 --test-force-exit tests/integration/duck-oracle.itest.ts 2>&1 | tail",
    "npm run check",
    "npm run gate",
    "npm run typecheck",
    "npm run test:integration",
    "scripts/gate-slot.ts node --test tests/integration/duck-oracle.itest.ts",
    "node scripts/gate-slot.ts node --test tests/hooks.test.ts",
    "scripts/fails-without.ts origin/main tests/hooks.test.ts",
    "node scripts/fails-without.ts origin/main tests/hooks.test.ts --test-name-pattern x",
    "node src/cli/main.ts --help",
    "echo 'node --test a.ts'",
    "git commit -m 'npm test is blocked'",
  ]) assertAllowed("test-timeout", command);
});

/**
 * Every test command the docs tell a session to run: a `node --test …` or `npm test …` that opens a
 * backtick span (a prompt's escaped one too) or a line (a code block's, after its VAR=value words), up to the span's
 * end, a comment or the line's end. `node --test` alone names the runner, not a command; `<ms>` is a placeholder.
 */
function instructedTestCommands(): { where: string; command: string }[] {
  const files = execFileSync("git", ["ls-files", "-z", "*.md", ".claude/"], { cwd: ROOT, encoding: "utf8" }).split("\0")
    .filter((f) => /\.(md|js)$/.test(f));
  const found: { where: string; command: string }[] = [];
  for (const file of files) {
    fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/(?:^\s*|`)((?:[A-Z_]+=\S*\s+)*(?:node --test\b|npm (?:run |run-script )?t(?:est)?(?![\w:-]))[^`#\\\n]*)/g)) {
        const command = m[1]!.trim().replaceAll("<ms>", "1000");
        if (command !== "node --test") found.push({ where: `${file}:${i + 1}`, command });
      }
    });
  }
  return found;
}

test("test-timeout: every test command the docs instruct is one the hook lets through", () => {
  const commands = instructedTestCommands();
  assert.ok(commands.some((c) => c.where.startsWith("CLAUDE.md")), "the reader finds CLAUDE.md's commands");
  const blocked = commands.filter(({ command }) => run("test-timeout", bash(command)).code !== 0);
  assert.deepEqual(blocked, [], "each of these would be blocked by the hook: give it --test-timeout=<ms> --test-force-exit before its files");
});

// ------------------------------------------------------------------ merge only the commit read

test("merge-head: gh pr merge without --match-head-commit is blocked with the same command pinned", () => {
  assertBlocked("merge-head", "gh pr merge 12 --auto --merge",
    /^gh pr merge needs --match-head-commit.*: gh pr merge 12 --auto --merge --match-head-commit \$\(gh pr view 12 --json headRefOid --jq \.headRefOid\), once that head has been read$/);
  assertBlocked("merge-head", "cd /tmp/x && gh pr merge --merge 7 && echo merged", /: gh pr merge --merge 7 --match-head-commit \$\(gh pr view 7 /);
  assertBlocked("merge-head", "gh pr merge --squash", /gh pr view <n> --json headRefOid/);
});

test("merge-head: a merge pinned to its head, and other gh commands, are allowed", () => {
  assertAllowed("merge-head", "gh pr merge 12 --auto --merge --match-head-commit 36c6ea8f");
  assertAllowed("merge-head", "gh pr merge 12 --merge --match-head-commit=36c6ea8f");
  assertAllowed("merge-head", "gh pr view 12 --json headRefOid --jq .headRefOid");
  assertAllowed("merge-head", "git merge origin/main");
  // withdrawing a queued merge lands no commit, so there is no head to pin (gh ignores one given on a disable)
  assertAllowed("merge-head", "gh pr merge 12 --disable-auto");
});

// issue 588: a coordinator merged a PR itself. A hook fired inside a sub-agent carries `agent_id` (a non-empty string);
// the main session's carries none, and a `--agent` main session agent_type alone (code.claude.com/docs/en/hooks).
const SUB = { agent_id: "a1b2c3", agent_type: "general-purpose" };
const as = (who: Record<string, unknown>, command: string): unknown => ({ ...(bash(command) as object), ...who });
const SUB_AGENT_SAYS = /^a sub-agent never merges nor queues a merge \(CLAUDE\.md "Who merges what"\): report PR (\d+|<n>) and the head you read to the session that started you; the coordinator reads the diff and merges it \(\.claude\/skills\/coordinate\/SKILL\.md\)$/;

test("merge-head: a sub-agent's gh pr merge is blocked, pinned or not, queued or not, in every shape a session types", () => {
  for (const command of [
    "gh pr merge 577 --merge --match-head-commit d66508cb45b9",
    "gh pr merge 12 --auto --merge --match-head-commit 36c6ea8f",
    "cd /tmp/w && gh pr merge 7 --squash --match-head-commit=abc123 && echo done",
    "gh pr merge 12 --auto --merge",
    "sh -c 'gh pr merge 5 --merge --match-head-commit a'",
    "GH_PAGER= /opt/homebrew/bin/gh pr merge 5 --merge --match-head-commit a",
    "gh pr merge --squash",
  ]) {
    for (const who of [SUB, { agent_id: "a1" }]) {
      const r = run("merge-head", as(who, command));
      assert.equal(r.code, 2, `blocked from a sub-agent: ${command}\n${r.stderr}`);
      // who merges is decided first: an unpinned merge from a sub-agent gets this message, not the pin's
      assert.match(r.stderr.trimEnd(), SUB_AGENT_SAYS, command);
      assert.equal(r.stderr.trimEnd().split("\n").length, 1, `one line: ${r.stderr}`);
    }
  }
  assert.match(run("merge-head", as(SUB, "gh pr merge 577 --merge --match-head-commit d66508cb45b9")).stderr, /report PR 577 and the head/);
});

test("merge-head: a sub-agent may withdraw a queued merge, merge its base into its branch, push and read PRs", () => {
  for (const command of ["gh pr merge 12 --disable-auto", "git merge origin/main",
    "git merge --no-edit origin/main",
    "git push origin HEAD:upnext-588", "gh pr view 12 --json mergeable,mergeStateStatus", "gh pr create --base main --head upnext-588"]) {
    const r = run("merge-head", as(SUB, command));
    assert.deepEqual([r.code, r.stderr, r.stdout], [0, "", ""], command);
  }
  const read = run("merge-head", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, ...SUB });
  assert.deepEqual([read.code, read.stderr], [0, ""], "another tool from a sub-agent");
});

test("merge-head: the top session keeps its rules, and only a non-empty string agent_id is a sub-agent", () => {
  const pinned = "gh pr merge 12 --merge --match-head-commit a";
  for (const who of [{}, { agent_type: "up-next" }, { agent_id: "" }, { agent_id: 7 }, { agent_id: null }]) {
    const r = run("merge-head", as(who, pinned));
    assert.deepEqual([r.code, r.stderr], [0, ""], `read as the main session: ${JSON.stringify(who)}`);
  }
  assertAllowed("merge-head", "gh pr merge 12 --auto --merge --match-head-commit 36c6ea8f");
  const r = run("merge-head", as({ agent_type: "up-next" }, "gh pr merge 12 --auto --merge"));
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trimEnd(), "gh pr merge needs --match-head-commit, so a push after your read is not merged unread: gh pr merge 12 --auto --merge --match-head-commit $(gh pr view 12 --json headRefOid --jq .headRefOid), once that head has been read");
});

// ------------------------------------------------------------------ no re-run of an unchanged tree

test("no-rerun: gh run rerun is blocked, with or without --failed or --job", () => {
  for (const command of ["gh run rerun 123", "gh run rerun 123 --failed", "gh run rerun --job 456", "cd x && gh run rerun 1 | cat"]) {
    assertBlocked("no-rerun", command, /^gh run rerun repeats the same commit: read the failure \(gh run view <id> --log-failed\); it is the change's to fix, or a flake to quarantine with an issue/);
  }
});

test("no-rerun: reading a run is allowed", () => {
  for (const command of ["gh run view 123 --log-failed", "gh run list", "echo gh run rerun"]) assertAllowed("no-rerun", command);
});

// ------------------------------------------------------------------ the coordinator writes no change itself

// issue 741: a coordinator wrote five changes itself. The repository is $CLAUDE_PROJECT_DIR; a sub-agent carries agent_id.
const COORD_SAYS = /: the coordinator writes no change itself \(CLAUDE\.md "How work is done here", \.claude\/skills\/coordinate\/SKILL\.md\): start an implementer, or send this to the PR's implementer with SendMessage$/;

/** A repository of its own in a temp folder, with a worktree folder, a git index and the root CLAUDE.md. */
function repo(t: { after: (fn: () => void) => void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-writes-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude", "worktrees", "x", "app"), { recursive: true });
  fs.mkdirSync(path.join(dir, "app"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function coordinator(root: string, input: Record<string, unknown>, who: Record<string, unknown> = {}): { code: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [hook("coordinator-writes")], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, ...input, ...who }), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { code: r.status, stderr: r.stderr };
}

const edit = (tool: string, file: string): Record<string, unknown> =>
  ({ tool_name: tool, tool_input: tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file, content: "x" } });
const shell = (command: string): Record<string, unknown> => ({ tool_name: "Bash", tool_input: { command } });

function refused(root: string, input: Record<string, unknown>): void {
  const r = coordinator(root, input);
  assert.equal(r.code, 2, `refused from the top session: ${JSON.stringify(input)}\n${r.stderr}`);
  assert.match(r.stderr.trimEnd(), COORD_SAYS, JSON.stringify(input));
  assert.equal(r.stderr.trimEnd().split("\n").length, 1, `one line: ${r.stderr}`);
  const sub = coordinator(root, input, SUB);
  assert.deepEqual([sub.code, sub.stderr], [0, ""], `a sub-agent is never affected: ${JSON.stringify(input)}`);
}

function letThrough(root: string, input: Record<string, unknown>): void {
  const r = coordinator(root, input);
  assert.deepEqual([r.code, r.stderr], [0, ""], `allowed: ${JSON.stringify(input)}`);
}

test("coordinator-writes: an edit of the repository's code or a worktree's files is refused from the top session, never from a sub-agent", (t) => {
  const root = repo(t);
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    for (const file of [
      path.join(root, "app", "a.ts"),
      path.join(root, "app", "new", "deep.ts"),
      path.join(root, "README.md"),
      path.join(root, ".github", "workflows", "ci.yml"),
      path.join(root, ".claude", "worktrees", "x", "app", "a.ts"),
      // a worktree's own CLAUDE.md and .claude/ are a branch's files
      path.join(root, ".claude", "worktrees", "x", "CLAUDE.md"),
      path.join(root, ".claude", "worktrees", "x", ".claude", "settings.json"),
      path.join(root, "docs", "CLAUDE.md"),
      // relative to the cwd, and through ..
      "app/a.ts",
      path.join(root, ".claude", "..", "app", "a.ts"),
      path.join(root, ".claude", "skills", "..", "..", "app", "a.ts"),
      ".claude/worktrees/x/app/a.ts",
    ]) refused(root, edit(tool, file));
  }
  // a link under .claude/ that points into the code is the code
  fs.symlinkSync(path.join(root, "app"), path.join(root, ".claude", "app-link"));
  refused(root, edit("Write", path.join(root, ".claude", "app-link", "a.ts")));
});

test("coordinator-writes: the root CLAUDE.md, .claude/ outside its worktrees and a file outside the repository are allowed", (t) => {
  const root = repo(t);
  for (const file of [
    path.join(root, "CLAUDE.md"),
    "CLAUDE.md",
    path.join(root, ".claude", "skills", "coordinate", "SKILL.md"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "rules", "cli.md"),
    path.join(os.tmpdir(), "scratchpad", "notes.txt"),
    path.join(root, "..", "elsewhere.ts"),
  ]) letThrough(root, edit("Write", file));
});

test("coordinator-writes: a git command that lands a change is refused from the top session, in every shape a session types", (t) => {
  const root = repo(t);
  for (const command of [
    "git commit -am x",
    "git push -u origin claude/x",
    "git merge origin/main",
    "git merge --no-edit origin/main",
    "git cherry-pick abc123",
    "git rebase origin/main",
    "git am < x.patch",
    "git apply x.patch",
    "git revert HEAD",
    "git -C .claude/worktrees/x commit -m x",
    "git -C /tmp/w push",
    "cd w && git commit -m x",
    "git status && git push",
    "bash -c 'git commit -m x'",
    "GIT_DIR=x git commit -m x",
    "git push --abort",
  ]) refused(root, shell(command));
  refused(root, { tool_name: "mcp__github__push_files", tool_input: { owner: "o", repo: "r", branch: "b", files: [] } });
  refused(root, { tool_name: "mcp__github__create_or_update_file", tool_input: { path: "app/a.ts" } });
  refused(root, { tool_name: "mcp__github__delete_file", tool_input: { path: "app/a.ts" } });
});

test("coordinator-writes: reading git, withdrawing a merge and the worktrees' housekeeping are allowed", (t) => {
  const root = repo(t);
  for (const command of [
    "git merge --abort", "git rebase --abort", "git cherry-pick --abort", "git log --oneline -5", "git diff main...HEAD",
    "git status", "git fetch origin", "git worktree add .claude/worktrees/y -b claude/y origin/main",
    "git worktree remove .claude/worktrees/y", "git branch -D claude/y", "gh pr merge 12 --squash --match-head-commit abc",
    "echo git commit",
  ]) letThrough(root, shell(command));
});

test("coordinator-writes: a lone git commit of CLAUDE.md and .claude/ staged in the root is allowed; anything else staged, or that it cannot tell, is refused", (t) => {
  const root = repo(t);
  const write = (rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "x\n");
  };
  const git = (...a: string[]): void => { execFileSync("git", ["-C", root, ...a]); };
  // nothing staged: nothing to tell from
  refused(root, shell("git commit -m x"));
  write("CLAUDE.md");
  write(".claude/skills/coordinate/SKILL.md");
  git("add", "CLAUDE.md", ".claude/skills");
  for (const command of ["git commit -m 'process: one line'", "git commit -q -m x -m y", "git commit --message=x", "git commit -F msg.txt -s"]) {
    letThrough(root, shell(command));
  }
  // flags that commit what the index does not show yet, a commit beside another command, or from another directory
  for (const command of ["git commit -a -m x", "git commit -m x app/a.ts", "git commit --amend -m x", "git commit -p -m x",
    "git add -A && git commit -m x", "git -C . commit -m x", "GIT_INDEX_FILE=/tmp/i git commit -m x", "git commit -m x && git push"]) {
    refused(root, shell(command));
  }
  // a worktree's CLAUDE.md is a branch's file
  write(".claude/worktrees/x/CLAUDE.md");
  git("add", "-f", ".claude/worktrees/x/CLAUDE.md");
  refused(root, shell("git commit -m x"));
  git("rm", "-q", "--cached", ".claude/worktrees/x/CLAUDE.md");
  letThrough(root, shell("git commit -m x"));
  write("app/a.ts");
  git("add", "app/a.ts");
  refused(root, shell("git commit -m x"));
  // a rename into .claude/ still deletes the code it came from
  git("rm", "-q", "--cached", "app/a.ts");
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
  write("app/b.ts");
  git("add", "app/b.ts");
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "b"]);
  git("mv", "app/b.ts", ".claude/b.ts");
  refused(root, shell("git commit -m x"));
  // a cwd outside any repository: git cannot answer
  const r = coordinator(root, { ...shell("git commit -m x"), cwd: os.tmpdir() });
  assert.equal(r.code, 2, r.stderr);
});

test("the PreToolUse hooks let every other tool through, and allow on an empty or malformed input", () => {
  for (const name of ["test-timeout", "merge-head", "no-rerun", "coordinator-writes", "wake-up"]) {
    if (name !== "wake-up") {
      const r = run(name, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });
      assert.deepEqual([r.code, r.stderr], [0, ""], name);
    }
    for (const input of ["", "not json", "{\"tool_name\":\"Ba", "null"]) {
      const r = spawnSync(process.execPath, [hook(name)], { input, encoding: "utf8", timeout: 30_000 });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], `${name} on ${JSON.stringify(input)}`);
    }
  }
});

// ------------------------------------------------------------------ the wake-up before a turn ends

const assistant = (...content: unknown[]): unknown => ({ type: "assistant", message: { role: "assistant", content } });
const use = (id: string, name: string, input: unknown): unknown => ({ type: "tool_use", id, name, input });
const prompt = (content: unknown): unknown => ({ type: "user", message: { role: "user", content } });
const result = (id: string): unknown => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const notification = (id: string): unknown => ({
  type: "user", message: { role: "user", content: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>` },
});
const MERGE = use("t1", "Bash", { command: "gh pr merge 12 --auto --merge --match-head-commit abc" });
const SEND = use("t1", "mcp__ccd_session_mgmt__send_message", { session_id: "s", message: "go on" });
const WAIT = use("t2", "Bash", { command: "until gh pr view 12 --json state | grep MERGED; do sleep 60; done", run_in_background: true });

function stop(t: { after: (fn: () => void) => void }, entries: unknown[] | string, extra: Record<string, unknown> = {}): { code: number | null; stderr: string; stdout: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, typeof entries === "string" ? entries : entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return run("wake-up", { hook_event_name: "Stop", transcript_path: file, stop_hook_active: false, ...extra });
}

const WARNS = /"systemMessage":".* and no background wait is running: leave a bounded wait \(CLAUDE.md \\"Waiting\\"\)"/;

test("wake-up: a queued merge or a message to a lead with no background wait after it warns, and never blocks", (t) => {
  const merge = stop(t, [assistant(MERGE)]);
  assert.equal(merge.code, 0);
  assert.match(merge.stdout, /a merge is queued/);
  assert.match(merge.stdout, WARNS);
  const send = stop(t, [assistant(SEND)]);
  assert.deepEqual([send.code, /a lead is working/.test(send.stdout)], [0, true]);
  // in this turn, after a prompt, with tool results and a notification between: still this turn
  assert.match(stop(t, [prompt("merge 12"), assistant(MERGE), result("t1"), notification("t9"), assistant(use("t3", "Bash", { command: "ls" }))]).stdout, WARNS);
  // a wait started BEFORE the merge, or one that has already finished, wakes nobody after it
  assert.match(stop(t, [assistant(WAIT), assistant(MERGE)]).stdout, WARNS);
  assert.match(stop(t, [assistant(SEND), assistant(WAIT), notification("t2")]).stdout, WARNS);
  // a foreground Bash is no wait
  assert.match(stop(t, [assistant(MERGE), assistant(use("t3", "Bash", { command: "sleep 1" }))]).stdout, WARNS);
});

test("wake-up: a background wait still running after the merge or the message, or one Claude Code lists, is silent", (t) => {
  for (const entries of [
    [assistant(MERGE), assistant(WAIT)],
    [assistant(SEND), assistant(WAIT)],
    [assistant(MERGE, WAIT)],
    [assistant(SEND), assistant(use("t4", "Monitor", { command: "x" }))],
    [assistant(use("t5", "Bash", { command: "gh pr merge 3 --merge --match-head-commit a" }))], // not queued: nothing to wait on
    [assistant(use("t6", "Bash", { command: "ls" }))],
    // a SendMessage continues a sub-agent, whose end wakes the session: no wake-up needed
    [assistant(use("t7", "SendMessage", { to: "agent", message: "x" }))],
    // a trigger in an EARLIER turn was that turn's to resolve, or to be warned of
    [prompt("merge 12"), assistant(MERGE), result("t1"), prompt("now the other thing"), assistant(use("t8", "Bash", { command: "ls" }))],
    [assistant(SEND), prompt([{ type: "text", text: "next" }])],
    [assistant(MERGE), prompt([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } }, { type: "text", text: "next" }])],
    // another connector's send_message (an email) is no lead at work
    [assistant(use("t10", "mcp__0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0__send_message", { to: "x@example.com", body: "x" }))],
  ]) {
    const r = stop(t, entries);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], JSON.stringify(entries));
  }
  const listed = stop(t, [assistant(MERGE)], { background_tasks: [{ id: "b1", type: "shell", status: "running" }] });
  assert.deepEqual([listed.code, listed.stdout], [0, ""]);
  const cron = stop(t, [assistant(MERGE)], { session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "x" }] });
  assert.deepEqual([cron.code, cron.stdout], [0, ""]);
  const continuing = stop(t, [assistant(MERGE)], { stop_hook_active: true });
  assert.deepEqual([continuing.code, continuing.stdout], [0, ""]);
});

test("wake-up: an unreadable transcript or input says nothing and ends the stop with 0", (t) => {
  const missing = run("wake-up", { hook_event_name: "Stop", transcript_path: path.join(os.tmpdir(), "no-such-transcript.jsonl"), stop_hook_active: false });
  assert.deepEqual([missing.code, missing.stdout, missing.stderr], [0, "", ""]);
  const garbage = stop(t, "not json\n{\"type\":\"assistant\",\"mess");
  assert.deepEqual([garbage.code, garbage.stdout, garbage.stderr], [0, "", ""]);
  // a half-written last line does not hide what the lines before it say
  assert.match(stop(t, JSON.stringify(assistant(MERGE)) + "\n{\"type\":\"assist").stdout, WARNS);
  const r = spawnSync(process.execPath, [hook("wake-up")], { input: "not json", encoding: "utf8", timeout: 30_000 });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
});
