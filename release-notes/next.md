The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.

## What was wrong and is now right

- **A BI tool names a column of an enum, a citext or a composite as the source's type.** Mason's catalog could hold the
  number the wire sends for such a column as another type, often a synced table's row type, so a tool that looks the
  number up (Metabase, DBeaver and Tableau through JDBC, .NET and asyncpg clients) showed the column as that table, and
  a prepared statement that named the type by its number was read as the other type. The catalog now holds every such
  type at the source's own number. `pg_typeof` of one is also Postgres's: `other.level` for an enum of another schema
  and `mood[]` for an array, where Mason said `level` and `_mood`.

- **A full disk under `.mason/` no longer kills Mason and leaves it down.** When the disk filled, the run died on its
  own log, and the process that restarts it died too, leaving `.mason/restarts.json` empty, so `mason status` said
  `Unexpected end of JSON input` and nothing started Mason again. Now the run goes on, saying once that its log could
  not be written, and writes its log again once there is room. If it stops while the disk is full, it is started
  again once there is room (8 MiB free), its restart recorded whole then; `mason status` reads a record it cannot
  parse as unreadable and says the rest; and a write under `.mason/` that fails for disk space says so, with the way
  out: free disk where `.mason/` is. Nothing synced is lost.
