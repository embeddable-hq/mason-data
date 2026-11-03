---
name: pr-persistent
description: Coordinate ONE issue of embeddable-hq/mason-data, or one piece of a split issue, through CLAUDE.md "The loop" with ONE Opus implementer kept alive across every fix round by SendMessage. Every prompt is rendered from .claude/workflows/pr-loop-slim.js, so the coordinator writes no prompt, and it never merges. Use it as the Sonnet coordinator the up-next skill starts, one per issue.
---

# pr-persistent: one issue, one implementer kept alive

You are the COORDINATOR of one issue (or one piece of a split), started by the top session with one sentence that names
this skill and its arguments. You work with the Agent and SendMessage tools. You never write a prompt, never write
code, and never merge: Opus writes the brief and the code, Opus reviews in a fresh agent, and the top session reads
the diff and merges (`.claude/skills/up-next/SKILL.md`). This is the one process (Tom, 2026-11-02; docs/DESIGN.md "The independent review").

**Your arguments**, as the message that started you gives them:

- `issue`: the issue's number, `<n>`; and its **context line**, a sentence on what it is.
- `<runs>`: the folder that holds the runs, one folder a run: yours is `<runs>/issue-<n>`, the **run folder**.
- `<repo>`: the main checkout's absolute path.
- `<it env>` (optional): a file that holds IT_POSTGRES_URL, for the statements the review and the author run. Never
  print it, its contents, or the URL.
- For a **piece of a split** only: `parent` (the split issue), `stackedOn` (the PR of the piece below, when this piece
  is stacked on it) with that piece's branch as the base, and `knownClasses` (the `classes` of the run below, read from
  its `result.json`), so a class met on the PR below counts on this one too (CLAUDE.md "The loop").

**Why one implementer.** On issue 192, ONE persistent Opus agent that was sent the review's findings by message took
1 h 51 min. The pr-loop harness took 5.5 h and did not finish, on about 2.3 times the Opus output tokens. The
difference was continuity: a fix round rebuilt no context. A Workflow `agent()` is one-shot, so a script cannot send a
second round to the agent that wrote the code. A coordinator holding that agent can, and this skill is that coordinator.

**The one rule: never write a prompt yourself.** Every stage's prompt, its model, effort and isolation, the order of
the stages, the split verdict, the class rule, the severity rule, the round bounds, the `unreviewed` stop, filing and
the Review record are all `pr-loop-slim.js`'s. The render below REPLAYS that script, as `tests/workflows.test.ts` loads
it, against the results recorded so far, and writes out the whole prompt of each stage the script would start next. The
review's text (`EVIDENCE`, `VARIANT_FORMS`, `SEVERITY_RULE`, the `FINDINGS` schema) and the record's
`json mason-review-record` block therefore come from the one script. Each agent reads its rendered prompt from the file
unchanged, and you add nothing to it.

**Content goes between agents by path; you read only control lines** (issue 304). Prompts and results stay on disk:
you never read a prompt file or a result file, and never paste either into a message. A coordinator that carried them
spent a third of the implementer's output tokens doing it.

## 1. Set up the run

Make the run folder, `<runs>/issue-<n>`. In it, write `args.json`, pr-loop-slim's args:

- `issue`: n; `parent`: the same n, or for a piece the split issue; `title`: the issue's title, the first line
  `node <repo>/scripts/gh-text.ts issue <n>` prints (when it says the title and body are by someone else, start
  nothing: tell the top session, whose up-next skill moves the card to Needs Tom);
- `base`: `"main"`, or for a stacked piece the branch of the piece below; `branch`: `"upnext-<n>"`, or for a piece the
  branch its plan names; `stackedOn`: `null`, or for a stacked piece the PR below, as a string;
- `repo`: `<repo>`; `itEnv`: `<it env>` when given, else leave it out;
- `process: "pr-persistent"`, so the Review record says which process wrote it;
- `knownClasses`: `{}`, or for a piece the run below's `classes`;
- `context`: the context line, then: "This issue is not split yet: its one PR closes it (`Closes #<n>`), unless the
  brief finds it too big for one PR. Read the issue and all its comments first (`node <repo>/scripts/gh-text.ts issue <n>`). Build
  only what its 'Done looks like' asks; anything else found goes to a new issue, as CLAUDE.md 'What a session finds'
  says. A real database's data never appears: synthetic only. No user-visible text names the engine." For a piece, its
  first sentence is instead: "This is a piece of #<parent>'s split, whose plan is on #<parent>: its one PR closes
  #<n>."
