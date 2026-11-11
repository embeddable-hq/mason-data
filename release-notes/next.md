The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page's card for a user just added has a Copy on every field**: URL, User, Password, Database, Host, Port
  and SSL mode, so each can be pasted into a BI tool's connection form one by one. The card no longer shows a psql
  line: paste the URL after `psql`. `mason user add --json` keeps its `psql` field.

- **`mason wait` now waits for a table's catch-up poll** (after its first sync, a sync of it again whole, or a change of its `sync:` to `replication`). A first sync reads the table as of its start,
  then catches it up by one poll for what changed during the read, a `sync: off` table too; on a large table that poll
  is a scan of its own. `mason wait` said Ready while it ran, so a tool started on Ready read data as of the read's
  start, and the table's line said "NOT kept current" with a yellow bar. Now the table's line says it is being caught up
  by one poll, its bar at work, and `mason wait` is ready once that poll is over (a script waiting on it may wait that
  much longer); `mason status`, the web page and EXPLAIN say the same. In `--json` a table in its catch-up has
  `sync.state` `catching-up` (it was `syncing`), and `readiness` lists it under `waiting`.

- **`mason share` opens with the URL to paste**: its first line is now `Try mason with your favorite postgres client:
  postgres://<user>:<password>@<host>:<port>/<database>?sslmode=require`, the share's own login and address, so a
  client that takes a connection string connects from that one line. The host, port, database, user and password rows
  below it stay, for a tool that asks for each field, and `mason share --json` carries the same URL as `share.url`.
  The password is still made for this run alone and kept nowhere.

- `mason user add`, beside a `mason start` run on this machine's own address, now ends its tips with the way to a tool
  outside this machine: `mason share` opens an address on the internet, with a login and password of its own (not the
  new user's), for as long as it runs. It is not said beside `mason serve`, nor with `--replica`, nor while Mason is not
  running. `--json` is unchanged.

## What was wrong and is now right

- **A table of large values could fail its first sync under a small `MASON_DUCKDB_MEMORY`**, now and then, with
  `Failed to commit: could not allocate block of size …` in `mason status` and the log, and wait for its retry (at
  least 5 minutes later). When a chunk of the first sync runs out of memory as it commits, it is now rolled back and
  the sync reads on one chunk at a time, smaller, as it already did when the out-of-memory came in other words.
