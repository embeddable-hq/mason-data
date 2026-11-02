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
the 3 GB key column is read from EBS, tens of seconds. So a stream batch touching a table over `BIG_TABLE_ROWS` (1,000,000) is
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
render the chunks in flight between commits at that rate, held under 90 % of their expected rows (`READING_SHARE_CAP`), and the
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
- **ZSTD strings, the disk projection**: `.claude/rules/duck-memory.md` "Memory and the machine" (JSON text 0.66 → 0.26 GB/M rows).

## Keeping a copy current

### The poll

**Decision.** Each table is polled by ONE DuckDB transaction over ONE source snapshot: rows whose `xmin` is at or past the
watermark are written by key, an anti-join deletes what the source lacks only when the counts differ, and the watermark
commits WITH the rows. Over `POLL_PIECE_ROWS` (50,000) changed rows the deletes go first and the rows 50,000 to a commit,
the watermark moving with the last. Which tables are polled, and how often, is the sources file's `sync:` (next
section); a table's next poll is its interval after its last, stretched to four times that poll's time (`nextPollAt`).

**Why.** At 64 MB on 1 M uuid keys (while copies had a key) one upsert of 600,000 changed rows ran out of memory; in
pieces of 50,000 all 1 M went in, in 1.5 s; 8,000 deletes after 720,000 upserts ran out where before them they did not.
A poll is a full scan of every polled table (no index covers `xmin`): 13–17 s per poll for 13 GiB ("Measurements"), so a
5 s interval stretches to about a minute; a stretch once capped at 60 s capped an hourly interval too (a 10 GB table
polled every 74 s for seven hours). On the test server one 22 M-row table cost the replica 12 s of scan and 2 s of count
per poll. **Where.** `src/duck/sync.ts`, `src/cdc/poll.ts`; `tests/integration/duck-poll.itest.ts`.

### Each table's sync (issue 33)

**Decision** (2026-10-29). How a copy stays current after its first copy is the sources file's `sync:`, at the top of
the file for every table and on an entry for that one: `off` (the default) reads it again only at `mason sync <table>`,
`poll <interval>` (`<n>s|m|h`, 1 s to 24 h) polls it at that interval. One grammar (`parseSync`, src/lib/table-sync.ts)
read by the file's reader and by `mason add --sync`; `replication` streams the table from the change log (below, PR 2
of 3). The run is ONE pass loop that polls
the tables due (`Sync.dueAt`), never a timer a table: a pass also queues copies, drops removed tables and attaches the
source once. Two bounds on what the polls cost the source: a table's own (`nextPollAt`, four times its last poll) and
the passes' (`passDelayMs`, four times the last pass). The sync each table was last polled or copied under is a column
of `_mason.poll_state`, so a change made by hand while Mason was down is seen at the next start; a change keeps the
copy and catches it up by one poll. The row limit moved from the run to `mason add`: a table over `BIG_TABLE_ROWS`
(1,000,000) added under a file whose default polls is written `sync: off` on its entry and said, and a poll of more than
`COSTLY_POLL_ROWS` (10 M) more often than every minute is warned of with an estimate and its basis (the table's last
poll measured, else the copy's read rate a reader, else the catalog's rows at an assumed 1.8 M rows a second).
`MASON_POLL_MS` is no longer read, and refuses the start naming the line to write.

**Why.** The project-wide interval and the run's row limit made one decision for every table, and the second was found
only by its effect: a table over the limit was copied, served and never polled, said only as "NOT kept current" on its
line, and an operator who wanted a small table every 5 s and a big one hourly could not say so. A poll is a full scan
(above), so the cost of polling is the table's size times its frequency: the file is where the developer weighs it,
table by table, and `off` by default means Mason reads nothing it was not told to. The copy's age is said wherever a
copy is read (`mason status`, `wait`, `sync`, EXPLAIN, the MCP tools), since an `off` table is as old as its last sync.
**Where.** `src/lib/table-sync.ts`, `src/duck/sync.ts`, `src/cli/source-edit.ts`; `tests/cli-sources.test.ts`,
`tests/duck-sync-schedule.test.ts`, `tests/integration/duck-poll.itest.ts`.

**`sync: replication`, per table** (2026-10-29, PR 2 of 3). A table whose sync is `replication` is streamed; the others
are polled beside the stream or left `off`, in one run. The project still has ONE slot and ONE publication, and the
publication carries the replicated tables alone: Mason's own is `ALTER PUBLICATION … SET TABLE` to exactly that list
(created with it when missing) and verified against `pg_publication_tables` afterwards, so a polled table's writes
are never decoded into the slot's WAL; a publication the operator names (`publication:` at the top of the sources
file, `${PG_PUBLICATION}` allowed, read by `readSource` as `url:` is) is never altered, and a replicated table it lacks
is refused alone with the `ALTER PUBLICATION … ADD TABLE` its owner runs. What cannot be replicated is refused at the
file's read, on one report with the line to write: a `key:` table (no primary key, so the stream cannot apply its
changes by key) and a `REPLICA IDENTITY NOTHING` one (publishing it would fail the app's own UPDATEs), the latter read
from the catalog; `mason add` of either under a file whose default is `replication` writes `sync: poll 5m` on its
entry and says why. A change of sync keeps the copy in every direction: into replication the table is marked behind
(`_mason.catch_up`, so a restart owes the same) and its changes are held from before its one catch-up poll — the
publication carries it before that poll starts, which is what makes the replay safe (src/duck/stream.ts) — then it
joins the stream; out of it the table leaves the stream (`refreshStreamed`) and is caught up by one poll from its
watermark, then polled as its sync says. When no table is replicated any more the slot is dropped, and Mason's own
publication with it, VERIFIED gone (`retireReplication`: the stream stopped first, the slot waited inactive), at the
start that finds none and live when the last one leaves; the project's config records what was made
(`config.replication`) through the run's hook, so `mason destroy` drops what exists, never a name computed again.
`mason start --replication` / `--poll` / `MASON_CHANGES` were taken only where they agreed with the file and refused
otherwise, naming the `sync:` line to write, until PR 3 removed them (below).

**Why.** One decision per project made the developer choose between a slot that decodes every table's writes (a busy
log table the dashboards never read included) and polls that scan every table; the file already weighs each table's
cost, so the change log is one more choice there. A publication of the replicated tables alone keeps the slot's WAL to
what Mason reads. The slot is dropped when unused because it holds the source's WAL for ever otherwise (CLAUDE.md
"A replication slot outlives its reader"). The copy's age of a replicated table is the stream's position and the last
instant the stream was known current (`kept.syncedAt`: the later of its last poll and the stream's last keepalive or
flush with nothing pending), said as `replicated, at <lsn>, <age>` on its line, so a stopped stream's copy is never
read as current. **Where.** `src/duck/sync.ts` (`replicated`, `streams`, `ensurePublication`, `retireReplication`),
`src/cli/replication-mode.ts`, `src/cli/sources.ts`; `tests/cli-sources.test.ts`,
`tests/integration/duck-stream.itest.ts` (a mixed project, a switch each way, a named publication, REPLICA IDENTITY NOTHING).

**The flags and `MASON_CHANGES` gone** (2026-10-30, PR 3 of 3). `mason start --replication`, `--poll` and
`--publication`, and `MASON_CHANGES` on a server, are removed: each flag answers, before the options are parsed and
before anything starts, with the line to write at the top of the sources file (`sync: replication`, `sync: poll 5m`,
`publication: <name>`) and exit 2, on one report however many are given; `MASON_CHANGES` set is one line of `mason
serve`'s settings report, naming its `sync:` line (`removedStartFlags`, `changesRetired`, `src/lib/table-sync.ts`).
The way out names the EDIT, read from the file (`sourcesTop`, `topEdit`): every file `mason init` writes has a `sync:`
line at its top already, so "write `sync: replication` at the top" made a second one, a file the run refuses (the
independent review); it says "change `sync: poll 5s` … to `sync: replication`", "keep", or "write" only where the file
has no such line — `MASON_POLL_MS`'s too. A test applies each way out to an init-made file as written and parses it.
**Why.** Taken where they agreed with the file (PR 2) they said nothing the file did not, and two places to say how a
table is kept current is one more than production can be held to: the committed file is what runs. A removed setting
refuses rather than runs a default (CLAUDE.md "Conventions"). `config.json`'s `changes`, the mode an older Mason
recorded, is still READ — never written — so `mason destroy` drops that older run's slot, and a start under a file that
says `sync: off` or `poll` drops it too; the first start past that deletes it. **A file naming tables with no `sync:` at all
REFUSES the start of a project with a slot, and a run up keeps the tables it read** (2026-10-30, before v0.8.0;
`recordRefusal`, src/cli/replication-mode.ts; `rereadSources`; the independent review widened it from 0.7.0's record to
any recorded slot): that start used to drop the slot and go on, so an operator who merely omitted a line paid a full
scan of every table on their production database. A silent file is an omission; any `sync:` at the top or on an entry is a decision, so a project that chose polling has
its way through. The same for a recorded `publication` no line names, which silently became a publication Mason made
on the source (0.7.0 read the record at each start; the literal `publication: null` is the way to Mason's own on purpose, since a
keyword could be someone's publication and taking the line out is what the omission looks like; a bare `publication:`
is a mistake, and `publication: null` beside `PG_PUBLICATION` is refused, since it is a CREATE on the source). `MASON_CHANGES` set
refuses `mason start` too. **Where.** `src/cli/registry.ts`, `src/cli/serve.ts`,
`src/lib/table-sync.ts`; `tests/cli-commands.test.ts`, `tests/serve.test.ts`.

### Logical replication

**Decision.** A table whose `sync:` is `replication` is kept current from the change log (`src/duck/stream.ts`); the rules
are `.claude/rules/duck-sync.md` "Keeping a copy current". Why each is so:

| decision | why, with the number |
|---|---|
| a NAMED publication is read and verified (`checkPublication`), never created, altered or dropped | a read replica takes no CREATE PUBLICATION; on a production primary the slot is the one object Mason creates |
| a table the publication lacks (or narrows, or filters) is refused alone; insert, update and delete must be published | a filtered row's delete never arrives; one table's gap must not stop the rest |
| on a standby: a named publication, and Postgres 16+ | a standby decodes only from 16 |
| `REPLICA IDENTITY NOTHING` and a `key:` table are refused | publishing a table of `REPLICA IDENTITY NOTHING` fails the app's own UPDATEs and DELETEs; a `key:` table's changes carry no key to apply them by |
| a table joins once caught up by ONE poll; a new slot catches the copies up by one poll from their watermarks | a key's changes replayed in commit order end at its state, so nothing is copied again |
| a batch (500 ms or 10 k changes) commits with its position before it is acknowledged; idle, the server's position is acknowledged | a run that dies skips what it applied; an idle slot holds no WAL |
| a large transaction is applied in committed pieces of `PIECE_CHANGES` (10,000) | 607,000 changes in one transaction ran a sync out of a 96 MB heap folded whole; in pieces it ran in 48 MB |
| a change is written as the COPY's columns (`Sync.asCopied`, `projectTuple`) | a column removed from a 22 M-row table's entry and restored during its re-copy: held changes named a column the copy lacked (`Binder Error`) and the table stopped |
| a batch holds a table's changes of ONE stay in the stream, and only the stay it is in now is applied (`StreamedTable.stay`) | told apart by columns, two copies inside one 500 ms flush (a sources file edited and restored, 0.2 s each on CI) mixed two shapes in a batch and held the table 5 minutes; the same race dropped changes made after the catch-up's poll, and could replay an old change over a newer one |
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

### A type the copy maps to another

Metabase's fingerprint failed on a `timetz` column: `information_schema` said `text`, the copy held DuckDB's TIMETZ, and
`SUBSTRING(col, 1, 1234)` failed in the engine's words. A review had found the same for `point`, sent as text with
`{'x': 1, 'y': 2}` inside. Reading every built-in type through the copy found the class was wider than either report: the
catalog said what the wire happened to send, and the wire what DuckDB's reader happened to make. Of 60 types, a `box`,
`circle`, `line`, `lseg`, `path`, `polygon` and most arrays of a type the reader did not know stopped the table's sync
altogether; `interval year to month` and every other type read as text; `pg_typeof` answered DuckDB's own names (`time`,
`struct(x double, y double)`); and a domain over an integer read as text.

The decision closes the class at its two ends. The catalog declares the source's type, always, so Postgres's analysis
decides every statement (a `GROUP BY point` is Postgres's own 42883, a `substring(point, …)` too). And the copy's holding
has a default that cannot be wrong: what `NATIVE` does not name is held as Postgres's text, so a type nobody thought of
reads right, and everything that needs its own value is refused by one rule rather than one rule per type. `timetz` is
NATIVE: DuckDB's order is by the instant and then by the offset, east first, which is `timetz_cmp`.

Three things were not obvious. The oracle runs with the allowlist off, so the refusal had to be explicit: `length(lseg)` is
a function Postgres has, and the rewrite answered the length of its text. A literal must be canonical to equal the column
(`'0800.2b01.0203'`), which Postgres's own input function does at the rewrite; but a money's text is the source's
lc_monetary's. And pgjdbc asks for `timetz`, `point` and `box` in binary once a statement has run five times, which a BI
tool's repeated query does: those three have their binary form, and any other is refused by name.

### What is not supported, and how the list stays true

**Decision.** An allowlist, not a blocklist: DuckDB answers only a statement whose every function, operator, aggregate,
cast, type and construct (by resolved OID, `src/duck/resolved.ts`) is in `src/duck/verified.ts` — what the oracle answered
EXACTLY in all three phases, regenerated by `UPDATE_VERIFIED=1` or, from a CI run's oracle legs,
`node scripts/oracle-legs.ts --write <run-id>`; anything else is 0A000 naming the piece. Every refusal
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
| text under glibc `en_US.utf8` sorted as ICU (Hangul after Latin, `$` after `@`) | glibc's order MEASURED from the database at the first start (~14 s; 13 s one query sorting 159,865 code points), kept in the copy (`src/duck/libc-order.ts`); its four levels read since issue 128, see "A libc order, read level by level"; what cannot be read refused (`libc-uncovered`) |
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

### The independent review (2026-10-28)

**Decision.** Every PR is read for wrong answers by a reader in a fresh context before a person sees it, and its
findings go back to the author in one message (CLAUDE.md "How work is done here", "The loop").

**Why.** Three PRs landed in one day — three rewrites for a BI tool's slow shapes (date_trunc of a timestamptz, a
LEFT lateral of json rows, the nulls idiom), jsonb's order and equality, and that order stored as a column — each by an
agent whose own oracle run showed zero differences over about 21,000 statements. Independent readers of the diffs,
handed the code and not the authors' reports, found eleven wrong answers between them, every one a shape the authors'
statements had not held: a grouped jsonb sorted by its ordinal or output name sorted by its text (a clone dropped the
node's type); the nulls idiom folded a bare name an output alias shadowed, and an integer ordinal; a three-argument
date_trunc never read a NULL or row-held zone for seconds and below; jsonb equality under glibc refused whole tables
holding an emoji's variation selector, where equality needs no collation; a mark a write stored after a key was counted
exact was read as a key. The authors fixed each with a test shown to fail without it, and the oracle gained the shapes.

**What it cost.** Two implementations of 1 h 45 and 1 h 49 ran side by side; a review took 9 to 15 minutes; the fix
rounds took 44 minutes and 1 h 28 (three batches of findings, three cycles); CI about 12 minutes a run, six runs,
mostly overlapped. The batch landed in a little over three hours: the slowest implementation, one review cycle, and the
CI runs that gated the merges — not the sum of the parts. Where time was spent on nothing new: each agent ran the full
oracle several times while iterating, and one built a 20 M-row dataset twice.

**A finding is a failure, never a patch (2026-11-01).** PR 170 (key-first GROUP BY, issue 134) took five findings of
one class in four rounds: a sort key written as a constant, which the engine reads as an ordinal or refuses. The CI
oracle found a text literal; then a second statement of the same shape; a re-check found a chain of casts and a
derived table's `1 AS one` read through the table around it; the next a cast of a typed literal (`2147483648::int`,
which Postgres evaluates at planning and refuses); the next a regression of that fix (`1.5::numeric`, now kept and
written as a bare `1.5`). Every round the coordinator forwarded the reviewer's suggested edit as the fix, in 20 to 30
calls, and the author applied it, correctly; the reviewer had named the class in round three ("the constant is decided
from syntax where it should be decided from the analysis", CLAUDE.md's "a fact derived in several places") and the
class was never the round's task. Neither the size of the pieces nor the agents' effort explained it: an author handed
a patch applies the patch. So a finding goes back as the statement, Postgres's answer and Mason's, with its class; and
the second finding of a class on one PR turns the next round into a class round, which writes the class's cases down
first, tests each against Postgres, then fixes the decision. Its first such round ran at high effort, to see whether
effort changes the count.

**The loop as workflows, and the base's findings filed (Tom, 2026-11-01).** PR 207 took three rounds over a numeric
quotient computed as a double, and the wrong answer grew each round: main had given it since before the PR, so the PR
chased a class it did not make. A finding the base already answers wrong is now the base's: one issue per class, never
a fix in the PR, and never counted toward the PR's class rule. PR 170 and PR 207 met one class, which per-PR counting
could not see, so a run's classes carry to the PR stacked on it. The coordinator ran the loop by hand; it now runs as
`.claude/workflows/pr-loop.js` and `.claude/workflows/issue-loop.js`, started with the Workflow tool, each stage an
agent and the scripts' logic held by `tests/workflows.test.ts`. The brief and the plan moved to Opus with implementation, and Fable is kept for the reviews,
where outreading the author is the point.

**Passing the review the first time (Tom, 2026-11-01).** By the coordinator's count of fix rounds over the last 25
merged PRs that change `src/`, about 45% needed at most one and about 55% at most two. GitHub counts 17 commits on
PR 170, 12 on PR 156, 8 on PR 149, 6 each on PRs 109 and 163, and 5 on PR 135. The aim is about 90% passing Fable's
review the first or second time. PR 202 (generated tables, stage 3; open, 10 commits) took six review rounds by the
coordinator's count, and its root cause was a design nobody reviewed. At its head, its refusal reasons were decided by
a walk over the raw parse tree (`seen` and `formsOf` in `src/duck/generated-plan.ts`), guessing types from lists of
function names, where Postgres's analysis already held every node's result type (`src/duck/pgtree.ts` reads them)
and "Postgres decides, DuckDB computes" is CLAUDE.md's first principle. Every round's wording finding traced back to
that guess; each fix layered another guess on it, and each class round's brief described the syntax walk as the
decision, so the class rounds built more of the wrong design. What the reviews caught, the brief had never given the
author: a rule the project already has, not applied ("Postgres decides", "a fact derived in several places", "A
refusal on the wire is Postgres's", "An APPROXIMATE value cannot be compared for equality"); the reviewer's probes,
which the author never ran (wrap the expression in `* 2`, coalesce or round, nest it, change the input type, put the
table on an outer join's nullable side, pass a parameter, prepare before a SET, run the real run and not only the unit
world); unverified assumptions about the engine or the real run; and context lost between rounds, each fix round a
fresh agent seeing only the latest findings. CI was red at PR 202's first commit (`checks`, a unit shard and
`integration (rest)` failed), and rounds 1 and 2 never heard of it, since the loop read CI only once the reviews were
clean. So `pr-loop.js` gained six phases and changed its rounds twice:
- **Design** and **Design review**: an Opus note before code, naming each fact's authority, which Fable reviews
  against that code; after two rounds the run goes on, carrying what is still open in its result and status.
- **Probe**: before every review, a fresh Opus with no stake in the code runs the `## What review probes` of the
  rules files the diff touches, the reviews' own probes and the note's shapes; this PR's findings are fixed before
  Fable reads the head, at most two rounds a push, counted apart from the review's. The probe is the author's check
  and the review the gate, so a probe that fails is noted and the review goes on.
- **Learn**: once the reviews are clean and before the CI loop, each class met becomes a bullet in its rules file's
  section, so the next PR's probe runs it. Its commit is neither probed nor reviewed, so its files are read from git
  and a head that changed anything outside `.claude/rules/` stops the run. `tests/workflows.test.ts` holds every
  rules file to the heading, and `tests/conventions.test.ts` every bullet to the PR or issue it was met in.
- **Record**: every exit with a PR posts a `Review record` on it, and `scripts/review-stats.ts` turns the records into
  the number that says whether this worked: of the PRs that reached a review, the share whose first review found
  nothing of theirs, and whose first or second did; runs that stopped before a review are counted apart.
- **Link**: PR 202 said "Part of #175", which GitHub does not link, and the board never saw it: the prompt asked for
  `Closes` and nothing read it. After the implement push the run now asks GitHub whether the PR closes its
  sub-issue, fixes the body once if not, and stops if it still does not. GitHub links a closing keyword only on a PR
  into the default branch, so for a stacked PR the body's keyword is read instead.
- The rounds: every fix round is handed the note and every earlier round, probe and review, with what each judged
  correct; and CI is read beside each review, a red run going back with the review's findings in the same fix. Beside
  a clean review there is no fix round to join, and the CI stage reads the failure again after Learn.

**Only a blocking finding sends a PR back (Tom, 2026-11-01).** PR 202 took eight review rounds. Rounds 1 to 4 and 8
found real wrong answers or a crash; rounds 5 to 7 found only the quality of refusal messages (a reason, a HINT, a
DETAIL), about two hours of rounds on a PR whose answers were by then right, and PR 207 spent rounds the same way. The
owner's words: "It's super important that we don't let any real correctness or security bugs get through. But if you
determine that the feedback items don't block the current PR and instead go into a new issue, that feels like a good
way to move forwards." So every finding the probe and the review report carries a severity (the `FINDINGS` schema in
`pr-loop.js` requires it). Blocking: `wrong-answer` (where Mason answers, it answers differently from Postgres: rows,
text, types or OIDs, order, SQLSTATE), `crash` (a crash, a hang, a stuck state such as a table left `building`),
`data-loss`, `security`, `regression` (what the base got right is now wrong or refused), and a red CI. Not blocking:
`message` (a refusal's wording, reason, HINT or DETAIL, or a way out that does not work, when the refusal itself is
right), `over-refusal` (Mason refuses where Postgres answers and the base refused too: safe, and a gap), `docs`,
`quality`. When the reviewer is unsure, the finding is blocking, and so is a finding with no severity or one the
script does not know: the line errs toward a fix round, never toward a wrong answer merged. Only the PR's blocking
findings make a fix or probe-fix round, count toward the class rule and are learnt; a round with only non-blocking
findings is clean. The others are filed at the run's exit beside the base's, one issue per class, each saying it was
met in the PR's review and deferred, and listed in the Review record's `deferred`; `scripts/review-stats.ts` counts a
first review as passed when it found nothing blocking, and reads a record written before severity as all blocking,
since every finding then made a round.

