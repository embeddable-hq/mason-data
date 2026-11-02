export const meta = {
  name: 'pr-loop-slim',
  description: 'One PR through CLAUDE.md "The loop", slim: brief, implement (Opus, who writes the design note and a Handoff comment), review (Fable) with CI read beside it, fix rounds that read and extend the Handoff, the class rule, learn, CI, then stop at the merge gate. Raced against pr-loop; no design review and no probe',
  whenToUse: 'One sub-issue of a Mason issue, from brief to a reviewed, green PR ready for the merge decision, in the race against pr-loop (issue 176)',
  phases: [
    { title: 'Brief', detail: 'Opus names the shapes and the tests', model: 'opus' },
    { title: 'Implement', detail: 'Opus, a worktree of its own: the design note before any code, the push, the note in the PR body, the Handoff comment', model: 'opus' },
    { title: 'Link', detail: "GitHub itself says the PR closes its sub-issue, or the body is fixed and asked again", model: 'sonnet' },
    { title: 'Review', detail: 'Fable, fresh context, findings with their class, their severity and whether the base has them', model: 'fable' },
    { title: 'Fix', detail: "reads the Handoff first and appends to it; this PR's blocking failures and classes and CI's, never the edit; a repeated class makes a class round", model: 'opus' },
    { title: 'Learn', detail: "each class met becomes a review probe in its rules file, one docs-only commit", model: 'opus' },
    { title: 'CI', detail: 'bounded wait on gh pr checks, with mergeable read first on every pass (GitHub runs no CI on a conflicting PR, so a conflict is its own verdict), beside each review and after the last; a CI fix gets a narrow re-check', model: 'sonnet' },
    { title: 'File', detail: "the base's findings and this PR's non-blocking ones, one issue per class, at every exit", model: 'sonnet' },
    { title: 'Record', detail: 'the Review record comment, with its machine-readable block, at every exit with a PR', model: 'sonnet' },
  ],
}

// pr-loop-slim: .claude/workflows/pr-loop.js with three changes, raced against it and against the pr-persistent skill
// (.claude/skills/pr-persistent/SKILL.md) on issue 176 (Tom, 2026-11-01). On issue 192 one persistent Opus agent, sent
// the review's findings by message, took 1 h 51 min where pr-loop took 5.5 h unfinished, on about 1/2.3 of its Opus
// output tokens: a fix round rebuilt no context. A Workflow agent() is one-shot, so this script cannot message the
// implementer again; it hands the context on instead.
//   1. No design stage, no design review and no probe: the implementer writes the design note itself, before any code,
//      into the PR body under `## Design`.
//   2. A HANDOFF: the implementer posts ONE PR comment headed `## Handoff` (the design decisions and why, what was tried
//      and rejected, the files and functions that matter, the open risks); every fix agent reads it first, beside every
//      earlier round, reads its rejected list before it changes a design decision, and appends what it changed and why.
//      A comment, never a committed file, so nothing of it lands in the repository.
//   3. The author checks at scale before every push (SELF_CHECK): the review's BATCH and CHECKS text, the differences
//      fixed before the push, the counts returned. On issue 192 every correctness bug was found by running statements.
// Everything else is pr-loop's, word for word where a prompt says it (the review, the re-check, the CI read: the review
// adds one sentence, that the Handoff is the author's account and never read), and so are the args, the result's shape
// and the Review record's block, whose designRounds and probeRounds are 0. tests/workflows.test.ts holds it so.
// args: { issue, parent, title, base, branch, stackedOn, context, readFirst?, brief?, process?, knownClasses?, repo?, itEnv? }
//   repo: the main checkout's path. Without it each agent finds the repository itself (WHERE), so the script runs for
//   anyone on the team, from any checkout: no path of one machine is written here.
//   brief: { brief, shapes, tests }, the Brief stage's shape: given, that stage is skipped (the race shares one brief).
//   process: who drives the run, said in the Review record's text: 'pr-loop-slim' (the Workflow tool, the default) or
//   'pr-persistent' (the coordinator following .claude/skills/pr-persistent/SKILL.md, which replays this script to
//   render each prompt, and sends every fix to the one implementer it keeps alive). Nothing else reads it.
//   knownClasses: { slug: { count, why } } carried from the PRs this one is stacked on (or the issue's earlier PRs), so
//   a class met on PR 170 counts on PR 207 too. The run returns its classes in the same shape, for the next run: only
//   the classes of blocking findings a PR made, never the base's nor a non-blocking one, which are filed instead.
//   itEnv: a path to a shell file that exports IT_POSTGRES_URL, the Postgres the reviews and the author's own checks run
//   their statements against through scripts/duck-repro.ts (a database of its own is made there and dropped). Without
//   it, each starts a throwaway postgres:18 container of its own (wal_level=logical, a random password, a free loopback
//   port) and removes it when done. No prompt prints the URL.
// Every exit returns pr-loop's shape, result(status):
//   { status, pr, head, rounds, fromBase, deferred, filed, classes, designRounds, probeRounds }, the last two always [].
const A = args
const PROCESSES = ['pr-loop-slim', 'pr-persistent']
const PROCESS = A.process === undefined ? 'pr-loop-slim' : A.process
const REPO = A.repo || '<repo>'
const WHERE = A.repo
  ? `The repository's main checkout is ${A.repo}.\n`
  : "<repo> below is the repository's main checkout: the one your working directory is in (`git rev-parse --show-toplevel`), or for a worktree agent, its main checkout via `git rev-parse --path-format=absolute --git-common-dir` and its parent. Find it first and use its absolute path for <repo>.\n"
// the board is moved from the main checkout's file, never through `node <(git show …)`, which exits 0 having run nothing
const BOARD = (status) => `node ${REPO}/scripts/board.ts status ${A.issue} "${status}"`
// one bound per PR, on the one counter (`round`) the stop's status and rounds[] read: the review rounds of a CI fix's
// re-check count toward it too
const MAX_ROUNDS = 4
// the CI fixes a PR gets; the last one's CI is waited on too
const MAX_CI_FIXES = 3

// Each stage's model, and the name what it posts is signed with: a posting names the model that wrote it, read from
// the same value as the agent's `model`, never written beside it.
const SIGNS = { opus: 'Opus 5.5', fable: 'Fable 5.1', sonnet: 'Sonnet 5.5' }
const ON = {
  brief: { model: 'opus', effort: 'high' },
  implement: { model: 'opus', effort: 'high', isolation: 'worktree' },
  link: { model: 'sonnet', effort: 'low' },
  review: { model: 'fable', effort: 'medium' },
  fix: { model: 'opus', effort: 'high', isolation: 'worktree' },
  learn: { model: 'opus', effort: 'medium', isolation: 'worktree' },
  ci: { model: 'sonnet', effort: 'low' },
  file: { model: 'sonnet', effort: 'medium' },
  record: { model: 'sonnet', effort: 'low' },
  learnCheck: { model: 'sonnet', effort: 'low' },
}
const signed = (on) => `### From Claude (${SIGNS[on.model]})`
const coAuthor = (on) => `Co-Authored-By: Claude ${SIGNS[on.model]} <noreply@anthropic.com>`

// One chunk of the CI wait (CLAUDE.md "Local gates": a `gh pr checks` loop with a deadline, never --watch, which exits
// at once on "no checks reported"). Each pass first reads `gh pr view --json mergeable,mergeStateStatus`, before the
// checks' verdict: GitHub runs no pull_request workflow on a PR with a merge conflict, so on a conflicting PR "no checks
// reported" never ends (PRs 231 and 233 waited to their deadline, issue 255). mergeable CONFLICTING is its own verdict,
// conflict, at once, even over a finished run at the head (a green PR that cannot merge is not ready); UNKNOWN (GitHub
// computes it lazily, just after a push) or a read that fails is "couldn't tell", a wait; only MERGEABLE lets the checks
// decide. mergeStateStatus is printed for the record and is never a verdict (DRAFT, BLOCKED and BEHIND all get CI).
// gh pr checks exits 0 when all passed, 8 while any is pending, 1 on a failure, and
// also 1 with "no checks reported" just after a push, which is a wait, not a failure; a failure while others are still
// pending is a failure (gh says 1). Any other exit is "couldn't tell", waited on like a pending one, and the last exit
// code is printed. Nine minutes: the agent's tool call is given a timeout of 600000 ms (CI_TOOL_MS), past the chunk, as
// the default of two minutes would kill it before it printed. The $SECONDS deadline bounds the loop, since an alarm
// exec'd into gh (a Go program) is ignored.
const CI_CHUNK_S = 540
const CI_TOOL_MS = 600000
const CI_WAIT = (pr) => `p=${pr}; end=$((SECONDS + ${CI_CHUNK_S})); st=pending; while [ $SECONDS -lt $end ]; do mg=$(gh pr view "$p" --json mergeable,mergeStateStatus 2>&1); mrc=$?; out=$(gh pr checks "$p" 2>&1); rc=$?; if [ $mrc -eq 0 ] && grep -q '"mergeable": *"CONFLICTING"' <<<"$mg"; then st=conflict; break; elif [ $mrc -ne 0 ] || ! grep -q '"mergeable": *"MERGEABLE"' <<<"$mg"; then :; elif [ $rc -eq 0 ]; then st=green; break; elif [ $rc -eq 1 ] && ! grep -q "no checks reported" <<<"$out"; then st=failed; break; fi; sleep 10; done; echo "PR $p: $st (last exit $rc)"; echo "mergeable (exit $mrc): $mg"; printf '%s\\n' "$out"`
// The CI wait's prompt: the final CI stage moves the card, the read beside a review moves none (the review does).
const CI_PROMPT = (board) => `${WHERE}${board ? `First run \`${BOARD('CI / queued')}\`.` : 'Move no card on the board.'} Wait for PR ${last.pr}'s CI at head ${last.head.slice(0, 7)} and report it. The wait is CLAUDE.md "Local gates"' loop on \`gh pr checks\` with a deadline, never \`--watch\`. Run this chunk of it in the foreground, as it is, with the Bash tool's timeout set to ${CI_TOOL_MS} (the chunk runs up to ${CI_CHUNK_S / 60} minutes, and the default timeout of two minutes would kill it before it prints), up to 8 times, until its first line says green, failed or conflict; still pending after the 8th is a timeout:
\`${CI_WAIT(last.pr)}\`
If the tool refuses the loop (a foreground \`sleep\`), run the same chunk with run_in_background and read its output when it exits; never drop its deadline or use \`--watch\` instead.
Each pass reads \`gh pr view <n> --json mergeable,mergeStateStatus\` first, and its \`mergeable\` decides before the checks do. CONFLICTING is the verdict conflict, at once and final, even when the head's checks finished green or red: GitHub starts no CI run on a PR with a merge conflict, so its "no checks reported" never ends, and a PR that cannot merge is not ready. Report conflict with the base it conflicts with and the \`gh pr view\` line the chunk printed; read no job's log for it. UNKNOWN (GitHub computes it lazily, just after a push) or a \`gh pr view\` that fails is "couldn't tell": a wait, never a verdict. Only MERGEABLE lets the checks decide; mergeStateStatus (DRAFT, BLOCKED, BEHIND, ...) is printed for the record and is never a verdict. \`gh pr checks\` exits 0 when all passed, 8 while any is pending, 1 on a failure, and also 1 with "no checks reported" just after a push, which is a wait, not a failure; a failure while others are still pending is a failure. Any other exit code is "couldn't tell": a wait, never green and never failed. On a failure, read each failing job's log: \`gh run view <run> --json jobs\`, then \`gh api repos/embeddable-hq/mason-data/actions/jobs/<id>/logs\` and the lines after "failing tests:" (for the oracle, the "differs:" lines and the first difference). Report each failing test's name and assertion text. Never re-run a job.`

