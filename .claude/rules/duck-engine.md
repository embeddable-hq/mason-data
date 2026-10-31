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
