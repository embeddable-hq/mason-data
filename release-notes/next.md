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

- **A table under `sync: replication` no longer blocks `ALTER TABLE … DROP COLUMN` on your database.** On Postgres 15
  and later, the publication Mason makes for itself listed each table's columns. So your database refused to drop a
  listed column, with "publication … depends on column", and never sent a column added later. Mason's publication now
  names each table whole. Mason updates a publication it made before at its first start after the upgrade, once,
  while it keeps syncing. Columns a table's entry leaves out, with `exclude:` or `columns:`, now reach Mason over
  replication. Mason drops them as they arrive. They are never stored, logged or served. A publication you name with
  `publication:` is still never changed. If it lists a table's columns, Mason now says once that the list blocks
  `DROP COLUMN`, and how to name the table whole. This was listed as known in 0.20.0.
- **A column added to, renamed in or dropped from a synced table on your database now reaches Mason without a restart.**
  Before, a new column never reached the synced data until Mason was started again, while `mason status` said every
  table was synced. A column renamed or dropped made the table's sync fail again and again until a restart. Now Mason
  checks the table's columns before each poll, at `mason sync` and when the change log says the table changed. The
  check reads only the database's catalog. When the columns changed, Mason syncs that table again whole, and serves its
  old data until that ends. A new column that looks like a secret, such as `api_token`, is left out, as `mason add`
  leaves it out. Mason writes `exclude:` on the table's entry in the sources file, and says so in its log, its events
  and `mason status`. To sync it, run `mason add <table> --include <column>`.
  A column that the sources file names in `exclude:` or `columns:` and that your database dropped no longer stops Mason
  from starting. Mason passes over the name, says so in `mason status`, and syncs the table with the columns it has. A
  name that is close to a column, such as a typo, is still refused, with the name it is close to.
  A publication you name in the sources file (`publication:`) is never changed by Mason. If it lists a table's columns,
  Postgres does not send a new column, so Mason stops keeping that table current and says the `ALTER PUBLICATION` line
  that adds the column.
