---
name: pr-persistent
description: Take ONE PR of embeddable-hq/mason-data through CLAUDE.md "The loop" with ONE persistent Opus implementer that the coordinator keeps alive and sends each review's findings to by SendMessage, and a fresh Fable review each round that runs statements at scale with pr-loop.js's own text. Use it when the coordinator runs a sub-issue this way instead of the Workflow scripts, as in the race against .claude/workflows/pr-loop-slim.js on issue 176.
---

# pr-persistent: one PR, one implementer kept alive

You are the COORDINATING session. You follow these steps with the Agent and SendMessage tools; nothing here runs by
itself. It is one of two experimental processes raced on issue 176 (Tom, 2026-11-01); the other is
`.claude/workflows/pr-loop-slim.js`. Both keep `.claude/workflows/pr-loop.js`'s review word for word, because that
review is the yardstick.

**Why.** On issue 192 one persistent Opus agent, sent the review's findings by message, took 1 h 51 min (plus 42 min
for a fix round) where pr-loop took 5.5 h and was unfinished, on about 1/2.3 of its Opus output tokens: a fix round
rebuilt no context. Its first review only read code and missed 2 regressions and about 4 wrong answers; pr-loop's
review now RUNS statements at scale (PR 245), and this process uses that review. A Workflow `agent()` is one-shot, so
"the findings go back to the agent that wrote the code" needs a coordinator holding the agent: this skill.

The inputs are pr-loop's args: the sub-issue, its parent, the title, the base (`main`, or the PR below for a stacked
one), the branch, `stackedOn`, the context, the known classes carried from the stack, and an `itEnv` file if you have
one. Read CLAUDE.md "How work is done here" and `.claude/workflows/pr-loop.js` once before step 1: several steps
below point at its text by name, and you paste that text, never your own version of it.

## 0. The race log

For the race, keep a log in your scratchpad: for EVERY step below, its wall-clock start and end (`date -u +%FT%TZ`
when it starts and when it ends) and, for each agent, the tokens and tool uses its completion notification reports.
A SendMessage round to the implementer is its own row: the implementer's tokens are read from each notification it
sends when it finishes a round. Learn's own time is a row of its own (step 6), so the race can be compared with and
without it. The totals go into the Review record's text (step 8), never its JSON block.

## 1. Brief

Write the brief yourself (CLAUDE.md "The loop" step 1). Read the parent issue and its comments
(`gh issue view <parent> --comments`), the code at `origin/<base>`, and the `.claude/rules/` file of each subsystem it
touches. The brief has pr-loop's BRIEF shape:

- `brief`: what to build, where, and the decision it takes;
- `shapes`: EVERY shape the tests and, for the engine, the oracle must answer equal to Postgres, each a concrete SQL
  statement over the tests' own synthetic tables, including the shapes `.claude/rules/duck-rewrite.md` requires of a
  rewrite and the fallback shapes that must stay as written;
- `tests`: the test files, each with its `--test-name-pattern`, and the `IT_ORACLE_ONLY=<regex>` the oracle runs use.

In the race, the same brief object goes to `pr-loop-slim.js` as its `brief` arg, so both arms start from one brief.

## 2. Render the shared text

A skill cannot import JavaScript, so the text both processes share is rendered from the workflow files themselves.
It lives in `.claude/workflows/pr-loop.js`: `REPRO_TABLES`, `VARIANT_FORMS`, `PG_ACCESS`, `STATEMENT_PATHS`, `BATCH`,
`CHECKS` and `EVIDENCE` (between `const PROBE_TREES` and `const BRIEF`), `SEVERITY_RULE` and the `FINDINGS` schema
(between `const BLOCKING` and `const FILED`), and the review's scale in `reviewAndFix` (`EVIDENCE(kind === 'full' …`);
the author's own check is `SELF_CHECK` in `.claude/workflows/pr-loop-slim.js`. Run this from anywhere, with `REPO` the
main checkout, `BASE` and `BRANCH` the PR's, and `IT_ENV` the itEnv file or empty; paste what it prints, as printed:

- `PART=review SCALE=full`: the full review's evidence text, SEVERITY_RULE and the FINDINGS schema (step 4);
- `PART=review SCALE=narrow`: the same for a narrow re-check (step 5);
- `PART=implement`: the implementer's own check at scale before its first push (step 3);
- `PART=fix`: a fix's own check at scale, for its fix's paths (step 5).

