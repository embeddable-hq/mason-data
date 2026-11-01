#!/usr/bin/env node
/**
 * HOW OFTEN A PR PASSES ITS REVIEW (.claude/workflows/pr-loop.js). Every exit of pr-loop posts a `Review record`
 * comment on its PR, holding one fenced block tagged `json mason-review-record`: the PR, its design, probe and review
 * rounds, each finding's round, stage and class, its CI fixes and its status. This reads every such block from the
 * repository's PR comments and prints the number to watch: the share of PRs whose review passed the first time
 * (review rounds ≤ 1) and by the second (≤ 2), the mean review rounds, and the classes met most.
 *
 *   node scripts/review-stats.ts [--repo <owner/name>] [--json]
 *
 * A PR run through pr-loop twice (a resume) posts two records; the last one posted is the PR's. A block that does not
 * parse, or lacks a field, is reported on stderr with its comment's URL and left out of the numbers, never guessed.
 * Exit 0 with the numbers; 1 when gh failed or a block was malformed; 2 on a usage error.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type RecordFinding = { round: number; stage: "design" | "probe" | "review"; classKey: string };
export type ReviewRecord = {
  pr: number; designRounds: number; probeRounds: number; reviewRounds: number;
  findings: RecordFinding[]; ciFixes: number; status: string;
};
export type Stats = {
  prs: number; firstPass: number; bySecond: number; meanReviewRounds: number; meanProbeRounds: number;
  topClasses: Array<{ classKey: string; count: number }>;
};

const FENCE = /```json mason-review-record\r?\n([\s\S]*?)\r?\n```/g;
const STAGES = new Set(["design", "probe", "review"]);

/** Why a parsed block is not a ReviewRecord, or null when it is one. */
function problemOf(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return "not an object";
  const r = v as Record<string, unknown>;
  for (const k of ["pr", "designRounds", "probeRounds", "reviewRounds", "ciFixes"]) {
    if (typeof r[k] !== "number") return `${k} is not a number`;
  }
  if (typeof r["status"] !== "string") return "status is not a string";
  if (!Array.isArray(r["findings"])) return "findings is not an array";
  for (const f of r["findings"] as unknown[]) {
    const g = f as Record<string, unknown> | null;
    if (!g || typeof g["round"] !== "number" || typeof g["classKey"] !== "string" || !STAGES.has(String(g["stage"]))) {
      return `a finding is not { round, stage, classKey }: ${JSON.stringify(f)}`;
    }
  }
  return null;
}

/** Every review record in one comment's body. Throws, naming what is wrong, on a block that is not one. */
export function parseRecords(body: string): ReviewRecord[] {
  const out: ReviewRecord[] = [];
  for (const m of body.matchAll(FENCE)) {
    let v: unknown;
    try {
      v = JSON.parse(m[1]!);
    } catch (e) {
      throw new Error(`a mason-review-record block is not JSON: ${(e as Error).message}`);
    }
    const problem = problemOf(v);
    if (problem) throw new Error(`a mason-review-record block is malformed: ${problem}`);
    out.push(v as ReviewRecord);
  }
  return out;
}

/** The numbers over records in the order they were posted: the last record of a PR is its own. */
export function stats(records: readonly ReviewRecord[], top = 10): Stats {
  const byPr = new Map<number, ReviewRecord>();
  for (const r of records) byPr.set(r.pr, r);
  const rs = [...byPr.values()];
  const n = rs.length;
  const counts = new Map<string, number>();
  for (const r of rs) for (const f of r.findings) counts.set(f.classKey, (counts.get(f.classKey) ?? 0) + 1);
  const mean = (k: "reviewRounds" | "probeRounds") => (n ? rs.reduce((s, r) => s + r[k], 0) / n : 0);
  return {
    prs: n,
    firstPass: n ? rs.filter((r) => r.reviewRounds <= 1).length / n : 0,
    bySecond: n ? rs.filter((r) => r.reviewRounds <= 2).length / n : 0,
    meanReviewRounds: mean("reviewRounds"),
    meanProbeRounds: mean("probeRounds"),
    topClasses: [...counts].map(([classKey, count]) => ({ classKey, count }))
      .sort((a, b) => b.count - a.count || a.classKey.localeCompare(b.classKey)).slice(0, top),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function main(argv: string[]): number {
  let repo = "{owner}/{repo}";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--repo" && argv[i + 1]) repo = argv[++i]!;
    else {
      process.stderr.write(`review-stats: unknown argument ${argv[i]}\nusage: node scripts/review-stats.ts [--repo <owner/name>] [--json]\n`);
      return 2;
    }
  }
  let out: string;
  try {
    // issue comments are PR comments too; --jq runs per page, one object a line
    out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/issues/comments?per_page=100`, "--jq",
      '.[] | select(.body | contains("mason-review-record")) | {url: .html_url, body}'], { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e) {
    process.stderr.write(`review-stats: gh api failed: ${(e as Error).message}\n`);
    return 1;
  }
  const records: ReviewRecord[] = [];
  let malformed = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const c = JSON.parse(line) as { url: string; body: string };
    try {
      records.push(...parseRecords(c.body));
    } catch (e) {
      malformed++;
      process.stderr.write(`review-stats: ${c.url}: ${(e as Error).message}; left out\n`);
    }
  }
  const s = stats(records);
  if (json) process.stdout.write(`${JSON.stringify({ ...s, malformed })}\n`);
  else {
    process.stdout.write(`${s.prs} PR(s) with a review record${malformed ? ` (${malformed} malformed, left out)` : ""}\n`);
    process.stdout.write(`passed the first review: ${pct(s.firstPass)}; by the second: ${pct(s.bySecond)}\n`);
    process.stdout.write(`mean review rounds ${s.meanReviewRounds.toFixed(2)}, mean probe rounds ${s.meanProbeRounds.toFixed(2)}\n`);
    process.stdout.write(`top classes:\n${s.topClasses.map((c) => `  ${c.count}  ${c.classKey}`).join("\n") || "  (none)"}\n`);
  }
  return malformed ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
