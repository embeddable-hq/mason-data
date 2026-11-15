The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.
- **A script that adds tables may now stop to ask.** `mason add` and `mason deploy` now stop before a table that likely
  won't fit on disk, with exit 1 and the code `disk_short`. Where a script or CI must go ahead regardless, add `--yes`.

## What changes

- **Adding a table now says up front when it likely won't fit on disk.** Before, its first sync started, and stopped
  only once it was under way and the disk ran short. Now Mason estimates how much disk the table's synced data needs.
  The estimate reads your database's catalog only, never the table. It is held to the free disk, less the room kept
  for queries that spill to disk (half of what is free, or `MASON_SPILL_LIMIT`) and what other first syncs still need.
  When it likely won't fit, nothing is added, and you are told the numbers. Choose fewer columns, give Mason more disk,
  or go ahead anyway: Add anyway on the web page, `--yes` on `mason add` and `mason deploy`. The estimate is rough. It
  usually overstates the size, and a sync that runs short of disk still stops before the disk fills. The Tables page
  shows each table's estimated size before you add it, and `mason tables` says it too. When a sync runs short of disk,
  its failure event and `mason status --json` now carry the code `disk_short` and the numbers, so a script need not
  read the message.

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
