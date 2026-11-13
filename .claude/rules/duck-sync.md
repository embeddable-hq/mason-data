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
  - "src/duck/kept.ts"
  - "src/duck/compact.ts"
  - "tests/duck-compact.test.ts"
  - "tests/duck-compact-room.test.ts"
  - "tests/integration/duck-compact.itest.ts"
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
  for good. **Each schedule has a timer of its own, never one field for two** (issue 908): `timer` is the next pass's and a
  kick clears it; the stream's restart is `streamTimer` (a kick inside its wait ran a pass too soon to start the stream,
  cleared the restart, and the stream stayed stopped for the run); `wake` holds the earliest back-off and is set again
  for the next after every pass (`wakeForBackOffs`). DETECTOR: `duck-stream.itest.ts` "a pass kicked while the stream
  waits", `tests/duck-sync-schedule.test.ts`. A failed catch-up backs off as a failed copy does (`backOff`, `copyRetryDelayMs`), its whole error and next
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
  made (`recordRefusal`), and the literal `publication: null` asks for Mason's own on purpose (refused beside a set `PG_PUBLICATION`); **a start that
  reads another publication than the record (Mason's own → named, named → own, named → named) drops the SLOT, verified
  gone, with Mason's own publication when that was the one read, before the record moves (`staleReplication`; issue
  893: a slot resumed under a new publication decodes a transaction open across its creation without it — Postgres 18
  skips its changes with a WARNING alone, 16 fails the stream for good)**: the run makes the slot anew and catches each
  replicated table up by one poll, a full read of it, said at the start with that price. **A slot about to be made has
  its tables marked behind, with its record at 0/0, in one transaction committed BEFORE `CREATE_REPLICATION_SLOT`**
  (`prepareReplication`; the review of PR 897: marked after it, a `kill -9` between the two left the next start
  streaming the new slot under the old one's record, never caught up — the switch keeps the slot's name), **and no
  catch-up ends a mark while it is made (`makingSlot`); the marks a catch-up compares are set anew only once it exists**
  (the second review: a catch-up queued behind a copy polled while the slot's creation waited on an open transaction,
  took a mark set before the slot, and ended it — the transaction reached neither the poll nor the stream); verified by the ClickHouse reader's own `checkPublication` (src/duck/publication.ts), never a
  second verifier. A gap in one table refuses that table alone, the others stream on; the way out is the found
  publication plus the gap as `ALTER PUBLICATION … ADD TABLE …`. On a standby a named one is required, refused before
  any slot is made. ("Logical replication")
- **A write by key is a DELETE of its keys by ONE join against the table's key column, then an INSERT** (`writeByKey`,
  `writeStaged`, `deleteKeys`), in the piece's one transaction; an unchanged-TOAST update is ONE `UPDATE … FROM` per set
  of carried columns (`updateCarried`). Never `INSERT OR REPLACE` (it needs a key constraint) and never a statement per
  row: each is a scan of the key column — 4 ms a 10,000-change piece on 1 M uuid rows, 0.35–1.8 s on 195 M, tens of
  seconds on the test server's disk — so a stream batch that changes a table over `BIG_TABLE_ROWS` is applied by time as well
  (`applySize`: at most every 5 s, pieces of up to 50,000). A bigserial key prunes (heap order puts its zonemaps in order).
