The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

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

- **A numeric column of a subquery whose name has a space in it now keeps its exact value.** Metabase names a JSON
  field it unfolds `"meta → n"`, and a custom column can be `"Unit Price"`. When the outer query read such a column, Mason
  could print the subquery's numeric with the wrong digits. `1000000000.00` came back as `1000000000`, and `x / 3` had
  15 digits where Postgres gives 20. Whether a query was hit depended on its length, so a small edit could hide it. Now
  every such name is read exactly. A column whose own name holds a line break, read through a `*`, can still be
  refused by name (`name-unreadable`) where Mason cannot tell its name apart. Name the column in the query to have it
  answered.

- **A polled table no longer costs an extra connection to your database now and then.** On some machines, Mason's
  timer for the next poll woke a moment early. Mason then connected to your database, found no table due yet, and
  connected again a moment later to poll it. Now every timer waits until its time has come.
- **Mason no longer leaves a time limit on your database's pooled connections.** When the web page checked whether a
  table could be kept current by replication, Mason set a 10-second time limit on its connection and never took it off.
  Behind a pooler in transaction mode (PgBouncer, or Supabase's default pooler URL), that connection is handed on to
  your application next. Your application's queries could then be cancelled after 10 seconds, for up to an hour.
  `mason mcp` did the same on Mason's own Postgres API with each tool call's time limit. Now each limit ends with
  Mason's own query, whatever pooler sits in between.
