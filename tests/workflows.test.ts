import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";
import { parseRecords, recordsOfComment, stats, type ReviewRecord } from "../scripts/review-stats.ts";

// The coordinator's Workflow scripts, .claude/workflows/pr-loop.js and issue-loop.js, run CLAUDE.md "The loop" with
// agents. Nothing else reads them before a run, and a run costs hours, so this is their detector: each is loaded as the
// Workflow harness loads it (the leading `export const meta` made a `const`, the body an async function of args, agent,
// phase, log, workflow and parallel), and run against stub agents keyed on their label.

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const file = (name: string): string => path.join(ROOT, ".claude", "workflows", `${name}.js`);
const source = (name: string): string => fs.readFileSync(file(name), "utf8");

type Opts = { label: string; phase?: string; model?: string; effort?: string; isolation?: string; schema?: unknown };
type Call = { prompt: string; opts: Opts };
type Run = (args: unknown, agent: unknown, phase: unknown, log: unknown, workflow: unknown, parallel: unknown) => Promise<unknown>;
type Meta = { name: string; description: string; phases: Array<{ title: string }> };
type Answers = Record<string, unknown>;
type Result = Record<string, unknown>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...params: string[]) => Run;

function load(name: string): Run {
  const src = source(name);
  assert.match(src, /^export const meta = /, `${name}: the script begins with \`export const meta\``);
  return new AsyncFunction("args", "agent", "phase", "log", "workflow", "parallel", src.replace(/^export const meta/, "const meta"));
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
const SIGNS: Record<string, string> = { opus: "Opus 5.5", fable: "Fable 5.1", sonnet: "Sonnet 5.5" };
/** A script's SIGNS. */
function signs(name: string): Record<string, string> {
  const m = /^const SIGNS = (\{[^\n]*\})$/m.exec(source(name));
  assert.ok(m, `${name}: SIGNS is declared on one line`);
  return new Function(`return (${m[1]})`)() as Record<string, string>;
}

/** Every signature a prompt asks for: a heading, a co-author line, a sub-issue's --from. */
const signatures = (prompt: string): string[] =>
  [...prompt.matchAll(/### From Claude \(([^)]*)\)|Co-Authored-By: Claude ([^<`]*?) <|--from "([^"]*)"/g)].map((m) => (m[1] ?? m[2] ?? m[3])!);

/** A run of a script with stub agents: `answers[label]` is a value or a function of the call; a stage of pr-loop that
 * most tests do not look at (DEFAULTS) answers as a clean run's would, unless `answers` names it. */
async function run(name: string, args: Record<string, unknown>, answers: Answers,
  flows: Array<(spec: unknown, a: Record<string, unknown>) => unknown> = []) {
  const calls: Call[] = [];
  const phases: string[] = [];
  const flowCalls: Array<{ spec: unknown; args: Record<string, unknown> }> = [];
  const agent = async (prompt: string, opts: Opts) => {
    calls.push({ prompt, opts });
    const d = name === "pr-loop" ? DEFAULTS.find(([re]) => re.test(opts.label)) : undefined;
    assert.ok(opts.label in answers || d, `${name}: no stub answer for the agent labelled "${opts.label}"`);
    const a = opts.label in answers ? answers[opts.label] : d![1];
    return typeof a === "function" ? (a as (c: Call) => unknown)({ prompt, opts }) : a;
  };
  // the harness's parallel(): every thunk started at once. The harness resolves a thunk that throws to null; here a
  // throw is a stub's assertion failing, so it fails the test instead of reading as an agent that returned nothing.
  const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()));
  const workflow = async (spec: unknown, a: Record<string, unknown>) => {
    flowCalls.push({ spec, args: a });
    const f = flows[flowCalls.length - 1];
    assert.ok(f, `${name}: no stub for workflow call ${flowCalls.length}`);
    return f(spec, a);
  };
  const result = await load(name)(args, agent, (t: string) => { phases.push(t); }, () => {}, workflow, parallel) as Result;
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
const RESULT_KEYS = ["classes", "designRounds", "filed", "fromBase", "head", "pr", "probeRounds", "rounds", "status"];
const shapeOf = (r: Result) => Object.keys(r).sort();
const NOTE = {
  decision: "the kind is read from Postgres's analysis",
  authorities: [{ fact: "a node's result type", authority: "src/duck/pgtree.ts", whyNotAnother: "the analysis already holds it" }],
  principles: [{ principle: "Postgres decides, DuckDB computes", how: "no type is guessed from syntax" }],
  shapes: [{ input: "SELECT a * 2 FROM t", form: "select list", wrapper: "* 2", type: "int4", where: "real run" }],
  outOfScope: ["the stream"],
};
const green = { state: "green", detail: "" };
/** The stages of pr-loop most tests do not look at, answered as a clean run's. */
const DEFAULTS: Array<[RegExp, unknown]> = [
  [/^design d\d+$/, NOTE],
  [/^design review d\d+$/, { verdict: "sound", findings: [] }],
  [/^link$/, { linked: true, bodyFixed: false, detail: "listed 900" }],
  [/^probe \d+$/, clean],
  [/^CI read r\d+$/, green],
  [/^learn$/, pushed("f")],
  [/^learn check$/, { files: [".claude/rules/duck-rewrite.md"] }],
  [/^record$/, { url: "https://github.com/embeddable-hq/mason-data/pull/900#issuecomment-1" }],
];
/** The labels of the stages the older tests were written for: brief, implement, review, fix, CI and file. */
const core = (labels: string[]) => labels.filter((l) => !/^(design|link|probe|CI read|learn|record)/.test(l));

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
  assert.deepEqual(labels, [
    "brief", "design d1", "design review d1", "implement", "link", "probe 1", "review r1", "CI read r1", "fix r1",
    "probe 2", "review r2", "CI read r2", "learn", "learn check", "CI 1", "CI fix 1", "probe 3", "review r3", "CI read r3", "CI 2", "file", "record",
  ]);

  for (const c of calls.filter((c) => /^(fix|CI fix|probe fix|learn|record)/.test(c.opts.label))) assert.ok(!c.prompt.includes(base.input), `"${c.opts.label}" was handed the base's finding`);
  assert.ok(prompt("fix r1").includes(mine.input));
  assert.equal(prompt("file").split(base.input).length - 1, 1, "the base's finding, met in two rounds under two slugs, is filed once");
  assert.ok(prompt("review r2").includes("the cast of a text"), "the narrow re-check is told what the first review judged correct");
  // the CI fix is re-checked from the head before it: learn's docs commit (ffff…)
  assert.ok(prompt("review r3").includes("a test failed") && prompt("review r3").includes(`diff ${sha("f")} ${sha("c")}`), "the CI fix's commit is re-checked narrowly, from the head before it");
  assert.ok(prompt("CI 1").includes("gh pr checks") && !/gh pr checks[^`]*--watch/.test(prompt("CI 1")), "the CI wait is a gh pr checks loop, never --watch");
  assert.match(prompt("CI 1"), /timeout set to 600000/, "the CI chunk's tool call is given a timeout past the chunk");

  // the board is moved at every stage CLAUDE.md "The board says…" names
  for (const [l, status] of [["implement", "Implementing"], ["review r1", "In review"], ["fix r1", "Fixing"], ["CI 1", "CI / queued"], ["CI fix 1", "Fixing"]] as const) {
    assert.ok(prompt(l).includes(`scripts/board.ts status 301 "${status}"`), `"${l}" moves the card to ${status}`);
  }
  for (const c of calls) {
    const writes = /^(implement|fix|CI fix|probe fix|learn$)/.test(c.opts.label);
    assert.equal(c.opts.isolation === "worktree", writes, `"${c.opts.label}": every writer, and only a writer, works in a worktree of its own`);
    assert.equal(c.opts.model === "fable", /^(review|design review)/.test(c.opts.label), `"${c.opts.label}": only reviews are Fable's`);
  }
  const opts = (l: string) => calls.find((c) => c.opts.label === l)!.opts;
  for (const l of ["brief", "design d1", "implement", "probe 1", "fix r1", "CI fix 1"]) assert.deepEqual([opts(l).model, opts(l).effort], ["opus", "high"], l);
  assert.deepEqual([opts("learn").model, opts("learn").effort], ["opus", "medium"]);
  for (const l of ["review r1", "review r2", "review r3", "design review d1"]) assert.equal(opts(l).effort, "medium", l);
  for (const l of ["file", "CI 1", "CI read r1", "link", "record"]) assert.equal(opts(l).model, "sonnet", l);
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
  assert.deepEqual(r.labels.slice(-2), ["file", "record"], "the MAX_ROUNDS exit files the base's findings, then posts its record");
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);

  // a CI wait that returns nothing
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": null });
  assert.match(String(r.result["status"]), /^CI wait 1 returned nothing/);
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  assert.equal(r.result["head"], sha("a"));

  // a CI fix that moves no head, and one that says flake, end the stage: CI is not waited on again for the same failure
  for (const fix of [{ ...pushed("a"), flake: false }, { ...pushed("a"), flake: true }]) {
    r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": { state: "failed", detail: "flaky" }, "CI fix 1": fix });
    assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1"]);
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

const red = { state: "failed", detail: "a test failed" };
const f = (input: string) => ({ findings: [finding({ classKey: `c-${input}`, input })], judgedCorrect: [] });

test("pr-loop: the round bound is the PR's, counted through a CI fix's re-check", async () => {
  // two rounds before CI, two in a CI fix's re-check: the fourth is the PR's last, whatever call it falls in
  let r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false },
    "review r3": f("b"), "fix r3": pushed("d"), "review r4": f("c"),
  });
  assert.match(String(r.result["status"]), /^still 1 finding\(s\) after 4 rounds/);
  assert.equal((r.result["rounds"] as unknown[]).length, 4);
  assert.ok(!r.labels.includes("review r5"));
  // the bound already reached when a CI fix lands: no fifth review, and the status says the head was not re-checked
  r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": f("b"), "fix r2": pushed("c"), "review r3": f("c"), "fix r3": pushed("d"),
    "review r4": clean, "CI 1": red, "CI fix 1": { ...pushed("e"), flake: false },
  });
  assert.match(String(r.result["status"]), /^4 review rounds reached; head eeeeeee is not re-checked/);
  assert.equal(r.result["head"], sha("e"));
});

