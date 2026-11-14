The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A whole number beside a decimal column no longer loses the column's decimals.** This covers `div()` of two
  integers, an integer cast to `numeric`, a whole constant such as `2.5e2`, and a whole part of `extract`. When one
  met a decimal column in an `IN (SELECT …)`, a `UNION`, an `INTERSECT`, a `CASE`, a `COALESCE` or `GREATEST`, the
  column's decimals were rounded away with no error. So `a IN (SELECT div(i, 7) …)` matched 0.01 to 0, and rows came
  back in the wrong order. Now the answer is Postgres's.
