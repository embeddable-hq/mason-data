# The Postgres API

Mason answers the Postgres wire protocol, so any tool that speaks to Postgres — `psql`, a JDBC or ODBC driver,
Metabase, Grafana, DBeaver, Superset — connects to Mason as it would to a read replica and sees **the tables `mason
add` copied**, in their own schemas, with the source's column types, keys and comments. A statement over them is
analysed by Postgres (an embedded one, holding the tables' definitions and no rows) and computed by DuckDB over the
copy, and its answer is written as Postgres's columns: the same names, types, values, text and order a real Postgres
gives ([docs/DESIGN.md](DESIGN.md) "How a statement is answered: Postgres decides, DuckDB
computes").

**It is a read-only copy, not a Postgres.** A statement is answered only when everything it is made of — each
function, operator, aggregate, cast, type and construct Postgres resolved it to — is on the verified list of
[docs/SQL-SUPPORT.md](SQL-SUPPORT.md): pieces a statement of the oracle used and Mason answered exactly as Postgres
did. Anything else is refused by name, with the statement position, a SQLSTATE and the way out — never answered
differently on a guess.

## Connecting

```bash
mason user add metabase                             # the URL, the user and its password: paste them into the tool now
mason user list                                     # metabase   id 81fcb84caead79b7 · added 2026-10-26 12:00 UTC
mason user disable metabase                         # kept: its logins refused (28000) until mason user enable metabase
mason user enable metabase                          # it connects again, with the same password
mason user remove metabase                          # its next connection is refused; its sessions end at their next statement
docker compose exec mason mason user add grafana    # beside mason serve, in its data folder
```

**A user is how a tool connects** (`mason start` and `mason serve`): a BI tool's datasource stores ONE
password. `mason user add <name>` makes a named user whose password does not expire and prints it ONCE, with the URL
to connect with; `mason user list` says the users (name, id, when added); `mason user disable <name>` stops one connecting and
`mason user enable <name>` lets it again; `mason user remove <name>` removes one.

- **The user name must be the user's**: the password is `mason_<id>_<mac>`, the MAC over the user's name and id keyed
  by the project's API key, so a connection sending another name is refused as a wrong password is (28P01), the reason
  in the message (`this password is the user "metabase"'s: connect with the user name metabase`). Every statement of a user's
  session is that user's row of the request log (`user_name` in `_mason.requests`, `(user metabase)` in `mason logs
  --requests`), and so is a refused login, under the name it sent.
- **The list of users is `.mason/users.json`** (`MASON_DATA/.mason/` under `mason serve`): names, ids, when each was
  added and which API key — never a password. `mason user` runs beside the running Mason (which holds DuckDB's file),
  changes the file under a lock and renames a new one over it, and the listener reads it again at every connection and
  before every statement of a user's session. So a removal takes effect at once, without a restart: the next
  connection is refused (28P01, "was removed"), and a session the user holds ends, FATAL (28000), at its next
  statement, whatever it is. A file that cannot be read refuses every user's connection and statement (57P03, the
  reason said), never lets one in. `mason destroy` keeps it, as it keeps the API key.
- **A disabled user is kept, with its password** (`disabledAt` in the file): its login, the password right, is refused
  as Postgres refuses a role without LOGIN — `28000`, `role "metabase" is not permitted to log in`, DETAIL `the user
  "metabase" is disabled (mason user disable). Mason: user_disabled`, HINT `mason user enable metabase lets it connect
  again, with the same password` — and a session it holds ends, FATAL (28000, "was disabled"), at its next statement, as a removed
  user's does. A wrong password for it is a wrong password (28P01): the state is told only to the login's holder.
  `mason user enable` clears it: the same password connects again. Disabling one disabled already (or enabling one
  that is not) says so and changes nothing, exit 0.
- **Rotating the API key removes every user at once** (`apiKey` in `.mason/config.json`, `MASON_API_KEY` under
  `mason serve`): no password verifies under the new key, the refusal says the key was rotated, and `mason user list`
  marks each as not connecting. Remove and add each again for new passwords.
- **A name is one user**: adding an existing name is refused, with the way out (remove it, then add it: a new
  password; or add another name and remove the old one once the tool uses it). The password is never kept, so it
  cannot be printed again: a lost one is a remove and an add.

### Roles

**A role limits what a user reads to tables and columns**: `mason user add <name> --role <role>` names a role of the
project's roles file, `mason/roles.yml` beside the sources file, written in the sources file's own words:

```yaml
roles:
  agent:                         # the role's name
    tables:
      orders: {}                 # every column of a copied table
      customers:
        columns: [id, country]   # these columns only
      billing.invoices:
        exclude: [notes]         # every column but these
```

- **A role names copied tables only**: a table the sources file does not copy, a column the copy lacks, a role with
  no table, a column both listed and excluded — each refuses `mason start` (and `mason user add --role`) by its key,
  with the closest name and the way out, before anything opens. The file is read again whenever it changes, with no
  restart; one edited into a mistake while Mason runs refuses every statement of a user with a role (57P03, the
  mistake said) until it is repaired, never widens.
- **It is enforced on the analysed tree, never on the statement's text**: after the catalog Postgres has analysed a
  statement (views expanded, every name resolved) and before it is rewritten, every table it reads and every column
  of each — in a WHERE, a CTE, a subquery, a USING or NATURAL join, a window, an ORDER BY, a GROUP BY, a CASE, a
  lateral, a parameter, a prepared statement — is held to the role. A read past it is refused as Postgres refuses it:
  `42501`, `permission denied for table orders` (Postgres's own message, which never names the column), the DETAIL
  naming the role and the column (`the role agent may not read column notes of orders`), the HINT what the role may
  read. `SELECT *` or `t.*` on a partly granted table is refused naming the first hidden column, never narrowed to the
  granted ones; `count(*)` over a table of which the role reads any column is answered, as on Postgres; a system
  column (`xmin`) needs the whole table, as on Postgres; a statement that reads no copied table is untouched.
- **The role is read with the user before every statement** (the users file, `recheckMs: 0`): a role given, taken or
  changed under a held session applies to its next statement — an EXECUTE of a statement prepared before included —
  and a role the file no longer names refuses its users by name (42501, the way out: add it back, or remove and add
  the user) rather than letting them read everything. `mason start` and `mason user list` say which users carry a
  role the file lacks. A user with no role, and a token, read every copied table as before.
- **The catalog answers for the role**: one Postgres role per Mason role, with the same `GRANT SELECT` and
  `GRANT SELECT (columns)`, lives in the catalog Postgres, rebuilt when the file or the copied tables change, and a
  session with a role runs each catalog statement under `SET ROLE … RESET ROLE` in one request. So
  `information_schema.tables` and `.columns` list the role what it may read, `has_table_privilege` /
  `has_column_privilege` / `has_any_column_privilege` answer as Postgres's would for its grants (`current_user` is the
  role's name, as under Postgres's own `SET ROLE`), and `mason mcp`'s
  `tables` and `describe` (which ask them) list an agent only what its user may read. **`pg_catalog` itself is not
  filtered in this stage**: `pg_class` and `pg_attribute` still list every copied column to every role (as they do on
  Postgres, which filters neither), while a read of a hidden one is refused. **Every role may see every view** of the
  source: reading one is held to the tables it reads, so a view over a hidden column is refused when read — stricter
  than Postgres, where a view's owner's grants apply. No row filter yet (the gap `roles` in docs/SQL-SUPPORT.md).
- **A session is its user and becomes no one else**: `SET ROLE` and `SET SESSION AUTHORIZATION` to its own name,
  `NONE` or `RESET` are no-ops, any other name is Postgres's refusal (`42501 permission denied to set role "…"`);
  `session_user` is the session's user and `current_user` its role. **`set_config` never reaches the embedded
  Postgres**: `SELECT set_config('name', 'value', false)` on its own is the session's `SET` (so `set_config('role',
  'none', false)` is `SET ROLE NONE`'s no-op), and any other form is refused (below). Inside the embedded Postgres it
  is also revoked while roles exist: that is one superuser connection with `SET ROLE` on top, and inside one statement
  the call was a reset to the superuser (the hidden columns' NAMES, never rows, were listed by the rest of the
  statement).
- **Every refusal is a row of the request log with the user's role** (`role` in `_mason.requests`).

`mason start` listens on 5433 when it is free on every address (127.0.0.1, 0.0.0.0, `::` and `::1`: a port another
Postgres holds on any of them would send a container or a driver trying `::1` first to that server), else on the next
free port, and says which address held 5433. **The port is then the project's** (`pgPort` in `.mason/config.json`):
every later start listens on the same port, so a BI tool's saved connection keeps working across
restarts, and a start whose port is held refuses, naming what holds it, rather than move. `MASON_PG_PORT` in the shell
you run it from names the port, or moves the project to it (said): it is used, or `mason start` refuses before starting
anything, naming what holds it (`mason doctor` says the same).
`mason status` prints where the listener is (`Postgres API  postgres://<user>:<password>@…`); it reads the address
`mason start` told the run to listen on, so what it prints is where the API listens.

**From another machine** (a hosted BI tool reaching a `mason start` on a server): `mason start` reads where
and how its listener listens with the service's own reader (`pgListenerSettings`, src/api/postgres/listener.ts), so
the variables below mean the same to both. It listens on 127.0.0.1 unless `MASON_PG_HOST` names another address
(`0.0.0.0` is every address of the machine), and off loopback it needs TLS, else it refuses to start, before it
connects to anything, saying what is wrong, why and both ways out:

```bash
MASON_PG_HOST=0.0.0.0 MASON_PG_TLS_CERT=/etc/mason/pg.crt MASON_PG_TLS_KEY=/etc/mason/pg.key mason start   # your certificate
MASON_PG_HOST=0.0.0.0 mason start --self-signed-tls                                                        # one made for the project
```

`--self-signed-tls` makes an RSA key and a certificate for the project in `.mason/` (`postgres-tls.crt`,
`postgres-tls.key`, mode 0600), records them in `.mason/config.json` with the certificate's SHA-256 fingerprint, and
serves the same one at every later start with the flag (a new one only when it expired or its key is not its own,
said so); it is refused beside `MASON_PG_TLS_CERT` / `_KEY`. A self-signed certificate ENCRYPTS — every client
connects with `sslmode=require`, which checks no certificate — but proves nothing about whose server it is: for that,
a certificate a CA signed, through the two variables. The URL `mason status` and `mason user add` print
then ends `?sslmode=require`, and a client that does not ask for TLS is refused (28000). With the listener on every
address the URL says `localhost`, where a tool on the machine reaches it: put the machine's address or name in its
place; `mason status` says what the listener serves (its address, TLS or plain,
whose certificate and its fingerprint; `postgres.listener` under `--json`). node-postgres reads `sslmode=require` as
`verify-full`, which a self-signed certificate fails: give it `uselibpqcompat=true&sslmode=require`, or
`ssl: { rejectUnauthorized: false }`. **A TLS listener takes both ways a client starts TLS**: `sslmode=require` asks
with Postgres's SSLRequest first, and Postgres 17's `sslnegotiation=direct` (and anything else that opens with a TLS
ClientHello, such as a platform's generic TLS terminator re-encrypting to Mason) is TLS from the first byte, with ALPN
`postgresql` as Postgres answers it. **A team whose own proxy or load balancer terminates TLS** keeps the listener on
127.0.0.1 behind it, or sets `MASON_PG_PLAIN=1` with the address its network reaches; a plain listener closes a
connection that opens with a ClientHello and says why in its log (it has no certificate to answer one with).

**The parts of the URL**, for a driver's form:

```
postgres://<user>:<password>@<host>:5433/<project>
```

- **The password is a `mason user`'s** (above). The project's API key is refused as a password (28P01, saying so).
  `application_name` is logged with every request.
- **The database is the project's name.** A connection to any other database is refused (3D000) naming the right one.
- **The port is the project's** (above; `MASON_PG_PORT`), the address `MASON_PG_HOST` (default 127.0.0.1).
- **TLS or a declared private network.** With `MASON_PG_TLS_CERT` and `MASON_PG_TLS_KEY` (PEM files) both set,
  TLS is required: a client that does not ask for it is refused (asked by SSLRequest or by a direct TLS start,
  `sslnegotiation=direct`). Without them the listener is plain, and the password travels in clear — which crosses no
  network on loopback, and is a decision anywhere else: a plain listener on any other address REFUSES TO START unless
  `MASON_PG_PLAIN=1` says the port is published on a private network (the refusal names both ways out). A session
  says what it is: `SHOW ssl` and `current_setting('ssl')` answer `on` over TLS and `off` plain, and `ssl_library`,
  `ssl_min_protocol_version`, `ssl_max_protocol_version`, `ssl_ciphers`, `ssl_groups` and `ssl_prefer_server_ciphers`
  what the listener serves (Node's OpenSSL); the other `ssl_*` (file names) are the embedded Postgres's defaults.

What a tool is told on connect: `server_version` 18.6, `client_encoding` UTF8, `DateStyle` ISO, the session's
`TimeZone` (UTC until `SET TimeZone`), `integer_datetimes` on, `standard_conforming_strings` on.
`SELECT version()` answers `PostgreSQL 18.6 (Mason <version>) …`.

**A refused or failed statement is always a log line** (a BI tool met an error and the log had said only that its
session connected and closed), trace or not, one per statement:
`[postgres] session <session> refused: <SQLSTATE> <message>; detail: <detail>; hint: <hint> — <sql>`, the detail and
hint where the error has them and the statement on one line, as an answered statement's line carries it. A failure that
is Mason's or the machine's rather than the statement's (SQLSTATE classes `XX` internal, `53` resources, `57` a
timeout or a cancel, `58` system) says `failed:` in place of `refused:`. So `mason logs` (or the service's log) answers
"why did my query fail": search it for the session's number, which `connected` and `closed` lines carry too. A FATAL
that ends the session is said by its `closed` line. Every statement's ErrorResponse is sent from one place
(`Session.refuse`, server.ts), so none is refused without the line (tests/postgres-api/server.test.ts).

**Tracing a session**: with `MASON_PG_TRACE=1` the service logs every statement text a session receives — a simple
Query's whole text and each Parse's — as `[postgres] trace <session> "<application_name>" Query|Parse: "<sql>"`, and
every refusal as `[postgres] trace <session> refused[ at Parse|Bind|Describe|Execute]: <SQLSTATE> "<message>"`, beside
the refusal's own line above. It is a log line and nothing else:
nothing is stored, and the password is no statement. It is how the tool corpus was recorded ("How it is
tested"), and how to see what a tool you are connecting sends.

### From an MCP client

`mason mcp` (`mason help mcp`) is an MCP server on stdio for Claude Code, Claude Desktop and other agents, and a client
of this API like any tool: it connects as a `mason user` by the URL `mason user add` printed (`MASON_URL`, or `--url`),
honours the URL's `sslmode`, and sets `application_name` to `mason-mcp/<the MCP client's name>`, so the request log
names the agent. Its tools say over this wire what a bare SQL tool would leave a model to guess:

- `tables` and `describe` read the catalog (`pg_class`, `pg_attribute`, `pg_index`, `pg_constraint`, filtered by
  `has_table_privilege` / `has_any_column_privilege` and `has_column_privilege`, so a user with a role is shown what
  it may read, "Roles" above) and, for each
  copy's rows and how it is kept current, `EXPLAIN (FORMAT JSON)`'s `Mason.Copies` — one EXPLAIN a table, a few at
  once, so a remote `mason serve` answers as a local run does; a table is named as EXPLAIN names it, as a statement
  writes it (`public."Clients"`);
- `query` sends ONE statement through the extended protocol (a second is Postgres's 42601), its `max_rows` the
  Execute's row count (the server stops there and answers PortalSuspended: `truncated`), after `SET statement_timeout`
  to its `timeout_ms` (57014 past it); the column types are the catalog's `mason_wire_type(oid, typmod)` of the
  RowDescription's OID and modifier. The wire sends the SOURCE's OID for a type the source made (an enum, a citext),
  which the catalog holds under another OID, and both count from 16384: `mason_wire_type` names an OID as the wire
  sent it; `format_type` keeps the catalog's meaning for an OID the catalog has (pg_attribute's `atttypid`) and names
  any other as the wire's; `pg_catalog.format_type`, written out, is the catalog's own;
- a request the client cancels (`notifications/cancelled`) is a CancelRequest for its statement;
- a refusal reaches the model whole, as an MCP tool error: SQLSTATE, message, DETAIL (the gap's id) and HINT (its way
  out), the fields this listener's ErrorResponse carries;
- `explain` is this API's EXPLAIN, as text.

## What a tool sees

- **Each copied table**, in the schema it has in the source (`public.orders` stays `public.orders`), with the columns
  that are copied, in the source's order, each with its source type, its comment, and an enum's labels. A table appears
  once its first copy commits; until then a statement naming it is refused `42P01` with a hint saying where its copy
  is (being copied and how far, waiting its turn, or why its copy failed), and only a table nobody added is told
  `mason add <table>` copies it.
- **Its keys**: the primary key and unique indexes over plain columns, and a foreign key between two copied tables
  (`pg_constraint`, so a tool's "relationships" view and ER diagram draw them).
- **The source's views** over copied tables, answered by their definitions as Postgres's rewriter answers them; a view
  over a table not copied is left out, said once in the log.
- **The catalog is a Postgres**: `pg_catalog` and `information_schema` are answered by the embedded Postgres (PGlite:
  Postgres 18.6 compiled to WebAssembly) that holds exactly these tables, so whatever a tool asks of the catalog —
  `psql`'s `\d`, pgjdbc's `getColumns`, Metabase's sync — is answered as Postgres answers it. It starts on the first
  catalog statement, runs on a thread of its own (a slow catalog statement never stalls the other sessions), and stops
  after ten minutes without one. One that takes longer than `MASON_PG_CATALOG_TIMEOUT_MS` (10 s) is refused naming the
  deadline, and the instance is replaced. A catalog statement's own `now()` (`SELECT now()`, reading no table) is that
  Postgres's clock as the statement runs.
- **`EXPLAIN`** is the statement it explains, in Postgres's shape (one `QUERY PLAN` column, or `FORMAT JSON`), with
  DuckDB's plan inside: which copy answered, what was sent to DuckDB and what Mason computed after it
  (docs/DESIGN.md "EXPLAIN").

## What is refused, by name

A refusal is an `ErrorResponse` with the SQLSTATE, the message a developer can act on and, where the statement has
one, the position of the construct. A statement Postgres itself refuses (a syntax error 42601, an unknown table 42P01
or column 42703, a type mismatch 42883) is refused with Postgres's own error: DuckDB never sees it.

| You wrote | Answer |
|---|---|
| a function, operator, aggregate, cast, type or construct not on the verified list | 0A000, `Mason gap unverified` in the detail, naming each piece (`degrees(double precision)`) |
| a construct Mason knows it cannot answer as Postgres does | 0A000, `Mason gap <id>` in the detail and what to write instead in the hint ([docs/SQL-SUPPORT.md](SQL-SUPPORT.md) "Refused") |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`, `TRUNCATE`, DDL, `GRANT`, `VACUUM`, `SET … READ WRITE` | 25006: a read-only copy |
| `PREPARE` / `EXECUTE` (the SQL forms) | 0A000: use the protocol's prepared statements (every driver does) |
| `SAVEPOINT`, `PREPARE TRANSACTION` | 0A000: BEGIN, COMMIT and ROLLBACK are accepted and do nothing |
| `LISTEN`, and any other statement that is not a SELECT, an EXPLAIN, a catalog query, SET, SHOW or a transaction no-op | 0A000, naming what is answered |
| an unknown `SET` | 42704, as Postgres |
| `SET TimeZone = 'CET'` (an abbreviation or a fixed offset) | 22023: an IANA zone name (`Europe/London`) or UTC |

What Mason answers differently from Postgres, without refusing it, is listed in [docs/SQL-SUPPORT.md](SQL-SUPPORT.md)
"Answered differently", each entry with what differs.

## Sessions, settings and transactions

`SET` and `SHOW` for what a driver sets on connect: `TimeZone` (an IANA zone or UTC), `application_name`,
`search_path`, `client_encoding` (`UTF8` only), `DateStyle` (`ISO` only: every date and time is written ISO 8601),
`extra_float_digits` (1 or more: every float is sent as the shortest text that reads back exactly),
`standard_conforming_strings` (on), `IntervalStyle`, the transaction isolation and `SESSION CHARACTERISTICS`
(accepted; `READ WRITE` refused 25006), the timeouts, the resource settings and `lc_*` (remembered; none changes an
answer). `statement_timeout` is honoured, and may only shorten the run's own limit for one statement
(`MASON_STATEMENT_TIMEOUT`, default 5 minutes). Any other name Postgres knows is accepted the way Postgres accepts it
(the embedded Postgres validates it, inside a transaction it rolls back: the value is the session's alone); one it
does not know is 42704.

`SHOW ALL` (Postico sends it on connect) answers Postgres's three text columns, `name`, `setting` and
`description`, a row per setting the embedded Postgres has, ordered by name, with this session's own values laid over
(`TimeZone`, `search_path`, `application_name`, `DateStyle`, `ssl`, what it SET): each row's `setting` is what
`SHOW <name>` answers. They are Mason's settings, never the source database's (`show-all` in
[docs/SQL-SUPPORT.md](SQL-SUPPORT.md)).

**One reader answers a session's settings, however a tool asks.** `SHOW <name>`, SHOW ALL's row, the ParameterStatus
the session is told and `current_setting(name[, missing_ok])` are the same string: after `SET search_path = sales,
public`, `current_setting('search_path')` answers `sales, public` in a statement the embedded Postgres answers and in
one over a copied table alike, in a WHERE, a CTE or a prepared statement executed after the SET (each catalog request
carries the session's settings in and takes them out again, and a statement over a copy reads them, never the copy
engine's own). A name the session does not hold is the embedded Postgres's own value (`block_size`), and a name nobody
holds is Postgres's 42704, or NULL with `missing_ok`. `RESET <name>`, `RESET ALL` and `DISCARD ALL` restore the value
the session started with — its startup packet's `application_name` and `options` (`-c name=value`) included — and the
session is told a ParameterStatus for each reported parameter whose value changed, as Postgres tells a driver that
caches them (pgjdbc, npgsql): once per request and parameter, its last value, after the statements' CommandComplete
and before the ReadyForQuery (a SET, a RESET or RESET ALL that moves nothing reports nothing).
`SELECT set_config('name', 'value', false)` on its own is the session's `SET`, answered with the value as `SHOW` then
answers it. Forwarded to the embedded Postgres, which every session shares, it stayed there for every session. Any
other form — beside another column or a table, with an expression, a parameter or NULL, with `is_local` true, under
EXPLAIN — is refused (`set-config-forms`). Not yet Postgres's: a `SET LOCAL`, and a SET inside a transaction that is
rolled back, change the session's value for good (GitHub issue 47).

`BEGIN`, `COMMIT` and `ROLLBACK` are accepted and write nothing — there is nothing to write. A failed statement inside
a transaction puts it in the failed state (25P02 until `ROLLBACK`), as Postgres does, because drivers rely on it.
`CancelRequest` cancels the statement running on that session's backend.

**What "now" is**: Postgres's, the start of the TRANSACTION. `now()`, `current_timestamp`, `current_date` and a
`'now'` / `'today'` literal read it. Outside `BEGIN` every statement is its own transaction; inside `BEGIN … COMMIT`
every statement sees the instant the transaction began. DuckDB's own clock is never read (docs/DESIGN.md
"How a statement is answered").

## Observability

Every statement DuckDB answered, every statement refused or failed (a Parse, a Bind, a syntax error, a catalog read
Postgres refused) and every refused login is a row of the run's request log, `_mason.requests` in `.mason/duck.db`.
The catalog never lists `_mason`, so a connected tool cannot read it. A catalog read, a `SET`, a `SHOW` or a `BEGIN`
that was answered is the protocol's chatter and is not recorded (`MASON_PG_TRACE=1` logs every statement): a statement
over the catalog alone (`pg_class`, `information_schema`, `SELECT version()`) is a row only when it is refused. A statement a client
stopped reading at a row count (an Execute's: JDBC's `setMaxRows`, `mason mcp`'s `max_rows`) is a row when its portal
closes (a Sync, a Close, the session's end), with the rows it sent. A row has
the session, `application_name`, the `mason user`, the method (`QUERY`, `PARSE`, `BIND`, `DESCRIBE`, `EXECUTE`,
`CONNECT`), the SQLSTATE, message, detail and hint sent, the rows sent, the bytes sent (every frame of the answer, its
CommandComplete or ErrorResponse included, the ReadyForQuery after it not), the duration and the statement (cut at 64
KiB, flagged when cut). Its outcome is the SQLSTATE's: `ok`, `refused` (the statement's own fault), `failed` (Mason's
or the machine's: classes XX, 53, 57, 58) or `cancelled` (57014: a cancel or a statement timeout). It is kept
`MASON_HISTORY_DAYS` days (default 7). `mason logs --requests` reads it, a request a line, filtered by
`--outcome`, `--since` / `--until`, `--user` and `--client` (`--failed` for every one not answered), a page at a time
(`--before`, the position the last page answered with), `--json` for every column; `mason status` shows the last
day's and week's statements (each outcome, the completed ones' average / p50 / p95 time, the rows and bytes sent) and
the last day's slow and refused statements (docs/DESIGN.md "The request log").

`mason logs --running` lists the statements running now, one per session (its number, its user, `application_name`,
when it started, the rows sent so far), and `mason cancel <session> --statement <n>` stops one exactly as the client's
own cancel would: the client is told 57014 "canceling statement due to user request", its session goes on, and the
request log keeps it as cancelled. With `--statement`, a statement that ended before the cancel arrived is never
mistaken for the session's next one: nothing is cancelled, and the answer names the one it runs now (409). Without it,
whatever the session runs at that moment is stopped, as a `CancelRequest` stops it (Postgres's own semantics).

## Settings

| Setting | Default | What it is |
|---|---|---|
| `MASON_PG_PORT` | 5433, then the project's | the listener's port |
| `MASON_PG_HOST` | 127.0.0.1 | the listener's address |
| `MASON_PG_TLS_CERT`, `MASON_PG_TLS_KEY` | unset (plain) | PEM files; both or neither; with them TLS is required |
| `MASON_PG_PLAIN` | unset | `1`: a plain listener off loopback is on a private network; without it (or TLS) such a listener refuses to start |
| `MASON_PG_CATALOG_TIMEOUT_MS` | 10000 | how long a catalog statement may take before the embedded Postgres is discarded and the statement refused |
| `MASON_STATEMENT_TIMEOUT` | 5min | the longest one statement may run (Postgres's units; 0 for none); a session's `statement_timeout` may only shorten it |
| `MASON_HISTORY_DAYS` | 7 | how many days of the request log (and the sync's events, the usage samples and the copies' sizes) are kept |
| `MASON_STORE_JSON_PATHS` | on | `off`: never store the JSON paths statements keep reading as columns of the copy (`payload ->> 'customer_id'` read by 3 statements, or by one taking 1 s, is stored, and read from there; `mason status` lists them), and drop those stored, at that start |
| `MASON_PG_TRACE` | unset | `1`: log every statement text a session receives |

## How it is tested, and what is not

- **The oracle** (`tests/integration/duck-oracle.itest.ts`, `oracle/`): adversarial synthetic data seeded on a real
  Postgres and copied by Mason's own sync, then thousands of statements — BI tools' shapes, every type, function,
  operator, aggregate, cast and construct — sent through the listener and held to what Postgres answers, after the
  copy and after two rounds of changes. It writes `src/duck/verified.ts` (`UPDATE_VERIFIED=1`) and fails while that
  file is not exactly what it would write.
- **The gaps** (`tests/duck-gaps.test.ts`): docs/SQL-SUPPORT.md is what `src/duck/gaps.ts` and `verified.ts` render,
  and every refusal names an entry that exists.
- **The wire** (`tests/postgres-api/protocol.test.ts`, `encode.test.ts`, `server.test.ts`, `tests/duck-wire.test.ts`):
  the frames, the bytes of every type against Postgres's own, and sessions driven by node-postgres over a real DuckDB
  copy.
- **Roles** (`tests/duck-roles-wire.test.ts`, `tests/postgres-api/catalog.test.ts`, the oracle's role cases): every
  shape a hidden column can be read in, refused over a real listener; the catalog's roles and `SET ROLE`; and a
  Postgres role with the same grants asked the same statements, the refusals equal by SQLSTATE and message.
- **The tool corpus** (`tests/duck-corpus.test.ts`, `tests/postgres-api/corpus/`): the statements psql, pgjdbc 42.7.14,
  node-postgres 8.23, Metabase 0.64.2.8, Grafana 13.2.4, DBeaver 26.2.0 and Superset 6.1.0 were RECORDED sending
  (`MASON_PG_TRACE`) on connect, to list the catalog and to describe a table, replayed and held to an
  answer. A tool is "supported" here only in the sense that what it was recorded sending is answered. Tableau and
  Power BI have not been tried.
