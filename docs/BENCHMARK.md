# Mason against a Postgres read replica: the benchmark

`scripts/bench-replica.ts` answers "why not just use a Postgres read replica?" with numbers. It has two modes:

- **The cold mode** (`--cold`) is the published run. It answers the question a reader asks first: how long does one
  query take on each, the first time, with one client and with ten?
- **The warm mode** (no `--cold`) measures a mix of six queries for a fixed time, after a warm-up, as the tables grow
  and as more readers ask at once.

The published result is `tests/fixtures/bench-replica.json`. [MEASUREMENTS.md](MEASUREMENTS.md) ("When is Mason
faster?") and the README's "Speed" table are rendered from it. docs/DESIGN.md "Mason against a Postgres read replica"
says why the published run is the cold mode.

## The cold mode

### What it measures

- **Three queries**, sent as written to both (`COLD_STATEMENTS` in `scripts/bench-replica-cold.ts`): a count by status
  over every order, revenue by month and signup year over orders joined to customers, and one order by its primary
  key. Neither uses `extract(...)`.
- **Three sizes**: 1 M, 10 M and 100 M orders (`--sizes`).
- **The data** (`COLD_DATA` and `coldDataSql`) is the warm mode's `orders` and `customers` (below), with two changes. The
  primary keys are random UUIDs: `orders.id` is `gen_random_uuid()`, and a customer's id is `md5('customer' || n)::uuid`,
  so an order's `customer_id` is computed with no join. And `orders (status)` has no index, so the count reads every row
  on both. The other indexes are a read replica's: both primary keys, `orders (tenant_id, created_at)` and
  `orders (created_at)`. `created_at` still rises with the heap's order. The data has its own databases
  (`bench_replica_cold_<rows>`) and marker, so neither mode reuses the other's. The fixture records it (`data`), and a
  fixture of other data does not render.
- **1 client and 10 clients** (`--clients`). In a run, each client sends the query once, and all clients send it at
  the same moment. A client's time excludes its connection.
- **3 runs of each cell** (`--runs`). A cell's time is the median over its runs of the slowest client: the time until
  every client has its answer. The fixture keeps every run, with each client's time and the mean.
- **What each run read from disk**: the bytes the measured engine's container read while pgbench ran, from its cgroup
  v2 `io.stat` (`rbytes`, over every device). On Mason's runs the idle Postgres's read is recorded too. Where Docker
  does not use cgroup v2, or a container's `io.stat` cannot be read, the run refuses at its start.
  docs/MEASUREMENTS.md shows each run's read in GB, and the MB/s it implies. `--disk "<words>"` records the disk, and
  the README names it, since cold times on Postgres depend on the disk's throughput.
- **The lookup's rows**: each client asks for a different row, sampled from the data once per size
  (`TABLESAMPLE SYSTEM` over about 2,000 rows' pages, never a sort of the table) and recorded in the fixture. pgbench
  picks the client's id with `\if :client_id = 0` … `\endif`, so each engine is sent a plain quoted literal,
  `WHERE id = '<uuid>'`. The script checks that each id is a UUID's 36 characters before it goes into the SQL. A literal chosen inside the SQL, such as `CASE :client_id WHEN 0 THEN … END`, stops Mason's engine from
  pushing the filter down, and makes Mason look many times slower than it is.

### What it does

- **The same resources.** Postgres (`postgres:18`) and Mason (the `ghcr.io/embeddable-hq/mason-data` image of this
  checkout's version) each run in a container with the same `--cpus`, `--memory` and `--memory-swap`, so neither
  swaps. A cgroup v2 memory limit counts the page cache, so both get the same cache. Postgres gets a read replica's
  settings for that memory (`replicaSettings`). Mason gives its engine half the container's limit, as it does in any
  container.
- **The same rows.** Both containers are on a Docker network of their own (`bench-replica`). Mason syncs the size's
  database from Postgres by its alias on that network, with every table `sync: off`, so nothing polls the source while
  it is measured. Every query's answer is compared on both before anything is timed.
- **Cold, before every run.** Mason is stopped and Postgres restarted. For Mason's run, Mason is started after that.
  The run waits until the engine answers `SELECT 1 FROM orders LIMIT 0`, waits `--settle` seconds more (10), and drops
  the OS page cache.
- **One at a time.** Mason is stopped while Postgres is measured. Postgres stays up while Mason is measured, because a
  Mason start reads its source's catalog, but it is idle and was restarted first. The engines take turns going first.
- **The client** is pgbench from the Postgres image, in a container of its own on the host's network:
  `pgbench -n -c N -j N -t 1 -f <script> --log`. Each client's time is read from pgbench's log of each transaction.
  Both sessions run in UTC (`PGTZ`), since `date_trunc` of a `timestamptz` depends on the time zone.
- **Secrets** (Postgres's password, Mason's API key, the bench user's password from `mason user add --json`) go to
  0600 env files in a 0700 folder. None is on a command line or in the output.
- **Another run is never touched.** A cold run holds a lock, `/tmp/bench-replica-cold.lock`, from its start to its
  end. A lock whose process is alive refuses the next run before any Docker call, and a killed run's lock is taken over.
  A `bench-pg`, `bench-mason` or `bench-client` container, or a Mason volume of a size to be measured, that is already
  there is refused too, before the page cache is dropped. `--reuse-postgres` adopts only a `bench-pg` whose owner (its
  `mason-bench.owner` label) has ended: the Postgres a `--keep-postgres` run left. A check Docker cannot answer, such
  as with its daemon down, refuses the run. Only Docker's own "no such" counts as absent.
- **At the end** the run removes what it made itself, by the ids Docker gave back: its containers, volumes, network and
  files. `--keep-postgres` keeps its Postgres, its databases and the network, for a later run with `--reuse-postgres`.
  A Postgres container adopted with `--reuse-postgres` is not removed. The fixture is written after each size, and
  `--resume` measures only the sizes it lacks.

### What it needs

- **Linux, Docker, and passwordless sudo** for `tee /proc/sys/vm/drop_caches`. Without them the run refuses, and says
  why.
- **About 150 GB of free disk** where Docker keeps its data, for 100 M rows on both engines. At 1 M rows the cold data
  measured 376 bytes a row in Postgres (its tables and indexes) and about 103 in Mason's synced data, so 100 M rows
  take about 50 GB on both, and the indexes' builds and the WAL need room beside it. The run predicts each size from the
  last one it measured. A size whose estimate would leave less than `--reserve-gb` (60 GiB) free is skipped, and the
  output and the fixture say so.
- **Docker using cgroup v2**, to read each engine's disk read.
- **3 GiB of memory or more** for each container (`--memory`, by default half the RAM).
- **A quiet machine.** Stop anything else that reads the disk or uses the CPU first.
- **Time.** At 100 M rows, Postgres makes the data in tens of minutes, and Mason's first sync takes about as long. Each
  of the 36 runs of a size restarts an engine, waits, and drops the page cache.

### Running it

```bash
npm ci
node scripts/bench-replica.ts --cold --help                     # every option
node scripts/bench-replica.ts --cold --sizes 100k --runs 1 --memory 8GiB --out /tmp/cold-smoke.json   # a smoke, a few minutes
node scripts/bench-replica.ts --cold --label "m7g.xlarge, 4 vCPU, 16 GiB RAM" --disk "EBS gp3, 125 MB/s, 3000 IOPS" --memory 8GiB --out /tmp/bench-cold.json
```

`tests/integration/bench-replica-cold.itest.ts` runs a smoke at 1 M rows and checks its fixture, when
`IT_BENCH_COLD=1`. CI does not run it by default: it would add about ten minutes to every PR, on a runner shared with
other jobs.

### Publishing it

```bash
cp /tmp/bench-cold.json tests/fixtures/bench-replica.json
UPDATE_FIXTURE=1 node --test --test-timeout=300000 --test-force-exit tests/bench-replica.test.ts
git diff docs/MEASUREMENTS.md README.md                         # read it
```

The renderer (`renderCold` in `tests/bench-replica.test.ts`) reads the fixture's `mode: "cold"`. The numbers come from
the fixture and the sentences from the renderer, so the wording is changed in the renderer, never in the rendered
files. The README's "Speed" has one table: each query × size × clients, Postgres's time, Mason's time and **Mason is**
(`15× faster`, `79× slower`), with the note that a lookup through an index is faster on Postgres when the run shows
it, and the disk the run read. docs/MEASUREMENTS.md has the same table, every run, the data and the first sync, and "How it was measured".

## The warm mode

### What it measures

- **The data**: a synthetic `orders` table (id, tenant_id over 200 tenants, customer_id, status, amount numeric(12,2),
  created_at over two years rising with the heap's order, a ~150-byte jsonb payload, a text note) and `customers` (one
  per 20 orders), made by `generate_series` in a database `bench_replica_<rows>`, with the indexes a replica would have
  (both primary keys, `orders (tenant_id, created_at)`, `(status)`, `(created_at)`) and `VACUUM (ANALYZE)`.
- **The statements** (`QUERIES` in the script), Postgres's SQL sent as written to both: orders and revenue by status
  over every row; one tenant's orders per day over 90 days; the top 20 customers by amount, joined to `customers`; orders
  by `payload ->> 'source'`; paid orders in a 30-day window; one order by its primary key.
- **Mason** is the real sync and listener in the script's process, wired as `mason start` wires them (the request log
  on, the stored JSON paths on), syncing from the same Postgres; the first sync's time is part of the result. Before a size is
  measured every statement's answer from Mason is compared with Postgres's.
- **Each cell** (size × clients × engine): N clients in a separate Node process run the statements in turn for
  `--seconds` after `--warmup` and one pass of the mix by every client; p50 / p95 are of every statement's wall time, the rate is statements completed per
  second. Each cell runs `--runs` times, the engines alternating which goes first; runs that disagree by more than 30 %
  get another (at most two more), and the median is kept. The load average before each run, the client process's CPU
  and its event loop's delay are recorded, so a client process that was the bottleneck shows.

### Two shapes: the sweep to a minute and the grid (a smoke)

**The warm mode's main run is the sweep to a minute** (both the concurrency and the row count are pushed until
Postgres takes at least a minute to answer). It was the published run before the cold mode. With `--target-postgres-seconds 60` the
sizes and client counts are not chosen in advance; each axis is pushed until Postgres's p95 of the mix reaches the
target, and Mason is measured at every cell Postgres is:

1. **Rows**, at a dashboard's concurrency (`--sweep-clients`, 8: at one client a minute needs more rows than a test
   server's disk holds): from the first `--sizes`, about √10 a step (1M, 3M, 10M, 30M, 100M, …), until Postgres reaches
   the target — or the disk or `--max-rows` stops the sweep, said in the output and the fixture ("the disk stopped the
   sweep at N rows, with Postgres at X s at M"). The next size's disk is PREDICTED from the bytes a row the last size
   took on both engines in this run (Postgres's tables and indexes, Mason's file), a quarter more and 2 GiB for what a
   load writes beside them, and held to `--reserve-gb` of free disk where `--work` is; the constant is only the first
   size's. The container's database of a size two steps back is dropped as the sweep goes on.
2. **Clients**, at the largest size step 1 measured under the target (`--clients-rows` chooses another): the `--clients`
   list, then doubling past its end, until Postgres reaches the target or `--max-clients` (1024) stops it. The
   container's `max_connections` is raised past `--max-clients` so every client is answered — a production replica's
   is lower (Postgres's default is 100), which the published text says.

A cell after one whose Postgres p95 was over a tenth of the target is measured for at least 3 × the target, a
statement's limit (`--timeout`) is at least 5 × the target (its default then; a smaller one is refused), and the
output says how long each cell will take before it starts. The fixture records each sweep's verdict — where Postgres
reached the target, its slowest statement there, and Mason at the same cell — and every mix cell's slowest statement.

**Without `--target-postgres-seconds` the run is a grid**, every `--sizes` × every `--clients`: what a smoke on a
laptop runs (`--sizes 1M --clients 1,8 --seconds 10 --runs 1`).

### Running it on a server

```bash
npm install
node scripts/bench-replica.ts --label "m7g.xlarge, EBS" --target-postgres-seconds 60 \
  --work <a directory on the disk a deployment's synced data lives on> --out /tmp/bench-replica.json
```

- **The other engine stopped**: while Postgres is measured Mason is closed (its DuckDB memory released, its file kept,
  opened again as `mason start` reopens the synced data), and while Mason is measured the bench's Postgres container is stopped
  (`docker stop`). An idle engine is not equivalent: its buffers stay resident and take the other's page cache. A
  `--postgres` server stays up (the fixture says so).
- **A quiet machine**: stop Mason's own run (`mason stop`, or the `mason-data` container) and anything else that reads
  the disk or the CPU first; the load average before each run is in the fixture, and a run beside other work is said
  by it.
- **Its own Postgres**, by default: a `postgres:18` container named `bench-pg` on a free loopback port, removed at the end
  (`--keep-postgres` leaves it, and its data, for another run). It is given `--memory` equal to DuckDB's memory limit
  (`--memory`, else `MASON_DUCKDB_MEMORY`, else Mason's default of half the RAM), so both have the same budget, and a
  replica's settings for that memory (`replicaSettings`): shared_buffers 25 %, effective_cache_size 75 %, work_mem
  32MB, max_connections 300 (past `--max-clients` in a sweep), parallel workers by the CPUs, random_page_cost 1.1. Where the machine's Docker has less
  memory than that, pass a smaller `--memory`.
- **A Postgres someone started**: `--postgres postgres://user:password@host:port/postgres` (the user needs CREATEDB);
  its settings are read and recorded (a sweep refuses one whose `max_connections` is not past `--max-clients`), and its `bench_replica_<rows>` databases are kept for the next run (`COMMENT ON
  TABLE orders` says what one holds; a stale one is made again).
- **Disk**: a size whose estimate (~700 bytes a row, both engines) would leave less than `--reserve-gb` (60) free where
  Mason's synced data is written (`--work`, the OS temp dir by default) is skipped, said in the output and the fixture.
  Where `/tmp` is a tmpfs or a small volume, point `--work` at the disk a deployment's synced data would live on, so Mason reads the
  disk Postgres reads.
- **Time**: about `2 × runs × (warm-up + window + the slowest statements' drain)` per cell, printed before each cell
  starts, plus the data's generation (~5 s per million rows on a laptop) and Mason's first sync. A sweep to a minute is
  hours: its last cells measure for 3 minutes, twice per engine.

The output prints a line per run as it ends, and the fixture is written after each size and at the end, so an
interrupted run keeps the sizes it finished.

### Measuring a layout of the copy (never a published run)

Four bench-only options measure Mason over a copy in another physical order (issue #9) against the same data, the same
statements and the same machine, one thing changed per run:

- `--order "<ORDER BY list>"` rewrites the copy of `public.orders` once it has landed and its stored JSON path is
  ready: Mason is closed, its store opened by the bench alone (no sync, poll, request log or listener), the table
  written again by `CREATE TABLE … AS SELECT * … ORDER BY …` in UTC and swapped in by name, checkpointed, and Mason
  opened again as after a `mason stop` (a copy made again fails the run). The columns, their types, the rows and the
  absence of a key are checked equal; `_mason`'s bookkeeping names the table, so it is untouched. The fixture records the
  order (`environment.mason.order`) and the rewrite (`sizes[].reorder`: its time, the row groups and the file's bytes in
  use before and after). The answers are compared with Postgres's after it.
- `--mason-only` measures Mason's cells alone (a grid); Postgres still makes the data and the answers are still compared.
- `--reuse-postgres` adopts the `bench-pg` container a `--keep-postgres` run left, stopped while Mason is measured as in
  the run that made it, so a second layout's run is isolated as the first was.
- `--keep-copy` leaves the copy at the end with `statements.json` beside it: each statement's DuckDB SQL as Mason
  plans it (its `EXPLAIN (FORMAT JSON)`), to time the statements over the file alone.

### Publishing a warm run

A warm fixture has no `mode`, and the renderer lays it out as below. `tests/fixtures/bench-replica-warm.json` keeps a
warm run for the warm renderer's tests.

```bash
node scripts/bench-replica.ts --label "<the machine>" --target-postgres-seconds 60 … --out tests/fixtures/bench-replica.json
UPDATE_FIXTURE=1 node --test --test-timeout=300000 --test-force-exit tests/bench-replica.test.ts   # renders docs/MEASUREMENTS.md and the README's headline from it
git diff docs/MEASUREMENTS.md README.md                     # read it
```

The section's numbers come from the fixture and its sentences from the renderer's template (`renderReplicaSection`, and
`renderReplicaHeadline` for the README's short table), so the wording is changed in the renderer and never in the
rendered files. It is laid out for scanning:

- **The short version**: one table of the cells worth a glance (the rows sweep's first and last step, the clients
  sweep's last, and the point lookup at the largest cell by p50), each with Postgres's and Mason's time and **Mason is**
  (`15× faster`, `79× slower`). The README's "Speed" carries this table alone, with a link to the rest.
- **As the tables grow** and **as more readers ask at once**: a table each, one row per step of its sweep (for a grid,
  the sizes at the per-statement client count and the client counts at the largest size), p95 and statements/s for
  both engines; the sweep's verdict (where Postgres reached the target, or what stopped it, and its slowest statement
  there) under it. A measured cell on neither line gets a table of its own.
- **Statement by statement** at the largest cell, **Mason is** from the p50s, and the statements Postgres answers faster
  named under it; **the first sync**, a row per size; and the environment, the method, the answers' check, any failed
  statements and skipped sizes folded in a `<details>` "How it was measured".

Every time is in seconds, the header saying `(s)`, at a precision by size (`258`, `37.9`, `4.53`, `0.14`, `0.013`);
every header names which column is Postgres and which is Mason;
docs/DESIGN.md "Mason against a Postgres read replica" says what a published run shows and does not.
