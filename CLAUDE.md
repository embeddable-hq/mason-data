# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It holds the RULES every session needs — what to do, what not to do, and why in a sentence; each subsystem's rules
are in `.claude/rules/`, loaded when its code is touched (see "Architecture"). The story behind a rule (the incident,
the measurement, the dated decision) is in `docs/DESIGN.md`, under the section the rule names. A doc is not
instructions: where it disagrees with this file, this file wins.

## What this is

Mason is a drop-in replacement for a Postgres read replica, built for analytical queries (the README's "Why Mason"): it
syncs the tables a project names out of a Postgres, keeps them in sync as rows change, and serves them over the
Postgres wire protocol, so a BI tool, an AI agent or an application's analytics code queries Mason with the SQL it
sends Postgres and reads the same answer. It is for scans and aggregates, never an application's own reads and writes
(a point lookup is faster on Postgres, and Mason is read-only). In the code and the commands a synced table is *the
copy* ("Vocabulary"):

```
a Postgres  ──SELECTs (the poll) or its change log (the stream)──▶  the copy (DuckDB, in-process)  ──▶  the Postgres API
```

**One process** (`mason start`, `src/cli/dev.ts`; on a server `mason serve`, `src/cli/serve.ts`, the `mason-data` image):
DuckDB in-process (`src/duck/store.ts`), the sync (`src/duck/sync.ts`: the chunked copy, the xmin poll, the stream of
`src/duck/stream.ts`), the catalog Postgres (PGlite, `src/api/postgres/catalog.ts`: the copied tables' definitions, no
rows), the wire listener (`src/api/postgres/server.ts`), the request ledger (`src/duck/requests.ts`) and the users
(`src/duck/users.ts`). **Postgres decides, DuckDB computes** (`src/duck/plan.ts`): every statement is analysed by the
catalog Postgres, rewritten for DuckDB, run there, and answered with Postgres's names, type OIDs and text; what cannot be
answered exactly as Postgres would is refused by name, from an allowlist the oracle regenerates (`src/duck/verified.ts`,
`docs/SQL-SUPPORT.md`). The README is the front door; `docs/POSTGRES-API.md` is the API; `docs/DESIGN.md` the design.

## Where files live

- **`src/`** is the PRODUCT, one folder per component: `cli/` (the `mason` command: every command, the run, `serve`, the
  sources file; packaged by the root's `cli/` as `@mason-data/cli`), `duck/` (the engine), `api/postgres/` (the listener
  and its catalog), `cdc/` (reading a Postgres: the wire protocol, the poll, logical decoding), `lib/` (shared),
  `web/` (`mason start`'s web page, `mason ui`: plain HTML, CSS and an ES module, served by the run's command server).
  `scripts/` is tooling for developing Mason (`fails-without.ts`, `duck-diff.ts`, `duck-repro.ts`); it may import
  `src/`, never the reverse.
- **A project is a folder**: `mason/sources/<name>.yml` (the database and the tables to copy, committed; the URL stays
  in `.env`, the file names its variable — `src/cli/sources.ts`, one source per project) and `mason/mason.yml` (the
  version); `.mason/` beside it is the machine's (`config.json`, the copy `duck.db`, `users.json`, the logs; gitignored).
  A test makes a project of its own in a temp folder (`tests/cli-*.test.ts`); the integration tests make a database of
  their own on `IT_POSTGRES_URL` and drop it.
- **`docker/mason-data.Dockerfile`** is the image; `deploy/mason-data/` how an application runs it; `.github/workflows/`
  CI, the image and the release.

## Who this is for

**The primary audience is software engineers who build web applications on Postgres**, and the BI tools, AI agents
and customer-facing analytics they point at it. Everything a person or a coding agent meets — the CLI first, but an error message, a log line or a refusal on the
wire too — serves both, and each is owed something different: a person wants feedback and short, scannable output; an
agent wants complete context and a machine-readable form (`--json`, a declared shape, a stable code, an exit code).
`.claude/rules/cli.md` has the mechanics. **Nothing a user sees is named for DuckDB**: the image is `mason-data`, a
command's words say "the copy", never the engine; the engine's name belongs in the code and the docs.

## Scope of work

**Only build what was asked for.** Analysis, measurements, and recommendations are always welcome — but do not create
tables, scripts, or other artifacts that weren't explicitly requested. If a piece of work seems like an obvious
next step or you're unsure whether it's in scope, ask for confirmation or outline the plan first and let the project's owner decide.
("Do it" authorizes the thing under discussion, not everything previously suggested.)

## Licensing

Apache-2.0 (the root `LICENSE`), the copyright holder "Embeddable". A NEW package that someone embeds in their own
application (a client library) would be MIT with its own `LICENSE`; anything that runs Mason is Apache-2.0.

## How work is done here

- **Every change carries its test**, in the matching `tests/*.test.ts` ("Checks and tests"), proved to guard the change by
  `scripts/fails-without.ts`; a change that cannot be tested says why in its commit. A change to docs alone needs none.
- **Work on a branch, in a worktree of its own** whenever anything else may be working in the checkout (another session,
  another agent), and never in another session's worktree: two writers on one tree overwrite each other silently.
- **Commit at natural checkpoints and push, to a PR.** When the branch has no PR yet, push it and create one
  (`gh pr create`). A PR is where a person reviews and another agent comments, and a PR (or a commit on one) can always
  be thrown away or rolled back, where unpushed work can be lost. Don't leave work uncommitted or unpushed at the end
  of a task.
- **Every PR gets an independent review before a person sees it**: a reader in a FRESH context (another agent, or
  the harness's review), given the diff and the code, never the author's conclusions or report, reading for wrong
  answers. The author's own green oracle is not that evidence: three PRs whose oracle runs showed zero differences
  carried eleven wrong answers an independent reader found (docs/DESIGN.md "The independent review"). Each confirmed
  finding becomes an oracle statement and a test; what the reviewer judged correct is said too, so the author does not
  re-check it.
- **One review per PR, its findings in ONE message.** Findings sent to an author in three batches cost three fix
  cycles, each a CI run; collect them, then send once.
- **A brief says what the test must hold, not only what to build.** Name the shapes the oracle must hold up front
  (`.claude/rules/duckdb.md` lists them for a rewrite: the grouped view ordered by its output name, the nulls idiom,
  each collation kind, a prepared statement run after a SET): the first fix round of every PR was for shapes the brief
  had not named.
- **Iterate on a subset, run the full gate once.** While a change is being made, `IT_ORACLE_ONLY=<regex>` runs the
  statements it touches; the full oracle (21,000 statements, minutes) runs ONCE before the push. A measurement's dataset
  is built once and kept until the PR is pushed. Agents that ran the full oracle after every edit and built a 20 M-row
  table twice spent about half an hour each on nothing new.
- **Push early, read while CI runs.** Open the PR as soon as the first commit is green locally (CI is about twelve
  minutes a run, and it gates every merge); read the diff and run the review while it runs; land fix commits in one
  push, not one per finding.
- **Delegate when it is faster, but merge nothing you have not read.** Independent pieces go to sub-agents, each in a
  worktree of its own; the one who merges reads each diff in full, verifies it (the check, and the integration suite when
  the engine or the listener changed), and merges it. A sub-agent's report is its claim, not the evidence. Two
  implementations of two hours each ran side by side; the review-and-fix round after them was the next hour and a half,
  so the time to land a batch is the slowest implementation plus one review cycle, never the sum.
- **Implementation runs on Opus 5.5; every review is Fable's.** A sub-agent or a session that writes code is started
  on Opus 5.5 (`model: "opus"` on the Agent tool, `model: "claude-opus-5-5"` on a session: a session INHERITS the
  coordinator's model when none is named). The independent review of a PR is done by the coordinating session itself
  (Fable) or by a Fable agent, never by an Opus one: the reviewer must outread the author (2026-10-29).

## Git workflow

**A comment Claude writes on GitHub says so in its first line**. GitHub shows everything a session posts as written by
the account it uses, so every issue comment, PR comment, review, inline review comment and reply begins with a heading
naming Claude and the model, e.g. `### From Claude (Opus 5.5)`, before anything else; a reader must never take
Claude's words for those of the person whose account posted them.

**A release is `release-notes/v<version>.md` merged, with `cli/package.json` at that version**; the merge itself tags,
publishes the image and the CLI, and creates the GitHub release (`.github/workflows/release.yml`: nothing after the
merge is done by hand). The notes are for the team RUNNING Mason — what to do before upgrading, what changes for them,
what was wrong and is now right — never what was implemented (`release-notes/README.md`).

## The source database is production, and not ours

**Mason is read-only on the source Postgres**, which is someone's production database: no writes, no DDL, and no fix
that needs a migration, a column, a backfill or a write-path change on the source's side is ever proposed. The one object Mason creates there is its replication slot (its
user needs REPLICATION), and its own publication only when none is named (a named one is read and verified, never
created, altered or dropped). **Keep the load on Mason's side** (overloading the source Postgres is the last thing
Mason may do): a copy reads `MASON_COPY_PARALLEL` chunks at once, one backend each, never the attached scan's ten; the
poll is a full scan of the table, so a table is polled only when its `sync:` says so, and `mason add` writes `sync: off` for
a big one; a SELECT on the source
never carries an `ORDER BY`. `.claude/rules/duckdb.md` "The copy" has the rules and the numbers.

**A real database's data and structures are confidential.** No real table, column or dataset name, and no row, from
any database Mason was run against, in the repo, a commit, a PR, an issue or a test: tests are written over synthetic schemas, and a finding from a real database is said
in sizes and shapes ("a 22 M-row table with two wide JSON columns"). A real database's saved statements may RANK what is
tested (the BI shapes), never appear. **Never print a real deployment's `mason status`, config or logs raw** into a
transcript, a PR or an issue: the Database line names the source's host and user. Filter to the lines you need first; a
filter that failed printed the host once, and a printed line cannot be unprinted.

## Commands

```bash
npm install && npm run check          # typecheck + unit tests, offline, a few minutes
npm run test:integration              # the real copy, stream, listener, serve and the oracle against IT_POSTGRES_URL
                                      #   (a throwaway Postgres; tests/integration/README.md)
node src/cli/main.ts --help           # the mason command from the checkout (every command, by step)
node cli/build.ts                     # the npm package: src/ compiled to cli/dist/
node cli/extensions.ts                # its platform packages (the copy's extensions, checksums pinned) in cli/platforms/
docker build -f docker/mason-data.Dockerfile -t mason-data:dev .   # the image; deploy/mason-data/compose.yml runs it
scripts/fails-without.ts <commit> <test-file>   # proof a test guards a fix: it must fail with src/ as it was at <commit>
```

### Checks and tests

- **`npm run check` (typecheck + tests) must pass.** It is offline. CI (`.github/workflows/ci.yml`) runs exactly that,
  builds the CLI package and the image, and runs `tests/integration/` against a Postgres service, on every PR and on main.
- No ESLint: the `tsc` flags in `tsconfig.json` (`noUnusedLocals`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  …) are the linter. Keep them on.
- Tests are `tests/*.test.ts` under `node --test`, no deps. Extend the matching file when you touch its logic: the
  commands (`tests/cli-commands.test.ts`), every command in every state (`tests/cli-state-matrix.test.ts`, `tests/cli-matrix.ts`
  must name every command), the copy (`tests/duck-copy-order.test.ts`, `tests/duck-sync-*.test.ts`), the listener
  (`tests/duck-wire.test.ts`), the recorded corpus of what BI tools send (`tests/duck-corpus.test.ts`), the refusals'
  registry and its doc (`tests/duck-gaps.test.ts`).
- **The oracle is the arbiter** (`tests/integration/duck-oracle.itest.ts`): every statement Mason answers is held equal to
  what a real Postgres answers — names, OIDs, text, order, SQLSTATE. A fix for a class of statement adds a statement to
  it; `UPDATE_VERIFIED=1` regenerates the allowlist from what it verified.
- **Golden fixtures are change-detectors: update them with `UPDATE_FIXTURE=1 npm test`, then READ THE DIFF**
  (`docs/SQL-SUPPORT.md` is one, rendered from `src/duck/gaps.ts` and `src/duck/verified.ts`).
- **Watch every test fail before you trust it.** When the fix is already in the tree, `scripts/fails-without.ts <commit>
  <test-file>` runs the test with `src/` as it was at that commit and exits 0 only when a test that passes here fails
  there BY NAME. A test FILE that cannot load at the commit is its own verdict, `DID NOT LOAD`, never a proof.

**Script languages**: scripts are TypeScript run directly by Node's type stripping (`#!/usr/bin/env node`, Node ≥ 23.6
in the checkout, no build step, no tsx); the published package is compiled by `cli/build.ts` because Node strips no types
under node_modules. Erasable syntax only (`erasableSyntaxOnly`: no enums, namespaces or parameter properties).

