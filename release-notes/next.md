The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Allow for a longer first start if a generated table has a `jsonb` column.** At Mason's first start after the
  upgrade, Mason rewrites each such table's `jsonb` values once, in the form Postgres stores them. This takes about 30
  to 45 seconds a million rows on a 4-core machine. Nothing is served until it is done, and `/healthz` answers 503
  meanwhile. The log names each table rewritten. If your platform restarts a container that stays unhealthy, give the
  first start room in its health check for your largest generated tables. The image's own check gives up after about
  2 minutes 45 seconds. The rest of the start counts against it too, such as reading your database's text order and
  starting the catalog, so it covers about 3 million rows.
- **Each synced table with a `numeric` column of no precision is synced again once, at the first start.** Mason now
  keeps each such value's own decimals (below), which the data synced before does not hold. The table serves its old
  data until then, and a large table takes about as long as its first sync did.
- **A table that an older Mason left without one of its columns is synced again once, at the first start.** This is
  a table with a column whose name begins with `__mason_json_`, which that Mason dropped (below). The table serves
  its old data until then, and a large table takes about as long as its first sync did.

## What changes

- **A sync now says how many rows it added, updated and deleted**, such as "1,200 added, 282,770 updated, 0 deleted".
  Before, it said "283,970 changed", which lumped new rows and edited rows together. The new words are in `mason sync`,
  the web page's Sync now and Sync events, and `mason logs --events`. A first sync, or a table synced again whole, adds
  every row. Over replication, the counts follow your database's inserts, updates and deletes. `mason status`, the web
  page and the run's log say a replicated table's counts the same way, such as "1,000 added, 200 updated, 4 deleted".
  Before, they said "1,204 changes (1,000 inserts, 200 updates, 4 deletes)". A poll's own lines in the run's log still
  say "changed". A script
  that reads `mason sync --json` must read `added` and `updated` in place of `changed`. A script that matched the
  words of a `synced`, `polled`, `streamed` or `full_sync` event must match the new words.

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
- **`POST /api/sync` answers as soon as the sync has started.** It answers `202` with `{ sync: { id, tables, state,
  startedAt, endedAt } }`. Each table in `/api/state` then has `syncByHand`, which says `syncing` until the sync
  ends, then `synced` with what it did or `failed` with why. A script that calls the endpoint directly and needs the
  old answer adds `"wait": true` to its body. `mason sync` does this, so it still waits and prints the same report.
  A refusal is answered at once, as before.
- **A sync of a table that is already syncing, or waiting to start, is refused at once.** This holds for the web
  page's Sync now, for `mason sync` and for `POST /api/sync`. It is never queued for another read of the table. The
  refusal has a new code, `busy` (exit 1), and says when the running sync started. The page says the table's row shows
  when it ends. `mason sync` names `mason status` when a sync by hand or a scheduled poll is running. When the table's
  first sync, whole read again, catch-up or column change is under way, it names `mason wait <table>` first, then
  `mason status`. A table whose first sync, whole read again or catch-up is under
  way was refused before with `nothing_yet`, and is now refused with `busy`. A script that matched `nothing_yet` there
  must match `busy`.
- **A sync you start by hand that fails is now listed under Sync events**, as "Manual sync failed" (`sync_failed` in
  `mason logs --events`).
- **The web page's Sync events list shows how long each sync took in a column of its own.** The Took column holds
  it, such as `570 ms` or `7 min 57 s`, and you can sort the list by it. The message no longer ends with it there.
  `mason logs --events --json` gives it as a new field, `tookMs`. A first sync's event now ends with its time as a
  poll's does, such as `synced: 1,000 row(s) · 2.0 s`, where it said `in 2.00 s`. Events recorded before the upgrade
  keep their time in the message.

## What was wrong and is now right

- **Removing a synced table whose name a generated table also uses no longer stops the sync.** While a synced table
  holds a name, a generated table of that name is refused, as before. Once you remove the synced table, the generated
  table is built again and served. Before, if no review of the generated tables ran between the add and the remove,
  every sync pass failed with "Table with name … does not exist", and queries on the name failed until one of the
  generated table's bases changed. A project already in that state recovers at its first start after the upgrade.
- **A generated table whose name differs from a synced table's only in case is refused.** The synced data does not
  tell such names apart, so `Orders.yml` beside a synced `orders` could replace the synced table's rows. Now it is
  refused by name, as a generated file of the synced table's own name is. Two generated files whose names differ only
  in case are refused the same way. Rename the file to fix either.
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
- **A timestamp with time zone compared with a `timestamp[]` or `date[]`, or with a subquery of timestamps or dates,
  now uses your session's time zone.** This covers `ANY`, `ALL`, `IN` and `NOT IN`. Before, a session outside UTC got
  other rows. The same holds for a timestamp or a date compared with a wider time type.
