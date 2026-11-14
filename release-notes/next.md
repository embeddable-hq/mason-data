The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **Mason no longer leaves a time limit on your database's pooled connections.** When the web page checked whether a
  table could be kept current by replication, Mason set a 10-second time limit on its connection and never took it off.
  Behind a pooler in transaction mode (PgBouncer, or Supabase's default pooler URL), that connection is handed on to
  your application next. Your application's queries could then be cancelled after 10 seconds, for up to an hour.
  `mason mcp` did the same on Mason's own Postgres API with each tool call's time limit. Now each limit ends with
  Mason's own query, whatever pooler sits in between.
- **The smallest and largest value of a text column, and a page sorted by one, are many times faster when your
  database sorts text by a language's rules** (a collation such as `en_US.UTF-8`). Metabase reads them when it scans
  a table, and for a table's preview. Over 4.5 million rows they took 5 to 19 seconds, and now take 0.1 to 2 seconds.
  The slowest case was a column where most rows hold the same value, such as a status. The answers are the same as
  before. A list of distinct values, a smallest value per group and `FETCH FIRST … WITH TIES` are still slow.
