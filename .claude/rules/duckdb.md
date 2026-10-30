---
paths:
  - "src/duck/**"
  - "src/cli/dev.ts"
  - "tests/duck-*.test.ts"
  - "tests/integration/duck-*.itest.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). Written from
docs/DESIGN.md and the doc comments of src/duck/; CLAUDE.md lists every rules file. The story behind each
rule (the incident, the measurement) is in docs/DESIGN.md, under the section each rule names. -->

# The engine (`mason start` on DuckDB)

DuckDB runs INSIDE the `mason start` process, on a worker thread of its own (`src/duck/executor.ts`), file-backed at
`.mason/duck.db` (`src/duck/store.ts`): one writing process per file, so the sync and every Postgres wire session share
one instance. **Postgres decides, DuckDB
computes**: the catalog Postgres (PGlite, the copied tables' definitions, no rows) analyses each statement, the rewrite
makes it DuckDB's, and DuckDB runs it (`src/duck/plan.ts`). Each added table is copied whole from the source, then kept
current as its `sync:` says — `off` (the default: read again only at `mason sync`), Mason's xmin poll at its interval,
or logical replication (`replication`, `src/duck/stream.ts`), mixed in one project.

## A statement

- **DuckDB runs only a `PlannedSql`, made in `src/duck/plan.ts` alone, after the read-back** (`tests/conventions.test.ts`):
  a statement's own text never reaches DuckDB, because an `EXPLAIN ANALYZE <write>` that did ran the write
  (docs/DESIGN.md "The review").
- **How a copy is kept current is derived ONCE, by the sync** (`Sync.keptOf`, carried on `Sync.state` as `kept`):
  `mason status` (`kept`: its sync, `syncedAt`, `nextAt`; `streamStatus`'s tables) and EXPLAIN's first line (`keptText`, src/duck/explain.ts) both
  read it, never the poll's ledger (a project switched to replication keeps its last poll there: EXPLAIN said "kept
  current by polling" of a streamed table). `tests/duck-sync-added.test.ts` and `tests/duck-wire.test.ts` hold it.
  ("EXPLAIN")
- **EXPLAIN ANALYZE's profile is held to its statement, never assumed its** (src/duck/store.ts `explained`): DuckDB's
  profiler writes the LAST profiled statement's profile on the connection, so it is on for the statement alone (turned
  on in `streamed` after the settle, off before anything else runs), and the profile must name the planned SQL
  (`query.sql`; another's is XX000 "report it"). None written — DuckDB answered while planning, a count(*) of a whole
  table — is said, with DuckDB's EXPLAIN as the plan: the settle's probe of the schemas was once reported as the plan of
  such a count (`tests/duck-wire.test.ts` "own profile"; docs/DESIGN.md "EXPLAIN").
- **A node is placed ONCE in the rewritten tree**: the walker runs a node's rule at its first place only, so a rule that
  uses a node twice clones it per use (`this.cp`, a helper's `copy`), or the second place is Postgres's text (a json
  read's column qualified in one arm of its CASE: DuckDB's 42804, a review finding). The walker records a node
  of the statement met twice outside its own rule's answer (`nodesPlacedTwice`, src/duck/rewrite.ts), and
  `tests/duck-wire.test.ts`, `tests/duck-corpus.test.ts` and the oracle hold it to none. ("A `->>` is DuckDB's own read")
- **A rewrite the deparser cannot spell is a refusal, never a different statement**: the rewritten tree is deparsed,
  parsed again and compared node for node (`treeDifference`). ("How a statement is answered")
- **No DuckDB macro**: with the `postgres` extension loaded, a macro with a lambda or calling a macro
  fails; every helper is a JavaScript scalar function (`src/duck/functions.ts`) or SQL written inline.
  ("How a statement is answered")
- **What DuckDB is sent is the form it computes natively, where that is Postgres's answer** (each was a BI tool's slow
  path on the test server, and two were not Postgres's answer either; "What DuckDB is sent"):
  - **a truncation of a timestamptz is the instant's arithmetic** (`truncInstant`: `epoch_us` floored, `make_timestamptz`),
    never ICU's calendar where the arithmetic is Postgres's: every part in UTC, a second or less in any zone, a minute or
    an hour elsewhere with the instant's offset kept (ICU re-read the wall clock: 02:30 CEST truncated to 02:00 +01). A
    day or more in another zone stays DuckDB's `date_trunc` in the session's zone. ICU is ~45 ns a row even in UTC, the
    arithmetic ~8; a TIMESTAMP ↔ TIMESTAMPTZ cast is ICU's too, so never "cast, truncate, cast back". The session's
    zone is read where the statement executes (`current_setting('TimeZone')`), never the rewriter's: a prepared
    statement's plan is made at its Parse and run after a later `SET TimeZone`;
  - **a LEFT JOIN of a list's rows ON TRUE is an INNER lateral of a list never empty only where its rows' order
    decides the answer** (`leftLateral`, `markBounds`, `limitBounds`, the functions' `orNull`): DuckDB's LEFT lateral is
    a delimiter join over the whole base, whose LIMIT read every row (37.9 s for a 100-row preview) and whose order
    kept other rows than Postgres's; the INNER one is its streaming UNNEST. But the UNNEST calls the function per ROW,
    the delimiter join per DISTINCT argument, so where every row is read anyway (a count, a GROUP BY, a DISTINCT, a
    window, a whole result, a sort by the lateral's column) DuckDB's own join stays (a count over 22 M rows: 79 s joined,
    over 200 s streamed). Bounded: a LIMIT or OFFSET over the join, passing down through a derived table, a CTE and a
    UNION ALL's arms; under an ORDER BY only a LIMIT (never WITH TIES), and only when its first key, the nulls idiom
    folded, is a table's column sorted bare (no collation keys, citext, char(n), jsonb: the top N's filter reaches the
    scan); and an order-sensitive aggregate or window (string_agg, array_agg, row_number …) with no ORDER BY of its
    own. **DuckDB streams the INNER lateral only where its list reads ONE column of the row or an array column**; two
    or more and no array is its delimiter join again (a scalar enum, domain or citext counts as a column; a user
    type's array as an array). So such an argument (any list function's), and an unnest's
    expression of any columns, is computed ONCE by a step of its own before it, `CROSS JOIN LATERAL (SELECT e AS __mason_arg<n>)
    AS __mason_arg<n>` (a projection under the UNNEST, free; the never-empty CASE names the step's column twice) —
    never where e reads an array (DuckDB plans THAT step as its join: an unnest's e is then computed once inside,
    `list_transform(list_value(e), l -> CASE … l … END)[1]`, a list copy a row, 12–23 ms a million rows), nor where
    a `*` or a join's name reads the join (`markWholeReads`: the step's column would be read). Decided in a pre-pass
    over the whole statement (the walk meets a CTE before the SELECT that reads it). Bounding too much costs time, too
    little an answer; where DuckDB itself falls back to the delimiter join, the difference is registered: under a
    filter it does not push down (`limit-lateral-filter`), an argument holding a subquery or two columns under a `*`
    (`limit-lateral-argument`). **A row count an Execute sets on the wire is a bound the Parse's plan cannot see**: the plan says where a lateral was left joined that such a bound
    would stream (`PlannedSql.unboundedLateral`, the pre-pass run again with the outermost SELECT bounded — never a
    re-parse), and the portal's first Execute with a row count runs the statement planned again with `wireBound`
    (`Session.boundOnWire`), under its Parse's settings, kept on the statement and in the plans by text; a suspended
    portal reads on from its one result, never re-runs (`tests/duck-wire.test.ts` "an Execute's row count");
  - **equivalent order keys are canonicalised: `x IS [NOT] NULL, x` is one key on `x` with its NULLS placed**
    (`nullsKeyFolded`): an expression key stops DuckDB's top N pruning the scan (6.4 s and 91 s for a 100-row page).
    Equivalent means READ alike too: a bare key that is an integer or an output column's name is the output's
    (findTargetlistEntrySQL92), the same tree inside an expression the input's (`bareKeyIsInput`);
  - **a count(DISTINCT x) of a key is count(x)** (`src/duck/distinct-key.ts`): x alone its table's PRIMARY KEY in
    the CATALOG's pg_index (the key the copy is written by; never a sources file's `key:`, and NEVER another UNIQUE
    index — the copy may hold its value twice for a moment, and the catalog's indexes are the source's as of the start
    and `mason add` / `remove` only), and the FROM repeating no row of its table (its table alone, or joined only to
    base tables each on an equality with THAT table's primary key) — all read from the analysed tree and pg_index, never a column's name;
    when unsure the DISTINCT stays (DuckDB's count(DISTINCT) is a second hash aggregate: 120 s against 9 s over 197 M
    rows). Only count; an ORDER BY repeating it drops it with its twin in the same SELECT only. `tests/duck-distinct-key.test.ts`,
    the plan fixture's `KEY_COUNTS` and the oracle's `count of distinct keys` / `keyed` hold it ("A count of distinct keys");
  A new such form is held to Postgres by the oracle in more than one session zone and its SQL by `tests/duck-wire.test.ts`,
  **in the shapes a BI tool sends, each of which broke a rewrite that passed its author's oracle** (2026-10-28, "The
  independent review"): the value grouped, then ORDER BY its ordinal, its output name and the qualified column; the
  nulls idiom with a bare name an output alias shadows, and with an integer constant; a prepared statement executed
  after a later `SET`; `SELECT *` beside the named columns; each collation kind (C, ICU, a libc order) where a string
  is compared, and equality apart from order (equality needs no collation); a NULL or a row-held argument where
  Postgres is strict.
- **A new rewrite for speed is held by the PLAN fixture too** (`tests/duck-plans.test.ts`, `tests/fixtures/duck-plans.json`):
  its statement in the tool's own spelling, over the shop's million orders, its plan's skeleton in the fixture (the
  operators, a top N's count of sort keys, each scan's table and top-N / zone-map filter, the Mason functions, what it sorts by beyond a value —
  ICU's key, a stored column —, a delimiter join, a full sort; a form that reads a stored column, held both stored
  and not, over a copy of the shop whose keeper stored it), and
  where the skeleton cannot show the gain an invariant DuckDB's EXPLAIN ANALYZE measures (the row groups or rows a
  scan read). The oracle is blind to the plan: each of the three forms above was a BI tool's slow path with every
  answer right. A diff of the fixture is a plan changed: a regression is fixed, a better plan regenerated
  (`UPDATE_FIXTURE=1 npm test`) and said so in the commit. DuckDB's EXPLAIN names a projection by its alias, so what
  an expression costs (ICU's date_trunc against the arithmetic) is read from the SQL sent: the skeleton lists the time
  functions it calls. DuckDB 2.0 plans a delimiter join as a CTE (`__duckdb_delim_<n>`) joined back to a hash group by
  of its own scan, no operator named DELIM (`delimiterJoin`). ("The plan fixture")
- **A result's names, types and typmods are Postgres's**, from the analysis, and a numeric Postgres computes exactly is
  computed by `src/lib/pg-numeric.ts`, never DuckDB's double or HUGEINT. ("How a statement is answered")
- **DuckDB lives on the executor worker; the main thread never runs a Mason function and never waits for the
  executor** (the test server: a JSON read through a function held the process silent for 98 s, and a client
  leaving mid-statement hung it for good). A JavaScript scalar function runs on the thread that REGISTERED it, so the
  instance, every connection and the functions are the worker's (`src/duck/executor.ts`, `executor-worker.ts`); the
  sync, the stream, the request log and the tests post statements through `DuckConnection`, the sessions through
  `RemoteRunner`. Never open a second instance of the file in the process — DuckDB does not refuse it and the two lose
  each other's writes (`DuckStore.open` refuses one still open and waits for one closing). On the worker the old rule
  holds: closing a result or a connection waits for the executor's tasks, so a statement that calls a function is
  cancelled through its SESSION — the CANCEL TABLE (`src/duck/cancel.ts`, shared memory the listener writes at once,
  never a message to the busy worker; every `__mason_*` call carries `getvariable('__mason_session')` first,
  src/duck/rewrite.ts `fn`): its next call raises, it is interrupted as well (its call-free rest stops at DuckDB's next
  chunk), and the result is closed only once DuckDB ended the query off this thread (`cleanUp`, below); one that calls none
  is interrupted and goes the same way. `tests/duck-executor.test.ts` and `tests/duck-wire.test.ts` "a client
  leaving mid-statement" / "statement_timeout stops a statement that calls a Mason function" hold it.
- **Whether a statement calls a Mason function is its PLAN's, never its text's** (a review finding: a `*` over a
  copy reads `__mason_visible`, which calls nothing, and a text match left every such statement uncancellable — 82 s
  past a 300 ms timeout): `PlannedSql.functions`, the `__mason_*` calls of the rewritten tree (`masonCalls`,
  src/duck/rewrite.ts), carried from the planner to the executor and listed by EXPLAIN. `tests/conventions.test.ts`
  refuses a text match in `src/`, and `tests/duck-corpus.test.ts` holds the list equal to the calls in the text.
- **A cancel asked is a cancel answered**: a statement whose cancel or timeout landed after its last call, or as its
  last chunk was computed, is told 57014, never "ok" (the worker reads the cancel table at the end, the listener's
  thread its own signal). A drained statement's own error is logged, never swallowed.
- **The worker's thread never waits for DuckDB's tasks** (under load the suite's process sat at 0 % CPU for good — the
  worker inside a result's close, DuckDB's `CancelTasks`, waiting for a task that waited inside a Mason function call for
  the worker; issue 58 made it with no load at all): every close is synchronous on the worker, a close of an open
  result or of a connection with something running waits for its tasks, and a call-free statement's close holds the
  thread for the rest of a native vector (17.9 s measured, every session behind it). So a statement that did not run to
  its end — failed, cancelled, closed early, calling or not — is interrupted and READ ON with an async `fetchChunk` until
  it fails or ends (`SessionRunner.cleanUp`): every end of a query waits for its tasks on the thread that ends it
  (`EndQueryInternal`), there libuv's, while this thread answers their calls, and only then is the result closed. A
  **statement performs no wait**: DuckDB refuses one while a result holds the connection, so `SELECT 1` is the PROOF
  that nothing is left, never the wait (DETECTOR: a refused probe is logged as a Mason bug; RESPONSE: closed all the
  same, and the watch below catches a deadlock). Time is no proof: no call for 50 ms proved nothing, a vector's native
  work outlasts any window. A connection's close (`conn.close`, src/duck/executor-worker.ts) interrupts its own calls and
  waits for them. A new synchronous call into DuckDB on the worker is read against this rule (`tests/conventions.test.ts`
  lists the closes). `tests/duck-executor.test.ts` "a vector slower than any quiet window", "a call-free statement closed
  inside a slow vector", "a connection closed under its own", "cancelling a function-calling statement again and again"
  hold it. Any statement on a session's connection waits for `releasing` first: DuckDB would refuse it. ("The watch")
- **Nothing is closed under a pending call of DuckDB's** (a stop during a drain aborted the process, exit
  134): a session's connection closes once nothing runs on it (`SessionRunner.close`: an open answer drained, every
  fetch settled), and the worker's shutdown waits for every session close in flight and every connection's call before
  it closes the connections and the instance; a statement still in flight is stopped as a cancel stops it and told
  57P01 (`STOPPING`, src/duck/executor.ts), a later one too; a connection's call still running is interrupted first.
- **Every call to the worker settles** (src/duck/executor.ts `SILENT_MS`, `CLOSE_GRACE_MS`): a worker silent 60 s with
  a request pending is given up on — every request told 57P02, the run told (`onCrash`) — and `close` settles within
  5 s whatever the worker does. A thread blocked inside native code is never ended by `terminate` or `process.exit`
  (measured), so a file given up on is never opened again in the process (`abandoned`); its supervisor's SIGKILL ends it.
- **The watch counts its own ticks and hears a beat, so it fires on nothing but a stuck thread** (issue 58): silence is
  unanswered pings on the MAIN thread's ticks, never the wall clock, so a main thread blocked or a process frozen counts
  nothing against a healthy worker, and every Mason function call and row bumps the BEAT (`beat`, src/duck/cancel.ts,
  shared memory), since a calling statement holds the worker's loop a thousand calls at a time with no pong (a 20 kB
  document: 999 × 322 ms). What is left is a thread that neither turned its loop nor ran a row of a function for 60 s of
  main's time. A new long stretch of JavaScript on the worker with no loop turn beats, or the watch calls it stuck. Never
  a test that blocks the main thread: `nodeProcess` in `tests/duck-executor.test.ts` is an async spawn. "the watch" tests
  there hold both sides: blocked main and a beating thread must not fire, the silent worker and a spinning thread must.
