The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A table synced by a `key:` no longer loses synced rows when the database stops keeping that key unique.** Mason
  checks a `key:` against your database's unique indexes when it reads the sources file. Before, if that index was
  dropped while Mason ran, two rows could share a key. A poll then deleted both of them from the synced data and put
  back only the one that changed. The same was true of a table's primary key.
  - Now Mason asks your database whether a unique index still covers the key. It asks before each poll, at `mason
    sync`, and before it syncs a table whole. The check reads only your database's catalog, in under a millisecond.
  - If none does, Mason does not sync that table, and the synced data stays as it was. `mason status`, `mason sync`
    and the web page say so. They name the sources file and the key, and the unique index to name instead, if the
    table has one.
