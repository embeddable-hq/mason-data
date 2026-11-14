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

- **A numeric column of a subquery whose name has a space in it now keeps its exact value.** Metabase names a JSON
  field it unfolds `"meta → n"`, and a custom column can be `"Unit Price"`. When the outer query read such a column, Mason
  could print the subquery's numeric with the wrong digits. `1000000000.00` came back as `1000000000`, and `x / 3` had
  15 digits where Postgres gives 20. Whether a query was hit depended on its length, so a small edit could hide it. Now
  every such name is read exactly, one with a line break or a no-break space in it included.
