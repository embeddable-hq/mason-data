# Flows

Two maps of what runs, in order, and what waits on what. They say where to look and what happens next; the rules are
`.claude/rules/`, the reasons `docs/DESIGN.md`. A name here is a function or field of the code on `main`. To change
something, start from `docs/RECIPES.md`.

## The threads

| Thread | Runs | Never does |
|---|---|---|
| Main | The listener's sessions, the `Sync` logic, the stream's decoding, the command server | Touches the binding, or runs a Mason function |
| Executor worker (`src/duck/executor-worker.ts`) | The one DuckDB instance, every connection, every `__mason_*` function | Waits for a task that may need this thread |
| libuv pool | The wait of each promise-returning binding call | |
| DuckDB's task threads | The query's work; they queue function calls back to the worker | |
| Catalog worker (`src/api/postgres/catalog-worker.ts`) | PGlite, one request at a time (`PgCatalog.run`), with a deadline per request | |
| Parser worker (`src/api/postgres/parser-worker.ts`) | `parseSql` | |
| Pg-eval worker (`src/duck/pg-eval-worker.ts`) | A PGlite with no tables, started at the first `__mason_pg_*` call: Postgres's own functions over a chunk's values | Waits on the executor worker, which is blocked on it |

Main reaches the worker through `DuckConnection` (`RemoteConnection`) and `DuckRunner` (`RemoteRunner`) in
`src/duck/executor.ts`. Those are messages: a `closeSync` or an `interrupt` on main is posted and returns at once, so the
wait described below happens on the worker.

## A statement

The first steps differ by protocol. From `Session.duckPlan` on they are one path.

### 1. In: the same for both protocols

1. `Session.drain` decodes one message and awaits `Session.handle`. A session handles one message at a time.
2. `handle` sets `asked`, the request log's record of the statement.
3. For a Query, a Parse or an Execute, `stillLive` re-checks the user. A Bind is not checked.
4. `handle` dispatches to `simpleQuery` or `extended`.

### 2. Classified

`classify` calls `Server.schema` first, which replaces the catalog if the copied tables changed. Then `duckTranslate`
(`src/api/postgres/translate.ts`) answers one kind:

- `catalog`: reads only `pg_catalog` or `information_schema`, or no table at all. Forwarded to PGlite.
- `duckdb`: a SELECT over a copied table. Planned below.
- `explain`: `Session.explaining` classifies the inner statement the same way.
- `set`, `set_config`, `show`, `transaction`, `discard`, `deallocate`: the session answers these itself.
- Anything else: `sessionStatement` raises `Unsupported`, a refusal.

### 3. Where each kind runs

| Kind | Simple Query (`runSimple`) | Extended |
|---|---|---|
| `duckdb` | Plan, then `duckAnswer`, then `streamRest` | `parseMessage` plans; `bindMessage` stores the portal; `executeMessage` calls `executeDuck` |
| `catalog` | `forwardSimple`, through `catalogAs` | `parseMessage` prepares it in the sidecar; **`bindMessage` runs it whole**; `executeMessage` hands out the stored rows |
| Session | Answered in `runSimple` | Answered in `executeMessage` |

The extended column has a trap, the last fact below: a catalog statement runs at its Bind, not its Execute.

### 4. The plan

1. `Session.duckPlan` slices the statement's text, reads `grants` and works out the role key, then calls
   `Server.duckPlan`.
2. **`Server.duckPlan`** is the plan cache.
   - `Server.schema` replaces the catalog if the copied tables moved, so a plan is always made over the current one.
   - It clears the cache if the schema, the keeper's generation (`kept.generation`) or the roles moved.
   - The key is `searchPath`, `timeZone`, parameter OIDs, `wireBound`, role and text.
   - **A hit returns here.** Nothing below runs: no analysis, no `enforceGrants`, no check against `verified`.
   - On a miss it calls `DuckOptions.plan` (`DuckStore.listener`), which calls `planDuck`. A plan made while the schema moved
     is returned, not kept.
3. **`planDuck`** (`src/duck/plan.ts`), on main, each catalog read a round trip to the catalog worker:
   1. `analyze` (`src/duck/analyze.ts`): Postgres's analysis. **Refusal point**: Postgres's own error, with
      `missingRelationHint` for a table not synced yet.
   2. `expandViews`: a view is replaced and `planDuck` runs again from the top, on the expanded text.
   3. `enforceGrants` (`src/duck/grants.ts`) when roles exist. **Refusal point**: 42501. The reads stay on the plan.
   4. `resolvedKeys`, then the user types, enums and row types, when the statement uses any.
   5. `keptLookup` and `distinctKeys`: what the rewrite may read from stored columns and key counts.
   6. `rewrite` (`src/duck/rewrite.ts`), below. **Refusal point**: `Unrewritable` becomes `gapRefusal`, or Postgres's
      SQLSTATE where the gap is Postgres's own.
   7. `hideKept`, then `selectListAfterLimit` (`src/duck/late.ts`: a top N or an unsorted LIMIT over joined tables by row number, `joinRows`, else the list after the limit).
   8. **Refusal point**: every key must be in `verified`, else `gapRefusal("unverified", …)`.
   9. `deparseSync`, then `parseSql` and `treeDifference`. **Refusal point**: 0A000 when the text does not read back as
      the tree.
   10. The `PlannedSql` is made, with `functions` from `masonCalls`. The `DuckPlan` carries `fields`, `exact`, `clock`,
       `jsonReads` and `reads`.

