---
paths:
  - "src/duck/store.ts"
  - "src/duck/sync.ts"
  - "src/cli/dev.ts"
  - "tests/duck-copy-disk.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## Memory and the machine (so Claude is aware of it)

- **DuckDB's memory limit is HALF the machine's RAM by default** (`DEFAULT_MEMORY_LIMIT`, `src/duck/store.ts`;
  `MASON_DUCKDB_MEMORY` overrides it, `8GB` / `512MiB`), and it shares ONE process with V8's heap and two PGlites —
  DuckDB's own 80 % let the system kill the sync and every session together. On a dedicated box half is
  conservative; on a laptop a large copy and a BI query starve each other. What cannot spill fails ITS statement with
  53200 and a hint naming the variable; the run goes on.
- **What statements spill has a ceiling under the free disk, and it follows the disk** (`spillCeiling`, `keepSpillCeiling`,
  `src/duck/store.ts`, issue 105): half of what is free plus what is spilled (the free bytes exclude the spill: half of the
  free bytes on top of it converges on the whole disk), or `MASON_SPILL_LIMIT`, never past 90% of that; re-read every 15 s. DuckDB's own is 90% of what was free at its first spill, read once (measured on a
  small volume: a disk that fills after that ends in its IO error). Past it (53400, as past Postgres's temp_file_limit) or on a full disk (53100) the statement fails alone:
  no path and no engine in the answer, gap `spill-limit` on its request-log row. A sizing decision reads
  `store.spillLimitBytes`. ("A top N over joined tables")
- **A sizing decision reads `store.memoryLimitBytes`**, never `os.totalmem()` or a constant: the operator may have set
  the limit. (The copy needs none since it has no sort, "The copy"; its chunks are sized in pages, by time.)
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

Run each probe that applies before a push; the harness's Learn step adds to this list.

- Many heavy statements at once (64 with the pool) under one `MASON_DUCKDB_MEMORY`: out-of-memory failures or spills where a queue used to make them wait (PR 148).
