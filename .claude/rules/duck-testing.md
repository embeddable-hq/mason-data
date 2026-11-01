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

Run each probe that applies before a push: the harness's implement and fix prompts say so, and its Probe stage runs them
again before each review. Its Learn step adds to this list; each bullet names the PR or issue it was met in.

- A test or oracle statement whose data cannot tell right from wrong (the ON key is the primary key, the GROUP BY keys
  are the star's leading columns, every shape carries a LIMIT, the constant listed is never the sort key): a detector
  that dodges the failing shape (PR 120, 155, 197, 207).
- An oracle shape's name against its table (a "composite key" shape over a table keyed by `id`): a claim its data does
  not hold (PR 170).
- A KNOWN decision or gap case under C, ICU and libc sources: stale or dead off the collation it was written for (PR
  135).
- The allowlist and fixture written from a CI run: that run's head is the commit's (PR 159, 170).
- An oracle helper that answers a question the engine already answers (does a deparsed text mean this modified tree):
  over `SELECT ARRAY[1,2] FROM t`, a hand-written tree equality that skips `location` but not `list_start` calls every
  modified tree unequal. Use the engine's module (`sameTree` / `treeDifference`, `src/duck/rewrite.ts`):
  `tree-equality-derived-again` (PR 261).
- One relation name spelled two ways in the oracle: a quoting call made after the listener replaced
  `QuoteUtils.quoteIdentifier` (DuckDB's keywords) spells `t` one way in the real run and another in the unit world,
  beside the RangeVar's written text at its location. One spelling per relation, from one module:
  `fact-derived-twice` (PR 261).
- An oracle shape's reach claimed from the statement it is built on, not from the base the real run asks: a base the
  loop skips because both sides refuse it (`SELECT * FROM t ORDER BY id COLLATE "C"` over a bigint `id`, 42804 alike)
  is never shaped: `shape-unreachable-in-real-run` (PR 261).
- A shapes table restated from one group of bases: a bare `SELECT * FROM t2 ORDER BY id` over a table with a
  composite, a range and a domain over point is shaped by every star arm, with types no row of the table covers:
  `shapes-table-gap` (PR 261).
- A liveness count that cannot tell rows answered alike from a refusal met alike: a UNION arm both sides refuse with
  42804 or 42601 counts as alive as one that answered rows. The tally says which, and a shape expected to live by
  refusal declares its SQLSTATE: `dead-shape-detector-blind` (PR 261).
- A shape's refusal codes assumed, not read from the bases it reaches: `SELECT j::json, 'x'::text FROM t UNION SELECT
  NULL, 'y'::character(3)` is refused by Postgres with 42883 (no equality operator for json), and the undeclared code
  fails the run with only the declaration left to edit: `undeclared-refusal-expectation` (PR 261).
- A decision's key spelled by two readers (`[<shape>] <regex>` in the leg report; the regex alone in
  `staleDecisions`' message and `staleOrDead`'s merge): a stale `[integer-arm] /c \/ 3/` is named like the base entry
  with the same pattern. One function builds the key: `decision-key-spelled-twice` (PR 261).
- A detector that fires where the PR may not respond: a shape whose every ask meets a decided base difference
  (`SELECT id, c / 3 FROM t … UNION ALL VALUES (…)`, decided under an issue) reported dead and failing the run:
  `detector-without-response` (PR 261).
- A refusal shape alive only once a filed base issue is fixed (`SELECT * FROM t ORDER BY a LIMIT -1`: Postgres 2201W,
  Mason 42804) with no KNOWN entry able to keep it alive, so every push is red. Liveness counts a decided difference,
  or the shape declares the code it meets: `undecidable-shape-liveness` (PR 261).
- A new shape pushed without the base differences it meets decided: every difference in the differences file of the
  run of the head MERGED WITH CURRENT MAIN (`SELECT NULL, 'paid'::character(6), NULL UNION (SELECT id, b, c / 3 FROM t
  ORDER BY id LIMIT 5)`, a numeric's scale lost) is filed once per class and recorded in KNOWN (`shape`, `issue`) for
  every shape and kind it appears under, in the same push: `shape-base-differences-undecided` (PR 261).
- An issue-backed decision written from a run against an older main: main fixes the defect (`TABLE t ORDER BY b, id`
  sorted by code point), the PR's merge ref answers alike, and the stale decision turns the gate red though the PR
  changed no engine code. Read the decisions from the head merged with current main:
  `shape-decisions-stale-on-merged-main` (PR 261).
- A constraint stated in a design note without reading the code it names ("oracle-legs imports only Node's builtins",
  where it imports `src/duck/gaps.ts`; the rule is no node_modules dependency, transitively): it forbids what is
  allowed and misleads the implementer: `misstated-constraint` (PR 261).
