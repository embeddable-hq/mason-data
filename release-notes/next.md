The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **Mason no longer leaves a time limit on your database's pooled connections.** When the web page checked whether a
  table could be kept current by replication, Mason set a 10-second time limit on its connection and never took it off.
  Behind a pooler in transaction mode (PgBouncer, or Supabase's default pooler URL), that connection is handed on to
  your application next. Your application's queries could then be cancelled after 10 seconds, for up to an hour.
  `mason mcp` did the same on Mason's own Postgres API with each tool call's time limit. Now each limit ends with
  Mason's own query, whatever pooler sits in between.
- **A whole number beside a decimal column no longer loses the column's decimals.** This covers `div()` of two
  integers, an integer cast to `numeric`, a whole constant such as `2.5e2`, and a whole part of `extract`. When one
  met a decimal column in an `IN (SELECT …)`, a `UNION`, an `INTERSECT`, a `CASE`, a `COALESCE` or `GREATEST`, the
  column's decimals were rounded away with no error. So `a IN (SELECT div(i, 7) …)` matched 0.01 to 0, and rows came
  back in the wrong order. Now the answer is Postgres's.
