#!/usr/bin/env node
/**
 * WHICH LINE A RELEASE IS ON, AND WHETHER IT IS THE NEWEST (.github/workflows/release.yml's `decide`;
 * release-notes/README.md "Release lines"; tests/release-line.test.ts).
 *
 *   git tag -l 'v*' | node scripts/release-line.ts <ref> <version>            newest=, npm_tag= and line_tag= lines
 *   git ls-remote --tags --refs origin 'refs/tags/v*' | node scripts/release-line.ts <ref> <version> <key>
 *                                                                              that one value alone (newest, npm_tag)
 *
 * The tags come on stdin, one a line, as `git tag -l` prints them (`v0.20.0`) or as `git ls-remote` does
 * (`<sha>\trefs/tags/v0.20.0`). The first form is for GITHUB_OUTPUT. The second is THE RE-CHECK: a job that moves a
 * name meaning "the newest" (npm's `latest`, the image's `latest`, GitHub's Latest) reads the remote's tags again just
 * before it moves it (release.yml says why). A refused release says why on stderr, with exit 1 (exit 2 on a bad
 * argument). Only Node's builtins: the jobs run it with no npm ci.
 *
 * A release from main may be on any line. A release from a branch must be on that branch's line: `release/0.19` releases
 * 0.19.x and nothing else, so a notes file of another line merged there by mistake never publishes. Any other ref
 * releases nothing.
 *
 * The newest release is the highest version among this one and every v<x.y.z> tag. Only it takes npm's `latest`, the
 * image's `latest` and GitHub's Latest. A patch on an older line is published under npm's `latest-<major>.<minor>`
 * (npm refuses a tag that reads as a version range, such as `0.19`). The image's line tag (`0.19`) moves only forward:
 * not when a higher patch of the line is tagged already.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface Version { major: number; minor: number; patch: number }

const parse = (text: string): Version | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
};

const compare = (a: Version, b: Version): number => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

export interface LineDecision { newest: boolean; npmTag: string; line: string; lineTag: boolean }

/** What `decide` does with a release of `version` pushed to `ref`, given the repository's tags; or why it is refused. */
export function decideLine(ref: string, version: string, tags: readonly string[]): LineDecision | { problem: string } {
  const v = parse(version);
  if (v === null) return { problem: `${version} is not a version (x.y.z, such as 0.20.1)` };
  const line = `${v.major}.${v.minor}`;
  if (ref !== "refs/heads/main") {
    const branch = ref.replace(/^refs\/heads\//, "");
    if (!ref.startsWith("refs/heads/release/")) {
      return { problem: `${ref} is not main or a release branch, so it releases nothing. Release from main, or from a branch named release/<major>.<minor>.` };
    }
    const m = /^release\/(\d+)\.(\d+)$/.exec(branch);
    if (m === null || String(Number(m[1])) !== m[1] || String(Number(m[2])) !== m[2]) {
      return { problem: `The branch ${branch} is not named for a line. Name it release/<major>.<minor>, such as release/0.19.` };
    }
    if (Number(m[1]) !== v.major || Number(m[2]) !== v.minor) {
      return { problem: `The branch ${branch} releases ${m[1]}.${m[2]}.x only, and its newest release notes are v${version}. ` +
        `Release ${version} from main or from release/${line}, or remove release-notes/v${version}.md from ${branch}.` };
    }
  }
  const released = tags.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t.trim())?.[1]).filter((t) => t !== undefined).map(parse)
    .filter((t): t is Version => t !== null);
  const newest = released.every((t) => compare(t, v) <= 0);
  const lineTag = released.every((t) => t.major !== v.major || t.minor !== v.minor || t.patch <= v.patch);
  return { newest, npmTag: newest ? "latest" : `latest-${line}`, line, lineTag };
}

/** The tag names in `git tag -l`'s or `git ls-remote`'s lines: `v0.20.0` either way. */
export function tagNames(text: string): string[] {
  return text.split("\n").map((l) => l.trim().split(/\s+/).pop() ?? "").filter((t) => t !== "")
    .map((t) => t.replace(/^refs\/tags\//, ""));
}

const KEYS = ["newest", "npm_tag", "line_tag"] as const;

function main(args: string[]): number {
  const [ref, version, key] = args;
  if (ref === undefined || version === undefined || args.length > 3 || (key !== undefined && !(KEYS as readonly string[]).includes(key))) {
    process.stderr.write(`usage: git tag -l 'v*' | node scripts/release-line.ts <ref> <version> [${KEYS.join(" | ")}]\n`);
    return 2;
  }
  const d = decideLine(ref, version, tagNames(fs.readFileSync(0, "utf8")));
  if ("problem" in d) { process.stderr.write(`${d.problem}\n`); return 1; }
  const values: Record<(typeof KEYS)[number], string> = { newest: String(d.newest), npm_tag: d.npmTag, line_tag: String(d.lineTag) };
  process.stdout.write(key === undefined ? KEYS.map((k) => `${k}=${values[k]}\n`).join("") : `${values[key as (typeof KEYS)[number]]}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
