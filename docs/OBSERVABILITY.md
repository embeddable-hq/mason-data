# Observability

What a team running Mason sees about it: whether it is healthy, how fresh each copy is, what was asked of it, who
asked, and what it costs. The data and the endpoints came first and are built (steps 1–6 below, ✅); the presentation
(the web page's sections, the managed service) is built on them after. What is not built says so (⏸, "Access").

## Built

Every field below is a field of a command's `--json`, and the run's command server (src/cli/run-server.ts) answers the
same JSON; the web page and the managed service read those endpoints, never a second computation.

| Endpoint | Command | What |
|---|---|---|
| `GET /api/state` | `mason status`, `mason tables`, `mason wait` | each copy's rows, state and last sync (`tables[].sync`), the totals, the readiness |
| `GET /api/queries` | `mason status` | the last day's and week's statements: outcomes, time (average, p50, p95), rows and bytes sent |
| `GET /api/slow`, `GET /api/refused` | `mason status` | the slow statements; the refused and failed ones, each distinct one once |
| `GET /api/requests?limit=&failed=&outcome=&since=&until=&user=&client=&before=` | `mason logs --requests` | the request log, filtered and paged |
| `GET /api/events?limit=&since=&failed=` | `mason logs --events`; `mason status` `recentErrors.sync` | the sync's failures and events, and the run's restarts |
| `GET /api/running`, `POST /api/cancel { session }` | `mason logs --running`, `mason cancel <session>` | the statements running now; stop one as a client's cancel does |
| `GET /api/usage?since=&until=&step=` | `mason usage` | a sample a minute, re-bucketed by `step`, and each copy's own size |
| `GET /api/users[?lastUsed=1]` | `mason user list` | the users, removed ones kept; the last use only when asked (a scan of the request log) |
| `GET /api/logs?lines=&since=` | `mason logs --json` | the run's last log entries from memory (`mason serve` has no file) |
| `POST /api/sync { tables }` | `mason sync` | sync now, per table |

`mason status --json` `recentErrors` holds the latest sync failures (`sync`) and the latest statements refused, failed or
cancelled (`queries`, the request log's own shape). `since` and `until` are read everywhere by one grammar: an age (30m,
2h, 7d) or an ISO 8601 time with its zone.

## Pages (the web UI's structure)

One page per concern (`.claude/rules/web-ui.md`), each rendered from the endpoints above in the commands' words, as
plain tables first; how they look comes after. The page stays `mason start`'s (`mason ui`); the managed service renders
the same endpoints its own way.

Built: the shell and every page (src/web/app.js, src/web/pages/).

- **The shell**: `index.html` with a nav — Status · Tables · Queries · Users · Usage · Logs — and one section per page,
  chosen by the URL's hash (`#status`, the default). Each page is an ES module of its own, a route of `PAGE_ROUTES`.
  ONLY THE PAGE SHOWN polls, each endpoint at the rate its data moves (below), and nothing while the tab is hidden.
- **Status** (`#status`): one word, `mason status`'s (Ready / Under way / Failed: `readinessWord` of `readiness`, said
  by the CLI and the page alike — the "Healthy / Syncing / Error" asked for, in the commands' words); ONE table of
  facts — the database and how its changes arrive, the warnings, Mason's version, up for, restarts (`engine`), tables
  synced N of M, rows, last sync, the copy's size, the free disk and what a running copy is projected to add (`disk`),
  the sessions open (`sessions`); in replication mode a Changes table — the stream (`stream`: running or why not, position,
  lag, last batch, as `streamLines` says it) and the slot's hold on the WAL (`stream.slot`: held, status, room left;
  `lost`, `unreserved` or no cap are warnings); the statements of the last day and week (p50 / p95); the copies not
  finished, a bar each, only while there are any; and a table of the recent errors (sync and statements). A fact the
  run could not read (`{ error }`) is said as unknown with its reason, never as 0; one it does not say is not shown.
  The slow and the refused statements are the Queries page's. Reads `/api/state` (2 s), `/api/queries`,
  `/api/events?failed=1`, `/api/requests?failed=1` (30 s).
- **Tables** (`#tables`): ONE table of the database's tables. An added one shows its state (Synced / Syncing / Failed /
  Waiting), rows, last sync and its age, how long it took (`<0.1 s` under a tenth), the copy's own size, in replication
  mode its stream state, its error, **Sync** (`POST /api/sync`) and Remove; one not added its rows and key and why it
  cannot be added as it is, with Add / Columns… / Name its key…. A search box over the names and All / Added / Not added.
  Reads `/api/state` (2 s), `/api/usage` `copySizes` (60 s).
- **Queries** (`#queries`): who is connected now (`sessions` of `/api/state`: user, client, sessions open, statements
  running), the statements running now, each with **Cancel** (asks first; `POST /api/cancel`), and the request log as a
  table — the first 8 characters of the id, started, duration, status, user, client, rows, the statement, its error's
  first line — with a per-row details (the whole id, ended, bytes sent, the whole statement and error), filtered by
  status, time, user and client, paged by **Older**. Rows scanned is not a column: decide later, it may add cost to
  every statement. Reads `/api/running` (2 s), `/api/requests` (5 s on the newest page, never on an older one),
  `/api/state` (5 s).
- **Users** (`#users`): today's add form and Remove, and each user's status (Active / Removed), when it was added, its
  last use, and its URL without the password (**Copy**). Reads `/api/users?lastUsed=1` (on opening, then 30 s).
