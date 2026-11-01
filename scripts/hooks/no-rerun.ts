#!/usr/bin/env node
/**
 * PreToolUse hook (Bash): a failed run is read, never re-run on the same commit to see whether it goes away (CLAUDE.md
 * "Never re-run a gate on an unchanged tree"). `gh run rerun`, with or without `--failed` or `--job`, is blocked: a
 * re-run repeats the same commit, so its verdict says nothing new. Exits 2 with the way out (scripts/hooks/shell.ts).
 */
import { bashCommand, block, readInput, simpleCommands } from "./shell.ts";

const command = bashCommand(readInput());
if (command !== undefined && simpleCommands(command).some(({ argv }) =>
  argv[0]!.replace(/^.*\//, "") === "gh" && argv[1] === "run" && argv[2] === "rerun")) {
  block("gh run rerun repeats the same commit: read the failure (gh run view <id> --log-failed); it is the change's to fix, or a flake to quarantine with an issue (CLAUDE.md \"Local gates\")");
}
