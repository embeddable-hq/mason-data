#!/usr/bin/env node
/**
 * PreToolUse hook (Edit, Write, NotebookEdit, Bash, the GitHub MCP tools that write a file): the coordinator writes no
 * change itself (CLAUDE.md "How work is done here", .claude/skills/coordinate/SKILL.md). A coordinator once wrote five
 * changes itself, each small (a wording asked in chat, merge conflicts, a test after a merge, a workflow), and none was
 * built by an implementer (issue 741). From the TOP session only (a sub-agent's input carries `agent_id`,
 * scripts/hooks/shell.ts `subAgent`), it refuses:
 *
 * - an edit of a file in the repository or its worktrees, except the root CLAUDE.md and `.claude/` outside
 *   `.claude/worktrees/` (the process docs the owner may ask for); a file outside the repository (a scratchpad) is allowed;
 * - a git command that lands a change (commit, push, merge but `--abort`, …), so a shell edit cannot land either; the one
 *   exception is a lone `git commit -m …` in the repository's root whose staged files are all CLAUDE.md or `.claude/`;
 * - the GitHub MCP tools that write a file.
 *
 * A check that cannot tell refuses. Exits 2 with what to do instead.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { block, readInput, simpleCommands, subAgent, type HookInput } from "./shell.ts";

const WAY_OUT = `the coordinator writes no change itself (CLAUDE.md "How work is done here", .claude/skills/coordinate/SKILL.md): start an implementer, or send this to the PR's implementer with SendMessage`;
const MCP_WRITES = new Set(["mcp__github__push_files", "mcp__github__create_or_update_file", "mcp__github__delete_file"]);
/** git subcommands that make or publish a commit; each but push may be withdrawn with `--abort`. */
const LANDS = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am", "apply", "revert"]);
/** git's global options that take the next word as their value. */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

const input = readInput();
if (!subAgent(input)) {
  try {
    check(input);
  } catch (e) {
    // An exit 1 would let the call through (only 2 blocks), so what the hook could not judge refuses.
    block(`${input.tool_name}: the check failed (${(e as Error).message.split("\n")[0]}), so it is refused: ${WAY_OUT}`);
  }
}

function check(input: HookInput): void {
  const tool = input.tool_name;
  if (MCP_WRITES.has(tool ?? "")) block(`${tool} writes a file: ${WAY_OUT}`);
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    const file = tool === "NotebookEdit" ? input.tool_input?.notebook_path : input.tool_input?.file_path;
    const root = repository(input);
    if (typeof file !== "string" || root === undefined) block(`${tool}: could not tell which file or which repository, so it is refused: ${WAY_OUT}`);
    const cwd = typeof input.cwd === "string" ? input.cwd : root;
    const real = realPath(path.resolve(cwd, file));
    if (!allowed(root, real)) block(`${tool} of ${real}: ${WAY_OUT}`);
    return;
  }
  if (tool === "Bash" && typeof input.tool_input?.command === "string") {
    const commands = simpleCommands(input.tool_input.command);
    for (const { argv, text } of commands) {
      if (argv[0]!.replace(/^.*\//, "") !== "git") continue;
      let i = 1;
      while (i < argv.length && argv[i]!.startsWith("-")) i += GIT_VALUED.has(argv[i]!) ? 2 : 1;
      const sub = argv[i];
      if (sub === undefined || !LANDS.has(sub)) continue;
      if (sub !== "push" && argv.includes("--abort")) continue;
      if (sub === "commit" && commands.length === 1 && i === 1 && processOnly(input, text, argv.slice(2))) continue;
      block(`${text} lands a change: ${WAY_OUT}`);
    }
  }
}

/** The repository the session works in: $CLAUDE_PROJECT_DIR, else the input's cwd, its real path; undefined if neither. */
function repository(input: HookInput): string | undefined {
  const dir = process.env["CLAUDE_PROJECT_DIR"] || (typeof input.cwd === "string" ? input.cwd : undefined);
  return dir === undefined || dir === "" ? undefined : realPath(path.resolve(dir));
}

/** The real path of a file that may not exist yet: its nearest existing ancestor resolved, the rest appended. */
function realPath(file: string): string {
  let dir = file;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch (e) {
      // Only a missing part is walked up past; anything else (a permission, a loop) is thrown, and refuses.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
      const parent = path.dirname(dir);
      if (parent === dir) return file;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/** Outside the repository, or the root's CLAUDE.md, or under `.claude/` but not `.claude/worktrees/`. */
function allowed(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return outside || processFile(rel.split(path.sep).join("/"));
}

/** A path relative to the root that is a process doc: CLAUDE.md, or `.claude/…` outside `.claude/worktrees`. */
function processFile(rel: string): boolean {
  if (rel === "CLAUDE.md") return true;
  return rel.startsWith(".claude/") && rel !== ".claude/worktrees" && !rel.startsWith(".claude/worktrees/");
}

/**
 * Whether a lone `git commit` lands process docs only: it is the whole command line, typed as is (no `VAR=` before it),
 * takes only a message and quiet flags (no `-a`, path, `--amend` or `-p`, which commit what the index does not show yet),
 * runs in the repository's root (a worktree's CLAUDE.md is a branch's file), and every staged path, renames split, is
 * CLAUDE.md or `.claude/` outside its worktrees. Anything git cannot answer refuses.
 */
function processOnly(input: HookInput, text: string, args: string[]): boolean {
  if (!/^git\s/.test(text)) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-m" || a === "-F" || a === "--message" || a === "--file") { i++; continue; }
    if (/^(-m|-F).|^--(message|file)=/.test(a) || ["-q", "--quiet", "-s", "--signoff"].includes(a)) continue;
    return false;
  }
  const root = repository(input);
  if (root === undefined || typeof input.cwd !== "string") return false;
  try {
    const git = (...a: string[]): string => execFileSync("git", ["-C", input.cwd as string, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (realPath(git("rev-parse", "--show-toplevel").trim()) !== root) return false;
    const staged = git("diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter((p) => p !== "");
    return staged.length > 0 && staged.every(processFile);
  } catch {
    // Narrow: only the two git reads are inside; a git that cannot answer is "could not tell", which refuses.
    return false;
  }
}