- **Usage** (`#usage`): the last day's and week's statements (`/api/queries`), the last 24 h hour by hour
  (`/api/usage?since=24h&step=3600`, the process's memory in a closed details), and each copy's own size (60 s).
- **Logs** (`#logs`): the sync's events (`/api/events`, 10 s). The run's raw log (`/api/logs`, 5 s) is debugging output
  with internal tags and paths: it is behind a closed details and read only while that is open.

## Who reads it

- **Every Mason run collects it**, with nothing to turn on: `mason start` on a laptop and `mason serve` in production.
- **The managed service** shows it in its online interface, reading each instance's endpoints over a service token
  (see "Access" below).
- **Open source**: the same endpoints and `--json`; whether a UI is served on top of them is not decided.

## How it is built (the rules it follows)

- **One fact, one place**: every field is computed once on the server and is a field of a command's `--json` before
  any page shows it (`.claude/rules/web-ui.md`). The web page, the managed service and a coding agent read the same JSON.
- **Mason's words**: a "user" (what `mason user` makes), never "credential" or "token"; "the copy"; never the engine's name.
- **Kept like the request log**: anything with history lives in the run's own file, written on a connection of its own
  (never the sync's writer turn), kept `MASON_REQUEST_LOG_DAYS` days.

Key: ✅ built · ⏸ deferred

## 1. Status

| Field | | Where it comes from / what to build |
|---|---|---|
| Healthy / Syncing / Error | ✅ | `readiness` (src/cli/readiness.ts) |
| Tables synced, N of M | ✅ | `/api/state` `tables` |
| Total rows | ✅ | `totals.rows`; a copy's rows are counted after every batch |
| Last successful sync | ✅ | `totals.syncedAt` and `tables[].sync` (`syncedAt`, `syncedBy`); in replication mode the stream's last batch |
| Storage used | ✅ | `engine.bytes`, the copy's file |
| Queries, last 24 h / 7 d | ✅ | `queries` (`/api/queries`), from the request log (`_mason.requests`); 7 days is its default retention |
| Query duration | ✅ | `queries`: average, and p50 / p95 (an average alone hides the slow ones) |
| Recent errors | ✅ | `recentErrors`: `sync` (the sync events record, step 2) and `queries` (the request log's failures) |

## 2. Tables

| Field | | Where it comes from / what to build |
|---|---|---|
| Row count | ✅ | as Total rows above |
| Last sync time, and how old the copy is | ✅ | per table: `sync.syncedAt`, `sync.ageSeconds` |
| Sync now, per table | ✅ | `POST /api/sync { tables }` (`mason sync`) |
| Synced / Syncing / Failed / Pending | ✅ | the copy's phase: done / copying / failed / waiting |
| Sync duration | ✅ | `sync.syncSeconds`: how long the sync that brought the copy current took |
| Sync error | ✅ | the current one on the table; its history is the sync events (`mason logs --events`) |
| Size of the copy | ✅ | `bytes` is the SOURCE table's size; the copy's own size per table is measured every 10 min from its blocks (`/api/usage` `copySizes`, `mason usage`), never per request |
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
| Rows scanned | ⏸ | **Decide later: may add cost to every query.** DuckDB reports it only with its profiler on per statement, whose cost is not measured. Measure (about half a day) before promising it. |
| Filters: status, date, user | ✅ | `/api/requests`: outcome, `failed`, since / until, user, client, and paging (`before`) |

## 4. Users

| Field | | Where it comes from / what to build |
|---|---|---|
| List, add (password shown once), remove | ✅ | `mason user`, `/api/users` |
| Added at | ✅ | `addedAt` |
| Last used | ✅ | `lastUsedAt`, the request log's latest row for the user (`?lastUsed=1`); older than the retention is said as such |
| Active / Removed | ✅ | a removed user is kept with `removedAt` |
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

1. **How old each copy is**, in seconds: "can I trust this number?"
2. **Stream lag, and the WAL the replication slot holds on the source**: a slot nobody reads fills the source's disk.
3. **Refused statements grouped by the unsupported SQL they used** (`src/duck/gaps.ts`), so users know what to rewrite.
4. **Sessions open now, restarts, memory against the limit** (`store.memoryLimitBytes`).
5. **Free disk against the copy's projected size** (`copyDiskProjection` computes it already).

## Steps (data and endpoints; presentation later)

Each adds fields to a command's `--json` and the endpoint with the same JSON, with its tests.

1. ✅ **Status and Tables (~2 days)**: row counts after each poll; per table the last sync, its duration and the copy's
   age; totals; query counts and durations over 24 h and 7 d.
2. ✅ **Sync events (~1.5 days)**: copy and poll failures and restarts as rows, kept as the request log is.
3. ✅ **Queries (~2 days)**: filters and paging, ended, Cancelled; the running statements and cancel; bytes sent.
4. ✅ **Users (~1 day)**: last used, removed entries kept, the URL without the password.
5. ✅ **Logs (~1 day)**: the last N lines in memory, an endpoint, `mason logs --json`.
6. ✅ **Samples (~2–3 days)**: every N seconds — storage, rows, queries, bytes sent, lag, memory — and each copy's size
   less often.

## Access (open)

The managed service reads these from `mason serve`, which today answers `/healthz` alone: the endpoints above are
`mason start`'s command server (loopback, the run's token). It needs them served from `mason serve` behind a service
token, and TLS off loopback. Not designed yet.

## Decided

- "User", never "credential" (the CLI's word).
- Billing period: dropped for now.
- A user's password is shown once, when it is added.
- Rows scanned: deferred, a placeholder above.
