The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Each synced table with a `numeric` column of no precision is synced again once, at the first start.** Mason now
  keeps each such value's own decimals (below), which the data synced before does not hold. The table serves its old
  data until then, and a large table takes about as long as its first sync did.

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
  costs about 25 seconds a million rows on a 4-core machine. A `jsonb` column taken as it is from another table costs
  nothing more.
- **After the upgrade, Mason rewrites each generated table's `jsonb` columns once, when it starts.** This happens before
  the table is served, and the log says which tables. A large table can make that start take longer.
