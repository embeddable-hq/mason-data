The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Two sync event kinds have new names.** `copied` is now `full_sync`, and `copy_failed` is now `full_sync_failed`.
  You see them in `mason logs --events`, its `--json` and the web page's Syncs filter. If a script or an alert filters
  on the old names, change it. Events recorded before the upgrade keep their old names. They
  still show in the full list, but an old `copy_failed` no longer counts as a failure.

## What changes

- **Metabase's preview of a join to a table with JSON fields is faster.** When you join a table in Metabase's query
  builder and show fields it unfolds from a JSON column, the preview is a `LIMIT 2000` with no sort. Mason now gathers
  the rows the preview shows before it reads those fields, so it reads them in a few large batches. Over a 3 M-row
  table, the 2,000-row preview took about 5 s and now takes about 0.6 s. Postgres still answers it faster, so there is
  more to do. The rows are the same kind as before: any rows of the join, as Postgres allows for a query with no ORDER
  BY.

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
