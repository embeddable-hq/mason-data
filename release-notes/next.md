The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.

## What was wrong and is now right

- **A BI tool names a column of an enum, a citext or a composite as its type.** Mason sent such a column with the
  source database's number for its type, which Mason's own catalog could hold as another type, often a synced table's
  row type. So a tool that looks the number up (Metabase, DBeaver and Tableau through JDBC, .NET and asyncpg clients)
  showed the column as that table, and a prepared statement that named the type by its number was read as the other
  type. Mason now sends its own number for every type, the one its catalog names, so the lookup names the column's type
  and a prepared statement given that number reads it. The number is no longer the source database's: a tool that
  cached a type's number from the source should look it up again (two Postgres databases number their own types apart
  anyway). `pg_typeof` of such a column is also Postgres's: `other.level` for an enum of another schema and `mood[]`
  for an array, where Mason said `level` and `_mood`.
- **The limit on what statements may spill to disk is in force from the start.** Before, the limit (half of the free
  disk under `.mason/`, or `MASON_SPILL_LIMIT`) was not enforced until the free disk moved by 1 % or more, so a heavy
  statement could spill past it and fill the disk. Now a statement past it fails alone with 53400 and Mason's hint.
  This applies at the default too: a statement, or many at once, that used to finish by spilling past half of the free
  disk now fails with 53400. Set `MASON_SPILL_LIMIT` (for example `40GB`) to raise the limit, or ask for less at once.
  Mason also checks every engine setting it gives at the start, and refuses to start, naming the setting, if one is not
  what it gave.
- **A full disk under `.mason/` no longer kills Mason and leaves it down.** When the disk filled, the run died on its
  own log, and the process that restarts it died too, leaving `.mason/restarts.json` empty, so `mason status` said
  `Unexpected end of JSON input` and nothing started Mason again. Now the run goes on, saying once that its log could
  not be written, and writes its log again once there is room. If it stops while the disk is full, it is started
  again once there is room (8 MiB free), its restart recorded whole then; `mason status` reads a record it cannot
  parse as unreadable and says the rest; and a write under `.mason/` that fails for disk space says so, with the way
  out: free disk where `.mason/` is. Nothing synced is lost.
