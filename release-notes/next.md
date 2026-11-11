The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- A preview of a join with a LIMIT and no ORDER BY (`SELECT a.*, b.* FROM a LEFT JOIN b ON a.id = b.a_id LIMIT 100`,
  what a BI tool sends to show a table) now stops as soon as it has its rows. Before, where each join matched on a
  primary key, Mason sorted every row of the join to keep its pages stable. That took seconds to tens of seconds over a
  table of a hundred million rows; now it takes milliseconds. The pages of such a statement may now overlap, as they
  already could over other joins: `LIMIT n OFFSET m` with no ORDER BY can show a row twice and skip another, as SQL and
  Postgres allow. Add an ORDER BY where the pages matter.

- A page of a LEFT JOIN sorted by the left table's columns (`SELECT … FROM a LEFT JOIN b ON a.id = b.a_id ORDER BY
  a.created_at DESC LIMIT 100`, a filter on `a` allowed) now sorts only the left table's first rows, then joins them,
  instead of joining and sorting every row of `b`. Over 25 thousand × 30 million rows it took about a fifth of the time
  (0.9 s to 0.2 s, warm). It still reads `b`'s join column whole, so on a cold disk a table of a hundred million rows
  still takes seconds. A sort by `b`'s columns, an inner join and a filter on `b` are unchanged.

- How long a statement took, and the average, p50 and p95 of those times, are now always whole milliseconds with
  thousands separators (`19,800 ms`, `810 ms`, `27 ms`), so a column of them can be compared at a glance. Before, the
  unit changed at a second and at a minute (`19.8 s`, `2 min 5 s`). This applies on the web page (Observability ›
  Queries' Duration, the Overview's p95 card, statements table and query errors, Usage's cards, hours, p95 chart
  read-out and slowest statements) and in the text of `mason logs --requests`, `mason status` and `mason usage`.
  `--json` still gives numbers. A chart's axis, a statement still running, a sync's time, an interval and an age keep
  their form. On Observability › Queries, the Statement cell
  now has its own `+` beside the statement. It opens and closes the same row as the Query id's `+`.