```sh
# render-review-text: prints the text pr-loop.js's review, or pr-loop-slim.js's author, is given
node --input-type=module <<'EOF'
import fs from "node:fs";
const e = process.env;
const read = (f) => fs.readFileSync(`${e.REPO}/.claude/workflows/${f}`, "utf8");
const cut = (src, from, to) => {
  const i = src.indexOf(from), j = src.indexOf(to, i + 1);
  if (i < 0 || j < 0) throw new Error(`the workflow no longer has ${from} … ${to}: read it by hand and fix this skill`);
  return src.slice(i, j);
};
const A = { repo: e.REPO, base: e.BASE, branch: e.BRANCH, itEnv: e.IT_ENV || undefined };
const make = (body, names) => new Function("A", "REPO", `${body}; return { ${names} }`)(A, e.REPO);
if (e.PART === "review") {
  const loop = read("pr-loop.js");
  const t = make(cut(loop, "const PROBE_TREES", "const BRIEF =") + cut(loop, "const BLOCKING", "const FILED ="), "PROBE_TREES, EVIDENCE, SEVERITY_RULE, FINDINGS");
  const m = /EVIDENCE\(kind === 'full'\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\)/.exec(loop);
  if (!m) throw new Error("pr-loop.js no longer says the review's scale as EVIDENCE(kind === 'full' ? … : …)");
  const scale = { full: m[1], narrow: m[2] }[e.SCALE];
  if (!scale) throw new Error("SCALE is full or narrow");
  console.log(`Run what you check ${t.PROBE_TREES}.${t.EVIDENCE(scale)}\n\n${t.SEVERITY_RULE}\n\nEnd your report with ONE fenced json block of this shape, pr-loop's FINDINGS schema: ${JSON.stringify(t.FINDINGS)}`);
} else if (e.PART === "implement" || e.PART === "fix") {
  const t = make(cut(read("pr-loop-slim.js"), "const PROBE_TREES", "const BRIEF ="), "SELF_CHECK, IMPLEMENT_SCALE, FIX_SCALE");
  console.log(t.SELF_CHECK(e.PART === "implement" ? t.IMPLEMENT_SCALE : t.FIX_SCALE));
} else throw new Error("PART is review, implement or fix");
EOF
```

## 3. One implementer, kept alive for the whole PR

Run `node <repo>/scripts/board.ts status <sub-issue> "Implementing"`. Start ONE implementer with the Agent tool:
`model: "opus"`, `effort: "high"`, `isolation: "worktree"`; it runs in the background and notifies you when it
reports. Keep its agent ID: every later round goes to THIS agent by SendMessage, never to a new one. Its prompt is
pr-loop.js's implement prompt (the `Implement` section) with these differences, and with the brief pasted in:

- **Design note first.** No design review comes before it: before any code it writes the design note (pr-loop.js's
  `DESIGN` fields: the decision; for EACH fact the change needs, the module that is its AUTHORITY and why not another;
  the principles; the shapes table; what is out of scope) and puts it in the PR body under `## Design`.
- **Implement, then the local gates** CLAUDE.md "Local gates" names: the nearest tests, bounded; one full
  `npm run check` before the first push; no full oracle locally; `scripts/fails-without.ts` once on the final tree;
  the `## What review probes` of each rules file its paths fall under; a product change's line in
  `release-notes/next.md`.
- **Then check at scale before the first push**: paste the `PART=implement` render. It runs its own statements in
  batches through `scripts/duck-repro.ts` at its head and at the base, the brief's shapes in every variant form plus
  the regression sweep of each touched path without the new feature, runs what it changed on the other paths, fixes
  what differs, and reports `statementsRun`, `statementsMatched` and `checksRun`.
- **Push and open the PR**: `git push -u origin <branch>`, `gh pr create --base <base> --head <branch>`, a body that
  starts `### From Claude (Opus 5.5)`, says `Closes #<sub-issue>` (and that it is stacked on PR n, if it is), carries
  the design note and the fails-without verdict, and ends with the Claude Code line. Each commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. It does not merge.
