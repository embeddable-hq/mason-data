/**
 * THE POSTGRES API BEHIND A TCP PROXY (`MASON_PG_PROXY_FROM`, src/api/postgres/proxy.ts; issue 472): real listeners over
 * a throwaway DuckStore, their request log the ledger `mason start` wires (src/duck/requests.ts), and a fake proxy in
 * front that begins every connection with a PROXY protocol v2 header built from the spec (tests/postgres-api/wire.ts).
 * Through a named proxy the request log, read as `mason logs --requests` reads it, names the client the header carries;
 * a named address that sends no header, or a broken one, is refused; a header from an address the setting does not name
 * is refused, never believed; unset, nothing changes; TLS (SSLRequest and a direct start) and a CancelRequest work
 * behind a header. The header parser itself is tests/postgres-api/proxy.test.ts's.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger, type LedgerRequest } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import { parseProxyFrom, type ProxyFrom } from "../src/api/postgres/proxy.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import { selfSignedCertificate } from "../src/cli/self-signed-cert.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import * as wire from "./postgres-api/wire.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-proxy-wire-"));
const pair = selfSignedCertificate("mason-proxy-test");
const logs: string[] = [];
let store: DuckStore;
let ledger: RequestLedger;
/** MASON_PG_PROXY_FROM names this machine (the fake proxy's address): every connection must begin with a header */
let named: PgApiServer;
/** the same, over TLS */
let namedTls: PgApiServer;
/** MASON_PG_PROXY_FROM names another network: this machine's connections are read as before */
let unnamed: PgApiServer;
/** MASON_PG_PROXY_FROM unset */
let unset: PgApiServer;
const proxies: Array<{ close(): Promise<void> }> = [];

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }] },
    { name: "big", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }] },
  ],
};

