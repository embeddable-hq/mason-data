The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason deploy` shows what it changes on the replica, and asks before it removes a synced table**: the tables it
  adds (each a first sync) and removes, with their sizes where the service says them, the tables whose columns, key or
  `sync:` change, the generated tables and roles changed, and the pin — before it sends, and in `--dry-run` when signed
  in (`plan` in `--json`). A deploy that removes a table the replica syncs asks for the replica's name to be typed back
  at a terminal; in CI, from a coding agent and with `--json` it is now refused, naming each table and its size,
  unless you add `--yes`. Adding a table is never asked about. A service that does not say what the replica runs
  leaves the plan unknown, said, and the deploy goes on.
- **`mason serve --check` says whether the database can serve the project, before anything changes**: every problem
  at once, each with its fix — a table it lacks or the user cannot read, a column or key, and for `sync: replication`
  the role, `wal_level`, a free slot and the publication's tables (with the `ALTER PUBLICATION` its owner runs) — or
  the connection's own failure; `--json` carries them as `problems`. It writes nothing and runs beside a running serve,
  so a hosted deploy can be refused before it writes the new files.
- **A table the user cannot read is now refused at the start, by name**: one whose schema it lacks `USAGE` on (the
  first sync failed on it before), and one whose row-level security has no policy for it (it was synced empty, without
  a word). The way out is said: the grant, a policy, or removing the entry.
