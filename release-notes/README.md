# Release notes

A release is `release-notes/v<version>.md` merged to `main`, with `cli/package.json` at that version. The merge
itself tags, publishes the image and the CLI, and creates the GitHub release (`.github/workflows/release.yml`):
nothing after the merge is done by hand. A patch on a line that has its own branch is merged to that branch,
`release/0.<minor>`, instead ("Where breaking changes wait" and "A patch on a line's branch", below).

**A release-notes PR's branch is `notes/v<version>`**, such as `notes/v0.21.0`. Never name it under `release/`. A
`release/*` branch is a line's, and its ruleset takes changes by PR only. A push to a branch under `release/` that is
not named for a line, such as an old `release/v0.20.0`, releases nothing, and its run stays green.

The notes are for the team RUNNING Mason — what to do before upgrading, what changes for them, what was wrong and
is now right — never what was implemented. The file's first line is the release's name (`# Mason v0.7.0`); the rest
is its body.

## Release lines

A release line is every release with the same minor version, such as `0.20.0`, `0.20.1` and `0.20.2`. Before 1.0,
each project's `mason/mason.yml` pins it to one line. Mason runs a project pinned to its own line, at its own patch or
an older one. It refuses a project pinned to another line (`src/lib/project-version.ts`).

A host that runs Mason for others pins each project to a line. It cannot move a project to a new line for the
project's owner. So most releases are patches, and a host can apply a patch with a restart.

- **A release on the current line is a patch** (`0.20.1`), unless it holds a breaking change.
- **A breaking change waits for the next line** (`0.21.0`). A new line is occasional. "Where breaking changes wait"
  says how.
- **A security fix is released on the previous line too** (`0.19.x`), as well as on the current one.

## What a breaking change is

A breaking change is anything that reads a project differently. A patch runs a project pinned to an older patch of
its line, and nobody moves the pin first. So a patch must read that project exactly as the older patch did.

A project is its folder: `mason.yml`, the sources file (`sources/<name>.yml`), `roles.yml` and the generated tables
(`generated/<table>.yml`). Each of these is a breaking change:

- **A file is read differently.** A key is renamed or removed. A key's default changes, such as a table's `sync:`. A
  value means something else, such as which tables a role may read or what a user with no role reads.
- **A project the previous patch accepted is now refused.** A value it took is now invalid. A file it read now fails
  to load. The start stops where it used to run.

These are not breaking changes, so they can go in a patch:

- A new key, a new setting or a new command that a project does not have to use.
- A fix for a wrong answer, a crash or lost data.
- A query that Mason now answers, or now refuses by name because its answer was wrong.

Not decided yet, so ask the owner before such a change goes in a patch:

- A renamed or removed `--json` key, event kind, metric or log line, such as `copied` becoming `full_sync` in 0.20.0.
  The project is read the same, but a host's script or alert can stop matching.
- A change that makes Mason sync a table again whole after the upgrade, once, such as a new layout of the synced data.
  The project is read the same, but the restart reads every such table from the source again.
- A renamed or removed setting the host sets: a `MASON_*` variable, or the variable the sources file names for the
  URL. The project is read the same, but a setting under an old name stops the start, so a restart alone no longer
  works.

## Is the next release a patch or a new line?

Read `release-notes/next.md` before you choose the version. A patch may have a "Before you upgrade" too, so that
section alone does not decide it.

- **It is a new line** when it holds a breaking change, by the definition above. Its "Before you upgrade" then asks
  the reader to change a project's files, or says that a project is read or refused differently. The version is the
  next minor version (`0.21.0`), and the notes tell the reader to move the pin.
- **It is a patch** otherwise. Then the version is the next patch on the current line (`0.20.1`). Its "Before you
  upgrade" says that the pin needs no change (`v0.17.1.md` has the wording).

## Where breaking changes wait

A release from `main` carries everything merged to `main`. So once a breaking change merges to `main`, the next
release from `main` is the next line (`0.21.0`). The line before it gets its own branch at that release (the owner,
2026-11-14):

- **The release of a new line cuts the previous line's branch.** When `.github/workflows/release.yml` releases
  `0.21.0` from `main`, it first creates `release/0.20` at the newest `v0.20.*` tag, such as `v0.20.3`. It does this
  before it tags `v0.21.0`. Nobody cuts the branch by hand.
- **So a patch of the old line starts from exactly what its users run,** plus the fix.
- **The workflow never moves a branch that exists.** When the branch is there already, it is left where it is.
- **If the workflow cannot create the branch, the release fails** before anything is tagged or published. Fix the
  cause, then re-run the release from the Actions page. "The ruleset on `release/*`" (below) has the usual cause.
