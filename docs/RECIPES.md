# Recipes

How the common changes are made here: the files in order, a real function to copy, what the tests must hold, and what
reviews caught last time. Each is a checklist, not a rule: the rules are `.claude/rules/`, and each recipe names the file
to read. For how a statement or a sync moves through the code, see `docs/FLOWS.md`.

Every change: a test proved by `scripts/fails-without.ts` once on the final tree, and a fresh-context review before a person
sees it (`CLAUDE.md` "How work is done here").

## Add a sources key

Read `.claude/rules/cli.md` ("What a project syncs is ONE sources file"). Walked against PR 36 (`sync:`) and PR 72
(`database:`). Copy `sync` for a value that is parsed, `key` for one checked against the catalog.

1. **Name it** by `CLAUDE.md` "The sources file is named for a software engineer".
2. **`src/cli/sources.ts`: the shape.** Add it to `KEYS` (top) or `ENTRY_KEYS` (entry), and to `SourceFile` or `TableEntry`.
3. **`parseSourceText`: the read.** Add every problem to `problems` at its key, never throw: one report (`sourceFailure`).
   A value with a grammar gets a parser in `src/lib/` that answers `{ problem }`, as `parseSync` does.
4. **`entryProblems`: the catalog's check**, if the database can refuse it. An edit is held to the same check.
5. **`addedTables`: into the run.** A field the engine reads goes on `AddedTable` (`src/duck/sync.ts`).
6. **What writes the file:** `entryText` and `withTable` for an entry key, `newSourceText` for a top key and for the comment
   at the top of a new file. Every other byte stays as it was (`withEntrySync` shows how to edit one key).
7. **The other entrances.** `mason add` takes a flag if a person sets it per table (`addSpecs` in
   `src/cli/commands.ts`, `addEntry` in `src/cli/source-edit.ts`). Both of `POST /api/pick` and the command with Mason
   down go through `addEntry`.
8. **A top key the run reads at its start** has more entrances (PR 72's walk): `mason init` (`src/cli/init.ts`), `mason serve`
   (`serveSettings`, one report), and `mason start`, which refuses in the parent (`src/cli/background.ts`) before it spawns.
9. **A change while running.** Decide what an edit does: `rereadSources` hands it to `Sync.setTables`. A change that keeps the
   copy goes through the sync-change branch there; one that re-reads the table goes through `needsCopy` and `columnsKey`.
   A key read only at the start says so when the file disagrees with the run.
10. **What it says.** `mason status` and `--json` (the status recipe below), EXPLAIN (`src/duck/explain.ts`) and the web page
    if it changes how a table is kept, the header comment of `src/cli/sources.ts`, `src/cli/guides.ts`, the demo
    (`src/cli/demo.ts`, `src/demo/seed.ts`) if it refuses a value or needs one.
11. **Docs:** `README.md`, `cli/README.md`, `deploy/` if a server sets it, the rules file.

**Tests:** `tests/cli-sources.test.ts`: a misspelling with its `did you mean`, a wrong type, two mistakes on one report, each
asserted on its whole text. `tests/cli-commands.test.ts`: the same refusal from both entrances, a person's and `--json`.
`tests/cli-state-matrix.test.ts` if a flag was added (`tests/cli-matrix.ts` carries it). `tests/duck-sync-added.test.ts`
drives a real `Sync` through a change of the key. For a top key: `tests/cli-dev.test.ts`, `tests/serve.test.ts`.

**Reviews caught:**
- A way out that said "write `sync: …` at the top" of a file that already had one, so following it made a file the run
  refuses. Say the edit, read from the file (`sourcesTop`, `topEdit`), and test each way out applied as written.
- `mason add --sync` on an entry with no value lost the comment on its line.
- Two spellings of one value read as a change (`05s`, `5s`), and a value past a `Date`'s range broke every status line.
  Hold one written form and a bound.
- A setting the file replaced, still set under the old way: it must refuse (`pollMsRetired`, `removedStartFlags`).
- A change reported at every start, because a record was compared when nothing was owed.
- An upgrade that changes behaviour silently: `mason start` must say it, in its output and the log.

## Add a status field

Read `.claude/rules/cli.md` and `docs/OBSERVABILITY.md`. Walked against `disk` (185bf79), `sessions` (e0c8eab) and `kept`
(c3f78da): 7 to 14 files each. **Copy `disk`.**

1. **Derive it once**, where the fact lives: `Sync` (`diskStatus`, `keptOf`), the listener (`openSessions`) or the run. Never
   a second computation in a reader (`CLAUDE.md` "Fix the class": a fact derived in several places).
2. **Put it on the run's state:** `RunContext` and `runState` in `src/cli/run-server.ts`, and on `CopyState` for a per-table
   fact. The page polls `/api/state` every 2 s, so nothing here reads the source or scans the ledger. A slow read is an
   endpoint of its own, as `/api/queries` is.
3. **Wire it in the run:** `src/cli/dev.ts` builds the `RunContext`. Fakes of it are in seven test files, and each needs the
   new member: grep `RunContext` in `tests/`. Four are casts that `tsc` will not catch: `tests/duck-sync-added.test.ts`,
   `tests/web-page.test.ts`, `tests/cli-ui.test.ts` and `tests/cli-state-matrix.test.ts`.
4. **Type it:** `RunState` in `src/cli/commands.ts`.
5. **Render it** in an exported renderer beside `diskRows` or `masonRow`, called from `status`. The web page uses the same
   words (`src/web/pages/status.js`, `.claude/rules/web-ui.md`).
6. **Declare it:** `STATUS_USAGE`'s `--json` text, and the `json` list of `STATUS` for a new top-level key (`jsonText` and
   `tests/cli-help.test.ts` hold both).
