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
