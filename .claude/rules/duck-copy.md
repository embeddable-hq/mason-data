---
paths:
  - "src/duck/extensions.ts"
  - "src/duck/sync.ts"
  - "src/duck/text-compression.ts"
  - "tests/duck-copy-disk.test.ts"
  - "tests/duck-copy-order.test.ts"
  - "tests/duck-copy-retry.test.ts"
  - "tests/duck-extensions.test.ts"
  - "tests/duck-text-compression.test.ts"
  - "tests/integration/duck-poll.itest.ts"
  - "tests/integration/duck-rewrite.itest.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## The copy

- **Heap order, no index** (`src/duck/sync.ts` `copy`):
  every copy holds its rows in the order the source's scan delivers them, with NO PRIMARY KEY, UNIQUE or index
  (`duckdb_constraints()` empty for it). In key order every time-window query on the test server scanned all 195 M rows (a
  random uuid puts each day in every row group), the copy took 56 minutes and three times the table on disk, and the
  index (~21 GB of 53) had to be resident for any write of random keys. ("Heap order, no index")
- **Smallest first** (`copyOrder`): copies are queued, and taken from the queue, by the catalog's row
  estimate (unknown last, ties by bytes then name), a copy again included. On the test server three small tables (776, 15 k and
  22 M rows) waited the whole 23 minutes of a 196 M-row copy before they were current.
