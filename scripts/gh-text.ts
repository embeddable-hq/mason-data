#!/usr/bin/env node
/**
 * WHO MAY GIVE AN AGENT WORDS (issue 438, CLAUDE.md "The loop"). The agents that work this repository read an issue's or
 * a PR's people-written text (its title, body, comments, reviews, inline review comments, and search results) only
 * through this script. It reads GitHub's REST `author_association` on each item and keeps only the repository's owners,
 * members and collaborators (KEPT): an allowlist, so CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE,
 * a missing field and any value GitHub adds later are left out. What it leaves out it names by count and kind, never by
 * its text and never by its author's login, so the reader knows something was not read.
 *
 *   node scripts/gh-text.ts issue <n>               the issue's title, body and comments by kept authors, then what was left out
 *   node scripts/gh-text.ts pr <n>                  the PR's title, body, comments, reviews and inline review comments, the same way
 *   node scripts/gh-text.ts body <n>                the issue's or PR's body alone, raw, for a stage that rewrites it
 *   node scripts/gh-text.ts comment-id <n> <marker> the id of the latest comment by a kept author with a line that is <marker>
 *   node scripts/gh-text.ts search <words>...       open issues matching the words, by kept authors (number and title)
 *   node scripts/gh-text.ts author <n>              exit 0 when the issue's author is kept, 3 when not
 *
 * Exit 0 read; 1 gh failed (nothing is printed as kept: "couldn't tell" is never "kept"); 2 a usage error; 3 the author is
 * not kept (`author`, `body`) or no kept comment holds the marker (`comment-id`). Every list is read with `--paginate`
 * and per_page=100, so no comment past the first page is silently missing. scripts/review-stats.ts imports KEPT.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "embeddable-hq/mason-data";
/** The authors whose words an agent reads: GitHub's author_association values for the repository's people. */
export const KEPT: readonly string[] = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

/** An item of GitHub's REST answers, as far as this script reads it. */
export type Item = {
  id?: number; number?: number; title?: string | null; body?: string | null; author_association?: unknown;
  user?: { login?: string } | null; created_at?: string; submitted_at?: string; path?: string; line?: number | null;
};

/** Whether an item's author is kept: its association one of KEPT, exactly. Anything else, a missing one included, is not. */
export const isKept = (item: { author_association?: unknown }): boolean =>
  typeof item.author_association === "string" && KEPT.includes(item.author_association);

/** The items by kept authors, in order, and how many were left out. */
export function keep<T extends { author_association?: unknown }>(items: readonly T[]): { kept: T[]; left: number } {
  const kept = items.filter(isKept);
  return { kept, left: items.length - kept.length };
}

/** "1 comment, 2 reviews and 1 review comment": the counts left out, by kind, never their text or authors. */
export function leftOut(counts: Array<[number, string, string]>): string {
  const parts = counts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const who = (i: Item): string => `${i.user?.login ?? "?"} (${String(i.author_association)})`;
const text = (b: string | null | undefined): string => (b ?? "").trimEnd() || "(no text)";
const hasText = (i: Item): boolean => typeof i.body === "string" && i.body.trim() !== "";

/** The issue's or PR's people-written text as an agent reads it: kept items in full, the rest counted. */
export function renderThread(kind: "issue" | "pr", n: number, head: Item, comments: Item[], reviews: Item[] = [], inline: Item[] = []): string {
  const out: string[] = [];
  const kindWord = kind === "pr" ? "PR" : "issue";
  if (isKept(head)) {
    out.push(`## ${kindWord} #${n}: ${head.title ?? ""}`, `by ${who(head)}, ${head.created_at ?? ""}`, "", text(head.body), "");
  } else {
    out.push(`## ${kindWord} #${n}`, `the ${kindWord}'s title and body are by someone else (${String(head.author_association ?? "no association")}): not read`, "");
  }
  const c = keep(comments);
  for (const i of c.kept) out.push(`### comment by ${who(i)}, ${i.created_at ?? ""} (id ${i.id ?? "?"})`, "", text(i.body), "");
  // a review with no text (an approval, or the shell of inline comments) gives no words: neither printed nor counted
  const r = keep(reviews.filter(hasText));
  for (const i of r.kept) out.push(`### review by ${who(i)}, ${i.submitted_at ?? ""}`, "", text(i.body), "");
  const l = keep(inline);
  for (const i of l.kept) out.push(`### review comment by ${who(i)} on ${i.path ?? "?"}${i.line ? `:${i.line}` : ""}, ${i.created_at ?? ""}`, "", text(i.body), "");
  const left = leftOut([[c.left, "comment", "comments"], [r.left, "review", "reviews"], [l.left, "review comment", "review comments"]]);
  out.push(left ? `left out: ${left} by others not read` : "left out: nothing");
  return `${out.join("\n")}\n`;
}

/** Search results as an agent reads them: number and title of the kept authors' issues, then the count left out. */
export function renderSearch(items: Item[]): string {
  const k = keep(items);
  const lines = k.kept.map((i) => `#${i.number} ${i.title ?? ""}`);
  lines.push(k.left ? `left out: ${leftOut([[k.left, "issue", "issues"]])} by others not listed` : "left out: nothing");
  return `${lines.join("\n")}\n`;
}

/** The latest comment by a kept author with a line that is the marker (a heading such as `## Handoff`, not a mention of
 * it in another comment's text), or null. */
export function commentId(comments: Item[], marker: string): number | null {
  const has = (b: unknown): boolean => typeof b === "string" && b.split("\n").some((l) => l.trim() === marker.trim());
  const hit = keep(comments).kept.filter((c) => has(c.body)).pop();
  return hit && typeof hit.id === "number" ? hit.id : null;
}

class GhFailed extends Error {}

/** One gh call. A list endpoint is read with --paginate and `--jq <each>`, one item a line; a single object as it is. */
function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) throw new GhFailed(`gh could not run: ${r.error.message}`);
  if (r.status !== 0) throw new GhFailed(`gh ${args.slice(0, 4).join(" ")} exited ${r.status}: ${(r.stderr || "").trim().split("\n")[0] ?? ""}`);
  return r.stdout;
}
function parse(out: string, what: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    // never echo the output: it may hold text by an author who is not kept
    throw new GhFailed(`gh's answer for ${what} was not JSON`);
  }
}
const one = (p: string): Item => {
  const v = parse(gh(["api", p]), p);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new GhFailed(`gh's answer for ${p} was not an object`);
  return v as Item;
};
const list = (p: string, each = ".[]", extra: string[] = []): Item[] =>
  gh(["api", "--paginate", ...extra, p, "--jq", each]).split("\n").filter((l) => l.trim()).map((l) => parse(l, p) as Item);

