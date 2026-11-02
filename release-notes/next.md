The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A database under a glibc locale is read again on the first start, so its source must be reachable.** About 50-60 s
  on a laptop, read-only SELECTs over constants, once for a collation version. If the source cannot be reached then, the
  start exits and says so. Stored jsonb sort keys are dropped and refilled after it.
- **The same read runs again on the first start after an OS upgrade moves the source's glibc**: the same 50-60 s, with the
  source reachable.
- **A table whose synced data holds a column of a type below in another form than Postgres's text is read again whole on
  the first start**, once (a `point` was held as its x and y): Mason looks at what each synced table holds, says each
  such table by name in the log and `mason status`, and serves it as it was until it is read. A table with a domain
  column is read again too; tables of `timetz` or an enum are not. Plan for the source's load, as for a `mason add` of
  them.

## What changes

- **Text is now ordered by the collation Postgres would use, wherever it comes from**: a column's own (`name text
  COLLATE "C"` on an en_US or ICU database), a `COLLATE` on either side of a comparison, inside `min()` or one argument
  of `GREATEST`, a derived table's or a view's `COLLATE`, and a libc collation other than the database's (`COLLATE
  "en_US"` on an ICU database, read from the source on its first use, as the database's own is). Before, these sorted
  or compared under the database's collation, or byte order, without saying so. A `SELECT` of no table that sorts or
  compares text (`SELECT 'a' < 'B'`) now answers under the database's collation rather than byte order (one that
  also holds a numeric, such as `1.5`, still answers in byte order, its numbers exact), and
  `percentile_disc` and `mode()` of text answer under every collation. Two kinds are refused by name rather than
  answered differently: a nondeterministic collation, and an ICU collation with a keyword (`und-u-kn`); `rank(…)
  WITHIN GROUP` and the other hypothetical-set aggregates are refused by name rather than with an internal error.
- **On a container under 5 GiB the queries' default share of memory is smaller**: half the container's limit, as
  before, or what leaves 2.5 GiB beside it when that is less, never under 128 MiB: 128 MiB of a container of 2.5 GiB or
  less (half of it before: 1 GiB of a 2 GiB one), 512 MiB of 3 GiB (was 1.5 GiB), 1.5 GiB of 4 GiB (was 2 GiB). From 5 GiB up
  it is half, unchanged. A query that needs more than its share spills to disk or fails
  on its own (53200) where it used to take the whole run down with it; `MASON_DUCKDB_MEMORY` still sets the share.
  `mason doctor` says the share and what it leaves, and warns when a share you set leaves under 2.5 GiB.
- **Under 3 GiB of memory, with `MASON_DUCKDB_MEMORY` unset, Mason starts and warns** that the system may stop it: in
  the log at its start, in `mason status` (and `warnings` in `--json`) while it runs, and in `mason doctor`. The
  warning says the size it read, where it read it, what Mason needs beside its queries and the two ways out: give the
  container 3 GiB or more, or set `MASON_DUCKDB_MEMORY` yourself. Measured, Mason uses up to 2.3 GiB beside its
  queries' share, and under the old default the kernel killed the whole run at 1, 1.5, 2 and 3 GiB.
- **The `mason-data` image now runs Node 26, where it ran Node 24**, the Node CI tests on: Node 24's V8 could now and
  then abort the server (nodejs/node#66366), for the platform to restart (compose's `restart: unless-stopped`). Nothing
  to do on upgrade, unless you build your own image FROM it with native modules of your own: rebuild them. A CLI on
  Node 24 has the same aborts, which `mason start` restarts; Node 26, or a 22.x release from 22.13, avoids them.
- **`mason status`, `--json` and the web page now say when a synced table is behind what its `sync:` promises**,
  measured from when it was last synced, with why. A table set to `sync: poll 15m` whose pass of polls takes 13 min is
  polled about every hour, since Mason waits four times a pass between passes to keep the database's load to a fifth;
  its line now says `— behind by 36 min:` and that reason, painted yellow, and `tables[].sync.state` is `behind`
  (`asOf`, `promisedSeconds`, `behindBySeconds`, `behindWhy` beside it). A polled table is behind past its interval
  plus the larger of a minute and twice its own last poll; a streamed one past two minutes. `sync: off` is never behind.
  Behind is not a failure: `mason wait` still exits 0.
- **A synced table whose keeping fails is now a failure on its own row, and `mason wait` exits 1 for it**, where it said
  ready before: a named publication that does not carry it (its line gives the `ALTER PUBLICATION … ADD TABLE …` for
  the database's owner, or `sync: poll <interval>` on its entry), a catch-up that failed, a poll or the stream that
  failed. Its line says it is served as of its age and NOT kept current, in red, never that its first sync failed. A
  stream error left from an earlier run on a table the stream keeps current is now cleared as soon as the stream has
  everything the database wrote, not only by the next change.

- **`latest(x ORDER BY …)`, an aggregate Mason adds, in any statement.** It answers the `x` of the row its ORDER BY
  sorts last, by Postgres's sort rules (NULLs last ascending, first descending, `NULLS FIRST/LAST` as written, a text
  key's collation): `SELECT customer_id, latest(status ORDER BY updated_at, id) FROM orders GROUP BY customer_id`. End
  the keys in a unique column, since tied rows have no defined pick. Without an ORDER BY, as a window function, or of a
  numeric quotient it is refused with the way out (`latest-order`, `latest-quotient` in docs/SQL-SUPPORT.md).
- **Connect from anywhere, on the web page.** The Overview's Connect card opens what `mason share` opens — a temporary
  public address, TLS required, a password shown once — after asking once, with a role picker where `mason/roles.yml`
  has several roles, and Stop sharing beside it. The share lasts while the page is open: two minutes after it closes or
  sleeps, the share and its tunnel end. One share at a time between the page and `mason share`. Not offered under
  `mason serve`.
- **Generated tables: a table declared in SQL, kept current by Mason.** One file per table in `mason/generated_tables/`,
  committed beside the sources file, with `kind: scheduled`, `target_lag:` and `sql:`; `mason help generated` is the
  guide. A table re-runs its whole SQL once a base has changed and its target comes due, inside Mason, reading nothing from
  your database, and nothing runs over idle bases. A statement reads it by name; `mason status` shows its state and lag. A
  role with `tables: all` reads it, and a role with a list reads it once it names it. Nothing changes if you add no file.
  A generated table may read another: parents are built first, a change to a base re-runs the whole chain above it at
  one snapshot, and the chain is swapped in at one moment, so a child never shows rows its parent doesn't. A table that
  reads itself, directly or through others, is refused with the tables of the cycle. A child of a parent whose run failed,
  or of a parent refused before it was ever built, is not run, and `mason status` says why; a parent refused after an edit
  to its file keeps re-running from the SQL it was last built from, and carries its children, so `mason status` shows the
  parent refused and the child current until the file is fixed.
  A generated table holds a numeric exactly, with Postgres's digits, wherever its types fix the scale: a column passed
  through, its min or max, a sum of an integer (`bigint` for a `smallint` or `integer`, `numeric` for a `bigint`) or of a
  `numeric(p,s)`, and `+ - *`, negation, `abs`, `mod`, `round(x, n)` and `trunc(x, n)` (`n` below 0 too), `floor`,
  `ceil`, a cast to `numeric(p,s)`, or a `CASE`, `GREATEST`, `LEAST` or `COALESCE` of one scale, over those.
  A value added to an enum is answered by the synced table at once, though a generated table built before it still
  holds the old type until its next run. It holds an enum,
  sorted in its declared order, and a citext, compared without case.
  A table's lag is measured against the base across its chain: a child is behind from the moment a base below its parent
  changes, not from its parent's run, in `mason status`, `--json`'s `behindSeconds` and `behindSince`, and after a
  restart. A child's `target_lag` shorter than a parent's is refused by name, with the way out: it can be no fresher than
  what it reads. `mason wait <table>` waits until a generated table holds every change synced when the wait began (exit
  0; 1 when its run failed or it or a parent was refused before it was built; 124 on `--timeout`), so a script can read it right after a load. A table
  that serves and holds everything synced is ready though its last run failed: after editing its file, read
  `mason status` for whether the new definition was refused or failed.
- **`mason init demo` also writes a generated table**, `mason/generated_tables/daily_orders.yml`: orders and revenue per
  day (UTC) and status, over the synced `orders`, `target_lag: 30s`. `mason wait daily_orders` waits until it is built,
  and `mason status` shows it re-running as the demo's orders arrive. A file already at that path is kept. `mason init
  --json` has a new key, `generated`: `[{ table, file, written }]` for the demo, `[]` for any other project.
- **A column is reported as the source's type, whatever Mason holds.** `information_schema`, `pg_attribute`, `pg_typeof`
  and the wire's type OID now say `timetz` (1266), `point`, `money`, `bit`, `macaddr` and the rest where they said `text`,
  so a BI tool stops sending text functions at them. If a saved question or a script of yours read one of these columns as
  text (`substring(x, 1, 3)`, `x LIKE '…'`), it now gets Postgres's own `42883`: write `x::text`.
- **A `timetz` column is answered as Postgres answers it**: rows, `=`, GROUP BY, ORDER BY, min and max, in any session
  zone. `extract`, a cast to `time`, `AT TIME ZONE` and interval arithmetic on it are refused by name where they are not
  exact.
- **A table with a `box`, `circle`, `line`, `lseg`, `path` or `polygon` column, or an array of `point`, `money`, `macaddr`,
  `cidr`, `oid`, a range or a `tsvector`, is now synced**, where its sync failed. Nothing to do on upgrade.
- **Other types are read as Postgres writes them, and what needs their own value is refused by name** (`held-type-compare`
  in docs/SQL-SUPPORT.md): the value, `x::text` and everything over that text, `IS NULL`, `count`, and `=` and GROUP BY where
  equal values have one text. `ORDER BY money`, `sum(money)`, `lower(range)` and a composite's field are refused with
  the way out, where they failed in the engine's words or answered wrongly. A `point` was written as `{'x': 1, 'y': 2}`.
- **A column of a domain is its base type**, as on the wire. `pg_typeof(x)` and `domain_name` say the base type, a listed
  difference (`domain-column`), and a domain over an integer no longer reads as text.
- **Text under `en_*` is ordered as glibc orders it, and nothing under it is refused.** One emoji, a Thai vowel or a mark
  in a column no longer refuses the column's sort, group or dropdown, and no refusal quotes a row's value. Two rare shapes
  are listed differences (`libc-rare-letter`, `libc-mark-run-form`, in docs/SQL-SUPPORT.md); mason status's `Text order`
  line counts them, and `source.textOrder` in `mason status --json` sits beside it.
- **A database under tr_TR, sv_SE, cs_CZ or another locale that moves ASCII or Latin now refuses `ORDER BY`, `<`, `min`
  and `max` of text by name (`libc-locale-unread`)**, where it answered in a wrong order. Add `COLLATE "C"` or an ICU
  collation to them; everything else is served. `mason start` and mason status say so.
- **A Postgres whose locale sorts by bytes (macOS, musl) is followed as that**, where the start failed.
- **`mason share`'s password now reads `mason_share_` and 48 hex digits**, where it was 48 bare hex digits, so a secret
  scanner or a person reading a saved connection can tell it is Mason's. It is as strong as before, and it logs in only
  on the share it was printed for. Nothing to do on upgrade, unless a script of yours checks the old shape.
- **A LIMIT with no ORDER BY over a many-to-many join is back to milliseconds**, where it had taken tens of seconds or
  minutes: it ran the whole join to pick its rows. Nothing to do on upgrade.
- **A small statement no longer waits tens of seconds beside a heavy one**: a statement that computes something per row
  (`to_char`, a numeric bin, jsonb `@>`) held every other session, up to 57 s on one deployment. A small statement now
  answers in under about a second or two.
- **Five or more heavy statements at once no longer stall a small one**: it waited 10 to 50 s beside five to eight, and
  now about a second or two, at 2 vCPU as on a larger machine. Mason now starts 32 threads for statements where Node
  starts four, a few tens of MB of memory at most. The trade: past 32 running statements the queue still holds them; more
  run at once, so a memory or spill failure can replace a long wait; a small statement's typical time rises a little
  while its worst case falls ten-fold.
- **A run has about 40 threads plus five a CPU (49 at 2, 89 at 10).** Under a thread limit Mason lowers the size to fit
  and says so at the start. A `UV_THREADPOOL_SIZE` of your own is kept, but one that does not fit, or is not a number
  from 1 to 1024, now refuses the start. On Windows, set it in the shell before `mason`: the pool otherwise stays at
  four.
- **A LIMIT over a view, a WITH query, a tool's `SELECT * FROM (<join>) t LIMIT 100` wrapper or a derived table beside a wide
  table no longer reads every wide column to keep 100 rows.** Such a statement took seconds and gigabytes of spill, or
  failed for memory; it now takes a fraction of a second and spills nothing. A narrow statement of these shapes with no
  ORDER BY now pays for the join's whole output where the join is proved bounded: a few milliseconds at a LIMIT alone, and
  a deep OFFSET can take about twice as long. A column of an aggregated side, and a statement of a role that filters
  rows, are read as before. Nothing to do on upgrade.
- **A LIMIT over `JOIN … USING`, a `NATURAL JOIN` or a sort by a computed column of a join no longer reads every wide column to
  keep 100 rows**: seconds and gigabytes of spill are now a fraction of a second and none, and such a statement that failed
  for memory now answers, whether the sort names the computed column by its alias, its position or its expression. A
  `NATURAL JOIN` of two tables with no column in common now answers as Postgres does, every row paired, where it was
  refused ("No columns found to join on"). Nothing to do on upgrade.
- **A user whose role filters rows gets the same: a LIMIT over a join of filtered tables no longer reads every column of
  every visible row to keep 100** (about 2 s now a tenth of that, on a 3.4 kB-a-row table filtered to a tenth). Which rows
  the user sees is unchanged: the rows are chosen, and their columns read, through the role's filter alone, and the
  statement's expressions still never run on a row the filter hides. Nothing to do on upgrade.
- **A subquery in the select list of a LIMIT, such as `(SELECT count(*) FROM items i WHERE i.order_id = o.id)`, now runs
  for the rows the LIMIT keeps alone**, over one table or a join, with the rows chosen first: a statement that took about a
  minute and tens of gigabytes of spill now takes a fraction of a second. A subquery in a WHERE, a join's condition or the
  ORDER BY runs as before. Nothing to do on upgrade.
- **A value that raises in such a derived list or list subquery no longer fails the statement when the LIMIT leaves its row out**: Postgres
  raises there, sorting every row first. This is the decided difference `limit-errors` (docs/SQL-SUPPORT.md), wider.
- **`#>> array['k']`, the form BI tools send for a JSON field, is as fast as `->> 'k'`**: on 20 M rows a `GROUP BY` of it
  took 45-90 s and now takes about 1.2 s. The same holds for `'{k}'::text[]`, `array['k']::text[]` and
  `json_extract_path_text(j, VARIADIC array['k'])`, and each now reads a stored JSON path where there is one. `#>` with
  a constant path reads what `->` reads. Nothing to do on upgrade.
