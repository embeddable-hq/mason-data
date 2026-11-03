---
paths:
  - "src/api/**"
  - "tests/postgres-api/**"
  - "tests/duck-wire.test.ts"
  - "tests/duck-requests-wire.test.ts"
  - "tests/duck-users-wire.test.ts"
  - "tests/duck-corpus.test.ts"
  - "docs/POSTGRES-API.md"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. The
story behind each rule is in docs/DESIGN.md, under the section it names. -->

# The Postgres API (`src/api/postgres/`, docs/POSTGRES-API.md)

A Postgres wire-protocol listener in the `mason start` process (BI tools connect to Mason as to a read replica). A
tool sends the SQL it sends Postgres and reads the answer as Postgres's, so every rule here is a way a wire answer could
differ from Postgres — the engine's own rules (what is answered, what is refused, the allowlist) are
`.claude/rules/duck-rewrite.md`.

- **What this module owns is the SESSION** (`server.ts`): the handshake, the password, the parameters a tool sets,
  the prepared statements and portals, the catalog Postgres beside it, and the bytes of every answer (`encode.ts`). A
  statement is parsed by Postgres's own grammar (`parser.ts`, on a worker: `libpg-query`'s WebAssembly grows the
  process otherwise, `parser-worker.ts`) and classified (`translate.ts`): a SELECT over a copied table is planned by
  the catalog Postgres and run by DuckDB (`src/duck/plan.ts`), a catalog statement is the catalog Postgres's, and
  SET / SHOW / BEGIN are the session's. **Nothing unlisted is accepted**: a statement kind the classifier does not
  know is refused with a SQLSTATE and the way out, never guessed at.
- **The catalog is a Postgres** (`catalog.ts`: PGlite, lazy, idle-stopped, ~820 MB while up, on a worker thread with
  a deadline per statement — `statementMs`, `MASON_PG_CATALOG_TIMEOUT_MS` — since it runs synchronously on whatever
  thread hosts it): `pg_catalog` and `information_schema` statements, and a statement that reads no table at all
  (`SELECT version()`, `SELECT 1`, `current_setting(…)`), are forwarded, under per-session statement names, and the
  reply relayed byte for byte, never hand-answered from text matching. Its database is C, so a statement of no table
  whose analysis ORDERS text under a collation that is not byte order (`SELECT 'a' < 'B'` under en_US or ICU, a VALUES
  sorted, a `COLLATE "und-x-icu"`) is the synced data's instead (`ordersText`, src/duck/plan.ts: one analysis, 5 to
  13 ms measured on a loaded laptop, so asked only of a statement of no table whose raw tree has a sort, `<`, `>`,
  BETWEEN, GREATEST / LEAST, min / max or a COLLATE: `mayOrderText`, translate.ts; issue 122); equality and every other
  one stay the catalog's. A COLLATE naming a collation the resolver refuses (a nondeterministic one) is the synced
  data's, which refuses it by name, ordered or not. Two stay the catalog's though they order text: one naming a
  parameter in a simple Query (Postgres's 42P02, the analysis being a Parse's), and one that holds a numeric (a literal
  such as 1.5 included), which the catalog computes exactly (Mason gap `fromless-numeric-text-order`, its text then in byte order).
  It holds the copied tables' definitions (`schema.ts`, from the copy's own columns and types, each column's own
  collation) and the source's collations (`collationDdl`: a locale PGlite lacks is made under its provider's root, so
  its name and provider are the source's, and Postgres's analysis names it), and no rows. It is ONE connection every session shares, so the
  server keeps its protocol state itself: after an ErrorResponse it sends the Sync Postgres waits for
  (`ignore_till_sync`; without it one refused Parse silenced the catalog for every session), and a `SET` it validates
  runs inside a transaction it rolls back. A view or default of the source the catalog cannot hold is said in one
  log line, by name, never silently dropped.
