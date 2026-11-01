import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";
import { BLOCKING, DEFERRED, parseRecords, recordsOfComment, render, stats, type ReviewRecord } from "../scripts/review-stats.ts";

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

/** The scripts that take one PR through the loop: pr-loop, and the slim one raced against it. */
const PR_LOOPS = ["pr-loop", "pr-loop-slim"];

/** A run of a script with stub agents: `answers[label]` is a value or a function of the call; a stage of pr-loop that
 * most tests do not look at (DEFAULTS) answers as a clean run's would, unless `answers` names it. */
async function run(name: string, args: Record<string, unknown>, answers: Answers,
  flows: Array<(spec: unknown, a: Record<string, unknown>) => unknown> = []) {
  const calls: Call[] = [];
  const phases: string[] = [];
  const flowCalls: Array<{ spec: unknown; args: Record<string, unknown> }> = [];
  const agent = async (prompt: string, opts: Opts) => {
    calls.push({ prompt, opts });
    const d = PR_LOOPS.includes(name) ? DEFAULTS.find(([re]) => re.test(opts.label)) : undefined;
    assert.ok(opts.label in answers || d, `${name}: no stub answer for the agent labelled "${opts.label}"`);
    const a = opts.label in answers ? answers[opts.label] : d![1];
    const v = await (typeof a === "function" ? (a as (c: Call) => unknown)({ prompt, opts }) : a);
    // a probe or review stub that does not say otherwise read an engine diff and ran a statement: a review that showed
    // none of the evidence it owed stops the run, and the tests of that give the key (0, a non-count, or undefined)
    if (PR_LOOPS.includes(name) && /^(probe \d+|review r\d+)$/.test(opts.label) && v && typeof v === "object") {
      const ran: Record<string, unknown> = { changedPaths: ["src/duck/plan.ts"], statementsRun: 1, statementsMatched: 1, checksRun: 0 };
      return { ...Object.fromEntries(Object.entries(ran).filter(([k]) => !(k in v))), ...v };
    }
    return v;
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
  input: "SELECT 1", expected: "1", actual: "2", atBase: "1", origin: "this-pr", severity: "wrong-answer", classKey: "some-class", classWhy: "why", where: "plan.ts:1", ...o,
});
const clean = { findings: [], judgedCorrect: [] };
const PR = { issue: 301, parent: 300, title: "300 · a piece", base: "main", branch: "issue-300-a-piece", stackedOn: "", context: "the scope" };
const START: Answers = {
  brief: { brief: "build it", shapes: ["SELECT a FROM t"], tests: ["tests/workflows.test.ts"] },
  implement: { pr: 900, head: sha("a"), summary: "done" },
};
const pushed = (c: string) => ({ pr: 900, head: sha(c), summary: "fixed" });
const RESULT_KEYS = ["classes", "deferred", "designRounds", "filed", "fromBase", "head", "pr", "probeRounds", "rounds", "status"];
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

test("every script parses as the harness loads it, with a pure-literal meta naming them, and none of the calls the harness forbids", () => {
  for (const name of ["pr-loop", "pr-loop-slim", "issue-loop"]) {
    assert.equal(typeof load(name), "function");
    meta(name);
    const src = source(name);
    assert.doesNotMatch(src, /Date\.now\(|Math\.random\(|new Date\(\s*\)/, `${name}: Date.now(), Math.random() and new Date() are not allowed in a Workflow script`);
    // the scripts run for anyone on the team: no path of one machine, and no scratch folder beside them
    assert.doesNotMatch(src, /\/Users\/|\/home\/|~\/|[A-Z]:\\\\|scratch/, `${name}: a home path or a scratch folder is written in the script`);
  }
  // a script cannot import, so the one table of signatures is written in each, and held equal here
  for (const name of ["pr-loop", "pr-loop-slim", "issue-loop"]) assert.deepEqual(signs(name), SIGNS, name);
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
    file: { issues: [{ classKey: "base-class", source: "base", issue: 950, action: "filed" }] },
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
  const many: Answers = { ...START, file: { issues: [{ classKey: "b", source: "base", issue: 951, action: "filed" }] } };
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
    "review r1": clean, "CI 1": green, file: { issues: [{ classKey: "on-base", source: "base", issue: 960, action: "filed" }] },
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
    { round: 1, stage: "design", classKey: "type-from-syntax" }, { round: 1, stage: "probe", classKey: "p", severity: "wrong-answer" },
    { round: 1, stage: "review", classKey: "a", severity: "wrong-answer" },
  ]);
  assert.deepEqual(rec.deferred, []);
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

// ---------------------------------------------------------------- only a blocking finding sends a PR back (Tom,
// 2026-11-01; CLAUDE.md "The loop" step 4): a wrong answer, a crash, lost data, security, a regression, or a red CI.
// A refusal's wording, an over-refusal, docs and quality are filed, one issue per class, and the PR goes on.

/** A script's one-line `const <name> = [...]`. */
function listOf(name: string, constName: string): string[] {
  const m = new RegExp(`^const ${constName} = (\\[[^\\n]*\\])$`, "m").exec(source(name));
  assert.ok(m, `${name}: ${constName} is declared on one line`);
  return new Function(`return (${m[1]})`)() as string[];
}
const later = (o: Partial<Record<string, string>>) => finding({ severity: "message", classKey: "wording", ...o });

test("pr-loop: every finding must carry a severity, blocking or not, and the two lists are review-stats' own", async () => {
  // a script cannot import: its lists are held equal to the ones review-stats reads records with
  assert.deepEqual(listOf("pr-loop", "BLOCKING"), [...BLOCKING]);
  assert.deepEqual(listOf("pr-loop", "DEFERRED"), [...DEFERRED]);
  assert.deepEqual([...BLOCKING], ["wrong-answer", "crash", "data-loss", "security", "regression"]);
  assert.deepEqual([...DEFERRED], ["message", "over-refusal", "docs", "quality"]);
  const r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  for (const l of ["probe 1", "review r1"]) {
    const schema = r.calls.find((c) => c.opts.label === l)!.opts.schema as
      { properties: { findings: { items: { required: string[]; properties: Record<string, { enum?: string[]; description?: string }> } } } };
    const item = schema.properties.findings.items;
    assert.ok(item.required.includes("severity"), `${l}: the schema requires a severity`);
    assert.deepEqual(item.properties["severity"]!.enum, [...BLOCKING, ...DEFERRED], `${l}: the nine kinds`);
    assert.match(item.properties["severity"]!.description!, /When unsure, a blocking severity/, `${l}: the schema says when unsure, blocking`);
    // the prompt states the line in one paragraph: each kind, and that unsure is blocking
    for (const k of [...BLOCKING, ...DEFERRED]) assert.ok(r.prompt(l).includes(k), `${l}: the prompt names ${k}`);
    assert.match(r.prompt(l), /When you are unsure, the finding is blocking/, l);
  }
});

test("pr-loop: a round with only non-blocking findings of the PR's is clean: filed as deferred, recorded, never fixed or learnt", async () => {
  const a = later({ input: "SELECT wording_a FROM t" });
  const b = later({ input: "SELECT wording_b FROM t" }); // the same class twice: no class round, since none is fixed
  const o = later({ input: "SELECT refused FROM t", severity: "over-refusal", classKey: "gap" });
  const r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [a, b, o], judgedCorrect: [] }, "CI 1": green,
    file: (c: Call) => {
      assert.ok(c.prompt.includes("source 'deferred'") && !c.prompt.includes("source 'base'"), "only the deferred section");
      return { issues: [{ classKey: "wording", source: "deferred", issue: 970, action: "filed" }, { classKey: "gap", source: "deferred", issue: 971, action: "filed" }] };
    },
  });
  assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "file"], "no fix round, no learn");
  assert.ok(!r.labels.includes("learn"));
  assert.match(String(r.result["status"]), /^reviewed, no open blocking finding of this PR, CI green.*3 non-blocking finding\(s\) of this PR filed \(#970, #971\), not fixed/);
  assert.doesNotMatch(String(r.result["status"]), /NOT filed/);
  assert.deepEqual(r.result["classes"], {}, "a non-blocking class is never counted toward the class rule");
  assert.equal((r.result["deferred"] as unknown[]).length, 3);
  assert.deepEqual(r.result["fromBase"], []);
  const file = r.prompt("file");
  for (const s of [a.input, b.input, o.input, "deferred as non-blocking", "met in PR 900's review", "met in review r1", "message", "over-refusal"]) assert.ok(file.includes(s), `the filing says ${s}`);
  // the record lists them apart, and review-stats reads the PR as passing its first review
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual(rec.findings, []);
  assert.deepEqual(rec.deferred, [
    { round: 1, stage: "review", classKey: "wording", severity: "message" }, { round: 1, stage: "review", classKey: "wording", severity: "message" },
    { round: 1, stage: "review", classKey: "gap", severity: "over-refusal" },
  ]);
  assert.match(r.prompt("record"), /review 1: 0 finding\(s\); 3 non-blocking, deferred/);
  assert.match(r.prompt("record"), /#970 \(wording, deferred, filed\)/);
  assert.equal(stats([rec]).firstPass, 1);

  // a red CI still blocks: beside a non-blocking-only review it goes to the CI stage and a CI fix
  const redRun = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [a], judgedCorrect: [] }, "CI read r1": red, "CI 1": red, "CI fix 1": { ...pushed("b"), flake: false },
    "review r2": clean, "CI 2": green, file: { issues: [] },
  });
  assert.deepEqual(core(redRun.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1", "review r2", "CI 2", "file"]);
});

