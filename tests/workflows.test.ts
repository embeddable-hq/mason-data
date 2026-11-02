import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";
import { BLOCKING, DEFERRED, parseRecords, recordsOfComment, render, stats, type ReviewRecord } from "../scripts/review-stats.ts";
import { authority, ENGINE_RULES, globRe, globsOf, HOST_RULES } from "../scripts/evidence-owed.ts";
import { deepShapes, PLAN_TIME_DEPTHS } from "./deep-chains.ts";

// The loop's one script, .claude/workflows/pr-loop-slim.js, runs CLAUDE.md "The loop" with agents, and the pr-persistent
// skill renders every prompt from it (issue 386 retired pr-loop.js and issue-loop.js). Nothing else reads it before a
// run, and a run costs hours, so this is its detector: it is loaded as the Workflow harness loads it (the leading `export const meta` made a `const`, the body an async function of args, agent,
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

/** The scripts that take one PR through the loop: pr-loop-slim alone, since pr-loop.js was retired (issue 386). */
const PR_LOOPS = ["pr-loop-slim"];

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
      const ran: Record<string, unknown> = { changedPaths: ["src/duck/plan.ts"], statementsRun: 1, statementsMatched: 1, checksRun: 0, checksOnly: [] };
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
/** A handoff, in the shape Tom named: what the author knows and the code does not say. */
const H1 = {
  decisions: [{ what: "the arm's type is read from Postgres's analysis", why: "the analysis already holds it" }],
  rejected: [], keyFiles: ["src/duck/plan.ts: rewriteSetOp"], risks: ["a char(n) arm beside a text one"],
};
/** A run's first two answers, the implementer's carrying its handoff, as pr-loop-slim's schema asks. */
const SLIM: Answers = { ...START, implement: { ...(START["implement"] as object), handoff: H1 } };
/** Two pieces of a split (issue 386): the second stacked on the first. */
const PIECES = [
  { title: "301 · schema", branch: "issue-301-schema", scope: "the schema", stacked: false, readFirst: "src/duck/plan.ts" },
  { title: "301 · reader", branch: "issue-301-reader", scope: "the reader", stacked: true, readFirst: "src/duck/sync.ts" },
];
/** A Brief that finds the issue too big for one PR, as its schema lets it answer. */
const SPLIT_BRIEF = { brief: "too big: two pieces", shapes: [], tests: [], split: PIECES };
const RESULT_KEYS = ["classes", "deferred", "designRounds", "filed", "fromBase", "head", "pr", "probeRounds", "rounds", "status"];
const shapeOf = (r: Result) => Object.keys(r).sort();
const green = { state: "green", detail: "" };
/** The stages most tests do not look at, answered as a clean run's. */
const DEFAULTS: Array<[RegExp, unknown]> = [
  [/^link$/, { linked: true, bodyFixed: false, detail: "listed 900" }],
  [/^CI read r\d+$/, green],
  [/^learn$/, pushed("f")],
  [/^learn check$/, { files: [".claude/rules/duck-rewrite.md"] }],
  [/^record$/, { url: "https://github.com/embeddable-hq/mason-data/pull/900#issuecomment-1" }],
];
/** The labels of the stages the older tests were written for: brief, implement, review, fix, CI and file. */
const core = (labels: string[]) => labels.filter((l) => !/^(design|link|probe|CI read|learn|record)/.test(l));

test("every script parses as the harness loads it, with a pure-literal meta naming them, and none of the calls the harness forbids", () => {
  assert.deepEqual(execFileSync("git", ["ls-files", ".claude/workflows"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n"), [".claude/workflows/pr-loop-slim.js"],
    "pr-loop-slim.js is the one workflow: pr-loop.js and issue-loop.js are retired (issue 386)");
  for (const name of PR_LOOPS) {
    assert.equal(typeof load(name), "function");
    meta(name);
    const src = source(name);
    assert.doesNotMatch(src, /Date\.now\(|Math\.random\(|new Date\(\s*\)/, `${name}: Date.now(), Math.random() and new Date() are not allowed in a Workflow script`);
    // the scripts run for anyone on the team: no path of one machine, and no scratch folder beside them
    assert.doesNotMatch(src, /\/Users\/|\/home\/|~\/|[A-Z]:\\\\|scratch/, `${name}: a home path or a scratch folder is written in the script`);
  }
  // a script cannot import, so the one table of signatures is written in each, and held equal here
  for (const name of PR_LOOPS) assert.deepEqual(signs(name), SIGNS, name);
});

test("pr-loop-slim: a finding the base has is filed once and never fixed, never counted as a class; a CI fix gets its narrow re-check", async () => {
  const base = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t", atBase: "2" });
  const mine = finding({ classKey: "new-class", input: "SELECT mine FROM t" });
  const { result, calls, labels, prompt } = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
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
    "brief", "implement", "link", "review r1", "CI read r1", "fix r1",
    "review r2", "CI read r2", "learn", "learn check", "CI 1", "CI fix 1", "review r3", "CI read r3", "CI 2", "file", "record",
  ]);

  for (const c of calls.filter((c) => /^(fix|CI fix|learn|record)/.test(c.opts.label))) assert.ok(!c.prompt.includes(base.input), `"${c.opts.label}" was handed the base's finding`);
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
    const writes = /^(implement|fix|CI fix|learn$)/.test(c.opts.label);
    assert.equal(c.opts.isolation === "worktree", writes, `"${c.opts.label}": every writer, and only a writer, works in a worktree of its own`);
    assert.equal(c.opts.model === "fable", /^review/.test(c.opts.label), `"${c.opts.label}": only reviews are Fable's`);
  }
  const opts = (l: string) => calls.find((c) => c.opts.label === l)!.opts;
  for (const l of ["brief", "implement", "fix r1", "CI fix 1"]) assert.deepEqual([opts(l).model, opts(l).effort], ["opus", "high"], l);
  assert.deepEqual([opts("learn").model, opts("learn").effort], ["opus", "medium"]);
  for (const l of ["review r1", "review r2", "review r3"]) assert.equal(opts(l).effort, "medium", l);
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

test("pr-loop-slim: each trigger of the class rule makes the next fix a class round, and a base finding never does", async () => {
  const k = (o: Partial<Record<string, string>> = {}) => finding({ classKey: "k", ...o });
  // twice in one review
  let r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [k({ input: "a" }), k({ input: "b" })], judgedCorrect: [] },
    "fix r1 (class)": (c: Call) => { assert.match(c.prompt, /CLASS round/); return pushed("b"); }, "review r2": clean, "CI 1": { state: "green", detail: "" },
  });
  assert.ok(r.labels.includes("fix r1 (class)"), "twice in one review");
  // across rounds
  r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [k({ input: "a" })], judgedCorrect: [] }, "fix r1": pushed("b"),
    "review r2": { findings: [k({ input: "b" })], judgedCorrect: [] }, "fix r2 (class)": pushed("c"), "review r3": clean, "CI 1": { state: "green", detail: "" },
  });
  assert.deepEqual(r.labels.filter((l) => l.startsWith("fix")), ["fix r1", "fix r2 (class)"], "across rounds");
  // carried in from the stack
  r = await run("pr-loop-slim", { ...PR, repo: "/srv/checkout", knownClasses: { k: { count: 1, why: "met on the PR below" } } }, {
    ...SLIM, "review r1": { findings: [k()], judgedCorrect: [] }, "fix r1 (class)": pushed("b"), "review r2": clean, "CI 1": { state: "green", detail: "" },
  });
  assert.ok(r.labels.includes("fix r1 (class)"), "carried in from the stack");
  assert.ok(r.prompt("implement").includes("/srv/checkout/scripts/board.ts status 301"), "args.repo is the board's checkout");
  assert.ok(r.calls.every((c) => !c.prompt.includes("<repo>")), "with args.repo no prompt leaves the repository to be found");
  // a base finding of k, in round 1 and twice over, never makes a round of k a class round
  r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [k({ origin: "base", input: "x" }), k({ origin: "base", input: "y" }), finding({ classKey: "j", input: "a" })], judgedCorrect: [] },
    "fix r1": pushed("b"), "review r2": { findings: [k({ input: "b" })], judgedCorrect: [] }, "fix r2": pushed("c"), "review r3": clean,
    "CI 1": { state: "green", detail: "" }, file: { issues: [] },
  });
  assert.deepEqual(r.labels.filter((l) => l.startsWith("fix")), ["fix r1", "fix r2"], "a base finding never triggers a class round");
  assert.deepEqual(Object.keys(r.result["classes"] as object).sort(), ["j", "k"]);
  assert.equal((r.result["classes"] as Record<string, { count: number }>)["k"]!.count, 1, "the base's two findings of k are not counted");
});

test("pr-loop-slim: every exit returns one shape, and the base's findings are filed at every exit", async () => {
  const base = finding({ origin: "base", classKey: "b", input: "SELECT on_base FROM t" });
  // MAX_ROUNDS: four reviews with findings, three fixes, then a stop that still files
  const many: Answers = { ...SLIM, file: { issues: [{ classKey: "b", source: "base", issue: 951, action: "filed" }] } };
  for (let i = 1; i <= 4; i++) many[`review r${i}`] = { findings: [finding({ classKey: `c${i}`, input: `q${i}` }), ...(i === 1 ? [base] : [])], judgedCorrect: [] };
  for (let i = 1; i <= 3; i++) many[`fix r${i}`] = pushed(String(i));
  let r = await run("pr-loop-slim", { ...PR }, many);
  assert.match(String(r.result["status"]), /^still 1 finding\(s\) after 4 rounds/);
  assert.deepEqual(r.labels.slice(-2), ["file", "record"], "the MAX_ROUNDS exit files the base's findings, then posts its record");
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);

  // a CI wait that returns nothing
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": null });
  assert.match(String(r.result["status"]), /^CI wait 1 returned nothing/);
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  assert.equal(r.result["head"], sha("a"));

  // a CI fix that moves no head, and one that says flake, end the stage: CI is not waited on again for the same failure
  for (const fix of [{ ...pushed("a"), flake: false }, { ...pushed("a"), flake: true }]) {
    r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": { state: "failed", detail: "flaky" }, "CI fix 1": fix });
    assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1"]);
    assert.match(String(r.result["status"]), fix.flake ? /flake/ : /pushed nothing/);
    assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  }

  // a fix round that moves no head ends the run too
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { findings: [finding({})], judgedCorrect: [] }, "fix r1": pushed("a") });
  assert.match(String(r.result["status"]), /pushed nothing/);

  // a brief that fails, before any PR
  r = await run("pr-loop-slim", { ...PR }, { brief: null });
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  assert.equal(r.result["pr"], null);
});

const red = { state: "failed", detail: "a test failed" };
const f = (input: string) => ({ findings: [finding({ classKey: `c-${input}`, input })], judgedCorrect: [] });

test("pr-loop-slim: the round bound is the PR's, counted through a CI fix's re-check", async () => {
  // two rounds before CI, two in a CI fix's re-check: the fourth is the PR's last, whatever call it falls in
  let r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false },
    "review r3": f("b"), "fix r3": pushed("d"), "review r4": f("c"),
  });
  assert.match(String(r.result["status"]), /^still 1 finding\(s\) after 4 rounds/);
  assert.equal((r.result["rounds"] as unknown[]).length, 4);
  assert.ok(!r.labels.includes("review r5"));
  // the bound already reached when a CI fix lands: no fifth review, and the status says the head was not re-checked
  r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": f("b"), "fix r2": pushed("c"), "review r3": f("c"), "fix r3": pushed("d"),
    "review r4": clean, "CI 1": red, "CI fix 1": { ...pushed("e"), flake: false },
  });
  assert.match(String(r.result["status"]), /^4 review rounds reached; head eeeeeee is not re-checked/);
  assert.equal(r.result["head"], sha("e"));
});

test("pr-loop-slim: the head, not the flag, says whether a CI fix pushed; the last CI fix's CI is read", async () => {
  // flake: true with a head that moved: it was pushed, so it is re-checked and its CI read
  let r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": clean, "CI 1": red, "CI fix 1": { ...pushed("b"), flake: true }, "review r2": clean, "CI 2": { state: "green", detail: "" },
  });
  assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1", "review r2", "CI 2"]);
  assert.match(String(r.result["status"]), /^reviewed/);
  assert.equal(r.result["head"], sha("b"));

  // three CI fixes: the third one's CI is waited on before "still red"
  r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": clean, "CI 1": red, "CI fix 1": { ...pushed("b"), flake: false }, "review r2": clean,
    "CI 2": red, "CI fix 2": { ...pushed("c"), flake: false }, "review r3": clean,
    "CI 3": red, "CI fix 3": { ...pushed("d"), flake: false }, "review r4": clean, "CI 4": red,
  });
  assert.equal(core(r.labels).at(-1), "CI 4", "the last CI fix's CI is read");
  assert.match(r.prompt("CI 4"), new RegExp(`at head ${"d".repeat(7)}`));
  assert.match(String(r.result["status"]), /^CI still red after 3 fixes/);
});

// ---------------------------------------------------------------- the first-pass rules (docs/DESIGN.md "The
// independent review": a design note reviewed before code, a probe before every review, CI read beside it, every
// round carried to the next fix, each class learnt as a probe, and the record that says how often a PR passes)

test("pr-loop-slim: every fix carries the note and every earlier round, labelled, with what each judged correct", async () => {
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
    "review r1": { findings: [finding({ classKey: "a", input: "SELECT r1_found FROM t" })], judgedCorrect: ["r1-judged"] },
    "fix r1": pushed("c"),
    "review r2": { findings: [finding({ classKey: "b", input: "SELECT r2_found FROM t" })], judgedCorrect: ["r2-judged"] },
    "fix r2": pushed("d"),
    "review r3": { findings: [finding({ classKey: "c", input: "SELECT r3_found FROM t" })], judgedCorrect: ["r3-judged"] },
    "fix r3": pushed("e"),
    "review r4": clean, "CI 1": green,
  });
  const fix3 = r.prompt("fix r3");
  for (const s of ["### review r1", "SELECT r1_found FROM t", "r1-judged", "### review r2", "SELECT r2_found FROM t", "r2-judged", "SELECT r3_found FROM t", "`## Design` (`node <repo>/scripts/gh-text.ts body 900`)"]) {
    assert.ok(fix3.includes(s), `fix r3 carries ${s}`);
  }
  assert.ok(fix3.indexOf("### review r1") < fix3.indexOf("### review r2"), "oldest first");
  assert.ok(r.prompt("fix r2").includes("### review r1") && !r.prompt("fix r2").includes("### review r2"), "a round is not its own earlier round");
  assert.ok(!r.prompt("fix r1").includes("### review r1"), "the first fix has no earlier round");
});

test("pr-loop-slim: CI is read beside each review, and its failure goes into that round's fix, in one push", async () => {
  let ciStarted = false;
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
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
  const unsure = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "CI read r1": null, "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  assert.doesNotMatch(unsure.prompt("fix r1"), /CI failed/);
});

test("pr-loop-slim: learn turns every finding of the PR into a review probe, before CI so CI covers it, and only when there was one", async () => {
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
    "review r1": { findings: [finding({ classKey: "a", input: "SELECT review_found FROM t" })], judgedCorrect: [] },
    "fix r1": pushed("c"), "review r2": { findings: [finding({ classKey: "b", input: "SELECT review2_found FROM t" })], judgedCorrect: [] },
    "fix r2": pushed("d"), "review r3": clean, "CI 1": green,
  });
  assert.deepEqual(r.labels.slice(-5), ["CI read r3", "learn", "learn check", "CI 1", "record"]);
  const learn = r.prompt("learn");
  for (const s of ["SELECT review_found FROM t", "SELECT review2_found FROM t", "PR 900", "## What review probes", "## Detector wanted", "synthetic"]) {
    assert.ok(learn.includes(s), `learn is told ${s}`);
  }
  assert.match(learn, /never a second bullet/);
  assert.match(r.prompt("CI 1"), new RegExp(`at head ${"f".repeat(7)}`), "CI waits on learn's commit");
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual(rec.findings, [
    { round: 1, stage: "review", classKey: "a", severity: "wrong-answer" }, { round: 2, stage: "review", classKey: "b", severity: "wrong-answer" },
  ]);
  assert.deepEqual(rec.deferred, []);
  assert.deepEqual([rec.designRounds, rec.probeRounds, rec.reviewRounds], [0, 0, 3]);

  // no finding anywhere: nothing to learn
  const none = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  assert.ok(!none.labels.includes("learn"));
  // a learn that fails is said, and the run goes on to CI
  const failed = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, learn: null, "CI 1": green });
  assert.match(String(failed.result["status"]), /^reviewed.*learn failed/);
});

test("pr-loop-slim: every exit with a PR posts one Review record, whose block review-stats reads", async () => {
  const exits: Array<[string, Answers]> = [
    ["green", { ...SLIM, "review r1": clean, "CI 1": green }],
    ["CI null", { ...SLIM, "review r1": clean, "CI 1": null }],
    ["review failed", { ...SLIM, "review r1": null }],
    ["learn outside the rules", { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "learn check": { files: ["src/duck/plan.ts"] } }],
    ["not linked", { ...SLIM, link: { linked: false, bodyFixed: true, detail: "listed none" } }],
  ];
  for (const [name, answers] of exits) {
    const r = await run("pr-loop-slim", { ...PR }, answers);
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
  const r = await run("pr-loop-slim", { ...PR }, { brief: null });
  assert.ok(!r.labels.includes("record"));
  // a record that is not posted is said
  const lost = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green, record: null });
  assert.match(String(lost.result["status"]), /the Review record was not posted$/);
});

test("pr-loop-slim: GitHub itself must say the PR closes its sub-issue, or the run stops", async () => {
  // linked: the run goes on, and the query asked is GitHub's
  let r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  assert.deepEqual(r.labels.slice(1, 4), ["implement", "link", "review r1"]);
  const q = r.prompt("link");
  assert.ok(q.includes("`gh issue view 301 --json closedByPullRequestsReferences`"), "the link is read from GitHub");
  assert.ok(q.includes("Closes #301") && q.includes("gh pr edit 900"), "an unlinked body is fixed, then asked again");
  // not linked after the fix: the run stops there, before any review
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, link: { linked: false, bodyFixed: true, detail: "listed none" } });
  assert.deepEqual(r.labels.slice(1), ["implement", "link", "record"]);
  assert.match(String(r.result["status"]), /^PR 900 is not linked to #301 after its body was fixed/);
  // no answer is "not known", never linked
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, link: null });
  assert.match(String(r.result["status"]), /whether PR 900 closes #301 is not known/);
  // a stacked PR: GitHub links only into the default branch, so its body's keyword is read
  r = await run("pr-loop-slim", { ...PR, base: "issue-300-a", stackedOn: "401" }, { ...SLIM, "review r1": clean, "CI 1": green });
  assert.ok(r.prompt("link").includes("stacked") && !r.prompt("link").includes("graphql"));
});

