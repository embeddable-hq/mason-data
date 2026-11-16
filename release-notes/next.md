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

- **A whole row of a table an outer join leaves unmatched is now NULL, as in Postgres.** In `a LEFT JOIN b`, a row of
  `a` with no match read `row_to_json(b)` as `{"id":null,…}` and `b::text` as `(,)`. Both are now NULL. So are
  `to_json(b)`, `to_jsonb(b)`, `b` itself, and the element `json_agg(b)` adds. It holds for a RIGHT and a FULL JOIN, a
  nested join, and a subquery or a WITH query that selects its table's primary key, a count or a constant. A subquery
  whose every column may be NULL in a matched row is now refused by name, since Mason cannot tell its unmatched rows.
  Select its primary key too, or name its columns.
- **A table synced whole is no longer served with rows missing until its catch-up.** This is a first sync, or a
  table synced again whole, such as after its columns change.
  - Before, the synced table held only the rows written before the oldest open transaction on your database began.
    It was served like that until its catch-up a moment later, or longer when the catch-up failed. In the worst case
    it served 0 rows: a `TRUNCATE`, then another transaction left open, then the reload.
  - Now each whole sync is caught up before it is served. Until then, a table synced before keeps serving its previous
    data, and a new table is not served yet.
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