## Architecture — what you need to know before editing

The rules for each subsystem are in `.claude/rules/`, and Claude Code loads one only when a file its `paths:` names is
read or edited. **Before you answer a question about a subsystem, or plan a change to it, without having opened its
code, read its rules file:**
- `duckdb.md` — the engine: Postgres decides and DuckDB computes, the allowlist, the copy in heap order with no index
  and in chunks that resume, memory, the poll and the stream, the request log, users, the oracle.
- `cli.md` — the `mason` command: one interface for people and coding agents, self-documenting commands, one output
  shape, one failure shape, every command in every state, the project folder, the run's command server, `mason serve`.
- `postgres-api.md` — the listener: the catalog is a Postgres, the password is a user's or a token's, TLS off loopback,
  the recorded corpus.
- `web-ui.md` — the web page (`mason ui`): rendered from the command server's JSON in the CLI's words, no framework or
  build, served from an allowlist under the run's guard, `mason start`'s only, and what the full UI adds.

**Where a new rule goes**: a rule about one subsystem goes in its rules file, never here; this file holds only what
every session needs. Write the rule and one sentence of why; the incident, the measurement and the dated decision go in
`docs/DESIGN.md`.

## Conventions (apply to all new work)

- **An error a developer meets says what to do about it** (a design principle of the CLI): the file and the key,
  what is wrong in the developer's words, and the way out — the choices, a `did you mean` (`src/lib/did-you-mean.ts`),
  the exact line to add — on ONE report, so a coding agent fixes it from the message alone.
  A message that needs the log, a stack or a second command to be understood is a bug. Every `mason` command documents
  itself by construction (`src/cli/command.ts`; `tests/cli-help.test.ts`).
