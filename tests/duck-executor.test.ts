/**
 * THE EXECUTOR WORKER (src/duck/executor.ts; docs/DESIGN.md "The executor worker"). On the test server a
 * JSON read through a Mason function over 22 M rows took 98 s, and for those 98 s the whole process was silent: every
 * `__mason_*` function is JavaScript, DuckDB's executor threads call it on the thread that registered it, and that was
 * the main thread — the listener, the commands, even the cancel of a client that had left waited for the statement.
 * DuckDB now lives on a worker of its own: the listener's thread runs no function call, and a cancel is written to
 * shared memory the calls read (src/duck/cancel.ts), never posted to the busy worker.
 *
 * Offline, over a generated table (DuckDB's own range(): no customer's data), with the listener and the run's command
 * server as `mason start` wires them (src/cli/dev.ts).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import type { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-executor-"));
const logged: string[] = [];
let store: DuckStore;
let api: PgApiServer;
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
const ROWS = 6_000_000;
const CALLING = "SELECT count(*) FROM gen WHERE (j -> 'n') IS NOT NULL";
const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "gen", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "j", type: "jsonb" }] },
    { name: "small", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }] },
  ],
};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => { logged.push(l); });
  await store.writer.run(`CREATE TABLE public.gen AS SELECT range::INTEGER AS id, '{"n": ' || range || ', "pad": "' || repeat('x', 40) || '"}' AS j FROM range(${ROWS})`);
  await store.writer.run("CREATE TABLE public.small AS SELECT range::INTEGER AS id FROM range(10)");
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
    slot: "", changes: "poll", port: 0, token: TOKEN, folder: () => null, root: dir, sources: () => ({ file: null, problem: null }), sourcesChanged: () => undefined,
    readSource: () => ({ message: "no sources file here", code: "bad_source" }), runUrl: "", log: () => undefined,
    duck: { copies: () => [], file: path.join(dir, "duck.db"), pollSeconds: 5, poll: async () => ({ at: new Date().toISOString(), tables: [] }), stream: async () => null,
      requests: { days: 7, recent: async () => [], slow: async () => [], refused: async () => ({ total: 0, refused: [] }) } },
  };
  control = createRunServer(ctx);
  await new Promise<void>((r) => control.listen(0, "127.0.0.1", () => r()));
  controlPort = ctx.port = (control.address() as net.AddressInfo).port;
});
after(async () => {
  control.close();
  await api.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = async (): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  return c;
};

/** the command server's ping, as `mason status` asks it: its status, or the failure */
const ping = (): Promise<number> => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: controlPort, path: "/api/ping", headers: { Host: `127.0.0.1:${controlPort}`, Authorization: `Bearer ${TOKEN}` } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode ?? 0));
  });
  req.on("error", reject);
  req.end();
});

/** how long `f` took, ms */
async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await f();
  return { ms: performance.now() - t0, value };
}

const released = (from: number): boolean => logged.slice(from).some((l) => /^statement: \d+ row\(s\) in \d+ ms — SELECT count\(\*\) AS count FROM gen/.test(l));

