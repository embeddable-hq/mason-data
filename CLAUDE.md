# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It holds the RULES every session needs — what to do, what not to do, and why in a sentence; each subsystem's rules
are in `.claude/rules/`, loaded when its code is touched (see "Architecture"). The story behind a rule (the incident,
the measurement, the dated decision) is in `docs/DESIGN.md`, under the section the rule names. A doc is not
instructions: where it disagrees with this file, this file wins.

## What this is

Mason is a drop-in replacement for a Postgres read replica, built for analytical queries (the README's opening): it
syncs the tables a project names out of a Postgres, keeps them in sync as rows change, and serves them over the
Postgres wire protocol, so a BI tool, an AI agent or an application's analytics code queries Mason with the SQL it
sends Postgres and reads the same answer. It is for scans and aggregates, never an application's own reads and writes
(a point lookup is faster on Postgres, and Mason is read-only). In the code a synced table is *the copy*; in what
a user reads it is *the synced table*, its rows *the synced data* ("Vocabulary"):

```
a Postgres  ──SELECTs (the poll) or its change log (the stream)──▶  the synced data (DuckDB, in-process)  ──▶  the Postgres API
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
command's words say "the synced data", never the engine; the engine's name belongs in the code and the docs.

## Scope of work

**Only build what was asked for.** Analysis, measurements, and recommendations are always welcome — but do not create
tables, scripts, or other artifacts that weren't explicitly requested. If a piece of work seems like an obvious
next step or you're unsure whether it's in scope, ask for confirmation or outline the plan first and let the project's owner decide.
("Do it" authorizes the thing under discussion, not everything previously suggested.)

**What a session finds, it acts on, without being told** (2026-10-30). This is an exception to the rule above, for what
is found along the way. A bug with an obvious fix gets a session of its own to fix it; anything else that needs
investigating, including a bug whose fix is not obvious, gets a GitHub issue saying what was seen, what is not known and
what done looks like. An issue is headed as a comment is ("Git workflow"), says a real database's findings in sizes and
shapes ("The source database is production"), and is filed once, after a look for one that already names the thing.
Neither waits for the owner to ask, and neither stops at a line in a message, which is forgotten: the task in hand goes
on, the reply names what was filed or started, and the fix's PR is reviewed and merged as any PR is ("Local gates"). A
review's findings are the PR's and go to its author in one message ("How work is done here"), not here.

## Licensing

Apache-2.0 (the root `LICENSE`), the copyright holder "Embeddable". A NEW package that someone embeds in their own
application (a client library) would be MIT with its own `LICENSE`; anything that runs Mason is Apache-2.0.

## How work is done here

Four guidelines, then the loop every PR goes through. Why each is so, with its incident and its numbers, is in
docs/DESIGN.md ("The independent review", "Local gates").

1. **Nothing lands unproved.** Every change carries its test in the matching `tests/*.test.ts` ("Checks and tests"),
   seen failing without the change (`scripts/fails-without.ts`); a change that cannot be tested says why in its commit,
   and docs alone need none. Every PR is read by an independent reviewer, and in full by whoever merges it: an author's
   report and its green oracle are claims, not evidence.
2. **Fix the class, not the symptom** ("Conventions"). A finding names a failure, never a patch, and the reviewer names
   its class. A second finding of one class on a PR ends the patching: the next round fixes the class.
3. **Work where nobody else writes, and push it.** A branch, in a worktree of its own whenever anything else may be
   working in the checkout, never in another session's worktree (two writers on one tree overwrite each other
   silently); commit at checkpoints and push to a PR (`gh pr create`), since unpushed work can be lost and a PR can be
   rolled back.
4. **Nothing waits unwatched, and nobody watches.** Every wait has a bound, and a job past it is a hang: a background
   job reports only when it exits, and a deadlocked one never does. No session sits in a wait on a run, and no session
   that waits on anything ends a turn without a background job that will wake it ("The loop", step 5).

### The loop

1. **Brief.** Name what the tests must hold, not only what to build: the shapes the oracle must answer
   (`.claude/rules/duck-rewrite.md` lists them for a rewrite), and the tests the runs use, by `--test-name-pattern` and
   `IT_ORACLE_ONLY`. Then a **design note**, before any code: the decision; for each fact the change needs, the module
   that is its AUTHORITY (Postgres's analysis, `pgErrorOf`, the engine's prepared types), never a new derivation; the
   principles and named classes it honours; the shapes (each form, wrapper and type, in the real run and the unit
   world); what is out of scope. Fable reviews the note against the code it names; after two rounds the work goes on,
   carrying what is still open.
2. **Implement**, on Opus 5.5 (`model: "opus"` on an agent; `model: "claude-opus-5-5"` on a session, which otherwise
   inherits the coordinator's), in its own worktree, ending at the push with the PR and its head; the note goes in its
   body under `## Design`. Push as soon as the first commit is green locally ("Local gates" says which gate when); the
   review runs while CI does. Independent pieces run side by side: a batch lands in its slowest piece plus one review,
   never the sum. Before each push the author runs the `## What review probes` of each rules file its paths fall
   under; before every review a fresh Opus **probes** the head with them again, and what it finds of the PR's is fixed
   first: at most two rounds a push, never counted as review rounds. A probe that fails is noted, never a stop.
3. **Review**, by Fable (the coordinating session or a Fable agent, never Opus: the reader must outread the author),
   in a fresh context given the diff and the code, never the author's report. It and the probe RUN statements, never
   judging by reading alone: batched through `scripts/duck-repro.ts` at the head and the base, only the differences
   read, hundreds in a full review; in the variant forms no author wrote, and a regression sweep of each touched
   path's plain form, where a statement the base matched and the head does not blocks (`pr-loop.js` `VARIANT_FORMS`,
   `BATCH`; the record counts them). Its ONE report gives, for each finding,
   the failing input and the two answers (for the engine: the statement, Postgres's answer and Mason's), the
   finding's class and its severity (step 4: blocking or not); and what it judged correct, so nobody checks that
   twice. Each confirmed blocking finding becomes a test and, for the engine, an oracle statement. CI is read beside
   it: a red run goes back with the review's findings, and beside a clean review it is read again by the CI stage.
4. **Fix.** **Only a blocking finding sends the PR back**: a wrong answer (where Mason answers, its rows, text, types
   or OIDs, order or SQLSTATE differ from Postgres's), a crash, hang or stuck state, synced data lost or corrupted, a
   security hole, a regression (what the base got right is now wrong or refused), or a red CI; when the reviewer is
   unsure, it blocks. A refusal's wording, reason, HINT or DETAIL (the refusal itself right), an over-refusal (safe, and
   a gap), docs and code quality do not: they are filed, one issue per class, and the PR goes on, since a round spent
   on wording holds back a PR whose answers are already right (docs/DESIGN.md "Passing the review the first time").
   The blocking findings go to the author in ONE message, as failures and their class, never the edit (for a change to
   prose, the words are the failure): an author handed a patch applies it, and the class goes unfixed. The message
   carries the note and every earlier round's findings and judged-correct list. The author comes back in ONE push, not
   one per finding. The second blocking finding of a class on a PR makes the next round a CLASS round: it first writes
   down every case of the class, in the PR, gives each a test, then fixes the decision that makes the class
   impossible, naming its authority and checked against the note; give it room (about 60 calls). Every fix commit gets
   a narrow re-check, the same way. Once the reviews are clean (nothing blocking), each blocking class met is
   **learnt**: a bullet in its rules file's `## What review probes` (a synthetic shape, the class, the PR), in one
   commit before CI whose files, read from git, must all be under `.claude/rules/`. Detector: the reviewer's classes
   and severities, read across a PR's rounds (`tests/workflows.test.ts` holds the harness to them).
5. **Merge.** Read the diff in full, then queue it pinned to the head read:
   `gh pr merge <n> --auto --merge --match-head-commit <sha>`. A queued merge survives a later push, so a PR sent back
   has it withdrawn (`gh pr merge <n> --disable-auto`) and queued again once the fix is read; who may merge what is
   "Local gates". Bind the PR to the session (the app's monitor then brings a failure, a conflict or a comment, never a
   green run or a merge), and go on with other work. While a merge is queued, a run's verdict is awaited or a lead is
   working, leave one bounded background job per thing, which exits when it changes: a loop on `gh pr checks` ("Local
   gates"), `gh pr view --json state` for a merge, `git ls-remote` for a lead's new head. Its exit wakes the session,
   where an auto-merge and another session's report may not; when its bound passes with nothing changed, look, and
   leave another. Detector: the Stop hook `scripts/hooks/wake-up.ts` warns when a turn ends after a queued merge or a
   message to a lead with no background job started since and still running; a warning, never a block, because it
   reads the transcript by heuristic.

The coordinator runs the loop with the Workflow tool: `.claude/workflows/pr-loop.js` for one PR, and
`.claude/workflows/issue-loop.js` for an issue's tasks, planned first and read by the coordinator, then run. In them
the brief, the plan and the design note are Opus's and only the reviews, the design's included, are Fable's. After the
implement push, GitHub itself must list the PR as closing its sub-issue (`closedByPullRequestsReferences`; for a
stacked PR, which GitHub links only once it targets the default branch, the body must say `Closes`), or the body is
fixed, or the run stops. Every exit with a PR posts a `Review record` comment on it, whose `json mason-review-record`
block `scripts/review-stats.ts` reads. The number to watch: of the PRs that reached a review, the share whose first
review found nothing blocking of theirs, and whose first or second did. Every finding carries its severity, and only
the PR's blocking ones make a fix round, count toward the class rule, or keep a round from being clean; its others are
filed, one issue per class saying the PR's review met it and deferred it, and listed in the Review record. A finding
the base already has is filed the same way, at whatever exit the run takes, and is never fixed in the PR nor counted
toward its class rule: a PR that chases a class it did not make grows each round. Classes carry across a stack, so a class met on the PR below counts
on the one above. A teammate needs Claude Code with the Workflow tool, the Opus and Fable models, and `gh`
authenticated with the `project` scope for the board. Why: docs/DESIGN.md "The independent review". Detector:
`tests/workflows.test.ts`.

**The board says where each piece is**, so the owner reads progress there instead of asking: the [Mason work
board](https://github.com/orgs/embeddable-hq/projects/4). An issue split into pieces has one sub-issue per PR
(`scripts/board.ts sub <issue> "<issue> · <piece>" --from "<model>"`), and its PR says `Closes #<sub-issue>`. Each move
is made where it happens, with `scripts/board.ts status <n> "<status>"` run from a file, never `node <(git show …)`,
which exits 0 having run nothing: **Implementing** when an agent starts, **In review** with the review, **Fixing** when
findings or a red CI go back, **CI / queued** with the merge, **Done** once it is confirmed (the board's "item closed"
workflow is off), and **Needs Tom** for anything that waits on the owner's word. The parent is **In progress** while any
piece is, and **Done** with its last.

## Local gates

One laptop is shared by every session, and one gate fills it: gates are the largest single use of a session's time
(docs/DESIGN.md "Local gates" has the measurements). **CI is the full gate**, and a local gate runs for a reason. Each
rule says what detects it, or why nothing does: most are habits that only a session's transcript shows, which no test
reads. Some detectors are Claude Code hooks, wired in `.claude/settings.json` from `scripts/hooks/`
(`tests/hooks.test.ts`): a PreToolUse hook blocks the command, and its one-line message says what to run instead; the
Stop hook only warns. They resolve against `$CLAUDE_PROJECT_DIR`, the main checkout even from a worktree, so a main
checkout on a branch without `scripts/hooks/` prints a hook error on each Bash call and each turn's end (not a block).

- **While working, the tests nearest the change**: `node --test --test-timeout=<ms> <file>`, with
  `--test-name-pattern` for one test, and `IT_ORACLE_ONLY=<regex>` for the oracle's statements it touches. The
  timeout goes BEFORE the files, since Node ignores it after them, so `npm test` cannot take one (issue 139); the hook
  `scripts/hooks/test-timeout.ts` blocks a `node --test` without it before its files, and `npm test`. **A full
  integration run is not an iteration tool**, and neither is the full oracle. A measurement's dataset is built once and
  kept until the PR is pushed. Nothing detects that; a transcript found it.
- **A test past its bound is read, not repeated.** Compare CPU with elapsed time on the test's own process, not the
  wrapper (`pgrep -P <pid>` down to it, then `ps -o time,etime -p <pid>`): a hung test uses none, though nor does one
  waiting on I/O. A hang is the change's to fix, or a flake (below).
- **A wait on CI is a `gh pr checks <n>` loop with a deadline**, without `--watch`: it exits 0 when all passed, 8 while
  any is pending, 1 on a failure, and also 1 with "no checks reported" just after a push, which is a wait, not a
  failure. `--watch` exits on that at once, and an alarm `exec`'d into `gh` (a Go program) is ignored, so neither bounds
  it. Nothing detects it; three waits, each wrong a different way, were found by reading the transcript.
- **One full `npm run check`, before a PR's first push.** A fix round after a review or a merge of main gets
  `npm run typecheck`, `node --test tests/conventions.test.ts tests/cli-state-matrix.test.ts` and the test files of the
  change, and CI carries the full suite: the few real catches a full local run made in another file were all such fast
  checks. Which files are nearest is the author's judgement, not a guarantee: a recent change imports its way to most of
  the unit tests, so no list can be computed, and CI catches the rest. Detector: `checks` red on the PR.
- **No session runs the full oracle locally; CI runs it on every push**, in two legs. An engine or listener change
  (`src/duck/`, `src/api/`, `src/cdc/`) runs only `IT_ORACLE_ONLY=<regex>` for the statements it touches, and of the
  other integration files those nearest the change; the rest is CI's. When what is answered moved, the allowlist
  (`src/duck/verified.ts`) and `tests/fixtures/oracle-duckdb-alone.json` come from that push's CI run, by
  `node scripts/oracle-legs.ts --write <run-id>`, then read the diff and commit both: a whole local run held a shared
  slot for what the legs already measured. Detector: `integration (oracle)` red on the PR, naming the command.
- **A heavy gate takes a slot.** `npm run check`, `npm run gate` and `npm run test:integration` queue for one of
  `MASON_GATE_SLOTS` machine-wide (`scripts/gate-slot.ts`) and say who they wait for, so a long wait is not a hang: start
  a gate in the background, because the wait can outlast a tool's foreground limit. Anything else whole goes through it
  by hand (`scripts/gate-slot.ts <command>`); a bare `npm test` does not queue, so regenerate with
  `UPDATE_FIXTURE=1 npm run check`. A queue that fails exits non-zero and runs nothing. Detector:
  `tests/gate-slot.test.ts`, which holds all three scripts to it.
- **`scripts/fails-without.ts` runs once per PR, on the final tree**, not after each edit: nearly every verdict was
  `PROVED`, so a run before the tree is final buys little. The principle stands ("Watch every test fail before you trust
  it"): a test written before its fix is seen failing then, and the tool's one run is the proof. Detector: its output in
  the PR's description, read by the reviewer. How often it ran, nothing detects.
- **Merge main only for a conflict, or just before the merge when main has moved in the same area.** A PR's run already
  tests the merge: it checks out `refs/pull/<n>/merge`, the head merged into main as main stood at that push. It does
  not run again when main moves, and re-running a job repeats the same commit, so a green run says nothing of what main
  has gained since: when that touches the same area, merge main, and the push starts a new run. Nothing tests the merge
  as it lands; a merge queue would (a `merge_group:` trigger and a ruleset), which is the owner's call. Detector: the
  `push` run on main, red after a merge.
- **CI stops a merge on `main`, unless the owner bypasses it.** A ruleset requires `checks`, `image`,
  `integration (oracle)` and `integration (rest)` on a PR, not that the PR is up to date with main, blocks a force
  push and deleting the branch, and takes changes through a PR only. It asks no approval, except of a PR with a commit
  whose author GitHub cannot link to an account. The repository's admins can bypass it, so whoever merges still reads
  every job.
  Detector: the merge is refused, and the `push` run on main after it.
- **Who merges what.** A PR that changes nothing under `src/` merges without the owner's word once its Fable review has
  no open finding, CI is green at its head and the diff has been read in full; a PR that changes `src/`, and a release,
  merge on the owner's word. It is queued pinned, as "The loop" step 5 says, and its landing is confirmed, never
  assumed: PR 89 had not merged itself some while after its last check went green, and was merged by hand.
  Detector: the hook `scripts/hooks/merge-head.ts` blocks a `gh pr merge` with no `--match-head-commit`, and lets
  `gh pr merge <n> --disable-auto` through.
- **Never re-run a gate on an unchanged tree to see whether a failure goes away.** Read the failure: it is the change's
  to fix, or it is a flake, the next rule. Detector: the hook `scripts/hooks/no-rerun.ts` blocks `gh run rerun`; a
  local gate run again on an unchanged tree, nothing detects (the gate could compare the tree's hash, and does not).
- **A flaky test met during other work is quarantined with an issue, not fixed in that PR**: a flake's fix costs more
  than the PR it interrupts, and its review is its own. A flake here is a test the change cannot have touched, failing
  on timing or load. The skip goes in its own commit, `test("…", { skip: "quarantined: #<issue>" }, …)`, and the issue
  is filed as "What a session finds" says, titled `Flaky: <test>`, with the failure's text. It says what is not known,
  because a flake can be a real fault; the fix is that issue's, and removes the skip. Never quarantined: an oracle
  statement, a wrong answer, a crash. Detector: `tests/conventions.test.ts` holds every skip or todo that
  no run decides, in any spelling and any case, to a quarantine naming its issue (one the run decides, such as no
  `IT_POSTGRES_URL`, is not a quarantine), and their number to a ceiling, so past it the next PR's `checks` is red until
  one is fixed.
- **Node: CI's decides.** CI runs Node 26, and never 24: `.github/workflows/ci.yml` says why (V8's abort at a process's
  exit, nodejs/node#66366). A laptop may run 24, whose `# Check failed: jit_page_->allocations_.erase(addr) == 1` after
  every test passed is that bug, not the change's fault and not a reason to run it again; `Check failed: end > addr`
  at high load is not explained yet (issue 67). A test that differs between the two is read on Node 26. Detector for
  CI's Node: `tests/conventions.test.ts` ("no workflow runs Node 24"); a laptop's is a fact, not a fault, so nothing
  checks it.

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
never carries an `ORDER BY`. `.claude/rules/duck-copy.md` "The copy" has the rules and the numbers.

**A real database's data and structures are confidential.** No real table, column or dataset name, and no row, from
any database Mason was run against, in the repo, a commit, a PR, an issue or a test: tests are written over synthetic schemas, and a finding from a real database is said
in sizes and shapes ("a 22 M-row table with two wide JSON columns"). A real database's saved statements may RANK what is
tested (the BI shapes), never appear. **Never print a real deployment's `mason status`, config or logs raw** into a
transcript, a PR or an issue: the Database line names the source's host and user. Filter to the lines you need first; a
filter that failed printed the host once, and a printed line cannot be unprinted.

## Commands

```bash
npm install && npm run check          # typecheck + unit tests, offline; queues for a slot ("Local gates")
npm run test:integration              # the real copy, stream, listener, serve and the oracle against IT_POSTGRES_URL
                                      #   (a throwaway Postgres; tests/integration/README.md); queues for a slot
node src/cli/main.ts --help           # the mason command from the checkout (every command, by step)
node cli/build.ts                     # the npm package: src/ compiled to cli/dist/
node cli/extensions.ts                # its platform packages (the copy's extensions, checksums pinned) in cli/platforms/
docker build -f docker/mason-data.Dockerfile -t mason-data:dev .   # the image; deploy/mason-data/compose.yml runs it
scripts/fails-without.ts <commit> <test-file>   # proof a test guards a fix: it must fail with src/ as it was at <commit>
scripts/gate-slot.ts <command>        # runs a command in one of the machine's slots, as the heavy gates do
scripts/board.ts status <n> "<status>"   # moves an issue's card on the Mason work board ("The board says …")
scripts/board.ts sub <issue> "<title>" --from "<model>"   # makes a sub-issue of <issue>, on the board; prints its number
```

### Checks and tests

- **CI must be green, and `npm run check` (typecheck + tests) is that check locally.** It is offline. CI
  (`.github/workflows/ci.yml`) runs the same two, the tests in shards, builds the CLI package and the image, and runs
  `tests/integration/` against a Postgres service, on every PR and on main. When each runs locally is "Local gates".
- No ESLint: the `tsc` flags in `tsconfig.json` (`noUnusedLocals`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  …) are the linter. Keep them on.
- Tests are `tests/*.test.ts` under `node --test`, no deps. Extend the matching file when you touch its logic: the
  commands (`tests/cli-commands.test.ts`), every command in every state (`tests/cli-state-matrix.test.ts`, `tests/cli-matrix.ts`
  must name every command), the copy (`tests/duck-copy-order.test.ts`, `tests/duck-sync-*.test.ts`), the listener
  (`tests/duck-wire.test.ts`), the recorded corpus of what BI tools send (`tests/duck-corpus.test.ts`), the refusals'
  registry and its doc (`tests/duck-gaps.test.ts`).
- **The oracle is the arbiter** (`tests/integration/duck-oracle.itest.ts`): every statement Mason answers is held equal to
  what a real Postgres answers — names, OIDs, text, order, SQLSTATE. A fix for a class of statement adds a statement to
  it; the allowlist is regenerated from CI's legs (`node scripts/oracle-legs.ts --write <run-id>`, "Local gates").
- **Golden fixtures are change-detectors: update them with `UPDATE_FIXTURE=1 npm run check`, then READ THE
  DIFF** (`docs/SQL-SUPPORT.md` is one, rendered from `src/duck/gaps.ts` and `src/duck/verified.ts`).
- **Watch every test fail before you trust it.** When the fix is already in the tree, `scripts/fails-without.ts <commit>
  <test-file>` runs the test with `src/` as it was at that commit, in a copy of the tree that leaves this one free to
  edit, and exits 0 only when a test that passes here fails there BY NAME (`--test-name-pattern` narrows it to one test).
  A test FILE that cannot load at the commit is its own verdict, `DID NOT LOAD`, never a proof.

**Script languages**: scripts are TypeScript run directly by Node's type stripping (`#!/usr/bin/env node`, Node ≥ 23.6
in the checkout, no build step, no tsx); the published package is compiled by `cli/build.ts` because Node strips no types
under node_modules. Erasable syntax only (`erasableSyntaxOnly`: no enums, namespaces or parameter properties).

## Architecture — what you need to know before editing

The rules for each subsystem are in `.claude/rules/`, and Claude Code loads one only when a file its `paths:` names is
read or edited. **Before you answer a question about a subsystem, or plan a change to it, without having opened its
code, read its rules file:**
- The engine, one `duck-*.md` per subsystem, so a session loads only what its files touch:
  - `duck-engine.md` — what the engine is, in a paragraph (any file of the engine loads it).
  - `duck-rewrite.md` — Postgres decides and DuckDB computes: a statement's plan, what DuckDB is sent, the plan fixture,
    the allowlist and the refusals.
  - `duck-executor.md` — DuckDB's worker thread: cancels, closes, the watch.
  - `duck-stored-json.md` — stored JSON paths and a jsonb's stored keys.
  - `duck-copy.md` — the copy in heap order with no index and in chunks that resume.
  - `duck-sync.md` — the poll and the stream, what the sync records.
  - `duck-generated.md` — tables declared in SQL: what is refused at load, a run, the marks, lag.
  - `duck-memory.md` — memory, spill and the disk.
  - `duck-request-log.md` — `_mason.requests` and usage over time.
  - `duck-users.md` — `mason user`.
  - `duck-testing.md` — the oracle and how the engine is tested.
- `cli.md` — the `mason` command: one interface for people and coding agents, self-documenting commands, one output
  shape, one failure shape, every command in every state, the project folder, the run's command server, `mason serve`.
- `postgres-api.md` — the listener: the catalog is a Postgres, the password is a user's or a token's, TLS off loopback,
  the recorded corpus.
- `web-ui.md` — the web page (`mason ui`): rendered from the command server's JSON in the CLI's words, no framework or
  build, served from an allowlist under the run's guard, `mason start`'s only, and what the full UI adds.

**How a common change is done**, step by step with what its tests must hold: `docs/RECIPES.md`. How a statement and `Sync`
run, and what waits on which thread: `docs/FLOWS.md`.

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
- **Vocabulary**: the *sources file* names what is synced, one *entry* per table; what Mason does to a table's data is
  *sync*: a user reads *the first sync* (the chunked copy, in the code), *the synced table* and *the synced data*, never
  "copy" (`tests/conventions.test.ts` holds every literal of src/ to it: the commands, the log, the wire; identifiers, `--json` keys and
  `MASON_COPY_PARALLEL` keep the code's word); changes
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
