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

## What review probes

Run each probe that applies before a push: the harness's implement and fix prompts say so, and its Probe stage runs them
again before each review. Its Learn step adds to this list; each bullet names the PR or issue it was met in.

- Each probe at the base as well as the head: a refusal the change turns into an answer must equal Postgres's, an answer
  it turns into a refusal is a regression, and a difference both share is the base's (PR 120, 170, 197).
- Each rules-file, DESIGN or release-note sentence the change touches, read against the code's branches: a sentence
  still stating what the change removed, or wider or narrower than the code; a design note's or commit's "the class is
  closed" read against every reader of the class, a LIMIT body's `sortKeys` beside a WITH TIES body's keys
  (class-claim-overstated; PR 146, 161, 163, 170, 233).
- Each type, field and module a design note names, opened at the line it cites (`PlannedStatement.dropLast` where the
  plan's type is `DuckPlan`): a name the code does not have, so the plan changes a field nobody reads (wrong-type-name;
  PR 233).
- Each authority a design note names for a fact, asked for that fact on the shape (`FETCH FIRST 2.5 ROWS`'s int8 target
  from `typeOf`, which gives the count's numeric source type; the analysed `limitCount` holds int8): a module named for
  a fact it does not hold (authority-misnamed; PR 233).
- A name the rewrite writes, written by the user: an output `l.id AS __mason_row` or `AS __mason_rank` under `ORDER BY
  l.c OFFSET 1 FETCH FIRST 1 ROWS WITH TIES`, a FROM item `late AS __mason_late` or a CTE so named in a WITH TIES over a
  join, in another case (`"__MASON_LATE"`): a rewrite column or alias read back by a name the user's shadows
  (rewrite-name-in-user-namespace; PR 233).
- The head merged with `origin/main` before the probe (`git merge-tree`), and a statement main fixed in the same files
  (`SELECT s.q * 2 AS d FROM (SELECT l.k / 7.0 AS q FROM late l ORDER BY l.c LIMIT 3) s`) asked of the head: a branch
  behind main answering wrong where main answers right, and a conflict whose resolution drops main's fix
  (branch-behind-main; PR 233).
