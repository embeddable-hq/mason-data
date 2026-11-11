The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page's Tables choose how each table is kept current**: every added table says its sync on its line (Off,
  Every 5 minutes, Live (replication)), and where the page may edit the sources file it opens a choice — Off (the
  default), a poll every 5 minutes, 15 minutes, hour or day, each saying it scans the whole table on your database at
  that interval (a table over a million rows says what each poll costs and asks before saving), or Live, logical
  replication. Live can be chosen only when your database is ready for it: otherwise it is shown greyed out with each
  check that fails — no primary key, `wal_level`, a user without REPLICATION, no free replication slot or WAL sender, a
  read replica before Postgres 16, the table missing from your publication — and the SQL or setting that fixes it. The
  checks read your database's settings and catalog only, never a row, when the choice opens and again when it is saved,
  so a database that changed in between is refused. Saving writes the table's `sync:` line in the sources file, as
  `mason add <table> --sync …` does. Where the project's files are read-only, the page shows the sync without a choice.
- **`mason add <table> --sync …` works for a table added with `key:`** (one with no primary key): it changes its
  `sync:` and keeps its key, where it was refused as "cannot be added: no primary key".

- **`mason share` opens with the URL to paste**: its first line is now `Try mason with your favorite postgres client:
  postgres://<user>:<password>@<host>:<port>/<database>?sslmode=require`, the share's own login and address, so a
  client that takes a connection string connects from that one line. The host, port, database, user and password rows
  below it stay, for a tool that asks for each field, and `mason share --json` carries the same URL as `share.url`.
  The password is still made for this run alone and kept nowhere.

## What was wrong and is now right

- **A table of large values could fail its first sync under a small `MASON_DUCKDB_MEMORY`**, now and then, with
  `Failed to commit: could not allocate block of size …` in `mason status` and the log, and wait for its retry (at
  least 5 minutes later). When a chunk of the first sync runs out of memory as it commits, it is now rolled back and
  the sync reads on one chunk at a time, smaller, as it already did when the out-of-memory came in other words.
