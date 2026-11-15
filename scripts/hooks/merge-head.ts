#!/usr/bin/env node
/**
 * PreToolUse hook (Bash), two rules of CLAUDE.md "Who merges what":
 *
 * - Only the top session merges (the coordinator, .claude/skills/coordinate/SKILL.md). A merge from a sub-agent (an
 *   implementer, any agent the Agent tool or a Workflow started: its input carries `agent_id`, scripts/hooks/shell.ts
 *   `subAgent`) is blocked, pinned or not, queued or not; it reports the PR and the head it read instead (issue 588).
 *   A merge is `gh pr merge`, or a REST call that merges or puts the PR in the merge queue (`PUT /pulls/<n>/merge`,
 *   `PUT /pulls/<n>/merge-async`: scripts/hooks/shell.ts `restMerge`).
 * - A merge lands the commit that was read. `gh pr merge` without `--match-head-commit <sha>`, or a REST merge without
 *   the body's `sha`, merges whatever the head is when it lands, so a push after the review would be merged unread; with
 *   it, GitHub refuses a head that moved (for merge-async, it cancels the request). A body from `--input` cannot be
 *   read here, so it is refused: the hook fails closed.
 *
 * `--disable-auto` withdraws a queued merge and lands nothing, so it is allowed from anyone, as is any read (`GET`).
 * Exits 2 with what to do instead (scripts/hooks/shell.ts).
 */
import { bashCommand, block, readInput, restMerge, simpleCommands, subAgent } from "./shell.ts";

const SUB_AGENT = (pr: string): string => `a sub-agent never merges nor queues a merge (CLAUDE.md "Who merges what"): report PR ${pr} and the head you read to the session that started you; the coordinator reads the diff and merges it (.claude/skills/coordinate/SKILL.md)`;

const input = readInput();
const command = bashCommand(input);
if (command !== undefined) {
  for (const { argv, text } of simpleCommands(command)) {
    const rest = restMerge(argv);
    if (rest !== undefined) {
      if (subAgent(input)) block(SUB_AGENT(rest.pr));
      if (rest.input) block(`a REST merge's body from --input cannot be checked for the head it pins: give the fields with -f, sha included: ${text}`);
      if (/^[0-9a-f]{7,40}$/.test(rest.fields.get("sha") ?? "")) continue;
      block(`a REST merge needs the head it was read at, so a push after your read is not merged unread: ${text} -f sha=$(gh api repos/{owner}/{repo}/pulls/${rest.pr} --jq .head.sha), once that head has been read`);
    }
    if (argv[0]!.replace(/^.*\//, "") !== "gh" || argv[1] !== "pr" || argv[2] !== "merge") continue;
    if (argv.includes("--disable-auto")) continue;
    const pr = argv.slice(3).find((w) => !w.startsWith("-")) ?? "<n>";
    if (subAgent(input)) block(SUB_AGENT(pr));
    if (argv.some((w) => w === "--match-head-commit" || w.startsWith("--match-head-commit="))) continue;
    block(`gh pr merge needs --match-head-commit, so a push after your read is not merged unread: ${text} --match-head-commit $(gh pr view ${pr} --json headRefOid --jq .headRefOid), once that head has been read`);
  }
}
