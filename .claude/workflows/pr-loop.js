export const meta = {
  name: 'pr-loop',
  description: 'One PR through CLAUDE.md "The loop": brief, implement (Opus), review (Fable), fix rounds with the class rule, CI, then stop at the merge gate',
  whenToUse: 'One sub-issue of a Mason issue, taken from brief to a reviewed, green PR ready for the merge decision',
  phases: [
    { title: 'Brief', detail: 'Opus names the shapes and the tests', model: 'opus' },
    { title: 'Implement', detail: 'Opus, a worktree of its own, ends at the push', model: 'opus' },
    { title: 'Review', detail: 'Fable, fresh context, findings with their class and whether the base has them', model: 'fable' },
    { title: 'Fix', detail: "this PR's failures and classes, never the edit; a repeated class makes a class round", model: 'opus' },
    { title: 'CI', detail: 'bounded wait on gh pr checks; a CI fix gets a narrow re-check' },
    { title: 'File', detail: "the base's findings, one issue per class, at every exit" },
  ],
}

// args: { issue, parent, title, base, branch, stackedOn, context, readFirst?, knownClasses?, repo? }
//   repo: the main checkout's path. Without it each agent finds the repository itself (WHERE), so the script runs for
//   anyone on the team, from any checkout: no path of one machine is written here.
//   knownClasses: { slug: { count, why } } carried from the PRs this one is stacked on (or the issue's earlier PRs), so
//   a class met on PR 170 counts on PR 207 too. The run returns its classes in the same shape, for the next run: only
//   the classes of findings a PR made, never the base's, which are filed instead.
// Every exit returns one shape, result(status): { status, pr, head, rounds, fromBase, filed, classes }.
const A = args
const REPO = A.repo || '<repo>'
const WHERE = A.repo
  ? `The repository's main checkout is ${A.repo}.\n`
  : "<repo> below is the repository's main checkout: the one your working directory is in (`git rev-parse --show-toplevel`), or for a worktree agent, its main checkout via `git rev-parse --path-format=absolute --git-common-dir` and its parent. Find it first and use its absolute path for <repo>.\n"
// the board is moved from the main checkout's file, never through `node <(git show …)`, which exits 0 having run nothing
const BOARD = (status) => `node ${REPO}/scripts/board.ts status ${A.issue} "${status}"`
const MAX_ROUNDS = 4

// Each stage's model, and the name what it posts is signed with: a posting names the model that wrote it, read from
// the same value as the agent's `model`, never written beside it.
const SIGNS = { opus: 'Opus 5.5', fable: 'Fable', sonnet: 'Sonnet' }
const ON = {
  brief: { model: 'opus', effort: 'high' },
  implement: { model: 'opus', effort: 'high', isolation: 'worktree' },
  review: { model: 'fable', effort: 'medium' },
  fix: { model: 'opus', effort: 'high', isolation: 'worktree' },
  ci: { model: 'sonnet', effort: 'low' },
  file: { model: 'sonnet', effort: 'medium' },
}
const signed = (on) => `### From Claude (${SIGNS[on.model]})`
const coAuthor = (on) => `Co-Authored-By: Claude ${SIGNS[on.model]} <noreply@anthropic.com>`

// One chunk of the CI wait (CLAUDE.md "Local gates": a `gh pr checks` loop with a deadline, never --watch, which exits
// at once on "no checks reported"). gh pr checks exits 0 when all passed, 8 while any is pending, 1 on a failure, and
// also 1 with "no checks reported" just after a push, which is a wait, not a failure; a failure while others are still
// pending is a failure (gh says 1). Any other exit is "couldn't tell", waited on like a pending one, and the last exit
// code is printed. Nine minutes: the agent's tool call is given a timeout of 600000 ms (CI_TOOL_MS), past the chunk, as
// the default of two minutes would kill it before it printed. The $SECONDS deadline bounds the loop, since an alarm
// exec'd into gh (a Go program) is ignored.
const CI_CHUNK_S = 540
const CI_TOOL_MS = 600000
const CI_WAIT = (pr) => `p=${pr}; end=$((SECONDS + ${CI_CHUNK_S})); st=pending; while [ $SECONDS -lt $end ]; do out=$(gh pr checks "$p" 2>&1); rc=$?; if [ $rc -eq 0 ]; then st=green; break; elif [ $rc -eq 1 ] && ! grep -q "no checks reported" <<<"$out"; then st=failed; break; fi; sleep 10; done; echo "PR $p: $st (last exit $rc)"; printf '%s\\n' "$out"`