test("pr-loop: the head, not the flag, says whether a CI fix pushed; the last CI fix's CI is read", async () => {
  // flake: true with a head that moved: it was pushed, so it is re-checked and its CI read
  let r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": clean, "CI 1": red, "CI fix 1": { ...pushed("b"), flake: true }, "review r2": clean, "CI 2": { state: "green", detail: "" },
  });
  assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1", "review r2", "CI 2"]);
  assert.match(String(r.result["status"]), /^reviewed/);
  assert.equal(r.result["head"], sha("b"));

  // three CI fixes: the third one's CI is waited on before "still red"
  r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": clean, "CI 1": red, "CI fix 1": { ...pushed("b"), flake: false }, "review r2": clean,
    "CI 2": red, "CI fix 2": { ...pushed("c"), flake: false }, "review r3": clean,
    "CI 3": red, "CI fix 3": { ...pushed("d"), flake: false }, "review r4": clean, "CI 4": red,
  });
  assert.equal(core(r.labels).at(-1), "CI 4", "the last CI fix's CI is read");
  assert.match(r.prompt("CI 4"), new RegExp(`at head ${"d".repeat(7)}`));
  assert.match(String(r.result["status"]), /^CI still red after 3 fixes/);
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

// ---------------------------------------------------------------- the first-pass rules (docs/DESIGN.md "The
// independent review": a design note reviewed before code, a probe before every review, CI read beside it, every
// round carried to the next fix, each class learnt as a probe, and the record that says how often a PR passes)

