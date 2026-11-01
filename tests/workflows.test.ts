import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";

// The coordinator's Workflow scripts, .claude/workflows/pr-loop.js and issue-loop.js, run CLAUDE.md "The loop" with
// agents. Nothing else reads them before a run, and a run costs hours, so this is their detector: each is loaded as the
// Workflow harness loads it (the leading `export const meta` made a `const`, the body an async function of args, agent,
// phase, log and workflow), and run against stub agents keyed on their label.

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const file = (name: string): string => path.join(ROOT, ".claude", "workflows", `${name}.js`);
const source = (name: string): string => fs.readFileSync(file(name), "utf8");

type Opts = { label: string; phase?: string; model?: string; effort?: string; isolation?: string; schema?: unknown };
type Call = { prompt: string; opts: Opts };
type Run = (args: unknown, agent: unknown, phase: unknown, log: unknown, workflow: unknown) => Promise<unknown>;
type Meta = { name: string; description: string; phases: Array<{ title: string }> };
type Answers = Record<string, unknown>;
type Result = Record<string, unknown>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...params: string[]) => Run;

function load(name: string): Run {
  const src = source(name);
  assert.match(src, /^export const meta = /, `${name}: the script begins with \`export const meta\``);
  return new AsyncFunction("args", "agent", "phase", "log", "workflow", src.replace(/^export const meta/, "const meta"));
}

/** `meta`'s initializer, held to a pure literal (no identifier, call or substitution), then evaluated. */
function meta(name: string): Meta {
  const src = source(name);
  const sf = ts.createSourceFile(`${name}.js`, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stmt = sf.statements[0];
  assert.ok(stmt && ts.isVariableStatement(stmt), `${name}: the first statement is \`export const meta\``);
  const init = stmt.declarationList.declarations[0]?.initializer;
  assert.ok(init, `${name}: meta has an initializer`);
  const impure: string[] = [];
  const visit = (n: ts.Node): void => {
    const pure = ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || ts.isPropertyAssignment(n)
      || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)
      || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword
      || (ts.isIdentifier(n) && ts.isPropertyAssignment(n.parent) && n.parent.name === n);
    if (!pure) impure.push(`${ts.SyntaxKind[n.kind]}: ${n.getText(sf).slice(0, 40)}`);
    else ts.forEachChild(n, visit);
  };
  visit(init);
  assert.deepEqual(impure, [], `${name}: meta is a pure literal`);
  const m = new Function(`return (${init.getText(sf)})`)() as Meta;
  assert.equal(m.name, name);
  assert.ok(typeof m.description === "string" && m.description.length > 0, `${name}: meta has a description`);
  return m;
}

/** The name each model signs a posting with: each script's SIGNS is held to it. */
const SIGNS: Record<string, string> = { opus: "Opus 5.5", fable: "Fable", sonnet: "Sonnet" };
/** A script's SIGNS. */
function signs(name: string): Record<string, string> {
  const m = /^const SIGNS = (\{[^\n]*\})$/m.exec(source(name));
  assert.ok(m, `${name}: SIGNS is declared on one line`);
  return new Function(`return (${m[1]})`)() as Record<string, string>;
}

