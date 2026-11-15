The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What was wrong and is now right

- **A column your sources file leaves out is no longer served under another name.** This covers a column that
  `exclude:` names, one a `columns:` entry does not list, and a secret-looking column `mason add` left out. Before, Mason
  matched columns by name alone. If two columns swapped names in one transaction, the left-out column was served under
  the other's name. The same happened after a rename while Mason was stopped, and to a column renamed to a name
  `columns:` lists. Now Mason knows each column by its identity on your database, which a rename keeps. A left-out
  column stays out under any name, its old name too. Mason syncs it again only once you confirm it. To confirm, run the
  `mason add <table> --columns …` command the table's line gives, which names every column to sync. A plain
  `mason add <table>` would leave secret-looking columns out again. `mason add` confirms whether Mason runs or not. You
  can also remove the table's entry and add it back. Until then, if your entry would sync the column, Mason stops syncing
  that table and keeps serving the data it holds. That covers a rename, a swap, a column renamed back under a name Mason
  took out of `exclude:`, and a name you take out of `exclude:` or add to `columns:` by hand. The table's line in
  `mason status` and on the web page says why, and gives the line that keeps the column out.
  - In a project deployed read-only (`MASON_PROJECT_READONLY=1`), the committed file is your word, so a column that did
    not move on your database is synced as the file says. A column that moved is held. Its line says how to sync it
    there: take the entry out of the committed file and start Mason, then put it back and start Mason again.
  - A table dropped and created again under its name is now read again whole by itself. Its columns are decided again by
    name, and a name the old table left out stays out.
