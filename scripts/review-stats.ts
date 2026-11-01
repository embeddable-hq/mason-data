#!/usr/bin/env node
/**
 * HOW OFTEN A PR PASSES ITS REVIEW (.claude/workflows/pr-loop.js). Every exit of pr-loop with a PR posts a
 * `Review record` comment on that PR, holding one fenced block tagged `json mason-review-record`: the PR, its design,
 * probe and review rounds, each finding of the PR's with its round, stage and class, its CI fixes and its status. This
 * reads every such block from the repository's PR comments and prints the number to watch, over the PRs whose run
 * reached a review:
 *   - passed the first review: Fable's round 1 found nothing of the PR's (a later re-check of a CI fix does not undo it);
 *   - passed by the second: round 1 found nothing, or a round 2 ran and found nothing;
 *   - the mean review and probe rounds, and the classes met most.
 * The runs that never reached a review (a stop at the link check, a failed brief or review) are counted apart, never
 * as passing.
 *
 *   node scripts/review-stats.ts [--repo <owner/name>] [--json]
 *
 * A record counts for the PR whose comment holds it, and only when it names that PR: a record quoted on another PR is
 * left out. A PR run through pr-loop twice (a resume) posts two records; the last one posted is the PR's. A block
 * opens with a line that is exactly the fence and its tag, so a quoted one (`> ```json …`) is not a block. A block that
 * does not parse, lacks a field, or never closes is reported on stderr with its comment's URL and left out, never
 * guessed. Exit 0 with the numbers; 1 when gh failed or a block was malformed; 2 on a usage error.
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
  prs: number; reviewed: number; neverReviewed: number; firstPass: number; bySecond: number;
  meanReviewRounds: number; meanProbeRounds: number; topClasses: Array<{ classKey: string; count: number }>;
};

const OPEN = "```json mason-review-record";
const CLOSE = "```";
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

/** Every review record in one comment's body: a block opens on a line that is exactly the fence and its tag, and
 * closes on the next line that is exactly a fence. Throws, naming what is wrong, on a block that is not a record. */
export function parseRecords(body: string): ReviewRecord[] {
  const out: ReviewRecord[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== OPEN) continue;
    const end = lines.findIndex((l, j) => j > i && l.trimEnd() === CLOSE);
    if (end < 0) throw new Error("a mason-review-record block never closes");
    let v: unknown;
    try {
      v = JSON.parse(lines.slice(i + 1, end).join("\n"));
    } catch (e) {
      throw new Error(`a mason-review-record block is not JSON: ${(e as Error).message}`);
    }
    const problem = problemOf(v);
    if (problem) throw new Error(`a mason-review-record block is malformed: ${problem}`);
    out.push(v as ReviewRecord);
    i = end;
  }
  return out;
}

/** The records a comment holds for its own PR (the number its issue_url ends in), and how many name another PR. */
export function recordsOfComment(c: { issue_url: string; body: string }): { records: ReviewRecord[]; quoted: number } {
  const m = /\/issues\/(\d+)$/.exec(c.issue_url);
  if (!m) throw new Error(`a comment's issue_url names no PR: ${c.issue_url}`);
  const pr = Number(m[1]);
  const all = parseRecords(c.body);
  const records = all.filter((r) => r.pr === pr);
  return { records, quoted: all.length - records.length };
}

/** Whether review round `n` of a record ran and found nothing of the PR's. */
const cleanRound = (r: ReviewRecord, n: number) =>
  r.reviewRounds >= n && !r.findings.some((f) => f.stage === "review" && f.round === n);

/** The numbers over records in the order they were posted: the last record of a PR is its own. */
export function stats(records: readonly ReviewRecord[], top = 10): Stats {
  const byPr = new Map<number, ReviewRecord>();
  for (const r of records) byPr.set(r.pr, r);
  const all = [...byPr.values()];
  const rs = all.filter((r) => r.reviewRounds >= 1);
  const n = rs.length;
  const counts = new Map<string, number>();
  for (const r of all) for (const f of r.findings) counts.set(f.classKey, (counts.get(f.classKey) ?? 0) + 1);
  const share = (p: (r: ReviewRecord) => boolean) => (n ? rs.filter(p).length / n : 0);
  const mean = (k: "reviewRounds" | "probeRounds") => (n ? rs.reduce((s, r) => s + r[k], 0) / n : 0);
  return {
    prs: all.length,
    reviewed: n,
    neverReviewed: all.length - n,
    firstPass: share((r) => cleanRound(r, 1)),
    bySecond: share((r) => cleanRound(r, 1) || cleanRound(r, 2)),
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
      '.[] | select(.body | contains("mason-review-record")) | {url: .html_url, issue_url, body}'], { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e) {
    process.stderr.write(`review-stats: gh api failed: ${(e as Error).message}\n`);
    return 1;
  }
  const records: ReviewRecord[] = [];
  let malformed = 0;
  let quoted = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const c = JSON.parse(line) as { url: string; issue_url: string; body: string };
    try {
      const r = recordsOfComment(c);
      records.push(...r.records);
      quoted += r.quoted;
    } catch (e) {
      malformed++;
      process.stderr.write(`review-stats: ${c.url}: ${(e as Error).message}; left out\n`);
    }
  }
  const s = stats(records);
  if (json) process.stdout.write(`${JSON.stringify({ ...s, quoted, malformed })}\n`);
  else {
    process.stdout.write(`${s.prs} PR(s) with a review record: ${s.reviewed} reached a review, ${s.neverReviewed} stopped before one`
      + `${quoted ? `; ${quoted} record(s) quoted on another PR, left out` : ""}${malformed ? `; ${malformed} malformed, left out` : ""}\n`);
    process.stdout.write(`of those reviewed, passed the first review: ${pct(s.firstPass)}; by the second: ${pct(s.bySecond)}\n`);
    process.stdout.write(`mean review rounds ${s.meanReviewRounds.toFixed(2)}, mean probe rounds ${s.meanProbeRounds.toFixed(2)}\n`);
    process.stdout.write(`top classes:\n${s.topClasses.map((c) => `  ${c.count}  ${c.classKey}`).join("\n") || "  (none)"}\n`);
  }
  return malformed ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
