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
- **A value that raises in such a derived list no longer fails the statement when the LIMIT leaves its row out**: Postgres
  raises there, sorting every row first. This is the decided difference `limit-errors` (docs/SQL-SUPPORT.md), wider.

## Known

- **Pages of such a statement may overlap**: `LIMIT n OFFSET m` with no ORDER BY over a join that can multiply rows, or over
  an aggregated side, has no stable order, so a tool paging one can see a row twice and miss another. Add an ORDER BY
  where the pages matter.
