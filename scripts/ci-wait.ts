#!/usr/bin/env node
/**
 * ONE BOUNDED WAIT ON A PR's CI (CLAUDE.md "Local gates": a `gh pr checks` loop with a deadline, never `--watch`).
 *
 *   node scripts/ci-wait.ts <pr> <seconds>
 *
 * Each pass reads `gh pr view <pr> --json mergeable,mergeStateStatus` FIRST, then `gh pr checks <pr>`. GitHub runs no
 * pull_request workflow on a PR with a merge conflict, so there "no checks reported" never ends (issue 255): mergeable
 * CONFLICTING is the verdict conflict, at once and final, even over a finished green or red run. UNKNOWN (computed
 * lazily after a push), any other value, or a `gh pr view` that fails is "couldn't tell", a wait; only MERGEABLE lets
 * the checks decide. mergeStateStatus (DRAFT, BLOCKED, BEHIND, ...) is printed, never a verdict. `gh pr checks` exits 0
 * when all passed, 8 while any is pending, 1 on a failure, and also 1 with "no checks reported" just after a push, which
 * is a wait; any other code is "couldn't tell", a wait. mergeable is read from the JSON, parsed, never grepped.
 *
 * It was a shell loop written into the harness's prompts, which Claude Code's worktree guard refuses in an isolated
 * agent (`$SECONDS` arithmetic, `$(…)`, `<<<`), so each agent improvised its own (issue 322): it is one plain command.
 *
 * Exit codes are the verdicts, and never Node's own 1: 0 green, 3 failed, 4 conflict, 8 pending (the deadline passed
 * with no verdict), 2 usage. Any other exit (1 is an uncaught error) is "couldn't tell".
 * It prints three parts: `PR <n>: <verdict> (last exit <rc>)`, `mergeable (exit <mrc>): <gh pr view's output>`, then the
 * last `gh pr checks` output.
 *
 * BOUNDED: a deadline from a monotonic clock; no pass starts after it; every gh call is killed with SIGKILL at the time
 * left (at most 60 s; gh is a Go program, which ignores an alarm). `seconds` is capped so the wait and its last call end
 * inside the Bash tool's 600000 ms. CI_WAIT_INTERVAL_MS sets the pause between passes (10 s); only the tests set it.
 */
import { spawn } from "node:child_process";

/** The largest wait: it, the last call's second of grace and Node's start end inside the Bash tool's 600 s. */
export const MAX_SECONDS = 570;
const CALL_MS = 60_000;
const VERDICT = { green: 0, failed: 3, conflict: 4, pending: 8 } as const;
type Verdict = keyof typeof VERDICT;
/** A call killed past its bound reads as the shell's 128 + SIGKILL; gh not found, as the shell's 127. */
const KILLED = 137, NOT_RUN = 127;

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

/** mergeable from `gh pr view --json`'s output, or null when it cannot be read ("couldn't tell"). */
function mergeableOf(text: string): string | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && typeof (v as Record<string, unknown>)["mergeable"] === "string" ? (v as Record<string, string>)["mergeable"]! : null;
  } catch {
    // not JSON (an error page, a partial read): couldn't tell, which is a wait
    return null;
  }
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
  // a call gets the time left, at least a second (so a pass begun just in time reads something), at most CALL_MS
  const bound = (): number => Math.min(CALL_MS, Math.max(1000, left()));
  let st: Verdict = "pending", rc: number | null = null, mrc: number | null = null, mg = "", out = "";
  while (left() > 0) {
    const v = await gh(["pr", "view", pr, "--json", "mergeable,mergeStateStatus"], bound());
    mrc = v.code;
    mg = v.out;
    const c = await gh(["pr", "checks", pr], bound());
    rc = c.code;
    out = c.out;
    const mergeable = mrc === 0 ? mergeableOf(mg) : null;
    if (mergeable === "CONFLICTING") { st = "conflict"; break; }
    if (mergeable === "MERGEABLE") {
      if (rc === 0) { st = "green"; break; }
      if (rc === 1 && !out.includes("no checks reported")) { st = "failed"; break; }
    }
    if (left() <= 0) break;
    await sleep(Math.max(0, Math.min(Number.isFinite(interval) ? interval : 10_000, left())));
  }
  process.stdout.write(`PR ${pr}: ${st} (last exit ${rc ?? "none"})\nmergeable (exit ${mrc ?? "none"}): ${mg}\n${out}\n`);
  return VERDICT[st];
}

process.exitCode = await main(process.argv.slice(2));
