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
import { DEPLOY } from "../src/cli/deploy.ts";
import { PROJECT_STATES, meets, type ProjectState } from "../src/cli/state.ts";
import { MATRIX_ARGS, MATRIX_EXTRA_ARGS, MATRIX_HOSTED, MATRIX_MORE, TRANSITIONS, answerProblems, containerMemoryEnv, matrixEnv, runMason, takesJson, type Answer } from "./cli-matrix.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import type { CopyState, KeptCurrent, StreamStatus } from "../src/duck/sync.ts";
import type { GeneratedStatus } from "../src/duck/generated.ts";
import { unassignedPort } from "./test-ports.ts";

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
/**
 * The folder a command runs in, in a state: a demo project's `mason start` gets a sources file with `orders: { sync:
 * replication }`, which the demo refuses before anything starts (`demoChangesRefusal`, background.ts and dev.ts) — so the
 * row runs the start itself in the demo state (its project, its run lookup, its refusal) and never leaves a run behind,
 * where a plain start would host the demo database and run. The refusal's words: the demo test below.
 */
function folderFor(state: string, cmd: string): string {
  const root = folderIn(state);
  if (state === "demo" && cmd === "start") demoReplicating(root);
  return root;
}

/** A demo folder's sources file with orders set to sync: replication. */
function demoReplicating(root: string): void {
  const file = path.join(root, "mason", "sources", "demo.yml");
  const was = fs.readFileSync(file, "utf8");
  const now = was.replace(/^ {2}orders: \{\}$/m, "  orders: { sync: replication }");
  if (now === was) throw new Error(`the demo's sources file has no "orders: {}" line to set to sync: replication:\n${was}`);
  fs.writeFileSync(file, now);
}

const V0_7_STREAMED = { changes: "replication", publication: null, replication: { slot: "mason_dev_matrix_shop", publication: "mason_dev_matrix_shop", owned: true } };

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
  // a project's files alone, never mason init'ed (fetched, or cloned): no .mason/ at all
  if (state === "files_only") { fs.rmSync(dir, { recursive: true }); return root; }
  if (state === "broken") { fs.writeFileSync(path.join(dir, "config.json"), '{"name": "matrix", "sour'); return root; }
  // `remote`: an older Mason's key (its --remote, gone: issue 888), which every command in every state reads past
  const config: Record<string, unknown> = { name: `matrix-${state.replace(/_/g, "-")}`, folder: "mason", remote: true,
    apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null };
  if (state === "stale" || state === "squatted") {
    // after a reboot the config still names the run; its pid is dead, or now another process's (this test's own), which
    // started at another moment than the run recorded (src/cli/runs.ts masonProcess)
    config.running = { pid: state === "stale" ? deadPid() : process.pid, started: "linux:a-boot-before:1", controlUrl: "http://127.0.0.1:1", token: "t".repeat(32), postgresUrl: "postgresql://127.0.0.1:1/matrix", postgresListener: { host: "127.0.0.1", tls: null } };
  }
  // what a 0.7.0 start recorded for a project it streamed (v0.7.0 src/cli/dev.ts), under the file 0.7.0 wrote: no sync:
  if (state === "streamed_0_7") Object.assign(config, V0_7_STREAMED);
  // what a start under MASON_PROJECT_READONLY=1 records (src/cli/dev.ts): the project's files deployed, read-only here
  if (state === "deployed") config.projectReadOnly = true;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  return root;
}

const STATES = ["no_project", "files_only", "stopped", "stale", "squatted", "broken", "demo", "streamed_0_7", "deployed"] as const;
/** Which of src/cli/state.ts's states each folder is: a run recorded that does not answer is stopped. */
const IS: Record<(typeof STATES)[number], ProjectState> = { no_project: "no_project", files_only: "no_project", stopped: "stopped", stale: "stopped", squatted: "stopped", broken: "bad_config", demo: "stopped", streamed_0_7: "stopped", deployed: "stopped" };

test("the states are src/cli/state.ts's, in order: each meets more than the one before", () => {
  assert.deepEqual(Object.keys(PROJECT_STATES), ["no_project", "bad_config", "stopped", "up"]);
  for (const need of ["project", "run"] as const) {
    const met = Object.keys(PROJECT_STATES).map((s) => meets(s as ProjectState, need));
    assert.deepEqual(met, [...met].sort(), `${need}: once met, met in every later state`);
    assert.ok(met.includes(true) && met.includes(false), need);
  }
});

/**
 * Whether a folder in `state` meets what a command needs: src/cli/state.ts's `meets`, and for a command that needs the
 * project's files alone (`needs: "files"`, mason deploy) a project, or a folder holding mason/ with no .mason/.
 */