`rewrite` is a sequence of passes over one copy of the tree: `volatileWindows`, `adopt`, `nameTargets`, `indexShapes`,
`repeatedKeyCounts`, `exactThrough`, `markBounds`, `markWholeReads`, then the walk (`Rewriter.walk`, which dispatches through
`rule`) and `flattenBool` with `guardFilters`. Anything that decides by looking across the statement is a pre-pass,
because the walk meets a CTE before the SELECT that reads it.

**Row filters** come straight after `enforceGrants` in `planDuck`: a role's `where:` and `through:` are expanded by `expandRowFilters` (`src/duck/row-filter.ts`), the filtered statement is planned again from the top, as a view is, and the role key gains the bound filters.

### 5. Run

1. `Session.duckAnswer` calls `readsOf`, then `heldToRole`: a plan made at an earlier Parse is held to the role of this
   moment. **Refusal point**.
2. `readAside` reads any half-read portal to its end. DuckDB starts nothing on a connection with an open result.
3. `this.running = controller` makes the statement cancellable. For an Execute with a row count, `boundOnWire` has
   already chosen the plan made with `wireBound`.
4. `duckValues`: parameters read by the catalog (`duckParameters`, `readParameters`). **Refusal point**: a value
   Postgres's input function refuses. The `clock` values are written in here.
5. `duckSession` builds the settings, then `RemoteRunner.run` posts `runner.run` to the worker.
6. On the worker, `SessionRunner.run` calls **`SessionRunner.streamed`**:
   1. waits for `releasing`, the last statement's release;
   2. `beginStatement` opens the cancel slot;
   3. `settle` applies TimeZone, search_path and the settings map to the connection;
   4. `prepare`, then the cancel wiring (`cancel`, `release`, `drain`, `close`);
   5. binds parameters as text, then **`p.stream()`**;
   6. builds the `columns`, Postgres's types and names (`pgTypedColumn`), and answers with a `DuckAnswer`.
7. Back on main, `duckAnswer` builds the `FieldDescription`s.

### 6. Rows

- `streamRest` loops `flushPending`, `writable`, `fill`. `fill` calls `DuckAnswer.fetch`, which posts `answer.fetch`.
- On the worker, `fetch` calls `fetchChunk`, then `exactRows` for numerics Mason computes and `encodeRows` for the wire. One
  buffer per chunk is transferred to main.
- With a row count, `executeDuck` reads ahead by one chunk to know whether to send `portalSuspended`. The portal keeps the
  open result, and a suspended one's request-log row is written by `dropPortal`.
- At the end the answer's `close` runs, in a `finally` when streaming (`runSimple`, `executeDuck`), then `recordRequest`
  writes the row.

### 7. A refusal, wherever it was raised

Everything above throws. `simpleStatements` or `extended` catches it, `asPgError` shapes it, and `Session.refuse` is the
one place a statement's ErrorResponse goes out: it logs, calls `recordRequest` and sends. Then `tx` moves to `failed` if
a block is open. The extended path also sets `skipToSync`.

A cancel or timeout aborts the statement's `AbortController` (`armTimeout`, `Server.interrupt`). The cancel table and the
close path are `.claude/rules/duckdb.md` "A statement".

## `Sync`

`src/duck/sync.ts`. All of this logic runs on main. Its DuckDB statements run on the worker, each on one of these lanes.

| Lane | Connection | Who runs on it | Its discipline |
|---|---|---|---|
| Writer (`writerLane`) | `store.writer` | Stream batches, polls, attach and detach, swaps, removals, `record` from those | One job at a time: `onWriter` chains jobs on `writerTurn` |
| Rebuilder (`rebuilderLane`) | Its own | The copy's first reader, `fillSide`, the catch-up's poll | One rebuild at a time: the `queued` map and `drainRebuilds` |
| Readers (`copyLanes`) | One per extra reader, made in `readChunks` | Chunks beside the first | Up to `copyParallel`; closed when `readChunks` ends |
| Catalog (`catalog`) | Its own | `schemaBuilt` | Serial through `schemaBuild`; sees only what is committed |

