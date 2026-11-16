The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What changes

- **A sync that waits for an open transaction on your database now reads as waiting, never as failed.** Mason waits
  when a table was rewritten after a transaction that is still open began. It checks again every 30 seconds and goes
  on by itself.
  - `mason status` and the web page now say Waiting, with the transaction the sync waits for. Before, they said
    Failed.
  - `mason wait` keeps waiting for a first sync that waits, within its `--timeout`. Before, it exited 1, so
    `mason add <table> && mason wait` read the wait as a failure. A table synced before is served meanwhile, so
    `mason wait` is ready for it.
  - In `mason status --json` and `mason wait --json`, the wait is no longer the table's `error`, and its `sync.state`
    is `waiting`. A new `syncWaits` says why, and when Mason last checked. If a script or an alert looks for `failed`
    to catch this case, it no longer matches. Another error on the table, such as its stream's, is still said.
  - The event is now `sync_waits`, and it is not a failure. Before, it was `full_sync_failed`.
  - The message names the transaction and its pid only while that transaction is still open. Before, it could name
    one that had already ended, whose pid may belong to another session by then.
- **You can see, before you upgrade, which synced tables the new release reads again whole.** Run
  `npx @mason-data/cli@<version> upgrade --check` in the project's folder while Mason runs, with the version you are
  upgrading to. It lists each table that release's first start reads again from your database, why, how large it is,
  and whether it keeps serving its synced data until its new sync is done. It changes nothing. `--json` gives the same
  as data.
  - It works only for an upgrade from this release or a later one. An older Mason does not say what its synced data
    holds, and the command says so. For an upgrade from 0.22.0 or before, read each release's "Before you upgrade".

- **`mode() WITHIN GROUP (ORDER BY …)` of a `text` or `varchar` is faster under a libc collation**, such as a database
  whose collation is `en_US.utf8`. Over a million rows, the most common status per tenant took 2.2 s and now takes
  under 0.1 s, about a fifth of Postgres's time. The answers are Postgres's, as before: of values equally common, the
  first in the collation's order wins. Under a locale other than English, a value holding a character Mason cannot order
  as the collation does now refuses the query only when it is among the most common values of its group. Before, any
  such value it read refused it. These are still slow: a `mode()` of a `char(n)` or
  a `citext`, one ordered with `USING`, and one of a value that calls `random()` or reads a subquery or an outer
  query's column.

## What was wrong and is now right

- **A numeric quotient or average written as text by `concat`, `format`, `||`, `to_json` or `json_build_object` now
  has Postgres's digits.** Before, `concat(amount / 3)` wrote the engine's nearest double, such as `-735159.5` where
  Postgres writes `-735159.499999999988`. A cast to text, such as `(amount / 3)::text`, was already right.
