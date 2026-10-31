---
paths:
  - "src/duck/events.ts"
  - "src/duck/publication.ts"
  - "src/duck/stream.ts"
  - "src/duck/sync.ts"
  - "src/cli/dev.ts"
  - "tests/duck-events.test.ts"
  - "tests/duck-publication.test.ts"
  - "tests/duck-stream.test.ts"
  - "tests/duck-sync-added.test.ts"
  - "tests/duck-sync-facts.test.ts"
  - "tests/duck-sync-schedule.test.ts"
  - "tests/integration/duck-poll.itest.ts"
  - "tests/integration/duck-stream.itest.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## Keeping a copy current

- **A copy runs BESIDE the stream and the polls, never instead of them** (one 195 M-row copy stopped
  every other table's freshness, and held the slot's WAL, for 35 minutes): on a DuckDB connection of its own
  (`rebuilder`), one rebuild at a time (the memory limit is one), writing only its table, side table and ledger rows. A pass never stops the stream; `stop` stops all of it. ("A copy beside the stream")
- **Everything else that writes takes a turn on the writer (`onWriter`)**: a statement on a connection lands inside
  whatever transaction is open there, so the stream's batches, the polls, the source's attach/detach (instance-wide,
  counted per user) and every rebuild's SWAP (a DROP under another transaction's write fails its commit) each wait for
  the one before. A turn never queues another and waits for it: it would wait for itself.
- **A rebuilt table is caught up by ONE poll from its watermark before it is kept current again** (`_mason.catch_up`,
  written with the swap): skipped by the stream and the polls until then. In replication mode the stream HOLDS its
  changes from just before that poll and applies them after it — the stream acknowledges what it skips, so a table
  joining late is missing exactly what that poll reads (src/duck/stream.ts "why replaying is safe"). A table whose sync
  is `off` is caught up too: one scan per rebuild, then served as of it.