test("a statement calling a Mason function on every row starves no one but its thread: another session, a new login and the command server answer within a second", { timeout: 120_000 }, async (t) => {
  const a = await client();
  const login = (): Promise<number> => (async () => { const c = await client(); try { return (await c.query("SELECT 1 AS one")).rows[0].one as number; } finally { await c.end(); } })();
  try {
    const idle = await timed(login);
    const from = logged.length;
    const t0 = Date.now();
    const slow = a.query(CALLING);
    await sleep(500);
    assert.ok(!released(from), "the calling statement is still running when the others ask (make ROWS larger if this machine is faster)");
    const other = await timed(login);
    const pinged = await timed(ping);
    t.diagnostic(`login + SELECT 1: ${Math.round(idle.ms)} ms idle, ${Math.round(other.ms)} ms during the calling statement; /api/ping ${Math.round(pinged.ms)} ms`);
    assert.ok(other.ms < 1000, `a new session's login and SELECT 1 took ${Math.round(other.ms)} ms during the calling statement`);
    assert.ok(pinged.ms < 1000, `the command server's /api/ping took ${Math.round(pinged.ms)} ms during the calling statement`);
    assert.equal(other.value, 1);
    assert.equal(pinged.value, 200);
    // what still waits for the copy's thread, said and not held: a statement over a copied table is a request to it
    const copied = await timed(async () => { const c = await client(); try { return (await c.query("SELECT count(*) AS n FROM small")).rows[0].n as string; } finally { await c.end(); } });
    t.diagnostic(`a statement over a copied table: ${Math.round(copied.ms)} ms (the calling statement had run ${Date.now() - t0} ms when it was answered)`);
    assert.equal(copied.value, "10");
    assert.equal(String((await slow).rows[0].count), String(ROWS), "and the calling statement answers");
  } finally { await a.end(); }
});

test("a client leaving mid-statement cancels its function-calling statement within about a second, however busy the copy's thread", { timeout: 120_000 }, async (t) => {
  const a = await client();
  a.on("error", () => undefined);   // pg reports the socket torn down below as an error event: what the test does
  const from = logged.length;
  const slow = a.query(CALLING).then(() => "answered", (e: Error) => e.message);
  await sleep(500);
  assert.ok(!released(from), "the calling statement is still running when its client leaves (make ROWS larger if this machine is faster)");
  const left = Date.now();
  (a as unknown as { connection: { stream: net.Socket } }).connection.stream.destroy();
  for (;;) {
    if (released(from)) break;
    if (Date.now() - left > 2_000) throw new Error(`the statement was not released within 2 s of its client leaving\n${logged.slice(from).join("\n")}`);
    await sleep(20);
  }
  const ms = Date.now() - left;
  t.diagnostic(`released ${ms} ms after its client left`);
  assert.ok(ms < 1500, `released ${ms} ms after its client left`);
  assert.match(await slow, /Connection terminated|terminated unexpectedly|closed/);
  // the copy goes on answering
  const c = await client();
  try { assert.equal(String((await c.query("SELECT count(*) AS n FROM small")).rows[0].n), "10"); }
  finally { await c.end(); }
});

// A RESULT CLOSED AFTER ITS LAST ROW, BEFORE ITS END (found writing the tests above). A statement that calls
// a Mason function is released only once DuckDB hands its result back (`drain`, src/duck/store.ts), and past its end a
// streamed result hands back EMPTY chunks for ever, never null: the drain read on without end — a thread spinning, the
// session's close waiting on it. Run in a process of its own, killed when it does not end: a spin never lets one end.
test("a function-calling statement's answer closed after its last row and before its end is released, and its session closes", { timeout: 60_000 }, () => {
  const store = fileURLToPath(new URL("../src/duck/store.ts", import.meta.url));
  const file = path.join(dir, "drain.db");
  const script = `
    const { DuckStore } = await import(${JSON.stringify(store)});
    const store = await DuckStore.open(${JSON.stringify(file)}, () => undefined);
    await store.writer.run("CREATE TABLE public.t AS SELECT range AS id, '{\\"n\\": ' || range || '}' AS j FROM range(10)");
    const r = await store.runner();
    const session = { timeZone: "UTC", searchPath: "public" };
    // the rewrite's call of json's -> (src/duck/rewrite.ts fn): the session first
    // a planned statement (src/duck/plan.ts PlannedSql): its text, and the functions its plan says it calls
    const a = await r.run({ text: "SELECT count(*) FROM t WHERE __mason_json_get(getvariable('__mason_session'), j, '[\\"n\\"]', false, true, false) IS NOT NULL",
      functions: ["__mason_json_get"] }, [], session, new AbortController().signal);
    const rows = await a.fetch([], { timeZone: "UTC" });
    a.close();
    await r.close();
    await store.close();
    console.log("closed after " + rows.length + " row(s)");
  `;
  // a file, never --eval: a worker thread inherits the process's flags, and --input-type refuses a worker's file
  const scriptFile = path.join(dir, "drain.mjs");
  fs.writeFileSync(scriptFile, script);
  const run = spawnSync(process.execPath, [scriptFile], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.signal, null, `the session did not close within 20 s of its answer's close (killed): ${run.stderr}`);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "closed after 1 row(s)");
});

