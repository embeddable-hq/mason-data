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

- **Generated tables: a table declared in SQL, kept current by Mason.** One file per table in `mason/generated_tables/`,
  committed beside the sources file, with `kind: scheduled`, `target_lag:` and `sql:`; `mason help generated` is the
  guide. A table re-runs its whole SQL once a base has changed and its target comes due, inside Mason, reading nothing from
  your database, and nothing runs over idle bases. A statement reads it by name; `mason status` shows its state and lag. A
  role with `tables: all` reads it, and a role with a list reads it once it names it. Nothing changes if you add no file.
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

## Known

- **A generated table can't yet hold a numeric or one of your own types, or read another generated table**, and `kind:
  live` is refused. Each is refused by file and key, with the way out, before anything is built.
- **`mason status` shows generated tables; the web page doesn't yet.**
- **Pages of such a statement may overlap**: `LIMIT n OFFSET m` with no ORDER BY over a join that can multiply rows, or over
  an aggregated side, has no stable order, so a tool paging one can see a row twice and miss another. Add an ORDER BY
  where the pages matter.
