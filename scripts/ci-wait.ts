#!/usr/bin/env node
/**
 * ONE BOUNDED WAIT ON A PR's CI (CLAUDE.md "Waiting": a loop with a deadline, never `gh pr checks --watch`).
 *
 *   node scripts/ci-wait.ts <pr> <seconds>                  the PR's own checks, at its head
 *   node scripts/ci-wait.ts <pr> <seconds> --queued <sha>   a PR in the merge queue, put there at <sha>, until it merges
 *
 * REST ONLY: `gh pr view --json`, `gh pr checks` and `gh pr status` go through GitHub's GraphQL API, which a cloud
 * session cannot reach, so there every PR read as pending, and a red one was once read as green (issue 758). Each pass
 * reads `gh api repos/{owner}/{repo}/pulls/<pr>` (gh fills the repository from the checkout's remote) FIRST:
 * `mergeable` false is the verdict conflict, at once and final, since GitHub runs no pull_request workflow on a PR with
 * a merge conflict, so its checks never come (issue 255); null (computed lazily after a push), or a read that fails or
 * does not parse, is "couldn't tell", a wait; only true lets the checks decide. `mergeable_state` (blocked, behind,
 * draft, ...) is printed, never a verdict. Then `gh api repos/{owner}/{repo}/commits/<head.sha>/check-runs`: the HEAD's
 * runs only, the latest (highest id) of each name. Of the REQUIRED checks: any one failed, timed out, needing action or
 * failed to start is failed; all of them success, skipped or neutral (what a required check passes on) is green; one
 * not there yet, not completed, cancelled, or a conclusion not named here is a wait. CANCELLED IS NEVER FAILED: two runs
 * can start at the same commit, and CI's concurrency group cancels the older, whose jobs then read `cancelled` beside
 * the newer run's (twice read as failed for a green PR). The newer run's job of the same name has a higher id and
 * decides once it reports; until then the answer is "couldn't tell". A read that fails or does not parse is "couldn't tell", a wait. Both answers are parsed, never grepped.
 *
 * --queued <sha>: THE MERGE QUEUE. A PR put in the queue (`PUT /pulls/<n>/merge-async` with `merge_action=merge_queue`
 * and `sha`, CLAUDE.md "Who merges what") is merged by GitHub once the required checks pass on its merge group, a commit
 * of its own on a branch `gh-readonly-queue/<base>/pr-<n>...`. Each pass reads the PR first: merged at <sha> is the
 * verdict merged, final; merged or open at another head is moved, final (a push after the read: GitHub's REST docs do
 * not say that a push takes a queued PR out of the queue, so the wait says so, and the merge it lands is unread);
 * closed unmerged is closed; `mergeable` false is conflict. Then the PR's LIVE group branch
 * (`GET /git/matching-refs/heads/gh-readonly-queue/<base>/pr-<n>`, then `-` or nothing): any required check red at its
 * commit is failed (GitHub takes a PR out of the queue when its group fails; when a PR ahead of it caused it, GitHub
 * groups it again, so read the run before acting). A red run of a group GitHub destroyed is at another commit, so it is
 * never failed. With no live branch, the newest CI run on merge_group for this PR (`GET /actions/runs`): red is
 * UNKNOWN, since the PR may have left the queue or be grouped again, and the wait ends `unknown` (8) if it is still so
 * at the deadline. Anything else, a group not built yet included, is a wait. REST has no "in the queue" field, so a PR
 * that left the queue without closing reads 8 for ever: a queued wait that ends 8 says when to escalate (ESCALATE).
 * A direct merge (`merge_action=direct_merge`, the queue off) is read the same way: merged at <sha> is merged.
 *
 * It was a shell loop written into the harness's prompts, which Claude Code's worktree guard refuses in an isolated
 * agent (`$SECONDS` arithmetic, `$(…)`, `<<<`), so each agent improvised its own (issue 322): it is one plain command.
 *
 * Exit codes are the verdicts, and never Node's own 1: 0 green, 3 failed, 4 conflict, 8 pending (the deadline passed
 * with no verdict), 2 usage; with --queued, 0 merged (at <sha>), 6 closed (unmerged), 7 moved (the head is not
 * <sha>) and 8 unknown (as pending, with a red group that is gone). Any other exit (1 is an uncaught error) is "couldn't tell". Never pipe it: the exit code is
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
const VERDICT = { green: 0, merged: 0, failed: 3, conflict: 4, closed: 6, moved: 7, pending: 8, unknown: 8 } as const;
/** What a queued wait that ends 8 says to do: REST has no "in the queue" field, so 8 can go on for ever. */
export const ESCALATE = "next: 8 again is a wait, not an answer. A PR can leave the queue without closing (removed on its page, or the queue's check timeout), and REST cannot see that. If waits on it keep ending 8 for longer than the queue's check timeout plus a full CI run (16 to 22 minutes on main in November 2026), open the PR's page, and tell the owner if it is not in the queue.";
type Verdict = keyof typeof VERDICT;
/** A call killed past its bound reads as the shell's 128 + SIGKILL; gh not found, as the shell's 127. */
const KILLED = 137, NOT_RUN = 127;
const PASSED = new Set(["success", "skipped", "neutral"]);
// never `cancelled`: a run CI's concurrency group cancelled for a newer one at the same commit is no verdict (above)
const RED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

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