7. **Sample it?** A number worth a chart: `usageFacts`, `src/duck/usage.ts`, `src/cli/usage.ts`. A number for a scrape:
   `metricsFacts`. `src/cli/metrics.ts` holds to numbers only.
8. **Docs:** `docs/OBSERVABILITY.md`, and the rules file if it carries a rule.

**Tests:** the deriving unit (`tests/duck-sync-facts.test.ts`, `tests/duck-usage.test.ts`, or `tests/duck-wire.test.ts` for
the listener). `tests/cli-run-server.test.ts`: the state's shape, with a fixture that is what the real source emits.
`tests/cli-commands.test.ts`: the line, and `--json`. `tests/cli-state-matrix.test.ts` holds a table just added and just
removed. `tests/web-page.test.ts` if the page shows it.

**Reviews caught:**
- A field right for the common case and wrong for the rest: `kept` said `by: poll` of a table waiting for its first copy,
  which every text reader hid by checking the phase first and an agent reading `--json` did not. Test every phase of
  `CopyState`, and each sync mode.
- "never synced" at 100 %: a time set only when the pass re-read the ledger. Set it at the moment it becomes true.
- A fixture hand-written to a shape the real code does not emit. Build it from what the source emits (73d0459).
- A read a scrape could trigger on the source: `/metrics` opened a connection per scrape. Answer from the cache (26af19b).

## Add a rewrite rule

Read `.claude/rules/duckdb.md` "A statement" and "What is not supported". The map is `docs/FLOWS.md` "The plan". Copy
`truncInstant` for a form computed natively, `textMinMax` for a function with collation, `regexpMatch` for a function
whose forms are refused by name.

1. **Ask Postgres first:** the answer's names, OIDs, text, order and NULLs.
2. **Place the rule:** a case in `Rewriter.rule`, or `funcCall`, `aExpr`, `typeCast`. A decision that looks across the
   statement is a pre-pass in `rewrite` beside `markBounds`, because the walk meets a CTE before the SELECT that reads it.
3. **Read types from the analysis** (`typed`, `typeOf`), never from a name. Use `this.cp` for a node placed twice. Compare
   through `comparable`, `equalKey` or `sortKeys`, so a jsonb and a collation are not missed.
4. **A helper** is a JavaScript function in `src/duck/functions.ts` or inline SQL, never a macro. Each call costs a trip to
   the worker: prefer DuckDB's own form where it is Postgres's answer.