test("pr-loop: only a blocking finding of the PR's is fixed and counts toward a class round; the others never reach a fix", async () => {
  const k = later({ classKey: "k", input: "SELECT k_wording FROM t" });
  const r = await run("pr-loop", { ...PR }, {
    ...START,
    // a probe's non-blocking finding: no probe fix, and the review reads the head unchanged
    "probe 1": { findings: [later({ classKey: "p", input: "SELECT probe_wording FROM t", severity: "docs" })], judgedCorrect: [] },
    // round 1: one blocking of j, two non-blocking of k (which would make a class round if they counted)
    "review r1": { findings: [finding({ classKey: "j", input: "SELECT j_wrong FROM t" }), k, { ...k, input: "SELECT k_wording2 FROM t" }], judgedCorrect: [] },
    "fix r1": pushed("b"),
    // round 2: a blocking finding of k, the class round 1 met only as non-blocking; and k's first input met again
    "review r2": { findings: [finding({ classKey: "k", input: "SELECT k_wrong FROM t", severity: "crash" }), k], judgedCorrect: [] },
    "fix r2": pushed("c"),
    "review r3": clean, "CI 1": green, file: { issues: [] },
  });
  assert.ok(!r.labels.some((l) => l.startsWith("probe fix")), "a probe's non-blocking finding gets no probe fix");
  assert.deepEqual(r.labels.filter((l) => /^fix/.test(l)), ["fix r1", "fix r2"], "no class round: k's earlier findings did not block");
  for (const l of ["fix r1", "fix r2", "learn"]) {
    for (const s of ["SELECT probe_wording FROM t", "SELECT k_wording FROM t", "SELECT k_wording2 FROM t"]) assert.ok(!r.prompt(l).includes(s), `"${l}" was handed the non-blocking ${s}`);
  }
  assert.ok(r.prompt("fix r1").includes("SELECT j_wrong FROM t") && r.prompt("fix r2").includes("SELECT k_wrong FROM t"));
  assert.deepEqual(Object.fromEntries(Object.entries(r.result["classes"] as Record<string, { count: number }>).map(([c, v]) => [c, v.count])), { j: 1, k: 1 });
  // a later round is told what is already deferred, and an input met twice is filed once
  assert.ok(r.prompt("review r2").includes("Already deferred as non-blocking") && r.prompt("review r2").includes("SELECT k_wording FROM t"));
  assert.equal(r.prompt("file").split("SELECT k_wording FROM t").length - 1, 1);
  assert.equal((r.result["deferred"] as unknown[]).length, 3);
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual(rec.findings.map((f) => [f.stage, f.round, f.classKey, f.severity]), [["review", 1, "j", "wrong-answer"], ["review", 2, "k", "crash"]]);
  assert.deepEqual(rec.deferred!.map((f) => [f.stage, f.round, f.classKey]), [["probe", 1, "p"], ["review", 1, "k"], ["review", 1, "k"]]);
});

test("pr-loop: a finding with no severity, or one the script does not know, blocks; a base finding is the base's whatever its severity", async () => {
  for (const severity of [undefined, "cosmetic"]) {
    const { severity: _, ...bare } = finding({ input: "SELECT unsure FROM t" });
    const r = await run("pr-loop", { ...PR }, {
      ...START, "review r1": { findings: [severity ? { ...bare, severity } : bare], judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
    });
    assert.ok(r.labels.includes("fix r1"), `severity ${severity}: blocking`);
    assert.ok(!r.labels.includes("file"));
  }
  const base = later({ origin: "base", input: "SELECT base_wording FROM t" });
  const mine = later({ input: "SELECT mine_wording FROM t" });
  const r = await run("pr-loop", { ...PR }, { ...START, "review r1": { findings: [base, mine], judgedCorrect: [] }, "CI 1": green, file: { issues: [] } });
  const file = r.prompt("file");
  const [onBase, ofPr] = [file.indexOf("## source 'base'"), file.indexOf("## source 'deferred'")];
  assert.ok(onBase >= 0 && ofPr > onBase, "two sections, kept apart");
  assert.ok(file.indexOf(base.input) > onBase && file.indexOf(base.input) < ofPr, "the base's finding is filed as the base's");
  assert.ok(file.indexOf(mine.input) > ofPr, "the PR's own is filed as deferred");
  assert.deepEqual((r.result["fromBase"] as Array<{ input: string }>).map((g) => g.input), [base.input]);
  assert.deepEqual((r.result["deferred"] as Array<{ input: string }>).map((g) => g.input), [mine.input]);
});

test("pr-loop: an input deferred once and found blocking later is fixed, never filed; a failed filing never says filed", async () => {
  const w = later({ input: "SELECT later_blocking FROM t" });
  const r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [finding({ classKey: "j", input: "SELECT j_wrong FROM t" }), w], judgedCorrect: [] }, "fix r1": pushed("b"),
    "review r2": { findings: [{ ...w, severity: "regression" }], judgedCorrect: [] }, "fix r2": pushed("c"), "review r3": clean, "CI 1": green,
  });
  assert.ok(r.prompt("fix r2").includes(w.input), "the blocking re-report is fixed");
  assert.deepEqual(r.result["deferred"], [], "and no longer deferred");
  assert.ok(!r.labels.includes("file"), "so nothing is filed");

  const lost = await run("pr-loop", { ...PR }, { ...START, "review r1": { findings: [w], judgedCorrect: [] }, "CI 1": green, file: null });
  assert.match(String(lost.result["status"]), /filing failed: the findings are in fromBase and deferred/);
  assert.doesNotMatch(String(lost.result["status"]), /filed, not fixed/);
});

test("pr-loop: a deferred input is RUN again by every later probe and review, and re-reported when a fix made it block", async () => {
  // round 1 defers a refusal's wording; fix r1 (for j) turns that refusal into a wrong answer. A reviewer that does
  // what its prompt says reports it again only if the prompt asks for it: the stub holds the prompt to that.
  const x = later({ input: "SELECT x FROM t" });
  const told = (c: Call) => {
    assert.ok(c.prompt.includes("SELECT x FROM t"), `"${c.opts.label}" is told the deferred input`);
    assert.match(c.prompt, /RUN each of them again at this head/, `"${c.opts.label}" is told to run it again`);
    assert.match(c.prompt, /report it again with that blocking severity/, `"${c.opts.label}" is told to re-report it when it blocks`);
    assert.doesNotMatch(c.prompt, /do NOT report again/i, `"${c.opts.label}" is never told not to report it, whatever it now answers`);
    assert.doesNotMatch(c.prompt, /deferred as non-blocking and filed/, `"${c.opts.label}" is not told it is filed: nothing is filed before finish`);
  };
  const r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [finding({ classKey: "j", input: "SELECT j_wrong FROM t" }), x], judgedCorrect: [] }, "fix r1": pushed("b"),
    "probe 2": (c: Call) => { told(c); return clean; },
    "review r2": (c: Call) => { told(c); return { findings: [{ ...x, severity: "wrong-answer" }], judgedCorrect: [] }; },
    "fix r2": pushed("c"), "review r3": clean, "CI 1": green,
  });
  assert.ok(r.prompt("fix r2").includes("SELECT x FROM t"), "the re-report is this PR's to fix");
  assert.deepEqual(r.result["deferred"], []);
  assert.ok(!r.labels.includes("file"), "and it is not filed");
});

