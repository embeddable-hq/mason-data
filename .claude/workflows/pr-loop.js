export const meta = {
  name: 'pr-loop',
  description: 'One PR through CLAUDE.md "The loop": brief, implement (Opus), review (Fable), fix rounds with the class rule, CI, then stop at the merge gate',
  whenToUse: 'One sub-issue of a Mason issue, taken from brief to a reviewed, green PR ready for the merge decision',
  phases: [
    { title: 'Brief', detail: 'Opus names the shapes and the tests', model: 'opus' },
    { title: 'Implement', detail: 'Opus, a worktree of its own, ends at the push', model: 'opus' },
    { title: 'Review', detail: 'Fable, fresh context, findings with their class and whether the base has them', model: 'fable' },
    { title: 'Fix', detail: "this PR's failures and classes, never the edit; a repeated class makes a class round", model: 'opus' },
    { title: 'File', detail: "the base's findings, one issue per class" },
    { title: 'CI', detail: 'bounded wait on gh pr checks' },
  ],
}

// args: { issue, parent, title, base, branch, stackedOn, context, readFirst?, knownClasses?, repo? }
//   repo: the main checkout's path. Without it each agent finds the repository itself (WHERE), so the script runs for
//   anyone on the team, from any checkout: no path of one machine is written here.
//   knownClasses: { slug: { count, why } } carried from the PRs this one is stacked on (or the issue's earlier PRs), so
//   a class met on PR 170 counts on PR 207 too. The run returns its classes in the same shape, for the next run.
const A = args
const REPO = A.repo || '<repo>'
const WHERE = A.repo
  ? `The repository's main checkout is ${A.repo}.\n`
  : "<repo> below is the repository's main checkout: the one your working directory is in (`git rev-parse --show-toplevel`), or for a worktree agent, its main checkout via `git rev-parse --path-format=absolute --git-common-dir` and its parent. Find it first and use its absolute path for <repo>.\n"
// the board is moved from the main checkout's file, never through `node <(git show …)`, which exits 0 having run nothing
const BOARD = `node ${REPO}/scripts/board.ts status ${A.issue}`
const MAX_ROUNDS = 4

// One chunk of the CI wait (CLAUDE.md "Local gates": a `gh pr checks` loop with a deadline, never --watch, which exits
// at once on "no checks reported"). gh pr checks exits 0 when all passed, 8 while any is pending, 1 on a failure, and
// also 1 with "no checks reported" just after a push, which is a wait, not a failure; a failure while others are still
// pending is a failure (gh says 1). Any other exit is "couldn't tell", waited on like a pending one, and the last exit
// code is printed. Nine minutes, under a tool's ten-minute foreground limit; the $SECONDS deadline bounds it, since an
// alarm exec'd into gh (a Go program) is ignored.
const CI_WAIT = (pr) => `p=${pr}; end=$((SECONDS + 540)); st=pending; while [ $SECONDS -lt $end ]; do out=$(gh pr checks "$p" 2>&1); rc=$?; if [ $rc -eq 0 ]; then st=green; break; elif [ $rc -eq 1 ] && ! grep -q "no checks reported" <<<"$out"; then st=failed; break; fi; sleep 10; done; echo "PR $p: $st (last exit $rc)"; printf '%s\\n' "$out"`

// Every agent that writes code runs with isolation 'worktree': a worktree made for it, which it may edit. A worktree
// another agent made is another session's to the edit guard, so a fix agent sent to the implementer's worktree was
// blocked and moved into the coordinator's own (PR 207, round 2): two writers on one tree. The branch is never checked
// out in a worktree; each agent works detached at the branch's tip and pushes HEAD to it.
const WORKTREE = (from) => `You run in a git worktree made for you; work only there, never in another worktree. Start with \`git fetch origin ${A.branch} ${A.base} && git checkout --detach ${from}\`, and push with \`git push origin HEAD:${A.branch}\`. Never \`git checkout ${A.branch}\` (a branch can be checked out in one worktree only).`