test("every .claude/rules/ file has a `## What review probes` section, which the author runs before each push and Learn writes", () => {
  const dir = path.join(ROOT, ".claude", "rules");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0);
  const missing = files.filter((f) => !/^## What review probes$/m.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(missing, [], "a rules file without the section gives the author nothing to run for its paths");
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

test("pr-loop-slim: Learn's commit is read from git, and a head that changed anything outside .claude/rules/ is never reported ready", async () => {
  const learnt: Answers = { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green };
  let r = await run("pr-loop-slim", { ...PR }, learnt);
  assert.deepEqual(r.labels.slice(-4), ["learn", "learn check", "CI 1", "record"]);
  assert.ok(r.prompt("learn check").includes(`diff --no-renames --name-only ${sha("b")} ${sha("f")}`), "the files are read from the commit range");
  assert.match(String(r.result["status"]), /^reviewed/);
  // a learn that touched a test: stopped before CI, at learn's head
  r = await run("pr-loop-slim", { ...PR }, { ...learnt, "learn check": { files: [".claude/rules/cli.md", "tests/workflows.test.ts"] } });
  assert.deepEqual(r.labels.slice(-2), ["learn check", "record"]);
  assert.match(String(r.result["status"]), /^learn's commit fffffff changed tests\/workflows\.test\.ts outside \.claude\/rules\//);
  assert.equal(r.result["head"], sha("f"));
  // the files could not be read: not known, never ready
  // the files could not be read, or no path was read of a head that moved: not known, never ready
  for (const check of [null, { files: [] }]) {
    r = await run("pr-loop-slim", { ...PR }, { ...learnt, "learn check": check });
    assert.match(String(r.result["status"]), /could not be read: whether it touched only \.claude\/rules\/ is not known/, JSON.stringify(check));
    assert.ok(!r.labels.includes("CI 1"), JSON.stringify(check));
  }
  // a rename from outside into .claude/rules/: both ends are paths the check reads, so its source stops the run
  r = await run("pr-loop-slim", { ...PR }, { ...learnt, "learn check": { files: [".claude/rules/moved.md", "src/duck/plan.ts"] } });
  assert.match(String(r.result["status"]), /changed src\/duck\/plan\.ts outside/);
});

test("pr-loop-slim: the Learn check's own git command prints both ends of a rename", async () => {
  // the command the prompt gives, run on a real repository where a file moved from src/ into .claude/rules/
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  const m = /`git (diff [^`]*) \S+ \S+`/.exec(r.prompt("learn check"));
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

test("pr-loop-slim: a red CI beside a clean review goes to the CI stage, which reads it and sends it to a CI fix", async () => {
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": clean, "CI read r1": { state: "failed", detail: "tests/workflows.test.ts: red" },
    "CI 1": { state: "failed", detail: "tests/workflows.test.ts: red" }, "CI fix 1": { ...pushed("b"), flake: false }, "review r2": clean, "CI 2": green,
  });
  assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1", "review r2", "CI 2"], "no review fix round for a clean review");
  assert.match(String(r.result["status"]), /^reviewed/);
});

// ---------------------------------------------------------------- a conflicting PR (issue 255): GitHub runs no
// pull_request workflow on a PR with a merge conflict, so "no checks reported" never ends there, and PRs 231 and 233
// waited to their deadline. The wait reads `mergeable` first, and a conflict is its own verdict.

/** The CI wait's chunk, as the CI stage's prompt gives it: the line that is one backticked command, scripts/ci-wait.ts
 * (issue 322: it was a shell loop the worktree guard refused in an isolated agent). */
function ciWaitOf(prompt: string): string {
  const m = /^`(node \S+\/scripts\/ci-wait\.ts \d+ \d+)`$/m.exec(prompt);
  assert.ok(m, "the CI prompt carries the wait's chunk on a line of its own");
  return m[1]!;
}
const CI_WAIT_SCRIPT = path.join(ROOT, "scripts", "ci-wait.ts");

type Step = { out: string; rc: number };
const NO_CHECKS: Step = { out: "no checks reported on the 'issue-300-a-piece' branch", rc: 1 };
const FAILING: Step = { out: "checks\tfail\t3m\thttps://github.com/embeddable-hq/mason-data/actions/runs/1/job/2", rc: 1 };
const view = (mergeable: string, mergeStateStatus: string): Step => ({ out: JSON.stringify({ mergeable, mergeStateStatus }), rc: 0 });

/** Runs the command in bash with a stub `gh` first on PATH (each subcommand answering its scripted steps in turn, the
 * last repeated; a step with `hang` never returns) and no pause between passes; returns its output, exit code, time and
 * the stub's call log, each call with the time it started. */
type Waited = { out: string; err: string; status: number | null; ms: number; first: string; views: string[]; checks: string[]; starts: number[]; t0: number };
function runWait(cmd: string, scenario: { view: Array<Step & { hang?: boolean }>; checks: Array<Step & { hang?: boolean }> }, bash = true): Waited {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wait-"));
  try {
    fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
    fs.writeFileSync(path.join(dir, "calls.log"), "");
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
const kind = a[0] === "pr" && a[1] === "view" ? "view" : a[0] === "pr" && a[1] === "checks" ? "checks" : "other";
fs.appendFileSync(dir + "/calls.log", kind + " " + Date.now() + " " + a.join(" ") + "\\n");
const steps = JSON.parse(fs.readFileSync(dir + "/scenario.json", "utf8"))[kind];
if (!steps) { process.stderr.write("stub gh: unexpected call " + a.join(" ")); process.exit(2); }
const n = fs.readFileSync(dir + "/calls.log", "utf8").split("\\n").filter((l) => l.startsWith(kind + " ")).length;
const s = steps[Math.min(n, steps.length) - 1];
if (s.hang) setInterval(() => {}, 1000);
else { process.stdout.write(s.out + "\\n"); process.exit(s.rc); }
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, CI_WAIT_INTERVAL_MS: "0" };
    const t0 = Date.now();
    const r = bash ? spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 60_000, env }) : spawnSync(process.execPath, [CI_WAIT_SCRIPT, ...cmd.split(" ").filter(Boolean)], { encoding: "utf8", timeout: 60_000, env });
    const ms = Date.now() - t0;
    assert.equal(r.error, undefined, `the wait ended within the test's bound: ${String(r.error)}`);
    const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).map((c) => c.split(" "));
    const line = (c: string[]) => [c[0], ...c.slice(2)].join(" ");
    return { out: r.stdout, err: r.stderr, status: r.status, ms, first: r.stdout.split("\n")[0]!, t0, starts: calls.map((c) => Number(c[1])),
      views: calls.filter((c) => c[0] === "view").map(line), checks: calls.filter((c) => c[0] === "checks").map(line) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("pr-loop-slim: the CI wait reads mergeable beside gh pr checks, and a conflicting PR is its own verdict at once", async () => {
  for (const name of PR_LOOPS) {
    // without repo the prompt names <repo>, as BOARD does; with it, the command is the checkout's own script, run as is
    const bare = await run(name, { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
    assert.equal(ciWaitOf(bare.prompt("CI 1")), "node <repo>/scripts/ci-wait.ts 900 540", `${name}: one plain command`);
    const r = await run(name, { ...PR, repo: ROOT }, { ...SLIM, "review r1": clean, "CI 1": green });
    const p = r.prompt("CI 1");
    const cmd = ciWaitOf(p);
    assert.equal(cmd, `node ${ROOT}/scripts/ci-wait.ts 900 540`, name);
    for (const s of ["gh pr view", "--json mergeable,mergeStateStatus", "CONFLICTING", "gh pr checks", "timeout set to 600000",
      "exits 0 (green), 3 (failed) or 4 (conflict)", "exit 8 is pending", "Any other exit (2 is a usage error, 1 the script's own failure) is \"couldn't tell\""]) assert.ok(p.includes(s), `${name}: the CI prompt says ${s}`);
    assert.match(p, /green, failed or conflict/, `${name}: conflict is a verdict the chunk ends on`);
    assert.ok(!cmd.includes("--watch") && !fs.readFileSync(CI_WAIT_SCRIPT, "utf8").includes('"--watch"'), `${name}: the chunk never uses --watch`);
    assert.doesNotMatch(p, /run_in_background|a foreground `sleep`/, `${name}: no fallback for a shell sleep the script does not have`);
    const schema = r.calls.find((c) => c.opts.label === "CI 1")!.opts.schema as { properties: { state: { enum: string[] } } };
    assert.deepEqual(schema.properties.state.enum, ["green", "failed", "timeout", "conflict"], `${name}: the CI schema's states`);

    // the prompt's own command, run verbatim by bash: no checks reported on a conflicting PR: conflict at once, in one pass
    let w = runWait(cmd, { view: [view("CONFLICTING", "DIRTY")], checks: [NO_CHECKS] });
    assert.match(w.first, /^PR 900: conflict\b/, `${name}: ${w.out}`);
    assert.equal(w.status, 4, `${name}: conflict exits 4`);
    assert.deepEqual([w.views.length, w.checks.length], [1, 1], `${name}: one pass`);
    assert.ok(w.views[0]!.includes("pr view 900 --json mergeable,mergeStateStatus"), w.views[0]);
    assert.match(w.out, /CONFLICTING/, "the mergeable read is printed for the record");
    // a finished run at the head, green or red, of a PR that conflicts: conflict, read before the checks' verdict
    w = runWait(cmd, { view: [view("CONFLICTING", "DIRTY")], checks: [{ out: "all passed", rc: 0 }] });
    assert.match(w.first, /^PR 900: conflict\b/, `${name}: a stale green is not ready: ${w.out}`);
    assert.equal(w.status, 4);
    w = runWait(cmd, { view: [view("CONFLICTING", "DIRTY")], checks: [FAILING] });
    assert.match(w.first, /^PR 900: conflict\b/, `${name}: a stale red is no CI failure: ${w.out}`);
    assert.equal(w.status, 4, "never failed");
    // MERGEABLE leaves the checks' logic as it was: no checks yet is a wait (BLOCKED is no verdict), then green
    w = runWait(cmd, { view: [view("MERGEABLE", "BLOCKED")], checks: [NO_CHECKS, NO_CHECKS, { out: "all passed", rc: 0 }] });
    assert.match(w.first, /^PR 900: green\b/, `${name}: ${w.out}`);
    assert.equal(w.status, 0, "green exits 0");
    assert.equal(w.checks.length, 3, `${name}: it waited two passes first`);
    // UNKNOWN is "couldn't tell": a wait, then the conflict at the next pass
    w = runWait(cmd, { view: [view("UNKNOWN", "UNKNOWN"), view("CONFLICTING", "DIRTY")], checks: [NO_CHECKS] });
    assert.match(w.first, /^PR 900: conflict\b/, `${name}: ${w.out}`);
    assert.equal(w.views.length, 2, `${name}: UNKNOWN waited one pass`);
    // a gh pr view that fails is "couldn't tell", never a verdict, whatever the checks say
    w = runWait(cmd, { view: [{ out: "error connecting to api.github.com", rc: 1 }, view("MERGEABLE", "CLEAN")], checks: [{ out: "pending", rc: 8 }, { out: "all passed", rc: 0 }] });
    assert.match(w.first, /^PR 900: green\b/, `${name}: ${w.out}`);
    assert.equal(w.views.length, 2, `${name}: the failed read waited one pass`);
    w = runWait(cmd, { view: [{ out: "HTTP 401", rc: 1 }, view("MERGEABLE", "CLEAN")], checks: [{ out: "all passed", rc: 0 }] });
    assert.equal(w.views.length, 2, `${name}: a green beside a failed read is not yet green`);
    assert.equal(w.status, 0);
    // DRAFT is no verdict: a draft gets CI
    w = runWait(cmd, { view: [view("MERGEABLE", "DRAFT")], checks: [{ out: "pending", rc: 8 }, { out: "all passed", rc: 0 }] });
    assert.match(w.first, /^PR 900: green\b/, `${name}: ${w.out}`);
    assert.equal(w.checks.length, 2, `${name}: DRAFT waited on pending`);
    // and a real failure on a mergeable PR is failed, as before
    w = runWait(cmd, { view: [view("MERGEABLE", "CLEAN")], checks: [FAILING] });
    assert.match(w.first, /^PR 900: failed \(last exit 1\)/, `${name}: ${w.out}`);
    assert.equal(w.status, 3, "failed exits 3");
    // an exit gh pr checks does not list is "couldn't tell": a wait, never green and never failed
    w = runWait(cmd, { view: [view("MERGEABLE", "CLEAN")], checks: [{ out: "usage", rc: 2 }, { out: "?", rc: 4 }, { out: "gh: not found", rc: 127 }, { out: "all passed", rc: 0 }] });
    assert.match(w.first, /^PR 900: green \(last exit 0\)/, `${name}: ${w.out}`);
    assert.equal(w.checks.length, 4, `${name}: exits 2, 4 and 127 were each a wait`);
    // mergeable is parsed, never grepped: another key order and spacing is the same field
    w = runWait(cmd, { view: [{ out: '{"mergeStateStatus":"DIRTY","mergeable":"CONFLICTING"}', rc: 0 }], checks: [NO_CHECKS] });
    assert.equal(w.status, 4, `${name}: ${w.out}`);
  }
});

test("ci-wait: bounded, a deadline no pass starts after, a gh that never returns killed, and its verdict exits never 1", () => {
  // pending for ever: exit 8 at the deadline, no pass started after it, three parts printed
  let w = runWait("900 2", { view: [view("MERGEABLE", "CLEAN")], checks: [{ out: "pending", rc: 8 }] }, false);
  assert.equal(w.status, 8, w.out + w.err);
  assert.match(w.first, /^PR 900: pending \(last exit 8\)$/);
  assert.match(w.out, /\nmergeable \(exit 0\): \{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"\}\npending\n$/, "its three parts");
  assert.ok(w.ms < 2000 + 3000, `within the bound and a call's kill: ${w.ms} ms`);
  for (const t of w.starts) assert.ok(t - w.t0 < 2000 + 1000, `a call started ${t - w.t0} ms in, past the 2 s deadline`);
  // a gh pr checks that never returns is killed at the deadline (gh, a Go program, ignores an alarm)
  w = runWait("900 3", { view: [view("MERGEABLE", "CLEAN")], checks: [{ out: "", rc: 0, hang: true }] }, false);
  assert.equal(w.status, 8, w.out + w.err);
  assert.ok(w.ms >= 2900 && w.ms < 3000 + 4000, `killed near its deadline: ${w.ms} ms`);
  assert.match(w.first, /^PR 900: pending \(last exit 137\)$/);
  assert.match(w.out, /\nmergeable \(exit 0\): [^\n]*MERGEABLE[^\n]*\n[^\n]*killed after \d+ s, past its bound/, "its three parts, the kill said");
  // usage: exit 2, one line naming the cap, gh never called
  for (const args of ["", "abc 10", "900 0", "900 -5", "900 x", "900 571", "900 10 extra"]) {
    w = runWait(args, { view: [view("MERGEABLE", "CLEAN")], checks: [{ out: "all passed", rc: 0 }] }, false);
    assert.equal(w.status, 2, `"${args}": ${w.err}`);
    assert.match(w.err, /^usage: node scripts\/ci-wait\.ts <pr> <seconds>: [^\n]*from 1 to 570[^\n]*\n$/, `"${args}": one usage line naming the cap`);
    assert.equal(w.views.length + w.checks.length, 0, `"${args}": gh is never called`);
  }
  // its verdicts' exit codes are its own, never Node's 1 (an uncaught error), and the cap fits the Bash tool's bound
  const src = fs.readFileSync(CI_WAIT_SCRIPT, "utf8");
  const verdicts = /const VERDICT = (\{[^}]*\})/.exec(src)?.[1];
  assert.ok(verdicts, "VERDICT is one object");
  assert.deepEqual(new Function(`return (${verdicts})`)(), { green: 0, failed: 3, conflict: 4, pending: 8 });
  assert.match(src, /^export const MAX_SECONDS = 570;$/m);
  assert.ok(570 + 2 * 1 + 10 < 600, "a chunk at the cap, its last call's grace and Node's start end inside 600000 ms");
});

// ---------------------------------------------------------------- a conflict CI reads is a stage, not an exit (issue
// 452): the run's conflict exit was a status nobody read, and a clean PR sat an hour. The class: a run's stop that needs
// another party, reported only in a result file nobody reads. The script merges the base itself, and resolves the case
// that recurs (release-notes/next.md, insertions on both sides); every other case stops with a status that begins
// `conflict:` and names the files, which the skills make the coordinator's ONE report at once.
const conflictCI = { state: "conflict", detail: "PR 900 conflicts with main" };
const mergedAt = (c: string, files = ["release-notes/next.md"]) => ({ state: "merged", head: sha(c), files, detail: `merged: ${c.repeat(7)}` });
const MERGE_OPTS = { model: "sonnet", effort: "low", isolation: "worktree" };
const MERGE_CMD = 'node scripts/merge-base.ts origin/main "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"';
const baseFound = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t" });
const FILED_BASE = { issues: [{ classKey: "base-class", source: "base", issue: 950, action: "filed" }] };
/** A run that merges its base once, then meets a conflict its merge cannot resolve: both merge answers' text is read. */
const MERGE_RUN: Answers = { ...SLIM, "review r1": clean, "CI 1": conflictCI, "merge 1": mergedAt("m"), "CI 2": conflictCI,
  "merge 2": { state: "conflict", head: sha("m"), files: ["src/duck/plan.ts"], detail: "conflict: src/duck/plan.ts" } };

test("pr-loop-slim: a conflict CI reads starts a merge stage on a fresh agent, never a CI fix, and CI runs again on the merged head", async () => {
  for (const name of PR_LOOPS) {
    const r = await run(name, { ...PR }, { ...SLIM, "review r1": { findings: [baseFound], judgedCorrect: [] }, "CI 1": conflictCI, "merge 1": mergedAt("m"), "CI 2": green, file: FILED_BASE });
    assert.deepEqual(core(r.labels), ["brief", "implement", "review r1", "CI 1", "merge 1", "CI 2", "file"], name);
    const call = r.calls.find((c) => c.opts.label === "merge 1")!;
    const { label: _l, schema: _s, phase, ...on } = call.opts;
    assert.equal(phase, "Merge", `${name}: the merge's phase`);
    assert.deepEqual(on, MERGE_OPTS, `${name}: a fresh Sonnet agent in a worktree of its own, never the implementer`);
    const p = call.prompt;
    for (const s of ["git checkout --detach origin/issue-300-a-piece", `\`${MERGE_CMD}\``, "`git push origin HEAD:issue-300-a-piece`", "`git ls-remote origin refs/heads/issue-300-a-piece`"]) {
      assert.ok(p.includes(s), `${name}: the merge prompt says ${s}`);
    }
    for (const cmd of commandsOf(p)) assert.deepEqual(unplain(cmd), [], `${name}: \`${cmd}\` is plain`);
    assert.ok(!r.labels.some((l) => /fix/.test(l)), `${name}: a conflict is never sent to a fix`);
    // the head decides: the run goes on at the merged head, and the status names the merge for the top session
    const status = String(r.result["status"]);
    assert.match(status, /^reviewed, no open blocking finding of this PR, CI green: ready for the merge decision/, status);
    for (const s of ["origin/main", "mmmmmmm", "release-notes/next.md kept both sides"]) assert.ok(status.includes(s), `${name}: the status names the merge (${s}): ${status}`);
    assert.match(r.prompt("CI 2"), /at head mmmmmmm/, `${name}: CI waits on the merged head`);
    assert.equal(r.result["head"], sha("m"));
    const rec = parseRecords(r.prompt("record"))[0]!;
    assert.equal(rec.ciFixes, 0, `${name}: a merge is no CI fix`);
    assert.equal(rec.status, status);
  }
});

test("pr-loop-slim: a merge that leaves the conflict open stops the run with a status that begins `conflict:` and names the files or the reason", async () => {
  for (const name of PR_LOOPS) {
    const common: Answers = { ...SLIM, "review r1": { findings: [baseFound], judgedCorrect: [] }, "CI 1": conflictCI, file: FILED_BASE };
    // another file conflicts: the files, the base and the way out, the top session's
    let r = await run(name, { ...PR }, { ...common, "merge 1": { state: "conflict", head: sha("a"), files: ["src/duck/plan.ts", "release-notes/next.md"], detail: "conflict: src/duck/plan.ts release-notes/next.md" } });
    let status = String(r.result["status"]);
    assert.match(status, /^conflict: PR 900 conflicts with main\b/, status);
    for (const s of ["src/duck/plan.ts", "release-notes/next.md", "the top session merges origin/main into issue-300-a-piece", "pushes, reads the merge, and CI runs again"]) assert.ok(status.includes(s), `${name}: ${s}: ${status}`);
    assert.ok(!r.labels.includes("CI 2") && !r.labels.some((l) => /fix/.test(l)), `${name}: no CI 2 and no fix: ${r.labels}`);
    assert.ok(r.labels.includes("file") && r.labels.includes("record"), `${name}: file and record still run`);
    assert.equal(parseRecords(r.prompt("record"))[0]!.status, status);
    // nothing to merge, by its state or by its head: GitHub read a conflict the merge did not find, and the top session looks
    for (const m of [{ state: "up-to-date", head: sha("a"), files: [], detail: "up to date" }, { ...mergedAt("a", []), detail: "merged: aaaaaaa" }]) {
      r = await run(name, { ...PR }, { ...common, "merge 1": m });
      status = String(r.result["status"]);
      assert.match(status, /^conflict: /, `${name} ${m.state}: ${status}`);
      assert.ok(status.includes("GitHub read a conflict the merge did not find") && status.includes("the top session looks"), `${name} ${m.state}: ${status}`);
      assert.ok(!r.labels.includes("CI 2"), `${name} ${m.state}: the head did not move, so no CI 2`);
    }
    // the agent failed: the conflict is still open, never reviewed
    r = await run(name, { ...PR }, { ...common, "merge 1": null });
    status = String(r.result["status"]);
    assert.match(status, /^conflict: /, status);
    assert.ok(status.includes("merge 1 failed") && status.includes("the conflict is still open"), status);
    // an answer that is not merged yet moved the branch: the head is the run's, and no CI reads an unreviewed push as ready
    r = await run(name, { ...PR }, { ...common, "merge 1": { state: "conflict", head: sha("z"), files: [], detail: "push failed" } });
    status = String(r.result["status"]);
    assert.match(status, /^conflict: [^]*moved the branch to zzzzzzz/, status);
    assert.equal(r.result["head"], sha("z"));
    // stacked: the base below, never main
    const s = await run(name, { ...PR, base: "issue-300-below", stackedOn: "899" }, { ...SLIM, "review r1": clean, "CI 1": { state: "conflict", detail: "conflicts with issue-300-below" },
      "merge 1": { state: "conflict", head: sha("a"), files: ["src/x.ts"], detail: "conflict: src/x.ts" } });
    assert.ok(s.prompt("merge 1").includes('`node scripts/merge-base.ts origin/issue-300-below "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`'), "a stacked PR merges the branch below");
    assert.doesNotMatch(s.prompt("merge 1"), /origin\/main\b/, "never main");
    const ss = String(s.result["status"]);
    assert.ok(ss.startsWith("conflict: PR 900 conflicts with issue-300-below") && ss.includes("merges origin/issue-300-below into issue-300-a-piece") && !ss.includes("origin/main"), ss);
  }
});

test("pr-loop-slim: every answer of a merge either starts CI at a new head or ends with a `conflict:` status, never reviewed and never a fix (issue 452)", async () => {
  const answers: Array<[string, unknown]> = [
    ["merged, a new head", mergedAt("m")],
    ["merged with no file resolved", mergedAt("n", [])],
    ["conflict", { state: "conflict", head: sha("a"), files: ["src/duck/plan.ts"], detail: "conflict: src/duck/plan.ts" }],
    ["up to date", { state: "up-to-date", head: sha("a"), files: [], detail: "up to date" }],
    ["merged, the head unchanged", mergedAt("a", [])],
    ["null", null],
  ];
  for (const name of PR_LOOPS) {
    for (const [what, m] of answers) {
      const r = await run(name, { ...PR }, { ...SLIM, "review r1": clean, "CI 1": conflictCI, "merge 1": m, "CI 2": green });
      const status = String(r.result["status"]);
      assert.ok(!r.labels.some((l) => /fix/.test(l)), `${name} ${what}: no fix`);
      if (r.labels.includes("CI 2")) {
        assert.doesNotMatch(r.prompt("CI 2"), /at head aaaaaaa/, `${name} ${what}: CI 2 runs at a new head`);
        assert.ok(status.includes(`merged origin/main into issue-300-a-piece at ${String((m as { head: string }).head).slice(0, 7)}`), `${name} ${what}: ${status}`);
      } else {
        assert.match(status, /^conflict: PR 900 conflicts with main\b/, `${name} ${what}: ${status}`);
        assert.doesNotMatch(status, /reviewed, no open blocking/, `${name} ${what}`);
        assert.ok(/src\/duck\/plan\.ts|did not find|failed/.test(status), `${name} ${what}: it names the files or the reason: ${status}`);
      }
    }
  }
});

test("pr-loop-slim: merges are bounded apart from CI fixes; a merge eats no CI fix", async () => {
  for (const name of PR_LOOPS) {
    // conflict after every merge: three merges, then the conflict status, never a fourth
    let r = await run(name, { ...PR }, { ...SLIM, "review r1": clean, "CI 1": conflictCI, "merge 1": mergedAt("b"), "CI 2": conflictCI, "merge 2": mergedAt("c"),
      "CI 3": conflictCI, "merge 3": mergedAt("d"), "CI 4": conflictCI });
    assert.deepEqual(core(r.labels).slice(3), ["CI 1", "merge 1", "CI 2", "merge 2", "CI 3", "merge 3", "CI 4"], name);
    const status = String(r.result["status"]);
    assert.match(status, /^conflict: [^]*still conflicting after 3 merges/, status);
    assert.equal(r.result["head"], sha("d"));
    // a merge, then three CI fixes: MAX_CI_FIXES untouched by the merge
    r = await run(name, { ...PR }, { ...SLIM, "review r1": clean, "CI 1": conflictCI, "merge 1": mergedAt("b"),
      "CI 2": red, "CI fix 1": { ...pushed("c"), flake: false }, "review r2": clean,
      "CI 3": red, "CI fix 2": { ...pushed("d"), flake: false }, "review r3": clean,
      "CI 4": red, "CI fix 3": { ...pushed("e"), flake: false }, "review r4": clean, "CI 5": red });
    assert.deepEqual(core(r.labels).filter((l) => /^CI fix/.test(l)), ["CI fix 1", "CI fix 2", "CI fix 3"], name);
    assert.match(r.prompt("CI 5"), /at head eeeeeee/);
    assert.match(String(r.result["status"]), /^CI still red after 3 fixes/);
    assert.equal(parseRecords(r.prompt("record"))[0]!.ciFixes, 3);
  }
});

test("pr-loop-slim: a conflict read beside a review stays a log line: never a CI failure in the fix, never a merge before the reviews are clean", async () => {
  for (const name of PR_LOOPS) {
    const f1 = await run(name, { ...PR }, {
      ...SLIM, "review r1": f("a"), "CI read r1": { state: "conflict", detail: "conflicts with main" },
      "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green,
    });
    assert.doesNotMatch(f1.prompt("fix r1"), /CI failed|conflicts with main/, `${name}: the fix is told no CI failure`);
    assert.ok(!f1.labels.some((l) => /^merge/.test(l)), `${name}: no merge beside a review`);
    assert.match(String(f1.result["status"]), /^reviewed/);
  }
  // the rules a person's wait follows say the same
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  const ciBullet = /^- \*\*A wait on CI is[\s\S]*?(?=^- \*\*)/m.exec(claude)?.[0] ?? "";
  assert.ok(ciBullet.includes("mergeable") && ciBullet.includes("CONFLICTING"), "CLAUDE.md's CI wait reads mergeable");
  const step5 = /^5\. \*\*Merge\.\*\*[\s\S]*?(?=^\*\*One process runs the loop\*\*)/m.exec(claude)?.[0] ?? "";
  assert.ok(step5.includes("--json state,mergeable"), "CLAUDE.md's merge wait reads mergeable");
  assert.ok(upNextText().includes("--json state,mergeable"), "the up-next skill's merge wait reads mergeable: the top session merges");
});

// ---------------------------------------------------------------- scripts/merge-base.ts, against real throwaway git
// repositories under os.tmpdir(), with no network: an "up" repository is origin, "work" a clone of it on a branch.
const MERGE_BASE = path.join(ROOT, "scripts", "merge-base.ts");
type MergeRepo = { dir: string; work: string; up: string; git: (cwd: string, ...args: string[]) => string; env: Record<string, string | undefined> };
function mergeRepo(base: Record<string, string>, main: Record<string, string>, branch: Record<string, string>): MergeRepo {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "merge-base-")));
  const cfg = path.join(dir, "gitconfig");
  fs.writeFileSync(cfg, "");
  // a config of its own, so a laptop's (commit.gpgsign, hooks) changes nothing
  const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const put = (root: string, files: Record<string, string>, msg: string) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", msg);
  };
  const up = path.join(dir, "up"), work = path.join(dir, "work");
  fs.mkdirSync(up);
  git(up, "init", "-q", "-b", "main");
  put(up, base, "base");
  git(dir, "clone", "-q", up, work);
  git(work, "checkout", "-q", "-b", "issue-1-piece");
  if (Object.keys(branch).length) put(work, branch, "the branch");
  if (Object.keys(main).length) put(up, main, "main moved");
  git(work, "fetch", "-q", "origin");
  return { dir, work, up, git, env };
}
function mergeBaseRun(r: MergeRepo, ...args: string[]): { status: number | null; out: string; err: string; first: string } {
  const p = spawnSync(process.execPath, [MERGE_BASE, ...args], { cwd: r.work, env: r.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(p.error, undefined, String(p.error));
  return { status: p.status, out: p.stdout, err: p.stderr, first: p.stdout.split("\n")[0]! };
}
const NOTES_BASE = "# Next release\n\n## What changes\n\n- base note\n\n## Upgrading\n\n- nothing\n";
const after = (line: string, add: string) => NOTES_BASE.replace(`${line}\n`, `${line}\n${add}`);
/** The tree is as clean as a finished merge leaves it, and no merge is in progress. */
function settled(r: MergeRepo, what: string): void {
  assert.equal(r.git(r.work, "status", "--porcelain", "--untracked-files=no"), "", `${what}: the tree is clean`);
  assert.ok(!fs.existsSync(path.join(r.work, ".git", "MERGE_HEAD")), `${what}: no merge in progress`);
}

test("merge-base: a merge with no conflict is committed with two parents and the trailer last; nothing to merge is exit 5", () => {
  let r = mergeRepo({ "src/base.ts": "base\n" }, { "src/a.ts": "a\n" }, { "src/b.ts": "b\n" });
  try {
    const before = r.git(r.work, "rev-parse", "HEAD").trim();
    const m = mergeBaseRun(r, "origin/main", "Co-Authored-By: X");
    assert.equal(m.status, 0, m.out + m.err);
    const head = r.git(r.work, "rev-parse", "HEAD").trim();
    assert.equal(m.first, `merged: ${head}`);
    assert.doesNotMatch(m.out, /resolved:/, "a clean merge resolved no file");
    assert.equal(r.git(r.work, "rev-list", "--parents", "-n", "1", "HEAD").trim(), `${head} ${before} ${r.git(r.work, "rev-parse", "origin/main").trim()}`, "two parents: the branch, then the base");
    const msg = r.git(r.work, "log", "-1", "--format=%B").trim();
    assert.match(msg, /^Merge origin\/main into the branch\n/);
    assert.ok(msg.endsWith("\nCo-Authored-By: X"), msg);
    assert.equal(fs.readFileSync(path.join(r.work, "src/a.ts"), "utf8") + fs.readFileSync(path.join(r.work, "src/b.ts"), "utf8"), "a\nb\n");
    settled(r, "clean merge");
    // the branch now holds origin/main: up to date, exit 5, no commit
    const again = mergeBaseRun(r, "origin/main", "Co-Authored-By: X");
    assert.equal(again.status, 5, again.out + again.err);
    assert.match(again.first, /^up to date\b/);
    assert.equal(r.git(r.work, "rev-parse", "HEAD").trim(), head, "no new commit");
    settled(r, "up to date");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
  // usage: no argument, or a ref that does not resolve: never 0, nothing committed, the tree clean
  r = mergeRepo({ "src/base.ts": "base\n" }, { "src/a.ts": "a\n" }, { "src/b.ts": "b\n" });
  try {
    const before = r.git(r.work, "rev-parse", "HEAD").trim();
    for (const args of [[], ["origin/nope"], ["origin/main", "trailer", "extra"]]) {
      const m = mergeBaseRun(r, ...args);
      assert.ok(m.status === 2 || m.status === 1, `${JSON.stringify(args)}: exit ${m.status}: ${m.err}`);
      assert.ok(m.err.trim().length > 0, `${JSON.stringify(args)}: it says why`);
      assert.equal(r.git(r.work, "rev-parse", "HEAD").trim(), before, `${JSON.stringify(args)}: nothing committed`);
      settled(r, JSON.stringify(args));
    }
    assert.equal(mergeBaseRun(r).status, 2, "no argument is a usage error");
    assert.match(mergeBaseRun(r, "origin/nope").err, /origin\/nope does not resolve/);
    // its verdicts' exit codes are its own, never Node's 1, and its doc says so
    const src = fs.readFileSync(MERGE_BASE, "utf8");
    assert.deepEqual(new Function(`return (${/const VERDICT = (\{[^}]*\})/.exec(src)![1]})`)(), { merged: 0, conflict: 4, upToDate: 5, usage: 2 });
    assert.match(src, /Any other exit \(1 is a git call that failed/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("merge-base: release-notes/next.md alone, insertions on both sides, keeps both; an edit of the same line on both sides is a conflict", () => {
  let r = mergeRepo({ "release-notes/next.md": NOTES_BASE }, { "release-notes/next.md": after("- base note", "- main note A\n- main note B\n") }, { "release-notes/next.md": after("- base note", "- branch note\n") });
  try {
    const m = mergeBaseRun(r, "origin/main", "Co-Authored-By: X");
    assert.equal(m.status, 0, m.out + m.err);
    assert.match(m.out, /^merged: [0-9a-f]{40}\nresolved: release-notes\/next\.md \(kept both sides\)\n$/);
    const text = fs.readFileSync(path.join(r.work, "release-notes/next.md"), "utf8");
    for (const line of ["- base note", "- main note A", "- main note B", "- branch note", "- nothing"]) {
      assert.equal(text.split("\n").filter((l) => l === line).length, 1, `${line} once: ${text}`);
    }
    assert.doesNotMatch(text, /^(<{7}|={7}|>{7})/m, "no conflict marker");
    assert.equal(r.git(r.work, "show", "HEAD:release-notes/next.md"), text, "the file committed is the file kept");
    const msg = r.git(r.work, "log", "-1", "--format=%B").trim();
    assert.match(msg, /release-notes\/next\.md: kept both sides/);
    assert.ok(msg.endsWith("\nCo-Authored-By: X"), msg);
    settled(r, "notes kept both sides");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
  // both sides edited the same base line: never a union of the two edits
  r = mergeRepo({ "release-notes/next.md": NOTES_BASE }, { "release-notes/next.md": NOTES_BASE.replace("- base note", "- base note, as main says") }, { "release-notes/next.md": NOTES_BASE.replace("- base note", "- base note, as the branch says") });
  try {
    const before = r.git(r.work, "rev-parse", "HEAD").trim();
    const m = mergeBaseRun(r, "origin/main", "Co-Authored-By: X");
    assert.equal(m.status, 4, m.out + m.err);
    assert.equal(m.first, "conflict: release-notes/next.md");
    assert.equal(r.git(r.work, "rev-parse", "HEAD").trim(), before, "HEAD unchanged");
    assert.equal(fs.readFileSync(path.join(r.work, "release-notes/next.md"), "utf8"), NOTES_BASE.replace("- base note", "- base note, as the branch says"), "the branch's file, as it was");
    settled(r, "same line edited");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("merge-base: another file conflicting aborts the merge, next.md not resolved on its own; the paths are read from git's index", () => {
  const r = mergeRepo({ "release-notes/next.md": NOTES_BASE, "src/x.ts": "one\ntwo\n" },
    { "release-notes/next.md": after("- base note", "- main note\n"), "src/x.ts": "ONE (main)\ntwo\n" },
    { "release-notes/next.md": after("- base note", "- branch note\n"), "src/x.ts": "ONE (branch)\ntwo\n" });
  try {
    const before = r.git(r.work, "rev-parse", "HEAD").trim();
    const m = mergeBaseRun(r, "origin/main", "Co-Authored-By: X");
    assert.equal(m.status, 4, m.out + m.err);
    assert.match(m.first, /^conflict: /);
    assert.deepEqual(m.first.slice("conflict: ".length).split(" ").sort(), ["release-notes/next.md", "src/x.ts"]);
    assert.equal(r.git(r.work, "rev-parse", "HEAD").trim(), before, "HEAD unchanged");
    assert.equal(fs.readFileSync(path.join(r.work, "release-notes/next.md"), "utf8"), after("- base note", "- branch note\n"), "next.md as the branch had it");
    settled(r, "another file");
    // the paths come from the index: the script never reads merge's printed text for them
    const src = fs.readFileSync(MERGE_BASE, "utf8");
    assert.match(src, /"--diff-filter=U"/);
    assert.doesNotMatch(src, /CONFLICT \(|Automatic merge failed/, "merge's text is never parsed");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("pr-loop-slim: the author is told to run the rules' review probes before every push", async () => {
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false }, "review r3": clean, "CI 2": green,
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

test("pr-loop-slim: every finding must carry a severity, blocking or not, and the two lists are review-stats' own", async () => {
  // a script cannot import: its lists are held equal to the ones review-stats reads records with
  assert.deepEqual(listOf("pr-loop-slim", "BLOCKING"), [...BLOCKING]);
  assert.deepEqual(listOf("pr-loop-slim", "DEFERRED"), [...DEFERRED]);
  assert.deepEqual([...BLOCKING], ["wrong-answer", "crash", "data-loss", "security", "regression"]);
  assert.deepEqual([...DEFERRED], ["message", "over-refusal", "docs", "quality"]);
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  for (const l of ["review r1"]) {
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

test("pr-loop-slim: a round with only non-blocking findings of the PR's is clean: filed as deferred, recorded, never fixed or learnt", async () => {
  const a = later({ input: "SELECT wording_a FROM t" });
  const b = later({ input: "SELECT wording_b FROM t" }); // the same class twice: no class round, since none is fixed
  const o = later({ input: "SELECT refused FROM t", severity: "over-refusal", classKey: "gap" });
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [a, b, o], judgedCorrect: [] }, "CI 1": green,
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
  const redRun = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [a], judgedCorrect: [] }, "CI read r1": red, "CI 1": red, "CI fix 1": { ...pushed("b"), flake: false },
    "review r2": clean, "CI 2": green, file: { issues: [] },
  });
  assert.deepEqual(core(redRun.labels), ["brief", "implement", "review r1", "CI 1", "CI fix 1", "review r2", "CI 2", "file"]);
});

test("pr-loop-slim: only a blocking finding of the PR's is fixed and counts toward a class round; the others never reach a fix", async () => {
  const k = later({ classKey: "k", input: "SELECT k_wording FROM t" });
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
    // round 1: one blocking of j, two non-blocking of k (which would make a class round if they counted)
    "review r1": { findings: [finding({ classKey: "j", input: "SELECT j_wrong FROM t" }), k, { ...k, input: "SELECT k_wording2 FROM t" }], judgedCorrect: [] },
    "fix r1": pushed("b"),
    // round 2: a blocking finding of k, the class round 1 met only as non-blocking; and k's first input met again
    "review r2": { findings: [finding({ classKey: "k", input: "SELECT k_wrong FROM t", severity: "crash" }), k], judgedCorrect: [] },
    "fix r2": pushed("c"),
    "review r3": clean, "CI 1": green, file: { issues: [] },
  });
  assert.deepEqual(r.labels.filter((l) => /^fix/.test(l)), ["fix r1", "fix r2"], "no class round: k's earlier findings did not block");
  for (const l of ["fix r1", "fix r2", "learn"]) {
    for (const s of ["SELECT k_wording FROM t", "SELECT k_wording2 FROM t"]) assert.ok(!r.prompt(l).includes(s), `"${l}" was handed the non-blocking ${s}`);
  }
  assert.ok(r.prompt("fix r1").includes("SELECT j_wrong FROM t") && r.prompt("fix r2").includes("SELECT k_wrong FROM t"));
  assert.deepEqual(Object.fromEntries(Object.entries(r.result["classes"] as Record<string, { count: number }>).map(([c, v]) => [c, v.count])), { j: 1, k: 1 });
  // a later round is told what is already deferred, and an input met twice is filed once
  assert.ok(r.prompt("review r2").includes("Already deferred as non-blocking") && r.prompt("review r2").includes("SELECT k_wording FROM t"));
  assert.equal(r.prompt("file").split("SELECT k_wording FROM t").length - 1, 1);
  assert.equal((r.result["deferred"] as unknown[]).length, 2);
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual(rec.findings.map((f) => [f.stage, f.round, f.classKey, f.severity]), [["review", 1, "j", "wrong-answer"], ["review", 2, "k", "crash"]]);
  assert.deepEqual(rec.deferred!.map((f) => [f.stage, f.round, f.classKey]), [["review", 1, "k"], ["review", 1, "k"]]);
});

test("pr-loop-slim: a finding with no severity, or one the script does not know, blocks; a base finding is the base's whatever its severity", async () => {
  for (const severity of [undefined, "cosmetic"]) {
    const { severity: _, ...bare } = finding({ input: "SELECT unsure FROM t" });
    const r = await run("pr-loop-slim", { ...PR }, {
      ...SLIM, "review r1": { findings: [severity ? { ...bare, severity } : bare], judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
    });
    assert.ok(r.labels.includes("fix r1"), `severity ${severity}: blocking`);
    assert.ok(!r.labels.includes("file"));
  }
  const base = later({ origin: "base", input: "SELECT base_wording FROM t" });
  const mine = later({ input: "SELECT mine_wording FROM t" });
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { findings: [base, mine], judgedCorrect: [] }, "CI 1": green, file: { issues: [] } });
  const file = r.prompt("file");
  const [onBase, ofPr] = [file.indexOf("## source 'base'"), file.indexOf("## source 'deferred'")];
  assert.ok(onBase >= 0 && ofPr > onBase, "two sections, kept apart");
  assert.ok(file.indexOf(base.input) > onBase && file.indexOf(base.input) < ofPr, "the base's finding is filed as the base's");
  assert.ok(file.indexOf(mine.input) > ofPr, "the PR's own is filed as deferred");
  assert.deepEqual((r.result["fromBase"] as Array<{ input: string }>).map((g) => g.input), [base.input]);
  assert.deepEqual((r.result["deferred"] as Array<{ input: string }>).map((g) => g.input), [mine.input]);
});

test("pr-loop-slim: a finding with no origin, or one the script does not know, is the PR's: fixed when it blocks, filed as deferred when not, never dropped", async () => {
  // issue 235: only the exact 'base' makes a finding the base's; any other origin, or none, is read as this PR's, as an
  // unknown severity is read as blocking, so no finding falls between fromBase, the fix and deferred
  const withOrigin = (f: ReturnType<typeof finding>, origin: unknown) => {
    const { origin: _, ...bare } = f;
    return origin === "missing" ? bare : { ...bare, origin };
  };
  const inputsOf = (r: Result, key: string) => (r[key] as Array<{ input: string }>).map((g) => g.input);
  const odd: Array<[unknown, string]> = [
    ["missing", "SELECT no_origin FROM t"], [null, "SELECT null_origin FROM t"], ["", "SELECT empty_origin FROM t"],
    ["Base", "SELECT cased_origin FROM t"], ["this_pr", "SELECT misspelt_origin FROM t"], ["upstream", "SELECT unknown_origin FROM t"],
  ];
  for (const name of PR_LOOPS) {
    const start = SLIM;
    // a blocking finding of an origin not known, or none, is fixed and counted toward its class
    for (const [origin, input] of odd) {
      const at = `${name}, origin ${JSON.stringify(origin)}`;
      const r = await run(name, { ...PR }, {
        ...start, "review r1": { findings: [withOrigin(finding({ input }), origin)], judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
      });
      assert.ok(r.labels.includes("fix r1") && r.prompt("fix r1").includes(input), `${at}: the fix is handed it`);
      assert.deepEqual(r.result["fromBase"], [], `${at}: never the base's`);
      assert.equal((r.result["classes"] as Record<string, { count: number }>)["some-class"]?.count, 1, `${at}: its class is counted`);
      assert.deepEqual(parseRecords(r.prompt("record"))[0]!.findings, [{ round: 1, stage: "review", classKey: "some-class", severity: "wrong-answer" }], `${at}: in the record`);
      assert.ok(!r.labels.includes("file"), `${at}: nothing to file`);
    }

    // a non-blocking finding of an origin not known is deferred, and filed as the PR's, never as the base's
    const w = finding({ input: "SELECT unknown_wording FROM t", origin: "upstream", severity: "message", classKey: "wording" });
    const c = await run(name, { ...PR }, { ...start, "review r1": { findings: [w], judgedCorrect: [] }, "CI 1": green, file: { issues: [] } });
    assert.ok(!c.labels.some((l) => /^fix r/.test(l)), `${name}: no fix round for a non-blocking finding`);
    assert.deepEqual(inputsOf(c.result, "deferred"), [w.input], `${name}: deferred`);
    assert.deepEqual(c.result["fromBase"], [], `${name}: never the base's`);
    assert.deepEqual(c.result["classes"], {}, `${name}: a non-blocking class is not counted`);
    const file = c.prompt("file");
    const [onBase, ofPr] = [file.indexOf("## source 'base'"), file.indexOf("## source 'deferred'")];
    assert.equal(file.split(w.input).length - 1, 1, `${name}: filed once`);
    assert.ok(ofPr >= 0 && file.indexOf(w.input) > ofPr, `${name}: filed under the deferred source`);
    assert.ok(onBase < ofPr || file.indexOf(w.input) < onBase, `${name}: never under the base's source`);
    assert.deepEqual(parseRecords(c.prompt("record"))[0]!.deferred, [{ round: 1, stage: "review", classKey: "wording", severity: "message" }], `${name}: the record lists it deferred`);

    // the control: the exact 'base' is the one origin that leaves the PR
    const onBaseF = finding({ origin: "base", input: "SELECT on_base FROM t", classKey: "on-base" });
    const e = await run(name, { ...PR }, {
      ...start, "review r1": { findings: [onBaseF, finding({ input: "SELECT mine FROM t" })], judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
      file: { issues: [] },
    });
    assert.deepEqual(inputsOf(e.result, "fromBase"), ["SELECT on_base FROM t"], `${name}: the base's finding is the base's`);
    assert.ok(e.prompt("fix r1").includes("SELECT mine FROM t") && !e.prompt("fix r1").includes("SELECT on_base FROM t"), `${name}: the fix is handed only the PR's`);
    assert.ok(!("on-base" in (e.result["classes"] as object)), `${name}: the base's class is never counted`);

    // every finding of a round lands in exactly one of fromBase, the fix and deferred, whatever its origin
    const all = (["base", "this-pr", "missing", "upstream"] as const).flatMap((origin, i) => [
      withOrigin(finding({ input: `SELECT block_${i} FROM t`, classKey: `block-${i}` }), origin),
      withOrigin(finding({ input: `SELECT later_${i} FROM t`, classKey: `later-${i}`, severity: i % 2 ? "message" : "over-refusal" }), origin),
    ]);
    const f = await run(name, { ...PR }, {
      ...start, "review r1": { findings: all, judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": clean, "CI 1": green, file: { issues: [] },
    });
    const [fromBase, deferred, fix] = [inputsOf(f.result, "fromBase"), inputsOf(f.result, "deferred"), f.prompt("fix r1")];
    for (const { input } of all) {
      const places = [fromBase.includes(input), fix.includes(input), deferred.includes(input)].filter(Boolean).length;
      assert.equal(places, 1, `${name}: ${input} is in exactly one of fromBase, the fix and deferred (in ${places})`);
    }
  }
});

test("pr-loop-slim: an input deferred once and found blocking later is fixed, never filed; a failed filing never says filed", async () => {
  const w = later({ input: "SELECT later_blocking FROM t" });
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [finding({ classKey: "j", input: "SELECT j_wrong FROM t" }), w], judgedCorrect: [] }, "fix r1": pushed("b"),
    "review r2": { findings: [{ ...w, severity: "regression" }], judgedCorrect: [] }, "fix r2": pushed("c"), "review r3": clean, "CI 1": green,
  });
  assert.ok(r.prompt("fix r2").includes(w.input), "the blocking re-report is fixed");
  assert.deepEqual(r.result["deferred"], [], "and no longer deferred");
  assert.ok(!r.labels.includes("file"), "so nothing is filed");

  const lost = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { findings: [w], judgedCorrect: [] }, "CI 1": green, file: null });
  assert.match(String(lost.result["status"]), /filing failed: the findings are in fromBase and deferred/);
  assert.doesNotMatch(String(lost.result["status"]), /filed, not fixed/);
});

test("pr-loop-slim: a deferred input is RUN again by every later review, and re-reported when a fix made it block", async () => {
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
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [finding({ classKey: "j", input: "SELECT j_wrong FROM t" }), x], judgedCorrect: [] }, "fix r1": pushed("b"),
    "review r2": (c: Call) => { told(c); return { findings: [{ ...x, severity: "wrong-answer" }], judgedCorrect: [] }; },
    "fix r2": pushed("c"), "review r3": clean, "CI 1": green,
  });
  assert.ok(r.prompt("fix r2").includes("SELECT x FROM t"), "the re-report is this PR's to fix");
  assert.deepEqual(r.result["deferred"], []);
  assert.ok(!r.labels.includes("file"), "and it is not filed");
});

test("pr-loop-slim: 'filed' is read from the issues the File stage returns, class by class and source by source", async () => {
  const w = later({ input: "SELECT w FROM t" });
  const g = later({ input: "SELECT g FROM t", severity: "over-refusal", classKey: "gap" });
  const b = later({ origin: "base", input: "SELECT b FROM t", classKey: "on-base" });
  const go = (issues: unknown[]) => run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { findings: [w, g, b], judgedCorrect: [] }, "CI 1": green, file: { issues } });
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

test("pr-loop-slim: a fixer is told a severity it was not given, or one not known, is read as blocking", async () => {
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM, "review r1": { findings: [finding({ input: "SELECT odd FROM t", severity: "cosmetic" }), finding({ input: "SELECT known FROM t", classKey: "other" })], judgedCorrect: [] },
    "fix r1": pushed("b"), "review r2": clean, "CI 1": green,
  });
  assert.match(r.prompt("fix r1"), /\[class: some-class; cosmetic: not a known severity, read as blocking\]/);
  assert.match(r.prompt("fix r1"), /\[class: other; wrong-answer\]/);
});

test("pr-loop-slim: a run that stops still files its deferred findings", async () => {
  const w = later({ input: "SELECT stop_deferred FROM t" });
  const many: Answers = { ...SLIM, file: { issues: [] } };
  for (let i = 1; i <= 4; i++) many[`review r${i}`] = { findings: [finding({ classKey: `c${i}`, input: `q${i}` }), ...(i === 1 ? [w] : [])], judgedCorrect: [] };
  for (let i = 1; i <= 3; i++) many[`fix r${i}`] = pushed(String(i));
  const exits: Array<[string, Answers, RegExp]> = [
    ["MAX_ROUNDS", many, /^still 1 finding\(s\) after 4 rounds/],
    ["a review that fails", { ...SLIM, "review r1": { findings: [finding({ classKey: "j", input: "j" }), w], judgedCorrect: [] }, "fix r1": pushed("b"), "review r2": null, file: { issues: [] } }, /^review r2 failed/],
    ["a fix that pushes nothing", { ...SLIM, "review r1": { findings: [finding({ classKey: "j", input: "j" }), w], judgedCorrect: [] }, "fix r1": pushed("a"), file: { issues: [] } }, /pushed nothing/],
    ["CI that never finishes", { ...SLIM, "review r1": { findings: [w], judgedCorrect: [] }, "CI 1": { state: "timeout", detail: "" }, file: { issues: [] } }, /^CI not finished/],
  ];
  for (const [name, answers, stop] of exits) {
    const r = await run("pr-loop-slim", { ...PR }, answers);
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

test("pr-loop-slim: one list of variant forms, each concrete synthetic SQL, reaches the author's check and every review", async () => {
  const forms = arrayOf("pr-loop-slim", "VARIANT_FORMS");
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
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  for (const l of ["implement", "review r1", "fix r1", "review r2"]) {
    const p = r.prompt(l);
    for (const v of forms) assert.ok(p.includes(v), `"${l}" is given the variant form ${v}`);
    // the synthetic tables they run over, with the key duck-repro needs to sync a table
    assert.match(p, /t \(id int PRIMARY KEY, a int, b text, c numeric\(10,2\), d char\(4\)\)/, l);
    assert.match(p, /an empty table/, l);
  }
});

test("pr-loop-slim: every review runs its statements batched through duck-repro, at the head and the base, with a regression sweep", async () => {
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  for (const l of ["review r1", "review r2"]) {
    const p = r.prompt(l);
    assert.match(p, /`node --env-file=<env file> <tree>\/scripts\/duck-repro\.ts <ddl\.sql> <statements\.sql> > <out> 2>&1`, one plain command/, `${l}: statements go through duck-repro, one plain command`);
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

test("pr-loop-slim: the review's schema counts the statements run and matched, and the Review record carries them", async () => {
  const r = await run("pr-loop-slim", { ...PR }, {
    ...SLIM,
    "review r1": { ...f("a"), statementsRun: 340, statementsMatched: 331 }, "fix r1": pushed("c"),
    "review r2": { ...clean, statementsRun: 80, statementsMatched: 80 }, "CI 1": green,
  });
  for (const l of ["review r1"]) {
    const schema = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[]; properties: Record<string, { type: string }> };
    for (const k of ["statementsRun", "statementsMatched"]) {
      assert.ok(schema.required.includes(k), `${l}: the schema requires ${k}`);
      assert.equal(schema.properties[k]!.type, "integer", `${l}: ${k} is a count`);
    }
  }
  const rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual([rec.statementsRun, rec.statementsMatched], [340 + 80, 331 + 80], "the reviews' statements alone");
  assert.match(r.prompt("record"), /review 1: 1 finding\(s\): c-a[^\n]*; 340 statement\(s\) run, 331 matched/);
});

test("pr-loop-slim: a review that ran no statement, or gave no valid count, is never a clean round: the run stops unreviewed", async () => {
  const none = (o: Record<string, unknown> = {}) => ({ ...clean, statementsRun: 0, statementsMatched: 0, ...o });
  // the first review ran nothing (no psql, no Docker): no CI wait, no learn, a stop that says what to install
  let r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": none({ judgedCorrect: ["psql: command not found"] }) });
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
    r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...clean, statementsRun: bad, statementsMatched: 0 } });
    assert.match(String(r.result["status"]), /^unreviewed: review r1 reported no valid count of the statements it ran/, String(bad));
  }
  // a re-check that ran nothing after a fix: the fix is unchecked, so no clean round either
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": none() });
  assert.match(String(r.result["status"]), /^unreviewed: review r2 ran no statement for src\/duck\/plan\.ts, so head bbbbbbb was read and never run/);
  const rec2 = parseRecords(r.prompt("record"))[0]!;
  assert.equal(rec2.reviewRounds, 1);
  assert.equal(stats([rec2]).bySecond, 0, "round 2 ran nothing, so the PR did not pass by the second");
});

// PR 245, round 2: the evidence a review owes is read from its diff's paths. The engine's and the listener's owe SQL
// statements; every other path (the CLI, the web page, a script, a workflow, docs) owes checks, what it changed run.
test("pr-loop-slim: the evidence a review owes is read from its diff's paths: statements for the engine's, checks for every other", async () => {
  const cli = { ...clean, changedPaths: ["src/cli/command.ts", "tests/cli-commands.test.ts"], statementsRun: 0, statementsMatched: 0, checksRun: 6 };
  // a CLI-only diff, checked and with no statement: a clean review, reviewed and green
  let r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": cli, "CI 1": green });
  assert.match(String(r.result["status"]), /^reviewed, no open blocking finding/);
  assert.doesNotMatch(String(r.result["status"]), /ran no|read the code only/);
  let rec = parseRecords(r.prompt("record"))[0]!;
  assert.deepEqual([rec.reviewRounds, rec.statementsRun, rec.checksRun], [1, 0, 6]);
  assert.equal(stats([rec]).firstPass, 1);
  // so are a workflow-only diff (this PR) and a docs-only one
  for (const changedPaths of [[".claude/workflows/pr-loop-slim.js", "scripts/review-stats.ts", "tests/workflows.test.ts"], ["docs/DESIGN.md", "CLAUDE.md"]]) {
    r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...cli, changedPaths }, "CI 1": green });
    assert.match(String(r.result["status"]), /^reviewed/, changedPaths.join(" "));
  }
  // a CLI-only diff that ran nothing is still no review, and the stop says what to run
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...cli, checksRun: 0 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no check for src\/cli\/command\.ts and 1 more path\(s\).*run what the diff changed at the head and the base: the `mason` command/);
  assert.doesNotMatch(String(r.result["status"]), /psql/, "a diff that owes no statement is not told to install psql");
  // an engine diff with checks but no statement still stops unreviewed
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...cli, changedPaths: ["src/duck/plan.ts"], checksRun: 9 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no statement for src\/duck\/plan\.ts.*`psql` on PATH/);
  rec = parseRecords(r.prompt("record"))[0]!;
  assert.equal(rec.reviewRounds, 0);
  // the listener, the source's reader and an engine test owe statements too; a diff of both kinds owes both. A shared
  // path (src/cli/dev.ts) owes them too while the review waives nothing (checksOnly [], the stub's default): issue 286's
  // cases are the test "a shared path …" below
  for (const p of ["src/api/postgres/server.ts", "src/cdc/poll.ts", "src/cli/dev.ts", "tests/duck-wire.test.ts", "docs/POSTGRES-API.md"]) {
    r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...cli, changedPaths: [p] } });
    assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no statement/, p);
  }
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...cli, changedPaths: ["src/duck/plan.ts", "src/cli/command.ts"], statementsRun: 300, statementsMatched: 300, checksRun: 0 } });
  assert.match(String(r.result["status"]), /^unreviewed: review r1 ran no check for src\/cli\/command\.ts/);
  // the paths not said: what was owed is not known, so no review
  for (const changedPaths of [undefined, [], "src/cli/command.ts"]) {
    r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...cli, changedPaths } });
    assert.match(String(r.result["status"]), /^unreviewed: review r1 did not report the paths its diff changed/, JSON.stringify(changedPaths));
  }
  // the schema asks for both, and the prompt states both kinds and the paths that owe statements
  r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  for (const l of ["review r1"]) {
    const schema = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[]; properties: Record<string, { type: string; description?: string }> };
    for (const k of ["checksRun", "changedPaths"]) assert.ok(schema.required.includes(k), `${l}: the schema requires ${k}`);
    assert.equal(schema.properties["checksRun"]!.type, "integer");
    assert.match(schema.properties["checksRun"]!.description!, /SQL statements are never counted here/);
    assert.match(r.prompt(l), /STATEMENTS, for a changed path matching any of [^\n]*`src\/duck\/\*\*`/, l);
    assert.match(r.prompt(l), /CHECKS, for every other changed path: RUN what it changed, at the head and at the base/, l);
  }
});

