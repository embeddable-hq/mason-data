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

type Opts = { label: string; phase?: string; model?: string; effort?: string; isolation?: string; schema?: unknown };
type Call = { prompt: string; opts: Opts };
type Run = (args: unknown, agent: unknown, phase: unknown, log: unknown, workflow: unknown) => Promise<unknown>;
type Meta = { name: string; description: string; phases: Array<{ title: string }> };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...params: string[]) => Run;

function load(name: string): Run {
  const src = fs.readFileSync(file(name), "utf8");
  assert.match(src, /^export const meta = /, `${name}: the script begins with \`export const meta\``);
  return new AsyncFunction("args", "agent", "phase", "log", "workflow", src.replace(/^export const meta/, "const meta"));
}

/** `meta`'s initializer, held to a pure literal (no identifier, call or substitution), then evaluated. */
function meta(name: string): Meta {
  const src = fs.readFileSync(file(name), "utf8");
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

/** A run of a script with stub agents: `answers[label]` is a value or a function of the call. */
async function run(name: string, args: Record<string, unknown>, answers: Record<string, unknown>,
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
  const result = await load(name)(args, agent, (t: string) => { phases.push(t); }, () => {}, workflow) as Record<string, unknown>;
  // every phase a run names, by phase() or on an agent, is one meta declares
  const titles = meta(name).phases.map((p) => p.title);
  for (const t of [...phases, ...calls.map((c) => c.opts.phase)]) assert.ok(t && titles.includes(t), `${name}: phase "${t}" is not in meta.phases (${titles.join(", ")})`);
  for (const c of calls) assert.doesNotMatch(c.prompt, /undefined|\[object Object\]/, `${name}: the prompt of "${c.opts.label}" says undefined`);
  return { result, calls, flowCalls, phases };
}

const sha = (c: string) => c.repeat(40);
const finding = (o: Partial<Record<string, string>>) => ({
  input: "SELECT 1", expected: "1", actual: "2", atBase: "1", origin: "this-pr", classKey: "some-class", classWhy: "why", where: "src/x.ts:1", ...o,
});
const PR = { issue: 301, parent: 300, title: "300 · a piece", base: "main", branch: "issue-300-a-piece", stackedOn: "", context: "the scope" };

test("both scripts parse as the harness loads them, with a pure-literal meta naming them, and none of the calls the harness forbids", () => {
  for (const name of ["pr-loop", "issue-loop"]) {
    assert.equal(typeof load(name), "function");
    meta(name);
    const src = fs.readFileSync(file(name), "utf8");
    assert.doesNotMatch(src, /Date\.now\(|Math\.random\(|new Date\(\s*\)/, `${name}: Date.now(), Math.random() and new Date() are not allowed in a Workflow script`);
    // the scripts run for anyone on the team: no path of one machine, and no scratch folder beside them
    assert.doesNotMatch(src, /\/Users\/|\/home\/|~\/|[A-Z]:\\\\|scratch/, `${name}: a home path or a scratch folder is written in the script`);
  }
});

test("pr-loop: a finding the base has is filed once and never fixed; the narrow re-check carries what was judged correct; only reviews are Fable's", async () => {
  const base = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t", atBase: "2" });
  const mine = finding({ classKey: "new-class", input: "SELECT mine FROM t" });
  const { result, calls } = await run("pr-loop", { ...PR }, {
    brief: { brief: "build it", shapes: ["SELECT a FROM t"], tests: ["tests/x.test.ts"] },
    implement: { pr: 900, head: sha("a"), summary: "done" },
    "review r1": { findings: [base, mine], judgedCorrect: ["the cast of a text"] },
    "fix r1": { pr: 900, head: sha("b"), summary: "fixed" },
    "review r2": { findings: [base], judgedCorrect: ["the fix"] },
    file: { issues: [{ classKey: "base-class", issue: 950, action: "filed" }] },
    "CI 1": { state: "failed", detail: "tests/x.test.ts: a test failed" },
    "CI fix 1": { pr: 900, head: sha("c"), summary: "CI fixed" },
    "CI 2": { state: "green", detail: "" },
  });
  assert.deepEqual(calls.map((c) => c.opts.label), ["brief", "implement", "review r1", "fix r1", "review r2", "file", "CI 1", "CI fix 1", "CI 2"]);
  const prompt = (label: string) => calls.find((c) => c.opts.label === label)!.prompt;

  for (const c of calls.filter((c) => /^(fix|CI fix)/.test(c.opts.label))) assert.ok(!c.prompt.includes(base.input), `"${c.opts.label}" was handed the base's finding`);
  assert.ok(prompt("fix r1").includes(mine.input));
  assert.equal(calls.filter((c) => c.opts.label === "file").length, 1);
  assert.equal(prompt("file").split(base.input).length - 1, 1, "the base's finding, met in both rounds, is filed once");
  assert.ok(prompt("review r2").includes("the cast of a text"), "the narrow re-check is told what the first review judged correct");
  assert.ok(prompt("CI 1").includes("gh pr checks") && !/gh pr checks[^`]*--watch/.test(prompt("CI 1")), "the CI wait is a gh pr checks loop, never --watch");

  for (const c of calls) {
    if (/^(implement|fix|CI fix)/.test(c.opts.label)) assert.equal(c.opts.isolation, "worktree", `"${c.opts.label}" writes code in a worktree of its own`);
    assert.equal(c.opts.model === "fable", c.opts.label.startsWith("review"), `"${c.opts.label}": only reviews are Fable's`);
  }
  for (const l of ["brief", "implement", "fix r1", "CI fix 1"]) assert.deepEqual([calls.find((c) => c.opts.label === l)!.opts.model, calls.find((c) => c.opts.label === l)!.opts.effort], ["opus", "high"], l);
  for (const l of ["review r1", "review r2"]) assert.equal(calls.find((c) => c.opts.label === l)!.opts.effort, "medium", l);
  for (const l of ["file", "CI 1"]) assert.equal(calls.find((c) => c.opts.label === l)!.opts.model, "sonnet", l);

  assert.match(String(result["status"]), /^reviewed/);
  assert.deepEqual(Object.keys(result["classes"] as object).sort(), ["base-class", "new-class"]);
  // without args.repo each agent is told how to find the repository; no prompt names a machine's path
  assert.ok(calls.every((c) => !/\/Users\/|\/home\//.test(c.prompt)));
  assert.ok(prompt("implement").includes("git rev-parse --path-format=absolute --git-common-dir"));
});

test("pr-loop: a finding of a class the stack already met makes the next fix a class round", async () => {
  const { calls } = await run("pr-loop", { ...PR, repo: "/srv/checkout", knownClasses: { "known-class": { count: 1, why: "met on the PR below" } } }, {
    brief: { brief: "build it", shapes: ["SELECT a FROM t"], tests: ["tests/x.test.ts"] },
    implement: { pr: 900, head: sha("a"), summary: "done" },
    "review r1": { findings: [finding({ classKey: "known-class" })], judgedCorrect: [] },
    "fix r1 (class)": (c: Call) => { assert.match(c.prompt, /CLASS round/); return { pr: 900, head: sha("b"), summary: "fixed" }; },
    "review r2": { findings: [], judgedCorrect: [] },
    "CI 1": { state: "green", detail: "" },
  });
  assert.ok(calls.some((c) => c.opts.label === "fix r1 (class)"));
  assert.ok(calls.find((c) => c.opts.label === "implement")!.prompt.includes("/srv/checkout/scripts/board.ts status 301"), "args.repo is the board's checkout");
  assert.ok(calls.every((c) => !c.prompt.includes("<repo>")), "with args.repo no prompt leaves the repository to be found");
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

test("issue-loop: a stacked task is based on the one before, its PR stacked on that PR, with that PR's classes", async () => {
  const firstClasses = { "met-below": { count: 2, why: "w" } };
  const { result, calls, flowCalls } = await run("issue-loop", { issue: 300, tasks: TASKS }, SETUP, [
    () => ({ status: "reviewed, ...", pr: 401, classes: firstClasses }),
    () => ({ status: "reviewed, ...", pr: 402, classes: { ...firstClasses, more: { count: 1, why: "w" } } }),
  ]);
  assert.deepEqual(calls.map((c) => c.opts.label), ["setup"]);
  assert.equal(calls[0]!.opts.model, "sonnet");
  assert.deepEqual(flowCalls.map((f) => f.spec), ["pr-loop", "pr-loop"], "the named workflow, by default");
  const [first, second] = flowCalls.map((f) => f.args);
  assert.deepEqual([first!["base"], first!["stackedOn"], first!["issue"]], ["main", "", 311]);
  assert.deepEqual([second!["base"], second!["stackedOn"], second!["issue"]], ["issue-300-a", "401", 312]);
  assert.deepEqual(second!["knownClasses"], firstClasses);
  for (const a of [first!, second!]) assert.ok(!("scratch" in a) && !("repo" in a), "no scratch folder, and no repo unless given");
  assert.match(String(result["status"]), /^every task reviewed/);
});

test("issue-loop: a pr-loop that does not end reviewed stops the loop with how to resume; args.prLoop is run by path", async () => {
  const { result, flowCalls } = await run("issue-loop", { issue: 300, tasks: TASKS, prLoop: "/x/pr-loop.js", repo: "/srv/checkout" }, SETUP, [
    () => ({ status: "CI not finished within the bound", pr: 401, classes: {} }),
  ]);
  assert.equal(flowCalls.length, 1);
  assert.deepEqual(flowCalls[0]!.spec, { scriptPath: "/x/pr-loop.js" });
  assert.equal(flowCalls[0]!.args["repo"], "/srv/checkout");
  assert.match(String(result["status"]), /^stopped at task 1/);
  assert.deepEqual((result["resume"] as Record<string, unknown>)["from"], 0);
});
