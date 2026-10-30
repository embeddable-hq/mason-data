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
`.claude/rules/duckdb.md`.

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
  reply relayed byte for byte, never hand-answered from text matching. It holds the copied tables' definitions
  (`schema.ts`, from the copy's own columns and types) and no rows. It is ONE connection every session shares, so the
  server keeps its protocol state itself: after an ErrorResponse it sends the Sync Postgres waits for
  (`ignore_till_sync`; without it one refused Parse silenced the catalog for every session), and a `SET` it validates
  runs inside a transaction it rolls back. A view or default of the source the catalog cannot hold is said in one
  log line, by name, never silently dropped.
- **The password is a user's or a token's, the project is the database** (`authenticate`; `listenerLogins`,
  src/duck/users.ts): a `mason user`'s password (`mason_<id>_<mac>`, the MAC over its NAME and id keyed by the API key,
  so the startup packet's user name must be the user's and every statement is attributed), or a token minted from the
  API key; a refused one is `28P01` as a wrong password is, with the reason in the log; a DISABLED user's, its password
  right, is `28000` "role … is not permitted to log in", as Postgres refuses a role without LOGIN (`user_disabled`); the
  wrong database is `3D000`.
  The users file is re-read before every statement of a user's session (`recheckMs: 0`), so `mason user remove` (and `disable`) ends
  a session at its next statement. Fail closed: a users file that cannot be read refuses every user (`57P03`).
- **What a tool sets is honoured or refused, never silently ignored**: `TimeZone` moves every timestamptz the session
  sends; `extra_float_digits` below 1, a `client_encoding` other than UTF8 and a `DateStyle` other than ISO are
  refused; a parameter Mason has no opinion on is given to the catalog Postgres to validate (an unknown name is
  `42704`, as on Postgres) and kept by the session, so `SHOW` answers it. **What a session says about TLS is the
  session's** (`tlsParameters`): `SHOW ssl` / `current_setting('ssl')` and the `ssl_*` the listener knows
  are one table read before the catalog Postgres, which serves no TLS and said `off` on every TLS session.
- **A session's settings have ONE reader, `sessionSetting`** (server.ts): `SHOW`, SHOW ALL's rows, every ParameterStatus
  (the startup's and each a SET, RESET, RESET ALL or DISCARD ALL changed: `reportChanges`, Postgres's rule) and
  `current_setting` — in the catalog, where every request carries the session's settings and RESETs them after
  (`asSession`, catalog.ts; the catalog is one connection every session shares), and beside a copied table, where
  the rewrite reads the map the session's statement runs under (`settingRead`, `SETTINGS_VARIABLE`), never DuckDB's
  own. RESET restores the startup's values (`startupVars`: its packet's `application_name` and `options`).
  `set_config` is a SET, so the listener's (translate.ts `setConfig`: alone in a SELECT, else `set-config-forms`):
  forwarded, it ran on the one shared catalog connection and stayed for every session. The changed parameters are
  told once per request, before its ReadyForQuery (`ready`). The
  catalog's `current_setting` was a fourth reader answering its own values after a SET (issues 40, 41). DETECTOR:
  `tests/conventions.test.ts` (one reader; every catalog request carries the settings or is named), `tests/duck-wire.test.ts`
  and the oracle's setting cases.
- **A transaction is Postgres's**: `BEGIN` opens one (ReadyForQuery `T`), an error inside it aborts it (`E`, every
  statement until `ROLLBACK` is `25P02`, as a driver with autocommit off expects), `COMMIT` of an aborted one is a
  `ROLLBACK`. Nothing is ever written, so a transaction holds nothing — the states exist because a driver reads them.
  **"Now" is the transaction's** (`txNow`: a simple Query's arrival or the first Bind since Sync, kept by `BEGIN`),
  read by the plan as a parameter, so two statements in one transaction see one instant.
- **Where the listener is comes from ONE reader** (`listener.ts` `pgListenerAddress`: `MASON_PG_PORT`, `MASON_PG_HOST`),
  and **off loopback it is TLS or refused** (`pgListenerSettings`, read by the listener, `mason start`, `mason serve`
  and `mason doctor` alike): `MASON_PG_TLS_CERT` / `_KEY` (then required), plain on loopback, and plain anywhere else
  ONLY under `MASON_PG_PLAIN=1` (`plain.ts`, for a TLS proxy of the operator's own). **A TLS listener takes a direct
  TLS start** (`directTls`): a connection's first byte 0x16 is a ClientHello (`sslnegotiation=direct`, a
  TLS terminator in front) and is TLS at once, ALPN `postgresql`, the bytes read unshifted onto the socket whole —
  never a second read path; a plain listener closes it saying so in the log.
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
  `rowFilterCases` (Postgres logins under the same policies).
- **Every statement answered and every refusal is a row of the request log** (`recordRequest` → `RequestLedger`,
  src/duck/requests.ts; `.claude/rules/duckdb.md` "The request log"): SQLSTATE, message, DETAIL, HINT, rows, session,
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
