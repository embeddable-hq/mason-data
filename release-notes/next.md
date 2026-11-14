The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

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
- **The host's card (`MASON_UI_OVERVIEW_CARD`) is now the first thing on the web page's Overview**, above Mason's own
  cards, at the full width. A host with nothing to say answers `{ "refresh": 60, "sections": [] }`, and the title may
  be left out. The Overview then draws no card at all, and reads the path again at its `refresh`, so a card added
  later shows up on the next read. A read that fails is still shown in the card. Before, an empty answer drew a box
  with only its title, and the card came last.
- **On a server that runs the project read-only, the web page links to how to deploy a change.** `mason status --json`
  words `sourcesReadOnly` as plain sentences now, so a script that matched its old text must match the new one. A new
  field, `sourcesReadOnlyKind`, says which reason it is: `deployed`, `unwritable` or `unknown`.
- **`POST /api/sync` answers as soon as the sync has started.** It answers `202` with `{ sync: { id, tables, state,
  startedAt, endedAt }, already }`. Each table in `/api/state` then has `syncByHand`, which says `syncing` until the
  sync ends, then `synced` with what it did or `failed` with why. A script that calls the endpoint directly and needs
  the old answer adds `"wait": true` to its body. `mason sync` does this, so it still waits and prints the same report.
  A refusal is answered at once, as before. A second sync of a table that is syncing gets that sync as its answer,
  and never starts another.
- **A sync you start by hand that fails is now listed under Sync events**, as "Manual sync failed" (`sync_failed` in
  `mason logs --events`).

## What was wrong and is now right

- **Sync now on the web page no longer shows a timeout for a big table behind a proxy.** The page waited for the
  whole sync in one request. A reverse proxy or load balancer in front of `mason serve` closed the request when its
  own time limit ran out. The sync went on, but the page said it failed. Now the button says Syncing… while the sync runs, even after
  the page is reloaded, and then says what the sync did or why it failed.

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
