The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Heavy queries take turns, so many at once no longer spill to disk.** A heavy query keeps many rows in memory: a
  join of two large tables, or a group by, distinct or sort that keeps many rows. A few heavy queries run at
  once, and the rest wait their turn. Before, ten clients that each sent a join of 100 M orders to 5 M customers at once
  took 11 minutes. Together the joins did not fit in memory, so Mason wrote 48.7 GB to disk and read most of it back.
  Four at a time took about 40 s.
  - A light query never waits. A lookup by key, a filter, a count and a group by into a few groups are light, however
    many rows they read.
  - By default one heavy query runs for each GiB of `MASON_DUCKDB_MEMORY`, at most one for each CPU and at least one.
    `MASON_HEAVY_QUERIES` sets the number. `mason start` and `mason serve` say it as they start.
  - A query can be cancelled while it waits. Its `statement_timeout` counts the wait. Either ends it with SQLSTATE
    57014, as Postgres does.
  - The request log has a new column, `waited_ms`: how long a heavy query waited for its turn. It is empty for a
    light query. `mason logs --requests --id <request>` shows it.
- **Short text columns are stored many times smaller, so a dashboard that groups or filters on them reads less.** When
  Mason syncs a table, it now chooses how to compress each text column from a sample of its values. A column of short
  or repeated values, such as a status, a type, a country code or a name, is stored with a dictionary. Values of 64 bytes
  or more that do not repeat, such as JSON documents, are stored as before. On a benchmark of 100 M orders, a status column of six
  values went from 645 MB to 41 MB, and a count by status read from disk went from 4.03 s to 0.17 s. The answers are
  the same.
  - The upgrade reads no table again. A table synced before keeps how it is stored until it is synced again whole, or
    until Mason compacts it. Mason compacts a table by itself once much of its space is deleted rows.
  - To apply it to a table now, sync it again whole. With Mason running, run `mason remove <table>`. Wait until
    `mason logs` shows `dropped <table>'s synced data`, then run `mason add <table>`. The table is not served in
    between.
  - Generated tables are stored as before.
- **A group by month, week, day or hour of a `timestamptz` column is faster in a time zone other than UTC.** Mason now
  syncs each such column with a small hidden number beside it: the 15 minutes of UTC its value falls in. A query that
  groups by a unit of the column groups by that number first, and works out each group's local month once, not once a
  row. It reads that number and not the time, so a query read from disk reads much less. On 50 M orders in
  `Asia/Kathmandu`, revenue by month went from 456 ms to 60 ms, and from 5.1 s to 0.6 s with ten clients at once. The
  answers are the same, in every zone.
  - In UTC, a query runs as before, since it is already fast there.
  - A table with a time before 1980 or an infinite one still reads the time of those rows.
  - The synced data grows by about 5%, and the first sync takes about 7% longer.
  - The upgrade reads no table again. A table synced before keeps running its queries as before, until it is synced
    again whole.
- **`mason login` and `mason logout` name the hosted service Mason Cloud** in their help, with its address
  (https://app.masondata.ai) and `MASON_CLOUD_URL` for another service. What they do is unchanged.

## What was wrong and is now right

- **The web page's Users list cut "not used in the last 7 days" short, with no way to read it.** Its Last used column
  is narrower than those words. Now a hover shows them whole, as it does for every other value a list cuts.
