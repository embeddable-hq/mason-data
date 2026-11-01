---
paths:
  - "src/duck/plan.ts"
  - "src/duck/rewrite.ts"
  - "tests/duck-corpus.test.ts"
  - "tests/integration/duck-*.itest.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

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

## What review probes

Run each probe that applies before a push; the harness's Learn step adds to this list.

- A test or oracle statement whose data cannot tell right from wrong (the ON key is the primary key, the GROUP BY keys are the star's leading columns, every shape carries a LIMIT, the constant listed is never the sort key): a detector that dodges the failing shape (PR 120, 155, 197, 207).
- An oracle shape's name against its table (a "composite key" shape over a table keyed by `id`): a claim its data does not hold (PR 170).
- A KNOWN decision or gap case under C, ICU and libc sources: stale or dead off the collation it was written for (PR 135).
- The allowlist and fixture written from a CI run: that run's head is the commit's (PR 159, 170).