- **A stream change is written as the COPY's columns, never the publication's or the sources file's of the moment**
  (`Sync.asCopied`, the copy's own column list, set at its swap; `projectTuple` in src/duck/stream.ts): a column the
  publication sends and the copy lacks is dropped, and every write — a batch, the held changes, `updateCarried`, a delete
  by key, the catch-up's poll — names only the copy's columns; changes decoded in another shape are never applied to a
  new copy (its snapshot holds them). The sources file changes while a copy runs: the test server's 22 M-row table once had a
  column removed and restored mid-copy, and the held changes were written naming a column the new copy lacked (`Binder
  Error`). A relation that stops carrying a column the copy holds (a DDL, a narrower publication) refuses THAT table by
  name with the way out, marked behind before anything past it is acknowledged; the others stream on.
  ("Logical replication")
- **A batch holds a table's changes of ONE STAY in the stream, and only the stay it is in now is applied**
  (`StreamedTable.stay`: a new number when the table enters `streamed` or its copy is swapped, never used twice;
  `streamOnce`, `applyStreamed`): an ended stay's changes committed before the next copy's catch-up, so that copy or
  catch-up holds them. Never tell them apart by columns: two copies inside one flush (a sources file edited and restored,
  0.2 s each on CI) mixed two shapes in one batch (`VALUES lists must all be the same length`, then the 5-minute
  back-off), lost the changes after the catch-up's poll (a batch that began in a copy gone by the flush), or replayed an
  old change over the poll that read a newer one (same columns). `duck-stream.itest.ts` "a batch open across" forces each
  order. ("Logical replication")
- **A table is never left neither streamed nor copied**: after every rebuild, a table that still needs a copy or a
  catch-up gets a pass at once (`followUp`; a change of its columns during its copy re-copies it at once), or when its back-off
  ends (`wakeAt`) — replication mode runs a pass only when kicked, and on the test server a failed catch-up left that table dead
  for good. A failed catch-up backs off as a failed copy does (`backOff`, `copyRetryDelayMs`), its whole error and next
  attempt said in the log and `mason status` (`catchUp.retryAt`). ("Logical replication")
- **A multi-line reason is ONE log entry**, its further lines indented (`textEntry`, src/lib/log.ts: the
  run's log, mason.log, is written through it, src/cli/dev.ts) — the test server's Binder Error was read as its first line.
- **A table being caught up holds its decoded changes in Node's heap** until its catch-up poll ends (`held`, `catchUp`):
  unbounded for a migration's transaction during a long catch-up. Known, not fixed ("What stands between this and
  production").
- **The poll is ONE DuckDB transaction per table over ONE source snapshot**, its rows and new watermark committed
  together (`_mason.poll_state`), so a poll that dies is read again; it costs the source a full scan per table (no index
  covers `xmin`). ("The poll")
- **How often a table is polled is ITS `sync:`, never the run's** (src/lib/table-sync.ts; one 22 M-row table and a
  776-row one shared one interval, and a row limit in the run left the big one never polled, said only on its line):
  `off` (the default) is read again only at `mason sync`, `poll <interval>` at that interval, 1 s to 24 h. ONE pass loop
  polls the tables due (`dueAt`), never a timer a table; a table's next poll is its interval after its last, stretched
  to four times that poll's time (`nextPollAt`), and the passes to four times the last pass (`passDelayMs`). The sync a
  table was last polled or copied under is `_mason.poll_state.sync`: a change (live or made while Mason was down) keeps
  the copy and catches it up by ONE poll, logged, never a copy again. The engine never decides by size: the row count
  is `mason add`'s (src/cli/source-edit.ts), which writes `sync: off` for a table over `BIG_TABLE_ROWS` under a file
  that polls, and warns a poll of over `COSTLY_POLL_ROWS` under a minute with its estimate and basis. A setting that
  sets an interval for every table (`MASON_POLL_MS`) refuses the start. DETECTOR: `kept` on every table's line
  (`mason status`, `wait`, EXPLAIN, the MCP tools) says its sync and its copy's age; `tests/duck-sync-schedule.test.ts`
  and `tests/integration/duck-poll.itest.ts` hold the schedule and the switch. ("Each table's sync") **A polled table's
  `kept.pending` is `pollable`'s answer, never a second check**: nothing pending means a `mason sync` of it runs, so a table
  stays pending until its rebuild ended, the writer's turn after its catch-up, and says so in its own words
  (`notStreamedReason`; `rebuildingNow.kind` turns to `catch-up` as the whole read ends). A pass is ONE
  attachment of the source (`attach` / `detach`: a new connection on the database), so at `poll 1s`, the floor, a
  table costs the source a connection a second beside its scan; holding the attachment across close passes is a later
  step, measured first.
- **Replication has no gap, by construction**: a table is copied only after the publication carries it and the slot
  exists, joins the stream only once caught up, and a key's changes replayed in commit order end at its state whatever
  they start from; a slot new to the copy is caught up the same way, by ONE poll from the watermarks, never a fresh
  copy. (`src/duck/stream.ts`; "Logical replication")
- **A batch is committed before it is acknowledged**: whole transactions applied in one DuckDB transaction with the
  position they end at (`_mason.stream_state`), and only then sent to Postgres; a run that dies between skips what its
  record says it applied.
- **The stream says when a table joins or leaves and where it is; a stream that is silent is a bug** (the
  test server's first run printed one stream line in 35 minutes and `mason status` showed no position): a join and a leave are a
  line each with the position, found in ONE place (`refreshStreamed`), never a line per batch; a periodic line at most
  once a minute when something moved (`reportStream`); `mason status` / `wait` / `--json` show the position, the
  database's (a connection at most every 5 s, never the keepalive's: that is the walsender's read position), the lag in
  bytes and as the newest change's age, the WAL the slot holds on the database (`stream.slotWal`: one row of
  `pg_replication_slots` on that same connection, at most every 30 s, `SLOT_READ_MS` — its status, and the cap left, or
  that `max_slot_wal_keep_size` is unset and nothing caps it), and each table's state and changes applied
  (`streamStatus`). A new state of a table is a state there too. ("Logical replication")
- **A table is streamed only when its `sync:` is `replication`; the others are polled beside the stream, or `off`**
  (`Sync.replicated`, `Sync.streams`): one slot and ONE publication per project, the publication carrying the
  replicated tables ALONE — Mason's own `SET TABLE` to exactly that list, verified against `pg_publication_tables`
  afterwards (a polled table's writes in the slot's WAL are WAL held for nothing), a named one never altered. A `key:`
  table and a `REPLICA IDENTITY NOTHING` one under `replication` are refused at the file's read with the line to write
  (`entryProblems`; the stream cannot apply a keyless change, and publishing NOTHING fails the app's own UPDATEs).
  A sync change keeps the copy in every direction: into replication it is marked behind in `_mason.catch_up` and caught
  up by one poll while the stream holds its changes; out of it, it leaves the stream and is caught up by one poll.
  `mason start --replication` / `--poll` / `--publication` and `MASON_CHANGES` are gone: each answers with the line to
  write in the sources file, starting nothing (`removedStartFlags`, `changesRetired` at `mason start` and `mason serve`, src/lib/table-sync.ts). **A table set to `replication` while the run is
  up, in a run that never checked the database for it, is held to the start's own checks first** (`checkReplication`,
  src/cli/dev.ts; `liveReadinessFailure`): refused with what the database lacks and the line that polls it, the file put
  back byte for byte — a review finding: on `wal_level = replica` the add said success and the table, polled until then,
  was frozen for ever; the engine's own failure to set replication up says the same way out on the table's line.
  DETECTOR: `tests/integration/duck-stream.itest.ts` (a mixed project, the publication's list, a switch each way held to
  the ledger), `tests/cli-run-server.test.ts` (the live refusal). ("Each table's sync")
- **The slot outlives `mason stop` and holds the source's WAL** (said at the stop); it is dropped, with Mason's own
  publication, VERIFIED gone, when the file says no table's sync is `replication` any more (`retireReplication`: at the start, and live
  when the last one leaves) and at `mason destroy`, from what the config records (`config.replication`). A project with
  a slot recorded (or an older Mason's `config.changes`) under a file naming tables with no `sync:` anywhere is refused
  instead, nothing dropped (`recordRefusal`), and a run up keeps the tables read before (`silentOverSlot`,
  `rereadSources`): the drop is a full scan of every table to undo, and a silent file is no decision.
- **A NAMED publication is read and verified, never created, altered or dropped; Mason makes its own only when none is
  named** (a read replica takes no CREATE PUBLICATION, and on a production primary the slot is the one
  object Mason creates). Named by `publication:` at the top of the sources file (`${PG_PUBLICATION}` allowed, read by
  `readSource`), else `PG_PUBLICATION` (`namedPublication`) — never the one a
  start recorded, read silently: a replicating file that names none over a recorded one is refused before anything is
  made (`recordRefusal`), and the literal `publication: null` asks for Mason's own on purpose (refused beside a set `PG_PUBLICATION`); Mason's own one left behind by a switch to a
  named one is dropped, verified gone, before the record moves (`staleReplication`); verified by the ClickHouse reader's own `checkPublication` (src/duck/publication.ts), never a
  second verifier. A gap in one table refuses that table alone, the others stream on; the way out is the found
  publication plus the gap as `ALTER PUBLICATION … ADD TABLE …`. On a standby a named one is required, refused before
  any slot is made. ("Logical replication")

## What the sync records

- **Every sync failure is a row of `_mason.sync_events`, kept as the request log is** (src/duck/events.ts: a failure
  was kept only as a table's CURRENT error, wiped by the next success, and earlier ones only in the log file): the sync
  says each where it logs it (`Sync.event`: copy, poll, catch-up and stream failures, the database out of reach, a copy
  finished, a table current again — the last detected in `record`, the one place an error is cleared — and a sync asked
  by hand, `synced`, in the words mason sync answers: a scheduled poll that succeeds is no event, and without it a
  person who synced read the list as a sync lost), `SyncEvents`
  writes them in batches on a connection of its own, never the writer's turn, a failed write said once and never
  failing the sync; a failure repeated word for word within an hour is one event unless it was over between — a
  table's when it is current again (`recovered`) or copied anew (`copied`), the whole sync's (`table: null`) when the
  sync says so (`recovered` of no table: the stream applied a batch WITH A POSITION, the publication and slot were made
  ready, the database attached — `wholeFailure`); never a failure whose end nothing says. **A copy's replication error
  is over only when the stream applies a batch with a position** (`applyChanges`: every table it keeps current is current
  as of it), never at a pass's publication check (`settlePrepared`, which runs while the stream waits out its back-off)
  nor at a piece of a large transaction; the check clears only what it owns — a named publication's gap once the table is
  carried again, and its own failure on a table never copied.
  The supervisor's restarts stay in `.mason/restarts.json` (a process of its own cannot open the file) and are merged
  when read (`withRestarts`). `mason logs --events` and `mason status` (`recentErrors`) read them through the command
  server's `/api/events`.
- **A copy's `rows` is its count after every write that changes it** (`CopyState.rows`): the copy's own count at the
  swap, the poll's reconciled count at its commit, and after every stream batch the rows its writes inserted less the
  rows they deleted (`rowsChanged`, `writeByKey`) — never a `count(*)` per batch (a write by key's deletes make it a
  scan) — written to `copy_state` IN the batch's transaction. When it was last brought current, and how,
  is `CopyState.synced` (`Synced`: the swap, a poll's start, the stream's last batch); `/api/state` derives each
  table's state in one word (`syncStateOf`, src/cli/readiness.ts) and its age at the moment asked. **A poll's or a
  batch's time is ONE value, the ledger's**: taken once before the sync's transaction, written in it (`polled_at`,
  `applied_at`) and remembered as written (`polledAt`, `synced`), never `now()` in the ledger beside a `new Date()`
  here — the two stood until `readPolledAt` replaced one with the other, and a table's `syncedAt` went 8 ms backwards
  under `mason status`. **A copy has TWO, each one value**: its watermark's `polled_at`, taken before the swap, which
  `kept.syncedAt`, `dueAt` and `nextAt` read, and `copied_at`, taken after it, which `CopyState.synced.at` and
  `copiedAt` read; they differ by the swap's length, and `copied_at >= polled_at` is how `readSynced` tells a copy from
  a later poll. **`readPolledAt` only ever moves a time forward** (its SELECT's snapshot may be older than a commit on
  the rebuilds' connection), and drops a table the ledger no longer holds only when no commit gave it a time meanwhile.
  `tests/duck-sync-facts.test.ts` and `tests/integration/duck-poll.itest.ts` hold what the run says to the ledger.