test("pr-loop: 'filed' is read from the issues the File stage returns, class by class and source by source", async () => {
  const w = later({ input: "SELECT w FROM t" });
  const g = later({ input: "SELECT g FROM t", severity: "over-refusal", classKey: "gap" });
  const b = later({ origin: "base", input: "SELECT b FROM t", classKey: "on-base" });
  const go = (issues: unknown[]) => run("pr-loop", { ...PR }, { ...START, "review r1": { findings: [w, g, b], judgedCorrect: [] }, "CI 1": green, file: { issues } });
  const status = async (issues: unknown[]) => String((await go(issues)).result["status"]);

  // nothing returned: nothing is said filed, and every class is named as not filed
  let s = await status([]);
  assert.doesNotMatch(s, /non-blocking finding\(s\) of this PR filed/, s);
  assert.match(s, /non-blocking class\(es\) of this PR NOT filed: wording, gap: in deferred/, s);
  assert.match(s, /the base's class\(es\) NOT filed: on-base: in fromBase/, s);
  // some classes filed, others not: only the filed ones are said filed, with their issue
  s = await status([{ classKey: "wording", source: "deferred", issue: 980, action: "filed" }]);
  assert.match(s, /1 non-blocking finding\(s\) of this PR filed \(#980\), not fixed/, s);
  assert.match(s, /NOT filed: gap: in deferred/, s);
  // an issue of the other source does not file a class: 'base' issues for the deferred classes, and the reverse
  s = await status([
    { classKey: "wording", source: "base", issue: 981, action: "filed" }, { classKey: "gap", source: "base", issue: 982, action: "filed" },
    { classKey: "on-base", source: "deferred", issue: 983, action: "filed" },
  ]);
  assert.match(s, /NOT filed: wording, gap: in deferred/, s);
  assert.match(s, /the base's class\(es\) NOT filed: on-base/, s);
  // every class filed under its own source: nothing said not filed
  s = await status([
    { classKey: "wording", source: "deferred", issue: 984, action: "filed" }, { classKey: "gap", source: "deferred", issue: 985, action: "commented" },
    { classKey: "on-base", source: "base", issue: 986, action: "filed" },
  ]);
  assert.match(s, /2 non-blocking finding\(s\) of this PR filed \(#984, #985\), not fixed/, s);
  assert.doesNotMatch(s, /NOT filed/, s);
});

test("pr-loop: a fixer is told a severity it was not given, or one not known, is read as blocking", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START, "review r1": { findings: [finding({ input: "SELECT odd FROM t", severity: "cosmetic" }), finding({ input: "SELECT known FROM t", classKey: "other" })], judgedCorrect: [] },
    "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
  });
  assert.match(r.prompt("fix r1"), /\[class: some-class; cosmetic: not a known severity, read as blocking\]/);
  assert.match(r.prompt("fix r1"), /\[class: other; wrong-answer\]/);
});

test("pr-loop: a run that stops still files its deferred findings", async () => {
  const w = later({ input: "SELECT stop_deferred FROM t" });
  const many: Answers = { ...START, file: { issues: [] } };
  for (let i = 1; i <= 4; i++) many[`review r${i}`] = { findings: [finding({ classKey: `c${i}`, input: `q${i}` }), ...(i === 1 ? [w] : [])], judgedCorrect: [] };
  for (let i = 1; i <= 3; i++) many[`fix r${i}`] = pushed(String(i));
  const exits: Array<[string, Answers, RegExp]> = [
    ["MAX_ROUNDS", many, /^still 1 finding\(s\) after 4 rounds/],
    ["a review that fails", { ...START, "review r1": { findings: [finding({ classKey: "j", input: "j" }), w], judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": null, file: { issues: [] } }, /^review r2 failed/],
    ["a fix that pushes nothing", { ...START, "review r1": { findings: [finding({ classKey: "j", input: "j" }), w], judgedCorrect: [] }, "fix r1": pushed("a"), file: { issues: [] } }, /pushed nothing/],
    ["CI that never finishes", { ...START, "review r1": { findings: [w], judgedCorrect: [] }, "CI 1": { state: "timeout", detail: "" }, file: { issues: [] } }, /^CI not finished/],
  ];
  for (const [name, answers, stop] of exits) {
    const r = await run("pr-loop", { ...PR }, answers);
    assert.match(String(r.result["status"]), stop, name);
    assert.deepEqual(r.labels.slice(-2), ["file", "record"], `${name}: the File call happens, then the record`);
    assert.ok(r.prompt("file").includes(w.input), `${name}: the deferred finding is in the filing`);
    assert.match(String(r.result["status"]), /NOT filed: wording: in deferred/, `${name}: and an empty return is said not filed`);
  }
});

test("review-stats: a first review passes when it found nothing blocking; a finding with no severity (a record older than severity) blocks", () => {
  const rec = (o: Partial<ReviewRecord>): ReviewRecord => ({ pr: 1, designRounds: 1, probeRounds: 1, reviewRounds: 1, findings: [], ciFixes: 0, status: "reviewed", ...o });
  const block = (r: unknown) => "```json mason-review-record\n" + JSON.stringify(r) + "\n```";
  const s = stats([
    // only a non-blocking finding in round 1: passed the first review
    rec({ pr: 1, findings: [{ round: 1, stage: "review", classKey: "w", severity: "message" }] }),
    // the same, written apart as pr-loop writes it
    rec({ pr: 2, deferred: [{ round: 1, stage: "review", classKey: "w", severity: "over-refusal" }] }),
    // a blocking one: not passed
    rec({ pr: 3, reviewRounds: 2, findings: [{ round: 1, stage: "review", classKey: "j", severity: "regression" }, { round: 2, stage: "review", classKey: "j", severity: "regression" }] }),
    // a legacy record: no severity, so blocking; its round 2 was clean, so passed by the second
    rec({ pr: 4, reviewRounds: 2, findings: [{ round: 1, stage: "review", classKey: "j" }] }),
  ]);
  assert.equal(s.firstPass, 2 / 4, "PRs 1 and 2");
  assert.equal(s.bySecond, 3 / 4, "PRs 1, 2 and 4");
  // a severity is one of the nine, and a deferred finding is a non-blocking one
  assert.throws(() => parseRecords(block(rec({ findings: [{ round: 1, stage: "review", classKey: "k", severity: "cosmetic" as never }] }))), /severity is not one of/);
  assert.throws(() => parseRecords(block(rec({ deferred: [{ round: 1, stage: "review", classKey: "k", severity: "crash" }] }))), /deferred finding is not of a non-blocking severity/);
  assert.throws(() => parseRecords(block({ ...rec({}), deferred: {} })), /deferred is not an array/);
  assert.equal(parseRecords(block(rec({}))).length, 1, "a record with no deferred field still reads");
});

// ---------------------------------------------------------------- the review and the probe RUN statements at scale
// (Tom, 2026-11-01; docs/DESIGN.md "The independent review"): on issue 192, a review that only read the code passed an
// implementation that three checks of 300 to 500 statements each, run against Postgres and Mason side by side with the
// base beside them, found two regressions and about four new wrong answers in. They found them with forms nobody
// wrote and a sweep of the plain forms of each path the diff touched, batched through scripts/duck-repro.ts.

/** A script's `const <name> = [` … `]`, over several lines, evaluated. */
function arrayOf(name: string, constName: string): string[] {
  const m = new RegExp(`^const ${constName} = (\\[\\n[\\s\\S]*?\\n\\])$`, "m").exec(source(name));
  assert.ok(m, `${name}: ${constName} is declared as an array, one item a line`);
  return new Function(`return (${m[1]})`)() as string[];
}

test("pr-loop: one list of variant forms, each concrete synthetic SQL, reaches the probe and the full review", async () => {
  const forms = arrayOf("pr-loop", "VARIANT_FORMS");
  assert.ok(forms.length >= 7, "the forms issue 192's checks ran, at least");
  // every form issue 192's checks found wrong answers with
  const all = forms.join("\n");
  for (const re of [/\bTABLE t\b/, /UNION ALL TABLE t ORDER BY 1 LIMIT 2/, /`VALUES \([^`]*\) UNION/, /WHERE false/, /char\(\d+\)/, /LIMIT NULL/, /LIMIT -1/, /OFFSET -1/,
    /c \/ \d+ FROM t UNION ALL SELECT a FROM t/, /FROM \(SELECT c \/ \d+ AS x FROM t\) s/, /WITH q AS \(SELECT c \/ \d+ AS x FROM t\)/]) {
    assert.match(all, re, `a variant form matches ${re}`);
  }
  for (const v of forms) {
    // concrete SQL: each form gives at least one statement, in backticks
    const sql = [...v.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    assert.ok(sql.length > 0 && sql.every((s) => /^(SELECT|TABLE|VALUES|WITH|\()/.test(s)), `"${v}" gives its statements in backticks`);
    // synthetic: only the tables the prompt declares (t, the empty e) and a CTE q, never another name
    for (const s of sql) {
      for (const m of s.matchAll(/\b(?:FROM|TABLE|JOIN)\s+([a-z_][a-z0-9_.]*)/gi)) assert.ok(["t", "e", "q"].includes(m[1]!), `"${s}" reads ${m[1]}, not a synthetic table`);
    }
  }
  const r = await run("pr-loop", { ...PR }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  for (const l of ["probe 1", "review r1", "probe 2", "review r2"]) {
    const p = r.prompt(l);
    for (const v of forms) assert.ok(p.includes(v), `"${l}" is given the variant form ${v}`);
    // the synthetic tables they run over, with the key duck-repro needs to sync a table
    assert.match(p, /t \(id int PRIMARY KEY, a int, b text, c numeric\(10,2\), d char\(4\)\)/, l);
    assert.match(p, /an empty table/, l);
  }
});

test("pr-loop: the probe and every review run their statements batched through duck-repro, at the head and the base, with a regression sweep", async () => {
  const r = await run("pr-loop", { ...PR }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  for (const l of ["probe 1", "review r1", "review r2"]) {
    const p = r.prompt(l);
    assert.match(p, /node scripts\/duck-repro\.ts <ddl\.sql> <statements\.sql>/, `${l}: statements go through duck-repro`);
    assert.match(p, /lines holding only `--`/, `${l}: in files, as duck-repro reads them`);
    assert.match(p, /> <out> 2>&1/, `${l}: the output goes to a file`);
    assert.match(p, /grep -c '\^SAME'/, `${l}: and only the counts and the differences are read`);
    assert.match(p, /grep -A2 '\^DIFFER'/, l);
    assert.match(p, /at the head and at the base/, l);
    assert.match(p, /REGRESSION SWEEP/, `${l}: the regression sweep`);
    assert.match(p, /WITHOUT the new feature/, l);
    assert.match(p, /SAME at the base and DIFFER at the head is blocking: severity regression/, l);
    assert.match(p, /never more than \d+ tool calls/, `${l}: the work has a bound`);
  }
  assert.match(r.prompt("review r1"), /hundreds of statements/, "a full review aims for hundreds");
  assert.match(r.prompt("review r2"), /a narrower set/, "a re-check runs a narrower set");
  assert.doesNotMatch(r.prompt("review r2"), /hundreds of statements/);
  assert.doesNotMatch(r.prompt("review r1"), /About 40 tool calls/, "the reading review's bound is raised to fit");
});

test("pr-loop: the probe's and the review's schema count the statements run and matched, and the Review record carries them", async () => {
  const r = await run("pr-loop", { ...PR }, {
    ...START,
    "probe 1": { ...f("p"), statementsRun: 120, statementsMatched: 117 }, "probe fix 1": pushed("b"),
    "probe 2": { ...clean, statementsRun: 40, statementsMatched: 40 },
    "review r1": { ...f("a"), statementsRun: 340, statementsMatched: 331 }, "fix r1": pushed("c"),
    "probe 3": { ...clean, statementsRun: 60, statementsMatched: 60 },
    "review r2": { ...clean, statementsRun: 80, statementsMatched: 80 }, "CI 1": green,
  });
  for (const l of ["probe 1", "review r1"]) {
    const schema = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[]; properties: Record<string, { type: string }> };
    for (const k of ["statementsRun", "statementsMatched"]) {
      assert.ok(schema.required.includes(k), `${l}: the schema requires ${k}`);
      assert.equal(schema.properties[k]!.type, "integer", `${l}: ${k} is a count`);
    }
  }
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual([rec.statementsRun, rec.statementsMatched], [120 + 40 + 340 + 60 + 80, 117 + 40 + 331 + 60 + 80]);
  assert.match(r.prompt("record"), /review 1: 1 finding\(s\): c-a[^\n]*; 340 statement\(s\) run, 331 matched/);
});

test("pr-loop: a review that ran no statement, or gave no valid count, is never a clean round: the run stops unreviewed, and issue-loop goes no further", async () => {
  const none = (o: Record<string, unknown> = {}) => ({ ...clean, statementsRun: 0, statementsMatched: 0, ...o });
  // the first review ran nothing (no psql, no Docker): no CI wait, no learn, a stop that says what to install
  let r = await run("pr-loop", { ...PR }, { ...START, "review r1": none({ judgedCorrect: ["psql: command not found"] }) });
  const status = String(r.result["status"]);
  assert.match(status, /^unreviewed: review r1 ran no statement for src\/duck\/plan\.ts \(it said: psql: command not found\)/);
  assert.doesNotMatch(status, /^reviewed/);
  for (const s of ["`psql` on PATH", "brew install libpq", "postgresql-client", "Docker running", "itEnv"]) assert.ok(status.includes(s), `the stop says what to install: ${s}`);
  assert.deepEqual(r.labels.slice(-2), ["CI read r1", "record"], "nothing after the review but its record");
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.equal(rec.status, status);
  assert.equal(rec.reviewRounds, 0, "an unrun round is no review round");
  assert.deepEqual([stats([rec]).reviewed, stats([rec]).neverReviewed, stats([rec]).firstPass], [0, 1, 0], "and review-stats never reads it as passed");

  // no valid count at all: missing, or not a count
  for (const bad of [undefined, "many", -1, 2.5]) {
    r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...clean, statementsRun: bad, statementsMatched: 0 } });
    assert.match(String(r.result["status"]), /^unreviewed: review r1 reported no valid count of the statements it ran/, String(bad));
  }
  // a re-check that ran nothing after a fix: the fix is unchecked, so no clean round either
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": none() });
  assert.match(String(r.result["status"]), /^unreviewed: review r2 ran no statement for src\/duck\/plan\.ts, so head bbbbbbb was read and never run/);
  const rec2 = parseRecords(r.prompt("record"))[0]!;
  assert.equal(rec2.reviewRounds, 1);
  assert.equal(stats([rec2]).bySecond, 0, "round 2 ran nothing, so the PR did not pass by the second");

  // issue-loop reads the stop as a stop
  const stop = await run("issue-loop", { issue: 300, tasks: TASKS }, SETUP, [() => ({ status, pr: 401, classes: {} })]);
  assert.equal(stop.flowCalls.length, 1, "the next task is not run");
  assert.match(String(stop.result["status"]), /^stopped at task 1: unreviewed/);

  // a probe is the author's check: one that ran nothing, or gave no count, is noted with what to install, and the review goes on
  r = await run("pr-loop", { ...PR }, { ...START, "probe 1": none(), "review r1": clean, "CI 1": green });
  assert.match(String(r.result["status"]), /^reviewed.*probe 1 ran no statement for src\/duck\/plan\.ts: it read the code only \(scripts\/duck-repro\.ts needs `psql` on PATH/);
  r = await run("pr-loop", { ...PR }, { ...START, "probe 1": { ...clean, statementsRun: undefined }, "review r1": clean, "CI 1": green });
  assert.match(String(r.result["status"]), /^reviewed.*probe 1 reported no valid count/);
});

// PR 245, round 2: the evidence a review owes is read from its diff's paths. The engine's and the listener's owe SQL
// statements; every other path (the CLI, the web page, a script, a workflow, docs) owes checks, what it changed run.
test("pr-loop: the evidence a review owes is read from its diff's paths: statements for the engine's, checks for every other", async () => {
  const cli = { ...clean, changedPaths: ["src/cli/command.ts", "tests/cli-commands.test.ts"], statementsRun: 0, statementsMatched: 0, checksRun: 6 };
  // a CLI-only diff, checked and with no statement: a clean review, reviewed and green
  let r = await run("pr-loop", { ...PR }, { ...START, "probe 1": cli, "review r1": cli, "CI 1": green });
  assert.match(String(r.result["status"]), /^reviewed, no open blocking finding/);
  assert.doesNotMatch(String(r.result["status"]), /ran no|read the code only/);
  let rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual([rec.reviewRounds, rec.statementsRun, rec.checksRun], [1, 0, 12]);
  assert.equal(stats([rec]).firstPass, 1);
  // so are a workflow-only diff (this PR) and a docs-only one
  for (const changedPaths of [[".claude/workflows/pr-loop.js", "scripts/review-stats.ts", "tests/workflows.test.ts"], ["docs/DESIGN.md", "CLAUDE.md"]]) {
    r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...cli, changedPaths }, "CI 1": green });
    assert.match(String(r.result["status"]), /^reviewed/, changedPaths.join(" "));
  }
  // a CLI-only diff that ran nothing is still no review, and the stop says what to run
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...cli, checksRun: 0 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no check for src\/cli\/command\.ts and 1 more path\(s\).*run what the diff changed at the head and the base: the `mason` command/);
  assert.doesNotMatch(String(r.result["status"]), /psql/, "a diff that owes no statement is not told to install psql");
  // an engine diff with checks but no statement still stops unreviewed
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...cli, changedPaths: ["src/duck/plan.ts"], checksRun: 9 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no statement for src\/duck\/plan\.ts.*`psql` on PATH/);
  rec = parseRecords(r.prompt("record"))[0]!;
  assert.equal(rec.reviewRounds, 0);
  // the listener, the source's reader and an engine test owe statements too; a diff of both kinds owes both
  for (const p of ["src/api/postgres/server.ts", "src/cdc/poll.ts", "src/cli/dev.ts", "tests/duck-wire.test.ts", "docs/POSTGRES-API.md"]) {
    r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...cli, changedPaths: [p] } });
    assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no statement/, p);
  }
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...cli, changedPaths: ["src/duck/plan.ts", "src/cli/command.ts"], statementsRun: 300, statementsMatched: 300, checksRun: 0 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no check for src\/cli\/command\.ts/);
  // the paths not said: what was owed is not known, so no review
  for (const changedPaths of [undefined, [], "src/cli/command.ts"]) {
    r = await run("pr-loop", { ...PR }, { ...START, "review r1": { ...cli, changedPaths } });
    assert.match(String(r.result["status"]), /^unreviewed: review r1 did not report the paths its diff changed/, JSON.stringify(changedPaths));
  }
  // the schema asks for both, and the prompt states both kinds and the paths that owe statements
  r = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  for (const l of ["probe 1", "review r1"]) {
    const schema = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[]; properties: Record<string, { type: string; description?: string }> };
    for (const k of ["checksRun", "changedPaths"]) assert.ok(schema.required.includes(k), `${l}: the schema requires ${k}`);
    assert.equal(schema.properties["checksRun"]!.type, "integer");
    assert.match(schema.properties["checksRun"]!.description!, /SQL statements are never counted here/);
    assert.match(r.prompt(l), /STATEMENTS, for a changed path matching any of [^\n]*`src\/duck\/\*\*`/, l);
    assert.match(r.prompt(l), /CHECKS, for every other changed path: RUN what it changed, at the head and at the base/, l);
  }
});

