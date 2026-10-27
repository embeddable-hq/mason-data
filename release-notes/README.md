# Release notes

A release is `release-notes/v<version>.md` merged to `main`, with `cli/package.json` at that version. The merge
itself tags, publishes the image and the CLI, and creates the GitHub release (`.github/workflows/release.yml`):
nothing after the merge is done by hand.

The notes are for the team RUNNING Mason — what to do before upgrading, what changes for them, what was wrong and
is now right — never what was implemented. The file's first line is the release's name (`# Mason v0.7.0`); the rest
is its body.
