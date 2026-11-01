export const meta = {
  name: 'issue-loop',
  description: "An issue's PR-sized tasks, each through pr-loop in order: plan them (returned for the coordinator to read), then run them, carrying each task's classes to the next",
  whenToUse: 'A Mason issue too big for one PR. Call once without `tasks` to plan; read the plan; call again with `tasks` to run them',
  phases: [
    { title: 'Plan', detail: 'Opus splits the issue into tasks that could each ship alone', model: 'opus' },
    { title: 'Setup', detail: 'a sub-issue per task, the list posted on the issue' },
    { title: 'Tasks', detail: 'pr-loop for each, in order, stopping at the first that is not ready to merge' },
  ],
}

// args: { issue, base = 'main', prLoop?, tasks?, knownClasses?, from?, prev?, repo? }
//   repo: the main checkout's path, passed on to pr-loop. Without it each agent finds the repository itself (WHERE).
//   prLoop: a path to a pr-loop script to run instead of the named workflow `pr-loop` (.claude/workflows/pr-loop.js).
//   Without `tasks`: plan only, and return the tasks. The coordinator reads them (and may edit them) before a run: a
//   split is a design decision, and a run of several PRs is expensive to redo.
//   With `tasks`: run them in order. A task `stacked` on the one before it is based on that task's branch, its PR stacked
//   on that PR; otherwise on `base`. The classes each run met go to the next, so a class repeated across the stack makes
//   a class round (PR 170 and PR 207 met one class, and per-PR counting could not see it).
//   `from` (a task's index) resumes at that task, after the tasks before it have merged or been run.
const A = args
const REPO = A.repo || '<repo>'
const WHERE = A.repo
  ? `The repository's main checkout is ${A.repo}.\n`
  : "<repo> below is the repository's main checkout: the one your working directory is in (`git rev-parse --show-toplevel`), or for a worktree agent, its main checkout via `git rev-parse --path-format=absolute --git-common-dir` and its parent. Find it first and use its absolute path for <repo>.\n"
const BASE = A.base || 'main'

const TASKS = { type: 'object', required: ['tasks'], properties: {
  tasks: { type: 'array', items: { type: 'object', required: ['title', 'branch', 'scope', 'stacked', 'readFirst'], properties: {
    title: { type: 'string', description: 'short, as the sub-issue is titled: "<issue> · <piece>"' },
    branch: { type: 'string', description: `kebab-case, issue-${A.issue}-<piece>` },
    scope: { type: 'string', description: "what this PR changes and what it must not, the design section of the issue it implements, and how it is measured if it is a speed change; enough for a brief without this planner's context" },
    stacked: { type: 'boolean', description: 'true when it needs the previous task\'s code and so is based on its branch' },
    readFirst: { type: 'string', description: 'the files and functions a brief must read first' },
    subIssue: { type: 'number', description: 'an existing open sub-issue this task is, if there is one' },
  } } },
  notes: { type: 'string', description: "what the plan leaves out and why, and anything the coordinator should decide" },
} }
const SETUP = { type: 'object', required: ['subIssues'], properties: {
  subIssues: { type: 'array', items: { type: 'number' }, description: 'one per task, in order' },
} }

if (!A.tasks) {
  phase('Plan')
  const plan = await agent(
    `${WHERE}Split Mason issue #${A.issue} (embeddable-hq/mason-data, ${REPO}) into the PRs that remain, in order. Read the issue and every comment (\`gh issue view ${A.issue} --comments\`), its sub-issues and their state (\`gh issue list --state all --search "${A.issue} ·"\`), the PRs that close them (\`gh pr list --state all --search "${A.issue}"\`), and the code the remaining work touches on origin/${BASE} (\`git -C ${REPO} fetch origin ${BASE}\`, read with \`git -C ${REPO} show origin/${BASE}:<path>\`), and the .claude/rules/ file of each subsystem it touches.
Each task is ONE PR that could ship alone (CLAUDE.md "How work is done here"): small enough for one review, with its own tests. Done or open work (merged PRs, open PRs, sub-issues in progress) is not a task; say what you left out in notes. A task that needs another's code is \`stacked\` on it and comes right after it. Reuse an existing open sub-issue for a task when it is that task. Write each scope so a brief can be written from it alone. Do not create issues, comment or write code.`,
    { label: 'plan', phase: 'Plan', model: 'opus', effort: 'high', schema: TASKS })
  if (!plan) return { status: 'plan failed' }
  return { status: 'planned: read the tasks, then run again with `tasks`', issue: A.issue, ...plan }
}

phase('Setup')
const from = A.from || 0
const setup = await agent(
  `${WHERE}For Mason issue #${A.issue}: make sure each task below has a sub-issue, then post the list. For a task with a subIssue, use it. For one without, run \`node ${REPO}/scripts/board.ts sub ${A.issue} "<its title>" --from "Opus 5.5"\` from ${REPO} (run board.ts from that file, never through \`node <(git show …)\`, which exits 0 having run nothing) and take the number it prints; then \`gh issue edit <n> --body-file <file>\` with its scope, headed \`### From Claude (Opus 5.5)\`. Then comment once on #${A.issue}, headed the same way: the tasks in order, each with its sub-issue, whether it is stacked, and that each runs through the pr-loop workflow (.claude/workflows/pr-loop.js). Skip the comment when the issue already has one listing these same sub-issues. Return the sub-issue numbers in order.
Tasks:
${A.tasks.map((t, i) => `${i + 1}. ${t.title}${t.subIssue ? ` (sub-issue #${t.subIssue})` : ''}${t.stacked ? ' [stacked on the one before]' : ''}\n   ${t.scope}`).join('\n')}`,
  { label: 'setup', phase: 'Setup', model: 'sonnet', effort: 'low', schema: SETUP })
if (!setup || setup.subIssues.length !== A.tasks.length) return { status: 'setup failed: sub-issues not made', setup }

phase('Tasks')
let classes = { ...(A.knownClasses || {}) }
let prev = A.prev || null // { branch, pr } of the task before `from`, when resuming a stack
const done = []
for (let i = from; i < A.tasks.length; i++) {
  const t = A.tasks[i]
  const stackedOn = t.stacked && prev ? prev : null
  log(`task ${i + 1}/${A.tasks.length}: #${setup.subIssues[i]} ${t.title}${stackedOn ? ` (stacked on PR ${stackedOn.pr})` : ''}`)
  const r = await workflow(A.prLoop ? { scriptPath: A.prLoop } : 'pr-loop', {
    issue: setup.subIssues[i], parent: A.issue, title: t.title,
    base: stackedOn ? stackedOn.branch : BASE, branch: t.branch,
    stackedOn: stackedOn ? String(stackedOn.pr) : '',
    context: t.scope, ...(A.repo ? { repo: A.repo } : {}), readFirst: t.readFirst, knownClasses: classes,
  })
  done.push({ task: i, subIssue: setup.subIssues[i], ...(r || { status: 'pr-loop returned nothing' }) })
  if (!r || !String(r.status).startsWith('reviewed')) {
    return { status: `stopped at task ${i + 1}: ${r ? r.status : 'no result'}`, resume: { from: i, prev, knownClasses: classes }, done }
  }
  classes = r.classes || classes
  prev = { branch: t.branch, pr: r.pr }
}
return { status: 'every task reviewed and green: each waits on its merge, in order', done, classes }