const BRIEF = { type: 'object', required: ['brief', 'shapes', 'tests'], properties: {
  brief: { type: 'string', description: 'what to build, where, and the decision it takes' },
  shapes: { type: 'array', items: { type: 'string' }, description: 'every shape the tests and oracle must hold, each a concrete SQL statement or input' },
  tests: { type: 'array', items: { type: 'string' }, description: 'the test files and --test-name-pattern / IT_ORACLE_ONLY the runs use' },
} }
const PUSHED = { type: 'object', required: ['pr', 'head', 'summary'], properties: {
  pr: { type: 'number' }, head: { type: 'string', description: 'full sha pushed' },
  summary: { type: 'string' }, failsWithout: { type: 'string', description: 'scripts/fails-without.ts verdict line, if run' },
} }
const FINDINGS = { type: 'object', required: ['findings', 'judgedCorrect'], properties: {
  findings: { type: 'array', items: { type: 'object', required: ['input', 'expected', 'actual', 'atBase', 'origin', 'classKey', 'classWhy', 'where'], properties: {
    input: { type: 'string', description: 'the failing statement or input, exactly, with the table it runs over' },
    expected: { type: 'string', description: "Postgres's answer (or the right one)" },
    actual: { type: 'string', description: "Mason's answer at the PR's head" },
    atBase: { type: 'string', description: `Mason's answer to the same input at the PR's base (origin/${A.base}), run, not reasoned` },
    origin: { type: 'string', enum: ['this-pr', 'base'], description: "'base' when Mason at the base gives the same wrong answer (the PR did not cause it); 'this-pr' when the base answered right, refused, or did not reach it" },
    classKey: { type: 'string', description: 'kebab-case slug of the class; REUSE a known slug when it is the same class' },
    classWhy: { type: 'string', description: 'the class in one sentence, and the decision that would make it impossible' },
    where: { type: 'string', description: 'file:line' },
  } } },
  judgedCorrect: { type: 'array', items: { type: 'string' } },
} }
const FILED = { type: 'object', required: ['issues'], properties: {
  issues: { type: 'array', items: { type: 'object', required: ['classKey', 'issue', 'action'], properties: {
    classKey: { type: 'string' }, issue: { type: 'number' }, action: { type: 'string', enum: ['filed', 'commented'] },
  } } },
} }
const CI = { type: 'object', required: ['state', 'detail'], properties: {
  state: { type: 'string', enum: ['green', 'failed', 'timeout'] },
  detail: { type: 'string', description: 'for failed: each failing job, its failing test name and assertion text' },
} }

const asFailures = (fs) => fs.map((f, i) => `${i + 1}. [class: ${f.classKey}] ${f.classWhy}\n   input: ${f.input}\n   expected (Postgres): ${f.expected}\n   actual (Mason): ${f.actual}\n   at: ${f.where}`).join('\n')
const classes = { ...(A.knownClasses || {}) }
const knownList = () => Object.entries(classes).map(([k, c]) => `${k} (${c.count}×: ${c.why})`).join('\n  ') || '(none)'

// ---------------------------------------------------------------- 1. Brief
phase('Brief')
const brief = await agent(
  `${WHERE}Write the brief for ONE PR of the Mason repo (${REPO}): sub-issue #${A.issue} of #${A.parent}, "${A.title}".
Read issue #${A.parent} and its comments (\`gh issue view ${A.parent} --comments\`) for this task's part, and the code it builds on: branch \`${A.base}\` (\`git -C ${REPO} fetch origin ${A.base}\`; read with \`git -C ${REPO} show origin/${A.base}:<path>\`)${A.readFirst ? `, especially ${A.readFirst}` : ''}. Read the .claude/rules/ file of the subsystem it touches.
${A.context || ''}
The brief follows CLAUDE.md "The loop" step 1: name what the tests must hold, not only what to build. List EVERY shape the tests (and for the engine, the oracle) must answer equal to Postgres, as concrete SQL over the tests' own tables, including the shapes .claude/rules/duck-rewrite.md requires of a rewrite and the fallback shapes that must stay as written. Name the test files and the --test-name-pattern / IT_ORACLE_ONLY the runs use. Do not write code.`,
  { label: 'brief', phase: 'Brief', model: 'opus', effort: 'high', schema: BRIEF })
