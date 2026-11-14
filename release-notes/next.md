The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Metabase's preview of a join to a table with JSON fields is faster.** When you join a table in Metabase's query
  builder and show fields it unfolds from a JSON column, the preview is a `LIMIT 2000` with no sort. Mason now gathers
  the rows the preview shows before it reads those fields, so it reads them in a few large batches. Over a 3 M-row
  table, the 2,000-row preview took about 5 s and now takes about 0.6 s. Postgres still answers it faster, so there is
  more to do. The rows are the same kind as before: any rows of the join, as Postgres allows for a query with no ORDER
  BY.

- **Three shapes Metabase and other BI tools send are faster.** A count grouped by `to_char(created_at, 'YYYY-MM')`
  over 4.5 M rows took 23–29 s and now takes under a second, about a quarter of Postgres's time. Formats with a
  quarter (`Q`), a padded month name or an ordinal (`DDth`) are still slow. Metabase's week of the year over 12 M rows
  now takes about 1 s, where Postgres takes about 4.5 s. A query that returns many `timestamptz` values in a session in
  UTC sends them about three times as fast: 300,000 rows of a `DISTINCT ON` took 10 s and now take under 3 s, about
  Postgres's time. In a session in another time zone, those values are still slow to send.

## What was wrong and is now right

- **A polled table no longer costs an extra connection to your database now and then.** On some machines, Mason's
  timer for the next poll woke a moment early. Mason then connected to your database, found no table due yet, and
  connected again a moment later to poll it. Now every timer waits until its time has come.
- **Mason no longer leaves a time limit on your database's pooled connections.** When the web page checked whether a
  table could be kept current by replication, Mason set a 10-second time limit on its connection and never took it off.
  Behind a pooler in transaction mode (PgBouncer, or Supabase's default pooler URL), that connection is handed on to
  your application next. Your application's queries could then be cancelled after 10 seconds, for up to an hour.
  `mason mcp` did the same on Mason's own Postgres API with each tool call's time limit. Now each limit ends with
  Mason's own query, whatever pooler sits in between.
