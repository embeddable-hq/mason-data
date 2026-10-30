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
import * as net from "node:net";
import * as tls from "node:tls";
import pg from "pg";
import { ApiError } from "../../src/api/error.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer, type ShareDoor, type ShareSocket } from "../../src/api/postgres/server.ts";
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

// SHOW ALL's rows are read by the reader SHOW <name> reads (server.ts sessionSetting): the TLS parameters first
test("SHOW ALL's ssl rows say what the session is, as SHOW ssl does: on with the listener's TLS over TLS, off plain", async () => {
  const settings = async (c: pg.Client): Promise<Map<string, string>> =>
    new Map((await c.query<{ name: string; setting: string }>("SHOW ALL")).rows.map((r) => [r.name, r.setting]));
  const s = client(secure, { rejectUnauthorized: false });
  await s.connect();
  try {
    const all = await settings(s);
    assert.equal(all.get("ssl"), "on");
    assert.equal(all.get("ssl_library"), "OpenSSL");
    assert.equal(all.get("ssl_min_protocol_version"), tls.DEFAULT_MIN_VERSION);
    assert.equal(all.get("ssl_ciphers"), tls.DEFAULT_CIPHERS);
    assert.equal(all.get("ssl_cert_file"), "server.crt", "the rest is the catalog's");
    for (const name of ["ssl", "ssl_library", "ssl_ciphers", "ssl_groups", "ssl_cert_file"]) assert.equal(all.get(name), await one(s, `SHOW ${name}`), `${name}: SHOW ALL's row is SHOW's`);
  } finally { await s.end(); }

  const p = client(plain, false);
  await p.connect();
  try {
    const all = await settings(p);
    assert.equal(all.get("ssl"), "off");
    for (const name of ["ssl", "ssl_library", "ssl_ciphers"]) assert.equal(all.get(name), await one(p, `SHOW ${name}`), `${name}: SHOW ALL's row is SHOW's`);
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

// ---------------------------------------------------------------------------------------------------------------------
// ONE SERVER, TWO SOCKETS (mason share): TLS required of the share's socket alone, a property of the socket carried into
// the session, on a plain server. Real listeners, real clients.

const SHARE_PASSWORD = "the-share-password";
/** a share's login: its own password alone, nothing the run's listener takes */
const shareDoor = (o: Partial<ShareDoor> = {}): ShareDoor => ({
  tls: { cert: Buffer.from(pair.cert), key: Buffer.from(pair.key) },
  authenticate: (p, user) => {
    if (p !== SHARE_PASSWORD) { const e = new ApiError(401, "not this share's password", "invalid_share"); e.userName = user; throw e; }
    return { user: "share_a", jti: "share_a" };
  },
  recheck: async () => undefined,
  loginHint: "the password mason share printed",
  ...o,
});

const shareClient = (port: number, ssl: pg.ClientConfig["ssl"], o: { password?: string; user?: string; database?: string } = {}): pg.Client =>
  new pg.Client({ host: "127.0.0.1", port, user: o.user ?? "share_a", password: o.password ?? SHARE_PASSWORD, database: o.database ?? "shop", ssl, connectionTimeoutMillis: 10_000 });

/** the first message of a raw plain connection's answer, once `bytes` are sent */
const firstAnswer = (port: number, bytes: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1");
  const got: Buffer[] = [];
  c.on("connect", () => c.write(bytes));
  c.on("data", (b: Buffer) => got.push(b));
  c.on("error", reject);
  c.on("close", () => resolve(Buffer.concat(got)));
});

/** one server with the two sockets, closed whatever the test did */
async function withShare(t: { after: (f: () => Promise<void>) => void }, o: Partial<ShareDoor> = {}, server: Partial<PgApiOptions> = {}): Promise<{ api: PgApiServer; share: ShareSocket }> {
  const api = await startPostgresApi({ ...options({ tls: null }), ...server });
  t.after(() => api.close());
  return { api, share: await api.openShare(shareDoor(o)) };
}

test("a share's socket requires TLS on a plain server: a plain startup refused there alone, SSLRequest and a direct start TLS, SHOW ssl each session's own, and the socket closed takes no plain session with it", async (t) => {
  const { api, share } = await withShare(t);
  assert.notEqual(share.port, api.port);

  // the same plain startup: answered on the plain socket, refused 28000 on the share's
  const plainOnPlain = shareClient(api.port, false, { user: "anyone", password: "good-token" });
  await plainOnPlain.connect();
  assert.equal(await one(plainOnPlain, "SHOW ssl"), "off");
  const refused = replies(await firstAnswer(share.port, startup({ user: "share_a", database: "shop" })));
  const error = refused.find((m) => m.type === "ErrorResponse");
  assert.ok(error?.type === "ErrorResponse");
  assert.equal(error.fields.C, "28000");
  assert.match(error.fields.M ?? "", /this server requires TLS/);
  // a driver that does not ask for TLS is refused too, and the password never left it
  const plainDriver = shareClient(share.port, false);
  await assert.rejects(plainDriver.connect(), (e: pg.DatabaseError) => e.code === "28000");

  // SSLRequest: a driver's default negotiation, in the same process as the plain session
  const negotiated = shareClient(share.port, { rejectUnauthorized: false });
  await negotiated.connect();
  assert.equal(await one(negotiated, "SHOW ssl"), "on");
  assert.equal(await one(plainOnPlain, "SHOW ssl"), "off", "the plain session beside it is still plain");
  assert.equal(share.sessions, 1);

  // a direct TLS start is TLS at once
  const direct = tls.connect({ host: "127.0.0.1", port: share.port, rejectUnauthorized: false, ALPNProtocols: ["postgresql"] });
  await new Promise<void>((resolve, reject) => { direct.once("secureConnect", resolve); direct.once("error", reject); });
  const answer = replies(await new Promise<Buffer>((resolve, reject) => {
    const got: Buffer[] = [];
    direct.on("data", (b: Buffer) => got.push(b));
    direct.on("error", reject);
    direct.on("close", () => resolve(Buffer.concat(got)));
    direct.write(Buffer.concat([startup({ user: "share_a", database: "shop" }), password(SHARE_PASSWORD), query("SHOW ssl"), terminate()]));
  }));
  const row = answer.find((m) => m.type === "DataRow");
  assert.ok(row?.type === "DataRow");
  assert.equal(row.values[0]?.toString(), "on");

  // closed: its session ended and its port gone; the plain session goes on, on the same server
  const gone = new Promise<void>((resolve) => { negotiated.once("error", () => resolve()); negotiated.once("end", () => resolve()); });
  await share.close();
  await gone;
  await assert.rejects(new Promise((resolve, reject) => { const c = net.connect(share.port, "127.0.0.1"); c.once("connect", () => { c.destroy(); resolve(null); }); c.once("error", reject); }), /ECONNREFUSED/);
  assert.equal(await one(plainOnPlain, "SELECT 1"), "1");
  await plainOnPlain.end();
});

test("only the share's own login opens its socket, and that login opens nothing else: a token is refused there, the share's password on the run's listener, each 28P01 with its door's hint, recorded and counted", async (t) => {
  const records: Array<{ user?: string; role?: string; sqlstate?: string; method: string }> = [];
  const refusedUsers: string[] = [];
  const { api, share } = await withShare(t, { refused: (u) => { refusedUsers.push(u); return true; } }, { record: (r) => { records.push(r as (typeof records)[number]); } });

  const token = shareClient(share.port, { rejectUnauthorized: false }, { user: "anyone", password: "good-token" });
  await assert.rejects(token.connect(), (e: pg.DatabaseError) => e.code === "28P01" && e.hint === "the password mason share printed");
  assert.deepEqual(refusedUsers, ["anyone"], "a refused login is told to the door, with the user the packet named");
  assert.ok(records.some((r) => r.method === "CONNECT" && r.sqlstate === "28P01" && r.user === "anyone"), "and is a row of the request log, as a plain socket's");

  const onPlain = shareClient(api.port, false, { user: "share_a" });
  await assert.rejects(onPlain.connect(), (e: pg.DatabaseError) => e.code === "28P01" && /mason user add/.test(e.hint ?? ""));

  const good = shareClient(share.port, { rejectUnauthorized: false });
  await good.connect();
  // one server, not two: its refused statement is a row like a plain session's, attributed to the share's login
  await assert.rejects(good.query("SELECT 1 FROM"), (e: pg.DatabaseError) => e.code === "42601");
  await good.end();
  assert.ok(records.some((r) => r.method !== "CONNECT" && r.sqlstate === "42601" && r.user === "share_a"), JSON.stringify(records));
});

test("a connection held open without logging in cannot starve a login: the oldest makes way for a newer one, and one alone is dropped at the deadline", async (t) => {
  const dropped: string[] = [];
  const limit = 4;
  const { share } = await withShare(t, { pendingLimit: limit, pendingMs: 400, dropped: (why) => dropped.push(why) });
  // more than the limit, each past the TLS start or at it, none sending a password
  const held = await Promise.all(Array.from({ length: limit + 3 }, async (_, i) => {
    const c = net.connect(share.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { c.once("connect", resolve); c.once("error", reject); });
    c.on("error", () => undefined);   // dropped by the server: the point of the test
    c.resume();
    if (i % 2 === 0) c.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));   // an SSLRequest, and then silence
    return c;
  }));
  // the tool logs in at once, past them all
  const tool = shareClient(share.port, { rejectUnauthorized: false });
  await tool.connect();
  assert.equal(await one(tool, "SELECT 1"), "1");
  await tool.end();
  assert.ok(dropped.includes("made way for a newer connection"), dropped.join(", "));
  // and whatever was left is gone at the deadline, so an idle holder costs nothing past it
  const closed = held.map((c) => c.destroyed ? Promise.resolve() : new Promise<void>((resolve) => c.once("close", () => resolve())));
  let deadline: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(closed), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("a connection outlived the login deadline")), 10_000); })]).finally(() => clearTimeout(deadline));
  assert.ok(dropped.includes("did not log in in time"), dropped.join(", "));
});

