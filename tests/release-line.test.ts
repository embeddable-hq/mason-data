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
import { decideCut, decideLine, decideLineCut, refLine, tagNames } from "../scripts/release-line.ts";

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

test("main refuses a release of a line that has its branch, before anything is tagged, and names the branch", () => {
  const branched = [...TAGS, "refs/heads/release/0.20"];
  const d = decideLine(MAIN, "0.20.1", branched);
  assert.ok("problem" in d, "v0.20.1 from main would be missing from release/0.20");
  assert.match(d.problem, /The line 0\.20 has its branch, release\/0\.20, so 0\.20\.1 is released from that branch, not from main/);
  // the branch releases it, and main still releases the next line, and a line with no branch
  assert.deepEqual(decideLine("refs/heads/release/0.20", "0.20.1", branched), { newest: true, npmTag: "latest", line: "0.20", lineTag: true });
  assert.deepEqual(decideLine(MAIN, "0.21.0", branched), { newest: true, npmTag: "latest", line: "0.21", lineTag: true });
  assert.ok(!("problem" in decideLine(MAIN, "0.19.1", branched)), "0.19 has no branch");
  assert.ok("problem" in decideLine(MAIN, "0.19.1", [...branched, "refs/heads/release/0.19"]));
  // a version tagged already is not refused: main's newest notes stay v0.20.0.md until the next line's land, and every
  // push to main reads them
  assert.ok(!("problem" in decideLine(MAIN, "0.20.0", branched)));
  // a branch's name is not a tag
  assert.ok(!("problem" in decideLine(MAIN, "0.20.1", [...TAGS, "refs/heads/release/0.20-old", "release/0.20"])));
});

test("decide reads the branches with the tags, in one git ls-remote call, and refuses with exit 1", () => {
  const remote = (refs: string[]) => refs.map((r) => `${"0".repeat(40)}\t${r.startsWith("refs/") ? r : `refs/tags/${r}`}\n`).join("");
  const no = run(remote([...TAGS, "refs/heads/release/0.20"]), MAIN, "0.20.1");
  assert.equal(no.status, 1);
  assert.equal(no.stdout, "");
  assert.match(no.stderr, /released from that branch, not from main/);
  assert.equal(run(remote([...TAGS, "refs/heads/release/0.20"]), "refs/heads/release/0.20", "0.20.1").status, 0);
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const decide = job(yml, "decide");
  assert.ok(decide.includes(`line="$(git ls-remote --refs origin 'refs/tags/v*' 'refs/heads/release/*' | node scripts/release-line.ts "$GITHUB_REF" "$version")"`));
  assert.ok(decide.indexOf("release-line.ts \"$GITHUB_REF\" \"$version\"") < decide.indexOf('echo "version=$version"'), "before it says what to release");
});

test("a release branch refuses a release of another line, before anything is published", () => {
  const d = decideLine("refs/heads/release/0.19", "0.21.0", TAGS);
  assert.ok("problem" in d, "release/0.19 holding v0.21.0.md must not publish 0.21.0 as latest");
  assert.match(d.problem, /release\/0\.19 releases 0\.19\.x only/);
  assert.ok("problem" in decideLine("refs/heads/release/0.19", "0.20.1", TAGS));
  assert.ok("problem" in decideLine("refs/heads/release/0.19", "1.19.0", TAGS));
});

// branches the `release/*` trigger reaches that are not named for a line: old release-notes PRs' branches among them
const NOT_A_LINE = ["refs/heads/release/v0.20.0", "refs/heads/release/v0.8.0", "refs/heads/release/0.19.x", "refs/heads/release/v0.19",
  "refs/heads/release/0.19-hotfix", "refs/heads/release/019", "refs/heads/release/0.019", "refs/heads/release/", "refs/heads/release/0.19/fix"];

test("a branch not named release/<major>.<minor>, or no branch at all, releases nothing", () => {
  for (const ref of [...NOT_A_LINE, "refs/heads/feature", "refs/heads/notes/v0.21.0", "refs/tags/v0.19.1", "refs/heads/mainline"]) {
    assert.ok("skip" in refLine(ref), `${ref} is skipped`);
    const d = decideLine(ref, "0.19.1", TAGS);
    assert.ok("problem" in d, `${ref} must never release`);
    assert.match(d.problem, /releases nothing/, ref);
  }
  assert.deepEqual(refLine(MAIN), { main: true });
  assert.deepEqual(refLine("refs/heads/release/0.19"), { major: 0, minor: 19, branch: "release/0.19" });
  assert.ok("problem" in decideLine(MAIN, "0.20", TAGS));
});

