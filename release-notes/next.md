The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What changes

- **You can see, before you upgrade, which synced tables the new release reads again whole.** Run
  `npx @mason-data/cli@<version> upgrade --check` in the project's folder while Mason runs, with the version you are
  upgrading to. It lists each table that release's first start reads again from your database, why, how large it is,
  and whether it keeps serving its synced data until its new sync is done. It changes nothing. `--json` gives the same
  as data.
  - It works only for an upgrade from this release or a later one. An older Mason does not say what its synced data
    holds, and the command says so. For an upgrade from 0.22.0 or before, read each release's "Before you upgrade".

## What was wrong and is now right

- **A WITH query named like the table it reads now gives Postgres's answer.** In
  `WITH orders AS (SELECT * FROM orders WHERE status = 'paid') SELECT count(*) FROM orders`, the WITH query's own
  `FROM orders` reads the table, as on Postgres. Before, Mason counted 0 rows. With a join, the query failed with
  XX000 "Maximum call stack size exceeded". This also holds when the WITH query is inside a subquery or one arm of a
  UNION, and when a later WITH query reads an earlier one named like a table. A WITH query in one arm of a UNION,
  named like a synced table, could also read that table instead of itself when the query held a `*`. It now reads
  itself.
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
