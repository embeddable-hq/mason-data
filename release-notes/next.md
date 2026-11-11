The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- A preview of a join with a LIMIT and no ORDER BY (`SELECT a.*, b.* FROM a LEFT JOIN b ON a.id = b.a_id LIMIT 100`,
  what a BI tool sends to show a table) now stops as soon as it has its rows. Before, where each join matched on a
  primary key, Mason sorted every row of the join to keep its pages stable. That took seconds to tens of seconds over a
  table of a hundred million rows; now it takes milliseconds. The pages of such a statement may now overlap, as they
  already could over other joins: `LIMIT n OFFSET m` with no ORDER BY can show a row twice and skip another, as SQL and
  Postgres allow. Add an ORDER BY where the pages matter.

- How long a statement took, and the average, p50 and p95 of those times, are now always whole milliseconds with
  thousands separators (`19,800 ms`, `810 ms`, `27 ms`), so a column of them can be compared at a glance. Before, the
  unit changed at a second and at a minute (`19.8 s`, `2 min 5 s`). This applies on the web page (Observability ›
  Queries' Duration, the Overview's p95 card, statements table and query errors, Usage's cards, hours, p95 chart
  read-out and slowest statements) and in the text of `mason logs --requests`, `mason status` and `mason usage`.
  `--json` still gives numbers. A chart's axis, a statement still running, a sync's time, an interval and an age keep
  their form. On Observability › Queries, the Statement cell
  now has its own `+` beside the statement. It opens and closes the same row as the Query id's `+`.

## What was wrong and is now right

- The Overview's "The synced data's file" card, `mason status`, `mason usage` and `mason_copy_bytes` now count the synced
  data's write-ahead log: they read 12 KiB for a file whose log held 1.3 MB.
- A small synced table's size is shown once its rows are written into the file, which happens when the write-ahead log
  passes 16 MiB or Mason stops. Until then the Tables view and `mason usage` say so. Before, the page said the size was
  coming at the next measurement, and for a small table it could never come.
