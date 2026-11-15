The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **Allow for one whole sync of a table whose primary key has an INCLUDE column, if its entry names `columns:`.**
  Mason used to count an index's INCLUDE columns as part of the table's key. A table's key is always synced. So for
  `PRIMARY KEY (id) INCLUDE (v)`, Mason synced `v` even when the entry's `columns:` left it out.
  - Now the key is `id` alone, so `v` is synced only if the entry names it.
  - At the first start, such a table is synced again whole, to drop `v`. The log says so. Its synced data serves as
    it was meanwhile.
  - To keep `v`, add it to the entry's `columns:` before you upgrade. Then nothing is synced again.
  - A table whose entry is `{}` or `exclude:` is not synced again.

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
  - A polled table whose primary key is dropped is held to the same check. A table under `sync: replication` is not
    checked yet.
- **A unique index with INCLUDE columns can be a table's `key:`.** For `UNIQUE (a) INCLUDE (b)`, `key: [a]` is now
  accepted. Before, it was refused as though no unique index covered `a`.
