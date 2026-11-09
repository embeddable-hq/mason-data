The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A read-only web page can still edit its tables**: `mason serve` with `MASON_UI_READ_ONLY=1` and
  `MASON_UI_READ_ONLY_ALLOW=tables` keeps Add, Columns…, Name its key…, Remove and Sync now on the Tables page, and
  still refuses every other change the page sends (users, cancelling a statement, sharing). `MASON_PROJECT_READONLY=1`
  still refuses an Add or a Remove. Any other value, or the setting without `MASON_UI_READ_ONLY=1`, refuses the start.
  Unset, nothing changes.