test("--ref: a push to a branch under release/ not named for a line is skipped quietly, with exit 0", () => {
  for (const ref of NOT_A_LINE) {
    const r = run("", "--ref", ref);
    assert.equal(r.status, 0, `${ref}: ${r.stderr}`);
    assert.match(r.stdout, /^releases=false\nwhy=.*releases nothing\n$/, ref);
  }
  for (const ref of [MAIN, "refs/heads/release/0.19", "refs/heads/release/1.0"]) assert.equal(run("", "--ref", ref).stdout, "releases=true\n", ref);
  assert.equal(run("", "--ref").status, 2);
});

test("release.yml's decide skips a branch not named for a line first, before it reads the notes, and stays green", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const decide = job(yml, "decide");
  const skip = decide.indexOf('node scripts/release-line.ts --ref "$GITHUB_REF"');
  assert.ok(skip > 0, "decide asks --ref");
  assert.ok(skip < decide.indexOf("ls release-notes"), "before it reads the notes or cli/package.json");
  assert.match(decide.slice(skip), /if ! grep -qx 'releases=true' <<<"\$ref"; then\n\s+echo "version=" >> "\$GITHUB_OUTPUT"; echo "cli_publish=false" >> "\$GITHUB_OUTPUT"\n\s+exit 0/);
});

const SCRIPT = path.join(ROOT, "scripts", "release-line.ts");
const run = (input: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });

test("the script prints decide's outputs, or refuses with exit 1 and the reason", () => {
  const ok = run(TAGS.join("\n") + "\n", "refs/heads/release/0.19", "0.19.1");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "newest=false\nnpm_tag=latest-0.19\nline_tag=true\n");
  const no = run(TAGS.join("\n") + "\n", "refs/heads/release/0.19", "0.21.0");
  assert.equal(no.status, 1);
  assert.equal(no.stdout, "");
  assert.match(no.stderr, /release\/0\.19 releases 0\.19\.x only/);
  assert.equal(run("", "refs/heads/main", "0.20.1", "line").status, 2, "an unknown key is a bad argument");
});

test("the re-check reads git ls-remote's tags: a newer release tagged meanwhile keeps an older one off latest", () => {
  const remote = (tags: string[]) => tags.map((t, i) => `${String(i).padStart(40, "0")}\trefs/tags/${t}\n`).join("");
  assert.deepEqual(tagNames(remote(["v0.19.0", "v0.20.0"])), ["v0.19.0", "v0.20.0"]);
  assert.deepEqual(tagNames("v0.19.0\nv0.20.0\n\n"), ["v0.19.0", "v0.20.0"]);
  // decide saw 0.20.1 as the newest; by the publish, 0.21.0 was tagged by main's run
  const before = run(remote([...TAGS, "v0.20.1"]), "refs/heads/release/0.20", "0.20.1", "npm_tag");
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout, "latest\n");
  const after = run(remote([...TAGS, "v0.20.1", "v0.21.0"]), "refs/heads/release/0.20", "0.20.1", "npm_tag");
  assert.equal(after.stdout, "latest-0.20\n");
  assert.equal(run(remote([...TAGS, "v0.20.1", "v0.21.0"]), "refs/heads/release/0.20", "0.20.1", "newest").stdout, "false\n");
  // the newer release's own re-check, with the older one tagged too, keeps latest
  assert.equal(run(remote([...TAGS, "v0.20.1", "v0.21.0"]), MAIN, "0.21.0", "newest").stdout, "true\n");
  // the re-check refuses what decide refuses
  const other = run(remote([...TAGS, "v0.21.0"]), "refs/heads/release/0.19", "0.21.0", "npm_tag");
  assert.equal(other.status, 1);
  assert.match(other.stderr, /release\/0\.19 releases 0\.19\.x only/);
});