- **Until the new line is released, `main` releases no patch of the current line.** A patch the current line needs
  before then waits for the new line's release, which cuts the branch. Then it is released from the branch.
- **From then on, every patch on the old line is released from its branch,** security or not ("A patch on a line's
  branch", below).
- **A fix needed on both lines goes to `main` first.** Then cherry-pick it to the branch, in its own PR.

`scripts/release-line.ts` decides whether a release is a new line, which branch it cuts and from which tag.
`tests/release-line.test.ts` holds it.

## The ruleset on `release/*`

**Every `release/*` branch must be protected like `main`.** A push to one publishes a release. So it needs a ruleset
like `main`'s: changes by PR only, the same required checks, no force-push and no deletion. The owner sets it up.
Until it exists, a push to a release branch is a release that nobody reviewed.

**The ruleset must let GitHub Actions create the branch. The owner adds this once.** On GitHub, open the repository's
Settings, then Rules, then Rulesets, then the `release` ruleset. Under "Bypass list", click "Add bypass", choose the
"GitHub Actions" app, and keep "Always allow". Save the ruleset.

- Two workflows create a line's branch: `release.yml`, and "Release line branch" for an older line. Each uses its
  `GITHUB_TOKEN`. That token belongs to the GitHub Actions app, so the ruleset judges the app. A bypass list that
  holds only "Repository admin" does not cover it.
- GitHub applies a ruleset's required status checks to a new branch too, unless the rule has "Do not require status
  checks on creation". A tag's commit may have no green checks: a later push to `main` cancels the run on it. And
  GitHub's docs do not say that the pull request rule allows a new branch.
- With the bypass, a workflow with write access to the repository's contents can push to `release/*` without a PR.
  Only `release.yml` and "Release line branch" ask for that access today.

Without the bypass, the release of a new line fails at its first step, and so does "Release line branch". Both name
this section.

## A patch on a line's branch

A security fix goes to the previous line as well as the current one. Each line that is no longer on `main` has a
branch, `release/0.<minor>`.

1. **Find the line's branch.** The release of the next line cut it ("Where breaking changes wait"). A line released
   before the workflow cut branches, such as `0.19`, has none. To patch one of those, run the "Release line branch"
   workflow (`.github/workflows/release-line-branch.yml`) from the Actions page, with the line (`0.19`). It creates
   `release/0.19` at the line's newest tag, and checks the commit afterwards. It refuses a line with no tag, and the
   newest line, whose branch the next line's release cuts. It never moves a branch that exists. Nobody cuts a branch
   by hand.
2. **Make the fix on a branch from `release/0.19`,** and open its PR against `release/0.19`. CI runs on it as on any
   PR. A fix that is on `main` already is cherry-picked to the branch, in its own PR.
   - The first PR to a new branch also takes `main`'s `.github/workflows/release.yml`, `images-publish.yml` and
     `scripts/release-line.ts`. A push runs the workflow file of the branch it lands on. Every tag made before this
     change, `v0.20.0` and every older one, has a `release.yml` that releases from `main` alone. Without this step,
     the merge to the branch releases nothing, and says nothing.
3. **Add the release in the same PR or the next one:** `release-notes/v0.19.1.md`, `cli/package.json` at `0.19.1`,
   and its five `optionalDependencies` at `0.19.1`.
4. **Merge it to `release/0.19`.** The merge releases it in the same way as a merge to `main`. The tag `v0.19.1` goes
   on the merge commit. A release branch releases its own line only. A merge of `v0.21.0.md` to `release/0.19` fails
   the release before anything is tagged or published, and says why.

The newest release keeps the names that mean "the newest". A patch on an older line never takes them:

- **npm:** the newest release is `latest`. An older line's patch is published under `latest-0.19`.
- **The image:** each release is tagged with its version and its line (`0.19.1` and `0.19`). The line's tag only
  moves forward, to the line's highest patch. Only the newest release also gets `latest`.
- **GitHub:** only the newest release is marked Latest.

"The newest" is the highest version among this release and every `v*` tag (`scripts/release-line.ts`). Each job
that moves one of these names reads the tags again just before it does, so two releases at once never move `latest`
back (`.github/workflows/release.yml` says how).

**Finish every release that was tagged.** A newer release counts as the newest once its tag exists, even if its run
failed later, at the image or npm. Until it is finished, `latest` stays where it was, and no patch on an older line
takes it. So re-run the failed release from the Actions page, or fix it and merge again, until its GitHub release
exists.

**Never copy a branch's release notes to `main`.** `main` releases its newest notes file, and checks it against
`cli/package.json`. A `v0.20.1.md` on a `main` that is at `0.20.0` fails every release run on `main` until
`v0.21.0.md` lands. A patch's notes stay on its branch and in its GitHub release.
