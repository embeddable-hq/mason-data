The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Each synced table with a `numeric` column of no precision is synced again once, at the first start.** Mason now
  keeps each such value's own decimals (below), which the data synced before does not hold. The table serves its old
  data until then, and a large table takes about as long as its first sync did.

## What was wrong and is now right

- **A `numeric` column with no precision now prints each value as your database does.** Rails makes such a column from
  `t.decimal`. Mason printed every value with the most decimals any value in the column had, so `12.5` read `12.50` and
  `0` read `0.00`. Now a plain `SELECT`, `::text`, arithmetic, `sum`, `min`, `max`, windows, subqueries and the binary
  wire all give your database's text. A few readers still print the old way: `to_json` and its kin, `concat`,
  `format`, `||`, `array_agg`, a row's text, a scalar subquery, and a `UNION` without `ALL`. A fix for those is planned.
