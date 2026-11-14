The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **The smallest and largest value of a text column, and a page sorted by one, are many times faster when your
  database sorts text by a language's rules** (a collation such as `en_US.UTF-8`). Metabase reads them when it scans
  a table, and for a table's preview. Over 4.5 million rows they took 5 to 19 seconds, and now take 0.1 to 2 seconds.
  The slowest case was a column where most rows hold the same value, such as a status. The answers are the same as
  before. A list of distinct values, a smallest value per group and `FETCH FIRST … WITH TIES` are still slow.