- **The password is a user's or a token's** (`authenticate`; `listenerLogins`,
  src/duck/users.ts): a `mason user`'s password (`mason_<id>_<mac>`, the MAC over its NAME and id keyed by the API key,
  so the startup packet's user name must be the user's and every statement is attributed), or a token minted from the
  API key; a refused one is `28P01` as a wrong password is, with the reason in the log; a DISABLED user's, its password
  right, is `28000` "role … is not permitted to log in", as Postgres refuses a role without LOGIN (`user_disabled`).
  The users file is re-read before every statement of a user's session (`recheckMs: 0`), so `mason user remove` (and `disable`) ends
  a session at its next statement. Fail closed: a users file that cannot be read refuses every user (`57P03`).
- **The database a tool connects with has ONE rule, and it is not the project's name** (`src/lib/database-name.ts`
  `connectDatabase`: the sources file's `database:`, else on a server `MASON_PG_DATABASE`, else `mason`; docs/DESIGN.md
  "The database name a tool connects with"): the listener compares it exactly, the wrong one is `3D000` whose hint
  (`wrongDatabaseHint`) says the right name, how to say it and where it is set, and never the sources file's path (a
  client reads it before any password, and that file is named for the source's database). The catalog renames its own
  database to it (`databaseNameSql`, which moves another database holding the name, PGlite's `template0` / `template1`, aside), so `current_database()` and
  `pg_database` agree. The project's name names the slot alone. DETECTOR: `tests/conventions.test.ts`,
  `tests/database-name.test.ts`.
- **What a tool sets is honoured, read back or refused by name, never silently ignored** (issues 64, 253): `TimeZone`
  moves every timestamptz the session sends; `DateStyle`'s field order (`ISO, DMY` / `YMD` / `MDY`, a part not named
  kept as `check_datestyle` keeps it) is held and read by both engines' input of a date; `extra_float_digits` 1..3 and
  the isolation levels (`SET TRANSACTION`, transaction-local; `SET SESSION CHARACTERISTICS`) are remembered, so `SHOW`
  and `current_setting` read back what was set; `extra_float_digits` below 1, a `client_encoding` other than UTF8, a
  `DateStyle` other than ISO and an `IntervalStyle` other than `postgres` (gap `interval-style`) are refused; a
  parameter Mason has no opinion on is given to the catalog Postgres to validate (an unknown name is
  `42704`, as on Postgres) and kept by the session, so `SHOW` answers it. **What a session says about TLS is the
  session's** (`tlsParameters`): `SHOW ssl` / `current_setting('ssl')` and the `ssl_*` the listener knows
  are one table read before the catalog Postgres, which serves no TLS and said `off` on every TLS session.
- **A session's settings have ONE reader, `sessionSetting`** (server.ts): `SHOW`, SHOW ALL's rows, every ParameterStatus
  (the startup's and each a SET, RESET, RESET ALL or DISCARD ALL changed: `reportChanges`, Postgres's rule) and
  `current_setting` — in the catalog, where every request carries the session's settings and RESETs them after
  (`asSession`, catalog.ts; the catalog is one connection every session shares), and beside a copied table, where
  the rewrite reads the map the session's statement runs under (`settingRead`, `SETTINGS_VARIABLE`), never DuckDB's
  own. RESET restores the startup's values (`startupVars`: its packet's `application_name` and `options`).
  `set_config` is a SET, or under `is_local` a SET LOCAL, so the listener's (translate.ts `setConfig`: alone in a
  SELECT, else `set-config-forms`): forwarded, it ran on the one shared catalog connection and stayed for every session.
  The changed parameters are
  told once per request, before its ReadyForQuery (`ready`).
