/**
 * EVERY COMMAND IN EVERY STATE WITHOUT A RUN (tests/cli-matrix.ts says why): no project here; a project that is stopped;
 * one whose config still says it runs after a reboot (the pid dead, or reused by another process); one whose config is
 * half-written. Each command is run as a process, as a person runs it and with --json as an agent does, and must answer
 * in the failure shape or succeed — never a stack, a hang, or prose under --json. The states with a run up are
 * a run against a real Postgres (no integration test yet).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { COMMANDS } from "../src/cli/registry.ts";
import { PROJECT_STATES, meets, type ProjectState } from "../src/cli/state.ts";
import { MATRIX_ARGS, TRANSITIONS, answerProblems, matrixEnv, runMason, takesJson, type Answer } from "./cli-matrix.ts";

// nothing listens on port 1: a database that does not answer, as one that is away
const SOURCE = "kind: postgres\nurl: postgres://mason:secret@127.0.0.1:1/shop\ntables:\n  orders: {}\n";
/** a file of another stack's, in a folder Mason does not read */
const SAVED = "queries:\n  orders_count:\n    sql: SELECT count(*) FROM orders\n";

/** A pid nobody has: a process that ran and ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

/** Every folder the matrix made, removed when it ends. */
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A STOPPED DEMO PROJECT, written by `mason init demo` itself (its sources file, its `.env` naming a port free now,
 * `demo: true`), once, and copied for each command: its database runs inside mason start, so nothing answers there.
 */
const demoTemplate = fs.mkdtempSync(path.join(os.tmpdir(), "mason-matrix-demo-template-"));
made.push(demoTemplate);
const demoInit = await runMason(demoTemplate, ["init", "demo", "--json"], matrixEnv());
if (demoInit.code !== 0) throw new Error(`mason init demo, for the matrix's demo project: exit ${demoInit.code}\n${demoInit.stdout}${demoInit.stderr}`);
const demoAt = /^DATABASE_URL=postgres:\/\/demo@(127\.0\.0\.1:\d+)\/demo$/m.exec(fs.readFileSync(path.join(demoTemplate, ".env"), "utf8"))?.[1];
if (demoAt === undefined) throw new Error("mason init demo wrote no demo URL in .env");
/** The commands' lines in a state: a demo project's start asks for replication, refused before anything starts (a
 *  plain start there would host the demo database and run, which the matrix must not leave behind). */
const argsIn = (state: string, cmd: string): readonly string[] => state === "demo" && cmd === "start" ? ["--replication"] : MATRIX_ARGS[cmd]!;

