# Mason

A **drop-in replacement** for **a Postgres read replica**, built for **exceptionally fast analytical queries.**

- **Lightweight:** Mason runs anywhere as a single Node.js process (`mason init && mason start`). [Learn more](#getting-started)
- **Like a read replica:** Choose which tables and columns to sync from your Postgres database. Mason keeps them in sync and makes them available to query. [Learn more](#syncing-from-postgres)
- **Lightning fast:** Under the hood, Mason uses [DuckDB](https://github.com/duckdb/duckdb)'s columnar engine to accelerate analytical queries (`COUNT`, `SUM`, `GROUP BY`, etc.) over large tables. [Learn more](#performance-vs-postgres)
- **Keep your existing SQL:** Mason is built from the ground up to match Postgres syntax and behaviour, so you can reuse existing SQL without risky rewrites or subtle changes to query semantics. [Learn more](#postgres-compatibility)
- **Built for AI agents:** Give AI agents fast, secure access to your data, with a database user per agent that you can revoke at once, every query logged, and native MCP support. [Learn more](#for-ai-agents)

[Documentation](#documentation) · [Website](https://masondata.ai) · [Issues](https://github.com/embeddable-hq/mason-data/issues)

<!-- The version badge reads cli/package.json: once @mason-data/cli is on npm, switch it to https://img.shields.io/npm/v/@mason-data/cli linking https://www.npmjs.com/package/@mason-data/cli -->
[![version](https://img.shields.io/github/package-json/v/embeddable-hq/mason-data?filename=cli%2Fpackage.json&label=version)](cli/README.md)
[![CI](https://img.shields.io/github/actions/workflow/status/embeddable-hq/mason-data/ci.yml?branch=main&label=CI)](https://github.com/embeddable-hq/mason-data/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Version 0.x: until 1.0, a release may rename a command, a key or a setting, with no compatibility shim.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-mason-works-dark.svg">
  <img alt="How Mason works: the tables you name are copied from your Postgres and kept current by the poll or the stream; every statement a BI tool, an AI agent or your app sends over the Postgres protocol is analysed by a real Postgres, run on the columnar copy, and answered as Postgres would or refused by name." src="docs/how-mason-works.svg" width="100%">
</picture>

## Getting started

Mason is one process: no cluster to run, no Docker, nothing installed on your Postgres. The copy lives in a DuckDB file
in `.mason/`; the Postgres API is Mason's own wire-protocol listener in the same process, and the catalog a tool reads
(`pg_catalog`, `information_schema`) is a real Postgres (PGlite, no rows). On your machine it is
`mason init && mason start`; in production it is one container, `mason serve`, its copy on one volume
([Going to production](#going-to-production)).

### Try the demo

```bash
npm i -g @mason-data/cli             # needs Node 22.13+ (`mason doctor` checks this machine)
mkdir mason-demo && cd mason-demo
mason init demo && mason start       # a small shop's Postgres, run by Mason in its own process: no Docker
mason add order_items                # the fourth table: its copy begins (or Add, on mason ui)
mason user add me                    # prints the URL with its password, once: paste it below
psql "<the URL it printed>" -c "select status, count(*) from orders group by 1"   # psql, or any Postgres client
mason destroy                        # the copy and the demo database go; the next mason start seeds it again
```

Not on npm yet: until the first release, run it from a checkout (Node ≥ 23.6):
`git clone https://github.com/embeddable-hq/mason-data && cd mason-data && npm install && alias mason="node $PWD/src/cli/main.ts"`.

The demo is a small shop (`customers`, `products`, `orders`, `order_items`) in a Postgres that `mason start` runs in
its own process, kept in `.mason/demo/` and served on a port of this machine. Three of the four tables are added
already; the fourth is yours, so the first thing you do is a real `mason add` and you watch its copy begin. A new order
lands every few seconds, so `mason status` shows the copy keeping up. Mason reads it as it reads yours, over the
Postgres protocol, by polling (the demo database has no change log, so `--replication` does not apply).

### On your app's database

**1. Make the folder a project, add tables, start.** `mason init` reads `DATABASE_URL` from `.env.local`, `.env` or
the shell (or takes the URL) and checks it can read the database. No `DATABASE_URL`? Give the URL to `mason init` and
it is written to `.env` for you (as `MASON_DATABASE_URL` when your app's `DATABASE_URL` names another database, which
is never changed). It writes the sources file, `mason/sources/<database>.yml`, yours to commit
([Choosing what to sync](#choosing-what-to-sync)); `.mason/` beside it is this machine's copy and Mason's state
(gitignored). `mason add` adds a table to the file, checked against the database first, and `mason start` copies what
the file names:

```bash
cd your-app
# add your database URL to .env if it's not already there
# echo "DATABASE_URL=postgres://me:secret@localhost:5432/your_app" >> .env   
mason init                           # creates a `mason` folder containing config files and a .gitignored .mason folder containing local state
mason tables                         # what this database has: rows, keys, what is added
mason add orders customers           # add them (--columns id,status,total: those only, one table at a time)
mason start                          # Mason in the background, for this folder: the copy begins; returns once it is up
mason wait                           # until every added table is copied and served
mason remove customers               # (later) take one out of the file again; its copy is dropped
```

**2. Connect a tool.** `mason user add` makes a user of Mason's Postgres API and prints its password once, with the
URL to paste into the tool's datasource form:

```bash
mason user add metabase              # postgres://metabase:<password>@127.0.0.1:5433/your-app
mason ui                             # the status page and the users, in your browser
```

The tool sends the SQL it sends Postgres and reads the same names, types and text back; each copied table is a table
of the database named after your project. The first start takes port 5433 (or the next free one when a second Postgres
holds it) and every later start listens on the same port, so a saved connection keeps working.
[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) says what SQL is answered, what is refused by name, and how a tool
connects.

**3. Keep an eye on it.** `mason status` says what Mason is doing: the database and how its changes are read, each
table's copy, the Postgres API and how it listens, the statements it answered slowly in the last day and the ones it
refused, each with its reason ([Observability](#observability)).

```bash
mason status
mason logs --requests --failed       # every statement the Postgres API refused or failed, with why
mason stop                           # the copy stays; the next `mason start` resumes in seconds
mason destroy                        # removes this project's copy and state, never its files or users
```

`mason --help` lists every command in the order you will need them, and `mason help <command>` says how to use one,
with examples; [`cli/README.md`](cli/README.md) has every command and option.

### Going to production

Only the project folder travels: `mason/`, the sources file and `mason.yml` (the Mason version
it is written for). In production Mason runs as one container, `mason serve`, configured by the
environment, its copy on one volume, with `/healthz` for the platform. `mason help production` is
this section, offline.

From a checkout of this repository (or with `deploy/mason-data/compose.yml` and `.env.example` copied into a folder of
yours):

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
- Polling needs a user that can `SELECT` the tables; `MASON_CHANGES=replication` reads the change log
  instead ([Logical replication](#logical-replication) says what it needs).
- **Memory**: the copy may use half the container's memory limit by default (else half the
  machine's RAM); the other half is the page cache, the catalog (~820 MB) and Node. Give the
  container enough that the page cache holds the columns your dashboards read: a query over a
  column it does not hold runs at the disk's speed. The benchmark's copy was about a fifth of its
  tables in Postgres (10.1 GiB → 1.8 GiB, on a 15 GiB machine); `mason status` says yours. To set
  it, `MASON_DUCKDB_MEMORY=4GB` with the container's limit about twice that. A statement past it
  fails alone (53200) and the run goes on; a value near the container's limit is an OOM kill.
- **CPU**: memory first, then cores. The benchmark's machine (4 vCPU Graviton3, 15 GiB) answered
  32 clients at 10 M rows, 12 statements a second at a p95 of 3.5 s, as many a second as at 8
  clients: more clients waited longer. A copy's readers take about a core each while it runs
  (`MASON_COPY_PARALLEL`, default 3). The image is arm64 (the measured one) and amd64.

[`deploy/mason-data/README.md`](deploy/mason-data/README.md#settings) lists the settings a
production run must set and the ones worth deciding; `mason serve --help` has every one.

## Syncing from Postgres

Point Mason at your Postgres and name the tables and columns you want. It copies them, keeps them in sync as rows
change, and serves them over the Postgres wire protocol: a BI tool (Metabase, Grafana, Superset, Power BI, psql), an
AI agent or your own analytics code connects as it would to any read replica. Mason only reads your Postgres, which is
your production database: it writes nothing there, and installs nothing. There are two ways it keeps a copy current,
polling (the default) and logical replication:

| | Polling (the default) | Logical replication |
|---|---|---|
| reads | `SELECT`s, every 5 s | the database's change log, as a replica does |
| needs on your Postgres | a user that can `SELECT` the tables | `wal_level = logical`, a user with `REPLICATION`, a publication |
| makes on your Postgres | nothing | a replication slot (and a publication, when you name none) |
| a read replica as the source | yes | Postgres 16+, with a publication you name |
| tables kept current | up to 1,000,000 rows each; a bigger one on `mason sync <table>` | every table, whatever its size |
| turned on by | `mason start` (or `--poll` to go back) | `mason start --replication`; `MASON_CHANGES=replication` on a server |

### Choosing what to sync

The sources file, `mason/sources/<database>.yml`, is the list of what Mason copies, a table per entry; the URL itself
stays in `.env`, the file names the variable:

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

A column that looks like a secret (`password`, `token`, `api_key`, …) is left out unless you name it, written as
`exclude:`. Column types are read from the database at every start, never written in the file. With Mason running,
`mason add` starts the copy at once and the table is served the moment it lands (before `mason start`, the copy
begins at the start); `mason add` and `mason remove` keep the rest of the file as it was, comments included. An entry
you edit by hand is applied at the next `mason start`, and a mistake in it is refused with the key and the way out.

### The first copy

Each table is read a range of heap pages at a time, a few chunks in parallel (`MASON_COPY_PARALLEL`, default 3), one
Postgres backend each, never more: the load stays on Mason's side. Small tables are copied first, and a copy that
stops (a crash, `mason stop`) continues with the ranges it did not commit. A table is served the moment its copy lands,
and a copy runs beside the polls and the stream, never instead of them, so adding a big table never stops the others
from keeping up. `mason wait` shows each table's progress.

### Polling

The default, and the one that needs nothing on your Postgres. Every 5 seconds (`MASON_POLL_MS`) each table is read in
one transaction over one snapshot: the rows changed since the last poll (by `xmin`, Postgres's own row version) are
written by key, the source's count is compared with the copy's, and only when they differ are the keys compared to
find the deleted rows. The rows and the poll's position commit together, so a poll that dies is simply read again.

No index covers `xmin`, so a poll is a full scan of every polled table. Two rules keep that off your database: the
interval stretches to four times the last poll, so polls take at most a fifth of the source's time; and a table over
1,000,000 rows is copied and served but not polled. `mason status` and `mason wait` say so on its line; `mason sync
<table>` polls it now, and logical replication keeps it current.

### Logical replication

`mason start --replication` (on a server, `MASON_CHANGES=replication`) reads the change log the way a Postgres replica
does, through a replication slot of its own: every table is kept current whatever its size, a change typically lands
within seconds, and a poll's full scans are gone. A switch keeps the copies and catches each table up by one poll, never
a fresh copy; `--poll` goes back.

It needs `wal_level = logical`, a user with `REPLICATION`, and either a publication you name (`--publication`, or
`PG_PUBLICATION`), which Mason reads and verifies but never creates, alters or drops, or the right to create one. On a
read replica it needs Postgres 16+ and a publication you name. A table with no primary key (a `key:` entry) or with
`REPLICA IDENTITY NOTHING` is refused by name: publishing its updates would fail your application's own UPDATEs.

**A replication slot outlives its reader**, and holds your database's WAL while nobody reads it. Cap it on the source
with `max_slot_wal_keep_size` (Postgres 13+). `mason stop` leaves the slot (the next start resumes from it);
`mason destroy` and `--poll` drop it, verified gone.

[docs/DESIGN.md](docs/DESIGN.md) "Keeping a copy current" has every decision behind both, and why.

## Performance vs Postgres

<!-- GENERATED by tests/bench-replica.test.ts from tests/fixtures/bench-replica.json (the headline; docs/MEASUREMENTS.md has the rest), to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
A sum by status over every order, a top-N joined to its customers, a group-by over a JSON field: each comes back 15× to 57× faster than on Postgres at p95, and keeps that lead as the tables grow and as more dashboards ask at once:

| | Postgres p95 (s) | Mason p95 (s) | Mason is |
|---|---:|---:|---|
| 1 M rows, 8 clients | 2.06 | 0.14 | 15× faster |
| 30 M rows, 8 clients | 258 | 4.53 | 57× faster |
| 10 M rows, 32 clients | 96.6 | 3.51 | 28× faster |
| one order by its primary key, 30 M rows, 8 clients (p50) | 0.013 | 0.99 | 79× slower |

Mason is for scans and aggregates; a lookup through an index stays Postgres's ([docs/DESIGN.md](docs/DESIGN.md) "Heap order, no index"). Each p95 is of a dashboard's mix of 6 statements, measured on m7g.xlarge, 4 vCPU, 15 GiB RAM, EBS gp3, against PostgreSQL 18.6, Docker (postgres:18) on the same machine; [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) has every measurement and how it was taken.
<!-- END GENERATED -->

### What Mason is for, and what stays on Postgres

**For analytics, not for your application's reads and writes.** Mason is for the scans and aggregates that get slower
as data grows and that, on a replica, compete with each other and with everything else. Dashboards and reports, BI
tools, AI agents and customer-facing analytics: Mason makes them fast and predictable at scale, and takes them off
your database. Keep your application's own queries (a row by its primary key, an insert, an update) on Postgres, which
is built for them: a point lookup by primary key is faster there, and Mason answers no writes.

### How it is fast

- **A columnar copy.** DuckDB stores each column apart, compressed, and a query reads only the columns it names, a batch of
  values at a time over every core, where Postgres reads each row whole. The benchmark's tables took about a
  fifth of their size in Postgres (10.1 GiB → 1.8 GiB), so more of what a dashboard reads stays in memory.
- **No index, in the source's order.** A copy keeps its rows in the order Postgres's scan delivers them (about the
  order they were inserted in), with no index to maintain: a query over a time window skips most of the row groups outside it,
  and a change is written without an index to update. That is also why a lookup by primary key is a scan, and
  Postgres's.
- **Off your database.** A dashboard's scans run on Mason's machine, so they no longer compete with your application
  for your database's CPU, memory and disk; what Mason costs your database is a copy read a few chunks at a time, then
  the polls or the change log ([Syncing from Postgres](#syncing-from-postgres)).

[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) is every measurement and how it was taken;
[docs/BENCHMARK.md](docs/BENCHMARK.md) runs the benchmark on your own machine.

## Postgres compatibility

Mason's goal is to answer every statement it accepts exactly as Postgres would: the same column names, type OIDs and
text, the same order, the same SQLSTATE. You keep the SQL you already run, without rewriting it for a warehouse. What
Mason cannot answer exactly is refused by name, the error saying what to write instead, never answered differently.

### Postgres decides, DuckDB computes

Every statement is analysed by a real Postgres first: the catalog Postgres (PGlite, in the same process) holds the
copied tables' definitions and no rows, parses the statement, types every expression and names the result's columns.
The catalog a tool reads at connection (`pg_catalog`, `information_schema`) is that Postgres too. The statement is then
rewritten wherever DuckDB's meaning differs (collation and case, `LIKE` and regex, JSON, `to_char`, date arithmetic,
casts to text), checked piece by piece against an allowlist of what is verified, run on the copy,
and answered with Postgres's names, OIDs and text. A `numeric` Postgres computes exactly is computed exactly, never
as DuckDB's double.

### The oracle

The allowlist is not written by hand: an oracle runs tens of thousands of statements on a real Postgres and on Mason,
holds each answer to Postgres's (names, OIDs, text, order, SQLSTATE), and allows only what came back identical. A fix
for a class of statement adds a statement to it, and a difference you report becomes a case the oracle holds Mason to
from then on:

<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
Of the 2,998 statements the oracle also sends to a plain DuckDB connection, Mason answers 95% exactly as Postgres
does, 1% differently by a decision it lists, and refuses 4% by name, saying what to write instead;
none was answered with a wrong value. DuckDB alone, over the same tables, answers 31% of them exactly. [docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md),
rendered from the code, names the 992 pieces verified (types, functions, operators, aggregates, window functions,
casts, constructs and their forms), the 46 shapes refused, the 14 answered differently and the 7 limits, each
with what to write instead.
<!-- END GENERATED -->

What BI tools send is recorded from the tools themselves, never transcribed (psql, pgjdbc, node-postgres, Metabase,
Grafana, DBeaver and Superset), and every recorded statement is replayed by the tests. [docs/DESIGN.md](docs/DESIGN.md) "The statement path" is
how a statement is answered, and how the list stays true.

## For AI agents

An agent connects as any Postgres client does, or over MCP, and gets a dashboard's speed on the tables you chose. A
statement Mason cannot answer exactly comes back refused with what to write instead, which an agent can act on, never
with a different answer it would trust.

### Access control

Give each agent and each tool a user of its own:

```bash
mason user add claude                # its password, printed once, in the URL to connect with
mason user list                      # the users, and when each was added
mason user remove claude             # refuses its next connection, ends its sessions at their next statement
```

A user is a login to Mason's Postgres API alone, never to your database. It reads only the tables and columns the
sources file names (a column that looks like a secret is left out unless you name it), and Mason answers no writes.
`mason user remove` takes effect without a restart. Off this machine the Postgres API is TLS or refused
([Going to production](#going-to-production)).

### The MCP server

`mason mcp` is an MCP server on stdio for Claude Code, Claude Desktop and other agents, connected as a `mason user`.
Its tools list the tables and how current each is, describe one (its columns, Postgres types and keys), run a query
and EXPLAIN it; a refusal comes back as Postgres's (SQLSTATE, message and the hint with the way out). In Claude Code,
in the project's folder with Mason running:

```bash
mason user add claude                # the URL, printed once
claude mcp add mason --env MASON_URL="postgres://claude:<password>@127.0.0.1:5433/shop" -- mason mcp
```

It works against `mason start` on your machine as against `mason serve` elsewhere: it reads only the wire.
[`cli/README.md`](cli/README.md#from-an-mcp-client-mason-mcp) has every tool and the setup for Claude Desktop.

### Observability

- **Every query logged.** Every statement is a row of the request log, refused or answered: when, the outcome and
  SQLSTATE, how long, the rows sent, the tool's `application_name` and the user's name (an MCP client's is
  `mason-mcp/<client>`). `mason logs --requests` reads it, `--failed` for the refused and failed only, `--json` for
  every column; it is kept 7 days (`MASON_REQUEST_LOG_DAYS`).
- **`mason status`** shows each table's copy and how current it is, and the last day's slow and refused statements,
  each with its reason; `mason ui` shows the status, the slow and refused counts and the users in your browser.
- **EXPLAIN** says, for each copy a statement reads, its rows and how current it is, beside the SQL DuckDB ran.

### A CLI an agent can drive

The commands are the same for you and for a coding agent (Claude Code, Codex, …). Each prints for a person or, with
`--json`, one object of a declared shape; it says by its exit code how it went and names what to run next.
`mason help agent` is the page an agent reads first.

## Documentation

| | |
|---|---|
| [`cli/README.md`](cli/README.md) | every command and option of the `mason` command |
| [`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) | the Postgres API: connecting a tool, what SQL is answered, what is refused by name |
| [`docs/WEB-UI.md`](docs/WEB-UI.md) | the web page of `mason start` (`mason ui`): what it shows, how it is opened and guarded, how to build it out |
| [`docs/SQL-SUPPORT.md`](docs/SQL-SUPPORT.md) | what is verified to answer exactly as Postgres does, and what is not (rendered from the code) |
| [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) | when Mason is faster than a Postgres read replica: every measurement and how it was taken (rendered from the benchmark's result) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | the design: how a statement is answered, the copy, replication, the decisions and measurements behind them |
| [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | Mason against a Postgres read replica: running the benchmark and publishing its result |
| [`deploy/mason-data/README.md`](deploy/mason-data/README.md) | running the image on a server |
| [`release-notes/`](release-notes/README.md) | what each release changes for you, and what to do before upgrading |
| [`CLAUDE.md`](CLAUDE.md) | the rules of the codebase, for anyone changing it, human or not; each subsystem's own rules are in `.claude/rules/` |

## Community

If Mason is slow, inaccurate, or answers anything differently from Postgres, we want to know:
[open an issue](https://github.com/embeddable-hq/mason-data/issues/new/choose). The issue forms ask for what a report
needs (the statement, the types, both answers or both timings), and a reported difference becomes a case the oracle
holds Mason to from then on. [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## Contributing

An issue is welcome; a pull request with a test is better. [CONTRIBUTING.md](CONTRIBUTING.md) has the checks, where
the code lives, how to run the checkout's `mason` from any folder, and what a pull request needs.
[CLAUDE.md](CLAUDE.md) has the rules of the codebase, for people and coding agents alike.

## License

Apache-2.0 ([LICENSE](LICENSE)). Copyright Embeddable.
