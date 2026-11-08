// The scripts a session runs by hand: the bounded CI wait, duck-repro, review-postgres, duck-repro-bounded, and
// done-file / wait-file, which let an agent wait on a gate that outlasts one tool call.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const CI_WAIT_SCRIPT = path.join(ROOT, "scripts", "ci-wait.ts");

type Step = { out: string; rc: number; hang?: boolean };
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** `GET /repos/{o}/{r}/pulls/<n>`'s answer, the fields ci-wait reads. */
const pull = (mergeable: boolean | null, mergeable_state: string, sha = SHA): Step => ({ out: JSON.stringify({ number: 900, head: { sha }, mergeable, mergeable_state }), rc: 0 });
type Run = [name: string, status: string, conclusion: string | null, id?: number];
/** `GET /repos/{o}/{r}/commits/<sha>/check-runs`'s answer. */
const runs = (...rs: Run[]): Step => ({ out: JSON.stringify({ total_count: rs.length, check_runs: rs.map(([name, status, conclusion, id], i) => ({ id: id ?? 100 + i, name, status, conclusion, html_url: `https://github.com/o/r/actions/runs/1/job/${id ?? 100 + i}` })) }), rc: 0 });
const REQUIRED_NAMES = ["checks", "image", "integration (oracle)", "integration (rest)"];
/** Every required check completed with `conclusion`, beside the jobs behind them. */
const all = (conclusion: string, ...extra: Run[]): Step => runs(["build", "completed", "success"], ...REQUIRED_NAMES.map((n): Run => [n, "completed", conclusion]), ...extra);
const GREEN = all("success");

/** Runs the command in bash with a stub `gh` first on PATH (each REST call answering its scripted steps in turn, the
 * last repeated; a step with `hang` never returns) and no pause between passes; returns its output, exit code, time and
 * the stub's call log, each call with the time it started. The stub is a bash script, never a Node one: Node's start
 * under load pushed a call past the deadline the test holds (issue 405). */
type Waited = { out: string; err: string; status: number | null; ms: number; first: string; pulls: string[]; checks: string[]; starts: number[] };
function runWait(cmd: string, scenario: { pull: Step[]; runs: Step[] }, bash = true): Waited {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wait-"));
  try {
    for (const [kind, steps] of Object.entries(scenario)) {
      fs.writeFileSync(path.join(dir, `${kind}.count`), String(steps.length));
      steps.forEach((s, i) => {
        fs.writeFileSync(path.join(dir, `${kind}.${i + 1}.out`), `${s.out}\n`);
        fs.writeFileSync(path.join(dir, `${kind}.${i + 1}.rc`), String(s.rc));
        if (s.hang) fs.writeFileSync(path.join(dir, `${kind}.${i + 1}.hang`), "");
      });
    }
    fs.writeFileSync(path.join(dir, "calls.log"), "");
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
d=${JSON.stringify(dir)}
case "$1 $2" in
  "api repos/{owner}/{repo}/pulls/"*) kind=pull ;;
  "api repos/{owner}/{repo}/commits/"*"/check-runs"*) kind=runs ;;
  *) kind=other ;;