function meetsNeed(state: (typeof STATES)[number], need: "files" | "project" | "run"): boolean {
  return need === "files" ? state === "files_only" || meets(IS[state], "project") : meets(IS[state], need);
}

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
async function upProject(changes: "poll" | "replication", copies: CopyState[], stream: StreamStatus | null, generated: GeneratedStatus[] = []): Promise<{ root: string; close: () => void }> {
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
    replication: () => changes === "replication" ? { slot: "mason_matrix", publication: "mason_matrix", owned: true } : null,
    port: 0, token, page: false, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [] }, folder: () => folder, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(), sourcesChanged: () => undefined, log: () => undefined, readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    sources: () => ({ file: { name: "shop", file, kind: "postgres", url: { env: "DATABASE_URL" }, tables: ["orders", "events", "fresh"].map((t) => ({ name: t, table: `public.${t}`, columns: null, exclude: [], key: null })) }, problem: null }),
    duck: { copies: () => copies, generated: () => generated, file: path.join(root, ".mason", "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => stream, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, recent: async () => [], slow: async () => [], refused: async () => ({ total: 0, refused: [] }) } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = ctx.port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SOURCE.replace("  orders: {}\n", "  orders: {}\n  events: {}\n  fresh: {}\n"));
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: `matrix-up-${changes}`, folder: "mason", remote: true, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } },
    lastRun: null, ...(changes === "replication" ? { changes } : {}) }), { mode: 0o600 });
  return { root, close: () => { server.close(); } };
}

