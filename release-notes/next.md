The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The smallest and largest value of a text column, and a page sorted by one, are many times faster when your
  database sorts text by a language's rules** (a collation such as `en_US.UTF-8`). Metabase reads them when it scans
  a table, and for a table's preview. Over 4.5 million rows they took 3 to 22 seconds, and now take 0.2 to 3 seconds.
  The slowest case was a column where most rows hold the same value, such as a status. Over 30 million names they took
  2 to 4.5 minutes, close to the 5-minute limit, and now take 13 to 26 seconds. Names that begin with an accented
  letter, such as É, Ø or Ł, are as fast as the rest. The answers are the same as before. A list of distinct values,
  a smallest value per group and `FETCH FIRST … WITH TIES` are still slow.
- **Listing a JSON column's keys is now about as fast as on Postgres.** `jsonb_object_keys` and `json_object_keys` of a
  column took 16 to 70 times as long as on Postgres, grouped as Metabase sends it, with `DISTINCT`, or in a `LEFT JOIN
  LATERAL`. Over about 5 million rows they timed out. While one ran, a small query in another session waited up to 8
  seconds. Over 3 million rows they now take 3 to 5 seconds, a little less than Postgres, and other queries no longer
  wait. This holds for a synced table's column, and for a generated table's `json` column.

## What was wrong and is now right

- **A generated table's `jsonb` column now answers as Postgres does when its SQL wrote a key twice.** For example,
  `jsonb_build_object('a', 1, 'a', 2)` keeps only the last `a` in Postgres. Mason kept both. `->` read the first one,
  and `@>` checked against the first one, so both could answer wrong. Now they answer as Postgres does. To be right,
  Mason now reads a generated table's `jsonb` the slow way: `->`, `->>`, `@>`, `IS NULL` of a path and
  `jsonb_object_keys` over it can take longer than before.