- **A copy is a sequence of CHUNKS that resumes** (the test server's copy could not step aside, and one that
  failed at 90 % started from zero, re-reading the source replica — ~738 GB over the day's attempts): the side table
  `<table>__mason_copy` (no key) is filled a range of heap pages at a time (sized by time, next bullet),
  each chunk a passthrough read (`pq`) of `ctid >= '(p,0)' AND ctid < '(q,0)'` (a TID range scan, never an ORDER BY
  there; the last chunk open-ended) appended in a DuckDB transaction of its own with ITS OWN row in
  `_mason.copy_chunks` (its page range, rows, the source's filenode; keyed by source and first page), COMMITTED — what
  the copy was begun with (first snapshot, columns, exact numerics, pages) is `_mason.copy_progress`, written once in a
  transaction of its own; then caught up by one poll into the side table (`catchUpSide`, below) and swapped in on the
  writer's turn (`swap`, which removes both).
  A copy that died (a crash, `mason stop`, a failure) continues with exactly the ranges no chunk committed
  (`chunksToRead`) when its columns are the same, said; a stop rolls back only the chunks in flight, and a copy that
  ends before any chunk committed keeps nothing. `rowsSoFar` is the committed chunks' rows (exact). Step 0 (`recopy`) is
  one transaction on one connection and does not resume. Never go back to one statement, add a key, a sort or an
  `ORDER BY` on the source without measuring again.
- **A chunk is sized by the TIME it takes here, never by a row estimate alone** (a laptop copying a
  20 M-row table over the internet showed `0 of ~20,126,276 rows` for minutes, then jumped 27 %; `nextChunkPages`,
  `nextRate`): the estimate's ~2 M rows (`COPY_CHUNK_ROWS`, `chunkPages`) is only the CEILING; a copy's first chunks are
  a tenth of it (at least `COPY_CHUNK_MIN_PAGES`), and every later one is what one reader reads in
  `MASON_COPY_CHUNK_SECONDS` (1–300, default 12; `copyChunkSecondsOf`) at a moving average of the rate its committed
  chunks measured (pages, rows and bytes a second, from BEGIN to COMMIT; quick to shrink, slow to grow), re-sized at
  every chunk taken. Why: the test
  server's 2 M-row chunks were ~6 s, the same rows over a WAN minutes, and a chunk is the unit that commits — what a
  stop reads again and what `mason wait` can count. Each chunk is cut from what no committed chunk covers (`copyGaps`,
  `takeChunk`), so a resumed copy reads exactly its uncommitted ranges whatever size its chunks were.
  `tests/duck-copy-order.test.ts` holds the sizing, `duck-poll.itest.ts` a copy whose reader slows half way.
- **A chunk's values out of line are held to the memory** (issue 96: a table of large `jsonb` values had a heap of a few
  hundred pages, so its rows ceiling was the whole table, one chunk, out of a 7.8 GiB limit; `chunkCeiling`): the source's
  TOAST bytes a heap page (`outOfLineBytes`, the catalog's, read once an attempt) bound the ceiling to an eighth of
  `store.memoryLimitBytes` over `MASON_COPY_PARALLEL` (`COPY_CHUNK_MEMORY_SHARE`), at least one page; a table with nothing
  out of line keeps the rows ceiling exactly. A chunk OUT OF MEMORY (53200 from `pgErrorOf`, never a regex of its own;
  53400 is the spill's ceiling, disk, and fails as any error) rolls back, its range is given back (`giveBack`, which keeps
  the gaps tiling), and the copy reads on with ONE reader, each chunk at most half the one that ran out, said once a
  step; a one-page chunk read alone that runs out fails the copy with `tooLargeText` (the limit as set, raise
  `MASON_DUCKDB_MEMORY`, `mason add … --columns`; never the engine's remedies), its chunks kept, backed off. No table is
  refused before it is read by a formula over the source's catalog: what the engine can write is the engine's to say,
  at the write (an up-front refusal by TOAST bytes refused 140,000 rows of ~2.6 KB that sync in 128 MB; PR 380). A
  checkpoint never merges the small row groups a copy of large values leaves (`max_vacuum_tasks` 0, read back at every
  open, `instanceSettingsProblem`): such a merge that did not fit invalidated the whole database (issue 371; docs/DESIGN.md
  "No checkpoint merges row groups"). `duck-poll.itest.ts` holds both shapes and the two out-of-memory paths (docs/DESIGN.md "Large values out of line").
- **A copy's progress is rendered between commits** (`CopyLive`, `copyProgressNow`, `CopyState.progress`): the chunks
  done and about how many in all, the ones reading and how long the oldest has, the readers' measured rate and the time
  the pages left take at it, and the rows the chunks in flight have read by now at that rate, each held under 90 % of
  its expected rows (its pages at the rows a page so far, `READING_SHARE_CAP`) so a commit that holds them moves the
  count forward: an estimate, which a chunk's pages may undercut (the heap's last page, a sparse range), when the count
  steps back to what committed. Its SHARE is of the heap's pages read
  (`share`), never of the rows: the ranges are exact and the row estimate is Postgres's, which a copy can outrun (23.7 M
  rows under 20.1 M sent the bar back to 0 %), and a share derived from an estimate must never move backwards.
  `mason wait` and `mason status` render it (`copyingText`, src/cli/commands.ts); the rate is the sync's, never a
  client's count over polls.
- **A copy reads `MASON_COPY_PARALLEL` chunks at once (1–8, default 3; `COPY_PARALLEL`, `readChunks`), each on a DuckDB
  connection of its own, so ONE backend on the source each — never the attached scan's ~10** (keep the load on
  Mason's side: overloading the source Postgres is the last thing Mason may do). One reader is one backend's
  throughput: on the test server's read replica a 2 M-row chunk of a table with two wide text columns took 6.1 s, 0.6 s of it the
  TID range scan and the rest that backend detoasting, formatting and sending at ~150 MB/s, so one reader took the
  22 M-row table 72 s against the attached scan's 28 s. The readers append to the ONE side table side by side (DuckDB 2.0
  lets transactions append to one table at once; `tests/duck-copy-order.test.ts` holds it — if it ever conflicts, each
  reader needs a side table of its own that the swap UNIONs ALL) and commit out of order; a chunk's range is a row of
  its own, never an update of one progress row (two readers updating one row would conflict), and the key refuses a
  chunk committed twice. Every chunk is held to the first snapshot and checks the filenode whichever reader reads it
  (the copy's file is the one its first snapshot sees, `heldFile`). The first reader to fail — a rewrite, an error, `mason stop` —
  interrupts the others (`interruptible` per connection, `copyLanes`, re-sent every 50 ms) and none commits after it.
  A chunk's size does not grow with N (docs/DESIGN.md "Chunks read N at a time" says why). Raise N only against
  the source's own headroom, never past 8 (the extension's pool is 15 connections, the writer's poll among them).
- **Every chunk is held to the copy's FIRST snapshot** (`xminBeforeSql`, src/cdc/poll.ts: rows written before its xmin,
  the complement of the catch-up's `xmin8Sql >= watermark`): each DuckDB transaction is a new Postgres snapshot, and
  without the hold a row updated between two chunks is read twice (its old version from an early page, its new one at
  the heap's end; 250 keys of `duck-poll`'s resume test) or missed. Written with `age()`, never a text cast of `xmin`
  (the casts cost the source 5× a scan's CPU). It is exact only while no table rewrite (VACUUM FULL, CLUSTER, TRUNCATE,
  a type change: rows MOVE between pages) happened since the first snapshot and fewer than 2^30 transactions ran: the
  table's `pg_relation_filenode`, read after each chunk under the lock its read still holds, and the snapshot's age are
  checked, and either starts the copy over from page 0, said. The swap asserts as many distinct keys as rows (a failure
  is a Mason bug: not swapped, copied again), unless the database no longer enforces the key, which is said as the
  key's refusal (duck-sync.md "A key is written by only while the database enforces it"), as it is before the first page.
- **A copy is held to the file its FIRST SNAPSHOT sees, never one a chunk happens to read, and never reads a rewritten
  table as empty** (issue 1025; `heldFile`, `fileFactsSql`, `RewriteWait`): a rewrite is not MVCC-safe, so a snapshot
  taken before it commits reads the new file once its read gets the lock, and an ALTER's or a TRUNCATE's rows there are
  invisible to it; a copy that took its file from its first chunk swapped in 0 rows, served until its catch-up. The
  beginning's transaction reads `pg_class.relfilenode` through its snapshot right after taking it, and every chunk's
  file must be that one (else started over); a resumed copy checks its file once (`resumedFileHolds`), and one begun
  with no chunk committed begins again. A file the snapshot sees whose catalog row was written at or after the
  watermark, by a rewrite (`relfilenode` no longer the oid), is checked for a row the hold keeps: none (an ALTER, a
  TRUNCATE and a load, pg_repack) and the copy WAITS for the open transaction that holds the watermark back (else its
  catch-up would read every row in one read of the source), checked every `REWRITE_RECHECK_MS` (30 s), never backed
  off, the old copy serving; a CLUSTER, VACUUM FULL or SET TABLESPACE keeps each row's xmin and goes on. **A wait is
  never a failure** (issue 1066: #1058 recorded a first sync that waited as `failed`, so `mason add t && mason wait`
  exited 1 while Mason only waited): no `error` of its own (it clears only the whole sync's own, `wholeErrors`, or an
  older Mason's wait, `OLDER_WAIT_ERROR`; a stream's or a poll's stays), a first sync's phase `waiting`, said as `CopyState.syncWaits` (its
  why and when it was checked), `sync.state` `waiting`, a `sync_waits` event that is no failure, and on the table's
  line (`notStreamedReason`), each time in the words of its last check. **The transaction is named only while it is
  open, and only one running at the snapshot** (`holderSql`, `holderOf`, `snapshotHolder`, read at every check, the
  decided ones included; a resumed sync's old snapshot taken with none running has the next id as its xmin, which a
  later transaction takes): #1058's words kept naming the
  first of two transactions older than the rewrite after it ended, a pid another session may hold by then. **That check reads a SAMPLE, never the
  whole table** (issue 1066: #1058's read every row of an ALTERed table under AccessShareLock, minutes on a large one,
  a migration's ALTER queued behind it and the application behind the ALTER): `rowsHeldSql` reads the first
  `HELD_SAMPLE_ROWS` visible rows of a plain scan (no ctid, no ORDER BY), since a rewrite treats every row alike, under
  `SET LOCAL lock_timeout` (`REWRITE_CHECK_LOCK_MS`, 1 s) and `statement_timeout` (`MASON_COPY_CHUNK_SECONDS`,
  `heldReadsNone`). A read they stop could not tell, and the copy waits as for "none", checked again (fail closed). It
  differs from the whole table's answer only for a table holding both kinds of row with the new ones first, and then
  waits rather than swap in part of it. **A poll is held
  to its snapshot's file the same way**: a read whose file is not the one the snapshot sees writes nothing and fails
  (its count found 0 and deleted every key). `tests/integration/duck-rewrite.itest.ts` holds each, in both modes.
- **A whole read is served only together with its catch-up** (issue 1066; `catchUpSide`, `swapCaughtUp`): the chunks
  keep only the rows written before the first snapshot's xmin, which an open transaction holds back, so a TRUNCATE,
  then a transaction left open, then the reload, was swapped in with 0 rows and served so until its catch-up — and
  every load or update since the oldest open transaction began was missing the same way, on a smaller scale. So the
  ONE poll from the whole read's watermark runs INTO THE SIDE TABLE (`poll`'s `into`, which moves nothing of the table
  served), and the swap carries that poll's snapshot as the watermark: what is swapped in is the whole table as of one
  snapshot, or nothing is. Until then the table serves its previous synced data, or is not served. Under replication
  the stream holds the table's changes from a writer's turn before that poll, in the side table's columns
  (`sideColumns`) and a stay that goes on past the swap, and the swap's turn applies them (`applySideHeld`), the
  table marked behind in the swap's transaction until then (a crash between is caught up by one poll). A mark set
  while it caught up (a slot made, `makingSlot`) is left to its own catch-up. **A table served is marked behind, in
  the ledger, as its side table's catch-up begins, and a catch-up that ends without a swap ends its stay**
  (`releaseSide`; the review of PR 1084: a sync again whole whose column change was reverted while it read had its
  table back in the stream, served, and a failed side poll dropped what the stream held and had acknowledged, for
  good, and wrote changes decoded in the side table's wider columns to the table served): one poll from the table's
  own watermark catches it up, and nothing decoded in the side's columns reaches it. `tests/integration/duck-rewrite.itest.ts`
  "loaded again after a transaction began" and "loses no change the stream held" hold it.
- **A passthrough read (`pq`) names its columns through `pgColumnSql`**, the copy's chunks and the poll alike: an exact
  numeric as text, and as `text[]` a citext[] / inet[] / json[] (`KEPT_ARRAYS`) and an enum array (`enumLists`, by its
  stored type) — `postgres_query` hands each over as one VARCHAR DuckDB cannot cast to the column (the
  oracle's enum array failed to copy, and a poll of a changed one had always failed).
- **A plain numeric's own scale is a hidden column every write computes** (`src/duck/scale-column.ts`, issue 946): a
  column declared `numeric` with no precision is DECIMAL(38, s) with a UTINYINT beside it, each value's decimals read
  from the source's text — the copy's chunks (`scaleSql`), the poll's `writeStaged`, the stream's `writeByKey` and
  `updateCarried` (`scaleOfText`). A new write path into a copy names it too, or that column prints at s again. It is
  never listed (the copy's view of its visible columns, stored JSON paths on or off), and the rewrite reads it only to
  print (`scaleOf`): keys, filters and aggregates stay the engine's DECIMAL. A copy without it is read again once
  (`SCALE_LAYOUT`). Why: Postgres prints `12.5` beside `12.49`, and one DECIMAL scale printed `12.50`.
- **A reference's hidden integer keys are a column a side table gets before its swap** (src/duck/reference-keys.ts
  `fillSide`, issue 1144): added to the side table and numbered from the dictionary, read only, on the rebuilds'
  connection, in chunks the stop can interrupt. Never listed, like the scale column. A key the dictionary lacks stays
  NULL until the writer numbers it.
- **Each text column is compressed by its own values** (`src/duck/text-compression.ts`, issue 1140): `beginCopy` reads
  one sample of the source in the copy's snapshot (`sourceLengthsSql`, then `sourceDistinctSql`: about 100 pages by
  `TABLESAMPLE SYSTEM`, at most 10,000 rows, one row of aggregates back each), and gives each VARCHAR or JSON column
  `USING COMPRESSION` in the side table's definition (`textStorage`): the dictionary (`dict_fsst`) for values under 64
  bytes or repeated, ZSTD for long values that do not repeat or a column whose text could reach 16 KiB. A json's or
  jsonb's sample is its size as stored, so it gets the dictionary only when every value is uncompressed and under 2,000
  bytes (`dictionaryHolds`). Why: a jsonb stored compressed at 3 KB was 52 KB of text, and the dictionary stored it
  Uncompressed, 51 times ZSTD's size. A compaction decides again from the table's own rows (`rewrite`,
  `syncedLengthsSql`). Why: the instance's forced ZSTD stored a six-value status 16 times larger than the dictionary, and
  a count by it read cold took 4.03 s against 0.17 s. The definition carries the choice, so a new path that makes a
  synced table must give its text columns a clause, or they fall back to the instance's ZSTD.
- **What heap order gives up**, said as such: a wide uuid-keyed table's click takes seconds, a point lookup by a random
  uuid is a scan, and uniqueness is the write path's (the oracle holds every copy to the source), not the engine's. The
  later step is a sort by a declared time column once the sources file names one.
- **A copy in the old layout is RETIRED** (`RETIRED_LAYOUT`): a copied table with a primary-key or unique constraint was
  stored in key order with its index. `open` says it by name, `mason status` / `wait` say it on its
  line, it serves as it was, and it is copied again through the normal path (`needsCopy`) — never converted in place:
  its rows are sorted on disk, and only the source has them in its own order. The ledger's re-sort columns are dropped
  and a stage file left beside the copy is removed, said.
- **A failed copy backs off** (`copyRetryDelayMs`: four times the attempt, at least 5 minutes, doubled per failure in a
  row, at most 6 hours; at once after a restart or a column/key change) and then CONTINUES with the ranges no chunk
  committed (its committed chunks are kept), and `mason stop` interrupts the chunks in flight, rolled back, never
  failing it (one waiting on the source is cancelled there: duck-sync.md "A stop cancels"). A table removed, or whose columns changed, loses its side table, progress row and chunk rows; one removed
  while it is read stops at once, its chunks in flight cancelled on the source (duck-sync.md "cut short").
- **Nothing yields to BI queries between chunks**: the listener keeps no count of statements in flight
  that the sync could read, so none was invented; DuckDB has no per-connection thread or priority control (`threads` is
  GLOBAL in 2.0, "cannot be set locally"). A reader is one Postgres backend and about one DuckDB core: beside one, a
  DuckDB query took ~1.2× its time alone, where beside the old one-statement scan (~10 backends) it took 4–6× (3 M rows;
  "The copy in chunks"); at N = 2–4 readers a query on the SOURCE took ~2× its time alone and a DuckDB one ~1.2–1.7×,
  and at N=3 the copy took the attached scan's time (4 M wide rows: 32–40 s against 29–41 s; "Chunks read N at a time").
- **The catalog serves a table the moment its copy commits**, on a DuckDB connection of its own that no copy's
  transaction holds (after a restart it was empty for hours behind a large copy).
- **The run never downloads an extension** (src/duck/extensions.ts; docs/DESIGN.md "The copy's extensions ship with
  Mason"): `postgres` and `inet` come from this platform's `@mason-data/extensions-<platform>` package, the instance's
  `extension_directory` with autoinstall off; DuckDB's INSTALL runs only where no package is found, said with the
  reason. A new extension the engine needs is added to `EXTENSION_NAMES` and pinned in `cli/extensions.json`, never
  left to an autoinstall; a DuckDB upgrade is `node cli/extensions.ts --pin` and its diff read.
  `tests/integration/extensions.itest.ts` holds a copy and an inet cast with HOME empty and the package read-only.
- **Read-only on the source**: a scan through a `READ_ONLY` attachment, SELECTs only, never an `ORDER BY` there (a sort,
  or an index walk, of the source table).

## What review probes

Run each probe that applies: the implementer before each push, and the fresh reviewer at each review (CLAUDE.md
"How work is done here"). A new probe is proposed to the owner; each bullet names the PR or issue it was met in.

- A table holding every held built-in type and its array (point, money, macaddr, cidr, bit, tsvector, a range, `oid[]`):
  the copy writes what the poll and the stream write, and an older copy's layout is caught (PR 153).
- A table of large out-of-line values (a few rows a heap page, ~1 MB of text `STORAGE EXTERNAL`, or `jsonb` of ~512 KB)
  under a low `MASON_DUCKDB_MEMORY` at `MASON_COPY_PARALLEL` 3: it syncs in chunks of a page's values, or fails with
  the operator's way out and never the engine's advice (issue 96); and many moderate ones (~2 KB, 140,000 rows) under
  128 MB, never refused before they are read (PR 380). A checkpoint that invalidated the database was issue 371's.
- `sizing-guard-from-derived-estimate`: a refusal decided up front by arithmetic on the source's catalog (out-of-line
  bytes a row group times a share, against the memory limit), measured on one shape and applied to all. Sync
  `CREATE TABLE t (id bigint PRIMARY KEY, v text)`, `v` `STORAGE EXTERNAL`, 140,000 rows of `repeat(md5(id::text), 64)`
  (~365 MiB out of line) under `memoryLimit '128MB'`, `copyParallel` 3: it syncs and equals the source, as the base
  does. The authority for "cannot be written" is the engine's own failure at the write (53200 at the commit or the
  checkpoint), said as the chunk out-of-memory path says it, never a formula the base's behaviour contradicts (PR 380).
