The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`--remote` is gone.** `mason init` and `mason start` no longer stop for a database on another machine. They carry
  on, and say once: "Your database is on another machine. Mason will sync the tables you choose to this machine." Drop
  `--remote` from your scripts: `mason init --remote` now fails as an unknown option (exit 2). An older
  `.mason/config.json`'s `"remote"` key is ignored, and `mason serve` no longer writes it.
- **Your main database is information, not a warning.** `mason init`, and `mason start` until the first sync is done,
  say: "This is your main database, not a read replica. Mason only reads from it and keeps its load small. If you have
  a read replica, you can point Mason there instead." Neither this line nor the one above is a Warning row of `mason
  status`, or in `--json`'s `warnings`. `mason status`'s Database line now ends with "your main database" or "a read
  replica", as the web page's does. `mason init --json` has a new `notes` list for these lines.
- **A password in `mason init`'s URL is a tip, not a warning.** It says your shell's history now holds the password,
  and that next time you can put the URL in `.env`.
- **`mason doctor` no longer warns about CREATE in schema `public` on Postgres before 15** when that is only Postgres's
  own default, which every role has. It says so as information. A grant someone made, or a schema the role owns, is
  still a warning.
- **Calmer words.** The note for a serverless database (Neon, Aurora Serverless) now names everything that keeps it
  awake, Mason's own read of the database's tables every 10 seconds included. `mason share` says it is for trying
  Mason out. A table's line says "not kept current" in lower case.

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