// Every agent that writes code runs with isolation 'worktree': a worktree made for it, which it may edit. A worktree
// another agent made is another session's to the edit guard, so a fix agent sent to the implementer's worktree was
// blocked and moved into the coordinator's own (PR 207, round 2): two writers on one tree. The implementer makes the
// branch in its own worktree, which keeps it checked out; every agent after it works detached at the branch's tip and
// pushes HEAD to it, since a branch can be checked out in one worktree only.
const WORKTREE = (from) => `You run in a git worktree made for you; work only there, never in another worktree. Start with \`git fetch origin ${A.branch} ${A.base} && git checkout --detach ${from}\`, and push with \`git push origin HEAD:${A.branch}\`. Never \`git checkout ${A.branch}\` (a branch can be checked out in one worktree only).`
// the gates of a fix round (CLAUDE.md "Local gates"): the change's tests, typecheck and the two fast convention files
const FIX_GATES = 'Before the push, run the `## What review probes` of each .claude/rules/ file whose `paths:` the change falls under. Bound every test run. Run the tests of the change by --test-name-pattern, `npm run typecheck`, and `node --test --test-timeout=120000 tests/conventions.test.ts tests/cli-state-matrix.test.ts`; fails-without once on the final tree.'
// a probe and a review run their statements in throwaway worktrees, never under a home path, and leave nothing behind
const PROBE_TREES = `in two worktrees of your own under the system temp dir (\`git -C ${REPO} worktree add "$(mktemp -d)/head" <sha>\`), never under a home path, one at the head and one at origin/${A.base}, both removed afterwards (\`git -C ${REPO} worktree remove\`)`

// A probe and a review RUN statements, Postgres and Mason side by side with the base beside them, and never judge by
// reading alone (Tom, 2026-11-01). On issue 192 (WITH TIES) a review that only read the code passed an implementation;
// three checks of 300 to 500 statements each then found two regressions and about four new wrong answers in it, for
// about the tokens of a reading review (172k to 250k each, against 197k), because the statements were batched through
// scripts/duck-repro.ts and only the differences read; they took two to three times the wall time.
// The synthetic tables every variant form runs over; duck-repro syncs only a table with a key.
const REPRO_TABLES = "`t (id int PRIMARY KEY, a int, b text, c numeric(10,2), d char(4))`, holding NULLs, duplicate values and ties in every column but id, and `e`, an empty table of the same shape"
// The forms nobody wrote that found issue 192's wrong answers, generalised: each a concrete statement over REPRO_TABLES.
// Run every form that reaches the code the diff touches, with the feature under test and, for the regression sweep,
// without it. One list, for the probe and every review.
const VARIANT_FORMS = [
  "TABLE t in place of SELECT * FROM t, alone and as a set operation's arm: `TABLE t ORDER BY 1 LIMIT 2`; `SELECT * FROM t UNION ALL TABLE t ORDER BY 1 LIMIT 2`",
  "a VALUES arm first in a set operation: `VALUES (0, 0, 'v', 0.5, 'v') UNION ALL SELECT * FROM t ORDER BY 1 LIMIT 3`; `VALUES (1), (NULL) EXCEPT SELECT a FROM t`",
  "an empty input under each bound and aggregate: `SELECT a FROM t WHERE false ORDER BY a LIMIT 2`; `SELECT * FROM e ORDER BY 1 OFFSET 1`; `SELECT count(*), sum(c), max(b) FROM t WHERE false`",
  "a char(4) arm (d) beside a text arm (b): `SELECT d FROM t UNION SELECT b FROM t ORDER BY 1`; `SELECT b FROM t UNION ALL SELECT d FROM t ORDER BY 1 LIMIT 3`",
  "each count and offset zero, negative, NULL and an expression: `SELECT a FROM t ORDER BY a LIMIT NULL`; `SELECT a FROM t ORDER BY a LIMIT -1`; `SELECT a FROM t ORDER BY a OFFSET -1`; `SELECT a FROM t ORDER BY a LIMIT 0`; `SELECT a FROM t ORDER BY a LIMIT 1 + 1 OFFSET NULL`",
  "a quotient in a numeric arm beside an integer arm: `SELECT c / 3 FROM t UNION ALL SELECT a FROM t ORDER BY 1`; `SELECT a / 3 FROM t UNION SELECT c / 7 FROM t ORDER BY 1`",
  "an exact numeric read through a derived table or a CTE: `SELECT x FROM (SELECT c / 3 AS x FROM t) s ORDER BY 1`; `WITH q AS (SELECT c / 7 AS x FROM t) SELECT sum(x), max(x) FROM q`",
  "NULLs and ties at the bound: `SELECT a FROM t ORDER BY a NULLS FIRST LIMIT 2`; `SELECT a FROM t ORDER BY a DESC LIMIT 3`",
  "a set operation's arm with a bound of its own, parenthesised: `(SELECT a FROM t ORDER BY a LIMIT 1) UNION ALL (SELECT a FROM t ORDER BY a DESC LIMIT 1) ORDER BY 1`",
]
// Where duck-repro's Postgres comes from: the itEnv file, or a container of the stage's own that it removes. The
// password is passed by the environment, never argv (`ps` shows argv), and the container ends itself after two hours
// should the agent die first (as scripts/gate.ts's does); a shell's variables do not outlive a tool call, so the URL
// is kept in a file only its owner reads (umask 077).
const NEVER_PRINT = 'Never print, echo or log the URL or its password: no `cat` of the env file, no `env`, no `set -x`. If no Postgres can be had, report statementsRun 0 and say why first in judgedCorrect; never reason out an answer in place of running it.'
const PG_ACCESS = A.itEnv
  ? `Postgres: \`${A.itEnv}\` exports IT_POSTGRES_URL; source it in the same shell call as duck-repro (\`. ${A.itEnv}\`). ${NEVER_PRINT}`
  : `Postgres: start a throwaway one of your own, and remove it when done. \`umask 077; n=mason-review-$(openssl rand -hex 4); pw=$(openssl rand -hex 16); POSTGRES_PASSWORD=$pw docker run -d --rm --name "$n" -e POSTGRES_PASSWORD -p 127.0.0.1:0:5432 --entrypoint timeout postgres:18 --kill-after=30 7200 docker-entrypoint.sh postgres -c wal_level=logical\`; its port is \`docker port "$n" 5432/tcp\`; in that same call, write \`export IT_POSTGRES_URL=postgres://postgres:$pw@127.0.0.1:<port>/postgres\` to an env file under the system temp dir, and source it (\`. <env file>\`) in each call that runs duck-repro. It is ready when \`docker exec "$n" pg_isready -h 127.0.0.1 -U postgres\` says so, within 60 seconds. When done: \`docker rm -f -v "$n"\`, then \`docker inspect "$n"\` must fail, and delete the env file. ${NEVER_PRINT}`