- **Two readers, one interface**: a person at a terminal gets feedback (a spinner, a checklist, a bar)
  and short, scannable output (one thing a line, colour, a `Next:`); an agent gets `--json` with a declared shape and an
  exit code. Both get what to run next, from ONE list. The reader is told apart by the stream (`isTTY`) and by `--json`
  only — never by sniffing an environment variable that names an agent. A failure is one shape for both: what is wrong,
  why, the way out, what to run next (`Failure`, `src/cli/command.ts`).
- **A refusal on the wire is Postgres's** (SQLSTATE, message, DETAIL, HINT), and every refusal names its registry entry
  (`src/duck/gaps.ts`): a DuckDB-side refusal without one does not compile; a `PgError` 0A000 in src/api/ without one fails
  `tests/conventions.test.ts` (six older ones are ratcheted there).
- **Never swallow an error.** No bare `.catch(() => {})`, no empty `catch {}`, no `2>/dev/null` or `|| true` over a failure
  you have not reasoned about. **A step that fails must never report success.** If a failure is genuinely tolerable,
  catch it narrowly, say why in a comment, log it, and — if the operation changed state — VERIFY the outcome afterwards.
  `tests/conventions.test.ts` fails CI on an empty `.catch()` handler; everything subtler is on you. **An empty search
  result is not evidence of absence** — `ugrep` may shadow `grep` and return nothing for patterns it dislikes.
