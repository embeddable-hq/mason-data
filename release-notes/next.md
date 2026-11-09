The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason deploy` shows what it changes on the replica, and asks before it removes a synced table**: the tables it
  adds (each a first sync) and removes, with their sizes where the service says them, the tables whose columns, key or
  `sync:` change, the generated tables and roles changed, and the pin — before it sends, and in `--dry-run` when signed
  in (`plan` in `--json`). A deploy that removes a table the replica syncs asks for the replica's name to be typed back
  at a terminal; in CI, from a coding agent and with `--json` it is now refused, naming each table and its size,
  unless you add `--yes`. Adding a table is never asked about. A service that does not say what the replica runs
  leaves the plan unknown, said, and the deploy goes on.
