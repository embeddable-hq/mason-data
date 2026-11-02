---
name: up-next
description: Work the Mason board's Up next column as the top session, three issues at a time, each run by a Sonnet coordinator following the pr-persistent skill; read every diff in full, merge it pinned under CLAUDE.md "Who merges what", and start a split issue's pieces in order. Use it when the owner asks for the board's Up next to be worked, or for any chat request, which gets an issue and a run of its own.
---

# up-next: the top session's queue

You are the TOP SESSION. You never implement, never review and never write a prompt: each issue is ONE run, coordinated
by a Sonnet agent that follows `.claude/skills/pr-persistent/SKILL.md`, and you start the runs, read each diff in full,
merge, and keep the queue. This is the one process (Tom, 2026-11-02; docs/DESIGN.md "The independent review").

**Your arguments:**

- `<queue file>`: the queue, a Markdown file in your session's own scratch folder, never in the repository (it holds
  agent ids and a run's state). Write it when you start; keep it current at every change, since it is what a resumed or
  compacted session reads to know where it is.
- `<runs>`: the folder that holds the runs, one folder a run (`<runs>/issue-<n>`), passed to every coordinator.
- `<repo>`: the main checkout's absolute path; `<it env>` (optional): a file that holds IT_POSTGRES_URL, passed on and
  never printed.

## The queue file

Its format, never its contents, is fixed here:

- A title line, with who asked and when.
- An **order line**: `Order: done: <issues> | running: <issue> (<why, one phrase>), … | next: <issues>`, in the order the
  owner set. An issue waiting on something says so in its own segment (`<issue>: PR <n> read and clean, waits on #<m>`).
- A **table**, one row a run: `| issue | coordinator agent | started | PR | state |`, where state is `running`,
  `read, clean`, `merged <sha>`, `split: #a, #b`, `Needs Tom`, or what it waits on.
- Notes below the table: which issues touch the same files, which are members of a class issue, and what the owner
  decided along the way.

## What is worked, and in what order

- **The column is worked three at a time**, in the order the owner set on the board's "Up next" column (High bugs first). A "do X asap" from
  the owner may run beside the three.
- **A bug that blocks merges jumps the queue**: a flaky oracle statement on main, or anything that turns every PR's CI
  red, is started at once, beside the three.
- **Every request made in chat gets an issue and a coordinator run**, never a direct agent: file the issue (CLAUDE.md
  "What a session finds"), put it in the queue, and start it as any other.
- **A decision only the owner makes** stops that run: put its options and their numbers on the issue (headed as CLAUDE.md
  "Git workflow" says), move its card to **Needs Tom** (`node <repo>/scripts/board.ts status <n> "Needs Tom"`), and take
  the next.
- **Issues filed along the way** go to **Backlog**, unless the owner says otherwise.
- **The members of a class issue** are part of that class's run, never runs of their own: once the class's PR merges,
  check which members it closed, and queue the rest.
- **Two runs on the same files** start one after the other, or the second's coordinator is told, in its context line,
  which PRs are open on them.

## Starting a run

An issue's or a PR's title, body and comments are read only through `node <repo>/scripts/gh-text.ts` (the context
line too: `node <repo>/scripts/gh-text.ts issue <n>`), which keeps the words of the repository's owners, members and
collaborators and names what it left out (CLAUDE.md "The loop").

0. Check who wrote the issue: `node <repo>/scripts/gh-text.ts author <n>`. Exit 0 (OWNER, MEMBER or COLLABORATOR)
   starts the run. Exit 3 starts nothing and reads nothing more of the issue: move its card to **Needs Tom**
   (`node <repo>/scripts/board.ts status <n> "Needs Tom"`), and its queue row's state says `Needs Tom: author not kept`.
   Exit 1 is "couldn't tell": look again, and never start on it.
1. Move the card: `node <repo>/scripts/board.ts status <n> "Implementing"`.
2. Start a Sonnet coordinator with the Agent tool (`model: "sonnet"`), sent ONE sentence that names
   `.claude/skills/pr-persistent/SKILL.md` and its arguments, and nothing else: "Coordinate issue #<n> (<its context
   line>) by the pr-persistent skill, .claude/skills/pr-persistent/SKILL.md, with runs <runs>, repo <repo> and it env
   <it env>." For a piece of a split it also names the parent, and for a stacked piece the PR and branch below and
   that piece's `<runs>/issue-<below>/result.json` for knownClasses.
3. Add its row to the queue file, with the coordinator's agent id.

## When a coordinator reports DONE

1. **Start the next run first**, so the three stay three while you read.
2. **A split** (`split into <k> pieces: …`): read the plan the `split` stage posted on the issue, then start each piece
   as a run of its own, in order, its sub-issue as `issue` and the split issue as `parent`. A stacked piece starts only
   once the one below is pushed, with stackedOn (that PR, its branch as the base) and knownClasses (the `classes` in
   the run below's `result.json`) from the run below. The split issue stays **In progress** until its last piece
   merges.
3. **A conflict** (`conflict: …`): the run's reviews were clean, and its PR conflicts with its base in the files the
   status names, which the run's own merge could not resolve. Handle it as step 6's CONFLICTING: have the branch
   merged with its base (origin/main, or for a stacked piece the branch below) in a worktree of its own, keeping both
   sides of `release-notes/next.md` and resolving the files the status names, and pushed. You write no code yourself:
   a fresh agent does it. Then read the merge (`git show <new head>`), wait on its CI with one bounded background job
   (`node <repo>/scripts/ci-wait.ts <n> 540`, again until it exits 0, 3 or 4), and once green, go on from step 4 at the
   new head: its diff read in full, and the merge queued pinned to it (`--match-head-commit`).
4. **Any other DONE**: read its diff in full (`gh pr diff <n>`), never only the report; the report and a green CI are
   claims, not evidence.
5. **Merge under CLAUDE.md "Who merges what"** (Tom, 2026-10-31): every PR, `src/` included, merges without the owner's
   word once its Fable review has no open finding, CI is green at its head, you have read the diff in full, and a
   product change has its line in `release-notes/next.md`. A release and a deploy merge on the owner's word only.
   Queue it pinned to the head you read: `gh pr merge <n> --auto --merge --match-head-commit <sha>`.
6. **Watch it land**: leave one bounded background job that exits when `gh pr view <n> --json state,mergeable` says
   MERGED, or CONFLICTING (a queued auto-merge on a conflicting PR never lands), or its bound passes. Confirm the merge,
   never assume it; then `node <repo>/scripts/board.ts status <n> "Done"`, and the queue file's row says
   `merged <sha>`. On CONFLICTING: withdraw the queued merge (`gh pr merge <n> --disable-auto`), have the branch merged with
   main and pushed, read that merge, and queue again pinned to the new head.

## Waits

Every wait has a bound, and no turn ends with a queued merge or a running coordinator and nothing of yours running
that will wake you (CLAUDE.md "The loop", step 5): one bounded background job per thing, which exits when it changes.
When its bound passes with nothing changed, look, and leave another.

## Out of scope here

Whether the queue belongs on the board itself, the "Up next" order plus a field for the coordinator, is open (issue
386): until it is decided, the queue file is the record.