// Which evidence a review owes is decided by the diff's paths (PR 245, round 2: every review was made to run SQL, and a
// PR that changes only the CLI, the web page, a script, a workflow or docs has no statement that reaches its code).
// A path the engine or the listener answers through owes STATEMENTS against Postgres: the `paths:` of every
// .claude/rules/duck-*.md and postgres-api.md, which already map paths to those subsystems, and src/cdc/**, the source's
// reader, which no rules file covers and CLAUDE.md "Local gates" counts with the engine. tests/workflows.test.ts holds
// this list equal to those files' `paths:`. Every other path owes CHECKS: what it changed, run.
const STATEMENT_PATHS = [
  'docs/POSTGRES-API.md', 'src/api/**', 'src/cdc/**', 'src/cli/dev.ts', 'src/cli/generated-files.ts', 'src/cli/mason.cjs', 'src/cli/pool-size.cjs', 'src/duck/**',
  'tests/duck-*.test.ts', 'tests/duck-executor*.ts', 'tests/duck-generated*.ts', 'tests/integration/duck-*.itest.ts', 'tests/postgres-api/**',
]
// a `paths:` glob as Claude Code reads it: `**` any run of characters, `*` any within one path segment
const globRe = (g) => new RegExp(`^${g.split('**').map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`)
const STATEMENT_RES = STATEMENT_PATHS.map(globRe)
const owesStatements = (path) => STATEMENT_RES.some((re) => re.test(path))
// How the statements are run: in files, dozens a call, at the head and at the base, the output to a file, and only the
// counts and the differences read. `scale` says how many.
const BATCH = (scale) => `RUN statements; never judge by reading alone. ${PG_ACCESS}
Give each tree its dependencies: link \`${REPO}/node_modules\` into it when its package-lock.json is the same as the main checkout's (\`cmp\`), else \`npm ci\` there. Write a DDL file over the synthetic tables ${REPRO_TABLES} (never a real database's names or rows), and statement files under the system temp dir, statements separated by lines holding only \`--\`, as scripts/duck-repro.ts reads them. Run each file at the head and at the base, dozens of statements a call: \`(. <env file> && cd <tree> && node scripts/duck-repro.ts <ddl.sql> <statements.sql>) > <out> 2>&1\`, the Bash tool's timeout set to 600000. Then read only the counts and the differences: \`grep -c '^SAME' <out>\`, \`grep -c '^DIFFER' <out>\`, \`grep -A2 '^DIFFER' <out> | head -150\`, and \`grep -m5 'NOT COPIED\\|Error' <out>\` (a table not synced: fix the DDL, and count none of its statements); never the whole file. Read a statement that differs at the head beside its line at the base. A statement whose order Postgres leaves open (ties under a LIMIT, no ORDER BY) can differ by chance: order by every column before calling it a difference.
Run every one of these VARIANT FORMS that reaches the code the diff touches, each spelt over the shapes under test:
${VARIANT_FORMS.map((v) => `- ${v}`).join('\n')}
And a REGRESSION SWEEP: for each code path the diff touches (each function, branch or rewrite it changes), the statements that reach that path in their PLAIN form, WITHOUT the new feature, in the variant forms above, at the head and at the base. Issue 192's regression was \`SELECT * FROM t UNION ALL TABLE t ORDER BY 1 LIMIT 2\`, which has no new syntax at all. A statement SAME at the base and DIFFER at the head is blocking: severity regression, origin this-pr.
Aim for ${scale}. Report statementsRun (the statements you ran at the head, each once) and statementsMatched (of those, the ones SAME at the head).`
// what a non-engine path owes: what the diff changed, run at the head and the base
const CHECKS = `RUN what it changed, at the head and at the base, and compare; never judge by reading alone: for src/cli/ or cli/, the \`mason\` command it changed in a project of its own under the system temp dir (\`node <tree>/src/cli/main.ts <command>\`, with and without --json, in each state it can meet); for src/web/, the page's JSON from the run's command server; for scripts/ or .claude/, the script or workflow with the inputs it reads, or the test that loads it (tests/workflows.test.ts for a workflow); for docs, each claim checked against the code it names, and tests/conventions.test.ts; and the change's own test files, bounded (\`node --test --test-timeout=120000 <file>\`). A check whose result the base gave right and the head does not is blocking: severity regression. Report checksRun: the checks you ran at the head, each once (a command, a script, a test file).`
// The evidence a probe or review owes, both kinds stated, since only its diff says which applies
const EVIDENCE = (scale) => `Report changedPaths: every path \`git diff --no-renames --name-only\` prints for the diff you read; the evidence you owe is decided from them.
STATEMENTS, for a changed path matching any of ${STATEMENT_PATHS.map((g) => `\`${g}\``).join(', ')} (the engine and the listener): ${BATCH(scale)}
CHECKS, for every other changed path: ${CHECKS}
A diff with both owes both. A review that owed statements and ran none, or owed checks and ran none, is no review: the run stops unreviewed.`

// The author's own check at scale, before every push: the review's BATCH and CHECKS text, split by the diff's paths as
// EVIDENCE splits them, with the differences fixed before the push rather than reported (Tom, 2026-11-01: on issue
// 192 every correctness bug was found by running statements, and one found before the review saves a whole round).
const SELF_CHECK = (scale) => `CHECK AT SCALE before you push, as the review after you will: run what you check ${PROBE_TREES}, the head being your last commit. For each changed path (\`git diff --no-renames --name-only origin/${A.base} HEAD\`) matching any of ${STATEMENT_PATHS.map((g) => `\`${g}\``).join(', ')} (the engine and the listener), STATEMENTS: ${BATCH(scale)}
For every other changed path, CHECKS: ${CHECKS}
Fix what differs at the head and not at the base before you push, then run the statements that differed again. Report statementsRun, statementsMatched and checksRun in your result, counted as the review counts them.`
const IMPLEMENT_SCALE = "a hundred statements or more: the brief's shapes, each in every variant form that reaches the code you touched, and the regression sweep of every path your diff touches"
const FIX_SCALE = "your fix's paths: the fix's statements in the variant forms that reach the code it changed, and the regression sweep of that code; dozens"
const BRIEF = { type: 'object', required: ['brief', 'shapes', 'tests'], properties: {
  brief: { type: 'string', description: 'what to build, where, and the decision it takes' },
  shapes: { type: 'array', items: { type: 'string' }, description: 'every shape the tests and oracle must hold, each a concrete SQL statement or input' },
  tests: { type: 'array', items: { type: 'string' }, description: 'the test files and --test-name-pattern / IT_ORACLE_ONLY the runs use' },
} }
// what the author ran at scale before the push (SELF_CHECK), counted as a review counts them
const SELF_COUNTS = {
  statementsRun: { type: 'integer', minimum: 0, description: 'the statements run at the head through scripts/duck-repro.ts before the push, each counted once' },
  statementsMatched: { type: 'integer', minimum: 0, description: 'of those, the ones SAME at the head' },
  checksRun: { type: 'integer', minimum: 0, description: 'the checks run at the head on changed paths that owe no statement' },
}
const PUSHED = { type: 'object', required: ['pr', 'head', 'summary'], properties: {
  pr: { type: 'number' }, head: { type: 'string', description: 'full sha pushed' },
  summary: { type: 'string' }, failsWithout: { type: 'string', description: 'scripts/fails-without.ts verdict line, if run' },
} }
// The HANDOFF (Tom, 2026-11-01): what the author knows that the code does not say, as an object. The implementer
// returns it, the script pastes it VERBATIM into the next fix prompt, and each fix returns it updated, which the script
// carries forward; the PR comment `## Handoff` is its human-readable copy, written from the same object.
const ITEM = { type: 'object', required: ['what', 'why'], properties: { what: { type: 'string' }, why: { type: 'string' } } }
const HANDOFF = { type: 'object', required: ['decisions', 'rejected', 'keyFiles', 'risks'], properties: {
  decisions: { type: 'array', items: ITEM, description: 'each design decision and why; a fix adds one for each thing it changed, its what beginning with its round (`fix r2: …`)' },
  rejected: { type: 'array', items: ITEM, description: 'each approach tried and rejected, and why' },
  keyFiles: { type: 'array', items: { type: 'string' }, description: 'the files and functions that matter (`path` or `path: function`)' },
  risks: { type: 'array', items: { type: 'string' }, description: 'the open risks' },
} }
const isHandoff = (h) => !!h && typeof h === 'object' && ['decisions', 'rejected', 'keyFiles', 'risks'].every((k) => Array.isArray(h[k]))
// a push of code (the implementer's, a fix's) says what its author ran at scale and returns the handoff; learn's
// docs-only commit owes neither
const CHECKED = { ...PUSHED, required: [...PUSHED.required, ...Object.keys(SELF_COUNTS), 'handoff'], properties: { ...PUSHED.properties, ...SELF_COUNTS, handoff: HANDOFF } }
// learn says when it started and ended, so the race reads its time apart from the rest (a Workflow script has no clock)
const STAMPS = {
  startedAt: { type: 'string', description: 'the output of `date -u +%FT%TZ`, run as your first command' },
  endedAt: { type: 'string', description: 'the output of `date -u +%FT%TZ`, run as your last command' },
}
const LEARNED = { ...PUSHED, required: [...PUSHED.required, 'startedAt', 'endedAt'], properties: { ...PUSHED.properties, ...STAMPS } }
// a CI fix may push nothing: a flake is the coordinator's to quarantine on main
const CI_FIXED = { ...CHECKED, required: [...CHECKED.required, 'flake'], properties: { ...CHECKED.properties,
  flake: { type: 'boolean', description: 'true when the failure is a flake and nothing was pushed; head is then the unchanged head' },
} }
const LINKED = { type: 'object', required: ['linked', 'bodyFixed', 'detail'], properties: {
  linked: { type: 'boolean', description: "true only when GitHub's closedByPullRequestsReferences lists the PR; for a stacked PR, whose link GitHub makes only once it targets the default branch, when its body says Closes #<issue>" },
  bodyFixed: { type: 'boolean', description: 'true when the PR body was edited to say Closes' },
  detail: { type: 'string', description: 'the numbers each query listed, and what was edited' },
} }
// Only a blocking finding sends a PR back (Tom, 2026-11-01): PR 202's rounds 5 to 7 found only refusal wording, about
// two hours of rounds while every answer was already right. A finding of another severity is filed at finish, one issue
// per class, and the PR goes on. When the reviewer is unsure, the finding blocks; a severity this script does not know
// (or none) is read as blocking too. scripts/review-stats.ts holds the same two lists (tests/workflows.test.ts).
const BLOCKING = ['wrong-answer', 'crash', 'data-loss', 'security', 'regression']
const DEFERRED = ['message', 'over-refusal', 'docs', 'quality']
const blocks = (f) => !DEFERRED.includes(f.severity)
// the line, as the review and the probe are told it
const SEVERITY_RULE = "Give each finding its SEVERITY. Blocking, and sent back for a fix: wrong-answer (where Mason answers, it answers differently from Postgres: rows, text, types or OIDs, order, or SQLSTATE), crash (a crash, a hang, or a stuck state such as a table left `building`), data-loss (synced data lost or corrupted), security, regression (what the base got right is now wrong or refused). Not blocking, filed as an issue while the PR goes on: message (a refusal's wording, reason, HINT or DETAIL, or a way out that does not work, when the refusal itself is right), over-refusal (Mason refuses where Postgres answers, and the base refused it too: safe, and a gap), docs, quality (code quality, or a missing test of a shape already answered right). When you are unsure, the finding is blocking: give the blocking severity it would be."
const FINDINGS = { type: 'object', required: ['findings', 'judgedCorrect', 'statementsRun', 'statementsMatched', 'checksRun', 'changedPaths'], properties: {
  findings: { type: 'array', items: { type: 'object', required: ['input', 'expected', 'actual', 'atBase', 'origin', 'severity', 'classKey', 'classWhy', 'where'], properties: {
    input: { type: 'string', description: 'the failing statement or input, exactly, with the table it runs over' },
    expected: { type: 'string', description: "Postgres's answer (or the right one)" },
    actual: { type: 'string', description: "Mason's answer at the PR's head" },
    atBase: { type: 'string', description: `Mason's answer to the same input at the PR's base (origin/${A.base}), run, not reasoned` },
    origin: { type: 'string', enum: ['this-pr', 'base'], description: "'base' when Mason at the base gives the same wrong answer (the PR did not cause it); 'this-pr' when the base answered right, refused, or did not reach it" },
    severity: { type: 'string', enum: [...BLOCKING, ...DEFERRED], description: `${BLOCKING.join(', ')} BLOCK: the PR goes back for a fix. ${DEFERRED.join(', ')} do not: the finding is filed as an issue and the PR goes on. wrong-answer: where Mason answers, it answers differently from Postgres (rows, text, types/OIDs, order, SQLSTATE); crash: a crash, a hang or a stuck state; data-loss: synced data lost or corrupted; regression: what the base got right is now wrong or refused; message: a refusal's wording, reason, HINT or DETAIL, or a way out that does not work, when the refusal is right; over-refusal: Mason refuses where Postgres answers and the base refused too; docs; quality: code quality, or a missing test of a shape already answered right. When unsure, a blocking severity.` },
    classKey: { type: 'string', description: 'kebab-case slug of the class; REUSE a known slug when it is the same class' },
    classWhy: { type: 'string', description: 'the class in one sentence, and the decision that would make it impossible' },
    where: { type: 'string', description: 'file:line' },
  } } },
  judgedCorrect: { type: 'array', items: { type: 'string' } },
  statementsRun: { type: 'integer', minimum: 0, description: 'the statements run at the head through scripts/duck-repro.ts, each counted once (not their runs at the base)' },
  statementsMatched: { type: 'integer', minimum: 0, description: "of those, the ones duck-repro printed SAME: Mason's answer equal to Postgres's" },
  checksRun: { type: 'integer', minimum: 0, description: 'the checks run at the head on the changed paths that owe no statements: each command, script or test file once; SQL statements are never counted here' },
  changedPaths: { type: 'array', items: { type: 'string' }, description: 'every path git diff --no-renames --name-only printed for the diff read, exactly' },
} }
const FILED = { type: 'object', required: ['issues'], properties: {
  issues: { type: 'array', items: { type: 'object', required: ['classKey', 'source', 'issue', 'action'], properties: {
    classKey: { type: 'string' },
    source: { type: 'string', enum: ['base', 'deferred'], description: "'base' for a class the base already has; 'deferred' for this PR's non-blocking findings" },
    issue: { type: 'number' }, action: { type: 'string', enum: ['filed', 'commented'] },
  } } },
} }
const CI = { type: 'object', required: ['state', 'detail'], properties: {
  state: { type: 'string', enum: ['green', 'failed', 'timeout', 'conflict'] },
  detail: { type: 'string', description: 'for failed: each failing job, its failing test name and assertion text; for conflict: the base the PR conflicts with, and the gh pr view line the wait printed (mergeable, mergeStateStatus)' },
} }
const CHANGED = { type: 'object', required: ['files', 'endedAt'], properties: {
  files: { type: 'array', items: { type: 'string' }, description: 'every path git diff --no-renames --name-only printed, exactly' },
  endedAt: STAMPS.endedAt,
} }
const POSTED = { type: 'object', required: ['url'], properties: { url: { type: 'string', description: "the comment's URL" } } }

