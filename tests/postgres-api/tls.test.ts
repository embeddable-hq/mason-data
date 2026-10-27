/**
 * THE POSTGRES API OVER TLS (src/api/postgres/server.ts): what a session says about its TLS — `SHOW ssl` and
 * `current_setting('ssl')` the session's own, never the catalog Postgres's (PGlite serves no TLS and says `off`) —
 * against a real listener with a certificate and a plain one beside it, through a real driver; and how a connection
 * STARTS TLS: SSLRequest, or a TLS ClientHello as its first bytes (Postgres 17's `sslnegotiation=direct`, a generic TLS
 * terminator in front), which a plain listener refuses in its log.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as tls from "node:tls";
import pg from "pg";
import { ApiError } from "../../src/api/error.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../../src/api/postgres/server.ts";
import { selfSignedCertificate } from "../../src/cli/self-signed-cert.ts";
import { password, query, replies, startup, terminate } from "./wire.ts";

const pair = selfSignedCertificate("mason-tls-test");
const logs: string[] = [];
let secure: PgApiServer, plain: PgApiServer;

const NO_TABLE = "this test reads no table";
const options = (o: Pick<PgApiOptions, "tls">): PgApiOptions => ({
  port: 0, host: "127.0.0.1", database: "shop", masonVersion: "test", ...o,
  authenticate: (p) => { if (p === "good-token") return {}; throw new ApiError(401, "invalid token", "invalid_token"); },
  schema: () => ({ database: "shop", tables: [] }),
  record: () => undefined,
  // no table here: every statement is the catalog's or the session's, never DuckDB's
  duck: { open: () => Promise.reject(new Error(NO_TABLE)), plan: () => Promise.reject(new Error(NO_TABLE)), parameters: () => Promise.reject(new Error(NO_TABLE)) },
  log: (line) => logs.push(line),
});

before(async () => {
  secure = await startPostgresApi(options({ tls: { cert: Buffer.from(pair.cert), key: Buffer.from(pair.key) } }));
  plain = await startPostgresApi(options({ tls: null }));
});
after(async () => { await secure.close(); await plain.close(); });

const client = (server: PgApiServer, ssl: pg.ClientConfig["ssl"]): pg.Client =>
  new pg.Client({ host: "127.0.0.1", port: server.port, user: "anyone", password: "good-token", database: "shop", ssl });

/** one value of a one-row answer */
const one = async (c: pg.Client, q: string | pg.QueryConfig): Promise<string> => {
  const r = await c.query(q);
  assert.equal(r.rows.length, 1);
  return String(Object.values(r.rows[0] as Record<string, unknown>)[0]);
};

test("SHOW ssl and current_setting('ssl') say what the session is: on over TLS, off plain — never the catalog Postgres's off", async () => {
  const s = client(secure, { rejectUnauthorized: false });
  await s.connect();
  try {
    assert.ok((s as unknown as { connection: { stream: unknown } }).connection.stream instanceof tls.TLSSocket, "the session is TLS");
    assert.equal(await one(s, "SHOW ssl"), "on");
    assert.equal(await one(s, { text: "SHOW ssl", name: "show-ssl" }), "on", "the extended protocol's Describe and Execute alike");
    assert.equal(await one(s, "SHOW SSL"), "on", "a parameter's name in any case");
    assert.equal(await one(s, "SELECT current_setting('ssl')"), "on");
    assert.equal(await one(s, "SELECT current_setting('SSL', true)"), "on", "missing_ok's form, any case");
    // the parameters a server with ssl on answers, where the listener knows better than a catalog built without TLS
    assert.equal(await one(s, "SHOW ssl_library"), "OpenSSL");
    assert.equal(await one(s, "SHOW ssl_min_protocol_version"), tls.DEFAULT_MIN_VERSION);
    assert.equal(await one(s, "SHOW ssl_ciphers"), tls.DEFAULT_CIPHERS);
    assert.equal(await one(s, "SELECT current_setting('ssl_library')"), "OpenSSL", "one table answers SHOW and current_setting");
    // the rest is the catalog's, as before: a file name means nothing to a client
    assert.equal(await one(s, "SHOW ssl_cert_file"), "server.crt");
    assert.equal(await one(s, "SELECT current_setting('server_version_num')"), "180006", "every other setting is Postgres's own");
    await assert.rejects(s.query("SELECT current_setting('no_such_setting')"), (e: pg.DatabaseError) => e.code === "42704");
    assert.equal(await one(s, "SELECT current_setting('no_such_setting', true) IS NULL"), "true");
  } finally { await s.end(); }

  const p = client(plain, false);
  await p.connect();
  try {
    assert.equal(await one(p, "SHOW ssl"), "off");
    assert.equal(await one(p, "SELECT current_setting('ssl')"), "off");
  } finally { await p.end(); }
});