- **A session's state for an answer is ONE value, applied by ONE applier per engine** (issue 253): its TimeZone,
  search_path and DateStyle are `Session.sessionState()` (server.ts), built from `sessionSetting` alone; the plan, its
  cache key, the analysis, a Bind's values, a run and every catalog request take that value. The catalog Postgres is
  given it by `sessionSetSql` (catalog.ts: `asSession` around every request, which sets the catalog's base back after,
  `analyze` / `readParameters`, the lookups of views.ts and row-filter.ts); DuckDB by store.ts `SessionSetup.settle`,
  pg-eval told the zone and DateStyle from it. The catalog runs a request under the session's search_path as Postgres
  does (pg_catalog first unless listed), so the overrides (`version()`, `current_setting`, `format_type`) are reached
  by the splice of every call of them from the parse tree (`userSpliced`), never by the path's order. The clock is
  never spliced: each catalog request is a transaction of its own (`asSession`: BEGIN … ROLLBACK) whose first message
  runs with PGlite's wall clock held at the session's instant (`PgCatalog.run`'s `at`, catalog-worker.ts
  `pinnedClock`), so the catalog's transaction start IS the session's and every reader of it (now(), the keywords, a
  relative word however it is spelt, computed or bound) agrees with the DuckDB path; a block's two paths see one
  instant. The instant is MICROSECONDS, as Postgres's (issues 372, 363): one clock (`src/lib/instant.ts` `nowMicros`),
  one formatter for the DuckDB path (`instantText`), and the same integer round-tripped exactly into the catalog
  (`instantWallMs`), whose real clock after it is floored at it. A prepared statement whose search_path moved since its Parse is planned again
  (Postgres's plancache), and a result that moved is 0A000 `cached plan must not change result type`; a zone alone
  plans nothing again. DETECTOR: `tests/conventions.test.ts` "session state" (no SET of the four in src/ outside the
  appliers; `this.vars.timeZone` / `.searchPath` / `.dateStyle` read only where they are set), and the parameters'
  class test in `tests/postgres-api/server.test.ts` (every name `setParameter` knows has its verdict). The
  catalog's `current_setting` was a fourth reader answering its own values after a SET (issues 40, 41). DETECTOR:
  `tests/conventions.test.ts` (one reader; every catalog request carries the settings or is named), `tests/duck-wire.test.ts`
  and the oracle's setting cases.
- **A session's settings are transactional, and `vars` stays the one store** (issue 47; docs/DESIGN.md "A session's
  settings are transactional"): a transaction keeps only what to restore (`settingsTx`: `rollback`, the values it found;
  `commit`, those with its SETs and none of its LOCALs), read for no answer, and its end replaces `vars` with one of
  them (`endTransaction`). Every SET passes `applySetting`, every failure `abortTransaction`, which undoes them AT THE
  ERROR, as Postgres's AbortTransaction does (the failed block's ReadyForQuery reports the revert, its ROLLBACK nothing),
  and a request that ends with no block open commits its implicit transaction in `ready`. **An implicit transaction is
  one too**: `SET a; SELECT 1/0` in one Query, or in one batch before its Sync, undoes the SET, and `implicitBlock` says
  where Postgres's IsTransactionBlock is true (a Query of several statements; a batch once an Execute completed), which
  is what `SET LOCAL`'s warning and `DISCARD ALL`'s 25001 read. No savepoints, so one level. DETECTOR:
  `tests/conventions.test.ts` (one end, one way in), `tests/duck-wire.test.ts`, the oracle's `oracle/setting-scripts.ts`
  (each step's whole reply equal to Postgres's: warnings, ParameterStatus, tags, status).
- **A transaction is Postgres's**: `BEGIN` opens one (ReadyForQuery `T`), an error inside it aborts it (`E`, every
  statement until `ROLLBACK` is `25P02`, as a driver with autocommit off expects), `COMMIT` of an aborted one is a
  `ROLLBACK`. Nothing is ever written, so all a transaction holds is the session's settings — the states exist because
  a driver reads them. **A failed block accepts nothing but its end on every message** (`heldToFailedBlock`, read before
  a statement is classified or sent to the catalog: a catalog statement runs whole at its Bind, and its rows were once
  answered past the check; `describedInFailedBlock` for a Describe, refused only where it has a result).
  **"Now" is the transaction's** (`txNow`: a simple Query's arrival or the first Bind since Sync, kept by `BEGIN`),
  read by the plan as a parameter, so two statements in one transaction see one instant.
