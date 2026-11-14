/**
 * WHICH LINE A RELEASE IS ON (scripts/release-line.ts, .github/workflows/release.yml's `decide`; release-notes/README.md
 * "Release lines"): a release branch releases its own line only, and only the newest release takes `latest`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decideLine } from "../scripts/release-line.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAGS = ["v0.17.0", "v0.17.1", "v0.18.0", "v0.19.0", "v0.20.0"];
const MAIN = "refs/heads/main";

test("the newest release takes latest, on main or on its own line's branch", () => {
  assert.deepEqual(decideLine(MAIN, "0.20.1", TAGS), { newest: true, npmTag: "latest", line: "0.20", lineTag: true });
  assert.deepEqual(decideLine(MAIN, "0.21.0", TAGS), { newest: true, npmTag: "latest", line: "0.21", lineTag: true });
  assert.deepEqual(decideLine("refs/heads/release/0.20", "0.20.1", TAGS), { newest: true, npmTag: "latest", line: "0.20", lineTag: true });
  // a re-run once the release's own tag exists decides the same
  assert.deepEqual(decideLine(MAIN, "0.20.1", [...TAGS, "v0.20.1"]), { newest: true, npmTag: "latest", line: "0.20", lineTag: true });
});

test("a patch on an older line takes its line's npm tag, never latest", () => {
  assert.deepEqual(decideLine("refs/heads/release/0.19", "0.19.1", TAGS), { newest: false, npmTag: "latest-0.19", line: "0.19", lineTag: true });
  // by version, not by text: 0.19.10 is above 0.19.9, and below 0.20.0
  assert.deepEqual(decideLine("refs/heads/release/0.19", "0.19.10", [...TAGS, "v0.19.9"]), { newest: false, npmTag: "latest-0.19", line: "0.19", lineTag: true });
  // a tag that is not a release (a pre-release, another name) is not the newest
  assert.deepEqual(decideLine(MAIN, "0.20.1", [...TAGS, "v0.21.0-rc1", "nightly"]), { newest: true, npmTag: "latest", line: "0.20", lineTag: true });
});

test("the line's image tag moves only forward", () => {
  const d = decideLine(MAIN, "0.19.1", [...TAGS, "v0.19.2"]);
  assert.ok(!("problem" in d));
  assert.equal(d.lineTag, false);
  assert.equal(d.newest, false);
});

test("a release branch refuses a release of another line, before anything is published", () => {
  const d = decideLine("refs/heads/release/0.19", "0.21.0", TAGS);
  assert.ok("problem" in d, "release/0.19 holding v0.21.0.md must not publish 0.21.0 as latest");
  assert.match(d.problem, /release\/0\.19 releases 0\.19\.x only/);
  assert.ok("problem" in decideLine("refs/heads/release/0.19", "0.20.1", TAGS));
  assert.ok("problem" in decideLine("refs/heads/release/0.19", "1.19.0", TAGS));
});

test("a branch not named release/<major>.<minor>, or no branch at all, releases nothing", () => {
  for (const ref of ["refs/heads/release/0.19.x", "refs/heads/release/v0.19", "refs/heads/release/0.19-hotfix", "refs/heads/release/019",
    "refs/heads/release/0.019", "refs/heads/release/", "refs/heads/release/0.19/fix"]) {
    const d = decideLine(ref, "0.19.1", TAGS);
    assert.ok("problem" in d, `${ref} must be refused`);
    assert.match(d.problem, /is not named for a line/, ref);
  }
  for (const ref of ["refs/heads/feature", "refs/tags/v0.19.1", "refs/heads/mainline"]) {
    const d = decideLine(ref, "0.19.1", TAGS);
    assert.ok("problem" in d, `${ref} must be refused`);
    assert.match(d.problem, /releases nothing/, ref);
  }
  assert.ok("problem" in decideLine(MAIN, "0.20", TAGS));
});

test("the script prints decide's outputs, or refuses with exit 1 and the reason", () => {
  const run = (ref: string, version: string) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "release-line.ts"), ref, version],
    { input: TAGS.join("\n") + "\n", encoding: "utf8" });
  const ok = run("refs/heads/release/0.19", "0.19.1");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "newest=false\nnpm_tag=latest-0.19\nline=0.19\nline_tag=true\n");
  const no = run("refs/heads/release/0.19", "0.21.0");
  assert.equal(no.status, 1);
  assert.equal(no.stdout, "");
  assert.match(no.stderr, /release\/0\.19 releases 0\.19\.x only/);
});

test("release.yml's decide runs the script before it tags or publishes, and passes its outputs on", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const decide = /\n  decide:\n[\s\S]*?(?=\n  tag:\n)/.exec(yml)?.[0] ?? "";
  assert.match(decide, /node scripts\/release-line\.ts "\$GITHUB_REF" "\$version"/);
  for (const out of ["newest", "npm_tag", "line_tag"]) assert.match(decide, new RegExp(`${out}: \\$\\{\\{ steps\\.decide\\.outputs\\.${out} \\}\\}`));
  assert.match(yml, /branches: \[main, 'release\/\*'\]/);
});