/** A whole session over `socket` once it is open: startup, password, the statement and Terminate in one write (the
 *  server reads them in order), and every byte it answers until it closes. */
const session = (socket: tls.TLSSocket, sql: string): Promise<Buffer> => new Promise((resolve, reject) => {
  const got: Buffer[] = [];
  socket.on("data", (b: Buffer) => got.push(b));
  socket.on("error", reject);
  socket.on("close", () => resolve(Buffer.concat(got)));
  socket.write(Buffer.concat([startup({ user: "anyone", database: "shop" }), password("good-token"), query(sql), terminate()]));
});

test("a direct TLS start: a connection that opens with a ClientHello is TLS at once (ALPN postgresql), every byte of it handed on; SSLRequest unchanged; a plain listener refuses one in its log", async () => {
  // what sslnegotiation=direct does: TLS from the first byte, ALPN postgresql, the startup packet inside
  const direct = tls.connect({ host: "127.0.0.1", port: secure.port, rejectUnauthorized: false, ALPNProtocols: ["postgresql"] });
  await new Promise<void>((resolve, reject) => { direct.once("secureConnect", resolve); direct.once("error", reject); });
  assert.equal(direct.alpnProtocol, "postgresql", "the server chose ALPN postgresql, as libpq's direct negotiation requires");
  const answer = replies(await session(direct, "SHOW ssl"));
  assert.deepEqual(answer.filter((m) => m.type === "ErrorResponse"), []);
  const row = answer.find((m) => m.type === "DataRow");
  assert.ok(row !== undefined && row.type === "DataRow");
  assert.equal(row.values[0]?.toString(), "on", "the session behind a direct start is a TLS session");

  // a terminator re-encrypting offers no ALPN: taken as well
  const bare = tls.connect({ host: "127.0.0.1", port: secure.port, rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { bare.once("secureConnect", resolve); bare.once("error", reject); });
  assert.ok(replies(await session(bare, "SELECT 1")).some((m) => m.type === "DataRow"));

  // SSLRequest, as a driver negotiates by default, is unchanged
  const negotiated = client(secure, { rejectUnauthorized: false });
  await negotiated.connect();
  try { assert.equal(await one(negotiated, "SHOW ssl"), "on"); } finally { await negotiated.end(); }

  // a plain listener cannot answer a ClientHello on the wire: it closes the connection and says why in its log
  logs.length = 0;
  const refused = tls.connect({ host: "127.0.0.1", port: plain.port, rejectUnauthorized: false, ALPNProtocols: ["postgresql"] });
  await assert.rejects(new Promise((resolve, reject) => { refused.once("secureConnect", resolve); refused.once("error", reject); refused.once("close", () => reject(new Error("closed"))); }));
  refused.destroy();
  assert.ok(logs.some((l) => /refused: a direct TLS start .* on a plain listener — set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY/.test(l)), logs.join("\n"));
  // and the plain listener still serves a plain client
  const p = client(plain, false);
  await p.connect();
  try { assert.equal(await one(p, "SELECT 1"), "1"); } finally { await p.end(); }
});

/** psql's major version on PATH, or null without one */
const psqlMajor = (): Promise<number | null> => new Promise((resolve, reject) => {
  execFile("psql", ["--version"], (err, stdout) => {
    // no psql on PATH is this test's skip, said by its name; any other failure of `psql --version` is a failure
    if (err !== null) { if ((err as NodeJS.ErrnoException).code === "ENOENT") resolve(null); else reject(err); return; }
    const m = /\(PostgreSQL\) (\d+)/.exec(stdout);
    resolve(m === null ? null : Number(m[1]));
  });
});

test("psql 17+ with sslnegotiation=direct connects and is a TLS session (skipped without psql 17 or later on PATH)", async (t) => {
  const major = await psqlMajor();
  if (major === null || major < 17) { t.skip(`psql ${major ?? "not on PATH"}: sslnegotiation=direct is psql 17's`); return; }
  for (const negotiation of ["direct", "postgres"]) {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("psql", [`host=127.0.0.1 port=${secure.port} dbname=shop user=anyone sslmode=require sslnegotiation=${negotiation}`, "-XAtc", "SHOW ssl"],
        { env: { ...process.env, PGPASSWORD: "good-token", PGCONNECT_TIMEOUT: "10" } },
        (err, stdout, stderr) => (err !== null ? reject(new Error(`psql sslnegotiation=${negotiation}: ${err.message} ${stderr}`)) : resolve(stdout)));
    });
    assert.equal(out.trim(), "on", `sslnegotiation=${negotiation}`);
  }
});
