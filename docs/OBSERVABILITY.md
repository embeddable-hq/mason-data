# Observability

What a team running Mason sees about it: whether it is healthy, how fresh each synced table is, what was asked of it, who
asked, and what it costs. The data and the endpoints came first and are built (steps 1–6 below, ✅); the presentation
(the web page's sections, the managed service) is built on them after. What is not built says so (⏸, "Access").

## Built

Every field below is a field of a command's `--json`, and the run's command server (src/cli/run-server.ts) answers the
same JSON; the web page and the managed service read those endpoints, never a second computation.

| Endpoint | Command | What |
|---|---|---|
| `GET /api/state` | `mason status`, `mason wait` (with `?columns=1`) | each synced table's rows, state and last sync (`tables[].sync`), the totals, the readiness; each table's columns only with `?columns=1` |
| `GET /api/tables/<table>/columns` | `mason tables <table>` `columns` | one table's columns (`{ table, columns }`): the Tables page's form reads it as it opens |
| `GET /api/queries` | `mason status` | the last day's and week's statements: outcomes, time (average, p50, p95), rows and bytes sent; read at most once every 30 s, so up to 30 s old |
| `GET /api/activity?since=` | (the Usage page's) | one time range of the request log: `{ since, window, clients, clientsTotal, slowest, keptDays }` — its statements as the summary counts a day, who sent them (a row per user and client: statements, failed, sessions, last; the 50 with the most statements, `clientsTotal` the count of every client and session), the 10 slowest that completed |
| `GET /api/slow`, `GET /api/refused` | `mason status` | the slow statements; the refused and failed ones, each distinct one once |
| `GET /api/unsupported?since=&limit=` | `mason status` `unsupported` | the refused statements grouped by the registry entry (docs/SQL-SUPPORT.md) that refused them: `[{ gap, title, runs, users, clients, last, example }]`, the most refused first; a day and 10 entries by default |
| `GET /api/requests?limit=&failed=&outcome=&since=&until=&user=&client=&slow=&search=&before=&id=` | `mason logs --requests` | the request log, filtered and paged; `slow=1` (`--slow`) the ones that took `SLOW_MS` (1 s) or more, `search` (`--search`) a piece of the statement's text, any case; `id` (`--id`, printed whole) one request; a slow one carries its `plan` ("The plan of a slow statement") |
| `GET /api/events?limit=&since=&failed=` | `mason logs --events`; `mason status` `recentErrors.sync` | the sync's failures and events, and the run's restarts |
| `GET /api/running`, `POST /api/cancel { session }` | `mason logs --running`, `mason cancel <session>` | the statements running now; stop one as a client's cancel does |
| `GET /api/usage?since=&until=&step=` | `mason usage` | a sample a minute, re-bucketed by `step` (a point of more than a minute: its p50 / p95 are its statements', from the request log, never its worst minute's), and each synced table's own size on disk |
| `GET /api/users[?lastUsed=1]` | `mason user list` | the users, removed ones kept; the last use only when asked (a scan of the request log) |
| `POST /api/users/<name>/disable`, `POST /api/users/<name>/enable` | `mason user disable <name>`, `mason user enable <name>` | a user kept with its password, its logins refused (28000) until enabled; `{ disabled \| enabled, already, next }` |
| `GET /api/logs?lines=&since=` | `mason logs --json` | the run's last log entries from memory (`mason serve` has no file) |
| `POST /api/sync { tables }` | `mason sync` | sync now, per table |

`/api/state` also says the run's health beyond the synced tables (each `mason status` says on a line of its own, and each
sampled once a minute where it moves):

- `stream.slotWal` (replication): the WAL the slot holds on the database — `{ walHeldBytes, walStatus, safeWalSizeBytes, at }`
  or `{ error }`; `safeWalSizeBytes` null is `max_slot_wal_keep_size` unset, nothing capping it. One row of
  `pg_replication_slots`, read on the connection the database's position is read on, at most every 30 s. Sampled as
  `slotWalHeldBytes`. (`stream.slot` is the slot's name.)
- `engine.version`, `engine.startedAt`, `engine.uptimeSeconds`: the run's own (a supervisor's restart is a new run), and
  `engine.restarts` — `{ count, last: { at, why, upSeconds } | null }` or `{ error }` — its supervisor's record
  (`.mason/restarts.json`, the last 20), read by ONE function (src/cli/supervise.ts `restartsFact`) that `mason status`
  reads with Mason stopped too.
- `disk` — `{ path, freeBytes, copyBytes, projectedBytes, error? }`: free where the synced data's file is (the sync's own
  `diskFree`, the measure a first sync is held to), the file and its write-ahead log (`engine.bytes`), and while first
  syncs run what their pages left are projected to add (`copyDiskProjection`, as each chunk's check last computed it; null while none can say). A `statfs`, no
  query. Sampled as `diskFreeBytes` (re-bucketed, the lowest).
- `sessions` — `{ open, byClient: [{ user, client, open, running }] }`: the Postgres API's sessions logged in now, by
  `mason user` ('' a token's) and application_name, and how many of each run a statement; the listener's own, in memory
  (`openSessions`). Sampled as `sessionsOpen`.

The lines `mason status` prints for them are exported renderers (src/cli/commands.ts `slotText`, `masonRows`,
`restartsRows`, `diskRows`, `sessionsRows`), so the web page is held equal to them.

`mason status --json` `recentErrors` holds the latest sync failures (`sync`) and the latest statements refused, failed or
cancelled (`queries`, the request log's own shape). `since` and `until` are read everywhere by one grammar: an age (30m,
2h, 7d) or an ISO 8601 time with its zone.

## Pages (the web UI's structure)

One page per concern (`.claude/rules/web-ui.md`), each rendered from the endpoints above in the commands' words, as
plain tables first; how they look comes after. The page stays `mason start`'s (`mason ui`); the managed service renders
the same endpoints its own way.

Built: the shell and every page (src/web/app.js, src/web/pages/).

- **The shell**: `index.html` with a left sidebar — Overview · Tables · Users, then the Observability group's three
  views, Queries · Usage · Sync events (modelled on Vercel's, Neon's and PlanetScale's) — and one section per page, chosen
  by the URL's hash (`#overview`, the default; `#observability/queries`; the old `#status`, `#queries`, `#usage` and
  `#logs` land on their view; `#observability/logs` is Sync events). Each page is an ES module of its own, a route of `PAGE_ROUTES`. ONLY THE PAGE SHOWN
  polls, each endpoint at the rate its data moves (below), and nothing while the tab is hidden.
- **Observability's time range**: Now · Last hour · 24 hours · 7 days · 30 days · 90 days (Now unless `?range=` says;
  Now is the last 15 minutes and LIVE — its reads every few seconds — and every other range is read once when chosen,
  with when and Refresh beside it; 30
  and 90 days only where the run keeps them, `/api/state` `engine.keptDays`, MASON_HISTORY_DAYS — else shown
  disabled, saying so), shared by its three views and kept in the hash: Queries' request log `since`, Usage's samples
  (`since`, and a step of 60 s, 1 h, 6 h or a day — 90 days, 129,600 samples, re-bucket in ~15 ms),
  Usage's `/api/activity`, Sync events' `since`. Each view's filters compose with it.
- **Overview** (`#overview`): one word, `mason status`'s (Ready / Under way / Failed: `readinessWord` of `readiness`, said
  by the CLI and the page alike — the "Healthy / Syncing / Error" asked for, in the commands' words); cards that each link
  into the view that lists what they count (the failed tables, Queries — the slow ones from the p95 —, Usage); ONE table
  of facts — the database and how its changes arrive, the warnings, Mason's version, up for, restarts (`engine`), the
  free disk and what a running first sync is projected to add (`disk`), the sessions open (`sessions`); in replication mode a
  Changes table — the stream (`stream`: running or why not, position, lag, last batch, as `streamLines` says it) and the
  slot's hold on the WAL (`stream.slotWal`: held, status, room left; `lost`, `unreserved` or no cap are warnings); the
  statements of the last day and week (p50 / p95); the first syncs not finished, a bar each, only while there are any; and a
  table of the recent errors (sync and statements), each with See all. A fact the run could not read (`{ error }`) is
  said as unknown with its reason, never as 0; one it does not say is not shown; the last day's unsupported SQL, one line
  with See all when there is any. Reads `/api/state` (2 s), `/api/queries`, `/api/events?failed=1`,
  `/api/requests?failed=1`, `/api/unsupported` (30 s).
- **Tables** (`#tables`, `#tables?show=failed`): ONE table of the database's tables. An added one shows its state
  (Synced / Syncing / Failed / Waiting), rows, last sync and its age, how long it took (`<0.1 s` under a tenth), the
  synced table's own size on disk, in replication mode its stream state, its error, **View events** (Sync events narrowed to it), **Sync now**
  (`POST /api/sync`) and Remove; one not added
  its rows and key and why it cannot be added as it is, with Add / Columns… / Name its key…. A search box over the names
  and All / Added / Failed / Not added; the first 100 that pass written, then Show more / Show all. Reads `/api/state`
  (2 s, lean: no table's columns), `/api/usage` `copySizes` and `unsized` (60 s: a synced table with no size says why, `< 3 MiB` or `Measuring…`), and a table's columns once as its form opens
  (`/api/tables/<table>/columns`).
- **Users** (`#users`): today's add form, Disable (asks first) / Enable and Remove, and each user's status (Active /
  Disabled / Removed), when it was added, its last use and its Queries; ONE Connect panel for the run (host, port,
  database, SSL mode, the URL and psql with `<user>:<password>`, each with **Copy**), never a URL per user. Reads
  `/api/users?lastUsed=1` and `/api/state` (on opening, then 30 s).
- **Observability › Queries** (`#observability/queries`): the request log as a table, newest first — the first 8
  characters of the id, started, duration, status, user, client, rows, the statement (two lines at most), its error's
  first line — with a per-row details (the whole id, ended, bytes sent, the statement and error, the first 16 KiB of
  each), filtered by status, slow (1 s or more), the statement's text, user and
  client (Usage's rows lead here with them), over the range alone, paged by **Older**, its page sorted by Started, Duration or Rows. Rows
  scanned is not a column: decide later, it may add cost to every statement. Reads `/api/requests` (under Now 5 s on
  the newest page, 30 s while a search is set — said under the log; once for any other range; never on an older page),
  `/api/state` (30 s, for Connect while the log is empty).
- **Observability › Usage** (`#observability/usage`): the range's cards, who is connected and what runs (Now:
  `/api/state` `sessions`, 5 s; `/api/running`, 2 s, each with **Cancel**, `POST /api/cancel`) or who sent statements
  and the slowest (any other range: `/api/activity`), the unsupported SQL of the range (`/api/unsupported?since=`), the
  range's samples (`/api/usage?since=<range>&step=<60|3600|21600|86400>`, newest first, the process's memory in a closed
  details), four charts of them, and each synced table's own size on disk. A client, a slow statement and a statement card lead to
  Queries filtered. Under Now `/api/activity` every 5 s and the rest every 60 s; any other range, each once.
- **Observability › Sync events** (`#observability/syncs`): the sync's events of the range (`/api/events?limit=500&since=`, 10 s
  under Now, else once), newest first, narrowed by Failures only, a kind (every kind) and a table (every added table,
  from `/api/state`, whether the range has an event of it or not; Tables' View events chooses it). The run's raw log
  (`/api/logs`, 5 s) is debugging output with internal tags and paths: it is behind a closed details, newest first, and
  read only while that is open.

## Who reads it

- **Every Mason run collects it**, with nothing to turn on: `mason start` on a laptop and `mason serve` in production.
- **The managed service** shows it in its online interface, reading each instance's endpoints over a service token
  (see "Access" below).
- **Open source**: the same endpoints and `--json`; whether a UI is served on top of them is not decided.

## How it is built (the rules it follows)

- **One fact, one place**: every field is computed once on the server and is a field of a command's `--json` before
  any page shows it (`.claude/rules/web-ui.md`). The web page, the managed service and a coding agent read the same JSON.
- **Mason's words**: a "user" (what `mason user` makes), never "credential" or "token"; "the synced table", "the synced data" and "the first sync", never "the copy"; never
  the engine's name.
- **Kept like the request log**: anything with history lives in the run's own file, written on a connection of its own
  (never the sync's writer turn), kept `MASON_HISTORY_DAYS` days.

Key: ✅ built · ⏸ deferred

## 1. Status

| Field | | Where it comes from / what to build |
|---|---|---|
| Healthy / Syncing / Error | ✅ | `readiness` (src/cli/readiness.ts) |
| Tables synced, N of M | ✅ | `/api/state` `tables` |
| Total rows | ✅ | `totals.rows`; a synced table's rows are counted after every batch |
| Last successful sync | ✅ | `totals.syncedAt` and `tables[].sync` (`syncedAt`, `syncedBy`); in replication mode the stream's last batch |
| Storage used | ✅ | `engine.bytes`, the synced data's file and its write-ahead log |
| Queries, last 24 h / 7 d | ✅ | `queries` (`/api/queries`), from the request log (`_mason.requests`); 7 days is its default retention |
| Query duration | ✅ | `queries`: average, and p50 / p95 (an average alone hides the slow ones) |
| Recent errors | ✅ | `recentErrors`: `sync` (the sync events record, step 2) and `queries` (the request log's failures) |

## 2. Tables

| Field | | Where it comes from / what to build |
|---|---|---|
| Row count | ✅ | as Total rows above |
| Last sync time, and how old the synced data is | ✅ | per table: `sync.syncedAt`, `sync.ageSeconds` |
| Sync now, per table | ✅ | `POST /api/sync { tables }` (`mason sync`) |
| Synced / Syncing / Failed / Pending | ✅ | the first sync's phase: `copy.phase` is `done`, `copying` or `failed`, and `copy` is null while the table waits |
| Sync duration | ✅ | `sync.syncSeconds`: how long the sync that brought the synced table current took |
| Sync error | ✅ | the current one on the table; its history is the sync events (`mason logs --events`) |
| Size of the synced table | ✅ | `bytes` is the SOURCE table's size; the synced table's own size is measured every 10 min from its blocks (`/api/usage` `copySizes`, `mason usage`), never per request; a synced table with none says why (`unsized`: its rows all in the write-ahead log, under its size `walBytes` while the file is unwritten since the measure; else why it is being measured: the file written, synced, or no measure since the start, `sizedAt`) |
| Search / filter | ✅ | over the list the endpoint returns; no server change for hundreds of tables |

## 3. Queries

| Field | | Where it comes from / what to build |
|---|---|---|
| SQL, started, duration, rows returned, error | ✅ | a request log row (`LedgerRequest`) |
| Ended | ✅ | `endedAt` |
| Completed / Failed / Cancelled | ✅ | `outcome` and `status`; a cancel is SQLSTATE 57014 |
| Running | ✅ | `GET /api/running`, `mason logs --running` |
| Cancel | ✅ | `POST /api/cancel`, `mason cancel <session>`, through the listener's one path |
| User | ✅ | `user`; and the client's `applicationName` |
| Query ID | ✅ | `requestId` |
| The plan of a slow statement | ✅ | `plan`, `planTruncated` ("The plan of a slow statement" below): in the row's details, and whole in `mason logs --requests --id <requestId>` |
| Rows scanned | ⏸ | **Decide later: may add cost to every query.** DuckDB reports it only with its profiler on per statement, whose cost is not measured. Measure (about half a day) before promising it. |
| Filters: status, date, user | ✅ | `/api/requests`: outcome, `failed`, since / until, user, client, `slow`, `search`, and paging (`before`) |

## 4. Users

| Field | | Where it comes from / what to build |
|---|---|---|
| List, add (password shown once), remove | ✅ | `mason user`, `/api/users` |
| Added at | ✅ | `addedAt` |
| Last used | ✅ | `lastUsedAt`, the request log's latest row for the user (`?lastUsed=1`); older than the retention is said as such |
| Active / Removed | ✅ | a removed user is kept with `removedAt` |
| Disable / enable | ✅ | `mason user disable` / `enable`, `POST /api/users/<name>/disable` / `enable`; kept with `disabledAt`, its password unchanged |
| Connection string | ✅ | with the password ONCE, when the user is added (kept nowhere); afterwards the URL without it |

## 5. Usage

| Field | | Where it comes from / what to build |
|---|---|---|
| Storage, queries executed | ✅ | as Status |
| Rows returned | ✅ | the request log |
| Rows processed | ⏸ | as Rows scanned |
| Data transferred | ✅ | `bytesSent`, the bytes the listener sends a statement, a column of the request log |
| Usage over time | ✅ | a sample a minute in `_mason.usage` (step 6): `/api/usage`, `mason usage` |
| Billing period | — | dropped for now |

## 6. Logs

- `mason start`: the run's log, `.mason/mason.log`. ✅ `mason logs`.
- `mason serve`: the log is stdout, so there is no file. ✅ the last 2000 entries are kept in memory, for both: `GET /api/logs`.

## Also worth showing (not asked for)

1. **How old each synced table is**, in seconds: "can I trust this number?"
2. ✅ **Stream lag, and the WAL the replication slot holds on the source**: a slot nobody reads fills the source's disk.
3. ✅ **Refused statements grouped by the unsupported SQL they used** (`src/duck/gaps.ts`), so users know what to rewrite
   (`GET /api/unsupported`; each refused statement's entry is the request log's `gap`).
4. ✅ **Sessions open now, restarts** (`sessions`, `engine.restarts`); memory against the limit is a usage sample (`copyMemoryBytes`).
5. ✅ **Free disk against the first sync's projected size** (`disk`, from `copyDiskProjection`).

## Steps (data and endpoints; presentation later)

Each adds fields to a command's `--json` and the endpoint with the same JSON, with its tests.

1. ✅ **Status and Tables (~2 days)**: row counts after each poll; per table the last sync, its duration and the synced
   table's age; totals; query counts and durations over 24 h and 7 d.
2. ✅ **Sync events (~1.5 days)**: first-sync and poll failures and restarts as rows, kept as the request log is.
3. ✅ **Queries (~2 days)**: filters and paging, ended, Cancelled; the running statements and cancel; bytes sent.
4. ✅ **Users (~1 day)**: last used, removed entries kept, the URL without the password.
5. ✅ **Logs (~1 day)**: the last N lines in memory, an endpoint, `mason logs --json`.
6. ✅ **Samples (~2–3 days)**: every N seconds — storage, rows, queries, bytes sent, lag, memory — and each synced table's size
   less often.

## Access (C built; A and B open)

The managed service reads these from `mason serve`, which answers `/healthz` and `/metrics` (C, below): the endpoints
above are `mason start`'s command server (loopback, the run's token). It needs them served from `mason serve` behind a
service token, and TLS off loopback. Not designed yet: options A and B, for the owner to choose.

**C is built (2026-10-30)**: `GET /metrics` on the health port (`MASON_HEALTH_PORT`, beside `/healthz`), Prometheus's
text format 0.0.4, no credential (src/cli/metrics.ts; deploy/mason-data/README.md "Metrics" has the scrape config). It
serves numbers only — `mason_ready`, `mason_info{version}`, `mason_uptime_seconds`, `mason_tables{phase}` (the phase of
each table's first sync: `synced`, `syncing`, `waiting` or `failed`), `mason_synced_bytes`, `mason_synced_rows`, `mason_sync_oldest_age_seconds`, `mason_stream_lag_bytes` /
`_seconds`, `mason_slot_wal_held_bytes`, `mason_disk_free_bytes`, `mason_sessions_open`,
`mason_statements_total{outcome}` (a counter since the process started) and `mason_statement_duration_seconds` (a
summary: the last minute's sample's p50 / p95, the sum and count since the start) — each the number `/api/state` or a
usage sample already holds (src/cli/run-server.ts `metricsFacts`), a number not known absent rather than 0. A scrape
never reaches the source: the stream's position and the slot are as the sampler last read them, absent when that is
more than two samples old. It
deliberately serves NO name — no table, column, user, client or host, as a value or a label — and no statement text,
because it takes no credential and a real database's structure is confidential: per-table or per-user detail, and the
statements, wait for A (or B) behind a secret. While Mason starts or stops it answers 200 with `mason_ready 0` and
`mason_info` alone: whether it is up is `/healthz`'s to say, and a scrape that errored then would alert on nothing.

| | A. Pull: the endpoints on `mason serve` | B. Push: `mason serve` sends to the service | C. `/metrics` (Prometheus) |
|---|---|---|---|
| What | the same `GET /api/*` JSON, read-only, on the health port (`MASON_HEALTH_PORT`) | samples, events and failed statements posted every minute to `MASON_OBSERVE_URL` | numbers only (counts, lag, ages, sizes), no statement text |
| Auth | a bearer secret, `MASON_OBSERVE_TOKEN`; no token set → the routes answer 404 | the same secret, sent outbound | none: numbers only, never a name (built) |
| TLS | required off loopback (`MASON_HEALTH_TLS_CERT` / `_KEY`, or the listener's), refused at start without it | the service's HTTPS | none, as `/healthz` (nothing secret in it) |
| Network | an inbound port the service reaches | outbound only: works behind NAT and in a VPC that takes no inbound | inbound, scraped |
| Cost | ~2 days: the routes, the guard, the start check, tests | ~4 days: a buffer that survives restarts, retries, back-off | ~1 day |
| Risk | the request log's statement text (customer literals) leaves the box when asked | the same, every minute, by default once set | none of the statement text |

Decisions it needs: pull or push (A or B); whether statement text is served at all or only on a second, narrower
token; whether actions (Cancel, Sync) are ever served there or read-only for good; one secret or a list of named ones
(as `mason user` is for the Postgres API). Recommended: **A, read-only, one secret, statement text included, TLS
required**, then **C** for teams that already run Prometheus. C is built (above); A and B stay open.

## The plan of a slow statement (issue 825, 2026-11-10)

A statement that took `SLOW_MS` (1 s) or more has Mason's plain EXPLAIN of it on its request-log row: `plan`,
`planTruncated` (`mason logs --requests --json`, `/api/requests`, the Queries page's row details,
`mason logs --requests --id <id>`). Finding why a 20–46 s preview was slow had taken a hand-run EXPLAIN on the server. A
hand-run `EXPLAIN ANALYZE` slowed a user's statement to 46 s, while a plain EXPLAIN (111 ms) showed the cause: the
rewrite's `ORDER BY a.rowid, b.rowid`, and a Top N over a Hash Join estimated at ~165 M rows.

How it is kept out of the answer's way (src/api/postgres/slow-plan.ts):
- **Recorded after the answer is sent.** The row waits for its plan in the ledger (src/duck/requests.ts,
  `PLAN_WAIT_MS`), never the client.
- **Planned from what it ran.** It is the plan the statement ran (`DuckPlan`), with its values and session. Nothing is
  planned again, so the catalog Postgres (one thread for every session's analysis) does nothing for it.
- **Its own connection.** On the engine's side, the EXPLAIN's prepare and plan are asynchronous calls. They run on a
  libuv pool thread, never the executor worker's own thread, which only passes a few messages.
- **One at a time.** At most one plan is in flight. A slow statement that ends meanwhile gets none, and the log says
  so at most once a minute, with how many.
- **Bounded.** A deadline of 30 s, a cap of 8 KiB, and the stop aborts the plan in flight.

**Measured** (a scratch script, not a test, on a shared 4-core sandbox with the load average 0.9 rising to 4.7 from
other work; Node 26.13, `UV_THREADPOOL_SIZE=32` as Mason sets it):
- **The setup.** A listener over a real store. Five sessions send 50 fast statements a second in all (a count over a
  10,000-row table, 91 texts). Two other sessions run a slow statement back to back (a nested-loop join of 20,000²
  pairs, ~2 s each), so about one plan a second is recorded.
- **The configurations.** Each ran 30 s, interleaved, twice: plans off; on at SLOW_MS; and at 0 ms, where every
  statement is slow, so a plan is always in flight (the worst case: ~30 plans a second, the rest dropped).

| Plans | fast statements | p50 ms | p95 ms | p99 ms | EXPLAIN p50 / p95 ms |
|---|---|---|---|---|---|
| off (round 1, 2) | 1,505 / 1,503 | 9.5 / 10.2 | 25.6 / 32.1 | 40.2 / 54.2 | — |
| at SLOW_MS (33 and 32 plans) | 1,502 / 1,499 | 10.4 / 10.5 | 30.1 / 31.0 | 71.3 / 88.6 | 13.7 / 40.3, 13.0 / 25.0 |
| every statement (1,096 and 847 plans) | 1,504 / 1,500 | 9.7 / 11.1 | 33.9 / 37.9 | 51.1 / 86.2 | 10.5 / 21.6, 10.9 / 22.9 |

At SLOW_MS, the fast statements' p50 and p95 are within the spread between the two rounds without plans. With a plan
always in flight, the p95 is 2–6 ms higher, about the size of that spread. An EXPLAIN takes ~10–14 ms at p50. No
design around it (a lower priority, waiting for an idle executor) was needed; measure again if what the plan reads
grows (a synced table's facts are read in memory; `duckdb_tables()` once).

## To come back to

- **NEXT: a table just added shows its first sync's progress at once.** Today, Add on the Tables page writes the
  sources file and the first sync starts, but nothing on the row moves, so it looks as if nothing happened. The row
  should show a progress bar and the % synced (`tables[].copy.progress.share`, the rows, the time left — what `mason
  wait` prints, `copyingText`), from the click until the synced table is served; then its sync state.
- **NEXT: a vertical left sidebar with icons** in place of the horizontal top nav (Overview, Tables, Users, and
  Observability with Queries / Usage / Logs under it), as Vercel's and Supabase's dashboards do; collapsing to icons
  on a narrow window and to a menu on a phone. Icons served by Mason like everything else: inline SVG, or a small icon
  set vendored whole with its license (e.g. Lucide, ISC) under `src/web/vendor/`.

- ✅ **The slow statements have a page**: Observability › Queries' **Slow (1 s or more)** filter — the request log's
  `slow` (`--slow`, `slow=1`, src/cli/request-filter.ts `SLOW_MS`, the constant `mason status` lists them by) — and the
  Overview's p95 card links to it; Duration sorts the page shown.
- **The oracle's measurement fixture** (`tests/fixtures/oracle-duckdb-alone.json`) fails on `main` as on this branch
  against a local Postgres 18.3 (913 exact where it has 850): recorded elsewhere, to regenerate where CI runs.
- **Access** for the managed service (above): C (`/metrics`) built; A and B written, awaiting the owner's choice.
- **Rows scanned**: deferred (it may add cost to every statement).

## Architecture review (2026-10-29)

Measured, not estimated: a synthetic request log of 30 M rows (a week of a BI tool at 50 statements a second, 2.2 GiB,
written in time order as the ledger writes it) on a 10-core, 32 GiB laptop; the demo with 804 tables in its database
and 204 of them synced; the listener against the `main` it branched from. Three runs each.

**The request log's reads at 30 M rows** (what the pages poll; before → after this review):

| Read | Who asks, how often | ms |
|---|---|---|
| `summary` (`/api/queries`) | Overview 30 s, Usage, Queries, `mason status` | 707–765 → **146–162** (one GROUP BY; p50 / p95 from the durations' histogram, exact) |
| `lastUsed` (`/api/users?lastUsed=1`) | Users 30 s, `mason user list` | 6 users 182–185, 66 users 2,155–2,812 → **121–142** for either (one join) |
| `slow` (`/api/slow`) | `mason status` | 207–251 → **57–67** (only the statements that were ever slow are grouped) |
| `page` of 50, any filter but `search` | Queries 5 s | 4–10 (`started_at` prunes: insertion order is time order, the zonemaps skip all but the window — 351 k of 30 M rows scanned for 3 h) |
| `page` with `search`, no match | Queries 5 s | 24 h: 84–89; 7 days: **561–610** (a scan of the statements' text; left) |
| `unsupported` | Overview 30 s (a day), Queries 60 s (the range) | a day 31–37; 7 days 190–222 |
| `refused`, events, `max(seq)` at open | `mason status`, Logs, the open | 30–36; 1–2; 1–3 |
| the retention trim | hourly, and at open | an hour's 179 k rows 4 ms, a day's 4.3 M 15 ms |
| the open's `ADD COLUMN IF NOT EXISTS` | each start | 5 ms; 210 ms once on a log from `main` missing two columns |
| `copySizes` (`pragma_storage_info`) | every 10 min | 30 M rows × 19 columns (9,348 segments) 71–84 ms, so ~0.5 s for 200 M × 20; 203 small synced tables 421 ms |

**The listener**: no per-statement cost measurable — 3,000 small statements, 780–970 µs each on `main` and on this
branch alike, and a 150,000-row answer 96–126 ms on both (the bytes counted per send, the running list and the
sessions are read only when asked).

**Spin-up**: `mason init demo` 0.23 s, `mason start` 1.89 s (seeding the demo) and ready 0.26 s later; a restart with
204 synced tables 2.25 s, ready +0.31 s; `mason serve` healthy after 0.60 s. The new tables' opens add 5–10 ms.

**The page**: the first load is 23 static requests, 520 KB (uPlot 145 KB and the fonts 141 KB of it; uPlot is
imported only when a chart is drawn, which the Overview's sparklines do), every request same-origin (the CSP is
`default-src 'self'`); the load event at 25 ms on loopback. A reload now keeps the pinned vendor files (immutable):
222 KB. `/api/state` with 804 tables is 590–604 KB (750 B a table not added, most of it its columns), built in 2–16 ms,
parsed in 1 ms, and polled every 2 s by the Overview and Tables.

**Nothing is fetched at run time**: no URL in src/ is fetched but DuckDB's extension repository; JSON, ICU and Parquet
are built into DuckDB; the `postgres` and `inet` extensions ship with the CLI and the image, one npm package per
platform (src/duck/extensions.ts), and with them DuckDB's autoinstall is off. Without a package for the platform, the
first sync on a machine downloads them once.

**Left, most worth it first**:

1. **Done**: `/api/state` carried every catalog table's columns, polled every 2 s. It is lean now: 800 tables of 5
   columns 465 KB → **134 KB**, of 50 columns 3,414 KB → **134 KB** (built and serialised 4.6 → 1.2 ms); a form's
   columns are `GET /api/tables/<table>/columns`, read once as Columns… or Name its key… opens, and `?columns=1` keeps
   them for `mason status --json` (its shape unchanged).
2. **Done, by PR 37**: from npm, an offline machine's first sync failed (the extension download), said only then. The
   sync's `postgres` and `inet` extensions now ship with the CLI as one optional package per platform
   (`@mason-data/extensions-<platform>`, src/duck/extensions.ts) and in the image; `mason doctor` has an `extensions`
   line. This branch's own `mason init` install step was dropped for it when main was merged (2026-10-29).
3. **Done**: Queries' `search` over 7 days was ~0.6 s every 5 s while shown (12 scans, ~7.2 s of a core a minute); a
   search is read every 30 s now (2, ~1.2 s a minute), and the log says "Refreshed every 30 s while searching".
4. **Done**: the summary was a 7-day scan per ask (146–162 ms at 30 M rows), for each page and `mason status` that
   asked. It is one read shared for 30 s now (`SUMMARY_TTL_MS`, src/cli/run-server.ts `timedCache`, by time only;
   asks at once share the read in flight, a failed read is not kept): at most one scan every 30 s, whoever asks, so
   **the summary is up to 30 s old** — on the Overview, Usage, Queries' cards and `mason status`.
5. **Done**: the three history tables (requests, sync events, usage) each repeated the same frame — two connections,
   batched writes, the hourly trim, a failure said once per streak, the close. It is one module now,
   `src/duck/history.ts` (`History`, `Batches`, `Streak`), behaviour and the tables' tests unchanged: the three went
   from 1,151 lines to 1,099 (the frame's 99, its account included, said once). The shapes `src/duck/` imported
   from `src/cli/` live in `src/duck/` (`Restart` in events.ts, `SlowQuery` / `RefusedQuery` in requests.ts, re-exported
   where the commands import them); `src/duck/sync.ts`'s import of the source's shapes from `src/cli/preflight.ts`,
   older than this review, is left.

## Decided

- "User", never "credential" (the CLI's word).
- Billing period: dropped for now.
- A user's password is shown once, when it is added.
- Rows scanned: deferred, a placeholder above.
