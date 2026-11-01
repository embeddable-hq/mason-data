The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A database under a glibc locale is read again on the first start, so its source must be reachable.** About 50-60 s
  on a laptop, read-only SELECTs over constants, once for a collation version. If the source cannot be reached then, the
  start exits and says so. Stored jsonb sort keys are dropped and refilled after it.
- **The same read runs again on the first start after an OS upgrade moves the source's glibc**: the same 50-60 s, with the
  source reachable.

## What changes

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
  answers in under about a second or two, with up to about four such statements running at once. Nothing to do on
  upgrade.
- **A LIMIT over a view, a WITH query, a tool's `SELECT * FROM (<join>) t LIMIT 100` wrapper or a derived table beside a wide
  table no longer reads every wide column to keep 100 rows.** Such a statement took seconds and gigabytes of spill, or
  failed for memory; it now takes a fraction of a second and spills nothing. A narrow statement of these shapes with no
  ORDER BY now pays for the join's whole output where the join is proved bounded: a few milliseconds at a LIMIT alone, and
  a deep OFFSET can take about twice as long. A column of an aggregated side, and a statement of a role that filters
  rows, are read as before. Nothing to do on upgrade.
- **A value that raises in such a derived list no longer fails the statement when the LIMIT leaves its row out**: Postgres
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

## Known

- **Five or more heavy statements at once can still stall a small one**, for tens of seconds in the worst case measured
  ([issue 88](https://github.com/embeddable-hq/mason-data/issues/88)).
- **Pages of such a statement may overlap**: `LIMIT n OFFSET m` with no ORDER BY over a join that can multiply rows, or over
  an aggregated side, has no stable order, so a tool paging one can see a row twice and miss another. Add an ORDER BY
  where the pages matter.