- **How a copy is kept current is derived ONCE, by the sync** (`Sync.keptOf`, carried on `Sync.state` as `kept`):
  `mason status` (`kept`: its sync, `syncedAt`, `nextAt`; `streamStatus`'s tables) and EXPLAIN's first line (`keptText`, src/duck/explain.ts) both
  read it, never the poll's ledger (a project switched to replication keeps its last poll there: EXPLAIN said "kept
  current by polling" of a streamed table). `tests/duck-sync-added.test.ts` and `tests/duck-wire.test.ts` hold it.
  ("EXPLAIN")
- **What a table's `sync:` promises is derived ONCE, by the sync** (`keptPromise`, carried on `kept` as
  `promisedSeconds` and `lateWhy`): a polled table its interval plus max(60 s, twice its own last poll), a recopied one
  the run's interval plus max(60 s, twice the last pass), a streamed one `REPLICATION_BEHIND_SECONDS`, an `off` one
  nothing. It reads what the schedule reads (`lastPollMs`, `lastPassMs`) and changes neither load rule: it SAYS them —
  `poll 15m` behind a 13-minute pass is polled about hourly, and said nowhere before (issue 106). Whether a table is
  behind is compared ONCE, at the moment asked, from the ledger's time (`kept.syncedAt`), never a schedule, a phase or
  `CopyState.synced.at` (src/cli/readiness.ts `behindOf`: `tables[].sync.state` `behind`). DETECTOR:
  `tests/duck-sync-schedule.test.ts`, `tests/cli-run-server.test.ts`.
