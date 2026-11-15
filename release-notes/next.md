The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

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
