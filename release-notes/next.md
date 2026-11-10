The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- A small synced table's size now appears on the web page's Tables view and in `mason usage` within 10 minutes of its
  first sync. Before, a table small enough that its rows stayed in the synced data's write-ahead log showed "—" with
  "not measured yet" for the life of the run. The Overview's "The synced data's file" card, `mason status`, `mason usage`
  and `mason_copy_bytes` now count that log too: they read 12 KiB for a file whose log held 1.3 MB.
