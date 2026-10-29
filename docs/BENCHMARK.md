# Mason against a Postgres read replica: the benchmark

`scripts/bench-replica.ts` answers "why not just use a Postgres read replica?" with numbers: what the same SQL costs on
a Postgres and on Mason as the tables grow and as more readers ask at once. Its result is
`tests/fixtures/bench-replica.json`, from which [MEASUREMENTS.md](MEASUREMENTS.md) ("When is Mason faster?") and the
README's headline numbers are rendered;
docs/DESIGN.md "Mason against a Postgres read replica" says why the sweep is shaped so and what a run does and does not show.

## What it measures

- **The data**: a synthetic `orders` table (id, tenant_id over 200 tenants, customer_id, status, amount numeric(12,2),
  created_at over two years rising with the heap's order, a ~150-byte jsonb payload, a text note) and `customers` (one
  per 20 orders), made by `generate_series` in a database `bench_replica_<rows>`, with the indexes a replica would have
  (both primary keys, `orders (tenant_id, created_at)`, `(status)`, `(created_at)`) and `VACUUM (ANALYZE)`.
- **The statements** (`QUERIES` in the script), Postgres's SQL sent as written to both: orders and revenue by status
  over every row; one tenant's orders per day over 90 days; the top 20 customers by amount, joined to `customers`; orders
  by `payload ->> 'source'`; paid orders in a 30-day window; one order by its primary key.
- **Mason** is the real copy and listener in the script's process, wired as `mason start` wires them (the request log
  on, the stored JSON paths on), copying from the same Postgres; the copy's time is part of the result. Before a size is
  measured every statement's answer from Mason is compared with Postgres's.
- **Each cell** (size × clients × engine): N clients in a separate Node process run the statements in turn for
  `--seconds` after `--warmup` and one pass of the mix by every client; p50 / p95 are of every statement's wall time, the rate is statements completed per
  second. Each cell runs `--runs` times, the engines alternating which goes first; runs that disagree by more than 30 %
  get another (at most two more), and the median is kept. The load average before each run, the client process's CPU
  and its event loop's delay are recorded, so a client process that was the bottleneck shows.

## Two shapes: the sweep to a minute (published) and the grid (a smoke)

**The published run is the sweep to a minute** (both the concurrency and the row count are pushed until Postgres takes
at least a minute to answer). With `--target-postgres-seconds 60` the
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

## Running it on a server

```bash
npm install
node scripts/bench-replica.ts --label "m7g.xlarge, EBS" --target-postgres-seconds 60 \
  --work <a directory on the disk a deployment's copy lives on> --out /tmp/bench-replica.json
```

- **The other engine stopped**: while Postgres is measured Mason is closed (its DuckDB memory released, its file kept,
  opened again as `mason start` reopens a copy), and while Mason is measured the bench's Postgres container is stopped
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
  Mason's copy is written (`--work`, the OS temp dir by default) is skipped, said in the output and the fixture. Where
  `/tmp` is a tmpfs or a small volume, point `--work` at the disk a deployment's copy would live on, so Mason reads the
  disk Postgres reads.
- **Time**: about `2 × runs × (warm-up + window + the slowest statements' drain)` per cell, printed before each cell
  starts, plus the data's generation (~5 s per million rows on a laptop) and Mason's copy. A sweep to a minute is
  hours: its last cells measure for 3 minutes, twice per engine.

The output prints a line per run as it ends, and the fixture is written after each size and at the end, so an
interrupted run keeps the sizes it finished.

## Measuring a layout of the copy (never a published run)

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

## Publishing a result

```bash
node scripts/bench-replica.ts --label "<the machine>" --target-postgres-seconds 60 … --out tests/fixtures/bench-replica.json
UPDATE_FIXTURE=1 node --test tests/bench-replica.test.ts    # renders docs/MEASUREMENTS.md and the README's headline from it
git diff docs/MEASUREMENTS.md README.md                     # read it
```

The section's numbers come from the fixture and its sentences from the renderer's template (`renderReplicaSection`, and
`renderReplicaHeadline` for the README's short table), so the wording is changed in the renderer and never in the
rendered files. It is laid out for scanning:

- **The short version**: one table of the cells worth a glance (the rows sweep's first and last step, the clients
  sweep's last, and the point lookup at the largest cell by p50), each with Postgres's and Mason's time and **Mason is**
  (`15× faster`, `79× slower`). The README's "Why Mason" carries this table alone, with a link to the rest.
- **As the tables grow** and **as more readers ask at once**: a table each, one row per step of its sweep (for a grid,
  the sizes at the per-statement client count and the client counts at the largest size), p95 and statements/s for
  both engines; the sweep's verdict (where Postgres reached the target, or what stopped it, and its slowest statement
  there) under it. A measured cell on neither line gets a table of its own.
- **Statement by statement** at the largest cell, **Mason is** from the p50s, and the statements Postgres answers faster
  named under it; **the copy**, a row per size; and the environment, the method, the answers' check, any failed
  statements and skipped sizes folded in a `<details>` "How it was measured".

Every time is in seconds, the header saying `(s)`, at a precision by size (`258`, `37.9`, `4.53`, `0.14`, `0.013`);
every header names which column is Postgres and which is Mason;
docs/DESIGN.md "Mason against a Postgres read replica" says what a published run shows and does not.