A **writer's turn** is a place in a promise chain on main, not a thread. Inside a job, await nothing that queues another
`onWriter` job: it would wait for itself. `Lane.inFlight`, set by `interruptible`, is what `stop` interrupts.

### State

- `states`: each table's `CopyState`, written through `record` to `_mason.copy_state`.
- `tables`: what the sources file adds now, from `setTables`.
- `snapshots`: each table's watermark, from `_mason.poll_state`.
- `copiedAs`, `copiedColumns`: the columns of the copy as it is, not as the file says. `asCopied` shapes every write.
- `behind`: copied, and owed one catch-up poll. Mirrors `_mason.catch_up`.
- `held`: changes the stream holds for a table being caught up.
- `rebuildingNow`, `queued`, `catchingUp`, `retries`, `due`: the schedule.
- `streamed`: what the stream may apply now, derived only by `refreshStreamed`.

`needsCopy` reads `states`, `snapshots`, `copiedAs` and `retired`. `refreshStreamed` must run in a writer's turn whenever
one of its inputs moves, or a table is left neither streamed nor copied.

### The run of a table

1. **`kick`** starts one `pass` if none runs. When a pass ends it sets the next timer from `nextPassDelay`. A pass also runs
   when a sources file change calls `setTables`, from `wakeAt`, and from `followUp`.
2. **`pass`**, on main, taking writer's turns:
   - drops removed tables and their ledger rows (a turn each);
   - `prepareReplication` and `startStream` if any table replicates, or `retireReplication` if none does;
   - `attach` (a turn), then `work`, then `detach` (a turn), then `rebuildSchema`.
3. **`work`**:
   - `enqueue` a `copy` for each table `needsCopy`, smallest first, skipping those in back-off (`retries`) or `unpublished`.
   - `enqueue` a `catch-up` for each table in `behind`.
   - Polls each due table in **a writer's turn of its own**: `poll(writerLane, [t])`, skipped if the table is being rebuilt
     or is `behind`. Then `polledNow`. A failure is that table's: it is recorded and the others go on.
4. **`enqueue`** starts **`drainRebuilds`**, which does not hold the pass: the pass ends and the queue carries on. The queue
   takes catch-ups first, then the smallest copy, and calls `rebuild` for one table at a time, then `followUp`.
5. **`rebuild`**:
   - sets `rebuildingNow` and calls `refreshStreamed` (a turn);
   - `attach` (a turn), since the pass may have detached;
   - `copy` if a copy was asked;
   - `catchUp` if the table is `behind`, does not need a copy, and is not stopping;
   - in `finally`, `detach`, clears `rebuildingNow`, `refreshStreamed` (a turn).
6. **`copy`**, on the rebuilder lane, not on a turn:
   - `resumable` finds a copy to continue, then **`readChunks`** fills `<table>__mason_copy`:
     `beginCopy` once, then per reader a loop of `takeChunk`, BEGIN, the chunk's INSERT, `recordChunk`, COMMIT.
     `live` (`copyLive`) and `states` move at each commit. `StartOver` restarts it once from page 0.
   - The rows-against-keys check, then `fillSide` for stored JSON paths.
   - **`swap`** in a writer's turn.
   - `record` the table as `copied`, then `rebuildSchema`: **the catalog serves it from here**, before its catch-up.
7. **`swap`**, one transaction on the writer: DROP the old table, RENAME the side table, write `poll_state` and `catch_up`,
   delete `copy_progress` and `copy_chunks`, `kept.swapping`. After COMMIT: `kept.swapped`, then in memory `snapshots`,
   `polledAt`, `copiedColumns`, `behind`, `held`, `refreshStreamed`.
8. **`catchUp`**, on the rebuilder lane:
   - marks `held` in a turn, so batches fold in there (`applyStreamed`, `foldInto`);
   - **`poll(rebuilder, [asCopied(t)])`, not on a writer's turn**;
   - no rows found (a numeric wider than the copy) returns `"copy again"`;
   - then one turn: `applyChanges(held, "held")`, delete from `catch_up`, clear `behind`, `refreshStreamed`. The table joins
     the stream or the polls here.
   - A failure calls `backOff`, and the table stays `behind`.
9. **`followUp`** asks what is next for the table: `kick` now, `wakeAt` after its back-off, or `rearm` once it is done.

### Beside all this

- **The stream** (`src/duck/stream.ts`) decodes on main and hands each batch to `applyStreamed`, which takes a writer's turn,
  calls `refreshStreamed`, drops changes from a stay that ended (`StreamedTable.stay`: `swap` ends one), folds held tables
  and calls `applyChanges`. It acknowledges only what is committed.
- **`pollNow`** (`mason sync`) is a pass of its own, queued behind the running one. `refuseRebuilding` refuses a table
  being read again.
- **`stop`** sets `stopped`, interrupts every lane in flight every 50 ms, waits for the stream, the pass, the rebuild and the
  keeper, then closes the catalog and rebuilder connections.
