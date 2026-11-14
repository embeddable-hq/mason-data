The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Metabase's preview of a join to a table with JSON fields is faster.** When you join a table in Metabase's query
  builder and show fields it unfolds from a JSON column, the preview is a `LIMIT 2000` with no sort. Mason now gathers
  the rows the preview shows before it reads those fields, so it reads them in a few large batches. Over a 3 M-row table, the 2,000-row preview took about 5 s and now
  takes about 0.6 s. Postgres still answers it faster, so there is more to do. The rows are the same kind as before: any
  rows of the join, as Postgres allows for a query with no ORDER BY.