/** Every signature a prompt asks for: a heading, a co-author line, a sub-issue's --from. */
const signatures = (prompt: string): string[] =>
  [...prompt.matchAll(/### From Claude \(([^)]*)\)|Co-Authored-By: Claude ([^<`]*?) <|--from "([^"]*)"/g)].map((m) => (m[1] ?? m[2] ?? m[3])!);

/** A run of a script with stub agents: `answers[label]` is a value or a function of the call. */
async function run(name: string, args: Record<string, unknown>, answers: Answers,
  flows: Array<(spec: unknown, a: Record<string, unknown>) => unknown> = []) {
  const calls: Call[] = [];
  const phases: string[] = [];
  const flowCalls: Array<{ spec: unknown; args: Record<string, unknown> }> = [];
  const agent = async (prompt: string, opts: Opts) => {
    calls.push({ prompt, opts });
    assert.ok(opts.label in answers, `${name}: no stub answer for the agent labelled "${opts.label}"`);
    const a = answers[opts.label];
    return typeof a === "function" ? (a as (c: Call) => unknown)({ prompt, opts }) : a;
  };
  const workflow = async (spec: unknown, a: Record<string, unknown>) => {
    flowCalls.push({ spec, args: a });
    const f = flows[flowCalls.length - 1];
    assert.ok(f, `${name}: no stub for workflow call ${flowCalls.length}`);
    return f(spec, a);
  };
  const result = await load(name)(args, agent, (t: string) => { phases.push(t); }, () => {}, workflow) as Result;
  // every phase a run names, by phase() or on an agent, is one meta declares
  const titles = meta(name).phases.map((p) => p.title);
  for (const t of [...phases, ...calls.map((c) => c.opts.phase)]) assert.ok(t && titles.includes(t), `${name}: phase "${t}" is not in meta.phases (${titles.join(", ")})`);
  for (const c of calls) {
    assert.doesNotMatch(c.prompt, /undefined|\[object Object\]/, `${name}: the prompt of "${c.opts.label}" says undefined`);
    // a posting is signed with the model the agent runs on, never another's
    for (const s of signatures(c.prompt)) assert.equal(s, SIGNS[c.opts.model!], `${name}: "${c.opts.label}" runs on ${c.opts.model} but is told to sign "${s}"`);
  }
  const label = (l: string) => calls.find((c) => c.opts.label === l);
  return { result, calls, flowCalls, phases, labels: calls.map((c) => c.opts.label), prompt: (l: string) => label(l)!.prompt };
}

const sha = (c: string) => c.repeat(40);
const finding = (o: Partial<Record<string, string>>) => ({
  input: "SELECT 1", expected: "1", actual: "2", atBase: "1", origin: "this-pr", classKey: "some-class", classWhy: "why", where: "plan.ts:1", ...o,
});
const clean = { findings: [], judgedCorrect: [] };
const PR = { issue: 301, parent: 300, title: "300 · a piece", base: "main", branch: "issue-300-a-piece", stackedOn: "", context: "the scope" };
const START: Answers = {
  brief: { brief: "build it", shapes: ["SELECT a FROM t"], tests: ["tests/workflows.test.ts"] },
  implement: { pr: 900, head: sha("a"), summary: "done" },
};
const pushed = (c: string) => ({ pr: 900, head: sha(c), summary: "fixed" });
const RESULT_KEYS = ["classes", "filed", "fromBase", "head", "pr", "rounds", "status"];
const shapeOf = (r: Result) => Object.keys(r).sort();

test("both scripts parse as the harness loads them, with a pure-literal meta naming them, and none of the calls the harness forbids", () => {
  for (const name of ["pr-loop", "issue-loop"]) {
    assert.equal(typeof load(name), "function");
    meta(name);
    const src = source(name);
    assert.doesNotMatch(src, /Date\.now\(|Math\.random\(|new Date\(\s*\)/, `${name}: Date.now(), Math.random() and new Date() are not allowed in a Workflow script`);
    // the scripts run for anyone on the team: no path of one machine, and no scratch folder beside them
    assert.doesNotMatch(src, /\/Users\/|\/home\/|~\/|[A-Z]:\\\\|scratch/, `${name}: a home path or a scratch folder is written in the script`);
  }
  // a script cannot import, so the one table of signatures is written in each, and held equal here
  for (const name of ["pr-loop", "issue-loop"]) assert.deepEqual(signs(name), SIGNS, name);
});

test("pr-loop: a finding the base has is filed once and never fixed, never counted as a class; a CI fix gets its narrow re-check", async () => {
  const base = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t", atBase: "2" });
  const mine = finding({ classKey: "new-class", input: "SELECT mine FROM t" });
  const { result, calls, labels, prompt } = await run("pr-loop", { ...PR }, {
    ...START,
    "review r1": { findings: [base, mine], judgedCorrect: ["the cast of a text"] },
    "fix r1": pushed("b"),
    // the same input, given another slug by a later round, is the same finding
    "review r2": { findings: [{ ...base, classKey: "base-class-reslugged" }], judgedCorrect: ["the fix"] },
    "CI 1": { state: "failed", detail: "tests/workflows.test.ts: a test failed" },
    "CI fix 1": { ...pushed("c"), flake: false },
    "review r3": clean,
    "CI 2": { state: "green", detail: "" },
    file: { issues: [{ classKey: "base-class", issue: 950, action: "filed" }] },
  });
  assert.deepEqual(labels, ["brief", "implement", "review r1", "fix r1", "review r2", "CI 1", "CI fix 1", "review r3", "CI 2", "file"]);

  for (const c of calls.filter((c) => /^(fix|CI fix)/.test(c.opts.label))) assert.ok(!c.prompt.includes(base.input), `"${c.opts.label}" was handed the base's finding`);
  assert.ok(prompt("fix r1").includes(mine.input));
  assert.equal(prompt("file").split(base.input).length - 1, 1, "the base's finding, met in two rounds under two slugs, is filed once");
  assert.ok(prompt("review r2").includes("the cast of a text"), "the narrow re-check is told what the first review judged correct");
  assert.ok(prompt("review r3").includes("a test failed") && prompt("review r3").includes(`diff ${sha("b")} ${sha("c")}`), "the CI fix's commit is re-checked narrowly, from the head before it");
  assert.ok(prompt("CI 1").includes("gh pr checks") && !/gh pr checks[^`]*--watch/.test(prompt("CI 1")), "the CI wait is a gh pr checks loop, never --watch");
  assert.match(prompt("CI 1"), /timeout set to 600000/, "the CI chunk's tool call is given a timeout past the chunk");

  // the board is moved at every stage CLAUDE.md "The board says…" names
  for (const [l, status] of [["implement", "Implementing"], ["review r1", "In review"], ["fix r1", "Fixing"], ["CI 1", "CI / queued"], ["CI fix 1", "Fixing"]] as const) {
    assert.ok(prompt(l).includes(`scripts/board.ts status 301 "${status}"`), `"${l}" moves the card to ${status}`);
  }
  for (const c of calls) {
    if (/^(implement|fix|CI fix)/.test(c.opts.label)) assert.equal(c.opts.isolation, "worktree", `"${c.opts.label}" writes code in a worktree of its own`);
    assert.equal(c.opts.model === "fable", c.opts.label.startsWith("review"), `"${c.opts.label}": only reviews are Fable's`);
  }
  const opts = (l: string) => calls.find((c) => c.opts.label === l)!.opts;
  for (const l of ["brief", "implement", "fix r1", "CI fix 1"]) assert.deepEqual([opts(l).model, opts(l).effort], ["opus", "high"], l);
  for (const l of ["review r1", "review r2", "review r3"]) assert.equal(opts(l).effort, "medium", l);
  for (const l of ["file", "CI 1"]) assert.equal(opts(l).model, "sonnet", l);
  assert.ok(prompt("fix r1").includes("tests/conventions.test.ts tests/cli-state-matrix.test.ts"), "a fix round runs the gates \"Local gates\" names for one");

  assert.match(String(result["status"]), /^reviewed/);
  assert.deepEqual(shapeOf(result), RESULT_KEYS);
  assert.deepEqual(Object.keys(result["classes"] as object), ["new-class"], "only this PR's classes are returned, never the base's");
  assert.equal((result["filed"] as unknown[]).length, 1);
  // without args.repo each agent is told how to find the repository; no prompt names a machine's path
  assert.ok(calls.every((c) => !/\/Users\/|\/home\//.test(c.prompt)));
  assert.ok(prompt("implement").includes("git rev-parse --path-format=absolute --git-common-dir"));
});

test("pr-loop: each trigger of the class rule makes the next fix a class round, and a base finding never does", async () => {
  const k = (o: Partial<Record<string, string>> = {}) => finding({ classKey: "k", ...o });
  // twice in one review
  let r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [k({ input: "a" }), k({ input: "b" })], judgedCorrect: [] },
    "fix r1 (class)": (c: Call) => { assert.match(c.prompt, /CLASS round/); return pushed("b"); }, "review r2": clean, "CI 1": { state: "green", detail: "" },
  });
  assert.ok(r.labels.includes("fix r1 (class)"), "twice in one review");
  // across rounds
  r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [k({ input: "a" })], judgedCorrect: [] }, "fix r1": pushed("b"),
    "review r2": { findings: [k({ input: "b" })], judgedCorrect: [] }, "fix r2 (class)": pushed("c"), "review r3": clean, "CI 1": { state: "green", detail: "" },
  });
  assert.deepEqual(r.labels.filter((l) => l.startsWith("fix")), ["fix r1", "fix r2 (class)"], "across rounds");
  // carried in from the stack
  r = await run("pr-loop", { ...PR, repo: "/srv/checkout", knownClasses: { k: { count: 1, why: "met on the PR below" } } }, {
    ...START, "review r1": { findings: [k()], judgedCorrect: [] }, "fix r1 (class)": pushed("b"), "review r2": clean, "CI 1": { state: "green", detail: "" },
  });
  assert.ok(r.labels.includes("fix r1 (class)"), "carried in from the stack");
  assert.ok(r.prompt("implement").includes("/srv/checkout/scripts/board.ts status 301"), "args.repo is the board's checkout");
  assert.ok(r.calls.every((c) => !c.prompt.includes("<repo>")), "with args.repo no prompt leaves the repository to be found");
  // a base finding of k, in round 1 and twice over, never makes a round of k a class round
  r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [k({ origin: "base", input: "x" }), k({ origin: "base", input: "y" }), finding({ classKey: "j", input: "a" })], judgedCorrect: [] },
    "fix r1": pushed("b"), "review r2": { findings: [k({ input: "b" })], judgedCorrect: [] }, "fix r2": pushed("c"), "review r3": clean,
    "CI 1": { state: "green", detail: "" }, file: { issues: [] },
  });
  assert.deepEqual(r.labels.filter((l) => l.startsWith("fix")), ["fix r1", "fix r2"], "a base finding never triggers a class round");
  assert.deepEqual(Object.keys(r.result["classes"] as object).sort(), ["j", "k"]);
  assert.equal((r.result["classes"] as Record<string, { count: number }>)["k"]!.count, 1, "the base's two findings of k are not counted");
});

