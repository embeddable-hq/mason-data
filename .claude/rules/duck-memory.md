---
paths:
  - "src/duck/store.ts"
  - "src/duck/sync.ts"
  - "src/cli/dev.ts"
  - "tests/duck-copy-disk.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## Memory and the machine (so Claude is aware of it)

- **DuckDB's memory limit is HALF the memory by default, or what leaves `OUTSIDE_RESERVE_BYTES` (2.5 GiB) beside it
  when that is less** (`defaultMemoryLimit`, `DEFAULT_MEMORY_LIMIT`, `src/duck/store.ts`; `MASON_DUCKDB_MEMORY` overrides
  it, `8GB` / `512MiB`), and it shares ONE process with V8's heap, two PGlites and DuckDB's own memory its limit does
  not count — DuckDB's own 80 % let the system kill the sync and every session together, and so did half of every
  container up to 3 GiB (issue 301: up to 2.3 GiB measured outside the limit). On a dedicated box half is
  conservative; on a laptop a large copy and a BI query starve each other. What cannot spill fails ITS statement with
  53200 and a hint naming the variable; the run goes on.
- **Under `MEMORY_FLOOR_BYTES` (3 GiB) a start goes on and WARNS while `MASON_DUCKDB_MEMORY` is unset, never refuses**
  (Tom, PR 382): the default is then what leaves the reserve, never under `MIN_SHARE_BYTES` (128 MiB), the most room
  for the rest (128 MiB up to 2.625 GiB, the size less 2.5 GiB from there to the floor), and the warning is
  `memoryWarning`, the one function, said in three places (the run's log, `mason status` and `--json` `warnings` while
  it runs, mason doctor's memory line as a warning, never a failure). Only a value that is not an amount is refused
  (`memoryProblems`). Set, the variable is the operator's word at any size, and doctor says the room it leaves. The three constants are a
  measurement (docs/DESIGN.md "Memory: the room outside the engine's limit"): a change that adds memory outside the
  engine's limit (a worker, a WebAssembly instance, a cache) measures them again, never guesses.
- **What statements spill has a ceiling under the free disk, and it follows the disk** (`spillCeiling`, `keepSpillCeiling`,
  `src/duck/store.ts`, issue 105): half of what is free plus what is spilled (the free bytes exclude the spill: half of the
  free bytes on top of it converges on the whole disk), or `MASON_SPILL_LIMIT`, never past 90% of that; re-read every 15 s.
  It is in force from the open by a `SET GLOBAL`, never a setting given at the instance's creation, which DuckDB 2.0 shows
  and does not enforce (issue 850: 47.0 MiB shown, 300 MB spilled); the open reads back every setting it gives and
  refuses, naming it, one that is not what it gave (`instanceSettingsProblem`). DuckDB's own is 90% of what was free at its first spill, read once (measured on a
  small volume: a disk that fills after that ends in its IO error). Past it (53400, as past Postgres's temp_file_limit) or on a full disk (53100) the statement fails alone:
  no path and no engine in the answer, gap `spill-limit` on its request-log row. A sizing decision reads
  `store.spillLimitBytes`. ("A top N over joined tables")
- **A sizing decision reads `store.memoryLimitBytes`**, never `os.totalmem()` or a constant: the operator may have set
  the limit. The copy reads it: a chunk's values out of line are held to an eighth of it over the readers
  (`chunkCeiling`, `COPY_CHUNK_MEMORY_SHARE`; docs/DESIGN.md "Large values out of line").
- **A copy shares that limit with the stream, the polls and the BI queries** (it runs beside them):
  what does not fit beside fails its own statement, is said, and is tried again.
- **What a copy costs the queries beside it is PAGE-CACHE EVICTION, not CPU** (measured on the test server: buffered
  writes evicting the cache took a 1 s weekly chart to 8 s and a 0.3 s count to 9.9 s, where a CPU-only load cost +85 %
  and O_DIRECT writes nothing): the copy writes into the very file the queries read. So bound what a copy has in flight
  (its chunks) before reaching for CPU priority (which recovered only about half of the smaller cost); measure a change
  to the copy's write pattern on the test server, whose page cache is smaller than its table, never on a laptop whose is not.
- **A query over a WIDE column is bound by the disk when the working set does not fit RAM, and JSON extraction over a
  text column is slow.** On the test server (m7g.xlarge: 4 cores, 15 GiB, EBS at 125 MB/s) a 28 GB table cannot be cached, so
  anything touching its two JSON payload columns reads at disk speed: a count of rows whose payload has a given key
  (`payload->>'key' IS NOT NULL`) over 22 M rows took 93.5 s on DuckDB against 15 s on ClickHouse. So size a machine's
  RAM to the working set, never promise ClickHouse's speed on a JSON path, and the later remedy is extracting the hot
  JSON fields into columns. ("What stands between this and production")
- **Strings are stored ZSTD, forced on the instance** (`INSTANCE_SETTINGS`, `src/duck/store.ts`): DuckDB's
  analyzer never picks ZSTD by itself and left a copied table's JSON text column Uncompressed — 0.66 GB a million rows
  on the test server, 0.26 forced, a text sample 4.5× smaller — while integers, UUIDs and timestamps keep their own
  methods. A copy's size is measured with it on; the read cost of a ZSTD column is not measured yet.
- **A copy that would fill the disk is stopped before it does** (`copyDiskProjection`, `src/duck/sync.ts`): once an
  attempt read 1 % of the heap, what the pages left would add (from what its pages added to the file and its log) is
  held to what is free where the file is; past it the copy FAILS with the way out (free disk, `mason remove`, `mason add
  --columns`), its chunks kept, and is tried again as a failed copy is — at the retry, or at once at the next start.
  Nothing warns before 1 %; a table whose late pages are wider than its early ones is under-projected. What the check
  last projected is kept on the copy's live state and said, never computed a second way (`diskStatus`: `/api/state`
  `disk`, `mason status`'s Disk line, beside the bytes free by the same `diskFree`).

## What review probes

Run each probe that applies: the implementer before each push, and the fresh reviewer at each review (CLAUDE.md
"How work is done here", steps 3 and 4). A new probe is proposed to the owner; each bullet names the PR or issue it was met in.

- Many heavy statements at once (64 with the pool) under one `MASON_DUCKDB_MEMORY`: out-of-memory failures or spills
  where a queue used to make them wait (PR 148).