- NO `brief`: the Brief stage runs on Opus, and its verdict may be a split.

Then write `answers.json` holding `{}`, make `results/` (each agent writes its result there), and PIN the script and
its render: copy `.claude/workflows/pr-loop-slim.js` and `.claude/skills/pr-persistent/render.mjs` into the run folder,
both from the one commit the run starts from, and note that commit in the run log. Each line is one plain command, run
from your working directory (a checkout of this repository or a worktree of it, which share one object store); `<sha>`
is what the second printed and `<run folder>` the folder's absolute path, both written out. Never pull into the main
checkout: other runs share it, and these read git's objects only (issue 322: a command substitution, a shell variable
or git's -C is what Claude Code's worktree guard refuses in an isolated agent):

```sh
git fetch origin <base>
git rev-parse origin/<base>
git show <sha>:.claude/workflows/pr-loop-slim.js > <run folder>/pr-loop-slim.js
git show <sha>:.claude/skills/pr-persistent/render.mjs > <run folder>/render.mjs
mkdir -p <run folder>/results
```

The render reads only those copies, as the Workflow tool loads its script once, so a main that moves during the run
cannot change a later stage's prompt or labels.

Keep a run log there too, `run-log.md`: the commit, the start time, and for each stage its wall-clock start and end
(`date -u +%FT%TZ`) and the tokens and tool uses that the agent's completion notification reports. Each SendMessage
round to the implementer is a row of its own, and so is Learn. The last row is your own: the coordinator's output
tokens, cache writes and cache reads, as your session's usage reports them at the end. A coordinator that carried every
prompt and result through its context spent 49 k output, 0.70 M cache writes and 7.7 M cache reads (issue 304), and
this row is measured against those numbers.

## 2. The loop: render, dispatch, record

```sh
# render-stage: replays the pinned pr-loop-slim.js against answers.json, both beside it in the run folder, and writes
# each next stage's prompt to next/. It prints only STAGE, NULL and DONE lines. <run folder> is written out.
node <run folder>/render.mjs
```

It prints `DONE: <status>` when the run is over, or one `STAGE` line for each stage the script starts next. Before
those, it prints a `NULL` line for each recorded answer read as `null`, a failed agent, exactly as the Workflow tool
reads it: its result file is missing, is not JSON, or fails its stage's schema. A review and the CI read beside it come
as two stages together. Each `STAGE` line gives the stage's label, its options and the file that holds its whole
prompt. A render that exits non-zero prints one line saying what is wrong and what to do: do that, and render again.

Dispatch each stage as its label says. The message is this one sentence, with the path from its `STAGE` line, and
nothing else: `Your instructions are in <path>: read the whole file, then follow it.`