test("pr-loop-slim: the paths that owe statements are the `paths:` of the engine's and the listener's rules files, and src/cdc/", () => {
  const listed = arrayOf("pr-loop-slim", "STATEMENT_PATHS");
  const dir = path.join(ROOT, ".claude", "rules");
  const files = fs.readdirSync(dir);
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  assert.ok(files.filter((f) => ENGINE_RULES.test(f)).length >= 10, "the engine's rules files and the listener's");
  // the rules' front matter is read by scripts/evidence-owed.ts alone (one module reads it)
  const { statement, host } = authority(files, read);
  const owed = new Set(statement);
  for (const g of owed) assert.ok(listed.some((l) => g === l || globRe(l).test(g)), `${g} (a rules file's path) owes statements, but STATEMENT_PATHS does not cover it`);
  for (const l of listed) assert.ok(owed.has(l), `${l} is in STATEMENT_PATHS but in no engine or listener rules file`);
  // and nothing of the CLI's or the web page's own owes statements
  for (const f of HOST_RULES) {
    for (const g of globsOf(read(f)).filter((g) => !owed.has(g))) {
      assert.ok(!listed.some((l) => globRe(l).test(g)), `${g} (${f}) is made to owe statements`);
    }
  }
  // HOST_PATHS, which makes a path SHARED (issue 286), is cli.md's and web-ui.md's `paths:`, the same in both workflows
  assert.deepEqual(HOST_RULES, ["cli.md", "web-ui.md"]);
  for (const name of PR_LOOPS) {
    assert.deepEqual([...arrayOf(name, "HOST_PATHS")].sort(), [...host].sort(), `${name}: HOST_PATHS is the paths: of cli.md and web-ui.md`);
    assert.deepEqual(arrayOf(name, "STATEMENT_PATHS"), listed, `${name}: STATEMENT_PATHS is pr-loop's`);
  }
  const shared = listed.filter((l) => !l.includes("*") && host.some((g) => globRe(g).test(l)));
  assert.ok(shared.includes("src/cli/dev.ts"), "src/cli/dev.ts is shared");
  assert.ok(!shared.some((s) => /^src\/(duck|api|cdc)\//.test(s)), "no engine, listener or source-reader path is shared");
  assert.ok(!listed.filter((l) => /^src\/(duck|api|cdc)\//.test(l)).some((l) => host.some((g) => globRe(g).test(l))), "and no glob of theirs is");
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

test("pr-loop-slim: Postgres for the statements is the itEnv file when given, else a throwaway postgres:18 of the stage's own, and its URL is never printed", async () => {
  const src = source("pr-loop-slim");
  assert.match(src, /^\/\/ args: \{[^}\n]*\bitEnv\?/m, "the args line names itEnv");
  assert.match(src, /^\/\/ {3}itEnv: [^\n]*IT_POSTGRES_URL/m, "and the header says what it is");
  // the container's start and stop are scripts/review-postgres.ts (issue 322), whose own test holds its rules
  const ownPg = [/`node <repo>\/scripts\/review-postgres\.ts start`/, /postgres:18/, /wal_level=logical/, /password passed by the environment and never printed/, /`--env-file=<env file>`/,
    /`node <repo>\/scripts\/review-postgres\.ts stop <name>`, which removes it, checks that `docker inspect --format '\{\{\.State\.Status\}\}' <name>` then fails, and deletes the env file/];
  const without = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  for (const l of ["implement", "review r1"]) {
    const p = without.prompt(l);
    for (const re of ownPg) assert.match(p, re, `${l}: without itEnv, a throwaway Postgres of its own (${re})`);
    assert.match(p, /Never print, echo or log the URL or its password/, l);
  }
  const given = await run("pr-loop-slim", { ...PR, itEnv: "/srv/it.env" }, { ...SLIM, "review r1": clean, "CI 1": green });
  for (const l of ["implement", "review r1"]) {
    const p = given.prompt(l);
    assert.match(p, /`--env-file=\/srv\/it\.env`, never a shell's `\.` or `source`/, `${l}: the file is loaded by Node, never sourced`);
    assert.doesNotMatch(p, /docker run|review-postgres/, `${l}: and no container is started`);
    assert.match(p, /Never print, echo or log the URL or its password/, l);
  }
});

// ---------------------------------------------------------------- the one process (Tom, 2026-11-02; issue 386): the
// pr-persistent skill keeps ONE implementer alive and renders every prompt from pr-loop-slim.js, which hands context on
// in a `## Handoff` PR comment when run by the Workflow tool. On issue 192 one persistent Opus agent, sent the review's
// findings by message, finished in a third of the harness's time on less than half its Opus tokens, because a fix round
// rebuilt no context. The review is the retired pr-loop's, and runs statements at scale.

/** The one sentence pr-loop-slim's review adds to the retired pr-loop's: the handoff is the author's report, never evidence. */
const NOT_THE_HANDOFF = " The PR's `## Handoff` comment is the author's account too: never read it.";

// Issue 286: PR 280 changed one line of src/cli/dev.ts (a sweep of tunnel files), a path in both an engine rules file's
// `paths:` and cli.md's, and its review was made to run 332 statements that told it nothing. A SHARED path owes checks
// only when scripts/evidence-owed.ts found no hunk of it reaching the engine AND the review agreed (checksOnly);
// everything else, and every engine or listener path whatever is listed, still owes statements.
test("pr-loop-slim: a shared path owes checks only when the review waives it in checksOnly; an engine path never", async () => {
  const pr280 = { ...clean, changedPaths: ["src/cli/dev.ts", "src/cli/tunnel.ts", "tests/web-page.test.ts"], checksOnly: ["src/cli/dev.ts"], statementsRun: 0, statementsMatched: 0, checksRun: 5 };
  for (const name of PR_LOOPS) {
    const go = (review: object, extra: Answers = {}) =>
      run(name, { ...PR }, { ...SLIM, "review r1": review, "CI 1": green, ...extra });
    const status = async (review: object, extra: Answers = {}) => String((await go(review, extra)).result["status"]);
    // PR 280's shape: checks, no statement, a clean first review
    const r = await go(pr280);
    assert.match(String(r.result["status"]), /^reviewed, no open blocking finding/, name);
    assert.doesNotMatch(String(r.result["status"]), /ran no|read the code only/, name);
    const rec = parseRecords(r.prompt("record"))[0]!;
    assert.deepEqual([rec.reviewRounds, rec.statementsRun, rec.checksRun], [1, 0, 5], name);
    // nothing waived, or a waiver that cannot be read: statements are owed, as before, and the run does not crash
    for (const checksOnly of [[], undefined, "src/cli/dev.ts", [1]]) {
      assert.match(await status({ ...pr280, checksOnly }), /^unreviewed: review r1 ran no statement for src\/cli\/dev\.ts/, `${name} ${JSON.stringify(checksOnly)}`);
    }
    // an engine, listener or source-reader path is never waived, whatever is listed
    assert.match(await status({ ...pr280, changedPaths: ["src/duck/plan.ts"], checksOnly: ["src/duck/plan.ts"], checksRun: 9 }), /^unreviewed: review r1 ran no statement for src\/duck\/plan\.ts/, name);
    for (const p of ["src/api/postgres/server.ts", "src/cdc/poll.ts", "tests/duck-wire.test.ts", "docs/POSTGRES-API.md"]) {
      assert.match(await status({ ...pr280, changedPaths: [p], checksOnly: [p] }), /^unreviewed: review r1 ran no statement/, `${name} ${p}`);
    }
    // a shared path listed is checks to the workflow (the script never marks a .cjs checks: its own test holds that)
    assert.match(await status({ ...pr280, changedPaths: ["src/cli/mason.cjs"], checksOnly: ["src/cli/mason.cjs"] }), /^reviewed/, name);
    // a waived shared path owes checks, beside the statements an engine path owes
    assert.match(await status({ ...pr280, changedPaths: ["src/cli/dev.ts", "src/duck/sync.ts"], statementsRun: 300, statementsMatched: 300, checksRun: 0 }), /^unreviewed: review r1 ran no check for src\/cli\/dev\.ts/, name);
    // the schema requires checksOnly, and the prompt names the script and the override
    for (const l of ["review r1"]) {
      const schema = r.calls.find((c) => c.opts.label === l)!.opts.schema as { required: string[]; properties: Record<string, { type: string; items?: { type: string } }> };
      assert.ok(schema.required.includes("checksOnly"), `${name} ${l}: the schema requires checksOnly`);
      assert.deepEqual([schema.properties["checksOnly"]!.type, schema.properties["checksOnly"]!.items?.type], ["array", "string"]);
      assert.ok(r.prompt(l).includes("node scripts/evidence-owed.ts <base> <head>"), `${name} ${l}: names the script`);
      assert.match(r.prompt(l), /Leave a path out, and it owes statements/, `${name} ${l}`);
      assert.match(r.prompt(l), /except a shared path you report in checksOnly/, `${name} ${l}`);
    }
    assert.ok(r.prompt("implement").includes("node scripts/evidence-owed.ts origin/main HEAD"), `${name}: the author's SELF_CHECK names the script`);
    assert.match(r.prompt("implement"), /Leave a path out, and it owes statements[^\n]*\nFor each changed path[^\n]*except a shared path you report in checksOnly/);
  }
});

// scripts/evidence-owed.ts over a synthetic repo: a base, then one head a case, each a commit off the base.
test("evidence-owed: a shared path is decided by its hunks through the checker; anything it cannot settle owes statements", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-owed-test-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); };
  // the synthetic repo's own imports, spelt so the import guard (tests/conventions.test.ts) does not read them as this file's
  const [DUCK, TUNNEL] = ["../duck/store.ts", "./tunnel.ts"];
  const DEV = [
    `import { DuckStore } from "${DUCK}";`,
    `import { sweepTunnelFiles } from "${TUNNEL}";`,
    "",
    "// the run",
    "export function start(dir: string): string {",
    "  const store = new DuckStore();",
    '  const greeting = "hello";',
    "  return store.query('SELECT 1') + greeting + dir + String(sweepTunnelFiles);",
    "}",
    "",
  ].join("\n");
  try {
    g("init", "-q", "-b", "main");
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) g("config", k!, v!);
    put(".claude/rules/cli.md", '---\npaths:\n  - "src/cli/**"\n---\n# cli\n');
    put(".claude/rules/duck-engine.md", '---\npaths:\n  - "src/duck/**"\n  - "src/cli/dev.ts"\n  - "src/cli/mason.cjs"\n---\n# engine\n');
    put("tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", allowImportingTsExtensions: true, noEmit: true, strict: true } }));
    put("src/duck/store.ts", "export class DuckStore { query(sql: string) { return sql } }\n");
    put("src/cli/tunnel.ts", "export function sweepTunnelFiles(dir: string) { return dir }\n");
    put("src/cli/dev.ts", DEV);
    put("src/cli/mason.cjs", "module.exports = 1;\n");
    put("notes/README.md", "# readme\n");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    const base = g("rev-parse", "HEAD");
    const head = (edit: () => void): string => {
      g("checkout", "-q", "--detach", base);
      edit();
      g("add", "-A");
      g("commit", "-q", "-m", "head");
      return g("rev-parse", "HEAD");
    };
    const dev = (from: string, to: string) => () => put("src/cli/dev.ts", DEV.replace(from, to));
    const owed = (b: string, h: string) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "evidence-owed.ts"), b, h], { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return Object.fromEntries(r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { path: string; owes: string; why: string; declaredIn?: string }).map((o) => [o.path, o]));
    };
    const A = head(dev('  const greeting = "hello";\n', '  const greeting = "hello";\n  sweepTunnelFiles(dir);\n'));
    assert.equal(owed(base, A)["src/cli/dev.ts"]!.owes, "checks", "A: a call to a CLI function reaches no engine code");
    const B = head(dev("store.query('SELECT 1')", "store.query('SELECT 2')"));
    const b = owed(base, B)["src/cli/dev.ts"]!;
    assert.deepEqual([b.owes, b.declaredIn], ["statements", "src/duck/store.ts"], "B: an instance method resolves to the engine through the checker");
    assert.match(b.why, /src\/duck\/store\.ts/);
    const C = head(dev("  const store = new DuckStore();\n", ""));
    assert.equal(owed(base, C)["src/cli/dev.ts"]!.owes, "statements", "C: a removed line is resolved in the base");
    const D = head(dev("// the run\n", `// the run\nimport { DuckStore as S } from "${DUCK}";\nnew S();\n`));
    assert.deepEqual([owed(base, D)["src/cli/dev.ts"]!.owes, owed(base, D)["src/cli/dev.ts"]!.declaredIn], ["statements", "src/duck/store.ts"], "D: an alias is followed");
    const E = head(() => put("src/cli/dev.ts", DEV.replace("// the run", "// the run, started").replace('"hello"', '"hi"')));
    assert.equal(owed(base, E)["src/cli/dev.ts"]!.owes, "checks", "E: a comment and a string literal");
    const F = head(() => put("src/cli/mason.cjs", "module.exports = 2;\n"));
    const f = owed(base, F)["src/cli/mason.cjs"]!;
    assert.equal(f.owes, "statements", "F: a shared path that is not TypeScript");
    assert.match(f.why, /could not tell/);
    const G = head(() => fs.rmSync(path.join(repo, "src/cli/dev.ts")));
    assert.equal(owed(base, G)["src/cli/dev.ts"]!.owes, "statements", "G: deleted");
    assert.equal(owed(G, base)["src/cli/dev.ts"]!.owes, "statements", "G: added");
    const H = head(() => { put("src/duck/store.ts", "export class DuckStore { query(sql: string) { return sql + '' } }\n"); put("src/cli/tunnel.ts", "export function sweepTunnelFiles(dir: string) { return dir + '' }\n"); put("notes/README.md", "# readme 2\n"); });
    const h = owed(base, H);
    assert.deepEqual([h["src/duck/store.ts"]!.owes, h["src/cli/tunnel.ts"]!.owes, h["notes/README.md"]!.owes], ["statements", "checks", "checks"], "H");
    const I = head(dev('  const greeting = "hello";', "  const greeting = ;"));
    const i = owed(base, I)["src/cli/dev.ts"]!;
    assert.equal(i.owes, "statements", "I: a file that does not parse");
    assert.match(i.why, /could not tell[^\n]*could not parse/);
    // a commit that is not there: a failure, never a line of checks
    const bad = spawnSync(process.execPath, [path.join(ROOT, "scripts", "evidence-owed.ts"), "f".repeat(40), A], { cwd: repo, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /is not a commit/);
    // nothing left behind: no worktree, nothing written under the repo
    assert.equal(g("worktree", "list").split("\n").length, 1, "only the repo's own tree");
    g("checkout", "-q", "--detach", I);
    assert.equal(g("status", "--porcelain"), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("pr-loop-slim: no design stage, no design review and no probe; the author's note and check at scale take their place", async () => {
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
  assert.deepEqual(shapeOf(result), RESULT_KEYS, "one shape at every exit, which every reader of a result reads");
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

  // the class rule
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
  // a review that ran nothing is no review
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
  assert.ok(none.prompt("fix r1").includes("node <repo>/scripts/gh-text.ts pr 900") && !none.prompt("fix r1").includes("```json"));
  assert.match(String(none.result["status"]), /the implementer returned no whole handoff/);

  // the author checks at scale before every push, with the review's own text: statements for the engine's paths, in
  // every variant form, and the regression sweep; checks for the others; the differences fixed, the counts reported
  const forms = arrayOf("pr-loop-slim", "VARIANT_FORMS");
  for (const l of ["implement", "fix r1", "CI fix 1"]) {
    const p = r.prompt(l);
    assert.match(p, /CHECK AT SCALE before you push/, l);
    assert.match(p, /node --env-file=<env file> <tree>\/scripts\/duck-repro\.ts <ddl\.sql> <statements\.sql>/, `${l}: in batches, through duck-repro`);
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
  // learn and its check run, and each says its time
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

test("pr-loop-slim: its review adds the handoff sentence once, returns FINDINGS, and its Review record keeps the block's keys", async () => {
  const slim = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green });
  for (const l of ["review r1", "review r2"]) assert.equal(slim.prompt(l).split(NOT_THE_HANDOFF).length, 2, `"${l}" adds the handoff sentence once`);
  const schema = slim.calls.find((c) => c.opts.label === "review r1")!.opts.schema as { required: string[] };
  assert.deepEqual(schema.required, ["findings", "judgedCorrect", "statementsRun", "statementsMatched", "checksRun", "changedPaths", "checksOnly"], "the review returns FINDINGS");
  const b = parseRecords(slim.prompt("record"))[0]!;
  assert.deepEqual(Object.keys(b).sort(), ["checksRun", "ciFixes", "deferred", "designRounds", "findings", "pr", "probeRounds", "reviewRounds", "statementsMatched", "statementsRun", "status"],
    "the record block's keys, which scripts/review-stats.ts reads");
  assert.deepEqual([b.pr, b.reviewRounds, b.ciFixes], [900, 2, 0]);
  assert.deepEqual(b.findings, [{ round: 1, stage: "review", classKey: "c-a", severity: "wrong-answer" }]);
  assert.deepEqual([b.designRounds, b.probeRounds], [0, 0], "no design round and no probe round");
  assert.equal(b.statementsRun, 2, "the reviews' statements alone, summed");
  assert.match(slim.prompt("record"), /pr-loop-slim/, "the record's text names the process it came from");
  assert.equal(stats([b]).firstPass, 0);
  assert.equal(stats([b]).bySecond, 1, "review-stats reads it");
});

// ---------------------------------------------------------------- the pr-persistent skill: the coordinator of one run
// PR 258, review round 1, a CLASS round: a prompt duplicated by hand drifts from its source, so the skill restates
// NOTHING (that was measured in the race on issue 176, which this skill won, issue 386): its render
// command replays pr-loop-slim.js against the answers recorded so far and writes the whole prompt of each next stage.
// These tests hold every stage's rendered prompt equal to slim's own, whole, for the same inputs, and the skill free of
// slim's prompt text.
const SKILL = path.join(ROOT, ".claude", "skills", "pr-persistent", "SKILL.md");
const skillText = (): string => fs.readFileSync(SKILL, "utf8");
// Issue 386: the top session's queue, a skill of its own; it starts each run as a coordinator following SKILL.md
const UP_NEXT = path.join(ROOT, ".claude", "skills", "up-next", "SKILL.md");
const upNextText = (): string => fs.readFileSync(UP_NEXT, "utf8");
/** A skill's frontmatter fields, held to what Claude Code reads: a name, and a description that is one plain scalar. */
function frontmatter(text: string): Record<string, string> {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "the skill opens with frontmatter");
  const fields = Object.fromEntries([...front[1]!.matchAll(/^([a-z-]+): (.+)$/gm)].map((m) => [m[1]!, m[2]!]));
  assert.ok((fields["description"] ?? "").length > 40, "a description that says when to use it");
  assert.doesNotMatch(fields["description"]!, /: /, "the description is one plain YAML scalar");
  return fields;
}
/** What no checked-in skill may hold: a machine's path, a scratch folder, or an agent's id (a run's state). */
const MACHINE = /\/Users\/|\/home\/|\/private\/tmp|scratchpad|claude-501|\ba[0-9a-f]{16}\b/;
// Issue 304: the coordinator carried every prompt and result through its own context, a third of the implementer's
// output tokens, only to forward them. Content now goes between agents by path: the render is a script file pinned
// into the run folder, its stdout only control lines, each prompt a file, each result a file the agent writes.
const RENDER = path.join(ROOT, ".claude", "skills", "pr-persistent", "render.mjs");
/** The skill's render command, the ```sh block that begins `# render-stage`. */
function renderCommand(): string {
  const m = /```sh\n(# render-stage[\s\S]*?)\n```/.exec(skillText());
  assert.ok(m, "the skill has the render command, in a ```sh block that begins `# render-stage`");
  return m[1]!;
}
/** A run folder of its own, as SKILL.md sets one up: args.json, the pinned copy of slim (this tree's, or `slimSrc`),
 * render.mjs and results/. Its real path, as the render names it from import.meta.url. */
function runFolder(args: Record<string, unknown>, slimSrc = source("pr-loop-slim")): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-persistent-")));
  fs.writeFileSync(path.join(dir, "args.json"), JSON.stringify(args));
  fs.writeFileSync(path.join(dir, "pr-loop-slim.js"), slimSrc);
  fs.copyFileSync(RENDER, path.join(dir, "render.mjs"));
  fs.mkdirSync(path.join(dir, "results"));
  return dir;
}
const fileName = (label: string) => label.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "");
/** Where the agent of `label` writes its result, and the one value besides null answers.json may record for it. */
const resultPath = (dir: string, label: string) => path.join(dir, "results", `${fileName(label)}.json`);
type Rendered = { out: string; err: string; status: number | null; files: Record<string, string>; dir: string };
/** `node <dir>/render.mjs` with answers.json holding `recorded` as is, run from another folder, with no RUN or REPO in
 * its environment: the run folder is the one the script sits in. */