test("pr-loop: every exit returns one shape, and the base's findings are filed at every exit", async () => {
  const base = finding({ origin: "base", classKey: "b", input: "SELECT on_base FROM t" });
  // MAX_ROUNDS: four reviews with findings, three fixes, then a stop that still files
  const many: Answers = { ...START, file: { issues: [{ classKey: "b", issue: 951, action: "filed" }] } };
  for (let i = 1; i <= 4; i++) many[`review r${i}`] = { findings: [finding({ classKey: `c${i}`, input: `q${i}` }), ...(i === 1 ? [base] : [])], judgedCorrect: [] };
  for (let i = 1; i <= 3; i++) many[`fix r${i}`] = pushed(String(i));
  let r = await run("pr-loop", { ...PR }, many);
  assert.match(String(r.result["status"]), /^still 1 finding\(s\) after 4 rounds/);
  assert.equal(r.labels.at(-1), "file", "the MAX_ROUNDS exit files the base's findings");
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);

  // a CI wait that returns nothing
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": null });
  assert.match(String(r.result["status"]), /^CI wait 1 returned nothing/);
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  assert.equal(r.result["head"], sha("a"));

  // a CI fix that moves no head, and one that says flake, end the stage: CI is not waited on again for the same failure
  for (const fix of [{ ...pushed("a"), flake: false }, { ...pushed("a"), flake: true }]) {
    r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": { state: "failed", detail: "flaky" }, "CI fix 1": fix });
    assert.deepEqual(r.labels, ["brief", "implement", "review r1", "CI 1", "CI fix 1"]);
    assert.match(String(r.result["status"]), fix.flake ? /flake/ : /pushed nothing/);
    assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  }

  // a fix round that moves no head ends the run too
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": { findings: [finding({})], judgedCorrect: [] }, "fix r1": pushed("a") });
  assert.match(String(r.result["status"]), /pushed nothing/);

  // a brief that fails, before any PR
  r = await run("pr-loop", { ...PR }, { brief: null });
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  assert.equal(r.result["pr"], null);
});