test("the re-check fails closed: a list without the release's own tag never reads as the newest", () => {
  const remote = (tags: string[]) => tags.map((t) => `${"0".repeat(40)}\trefs/tags/${t}\n`).join("");
  for (const input of ["", "\n", remote(["v0.20.0"]), remote(["v0.20.10", "v0.2.1"])]) {
    for (const key of ["newest", "npm_tag", "line_tag"]) {
      const r = run(input, MAIN, "0.21.0", key);
      assert.equal(r.status, 1, `${JSON.stringify(input)} ${key}`);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /hold no v0\.21\.0/);
    }
  }
  assert.equal(run(remote(["v0.20.0", "v0.21.0"]), MAIN, "0.21.0", "newest").stdout, "true\n");
  // decide's own read, before the tag exists, needs no tag of its own
  assert.equal(run("v0.20.0\n", MAIN, "0.21.0").status, 0);
});

/** One job of release.yml, by its name. */
const job = (yml: string, name: string): string => new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|$)`).exec(yml)?.[0] ?? "";

test("release.yml checks the line before it tags, and re-checks the newest just before each move of latest", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(job(yml, "decide"), /node scripts\/release-line\.ts "\$GITHUB_REF" "\$version"/);
  assert.match(job(yml, "decide"), /line_tag: \$\{\{ steps\.decide\.outputs\.line_tag \}\}/);
  assert.match(yml, /branches: \[main, 'release\/\*'\]/);
  const recheck = /git ls-remote --tags --refs origin 'refs\/tags\/v\*' \| node scripts\/release-line\.ts "\$GITHUB_REF" "\$\w+" (\w+)/;
  for (const [name, key] of [["extensions", "npm_tag"], ["cli", "npm_tag"], ["release", "newest"]] as const) {
    const j = job(yml, name);
    assert.equal(recheck.exec(j)?.[1], key, `${name} re-checks ${key} from the remote's tags`);
  }
  for (const name of ["extensions", "cli"]) assert.match(job(yml, name), /npm publish --access public --tag "\$tag"/);
  const release = job(yml, "release");
  assert.match(release, /if: steps\.newest\.outputs\.newest == 'true'[\s\S]*imagetools create --tag "\$IMAGE:latest"/);
  assert.match(release, /--latest="\$NEWEST"/);
  assert.match(release, /NEWEST: \$\{\{ steps\.newest\.outputs\.newest \}\}/);
  // no name meaning "the newest" moves on decide's word alone
  assert.doesNotMatch(yml, /needs\.decide\.outputs\.(newest|npm_tag)/);
});

