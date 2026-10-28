# Observability: the plan

What a team running Mason sees about it: whether it is healthy, how fresh each copy is, what was asked of it, who
asked, and what it costs. This is a PLAN: the data and the endpoints first, the presentation after. Nothing here is
built yet unless it says ✅.

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

Key: ✅ exists · 🟡 derivable from what Mason already records · 🔨 needs building · ⏸ deferred

## 1. Status

| Field | | Where it comes from / what to build |
|---|---|---|
| Healthy / Syncing / Error | ✅ | `readiness` (src/cli/readiness.ts) |
| Tables synced, N of M | ✅ | `/api/state` `tables` |
| Total rows | 🔨 | a copy's `rows` is counted when it is copied and never refreshed by a poll (src/duck/sync.ts `record` at the swap): count after each poll |
| Last successful sync | 🟡 | `_mason.poll_state.polled_at`; in replication mode the stream's last batch |
| Storage used | ✅ | `engine.bytes`, the copy's file |
| Queries, last 24 h / 7 d | 🟡 | the request log (`_mason.requests`); 7 days is its default retention |
| Query duration | 🟡 | the request log: average, and p50 / p95 (an average alone hides the slow ones) |
| Recent errors | 🔨 | query failures are in the request log; a sync failure is kept only as a table's CURRENT error, earlier ones only in the log file: needs the sync events record (step 2) |

## 2. Tables

| Field | | Where it comes from / what to build |
|---|---|---|
| Row count | 🔨 | as Total rows above |
| Last sync time, and how old the copy is | 🟡 | per table: `poll_state.polled_at`, or the stream's per-table state |
| Sync now, per table | ✅ | `POST /api/sync { tables }` (`mason sync`) |
| Synced / Syncing / Failed / Pending | ✅ | the copy's phase: done / copying / failed / waiting |
| Sync duration | 🟡 / 🔨 | a copy's `seconds` exists; a table's poll is not timed (only the whole pass, `lastPassMs`) |
| Sync error | ✅ / 🔨 | the current one exists; its history needs step 2 |
| Size of the copy | ✅ | `bytes` is the SOURCE table's size; the copy's own size per table is measured every 10 min from its blocks (`/api/usage` `copySizes`, `mason usage`), never per request |
| Search / filter | 🟡 | over the list the endpoint returns; no server change for hundreds of tables |

## 3. Queries

| Field | | Where it comes from / what to build |
|---|---|---|
| SQL, started, duration, rows returned, error | ✅ | a request log row (`LedgerRequest`) |
| Ended | 🟡 | started + duration |
| Completed / Failed / Cancelled | 🟡 | `outcome`, and SQLSTATE 57014 for a cancel |
| Running | 🔨 | the listener knows each session's statement in flight (`Session`, src/api/postgres/server.ts); nothing exposes it |
| Cancel | 🔨 | the listener cancels a session's statement for the Postgres protocol already; needs an endpoint and a command |
| User | ✅ | `user`; and the client's `applicationName` |
| Query ID | ✅ | `requestId` |
| Rows scanned | ⏸ | **Decide later: may add cost to every query.** DuckDB reports it only with its profiler on per statement, whose cost is not measured. Measure (about half a day) before promising it. |
| Filters: status, date, user | 🔨 | `/api/requests` takes `limit` and `failed` only: add outcome, since / until, user, client, and paging |

## 4. Users

| Field | | Where it comes from / what to build |
|---|---|---|
| List, add (password shown once), remove | ✅ | `mason user`, `/api/users` |
| Added at | ✅ | `addedAt` |
| Last used | 🟡 | the request log's latest row for the user; older than the retention is said as such |
| Active / Removed | 🔨 | a removal deletes the entry: keep it with `removedAt` |
| Connection string | ✅ | with the password ONCE, when the user is added (kept nowhere); afterwards the URL without it |

## 5. Usage

| Field | | Where it comes from / what to build |
|---|---|---|
| Storage, queries executed | ✅ / 🟡 | as Status |
| Rows returned | 🟡 | the request log |
| Rows processed | ⏸ | as Rows scanned |
| Data transferred | 🔨 | not recorded: the listener counts the bytes it sends a statement, a column of the request log |
| Usage over time | ✅ | a sample a minute in `_mason.usage` (step 6): `/api/usage`, `mason usage` |
| Billing period | — | dropped for now |

## 6. Logs

- `mason start`: the run's log, `.mason/mason.log`. 🔨 an endpoint.
- `mason serve`: the log is stdout, so there is no file. 🔨 the last N lines kept in memory, for both.

## Also worth showing (not asked for)

1. **How old each copy is**, in seconds: "can I trust this number?"
2. **Stream lag, and the WAL the replication slot holds on the source**: a slot nobody reads fills the source's disk.
3. **Refused statements grouped by the unsupported SQL they used** (`src/duck/gaps.ts`), so users know what to rewrite.
4. **Sessions open now, restarts, memory against the limit** (`store.memoryLimitBytes`).
5. **Free disk against the copy's projected size** (`copyDiskProjection` computes it already).

## Steps (data and endpoints; presentation later)

Each adds fields to a command's `--json` and the endpoint with the same JSON, with its tests.

1. **Status and Tables (~2 days)**: row counts after each poll; per table the last sync, its duration and the copy's
   age; totals; query counts and durations over 24 h and 7 d.
2. **Sync events (~1.5 days)**: copy and poll failures and restarts as rows, kept as the request log is.
3. **Queries (~2 days)**: filters and paging, ended, Cancelled; the running statements and cancel; bytes sent.
4. **Users (~1 day)**: last used, removed entries kept, the URL without the password.
5. **Logs (~1 day)**: the last N lines in memory, an endpoint, `mason logs --json`.
6. ✅ **Samples (~2–3 days)**: every N seconds — storage, rows, queries, bytes sent, lag, memory — and each copy's size
   less often.

## Access (open)

The managed service reads these from `mason serve`, which today answers `/healthz` alone. It needs the endpoints
served there behind a service token, and TLS off loopback. Not designed yet; it decides whether steps 1–6 land on
`mason serve` at once or `mason start` first.

## Decided

- "User", never "credential" (the CLI's word).
- Billing period: dropped for now.
- A user's password is shown once, when it is added.
- Rows scanned: deferred, a placeholder above.
