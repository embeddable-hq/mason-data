The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A mistake in one table's entry no longer stops Mason keeping the other tables current.** Before, if a column that a
  `columns:` entry lists was renamed on your database, Mason stopped taking the sources file while it ran. From then on,
  a column added to any other table was never synced, and a renamed column elsewhere made that table's polls fail, until
  a restart. Now only the table whose entry is wrong is held. It keeps serving the data it holds, and never syncs the
  renamed column under its new name until your file says so. Its line in `mason status` and on the web page says why,
  and gives the line to write. `mason add <table> --columns …` while Mason runs takes the fixed entry at once. A fix
  made by hand is taken the next time Mason reads the file: at `mason stop && mason start`, at a `mason add` or
  `mason remove`, or when a table's columns change on your database. Mason also checks a held table on your database
  again: a polled one at its poll interval, and a replicated one every minute. A `sync: off` one is checked when you
  run `mason sync <table>`. If the problem is gone there, such as a column renamed back or a unique index a `key:`
  needs restored, the table is synced again. Every other table is kept current as before.
  - A new entry whose table's name differs only in case from a synced table's, such as `Accents` beside `accents`, is
    never synced while Mason runs, wherever you write it in the file. The synced table keeps syncing. The new entry's
    warning says to remove one of the two entries.
  - The warning for a sources file Mason cannot read while it runs said "mason start reads the file again". It now says
    to run `mason stop && mason start`, since `mason start` alone only says Mason is already running.
