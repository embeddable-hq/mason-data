#!/usr/bin/env node
/**
 * WHICH LINE A RELEASE IS ON, AND WHETHER IT IS THE NEWEST (.github/workflows/release.yml's `decide`;
 * release-notes/README.md "Release lines"; tests/release-line.test.ts).
 *
 *   git tag -l 'v*' | node scripts/release-line.ts <ref> <version>            newest=, npm_tag= and line_tag= lines
 *   git ls-remote --tags --refs origin 'refs/tags/v*' | node scripts/release-line.ts <ref> <version> <key>
 *                                                                              that one value alone (newest, npm_tag)
 *   node scripts/release-line.ts --ref <ref>          releases=true, or releases=false and why= (exit 0 either way)
 *   git ls-remote --refs origin 'refs/tags/v*' 'refs/heads/release/*' | node scripts/release-line.ts --cut <ref> <version>
 *                                                     cut=true, branch= and from=; or cut=false and why= (exit 0 either way)
 *   git ls-remote --refs origin 'refs/tags/v*' 'refs/heads/release/*' | node scripts/release-line.ts --cut-line <major.minor>
 *                                                     the same, for an older line asked for by name (exit 1 when refused)
 *
 * `--ref` is `decide`'s first step: a branch under release/ that is not named for a line releases nothing, quietly.
 *
 * The tags come on stdin, one a line, as `git tag -l` prints them (`v0.20.0`) or as `git ls-remote` does
 * (`<sha>\trefs/tags/v0.20.0`). The first form is for GITHUB_OUTPUT. The second is THE RE-CHECK: a job that moves a
 * name meaning "the newest" (npm's `latest`, the image's `latest`, GitHub's Latest) reads the remote's tags again just
 * before it moves it (release.yml says why). It refuses a list without the release's own tag, which it pushed first:
 * such a list cannot tell what is newest. A refused release says why on stderr, with exit 1 (exit 2 on a bad
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
 *
 * THE PREVIOUS LINE'S BRANCH IS CUT BY THE RELEASE OF A NEW LINE (`--cut`, release.yml's `tag` job, before it tags). A
 * release from main whose line is newer than every other tag's starts a new line. Before it is tagged, the newest line
 * below it gets its branch, `release/<major>.<minor>`, at that line's newest tag, unless the branch exists. So a patch
 * of the old line starts from exactly what its users run. A release from a line's branch never cuts one, and neither
 * does the first line ever.
 *
 * A LINE RELEASED BEFORE THAT HAS NO BRANCH, and is cut by name (`--cut-line`, .github/workflows/release-line-branch.yml,
 * run from the Actions page): `release/<major>.<minor>` at that line's newest tag, by the same rules. It refuses a line
 * with no tag, and the newest line, whose branch the release of the next line cuts. A branch that exists is never moved.
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

/**
 * Whether a push to `ref` may release, and on which line: main, any line; `release/<major>.<minor>`, that line alone.
 * Anything else releases nothing. A branch under release/ that is not named for a line (an old release-notes PR's
 * `release/v0.20.0`, from before notes PRs moved to `notes/v<version>`) is NOT a mistake to fail on: release.yml's
 * `release/*` trigger reaches it, and `decide` skips it quietly, before it reads anything (`--ref` below).
 */