test("issue-loop: without tasks it plans and returns, and runs nothing else", async () => {
  const { result, calls, flowCalls } = await run("issue-loop", { issue: 300 }, {
    plan: { tasks: [{ title: "300 · a", branch: "issue-300-a", scope: "s", stacked: false, readFirst: "r" }], notes: "" },
  });
  assert.deepEqual(calls.map((c) => c.opts.label), ["plan"]);
  assert.equal(flowCalls.length, 0);
  assert.match(String(result["status"]), /^planned/);
  assert.deepEqual([calls[0]!.opts.model, calls[0]!.opts.effort], ["opus", "high"]);
});

const TASKS = [
  { title: "300 · a", branch: "issue-300-a", scope: "first", stacked: false, readFirst: "r" },
  { title: "300 · b", branch: "issue-300-b", scope: "second", stacked: true, readFirst: "r" },
];
const SETUP = { setup: { subIssues: [311, 312] } };
const RUN_KEYS = ["classes", "done", "resume", "status", "tasks"];

test("issue-loop: a stacked task is based on the one before, its PR stacked on that PR, with that PR's classes", async () => {
  const firstClasses = { "met-below": { count: 2, why: "w" } };
  const { result, calls, flowCalls } = await run("issue-loop", { issue: 300, tasks: TASKS }, SETUP, [
    () => ({ status: "reviewed, ...", pr: 401, classes: firstClasses }),
    () => ({ status: "reviewed, ...", pr: 402, classes: { ...firstClasses, more: { count: 1, why: "w" } } }),
  ]);
  assert.deepEqual(calls.map((c) => c.opts.label), ["setup"]);
  assert.equal(calls[0]!.opts.model, "sonnet");
  assert.ok(calls[0]!.prompt.includes('board.ts status 300 "In progress"'), "the parent's card is moved to In progress");
  assert.deepEqual(flowCalls.map((f) => f.spec), ["pr-loop", "pr-loop"], "the named workflow, by default");
  const [first, second] = flowCalls.map((f) => f.args);
  assert.deepEqual([first!["base"], first!["stackedOn"], first!["issue"]], ["main", "", 311]);
  assert.deepEqual([second!["base"], second!["stackedOn"], second!["issue"]], ["issue-300-a", "401", 312]);
  assert.deepEqual(second!["knownClasses"], firstClasses);
  for (const a of [first!, second!]) assert.ok(!("scratch" in a) && !("repo" in a), "no scratch folder, and no repo unless given");
  assert.match(String(result["status"]), /^every task reviewed/);
  assert.deepEqual(shapeOf(result), RUN_KEYS);
});

