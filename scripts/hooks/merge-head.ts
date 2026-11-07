#!/usr/bin/env node
/**
 * PreToolUse hook (Bash), two rules of CLAUDE.md "Who merges what":
 *
 * - Only the top session merges (the coordinator, .claude/skills/coordinate/SKILL.md). A `gh pr merge` from a sub-agent (an
 *   implementer, any agent the Agent tool or a Workflow started: its input carries `agent_id`, scripts/hooks/shell.ts
 *   `subAgent`) is blocked, pinned or not, queued or not; it reports the PR and the head it read instead (issue 588).
 * - A merge lands the commit that was read. `gh pr merge` without `--match-head-commit <sha>` merges whatever the head
 *   is when it lands, so a push after the review would be merged unread; with it, GitHub refuses a head that moved.
 *
 * `--disable-auto` withdraws a queued merge and lands nothing, so it is allowed from anyone. Exits 2 with what to do
 * instead (scripts/hooks/shell.ts).
 */
import { bashCommand, block, readInput, simpleCommands, subAgent } from "./shell.ts";

const input = readInput();
const command = bashCommand(input);
if (command !== undefined) {
  for (const { argv, text } of simpleCommands(command)) {
    if (argv[0]!.replace(/^.*\//, "") !== "gh" || argv[1] !== "pr" || argv[2] !== "merge") continue;
    if (argv.includes("--disable-auto")) continue;
    const pr = argv.slice(3).find((w) => !w.startsWith("-")) ?? "<n>";
    if (subAgent(input)) {
      block(`a sub-agent never merges nor queues a merge (CLAUDE.md "Who merges what"): report PR ${pr} and the head you read to the session that started you; the coordinator reads the diff and merges it (.claude/skills/coordinate/SKILL.md)`);
    }
    if (argv.some((w) => w === "--match-head-commit" || w.startsWith("--match-head-commit="))) continue;
    block(`gh pr merge needs --match-head-commit, so a push after your read is not merged unread: ${text} --match-head-commit $(gh pr view ${pr} --json headRefOid --jq .headRefOid), once that head has been read`);
  }
}
