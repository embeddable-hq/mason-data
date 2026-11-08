#!/usr/bin/env node
/**
 * ONE BOUNDED WAIT ON A PR's CI (CLAUDE.md "Waiting": a loop with a deadline, never `gh pr checks --watch`).
 *
 *   node scripts/ci-wait.ts <pr> <seconds>
 *
 * REST ONLY: `gh pr view --json`, `gh pr checks` and `gh pr status` go through GitHub's GraphQL API, which a cloud
 * session cannot reach, so there every PR read as pending, and a red one was once read as green (issue 758). Each pass
 * reads `gh api repos/{owner}/{repo}/pulls/<pr>` (gh fills the repository from the checkout's remote) FIRST:
 * `mergeable` false is the verdict conflict, at once and final, since GitHub runs no pull_request workflow on a PR with
 * a merge conflict, so its checks never come (issue 255); null (computed lazily after a push), or a read that fails or
 * does not parse, is "couldn't tell", a wait; only true lets the checks decide. `mergeable_state` (blocked, behind,
 * draft, ...) is printed, never a verdict. Then `gh api repos/{owner}/{repo}/commits/<head.sha>/check-runs`: the HEAD's
 * runs only (a superseded run's cancelled jobs are on an older commit), the latest of each name. Of the REQUIRED checks:
 * any one failed, cancelled, timed out, needing action or failed to start is failed; all of them success, skipped or
 * neutral (what a required check passes on) is green; one not there yet, not completed, or a conclusion not named here
 * is a wait. A read that fails or does not parse is "couldn't tell", a wait. Both answers are parsed, never grepped.
 *
 * It was a shell loop written into the harness's prompts, which Claude Code's worktree guard refuses in an isolated
 * agent (`$SECONDS` arithmetic, `$(…)`, `<<<`), so each agent improvised its own (issue 322): it is one plain command.
 *
 * Exit codes are the verdicts, and never Node's own 1: 0 green, 3 failed, 4 conflict, 8 pending (the deadline passed
 * with no verdict), 2 usage. Any other exit (1 is an uncaught error) is "couldn't tell". Never pipe it: the exit code is
 * the verdict. It prints `PR <n>: <verdict> at <head sha>`, then the PR's read, then each required check's.
 *
 * BOUNDED: a deadline from a monotonic clock; no call starts after it; every gh call is killed with SIGKILL at the time
 * left (at most 60 s; gh is a Go program, which ignores an alarm). `seconds` is capped so the wait and its last call end
 * inside the Bash tool's 600000 ms. CI_WAIT_INTERVAL_MS sets the pause between passes (10 s); only the tests set it.
 */
import { spawn } from "node:child_process";

/** The largest wait: it, the last call's second of grace and Node's start end inside the Bash tool's 600 s. */
export const MAX_SECONDS = 570;
/** The checks the ruleset on main requires (.github/workflows/ci.yml's header names them; tests/scripts.test.ts holds the two equal). */
export const REQUIRED = ["checks", "image", "integration (oracle)", "integration (rest)"] as const;
const CALL_MS = 60_000;
const VERDICT = { green: 0, failed: 3, conflict: 4, pending: 8 } as const;
type Verdict = keyof typeof VERDICT;
/** A call killed past its bound reads as the shell's 128 + SIGKILL; gh not found, as the shell's 127. */
const KILLED = 137, NOT_RUN = 127;
const PASSED = new Set(["success", "skipped", "neutral"]);
const RED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `gh <args>`, stdout and stderr in one text as `2>&1` gave them, killed at `ms`. */
function gh(args: string[], ms: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "", done = false, killed = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\n+$/, "") + (killed ? `${out ? "\n" : ""}(gh ${args.slice(0, 2).join(" ")} killed after ${Math.round(ms / 1000)} s, past its bound)` : "") });
    };
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, ms);
    child.on("error", (e) => { out += `could not run gh: ${e.message}`; finish(NOT_RUN); });
    child.on("close", (code) => finish(killed ? KILLED : code ?? KILLED));
    // a grandchild holding the pipes open must not hold the wait past its bound: the exit decides, a second later
    child.on("exit", () => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(killed ? KILLED : child.exitCode ?? KILLED);
      }, 1000).unref();
    });
  });
}

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // not JSON (an error page, a partial read): couldn't tell, which is a wait
    return null;
  }
}