- **A synced table is compacted by Mason, never by a checkpoint** (issue 851; src/duck/compact.ts, `Sync.compact`;
  docs/DESIGN.md "Compaction"): the checkpoint merges no row groups (issue 371), so a table's dead rows and its row
  groups past the fewest are read every 10 minutes on a connection of its own (`checkCompaction`, metadata only) and a
  table whose waste is half its blocks and 4 MiB is queued LAST, one rebuild at a time, never beside a first sync. It
  reads the synced data alone: the table frozen on the writer's turn (no poll, `mason sync` refused, stored JSON fills
  paused, a streamed table's changes SPILLED to `_mason.compact_held` in each batch's transaction, never held in Node's
  heap, and marked in `_mason.catch_up` for a stop or a crash), its rows into a side table in pieces held to
  `store.memoryLimitBytes` (halved at 53200) and, before each, to the free disk (`diskShortFor`: none, and the table
  waits, said), swapped as a copy is, the spill replayed after in pieces of 50,000. Its failure is an ordinary
  statement's, that table's alone: never its `error`, never fatal, backed off. A new writer of a synced table checks
  `rebuildingNow`, or it writes under a compaction and its write is lost at the swap. **A table whose changes are
  spilled is never marked current past what it serves** (issue 904: the batch's position moved its `synced`, so `mason
  status`, `wait` and `caughtUp` said current while the newest changes waited in the spill; the bulk itest read
  DuckDB 7,000–17,000 changes short): its part in the stream is `compacting`, its `kept.syncedAt` the moment its spill
  began (`heldFrom`), its `synced` left as it was by every batch until the replay's last piece, which sets it to the
  stream's last position; `caughtUp` waits for the spill; a stop or a replay that fails before it ends leaves it
  `behind`, as its mark says. DETECTOR: `tests/duck-compact.test.ts`, `tests/integration/duck-compact.itest.ts`, the
  bulk test of `tests/integration/duck-stream.itest.ts` (compaction checked every 3 s).
- **No INSERT … SELECT into an empty CREATE TABLE AS of the same transaction** (`writeByKey`; the review of PR 856):
  DuckDB 2.0.0 reads back NOTHING of a table made by `CREATE TABLE AS … LIMIT 0` and filled by one INSERT … SELECT of a
  row group's rows (122,880) or more in that transaction (`count(*)` says them all; lost even after the COMMIT), and a
  write by key of more keys deleted none and inserted every row twice. Fill it by VALUES, or make it before the
  transaction or by an explicit CREATE TABLE. DETECTOR: `tests/duck-compact.test.ts` "a held set of 300,000 changes".

## What the sync records

- **The source's password is in no string the engine repeats, and in no error's words the sync repeats** (issue 599: the
  extension's `Unable to connect to Postgres at "<path>"` repeated `password='…'` into the log, the ledger, `mason
  status` and the web page when a source restarted under a run). The ONE `ATTACH … (TYPE postgres)` (`attach`) takes
  `attachPath` (`sslmode` and `application_name`, nothing else) and the credentials as a TEMPORARY secret
  (`sourceSecretSql`), dropped right after the ATTACH; never a keyword string, a PGPASSWORD or a new attach site. The
  secret's statement is the one text that holds the password, so its error is said by its code alone. A caught engine or
  driver error becomes words ONCE, where it enters, through `this.errorText` (src/lib/secret-mask.ts `errorText`; the
  stream is handed it), which masks only a `password=` value — never a substring of the password, which a table's,
  a user's or a slot's name may hold (the reviews of PR 620: `public.****ices`, `public.****_archive`, `for user
  "****"` showed where it sat, and stuck `mason wait`). **A decision never reads those words**: it reads `messageOf`
  (`widerIn`, `endedTransaction`, the stream's `away`). No answer is walked by a mask. `open` scrubs the `password=`
  value from the ledger's `error` and `message` an earlier Mason wrote (`scrubLedger`, bound parameters). DETECTOR:
  `tests/integration/duck-secret.itest.ts` (the engine alone, the mask alone through `attachSeamForTest`, a password
  inside names, `mason start` under `dev`, `mason start` searched whole), `tests/secret-mask.test.ts` (the forms, and
  sync.ts / stream.ts making an error's words only through `errorText` and deciding only on `messageOf`). ("Security
  comes first")
- **Every sync failure is a row of `_mason.sync_events`, kept as the request log is** (src/duck/events.ts: a failure
  was kept only as a table's CURRENT error, wiped by the next success, and earlier ones only in the log file): the sync
  says each where it logs it (`Sync.event`: copy, poll, catch-up and stream failures, the database out of reach, a copy
  finished, a table current again — the last detected in `record`, the one place an error is cleared — and a sync asked
  by hand, `synced`, in the words mason sync answers: without it a person who synced read the list as a sync lost —
  and the scheduled syncs that succeed, `polled` a poll and `streamed` ONE a table a minute of the stream's changes
  (`reportStream`, never one a batch), which a reader gets only when it asks (`SCHEDULED`, `?scheduled=1`,
  `--scheduled`: in the query, so they never take a failure's place among the newest asked for)), `SyncEvents`
  writes them in batches on a connection of its own, never the writer's turn, a failed write said once and never
  failing the sync; a failure repeated word for word within an hour is one event unless it was over between — a
  table's when it is current again (`recovered`) or copied anew (`copied`), the whole sync's (`table: null`) when the
  sync says so (`recovered` of no table: the stream applied a batch WITH A POSITION, the publication and slot were made
  ready, the database attached — `wholeFailure`); never a failure whose end nothing says. **A copy's replication error
  is over only when the stream applies a batch with a position** (`applyChanges`: every table it keeps current is current
  as of it), **or says it has everything the database wrote** (`streamCurrent`: a keepalive with nothing pending, the
  same proof — an idle database sends no batch, and a run-old stream error stayed on a healthy table, which `mason wait`
  read as failed once readiness read the state, issue 254), never at a pass's publication check (`settlePrepared`, which runs while the stream waits out its back-off)
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

## What review probes

Run each probe that applies: the implementer before each push, and the fresh reviewer at each review (CLAUDE.md
"How work is done here"). A new probe is proposed to the owner; each bullet names the PR or issue it was met in.

- A store written by the previous release (a `copy_state` row without the new field, a `point` copied as a STRUCT, an
  enum column): synced again exactly where the layout differs, and quiet on the second start (PR 153).
- A kept form or ledger column changed: a store from the previous release, or from an earlier commit of the branch, read
  again or refused plainly, never decoded as `NaN` or failing a SELECT (PR 135, 156).
- A replicated table leaving the stream for a re-sync whose column change is reverted before it swaps: back in the
  stream with no catch-up (issue 79).
- A slot invalidated for another reason (a conflict on a standby): blamed on `max_slot_wal_keep_size` (issue 74).