- **Where the listener is comes from ONE reader** (`listener.ts` `pgListenerAddress`: `MASON_PG_PORT`, `MASON_PG_HOST`),
  and **off loopback it is TLS or refused** (`pgListenerSettings`, read by the listener, `mason start`, `mason serve`
  and `mason doctor` alike): `MASON_PG_TLS_CERT` / `_KEY` (then required), plain on loopback, and plain anywhere else
  ONLY under `MASON_PG_PLAIN=1` (`plain.ts`, for a TLS proxy of the operator's own). **A TLS listener takes a direct
  TLS start** (`directTls`): a connection's first byte 0x16 is a ClientHello (`sslnegotiation=direct`, a
  TLS terminator in front) and is TLS at once, ALPN `postgresql`, the bytes read unshifted onto the socket whole —
  never a second read path; a plain listener closes it saying so in the log.
- **A PROXY header is believed only from the addresses `MASON_PG_PROXY_FROM` names** (`proxy.ts`, read by
  `pgListenerSettings`; docs/POSTGRES-API.md "Behind a TCP proxy"): a connection from one MUST begin with a valid v2
  header, read whole before anything else (SSLRequest, ClientHello, startup, CancelRequest), bounded at 216 bytes past
  its first 16 and 5 s; a header from any other address, or on a share's socket, is refused, never believed. Why: a
  header is a claim about who connected, and the request log is believed. **The client's address has ONE reader**
  (`clientAddress`, kept as `Session.clientAddr`): the request log's `client_addr` and the `connected` line read it,
  never `socket.remoteAddress`. DETECTOR: `tests/postgres-api/proxy.test.ts`, `tests/duck-proxy-wire.test.ts`.
- **What a connection may do is its SOCKET'S, never the server's** (`Door`, `Session.door`, `openShare`; docs/POSTGRES-API.md
  "From a cloud BI tool"): TLS, who logs in, what a login is told. One server with two sockets, the same sessions,
  store, roles and request log, so a new socket is a door, never a branch in the session. **A share's socket is TLS or
  refused, on loopback too**, because what is on the tunnel's other end is not loopback ("off loopback it is TLS or
  refused" stays for the run's own listener). It is PUBLIC: nothing of the project is said before a login (every
  self-signed certificate is `CN=mason`, a certificate reaches whoever connects; a wrong database is refused after the
  password, so it is no oracle for the name), what a stranger writes to the request log is bounded (names cut to 63
  bytes, `refused` answering false past ten rows a minute), a CancelRequest on it reaches its own sessions alone (one in clear is how a driver cancels: never a reason to refuse it), and
  its pending logins are capped with the OLDEST making way (`LoginQueue`): a cap that refused the new connection
  would hand the socket to whoever sat on it, and a tunnel hides every source, so nothing can be per source and no log
  line may name one. DETECTOR: `tests/postgres-api/tls.test.ts`, `tests/duck-roles-wire.test.ts`, `tests/duck-wire.test.ts`.
- **The sessions open are the listener's own, counted in memory** (`openSessions`: logged-in sessions by user and
  application_name, and how many run a statement): `/api/state` `sessions`, `mason status`, the usage samples — never a
  query of the request log.
