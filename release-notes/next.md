The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A whole number beside a numeric with very many decimals keeps at least 19 of its decimals.** This covers `div()`
  of two integers, an integer cast to `numeric`, a whole constant such as `2.5e2`, and a whole part of `extract`.
  Beside a column like `numeric(38,30)`, in a `UNION`, an `IN`, a `CASE`, a `COALESCE` or `GREATEST`, Mason keeps
  every digit before the point and the column's first 19 decimals, and rounds the rest. Postgres keeps all 30. A
  number of 1 or more is the same to at least 19 significant digits. A smaller one is the same to its first 19
  decimals, so a value smaller than 0.00000000000000000005 reads 0. Values that differ only after the 19th decimal
  compare equal: `UNION` and `DISTINCT` merge them, and `IN` and a join match them. Before, Mason rounded away every
  decimal there. To get Postgres's rows exactly, cast the column to 18 decimals or fewer first, such as
  `::numeric(38,18)`.
- **The smallest and largest value of a text column, and a page sorted by one, are many times faster when your
  database sorts text by a language's rules** (a collation such as `en_US.UTF-8`). Metabase reads them when it scans
  a table, and for a table's preview. Over 4.5 million rows they took 3 to 22 seconds, and now take 0.2 to 3 seconds.
  The slowest case was a column where most rows hold the same value, such as a status. Over 30 million names they took
  2 to 4.5 minutes, close to the 5-minute limit, and now take 13 to 26 seconds. Names that begin with an accented
  letter, such as É, Ø or Ł, are as fast as the rest. The answers are the same as before. A list of distinct values,
  a smallest value per group and `FETCH FIRST … WITH TIES` are still slow.

## What was wrong and is now right

- **A whole number beside a decimal column no longer loses the column's decimals.** This covers `div()` of two
  integers, an integer cast to `numeric`, a whole constant such as `2.5e2`, and a whole part of `extract`. When one
  met a decimal column in an `IN (SELECT …)`, a `UNION`, an `INTERSECT`, an `EXCEPT`, a `CASE`, a `COALESCE` or
  `GREATEST`, the column's decimals were rounded away with no error. So `a IN (SELECT div(i, 7) …)` matched 0.01 to 0,
  and rows came back wrong or in the wrong order. Now the rows are Postgres's. A `UNION`, `INTERSECT` or `EXCEPT`
  without `ALL` still prints every row at one scale, the widest (`3.00` where Postgres prints `3`), as listed.
