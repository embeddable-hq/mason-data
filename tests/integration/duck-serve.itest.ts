/**
 * `mason serve` AGAINST A REAL POSTGRES (src/cli/serve.ts): the server's whole life as a platform sees it. Started with
 * its settings in the environment and nothing else, /healthz turns 200 once it answers; a table added beside it with
 * `mason add` (as `docker compose exec mason mason add …` does) is copied and counted; the Postgres API answers a token
 * minted from MASON_API_KEY; GET /metrics says the run's numbers and no name; SIGTERM stops it with exit 0, the run recorded stopped and the copy kept; a second serve
 * over the same data folder resumes that copy instead of copying again, and serves its web page through `mason ui --ssh`.
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
    assert.match(first.out(), /^ {2}database {2}mason, what a tool connects with$/m, "MASON_NAME is the project's, never the database's");
    assert.match(first.out(), /mason start: ready/);
    assert.match(first.out(), /\[sync\]|\[engine\]/, "the run's log is on stdout");
    assert.doesNotMatch(first.out(), new RegExp(KEY), "the API key is never printed");

    // beside it, in its data folder, as `docker compose exec mason mason add …`
    const add = spawnSync(process.execPath, [MAIN, "add", "public.items"], { cwd: data, env, encoding: "utf8" });
    assert.equal(add.status, 0, `mason add:\n${add.stdout}${add.stderr}`);
    const written = fs.readdirSync(path.join(project, "sources"));
    assert.deepEqual(written, [`${tag}.yml`], "the sources file written into MASON_PROJECT, named for the database");
    assert.match(fs.readFileSync(path.join(project, "sources", written[0]!), "utf8"), /^tables:\n {2}items: \{\}$/m, "the table added to it");
    const copied = await healthUntil(health, first, (_s, b) => (b.tables as { copied: number }).copied === 1);
    assert.deepEqual(copied.tables, { total: 1, copied: 1, copying: 0, waiting: 0, failed: 0 });

    // the Postgres API, with a token minted from MASON_API_KEY, over the database a tool connects with
    const token = mintToken(KEY, 600).token;
    const count = psql(`postgresql://anyone:${token}@127.0.0.1:${pgPort}/mason`, "SELECT count(*) FROM public.items");
    assert.equal(count, "500");

    // GET /metrics beside /healthz, once it serves: the run's numbers (src/cli/run-server.ts metricsFacts through the
    // run's serve hook), the statement just answered counted, and no name of the database in it (it takes no credential)
    const scrape = await fetch(`http://127.0.0.1:${health}/metrics`);
    assert.deepEqual([scrape.status, scrape.headers.get("content-type")], [200, "text/plain; version=0.0.4; charset=utf-8"]);
    const metrics = await scrape.text();
    assert.match(metrics, /^mason_ready 1$/m);
    assert.match(metrics, /^mason_tables\{phase="copied"\} 1$/m);
    assert.match(metrics, /^mason_copy_rows 500$/m);
    assert.match(metrics, /^mason_copy_bytes \d+$/m);
    assert.match(metrics, /^mason_disk_free_bytes \d+$/m);
    assert.ok(Number(/^mason_statements_total\{outcome="completed"\} (\d+)$/m.exec(metrics)?.[1]) >= 1, `the count(*) is counted:\n${metrics}`);
    assert.doesNotMatch(metrics, /^mason_stream_lag/m, "polled: no stream, so no lag (absent, never 0)");
    assert.doesNotMatch(metrics, new RegExp(`items|${tag}|anyone|count\\(`), "never a table, a database, a user or a statement");
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
  const uiPort = await freePort();
  const second = startServe({ ...env, MASON_UI_PORT: String(uiPort) });
  try {
    const again = await healthUntil(health, second, (status, b) => status === 200 && (b.tables as { copied: number }).copied === 1);
    assert.deepEqual(again.tables, { total: 1, copied: 1, copying: 0, waiting: 0, failed: 0 });
    assert.match(second.out(), /the synced data in .*\.mason, resumed/);
    assert.doesNotMatch(second.out(), /synced public\.items/, "the copy was kept, not made again");

    // ITS WEB PAGE, as a developer's machine opens it (src/cli/ui-ssh.ts): over a fake ssh that runs the remote command
    // here, so real ssh is not exercised; the run, its bridge and its page are real
    const config = JSON.parse(fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8")) as { running: { token: string; controlUrl: string } };
    assert.equal(config.running.controlUrl, `http://127.0.0.1:${uiPort}`, "MASON_UI_PORT is the port");
    const onServer = spawnSync(process.execPath, [MAIN, "ui", "--json"], { cwd: data, env, encoding: "utf8" });
    assert.equal(onServer.status, 1, "mason ui on the server names mason ui --ssh");
    assert.match(onServer.stdout, /mason ui --ssh <user@server>/);
    const status = spawnSync(process.execPath, [MAIN, "status"], { cwd: data, env, encoding: "utf8" });
    assert.match(status.stdout, /Web UI +from your machine: mason ui --ssh <user@server>/);

    const bin = path.join(dir, "fake-ssh-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\nexec sh -c "$1"\n', { mode: 0o755 });
    const laptop = spawn(process.execPath, [MAIN, "ui", "--ssh", "deploy@server", "--mason", `cd '${data}' && '${process.execPath}' '${MAIN}'`, "--json"],
      { cwd: dir, env: { ...env, PATH: `${bin}:${env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    let printed = "", said = "";
    laptop.stderr.on("data", (b) => { said += String(b); });
    const closed = new Promise<number | null>((r) => laptop.once("close", (c) => r(c)));
    const opened = await new Promise<{ url: string; port: number }>((resolve, reject) => {
      laptop.stdout.on("data", (b) => { printed += String(b); try { resolve(JSON.parse(printed) as { url: string; port: number }); } catch { /* not whole yet: the next chunk */ } });
      void closed.then((c) => reject(new Error(`mason ui --ssh ended (${c}): ${printed}${said}`)));
    });
    assert.notEqual(opened.port, uiPort);
    const traded = await fetch(opened.url, { redirect: "manual" });
    assert.equal(traded.status, 303);
    const cookie = traded.headers.get("set-cookie")!.split(";")[0]!;
    const pageAt = `http://127.0.0.1:${opened.port}`;
    assert.match(await (await fetch(`${pageAt}/`, { headers: { Cookie: cookie } })).text(), /<title>/);
    const state = await (await fetch(`${pageAt}/api/state`, { headers: { Cookie: cookie } })).json() as { served: boolean; sourcesReadOnly: string | null; totals: { copied: number } };
    assert.deepEqual([state.served, state.sourcesReadOnly, state.totals.copied], [true, null, 1]);
    // what the page does, through the tunnel: a sync on demand, from its own Origin
    const synced = await fetch(`${pageAt}/api/sync`, { method: "POST", headers: { Cookie: cookie, Origin: pageAt, "Content-Type": "application/json" }, body: JSON.stringify({ tables: ["public.items"] }) });
    assert.equal(synced.status, 200, await synced.clone().text());
    laptop.kill("SIGINT");
    assert.equal(await closed, 0, said);
    for (const seen of [printed, said, second.out()]) assert.ok(!seen.includes(config.running.token), "the run's token is printed nowhere");
    assert.match(second.out(), new RegExp(`a tunnel opened from local port ${opened.port}`));

    // a tunnel left open never holds the run's stop, and the laptop is told
    const left = spawn(process.execPath, [MAIN, "ui", "--ssh", "deploy@server", "--mason", `cd '${data}' && '${process.execPath}' '${MAIN}'`, "--json"],
      { cwd: dir, env: { ...env, PATH: `${bin}:${env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    let leftSaid = "";
    left.stderr.on("data", (b) => { leftSaid += String(b); });
    const leftGone = new Promise<number | null>((r) => left.once("close", (c) => r(c)));
    await new Promise<void>((r) => { left.stdout.once("data", () => r()); });
    second.child.kill("SIGTERM");
    assert.equal(await leftGone, 1, leftSaid);
    assert.match(leftSaid, /the tunnel to deploy@server dropped/);
  } finally {
    second.child.kill("SIGTERM");
  }
  assert.deepEqual(await second.exited, { code: 0, signal: null }, second.out());
});