- **A role is enforced on the ANALYSED tree, never on SQL text, and the catalog's roles mirror the roles file**
  (`src/duck/grants.ts`, `src/cli/roles.ts`, `catalog.ts` `catalogRoles` / `asRole`; docs/POSTGRES-API.md "Roles"):
  after Postgres's analysis (views expanded, names resolved) and before the rewrite, every `RTEPERMISSIONINFO` of a
  copied table is held to the session's role — the table and every column in `selectedCols` — and refused with
  Postgres's own message (`42501 permission denied for table …`, the role and column in the DETAIL); a text match would
  miss a CTE, a USING join, a lateral, a `*`. The role is read with the user before every statement and at an Execute
  (a plan carries its `reads`; the plan cache is keyed by role), and fails closed: a role the file lacks, or a file
  that cannot be read, refuses by name, never widens. One Postgres role per Mason role lives in the catalog with the
  same grants, rebuilt when the file or the tables move, and a session with a role runs each catalog request under
  `SET ROLE … RESET ROLE` in ONE message (a Sync added before the RESET: after an error Postgres ignores everything
  until one), so `information_schema` and `has_*_privilege` answer for the role and no other session's request meets
  it. `pg_catalog` is not filtered (stage 1a). DETECTOR: `tests/duck-roles-wire.test.ts` (every shape),
  `tests/postgres-api/catalog.test.ts` (the roles' DDL, `SET ROLE`, interleaving) and the oracle's role cases (a
  Postgres role with the same grants, the same statements, refusals equal by SQLSTATE and message).
- **The roles file decides what a user with no role reads, never the code** (`Session.grants` / `roleName`; docs/DESIGN.md
  "Roles: the file decides the default"): no file, every copied table; `default: <role>`, that role (its refusals,
  its catalog under `SET ROLE`, its request-log `role`), read at every statement; a file with no `default:`, nothing —
  every statement that reads a copied table refused 42501 with the two ways out, `SELECT 1` answered, the catalog run
  as `NO_ROLE_CATALOG` (a grant-less role, src/duck/grants.ts `catalogRolesOf`: information_schema lists nothing, the
  privilege functions are false, `current_user` / `current_role` / `user` spliced to the user's name, `set_config`
  refused), never as the catalog's superuser. A token reads every copied table. Why: a default in the code is a grant nobody committed. DETECTOR:
  `tests/duck-roles-wire.test.ts` (stage 1b's tests), `tests/cli-roles.test.ts`.
- **A role's rows are filtered by REPLACING every read of a filtered table on the analysed tree, never by text, and a
  user missing a value is refused, never answered with no rows** (`src/duck/row-filter.ts` `expandRowFilters`,
  `server.ts` `withRows`; docs/DESIGN.md "Roles: rows per user"): each read of the table — a view's, a CTE's, a
  subquery's, a join side's — becomes its filtered read (`through:` an EXISTS over the parent's filtered read), the
  attributes bound as typed literals the catalog inferred, and the result goes through the grants, rewrite and
  allowlist again (one grammar). The plan cache is keyed by role AND bound filters; an Execute whose filters moved is
  planned again. The catalog holds the same filters as `CREATE POLICY`, reading `current_setting('mason.attr.…')`,
  which the session may SHOW but never SET. Why: zero rows for a missing value is a silent wrong answer, and a filter
  in the text misses the read a view or a CTE hides. DETECTOR: `tests/duck-roles-rows-wire.test.ts`, the oracle's
  `rowFilterCases` (Postgres logins under the same policies). Every `duck.plan` caller passes the session's `grants`
  (`tests/conventions.test.ts`).
- **A filtered read is a SECURITY BARRIER: a statement's own expression never runs on a hidden row** (`BARRIER`,
  `src/duck/row-filter.ts`; docs/DESIGN.md "Roles: rows per user"): the outermost filtered read ends in a LIMIT the filter
  pushdown cannot cross, for a `where:`, a list and a `through:`, with no gate, because `proleakproof` on the analysed
  tree says nothing about what the rewrite sends. Why: below a filter's SEMI join an expression that raises answers "does
  a hidden row satisfy P?" for any P. The LIMIT is the guarantee (a filter pushed through it would change what it keeps);
  `try` stops the pushdown too, but only as an observation. DETECTOR: `tests/duck-roles-barrier-wire.test.ts`, every shape
  with the `try` wall off by `wallSwitch`, so the LIMIT stands alone (with `try` on, no test can tell), the expression
  above the role's filter and in no scan, read from the engine's plan of what is sent, never "a Limit is there", which
  statistics propagation drops, nor the text; and the oracle's `BARRIER_SHAPES`. **A test of this needs more than 50
  visible keys over a wide range, about half the table visible**, or the engine's join filter hides the leak. RESPONSE:
  on a DuckDB upgrade these fail before the leak ships; the barrier's form changes, never the guarantee. Timing is out of
  scope, and the docs say so.
- **A filtered read keeps what the table's key decides** (`carryKeyDependency`, `src/duck/row-filter.ts`): a subquery has no
  key, so a column a `GROUP BY` of the primary key decides joins the GROUP BY, only when the key is grouped whole (no added
  column can then split a group). Why: the filtered text is analysed again, and 42803 there is Mason's doing, never the
  statement's. DETECTOR: the oracle's `GROUP BY the key` shapes, and `GROUP BY an expression` beside them. RESPONSE: what it
  cannot carry is refused by the gap `roles` with the way out.
- **A table's statistics reach nothing a filtered user reads** (`wallStatistics`, `src/duck/row-filter.ts`;
  docs/DESIGN.md "Roles: rows per user"): the filtered read ends in `try(col)` of every column, which this engine carries no
  statistics through (an observation, not a guarantee, so it has its detector), its select found by a name chosen after
  reading the statement and the count of reads Mason wrote, never by a fixed name; and an EXPLAIN of a statement that reads a filtered table never shows it to the engine: the tables
  are the statement's (`plan.reads`, never the engine's plan's), no line varies with the data, `FORMAT JSON` keeps its
  shape, and ANALYZE is refused by the gap `roles`, the way out said (a user with no row filter reads the full plan).
  Why: a column's table-wide maximum proves a condition false, and whether it was proved is a binary search on a hidden
  row, as `Empty Result`, as the plan's `rows=`, or as an error that did not happen. A session with no filter, and a
  statement that reads no filtered table, are unchanged. DETECTOR: `tests/duck-roles-rows-wire.test.ts`, the same
  statement either side of a hidden row's value answers byte-identical text in every form for `where:`, a list,
  `through:` and a join, and an ordinary SELECT alike. `tests/duck-roles-try-types.test.ts` holds name, type and text through the wall.
  RESPONSE: reads walled other than the ones Mason wrote are refused by the gap `roles` (`wallStatistics`); a DuckDB upgrade
  that carries statistics through `try` fails the SELECT test, and the wall's form changes. Nothing new
  may print the engine's plan or scanned tables for a plan with `rowFilters`.
- **Every statement answered and every refusal is a row of the request log** (`recordRequest` → `RequestLedger`,
  src/duck/requests.ts; `.claude/rules/duck-request-log.md` "The request log"): SQLSTATE, message, DETAIL, HINT, rows, session,
  `application_name`, a token's NAME (never the token) or the user's name, and the registry entry that refused it
  (`gap`, from `PgError.gap`: the error's own field, never the text the client was sent). A refused statement is recorded in
  `Session.refuse` alone, the one sender of a statement's ErrorResponse, so no refusal can go unrecorded.
- **A 64-bit integer, a numeric and a float are Postgres's TEXT** (`encode.ts`; `src/lib/pg-numeric.ts` for what
  Postgres computes exactly): the wire carries text, so a value's digits are the oracle's business, never JSON's.
- **The corpus is RECORDED, never transcribed** (`tests/postgres-api/corpus/`, `tests/duck-corpus.test.ts`: every
  statement psql, pgjdbc, node-postgres, Metabase, Grafana, DBeaver and Superset were recorded sending; the
  first live recordings found seven defects a transcribed corpus had passed): run the tool against a run with
  `MASON_PG_TRACE=1` and take the trace's statements, the tool's version beside them; a refusal a tool meets is in
  `KNOWN_GAPS`, with why. `tests/postgres-api/server.test.ts` and `tests/duck-wire.test.ts` drive a real listener over
  a real store; `tests/postgres-api/tls.test.ts` holds the TLS rules; the oracle holds every answer to Postgres.

## What review probes

Run each probe that applies before a push: the harness's implement and fix prompts say so, and its review runs them
again at every round. Its Learn step adds to this list; each bullet names the PR or issue it was met in.

- A binary Bind of a `text[]` or `varchar[]` parameter holding invalid UTF-8, a NUL byte, flags 2, the other element
  OID, a dimension past 268435455, a lower bound of 2147483647: Postgres's SQLSTATE and message, not 08P01 (PR 149;
  issue 160).