function renderRaw(dir: string, recorded: Record<string, unknown>): Rendered {
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(recorded));
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["RUN"];
  delete env["REPO"];
  const r = spawnSync(process.execPath, [path.join(dir, "render.mjs")], { env, cwd: os.tmpdir(), encoding: "utf8" });
  const next = path.join(dir, "next");
  const files = fs.existsSync(next) ? Object.fromEntries(fs.readdirSync(next).map((f) => [f, fs.readFileSync(path.join(next, f), "utf8")])) : {};
  return { out: r.stdout, err: r.stderr, status: r.status, files, dir };
}
/** The skill's render over args and answers, recorded as the coordinator records them: each answer written to its
 * stage's results file by "the agent", and that path (or null for a failed agent) in answers.json. */
function renderStage(args: Record<string, unknown>, answers: Answers, slimSrc = source("pr-loop-slim")): Rendered {
  const dir = runFolder(args, slimSrc);
  const recorded: Record<string, string | null> = {};
  for (const [label, a] of Object.entries(answers)) {
    if (a === null) { recorded[label] = null; continue; }
    fs.writeFileSync(resultPath(dir, label), JSON.stringify(a));
    recorded[label] = resultPath(dir, label);
  }
  const r = renderRaw(dir, recorded);
  assert.equal(r.status, 0, `the render exits 0: ${r.err}`);
  assert.equal(r.err, "", "the render prints nothing on stderr when nothing is wrong");
  return r;
}
/** What the render appends to slim's prompt of `label`, up to its schema: where the agent writes its result. */
const RESULT_TRAILER = (dir: string, label: string) =>
  `\n\nBefore you end your turn, write your result, ONE JSON value matching this schema (the Workflow tool enforces it on pr-loop-slim's agents), to ${resultPath(dir, label)}, and end your report with that path. The schema: `;
