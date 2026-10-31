/**
 * WHAT THE EXECUTOR'S TEST FILES SHARE (tests/duck-executor*.test.ts; CI's unit shards, scripts/ci-shards.ts, place each
 * file on its own, so its stress tests can land apart). `useServer` is the listener and the command server over a
 * generated table, as `mason start` wires them; `useScratch` is the temp folder alone, for a file whose tests each run in
 * a process of their own (`inProcess`) and never read that table. Importing this file registers nothing: a test file
 * calls exactly one of the two at its top, and each test file gets a store, a folder and a `logged` of its own.
 */
import { after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";

export const API_KEY = "k".repeat(48);
export const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-executor-"));
export const logged: string[] = [];
export let store: DuckStore;
export let api: PgApiServer;
let control: http.Server;
let controlPort = 0;
const TOKEN = "t0ken-of-this-run";

/**
 * THE STATEMENT THAT CALLS A MASON FUNCTION ON EVERY ROW. Its shape is chosen to stay a function call whatever the
 * rewrite answers natively (a string-valued `->>` is read in DuckDB's own SQL): `->` keeps the json value's text,
 * which only `__mason_json_get` computes as Postgres does, and the value read is a NUMBER, which no string read covers.
 * 6 M rows of jsonb (written canonically per row): several seconds of calls on the test machine, the executor's
 * threads all calling at once — long enough that, where the calls run on the listener's thread (before the executor
 * worker), a leaving client's close lands while the statement still runs.
 */
export const ROWS = 6_000_000;
export const CALLING = "SELECT count(*) FROM gen WHERE (j -> 'n') IS NOT NULL";
export const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "gen", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "j", type: "jsonb" }] },
    { name: "small", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }] },
    { name: "wide", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "n", type: "int4" }, { name: "ts", type: "timestamptz" }, { name: "j", type: "jsonb" }] },
  ],
};
/** the rows of `wide`, which a statement of each per-row function reads in tests/duck-executor-starve.test.ts: more than
 *  2,000 vectors, so a statement is over 1,000 calls of each function (src/duck/functions.ts `registerTurn`) */
export const WIDE_ROWS = 5_000_000;

/** the temp folder removed at the end, for a file that starts no server */
export function useScratch(): void {
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
}

/** the store, the listener and the command server, for every test of the file that calls it */
export function useServer(o: { warm?: boolean; wide?: boolean } = {}): void {
  before(async () => {
    store = await DuckStore.open(path.join(dir, "duck.db"), (l) => { logged.push(l); });
    await store.writer.run(`CREATE TABLE public.gen AS SELECT range::INTEGER AS id, '{"n": ' || range || ', "pad": "' || repeat('x', 40) || '"}' AS j FROM range(${ROWS})`);
    await store.writer.run("CREATE TABLE public.small AS SELECT range::INTEGER AS id FROM range(10)");
    if (o.wide === true) {
      await store.writer.run(`CREATE TABLE public.wide AS SELECT range::INTEGER AS id, (range % 1000)::INTEGER AS n,
        TIMESTAMPTZ '2024-01-01 00:00:00+00' + INTERVAL (range * 13 % 63072000) SECOND AS ts,
        '{"a": ' || (range % 50) || ', "b": "v' || (range % 7) || '", "pad": "' || repeat('x', 40) || '"}' AS j FROM range(${WIDE_ROWS})`);
    }
    api = await startPostgresApi({
      port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
      authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
      schema: () => schema, record: () => undefined, log: (l) => { logged.push(l); },
      duck: await store.listener(undefined),
    });
    // the run's command server, as src/cli/dev.ts starts it: /api/ping is what `mason status` and the supervisor ask
    const parsed = parseSource("postgres://me@localhost:5432/app");
    assert.ok("source" in parsed);
    const ctx: RunContext = {
      source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [],
      replication: () => null, port: 0, token: TOKEN, page: false, users: { file: path.join(dir, "users.json"), apiKey: API_KEY, database: "app", postgresUrl: "postgresql://127.0.0.1:5433/app" }, folder: () => null, root: dir, home: dir, version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => undefined,
      readSource: () => ({ message: "no sources file here", code: "bad_source" }), runUrl: "", log: () => undefined, listener: api,
      logs: { capacity: 2000, recent: () => [] },
      duck: { copies: () => [], file: path.join(dir, "duck.db"), poll: async () => ({ at: new Date().toISOString(), tables: [] }), stream: async () => null, disk: () => ({ path: dir, freeBytes: null, projectedBytes: null }),
        requests: { days: 7, unsupported: async () => [], page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }), summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }), slowest: async () => [], durationsBy: async () => new Map(), 
          lastUsed: async (u) => u.map(() => null) }, events: { days: 7, recent: async () => [] },
        usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [], statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null }, restarts: () => [] },
    };
    control = createRunServer(ctx);
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", () => r()));
    controlPort = ctx.port = (control.address() as net.AddressInfo).port;
    // in this hook: a file's second `before` would not find the listener up
    if (o.warm === true) {
      const c = await client();
      try { await c.query(CALLING); } finally { await c.end(); }
    }
  });
  after(async () => {
    control.close();
    await api.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

export const client = async (): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  return c;
};

/** the command server's ping, as `mason status` asks it: its status, or the failure */
export const ping = (): Promise<number> => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: controlPort, path: "/api/ping", headers: { Host: `127.0.0.1:${controlPort}`, Authorization: `Bearer ${TOKEN}` } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode ?? 0));
  });
  req.on("error", reject);
  req.end();
});