- **Fix the class, not the symptom**. Before fixing a bug, name the class it belongs to and the decision
  that would make the class impossible, and prefer that fix when it is within reach; a symptom fix on its own is the
  exception, said as such. Classes already named, and their decisions: a fact derived in several places (one module
  reads it); one input through two preprocessing paths (one grammar at every entrance); "done" asserted by code that
  never exercised the artifact (the contract answers a probe); progress and reasons that lived only in the log (the
  ledger is the record, the commands render it). A bug fixed is a candidate for a convention test
  (`tests/conventions.test.ts`) or a rule; a second bug of a class already named is a failure to apply the decision,
  and says so in its commit.
- **A rule is not done until it has a DETECTOR (a test, a line of `mason status`, a ledger row a reader checks) and a
  RESPONSE (what Mason does when it fires)**; a rule that stays prose is one the next change forgets.
- **Vocabulary**: the *sources file* names what is copied, one *entry* per table; a copied table is *the copy*; changes
  arrive by *the poll* (SELECTs on xmin) or *the stream* (logical replication); a *user* is what `mason user` makes (never "token" or "credentials" in what it
  prints); the *request log* is `_mason.requests`. Name the engine only in code and docs.
- **The sources file is named for a software engineer**: someone who writes SQL against Postgres must recognise every
  key (`kind`, `url`, `tables`, `columns`, `exclude`, `key`) without a BI glossary (no CLI answer says otherwise,
  `tests/conventions.test.ts`). Choose a word in this order: what SQL and the database call it; what an application
  developer's tools call it; then dbt's, where the reader would not stumble. Document a divergence at the key; never coin a term for something that has one.