/** The coordinator reads stdout, so it holds control lines only, and no sentence of any prompt it rendered. */
function onlyControlLines(r: Rendered, what: string): void {
  for (const line of r.out.split("\n").filter(Boolean)) assert.match(line, /^(STAGE |DONE: |NULL )/, `${what}: a stdout line that is not a control line: ${line}`);
  for (const text of Object.values(r.files)) {
    for (const s of text.split(/(?<=[.:])\s+|\n/).map((x) => x.trim()).filter((x) => x.length >= 30)) {
      assert.ok(!r.out.includes(s), `${what}: stdout carries a sentence of a prompt: ${s}`);
    }
  }
}

test("the pr-persistent skill: valid frontmatter, and it names where its text comes from without restating it", async () => {
  assert.ok(fs.existsSync(SKILL), "the skill exists at .claude/skills/pr-persistent/SKILL.md");
  const text = skillText();
  const fields = frontmatter(text);
  assert.equal(fields["name"], "pr-persistent");
  assert.doesNotMatch(fields["description"]!, /\brace\b|\barm\b|issue 176/i, "the race is over (issue 386): the description names none");
  for (const s of [".claude/workflows/pr-loop-slim.js", "EVIDENCE", "VARIANT_FORMS", "SEVERITY_RULE", "FINDINGS", "json mason-review-record", "SendMessage",
    'process: "pr-persistent"', "THE SAME implementer", "Run log", "Learn"]) {
    assert.ok(text.includes(s), `the skill says ${s}`);
  }
  assert.ok(!text.includes("Race log"), "the run log, no longer the race's");
  assert.doesNotMatch(text, /\braced\b|the other arm|experimental|issue 176/, "no race wording");
});

test("the pr-persistent skill: its arguments, the coordinator's report at DONE, a split DONE, and no merge of its own (issue 386)", () => {
  const text = skillText(), prose = text.replace(/\s+/g, " ");
  // the arguments, said once near the top, as placeholders
  const args = prose.slice(0, prose.indexOf("## 1. Set up the run"));
  for (const a of ["`issue`", "context line", "`<runs>`", "`<runs>/issue-<n>`", "`<repo>`", "`<it env>`", "`parent`", "`stackedOn`", "`knownClasses`", "`result.json`"]) {
    assert.ok(args.includes(a), `the arguments name ${a}`);
  }
  // args.json without a brief: the Brief stage runs, and may split
  assert.ok(prose.includes("NO `brief`") && prose.includes("This issue is not split yet"), "args.json has no brief, and the context sentence");
  // the coordinator never merges: the top session does
  assert.doesNotMatch(text, /gh pr merge/, "no merge command: the coordinator never merges");
  assert.ok(prose.includes("Never merge, nor queue a merge") && prose.includes(".claude/skills/up-next/SKILL.md"), "it says who merges");
  // a split DONE reports the pieces and stops
  assert.match(prose, /\*\*A split\*\* \(`DONE: split into <k> pieces: …`\)[^]*?their sub-issues[^]*?and stop/);
  // the report at DONE
  for (const s of ["the PR and its head", "the status line the render printed", "the wall time", "the tokens per model, from the run log", "every issue filed during the run", "anything that went wrong"]) {
    assert.ok(prose.includes(s), `the report gives ${s}`);
  }
  // pinning reads git's objects: no pull of the main checkout, no index.lock dance
  assert.match(text, /^git fetch origin <base>$/m);
  assert.doesNotMatch(text, /git (?:-C \S+ )?pull|index\.lock/, "the main checkout is never pulled");
  for (const s of ["## Waits", "## Never", "--test-force-exit"]) assert.ok(text.includes(s), `the skill says ${s}`);
});

test("the up-next skill: the top session's queue, its rules, how a run starts and how a DONE is merged (issue 386)", () => {
  assert.ok(fs.existsSync(UP_NEXT), "the skill exists at .claude/skills/up-next/SKILL.md");
  const text = upNextText(), prose = text.replace(/\s+/g, " ");
  assert.equal(frontmatter(text)["name"], "up-next");
  for (const s of ["three at a time", "Needs Tom", "Backlog", "jumps the queue", "Every request made in chat gets an issue and a coordinator run", "never a direct agent",
    "--match-head-commit", "release-notes/next.md", "Sonnet", ".claude/skills/pr-persistent/SKILL.md", "`<queue file>`", "`<runs>`",
    "members of a class issue", "Two runs on the same files", "--json state,mergeable", "Start the next run first", "read its diff in full"]) {
    assert.ok(prose.includes(s), `the skill says ${s}`);
  }
  assert.match(prose, /A bug that blocks merges jumps the queue[^.]*flaky oracle statement/, "a merge-blocking flake jumps the queue");
  // a split DONE: each piece in order, a stacked one with stackedOn and knownClasses from the run below
  assert.match(prose, /\*\*A split\*\*[^]*?in order[^]*?stacked piece starts only once the one below is pushed, with stackedOn[^]*?knownClasses[^]*?from the run below/);
  // the queue file's format, never its contents
  assert.ok(prose.includes("Order: done: <issues> | running: <issue>") && prose.includes("| issue | coordinator agent | started | PR | state |"), "the queue file's format");
  assert.ok(text.includes("`gh pr merge <n> --auto --merge --match-head-commit <sha>`"), "the merge is queued pinned to the head read");
  assert.ok(prose.includes("the queue belongs on the board") && prose.includes("is open"), "the queue on the board stays an open question");
  // a run starts only on an issue whose author is the repository's own (issue 438); any other goes to Needs Tom
  const gate = text.indexOf("`node <repo>/scripts/gh-text.ts author <n>`");
  const implementing = text.indexOf('`node <repo>/scripts/board.ts status <n> "Implementing"`');
  assert.ok(gate >= 0 && implementing > gate, "the author is checked before the card moves to Implementing");
  assert.match(text.slice(gate, implementing), /Exit 3[^]*Needs Tom[^]*`node <repo>\/scripts\/board\.ts status <n> "Needs Tom"`/, "exit 3 goes to Needs Tom");
  assert.match(text.slice(gate, implementing), /Exit 1 is "couldn't tell"[^.]*never start/, "a gh that failed starts nothing");
});

test("both skills: no machine path, agent id or run state, and no sentence of a pr-loop-slim prompt (issue 386, PR 258's class)", async () => {
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false, handoff: H1 }, "review r3": clean, "CI 2": green });
  const split = await run("pr-loop-slim", { ...PR }, { brief: SPLIT_BRIEF, split: { subIssues: [401, 402] } });
  const merge = await run("pr-loop-slim", { ...PR }, MERGE_RUN);
  const sentences = [...new Set([...r.calls, ...split.calls, ...merge.calls, { prompt: String(merge.result["status"]) }].flatMap((c) => c.prompt.split(/(?<=[.:;])\s+|\n/)).map((x) => x.trim()).filter((x) => x.length >= 50))];
  for (const [name, text] of [["pr-persistent", skillText()], ["up-next", upNextText()]] as const) {
    assert.doesNotMatch(text, MACHINE, `${name}: a machine path, a scratch folder or an agent id`);
    assert.deepEqual(sentences.filter((x) => text.includes(x)), [], `${name} restates a prompt of pr-loop-slim.js: render it instead`);
    for (const cmd of commandsOf(text)) assert.deepEqual(unplain(cmd), [], `${name}: \`${cmd}\` is not plain`);
  }
});

test("the pr-persistent skill: the render is one command, each stage is dispatched by path, and the run is pinned and measured", () => {
  const cmd = renderCommand();
  assert.ok(cmd.includes("node <run folder>/render.mjs"), "the render is the pinned script, run by its literal path");
  assert.doesNotMatch(cmd, /<</, "no heredoc: the coordinator never re-emits the render's source");
  assert.deepEqual(cmd.split("\n").filter((l) => !l.startsWith("#")), ["node <run folder>/render.mjs"], "the block is that one command");
  const text = skillText(), prose = text.replace(/\s+/g, " ");
  for (const s of ["Your instructions are in", "read the whole file, then follow it", "results/", "PIN the script and its render",
    ".claude/skills/pr-persistent/render.mjs", "never the JSON", "cache writes", "cache reads"]) {
    assert.ok(prose.includes(s), `the skill says ${s}`);
  }
  // both files are pinned from one commit, as the Workflow tool loads its script once, read from git's objects
  assert.match(text, /^git rev-parse origin\/<base>$/m);
  assert.match(text, /^git show <sha>:\.claude\/workflows\/pr-loop-slim\.js > <run folder>\/pr-loop-slim\.js$/m);
  assert.match(text, /^git show <sha>:\.claude\/skills\/pr-persistent\/render\.mjs > <run folder>\/render\.mjs$/m);
  assert.doesNotMatch(text, /fenced json block/, "a result travels by file, never in the report");
  // issue 304, PR 313: a resumed implementer's completion notice can go to the top-level session, never to the
  // coordinator, so the coordinator's wait on an agent watches its results file (or the PR's head), never a notice
  for (const s of ["before it ends its turn", "never the agent's completion notice", "`node <repo>/scripts/wait-file.ts <path> 1800`", "run_in_background", "git ls-remote", "never on a notice"]) {
    assert.ok(prose.includes(s), `the skill says ${s}`);
  }
  assert.doesNotMatch(prose, /every agent you start notifies you/, "no wait relies on a notice");
});

test("the skills and the render restate no sentence of a prompt pr-loop-slim.js gives its agents (PR 258's class)", async () => {
  const text = skillText() + "\n" + upNextText() + "\n" + fs.readFileSync(RENDER, "utf8");
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false, handoff: H1 }, "review r3": clean, "CI 2": green });
  const merge = await run("pr-loop-slim", { ...PR }, MERGE_RUN);
  const sentences = new Set([...r.calls, ...merge.calls].flatMap((c) => c.prompt.split(/(?<=[.:])\s+|\n/)).map((x) => x.trim()).filter((x) => x.length >= 50));
  assert.ok(sentences.size > 100);
  const restated = [...sentences].filter((x) => text.includes(x));
  assert.deepEqual(restated, [], "the skill restates a prompt of pr-loop-slim.js: render it instead");
  // a paraphrase matches no sentence, so what drifted on PR 258 is held apart: a budget, a scale, a stage's rule
  assert.doesNotMatch(text, /tool calls|hundreds of statements|a narrower set|CLASS round|Each finding becomes a test/, "a budget or rule of a stage is slim's, rendered, never the skill's");
  assert.equal(parseRecords(text).length, 0, "no record block of its own: the record stage is rendered");
});

/** A full run as the skill drives it: its args, and every stage answered explicitly, so the harness adds nothing the
 * render does not see. (Named for the race on issue 176, whose args these were.) */