- A text-format array parameter of a shape the literal path refuses (`{{1},{2}}`, `[2:3]={a,b}`): a parameter path that
  skips the literal's checks (PR 149).
- A function argument holding a parameter inside it (`a = $1`, `col || $1`) beside a bare `$1`: one parameter decides a
  whole argument (PR 144).
- A prepared statement executed after `SET TimeZone` or `SET search_path`: the Parse's analysis read under another
  session (PR 146; issue 63).
- A statement of no table under `SET TimeZone = 'America/St_Johns'` (`SELECT '12:30'::time::timetz`): the catalog's UTC
  answer (PR 166; issue 168).
- A parse-tree field at its default value, which libpg-query's JSON omits (`SELECT length(current_time(0)::text),
  length(localtimestamp(0)::text)`, a precision of 0 against 1 and 2; any node whose `_N` kind or flag says a value is
  written while the value is 0, false or empty): the absent field read as "not written" where the node's kind says it
  is; `parse-tree-default-field-read-as-absent` (PR 333).
- A parameter value Postgres rejects that Mason's own parsing of it accepts (`SET DateStyle = 'YMD, DMY'`, `'ISO,
  SQL'`, two orders or two styles in one value): accepted and remembered where the catalog Postgres answers 22023 with
  its DETAIL; a parameter's validity is the catalog Postgres's, never re-derived; `parameter-validity-rederived`
  (PR 333).
