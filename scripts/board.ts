#!/usr/bin/env node
/**
 * THE MASON WORK BOARD (CLAUDE.md "The board says where each piece is"): the one way a session moves an issue's card
 * or makes a sub-issue, so every status is one of the board's and every sub-issue is on it.
 *
 *   scripts/board.ts status <issue> <status>                          move the issue's card (added to the board if it
 *                                                                      is not on it)
 *   scripts/board.ts severity <issue> <Critical|High|Medium|Low>       set a bug's Severity field (added to the board
 *                                                                      if it is not on it), by CLAUDE.md's definitions
 *   scripts/board.ts sub <parent> <title> --from <model> [<status>]   make a sub-issue of <parent>, on the board
 *                                                                      (Backlog by default); prints its number. Its
 *                                                                      body is headed "### From Claude (<model>)", as
 *                                                                      CLAUDE.md "Git workflow" asks
 *
 * It calls GitHub through `gh`, whose login needs the `project` scope (`gh auth refresh -h github.com -s project`).
 * The board's ids are fixed here: a board made again needs them read again (its Status and Severity fields' options).
 */
import { execFileSync } from "node:child_process";
import { didYouMean } from "../src/lib/did-you-mean.ts";

const REPO = "embeddable-hq/mason-data";
const BOARD = "https://github.com/orgs/embeddable-hq/projects/4";
const PROJECT = "PVT_kwDOCDaQzM4BprO_";
const STATUS_FIELD = "PVTSSF_lADOCDaQzM4BprO_zhoFwPg";
/** each status and its option on the board's Status field, in the order a piece of work moves through them */
export const STATUSES: Record<string, string> = {
  "Backlog": "0f003a08", "In progress": "490160e7", "Implementing": "80d23f4a", "In review": "d50b167f",
  "Fixing": "a58cbd95", "CI / queued": "d0db6aca", "Needs Tom": "213d1ef4", "Done": "4d66b2dd",
};
const SEVERITY_FIELD = "PVTSSF_lADOCDaQzM4BprO_zhoJbcA";
/** each severity and its option on the board's Severity field, most severe first, so a view sorts by it */
export const SEVERITIES: Record<string, string> = { "Critical": "ad7a70aa", "High": "39b48c10", "Medium": "ebe789b5", "Low": "1d11df05" };
const USAGE = "usage: scripts/board.ts status <issue> <status> | scripts/board.ts severity <issue> <Critical|High|Medium|Low> | " +
  "scripts/board.ts sub <parent> <title> --from <model> [<status>]";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

/** `gh`'s output; a failure exits 1 with gh's own words and the way out, never a stack */
function gh(args: string[], input?: string): string {
  try {
    return execFileSync("gh", args, { encoding: "utf8", ...(input === undefined ? {} : { input }), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).trim();
  } catch (x) {
    const said = String((x as { stderr?: unknown }).stderr ?? (x instanceof Error ? x.message : x)).trim().split("\n")[0];
    throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${said}. If it is a scope or a login, run: gh auth refresh -h github.com -s project`);
  }
}
const gql = (query: string, vars: Record<string, string>): { data: Record<string, unknown> } =>
  JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])]));
const issueOf = (n: string): { id: number; node_id: string } => JSON.parse(gh(["api", `repos/${REPO}/issues/${n}`]));

function option(status: string): string {
  const o = STATUSES[status];
  if (o === undefined) fail(`"${status}" is no status of the board: one of ${Object.keys(STATUSES).map((s) => `"${s}"`).join(", ")}`);
  return o;
}

function severity(level: string): string {
  const o = SEVERITIES[level];
  if (o === undefined) fail(`"${level}" is no severity of the board: one of ${Object.keys(SEVERITIES).map((s) => `"${s}"`).join(", ")}${didYouMean(level, Object.keys(SEVERITIES))}`);
  return o;
}

/** the issue's card (added to the board if it is not on it; adding one already there returns its card) with one
 * single-select field set to one option */
function set(nodeId: string, field: string, optionId: string): void {
  const added = gql("mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}", { p: PROJECT, c: nodeId });
  const item = (added.data.addProjectV2ItemById as { item: { id: string } }).item.id;
  gql("mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}",
    { p: PROJECT, i: item, f: field, o: optionId });
}
const place = (nodeId: string, status: string): void => set(nodeId, STATUS_FIELD, option(status));

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "status") {
    const [n, status] = rest;
    if (n === undefined || status === undefined || !/^\d+$/.test(n) || rest.length !== 2) fail(USAGE);
    option(status);
    place(issueOf(n).node_id, status);
    console.log(`#${n} → ${status}`);
  } else if (command === "severity") {
    const [n, level] = rest;
    if (n === undefined || level === undefined || !/^\d+$/.test(n) || rest.length !== 2) fail(USAGE);
    const o = severity(level);
    set(issueOf(n).node_id, SEVERITY_FIELD, o);
    console.log(`#${n} severity → ${level}`);
  } else if (command === "sub") {
    const at = rest.indexOf("--from");
    const from = at < 0 ? undefined : rest[at + 1];
    const args = at < 0 ? rest : [...rest.slice(0, at), ...rest.slice(at + 2)];
    const [parent, title, status = "Backlog"] = args;
    if (parent === undefined || title === undefined || !/^\d+$/.test(parent) || args.length > 3) fail(USAGE);
    if (from === undefined || from === "" || from.startsWith("--")) fail(`sub needs --from <model>, the model whose words the sub-issue's body is (CLAUDE.md "Git workflow"): --from "Opus 5.5"\n${USAGE}`);
    option(status);
    const body = `### From Claude (${from})\n\nA sub-issue of #${parent}, one PR. Its status is kept on the [Mason work board](${BOARD}).`;
    const n = gh(["issue", "create", "--repo", REPO, "--title", title, "--body-file", "-"], body).split("/").pop()!;
    // the issue exists from here: a failure after it says its number, and what to run to finish
    try {
      const made = issueOf(n);
      gh(["api", "-X", "POST", `repos/${REPO}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${made.id}`]);
      place(made.node_id, status);
    } catch (x) {
      fail(`#${n} was made, but not made a sub-issue of #${parent} or not put on the board: ${x instanceof Error ? x.message : String(x)}\n` +
        `Finish it: gh api -X POST repos/${REPO}/issues/${parent}/sub_issues -F sub_issue_id=$(gh api repos/${REPO}/issues/${n} --jq .id); scripts/board.ts status ${n} "${status}"`, 1);
    }
    console.log(n);
  } else {
    fail(USAGE);
  }
} catch (x) {
  fail(x instanceof Error ? x.message : String(x), 1);
}