esac
if [ -n "\${EPOCHREALTIME:-}" ]; then t=\${EPOCHREALTIME/[.,]/}; t=\${t:0:13}; else t=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000'); fi
echo "$kind $t $*" >> "$d/calls.log"
[ -f "$d/$kind.count" ] || { echo "stub gh: unexpected call $*" >&2; exit 2; }
n=$(grep -c "^$kind " "$d/calls.log"); max=$(cat "$d/$kind.count")
[ "$n" -gt "$max" ] && n=$max
[ -e "$d/$kind.$n.hang" ] && exec sleep 1000
cat "$d/$kind.$n.out"
exit "$(cat "$d/$kind.$n.rc")"
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, CI_WAIT_INTERVAL_MS: "0" };
    const t0 = Date.now();
    const r = bash ? spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 60_000, env }) : spawnSync(process.execPath, [CI_WAIT_SCRIPT, ...cmd.split(" ").filter(Boolean)], { encoding: "utf8", timeout: 60_000, env });
    const ms = Date.now() - t0;
    assert.equal(r.error, undefined, `the wait ended within the test's bound: ${String(r.error)}`);
    const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).map((c) => c.split(" "));
    const line = (c: string[]) => [c[0], ...c.slice(2)].join(" ");
    return { out: r.stdout, err: r.stderr, status: r.status, ms, first: r.stdout.split("\n")[0]!, starts: calls.map((c) => Number(c[1])),
      pulls: calls.filter((c) => c[0] === "pull").map(line), checks: calls.filter((c) => c[0] !== "pull").map(line) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ci-wait: reads the PR and its head's required checks through REST alone, and a probe that cannot tell is a wait (issue 758)", () => {
  const cmd = `node ${ROOT}/scripts/ci-wait.ts 900 540`;
  const src = fs.readFileSync(CI_WAIT_SCRIPT, "utf8");
  assert.ok(!src.includes("\"--watch\""), "the wait never uses --watch");
  for (const graphql of ["\"pr\"", "graphql"]) assert.ok(!src.includes(graphql), `no ${graphql} in the wait: gh pr view, checks and status use GraphQL, which a cloud session cannot reach`);
  // green: the PR, then the head's check-runs, by REST; every required check passed (skipped passes a required check)
  let w = runWait(cmd, { pull: [pull(true, "clean")], runs: [all("success", ["changes", "completed", "skipped"])] });
  assert.match(w.first, /^PR 900: green at 0123456789abcdef0123456789abcdef01234567$/, w.out);
  assert.equal(w.status, 0, "green exits 0");
  assert.deepEqual(w.pulls, ["pull api repos/{owner}/{repo}/pulls/900"], "one pass, the PR read by REST");
  assert.deepEqual(w.checks, [`runs api repos/{owner}/{repo}/commits/${SHA}/check-runs?filter=latest&per_page=100`], "the head's runs, by REST");
  assert.match(w.out, /\npull \(exit 0\): mergeable true, mergeable_state clean\ncheck-runs \(exit 0\):\nchecks\tcompleted\tsuccess\t\S+\nimage\t/, "both reads printed for the record");
  w = runWait(cmd, { pull: [pull(true, "blocked")], runs: [runs(...REQUIRED_NAMES.map((n): Run => [n, "completed", n === "image" ? "skipped" : "success"]))] });
  assert.equal(w.status, 0, `skipped is a pass, blocked no verdict: ${w.out}`);
  // red: any required check failed, cancelled or timed out is failed, at once, whatever the others are doing
  for (const red of ["failure", "cancelled", "timed_out"]) {
    w = runWait(cmd, { pull: [pull(true, "blocked")], runs: [runs(["checks", "in_progress", null], ["image", "completed", "success"], ["integration (oracle)", "completed", red])] });
    assert.match(w.first, /^PR 900: failed at /, `${red}: ${w.out}`);
    assert.equal(w.status, 3, `${red}: failed exits 3`);
    assert.equal(w.pulls.length, 1, `${red}: in one pass`);
  }
  // a failed job that no required check names is not the verdict: the required checks are
  w = runWait(cmd, { pull: [pull(true, "clean")], runs: [all("success", ["oracle collation icu", "completed", "failure"])] });
  assert.equal(w.status, 0, `a job outside the four is read through its required check: ${w.out}`);
  // pending: a check in progress, then green
  w = runWait(cmd, { pull: [pull(true, "blocked")], runs: [runs(...REQUIRED_NAMES.map((n): Run => [n, n === "checks" ? "in_progress" : "completed", n === "checks" ? null : "success"])), GREEN] });
  assert.match(w.first, /^PR 900: green\b/, w.out);
  assert.equal(w.checks.length, 2, "in_progress waited one pass");
  // a required check missing (not reported yet, just after a push) is a wait, never green, even when the rest passed
  w = runWait(cmd, { pull: [pull(true, "blocked")], runs: [runs(), runs(...REQUIRED_NAMES.filter((n) => n !== "image").map((n): Run => [n, "completed", "success"])), GREEN] });
  assert.match(w.first, /^PR 900: green\b/, w.out);
  assert.equal(w.checks.length, 3, `no runs, then image missing, each waited: ${w.out}`);
  // the head's latest run of a name decides: a re-run's newer success over its first, cancelled, attempt is green
  w = runWait(cmd, { pull: [pull(true, "clean")], runs: [all("success", ["checks", "completed", "cancelled", 1])] });
  assert.equal(w.status, 0, `the older cancelled run of checks is superseded: ${w.out}`);
  w = runWait(cmd, { pull: [pull(true, "clean")], runs: [all("success", ["checks", "completed", "cancelled", 999])] });
  assert.equal(w.status, 3, `the newer cancelled run of checks is the verdict: ${w.out}`);
  // a conclusion not named (stale) is couldn't tell, a wait
  w = runWait(cmd, { pull: [pull(true, "clean")], runs: [all("stale"), GREEN] });
  assert.equal(w.checks.length, 2, `stale waited: ${w.out}`);
  // mergeable null (GitHub still computing it after a push) is couldn't tell: a wait, never a conflict and never green
  w = runWait(cmd, { pull: [pull(null, "unknown"), pull(true, "clean")], runs: [GREEN] });
  assert.match(w.first, /^PR 900: green\b/, w.out);
  assert.equal(w.pulls.length, 2, `null waited a pass beside a green run: ${w.out}`);
  w = runWait(cmd, { pull: [pull(null, "unknown"), pull(false, "dirty")], runs: [all("failure")] });
  assert.equal(w.status, 4, `null beside a red run waited, then the conflict: ${w.out}`);
  assert.equal(w.pulls.length, 2);
  // a conflict is its own verdict, at once and final, over a finished green or red run (no workflow runs on it)
  for (const r of [GREEN, all("failure"), runs()]) {
    w = runWait(cmd, { pull: [pull(false, "dirty")], runs: [r] });
    assert.match(w.first, /^PR 900: conflict at /, w.out);
    assert.equal(w.status, 4, "conflict exits 4");
    assert.deepEqual([w.pulls.length, w.checks.length], [1, 0], "one read: a conflict needs no checks");
    assert.match(w.out, /mergeable false, mergeable_state dirty/, "the read is printed");
  }
  // a probe that fails or does not parse is couldn't tell, a wait, whatever the other says
  for (const bad of [{ out: "gh: Not Found (HTTP 404)", rc: 1 }, { out: "<html>bad gateway</html>", rc: 0 }, { out: JSON.stringify({ head: { sha: "x" }, mergeable: true }), rc: 0 }, { out: "", rc: 127 }]) {
    w = runWait(cmd, { pull: [bad, pull(true, "clean")], runs: [GREEN] });
    assert.match(w.first, /^PR 900: green\b/, `${bad.out}: ${w.out}`);
    assert.deepEqual([w.pulls.length, w.checks.length], [2, 1], `a PR read that failed (${bad.out}) waited, and read no checks`);
  }
  for (const bad of [{ out: "gh: HTTP 502", rc: 1 }, { out: "{\"check_runs\":", rc: 0 }, { out: "{\"message\":\"x\"}", rc: 0 }]) {
    w = runWait(cmd, { pull: [pull(true, "clean")], runs: [bad, GREEN] });
    assert.match(w.first, /^PR 900: green\b/, `${bad.out}: ${w.out}`);
    assert.equal(w.checks.length, 2, `a check-runs read that failed (${bad.out}) waited`);
  }
  // both answers are parsed, never grepped: another key order is the same field
  w = runWait(cmd, { pull: [{ out: `{"mergeable_state":"dirty","mergeable":false,"head":{"ref":"x","sha":"${SHA}"}}`, rc: 0 }], runs: [GREEN] });
  assert.equal(w.status, 4, w.out);
});