/** A folder in a state; `null` config writes none. */
function folderIn(state: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mason-matrix-${state}-`));
  made.push(root);
  if (state === "no_project") return root;
  if (state === "demo") { fs.cpSync(demoTemplate, root, { recursive: true }); return root; }
  const dir = path.join(root, ".mason");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "mason", "queries"), { recursive: true });
  fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), SOURCE);
  // a saved query (mason/queries/), which only the ClickHouse stack this was cut from read: every state is a project
  // carrying one, so a file Mason does not read is held to changing no command's answer
  fs.writeFileSync(path.join(root, "mason", "queries", "orders.yml"), SAVED);
  if (state === "broken") { fs.writeFileSync(path.join(dir, "config.json"), '{"name": "matrix", "sour'); return root; }
  const config: Record<string, unknown> = { name: `matrix-${state.replace(/_/g, "-")}`, folder: "mason", remote: false,
    apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null };
  if (state === "stale" || state === "squatted") {
    // after a reboot the config still names the run; its pid is dead, or now another process's (this test's own)
    config.running = { pid: state === "stale" ? deadPid() : process.pid, controlUrl: "http://127.0.0.1:1", token: "t".repeat(32), postgresUrl: "postgresql://127.0.0.1:1/matrix", postgresListener: { host: "127.0.0.1", tls: null } };
  }
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  return root;
}

const STATES = ["no_project", "stopped", "stale", "squatted", "broken", "demo"] as const;
/** Which of src/cli/state.ts's states each folder is: a run recorded that does not answer is stopped. */
const IS: Record<(typeof STATES)[number], ProjectState> = { no_project: "no_project", stopped: "stopped", stale: "stopped", squatted: "stopped", broken: "bad_config", demo: "stopped" };

test("the states are src/cli/state.ts's, in order: each meets more than the one before", () => {
  assert.deepEqual(Object.keys(PROJECT_STATES), ["no_project", "bad_config", "stopped", "up"]);
  for (const need of ["project", "run"] as const) {
    const met = Object.keys(PROJECT_STATES).map((s) => meets(s as ProjectState, need));
    assert.deepEqual(met, [...met].sort(), `${need}: once met, met in every later state`);
    assert.ok(met.includes(true) && met.includes(false), need);
  }
});

/** Run `jobs` with at most `n` at once. */
/** Every key of a JSON answer, at any depth, that names a model (`model`, `models`, `modelFile`…); [] for text. */
function keysNamingAModel(stdout: string): string[] {
  let v: unknown;
  try { v = JSON.parse(stdout); } catch { return []; }   // not JSON: answerProblems says so where JSON was owed
  const found: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x !== "object" || x === null) return;
    for (const [k, y] of Object.entries(x)) { if (/model/i.test(k)) found.push(k); walk(y); }
  };
  walk(v);
  return found;
}

/**
 * Every `source` key of a JSON answer, at any depth, that is not the source database's object (a table is `table`:
 * a project will sync several databases, each a source, so `source` holding `schema.table` would mean two things).
 */
function sourcesNotADatabase(stdout: string): string[] {
  let v: unknown;
  try { v = JSON.parse(stdout); } catch { return []; }   // not JSON: answerProblems says so where JSON was owed
  const found: string[] = [];
  const walk = (x: unknown, at: string): void => {
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${at}[${i}]`)); return; }
    if (typeof x !== "object" || x === null) return;
    for (const [k, y] of Object.entries(x)) {
      if (k === "source" && (typeof y !== "object" || y === null || Array.isArray(y))) found.push(`${at}${at ? "." : ""}${k} = ${JSON.stringify(y)}`);
      walk(y, `${at}${at ? "." : ""}${k}`);
    }
  };
  walk(v, "");
  return found;
}

async function pool<T>(jobs: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k]!(); } }));
  return out;
}

test("mason tables needs only the project: Mason stopped, it reads the database itself and says why it cannot", async () => {
  // the hands-on review of #451, item 15: `mason tables` answered not_running, though what it lists is the database's
  // catalog and the project's sources file — neither is the run's. In a stopped project whose database does not answer
  // (port 1), it must be the DATABASE's refusal, with the way out, never "Mason is not running"
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mason-matrix-home-"));
  made.push(home);
  const a = await runMason(folderIn("stopped"), ["tables", "--json"], matrixEnv({ HOME: home, PATH: path.dirname(process.execPath) }));
  const v = JSON.parse(a.stdout) as { error?: { code: string; message: string; fix?: string } };
  assert.equal(a.code, 1, a.stdout + a.stderr);
  assert.equal(v.error?.code, "unreachable", a.stdout);
  assert.equal(v.error?.message, "could not connect to postgres://mason:****@127.0.0.1:1/shop: nothing is listening on 127.0.0.1:1");
  assert.equal(v.error?.fix, "change the URL where it is (mason/sources/shop.yml) when the database's password or host changed");
});

test("mason status --json, Mason stopped: source is the database — its name, its file, its URL and the file's error — and a table is table", async () => {
  // a project will sync several databases, each a source of its own: `source` is that object, never a table's name or
  // the file's path alone, and the sources file's problem is the source's (source.error), never a key of its own
  const root = folderIn("stopped");
  const ok = await runMason(root, ["status", "--json"], matrixEnv());
  assert.equal(ok.code, 0, ok.stderr);
  const v = JSON.parse(ok.stdout) as Record<string, unknown>;
  assert.deepEqual(v.source, { name: "shop", file: path.join(fs.realpathSync(root), "mason", "sources", "shop.yml"), url: "postgres://mason:****@127.0.0.1:1/shop", error: null });
  assert.deepEqual(v.tables, [{ table: "public.orders" }]);
  assert.deepEqual(v.project, { name: "matrix-stopped", folder: path.join(fs.realpathSync(root), "mason") });
  assert.equal("sources" in v, false);
  fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), "kind: postgres\nurl: x\ntables:\n  a.b.c: {}\n");
  const bad = JSON.parse((await runMason(root, ["status", "--json"], matrixEnv())).stdout) as { source: { name: unknown; file: unknown; url: unknown; error: { code: string; message: string } } };
  assert.deepEqual([bad.source.name, bad.source.file, bad.source.url, bad.source.error.code], [null, null, null, "bad_source"]);
  assert.match(bad.source.error.message, /^mason\/sources\/shop\.yml: tables\.a\.b\.c: /);
});