test("a public socket says nothing of the project before a login: a wrong database and the right one answer alike until the password is good", async (t) => {
  const { api, share } = await withShare(t);
  const told = (database: string, password: string): Promise<pg.DatabaseError> => shareClient(share.port, { rejectUnauthorized: false }, { database, password }).connect()
    .then(() => { throw new Error("it connected"); }, (e: pg.DatabaseError) => e);
  // Without the password, nothing tells the name from a guess
  const guessed = await told("guess", "wrong"), right = await told("shop", "wrong");
  assert.equal(guessed.code, "28P01");
  assert.equal(guessed.message, right.message);
  assert.equal(guessed.hint, right.hint);
  // With it, the holder is told: the report that gave them the password names the database
  const holder = await told("guess", SHARE_PASSWORD);
  assert.equal(holder.code, "3D000");
  assert.match(holder.message, /^database "guess" does not exist$/);
  assert.match(holder.hint ?? "", /connect with database=shop/);
  // the plain socket says it at once, to a developer on this machine
  const local = shareClient(api.port, false, { user: "anyone", password: "wrong", database: "guess" });
  await assert.rejects(local.connect(), (e: pg.DatabaseError) => e.code === "3D000" && /shop/.test(e.hint ?? ""));
});

test("what a stranger can write to the request log through a public socket is bounded: a name's length, and no row when the door says none", async (t) => {
  const records: Array<{ user?: string; client?: string; error?: string; method: string }> = [];
  let free = true;
  const { share } = await withShare(t, { refused: () => free }, { record: (r) => { records.push(r as (typeof records)[number]); } });
  const long = "x".repeat(4_000);
  const c = new pg.Client({ host: "127.0.0.1", port: share.port, user: long, password: "wrong", database: "shop", application_name: long, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5_000 });
  await assert.rejects(c.connect(), (e: pg.DatabaseError) => e.code === "28P01" && e.message.length < 150);
  const row = records.find((r) => r.method === "CONNECT")!;
  assert.equal(row.user, "x".repeat(63));
  assert.equal(row.client, `postgres:${"x".repeat(63)}`);
  assert.ok(row.error!.length < 150, row.error);
  records.length = 0;
  free = false;
  await assert.rejects(shareClient(share.port, { rejectUnauthorized: false }, { password: "wrong" }).connect(), (e: pg.DatabaseError) => e.code === "28P01");
  assert.deepEqual(records, [], "refused, and no row");
});