const designFinding = { problem: "the type is guessed from a list of function names", class: "type-from-syntax", principle: "Postgres decides" };
const revise = { verdict: "revise", findings: [designFinding] };

test("pr-loop: the design note is reviewed before any code, revised at most once, then carried to the implementer and every fix", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START,
    "design review d1": revise,
    "design d2": (c: Call) => { assert.ok(c.prompt.includes(designFinding.problem) && c.prompt.includes(NOTE.decision), "the revision is given the note and its findings"); return NOTE; },
    "design review d2": revise,
    "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
  });
  assert.deepEqual(r.labels.slice(0, 6), ["brief", "design d1", "design review d1", "design d2", "design review d2", "implement"]);
  assert.ok(!r.labels.includes("design d3"), "two design rounds at most");
  assert.ok(r.prompt("design review d1").includes(NOTE.authorities[0]!.authority), "the design review reads the note's authorities");
  for (const l of ["implement", "fix r1"]) {
    assert.ok(r.prompt(l).includes(NOTE.decision) && r.prompt(l).includes(NOTE.shapes[0]!.input), `"${l}" is given the note`);
    assert.ok(r.prompt(l).includes(designFinding.problem), `"${l}" is given the design findings still open`);
  }
  assert.ok(r.prompt("implement").includes("## Design"), "the note goes in the PR body under ## Design");
  assert.ok(!r.prompt("design review d2").includes("Open design findings"), "within the design rounds, a finding is the next round's, not open");
  assert.equal((r.result["designRounds"] as unknown[]).length, 2);
  assert.match(String(r.result["status"]), /^reviewed.*1 design finding\(s\) still open after 2 design rounds/);

  // a sound note at once: one round, nothing open
  const once = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  assert.deepEqual(once.labels.slice(0, 4), ["brief", "design d1", "design review d1", "implement"]);
  assert.doesNotMatch(String(once.result["status"]), /design/);
  // a design review that returns nothing stops before any code, with no PR to post a record on
  const failed = await run("pr-loop", { ...PR }, { ...START, "design review d1": null });
  assert.deepEqual(failed.labels, ["brief", "design d1", "design review d1"]);
  assert.match(String(failed.result["status"]), /^design review d1 failed/);
  assert.deepEqual(shapeOf(failed.result), RESULT_KEYS);
});