// a severity the script does not know, or none, is said to be read as blocking, so the fixer is not left to guess
const severityText = (s) => (!s ? 'no severity: read as blocking' : BLOCKING.includes(s) || DEFERRED.includes(s) ? s : `${s}: not a known severity, read as blocking`)
const asFailures = (fs) => fs.map((f, i) => `${i + 1}. [class: ${f.classKey}; ${severityText(f.severity)}] ${f.classWhy}\n   input: ${f.input}\n   expected (Postgres): ${f.expected}\n   actual (Mason): ${f.actual}\n   at: ${f.where}`).join('\n')
// the classes of THIS PR's findings and the stack's (knownClasses), never the base's: a class the base has is filed,
// and counting it here would make a class round of a class this PR did not make
const classes = { ...(A.knownClasses || {}) }
const knownList = () => Object.entries(classes).map(([k, c]) => `${k} (${c.count}×: ${c.why})`).join('\n  ') || '(none)'

const rounds = [] // the review rounds
// every round of this PR in the order it ran: a fix round is handed all of them, not the last only
// (PR 202: each round's fresh agent saw only the latest findings, and undid or re-guessed what the one before decided)
const history = []
const fromBase = []
// this PR's findings that do not block, each with the round that met it: filed at finish beside fromBase, never fixed
const deferred = []
const filed = []
const notes = [] // what a stage that does not stop the run failed to do, said in the final status
let ciFixes = 0
let last = null // the PR's last pushed head: { pr, head }
const authored = [] // { label, statementsRun?, statementsMatched?, checksRun? }: the author's own check before each push
let handoff = null // the HANDOFF object, as the last agent that wrote code returned it
let learnTime = null // { startedAt, endedAt }: the Learn step's own time, for the race
// pr-loop's shape, so issue-loop can run either: this script has no design round and no probe round
const result = (status) => ({ status, pr: last ? last.pr : null, head: last ? last.head : null, rounds, fromBase, deferred, filed, classes, designRounds: [], probeRounds: [] })

