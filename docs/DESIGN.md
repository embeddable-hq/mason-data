# How Mason works, and why

Mason copies the tables a project names out of a Postgres, keeps the copy current, and serves it over the Postgres wire
protocol. **Postgres decides, DuckDB computes**: a real Postgres analyses every statement, DuckDB computes it over the
copy, and what cannot be answered exactly as Postgres would is refused by name. The [README](../README.md) has the rest.

This is the decision record, by subsystem in the order of the code: each decision, why, and the number that decided it;
the operative rules are `.claude/rules/`. "The test server" is an m7g.xlarge (4 cores, 15 GiB, EBS at ~125 MB/s) reading
an RDS read replica; "a laptop" an Apple M5 (10 cores, 32 GiB) under other sessions' load: ranges of runs, not benchmarks.

## The copy

### Heap order, no index

**Decision.** Every copy holds its rows in the order the source's scan delivers them, with no PRIMARY KEY, UNIQUE or
index (`duckdb_constraints()` is empty for every copied table). Uniqueness is the write path's — a key is written by
deleting it first — and the oracle holds every copy to the source.

**Why.** The copy was first kept in primary-key order under its key (`ORDER BY id LIMIT 1000` on 1 M wide uuid-keyed
rows: 140 → 6 ms). On the test server's 195,895,087-row table (a uuid key, 17 columns, two wide JSON columns; DuckDB at
2.7 GiB) that cost:

