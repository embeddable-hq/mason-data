#!/usr/bin/env node
/**
 * MERGE A PR's BASE INTO ITS BRANCH, IN THE WORKTREE IT RUNS IN (issue 452: a run whose PR GitHub reads CONFLICTING).
 *
 *   node scripts/merge-base.ts <ref> [<trailer>]
 *
 * It runs `git merge --no-ff --no-commit <ref>` in its working directory and reads what conflicted from git's INDEX
 * (the unmerged stages, `git diff --name-only --diff-filter=U`), never from merge's printed text.
 *
 * - No conflict: the merge is committed as it is.
 * - The ONLY unmerged path is release-notes/next.md, the file every product PR adds a line to, and every conflict hunk
 *   in it is an insertion on both sides (the common ancestor's part of the hunk is empty, read from
 *   `git merge-file --diff3` over the stages :1, :2 and :3): the file is resolved by keeping both sides, ours then
 *   theirs, as `git merge-file --union` does, checked to hold no conflict marker, staged, and committed.
 * - A next.md hunk where both sides edited the SAME base lines is not "both sides added notes": a union there would ship
 *   two versions of one bullet, so it is a conflict like any other file.
 * - Any other unmerged path: `git merge --abort`, the tree verified clean and HEAD unchanged, and the paths printed.
 *   next.md is never resolved on its own while anything else conflicts.
 * - The branch already holds <ref>: nothing to merge, no commit.
 *
 * The commit's message is `Merge <ref> into the branch`, a line saying release-notes/next.md kept both sides when it
 * did, and <trailer> as its last line. It never pushes: the caller pushes, and the pushed head is the authority.
 *
 * Exit codes are the verdicts, and never Node's own 1: 0 merged (committed; first line `merged: <sha>`, then a
 * `resolved: <path> (kept both sides)` line for each file it resolved), 4 conflict (first line
 * `conflict: <path> <path>…`, the merge aborted), 5 up to date (first line `up to date: …`, nothing committed), 2 usage
 * (no ref, too many arguments, or a ref that does not resolve to a commit). Any other exit (1 is a git call that failed,
 * with git's message, or an uncaught error) is "couldn't tell".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERDICT = { merged: 0, conflict: 4, upToDate: 5, usage: 2 } as const;
/** The file whose both-sides insertions are resolved by keeping both. */
const NOTES = "release-notes/next.md";
/** Conflict markers longer than any line a release note holds, so a `=======` in the notes is never read as one. */
const MARKER = 41;

class GitFailed extends Error {}

