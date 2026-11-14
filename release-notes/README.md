# Release notes

A release is `release-notes/v<version>.md` merged to `main`, with `cli/package.json` at that version. The merge
itself tags, publishes the image and the CLI, and creates the GitHub release (`.github/workflows/release.yml`):
nothing after the merge is done by hand. A patch on a line that has its own branch is merged to that branch,
`release/0.<minor>`, instead ("Where breaking changes wait" and "A patch on a line's branch", below).

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
- **A setting the host sets is renamed or removed.** This is a `MASON_*` variable, or the variable the sources file
  names for the URL. A setting under an old name stops the start, so a restart alone no longer works.

These are not breaking changes, so they can go in a patch:

- A new key, a new setting or a new command that a project does not have to use.
- A fix for a wrong answer, a crash or lost data.
- A query that Mason now answers, or now refuses by name because its answer was wrong.

Not decided yet, so ask the owner before such a change goes in a patch:

- A renamed or removed `--json` key, event kind, metric or log line, such as `copied` becoming `full_sync` in 0.20.0.
  The project is read the same, but a host's script or alert can stop matching.
- A change that makes Mason sync a table again whole after the upgrade, once, such as a new layout of the synced data.
  The project is read the same, but the restart reads every such table from the source again.

## Is the next release a patch or a new line?

Read `release-notes/next.md` before you choose the version.

- **It is a new line** when its "Before you upgrade" asks the reader to change a project's files or a setting, or says
  that a project is read or refused differently. Then the version is the next minor version (`0.21.0`), and the
  notes tell the reader to move the pin.
- **It is a patch** otherwise. Then the version is the next patch on the current line (`0.20.1`). Its "Before you
  upgrade" says that the pin needs no change (`v0.17.1.md` has the wording).

## Where breaking changes wait

A release from `main` carries everything merged to `main`. So a breaking change on `main` would ship in the next
patch. The current line moves to its own branch first (the owner, 2026-11-14):

- **Before the first breaking change merges to `main`, cut the current line's branch** (`release/0.20`) from `main`, at
  the commit just before it. The coordinator cuts it before merging a PR whose release note goes under "Before you
  upgrade", or that the review marks breaking.
- **From then on, every patch on the current line is released from that branch,** security or not. It is released in
  the same way as a patch on the previous line (below). While it is the newest release, it takes `latest`.
- **A fix needed on both lines goes to `main` first.** Then cherry-pick it to the branch, in its own PR.
- **`main` becomes the next line.** Its next release is `0.21.0`.

## A patch on a line's branch

A security fix goes to the previous line as well as the current one. Each line that is no longer on `main` has a
branch, `release/0.<minor>`.

1. **Cut the branch once.** For the previous line, cut it from the line's newest tag:
   `git push origin 'v0.19.0^{commit}:refs/heads/release/0.19'`. For the current line, cut it from `main` at the
   commit before the first breaking change ("Where breaking changes wait"). Skip this when the branch exists.
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

"The newest" is the highest version among this release and every `v*` tag (`scripts/release-line.ts`). Put the
notes of a patch released from a branch on `main` as well, once it is released, so that `main` keeps every release's
notes. `main` releases only its own newest notes, so an older file there releases nothing.
