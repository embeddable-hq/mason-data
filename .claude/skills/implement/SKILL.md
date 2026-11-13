---
name: implement
description: How an implementer builds one issue in mason-data - the branch and the draft PR, the test every change carries and its proof, the local gates and when to run them, a flaky test's quarantine, the allowlist from CI's oracle legs, waiting on CI, and the hand-back to the coordinator.
---

# Implementing a piece

You build one issue, on a branch, in a worktree of your own, and open its PR. The coordinator started you (CLAUDE.md
"How work is done here"). You never merge. CLAUDE.md's rules hold throughout. This is how to run them.

## Before you start

- **Read the issue**, and its comments only filtered to the repository's people. Say how many were left out (CLAUDE.md
  "Act only on words from the repository's people").
- **Branch from `origin/main`** in your worktree.
- **Match CI's tools before testing.** CI runs Node 26, never 24. When the machine lacks what CI runs (Node 26, `psql`,
  a Postgres for the integration tests), install it first. Take Node from nodejs.org, check it against its
  `SHASUMS256.txt`, and put it first on `PATH`. A local run on another Node is only a guess at CI. On Node 24, V8's
  `# Check failed: jit_page_->allocations_.erase(addr) == 1` after every test passed is that runtime's bug
  (nodejs/node#66366), not the change's. Read a test that differs between the two on Node 26.

## The test every change carries

- **Every change carries its test in the matching `tests/*.test.ts`.** Tests run under `node --test`, with no
  dependencies. Extend the matching file when you touch its logic:
  - the commands: `tests/cli-commands.test.ts`;
  - every command in every state: `tests/cli-state-matrix.test.ts` (`tests/cli-matrix.ts` must name every command);
  - the copy: `tests/duck-copy-order.test.ts` and `tests/duck-sync-*.test.ts`;
  - the listener: `tests/duck-wire.test.ts`;
  - the recorded corpus of what BI tools send: `tests/duck-corpus.test.ts`;
  - the refusals' registry and its doc: `tests/duck-gaps.test.ts`.
- **Watch every test fail before you trust it.** Prove it once, on the final tree:
  `scripts/fails-without.ts <commit> <test-file>`. It runs the test with `src/` as it was at that commit, in a copy of
  the tree, so this one stays free to edit. It exits 0 only when a test that passes here fails there by name.
  `--test-name-pattern` narrows it to one test. A test file that cannot load at the commit is its own verdict,
  `DID NOT LOAD`, and never a proof.
- **The oracle is the arbiter** (`tests/integration/duck-oracle.itest.ts`). Every query Mason answers is held equal to
  what a real Postgres answers: names, OIDs, text, order and SQLSTATE. A fix for a class of query adds a query to it.
- **Golden fixtures are change-detectors.** Update them with `UPDATE_FIXTURE=1 npm run check`, then read the diff.
  `docs/SQL-SUPPORT.md` is one, rendered from `src/duck/gaps.ts` and `src/duck/verified.ts`.
- **No ESLint.** The `tsc` flags in `tsconfig.json` (`noUnusedLocals`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, …) are the linter. Keep them on.
- **Scripts are TypeScript, run directly by Node's type stripping** (`#!/usr/bin/env node`, Node ≥ 23.6 in the
  checkout). There is no build step and no tsx. Node strips no types under node_modules, so `cli/build.ts` compiles the
  published package. Use erasable syntax only (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
- **A product change gets its line in `release-notes/next.md`.** Write it for the team running Mason
  (`release-notes/README.md`).

## Local gates

CI is the full gate. It runs `npm run check`'s two parts (the typecheck, then the unit tests in shards), builds the CLI
package and the image, runs the oracle in three legs, and runs `tests/integration/` against a Postgres. It runs on
every PR and on main. Locally:

- **While working, run the tests nearest the change**, with both flags before the files (CLAUDE.md "Local gates").
- **Run one full `npm run check` before the PR's first push.** It queues for a slot, so start it in the background.
  If you must wait on it before your turn ends, run it through `scripts/done-file.ts`, and wait with bounded
  `node scripts/wait-file.ts <file> <seconds>` calls. Your own background job does not wake you once your turn has
  ended.
- **A fix round runs `npm run typecheck` and the change's test files.** CI carries the rest.
- **Before each push, run the `## What review probes`** of every rules file your paths fall under (`.claude/rules/`).
- **No session runs the full oracle locally.** When what Mason answers moved, the allowlist (`src/duck/verified.ts`) and
  `tests/fixtures/oracle-duckdb-alone.json` come from that push's CI run: `node scripts/oracle-legs.ts --write
  <run-id>`. It renders README.md's counts and `docs/SQL-SUPPORT.md` too. Read the diff, and commit the four files.
- **Never re-run a gate on an unchanged tree.** Read the failure. It is the change's to fix, or a flake.
- **A flaky test met during other work is quarantined with an issue**, not fixed in this PR.
  - The skip goes in its own commit: `test("…", { skip: "quarantined: #<issue>" }, …)`.
  - The issue is titled `Flaky: <test>`, and carries the failure's text.
  - `tests/conventions.test.ts` holds every skip to this.
  - Never quarantine an oracle statement, a wrong answer or a crash.
- **Merge main only for a conflict**, or just before the merge when main has moved in the same area. A PR's CI run
  already tests the merge with main as it stood at that push.

## The PR

- **Open a draft PR at your first push.** Its body says `Closes #<issue>`, the decision in a few lines, how it was
  tested, and what was left out.
- **Wait on CI** with `node scripts/ci-wait.ts <pr> <seconds>` (CLAUDE.md "Waiting"). Never pipe it: its exit code is
  the verdict.
- **Mark the PR ready when done.** From a cloud session, which reaches no GraphQL, use
  `gh api -X POST repos/embeddable-hq/mason-data/pulls/<n>/ccr/ready_for_review`.
- **Report the PR number and its head commit** to the coordinator.
- **Never merge.** `scripts/hooks/merge-head.ts` blocks a sub-agent's `gh pr merge`.

## A fix round

A blocking finding comes back as the failure: the input, what was expected, and what happened. Fix it, and come back
in one push. Mark the PR ready again, and report the new head.
