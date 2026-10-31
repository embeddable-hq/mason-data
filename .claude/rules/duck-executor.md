---
paths:
  - "src/duck/cancel.ts"
  - "src/duck/executor-worker.ts"
  - "src/duck/executor.ts"
  - "src/duck/functions.ts"
  - "src/duck/store.ts"
  - "tests/duck-executor*.ts"
  - "tests/duck-runner-signal.test.ts"
  - "tests/duck-wire.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## The executor worker

- **EXPLAIN ANALYZE's profile is held to its statement, never assumed its** (src/duck/store.ts `explained`): DuckDB's
  profiler writes the LAST profiled statement's profile on the connection, so it is on for the statement alone (turned
  on in `streamed` after the settle, off before anything else runs), and the profile must name the planned SQL
  (`query.sql`; another's is XX000 "report it"). None written — DuckDB answered while planning, a count(*) of a whole
  table — is said, with DuckDB's EXPLAIN as the plan: the settle's probe of the schemas was once reported as the plan of
  such a count (`tests/duck-wire.test.ts` "own profile"; docs/DESIGN.md "EXPLAIN").
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
  lists the closes). `tests/duck-executor-slow-vector.test.ts` "a vector slower than any quiet window",
  `tests/duck-executor.test.ts` "a call-free statement closed inside a slow vector", "a connection closed under its own",
  `tests/duck-executor-cancel-stress.test.ts` "cancelling a function-calling statement again and again"
  hold it. Any statement on a session's connection waits for `releasing` first: DuckDB would refuse it. ("The watch")
  **Its log line does not wait for that close** (`say`, src/duck/store.ts): a statement's line is posted before its client
  is told it ended, in the worker port's order, so a statement's own line is before its answer and no earlier statement
  it was told of lands after it (a late line entered the next test's window). A statement its client closed
  early (a portal, a session gone) has no end its client hears: its line still comes at its release.
  `tests/duck-wire.test.ts` "logged before its client is told" holds it.
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
  a test that blocks the main thread: `nodeProcess` in `tests/duck-executor-harness.ts` is an async spawn. "the watch" tests
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