if (!brief) return { status: 'brief failed' }

// ---------------------------------------------------------------- 2. Implement
phase('Implement')
let pushed = await agent(
  `${WHERE}Implement ONE PR in the Mason repo, about 40 tool calls, ending at the push. First run \`${BOARD} Implementing\`.
You run in a git worktree made for you; work only there. Start with \`git fetch origin ${A.base} && git checkout -b ${A.branch} origin/${A.base}\`.
Task: #${A.issue} of #${A.parent}, "${A.title}".
${brief.brief}

Shapes the tests must hold (each a test against Postgres, and for the engine an oracle statement):
${brief.shapes.map((s) => '- ' + s).join('\n')}

Test runs: ${brief.tests.join('; ')}. Bound every run (\`node --test --test-timeout=<ms> ...\`). Follow CLAUDE.md "Local gates": the nearest tests, one full \`npm run check\` before the first push, no full oracle locally, scripts/fails-without.ts once on the final tree by --test-name-pattern. A product change adds its line to release-notes/next.md.
Push with \`git push -u origin ${A.branch}\`, and open the PR with \`gh pr create --base ${A.base} --head ${A.branch}\`. Its body starts \`### From Claude (Opus 5.5)\`, says \`Closes #${A.issue}\`${A.stackedOn ? ` and that it is stacked on PR ${A.stackedOn}` : ''}, carries the fails-without verdict, and ends with the Claude Code line. The commit ends with \`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\`. Do not merge.`,
  { label: 'implement', phase: 'Implement', model: 'opus', effort: 'high', isolation: 'worktree', schema: PUSHED })
if (!pushed) return { status: 'implement failed' }
log(`PR ${pushed.pr} pushed at ${pushed.head.slice(0, 7)}`)