test("pr-loop: a probe runs before every review, two rounds a push at most, never counted toward MAX_ROUNDS", async () => {
  // every push's first probe finds one of this PR's, its fix is probed again (clean), then Fable reads it
  const a: Answers = { ...START };
  let c = 0;
  const next = () => pushed(String.fromCharCode(98 + c++));
  for (let p = 1; p <= 8; p++) a[`probe ${p}`] = p % 2 ? { findings: [finding({ classKey: `p${p}`, input: `probe-${p}` })], judgedCorrect: [] } : clean;
  for (let p = 1; p <= 8; p += 2) a[`probe fix ${p}`] = next;
  for (let i = 1; i <= 4; i++) a[`review r${i}`] = { findings: [finding({ classKey: `c${i}`, input: `q${i}` })], judgedCorrect: [] };
  for (let i = 1; i <= 3; i++) a[`fix r${i}`] = next;
  let r = await run("pr-loop", { ...PR }, a);
  assert.equal((r.result["rounds"] as unknown[]).length, 4, "four review rounds, whatever the probe's rounds");
  assert.equal((r.result["probeRounds"] as unknown[]).length, 8);
  assert.match(String(r.result["status"]), /^still 1 finding\(s\) after 4 rounds/);
  for (const [i, l] of r.labels.entries()) if (/^review r/.test(l)) assert.match(r.labels[i - 1]!, /^probe \d+$/, `"${l}" is probed first`);
  assert.ok(r.prompt("probe 1").includes("## What review probes") && r.prompt("probe 1").includes(NOTE.shapes[0]!.input), "the probe runs the rules' probes and the note's shapes");
  assert.match(r.prompt("probe 1"), /outer join's nullable side/);

  // at most two probe rounds on one push: the second fix goes to the review unprobed
  r = await run("pr-loop", { ...PR }, {
    ...START,
    "probe 1": { findings: [finding({ classKey: "x", input: "p1" }), finding({ origin: "base", classKey: "on-base", input: "probe-base" })], judgedCorrect: [] },
    "probe fix 1": pushed("b"),
    "probe 2": { findings: [finding({ classKey: "y", input: "p2" })], judgedCorrect: [] },
    "probe fix 2": pushed("c"),
    "review r1": clean, "CI 1": green, file: { issues: [{ classKey: "on-base", issue: 960, action: "filed" }] },
  });
  assert.deepEqual(r.labels.slice(4, 10), ["link", "probe 1", "probe fix 1", "probe 2", "probe fix 2", "review r1"]);
  assert.ok(r.prompt("review r1").includes(`diff origin/main ${sha("c")}`), "the review reads the last probe fix");
  assert.ok(r.prompt("file").includes("probe-base"), "a probe's base finding is filed");
  assert.ok(!r.prompt("probe fix 1").includes("probe-base"), "and never fixed");
  assert.equal(r.calls.find((x) => x.opts.label === "probe fix 1")!.opts.isolation, "worktree");
  assert.ok(r.prompt("probe fix 1").includes("tests/conventions.test.ts tests/cli-state-matrix.test.ts"), "a probe fix runs a fix round's gates");
});

test("pr-loop: every fix carries the note and every earlier round, labelled, with what each judged correct", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START,
    "probe 1": { findings: [finding({ classKey: "p", input: "SELECT probe_found FROM t" })], judgedCorrect: ["probe-judged"] },
    "probe fix 1": pushed("b"),
    "review r1": { findings: [finding({ classKey: "a", input: "SELECT r1_found FROM t" })], judgedCorrect: ["r1-judged"] },
    "fix r1": pushed("c"),
    "review r2": { findings: [finding({ classKey: "b", input: "SELECT r2_found FROM t" })], judgedCorrect: ["r2-judged"] },
    "fix r2": pushed("d"),
    "review r3": clean, "CI 1": green,
  });
  const fix2 = r.prompt("fix r2");
  for (const s of ["### probe 1", "SELECT probe_found FROM t", "probe-judged", "### review r1", "SELECT r1_found FROM t", "r1-judged", "SELECT r2_found FROM t", NOTE.decision]) {
    assert.ok(fix2.includes(s), `fix r2 carries ${s}`);
  }
  assert.ok(fix2.indexOf("### probe 1") < fix2.indexOf("### review r1"), "oldest first");
  assert.ok(r.prompt("fix r1").includes("### probe 1") && !r.prompt("fix r1").includes("### review r1"), "a round is not its own earlier round");
});