- **The handoff.** With every push it reports its HANDOFF, in pr-loop-slim.js's `HANDOFF` shape, as a fenced json
  block: `{ "decisions": [{ "what", "why" }], "rejected": [{ "what", "why" }], "keyFiles": [string], "risks": [string] }`,
  the design decisions and why, what it tried and rejected and why, the files and functions that matter, the open
  risks. It keeps the same object as ONE PR comment, `### From Claude (Opus 5.5)` then `## Handoff`, then
  `### Decisions`, `### Rejected`, `### Key files` and `### Risks`, posted with the first push and edited in place
  after each fix (`gh api -X PATCH repos/embeddable-hq/mason-data/issues/comments/<id> -F body=@<file>`), never a
  second one. It is insurance against its own context being compacted, and keeps the two arms' records alike.
- **It ends each round at the push** and reports the PR number, the full head sha, a summary, the fails-without
  verdict, its counts and its handoff. It does NOT wait on CI. Then it stops and waits: tell it that the coordinator
  will send the review's findings to it by message, and that it keeps its worktree and its context for them.

When it reports, check that GitHub links the PR to the sub-issue: pr-loop.js's `LINK_QUERY`
(`closedByPullRequestsReferences`) must list the PR; for a stacked PR, the body must say `Closes #<sub-issue>`. If not,
SendMessage the implementer to fix the body, and ask again; still not linked, stop there (step 8).

## 4. Each round: a fresh review, with CI read beside it

Run `node <repo>/scripts/board.ts status <sub-issue> "In review"`. Start a FRESH review with the Agent tool:
`model: "fable"`, `effort: "medium"`, no worktree isolation (it makes its own throwaway worktrees), never the
implementer's report or handoff. Its prompt is pr-loop.js's review prompt in `reviewAndFix`, the full form for the
first round, filled in as pr-loop fills it: the head and the base, the `git diff`, the rules file, the brief's shapes,
the known classes (pr-loop's `knownList`), what is already deferred (`alreadyDeferred`), and where pr-loop says
`Run what you check …`, the `PART=review SCALE=full` render pasted as printed. Add pr-loop-slim.js's one sentence, that
the `## Handoff` comment is the author's account and never read. Nothing else: the review text is the yardstick.

Beside it, read CI: start pr-loop.js's `CI_WAIT` loop for the PR in the background (`run_in_background`), the
`gh pr checks` loop with its deadline, never `--watch`; its exit wakes you.

When the review reports, read its FINDINGS block and sort every finding as pr-loop's `tally` does:

- `origin: "base"`: the base already gives it. Kept for filing (step 8); never sent to the implementer, never counted
  toward a class.
- this PR's, of a non-blocking severity (`message`, `over-refusal`, `docs`, `quality`): deferred, filed at the end,
  never fixed here.
- this PR's, of a blocking severity (`wrong-answer`, `crash`, `data-loss`, `security`, `regression`), or of no or an
  unknown severity: BLOCKING. Only these send the PR back.

The evidence rule: the review's `changedPaths` decide what it owed (pr-loop's `STATEMENT_PATHS`: statements for the
engine's and the listener's paths, checks for every other). A review that owed statements and ran none, or owed checks
and ran none, or did not say its paths, is no review: stop `unreviewed: …` (step 8), as pr-loop's `missingEvidence`
does. Count a round toward `reviewRounds` only when it showed its evidence.

No blocking finding of this PR's: the round is clean; go to step 6.

## 5. Fix: the findings go back to THE SAME implementer

Run `node <repo>/scripts/board.ts status <sub-issue> "Fixing"`. Send ONE message to the implementer by SendMessage:

- this round's blocking failures, each as pr-loop's `asFailures` writes it: its class and severity, the class's why,
  the input, Postgres's answer, Mason's, and where. Never a patch and never the edit: the fix is the implementer's to
  work out;
- CI's failure, when the CI read beside the review was red, to be fixed in the same push (a flake: it changes nothing
  for it and says so, and you quarantine it as CLAUDE.md "Local gates" says);
- **the class rule.** When a class among them was met before on this PR or the stack, or twice in this round, this is
  a CLASS round: paste pr-loop.js's class-round paragraph from `fixPrompt` ("This is a CLASS round …"), about 60
  tool calls;