test("a demo project, stopped: mason tables says its database runs inside mason start, and --replication is refused before anything starts", async () => {
  const tables = await runMason(folderIn("demo"), ["tables", "--json"], matrixEnv());
  assert.equal(tables.code, 1, tables.stdout + tables.stderr);
  const t = (JSON.parse(tables.stdout) as { error: { code: string; message: string; fix: string } }).error;
  assert.deepEqual([t.code, t.message, t.fix], ["unreachable", `could not connect to postgres://demo@${demoAt}/demo: the demo database is not running on ${demoAt}`,
    "the demo database runs inside mason start: start it first"]);
  for (const json of [false, true]) {
    const root = folderIn("demo");
    const start = await runMason(root, ["start", "--replication", ...(json ? ["--json"] : [])], matrixEnv());
    assert.equal(start.code, 1, start.stdout + start.stderr);
    if (json) assert.equal((JSON.parse(start.stdout) as { error: { code: string } }).error.code, "refused");
    assert.match(json ? start.stdout : start.stderr, /the demo database is read by polling only: --replication does not apply to it/);
    assert.equal(fs.existsSync(path.join(root, ".mason", "dev.log")), false, "refused before a run was spawned");
  }
});

test("mason add and mason remove need only the project: Mason stopped, they read the database themselves — the demo's runs inside mason start", async () => {
  // the sources file is the list, so a table is added before mason start: with Mason stopped the command checks the
  // edit against the database itself, and a database that does not answer is ITS refusal, as mason tables says it —
  // never "Mason is not running"; the demo database's way out is mason start, which hosts it
  for (const cmd of ["add", "remove"]) {
    const stopped = await runMason(folderIn("stopped"), [cmd, "orders", "--json"], matrixEnv());
    assert.equal(stopped.code, 1, stopped.stdout + stopped.stderr);
    const s = JSON.parse(stopped.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
    assert.deepEqual([s.error.code, s.error.message, s.error.fix, s.next.map((n) => n.command)], ["unreachable",
      "could not connect to postgres://mason:****@127.0.0.1:1/shop: nothing is listening on 127.0.0.1:1",
      "change the URL where it is (mason/sources/shop.yml) when the database's password or host changed", ["mason doctor"]], `mason ${cmd}, stopped`);
    const root = folderIn("demo");
    const was = fs.readFileSync(path.join(root, "mason", "sources", "demo.yml"), "utf8");
    const demo = await runMason(root, [cmd, "orders", "--json"], matrixEnv());
    assert.equal(demo.code, 1, demo.stdout + demo.stderr);
    const d = JSON.parse(demo.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
    assert.deepEqual([d.error.code, d.error.message, d.error.fix, d.next.map((n) => n.command)], ["unreachable",
      `could not connect to postgres://demo@${demoAt}/demo: the demo database is not running on ${demoAt}`, "the demo database runs inside mason start: start it first", ["mason start"]], `mason ${cmd}, a demo project stopped`);
    assert.equal(fs.readFileSync(path.join(root, "mason", "sources", "demo.yml"), "utf8"), was, "nothing written");
  }
});

test("every command has a line in the matrix: a new command is run in every state by construction", () => {
  assert.deepEqual(Object.keys(MATRIX_ARGS).sort(), COMMANDS.map((c) => c.name).sort());
});

test("no folder above the matrix's temp folders is a project (else every state would be that project's)", () => {
  for (let d = os.tmpdir(); ; d = path.dirname(d)) {
    assert.ok(!fs.existsSync(path.join(d, ".mason", "config.json")), `${d} is a Mason project`);
    if (path.dirname(d) === d) break;
  }
});

test("every command, in every state without a run, as a person and with --json: the failure shape or success, never a stack or a hang", { timeout: 600_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mason-matrix-home-"));
  made.push(home);
  // Docker is not this test's: a PATH without it makes every machine answer the same (and nothing is touched)
  const env = matrixEnv({ HOME: home, PATH: path.dirname(process.execPath) });
  const jobs: Array<() => Promise<{ state: (typeof STATES)[number]; cmd: string; json: boolean; a: Answer }>> = [];
  for (const state of STATES) {
    for (const c of COMMANDS) {
      // start in a stopped project is the session's transition (it connects to the database): its refusal here is
      // the database not answering, which is checked; stop is harmless where nothing runs
      for (const json of takesJson(c.name) ? [false, true] : [false]) {
        jobs.push(async () => {
          const root = folderIn(state);
          const argv = [c.name, ...argsIn(state, c.name), ...(json ? ["--json"] : [])];
          return { state, cmd: c.name, json, a: await runMason(root, argv, env, TRANSITIONS.has(c.name) ? 90_000 : 30_000) };
        });
      }
    }
  }
  const answers = await pool(jobs, Math.max(2, Math.min(8, os.availableParallelism())));
  const problems = answers.flatMap(({ state, cmd, json, a }) => {
    // a command in a state that does not meet what it needs answers with THAT state's code (src/cli/state.ts reach)
    const needs = COMMANDS.find((c) => c.name === cmd)!.needs;
    const codes = needs && !meets(IS[state], needs) ? PROJECT_STATES[IS[state]].codes : [];
    const p = answerProblems(cmd, a, json, codes);
    if (json && codes.length && a.code === 0) p.push(`mason ${a.argv.join(" ")}: exit 0, where ${IS[state]} does not meet what it needs (${needs})`);
    // what a project copies is its sources file's tables: no answer names a model, at any depth
    if (json) for (const k of keysNamingAModel(a.stdout)) p.push(`mason ${a.argv.join(" ")}: --json answers with a key ${k}, where it says table or source`);
    // a key named source is the database, an object; a table is table
    if (json) for (const k of sourcesNotADatabase(a.stdout)) p.push(`mason ${a.argv.join(" ")}: --json answers ${k}, where source is the database's object and a table is table`);
    return p.map((x) => `[${state}] ${x}`);
  });
  assert.deepEqual(problems, []);
});

test("the matrix's own check: a source key holding a table, or a file's path, is caught; the database's object is not", () => {
  assert.deepEqual(sourcesNotADatabase(JSON.stringify({ tables: [{ source: "public.orders" }], project: { source: "/p/mason/sources/shop.yml" } })),
    ['tables[0].source = "public.orders"', 'project.source = "/p/mason/sources/shop.yml"']);
  assert.deepEqual(sourcesNotADatabase(JSON.stringify({ source: { name: "shop", file: "/p/mason/sources/shop.yml", error: null }, tables: [{ table: "public.orders" }] })), []);
});

test("the matrix's own check: a failure's head may follow progress on stderr; a failure without one, or a stack, is caught", () => {
  const a = (stderr: string, stdout = ""): Answer => ({ argv: ["wait", "--timeout", "1"], code: 124, signal: null, stdout, stderr, ms: 1 });
  // mason wait's bars, then its failure (found in CI: a wait that timed out during the loop's own apply)
  assert.deepEqual(answerProblems("wait", a("  public.orders  ████ 100%\n✗ mason wait: not ready after 1 s\n  why   applying the project\n"), false), []);
  assert.match(answerProblems("wait", a("  public.orders  ████ 100%\n"), false)[0]!, /has no "mason wait: …" line/);
  assert.match(answerProblems("wait", a("mason wait: x\n    at run (file:///x.ts:1:2)\n"), false)[0]!, /printed a stack/);
  assert.match(answerProblems("wait", a("", "{"), true)[0]!, /stdout is not one JSON object/);
  // a crash folded into a failure by main.ts's catch-all (MASON_DEBUG unset) is still a crash, whatever the state accepts
  const crash = JSON.stringify({ error: { code: "failed", message: "x is not a function", fix: "this is a bug in mason: MASON_DEBUG=1 prints where it happened, for the report" }, next: [] });
  assert.match(answerProblems("wait", { ...a(""), code: 1, stdout: crash }, true)[0]!, /crashed \(main\.ts's catch-all\): x is not a function/);
});
