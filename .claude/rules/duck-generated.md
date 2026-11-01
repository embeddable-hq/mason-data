---
paths:
  - "src/duck/generated.ts"
  - "src/duck/generated-plan.ts"
  - "src/cli/generated-files.ts"
  - "tests/duck-generated*.ts"
  - "tests/integration/duck-generated.itest.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

# Generated tables (`mason/generated_tables/`, issue 124, docs/DESIGN.md "Generated tables")

A file names a table and the SELECT that gives it; Mason keeps that table within `target_lag:` of its bases. `kind:
scheduled` re-runs the whole SELECT, and may read another generated table (a chain). `kind: live` is refused until its write path exists.

- **A definition is held to the listener's catalog, as a statement is** (`planDefinition`): the same plan, so the same
  rewrite, the same allowlist and the same text order as a statement of that SQL. A plan is never stored: a run plans
  again, for what the catalog and the stored JSON paths say now. Detector: tests/integration/duck-generated.itest.ts, every
  statement over a table held to Postgres from the same SQL over the base.
- **What a table can't hold is refused at load, by file, key, reason and options, never at a run** (`GeneratedRefusal`,
  `refusalText`), and each refusal stops only its table. A table already built keeps serving and keeps being re-run from
  the definition the ledger holds, so a bad edit costs no freshness. Detector: tests/duck-generated.test.ts.
- **A table has no session.** What reads one (a time zone, a setting, a role, `'now'`) is refused from what Postgres
  RESOLVED, by `pg_proc.provolatile` and the cast's functions, never a list of names (`sessionReads`). `now()` is the run's
  own clock, and a stable function that reads no session goes on `NOT_THE_SESSION`; one marked immutable that reads the
  zone goes on `READS_ZONE_ANYWAY`. A statement the allowlist refuses (`current_time`'s timetz) that also reads a session
  is refused for the session, with its way out: verifying it would not make it a table's to hold. A function Postgres
  marks stable for its arguments' text alone (one over `"any"` or a polymorphic type: `jsonb_build_object`, `concat`) is
  judged by each argument's type's output function (`textReads`, from the plan's `argumentTypes`).
- **Only what a stored cell gives back as Postgres's text is stored** (`STORED_TYPES`): a type goes on it once the oracle
  holds it over a generated table. A cell the plan fills after the engine's answer (`DuckPlan.exact`, `dropLast`) is
  refused, because a plain write would store another value.
- **A run takes its snapshot and its marks on ONE writer's turn**: a commit is in the snapshot or marked for the next
  run, never neither. DuckDB's snapshot is a transaction's first read of a table, never its BEGIN, so the run reads the
  ledger there. A commit that changes a base marks it AFTER that commit, on that writer's turn, in memory, adding nothing
  to a batch's transaction. **A new write path to a copy calls `generated.changed`.** At a restart a base counts as
  changed when its last sync is another than the one the snapshot's turn saw (`basesSynced`), never when it is "after the
  snapshot": a poll's time is its start. Detector: the itest's poll, stream
  batch, held changes and copy made again, each followed by the statements held to Postgres.
- **Lag is the age of the oldest base change not in the table** (`oldest`: a run's changes count until its swap), never
  the snapshot's age: over an idle base nothing is behind and nothing runs. **Across a chain it is the oldest anywhere
  below** (`chainOldest`): a parent's unreflected change is not in its child either, and a parent swapped in without its
  child marks the child at the oldest base change that swap brought, never at the swap's time: the oldest any member of
  the run at or below that parent took, not the parent's own alone (`chainTook`). Measured against the base,
  never summed. `behindSince` is that change's time, what `mason wait <table>` reads (src/cli/readiness.ts
  `generatedReadiness`). Detector: the chain lag tests of tests/duck-generated.test.ts, a restart's included.
- **A child's `target_lag` is never shorter than a generated parent's**: refused at its key (`fresherThan`), with the
  way out, and checked again when any table's target moves (the check's `seen` key holds them). A parent refused in its
  file but deployed is held at the target it runs at, its built one (`targetOf`).
- **The run and the swap are a copy's**: one at a time in the one rebuild queue, behind the copies whose rows it reads, on
  a connection of its own set up as a session, swapped on a writer's turn with its ledger row in ONE transaction. A crash
  leaves the old table and at worst a side table, which `open` drops. Detector: a SIGKILL at each `GeneratedStep`.
- **A failed run keeps the old table, says why and never quotes a row** (`withoutValues`), and waits the back-off a failed
  copy waits. The event is `generated_failed`.
- **A chain is built parents first, at ONE snapshot, and swapped in on ONE writer's turn** (stage 2a). A run of a parent
  builds every child after it in the same transaction (`unitOf`), each planned over its parents' SIDE tables by a change
  to the plan's tree (src/duck/plan.ts `swapRelations`, which throws for a parent it could not swap): never the served
  parent, which is the old one until the swap. A child that comes due while a parent has changes not in it hands its
  run to that parent (`rootOf`). A new definition of a parent swaps in alone and marks its children, whose plans need
  the catalog to say its columns first. A child of a parent refused or failed is not run, and says why in `waitingFor`
  (`blocker`): the entry keeps the parent's NAME only, and why is read when status is (`waitingWords`), never cached
  with it, since `mason wait` exits 1 on it; a child that fails is taken out of its parent's run, which goes on without it. Detector: the chain tests
  of tests/duck-generated.test.ts, and the itest's children held to Postgres over the parent's view.
- **A cycle is refused by name, with the tables in it**: from the SQL's names when the folder is read (`readsByName`,
  `findCycles`), else from what the plan reads at the check (`cycleOf`). A refused table keeps serving what it was built
  from, as any refusal does.
- **A file's name is its table.** A name a synced table holds is refused, and the synced table wins the catalog
  (`served`, `names`) and the table: what was deployed under that name is let go with its ledger row (`release`), and
  nothing is built or swapped over it (`buildable`).
