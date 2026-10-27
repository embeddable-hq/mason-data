# tests/integration — the real thing against a real Postgres

`npm test` covers the pure logic offline. These tests run the real copy, the real poll and stream, the real listener
and `mason serve` against a Postgres of yours, and hold every answer to what that Postgres answers.

```bash
export IT_POSTGRES_URL=postgres://postgres:<password>@localhost:5432/postgres   # wal_level=logical for the stream
npm run test:integration
```

`IT_POSTGRES_URL` is a libpq URL to a Postgres — locally Postgres.app or a container, in CI a `postgres:18` service
switched to `wal_level=logical`. `psql` must be on PATH. **Every file writes only inside a database it creates on that
server (`it_<name>_<random>`) and drops at the end**, so point it at a throwaway server, never a shared one: its user
needs CREATEDB, and REPLICATION for the stream. DuckDB's `postgres` extension is downloaded once per machine.

**One file at a time** (`--test-concurrency=1` in `npm run test:integration`): each file runs a listener on a port and a
store of its own, and two at once double the machine's load and the chance of a port clash. CI runs the suite as two
jobs, each with a Postgres of its own (`.github/workflows/ci.yml`, `integration`): the oracle, and every other file — a
new file joins the second by itself.

| file | what it proves |
|---|---|
| The copy and the poll (`duck-poll.itest.ts`) | the copy equals the source, row for row, after every kind of change an app makes — an insert, an update, a delete, a primary-key change, a savepoint's row, a transaction open across several polls, a TRUNCATE — and after a restart over the same file (the watermarks are kept); the chunked copy resumes with exactly the ranges no chunk committed, with one, two or three readers. Nothing is created on the source. Needs `IT_POSTGRES_URL` (any `wal_level`) |
| The stream (`duck-stream.itest.ts`) | the copy kept current by logical replication after the same changes, an UPDATE that leaves a large (TOASTed) value unchanged, a restart (the slot resumes; nothing is copied again), a table added while streaming, a project that polled before (caught up by one poll), and every type of the copy arriving through the stream as the copy stores it. Needs `wal_level = logical`; makes and drops its own slots |
| `mason serve` (`duck-serve.itest.ts`) | the server's whole life as a platform sees it: started with its settings in the environment and nothing else, `/healthz` turns 200 once it answers; a table added beside it with `mason add` is copied and counted; the Postgres API answers a token minted from `MASON_API_KEY`; SIGTERM stops it with exit 0, the copy kept; a second serve over the same data folder resumes |
| `to_char` (`duck-to-char.itest.ts`) | Mason's `to_char` is Postgres's: every time pattern and number template over values chosen for their edges, formatted by Postgres itself and by Mason, compared character by character |
| `mason start`'s catalog read (`cli-preflight.itest.ts`) | a partitioned table is listed once with its leaves' rows and size; a never-analysed table is counted, once per run; an analysed one is read from the catalog |
| THE ORACLE (`duck-oracle.itest.ts`, `oracle/`) | every statement Mason answers is held EXACTLY equal to what the Postgres it copies from answers — the same column names, type OIDs, text, rows in the same order, the same refusal (SQLSTATE) — because a BI tool sends Mason the SQL it sends Postgres and reads the answer as Postgres's. Adversarial data (`oracle/data.ts`: NULL beside '' beside a value, case variants, ties, bucket boundaries, 1970 and the far future, negatives, float-unfriendly decimals) is copied by the real copy and served by the real listener; thousands of statements (`postgres-cases.ts`: every construct a tool writes; `oracle/bi-shapes.ts`: what BI tools send, in six shapes (`oracle/shapes.ts`); `oracle/type-matrix.ts`: every type through every path; `oracle/gap-cases.ts`: every documented refusal, which must still be refused) are sent to both and diffed — after the copy and after two rounds of changes. It regenerates the allowlist of what is verified (`src/duck/verified.ts`, `UPDATE_VERIFIED=1`). `IT_ORACLE_ONLY=<regex>` runs a subset |
