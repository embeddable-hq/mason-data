---
name: pr-persistent
description: Take ONE PR of embeddable-hq/mason-data through CLAUDE.md "The loop" with ONE persistent Opus implementer that the coordinator keeps alive and sends every fix round to by SendMessage. Every prompt is rendered from .claude/workflows/pr-loop-slim.js itself, so the only difference from that workflow is the implementer's continuity. Use it when the coordinator runs a sub-issue this way, as in the race against pr-loop-slim on issue 176.
---

# pr-persistent: pr-loop-slim's prompts, one implementer kept alive

You are the COORDINATING session, and you follow these steps with the Agent and SendMessage tools. This is one of two
experimental processes raced on issue 176 (Tom, 2026-11-01). The other is `.claude/workflows/pr-loop-slim.js` run by
the Workflow tool.

**Why.** On issue 192, ONE persistent Opus agent that was sent the review's findings by message took 1 h 51 min. The
pr-loop harness took 5.5 h and did not finish, and it spent about 2.3 times the Opus output tokens. The difference was
continuity: a fix round rebuilt no context. A Workflow `agent()` is one-shot, so a script cannot send a second round
to the agent that wrote the code. A coordinator holding that agent can, and this skill is that coordinator.

**The one rule: never write a prompt yourself.** Every stage's prompt, its model, effort and isolation, the order of
the stages, the class rule, the severity rule, the round bounds, the `unreviewed` stop, filing and the Review record
are all `pr-loop-slim.js`'s. The render below REPLAYS that script, as `tests/workflows.test.ts` loads it, against the
results recorded so far. It writes out the whole prompt of each stage the script would start next. The review's text
(`EVIDENCE`, `VARIANT_FORMS`, `SEVERITY_RULE`, the `FINDINGS` schema) and the record's `json mason-review-record`
block therefore come from the same code as in the other arm. Each agent reads its rendered prompt from the file
unchanged, and you add nothing to it, so the two arms differ only in who receives each prompt.

**Content goes between agents by path; you read only control lines** (issue 304). Prompts and results stay on disk:
you never read a prompt file or a result file, and never paste either into a message. A coordinator that carried them
spent a third of the implementer's output tokens doing it.

## 1. Set up the run

Make a run folder in your scratchpad. In it, write `args.json` with pr-loop-slim's args for the sub-issue:

- `issue`, `parent`, `title`, `base`, `branch`, `stackedOn` and `context`;
- `knownClasses` carried from the stack, and `itEnv` if you have one;
- `repo`: the main checkout's absolute path;
- `process: "pr-persistent"`, so that the Review record says which arm wrote it;
- `brief`: in the race, the ONE brief both arms share, in pr-loop's BRIEF shape (`{ brief, shapes, tests }`). Write it
  yourself as CLAUDE.md "The loop" step 1 says, and give the other arm the same object.

Then write `answers.json` holding `{}`, make `results/` (each agent writes its result there), and PIN the script and
its render: copy `.claude/workflows/pr-loop-slim.js` and `.claude/skills/pr-persistent/render.mjs` into the run folder,
both from the commit the other arm starts from, and note that commit in the race log:

```sh
SHA=$(git -C <repo> rev-parse HEAD)
git -C <repo> show "$SHA:.claude/workflows/pr-loop-slim.js" > "$RUN/pr-loop-slim.js"
git -C <repo> show "$SHA:.claude/skills/pr-persistent/render.mjs" > "$RUN/render.mjs"
mkdir -p "$RUN/results"
```

The render reads only those copies, as the Workflow tool loads its script once, so a main that moves during the race
cannot change a later stage's prompt or labels.

Keep a race log there too. For each stage, note its wall-clock start and end (`date -u +%FT%TZ`) and the tokens and
tool uses that the agent's completion notification reports. Each SendMessage round to the implementer is a row of its
own, and so is Learn. The last row is your own: the coordinator's output tokens, cache writes and cache reads, as your
session's usage reports them at the end. A coordinator that carried every prompt and result through its context spent
49 k output, 0.70 M cache writes and 7.7 M cache reads (issue 304), and this row is measured against those numbers.

## 2. The loop: render, dispatch, record

```sh
# render-stage: replays the pinned pr-loop-slim.js against answers.json, both beside it in the run folder, and writes
# each next stage's prompt to next/. It prints only STAGE, NULL and DONE lines.
node "$RUN/render.mjs"
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
  rounds. That sentence is the only thing you add, and it is what this arm measures.
- **Every other stage** (`review r<n>`, `CI read r<n>`, `link`, `learn`, `learn check`, `CI <n>`, `file`, `record`):
  a FRESH agent with the Agent tool, with the printed options. A review is `model: "fable"`, `effort: "medium"`.

Each rendered prompt ends by telling its agent to write its result, ONE JSON value, to `results/<name>.json` in the run
folder before it ends its turn, and to end its report with that path. That path is the `STAGE` line's, with `next/`
made `results/` and `.md` made `.json`. **The file is the result, never the agent's completion notice**: when you
resume the implementer by SendMessage, the notice of its end can go to the top-level session instead of you, so a
fix round's result would be lost while you wait on it (issue 304, PR 313). So for each stage you dispatch, leave a
bounded background job that exits when its results file exists or 30 minutes pass
(`for i in $(seq 120); do [ -s <path> ] && break; sleep 15; done`); it wakes you whether or not a notice reaches you. When its bound passes with no
file, look before leaving another: a fix that pushed has moved the PR's head (`git ls-remote origin <branch>`), and an
agent that ended without writing its file failed. Then record under the stage's label in `answers.json`, exactly as
printed, its results path once the file exists, or `null` when the agent failed without writing it. Then render
again. Record a path, never the JSON: the render refuses any value but that label's own results path or `null`, since
another stage's file would be read as this stage's answer. Never judge whether a result is valid by eye:
the render checks each against the schema its stage carries. A review's result is its `FINDINGS`; the implementer's
and a fixer's carry the handoff, which the next fix prompt pastes verbatim. Never edit a result. The script itself
decides what happens next from those results: a class round, a deferral, the 4-round bound, the `unreviewed` stop,
CI, Learn, filing and the record.

Nothing waits unwatched: every agent you dispatch has a bounded wait on its results file, never on a notice, and each
CI stage is an agent with its own bounded wait.

## 3. When the render says DONE

- Post the race log as ONE comment on the PR, headed `### From Claude (<your model>)` and `## Race log`. Give each
  stage's wall time, Learn's own time on its own row, each agent's tokens, and your own on the last row. The Review
  record is the `record` stage's comment, as rendered, so do not add the log to it.
- **Merge** under CLAUDE.md "Who merges what". Read the diff in full. A PR that changes `src/` waits for the owner's
  word (`Needs Tom` on the board). When the PR may merge, queue it pinned,
  `gh pr merge <n> --auto --merge --match-head-commit <sha>`, and leave a bounded background job on
  `gh pr view <n> --json state,mergeable`, which exits on CONFLICTING too, since a queued auto-merge on a conflicting PR
  never lands. Confirm that it merged, then move the card with
  `node <repo>/scripts/board.ts status <sub-issue> "Done"`.
- **End the implementer** once the PR is merged or stopped: tell it it is done, and check that nothing in its worktree
  is unpushed.
