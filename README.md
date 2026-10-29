# Mason

A drop-in replacement for a Postgres read replica, built for exceptionally fast analytical queries.

- **Lightweight:** Mason is a single Node.js process you can run anywhere (`mason init && mason start`).
- **Like a read replica:** Choose which tables and columns to sync from your Postgres database, and how each stays in sync: on demand, polling or replication. Mason makes them available to query.
- **Lightning fast:** Under the hood, Mason uses [DuckDB](https://github.com/duckdb/duckdb)'s columnar engine to accelerate analytical queries (`COUNT`, `SUM`, `GROUP BY`, etc.) over large tables.
- **Keep your existing SQL:** Mason is built from the ground up to match Postgres syntax and behaviour, so you can reuse existing SQL without risky rewrites or subtle changes to query semantics.
- **Built for AI agents:** Give AI agents fast, secure access to your data: a user per agent, a role that limits the tables, columns and rows it can read, every query logged, and native MCP support.

**Contents**

- [Getting started](#getting-started)
  - [Try the demo](#try-the-demo)
  - [Try with your data](#try-with-your-data)
  - [Going to production](#going-to-production)
- [Syncing from Postgres](#syncing-from-postgres)
  - [Choosing what to sync](#choosing-what-to-sync)
  - [The first copy](#the-first-copy)
  - [Manual sync](#manual-sync)
  - [Polling](#polling)
  - [Logical replication](#logical-replication)
- [Performance vs Postgres](#performance-vs-postgres)
  - [When to use Mason](#when-to-use-mason)
  - [Why it's fast](#why-its-fast)
- [Postgres compatibility](#postgres-compatibility)
  - [How a query is answered](#how-a-query-is-answered)
  - [How compatibility is tested](#how-compatibility-is-tested)
- [For AI agents](#for-ai-agents)
  - [Access control](#access-control)
  - [The MCP server](#the-mcp-server)
  - [Observability](#observability)
  - [A CLI for coding agents](#a-cli-for-coding-agents)
- [Documentation](#documentation) · [Community](#community) · [Contributing](#contributing) · [License](#license)

[Website](https://masondata.ai) · [Issues](https://github.com/embeddable-hq/mason-data/issues)

[![npm](https://img.shields.io/npm/v/@mason-data/cli)](https://www.npmjs.com/package/@mason-data/cli)
[![CI](https://img.shields.io/github/actions/workflow/status/embeddable-hq/mason-data/ci.yml?branch=main&label=CI)](https://github.com/embeddable-hq/mason-data/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-mason-works-dark.svg">
  <img alt="How Mason works: Mason copies the tables you choose from your Postgres and keeps them up to date on demand, by polling or by replication. A BI tool, an AI agent or your app sends SQL over the Postgres protocol. A real Postgres analyses each query, Mason runs it on the columnar copy, and the answer is exactly what Postgres would send. If Mason can't answer exactly, it refuses with an error that says why." src="docs/how-mason-works.svg" width="100%">
</picture>

## Getting started

Mason runs as a single process, and you install nothing on your Postgres. On your machine, you install Mason from
npm. On a server, you run the `ghcr.io/embeddable-hq/mason-data` Docker image (see
[Going to production](#going-to-production)).

### Try the demo

```bash
npm i -g @mason-data/cli             # needs Node 22.13+ (run mason doctor to check this machine)
mkdir mason-demo && cd mason-demo
mason init demo && mason start       # starts a demo shop database for you: nothing else to install
mason add order_items                # adds the fourth table, so you can watch its copy start
mason user add me                    # prints a connection URL with a password (shown only once)
psql "<the URL it printed>" -c "select status, count(*) from orders group by 1"   # or use any Postgres client
mason destroy                        # deletes the copy and the demo database (the next mason start creates a new one)
```

The demo shop has four tables: `customers`, `products`, `orders` and `order_items`. Its data lives in
`.mason/demo/`, and a new order arrives every few seconds. The demo's sources file polls every 5 seconds
(`sync: poll 5s`), so `mason status` shows the copy keeping up. Mason reads the demo database the same way it reads
yours: over the Postgres protocol.

### Try with your data

**1. Add your tables and start Mason.**

```bash
cd your-app                          # Mason reads DATABASE_URL from .env.local, .env or the shell
mason init                           # creates mason/sources/<database>.yml (commit it) and .mason/ (local, gitignored)
mason tables                         # lists the tables in your database, with their rows and keys
mason add orders customers           # adds tables (use --columns id,status,total to copy only some columns)
mason start                          # starts Mason in the background and begins the copy
mason wait                           # waits until every added table is copied
mason sync orders                    # reads the latest changes (by default, Mason syncs only when you ask)
mason remove customers               # removes a table and deletes its copy
```

No `DATABASE_URL`? Run `mason init <url>` instead, and Mason writes the URL to `.env` for you. If your app's
`DATABASE_URL` points to a different database, Mason writes `MASON_DATABASE_URL` instead and leaves yours alone.

The sources file lists the tables Mason copies. It also says how each table stays up to date: synced when you ask,
polled, or replicated (see [Choosing what to sync](#choosing-what-to-sync)).

**2. Connect a tool.**

```bash
mason user add metabase              # prints postgres://metabase:<password>@127.0.0.1:5433/your-app (shown only once)
```

Paste this URL into your tool's Postgres connection form. Each copied table appears as a table in a database named
after your project. The port stays the same every time Mason starts, so saved connections keep working.
[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) explains how tools connect and which SQL Mason answers.

**3. Keep an eye on it.**

```bash
mason status                         # shows your database, each table's copy, the Postgres API, and slow or refused queries
mason ui                             # shows the same in your browser, plus the users
mason logs --requests --failed       # lists every query that was refused or failed, and why
mason stop                           # stops Mason; the copy stays, and the next mason start resumes in seconds
mason destroy                        # deletes the copy and Mason's state (never your files or users)
```

`mason --help` lists every command in the order you will need them. `mason help <command>` explains one command, with
examples. [`cli/README.md`](cli/README.md) documents every command and option.

### Going to production

In production, you deploy only the project folder: `mason/`, which holds the sources file and `mason.yml`.
(`mason.yml` records the Mason version the project was written for.) Mason runs as one container with `mason serve`.
You configure it with environment variables, and it keeps its copy on one volume. Your platform can check its health
at `/healthz`. Run `mason help production` to read this section offline.

```bash
cd deploy/mason-data && mkdir -p mason   # or copy compose.yml and .env.example into your own folder
cp .env.example .env                 # set DATABASE_URL and MASON_API_KEY (openssl rand -hex 24)
docker compose up -d                 # starts ghcr.io/embeddable-hq/mason-data
docker compose exec mason mason add public.orders
docker compose exec mason mason user add metabase
```

| | |
|---|---|
| Image | `ghcr.io/embeddable-hq/mason-data`, for amd64 and arm64. The `main` tag is built from every merge, and `<version>` is a release. [`deploy/mason-data/README.md`](deploy/mason-data/README.md) walks you through it. |
| Replicas | Run one container per volume, because DuckDB lets only one process write its file. Deploy with stop-then-start (in Kubernetes, `strategy: Recreate`). A deploy means a few seconds of downtime, not a new copy. The copy stays on the volume. A restarted Mason is healthy about half a second after it starts, and then it catches up on the changes it missed. |
| TLS | Required when clients connect from outside the container. Set `MASON_PG_SELF_SIGNED_TLS=1` to create a certificate on the volume (clients then connect with `sslmode=require`), or mount a certificate from your CA. |
| Sync | The sources file you deploy says how each table stays up to date, so production runs exactly what you committed. Off and polling need a user that can `SELECT` the tables. Replication needs more (see [Logical replication](#logical-replication)). |
| Settings | [`deploy/mason-data/README.md`](deploy/mason-data/README.md#settings) lists the settings you must set and the ones worth deciding. `mason serve --help` lists all of them. |
| Upgrades | Mason is pre-1.0, so a release may still rename a command, a key or a setting. `mason.yml` pins the version your project uses. The image refuses to run a project written for a different release line. The [release notes](release-notes/README.md) tell you what to do before each upgrade. |

<details>
<summary><b>Sizing: memory and CPU</b></summary>

- **Memory**: By default, the copy may use half of the container's memory limit (or half the machine's RAM if there
  is no limit). The other half is for the page cache, Node and the catalog. The catalog uses about 820 MB, but only
  while it is in use. It starts on a tool's first catalog query and stops after 10 minutes without one.

  Give the container enough memory for the page cache to hold the columns your dashboards read. A query on a column
  that is not in the cache runs at disk speed. In the benchmark, the copy was about a fifth of the tables' size in
  Postgres (10.1 GiB → 1.8 GiB, on a 15 GiB machine). `mason status` shows the size of yours.

  To set the limit yourself, use `MASON_DUCKDB_MEMORY=4GB`, and give the container about twice that. A query that needs
  more memory fails on its own (53200), and Mason keeps running. If you set the limit close to the container's limit,
  the container can be killed for running out of memory.
- **CPU**: Memory matters first, then cores. The benchmark machine (4 vCPU Graviton3, 15 GiB) answered 12 queries a
  second at a p95 of 3.5 s, with 32 clients on 10 M rows. That is the same throughput as with 8 clients: the extra
  clients waited in a queue. While a copy runs, each of its readers uses about one core (`MASON_COPY_PARALLEL`,
  default 3).

</details>

## Syncing from Postgres

Choose the tables and columns you want, and Mason copies them. BI tools (Metabase, Grafana, Superset, Power BI, psql),
AI agents and your own code then connect to Mason as they would to any read replica. Mason only reads from your
Postgres. It never writes to it.

**By default, Mason reads each table once (the first copy). After that, it reads again only when you tell it to.**
For each table, you choose how its copy stays up to date:

| `sync:` | Off (the default) | Polling | Logical replication |
|---|---|---|---|
| after the first copy | nothing, until you run `mason sync <table>` | `SELECT` queries, at an interval you choose | reads the database's change log, like a replica |
| needs on your Postgres | a user that can `SELECT` the tables | the same | `wal_level = logical`, a user with `REPLICATION`, and a publication |
| creates on your Postgres | nothing | nothing | a replication slot (and a publication, if you don't name one) |
| works with a read replica as the source | yes | yes | yes, on Postgres 16+, with a publication you name |
| good for | trying Mason, and reports that run on a schedule | most tables, every few seconds to every few hours | big, busy tables, and changes within seconds |
| how to write it | `sync: off` | `sync: poll 5m` | `sync: replication` |

### Choosing what to sync

```yaml
# mason/sources/app.yml: the database this project copies from. Commit this file. The URL is not stored in it.
kind: postgres
url: ${DATABASE_URL}          # a variable from .env.local, .env or the shell (a literal URL is fine for local dev)
sync: off                     # the default for every table, unless a table says otherwise
tables:
  orders:                     # a bare name means the `public` schema; write `billing.invoices` for another schema
    columns: [id, customer_id, status, amount, created_at, payload]
    sync: poll 30s            # this table is polled every 30 seconds
  customers: {}               # copies every column, with the default sync
  events:
    exclude: [raw_body]       # copies every column except these
  sessions:
    key: [tenant_id, id]      # only for a table with no primary key: the columns that identify a row
```

- `mason add` writes these entries for you. To set a table's sync, run `mason add orders --sync "poll 30s"`.
- `mason add` leaves out columns that look like secrets (`password`, `token`, `api_key`, …) unless you name them. It
  lists them under `exclude:`. If you write `{}` by hand, every column is copied.
- Mason reads column types from your database each time it starts. You never write them in the file.
- While Mason runs, `mason add` and `mason remove` take effect at once. They keep the rest of the file as it was,
  including comments. If you edit the file by hand, the change applies at the next `mason start`. If an entry has a
  mistake, Mason tells you the key and how to fix it.
- If you change a table's `sync:`, Mason keeps its copy. It catches the table up with one poll and never copies it
  again.
- `mason status`, the MCP tools and EXPLAIN show how each table stays up to date and when it was last synced. You
  always know how old a copy is.

### The first copy

- Mason reads each table in ranges of pages. It reads `MASON_COPY_PARALLEL` ranges at a time (3 by default), each on
  its own connection. So a copy never uses more connections to your database than that.
- The smallest table is copied first. Each table can be queried as soon as its copy is done. `mason wait` shows the
  progress.
- If a copy stops (after a crash, or `mason stop`), it resumes later. It reads only the ranges it had not finished.
- A copy runs alongside the polls and the replication stream. Adding a big table never stops the other tables from
  staying up to date.

### Manual sync

After the first copy, Mason reads nothing from your database until you run `mason sync orders`.
That command polls the tables you name once, right away. You can run it before a report, from cron, or at the end of
a deploy. Between syncs, Mason does not touch your database.

### Polling

Write `sync: poll <interval>`, for example `5s`, `5m` or `1h`. You don't need to set up anything on your Postgres.

- **How it works**: At each interval, Mason reads the table in one transaction, from one snapshot. It finds the rows
  that changed since the last poll by their `xmin` (Postgres's row version), and writes them by key. To find deleted
  rows, it compares row counts first. It compares keys only when the counts differ. The rows and the poll's position
  are saved together, so if a poll fails, the next one simply reads the same rows again.
- **What it costs your database**: Postgres has no index on `xmin`, so each poll reads the whole table. Choose an
  interval that suits the table's size: every few seconds for a small table, every hour for a table of 50 M rows.
  Mason also limits the cost itself. After each poll, it waits at least four times as long as that poll took. So polls
  never use more than a fifth of your database's time. `mason status` shows what each table's polls cost.

### Logical replication

Write `sync: replication`, usually at the top of the file. Use it for big, busy tables, and when you want changes
within seconds.

- **How it works**: Mason reads the database's change log through one replication slot per project, the way a
  Postgres replica does. Replicated tables stay up to date whatever their size. Tables set to `off` or `poll` keep
  working as before.
- **What it needs**: `wal_level = logical` and a user with `REPLICATION`. It also needs a publication: either you name
  one, or Mason needs permission to create its own. To name one, write `publication:` at the top of the sources file
  (`${PG_PUBLICATION}` works there, as in `url:`). Mason checks a named publication, but never creates, changes or
  drops it. If your source is a read replica, it needs Postgres 16+ and a publication you name.
- **What it can't replicate**: two kinds of table.
  - A table with no primary key (a `key:` entry). The change log has no key to match its changes to rows.
  - A table with `REPLICA IDENTITY NOTHING`. Publishing it would make your app's UPDATEs and DELETEs fail.

  Give such a table `sync: poll <interval>` instead. `mason add` writes this for you.
- **One setting to make on your database**: `max_slot_wal_keep_size` (Postgres 13+). A replication slot keeps WAL
  until its reader has read it. That includes Mason's slot, even while Mason is stopped. This setting limits how much
  WAL the slot may keep. `mason stop` keeps the slot, so the next start resumes where it stopped. Mason drops the slot
  (and checks that it is gone) when no table uses `replication` any more, and on `mason destroy`.

[docs/DESIGN.md](docs/DESIGN.md) "Keeping a copy current" explains every decision behind these, and why.

## Performance vs Postgres

<!-- GENERATED by tests/bench-replica.test.ts from tests/fixtures/bench-replica.json (the headline; docs/MEASUREMENTS.md has the rest), to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
The benchmark runs a dashboard's queries, such as a sum by status over every order, the top N orders joined to their customers, and a group-by over a JSON field. At p95, Mason answers them 15× to 57× faster than Postgres. Mason keeps that lead as the tables grow and as more dashboards query at once:

| | Postgres p95 (s) | Mason p95 (s) | Mason is |
|---|---:|---:|---|
| 1 M rows, 8 clients | 2.06 | 0.14 | 15× faster |
| 30 M rows, 8 clients | 258 | 4.53 | 57× faster |
| 10 M rows, 32 clients | 96.6 | 3.51 | 28× faster |
| one order by its primary key, 30 M rows, 8 clients (p50) | 0.013 | 0.99 | 79× slower |

Mason is for scans and aggregates. A lookup through an index is faster on Postgres ([docs/DESIGN.md](docs/DESIGN.md) "Heap order, no index"). Each p95 is over a mix of 6 dashboard queries. It was measured on m7g.xlarge, 4 vCPU, 15 GiB RAM, EBS gp3, against PostgreSQL 18.6, Docker (postgres:18) on the same machine. [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) has every measurement and how it was taken.
<!-- END GENERATED -->

### When to use Mason

Use Mason for analytical queries: the queries that get slower as your data grows. On a replica, these queries
compete with each other and with everything else. Typical examples are dashboards, reports, BI tools, AI agents and
customer-facing analytics.

Keep your application's own queries on Postgres: fetching a row by its primary key, inserts and updates. Postgres is
faster at point lookups, and Mason is read-only.

### Why it's fast

Postgres is built to find a few rows quickly. Mason is built to read millions of rows quickly. On a large table, four
things make the difference:

- **It reads only the columns a query uses.** Postgres stores a table row by row, so a query that sums one column
  still reads every row in full. Mason stores each column separately, and compressed. A `SUM(amount)` reads the
  `amount` column and nothing else. In the benchmark, the whole copy was about a fifth of the tables' size in Postgres
  (10.1 GiB → 1.8 GiB), so much more of it stays in memory.
- **It processes values in batches, not one row at a time.** Postgres's executor handles one row at a time, and each
  row passes through every step of the plan. DuckDB handles 2,048 values at a time, in tight loops that a modern CPU
  runs very efficiently. Over millions of rows, a `SUM` or a `GROUP BY` costs far less CPU this way.
- **It uses every core for one query.** By default, Postgres gives one query at most 2 extra workers
  (`max_parallel_workers_per_gather`). DuckDB splits a query's scan, aggregation and joins across all the machine's
  cores.
- **It skips blocks that can't match.** For every block of about 122,880 rows, DuckDB keeps each column's smallest and
  largest value. A filter like `created_at > now() - interval '7 days'` skips every block whose dates are all older.
  This works best on columns that grow as rows are inserted, such as `created_at` or an increasing `id`, because Mason
  keeps rows in the order they were inserted.

The trade-off is the index. Mason keeps none, so fetching one row by its primary key means a scan, and Postgres is
faster for that. And because analytical queries run on Mason's machine, they no longer slow down your database.

[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) has every measurement and how it was taken.
[docs/BENCHMARK.md](docs/BENCHMARK.md) shows how to run the benchmark on your own machine.

## Postgres compatibility

Mason's goal is to answer every query exactly as Postgres would. That means the same column names, the same type
OIDs, the same text, the same row order and the same SQLSTATE error codes. So you can keep the SQL you already have.

If Mason can't answer a query exactly, it refuses it. The error says what isn't supported and what to write instead.
In a few cases, Mason answers differently from Postgres on purpose. Each of these cases is listed, with the reason.
Mason never gives a different answer silently.

### How a query is answered

Each query goes through four steps:

1. **Postgres analyses it.** Mason runs a real Postgres (PGlite) in the same process. This Postgres knows the copied
   tables' definitions, but holds none of their rows. It parses the query, works out the type of every expression,
   and names the result's columns. When a tool reads the catalog (`pg_catalog`, `information_schema`), this Postgres
   answers too.
2. **Mason rewrites it** wherever DuckDB would mean something different. Examples are collation and case, `LIKE` and
   regular expressions, JSON, `to_char`, date arithmetic, and casts to text.
3. **An allowlist checks it**, piece by piece. Anything that has not been verified is refused, and the error names it.
4. **DuckDB runs it** on the copy. The answer comes back with the column names, type OIDs and text that Postgres would
   send. Exact `numeric` arithmetic stays exact: it is never rounded through a floating-point number.

### How compatibility is tested

The allowlist is not written by hand. An oracle runs tens of thousands of queries on a real Postgres and on Mason, and
compares the answers. Only queries that come back identical, or that differ by a listed decision, are allowed. Every
fix adds its queries to the oracle. A difference you report becomes a permanent test case.

<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
The oracle also sends 2,998 of its queries to a plain DuckDB connection. Of those, Mason answers 95% exactly as
Postgres does. It answers 1% differently, each by a decision it lists. It refuses 4% with an error that says what
to write instead. None was answered with a wrong value. DuckDB alone, over the same tables, answers only 31% of them exactly.

[docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md) is generated from the code. It lists the 992 verified pieces (types, functions,
operators, aggregates, window functions, casts, constructs and their forms). It also lists the 46 refused shapes, the
14 that are answered differently and the 7 limits, each with what to write instead.
<!-- END GENERATED -->

The tests also replay the queries that BI tools send: psql, pgjdbc, node-postgres, Metabase, Grafana, DBeaver and
Superset. These queries were recorded from the tools themselves. [docs/DESIGN.md](docs/DESIGN.md) "The statement path"
explains the whole process.

## For AI agents

An agent connects like any Postgres client, or over MCP. It gets dashboard speed on the tables you chose. If Mason
can't answer a query exactly, the agent gets an error that says what to write instead, so it can try again.

### Access control

Give each agent and each tool its own user, and a role that says what it may read. A role narrows what the sources
file copies, by table, by column and by row:

```yaml
# mason/roles.yml: commit it next to the sources file, and review it the same way
roles:
  agent:
    tables:
      orders: { columns: [id, status, amount, created_at] }
      customers: { exclude: [email, phone] }   # the same shape as in the sources file
  tenant:
    attributes: [tenant]
    tables:
      orders: { where: "tenant_id = :tenant" }
      order_items: { through: orders }         # filtered through its foreign key to orders
```

```bash
mason user add claude --role agent   # prints its password once, inside the connection URL
mason user add acme --role tenant --set tenant=42
mason user list                      # lists the users, their roles, and when each was added
mason user remove claude             # blocks its next connection, and ends its open sessions at their next query
```

- If a query reads a table or column outside the user's role, Mason refuses it with `42501`, the same error Postgres
  sends. The error names the table or column. A `SELECT *` on a table where the role can see only some columns is
  refused too. Mason never quietly returns fewer columns.
- When a user reads the catalog or uses the MCP tools, it sees only what its role can read. So an agent never finds a
  table it is not allowed to query.
- A user with no role can read every table and column the sources file copies.
- Every user is read-only. Users exist only in Mason, never in your database. `mason user remove` takes effect without
  a restart.
- When clients connect from another machine, the Postgres API requires TLS. The exception is `MASON_PG_PLAIN=1`, for
  when your own TLS proxy sits in front (see [Going to production](#going-to-production)).

### The MCP server

`mason mcp` is an MCP server for Claude Code, Claude Desktop and other agents. It runs over stdio, and it connects to
Mason as a `mason user`, so it follows that user's role. Its tools can:

- list the tables, and how up to date each one is
- describe a table: its columns, Postgres types and keys
- run a query, or EXPLAIN it

If a query is refused, the tool returns Postgres's error, with a hint that says what to write instead. To add the
server to Claude Code, run this in the project's folder while Mason is running:

```bash
mason user add claude --role agent   # prints the URL (shown only once)
claude mcp add mason --env MASON_URL="postgres://claude:<password>@127.0.0.1:5433/shop" -- mason mcp
```

The MCP server talks to Mason only over the Postgres protocol. So it works the same with `mason start` on your
machine and with `mason serve` on a server. [`cli/README.md`](cli/README.md#from-an-mcp-client-mason-mcp) lists every
tool, and shows the setup for Claude Desktop.

### Observability

| | |
|---|---|
| `mason logs --requests` | Every query, answered or refused. For each one: when it ran, the result and SQLSTATE, how long it took, the rows sent, the tool's `application_name`, and the user and its role. For a refused query, it also shows the grant or filter that refused it. An MCP client shows up as `mason-mcp/<client>`. Add `--failed` for refused and failed queries only, or `--json` for every column. Queries are kept for 7 days (`MASON_REQUEST_LOG_DAYS`). |
| `mason status` | Each table's copy and how up to date it is, plus the last day's slow and refused queries, each with its reason. |
| `mason ui` | The status, the slow and refused counts, and the users, in your browser. |
| `EXPLAIN` | For each copy a query reads: its rows and how up to date it is, next to the SQL Mason runs. |

### A CLI for coding agents

You and a coding agent (Claude Code, Codex, …) use the same commands. Each command prints output for a person. With
`--json`, it prints one JSON object with a documented shape instead. Its exit code says whether it worked, and it
always tells you what to run next. `mason help agent` is the page an agent should read first.

## Documentation

| | |
|---|---|
| [`cli/README.md`](cli/README.md) | every command and option of `mason` |
| [`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) | the Postgres API: how a tool connects, which SQL is answered, and what is refused |
| [`docs/WEB-UI.md`](docs/WEB-UI.md) | the web page (`mason ui`): what it shows, how access to it is protected, and how to extend it |
| [`docs/SQL-SUPPORT.md`](docs/SQL-SUPPORT.md) | what is verified to answer exactly as Postgres does, and what is not (generated from the code) |
| [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) | when Mason is faster than a Postgres read replica: every measurement and how it was taken (generated from the benchmark results) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | the design: how a query is answered, the copy, replication, and the decisions and measurements behind them |
| [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | how to run the benchmark against a Postgres read replica, and how to publish the results |
| [`deploy/mason-data/README.md`](deploy/mason-data/README.md) | how to run the image on a server |
| [`release-notes/`](release-notes/README.md) | what each release changes for you, and what to do before upgrading |
| [`CLAUDE.md`](CLAUDE.md) | the rules of the codebase, for anyone who changes it, human or AI. Each subsystem has its own rules in `.claude/rules/` |

## Community

If Mason is slow, gives a wrong answer, or answers anything differently from Postgres, we want to know. Please
[open an issue](https://github.com/embeddable-hq/mason-data/issues/new/choose). The issue forms ask for what we need:
the query, the types, and both answers or both timings. A difference you report becomes a test case that the oracle
checks from then on. To report a security vulnerability privately, see [SECURITY.md](SECURITY.md).

## Contributing

Issues are welcome, and a pull request with a test is even better. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
checks, where the code lives, how to run the checkout's `mason` from any folder, and what a pull request needs.
[CLAUDE.md](CLAUDE.md) has the rules of the codebase, for people and coding agents alike.

## License

Apache-2.0 ([LICENSE](LICENSE)). Copyright Embeddable.
