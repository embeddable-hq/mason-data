# Mason

A drop-in replacement for your Postgres read replica. Same SQL. Same answers. Seconds, not minutes.

- **Lightweight:** Mason is a single Node.js process you can run anywhere.
- **Works like a read replica:** Choose which tables and columns to sync from your Postgres database, and how each stays in sync: on demand, polling or logical replication. Mason makes them available to query from any Postgres client.
- **Exceptionally fast:** Mason rewrites your Postgres queries to run on [DuckDB](https://github.com/duckdb/duckdb)'s columnar engine, in the form DuckDB runs fastest. Analytical queries (`COUNT`, `SUM`, `GROUP BY`, etc.) over large tables run [significantly faster](#speed) than on Postgres.
- **Same SQL, same answers:** Mason is built from the ground up [to match Postgres syntax and behaviour](#compatibility), so you can confidently point your existing SQL queries at Mason, without needing to port them to another SQL dialect (where subtle differences change your results).
- **Built for AI agents:** Give AI agents fast, secure access to your data: a user per agent, role-based access control (RBAC) that limits the tables, columns and rows each one can read, every query logged, and native MCP support.

[![npm](https://img.shields.io/npm/v/@mason-data/cli)](https://www.npmjs.com/package/@mason-data/cli)
[![CI](https://img.shields.io/github/actions/workflow/status/embeddable-hq/mason-data/ci.yml?branch=main&label=CI)](https://github.com/embeddable-hq/mason-data/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-mason-works-dark.svg">
  <img alt="How Mason works: Mason syncs the tables you choose from your Postgres. Each table is kept up to date on demand, by polling or by replication. A BI tool, an AI agent (over SQL or MCP) or your app connects as a user, and the user's role limits the tables, columns and rows it can read. A real Postgres analyses each query. Mason rewrites it into the fastest exact form, runs it on its own columnar tables, and answers exactly as Postgres would. If Mason can't answer exactly, it refuses with an error that says why. Every query is logged. An oracle of tens of thousands of queries decides what is exact." src="docs/how-mason-works.svg" width="100%">
</picture>

**Contents**

- [Try it in 2 minutes](#try-it-in-2-minutes)
- [Use it with your database](#use-it-with-your-database)
  - [Set up a project](#set-up-a-project) · [Choose tables and columns](#choose-tables-and-columns) · [Keep them up to date](#keep-them-up-to-date)
  - [Connect a tool](#connect-a-tool) · [Access control](#access-control) · [Check on it](#check-on-it) · [Run it on a server](#run-it-on-a-server)
- [Speed and compatibility](#speed-and-compatibility)
  - [Speed](#speed) · [Compatibility](#compatibility)
- [Agents](#agents) · [Where to read more](#where-to-read-more) · [Community](#community) · [License](#license)

## Try it in 2 minutes

```bash
npm i -g @mason-data/cli             # needs Node 22.13+ (run mason doctor to check this machine)
mkdir mason-demo && cd mason-demo
mason init demo && mason start       # starts a demo shop database for you: nothing else to install
mason add order_items                # adds the fourth table, so you can watch its sync start
mason ui                             # opens Mason in your browser: the tables syncing, the users and the queries
mason destroy                        # deletes the synced data and the demo database
```

The demo shop has four tables: `customers`, `products`, `orders` and `order_items`. A new order arrives every few
seconds. The demo polls every 5 seconds (`sync: poll 5s`), so `mason status` shows Mason keeping up. Mason reads the
demo database the same way it reads yours: over the Postgres protocol. The demo also has a
[generated table](#generated-tables), `daily_orders`. Nothing is downloaded after `npm install` on most machines
([`cli/README.md`](cli/README.md#requirements)).

## Use it with your database

### Set up a project

A Mason project is your app's folder. Run these in it:

```bash
cd your-app
# Mason reads MASON_DATABASE_URL, then DATABASE_URL, from .env.local, .env or the shell.
mason init                           # creates mason/sources/<database>.yml (commit it) and .mason/ (local, gitignored)
mason tables                         # lists your database's tables, with their rows and keys
mason add orders customers           # adds tables to the sources file
mason start                          # starts Mason in the background and begins the first sync
mason wait                           # waits until every added table is synced
```

Set `MASON_DATABASE_URL` to sync a different database from your app's. `mason init - < db-url.txt` reads the URL from
a file and writes it to `.env`, out of your shell's history. `mason init` also writes `mason/roles.yml`
([Access control](#access-control)) and `mason/mason.yml` (the Mason version). Commit everything in `mason/`.

### Choose tables and columns

The sources file lists the tables Mason syncs. `mason add` and `mason remove` edit it for you, and keep your comments.

```yaml
# mason/sources/app.yml: the database this project syncs from. Commit this file. The URL is not stored in it.
kind: postgres
url: ${DATABASE_URL}          # a variable from .env.local, .env or the shell
sync: off                     # the default for every table, unless a table says otherwise
tables:
  orders:                     # a bare name means the `public` schema; write `billing.invoices` for another schema
    columns: [id, customer_id, status, amount, created_at, payload]
    sync: poll 30s            # this table is polled every 30 seconds
  customers: {}               # syncs every column
  events:
    exclude: [raw_body]       # syncs every column except these
  sessions:
    key: [tenant_id, id]      # only for a table with no primary key: the columns that identify a row
```

- `mason add orders --columns id,status,total` syncs only those columns. `mason add orders --sync "poll 30s"` sets
  how the table stays up to date.
- `mason add` leaves out columns that look like secrets (`password`, `token`, `api_key`, …), and lists them under
  `exclude:`. Name one with `--include` to sync it.
- While Mason runs, `mason add` and `mason remove` take effect at once. A change you make by hand applies at the next
  `mason start`. If an entry has a mistake, Mason names the key and says how to fix it. You never write column types.

### Keep them up to date

Mason reads each table once in full: the first sync. After that, each table's `sync:` says how it stays up to date.

| `sync:` | `off` (the default) | `poll 5m` | `replication` |
|---|---|---|---|
| after the first sync | nothing, until you run `mason sync <table>` | a `SELECT` of the table, at the interval you choose | reads the database's change log, like a replica |
| needs on your Postgres | a user that can `SELECT` the tables | the same | `wal_level = logical`, a user with `REPLICATION` (or `rds_replication`), and a publication |
| creates on your Postgres | nothing | nothing | a replication slot (and a publication, if you don't name one) |
| works on a read replica | yes | yes | yes, on Postgres 16+, with a publication you name |
| good for | trying Mason, and reports that run on a schedule | most tables, every few seconds to every few hours | big, busy tables, and changes within seconds |

**Your database stays safe.** Mason only reads: it never writes, never changes a table, and never asks your database
to sort. The first sync uses at most 3 connections (`MASON_COPY_PARALLEL`). If it stops, it resumes where it stopped.
You can point Mason at a read replica, so its queries run there. Mason connects only when it syncs, or when you ask:
`mason tables`, `add`, `remove`, `status`, `wait` or `doctor`, or the web page while it is open.

**Off.** Mason reads nothing more until you run `mason sync orders` (or `--all`): before a report, from cron, or at
the end of a deploy.

**Polling.** Write `sync: poll <interval>`, from `1s` to `24h`. You set up nothing on your Postgres. Each poll reads the
whole table, because Postgres has no index on what changed. So choose an interval that suits the table's size: every
few seconds for a small table, every hour for one of 50 M rows. After each poll, Mason waits at least four times as
long as the poll took, so a table's polls never take more than a fifth of your database's time. When your file polls
by default, `mason add` writes `sync: off` for a table of over 1 M rows, and says so.

**Logical replication.** Write `sync: replication`. Mason reads the change log through one replication slot per
project, as a Postgres replica does.

- **The publication.** Name one with `publication:` at the top of the sources file (`${PG_PUBLICATION}` works there).
  Mason checks it, but never creates, changes or drops it. Otherwise Mason needs the right to create its own. A read
  replica needs Postgres 16+ and a publication you name.
- **Two kinds of table can't be replicated.** These are a table with no primary key (a `key:` entry), and one with
  `REPLICA IDENTITY NOTHING`. Give them `sync: poll <interval>` instead. `mason add` writes this for you.
- **Cap the slot's WAL.** A slot keeps WAL until Mason reads it, even while Mason is stopped. Set
  `max_slot_wal_keep_size` (Postgres 13+) on your database to limit it. Mason drops the slot, and checks it is gone,
  when no table uses `replication` any more, and on `mason destroy`.

If you change a table's `sync:`, Mason keeps its data and catches it up with one poll. [`docs/DESIGN.md`](docs/DESIGN.md#keeping-a-copy-current)
explains how each one works, and why.

### Connect a tool

Which command depends on where the tool runs:

```bash
mason user add metabase              # a tool that can reach this machine: prints a connection URL (shown only once)
mason share                          # a tool in the cloud: prints a temporary address and login (Ctrl-C ends it)
```

Paste what it prints into your tool's Postgres connection form. Each synced table appears as a table in a database
named `mason`. To move a tool that reads your Postgres, change its host, port and database name, or keep the name with
`database: <name>` in the sources file.

A user's password lasts until you remove the user. `mason share` is for trying Mason with a cloud BI tool, on data
you may send through a free tunnel service. It is encrypted, but the tool does not verify the certificate, and it
lasts about an hour. The web page's Users page offers it as Temporary cloud login. To keep a dashboard running,
[run Mason on a server](#run-it-on-a-server).

[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) explains how tools connect and which SQL Mason answers.

### Access control

Every tool and agent connects as a user, and a role says what it may read. A role narrows what the sources file syncs,
by table, by column and by row:

```yaml
# mason/roles.yml: mason init writes it. Commit it next to the sources file, and review it the same way.
default: everything           # the role of a user added without --role
roles:
  everything:
    tables: all               # every synced table and column, including tables added later
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
mason user disable claude            # refuses its logins until mason user enable claude (it keeps its password)
mason user remove claude             # blocks its next connection, and ends its open sessions at their next query
```

- A query that reads a table or column outside the user's role is refused with `42501`, as Postgres refuses it. A
  `SELECT *` over hidden columns is refused too. Mason never quietly returns fewer columns.
- Remove the `default:` line, and a user with no role reads nothing.
- Every user is read-only, and exists only in Mason, never in your database. Changes take effect without a restart.

[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md#roles) has every rule.

### Check on it

```bash
mason status                         # your database, each synced table, the Postgres API, and the last day's and week's queries
mason ui                             # the same in your browser, and more
mason logs --requests --failed       # every query that was refused, failed or cancelled, and why
mason logs --events                  # the sync's events: failures, restarts, each sync you asked for (--scheduled: every one)
mason logs --running                 # the queries running now (mason cancel <session> stops one)
mason usage --since 7d --step 1h     # the last week, one line per hour: queries, the synced data, memory
mason stop                           # stops Mason; the synced data stays, and the next mason start resumes in seconds
```

`mason status` lists the facts (Source, Sources file, Version, Up, Free disk, Connections open), then each table with
how it stays up to date and when it last synced, then the queries. `mason ui` opens the web page. Its Overview has
cards for the last day's sync and query errors. Tables and Users let you add and remove tables and users, and
Observability shows the queries, usage and sync events, each time range updating by itself.

`mason --help` lists every command, and [`cli/README.md`](cli/README.md) documents each one.

### Run it on a server

On a server, Mason runs as one container, `ghcr.io/embeddable-hq/mason-data`, with `mason serve`. You deploy only
the project folder, `mason/`. It already names your tables and how each one syncs. Run `mason help production` to read
the whole road offline.

```bash
cd your-app                          # the folder that holds mason/
curl -fsSLO https://raw.githubusercontent.com/embeddable-hq/mason-data/main/deploy/mason-data/compose.yml
# On the server, .env sets the database URL (under the name your sources file uses: MASON_DATABASE_URL or
# DATABASE_URL), MASON_API_KEY (openssl rand -hex 24) and MASON_PG_SELF_SIGNED_TLS=1 (see TLS below).
docker compose up -d                 # starts ghcr.io/embeddable-hq/mason-data with your mason/ folder
docker compose exec mason mason user add metabase   # users are kept on the server, so add them there
```

- **One container per volume.** Only one process can write the synced data. Deploy with stop-then-start (in
  Kubernetes, `strategy: Recreate`). The synced data stays on the volume, so a deploy is a few seconds of downtime,
  not a sync from scratch.
- **TLS.** Clients from outside the container need it. `MASON_PG_SELF_SIGNED_TLS=1` makes a certificate (clients use
  `sslmode=require`), or mount one from your CA.
- **Memory.** Give the container 3 GiB or more, and enough for the columns your dashboards read.
  [Memory](deploy/mason-data/README.md#memory) says how to size it.
- **Checks.** `/healthz` answers once Mason serves, about 15 seconds after the first start. `/metrics` is for
  Prometheus, with numbers only. `mason ui --ssh <user@server>` opens the server's web page from your machine.
- **Upgrades.** Mason is pre-1.0, so a release may rename a command, a key or a setting. `mason.yml` pins the version.
  Read the [release notes](release-notes/README.md) before each upgrade.

[`deploy/mason-data/README.md`](deploy/mason-data/README.md) walks you through it, with
[the settings](deploy/mason-data/README.md#settings) to decide. [`deploy/README.md`](deploy/README.md) has guides for
Fly.io, Kubernetes, Railway and AWS ECS. A hosted Mason service can also run it for you
([`docs/HOSTED-API.md`](docs/HOSTED-API.md)).

## Speed and compatibility

### Speed

<!-- GENERATED by tests/bench-replica.test.ts from tests/fixtures/bench-replica.json (the headline; docs/MEASUREMENTS.md has the rest), to the END line: never edit by hand; UPDATE_FIXTURE=1 npm run check rewrites it -->
The benchmark runs a dashboard's queries, such as a sum by status over every order, the top N orders joined to their customers, and a group-by over a JSON field. At p95, Mason answers them 15× to 57× faster than Postgres. Mason keeps that lead as the tables grow and as more dashboards query at once:

| | Postgres p95 (s) | Mason p95 (s) | Mason is |
|---|---:|---:|---|
| 1 M rows, 8 clients | 2.06 | 0.14 | 15× faster |
| 30 M rows, 8 clients | 258 | 4.53 | 57× faster |
| 10 M rows, 32 clients | 96.6 | 3.51 | 28× faster |
| one order by its primary key, 30 M rows, 8 clients (p50) | 0.013 | 0.99 | 79× slower |

Mason is for scans and aggregates. A lookup through an index is faster on Postgres ([docs/DESIGN.md](docs/DESIGN.md) "Heap order, no index"). Each p95 is over a mix of 6 dashboard queries. It was measured on m7g.xlarge, 4 vCPU, 15 GiB RAM, EBS gp3, against PostgreSQL 18.6, Docker (postgres:18) on the same machine. [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) has every measurement and how it was taken.
<!-- END GENERATED -->

Use Mason for analytical queries, and keep your application's own reads and writes on Postgres. Mason is fast because
DuckDB reads only the columns a query uses, works on batches of values, uses every core for one query, and skips blocks
of rows a filter can't match. Mason also stores the JSON fields your queries keep reading, and rewrites slow query
shapes into fast ones with the same answer. [`docs/POSTGRES-API.md`](docs/POSTGRES-API.md#fast-queries) explains each,
and how to make queries faster. [`docs/BENCHMARK.md`](docs/BENCHMARK.md) shows how to run the benchmark yourself.

#### Generated tables

When dashboards keep computing the same aggregate, declare it as a generated table: a file in
`mason/generated_tables/` that holds a `SELECT`. Mason keeps it up to date from the synced tables, inside Mason, and a
query reads it by name. The demo's `daily_orders.yml` is one. `mason help generated` has every key and rule.

### Compatibility

Mason answers every query exactly as Postgres would: the same column names, type OIDs, text, row order and SQLSTATE
error codes. If it can't, it refuses the query, and the error says what to write instead. It never gives a different
answer silently, and the [few cases](docs/SQL-SUPPORT.md#answered-differently) it answers differently on purpose are
listed. An oracle runs tens of thousands of queries on a real Postgres and on Mason, and allows only what comes back
identical. The tests also replay what psql, pgjdbc, node-postgres, Metabase, Grafana, DBeaver and Superset send.

<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm run check rewrites it -->
To show what Mason adds over DuckDB by itself, the oracle also sends 7,400 of its queries to a plain DuckDB connection,
over the same tables. **DuckDB alone answers only 25% of them exactly as Postgres does. Mason answers 93%.**
It answers 1% differently, each by a decision it lists, and it refuses 6% with an error that says what to write
instead. None was answered with a wrong value.

[docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md) is generated from the code. It lists the 1,153 verified pieces (types, functions,
operators, aggregates, window functions, casts, constructs and their forms). It also lists the 63 refused shapes, the
19 that are answered differently and the 8 limits, each with what to write instead.
<!-- END GENERATED -->

[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) says how a query is answered and how this is tested.

## Agents

An agent connects like any Postgres client, or over MCP, as a user with a role ([Access control](#access-control)). If
Mason can't answer a query exactly, the agent gets an error that says what to write instead, so it can try again.

`mason mcp` is an MCP server for Claude Code, Claude Desktop and other agents. Its tools list the tables, describe
one, and run or EXPLAIN a query. To add it to Claude Code, run this in the project's folder while Mason is running:

```bash
mason user add claude --role agent   # prints the URL (shown only once)
claude mcp add mason --env MASON_URL="postgres://claude:<password>@127.0.0.1:5433/mason" -- mason mcp
```

A coding agent (Claude Code, Codex, …) uses the same commands you do. With `--json`, a command prints one JSON object
with a documented shape and what to run next, and its exit code says whether it worked. `mason help agent` is the page
an agent should read first. [`cli/README.md`](cli/README.md#for-coding-agents) has the details.

## Where to read more

| | |
|---|---|
| [`cli/README.md`](cli/README.md) | every command and option of `mason` |
| [`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) | the Postgres API: how a tool connects, roles, which SQL is answered, and how to make queries fast |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | what you can see about a running Mason: each command, its endpoint and its JSON |
| [`docs/WEB-UI.md`](docs/WEB-UI.md) | the web page (`mason ui`): its pages, how access to it is protected, and how to extend it |
| [`docs/SQL-SUPPORT.md`](docs/SQL-SUPPORT.md) | what is verified to answer exactly as Postgres does, and what is not (generated from the code) |
| [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) | when Mason is faster than a Postgres read replica: every measurement and how it was taken |
| [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | how to run the benchmark against a Postgres read replica |
| [`deploy/mason-data/README.md`](deploy/mason-data/README.md) | how to run the image on a server, and how to size it |
| [`deploy/README.md`](deploy/README.md) | which platforms can run Mason, each with a guide, and which can't |
| [`docs/DESIGN.md`](docs/DESIGN.md) | the design: how a query is answered, the first sync, polling, replication, and the measurements behind them |
| [`release-notes/`](release-notes/README.md) | what each release changes for you, and what to do before upgrading |
| [`CLAUDE.md`](CLAUDE.md) | the rules of the codebase, for anyone who changes it, human or AI |

## Community

If Mason is slow, gives a wrong answer, or answers anything differently from Postgres, please
[open an issue](https://github.com/embeddable-hq/mason-data/issues/new/choose). The forms ask for the query, the types,
and both answers or both timings. A difference you report becomes a test case. To report a security vulnerability
privately, see [SECURITY.md](SECURITY.md). Pull requests with a test are welcome: [CONTRIBUTING.md](CONTRIBUTING.md)
says what one needs.

## License

Apache-2.0 ([LICENSE](LICENSE)). Copyright Embeddable.
