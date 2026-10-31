---
paths:
  - "src/duck/kept-route.ts"
  - "src/duck/kept.ts"
  - "src/duck/plan.ts"
  - "src/duck/rewrite.ts"
  - "src/duck/stream.ts"
  - "src/duck/sync.ts"
  - "tests/duck-json-columns.test.ts"
  - "tests/integration/duck-json-paths.itest.ts"
  - "src/duck/jsonb-order.ts"
  - "src/duck/functions.ts"
  - "tests/duck-jsonb-order.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## Stored JSON paths (src/duck/kept.ts, src/duck/kept-route.ts; docs/DESIGN.md "Stored JSON paths")

- **Every write of a copy computes its stored columns, in the write itself**: the poll's `writeStaged` (whole stage or
  piece, the writer's lane or a catch-up's), the stream's `writeByKey` and `updateCarried` (a stored column of a JSON
  column the update carries), the copy's side table before its swap (`fillSide`), and the backfill. A new write path
  into a copied table names its columns and adds `kept.stored(...)` / `kept.storedSet(...)`, or its rows hold the
  unset mark, the column's NULL (refilled by the detector, which logs it as a Mason bug; until then the path's reads
  are the CASE below, never the column alone).
  `tests/duck-json-columns.test.ts` breaks each path and must fail; `tests/integration/duck-json-paths.itest.ts` holds
  every stored read to Postgres's after a copy, polls, stream batches and a copy made again.