// THE COPY'S THREAD DYING (V8 out of heap there, an uncaught error: src/duck/executor.ts). Every statement in flight and
// every later one is told 57P02 with the reason and the way out, never left waiting, and the run is told (src/cli/dev.ts
// exits for its supervisor). The worker is ended from outside here, as either would end it: the executor's is private.
test("the copy's thread dying mid-statement is said to the session (57P02, why, reconnect) and to the run, never a hang", { timeout: 60_000 }, async () => {
  const own = await DuckStore.open(path.join(dir, "crash.db"), () => undefined);
  const said: string[] = [];
  own.onCrash((reason) => { said.push(reason); });
  await own.writer.run(`CREATE TABLE public.gen AS SELECT range::INTEGER AS id, '{"n": ' || range || '}' AS j FROM range(${ROWS})`);
  const server = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined, duck: await own.listener(undefined),
  });
  const connect = async (): Promise<pg.Client> => {
    const c = new pg.Client({ host: "127.0.0.1", port: server.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
    await c.connect();
    return c;
  };
  const c = await connect();
  try {
    const running = c.query(CALLING).then(() => null, (e: pg.DatabaseError) => e);
    await sleep(300);
    await (own as unknown as { executor: { worker: Worker } }).executor.worker.terminate();
    const gone = (e: pg.DatabaseError | null): boolean => e !== null && e.code === "57P02" && /the copy's engine stopped/.test(e.message) &&
      /exited with code 1/.test(e.detail ?? "") && /reconnect/.test(e.hint ?? "");
    const e = await running;
    assert.ok(gone(e), `the statement in flight: ${JSON.stringify(e && { code: e.code, message: e.message, detail: e.detail, hint: e.hint })}`);
    assert.deepEqual(said, ["it exited with code 1"], "the run is told once, with the reason");
    // a later statement, and a new session's, are told the same at once
    await assert.rejects(c.query("SELECT count(*) FROM small"), (x: pg.DatabaseError) => gone(x));
    const d = await connect();
    try { await assert.rejects(d.query("SELECT count(*) FROM small"), (x: pg.DatabaseError) => gone(x)); }
    finally { await d.end(); }
  } finally {
    await c.end();
    await server.close();
    await own.close();
  }
});

// ---------------------------------------------------------------------------------------------------------- review findings

/**
 * A process of its own over a store with STORED JSON PATHS (src/duck/kept.ts) and a listener, as `mason start` wires
 * them: `body` runs in it, `say(x)` prints a line of JSON the test reads, and the process must END by itself — a hang is
 * a kill (spawnSync's timeout, a signal), a native abort its exit code (134), each a failure the test can see. The
 * modules are imported by path, so the script runs whatever `src/` the checkout has (scripts/fails-without.ts).
 */
function inProcess(name: string, body: string, ms = 90_000): { status: number | null; signal: NodeJS.Signals | null; said: Record<string, unknown>[]; stdout: string; stderr: string } {
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
  const run = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: ms, env: { ...process.env } });
  const said = run.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: run.status, signal: run.signal, said, stdout: run.stdout, stderr: run.stderr };
}

