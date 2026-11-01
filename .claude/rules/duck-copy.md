---
paths:
  - "src/duck/extensions.ts"
  - "src/duck/sync.ts"
  - "tests/duck-copy-disk.test.ts"
  - "tests/duck-copy-order.test.ts"
  - "tests/duck-copy-retry.test.ts"
  - "tests/duck-extensions.test.ts"
  - "tests/integration/duck-poll.itest.ts"
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
  transaction of its own; then swapped in on the writer's turn (`swap`, which removes both) and caught up (`catchUp`).
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
  (the first file a chunk reads is the copy's). The first reader to fail — a rewrite, an error, `mason stop` —
  interrupts the others (`interruptible` per connection, `copyLanes`, re-sent every 50 ms) and none commits after it.
  A chunk's size does not grow with N (docs/DESIGN.md "Chunks read N at a time" says why). Raise N only against
  the source's own headroom, never past 8 (the extension's pool is 15 connections, the writer's poll among them).
- **Every chunk is held to the copy's FIRST snapshot** (`xminBeforeSql`, src/cdc/poll.ts: rows written before its xmin,
  the complement of the catch-up's `xmin8Sql >= watermark`): each DuckDB transaction is a new Postgres snapshot, and
  without the hold a row updated between two chunks is read twice (its old version from an early page, its new one at
  the heap's end; 250 keys of `duck-poll`'s resume test) or missed. Written with `age()`, never a text cast of `xmin`
  (the casts cost the source 5× a scan's CPU). It is exact only while no table rewrite (VACUUM FULL, CLUSTER, TRUNCATE,
  a type change: rows MOVE between pages) happened since the first chunk and fewer than 2^30 transactions ran: the
  table's `pg_relation_filenode`, read after each chunk under the lock its read still holds, and the snapshot's age are
  checked, and either starts the copy over from page 0, said. The swap asserts as many distinct keys as rows (a failure
  is a Mason bug: not swapped, copied again).
- **A passthrough read (`pq`) names its columns through `pgColumnSql`**, the copy's chunks and the poll alike: an exact
  numeric as text, and as `text[]` a citext[] / inet[] / json[] (`KEPT_ARRAYS`) and an enum array (`enumLists`, by its
  stored type) — `postgres_query` hands each over as one VARCHAR DuckDB cannot cast to the column (the
  oracle's enum array failed to copy, and a poll of a changed one had always failed).
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
  failing it. A table removed, or whose columns changed, loses its side table, progress row and chunk rows.
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

Run each probe that applies before a push: the harness's implement and fix prompts say so, and its Probe stage runs them
again before each review. Its Learn step adds to this list; each bullet names the PR or issue it was met in.

- A table holding every held built-in type and its array (point, money, macaddr, cidr, bit, tsvector, a range, `oid[]`):
  the copy writes what the poll and the stream write, and an older copy's layout is caught (PR 153).
