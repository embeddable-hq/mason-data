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
are all `pr-loop-slim.js`'s. The render command below REPLAYS that script, as `tests/workflows.test.ts` loads it,
against the results you have recorded. It writes out the whole prompt of each stage the script would start next. The
review's text (`EVIDENCE`, `VARIANT_FORMS`, `SEVERITY_RULE`, the `FINDINGS` schema) and the record's
`json mason-review-record` block therefore come from the same code as in the other arm. You paste a rendered prompt
unchanged and add nothing to it, so the two arms differ only in who receives each prompt.

## 1. Set up the run

Make a run folder in your scratchpad. In it, write `args.json` with pr-loop-slim's args for the sub-issue:

- `issue`, `parent`, `title`, `base`, `branch`, `stackedOn` and `context`;
- `knownClasses` carried from the stack, and `itEnv` if you have one;
- `repo`: the main checkout's absolute path;
- `process: "pr-persistent"`, so that the Review record says which arm wrote it;
- `brief`: in the race, the ONE brief both arms share, in pr-loop's BRIEF shape (`{ brief, shapes, tests }`). Write it
  yourself as CLAUDE.md "The loop" step 1 says, and give the other arm the same object.

Then write `answers.json` holding `{}`, and PIN the script: copy `<repo>/.claude/workflows/pr-loop-slim.js` into the
run folder, as `pr-loop-slim.js`, at the same commit the other arm starts from. Note that commit in the race log
(`git -C <repo> rev-parse HEAD`). The render reads only that copy, as the Workflow tool loads its script once, so a
main that moves during the race cannot change a later stage's prompt or labels.

Keep a race log there too. For each stage, note its wall-clock start and end (`date -u +%FT%TZ`) and the tokens and
tool uses that the agent's completion notification reports. Each SendMessage round to the implementer is a row of its
own, and so is Learn.

## 2. The loop: render, dispatch, record