test("a release run is never cancelled by another branch's push: the concurrency group is per branch", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const group = /\nconcurrency:\n  group: (.+?)(?:\s+#[^\n]*)?\n  cancel-in-progress: (\w+)/.exec(yml);
  assert.ok(group !== null, "release.yml has a concurrency group");
  assert.equal(group[1], "release-${{ github.ref }}");
  assert.equal(group[2], "false");
  const images = fs.readFileSync(path.join(ROOT, ".github", "workflows", "images-publish.yml"), "utf8");
  assert.match(images, /flavor: latest=\$\{\{ inputs\.version == '' && startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
    "a release's image takes latest only from the release job's re-check");
});

// THE PREVIOUS LINE'S BRANCH, CUT BY A NEW LINE'S RELEASE (scripts/release-line.ts `--cut`, release.yml's `tag` job)
const LINES = ["v0.19.0", "v0.19.1", "v0.20.0", "v0.20.3"];

test("a new line from main cuts the previous line's branch at that line's newest tag", () => {
  assert.deepEqual(decideCut(MAIN, "0.21.0", LINES), { cut: true, branch: "release/0.20", from: "v0.20.3" });
  // by version, not by text: v0.20.10 is the line's newest, above v0.20.9
  assert.deepEqual(decideCut(MAIN, "0.21.0", [...LINES, "v0.20.9", "v0.20.10"]), { cut: true, branch: "release/0.20", from: "v0.20.10" });
  // a tag that is not a release is not a line's newest
  assert.deepEqual(decideCut(MAIN, "0.21.0", [...LINES, "v0.20.4-rc1", "nightly"]), { cut: true, branch: "release/0.20", from: "v0.20.3" });
  // another line's branch is not this one
  assert.deepEqual(decideCut(MAIN, "0.21.0", [...LINES, "refs/heads/release/0.19"]), { cut: true, branch: "release/0.20", from: "v0.20.3" });
  // a new major: the previous line is the newest one below it, whatever its major
  assert.deepEqual(decideCut(MAIN, "1.0.0", LINES), { cut: true, branch: "release/0.20", from: "v0.20.3" });
  // a re-run once the release's own tag exists decides the same
  assert.deepEqual(decideCut(MAIN, "0.21.0", [...LINES, "v0.21.0"]), { cut: true, branch: "release/0.20", from: "v0.20.3" });
});

test("no cut: a patch on main, a branch that exists, the first line ever, a release from a line's branch", () => {
  const no = (d: ReturnType<typeof decideCut>, why: RegExp) => {
    assert.ok(!("problem" in d) && !d.cut, JSON.stringify(d));
    assert.match(d.why, why);
  };
  no(decideCut(MAIN, "0.20.4", LINES), /not a new line/);
  no(decideCut(MAIN, "0.21.1", [...LINES, "v0.21.0"]), /not a new line/);
  // an older line released from main is not a new line either
  no(decideCut(MAIN, "0.19.2", LINES), /not a new line/);
  // the branch exists already: it is never moved, wherever it is
  no(decideCut(MAIN, "0.21.0", [...LINES, "refs/heads/release/0.20"]), /release\/0\.20 exists already/);
  no(decideCut(MAIN, "0.1.0", []), /first line/);
  no(decideCut(MAIN, "0.1.0", ["v0.1.0", "nightly"]), /first line/);
  no(decideCut("refs/heads/release/0.20", "0.20.4", LINES), /never cuts/);
  no(decideCut("refs/heads/release/0.20", "0.20.4", []), /never cuts/);
  assert.ok("problem" in decideCut("refs/heads/release/v0.20.0", "0.21.0", LINES));
  assert.ok("problem" in decideCut(MAIN, "0.21", LINES));
});

test("--cut reads git ls-remote's tags and branches, and prints the branch and the tag", () => {
  const remote = (refs: string[]) => refs.map((r) => `${"0".repeat(40)}\t${r.startsWith("refs/") ? r : `refs/tags/${r}`}\n`).join("");
  const yes = run(remote(LINES), "--cut", MAIN, "0.21.0");
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(yes.stdout, "cut=true\nbranch=release/0.20\nfrom=v0.20.3\n");
  const exists = run(remote([...LINES, "refs/heads/release/0.20"]), "--cut", MAIN, "0.21.0");
  assert.equal(exists.status, 0, exists.stderr);
  assert.match(exists.stdout, /^cut=false\nwhy=release\/0\.20 exists already/);
  assert.equal(run("", "--cut", MAIN, "0.21.0").stdout, "cut=false\nwhy=0.21.0 is the first line: no line is released before it\n");
  assert.equal(run(remote(LINES), "--cut", "refs/heads/release/v0.20.0", "0.21.0").status, 1);
  assert.equal(run("", "--cut", MAIN).status, 2);
});

/** A workflow step that uses the line-branch action, with the outputs of the `cut` step. */
const USES_ACTION = /\n      - name: [^\n]+\n        if: steps\.cut\.outputs\.cut == 'true'\n        uses: \.\/\.github\/actions\/line-branch\n        with:\n          branch: \$\{\{ steps\.cut\.outputs\.branch \}\}\n          from: \$\{\{ steps\.cut\.outputs\.from \}\}\n          token: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n          deploy-key: \$\{\{ secrets\.RELEASE_BRANCH_DEPLOY_KEY \}\}\n/;

test("release.yml cuts the branch in the tag job, before it tags, with contents: write alone", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const tag = job(yml, "tag");
  const cut = tag.indexOf(`git ls-remote --refs origin 'refs/tags/v*' 'refs/heads/release/*' | node scripts/release-line.ts --cut "$GITHUB_REF" "$VERSION"`);
  assert.ok(cut > 0, "the tag job asks --cut, from the remote's refs");
  assert.match(tag, /\n      - id: cut\n/);
  const uses = USES_ACTION.exec(tag);
  assert.ok(uses !== null, "the tag job creates the branch with the line-branch action");
  assert.ok(cut < uses.index && uses.index < tag.indexOf('git tag -a "v$VERSION"'), "after the decision, before it tags");
  assert.match(tag, /\n    permissions:\n      contents: write(\s+#[^\n]*)?\n(    #[^\n]*\n)*    environment: release-branches\n    steps:/);
  assert.doesNotMatch(tag, /git push[^\n]*heads|-X PATCH/);
});

test("the deploy key is read only by the jobs that cut a branch, through the environment release-branches", () => {
  for (const [file, name] of [["release.yml", "tag"], ["release-line-branch.yml", "cut"]] as const) {
    const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8");
    assert.equal(yml.match(/secrets\.RELEASE_BRANCH_DEPLOY_KEY/g)?.length, 1, `${file} reads the key once`);
    const j = job(yml, name);
    assert.match(j, /secrets\.RELEASE_BRANCH_DEPLOY_KEY/, `${file}'s ${name} job reads it`);
    assert.match(j, /\n    environment: release-branches\n/, `${file}'s ${name} job names the environment`);
    assert.equal(yml.match(/environment: /g)?.length, 1, `${file}: no other job names it`);
  }
  for (const file of fs.readdirSync(path.join(ROOT, ".github", "workflows"))) {
    if (file === "release.yml" || file === "release-line-branch.yml") continue;
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8"), /RELEASE_BRANCH_DEPLOY_KEY|release-branches/, file);
  }
  // GitHub's host keys come from its API with the job's token, never an unauthenticated read
  const action = fs.readFileSync(path.join(ROOT, ".github", "actions", "line-branch", "action.yml"), "utf8");
  assert.match(action, /gh api meta --jq '\.ssh_keys\[\] \| "github\.com " \+ \.' > "\$hosts"/);
  assert.doesNotMatch(action, /curl/);
});

test("the line-branch action never moves a branch, fails closed, and prints GitHub's refusal word for word", () => {
  const action = fs.readFileSync(path.join(ROOT, ".github", "actions", "line-branch", "action.yml"), "utf8");
  assert.match(action, /\nruns:\n  using: composite\n/);
  // with no deploy key: the REST API, which refuses a ref that exists
  assert.match(action, /gh api -X POST "repos\/\$GITHUB_REPOSITORY\/git\/refs" -f ref="refs\/heads\/\$BRANCH" -f sha="\$sha" > "\$answer" 2>&1/);
  // with one: a push whose empty lease refuses a ref that exists at all, never a plain or forced push
  assert.match(action, /if \[ -n "\$DEPLOY_KEY" \]; then/);
  assert.match(action, /git push --force-with-lease="refs\/heads\/\$BRANCH:" "git@github\.com:\$GITHUB_REPOSITORY\.git" "\$sha:refs\/heads\/\$BRANCH" > "\$answer" 2>&1/);
  assert.equal(action.match(/git push/g)?.length, 1);
  assert.doesNotMatch(action, /--force(?!-with-lease)|-X PATCH| -f "\$sha/);
  // the key is a 0600 file, checked against GitHub's host keys, and removed; it is never printed
  assert.match(action, /\(umask 077; printf '%s\\n' "\$DEPLOY_KEY" > "\$key"\)/);
  assert.match(action, /StrictHostKeyChecking=yes/);
  assert.match(action, /trap 'rm -f "\$key"' EXIT/);
  assert.doesNotMatch(action, /echo[^\n]*DEPLOY_KEY/);
  // a refusal: a branch made meanwhile is kept; otherwise GitHub's answer, word for word, and exit 1
  assert.match(action, /if \[ "\$ok" != 1 \]; then\n\s+# [^\n]*\n\s+if git ls-remote --exit-code --heads origin "refs\/heads\/\$BRANCH"/);
  assert.match(action, /echo "GitHub's answer, word for word:"\n\s+cat "\$answer"\n[\s\S]*?\} >&2\n\s+exit 1/);
  // the commit is verified afterwards
  assert.match(action, /if \[ "\$at" != "\$sha" \]; then[^\n]*>&2; exit 1; fi/);
});

// AN OLDER LINE'S BRANCH, CUT ON REQUEST (scripts/release-line.ts `--cut-line`, release-line-branch.yml)
test("a line's branch is cut on request at that line's newest tag, and an existing branch is never moved", () => {
  assert.deepEqual(decideLineCut("0.19", LINES), { cut: true, branch: "release/0.19", from: "v0.19.1" });
  assert.deepEqual(decideLineCut("0.19", [...LINES, "v0.19.9", "v0.19.10"]), { cut: true, branch: "release/0.19", from: "v0.19.10" });
  // another line's branch is not this one
  assert.deepEqual(decideLineCut("0.19", [...LINES, "refs/heads/release/0.20"]), { cut: true, branch: "release/0.19", from: "v0.19.1" });
  // the newest line too (its patches are then released from the branch), and an older major's line
  assert.deepEqual(decideLineCut("0.20", LINES), { cut: true, branch: "release/0.20", from: "v0.20.3" });
  assert.deepEqual(decideLineCut("0.20", ["v0.20.0"]), { cut: true, branch: "release/0.20", from: "v0.20.0" });
  assert.deepEqual(decideLineCut("0.20", [...LINES, "v1.0.0"]), { cut: true, branch: "release/0.20", from: "v0.20.3" });
  for (const line of ["0.19", "0.20"]) {
    const exists = decideLineCut(line, [...LINES, `refs/heads/release/${line}`]);
    assert.ok(!("problem" in exists) && !exists.cut, JSON.stringify(exists));
    assert.match(exists.why, new RegExp(`release/${line.replace(".", "\\.")} exists already, and is never moved`));
  }
});

test("a line with no tag, or a name that is not a line, is refused", () => {
  const refused = (d: ReturnType<typeof decideLineCut>, problem: RegExp) => {
    assert.ok("problem" in d, JSON.stringify(d));
    assert.match(d.problem, problem);
  };
  refused(decideLineCut("0.18", LINES), /0\.18 has no release/);
  refused(decideLineCut("0.19", []), /0\.19 has no release/);
  refused(decideLineCut("0.19", ["v0.19.1-rc1", "nightly", "refs/heads/release/0.19"]), /has no release/);
  for (const bad of ["0.19.1", "v0.19", "0.019", "019", "", "0.19; rm -rf /", "release/0.19"]) refused(decideLineCut(bad, LINES), /is not a line/);
});

test("--cut-line prints the branch and the tag, and refuses with exit 1", () => {
  const remote = (refs: string[]) => refs.map((r) => `${"0".repeat(40)}\t${r.startsWith("refs/") ? r : `refs/tags/${r}`}\n`).join("");
  const yes = run(remote(LINES), "--cut-line", "0.19");
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(yes.stdout, "cut=true\nbranch=release/0.19\nfrom=v0.19.1\n");
  const exists = run(remote([...LINES, "refs/heads/release/0.19"]), "--cut-line", "0.19");
  assert.equal(exists.status, 0, exists.stderr);
  assert.match(exists.stdout, /^cut=false\nwhy=release\/0\.19 exists already/);
  const none = run(remote(LINES), "--cut-line", "0.18");
  assert.equal(none.status, 1);
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /0\.18 has no release/);
  assert.equal(run("", "--cut-line").status, 2);
  assert.equal(run("", "--cut-line", "0.19", "extra").status, 2);
});

test("release-line-branch.yml cuts by --cut-line on request, with contents: write alone, through the line-branch action", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release-line-branch.yml"), "utf8");
  assert.match(yml, /\non:\n  workflow_dispatch:\n    inputs:\n      line:\n/);
  assert.match(yml, /\npermissions:\n  contents: write(\s+#[^\n]*)?\n\n/);
  assert.doesNotMatch(yml, /\n +permissions:/, "no job asks for more");
  // the input reaches the script through the environment, never into the script's text
  assert.match(yml, /LINE: \$\{\{ inputs\.line \}\}/);
  assert.equal(yml.match(/\$\{\{ inputs\.line \}\}/g)?.length, 2, "the environment and the concurrency group only");
  const cut = yml.indexOf(`git ls-remote --refs origin 'refs/tags/v*' 'refs/heads/release/*' | node scripts/release-line.ts --cut-line "$LINE"`);
  assert.ok(cut > 0, "it asks --cut-line, from the remote's refs");
  const uses = USES_ACTION.exec(yml);
  assert.ok(uses !== null && uses.index > cut, "then creates the branch with the line-branch action");
  assert.doesNotMatch(yml, /--force|-X PATCH|git push/);
});