5. **Refuse what is not exact:** `Unrewritable` with a `GapId`, an entry in `src/duck/gaps.ts`, a statement in
   `tests/integration/oracle/gap-cases.ts`.
6. **The allowlist:** a new function, operator or cast is `unverified` until the oracle verified it. Add its statements, run
   `UPDATE_VERIFIED=1`, then read the diff of `src/duck/verified.ts`: a piece is as wide as every statement that uses it.
7. **Fixtures:** `UPDATE_FIXTURE=1` regenerates `docs/SQL-SUPPORT.md` (on `npm run check`) and
   `tests/fixtures/oracle-duckdb-alone.json` (on the oracle). Read both diffs.
8. **For speed:** the plan fixture too (`tests/duck-plans.test.ts`, `tests/fixtures/duck-plans.json`). The oracle is blind to
   the plan.

**Tests:** `tests/duck-wire.test.ts` against PGlite for the SQL sent. Statements in `tests/integration/duck-oracle.itest.ts` or
`tests/integration/oracle/bi-shapes.ts`, columns they need in `tests/integration/oracle/type-matrix.ts`. Iterate with
`IT_ORACLE_ONLY`; run the full oracle once. `tests/integration/oracle/shapes.ts` asks each statement again as a subquery, a
CTE, a UNION, with parameters, by name and ordered, so those need no statement of their own.

**The shapes the brief must name** are `.claude/rules/duckdb.md`'s, under "A statement": "in the shapes a BI tool sends".

**Reviews caught:**
- A strict function not strict: `date_trunc` with a NULL zone answered the instant (d95fda6).
- A pre-pass done in the walk: `limitBounds` missed a CTE read by another CTE (8819fd9).
- A piece verified over scalars unlocking other forms: `ARRAY(SELECT …)` of a numeric (713a594).
- A comparison the allowlist cannot see: a jsonb in `UNION ALL … ORDER BY 1`, or in a row (40e76ec).
- A new refusal of what `main` answered: equality under libc, for a string only an order must read (40e76ec).

## Add a session setting

Read `.claude/rules/postgres-api.md` ("What a tool sets", "A session's settings have ONE reader"). Walked against PR 46
(`current_setting`) and PR 60 (transactional settings). **Copy `statement_timeout`** for a setting that changes behaviour,
`timezone` for one that changes answers.

1. **Decide what it is.** Honoured, or refused with `0A000` and a way out (`datestyle`), or accepted and remembered because
   no answer changes. It is never silently ignored.
2. **`setParameter`** (`src/api/postgres/server.ts`): add a `case`. Validate at the SET; a value Postgres refuses gets
   Postgres's SQLSTATE and message. `atStartup` covers the startup packet and `options`.
3. **`decidesHere`**: a name this listener decides skips `validateElsewhere`, the catalog's check.
4. **Holding it:** `vars.other` needs nothing more. A new field on `Vars` needs `defaultVars`, `copyVars` (a copy per RESET, and
   per block under PR 60) and an entry in `FIXED`, or `SHOW` and `current_setting` will not see it.
   **Reading it:** only through `sessionSetting`; `tests/conventions.test.ts` holds the readers.
5. **A driver-visible parameter** goes in `REPORTED`, so `ParameterStatus` is sent (`reportChanges`). The startup list is
   pinned in `tests/duck-wire.test.ts`.
6. **If it changes an answer on DuckDB:**
   - add it to `settle` (`src/duck/store.ts`) so the connection holds it;
   - decide whether a plan depends on it. If so, it joins the key in `Server.duckPlan` and `Statement.plannedUnder`, as
     `timeZone` does. A statement prepared before the SET must still answer correctly;
   - a value the statement reads at run time is `current_setting`, through `settingRead`.
7. **A new SET form** is `translate.ts`: `setStatement`, and `setConfig` for `set_config`.
8. **A time or a bound** is armed per statement, as `armTimeout` is. A catalog statement runs at its Bind, past it.
9. **Docs:** `docs/POSTGRES-API.md`, and `docs/SQL-SUPPORT.md` through its gaps if a form is refused.