test("issue-loop: a stop returns a resume whose tasks carry their sub-issues, and a resumed Setup that makes another is refused", async () => {
  const stop = await run("issue-loop", { issue: 300, tasks: TASKS, prLoop: "/x/pr-loop.js", repo: "/srv/checkout" }, SETUP, [
    () => ({ status: "CI not finished within the bound", pr: 401, classes: {} }),
  ]);
  assert.equal(stop.flowCalls.length, 1);
  assert.deepEqual(stop.flowCalls[0]!.spec, { scriptPath: "/x/pr-loop.js" });
  assert.equal(stop.flowCalls[0]!.args["repo"], "/srv/checkout");
  assert.match(String(stop.result["status"]), /^stopped at task 1/);
  assert.deepEqual(shapeOf(stop.result), RUN_KEYS);
  const resume = stop.result["resume"] as Record<string, unknown>;
  assert.equal(resume["from"], 0);
  assert.deepEqual((resume["tasks"] as Array<{ subIssue: number }>).map((t) => t.subIssue), [311, 312]);

  // run again with the resume: Setup is told the sub-issues, and is held to them
  const again = await run("issue-loop", resume, { setup: (c: Call) => { assert.ok(c.prompt.includes("(sub-issue #311)") && c.prompt.includes("(sub-issue #312)")); return { subIssues: [311, 312] }; } }, [
    (_s, a) => { assert.equal(a["issue"], 311); return { status: "reviewed", pr: 401, classes: {} }; },
    (_s, a) => { assert.equal(a["issue"], 312); return { status: "reviewed", pr: 402, classes: {} }; },
  ]);
  assert.match(String(again.result["status"]), /^every task reviewed/);
  const twice = await run("issue-loop", resume, { setup: { subIssues: [311, 999] } });
  assert.match(String(twice.result["status"]), /^setup failed: it returned another sub-issue for #312/);
  assert.equal(twice.flowCalls.length, 0);
});
