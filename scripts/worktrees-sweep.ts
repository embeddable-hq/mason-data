#!/usr/bin/env node
/**
 * THE WORKTREES SWEEP (issue 852): removes each agent's worktree under `.claude/worktrees/` once its work is on GitHub
 * and done with, so they do not pile up (48 of them, about 9 GB, were once removed by hand).
 *
 *   node scripts/worktrees-sweep.ts        (from any checkout of the repository)
 *
 * Run by hand, or started in the background after a merge by scripts/hooks/worktrees-sweep-after-merge.ts.
 *
 * A worktree is removed only when ALL hold, and is otherwise KEPT and said with why:
 * - it is under `<the main checkout>/.claude/worktrees/` (its real path) and `git worktree list` lists it; nothing else
 *   is ever looked at, so no path is removed by a pattern;
 * - it is not locked, or its lock is a stale one of Claude Code's (below);
 * - no live process has its working directory inside it (an agent, a shell or a test still there);
 * - no tracked file has an uncommitted change (an untracked file makes `git worktree remove` refuse: kept too);
 * - its work is done: its HEAD is already in origin/main, or the PR of its branch (`gh api` REST, since a cloud
 *   session reaches no GraphQL) is merged or closed, and none of its branch's PRs is open;
 * - no commit of it is off GitHub: every commit is on a remote ref, or HEAD is the PR's head, which GitHub keeps as
 *   `refs/pull/<n>/head` after the branch is deleted (a squash merge with --delete-branch, then a `fetch --prune`,
 *   leaves the commits on no remote-tracking ref).
 * Removing is `git worktree remove` (never --force), then `git branch -D` of its branch, then one `git worktree prune`.
 *
 * LOCKS. Claude Code locks an agent's worktree while the agent runs, with the reason `claude agent <name> (pid <pid>
 * start <ticks>)`: the Claude Code process and its start time (`/proc/<pid>/stat` field 22), and unlocks it when the
 * agent ends. Such a lock whose process is alive with that start time is a running agent: kept. One whose process is
 * gone, or whose pid now names another process (a start time that differs: the machine restarted), is stale: the
 * worktree goes on to the other checks, and is unlocked just before it is removed. Where the start time cannot be read
 * (not Linux), a live pid keeps it. Any other lock (a person's, or one with no reason) keeps it.
 *
 * LIVE PROCESSES. On Linux, every `/proc/<pid>/cwd`; elsewhere `lsof -d cwd`. A process whose cwd the kernel will not
 * show this user (EACCES: another user's, or one that made itself non-dumpable: a setuid program, ssh-agent, a sandbox's
 * init, a CI runner's worker) is passed over: an agent, its shells, git, node and the tests are plain processes of this
 * user, which can always be read, and failing closed on such a process kept every worktree on a GitHub runner and in a
 * cloud container. Any other failure to read, or a listing that fails, is "cannot tell", and keeps every worktree.
 *
 * FAILS CLOSED: a check that cannot tell (git or gh failing, an answer that does not parse) keeps the worktree. Two
 * sweeps never run at once (a lock in the common git dir), and every `git worktree` call is made under the lock
 * scripts/fails-without.ts holds around its own (scripts/worktree-lock.ts).
 *
 * Prints one line per worktree (`removed <name>: <why>` or `kept <name>: <reason>`) and a total. Exit 0 when the sweep
 * ran, whatever it kept; 1 when it could not run at all (not in a repository, no worktree list).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { underLock } from "./worktree-lock.ts";

interface Worktree { path: string; head: string; branch: string | undefined; locked: string | undefined; prunable: boolean }
interface Pull { number: number; state: string; merged_at: string | null; head: { sha: string } }
type Verdict = { remove: true; why: string; unlock: boolean } | { remove: false; reason: string };

/** The message of a failed child process, its stderr first, on one line. */
function failure(e: unknown): string {
  const err = e as { stderr?: Buffer | string; message?: string };
  const text = String(err.stderr ?? "").trim() || String(err.message ?? e);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function run(cmd: string, args: string[], cwd: string, timeout = 60_000): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGKILL" });
}

/** `git worktree list --porcelain`, parsed; the first is the main checkout. */
function worktrees(cwd: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of run("git", ["worktree", "list", "--porcelain"], cwd).split("\n\n")) {
    const lines = block.split("\n").filter((l) => l !== "");
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (wt === undefined) continue;
    const field = (name: string): string | undefined => {
      const l = lines.find((x) => x === name || x.startsWith(`${name} `));
      return l === undefined ? undefined : l.slice(name.length + 1);
    };
    const branch = field("branch");
    out.push({
      path: wt.slice("worktree ".length),
      head: field("HEAD") ?? "",
      branch: branch?.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : undefined,
      locked: field("locked"),
      prunable: field("prunable") !== undefined,
    });
  }
  return out;
}

/** `owner/repo` of the origin remote: the URL's last two path segments, `.git` dropped. */
function repository(cwd: string): string | undefined {
  const url = run("git", ["remote", "get-url", "origin"], cwd).trim();
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m === null ? undefined : `${m[1]}/${m[2]}`;
}

