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

- **A list of values passed as one query parameter now works, as node-pg passes it.** node-pg, and the ORMs built on
  it, send a JavaScript array as text such as `{"1","3"}`, and let the database work out its type. Mason answered
  `WHERE id = ANY($1)` and `WHERE id = ANY($1::int[])` with an error for such a value. Now it answers them as Postgres
  does, for arrays of integers, text, uuids, numerics, booleans, dates, timestamps and floats. That includes an empty
  array, NULL elements and quoted elements that hold commas or braces. An array sent in binary, as Npgsql sends it,
  works too.
- **A `numeric[]` parameter is compared with every digit kept.** This holds for a numeric or an integer column, in
  `= ANY`, `<> ALL` and the other comparisons with `ANY` or `ALL`. So does `x = ANY(ARRAY[$1::numeric, $2::numeric])`,
  which matched values that differ past the 15th digit. A NULL `numeric[]` is answered everywhere. Mason refuses any
  other `numeric[]` value by name, and says what to write instead, in two places. One is a `numeric[]` read anywhere
  else, such as in the SELECT list or in `unnest`. The other is a `numeric[]` compared with a float column.
- **A timestamp with time zone compared with `ANY` or `ALL` of a `timestamp[]` or `date[]` now uses your session's time
  zone.** Before, a session outside UTC got other rows. The same holds for a timestamp or a date compared with an
  array of a wider time type.
- **A table under `sync: replication` no longer blocks `ALTER TABLE … DROP COLUMN` on your database.** On Postgres 15
  and later, the publication Mason makes for itself listed each table's columns. So your database refused to drop a
  listed column, with "publication … depends on column", and never sent a column added later. Mason's publication now
  names each table whole. Mason updates a publication it made before at its first start after the upgrade, once,
  while it keeps syncing. Columns a table's entry leaves out, with `exclude:` or `columns:`, now reach Mason over
  replication. Mason drops them as they arrive. They are never stored, logged or served. A publication you name with
  `publication:` is still never changed. If it lists a table's columns, Mason now says once that the list blocks
  `DROP COLUMN`, and how to name the table whole. This was listed as known in 0.20.0.