// The note is the implementer's, in the PR body. The HANDOFF object goes from agent to agent through this script, and
// its copy for people is the PR's `## Handoff` comment, as nothing of an agent's context outlives its call.
const NOTE_AT = (pr) => `The design note this PR implements is its body's \`## Design\` (\`gh pr view ${pr} --json body\`); keep to it, and say any departure there, with why.`
const HANDOFF_COPY = `\`${signed(ON.implement)}\`, a line \`## Handoff\`, then \`### Decisions\` and \`### Rejected\` (a line \`- <what>: <why>\` each), \`### Key files\` and \`### Risks\` (one a line)`
const handoffText = () => `\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\``
const HANDOFF_READ = (pr) => `${handoff
  ? `Read the HANDOFF first, before anything else. The author's handoff, verbatim as the last agent that wrote this PR's code returned it:\n${handoffText()}\n`
  : `Read the HANDOFF first, before anything else: no handoff object reached this script, so read its copy, the comment on PR ${pr} headed \`## Handoff\` (\`gh pr view ${pr} --comments\`). `}Before you change ANY design decision (the note's, or one in decisions), read rejected; if you do change one, say why in the handoff you return. Do not try again what rejected holds, unless you say there why.`
// a fixer starts from the code the failure names, not from the whole PR (Tom, 2026-11-01)
const FROM_THE_CODE = `Start from the code: the files the failures name (each one's \`at:\`) and the handoff's keyFiles. Read the whole diff (\`git diff origin/${A.base}...HEAD\`) only where those do not explain a failure.`
const HANDOFF_RETURN = (pr, title) => `Return the handoff UPDATED: keep what still holds; add a decision for each thing you changed, with why, its what beginning \`${title}:\`; add to rejected what you tried and dropped, and to keyFiles and risks what you met. Then write that same object as the PR's \`## Handoff\` comment, replacing its body in place (${HANDOFF_COPY}): its id is \`gh api repos/embeddable-hq/mason-data/issues/${pr}/comments --jq '.[] | select(.body | contains("## Handoff")) | .id'\`, and \`gh api -X PATCH repos/embeddable-hq/mason-data/issues/comments/<id> -F body=@<file>\` writes it; never a second Handoff comment.`
// what the script carries forward: a fix's handoff when it returned a whole one, else the one before, said in the notes
function carry(h, label) {
  if (isHandoff(h)) handoff = h
  else notes.push(`${label} returned no whole handoff: the one before was carried forward`)
}
// the one sentence the review adds to pr-loop's: the Handoff is the author's account, and a review never takes it as evidence
const NOT_THE_HANDOFF = " The PR's `## Handoff` comment is the author's account too: never read it."
// A later review is told what is already deferred, so it is not reported again round after round at the same
// severity; and it is told to RUN each again, since a fix can turn a deferred refusal into a wrong answer, and tally()
// takes an input back from deferred only when it is reported again as blocking. Nothing is filed before finish.
const alreadyDeferred = () => deferred.length
  ? ` Already deferred as non-blocking (to be filed as issues when this run ends, not fixed in this PR): ${deferred.map((f) => `${f.classKey} (${f.severity}): ${f.input}`).join('; ')}. Do not report one of these again at a non-blocking severity. But RUN each of them again at this head: if one now blocks (a fix turned its refusal into a wrong answer, a crash, or anything else blocking), report it again with that blocking severity, as it is then this PR's to fix.`
  : ''
const historyText = (hs) => hs.length
  ? hs.map((h) => `### ${h.label} (head ${h.head.slice(0, 7)})\nFindings of this PR:\n${h.findings.length ? asFailures(h.findings) : '(none)'}\nJudged correct: ${h.judgedCorrect.join('; ') || '(none listed)'}`).join('\n\n')
  : '(none: this is the first)'

// A finding the base has joins fromBase (one input is one finding, whatever slug a later round gives it); this PR's
// that do not block join deferred, the same way; this PR's blocking ones are `mine`, and only they drive a fix and
// count toward the class rule. A class seen before (on this PR, or carried from the stack), or twice in these
// findings, makes the fix a class round.
function tally(findings, at) {
  const mine = findings.filter((f) => f.origin === 'this-pr' && blocks(f))
  for (const f of findings) if (f.origin === 'base' && !fromBase.some((g) => g.input === f.input)) fromBase.push(f)
  const later = findings.filter((f) => f.origin === 'this-pr' && !blocks(f))
  for (const f of later) if (!deferred.some((g) => g.input === f.input) && !mine.some((g) => g.input === f.input)) deferred.push({ ...f, ...at })
  // an input deferred once and found blocking later is this PR's to fix, never filed as well
  for (const f of mine) {
    const i = deferred.findIndex((g) => g.input === f.input)
    if (i >= 0) deferred.splice(i, 1)
  }
  const repeated = [...new Set(mine.map((f) => f.classKey).filter((k) => classes[k] || mine.filter((g) => g.classKey === k).length >= 2))]
  for (const f of mine) classes[f.classKey] = { count: (classes[f.classKey]?.count || 0) + 1, why: f.classWhy }
  return { mine, later, repeated }
}

// One fix prompt for a review's findings and a CI failure met beside a review: the handoff first, verbatim, where to
// start in the code, where the note is, every earlier round of this PR, then this round's failures, never the edit; it
// returns the handoff updated.
function fixPrompt(title, on, now, repeated, ciFailure) {
  const earlier = history.slice(0, history.indexOf(now))
  return `${WHERE}${title} on PR ${last.pr} (branch ${A.branch}) of the Mason repo. ${HANDOFF_READ(last.pr)}
${WORKTREE(`origin/${A.branch}`)} Run \`${BOARD('Fixing')}\` first. ${FROM_THE_CODE}
${NOTE_AT(last.pr)}

Every earlier round of this PR, oldest first: do not undo what one fixed, and do not re-check what one judged correct.
${historyText(earlier)}

${now.findings.length ? `Now, ${now.label} found these FAILURES, each one this PR's (the base answered right). Each comes with its class; the fix is yours to work out, and none is given:\n${asFailures(now.findings)}` : ''}
${ciFailure ? `CI failed at head ${now.head.slice(0, 7)} too; fix it in the same push. Read it as CLAUDE.md "Local gates" says: if it is a flake (a test the change cannot have touched, failing on timing or load), change nothing for it and say so in your summary, as the coordinator quarantines it on main; if the oracle's allowlist or fixture is stale, regenerate it from that run (\`node scripts/oracle-legs.ts --write <run-id>\`) and read the diff. The failure:\n${ciFailure}` : ''}
${repeated.length
  ? `This is a CLASS round (CLAUDE.md "The loop" step 4): ${repeated.join(', ')} has now been met more than once. Before ANY code, write in the PR body every case of each such class that THIS PR's change reaches: every spelling, depth and kind of input, under each statement form. Name the DECISION that makes the class impossible and the module that is its AUTHORITY (the one that already holds the fact: Postgres's analysis via src/duck/pgtree.ts, store.ts's pgErrorOf, the engine's prepared types, …), and check it against the design note and CLAUDE.md's named classes ("Fix the class, not the symptom") before code: a decision that derives again a fact a module already holds, or guesses from syntax what Postgres's analysis decides, is the class again. Give each case a test against Postgres and watch it fail where it fails today. Then fix the decision, not the cases. A case the base already answers wrong is not this PR's: list it in the PR body under "On the base, filed separately" and leave it. About 60 tool calls.`
  : 'About 30 tool calls.'}
Each finding becomes a test (tests/duck-wire.test.ts for the engine) and, for the engine, an oracle statement. What this round judged correct, do not re-check: ${now.judgedCorrect.join('; ') || '(nothing listed)'}.
${FIX_GATES}
${SELF_CHECK(FIX_SCALE)}
Come back in ONE push. The commit ends with \`${coAuthor(on)}\`. ${HANDOFF_RETURN(last.pr, title)} Return the new head.`
}

// The Review record: one comment at every exit with a PR, a summary for a person and a block that
// scripts/review-stats.ts reads, pr-loop's block key for key. `findings` are this PR's blocking ones, a review's with
// their severity; `deferred` the PR's non-blocking ones, filed and not fixed; designRounds and probeRounds are 0.
const sev = (f) => (f.severity ? { severity: f.severity } : {})
// A round's counts, when its agent gave them (the schema requires them). The evidence it OWED is read from its diff's
// paths (STATEMENT_PATHS): statements for the engine's and the listener's, checks for every other. A round that owed
// evidence and shows none, or no valid count of it, or that did not say its paths (so what it owed is not known), ran
// nothing anyone can see: a review's round is then UNRUN and stops the run as `unreviewed`, which issue-loop does not
// read as passed; a probe's is noted, as a failed probe is (PR 245, round 1: a review that ran nothing was a clean
// round, so "never judge by reading alone" was asserted and never enforced)
const isCount = (x) => Number.isInteger(x) && x >= 0
const countsOf = (a) => ({
  ...(isCount(a.statementsRun) ? { statementsRun: a.statementsRun, statementsMatched: isCount(a.statementsMatched) ? Math.min(a.statementsMatched, a.statementsRun) : 0 } : {}),
  ...(isCount(a.checksRun) ? { checksRun: a.checksRun } : {}),
})
// what the statements need, said wherever a stage that ran none of them is reported
const NEEDS = 'scripts/duck-repro.ts needs `psql` on PATH (the Postgres client: `brew install libpq` and its bin on PATH, or the `postgresql-client` package) and a Postgres: Docker running, for a throwaway postgres:18, or itEnv naming a file that exports IT_POSTGRES_URL'
const RUN_CHECKS = 'run what the diff changed at the head and the base: the `mason` command in a project of its own, the script, the change\'s test files'
// what the round failed to show, or null when it showed all it owed
function missingEvidence(a) {
  const paths = a.changedPaths
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((x) => typeof x === 'string' && x)) return { text: 'did not report the paths its diff changed, so the evidence it owed is not known', needs: `report changedPaths, and ${RUN_CHECKS}; ${NEEDS}` }
  const engine = paths.filter(owesStatements)
  const other = paths.filter((x) => !owesStatements(x))
  const miss = []
  const needs = []
  if (engine.length && !(isCount(a.statementsRun) && a.statementsRun > 0)) {
    miss.push(`${isCount(a.statementsRun) ? 'ran no statement' : 'reported no valid count of the statements it ran'} for ${engine[0]}${engine.length > 1 ? ` and ${engine.length - 1} more engine path(s)` : ''}`)
    needs.push(NEEDS)
  }
  if (other.length && !(isCount(a.checksRun) && a.checksRun > 0)) {
    miss.push(`${isCount(a.checksRun) ? 'ran no check' : 'reported no valid count of the checks it ran'} for ${other[0]}${other.length > 1 ? ` and ${other.length - 1} more path(s)` : ''}`)
    needs.push(RUN_CHECKS)
  }
  return miss.length ? { text: miss.join(', and '), needs: needs.join('; ') } : null
}
const saidText = (a) => (Array.isArray(a.judgedCorrect) && a.judgedCorrect[0] ? ` (it said: ${String(a.judgedCorrect[0]).slice(0, 200)})` : '')
const sumOf = (k) => rounds.reduce((s, e) => s + (e[k] || 0), 0)
// reviewRounds counts only the rounds that showed their evidence: an unrun round is no review, so review-stats never reads it
// as a clean one (a run whose first review was unrun is counted as never reviewed); its findings keep their round
const recordOf = (status) => ({
  pr: last.pr, designRounds: 0, probeRounds: 0, reviewRounds: rounds.filter((r) => !r.unrun).length,
  findings: rounds.flatMap((r) => r.findings.map((f) => ({ round: r.round, stage: 'review', classKey: f.classKey, ...sev(f) }))),
  deferred: deferred.map((f) => ({ round: f.round, stage: f.stage, classKey: f.classKey, severity: f.severity })),
  ciFixes, status,
  statementsRun: sumOf('statementsRun'), statementsMatched: sumOf('statementsMatched'), checksRun: sumOf('checksRun'),
})
const ranText = (e) => `${isCount(e.statementsRun) ? `; ${e.statementsRun} statement(s) run, ${e.statementsMatched} matched` : ''}${e.checksRun ? `; ${e.checksRun} check(s) run` : ''}${e.unrun ? '; showed none of the evidence it owed: no review' : ''}`
const roundLine = (name, n, fs, later = 0, e = {}) => `- ${name} ${n}: ${fs.length} finding(s)${fs.length ? `: ${[...new Set(fs)].join(', ')}` : ''}${later ? `; ${later} non-blocking, deferred` : ''}${ranText(e)}`
const laterOf = (stage, n) => deferred.filter((f) => f.stage === stage && f.round === n).length
const recordBody = (status) => `${signed(ON.record)}
## Review record

PR ${last.pr}: ${status}

${PROCESS === 'pr-persistent' ? "pr-persistent (pr-loop-slim's prompts, with ONE implementer kept alive across the fix rounds)" : 'pr-loop-slim'} (no design review and no probe; the context handed on in the PR's \`## Handoff\` comment): ${rounds.length} review round(s), ${ciFixes} CI fix(es); ${sumOf('statementsRun')} statement(s) run at the head by the reviews, ${sumOf('statementsMatched')} matching Postgres; ${sumOf('checksRun')} check(s) run on other paths.
Learn: ${learnTime ? `${learnTime.startedAt || '?'} to ${learnTime.endedAt || '?'}, the learn check included` : 'not run'}.
The author's own check at scale before each push: ${authored.map((a) => `${a.label}: ${a.statementsRun ?? '?'} statement(s) run, ${a.statementsMatched ?? '?'} matched, ${a.checksRun ?? '?'} check(s)`).join('; ') || 'none reported'}.
${rounds.map((r) => roundLine('review', r.round, r.findings.map((f) => f.classKey), laterOf('review', r.round), r)).join('\n')}
Deferred as non-blocking: ${deferred.map((f) => `${f.classKey} (${f.severity}, ${f.label})`).join(', ') || 'none'}
Issues filed: ${filed.map((i) => `#${i.issue} (${i.classKey}, ${i.source}, ${i.action})`).join(', ') || 'none'}