// ---------------------------------------------------------------- 3-4. Review and fix rounds, with the class rule
// Only this PR's findings drive a round. A finding the base already answers wrong is the base's: it is filed (phase 5)
// and never patched here, or a PR chases a class it did not make (PR 207: a numeric quotient computed as a double,
// main's since before the PR, took three rounds and grew each one).
const rounds = []
const fromBase = []
let base = `origin/${A.base}`
let reviewKind = 'full'
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const review = await agent(
    `${WHERE}${reviewKind === 'full' ? 'Review' : 'Narrowly re-check the latest fix round of'} PR ${pushed.pr} of embeddable-hq/mason-data at head ${pushed.head}, for wrong answers. Run \`git -C ${REPO} fetch origin ${A.branch} ${A.base}\` and \`git -C ${REPO} diff ${base} ${pushed.head}\`, and read the whole touched files at that head with \`git show\`. Read the .claude/rules/ file of the subsystem. Never take the author's report as evidence. Probe against a real Postgres as the tests do, in two worktrees of your own under the system temp dir (\`git -C ${REPO} worktree add "$(mktemp -d)/head" <sha>\`), never under a home path, one at the head and one at origin/${A.base}, both removed afterwards (\`git -C ${REPO} worktree remove\`). Do not edit or push.
${reviewKind === 'full' ? `The shapes the brief named:\n${brief.shapes.map((s) => '- ' + s).join('\n')}\nLook beyond them too. About 40 tool calls.` : `The previous round's findings were:\n${asFailures(rounds[rounds.length - 1].findings)}\nCheck each is fixed, and look for what the fix broke, in the code this round changed only. Already judged correct, so do NOT re-check: ${rounds.flatMap((x) => x.judgedCorrect).join('; ')}. About 20 tool calls.`}
For each confirmed finding give the failing input, Postgres's answer, Mason's answer at the head, and Mason's answer at the base (RUN it there), where, and its CLASS: the kind of mistake and the decision that would make it impossible (CLAUDE.md "Fix the class, not the symptom"). origin is 'base' when the base gives the same wrong answer, else 'this-pr'. Known classes, to REUSE by slug when it is the same class:
  ${knownList()}
Give no fix and no patch. Also list what you judged correct.`,
    { label: `review r${round}`, phase: 'Review', model: 'fable', effort: 'medium', schema: FINDINGS })
  if (!review) return { status: 'review failed', pr: pushed.pr, head: pushed.head, rounds, classes }
  const mine = review.findings.filter((f) => f.origin === 'this-pr')
  for (const f of review.findings) {
    if (f.origin === 'base' && !fromBase.some((g) => g.classKey === f.classKey && g.input === f.input)) fromBase.push(f)
  }
  // a class seen before (on this PR, or carried from the stack), or twice in this review, makes the round a class round
  const repeated = [...new Set(mine.map((f) => f.classKey).filter((k) => classes[k] || mine.filter((g) => g.classKey === k).length >= 2))]
  for (const f of review.findings) classes[f.classKey] = { count: (classes[f.classKey]?.count || 0) + 1, why: f.classWhy }
  const classRound = repeated.length > 0
  rounds.push({ round, head: pushed.head, findings: mine, base: review.findings.length - mine.length, judgedCorrect: review.judgedCorrect, classRound })
  log(`round ${round}: ${mine.length} finding(s) of this PR, ${review.findings.length - mine.length} of the base${classRound ? `; CLASS round next (${repeated.join(', ')})` : ''}`)
  if (mine.length === 0) break
  if (round === MAX_ROUNDS) return { status: `still ${mine.length} finding(s) after ${MAX_ROUNDS} rounds: the coordinator decides`, pr: pushed.pr, head: pushed.head, rounds, fromBase, classes }

  const prev = pushed.head
  pushed = await agent(
    `${WHERE}Fix round ${round} on PR ${pushed.pr} (branch ${A.branch}) of the Mason repo. ${WORKTREE(`origin/${A.branch}`)} Run \`${BOARD} Fixing\` first.
The review found these FAILURES, each one this PR's (the base answered right). Each comes with its class; the fix is yours to work out, and none is given:
${asFailures(mine)}
${classRound
  ? `This is a CLASS round (CLAUDE.md "The loop" step 4): ${repeated.join(', ')} has now been met more than once. Before ANY code, write in the PR body every case of each such class that THIS PR's change reaches: every spelling, depth and kind of input, under each statement form. Give each a test against Postgres and watch it fail where it fails today. Then fix the DECISION that makes the class impossible, not the cases. A case the base already answers wrong is not this PR's: list it in the PR body under "On the base, filed separately" and leave it. About 60 tool calls.`
  : 'About 30 tool calls.'}
Each finding becomes a test (tests/duck-wire.test.ts for the engine) and, for the engine, an oracle statement. What the reviewer judged correct, do not re-check: ${review.judgedCorrect.join('; ')}.
Bound every test run. Run the tests of the change by --test-name-pattern, typecheck, and tests/conventions.test.ts; fails-without once on the final tree. Come back in ONE push. The commit ends with the Co-Authored-By line. Return the new head.`,
    { label: `fix r${round}${classRound ? ' (class)' : ''}`, phase: 'Fix', model: 'opus', effort: 'high', isolation: 'worktree', schema: PUSHED })
  if (!pushed) return { status: `fix round ${round} failed`, rounds, fromBase, classes }
  base = prev
  reviewKind = 'narrow'
}