**A review runs statements at scale (Tom, 2026-11-01).** An A/B on issue 192 (WITH TIES): a review that only read
the code passed an implementation clean. Three later checks ran 300 to 500 statements each against Postgres 18 and
Mason side by side, with the base beside them, and found two regressions and about four new wrong answers in that same
implementation. What found them was not the feature's own syntax but forms nobody wrote — `TABLE t` for `SELECT * FROM
t`, a VALUES arm first in a set operation, an empty input under a bound, a `char(n)` arm beside a text arm, a negative
or NULL count or offset, a quotient in a numeric arm beside an integer arm, an exact numeric read through a derived
table or a CTE — and a sweep of the PLAIN form of each code path the diff touched: the regression was `SELECT * FROM t
UNION ALL TABLE t ORDER BY 1 LIMIT 2`, which has no new syntax at all. Each check cost about what the reading review
did in tokens (172k to 250k, against 197k), because its statements were batched: one `scripts/duck-repro.ts` call
runs dozens, its output goes to a file, and only the differences are read. The cost is wall time, two to three times.
So the probe and every review in `pr-loop.js` run their statements that way, at the head and the base: the forms are one
list (`VARIANT_FORMS`, over synthetic tables), a full review aims for hundreds and a re-check for a narrower set, and
a statement the base matched and the head does not is a `regression`, blocking. Each reports `statementsRun` and
`statementsMatched`, which the Review record sums and `scripts/review-stats.ts` prints. Statements are what the
engine's and the listener's paths owe, and only theirs: PR 245's second round found every PR made to run SQL, so a PR
of the CLI, the web page, a script, a workflow or docs could never pass. So the evidence is read from the diff's paths,
which the review reports (`changedPaths`): a path in `STATEMENT_PATHS` (the `paths:` of `.claude/rules/duck-*.md`
and `postgres-api.md`, held equal by `tests/workflows.test.ts`, and `src/cdc/`) owes statements, and every other
path owes checks, what it changed run at the head and the base (`checksRun`: a `mason` command, a script, a test
file; never SQL). A review or re-check that showed none of what it owed, or gave no valid count, or did not say its
paths, is never a clean round: the run stops `unreviewed`, saying what to install or run (`psql`
on PATH, Docker or `itEnv` for statements; the command, script or tests for checks), issue-loop goes no further, and
the record counts the round as no review (PR 245's first review found such a round passing as reviewed); a probe that
showed none is noted, as a failed probe is. The statements' Postgres is the file the `itEnv` argument names, or a
throwaway `postgres:18` container of the stage's own, removed when done, whose URL no prompt prints.

### Issue labels and a bug's Severity (Tom, 2026-11-01)

**Decision.** Every open issue carries the label `bug` or `enhancement`. Every bug is on the Mason work board with its
`Severity` field set to Critical, High, Medium or Low (CLAUDE.md "What a session finds"). A session sets it with
`scripts/board.ts severity <n> <level>`, which adds the issue to the board if it is not there.

**Why a field, not a label.** The triage first recorded severity as four `severity:` labels, and the owner moved it to
the board the same day. A single-select field holds exactly one value, where labels allow none or two. Its options are
ordered most severe first, so a view sorts the bugs by it. The four labels were deleted.

**Why.** On 2026-11-01, 3 of the 100 open issues carried either label. Nearly all had been filed by sessions under "What
a session finds, it acts on", each one well written, but none said how much it mattered. A silent wrong answer
sat in the list beside a test's fixed sleep and a harness prompt's wording, and only reading all of them told them
apart. The blocking rule above already sorts a review's findings by severity. The backlog had no such order, and
it is where the deferred findings now go.

**How the lines were drawn.**
- **An over-refusal of a shape never answered is a feature, a regression a bug.** The same split the blocking rule
  makes (`over-refusal` against `regression`): a refusal is safe, and what the base answered is a promise.
- **Harness and tooling defects are bugs.** A harness that drops a finding, misreads its origin or prints DIFFER for a
  statement with no ORDER BY lets a wrong answer through, or wastes a run, as surely as a test that hangs.
- **Data staler than Mason reports is high.** Two issues measured on real deployments made the case:
  - a table frozen for hours while `mason status` called it ready;
  - tables written `poll 15m` polled about hourly.

  No row is wrong, but the reader cannot tell the data is old. That is the same harm as a silent wrong answer, in time.
- **A loud failure is medium, whatever its cause.** A wrong SQLSTATE, the engine's error, or a refusal where Postgres
  answers is a failure the reader sees and can route around. A silent one is never below high.

**COMMON takes evidence.** The first pass rated severity by judgement, and one issue was rated critical: a numeric
quotient that leaves the engine as a double in several readers, judged common because numeric division is everyday BI.
The second pass asked for evidence and moved it to high. The BI shapes the oracle ranks already hold a quotient exact
under DISTINCT, beside a numeric arm in a UNION ALL, and as a cast to text. The readers still wrong (an integer arm,
USING, `length()` of the text, a cast subquery) are in neither the corpus nor the BI shapes, and no deployment met
them. "Common" was the one judgement the two passes disagreed on, so it now names its source:
- the recorded corpus or the ranked BI shapes;
- a named tool, ORM or agent that writes the shape by default;
- a real deployment.

The source is a shape, not a condition. One issue's statements, `initcap` and a text percentile, are among the BI
shapes, but they differ only on a source under an ICU collation. No source records how common that is, so that issue
stayed high, and that call was reported to the owner.

**The triage's result.** It closed three duplicates and closed nothing as fixed. Two candidates were checked against
main and each kept a done criterion still unmet. After the second pass, of 100 open issues: 71 bugs (35 High, 34
Medium, 2 Low, none Critical) and 29 features.

**Detector.** The board's view "Bugs by severity" (`is:open label:bug`, sorted by Severity), where a bug with no
Severity shows at the bottom. An issue with neither label is seen only by reading the list. There is no automatic
check. A script that lists an open issue with neither label, or a bug with no Severity, would be one; it is not built.

### The plan fixture (2026-10-28)

**Decision.** The plans DuckDB runs for the shapes BI tools send are a golden fixture, like `docs/SQL-SUPPORT.md`:
80 statements (27 of PR #13's shapes, their controls, a count by a column and a table's previews, each in the tool's
spelling; 36 of `oracle/bi-shapes.ts`, one of each structure; 17 of a jsonb sorted, grouped, made DISTINCT and
compared, below) explained through the
listener over the shop with a million orders in nine row groups, each reduced to a coarse skeleton — the operators in
tree order, a top N's count of sort keys, each scan's table and whether a top-N dynamic filter or a zone-map filter is
attached (and whether that filter compares a bare column with a constant), the Mason functions called, the time functions the SQL sent calls,
what it sorts or compares by beyond a value (ICU's key, a stored column: `keys`, printed only where there is one), a
delimiter join, a full sort; no cost, estimate or row count, so a DuckDB upgrade that keeps the plan keeps the
fixture. Five invariants are measured with DuckDB's EXPLAIN ANALYZE, where a skeleton cannot show the gain: a 100-row
page by a column reads at most 6 of the 9 row groups in each scan (1–3 measured; loose, since the count is how many
threads claimed a row group before the top N's bound reached the scan), a LEFT lateral preview of json rows under a
LIMIT at most a tenth of the base's rows. Four more are counted by the executor's function counter, in the ROWS each
call is handed (`functionRows`; the calls are DuckDB's chunks, whose number its partitioning decides: a count's 128 was
its radix partitions, 2^7): a count over a LEFT lateral of `jsonb_each` and of `json_each` hands the function each
distinct document once (240,001 rows measured: the 240,000 documents and the NULL, never the million), and the lateral
sorted by a table column under a LIMIT, plainly and in the nulls idiom, at most two row groups' rows (16,960 measured).

**Why.** The oracle holds every answer to Postgres's and is blind to the plan. On 2026-10-28 three regressions of the
rewrite were found only by a BI tool's slow statements on the test server, each with every answer right: a LEFT JOIN
LATERAL of json rows planned as a delimiter join under a LIMIT (37.9 s for a 100-row page), an expression sort key that
stopped DuckDB's top N pruning the scan (6.4 s and 91 s), date_trunc of a timestamptz through ICU's calendar (7.9 s over
197 M rows). Rewritten in PR #13, nothing held their plans: a change turning the streaming UNNEST back into a delimiter
join, or the bare key back into an expression, passed every test. With `src/` at 3ad6493 (main before PR #13) the
fixture fails 12 statements by name — the three LEFT lateral previews, the three nulls-idiom pages, two BI shapes with
a LEFT lateral, three date_trunc histograms and the BI shape whose window orders by date_trunc (the SQL sent called
`date_trunc` alone, where now it is the instant's arithmetic under a CASE on the zone; a day in a zone of its own is
DuckDB's truncation of a local time before and after) — and the invariants measure what the plans cost: the idiom's
page read 9 of 9 row groups (1,000,000 rows) in its top N's scan, against 1 of 9 (16,960 rows) by created_at and 3 of 9 (262,720) by shipped_at with the
rewrite; the lateral preview read all 1,000,000 rows of its base, against 18,432 on a laptop's nine threads (a
2,048-row vector each; 2,048 on one thread).

**What it found, and what it cannot see.** DuckDB 2.0 plans a delimiter join without the name: the outer rows as a
CTE named `__duckdb_delim_<n>`, the lateral over a HASH_GROUP_BY of the CTE's scan (their distinct values), joined
back, no operator named DELIM — so a plan checked for `DELIM` alone passes the very plan that read all 1,000,000 rows;
the skeleton names that form a delimiter join too (`delimiterJoin`), and its tree is the guard either way.
A NULL in every row group defeats the top N's pruning even with one key (a timestamp NULL every ninth row, DESC NULLS
LAST: 9 of 9 row groups; the same column NULL only for its latest rows: 1–3, whatever the threads), and a text column
whose values spread over every row group is never pruned (9 of 9 either way): both are DuckDB's, and a page sorted by
such a column gains only the fetch of the winners' columns. DuckDB's EXPLAIN names a projection by its alias, so the
cost of an expression — ICU's date_trunc against the instant's arithmetic — is not in the operators (at 3ad6493 the
histogram's are the same); the skeleton reads it from the SQL sent, the time functions it calls, which is what
`truncInstant` changes.

**A jsonb's plans (2026-10-29).** Nothing held the plans of PRs #12 and #14 (jsonb's order, and that order stored),
and a BI tool's page by a jsonb took 17 s over 22 M rows computing the key per row. 17 statements now do — a page by a
jsonb DESC and ASC, the nulls idiom over one, a count per document, a DISTINCT, an equality with a document — each with
the key computed (over the shop) and with it stored, over two smaller copies (the orders alone, 245,760 rows in two row
groups: nothing these entries hold depends on the size, and they regenerated byte-identical from the million): one
whose keeper stored `meta`'s order key under C, one under a libc order (its page with the key computed, its page with
it stored, and its three equalities, which read the C key, computed per row whether or not the order key is stored: a
stored C key changes those three). A top N now says how many keys it sorts by (`TOP_N (1 key)`): a jsonb's key is
never a top N's filter, so the nulls idiom folded or not (nullsKeyFolded, which folds alike trees of any type) differs
by that count alone. With `src/` at b71bc3c (main before PR #12) all 17 fail by name, the computed ones on Mason's
refusal to order a jsonb, the stored ones on the keeper storing no order key; at cd74a4f (main before PR #14) the 10
that read a stored key fail and the 7 that compute it pass, PR #12's plans unchanged since; with the fold turned off,
the two jsonb idiom entries fail on `TOP_N (2 keys)`. Eight invariants count what the plans cost (the function counter
came with this fixture, so they prove nothing against those commits): the page by a jsonb with its key not stored
hands `__mason_jsonb_key` every row once and the 100 winners again (245,860 of 245,760 rows; 1,000,100 over the
million) — a NULL document's call included, the winners' where the late-materialized page sorts them — and each
statement over a stored key hands no function a row (an equality its constant's key, once), its top N's scan reading
the stored column and never the documents. What storing the key does not buy: DuckDB 2.0 pushes no top N's filter into
a scan of the BLOB column through the exact read's CASE (the mark's check; the entries hold it), nor — measured once on
DuckDB 2.0 on 2026-10-29, held by no test — with the bare column sorted (9 of 9 row groups, 1,000,000 rows); and in this
shop a jsonb's order is spread over the row groups like a text column's (`meta` cycles with the id), so no zone map
would skip one anyway, where a table whose documents follow insertion time could. The gain is the calls ("The key
stored" below: 19.2–26.1 s by the function against 0.13–0.31 s from the stored key, 20 M rows under C).

**A count of distinct keys (2026-10-29).** Eleven statements (`KEY_COUNTS`, over the shop, its customers' email
declared UNIQUE, and a composite-keyed `order_tags` beside it): `count(DISTINCT id)` of the orders alone, grouped by a
dimension LEFT or INNER joined on its primary key, with a FILTER — each sent as `count(id)` and planned with one
aggregate (none for the ungrouped count, answered from DuckDB's statistics) — and the contrasts that keep their
DISTINCT and their two aggregates: a join on a non-key, a LATERAL `jsonb_each` beside it, a column that is no key, a
derived table, a composite key's column, and a UNIQUE column that is not the primary key, counted and joined on. An invariant holds
both the SQL sent and the number of aggregates for each, so a rewrite that drops a DISTINCT too far fails as surely as
one that loses it ("A count of distinct keys" below).
**Where.** `tests/duck-plans.test.ts`, `tests/fixtures/duck-plans.json`.

### EXPLAIN

**Decision.** Postgres's shape, DuckDB's plan inside. An EXPLAIN is the statement it explains: options read in Postgres's
words, then the statement planned and refused as it would be alone (`EXPLAIN ANALYZE DELETE` is the DELETE's 25006). A
`QUERY PLAN` text column or Postgres's JSON; a first line says which copy answered, what DuckDB was sent and what Mason
computed after. ANALYZE runs the statement as any statement runs, DuckDB's profiler timing each operator. Operators keep
DuckDB's names (`Table Scan`, not `Seq Scan`, which sends a reader looking for an index); time is `thread time=`
(`Engine Thread Time` in JSON), never `actual time=`; FORMAT XML / YAML and GENERIC_PLAN are refused (`explain-option`).

**Why.** EXPLAIN was the review's critical finding, so it is built over plans. DuckDB's operator time is THREAD time
summed over threads: a parallel scan's exceeds the Execution Time, which a reader of `actual time` takes for elapsed.
The profile is the statement's because it is checked to be (2026-10-28): DuckDB's profiler writes one file, the last
profiled statement's on the connection, and Mason turned it on before the settle's probe of the schemas. A count(*) of a
whole table writes no profile (DuckDB answers it from the table's row count while planning, a lone `COLUMN_DATA_SCAN`),
so on a real deployment `EXPLAIN (ANALYZE) SELECT count(*)` of a 197 M-row copy answered the probe's plan, "reading none
of its copies", while a GROUP BY over the same copy answered its own. Now the profiler is on for the statement alone, the
profile must name it (`query.sql`), and a statement with none is said so, its plan DuckDB's EXPLAIN with the rows it
answered and no times. How each copy is kept current is the sync's one fact (`KeptCurrent`, `Sync.state`), the one
`mason status` reads (2026-10-29): EXPLAIN read the poll's ledger (`_mason.poll_state`) instead, and on a deployment
streaming by logical replication since 2026-10-27 its first line said "kept current by polling, last poll" two days
old, the poll before the switch, while status said streamed. Now the listener hands the sync's state to the EXPLAIN, and
a table no sync knows is said unknown, never guessed.
**Where.** `src/api/postgres/explain.ts`, `src/duck/explain.ts` (`keptText`), `src/duck/sync.ts` (`keptOf`);
`tests/duck-explain-options.test.ts`, `tests/duck-wire.test.ts`, `tests/duck-sync-added.test.ts`.

### jsonb's order

**Decision.** A jsonb is compared through a byte key (`src/duck/jsonb-order.ts`) that encodes Postgres's
`compareJsonbContainers`: the type first (null < string < number < boolean < array < object), an array or object by its
count then its members, an object's pairs in jsonb's storage order (shorter key first), a number by value with its scale
dropped, a string by the collation's key of it. A top-level scalar is a one-element array marked raw, so `[] < 1 < [1]`
and every scalar sorts before every object. Equality is the same key, so `'1.0' = '1.00'`; GROUP BY and DISTINCT write
one group as one of its values (`jsonb-equal-text`). `json` has no order in Postgres (42883), and Mason answers it so.

**Why.** A BI tool sorts by any column it shows (Trevor.io: `ORDER BY j IS NULL, j DESC LIMIT 100` over a jsonb), and
the refusal broke a table view. The canonical text alone is not the order (`10 < 9` as text, objects by size first) nor
the equality (`1.0` and `1.00` are one value), so the key is its own function, held to PGlite and to the oracle under
each collation kind. Keying ORDER BY found that the allowlist never saw a sort's or a group's operator: IS DISTINCT
FROM, NULLIF, CASE x WHEN, PARTITION BY, = ANY, INTERSECT, ROLLUP, BETWEEN and JOIN USING over jsonb had been answered
by DuckDB's text equality. Each is now keyed or refused.

**Where.** `src/duck/jsonb-order.ts`, `jsonbKey` in `src/duck/rewrite.ts`; `tests/duck-jsonb-order.test.ts`, the oracle's
`jorder` (tests/integration/oracle/type-matrix.ts).

#### The key stored (2026-10-28)

**Decision.** The key is a stored read of the keeper ("Stored JSON paths"): a BLOB hidden column per jsonb column and
collation, recorded, weighed, filled and kept current exactly as a path is, and read by the rewrite once ready.

**Why.** Measured on a laptop (10 cores, NVMe, the file in the page cache) over 20 M synthetic rows of mixed shapes
(objects of four keys with a nested array, arrays of strings, raw numbers and strings, nested arrays, NULLs), the
Trevor.io shape `SELECT e.id … ORDER BY e.j IS NULL, e.j DESC LIMIT 100` through the listener:

| | C | libc (en_US.utf8) |
|---|---|---|
| by the key's function, per row | 19.2–26.1 s wall, 20–27 s CPU | 83–126 s wall, 90–132 s CPU |
| filling the stored key (the keeper's chunks) | 20.8 s | 93.1 s |
| from the stored key | 0.13–0.31 s wall, ~1 s CPU | 0.13–0.14 s wall, ~1.2 s CPU |
| `GROUP BY j` from the stored key | 0.40–0.68 s | 0.62–1.21 s |

A sort by the function is a call per row, and a call per row holds the executor worker for the whole statement
("The executor worker"); a fill costs what one or four such sorts cost, and every later one is free. A key is its
collation's (a string's key is ICU's or the measured libc order's), so it is stored under the collation's id and
dropped when the source's collation, or its glibc's measured order, changes — and with the key's encoding
(`KEY_VERSION`) and the DuckDB whose ICU made its strings' keys (`DUCKDB_VERSION`) in the id, an upgrade that changes
either stores it again rather than reading another release's bytes. The fill model (`FILL_US_PER_ROW`, made for
paths) prices a key's fill at 13 µs a row where it measured 1.0 (C) to 4.7 (libc): a large table's key waits longer
for its evidence than it must, the safe side, until the rate of a key's fill of that column is measured (a path's
fill is another function's, and its rate is never read for a key's).

**Equality under libc is the C key.** The `GROUP BY j` row above is C's and ICU's: under a libc collation an
equality (GROUP BY, DISTINCT, =, PARTITION BY) reads the C key (stored as a column of its own since 2026-10-29,
below), because the order's stored key is the libc order's, which refuses a string holding a character the measured
order does not cover where equality needs no order at all (the review found the first form keying equality by the
collation, and refusing).

**A mark written after the count (the review, 2026-10-28).** The stream and the poll write a libc-uncovered document
(an NFD `café`, e + U+0301) at any time, and its key is the mark; the plans read the key alone until the detector
counts the marks (a minute), so the mark sorted first as a key. Rather than every write path counting its marks before
it commits, the exact read raises at a mark from the column alone (one comparison a row, no document read): the
statement is refused by the gap's name, as the statement's own key refuses it, until the reads turn to the CASE.

**What it does not cover.** A statement that lists a copy's columns without naming them (`SELECT * … ORDER BY j`)
reads no stored column at all (`hideKept`), so its sort is the function's: 23.2 s (C) and 84.3 s (libc) on the same
rows.

#### Under libc, the C key stored for equality (2026-10-29)

**Decision.** Under a libc collation the C key is a second stored read beside the order's (`EQUAL_STEPS`,
src/duck/kept-route.ts), stored as `equal:` and the C order's id (`equalId`: `KEY_VERSION` and `DUCKDB_VERSION`, never
the libc order, which the C key does not read). GROUP BY, DISTINCT, count(DISTINCT), PARTITION BY, =, IN and a join on
`=` record it (`equalKey`), and it is weighed, filled, swept, marked, dropped and read exactly as the order's key. It
marks no libc-uncovered string (the C key covers every string), so its mark is a Mason bug, never the gap. Under C and
ICU the order's key equates, so an equality read is the order's (`own`) and a C key is dropped at `orderBy`: one column
serves both there, never two.

**Why.** Measured on a laptop (10 cores, NVMe, the file in the page cache, the machine shared with other work: load
average 9–18, so the wall times are high and the CPU times the steadier figure) over 20 M synthetic rows of four shapes
(objects of three keys with an array, arrays of four members, numbers, strings; 500 values each, 2,000 distinct, and a
sixth NULL), under en_US.utf8 (the libc container), through the rewrite's plan and the keeper:

| | by the C key's function, per row | from the stored C key |
|---|---|---|
| `SELECT j, count(*), min(id) … GROUP BY j ORDER BY 3 LIMIT 10` | 34–77 s wall, 32–45 s CPU | 0.15–0.23 s wall, ~1.1 s CPU |
| `SELECT DISTINCT j` | 26–53 s wall, 27–39 s CPU | 0.14–0.19 s wall, ~1.0 s CPU |
| `SELECT count(DISTINCT j)` | 21–22 s wall, 23–24 s CPU | 0.09–0.11 s wall, ~0.6 s CPU |

(Two runs each, of two processes; the very first computed GROUP BY after the build took 188 s wall for the same 45 s
of CPU, the machine's other work, and is left out.) The fill (the keeper's chunks of 50,000 rows) took 29 s, 1.4 µs a
row: about one computed GROUP BY, once. Each answer from the stored key equalled the computed one.

A source whose collation turns from libc to C drops the C key at `orderBy` and fills the order's key, whose bytes are
the same C key's: one fill wasted, once, at a change that is rare; accepted rather than a rename of the column.

**Rolling back past it (the review, 2026-10-29).** The release before this one does not know a `equal:…` row, and
`mason destroy` (then a copy again under that release) is the only way back to it: its `mason status` and `mason wait`
throw parsing the row's steps as a JSON path (`pathText`), even once `MASON_STORE_JSON_PATHS=off` has marked the row
dropped, and its review stores the request log's `equal` reads as a path whose every write raises. So, as the class
fix, a kind a Mason does not know is inert from this release on (`knownSteps`, src/duck/kept-route.ts): its request
log reads are not counted (`readOfKey`), its ledger row is dropped at the start with its column (`open`), and
`mason status` says it raw (`pathText`) — a later release's new kind is never fatal to this one.

### What DuckDB is sent: the form it computes fastest, where that is Postgres's answer

Three shapes BI tools send on every chart and preview were each the slow path of DuckDB's, and two of them were also
not Postgres's answer. Each is now written in the form DuckDB computes natively, held to Postgres by the oracle (the
new statements in `oracle/type-matrix.ts`, in five session zones) and by `tests/duck-wire.test.ts`. A fourth, a
count of distinct keys, came later (below).

#### date_trunc of a timestamptz

**Decision.** `date_trunc(part, timestamptz)` in the session's zone, and `date_trunc(part, timestamptz, zone)`, are the
instant's own arithmetic where that is Postgres's `timestamptz_trunc_internal` (`truncInstant`, `src/duck/rewrite.ts`):
the instant's microseconds (`epoch_us`) floored and made an instant again (`make_timestamptz`), never ICU's calendar.
Postgres truncates the wall clock in the zone and, from a day up, reads the truncated wall clock back in it (`redotz`);
below a day it keeps the instant's own offset. So: milliseconds and seconds floored in every zone (offsets are whole
seconds); minutes and hours floored in UTC, elsewhere the instant less the wall clock's remainder (one zone conversion);
day and week (Monday's) floored in UTC, month and up the naive calendar of the UTC wall clock (`make_timestamp`); a day
and up in another zone stays DuckDB's own `date_trunc` in the session's zone (the three-argument form's wall clock
there, read back), whose zone lookup no form here makes cheaper. ±infinity is itself, NULL NULL. The session's zone is
the one the statement EXECUTES in, read by `current_setting('TimeZone')` under a CASE on UTC's names (`UTC_NAMES`,
`src/lib/timezone.ts`), never the zone it was planned in: a prepared statement is planned at its Parse and run after any
later `SET TimeZone`, so a plan that baked in the Parse's zone truncated by UTC's days in Berlin. DuckDB folds the
CASE to one branch when it plans what it runs (the histogram's times below are unchanged by it). The three-argument
form is strict and reads its zone first: a zone that is not a constant name (a row's, a NULL) is read by `__mason_zone`
under `CASE WHEN zone IS NULL THEN NULL`, whatever the part, since a second or less never names the zone in its
arithmetic (a review finding: a NULL zone answered the instant, a row's unknown zone no error).

**Why.** On the test server a BI tool's monthly histogram (`DATE_TRUNC('month', t.ts) … GROUP BY 1 ORDER BY 1
DESC LIMIT 100`) over 197 M rows took 7.9 s, every core busy and the disk idle: the Projection holding `date_trunc` took
41.8 s of thread time against the scan's 13.1 (~150 ns a row a thread), and 799 statements of its request log carried a
DATE_TRUNC (median 2.5 s). DuckDB's `date_trunc` of a TIMESTAMPTZ is the ICU extension's calendar for every row, in UTC
too. And it was not Postgres's: below a day ICU re-reads the truncated wall clock, so 02:30 CEST on 2026-10-25 (the first
of the repeated hour) was truncated to 02:00 **+01**, an hour after the instant, where Postgres answers 02:00 +02 (New
York's 2026-11-01 alike); the three-argument form's centuries began in a year 0 (2000-01-01 for 2001-01-01). The oracle's
new statements met both on main (9 of them, in each of the three phases) and none now.

Measured on a laptop, DuckDB alone, 20 M timestamptz rows over two years, one thread, `sum(epoch_us(<form>))` (best of
five, ns a row; the bare column ~1.4):

| form | hour | day | week | month | year |
|---|---|---|---|---|---|
| (a) `date_trunc(p, ts)`, TimeZone UTC (ICU) | 42 | 43 | 64 | 46 | 48 |
| (b) `date_trunc(p, ts::TIMESTAMP)::TIMESTAMPTZ` (UTC only) | 85 | 87 | — | 93 | — |
| (c) `timezone(z, date_trunc(p, timezone(z, ts)))`, UTC | 72 | 73 | 97 | 79 | 80 |
| (d) `time_bucket(INTERVAL '1 p', ts)` | 22 | 244 | — | 976 | — |
| **the instant's arithmetic, UTC** (with the infinity CASE) | **8.0** | **8.5** | **8.2** | **12.6** | **10.7** |
| (a) in Europe/Berlin | 67 | 78 | 77 | 74 | 77 |
| (c) in Europe/Berlin | 99 | 99 | 101 | 103 | 112 |
| **the offset kept, Europe/Berlin** (one `timezone(z, ts)`) | **56** | — | — | — | — |

A cast between TIMESTAMP and TIMESTAMPTZ is itself ICU's (~40 ns: `timezone(z, ts)` costs that in UTC too), which is why
(b) and (c) are slower than (a); `time_bucket` with a zone argument was slower still (272–414 ns). Through Mason (the
listener and a client, the laptop's 10 cores, the histogram above over 50 M rows of a 3.8 GiB copy, best of three, ms):

| part | UTC, main | UTC, now | Europe/Berlin, main | Europe/Berlin, now |
|---|---|---|---|---|
| month | 528 | 156 | 743 | 659 (DuckDB's own) |
| day | 455 | 104 | 686 | 630 (DuckDB's own) |
| hour | 439 | 94 | 672 | 500 (the offset kept) |
| week | 513 | 92 | 762 | 686 (DuckDB's own) |
| year | 475 | 108 | 666 | 615 (DuckDB's own) |

The laptop's ICU call is ~45 ns where the test server's was ~150, so the test server's 7.9 s histogram should fall about
as far; not measured there yet.

#### A LEFT lateral of a list

**Decision.** `FROM base LEFT JOIN <the rows of a list> ON TRUE` — `json_each`, `jsonb_each`, their `_text`,
`json(b)_array_elements(_text)`, `json(b)_object_keys`, and `unnest` of an array (a column, or any expression computed
once: "An unnest of an expression, an argument of two columns" below) — WHERE ITS ROWS' ORDER DECIDES
THE ANSWER is an INNER lateral over a list that is never empty: the rows, or one NULL where there are none
(`leftLateral`; the functions' `orNull` argument, `src/duck/functions.ts`). The join must be LEFT, ON a literal TRUE, one
such function on its right, no ORDINALITY; and it must be bounded (`markBounds`, `limitBounds`):
- a LIMIT or an OFFSET keeps the first of its rows: the SELECT that holds the join has one, or a SELECT reading it as a
  derived table, a CTE or an arm of its UNION ALL does, with no aggregate, GROUP BY, DISTINCT, window or other set
  operation between. Under an ORDER BY only a LIMIT of its own bounds (an OFFSET alone does not; WITH TIES never, Mason
  ranks every row for it), and only when its first key, the nulls idiom folded, is a column of a table sorted bare — not
  a text under a collation, a citext, a char(n) or a jsonb, each sorted by an expression no top N filter reaches the
  scan by. An OFFSET alone with no ORDER BY is bounded for the answer's sake (Postgres's rows after it) and streams
  every row it does not skip; a CTE read twice or MATERIALIZED is computed whole, a call a row;
- or an aggregate that reads its rows in order (`string_agg`, `array_agg`, `json_agg`, `json_object_agg` …) has no
  ORDER BY of its own, or a window function that reads its frame in order (`row_number`, `lag`, `first_value` …) has a
  window with no ORDER BY: Postgres hands each base row's members to it in their order.

Everywhere else — a count, a GROUP BY, a DISTINCT, a window, a whole result, a sort by the lateral's own column —
DuckDB's own plan stays, as do an INNER lateral, a condition and another function. The bound is decided in a pre-pass
over the whole statement before the walk: libpg-query writes a SELECT's keys in its struct's order (its FROM before its
WITH, a UNION's arms last), so the walk meets a CTE before the SELECT that reads it. (2026-10-29; until then every such
join was rewritten, whatever stood above it.)

**Why.** On the test server a BI tool's "expand the JSON" preview (`SELECT q.*, d.key, d.value FROM (SELECT …) q LEFT
JOIN json_each(CASE … END) d ON TRUE LIMIT 100 OFFSET 0`) over 22 M rows took 37.9 s, its `count(*)` cut off at 16 s.
DuckDB plans a LEFT lateral as a delimiter join — the whole base grouped by the function's argument (a Hash Group By of
22 M rows), the function called for each, a hash join back — under a LIMIT that applies after all of it; an INNER lateral
of an unnested list is its UNNEST operator, streaming, in the base's order, the members in theirs. The delimiter join
also handed its rows back in an order of its own, so the LIMIT kept OTHER rows than Postgres, which walks the base and
each row's members in order: the oracle's new limited statements differed on main (11 of them: `"key": "nested" where Postgres has
"event"`) and agree now. A `LIMIT n + m` pushed into the base instead would have kept the
delimiter join over those rows and its order, so still not Postgres's rows. A row the LIMIT leaves out is still read in
its chunk (2,048 rows): a document there Postgres would never reach and the function refuses raises here, as it did.

DuckDB 2.0's own `json_each` / `json_tree` (table functions) keep a document's key order and a key held twice, but are no
stand-in yet: a value is DuckDB's re-serialisation (`1.50` is `1.5`, `[1, 2]` is `[1,2]`, where Postgres's json keeps
the text and jsonb prints its own), an array is read as members by index (Postgres refuses it), and jsonb's key order
(by length, then bytes) is not theirs. Standing in would take the native read for keys and string, boolean and null
values (as `->>` is), the function for the rest, a per-row order for jsonb and Postgres's refusal of a non-object: a
second change, held by the oracle on every shape in the registry. And it is not what is slow: DuckDB's own `json_each`
in a LEFT lateral is the same delimiter join (10.9 s for the 100-row preview below), and its INNER count took 17.7 s
against Mason's 16.9.

Measured through Mason on the laptop (10 cores), 5 M rows of ~150-byte JSON documents (a NULL every 13th, an array
every 17th), best of three:

| statement | main | now |
|---|---|---|
| the preview, `LEFT JOIN json_each(CASE …) d ON TRUE LIMIT 100 OFFSET 0` | 16.6 s | 84 ms |
| the same, `LIMIT 100 OFFSET 1000` | 17.0 s | 71 ms |
| the same `ORDER BY d.key, q.id LIMIT 100` (every row's members sorted) | 18.0 s | 16.7 s |
| its `count(*)` (every row's members counted) | 17.9 s | 16.9 s |
| an INNER lateral, `LIMIT 100` (already DuckDB's UNNEST) | 62 ms | 71–112 ms |

What reads every row still calls the two functions for every document (~3.4 µs a row), and stays slow: that is the
executor worker's cost ("The executor worker"), and the stored JSON paths' remedy does not reach a document's members.

**Why only under a LIMIT (2026-10-29).** The measurement above had nearly every document distinct, where the delimiter
join saves nothing: it calls the function once per DISTINCT argument, the UNNEST once per row. On the test server the
same preview's row count — `SELECT count(*) FROM (SELECT … FROM base LEFT JOIN LATERAL json_each(base.doc) d ON TRUE)
sub`, a 22 M-row table whose json column holds a few thousand distinct documents — went from 79 s to over 200 s
(cut off) with the rewrite: `Ungrouped Aggregate > Projection > Unnest > Table Scan (22,405,332 rows)`, two JavaScript
calls per base row. The streaming plan wins only where a LIMIT stops it early, which is also the only place its order
(Postgres's) changes an answer; under an aggregate, a GROUP BY, a DISTINCT or a window every row is read either way,
and each hands back an order of its own. An ORDER BY … LIMIT reads every row too unless its first key is a column of
a table: DuckDB's top N then pushes its bound into that table's scan as a filter, and the rows reaching the UNNEST are
few — measured below, the streamed plan's worst case there is seconds where the delimiter join's is a hundred.
Bounding too much costs time, never an answer (the streamed lateral is Postgres's rows in Postgres's order);
bounding too little keeps the delimiter join under a LIMIT, whose rows are not Postgres's, so a LIMIT passes down
through a derived table, a CTE and a UNION ALL's arms. The same holds where no LIMIT does: an aggregate or a window
that reads its rows in order with no ORDER BY of its own (`string_agg(d.key, ',')`, `row_number() OVER ()`) took the
delimiter join's order on the first version of this change, and differed from Postgres in the oracle, so it is
bounded too.

Measured through Mason's listener on the laptop (10 cores), two 20 M-row tables, a `json` column of five-key objects:
one with 2,000 distinct documents, one with every document distinct; `json_each(q.doc)` in a `LEFT JOIN LATERAL … ON
TRUE`; each statement once (the fast ones best of three), *streamed* the rewrite everywhere (main), *joined* DuckDB's
delimiter join everywhere (before PR #13), *now* the gate:

| statement | 2,000 docs: streamed | joined | now | all distinct: streamed | joined | now |
|---|---|---|---|---|---|---|
| `count(*)` over the lateral | 62.5 s | 2.2 s | 2.7 s | 88.0 s | 117.6 s | 123.4 s |
| `GROUP BY d.key` | 137.0 s | 0.26 s | 0.58 s | 85.4 s | 92.9 s | 75.5 s |
| `ORDER BY d.key, q.id LIMIT 100` (the lateral's column) | 62.9 s | 0.85 s | 0.73 s | 76.2 s | 89.9 s | 79.1 s |
| the preview, `LIMIT 100` | 0.06 s | 1.68 s | 0.10 s | 0.06 s | 164.6 s | 0.52 s |
| the preview in a derived table, `LIMIT 100` outside | 0.08 s | 1.24 s | 0.12 s | 0.12 s | 93.0 s | 0.18 s |
| `ORDER BY q.id DESC LIMIT 100` (in heap order) | 0.18 s | 0.66 s | 0.29 s | 0.11 s | 105.8 s | 0.34 s |
| the same over a derived table `(SELECT t.id, t.doc FROM …) q` | 0.19 s | 0.41 s | 0.37 s | 0.21 s | 85.4 s | 0.23 s |
| `ORDER BY q.v DESC LIMIT 100` (a column of 1,000 values in every row group) | 3.6 s | 0.51 s | 6.3 s | 4.7 s | 91.9 s | 5.6 s |

The gate takes the faster plan in every row but two: a count (or any full read) over nearly distinct documents, where
the streamed plan is about a third faster (88 s against 118–123 s) — against 28 times slower over few distinct ones —
and an ORDER BY a table's column whose zone maps prune nothing, over few distinct documents (3.6–6.3 s streamed, 0.5 s
joined) — against 92 s joined over distinct ones. Which way a table's documents lean is not known when the statement is
planned, so each side takes the plan whose worst case is the smaller loss: a full read joined is at most about 1.4
times the streamed one and up to 500 times faster; a page sorted by a table's column streamed is seconds at worst,
where joined it is minutes. (The repeated rows vary run to run by
about 2×; a `now` column against its `streamed` or `joined` twin is the same plan.)

**A row count on the wire (2026-10-29).** A row limit set on the wire — the extended protocol's Execute with a row
count, as a JDBC driver's `setMaxRows` or fetch size, DBeaver or a native question sends it — with no LIMIT in the SQL
is a bound the plan made at Parse cannot see: until then such a statement kept the delimiter join, every row computed
before the first was sent and the first rows DuckDB's order (`row-limit-on-the-wire`, registered by PR #19). Now the
rewrite says, on the plan, where a LEFT lateral of a list was left DuckDB's join that such a bound would stream
(`PlannedSql.unboundedLateral`: the bounds computed twice in the pre-pass, the second time with the outermost SELECT
bounded as a SELECT read by a LIMIT is — `markBounds(root, wire)`, the same `limitBounds`), and the listener's first
Execute with a row count of a portal over such a plan plans the statement again with the bound asserted
(`Session.boundOnWire`, `planDuck`'s `wireBound`), under the search_path and TimeZone of its Parse. That plan is kept
on the prepared statement and in the plans by text (its key holds the bound), so a repeated Execute plans nothing. A
portal's result is begun once, by its first Execute, from whichever plan that Execute picked; an Execute after a
PortalSuspended reads on from the same result, never runs it again, and an Execute with no row count streams the rest.

What is not planned again: a statement whose SQL bounds the lateral already (a LIMIT, an OFFSET, an order-sensitive
aggregate), and one where every row is read whatever the client reads — an aggregate, a GROUP BY, a DISTINCT, a window,
a set operation other than UNION ALL — and an ORDER BY: a row count on the wire is no LIMIT DuckDB sees, so no top N
pushes it into the scan and DuckDB sorts every row first whichever plan it is given (where the delimiter join is the
cheaper). A plan made again over a schema moved since the Parse whose parameters or result columns are not the Parse's
is not run (the Parse's is: the client was told that result; the log says so), and so is one Postgres or the rewrite
refuses (the Parse answered; a row count must not fail it). A plan is made over the catalog of the schema it is kept
under wherever it is made — the catalog is replaced in `Server.duckPlan`, not only at a statement's classify: a
re-plan at an Execute that was the first statement after the copied tables moved analysed against the old catalog and
was kept under the new schema, for every session to read (a review finding). Planning again is the statement's own
time: a CancelRequest or the statement_timeout landing meanwhile is answered 57014 as for any statement (until the
review it was lost there: the controller was not yet the session's `running`). EXPLAIN explains the statement's own plan, the one an
Execute with no row count runs. (`tests/duck-wire.test.ts` "an Execute's row count over a LEFT lateral"; the oracle has
no portal shape: it sends every statement whole, so a row count on the wire is held there alone.)

The cost, not measured: a client that reads a WHOLE result through repeated Executes with a row count (JDBC's fetch
size with autocommit off, a node cursor, an export) now takes the streamed plan, which calls the function once per row
where the delimiter join calls it once per distinct document — the trade the measurements above make against a full
read (2.2 s joined against 62.5 s streamed for a count over 20 M rows of 2,000 documents). The row count says the
client may stop early, never that it will; a page's first rows being Postgres's, and sent as soon as they are read, is
what the bound buys, as a LIMIT's does. Measure a fetch-size export over few distinct documents before tuning this.

What DuckDB does on its own: it plans the streamed `CROSS JOIN LATERAL (SELECT unnest(…))` as a delimiter join again
when a filter sits above it that it does not push down to the base — a WHERE on the lateral's own column, one holding a
bound parameter in a SELECT around the join, one in a SELECT that reads the join through a CTE — and the LIMIT then
keeps its rows, not Postgres's (`limit-lateral-filter`, a decided difference, each form held by the oracle; a filter on
the base in the join's own SELECT, or a literal one through a derived table, stays the UNNEST). And a window function
over PARTITION BY with no ORDER BY numbers a partition's rows in DuckDB's partitioning's order, streamed or not
(`window-partition-order`). Main sent the same SQL for each of these.

**An unnest of an expression, an argument of two columns (2026-10-29).** Until then only an unnest of an array COLUMN
was streamed: its never-empty form names the list twice (`CASE WHEN len(l) > 0 THEN l ELSE [NULL] END`), which costs a
column nothing, and an expression there was left DuckDB's delimiter join — under a LIMIT or a row count on the wire,
rows in an order of its own and no registry entry: `SELECT o.id, x FROM orders o LEFT JOIN LATERAL unnest(ARRAY[o.id,
o.id*10]) x ON true LIMIT 1` answered `(1,10)` where Postgres answers `(1,1)` (a review of PR #27, on a real listener;
on main, sixteen of the oracle's new statements differ, measured by fails-without: fourteen unregistered, two of
them json rows, and two that stay registered below). Now an unnest of any expression streams, the expression
computed ONCE: by a step of its own before the lateral, `CROSS JOIN LATERAL (SELECT e AS __mason_arg<n>) AS __mason_arg<n>`, which
DuckDB plans as a projection under the same UNNEST, the CASE naming the step's column twice at no cost but the
expression's; or, where the step is no form (below), inside the lateral as the one element of a list whose lambda names
it twice, `list_transform(list_value(e), l -> CASE … l … END)[1]`, a copy of the list a row more. Named twice, Mason's
string_to_array (a JavaScript function) would be handed every row twice — the plan fixture holds it at the million
rows once, in both forms.

Making it stream showed what decides DuckDB 2.0's plan of the streamed lateral: the columns of the row its list reads.
One column, or any array column among them, is its UNNEST; two or more and no array is its delimiter join again, in
every spelling — so a json function's argument of two columns (`jsonb_each(CASE WHEN q.id > 0 AND jsonb_typeof(q.jb) =
'object' THEN q.jb END)`) had kept DuckDB's order on main too, unregistered. Such an argument, of any of the list
functions, is computed by the same step now, the lateral reading its one column. The step is no form for every
argument: DuckDB plans it as a delimiter join once it reads an array column (`array_append(tags, …)`, `tags[2:]`, even
`[len(tags)]`), where the lateral without it streams; a `*` of the SELECT that holds the join, or a join's own name,
reads its column; and an argument holding a subquery is a delimiter join in every form (a correlated `FROM (SELECT e AS
l)`, a CTE and VALUES too). The last two are registered (`limit-lateral-argument`). Which forms DuckDB 2.0 streams, by what the list reads (EXPLAIN
over 10,000 rows):

| the argument reads | the lateral as it is | a step of its own before it |
|---|---|---|
| one column (`[a, a * 10]`, `[s, upper(s)]`, a json column's path) | streamed | streamed |
| two or more columns (`[a, b]`, a json path and a column, a struct's field and a column) | delimiter join | streamed |
| an array column, alone or with others (`list_append(l1, a)`, `[len(l1), len(l2)]`) | streamed | delimiter join |
| a subquery (`ARRAY(SELECT …)`, a scalar subquery) | delimiter join | delimiter join |

Measured on the laptop (10 cores), DuckDB alone over 1 M rows (a NULL list every 7th, an empty one every 7th, else 3
integers), every row streamed (an OFFSET past the end), best of three:

| list | bare (INNER, no padding) | the CASE, named twice | `list_transform`, named once | a step of its own |
|---|---|---|---|---|
| the column `t.arr` (main's form: the CASE) | 7 ms | 9 ms | 25 ms | 85 ms, a delimiter join |
| `string_to_array(t.s, ',')`, the same lists | 32 ms | 59 ms | 55 ms | 37 ms |
| `ARRAY[t.id, t.id * 10]` | 7 ms | 12 ms | 19 ms | 8 ms |
| `list_reverse(t.arr)` | 16 ms | 28 ms | 33 ms | 77 ms, a delimiter join |

So the step costs nothing but the expression where DuckDB streams it (37 ms against string_to_array's own 32, 8 against
7), the list_transform a copy of the list a row over the bare expression (12–23 ms a million rows here, more for longer
lists: 24 elements cost 88 ms), and the CASE named twice the expression's own time again; a column keeps the CASE.

The review of PR #28 found three things the first round missed. An argument reading an enum beside another column got
no step (the count of columns refused every user type but citext, where only a user type's ARRAY is a list to DuckDB):
a scalar enum, a domain, citext is now a column like any other. An argument that raises in a row the LIMIT leaves out
(`(CASE WHEN id = 10 THEN 'x' END)::int`, jsonb_each of an array document) raises in Mason: DuckDB computes the
argument a vector of rows at a time, where Postgres stops at the LIMIT — registered under `limit-errors`, as the
select list's case was. And ARRAY(SELECT …), which the oracle's statements had verified as a whole, answers as
Postgres's only for a scalar element: a numeric is DuckDB's double where Postgres's numeric[] is exact; an array
element is a list of lists where Postgres accumulates a multi-dimensional array (and raises 2202E on an empty element,
22004 on a NULL one); a row is a struct where Postgres's is a record[]; and `x = ANY (ARRAY(SELECT …))` was DuckDB's
binder error (42804). Each is refused by name (`array-subquery-element`), decided by the element's type in the
analysis (an array's subscript, which has no offset of its own, by the array's), and a type the analysis does not say
is refused too.

#### Nulls placed by a key of their own

**Decision.** A pair of consecutive sort keys `<e> IS [NOT] NULL` then the same `<e>` (the same tree: parentheses are no
node of it) is ONE key on `<e>` with the second key's direction and the nulls where the first put them: `IS NULL ASC`
and `IS NOT NULL DESC` last, `IS NULL DESC` and `IS NOT NULL ASC` first (`nullsKeyFolded`, a canonicalisation of
equivalent order keys). Every other key stays in place; never under a DISTINCT ON, and never a window's ORDER BY.
The two keys must also be READ alike (`bareKeyIsInput`): Postgres reads a bare ORDER BY key by the SQL92 rule
(findTargetlistEntrySQL92), an integer as an output position and a one-part name as an output column's name, where the
same tree inside `IS NULL` is the constant or the input column. So `ORDER BY 2 IS NULL, 2` is never folded, nor `SELECT
coalesce(x, 0) AS x … ORDER BY x IS NULL, x` (sorted by the input's test, then the output's value: a review finding);
`SELECT x … ORDER BY x IS NULL, x` and `SELECT * …` are. An output column's name is Postgres's FigureColname, which
names a CASE by its ELSE where that name is strong (`CASE … ELSE x END` is `x`, Mason once named it `case`).

**Why.** It is how nulls-last is written in MySQL-compatible SQL, which has no NULLS LAST, so several tools emit it for
every sort of a nullable column: `ORDER BY (e.col) IS NULL ASC, e.col DESC`. With an expression as its first key,
DuckDB's top N cannot push its threshold (the current n-th value) into the scan, so it reads and heaps every row: on the
test server a 100-row page of a 197 M-row copy by a timestamp took 6.4 s, and by a nullable text id 91 s, until the tool
gave up. One plain key with its NULLS placed is pruned by the zone maps. Late materialisation (the top N over the key
and the row id, then the winners' columns) applies to both forms already: Mason sets `late_materialization_max_rows` to
10,000 (`INSTANCE_SETTINGS`; DuckDB's default is 50), so a page of 100 or 1,000 rows reads only the key column for the
sort and the page's rows for the rest; a page past 10,000 rows sorts every column, as before.

Measured on the laptop through Mason, a 40 M-row copy of 3.6 GiB (a nullable random text id, a nullable timestamp in
heap order, two ~330-byte JSON documents, 3 more columns) under a 1 GB memory limit, the file in the page cache, best
of three, ms; DuckDB's EXPLAIN ANALYZE of the statement sent:

| ORDER BY … LIMIT | main (the idiom as written) | now (one key) | row groups the key's scan read, main → now |
|---|---|---|---|
| `(w.ts) IS NULL ASC, w.ts DESC` LIMIT 100 | 61 | 5 | 326 → 8 of 326 |
| `(w.tid) IS NULL ASC, w.tid DESC` LIMIT 100 | 169 | 48 | 326 → 100 of 326 |
| the timestamp, LIMIT 1000 | 67 | 16 | 326 → 10 |
| the text id, LIMIT 1000 | 310 | 349 (noise: the folded key read every row group too) | 326 → 326 |

Without the LIMIT the plan is the same but for its sort key (`#7 ASC, tid DESC` against `tid DESC`). On a plain
DuckDB connection (late materialisation at its default 50) the text id's LIMIT 1000 took 2.8–3.0 s in either form: the
top N over every column. The test server's 91 s is that table read from its disk at ~125 MB/s: one key column (the late
fetch) and the row groups its threshold cannot skip are what remain, so a random text id gains what its zone maps
prune (a third here), a time column nearly everything; not measured there yet.