/** The start time of a process in clock ticks (`/proc/<pid>/stat` field 22), or undefined where it cannot be read. */
function startTicks(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    // Narrow by construction: no such process, or no /proc (not Linux); the caller treats both as "not known".
    return undefined;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const CLAUDE_LOCK = /^claude agent \S+ \(pid (\d+) start (\d+)\)$/;

/** Undefined when the lock lets the sweep go on (a stale one of Claude Code's), else why the worktree is kept. */
function lockKeeps(reason: string): string | undefined {
  const m = CLAUDE_LOCK.exec(reason);
  if (m === null) return `locked${reason === "" ? " (no reason given)" : `: ${reason}`}; unlock it by hand if it is done with`;
  const pid = Number(m[1]);
  if (!alive(pid)) return undefined;
  const start = startTicks(pid);
  if (start === undefined && process.platform === "linux") return undefined; // gone between the two reads
  if (start === undefined) return `locked by a Claude Code agent whose process (pid ${pid}) is alive, and its start time cannot be read here`;
  return start === m[2] ? `locked by a running Claude Code agent (pid ${pid})` : undefined;
}

/** Every live process's working directory, or a string saying why they cannot be known. */
function processCwds(): { pid: number; cwd: string }[] | string {
  const out: { pid: number; cwd: string }[] = [];
  if (fs.existsSync("/proc/self/cwd")) {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        out.push({ pid: Number(name), cwd: fs.readlinkSync(`/proc/${name}/cwd`) });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") continue; // it ended while the list was read
        if (code === "EACCES" || code === "EPERM") continue; // hidden from this user: no agent's process (the header)
        return `the working directory of process ${name} cannot be read (${code ?? String(e)})`;
      }
    }
    return out;
  }
  let text: string;
  try {
    text = run("lsof", ["-n", "-P", "-d", "cwd", "-F", "pn"], process.cwd());
  } catch (e) {
    // lsof exits 1 when it warns about a process it cannot read, with the rest listed: what it printed is used
    text = String((e as { stdout?: string }).stdout ?? "");
    if (!/^n/m.test(text)) return `lsof could not list the processes' working directories: ${failure(e)}`;
  }
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== process.pid) out.push({ pid, cwd: line.slice(1) });
  }
  return out.length > 0 ? out : "lsof listed no process's working directory";
}

const short = (sha: string): string => sha.slice(0, 7);

function verdict(wt: Worktree, ctx: { slug: string | undefined; cwds: { pid: number; cwd: string }[] | string; hasMain: boolean }): Verdict {
  const real = fs.realpathSync(wt.path);
  if (wt.locked !== undefined) {
    const keeps = lockKeeps(wt.locked);
    if (keeps !== undefined) return { remove: false, reason: keeps };
  }
  if (typeof ctx.cwds === "string") return { remove: false, reason: `cannot tell whether a process works in it: ${ctx.cwds}` };
  const live = ctx.cwds.filter((p) => p.cwd === real || p.cwd.startsWith(real + path.sep));
  if (live.length > 0) return { remove: false, reason: `a live process works in it (pid ${live.map((p) => p.pid).join(", ")})` };

  let dirty: string;
  try { dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], real); } catch (e) {
    return { remove: false, reason: `git status failed: ${failure(e)}` };
  }
  const changed = dirty.split("\n").filter((l) => l !== "").length;
  if (changed > 0) return { remove: false, reason: `${changed} tracked file(s) with uncommitted changes` };

  let done: string | undefined;
  let prHead: string | undefined;
  if (ctx.hasMain) {
    try { run("git", ["merge-base", "--is-ancestor", wt.head, "refs/remotes/origin/main"], real); done = `its HEAD ${short(wt.head)} is in origin/main`; } catch (e) {
      // exit 1 is "not an ancestor"; anything else is git failing, which cannot tell
      if ((e as { status?: number }).status !== 1) return { remove: false, reason: `git merge-base failed: ${failure(e)}` };
    }
  }
  if (done === undefined) {
    if (wt.branch === undefined) return { remove: false, reason: "a detached HEAD not in origin/main: no branch to look its PR up by" };
    if (ctx.slug === undefined) return { remove: false, reason: "the origin remote names no GitHub repository to look its PR up in" };
    const owner = ctx.slug.split("/")[0]!;
    let pulls: Pull[];
    try {
      const body: unknown = JSON.parse(run("gh", ["api", `repos/${ctx.slug}/pulls?head=${encodeURIComponent(`${owner}:${wt.branch}`)}&state=all`], real));
      if (!Array.isArray(body) || body.some((p) => typeof p?.number !== "number" || typeof p?.state !== "string" || typeof p?.head?.sha !== "string")) {
        return { remove: false, reason: "the PR lookup answered something that is not a list of PRs" };
      }
      pulls = body as Pull[];
    } catch (e) {
      return { remove: false, reason: `the PR lookup failed: ${failure(e)}` };
    }
    if (pulls.length === 0) return { remove: false, reason: `no PR for its branch ${wt.branch}, and its HEAD is not in origin/main` };
    const open = pulls.find((p) => p.state === "open");
    if (open !== undefined) return { remove: false, reason: `its PR #${open.number} is open` };
    const latest = pulls.reduce((a, b) => (b.number > a.number ? b : a));
    done = `its PR #${latest.number} is ${latest.merged_at ? "merged" : "closed"}`;
    prHead = latest.head.sha;
  }

  if (prHead !== wt.head) {
    let off: string;
    // the PR's head, when this clone has it, is on GitHub too: the commits past it are what is off GitHub
    let known = false;
    if (prHead !== undefined) {
      try { run("git", ["cat-file", "-e", `${prHead}^{commit}`], real); known = true; } catch { known = false; /* not fetched here: only the remote refs count */ }
    }
    try { off = run("git", ["rev-list", wt.head, "--not", "--remotes", ...(known ? [prHead!] : [])], real); } catch (e) {
      return { remove: false, reason: `git rev-list failed: ${failure(e)}` };
    }
    const n = off.split("\n").filter((l) => l !== "").length;
    if (n > 0) return { remove: false, reason: `${n} commit(s) on no remote ref, and HEAD ${short(wt.head)} is not its PR's head` };
  }
  return { remove: true, why: done, unlock: wt.locked !== undefined };
}

