The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Two sync event kinds have new names.** `copied` is now `full_sync`, and `copy_failed` is now `full_sync_failed`.
  You see them in `mason logs --events` and its `--json`, in `mason status` (its Sync errors section, and
  `recentErrors` in its `--json`) and in the web page's Syncs filter. If a script or an alert filters on the old names,
  change it. Events recorded before the upgrade keep their old names. They still show in the full list, but an old
  `copy_failed` no longer counts as a failure.

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
- **The SQL support list now says plainly what Mason prints for a `numeric` column with no precision.** Rails makes
  one from `t.decimal`. Mason prints every value of such a column with the most decimals any of its values has, so
  `12.5` reads `12.50` and `0` reads `0.00`. The values are right. Only their trailing zeros differ from Postgres's.
  This was listed before, but it was hard to find. To get the same text from Mason and Postgres now, cast the column
  to `numeric(p, s)` or use `round(x, s)`. A fix is planned.

## What was wrong and is now right

- **A table's columns dialog on the web page now names the choice its row names.** On the Tables page, a table that
  leaves out columns which look like secrets says "All but 7 columns". Its columns dialog said "All columns, … but
  password, …", so it read like a different choice. Now the dialog's choice starts with the same words, "All but 7
  columns", and names the columns left out.

- **A polled table no longer costs an extra connection to your database now and then.** On some machines, Mason's
  timer for the next poll woke a moment early. Mason then connected to your database, found no table due yet, and
  connected again a moment later to poll it. Now every timer waits until its time has come.
- **Mason no longer leaves a time limit on your database's pooled connections.** When the web page checked whether a
  table could be kept current by replication, Mason set a 10-second time limit on its connection and never took it off.
  Behind a pooler in transaction mode (PgBouncer, or Supabase's default pooler URL), that connection is handed on to
  your application next. Your application's queries could then be cancelled after 10 seconds, for up to an hour.
  `mason mcp` did the same on Mason's own Postgres API with each tool call's time limit. Now each limit ends with
  Mason's own query, whatever pooler sits in between.
