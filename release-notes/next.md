The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **`mason wait` now waits for a table's catch-up poll** (after its first sync, a sync of it again whole, or a change of its `sync:`). A first sync reads the table as of its start,
  then catches it up by one poll for what changed during the read, a `sync: off` table too; on a large table that poll
  is a scan of its own. `mason wait` said Ready while it ran, so a tool started on Ready read data as of the read's
  start, and the table's line said "NOT kept current" with a yellow bar. Now the table's line says it is being caught up
  by one poll, its bar at work, and `mason wait` is ready once that poll is over (a script waiting on it may wait that
  much longer); `mason status`, the web page and EXPLAIN say the same. In `--json` a table in its catch-up has
  `sync.state` `catching-up` (it was `syncing`), and `readiness` lists it under `waiting`.