- **Every setting an operator or installer sets is `MASON_*`**, beside the source's `PG_*` / `DATABASE_URL`; `mason serve
  --help` lists the ones a server sets, with their defaults. A renamed one set under its old name must REFUSE the start,
  never silently run the default.
- **No backwards compatibility before v1.0**: rename freely; validation fails plainly, never with rename hints or
  compat shims. A command's old name answers with the new one and exit 2, never runs.
- **Naming**: snake_case; a table is named as the database names it (`orders`, `billing.invoices`), never renamed in
  the copy.

## Read the verdict before you act on it

A gate you did not read is a gate you did not run. **Make the gate's verdict a branch, not a line of output**: `cmd &&
next`, or check the code in an `if`. Never put a gate and the action that depends on it in one unconditional sequence;
when a wrapper hides sub-commands, its exit code is a summary and the log is the evidence. **A monitoring check must
distinguish "no" from "couldn't tell"**: give every probe an explicit UNKNOWN and treat it as "keep waiting", never as
success or failure.

### Confirm the TARGET of a destructive or outward-facing action

**Name the target, verify it is the one you mean, then act.** The danger is a correct command aimed at the wrong thing
because the target was inferred from an ambiguous description. The same applies to anything that leaves the machine:
confirm what is published and AS WHOM before it becomes permanent.

### A doc claim is a hypothesis until you have checked it against the code

When a documented constraint is about to decide what you do — especially when it makes the job bigger — read the code
that implements it, and fix the doc in the same change. This file included.

## Measuring

- **Measure, never guess**: a copy's throughput, a poll's cost on the source and a query's time were each the opposite
  of what the shape predicted (`docs/DESIGN.md` "Measurements", "Heap order, no index"). Change ONE thing per
  run, against a baseline over the same data; record wall time and the source's statement time separately.
- **A sizing decision reads `store.memoryLimitBytes`**, never `os.totalmem()` or a constant: the operator may have set it.
- **What a copy costs the queries beside it is page-cache eviction, not CPU**: measure a change to the copy's write
  pattern on a machine whose page cache is smaller than its table, never on a laptop whose is not.
- **An APPROXIMATE value cannot be compared for equality**: a float's last bits follow the order it was added in
  (`src/lib/float-equal.ts`); a `numeric` Postgres computes exactly is computed by `src/lib/pg-numeric.ts`, never
  DuckDB's double, and the oracle holds every numeric to Postgres's TEXT.

## Hard-won gotchas (violating these costs hours)

- **A replication slot outlives its reader**, and holds the source's WAL while nobody reads it — for ever, whatever the
  disk. So the SOURCE caps it: `max_slot_wal_keep_size` (Postgres 13+). `mason stop` says the slot stays; `mason destroy`,
  and a start whose sources file has no table with `sync: replication`, drop it, verified gone. A deployment torn down for good must drop its slot.
- **One process per DuckDB file.** The store opens the file once; `mason user` edits `.mason/users.json` beside it and
  the listener re-reads the file, because a second process cannot open the store. A platform runs ONE replica.
- **`pgrep -f <pattern>` matches itself** inside a shell string; **never kill by a broad pattern** — kill by a checked PID.
- **A read-replica source emits permanent benign WARNs** (`could not send wal heartbeat … during recovery`); not a fault.
- **Postgres.app 18** guards passwordless `trust` connections with a macOS dialog that hangs clients; use password auth
  for the `postgres` role.
- **CI runs Node 26, never 24**: Node 24's V8 aborts a process now and then when a WebAssembly instance (PGlite,
  libpg-query) dies on one thread beside another's (`jit_page_->allocations_.erase(addr) == 1`, nodejs/node#66366), so
  that crash on Node 24 is the runtime's, not the branch's (docs/DESIGN.md "The Node CI runs on").
- **The browser and a BI tool cache**: confirm the new code is live (`mason --version`, `/healthz`) before believing a
  measurement.
