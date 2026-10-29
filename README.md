# Mason

A **drop-in replacement** for **a Postgres read replica**, built for **exceptionally fast analytical queries.**

- **Lightweight:** Mason runs anywhere as a single Node.js process (`mason init && mason start`). [Learn more](#getting-started)
- **Like a read replica:** Choose which tables and columns to sync from your Postgres database. Mason keeps them in sync and makes them available to query. [Learn more](#syncing-from-postgres)
- **Lightning fast:** Under the hood, Mason uses [DuckDB](https://github.com/duckdb/duckdb)'s columnar engine to accelerate analytical queries (`COUNT`, `SUM`, `GROUP BY`, etc.) over large tables. [Learn more](#performance-vs-postgres)
- **Keep your existing SQL:** Mason is built from the ground up to match Postgres syntax and behaviour, so you can reuse existing SQL without risky rewrites or subtle changes to query semantics. [Learn more](#postgres-compatibility)
- **Built for AI agents:** Give AI agents fast, secure access to your data: a user per agent, a role that limits the tables, columns and rows it can read, every query logged, and native MCP support. [Learn more](#for-ai-agents)

[Documentation](#documentation) · [Website](https://masondata.ai) · [Issues](https://github.com/embeddable-hq/mason-data/issues)

[![npm](https://img.shields.io/npm/v/@mason-data/cli)](https://www.npmjs.com/package/@mason-data/cli)
[![CI](https://img.shields.io/github/actions/workflow/status/embeddable-hq/mason-data/ci.yml?branch=main&label=CI)](https://github.com/embeddable-hq/mason-data/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-mason-works-dark.svg">
  <img alt="How Mason works: the tables you name are copied from your Postgres and kept current by the poll or the stream; every statement a BI tool, an AI agent or your app sends over the Postgres protocol is analysed by a real Postgres, run on the columnar copy, and answered exactly as Postgres would, or refused with an error saying why." src="docs/how-mason-works.svg" width="100%">
</picture>

## Getting started

Mason is a single process, with nothing to install on your Postgres: the npm package on your machine, the
`ghcr.io/embeddable-hq/mason-data` image on a server ([Going to production](#going-to-production)).

### Try the demo

```bash
npm i -g @mason-data/cli             # needs Node 22.13+ (`mason doctor` checks this machine)
mkdir mason-demo && cd mason-demo
mason init demo && mason start       # a small shop's Postgres, which Mason runs for you: nothing else to install
mason add order_items                # the fourth table: watch its copy begin (or Add, on mason ui)
mason user add me                    # prints the URL with its password, once: paste it below
psql "<the URL it printed>" -c "select status, count(*) from orders group by 1"   # psql, or any Postgres client
mason destroy                        # the copy and the demo database go; the next mason start seeds it again
```

The demo shop (`customers`, `products`, `orders`, `order_items`) lives in `.mason/demo/` and takes a new order every
few seconds, so `mason status` shows the copy keeping up. Mason reads it as it reads yours, over the Postgres protocol.

### On your app's database

**1. Add your tables and start.**

```bash
cd your-app                          # DATABASE_URL in .env.local, .env or the shell (or: mason init <url>)
mason init                           # writes mason/sources/<database>.yml (commit it) and .mason/ (this machine's, gitignored)
mason tables                         # what your database has: tables, rows, keys, what is added
mason add orders customers           # add tables (--columns id,status,total for some columns only)
mason start                          # Mason in the background: the copy begins
mason wait                           # returns once every added table is copied and served
mason remove customers               # (later) take a table out again; its copy is dropped
```

`mason init <url>` writes the URL to `.env` for you (as `MASON_DATABASE_URL` when your app's `DATABASE_URL` names
another database, which is never changed). The sources file is the list of what Mason copies
([Choosing what to sync](#choosing-what-to-sync)).

**2. Connect a tool.**

```bash
mason user add metabase              # prints postgres://metabase:<password>@127.0.0.1:5433/your-app, once
```

Paste the URL into the tool's Postgres connection form. Each copied table is a table of the database named after your
project, and the port stays the same at every start, so a saved connection keeps working.
[`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) says how a tool connects and what SQL is answered.

**3. Keep an eye on it.**

```bash
mason status                         # your database, each table's copy, the Postgres API, slow and refused statements
mason ui                             # the same, and the users, in your browser
mason logs --requests --failed       # every statement refused or failed, with why
mason stop                           # the copy stays; the next mason start resumes in seconds
mason destroy                        # removes the copy and Mason's state, never your files or users
```

`mason --help` lists every command in the order you will need them, and `mason help <command>` explains one, with
examples; [`cli/README.md`](cli/README.md) has every command and option.

### Going to production

The project folder is all you deploy: `mason/`, with the sources file and `mason.yml` (the Mason version it is written
for). In production Mason runs as one container, `mason serve`, configured by environment variables, its copy on one
volume, with `/healthz` for the platform. `mason help production` has this section offline.

```bash
cd deploy/mason-data && mkdir -p mason   # from a checkout, or copy compose.yml and .env.example into a folder of yours
cp .env.example .env                 # DATABASE_URL, MASON_API_KEY (openssl rand -hex 24)
docker compose up -d                 # ghcr.io/embeddable-hq/mason-data
docker compose exec mason mason add public.orders
docker compose exec mason mason user add metabase
```

| | |
|---|---|
| Image | `ghcr.io/embeddable-hq/mason-data`, amd64 and arm64: `main` is every merge, `<version>` a release. [`deploy/mason-data/README.md`](deploy/mason-data/README.md) is the walkthrough |
| Replicas | run it as a single container per volume (DuckDB lets one process write its file), deployed stop-then-start (Kubernetes: `strategy: Recreate`). The copy is on the volume, so a restarted container is healthy again within seconds, with nothing copied again |
| TLS | required off the container's loopback: `MASON_PG_SELF_SIGNED_TLS=1` makes a certificate on the volume (clients connect with `sslmode=require`), or mount a certificate from your CA |
| Changes | polling needs a user that can `SELECT` the tables; `MASON_CHANGES=replication` reads the change log instead ([Logical replication](#logical-replication)) |
| Settings | [`deploy/mason-data/README.md`](deploy/mason-data/README.md#settings) lists the ones to set and the ones worth deciding; `mason serve --help` has every one |
| Upgrades | Mason is pre-1.0, so a release may still rename a command, a key or a setting. `mason.yml` pins the version your project is written for, the image refuses a project written for another release line, and the [release notes](release-notes/README.md) say what to do before each upgrade |

<details>
<summary><b>Sizing: memory and CPU</b></summary>

- **Memory**: the copy may use half the container's memory limit by default (else half the machine's RAM); the other
  half is the page cache, the catalog (~820 MB) and Node. Give the container enough that the page cache holds the
  columns your dashboards read: a query over a column it does not hold runs at the disk's speed. The benchmark's copy
  was about a fifth of its tables in Postgres (10.1 GiB → 1.8 GiB, on a 15 GiB machine); `mason status` says yours. To
  set it, `MASON_DUCKDB_MEMORY=4GB` with the container's limit about twice that. A query that needs more fails on its
  own (53200) and Mason keeps running; set it close to the container's limit and the container is killed for running
  out of memory.
- **CPU**: memory first, then cores. The benchmark's machine (4 vCPU Graviton3, 15 GiB) answered 32 clients at 10 M
  rows, 12 statements a second at a p95 of 3.5 s, the same throughput as at 8 clients: the extra clients queued. A
  copy's readers take about a core each while it runs (`MASON_COPY_PARALLEL`, default 3).

</details>

## Syncing from Postgres

Name the tables and columns you want; Mason copies them and keeps them current, and BI tools (Metabase, Grafana,
Superset, Power BI, psql), AI agents and your own code connect as they would to any read replica. Mason only reads
your Postgres: it writes nothing there. It keeps a copy current in one of two ways:

| | Polling (the default) | Logical replication |
|---|---|---|
| reads | `SELECT`s, every 5 s | the database's change log, as a replica does |
| needs on your Postgres | a user that can `SELECT` the tables | `wal_level = logical`, a user with `REPLICATION`, a publication |
| makes on your Postgres | nothing | a replication slot (and a publication, when you name none) |
| a read replica as the source | yes | Postgres 16+, with a publication you name |
| tables kept current | up to 1,000,000 rows each (a bigger one: replication, or `mason sync <table>`) | every table with a primary key, whatever its size |
| turned on by | `mason start` (or `--poll` to go back) | `mason start --replication`; `MASON_CHANGES=replication` on a server |

**Start with polling**: it needs nothing on your database. **Switch to logical replication** when a table passes a
million rows or you want changes within seconds; the switch keeps every copy.

### Choosing what to sync

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

- `mason add` writes the entries for you, and leaves out a column that looks like a secret (`password`, `token`,
  `api_key`, …) unless you name it, as `exclude:`. A `{}` you write by hand copies every column.
- Column types are read from your database at every start, never written in the file.
- With Mason running, `mason add` and `mason remove` apply at once and keep the rest of the file, comments included. A
  hand edit applies at the next `mason start`, and a mistake is reported with the key and how to fix it.

### The first copy

- Each table is read a range of heap pages at a time, `MASON_COPY_PARALLEL` chunks at once (default 3), each on one
  connection to your database, so a copy never asks more of it than that.
- The smallest table goes first, and each is served the moment its copy lands; `mason wait` shows the progress.
- A copy that stops (a crash, `mason stop`) resumes from the ranges it had not committed.
- A copy runs beside the polls and the stream, so adding a big table never stops the others keeping up.

### Polling

The default, with nothing to set up on your Postgres.

- **How it works**: every 5 s (`MASON_POLL_MS`), each table is read in one transaction over one snapshot. The rows
  changed since the last poll (by `xmin`, Postgres's row version) are written by key; deleted rows are found by
  comparing counts, and keys only when the counts differ. Rows and position commit together, so a poll that dies is
  simply read again.
- **What it costs your database**: Postgres has no index on `xmin`, so a poll reads the whole table. Mason keeps that
  bounded: it waits at least four times as long as the last poll took, so polls use at most a fifth of your database's
  time, and it polls only tables up to a million rows.
- **Bigger tables** are still copied and queryable, and logical replication keeps them current. Under polling one
  stays as of its copy until `mason sync <table>` brings it up to date, and `mason status` says so.

### Logical replication

For big tables, and for changes that land within seconds.

- **How it works**: `mason start --replication` (on a server, `MASON_CHANGES=replication`) reads the change log
  through a replication slot of its own, as a Postgres replica does. A switch keeps the copies and catches each table
  up by one poll, never a fresh copy; `--poll` switches back.
- **What it needs**: `wal_level = logical`, a user with `REPLICATION`, and either a publication you name
  (`--publication`, or `PG_PUBLICATION`), which Mason verifies but never creates, alters or drops, or the right to
  create one. A read replica as the source needs Postgres 16+ and a publication you name.
- **What it refuses**: a table with no primary key (a `key:` entry), since the change log gives no key to match its
  changes to rows (keep such a project on polling), and one with `REPLICA IDENTITY NOTHING`, since publishing it would
  make your app's UPDATEs and DELETEs fail.
- **One setting to make on your database**: `max_slot_wal_keep_size` (Postgres 13+). A replication slot keeps WAL
  until its reader has it, Mason's too, even while Mason is stopped; the setting caps how much it may keep. `mason stop`
  keeps the slot, so the next start resumes from it; `mason destroy` and `--poll` drop it, and check it is gone.

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

Mason is for scans and aggregates; a lookup through an index is faster on Postgres ([docs/DESIGN.md](docs/DESIGN.md) "Heap order, no index"). Each p95 is of a dashboard's mix of 6 statements, measured on m7g.xlarge, 4 vCPU, 15 GiB RAM, EBS gp3, against PostgreSQL 18.6, Docker (postgres:18) on the same machine; [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) has every measurement and how it was taken.
<!-- END GENERATED -->

### What Mason is for, and what stays on Postgres

Use Mason for the scans and aggregates that slow down as data grows, and that on a replica compete with each other and
with everything else: dashboards, reports, BI tools, AI agents, customer-facing analytics. Keep your application's own
queries (a row by its primary key, an insert, an update) on Postgres: a point lookup is faster there, and Mason is
read-only.

### How it is fast

- **A columnar copy.** DuckDB stores each column apart, compressed, and a query reads only the columns it names, a
  batch of values at a time over every core, where Postgres reads each row whole. The benchmark's tables took about a
  fifth of their size in Postgres (10.1 GiB → 1.8 GiB), so more of what a dashboard reads stays in memory.
- **No index, in the source's order.** A copy keeps its rows in the order Postgres's scan delivers them (about the
  order they were inserted in), with no index to keep in memory: a query over a window of a column that grows as rows
  are inserted (`created_at`) skips most of the row groups outside it. It is also why a lookup by primary key is slower:
  Mason scans for it, where Postgres uses its index.
- **Off your database.** A dashboard's scans run on Mason's machine, not your database's CPU, memory and disk; your
  database's only work is the first copy, read a few chunks at a time, then the polls or the change log.

[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) is every measurement and how it was taken;
[docs/BENCHMARK.md](docs/BENCHMARK.md) runs the benchmark on your own machine.

## Postgres compatibility

Mason's goal is to answer every statement it accepts exactly as Postgres would: the same column names, type OIDs,
text, order and SQLSTATE. You keep the SQL you already run. When Mason can't answer a statement exactly, it refuses it
with an error that says what isn't supported and what to write instead. The few cases it answers differently are
listed, each with its reason. Nothing differs silently.

### Postgres decides, DuckDB computes

1. **Postgres analyses the statement.** A real Postgres in the same process (PGlite) holds the copied tables'
   definitions and no rows: it parses the statement, types every expression and names the result's columns. The
   catalog a tool reads (`pg_catalog`, `information_schema`) is that Postgres too.
2. **Mason rewrites it** wherever DuckDB's meaning differs: collation and case, `LIKE` and regex, JSON, `to_char`, date
   arithmetic, casts to text.
3. **An allowlist checks it**, piece by piece: anything not yet verified is refused with an error naming it.
4. **DuckDB runs it** on the copy, and the answer comes back with the column names, type OIDs and text
   Postgres would send. Exact `numeric` arithmetic stays exact, never rounded through a double.

### The oracle

The allowlist is not written by hand. An oracle runs tens of thousands of statements on a real Postgres and on Mason,
compares each answer with Postgres's, and allows only what came back identical or differs by a listed decision. Every
fix adds its statements to the oracle, and a difference you report becomes a permanent test case:

<!-- GENERATED by tests/duck-gaps.test.ts from src/duck/gaps.ts and src/duck/verified.ts, to the END line: never edit by hand; UPDATE_FIXTURE=1 npm test rewrites it -->
Of the 2,998 statements the oracle also sends to a plain DuckDB connection, Mason answers 95% exactly as Postgres
does, 1% differently by a decision it lists, and refuses 4% with an error saying what to write instead;
none was answered with a wrong value. DuckDB alone, over the same tables, answers 31% of them exactly. [docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md),
rendered from the code, names the 992 pieces verified (types, functions, operators, aggregates, window functions,
casts, constructs and their forms), the 46 shapes refused, the 14 answered differently and the 7 limits, each
with what to write instead.
<!-- END GENERATED -->

The statements BI tools send (psql, pgjdbc, node-postgres, Metabase, Grafana, DBeaver and Superset) were recorded
from the tools themselves, and the tests replay every one. [docs/DESIGN.md](docs/DESIGN.md) "The statement path"
explains it in full.

## For AI agents

An agent connects as any Postgres client does, or over MCP, and gets a dashboard's speed on the tables you chose. A
statement Mason cannot answer exactly comes back refused with what to write instead, which an agent can act on.

### Access control

Give each agent and each tool a user of its own, and a role that says what it may read. Roles narrow what the sources
file copies, by table, column and row:

```yaml
# mason/roles.yml — committed beside the sources file, and reviewed the same way
roles:
  agent:
    tables:
      orders: { columns: [id, status, amount, created_at] }
      customers: { exclude: [email, phone] }   # the sources file's shape
  tenant:
    attributes: [tenant]
    tables:
      orders: { where: "tenant_id = :tenant" }
      order_items: { through: orders }         # filtered by its foreign key to orders
```

```bash
mason user add claude --role agent   # its password, printed once, in the URL to connect with
mason user add acme --role tenant --set tenant=42
mason user list                      # the users, their roles, and when each was added
mason user remove claude             # refuses its next connection and ends its sessions at their next statement
```

- A statement that reads a table or column outside the user's role is refused with `42501`, naming it: the error
  Postgres sends; a `SELECT *` over a table the role sees only part of is refused too, never silently narrowed.
- A role's catalog reads and the MCP tools list only what it can read, so an agent never finds a table it may not query.
- A user with no role reads every table and column the sources file copies. Every user is read-only, and exists in Mason
  alone, never in your database; `mason user remove` takes effect without a restart.
- Off this machine the Postgres API requires TLS, unless `MASON_PG_PLAIN=1` puts it behind a TLS proxy of your
  own ([Going to production](#going-to-production)).

### The MCP server

`mason mcp` is an MCP server on stdio for Claude Code, Claude Desktop and other agents, connected as a `mason user`
(and so held to its role). Its tools list the tables and how current each is, describe one (its columns, Postgres types
and keys), run a query and EXPLAIN it; a refused query comes back as Postgres's error, with a hint saying what to
write instead. In Claude Code, in the project's folder with Mason running:

```bash
mason user add claude --role agent   # the URL, printed once
claude mcp add mason --env MASON_URL="postgres://claude:<password>@127.0.0.1:5433/shop" -- mason mcp
```

It talks to Mason only over the Postgres protocol, so it works against `mason start` on your machine as against `mason serve` elsewhere.
[`cli/README.md`](cli/README.md#from-an-mcp-client-mason-mcp) has every tool and the setup for Claude Desktop.

### Observability

| | |
|---|---|
| `mason logs --requests` | every statement, answered or refused: when, the outcome and SQLSTATE, how long, the rows sent, the tool's `application_name` (an MCP client's is `mason-mcp/<client>`), the user and its role, and for a refusal the grant or filter that refused it. `--failed` for the refused and failed only, `--json` for every column; kept 7 days (`MASON_REQUEST_LOG_DAYS`) |
| `mason status` | each table's copy and how current it is, and the last day's slow and refused statements, each with its reason |
| `mason ui` | the status, the slow and refused counts and the users, in your browser |
| `EXPLAIN` | for each copy a statement reads, its rows and how current it is, beside the SQL it runs |

### A CLI an agent can drive

The commands are the same for you and for a coding agent (Claude Code, Codex, …). Each prints for a person or, with
`--json`, one object of a declared shape; its exit code says how it went, and it names what to run next.
`mason help agent` is the page an agent reads first.

## Documentation

| | |
|---|---|
| [`cli/README.md`](cli/README.md) | every command and option of the `mason` command |
| [`docs/POSTGRES-API.md`](docs/POSTGRES-API.md) | the Postgres API: connecting a tool, what SQL is answered, what is refused and why |
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