**Tests:** `tests/duck-wire.test.ts`, against PGlite: SET, `SHOW`, `current_setting` in the catalog and beside a table, `RESET`,
`RESET ALL`, `DISCARD ALL`, the startup packet, `options`. The oracle's setting cases in
`tests/integration/duck-oracle.itest.ts`, including a named prepared statement after a later SET, and `SET TO DEFAULT`.
`tests/postgres-api/server.test.ts` for a refusal.

**Reviews caught:**
- A SET reaching the shared catalog: `set_config` ran as its superuser and stayed for every session (f94a9c9). The catalog is
  one connection, and a value there is everyone's.
- A placeholder (`myapp.x`) left defined with `''` for every session by a SET the catalog validated.
- A fourth reader answering its own value after a SET (issues 40, 41).
- `ParameterStatus` sent at the wrong moment: once per request, after CommandComplete, before ReadyForQuery.
- A check placed on a statement kind, not a message: a failed block's 25P02 sat where a catalog statement's Bind never
  reached it (PR 60, the Bind fact in `docs/FLOWS.md`).

## Add a command

Read `.claude/rules/cli.md`, the opening bullets and "Errors". Walked against `mason cancel` (3b4d39f), `mason usage`
(4cfd94e) and PR 71 (`mason share`). **Copy `src/cli/cancel.ts`** for a command that asks the run. For one that needs only
the project, copy `mason add`.

1. **A file of its own** in `src/cli/`, with a header comment saying what it does and what it reads.
2. **`CommandSpec`:** `name`, `summary`, `usage` (with an example and every option), `options`, `json`, `needs`. Its parser is
   `parseCommand`, so an option cannot exist without the spec. `needs` is what it reads, not more.
3. **Output:** `reportText` for a person, `jsonText` for `--json`, `failed` for every failure. Never a command's own shape,
   and a `Next:` for what to run after (`NextStep`). A new failure code goes in `FAILURE_CODES`.
4. **`src/cli/registry.ts`:** add it to the right step of `STEPS`. `COMMANDS`, `mason --help` and `mason help agent` are
   derived.
5. **If it asks the run:** an endpoint in `createRunServer` (`src/cli/run-server.ts`), called through `callRun`
   (`src/cli/control.ts`), reached through `reach` (`src/cli/state.ts`). A refusal is `sendFailure`. What the endpoint needs of
   the run goes on `RunContext`, built in `src/cli/dev.ts`.
6. **Words:** "sync" for what happens to a table's data, "the engine" never named to a user (`tests/conventions.test.ts`).
7. **Docs:** the commands table in `README.md`, `cli/README.md`, the rules file's list of commands and `STEPS`, and
   `src/cli/guides.ts` if a guide names the step.

**Tests:**
- `tests/cli-matrix.ts`: a line in `MATRIX_ARGS`, or `tests/cli-state-matrix.test.ts` fails. Add `MATRIX_MORE` lines for modes.
- `tests/cli-help.test.ts`: the expected order of `COMMANDS` is a list there.
- `tests/cli-commands.test.ts`, or a file of its own as `tests/cli-mcp.test.ts`: the answers as a person and with `--json`, and
  each refusal on its whole text.
- `tests/cli-run-server.test.ts` for an endpoint: its auth, its 4xx shape.

**Reviews caught:**
- A race between what a list showed and what the command acts on: `mason cancel 12` stopped whatever session 12 ran by then,
  hence `--statement` (a 409 if it moved).
- A false reason: `mason sync` said "its first sync has not finished" of a table being read again (2acf1c1).
- A next step that did not apply: `mason add --sync` alone said `mason wait`, when no copy starts (3bf3b65).
- A bad setting caught late: a wrong `MASON_HISTORY_DAYS` failed after the copy opened, and `mason serve` never checked it. One
  function reads a setting at every entrance, and it refuses before anything opens (202cc96).
- Errors flattened: a Postgres refusal said as "did not answer". Keep each class of failure apart (53dcca3).
