The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A JSON field read through a path your tool sends as a parameter is now as fast as one written in the query.**
  Metabase sends the path of every JSON field it unfolds as a parameter (`payload #>> array[$1]::text[]`). Mason used
  to read such a path row by row in its slowest way, so a card grouped by a JSON field took 10 to 18 times as long as
  on Postgres. Mason now reads the path's value when the query runs and answers it like a path written in the query:
  that card now takes about twice Postgres's time.
- **A chart that groups a number into bins is now faster than on Postgres.** Metabase bins a number column as
  `floor((x - min) / width) * width + min`, for its X-rays' "by value" cards and for a binned field of a joined table.
  Mason used to work out each row's bin in its slowest way, so over 12 million rows such a card took 16 to 25 times as
  long as on Postgres, and on a big table it ran past the statement timeout. Mason now works out the bin in the synced
  data's own exact arithmetic, for columns of `numeric(p, s)` and the integer types. The answers are the same as before,
  to the last digit.

## What was wrong and is now right

- **A table kept current by `sync: replication` is no longer called current while Mason compacts it.** During a
  compaction, the newest changes to the table wait until it ends, and queries read the rows as they were. Before, `mason
  status`, `mason wait` and the web page said the table was synced as of the newest change. Now its line says it is
  being compacted and when it was last synced, and that time moves on only once the waiting changes are in. If the
  compaction takes longer than two minutes, the table shows as behind until it ends. No data was ever lost.
- **Tables under `sync: replication` no longer stop being kept current after the replication slot is dropped.** If the
  slot was dropped while Mason ran, the stream stopped and waited a moment before it started again. Something else
  that asked for a sync during that moment could cancel the restart. The stream then stayed stopped for the rest of
  the run, and the tables kept serving old rows, with no error. Now the stream always starts again by itself.
- **Under `sync: replication`, a table whose sync failed is always tried again.** When two tables' syncs failed at
  different times, the one due to be tried later could wait until Mason started again. Now each is tried again at its
  own time.