- **Every name Postgres takes for a field of `extract` and `date_part` now gives that field's value.** Postgres takes
  `sec`, `secs` and `s` for `second`, `ms` and `msec` for `milliseconds`, `us` for `microseconds`, `mins`, `hrs`,
  `mons`, `yrs`, `jd` and more. Before, `extract(sec FROM ts)` dropped the fraction of a second, so
  `sum(extract(sec FROM ts))` was wrong. On an `interval`, `sec` and `ms` were refused, and names such as `j` and `mm`
  failed with 22P02.
  - `extract(julian FROM …)` is now answered for a date, a timestamp and a timestamptz, with Postgres's digits.
    Before, it was refused. Of a timestamp, it is read as a numeric quotient is: its text, its sum and its average are
    exact, and what Mason refuses for a quotient it refuses for it too, such as `array_agg` of it.
  - `extract(epoch FROM …)` of a `time with time zone` now counts its offset, as Postgres does. Before, it gave the time
    of day alone.
  - `date_part` of a `date` now answers `hour`, `minute`, `second` and their other names with 0, as Postgres does.
    Before, they were refused.
  - A name a type does not take now gets Postgres's own error, such as `unit "foo" not recognized for type
    timestamp without time zone` (22023), or `unit "day" not supported for type time without time zone` (0A000). It
    is raised only when a row holds a value, as on Postgres, so a query over no rows or over NULLs answers.

- **A query with `TABLESAMPLE` is now refused by name.** A sample is of your database's pages or rows, which the
  synced table does not hold. Before, Mason refused it only as something it had not verified yet. Without that check,
  `TABLESAMPLE SYSTEM (100)` was answered with 100 rows, not every row. Now every form is refused with
  `Mason gap tablesample`, wherever the table is read: a subquery, a CTE, a join or a view. A literal percent past 100,
  a NULL percent or a NULL seed gets Postgres's own error. To read a part of a table, filter it, such as
  `WHERE id % 10 = 0`.
- **A table synced whole is no longer served with rows missing until its catch-up.** This is a first sync, or a
  table synced again whole, such as after its columns change.
  - Before, the synced table held only the rows written before the oldest open transaction on your database began.
    It was served like that until its catch-up a moment later, or longer when the catch-up failed. In the worst case
    it served 0 rows: a `TRUNCATE`, then another transaction left open, then the reload.
  - Now each whole sync is caught up before it is served. Until then, a table synced before keeps serving its previous
    data, and a new table is not served yet.
- **A WITH query named like the table it reads now gives Postgres's answer.** In
  `WITH orders AS (SELECT * FROM orders WHERE status = 'paid') SELECT count(*) FROM orders`, the WITH query's own
  `FROM orders` reads the table, as on Postgres. Before, Mason counted 0 rows. With a join, the query failed with
  XX000 "Maximum call stack size exceeded". This also holds when the WITH query is inside a subquery or one arm of a
  UNION, and when a later WITH query reads an earlier one named like a table. A WITH query in one arm of a UNION,
  named like a synced table, could also read that table instead of itself when the query held a `*`. It now reads
  itself.
  - A WITH query whose name differs from a table's only in case is now told apart from it, as on Postgres. Before,
    `WITH small AS (…) SELECT count(*) FROM "Small"` counted the WITH query's rows, not the table `"Small"`'s. Tools
    that make PascalCase tables, such as Prisma, write such names.
  - A whole row of a WITH query with a column list, such as `WITH q(a, b) AS (…) SELECT q FROM q`, now answers.
    Before, it failed with 42703.
- **Two generated tables that read each other through a WITH query named like one of them are now refused.** Take a
  table `a` defined as `WITH b AS (SELECT * FROM b) SELECT * FROM b`, and a table `b` that reads `a`. The WITH query's
  own `FROM b` reads the table `b`, as on Postgres. So the two read each other, and each is refused with the cycle,
  as any cycle is. Before, Mason missed the cycle. Both said they were waiting for the other, for ever, and neither
  was built.
- **A column your sources file leaves out is no longer served under another name.** This covers a column that
  `exclude:` names, one a `columns:` entry does not list, and a secret-looking column `mason add` left out. Before, Mason
  matched columns by name alone. If two columns swapped names in one transaction, the left-out column was served under
  the other's name. The same happened after a rename while Mason was stopped, and to a column renamed to a name
  `columns:` lists. Now Mason knows each column by its identity on your database, which a rename keeps. A left-out
  column stays out under any name, its old name too. Mason syncs it again only once you confirm it. To confirm, run the
  `mason add <table> --columns …` command the table's line gives, which names every column to sync. A plain
  `mason add <table>` would leave secret-looking columns out again. `mason add` confirms whether Mason runs or not. It
  confirms the table as it read it. If the table's columns change on your database before Mason takes the entry, it is
  not a confirmation, and the table is held. You can also remove the table's entry and add it back. Until then, if your
  entry would sync the column, Mason stops syncing that table and keeps serving the data it holds. That covers a rename,
  a swap, a column renamed back under a name Mason took out of `exclude:`, and a name you take out of `exclude:` or add
  to `columns:` by hand. The table's line in `mason status` and on the web page says why, and gives the line that keeps
  the column out.
  - In a project deployed read-only (`MASON_PROJECT_READONLY=1`), the committed file is your word, so a column that did
    not move on your database is synced as the file says. A column that moved is held. Its line says how to sync it
    there: take the entry out of the committed file and start Mason, then put it back and start Mason again.
  - Two synced tables that swap names on your database no longer pass a left-out column from one entry to the other.
    The same holds for two schemas that swap names, and for a table renamed to another entry's name. Before, the entry
    that syncs every column served every value of the column the other entry left out. Now the entry that names the
    table is held until you confirm. The table that moved to the entry that leaves the column out is read again whole.
  - Under `sync: poll`, a table dropped and created again under its name is now read again whole by itself. Its columns
    are decided again by name, and a name the old table left out stays out. Under `sync: replication` it is not read
    again by itself, as before.
