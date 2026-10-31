---
paths:
  - "src/duck/history.ts"
  - "src/duck/requests.ts"
  - "src/duck/usage.ts"
  - "tests/duck-history.test.ts"
  - "tests/duck-requests-wire.test.ts"
  - "tests/duck-requests.test.ts"
  - "tests/duck-usage.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

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