test("pr-loop: the paths that owe statements are the `paths:` of the engine's and the listener's rules files, and src/cdc/", () => {
  const listed = arrayOf("pr-loop", "STATEMENT_PATHS");
  const dir = path.join(ROOT, ".claude", "rules");
  const globsOf = (f: string) => {
    const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.ok(front, `${f} has front matter`);
    return [...front[1]!.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]!);
  };
  const files = fs.readdirSync(dir).filter((f) => /^duck-.*\.md$|^postgres-api\.md$/.test(f));
  assert.ok(files.length >= 10, "the engine's rules files and the listener's");
  const authority = new Set([...files.flatMap(globsOf), "src/cdc/**"]);
  // the same glob reading as the script's
  const re = (g: string) => new RegExp(`^${g.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
  for (const g of authority) assert.ok(listed.some((l) => g === l || re(l).test(g)), `${g} (a rules file's path) owes statements, but STATEMENT_PATHS does not cover it`);
  for (const l of listed) assert.ok(authority.has(l), `${l} is in STATEMENT_PATHS but in no engine or listener rules file`);
  // and nothing of the CLI's or the web page's own owes statements
  for (const f of ["cli.md", "web-ui.md"]) {
    for (const g of globsOf(f).filter((g) => !authority.has(g))) {
      assert.ok(!listed.some((l) => re(l).test(g)), `${g} (${f}) is made to owe statements`);
    }
  }
});

test("review-stats: it reads and prints the checks run on other paths, and a record without them still reads", () => {
  const rec = (o: Partial<ReviewRecord>): ReviewRecord => ({ pr: 1, designRounds: 1, probeRounds: 1, reviewRounds: 1, findings: [], ciFixes: 0, status: "reviewed", ...o });
  const block = (r: unknown) => "```json mason-review-record\n" + JSON.stringify(r) + "\n```";
  const [a] = parseRecords(block(rec({ pr: 2, statementsRun: 0, statementsMatched: 0, checksRun: 7 })));
  const [legacy] = parseRecords(block(rec({ pr: 3 })));
  assert.equal(a!.checksRun, 7);
  assert.throws(() => parseRecords(block({ ...rec({}), checksRun: 1.5 })), /checksRun is not a count/);
  const s = stats([a!, legacy!]);
  assert.deepEqual([s.checksRun, s.withChecks], [7, 1]);
  assert.match(render(s, 0, 0), /checks run on other paths: 7 over 1 PR\(s\) that counted them/);
  assert.match(render(stats([legacy!]), 0, 0), /checks run on other paths: none counted/);
});

test("review-stats: it reads and prints the statements run and matched, and a record without them still reads", () => {
  const rec = (o: Partial<ReviewRecord>): ReviewRecord => ({ pr: 1, designRounds: 1, probeRounds: 1, reviewRounds: 1, findings: [], ciFixes: 0, status: "reviewed", ...o });
  const block = (r: unknown) => "```json mason-review-record\n" + JSON.stringify(r) + "\n```";
  const [withCounts] = parseRecords(block(rec({ pr: 2, statementsRun: 400, statementsMatched: 390 })));
  assert.deepEqual([withCounts!.statementsRun, withCounts!.statementsMatched], [400, 390]);
  const [legacy] = parseRecords(block(rec({ pr: 3 })));
  assert.equal(legacy!.statementsRun, undefined, "a record older than the counts reads, without them");
  assert.throws(() => parseRecords(block({ ...rec({}), statementsRun: "many" })), /statementsRun is not a count/);
  assert.throws(() => parseRecords(block({ ...rec({}), statementsRun: 10, statementsMatched: 11 })), /statementsMatched is more than statementsRun/);
  assert.throws(() => parseRecords(block({ ...rec({}), statementsMatched: 3 })), /statementsMatched without statementsRun/);

  const s = stats([withCounts!, legacy!, rec({ pr: 4, statementsRun: 100, statementsMatched: 100 })]);
  assert.deepEqual([s.statementsRun, s.statementsMatched, s.withStatements], [500, 490, 2], "summed over the PRs whose record has them");
  const text = render(s, 0, 0);
  assert.match(text, /statements run by probes and reviews: 500 over 2 PR\(s\) that counted them, 490 matched Postgres \(98%\)/);
  assert.match(render(stats([legacy!]), 0, 0), /statements run by probes and reviews: none counted/);
});

test("pr-loop: Postgres for the statements is the itEnv file when given, else a throwaway postgres:18 of the stage's own, and its URL is never printed", async () => {
  const src = source("pr-loop");
  assert.match(src, /^\/\/ args: \{[^}\n]*\bitEnv\?/m, "the args line names itEnv");
  assert.match(src, /^\/\/ {3}itEnv: [^\n]*IT_POSTGRES_URL/m, "and the header says what it is");
  const ownPg = [/postgres:18/, /wal_level=logical/, /-e POSTGRES_PASSWORD /, /openssl rand -hex/, /127\.0\.0\.1:0:5432/, /docker rm -f -v "\$n"/, /docker inspect "\$n"` must fail/];
  const without = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  for (const l of ["probe 1", "review r1"]) {
    const p = without.prompt(l);
    for (const re of ownPg) assert.match(p, re, `${l}: without itEnv, a throwaway Postgres of its own (${re})`);
    assert.match(p, /Never print, echo or log the URL or its password/, l);
  }
  const given = await run("pr-loop", { ...PR, itEnv: "/srv/it.env" }, { ...START, "review r1": clean, "CI 1": green });
  for (const l of ["probe 1", "review r1"]) {
    const p = given.prompt(l);
    assert.match(p, /`\. \/srv\/it\.env`/, `${l}: the file is sourced`);
    assert.doesNotMatch(p, /docker run/, `${l}: and no container is started`);
    assert.match(p, /Never print, echo or log the URL or its password/, l);
  }
  // issue-loop passes it on to each pr-loop, as it does repo
  const { flowCalls } = await run("issue-loop", { issue: 300, tasks: TASKS, itEnv: "/srv/it.env" }, SETUP, [
    () => ({ status: "reviewed", pr: 401, classes: {} }), () => ({ status: "reviewed", pr: 402, classes: {} }),
  ]);
  assert.deepEqual(flowCalls.map((c) => c.args["itEnv"]), ["/srv/it.env", "/srv/it.env"]);
  assert.match(source("issue-loop"), /^\/\/ args: \{[^}\n]*\bitEnv\?/m, "issue-loop's args line names it too");
});

// ---------------------------------------------------------------- the race (Tom, 2026-11-01): two ways of running one
// PR through the loop, raced on issue 176 against pr-loop. On issue 192 one persistent Opus agent, sent the review's
// findings by message, finished in a third of the harness's time on less than half its Opus tokens, because a fix round
// rebuilt no context. pr-loop-slim keeps the harness and hands context on in a `## Handoff` PR comment; the
// pr-persistent skill keeps ONE implementer alive. Both keep pr-loop's review, which runs statements at scale.

/** A handoff, in the shape Tom named: what the author knows and the code does not say. */
const H1 = {
  decisions: [{ what: "the arm's type is read from Postgres's analysis", why: "the analysis already holds it" }],
  rejected: [], keyFiles: ["src/duck/plan.ts: rewriteSetOp"], risks: ["a char(n) arm beside a text one"],
};
const SLIM: Answers = { ...START, implement: { ...(START["implement"] as object), handoff: H1 } };
/** The one sentence pr-loop-slim's review adds to pr-loop's: the handoff is the author's report, never evidence. */
const NOT_THE_HANDOFF = " The PR's `## Handoff` comment is the author's account too: never read it.";

test("pr-loop-slim: no design stage, no design review and no probe; the rest of the loop is pr-loop's", async () => {
  const titles = meta("pr-loop-slim").phases.map((p) => p.title);
  for (const t of ["Design", "Design review", "Probe"]) assert.ok(!titles.includes(t), `meta declares no ${t} phase`);
  const src = source("pr-loop-slim");
  assert.doesNotMatch(src, /label: `(design|probe)/, "no design, design review or probe agent is called");

  const base = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t", atBase: "2" });
  const mine = finding({ classKey: "new-class", input: "SELECT mine FROM t" });
  const { result, calls, labels, prompt } = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
    "review r1": { findings: [base, mine], judgedCorrect: ["the cast of a text"] },
    "fix r1": pushed("b"),
    "review r2": { findings: [{ ...base, classKey: "base-class-reslugged" }], judgedCorrect: ["the fix"] },
    "CI 1": red,
    "CI fix 1": { ...pushed("c"), flake: false },
    "review r3": clean,
    "CI 2": green,
    file: { issues: [{ classKey: "base-class", source: "base", issue: 950, action: "filed" }] },
  });
  assert.deepEqual(labels, [
    "brief", "implement", "link", "review r1", "CI read r1", "fix r1", "review r2", "CI read r2",
    "learn", "learn check", "CI 1", "CI fix 1", "review r3", "CI read r3", "CI 2", "file", "record",
  ]);
  assert.match(String(result["status"]), /^reviewed, no open blocking finding/);
  assert.deepEqual(shapeOf(result), RESULT_KEYS, "the result is pr-loop's shape, so issue-loop can run either");
  assert.deepEqual([(result["designRounds"] as unknown[]).length, (result["probeRounds"] as unknown[]).length], [0, 0]);
  assert.deepEqual(Object.keys(result["classes"] as object), ["new-class"], "only this PR's classes, never the base's");
  assert.equal(prompt("file").split(base.input).length - 1, 1, "the base's finding is filed once");
  for (const c of calls.filter((c) => /^(fix|CI fix|learn|record)/.test(c.opts.label))) assert.ok(!c.prompt.includes(base.input), `"${c.opts.label}" was handed the base's finding`);
  for (const [l, status] of [["implement", "Implementing"], ["review r1", "In review"], ["fix r1", "Fixing"], ["CI 1", "CI / queued"], ["CI fix 1", "Fixing"]] as const) {
    assert.ok(prompt(l).includes(`scripts/board.ts status 301 "${status}"`), `"${l}" moves the card to ${status}`);
  }
  const opts = (l: string) => calls.find((c) => c.opts.label === l)!.opts;
  for (const c of calls) {
    assert.equal(c.opts.isolation === "worktree", /^(implement|fix|CI fix|learn$)/.test(c.opts.label), `"${c.opts.label}": every writer, and only a writer, works in a worktree of its own`);
    assert.equal(c.opts.model === "fable", /^review/.test(c.opts.label), `"${c.opts.label}": only reviews are Fable's`);
  }
  for (const l of ["brief", "implement", "fix r1", "CI fix 1"]) assert.deepEqual([opts(l).model, opts(l).effort], ["opus", "high"], l);
  for (const l of ["review r1", "review r2", "review r3"]) assert.equal(opts(l).effort, "medium", l);
  assert.ok(prompt("review r3").includes(`diff ${sha("f")} ${sha("c")}`), "the CI fix is re-checked narrowly, from the head before it");

  // the class rule, as pr-loop's
  const k = (o: Partial<Record<string, string>> = {}) => finding({ classKey: "k", ...o });
  let r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [k({ input: "a" }), k({ input: "b" })], judgedCorrect: [] },
    "fix r1 (class)": (c: Call) => { assert.match(c.prompt, /CLASS round/); return pushed("b"); }, "review r2": clean, "CI 1": green,
  });
  assert.ok(r.labels.includes("fix r1 (class)"), "a class twice in one review makes a class round");
  // severity: a non-blocking finding of the PR's is deferred and filed, never fixed
  r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [finding({ severity: "message", classKey: "wording", input: "SELECT later FROM t" })], judgedCorrect: [] },
    "CI 1": green, file: { issues: [{ classKey: "wording", source: "deferred", issue: 961, action: "filed" }] },
  });
  assert.ok(!r.labels.some((l) => l.startsWith("fix")), "a non-blocking finding is never fixed");
  assert.ok(r.prompt("file").includes("SELECT later FROM t"));
  // MAX_ROUNDS
  const many: Answers = { ...SLIM };
  for (let i = 1; i <= 4; i++) many[`review r${i}`] = f(`q${i}`);
  for (let i = 1; i <= 3; i++) many[`fix r${i}`] = pushed(String(i));
  r = await run("pr-loop-slim", { ...PR }, many);
  assert.match(String(r.result["status"]), /^still 1 finding\(s\) after 4 rounds/);
  // a review that ran nothing is no review, as pr-loop's
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...clean, statementsRun: 0, statementsMatched: 0 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no statement/);
});