- **Nothing ends the worker's JavaScript while DuckDB has work in flight on it** (a test file under load aborted at
  exit, `libc++abi: … Napi::Error`: its close outlasted the grace and the executor terminated the worker under a
  Mason function call; a 1 ms grace reproduced it 6 times in 6). A worker given up on (the grace, the silence) is asked
  to SHUT DOWN (`shutDown`) and terminated only once that shutdown answered or it exited; until then it stays
  referenced, so the process cannot exit under it either — and an answer's close is a request, answered once DuckDB
  handed it back (`answer.close`). Never `worker.terminate()` a copy's worker that may have a statement in flight:
  even a call-free one aborted the process 2 times in 12. `tests/duck-executor.test.ts` "never ends the copy's thread
  under a call" holds it (a close with a 1 ms grace, a process ending while an answer drains).
- **A statement closed while it STARTS is released only once DuckDB hands its start back** (Linux CI: the stop met a
  calling count inside `stream()`, released it at once with nothing to close, and the result handed back after was
  never closed — the connection and the instance closed under its running tasks, and the thread's end met their
  queued calls, `FATAL ERROR: Error::Error napi_define_properties`): `drain` waits for a pending start (its failure
  releases it through `cleanUp`, its answer is drained once handed back), and `SessionRunner.close` closes an answer a
  statement opened while the close waited. `tests/duck-executor.test.ts` "a session closed while its function-calling
  statement starts" holds both, by the order the worker's port keeps (answered, then released).