const from = (v: string): ProxyFrom => parseProxyFrom(v) as ProxyFrom;

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 'paid'), (2, 'paid'), (3, 'pending')");
  await store.writer.run("CREATE TABLE public.big AS SELECT range::INTEGER AS id FROM range(150000)");
  const real = await store.instance.connect();
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000, insert: async (sql, values) => { await real.run(sql, values); } });
  const options = async (o: Partial<PgApiOptions>): Promise<PgApiOptions> => ({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: (row) => ledger.record(row), log: (line) => logs.push(line),
    duck: await store.listener(undefined), ...o,
  });
  named = await startPostgresApi(await options({ proxyFrom: from("127.0.0.1/32") }));
  namedTls = await startPostgresApi(await options({ proxyFrom: from("127.0.0.0/8, ::1"), tls: { cert: Buffer.from(pair.cert), key: Buffer.from(pair.key) } }));
  unnamed = await startPostgresApi(await options({ proxyFrom: from("192.0.2.0/24") }));
  unset = await startPostgresApi(await options({}));
});
after(async () => {
  for (const p of proxies) await p.close();
  for (const api of [named, namedTls, unnamed, unset]) await api?.close();
  await ledger.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A TCP proxy of the test's own: every connection to it is one to the listener on `target`, begun with `header` (as an
 * NLB or HAProxy with the PROXY protocol v2 sends it), the client's bytes and the listener's piped after it unchanged.
 */
async function fakeProxy(target: number, header: Buffer): Promise<number> {
  const open = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target, "127.0.0.1");
    open.add(client); open.add(upstream);
    upstream.write(header);
    client.pipe(upstream); upstream.pipe(client);
    // one side gone ENDS the other once what it was given has left, as a proxy does: destroying it dropped the
    // listener's last bytes still being piped (issue 585)
    for (const [s, other] of [[client, upstream], [upstream, client]] as const) {
      s.on("error", () => other.end());
      s.on("close", () => { open.delete(s); other.end(); });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxies.push({ close: () => new Promise<void>((resolve) => { for (const s of open) s.destroy(); server.close(() => resolve()); }) });
  return (server.address() as net.AddressInfo).port;
}

const token = (): string => mintToken(API_KEY, 600).token;
const client = (port: number, o: Partial<pg.ClientConfig> = {}): pg.Client =>
  new pg.Client({ host: "127.0.0.1", port, database: "app", user: "mason", password: token(), application_name: "proxied", ...o });

/** the request log as `mason logs --requests --json` reads it, flushed first */
async function requests(): Promise<LedgerRequest[]> {
  await ledger.flush();
  return ledger.recent({ limit: 1000 });
}

/** everything a raw connection is sent until the listener closes it */
async function closedWith(socket: net.Socket, ...writes: Buffer[]): Promise<Buffer> {
  const got: Buffer[] = [];
  const closed = new Promise<Buffer>((resolve) => { socket.on("data", (b: Buffer) => got.push(b)); socket.on("close", () => resolve(Buffer.concat(got))); });
  socket.on("error", () => undefined);   // the listener's reset of a refused connection; the bytes before it are the test's
  for (const w of writes) socket.write(w);
  return closed;
}

const errorOf = (bytes: Buffer): { C?: string; M?: string } | undefined => {
  const m = wire.replies(bytes).find((r) => r.type === "ErrorResponse");
  return m?.type === "ErrorResponse" ? m.fields : undefined;
};

test("through a named proxy the request log names the client its header carries: an answer, a refusal and a refused login, IPv4, IPv6 and v4-mapped", async () => {
  const before = (await requests()).length;
  const port = await fakeProxy(named.port, wire.proxyV2Inet4("203.0.113.7", 51234, "192.0.2.1", named.port));
  const c = client(port);
  await c.connect();
  try {
    assert.equal((await c.query("SELECT id FROM orders WHERE status = 'paid' ORDER BY id")).rows.length, 2);
    await assert.rejects(c.query("SELECT * FROM nope"), /relation "nope" does not exist/);
  } finally { await c.end(); }
  await assert.rejects(client(port, { password: "not-a-token" }).connect(), /password authentication failed/);
  const v6 = await fakeProxy(named.port, wire.proxyV2Inet6("20010db8000000000000000000000007", 443));
  const c6 = client(v6, { application_name: "proxied-v6" });
  await c6.connect();
  try { assert.equal((await c6.query("SELECT count(*) AS n FROM orders")).rows[0].n, "3"); } finally { await c6.end(); }
  const mapped = await fakeProxy(named.port, wire.proxyV2Inet6("00000000000000000000ffffc6336409", 443));
  await assert.rejects(client(mapped, { password: "not-a-token", application_name: "proxied-mapped" }).connect(), /password authentication failed/);
  const rows = (await requests()).slice(before);
  assert.deepEqual(rows.map((r) => [r.method, r.outcome, r.applicationName, r.clientAddress]), [
    ["QUERY", "ok", "proxied", "203.0.113.7"],
    ["QUERY", "refused", "proxied", "203.0.113.7"],
    ["CONNECT", "refused", "proxied", "203.0.113.7"],
    ["QUERY", "ok", "proxied-v6", "2001:db8::7"],
    ["CONNECT", "refused", "proxied-mapped", "198.51.100.9"],
  ], "every row names the client the header carries, never the proxy's 127.0.0.1");
  assert.ok(logs.some((l) => /^\[postgres\] session \d+ connected: "proxied" as "mason" from 203\.0\.113\.7$/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /^\[postgres\] session \d+ connected: "proxied-v6" as "mason" from 2001:db8::7$/.test(l)), logs.join("\n"));
});

test("a LOCAL header is the proxy's own connection (a health check): it is the proxy's address, and the session goes on", async () => {
  const before = (await requests()).length;
  const port = await fakeProxy(named.port, wire.proxyV2(0, 0x00, Buffer.alloc(0)));
  await assert.rejects(client(port, { password: "not-a-token", application_name: "local" }).connect(), /password authentication failed/);
  assert.deepEqual((await requests()).slice(before).map((r) => [r.method, r.clientAddress]), [["CONNECT", "127.0.0.1"]]);
});

test("a named address must begin with a valid v2 header: none, a v1 header, a broken one or one too slow is refused; one split into one-byte writes is read", async (t) => {
  const before = (await requests()).length;
  logs.length = 0;
  // a client straight to the listener, from the address MASON_PG_PROXY_FROM names
  await assert.rejects(client(named.port).connect(), (e: Error) => /did not begin with a valid PROXY protocol v2 header/.test(e.message));
  assert.ok(logs.some((l) => /refused: no PROXY protocol v2 header: its first 12 bytes are not the signature, from 127\.0\.0\.1, which MASON_PG_PROXY_FROM names, so it must begin with one — set the proxy to send the PROXY protocol v2/.test(l)), logs.join("\n"));
  for (const [header, said] of [
    [Buffer.from("PROXY TCP4 203.0.113.7 192.0.2.1 51234 5433\r\n", "latin1"), /a PROXY protocol v1 \(text\) header/],
    [wire.proxyV2(1, 0x00, Buffer.alloc(0)), /family and transport 0x00/],
    [Buffer.concat([wire.proxyV2(1, 0x11, Buffer.alloc(0)).subarray(0, 14), Buffer.from([0x01, 0x00])]), /of 256 bytes past its first 16: Mason reads at most 216/],
  ] as const) {
    const socket = net.connect(named.port, "127.0.0.1");
    const bytes = await closedWith(socket, header, wire.startup({ user: "mason", database: "app" }));
    assert.deepEqual([errorOf(bytes)?.C, errorOf(bytes)?.M], ["08P01", "the connection did not begin with a valid PROXY protocol v2 header"]);
    assert.ok(logs.some((l) => said.test(l)), `${said}: ${logs.join("\n")}`);
  }
  // a header split across reads: each byte its own write, with time for each to arrive alone
  const split = net.connect(named.port, "127.0.0.1");
  split.setNoDelay(true);
  await new Promise<void>((r) => split.once("connect", () => r()));
  for (const byte of wire.proxyV2Inet4("203.0.113.8", 1)) { split.write(Buffer.from([byte])); await sleep(2); }
  const got = await closedWith(split, wire.startup({ user: "mason", database: "app", application_name: "split" }), wire.password("not-a-token"));
  assert.equal(errorOf(got)?.C, "28P01", "the startup after the header was read: a password asked, and refused");
  assert.deepEqual((await requests()).slice(before).map((r) => [r.method, r.applicationName, r.clientAddress]), [["CONNECT", "split", "203.0.113.8"]],
    "no refused connection is a row: only the login read after a whole header");
  // two headers: the second is no header the proxy may send, and is refused as one
  const twice = await closedWith(net.connect(named.port, "127.0.0.1"), wire.proxyV2Inet4("203.0.113.8", 1), wire.proxyV2Inet4("198.51.100.1", 1));
  assert.equal(errorOf(twice)?.C, "08P01");
  assert.ok(logs.some((l) => /refused: a PROXY protocol header from 203\.0\.113\.8, after the header its proxy sent: one header a connection/.test(l)), logs.join("\n"));
  // the deadline: half a header, then nothing
  await t.test("a header not whole in time closes the connection", async () => {
    const slow = net.connect(named.port, "127.0.0.1");
    const at = Date.now();
    const bytes = await closedWith(slow, wire.proxyV2Inet4("203.0.113.9", 1).subarray(0, 8));
    const waited = Date.now() - at;
    assert.ok(waited >= 4_500 && waited < 15_000, `closed after ${waited} ms`);
    assert.equal(errorOf(bytes)?.C, "08P01");
    assert.ok(logs.some((l) => /refused: no whole PROXY protocol v2 header in 5 s, from 127\.0\.0\.1/.test(l)), logs.join("\n"));
  });
});

test("a header from an address MASON_PG_PROXY_FROM does not name is refused, never believed; unset, every header is, and nothing else changes", async () => {
  const before = (await requests()).length;
  logs.length = 0;
  for (const [api, said] of [[unnamed, /which MASON_PG_PROXY_FROM does not name/], [unset, /and this listener believes none/]] as const) {
    const port = await fakeProxy(api.port, wire.proxyV2Inet4("203.0.113.66", 4444));
    await assert.rejects(client(port, { password: "not-a-token" }).connect(), (e: Error) => /a PROXY protocol header, which this server takes only from the addresses of its own proxy/.test(e.message));
    assert.ok(logs.some((l) => new RegExp(`refused: a PROXY protocol header from 127\\.0\\.0\\.1, ${said.source}`).test(l)), logs.join("\n"));
    const v1 = await closedWith(net.connect(api.port, "127.0.0.1"), Buffer.from("PROXY TCP4 203.0.113.66 192.0.2.1 1 5433\r\n", "latin1"));
    assert.equal(errorOf(v1)?.C, "08P01", "a v1 header from it too");
    // a client straight to it: as before, its own address in the log
    const c = client(api.port, { application_name: "direct" });
    await c.connect();
    try { assert.equal((await c.query("SHOW ssl")).rows[0].ssl, "off"); } finally { await c.end(); }
    await assert.rejects(client(api.port, { password: "not-a-token", application_name: "direct" }).connect(), /password authentication failed/);
  }
  const rows = (await requests()).slice(before);
  assert.deepEqual(rows.map((r) => [r.method, r.applicationName, r.clientAddress]), [["CONNECT", "direct", "127.0.0.1"], ["CONNECT", "direct", "127.0.0.1"]],
    "the header's 203.0.113.66 is nowhere: the connections that sent one were refused before any login");
  assert.ok(!logs.some((l) => l.includes("203.0.113.66")), "nor in the log");
});

test("TLS behind a PROXY header: SSLRequest and a direct TLS start both work after it, the session TLS and its address the header's", async () => {
  const before = (await requests()).length;
  const port = await fakeProxy(namedTls.port, wire.proxyV2Inet4("203.0.113.21", 1));
  const c = client(port, { ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { assert.equal((await c.query("SHOW ssl")).rows[0].ssl, "on"); } finally { await c.end(); }
  await assert.rejects(client(port, { ssl: { rejectUnauthorized: false }, password: "not-a-token", application_name: "ssl-request" }).connect(), /password authentication failed/);
  await assert.rejects(client(port, { ssl: false }).connect(), /requires TLS/, "a plain startup behind a header is refused as without one");
  // sslnegotiation=direct: a ClientHello right after the header
  const direct = tls.connect({ host: "127.0.0.1", port: await fakeProxy(namedTls.port, wire.proxyV2Inet6("20010db8000000000000000000000021", 1)), rejectUnauthorized: false, ALPNProtocols: ["postgresql"] });
  await new Promise<void>((resolve, reject) => { direct.once("secureConnect", resolve); direct.once("error", reject); });
  assert.equal(direct.alpnProtocol, "postgresql");
  const bytes = await closedWith(direct as unknown as net.Socket, wire.startup({ user: "mason", database: "app", application_name: "direct-tls" }), wire.password("not-a-token"));
  assert.equal(errorOf(bytes)?.C, "28P01");
  assert.deepEqual((await requests()).slice(before).map((r) => [r.method, r.applicationName, r.clientAddress]),
    [["CONNECT", "ssl-request", "203.0.113.21"], ["CONNECT", "direct-tls", "2001:db8::21"]]);
});

test("a CancelRequest through the proxy carries its header too and stops the statement; one without a header from the proxy's address is refused", async () => {
  const port = await fakeProxy(named.port, wire.proxyV2Inet4("203.0.113.30", 7000));
  const c = client(port, { application_name: "cancelled" });
  await c.connect();
  try {
    const { processID: pid, secretKey: secret } = c as unknown as { processID: number; secretKey: number };
    const running = c.query("SELECT count(*) FROM big a, big b WHERE (a.id::bigint * b.id) % 7 = 3");
    const failed = running.then(() => null, (e: pg.DatabaseError) => e);
    for (const deadline = Date.now() + 15_000; named.running().every((r) => r.session !== pid); await sleep(20)) if (Date.now() > deadline) throw new Error("the statement never showed as running");
    // straight from the named address: no header, so refused before the cancel is read
    const refused = await closedWith(net.connect(named.port, "127.0.0.1"), wire.cancelRequest(pid, secret));
    assert.equal(errorOf(refused)?.C, "08P01");
    await sleep(200);
    assert.ok(named.running().some((r) => r.session === pid), "the statement goes on");
    // through the proxy: the header first, then the cancel, as a driver's cancel through an NLB arrives
    const viaProxy = await closedWith(net.connect(port, "127.0.0.1"), wire.cancelRequest(pid, secret));
    assert.equal(errorOf(viaProxy), undefined, "a cancel is answered by nothing, as Postgres's");
    const e = await failed;
    assert.equal(e?.code, "57014");
  } finally { await c.end(); }
});

test("a share's socket never reads a header, whatever MASON_PG_PROXY_FROM names: one is refused there without a line of the log, and a connection without one starts as before", async () => {
  const share = await named.openShare({ tls: { cert: Buffer.from(pair.cert), key: Buffer.from(pair.key) }, authenticate: () => ({}), recheck: async () => undefined, loginHint: "" });
  try {
    logs.length = 0;
    const refused = await closedWith(net.connect(share.port, "127.0.0.1"), wire.proxyV2Inet4("203.0.113.40", 1), wire.sslRequest());
    assert.equal(errorOf(refused)?.C, "08P01", "the share's loopback is the tunnel's, never a named proxy");
    assert.deepEqual(logs.filter((l) => /PROXY/.test(l)), [], "a stranger's bytes write no line there");
    const plain = net.connect(share.port, "127.0.0.1");
    const answer = await new Promise<Buffer>((resolve, reject) => { plain.once("data", resolve); plain.once("error", reject); plain.write(wire.sslRequest()); });
    plain.destroy();
    assert.equal(answer.toString("latin1"), "S", "no header asked of it: the SSLRequest is answered");
  } finally { await share.close(); }
});