test("pr-loop: CI is read beside each review, and its failure goes into that round's fix, in one push", async () => {
  let ciStarted = false;
  const r = await run("pr-loop", { ...PR }, {
    ...START,
    "review r1": async () => { await new Promise((ok) => setImmediate(ok)); assert.ok(ciStarted, "CI is read while the review runs"); return f("a"); },
    "CI read r1": () => { ciStarted = true; return { state: "failed", detail: "tests/workflows.test.ts: boom" }; },
    "fix r1": pushed("b"), "review r2": clean, "CI read r2": { state: "timeout", detail: "" }, "CI 1": green,
  });
  assert.deepEqual(r.labels.filter((l) => /^(review|CI read|fix)/.test(l)), ["review r1", "CI read r1", "fix r1", "review r2", "CI read r2"]);
  assert.ok(r.prompt("fix r1").includes("boom") && r.prompt("fix r1").includes("input: a"), "the review's finding and CI's failure in one fix");
  assert.ok(r.prompt("review r2").includes("boom"), "the re-check is told the CI failure was fixed too");
  assert.ok(!r.prompt("CI read r1").includes("board.ts status"), "the CI read beside a review moves no card");
  assert.equal(parseRecords(r.prompt("record"))[0]!.ciFixes, 1);

  // a CI read that could not tell sends nothing back
  const unsure = await run("pr-loop", { ...PR }, { ...START, "review r1": f("a"), "CI read r1": null, "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  assert.doesNotMatch(unsure.prompt("fix r1"), /CI failed/);
});

test("pr-loop: learn turns every finding of the PR into a review probe, before CI so CI covers it, and only when there was one", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START,
    "design review d1": revise, "design d2": NOTE,
    "probe 1": { findings: [finding({ classKey: "p", input: "SELECT probe_found FROM t" })], judgedCorrect: [] },
    "probe fix 1": pushed("b"),
    "review r1": { findings: [finding({ classKey: "a", input: "SELECT review_found FROM t" })], judgedCorrect: [] },
    "fix r1": pushed("c"), "review r2": clean, "CI 1": green,
  });
  assert.deepEqual(r.labels.slice(-5), ["CI read r2", "learn", "learn check", "CI 1", "record"]);
  const learn = r.prompt("learn");
  for (const s of ["SELECT probe_found FROM t", "SELECT review_found FROM t", designFinding.problem, "PR 900", "## What review probes", "## Detector wanted", "synthetic"]) {
    assert.ok(learn.includes(s), `learn is told ${s}`);
  }
  assert.match(learn, /never a second bullet/);
  assert.match(r.prompt("CI 1"), new RegExp(`at head ${"f".repeat(7)}`), "CI waits on learn's commit");
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual(rec.findings, [
    { round: 1, stage: "design", classKey: "type-from-syntax" }, { round: 1, stage: "probe", classKey: "p" }, { round: 1, stage: "review", classKey: "a" },
  ]);
  assert.deepEqual([rec.designRounds, rec.probeRounds, rec.reviewRounds], [2, 3, 2]);

  // no finding anywhere: nothing to learn
  const none = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  assert.ok(!none.labels.includes("learn"));
  // a learn that fails is said, and the run goes on to CI
  const failed = await run("pr-loop", { ...PR }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, learn: null, "CI 1": green });
  assert.match(String(failed.result["status"]), /^reviewed.*learn failed/);
});

