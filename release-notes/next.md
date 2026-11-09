The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason serve`'s web page can link back to the site that links to it**: set `MASON_UI_BACK_URL` to a path on the
  page's host (`/something`) or an `https://` or `http://` URL, and the top of its sidebar shows "← Back" on every
  page, in the same tab; `MASON_UI_BACK_LABEL` names it. Any other scheme, a URL with a user or password, or a control
  character refuses the start. Unset, nothing changes. `mason start` refuses both.

- **`mason deploy` shows what it changes on the replica, and asks before it removes a synced table**: the tables it
  adds (each a first sync) and removes, with their sizes where the service says them, the tables whose columns, key or
  `sync:` change, the generated tables and roles changed, and the pin — before it sends, and in `--dry-run` when signed
  in (`plan` in `--json`). A deploy that removes a table the replica syncs asks for the replica's name to be typed back
  at a terminal; in CI, from a coding agent and with `--json` it is now refused, naming each table and its size,
  unless you add `--yes`. Adding a table is never asked about. A service that does not say what the replica runs
  leaves the plan unknown, said, and the deploy goes on.
- **When the service refuses a deploy for removing tables nobody confirmed, `mason deploy` asks and sends it again**:
  the tables the refusal names are said with their sizes and confirmed as above (typed back, else `--yes`), and the
  deploy is sent once more, removing exactly those. Where the service could not tell which tables go (it cannot read
  the sources file the replica runs), the question says any synced table the deploy removes will be dropped, so a
  deploy that fixes that file is no longer refused for ever. `--json` carries what was confirmed as `confirmed`.
- **A generated table's file whose YAML expands too many aliases is refused as that file's mistake**, as a sources or
  roles file's is, where `mason deploy` stopped on an internal error.
- **`mason serve --check` says whether the database can serve the project, before anything changes**: every problem
  at once, each with its fix — a table it lacks or the user cannot read, a column or key, and for `sync: replication`
  the role, `wal_level`, a free slot and the publication's tables (with the `ALTER PUBLICATION` its owner runs) — or
  the connection's own failure; `--json` carries them as `problems`. It writes nothing and runs beside a running serve,
  so a hosted deploy can be refused before it writes the new files.
- **A table the user cannot read is now refused at the start, by name**: one whose schema it lacks `USAGE` on (the
  first sync failed on it before), and one whose row-level security has no policy for it (it was synced empty, without
  a word). The way out is said: the grant, a policy, or removing the entry.
- **A process beside `mason serve` can rely on the table list and on adding and removing tables.** `GET /api/state`
  (its `tables`), `GET /api/tables/<table>/columns`, `POST /api/pick` and `POST /api/remove`, reached over
  `MASON_UI_SOCKET` with the token from `MASON_UI_RUN_FILE`, are now a documented contract: their bodies, answers and
  refusals keep their shape within a release line (docs/WEB-UI.md "An operator's table edits"). `MASON_UI_READ_ONLY=1`
  refuses the page's edits, never a request with the run's token. Nothing about them changed.