// A `SELECT *` OVER A COPY WITH A STORED JSON PATH CALLS NO FUNCTION (a review finding). It reads the copy's
// view of its visible columns (`__mason_visible`, src/duck/kept-route.ts hideKept), whose name begins `__mason_`; the
// executor classified a statement as calling a Mason function by that text, so every `*` over such a copy was cancelled
// only through a function call it never made: past a 300 ms statement_timeout it ran 82 s and answered "ok", and a client
// leaving left it running over a minute. Whether a statement calls a function is now its plan's (PlannedSql.functions).
const NO_ROW_EVER = "SELECT * FROM docs a, docs b WHERE (a.id::bigint * b.id) % 1000003 = -1";
test("a SELECT * over a copy with a stored JSON path is stopped by a statement_timeout and by its client leaving, each within a second", { timeout: 120_000 }, (t) => {
  const r = inProcess("star", `
    const c = await client();
    await c.query("SELECT j ->> 's' AS s FROM docs LIMIT 1");   // stores the path (eager): the copy has its view now
    say({ hidden: (await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_')")).getRowsJS()[0][0].toString() });
    await c.query("SET statement_timeout = 300");
    let t = Date.now();
    say({ timeout: await Promise.race([outcome(c.query(${JSON.stringify(NO_ROW_EVER)})), sleep(10_000).then(() => "nothing within 10 s")]), ms: Date.now() - t });
    const d = await client();
    const from = logged.length;
    const gone = outcome(d.query(${JSON.stringify(NO_ROW_EVER)}));   // its client leaves: what it is told is nobody's
    await sleep(300);
    d.connection.stream.destroy();
    t = Date.now();
    const released = () => logged.slice(from).find((l) => /^statement: /.test(l));
    while (Date.now() - t < 10_000 && released() === undefined) await sleep(20);
    say({ left: released() ?? "not released within 10 s", ms: Date.now() - t });
    void gone;
    const closed = await Promise.race([(async () => { await c.end(); await api.close(); await keeper.stop(); await store.close(); return "closed"; })(), sleep(10_000).then(() => "not closed within 10 s")]);
    say({ closed });
    process.exit(0);
  `);
  assert.equal(r.signal, null, `the process did not end by itself (${r.signal}): it said\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  const [hidden, timeout, left, closed] = r.said as [{ hidden: string }, { timeout: string; ms: number }, { left: string; ms: number }, { closed: string }];
  t.diagnostic(`statement_timeout 300 ms: answered after ${timeout.ms} ms; client left: released after ${left.ms} ms`);
  assert.equal(hidden.hidden, "1", "the copy has a stored path, so a * reads its view");
  assert.equal(timeout.timeout, "57014 canceling statement due to statement timeout");
  assert.ok(timeout.ms < 1300, `the statement_timeout of 300 ms stopped it after ${timeout.ms} ms`);
  assert.match(left.left, /^statement: \d+ row\(s\) in \d+ ms — SELECT \* FROM __mason_visible\.public\.docs AS a/, "the statement read the copy's view, and was released");
  assert.ok(left.ms < 1000, `released ${left.ms} ms after its client left`);
  assert.equal(closed.closed, "closed");
});

// A STOP DURING A DRAIN (a review finding): the worker's session close took the runner out of its list before
// it had closed, so the shutdown did not wait for it and closed the connections and the instance under the drain's
// pending fetch — the process aborted (exit 134, an uncaught Napi::Error) or hung for good. Stopped as src/cli/dev.ts
// stops (the listener, the keeper, the copy) while a statement is drained, and the copy stopped FIRST under a statement
// still running, whose session is told 57P01; each process must end by itself, exit 0.
test("stopping while a statement is drained ends the process cleanly, and a statement running when the copy stops is told 57P01", { timeout: 300_000 }, () => {
  // the session's first statement first: the catalog started and the runner open, so the stop meets the statement in
  // DuckDB (a statement still being PLANNED when the listener closes restarts the parser's worker, which keeps a process
  // alive: another matter, src/api/postgres/parser.ts)
  const asDevStops = `
    const c = await client();
    await c.query("SELECT count(*) FROM docs");
    const q = outcome(c.query(process.env.SQL));
    await sleep(1000);
    await api.close();
    say({ told: await Promise.race([q, sleep(5_000).then(() => "nothing within 5 s")]) });
    await keeper?.stop();
    await store.close();
    say({ released: logged.some((l) => /^statement: \\d+ row\\(s\\) in \\d+ ms — SELECT .* AS a, .* AS b/.test(l)) });
    say({ stopped: true });
  `;
  let n = 0;
  for (const [what, env] of [
    ["a SELECT * cross join over a copy with a stored path", { SQL: "SELECT * FROM docs a, docs b", ROWS: "4000" }],
    ["a function-calling count over a cross join", { SQL: "SELECT count(*) FROM docs a, docs b WHERE (a.j->'n')::text || (b.j->'n')::text <> ''", ROWS: "4000" }],
    ["a scalar subquery's call, then a call-free cross join, without stored paths", { SQL: "SELECT a.id, b.id, (SELECT (j -> 'n')::text FROM docs WHERE id = 1) AS n FROM docs a, docs b", ROWS: "4000", NO_KEEPER: "1" }],
  ] as const) {
    Object.assign(process.env, env);
    try {
      const r = inProcess(`stop-${n++}`, asDevStops, 60_000);
      assert.equal(r.signal, null, `${what}: the process did not end by itself (${r.signal}: SIGTERM is a hang killed after 60 s, SIGABRT a native abort)\n${r.stdout}\n${r.stderr}`);
      assert.equal(r.status, 0, `${what}: exit ${r.status}\n${r.stderr}`);
      assert.deepEqual(r.said.slice(-2), [{ released: true }, { stopped: true }], `${what}: the statement reached DuckDB, was released, and the copy closed\n${r.stdout}`);
    } finally { for (const k of Object.keys(env)) delete process.env[k]; }
  }
  // the copy stopped under a running statement (a crash path's order, or a stop that skipped the listener): the session
  // is told the stop in Postgres's words for it, never "ok" and never a hang
  Object.assign(process.env, { ROWS: "4000" });
  try {
    const r = inProcess("stop-first", `
      const c = await client();
      // its path stored first (eager, the oracle's way: the plan itself stores it), so the stop meets the statement running
      await c.query("SELECT (j -> 'n')::text FROM docs LIMIT 1");
      const q = outcome(c.query("SELECT count(*) FROM docs a, docs b WHERE (a.j->'n')::text || (b.j->'n')::text <> ''"));
      await sleep(1000);
      await keeper.stop();
      await store.close();
      say({ told: await Promise.race([q, sleep(5_000).then(() => "nothing within 5 s")]) });
      say({ next: await outcome(c.query("SELECT count(*) FROM docs")) });
      await c.end();
      await api.close();
      say({ stopped: true });
    `, 60_000);
    assert.equal(r.signal, null, `the process did not end by itself (${r.signal})\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.said, [{ told: "57P01 terminating connection due to administrator command" }, { next: "57P01 terminating connection due to administrator command" }, { stopped: true }]);
  } finally { delete process.env.ROWS; }
});