export function refLine(ref: string): { main: true } | { major: number; minor: number; branch: string } | { skip: string } {
  if (ref === "refs/heads/main") return { main: true };
  const branch = ref.replace(/^refs\/heads\//, "");
  const m = /^release\/(\d+)\.(\d+)$/.exec(branch);
  if (!ref.startsWith("refs/heads/") || m === null || String(Number(m[1])) !== m[1] || String(Number(m[2])) !== m[2]) {
    return { skip: `${branch} is not main or a branch named for a line (release/<major>.<minor>, such as release/0.19), so it releases nothing` };
  }
  return { major: Number(m[1]), minor: Number(m[2]), branch };
}

/** What `decide` does with a release of `version` pushed to `ref`, given the repository's tags; or why it is refused. */
export function decideLine(ref: string, version: string, tags: readonly string[]): LineDecision | { problem: string } {
  const v = parse(version);
  if (v === null) return { problem: `${version} is not a version (x.y.z, such as 0.20.1)` };
  const line = `${v.major}.${v.minor}`;
  const at = refLine(ref);
  if ("skip" in at) return { problem: `${at.skip}.` };
  if ("branch" in at && (at.major !== v.major || at.minor !== v.minor)) {
    return { problem: `The branch ${at.branch} releases ${at.major}.${at.minor}.x only, and its newest release notes are v${version}. ` +
      `Release ${version} from main or from release/${line}, or remove release-notes/v${version}.md from ${at.branch}.` };
  }
  const released = tags.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t.trim())?.[1]).filter((t) => t !== undefined).map(parse)
    .filter((t): t is Version => t !== null);
  const newest = released.every((t) => compare(t, v) <= 0);
  const lineTag = released.every((t) => t.major !== v.major || t.minor !== v.minor || t.patch <= v.patch);
  return { newest, npmTag: newest ? "latest" : `latest-${line}`, line, lineTag };
}

export type CutDecision = { cut: true; branch: string; from: string } | { cut: false; why: string };

/**
 * Whether a release of `version` pushed to `ref` cuts the previous line's branch first, given the remote's refs: its
 * `v*` tags and its `release/*` branches, as `git ls-remote --refs` prints them (or as bare names, `v0.20.3` and
 * `refs/heads/release/0.20`). The release's own tag, on a re-run, does not count against it being a new line.
 */