type Ran = { status: number; out: string; err: string };
/** `git <args>` in the working directory. A git that could not start, or was killed, is a failure, never a status. */
function git(args: string[], input?: string): Ran {
  const r = spawnSync("git", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } });
  if (r.error) throw new GitFailed(`git ${args.join(" ")}: ${r.error.message}`);
  if (r.status === null) throw new GitFailed(`git ${args.join(" ")}: killed by ${r.signal}`);
  return { status: r.status, out: r.stdout, err: r.stderr };
}
/** `git <args>` that must exit 0; its stdout. */
function gitOk(args: string[], input?: string): string {
  const r = git(args, input);
  if (r.status !== 0) throw new GitFailed(`git ${args.join(" ")} exited ${r.status}: ${(r.err || r.out).trim()}`);
  return r.out;
}
const head = (): string => gitOk(["rev-parse", "HEAD"]).trim();
const merging = (): boolean => {
  const r = git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new GitFailed(`git rev-parse -q --verify MERGE_HEAD exited ${r.status}: ${r.err.trim()}`);
};
/** Tracked changes, staged or not; untracked files are not the merge's. */
const dirty = (): string => gitOk(["status", "--porcelain", "--untracked-files=no"]).trim();
/** The unmerged paths, from the index, NUL-separated so no path is misread. */
const unmerged = (): string[] => gitOk(["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);

/** A stage of `file` in the index (1 the ancestor, 2 ours, 3 theirs), or null when the index has none. */
function stage(n: 1 | 2 | 3, file: string): string | null {
  // `<mode> <sha> <stage>\t<path>` an entry: an add/add has no stage 1, a modify/delete no stage 2 or 3
  const stages = gitOk(["ls-files", "-u", "-z", "--", file]).split("\0").filter(Boolean).map((e) => e.split("\t")[0]!.split(" ")[2]);
  return stages.includes(String(n)) ? gitOk(["cat-file", "blob", `:${n}:${file}`]) : null;
}

/** `git merge-file -p <flag>` over three texts, through files of a temp dir of its own; its stdout and exit code. */
function mergeFile(flag: string, ours: string, base: string, theirs: string): Ran {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-base-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => path.join(dir, n)) as [string, string, string];
    fs.writeFileSync(o, ours);
    fs.writeFileSync(b, base);
    fs.writeFileSync(t, theirs);
    const r = git(["merge-file", "-p", flag, `--marker-size=${MARKER}`, "-L", "ours", "-L", "base", "-L", "theirs", o, b, t]);
    // its exit is the number of conflicts (capped at 127); a negative one (255 here) is an error
    if (r.status > 127) throw new GitFailed(`git merge-file ${flag} exited ${r.status}: ${r.err.trim()}`);
    return r;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** next.md kept both sides, or null when a hunk is not an insertion on both sides (or a side is absent). */
function unionOfNotes(): string | null {
  const ours = stage(2, NOTES), theirs = stage(3, NOTES);
  if (ours === null || theirs === null) return null;
  const base = stage(1, NOTES) ?? "";
  // every conflict hunk's ancestor part, between its `|||||||` and `=======` markers, must be empty
  const open = "<".repeat(MARKER), anc = "|".repeat(MARKER), mid = "=".repeat(MARKER), close = ">".repeat(MARKER);
  let where: "out" | "ours" | "base" | "theirs" = "out";
  let hunks = 0;
  for (const line of mergeFile("--diff3", ours, base, theirs).out.split("\n")) {
    if (line.startsWith(open)) { if (where !== "out") return null; where = "ours"; hunks++; }
    else if (line.startsWith(anc)) { if (where !== "ours") return null; where = "base"; }
    else if (line === mid) { if (where !== "base") return null; where = "theirs"; }
    else if (line.startsWith(close)) { if (where !== "theirs") return null; where = "out"; }
    else if (where === "base") return null;
  }
  if (where !== "out" || hunks === 0) return null;
  const merged = mergeFile("--union", ours, base, theirs);
  if (merged.status !== 0) return null;
  // no conflict marker is left, of git's default size or ours
  if (/^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(merged.out)) return null;
  return merged.out;
}

/** Aborts the merge and holds the tree to what it was: no merge in progress, HEAD unchanged, nothing changed. */
function abort(before: string): void {
  gitOk(["merge", "--abort"]);
  const wrong = [merging() ? "a merge is still in progress" : "", head() !== before ? `HEAD moved from ${before.slice(0, 7)}` : "", dirty() ? `the tree has changes:\n${dirty()}` : ""].filter(Boolean);
  if (wrong.length) throw new GitFailed(`after git merge --abort, ${wrong.join("; ")}`);
}

function main(argv: string[]): number {
  const [ref, trailer, ...extra] = argv;
  if (!ref || extra.length || ref.startsWith("-")) {
    process.stderr.write("usage: node scripts/merge-base.ts <ref> [<trailer>]: merges <ref> (e.g. origin/main) into HEAD, in this worktree; it never pushes\n");
    return VERDICT.usage;
  }
  const resolved = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (resolved.status !== 0) {
    process.stderr.write(`merge-base: ${ref} does not resolve to a commit (fetch it first: git fetch origin <branch>)${resolved.err.trim() ? `: ${resolved.err.trim()}` : ""}\n`);
    return VERDICT.usage;
  }
  if (merging()) throw new GitFailed("a merge is already in progress here: finish or abort it first");
  if (dirty()) throw new GitFailed(`the tree has changes, which a merge could mix with its own:\n${dirty()}`);
  const before = head();
  const ancestor = git(["merge-base", "--is-ancestor", ref, "HEAD"]);
  if (ancestor.status === 0) {
    process.stdout.write(`up to date: HEAD ${before.slice(0, 7)} already holds ${ref}\n`);
    return VERDICT.upToDate;
  }
  if (ancestor.status !== 1) throw new GitFailed(`git merge-base --is-ancestor exited ${ancestor.status}: ${ancestor.err.trim()}`);

  const m = git(["merge", "--no-ff", "--no-commit", ref]);
  if (!merging()) throw new GitFailed(`git merge exited ${m.status} and started no merge: ${(m.err || m.out).trim()}`);
  const resolvedFiles: string[] = [];
  const paths = unmerged();
  if (m.status !== 0 && paths.length === 0) {
    abort(before);
    throw new GitFailed(`git merge exited ${m.status} with no unmerged path (merge aborted): ${(m.err || m.out).trim()}`);
  }
  if (paths.length) {
    const union = paths.length === 1 && paths[0] === NOTES ? unionOfNotes() : null;
    if (union === null) {
      abort(before);
      process.stdout.write(`conflict: ${paths.join(" ")}\nthe merge of ${ref} was aborted; HEAD is ${before.slice(0, 7)} and the tree is clean\n`);
      return VERDICT.conflict;
    }
    fs.writeFileSync(NOTES, union);
    gitOk(["add", "--", NOTES]);
    resolvedFiles.push(NOTES);
    const left = unmerged();
    if (left.length) throw new GitFailed(`still unmerged after resolving ${NOTES}: ${left.join(" ")}`);
  }
  const message = [`Merge ${ref} into the branch`, ...(resolvedFiles.length ? ["", `${NOTES}: kept both sides, this branch's notes then ${ref}'s, as every conflict in it was an insertion on both sides.`] : []), ...(trailer ? ["", trailer] : [])].join("\n");
  gitOk(["commit", "-q", "--no-verify", "-F", "-"], `${message}\n`);
  const sha = head();
  const parents = gitOk(["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").length - 1;
  if (parents !== 2) throw new GitFailed(`the commit ${sha.slice(0, 7)} has ${parents} parent(s), not 2`);
  if (dirty()) throw new GitFailed(`the tree has changes after the merge commit:\n${dirty()}`);
  process.stdout.write(`merged: ${sha}\n${resolvedFiles.map((f) => `resolved: ${f} (kept both sides)\n`).join("")}`);
  return VERDICT.merged;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`merge-base: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