- **A `text[]` parameter works as a prepared statement's value**, where it failed: a JSON path bound as `$1`, and any
  other array of text bound the same way, sent as text or in binary (as Npgsql sends every parameter). One of two
  dimensions (`{{a},{b}}`) or whose subscripts do not start at 1 (`[2:3]={a,b}`) is refused by name
  (`multidim-array`, `array-lower-bound`). Nothing to do on upgrade.
- **A JSON path cast to `varchar(n)[]`, `char(n)[]` or `name[]` is refused by name (`json-path-type`)**, where it read the
  path uncut or failed. Cast it to `text[]`.
- **`SELECT *` in an arm of a UNION no longer lists a stored JSON path's hidden column**, which failed or added a column
  once a table had one stored. Nothing to do on upgrade.
- **A `time` cast to `timetz` takes the session zone's offset for today at the value's own time of day**, as Postgres
  does. On a day the clocks change it took the offset of the moment the query ran, so before the change `12:30` was
  answered `-04` in New York where Postgres has `-05`. Nothing to do on upgrade.
- **`GROUP BY` a table's primary key with a `LIMIT` no longer fills the disk** when the list shows that table's wide
  columns (a JSON document, long text): the groups are chosen on the key, and the wide columns read for the rows the
  limit keeps. Such a query spilled tens of GiB and failed for memory; it now answers in under a second. Nothing to do
  on upgrade.
