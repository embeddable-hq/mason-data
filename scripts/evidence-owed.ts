#!/usr/bin/env node
/**
 * WHAT A REVIEW OWES, PATH BY PATH (issue 286). A path the engine or the listener answers through owes SQL statements,
 * the rest owe checks (CLAUDE.md "The loop", step 3). A path two subsystems share (in an engine or listener rules
 * file's `paths:` AND in cli.md's or web-ui.md's, such as src/cli/dev.ts) is decided by its HUNKS: a hunk reaches the
 * engine when a name on a changed line resolves, through TypeScript's checker (aliases followed), to a declaration in
 * a path that owes statements; added lines are resolved in the head's tree, removed ones in the base's. A shared path
 * with no such hunk owes checks; anything this cannot settle owes statements, never checks.
 *
 *   node scripts/evidence-owed.ts <base> <head>      run in a checkout holding both commits
 *
 * Prints one JSON line a changed path (`git diff --no-renames`): {path, owes: "statements"|"checks", why}, and for a
 * shared path that reaches the engine the line and the declaring file. Exit 0 then; 2 for a wrong command line or a
 * commit that is not there, 1 when the diff could not be read or a temp worktree not removed, with no line printed for
 * a path it could not decide. It reads the rules files at <head>, and writes only under the system temp dir.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";

/** The `paths:` globs of a rules file's front matter: the one reader of them (the workflows' lists are held to it). */
export function globsOf(text: string): string[] {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!front) throw new Error("no front matter");
  return [...front[1]!.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]!);
}
/** A `paths:` glob as Claude Code reads it: `**` any run of characters, `*` any within one path segment. */
export const globRe = (g: string): RegExp =>
  new RegExp(`^${g.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
/** The engine's and the listener's rules files, and the CLI's and the web page's. */
export const ENGINE_RULES = /^duck-.*\.md$|^postgres-api\.md$/;
export const HOST_RULES = ["cli.md", "web-ui.md"];
/** From the rules files' names and a reader: the globs that owe statements (+ src/cdc/**, which no rules file covers)
 * and the globs of the CLI and the web page. */
export function authority(files: string[], read: (file: string) => string): { statement: string[]; host: string[] } {
  const statement = [...new Set([...files.filter((f) => ENGINE_RULES.test(f)).flatMap((f) => globsOf(read(f))), "src/cdc/**"])];
  const host = HOST_RULES.filter((f) => files.includes(f)).flatMap((f) => globsOf(read(f)));
  return { statement, host };
}

type Owed = { path: string; owes: "statements" | "checks"; why: string; line?: string; declaredIn?: string };
type Hit = { line: number; text: string; declaredIn: string };
const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });

/** The first name on one of `lines` (1-based) of `rel` in `tree` that the checker resolves to a declaration in another
 * file that `owes` statements, or null. Throws when the file cannot be loaded or parsed: the caller says it could not tell. */
function reach(tree: string, rel: string, lines: Set<number>, owes: (p: string) => boolean): Hit | null {
  if (lines.size === 0) return null;
  const file = path.join(tree, rel);
  let options: ts.CompilerOptions = { allowImportingTsExtensions: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 };
  const cfg = ts.readConfigFile(path.join(tree, "tsconfig.json"), ts.sys.readFile);
  if (!cfg.error) options = ts.parseJsonConfigFileContent(cfg.config, ts.sys, tree).options;
  const program = ts.createProgram([file], { ...options, noEmit: true, skipLibCheck: true });
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`could not load ${rel}`);
  const bad = program.getSyntacticDiagnostics(sf)[0];
  if (bad) throw new Error(`could not parse ${rel}: ${ts.flattenDiagnosticMessageText(bad.messageText, " ")}`);
  const checker = program.getTypeChecker();
  let hit: Hit | null = null;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    const named = ts.isIdentifier(n) || ts.isPrivateIdentifier(n)
      || (ts.isStringLiteral(n) && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)));
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    if (named && lines.has(line)) {
      let s = checker.getSymbolAtLocation(n);
      if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
      for (const d of s?.declarations ?? []) {
        const at = path.relative(tree, d.getSourceFile().fileName).split(path.sep).join("/");
        if (at !== rel && !at.startsWith("../") && owes(at)) {
          hit = { line, text: sf.text.split("\n")[line - 1]!.trim(), declaredIn: at };
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit;
}

/** The lines `git diff -U0` says changed: removed ones numbered in the base, added ones in the head. */
function changedLines(base: string, head: string, rel: string): { removed: Set<number>; added: Set<number> } {
  const removed = new Set<number>();
  const added = new Set<number>();
  for (const m of git(["diff", "-U0", "--no-renames", "--no-color", base, head, "--", rel]).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [a, b, c, d] = [m[1], m[2] ?? "1", m[3], m[4] ?? "1"].map(Number) as [number, number, number, number];
    for (let i = 0; i < b; i++) removed.add(a + i);
    for (let i = 0; i < d; i++) added.add(c + i);
  }
  return { removed, added };
}

function main(argv: string[]): number {
  const [baseArg, headArg] = argv;
  if (!baseArg || !headArg || argv.length !== 2) { console.error("usage: node scripts/evidence-owed.ts <base> <head>"); return 2; }
  const shaOf = (x: string): string | null => {
    try { return git(["rev-parse", "--verify", "--quiet", `${x}^{commit}`]).trim(); } catch { return null; } // its exit is the verdict, said below
  };
  const [base, head] = [shaOf(baseArg), shaOf(headArg)];
  if (!base || !head) { console.error(`evidence-owed: ${!base ? baseArg : headArg} is not a commit in this checkout: fetch it first`); return 2; }
  const rules = git(["ls-tree", "--name-only", head, ".claude/rules/"]).split("\n").filter(Boolean).map((f) => path.posix.basename(f));
  const { statement, host } = authority(rules, (f) => git(["show", `${head}:.claude/rules/${f}`]));
  const owes = (p: string) => statement.some((g) => globRe(g).test(p));
  const shared = (p: string) => owes(p) && host.some((g) => globRe(g).test(p));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "evidence-owed-")));
  const trees = new Map<string, string>();
  const modules = path.join(git(["rev-parse", "--show-toplevel"]).trim(), "node_modules");
  const treeOf = (sha: string): string => {
    const known = trees.get(sha);
    if (known) return known;
    const dir = path.join(tmp, `t${trees.size}`);
    git(["worktree", "add", "--detach", "--quiet", dir, sha]);
    trees.set(sha, dir);
    if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(dir, "node_modules"));
    return dir;
  };
  let code = 0;
  try {
    for (const entry of git(["diff", "--no-renames", "--name-status", base, head]).split("\n").filter(Boolean)) {
      const [status = "", p = ""] = entry.split("\t");
      const say = (o: Omit<Owed, "path">) => console.log(JSON.stringify({ path: p, ...o }));
      if (!owes(p)) { say({ owes: "checks", why: "not an engine or listener path" }); continue; }
      if (!shared(p)) { say({ owes: "statements", why: "an engine or listener path: any change owes statements" }); continue; }
      if (status !== "M") { say({ owes: "statements", why: `a shared path ${status === "A" ? "added" : status === "D" ? "deleted" : `changed (${status})`}: could not tell which hunks reach the engine` }); continue; }
      if (!p.endsWith(".ts")) { say({ owes: "statements", why: "a shared path that is not TypeScript: could not tell which hunks reach the engine" }); continue; }
      try {
        const { removed, added } = changedLines(base, head, p);
        const atHead = reach(treeOf(head), p, added, owes);
        const hit = atHead ?? reach(treeOf(base), p, removed, owes);
        if (hit) say({ owes: "statements", why: `a shared path whose ${atHead ? "added" : "removed"} line ${hit.line} names a declaration of ${hit.declaredIn}`, line: hit.text, declaredIn: hit.declaredIn });
        else say({ owes: "checks", why: "a shared path whose changed lines name no declaration of an engine or listener path" });
      } catch (e) {
        say({ owes: "statements", why: `a shared path: could not tell which hunks reach the engine (${e instanceof Error ? e.message : String(e)})` });
      }
    }
  } catch (e) {
    console.error(`evidence-owed: could not read the diff ${base}..${head}: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    for (const dir of trees.values()) {
      try { git(["worktree", "remove", "--force", dir]); } catch (e) { console.error(`evidence-owed: could not remove the worktree ${dir}: ${e instanceof Error ? e.message : String(e)}`); code = 1; }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === url.fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
