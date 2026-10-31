/**
 * LIBUV'S POOL IN A REAL RUN (src/cli/pool-size.cjs, issue 88): `mason serve` and `mason start`, each started as a user
 * starts it (src/cli/mason.cjs, the entry behind the published CLI and the image), run the size set, proved from outside
 * by the process's threads, because libuv starts all of its threads together; an operator's own size is held the same
 * way. And what the size is for: a fifth statement is answered while four heavy ones run.
 *
 * What it needs: IT_POSTGRES_URL, psql on PATH. It writes only inside a database it creates and drops at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { mintToken } from "../../src/duck/token.ts";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "mason.cjs");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_pool_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-pool-"));
const KEY = "p".repeat(48);
/** the pool's threads fewer in a run told UV_THREADPOOL_SIZE=8 than in a run of 64, leaving room for threads of other kinds */
const AT_LEAST_FEWER = 50;
/** long past what a small statement takes, and the time the heavy ones hold their threads in a run where it would wait */
const HEAVY_LIMIT_MS = 15_000;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

/** The threads of a process, from outside it; never 0 for one that is alive, so a failed read cannot pass for a small pool. */
function threadsOf(pid: number): number {
  const n = process.platform === "linux" ? fs.readdirSync(`/proc/${pid}/task`).length
    : spawnSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split("\n").length - 1;
  assert.ok(n > 0, `no threads read for ${pid}`);
  return n;
}

const running: ChildProcess[] = [];
let startRoot: string | null = null;
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, DATABASE_URL: dbUrl };

const mason = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: "utf8", timeout: 300_000 });

after(() => {
  for (const c of running) if (c.exitCode === null) c.kill("SIGTERM");
  if (startRoot !== null) mason(startRoot, baseEnv, "stop", "--json");
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Served { child: ChildProcess; pgPort: number; stop(): Promise<void> }

/** `mason serve` with `items` in its sources file, once it answers and its table is copied. */
async function serve(name: string, extra: Record<string, string>): Promise<Served> {
  const [health, pgPort] = [await freePort(), await freePort()];
  const data = path.join(dir, name, "data"), project = path.join(dir, name, "project");
  fs.mkdirSync(data, { recursive: true });
  const env = { ...baseEnv, MASON_API_KEY: KEY, MASON_DATA: data, MASON_PROJECT: project, MASON_NAME: name, MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1", MASON_PG_PORT: String(pgPort), ...extra };
  const child = spawn(process.execPath, [ENTRY, "serve"], { cwd: data, env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);
  let out = "";
  child.stdout!.on("data", (d) => { out += String(d); });
  child.stderr!.on("data", (d) => { out += String(d); });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const healthy = async (copied: number): Promise<void> => {
    for (const end = Date.now() + 240_000; Date.now() < end; await sleep(200)) {
      if (child.exitCode !== null) throw new Error(`mason serve exited ${child.exitCode}:\n${out}`);
      const r = await fetch(`http://127.0.0.1:${health}/healthz`).catch((e: Error) => { if (!/fetch failed/.test(e.message)) throw e; return null; });
      if (r?.status === 200 && ((await r.json()) as { tables: { copied: number } }).tables.copied === copied) return;
    }
    throw new Error(`mason serve did not answer in time:\n${out}`);
  };
  await healthy(0);
  const add = mason(data, env, "add", "public.items");
  assert.equal(add.status, 0, `mason add:\n${String(add.stdout)}${String(add.stderr)}`);
  await healthy(1);
  return { child, pgPort, stop: async () => { child.kill("SIGTERM"); await exited; } };
}

const client = async (port: number): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port, database: "mason", user: "anyone", password: mintToken(KEY, 600).token });
  await c.connect();
  return c;
};

test("the pool's size is in force on mason serve and mason start, an operator's own is respected, and a fifth statement is answered beside four heavy ones", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 900_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE items (id int PRIMARY KEY); INSERT INTO items SELECT generate_series(1, 2000)");

  const operators = await serve("operators", { UV_THREADPOOL_SIZE: "8" });
  const a = await client(operators.pgPort);
  await a.query("SELECT count(*) FROM items");
  await a.end();
  const eight = threadsOf(operators.child.pid!);
  await operators.stop();

  const served = await serve("served", {});
  try {
    const sixtyFour = threadsOf(served.child.pid!);
    assert.ok(sixtyFour - eight >= AT_LEAST_FEWER, `mason serve runs ${sixtyFour} threads, and ${eight} told UV_THREADPOOL_SIZE=8: the size set did not reach libuv's pool`);

    // FOUR HEAVY STATEMENTS HOLD FOUR THREADS until their limit, and each ending by that limit proves it ran the whole
    // time; the fifth is asked once they are under way and answered before any of them ends
    const heavy = await Promise.all(Array.from({ length: 4 }, () => client(served.pgPort)));
    const asked = await client(served.pgPort);
    try {
      let ended = 0;
      const answers = heavy.map(async (c) => {
        await c.query(`SET statement_timeout = ${HEAVY_LIMIT_MS}`);
        try { return await c.query("SELECT count(*) FROM items a, items b, items c, items d").then(() => "answered"); }
        catch (e) { return (e as { code?: string }).code ?? String(e); }
        finally { ended++; }
      });
      await sleep(2000);
      assert.equal(ended, 0, "the four are still running when the fifth is asked");
      const r = await asked.query("SELECT count(*) AS n FROM items");
      assert.equal(String(r.rows[0].n), "2000");
      assert.equal(ended, 0, "the fifth statement waited for a heavy one to end");
      assert.deepEqual(await Promise.all(answers), ["57014", "57014", "57014", "57014"], "all four ran to their limit");
    } finally {
      await Promise.all([...heavy, asked].map((c) => c.end()));
    }
  } finally {
    await served.stop();
  }

  // mason start: in the background, its run a process of the supervisor's
  const root = path.join(dir, "started");
  fs.mkdirSync(root);
  const env = { ...baseEnv, MASON_PG_PORT: String(await freePort()) };
  const init = mason(root, env, "init", dbUrl, "--name", "started", "--json");
  assert.equal(init.status, 0, `mason init:\n${String(init.stdout)}${String(init.stderr)}`);
  startRoot = root;
  const started = mason(root, env, "start", "--json");
  assert.equal(started.status, 0, `mason start:\n${String(started.stdout)}${String(started.stderr)}`);
  const pid = (JSON.parse(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8")) as { running: { pid: number } }).running.pid;
  const threads = threadsOf(pid);
  assert.ok(threads - eight >= AT_LEAST_FEWER, `mason start's run has ${threads} threads, and a run told UV_THREADPOOL_SIZE=8 had ${eight}`);
});