test("mason status and mason wait --json, Mason up: each added table says how its copy is kept current (kept), in poll and in replication mode", async () => {
  const copied = (source: string, kept: KeptCurrent, extra: Partial<CopyState> = {}): CopyState =>
    ({ source, phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-29T09:00:00.000Z", error: null, kept, ...extra });
  const polled: KeptCurrent = { by: "poll", sync: { mode: "poll", every: "30s", seconds: 30 }, syncedAt: "2026-10-29T09:30:00.000Z", nextAt: "2026-10-29T09:30:30.000Z" };
  const over: KeptCurrent = { by: "poll", sync: { mode: "off" }, syncedAt: "2026-10-29T09:00:00.000Z", nextAt: null };
  const streamed: KeptCurrent = { by: "replication", slot: "mason_matrix", state: "streamed", why: null, position: "0/16B3F28", lastCommit: "2026-10-29T09:29:59.000Z", notRunning: null, syncedAt: "2026-10-29T09:30:00.000Z" };
  const leftOut: KeptCurrent = { by: "replication", slot: "mason_matrix", state: "left-out", why: "publication mason_matrix does not carry public.events",
    position: "0/16B3F28", lastCommit: "2026-10-29T09:29:59.000Z", notRunning: null, syncedAt: "2026-10-29T09:00:00.000Z" };
  const zero = { inserts: 0, updates: 0, deletes: 0, truncates: 0 };
  const stream: StreamStatus = { slot: "mason_matrix", slotWal: { walHeldBytes: 2 ** 20, walStatus: "reserved", safeWalSizeBytes: 2 ** 30, at: "2026-10-29T09:30:00.000Z" }, publication: "mason_matrix", running: true, failure: null, position: "0/16B3F28", applied: "0/16B3F28",
    database: { lsn: "0/16B3F28", at: "2026-10-29T09:30:00.000Z" }, lag: { bytes: 0, seconds: 1 }, lastBatch: { appliedAt: "2026-10-29T09:30:00.000Z", committedAt: "2026-10-29T09:29:59.000Z" },
    tables: [{ table: "public.orders", state: "streamed", why: null, applied: zero }, { table: "public.events", state: "left-out", why: leftOut.why, applied: zero }] };
  // kept is the sync's, never the sources file's: `fresh`, just added, has no copy until the run reads the file again
  // (no kept); `logs`, just removed, is still held by the sync until then (its kept, though the file no longer adds it)
  const modes = [
    { changes: "poll" as const, copies: [copied("public.orders", polled), copied("public.events", over),
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

test("mason wait <generated table>, Mason up: 0 once it holds what was synced, 124 past --timeout, 1 for a failed run or no such table, each --json in its declared shape", async () => {
  const g = (table: string, extra: Partial<GeneratedStatus>): GeneratedStatus => ({ table, file: `mason/generated_tables/${table.slice(7)}.yml`, kind: "scheduled", method: "whole",
    state: "current", targetLag: "1m", behindSeconds: 0, behindSince: null, missingTarget: false, serving: true, lastRun: { at: "2026-10-29T09:00:00.000Z", seconds: 1, rows: 3 },
    error: null, retryAt: null, refusals: [], waitingFor: null, warnings: [], ...extra });
  const generated = [g("public.daily", {}), g("public.weekly", { state: "behind", behindSeconds: 3600, behindSince: new Date(Date.now() - 3_600_000).toISOString() }),
    g("public.broken", { state: "failed", behindSeconds: 60, behindSince: new Date(Date.now() - 60_000).toISOString(), error: "division by zero", retryAt: "2026-10-29T09:01:00.000Z" })];
  const p = await upProject("poll", [], null, generated);
  try {
    const keys = ["ready", "failed", "waiting", "timedOut", "tables", "generatedTable", "next"];
    const ready = await runMason(p.root, ["wait", "daily", "--json"], matrixEnv());
    assert.equal(ready.code, 0, ready.stdout + ready.stderr);
    const r = JSON.parse(ready.stdout) as Record<string, unknown> & { generatedTable: GeneratedStatus };
    assert.deepEqual(Object.keys(r), keys);
    assert.deepEqual([r.ready, r.timedOut, r.tables, r.generatedTable.table, r.generatedTable.behindSince], [true, false, [], "public.daily", null]);
    const person = await runMason(p.root, ["wait", "daily"], matrixEnv());
    assert.equal(person.code, 0, person.stdout + person.stderr);
    assert.match(person.stdout, /Ready: public\.daily holds every change synced when the wait began\./);
    const late = await runMason(p.root, ["wait", "public.weekly", "--json", "--timeout", "1"], matrixEnv());
    assert.equal(late.code, 124, late.stdout + late.stderr);
    const l = JSON.parse(late.stdout) as { ready: boolean; timedOut: boolean; waiting: string[]; error: { code: string; message: string } };
    assert.deepEqual([l.ready, l.timedOut, l.error.code], [false, true, "timeout"]);
    assert.match(l.waiting[0]!, /^public\.weekly: 3600 s behind its bases/);
    const broken = await runMason(p.root, ["wait", "broken", "--json"], matrixEnv());
    assert.equal(broken.code, 1, broken.stdout + broken.stderr);
    assert.deepEqual((JSON.parse(broken.stdout) as { error: { code: string; message: string } }).error.code, "failed");
    assert.match(broken.stdout, /public\.broken: its last run failed: division by zero/);
    const none = await runMason(p.root, ["wait", "monthly", "--json"], matrixEnv());
    assert.equal(none.code, 1, none.stdout + none.stderr);
    const n = (JSON.parse(none.stdout) as { error: { code: string; message: string; fix: string } }).error;
    assert.deepEqual([n.code, n.message, n.fix], ["not_found", 'there is no added or generated table "monthly"', "name one of: orders, events, fresh, daily, weekly, broken"]);
  } finally { p.close(); }
});

test("a demo project, stopped: mason tables says its database runs inside mason start, and a table set to sync: replication is refused before anything starts", async () => {
  const tables = await runMason(folderIn("demo"), ["tables", "--json"], matrixEnv());
  assert.equal(tables.code, 1, tables.stdout + tables.stderr);
  const t = (JSON.parse(tables.stdout) as { error: { code: string; message: string; fix: string } }).error;
  assert.deepEqual([t.code, t.message, t.fix], ["unreachable", `could not connect to postgres://demo@${demoAt}/demo: the demo database is not running on ${demoAt}`,
    "the demo database runs inside mason start: start it first"]);
  for (const json of [false, true]) {
    const root = folderFor("demo", "start");
    const start = await runMason(root, ["start", ...(json ? ["--json"] : [])], matrixEnv());
    assert.equal(start.code, 1, start.stdout + start.stderr);
    if (json) assert.equal((JSON.parse(start.stdout) as { error: { code: string } }).error.code, "refused");
    assert.match(json ? start.stdout : start.stderr, /the demo database is read by polling only: sync: replication does not apply to it \(orders\)/);
    assert.equal(fs.existsSync(path.join(root, ".mason", "dev.log")), false, "refused before a run was spawned");
  }
});

test("a project 0.7.0 streamed, its file silent on sync: mason start is refused in every state of its config, before it connects, the config as it was; a sync: written goes on to the database", async () => {
  for (const running of [null, "stale", "squatted"] as const) {
    for (const json of [false, true]) {
      const root = folderIn(running ?? "stopped");
      const config = path.join(root, ".mason", "config.json");
      fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")) as object, ...V0_7_STREAMED }));
      const was = fs.readFileSync(config, "utf8");
      const files = fs.readdirSync(path.join(root, "mason"));
      const start = await runMason(root, ["start", ...(json ? ["--json"] : [])], matrixEnv());
      assert.equal(start.code, 1, start.stdout + start.stderr);
      if (json) {
        const e = (JSON.parse(start.stdout) as { error: { code: string; message: string; fix: string } }).error;
        assert.deepEqual([e.code, e.message], ["refused", "this project streams, and mason/sources/shop.yml does not say so: no sync: at its top or on an entry"]);
        assert.match(e.fix, /write sync: replication at the top of mason\/sources\/shop\.yml; .* confirm it with sync: off or sync: poll <interval> there$/);
      } else assert.match(start.stderr, /mason start: this project streams, and mason\/sources\/shop\.yml does not say so/m);
      assert.equal(fs.readFileSync(config, "utf8"), was, "the config untouched");
      assert.deepEqual(fs.readdirSync(path.join(root, "mason")), files, "the pin not written");
      assert.equal(fs.existsSync(path.join(root, ".mason", "dev.log")), false, "refused before a run was spawned");
      // --attach is the run itself, which mason serve reaches too: the same refusal, nothing written
      const attached = await runMason(root, ["start", "--attach"], matrixEnv());
      assert.equal(attached.code, 1, attached.stdout + attached.stderr);
      assert.match(attached.stdout + attached.stderr, /this project streams/);
      assert.equal(fs.readFileSync(config, "utf8"), was, "the run wrote nothing either");
    }
  }
  // any sync: is the way past it: the next thing met is the database, which is away here
  const root = folderIn("streamed_0_7");
  const file = path.join(root, "mason", "sources", "shop.yml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("tables:", "sync: off\ntables:"));
  const through = await runMason(root, ["start", "--json"], matrixEnv());
  assert.doesNotMatch(through.stdout + through.stderr, /this project streams/);
});

test("mason init --remote, in every state: an option that is gone (issue 888), a wrong command line before anything is read or written", async () => {
  for (const state of STATES) {
    const root = folderIn(state);
    const was = fs.existsSync(path.join(root, ".mason", "config.json")) ? fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8") : null;
    for (const json of [false, true]) {
      const a = await runMason(root, ["init", "postgres://mason@db.example.com/shop", "--remote", ...(json ? ["--json"] : [])], matrixEnv());
      assert.equal(a.code, 2, `${state}: ${a.stdout}${a.stderr}`);
      if (json) assert.equal((JSON.parse(a.stdout) as { error: { code: string; message: string } }).error.message, "there is no option --remote", state);
      else assert.match(a.stderr, /mason init: there is no option --remote\n/, state);
      assert.doesNotMatch(a.stdout + a.stderr, /at .*\.ts:\d+/, `${state}: no stack`);
    }
    assert.equal(fs.existsSync(path.join(root, ".mason", "config.json")) ? fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8") : null, was, `${state}: nothing written`);
  }
});

test("MASON_CHANGES refuses mason start as it does mason serve, naming the line, in every state of a project; a state below a project answers its own", async () => {
  for (const state of ["stopped", "stale", "squatted", "streamed_0_7"] as const) {
    const root = folderIn(state);
    const was = fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8");
    const start = await runMason(root, ["start", "--json"], matrixEnv({ MASON_CHANGES: "replication" }));
    assert.equal(start.code, 1, start.stdout + start.stderr);
    const e = (JSON.parse(start.stdout) as { error: { code: string; message: string; fix: string } }).error;
    assert.equal(e.code, "refused", state);
    // settings first, at both entrances: the record's refusal is the next edit's
    assert.equal(e.message, "MASON_CHANGES=replication is no longer read", state);
    assert.equal(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8"), was, state);
    assert.equal(e.fix, "write sync: replication at the top of mason/sources/shop.yml (every table; a table's entry may say its own), then unset MASON_CHANGES");
    assert.equal(fs.existsSync(path.join(root, ".mason", "dev.log")), false, "refused before a run was spawned");
    // the run, as --attach reaches it
    const attached = await runMason(root, ["start", "--attach"], matrixEnv({ MASON_CHANGES: "replication" }));
    assert.equal(attached.code, 1, attached.stdout + attached.stderr);
    assert.ok((attached.stdout + attached.stderr).includes(e.message), `${state}: --attach says the same: ${attached.stdout}${attached.stderr}`);
  }
  const none = await runMason(folderIn("no_project"), ["start", "--json"], matrixEnv({ MASON_CHANGES: "poll" }));
  assert.equal((JSON.parse(none.stdout) as { error: { code: string } }).error.code, "no_project");
  const broken = await runMason(folderIn("broken"), ["start", "--json"], matrixEnv({ MASON_CHANGES: "poll" }));
  assert.equal(broken.code, 1, broken.stdout + broken.stderr);
  assert.doesNotMatch(broken.stdout, /MASON_CHANGES/);
});

test("memory under the floor with MASON_DUCKDB_MEMORY unset never refuses mason start, in any state of a project: it goes on to what it meets next (issue 301, a warning by Tom's decision)", async () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "mason-start-memory-"));
  try {
    const small = containerMemoryEnv(hooks, 1024 ** 3);
    for (const state of ["stopped", "stale", "squatted", "streamed_0_7"] as const) {
      const root = folderIn(state);
      const start = await runMason(root, ["start", "--json"], matrixEnv(small));
      assert.doesNotMatch(start.stdout + start.stderr, /Mason needs/, `${state}: not refused for memory`);
      const attached = await runMason(root, ["start", "--attach"], matrixEnv(small));
      assert.doesNotMatch(attached.stdout + attached.stderr, /✗ mason start: .*Mason needs/, `${state}: the run is not refused for memory`);
      // it goes on to what that state meets next: the database, or the record a streamed project's file must say
      assert.match(attached.stdout + attached.stderr, state === "streamed_0_7" ? /this project streams, and mason\/sources\/shop\.yml does not say so/ : /Connecting to/,
        `${state}: it went on: ${attached.stdout}${attached.stderr}`);
    }
    // not an amount: refused as on main, before it spawns and in the run
    const root = folderIn("stopped");
    const bad = await runMason(root, ["start", "--json"], matrixEnv({ ...small, MASON_DUCKDB_MEMORY: "lots" }));
    assert.equal(bad.code, 1, bad.stdout + bad.stderr);
    assert.equal((JSON.parse(bad.stdout) as { error: { code: string; message: string } }).error.message, 'MASON_DUCKDB_MEMORY="lots" is not an amount of memory');
    assert.equal(fs.existsSync(path.join(root, ".mason", "dev.log")), false, "refused before a run was spawned");
  } finally { fs.rmSync(hooks, { recursive: true, force: true }); }
});

test("memory under the floor: mason start STARTS and warns once, in the one text, at its start, in mason status (text and --json) while it runs, and in mason doctor before (issue 301)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-start-floor-")));
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "mason-start-floor-hook-"));
  const env = matrixEnv({ ...containerMemoryEnv(hooks, 1024 ** 3), MASON_PG_PORT: String(await unassignedPort()) });
  const mason = (argv: string[]): Promise<Answer> => runMason(root, argv, env, 120_000);
  const warning = "1.0 GiB of memory is under the 3.0 GiB Mason needs: 1.0 GiB is the container's memory limit; beside what the synced data's statements may use, " +
    "Mason itself needs up to 2.5 GiB (measured, with a margin), and with less the system may stop the whole run, every session with it, when a first sync, a burst of writes or a statement needs the memory — " +
    "give it 3.0 GiB or more (the container's memory limit), or set MASON_DUCKDB_MEMORY=<n> to choose the statements' share yourself, the rest left to Mason (mason doctor says what it leaves)";
  try {
    const init = await mason(["init", "demo"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    // the demo's database on a port the OS never hands out (tests/test-ports.ts), as tests/cli-demo-start.test.ts moves it
    const dotEnv = path.join(root, ".env");
    fs.writeFileSync(dotEnv, fs.readFileSync(dotEnv, "utf8").replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${await unassignedPort()}`));
    // mason doctor before the start: a warning (ok, said loudly), never a failure
    const doctor = await mason(["doctor", "--json"]);
    const memory = (JSON.parse(doctor.stdout) as { checks: Array<{ name: string; ok: boolean; warn?: boolean; detail: string }> }).checks.find((c) => c.name === "memory")!;
    assert.deepEqual([memory.ok, memory.warn], [true, true], doctor.stdout);
    assert.ok(memory.detail.startsWith(warning), memory.detail);
    const start = await mason(["start"]);
    assert.equal(start.code, 0, `it starts: ${start.stdout}${start.stderr}`);
    assert.equal(start.stdout.split(`  ! ${warning}\n`).length - 1, 1, `the warning once, at its start: ${start.stdout}`);
    assert.match(start.stdout, /at most 128MiB of memory \(MASON_DUCKDB_MEMORY\)/, "the least share, under the floor");
    const status = await mason(["status", "--json"]);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.deepEqual((JSON.parse(status.stdout) as { warnings: string[] }).warnings.filter((w) => w.includes("Mason needs")), [warning], "mason status --json, while it runs");
    const text = await mason(["status"]);
    assert.ok(text.stdout.includes("Mason needs"), `mason status says it: ${text.stdout}`);
    assert.ok(fs.readFileSync(path.join(root, ".mason", "mason.log"), "utf8").includes(`warning: ${warning}`), "the log has it (mason logs)");
  } finally {
    const stop = await mason(["stop"]);
    if (stop.code !== 0) process.stderr.write(`memory floor test: mason stop failed:\n${stop.stdout}${stop.stderr}\n`);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hooks, { recursive: true, force: true });
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

/** Every file under `root` but the run's own `.mason/`, with its bytes and its mtime: what an edit refused must leave as it was. */
function projectFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const at = path.join(e.parentPath, e.name);
    const rel = path.relative(root, at);
    if (rel.startsWith(".mason")) continue;
    out[rel] = `${fs.statSync(at).mtimeMs} ${fs.readFileSync(at, "base64")}`;
  }
  return out;
}

test("a deployed project (MASON_PROJECT_READONLY): mason add, mason remove and mason init are refused in every way it is said, with the Failure and nothing written; unset, nothing changes", async () => {
  const deployedFailure = (e: { code: string; message: string; why?: string; fix?: string }, next: Array<{ command: string }>, message: string): void => {
    assert.deepEqual([e.code, e.message, e.why, e.fix, next.map((n) => n.command)], ["refused", message,
      "Mason runs them as they were deployed: an edit here would run what nobody committed, and the next deploy would undo it",
      "edit the files and deploy them: mason add or mason remove where the project is committed, then commit and deploy", ["mason status"]]);
  };
  // the record (the run started with it), the setting in this shell, and the record under a shell saying 0: each refuses
  const ways: Array<{ state: "deployed" | "stopped"; env: Record<string, string>; message: string }> = [
    { state: "deployed", env: {}, message: "the project's files are read-only here (MASON_PROJECT_READONLY=1 when Mason last started)" },
    { state: "deployed", env: { MASON_PROJECT_READONLY: "0" }, message: "the project's files are read-only here (MASON_PROJECT_READONLY=1 when Mason last started)" },
    { state: "stopped", env: { MASON_PROJECT_READONLY: "1" }, message: "the project's files are read-only here (MASON_PROJECT_READONLY=1)" },
  ];
  for (const w of ways) {
    for (const argv of [["add", "orders"], ["add", "orders", "--sync", "poll 30s"], ["remove", "orders"], ["init", "postgres://mason:secret@127.0.0.1:1/shop"]]) {
      const root = folderIn(w.state);
      const was = projectFiles(root);
      const config = fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8");
      const a = await runMason(root, [...argv, "--json"], matrixEnv(w.env));
      const line = `${w.state} ${JSON.stringify(w.env)} mason ${argv.join(" ")}`;
      assert.equal(a.code, 1, `${line}: ${a.stdout}${a.stderr}`);
      const v = JSON.parse(a.stdout) as { error: { code: string; message: string; why?: string; fix?: string }; next: Array<{ command: string }> };
      // mason init in a project with a sources file says that first: it is already the project (and writes nothing)
      if (argv[0] === "init") assert.match(v.error.message, /already the Mason project/, line);
      else deployedFailure(v.error, v.next, w.message);
      assert.deepEqual(projectFiles(root), was, `${line}: no project file written`);
      assert.equal(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8"), config, `${line}: the config as it was`);
      // as a person: the failure's head, why and fix
      const person = await runMason(root, argv, matrixEnv(w.env));
      assert.equal(person.code, 1, line);
      if (argv[0] !== "init") assert.ok(person.stderr.includes(`mason ${argv[0]}: ${w.message}`), `${line}: ${person.stderr}`);
      assert.deepEqual(projectFiles(root), was, `${line}, as a person: no project file written`);
    }
  }
  // mason init in a new folder under the setting: refused before the database is asked, nothing written at all
  const empty = folderIn("no_project");
  const init = await runMason(empty, ["init", "postgres://mason:secret@127.0.0.1:1/shop", "--json"], matrixEnv({ MASON_PROJECT_READONLY: "1" }));
  assert.equal(init.code, 1, init.stdout + init.stderr);
  const iv = JSON.parse(init.stdout) as { error: { code: string; message: string; why?: string; fix?: string }; next: Array<{ command: string }> };
  deployedFailure(iv.error, iv.next, "the project's files are read-only here (MASON_PROJECT_READONLY=1)");
  assert.deepEqual(fs.readdirSync(empty), [], "nothing written");
  // a value that is neither 0 nor 1 cannot tell: the edit is refused, naming it, and mason start refuses to start
  for (const bad of ["yes", "true", "2", " 1"]) {
    const root = folderIn("stopped");
    const was = projectFiles(root);
    const a = await runMason(root, ["add", "orders", "--json"], matrixEnv({ MASON_PROJECT_READONLY: bad }));
    const e = (JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string } }).error;
    assert.deepEqual([a.code, e.code, e.message, e.fix], [1, "refused",
      `MASON_PROJECT_READONLY=${JSON.stringify(bad)}: 1 (the project's files are deployed, and read-only here) or 0 (the default), so whether the project's files may be written here cannot be told`,
      "set MASON_PROJECT_READONLY=1 or MASON_PROJECT_READONLY=0, or unset it"], bad);
    const start = await runMason(root, ["start", "--json"], matrixEnv({ MASON_PROJECT_READONLY: bad }));
    const se = (JSON.parse(start.stdout) as { error: { code: string; message: string } }).error;
    assert.deepEqual([start.code, se.code, se.message], [1, "refused", `MASON_PROJECT_READONLY=${JSON.stringify(bad)}: 1 (the project's files are deployed, and read-only here) or 0 (the default)`], bad);
    assert.equal(fs.existsSync(path.join(root, ".mason", "dev.log")), false, "refused before a run was spawned");
    assert.deepEqual(projectFiles(root), was, bad);
  }
  // THE RECORD IS THE RUN'S (src/cli/dev.ts): a start with the setting records it, before it connects; one without removes it
  const recordOf = (root: string): unknown => (JSON.parse(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8")) as { projectReadOnly?: unknown }).projectReadOnly;
  const plain = folderIn("stopped");
  const started = await runMason(plain, ["start", "--attach"], matrixEnv({ MASON_PROJECT_READONLY: "1" }), 90_000);
  assert.equal(started.code, 1, "the database does not answer");
  assert.equal(recordOf(plain), true, started.stdout + started.stderr);
  const deployed = folderIn("deployed");
  const unset = await runMason(deployed, ["start", "--attach"], matrixEnv(), 90_000);
  assert.equal(unset.code, 1, "the database does not answer");
  assert.equal(recordOf(deployed), undefined, unset.stdout + unset.stderr);
  // unset, or 0, with no record: an edit goes on to the database as it always did (here it does not answer)
  for (const env of [{}, { MASON_PROJECT_READONLY: "0" }]) {
    const a = await runMason(folderIn("stopped"), ["add", "orders", "--json"], matrixEnv(env));
    assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "unreachable", JSON.stringify(env));
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
      // destroy there tries the slot on a database that is away, and answers per project (`removed[].error`), exit 1:
      // its own shape, not this state's (tests/integration/cli-upgrade.itest.ts drops the slot of such a project)
      if (state === "streamed_0_7" && c.name === "destroy") continue;
      // start in a stopped project is the session's transition (it connects to the database): its refusal here is
      // the database not answering, which is checked; stop is harmless where nothing runs
      for (const args of [MATRIX_ARGS[c.name]!, ...(MATRIX_EXTRA_ARGS[c.name] ?? [])]) {
        for (const json of takesJson(c.name) ? [false, true] : [false]) {
          jobs.push(async () => {
            const root = folderFor(state, c.name);
            const argv = [c.name, ...args, ...(json ? ["--json"] : [])];
            return { state, cmd: c.name, json, a: await runMason(root, argv, env, TRANSITIONS.has(c.name) ? 90_000 : 30_000) };
          });
        }
      }
      // its other modes, --json each (MATRIX_MORE)
      for (const line of MATRIX_MORE[c.name] ?? []) {
        jobs.push(async () => ({ state, cmd: c.name, json: true, a: await runMason(folderIn(state), [c.name, ...line, "--json"], env, 30_000) }));
      }
    }
  }
  const answers = await pool(jobs, Math.max(2, Math.min(8, os.availableParallelism())));
  const problems = answers.flatMap(({ state, cmd, json, a }) => {
    // a command in a state that does not meet what it needs answers with THAT state's code (src/cli/state.ts reach)
    const needs = COMMANDS.find((c) => c.name === cmd)!.needs;
    const codes = needs && !meetsNeed(state, needs) ? PROJECT_STATES[IS[state]].codes : [];
    const p = answerProblems(cmd, a, json, codes);
    // a folder holding mason/ alone is a project to mason deploy: its dry run reads the files, and meets the sources
    // file's url: written with its password (refused: the replica keeps the files), never "no project"
    if (state === "files_only" && cmd === DEPLOY.name && !(json ? a.stdout : a.stderr).includes("mason/sources/shop.yml: url: is written with its password")) {
      p.push(`mason ${a.argv.join(" ")}: not the sources file's refusal, where mason/ is the project's files:\n${a.stdout}${a.stderr}`);
    }
    if (json && codes.length && a.code === 0) p.push(`mason ${a.argv.join(" ")}: exit 0, where ${IS[state]} does not meet what it needs (${needs})`);
    // what a project copies is its sources file's tables: no answer names a model, at any depth
    if (json) for (const k of keysNamingAModel(a.stdout)) p.push(`mason ${a.argv.join(" ")}: --json answers with a key ${k}, where it says table or source`);
    // a key named source is the database, an object; a table is table
    if (json) for (const k of sourcesNotADatabase(a.stdout)) p.push(`mason ${a.argv.join(" ")}: --json answers ${k}, where source is the database's object and a table is table`);
    return p.map((x) => `[${state}] ${x}`);
  });
  assert.deepEqual(problems, []);
});

test("mason user --replica, in every state without a run, as a person and with --json: no project is read, so every state answers alike — not signed in, refused before a byte is sent, never the state's code", { timeout: 300_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mason-matrix-home-"));
  made.push(home);
  const env = matrixEnv({ HOME: home, PATH: path.dirname(process.execPath) });
  const jobs: Array<() => Promise<{ state: (typeof STATES)[number]; cmd: string; json: boolean; a: Answer; users: string | null }>> = [];
  for (const state of STATES) {
    for (const [cmd, lines] of Object.entries(MATRIX_HOSTED)) {
      for (const line of lines) for (const json of [false, true]) {
        jobs.push(async () => {
          const root = folderIn(state);
          const users = path.join(root, ".mason", "users.json");
          const before = fs.existsSync(users) ? fs.readFileSync(users, "utf8") : null;
          const a = await runMason(root, [cmd, ...line, ...(json ? ["--json"] : [])], env, 30_000);
          return { state, cmd, json, a, users: (fs.existsSync(users) ? fs.readFileSync(users, "utf8") : null) === before ? null : users };
        });
      }
    }
  }
  const answers = await pool(jobs, Math.max(2, Math.min(8, os.availableParallelism())));
  assert.ok(answers.length >= STATES.length * 6);
  const problems = answers.flatMap(({ state, cmd, json, a, users }) => {
    const p = answerProblems(cmd, a, json, ["refused"]);
    if (a.code !== 1) p.push(`mason ${a.argv.join(" ")}: exit ${a.code}, where not signed in is 1`);
    if (!(json ? a.stdout : a.stderr).includes("this machine is not signed in to http://127.0.0.1:1")) p.push(`mason ${a.argv.join(" ")}: not the login's refusal:\n${a.stdout}${a.stderr}`);
    if (users !== null) p.push(`mason ${a.argv.join(" ")}: changed ${users}`);
    return p.map((x) => `[${state}] ${x}`);
  });
  assert.deepEqual(problems, []);
});

test("mason replica and mason token, in every state without a run, as a person and with --json: nothing is sent and nothing of the project written — create says the state, the url: written in the file or the login, every other line the login", { timeout: 300_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mason-matrix-home-"));
  made.push(home);
  const env = matrixEnv({ HOME: home, PATH: path.dirname(process.execPath) });
  const lines: Array<[string, readonly string[]]> = ["replica", "token"].flatMap((cmd) => [MATRIX_ARGS[cmd]!, ...(MATRIX_EXTRA_ARGS[cmd] ?? [])].map((l): [string, readonly string[]] => [cmd, l]));
  const jobs: Array<() => Promise<{ state: (typeof STATES)[number]; cmd: string; line: readonly string[]; json: boolean; a: Answer; changed: boolean }>> = [];
  for (const state of STATES) for (const [cmd, line] of lines) for (const json of [false, true]) {
    jobs.push(async () => {
      const root = folderIn(state);
      const snapshot = (): string => fs.existsSync(path.join(root, "mason")) ? fs.readdirSync(root, { recursive: true }).map(String).sort().join("\n") : "";
      const before = snapshot();
      const a = await runMason(root, [cmd, ...line, ...(json ? ["--json"] : [])], env, 30_000);
      return { state, cmd, line, json, a, changed: snapshot() !== before };
    });
  }
  const answers = await pool(jobs, Math.max(2, Math.min(8, os.availableParallelism())));
  assert.equal(answers.length, STATES.length * lines.length * 2);
  const problems = answers.flatMap(({ state, cmd, line, json, a, changed }) => {
    const said = json ? a.stdout : a.stderr;
    const create = cmd === "replica" && line[0] === "create";
    // what create meets first: the state's own refusal, else the sources file's literal url (every state's but the demo's), else the login
    const want = !create ? "this machine is not signed in to http://127.0.0.1:1" : state === "no_project" || state === "files_only" ? "no Mason project here or above"
      : state === "broken" ? ".mason/config.json" : state === "demo" ? "this machine is not signed in to http://127.0.0.1:1" : "mason/sources/shop.yml: url: is written in the file";
    const p = answerProblems(cmd, a, json, create && (state === "no_project" || state === "files_only") ? ["no_project"] : create && state === "broken" ? ["bad_config"] : ["refused"]);
    if (a.code !== 1) p.push(`mason ${a.argv.join(" ")}: exit ${a.code}, where 1 is owed`);
    if (!said.includes(want)) p.push(`mason ${a.argv.join(" ")}: not ${JSON.stringify(want)}:\n${a.stdout}${a.stderr}`);
    if (/postgres:\/\/mason:secret@/.test(a.stdout + a.stderr)) p.push(`mason ${a.argv.join(" ")}: printed the sources file's URL`);
    if (changed) p.push(`mason ${a.argv.join(" ")}: changed the project's folder`);
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