test("pr-loop-slim: the implementer returns a structured handoff, pasted verbatim into every fix and carried forward from each", async () => {
  const H2 = { ...H1, decisions: [...H1.decisions, { what: "fix r1: the arm's type read from the analysis", why: "the guess missed char(4)" }], rejected: [{ what: "a cast in the rewrite", why: "it lost the scale" }] };
  const H3 = { ...H2, risks: ["a CI fix's own risk"] };
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H2 }, "review r2": f("b"), "fix r2": pushed("c"), "review r3": clean,
    "CI 1": red, "CI fix 1": { ...pushed("d"), flake: false, handoff: H3 }, "review r4": clean, "CI 2": green,
  });
  const verbatim = (h: unknown) => "```json\n" + JSON.stringify(h, null, 2) + "\n```";
  // the schema of every agent that writes code requires it, in the shape Tom named
  for (const l of ["implement", "fix r1", "CI fix 1"]) {
    const s = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[]; properties: Record<string, { required: string[]; properties: Record<string, { items?: { required?: string[] } }> }> };
    assert.ok(s.required.includes("handoff"), `${l} returns the handoff`);
    assert.deepEqual(s.properties["handoff"]!.required, ["decisions", "rejected", "keyFiles", "risks"], l);
    for (const k of ["decisions", "rejected"]) assert.deepEqual(s.properties["handoff"]!.properties[k]!.items!.required, ["what", "why"], `${l}: ${k} is [{ what, why }]`);
  }
  // pasted verbatim, and carried forward: the implementer's into fix r1, fix r1's into fix r2 (which returned none, so it
  // is kept, and said) and the CI fix, the CI fix's into the record's notes nowhere
  assert.ok(r.prompt("fix r1").includes(verbatim(H1)), "fix r1 is given the implementer's handoff, verbatim");
  assert.ok(r.prompt("fix r2").includes(verbatim(H2)) && !r.prompt("fix r2").includes(verbatim(H1)), "fix r2 is given fix r1's");
  assert.ok(r.prompt("CI fix 1").includes(verbatim(H2)), "fix r2 returned none: the one before is carried");
  assert.match(String(r.result["status"]), /fix r2 returned no whole handoff: the one before was carried forward/);
  for (const l of ["fix r1", "fix r2", "CI fix 1"]) {
    const p = r.prompt(l);
    assert.ok(p.indexOf("Read the HANDOFF first") >= 0 && p.indexOf("Read the HANDOFF first") < p.indexOf("Run `"), `"${l}" reads it before it works`);
    assert.match(p, /Return the handoff UPDATED[^\n]*add a decision for each thing you changed, with why/, `"${l}" returns it updated`);
    assert.match(p, /Before you change ANY design decision[^\n]*read rejected; if you do change one, say why in the handoff you return/, l);
    // its copy for people, written from the same object, in place
    assert.match(p, /write that same object as the PR's `## Handoff` comment, replacing its body in place/, l);
    assert.match(p, /never a second Handoff comment/, l);
    // it starts from the code the failure names and the handoff's keyFiles, and reads the whole diff only past them
    assert.match(p, /keyFiles[^\n]*Read the whole diff|keyFiles; read the whole diff/, `"${l}" starts from the code`);
    assert.match(p, /only where those do not explain/, l);
  }
  assert.match(r.prompt("fix r1"), /the files the failures name \(each one's `at:`\)/);
  assert.match(r.prompt("fix r1"), /at: plan\.ts:1/, "and the failure names its file");
  for (const l of ["fix r1", "CI fix 1"]) assert.equal(r.calls.find((c) => c.opts.label === l)!.opts.effort, "high", `${l}: the effort stays high`);
  // the implementer posts the copy for people, and returns the object
  const impl = r.prompt("implement");
  assert.match(impl, /## Handoff/);
  assert.match(impl, /gh pr comment/, "the copy is a PR comment, never a committed file");
  assert.match(impl, /written from the handoff object you return/);
  for (const s of ["### Decisions", "### Rejected", "### Key files", "### Risks"]) assert.ok(impl.includes(s), `the copy has ${s}`);
  // the implementer still writes its design note, before any code, into the PR body
  assert.match(impl, /## Design/);
  assert.match(impl, /before any code/);
  assert.match(impl, /AUTHORITY/);
  for (const l of ["review r1", "review r2"]) {
    assert.ok(r.prompt(l).includes(NOT_THE_HANDOFF), `"${l}" never reads the handoff`);
    assert.ok(!r.prompt(l).includes("Read the HANDOFF") && !r.prompt(l).includes("--comments"), l);
  }
  // an implementer that returned no handoff: the fixer reads the comment, and no prompt says undefined
  const none = await run("pr-loop-slim", { ...PR }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  assert.ok(none.prompt("fix r1").includes("gh pr view 900 --comments") && !none.prompt("fix r1").includes("```json"));
  assert.match(String(none.result["status"]), /the implementer returned no whole handoff/);

  // the author checks at scale before every push, with the review's own text: statements for the engine's paths, in
  // every variant form, and the regression sweep; checks for the others; the differences fixed, the counts reported
  const forms = arrayOf("pr-loop-slim", "VARIANT_FORMS");
  assert.deepEqual(forms, arrayOf("pr-loop", "VARIANT_FORMS"), "pr-loop's variant forms");
  for (const l of ["implement", "fix r1", "CI fix 1"]) {
    const p = r.prompt(l);
    assert.match(p, /CHECK AT SCALE before you push/, l);
    assert.match(p, /node scripts\/duck-repro\.ts <ddl\.sql> <statements\.sql>/, `${l}: in batches, through duck-repro`);
    assert.match(p, /at the head and at the base/, l);
    assert.match(p, /REGRESSION SWEEP[^\n]*WITHOUT the new feature/, `${l}: the regression sweep`);
    assert.match(p, /For every other changed path, CHECKS: RUN what it changed/, `${l}: the EVIDENCE split`);
    assert.match(p, /Fix what differs at the head and not at the base before you push/, l);
    assert.match(p, /Report statementsRun, statementsMatched and checksRun/, l);
    for (const v of forms) assert.ok(p.includes(v), `${l}: the variant form ${v}`);
    const s = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[] };
    for (const k of ["statementsRun", "statementsMatched", "checksRun"]) assert.ok(s.required.includes(k), `${l} returns ${k}`);
  }
  assert.match(r.prompt("implement"), /a hundred statements or more/);
  assert.match(r.prompt("fix r1"), /your fix's paths/);

  // a fixer is given the past: every earlier round with its findings and what it judged correct, beside the handoff
  const two = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [finding({ classKey: "a", input: "SELECT r1_found FROM t" })], judgedCorrect: ["r1-judged"] },
    "fix r1": { ...pushed("b"), statementsRun: 140, statementsMatched: 138, checksRun: 2, handoff: H1 },
    "review r2": { findings: [finding({ classKey: "b", input: "SELECT r2_found FROM t" })], judgedCorrect: [] }, "fix r2": { ...pushed("c"), handoff: H1 }, "review r3": clean, "CI 1": green,
  });
  const fix2 = two.prompt("fix r2");
  for (const s of ["### review r1", "SELECT r1_found FROM t", "r1-judged", "SELECT r2_found FROM t", verbatim(H1)]) assert.ok(fix2.includes(s), `fix r2 carries ${s}`);
  assert.match(two.prompt("record"), /fix r1: 140 statement\(s\) run, 138 matched, 2 check\(s\)/, "the record's text says what the author ran");
});

test("pr-loop-slim: a brief given in args skips the Brief stage, and Learn runs and is timed on its own", async () => {
  const given = { brief: "the shared brief", shapes: ["SELECT shared_shape FROM t"], tests: ["tests/duck-wire.test.ts --test-name-pattern shared"] };
  let r = await run("pr-loop-slim", { ...PR, brief: given }, { ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green });
  assert.equal(r.labels[0], "implement", "no Brief stage");
  assert.ok(!r.phases.includes("Brief"));
  assert.ok(r.prompt("implement").includes("the shared brief") && r.prompt("implement").includes("SELECT shared_shape FROM t"));
  assert.ok(r.prompt("review r1").includes("SELECT shared_shape FROM t"), "the review holds the shared brief's shapes");
  // learn and its check run, as pr-loop's, and each says its time
  assert.deepEqual(r.labels.filter((l) => l.startsWith("learn")), ["learn", "learn check"]);
  assert.match(r.prompt("learn"), /date -u \+%FT%TZ` as your first command and as your last/);
  assert.match(r.prompt("learn check"), /date -u \+%FT%TZ` and return its output as endedAt/);
  for (const [l, k] of [["learn", "startedAt"], ["learn", "endedAt"], ["learn check", "endedAt"]] as const) {
    assert.ok((r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[] }).required.includes(k), `${l} returns ${k}`);
  }
  assert.ok(!(r.calls.find((c) => c.opts.label === "learn")!.opts.schema as { required: string[] }).required.includes("handoff"), "learn's docs commit owes no handoff");
  r = await run("pr-loop-slim", { ...PR, brief: given }, {
    ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green,
    learn: { ...pushed("f"), startedAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:04:00Z" },
    "learn check": { files: [".claude/rules/duck-rewrite.md"], endedAt: "2026-11-01T10:05:00Z" },
  });
  assert.match(r.prompt("record"), /Learn: 2026-11-01T10:00:00Z to 2026-11-01T10:05:00Z, the learn check included/);
  // no finding, no learn, said so
  r = await run("pr-loop-slim", { ...PR, brief: given }, { ...SLIM, "review r1": clean, "CI 1": green });
  assert.match(r.prompt("record"), /Learn: not run/);
  // a brief arg that is not one stops the run, before any PR
  r = await run("pr-loop-slim", { ...PR, brief: { brief: "x" } }, {});
  assert.deepEqual(r.labels, []);
  assert.match(String(r.result["status"]), /^args\.brief is not a brief/);
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
});

test("pr-loop-slim: its review, re-check and CI read are pr-loop's word for word, and its Review record is pr-loop's shape", async () => {
  const common: Answers = { "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green };
  const full = await run("pr-loop", { ...PR }, { ...START, ...common });
  const slim = await run("pr-loop-slim", { ...PR }, { ...SLIM, ...common, "fix r1": { ...pushed("b"), handoff: H1 } });
  for (const l of ["review r1", "review r2", "CI read r1", "CI read r2", "CI 1"]) {
    const s = slim.prompt(l);
    if (l.startsWith("review")) assert.equal(s.split(NOT_THE_HANDOFF).length, 2, `"${l}" adds the handoff sentence once`);
    assert.equal(s.replace(NOT_THE_HANDOFF, ""), full.prompt(l), `"${l}" is pr-loop's prompt`);
  }
  const schemaOf = (x: typeof full, l: string) => x.calls.find((c) => c.opts.label === l)!.opts.schema;
  assert.deepEqual(schemaOf(slim, "review r1"), schemaOf(full, "review r1"), "the review returns pr-loop's FINDINGS");
  const [a, b] = [parseRecords(full.prompt("record"))[0]!, parseRecords(slim.prompt("record"))[0]!];
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), "the record block has pr-loop's keys");
  for (const k of ["pr", "reviewRounds", "findings", "deferred", "ciFixes", "status"] as const) assert.deepEqual(b[k], a[k], k);
  assert.deepEqual([b.designRounds, b.probeRounds], [0, 0], "no design round and no probe round");
  assert.equal(b.statementsRun, 2, "the reviews' statements alone");
  assert.match(slim.prompt("record"), /pr-loop-slim/, "the record's text names the process it came from");
  assert.equal(stats([b]).firstPass, 0);
  assert.equal(stats([b]).bySecond, 1, "review-stats reads it as it reads pr-loop's");
});