- **A statement that calls a Mason function starves the executor worker for its whole run, and with it every other
  statement on the copy**: DuckDB's threads queue their calls faster than the worker answers, and Node's
  threadsafe-function loop runs up to a thousand calls between two turns of anything else (4.5 µs a row on the test
  server, ~9 ms a call), so a DuckDB statement of another session, a stream batch, a poll and a request-log write each
  wait about that long per round trip — in practice until the calling statement ends. The listener, the catalog, logins,
  the commands and cancels do not (`tests/duck-executor.test.ts`). The way out is FEWER CALLS, two ways:
  - **a `->>` / `#>>` of a COLUMN is DuckDB's own read where that read is Postgres's answer** (`jsonGet` in
    src/duck/rewrite.ts: a string value, a missing path, a JSON null; a chain of reads off one column folded into one,
    `jsonChain`), and the function answers only the rows it must (a number's digits, an object, an array, an index, a
    document holding a key twice) — the CASE's ELSE, which DuckDB evaluates on those rows alone. Only a COPIED table's
    jsonb column (`Typed.relation`) is read without checking each object's keys are held once: a jsonb the statement
    computes (`jsonb_object_agg`, `jsonb_build_object`) is the rewrite's text and may hold a key twice, whose `->>` is
    the last (a review finding). A `#>` element is an index by ONE definition, `pathIndex` (Postgres's
    `strtoint`), which the function and the native read both ask (`tests/conventions.test.ts`). Measured, 5 M
    rows: 0.21 s native, 8.8 s through the function. A new native read is held to Postgres by `tests/duck-wire.test.ts`
    "a ->> of a column is DuckDB's own read" (every shape, against PGlite, and the hops counted:
    `DuckStore.functionCalls`) and by the oracle. A test that must EXERCISE the function (a cancel, a timeout) reads
    with `->` or a number, never a string's `->>`;
  - **the JSON paths statements keep reading are stored as columns** (below), which answers a number's digits and
    the rest from a plain column. ("The executor worker", "A `->>` is DuckDB's own read")
- **A jsonb is sorted, grouped and compared by ONE key, `jsonbKey` (src/duck/jsonb-order.ts), never by its text**:
  Postgres orders jsonb by its own rules (`[] < 1 < [1]`, objects by size first) and equates `1.0` with `1.00`, so
  every form that compares two jsonb — ORDER BY, GROUP BY, DISTINCT [ON], PARTITION BY, =, <, IN, BETWEEN, IS DISTINCT
  FROM, NULLIF, CASE x WHEN, count(DISTINCT) — is rewritten to compare `__mason_jsonb_key*` (`jsonbKey` in
  src/duck/rewrite.ts), and every other form refuses with `jsonb-compare`. A rule that compares values (a new
  construct, a sort) asks `comparable`, which refuses a jsonb, or keys it; the allowlist does not see a sort's or a
  group's operator, so nothing else stops DuckDB's text equality. **Equality reads the C key, an order the
  collation's**: the database's collation is deterministic (equal strings are equal bytes), so =, IN, GROUP BY,
  DISTINCT, PARTITION BY … read `equalKey`, and only ORDER BY, <, >, BETWEEN must read the collation's key of each
  string (ICU's, or the measured libc order's, which refuses a character it does not cover: equality must never
  refuse what it never had to order). Under C and ICU the order's key equates exactly and never refuses, so
  `equalKey` is it (and may be stored); under libc it is the C key, stored as a column of its own (`EQUAL_STEPS`, below)
  or computed. A node the rewrite typed as another (`typedLike`) keeps
  that type through `clone`. `tests/duck-jsonb-order.test.ts` holds the key to
  Postgres's order under C, ICU and libc, and the oracle's `jorder` every form. ("jsonb's order")

## Stored JSON paths (src/duck/kept.ts, src/duck/kept-route.ts; docs/DESIGN.md "Stored JSON paths")

- **Every write of a copy computes its stored columns, in the write itself**: the poll's `writeStaged` (whole stage or
  piece, the writer's lane or a catch-up's), the stream's `writeByKey` and `updateCarried` (a stored column of a JSON
  column the update carries), the copy's side table before its swap (`fillSide`), and the backfill. A new write path
  into a copied table names its columns and adds `kept.stored(...)` / `kept.storedSet(...)`, or its rows hold the
  unset mark, the column's NULL (refilled by the detector, which logs it as a Mason bug; until then the path's reads
  are the CASE below, never the column alone).
  `tests/duck-json-columns.test.ts` breaks each path and must fail; `tests/integration/duck-json-paths.itest.ts` holds
  every stored read to Postgres's after a copy, polls, stream batches and a copy made again.
