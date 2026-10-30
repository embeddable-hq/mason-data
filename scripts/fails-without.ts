#!/usr/bin/env node
/**
 * WATCH A TEST FAIL WITHOUT ITS FIX (CLAUDE.md "Watch every test fail before you trust it"), mechanically: run test
 * files with `src/` — or the paths given — as they were at a commit, in a COPY of the working tree, and exit 0 only when
 * the tests PASS on the tree and at least one of them FAILED at the commit BY NAME. A test that passes on both says
 * nothing about the fix; one that fails on both is not green yet; a file that does not even LOAD at the commit (an
 * export renamed, a module moved) proves nothing about the behaviour and is its own verdict (the review of #504:
 * `time-axis.test.ts` was PROVED on `does not provide an export named 'assignTimeAxes'`, 0 tests run). Each is reported
 * by name.
 *
 *   scripts/fails-without.ts <commit> <test-file>... [--paths src,sdk/src] [--test-name-pattern <regex>] [--skip-now] [--show]
 *
 *   --paths              the folders (or files) taken from the commit (default: src)
 *   --test-name-pattern  run only the tests whose name matches (Node's own option, repeatable); a subtest runs only
 *                        when its parent's name matches too. It narrows what runs, never what counts as a proof
 *   --skip-now           do not run the tests on the working tree first
 *   --show               print the test runner's whole output, not only its summary lines
 *
 * THE COPY is taken once, before anything runs, so the working tree stays yours to edit, and several runs share it:
 * this used to swap `src/` in place, which blocked both for as long as a run took. It is a linked `git worktree`, not a
 * plain copy, because tests read `.git` (`git ls-files` in tests/conventions.test.ts): they get a repository of their
 * own, at this HEAD with this index, so they see what they would see here and can write nothing back. Every file the
 * index or the tree has is copied as it stands, uncommitted and untracked ones too: a dirty tree is the normal case, the
 * fix being what is uncommitted. What git ignores (node_modules, .env, a built CLI) is linked, not copied, and a nested
 * repository (`.claude/worktrees/` in a main checkout) is left out. Both runs use the copy, so one snapshot is judged.
 *
 * Nothing is committed or stashed, and the working tree and its index are never written. The commit's paths come through
 * `git archive`. The copy is removed whatever happens — a failing test, a thrown error, a signal; a run killed outright
 * leaves its pid beside its copy, and the next run in this repository removes the copy of a pid that is dead.
 *
 * A run that was interrupted has no verdict, only an exit of 130: tests cut short look like tests that failed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate as yieldToSignals } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(problem: string): never {
  console.error(`${problem}\n\nusage: scripts/fails-without.ts <commit> <test-file>... [--paths src,sdk/src] [--test-name-pattern <regex>] [--skip-now] [--show]`);
  process.exit(2);
}

const args = process.argv.slice(2);
let paths = ["src"]; let skipNow = false; let show = false;
const namePatterns: string[] = [];
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--paths") { const v = args[++i]; if (!v) usage("--paths needs a comma-separated list"); paths = v.split(",").map((p) => p.trim()).filter(Boolean); }
  else if (a.startsWith("--paths=")) paths = a.slice("--paths=".length).split(",").map((p) => p.trim()).filter(Boolean);
  else if (a === "--test-name-pattern") { const v = args[++i]; if (!v) usage("--test-name-pattern needs a regular expression"); namePatterns.push(v); }
  else if (a.startsWith("--test-name-pattern=")) namePatterns.push(a.slice("--test-name-pattern=".length));
  else if (a === "--skip-now") skipNow = true;
  else if (a === "--show") show = true;
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else positional.push(a);
}
const [commitArg, ...tests] = positional;
if (!commitArg || tests.length === 0) usage("a commit and at least one test file are needed");
for (const t of tests) if (!fs.existsSync(path.join(ROOT, t))) usage(`${t}: no such file`);
for (const p of paths) {
  if (path.isAbsolute(p) || p.split(path.sep).includes("..")) usage(`${p}: a path is relative to the repository root and inside it`);
  if (!fs.existsSync(path.join(ROOT, p))) usage(`${p}: no such path in the working tree`);
}
let commit: string;
try { commit = execFileSync("git", ["rev-parse", "--verify", `${commitArg}^{commit}`], { cwd: ROOT, encoding: "utf8" }).trim(); }
catch { usage(`${commitArg}: not a commit`); }

interface Run {
  passed: boolean;
  /** the tests that passed and failed, by name (the spec reporter's ✔ / ✖ lines, subtests included) */
  ok: Set<string>; failed: Set<string>;
  /** the test FILES that failed as a whole — the runner names the file when it cannot load it — with the first error */
  unloaded: Map<string, string>;
}
const RESULT = /^\s*([✔✖]) (.*?) \(\d+(?:\.\d+)?ms\)(?: # .*)?$/;
const git = (...a: string[]): string => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

const copyOf = (holder: string): string => path.join(holder, "tree");
function removeCopy(holder: string): string | null {
  const steps: Array<() => void> = [
    () => { if (fs.existsSync(path.join(copyOf(holder), ".git"))) git("worktree", "remove", "--force", copyOf(holder)); },
    () => fs.rmSync(holder, { recursive: true, force: true }),
    () => { git("worktree", "prune"); },
  ];
  const failed: string[] = [];
  // every step runs: a registration the first one could not remove is what the last one is for
  for (const step of steps) {
    try { step(); } catch (e) { failed.push(e instanceof Error ? e.message : String(e)); }
  }
  if (fs.existsSync(holder)) return `${holder} is still there: ${failed.join("; ")}`;
  return git("worktree", "list", "--porcelain").includes(holder) ? `${holder} is still registered: ${failed.join("; ")}` : null;
}
/** The copy of a run that was killed outright. Only of a pid that is dead: the worktrees of a repository are shared by all its checkouts, so a live one may be another session's. */
function removeAbandonedCopies(): void {
  for (const m of git("worktree", "list", "--porcelain").matchAll(/^worktree (.*)$/gm)) {
    const holder = path.dirname(m[1]!);
    if (path.basename(m[1]!) !== "tree" || !path.basename(holder).startsWith("fails-without-")) continue;
    // the pid is written before the copy is registered, so a registered copy with no pid is one the system's tmp cleaner took
    const pid = fs.existsSync(holder) ? Number(fs.readFileSync(path.join(holder, "pid"), "utf8")) : null;
    let dead = pid === null;
    if (pid !== null) {
      try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (!dead) continue;
    const problem = removeCopy(holder);
    if (problem !== null) throw new Error(problem);
    console.log(`[fails-without] removed the copy a killed run left (pid ${pid}): ${holder}`);
  }
}
/** The tree as it stands now, in a repository of its own: this HEAD, this index, every file here as it is here. */
function takeCopy(holder: string): void {
  const copy = copyOf(holder);
  git("worktree", "add", "--quiet", "--detach", "--no-checkout", copy, "HEAD");
  // Its index, so its `git ls-files` and `git status` are this tree's: a file staged here is tracked there
  // (--git-path answers from the folder it is asked in, absolute in a linked worktree and relative in a main checkout)
  fs.copyFileSync(path.resolve(ROOT, git("rev-parse", "--git-path", "index").trim()), path.resolve(copy, execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: copy, encoding: "utf8" }).trim()));
  for (const f of new Set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean))) {
    if (f.endsWith("/")) continue; // a nested repository: not this tree's (.claude/worktrees/ in a main checkout)
    let stat: fs.Stats;
    try { stat = fs.lstatSync(path.join(ROOT, f)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; } // deleted here, so absent there
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(path.join(ROOT, f)), path.join(copy, f));
    else fs.copyFileSync(path.join(ROOT, f), path.join(copy, f));
  }
  for (const f of git("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory").split("\0").filter(Boolean)) {
    const entry = f.replace(/\/$/, "");
    fs.mkdirSync(path.dirname(path.join(copy, entry)), { recursive: true });
    fs.symlinkSync(path.join(ROOT, entry), path.join(copy, entry));
  }
}