// ---------------------------------------------------------------- the pr-persistent skill: the race's first process
const SKILL = path.join(ROOT, ".claude", "skills", "pr-persistent", "SKILL.md");

test("the pr-persistent skill: valid frontmatter, pr-loop's review text rendered from pr-loop.js, and pr-loop's record block", async () => {
  assert.ok(fs.existsSync(SKILL), "the skill exists at .claude/skills/pr-persistent/SKILL.md");
  const text = fs.readFileSync(SKILL, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "the skill opens with frontmatter");
  const fields = Object.fromEntries([...front[1]!.matchAll(/^([a-z-]+): (.+)$/gm)].map((m) => [m[1]!, m[2]!]));
  assert.equal(fields["name"], "pr-persistent");
  assert.ok((fields["description"] ?? "").length > 40, "a description that says when to use it");
  for (const s of ["EVIDENCE", "VARIANT_FORMS", "SEVERITY_RULE", "FINDINGS", ".claude/workflows/pr-loop.js", "SendMessage", 'model: "opus"', 'effort: "high"', 'isolation: "worktree"',
    'model: "fable"', 'effort: "medium"', "Closes #", "scripts/board.ts status", "CLASS round", "--match-head-commit", "## Design", "tokens",
    // the implementer's own check at scale, and its handoff in the slim workflow's shape, kept as a PR comment too
    "PART=implement", "PART=fix", "## Handoff", "decisions", "rejected", "keyFiles", "risks",
    // learn, as in the slim workflow, checked from git and timed on its own
    "## What review probes", "git diff --no-renames --name-only", "Learn's own time"]) {
    assert.ok(text.includes(s), `the skill says ${s}`);
  }
  // the record block it shows parses as review-stats reads it, with the keys pr-loop's has
  const recs = parseRecords(text);
  assert.equal(recs.length, 1, "one record block, the template");
  const pr = await run("pr-loop", { ...PR }, { ...START, "review r1": clean, "CI 1": green });
  assert.deepEqual(Object.keys(recs[0]!).sort(), Object.keys(parseRecords(pr.prompt("record"))[0]!).sort());
  assert.deepEqual([recs[0]!.designRounds, recs[0]!.probeRounds], [0, 0]);

  // the render command prints pr-loop's review text exactly as pr-loop's review is given it
  const cmd = /```sh\n(# render-review-text[\s\S]*?)\n```/.exec(text);
  assert.ok(cmd, "the skill has the render command, in a ```sh block that begins `# render-review-text`");
  const loop = await run("pr-loop", { ...PR, repo: ROOT }, { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  const severity = /^const SEVERITY_RULE = "(.*)"$/m.exec(source("pr-loop"))![1]!;
  for (const [scale, label] of [["full", "review r1"], ["narrow", "review r2"]] as const) {
    const out = execFileSync("bash", ["-c", cmd[1]!], { env: { ...process.env, REPO: ROOT, BASE: "main", BRANCH: PR.branch, PART: "review", SCALE: scale, IT_ENV: "" }, encoding: "utf8" });
    const p = loop.prompt(label);
    const evidence = p.slice(p.indexOf("Run what you check"), p.indexOf("\nDo not edit or push."));
    assert.ok(evidence.length > 1000 && out.includes(evidence), `${scale}: the render prints the evidence text "${label}" is given`);
    assert.ok(p.includes(severity) && out.includes(severity), `${scale}: and SEVERITY_RULE`);
    assert.ok(out.includes(JSON.stringify(loop.calls.find((c) => c.opts.label === label)!.opts.schema)), `${scale}: and the FINDINGS schema`);
    for (const v of arrayOf("pr-loop", "VARIANT_FORMS")) assert.ok(out.includes(v), `${scale}: and the variant form ${v}`);
  }
  // and the author's own check at scale, as pr-loop-slim's implementer and fixers are given it
  const slim = await run("pr-loop-slim", { ...PR, repo: ROOT }, { ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green });
  for (const [part, label] of [["implement", "implement"], ["fix", "fix r1"]] as const) {
    const out = execFileSync("bash", ["-c", cmd[1]!], { env: { ...process.env, REPO: ROOT, BASE: "main", BRANCH: PR.branch, PART: part, IT_ENV: "" }, encoding: "utf8" }).trim();
    assert.match(out, /^CHECK AT SCALE before you push/, part);
    assert.ok(out.length > 1000 && slim.prompt(label).includes(out), `${part}: the render prints the check "${label}" is given in pr-loop-slim`);
  }
});
