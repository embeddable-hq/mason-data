The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Metabase's preview of a join to a table with JSON fields is faster.** When you join a table in Metabase's query
  builder and show fields it unfolds from a JSON column, the preview is a `LIMIT 2000` with no sort. Mason now gathers
  the rows the preview shows before it reads those fields, so it reads them in a few large batches. Over a 3 M-row
  table, the 2,000-row preview took about 5 s and now takes about 0.6 s. Postgres still answers it faster, so there is
  more to do. The rows are the same kind as before: any rows of the join, as Postgres allows for a query with no ORDER
  BY.

## What was wrong and is now right

- **A `numeric` column with no precision now prints each value as your database does.** Rails makes such a column from
  `t.decimal`. Mason printed every value with the most decimals any value in the column had, so `12.5` read `12.50` and
  `0` read `0.00`. Now a plain `SELECT`, `::text`, arithmetic, `sum`, `min`, `max`, windows, subqueries and the binary
  wire all give your database's text. A few readers still print the old way: `to_json` and its kin, `concat`,
  `format`, `||`, `array_agg`, a row's text, and a `UNION` without `ALL`. A fix for those is planned.
  - **Before upgrading:** each synced table with such a column is synced again once, at the first start. It serves
    its old data until then. A large table takes as long as its first sync did.
- **A polled table no longer costs an extra connection to your database now and then.** On some machines, Mason's
  timer for the next poll woke a moment early. Mason then connected to your database, found no table due yet, and
  connected again a moment later to poll it. Now every timer waits until its time has come.
- **Mason no longer leaves a time limit on your database's pooled connections.** When the web page checked whether a
  table could be kept current by replication, Mason set a 10-second time limit on its connection and never took it off.
  Behind a pooler in transaction mode (PgBouncer, or Supabase's default pooler URL), that connection is handed on to
  your application next. Your application's queries could then be cancelled after 10 seconds, for up to an hour.
  `mason mcp` did the same on Mason's own Postgres API with each tool call's time limit. Now each limit ends with
  Mason's own query, whatever pooler sits in between.