/** The PR's head and mergeable from `GET /pulls/<n>`, or null when it cannot be read ("couldn't tell"). */
type Pull = { sha: string; mergeable: boolean | null; state: string };
function pullOf(text: string): Pull | null {
  const v = record(parse(text));
  const sha = record(v?.["head"])?.["sha"];
  const mergeable = v?.["mergeable"];
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || !(mergeable === null || typeof mergeable === "boolean")) return null;
  return { sha, mergeable, state: typeof v?.["mergeable_state"] === "string" ? v["mergeable_state"] : "?" };
}

/** Each required check's latest run at the head from `GET /commits/<sha>/check-runs`, or null when it cannot be read. */
type Run = { status: string; conclusion: string | null; url: string };
function runsOf(text: string): Map<string, Run | undefined> | null {
  const list = record(parse(text))?.["check_runs"];
  if (!Array.isArray(list)) return null;
  const latest = new Map<string, Run & { id: number }>();
  for (const item of list) {
    const r = record(item);
    const name = r?.["name"], id = r?.["id"], status = r?.["status"], conclusion = r?.["conclusion"];
    if (typeof name !== "string" || typeof id !== "number" || typeof status !== "string" || !(conclusion === null || typeof conclusion === "string")) return null;
    // a re-run at the same commit is a newer run of the same name: the newest decides
    if ((latest.get(name)?.id ?? -1) < id) latest.set(name, { id, status, conclusion, url: typeof r?.["html_url"] === "string" ? r["html_url"] : "" });
  }
  return new Map(REQUIRED.map((n) => [n, latest.get(n)]));
}

function checksVerdict(runs: Map<string, Run | undefined>): Verdict {
  const all = [...runs.values()];
  if (all.some((r) => r?.status === "completed" && RED.has(r.conclusion ?? ""))) return "failed";
  if (all.every((r) => r?.status === "completed" && PASSED.has(r.conclusion ?? ""))) return "green";
  return "pending";
}

async function main(argv: string[]): Promise<number> {
  const [prArg, secArg] = argv;
  const usage = `usage: node scripts/ci-wait.ts <pr> <seconds>: <pr> a PR number, <seconds> a whole number from 1 to ${MAX_SECONDS} (the wait and its last call end inside the Bash tool's 600000 ms)`;
  if (argv.length !== 2 || !/^[1-9]\d*$/.test(prArg ?? "") || !/^\d+$/.test(secArg ?? "") || Number(secArg) < 1 || Number(secArg) > MAX_SECONDS) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const pr = prArg!;
  const interval = Number(process.env["CI_WAIT_INTERVAL_MS"] ?? 10_000);
  const deadline = now() + Number(secArg) * 1000;
  const left = (): number => deadline - now();
  // a call gets the time left, at least a second (so a call begun just in time reads something), at most CALL_MS
  const bound = (): number => Math.min(CALL_MS, Math.max(1000, left()));
  let st: Verdict = "pending", sha = "unknown", pullLine = "pull: not read", checkLines = "check-runs: not read";
  while (left() > 0) {
    const p = await gh(["api", `repos/{owner}/{repo}/pulls/${pr}`], bound());
    const pull = p.code === 0 ? pullOf(p.out) : null;
    pullLine = pull ? `pull (exit 0): mergeable ${String(pull.mergeable)}, mergeable_state ${pull.state}` : `pull (exit ${p.code}): ${p.out}`;
    if (!pull) checkLines = "check-runs: not read";
    else {
      if (pull.sha !== sha) checkLines = "check-runs: not read";
      sha = pull.sha;
      if (pull.mergeable === false) { st = "conflict"; checkLines = "check-runs: not read (a conflict runs no checks)"; break; }
      // past the deadline no call starts: the last pass's check-runs stay printed, for the record
      if (left() <= 0) break;
      const c = await gh(["api", `repos/{owner}/{repo}/commits/${pull.sha}/check-runs?filter=latest&per_page=100`], bound());
      const runs = c.code === 0 ? runsOf(c.out) : null;
      checkLines = runs
        ? `check-runs (exit 0):\n${[...runs].map(([n, r]) => r ? `${n}\t${r.status}\t${r.conclusion ?? "-"}\t${r.url}` : `${n}\tmissing`).join("\n")}`
        : `check-runs (exit ${c.code}): ${c.out}`;
      const v = runs && pull.mergeable === true ? checksVerdict(runs) : "pending";
      if (v !== "pending") { st = v; break; }
    }
    if (left() <= 0) break;
    await sleep(Math.max(0, Math.min(Number.isFinite(interval) ? interval : 10_000, left())));
  }
  process.stdout.write(`PR ${pr}: ${st} at ${sha}\n${pullLine}\n${checkLines}\n`);
  return VERDICT[st];
}

process.exitCode = await main(process.argv.slice(2));
