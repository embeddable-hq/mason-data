The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A JSON field read through a path your tool sends as a parameter is now as fast as one written in the query.**
  Metabase sends the path of every JSON field it unfolds as a parameter (`payload #>> array[$1]::text[]`). Mason used
  to read such a path row by row in its slowest way, so a card grouped by a JSON field took 10 to 18 times as long as
  on Postgres. Mason now reads the path's value when the query runs and answers it like a path written in the query:
  that card now takes about twice Postgres's time.

## What was wrong and is now right

- **A table kept current by `sync: replication` is no longer called current while Mason compacts it.** During a
  compaction, the newest changes to the table wait until it ends, and queries read the rows as they were. Before, `mason
  status`, `mason wait` and the web page said the table was synced as of the newest change. Now its line says it is
  being compacted and when it was last synced, and that time moves on only once the waiting changes are in. If the
  compaction takes longer than two minutes, the table shows as behind until it ends. No data was ever lost.