/** the test runner over the copy as it is now: what passed and failed, by name */
async function run(label: string): Promise<Run> {
  const names = namePatterns.map((p) => `--test-name-pattern=${p}`);
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...names, ...tests], { cwd: COPY, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  // spawnSync held the event loop, so a signal that came meanwhile is still waiting for its handler: let it run now,
  // before these results are read as a verdict
  await yieldToSignals();
  const out = `${r.stdout}${r.stderr}`;
  if (show) process.stdout.write(out);
  // the runner turns a signal into an exit of 1 and its unfinished tests into failures: never evidence
  if (r.status === null || /^Interrupted while running:/m.test(out)) {
    console.log(`[fails-without] ${label}: interrupted (${r.signal ?? "the test runner stopped early"}), so there is no verdict`);
    process.exit(130);
  }
  const lines = out.split("\n");
  // the spec reporter lists every failure again under "✖ failing tests:"; the first listing is enough
  const end = lines.findIndex((l) => /^✖ failing tests:/.test(l));
  const ok = new Set<string>(), failed = new Set<string>(), unloaded = new Map<string, string>();
  const asFile = (name: string): string | undefined => tests.find((t) => path.resolve(COPY, t) === path.resolve(COPY, name));
  lines.slice(0, end < 0 ? lines.length : end).forEach((l, i) => {
    const m = RESULT.exec(l);
    if (!m) return;
    const file = asFile(m[2]!);
    if (file !== undefined) {
      // a file that cannot load prints its error ABOVE its own ✖ line (the child's stderr, then the reporter's verdict)
      if (m[1] === "✖") unloaded.set(file, lines.slice(Math.max(0, i - 40), i).reverse().find((x) => /^\w*Error\b|^Error \[|error:/.test(x))?.trim() ?? "(no error line; --show prints the runner's output)");
      return;
    }
    (m[1] === "✔" ? ok : failed).add(m[2]!);
  });
  const summary = lines.filter((l) => /^ℹ (tests|pass|fail|cancelled|todo) /.test(l));
  console.log(`[fails-without] ${label}: exit ${r.status ?? `signal ${r.signal}`}${summary.length ? `\n  ${summary.join("\n  ")}` : ""}` +
    [...failed].map((n) => `\n  ✖ ${n}`).join("") + [...unloaded].map(([f, e]) => `\n  ✖ ${f} DID NOT LOAD: ${e}`).join(""));
  return { passed: r.status === 0, ok, failed, unloaded };
}

removeAbandonedCopies();
// real: macOS's tmp is a symlink, and the runner may name a file by the path it resolved
const holder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fails-without-"));
fs.writeFileSync(path.join(holder, "pid"), String(process.pid));
const COPY = copyOf(holder);
let leftBehind: string | null = null;
let removed = false;
function cleanUp(): void {
  if (removed) return;
  removed = true;
  leftBehind = removeCopy(holder);
  if (leftBehind !== null) console.error(`[fails-without] the copy was not removed, whatever the verdict says of the tests: ${leftBehind}`);
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { console.log(`[fails-without] ${s}: no verdict`); process.exit(130); });
process.on("exit", cleanUp);

let now: Run | null = null;
let without: Run;
try {
  takeCopy(holder);
  console.log(`[fails-without] running in a copy of the working tree: ${COPY}`);
  if (!skipNow) {
    now = await run("on the working tree (must pass)");
  }
  // the commit's paths in the copy's: `git archive` writes nothing to any index, and the paths are emptied first so a
  // file the commit lacks does not survive beside the old ones
  const tar = execFileSync("git", ["archive", "--format=tar", commit, "--", ...paths], { cwd: ROOT, maxBuffer: 1 << 30 });
  for (const p of paths) fs.rmSync(path.join(COPY, p), { recursive: true, force: true });
  const x = spawnSync("tar", ["-x", "-C", COPY], { input: tar, stdio: ["pipe", "inherit", "inherit"] });
  if (x.status !== 0) throw new Error(`tar exited ${x.status}: the commit's ${paths.join(", ")} could not be unpacked`);
  without = await run(`with ${paths.join(", ")} at ${commit.slice(0, 10)} (must fail)`);
} finally {
  cleanUp();
}

// PROVED: green here, every file loaded there, and a test that passes here failed there by name (with --skip-now, any
// named test failed there)
const detected = [...without.failed].filter((n) => now === null || now.ok.has(n));
const verdict = now !== null && !now.passed ? "NOT GREEN"
  : without.unloaded.size > 0 ? "DID NOT LOAD"
  : detected.length > 0 ? "PROVED"
  : "NOT A DETECTOR";
const at = `${paths.join(", ")} at ${commitArg}`;
const ranNothing = namePatterns.length > 0 && without.ok.size + without.failed.size === 0 && (now === null || now.ok.size + now.failed.size === 0);
console.log(`[fails-without] ${verdict}: ` + ({
  PROVED: `${detected.length} test(s) that pass on the working tree fail with ${at}:${detected.map((n) => `\n  - ${n}`).join("")}`,
  "NOT GREEN": `${tests.join(" ")} fail(s) on the working tree — fix it first, or --skip-now to judge the old code alone`,
  "DID NOT LOAD": `${[...without.unloaded.keys()].join(", ")} cannot be loaded with ${at}, so no test in it ran: that is an import the commit lacks, ` +
    `not the behaviour. Test the behaviour through names the commit has (or swap fewer --paths)`,
  "NOT A DETECTOR": ranNothing ? `--test-name-pattern matched no test, so nothing ran (a subtest runs only when its parent's name matches too)`
    : `nothing that passes here fails with ${at}: the tests do not detect what the commit lacked`,
} as Record<string, string>)[verdict]);
process.exit(verdict === "PROVED" && leftBehind === null ? 0 : 1);