| what | in key order |
|---|---|
| time-window queries (a random uuid puts each day in every row group: no zonemap prunes) | per day over 30 days 20 s; errors by code 30 s; p95 by origin over 7 days 45 s; a join over 7 days 58 s; `payload::jsonb ? 'key'` over ONE day 255 s |
| the copy (staged, partitioned into parquet, sorted per key range) | 56 minutes (25 partitioning, 27 sorting); three times the table on disk at its peak |
| one `INSERT … SELECT … ORDER BY key` | failed at 16 GiB (`failed to pin block`, [duckdb/duckdb#26712](https://github.com/duckdb/duckdb/issues/26712)) |
| the index | ~21 GB of the 53 GB file; RESIDENT for any write of random keys (~45 B a key: ~8.8 GB, past 2.7 GiB): the first poll after the copy ran out of memory at 13 minutes, and at 64 MB a DELETE that did not fit was FATAL, invalidating the database until a restart |
| low-cardinality uuid columns | uncompressed, 3.1 GB each (no runs in key order) |

The index served point lookups (73 ms) and nothing analytical. An index-less insert writes its row groups as they fill,
so its transaction does not grow with the table (DuckDB 2.0.0, `duckdb_memory()` sampled every 50 ms):

| table | memory limit | copy | DuckDB's peak | file |
|---|---|---|---|---|
| 400,000 wide rows (uuid key, two jsonb; 407 MB in Postgres) | 64 MB | 2.3 s | 64 MiB | 181 MiB |
| 5,000,000 rows of the test server's shape (5.1 GB in Postgres) | 256 MB | 82 s | 244 MiB | 1.9 GiB |
| the same | 2 GB | 42 s | 1.9 GiB (the buffer pool) | 1.9 GiB |

Over those 5 M rows inserted in time order a day's window reads 1 of 41 row groups; on a heap updated for years heap
order is only roughly time order, so pruning by time is good, not exact.

**Writes by key**: a poll piece or stream batch deletes its keys by ONE join against the key column, then inserts; an
unchanged-TOAST update is ONE `UPDATE … FROM` per set of carried columns. Each scans the key column: 10,000 changes into
1 M uuid rows 4 ms, 10 M 20 ms, 195 M 0.35–0.86 s to delete and 1.5–1.8 s to update (laptop NVMe); on the test server
the 3 GB key column is read from EBS, tens of seconds. So a stream batch touching a table over `POLL_ROW_LIMIT` is
applied at most every 5 s in pieces of up to 50,000 (`BIG_APPLY_MS`, `BIG_PIECE_CHANGES`): a 12 M-row migration is 240
scans, not 1,200, and the batch's other tables wait seconds with it. A bigserial key prunes (its zonemaps are in order).

**Given up**: a wide uuid-keyed table's `ORDER BY id LIMIT 1000` is seconds (7.9 s on 2.8 M rows); a point lookup by a
random uuid is a scan (the benchmark: Postgres 41× faster). The later remedy is a sort by a declared time column. A copy
in the old key-ordered layout (`RETIRED_LAYOUT`) serves until it is copied again, never converted in place. **Where.**
`src/duck/sync.ts` (`copy`, `writeByKey`), `src/duck/stream.ts`; `tests/integration/duck-poll.itest.ts`.

### The copy in chunks, smallest first

**Decision.** Copies are queued and taken smallest first by the catalog's row estimate (unknown last, ties by bytes then
name). A copy fills `<table>__mason_copy` a range of heap pages at a time — a passthrough read of `ctid >= '(p,0)' AND
ctid < '(q,0)'` (a TID range scan, never an `ORDER BY` on the source; the last chunk open-ended) — each chunk committed in
its own transaction with its own row in `_mason.copy_chunks`. A copy that dies continues with exactly the ranges no chunk
committed, when its columns are the same.

**Why.** On the test server a 196 M-row, 28 GB table copied in 1,392 s while three small tables (776, 15 k and 22 M rows)
waited all 23 minutes, and a copy that failed at 90 % started from zero, re-reading the replica (~738 GB over a day).

**Held to the first snapshot.** Each chunk is a new Postgres snapshot, so unheld a row updated between chunks is read twice
or missed. Every chunk keeps only rows written before the FIRST snapshot's xmin (`xminBeforeSql`, `src/cdc/poll.ts`); the
catch-up poll from that watermark reads exactly the complement (`tests/cdc-poll.test.ts`: "never neither" over every
32-bit xmin, wraparound and frozen included). A range on the id, never `pg_visible_in_snapshot` (a savepoint's
subtransaction id is not in the snapshot). Written with `age()`: over 3 M rows a `count(*)` took 320 ms plain, 437 ms
with the `age(xmin)` test, 1,642 ms with `xmin::text::bigint` — five times the scan's CPU, on the source database. A
rewrite of the source table (found by `pg_relation_filenode` after each chunk, under its read's lock) or a billion
transactions starts the copy over, said; the swap asserts as many distinct keys as rows. Without the hold the resume
test reads 250 keys twice; without the file check the copy silently differs.

**What a chunk costs** (laptop, disposable Postgres 18, 3,000,000 rows, 707 MB, 75,000 pages):

| | one statement (the attached scan) | 2 chunks of 50,000 pages |
|---|---|---|
| copy at 256 MB / at 2 GB | 2.5 – 4.4 s / 1.5 – 3.1 s | 2.7 – 5.5 s / 3.7 – 4.0 s (+ ~1 s catch-up) |
| DuckDB's peak at 256 MB / at 2 GB | 244 MiB / 466 – 555 MiB | 244 MiB / 299 – 301 MiB |
| the process's CPU | 94 – 141 % | 47 – 88 % (one core) |
| a `count(DISTINCT …)` over 5 M rows in the file (~85 ms alone), beside it | 331 – 533 ms | 97 – 106 ms |

15 chunks read in 2.39 – 2.52 s against 2.03 – 2.08 s in 2: ~30 ms a chunk for its commit, snapshot and file check.
**Where.** `src/duck/sync.ts` (`copyOrder`, `chunksToRead`, `StartOver`); `tests/integration/duck-poll.itest.ts`.

### Chunks read N at a time

**Decision.** A copy reads `MASON_COPY_PARALLEL` chunks at once (1 to 8, default 3), each on its own DuckDB connection and
so ONE Postgres backend, all appending to the one side table. The chunk ceiling (~2 M rows by the estimate,
`COPY_CHUNK_ROWS`, at most 1 GiB of pages) does not grow with N.

**Why.** On the test server a 22 M-row table (two wide text/json columns) took 72 s in 11 chunks of ~6.1 s where the
attached scan took 28 s: in one chunk the `age(xmin)` hold was ~1 %, the TID Range Scan 641 ms, and ~5.5 s one backend
detoasting, formatting and sending at ~150 MB/s. A chunk is ONE backend's throughput; the attached scan was faster only
by reading with ~10 backends — the load the chunks exist to remove. Laptop, 4,000,000 rows (~1.1 kB of json and text a
row, 5.2 GB, 12 chunks), DuckDB at 2 GB, beside it a 2 M-row aggregate on the SOURCE and a 5 M-row `count(DISTINCT …)`
in DuckDB:

| | copy | source backends | source query: alone → beside | DuckDB query: alone → beside |
|---|---|---|---|---|
| the attached scan | 28.7 – 40.6 s | 10 | | |
| N = 1 | 98.2 – 137.1 s | 1 | 415 → 300 – 458 ms | 73 – 134 → 147 – 204 ms |
| N = 2 | 50.2 – 59.3 s | 2 | 118 – 160 → 295 – 325 ms | 79 – 106 → 135 – 143 ms |
| **N = 3** | **31.5 – 39.7 s** | **3** | 127 – 132 → 258 – 298 ms | 70 – 78 → 117 – 118 ms |
| N = 4 | 18.5 – 30.6 s | 4 | 82 – 129 → 196 – 227 ms | 49 – 98 → 108 – 125 ms |

At N=3 the copy takes the attached scan's time on three backends instead of ten (the test server's 72 s should be ~25–30
s, not measured there); a source query beside it takes ~2× its time at N=2 to 4, hence 3, not 8 (never past 8: the
extension's pool is 15 connections). Memory sets no bound: the peak was the limit at every N, and at 512 MB N=4 read the
table in 22.8 s at 490 MiB (N=1: 130 s, 491 MiB). Chunks commit out of order but stay whole, so heap order breaks at
most at a chunk's edge (0 places at N=1, 1–4 at N=2 to 4). **The ceiling stays ~2 M rows whatever N**: a copy takes
about ⌈chunks ÷ N⌉ chunk-times, so 11 chunks at N=3 are 4 rounds against 3.7 (9 % idle) where 5 M-row chunks would be 2
against 1.7 (20 %), and re-read N times more at a stop. **Where.** `src/duck/sync.ts` (`COPY_PARALLEL`, `readChunks`);
`tests/duck-copy-order.test.ts`, `duck-poll.itest.ts`.

### Chunks sized by time, and progress between commits

**Decision.** A copy's first chunks (one per reader) are a tenth of the ceiling, at least 128 pages; every later one is
what a reader reads in `MASON_COPY_CHUNK_SECONDS` (12 s, 1 to 300) at a moving average of the committed chunks' rate,
the newest weighing 0.7 when slower and 0.3 when faster (`nextChunkPages`, `nextRate`). `mason wait` / `mason status`
render the chunks in flight between commits at that rate, held under 90 % of their rows (`READING_SHARE_CAP`), and the
share is of the heap's PAGES, never the rows.

**Why.** A laptop copying a 20,126,276-row, 5.4 GB table over the internet: chunks of 43,104 pages took ~180 s each, and
`mason wait` showed `0 of ~20,126,276 rows` for minutes, then jumped 27 % (the same chunk was ~6 s on the test server).
Replayed, that copy is ~150 chunks of ~12 s. With 0.3 both ways, a reader slowed from ~3,500 to ~480 pages a second took
four or five chunks of 1.3 – 2.7 s against a 0.5 s target to adapt. The estimate covered 23,719,703 rows, and a share of
rows sent the bar back to 0 % past it. **Where.** `src/duck/sync.ts` (`takeChunk`, `CopyLive`), `src/cli/commands.ts`;
`tests/duck-copy-order.test.ts`.

### A copy beside the stream

**Decision.** A rebuild runs on a DuckDB connection of its own, one at a time, writing only its table, side table and
ledger rows; everything else that writes (stream batches, polls, attach/detach, every swap) takes a turn on the writer
(`onWriter`). A rebuilt table is caught up by ONE poll from its copy's snapshot; in replication mode the stream holds
its changes from just before that poll and applies them after.

**Why.** On the test server one 195 M-row copy stopped every other table's freshness for ~35 minutes and held the slot's
WAL throughout. Two connections' writes of different keys both commit (the same key: "Conflict on update!"), but a DROP
under another transaction's write fails its commit, hence swaps on the writer's turn. **Where.** `src/duck/sync.ts`,
`src/duck/stream.ts` ("why replaying is safe"); `tests/integration/duck-stream.itest.ts`.

### Smaller decisions of the copy

- **Wide numerics are copied exactly** (`NUMERIC_TYPE`): the extension reads an unconstrained `numeric` (Rails) and a
  `numeric(p > 38)` (Prisma's numeric(65,30)) as DOUBLE, 15 digits; Mason reads their text into DECIMAL(38, s), s the
  most decimals the values use (at scale 30 a sum past 10⁸ would overflow 38 digits). A wider later value re-copies the
  table (at most three times a run); past 38 digits or a NaN stays a double, said.
- **A failed copy backs off** (`copyRetryDelayMs`: four times the attempt, at least 5 minutes, doubled per failure, at
  most 6 hours; at once after a restart or a column change) and keeps its committed chunks.
- **`mason stop` interrupts a copy**, re-sent every 50 ms (DuckDB loses an interrupt that arrives before its statement
  starts); the table is `waiting`, never failed.
- **The catalog serves a table the moment its copy commits**, on a connection no copy holds (after a restart it had been
  empty for hours behind a large copy).
- **An enum array is read as `text[]`**: a passthrough read hands it over as one VARCHAR DuckDB cannot cast.
- **ZSTD strings, the disk projection**: `.claude/rules/duckdb.md` "Memory and the machine" (JSON text 0.66 → 0.26 GB/M rows).

## Keeping a copy current

### The poll

**Decision.** Each table is polled by ONE DuckDB transaction over ONE source snapshot: rows whose `xmin` is at or past the
watermark are written by key, an anti-join deletes what the source lacks only when the counts differ, and the watermark
commits WITH the rows. Over `POLL_PIECE_ROWS` (50,000) changed rows the deletes go first and the rows 50,000 to a commit,
the watermark moving with the last. The interval stretches to four times the last poll (`nextPollDelayMs`). Only tables
of at most 1,000,000 rows by the estimate are polled (`POLL_ROW_LIMIT`); a bigger one serves as of its copy, said on its
line, and `mason sync <table>` polls it now.

**Why.** At 64 MB on 1 M uuid keys (while copies had a key) one upsert of 600,000 changed rows ran out of memory; in
pieces of 50,000 all 1 M went in, in 1.5 s; 8,000 deletes after 720,000 upserts ran out where before them they did not.
A poll is a full scan of every polled table (no index covers `xmin`): 13–17 s per poll for 13 GiB ("Measurements"), so a
5 s interval stretches to about a minute; a stretch once capped at 60 s capped an hourly interval too (a 10 GB table
polled every 74 s for seven hours). On the test server one 22 M-row table cost the replica 12 s of scan and 2 s of count
per poll. **Where.** `src/duck/sync.ts`, `src/cdc/poll.ts`; `tests/integration/duck-poll.itest.ts`.

### Logical replication

**Decision.** `mason start --replication` keeps the copies current from the change log (`src/duck/stream.ts`); the rules
are `.claude/rules/duckdb.md` "Keeping a copy current". Why each is so:

| decision | why, with the number |
|---|---|
| a NAMED publication is read and verified (`checkPublication`), never created, altered or dropped | a read replica takes no CREATE PUBLICATION; on a production primary the slot is the one object Mason creates |
| a table the publication lacks (or narrows, or filters) is refused alone; insert, update and delete must be published | a filtered row's delete never arrives; one table's gap must not stop the rest |
| on a standby: a named publication, and Postgres 16+ | a standby decodes only from 16 |
| `REPLICA IDENTITY NOTHING` and a `key:` table are refused | publishing their updates fails the app's own UPDATEs |
| a table joins once caught up by ONE poll; a new slot catches the copies up by one poll from their watermarks | a key's changes replayed in commit order end at its state, so nothing is copied again |
| a batch (500 ms or 10 k changes) commits with its position before it is acknowledged; idle, the server's position is acknowledged | a run that dies skips what it applied; an idle slot holds no WAL |
| a large transaction is applied in committed pieces of `PIECE_CHANGES` (10,000) | 607,000 changes in one transaction ran a sync out of a 96 MB heap folded whole; in pieces it ran in 48 MB |
| a change is written as the COPY's columns (`Sync.asCopied`, `projectTuple`) | a column removed from a 22 M-row table's entry and restored during its re-copy: held changes named a column the copy lacked (`Binder Error`) and the table stopped |
| a table needing a copy or catch-up gets a pass at once or at its back-off's end (`followUp`, `wakeAt`) | a pass runs only when kicked: 7+ minutes with no copy on the test server |
| each join and leave is a log line with its position; `mason status` shows position, lag and counts | the first run printed one stream line in 35 minutes; commit → applied then measured 0.2–5.5 s |
| the database's position: a connection at most every 5 s, never the keepalive | a walsender's keepalive carries its READ position, wrong while it decodes a backlog |
| any failure but the source going away restarts the stream, back-off doubled, at most 5 minutes | each start decodes the slot's WAL again on the source |

**Where.** `src/duck/stream.ts`, `src/duck/publication.ts`; `tests/integration/duck-stream.itest.ts`.

## The statement path

### How a statement is answered: Postgres decides, DuckDB computes

**Decision.** A SELECT reading any relation outside `pg_catalog` / `information_schema` is DuckDB's (`duckTranslate`);
one reading only the catalog or no table is PGlite's own answer. DuckDB's goes through four steps (`src/duck/plan.ts`):

1. **Postgres analyses it**: the catalog Postgres (PGlite, the copied tables' definitions, no rows) parses it with
   `debug_print_parse`, typing every expression, and gives the result's names, OIDs and typmods. What it refuses is
   refused with its error.
2. **The tree is rewritten** (`src/duck/rewrite.ts`) wherever DuckDB's meaning differs: collation and case, LIKE and
   regex, json, `to_char`, date/time arithmetic, casts to text, `WITH TIES`, a column the GROUP BY's key decides
   (`any_value`), a date literal as the value Postgres parsed. **The clock is Postgres's**: `'now'` is the transaction's
   start as of the Parse, `now()` as of the execution, both hidden parameters (`DuckPlan.clock`), so a kept plan keeps
   no time and DuckDB's own clock is never read. Integer division is `SET integer_division = true`. Then every resolved
   piece must be in the allowlist.
3. **The tree is deparsed and read back**, node for node (`treeDifference`): what the deparser cannot spell is refused.
4. **DuckDB runs it**, each value written with step 1's OID and typmod; a numeric Postgres computes exactly is computed
   by `src/lib/pg-numeric.ts` from cells DuckDB selects beside it (`1 / 3.0` is `0.33333333333333333333`).

What SQL cannot fix is a JavaScript function (`src/duck/functions.ts`); what only Postgres can say (a text read as a
date or a number, jsonpath, a regex RE2 reads otherwise) is asked of a PGlite on a worker thread, a 2,048-row chunk's
distinct values at a time (`src/duck/pg-eval.ts`). **No DuckDB macro**: with the `postgres` extension loaded, a macro
with a lambda called with constants, or calling a macro, fails (DuckDB 2.0).

**Why.** The SQL as written: 745 of 2,838 oracle answers differed; analysed and rewritten: 6, one decided class.
DuckDB's types (`count_star()`, HUGEINT for `sum(int)`, DOUBLE for `avg(numeric)`) never reach a tool. A Postgres call:
~8 ms a chunk, 0.6 s for 200,000 distinct values, ~2 s once to start; a relative time read from a row is refused (the
worker's clock is not the transaction's). **Where.** `src/duck/plan.ts`, `rewrite.ts`, `types.ts`;
`tests/integration/duck-oracle.itest.ts`.

### What is not supported, and how the list stays true

**Decision.** An allowlist, not a blocklist: DuckDB answers only a statement whose every function, operator, aggregate,
cast, type and construct (by resolved OID, `src/duck/resolved.ts`) is in `src/duck/verified.ts` — what the oracle answered
EXACTLY in all three phases, regenerated by `UPDATE_VERIFIED=1`; anything else is 0A000 naming the piece. Every refusal
names its registry entry (`Unrewritable` takes a `GapId`), and the oracle fails on an entry none of its statements meets.
[`docs/SQL-SUPPORT.md`](SQL-SUPPORT.md) is rendered from both.

**Why.** Every corpus run met SQL no oracle statement had used: the allowlist refused it by name (a rerun: 44 pieces
refused, none answered wrongly). Where the allowlist was blind, the answers were wrong (next entry). **Where.**
`src/duck/gaps.ts`; `tests/duck-gaps.test.ts`, `tests/integration/oracle/gap-cases.ts`.

### What the oracle's closed world missed

**Decision.** A finding from outside the oracle becomes an oracle statement and a class of input in the type matrix,
its fix shown to fail without it (`scripts/fails-without.ts`); every statement is asked again in six shapes (a
subquery, a CTE, a UNION ALL, `$n` parameters, implicit names, its ORDER BY outside: `oracle/shapes.ts`).

**Why.** A corpus of 5,749 statements recorded from real BI use (173 schemas, synthetic rows) answered 87.4 % (79.4 % exactly) and **four
silently wrong**: a `citext` compared case-sensitively (copied as `text`, so the allowlist saw `texteq`); an `inet` as its
`::text`; `SELECT s.* FROM (…) s ORDER BY s.x` by bytes (172 statements; wrapped statements were compared as sets);
`round(x::float8)::numeric::text` keeping `.0`. The shape multiplier's first run found 271 differences of 16,908. Reruns
found inputs no synthetic set wrote: names alike but for case; zone abbreviations (DuckDB read `CST` as Chicago's, `IST`
as India's, `UTC+3` east — all silently; now refused); `0.3 / 0.1` and `2.1 / 0.7` as two values (now Postgres's
quotient, `__mason_numeric_div`); a correlated `generate_series` of times answering no rows once one series was empty
(DuckDB 2.0.0's); an aggregate's arguments evaluated before its FILTER (22012 where Postgres answers; now a CASE of the
filter). The latest rerun answered 94.4 % of the corpus, 96.2 % of BIRD, 100 % of TPC-DS; the harness stays outside the
repo.

### The BI tools' findings

**Decision.** The recorded corpus (`tests/duck-corpus.test.ts`: 217 statements psql, pgjdbc, node-postgres, Metabase,
Grafana, DBeaver and Superset sent) is answered whole, and a tool-driven finding is fixed with a test and held by the
oracle. Those that changed a design:

| found | decision |
|---|---|
| text under glibc `en_US.utf8` sorted as ICU (Hangul after Latin, `$` after `@`) | glibc's order MEASURED from the database at the first start (~14 s; 13 s one query sorting 159,865 code points), kept in the copy (`src/duck/libc-order.ts`); an unplaceable character refused (`libc-uncovered`); 2 in 10,000 random strings still differ |
| a foreign key to a UNIQUE index not listed (BIRD's 57 of 87): no join drawn | the catalog creates the source's unique indexes, enums, NOT NULL, defaults and views (`src/duck/views.ts`) |
| `sum(CASE WHEN … THEN a ELSE 0.0 END)` read 5.0 for 5 (Metabase's "sum where") | a sum's scale is the most decimals a value summed has |
| a preview (`ORDER BY id LIMIT 2000`, a computed list) 466 ms over 60 k rows: DuckDB computes the list below its Top N | the list computed outside the sorted, limited subquery (`src/duck/late.ts`): 15 ms (Postgres through its index 2 ms) |
| Postico's `SELECT * … ORDER BY "id" LIMIT 1000` sorted every wide jsonb column of 23 M rows (late fetch stops at 50) | `late_materialization_max_rows` 10,000: 2.3 s → 36 ms |

### The review

**Decision.** DuckDB runs only a `PlannedSql` made in `src/duck/plan.ts` after the read-back; nothing runs a statement's
text (`tests/conventions.test.ts`).

**Why.** An adversarial review, each finding demonstrated against a disposable Postgres. The critical one: `EXPLAIN
ANALYZE <write>` ran on DuckDB as written — it deleted and updated copied rows, created tables, and could read any source
table (and the source password) through the attachment. Others, each fixed with a test that fails without it:

| finding | decision |
|---|---|
| a changed column list failed the one-transaction poll for EVERY table, forever | a copy's columns compared at each pass, a changed table copied again |
| a source unreachable at a pass turned tables `failed` and re-copied them whole | a copied table keeps serving, its error said |
| a numeric parameter was a double (`300` for `300.0000`) | its bound text is a cell of the program |
| a catalog portal closed by another session's Sync (every six-card Metabase dashboard) | a catalog statement's portal runs whole at its Bind |
| one node placed in two arms of a CASE, the second left unqualified | a node is placed once (`nodesPlacedTwice`, held to none) |

### EXPLAIN

**Decision.** Postgres's shape, DuckDB's plan inside. An EXPLAIN is the statement it explains: options read in Postgres's
words, then the statement planned and refused as it would be alone (`EXPLAIN ANALYZE DELETE` is the DELETE's 25006). A
`QUERY PLAN` text column or Postgres's JSON; a first line says which copy answered, what DuckDB was sent and what Mason
computed after. ANALYZE runs the statement as any statement runs, DuckDB's profiler timing each operator. Operators keep
DuckDB's names (`Table Scan`, not `Seq Scan`, which sends a reader looking for an index); time is `thread time=`
(`DuckDB Thread Time` in JSON), never `actual time=`; FORMAT XML / YAML and GENERIC_PLAN are refused (`explain-option`).

**Why.** EXPLAIN was the review's critical finding, so it is built over plans. DuckDB's operator time is THREAD time
summed over threads: a parallel scan's exceeds the Execution Time, which a reader of `actual time` takes for elapsed.
**Where.** `src/api/postgres/explain.ts`, `src/duck/explain.ts`; `tests/duck-explain-options.test.ts`.

### A query cannot take the run down

**Decision.** Results stream (the next chunk read once the socket drained), an Execute's row limit pages, a cancel aborts
between chunks, DuckDB's limit is half the RAM with spilling (53200 fails the statement alone), and a statement's limit is
the shorter of `statement_timeout` and `MASON_STATEMENT_TIMEOUT` (5 min). **Why.** `SELECT *` of a 23.4 M-row table
through Postico ran V8 out of heap — the answer built whole three times before its first row — and every session died.

## The executor worker

**Decision.** DuckDB lives on a worker thread: the instance, every connection and the `__mason_*` functions, registered
from it so every call lands there. The main thread keeps the listener, catalog, plans, the sync's logic and the command
server, and never runs a function call. One instance per file in the process (`DuckStore.open` refuses a second).

**Why.** A JavaScript scalar function runs on the thread that REGISTERED it, one 2,048-row vector a call, ~4.5 µs a row
on the test server: a JSON read over 22 M rows took 98 s, and for 98 s every session, the stream, the copy, `/api/ping`
and a departed client's cancel waited — Node's threadsafe-function loop runs up to a thousand calls before anything else
(a parallel scan of 6 M rows held the main thread's timers 1.3 s at a time). A second instance of a file is NOT refused
in-process (DuckDB's lock is per process): one instance's 1,000 committed, checkpointed rows were gone after the other
checkpointed.

| measured | main thread | worker |
|---|---|---|
| `SELECT *` of 1 M rows (74 MB), four runs | 7.3, 5.5, 5.8, 5.0 s | 6.4, 5.3, 5.7, 5.8 s |
| `SELECT *` of 10 M rows (770 MB) | 63.0, 61.6, 65.2, 51.8 s | 57.8, 53.5, 53.1, 58.8 s |
| a login and `SELECT 1` during a 9 s calling statement | 4.6 s | 2 ms (`/api/ping` 3 ms) |
| a leaving client's statement released | not within 2 s | 20 ms |

**Cancellation**:

| decision | why, with the number |
|---|---|
| a cancel is a cell of a `SharedArrayBuffer` table the listener writes at once (`src/duck/cancel.ts`) | the worker is busy for seconds with calls; a message would wait behind them |
| whether a statement calls a function is its PLAN's (`PlannedSql.functions`), never its text's | `__mason_visible` matched a text test: a self-join ran 82 s past a 300 ms timeout and answered "ok"; after, 57014 at 319 ms |
| a cancel asked is answered 57014, however the statement ends | a scalar subquery's early calls let a cancelled statement finish "ok" |
| a calling statement's unfinished result is cancelled, interrupted, and closed after `CALLS_QUIET_MS` (50 ms) with no call (`SessionRunner.cleanUp`) | under load the suite sat at 0 % CPU for good: the result's close (`Executor::CancelTasks`) waiting for a task waiting for the worker. After: released 21–63 ms after the client left; a 300 ms timeout answered at ~305 ms |
| nothing is closed under a pending call; a statement in flight at a stop gets 57P01 | a stop during a drain aborted the process (exit 134, `Napi::Error`) |
| a worker silent `SILENT_MS` (60 s) is given up on (57P02, the run exits for its supervisor); `close` settles in `CLOSE_GRACE_MS` (5 s) | a thread blocked in native code survives `worker.terminate()` and `process.exit`; one join (`a.id > b.id AND a.id - b.id = -7`, 1 M rows) takes ~10 s to honour an interrupt in DuckDB itself |

**Still true.** A calling statement starves the worker for its run, and every other request to the copy (another
session's statement: 8.2 s beside an 8.7 s calling one); the listener, logins, catalog, commands and cancels do not
wait. The way out is fewer calls ("Stored JSON paths"), not more threads. **Where.** `src/duck/executor.ts`,
`executor-worker.ts`; `tests/duck-executor.test.ts`, `tests/duck-runner-signal.test.ts`.

## Stored JSON paths

JSON reads are DuckDB's own where its answer is Postgres's, a hidden column for a path read again, else `__mason_json_get`.

### A `->>` is DuckDB's own read

**Decision.** A `->>` / `#>>` of a column (a chain folded by `jsonChain`) is `json_extract_string` for a string, NULL for
a missing path or JSON null, and the function — as a CASE's ELSE, evaluated only on those rows — for a number (DuckDB
writes `7.00` as `7.0`), an object, an array, an index step, a document that may hold a key twice, and `->`.

**Why.** 5 M rows, a second session asking `SELECT 1` every 100 ms:

| statement | time | calls | other session's longest wait |
|---|---|---|---|
| `count(DISTINCT payload ->> 'customer_id')` | 0.21 s | 0 | 7 ms |
| the same as `(payload -> 'customer_id')::text` (the function) | 8.80 s | 2,442 | 180 ms |
| `payload ->> 'amount'` (a number: the function) | 6.50 s | 2,442 | 3,592 ms |

**Where.** `src/duck/rewrite.ts` (`jsonGet`); `tests/duck-wire.test.ts` "a ->> of a column is DuckDB's own read".

### What a stored path is

**Decision.** A hidden VARCHAR column of the copy (`__mason_json_` + 12 hex digits of a SHA-256 of table and path)
holding the function's `->` answer per row: the JSON text, `KEPT_NULL` (a NUL), or `KEPT_RECOMPUTE` where it raised. ONE
column per path (`canonicalRead`): `#> '{a,b}'` and `-> 'a' -> 'b'` share it, `->>` derived from `->`, never the other
way (`->>` reads "5" and 5 alike). A READY path with no marked row reads the column ALONE; a marked row, through a CASE.
A `*`, `t.*` or NATURAL JOIN reads a view of the visible columns (`__mason_visible`).

**Why.** 1 M rows of ~2 KB documents, `count(DISTINCT …)` of one path: the function 12.6 – 14.8 s; the CASE naming the
document 0.33 – 0.49 s; the `->` column alone 5 – 8 ms; `->>` derived 8 – 9 ms (a second `->>` column, 5 – 7 ms, would
cost a whole-table backfill). On the test server a whole-table read of big documents: 192.6 s by the function, 41.6 s by
the CASE (it reads the document for every row), 8.5 s for a small column. ~300 B of JSON a row:

| | 1 M rows | 3 M rows |
|---|---|---|
| `GROUP BY payload ->> 'status'`: function → stored | 2,495 – 2,611 → 13 ms | 7,632 – 8,062 → 39 – 41 ms |
| `WHERE payload ->> 'customer_id' = 'c42'`: function → stored | 2,701 – 2,734 → 12 – 13 ms | 7,767 – 8,055 → 38 – 40 ms |
| the backfill of one path / the event loop's longest wait | 2.8 – 3.4 s / 148 ms | 8.3 – 12.2 s / 190 ms |
| a 10,000-row stream batch: 0 → 3 stored paths | 371 – 445 → 439 – 524 ms | 357 – 482 → 403 – 461 ms |

A path costs about one function read, once, then every read ~200× less.

### 1. Which paths: the review weighs the reads against the fill

**Decision.** Every `REVIEW_MS` (10 s) the keeper counts the request log's JSON reads by path and stores at most one.
Under `SMALL_FILL_SECONDS` (60) of estimated fill, a path is stored after `KEEP_AFTER_STATEMENTS` (3) statements or one
of `KEEP_AFTER_MS` (1 s); otherwise once 3 statements' reads took `KEEP_FILL_SHARE` (a tenth) of the estimate. A path
held back is a `waiting` row with its estimate. A review never waits for a fill; a path decided meanwhile is `queued`.

**Why.** On the test server one 3.5 s read of a 7-day window started a fill of 196.5 M rows — 1 h 34 min, disk-bound at
~2.5 KB read a row — and the waiting rows stayed an hour stale behind it. Three: a dashboard reads its paths a few times;
a tenth: reads at that rate over the week pay the fill back within weeks. **The estimate** (`fillEstimate`) is the rate
the column's last fill measured (`MEASURED_MIN_ROWS` 10,000 rows, the table at most `MEASURED_SPAN` 10× bigger), else 13
µs a row plus a µs per 120 bytes of the column ON DISK a row (`pragma_storage_info`). Text bytes alone priced the server's
196.6 M-row fill at 16 min 48 s; it took 60 and 94 min (5.6× low). A laptop's 30 M rows (~329 B a row on disk) took 558 s,
18.6 µs a row, the function's parse the cost; the server's 18.35 µs a row read ~2.5 KB of disk. The model: laptop 472 s
(0.85×), server 2,980 – 6,650 s, each within 2×. Every estimate says its `basis` in `mason status`.

### 2. Where the work runs: in the background, on the writer's turns, with no default

**Decision.** The column is added on the writer's turn with NO default, filled `BACKFILL_ROWS` (50,000) at a time by
`rowid`, each chunk its own transaction on the writer's turn, then swept by its NULL; never while its table is rebuilt.

**Why.** DuckDB writes a non-NULL default into every row in the ALTER and its COMMIT: with `chr(0)` the test server's
196.5 M rows held the writer ~28 s (~3.5 min beside a whole-table read; the WAL grew 1.4 GB); a laptop's 30 M rows 0.7 –
1.0 s against 0.1 s with none. Even with none, the ALTER (100 – 330 ms over 30 M rows) builds the column in memory for
every row (135 MB, ~4.5 B a row), which the next checkpoint writes (64 MB, 60 – 180 ms) — the same on its own connection,
as `JSON` or with `IF NOT EXISTS`. The test server's 196.6 M rows held the writer 8 – 17 s; the gap from the laptop's
scaled 1 – 2 s is not reproduced.

### 3. Every write computes it; 4. the route; 5. the lifecycle

**Decision.** The poll's `writeStaged`, the stream's `writeByKey` and `updateCarried`, the copy's side table
(`fillSide`) and the backfill compute the stored columns in the write. The DETECTOR, every `CHECK_EVERY` (6) reviews and
every swap, fills unset READY rows and turns a path with marked rows back to the CASE, said as a Mason bug. The rewrite
reads a column only when READY (`keptRead`); a state change moves the keeper's generation and kept plans are remade. A
path goes with its JSON column; `MASON_STORE_JSON_PATHS=off` drops all. Not stored: a path by a parameter, a subquery's
column. **Known**: an unread column is never dropped, its disk not reported; an empty request log stores nothing.
**Where.** `src/duck/kept.ts`, `kept-route.ts`; `tests/duck-json-columns.test.ts`, `duck-json-paths.itest.ts`.

## The Postgres API

The catalog a tool reads is a Postgres (PGlite with the source's definitions): `.claude/rules/postgres-api.md`.

### The listener off this machine

**Decision.** One reader of the listener's settings (`pgListenerSettings`): `MASON_PG_HOST`; the project's own port,
recorded at its first start and refused rather than moved when held (a tool's saved connection outlives a restart);
`MASON_PG_TLS_CERT` / `_KEY`. Off loopback without a certificate the start refuses before the run spawns (the way out: the
two variables, `MASON_PG_PLAIN=1`, or `--self-signed-tls`, a DER certificate from `node:crypto`, no dependency). A direct
TLS start (a ClientHello first, ALPN `postgresql`) is taken beside SSLRequest; `SHOW ssl` answers from the session.

**Why.** A hosted BI tool had to reach the test server's run, which bound 127.0.0.1 with no TLS whatever the shell said,
so a TLS proxy had been written beside it. Postgres 17's `sslnegotiation=direct` sends a ClientHello first. `SHOW ssl`
had answered `off` over TLS. **Where.** `src/api/postgres/listener.ts`, `src/cli/pg-tls.ts`; `tests/pg-tls.test.ts`,
`tests/postgres-api/tls.test.ts`.

### Users

**Decision.** `mason user add <name>` prints a password once: `mason_<id>_<mac>`, 16 random hex digits then 32 of an
HMAC-SHA256 over the NAME and id keyed by the API key, so the startup packet's user name must be the user's (28P01
otherwise) and every statement is attributed. The list is `.mason/users.json` (no secret), changed under a lock file;
the listener stats it before every statement of a user's session, so a removal ends a held session at its next
statement (28000), no restart; an unreadable file refuses every user (57P03); rotating the API key removes them all.

**Why.** A BI tool stores ONE password; the day-long token killed its connection the next day. A file, because `mason
user` runs beside the process holding DuckDB's lock. Named as Postgres names it (`CREATE USER … WITH PASSWORD`).
**Where.** `src/duck/users.ts`, `src/cli/user.ts`; `tests/duck-users.test.ts`, `tests/duck-users-wire.test.ts`.

## The request log

**Decision.** Every statement DuckDB answered and every refusal or failure (a Parse, a Bind, a syntax error, a refused
catalog read, a bad password) is a row of `_mason.requests` in `.mason/duck.db`; an answered catalog read, SET, SHOW or
BEGIN is chatter and is not. Its columns: `request_id`, `seq`, `started_at`, `duration_ms`, `session`,
`application_name`, `token_name` (a NAME, never the token), `user_name`, `method`, `sqlstate`, `message`, `detail`,
`hint`, `rows`, `query` (cut at 64 KiB, `query_truncated`) and `json_reads` ("Stored JSON paths" 1.). Written in batches
(a second or 1,000 rows) on a connection of its own, never the writer's turn; a failed write is said and fails no
statement; kept `MASON_REQUEST_LOG_DAYS` (7) days; read only through the command server; ordered by `started_at`, `seq`.

**Why.** A BI tool met an error on the test server and nothing could be found afterwards: the run threw the rows away
(`record: () => undefined`). A swap or a stream batch may hold the writer for seconds. With a random uuid and a
millisecond clock, a refused login and the statement before it read back in either order until `seq`. **Where.**
`src/duck/requests.ts`, `src/api/postgres/server.ts` (`recordRequest`); `tests/duck-requests.test.ts`.

## The CLI and the project

`.claude/rules/cli.md` has the rules. The decisions with a measurement or an incident behind them:

- **One sources file** (`src/cli/sources.ts`): `mason/sources/<name>.yml`, `url: ${DATABASE_URL}` (the URL stays in
  `.env`) and `tables`. Types are read from the database at every start, never written: a type in the file would be a
  second account of the source, wrong the day a migration runs. `mason add` / `remove` splice one entry, comments kept,
  and check a `--key` against the database first (a `key:` with duplicates had failed the copy, retried for ever).
- **A supervisor** (`src/cli/supervise.ts`) restarts a run that dies once ready: same port, waits of 1, 2, 5, 15 and 30 s,
  given up after 5 in 10 minutes; it records its pid so `mason stop` between restarts reaches it (stop had said "not
  running" and the run came back seconds later). DuckDB recovers from its WAL, so a restart is seconds, no fresh copy.

### The demo database (2026-10-27)

**Decision.** `mason init demo` makes an ordinary project whose database Mason hosts itself: PGlite (Postgres 18 in
WebAssembly, already a dependency for the catalog) persisted in `.mason/demo/`, seeded with a small shop schema at its
first open, served by the `mason start` process on a loopback port over the Postgres wire protocol, and changed every
`MASON_DEMO_CHANGE_MS` (5 s) by a writer in the run. The project's files are the usual ones — `url: ${DATABASE_URL}`,
three of the four tables added, the demo's URL in `.env` — with `demo: true` in its config. The fourth, `order_items`,
is left out of the sources file (2026-10-28, `DEMO_TABLE_TO_ADD` in `src/demo/seed.ts`): the first thing a person does
after `mason start` is a real `mason add` (or the web page's Add), and they see a copy begin; its foreign keys' targets
are among the three, so it joins cleanly when it lands, and the writer keeps inserting into it in the database meanwhile. The port is chosen free at init and kept
in that URL alone; the run reads it back from the resolved URL (`src/cli/demo.ts` `demoPort`). It is read by polling
only: `--replication` on a demo project is refused before anything starts.

**Why.** A first try should need nothing installed: no Docker, no Postgres, no database of one's own to point at.
PGlite is a real Postgres (its catalog, its types, its `xmin`) already in the package, where a fixture of rows would be a
second account of what a source is. It is reached over the wire, not through PGlite's own API, because the demo must run
the read path production runs — `checkSource`, the chunked copy, the poll, the catalog read every 10 s — or it would show
a Mason no one deploys. Polling only, because PGlite has no WAL sender: there is no change log to stream. The port lives in
one place because two records of it (the URL and a config field) would disagree the day a person edits `.env`; an edited
URL is refused by the run with the way out. `mason destroy` removes `.mason/demo/` with the copy and keeps `demo: true`,
so the next start seeds it again. **Where.** `src/cli/demo.ts`, `src/demo/source.ts`, `src/cli/init.ts`, `src/cli/dev.ts`;
`tests/cli-demo.test.ts`, `tests/cli-project.test.ts`.

## Operating it

### On a server: `mason serve` and the image

**Decision.** `mason serve` is `mason start --attach`'s run configured by the environment alone (`DATABASE_URL`,
`MASON_API_KEY`, `MASON_PROJECT`, `MASON_DATA`, `MASON_NAME`, `MASON_CHANGES`, `MASON_PG_*`), every bad setting on one
report, the log on stdout, SIGTERM its stop (tini PID 1). `GET /healthz` (`MASON_HEALTH_PORT`, 4140) is 503 until the run
answers, counts only (it takes no credential). The image (`docker/mason-data.Dockerfile`) is node:24-slim with DuckDB's
postgres extension installed at build (closed egress still copies); one replica, stop-then-start deploys;
`deploy/mason-data/compose.yml` the quickstart. `version()` is `PostgreSQL 18.6 (mason-data <version>) …`, Postgres first
since tools parse it. Item 1 of the server's plan was a login that does not expire: `mason user` ("Users").

**Why.** A first start is 503 for ~15 s idle (14 s on the host, 15.7 s in the image), 13 s of it ONE query sorting every
code point under the collation (kept in the copy: a restart is healthy in 0.5 s); at load 31 it took ~2.5 minutes, so
the HEALTHCHECK start period is 2 minutes plus three checks 15 s apart. One replica: DuckDB's file lock admits no reader
process beside the writer. Not built: Let's Encrypt, an SSH tunnel, readers over shared
storage, measuring where the catalog's ~820 MB goes. **Where.** `src/cli/serve.ts`; `tests/serve.test.ts`,
`tests/integration/duck-serve.itest.ts`.

### Memory and the machine

DuckDB's limit is half the RAM (its own 80 % let the system kill the run), in one process with V8 and two PGlites; a
wide JSON column is disk-bound past RAM (the test server, a 28 GB table: `payload->>'key' IS NOT NULL` over 22 M rows
93.5 s, against 15 s on a ClickHouse beside it): `.claude/rules/duckdb.md` "Memory and the machine". **What a copy costs
the queries beside it is page-cache eviction, not CPU** (the test server, five runs of a weekly chart over 22 M rows, Q1,
and a 7-day count over 196 M rows, Q2):

| beside the queries | Q1 | Q2 |
|---|---|---|
| nothing | 1.0 – 1.25 s | 0.19 – 0.36 s |
| CPU load only (an in-memory DuckDB) / the same at nice 19 in its own autogroup | 1.85 – 2.15 s (+85 %) / 1.35 – 1.9 s | |
| the disk saturated by O_DIRECT writes | no change | no change |
| BUFFERED writes evicting the page cache (9 → 2 GiB) | up to 8.0 s | up to 9.9 s |
| a real re-copy of the 22 M-row table | 4.1 – 4.5 s | |

So a copy's writes in flight are bounded (a chunk per reader). It does not yield between chunks: nothing counts the
statements in flight, and DuckDB 2.0 has no per-connection thread or priority control (`SET SESSION threads` is refused).

### What stands between this and production

1. A self-signed certificate only encrypts; a verifying client needs a CA's (`MASON_PG_TLS_CERT` / `_KEY`).
2. Every login reads every copied table: no per-user or per-tenant scope.
3. The poll scans every polled table every poll, so only tables under 1,000,000 rows are polled ("The poll").
4. A numeric of more than 38 digits, or holding NaN / Infinity, is a double (15 digits).
5. No copy has an index ("Heap order, no index").
6. A statement can fail on DuckDB where Postgres's plan filtered the failing rows out first (fixed for FILTER only).
7. The gaps ([`docs/SQL-SUPPORT.md`](SQL-SUPPORT.md)).
8. A wide JSON column is disk-bound past RAM; stored paths help only a path read again ("Memory and the machine").
9. On a laptop a large copy and a BI query share half the RAM; what cannot spill fails with 53200, the run goes on.
10. A table being caught up holds its decoded changes in Node's heap (`held`): unbounded for a migration meanwhile.
11. A copy's catch-up is ONE poll, neither chunked nor resumable (a transaction held open on the source moves the rows
    since into it; a copy resumed days later catches up days), and a copy neither pauses for a smaller table nor yields.

## Measurements

### First copy, and the poll's cost on the source

Four tables of a real database (the largest keyed tables under 5 GiB), each copied in one transaction through the
`postgres` extension, on a laptop:

| table | rows | source bytes | first copy | a poll's scan (5 polls) | its count |
|---|---|---|---|---|---|
| T1 (20 columns, jsonb) | 1.38 M | 4.93 GiB | 44.1 s | 2.3 – 5.7 s | 66 – 103 ms |
| T2 (8 columns, jsonb) | 23.4 M | 4.64 GiB | 47.3 s | 4.9 – 8.4 s | 690 – 849 ms |
| T3 (6 columns, jsonb) | 1.44 M | 2.17 GiB | 14.2 s | 2.9 – 3.7 s | 190 – 230 ms |
| T4 (8 columns, jsonb) | 3.16 M | 1.33 GiB | 4.8 s | 1.4 – 3.5 s | 98 – 213 ms |

13.1 GiB in 110 s (~120 MiB/s) into an 8.8 GiB file; a poll 13–17 s of the source's time, its snapshot read 0–13 ms.

### A Metabase dashboard, Postgres against Mason

Metabase 0.64.2.8, six cards over a synthetic database (200 k customers, 5 M orders, 10 M order items, 1.8 GB) on an
untuned Postgres 18 (128 MB shared_buffers, 4 MB work_mem, indexed on the join and date columns), every card at once, 11
loads after a warm one; every card's rows equal:

| card | Postgres p50 | Mason p50 |
|---|---|---|
| orders by status (5 M rows) | 1953 ms | 496 ms |
| revenue by month | 3385 ms | 647 ms |
| orders by a customer column (implicit join, 200 k) | 2244 ms | 583 ms |
| units by order status (implicit join, 10 M × 5 M) | 8043 ms | 818 ms |
| orders per day in a quarter, one status | 1807 ms | 740 ms |
| native: top products (`count(DISTINCT)` over 10 M) | 19087 ms | 451 ms |
| **the dashboard** | **19088 ms** (17.3 – 24.8 s) | **833 ms** (0.59 – 1.66 s) |

A tuned Postgres would close part of the gap, not 23×.

### Mason against a Postgres read replica

**Decision.** `scripts/bench-replica.ts` sweeps each axis until Postgres's p95 of a six-statement mix reaches a target
(`--target-postgres-seconds`; a minute for a published run): rows at 8 clients about √10 a step (`nextSize`), then
clients at the largest size under the target, doubling (`clientSteps`) to 1,024. Each engine is measured with the other
stopped. The README's "When is Mason faster?" is rendered from its fixture; `docs/BENCHMARK.md` has the method
in full (a replica's settings and indexes for the container's memory, answers compared before timing, the median of
runs).

**Why.** A grid compares sizes someone picked; a replica's owner asks where Postgres stops being usable. An idle engine
keeps its buffers and takes the other's page cache, which on a 15 GiB machine is the comparison itself.
`max_connections` is raised past the clients so the sweep measures answers, not refusals (a replica's default is 100).

**Results so far: laptop smokes, not the published numbers.** The committed fixture's sweep to 2 s crossed it at its
first cell (1 M rows, 8 clients: Postgres p95 2.23 s, Mason 153 ms; 15.1 statements/s against 118; the slowest statement
the top-20 join, Postgres p50 2.04 s); an earlier grid at 1 M rows had the mix's p95 at 251 ms / 23 ms with one client and
1.02 s / 76 ms with eight. Statements that read every row cost Postgres a heap scan and Mason a scan of the columns they
name; those an index answers are Postgres's (the point lookup 0.3 ms against 1.9 ms alone; Mason's rose to 20–22 ms beside
the scans, why not measured). Not shown: 10 M+ rows, a page cache smaller than the tables, a write load beside the reads,
a real database's rows.

### DuckDB alone against the oracle

**Decision.** Every oracle run asks each statement, as written, of a plain DuckDB connection over the same copy
(`duckdbAlone`); `tests/fixtures/oracle-duckdb-alone.json` holds the tallies, rendered in the README's table, and a move of
over a percentage point fails until it is rewritten. **Why.** It measures what Mason adds over its engine: of 2,753
statements Mason answers 94.7 % exactly (1.0 % a decided difference, 4.3 % refused by name, no wrong value); DuckDB alone
30.9 % exactly, 25.0 % the right rows under its own names, 16.2 % refused with its error, 12.6 % a wrong value, 6.1 % wrong
rows or order. By group on DuckDB alone: common whole statements 80 % identical, the BI shapes 21 %, the type matrix 36 %;
what fails includes integer division (`7 / 2` is 3.5), LIKE's escapes, an array's text (`[0,1]`), a libc collation's order.
