The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- How long a statement took, and the average, p50 and p95 of those times, are now always whole milliseconds with
  thousands separators (`19,800 ms`, `810 ms`, `27 ms`), so a column of them can be compared at a glance. Before, the
  unit changed at a second and at a minute (`19.8 s`, `2 min 5 s`). This applies on the web page (Observability ›
  Queries' Duration, the Overview's p95 card, statements table and query errors, Usage's cards, hours, p95 chart
  read-out and slowest statements) and in the text of `mason logs --requests`, `mason status` and `mason usage`.
  `--json` still gives numbers. A chart's axis, a statement still running, a sync's time, an interval and an age keep
  their form. On Observability › Queries, the Statement cell
  now has its own `+` beside the statement. It opens and closes the same row as the Query id's `+`.

## What was wrong and is now right

- A small synced table's size now appears on the web page's Tables view and in `mason usage` within 10 minutes of its
  first sync. Before, a table small enough that its rows stayed in the synced data's write-ahead log showed "—" with
  "not measured yet" for the life of the run. The Overview's "The synced data's file" card, `mason status`, `mason usage`
  and `mason_copy_bytes` now count that log too: they read 12 KiB for a file whose log held 1.3 MB.