\`\`\`json mason-review-record
${JSON.stringify(recordOf(status))}
\`\`\``

// Every exit goes through finish: the base's findings and this PR's non-blocking ones are filed whatever stopped the
// run, so "never fixed in the PR" never means "never filed" either; and a PR gets its Review record, whatever stopped it.
const byClass = (fs) => {
  const out = {}
  for (const f of fs) (out[f.classKey] = out[f.classKey] || []).push(f)
  return Object.entries(out).map(([k, gs]) => `### ${k}: ${gs[0].classWhy}\n${asFailures(gs)}`).join('\n\n')
}
// the classes of `fs` that no returned issue of `source` names, and the issues that name the classes of `fs`
const isIssue = (i, source, k) => i.source === source && i.classKey === k && Number.isInteger(i.issue) && i.issue > 0
const unfiled = (source, fs) => [...new Set(fs.map((f) => f.classKey))].filter((k) => !filed.some((i) => isIssue(i, source, k)))
const issuesOf = (source, fs) => [...new Set(filed.filter((i) => fs.some((f) => isIssue(i, source, f.classKey))).map((i) => `#${i.issue}`))].join(', ')
async function finish(status) {
  if (fromBase.length || deferred.length) {
    phase('File')
    const r = await agent(
      `${WHERE}PR ${last.pr}'s review met findings that are not that PR's to fix. File them as CLAUDE.md "What a session finds" says: ONE issue per class, each first looked for (\`gh issue list --state open --search "<words>"\`) and, when one already names the class, a comment on it instead. Each issue and comment begins \`${signed(ON.file)}\`, says what was seen (every input with Postgres's answer and Mason's), what is not known, the class and the decision that would make it impossible, and what done looks like. Synthetic tables only. Move no card on the board: PR ${last.pr}'s card is moved by its own stages. There are two kinds, kept apart: never one issue for a class of both, and return each issue with its source.${fromBase.length ? `

## source 'base': wrong answers origin/${A.base} already gives
Each issue says it was met in the review of PR ${last.pr} and that the base already gives it.
${byClass(fromBase)}` : ''}${deferred.length ? `

## source 'deferred': PR ${last.pr}'s own findings, deferred as non-blocking
Each issue says it was met in PR ${last.pr}'s review (the round named in each), its severity, and that it was deferred as non-blocking (CLAUDE.md "The loop" step 4): the refusal or answer is safe, and PR ${last.pr} goes on without it.
${byClass(deferred.map((f) => ({ ...f, classWhy: `${f.classWhy} (met in ${f.label})` })))}` : ''}`,
      { label: 'file', phase: 'File', ...ON.file, schema: FILED })
    if (r) {
      filed.push(...r.issues)
      // "filed" is read from the issues returned, class by class and source by source, never from the call returning:
      // a class with no issue of its own source is said not filed, whatever the agent returned beside it
      const onBase = unfiled('base', fromBase)
      const mineLater = unfiled('deferred', deferred)
      const filedLater = deferred.filter((f) => !mineLater.includes(f.classKey))
      if (filedLater.length) status = `${status}; ${filedLater.length} non-blocking finding(s) of this PR filed (${issuesOf('deferred', filedLater)}), not fixed: in deferred`
      if (mineLater.length) status = `${status}; non-blocking class(es) of this PR NOT filed: ${mineLater.join(', ')}: in deferred`
      if (onBase.length) status = `${status}; the base's class(es) NOT filed: ${onBase.join(', ')}: in fromBase`
    } else status = `${status}; filing failed: the findings are in fromBase and deferred`
    log(`filed: ${filed.map((i) => `#${i.issue} (${i.classKey}, ${i.source}, ${i.action})`).join(', ') || 'nothing'}`)
  }
  if (notes.length) status = `${status}; ${notes.join('; ')}`
  if (last) {
    phase('Record')
    const posted = await agent(
      `${WHERE}Post this comment on PR ${last.pr} of embeddable-hq/mason-data, exactly as written between the BEGIN and END lines (not those lines): write it to a file under the system temp dir (\`f=$(mktemp)\`) and run \`gh pr comment ${last.pr} --body-file "$f"\`. Change nothing in it. Return the comment's URL.
BEGIN
${recordBody(status)}
END`,
      { label: 'record', phase: 'Record', ...ON.record, schema: POSTED })
    if (!posted) status = `${status}; the Review record was not posted`
  }
  return result(status)
}

// ---------------------------------------------------------------- Review and fix rounds, with the class rule
// Only this PR's blocking findings drive a round; its others are filed (finish), and a round with only those is clean.
// A finding the base already answers wrong is the base's: it is filed (finish) and never patched here, or a PR chases a class it did not make (PR 207: a numeric quotient computed as a double,
// main's since before the PR, took three rounds and grew each one). Returns null when a review finds nothing blocking of
// this PR's, else the status to stop with. `start` is the first review: { kind: 'full' }, or { kind: 'narrow', base, what }
// for a re-check of the commits since `base`, `what` saying what they were meant to fix. CI is read beside each review, so a red CI goes back in the review's fix round when there is one (PR 202 was
// red from its first push, and rounds 1 and 2 never heard of it); beside a clean review the CI stage reads it again.
let round = 0
async function reviewAndFix(start) {
  let { kind, base, what } = start
  for (;;) {
    if (round >= MAX_ROUNDS) return `${round} review rounds reached; head ${last.head.slice(0, 7)} is not re-checked: the coordinator decides`
    round++
    phase('Review')
    const judged = history.flatMap((x) => x.judgedCorrect)
    const [review, ciNow] = await parallel([
      () => agent(
        `${WHERE}First run \`${BOARD('In review')}\`. ${kind === 'full' ? 'Review' : 'Narrowly re-check the latest fix of'} PR ${last.pr} of embeddable-hq/mason-data at head ${last.head}, for wrong answers. Run \`git -C ${REPO} fetch origin ${A.branch} ${A.base}\` and \`git -C ${REPO} diff ${base} ${last.head}\`, and read the whole touched files at that head with \`git show\`. Read the .claude/rules/ file of the subsystem. Never take the author's report as evidence.${NOT_THE_HANDOFF} Run what you check ${PROBE_TREES}.${EVIDENCE(kind === 'full'
  ? "hundreds of statements (300 or more): the brief's shapes, each in every variant form, and the regression sweep of every path the diff touches"
  : "a narrower set: the fix's statements in the variant forms that reach the code it changed, and the regression sweep of that code; dozens, not a full review's count")}
Do not edit or push.
${kind === 'full' ? `The shapes the brief named:\n${brief.shapes.map((s) => '- ' + s).join('\n')}\nLook beyond them too. About 80 tool calls, never more than 120 tool calls.` : `${what}\nLook for what the fix broke, in the code it changed only. Already judged correct, so do NOT re-check: ${judged.join('; ') || '(nothing yet)'}. About 30 tool calls, never more than 45 tool calls.`}
For each confirmed finding give the failing input, Postgres's answer, Mason's answer at the head, and Mason's answer at the base (RUN it there), where, and its CLASS: the kind of mistake and the decision that would make it impossible (CLAUDE.md "Fix the class, not the symptom"). origin is 'base' when the base gives the same wrong answer, else 'this-pr'. ${SEVERITY_RULE}${alreadyDeferred()} Known classes, to REUSE by slug when it is the same class:
  ${knownList()}
Give no fix and no patch. Also list what you judged correct.`,
        { label: `review r${round}`, phase: 'Review', ...ON.review, schema: FINDINGS }),
      () => agent(CI_PROMPT(false), { label: `CI read r${round}`, phase: 'CI', ...ON.ci, schema: CI }),
    ])
    if (!review) return `review r${round} failed`
    // "couldn't tell" is never a failure sent back: the CI loop after the reviews reads it again
    const ciFailure = ciNow && ciNow.state === 'failed' ? ciNow.detail : null
    if (!ciNow || ciNow.state === 'timeout') log(`CI beside review r${round}: ${ciNow ? 'not finished' : 'no answer'}; the CI stage reads it`)
    // a conflict is never a CI failure: GitHub runs no CI on the PR until the base is merged, which the CI stage reports
    else if (ciNow.state === 'conflict') log(`CI beside review r${round}: the PR conflicts with ${A.base}; the CI stage reports it`)
    const { mine, later, repeated } = tally(review.findings, { round, stage: 'review', label: `review r${round}` })
    const classRound = repeated.length > 0
    const entry = { round, label: `review r${round}`, head: last.head, findings: mine, deferred: later.length, base: review.findings.length - mine.length - later.length, judgedCorrect: review.judgedCorrect, classRound, unrun: false, ...countsOf(review) }
    const missing = missingEvidence(review)
    entry.unrun = missing !== null
    rounds.push(entry)
    history.push(entry)
    log(`round ${round}: ${mine.length} blocking finding(s) of this PR, ${later.length} non-blocking (deferred, filed at the end), ${entry.base} of the base${ciFailure ? ', CI red' : ''}${classRound ? `; CLASS round next (${repeated.join(', ')})` : ''}`)
    // a full review or a re-check that ran nothing is never a clean round, whatever it found by reading: the run stops
    // `unreviewed`, saying what to install
    if (missing) return `unreviewed: review r${round} ${missing.text}${saidText(review)}, so head ${last.head.slice(0, 7)} was read and never run, and a review that runs nothing is no review. ${missing.needs}: install what is missing and run the review again, or the coordinator decides`
    // nothing blocking of this PR's is a clean round, whatever was deferred. A clean review with a red CI: the CI stage
    // reads that failure next and sends it to a CI fix
    if (mine.length === 0) return null
    if (round >= MAX_ROUNDS) return `still ${mine.length} finding(s) after ${round} rounds: the coordinator decides`

    phase('Fix')
    if (ciFailure) ciFixes++
    const fixed = await agent(fixPrompt(`Fix round ${round}`, ON.fix, entry, repeated, ciFailure),
      { label: `fix r${round}${classRound ? ' (class)' : ''}`, phase: 'Fix', ...ON.fix, schema: CHECKED })
    if (!fixed) return `fix round ${round} failed`
    if (fixed.head === last.head) return `fix round ${round} pushed nothing: the coordinator decides`
    authored.push({ label: `fix r${round}`, ...countsOf(fixed) })
    carry(fixed.handoff, `fix r${round}`)
    base = last.head
    last = fixed
    kind = 'narrow'
    what = `The previous round's findings were:\n${asFailures(mine)}\nCheck each is fixed.${ciFailure ? `\nCI's failure, fixed in the same push:\n${ciFailure}` : ''}`
  }
}

// ---------------------------------------------------------------- Brief
if (!PROCESSES.includes(PROCESS)) return await finish(`args.process is ${JSON.stringify(PROCESS)}: it is one of ${PROCESSES.join(', ')}`)
// A brief given in args (the race's processes share one) skips the stage; one that is not a brief stops the run.
const givenBrief = A.brief && typeof A.brief.brief === 'string' && Array.isArray(A.brief.shapes) && Array.isArray(A.brief.tests) ? A.brief : null
if (A.brief && !givenBrief) return await finish('args.brief is not a brief: { brief, shapes[], tests[] }, as the Brief stage returns')
let brief = givenBrief
if (!brief) {
  phase('Brief')
  brief = await agent(
  `${WHERE}Write the brief for ONE PR of the Mason repo (${REPO}): sub-issue #${A.issue} of #${A.parent}, "${A.title}".
Read issue #${A.parent} and its comments (\`gh issue view ${A.parent} --comments\`) for this task's part, and the code it builds on: branch \`${A.base}\` (\`git -C ${REPO} fetch origin ${A.base}\`; read with \`git -C ${REPO} show origin/${A.base}:<path>\`)${A.readFirst ? `, especially ${A.readFirst}` : ''}. Read the .claude/rules/ file of the subsystem it touches.
${A.context || ''}
The brief follows CLAUDE.md "The loop" step 1: name what the tests must hold, not only what to build. List EVERY shape the tests (and for the engine, the oracle) must answer equal to Postgres, as concrete SQL over the tests' own tables, including the shapes .claude/rules/duck-rewrite.md requires of a rewrite and the fallback shapes that must stay as written. Name the test files and the --test-name-pattern / IT_ORACLE_ONLY the runs use. Do not write code.`,
    { label: 'brief', phase: 'Brief', ...ON.brief, schema: BRIEF })
}
if (!brief) return await finish('brief failed')

// ---------------------------------------------------------------- Implement
phase('Implement')
last = await agent(
  `${WHERE}Implement ONE PR in the Mason repo, about 50 tool calls, ending at the push. First run \`${BOARD('Implementing')}\`.
You run in a git worktree made for you; work only there. Start with \`git fetch origin ${A.base} && git checkout -b ${A.branch} origin/${A.base}\`.
Task: #${A.issue} of #${A.parent}, "${A.title}".
${brief.brief}

No design review comes before you: write the DESIGN NOTE yourself, before any code, from the code at origin/${A.base} and the .claude/rules/ file of each subsystem the change touches, then keep to it. It goes in the PR body under \`## Design\`, and says:
- decision: the decision the change makes.
- authorities: for EACH fact the change needs (a type, an error, a name, a value's kind), the existing module that is its AUTHORITY, and why not another: Postgres's analysis (src/duck/pgtree.ts reads every node's result type), store.ts's pgErrorOf for an error, the engine's prepared types, …. A fact derived again where a module already holds it is CLAUDE.md's "a fact derived in several places"; a type guessed from syntax (a list of function names over the raw parse tree) where Postgres's analysis holds it breaks "Postgres decides, DuckDB computes".
- principles: which of CLAUDE.md's principles and named classes apply, and how the design honours each.
- shapes: the table the tests must hold: each form × wrapper (bare, \`* 2\`, coalesce, round, nested, in a subquery) × input type × where (the real run, \`mason start\` and the listener over a synced table, or the unit world), each a concrete input over a synthetic table.
- out of scope.

Shapes the tests must hold (each a test against Postgres, and for the engine an oracle statement):
${brief.shapes.map((s) => '- ' + s).join('\n')}

Before the push, run the \`## What review probes\` of each .claude/rules/ file whose \`paths:\` your change falls under: the review after you runs them.
Test runs: ${brief.tests.join('; ')}. Bound every run (\`node --test --test-timeout=<ms> ...\`). Follow CLAUDE.md "Local gates": the nearest tests, one full \`npm run check\` before the first push, no full oracle locally, scripts/fails-without.ts once on the final tree by --test-name-pattern. A product change adds its line to release-notes/next.md.
${SELF_CHECK(IMPLEMENT_SCALE)}
Push with \`git push -u origin ${A.branch}\`, and open the PR with \`gh pr create --base ${A.base} --head ${A.branch}\`. Its body starts \`${signed(ON.implement)}\`, says \`Closes #${A.issue}\`${A.stackedOn ? ` and that it is stacked on PR ${A.stackedOn}` : ''}, carries the design note and the fails-without verdict, and ends with the Claude Code line. The commit ends with \`${coAuthor(ON.implement)}\`. Do not merge.
Then post the HANDOFF's copy for people: ONE comment on the PR, written from the handoff object you return (${HANDOFF_COPY}); write it to a file under the system temp dir and run \`gh pr comment <your PR> --body-file <file>\`. A comment, never a committed file: nothing of it lands in the repository. Return the handoff object: what the fix agents after you need and the code does not say, since none of them has your context: decisions (each design decision and why), rejected (each approach tried and rejected, and why), keyFiles (the files and functions that matter), risks (the open risks).`,
  { label: 'implement', phase: 'Implement', ...ON.implement, schema: CHECKED })
if (!last) return await finish('implement failed')
authored.push({ label: 'implement', ...countsOf(last) })
if (isHandoff(last.handoff)) handoff = last.handoff
else notes.push('the implementer returned no whole handoff: each fix agent was told to read its comment')
log(`PR ${last.pr} pushed at ${last.head.slice(0, 7)}`)

// ---------------------------------------------------------------- Link: GitHub says the PR closes its issue
// PR 202 said "Part of #175", so GitHub never linked them and the board could not see the PR: the implement prompt
// asked for `Closes`, and nothing read whether it was written ("done" asserted by code that never exercised the
// artifact). GitHub links a closing keyword only on a PR into the default branch, so a stacked PR, whose base is
// another PR's branch, is checked for the keyword in its body and linked once it is retargeted.
phase('Link')
const LINK_QUERY = `gh api graphql -F n=${A.issue} -f query='query($n:Int!){repository(owner:"embeddable-hq",name:"mason-data"){issue(number:$n){closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number}}}}}'`
const link = await agent(
  `${WHERE}Check that GitHub links PR ${last.pr} to issue #${A.issue}. ${A.stackedOn
    ? `The PR is stacked (its base is ${A.base}, not the default branch), and GitHub links a closing keyword only on a PR into the default branch: read its body (\`gh pr view ${last.pr} --json body\`) and set linked true when it says \`Closes #${A.issue}\`. If it does not, add that line to the body (\`gh pr edit ${last.pr} --body-file <file>\`, the body read first and kept), set bodyFixed, and read it again.`
    : `Ask GitHub itself:\n\`${LINK_QUERY}\`\nlinked is true only when its nodes list ${last.pr}. If they do not, read the PR body (\`gh pr view ${last.pr} --json body\`), make it say \`Closes #${A.issue}\` (replacing a "Part of #${A.issue}" or the like; the rest kept), write it with \`gh pr edit ${last.pr} --body-file <file>\`, set bodyFixed, and run the query again; linked is what that second query says.`} Change nothing else. Move no card on the board. Report the numbers each query listed.`,
  { label: 'link', phase: 'Link', ...ON.link, schema: LINKED })
if (!link) return await finish(`the link check returned nothing: whether PR ${last.pr} closes #${A.issue} is not known`)
if (!link.linked) return await finish(`PR ${last.pr} is not linked to #${A.issue}${link.bodyFixed ? ' after its body was fixed' : ''}: ${link.detail}`)
if (link.bodyFixed) log(`PR ${last.pr}'s body fixed to close #${A.issue}`)

const stopped = await reviewAndFix({ kind: 'full', base: `origin/${A.base}` })
if (stopped) return await finish(stopped)

// ---------------------------------------------------------------- Learn: each class met becomes a review probe
// Before the CI loop, so CI covers its commit. Every blocking finding of this PR goes to the rules file of its
// subsystem as a probe pr-loop's Probe stage and every review run; a class already listed gets this PR's number.
const learnable = history.filter((h) => h.findings.length)
if (learnable.length) {
  phase('Learn')
  const learned = await agent(
    `${WHERE}Learn from PR ${last.pr}'s rounds. ${WORKTREE(`origin/${A.branch}`)} Move no card on the board.
Every finding of this PR is below. For each CLASS, add or update ONE bullet in the \`## What review probes\` section of the .claude/rules/ file whose \`paths:\` covers the finding's file (its \`at:\`), adding the section at the file's end if it has none. A bullet gives the probe as a synthetic input shape (a statement over a synthetic table: never a real database's table, column or value, CLAUDE.md "The source database is production"), the class's slug, and PR ${last.pr}. A class already listed gets PR ${last.pr} added to its bullet, never a second bullet. Where a detector within reach (a convention test in tests/conventions.test.ts, a hook) would have caught a class, say so in the PR body under \`## Detector wanted\` (read it with \`gh pr view ${last.pr} --json body\`, keep it, write it with \`gh pr edit ${last.pr} --body-file <file>\`): the class and what the detector would assert. Write no test: the coordinator decides.
Run \`date -u +%FT%TZ\` as your first command and as your last, and return each (startedAt, endedAt): the race reads Learn's time apart. ONE docs-only commit, touching .claude/rules/ only, then \`node --test --test-timeout=120000 tests/workflows.test.ts tests/conventions.test.ts\`. The commit ends with \`${coAuthor(ON.learn)}\`. Push, and return the new head. About 20 tool calls.
${learnable.map((h) => `### ${h.label}\n${asFailures(h.findings)}`).join('\n\n')}`,
    { label: 'learn', phase: 'Learn', ...ON.learn, schema: LEARNED })
  if (learned) learnTime = { startedAt: learned.startedAt, endedAt: learned.endedAt }
  if (!learned) notes.push('learn failed: its findings are in rounds')
  else if (learned.head === last.head) notes.push('learn pushed nothing')
  else {
    // Learn's commit is not reviewed, so it may touch .claude/rules/ only, and that is read from git,
    // never taken from the agent's word: a head that changed anything else, or whose files could not be read, is not
    // reported ready for the merge decision. --no-renames, as git detects renames by default and prints only a
    // rename's new path: a file moved from src/ into .claude/rules/ must show its removal too. A head that moved
    // touched at least one path, so no path read is "couldn't tell", never "nothing outside".
    const prev = last.head
    last = learned
    const check = await agent(
      `${WHERE}Run \`git -C ${REPO} fetch origin ${A.branch}\` and \`git -C ${REPO} diff --no-renames --name-only ${prev} ${learned.head}\`, and return every path it prints, exactly; if either command fails, return nothing rather than an empty list. Then run \`date -u +%FT%TZ\` and return its output as endedAt. Change nothing. Move no card on the board.`,
      { label: 'learn check', phase: 'Learn', ...ON.learnCheck, schema: CHANGED })
    if (check && learnTime && check.endedAt) learnTime.endedAt = check.endedAt
    if (!check || check.files.length === 0) return await finish(`learn's commit ${learned.head.slice(0, 7)} could not be read: whether it touched only .claude/rules/ is not known, and that head is not reviewed: the coordinator decides`)
    const outside = check.files.filter((f) => !f.startsWith('.claude/rules/'))
    if (outside.length) return await finish(`learn's commit ${learned.head.slice(0, 7)} changed ${outside.join(', ')} outside .claude/rules/, and that head is not reviewed: the coordinator decides`)
  }
}

// ---------------------------------------------------------------- CI, until green, failures sent back as failures
// A CI fix is a fix commit like any other, so it gets a narrow re-check (CLAUDE.md "The loop" step 4)
// before CI again.
for (let attempt = 1; attempt <= MAX_CI_FIXES + 1; attempt++) {
  phase('CI')
  const ci = await agent(CI_PROMPT(true), { label: `CI ${attempt}`, phase: 'CI', ...ON.ci, schema: CI })
  if (!ci) return await finish(`CI wait ${attempt} returned nothing: the coordinator looks`)
  // GitHub starts no CI run on a conflicting PR, so a conflict is never sent to a CI fix: the run stops naming the base
  // and the way out, never 'reviewed', so issue-loop stops there too
  if (ci.state === 'conflict') return await finish(`conflict: PR ${last.pr} conflicts with ${A.base}, and GitHub runs no CI on a conflicting PR: merge origin/${A.base} into ${A.branch} and push, then CI runs again (${ci.detail.slice(0, 300)})`)
  if (ci.state === 'timeout') return await finish('CI not finished within the bound')
  if (ci.state === 'green') return await finish('reviewed, no open blocking finding of this PR, CI green: ready for the merge decision')
  log(`CI failed: ${ci.detail.slice(0, 200)}`)
  if (attempt > MAX_CI_FIXES) return await finish(`CI still red after ${MAX_CI_FIXES} fixes: the coordinator decides`)
  phase('Fix')
  ciFixes++
  const fixed = await agent(
    `${WHERE}CI failed on PR ${last.pr} (branch ${A.branch}). ${HANDOFF_READ(last.pr)}
${WORKTREE(`origin/${A.branch}`)} Run \`${BOARD('Fixing')}\`. Start from the code: the files and tests the failure names and the handoff's keyFiles; read the whole diff (\`git diff origin/${A.base}...HEAD\`) only where those do not explain it. The failure:
${ci.detail}
${NOTE_AT(last.pr)}
Every round of this PR so far, oldest first: do not undo what one fixed.
${historyText(history)}
Read the failure (CLAUDE.md "Local gates"). If it is this change's, fix it, with a test. If it is a flake (a test the change cannot have touched, failing on timing or load), say so with flake: true, change nothing and return the head unchanged: the coordinator quarantines it on main. If the oracle's allowlist or fixture is stale, regenerate it from this run (\`node scripts/oracle-legs.ts --write <run-id>\`) and read the diff. If ${A.base} has the fix, merge \`origin/${A.base}\`. ${FIX_GATES}
${SELF_CHECK(FIX_SCALE)}
ONE push, whose commit ends with \`${coAuthor(ON.fix)}\`. ${HANDOFF_RETURN(last.pr, `CI fix ${attempt}`)} Return the new head.`,
    { label: `CI fix ${attempt}`, phase: 'Fix', ...ON.fix, schema: CI_FIXED })
  if (!fixed) return await finish(`CI fix ${attempt} failed`)
  // the head decides whether anything was pushed; the flag only says why nothing was
  if (fixed.head === last.head) return await finish(fixed.flake
    ? `CI failed on a flake, nothing pushed: the coordinator quarantines it (${fixed.summary})`
    : `CI fix ${attempt} pushed nothing: the coordinator decides`)
  authored.push({ label: `CI fix ${attempt}`, ...countsOf(fixed) })
  carry(fixed.handoff, `CI fix ${attempt}`)
  const prev = last.head
  last = fixed
  const again = await reviewAndFix({ kind: 'narrow', base: prev, what: `The commits since ${prev.slice(0, 7)} fix this CI failure:\n${ci.detail}\nCheck they fix it and change no answer Postgres would give.` })
  if (again) return await finish(again)
}
return await finish('CI loop ended without a verdict: the coordinator looks')
