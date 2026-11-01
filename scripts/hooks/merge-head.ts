#!/usr/bin/env node
/**
 * PreToolUse hook (Bash): a merge lands the commit that was read (CLAUDE.md "Who merges what"). `gh pr merge` without
 * `--match-head-commit <sha>` merges whatever the head is when it lands, so a push after the review would be merged
 * unread; with it, GitHub refuses a head that moved. Exits 2 with the command to run instead (scripts/hooks/shell.ts).
 */
import { bashCommand, block, readInput, simpleCommands } from "./shell.ts";

const command = bashCommand(readInput());
if (command !== undefined) {
  for (const { argv, text } of simpleCommands(command)) {
    if (argv[0]!.replace(/^.*\//, "") !== "gh" || argv[1] !== "pr" || argv[2] !== "merge") continue;
    if (argv.some((w) => w === "--match-head-commit" || w.startsWith("--match-head-commit="))) continue;
    const pr = argv.slice(3).find((w) => !w.startsWith("-")) ?? "<n>";
    block(`gh pr merge needs --match-head-commit, so a push after your read is not merged unread: ${text} --match-head-commit $(gh pr view ${pr} --json headRefOid --jq .headRefOid), once that head has been read`);
  }
}