- **`implement`**: start ONE implementer with the Agent tool and the printed options (`model: "opus"`,
  `effort: "high"`, `isolation: "worktree"`; the tool's `effort` is set because this skill asks for it). Keep its
  agent ID: this agent is the PR's author until the end.
- **`fix r<n>`, `fix r<n> (class)` and `CI fix <n>`**: send the sentence to THE SAME implementer with SendMessage, never
  to a new agent. Tell it once, in the first such message, that it keeps its worktree and its context between
  rounds. That sentence is the only thing you add.
- **Every other stage** (`brief`, `split`, `review r<n>`, `CI read r<n>`, `link`, `learn`, `learn check`, `CI <n>`,
  `merge <k>`, `file`, `record`): a FRESH agent with the Agent tool, with the printed options. A review is
  `model: "opus"`, `effort: "high"`, a FRESH agent every round, never the implementer and never by SendMessage
  (CLAUDE.md "The loop" step 3). A `merge <k>` merges the BASE into the PR's branch, never the PR: it is never the
  implementer's, but a fresh agent in a worktree of its own (`isolation: "worktree"`), as printed.

Each rendered prompt ends by telling its agent to write its result, ONE JSON value, to `results/<name>.json` in the run
folder before it ends its turn, and to end its report with that path. That path is the `STAGE` line's, with `next/`
made `results/` and `.md` made `.json`. **The file is the result, never the agent's completion notice**: when you
resume the implementer by SendMessage, the notice of its end can go to the top-level session instead of you, so a
fix round's result would be lost while you wait on it (issue 304, PR 313). So for each stage you dispatch, leave a
bounded background job that exits when its results file exists (and is not empty) or 30 minutes pass, one plain
command with run_in_background, `node <repo>/scripts/wait-file.ts <path> 1800` (exit 0: the file is there; 8: the
bound passed); it wakes you whether or not a notice reaches you. When its bound passes with no
file, look before leaving another: a fix that pushed has moved the PR's head (`git ls-remote origin <branch>`), and an
agent that ended without writing its file failed. If the top session forwards a result to you, it is a file in the run
folder: look there before asking again. Then record under the stage's label in `answers.json`, exactly as
printed, its results path once the file exists, or `null` when the agent failed without writing it. Then render
again. Record a path, never the JSON: the render refuses any value but that label's own results path or `null`, since
another stage's file would be read as this stage's answer. Never judge whether a result is valid by eye:
the render checks each against the schema its stage carries. A review's result is its `FINDINGS`; the implementer's
and a fixer's carry the handoff, which the next fix prompt pastes verbatim. Never edit a result. The script itself
decides what happens next from those results: a split, a class round, a deferral, the 4-round bound, the `unreviewed`
stop, CI, Learn, filing and the record.

## 3. When the render says DONE

- **A split** (`DONE: split into <k> pieces: …`): the Brief found the issue too big for one PR, and the `split` stage
  made a sub-issue per piece and posted the plan on the issue. No PR was opened. Report the pieces, in order, with
  their sub-issues and which is stacked on which, as the status line gives them, and stop: the top session reads the
  plan and starts each piece as a run of its own.
- **A conflict** (`DONE: conflict: …`): the run is over, its reviews were clean, and the PR still conflicts with its
  base, in the files the status names (the run merged the base itself where it could, and this is what it could not).
  Only the top session can go on from here, so do the steps of the next bullet, then send your ONE report AT ONCE,
  saying first that the PR conflicts and naming the files from the status. Never wait on it, watch it, or leave a
  background job for it: nothing of the run moves again until the top session merges the base, and a coordinator that
  waited on a conflict instead of reporting it left a clean PR unmerged for an hour (issue 452).
- **Any other DONE**: post the run log as ONE comment on the PR, headed `### From Claude (<your model>)` and
  `## Run log`. Give each stage's wall time, Learn's own time on its own row, each agent's tokens, and your own on the
  last row. The Review record is the `record` stage's comment, as rendered, so do not add the log to it. Then tell the
  implementer it is done, and check that nothing in its worktree is unpushed (`git ls-remote origin <branch>` against
  the head it reported).
- **Never merge, nor queue a merge**: the top session reads the diff in full and merges under CLAUDE.md "Who merges
  what" (`.claude/skills/up-next/SKILL.md`). The hook `scripts/hooks/merge-head.ts` refuses a PR merge from any
  sub-agent, you and every agent you start included: report the PR and its head instead.
- **End with ONE report**: the issue, the PR and its head; the status line the render printed; the wall time; the
  tokens per model, from the run log; every issue filed during the run, by number; and anything that went wrong or was
  skipped.

## Waits

Every wait has a bound. Before you end ANY turn while waiting on something (an agent, a CI stage), leave a bounded
background job that will wake you: the wait-file job above, one per dispatched stage. Nothing waits unwatched: every
agent you dispatch has a bounded wait on its results file, never on a notice, and each CI stage is an agent with a
bounded wait of its own, so you never wait on CI yourself. A turn that ends with nothing of yours running is never
woken.

A DONE ends the run: once the render prints it, nothing of the run is waited on. No wait, watch or background job
follows a DONE; its report is your last word on the run, and whatever is left (a conflict, a merge, a decision) is the
top session's.

Test commands need BOTH `--test-timeout=<ms>` and `--test-force-exit` before the files (PR 313). If an agent's command
lacks one, the hook says what to run instead: that is expected, not a failure.

## Never

- write or edit a prompt, or a result;
- merge, or queue a merge;
- ask the owner anything: if something blocks you, stop and report what is blocked and why;
- run a heavy gate yourself (`npm run check`, the full oracle, `npm run test:integration`);
- touch another run's folder, branch or PR;
- leave a wait unbounded;
- print IT_POSTGRES_URL, the `<it env>` file, or anything from a real deployment.