- **`SELECT DISTINCT` with a `LIMIT` whose list holds a table's primary key no longer fills the disk** either: the rows
  are made distinct on the key (and the other tables' listed columns), and that table's wide columns read for the rows
  the limit keeps. Such a query spilled 29 GiB and failed for memory after five minutes; it now answers in under a
  second. Nothing to do on upgrade.
- **`SELECT DISTINCT ON` with a `LIMIT` no longer fills the disk when the list shows wide columns**: the row kept for
  each group is chosen on the sort's columns alone, and the wide columns read for the rows the limit keeps. Such a query
  spilled 25 GiB and failed for memory after twenty minutes. One
  thing changes: a value in the list that cannot be computed (`'x'::int`) in a row that is not its group's first no
  longer fails the query. Nothing to do on upgrade.
- **`SELECT DISTINCT ON` answers as Postgres does in three more cases**: with an `ORDER BY` that names only some of the
  `ON` expressions (or none, with a `LIMIT`), the groups now come back in Postgres's order and a `LIMIT` keeps the same
  ones; a jsonb `ON` named by its output alias now treats `1.0` and `1` as one value; and a numeric division in the list
  of a `DISTINCT ON` or a `SELECT DISTINCT` (`amount / 3`) shows Postgres's exact digits instead of a rounded number, also when the `DISTINCT` is outside a subquery
  that computes it.
- **A numeric division or average is compared by its exact value**: `DISTINCT`, `GROUP BY`, `PARTITION BY`,
  `count(DISTINCT …)`, `=` and `<>` no longer treat two quotients as equal when they agree only in their first 17
  digits. A quotient in `ROLLUP` / `CUBE` / `GROUPING SETS`, in `sum(DISTINCT …)` and similar, or in a `UNION` /
  `INTERSECT` / `EXCEPT` without `ALL` is now refused with `numeric-quotient-equality` (write `round(x, n)`), where it
  could answer wrong rows before.
- **A division or average a subquery computes is exact outside it too**: grouped, filtered, joined, counted
  `DISTINCT`, cast or computed with outside a subquery or a `WITH` query (`SELECT q, count(*) FROM (SELECT a / 3 AS q
  …) s GROUP BY q`), compared with a scalar subquery's or a parameter's value, as its text (`(a / 3)::text`), or in a
  `UNION ALL` beside a plain column, it now shows and compares Postgres's exact digits — where it showed a rounded
  number, and could join or group values that differ past their 17th digit. A row holding one (`(a / 3, b) = (…)`) is
  now refused with `row-value`, and one compared outside a subquery that is also read by `*` beside other columns
  with `numeric-quotient-equality` (name the subquery's columns).
- **A numeric constant past 38 digits, or cast to `numeric(p, s)` past 38, is no longer compared as exact**
  (`x + '1e-39'::numeric = x` was true): it is computed and compared with Postgres's digits, or refused by name where
  it cannot be. A variance or standard deviation read from a subquery beside another computed column now shows
  Postgres's digits, as it did read alone. A `GROUP BY` of a division of `extract(...)` (Grafana's `$__timeGroup`) now
  groups by the exact quotient.
- **`FETCH FIRST n ROWS WITH TIES` answers as Postgres does wherever it is written.** These were wrong and are now right:
  a sort by the number of a computed column beside a `*` (`SELECT t.*, x % 5 AS m … ORDER BY 5`) kept every row; a
  `UNION`, `INTERSECT` or `EXCEPT` with `WITH TIES` failed with an internal error; inside an `IN`, a scalar subquery,
  `ARRAY(…)` or an arm of a `UNION` it failed with "returns 2 columns", and `SELECT s.*, 1 AS x` over it read the wrong
  last column; a count of `NULL` kept no row and a negative one answered nothing, where Postgres keeps every row and
  raises `2201W` (a negative `OFFSET` now raises Postgres's `2201X`), also where no row matches; a fractional count was
  not rounded; a numeric column under it lost its decimals, also through `SELECT * FROM (…) s` or a `WITH` query. A
  `TABLE t` statement under it, or as a `SELECT` of a `UNION` with an `ORDER BY`, now answers. A sort by a window
  function's or a set-returning function's column or by
  `random()`, and `SELECT DISTINCT` or `DISTINCT ON` with `WITH TIES`, now answer where they were refused or failed. Over
  a table a user's role filters it is refused by name (`roles`), with the way out. Nothing to do on upgrade.
- **A sort by a `UNION`'s column or by a row column answers as Postgres does, or is refused.** In a `UNION`,
  `INTERSECT` or `EXCEPT`, a `citext` column beside a `text` one is `text`, and `ORDER BY` now sorts it as text, where
  it was sorted without regard to case as the first `SELECT`'s `citext`. A `char(n)` beside a `text` is its text
  without the padding (`'a b'`, never `'a b  '`), so a `UNION`, a `GROUP BY` and the text read one value, as Postgres
  does. A numeric division beside an integer (`SELECT a / 3 … UNION ALL SELECT 1`) shows Postgres's digits, where it
  showed a rounded number. A sort by a column that is a row (`SELECT
  ROW(a, b) AS r … ORDER BY r`, `SELECT t … ORDER BY 1`) sorted by the row's text (`(0,100)` before `(0,50)`): it is
  now refused by name (`row-value`), with the way out, as `ORDER BY ROW(a, b)` already was. Sort by the row's columns
  instead. Nothing to do on upgrade.
- **A numeric division or average now keeps Postgres's exact value in more places.** It sorted, ranked and tied by a
  rounded number: `ORDER BY x / y`, `rank() OVER (ORDER BY x / y)`, `FETCH FIRST 1 ROWS WITH TIES` and `min` / `max` put
  two values that differ only past the 17th digit in either order, and `0.1 + 0.2` after `0.3`; they now sort as
  Postgres does. `sum`, `avg` and a running `sum(…) OVER` of a division, or of a subquery's or `WITH` query's division,
  showed 15 digits (`34.6428571428571`); they now show Postgres's (`34.6428571428571429`). A division cast to text,
  `varchar`, `double precision` or an integer was the rounded number's (`(5 / 2.0)::int` was `2`); it is Postgres's now
  (`3`, half away from zero). A `*` beside a division (`SELECT *, a / 7 AS q …`, `SELECT s.*, 1 …`) showed 15 digits; it
  shows Postgres's, and a comparison of such a subquery's division, refused before, is answered. A subquery column named
  like `__mason_cell_0` is the query's own. Nothing to do on upgrade.
- **A numeric division keeps Postgres's exact value in a `UNION ALL`, a scalar subquery and a window too.** A
  `UNION ALL` sorted, limited and tied by a division's rounded number, a `VALUES` arm beside a division failed with
  "types cannot be matched", and an integer beside a `numeric(12,2)` showed `1.00` where Postgres shows `1`; each now
  answers as Postgres does. `(SELECT a / 7 FROM …)`, `min` / `max` / `first_value` / `lag` / `lead` of a division
  over a window, `x / y IN (…)` and a grouped query's `ORDER BY` of a division by its alias now show, compare and sort
  Postgres's digits. `array_agg` of a division, and `JOIN … USING` or `NATURAL JOIN` on a subquery's division, are now
  refused by name with the way out (`array_agg((x / y)::text)`; `JOIN … ON`), where they answered rounded numbers.
  Nothing to do on upgrade.

- **A session's TimeZone, search_path and DateStyle now apply to every statement**, not only one that reads a synced
  table. A statement of no table (`SELECT '2026-01-02 03:04:05+00'::timestamptz`, `SELECT current_schemas(false)`,
  `SELECT 'orders'::regclass`) answered in UTC and under `public` whatever the session set; it now answers in the
  session's zone, under its search_path (pg_catalog first, as on Postgres: `current_schemas(false)` is `{public}`), and
  reads a date in its DateStyle's order (`SET DateStyle = 'ISO, DMY'`: `'01/02/2026'::date` is 2026-02-01, on every
  path, a bound parameter too). `now()`, `CURRENT_DATE` and the like, and `'now'` or `'today'` read as a
  date or time however the statement writes or computes it, are the transaction's instant on both paths, so two
  statements of one block agree. A prepared statement whose search_path moved since it was prepared is planned
  again, as Postgres does: it reads the table the path now names (it read the old one), and answers Postgres's
  `cached plan must not change result type` (0A000) when its columns moved. `SHOW extra_float_digits`,
  `SHOW transaction_isolation` and `SHOW default_transaction_isolation` read back what was set (they answered fixed
  values). `SET IntervalStyle` to anything but `postgres` is now refused by name (`interval-style`), where it was
  accepted and ignored: every interval is written in Postgres's default style. Nothing to do on upgrade, unless a
  tool sets IntervalStyle: remove the setting, or set it to `postgres`.
- **`now()` and the clock keywords now carry microseconds, as Postgres's do**: a prepared statement's `'now'` and its
  run's `now()` no longer compare equal when both fall in one millisecond, and `current_time` and `localtimestamp(6)`
  print Postgres's six fraction digits (they printed three).

- **A table of large values (big `jsonb` or `text` documents, a few rows to a page of the table) now syncs within the
  memory set by `MASON_DUCKDB_MEMORY`**, where its first sync read it whole at once and failed with `Out of Memory
  Error` and the engine's advice (threads, settings) however the readers were set. Its first sync reads as many pages
  at a time as the memory holds, and goes on with one reader and smaller chunks when one runs out. A table whose rows
  do not fit even one page at a time now fails with the limit as set and the way out: raise `MASON_DUCKDB_MEMORY` and
  start mason again, or `mason add <table> --columns …` without its widest columns.

## Known

- **A generated table can't yet hold a numeric that divides (an average is one); is a variance or a standard deviation, which Postgres computes exactly at decimals it picks per value, rounded, cast to numeric(p,s) or not; is a sqrt, exp, ln, log or power, whose decimals Postgres picks per value, rounded, cast to numeric(p,s) or not, whatever the decimals of what it is computed from; is a JSON number's text cast to numeric with no scale (cast to numeric(p,s), it is stored); has more than 18 decimals, at the end or on the way; sums values whose decimals the rows decide; is a CASE, GREATEST, LEAST or COALESCE of values with differing decimals; or is cast from a double; nor a domain or a composite**, and `kind: live` is refused. Each is refused by file and key before anything is built, said as Postgres types the value (a sqrt or an average of a double is a double, so cast to numeric it is a cast from a double), wherever it sits in the column (under an operator, a coalesce, a round, a cast or an aggregate, or in a scalar subquery, a `WITH` query, a subquery in `FROM` or a `UNION`'s arm), with the way out your own SQL with the cast moved and the aggregate kept (`sum(sqrt(x)::double precision)`), or the `WITH` query, subquery or `UNION` the cast belongs in, given whole. Each of these keeps its reason read back from its text (`::text`, `::varchar`, `|| ''`, a jsonb's `->>`, a `WITH` column), cast to numeric(p,s) or not, so a typmod over a variance's text never stores an approximation; only a stored column's or a JSON number's text read as a numeric is said as a text: a JSON number's, a stored double's or any other. A run that fails (a value past 38 digits, `bigint out of range`, `division by zero`) records Postgres's error, SQLSTATE and DETAIL (`numeric field overflow` says the precision and scale it must fit, on every path), and is tried again after its back-off.
- **`mason status` shows generated tables; the web page doesn't yet.**
- **Pages of such a statement may overlap**: `LIMIT n OFFSET m` with no ORDER BY over a join that can multiply rows, or over
  an aggregated side, has no stable order, so a tool paging one can see a row twice and miss another. Add an ORDER BY
  where the pages matter.