/** The PR's head, mergeable, and (for --queued) whether it is merged or closed and its base, from `GET /pulls/<n>`, or
 *  null when it cannot be read ("couldn't tell"). */
type Pull = { sha: string; mergeable: boolean | null; state: string; merged: boolean | undefined; open: boolean | undefined; base: string | undefined };
function pullOf(text: string): Pull | null {
  const v = record(parse(text));
  const sha = record(v?.["head"])?.["sha"];
  const mergeable = v?.["mergeable"];
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || !(mergeable === null || typeof mergeable === "boolean")) return null;
  const merged = v?.["merged"], state = v?.["state"], base = record(v?.["base"])?.["ref"];
  return { sha, mergeable, state: typeof v?.["mergeable_state"] === "string" ? v["mergeable_state"] : "?",
    merged: typeof merged === "boolean" ? merged : undefined, open: state === "open" ? true : state === "closed" ? false : undefined,
    base: typeof base === "string" && base !== "" ? base : undefined };
}

/** The newest CI run of this PR's merge group from `GET /actions/runs?event=merge_group`, null when none is there yet,
 *  or undefined when the answer cannot be read. A group's branch is `gh-readonly-queue/<base>/pr-<n>`, then `-` and more
 *  (GitHub's docs name the prefix alone), so `pr-1` never matches `pr-12-…`. */
type Group = { id: number; sha: string; branch: string; status: string; conclusion: string | null; url: string };
function groupOf(text: string, pr: string, base: string): Group | null | undefined {
  const list = record(parse(text))?.["workflow_runs"];
  if (!Array.isArray(list)) return undefined;
  const prefix = `gh-readonly-queue/${base}/pr-${pr}`;
  let newest: Group | null = null;
  for (const item of list) {
    const r = record(item);
    const id = r?.["id"], sha = r?.["head_sha"], branch = r?.["head_branch"], status = r?.["status"], conclusion = r?.["conclusion"], file = r?.["path"];
    if (typeof id !== "number" || typeof sha !== "string" || typeof status !== "string" || !(conclusion === null || typeof conclusion === "string")) return undefined;
    if (typeof branch !== "string" || !(branch === prefix || branch.startsWith(`${prefix}-`))) continue;
    if (typeof file !== "string" || file.replace(/@.*$/, "") !== ".github/workflows/ci.yml") continue;
    if (newest === null || newest.id < id) newest = { id, sha, branch, status, conclusion, url: typeof r?.["html_url"] === "string" ? r["html_url"] : "" };
  }
  return newest;
}

/** The live merge group branches of this PR from `GET /git/matching-refs/heads/<prefix>` (a prefix match, so `pr-1`
 *  also lists `pr-12-…`, which are dropped), or undefined when the answer cannot be read. */