// Every agent that writes code runs with isolation 'worktree': a worktree made for it, which it may edit. A worktree
// another agent made is another session's to the edit guard, so a fix agent sent to the implementer's worktree was
// blocked and moved into the coordinator's own (PR 207, round 2): two writers on one tree. The implementer makes the
// branch in its own worktree, which keeps it checked out; every agent after it works detached at the branch's tip and
// pushes HEAD to it, since a branch can be checked out in one worktree only.
const WORKTREE = (from) => `You run in a git worktree made for you; work only there, never in another worktree. Start with \`git fetch origin ${A.branch} ${A.base} && git checkout --detach ${from}\`, and push with \`git push origin HEAD:${A.branch}\`. Never \`git checkout ${A.branch}\` (a branch can be checked out in one worktree only).`
// the gates of a fix round (CLAUDE.md "Local gates"): the change's tests, typecheck and the two fast convention files
const FIX_GATES = 'Bound every test run. Run the tests of the change by --test-name-pattern, `npm run typecheck`, and `node --test --test-timeout=120000 tests/conventions.test.ts tests/cli-state-matrix.test.ts`; fails-without once on the final tree.'

const BRIEF = { type: 'object', required: ['brief', 'shapes', 'tests'], properties: {
  brief: { type: 'string', description: 'what to build, where, and the decision it takes' },
  shapes: { type: 'array', items: { type: 'string' }, description: 'every shape the tests and oracle must hold, each a concrete SQL statement or input' },
  tests: { type: 'array', items: { type: 'string' }, description: 'the test files and --test-name-pattern / IT_ORACLE_ONLY the runs use' },
} }
const PUSHED = { type: 'object', required: ['pr', 'head', 'summary'], properties: {
  pr: { type: 'number' }, head: { type: 'string', description: 'full sha pushed' },
  summary: { type: 'string' }, failsWithout: { type: 'string', description: 'scripts/fails-without.ts verdict line, if run' },
} }
// a CI fix may push nothing: a flake is the coordinator's to quarantine on main
const CI_FIXED = { ...PUSHED, required: [...PUSHED.required, 'flake'], properties: { ...PUSHED.properties,
  flake: { type: 'boolean', description: 'true when the failure is a flake and nothing was pushed; head is then the unchanged head' },
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
// the classes of THIS PR's findings and the stack's (knownClasses), never the base's: a class the base has is filed,
// and counting it here would make a class round of a class this PR did not make
const classes = { ...(A.knownClasses || {}) }
const knownList = () => Object.entries(classes).map(([k, c]) => `${k} (${c.count}×: ${c.why})`).join('\n  ') || '(none)'

const rounds = []
const fromBase = []
const filed = []
let last = null // the PR's last pushed head: { pr, head }
const result = (status) => ({ status, pr: last ? last.pr : null, head: last ? last.head : null, rounds, fromBase, filed, classes })

// Every exit goes through finish: the base's findings are filed whatever stopped the run, so "never fixed in the PR"
// never means "never filed" either.
async function finish(status) {
  if (fromBase.length) {
    phase('File')
    const byClass = {}
    for (const f of fromBase) (byClass[f.classKey] = byClass[f.classKey] || []).push(f)
    const r = await agent(
      `${WHERE}PR ${last.pr}'s review met wrong answers that origin/${A.base} already gives, so they are not that PR's to fix. File them as CLAUDE.md "What a session finds" says: ONE issue per class, each first looked for (\`gh issue list --state open --search "<words>"\`) and, when one already names the class, a comment on it instead. Each issue and comment begins \`${signed(ON.file)}\`, says what was seen (every input with Postgres's answer and Mason's), what is not known, the class and the decision that would make it impossible, and what done looks like, and that it was met in the review of PR ${last.pr}. Synthetic tables only. Move no card on the board: PR ${last.pr}'s card is moved by its own stages. The classes:
${Object.entries(byClass).map(([k, fs]) => `## ${k}: ${fs[0].classWhy}\n${asFailures(fs)}`).join('\n\n')}`,
      { label: 'file', phase: 'File', ...ON.file, schema: FILED })
    if (r) filed.push(...r.issues)
    else status = `${status}; filing the base's findings failed: they are in fromBase`
    log(`filed: ${filed.map((i) => `#${i.issue} (${i.classKey}, ${i.action})`).join(', ') || 'nothing'}`)
  }
  return result(status)
}

// ---------------------------------------------------------------- Review and fix rounds, with the class rule
// Only this PR's findings drive a round. A finding the base already answers wrong is the base's: it is filed (finish)
// and never patched here, or a PR chases a class it did not make (PR 207: a numeric quotient computed as a double,
// main's since before the PR, took three rounds and grew each one). Returns null when a review finds nothing of this
// PR's, else the status to stop with. `start` is the first review: { kind: 'full' }, or { kind: 'narrow', base, what }
// for a re-check of the commits since `base`, `what` saying what they were meant to fix.
let round = 0
async function reviewAndFix(start) {
  let { kind, base, what } = start
  for (let n = 1; n <= MAX_ROUNDS; n++) {
    round++
    phase('Review')
    const judged = rounds.flatMap((x) => x.judgedCorrect)
    const review = await agent(
      `${WHERE}First run \`${BOARD('In review')}\`. ${kind === 'full' ? 'Review' : 'Narrowly re-check the latest fix of'} PR ${last.pr} of embeddable-hq/mason-data at head ${last.head}, for wrong answers. Run \`git -C ${REPO} fetch origin ${A.branch} ${A.base}\` and \`git -C ${REPO} diff ${base} ${last.head}\`, and read the whole touched files at that head with \`git show\`. Read the .claude/rules/ file of the subsystem. Never take the author's report as evidence. Probe against a real Postgres as the tests do, in two worktrees of your own under the system temp dir (\`git -C ${REPO} worktree add "$(mktemp -d)/head" <sha>\`), never under a home path, one at the head and one at origin/${A.base}, both removed afterwards (\`git -C ${REPO} worktree remove\`). Do not edit or push.
${kind === 'full' ? `The shapes the brief named:\n${brief.shapes.map((s) => '- ' + s).join('\n')}\nLook beyond them too. About 40 tool calls.` : `${what}\nLook for what the fix broke, in the code it changed only. Already judged correct, so do NOT re-check: ${judged.join('; ') || '(nothing yet)'}. About 20 tool calls.`}
For each confirmed finding give the failing input, Postgres's answer, Mason's answer at the head, and Mason's answer at the base (RUN it there), where, and its CLASS: the kind of mistake and the decision that would make it impossible (CLAUDE.md "Fix the class, not the symptom"). origin is 'base' when the base gives the same wrong answer, else 'this-pr'. Known classes, to REUSE by slug when it is the same class:
  ${knownList()}
Give no fix and no patch. Also list what you judged correct.`,
      { label: `review r${round}`, phase: 'Review', ...ON.review, schema: FINDINGS })
    if (!review) return `review r${round} failed`
    const mine = review.findings.filter((f) => f.origin === 'this-pr')
    // one input is one finding, whatever slug a later round gives it
    for (const f of review.findings) if (f.origin === 'base' && !fromBase.some((g) => g.input === f.input)) fromBase.push(f)
    // a class seen before (on this PR, or carried from the stack), or twice in this review, makes the fix a class round
    const repeated = [...new Set(mine.map((f) => f.classKey).filter((k) => classes[k] || mine.filter((g) => g.classKey === k).length >= 2))]
    for (const f of mine) classes[f.classKey] = { count: (classes[f.classKey]?.count || 0) + 1, why: f.classWhy }
    const classRound = repeated.length > 0
    rounds.push({ round, head: last.head, findings: mine, base: review.findings.length - mine.length, judgedCorrect: review.judgedCorrect, classRound })
    log(`round ${round}: ${mine.length} finding(s) of this PR, ${review.findings.length - mine.length} of the base${classRound ? `; CLASS round next (${repeated.join(', ')})` : ''}`)
    if (mine.length === 0) return null
    if (n === MAX_ROUNDS) return `still ${mine.length} finding(s) after ${MAX_ROUNDS} rounds: the coordinator decides`

    phase('Fix')
    const fixed = await agent(
      `${WHERE}Fix round ${round} on PR ${last.pr} (branch ${A.branch}) of the Mason repo. ${WORKTREE(`origin/${A.branch}`)} Run \`${BOARD('Fixing')}\` first.
The review found these FAILURES, each one this PR's (the base answered right). Each comes with its class; the fix is yours to work out, and none is given:
${asFailures(mine)}
${classRound
  ? `This is a CLASS round (CLAUDE.md "The loop" step 4): ${repeated.join(', ')} has now been met more than once. Before ANY code, write in the PR body every case of each such class that THIS PR's change reaches: every spelling, depth and kind of input, under each statement form. Give each a test against Postgres and watch it fail where it fails today. Then fix the DECISION that makes the class impossible, not the cases. A case the base already answers wrong is not this PR's: list it in the PR body under "On the base, filed separately" and leave it. About 60 tool calls.`
  : 'About 30 tool calls.'}
Each finding becomes a test (tests/duck-wire.test.ts for the engine) and, for the engine, an oracle statement. What the reviewer judged correct, do not re-check: ${review.judgedCorrect.join('; ') || '(nothing listed)'}.
${FIX_GATES} Come back in ONE push. The commit ends with \`${coAuthor(ON.fix)}\`. Return the new head.`,
      { label: `fix r${round}${classRound ? ' (class)' : ''}`, phase: 'Fix', ...ON.fix, schema: PUSHED })
    if (!fixed) return `fix round ${round} failed`
    if (fixed.head === last.head) return `fix round ${round} pushed nothing: the coordinator decides`
    base = last.head
    last = fixed
    kind = 'narrow'
    what = `The previous round's findings were:\n${asFailures(mine)}\nCheck each is fixed.`
  }
  return `still findings after ${MAX_ROUNDS} rounds: the coordinator decides`
}

// ---------------------------------------------------------------- Brief
phase('Brief')
const brief = await agent(
  `${WHERE}Write the brief for ONE PR of the Mason repo (${REPO}): sub-issue #${A.issue} of #${A.parent}, "${A.title}".
Read issue #${A.parent} and its comments (\`gh issue view ${A.parent} --comments\`) for this task's part, and the code it builds on: branch \`${A.base}\` (\`git -C ${REPO} fetch origin ${A.base}\`; read with \`git -C ${REPO} show origin/${A.base}:<path>\`)${A.readFirst ? `, especially ${A.readFirst}` : ''}. Read the .claude/rules/ file of the subsystem it touches.
${A.context || ''}
The brief follows CLAUDE.md "The loop" step 1: name what the tests must hold, not only what to build. List EVERY shape the tests (and for the engine, the oracle) must answer equal to Postgres, as concrete SQL over the tests' own tables, including the shapes .claude/rules/duck-rewrite.md requires of a rewrite and the fallback shapes that must stay as written. Name the test files and the --test-name-pattern / IT_ORACLE_ONLY the runs use. Do not write code.`,
  { label: 'brief', phase: 'Brief', ...ON.brief, schema: BRIEF })
if (!brief) return await finish('brief failed')

// ---------------------------------------------------------------- Implement
phase('Implement')
last = await agent(
  `${WHERE}Implement ONE PR in the Mason repo, about 40 tool calls, ending at the push. First run \`${BOARD('Implementing')}\`.
You run in a git worktree made for you; work only there. Start with \`git fetch origin ${A.base} && git checkout -b ${A.branch} origin/${A.base}\`.
Task: #${A.issue} of #${A.parent}, "${A.title}".
${brief.brief}

Shapes the tests must hold (each a test against Postgres, and for the engine an oracle statement):
${brief.shapes.map((s) => '- ' + s).join('\n')}

Test runs: ${brief.tests.join('; ')}. Bound every run (\`node --test --test-timeout=<ms> ...\`). Follow CLAUDE.md "Local gates": the nearest tests, one full \`npm run check\` before the first push, no full oracle locally, scripts/fails-without.ts once on the final tree by --test-name-pattern. A product change adds its line to release-notes/next.md.
Push with \`git push -u origin ${A.branch}\`, and open the PR with \`gh pr create --base ${A.base} --head ${A.branch}\`. Its body starts \`${signed(ON.implement)}\`, says \`Closes #${A.issue}\`${A.stackedOn ? ` and that it is stacked on PR ${A.stackedOn}` : ''}, carries the fails-without verdict, and ends with the Claude Code line. The commit ends with \`${coAuthor(ON.implement)}\`. Do not merge.`,
  { label: 'implement', phase: 'Implement', ...ON.implement, schema: PUSHED })
if (!last) return await finish('implement failed')
log(`PR ${last.pr} pushed at ${last.head.slice(0, 7)}`)

const stopped = await reviewAndFix({ kind: 'full', base: `origin/${A.base}` })
if (stopped) return await finish(stopped)

// ---------------------------------------------------------------- CI, until green, failures sent back as failures
// A CI fix is a fix commit like any other, so it gets a narrow re-check (CLAUDE.md "The loop" step 4) before CI again.
for (let attempt = 1; attempt <= 3; attempt++) {
  phase('CI')
  const ci = await agent(
    `${WHERE}First run \`${BOARD('CI / queued')}\`. Wait for PR ${last.pr}'s CI at head ${last.head.slice(0, 7)} and report it. The wait is CLAUDE.md "Local gates"' loop on \`gh pr checks\` with a deadline, never \`--watch\`. Run this chunk of it in the foreground, as it is, with the Bash tool's timeout set to ${CI_TOOL_MS} (the chunk runs up to ${CI_CHUNK_S / 60} minutes, and the default timeout of two minutes would kill it before it prints), up to 8 times, until its first line says green or failed; still pending after the 8th is a timeout:
\`${CI_WAIT(last.pr)}\`
If the tool refuses the loop (a foreground \`sleep\`), run the same chunk with run_in_background and read its output when it exits; never drop its deadline or use \`--watch\` instead.
\`gh pr checks\` exits 0 when all passed, 8 while any is pending, 1 on a failure, and also 1 with "no checks reported" just after a push, which is a wait, not a failure; a failure while others are still pending is a failure. Any other exit code is "couldn't tell": a wait, never green and never failed. On a failure, read each failing job's log: \`gh run view <run> --json jobs\`, then \`gh api repos/embeddable-hq/mason-data/actions/jobs/<id>/logs\` and the lines after "failing tests:" (for the oracle, the "differs:" lines and the first difference). Report each failing test's name and assertion text. Never re-run a job.`,
    { label: `CI ${attempt}`, phase: 'CI', ...ON.ci, schema: CI })
  if (!ci) return await finish(`CI wait ${attempt} returned nothing: the coordinator looks`)
  if (ci.state === 'timeout') return await finish('CI not finished within the bound')
  if (ci.state === 'green') return await finish('reviewed, no open finding of this PR, CI green: ready for the merge decision')
  log(`CI failed: ${ci.detail.slice(0, 200)}`)
  phase('Fix')
  const fixed = await agent(
    `${WHERE}CI failed on PR ${last.pr} (branch ${A.branch}). ${WORKTREE(`origin/${A.branch}`)} Run \`${BOARD('Fixing')}\`. The failure:
${ci.detail}
Read it (CLAUDE.md "Local gates"). If it is this change's, fix it, with a test. If it is a flake (a test the change cannot have touched, failing on timing or load), say so with flake: true, change nothing and return the head unchanged: the coordinator quarantines it on main. If the oracle's allowlist or fixture is stale, regenerate it from this run (\`node scripts/oracle-legs.ts --write <run-id>\`) and read the diff. If ${A.base} has the fix, merge \`origin/${A.base}\`. ${FIX_GATES} ONE push, whose commit ends with \`${coAuthor(ON.fix)}\`; return the new head.`,
    { label: `CI fix ${attempt}`, phase: 'Fix', ...ON.fix, schema: CI_FIXED })
  if (!fixed) return await finish(`CI fix ${attempt} failed`)
  if (fixed.flake) return await finish(`CI failed on a flake, nothing pushed: the coordinator quarantines it (${fixed.summary})`)
  if (fixed.head === last.head) return await finish(`CI fix ${attempt} pushed nothing: the coordinator decides`)
  const prev = last.head
  last = fixed
  const again = await reviewAndFix({ kind: 'narrow', base: prev, what: `The commits since ${prev.slice(0, 7)} fix this CI failure:\n${ci.detail}\nCheck they fix it and change no answer Postgres would give.` })
  if (again) return await finish(again)
}
return await finish('CI still red after 3 fixes: the coordinator decides')