- **A column is added only on the writer's turn and never while its table is rebuilt** (a catch-up poll writes it from
  the rebuilds' connection), so every write knows its table's stored columns — **and with NO DEFAULT** (`keep`): DuckDB
  writes a non-NULL default into every row inside the ALTER and its COMMIT (the test server's 196.5 M-row table held
  the writer 28 s, the stream stalled ~3.5 min beside a whole-table read; a laptop's 30 M rows: 0.7 – 1.0 s against
  0.1 s, and nothing written at the commit), so the column's NULL is the unset mark and a NULL answer is `KEPT_NULL`
  (a NUL). Never give it a default. **Even with no default the add is a known cost Mason cannot shorten**: DuckDB 2.0
  reads no block of the table but builds the new column in memory for every row (~4.5 B a row: 135 MB of
  `IN_MEMORY_TABLE` for a laptop's 30 M rows, the ALTER 100–330 ms, its COMMIT 0–4 ms with nothing in the WAL), and the
  next checkpoint writes it, one 256 KiB block a row group under forced zstd (64 MB, 60–180 ms). The same on its own
  connection with `IF NOT EXISTS`, as `JSON`, or inside keep's transaction. The test server's 196.6 M rows (~885 MB in
  memory, ~420 MB at the checkpoint) held the writer 8–17 s; the laptop's numbers scale to 1–2 s, and the gap is not
  reproduced here. ("Stored JSON paths" 2.)
- **ONE column per path** (`pathKey`, src/duck/kept-route.ts): a `#>` whose elements are all keys (none reads as an
  index: `pathIndex`) is the same keys' `->` read (`canonicalRead`, the one place every read passes through: the
  rewrite, the request log's key, the hidden name, the ledger, `mason status`), and a path's `->` and `->>` share its
  column, which holds the `->` answer (the value's JSON text) — `->>` is derived from it (a string unquoted, a JSON
  null NULL, anything else its text; a string holding an escape by the function on the value's own text), never the
  other way (`->>` cannot tell the string "5" from the number 5). `{arr,0}` is not folded with `-> 'arr' ->> '0'`.
- **READY means every row holds the path's `->` answer or `KEPT_NULL`, and a READY path with no marked row (`marked`
  0, `exact`) is read from its column ALONE** — no CASE naming the document, so DuckDB never reads it (the test server:
  41.6 s for a whole-table read through the old CASE, 8.5 s for a small column's scan). After READY a row is unset
  only through a write path that does not compute it, and `KEPT_RECOMPUTE` only for a document Postgres accepted that
  the function cannot read — both Mason bugs; the DETECTOR (`check`, every `CHECK_EVERY` reviews, and every swap)
  counts both, fills the unset, and a marked row turns the path's reads to `CASE WHEN col IS NULL OR col =
  KEPT_RECOMPUTE THEN <the call> ELSE <from the column> END` (the generation moves) until none is left. Never read a
  column alone while `marked` > 0.
- **A fill is weighed against the reads that ask for it** (`decide`; the test server: one 3.5 s read of a 7-day
  window started a 1 h 34 min, disk-bound fill of 196.5 M rows): its cost is ESTIMATED (`estimate`) from the rate the
  last fill of the same JSON column measured (`filled` on its ledger row: the rows its chunks filled and the seconds
  they held the writer; one of at least `MEASURED_MIN_ROWS` rows over a table at most `MEASURED_SPAN` times as big),
  else MODELLED from the column's bytes ON DISK a row (`pragma_storage_info`'s blocks over its rows, `fillEstimate`,
  13 µs + bytes / 120 a row), never from its text's length alone, which priced the server's fill 5.6× low; a column
  not on disk yet is priced by its text. Under `SMALL_FILL_SECONDS` (60) a path is stored after 3 statements or one of
  1 s, else only after 3 statements whose reads took a tenth of the estimate in all within the request log's window. A
  path the cost holds back is a `waiting` row with the estimate and what would store it; every estimate says which it
  is (`basis`: measured, disk, text), and `mason status` says it. Never a fill without its estimate on the row.
- **A review never waits for a fill** (`fills`): it runs on its cadence whatever a fill is doing, re-reads the request
  log, rewrites each waiting row's evidence and estimate, and decides; a path decided while one fills has its column
  added (between the fill's chunks, on the writer's turn) and is `queued` behind it — one fill at a time, the first
  added first, so the writer never holds two fills' chunks and each chunk stays one short transaction. (The test
  server: one review filling for an hour left the waiting rows an hour stale, and a path that qualified was stored only
  at the next start.)
- **A hidden column is never listed**: a statement that lists a table's columns without naming them (`*` over a table,
  `t.*`, a NATURAL JOIN, a whole row) reads the copy's view of its visible columns (`__mason_visible`, `hideKept`), and
  every copy served has that view. PGlite's catalog never has the column (`schemaBuilt` reads the copy's recorded
  columns), and nothing else may `SELECT *` a copy into an answer.
- **A jsonb's order is stored as a read like a path's** (`ORDER_STEPS`, src/duck/kept-route.ts; the PR's measurement:
  `ORDER BY j LIMIT 100` over 20 M rows, 19 s by the key's function under C and 83 s under libc, 0.14 s from the
  stored key): the rewrite records `ORDER BY` / `GROUP BY` / `=` of a copied jsonb column as a read (`keptKey`), the
  policy weighs it as any path, and the column (BLOB) holds the key by the functions the statement's key calls
  (`JSONB_KEY_FUNCTIONS`, their `_stored` twins answering NULL where the key raises: the row is marked, its read
  raises). **A key is its bytes' inputs'**: stored as `ORDER_STEPS:<id>` (`orderId`: the collation, a libc order's
  content hashed, `KEY_VERSION` and `DUCKDB_VERSION` — bump `KEY_VERSION` with any change of the key's bytes); until
  the listener tells the collation (`orderBy`) a write leaves it unset and no plan reads it, then the unset rows are
  swept, a chunk a writer's turn, and it is ready; another id's is dropped. **A mark is never read as a value**: a
  stream or a poll may write a marked row after the count (a libc string the order does not cover), so the exact read
  raises at a mark by the column alone (`markedError`: the gap for a libc key, else a Mason bug) until the detector
  counts it and turns the reads to the CASE. A statement that lists the columns (`*`) reads none, so
  its sort computes the key per row. `tests/duck-json-columns.test.ts` holds the key to the function under C, ICU and
  libc and every write path to it; `IT_ORACLE_JSON_PATHS=eager` reads every jsonb sort from it; `tests/duck-plans.test.ts`
  holds the plans, computed and stored (no row handed a function from the stored key). **A stored key saves the calls,
  not the scan**: DuckDB 2.0 pushes no top N's filter into the stored key's scan through the mark's CASE (the fixture
  holds it), nor into the bare BLOB column's (measured once, DuckDB 2.0, 2026-10-29; no test holds it), so a page by a
  jsonb still reads every row's key (cheap) — never count on its pruning. ("The plan fixture")
- **Under a libc collation a jsonb's equality is a SECOND stored key, the C key** (`EQUAL_STEPS`, src/duck/kept-route.ts;
  `equalId`, src/duck/kept.ts: `equal:` and the C order's id, so `KEY_VERSION` and `DUCKDB_VERSION`, never the libc
  order, which the C key does not read): GROUP BY / DISTINCT / count(DISTINCT) / PARTITION BY / = / IN / a join on `=`
  record it as a read (`equalKey` → `keptKey(e, EQUAL_STEPS)`), weighed, filled, swept, marked, dropped and read exactly
  as the order's key, by every write path (`valueSql`). It never marks a libc-uncovered string (the C key covers every
  string), so a mark of it is a Mason bug (XX000), never the gap. **Under C and ICU no second column is ever made**: the
  order's key equates there, so the keeper folds an equality read into the order's (`own`) and drops a C key at
  `orderBy`. `mason status` names each: `GROUP BY j (its jsonb equality …)` beside `ORDER BY j (its jsonb order …)`.
  `tests/duck-json-columns.test.ts` holds both kinds through every write path, every equality form to PGlite, and the
  lifecycle; the eager oracle under libc reads `public.jorder`'s equality from it.
- **A stored read of a kind this Mason does not know is inert, never fatal** (`knownSteps`, src/duck/kept-route.ts): a
  request log's read of it is not counted (`readOfKey`), its ledger row is dropped at the start with its column and
  said with its steps (`open`), and `pathText` says it raw. A new kind of stored read is added there (the release before
  `equal:` broke its status and every write of the table on one). `tests/duck-json-columns.test.ts` holds it with a
  made-up kind `future:x`. ("jsonb's order", "Rolling back past it")
