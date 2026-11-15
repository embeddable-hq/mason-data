The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A table whose synced data an older Mason lost is read again whole, once.** Only a project that removed one of two
  tables whose names differ only in case, such as `"Orders"` and `orders`, has one. It is the table it kept. Its first
  start reads it whole from your database. It is not served until that sync is done, and it was not served before the
  upgrade either. No other table is read again.
- **Mason now refuses to start when the sources file names a table it cannot sync for the case of its names.** This
  is a table with two columns whose names differ only in case, such as `"Status"` and `status`. It is also two tables
  whose names differ only in case, such as `"Orders"` and `orders`. Before, the first never synced, and the second
  served one table under both names. The refusal names the entry and the line to write, such as `exclude: [status]`.
  Run `mason tables` before you upgrade. It names each such table. When you remove one of two such tables, the other
  is read again whole from your database, once. It is not served until that sync is done, as it may hold the removed
  table's rows.

## What was wrong and is now right

- **A table with two columns whose names differ only in case is refused by name, never synced for ever in vain.**
  Postgres keeps `"U"` and `u` apart. The synced data holds a name without regard to case, so such a table's first
  sync failed with `Column with name "u" already exists`, again and again. Now `mason add` refuses it with the
  `--columns` that syncs the other columns. `mason tables` and the web page say why it cannot be added. `mason start`
  refuses such an entry written by hand, and says the `exclude:` to write. A column like that added on your database
  while Mason runs is said among `mason status`'s warnings, and the table keeps serving what it served. A letter
  outside ASCII keeps its case: `"É"` and `"é"` sync as two columns.
- **Two tables whose names differ only in case are refused by name.** With `"Orders"` and `orders` both in the sources
  file, Mason served one of the two tables under both names. Now `mason add` refuses the second, and `mason start`
  refuses a file that names both. The same holds for two schemas, such as `"Billing".invoices` and `billing.invoices`.
- **A generated table whose SELECT names two columns that differ only in case is refused at its file**, such as
  `SELECT 1 AS "U", 2 AS u`. Before, its build failed at every run.
- **Removing one of two tables whose names differ only in case no longer leaves Mason serving no table at all.** With
  `"Orders"` and `orders` both synced, removing either dropped the other's synced data too. The kept table then failed
  every sync, and Mason served no table, the others included, even after a restart. Now the kept table is synced
  again whole, and every other table is served throughout. A project already in that state recovers at its first start
  after the upgrade, with nothing to remove or add. One table that cannot be read never stops Mason serving the others.
