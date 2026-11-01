#!/usr/bin/env node
/**
 * THE MASON WORK BOARD (CLAUDE.md "The board says where each piece is"): the one way a session moves an issue's card
 * or makes a sub-issue, so every status is one of the board's and every sub-issue is on it.
 *
 *   scripts/board.ts status <issue> <status>        move the issue's card (added to the board if it is not on it)
 *   scripts/board.ts sub <parent> <title> [status]  make a sub-issue of <parent>, on the board (Backlog by default);
 *                                                   prints its number
 *
 * It calls GitHub through `gh`, whose login needs the `project` scope (`gh auth refresh -h github.com -s project`).
 */
import { execFileSync } from "node:child_process";

const REPO = "embeddable-hq/mason-data";
const BOARD = "https://github.com/orgs/embeddable-hq/projects/4";
const PROJECT = "PVT_kwDOCDaQzM4BprO_";
const STATUS_FIELD = "PVTSSF_lADOCDaQzM4BprO_zhoFwPg";
/** each status and its option on the board's Status field, in the order a piece of work moves through them */
export const STATUSES: Record<string, string> = {
  "Backlog": "0f003a08", "In progress": "490160e7", "Implementing": "80d23f4a", "In review": "d50b167f",
  "Fixing": "a58cbd95", "CI / queued": "d0db6aca", "Needs Tom": "213d1ef4", "Done": "4d66b2dd",
};
const USAGE = "usage: scripts/board.ts status <issue> <status> | scripts/board.ts sub <parent> <title> [status]";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const gh = (args: string[], input?: string): string =>
  execFileSync("gh", args, { encoding: "utf8", ...(input === undefined ? {} : { input }), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] }).trim();
const gql = (query: string, vars: Record<string, string>): { data: Record<string, unknown> } =>
  JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])]));
const issueOf = (n: string): { id: number; node_id: string } => JSON.parse(gh(["api", `repos/${REPO}/issues/${n}`]));

function option(status: string): string {
  const o = STATUSES[status];
  if (o === undefined) fail(`"${status}" is no status of the board: one of ${Object.keys(STATUSES).map((s) => `"${s}"`).join(", ")}`);
  return o;
}

function place(nodeId: string, status: string): void {
  const added = gql("mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}", { p: PROJECT, c: nodeId });
  const item = (added.data.addProjectV2ItemById as { item: { id: string } }).item.id;
  gql("mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}",
    { p: PROJECT, i: item, f: STATUS_FIELD, o: option(status) });
}

const [command, ...args] = process.argv.slice(2);
if (command === "status") {
  const [n, status] = args;
  if (n === undefined || status === undefined || !/^\d+$/.test(n) || args.length !== 2) fail(USAGE);
  option(status);
  place(issueOf(n).node_id, status);
  console.log(`#${n} → ${status}`);
} else if (command === "sub") {
  const [parent, title, status = "Backlog"] = args;
  if (parent === undefined || title === undefined || !/^\d+$/.test(parent) || args.length > 3) fail(USAGE);
  option(status);
  const body = `### From Claude\n\nA sub-issue of #${parent}, one PR. Its status is kept on the [Mason work board](${BOARD}).`;
  const n = gh(["issue", "create", "--repo", REPO, "--title", title, "--body-file", "-"], body).split("/").pop()!;
  const made = issueOf(n);
  gh(["api", "-X", "POST", `repos/${REPO}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${made.id}`]);
  place(made.node_id, status);
  console.log(n);
} else {
  fail(USAGE);
}