- what the round judged correct, not to be re-checked;
- its latest handoff, verbatim, to read before it changes any design decision (and to say why in the handoff if it
  changes one);
- pr-loop.js's `FIX_GATES`, then the `PART=fix` render: its own check at scale for its fix's paths before the push;
- ONE push, then report as in step 3, the handoff updated and its comment edited in place.

When it reports, start a narrow re-check: a fresh Fable review, as in step 4 but the narrow form of pr-loop's review
prompt, the `PART=review SCALE=narrow` render, the previous round's failures as `what`, and every round's judged-correct
list. CI is read beside it again. Each review is a round; at most **4 review rounds** in all, the CI fixes' re-checks
included: past 4, stop and decide yourself (step 8). A fix that pushed nothing is a stop too.

## 6. Learn, once the reviews are clean

Only when some round had a blocking finding of this PR's. Note its start in the race log: Learn's own time is a row
of its own. Start a fresh learner with the Agent tool, `model: "opus"`, `effort: "medium"`, `isolation: "worktree"`,
with pr-loop.js's `Learn` prompt and every blocking finding of this PR: for each class, ONE bullet in the
`## What review probes` section of the `.claude/rules/` file whose `paths:` covers the finding's file, a synthetic
shape, the class and the PR; ONE docs-only commit, touching `.claude/rules/` only; then
`node --test --test-timeout=120000 tests/workflows.test.ts tests/conventions.test.ts`, and the push. Then read from
git, never from its word, that the commit touched nothing else:
`git diff --no-renames --name-only <head before> <learn's head>` must print only `.claude/rules/` paths; anything
else, or a diff that could not be read, is a stop (step 8). Note its end in the log.

## 7. CI, until green

Run `node <repo>/scripts/board.ts status <sub-issue> "CI / queued"` and the `CI_WAIT` loop in the background at the
last head. Green: step 8. Red: read the failing jobs' logs and SendMessage the failure to the implementer, as a
failure with the handoff, as in step 5 (`Fixing` on the board); then a narrow re-check of its push, and CI again. At
most 3 CI fixes; still red, stop.

## 8. Finish: file, record, merge

- **File** what was not this PR's to fix, once per class: the base's findings and this PR's deferred ones, kept apart.
  Start a `model: "sonnet"` agent with pr-loop.js's File prompt (in `finish`): one issue per class, each first looked
  for and commented on when one already names the class, each beginning `### From Claude (Sonnet 5.5)`.
- **Record.** Post ONE comment on the PR headed `## Review record`, signed with your own model, whose status line is
  pr-loop's for the same exit (`reviewed, no open blocking finding of this PR, CI green: ready for the merge decision`;
  `unreviewed: …`; `still N finding(s) after 4 rounds: the coordinator decides`; …). Its text says it came from
  pr-persistent, the race log's totals (wall time per step, Learn's own time, each agent's tokens) and each round's
  findings; then the SAME `json mason-review-record` block pr-loop's `recordOf` writes, read by
  `scripts/review-stats.ts`: `designRounds` and `probeRounds` are 0, `reviewRounds` counts the rounds that showed
  their evidence, `findings` are this PR's blocking ones (`stage: "review"`, with round, class and severity),
  `deferred` its non-blocking ones, and the statement and check counts are the reviews' own. For example:

```json mason-review-record
{"pr":176,"designRounds":0,"probeRounds":0,"reviewRounds":2,"findings":[{"round":1,"stage":"review","classKey":"set-op-arm-type","severity":"wrong-answer"}],"deferred":[{"round":1,"stage":"review","classKey":"refusal-wording","severity":"message"}],"ciFixes":0,"status":"reviewed, no open blocking finding of this PR, CI green: ready for the merge decision","statementsRun":420,"statementsMatched":420,"checksRun":3}
```

- **Merge** per CLAUDE.md "Who merges what": read the diff in full; a PR that changes `src/` waits for the owner's
  word (`Needs Tom` on the board); when it may merge, queue it pinned,
  `gh pr merge <n> --auto --merge --match-head-commit <sha>`, and leave a bounded background job on
  `gh pr view <n> --json state`. Confirm it merged, then move the card to `Done`.
- **End the implementer** once the PR is merged or stopped: tell it it is done (or stop it), and make sure nothing
  of its worktree is unpushed.