export function decideCut(ref: string, version: string, refs: readonly string[]): CutDecision | { problem: string } {
  const v = parse(version);
  if (v === null) return { problem: `${version} is not a version (x.y.z, such as 0.20.1)` };
  const at = refLine(ref);
  if ("skip" in at) return { problem: `${at.skip}.` };
  if ("branch" in at) return { cut: false, why: `a release from ${at.branch} never cuts a branch` };
  const names = refs.map((r) => r.trim().replace(/^refs\/tags\//, "")).filter((r) => r !== "");
  const released = releases(names.filter((t) => t !== `v${version}`));
  const line = (t: Version): Version => ({ major: t.major, minor: t.minor, patch: 0 });
  if (released.some((t) => compare(line(t), line(v)) >= 0)) {
    return { cut: false, why: `${version} is not a new line: ${v.major}.${v.minor} or a newer line is released already` };
  }
  const previous = highest(released);
  if (previous === null) return { cut: false, why: `${version} is the first line: no line is released before it` };
  return cutAt(previous, names);
}

/**
 * Whether the branch of an older line, asked for by name (`0.19`), is cut, given the remote's refs as `decideCut` reads
 * them: at the line's newest tag, unless the branch exists. Refused: a name that is not a line, a line with no tag, and
 * the newest line (its branch is cut by the release of the next line, from its newest tag then).
 */
export function decideLineCut(line: string, refs: readonly string[]): CutDecision | { problem: string } {
  const m = /^(\d+)\.(\d+)$/.exec(line.trim());
  if (m === null || String(Number(m[1])) !== m[1] || String(Number(m[2])) !== m[2]) {
    return { problem: `${line} is not a line (<major>.<minor>, such as 0.19)` };
  }
  const names = refs.map((r) => r.trim().replace(/^refs\/tags\//, "")).filter((r) => r !== "");
  const released = releases(names);
  const newest = highest(released.filter((t) => t.major === Number(m[1]) && t.minor === Number(m[2])));
  if (newest === null) return { problem: `${line} has no release: no v${line}.<patch> tag, so there is nothing to cut its branch from` };
  if (released.every((t) => t.major < newest.major || (t.major === newest.major && t.minor <= newest.minor))) {
    return { problem: `${line} is the newest line. Its patches are released from main, and the release of the next line cuts its branch` };
  }
  return cutAt(newest, names);
}

/** The x.y.z of every `v<x.y.z>` among the names; nothing else is a release. */
const releases = (names: readonly string[]): Version[] =>
  names.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t)?.[1]).filter((t): t is string => t !== undefined).map(parse)
    .filter((t): t is Version => t !== null);

const highest = (versions: readonly Version[]): Version | null =>
  versions.reduce<Version | null>((best, t) => (best === null || compare(t, best) > 0 ? t : best), null);

/** The branch of `tag`'s line, cut at `tag`, unless it exists: an existing branch is never moved. */
function cutAt(tag: Version, names: readonly string[]): CutDecision {
  const branch = `release/${tag.major}.${tag.minor}`;
  if (names.includes(`refs/heads/${branch}`)) return { cut: false, why: `${branch} exists already, and is never moved` };
  return { cut: true, branch, from: `v${tag.major}.${tag.minor}.${tag.patch}` };
}

/** The tag names in `git tag -l`'s or `git ls-remote`'s lines: `v0.20.0` either way. */
export function tagNames(text: string): string[] {
  return text.split("\n").map((l) => l.trim().split(/\s+/).pop() ?? "").filter((t) => t !== "")
    .map((t) => t.replace(/^refs\/tags\//, ""));
}

const KEYS = ["newest", "npm_tag", "line_tag"] as const;

function main(args: string[]): number {
  if (args[0] === "--ref") {
    // whether a push to this ref may release at all: `releases=true`, or `releases=false` and the reason, exit 0 either
    // way, so a stray branch under release/ is a quiet green run that publishes nothing
    if (args.length !== 2 || args[1] === undefined) { process.stderr.write("usage: node scripts/release-line.ts --ref <ref>\n"); return 2; }
    const at = refLine(args[1]);
    process.stdout.write("skip" in at ? `releases=false\nwhy=${at.skip}\n` : "releases=true\n");
    return 0;
  }
  if (args[0] === "--cut" || args[0] === "--cut-line") {
    // whether this release cuts the previous line's branch first (`--cut <ref> <version>`), or whether an older line's
    // branch is cut (`--cut-line <line>`): `cut=true`, the branch and the tag to cut it from; or `cut=false` and why.
    // Exit 1 when refused
    const byLine = args[0] === "--cut-line";
    const [, a, b] = args;
    if (args.length !== (byLine ? 2 : 3) || a === undefined || (!byLine && b === undefined)) {
      process.stderr.write(`usage: git ls-remote --refs origin 'refs/tags/v*' 'refs/heads/release/*' | node scripts/release-line.ts ${byLine ? "--cut-line <major.minor>" : "--cut <ref> <version>"}\n`);
      return 2;
    }
    const refs = fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim().split(/\s+/).pop() ?? "");
    const d = byLine ? decideLineCut(a, refs) : decideCut(a, b ?? "", refs);
    if ("problem" in d) { process.stderr.write(`${d.problem}\n`); return 1; }
    process.stdout.write(d.cut ? `cut=true\nbranch=${d.branch}\nfrom=${d.from}\n` : `cut=false\nwhy=${d.why}\n`);
    return 0;
  }
  const [ref, version, key] = args;
  if (ref === undefined || version === undefined || args.length > 3 || (key !== undefined && !(KEYS as readonly string[]).includes(key))) {
    process.stderr.write(`usage: git tag -l 'v*' | node scripts/release-line.ts <ref> <version> [${KEYS.join(" | ")}]\n`);
    return 2;
  }
  const tags = tagNames(fs.readFileSync(0, "utf8"));
  // THE RE-CHECK FAILS CLOSED: it runs after the release's own tag is pushed, so a list without it (an empty answer
  // from the remote, a list cut short) cannot tell what is newest, and must never read as "the newest"
  if (key !== undefined && !tags.includes(`v${version}`)) {
    process.stderr.write(`The tags read hold no v${version}, the tag this release pushed first. They cannot tell whether ${version} is the newest release, so nothing is published under latest. Re-run the job once the tag is on the remote.\n`);
    return 1;
  }
  const d = decideLine(ref, version, tags);
  if ("problem" in d) { process.stderr.write(`${d.problem}\n`); return 1; }
  const values: Record<(typeof KEYS)[number], string> = { newest: String(d.newest), npm_tag: d.npmTag, line_tag: String(d.lineTag) };
  process.stdout.write(key === undefined ? KEYS.map((k) => `${k}=${values[k]}\n`).join("") : `${values[key as (typeof KEYS)[number]]}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