// A CANCEL ASKED IS A CANCEL ANSWERED (a review finding): a statement that calls a Mason function is cancelled
// through its session, at its next call; one whose calls are all made early (a scalar subquery) and whose call-free rest
// runs on has no next call, ran to its end and answered "ok" past its timeout. It is told 57014 however it ends. Its
// rest finds NO row, so the timeout lands inside the one fetch that ends the result (a row would come back first, and the
// next fetch would see the cancel before it read on). Since the suite's hang (below) it is interrupted as well, so
// it no longer runs that rest to its end: DuckDB reads an interrupt at its next chunk (microseconds for this join), the
// result is closed once the session's calls have been quiet 50 ms (src/duck/store.ts cleanUp), so the answer comes
// within a second of the timeout — that, not the statement's length, is the bound.
const CALLS_THEN_COUNTS = "SELECT a.id FROM gen a, small b, small d, small e WHERE a.id + b.id + d.id + e.id < (SELECT ((j -> 'n')::text)::int - 100 FROM gen WHERE id = 1)";
test("a timeout that lands after a statement's last function call is 57014, never ok: the session's statement_timeout and MASON_STATEMENT_TIMEOUT", { timeout: 120_000 }, async (t) => {
  const capped = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data", statementTimeoutMs: 300,
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => { logged.push(l); }, duck: await store.listener(undefined),
  });
  const c = await client();
  const d = new pg.Client({ host: "127.0.0.1", port: capped.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await d.connect();
  try {
    const whole = await timed(() => c.query(CALLS_THEN_COUNTS));
    assert.equal(whole.value.rowCount, 0, "its rest finds no row");
    assert.ok(whole.ms > 600, `the statement must outlast a 300 ms timeout by its call-free rest (it took ${Math.round(whole.ms)} ms: make it larger)`);
    await c.query("SET statement_timeout = 300");
    const own = await timed(() => assert.rejects(c.query(CALLS_THEN_COUNTS), (e: pg.DatabaseError) => e.code === "57014" && e.message === "canceling statement due to statement timeout" && e.hint === undefined));
    await c.query("SET statement_timeout = 0");
    // the capped listener's catalog warmed first (its first analysis is a cold PGlite's, ~1 s here): what is timed is
    // the statement, not the catalog's start
    await d.query("SELECT count(*) FROM gen a, small b WHERE a.id = b.id");
    const server = await timed(() => assert.rejects(d.query(CALLS_THEN_COUNTS), (e: pg.DatabaseError) => e.code === "57014" && /MASON_STATEMENT_TIMEOUT/.test(e.hint ?? "")));
    t.diagnostic(`whole: ${Math.round(whole.ms)} ms; under a 300 ms timeout: ${Math.round(own.ms)} ms (the session's), ${Math.round(server.ms)} ms (Mason's)`);
    assert.ok(own.ms < 1300 && server.ms < 1300, `answered ${Math.round(own.ms)} / ${Math.round(server.ms)} ms after it was asked: the rest is interrupted, never run to its end (${Math.round(whole.ms)} ms)`);
    // the sessions go on
    assert.equal(String((await c.query("SELECT count(*) AS n FROM small")).rows[0].n), "10");
    assert.equal(String((await d.query("SELECT count(*) AS n FROM small")).rows[0].n), "10");
  } finally { await c.end(); await d.end(); await capped.close(); }
});

