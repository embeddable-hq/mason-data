/**
 * WHAT scripts/ci-shards.ts AND scripts/oracle-legs.ts BOTH NEED, in a file that imports neither. Each is run as a
 * program with top-level code: when one imported the other in a cycle, `scripts/oracle-legs.ts` ended with Node's exit 13
 * (an unsettled top-level await) and said nothing else. tests/ci-shards.test.ts runs both as processes. Both rebalance
 * from a CI run's artifacts the same way (`runProblems`, `runArtifacts`, `entriesText`), so that lives here once.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The shards of each kind; `.github/workflows/ci.yml`'s matrices say the same (tests/ci-shards.test.ts). */
export const SHARDS = { unit: 4, rest: 3, oracle: 3 } as const;

/** The report an oracle leg writes */
export const reportName = (leg: number): string => `duck-oracle-leg-${leg}.json`;

/** Why a run's artifacts are not this tree's, from `gh run view <id> --json headSha,status,conclusion`: a run of another
 *  commit (an earlier push, another branch) measured another tree, and a run still going may have no artifacts yet */
export function runProblems(view: { headSha?: string; status?: string; conclusion?: string | null }, headSha: string): string[] {
  const problems: string[] = [];
  if (view.headSha !== headSha) problems.push(`the run is of commit ${view.headSha ?? "unknown"}, where this checkout is at ${headSha}: use the run of this commit's push (gh run list --commit ${headSha}), or check out ${view.headSha ?? "its commit"}`);
  if (view.status !== "completed") problems.push(`the run has not finished (${view.status ?? "unknown"}): wait for it, then run this again`);
  return problems;
}

/**
 * The folder of a run's artifacts matching `pattern` (`gh run download`, each artifact in a folder of its own), downloaded
 * only once the run is of the commit checked out at `root` and has finished (`runProblems`); a folder, as given, said to
 * be unchecked. `who` begins every line (`oracle legs`, `unit shards`), `what` names what ran (`legs`, `shards`).
 */
export function runArtifacts(from: string, pattern: string, root: string, who: string, what: string): { dir: string; out: string[] } | { err: string[] } {
  if (!/^\d+$/.test(from) || fs.existsSync(from)) return { dir: from, out: [`${who}: ${from} is a folder, not a run: nothing checks that its ${what} ran on this checkout's commit`] };
  const view = JSON.parse(execFileSync("gh", ["run", "view", from, "--json", "headSha,status,conclusion"], { cwd: root, encoding: "utf8" })) as Parameters<typeof runProblems>[0];
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const wrong = runProblems(view, head);
  if (wrong.length > 0) return { err: [...wrong.map((p) => `${who}: run ${from}: ${p}`), `${who}: nothing written`] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${who.replace(/\W+/g, "-")}-`));
  console.log(`${who}: downloading the ${pattern} artifacts of run ${from} into ${dir}`);
  execFileSync("gh", ["run", "download", from, "--pattern", pattern, "--dir", dir], { cwd: root, stdio: "inherit" });
  return { dir, out: [] };
}

/** A weights fixture's text: its head keys (those not undefined) one a line, then `key`'s entries one a line, so its
 *  diff can be read */
export function entriesText(head: Record<string, unknown>, key: string, entries: Record<string, unknown>): string {
  const top = Object.entries(head).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join("");
  const listed = Object.entries(entries).map(([k, x]) => `    ${JSON.stringify(k)}: ${JSON.stringify(x)}`);
  return `{\n${top}  ${JSON.stringify(key)}: {${listed.length === 0 ? "" : `\n${listed.join(",\n")}\n  `}}\n}\n`;
}