- **Sync now on the web page no longer shows a timeout for a big table behind a proxy.** The page waited for the
  whole sync in one request. A reverse proxy or load balancer in front of `mason serve` closed the request when its
  own time limit ran out. The sync went on, but the page said it failed. Now the button says Syncing… while the sync runs, even after
  the page is reloaded, and then says what the sync did or why it failed.

- **A `numeric` column with no precision now prints each value as your database does.** Rails makes such a column from
  `t.decimal`. Mason printed every value with the most decimals any value in the column had, so `12.5` read `12.50` and
  `0` read `0.00`. Now a plain `SELECT`, `::text`, arithmetic, `sum`, windows, subqueries and the binary
  wire all give your database's text. So does every way such a value is turned into text: `to_json` and the other
  JSON functions, a row's text, `concat`, `format`, `||`, `string_agg`, an array's text, and the text of a `min`,
  `max` or `sum`. `SELECT DISTINCT x::text` keeps `12.5` and `12.50` apart, as your database does. A few readers
  still print the old way: `array_agg` itself, `min` and `max` themselves, a scalar subquery, `percentile_disc`,
  `mode()`, a `UNION` without `ALL`, and a generated table's column. `docs/SQL-SUPPORT.md` lists them all, under
  `mixed-scale-numeric`.
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
- **A column whose name begins with `__mason_json_` is no longer dropped from the synced data.** Mason uses names like
  this for columns of its own. At each start, Mason dropped a column of your table named like that, and its values were
  lost. Then every poll of that table failed. Under `sync: replication`, the stream stopped for every table. Now Mason
  knows its own columns from what it records, whatever their names, so every column of your table is synced and
  served. A column named like Mason's other hidden columns, such as `__mason_scale_`, is kept the same way.
- **Mason no longer crashes when it stops while a client is still connecting.** A connection that was still opening
  as Mason stopped could crash the process with a segmentation fault or an abort. The supervisor then saw a signal and
  no reason. Now the stop waits for each connection still opening, and then closes the synced data.
- **A column added to, renamed in or dropped from a synced table on your database now reaches Mason without a restart.**
  Before, a new column never reached the synced data until Mason was started again, while `mason status` said every
  table was synced. A column renamed or dropped made the table's sync fail again and again until a restart. Now Mason
  checks the table's columns before each poll, at `mason sync` and when the change log says the table changed. The
  check reads only the database's catalog. When the columns changed, Mason syncs that table again whole, and serves its
  old data until that ends. A new column that looks like a secret, such as `api_token`, is left out, as `mason add`
  leaves it out. Mason writes `exclude:` on the table's entry in the sources file, and says so in its log, its events
  and `mason status`. To sync it, run `mason add <table> --include <column>`.
  A column that `exclude:` names and that is renamed while Mason runs is never synced: Mason writes its new name in
  `exclude:` in its place. When the project's files are read-only, Mason leaves it out and says the line to write.
  One that is dropped while Mason runs is taken out of `exclude:`. A column that `columns:`
  names and that your database dropped no longer stops Mason from starting: Mason says so in `mason status`, and syncs
  the columns that are left. A whole sync that fails because a column changed under it now reads the columns again
  and starts over with them, instead of failing again and again.
  A publication you name in the sources file (`publication:`) is never changed by Mason. If it lists a table's columns,
  Postgres does not send a new column, so Mason stops keeping that table current and says the `ALTER PUBLICATION` line
  that adds the column.
- **A generated table's `jsonb` column is now stored as Postgres stores it, so `->`, `@>` and its keys answer right.**
  When a generated table's SQL wrote a key twice, as in `jsonb_build_object('a', 1, 'a', 2)`, Postgres keeps only the
  last `a`. Mason kept both, in the order written. `->` read the first one, and `@>` checked against the first one.
  Now each `jsonb` value is written in Postgres's own form when the table is
  built: keys in Postgres's order, each key once, at every depth. These reads are right, and as fast as on a synced
  table.
- **A generated table that computes a `jsonb` column now takes longer to build.** Writing each value in Postgres's form
  costs about 30 to 40 seconds a million rows on a 4-core machine. A `jsonb` column taken as it is from another table costs
  nothing more.
