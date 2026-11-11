The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page's card for a user just added has a Copy on every field**: URL, User, Password, Database, Host, Port
  and SSL mode, so each can be pasted into a BI tool's connection form one by one. The card no longer shows a psql
  line: paste the URL after `psql`. `mason user add --json` keeps its `psql` field.

## What was wrong and is now right

- **A table of large values could fail its first sync under a small `MASON_DUCKDB_MEMORY`**, now and then, with
  `Failed to commit: could not allocate block of size …` in `mason status` and the log, and wait for its retry (at
  least 5 minutes later). When a chunk of the first sync runs out of memory as it commits, it is now rolled back and
  the sync reads on one chunk at a time, smaller, as it already did when the out-of-memory came in other words.
