The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What changes

- **The web page links to how to change a deployed project.** When a deployed project's Tables page says it is
  read-only, its link now goes to the README's new "Change a deployed project" section. A host that runs Mason for
  others can link to its own steps instead. Set `MASON_UI_DEPLOY_DOCS_URL` on `mason serve` to a path on the page's
  host or an `https://` or `http://` URL. It follows `MASON_UI_BACK_URL`'s rules. A value Mason cannot use stops the
  start with a message that says what is wrong.

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
