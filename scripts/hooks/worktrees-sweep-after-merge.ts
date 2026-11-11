#!/usr/bin/env node
/**
 * PostToolUse hook (Bash): after a PR merges, the worktrees whose work is done are swept (issue 852). It starts
 * scripts/worktrees-sweep.ts DETACHED, in the project's folder (`$CLAUDE_PROJECT_DIR`, else the input's cwd), its output
 * appended to `.claude/worktrees-sweep.log` there (gitignored), and exits at once: the sweep fails closed on its own and
 * keeps whatever it cannot tell about.
 *
 * A merge is a simple command (scripts/hooks/shell.ts) that is
 * - `gh pr merge …`, neither queued (`--auto`, which merges later, and the next merge's sweep takes it) nor withdrawn
 *   (`--disable-auto`); in a non-terminal it prints nothing when it merges, so its success is the call's: Claude Code
 *   runs PostToolUse only for a call that succeeded (a non-zero exit is PostToolUseFailure), and an output that says it
 *   failed (`not mergeable`, `failed`, an HTTP 4xx/5xx) or an interrupted call is no merge;
 * - `gh api -X PUT repos/…/pulls/<n>/merge` (or `--method PUT`), whose output says `"merged": true`.
 *
 * It never blocks nor fails the session: every path exits 0 with nothing on stdout; what goes wrong starting the sweep
 * is written to the log when it can be, and to stderr (Claude Code's debug log) else.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bashCommand, readInput, simpleCommands } from "./shell.ts";

const SWEEP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worktrees-sweep.ts");

/** The merge a command line makes, by kind, or undefined. */
function mergeIn(command: string): "gh" | "rest" | undefined {
  for (const { argv } of simpleCommands(command)) {
    if (argv[0]!.replace(/^.*\//, "") !== "gh") continue;
    if (argv[1] === "pr" && argv[2] === "merge" && !argv.includes("--auto") && !argv.includes("--disable-auto")) return "gh";
    if (argv[1] !== "api") continue;
    const put = argv.some((w, i) => w === "-XPUT" || w === "--method=PUT" || w === "-X=PUT"
      || ((w === "-X" || w === "--method") && argv[i + 1]?.toUpperCase() === "PUT"));
    if (put && argv.some((w) => /^\/?repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/.test(w))) return "rest";
  }
  return undefined;
}

/** Whether the call's result says the merge landed. */
function landed(kind: "gh" | "rest", response: unknown): boolean {
  const r = (typeof response === "object" && response !== null ? response : { stdout: typeof response === "string" ? response : "" }) as
    { stdout?: unknown; stderr?: unknown; interrupted?: unknown };
  if (r.interrupted === true) return false;
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const output = `${stdout}\n${typeof r.stderr === "string" ? r.stderr : ""}`;
  if (kind === "rest") return /"merged"\s*:\s*true\b/.test(stdout);
  return !/not mergeable|\bfailed\b|HTTP [45]\d\d/i.test(output);
}

function start(dir: string, command: string): void {
  const log = path.join(dir, ".claude", "worktrees-sweep.log");
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fd = fs.openSync(log, "a");
  } catch (e) {
    process.stderr.write(`worktrees-sweep-after-merge: cannot open ${log}, no sweep started: ${(e as Error).message}\n`);
    return;
  }
  try {
    fs.writeSync(fd, `\n--- a merge was seen (${command.replace(/\s+/g, " ").slice(0, 200)}): starting the sweep\n`);
    const child = spawn(process.execPath, [SWEEP], { cwd: dir, detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", (e) => { fs.writeSync(fd, `the sweep could not start: ${e.message}\n`); });
    child.unref();
  } catch (e) {
    fs.writeSync(fd, `the sweep could not start: ${(e as Error).message}\n`);
  }
}

try {
  const input = readInput();
  const command = bashCommand(input);
  if (command !== undefined && (input.hook_event_name === undefined || input.hook_event_name === "PostToolUse")) {
    const kind = mergeIn(command);
    if (kind !== undefined && landed(kind, input.tool_response)) {
      const dir = [process.env["CLAUDE_PROJECT_DIR"], input.cwd].find((d): d is string => typeof d === "string" && d !== "" && fs.existsSync(d));
      if (dir === undefined) process.stderr.write("worktrees-sweep-after-merge: no project folder in CLAUDE_PROJECT_DIR or the input's cwd, no sweep started\n");
      else start(dir, command);
    }
  }
} catch (e) {
  // A hook that must never fail the session: what went wrong is said on stderr (Claude Code's debug log), and it exits 0.
  process.stderr.write(`worktrees-sweep-after-merge: no sweep started: ${(e as Error).message}\n`);
}
process.exit(0);
