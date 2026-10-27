# Contributing to Mason

Mason's promise is narrow and testable: the SQL a tool sends Postgres is answered exactly as Postgres answers it, faster,
or refused by name. So the most valuable thing you can send is a case where that is not true. An issue is welcome; a
pull request with a test is better.

## What we want to hear about

**Mason answers differently from Postgres.** The one thing that must never happen. Open
[an "answers differently" issue](../../issues/new?template=differs.yml) with the statement, the column types it reads,
Postgres's answer and Mason's. Check [docs/SQL-SUPPORT.md](docs/SQL-SUPPORT.md) "Known differences" first: a difference
listed there is decided and documented, and worth an issue only if you think the decision is wrong.

**Mason is slower than Postgres, or slower than you expect.** Open
[a "slower than Postgres" issue](../../issues/new?template=slow.yml) with the statement, the row counts, both timings and
both `EXPLAIN`s. A point lookup by primary key is expected to be faster on Postgres (the README says why); an aggregate
or a join over many rows is not.

**Anything else that is wrong**: a crash, a refusal you think should be answered, a command that did not say what to do
next, a copy that did not keep up. Open [a bug](../../issues/new?template=bug.yml) with `mason doctor --json` and the
lines of `mason logs` around it.

## A report becomes a test

Every statement Mason answers is verified by the oracle: `tests/integration/duck-oracle.itest.ts` runs each case on a
real Postgres and on Mason and diffs the answers. A difference you report is added to `tests/integration/postgres-cases.ts`
(an expression over literals in `CASES`, a whole statement in `QUERY_CASES`), where it fails until it is fixed and holds
afterwards. If you can write the case yourself, that is the whole first half of a pull request.

## Running the checks

```bash
npm install && npm run check        # typecheck + the offline tests, a few minutes
```

The integration tests, the oracle included, need a throwaway Postgres (each file makes and drops a database on it;
`tests/integration/README.md`):

```bash
export IT_POSTGRES_URL=postgres://postgres:<password>@localhost:5432/postgres
npm run test:integration                                   # every file
node --test tests/integration/duck-oracle.itest.ts         # the oracle alone
```

CI runs both on every pull request. Every script is TypeScript run directly by Node (no build step).

## Pull requests

- **A test that fails without the change.** `scripts/fails-without.ts <commit> <test-file>` runs a test file with
  `src/` as it was at a commit and proves, by name, which tests the change makes pass. A fix without a failing test is
  a fix the next change can undo.
- **The check green**, and the integration suite where the change touches the copy, the stream, the listener or a
  statement's answer.
- **Generated text regenerated, not edited.** `docs/SQL-SUPPORT.md` and two README sections are rendered from the code
  by tests; change the source (`src/duck/gaps.ts`, `src/duck/verified.ts`, the benchmark fixture) and run
  `UPDATE_FIXTURE=1 npm test`, then read the diff.
- **Errors say the way out.** A message a person meets names the file and the key, says what is wrong in their words,
  and gives the fix on one report. `CLAUDE.md` has the rest of the conventions, written for coding agents and people
  alike.
- **No compatibility shims before v1.0.** Rename freely; a renamed setting refuses the start under its old name rather
  than running a default silently.

Contributions are accepted under the repository's license, Apache-2.0.