// THE SUITE'S HANG: under load a file's process sat at 0 % CPU for good. Its threads, sampled: the executor
// worker inside a result's close (DuckDB's Executor::CancelTasks, waiting for the query's tasks) and one of DuckDB's
// threads inside a Mason function call (CAPIScalarFunction, waiting for the worker, which runs every function). DuckDB
// hands a cancelled statement's error back while another task of it still waits for a call; the close then waited for
// that task and the task for the closing thread. Every later request to the copy waited with them — the next test's
// statements, the after-hook's close. Cancelled a few hundred times, a statement calling a function on every row met
// it within a minute on a laptop; a result that did not end is now closed only once the session's calls have stopped
// (src/duck/store.ts cleanUp). In a process of its own: a deadlock is a kill, and a test process that cannot end.
test("cancelling a function-calling statement again and again never deadlocks the copy's thread: every one is 57014, and the copy closes", { timeout: 240_000 }, () => {
  const r = inProcess("cancels", `
    await store.writer.run("CREATE TABLE public.calls AS SELECT range::INTEGER AS id, '{\\"n\\": ' || range || '}' AS j FROM range(2000000)");
    const runner = await store.runner();
    const S = { timeZone: "UTC", searchPath: "public" };
    // a planned statement (src/duck/plan.ts PlannedSql) calling json's -> on every row, as the rewrite writes it
    const calling = { text: "SELECT count(*) FROM calls WHERE __mason_json_get(getvariable('__mason_session'), j, '[\\"n\\"]', false, true, false) IS NOT NULL", functions: ["__mason_json_get"] };
    const told = {};
    for (let i = 0; i < 200; i++) {
      const c = new AbortController();
      const q = runner.run(calling, [], S, c.signal).then(async (a) => { await a.fetch([], { timeZone: "UTC" }); return "answered"; }).catch((e) => e.fields?.code ?? e.message);
      await sleep(10 + (i * 37) % 150);
      c.abort();
      const got = await Promise.race([q, sleep(30_000).then(() => "no answer within 30 s")]);
      told[got] = (told[got] ?? 0) + 1;
      if (got === "no answer within 30 s") break;
    }
    say({ told });
    await runner.close();
    await api.close();
    await keeper.stop();
    await store.close();
    say({ closed: true });
  `, 180_000);
  assert.equal(r.signal, null, `the process did not end by itself (${r.signal}: a deadlock, killed): it said\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.said, [{ told: { "57014": 200 } }, { closed: true }]);
});

// EVERY CALL TO THE WORKER SETTLES (src/duck/executor.ts SILENT_MS, CLOSE_GRACE_MS): a worker that stops answering —
// here one that answers the open and nothing after, in place of the copy's — leaves no request waiting for ever: they
// are told 57P02 once it has been silent `silentMs`, the run is told, and a close settles within its grace.
test("a copy's thread that stops answering: every request is told 57P02 within its bound, the run is told, and close settles within its grace", { timeout: 60_000 }, async () => {
  const silent = path.join(dir, "silent-worker.mjs");
  fs.writeFileSync(silent, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (m) => { if (m.op === "open") parentPort.postMessage({ id: m.id, ok: true, value: null }); });
`);
  type Exec = { runner(): Promise<unknown>; writer(): { run(sql: string): Promise<unknown> }; onCrash(f: (r: string) => void): void; close(graceMs?: number): Promise<void>; abandoned?: string | null };
  const { Executor } = await import("../src/duck/executor.ts") as unknown as { Executor: { start(o: Record<string, unknown>): Promise<Exec> } };
  const ex = await Executor.start({ file: path.join(dir, "silent.db"), settings: {}, log: () => undefined, silentMs: 1_000, workerFile: silent });
  const crashed: string[] = [];
  ex.onCrash((reason) => crashed.push(reason));
  const t0 = performance.now();
  const outcome = (p: Promise<unknown>): Promise<string> => Promise.race([p.then(() => "answered", (e: { fields?: { code: string }; message: string }) => e.fields?.code ?? e.message), sleep(10_000).then(() => "no answer within 10 s")]);
  const [session, statement] = await Promise.all([outcome(ex.runner()), outcome(ex.writer().run("SELECT 1"))]);
  const ms = performance.now() - t0;
  assert.equal(session, "57P02", "a session asking the silent thread is told the copy's engine stopped");
  assert.match(statement, /answered nothing for 1 s/, "a connection's statement is told why");
  assert.ok(ms < 3_000, `told after ${Math.round(ms)} ms (silent 1 s, pinged every 250 ms)`);
  assert.equal(crashed.length, 1, "the run is told, once");
  assert.equal(String(ex.abandoned ?? ""), crashed[0]);
  const closing = await timed(() => ex.close(500));
  assert.ok(closing.ms < 1_500, `close settled after ${Math.round(closing.ms)} ms`);
  // and a thread silent at the close itself: the close settles within its grace
  const ex2 = await Executor.start({ file: path.join(dir, "silent2.db"), settings: {}, log: () => undefined, workerFile: silent });
  const closing2 = await timed(() => Promise.race([ex2.close(500).then(() => "closed"), sleep(10_000).then(() => "no settle within 10 s")]));
  assert.equal(closing2.value, "closed");
  assert.ok(closing2.ms < 1_500, `close settled after ${Math.round(closing2.ms)} ms (grace 500 ms)`);
  assert.match(String(ex2.abandoned ?? ""), /did not close within 0.5 s/);
});
