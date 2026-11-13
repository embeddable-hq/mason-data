/**
 * A RUNNING MASON READS THE DATABASE'S CATALOG ONLY WHEN ASKED (issue 890), and says a database on another machine and
 * the main database as information (issue 888), against a real Postgres reached through a proxy here that counts the
 * connections made to it.
 *
 * A run read the catalog on a 10-second timer, a connection every 10 s whatever each table's sync, which kept a
 * serverless compute awake with every table `sync: off`. Here: a run whose tables are all `sync: off`, once its first
 * sync is done and nobody asks, opens NO connection over a window longer than a minute; behind another session's lock
 * the run's state (`mason status`, `mason wait`, the page) still answers at once; and a table made a moment ago is added
 * at once. (How often a read is reused is tests/cli-source-catalog.test.ts's; `mason tables` reads the catalog itself, a
 * connection each time, by design: it needs the project, not the run.)
 *
 * The proxy listens on this machine's first non-loopback address when it has one, so the database is "on another
 * machine" to Mason: `mason init` and the first `mason start` say so as information, never a warning; the next start,
 * its first sync done, no longer says it is the main database; `mason status` warns of neither.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, and DuckDB's postgres extension. It writes only inside a
 * database it creates, `it_catalog_<random>`, and drops it at the end.
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
const tag = `it_catalog_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-catalog-")));
const root = path.join(dir, "app"), home = path.join(dir, "home");
/** the old timer read every 10 s: a window past a minute holds six of its reads, and past the reuse of a read */
const IDLE_MS = 65_000;

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
/** A TCP proxy to the Postgres at `to`, listening on `host`: every connection made through it is counted. */
/** `muteNext()`: the next connection made through it goes silent once logged in (its ReadyForQuery passed): nothing
 *  either way after it, the TCP connection kept — a connection gone silent, as a stalled network or proxy leaves it. */
function countingProxy(host: string, to: { host: string; port: number }): Promise<{ port: number; connections: () => number; close: () => void; muteNext: () => void }> {
  let n = 0, mute = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    n++;
    const upstream = net.connect(to.port, to.host);
    sockets.add(client).add(upstream);
    if (mute) {
      mute = false;
      let silent = false;
      client.on("data", (d: Buffer) => { if (!silent) upstream.write(d); });
      upstream.on("data", (d: Buffer) => {
        if (silent) return;
        client.write(d);
        // ReadyForQuery ('Z', length 5): logged in; from here on nothing passes
        if (d.includes(Buffer.from([0x5a, 0, 0, 0, 5]))) silent = true;
      });
    } else client.pipe(upstream).pipe(client);
    const end = (): void => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, host, () => resolve({ port: (server.address() as net.AddressInfo).port, connections: () => n,
      close: () => { for (const s of sockets) s.destroy(); server.close(); }, muteNext: () => { mute = true; } }));
  });
}