- Every spelling the parser reads as one value, where a rule keys on a literal's text (`E'now'`, `$$now$$`,
  `U&'now'`, `'now'::text::timestamptz`, `'now'::char(4)::timestamptz`, `'now'::varchar(2)::timestamptz`, the bare
  `now() = 'now'`, `lower('now')::timestamptz`, `coalesce('now','x')::timestamptz`, `(SELECT 'now')::timestamptz`, a
  CASE, a bound `$1 = 'now'`), each `= now()` on a statement of no table: one spelling spliced and the rest read
  another clock, or a written typmod truncating the spliced text; `splice-confirmed-by-one-spelling` (PR 333).
- A statement whose first token is not at byte 0 (`/* app */ SELECT 'now'::timestamptz = now()`, `-- a line\nSELECT
  …`, `SELECT 1; SELECT E'now'::timestamptz = now()`, the same under EXPLAIN, a CTE or a sub-SELECT): a position read
  in the whole text's frame and used in the statement's, or the reverse, so a rewrite lands beside its token instead
  of on it; `offset-mixed-between-two-frames` (PR 333).
- A statement of no table that only equates, groups, distincts or filters under a nondeterministic collation the
  catalog declared (`CREATE COLLATION mason_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`
  on the source: `SELECT 'a' = 'A' COLLATE mason_ci`, `SELECT 'a' COLLATE mason_ci IN ('A', 'z')`, `SELECT DISTINCT x
  COLLATE mason_ci FROM (VALUES ('a'), ('A')) AS v(x)`, the same under GROUP BY and WHERE), beside one that orders
  text: kept as the catalog's because the routing asked only whether text is ORDERED, so PGlite's own locale answers
  silently where the resolver would have refused the nondeterministic collation by name; any collation beyond 0/100
  and byte order in the analysis must reach the resolver; `catalog-answers-under-declared-collation` (PR 413).
- A statement of no table that the catalog's own analysis, as the session would run it, refuses (`SELECT $1::text <
  $2::text` sent as a simple Query with no parameters: 42P02 "there is no parameter $1"), under each route a
  statement of no table can take to the synced data (one that orders text, one under a collation): routed before
  Postgres could refuse it, so the engine's protocol error (08P01) replaces Postgres's SQLSTATE; a statement is routed
  only once the catalog's analysis of it succeeds; `fromless-routed-before-postgres-refuses` (PR 413).
- A statement of no table that maps case over a value of the server, the catalog or the session (`SELECT
  upper(version()) LIKE 'POSTGRES%'`, `SELECT upper(split_part(version(), ' ', 1))`, `SELECT count(*) FROM (SELECT
  upper(version()) AS v) s WHERE v LIKE 'POSTGRES%'`, `SELECT upper(format_type(23, NULL))`, a `current_setting(…)`
  in the same place), run through `scripts/duck-repro.ts`, never only the unit world, which answered it right while the
  real run did not: routed to the synced data because a trial run SUCCEEDED, so the engine answered with its own
  version or type name; a run's success is not the authority for the route, Postgres's analysis and the allowlist are,
  and a server's or session's value stays the catalog's; `fromless-case-route-run-success-read-as-sameness` (PR 568).
