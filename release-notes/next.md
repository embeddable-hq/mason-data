The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A table whose primary key has INCLUDE columns, and whose entry's `columns:` leaves out any one of them, is read
  again whole, once.** Plan for a full read of each such table from your database. It keeps serving its old data
  until the new sync is done, and the log says so. No other table is read again.
  - Why: Mason used to count an index's INCLUDE columns as part of the table's key, and a table's key is always
    synced. So for `PRIMARY KEY (id) INCLUDE (v, w)`, Mason synced `v` and `w` even when `columns:` left them out.
    Now the key is `id` alone, so `v` and `w` are synced only if the entry names them.
  - To avoid the read, add every INCLUDE column to the entry's `columns:` before you upgrade.
  - A table whose entry is `{}` or `exclude:` is not read again.
- **Check for synced tables with missing rows if a primary key has an INCLUDE column that can be NULL.** Before this
  release, a poll of such a table could delete synced rows whose INCLUDE column is NULL, while your database still
  held them. Upgrading stops further loss. It does not bring the lost rows back: a row comes back only when it changes
  on your database.
  - To tell if a table is affected, run `\d <table>` in psql on your database. Look for a primary key with `INCLUDE
    (…)`, where an included column is not `not null`. Then compare `SELECT count(*) FROM <table>` on your database and
    on Mason.
  - To get its rows back after upgrading, sync it again whole: run `mason remove <table>`, then `mason add <table>`,
    then `mason wait <table>`. The table is not served from the remove until that sync ends, so plan it for a quiet
    time.
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

- **A table synced by a `key:` no longer loses synced rows when the database stops keeping that key unique.** Mason
  checks a `key:` against your database's unique indexes when it reads the sources file. Before, if that index was
  dropped while Mason ran, two rows could share a key. A poll then deleted both of them from the synced data and put
  back only the one that changed.
  - Now Mason asks your database whether a unique index still covers the key. It asks before each poll, at `mason
    sync`, and before it syncs a table whole. The check reads only your database's catalog, in under a millisecond.
  - If none does, Mason does not sync that table, and the synced data stays as it was. `mason status`, `mason sync`
    and the web page say so. They name the sources file and the key, and the unique index to name instead, if the
    table has one.
  - A polled table whose primary key is dropped is held to the same check.
  - Mason asks your database again every minute, and syncs the table once the key holds again. The log says that the
    table waits for its key once, and again only if the reason changes.
- **A table under `sync: replication` no longer loses a synced row when its primary key is dropped on your
  database.** Before, a row inserted with the same key as a synced row replaced that row in the synced data, and
  nothing reported it. This happened with every replica identity, and when the key was dropped in the same
  transaction as the insert.
  - Now the stream checks the table's key after any change to the table's definition, before it applies the table's
    next change. Most tables need no extra query. A table with `REPLICA IDENTITY FULL`, or one whose key is gone,
    costs one catalog query on a short connection.
  - If the key no longer keeps the rows apart, Mason stops applying that table's changes and keeps serving its synced
    data. The other tables keep streaming. `mason status` and the log say why, and what to do: restore the primary
    key, or poll the table by one of its unique indexes.
  - Mason asks again every minute, and the log says it once. Once the key is back, one poll catches the table up, and
    it streams again. This holds when the key's return was committed with `synchronous_commit = off` too.
  - A row can still be lost in one case, as before this release. That is when the key is dropped, a duplicate row is
    written, that duplicate is deleted, and the key is restored, all before the stream reads the first of these
    changes. This can happen while Mason is stopped, or when the stream lags behind your database. To avoid it, make
    these changes while Mason is running and its stream is current. `mason status` shows how far behind it is.
- **A unique index with INCLUDE columns can be a table's `key:`.** For `UNIQUE (a) INCLUDE (b)`, `key: [a]` is now
  accepted. Before, it was refused as though no unique index covered `a`.
- **A table rewritten on your database while Mason read it is no longer served empty or partial.** A rewrite is a
  `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, an `ALTER TABLE` that rewrites the table (such as a column's type change), or
  a tool that swaps its file, such as pg_repack. Before, a first sync or a table synced again whole could read none of
  the table's rows, and serve them as 0 rows until its catch-up a few seconds later. A poll could also delete every row
  until the next poll. Now Mason keeps serving the table's previous data. A sync that meets a rewrite starts again at
  once. A poll that meets one writes nothing, and the next poll reads the table again. A rewrite after a transaction
  that is still open on your database began is different. No read can see the table's rows until that transaction
  ends. So Mason waits for it and checks again every 30 seconds. The table's line in `mason status` says so, with the
  transaction's pid. A `VACUUM FULL` or `CLUSTER` keeps each row as it was, so its sync goes on at once. To tell
  these apart, Mason reads a sample of the table's rows, never the whole table. That read takes at most one chunk of a
  sync's time (`MASON_COPY_CHUNK_SECONDS`). If another session holds a lock on the table, such as a migration's
  `ALTER TABLE`, the read gives up after a second, so it never makes your application's queries wait behind it. The
  sync then waits and checks again.
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
