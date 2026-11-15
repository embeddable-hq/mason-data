The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What changes

- **A sync that waits for an open transaction on your database now reads as waiting, never as failed.** Mason waits
  when a table was rewritten after a transaction that is still open began. It checks again every 30 seconds and goes
  on by itself.
  - `mason status` and the web page now say Waiting, with the transaction the sync waits for. Before, they said
    Failed.
  - `mason wait` keeps waiting for a first sync that waits, within its `--timeout`. Before, it exited 1, so
    `mason add <table> && mason wait` read the wait as a failure. A table synced before is served meanwhile, so
    `mason wait` is ready for it.
  - In `mason status --json` and `mason wait --json`, the table's `error` is now `null` and its `sync.state` is
    `waiting`. A new `syncWaits` says why, and when Mason last checked. If a script or an alert looks for `failed` to
    catch this case, it no longer matches.
  - The event is now `sync_waits`, and it is not a failure. Before, it was `full_sync_failed`.
  - The message names the transaction and its pid only while that transaction is still open. Before, it could name
    one that had already ended, whose pid may belong to another session by then.

## What was wrong and is now right

- **A table synced whole is no longer served with rows missing until its catch-up.** This is a first sync, or a
  table synced again whole, such as after its columns change.
  - Before, the synced table held only the rows written before the oldest open transaction on your database began.
    It was served like that until its catch-up a moment later, or longer when the catch-up failed. In the worst case
    it served 0 rows: a `TRUNCATE`, then another transaction left open, then the reload.
  - Now each whole sync is caught up before it is served. Until then, a table synced before keeps serving its previous
    data, and a new table is not served yet.