function sweep(common: string): number {
  let all: Worktree[];
  try {
    all = worktrees(process.cwd());
  } catch (e) {
    process.stderr.write(`worktrees-sweep: git cannot list the worktrees, nothing swept: ${failure(e)}\n`);
    return 1;
  }
  const main = all[0];
  if (main === undefined) { process.stderr.write("worktrees-sweep: git listed no worktree, nothing swept\n"); return 1; }
  const dirAbs = path.join(main.path, ".claude", "worktrees");
  if (!fs.existsSync(dirAbs)) { process.stdout.write(`swept ${dirAbs}: 0 removed, 0 kept (no such folder)\n`); return 0; }
  const dir = fs.realpathSync(dirAbs);
  const mine = all.slice(1).filter((w) => !w.prunable && fs.existsSync(w.path) && fs.realpathSync(w.path).startsWith(dir + path.sep));
  if (mine.length === 0) { process.stdout.write(`swept ${dir}: 0 removed, 0 kept (no worktree in it)\n`); return 0; }

  let slug: string | undefined;
  try { slug = repository(main.path); } catch (e) {
    process.stdout.write(`the origin remote cannot be read, so no PR is looked up: ${failure(e)}\n`);
    slug = undefined;
  }
  let hasMain = true;
  try { run("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], main.path); } catch { hasMain = false; /* no origin/main ref: only the PRs decide */ }
  const gitLock = path.join(common, "fails-without-worktrees.lock");
  const worktreeCall = (...args: string[]): string => underLock(gitLock, () => run("git", ["worktree", ...args], main.path));

  let removed = 0;
  for (const wt of mine) {
    const name = path.relative(dir, fs.realpathSync(wt.path));
    let v: Verdict;
    // the processes are read for each worktree, just before its verdict, so an agent started since the sweep began is seen
    try { v = verdict(wt, { slug, cwds: processCwds(), hasMain }); } catch (e) { v = { remove: false, reason: `a check failed: ${failure(e)}` }; }
    if (!v.remove) { process.stdout.write(`kept ${name}: ${v.reason}\n`); continue; }
    try {
      if (v.unlock) worktreeCall("unlock", wt.path);
      worktreeCall("remove", wt.path);
    } catch (e) {
      process.stdout.write(`kept ${name}: ${v.why}, but git worktree would not remove it: ${failure(e)}\n`);
      continue;
    }
    removed++;
    let branch = "";
    if (wt.branch !== undefined) {
      try { run("git", ["branch", "-D", wt.branch], main.path); branch = `, branch ${wt.branch} deleted`; } catch (e) {
        branch = `, its branch ${wt.branch} kept: ${failure(e)}`;
      }
    }
    process.stdout.write(`removed ${name}: ${v.why}${branch}\n`);
  }
  try { worktreeCall("prune"); } catch (e) { process.stdout.write(`git worktree prune failed: ${failure(e)}\n`); }
  process.stdout.write(`swept ${dir}: ${removed} removed, ${mine.length - removed} kept\n`);
  return 0;
}

const common = (() => {
  try { return path.resolve(run("git", ["rev-parse", "--git-common-dir"], process.cwd()).trim()); } catch (e) {
    process.stderr.write(`worktrees-sweep: not in a git repository, nothing swept: ${failure(e)}\n`);
    process.exit(1);
  }
})();
process.stdout.write(`worktrees-sweep at ${new Date().toISOString()} (pid ${process.pid})\n`);
process.exitCode = underLock(path.join(common, "worktrees-sweep.lock"), () => sweep(common), { waitMs: 300_000 });