- **A column is added only on the writer's turn and never while its table is rebuilt** (a catch-up poll writes it from
  the rebuilds' connection), so every write knows its table's stored columns — **and with NO DEFAULT** (`keep`): DuckDB
  writes a non-NULL default into every row inside the ALTER and its COMMIT (the test server's 196.5 M-row table held
  the writer 28 s, the stream stalled ~3.5 min beside a whole-table read; a laptop's 30 M rows: 0.7 – 1.0 s against
  0.1 s, and nothing written at the commit), so the column's NULL is the unset mark and a NULL answer is `KEPT_NULL`
  (a NUL). Never give it a default. **Even with no default the add is a known cost Mason cannot shorten**: DuckDB 2.0
  reads no block of the table but builds the new column in memory for every row (~4.5 B a row: 135 MB of
  `IN_MEMORY_TABLE` for a laptop's 30 M rows, the ALTER 100–330 ms, its COMMIT 0–4 ms with nothing in the WAL), and the
  next checkpoint writes it, one 256 KiB block a row group under forced zstd (64 MB, 60–180 ms). The same on its own
  connection with `IF NOT EXISTS`, as `JSON`, or inside keep's transaction. The test server's 196.6 M rows (~885 MB in
  memory, ~420 MB at the checkpoint) held the writer 8–17 s; the laptop's numbers scale to 1–2 s, and the gap is not
  reproduced here. ("Stored JSON paths" 2.)
- **ONE column per path** (`pathKey`, src/duck/kept-route.ts): a `#>` whose elements are all keys (none reads as an
  index: `pathIndex`) is the same keys' `->` read (`canonicalRead`, the one place every read passes through: the
  rewrite, the request log's key, the hidden name, the ledger, `mason status`), and a path's `->` and `->>` share its
  column, which holds the `->` answer (the value's JSON text) — `->>` is derived from it (a string unquoted, a JSON
  null NULL, anything else its text; a string holding an escape by the function on the value's own text), never the
  other way (`->>` cannot tell the string "5" from the number 5). `{arr,0}` is not folded with `-> 'arr' ->> '0'`.
- **READY means every row holds the path's `->` answer or `KEPT_NULL`, and a READY path with no marked row (`marked`
  0, `exact`) is read from its column ALONE** — no CASE naming the document, so DuckDB never reads it (the test server:
  41.6 s for a whole-table read through the old CASE, 8.5 s for a small column's scan). After READY a row is unset
  only through a write path that does not compute it, and `KEPT_RECOMPUTE` only for a document Postgres accepted that
  the function cannot read — both Mason bugs; the DETECTOR (`check`, every `CHECK_EVERY` reviews, and every swap)
  counts both, fills the unset, and a marked row turns the path's reads to `CASE WHEN col IS NULL OR col =
  KEPT_RECOMPUTE THEN <the call> ELSE <from the column> END` (the generation moves) until none is left. Never read a
  column alone while `marked` > 0.
- **A fill is weighed against the reads that ask for it** (`decide`; the test server: one 3.5 s read of a 7-day
  window started a 1 h 34 min, disk-bound fill of 196.5 M rows): its cost is ESTIMATED (`estimate`) from the rate the
  last fill of the same JSON column measured (`filled` on its ledger row: the rows its chunks filled and the seconds
  they held the writer; one of at least `MEASURED_MIN_ROWS` rows over a table at most `MEASURED_SPAN` times as big),
  else MODELLED from the column's bytes ON DISK a row (`pragma_storage_info`'s blocks over its rows, `fillEstimate`,
  13 µs + bytes / 120 a row), never from its text's length alone, which priced the server's fill 5.6× low; a column
  not on disk yet is priced by its text. Under `SMALL_FILL_SECONDS` (60) a path is stored after 3 statements or one of
  1 s, else only after 3 statements whose reads took a tenth of the estimate in all within the request log's window. A
  path the cost holds back is a `waiting` row with the estimate and what would store it; every estimate says which it
  is (`basis`: measured, disk, text), and `mason status` says it. Never a fill without its estimate on the row.
- **A review never waits for a fill** (`fills`): it runs on its cadence whatever a fill is doing, re-reads the request
  log, rewrites each waiting row's evidence and estimate, and decides; a path decided while one fills has its column
  added (between the fill's chunks, on the writer's turn) and is `queued` behind it — one fill at a time, the first
  added first, so the writer never holds two fills' chunks and each chunk stays one short transaction. (The test
  server: one review filling for an hour left the waiting rows an hour stale, and a path that qualified was stored only
  at the next start.)
- **A hidden column is never listed**: a statement that lists a table's columns without naming them (`*` over a table,
  `t.*`, a NATURAL JOIN, a whole row) reads the copy's view of its visible columns (`__mason_visible`, `hideKept`), and
  every copy served has that view. PGlite's catalog never has the column (`schemaBuilt` reads the copy's recorded
  columns), and nothing else may `SELECT *` a copy into an answer.
- **A jsonb's order is stored as a read like a path's** (`ORDER_STEPS`, src/duck/kept-route.ts; the PR's measurement:
  `ORDER BY j LIMIT 100` over 20 M rows, 19 s by the key's function under C and 83 s under libc, 0.14 s from the
  stored key): the rewrite records `ORDER BY` / `GROUP BY` / `=` of a copied jsonb column as a read (`keptKey`), the
  policy weighs it as any path, and the column (BLOB) holds the key by the functions the statement's key calls
  (`JSONB_KEY_FUNCTIONS`, their `_stored` twins answering NULL where the key raises: the row is marked, its read
  raises). **A key is its bytes' inputs'**: stored as `ORDER_STEPS:<id>` (`orderId`: the collation, a libc order's
  content hashed, `KEY_VERSION` and `DUCKDB_VERSION` — bump `KEY_VERSION` with any change of the key's bytes); until
  the listener tells the collation (`orderBy`) a write leaves it unset and no plan reads it, then the unset rows are
  swept, a chunk a writer's turn, and it is ready; another id's is dropped. **A mark is never read as a value**: a
  stream or a poll may write a marked row after the count (a libc string the order does not cover), so the exact read
  raises at a mark by the column alone (`markedError`: the gap for a libc key, else a Mason bug) until the detector
  counts it and turns the reads to the CASE. A statement that lists the columns (`*`) reads none, so
  its sort computes the key per row. `tests/duck-json-columns.test.ts` holds the key to the function under C, ICU and
  libc and every write path to it; `IT_ORACLE_JSON_PATHS=eager` reads every jsonb sort from it; `tests/duck-plans.test.ts`
  holds the plans, computed and stored (no row handed a function from the stored key). **A stored key saves the calls,
  not the scan**: DuckDB 2.0 pushes no top N's filter into the stored key's scan through the mark's CASE (the fixture
  holds it), nor into the bare BLOB column's (measured once, DuckDB 2.0, 2026-10-29; no test holds it), so a page by a
  jsonb still reads every row's key (cheap) — never count on its pruning. ("The plan fixture")
- **Under a libc collation a jsonb's equality is a SECOND stored key, the C key** (`EQUAL_STEPS`, src/duck/kept-route.ts;
  `equalId`, src/duck/kept.ts: `equal:` and the C order's id, so `KEY_VERSION` and `DUCKDB_VERSION`, never the libc
  order, which the C key does not read): GROUP BY / DISTINCT / count(DISTINCT) / PARTITION BY / = / IN / a join on `=`
  record it as a read (`equalKey` → `keptKey(e, EQUAL_STEPS)`), weighed, filled, swept, marked, dropped and read exactly
  as the order's key, by every write path (`valueSql`). It never marks a libc-uncovered string (the C key covers every
  string), so a mark of it is a Mason bug (XX000), never the gap. **Under C and ICU no second column is ever made**: the
  order's key equates there, so the keeper folds an equality read into the order's (`own`) and drops a C key at
  `orderBy`. `mason status` names each: `GROUP BY j (its jsonb equality …)` beside `ORDER BY j (its jsonb order …)`.
  `tests/duck-json-columns.test.ts` holds both kinds through every write path, every equality form to PGlite, and the
  lifecycle; the eager oracle under libc reads `public.jorder`'s equality from it.
- **A stored read of a kind this Mason does not know is inert, never fatal** (`knownSteps`, src/duck/kept-route.ts): a
  request log's read of it is not counted (`readOfKey`), its ledger row is dropped at the start with its column and
  said with its steps (`open`), and `pathText` says it raw. A new kind of stored read is added there (the release before
  `equal:` broke its status and every write of the table on one). `tests/duck-json-columns.test.ts` holds it with a
  made-up kind `future:x`. ("jsonb's order", "Rolling back past it")
## What is not supported, and how the list stays true

- **An allowlist, not a blocklist**: DuckDB answers only a statement whose every resolved piece is in
  `src/duck/verified.ts`, which the oracle regenerates (`UPDATE_VERIFIED=1`) from what it answered exactly; anything
  else is refused naming the piece (0A000, `Mason gap unverified`). **A piece is as wide as every statement that
  uses it**: one the oracle verified over its scalar forms answers the others too, so a new piece added by
  `UPDATE_VERIFIED` is read in the diff for the forms it unlocks, and a form not exact is refused by name in the rewrite
  (ARRAY(SELECT …) of a numeric, an array, a row: `array-subquery-element`).
- **Every refusal names its entry**: `Unrewritable` takes a `GapId` from `src/duck/gaps.ts`, so a refusal without one
  does not compile; `docs/SQL-SUPPORT.md` is rendered from the registry, and `tests/duck-gaps.test.ts` fails when it is not.
- **No dead entries**: the oracle fails when a `refused` or `differs` entry is met by none of its statements
  (`oracle/gap-cases.ts`), so an entry no longer true is removed, not left to mislead. ("What is not supported")

## The copy

- **Heap order, no index** (`src/duck/sync.ts` `copy`):
  every copy holds its rows in the order the source's scan delivers them, with NO PRIMARY KEY, UNIQUE or index
  (`duckdb_constraints()` empty for it). In key order every time-window query on the test server scanned all 195 M rows (a
  random uuid puts each day in every row group), the copy took 56 minutes and three times the table on disk, and the
  index (~21 GB of 53) had to be resident for any write of random keys. ("Heap order, no index")
- **Smallest first** (`copyOrder`): copies are queued, and taken from the queue, by the catalog's row
  estimate (unknown last, ties by bytes then name), a copy again included. On the test server three small tables (776, 15 k and
  22 M rows) waited the whole 23 minutes of a 196 M-row copy before they were current.
- **A copy is a sequence of CHUNKS that resumes** (the test server's copy could not step aside, and one that
  failed at 90 % started from zero, re-reading the source replica — ~738 GB over the day's attempts): the side table
  `<table>__mason_copy` (no key) is filled a range of heap pages at a time (sized by time, next bullet),
  each chunk a passthrough read (`pq`) of `ctid >= '(p,0)' AND ctid < '(q,0)'` (a TID range scan, never an ORDER BY
  there; the last chunk open-ended) appended in a DuckDB transaction of its own with ITS OWN row in
  `_mason.copy_chunks` (its page range, rows, the source's filenode; keyed by source and first page), COMMITTED — what
  the copy was begun with (first snapshot, columns, exact numerics, pages) is `_mason.copy_progress`, written once in a
  transaction of its own; then swapped in on the writer's turn (`swap`, which removes both) and caught up (`catchUp`).
  A copy that died (a crash, `mason stop`, a failure) continues with exactly the ranges no chunk committed
  (`chunksToRead`) when its columns are the same, said; a stop rolls back only the chunks in flight, and a copy that
  ends before any chunk committed keeps nothing. `rowsSoFar` is the committed chunks' rows (exact). Step 0 (`recopy`) is
  one transaction on one connection and does not resume. Never go back to one statement, add a key, a sort or an
  `ORDER BY` on the source without measuring again.
- **A chunk is sized by the TIME it takes here, never by a row estimate alone** (a laptop copying a
  20 M-row table over the internet showed `0 of ~20,126,276 rows` for minutes, then jumped 27 %; `nextChunkPages`,
  `nextRate`): the estimate's ~2 M rows (`COPY_CHUNK_ROWS`, `chunkPages`) is only the CEILING; a copy's first chunks are
  a tenth of it (at least `COPY_CHUNK_MIN_PAGES`), and every later one is what one reader reads in
  `MASON_COPY_CHUNK_SECONDS` (1–300, default 12; `copyChunkSecondsOf`) at a moving average of the rate its committed
  chunks measured (pages, rows and bytes a second, from BEGIN to COMMIT; quick to shrink, slow to grow), re-sized at
  every chunk taken. Why: the test
  server's 2 M-row chunks were ~6 s, the same rows over a WAN minutes, and a chunk is the unit that commits — what a
  stop reads again and what `mason wait` can count. Each chunk is cut from what no committed chunk covers (`copyGaps`,
  `takeChunk`), so a resumed copy reads exactly its uncommitted ranges whatever size its chunks were.
  `tests/duck-copy-order.test.ts` holds the sizing, `duck-poll.itest.ts` a copy whose reader slows half way.
- **A copy's progress is rendered between commits** (`CopyLive`, `copyProgressNow`, `CopyState.progress`): the chunks
  done and about how many in all, the ones reading and how long the oldest has, the readers' measured rate and the time
  the pages left take at it, and the rows the chunks in flight have read by now at that rate, each held under 90 % of
  its expected rows (`READING_SHARE_CAP`) so a commit moves the count forward. Its SHARE is of the heap's pages read
  (`share`), never of the rows: the ranges are exact and the row estimate is Postgres's, which a copy can outrun (23.7 M
  rows under 20.1 M sent the bar back to 0 %), and a share derived from an estimate must never move backwards.
  `mason wait` and `mason status` render it (`copyingText`, src/cli/commands.ts); the rate is the sync's, never a
  client's count over polls.
- **A copy reads `MASON_COPY_PARALLEL` chunks at once (1–8, default 3; `COPY_PARALLEL`, `readChunks`), each on a DuckDB
  connection of its own, so ONE backend on the source each — never the attached scan's ~10** (keep the load on
  Mason's side: overloading the source Postgres is the last thing Mason may do). One reader is one backend's
  throughput: on the test server's read replica a 2 M-row chunk of a table with two wide text columns took 6.1 s, 0.6 s of it the
  TID range scan and the rest that backend detoasting, formatting and sending at ~150 MB/s, so one reader took the
  22 M-row table 72 s against the attached scan's 28 s. The readers append to the ONE side table side by side (DuckDB 2.0
  lets transactions append to one table at once; `tests/duck-copy-order.test.ts` holds it — if it ever conflicts, each
  reader needs a side table of its own that the swap UNIONs ALL) and commit out of order; a chunk's range is a row of
  its own, never an update of one progress row (two readers updating one row would conflict), and the key refuses a
  chunk committed twice. Every chunk is held to the first snapshot and checks the filenode whichever reader reads it
  (the first file a chunk reads is the copy's). The first reader to fail — a rewrite, an error, `mason stop` —
  interrupts the others (`interruptible` per connection, `copyLanes`, re-sent every 50 ms) and none commits after it.
  A chunk's size does not grow with N (docs/DESIGN.md "Chunks read N at a time" says why). Raise N only against
  the source's own headroom, never past 8 (the extension's pool is 15 connections, the writer's poll among them).
- **Every chunk is held to the copy's FIRST snapshot** (`xminBeforeSql`, src/cdc/poll.ts: rows written before its xmin,
  the complement of the catch-up's `xmin8Sql >= watermark`): each DuckDB transaction is a new Postgres snapshot, and
  without the hold a row updated between two chunks is read twice (its old version from an early page, its new one at
  the heap's end; 250 keys of `duck-poll`'s resume test) or missed. Written with `age()`, never a text cast of `xmin`
  (the casts cost the source 5× a scan's CPU). It is exact only while no table rewrite (VACUUM FULL, CLUSTER, TRUNCATE,
  a type change: rows MOVE between pages) happened since the first chunk and fewer than 2^30 transactions ran: the
  table's `pg_relation_filenode`, read after each chunk under the lock its read still holds, and the snapshot's age are
  checked, and either starts the copy over from page 0, said. The swap asserts as many distinct keys as rows (a failure
  is a Mason bug: not swapped, copied again).
- **A passthrough read (`pq`) names its columns through `pgColumnSql`**, the copy's chunks and the poll alike: an exact
  numeric as text, and as `text[]` a citext[] / inet[] / json[] (`KEPT_ARRAYS`) and an enum array (`enumLists`, by its
  stored type) — `postgres_query` hands each over as one VARCHAR DuckDB cannot cast to the column (the
  oracle's enum array failed to copy, and a poll of a changed one had always failed).
- **A write by key is a DELETE of its keys by ONE join against the table's key column, then an INSERT** (`writeByKey`,
  `writeStaged`, `deleteKeys`), in the piece's one transaction; an unchanged-TOAST update is ONE `UPDATE … FROM` per set
  of carried columns (`updateCarried`). Never `INSERT OR REPLACE` (it needs a key constraint) and never a statement per
  row: each is a scan of the key column — 4 ms a 10,000-change piece on 1 M uuid rows, 0.35–1.8 s on 195 M, tens of
  seconds on the test server's disk — so a stream batch that changes a table over `BIG_TABLE_ROWS` is applied by time as well
  (`applySize`: at most every 5 s, pieces of up to 50,000). A bigserial key prunes (heap order puts its zonemaps in order).
- **What heap order gives up**, said as such: a wide uuid-keyed table's click takes seconds, a point lookup by a random
  uuid is a scan, and uniqueness is the write path's (the oracle holds every copy to the source), not the engine's. The
  later step is a sort by a declared time column once the sources file names one.
- **A copy in the old layout is RETIRED** (`RETIRED_LAYOUT`): a copied table with a primary-key or unique constraint was
  stored in key order with its index. `open` says it by name, `mason status` / `wait` say it on its
  line, it serves as it was, and it is copied again through the normal path (`needsCopy`) — never converted in place:
  its rows are sorted on disk, and only the source has them in its own order. The ledger's re-sort columns are dropped
  and a stage file left beside the copy is removed, said.
- **A failed copy backs off** (`copyRetryDelayMs`: four times the attempt, at least 5 minutes, doubled per failure in a
  row, at most 6 hours; at once after a restart or a column/key change) and then CONTINUES with the ranges no chunk
  committed (its committed chunks are kept), and `mason stop` interrupts the chunks in flight, rolled back, never
  failing it. A table removed, or whose columns changed, loses its side table, progress row and chunk rows.
- **Nothing yields to BI queries between chunks**: the listener keeps no count of statements in flight
  that the sync could read, so none was invented; DuckDB has no per-connection thread or priority control (`threads` is
  GLOBAL in 2.0, "cannot be set locally"). A reader is one Postgres backend and about one DuckDB core: beside one, a
  DuckDB query took ~1.2× its time alone, where beside the old one-statement scan (~10 backends) it took 4–6× (3 M rows;
  "The copy in chunks"); at N = 2–4 readers a query on the SOURCE took ~2× its time alone and a DuckDB one ~1.2–1.7×,
  and at N=3 the copy took the attached scan's time (4 M wide rows: 32–40 s against 29–41 s; "Chunks read N at a time").
- **The catalog serves a table the moment its copy commits**, on a DuckDB connection of its own that no copy's
  transaction holds (after a restart it was empty for hours behind a large copy).
- **The run never downloads an extension** (src/duck/extensions.ts; docs/DESIGN.md "The copy's extensions ship with
  Mason"): `postgres` and `inet` come from this platform's `@mason-data/extensions-<platform>` package, the instance's
  `extension_directory` with autoinstall off; DuckDB's INSTALL runs only where no package is found, said with the
  reason. A new extension the engine needs is added to `EXTENSION_NAMES` and pinned in `cli/extensions.json`, never
  left to an autoinstall; a DuckDB upgrade is `node cli/extensions.ts --pin` and its diff read.
  `tests/integration/extensions.itest.ts` holds a copy and an inet cast with HOME empty and the package read-only.
- **Read-only on the source**: a scan through a `READ_ONLY` attachment, SELECTs only, never an `ORDER BY` there (a sort,
  or an index walk, of the source table).

## Memory and the machine (so Claude is aware of it)

- **DuckDB's memory limit is HALF the machine's RAM by default** (`DEFAULT_MEMORY_LIMIT`, `src/duck/store.ts`;
  `MASON_DUCKDB_MEMORY` overrides it, `8GB` / `512MiB`), and it shares ONE process with V8's heap and two PGlites —
  DuckDB's own 80 % let the system kill the sync and every session together. On a dedicated box half is
  conservative; on a laptop a large copy and a BI query starve each other. What cannot spill fails ITS statement with
  53200 and a hint naming the variable; the run goes on.
- **A sizing decision reads `store.memoryLimitBytes`**, never `os.totalmem()` or a constant: the operator may have set
  the limit. (The copy needs none since it has no sort, "The copy"; its chunks are sized in pages, by time.)
- **A copy shares that limit with the stream, the polls and the BI queries** (it runs beside them):
  what does not fit beside fails its own statement, is said, and is tried again.
- **What a copy costs the queries beside it is PAGE-CACHE EVICTION, not CPU** (measured on the test server: buffered
  writes evicting the cache took a 1 s weekly chart to 8 s and a 0.3 s count to 9.9 s, where a CPU-only load cost +85 %
  and O_DIRECT writes nothing): the copy writes into the very file the queries read. So bound what a copy has in flight
  (its chunks) before reaching for CPU priority (which recovered only about half of the smaller cost); measure a change
  to the copy's write pattern on the test server, whose page cache is smaller than its table, never on a laptop whose is not.
- **A query over a WIDE column is bound by the disk when the working set does not fit RAM, and JSON extraction over a
  text column is slow.** On the test server (m7g.xlarge: 4 cores, 15 GiB, EBS at 125 MB/s) a 28 GB table cannot be cached, so
  anything touching its two JSON payload columns reads at disk speed: a count of rows whose payload has a given key
  (`payload->>'key' IS NOT NULL`) over 22 M rows took 93.5 s on DuckDB against 15 s on ClickHouse. So size a machine's
  RAM to the working set, never promise ClickHouse's speed on a JSON path, and the later remedy is extracting the hot
  JSON fields into columns. ("What stands between this and production")
- **Strings are stored ZSTD, forced on the instance** (`INSTANCE_SETTINGS`, `src/duck/store.ts`): DuckDB's
  analyzer never picks ZSTD by itself and left a copied table's JSON text column Uncompressed — 0.66 GB a million rows
  on the test server, 0.26 forced, a text sample 4.5× smaller — while integers, UUIDs and timestamps keep their own
  methods. A copy's size is measured with it on; the read cost of a ZSTD column is not measured yet.
- **A copy that would fill the disk is stopped before it does** (`copyDiskProjection`, `src/duck/sync.ts`): once an
  attempt read 1 % of the heap, what the pages left would add (from what its pages added to the file and its log) is
  held to what is free where the file is; past it the copy FAILS with the way out (free disk, `mason remove`, `mason add
  --columns`), its chunks kept, and is tried again as a failed copy is — at the retry, or at once at the next start.
  Nothing warns before 1 %; a table whose late pages are wider than its early ones is under-projected. What the check
  last projected is kept on the copy's live state and said, never computed a second way (`diskStatus`: `/api/state`
  `disk`, `mason status`'s Disk line, beside the bytes free by the same `diskFree`).

## Keeping a copy current

- **A copy runs BESIDE the stream and the polls, never instead of them** (one 195 M-row copy stopped
  every other table's freshness, and held the slot's WAL, for 35 minutes): on a DuckDB connection of its own
  (`rebuilder`), one rebuild at a time (the memory limit is one), writing only its table, side table and ledger rows. A pass never stops the stream; `stop` stops all of it. ("A copy beside the stream")
- **Everything else that writes takes a turn on the writer (`onWriter`)**: a statement on a connection lands inside
  whatever transaction is open there, so the stream's batches, the polls, the source's attach/detach (instance-wide,
  counted per user) and every rebuild's SWAP (a DROP under another transaction's write fails its commit) each wait for
  the one before. A turn never queues another and waits for it: it would wait for itself.
- **A rebuilt table is caught up by ONE poll from its watermark before it is kept current again** (`_mason.catch_up`,
  written with the swap): skipped by the stream and the polls until then. In replication mode the stream HOLDS its
  changes from just before that poll and applies them after it — the stream acknowledges what it skips, so a table
  joining late is missing exactly what that poll reads (src/duck/stream.ts "why replaying is safe"). A table whose sync
  is `off` is caught up too: one scan per rebuild, then served as of it.
- **A stream change is written as the COPY's columns, never the publication's or the sources file's of the moment**
  (`Sync.asCopied`, the copy's own column list, set at its swap; `projectTuple` in src/duck/stream.ts): a column the
  publication sends and the copy lacks is dropped, and every write — a batch, the held changes, `updateCarried`, a delete
  by key, the catch-up's poll — names only the copy's columns; changes decoded in another shape are never applied to a
  new copy (its snapshot holds them). The sources file changes while a copy runs: the test server's 22 M-row table once had a
  column removed and restored mid-copy, and the held changes were written naming a column the new copy lacked (`Binder
  Error`). A relation that stops carrying a column the copy holds (a DDL, a narrower publication) refuses THAT table by
  name with the way out, marked behind before anything past it is acknowledged; the others stream on.
  ("Logical replication")
- **A table is never left neither streamed nor copied**: after every rebuild, a table that still needs a copy or a
  catch-up gets a pass at once (`followUp`; a change of its columns during its copy re-copies it at once), or when its back-off
  ends (`wakeAt`) — replication mode runs a pass only when kicked, and on the test server a failed catch-up left that table dead
  for good. A failed catch-up backs off as a failed copy does (`backOff`, `copyRetryDelayMs`), its whole error and next
  attempt said in the log and `mason status` (`catchUp.retryAt`). ("Logical replication")
- **A multi-line reason is ONE log entry**, its further lines indented (`textEntry`, src/lib/log.ts: the
  run's log, mason.log, is written through it, src/cli/dev.ts) — the test server's Binder Error was read as its first line.
- **A table being caught up holds its decoded changes in Node's heap** until its catch-up poll ends (`held`, `catchUp`):
  unbounded for a migration's transaction during a long catch-up. Known, not fixed ("What stands between this and
  production").
- **The poll is ONE DuckDB transaction per table over ONE source snapshot**, its rows and new watermark committed
  together (`_mason.poll_state`), so a poll that dies is read again; it costs the source a full scan per table (no index
  covers `xmin`). ("The poll")
- **How often a table is polled is ITS `sync:`, never the run's** (src/lib/table-sync.ts; one 22 M-row table and a
  776-row one shared one interval, and a row limit in the run left the big one never polled, said only on its line):
  `off` (the default) is read again only at `mason sync`, `poll <interval>` at that interval, 1 s to 24 h. ONE pass loop
  polls the tables due (`dueAt`), never a timer a table; a table's next poll is its interval after its last, stretched
  to four times that poll's time (`nextPollAt`), and the passes to four times the last pass (`passDelayMs`). The sync a
  table was last polled or copied under is `_mason.poll_state.sync`: a change (live or made while Mason was down) keeps
  the copy and catches it up by ONE poll, logged, never a copy again. The engine never decides by size: the row count
  is `mason add`'s (src/cli/source-edit.ts), which writes `sync: off` for a table over `BIG_TABLE_ROWS` under a file
  that polls, and warns a poll of over `COSTLY_POLL_ROWS` under a minute with its estimate and basis. A setting that
  sets an interval for every table (`MASON_POLL_MS`) refuses the start. DETECTOR: `kept` on every table's line
  (`mason status`, `wait`, EXPLAIN, the MCP tools) says its sync and its copy's age; `tests/duck-sync-schedule.test.ts`
  and `tests/integration/duck-poll.itest.ts` hold the schedule and the switch. ("Each table's sync") A pass is ONE
  attachment of the source (`attach` / `detach`: a new connection on the database), so at `poll 1s`, the floor, a
  table costs the source a connection a second beside its scan; holding the attachment across close passes is a later
  step, measured first.
- **Replication has no gap, by construction**: a table is copied only after the publication carries it and the slot
  exists, joins the stream only once caught up, and a key's changes replayed in commit order end at its state whatever
  they start from; a slot new to the copy is caught up the same way, by ONE poll from the watermarks, never a fresh
  copy. (`src/duck/stream.ts`; "Logical replication")
- **A batch is committed before it is acknowledged**: whole transactions applied in one DuckDB transaction with the
  position they end at (`_mason.stream_state`), and only then sent to Postgres; a run that dies between skips what its
  record says it applied.
- **The stream says when a table joins or leaves and where it is; a stream that is silent is a bug** (the
  test server's first run printed one stream line in 35 minutes and `mason status` showed no position): a join and a leave are a
  line each with the position, found in ONE place (`refreshStreamed`), never a line per batch; a periodic line at most
  once a minute when something moved (`reportStream`); `mason status` / `wait` / `--json` show the position, the
  database's (a connection at most every 5 s, never the keepalive's: that is the walsender's read position), the lag in
  bytes and as the newest change's age, the WAL the slot holds on the database (`stream.slotWal`: one row of
  `pg_replication_slots` on that same connection, at most every 30 s, `SLOT_READ_MS` — its status, and the cap left, or
  that `max_slot_wal_keep_size` is unset and nothing caps it), and each table's state and changes applied
  (`streamStatus`). A new state of a table is a state there too. ("Logical replication")
- **A table is streamed only when its `sync:` is `replication`; the others are polled beside the stream, or `off`**
  (`Sync.replicated`, `Sync.streams`): one slot and ONE publication per project, the publication carrying the
  replicated tables ALONE — Mason's own `SET TABLE` to exactly that list, verified against `pg_publication_tables`
  afterwards (a polled table's writes in the slot's WAL are WAL held for nothing), a named one never altered. A `key:`
  table and a `REPLICA IDENTITY NOTHING` one under `replication` are refused at the file's read with the line to write
  (`entryProblems`; the stream cannot apply a keyless change, and publishing NOTHING fails the app's own UPDATEs).
  A sync change keeps the copy in every direction: into replication it is marked behind in `_mason.catch_up` and caught
  up by one poll while the stream holds its changes; out of it, it leaves the stream and is caught up by one poll.
  `mason start --replication` / `--poll` / `--publication` and `MASON_CHANGES` are gone: each answers with the line to
  write in the sources file, starting nothing (`removedStartFlags`, `changesRetired`, src/lib/table-sync.ts). **A table set to `replication` while the run is
  up, in a run that never checked the database for it, is held to the start's own checks first** (`checkReplication`,
  src/cli/dev.ts; `liveReadinessFailure`): refused with what the database lacks and the line that polls it, the file put
  back byte for byte — a review finding: on `wal_level = replica` the add said success and the table, polled until then,
  was frozen for ever; the engine's own failure to set replication up says the same way out on the table's line.
  DETECTOR: `tests/integration/duck-stream.itest.ts` (a mixed project, the publication's list, a switch each way held to
  the ledger), `tests/cli-run-server.test.ts` (the live refusal). ("Each table's sync")
- **The slot outlives `mason stop` and holds the source's WAL** (said at the stop); it is dropped, with Mason's own
  publication, VERIFIED gone, when no table's sync is `replication` any more (`retireReplication`: at the start, and live
  when the last one leaves) and at `mason destroy`, from what the config records (`config.replication`).
- **A NAMED publication is read and verified, never created, altered or dropped; Mason makes its own only when none is
  named** (a read replica takes no CREATE PUBLICATION, and on a production primary the slot is the one
  object Mason creates). Named by `publication:` at the top of the sources file (`${PG_PUBLICATION}` allowed, read by
  `readSource`), else `PG_PUBLICATION` (`namedPublication`) — never the one a
  start recorded, so a file that takes `publication:` out gets Mason's own; Mason's own one left behind by a switch to a
  named one is dropped, verified gone, before the record moves (`staleReplication`); verified by the ClickHouse reader's own `checkPublication` (src/duck/publication.ts), never a
  second verifier. A gap in one table refuses that table alone, the others stream on; the way out is the found
  publication plus the gap as `ALTER PUBLICATION … ADD TABLE …`. On a standby a named one is required, refused before
  any slot is made. ("Logical replication")

## The request log

- **Every statement DuckDB answered and every refusal is a row of `_mason.requests`** (a refused statement in
  `Session.refuse` alone, the one sender of a statement's ErrorResponse) (every request is
  recorded in an ops schema in DuckDB, so a failed one can be debugged later — a BI tool met an error on the test server
  and nothing could be found afterwards; the run passed `record: () => undefined`). The listener builds the row
  (`recordRequest`, src/api/postgres/server.ts: SQLSTATE, message, DETAIL, HINT, rows, session, application_name, a
  token's NAME, never the token, a `mason user`'s name and its ROLE), `RequestLedger` (src/duck/requests.ts) writes it in batches on a connection of its
  own — never the sync's writer turn — and keeps `MASON_HISTORY_DAYS` days (7). A failed write is said once and
  fails no statement. `mason logs --requests` and `mason status` read it through the run's command server, never the
  file. **Its order is `started_at`, then `seq`** (the row's number in arrival order, continuing across restarts):
  `request_id` is a random uuid and the clock a millisecond, so a refused login and the statement before it read back
  in either order until a number broke the tie; a page's cursor is that order's position (`requestCursor`). **An
  outcome is ONE rule** (`outcomeOf`, src/api/request-log.ts: ok, refused, failed, cancelled = 57014), read as SQL by
  the ledger's filters and summary through `outcomeSql`, held equal code for code by tests/duck-requests.test.ts. Every
  row carries the bytes the listener sent for the statement (`bytes_sent`), and a refusal by a registry entry its id
  (`gap`): taken from the error as the refusal was built (`gapRefusal`, src/api/postgres/server.ts; an `EncodeError`'s,
  `NumericError`'s or `Unsupported`'s own `gap`), read from the text (`gapIn`) only where a refusal crossed DuckDB as
  its message (src/duck/store.ts `pgErrorOf`), and carried across the executor's worker (`WireError`); a re-wrap of an
  error keeps it (tests/duck-wire.test.ts holds every path). `unsupported` groups by it (`/api/unsupported`, `mason
  status`). ("The request log")
- **Every sync failure is a row of `_mason.sync_events`, kept as the request log is** (src/duck/events.ts: a failure
  was kept only as a table's CURRENT error, wiped by the next success, and earlier ones only in the log file): the sync
  says each where it logs it (`Sync.event`: copy, poll, catch-up and stream failures, the database out of reach, a copy
  finished, a table current again — the last detected in `record`, the one place an error is cleared — and a sync asked
  by hand, `synced`, in the words mason sync answers: a scheduled poll that succeeds is no event, and without it a
  person who synced read the list as a sync lost), `SyncEvents`
  writes them in batches on a connection of its own, never the writer's turn, a failed write said once and never
  failing the sync; a failure repeated word for word within an hour is one event unless it was over between — a
  table's when it is current again (`recovered`) or copied anew (`copied`), the whole sync's (`table: null`) when the
  sync says so (`recovered` of no table: the stream applied a batch WITH A POSITION, the publication and slot were made
  ready, the database attached — `wholeFailure`); never a failure whose end nothing says. **A copy's replication error
  is over only when the stream applies a batch with a position** (`applyChanges`: every table it keeps current is current
  as of it), never at a pass's publication check (`settlePrepared`, which runs while the stream waits out its back-off)
  nor at a piece of a large transaction; the check clears only what it owns — a named publication's gap once the table is
  carried again, and its own failure on a table never copied.
  The supervisor's restarts stay in `.mason/restarts.json` (a process of its own cannot open the file) and are merged
  when read (`withRestarts`). `mason logs --events` and `mason status` (`recentErrors`) read them through the command
  server's `/api/events`.
- **Usage over time is a row of `_mason.usage` a minute, and each copy's own bytes a row of `_mason.copy_sizes` every 10
  minutes, kept as the request log is** (src/duck/usage.ts `UsageSampler`; the run had only the moment): on connections
  of their own, never the writer's turn, a failed take or write said once and never failing anything (a sample not
  taken keeps its counts for the next). A sample computes NOTHING a second time: the copies' facts are `/api/state`'s
  at that moment (`usageFacts`, src/cli/run-server.ts), the statements are counted as the listener records them (the one
  `record`, by the summary's rules: no CONNECT, `outcomeOf`, the completed ones' `quantile_cont`, held equal to DuckDB's
  by tests/duck-usage.test.ts) — so a statement is in the interval it ENDED in, which a query by `started_at` would miss.
  An interval keeps at most `DURATIONS_KEPT` completed durations (a sample not taken carries its interval on, for as
  long as samples fail): exact up to it, a uniform reservoir past it.
  The copy's memory is `duckdb_memory()`; a copy's bytes are its distinct blocks from `pragma_storage_info`
  (metadata only, but it grows with rows × columns, so never per request; docs/DESIGN.md "Observability" has the
  measurement). `mason usage` and `GET /api/usage` read them.
- **A copy's `rows` is its count after every write that changes it** (`CopyState.rows`): the copy's own count at the
  swap, the poll's reconciled count at its commit, and after every stream batch the rows its writes inserted less the
  rows they deleted (`rowsChanged`, `writeByKey`) — never a `count(*)` per batch (a write by key's deletes make it a
  scan) — written to `copy_state` IN the batch's transaction. When it was last brought current, and how,
  is `CopyState.synced` (`Synced`: the swap, a poll's commit, the stream's last batch); `/api/state` derives each
  table's state in one word (`syncStateOf`, src/cli/readiness.ts) and its age at the moment asked.

## Users (`mason user`, src/duck/users.ts)

- **A user's password is `mason_<id>_<mac>`, the MAC over its NAME and id keyed by the API key** (the
  server plan's item 1): the startup packet's user name must be the user's (28P01 with the reason otherwise), so every
  statement is attributed (`user_name` in `_mason.requests`); rotating the API key removes every user. A password of
  another shape is a token's, read as before (`listenerLogins`, the one wiring the run and the tests use).
  ("On a server")
- **A user's `role` is a field of its row** (`MasonUser.role`, `mason user add --role`; the roles file is `src/cli/roles.ts`,
  its enforcement `.claude/rules/postgres-api.md`), read with the user before every statement, so a role given or taken
  applies at the next statement.
- **The live users are a FILE, `.mason/users.json`, never DuckDB** (`mason user` runs beside the process holding
  DuckDB's file lock): no secret in it; changed under a lock file and renamed into place; the listener stats it at every
  connection and before EVERY statement of a user's session (`recheckMs: 0`), so a removal takes effect without a
  restart. Fail closed: a file that cannot be read refuses every user (57P03), never "live"; no file is no users.
- **A removed user is KEPT in the file with `removedAt`** (the list shows Active / Removed): only entries without one are live,
  and the listener (`LiveUsers`) reads only those, so a removal refuses as before; a removed name can be added again (a new
  id); `mason user list` gives each user `lastUsedAt` (`RequestLedger.lastUsed`, within the user's own window) and its URL
  without the password (`connectionUrl`, the one builder).
- **A disabled user is KEPT with `disabledAt` and its id** (`mason user disable`): `LiveUsers` still holds it, so its
  login is judged whole first — a wrong password stays 28P01 — and only then refused `user_disabled` (the listener's
  28000); its sessions end at their next statement; `enable` deletes the field, so the same password connects again.

## Testing

- **The oracle is the arbiter** (`tests/integration/duck-oracle.itest.ts`, `IT_ORACLE_ONLY=<regex>` for a subset): every
  statement asked of a real Postgres and of the endpoint, after the copy and after two rounds of changes, and again in
  six shapes (`oracle/shapes.ts`); names, OIDs, text, order and SQLSTATEs must be equal. A fix for a class adds a
  statement to it (`postgres-cases.ts`, `oracle/bi-shapes.ts`, `oracle/type-matrix.ts`, `oracle/gap-cases.ts`). The
  sessions are in UTC; a type-matrix statement with a `zone` is asked with both sessions' TimeZone set to it (a time
  computed in the session's zone must be held in a zone with daylight saving, not UTC alone). Run it against a Linux
  Postgres (CI's `postgres:18` image): a macOS cluster's libc collation is not glibc's, and its `coll` statements differ.
- **It needs a disposable Postgres, `IT_POSTGRES_URL`** (a database of its own is created and dropped; `duck-stream` needs
  `wal_level=logical`, the oracle and `duck-poll` any; `tests/integration/README.md`), never a shared deployment's source.
- **The recorded corpus is answered whole offline** (`tests/duck-corpus.test.ts`: every statement psql, pgjdbc,
  node-postgres, Metabase, Grafana, DBeaver and Superset were recorded sending); a refusal a tool meets is in
  `KNOWN_GAPS`, with why.
- **Every fix has a test shown to fail without it** (`scripts/fails-without.ts <commit> <test-file>`), as every
  finding of the review did. Synthetic data only: the BI shapes were RANKED from a real database's saved statements,
  and every statement in the repo is written over the shop.
- **A test that needs something to happen WHILE a copy runs holds the copy** (the Sync's `onChunk` awaiting a promise
  the test releases: `heldCopy`, `tests/integration/held-copy.ts`) and asserts the ORDER of the
  sync's lines, never that a copy of N rows outlasts a poll, a batch or a `setTables`: a copy's time is the runner's (the
  400,000-row copy in "copies beside the polls" took 0.89 s on a CI runner, one poll pass ran beside it, and it failed). Its
  check: the test still passes with the table cut to 50 rows. Release the hold in a `finally` before `sync.stop()`,
  which interrupts DuckDB's statements, never the test's promise.
