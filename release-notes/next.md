The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A failed sync event now says its code and where it happened.** `mason logs --events --json` and `/api/events` give
  each failure a `code` and an `origin`. The code is the error's SQLSTATE when your database failed it, the system's
  error when the network or the disk did (`ECONNREFUSED`, `ENOSPC`), or the error's class (`conversion_error`). It is
  `unknown` when none of these is known. The origin is a file and a line in Mason's code, such as
  `src/duck/sync.ts:3637`. Group failures by the code, and give the origin when you report one. Good news has neither.
  The Sync events page shows both under a failure's message.
- **A query that failed inside Mason now says where.** A request-log row answered `XX000` has an `origin` in
  `mason logs --requests --json` and `/api/requests`. Every other row has none.
- Both are new keys. Events and requests recorded before you upgrade are kept, and read with both null.
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