- **Stored JSON paths** (`src/duck/kept.ts`) take writer's turns through the `onWriter` it is handed. The rules are in
  `.claude/rules/duckdb.md` "Stored JSON paths".

## Facts agents had to work out

Probed on 2026-10-30 with `@duckdb/node-api` 2.0.0-r.1 on macOS, Node 24, under load; timings are one machine's. A
probe measured the event loop's longest stall during each call.

### What waits, and where

| Call | Form | Where it waits |
|---|---|---|
| `DuckDBInstance.create`, `connect`, `prepare`, `run`, `runAndReadAll`, `stream`, `fetchChunk` | Promise | On a libuv pool thread. The calling thread's loop stays free: a 1.5 s aggregate stalled it under 20 ms |
| `interrupt` | Sync | Nowhere: it returned in 0 ms. The statement stops later, at DuckDB's next check |
| `bindVarchar`, `bindNull`, `getRows`, `columnType` | Sync | On the calling thread, for the work itself |
| `closeSync` (result, connection, instance), `disconnectSync`, `destroySync` | Sync | **On the calling thread**, which in Mason is the worker. See below |
| A `__mason_pg_*` function (`src/duck/functions.ts`, `pgEvalSync` in `src/duck/pg-eval.ts`) | Sync, `Atomics.wait` | **On the calling thread, the executor worker**, until the PGlite on the pg-eval worker answers: about 8 ms per 2,048 values. At `TIMEOUT_MS` (30 s) that worker is terminated and the statement fails. Not probed here |

- **The pool is small and shared.** libuv's pool is per process, four threads by default, and nothing here sets
  `UV_THREADPOOL_SIZE`. Six statements on six connections finished four together, then the rest; a `connect` beside them
  waited 1.5 s, and 3.7 s with a pool of two. So a call that looks free can be waiting behind running statements.
- **`stream()` is not where the work is, reliably.** For a call-free aggregate it returned in 2 ms and the first
  `fetchChunk` took the whole 1.3 s. The comment in `SessionRunner.streamed` describes a calling count computing inside
  `stream()`. Handle both.
- **One open result per connection.** A second statement on the connection is refused at once: `connection has an open
  result; drain or destroy it before starting a new query`. Hence `readAside`.

### The close path has no async form

`@duckdb/node-bindings` exposes `destroy_result_sync`, `destroy_prepare_sync`, `destroy_pending_sync`, `disconnect_sync` and
`close_sync`, and no promise form of any of them. A close cannot be waited for off the thread that calls it, so Mason
arranges that a close has nothing to wait for, and `tests/conventions.test.ts` lists every `closeSync` on the worker.

- **A result that did not run to its end:** `SessionRunner.cleanUp` interrupts it, then `fetchChunk`s it. A fetch runs on the
  libuv pool, so that is where DuckDB ends the query and waits for its tasks, while the worker stays free to answer their
  calls. A `SELECT 1` then proves nothing is left, because DuckDB refuses it while a result is open. Only then `closeSync`.
- **A connection:** `conn.close` interrupts and awaits its `connCalls` first. Without that it is not a wait but a loss. With
  a call-free `run()` in flight, a bare `closeSync` returned in 0 ms, the statement's promise had not settled 15 s later (two
  runs of two), and `process.exit` then did not end the process: it took SIGKILL.

Most closes cost nothing: a result's `closeSync` took 0-2 ms in every shape the probe tried, and the probe did not manage to
catch one waiting. The wait is real when a task of the result is mid-vector: PR 75 measured 17.9 s for a call-free statement,
with every session behind it. For a statement that calls a Mason function it is a deadlock, because the task waits for the
thread the close is holding (`.claude/rules/duckdb.md` "The worker's thread never waits for DuckDB's tasks").

### A catalog statement runs at its Bind

`bindMessage` sends Bind, Describe, Execute, Close and Sync to the catalog in one request and stores the rows on the portal
(`Portal.catalog`). `executeMessage` then returns those rows from its first branch, before the check every other kind
meets. So in the extended protocol a catalog statement goes past what an Execute does:

- **The failed-block check.** In a failed block `SELECT $1::int` and a `pg_class` read were answered, where a copied table's
  statement got 25P02 and the same catalog statement over the simple protocol got 25P02. Probed on `main`. PR 60 fixes this
  one with a check at each entrance.
- **The time limit.** `armTimeout` is not armed at a Bind. The catalog's own deadline (`statementMs`) still applies.
- **A cancel.** `running` is not set during `bindMessage`, so a CancelRequest finds nothing to stop.
- **`stillLive`.** It runs at the Parse and the Execute, not the Bind. A removed user's Bind runs; its Execute is refused.

Anything added to `executeMessage` that must hold for every statement must also be added to `bindMessage`'s catalog branch.
