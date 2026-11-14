The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Allow for a longer first start if a generated table has a `jsonb` column.** At Mason's first start after the
  upgrade, Mason rewrites each such table's `jsonb` values once, in the form Postgres stores them. This takes about 30
  to 45 seconds a million rows on a 4-core machine. Nothing is served until it is done, and `/healthz` answers 503
  meanwhile. The log names each table rewritten. If your platform restarts a container that stays unhealthy, give the
  first start room in its health check for your largest generated tables. The image's own check gives up after about
  2 minutes 45 seconds, which is about 4 million rows.
- **Each synced table with a `numeric` column of no precision is synced again once, at the first start.** Mason now
  keeps each such value's own decimals (below), which the data synced before does not hold. The table serves its old
  data until then, and a large table takes about as long as its first sync did.

## What changes

- **A whole number beside a numeric with very many decimals keeps at least 19 of its decimals.** This covers `div()`
  of two integers, an integer cast to `numeric`, a whole constant such as `2.5e2`, and a whole part of `extract`.
  Beside a column like `numeric(38,30)`, in a `UNION`, an `IN (SELECT …)`, a `CASE`, a `COALESCE` or `GREATEST`,
  Mason keeps every digit before the point and the column's first 19 decimals, and rounds the rest. Postgres keeps
  all 30. A number of 1 or more is the same to at least 19 significant digits. A smaller one is the same to its
  first 19 decimals, so a value smaller than 0.00000000000000000005 reads 0. Beside a sum of whole numbers, Mason
  keeps 10 decimals.
  - Values that differ only after the decimals kept compare equal: `UNION` and `DISTINCT` merge them, and `IN` and a
    join match them.
  - Before, Mason rounded away every decimal there.
  - Comparing such a column with `=`, or with an `IN` list of constants, to a whole number that does not fit its type
    still fails with `numeric field overflow`, as before.
  - To get Postgres's rows exactly, cast the column to 18 decimals or fewer first, such as `::numeric(38,18)`.
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
  wait. This holds for a synced table's JSON columns and a generated table's alike.
- **The host's card (`MASON_UI_OVERVIEW_CARD`) is now the first thing on the web page's Overview**, above Mason's own
  cards, at the full width. A host with nothing to say answers `{ "refresh": 60, "sections": [] }`, and the title may
  be left out. The Overview then draws no card at all, and reads the path again at its `refresh`, so a card added
  later shows up on the next read. A read that fails is still shown in the card. Before, an empty answer drew a box
  with only its title, and the card came last.
- **On a server that runs the project read-only, the web page links to how to deploy a change.** `mason status --json`
  words `sourcesReadOnly` as plain sentences now, so a script that matched its old text must match the new one. A new
  field, `sourcesReadOnlyKind`, says which reason it is: `deployed`, `unwritable` or `unknown`.

## What was wrong and is now right

- **A `numeric` column with no precision now prints each value as your database does.** Rails makes such a column from
  `t.decimal`. Mason printed every value with the most decimals any value in the column had, so `12.5` read `12.50` and
  `0` read `0.00`. Now a plain `SELECT`, `::text`, arithmetic, `sum`, windows, subqueries and the binary
  wire all give your database's text. A few readers still print the old way: `to_json` and its kin, `concat`,
  `format`, `||`, `array_agg`, a row's text, a scalar subquery, `min`, `max`, `percentile_disc`, `mode()`, `sum(DISTINCT …)`, a
  `UNION` without `ALL`, and a generated table's column. `docs/SQL-SUPPORT.md` lists them all, under
  `mixed-scale-numeric`. A fix for most of them is planned.
- **A whole number beside a decimal column no longer loses the column's decimals.** This covers `div()` of two
  integers, an integer cast to `numeric`, a whole constant such as `2.5e2`, and a whole part of `extract`. When one
  met a decimal column in an `IN (SELECT …)`, a `UNION`, an `INTERSECT`, an `EXCEPT`, a `CASE`, a `COALESCE` or
  `GREATEST`, the column's decimals were rounded away with no error. So `a IN (SELECT div(i, 7) …)` matched 0.01 to 0,
  and rows came back wrong or in the wrong order. Now the rows are Postgres's. A `UNION`, `INTERSECT` or `EXCEPT`
  without `ALL` still prints every row at one scale, the widest (`3.00` where Postgres prints `3`), as listed.
- **A table under `sync: replication` no longer blocks `ALTER TABLE … DROP COLUMN` on your database.** On Postgres 15
  and later, the publication Mason makes for itself listed each table's columns. So your database refused to drop a
  listed column, with "publication … depends on column", and never sent a column added later. Mason's publication now
  names each table whole. Mason updates a publication it made before at its first start after the upgrade, once,
  while it keeps syncing. Columns a table's entry leaves out, with `exclude:` or `columns:`, now reach Mason over
  replication. Mason drops them as they arrive. They are never stored, logged or served. A publication you name with
  `publication:` is still never changed. If it lists a table's columns, Mason now says once that the list blocks
  `DROP COLUMN`, and how to name the table whole. This was listed as known in 0.20.0.
- **A generated table's `jsonb` column is now stored as Postgres stores it, so `->`, `@>` and its keys answer right.**
  When a generated table's SQL wrote a key twice, as in `jsonb_build_object('a', 1, 'a', 2)`, Postgres keeps only the
  last `a`. Mason kept both, in the order written. `->` read the first one, and `@>` checked against the first one.
  Now each `jsonb` value is written in Postgres's own form when the table is
  built: keys in Postgres's order, each key once, at every depth. These reads are right, and as fast as on a synced
  table.
- **A generated table that computes a `jsonb` column now takes longer to build.** Writing each value in Postgres's form
  costs about 30 to 40 seconds a million rows on a 4-core machine. A `jsonb` column taken as it is from another table costs
  nothing more.