test("pr-loop: every exit with a PR posts one Review record, whose block review-stats reads", async () => {
  const exits: Array<[string, Answers]> = [
    ["green", { ...START, "review r1": clean, "CI 1": green }],
    ["CI null", { ...START, "review r1": clean, "CI 1": null }],
    ["review failed", { ...START, "review r1": null }],
    ["learn outside the rules", { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "learn check": { files: ["src/duck/plan.ts"] } }],
    ["not linked", { ...START, link: { linked: false, bodyFixed: true, detail: "listed none" } }],
  ];
  for (const [name, answers] of exits) {
    const r = await run("pr-loop", { ...PR }, answers);
    assert.equal(r.labels.filter((l) => l === "record").length, 1, name);
    assert.equal(r.labels.at(-1), "record", name);
    const p = r.prompt("record");
    assert.match(p, /## Review record/);
    const recs = parseRecords(p);
    assert.equal(recs.length, 1, name);
    assert.equal(recs[0]!.pr, 900);
    assert.equal(recs[0]!.status, r.result["status"], `${name}: the record holds the run's status`);
    assert.equal(recs[0]!.reviewRounds, (r.result["rounds"] as unknown[]).length);
    assert.match(p, /gh pr comment 900 --body-file/);
  }
  // no PR, no record
  const r = await run("pr-loop", { ...PR }, { brief: null });
  assert.ok(!r.labels.includes("record"));
  // a record that is not posted is said
  const lost = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green, record: null });
  assert.match(String(lost.result["status"]), /the Review record was not posted$/);
});