test("a connection reset in the middle of its TLS handshake ends that session alone", async (t) => {
  const { share } = await withShare(t);
  const c = net.connect(share.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { c.once("connect", resolve); c.once("error", reject); });
  c.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
  await new Promise<void>((resolve) => c.once("data", () => resolve()));
  c.resetAndDestroy();
  await new Promise((r) => setTimeout(r, 100));
  const tool = shareClient(share.port, { rejectUnauthorized: false });
  await tool.connect();
  assert.equal(await one(tool, "SELECT 1"), "1");
  await tool.end();
});

test("endSessions ends one login's sessions at once and leaves another's", async (t) => {
  const { share } = await withShare(t, {
    authenticate: (p, user) => { if (p !== SHARE_PASSWORD) throw new ApiError(401, "no", "invalid_share"); return { user, jti: user }; },
  });
  const a = shareClient(share.port, { rejectUnauthorized: false }, { user: "share_a" });
  const b = shareClient(share.port, { rejectUnauthorized: false }, { user: "share_b" });
  await a.connect(); await b.connect();
  const ended = new Promise<void>((resolve) => { a.once("error", () => resolve()); a.once("end", () => resolve()); });
  assert.equal(share.endSessions("share_a", "the share ended"), 1);
  await ended;
  assert.equal(await one(b, "SELECT 1"), "1");
  assert.equal(share.sessions, 1);
  await b.end();
});