const API = `repos/${REPO}`;
const USAGE = "usage: node scripts/gh-text.ts issue <n> | pr <n> | body <n> | comment-id <n> <marker> | search <words>... | author <n>";

export function main(argv: string[], write = (s: string) => process.stdout.write(s), err = (s: string) => process.stderr.write(s)): number {
  const [sub, ...rest] = argv;
  const num = (s: string | undefined): number | null => (s !== undefined && /^[1-9]\d*$/.test(s) ? Number(s) : null);
  const n = num(rest[0]);
  const usage = (why: string): number => { err(`gh-text: ${why}\n${USAGE}\n`); return 2; };
  try {
    switch (sub) {
      case "issue":
      case "pr": {
        if (n === null || rest.length !== 1) return usage(`${sub} takes one issue or PR number`);
        const head = one(`${API}/issues/${n}`);
        const comments = list(`${API}/issues/${n}/comments?per_page=100`);
        const reviews = sub === "pr" ? list(`${API}/pulls/${n}/reviews?per_page=100`) : [];
        const inline = sub === "pr" ? list(`${API}/pulls/${n}/comments?per_page=100`) : [];
        write(renderThread(sub, n, head, comments, reviews, inline));
        return 0;
      }
      case "body": {
        if (n === null || rest.length !== 1) return usage("body takes one issue or PR number");
        const head = one(`${API}/issues/${n}`);
        if (!isKept(head)) {
          err(`gh-text: #${n}'s body is by someone else (${String(head.author_association ?? "no association")}): not read; write no body back to it\n`);
          return 3;
        }
        write(head.body ?? "");
        return 0;
      }
      case "comment-id": {
        if (n === null || rest.length !== 2 || !rest[1]) return usage("comment-id takes a PR number and a marker");
        const id = commentId(list(`${API}/issues/${n}/comments?per_page=100`), rest[1]);
        if (id === null) {
          err(`gh-text: no comment on #${n} by the repository's people has the line ${JSON.stringify(rest[1])}\n`);
          return 3;
        }
        write(`${id}\n`);
        return 0;
      }
      case "search": {
        const words = rest.join(" ").trim();
        if (!words) return usage("search takes the words to look for");
        write(renderSearch(list("search/issues", ".items[]", ["-X", "GET", "-f", `q=repo:${REPO} is:issue is:open ${words}`, "-f", "per_page=100"])));
        return 0;
      }
      case "author": {
        if (n === null || rest.length !== 1) return usage("author takes one issue number");
        const head = one(`${API}/issues/${n}`);
        if (isKept(head)) {
          write(`#${n}'s author is ${String(head.author_association)}: kept\n`);
          return 0;
        }
        write(`#${n}'s author is ${String(head.author_association ?? "no association")}: not one of ${KEPT.join(", ")}\n`);
        return 3;
      }
      default:
        return usage(sub === undefined ? "no command" : `unknown command ${sub}`);
    }
  } catch (e) {
    if (!(e instanceof GhFailed)) throw e;
    err(`gh-text: ${e.message}; nothing was read. Check \`gh auth status\` and the number, then run it again\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
