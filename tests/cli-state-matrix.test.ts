/**
 * EVERY COMMAND IN EVERY STATE WITHOUT A RUN (tests/cli-matrix.ts says why): no project here; a project that is stopped;
 * one whose config still says it runs after a reboot (the pid dead, or reused by another process); one whose config is
 * half-written. Each command is run as a process, as a person runs it and with --json as an agent does, and must answer
 * in the failure shape or succeed — never a stack, a hang, or prose under --json. The states with a run up are
 * a run against a real Postgres (no integration test yet); what `mason status` and `mason wait` read of a run that is up
 * is held here over this test's own command server (`upProject`), its copies faked.
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
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import type { CopyState, KeptCurrent, StreamStatus } from "../src/duck/sync.ts";

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
 * Its port is then moved to 1, where nothing listens (as SOURCE's): the port init picks is the demo's preferred one,
 * which tests/cli-demo-start.test.ts's run, beside this file under `node --test`, picks too and hosts its demo database
 * on — and a `mason tables`, `add` or `remove` here would read that one.
 */
const demoTemplate = fs.mkdtempSync(path.join(os.tmpdir(), "mason-matrix-demo-template-"));
made.push(demoTemplate);
const demoInit = await runMason(demoTemplate, ["init", "demo", "--json"], matrixEnv());
if (demoInit.code !== 0) throw new Error(`mason init demo, for the matrix's demo project: exit ${demoInit.code}\n${demoInit.stdout}${demoInit.stderr}`);
const demoEnv = path.join(demoTemplate, ".env");
const initAt = /^DATABASE_URL=postgres:\/\/demo@(127\.0\.0\.1:\d+)\/demo$/m.exec(fs.readFileSync(demoEnv, "utf8"))?.[1];
if (initAt === undefined) throw new Error("mason init demo wrote no demo URL in .env");
const demoAt = "127.0.0.1:1";
fs.writeFileSync(demoEnv, fs.readFileSync(demoEnv, "utf8").replace(`@${initAt}/`, `@${demoAt}/`));
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
  // how a copy is kept current is the run's (src/duck/sync.ts KeptCurrent): with nothing running, no table says it
  assert.equal("kept" in (v.tables as Array<Record<string, unknown>>)[0]!, false, "Mason stopped: no kept");
  assert.deepEqual(v.project, { name: "matrix-stopped", folder: path.join(fs.realpathSync(root), "mason") });
  assert.equal("sources" in v, false);
  fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), "kind: postgres\nurl: x\ntables:\n  a.b.c: {}\n");
  const bad = JSON.parse((await runMason(root, ["status", "--json"], matrixEnv())).stdout) as { source: { name: unknown; file: unknown; url: unknown; error: { code: string; message: string } } };
  assert.deepEqual([bad.source.name, bad.source.file, bad.source.url, bad.source.error.code], [null, null, null, "bad_source"]);
  assert.match(bad.source.error.message, /^mason\/sources\/shop\.yml: tables\.a\.b\.c: /);
});

/**
 * A PROJECT WHOSE RUN IS UP, in `changes` mode: this test's own command server (src/cli/run-server.ts), named in the
 * project's config with this process's pid, so `mason status` and `mason wait` — real processes — find Mason up and
 * read its state. The copies are the sync's, faked (`copies`); the sources file adds `orders`, `events` and `fresh`, and
 * the database also has `logs`.
 */
