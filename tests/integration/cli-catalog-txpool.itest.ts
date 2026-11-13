/**
 * A CATALOG READ LEAVES NOTHING ON A POOLED SERVER CONNECTION (the re-check of PR 900 at 6d60906b). Behind a pooler in
 * transaction mode (PgBouncer's `pool_mode = transaction`, Supabase's default pooler URL), one server connection is
 * handed to one client after another, a transaction at a time, and nothing is reset between them. The catalog read ran
 * a session `SET lock_timeout = 2000`, so the application's next connections were given that limit, and a query of
 * theirs waiting on another session's lock failed after 2 s, for as long as the server connection lived (an hour by
 * default).
 *
 * Here a pooler of the test's own, in transaction mode, with ONE server connection: the first client's login is passed
 * to the server (so it authenticates the connection), every later client is answered at once with that login's
 * parameters, and each client is given the server connection from its first message until the server says it is idle
 * outside a transaction ('Z' with 'I'). (A real PgBouncer is not installed here or on CI; the pooler's one behaviour
 * this needs, a server connection shared in turn with nothing reset, is the whole of this one.) The run's catalog read
 * (`watchedRead`, as src/cli/dev.ts calls it, reading `readSourceFacts`) goes through it, then an application's client:
 * its `lock_timeout` must be the server's own.
 *
 * What it needs: IT_POSTGRES_URL. It writes only inside a database it creates, `it_txpool_<random>`, and drops it.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import { spawnSync } from "node:child_process";
import { connectSource, parseSource, readSourceFacts } from "../../src/cli/preflight.ts";
import { watchedRead } from "../../src/cli/source-catalog.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_txpool_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

/** The messages whole in `buf` (type byte, then a length that counts itself), and what is left over. */
function messages(buf: Buffer): { whole: Buffer[]; rest: Buffer } {
  const whole: Buffer[] = [];
  while (buf.length >= 5 && buf.length >= 1 + buf.readInt32BE(1)) {
    const len = 1 + buf.readInt32BE(1);
    whole.push(buf.subarray(0, len));
    buf = buf.subarray(len);
  }
  return { whole, rest: buf };
}

/** A pooler in transaction mode with one server connection (see the header). */
function transactionPooler(to: { host: string; port: number }): Promise<{ port: number; close: () => void; serverConnections: () => number }> {
  const sockets = new Set<net.Socket>();
  let upstream: net.Socket | null = null, servers = 0;
  // what the server said at the login: ParameterStatus ('S') and BackendKeyData ('K'), replayed to every later client
  const login: Buffer[] = [];
  let loggedIn = false;
  let holder: net.Socket | null = null;
  const waiting: Array<() => void> = [];
  const release = (): void => { holder = null; waiting.shift()?.(); };
  let fromServer: Buffer = Buffer.alloc(0);
  const server = net.createServer((client) => {
    sockets.add(client);
    const end = (): void => { client.destroy(); sockets.delete(client); if (holder === client) release(); };
    client.on("error", end).on("close", end);
    let started = false, pending: Buffer = Buffer.alloc(0), fromClient: Buffer = Buffer.alloc(0);
    /** A client's messages, whole; its Terminate ('X') is the pooler's to take, never the server connection's. */
    const send = (d: Buffer): void => {
      fromClient = Buffer.concat([fromClient, d]);
      const { whole, rest } = messages(fromClient);
      fromClient = rest;
      const kept = whole.filter((m) => m[0] !== 0x58);
      if (kept.length) forward(Buffer.concat(kept));
    };
    const forward = (d: Buffer): void => {
      // a client's messages reach the server connection only while it holds it: taken at its first, kept until the
      // server is idle outside a transaction
      const go = (): void => { holder = client; upstream!.write(d); };
      if (holder === client) upstream!.write(d);
      else if (holder === null) go();
      else waiting.push(() => { if (!client.destroyed) go(); else release(); });
    };
    client.on("data", (d: Buffer) => {
      if (started) { send(d); return; }
      pending = Buffer.concat([pending, d]);
      if (pending.length < 8) return;
      const len = pending.readInt32BE(0);
      if (pending.length < len) return;
      const startup = pending.subarray(0, len);
      const after = pending.subarray(len);
      started = true;
      if (upstream === null) {
        // the first client logs the server connection in, its exchange passed through as it is
        servers++;
        upstream = net.connect(to.port, to.host);
        sockets.add(upstream);
        holder = client;
        upstream.on("error", () => undefined);
        upstream.on("data", (b: Buffer) => {
          fromServer = Buffer.concat([fromServer, b]);
          const { whole, rest } = messages(fromServer);
          fromServer = rest;
          for (const m of whole) {
            if (!loggedIn && (m[0] === 0x53 || m[0] === 0x4b)) login.push(Buffer.from(m));
            holder?.write(m);
            if (m[0] === 0x5a) { loggedIn = true; if (m[5] === 0x49) release(); }
          }
        });
        upstream.write(startup);
        if (after.length) upstream.write(after);
        return;
      }
      // a later client: logged in at once, with the first login's parameters, on the same server connection
      client.write(Buffer.concat([Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]), ...login, Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]));
      if (after.length) send(after);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, serverConnections: () => servers,
      close: () => { for (const s of sockets) s.destroy(); server.close(); } }));
  });
}

let closePooler = (): void => undefined;
after(() => {
  closePooler();
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

test("behind a pooler in transaction mode, the catalog read leaves no setting on the server connection: the next client has the server's own lock_timeout", {
  skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 120_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE customers (id int PRIMARY KEY, name text)");
  const serverDefault = psql(dbUrl, "SHOW lock_timeout");
  const target = new URL(dbUrl);
  const pooler = await transactionPooler({ host: target.hostname, port: Number(target.port || 5432) });
  closePooler = pooler.close;
  const viaPooler = new URL(dbUrl);
  viaPooler.hostname = "127.0.0.1";
  viaPooler.port = String(pooler.port);
  viaPooler.searchParams.set("sslmode", "disable");
  const parsed = parseSource(viaPooler.toString());
  assert.ok("source" in parsed);
  const connect = async () => { const c = await connectSource(parsed.source); if ("failure" in c) throw new Error(c.failure.message); return c.pg; };

  // the run's catalog read, as src/cli/dev.ts makes it
  const facts = await watchedRead({ connect, read: (pg) => readSourceFacts(pg, undefined, { collations: false }), signal: new AbortController().signal, log: () => undefined });
  assert.ok(facts.tables.some((t) => t.source === "public.customers"), "the read read the catalog");

  // the application's next clients, given the same server connection
  for (let i = 0; i < 2; i++) {
    const app = await connect();
    try {
      const seen = (await app.query("SELECT current_setting('lock_timeout'), pg_backend_pid()")).rows[0]!;
      assert.equal(seen[0], serverDefault, `client ${i + 1} after the read: lock_timeout ${seen[0]}, the server's is ${serverDefault}`);
    } finally { app.close(); }
  }
  assert.equal(pooler.serverConnections(), 1, "every client was given the one server connection");
});