const RACE_ARGS = { ...PR, repo: ROOT, brief: { brief: "the shared brief", shapes: ["SELECT shared_shape FROM t"], tests: ["tests/duck-wire.test.ts --test-name-pattern shared"] }, process: "pr-persistent" };
const ran = (o: object) => ({ changedPaths: ["src/duck/plan.ts"], statementsRun: 300, statementsMatched: 299, checksRun: 0, checksOnly: [], ...o });
const RACE_ANSWERS: Answers = {
  implement: { ...pushed("a"), statementsRun: 120, statementsMatched: 118, checksRun: 1, handoff: H1 },
  link: { linked: true, bodyFixed: false, detail: "listed 900" },
  "review r1": ran({ findings: [finding({ classKey: "k", input: "SELECT r1 FROM t" }), finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t" })], judgedCorrect: ["the cast"] }),
  "CI read r1": { state: "failed", detail: "tests/duck-wire.test.ts: a test failed" },
  "fix r1": { ...pushed("b"), statementsRun: 40, statementsMatched: 40, checksRun: 0, handoff: { ...H1, risks: ["after fix r1"] } },
  "review r2": ran({ findings: [finding({ classKey: "k", input: "SELECT r2 FROM t" })], judgedCorrect: [] }),
  "CI read r2": green,
  "fix r2 (class)": { ...pushed("c"), statementsRun: 60, statementsMatched: 60, checksRun: 0, handoff: H1 },
  "review r3": ran({ findings: [], judgedCorrect: ["the class"] }),
  "CI read r3": green,
  learn: { ...pushed("d"), startedAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:03:00Z" },
  "learn check": { files: [".claude/rules/duck-rewrite.md"], endedAt: "2026-11-01T10:04:00Z" },
  "CI 1": red,
  "CI fix 1": { ...pushed("e"), flake: false, statementsRun: 12, statementsMatched: 12, checksRun: 0, handoff: H1 },
  "review r4": ran({ findings: [], judgedCorrect: [] }),
  "CI read r4": green,
  "CI 2": green,
  file: { issues: [{ classKey: "base-class", source: "base", issue: 950, action: "filed" }] },
  record: { url: "https://github.com/embeddable-hq/mason-data/pull/900#issuecomment-2" },
};
const fileOf = (label: string) => `${label.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "")}.md`;

test("the pr-persistent skill: every stage's prompt and options, rendered by the skill, are pr-loop-slim's own, whole", async () => {
  const [args, answers] = [RACE_ARGS, RACE_ANSWERS];
  const slim = await run("pr-loop-slim", args, answers);
  assert.deepEqual(slim.labels, Object.keys(answers), "the run reaches every stage, in this order");
  for (const [i, call] of slim.calls.entries()) {
    const { label, phase, schema, ...on } = call.opts;
    const before = Object.fromEntries(slim.labels.slice(0, i).map((l) => [l, answers[l]]));
    const r = renderStage(args, before);
    const { out, files, dir } = r;
    assert.match(out, new RegExp(`^STAGE ${JSON.stringify(label).replace(/[()]/g, "\\$&")} \\(${phase}\\) `), `${label}: the render's next stage`);
    assert.ok(out.split("\n")[0]!.includes(JSON.stringify(on)), `${label}: the options slim gives it (${JSON.stringify(on)})`);
    assert.ok(out.split("\n")[0]!.endsWith(`: ${path.join(dir, "next", fileOf(label))}`), `${label}: the STAGE line names its prompt's file`);
    assert.equal(files[fileOf(label)], call.prompt + RESULT_TRAILER(dir, label) + JSON.stringify(schema), `${label}: the rendered prompt is slim's, whole`);
    // the trailer sends the result to a file, by an absolute path the render reads back, and never into the report
    const trailer = files[fileOf(label)]!.slice(call.prompt.length);
    assert.ok(path.isAbsolute(resultPath(dir, label)) && trailer.includes(resultPath(dir, label)), `${label}: the trailer names its results file`);
    assert.doesNotMatch(trailer, /fenced json block/, `${label}: the result goes to a file`);
    onlyControlLines(r, label);
  }
  assert.ok(!renderStage(args, {}).out.includes("Implement ONE PR in the Mason repo"), "the implement prompt stays on disk");
  // a review and the CI read beside it are rendered together, as slim starts them together
  const together = renderStage(args, Object.fromEntries(slim.labels.slice(0, 2).map((l) => [l, answers[l]])));
  assert.deepEqual(Object.keys(together.files).sort(), ["CI-read-r1.md", "review-r1.md"]);
  assert.deepEqual(together.out.split("\n").filter(Boolean).map((l) => l.replace(/ \(.*$/, "")), ['STAGE "review r1"', 'STAGE "CI read r1"']);
  onlyControlLines(together, "review and CI read");
  // the record is rendered too: its block, for the PR it is posted on, saying which process wrote it
  const recorded = renderStage(args, Object.fromEntries(slim.labels.slice(0, -1).map((l) => [l, answers[l]])));
  onlyControlLines(recorded, "record");
  const record = recorded.files["record.md"]!;
  const rec = parseRecords(record);
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.pr, 900, "the record names the PR, read from the implementer's answer");
  assert.match(record, /pr-persistent \(pr-loop-slim's prompts, with ONE implementer kept alive across the fix rounds\)/);
  // and when every stage is answered, the run is over, with slim's status
  const done = renderStage(args, answers);
  onlyControlLines(done, "done");
  assert.equal(done.out, `DONE: ${String(slim.result["status"])}\n`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(done.dir, "result.json"), "utf8")).status, slim.result["status"]);
});

/** What pr-loop-slim, under the stub harness, starts next with these answers: the first stage it calls that has none
 * (its call), or the run's end (its status). The harness's DEFAULTS never answer: an unanswered stage is the next. */
async function slimNext(args: Record<string, unknown>, answers: Answers): Promise<Call | { done: string }> {
  const STOP = new Error("stop");
  let first: Call | undefined;
  const proxy = new Proxy(answers, {
    has: () => true,
    get: (t, k) => (typeof k === "string" && Object.hasOwn(t, k) ? t[k] : (c: Call) => { first ??= c; throw STOP; }),
  });
  try {
    const r = await run("pr-loop-slim", args, proxy);
    return { done: String(r.result["status"]) };
  } catch (e) {
    if (e !== STOP) throw e;
    return first!;
  }
}
/** The skill's render and slim agree on what comes next: the same stage with the same whole prompt, or the same end. */
async function sameNext(answers: Answers | Rendered, expect: Answers, what: string): Promise<string> {
  const want = await slimNext(RACE_ARGS, expect);
  const got = typeof answers["out"] === "string" && typeof answers["dir"] === "string" ? answers as Rendered : renderStage(RACE_ARGS, answers);
  assert.equal(got.status, 0, `${what}: the render exits 0: ${got.err}`);
  onlyControlLines(got, what);
  if ("done" in want) {
    assert.equal(got.out.split("\n").filter((l) => !l.startsWith("NULL ")).join("\n").trim(), `DONE: ${want.done}`, what);
  } else {
    const { label, phase, schema } = want.opts;
    assert.match(got.out, new RegExp(`^STAGE ${JSON.stringify(label).replace(/[()]/g, "\\$&")} \\(${phase}\\) `, "m"), `${what}: the next stage is ${label}`);
    assert.equal(got.files[fileOf(label)], want.prompt + RESULT_TRAILER(got.dir, label) + JSON.stringify(schema), `${what}: ${label}'s prompt, whole`);
  }
  return got.out;
}
/** The answers of the full run up to `label` (not included), with `label` answered by `a`. */
const upTo = (label: string, a: unknown): Answers => {
  const keys = Object.keys(RACE_ANSWERS);
  return { ...Object.fromEntries(keys.slice(0, keys.indexOf(label)).map((k) => [k, RACE_ANSWERS[k]])), [label]: a };
};

// PR 258, re-check: the Workflow tool checks each agent's result against its schema and reads one that fails as null;
// the render once trusted answers.json, so a finding with `origin: "this_pr"` matched no origin, the round read clean,
// and a blocking wrong answer went to CI as reviewed. The authority is the schema each agent() call carries.
test("the pr-persistent skill's render reads an answer that fails its stage's schema as null, as the Workflow tool does", async () => {
  const goodReview = RACE_ANSWERS["review r1"] as Record<string, unknown>;
  const ciGreen = { "CI read r1": green };
  // a finding whose origin is not in the enum: slim's run reads the review as failed, never as clean
  const badOrigin = { ...goodReview, findings: [finding({ origin: "this_pr", severity: "wrong-answer" })] };
  let out = await sameNext({ ...upTo("review r1", badOrigin), ...ciGreen }, { ...upTo("review r1", null), ...ciGreen }, "origin this_pr");
  assert.match(out, /^NULL "review r1": answer\.findings\[0\]\.origin is "this_pr", not one of this-pr, base; read as null/m);
  assert.doesNotMatch(out, /STAGE "CI 1"/, "the PR never goes to CI as reviewed");
  const status = (await slimNext(RACE_ARGS, { ...upTo("review r1", null), ...ciGreen, record: RACE_ANSWERS["record"] })) as { done: string };
  assert.match(status.done, /^review r1 failed/);
  // no changedPaths: a failed review, as the Workflow arm's, never `unreviewed`
  const noPaths = { findings: [], judgedCorrect: [], statementsRun: 3, statementsMatched: 3, checksRun: 0 };
  out = await sameNext({ ...upTo("review r1", noPaths), ...ciGreen }, { ...upTo("review r1", null), ...ciGreen }, "changedPaths absent");
  assert.match(out, /^NULL "review r1": answer\.changedPaths is missing/m);
  // a fix with no head: a failed fix, said so, never a TypeError
  const { head: _head, ...noHead } = RACE_ANSWERS["fix r1"] as Record<string, unknown>;
  out = await sameNext(upTo("fix r1", noHead), upTo("fix r1", null), "fix r1 without head");
  assert.match(out, /^NULL "fix r1": answer\.head is missing/m);

  // one missing required field for each schema the run uses: each answer then follows slim's path for null
  const full = await run("pr-loop-slim", RACE_ARGS, RACE_ANSWERS);
  const seen = new Set<string>();
  for (const c of full.calls) {
    const schema = c.opts.schema as { required?: string[] };
    const key = JSON.stringify(schema);
    if (seen.has(key)) continue;
    seen.add(key);
    const k = schema.required!.at(-1)!;
    const { [k]: _gone, ...without } = RACE_ANSWERS[c.opts.label] as Record<string, unknown>;
    const label = c.opts.label;
    // a review's CI read is answered beside it, as the coordinator records both
    const beside = label.startsWith("review r") ? { [`CI read r${label.slice(8)}`]: RACE_ANSWERS[`CI read r${label.slice(8)}`] } : {};
    out = await sameNext({ ...upTo(label, without), ...beside }, { ...upTo(label, null), ...beside }, `${label} without ${k}`);
    assert.match(out, new RegExp(`^NULL ${JSON.stringify(label).replace(/[()]/g, "\\$&")}: answer\\.${k} is missing`, "m"), `${label} without ${k}`);
  }
  assert.ok(seen.size >= 9, `every schema the run uses (${seen.size})`);
  // and a valid answer is never read as null
  assert.doesNotMatch(renderStage(RACE_ARGS, RACE_ANSWERS).out, /^NULL /m);
});

test("the pr-persistent skill's render reads only the run folder's pinned pr-loop-slim.js, never the checkout's", () => {
  const marked = source("pr-loop-slim").replace("Implement ONE PR in the Mason repo", "Implement ONE PINNED PR in the Mason repo");
  assert.notEqual(marked, source("pr-loop-slim"));
  // renderStage runs the render from another folder with no RUN or REPO in its environment
  const { files, dir } = renderStage(RACE_ARGS, {}, marked);
  assert.match(files["implement.md"]!, /Implement ONE PINNED PR/, "the stage is rendered from the copy in the run folder");
  assert.ok(fs.existsSync(path.join(dir, "next", "implement.md")), "into its own folder");
  const src = fs.readFileSync(RENDER, "utf8");
  assert.match(src, /import\.meta\.url/, "the run folder is the one the script sits in");
  assert.doesNotMatch(src, /REPO|\.claude\/workflows|process\.env/, "the render reads nothing from a checkout or the environment");
  assert.doesNotMatch(src, /from "\.{1,2}\//, "it imports nothing relative: it runs from a scratchpad folder");
  assert.match(skillText(), /PIN the script/);
});

// Issue 304: the coordinator records a path, never the JSON, and the render reads the file at that path as the
// Workflow tool reads an agent's result: missing or not JSON is a failed agent, said on a NULL line.
test("the pr-persistent render reads a missing or invalid result file as null, as a failed agent", async () => {
  let dir = runFolder(RACE_ARGS);
  let out = await sameNext(renderRaw(dir, { implement: resultPath(dir, "implement") }), { implement: null }, "implement's file absent");
  assert.match(out, new RegExp(`^NULL "implement": the result file ${resultPath(dir, "implement").replace(/[.]/g, "\\.")} does not exist; read as null`, "m"));
  dir = runFolder(RACE_ARGS);
  fs.writeFileSync(resultPath(dir, "implement"), "not json");
  out = await sameNext(renderRaw(dir, { implement: resultPath(dir, "implement") }), { implement: null }, "implement's file not JSON");
  assert.match(out, /^NULL "implement": the result file \S+ is not JSON \([^\n]*\); read as null/m);
  // a recorded null is a failed agent, and says nothing: the coordinator knew it
  out = await sameNext({ implement: null }, { implement: null }, "implement null");
  assert.doesNotMatch(out, /^NULL /m);
});

test("the pr-persistent render refuses an answer that is not its label's results path, before anything runs", () => {
  // the old flow's raw JSON
  let dir = runFolder(RACE_ARGS);
  let r = renderRaw(dir, { implement: RACE_ANSWERS["implement"] });
  assert.notEqual(r.status, 0, "the render exits non-zero");
  assert.doesNotMatch(r.out, /^(STAGE|DONE)/m, "and starts nothing");
  assert.deepEqual(r.files, {}, "and renders no prompt");
  assert.equal(r.err.trim().split("\n").length, 1, `ONE stderr line: ${r.err}`);
  assert.match(r.err, /"implement"/);
  assert.match(r.err, /record the results path/);
  assert.match(r.err, /never the JSON/);
  assert.ok(r.err.includes(resultPath(dir, "implement")), "it names the path to record");
  // another stage's file: a review would read the fix's result as its own, silently
  dir = runFolder(RACE_ARGS);
  const answers = upTo("review r1", null);
  const recorded: Record<string, unknown> = {};
  for (const [l, a] of Object.entries(answers)) {
    if (a !== null) fs.writeFileSync(resultPath(dir, l), JSON.stringify(a));
    recorded[l] = a === null ? null : resultPath(dir, l);
  }
  fs.writeFileSync(resultPath(dir, "fix r1"), JSON.stringify(RACE_ANSWERS["fix r1"]));
  r = renderRaw(dir, { ...recorded, "review r1": resultPath(dir, "fix r1") });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.out, /^(STAGE|DONE)/m);
  assert.match(r.err, /"review r1"/);
  assert.ok(r.err.includes(resultPath(dir, "review r1")), `it names the path it expects: ${r.err}`);
  // a bad answers.json is one line too, never a stack
  dir = runFolder(RACE_ARGS);
  fs.writeFileSync(path.join(dir, "answers.json"), "{");
  const bad = spawnSync(process.execPath, [path.join(dir, "render.mjs")], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^render\.mjs: \S+answers\.json is not JSON \([^\n]*\): [^\n]+\n$/);
});

// Issue 452: a conflict CI reads is a stage the render dispatches like any other, and a conflict DONE is the
// coordinator's ONE report at once, never a wait; the top session merges what the run could not.
test("the pr-persistent skill: a conflict renders the merge stage for a fresh agent, and a conflict DONE is slim's status (issue 452)", async () => {
  const atConflict = upTo("CI 1", conflictCI);
  const r = renderStage(RACE_ARGS, atConflict);
  assert.equal(r.out, `STAGE "merge 1" (Merge) ${JSON.stringify(MERGE_OPTS)}: ${path.join(r.dir, "next", "merge-1.md")}\n`, "exactly one stage: the merge");
  await sameNext(r, atConflict, "merge 1: slim's whole prompt and the results trailer");
  // the merge leaves the conflict open: File and Record still run, then DONE with slim's own status
  const open = { ...atConflict, "merge 1": { state: "conflict", head: sha("d"), files: ["src/duck/plan.ts"], detail: "conflict: src/duck/plan.ts" } };
  await sameNext(open, open, "file after a merge that left the conflict open");
  const all = { ...open, file: RACE_ANSWERS["file"], record: RACE_ANSWERS["record"] };
  const want = await slimNext(RACE_ARGS, all) as { done: string };
  assert.match(want.done, /^conflict: PR 900 conflicts with main\b[^]*src\/duck\/plan\.ts/, want.done);
  const done = renderStage(RACE_ARGS, all);
  onlyControlLines(done, "conflict DONE");
  assert.equal(done.out, `DONE: ${want.done}\n`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(done.dir, "result.json"), "utf8")).status, want.done);
  // a merge that pushed: CI again at the new head, never a fix
  const pushedMerge = { ...atConflict, "merge 1": mergedAt("m") };
  const next = await sameNext(pushedMerge, pushedMerge, "CI 2 after the merge");
  assert.match(next, /^STAGE "CI 2" \(CI\) /);
});

test("the skills: a conflict DONE is the coordinator's ONE report at once, and the top session merges the base (issue 452)", () => {
  const text = skillText(), prose = text.replace(/\s+/g, " ");
  // section 2: the merge is a fresh agent's, with the printed options, never the implementer's
  const fresh = /\*\*Every other stage\*\*[^]*?(?=\n- \*\*|\n\n)/.exec(text)?.[0].replace(/\s+/g, " ") ?? "";
  assert.ok(fresh.includes("`merge <k>`"), `section 2's fresh-agent list names merge <k>: ${fresh}`);
  assert.ok(!/\*\*`fix r<n>`[^]*?SendMessage/.exec(text)?.[0].includes("merge"), "the implementer's list does not name the merge");
  // section 3: a conflict DONE, reported at once as the ONE report, naming the files, with no wait after it
  assert.match(prose, /\*\*A conflict\*\* \(`DONE: conflict: …`\)[^]*?the files the status names[^]*?your ONE report AT ONCE[^]*?naming the files from the status[^]*?Never wait on it, watch it, or leave a background job for it/);
  const waits = (/## Waits\n([^]*?)(?=\n## )/.exec(text)?.[1] ?? "").replace(/\s+/g, " ");
  assert.ok(waits.includes("A DONE ends the run") && waits.includes("No wait, watch or background job follows a DONE"), `## Waits: ${waits}`);
  // up-next: the conflict DONE is step 6's CONFLICTING, merged with both sides of next.md kept, read, CI waited on, queued pinned
  const up = upNextText().replace(/\s+/g, " ");
  assert.match(up, /\*\*A conflict\*\* \(`conflict: …`\)[^]*?step 6's CONFLICTING[^]*?keeping both sides of `release-notes\/next\.md` and resolving the files the status names, and pushed[^]*?You write no code yourself[^]*?read the merge[^]*?one bounded background job \(`node <repo>\/scripts\/ci-wait\.ts <n> 540`[^]*?its diff read in full, and the merge queued pinned to it \(`--match-head-commit`\)/);
  assert.match(up, /6\. \*\*Watch it land\*\*[^]*?On CONFLICTING/, "the step a conflict DONE refers to is the one that handles CONFLICTING");
});

test("pr-loop-slim: args.process names the arm in the record's text, and an unknown one stops the run", async () => {
  let r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  assert.match(r.prompt("record"), /\npr-loop-slim \(no design review/);
  r = await run("pr-loop-slim", { ...PR, process: "pr-persistent" }, { ...SLIM, "review r1": clean, "CI 1": green });
  assert.match(r.prompt("record"), /\npr-persistent \(pr-loop-slim's prompts/);
  r = await run("pr-loop-slim", { ...PR, process: "persistent" }, {});
  assert.deepEqual(r.labels, []);
  assert.match(String(r.result["status"]), /^args\.process is "persistent": it is one of pr-loop-slim, pr-persistent/);
});

// ---------------------------------------------------------------- the split verdict (issue 386): an issue too big for
// one PR was seen only if the top session spotted it, or late, as rounds piled up or the round bound stopped a run. The
// Brief may now return `split`; the run makes a sub-issue per piece, posts the plan and stops before any code.
// issue-loop.js's TASKS item is the piece's shape and its Setup the split stage's prompt, both moved.

test("pr-loop-slim split: a Brief that splits makes a sub-issue per piece, posts the plan and stops before Implement", async () => {
  const r = await run("pr-loop-slim", { ...PR }, { brief: SPLIT_BRIEF, split: { subIssues: [401, 402] } });
  assert.deepEqual(r.labels, ["brief", "split"], "no implement, link, review, file or record");
  assert.deepEqual(r.phases, ["Brief", "Split"]);
  const titles = meta("pr-loop-slim").phases.map((p) => p.title);
  for (const t of ["Brief", "Split"]) assert.ok(titles.includes(t), `meta declares ${t}`);
  assert.deepEqual(shapeOf(r.result), RESULT_KEYS, "the result's one shape: no new key");
  assert.deepEqual([r.result["pr"], r.result["head"]], [null, null]);
  const status = String(r.result["status"]);
  assert.match(status, /^split into 2 pieces: #401, #402 \(stacked on #401\); the plan is on #301: the top session starts each as a run$/);

  // the split stage's prompt: issue-loop's Setup, moved
  const p = r.prompt("split");
  for (const s of ['`node <repo>/scripts/board.ts status 301 "In progress"`', '`node <repo>/scripts/board.ts sub 301 "301 · schema" --from "Sonnet 5.5"`',
    '`node <repo>/scripts/board.ts sub 301 "301 · reader" --from "Sonnet 5.5"`', "scope: the schema", "scope: the reader", "branch: issue-301-reader",
    "read first: src/duck/sync.ts", "`### From Claude (Sonnet 5.5)`", ".claude/skills/pr-persistent/SKILL.md", "too big: two pieces", "comment once on #301"]) {
    assert.ok(p.includes(s), `the split prompt says ${s}`);
  }
  assert.equal(p.split("[stacked on the one before]").length - 1, 1, "the second piece alone is stacked");
  assert.ok(p.includes("\n2. 301 · reader [stacked on the one before]\n") && p.includes("\n1. 301 · schema\n"), "on the reader, in order");
  const { label: _l, phase: _p, schema, ...on } = r.calls.find((c) => c.opts.label === "split")!.opts;
  assert.deepEqual(on, { model: "sonnet", effort: "low" }, "Sonnet, low effort, no isolation: it writes no code");
  assert.deepEqual((schema as { required: string[] }).required, ["subIssues"]);
  for (const cmd of commandsOf(p)) assert.deepEqual(unplain(cmd), [], `\`${cmd}\` is plain`);

  // with repo, the commands are the checkout's own
  const withRepo = await run("pr-loop-slim", { ...PR, repo: "/srv/checkout" }, { brief: SPLIT_BRIEF, split: { subIssues: [401, 402] } });
  assert.ok(withRepo.prompt("split").includes('`node /srv/checkout/scripts/board.ts sub 301 "301 · schema" --from "Sonnet 5.5"`'));
});

test("pr-loop-slim split: a split answer that is not one sub-issue a piece stops the run as failed; a split of one piece is no split", async () => {
  for (const answer of [{ subIssues: [401] }, null, { subIssues: [401, 0] }, { subIssues: [401, 402, 403] }]) {
    const r = await run("pr-loop-slim", { ...PR }, { brief: SPLIT_BRIEF, split: answer });
    assert.match(String(r.result["status"]), /^split failed: /, JSON.stringify(answer));
    assert.ok(String(r.result["status"]).includes("#301"), "it says where to look");
    assert.deepEqual(r.labels, ["brief", "split"], `${JSON.stringify(answer)}: no implement`);
    assert.deepEqual(shapeOf(r.result), RESULT_KEYS);
  }
  // one piece: no split stage, nothing implemented from a brief that may be empty
  const one = await run("pr-loop-slim", { ...PR }, { brief: { ...SPLIT_BRIEF, split: [PIECES[0]] } });
  assert.deepEqual(one.labels, ["brief"]);
  assert.match(String(one.result["status"]), /a split of one piece is no split/);
  assert.deepEqual(shapeOf(one.result), RESULT_KEYS);
  assert.deepEqual([one.result["pr"], one.result["head"]], [null, null]);
});

test("pr-loop-slim split: opt-in, so a Brief with no split, or an empty one, runs exactly as before; a given brief may split", async () => {
  const rest: Answers = { "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green };
  const today = await run("pr-loop-slim", { ...PR }, { ...SLIM, ...rest });
  assert.ok(!("split" in (START["brief"] as object)), "today's brief has no split key");
  const empty = await run("pr-loop-slim", { ...PR }, { ...SLIM, brief: { ...(START["brief"] as object), split: [] }, ...rest });
  for (const r of [empty]) {
    assert.deepEqual(r.labels, today.labels);
    assert.ok(!r.labels.includes("split"));
    for (const [i, c] of r.calls.entries()) assert.equal(c.prompt, today.calls[i]!.prompt, `"${c.opts.label}" is the same prompt`);
    assert.equal(r.result["status"], today.result["status"]);
  }
  assert.deepEqual(today.labels.slice(0, 4), ["brief", "implement", "link", "review r1"]);
  // a brief given in args with a split goes to the split stage, with no Brief stage
  const given = await run("pr-loop-slim", { ...PR, brief: SPLIT_BRIEF }, { split: { subIssues: [401, 402] } });
  assert.deepEqual(given.labels, ["split"]);
  assert.match(String(given.result["status"]), /^split into 2 pieces: #401, #402 \(stacked on #401\)/);
  // a given split whose piece is not a piece is not a brief
  const bad = await run("pr-loop-slim", { ...PR, brief: { ...SPLIT_BRIEF, split: [{ title: "x" }, PIECES[1]] } }, {});
  assert.deepEqual(bad.labels, []);
  assert.match(String(bad.result["status"]), /^args\.brief is not a brief/);
});

test("pr-loop-slim split: the Brief's schema is one plain object whose split is optional, and its prompt says when to split", async () => {
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  const schema = r.calls.find((c) => c.opts.label === "brief")!.opts.schema as
    { type: string; required: string[]; oneOf?: unknown; anyOf?: unknown; properties: Record<string, { type: string; items: { type: string; required: string[] } }> };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["brief", "shapes", "tests"], "split is optional");
  assert.ok(!("oneOf" in schema) && !("anyOf" in schema), "render.mjs's problem() and the Workflow tool read a plain object schema");
  const split = schema.properties["split"]!;
  assert.equal(split.type, "array");
  assert.equal(split.items.type, "object");
  assert.deepEqual(split.items.required, ["title", "branch", "scope", "stacked", "readFirst"], "issue-loop's TASKS item, moved");
  const p = r.prompt("brief");
  assert.match(p, /SPLIT only when the issue's "Done looks like" cannot ship as ONE PR small enough for one review, with its own tests/);
  assert.match(p, /two pieces or more, in order/);
  assert.match(p, /`shapes` and `tests` may be empty/);
  // the race is over: Learn's time is the run log's, and the script names no race
  const learn = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": green });
  assert.doesNotMatch(learn.prompt("learn"), /the race/);
  assert.match(learn.prompt("learn"), /the run log reads Learn's time apart/);
  const m = meta("pr-loop-slim") as Meta & { whenToUse?: string };
  for (const t of [m.description, m.whenToUse ?? ""]) assert.doesNotMatch(t, /\brace\b|raced|issue 176/i, t);
  assert.match(m.description, /pr-persistent/, "it says it is the skill's source");
});

test("pr-loop-slim split, through render.mjs: a brief result with a split renders the split stage, and its answer the DONE", () => {
  const { brief: _brief, ...args } = RACE_ARGS;
  // the Brief's own answer, recorded as a file, with two pieces
  const split = renderStage(args, { brief: SPLIT_BRIEF });
  assert.equal(split.out, `STAGE "split" (Split) ${JSON.stringify({ model: "sonnet", effort: "low" })}: ${path.join(split.dir, "next", "split.md")}\n`);
  onlyControlLines(split, "split");
  assert.match(split.files["split.md"]!, /scripts\/board\.ts sub 301 "301 · reader" --from "Sonnet 5\.5"/);
  // the split stage's answer: the DONE, its status in result.json
  const done = renderStage(args, { brief: SPLIT_BRIEF, split: { subIssues: [401, 402] } });
  assert.equal(done.out, "DONE: split into 2 pieces: #401, #402 (stacked on #401); the plan is on #301: the top session starts each as a run\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(done.dir, "result.json"), "utf8")).status, done.out.slice("DONE: ".length).trim());
  // a piece without `stacked` fails the Brief's schema: a failed agent, and the run stops there
  const { stacked: _s, ...noStacked } = PIECES[1]!;
  const bad = renderStage(args, { brief: { ...SPLIT_BRIEF, split: [PIECES[0], noStacked] } });
  assert.match(bad.out, /^NULL "brief": answer\.split\[1\]\.stacked is missing; read as null/m);
  assert.match(bad.out, /^DONE: brief failed$/m);
});

test("the repo records one process: CLAUDE.md names the skills and the one workflow, and who merges what (issue 386)", () => {
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  for (const s of ["pr-loop.js", "issue-loop.js", "raced", "experimental process"]) assert.ok(!claude.includes(s), `CLAUDE.md no longer says ${s}`);
  for (const s of [".claude/skills/pr-persistent/SKILL.md", ".claude/skills/up-next/SKILL.md", ".claude/workflows/pr-loop-slim.js"]) assert.ok(claude.includes(s), `CLAUDE.md names ${s}`);
  const who = /^- \*\*Who merges what\*\*[\s\S]*?(?=^- \*\*)/m.exec(claude)?.[0] ?? "";
  assert.ok(who.includes("release-notes/next.md"), "a product change's line in release-notes/next.md");
  assert.match(who.replace(/\s+/g, " "), /A release and a deploy merge on the owner's word/);
  assert.doesNotMatch(who.replace(/\s+/g, " "), /a PR that changes `src\/`[^.]*merge on the owner's word/i, "a src/ PR no longer waits on the owner");
  assert.match(who, /--match-head-commit|merge-head\.ts/, "its detector stays");
});

// ---------------------------------------------------------------- issue 246: five rough edges in the prompts of the
// review at scale (PR 245's review), each held here on pr-loop-slim, whose review is the retired pr-loop's word for word.

/** A statement's text with every parenthesised group emptied, so only its top level is left: `count(*)` reads `count()`. */
const topLevel = (sql: string): string => {
  let s = sql;
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/\([^()]*\)/g, "()"); }
  return s;
};
const AGGREGATES = /^(count|sum|max|min|avg|bool_and|bool_or|every)\(\)$/i;
/** True when Postgres fixes the statement's row order: a top-level ORDER BY, or a single row (aggregates, no GROUP BY). */
function orderIsFixed(sql: string): boolean {
  const top = topLevel(sql);
  if (/\bORDER BY\b/i.test(top)) return true;
  if (/\b(GROUP BY|UNION|EXCEPT|INTERSECT)\b/i.test(top)) return false;
  const lists = [...top.matchAll(/\bSELECT\s+(.*?)\s+FROM\b/gi)];
  const list = lists.at(-1)?.[1];
  return list !== undefined && list.split(",").every((x) => AGGREGATES.test(x.trim()));
}

test("variant forms: every statement fixes its row order, so a DIFFER is never chance (issue 246)", () => {
  // the rule's own cases, so a reading that passes everything fails here
  for (const s of ["SELECT count(*), sum(c), max(b) FROM t WHERE false", "WITH q AS (SELECT c / 7 AS x FROM t) SELECT sum(x), max(x) FROM q", "TABLE t ORDER BY 1 LIMIT 2",
    "(SELECT a FROM t ORDER BY a LIMIT 1) UNION ALL (SELECT a FROM t ORDER BY a DESC LIMIT 1) ORDER BY 1"]) assert.ok(orderIsFixed(s), s);
  for (const s of ["VALUES (1), (NULL) EXCEPT SELECT a FROM t", "SELECT a FROM t", "SELECT count(*) FROM t GROUP BY a", "(SELECT a FROM t ORDER BY a) UNION SELECT b FROM t",
    "SELECT x FROM (SELECT a AS x FROM t ORDER BY a) s"]) assert.ok(!orderIsFixed(s), s);
  const forms = arrayOf("pr-loop-slim", "VARIANT_FORMS");
  const sql = forms.flatMap((v) => [...v.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
  assert.ok(sql.includes("VALUES (1), (NULL) EXCEPT SELECT a FROM t ORDER BY 1"), "the VALUES arm's EXCEPT carries its ORDER BY");
  assert.ok(!sql.includes("VALUES (1), (NULL) EXCEPT SELECT a FROM t"));
  for (const s of sql) assert.ok(orderIsFixed(s), `"${s}" leaves its row order to chance: give it a top-level ORDER BY`);
});

// what every prompt that runs duck-repro is told of `psql`, with or without itEnv
const PSQL_ON_PATH = /scripts\/duck-repro\.ts needs `psql` on PATH[^\n]*`brew install libpq`[^\n]*`postgresql-client`[^\n]*the postgres:18 container does not supply it/;
const SLIM_CI_FIX: Answers = { "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": red, "CI fix 1": { ...pushed("c"), flake: false }, "review r3": clean, "CI 2": green };

test("pr-loop-slim: every prompt that runs statements through duck-repro says `psql` must be on PATH, with or without itEnv (issue 246)", async () => {
  for (const args of [{ ...PR }, { ...PR, itEnv: "/srv/it.env" }]) {
    const slim = await run("pr-loop-slim", args, { ...SLIM, ...SLIM_CI_FIX });
    for (const l of ["implement", "fix r1", "CI fix 1", "review r1", "review r3"]) assert.match(slim.prompt(l), PSQL_ON_PATH, `pr-loop-slim "${l}" ${JSON.stringify(args)}`);
  }
  // the stop's text is built from the same sentence, and still says all a reader needs to install
  const r = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": { ...clean, statementsRun: 0, statementsMatched: 0 } });
  const status = String(r.result["status"]);
  assert.match(status, /^unreviewed: review r1 ran no statement for src\/duck\/plan\.ts/);
  assert.match(status, PSQL_ON_PATH);
  for (const s of ["`psql` on PATH", "brew install libpq", "postgresql-client", "Docker running", "itEnv"]) assert.ok(status.includes(s), s);
  for (const name of PR_LOOPS) assert.equal(source(name).match(/brew install libpq/g)?.length, 1, `${name}: the fact lives in one place`);
});

test("duck-repro: a missing psql says so, names PATH and how to install it, never `psql: ` and nothing (issue 246)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-repro-nopsql-"));
  try {
    const bin = path.join(dir, "empty-bin");
    fs.mkdirSync(bin);
    for (const f of ["ddl.sql", "stmts.sql"]) fs.writeFileSync(path.join(dir, f), "SELECT 1\n");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "duck-repro.ts"), path.join(dir, "ddl.sql"), path.join(dir, "stmts.sql")], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { PATH: bin, IT_POSTGRES_URL: "postgres://x:y@127.0.0.1:1/x" },
    });
    assert.equal(r.error, undefined, `the script ran within its bound: ${String(r.error)}`);
    assert.notEqual(r.status, 0, "it fails");
    assert.doesNotMatch(r.stderr, /psql: *(\n|$)/, "never `psql: ` with nothing after it");
    assert.match(r.stderr, /`psql`/, "it names psql");
    assert.match(r.stderr, /\bPATH\b/, "and PATH");
    assert.match(r.stderr, /brew install libpq[^\n]*postgresql-client/, "and how to install it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-loop-slim: no `docker inspect` prints the container's environment, and NEVER_PRINT forbids one that would (issue 246)", async () => {
  for (const name of PR_LOOPS) {
    const answers: Answers = { ...SLIM, "review r1": clean, "CI 1": green };
    const labels = ["implement", "review r1"];
    for (const args of [{ ...PR }, { ...PR, itEnv: "/srv/it.env" }] as Array<Record<string, unknown>>) {
      const r = await run(name, args, answers);
      for (const l of labels) {
        const p = r.prompt(l);
        const what = `${name} "${l}" ${JSON.stringify(args)}`;
        assert.match(p, /Never print, echo or log the URL or its password/, what);
        assert.match(p, /never a `docker inspect` without a `--format` naming one field[^\n]*Config\.Env[^\n]*POSTGRES_PASSWORD/, `${what}: NEVER_PRINT forbids it`);
        if (args.itEnv) continue;
        // every docker inspect the prompt has an agent run (a backticked command with a target) prints one field
        const uses = [...p.matchAll(/`(docker inspect [^`]+)`/g)].map((m) => m[1]!);
        assert.ok(uses.length > 0, `${what}: the removal check is there`);
        for (const u of uses) assert.match(u, /^docker inspect --format '\{\{\.[A-Za-z.]+\}\}' <name>$/, `${what}: "${u}" prints one field, never Config.Env`);
        assert.match(p, /`node \S+\/scripts\/review-postgres\.ts stop <name>`, which removes it, checks that `docker inspect --format '\{\{\.State\.Status\}\}' <name>` then fails, and deletes the env file/, what);
      }
    }
  }
});

test("pr-loop-slim: a narrow re-check's regression sweep covers the fix's own code only; the full review's is unchanged (issue 246)", async () => {
  const OWN = /Its REGRESSION SWEEP covers the fix's own code only, the code `git diff (\w+) (\w+)` changed: what earlier rounds judged correct outside that code is not re-checked, and inside it the sweep runs it again/;
  const full = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  const slim = await run("pr-loop-slim", { ...PR }, { ...SLIM, ...SLIM_CI_FIX });
  for (const [x, l, from, to] of [[full, "review r2", "a", "b"], [slim, "review r2", "a", "b"], [slim, "review r3", "f", "c"]] as const) {
    const m = OWN.exec(x.prompt(l));
    assert.ok(m, `"${l}" says its sweep covers the fix's own code only`);
    assert.deepEqual([m[1], m[2]], [sha(from), sha(to)], `"${l}": the code since the previous head`);
    assert.match(x.prompt(l), /Already judged correct, so do NOT re-check/, l);
  }
  for (const x of [full, slim]) {
    assert.doesNotMatch(x.prompt("review r1"), /covers the fix's own code only/, "the full review is not narrowed");
    assert.match(x.prompt("review r1"), /hundreds of statements/);
  }
});

test("pr-loop-slim: `e` keeps its PRIMARY KEY, since duck-repro syncs only a table with a key (issue 246)", async () => {
  const E = /`t \(id int PRIMARY KEY, a int, b text, c numeric\(10,2\), d char\(4\)\)`[^\n]*`e`, an empty table of the same shape, its PRIMARY KEY included \(duck-repro syncs only a table with a key\)/;
  const full = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  for (const l of ["implement", "review r1", "fix r1", "review r2"]) assert.match(full.prompt(l), E, `pr-loop-slim "${l}"`);
  const slim = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": clean, "CI 1": green });
  for (const l of ["implement", "review r1"]) assert.match(slim.prompt(l), E, `pr-loop-slim "${l}"`);
});

// ---------------------------------------------------------------- issue 264: no review ever timed a statement's plan, so
// PR 202's planner walk that grew 3^depth reached its 14th round before a reviewer happened on it. One variant form is
// DEEP, and it is timed at the head and at the base as well as compared: a head much slower is a regression, and blocks.
test("variant forms: a deep form, timed at the head and at the base; a head much slower blocks (issue 264)", async () => {
  const forms = arrayOf("pr-loop-slim", "VARIANT_FORMS");
  const deep = forms.filter((v) => /^a DEEP form/.test(v));
  assert.equal(deep.length, 1, "one deep form");
  const sql = [...deep[0]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  // the unit test's own statements at its top depth, so the review executes what the planner's test bounds
  const top = PLAN_TIME_DEPTHS.at(-1)!;
  const shapes = deepShapes(top);
  assert.deepEqual(sql, [shapes["order by and limit"], shapes["union, a bound at every level"]], "the deep form is deepShapes' at the top depth");
  assert.ok(sql[0]!.split("FROM (").length - 1 >= top, `the nested statement is ${top} levels deep`);
  assert.ok(sql[1]!.split("UNION ALL").length - 1 >= top, `the UNION ALL chain is ${top} levels deep`);
  // each level reads the one below three times, in a way no depth overflows or grows: never a + a + a or b || b || b
  for (const s of sql) assert.ok(s.includes("a + a - a") && !/a \+ a \+ a|\|\|/.test(s), s);
  // and every level is bounded, so Postgres never pulls it up into the next (its own pull-up grows 3^depth, and took
  // down a Postgres at depth 11): a derived table without a bound would make the review's Postgres the thing that dies
  for (const s of sql) assert.equal(s.split("LIMIT 100").length - 1, top, s);

  const TIMING = [/TIME the DEEP form too[^\n]*run once at the head and once at the base/,
    /`node --env-file=<env file> \S+\/scripts\/duck-repro-bounded\.ts 300 <tree> <ddl\.sql> <deep\.sql> > <out> 2>&1` \(it runs that tree's duck-repro, prints the run's pid first and its `real` time last, and past the 300 s bound kills the run and exits 124\)/,
    /more than twice the base's AND more than 30 s longer is blocking, severity regression, origin this-pr/,
    /a head killed by the bound or dead \(out of memory\) where the base finished is a hang, severity crash/,
    /`duck_repro_<pid>` by the pid it printed first, never by a pattern/];
  const WIDE = "regression (what the base got right is now wrong, refused, or much slower (the deep form's time))";
  const full = await run("pr-loop-slim", { ...PR }, { ...SLIM, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green });
  const slim = await run("pr-loop-slim", { ...PR }, { ...SLIM, ...SLIM_CI_FIX });
  for (const [r, labels, reviews] of [[full, ["implement", "review r1", "fix r1", "review r2"], ["review r1", "review r2"]],
    [slim, ["implement", "fix r1", "CI fix 1", "review r1", "review r3"], ["review r1", "review r3"]]] as const) {
    for (const l of labels) {
      const p = r.prompt(l);
      assert.ok(p.includes(deep[0]!), `${l}: the deep form, verbatim`);
      for (const re of TIMING) assert.match(p, re, `${l}: the timing`);
    }
    for (const l of reviews) {
      assert.ok(r.prompt(l).includes(WIDE), `${l}: a much slower head is a regression`);
      const schema = JSON.stringify(r.calls.find((c) => c.opts.label === l)!.opts.schema);
      assert.ok(schema.includes("regression: what the base got right is now wrong, refused, or much slower (the deep form's time);"), `${l}: the findings schema's regression`);
    }
  }
  // the doc says what the harness does
  assert.ok(fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "CLAUDE.md"), "utf8").includes(`a ${WIDE}`), "CLAUDE.md 'The loop' step 4");
});

// ---------------------------------------------------------------- issue 322: a command the harness writes out for an
// agent is refused by Claude Code's worktree guard, in an agent that runs isolated in a worktree (or inherits a lead's),
// so each agent improvised its own: the CI wait's $SECONDS loop, a sourced env file, the throwaway Postgres's shell
// line, `git -C <repo> worktree add "$(mktemp -d)/head"`, the Record stage's `f=$(mktemp)`, the skill's `node
// "$RUN/render.mjs"`. Every command an agent is told to run is PLAIN: one program with literal arguments, at most its
// output redirected to a file; what needs logic is a script under scripts/.

/** A backticked span that is a shell command (a program or a shell construct first), not a name, a flag or SQL. */
const SHELL_START = /^(?:\((?!\s*(?:SELECT|VALUES|WITH|TABLE)\b)|\.\s|source\s|\$|[A-Za-z_]\w*=|\/usr\/bin\/time\b|(?:for|while|until|if|git|gh|node|npm|npx|docker|psql|grep|cd|mktemp|umask|perl|mkdir|cp|mv|cat|sleep|rm|date|openssl|bash|sh|seq)\b)/;
/** What the guard refuses in an isolated agent, each with its name. */
const UNPLAIN: Array<[RegExp, string]> = [
  [/\$\(/, "a command substitution, $(…) or $((…))"],
  [/<</, "a heredoc or a here-string"],
  [/\b(?:while|until)\b|\bfor\s+\w+\s+in\b|;\s*do\b|;\s*done\b/, "a loop"],
  [/^\(|[;&|]\s*\(/, "a ( … ) subshell"],
  [/(?:^|[;&|(]\s*)(?:\.|source)\s+\S/, "a sourced file"],
  [/\$\{?[A-Za-z_]/, "a shell variable"],
  [/\bgit\s+-C\b/, "git -C"],
  // `gh api graphql -f query='query{…}'` was refused in issue 322's isolated implementer; gh issue view --json reads the same field
  [/\bgh\s+api\s+graphql\b/, "a GraphQL query"],
];
/** The shell commands a text tells its reader to run: each backticked span that is one, and each line of a ```sh block. */
function commandsOf(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)\n```/g)].flatMap((m) => m[1]!.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  const spans = [...text.replace(/```sh\n[\s\S]*?\n```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()).filter((s) => SHELL_START.test(s));
  return [...blocks, ...spans];
}
const unplain = (cmd: string): string[] => UNPLAIN.filter(([re]) => re.test(cmd)).map(([, why]) => why);

test("plain: no command a harness prompt or a skill tells an agent to run is one the worktree guard refuses (issue 322)", async () => {
  const base = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t" });
  const filed = { issues: [{ classKey: "base-class", source: "base", issue: 950, action: "filed" }, { classKey: "wording", source: "deferred", issue: 951, action: "filed" }] };
  const review1 = { findings: [finding({ classKey: "c-a", input: "SELECT a FROM t" }), base, later({ input: "SELECT later FROM t" })], judgedCorrect: [] };
  const SLIM_FULL: Answers = { ...SLIM, "review r1": review1, "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": red,
    "CI fix 1": { ...pushed("c"), flake: false, handoff: H1 }, "review r3": clean, "CI 2": green, file: filed };
  const bad = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const labels = new Set<string>();
  const note = (cmd: string, where: string): void => {
    seen.add(cmd);
    for (const why of unplain(cmd)) {
      const k = `${cmd.slice(0, 160)} [${why}]`;
      if (!bad.has(k)) bad.set(k, new Set());
      bad.get(k)!.add(where);
    }
  };
  for (const name of PR_LOOPS) {
    for (const repo of [undefined, ROOT]) {
      for (const itEnv of [undefined, "/srv/it.env"]) {
        const args: Record<string, unknown> = { ...PR, ...(repo ? { repo } : {}), ...(itEnv ? { itEnv } : {}) };
        // a full run, and a run that reaches the split stage (issue 386), so the split prompt's commands are read too, and one that merges its base (issue 452)
        for (const answers of [SLIM_FULL, MERGE_RUN, { brief: SPLIT_BRIEF, split: { subIssues: [401, 402] } }]) {
          const r = await run(name, args, answers);
          for (const c of r.calls) {
            labels.add(`${name}: ${c.opts.label.replace(/\d+/g, "n")}`);
            for (const cmd of commandsOf(c.prompt)) note(cmd, `${name} "${c.opts.label}"${repo ? " repo" : ""}${itEnv ? " itEnv" : ""}`);
          }
        }
      }
    }
  }
  for (const cmd of commandsOf(skillText())) note(cmd, "pr-persistent SKILL.md");
  for (const cmd of commandsOf(upNextText())) note(cmd, "up-next SKILL.md");
  assert.deepEqual([...bad].map(([k, w]) => `${k} in ${[...w].slice(0, 3).join(", ")}${w.size > 3 ? ` and ${w.size - 3} more` : ""}`), [],
    "a command an agent is told to run that Claude Code's worktree guard refuses in an isolated agent: make it one program with literal arguments, its logic in a script under scripts/");
  // every stage was rendered, and the commands the decision names are read, so the check is not vacuous
  for (const l of ["brief", "split", "implement", "link", "review rn", "fix rn", "CI read rn", "learn", "learn check", "CI n", "CI fix n", "merge n", "file", "record"]) {
    assert.ok(labels.has(`pr-loop-slim: ${l}`), `pr-loop-slim's ${l} was rendered`);
  }
  for (const cmd of ["node <repo>/scripts/ci-wait.ts 900 540", "mktemp -d", "git worktree add --detach <that path>/head <sha>", "git worktree remove <that path>/head",
    "node --env-file=<env file> <tree>/scripts/duck-repro.ts <ddl.sql> <statements.sql> > <out> 2>&1", "node <repo>/scripts/review-postgres.ts start",
    "node <repo>/scripts/review-postgres.ts stop <name>", "node --env-file=<env file> <repo>/scripts/duck-repro-bounded.ts 300 <tree> <ddl.sql> <deep.sql> > <out> 2>&1",
    "mktemp", "gh pr comment 900 --body-file <that path>", "gh issue view 301 --json closedByPullRequestsReferences", "node <run folder>/render.mjs", "node <repo>/scripts/wait-file.ts <path> 1800", "git rev-parse origin/<base>",
    'node <repo>/scripts/board.ts status 301 "In progress"', 'node <repo>/scripts/board.ts sub 301 "301 · schema" --from "Sonnet 5.5"',
    "gh pr merge <n> --auto --merge --match-head-commit <sha>", 'node <repo>/scripts/board.ts status <n> "Implementing"',
    "node <repo>/scripts/gh-text.ts issue 300", "node <repo>/scripts/gh-text.ts body 900", 'node <repo>/scripts/gh-text.ts comment-id 900 "## Handoff"',
    'node <repo>/scripts/gh-text.ts search "<words>"', "node <repo>/scripts/gh-text.ts author <n>", "node <repo>/scripts/gh-text.ts issue <n>", MERGE_CMD, "git push origin HEAD:issue-300-a-piece", "git ls-remote origin refs/heads/issue-300-a-piece", "node <repo>/scripts/ci-wait.ts <n> 540"]) {
    assert.ok(seen.has(cmd), `the check reads \`${cmd}\``);
  }
  // and it catches each form the guard refused, as origin/main wrote them
  for (const [cmd, why] of [
    ["p=900; end=$((SECONDS + 540)); while [ $SECONDS -lt $end ]; do sleep 10; done", "a loop"],
    ["(. /srv/it.env && cd <tree> && node scripts/duck-repro.ts <ddl.sql> <statements.sql>) > <out> 2>&1", "a sourced file"],
    ["umask 077; n=mason-review-$(openssl rand -hex 4)", "a command substitution, $(…) or $((…))"],
    ["git -C /repo worktree add \"$(mktemp -d)/head\" <sha>", "git -C"],
    ["f=$(mktemp)", "a command substitution, $(…) or $((…))"],
    ["node \"$RUN/render.mjs\"", "a shell variable"],
    ["mg=$(gh pr view 900) ; grep -q x <<<\"$mg\"", "a heredoc or a here-string"],
    ["gh api graphql -f query='query{repository(owner:\"o\",name:\"r\"){issue(number:1){id}}}'", "a GraphQL query"],
  ]) {
    assert.equal(commandsOf(`\`${cmd}\``).length, 1, `${cmd} is read as a command`);
    assert.ok(unplain(cmd!).includes(why!), `${cmd}: ${why}`);
  }
  for (const sql of ["(SELECT a FROM t ORDER BY a LIMIT 1) UNION ALL (SELECT a FROM t ORDER BY a DESC LIMIT 1) ORDER BY 1", "SELECT a FROM t"]) assert.deepEqual(commandsOf(`\`${sql}\``), [], "SQL is no command");
});

test("plain: Node's --env-file reads an env file written either way, `export IT_POSTGRES_URL=…` and `IT_POSTGRES_URL=…`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-file-"));
  try {
    const url = "postgres://u:p@127.0.0.1:5/postgres";
    for (const [file, text] of [["export.env", `export IT_POSTGRES_URL=${url}\n`], ["bare.env", `IT_POSTGRES_URL=${url}\n`]] as const) {
      fs.writeFileSync(path.join(dir, file), text);
      const r = spawnSync(process.execPath, [`--env-file=${path.join(dir, file)}`, "-e", "process.stdout.write(process.env.IT_POSTGRES_URL ?? 'unset')"], { encoding: "utf8", env: { PATH: process.env["PATH"] } });
      assert.equal(r.stdout, url, `${file}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A stub program in `dir`, a Node script logging its argv and the environment the tests look at, then `body`. */
function stubBin(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
fs.appendFileSync(dir + "/${name}.log", JSON.stringify({ argv: a, env: { POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD, PGPASSWORD: process.env.PGPASSWORD, PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGUSER: process.env.PGUSER, PGDATABASE: process.env.PGDATABASE } }) + "\\n");
${body}
`, { mode: 0o755 });
}
const logOf = (dir: string, name: string): Array<{ argv: string[]; env: Record<string, string | undefined> }> =>
  fs.existsSync(path.join(dir, `${name}.log`)) ? fs.readFileSync(path.join(dir, `${name}.log`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("plain: review-postgres starts a throwaway postgres:18 and stops it, its password never in argv, stdout or a file others read", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-pg-")));
  const tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp);
  const SCRIPT = path.join(ROOT, "scripts", "review-postgres.ts");
  try {
    stubBin(dir, "docker", `const state = dir + "/state";
if (a[0] === "run") { fs.writeFileSync(state, "running"); process.stdout.write("c0ffee\\n"); process.exit(0); }
if (a[0] === "port") { process.stdout.write("127.0.0.1:54321\\n"); process.exit(0); }
if (a[0] === "exec") { const n = (fs.existsSync(dir + "/ready") ? 1 : 0); fs.writeFileSync(dir + "/ready", "1"); process.exit(n ? 0 : 2); }
if (a[0] === "rm") { fs.writeFileSync(state, "gone"); process.exit(0); }
if (a[0] === "inspect") { if (fs.readFileSync(state, "utf8") === "running") { process.stdout.write("running\\n"); process.exit(0); } process.stderr.write("Error: No such object\\n"); process.exit(1); }
process.exit(9);`);
    const env = { PATH: `${dir}:${process.env["PATH"]}`, TMPDIR: tmp, REVIEW_POSTGRES_POLL_MS: "0" };
    const start = spawnSync(process.execPath, [SCRIPT, "start"], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(start.status, 0, start.stderr);
    const name = /^container (mason-review-[0-9a-f]{8})$/m.exec(start.stdout)?.[1];
    assert.ok(name, start.stdout);
    const envFile = /^env file (\S+)$/m.exec(start.stdout)?.[1];
    assert.equal(envFile, path.join(tmp, `${name}.env`));
    assert.equal(fs.statSync(envFile!).mode & 0o077, 0, "the env file is its owner's alone");
    const text = fs.readFileSync(envFile!, "utf8");
    const pw = /^export IT_POSTGRES_URL=postgres:\/\/postgres:([0-9a-f]{32})@127\.0\.0\.1:54321\/postgres\n$/.exec(text)?.[1];
    assert.ok(pw, "the env file holds the URL, on the free port docker gave");
    const runCall = logOf(dir, "docker").find((c) => c.argv[0] === "run")!;
    assert.equal(runCall.env["POSTGRES_PASSWORD"], pw, "the password is passed by the environment");
    for (const c of logOf(dir, "docker")) assert.ok(!c.argv.join(" ").includes(pw!), `never in argv: docker ${c.argv.join(" ")}`);
    assert.ok(!start.stdout.includes(pw!) && !start.stderr.includes(pw!) && !start.stdout.includes("postgres://"), "the URL is never printed");
    const argv = runCall.argv.join(" ");
    for (const s of ["-d --rm --name " + name, "-e POSTGRES_PASSWORD -p 127.0.0.1:0:5432", "--entrypoint timeout postgres:18 --kill-after=30 7200 docker-entrypoint.sh postgres -c wal_level=logical"]) assert.ok(argv.includes(s), `docker run … ${s}`);
    assert.equal(logOf(dir, "docker").filter((c) => c.argv[0] === "exec").length, 2, "it waited for pg_isready");
    const stop = spawnSync(process.execPath, [SCRIPT, "stop", name!], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(!fs.existsSync(envFile!), "the env file is deleted");
    const calls = logOf(dir, "docker").map((c) => c.argv.join(" "));
    assert.ok(calls.includes(`rm -f -v ${name}`), "removed");
    for (const c of calls.filter((x) => x.startsWith("inspect"))) assert.equal(c, `inspect --format {{.State.Status}} ${name}`, "inspect prints one field, never Config.Env");
    // still there after rm: stop says so, non-zero
    stubBin(dir, "docker", `if (a[0] === "inspect") { process.stdout.write("running\\n"); process.exit(0); } process.exit(0);`);
    const stuck = spawnSync(process.execPath, [SCRIPT, "stop", name!], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(stuck.status, 3, stuck.stderr);
    assert.match(stuck.stderr, /is not gone/);
    // without Docker it says so, and how to go on
    const none = spawnSync(process.execPath, [SCRIPT, "start"], { encoding: "utf8", env: { ...env, PATH: tmp }, timeout: 60_000 });
    assert.equal(none.status, 3, none.stderr);
    assert.match(none.stderr, /could not run docker[^\n]*itEnv/);
    for (const bad of [["stop"], ["stop", "postgres"], ["go"]]) assert.equal(spawnSync(process.execPath, [SCRIPT, ...bad], { encoding: "utf8", env }).status, 2, bad.join(" "));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plain: duck-repro-bounded prints the run's pid first and its real time last; past the bound it kills the run and drops that run's database", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repro-bounded-")));
  const SCRIPT = path.join(ROOT, "scripts", "duck-repro-bounded.ts");
  try {
    // a tree whose duck-repro says its own pid, then answers or never returns, as its statements file says
    fs.mkdirSync(path.join(dir, "tree", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tree", "scripts", "duck-repro.ts"), `import * as fs from "node:fs";
process.stdout.write("mypid " + process.pid + "\\n");
if (fs.readFileSync(process.argv[3]!, "utf8").includes("hang")) setInterval(() => {}, 1000);
else process.stdout.write("SAME 1\\n");
`);
    fs.writeFileSync(path.join(dir, "ddl.sql"), "CREATE TABLE t (id int PRIMARY KEY)\n");
    fs.writeFileSync(path.join(dir, "ok.sql"), "SELECT 1\n");
    fs.writeFileSync(path.join(dir, "hang.sql"), "-- hang\n");
    fs.writeFileSync(path.join(dir, "it.env"), "export IT_POSTGRES_URL=postgres://u:s3cret@127.0.0.1:5/postgres\n");
    stubBin(dir, "psql", "process.exit(0);");
    const env = { PATH: `${dir}:${process.env["PATH"]}` };
    const go = (stmts: string, secs = "1") => spawnSync(process.execPath, [`--env-file=${path.join(dir, "it.env")}`, SCRIPT, secs, path.join(dir, "tree"), path.join(dir, "ddl.sql"), path.join(dir, stmts)], { encoding: "utf8", env, timeout: 60_000 });
    const ok = go("ok.sql", "30");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /SAME 1/);
    assert.match(ok.stderr, /^pid (\d+)\n(?:[^\n]*\n)*real \d+\.\d\d\n$/, ok.stderr);
    assert.equal(/^pid (\d+)/.exec(ok.stderr)![1], /mypid (\d+)/.exec(ok.stdout)![1], "the pid printed is the run's own");
    assert.equal(logOf(dir, "psql").length, 0, "a run that finished leaves nothing to drop");
    const hung = go("hang.sql");
    assert.equal(hung.status, 124, hung.stderr);
    const pid = /^pid (\d+)/.exec(hung.stderr)?.[1];
    assert.equal(pid, /mypid (\d+)/.exec(hung.stdout)?.[1], "the pid printed first is the run's own");
    assert.match(hung.stderr, /killed: past the bound of 1 s\n/);
    assert.match(hung.stderr, new RegExp(`dropped duck_repro_${pid}\\n`));
    assert.match(hung.stderr, /\nreal 1\.\d\d\n$/, "the real time, last");
    const drop = logOf(dir, "psql");
    assert.equal(drop.length, 1);
    assert.ok(drop[0]!.argv.includes(`DROP DATABASE IF EXISTS duck_repro_${pid} WITH (FORCE)`), drop[0]!.argv.join(" "));
    assert.ok(!drop[0]!.argv.join(" ").includes("s3cret"), "the password never in psql's argv");
    assert.deepEqual([drop[0]!.env["PGPASSWORD"], drop[0]!.env["PGHOST"], drop[0]!.env["PGPORT"], drop[0]!.env["PGUSER"], drop[0]!.env["PGDATABASE"]], ["s3cret", "127.0.0.1", "5", "u", "postgres"]);
    assert.ok(!hung.stderr.includes("s3cret") && !hung.stdout.includes("s3cret"), "nor printed");
    // usage: without the URL, a bound out of range, or a tree with no duck-repro
    for (const [withEnv, args] of [[false, ["1", path.join(dir, "tree"), "a", "b"]], [true, ["0", path.join(dir, "tree"), "a", "b"]], [true, ["1", dir, "a", "b"]]] as const) {
      const r = spawnSync(process.execPath, [...(withEnv ? [`--env-file=${path.join(dir, "it.env")}`] : []), SCRIPT, ...args], { encoding: "utf8", env });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plain: wait-file exits 0 once its file is there and not empty, 8 at its bound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-file-"));
  const SCRIPT = path.join(ROOT, "scripts", "wait-file.ts");
  try {
    const target = path.join(dir, "result.json");
    fs.writeFileSync(target, "");
    const t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT, target, "20"], { env: { ...process.env, WAIT_FILE_INTERVAL_MS: "50" } });
    setTimeout(() => fs.writeFileSync(target, "{}"), 400);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 >= 350, "an empty file is not there yet");
    const late = spawnSync(process.execPath, [SCRIPT, path.join(dir, "never.json"), "1"], { encoding: "utf8", env: { ...process.env, WAIT_FILE_INTERVAL_MS: "50" }, timeout: 30_000 });
    assert.equal(late.status, 8, late.stderr);
    for (const args of [[], [target], [target, "0"], [target, "x"], [target, "7201"]]) assert.equal(spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }).status, 2, args.join(" "));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- issue 438: the agents read an issue's or a PR's
// people-written text (titles, bodies, comments, reviews, inline review comments, search results) only through
// scripts/gh-text.ts, which keeps OWNER, MEMBER and COLLABORATOR and names what it left out. Nothing here imports it
// statically, so at a commit without it each test fails by name instead of the file not loading.

const GH_TEXT = path.join(ROOT, "scripts", "gh-text.ts");
const REVIEW_STATS = path.join(ROOT, "scripts", "review-stats.ts");
/** The `--json` fields a prompt may ask `gh issue view` / `gh pr view` for: GitHub's own values, never people's words. */
const NOT_TEXT_FIELDS = new Set(["mergeable", "mergeStateStatus", "state", "headRefOid", "closedByPullRequestsReferences", "number", "url", "isDraft", "baseRefName", "headRefName", "statusCheckRollup"]);
/** Each `gh` command in a text (up to a backtick or a line's end) that reads an issue's or a PR's people-written text
 * other than through gh-text: a view with --comments, with a --json field that is not GitHub's own value, or of a number
 * with no --json at all (it prints the title and body); any list or search; a `gh api` GET of an issue, a PR, their
 * comments or reviews, or search. A write (`gh api -X PATCH …`), a diff, the checks and a run's log are let through. */
function textReads(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bgh\s+(issue|pr|api|search)\b[^`\n]*/g)) {
    const cmd = m[0];
    if (m[1] === "search") { out.push(cmd); continue; }
    if (m[1] === "api") {
      if (/\s(?:-X|--method)\s+(?:POST|PATCH|PUT|DELETE)\b/.test(cmd)) continue;
      if (/(?:^|\s)\/?(?:repos\/[^/\s]+\/[^/\s]+\/(?:issues|pulls)\b|search\/)/.test(cmd)) out.push(cmd);
      continue;
    }
    const verb = /^gh\s+\w+\s+(\w+)/.exec(cmd)?.[1];
    if (verb === "list") { out.push(cmd); continue; }
    if (verb !== "view") continue;
    if (/--comments\b/.test(cmd)) { out.push(cmd); continue; }
    const json = /--json[\s=]+(\S+)/.exec(cmd);
    if (json) { if (json[1]!.split(",").some((f) => !NOT_TEXT_FIELDS.has(f))) out.push(cmd); continue; }
    // a bare `gh pr view` names the command in prose; one given a number and no --json prints the title and body
    if (/^gh\s+\w+\s+view\s+(?:\d|<|\$\{)/.test(cmd)) out.push(cmd);
  }
  return out;
}

test("github text: no prompt or skill reads an issue's or a PR's text except through gh-text", async () => {
  // the matcher catches each form origin/main wrote, and lets GitHub's own values, the diff, the checks and the write through
  for (const main of ["gh issue view 300 --comments", "gh issue view <n> --json title", "gh pr view 900 --comments", "gh pr view 900 --json body",
    'gh issue list --state open --search "<words>"', "gh api repos/embeddable-hq/mason-data/issues/900/comments --jq '.[] | select(.body | contains(\"## Handoff\")) | .id'",
    "gh pr view 900", "gh issue view 7 --json title,closedByPullRequestsReferences", "gh search issues collaborators", "gh pr list --search x",
    "gh api repos/embeddable-hq/mason-data/pulls/900/reviews", "gh api --paginate repos/embeddable-hq/mason-data/pulls/900/comments", "gh api search/issues -f q=x"]) {
    assert.deepEqual(textReads(`\`${main}\``), [main], `the matcher catches \`${main}\``);
  }
  for (const ok of ["gh pr view 900 --json mergeable,mergeStateStatus", "gh pr view <n> --json state,mergeable", "gh issue view 301 --json closedByPullRequestsReferences",
    "gh pr diff <n>", "gh pr checks 900", "gh api -X PATCH repos/embeddable-hq/mason-data/issues/comments/<id> -F body=@<file>", "gh run view <run> --json jobs",
    "gh api repos/embeddable-hq/mason-data/actions/jobs/<id>/logs", "gh pr view <n> --json headRefOid --jq .headRefOid", "gh pr edit 900 --body-file <file>"]) {
    assert.deepEqual(textReads(`\`${ok}\``), [], `the matcher lets \`${ok}\` through`);
  }
  assert.deepEqual(textReads("the `gh pr view` line the chunk printed"), [], "a bare name in prose is no read");

  const base = finding({ origin: "base", classKey: "base-class", input: "SELECT base_only FROM t" });
  const filed = { issues: [{ classKey: "base-class", source: "base", issue: 950, action: "filed" }, { classKey: "wording", source: "deferred", issue: 951, action: "filed" }] };
  const review1 = { findings: [finding({ classKey: "c-a", input: "SELECT a FROM t" }), base, later({ input: "SELECT later FROM t" })], judgedCorrect: [] };
  const FULL: Answers = { ...SLIM, "review r1": review1, "fix r1": { ...pushed("b"), handoff: H1 }, "review r2": clean, "CI 1": red,
    "CI fix 1": { ...pushed("c"), flake: false, handoff: H1 }, "review r3": clean, "CI 2": green, file: filed };
  const NO_HANDOFF: Answers = { ...START, "review r1": f("a"), "fix r1": pushed("b"), "review r2": clean, "CI 1": green };
  const reads: string[] = [];
  const prompts = new Map<string, string[]>();
  for (const repo of [undefined, ROOT]) {
    for (const itEnv of [undefined, "/srv/it.env"]) {
      for (const stackedOn of ["", "899"]) {
        const args: Record<string, unknown> = { ...PR, stackedOn, ...(repo ? { repo } : {}), ...(itEnv ? { itEnv } : {}) };
        for (const answers of [FULL, NO_HANDOFF, { brief: SPLIT_BRIEF, split: { subIssues: [401, 402] } }]) {
          const r = await run("pr-loop-slim", args, answers);
          for (const c of r.calls) {
            const key = `${c.opts.label}${repo ? " repo" : ""}${stackedOn ? " stacked" : ""}${answers === NO_HANDOFF ? " no-handoff" : ""}`;
            prompts.set(key, [...(prompts.get(key) ?? []), c.prompt]);
            for (const x of textReads(c.prompt)) reads.push(`${key}: ${x}`);
          }
        }
      }
    }
  }
  for (const [name, text] of [["pr-persistent SKILL.md", skillText()], ["up-next SKILL.md", upNextText()]] as const) for (const x of textReads(text)) reads.push(`${name}: ${x}`);
  assert.deepEqual([...new Set(reads)], [], "an issue's or a PR's text is read only through scripts/gh-text.ts");

  // not vacuous: each stage that reads GitHub text is rendered and names gh-text, with the path the run gives
  const has = (key: string, s: string) => assert.ok((prompts.get(key) ?? []).some((p) => p.includes(s)), `"${key}" says ${s}`);
  has("brief", "node <repo>/scripts/gh-text.ts issue 300");
  has("brief repo", `node ${ROOT}/scripts/gh-text.ts issue 300`);
  has("fix r1 no-handoff", "node <repo>/scripts/gh-text.ts pr 900");
  has("fix r1 repo no-handoff", `node ${ROOT}/scripts/gh-text.ts pr 900`);
  for (const l of ["fix r1", "CI fix 1"]) has(l, "gh-text.ts body 900");
  for (const l of ["fix r1", "CI fix 1"]) {
    has(l, 'node <repo>/scripts/gh-text.ts comment-id 900 "## Handoff"');
    has(l, "gh api -X PATCH repos/embeddable-hq/mason-data/issues/comments/<id> -F body=@<file>");
  }
  for (const l of ["link", "link stacked", "learn"]) has(l, "node <repo>/scripts/gh-text.ts body 900");
  has("file", 'node <repo>/scripts/gh-text.ts search "<words>"');
  has("file", "node <repo>/scripts/gh-text.ts issue <n>");
  // every prompt carries the rule, so an agent that would read more of GitHub reads it the same way
  for (const [key, ps] of prompts) for (const p of ps) assert.ok(p.includes("scripts/gh-text.ts` (issue, pr, body, comment-id, search, author)"), `"${key}" carries the rule`);
  for (const [name, text] of [["pr-persistent", skillText()], ["up-next", upNextText()]] as const) {
    assert.ok(text.includes("node <repo>/scripts/gh-text.ts issue <n>"), `${name} reads an issue through gh-text`);
  }
});

type GhAnswer = { json?: unknown; pages?: unknown[][]; rc?: number; err?: string };
/** Runs a script with a stub `gh` first on PATH that answers `gh api <path>` from `routes` (keyed by the path without its
 * query; "*" answers any other), as gh does: a list read with --paginate gets every page, without it the first; `--jq
 * '.[]'` or `'.items[]'` prints one item a line, and review-stats' record filter is applied as its jq would. */
function runGh(script: string, args: string[], routes: Record<string, GhAnswer>): { rc: number | null; out: string; err: string; calls: string[][] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-text-"));
  try {
    fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify(routes));
    fs.writeFileSync(path.join(dir, "calls.log"), "");
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", JSON.stringify(a) + "\\n");
const routes = JSON.parse(fs.readFileSync(dir + "/routes.json", "utf8"));
const VALUE = new Set(["--jq", "-f", "-F", "-X", "--method", "-H"]);
let p = "";
for (let i = 1; i < a.length; i++) { if (VALUE.has(a[i])) { i++; continue; } if (!a[i].startsWith("-")) { p = a[i]; break; } }
const r = routes[p.split("?")[0]] || routes["*"];
if (a[0] !== "api" || !r) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
if (r.rc) { process.stderr.write((r.err || "gh: failed") + "\\n"); process.exit(r.rc); }
const v = r.pages ? (a.includes("--paginate") ? r.pages.flat() : r.pages[0]) : r.json;
const jq = a.includes("--jq") ? a[a.indexOf("--jq") + 1] : null;
let items = null;
if (jq === ".[]") items = v;
else if (jq === ".items[]") items = v.items;
else if (jq && jq.includes("mason-review-record")) items = v.filter((c) => c.body.includes("mason-review-record")).map((c) => ({ url: c.html_url, issue_url: c.issue_url, body: c.body, author_association: c.author_association }));
else if (jq) { process.stderr.write("stub gh: unknown jq " + jq + "\\n"); process.exit(2); }
process.stdout.write(items ? items.map((x) => JSON.stringify(x)).join("\\n") + "\\n" : JSON.stringify(v));
`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${dir}:${process.env["PATH"]}` } });
    assert.equal(r.error, undefined, String(r.error));
    const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { rc: r.status, out: r.stdout, err: r.stderr, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const API = "repos/embeddable-hq/mason-data";
/** An item of GitHub's REST answers: `assoc` undefined leaves author_association out; its login carries its body's word. */
const item = (id: number, assoc: string | undefined, body: string, extra: Record<string, unknown> = {}) => ({
  id, body, user: { login: `${body}-login` }, created_at: "2026-11-02T00:00:00Z", ...(assoc === undefined ? {} : { author_association: assoc }), ...extra,
});
const DROPPED = [item(3, "NONE", "drop-none"), item(4, "CONTRIBUTOR", "drop-contrib"), item(5, "FIRST_TIME_CONTRIBUTOR", "drop-ftc"), item(6, "FIRST_TIMER", "drop-ft"),
  item(7, "MANNEQUIN", "drop-mannequin"), item(8, undefined, "drop-missing"), item(9, "SOMETHING_NEW", "drop-new")];
const ISSUE_ROUTES: Record<string, GhAnswer> = {
  [`${API}/issues/7`]: { json: { number: 7, title: "kept-title", ...item(70, "OWNER", "kept-body") } },
  [`${API}/issues/7/comments`]: { pages: [[item(1, "MEMBER", "kept-member"), item(2, "COLLABORATOR", "kept-collab"), ...DROPPED]] },
  [`${API}/issues/8`]: { json: { number: 8, title: "drop-title", ...item(80, "NONE", "drop-body") } },
  [`${API}/issues/8/comments`]: { pages: [[item(1, "OWNER", "kept-owner")]] },
  [`${API}/issues/9`]: { json: { number: 9, title: "kept-nine", ...item(90, "MEMBER", "kept-nine-body") } },
  [`${API}/issues/9/comments`]: { pages: [Array.from({ length: 30 }, (_, i) => item(100 + i, "MEMBER", `kept-c${i + 1}-end`)), [item(130, "MEMBER", "kept-c31-end")]] },
};

test("github text: gh-text keeps OWNER, MEMBER and COLLABORATOR and names what it left out", async () => {
  const { KEPT, keep, isKept } = await import("../scripts/gh-text.ts") as { KEPT: readonly string[]; keep: (i: unknown[]) => { kept: unknown[]; left: number }; isKept: (i: object) => boolean };
  assert.deepEqual([...KEPT], ["OWNER", "MEMBER", "COLLABORATOR"]);
  assert.equal(keep(ISSUE_ROUTES[`${API}/issues/7/comments`]!.pages![0]!).left, 7, "the pure filter, called directly");
  assert.equal(isKept({}), false, "a missing association is not kept");

  const r = runGh(GH_TEXT, ["issue", "7"], ISSUE_ROUTES);
  assert.equal(r.rc, 0, r.err);
  for (const s of ["kept-title", "kept-body", "kept-member", "kept-collab", "MEMBER", "COLLABORATOR"]) assert.ok(r.out.includes(s), `prints ${s}`);
  assert.ok(!r.out.includes("drop-") && !r.err.includes("drop-"), "not one byte of a left-out comment, its author's login included");
  assert.match(r.out, /left out: 7 comments by others not read/);
  const comments = r.calls.find((c) => c.some((a) => a.startsWith(`${API}/issues/7/comments`)))!;
  assert.ok(comments.includes("--paginate") && comments.some((a) => a.includes("per_page=100")), `the list is read whole: ${comments.join(" ")}`);

  // a 31st comment, on a second page, is read
  const nine = runGh(GH_TEXT, ["issue", "9"], ISSUE_ROUTES);
  assert.equal(nine.rc, 0, nine.err);
  for (let i = 1; i <= 31; i++) assert.ok(nine.out.includes(`kept-c${i}-end`), `comment ${i} of 31`);
  assert.match(nine.out, /left out: nothing/);
});

test("github text: an issue by someone else is not read, and a gh that failed is never read as kept", () => {
  const r = runGh(GH_TEXT, ["issue", "8"], ISSUE_ROUTES);
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.includes("kept-owner"), "a kept comment is still printed");
  assert.ok(!r.out.includes("drop-") && !r.err.includes("drop-"), "neither the title nor the body");
  assert.match(r.out, /the issue's title and body are by someone else \(NONE\): not read/);
  const author = runGh(GH_TEXT, ["author", "8"], ISSUE_ROUTES);
  assert.equal(author.rc, 3);
  assert.match(author.out, /NONE/);
  assert.equal(runGh(GH_TEXT, ["author", "7"], ISSUE_ROUTES).rc, 0);
  const body = runGh(GH_TEXT, ["body", "8"], ISSUE_ROUTES);
  assert.equal(body.rc, 3);
  assert.equal(body.out, "", "a stranger's body never reaches a stage that writes it back");
  assert.ok(!body.err.includes("drop-"));
  assert.equal(runGh(GH_TEXT, ["body", "7"], ISSUE_ROUTES).out, "kept-body", "a kept body, raw");

  const failing = { "*": { rc: 1, err: "HTTP 401: Bad credentials" } };
  assert.equal(runGh(GH_TEXT, ["author", "7"], failing).rc, 1, "couldn't tell is never kept");
  const issue = runGh(GH_TEXT, ["issue", "7"], { [`${API}/issues/7`]: ISSUE_ROUTES[`${API}/issues/7`]!, "*": failing["*"] });
  assert.equal(issue.rc, 1);
  assert.equal(issue.out, "", "nothing printed as kept when a read failed");
  assert.match(issue.err, /gh auth status/, "it says the way out");
  for (const args of [[], ["issue"], ["issue", "x"], ["comment-id", "7"], ["search"], ["lunch", "1"]]) assert.equal(runGh(GH_TEXT, args, ISSUE_ROUTES).rc, 2, args.join(" "));
});

test("github text: a PR's reviews and inline comments are kept as its comments are; comment-id and search read only kept authors", () => {
  const handoff = item(11, "OWNER", "### From Claude (Opus 5.5)\n## Handoff\nkept-handoff");
  const routes: Record<string, GhAnswer> = {
    [`${API}/issues/900`]: { json: { number: 900, title: "kept-pr-title", ...item(9000, "OWNER", "## Design\nkept-design") } },
    [`${API}/issues/900/comments`]: { pages: [[handoff, item(12, "NONE", "## Handoff\ndrop-handoff")]] },
    [`${API}/pulls/900/reviews`]: { pages: [[item(21, "MEMBER", "kept-review", { submitted_at: "2026-11-02T00:00:00Z" }), item(22, "NONE", "drop-review"), item(23, "NONE", "")]] },
    [`${API}/pulls/900/comments`]: { pages: [[item(31, "COLLABORATOR", "kept-inline", { path: "src/duck/plan.ts", line: 3 }), item(32, "CONTRIBUTOR", "drop-inline")]] },
    "search/issues": { json: { items: [{ number: 950, title: "a refusal names its entry", author_association: "MEMBER" }, { number: 951, title: "drop-search", author_association: "NONE" }] } },
  };
  const r = runGh(GH_TEXT, ["pr", "900"], routes);
  assert.equal(r.rc, 0, r.err);
  for (const s of ["kept-pr-title", "kept-design", "kept-handoff", "kept-review", "kept-inline", "src/duck/plan.ts:3"]) assert.ok(r.out.includes(s), `prints ${s}`);
  assert.ok(!r.out.includes("drop-") && !r.err.includes("drop-"));
  assert.match(r.out, /left out: 1 comment, 1 review and 1 review comment by others not read/);
  for (const p of ["/pulls/900/reviews", "/pulls/900/comments", "/issues/900/comments"]) assert.ok(r.calls.find((c) => c.some((a) => a.includes(p)))!.includes("--paginate"), `${p} is paginated`);

  const id = runGh(GH_TEXT, ["comment-id", "900", "## Handoff"], routes);
  assert.deepEqual([id.rc, id.out], [0, "11\n"], "the kept Handoff, never the later one by someone else");
  const none = runGh(GH_TEXT, ["comment-id", "900", "## Handoff"], { ...routes, [`${API}/issues/900/comments`]: { pages: [[item(12, "NONE", "## Handoff\ndrop-handoff")]] } });
  assert.equal(none.rc, 3);
  assert.equal(none.out, "");

  const s = runGh(GH_TEXT, ["search", "wording", "refusal"], routes);
  assert.equal(s.rc, 0, s.err);
  assert.match(s.out, /^#950 a refusal names its entry$/m);
  assert.ok(!s.out.includes("drop-") && !s.out.includes("#951"));
  assert.match(s.out, /left out: 1 issue by others not listed/);
  const q = s.calls[0]!.join(" ");
  assert.ok(q.includes("--paginate") && q.includes("is:open") && q.includes("wording refusal") && q.includes("repo:embeddable-hq/mason-data"), q);
});

test("github text: review-stats counts only the records the repository's people wrote, with gh-text's own list", async () => {
  const gt = await import("../scripts/gh-text.ts") as { KEPT: unknown };
  const rs = await import("../scripts/review-stats.ts") as { KEPT?: unknown };
  assert.equal(rs.KEPT, gt.KEPT, "review-stats reads gh-text's list itself, never a copy");
  const block = (r: unknown) => "```json mason-review-record\n" + JSON.stringify(r) + "\n```";
  const rec = (o: object) => ({ pr: 900, designRounds: 0, probeRounds: 0, reviewRounds: 1, findings: [], ciFixes: 0, status: "reviewed", ...o });
  const comment = (id: number, assoc: string, r: object) => ({ id, html_url: `https://github.com/x/y/pull/900#issuecomment-${id}`, issue_url: `https://api.github.com/${API}/issues/900`, author_association: assoc, body: `## Review record\n\n${block(r)}` });
  const routes: Record<string, GhAnswer> = {
    // the one by someone else is posted later, so it would be the PR's own record if it counted
    "repos/{owner}/{repo}/issues/comments": { pages: [[comment(1, "OWNER", rec({})), comment(2, "NONE", rec({ findings: [{ round: 1, stage: "review", classKey: "k", severity: "wrong-answer" }] }))]] },
  };
  const r = runGh(REVIEW_STATS, ["--json"], routes);
  assert.equal(r.rc, 0, r.err);
  const s = JSON.parse(r.out) as { prs: number; firstPass: number };
  assert.deepEqual([s.prs, s.firstPass], [1, 1], "only the OWNER's record counts");
  assert.match(r.err, /1 record comment\(s\) by others left out/);
});
