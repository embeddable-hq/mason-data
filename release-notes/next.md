The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.
- **Mason now refuses to start when the sources file names a table it cannot sync for the case of its names.** This
  is a table with two columns whose names differ only in case, such as `"Status"` and `status`. It is also two tables
  whose names differ only in case, such as `"Orders"` and `orders`. Before, the first never synced, and the second
  served one table under both names. The refusal names the entry and the line to write, such as `exclude: [status]`.
  Only `mason start` names such an entry that the file already holds. `mason tables` does not.

## What changes

- **The web page links to how to change a deployed project.** When a deployed project's Tables page says it is
  read-only, its link now goes to the README's new "Change a deployed project" section. A host that runs Mason for
  others can link to its own steps instead. Set `MASON_UI_DEPLOY_DOCS_URL` on `mason serve` to a path on the page's
  host or an `https://` or `http://` URL. It follows `MASON_UI_BACK_URL`'s rules. A value Mason cannot use stops the
  start with a message that says what is wrong.
- **Every list on the web page now behaves the same in a narrow window.** Where a list is wider than the window, it
  scrolls sideways inside its box, and each row's buttons stay in view at its right. The page itself never scrolls
  sideways.

## What was wrong and is now right

- **A table rewritten on your database while Mason read it is no longer served empty or partial.** A rewrite is a
  `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, an `ALTER TABLE` that rewrites the table (such as a column's type change), or
  a tool that swaps its file, such as pg_repack. Before, a first sync or a table synced again whole could read none of
  the table's rows, and serve them as 0 rows until its catch-up a few seconds later. A poll could also delete every row
  until the next poll. Now Mason keeps serving the table's previous data. A sync that meets a rewrite starts again at
  once. A poll that meets one writes nothing, and the next poll reads the table again. A rewrite after a transaction
  that is still open on your database began is different. No read can see the table's rows until that transaction
  ends. So Mason waits for it and checks again every 30 seconds. The table's line in `mason status` says so, with the
  transaction's pid. A `VACUUM FULL` or `CLUSTER` keeps each row as it was, so its sync goes on at once.
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
- **Some lists on the web page read badly in a narrow window. They now read whole.**
  - On the Users page, the Role column was cut to "every t…" in a middle-width window. It now shows the role whole.
    A user's id is cut short where the name's column is narrow. Hover over it to read it whole.
  - On the Users page, on a phone 320 to 390 px wide, a user's "from …" line could sit under the Queries, Disable and
    Remove buttons, so a tap on it pressed one of them. It now sits beside them, and a long one is cut short. Hover
    over it to read it whole.
  - On the Tables page, on a phone 320 to 350 px wide, the Table column was squeezed to a few letters a line. The list
    now scrolls sideways there instead. A row count too long for its column, such as "~40,000,000 rows", is cut short.
    Hover over it to read it whole.
  - On the Sync events page, a table name of 30 characters was cut short in a middle-width window. A name of up to 30
    characters is now shown whole.
  - On a phone, after Add or Sync now, the answer shown at the bottom of the screen covered the last rows' buttons, and
    the page could not be scrolled far enough to reach them. It now can.
- **In a project Mason cannot write, a column `exclude:` names can now be renamed more than once while Mason runs.**
  This is a project run with `MASON_PROJECT_READONLY=1`, or one whose sources file Mason cannot write. Before, a second
  rename of such a column made Mason stop taking column changes for the rest of the run, in every table. This also
  happened when the file was refused for another reason during the renames, and was fixed later. A column added
  elsewhere was never synced, and a renamed one failed its table's sync again and again until a restart. The excluded
  column was never served. Now each change is taken, and the renamed column stays out of the synced data. `mason
  status` shows one line for the table: what to write in the sources file now. When nothing is left out, that line
  says to write the entry as `{}`, or to take `exclude:` out of it. It used to say `exclude: []`, which a start
  refuses. While Mason runs, it also keeps out a column the file excludes when a column of that name is added back,
  and says so.
