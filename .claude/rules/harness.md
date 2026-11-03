---
paths:
  - ".claude/workflows/**"
  - ".claude/skills/**"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## The harness

The loop's script (`.claude/workflows/pr-loop-slim.js`) and the skills that run it (`.claude/skills/`) are held by
`tests/workflows.test.ts`; CLAUDE.md "How work is done here" says what they run and why.

## What review probes

Run each probe that applies before a push: the harness's implement and fix prompts say so, and its review runs them
against the head.

- A prompt that tells an agent to keep a fact by hand-editing a generated file whose generator and CI check own it:
  a CI fix whose regeneration admits a piece beyond the issue (`function:9001` in the legs, `aggregate:2050` alone in
  `src/duck/verified.ts`), told to keep it refused by leaving its entry out of `src/duck/verified.ts`; run
  `scripts/oracle-legs.ts`'s `verifiedDiff` on that shape, and it reads `added: ["function:9001"]`, so
  `integration (oracle)` stays red and the next regeneration re-admits it. The authority for "refused" is what the
  generator reads (the oracle's answers and the refusals registry, `src/duck/gaps.ts`), never its output:
  `generated-artifact-as-authority` (PR 652).
- An automatic "start again at once" applied to its own output: a shrink run (`shrinkOf` given, branch
  `upnext-<n>-shrink`) that itself reaches the round bound and ends `DONE: shrink: …`; follow the skills' steps
  literally, and they start another shrink onto the same branch and run folder without the owner's word. Every
  automatic restart counts against the bound it enforces (a run started by a shrink starts none):
  `unbounded-automatic-restart` (PR 652).