async function upProject(changes: "poll" | "replication", copies: CopyState[], stream: StreamStatus | null): Promise<{ root: string; close: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mason-matrix-up-${changes}-`));
  made.push(root);
  const token = "u".repeat(64);
  const parsed = parseSource("postgres://mason:secret@127.0.0.1:1/shop");
  if (!("source" in parsed)) throw new Error(parsed.problem);
  const col = (name: string, type = "bigint") => ({ name, type, notNull: name === "id", comment: null });
  const catalog: SourceTable[] = ["orders", "events", "fresh", "logs"].map((table) => ({ source: `public.${table}`, schema: "public", table, key: ["id"], rows: 3, bytes: 8192,
    comment: null, columns: [col("id"), col("note", "text")], foreignKeys: [] }));
  const folder = path.join(root, "mason");
  const file = path.join(folder, "sources", "shop.yml");
  const ctx = {
    source: parsed.source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: catalog, systemIdentifier: null }), warnings: [],
    slot: changes === "replication" ? "mason_matrix" : "", changes, ...(changes === "replication" ? { publication: { name: "mason_matrix", owned: true } } : {}),
    port: 0, token, page: false, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    folder: () => folder, root, sourcesChanged: () => undefined, log: () => undefined, readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    sources: () => ({ file: { name: "shop", file, kind: "postgres", url: { env: "DATABASE_URL" }, tables: ["orders", "events", "fresh"].map((t) => ({ name: t, table: `public.${t}`, columns: null, exclude: [], key: null })) }, problem: null }),
    duck: { copies: () => copies, file: path.join(root, ".mason", "duck.db"), pollSeconds: 5, poll: async () => ({ at: "", tables: [] }), stream: async () => stream,
      requests: { days: 7, recent: async () => [], slow: async () => [], refused: async () => ({ total: 0, refused: [] }) } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = ctx.port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SOURCE.replace("  orders: {}\n", "  orders: {}\n  events: {}\n  fresh: {}\n"));
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: `matrix-up-${changes}`, folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } },
    lastRun: null, ...(changes === "replication" ? { changes } : {}) }), { mode: 0o600 });
  return { root, close: () => { server.close(); } };
}

test("mason status and mason wait --json, Mason up: each added table says how its copy is kept current (kept), in poll and in replication mode", async () => {
  const copied = (source: string, kept: KeptCurrent, extra: Partial<CopyState> = {}): CopyState =>
    ({ source, phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-29T09:00:00.000Z", error: null, kept, ...extra });
  const polled: KeptCurrent = { by: "poll", polledAt: "2026-10-29T09:30:00.000Z" };
  const over: KeptCurrent = { by: "poll", polledAt: "2026-10-29T09:00:00.000Z", unsynced: "over the 1,000,000-row sync limit" };
  const streamed: KeptCurrent = { by: "replication", slot: "mason_matrix", state: "streamed", why: null, position: "0/16B3F28", lastCommit: "2026-10-29T09:29:59.000Z", notRunning: null };
  const leftOut: KeptCurrent = { by: "replication", slot: "mason_matrix", state: "left-out", why: "publication mason_matrix does not carry public.events",
    position: "0/16B3F28", lastCommit: "2026-10-29T09:29:59.000Z", notRunning: null };
  const zero = { inserts: 0, updates: 0, deletes: 0, truncates: 0 };
  const stream: StreamStatus = { slot: "mason_matrix", publication: "mason_matrix", running: true, failure: null, position: "0/16B3F28", applied: "0/16B3F28",
    database: { lsn: "0/16B3F28", at: "2026-10-29T09:30:00.000Z" }, lag: { bytes: 0, seconds: 1 }, lastBatch: { appliedAt: "2026-10-29T09:30:00.000Z", committedAt: "2026-10-29T09:29:59.000Z" },
    tables: [{ table: "public.orders", state: "streamed", why: null, applied: zero }, { table: "public.events", state: "left-out", why: leftOut.why, applied: zero }] };
  // kept is the sync's, never the sources file's: `fresh`, just added, has no copy until the run reads the file again
  // (no kept); `logs`, just removed, is still held by the sync until then (its kept, though the file no longer adds it)
  const modes = [
    { changes: "poll" as const, copies: [copied("public.orders", polled), copied("public.events", over, { unsynced: { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-29T09:00:00.000Z" } }),
      copied("public.logs", polled)], stream: null, kept: { "public.orders": polled, "public.events": over, "public.logs": polled } },
    { changes: "replication" as const, copies: [copied("public.orders", streamed), copied("public.events", leftOut), copied("public.logs", streamed)], stream,
      kept: { "public.orders": streamed, "public.events": leftOut, "public.logs": streamed } },
  ];
  for (const m of modes) {
    const p = await upProject(m.changes, m.copies, m.stream);
    try {
      const status = await runMason(p.root, ["status", "--json"], matrixEnv());
      assert.equal(status.code, 0, status.stdout + status.stderr);
      const s = JSON.parse(status.stdout) as { running: boolean; source: { changes: string }; tables: Array<{ table: string; added: boolean; kept?: unknown }> };
      assert.deepEqual([s.running, s.source.changes], [true, m.changes]);
      const keptOf = (tables: ReadonlyArray<{ table: string; kept?: unknown }>) => Object.fromEntries(tables.filter((t) => "kept" in t).map((t) => [t.table, t.kept]));
      assert.deepEqual(keptOf(s.tables), m.kept, `${m.changes}: mason status --json, each table the sync holds with its kept as the run's state has it`);
      const fresh = s.tables.find((t) => t.table === "public.fresh")!;
      assert.deepEqual([fresh.added, "kept" in fresh], [true, false], `${m.changes}: added, not held by the sync yet: no kept`);
      assert.deepEqual([s.tables.find((t) => t.table === "public.logs")!.added], [false], `${m.changes}: removed, still held by the sync: its kept`);
      // mason wait lists the added tables, so it waits for fresh's copy and times out, saying each one's kept as status does
      const waited = await runMason(p.root, ["wait", "--json", "--timeout", "1"], matrixEnv());
      assert.equal(waited.code, 124, waited.stdout + waited.stderr);
      const w = JSON.parse(waited.stdout) as { ready: boolean; tables: Array<{ table: string; kept?: unknown }> };
      assert.deepEqual(w.tables.map((t) => t.table), ["public.orders", "public.events", "public.fresh"]);
      assert.deepEqual(keptOf(w.tables), { "public.orders": m.kept["public.orders"], "public.events": m.kept["public.events"] }, `${m.changes}: mason wait --json says the same`);
    } finally { p.close(); }
  }
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
