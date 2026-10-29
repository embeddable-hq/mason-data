/**
 * `mason serve` AGAINST A REAL POSTGRES (src/cli/serve.ts): the server's whole life as a platform sees it. Started with
 * its settings in the environment and nothing else, /healthz turns 200 once it answers; a table added beside it with
 * `mason add` (as `docker compose exec mason mason add …` does) is copied and counted; the Postgres API answers a token
 * minted from MASON_API_KEY; SIGTERM stops it with exit 0, the run recorded stopped and the copy kept; a second serve
 * over the same data folder resumes that copy instead of copying again.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, and DuckDB's postgres extension (downloaded once per
 * machine). It writes only inside a database it creates, `it_serve_<random>`, and drops it at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mintToken } from "../../src/duck/token.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_serve_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-serve-"));
const KEY = "s".repeat(48);

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

interface Serving { child: ChildProcess; out: () => string; exited: Promise<{ code: number | null; signal: string | null }> }

function startServe(env: Record<string, string>): Serving {
  const child = spawn(process.execPath, [MAIN, "serve"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => { out += String(d); });
  child.stderr!.on("data", (d) => { out += String(d); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, out: () => out, exited };
}

/** /healthz until `until` holds of its answer, or the run exits, or 240 s (the first start reads the source's text order) */
async function healthUntil(port: number, s: Serving, until: (status: number, body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  let last = "(never answered)";
  for (const end = Date.now() + 240_000; Date.now() < end;) {
    if (s.child.exitCode !== null) throw new Error(`mason serve exited ${s.child.exitCode}:\n${s.out()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await r.json() as Record<string, unknown>;
      last = `${r.status} ${JSON.stringify(body)}`;
      if (until(r.status, body)) return body;
    } catch (e) {
      // not listening yet: asked again
      if (!/fetch failed/.test((e as Error).message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`/healthz: ${last}\n${s.out()}`);
}

test("mason serve: healthy once it answers, a table added beside it copied, stopped cleanly by SIGTERM, resumed by the next", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 600_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE items (id int PRIMARY KEY, v text); INSERT INTO items SELECT g, 'v' || g FROM generate_series(1, 500) g");
  const [health, pgPort] = [await freePort(), await freePort()];
  const data = path.join(dir, "data"), project = path.join(dir, "project");
  fs.mkdirSync(data);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, DATABASE_URL: dbUrl, MASON_API_KEY: KEY, MASON_DATA: data, MASON_PROJECT: project,
    MASON_NAME: "served", MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1", MASON_PG_PORT: String(pgPort) };

  const first = startServe(env);
  try {
    const up = await healthUntil(health, first, (status) => status === 200);
    assert.deepEqual(up.tables, { total: 0, copied: 0, copying: 0, waiting: 0, failed: 0 });
    assert.match(first.out(), /^mason serve: served, the project in .*project, the state in .*data\/\.mason$/m);
    assert.match(first.out(), /mason start: ready/);
    assert.match(first.out(), /\[sync\]|\[duckdb\]/, "the run's log is on stdout");
    assert.doesNotMatch(first.out(), new RegExp(KEY), "the API key is never printed");

    // beside it, in its data folder, as `docker compose exec mason mason add …`
    const add = spawnSync(process.execPath, [MAIN, "add", "public.items"], { cwd: data, env, encoding: "utf8" });
    assert.equal(add.status, 0, `mason add:\n${add.stdout}${add.stderr}`);
    const written = fs.readdirSync(path.join(project, "sources"));
    assert.deepEqual(written, [`${tag}.yml`], "the sources file written into MASON_PROJECT, named for the database");
    assert.match(fs.readFileSync(path.join(project, "sources", written[0]!), "utf8"), /^tables:\n {2}items: \{\}$/m, "the table added to it");
    const copied = await healthUntil(health, first, (_s, b) => (b.tables as { copied: number }).copied === 1);
    assert.deepEqual(copied.tables, { total: 1, copied: 1, copying: 0, waiting: 0, failed: 0 });

    // the Postgres API, with a token minted from MASON_API_KEY, over the database the name names
    const token = mintToken(KEY, 600).token;
    const count = psql(`postgresql://anyone:${token}@127.0.0.1:${pgPort}/served`, "SELECT count(*) FROM public.items");
    assert.equal(count, "500");
  } finally {
    first.child.kill("SIGTERM");
  }
  const stopped = await first.exited;
  assert.deepEqual(stopped, { code: 0, signal: null }, first.out());
  assert.match(first.out(), /closed the synced data \(it stays in /);
  const cfg = JSON.parse(fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8")) as { running: unknown; served: boolean; lastStop: { at: string; how: string } };
  assert.equal(cfg.running, null, "the run recorded stopped");
  assert.equal(cfg.lastStop.how, "stopped by mason stop, or a shutdown (SIGTERM)", "and how, for mason status");
  assert.ok(Date.now() - Date.parse(cfg.lastStop.at) < 60_000);
  assert.ok(fs.existsSync(path.join(data, ".mason", "duck.db")), "the copy kept on the volume");
  await assert.rejects(fetch(`http://127.0.0.1:${health}/healthz`), "the health endpoint closed with it");

  // a restart (a new container over the same volume): the copy resumed, never copied again
  const second = startServe(env);
  try {
    const again = await healthUntil(health, second, (status, b) => status === 200 && (b.tables as { copied: number }).copied === 1);
    assert.deepEqual(again.tables, { total: 1, copied: 1, copying: 0, waiting: 0, failed: 0 });
    assert.match(second.out(), /the copy in .*\.mason, resumed/);
    assert.doesNotMatch(second.out(), /copied public\.items/, "the copy was kept, not made again");
  } finally {
    second.child.kill("SIGTERM");
  }
  assert.deepEqual(await second.exited, { code: 0, signal: null }, second.out());
});
