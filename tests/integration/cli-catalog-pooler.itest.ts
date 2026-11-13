/**
 * A CATALOG READ BEHIND A POOLER (the review of PR 900 at 0d5a63fc, B1). A pooler or proxy (PgBouncer, Supavisor, Neon's
 * proxy) answers the startup with a session id of its own in BackendKeyData (the 'K' message), not the backend's. The
 * run told a slow catalog read from a silent one by asking `pg_stat_activity` about that id: it found no row, judged the
 * session gone, and ended every read that sent nothing for 15 s. A large catalog's read (its one `json_agg` sends
 * nothing until it ends) never finished, so `mason add` failed every time, and each read it gave up on left its query
 * running on the source.
 *
 * Here a proxy rewrites the id in 'K' (and maps a CancelRequest back, as a pooler does), and the catalog read is made
 * slow on the server: a table, made after the run is up, whose row security calls a function that sleeps, so counting
 * its rows (it was never analysed) keeps the read's session working, and silent, for 25 s. `mason add` must succeed,
 * and no catalog query may be left running on the source after it.
 *
 * What it needs: IT_POSTGRES_URL as a superuser (it makes a role, dropped at the end), psql on PATH, and DuckDB's
 * postgres extension. It writes only inside a database it creates, `it_pooler_<random>`, and drops it at the end.
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
const tag = `it_pooler_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const role = `${tag}_reader`;
const password = `pw_${Math.floor(Math.random() * 1e9)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-pooler-")));
const root = path.join(dir, "app"), home = path.join(dir, "home");
/** how long the read's session works, silently, on the slow table */
const SLOW_S = 25;

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

/**
 * A proxy as a pooler is to the session id: every BackendKeyData passing to the client carries an id of the proxy's
 * own (never a backend's), and a CancelRequest carrying that id is passed on with the backend's real key. Everything
 * else is passed through as it is (`sslmode=disable`).
 */
function rewritingProxy(to: { host: string; port: number }): Promise<{ port: number; close: () => void; cancels: () => number }> {
  const keys = new Map<number, Buffer>();
  let next = 2_000_000_000, cancels = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    let upstream: net.Socket | null = null;
    const end = (): void => { client.destroy(); upstream?.destroy(); sockets.delete(client); if (upstream) sockets.delete(upstream); };
    client.on("error", end).on("close", end);
    client.once("data", (head: Buffer) => {
      // a CancelRequest (length 16, code 80877102): the proxy's id mapped back to the backend's key
      if (head.length >= 16 && head.readInt32BE(0) === 16 && head.readInt32BE(4) === 80877102) {
        const real = keys.get(head.readInt32BE(8));
        client.end();
        if (real === undefined) return;
        cancels++;
        const c = net.connect(to.port, to.host, () => { const b = Buffer.alloc(16); b.writeInt32BE(16, 0); b.writeInt32BE(80877102, 4); real.copy(b, 8); c.end(b); });
        c.on("error", () => c.destroy());
        return;
      }
      upstream = net.connect(to.port, to.host);
      sockets.add(upstream);
      upstream.on("error", end).on("close", end);
      upstream.write(head);
      client.on("data", (d: Buffer) => upstream!.write(d));
      // the server's messages, read whole until the first ReadyForQuery, so 'K' is rewritten wherever chunks split it
      let pending = Buffer.alloc(0), started = false;
      upstream.on("data", (d: Buffer) => {
        if (started) { client.write(d); return; }
        pending = Buffer.concat([pending, d]);
        const out: Buffer[] = [];
        while (pending.length >= 5 && pending.length >= 1 + pending.readInt32BE(1)) {
          const len = 1 + pending.readInt32BE(1);
          const m = Buffer.from(pending.subarray(0, len));
          pending = pending.subarray(len);
          if (m[0] === 0x4b && len === 13) {
            const id = next++;
            keys.set(id, Buffer.from(m.subarray(5, 13)));
            m.writeInt32BE(id, 5);
          }
          out.push(m);
          if (m[0] === 0x5a) { started = true; out.push(pending); pending = Buffer.alloc(0); break; }
        }
        if (out.length) client.write(Buffer.concat(out));
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, cancels: () => cancels,
      close: () => { for (const s of sockets) s.destroy(); server.close(); } }));
  });
}

let env: Record<string, string> = {};
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
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
  if (adminUrl) {
    psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
    psql(adminUrl, `DROP ROLE IF EXISTS ${role}`);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** the catalog queries of the run still running on the source: its count of an unanalysed table, here */
const catalogQueriesRunning = (): number => Number(psql(adminUrl!,
  `SELECT count(*) FROM pg_stat_activity WHERE usename = '${role}' AND state = 'active' AND query ILIKE '%count(*)%slow_rls%'`));

test("behind a pooler that rewrites the session id, a catalog read the database works on for 25 s, silently, finishes: mason add succeeds, and leaves no query running", {
  skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 600_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(adminUrl!, `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  psql(dbUrl, `CREATE TABLE customers (id int PRIMARY KEY, name text); INSERT INTO customers SELECT g, 'c' || g FROM generate_series(1, 50) g; ` +
    `GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON customers TO ${role}`);
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const target = new URL(dbUrl);
  const p = await rewritingProxy({ host: target.hostname, port: Number(target.port || 5432) });
  closeProxy = p.close;
  const viaProxy = new URL(dbUrl);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(p.port);
  viaProxy.username = role;
  viaProxy.password = password;
  viaProxy.searchParams.set("sslmode", "disable");
  env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()), DATABASE_URL: viaProxy.toString() };

  ok(await mason("init", "--json"), "mason init");
  ok(await mason("add", "customers", "--json"), "mason add customers");
  ok(await mason("start"), "mason start");
  ok(await mason("wait", "--timeout", "120", "--json"), "mason wait");

  // made after the start, so the run's next catalog read is the first to count its rows (never analysed): its row
  // security calls a function that sleeps, so the read's session works on it, sending nothing, for SLOW_S seconds
  psql(dbUrl, `CREATE FUNCTION it_slow() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${SLOW_S}); RETURN true; END $$; ` +
    `CREATE TABLE slow_rls (id int PRIMARY KEY); INSERT INTO slow_rls VALUES (1); ALTER TABLE slow_rls ENABLE ROW LEVEL SECURITY; ` +
    `CREATE POLICY it_slow_read ON slow_rls FOR SELECT USING ((SELECT it_slow())); GRANT SELECT ON slow_rls TO ${role}; ` +
    "CREATE TABLE orders (id int PRIMARY KEY, total numeric(10,2))");
  psql(dbUrl, `GRANT SELECT ON orders TO ${role}`);
  const began = Date.now();
  const added = await mason("add", "orders", "--json");
  assert.equal(added.status, 0, `mason add behind a pooler, its read slow on the server (${Date.now() - began} ms):\n${added.stdout}${added.stderr}`);
  assert.ok(Date.now() - began >= (SLOW_S - 2) * 1000, `the read waited for the database's work (${Date.now() - began} ms)`);
  assert.equal(catalogQueriesRunning(), 0, "no catalog query left running on the source");
  const shown = ok(await mason("status", "--json"), "mason status");
  assert.ok((shown.json.tables as Array<{ table: string; added: boolean }>).some((t) => t.table === "public.orders" && t.added), JSON.stringify(shown.json.tables));
});