#### A count of distinct keys (2026-10-29)

**Decision.** `count(DISTINCT x)` is sent to DuckDB as `count(x)` (its FILTER kept) where no two of the rows it counts
can hold one value of x (`src/duck/distinct-key.ts`, applied in `funcCall`): x is a plain column that is, alone, its
table's PRIMARY KEY in the catalog Postgres — the source's primary key, the key the copy is written by (a table copied
by a sources file's `key:` declares none: a key Mason was told and only verified to hold a unique index's columns is
never trusted for this) — under the equality and collation the DISTINCT compares by (the key's btree family); and the
FROM repeats no row of x's table: it is that table, or a join tree whose every join on the way down to it joins ONE
base table (INNER, LEFT, RIGHT or FULL) on a conjunction holding an equality of the other table's PRIMARY KEY with a
bare column of x's side. Never a UNIQUE index that is not the primary key, in either role, though the catalog declares
those too (next paragraph). Each row of x's side then meets at most one row of the other, so it is in
at most one row of the join whatever the join's kind (one unmatched row is one row; a NULL-extended one counts no
value), and every other conjunct only filters. A comma join, a derived table, a CTE, a function (a LATERAL
`jsonb_each`), a join of joins on the other side, an OR at the condition's top, an expression on either side of the key
equality, a COLLATE other than the index's, an outer query's aggregate inside a subquery: the DISTINCT stays.
Postgres decides: every piece is read from the ANALYSED tree (each Var's range-table entry, the join's resolved
equality operator, the aggregate's DISTINCT operator) and from the catalog Postgres's own pg_index, asked only for a
statement holding a count(DISTINCT …), never matched by a column's name. An ORDER BY repeating the count in its own
SELECT is analysed as that target (no node of its own) and drops it with its twin, never with a twin in another SELECT.
Only count: `sum`, `avg`, `array_agg` and `string_agg` keep their DISTINCT (array_agg's also sorts).

**Why.** A BI tool's default "count of entities" measure is `count(DISTINCT t.id)` of the primary key. On a real
deployment a 197 M-row table LEFT JOINed to a 780-row dimension on the dimension's key and grouped by a dimension column
took 120 s: DuckDB 2.0 computes a count(DISTINCT) as an aggregate of its own over the groups and the value (a hash
group by of every id under the one that counts — two levels), which spilled 1.5 GB; the same statement with `count(t.id)`
took 9 s cold, about 2 s warm, with Postgres's answer identical. The plan fixture holds the shapes (two
`HASH_GROUP_BY`s for a count(DISTINCT), one for the count, none at all for an ungrouped count of a column with no NULL,
which DuckDB answers from its statistics while planning). Measured on a laptop (10 cores) on DuckDB 2.0 with Mason's
instance settings, the same file and data, one change per run: 20 M rows in heap order with a random uuid key, LEFT
JOIN a 780-row dimension on its key, GROUP BY the dimension's name, best of five:

| memory limit | `count(DISTINCT t.id)` | `count(t.id)` |
|---|---|---|
| 16 GiB (half the laptop, Mason's default) | 0.18 s | 0.05 s |
| 768 MiB (the real server's memory per row, scaled to 20 M rows) | 0.40 s | 0.06 s |

The gap widens as the distinct values outgrow the memory, which the server's 197 M uuids on a 15 GiB machine did by
far (the 1.5 GB spill); a laptop whose page cache holds the table never shows the server's 120 s.

**Why the primary key alone (the review of PR #25).** The first version trusted any single-column unique index the
catalog declares, and three things made that a wrong answer waiting to happen:
- the catalog's keys and indexes are the source's as of `mason start` and `mason add` / `remove` ONLY: `Sync.setTables`
  carries them into the catalog's schema, and nothing else calls it — the run's 10-second catalog read
  (`refreshFacts`, src/cli/dev.ts) refreshes the commands' facts, not the sync's tables. A migration that replaces
  `UNIQUE (code)` with `UNIQUE (tenant_id, code)`, then two tenants inserting `'a'`, made `count(DISTINCT code)` count
  N+1 for N, and a join on `code` count a row twice. (Feeding the refreshed facts to `setTables` was left out: it would
  also hand the sync every column change of every table, which re-copies a table, and a change of its key mid-run —
  a change of what a run does, not of this rewrite.)
- an INVALID unique index (a `CREATE UNIQUE INDEX CONCURRENTLY` that failed leaves one, the duplicates that failed it
  still in the table) was read as unique by preflight and declared VALID in the empty catalog; preflight now reads only
  valid indexes (`TABLES_SQL`, which `key:`'s check reads too: an invalid index is no key Mason accepts either);
- a column the copy is NOT written by can hold one value twice for a moment no source snapshot shows: a large
  transaction applied in pieces (a stream batch over its piece size, a poll over its piece rows), or a row refetched as
  it is now. The copy's OWN key cannot: a write by key deletes before it inserts, a batch is folded per key, pieces are
  disjoint, and the swap checks as many distinct keys as rows.
The primary key closes the last two and the common form of the first (a unique constraint dropped or replaced). What it
costs: a unique column that is not the key (a product's sku beside its id, an email) keeps its DISTINCT; the measured
shape — a fact table's primary key counted over a dimension joined on ITS primary key — is unchanged.

**What it rests on, and the case left open.** The copy is the source's rows under the key it is written by (the swap's
check; the oracle holds every copy to its source), and the catalog's primary key is the source's as of the start or the
last `mason add` / `remove`. A source that DROPS its primary key mid-run is the case left open: the catalog still
declares it and the copy is still written by it, so two staged rows of one id would both be inserted and counted; under
logical replication that migration also breaks the source's own UPDATE and DELETE on the published table. The source
index's opclass and collation are not read either (`catalogDdl` declares the type's default), which for a scalar
column is the same equality.
**Where.** `src/duck/distinct-key.ts`, `src/duck/rewrite.ts` (`keyCounts`, `repeatedKeyCounts`), `src/duck/plan.ts`
(`distinctKeys`); `tests/duck-distinct-key.test.ts`, `tests/duck-plans.test.ts` (`KEY_COUNTS`), the oracle's
`count of distinct keys` BI shapes and the type matrix's `keyed`, `pairs` and `vkeys`; `tests/cli-sources.test.ts`
(an invalid index).

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
| a statement's unfinished result is interrupted, read on off the worker's thread until DuckDB ended it, proved ended, and closed (`SessionRunner.cleanUp`; "The watch" says why, 2026-10-30) | under load the suite sat at 0 % CPU for good: the result's close (`Executor::CancelTasks`) waiting for a task waiting for the worker. Until issue 58 the guard was 50 ms with no call, which was no proof |
| nothing is closed under a pending call; a statement in flight at a stop gets 57P01 | a stop during a drain aborted the process (exit 134, `Napi::Error`) |
| a worker silent `SILENT_MS` (60 s) is given up on (57P02, the run exits for its supervisor); `close` settles in `CLOSE_GRACE_MS` (5 s) | a thread blocked in native code survives `worker.terminate()` and `process.exit`. This row once said one join (`a.id > b.id AND a.id - b.id = -7`, 1 M rows) takes ~10 s to honour an interrupt; measured again in 2026-10, its close took 91 ms |
| a worker given up on is asked to shut down and terminated only once it answered, referenced until then; an answer's close is a request (2026-10-28) | a test file under four suites' load aborted at exit (`libc++abi: terminating due to uncaught exception of type Napi::Error`): the after-hook's close outlasted 5 s and the executor terminated the worker under a Mason function call. A close with a 1 ms grace under a calling statement: 6 aborts in 6 before, 0 in 4 after; a script ending while a closed answer drained: 4 in 4 before, 0 in 4 after. Twenty CPU burners beside the file alone did not reproduce it (3 runs). A terminate under a call-free statement still aborts (2 in 12): nothing terminates a worker with a statement in flight |
| a statement closed while it starts is released once DuckDB hands the start back; a session's close closes an answer opened while it waits (2026-10-28) | Linux CI then failed the new grace test (`FATAL ERROR: Error::Error napi_define_properties`, the worker's loop still turning): the shutdown answered with a result still open. In a Linux container (node 24, arm64) the test's "grace" child aborted 6 in 30, 7 in 30, 3 in 20 (0 in 30 on the Mac, where a start takes 1–8 ms); traced with synchronous writes, the abort's run met the statement with no answer yet (`stream()` pending), released it at once, and the start was handed back 1 ms later to nobody. After: 0 in 40, twice, and the test file 3 of 3. A start is short (a calling count: 1–8 ms start, 1.7–4.7 s first fetch), so the test makes it late on purpose: a worker whose `stream()` hands DuckDB's start back only once the close's interrupt landed. It first held the start 300 ms after saying "starting" BEFORE DuckDB's own start, and under load the close's interrupt landed inside that start, which DuckDB failed (`INTERRUPT Error: Interrupted!`): told 57014 and released after its failure, correct, but not the case the test names (CI once, two local full checks; 3 – 4 runs in 24 of the child alone, 12 at once). The start is now whole before the close and the close an event, never a timer: 0 in 96 |

### The watch

**What happened** (issue 58, 2026-10-30). A test failed with 57P02 "stuck inside the engine" on a healthy machine, and
looking found three separate things behind that one message:

| | what | the worker | was the message true? |
|---|---|---|---|
| A | the main thread blocked or frozen past 60 s | idle, healthy | no |
| B | one calling statement holds the worker's loop for a whole 999-call turn | running, on CPU | no |
| C | a close on the worker's thread waits for a task that waits for that thread | deadlocked at 0 % CPU, for good | yes |

A: the watch compared the clock with the last message, so a block counted as silence, and after one the tick ran before
the answer waiting in the port was read: `SELECT 41 + 1` refused in 0 ms, no load, and a 66 s SIGSTOP refused a healthy
statement at its resume. B: the pong needs a loop turn, and a turn lasts 999 × a call's CPU (6.8 ms at ~54 bytes, 103 ms at
5 kB, 322 ms at 20 kB), so a read of 5 kB documents fires on any machine; with the watchdog disarmed a 20 kB statement
answered after 1,232 s with a longest silence of 1,151 s. A read of such documents took the whole server down.

C was the 50 ms: a task doing native work before its call makes no call for as long as that takes, and a cancel before
the first call read the previous statement's time as quiet. Cancels hung 1 in 3,329 over small documents and 5 in 1,303
over 20 kB ones, and by construction (a vector with `md5(repeat(j, K))` in the call's argument) every time at K = 20000.

**Decision.** The watch counts unanswered pings on the main thread's own ticks, and every Mason function call and row
adds to a shared beat. Nothing on the worker's thread waits for DuckDB's tasks.

**What does the wait, read from DuckDB 2.0's source and held by experiment.** The prototype of this fix read on, then ran
`SELECT 1` "to wait"; which of the two waited was not known. `ClientContext::EndQueryInternal` runs
`Executor::CancelTasks` on the calling thread, and every end of a query passes through it. An interrupted result's next
fetch fails in `BufferedData::Participate` before it computes anything, and `HandleFetchFailure` ends the query on the
fetching thread, libuv's. A statement cannot do it: `InitialCleanup` refuses one while a result holds the connection
(`connection has an open result`, measured: refused while open, interrupted or not, and run after the fetch failed). So the
FETCH is the wait, and `SELECT 1` is the proof it happened. It is kept for that, as a probe: the contract answers one.

**What it costs: less.** From the abort, median of 30 on a loaded laptop (macOS, Node 24, 3 M rows):

| | client told, before → after | session free, before → after |
|---|---:|---:|
| calling, cancel between two chunks | 8.3 → 3.3 ms | 81.5 → 7.0 ms |
| calling, cancel inside a fetch | 4.0 → 1.5 ms | 62.0 → 3.5 ms |
| call-free, cancel between two chunks | 0.9 → 0.3 ms | 3.4 → 2.4 ms |
| call-free, cancel inside a fetch | 0.9 → 0.6 ms | 4.6 → 2.3 ms |

The call-free close was its own false alarm in waiting, which is why it takes the same path: DuckDB checks nothing inside
a vector, so a close held the thread for the rest of one. With another session's `SELECT 41 + 1` as the measure, a
vector of `md5(repeat(j, K))` over 1 M rows, before → after: 748 → 3 ms, and 17,872 → 5 ms. The session that closed still
waits for its vector (15.8 s there), and nobody else does. The join this page once said took ~10 s closed in 91 ms.

**What the message means now.** It fires on a thread that neither turned its loop nor ran a row of a Mason function for 60 s
of the main thread's time: inside the engine, or spinning. Both are Mason bugs, so a statement that holds the worker
for minutes no longer fires, and a real deadlock still does. **Where.** `src/duck/executor.ts` (the watch),
`src/duck/cancel.ts` (the beat), `src/duck/store.ts` `cleanUp`, `src/duck/executor-worker.ts` `conn.close`;
`tests/duck-executor.test.ts`.

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

**A path has one route however it is spelled** (issue 130). Only a literal `'{k}'` reached the route above; `array['k']`,
which BI tools send, was a `to_json` of a list, so no native read, no stored path and one path counted as none. The
constant is now read from the analysed tree (the Const's array bytes, an ARRAY's Consts), so `array_in` decides what a
literal says. `GROUP BY` over 20 M rows of a 190-byte jsonb, wall time of a laptop shared with other work, nothing
stored, then the path stored:

| statement | before | after | stored |
|---|---|---|---|
| `meta ->> 'k'` | 3.2-6.7 s | 1.3-2.1 s | 0.13-0.16 s |
| `meta #>> array['k']` | 58-89 s | 1.2-1.3 s | 0.17-0.19 s |
| `meta #>> array['k']::text[]` | 45-70 s | 1.2 s | |
| `meta #>> array['order','status']` | 44-55 s | 1.3-1.4 s | |
| `jsonb_extract_path_text(meta, VARIADIC array[…])` | 54-60 s | 1.4-1.6 s | |
| `count(meta #> array['k'])` | | | 0.05-0.07 s |

`#>`, like `->`, stays the function until the path is stored: it answers a value's JSON text, which DuckDB's writer
would respell. `(meta #> array['k'])::text` and `(meta -> 'k')::text` took 48-82 s and up to 168 s by the function
(both the same route, the spread the machine's), and 7-14 s stored, where the rest is the cast's own function.

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

## Generated tables

Issue 124's first stage (2026-10-31): `kind: scheduled` by a whole re-run, one file per table in `mason/generated_tables/`.
The issue's own claims were checked against the code before building and corrected on the issue, comment by comment.

**Why a plan, and not a stored text.** A definition is planned as a statement is, by the listener's catalog, because that
is what makes its answer Postgres's: the rewrite, the allowlist and the text order are the statement path's, not a second
reading of the SQL. A plan is not stored because it depends on what the catalog and the stored JSON paths say at that
moment. The cost is a plan per run, in milliseconds, against a run of seconds.

**The planner has no session.** Generated tables are built in UTC under `public`, with no role, and what would read a
session is refused rather than given a default: a daily table bucketed in the wrong zone is wrong with no error. Reads of a
session are found in what Postgres resolved, since Postgres's own volatility marks are the fact: `pg_proc.provolatile`.
Two marks needed a word: `age(timestamptz, timestamptz)` is immutable yet splits both instants in the session's zone, and
`to_char(timestamp, text)` is stable yet reads no session here because a timestamp has no zone.

**One snapshot, one set of marks.** DuckDB takes a transaction's snapshot at its first read of a table, not at `BEGIN` or
at `SELECT 1` (measured), so a run reads the ledger on a writer's turn and takes the marks in that same turn. A commit
before the turn is in the snapshot; one after it marks the next run. Marks are in memory because a mark inside a batch's
transaction would add a write to every batch for a fact a restart can rebuild: at a start, a base synced after a table was
built counts as changed since then. That costs at most one re-run.

**The side table's commit and the swap are two transactions**, as a copy's are, so a long run holds no writer's turn. The
ledger row moves with the swap, so the table and its row never disagree. `open` drops what a crash left beside them.

**Stored types are a list, not a default.** A `numeric` is held out of this stage because its digits are worked out after
the engine answers (`src/lib/pg-numeric.ts`), and a plain write would store DuckDB's double. A type joins `STORED_TYPES`
when a statement over it is held to Postgres.

**Chains (stage 2a).** A child built in the same run as its parent reads the parent's side table, never the served one:
the child's plan names the parent, and the served parent is the OLD one until the swap, so the plan's tree is changed
after the rewrite to read the side table under the parent's name (src/duck/plan.ts `swapRelations`, held by the same
read-back as any plan). The whole chain is one transaction on the run's connection, so parent and child are one
snapshot, and one swap transaction on one writer's turn. A parent's new definition swaps in alone: its children's plans
need the catalog to say its columns first.

**Lag across a chain (stage 2b)** is the oldest base change anywhere below a table not yet in its rows: a parent's
pending change is not in its child either, so the child's lag is the minimum of its own mark and its parents', taken
recursively. A parent swapped in without its child marks the child at the oldest base change the swap brought, not at
the swap, so lag stays measured against the base. Nothing new is stored: a restart's marks come back from the ledger's
`basesSynced` as before, and the chain's from its parents'. A child's `target_lag` shorter than a parent's is refused
(the issue: it could be no fresher than its parent). `mason wait <table>` reads `behindSince`, the oldest such change's
time, and is done when it is null or after the wait began.

**Not yet**, by stage: numeric and user types, `latest`, `live`, by-group recomputes. The issue has the order.

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

### mason share (2026-10-30, GitHub issue 62)

**Decision.** A second socket of the one listener, TLS required, opened by the run for a tunnel's client: the plain
listener is untouched, so no session drops and a local tool notices nothing. Restarting under `--self-signed-tls` was
rejected (fifteen seconds, every session dropped, TLS asked of every local tool), and offering TLS on the plain socket
too (a tunnel's connection and a local psql are the same to it, so a tool configured without SSL would send its
password through the relay in clear, and Mason would never know).

The owner's decisions on the issue: a free tunnel's end ends the share, because a new tunnel is a new address to copy
anyway; a paid token keeps the address, so it reconnects. The login lasts for one run of the command. No throttle: every
tunnelled connection is from 127.0.0.1, so a throttle cannot tell a scanner from the BI tool, and a port scanner would
lock the tool out. The promise is "a relay that forwards bytes cannot read them", never more.

Decided in the building:

- **The command makes the password; the run gets its SHA-256.** A run that holds a hash cannot log, answer or dump a
  password, whatever a later change prints, where a test for its absence holds only the paths it thought of. A fast hash
  is right because the password is 192 random bits.
- **The connection is the share**: an answer left open, so the end of the process is the end of the share with no
  signal, heartbeat or state file. A tunnel client would outlive a `kill -9` of its parent, so the run stops it, by its
  pid and only while that process names the share's port.
- **Oldest out, not newest refused**: with a cap that refuses, `limit` idle connections hold the socket for as long as
  their deadline; with eviction, a flood must outrun a real login. A flood through a relay still can, and nothing here
  stops it: no source is known.
- **`ssh` config over `-o`** keeps the token off the command line, and `-F` keeps the developer's `~/.ssh/config`
  (a `ProxyCommand`, a `ControlMaster`) out of it. A machine that needs a proxy to reach the internet is the price.
- **A second `mason share` meets the same socket with its own login**, so the issue's "a second call answers the same
  port" holds under a credential per run.
- **Measured once on the real free route (2026-10-30, the demo's synthetic data, a laptop on IPv6).** The client says
  "expire in 60 minutes" and it does: the service closed the session 3,601 s after it opened ("Time exceeded"), `ssh`
  exited 255, and a probe every 10 s saw the address answer until then and refuse after, so the end of `ssh` is the end
  of the address and `mason share` needs no timer of its own. A second tunnel minutes after the first got another port
  and another host, so a free tunnel keeps neither, and its host name held the laptop's public IPv6 address. Between
  the two, `sslmode=require` logged in, a plain client got `28000`, and `openssl` read the share's own fingerprint
  through the relay. The paid route has not been run.
- **A probe of the printed address**, because the address is read from output Mason does not own: the contract answers a
  probe (CLAUDE.md "Fix the class").
- **A public socket says nothing before a login**, which the independent review found it did twice: the certificate
  named the project (any TLS client reads it with no password), and `3D000` before the password let a scanner confirm a
  guessed name. So every self-signed certificate is `CN=mason`, one already in `.mason/` that names a project is made
  again, said, because its fingerprint moves; and a public socket refuses a wrong database after the password. The plain
  socket keeps its early hint: it is a developer's, on this machine.
- **Ten refused logins a minute are rows, and the rest are counted**: a row per refusal let a stranger set the request
  log's growth, each carrying up to a 10,000-byte startup packet, for `MASON_HISTORY_DAYS`. A person who mistypes a
  password still finds it in the log, and names are cut to Postgres's 63 bytes. A once-a-minute aggregate row was the
  alternative; it would hide the mistyped login inside a scan.
- **The tunnel client's pid can be lost in one small gap**: a `kill -9` between `ssh` starting and the run hearing its
  pid (a request to loopback) leaves the client running. Closing it means starting `ssh` through a shell that waits to
  be told, which loses `ENOENT`, the way a missing `ssh` is said. What is left running forwards to a socket already
  closed, with no login valid, so the gap is left open.

### The database name a tool connects with (2026-10-30)

**Decision.** The name is `mason`, unless the sources file says another with `database:`. It was the project's name
(`mason init --name`, the folder, `MASON_NAME`), which also named the replication slot and publication; the two are now
apart. `src/lib/database-name.ts` is the one rule, `connectDatabase`: the run derives it once and records it in its
URL, every command reads that URL, and a command with Mason stopped asks `projectDatabase`.

**Why `mason`.** It shows in every connection string, and a project's folder name was never something a tool should
carry: a tool's saved connection said `my-app-2` because of where someone ran `mason init`.

**Why the fixed name is not the project's name.** The obvious change, defaulting the project's name to `mason`, would
give every project on one source the slot `mason_dev_mason_<source>`, so two projects (a laptop and a staging server,
say) would share one slot and each read away the other's changes, silently. So the slot keeps the project's name
(`deploymentOf` is unchanged) and the name a tool sees is a separate fact. `tests/cli-dev.test.ts` holds two projects
answering as `mason` with two slots.

**Why `database:` is the sources file's.** The point of drop-in is a tool keeping what it has, and which name a tool
uses is a fact about the deployment that should be committed beside the tables it reads, not set per machine. So the
key takes what Postgres takes: capitals, dashes, dots and spaces are real databases' names, and `postgres` and
`template1` work (`databaseNameSql` moves PGlite's own aside). Refused: nothing, past 63 bytes (`datname` would cut it
and a tool's would stop matching), a control character, `.` and `..` (a URL reads them as path steps, even escaped),
and `${NAME}`, because the name is the same on every machine.

**`MASON_NAME` stays the project's name.** It still names the slot, and renaming it over the same synced data is still
refused. What it no longer does is name the database, and a platform that writes the sources file to its volume (Fly,
Railway) has no file a person edits, so `MASON_PG_DATABASE` sets the name there. The setting is `mason serve`'s alone: the
sources file's name comes first, the two are refused on the settings' one report when they disagree (a second place
for one fact is only safe if it cannot differ), and `mason start` refuses it rather than ignore it. Beside
`MASON_PG_PLAIN`, not `MASON_DATABASE`, which reads as `MASON_DATABASE_URL`.

**What a stopped project says.** `mason user add` reads the one key, not the whole file: it needs neither the URL nor
the tables right, but a file that cannot say the key is refused, because a guessed `mason` would hand a tool a name the
next run may not answer to. The name is read once at the start, so `mason status` warns while the file disagrees with
the run. The `3D000` hint never names the sources file's path: a client reads it before any password, and that file is
named for the source's own database.

**Several sources are not built.** When they are, a second source with no `database:` would clash on `mason`, and is
refused with the exact line to add.

### Users

**Decision.** `mason user add <name>` prints a password once: `mason_<id>_<mac>`, 16 random hex digits then 32 of an
HMAC-SHA256 over the NAME and id keyed by the API key, so the startup packet's user name must be the user's (28P01
otherwise) and every statement is attributed. The list is `.mason/users.json` (no secret), changed under a lock file;
the listener stats it before every statement of a user's session, so a removal ends a held session at its next
statement (28000), no restart; an unreadable file refuses every user (57P03); rotating the API key removes them all.

**Why.** A BI tool stores ONE password; the day-long token killed its connection the next day. A file, because `mason
user` runs beside the process holding DuckDB's lock. Named as Postgres names it (`CREATE USER … WITH PASSWORD`).
**Where.** `src/duck/users.ts`, `src/cli/user.ts`; `tests/duck-users.test.ts`, `tests/duck-users-wire.test.ts`.

### Roles: tables and columns per user (2026-10-29, GitHub issue 30, stage 1a)

**Decision.** A roles file beside the sources file (`mason/roles.yml`, `src/cli/roles.ts`) names what each role may
read: tables, and `columns:` or `exclude:` of each, in the sources file's own words; `mason user add <name> --role
<role>` puts a role on a user (`role` in `.mason/users.json`). A role is enforced in `src/duck/plan.ts` on the tree
Postgres analysed, after the views are expanded and before the rewrite (`src/duck/grants.ts`): every
`RTEPERMISSIONINFO` of a copied table, its `selectedCols` mapped through `pg_attribute` (bit − 7 = attnum; bit 7 the
whole row; a lower bit a system column, which needs the whole table; none, a `count(*)`, any column). The refusal is
Postgres's: `42501 permission denied for table <name>` — measured on Postgres 18, which never names the column under
column grants — with the role and the column in the DETAIL and what the role reads in the HINT. The catalog Postgres
holds one role per Mason role with the same GRANTs and runs a role's session's catalog statements under `SET ROLE …
RESET ROLE` in one request, so `information_schema`, `has_*_privilege` and `mason mcp` answer for the role;
`pg_catalog` is left unfiltered (Postgres filters it no more than Mason does). Fail closed everywhere: a role the
file lost refuses its users by name, a file that cannot be read refuses 57P03 and keeps the last good grants for the
catalog. The role travels with the user's token, re-read before every statement, and a plan carries its reads so an
Execute is held to the role of that moment; the plan cache is keyed by role.

**Why on the tree.** A text match misses a CTE, a `USING` join, a lateral's argument and a `*`; Postgres has already
resolved every one of them by the time the planner sees the tree, and its own permission check reads the same node.
**Why the catalog has real roles.** `information_schema` is a view over `has_*_privilege`: filtering it by hand would
be a second implementation of Postgres's rules; a real role makes PGlite answer as Postgres does, for every
introspection a tool sends. Views are granted to every role (the grant rides in the view's own statement, since the
view must exist first) and checked on their base tables: stricter than Postgres, said in the docs.
**Not in this stage.** `pg_catalog` filtered by role; row filters (stage 2); limits (stage 3).
**Where.** `src/duck/grants.ts`, `src/cli/roles.ts`, `src/api/postgres/catalog.ts` (`catalogRoles`, `asRole`),
`src/api/postgres/server.ts` (`Session.grants`, `heldToRole`, `catalogAs`); `tests/duck-roles-wire.test.ts`,
`tests/postgres-api/catalog.test.ts`, the oracle's `roleCases`.

### Roles: the file decides the default (2026-10-29, GitHub issue 30, stage 1b)

**What stage 1a left in the code.** A user with no role read every copied table, and so did a token: a grant nobody had
written down, decided by `Session.grants()` returning "no role, nothing to hold". Beside a roles file that narrowed
every other user, the one line of access no reviewer could read in a commit was the widest.

**Decision (the owner, 2026-10-29): the FILE says it.** Three states, each said where a person and an agent look (`mason
start`'s roles line, `mason user add` / `list`, `mason status`, the web page, `--json`'s `roleFrom` / `readsNothing`):
no `mason/roles.yml` — every user reads every copied table, as before roles existed; `default: <role>` at the top of
the file — a user added without `--role` reads as that role (its refusals, its catalog under `SET ROLE`, its request
log rows); a file with no `default:` — such a user reads nothing, each statement that reads a copied table refused
42501 with the two ways out as exact lines, `SELECT 1` still answered. Its catalog requests run as a grant-less role,
`__mason_no_role` — named outside the file's namespace (a role name never starts with `_`) — so `information_schema`
and the privilege functions answer as Postgres's do for a login with no grant (the review of #44: run as the catalog's
superuser they listed every table and said `has_table_privilege` true while every read was refused). The session asks the roles at
every statement (`LiveRoles` re-reads the file when its stat moves), so an edit of `default:` applies at the next one;
`Session.roleName` is the effective role, the one name `catalogAs`, the plan cache and the request log read. A file
that cannot be read refuses a roleless user too (57P03): its default cannot be known, and fail closed is the rule. A
token is no user and keeps reading everything: it is minted from the API key, which is the operator's.

**`tables: all`, Postgres's own word.** "Every table" is `GRANT SELECT ON ALL TABLES IN SCHEMA` in Postgres, so the
file says `tables: all` rather than a word of Mason's; it is resolved against the tables copied at every read
(`resolveRoles` writes a whole-table grant per copied table), so a table the sources file adds is the role's once its
copy is served, and the catalog grants it per table at its rebuild — never `ON ALL TABLES`, which would be true only
of the tables there at the GRANT. A table key `all` is refused with both meanings (`public.all` for a table so named).
The oracle holds a Mason role of `tables: all` to a Postgres role granted `ALL TABLES IN SCHEMA public`.

**`mason init` writes the file** (`newRolesText`, beside the sources file's `newSourceText`): one role, `everything`,
`tables: all`, and `default: everything`, with a narrower role as a comment to copy. A new project starts with today's
access, but visible in a committed file: narrowing it is an edit a reviewer sees, and deleting the `default:` line is
the one-line way to make every roleless user read nothing. A file already there (a clone) is kept byte for byte.

### Roles: rows per user (2026-10-30, GitHub issue 30, stage 2)

**Decision (the owner, 2026-10-30): one PR carrying `where:` and `through:`, scalars and lists, and a user missing a
value refused loudly.** A role declares `attributes:` (`[tenant]`, or `{ tenant: scalar, regions: list }`); a table of
it takes `where: "<SQL reading :name>"` or `through: <a table of the role>` (`through: { orders: order_id }` naming the
column); a user carries its values (`mason user add … --set tenant=42`, a list by repeating `--set`; `attributes` in
`.mason/users.json`). Answering a user that lacks a value with no rows would look like an empty tenant — a silent wrong
answer — so every statement of such a user is refused 42501 with the attribute, the `where:` and the exact commands,
and `mason start` and `mason user list` name such users.

**One grammar.** `:name` is found by one lexer (`whereParts`, src/duck/row-filter.ts) that skips strings, quoted
identifiers, dollar quotes, comments and `::` casts. The `where:` is analysed by the catalog Postgres at the file's read
as `SELECT 1 FROM <table> WHERE <$n>`, which types each attribute as Postgres infers it there (`tenant_id = :tenant`:
integer; `region = ANY(:regions)`: uuid[]); a list used as a scalar or the reverse is Postgres's own error at the key,
told again with declared types so the message is the one a developer would meet. Bound, a scalar is `CAST('42' AS
integer)` and a list `CAST(ARRAY['12', '41'] AS integer[])` — literals the catalog reads, never a value pasted into a
statement's text. In the statement, each read of a filtered table (a `RangeVar` resolved by `to_regclass` under the
session's search_path, every read the analysis found accounted for, as views are) is replaced by `(SELECT * FROM t WHERE
<filter>) AS t`, a `through:` by an `EXISTS` over the parent's own filtered read, recursively; the result is analysed
again and goes through the same grants, rewrite and allowlist as any statement. So a view, a CTE, a subquery, a join's
side and a prepared statement's every Execute meet the filter because there is no read without it. The plan cache is
keyed by the role AND the bound filters, and an Execute whose filters moved (the file edited) is planned again.

**Postgres row security is the reference, twice.** The catalog holds the filters as real policies (`ENABLE ROW LEVEL
SECURITY`, `CREATE POLICY … FOR SELECT TO <role> USING (… current_setting('mason.attr.tenant')::integer …)`), the
attributes sent with each catalog request as the session's settings and unsettable by the session; and the oracle
mirrors each Mason user with a Postgres login under the same policies (`ALTER ROLE … SET mason.attr.…`, a list read by
`string_to_array(…)::int[]`), asking thirty shapes as six users and as an unfiltered one (tests/integration/oracle/row-filters.ts).
**An empty list is not expressible**: `--set regions=` is refused and an empty list in the users file counts as a missing
value, since a user reading no row of its role is a user of another role, and an empty array would be the silent zero rows
this design refuses.

**The security barrier (the review of PR 51).** A Postgres policy is a barrier: a statement's condition runs below it only
if it is leakproof. The first form of this feature had none. The filtered read was a plain subquery, DuckDB flattened it,
and the statement's WHERE went below a `through:`'s or a list's SEMI join, onto every row of the table, so
`WHERE 1/(CASE WHEN qty = 99 THEN 0 ELSE 1 END) > 0` answered "does a hidden row satisfy P?" for any P, as 22012 or a
count. The tests had hidden it: DuckDB's dynamic join filter prunes hidden rows by itself below 50 build keys or over a
narrow key range, so **a test of this needs more than 50 visible keys over a wide range**, and the oracle's and the wire
test's do. Now the outermost filtered read ends `LIMIT 9223372036854775807` (`BARRIER`, src/duck/row-filter.ts): the filter
pushdown does not cross a LIMIT, which would change what it keeps. **The limit need not reach the plan**: statistics
propagation runs after the pushdown and drops a limit above the table's row count, so most plans hold no limit node, and
the statement's expression stays above the role's filter all the same; that is also why the barrier costs so little. So
the detector reads where the expression runs, never whether a Limit is there (`tests/duck-roles-barrier-wire.test.ts`).
With the `try` wall off (`wallSwitch`, below), removing it fails that file's limit test and, per user, the shapes counted
below; with `try` on, nothing fails, which is why the limit has a test of its own.

Measured on DuckDB 2.0, ten cores, a file of 30 M orders and 60 M items, a user keeping half the rows, min of five (three
for the last three rows), ms. One thing changed per column:

| Statement over the filtered read | No barrier | `LIMIT` max | `OFFSET 0` |
|---|---:|---:|---:|
| `count(*)` | 6 | 5 | 26 |
| `sum`, `avg` over every row | 12 | 10 | 48 |
| GROUP BY with a WHERE of its own | 18 | 23 | 85 |
| the same, the filter a 50-value list | 16 | 23 | 83 |
| a WHERE a zone map would prune (`id BETWEEN`) | 0 | 15 | 60 |
| `through:`, an aggregate | 539 | 541 | 492 |
| `through:`, a WHERE a zone map would prune | 98 | 505 | 514 |
| a join of two filtered tables | 28 | 26 | 133 |
| that join, a selective WHERE | 8 | 8 | 64 |
| ORDER BY … LIMIT 10 | 19 | 18 | 83 |
| 15 M rows returned | 130 | 72 | 160 |
| a window, a WHERE of its own | 21 | 34 | 74 |
| `count(*)` of a DISTINCT | 60 | 63 | 255 |

`OFFSET 0`, Postgres's own idiom, is a barrier too, but statistics cannot drop it and it runs a serial operator under the
default `preserve_insertion_order`: three to five times the cost, for nothing. **`WITH … AS MATERIALIZED` is no barrier**:
the same reproduction raised 22012 through it, read once or twice, and it costs more (`sum` 165 ms, a `through:` aggregate
1,319). **What the barrier costs is the
statement's own pruning**: every shape is within noise but those whose WHERE a zone map would have pruned, the worst five
times over on a `through:`, 400 ms on 60 M rows.

**A table's statistics (the second review of PR 51).** The review found EXPLAIN telling a filtered user what the engine
knew of the whole table: `Empty Result` and the first line's `answered reading no synced table` for `WHERE secret > N`
above the column's maximum, a binary search on a hidden row, and `rows=` and `actual rows=` beside it. Then a probe with no
EXPLAIN in it did the same: `WHERE 1/(id - id) > 0 AND secret > N` raised 22012 below the hidden maximum and answered 0
above it, because the engine proved the condition false from the column's statistics and took the Filter away, the
division with it. The limit stops a filter, not a fact: statistics pass up through it, through a UNION ALL's arms, `[x][1]`,
struct and unnest, `any_value`, `try_cast`, `list_concat`, `flatten`, `struct_pack` and `row()`. So hiding EXPLAIN was not
enough, and turning off the engine's `statistics_propagation` is not open: `disabled_optimizers` is global, visible from
another connection, so a per-statement setting would race every other session.

**Two things hold it.** The filtered read ends in `SELECT try(COLUMNS(*)) AS "\0" FROM (… LIMIT max)` (`wallStatistics`):
`try(col)` is opaque to the propagation (the plan was identical either side of N), and it keeps every column's name, type
and text, 34 types and 16 odd names held by `tests/duck-roles-try-types.test.ts`. Postgres has no `COLUMNS(*)`, so
`filteredSql` writes `*`, Postgres analyses that, and the list is replaced after the rewrite, where the read-back check
holds the text. **The wall's select is found by a name chosen after reading the statement**, the first of
`__mason_barrier`, `__mason_barrier_1`, … that no string of it holds, with the count of reads Mason wrote: a fixed name
counted a user's own subquery as Mason's, and a mismatch is refused by the gap `roles`. `COLUMNS` is printed the same way,
from calls marked in the tree under a name the text holds nowhere else, never by replacing characters a literal could
spell. And an EXPLAIN of a statement that reads
a filtered table never shows the statement to the engine: the tables are `plan.reads`, the first line constant, `Plan` a
constant node so a viewer and `mason mcp` keep reading `Mason.Tables`, and ANALYZE is refused by the gap `roles`, since a
profile is a count of what the engine read and there is nothing left to run it for. A session with no filter is untouched.

**What guarantees what.** The LIMIT's guarantee is the engine's semantics: a filter pushed through a LIMIT would change
what it keeps. `try` stopping the pushdown and `try` stopping statistics are both observations of this engine, not
guarantees: a later version could carry a minimum and a maximum through it. So each has its own detector. With `try` on, the
pushdown stops at `try` and a test cannot tell whether the LIMIT holds anything (`BARRIER` empty passed every test of the
two wire files), so `tests/duck-roles-barrier-wire.test.ts` runs every shape with the `try` wall off by a test-only switch
(`wallSwitch`), where the LIMIT stands alone. `tests/duck-roles-rows-wire.test.ts`'s statistics test is `try`'s detector, on the
wire because Postgres itself raises 22012 by written order on that statement, so the oracle cannot hold it. Both stay.

The oracle's data had to change with this. At a sixth of the invoices visible (`tenant`) or a third (`list2`), the join's own
filter pruned the hidden rows and the barrier shapes passed with the barrier removed. At about half visible, removing both
walls fails 7 shapes of `tenant` and of `list1`, 14 of `list2` and 15 of `regions`. The rest of a scalar's shapes cannot fail:
one value is a table filter in the scan, which runs before the statement's Filter with no barrier at all.

Measured on the same file, the same run, DuckDB 2.0, min of five (three for the last three rows), ms. **The machine was
loaded** (load average about 40), so compare across a row and never with the table above, whose rows are a quiet machine's:

| Statement over the filtered read | No barrier | `LIMIT` max | `LIMIT` and `try` |
|---|---:|---:|---:|
| `count(*)` | 7 | 7 | 8 |
| `sum`, `avg` over every row | 14 | 38 | 29 |
| GROUP BY with a WHERE of its own | 64 | 53 | 72 |
| the same, the filter a 50-value list | 43 | 103 | 146 |
| a WHERE a zone map would prune (`id BETWEEN`) | 1 | 14 | 22 |
| `through:`, an aggregate | 2,210 | 2,366 | 2,008 |
| `through:`, a WHERE a zone map would prune | 334 | 2,070 | 2,109 |
| a join of two filtered tables | 84 | 65 | 62 |
| that join, a selective WHERE | 11 | 32 | 32 |
| ORDER BY … LIMIT 10 | 46 | 30 | 54 |
| 15 M rows returned | 375 | 136 | 463 |
| a window, a WHERE of its own | 25 | 69 | 167 |
| `count(*)` of a DISTINCT | 342 | 211 | 406 |

`try` costs per row read (each column is evaluated through it), so it shows where a statement returns or sorts many rows,
up to about twice the limit's, and nothing where the time is the join's. A point lookup of a wide column costs 26 ms
against 0.9 ms on 150,000 visible 2 KB rows, and that is the LIMIT's, not `try`'s: the statement's own pruning, as above.

**A `where:` the rewrite cannot send is the file's problem.** `checkRoles` ran Postgres's analysis only, so a predicate
Postgres read and Mason cannot answer (a value of a type not verified) reached each user as 0A000, statement by statement.
It now plans the filter's own read too, every attribute NULL, the one value of every type (`filterProbe`).

**A value its type refuses is the attribute's problem.** `filterProbe` cannot see a value: `--set tenant=abc` on an integer
passed, and every statement of the filtered table answered `22P02` naming no attribute. A data exception on a filtered
statement now re-reads the bound values of the filters that statement reads (`attributeRefused`), and one the type refuses is 42501 with the attribute, the user
and the `mason user add` line; a statement's own bad literal stays Postgres's. `mason user add` does not refuse it at the
door: the type is the catalog's inference, a run's, and the command also works with Mason stopped.

**A GROUP BY of a filtered table's key.** A table turned into a subquery has no primary key, so `SELECT o.id, o.status … GROUP
BY o.id`, which Postgres accepts under row security, failed the filtered text's analysis with 42803. Each column the select
reads outside an aggregate now joins the GROUP BY (`carryKeyDependency`), gated on the key being grouped whole: a group is
then one row of the table and no added column can split it. The gate is the key and never Postgres's acceptance, because
`GROUP BY lower(status)` reads a column ungrouped too. What the carrying does not reach (a grouping set, a `json` column) is
a 42803 only the wrap can cause, so it is refused by the gap `roles`, with the way out.

**`SHOW ALL`** lists no `mason.attr.*`, and that is Postgres's answer: a placeholder is `GUC_NO_SHOW_ALL`, and the oracle
holds it, for a `SET myapp.x` and for an attribute `ALTER ROLE` set.

**No leakproof gate.** Postgres omits the barrier for a leakproof condition, and the "No barrier" column is the most a
gate could win back. It was not built: a gate must judge what reaches the engine, not what the user wrote, and Mason's
rewrite turns a comparison into its own functions (a collation's key, an exact numeric), so `pg_proc.proleakproof` on the
analysed tree says nothing about them. A safe gate needs an audit of every rewrite of every operator it admits, kept true
as the rewrite changes, and it must read the whole tree, since a derived table's expression becomes the outer condition
once substituted. A mistake there is the leak this section closes; its gain is the two pruned rows above. Timing is out of
scope either way: how long a statement runs depends on rows it cannot read, on Postgres too.

**Where.** `src/duck/row-filter.ts`, `src/cli/roles.ts` (`attributesOf`, `rowsOf`, `throughColumns`),
`src/api/postgres/server.ts` (`withRows`, `checkRoles`), `src/api/postgres/catalog.ts` (`catalogPolicies`),
`src/cli/user.ts` (`attributesToAdd`); `tests/duck-roles-rows-wire.test.ts`, `tests/cli-roles.test.ts`,
`tests/duck-row-filter.test.ts`, the oracle's `rowFilterCases`.

### An MCP server (2026-10-29)

**Decision.** `mason mcp` is an MCP server on stdio — newline-delimited JSON-RPC, stdout the protocol's alone — that is
a client of the Postgres API like any tool, connected as a `mason user` by the URL `mason user add` printed
(`MASON_URL`, or `--url`, where `ps` shows it), with `application_name` `mason-mcp/<client>`. It takes no `--json`
(`CommandSpec.stdout: "protocol"`): a failure to start is the failure shape on stderr, the MCP client's log. Its tools are named in Mason's words: `tables` (each copy's
rows and how it is kept current), `describe` (columns, Postgres types, key, foreign keys), `query` (one statement through
the extended protocol, `max_rows` the Execute's row count so the server stops there and says so, `timeout_ms` a
`SET statement_timeout`) and `explain`; the agent's guide and `mason help mcp` are its resources. The rows and the kept
line come from `EXPLAIN (FORMAT JSON)`'s `Mason.Tables` over the wire, never the run's command server: a remote
`mason serve` answers as a local run does, and the words are the sync's own, as `mason status` prints them. One
EXPLAIN a table, a few at once: a union of them all failed whole for one table it could not plan, and left a refusal
in the request log the agent never sent. A table is named as a statement writes it (`public."Clients"`, the formatter
EXPLAIN's text uses), and `describe` reads a name as Postgres does (quoting, folding) in mcp itself, never by
`to_regclass`, whose refusal of a name it cannot read would be a row of the request log too. A column's type is named
by the catalog's `mason_wire_type`: the wire sends the SOURCE's OID for a type the source made (an enum, a citext),
which the catalog holds under another OID — and both count from 16384, so `format_type` of the wire's OID can be
another relation's row type in the catalog; the catalog's map of source OIDs is the one place a wire OID is named.
A request the client cancels (`notifications/cancelled`) is a CancelRequest for its statement, and is answered no
further. With no URL it refuses and names `mason user add claude`; it never makes a user: a password is the person's
to hand out. The protocol is written by hand (initialize, ping, tools/list, tools/call, resources/list, resources/read)
rather than taken from `@modelcontextprotocol/sdk`, whose seventeen runtime dependencies (an HTTP server, an OAuth
library, two schema validators) are for the transports this command does not serve; `src/cdc/pg-wire.ts` is its
Postgres client, as it is the change reader's.

**Why.** Chat agents reach tools over MCP. A generic Postgres MCP server already works against Mason — it speaks the
wire protocol and reads a real catalog — but it hands the model a bare "run SQL" tool: the model guesses which tables
exist and how current each copy is, and when Mason refuses a statement it sees an error string. Mason knows all three,
and each refusal's way out (the gap's HINT, `src/duck/gaps.ts`), and the CLI was already built for agents (`--json`,
exit codes, `mason help agent`). A tool error carrying the SQLSTATE and HINT is what lets a model rewrite the statement
instead of giving up; a `kept` line is what stops it presenting a copy over the poll's row limit as current. And every
statement lands in the request log under the agent's name.

**Not yet: the same server inside `mason serve`, over HTTPS.** A hosted agent (claude.ai, a team's agent platform)
cannot spawn a process; it needs MCP's Streamable HTTP transport on the server. What that would take: a route on
`mason serve` beside `/healthz` (its own port or path, TLS as the Postgres API's: `MASON_PG_TLS_CERT` or the operator's
proxy), the same tools over the same session code, and authorization by MCP's OAuth 2.1 profile — Mason as the
resource server, publishing its protected-resource metadata, the bearer token mapped to a `mason user` so the request
log still names who asked — or, before an authorization server exists, a user's password as a bearer token for the
clients that take a static header. The tool code would not change; the transport and the login would.

**Where.** `src/cli/mcp.ts`, `src/cdc/pg-wire.ts` (`extended`, `cancel`), `src/api/postgres/catalog.ts`
(`sourceTypeNames`); `tests/cli-mcp.test.ts`, `tests/pg-wire.test.ts`.

### A session's settings are transactional (2026-10-30, issue 47)

`SET LOCAL` was a SET and a ROLLBACK undid none: the classifier read `is_local` and nothing used it. The issue asked for
a block's two ends; probing Postgres 18 message by message, before any code, found three things it had not:

- **A failed block reverts at the error, not at its ROLLBACK.** AbortTransaction runs AtEOXact_GUC when the error is
  raised; the block only stays open as a state. So the ParameterStatus comes with the error's ReadyForQuery (`E`), and
  the ROLLBACK reports nothing. A revert at ROLLBACK passes a test that reads `SHOW` after it and tells a driver late.
- **An implicit transaction is a transaction.** `SET a; SELECT 1/0` in one Query undoes the SET, and `SET a; ROLLBACK`
  does too, with its warning; a `BEGIN` after a SET takes the SET into the block. #46's comment and test said a request
  that failed half-way reports what its earlier statements moved: Postgres reports nothing, the value was undone.
- **A batch of Executes is a block once one completed**, on Postgres 18: the second `SET LOCAL` of a pipeline warns of
  nothing, `DISCARD ALL` after a SELECT is "cannot run inside a transaction block", not the pipeline's own message
  xact.c also holds, and a portal suspended at a row count counts as completed (the first version of this change said
  otherwise, and asserted it: the independent review measured it). Read from the wire, not the source.
- **A failed block's rule is per message, and Mason's was per statement kind.** The 25P02 check sat after a statement's
  classification, and a catalog statement never reached it in the extended protocol: it runs whole at its Bind, its rows
  kept for an Execute that returned them first, so `SELECT 1` answered inside a failed block where Postgres refuses the
  Parse. Issue 47's class, found by the same review: a state a driver reads, held at one of its entrances.

**Decision.** `vars` stays the one store every reader reads, so no reader can miss a transaction: the transaction keeps
two whole copies, what ROLLBACK restores and what COMMIT leaves, and a plain SET writes its one name through to the
second. That is Postgres's per-GUC stack (GUC_SET, GUC_LOCAL, GUC_SET_LOCAL) at one level, a value's whole history being
two strings; with savepoints it would be a list of these. An overlay of LOCAL values was the other shape, and every
reader would have had to read it. A placeholder's definition is no value (Postgres keeps it defined, `''`), so it is
written into both copies when a statement names it. `set_config(…, true)` needed one word in the classifier.

Each of the four sites that failed a transaction would have had to undo the settings, so they became one
(`abortTransaction`), held by `tests/conventions.test.ts`. The oracle's setting scripts hold each step's whole reply:
`ask` sees rows, and nothing here but SHOW is a row. On main 80 of the 95 scripts differed.

**Where.** `src/api/postgres/server.ts` (`settingsTx`, `applySetting`, `endTransaction`, `abortTransaction`,
`implicitBlock`), `translate.ts`; `tests/duck-wire.test.ts`, `tests/integration/oracle/setting-scripts.ts`.

## Observability (2026-10-27 – 2026-10-30)

**Decision.** Every run keeps its history in its own file — the request log (below), the sync's events, a usage
sample a minute and each copy's size every 10 minutes — and the commands (`mason status`, `mason logs`, `mason usage`)
and `mason start`'s web page (`mason ui`) render the same JSON. The plan, the endpoints and the access options are
docs/OBSERVABILITY.md; the page's rules are .claude/rules/web-ui.md; the numbers of its architecture review are
docs/OBSERVABILITY.md "Architecture review".

**The page's look, as it was decided.** A first palette of black bands and a dark orange read as dated, and its hard
stepped shadows as heavy: the owner kept the type (Geist Mono, Geist Sans, Zilla Slab) and asked for other colours,
so the page is a stone white with one patina accent and a hairline-and-soft-shadow step. A copy's bar was first a
course of bricks; the owner found it read as noise, and it is a plain line with its % at the end. A first chart set
its title into its frame, where "Statements an hour" overflowed the card; the title is the card's now. The owner's
rule for clicks — "clicking buttons in a table should not shift it around" — is why every question, form and answer
is a popover, every changing label keeps the room of its longest, and the Tables and Users lists have fixed columns
(a disabled user's "Disabled <when>" once widened Users' Status column).

**The ranges.** The views share one time range. Now (the last 15 minutes, read every few seconds) is the default,
and every other range is read once and holds still, with when it was read and Refresh: a person comparing a past
hour wants it to stay put. The Overview's links carry the range of what their card counts (24 hours; the sync's
failures 7 days): with Now the default, a card of 12 failed statements once landed on an empty 15 minutes.

**Measured.** A copy's size from `pragma_storage_info`: 61–72 ms cold on 30 M rows × 14 columns, metadata only but
growing with rows × columns, so it is sampled every 10 minutes, never per request; `duckdb_memory()` under 1 ms. A
`count(*)` after a stream batch that wrote by key was a scan, 12 ms on 20 M rows, so a copy's rows are kept by the
batch's own inserts less its deletes. A copy with no persistent block yet (its rows still in the write-ahead log) was
measured "0.0 KiB" for 5,000 rows, so it is not measured until it has one; and the file's block size read without
`current_database()` was the in-memory catalog's 0, which made every copy 0 B.

**`/metrics`: numbers only, no auth (2026-10-30).** Of the three ways docs/OBSERVABILITY.md "Access" costed to give a
DevOps team more than `/healthz`, the owner chose to build C first: `GET /metrics` on `mason serve`'s health port, in
Prometheus's text format, because a team that runs Prometheus scrapes it with three lines of config and alerts with
the rules it already writes, and it costs a day where A and B cost two and four. It takes NO credential, as `/healthz`
takes none: the health port is reached by the platform's probes and scrapers, which carry no secret, and asking for
one would make it A. That is safe only because it serves numbers alone — counts, lag, ages, sizes — and never a name
(no table, column, user, client or host, not even as a label) nor a statement's text: a real database's structure is
confidential, and a label is a value too. Per-table and per-user detail, and the statements, wait for A or B behind a
secret. Every number is one `/api/state` or a usage sample already computes (`metricsFacts`: `usageFacts`, the
sampler's counter beside its interval's, fed by the one `record` path, and its last p50 / p95), so a scrape and
`mason status` cannot disagree; the statements are a counter kept in the process, never counted from the request log
at each scrape, so it never goes down between two scrapes — it counts every statement the listener answered, so after
the request log lost rows it could not write (said in the log, `lost` streaks) it exceeds what `mason status` and
`mason usage` count by those rows. A number not known is absent, never 0 (a stream's lag where nothing streams) and
never NaN (which no alert compares true): a family is whole or absent. A SCRAPE NEVER REACHES THE SOURCE (the
review's blocker: the first cut read the stream's position as `mason status` does, a connection and a SELECT on the
production database per scrape at most every 5 s, from a GET anyone on the health port may loop): the position and
the slot are read as the sampler last cached them (`streamStatus({ refresh: false })`), and a number cached longer
ago than two samples, or a p50 / p95 of a sample that could not be taken, is absent rather than stale. While Mason starts or stops it answers 200 with
`mason_ready 0`: whether it is up is the probe's question, and a scrape that errored during every deploy's first
seconds would page someone for nothing.

**Where.** `src/duck/{requests,events,usage,history}.ts`, `src/cli/{run-server,usage,commands,metrics}.ts`, `src/web/`;
`tests/duck-{requests,events,usage,history}.test.ts`, `tests/cli-run-server.test.ts`, `tests/cli-metrics.test.ts`, `tests/web-page.test.ts`.

## The request log

**Decision.** Every statement DuckDB answered and every refusal or failure (a Parse, a Bind, a syntax error, a refused
catalog read, a bad password) is a row of `_mason.requests` in `.mason/duck.db`; an answered catalog read, SET, SHOW or
BEGIN is chatter and is not. Its columns: `request_id`, `seq`, `started_at`, `duration_ms`, `session`,
`application_name`, `token_name` (a NAME, never the token), `user_name`, `method`, `sqlstate`, `message`, `detail`,
`hint`, `rows`, `query` (cut at 64 KiB, `query_truncated`) and `json_reads` ("Stored JSON paths" 1.). Written in batches
(a second or 1,000 rows) on a connection of its own, never the writer's turn; a failed write is said and fails no
statement; kept `MASON_HISTORY_DAYS` (7) days; read only through the command server; ordered by `started_at`, `seq`.

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
only: a table whose `sync:` is `replication` in a demo project's sources file is refused before anything starts.

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

### A server's web page: `mason ui --ssh` (2026-10-31, issue 107)

**Decision.** The tunnel is ssh's stdio to a bridge beside the run (`mason ui --bridge`, `src/cli/ui-ssh.ts`), not `ssh -L`.
Why: Docker publishes to a container's network address, never its loopback, so `-L` needed the page off loopback, and
what keeps the page safe without TLS or a login is that it never is. A bridge inside the container makes a host and a
container one route, with nothing published. Frames multiplex every browser connection over one ssh connection, as
one per socket would be six hardware-token touches for a page. **The run's token never leaves the server**: the laptop
gets a one-use ticket, as the URL a browser opens is on a command line, and a tunnel is what adds a Host to the guard,
by its port, for as long as its connection lasts (`PageTunnel`), never a wider rule. Under `mason serve` a sources file
that cannot be written takes Add and Remove off the page (`sourcesReadOnly`), since a control that can only fail must
be absent. Run with real OpenSSH and sshd on one machine, host and container; a real network and SSM, IAP and Bastion are unverified (docs/WEB-UI.md).

### On a server: `mason serve` and the image

**Decision.** `mason serve` is `mason start --attach`'s run configured by the environment alone (`DATABASE_URL`,
`MASON_API_KEY`, `MASON_PROJECT`, `MASON_DATA`, `MASON_NAME`, `MASON_PG_*`), every bad setting on one
report, the log on stdout, SIGTERM its stop (tini PID 1). `GET /healthz` (`MASON_HEALTH_PORT`, 4140) is 503 until the run
answers, counts only (it takes no credential). The image (`docker/mason-data.Dockerfile`) is node:24-slim with the
copy's extensions installed at build as the npm CLI has them ("The copy's extensions ship with Mason"; closed egress
still copies); one replica, stop-then-start deploys;
`deploy/mason-data/compose.yml` the quickstart. `version()` is `PostgreSQL 18.6 (mason-data <version>) …`, Postgres first
since tools parse it. Item 1 of the server's plan was a login that does not expire: `mason user` ("Users").

**Why.** A first start is 503 for ~15 s idle (14 s on the host, 15.7 s in the image), 13 s of it ONE query sorting every
code point under the collation (kept in the copy: a restart is healthy in 0.5 s); at load 31 it took ~2.5 minutes, so
the HEALTHCHECK start period is 2 minutes plus three checks 15 s apart. One replica: DuckDB's file lock admits no reader
process beside the writer. Not built: Let's Encrypt, an SSH tunnel, readers over shared
storage, measuring where the catalog's ~820 MB goes. **Where.** `src/cli/serve.ts`; `tests/serve.test.ts`,
`tests/integration/duck-serve.itest.ts`.

### The copy's extensions ship with Mason (2026-10-29)

**Decision.** DuckDB bundles neither extension Mason needs — `postgres` (the copy reads the source through it) nor
`inet` (a text cast to inet, `s::inet`, reaches DuckDB's CAST and autoloads it) — and by default downloads each from
its repository at the first statement that needs it: a laptop offline at its first copy could not copy, and a server
fetched code at run time. Both now ship as ONE npm PACKAGE PER PLATFORM, `@mason-data/extensions-<platform>`
(darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64), optional dependencies of `@mason-data/cli` with
`os` / `cpu` / `libc`, as DuckDB's node bindings ship their binary (`src/duck/extensions.ts`). With the package found,
the instance's `extension_directory` is the package's folder and autoinstall is off: `LOAD postgres` and the inet
autoload read it, nothing is installed or downloaded, and the folder may be read-only. Without it (`--omit=optional`,
musl, Windows on arm64, a checkout) DuckDB's own install runs, said with the reason; `mason doctor` probes which.

**Why these choices.** `extension_directory` over `LOAD '<path>'`: a LOAD by path loads that file, and the inet cast's
autoload still looked in `~/.duckdb` (measured: the cast then tried to download). The official extensions are signed,
and DuckDB checks the signature at every LOAD with `allow_unsigned_extensions` off (measured, DuckDB 2.0: both load
from a read-only folder with no `.info` file). The files are pinned by sha256 and size in `cli/extensions.json` (DuckDB
publishes no checksum list: the pin is what was fetched once and read, and `node cli/extensions.ts --pin` makes the next
for a new engine), and `@duckdb/node-api` is pinned exactly, since a range could install an engine the packages hold no
files for. The image uses the same package rather than an INSTALL at build: one way for both, every file held to its
pin, `inet` too (the INSTALL had only `postgres`), and found by path, never under `$HOME`, which a container run as
another uid does not have. `cli/` has no lock of its own: `npm ci` there refuses a lock without the platform packages,
and they are published in the same release run as the CLI.

**Measured, DuckDB v2.0.0** (each package holds both files; a user downloads one):

| platform | postgres | inet | packed | installed |
|---|---|---|---|---|
| darwin-arm64 | 45.9 MB | 11.3 MB | 17.0 MiB | 54.6 MiB |
| darwin-x64 | 47.6 MB | 11.3 MB | 17.6 MiB | 56.3 MiB |
| linux-arm64 | 56.5 MB | 14.6 MB | 21.1 MiB | 67.8 MiB |
| linux-x64 | 59.2 MB | 14.9 MB | 22.4 MiB | 70.7 MiB |
| win32-x64 | 52.1 MB | 46.4 MB | 31.0 MiB | 93.9 MiB |

A machine's first copy downloaded the postgres extension anyway, so what an install adds is the inet extension (and
the download moves from the first copy to `npm install`).

### Memory and the machine

DuckDB's limit is half the RAM (its own 80 % let the system kill the run), in one process with V8 and two PGlites; a
wide JSON column is disk-bound past RAM (the test server, a 28 GB table: `payload->>'key' IS NOT NULL` over 22 M rows
93.5 s, against 15 s on a ClickHouse beside it): `.claude/rules/duck-memory.md` "Memory and the machine". **What a copy costs
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

### The Node CI runs on (2026-10-30)

**Incident.** From 2026-10-29 CI's `checks` job failed one test file after every test in it had passed, at the file's
exit: `# Check failed: jit_page_->allocations_.erase(addr) == 1.` in `ThreadIsolation::UnregisterWasmAllocation`, on
Node 24.22.1. Five runs in two days on five unrelated branches (about one `checks` run in thirteen), always a file that
loads WebAssembly: `tests/duck-json-columns.test.ts` three times, `tests/postgres-api/catalog.test.ts` twice. It is a
V8 bug, nodejs/node#66366: V8 13.6 (Node 24) keeps the wasm-to-JS import wrappers in ONE cache for every isolate of a
process, and a wrapper the wasm code GC is freeing can be looked up by another thread and freed a second time; fixed in
V8 by 9b8ca54d5a ("Fix lookup of wrappers marked is_dying"), in Node 26's V8 and absent from Node 22's (whose wrappers
are per isolate), and in no Node 24 release yet (backport nodejs/node#66376, open). Mason meets it by design: PGlite on
the catalog's worker and the function worker, libpg-query on the parser's, each its own isolate in one process, and a
worker terminated whenever a catalog stops, is replaced or idles out, or the process ends.

**Decision.** Every workflow runs Node 26 (`ci.yml`, `release.yml`), held by `tests/conventions.test.ts` ("no workflow
runs Node 24"). Closing every instance before the exit was not it: both files already stop every catalog they start
and close every PGlite they open (`finally`), and stop the parser in `after`, and the death of an instance is what
feeds the code GC that races: closing earlier moves the race, it does not remove it.
`--no-wasm-code-gc` does make the double free unreachable on Node 24 (V8 13.6 frees a wrapper only through the code
GC's `DecRefOnDeadCode`, which the flag never triggers), but it reaches only the processes `node --test` starts: Node
refuses it in `NODE_OPTIONS`, so the `mason` children the CLI tests spawn and the integration jobs' `mason serve` would
still run with the bug. Node 26 removes the code that races, in every process CI starts.

**Measured**, on CI's runner (ubuntu x64, 4 cores), the two files it hit run as three processes at once
(`duck-json-columns` twice, `catalog` once) beside one CPU-bound process, in a loop for 15 minutes, 15 jobs an arm:

| arm | file processes | the CHECK | jobs it failed |
|---|---|---|---|
| Node 24.22.1 | 537 | 9 (5 `duck-json-columns`, 4 `catalog`), the CI frames to the address | 7 of 15 |
| Node 26.13 | 621 | 0 | 0 of 15 |
| Node 24.22.1, `--no-wasm-code-gc` | 522 | 0 | 0 of 15 (one timing flake) |

At Node 24's 1.7 %, none in 621 is a chance of about 3 in 100,000. A full suite does not show it on demand: none in 20
full suites on each of the three arms (the suite is green on 26), none in 120 runs of `duck-json-columns` in an arm64
container under 1 and 2 CPUs on Node 24 and 26, none in 20 runs of a PGlite and libpg-query worker churn under
`--stress-wasm-code-gc` there. Upstream's reporter: 0 in 191 processes with the two V8 commits on Node 24, 8 in 149
without, and none on Node 26.10.

**Still true.** The image (`docker/mason-data.Dockerfile`, `node:24-slim`) and a user's own Node 24 still carry the bug,
and `mason serve` terminates a catalog worker at every idle stop: there it is a rare abort the supervisor restarts.
Lift the guard when a Node 24 release carries nodejs/node#66376.

### The turn (2026-10-31, issue 127)

**Measured** on a synthetic 17 M-row table, 10 cores: while `to_char` ran, a probe on the executor's thread saw 999 function
calls between two turns of its loop, each turn 2.2 to 3.3 s, 9 turns in the statement's 8,301 calls; CPU equal to wall
time. A `select 1 from small limit 1` needs about eight turns, and took 22 s (31 s beside `@>`, up to 17 s beside a
numeric bin; a real deployment saw 37 to 57 s). The binding (`duckdb_thread_callback.h`, v2.0.0-r.1) gives each scalar
function one thread-safe function and blocks the calling thread until the synchronous JavaScript returns; Node's
dispatch stops at an empty queue or 1,000 calls, and with two callers the queue is never empty.

**The decision:** a thread leaves the running queue between two calls, so the queue can empty. `__mason_turn` is a second
thread-safe function, called before each vector; a thread that finished a call waits there, and that queue is served only
after the running one returned to the loop. A turn is then one call per DuckDB thread, 999 becomes about 10, and a small
statement's wait is about eight turns of N × a vector's time, whatever the statements running.

| Small statement beside it (median / worst) | Before | After |
|---|---|---|
| `to_char`, 17 M rows | 22 s | 283 ms / 533 ms (843 ms / 1.8 s at load 38) |
| jsonb `@>`, 17 M rows | 31 s | 473 ms / 1.4 s |
| numeric bin, 17 M rows | up to 17 s | 194 ms / 319 ms |
| `to_char`, 3 M rows, two at once | | 693 ms / 1.2 s |

The heavy statement's own CPU did not move past the noise of a shared machine (`to_char` 30 s and 21 to 41 s of wall time
alone, 5.6 and 5.4 s of CPU over 3 M rows). The body is O(1): the session handed on as a constant vector.

**Rejected, measured:**
- DuckDB `threads = 1`, the same emptied queue by another road: 20 ms beside one heavy statement, 7.4 s beside two, and
  every native statement of the instance on one thread.
- More threads for the functions: a scalar function runs on the thread that registered it, and a connection is a Node
  object of the thread that made it, so a second thread cannot register on the instance. A compute pool behind the
  call does not help: the call still waits, synchronously, on the loop's thread.
- A priority for short statements: nothing in DuckDB or Node's dispatch to set one on; the queue is first in, first out.
- JavaScript that yields inside a call: the binding has no asynchronous return, and Node has no way to turn a loop from
  inside one.

**Native expressions are not rejected, they are the next step** (issue 130): `strftime` took 436 ms where `to_char` took
23 s, a decimal division 339 ms where the bin took 15 s. Each must be proved exact shape by shape first, and any function
left in JavaScript needs the turn all the same.

**What remains:** a very wide document's vector still takes as long as it takes: a turn is N of them.

### The pool (2026-10-31, issue 88)

**Measured:** a statement in flight holds a libuv thread, so at Node's four a fifth waits for one: five `to_char` at once
left a small statement a worst case of 28.6 s, 1.6 s with `UV_THREADPOOL_SIZE=16` and nothing else changed. A small
statement beside N heavy `to_char`, on the real listener and store, with the machine's other work at a load of 12 to 22:

| | N | pool 4: p50, worst | pool 64: p50, worst |
|---|---|---|---|
| 10 cores, 3 M rows | 2 | 250 ms, 0.9 s | 238 ms, 1.0 s |
| | 5 | 259 ms, 16.1 s | 295 ms, 0.8 s |
| | 8 | 239 ms, 39.2 s | 368 ms, 1.0 s |
| 2 vCPU (`--cpus=2`), 1.5 M rows, three runs | 2 | 69-113 ms, 2.2-4.8 s | 56-321 ms, 1.2-7.9 s |
| | 5 | 82-128 ms, 10.9-14.9 s | 134-801 ms, 0.4-2.1 s |
| | 8 | 73-430 ms, 25.6-52.9 s | 294-405 ms, 0.8-2.1 s |

The heavy statements' own time did not get worse, and at 2 vCPU it varied more with the machine's other work than with
the pool. The small p50 rises because more statements really do run at once. The worst at two heavy is the same either
way: it is not the pool.

**Memory is not the limit.** The bench's process idles at 216 MB with 4 threads, 219 MB with 64 and 222 MB with 256: a
parked thread touches a few kilobytes of its stack. The real image at 2 vCPU, 64 beside 4: 292 MB and 292 MB, then 298 MB
and 269 MB after a restart, 621 MB and 563 MB after a first start. So a few tens of MB at most, within the noise of one
sample. Peak RSS under load showed no pattern (687 to 912 MB at either size). Threads, read from the process: 81 at
2 vCPU where a pool of 4 has 21, exactly the 60 more; 121 at 10 CPUs.

**Why 32, a number and not derived.** The size was to sit above Mason's limit on running statements, and there is no
such limit: one statement runs per session, and `CANCEL_SLOTS` allows 4,096 sessions, past libuv's maximum of 1,024.
Past the pool's size, libuv's queue is the admission, first in, first out. 1,024 was tried and refused: libuv starts
every thread at the pool's first task and aborts with no message if one cannot be made, so `--pids-limit=300` ended the
process with exit 133. 64 was the first choice and the table's; the review chose 32, because nothing was measured past
eight statements, 16 already fixed five, and the old queue was the only limit on how much memory statements take at
once. So 32 covers the same data with half the thread exposure (at 2 vCPU, eight heavy, one run: p50 321 ms, worst 1.5 s, 32 s of wall time). An admission
limit would be the one fact to derive this from; it would be new behaviour, so it was not added here.

**A thread limit is read, because its failure is silent.** A platform restarting a process that aborts with no message
is a loop nobody can read. `src/cli/pool-size.cjs` reads `pids.max` (both cgroup versions) and `Max processes` first, and
a run is taken to need its size plus 20 plus five a CPU, more than the threads real runs were read to have (about 40 plus
five a CPU at 32: 49 at 2 and 89 at 10, each 32 below the 81 and 121 read at 64). Below that the default is lowered to
fit, never under 4, and said once, by the commands that start a run; a size of the operator's own that does not fit
refuses the start. So does one that is not a number from 1 to 1024: `abc` would run one thread and `-1` 1,024.

**Windows:** `process.env` never reaches libuv's getenv there, so the size set here does nothing and the pool stays at
four unless the shell sets it. A re-exec would cure it and was refused; the docs say so instead.

**Early enough:** `process.env` at the top of an ES entry was measured on Node 22.13, 24 and 26, on a pool counted by
parking its threads on FIFOs. On 22.13 the pool had started with four threads before the first line ran, even with no
static import, because the ES loader reads its files through it; on 24 and 26 it had not, and a first import is enough.
A CommonJS entry got its size on all three, so `src/cli/mason.cjs` is the `bin`, the image's `mason` and the run's
command, and `main.ts` imports `pool-size.cjs` first for `node src/cli/main.ts` in a checkout, which needs 23.6 or later.

### Local gates (2026-10-30)

**Measured**, over 117 agent transcripts: local test gates were 48 % of active time, and a third of that (13.5 of 39.7
hours) was contention from gates running at once. Load reached 153 on 10 cores. `npm run check` took about 174 s with
nothing else heavy running and about 1,012 s beside three or so others, and parallel gates made load-sensitive tests
fail, which caused more runs. Eighteen check reruns on an unchanged tree cost 2.2 hours. `scripts/fails-without.ts` was
200 runs and 9.0 hours, with about 4 % of verdicts anything but `PROVED`; swapping `src/` in place cost one session 1.45
hours of its 3.1, the tree blocked. Of 47 local full-suite failures across 194 runs, about 4 or 5 were real catches in
another file, all of them fast convention or matrix tests. Recent changes reach 86–91 % of unit test lines by imports,
so no list of affected tests can be computed. One agent ran the full integration suite 27 times on one PR. A flake's
fix cost about 1.75 hours plus a review.

After a PR opens, 31 % of the time follows a merge of main, with 46 full gates re-run across 34 merges, most of them
without a conflict. Gates that directly follow a merge total only 1.47 hours; the rest is entangled with a review's fix
edits, so the rule against merging main is not credited with more.

**What CI tests.** A `pull_request` run checks out `refs/pull/<n>/merge` (run 41099689116: `Merge a62e4f5 into 785b7af`,
the head into main at that push), so a merge is tested without a local merge, as of that push and no later. `main` has
no branch protection and no ruleset (`gh api`, 2026-10-30, before the owner added one that evening: `CLAUDE.md`), and `ci.yml` has no `merge_group:` trigger, so nothing
stops a red merge and nothing tests the merge as it lands: the 25 most recent merged PRs were all green because whoever
merged read them, and the `push` run on main is what sees a skew.

**The slot's default.** Parallel check-equivalents (`tsc`, then the unit tests) at once, each in a copy of the tree, on
the 10-core laptop on Node 24.18, while other sessions ran their own gates: the machine was never idle (load 18 to 51 before a
round, 38 to 47 on average during it), so these compare arms under the same disorder and do not repeat the 174 s.

| at once | wall of the round | gates per hour | failed or cancelled tests per run |
|---|---|---|---|
| 1 | 885 s, 559 s | 4.1, 6.4 | 1 |
| 2 | 1,026 s, 805 s | 7.0, 9.0 | 3 to 5 |
| 3 | 1,012 s | 10.7 | 8 or 9 |

The count leaves out two tests that failed only because the copies shared one index, which is this measurement's fault.
No run was green: one timing test failed in six of the nine runs, both of those alone among them. From 2 up, the demo's
and the executor's tests hit their timeouts, and a failed gate is a gate to read and run again, so its hour is not a gate. Four at once was stopped, the brief's 1,012 s being that case. The default is 2:
the most that still adds gates per hour without the failures taking them back, on a machine that is rarely idle. On an
idle one 1 may do better (174 s is about 21 gates an hour); `MASON_GATE_SLOTS` changes it. Once sessions queue, a gate
meets less load than these did, so this deserves measuring again.

**Decisions.** The queue is a folder of tickets, a bakery, so that it needs no lock of its own and a stale ticket can be
removed by a name no live run can hold (`scripts/gate-slot.ts`). The folder is `/tmp`, not `$TMPDIR`, which is per
session in a sandbox. `fails-without` copies into a linked `git worktree`, because `tests/conventions.test.ts` reads
`git ls-files` and a plain copy would fail it on both sides. A killed run's test runner reports failures by name, which
read as a proof, so an interrupted run now has no verdict.

**A wait with no limit (2026-10-31).** An agent ended its turn on a background unit suite and waited for the
notification; one test had deadlocked, so the job never exited and nothing came. It sat for 2h07 with 0.43 s of CPU,
shown as completed. Across that day's agents, about 31 of 115 agent-hours were idle until a notification or message
arrived and about 11 went on sleep loops, against about 4 running the oracle.

**The bound on a test (2026-11-02).** Measured on Node 26.13.0 over a test that never settles and holds an interval:
`--test-timeout` alone names it (`test timed out after 2000ms`) but its file's process never exits, so the run does
not end (alarm-killed at 20 s; on Node 24 still alive at 73 s); with `--test-force-exit` beside it the run exits 1 in
about 3 s, the test listed under `✖ failing tests:`. The 2h07 hang above held a handle (0.43 s of CPU, never exiting,
where a deadlock with no handle ends by itself with `Promise resolution is still pending`), so the timeout alone would
not have ended it: the bound is the pair, before the files (after them both are dropped silently, as is a
`--test-name-pattern`; `--test-timeout=0` is no bound; a test's own `{ timeout }` overrides the default; the bound is
per test, hook and suite, never per file). The value is read from CI, not guessed: across the 15 unit-shard logs of
main's five latest green runs the slowest test took 150.0 s (the state matrix), then 143.3 s and 128.0 s, and one test
varied 1.9x between runs (58.8 to 111.5 s), so the default is twice the slowest, 300 s (`TEST_TIMEOUT_MS`,
`scripts/gate.ts`), and CI's unit shards carry it. The trade: `--test-force-exit` turns a handle leaked after a file's
last test from a hang into a pass, and that hang never named anything (only CI's 30-minute job timeout ended it).

**A turn ended with nothing to wake it (2026-11-01).** Two issue leads, each running one Opus agent at a time, were
read from their transcripts over seven hours: an agent worked 34% and 21% of the wall clock. Of the rest, about 3.5 h
per lead was two gaps in which nothing woke the coordinator. At 02:07 it queued a PR to auto-merge and ended its turn;
the PR merged at 02:12, and nothing ran until the owner's next message at 04:22. At 06:55 it ended a turn, both leads
reported within three minutes, and their reports reached it only with the owner's next message at 08:08. Waits for
the coordinator's own reviews took about 35 and 47 min per lead, and a red oracle over a clock change about an hour.
Inside the agents the largest single cost was test runs: a 100 s test file run whole, and `fails-without` over it twice
per proof, 36 min of one issue's agents in three proofs (2, 13 and 20 min, each of which built a
copy of the tree as well); 43 min of commands ran past their own foreground limit and were moved to the background.

The same day the waits that replaced those gaps were found late twice over. They slept 120 s between looks, and the
one on a PR sent back for a fix watched only for its branch's next head, so its CI's red oracle was seen only when the
next push woke it. And two PRs queued to auto-merge at a reviewed head were found still queued at a later, unread
head: GitHub keeps a queued auto-merge across a push by someone with write access, and `--match-head-commit` is checked
only when the merge is queued. The first replacement, `gh pr checks --watch --fail-fast` bounded by a perl alarm, was
wrong twice more: `--watch` exits at once, as a failure, on a PR whose checks have not registered yet (just after a
push), and the alarm, `exec`'d into `gh`, is caught and ignored by Go's runtime, so the bound bounded nothing (a 3 s
alarm still running at 67 s). The waits became a loop of `gh pr checks` with a deadline, reading its exit code (0
passed, 8 pending, 1 failed or no checks yet), and a PR sent back has its merge withdrawn.

"No checks yet" was a wait that could not end. On 2026-11-01 PRs 231 and 233 went into conflict with main after PRs
202, 245 and 250 merged, and their CI waits sat to the deadline, then reported a timeout that did not name the cause:
GitHub runs no `pull_request` workflow on a PR with a merge conflict, so its new head never gets a check (issue 255).
Each pass of a wait now reads `gh pr view --json mergeable,mergeStateStatus` before the checks, and CONFLICTING is its
own verdict, even over a finished run (233 kept its old head's run), while UNKNOWN, which GitHub computes lazily, is a
wait. Two other doubts were checked against GitHub's docs: a draft PR gets CI (`opened` has no exception for drafts,
and ci.yml has no draft condition), and a workflow skipped by a `paths:` or `branches:` filter would leave its required
checks pending, but ci.yml has neither. Auto-merge lists no conflict among what switches it off, so a merge wait reads
`mergeable` too.

A brief names the shapes its tests must hold because on each of the three PRs of 2026-10-28 the first fix round was for
a shape its brief had left out, and the tests its runs use because one issue's agents spent 36 min proving a whole slow
file twice.

## A libc order, read level by level

Issue 128: under en_US.utf8 one value holding U+FE0F (`❤️`) or a Thai vowel refused a whole column's sort, group and
dropdown, and the refusal quoted the row. The order until then was glibc's first and last levels, read from the source,
with ICU's accent and case levels between them over the letters, and anything those could not say was refused.

A real `strcoll` was not an option: the source's costs a round trip per value (and sends it a row), and the process has
no libc call, nor this table: its glibc, if it runs on one, is another version. So the levels are read too.
`iso14651_t1_common` and `strcoll_l` were read to learn what to read, never shipped: a simulator of them written from
that table matched Postgres 18 / glibc 2.41 on every one of 20,000 random strings of Latin and marks, once it had the
two things no document says. `<SPECIAL>` (digits, symbols, punctuation, marks) is `backward` at the second level, and
`get_next_seq` decrements `backw` twice, so a run of two or more closed by a forward element skips the element before
its last: that is why `1-X < 1x`, which the registry had called a difference (`libc-symbol-punctuation`, gone). And a
code point the table does not list is one element per byte of its UTF-8 (`findidx` takes the lead byte), so `U+0378`,
`U+E000` and `U+F0000` differ at the last level by their length.

What the source is asked, by comparisons alone, so another table answers for itself, is in the header of
`src/duck/libc-order.ts`. A spelling is proposed by Unicode's data and kept only when the source says so; a character
whose neighbours or whose random pairs the key orders otherwise than the source may go uncovered, by the verdict below.
Under `en_*` nothing is refused, on any C library (the second review: Tom's rule, 2026-10-31).

The verdict of that holding (`holdLibcOrder`) is a branch, on two rounds of pairs (random, ASCII alone, Latin alone,
neighbours of a class and of the Latin letters: 35,800 in all), every pair counted, ASCII included. The review of PR 135
found the first form of it only uncovered characters, skipped a pair that differs in ASCII, and sampled 6,000 pairs, so
tr_TR answered silently wrong on 493 of 20,000 ASCII pairs (`'W' < ')W'`). Now:

- **`en_*` is never refused** (`isPlainTable`, by name: every glibc `en_XX` is `copy "iso14651_t1"`, en_CA's capitals first
  being asked of the source like any other case). Not a letter, a mark, a digit or a symbol, not `€` or `㏩` or a private-use
  code point, not on a C library this read cannot follow: one seeded pair could otherwise refuse a column, and another
  glibc gives other pairs, so an OS upgrade could break a customer. What differs stays as it was read and is recorded in
  both rounds' counts, told into rare and common: the log and mason status's `Text order` line. Those are the decided
  differences `libc-rare-letter` and `libc-mark-run-form`. What no level was read of falls to the first level and the bytes.
- **Any other locale** has a rare character (at or above U+0250) that differs uncovered; a pair that differs in ASCII or
  Latin alone leaves nothing to uncover, and the table is not followed: `libc-locale-unread`, every text ordered under it
  refused with the way out `COLLATE "C"` or an ICU collation, the copy serving everything else, and no exit at the start.
  A locale is not told plain by its name beyond English's, so de_DE or fr_FR, the same table, are held by measurement.
- **A byte-ordering strcoll** (musl's, macOS's) is that, read first from eighteen code points: the collation is `bytes`.
  A strcoll with no level of glibc's (no punctuation ignored) is not followed.

Measured on Postgres 18 / glibc 2.41, each read's verdict:

| locale | verdict | 40,000 random ASCII and Latin pairs after it |
|---|---|---|
| en_US, en_GB | followed, nothing refused, what differs recorded | 0 differ |
| de_DE, fr_FR, th_TH | followed, 102, 102, 97 rare characters uncovered | 0 differ |
| tr_TR, sv_SE, cs_CZ | not followed (802, 41, 26 pairs, of ASCII or Latin) | refused |

Measured against that Postgres, 60,000 pairs of random strings a script, a pair mostly one edit apart, read through
`libcKey`: Latin and marks, emoji with their selectors, skin tones and joiners, Thai, Lao, Arabic with its marks,
unassigned and private use: no difference. Ligatures and compatibility forms in mixtures no column holds: 12. Greek
with Cyrillic: 1. Indic scripts in one string with Kana and Hangul: 4. Reading it costs what it did and a little (the
one sort, 45–55 s on the loaded test laptop, 13 s on the server; the other 190 queries, 3 s). A row costs one JavaScript
call where it cost two and ICU's key (1.9 µs against 2.6 µs of JavaScript alone, a value of 20 characters; the key is 16 %
longer, its accent and case levels counted so plain letters cost one token), so issue 127's hop count fell with it.

One difference is left in those scripts, about one pair in 20,000 of random text, decided and listed
(`libc-mark-run-form`): a mark skipped in a run (mark, punctuation, then a letter) moves the third levels one along, so a
letter of a form of its own (`ß`, `ð`, `æ`, COMPAT in the table) meets a digit's MIN. Case is read within a letter, and
across letters has no measure. glibc's one scale could be read, a reference letter's variants and every other letter
placed among them by the same binary search, but through a shifted string for each letter, a new query shape over all
159,865 characters, for this one shape: the review's remedy of a decided difference was taken.

ICU had the same class in another place: U+FE0F is ignorable there, so `x` and `x` + U+FE0F tied, and a tie is two
strings Postgres orders by their bytes. A sort under ICU now ends in the bytes, and `<`, GREATEST, min and max compare ICU's key and the bytes.

## Measurements

### The stored fold, larger than memory (issue 124 stage 5, 2026-11-02)

**The question.** Issue 124's live table would keep a generated table current by folding each stream batch into its stored rows ("How a table stays current", steps 1-7, with the time bound). Does that cost an acceptable writer time per batch, and keep dashboard statements under 3 s at 4 users, when the data does not fit in memory and statements run beside it? `scripts/bench-fold.ts` drives the steps by hand on the real engine. The recompute's SQL comes from the planner over a swapped relation, on one connection set up by `SessionSetup`, in one transaction per batch. The thresholds were set before the run (`THRESHOLDS`).

**The setup.** One `mason-data` container: 4 GiB, no swap, 4 CPUs. The engine's limit was Mason's default, 2.0 GiB. Its data sat on a named volume whose device was throttled to an EBS gp3's 125 MB/s and 3,000 IOPS; the cold read rate measured 123 MB/s. The data, synthetic: 26.1 M events over 90 days in heap order. A ~1.5 kB high-entropy JSON column made the file 20.0 GiB (5.0x the container's memory): the key columns the fold reads take 0.55 GiB, the JSON 19.5 GiB. The generated tables are `requests` (9.39 M rows, ~0.2 GiB) and `daily_durations` (45,000 rows) over it. The clients ran S1-S7 for the largest tenant (8 % of the rows) and the median tenant: S1-S5 over the generated tables, S6 (a JSON key) and S7 (the fold at read time) over the base.

**What it measured.**
- **A whole re-run of both tables took 15.5 s** (0.34 GiB read from the disk). This is the relevance check, T4: under 60 s, so a scheduled table with `target_lag: 1m` keeps these dashboards within a minute without the fold.
- **The writer alone** (40 batches each, back to back, p95):

  | batch | base write only | with the fold |
  |---|---|---|
  | 6 rows | 9 ms | 289 ms |
  | 60 rows | 15 ms | 249 ms |
  | 1,000 rows | 234 ms | 1.44 s |

  The cascade into daily_durations (step 7, which reads the touched days' `requests` rows) is most of the fold: 125-176 ms at p95. Step 1 with the JSON column added to its list read 31 ms at p95 against 6 ms. An unbounded recompute (the touched groups' whole history) took 1.19 s at p95 against the bounded 21 ms, with the same rows in all 20 compared batches.
- **Beside 4 users the disk was the bottleneck, for both writers.** The throttled disk read 40.4 GiB over the together phase, mostly S6 and S7 reading the wide column over the base. These statements alone already had a set p95 of 3.69 s (7 days) and 57 s (30 days). Results:
  - The fold's batch p95 was 43.9 s at 6 rows every 0.5 s and 41.0 s at 60 rows every 5 s. Every batch was late, and the lag grew to 4-5 minutes.
  - Today's base write alone, under the same load, had a p95 of 6.76 s at 6 rows every 0.5 s. Its lag grew to 2.7 minutes.
  - The 7-day statements over the generated tables (S1-S5) had a p95 of 58 ms alone, 272 ms beside the base write and 1.29 s beside the fold.
- **Correctness**: after every phase, both stored tables equal their definitions run whole (`EXCEPT ALL` both ways). The bounded recomputes equal the unbounded ones.

**The thresholds.**

| threshold | result |
|---|---|
| T1 (writer p95 at most half the interval) | fails: 43.9 s against 250 ms, and 41.0 s against 2.5 s |
| T2 (fold's added p95 per 60-row batch at most 1 s) | fails: 40.9 s |
| T3 (S1-S5 p95 at most 3 s, rise at most 25 %) | fails on the rise (58 ms to 1.29 s), although the p95 itself stays under 3 s |
| T4 (a whole re-run at least 60 s) | 15.5 s: live buys little at this size |

**The decision it informs** (Tom's, issue 124). The numbers argue against stages 6-11 at this size. The fold is cheap alone, but beside statements that read a wide column from a disk of a gp3's rate, it stalls the stream for tens of seconds. It also triples what the stored tables' statements cost. Meanwhile a whole re-run of the same tables takes 15 s. Two caveats are part of the result, not reasons to discount it:
- Today's writer also falls behind under this load (6.8 s at p95). Part of the failure is the disk shared with S6 and S7's wide reads, not the fold itself.
- At 6 rows the fold misses T1 even alone (289 ms against 250 ms).

Detector: the report `scripts/bench-fold.ts` writes, re-run with the same command when the shape changes. A wider base, a table whose re-run takes minutes, or a faster disk would each change the answer.

### A top N over joined tables (issue 105, 2026-10-31)

A table preview over three tables (`a` 17 k rows, `b` 1.4 M, `c` 2.8 M with 4 kB of JSON, 4 M joined rows, synthetic, on a
laptop with DuckDB's limit at 2 GB) sent DuckDB carries every selected column through the join and the top N: its plan is
two hash joins under the Top N, every row group of `c` read. DuckDB's late materialization stops at a join. Its pushed
filters did not help: the LEFT JOIN is planned RIGHT, `a` on the build side, so the top N's filter arrives after the build.

| Selected, same join, LIMIT 100 | before | by row number |
|---|---|---|
| `a.*, b.*, c.*`, sorted by `a` | 12.9 s, 8.6 GiB spilled, 2.2 GiB RSS | 0.19 s, none, 0.5 GiB |
| the same, winners scattered through `c` | 18.5 s, 8.6 GiB spilled | 0.25 s, none, 0.7 GiB |
| LIMIT 10,000 | 53200 after 1.0 s | 2.9 s, none |
| LIMIT 200,000 | 53200 after 2.4 s | 3.8 s, none |
| LIMIT 100 OFFSET 2,000,000 | 53200 after 2.9 s | 0.38 s, none |
| the three ids alone | 0.06 s | 0.04 s |

Each row is one run of a warm page cache, the engine's statements only. Through the real listener, the first row as the
tool spells it: 14.06 s, 8.54 GiB spilled, 2.59 GiB RSS before; 1.19 s, none, 1.38 GiB after, a first statement's cold catalog included. The fetch by `rowid`
is cheap because the join's filter on `rowid` skips row groups. No limit on N is needed, and no width test: the narrow
statement costs nothing. Spill's ceiling, measured on a 1.4 GB volume: DuckDB's `90% of available disk space` is read when
it first spills (778.8 MiB of 865 free), stays that number, and failing against it is an `Out of Memory` error naming the
setting; with 600 MiB taken from the disk afterwards the next sort ended in `IO Error: Could not write file …`. Lowering
the setting under what is spilled at that moment is refused, and the statement goes on. A failed statement's files are gone at once.

**The same preview with no ORDER BY** (a real deployment: `LIMIT 100 OFFSET 0`, no sort, tens of GiB spilled, a last table of
about 100 M rows). It streams, and stops at the LIMIT, only where the wide table is probed; where the rows before it are
the more numerous (below, 8 M narrow rows before a 3 M-row table of 4 kB JSON) the wide table is the hash join's build side,
and every wide column is held before the first row comes out. Each cell one run, the engine's statements, a 2 GB limit:

| `LIMIT 100`, no ORDER BY | before | by row number, sorted by them |
|---|---|---|
| outer rows one-to-many | 9.02 s, 4.21 GiB spilled | 0.27 s, none |
| the same, `OFFSET 2,000,000` | 8.23 s, 4.12 GiB spilled | 0.37 s, none |
| outer rows many-to-one | 6.19 s, 3.91 GiB spilled | 0.04 s, none |
| the same, `OFFSET 2,000,000` | 6.89 s, 4.06 GiB spilled | 0.58 s, none |
| an empty table between | 7.73 s, 3.97 GiB spilled | 2.16 s, none |
| the same, `OFFSET 2,000,000` | 8.04 s, 4.05 GiB spilled | 3.89 s, none |
| a small outer table, the wide one probed (no spill before) | 0.05 s | row numbers alone: 0.03 s against 0.07 s streamed |

Why the row numbers are sorted, when any 100 rows of the join are a right answer: **pages**. Without a sort, DuckDB's
parallel hash join gives the same statement's rows in another order each run, so `LIMIT n OFFSET m` over them is no page of
one list. Paging joins of 0.7–1 M rows to their end, with a plain statement, in pages of 100,000: 222,912 to 366,176 rows came back twice and as many
never, most pages differed when asked twice, and at `LIMIT 100` over the first 3,000 rows one of four joins already repeated
152; one thread: none; sorted by row number, the same five joins paged: none repeated, none missed, every page alike when asked twice. Postgres promises nothing here either, but a fixed plan gives it in practice, and a tool's preview
pages. The numbered form (`row_number() OVER ()` over the chosen rows, kept outside) cost 0.04 to 0.08 s where the sort costs
0.04 to 0.58 s and kept that overlap.

**The sort has a price, accepted for stable pages.** A top N over row numbers is a full join where a streaming LIMIT stops
early, so its cost grows with the join, and a narrow join that used to stop early pays it with nothing spilled to save. An
unsorted row-number inner query costs about what the old plan did, at the price of overlapping pages. Over a 50 M-row table,
min of 3 warm runs:

| Narrow join, no ORDER BY | old plan | sorted by row number |
|---|---|---|
| `big JOIN dim LIMIT 100` | 4 ms | 4 ms |
| `big JOIN big2 LIMIT 100` | 502 ms | 519 ms |
| `big JOIN dim LIMIT 100 OFFSET 2000000` | 4 ms | 324 ms |
| `big JOIN big2 LIMIT 100 OFFSET 2000000` | 465 ms | 1286 ms |
| `dim LEFT JOIN big LIMIT 100` | 1 ms | 134 ms |
| `dim LEFT JOIN big LIMIT 100 OFFSET 2000000` | 10 ms | 1332 ms |

`LIMIT -1` is refused 42804 where Postgres says 2201W, with or without a join: not this path's.

**The sort only where the join is proved bounded (issue 134, 2026-10-31).** That price was measured on joins that do not
multiply. Where a join multiplies, the top N over row numbers runs the entire join, and a statement that used to stop in
milliseconds runs for minutes. So the row numbers are sorted only where `fanOutBounded` (src/duck/distinct-key.ts) proves
the join's rows linear in its tables: every join equates a whole primary key of a table its side holds at most once, from
the analysis and the catalog's `pg_index`. Elsewhere they are not sorted at all, inside or out. An EXPLAIN's estimate
would cost about 8 ms and can be wrong; the proof costs one catalog read, only for such a statement, and cannot.

The key must be unique in its SIDE, not only in its table: `a JOIN b ON a.id = b.a_id JOIN c ON a.id = c.a_id` equates a's
key twice, yet an `a` of a thousand `b`s and a thousand `c`s is a million rows, because the first join repeats `a`. A join
therefore passes on as held once only the tables of a side whose every row it matches at most once.

A million-row table and a 500,000-row one of 3.2 kB text (which compresses well), ten values of the join column, 2 GB
limit, through the listener. After: minimum of 3 warm runs. Before: minimum of 3 warm runs on a machine under load 15 to
50, so read the orders of magnitude.

| `LIMIT 100`, no ORDER BY | before (sorted row numbers) | after (row numbers, no sort) | plain join |
|---|---|---|---|
| many-to-many, 100 billion joined rows, two ids | 72.1 s | 16 ms | not measured |
| the same, reading a text column | 66.9 s | 16 ms | 14 ms |
| many-to-many over the wide table, 50 billion rows, reading it | 37.6 s | 10 ms | 135 ms |
| proved many-to-one, wide on the build side: unchanged, sorted | 37 ms | 37 ms | not measured |

The unsorted form holds the issue's measurement: it costs what the plain join does, and it still leaves wide columns out of
the join, where reading them through it was slower.

**What is given up.** A join the proof does not bound can overlap its pages again, as before PR 118: `LIMIT n OFFSET m` over
a many-to-many join, a cross join, a key in part, a table with no primary key, or a key equated with an expression can
show a row twice and miss another. A tool paging such a join to its end sees that. Each answer is still rows of the join,
each as often as the join holds it, so the proof decides cost and pages, never an answer, and the safe side of a failed
proof is no sort. A sources file's `key:` is allowed only on a table with no primary key, and the catalog then declares
none, so such a copy goes unsorted too. The comma form is proved on the WHERE's conjuncts; a join's condition moved to the
WHERE over a `CROSS JOIN` is not.


**A join's FROM items (issue 134, step 2, 2026-10-31).** `joinRows` stopped at a table, so a view, a WITH query, a tool's
wrapper and a derived side each carried every wide column through the join again. The issue's comment measured the shapes
by hand; the real rewrite, through the listener, over 8 M facts, 3 M rows of about 3 kB and a 2 GB limit (minimum of three
warm runs, a busy laptop, so compare orders of magnitude; a spill is the temp folder's peak):

| Shape | Before | After |
|---|---|---|
| View over the join, `LIMIT 100` | 5.0 s, 7.0 GiB | 0.13 s, none |
| View over the join, sorted | 12.2 s, 7.5 GiB | 0.15 s, none |
| WITH over the join, sorted | 13.3 s, 7.6 GiB | 0.18 s, none |
| Tool's wrapper, `LIMIT 100` | 10.0 s, 7.4 GiB | 0.12 s, none |
| View as a joined side, sorted | 13.7 s, 7.6 GiB | 0.16 s, none |
| Derived side, unsorted / sorted | 3.4 / 5.7 s, 3 GiB | 0.07 / 0.10 s, none |
| Aggregated side beside a wide table | 1.3 s | 13 ms |
| Narrow derived side, `LIMIT 100` | 12 ms | 12 ms |
| Narrow derived side, `OFFSET 2,000,000` | 21 ms | 45 ms |

Decided: a wrapper folds by substitution, as Postgres pulls a subquery up, because a nested form could not list a `*` of
two columns of one name by position; the substitution is sound because nothing folded is volatile and nothing reads
from outside it. A fetch keeps a nullable side's derived form, and DuckDB moved a computed list above the join in every
plan measured, so a raising value on a row left out stayed unread (`limit-errors`, held by the oracle). A plain read
counts for `fanOutBounded`, its bare outputs as its table's columns; what is carried has no row number and goes unsorted
even where the proof holds. A statement with a role's filtered read kept its form until step 4 reviewed the barrier.

Decided (2026-11-01, issue 134 step 4): a role's filtered read takes the late fetch too, its rows chosen inside the
barrier and fetched through the same filtered read. Three fetches were measured on issue 134 and cost the same: the base
table 177 ms, the statistics wall 190 ms, the whole filtered read 145 ms. The filtered read was chosen because it adds
no new argument: the fetch never hands a list expression the table-wide statistics the wall hides, nor a row the filter
drops, so what the barrier and the wall already proved holds for the fetch unchanged.

**Key-first grouping (issue 134, step 6), decided 2026-11-01.** `GROUP BY` a table's primary key with its wide columns
in the list and a LIMIT carried every wide value through the hash aggregate (the rewrite's `any_value` of each) for every
group, before the limit kept a hundred: on issue 134's dataset it failed with 53400 after 120 s and 29 GiB of spill,
where the hand rewrite took 0.76 s with none. So `keyFirst` (src/duck/late.ts) groups on the whole primary key with
`any_value(rowid)`, applies the HAVING, sort and LIMIT, then fetches the kept groups' rows by row number. It reads
`any_value(rowid)` rather than grouping by `rowid` too, because the copy can briefly hold a key twice, and a group split
by row number would answer two rows where the source answers one. That moment is the reason `distinct-key.ts` trusts no
UNIQUE index that is not the key, since a column the copy is not written by may hold one value twice; the primary key it
does trust because the copy is written by it, and the swap checks as many distinct keys as rows.

**A DISTINCT ON with a LIMIT, by row number (issue 134, task E), decided 2026-11-01.** `SELECT DISTINCT ON (…) … ORDER BY
… LIMIT` with wide columns in the list carried every row's wide values through DuckDB's DISTINCT ON (a window and a
filter) and the top N: on issue 134's dataset it failed with 53400 after 1230 s and 25 GiB of spill, where the hand form
took 0.21 s and Postgres 0.7 s. It is NOT key-first grouping: a DISTINCT ON keeps one whole row of the FROM per group,
the first by the sort, where a GROUP BY's group may hold many rows of a table. So `any_value(rowid)` would be wrong (it
answers an arbitrary row of the group for another table's columns, where DuckDB's DISTINCT ON answers the first), and the
primary-key proof decides nothing: the kept row's row numbers identify it exactly whatever the ON expressions, a key, a
non-key, a computed or a jsonb one, and a key the copy holds twice for a moment is still one row, kept by the DISTINCT ON
itself. It is `joinRows`'s form with the DISTINCT ON inside, one table included, because DuckDB's own late
materialization does not reach through the window and filter its DISTINCT ON is. What is given up is `limit-errors`: a
raising list value in a row that is not its group's first now answers. The task's brief wrote two of its "legal odd
forms" with a sort key between the ON expressions (`DISTINCT ON (a, b) … ORDER BY a, c`), which Postgres refuses with
42P10; the legal form is a sort that is a prefix of them (`ORDER BY a`), Postgres appending the rest. The review of
PR 207 found that the engine was sent the sort as written, not Postgres's with the rest appended, so a LIMIT kept other
groups in another order (at the base too, in the form sent as written): the rewrite now appends them to the statement's
sort before any key is built (`distinctOnSorted`), so every form sent sorts as Postgres's Unique does. It found too that
a jsonb ON named by its output compared the value's text, not jsonb's equality (only an ordinal was resolved), and that a
numeric quotient under a DISTINCT ON or a DISTINCT was the engine's double's text, as no cell rode beside it. Its
second round found the same text through a DISTINCT over a pass-through (`SELECT DISTINCT * FROM (…) s`: whether the
cells ride was decided per form), and that every DISTINCT, GROUP BY and `=` compared a quotient's double, so
1.00000000000000000001 and 1.00000000000000000002 were one group (pre-existing at the base). The class round's decision:
a numeric the plan decides exactly is equated by its exact program's value (`exactKey`), the pass-through's DISTINCT keyed
by the inner query's cells, and what cannot take a key refused by name; IN and the order of quotients equal to 17
digits are a listed difference, since a key there would have to sort as a numeric does.

**Step 3: `USING`, `NATURAL` and computed keys.** Through the listener, a 2 GB limit, 8 M facts beside 3 M rows of about 3 kB
that compress well (346 MB on disk, so the spill and the seconds before are smaller than the issue's 9.1 GB of noise; the
minimum of warm runs, a machine at load 28):

| Shape | Before | After |
|---|---|---|
| `USING`, sorted | 3.7 s, 2.5 GiB | 0.15 s, none |
| `USING`, LEFT, no sort | 1.9 s, 2.1 GiB | 0.05 s, none |
| FULL `USING`, by the merged column | 3.5 s, 2.3 GiB | 0.16 s, none |
| `NATURAL`, sorted | 2.7 s, 2.3 GiB | 0.16 s, none |
| A `*`, `USING` | 3.9 s, 2.4 GiB | 0.16 s, none |
| Computed output, by name / ordinal | 2.7 / 3.1 s, 2.3 GiB | 0.13 / 0.17 s, none |
| Computed output, a wrapper's, by name | 5.0 s, 2.2 GiB | 0.10 s, none |
| Computed key, repeated expression (already by row number) | 0.22 s | 0.15 s |
| Narrow `USING`, `LIMIT 100` / `OFFSET 2,000,000` | 31 / 188 ms | 38 / 153 ms |
| Narrow computed output | 27 ms | 25 ms |

Decided: a merged column is read through Postgres's join alias variables and never named by a side the fetch picks,
because only the analysis knows the side (an inner join prefers the side that needs no cast, so `int JOIN bigint` reads the
bigint). A computed key is read from the analysis as well as the tree: the tree alone cannot tell a collation's second key
from a value, so a volatile key the rewrite wrote as several keys stays as it was. `NATURAL` becomes the USING of the
columns Postgres merged because a copy's own table has hidden columns a NATURAL would join on, and because DuckDB refuses a
NATURAL of no column in common, which Postgres reads as every pair. It is written so in EVERY statement, by the rewrite
(`naturalWritten`), not by the rows a LIMIT chooses alone: written there first, a count, a sort with no LIMIT and a list
that reads no table still reached DuckDB as NATURAL and were refused (the review of PR 155).

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
stopped. docs/MEASUREMENTS.md ("When is Mason faster?") and the README's headline numbers are rendered from its fixture; `docs/BENCHMARK.md` has the method
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
(`duckdbAlone`); `tests/fixtures/oracle-duckdb-alone.json` holds the tallies, rendered in docs/SQL-SUPPORT.md's table (the README says the headline), and a move of
over a percentage point fails until it is rewritten. **Why.** It measures what Mason adds over its engine (docs/SQL-SUPPORT.md "Why not DuckDB by
itself" has the current run's tallies). When it was added, of 2,753 statements Mason answered 94.7 % exactly (1.0 % a decided difference, 4.3 % refused by name, no wrong value); DuckDB alone
30.9 % exactly, 25.0 % the right rows under its own names, 16.2 % refused with its error, 12.6 % a wrong value, 6.1 % wrong
rows or order. By group on DuckDB alone: common whole statements 80 % identical, the BI shapes 21 %, the type matrix 36 %;
what fails includes integer division (`7 / 2` is 3.5), LIKE's escapes, an array's text (`[0,1]`), a libc collation's order.