```sh
# render-stage: replays $RUN/pr-loop-slim.js (the pinned copy) against $RUN/answers.json, and writes the prompt of
# each stage it starts next. Export RUN (the run folder) first.
node --input-type=module <<'EOF'
import fs from "node:fs";
const { RUN } = process.env;
if (!RUN) throw new Error("export RUN (the run folder) first");
const read = (f) => JSON.parse(fs.readFileSync(`${RUN}/${f}`, "utf8"));
const args = read("args.json"), answers = read("answers.json");
const src = fs.readFileSync(`${RUN}/pr-loop-slim.js`, "utf8");
if (!/^export const meta = /.test(src)) throw new Error("pr-loop-slim.js no longer begins with `export const meta`: fix this command");
const run = new (Object.getPrototypeOf(async () => {}).constructor)("args", "agent", "phase", "log", "workflow", "parallel", src.replace(/^export const meta/, "const meta"));
// An answer is read as the Workflow tool reads an agent's result: one that fails the schema its agent() call carries
// is null, the result of an agent that failed. Why it failed is the first thing printed.
const problem = (v, s, at) => {
  if (s.enum && !s.enum.includes(v)) return `${at} is ${JSON.stringify(v)}, not one of ${s.enum.join(", ")}`;
  const min = (x) => (s.minimum !== undefined && x < s.minimum ? `${at} is below ${s.minimum}` : null);
  switch (s.type) {
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${at} is not an object`;
      const gone = (s.required ?? []).find((k) => !Object.hasOwn(v, k));
      if (gone) return `${at}.${gone} is missing`;
      for (const [k, p] of Object.entries(s.properties ?? {})) { const w = Object.hasOwn(v, k) ? problem(v[k], p, `${at}.${k}`) : null; if (w) return w; }
      return null;
    }
    case "array": {
      if (!Array.isArray(v)) return `${at} is not an array`;
      for (const [i, x] of v.entries()) { const w = s.items ? problem(x, s.items, `${at}[${i}]`) : null; if (w) return w; }
      return null;
    }
    case "string": return typeof v === "string" ? null : `${at} is not a string`;
    case "number": return typeof v === "number" && Number.isFinite(v) ? min(v) : `${at} is not a number`;
    case "integer": return Number.isInteger(v) ? min(v) : `${at} is not an integer`;
    case "boolean": return typeof v === "boolean" ? null : `${at} is not a boolean`;
    default: return null;
  }
};
const STOP = Symbol("stop"), next = [];
const agent = async (prompt, opts) => {
  if (Object.hasOwn(answers, opts.label)) {
    const a = answers[opts.label];
    const why = a === null || !opts.schema ? null : problem(a, opts.schema, "answer");
    if (why) console.log(`NULL ${JSON.stringify(opts.label)}: ${why}; read as null, an agent that failed, as the Workflow tool would`);
    return why ? null : a;
  }
  next.push({ prompt, opts });
  throw STOP;
};
const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
const name = (label) => label.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "");
fs.rmSync(`${RUN}/next`, { recursive: true, force: true });
fs.mkdirSync(`${RUN}/next`);
try {
  const result = await run(args, agent, () => {}, () => {}, () => { throw new Error("pr-loop-slim calls no workflow"); }, parallel);
  fs.writeFileSync(`${RUN}/result.json`, JSON.stringify(result, null, 2));
  console.log(`DONE: ${result.status}`);
} catch (e) {
  if (e !== STOP) throw e;
  for (const { prompt, opts } of next) {
    const { label, phase, schema, ...on } = opts;
    fs.writeFileSync(`${RUN}/next/${name(label)}.md`, `${prompt}\n\nEnd your report with ONE fenced json block holding your result, which must match this JSON schema (the Workflow tool enforces it on pr-loop-slim's agents): ${JSON.stringify(schema)}`);
    console.log(`STAGE ${JSON.stringify(label)} (${phase}) ${JSON.stringify(on)}: ${RUN}/next/${name(label)}.md`);
  }
}
EOF
```

Export RUN, then run the render. It prints `DONE: <status>` when the run is over, or one `STAGE` line for each stage
the script starts next. Before those, it prints a `NULL` line for each recorded answer that fails its stage's schema:
that answer was read as `null`, a failed agent, exactly as the Workflow tool reads it. A review and the CI read beside it come as two stages together. Each `STAGE` line gives the stage's label, its
options and the file that holds its whole prompt. Dispatch each stage as its label says, with that file's content as
the message, unchanged:

- **`implement`**: start ONE implementer with the Agent tool and the printed options (`model: "opus"`,
  `effort: "high"`, `isolation: "worktree"`; the tool's `effort` is set because this skill asks for it). Keep its
  agent ID: this agent is the PR's author until the end.
- **`fix r<n>`, `fix r<n> (class)` and `CI fix <n>`**: send the prompt to THE SAME implementer with SendMessage, never
  to a new agent. Tell it once, in the first such message, that it keeps its worktree and its context between
  rounds. That sentence is the only thing you add, and it is what this arm measures.
- **Every other stage** (`review r<n>`, `CI read r<n>`, `link`, `learn`, `learn check`, `CI <n>`, `file`, `record`):
  a FRESH agent with the Agent tool, with the printed options. A review is `model: "fable"`, `effort: "medium"`.

When an agent reports, take the fenced json block at the end of its report. Add it to `answers.json` under the
stage's label exactly as printed, or `null` when the agent failed or gave no block. Then render again. Never judge
whether a block is valid by eye: the render checks each answer against the schema its stage carries. A review's block is its `FINDINGS`; the implementer's and a fixer's carry the handoff, which
the next fix prompt pastes verbatim. Record each answer as the agent gave it, and never edit one. The script itself
decides what happens next from those answers: a class round, a deferral, the 4-round bound, the `unreviewed` stop,
CI, Learn, filing and the record.

Nothing waits unwatched: every agent you start notifies you when it reports, and each CI stage is an agent with its
own bounded wait.

## 3. When the render says DONE

- Post the race log as ONE comment on the PR, headed `### From Claude (<your model>)` and `## Race log`. Give each
  stage's wall time, Learn's own time on its own row, and each agent's tokens. The Review record is the `record`
  stage's comment, as rendered, so do not add the log to it.
- **Merge** under CLAUDE.md "Who merges what". Read the diff in full. A PR that changes `src/` waits for the owner's
  word (`Needs Tom` on the board). When the PR may merge, queue it pinned,
  `gh pr merge <n> --auto --merge --match-head-commit <sha>`, and leave a bounded background job on
  `gh pr view <n> --json state`. Confirm that it merged, then move the card with
  `node <repo>/scripts/board.ts status <sub-issue> "Done"`.
- **End the implementer** once the PR is merged or stopped: tell it it is done, and check that nothing in its worktree
  is unpushed.
