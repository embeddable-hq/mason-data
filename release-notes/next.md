The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A table whose primary key has an INCLUDE column, and whose entry's `columns:` leaves that column out, is read
  again whole, once.** Plan for a full read of each such table from your database. It keeps serving its old data
  until the new sync is done, and the log says so. No other table is read again.
  - Why: Mason used to count an index's INCLUDE columns as part of the table's key, and a table's key is always
    synced. So for `PRIMARY KEY (id) INCLUDE (v)`, Mason synced `v` even when `columns:` left it out. Now the key is
    `id` alone, so `v` is synced only if the entry names it.
  - To avoid the read, add the INCLUDE column to the entry's `columns:` before you upgrade.
  - A table whose entry is `{}` or `exclude:` is not read again.

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
  - Mason asks again every minute. Once the key is back, one poll catches the table up, and it streams again.
- **A unique index with INCLUDE columns can be a table's `key:`.** For `UNIQUE (a) INCLUDE (b)`, `key: [a]` is now
  accepted. Before, it was refused as though no unique index covered `a`.