test("pr-loop: GitHub itself must say the PR closes its sub-issue, or the run stops", async () => {
  // linked: the run goes on, and the query asked is GitHub's
  let r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  assert.deepEqual(r.labels.slice(3, 6), ["implement", "link", "probe 1"]);
  const q = r.prompt("link");
  assert.ok(q.includes("gh api graphql -F n=301") && q.includes("closedByPullRequestsReferences(first:10,includeClosedPrs:true)"), "the link is read from GitHub");
  assert.ok(q.includes("Closes #301") && q.includes("gh pr edit 900"), "an unlinked body is fixed, then asked again");
  // not linked after the fix: the run stops there, before any review
  r = await run("pr-loop", { ...PR }, { ...START, link: { linked: false, bodyFixed: true, detail: "listed none" } });
  assert.deepEqual(r.labels.slice(3), ["implement", "link", "record"]);
  assert.match(String(r.result["status"]), /^PR 900 is not linked to #301 after its body was fixed/);
  // no answer is "not known", never linked
  r = await run("pr-loop", { ...PR }, { ...START, link: null });
  assert.match(String(r.result["status"]), /whether PR 900 closes #301 is not known/);
  // a stacked PR: GitHub links only into the default branch, so its body's keyword is read
  r = await run("pr-loop", { ...PR, base: "issue-300-a", stackedOn: "401" }, { ...START, "review r1": clean, "CI 1": green });
  assert.ok(r.prompt("link").includes("stacked") && !r.prompt("link").includes("graphql"));
});

test("every .claude/rules/ file has a `## What review probes` section, which the Probe stage reads and Learn writes", () => {
  const dir = path.join(ROOT, ".claude", "rules");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0);
  const missing = files.filter((f) => !/^## What review probes$/m.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(missing, [], "a rules file without the section gives the Probe stage nothing to run for its paths");
});

test("review-stats: a record's block is parsed, a malformed one is refused by name, the last record of a PR is its own, and a PR that never reached a review never counts as passing", () => {
  const rec = (o: Partial<ReviewRecord>): ReviewRecord => ({ pr: 1, designRounds: 1, probeRounds: 1, reviewRounds: 1, findings: [], ciFixes: 0, status: "reviewed", ...o });
  const block = (r: unknown) => "```json mason-review-record\n" + JSON.stringify(r) + "\n```";
  const body = `### From Claude (Sonnet 5.5)\n## Review record\n\ntext\n\n${block(rec({ pr: 7 }))}\n\nmore\n${block(rec({ pr: 8 }))}`;
  assert.deepEqual(parseRecords(body).map((r) => r.pr), [7, 8]);
  assert.deepEqual(parseRecords("no record here"), []);
  assert.throws(() => parseRecords("```json mason-review-record\n{not json\n```"), /not JSON/);
  assert.throws(() => parseRecords(block({ pr: 1 })), /malformed: designRounds is not a number/);
  assert.throws(() => parseRecords(block({ ...rec({}), findings: [{ round: 1, stage: "lunch", classKey: "k" }] })), /a finding is not/);

  const rev = (round: number, classKey = "k") => ({ round, stage: "review" as const, classKey });
  const s = stats([
    rec({ pr: 1, reviewRounds: 4, findings: [rev(1)] }),
    rec({ pr: 1, reviewRounds: 1, findings: [{ round: 1, stage: "probe", classKey: "k" }] }), // a resume: the last is the PR's
    // a clean first review, then a CI fix whose narrow re-check is round 2: passed the first review
    rec({ pr: 2, reviewRounds: 2, probeRounds: 3, ciFixes: 1, findings: [{ round: 1, stage: "design", classKey: "k" }] }),
    // round 1 found one, round 2 found nothing: passed by the second
    rec({ pr: 3, reviewRounds: 2, findings: [rev(1, "j")] }),
    // round 1 found one, and its fix pushed nothing: one review round, not passed
    rec({ pr: 4, reviewRounds: 1, findings: [rev(1, "j")], status: "fix round 1 pushed nothing: the coordinator decides" }),
    // stopped at the link check, a failed review: no review, counted apart, never as passing
    rec({ pr: 5, reviewRounds: 0, status: "PR 5 is not linked to #1" }),
    rec({ pr: 6, reviewRounds: 0, status: "review r1 failed" }),
    // round 1 and round 2 both found one
    rec({ pr: 7, reviewRounds: 3, findings: [rev(1, "j"), rev(2, "j")] }),
  ]);
  assert.deepEqual([s.prs, s.reviewed, s.neverReviewed], [7, 5, 2]);
  assert.equal(s.firstPass, 2 / 5, "PRs 1 and 2");
  assert.equal(s.bySecond, 3 / 5, "PRs 1, 2 and 3");
  assert.equal(s.meanReviewRounds, (1 + 2 + 2 + 1 + 3) / 5, "over the PRs reviewed");
  assert.deepEqual(s.topClasses, [{ classKey: "j", count: 4 }, { classKey: "k", count: 2 }]);
  assert.equal(stats([]).firstPass, 0);
});

test("review-stats: a record counts for the PR whose comment holds it, and a quoted record is no block", () => {
  const rec = (pr: number) => JSON.stringify({ pr, designRounds: 1, probeRounds: 1, reviewRounds: 1, findings: [], ciFixes: 0, status: "reviewed" });
  const url = (n: number) => `https://api.github.com/repos/embeddable-hq/mason-data/issues/${n}`;
  const own = "```json mason-review-record\n" + rec(9) + "\n```";
  // a record of PR 9 quoted on PR 12: not PR 12's, and not credited to PR 9 from there
  assert.deepEqual(recordsOfComment({ issue_url: url(12), body: own }), { records: [], quoted: 1 });
  assert.deepEqual(recordsOfComment({ issue_url: url(9), body: own }).records.map((r) => r.pr), [9]);
  // a quoted opener whose closing fence is not quoted: the quote is no block, and the real record after it is read
  const body = "> ```json mason-review-record\n> " + rec(3) + "\n```\n\nours:\n" + "```json mason-review-record\n" + rec(12) + "\n```";
  assert.deepEqual(recordsOfComment({ issue_url: url(12), body }), { records: [JSON.parse(rec(12))], quoted: 0 });
  assert.throws(() => parseRecords("```json mason-review-record\n" + rec(1)), /never closes/);
  assert.throws(() => recordsOfComment({ issue_url: "https://example.com/x", body: own }), /names no PR/);
});

test("pr-loop: a probe that fails, or whose fix fails or pushes nothing, is noted and the review goes on", async () => {
  const cases: Array<[string, Answers, RegExp]> = [
    ["probe null", { "probe 1": null }, /probe 1 failed: the review read head aaaaaaa unprobed/],
    ["probe fix null", { "probe 1": f("p"), "probe fix 1": null }, /probe fix 1 failed: its findings went to the review unfixed/],
    ["probe fix pushed nothing", { "probe 1": f("p"), "probe fix 1": pushed("a") }, /probe fix 1 pushed nothing/],
  ];
  for (const [name, answers, note] of cases) {
    const r = await run("pr-loop", { ...PR }, { ...START, ...answers, "review r1": clean, "CI 1": green });
    assert.ok(r.labels.includes("review r1") && r.labels.includes("CI 1"), `${name}: the review and CI still run`);
    assert.match(String(r.result["status"]), /^reviewed/, name);
    assert.match(String(r.result["status"]), note, name);
    assert.match(parseRecords(r.prompt("record"))[0]!.status, note, `${name}: the record says it too`);
  }
});

test("pr-loop: Learn's commit is read from git, and a head that changed anything outside .claude/rules/ is never reported ready", async () => {
  const learnt: Answers = { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green };
  let r = await run("pr-loop", { ...PR }, learnt);
  assert.deepEqual(r.labels.slice(-4), ["learn", "learn check", "CI 1", "record"]);
  assert.ok(r.prompt("learn check").includes(`diff --no-renames --name-only ${sha("b")} ${sha("f")}`), "the files are read from the commit range");
  assert.match(String(r.result["status"]), /^reviewed/);
  // a learn that touched a test: stopped before CI, at learn's head
  r = await run("pr-loop", { ...PR }, { ...learnt, "learn check": { files: [".claude/rules/cli.md", "tests/workflows.test.ts"] } });
  assert.deepEqual(r.labels.slice(-2), ["learn check", "record"]);
  assert.match(String(r.result["status"]), /^learn's commit fffffff changed tests\/workflows\.test\.ts outside \.claude\/rules\//);
  assert.equal(r.result["head"], sha("f"));
  // the files could not be read: not known, never ready
  // the files could not be read, or no path was read of a head that moved: not known, never ready
  for (const check of [null, { files: [] }]) {
    r = await run("pr-loop", { ...PR }, { ...learnt, "learn check": check });
    assert.match(String(r.result["status"]), /could not be read: whether it touched only \.claude\/rules\/ is not known/, JSON.stringify(check));
    assert.ok(!r.labels.includes("CI 1"), JSON.stringify(check));
  }
  // a rename from outside into .claude/rules/: both ends are paths the check reads, so its source stops the run
  r = await run("pr-loop", { ...PR }, { ...learnt, "learn check": { files: [".claude/rules/moved.md", "src/duck/plan.ts"] } });
  assert.match(String(r.result["status"]), /changed src\/duck\/plan\.ts outside/);
});

test("pr-loop: the Learn check's own git command prints both ends of a rename", async () => {
  // the command the prompt gives, run on a real repository where a file moved from src/ into .claude/rules/
  const r = await run("pr-loop", { ...PR }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  const m = /`git -C \S+ (diff [^`]*) \S+ \S+`/.exec(r.prompt("learn check"));
  assert.ok(m, "the learn check names a git diff over the commit range");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-check-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
    git("init", "-q");
    fs.mkdirSync(path.join(dir, "src", "duck"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "duck", "plan.ts"), "export const a = 1;\n".repeat(20));
    git("add", "-A");
    git("commit", "-q", "-m", "before");
    fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
    git("mv", "src/duck/plan.ts", ".claude/rules/moved.md");
    git("commit", "-q", "-m", "after");
    const printed = git(...m[1]!.split(" "), "HEAD~1", "HEAD").split("\n").filter(Boolean).sort();
    assert.deepEqual(printed, [".claude/rules/moved.md", "src/duck/plan.ts"]);
    // without --no-renames git prints the new path alone: the check would see nothing outside
    assert.deepEqual(git("diff", "--name-only", "-M", "HEAD~1", "HEAD").split("\n").filter(Boolean), [".claude/rules/moved.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-loop: a red CI beside a clean review goes to the CI stage, which reads it and sends it to a CI fix", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": clean, "CI read r1": { state: "failed", detail: "tests/workflows.test.ts: red" },
    "CI 1": { state: "failed", detail: "tests/workflows.test.ts: red" }, "CI fix 1": { ...pushed("b"), flake: false }, "review r2": clean, "CI 2": green,
  });
  assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1", "review r2", "CI 2"], "no review fix round for a clean review");
  assert.match(String(r.result["status"]), /^reviewed/);
});

test("pr-loop: the author is told to run the rules' review probes before every push", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false }, "review r3": clean, "CI 2": green,
  });
  for (const l of ["implement", "fix r1", "CI fix 1"]) assert.match(r.prompt(l), /Before the push, run the `## What review probes`/, l);
});