// ---------------------------------------------------------------- 5. File the base's findings, one issue per class
let filed = { issues: [] }
if (fromBase.length) {
  phase('File')
  const byClass = {}
  for (const f of fromBase) (byClass[f.classKey] = byClass[f.classKey] || []).push(f)
  filed = await agent(
    `${WHERE}PR ${pushed.pr}'s review met wrong answers that origin/${A.base} already gives, so they are not that PR's to fix. File them as CLAUDE.md "What a session finds" says: ONE issue per class, each first looked for (\`gh issue list --state open --search "<words>"\`) and, when one already names the class, a comment on it instead. Each issue and comment begins \`### From Claude (Opus 5.5)\`, says what was seen (every input with Postgres's answer and Mason's), what is not known, the class and the decision that would make it impossible, and what done looks like, and that it was met in the review of PR ${pushed.pr}. Synthetic tables only. Run \`node ${REPO}/scripts/board.ts\` for nothing else. The classes:
${Object.entries(byClass).map(([k, fs]) => `## ${k}: ${fs[0].classWhy}\n${asFailures(fs)}`).join('\n\n')}`,
    { label: 'file', phase: 'File', model: 'sonnet', effort: 'medium', schema: FILED }) || { issues: [] }
  log(`filed: ${filed.issues.map((i) => `#${i.issue} (${i.classKey}, ${i.action})`).join(', ')}`)
}

// ---------------------------------------------------------------- 6. CI, until green, failures sent back as failures
for (let attempt = 1; attempt <= 3; attempt++) {
  const ci = await agent(
    `Wait for PR ${pushed.pr}'s CI at head ${pushed.head.slice(0, 7)} and report it. The wait is CLAUDE.md "Local gates"' loop on \`gh pr checks\` with a deadline, never \`--watch\`. Run this chunk of it in the foreground, as it is, each run under 10 minutes, up to 8 times, until its first line says green or failed; still pending after the 8th is a timeout:
\`${CI_WAIT(pushed.pr)}\`
\`gh pr checks\` exits 0 when all passed, 8 while any is pending, 1 on a failure, and also 1 with "no checks reported" just after a push, which is a wait, not a failure; a failure while others are still pending is a failure. Any other exit code is "couldn't tell": a wait, never green and never failed. On a failure, read each failing job's log: \`gh run view <run> --json jobs\`, then \`gh api repos/embeddable-hq/mason-data/actions/jobs/<id>/logs\` and the lines after "failing tests:" (for the oracle, the "differs:" lines and the first difference). Report each failing test's name and assertion text. Never re-run a job.`,
    { label: `CI ${attempt}`, phase: 'CI', model: 'sonnet', effort: 'low', schema: CI })
  const done = { pr: pushed.pr, head: pushed.head, rounds, fromBase, filed: filed.issues, classes }
  if (!ci || ci.state === 'timeout') return { status: 'CI not finished within the bound', ...done }
  if (ci.state === 'green') return { status: 'reviewed, no open finding of this PR, CI green: ready for the merge decision', ...done }
  log(`CI failed: ${ci.detail.slice(0, 200)}`)
  pushed = await agent(
    `${WHERE}CI failed on PR ${pushed.pr} (branch ${A.branch}). ${WORKTREE(`origin/${A.branch}`)} Run \`${BOARD} Fixing\`. The failure:
${ci.detail}
Read it (CLAUDE.md "Local gates"). If it is this change's, fix it, with a test. If it is a flake (a test the change cannot have touched, failing on timing or load), say so and change nothing: the coordinator quarantines it on main. If the oracle's allowlist or fixture is stale, regenerate it from this run (\`node scripts/oracle-legs.ts --write <run-id>\`) and read the diff. If ${A.base} has the fix, merge \`origin/${A.base}\`. Bound every test run. ONE push; return the new head.`,
    { label: `CI fix ${attempt}`, phase: 'Fix', model: 'opus', effort: 'high', isolation: 'worktree', schema: PUSHED })
  if (!pushed) return { status: 'CI fix failed', rounds, fromBase, classes }
}
return { status: 'CI still red after 3 fixes: the coordinator decides', pr: pushed.pr, head: pushed.head, rounds, fromBase, filed: filed.issues, classes }
