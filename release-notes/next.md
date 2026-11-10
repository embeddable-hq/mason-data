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
- A statement that takes a second or more now has its plan recorded with its row of the request log, so why it was
  slow can be read afterwards without rebuilding the plan by hand. Once the statement has ended and its answer was
  sent, Mason runs a plain `EXPLAIN` of it in the background: planning only, nothing run a second time. The plan says
  the tables it read and how fresh each was, the SQL sent to the synced data, and its operators with their estimated
  rows. Read it in `mason logs --requests --json` (`plan`, `planTruncated`), in a row's details on Observability ›
  Queries, or whole with the new `mason logs --requests --id <request id>`. A plan is at most 8 KiB and says when it
  was cut. One plan is recorded at a time: a slow statement that ends while another's is being recorded gets none, and
  the log says so. A statement bound with parameters has its operators recorded without their details, which could
  show the values it was bound with. A refused or cancelled statement has no plan. It is kept as the request log is
  (`MASON_HISTORY_DAYS`).