function liveOf(text: string, prefix: string): Array<{ branch: string; sha: string }> | undefined {
  const list = parse(text);
  if (!Array.isArray(list)) return undefined;
  const out: Array<{ branch: string; sha: string }> = [];
  for (const item of list) {
    const r = record(item);
    const ref = r?.["ref"], sha = record(r?.["object"])?.["sha"];
    if (typeof ref !== "string" || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return undefined;
    const branch = ref.replace(/^refs\/heads\//, "");
    if (branch === prefix || branch.startsWith(`${prefix}-`)) out.push({ branch, sha });
  }
  return out;
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
  const [prArg, secArg, flag, queuedArg] = argv;
  const usage = `usage: node scripts/ci-wait.ts <pr> <seconds> [--queued <sha>]: <pr> a PR number, <seconds> a whole number from 1 to ${MAX_SECONDS} (the wait and its last call end inside the Bash tool's 600000 ms), <sha> the 40-hex head the PR was put in the merge queue at`;
  if (!(argv.length === 2 || (argv.length === 4 && flag === "--queued" && /^[0-9a-f]{40}$/.test(queuedArg ?? "")))
    || !/^[1-9]\d*$/.test(prArg ?? "") || !/^\d+$/.test(secArg ?? "") || Number(secArg) < 1 || Number(secArg) > MAX_SECONDS) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const pr = prArg!;
  const queued = argv.length === 4 ? queuedArg! : undefined;
  const interval = Number(process.env["CI_WAIT_INTERVAL_MS"] ?? 10_000);
  const deadline = now() + Number(secArg) * 1000;
  const left = (): number => deadline - now();
  // a call gets the time left, at least a second (so a call begun just in time reads something), at most CALL_MS
  const bound = (): number => Math.min(CALL_MS, Math.max(1000, left()));
  let st: Verdict = "pending", sha = "unknown", pullLine = "pull: not read", checkLines = "check-runs: not read", unknown = false;
  while (left() > 0) {
    const p = await gh(["api", `repos/{owner}/{repo}/pulls/${pr}`], bound());
    const pull = p.code === 0 ? pullOf(p.out) : null;
    pullLine = pull ? `pull (exit 0): mergeable ${String(pull.mergeable)}, mergeable_state ${pull.state}` : `pull (exit ${p.code}): ${p.out}`;
    if (!pull) checkLines = "check-runs: not read";
    else if (queued !== undefined) {
      sha = pull.sha;
      pullLine += `, ${pull.merged === true ? "merged" : pull.open === true ? "open" : pull.open === false ? "closed" : "state not read"}, queued at ${queued}`;
      if (pull.merged === true) { st = pull.sha === queued ? "merged" : "moved"; checkLines = "merge group: not read (the PR merged)"; break; }
      if (pull.sha !== queued) { st = "moved"; checkLines = "merge group: not read (the head moved after the read: take the PR out of the queue on its page, then read the new head)"; break; }
      if (pull.open === false && pull.merged === false) { st = "closed"; checkLines = "merge group: not read (the PR is closed)"; break; }
      if (pull.mergeable === false) { st = "conflict"; checkLines = "merge group: not read (a conflict takes the PR out of the queue)"; break; }
      if (left() <= 0) break;
      if (pull.base === undefined || pull.merged === undefined || pull.open === undefined) checkLines = "merge group: not read (the PR's base, merged or state did not read)";
      else {
        // `unknown` is set only by a pass that read far enough to tell: one cut short by the deadline keeps the last
        const prefix = `gh-readonly-queue/${pull.base}/pr-${pr}`;
        const l = await gh(["api", `repos/{owner}/{repo}/git/matching-refs/heads/${prefix}`], bound());
        const live = l.code === 0 ? liveOf(l.out, prefix) : undefined;
        if (live === undefined) checkLines = `merge group branches (exit ${l.code}): ${l.out}`;
        else if (live.length > 1) unknown = false, checkLines = `merge group: ${live.length} live branches for ${prefix} (${live.map((g) => g.branch).join(", ")}): waiting for GitHub to leave one`;
        else if (live.length === 1) {
          // the live group: its commit's required checks decide; a red run of a group GitHub destroyed is at another commit
          const group = live[0]!;
          unknown = false;
          if (left() <= 0) break;
          const c = await gh(["api", `repos/{owner}/{repo}/commits/${group.sha}/check-runs?filter=latest&per_page=100`], bound());
          const runs = c.code === 0 ? runsOf(c.out) : null;
          checkLines = `merge group ${group.branch} at ${group.sha} (live)\n` + (runs
            ? `check-runs (exit 0):\n${[...runs].map(([n, r]) => r ? `${n}\t${r.status}\t${r.conclusion ?? "-"}\t${r.url}` : `${n}\tmissing`).join("\n")}`
            : `check-runs (exit ${c.code}): ${c.out}`);
          // a red live group is the verdict; a green one waits for the merge, which is GitHub's to make
          if (runs && checksVerdict(runs) === "failed") { st = "failed"; break; }
        } else {
          // no live group: not built yet, or destroyed. The newest group run says which can't be told
          if (left() <= 0) break;
          const g = await gh(["api", "repos/{owner}/{repo}/actions/runs?event=merge_group&per_page=100"], bound());
          const group = g.code === 0 ? groupOf(g.out, pr, pull.base) : undefined;
          if (group === undefined) checkLines = `merge group: no live branch for ${prefix}; its runs (exit ${g.code}): ${g.out}`;
          else if (group === null) unknown = false, checkLines = `merge group: none yet for ${prefix} (queued behind others, or not grouped yet)`;
          else if (group.status === "completed" && RED.has(group.conclusion ?? "")) {
            unknown = true;
            checkLines = `merge group: UNKNOWN. Its newest group ${group.branch} at ${group.sha} ended ${group.conclusion} (${group.url}) and is gone: the PR has left the queue, or GitHub is grouping it again behind a PR that failed`;
          } else unknown = false, checkLines = `merge group: no live branch for ${prefix}; its newest run ${group.branch} at ${group.sha}: CI ${group.status} ${group.conclusion ?? "-"} ${group.url}`;
        }
      }
    } else {
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
  if (st === "pending" && unknown) st = "unknown";
  const next = queued !== undefined && (st === "pending" || st === "unknown") ? `\n${ESCALATE}` : "";
  process.stdout.write(`PR ${pr}: ${st} at ${sha}\n${pullLine}\n${checkLines}${next}\n`);
  return VERDICT[st];
}

process.exitCode = await main(process.argv.slice(2));
