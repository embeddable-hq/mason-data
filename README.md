# Mason

A drop-in replacement for a Postgres read replica, built for analytical queries.

## Why Mason

**A read replica, backed by a columnar store.** Point Mason at your Postgres and name the tables
and columns you want. It syncs them, keeps them in sync as rows change, and serves them over the Postgres wire
protocol. A BI tool (Metabase, Grafana, Superset, Power BI, psql), an AI agent or your own
analytics code connects to it exactly as it would to any read replica, and sends the SQL it sends
Postgres.

Underneath, the replica is a columnar engine (DuckDB), so an aggregate over millions of rows comes
back in milliseconds where Postgres takes seconds or minutes:

- a sum by status over every order
- a top-N joined to its customers
- a group-by over a JSON field

and keeps doing so as the tables grow and as more dashboards ask at once
([Why not a Postgres read replica](#why-not-a-postgres-read-replica) has the measurements).

**For analytics, not for your application's reads and writes.** Keep sending your application's
own queries to Postgres: a row by its primary key, an insert, an update. That is what Postgres is
built for (a point lookup by primary key is faster there, and Mason is read-only).

Mason is for the other kind of load, the scans and aggregates that get slower as data grows and
that, on a replica, compete with each other and with everything else:

- dashboards and reports
- BI tools
- AI agents
- customer-facing analytics

It makes them fast and predictable at scale, and takes them off your database: Mason only reads
your Postgres, by `SELECT`s or its change log, needs nothing installed there, and can sync from a
read replica.

**The same SQL, the same answers.** A drop-in replacement means two things: you keep running the
SQL you already run, without rewriting it for a warehouse, and you can trust that the answers are
the ones Postgres gives. Our approach: Postgres decides, the columnar engine computes.

- **Postgres decides.** Every statement is analysed by a real Postgres first: the names it
  resolves, the types, the result's columns. The catalog a tool reads at connection (`pg_catalog`,
  `information_schema`) is a real Postgres too.
- **The engine computes.** The statement is rewritten for the engine and run there, and the answer
  is sent back with Postgres's column names, type OIDs and text.
- **Exact, or refused.** What the engine cannot answer exactly as Postgres would is refused by
  name, with the error saying what to write instead. Never answered differently.
- **An oracle decides what is exact.** Every construct, function, operator, cast and type is run
  on a real Postgres and on Mason and the answers diffed, tens of thousands of statements at a
  time; only what came back identical is allowed. The result is a list
  ([What of Postgres is answered](#what-of-postgres-is-answered), rendered from the code) and a
  short table of known differences, each one decided and checked to still differ.

You drive it with one command, `mason`, from your app's folder: the same commands for you and
for a coding agent (Claude Code, Codex, …), each printing for a person or, with `--json`, as
data, and saying by its exit code how it went.

## How you use it

```bash
npm i -g @mason-data/cli            # needs Node 22.13+ and nothing else; `mason doctor` checks this machine
cd your-app
```

**1. Make the folder a project.** `mason init` reads `DATABASE_URL` from `.env.local`, `.env` or
the shell (or takes the URL), checks it can read the database, and writes the project's sources
file, `mason/sources/<database>.yml` — yours to commit — beside `.mason/`, this machine's copy of
your data and Mason's state (gitignored). The URL itself stays in `.env`: the file names the variable.

```bash
mason init
mason start                          # Mason in the background, for this folder; returns once it is up
```

**2. Add the tables your dashboards read.** `mason add` copies a table and adds it to the sources file:

```bash
mason tables                         # what this database has: rows, keys, what is added
mason add orders customers           # copy them (--columns id,status,total: those only, one table at a time)
mason wait                           # until every added table is copied and served
mason remove customers               # (later) take one out of the file again; its copy is dropped
```

The sources file is the list of what Mason copies, a table per entry:

```yaml
# mason/sources/app.yml — the database this project copies from. Yours to commit; the URL stays out of it.
kind: postgres
url: ${DATABASE_URL}          # a variable from .env.local, .env or the shell; a literal URL is allowed for local dev
tables:
  orders:                     # a bare name is in `public`; `billing.invoices` names its schema
    columns: [id, customer_id, status, amount, created_at, payload]
  customers: {}               # every column
  events:
    exclude: [raw_body]       # every column but these
  sessions:
    key: [tenant_id, id]      # only for a table with no primary key: the unique columns to copy it by
```

A column that looks like a secret (`password`, `token`, `api_key`, …) is left out unless you
name it, written as `exclude:`. Column types are not in the file: they are read from the
database at every start. The copy starts at once and the table is served the moment it lands;
`mason add` and `mason remove` keep the rest of the file as it was, comments included. An entry
you edit by hand is applied at the next `mason start`, and a mistake in it is refused with the
key and the way out.

**3. Connect a tool.** `mason user add` makes a user of Mason's Postgres API and prints its
password once, with the URL to paste into the tool's datasource form:

```bash
mason user add metabase              # postgres://metabase:<password>@127.0.0.1:5433/your-app
mason ui                             # the status page and the users, in your browser
```

The tool sends the SQL it sends Postgres — the same names, types and text come back — and
each copied table is a table of the database named after your project. The port is the
project's: the first start takes 5433 (or the next free one when a second Postgres holds it)
and every later start listens on the same port, so a saved connection keeps working.
[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) says what SQL is answered, what is refused by
name, and how a tool connects.

**4. Keep an eye on it.** `mason status` says what Mason is doing: the database and how its
changes are read, each table's copy, the Postgres API and how it listens, the statements it
answered slowly in the last day and the ones it refused, each with its reason.

```bash
mason status
mason logs --requests --failed       # every statement the Postgres API refused or failed, with why
mason stop                           # the copy stays; the next `mason start` resumes in seconds
mason destroy                        # removes this project's copy and state, never its files or users
```

`mason --help` lists every command in the order you will need them, and `mason help <command>`
says how to use one, with examples. [`cli/README.md`](cli/README.md) has every command and option;
`mason help agent` is the page a coding agent reads first.

## What runs underneath

One process. The copy lives in a DuckDB file in `.mason/`; the Postgres API is Mason's own
wire-protocol listener in the same process, and the catalog a tool reads (`pg_catalog`,
`information_schema`) is a real Postgres (PGlite, no rows).

```
your Postgres  ──SELECTs (or its change log)──▶  the copy, kept current  ──▶  Postgres API (:5433)  ◀── BI tools, your app
```

- **Postgres decides, DuckDB computes.** Every statement is analysed by Postgres first (names,
  types, the result's columns), rewritten for DuckDB, and run there; the answer carries
  Postgres's names, type OIDs and text. What DuckDB cannot answer exactly as Postgres would is
  refused by name, never answered differently: the allowlist is regenerated from what the
  oracle (every statement run on a real Postgres and on Mason, and diffed) verified
  ([`docs/SQL-SUPPORT.md`](docs/SQL-SUPPORT.md) is the list).
- **Read-only on your database.** By default Mason polls with `SELECT`s: no `wal_level`, slot
  or publication is needed or made, and it works on a read replica. A table over a million
  rows is copied and served but kept current only by `mason sync <table>` or by logical
  replication (`mason start --replication`), which reads the change log the way production does.
- **A copy is chunks that resume.** Each table is read a range of heap pages at a time, a few
  chunks in parallel, one Postgres backend each; a copy that stops (a crash, `mason stop`)
  continues with the ranges it did not commit. Small tables are copied first, and a copy runs
  beside the stream and the polls, never instead of them.
- **Every statement is a row of the request log** (`mason logs --requests`): when, the outcome
  and SQLSTATE, how long, the rows sent, the tool's `application_name` and the user's name.

[`docs/DESIGN.md`](docs/DESIGN.md) is the design: how a statement is
answered, what was decided and why, what was measured.

## Going to production

Only the project folder travels: `mason/` — the sources file and `mason.yml`, the Mason version
it is written for. In production Mason runs as one container, `mason serve`, configured by the
environment, its copy on one volume, with `/healthz` for the platform. `mason help production` is
this section, offline.

```bash
cd deploy/mason-data && mkdir -p mason   # the project folder the container mounts (yours to commit)
cp .env.example .env                 # DATABASE_URL, MASON_API_KEY (openssl rand -hex 24)
docker compose up -d                 # ghcr.io/embeddable-hq/mason-data
docker compose exec mason mason add public.orders
docker compose exec mason mason user add metabase
```

- The image is `ghcr.io/embeddable-hq/mason-data` (`main` is every merge, `<version>` a release),
  amd64 and arm64; [`deploy/mason-data/README.md`](deploy/mason-data/README.md) is the walkthrough.
- **One container per volume, never two**: DuckDB lets one process write its file. Run one replica,
  and stop the old container before the new one starts.
- Off the container's loopback the Postgres API needs TLS: `MASON_PG_SELF_SIGNED_TLS=1` makes a
  certificate on the volume (clients connect with `sslmode=require`), or mount one a CA signed.
- Polling needs a user that can `SELECT` the tables. Replication (`MASON_CHANGES=replication`)
  needs `wal_level = logical`, a user with `REPLICATION`, and either a publication you name
  (`PG_PUBLICATION`, read as it is and never altered) or the right to create one; cap the slot's
  WAL with `max_slot_wal_keep_size`.

Every setting, with its default: `mason serve --help`.

## The repo

| | |
|---|---|
| `src/cli/` | the `mason` command: every command, its run (`mason start`), `mason serve`, the sources file |
| `src/duck/` | the engine: the store, the copy and sync, the stream (logical replication), the plan (Postgres decides, DuckDB computes), the allowlist, the request log, users |
| `src/api/postgres/` | the Postgres wire-protocol listener and its catalog |
| `src/cdc/` | reading a Postgres: the wire protocol, the poll, logical decoding |
| `src/lib/` | shared: logging, `.env`, ports, exact numerics, timezones |
| `cli/` | the npm package `@mason-data/cli` (built from `src/` by `cli/build.ts`) |
| `docker/`, `deploy/` | the `mason-data` image and how to run it |
| `tests/` | `node --test`, offline; `tests/integration/` against a real Postgres |
| `docs/` | below |

## Documentation

| | |
|---|---|
| [`cli/README.md`](cli/README.md) | every command and option of the `mason` command |
| [`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) | the Postgres API: connecting a tool, what SQL is answered, what is refused by name |
| [`docs/WEB-UI.md`](docs/WEB-UI.md) | the web page of `mason start` (`mason ui`): what it shows, how it is opened and guarded, how to build it out |
| [`docs/SQL-SUPPORT.md`](docs/SQL-SUPPORT.md) | what is verified to answer exactly as Postgres does, and what is not (rendered from the code) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | the design: how a statement is answered, the copy, replication, the decisions and measurements behind them |
| [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | Mason against a Postgres read replica: running the benchmark and publishing its result |
| [`deploy/mason-data/README.md`](deploy/mason-data/README.md) | running the image on a server |
| [`release-notes/`](release-notes/README.md) | what each release changes for you, and what to do before upgrading |
| [`CLAUDE.md`](CLAUDE.md) | the rules of the codebase, for anyone changing it, human or not; each subsystem's own rules are in `.claude/rules/` |

## Developing Mason

```bash
npm install && npm run check      # typecheck + tests, offline, a few minutes
```

The integration tests run the real copy, stream, listener and `mason serve` against a Postgres
of yours (`tests/integration/README.md`): a throwaway one, since each test makes and drops a
database there.

```bash
IT_POSTGRES_URL=postgres://postgres:secret@localhost:5432/postgres npm run test:integration
```

CI runs both on every pull request. Every script is TypeScript run directly by Node (no build
step); `CLAUDE.md` has the rest.

## Contributing

If Mason is slow, inaccurate, or answers anything differently from Postgres, we want to know: an issue is welcome, a
pull request with a test is better. The issue forms ask for what a report needs (the statement, the types, both
answers or both timings), and a reported difference becomes a case the oracle holds Mason to from then on.
[CONTRIBUTING.md](CONTRIBUTING.md) has the detail; [SECURITY.md](SECURITY.md) says how to report a vulnerability
privately.

## License

Apache-2.0 (`LICENSE`). Copyright Embeddable.

## What of Postgres is answered

<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
> **The list is the code; the sentences are a template.** `tests/duck-gaps.test.ts` renders this section from
> `src/duck/gaps.ts` and `src/duck/verified.ts`, and CI holds it equal to what they render, so it is as current as the
> commit you are reading. To change the wording, edit the renderer; to change what is answered or refused, change the
> source; an edit made here is undone by the next `UPDATE_FIXTURE=1 npm test`.

Mason is a drop-in replacement for a Postgres read replica: the SQL a tool sends Postgres is answered as Postgres
answers it — the same columns, types, values, text and order — or refused by name, never answered differently. Every
piece a statement is made of is verified against a real Postgres by the oracle ([docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md),
rendered from the code, names each). The copy is read-only.

### Why not DuckDB by itself

DuckDB reads most of Postgres's SQL, but does not answer it as Postgres does. The oracle's 2,764 statements,
each sent as written to Mason and to a plain DuckDB connection over the same copied tables (tests/integration/duck-oracle.itest.ts):

| Of 2,764 statements | Mason | DuckDB alone |
|---|---|---|
| answered exactly as Postgres: the rows, their text, the column names | 95% | 31% |
| answered differently by a decision the registry lists (the known differences below) | 1% | — |
| refused, naming what to write instead (SQLSTATE 0A000, `Mason gap <id>`) | 4% | — |
| the right rows under DuckDB's own column names (`count_star()` for `count`, the expression's text for an unnamed column) | — | 25% |
| refused with DuckDB's own error (a function it lacks, syntax it does not read) | — | 16% |
| a wrong value (`7 / 2` is 3.5, LIKE's backslash escape, a float4 beside a literal, a numeric's rounding) | 0% | 11% |
| wrong rows, or the rows in another order | — | 6% |
| the same value in other text (`1.0` for `1`, a numeric's scale, a timestamptz without its offset) | — | 5% |
| another error than Postgres's, or answered where Postgres refuses | — | 5% |

A tool that reads Postgres reads the first row's answers; the rest it would have to work around, statement by
statement. The oracle's statements are adversarial by design (NULL beside '', ties, every type's edge values), so
plain reports fare better on DuckDB alone than this table says — and still not as Postgres.

| Postgres | Mason |
|---|---|
| A `SELECT` over the copied tables (and the source's views over them): joins, subqueries, WITH queries, UNION / INTERSECT / EXCEPT, GROUP BY and grouping sets, HAVING, DISTINCT, ORDER BY under the database's collation, LIMIT / OFFSET / FETCH FIRST, window functions, CASE, COALESCE / NULLIF / GREATEST / LEAST, IN and ANY / ALL, parameters, EXPLAIN | answered exactly as Postgres answers it: 43 constructs and 85 forms of them verified |
| The types: bigint, boolean, bytea, character, character varying, date, double precision, inet, integer, interval, json, jsonb, jsonpath, name, numeric, real, smallint, text, time without time zone, timestamp with time zone, timestamp without time zone, uuid; arrays of bigint, boolean, character, character varying, date, double precision, inet, integer, interval, json, jsonb, numeric, real, smallint, text, time without time zone, timestamp with time zone, timestamp without time zone, uuid; the source's enums and citext; a table's row | answered (49 types verified) |
| Functions, operators, aggregates, window functions and casts | answered exactly: 241 functions, 342 operators, 91 aggregates, 58 window functions and 78 casts verified; [docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md) names each |
| Transactions, SET, SHOW, the catalog (`pg_catalog`, `information_schema`) and the protocol a tool uses | answered: what a BI tool asks at connection and before a query |
| Anything else: 46 shapes known not to answer as Postgres does (SQL-SUPPORT.md "Refused"), and any function, operator or cast the oracle has not verified | refused by name (SQLSTATE 0A000), the error saying what to write instead; never answered differently |

### Known differences (11)

Answered, but not as Postgres answers: each is a decided difference the oracle checks still differs.

| What | Postgres | Mason | Instead |
|---|---|---|---|
| text ordered under a libc collation where punctuation or a space follows a digit or a symbol and a later letter differs only in case ('1-X' beside '1x') | the punctuation outranks the case: 1-X < 1x | the case outranks the punctuation: 1x < 1-X | ORDER BY lower(x), x when the case must not decide first |
| a select-list value that raises (`'x'::int`, a bad JSON number) in a row a LIMIT leaves out, where no index gives the ORDER BY | raises: its plan sorts every row, its select list computed for each (through an index it stops at the limit and answers) | answers: a sorted, limited select list is computed for the rows the limit keeps (src/duck/late.ts), as Postgres's index scan does | none needed for an answer; filter the bad rows out to have neither raise |
| a numeric column whose values have several scales: an integer UNION ALL a numeric, lead(x, 1, 0) beside numeric(2,1) values, an unconstrained column holding 1 and 1.50 | each value its own scale: 1, 1.5 | one scale per column: 1.0, 1.5 | cast to numeric(p, s), or round(x, s) |
| upper / lower of letters added in Unicode 16 | maps them (its own Unicode 16 tables) | leaves them as they are (DuckDB's ICU predates Unicode 16) | none needed for letters before Unicode 16 |
| stddev / variance of a float, and ln, log, exp, power of a double: the last digit | its algorithm and libm's | DuckDB's: equal to about 1e-15 | round(x::numeric, 12) |
| -0 beside 0 in greatest / least / percentile_disc | keeps the one it met first | may answer the other | x + 0 makes -0 into 0 |
| exp / power of a double past its range, or so small it underflows | an error (22003) | Infinity, or 0 | bound the argument |
| min / max of a numeric expression (a quotient) where equal values have different scales (0 / 7 and 0 / 1000000) | the last of them it reads, so the scan order decides the trailing zeros | the one whose operands are least (min) or greatest (max) | round(min(a / b), n) |
| stddev / variance of DISTINCT integers or numerics, or of a numeric declared without a precision or with more than 18 digits: the last digits | exact numeric arithmetic, to its own scale | a double's 15 digits | round(stddev(x), 10) |
| greatest / least of a char(n) beside a text | compares without the padding, answers the first of equal values | compares the padded text | cast the char(n) to text first |
| an expression over a numeric a subquery computed exactly (a division, an avg, a round), outside that subquery: SELECT x * 2 FROM (SELECT a / 3 AS x …) | exact digits at every step | the subquery's value as DuckDB computed it (a double's 15 digits) where the outer query computes with it; passed through as it is (SELECT *, s.x), it is exact | compute it in the outermost query, or round(…, n) inside |

### Limits (7)

Not about one statement: what Mason does not do yet.

| What | Postgres | Mason | Instead |
|---|---|---|---|
| access | roles, grants, row-level security | every user (mason user) and token reads every copied table: no per-user or per-tenant scope | copy only the tables every user may read |
| keeping current by the poll (mason start without --replication) | - | the xmin poll scans every added table whole, every poll (no index covers xmin): ~13–17 s for 13 GiB | logical replication: mason start --replication |
| INSERT, UPDATE, DELETE, DDL, a read-write transaction | answers | refused by name: the copy is read-only (a read-write transaction: 25006) | write to the source database; the copy follows |
| a numeric of more than 38 digits, or holding NaN or Infinity: a column, or a constant ('1e400'::numeric) inside DuckDB's arithmetic or a WHERE | exact | a double (15 digits), said in the log for a column; a constant the outermost SELECT answers is exact | numeric(p, s) with p ≤ 38 |
| an unconstrained numeric[] column | exact elements | double precision elements (15 digits), said in the log | numeric(p, s)[] |
| a numeric parameter ($1) compared in a WHERE | exact | a double (exact to 15 digits) | a literal |
| .mason/mason.log's statement lines | - | each statement DuckDB ran, whole, literals included | keep the log private |
<!-- END GENERATED -->

## Why not a Postgres read replica

<!-- GENERATED by tests/bench-replica.test.ts from tests/fixtures/bench-replica.json, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
> **The numbers are a measurement; the sentences are a template.** `tests/bench-replica.test.ts` renders this section
> from `tests/fixtures/bench-replica.json`, a run of `scripts/bench-replica.ts`, and CI holds the section equal to what
> they render. To change the wording, edit the renderer; to change the numbers, run the benchmark
> ([docs/BENCHMARK.md](docs/BENCHMARK.md)); an edit made here is undone by the next `UPDATE_FIXTURE=1 npm test`.

A Postgres read replica answers a dashboard's SQL as Postgres does, and so does Mason: the same statements, the same
answers. The difference is what an answer costs as the tables grow and as more readers ask at once.

### The short version

| | Postgres p95 (s) | Mason p95 (s) | Mason is |
|---|---:|---:|---|
| 1 M rows, 8 clients | 2.06 | 0.14 | 15× faster |
| 30 M rows, 8 clients | 258 | 4.53 | 57× faster |
| 10 M rows, 32 clients | 96.6 | 3.51 | 28× faster |
| one order by its primary key, 30 M rows, 8 clients (p50) | 0.013 | 0.99 | 79× slower |

Mason is for scans and aggregates; a lookup through an index stays Postgres's ([docs/DESIGN.md](docs/DESIGN.md) "Heap order, no index").

### As the tables grow

**At 8 clients**, a dashboard's concurrency, the tables growing about √10 a step. Each p95 is of the mix: the 6 statements below, each client running them in turn.

| rows | Postgres p95 (s) | Mason p95 (s) | Mason is | Postgres statements/s | Mason statements/s |
|---:|---:|---:|---|---:|---:|
| 1,000,000 | 2.06 | 0.14 | 15× faster | 15.9 | 104 |
| 3,000,000 | 7.61 | 0.42 | 18× faster | 3.55 | 38.9 |
| 10,000,000 | 37.9 | 1.35 | 28× faster | 0.96 | 12.1 |
| 30,000,000 | 258 | 4.53 | 57× faster | 0.090 | 3.80 |

Postgres's p95 reached the 60 s target at 30 M rows, 8 clients, where its slowest statement, "top 20 customers by amount, joined to customers", took 133 s at p50.

### As more readers ask at once

**At 10,000,000 orders**, the largest size the rows sweep measured under 60 s.

| clients | Postgres p95 (s) | Mason p95 (s) | Mason is | Postgres statements/s | Mason statements/s |
|---:|---:|---:|---|---:|---:|
| 1 | 5.48 | 0.24 | 23× faster | 0.55 | 10.8 |
| 8 | 37.9 | 1.35 | 28× faster | 0.96 | 12.1 |
| 32 | 96.6 | 3.51 | 28× faster | 0.77 | 12.2 |

The bench's Postgres allows 1074 connections so that every client is answered; Postgres's default is 100, and past a replica's own limit the next connection is refused (53300).

Postgres's p95 reached the 60 s target at 10 M rows, 32 clients, where its slowest statement, "top 20 customers by amount, joined to customers", took 114 s at p50.

### Statement by statement

**At 30,000,000 rows and 8 clients**, each statement inside the mix; the last column is from the p50s.

| statement | Postgres p50 (s) | Postgres p95 (s) | Mason p50 (s) | Mason p95 (s) | Mason is |
|---|---:|---:|---:|---:|---|
| orders and revenue by status, every row | 31.8 | 71.2 | 2.15 | 3.75 | 15× faster |
| one tenant's orders per day, last 90 days | 0.040 | 0.073 | 0.96 | 2.47 | 24× slower |
| top 20 customers by amount, joined to customers | 133 | 261 | 3.96 | 5.80 | 34× faster |
| orders by a JSON field (payload ->> 'source') | 73.0 | 82.7 | 2.84 | 4.75 | 26× faster |
| paid orders in a 30-day window | 0.45 | 0.96 | 1.05 | 2.59 | 2.3× slower |
| one order by its primary key | 0.013 | 0.023 | 0.99 | 2.09 | 79× slower |

Postgres is faster at "one tenant's orders per day, last 90 days", "paid orders in a 30-day window" and "one order by its primary key": it reads them through an index, and Mason's copy has none ([docs/DESIGN.md](docs/DESIGN.md) "Heap order, no index").

### The copy

**Mason's copy** of each size, from that Postgres: *copied in* is the time until the copy was served, and the JSON path
is stored that long after its first reads.

| rows | in Postgres | copied in (s) | on Mason's disk | JSON path stored after (s) |
|---:|---:|---:|---:|---:|
| 1,000,000 orders, 50,000 customers | 0.34 GiB | 2.80 | 0.08 GiB | 17.9 |
| 3,000,000 orders, 150,000 customers | 1.0 GiB | 8.20 | 0.20 GiB | 25.6 |
| 10,000,000 orders, 500,000 customers | 3.4 GiB | 20.8 | 0.61 GiB | 77.4 |
| 30,000,000 orders, 1,500,000 customers | 10.1 GiB | 134 | 1.8 GiB | 213 |

<details><summary>How it was measured</summary>

Measured on m7g.xlarge, 4 vCPU, 15 GiB RAM, EBS gp3: 4 CPUs (AWS Graviton3), 15.3 GiB of RAM, Linux 7.0.0-1011-aws; PostgreSQL 18.6, Docker (postgres:18) on the same machine, 7.6 GiB of memory (shared_buffers 1958MB, effective_cache_size 5874MB, work_mem 32MB, max_parallel_workers_per_gather 2, max_connections 1074); Mason a12bb860 with DuckDB v2.0.0 at 7832MiB; 2026-10-27.

Synthetic rows (an `orders` table with a jsonb payload, and `customers`, from `generate_series`); each axis pushed until Postgres's p95 reached 60 s; each cell measured for 30–180 s (3 × the target after a cell where Postgres took over a tenth of it) after a warm-up of 5 s and one pass of the mix by every client, the median of 2 runs; each engine measured with the other stopped: Mason closed while Postgres ran, Postgres's container stopped while Mason ran.

Every statement's answer was the same on both, compared before each size was measured.

Statements that failed, counted in neither the latency nor the rate: 10,000,000 rows, 32 clients, Postgres: 81 (53100 disk_full × 81).

To rerun: `node scripts/bench-replica.ts` ([docs/BENCHMARK.md](docs/BENCHMARK.md) says how, and how to publish a result here).

</details>
<!-- END GENERATED -->