/**
 * `file` run by node in a process of its own, and its end: killed after `ms`, as a hang is. NEVER spawnSync: that blocks
 * this thread for as long as the child takes, every timer of the run with it (issue 58: the watch of the store `before`
 * opened counted the block against a healthy worker, and the next test's statement was refused 57P02).
 */
export function nodeProcess(file: string, ms: number): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

/** how long `f` took, ms */
export async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await f();
  return { ms: performance.now() - t0, value };
}

export const released = (from: number): boolean => logged.slice(from).some((l) => /^statement: \d+ row\(s\) in \d+ ms — SELECT count\(\*\) AS count FROM gen/.test(l));

/**
 * A process of its own over a store with STORED JSON PATHS (src/duck/kept.ts) and a listener, as `mason start` wires
 * them: `body` runs in it, `say(x)` prints a line of JSON the test reads, and the process must END by itself — a hang is
 * a kill (`nodeProcess`'s timeout, a signal), a native abort its exit code (134), each a failure the test can see. The
 * modules are imported by path, so the script runs whatever `src/` the checkout has (scripts/fails-without.ts).
 */
export async function inProcess(name: string, body: string, ms = 90_000): Promise<{ status: number | null; signal: NodeJS.Signals | null; said: Record<string, unknown>[]; stdout: string; stderr: string }> {
  const at = (p: string): string => JSON.stringify(fileURLToPath(new URL(p, import.meta.url)));
  const script = `
    import { createRequire } from "node:module";
    import { setTimeout as sleep } from "node:timers/promises";
    const pg = createRequire(${at("../package.json")})("pg");
    const { DuckStore } = await import(${at("../src/duck/store.ts")});
    const { startPostgresApi } = await import(${at("../src/api/postgres/server.ts")});
    const { mintToken, tokenProblem } = await import(${at("../src/duck/token.ts")});
    const { KeptJsonPaths } = await import(${at("../src/duck/kept.ts")});
    const say = (x) => console.log(JSON.stringify(x));
    const logged = [];
    const KEY = ${JSON.stringify(API_KEY)};
    const store = await DuckStore.open(${JSON.stringify(path.join(dir, `${name}.db`))}, (l) => logged.push(l));
    // the repo's own rows (DuckDB's range()): a JSON document per row, a string and a number in it
    await store.writer.run("CREATE TABLE public.docs AS SELECT range::INTEGER AS id, ('{\\"s\\": \\"x' || (range % 7) || '\\", \\"n\\": ' || range || '}')::JSON AS j FROM range(" + (process.env.ROWS ?? "200000") + ")");
    let turn = Promise.resolve();
    const host = { onWriter(f) { const t = turn.then(f); turn = t.then(() => undefined, () => undefined); return t; },
      served: () => new Map([["public.docs", [{ name: "id", type: "integer" }, { name: "j", type: "jsonb" }]]]), rebuilding: () => false, log: (l) => logged.push(l) };
    const keeper = process.env.NO_KEEPER ? undefined : new KeptJsonPaths(store, host, { enabled: true, eager: true, reviewMs: 0 });
    await keeper?.open();
    const schema = { database: "app", tables: [{ name: "docs", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "j", type: "jsonb" }] }] };
    const api = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
      authenticate: (password) => { const p = tokenProblem(KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
      schema: () => schema, record: () => undefined, log: (l) => logged.push(l), duck: await store.listener(undefined, undefined, undefined, () => [], keeper) });
    const client = async () => { const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(KEY, 600).token }); c.on("error", () => undefined); await c.connect(); return c; };
    const outcome = (q) => q.then((r) => "ok " + r.rowCount, (e) => e.code + " " + e.message);
    ${body}
  `;
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, script);
  const run = await nodeProcess(file, ms);
  const said = run.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: run.status, signal: run.signal, said, stdout: run.stdout, stderr: run.stderr };
}
