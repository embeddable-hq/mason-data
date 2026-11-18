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
- **`mason login` and `mason logout` name the hosted service Mason Cloud** in their help, with its address
  (https://app.masondata.ai) and `MASON_CLOUD_URL` for another service. What they do is unchanged.

## What was wrong and is now right

- **The web page's Users list cut "not used in the last 7 days" short, with no way to read it.** Its Last used column
  is narrower than those words. Now a hover shows them whole, as it does for every other value a list cuts.
