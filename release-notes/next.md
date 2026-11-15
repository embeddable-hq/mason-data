The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **You can see, before you upgrade, which synced tables the new release reads again whole.** Run
  `npx @mason-data/cli@<version> upgrade --check` in the project's folder while Mason runs, with the version you are
  upgrading to. It lists each table that release's first start reads again from your database, why, how large it is,
  and whether it keeps serving its synced data until its new sync is done. It changes nothing. `--json` gives the same
  as data.
  - It works only for an upgrade from this release or a later one. An older Mason does not say what its synced data
    holds, and the command says so. For an upgrade from 0.22.0 or before, read each release's "Before you upgrade".
