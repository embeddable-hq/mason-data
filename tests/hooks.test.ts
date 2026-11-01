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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("test-timeout: node --test with no --test-timeout before the files is blocked, in every shape a session types", () => {
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
  ]) assertBlocked("test-timeout", command, /^node --test needs --test-timeout=<ms> before the files .*node --test --test-timeout=120000 <files>/);
});

test("test-timeout: npm test and npm run test are blocked, whatever is appended", () => {
  for (const command of ["npm test", "npm run test", "npm t", "npm test -- --test-timeout=1000", "cd x && npm run-script test | tail"]) {
    assertBlocked("test-timeout", command, /^npm test runs node --test with no time limit.*node --test --test-timeout=120000 <files>, or npm run check/);
  }
});

test("test-timeout: a run with its limit before the files, the gates and the scripts that bound themselves are allowed", () => {
  for (const command of [
    "node --test --test-timeout=120000 tests/hooks.test.ts tests/conventions.test.ts",
    "node --test --test-timeout 120000 tests/hooks.test.ts",
    "node --test --test-name-pattern foo --test-timeout=120000 tests/hooks.test.ts",
    "node --test --test-timeout=120000 --test-name-pattern='a b' tests/hooks.test.ts",
    "cd /tmp/x && IT_ORACLE_ONLY=json node --test --test-timeout=600000 tests/integration/duck-oracle.itest.ts 2>&1 | tail",
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
  // withdrawing a queued merge takes no head: gh refuses --match-head-commit beside --disable-auto
  assertAllowed("merge-head", "gh pr merge 12 --disable-auto");
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

test("the PreToolUse hooks let every other tool through, and allow on an empty or malformed input", () => {
  for (const name of ["test-timeout", "merge-head", "no-rerun", "wake-up"]) {
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

const WARNS = /"systemMessage":".* and no background wait is running: leave a bounded wait \(CLAUDE.md \\"A coordinator never ends a turn without a wake-up\\"\)"/;

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