test("ci-wait: its required checks are the four ci.yml names", () => {
  const src = fs.readFileSync(CI_WAIT_SCRIPT, "utf8");
  const list = /^export const REQUIRED = (\[[^\]]*\]) as const;$/m.exec(src)?.[1];
  assert.ok(list, "REQUIRED is one list");
  const required = JSON.parse(list) as string[];
  assert.deepEqual(required, REQUIRED_NAMES);
  const named = (text: string, re: RegExp) => [...(re.exec(text)?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(named(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"), /THE FOUR REQUIRED CHECKS ARE ([^:]*):/), required, "ci.yml's header");
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const n of required) assert.ok(workflow.includes(`\n    name: ${n}\n`) || new RegExp(`\\n  ${n}:\\n(?!    name:)`).test(workflow), `ci.yml has a job named ${n}`);
});

test("ci-wait: bounded, a deadline no call starts after, a gh that never returns killed, and its verdict exits never 1", () => {
  // pending for ever: exit 8 at the deadline, no call started after it, three parts printed
  let w = runWait("900 2", { pull: [pull(true, "blocked")], runs: [runs(["checks", "in_progress", null])] }, false);
  assert.equal(w.status, 8, w.out + w.err);
  assert.match(w.first, /^PR 900: pending at 0123456789abcdef0123456789abcdef01234567$/);
  assert.match(w.out, /\npull \(exit 0\): mergeable true, mergeable_state blocked\ncheck-runs \(exit 0\):\nchecks\tin_progress\t-\t\S+\nimage\tmissing\nintegration \(oracle\)\tmissing\nintegration \(rest\)\tmissing\n$/, "its three parts");
  assert.ok(w.ms < 2000 + 3000, `within the bound and a call's kill: ${w.ms} ms`);
  // the deadline is set before the first call, so measured from that call's start, which leaves Node's own start out
  for (const t of w.starts) assert.ok(t - w.starts[0]! < 2000 + 500, `a call started ${t - w.starts[0]!} ms after the first, past the 2 s deadline`);
  // a check-runs read that never returns is killed at the deadline (gh, a Go program, ignores an alarm)
  w = runWait("900 3", { pull: [pull(true, "clean")], runs: [{ out: "", rc: 0, hang: true }] }, false);
  assert.equal(w.status, 8, w.out + w.err);
  assert.ok(w.ms >= 2900 && w.ms < 3000 + 4000, `killed near its deadline: ${w.ms} ms`);
  assert.match(w.first, /^PR 900: pending at /);
  assert.match(w.out, /\npull \(exit 0\): [^\n]*\ncheck-runs \(exit 137\): \(gh api repos\/\{owner\}\/\{repo\}\/commits\/[^\n]* killed after \d+ s, past its bound\)\n$/, "its three parts, the kill said");
  // usage: exit 2, one line naming the cap, gh never called
  for (const args of ["", "abc 10", "900 0", "900 -5", "900 x", "900 571", "900 10 extra"]) {
    w = runWait(args, { pull: [pull(true, "clean")], runs: [GREEN] }, false);
    assert.equal(w.status, 2, `"${args}": ${w.err}`);
    assert.match(w.err, /^usage: node scripts\/ci-wait\.ts <pr> <seconds>: [^\n]*from 1 to 570[^\n]*\n$/, `"${args}": one usage line naming the cap`);
    assert.equal(w.pulls.length + w.checks.length, 0, `"${args}": gh is never called`);
  }
  // its verdicts' exit codes are its own, never Node's 1 (an uncaught error), and the cap fits the Bash tool's bound
  const src = fs.readFileSync(CI_WAIT_SCRIPT, "utf8");
  const verdicts = /const VERDICT = (\{[^}]*\})/.exec(src)?.[1];
  assert.ok(verdicts, "VERDICT is one object");
  assert.deepEqual(new Function(`return (${verdicts})`)(), { green: 0, failed: 3, conflict: 4, pending: 8 });
  assert.match(src, /^export const MAX_SECONDS = 570;$/m);
  assert.ok(570 + 2 * 1 + 10 < 600, "a chunk at the cap, its last call's grace and Node's start end inside 600000 ms");
});

test("duck-repro: a missing psql says so, names PATH and how to install it, never `psql: ` and nothing (issue 246)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-repro-nopsql-"));
  try {
    const bin = path.join(dir, "empty-bin");
    fs.mkdirSync(bin);
    for (const f of ["ddl.sql", "stmts.sql"]) fs.writeFileSync(path.join(dir, f), "SELECT 1\n");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "duck-repro.ts"), path.join(dir, "ddl.sql"), path.join(dir, "stmts.sql")], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { PATH: bin, IT_POSTGRES_URL: "postgres://x:y@127.0.0.1:1/x" },
    });
    assert.equal(r.error, undefined, `the script ran within its bound: ${String(r.error)}`);
    assert.notEqual(r.status, 0, "it fails");
    assert.doesNotMatch(r.stderr, /psql: *(\n|$)/, "never `psql: ` with nothing after it");
    assert.match(r.stderr, /`psql`/, "it names psql");
    assert.match(r.stderr, /\bPATH\b/, "and PATH");
    assert.match(r.stderr, /brew install libpq[^\n]*postgresql-client/, "and how to install it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plain: Node's --env-file reads an env file written either way, `export IT_POSTGRES_URL=…` and `IT_POSTGRES_URL=…`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-file-"));
  try {
    const url = "postgres://u:p@127.0.0.1:5/postgres";
    for (const [file, text] of [["export.env", `export IT_POSTGRES_URL=${url}\n`], ["bare.env", `IT_POSTGRES_URL=${url}\n`]] as const) {
      fs.writeFileSync(path.join(dir, file), text);
      const r = spawnSync(process.execPath, [`--env-file=${path.join(dir, file)}`, "-e", "process.stdout.write(process.env.IT_POSTGRES_URL ?? 'unset')"], { encoding: "utf8", env: { PATH: process.env["PATH"] } });
      assert.equal(r.stdout, url, `${file}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A stub program in `dir`, a Node script logging its argv and the environment the tests look at, then `body`. */
function stubBin(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
fs.appendFileSync(dir + "/${name}.log", JSON.stringify({ argv: a, env: { POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD, PGPASSWORD: process.env.PGPASSWORD, PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGUSER: process.env.PGUSER, PGDATABASE: process.env.PGDATABASE } }) + "\\n");
${body}
`, { mode: 0o755 });
}
const logOf = (dir: string, name: string): Array<{ argv: string[]; env: Record<string, string | undefined> }> =>
  fs.existsSync(path.join(dir, `${name}.log`)) ? fs.readFileSync(path.join(dir, `${name}.log`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("plain: review-postgres starts a throwaway postgres:18 and stops it, its password never in argv, stdout or a file others read", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-pg-")));
  const tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp);
  const SCRIPT = path.join(ROOT, "scripts", "review-postgres.ts");
  try {
    stubBin(dir, "docker", `const state = dir + "/state";
if (a[0] === "run") { fs.writeFileSync(state, "running"); process.stdout.write("c0ffee\\n"); process.exit(0); }
if (a[0] === "port") { process.stdout.write("127.0.0.1:54321\\n"); process.exit(0); }
if (a[0] === "exec") { const n = (fs.existsSync(dir + "/ready") ? 1 : 0); fs.writeFileSync(dir + "/ready", "1"); process.exit(n ? 0 : 2); }
if (a[0] === "rm") { fs.writeFileSync(state, "gone"); process.exit(0); }
if (a[0] === "inspect") { if (fs.readFileSync(state, "utf8") === "running") { process.stdout.write("running\\n"); process.exit(0); } process.stderr.write("Error: No such object\\n"); process.exit(1); }
process.exit(9);`);
    const env = { PATH: `${dir}:${process.env["PATH"]}`, TMPDIR: tmp, REVIEW_POSTGRES_POLL_MS: "0" };
    const start = spawnSync(process.execPath, [SCRIPT, "start"], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(start.status, 0, start.stderr);
    const name = /^container (mason-review-[0-9a-f]{8})$/m.exec(start.stdout)?.[1];
    assert.ok(name, start.stdout);
    const envFile = /^env file (\S+)$/m.exec(start.stdout)?.[1];
    assert.equal(envFile, path.join(tmp, `${name}.env`));
    assert.equal(fs.statSync(envFile!).mode & 0o077, 0, "the env file is its owner's alone");
    const text = fs.readFileSync(envFile!, "utf8");
    const pw = /^export IT_POSTGRES_URL=postgres:\/\/postgres:([0-9a-f]{32})@127\.0\.0\.1:54321\/postgres\n$/.exec(text)?.[1];
    assert.ok(pw, "the env file holds the URL, on the free port docker gave");
    const runCall = logOf(dir, "docker").find((c) => c.argv[0] === "run")!;
    assert.equal(runCall.env["POSTGRES_PASSWORD"], pw, "the password is passed by the environment");
    for (const c of logOf(dir, "docker")) assert.ok(!c.argv.join(" ").includes(pw!), `never in argv: docker ${c.argv.join(" ")}`);
    assert.ok(!start.stdout.includes(pw!) && !start.stderr.includes(pw!) && !start.stdout.includes("postgres://"), "the URL is never printed");
    const argv = runCall.argv.join(" ");
    for (const s of ["-d --rm --name " + name, "-e POSTGRES_PASSWORD -p 127.0.0.1:0:5432", "--entrypoint timeout postgres:18 --kill-after=30 7200 docker-entrypoint.sh postgres -c wal_level=logical"]) assert.ok(argv.includes(s), `docker run … ${s}`);
    assert.equal(logOf(dir, "docker").filter((c) => c.argv[0] === "exec").length, 2, "it waited for pg_isready");
    const stop = spawnSync(process.execPath, [SCRIPT, "stop", name!], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(!fs.existsSync(envFile!), "the env file is deleted");
    const calls = logOf(dir, "docker").map((c) => c.argv.join(" "));
    assert.ok(calls.includes(`rm -f -v ${name}`), "removed");
    for (const c of calls.filter((x) => x.startsWith("inspect"))) assert.equal(c, `inspect --format {{.State.Status}} ${name}`, "inspect prints one field, never Config.Env");
    // still there after rm: stop says so, non-zero
    stubBin(dir, "docker", `if (a[0] === "inspect") { process.stdout.write("running\\n"); process.exit(0); } process.exit(0);`);
    const stuck = spawnSync(process.execPath, [SCRIPT, "stop", name!], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(stuck.status, 3, stuck.stderr);
    assert.match(stuck.stderr, /is not gone/);
    // without Docker it says so, and how to go on
    const none = spawnSync(process.execPath, [SCRIPT, "start"], { encoding: "utf8", env: { ...env, PATH: tmp }, timeout: 60_000 });
    assert.equal(none.status, 3, none.stderr);
    assert.match(none.stderr, /could not run docker[^\n]*itEnv/);
    for (const bad of [["stop"], ["stop", "postgres"], ["go"]]) assert.equal(spawnSync(process.execPath, [SCRIPT, ...bad], { encoding: "utf8", env }).status, 2, bad.join(" "));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plain: duck-repro-bounded prints the run's pid first and its real time last; past the bound it kills the run and drops that run's database", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repro-bounded-")));
  const SCRIPT = path.join(ROOT, "scripts", "duck-repro-bounded.ts");
  try {
    // a tree whose duck-repro says its own pid, then answers or never returns, as its statements file says
    fs.mkdirSync(path.join(dir, "tree", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tree", "scripts", "duck-repro.ts"), `import * as fs from "node:fs";
process.stdout.write("mypid " + process.pid + "\\n");
if (fs.readFileSync(process.argv[3]!, "utf8").includes("hang")) setInterval(() => {}, 1000);
else process.stdout.write("SAME 1\\n");
`);
    fs.writeFileSync(path.join(dir, "ddl.sql"), "CREATE TABLE t (id int PRIMARY KEY)\n");
    fs.writeFileSync(path.join(dir, "ok.sql"), "SELECT 1\n");
    fs.writeFileSync(path.join(dir, "hang.sql"), "-- hang\n");
    fs.writeFileSync(path.join(dir, "it.env"), "export IT_POSTGRES_URL=postgres://u:s3cret@127.0.0.1:5/postgres\n");
    stubBin(dir, "psql", "process.exit(0);");
    const env = { PATH: `${dir}:${process.env["PATH"]}` };
    const go = (stmts: string, secs = "1") => spawnSync(process.execPath, [`--env-file=${path.join(dir, "it.env")}`, SCRIPT, secs, path.join(dir, "tree"), path.join(dir, "ddl.sql"), path.join(dir, stmts)], { encoding: "utf8", env, timeout: 60_000 });
    const ok = go("ok.sql", "30");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /SAME 1/);
    assert.match(ok.stderr, /^pid (\d+)\n(?:[^\n]*\n)*real \d+\.\d\d\n$/, ok.stderr);
    assert.equal(/^pid (\d+)/.exec(ok.stderr)![1], /mypid (\d+)/.exec(ok.stdout)![1], "the pid printed is the run's own");
    assert.equal(logOf(dir, "psql").length, 0, "a run that finished leaves nothing to drop");
    const hung = go("hang.sql");
    assert.equal(hung.status, 124, hung.stderr);
    const pid = /^pid (\d+)/.exec(hung.stderr)?.[1];
    assert.equal(pid, /mypid (\d+)/.exec(hung.stdout)?.[1], "the pid printed first is the run's own");
    assert.match(hung.stderr, /killed: past the bound of 1 s\n/);
    assert.match(hung.stderr, new RegExp(`dropped duck_repro_${pid}\\n`));
    assert.match(hung.stderr, /\nreal 1\.\d\d\n$/, "the real time, last");
    const drop = logOf(dir, "psql");
    assert.equal(drop.length, 1);
    assert.ok(drop[0]!.argv.includes(`DROP DATABASE IF EXISTS duck_repro_${pid} WITH (FORCE)`), drop[0]!.argv.join(" "));
    assert.ok(!drop[0]!.argv.join(" ").includes("s3cret"), "the password never in psql's argv");
    assert.deepEqual([drop[0]!.env["PGPASSWORD"], drop[0]!.env["PGHOST"], drop[0]!.env["PGPORT"], drop[0]!.env["PGUSER"], drop[0]!.env["PGDATABASE"]], ["s3cret", "127.0.0.1", "5", "u", "postgres"]);
    assert.ok(!hung.stderr.includes("s3cret") && !hung.stdout.includes("s3cret"), "nor printed");
    // usage: without the URL, a bound out of range, or a tree with no duck-repro
    for (const [withEnv, args] of [[false, ["1", path.join(dir, "tree"), "a", "b"]], [true, ["0", path.join(dir, "tree"), "a", "b"]], [true, ["1", dir, "a", "b"]]] as const) {
      const r = spawnSync(process.execPath, [...(withEnv ? [`--env-file=${path.join(dir, "it.env")}`] : []), SCRIPT, ...args], { encoding: "utf8", env });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plain: wait-file exits 0 once its file is there and not empty, 8 at its bound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-file-"));
  const SCRIPT = path.join(ROOT, "scripts", "wait-file.ts");
  try {
    const target = path.join(dir, "result.json");
    fs.writeFileSync(target, "");
    const t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT, target, "20"], { env: { ...process.env, WAIT_FILE_INTERVAL_MS: "50" } });
    setTimeout(() => fs.writeFileSync(target, "{}"), 400);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 >= 350, "an empty file is not there yet");
    const late = spawnSync(process.execPath, [SCRIPT, path.join(dir, "never.json"), "1"], { encoding: "utf8", env: { ...process.env, WAIT_FILE_INTERVAL_MS: "50" }, timeout: 30_000 });
    assert.equal(late.status, 8, late.stderr);
    for (const args of [[], [target], [target, "0"], [target, "x"], [target, "7201"]]) assert.equal(spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }).status, 2, args.join(" "));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("done-file: writes the command's end, and only its end, to a file wait-file reads; the exit code is the command's (issue 504)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "done-file-"));
  const SCRIPT = path.join(ROOT, "scripts", "done-file.ts");
  const WAIT = path.join(ROOT, "scripts", "wait-file.ts");
  try {
    const done = path.join(dir, "done");
    fs.writeFileSync(done, "exit 0\n");
    // a command that runs a while: a stale done file is removed at once, and the file appears only at the end
    const child = spawn(process.execPath, [SCRIPT, done, process.execPath, "-e", "setTimeout(() => process.exit(3), 600)"], { stdio: "ignore" });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!fs.existsSync(done), "an earlier run's done file is gone before the command ends");
    const waited = spawnSync(process.execPath, [WAIT, done, "20"], { encoding: "utf8", env: { ...process.env, WAIT_FILE_INTERVAL_MS: "50" }, timeout: 30_000 });
    assert.equal(waited.status, 0, "wait-file ends once the command has ended");
    assert.ok(Date.now() - t0 >= 550, "and not before");
    const code = await new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", resolve)));
    assert.equal(code, 3, "done-file exits with the command's code");
    assert.equal(fs.readFileSync(done, "utf8"), "exit 3\n");
    // output is the command's, passed through
    const out = spawnSync(process.execPath, [SCRIPT, done, process.execPath, "-e", "console.log('gate output')"], { encoding: "utf8" });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "gate output\n");
    assert.equal(fs.readFileSync(done, "utf8"), "exit 0\n");
    // a command that cannot start is said, never read as passed
    const missing = spawnSync(process.execPath, [SCRIPT, done, path.join(dir, "no-such-command")], { encoding: "utf8" });
    assert.equal(missing.status, 127);
    assert.match(fs.readFileSync(done, "utf8"), /^error /);
    // a usage error runs nothing and writes nothing
    fs.rmSync(done);
    for (const args of [[], [done], ["", "node"]]) assert.equal(spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }).status, 2, args.join(" "));
    assert.ok(!fs.existsSync(done));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
