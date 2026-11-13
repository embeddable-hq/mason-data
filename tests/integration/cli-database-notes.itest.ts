/**
 * A DATABASE ON ANOTHER MACHINE, AND THE MAIN DATABASE, ARE INFORMATION (issue 888), against a real Postgres reached
 * through a proxy on this machine's own network address, so that to Mason the database is on another machine.
 *
 * `mason init` used to stop for such a database until it was given `--remote`, and `mason start` warned at every run that
 * it was a PRIMARY. Here: `mason init` writes the project on the first try and says both as information in `--json`'s
 * `notes`, never its `warnings`; the first `mason start` says both as plain lines, never as a warning; `mason status`
 * warns of neither, and its Database line ends "your main database"; the next start, its first sync done, still says
 * where the database is, but no longer that it is the main one.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, DuckDB's postgres extension, and a non-loopback IPv4
 * address on this machine (skipped without one). It writes only inside a database it creates, `it_notes_<random>`, and
 * drops it at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_notes_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-notes-")));
const root = path.join(dir, "app"), home = path.join(dir, "home");
/** this machine's own network address: a database reached there is "on another machine" to Mason */
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address ?? null;

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
/** A TCP proxy to the Postgres at `to`, listening on `host`. */
function proxy(host: string, to: { host: string; port: number }): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(to.port, to.host);
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const end = (): void => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, host, () => resolve({ port: (server.address() as net.AddressInfo).port,
      close: () => { for (const s of sockets) s.destroy(); server.close(); } }));
  });
}

let env: Record<string, string> = {};
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
/** a command, run WITHOUT blocking this process: the proxy is served by this event loop */
async function mason(...args: string[]): Promise<Ran> {
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
  child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
  const killer = setTimeout(() => child.kill("SIGKILL"), 300_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(killer);
  let json: Record<string, unknown> = {};
  if (args.includes("--json")) {
    try { json = JSON.parse(stdout) as Record<string, unknown>; } catch { throw new Error(`mason ${args.join(" ")}: not JSON (exit ${status}):\n${stdout}${stderr}`); }
  }
  return { status, stdout, stderr, json };
}
const ok = (r: Ran, what: string): Ran => { assert.equal(r.status, 0, `${what}:\n${r.stdout}${r.stderr}`); return r; };

let closeProxy = (): void => undefined;
after(() => {
  if (fs.existsSync(path.join(root, ".mason"))) {
    const s = spawnSync(process.execPath, [MAIN, "stop"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    if (s.status !== 0) console.error(`mason stop at the end: ${s.stdout}${s.stderr}`);
  }
  closeProxy();
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

const REMOTE = "Your database is on another machine. Mason will sync the tables you choose to this machine.";
const PRIMARY = "This is your main database, not a read replica. Mason only reads from it and keeps its load small. If you have a read replica, you can point Mason there instead.";

test("a database on another machine: init writes the project the first time, and init and the first start say where it is and that it is the main database as information, never a warning", {
  skip: !adminUrl ? "IT_POSTGRES_URL is not set" : lan === null ? "this machine has no non-loopback IPv4 address" : false, timeout: 600_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE customers (id int PRIMARY KEY, name text); INSERT INTO customers SELECT g, 'c' || g FROM generate_series(1, 50) g");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const target = new URL(dbUrl);
  const p = await proxy(lan!, { host: target.hostname, port: Number(target.port || 5432) });
  closeProxy = p.close;
  const viaProxy = new URL(dbUrl);
  viaProxy.hostname = lan!;
  viaProxy.port = String(p.port);
  // the proxy forwards bytes as they are: the TLS a database elsewhere is read over by default is the server's to offer
  viaProxy.searchParams.set("sslmode", "disable");
  env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()), DATABASE_URL: viaProxy.toString() };

  // INIT: on the first try (it stopped and wanted --remote); both lines are notes, not warnings
  const init = ok(await mason("init", "--json"), "mason init");
  assert.deepEqual([init.json.warnings, init.json.notes], [[], [REMOTE, PRIMARY]], JSON.stringify(init.json));
  assert.ok(fs.existsSync(path.join(root, ".mason", "config.json")), "written on the first try");
  assert.equal("remote" in (JSON.parse(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8")) as object), false, "no remote key");
  ok(await mason("add", "customers", "--json"), "mason add customers");

  // THE FIRST START: it starts (it stopped too), and says both as plain lines
  const started = ok(await mason("start"), "mason start");
  const startLog = started.stdout + started.stderr;
  assert.ok(startLog.includes(`  ${REMOTE}\n`), startLog);
  assert.ok(startLog.includes(`  ${PRIMARY}\n`), `before the first sync, the main database is said:\n${startLog}`);
  assert.doesNotMatch(startLog, /! .*(another machine|not this machine|read replica|PRIMARY)/, "neither is a warning");
  ok(await mason("wait", "--timeout", "120", "--json"), "mason wait");

  // STATUS: no Warning row of either; the Source line says which kind of server it is, as a plain fact (issue 935: Source, not Database)
  const status = ok(await mason("status", "--json"), "mason status --json");
  assert.deepEqual((status.json.warnings as string[]).filter((w) => /another machine|not this machine|read replica|main database|PRIMARY/.test(w)), [],
    JSON.stringify(status.json.warnings));
  const person = ok(await mason("status"), "mason status");
  assert.match(person.stdout, /\n {2}Source +\S+ · Postgres .* · your main database\n/, person.stdout);
  assert.doesNotMatch(person.stdout, /\n {2}(Database|Changes) /, "no Database or Changes row: Source names the database (issue 935)");

  // THE NEXT START, its first sync done: where the database is, still; that it is the main one, no longer
  ok(await mason("stop"), "mason stop");
  const again = ok(await mason("start"), "mason start again");
  const said = again.stdout + again.stderr;
  assert.ok(said.includes(`  ${REMOTE}\n`), said);
  assert.ok(!said.includes(PRIMARY), `said only until the first sync is done:\n${said}`);
});
