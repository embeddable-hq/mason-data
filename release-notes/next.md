The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The smallest and largest value of a text column, and a page sorted by one, are many times faster when your
  database sorts text by a language's rules** (a collation such as `en_US.UTF-8`). Metabase reads them when it scans
  a table, and for a table's preview. Over 4.5 million rows they took 3 to 22 seconds, and now take 0.2 to 3 seconds.
  The slowest case was a column where most rows hold the same value, such as a status. Over 30 million names they took
  2 to 4.5 minutes, close to the 5-minute limit, and now take 13 to 26 seconds. Names that begin with an accented
  letter, such as É, Ø or Ł, are as fast as the rest. The answers are the same as before. A list of distinct values,
  a smallest value per group and `FETCH FIRST … WITH TIES` are still slow.

## What was wrong and is now right

- **A column added to, renamed in or dropped from a synced table on your database now reaches Mason without a restart.**
  Before, a new column never reached the synced data until Mason was started again, while `mason status` said every
  table was synced. A column renamed or dropped made the table's sync fail again and again until a restart. Now Mason
  checks the table's columns before each poll, at `mason sync` and when the change log says the table changed. The
  check reads only the database's catalog. When the columns changed, Mason syncs that table again whole, and serves its
  old data until that ends. A new column that looks like a secret, such as `api_token`, is left out, as `mason add`
  leaves it out. Mason writes `exclude:` on the table's entry in the sources file, and says so in its log, its events
  and `mason status`. To sync it, run `mason add <table> --include <column>`.
  A publication you name in the sources file (`publication:`) is never changed by Mason. If it lists a table's columns,
  Postgres does not send a new column, so Mason stops keeping that table current and says the `ALTER PUBLICATION` line
  that adds the column.
