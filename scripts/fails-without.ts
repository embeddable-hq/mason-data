#!/usr/bin/env node
/**
 * WATCH A TEST FAIL WITHOUT ITS FIX (CLAUDE.md "Watch every test fail before you trust it"), mechanically: run test
 * files with `src/` — or the paths given — as they were at a commit, put the working tree back, and exit 0 only when
 * the tests PASS here and at least one of them FAILED there BY NAME. A test that passes on both says nothing about the
 * fix; one that fails on both is not green yet; a file that does not even LOAD at the commit (an export renamed, a
 * module moved) proves nothing about the behaviour and is its own verdict (the review of #504: `time-axis.test.ts`
 * was PROVED on `does not provide an export named 'assignTimeAxes'`, 0 tests run). Each is reported by name.
 *
 *   scripts/fails-without.ts <commit> <test-file>... [--paths src,sdk/src] [--skip-now] [--show]
 *
 *   --paths     the folders taken from the commit (default: src)
 *   --skip-now  do not run the tests on the working tree first
 *   --show      print the test runner's whole output, not only its summary lines
 *
 * The paths come from the commit through `git archive` (the index is never touched); the working tree's copies are
 * kept in a temp folder and restored whatever happens — a failing test, a thrown error, a signal. Nothing is committed
 * or stashed: a dirty tree is the normal case, the fix being what is uncommitted. Node's test runner is run as a child
 * so a signal reaches it first; the restore runs when it returns.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(problem: string): never {
  console.error(`${problem}\n\nusage: scripts/fails-without.ts <commit> <test-file>... [--paths src,sdk/src] [--skip-now] [--show]`);
  process.exit(2);
}

const args = process.argv.slice(2);
let paths = ["src"]; let skipNow = false; let show = false;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--paths") { const v = args[++i]; if (!v) usage("--paths needs a comma-separated list"); paths = v.split(",").map((p) => p.trim()).filter(Boolean); }
  else if (a.startsWith("--paths=")) paths = a.slice("--paths=".length).split(",").map((p) => p.trim()).filter(Boolean);
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
  if (!fs.existsSync(path.join(ROOT, p))) usage(`${p}: no such folder in the working tree`);
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
/** the test runner over the working tree as it is now: what passed and failed, by name */
function run(label: string): Run {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...tests], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  const out = `${r.stdout}${r.stderr}`;
  if (show) process.stdout.write(out);
  const lines = out.split("\n");
  // the spec reporter lists every failure again under "✖ failing tests:"; the first listing is enough
  const end = lines.findIndex((l) => /^✖ failing tests:/.test(l));
  const ok = new Set<string>(), failed = new Set<string>(), unloaded = new Map<string, string>();
  const asFile = (name: string): string | undefined => tests.find((t) => path.resolve(ROOT, t) === path.resolve(ROOT, name));
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

const keep = fs.mkdtempSync(path.join(os.tmpdir(), "fails-without-"));
let swapped = false;
let restored = false;
function restore(): void {
  if (!swapped || restored) return;
  restored = true;
  for (const p of paths) {
    fs.rmSync(path.join(ROOT, p), { recursive: true, force: true });
    fs.cpSync(path.join(keep, p), path.join(ROOT, p), { recursive: true });
  }
  fs.rmSync(keep, { recursive: true, force: true });
  console.log(`[fails-without] restored ${paths.join(", ")} from the working tree's copy`);
}
// a signal while the child runs reaches the child first (it shares the group); when spawnSync returns, this restores
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { restore(); process.exit(130); });
process.on("exit", restore);

let now: Run | null = null;
if (!skipNow) {
  now = run("on the working tree (must pass)");
}
// the working tree's copies, then the commit's in their place: `git archive` writes nothing to the index, and the
// folders are emptied first so a file the commit lacks does not survive beside the old ones
for (const p of paths) fs.cpSync(path.join(ROOT, p), path.join(keep, p), { recursive: true });
let without: Run;
try {
  const tar = execFileSync("git", ["archive", "--format=tar", commit, "--", ...paths], { cwd: ROOT, maxBuffer: 1 << 30 });
  swapped = true;
  for (const p of paths) fs.rmSync(path.join(ROOT, p), { recursive: true, force: true });
  const x = spawnSync("tar", ["-x", "-C", ROOT], { input: tar, stdio: ["pipe", "inherit", "inherit"] });
  if (x.status !== 0) throw new Error(`tar exited ${x.status}: the commit's ${paths.join(", ")} could not be unpacked`);
  without = run(`with ${paths.join(", ")} at ${commit.slice(0, 10)} (must fail)`);
} finally {
  restore();
}

// PROVED: green here, every file loaded there, and a test that passes here failed there by name (with --skip-now, any
// named test failed there)
const detected = [...without.failed].filter((n) => now === null || now.ok.has(n));
const verdict = now !== null && !now.passed ? "NOT GREEN"
  : without.unloaded.size > 0 ? "DID NOT LOAD"
  : detected.length > 0 ? "PROVED"
  : "NOT A DETECTOR";
const at = `${paths.join(", ")} at ${commitArg}`;
console.log(`[fails-without] ${verdict}: ` + ({
  PROVED: `${detected.length} test(s) that pass on the working tree fail with ${at}:${detected.map((n) => `\n  - ${n}`).join("")}`,
  "NOT GREEN": `${tests.join(" ")} fail(s) on the working tree — fix it first, or --skip-now to judge the old code alone`,
  "DID NOT LOAD": `${[...without.unloaded.keys()].join(", ")} cannot be loaded with ${at}, so no test in it ran: that is an import the commit lacks, ` +
    `not the behaviour. Test the behaviour through names the commit has (or swap fewer --paths)`,
  "NOT A DETECTOR": `nothing that passes here fails with ${at}: the tests do not detect what the commit lacked`,
} as Record<string, string>)[verdict]);
process.exit(verdict === "PROVED" ? 0 : 1);