let env: Record<string, string> = {};
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
/** a command, run WITHOUT blocking this process: the proxy that counts its connections is served by this event loop */
async function mason(...args: string[]): Promise<Ran> {
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
  child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
  const killer = setTimeout(() => child.kill("SIGKILL"), 300_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(killer);
  const r = { status, stdout, stderr };
  let json: Record<string, unknown> = {};
  if (args.includes("--json")) {
    try { json = JSON.parse(r.stdout) as Record<string, unknown>; } catch { throw new Error(`mason ${args.join(" ")}: not JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`); }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const ok = (r: Ran, what: string): Ran => { assert.equal(r.status, 0, `${what}:\n${r.stdout}${r.stderr}`); return r; };

let closeProxy = (): void => undefined;
after(() => {
  if (fs.existsSync(path.join(root, ".mason"))) {
    const s = spawnSync(process.execPath, [MAIN, "stop"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    if (s.status !== 0) console.error(`mason stop at the end: ${s.stdout}${s.stderr}`);
  }
  closeProxy();
  // the database first: a folder still being written by a run that ended a moment ago must not leave it behind
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

const REMOTE = "Your database is on another machine. Mason will sync the tables you choose to this machine.";
const PRIMARY = "This is your main database, not a read replica. Mason only reads from it and keeps its load small. If you have a read replica, you can point Mason there instead.";

test("an idle run whose tables are all sync: off opens no connection to the database; a table made since shows once asked, read once a minute at most", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 600_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE customers (id int PRIMARY KEY, name text); INSERT INTO customers SELECT g, 'c' || g FROM generate_series(1, 50) g; " +
    // a table this user reads and nothing adds: what another session's lock is taken on below
    "CREATE TABLE big (id int PRIMARY KEY)");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  // the proxy on this machine's own network address, when it has one: to Mason, a database on another machine
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address ?? null;
  const target = new URL(dbUrl);
  const proxy = await countingProxy(lan ?? "127.0.0.1", { host: target.hostname, port: Number(target.port || 5432) });
  closeProxy = proxy.close;
  const viaProxy = new URL(dbUrl);
  viaProxy.hostname = lan ?? "127.0.0.1";
  viaProxy.port = String(proxy.port);
  // the proxy forwards bytes as they are: the TLS a database elsewhere is read over by default is the server's to offer
  viaProxy.searchParams.set("sslmode", "disable");
  env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()), DATABASE_URL: viaProxy.toString() };

  // INIT: on the first try, whatever machine the database is on; where it is said as information, never a warning
  const init = ok(await mason("init", "--json"), "mason init");
  if (lan !== null) {
    assert.deepEqual([init.json.warnings, init.json.notes], [[], [REMOTE, PRIMARY]], JSON.stringify(init.json));
  }
  assert.ok(fs.existsSync(path.join(root, ".mason", "config.json")), "written on the first try");
  ok(await mason("add", "customers", "--json"), "mason add customers");

  const started = ok(await mason("start"), "mason start");
  const startLog = started.stdout + started.stderr;
  if (lan !== null) {
    assert.ok(startLog.includes(`  ${REMOTE}\n`), startLog);
    assert.ok(startLog.includes(`  ${PRIMARY}\n`), `before the first sync, the main database is said:\n${startLog}`);
    assert.doesNotMatch(startLog, /! .*(another machine|read replica|PRIMARY)/, "neither is a warning");
  }
  ok(await mason("wait", "--timeout", "120", "--json"), "mason wait");
  if (lan !== null) {
    const status = ok(await mason("status", "--json"), "mason status");
    assert.deepEqual((status.json.warnings as string[]).filter((w) => /another machine|read replica|main database/.test(w)), [], "no Warning row of either");
  }

  // IDLE: nobody asks, every table sync: off — no connection at all over a window that held six of the timer's reads
  await new Promise((r) => setTimeout(r, 3_000));   // what the first sync had open is closed by now
  const before = proxy.connections();
  await new Promise((r) => setTimeout(r, IDLE_MS));
  assert.equal(proxy.connections() - before, 0, `an idle run with every table sync: off connected ${proxy.connections() - before} time(s) in ${IDLE_MS / 1000} s`);

  // A LOCK THE READ WAITS ON (the review of PR 900, B1): another session holds ACCESS EXCLUSIVE on a table this user
  // reads, as a migration does; the catalog's last read is over a minute old, so asking begins one, which waits on the
  // lock — and the run still answers at once, with the read before (main answered in under 2 s; the head that waited
  // for the read did not answer within 30 s)
  const holder = spawn("psql", ["-X", "-q", dbUrl, "-c", "BEGIN; LOCK TABLE big IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(120); COMMIT"],
    { env: { ...process.env, PGAPPNAME: `${tag}_lock` }, stdio: "ignore" });
  try {
    for (const end = Date.now() + 30_000; ;) {
      if (psql(adminUrl!, `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${tag}_lock' AND query LIKE '%pg_sleep%' AND state = 'active'`) === "1") break;
      assert.ok(Date.now() < end, "the lock holder never began");
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const cmd of [["status", "--json"], ["wait", "--json"]]) {
      const began = Date.now();
      const r = await mason(...cmd);
      assert.equal(r.status, 0, `mason ${cmd[0]} behind a lock: ${r.stdout}${r.stderr}`);
      assert.ok(Date.now() - began < 15_000, `mason ${cmd[0]} answered in ${Date.now() - began} ms behind a lock`);
    }
    // an add's read waits on the lock a moment, then says so: never an answer from the read before, never "Mason does not
    // answer" (the re-check of PR 900)
    const blocked = await mason("add", "customers", "--columns", "id", "--json");
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    const e = (blocked.json as { error: { code: string; message: string; why?: string } }).error;
    assert.equal(e.code, "failed", JSON.stringify(e));
    assert.match(e.message, new RegExp(`^the tables of ${tag} could not be read just now: .*lock timeout`), JSON.stringify(e));
    assert.match(e.why ?? "", /another session holds a lock/);
  } finally {
    holder.kill();
    psql(adminUrl!, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${tag}_lock'`);
  }

  // A TABLE MADE A MOMENT AGO (the review of PR 900, B2): added at once — an add reads the database as it is now, never
  // the run's read of up to a minute before
  psql(dbUrl, "CREATE TABLE orders (id int PRIMARY KEY, customer_id int, total numeric(10,2))");
  // mason tables reads it itself, Mason up or down: it lists it
  const listed = ok(await mason("tables", "--json"), "mason tables");
  assert.ok((listed.json.tables as Array<{ table: string }>).some((t) => t.table === "public.orders"), JSON.stringify(listed.json.tables));
  ok(await mason("add", "orders", "--json"), "mason add orders, made a moment ago");
  // and the state shows it added, from that read
  const shown = ok(await mason("status", "--json"), "mason status");
  assert.ok((shown.json.tables as Array<{ table: string; added: boolean }>).some((t) => t.table === "public.orders" && t.added), JSON.stringify(shown.json.tables));

  // A CONNECTION GONE SILENT (the re-check of PR 900: one held every add for the quarter of an hour of the last guard):
  // the read's own connection goes silent once logged in; the database, asked on a connection of its own, says its
  // session does nothing for it, and the read ends — the add says so, and the next add reads anew and adds
  psql(dbUrl, "CREATE TABLE silenced (id int PRIMARY KEY)");
  proxy.muteNext();
  const began = Date.now();
  const hushed = await mason("add", "silenced", "--json");
  assert.equal(hushed.status, 1, hushed.stdout + hushed.stderr);
  assert.match((hushed.json as { error: { message: string } }).error.message, /could not be read just now: the database has had nothing to do for it for \d+ s .*the connection went silent/, hushed.stdout);
  assert.ok(Date.now() - began < 120_000, `said in ${Date.now() - began} ms, never after the last guard`);
  ok(await mason("add", "silenced", "--json"), "mason add, the next read answered");

  // THE NEXT START, its first sync done: where the database is, still; that it is the main one, no longer
  ok(await mason("stop"), "mason stop");
  const again = ok(await mason("start"), "mason start again");
  if (lan !== null) {
    const said = again.stdout + again.stderr;
    assert.ok(said.includes(`  ${REMOTE}\n`), said);
    assert.ok(!said.includes(PRIMARY), `said only until the first sync is done:\n${said}`);
  }
});
