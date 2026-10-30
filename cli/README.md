# @mason-data/cli

The `mason` command points [Mason](https://masondata.ai) at the Postgres your app already uses, copies the tables you
add, keeps the copy current, and serves it to BI tools and your app over the Postgres protocol. Every command works the
same for you and for a coding agent (Claude Code, Codex, …): it prints for a person, or with `--json` as data, and its
exit code says how it went ([for coding agents](#for-coding-agents)).

There is nothing to clone or build: install this package and run `mason`. It needs Node 22.13 or later and nothing
else — no Docker, no database of its own, and nothing downloaded after `npm install`: the copy's postgres and inet
extensions come with it, as an optional dependency for your platform (`@mason-data/extensions-<platform>`, 17–31 MiB
to download; installing with `--omit=optional` leaves them out, and the first copy then downloads them).
`mason doctor` checks this machine and says what is missing. On a terminal
its output is coloured and wrapped to the window, and a command that takes a moment shows a spinner; piped,
redirected, with `--json` or with `NO_COLOR` set, it is plain text.

**A Mason project is your app's folder.** `mason init` makes it one: its sources file in `mason/sources/` — the
database and the tables to copy — yours to commit; this machine's copy of your data and Mason's state in `.mason/`,
both rebuilt from that file. Every other command works
anywhere in the folder, as git does. `mason destroy` removes the copy and the state. ([Cleaning up](#cleaning-up))

```sh
npm i -g @mason-data/cli
cd my-app
mason doctor                         # Node, memory, ports: what is missing, and what to do
mason init                           # this folder becomes a project, on the database .env names (checked first)
mason tables                         # the tables: rows, keys, added; a table's columns with `mason tables orders`
mason add orders customers           # add them to the sources file (--columns id,status: those only)
mason start                          # Mason in the background, copying them, then returns
mason wait                           # until every added table is copied and served
mason user add metabase              # a user for a BI tool: its password, printed once, and the URL to paste
mason ui                             # the status, tables, users and statements, in your browser
```

`mason init` takes the database's URL as an argument too (`mason init postgres://user:password@localhost:5432/your_app`);
without one it reads `MASON_DATABASE_URL`, else `DATABASE_URL`, each from the folder's `.env.local`, `.env` or the
shell — set `MASON_DATABASE_URL` to aim Mason at a database other than the one your app's `DATABASE_URL` names. The
sources file it writes names the variable it read, `url: ${DATABASE_URL}` or `url: ${MASON_DATABASE_URL}` (given a URL
as an argument, `MASON_DATABASE_URL` when your app's `DATABASE_URL` names another database), and the URL itself stays
in `.env` (init writes the line there when you gave the URL as an argument or it was only in the shell, and gitignores
that file): change it there when the password changes. The database is required.

**No database at hand?** `mason init demo && mason start`, in a new folder, makes a project on a demo database Mason
hosts itself — a small shop (`customers`, `products`, `orders`, `order_items`; the first three added, `order_items`
left for your first `mason add order_items` after `mason start`), kept in `.mason/demo/`, served on a port of this machine, with a new order every few seconds (`MASON_DEMO_CHANGE_MS`, default 5000) so
`mason status` shows the copy keeping up. Nothing to install. It is read by polling only (it has no change log), and
`mason destroy` removes it with the copy.

## The project: its sources file, in your app

```
my-app/
  .env                    the database's URL (DATABASE_URL, as your app has it, or MASON_DATABASE_URL) (gitignored)
  .mason/                 this machine's: Mason's key, the copy of your data, its state and logs (gitignored)
  mason/sources/app.yml   the database and the tables Mason copies — commit it
  mason/mason.yml         the Mason version the project is written for — commit it: production runs that version
```

The sources file is named for the database (`app.yml` above) and lists what Mason copies, one entry per table:

```yaml
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

- An entry is `{}` (every column), `columns:` (those; the primary key is always copied), `exclude:` (every column but
  those) — never both — and, for a table with no primary key, `key:`: the columns that tell its rows apart, which it is
  copied by (polling only: logical replication cannot apply a change by them). A table with a primary key refuses `key:`.
- Column types are not in the file: Mason reads them from the database at every start.
- `url:` is `${NAME}`, read from `.env.local`, `.env` or the shell — or a literal URL, for a database on your machine.
- One source per project for now, and `postgres` is its only kind.
- `mason add` and `mason remove` edit one entry and keep every other byte of the file, your comments included, and
  apply at once; an entry you edit by hand is applied at the next `mason start`. A mistake — a column the table does
  not have, `columns` and `exclude` together, a variable that is not set — is refused, every one of the file's
  mistakes on one report, each with its key and the way out (`did you mean …?`).

`mason init --folder <dir>` puts `sources/` elsewhere in the folder (`--folder .` for the folder itself). Keep it in
your app's repo, so a schema change and the tables that copy it travel together. A teammate who clones the repo runs
`mason init` once: the sources file is kept, and `.mason/` is per machine.

**A project an older Mason made** (its tables listed in `mason/models/`) is refused by `mason start`; nothing is
migrated. `mason init` in it writes the sources file alone — its `.mason/` and copy kept — then `mason add` each table
again and remove `mason/models/`.

## Commands

| Command | What it does |
|---|---|
| `mason help [<command> \| <guide>]` | The commands by step, one command's usage, or one of the guides, offline: `mason help agent` (driving Mason from a coding agent: the commands in order, `--json` and its shapes, exit codes, failures) and `mason help production` (the road from a laptop to production: the image, its settings, Docker Compose, logical replication, upgrades). |
| `mason doctor` | Checks what Mason needs here — Node 22.13+, memory, Mason's ports — and in a project's folder its database; with Mason running for it, the run itself: whether every added table is copied, the statements refused or slow in the last day. Every failing line says what to do; it ends with the next command. |
| `mason init [<postgres url>]` | Makes this folder a project: checks it can read the database (nothing is written when it cannot; `--skip-check` writes anyway), writes `.mason/config.json` (Mason's key, never the URL) and `mason/sources/<database>.yml` (keeping a sources file already there), adds the URL to `.env` when it was not there, and adds `.mason/` and that `.env` to `.gitignore`. The URL from the argument, else `MASON_DATABASE_URL`, else `DATABASE_URL`, each in `.env.local`, `.env` or the shell (the sources file names the one read). `--name` sets the project's name (default: the folder's) — the database name a tool connects to — `--folder` where its files go, `--remote` allows a database on another machine. Refuses a folder already in a project, but for one with no sources file (an older Mason's), whose sources file alone it writes. |
| `mason start` | Starts Mason for this folder's project in the background and returns once it is up. Run it again any time: it says so when Mason is already running. Each table is kept current as its `sync:` in the sources file says (`off`, `poll <interval>` or `replication`). `--self-signed-tls` serves the Postgres API over TLS; `--attach` stays in the foreground. |
| `mason tables [<table>…] [--all]` | The tables this user can read against the sources file, one line each: rows, primary key, whether added (and with which columns), and why a table cannot be added yet (no primary key: the `--key` to add it by). Name a table (or pass `--all` for every one) for its columns: each one's type, what it references, and whether `mason add` would leave it out as a secret. It reads the project's database itself, so Mason need not be running. |
| `mason add <table>… [--columns …] [--include …] [--key …] [--sync …]` | Copies tables into Mason, each one an entry of the sources file: every column (`orders: {}`), or `--columns id,status,created_at` for those (one table at a time; the key is written with them). Columns that look like secrets (`password`, `token`, `api_key`, `private_key`, …) are left out, named, and written as `exclude:`; `--include password_hash` adds one. `--key tenant_id,id` adds a table with no primary key, copied by those columns. `--sync "poll 30s"` (or `off`) writes how it is kept current after its first copy on its entry; on a table already added, `--sync` alone changes that line and nothing else. Without it the entry follows the file's `sync:`, but a table over 1,000,000 rows under a file that polls is written `sync: off` and said, and a frequent poll of tens of millions of rows is warned of with an estimate of its cost. Adding a table again with other columns changes its entry. Mason need not be running: the entry is checked against the database as the run checks it, and the copy begins at `mason start` (with Mason running, at once). |
| `mason remove <table>…` | Takes tables out of the sources file — each one's entry, every other byte as it was — and Mason drops their copies: at once when it is running, else at the next `mason start`. Mason need not be running. |
| `mason wait [--timeout <s>]` | Waits until every added table is copied and served, showing every added table on a line of its own: 100% for the finished ones, in the order they finished, and a bar for each still copying (rows, %, rate, time left) at the bottom. Exit 0 ready, 1 a copy failed (printed, with what to do), 124 timed out (default 600 s). |
| `mason user add\|list\|remove <name>` | The users of the Postgres API: a name and a password that does not expire, as a BI tool's datasource form asks for them or an app's `DATABASE_URL` carries them. `add` prints the password once with the URL; `remove` refuses the next connection at once and ends the sessions it holds at their next statement, without a restart. |
| `mason mcp [--url <url>]` | An MCP server on stdio for Claude Code, Claude Desktop and other agents (below): the tables Mason serves with each copy's rows and how current it is, a table's columns, a statement's rows with their Postgres types or Mason's refusal with its way out, and EXPLAIN — connected as a `mason user` (`MASON_URL`, else `--url`), beside `mason start` or a `mason serve` elsewhere. |
| `mason ui` | Opens the running Mason's web page in your browser: the Overview (what `mason status` says), the Tables (add, remove or sync one), the Users of `mason user` (add one, its password shown once; disable, enable or remove one) and Observability (the statements, usage over time, the sync's events), refreshed while the tab is open. It prints the URL with the run's token, which the page trades for a cookie on the first visit; `--no-open` prints it only, `--json` is `{ url, port }`. `mason start`'s alone: `mason serve` serves no page. |
| `mason status` | What Mason is doing: the database and how its changes are read, the project folder, the copy's file, the Postgres API and how it listens, each table's copy, the statements of the last day and week (each outcome, the completed ones' average, p50 and p95 time, the rows and bytes sent), the ones answered slowly in the last day and the ones refused or failed, each with its reason. In replication mode, where the stream is. |
| `mason sync <table>…` | Makes the copy of these tables current now, by one poll each: a table whose `sync:` is `off` is kept current only so (from cron, before a report), a polled one is polled now as well as at its interval. In replication mode the stream keeps every table current, and it says where the stream is. |
| `mason logs [-n <lines>] [-f] [--start] [--requests [<filters>]] [--events [--failed]] [--running]` | Mason's log: every copy, poll and statement, with warnings and errors and their reasons; `-f` follows it, `--start` shows what `mason start` printed instead. `--requests` is the request log: every statement a tool sent, when, the outcome (ok, refused, failed, cancelled) and SQLSTATE, how long, the rows and bytes sent, the tool and the user; `--failed` only the ones not answered, `--outcome`, `--since` / `--until` (`2h`, `7d`, an ISO time), `--user` and `--client` narrow it, and `--before` reads the page before. `--events` is the sync's events: each copy, poll, catch-up or stream that failed, the database out of reach, a table current again, each sync asked by hand (mason sync, the page's Sync now), and each restart of the run (`--failed` only the failures). `--running` lists the statements running now, by session. |
| `mason cancel <session>` | Stops the statement a session of the Postgres API is running, as the client's own cancel would: the client is told 57014, its session goes on, and the request log keeps it as cancelled. `mason logs --running` lists the sessions. |
| `mason usage [--since 7d] [--step 1h]` | What Mason did over time, from a sample a minute kept `MASON_HISTORY_DAYS` days: the statements and their p95, the rows and bytes sent, the copy's size and rows, the stalest copy, the stream's lag, the memory; then each copy's own size. |
| `mason stop` | Stops Mason for this project. The copy and the state stay: the next `mason start` resumes in seconds. |
| `mason destroy` | Removes this project's copy of the data (its file) and Mason's state in `.mason/`, stopping Mason first if it runs — and, when a table was replicated, its slot (and its publication, when Mason made it) on the database. Your files, `.mason/config.json` and the users stay: the next `mason start` copies the tables again. |
| `mason serve` | Mason for a server or a container: `mason start --attach` configured by the environment alone, its state in one folder (a volume), its log on stdout, `GET /healthz`, `GET /metrics` (Prometheus, numbers only), a clean stop on SIGTERM. `mason serve --help` lists every setting with its default. |

Every command documents itself: `mason --help` lists them, and `mason <command> --help` (or `mason help <command>`) says
how to use one, with examples. Every command but `help` and `mcp` (whose stdout is the MCP protocol's) takes `--json`. A command means the project of the folder it
runs in, or the nearest one above it.

## What `mason start` does

1. **It only reads the database** — the one the sources file names, with `SELECT` statements. It does not need
   `wal_level = logical`, a replication slot, a publication or the `REPLICATION` attribute, and it creates none of
   them. When you stop it, nothing is left behind on the database. After its first copy each table is kept current as
   the sources file's `sync:` says — at the top for every table, on an entry for that one: `off` (the default, and what
   `mason init` writes) reads it again only at `mason sync <table>`; `poll 30s` polls it every 30 seconds, each poll a
   scan of the table, the next one at least four times the last one's time later. Changing a table's `sync:` keeps its
   copy and catches it up by one poll. `mason status` says each table's sync and when it was last synced, on its line.
   (`sync: replication` is the exception: that table is read from the change log, as production does, through one slot
   Mason makes and a publication carrying the replicated tables alone — its own, or the one `publication:` at the top
   of the file names, never altered. The slot is dropped, verified gone, once no table is replicated.)
2. **It copies each added table** into a DuckDB file in `.mason/`, a range of pages at a time, a few in parallel, one
   Postgres backend each, smallest table first; a copy that stops continues with the ranges it did not commit. The table
   is served the moment its copy lands; the copy runs beside the polls, never instead of them.
3. **It serves the Postgres API** on 5433, or on the next port free on every address when something holds 5433 (often a
   second Postgres; `mason start` says what held it) — and records it: every later start listens on the same port, so a
   tool's saved connection keeps working, and refuses, naming what holds it, rather than move. `MASON_PG_PORT=55433` in
   your shell names the port, or moves the project to it (said). It listens on 127.0.0.1 unless `MASON_PG_HOST` names
   another address; off this machine it needs TLS (`--self-signed-tls`, or `MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY`).
4. **It runs in the background**, copying what the sources file names: `mason add` and `mason remove` change it at once,
   a hand edit (or an add or remove made while Mason was stopped) at the next `mason start`.

Mason's own settings (`MASON_DUCKDB_MEMORY`, `MASON_COPY_PARALLEL`, …) set in your shell reach Mason. How often a
table is polled is its `sync:`, never a setting: `MASON_POLL_MS` set refuses the start, naming the line to write.
A copy reads `MASON_COPY_PARALLEL` chunks at once (default 3), each sized to take about `MASON_COPY_CHUNK_SECONDS` to
read (default 12) at the rate it measures on your connection, so `mason wait` moves every few seconds even over a slow
link, and a copy that stops reads at most those chunks again.
A JSON value your queries keep reading (`payload ->> 'customer_id'`) is stored as a column of the copy and read from
there (`mason status` lists them); `MASON_STORE_JSON_PATHS=off` turns that off.

## `mason start` options

| Option | What it does |
|---|---|
| `--self-signed-tls` | The Postgres API requires TLS, from a certificate made for this project in `.mason/` (served again by every later start with the flag); clients connect with `sslmode=require`. |
| `--port <n>` | The port the `mason` commands reach it on (default 4039, or the next free one). |
| `--attach` | Stay in the foreground: the terminal shows Mason's progress, and Ctrl-C stops it. |

`--replication`, `--poll` and `--publication` are gone: each answers with the line to write at the top of the sources
file (`sync: replication`, `sync: poll 5m`, `publication: <name>`) and exit 2, and starts nothing.

A database on another machine needs `mason init --remote`, which records that you mean it: the copy leaves the
database's network, and each polled table is read whole at its `sync:` interval (`sync: replication` reads only its
changes). Point it at a read replica, never the primary your app writes to.

**When the database moves.** Mason records the Postgres server it copied from. The same database on a new server (a
restore, a move to another host) is read again at the next `mason start`: every row is compared with the copy, and only
what changed is written. A different database is refused: `mason destroy`, then `mason start`, copies it.

## For coding agents

`mason help agent` is the page an agent reads first, offline: the commands in the order a project takes them, every
answer's shape, the exit codes and the failure codes. In short:

- Every command but `help` and `mcp` takes `--json` and answers with **one JSON object on stdout**, always with
  `next: [{ command, what }]` — the commands to run next, the same a person reads under `Next:`. The other keys are the
  command's own; `mason help <command>` names them on its `--json` line. Lists are wrapped (`{ tables: […], next }`).
- A failure is `{ "error": { "code", "message", "why", "fix" }, "next": […] }` on stdout, and the **exit code** says it:
  0 done, 1 failed with the reason, 2 the command line is wrong, 124 `mason wait` ran out of time. The codes are a closed
  set (`usage`, `no_project`, `bad_config`, `bad_source`, `not_running`, `unreachable`, `not_found`, `nothing_yet`,
  `refused`, `failed`, `timeout`). For a person the same failure is three short lines — what is wrong, `why`, `fix` — then `Next:`.
- Progress (a spinner, `mason wait`'s bars) goes to stderr, and only on a terminal; a pipe gets plain text, and nothing
  under `--json`. The Postgres API's URL is in `mason status --json` (`postgres.url`); a user's password is printed by
  `mason user add` once: never read `.mason/config.json`.

```sh
mason doctor --json && mason init --json && mason start --json
mason tables --json                      # choose the tables
mason add orders customers --json && mason wait --json
mason user add app --json                # the password and URL for the app, as data
```

### From an MCP client: `mason mcp`

A chat agent asks Mason with tools, over MCP, rather than through a shell. `mason mcp` is an MCP server on stdin and
stdout (newline-delimited JSON-RPC; stdout carries the protocol alone, what it says goes to stderr) that serves until
the client closes stdin; it takes no `--json`, and says a failure to start on stderr. It connects to the Postgres API as
a `mason user`, by the URL `mason user add` printed — `MASON_URL`, or `--url` — so it works beside `mason start` as against a `mason serve` elsewhere; TLS is as the URL's `sslmode`
says (a host off the machine: `require` when it names none). It never makes a user by itself: with no URL, it refuses
and says `mason user add claude`.

| Tool | Arguments | What it answers |
|---|---|---|
| `tables` | none | each table Mason serves, named as a statement writes it (`public.orders`, `public."Clients"`): `rows_about` (the copy's estimate), `kept` (how it is kept current, as `mason status` says it) and `kept_current_by` (`polling`, `logical replication`, `copying again`, or null when nothing keeps it current now) |
| `describe` | `table` (as `tables` names it, or a bare name in `public`) | its columns with their Postgres types and NOT NULL, its primary key, its foreign keys, comments, and the same rows and `kept` |
| `query` | `sql`, `max_rows` (200, at most 10,000), `timeout_ms` (30,000, at most 300,000) | `columns` (name, Postgres type), `rows` as Postgres's text, `truncated` when `max_rows` cut it; a refusal is a tool error with the SQLSTATE, message, DETAIL and HINT (the way out) |
| `explain` | `sql`, `analyze`, `timeout_ms` | Mason's EXPLAIN: each copy read with its rows and how current it is, the SQL it runs, the plan |

Its resources are `mason://help/agent` and `mason://help/mcp` (the two pages `mason help` prints). Every statement it
runs is in the request log under `application_name` `mason-mcp/<the client's name>` (`mason logs --requests`), a query
`max_rows` cut with the rows it sent; its catalog reads (the tables, a table's columns) are not, as no catalog read is.
A request the client cancels (`notifications/cancelled`) cancels its statement on the Postgres API.

Claude Code, in the project's folder with Mason running, the URL in the server's environment (the server's name
comes before `--env`, which takes every value after it):

```sh
mason user add claude                    # the URL, printed once
claude mcp add mason --env MASON_URL="postgres://claude:<password>@127.0.0.1:5433/shop" -- mason mcp
# or on its command line, where ps shows it to this machine's users and claude mcp add prints it
claude mcp add mason -- mason mcp --url "postgres://claude:<password>@127.0.0.1:5433/shop"
```

Claude Desktop, in `claude_desktop_config.json`. The app often starts a server without your shell's `PATH`, where
neither `mason` nor the `node` its first line asks for is found: name both by their absolute paths (`which node`,
`which mason`):

```json
{
  "mcpServers": {
    "mason": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mason", "mcp"],
      "env": { "MASON_URL": "postgres://claude:<password>@127.0.0.1:5433/shop" }
    }
  }
}
```

## Cleaning up

Three things exist once a project has run: your **files** (the sources file, in your app), the **copy of your data** (a
file in `.mason/`) and **Mason's state** (`.mason/`: its settings, logs and the request log). Each way of cleaning up
keeps a different set:

| You want | Run | Keeps |
|---|---|---|
| Pause | `mason stop` | the data, the state, your files: the next `mason start` resumes in seconds |
| Copy the data again, or free its disk | `mason destroy` | your files, `.mason/config.json` and the users: the next `mason start` copies everything again |

Restarting the machine is a `mason stop` that nobody ran: the next `mason start` resumes. In a demo project
(`mason init demo`) the demo database is state too: `mason destroy` removes it with the copy, and the next `mason start`
seeds it again.

## Requirements

`mason doctor` checks all of this and says what is missing.

- Node 22.13 or later. The SQL parser (`libpg-query`), the catalog (`PGlite`) and the engine (DuckDB) ship as
  WebAssembly or prebuilt binaries: no native build, no Python or compiler needed.
- Memory: the copy may use half the container's memory limit by default, else half the machine's RAM
  (`MASON_DUCKDB_MEMORY=4GB` sets it; `mason doctor` says it). Sizing a server:
  [deploy/mason-data/README.md#memory](https://github.com/embeddable-hq/mason-data/blob/main/deploy/mason-data/README.md#memory).
- Postgres 13 or later. Each table needs a primary key, or a `key:` in the sources file (polling only).

## Security

`mason start`'s command server listens on 127.0.0.1 only; each request must carry the run's token, read from the
project's `.mason/config.json`, which a browser cannot send — or, for its web page (`mason ui`), the cookie the run's token is traded for on the first visit (HttpOnly, SameSite=Strict, its Host and every change's Origin checked). The Postgres API takes a user's password (`mason user`): a
MAC over its name keyed by the project's API key, so rotating the key removes every user at once. Off loopback the Postgres API is TLS or refused.

What a project keeps on this machine (the database URL, the API key, the run's token, the copy, its log and request
log) is in its `.mason/`, readable by your user only and gitignored by `mason init`.

## In production

Only the project folder travels — `mason/`, with `mason.yml` naming the Mason version it is written for. Production runs
it as one container, `ghcr.io/embeddable-hq/mason-data`, with `mason serve`: the same run, configured by the environment,
its copy on one volume, each table read from Postgres's change log or polled as its `sync:` says. `mason help
production` is the road, offline; `deploy/mason-data/` in the repo is the Compose file and its walkthrough.

Apache-2.0.
