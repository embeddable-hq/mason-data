/**
 * `mason serve`'s MCP ENDPOINT OVER STREAMABLE HTTP, WITH OAUTH (src/cli/mcp-http.ts, src/cli/mcp-oauth.ts; issue 1115):
 * a Postgres listener over a throwaway DuckStore with its users file, the endpoint mounted on the health server as
 * `mason serve` mounts it, and a test authorization server this file runs itself (its metadata and published keys on
 * 127.0.0.1, synthetic keys, synthetic user names). A client posts JSON-RPC to /mcp as a hosted agent does. What it
 * must hold:
 *   - the protected resource's metadata at RFC 9728's paths, naming the PUBLIC address (MASON_MCP_URL) and the issuer;
 *     a request with no token is 401 with WWW-Authenticate naming that metadata;
 *   - a valid token lists the tables and runs a query as the user it names, and the request log names the user, the
 *     client (mason-mcp/<client>) and the client's address;
 *   - refused, each with what to do: a missing, expired, not-yet-valid, wrong-audience (the address Mason sees included),
 *     wrong-issuer, bad-signature, unknown-key, `alg: none` and HS256 token; a token for an unknown or disabled user;
 *   - MASON_MCP_FROM: client judges a user's ranges on the client's address; token replaces them for a request with a
 *     valid token alone, never for one without, and never on the Postgres API's own listener;
 *   - a cancellation (notifications/cancelled) stops the statement where it runs, as over stdio;
 *   - a session is its user's; the issuer's keys unreadable refuse every token (503), never let one through.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { CopyState } from "../src/duck/sync.ts";
import { listenerLogins, LiveUsers, USERS_FILE } from "../src/duck/users.ts";
import { addUser, disableUser } from "../src/cli/user.ts";
import { PgConnection, PgError } from "../src/cdc/pg-wire.ts";
import { healthServer } from "../src/cli/serve.ts";
import { mcpEndpoint, type McpEndpoint } from "../src/cli/mcp-http.ts";
import { mcpSettings, type McpSettings } from "../src/cli/mcp-oauth.ts";

const API_KEY = "k".repeat(48);
/** the endpoint's public address: what a relay in front serves, never the address the test reaches */
const PUBLIC = "https://mason.example.test/mcp";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-mcp-http-"));
const home = path.join(dir, ".mason");
const usersFile = path.join(home, USERS_FILE);
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;
let users: LiveUsers;
let limitedPassword = "";

const schema: PgSchema = {
  database: "shop",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8", notNull: true }, { name: "status", type: "text" }] },
    { name: "events", primaryKey: [], joins: [], columns: [{ name: "id", type: "int4" }] },
  ],
};
const copies = (): CopyState[] => [{ source: "public.orders", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-11-01T09:00:00.000Z", error: null,
  kept: { by: "poll", sync: { mode: "off" }, syncedAt: "2026-11-01T09:00:00.000Z", nextAt: null } }];

// ------------------------------------------------------------------ the test authorization server

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
/** a key the issuer never published, under the kid of one it did */
const stranger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
let issuerServer: http.Server;
let ISSUER = "";
let keyFetches = 0;

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

/** A JWT: the header and claims given, signed by `key` as `alg` says (none: no signature; HS256: the key's bytes as a secret). */
function jwt(claims: Record<string, unknown>, o: { alg?: string; kid?: string; key?: crypto.KeyObject; header?: Record<string, unknown> } = {}): string {
  const alg = o.alg ?? "RS256";
  const head = `${b64({ alg, typ: "at+jwt", ...(o.kid !== undefined ? { kid: o.kid } : { kid: alg.startsWith("ES") ? "e1" : "r1" }), ...o.header })}.${b64(claims)}`;
  const data = Buffer.from(head);
  if (alg === "none") return `${head}.`;
  if (alg === "HS256") return `${head}.${crypto.createHmac("sha256", Buffer.from(JSON.stringify(rsa.publicKey.export({ format: "jwk" })))).update(data).digest("base64url")}`;
  const key = o.key ?? (alg.startsWith("ES") ? ec.privateKey : rsa.privateKey);
  const sig = alg.startsWith("ES") ? crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }) : crypto.sign("sha256", data, key);
  return `${head}.${sig.toString("base64url")}`;
}

const nowS = (): number => Math.floor(Date.now() / 1000);
/** a valid token's claims for `user` */
const claims = (user: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISSUER, aud: PUBLIC, sub: user, exp: nowS() + 600, iat: nowS(), ...more });

// ------------------------------------------------------------------ the endpoint, as mason serve mounts it

interface Mounted { endpoint: McpEndpoint; server: http.Server; base: string; logged: string[] }
const mounted: Mounted[] = [];

async function mount(env: Record<string, string>): Promise<Mounted> {
  const s = mcpSettings({ MASON_MCP_URL: PUBLIC, MASON_MCP_ISSUER: ISSUER, ...env }, "127.0.0.1");
  assert.ok(s !== null && !("problems" in s), JSON.stringify(s));
  const logged: string[] = [];
  const endpoint = mcpEndpoint(s as McpSettings, { log: (l) => logged.push(l) });
  await endpoint.attach({ listener: api, users, database: "shop" });
  const server = healthServer(() => ({ phase: "starting" }), Date.now(), (l) => logged.push(l), undefined, endpoint);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const m = { endpoint, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, logged };
  mounted.push(m);
  return m;
}

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  issuerServer = http.createServer((req, res) => {
    const json = (v: unknown): void => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v)); };
    if (req.url === "/.well-known/oauth-authorization-server") { json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, authorization_endpoint: `${ISSUER}/authorize` }); return; }
    if (req.url === "/jwks") {
      keyFetches++;
      json({ keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "r1", use: "sig", alg: "RS256" }, { ...ec.publicKey.export({ format: "jwk" }), kid: "e1", use: "sig" }] });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
  ISSUER = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;
  store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR); INSERT INTO public.orders VALUES (1, 'paid'), (2, 'paid'), (3, 'pending')");
  await store.writer.run("CREATE TABLE public.events AS SELECT range::INTEGER AS id FROM range(150000)");
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000 });
  users = new LiveUsers(usersFile, API_KEY);
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test", ...listenerLogins(users, API_KEY),
    schema: () => schema, record: (row) => ledger.record(row), log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, copies),
  });
  const link = { url: "", host: "127.0.0.1", port: api.port, database: "shop" };
  for (const [name, o] of [["analyst", {}], ["limited", { from: ["10.0.0.0/8"] }], ["paused", {}]] as const) {
    const added = addUser(usersFile, API_KEY, name, { link, database: "shop", ...o });
    if ("message" in added) throw new Error(JSON.stringify(added));
    if (name === "limited") limitedPassword = new URL(added.url!).password;
  }
  const d = disableUser(usersFile, "paused");
  if ("message" in d) throw new Error(JSON.stringify(d));
});

after(async () => {
  for (const m of mounted) { await m.endpoint.close(); m.server.closeAllConnections(); m.server.close(); }
  issuerServer.close();
  await api.close();
  await ledger.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ a Streamable HTTP client

interface Answer { status: number; headers: Headers; body: Record<string, unknown> | null }

async function post(m: Mounted, message: unknown, o: { token?: string; session?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  const res = await fetch(`${m.base}/mcp`, { method: "POST", body: JSON.stringify(message), headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(o.token !== undefined ? { authorization: `Bearer ${o.token}` } : {}), ...(o.session !== undefined ? { "mcp-session-id": o.session } : {}), ...o.headers } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text === "" ? null : JSON.parse(text) as Record<string, unknown> };
}

let ids = 1;
/** a session opened as a hosted agent opens one: initialize, then notifications/initialized */
async function session(m: Mounted, token: string): Promise<string> {
  const init = await post(m, { jsonrpc: "2.0", id: ids++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hosted agent", version: "1" } } }, { token });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid !== null && sid.length >= 32, "a session id");
  assert.equal((init.body!.result as { serverInfo: { name: string } }).serverInfo.name, "mason");
  const ack = await post(m, { jsonrpc: "2.0", method: "notifications/initialized" }, { token, session: sid });
  assert.equal(ack.status, 202);
  assert.equal(ack.body, null);
  return sid;
}

async function call(m: Mounted, token: string, sid: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; text: string; structured: Record<string, unknown> }> {
  const a = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/call", params: { name, arguments: args } }, { token, session: sid });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const r = a.body!.result as { content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
  return { ...(r.isError ? { isError: true } : {}), text: r.content[0]!.text, structured: r.structuredContent };
}

async function rows(): Promise<Awaited<ReturnType<RequestLedger["recent"]>>> {
  await ledger.flush();
  return (await ledger.recent({ limit: 500 })).filter((r) => r.applicationName.startsWith("mason-mcp"));
}

// ------------------------------------------------------------------ the tests

test("the protected resource's metadata names the public address and the issuer; a request with no token is 401 naming it", async () => {
  const m = await mount({});
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`${m.base}${p}`);
    assert.equal(res.status, 200, p);
    assert.deepEqual(await res.json(), { resource: PUBLIC, authorization_servers: [ISSUER], bearer_methods_supported: ["header"], resource_name: "Mason" });
  }
  const none = await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(none.status, 401);
  // built from the PUBLIC address, never the address the request reached (RFC 9728 section 5.1)
  assert.equal(none.headers.get("www-authenticate"), 'Bearer resource_metadata="https://mason.example.test/.well-known/oauth-protected-resource/mcp"');
  assert.match(JSON.stringify(none.body), /sign in at http:\/\/127\.0\.0\.1:\d+ .*Authorization: Bearer/);
  // /healthz is the health server's as before
  assert.equal((await fetch(`${m.base}/healthz`)).status, 503);
});

test("a valid token lists the tables and runs a query as the user it names; the request log names the user, the client and its address", async () => {
  const m = await mount({});
  const token = jwt(claims("analyst"));
  const sid = await session(m, token);
  const list = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token, session: sid });
  assert.deepEqual((list.body!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name), ["tables", "describe", "query", "explain"]);
  const tables = await call(m, token, sid, "tables");
  assert.deepEqual((tables.structured.tables as Array<{ table: string }>).map((t) => t.table), ["public.events", "public.orders"]);
  const q = await call(m, token, sid, "query", { sql: "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY status" });
  assert.equal(q.isError, undefined, q.text);
  assert.deepEqual(q.structured.rows, [["paid", "2"], ["pending", "1"]]);
  assert.deepEqual(q.structured.columns, [{ name: "status", type: "text" }, { name: "n", type: "bigint" }]);
  // an EC (ES256) token of the same issuer is as good
  const es = await call(m, jwt(claims("analyst"), { alg: "ES256" }), sid, "query", { sql: "SELECT count(*) FROM orders" });
  assert.deepEqual(es.structured.rows, [["3"]]);
  const r = (await rows()).find((x) => x.query.includes("GROUP BY status"));
  assert.ok(r !== undefined, "the statement is a row of the request log");
  assert.equal(r.user, "analyst");
  assert.equal(r.applicationName, "mason-mcp/hosted-agent");
  assert.equal(r.clientAddress, "127.0.0.1");
  // as mason logs --requests prints it: the client and the user on its line
  const { requestLine } = await import("../src/cli/commands.ts");
  const { PLAIN } = await import("../src/cli/style.ts");
  assert.match(requestLine(r, PLAIN), /  mason-mcp\/hosted-agent \(user analyst\)  SELECT status, count\(\*\)/);
  // the token reaches no log line
  assert.ok(m.logged.every((l) => !l.includes(token.split(".")[2]!)), m.logged.join("\n"));
});

test("refused with what to do: a missing, expired, not-yet-valid, wrong-audience, wrong-issuer, bad-signature, unknown-key, alg none or HS256 token", async () => {
  const m = await mount({});
  const seen = `${m.base}/mcp`;
  const cases: Array<[string, string, RegExp]> = [
    ["expired", jwt(claims("analyst", { exp: nowS() - 120 })), /expired: sign in again/],
    ["not yet valid", jwt(claims("analyst", { nbf: nowS() + 600 })), /not valid yet/],
    ["no expiry", jwt({ iss: ISSUER, aud: PUBLIC, sub: "analyst" }), /no expiry/],
    ["another audience", jwt(claims("analyst", { aud: "https://other.example.test/mcp" })), /audience \(aud\) must name https:\/\/mason\.example\.test\/mcp \(MASON_MCP_URL\)/],
    // the address Mason SEES is not its address: the operator's public one is
    ["the address Mason sees", jwt(claims("analyst", { aud: seen })), /audience/],
    ["another issuer", jwt(claims("analyst", { iss: "https://issuer.example.test" })), /another authorization server than MASON_MCP_ISSUER/],
    ["a signature by another key", jwt(claims("analyst"), { key: stranger.privateKey }), /signature is not the issuer's/],
    ["a payload changed after signing", ((t) => { const [h, , s] = t.split("."); return `${h}.${b64(claims("paused"))}.${s}`; })(jwt(claims("analyst"))), /signature is not the issuer's/],
    ["an unknown key", jwt(claims("analyst"), { kid: "nobody" }), /none of the issuer's published keys/],
    ["no key named", jwt(claims("analyst"), { header: { kid: undefined } }), /names no key/],
    ["alg none", jwt(claims("analyst"), { alg: "none" }), /never none nor HS/],
    ["HS256 with the public key as its secret", jwt(claims("analyst"), { alg: "HS256" }), /never none nor HS/],
    ["an RS256 alg over an EC key", jwt(claims("analyst"), { alg: "RS256", kid: "e1" }), /does not fit its key's type/],
    ["crit", jwt(claims("analyst"), { header: { crit: ["exp"] } }), /crit/],
    ["not a JWT", "abc", /not a JWT/],
    ["no user claim", jwt({ iss: ISSUER, aud: PUBLIC, exp: nowS() + 600 }), /sub claim \(MASON_MCP_USER_CLAIM\) is missing/],
  ];
  for (const [what, token, reason] of cases) {
    const a = await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token });
    assert.equal(a.status, 401, what);
    const challenge = a.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer resource_metadata="https:\/\/mason\.example\.test\/\.well-known\/oauth-protected-resource\/mcp", error="invalid_token", error_description="/, what);
    assert.match(String((a.body!.error as { message: string }).message), reason, what);
    assert.match(String((a.body!.error as { fix: string }).fix), /sign in again/, what);
    assert.ok(!JSON.stringify(a.body).includes(token.slice(-20)) || token === "abc", `${what}: the answer carries no token`);
  }
  assert.ok(m.logged.every((l) => cases.every(([, t]) => t === "abc" || !l.includes(t.slice(-30)))), "no token in the log");
});

test("a valid token for an unknown or a disabled user: 403, with the mason user command that fixes it", async () => {
  const m = await mount({});
  const unknown = await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt(claims("ghost")) });
  assert.equal(unknown.status, 403);
  assert.deepEqual(unknown.body, { error: { code: "invalid_user", message: "the token names the mason user ghost, which this Mason does not have",
    fix: "mason user add ghost, beside mason serve, makes it; or the authorization server puts another user's name in the sub claim (MASON_MCP_USER_CLAIM)" } });
  const paused = await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt(claims("paused")) });
  assert.equal(paused.status, 403);
  assert.deepEqual(paused.body, { error: { code: "user_disabled", message: "the mason user paused is disabled", fix: "mason user enable paused, beside mason serve, lets it connect again" } });
  // a claim of another name, as MASON_MCP_USER_CLAIM says
  const byName = await mount({ MASON_MCP_USER_CLAIM: "mason_user" });
  const t = jwt(claims("someone-else", { mason_user: "analyst" }));
  const sid = await session(byName, t);
  assert.deepEqual((await call(byName, t, sid, "query", { sql: "SELECT count(*) FROM orders" })).structured.rows, [["3"]]);
});

test("MASON_MCP_FROM: client judges a user's ranges on the client's address; token replaces them only for a request with a valid token, and never on the Postgres API", async () => {
  const client = await mount({});
  const valid = jwt(claims("limited"));
  const outside = await post(client, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: valid });
  assert.equal(outside.status, 403);
  assert.equal((outside.body!.error as { code: string }).code, "address_not_allowed");
  assert.match((outside.body!.error as { fix: string }).fix, /mason user from limited <ranges>.*MASON_MCP_FROM=token/);

  const token = await mount({ MASON_MCP_FROM: "token" });
  // no token, or an invalid one, from an address outside the user's ranges: 401, no bypass
  assert.equal((await post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status, 401);
  assert.equal((await post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt(claims("limited", { exp: nowS() - 600 })) })).status, 401);
  assert.equal((await post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt(claims("limited"), { key: stranger.privateKey }) })).status, 401);
  // a valid token: allowed, and its statements run on the listener as the user
  const sid = await session(token, valid);
  const q = await call(token, valid, sid, "query", { sql: "SELECT count(*) FROM orders" });
  assert.equal(q.isError, undefined, q.text);
  assert.deepEqual(q.structured.rows, [["3"]]);
  assert.equal((await rows()).filter((r) => r.user === "limited" && r.query.includes("count(*) FROM orders")).length >= 1, true);
  // the Postgres API's own listener still refuses the same user from the same address, its password right
  await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: api.port, database: "shop", user: "limited", password: limitedPassword, sslmode: "disable", textForms: [] }),
    (e: unknown) => e instanceof PgError && e.code === "28000" && /no entry for host "127\.0\.0\.1"/.test(e.fields.M ?? ""));
});

test("the endpoint's door to the listener takes its own connections alone: a user's password with any PROXY header does not log in there", async () => {
  const m = await mount({ MASON_MCP_FROM: "token" });
  const door = m.endpoint.doorPort!;
  assert.ok(door > 0 && door !== api.port);
  const { proxyHeaderFor } = await import("../src/api/postgres/proxy.ts");
  const header = proxyHeaderFor("10.1.2.3")!;
  for (const [what, o] of [["a user's own password", { password: limitedPassword, proxyHeader: header }], ["no PROXY header", { password: limitedPassword }],
    ["a made-up secret", { password: "x".repeat(43), proxyHeader: header }]] as const) {
    await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: door, database: "shop", user: "limited", sslmode: "disable", connectTimeoutMs: 5_000, textForms: [], ...o }),
      (e: unknown) => e instanceof Error && (what === "no PROXY header" ? /PROXY|closed/.test(e.message) : e instanceof PgError && e.code === "28P01"), what);
  }
  // the Postgres API refuses a PROXY header from an address MASON_PG_PROXY_FROM does not name, as before
  await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: api.port, database: "shop", user: "limited", password: limitedPassword, sslmode: "disable", textForms: [], proxyHeader: header }),
    (e: unknown) => e instanceof PgError && e.code === "08P01" && /PROXY/.test(e.message));
  assert.equal((await rows()).some((r) => r.clientAddress === "10.1.2.3"), false);
});

test("a cancelled request: its statement is cancelled where it runs, and it is answered no further, as over stdio", async () => {
  const m = await mount({});
  const token = jwt(claims("analyst"));
  const sid = await session(m, token);
  const id = 4242;
  const long = post(m, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "query", arguments: { sql: "SELECT count(*) FROM events a, events b WHERE (a.id::bigint * b.id) % 7 = 2", timeout_ms: 120_000 } } }, { token, session: sid });
  await sleep(800);
  const t0 = Date.now();
  const cancel = await post(m, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "the user stopped it" } }, { token, session: sid });
  assert.equal(cancel.status, 202);
  const answered = await long;
  // answered no further: accepted, no JSON-RPC answer
  assert.equal(answered.status, 202);
  assert.equal(answered.body, null);
  assert.ok(Date.now() - t0 < 10_000);
  for (let i = 0; ; i++) {
    const r = (await rows()).filter((x) => x.query.includes("% 7 = 2"));
    if (r.length > 0) { assert.deepEqual(r.map((x) => x.sqlstate), ["57014"]); assert.match(r[0]!.message ?? "", /user request/); break; }
    assert.ok(i < 20, "the statement was cancelled");
    await sleep(250);
  }
  assert.ok(m.logged.some((l) => l === "[mcp] analyst: request 4242 cancelled by the client: the user stopped it"), m.logged.join("\n"));
});

test("a session is its user's; one that does not exist is 404; DELETE ends one; GET is not served", async () => {
  const m = await mount({});
  const a = jwt(claims("analyst"));
  const sid = await session(m, a);
  // another valid user's token naming the session: no such session for it
  const other = await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: jwt(claims("limited")), session: sid, headers: {} });
  assert.ok(other.status === 403 || other.status === 404, String(other.status));
  const m2 = await mount({ MASON_MCP_FROM: "token" });
  const sid2 = await session(m2, a);
  assert.equal((await post(m2, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: jwt(claims("limited")), session: sid2 })).status, 404);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a, session: "nope" })).status, 404);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a })).status, 400);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a, session: sid, headers: { "mcp-protocol-version": "1999-01-01" } })).status, 400);
  assert.equal((await fetch(`${m.base}/mcp`, { headers: { authorization: `Bearer ${a}` } })).status, 405);
  assert.equal((await fetch(`${m.base}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${a}`, "mcp-session-id": sid } })).status, 204);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a, session: sid })).status, 404);
});

test("the issuer's keys cannot be read: every token is refused 503, never let through; an unknown kid fetches them again at most once a minute", async () => {
  const dead = http.createServer((_q, r) => r.writeHead(500).end());
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
  try {
    const m = await mount({ MASON_MCP_ISSUER: at });
    const a = await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt({ ...claims("analyst"), iss: at }) });
    assert.equal(a.status, 503);
    assert.equal((a.body!.error as { code: string }).code, "unchecked");
    assert.ok(m.logged.some((l) => /keys could not be read, so every token is refused/.test(l)), m.logged.join("\n"));
  } finally { dead.close(); }
  const m = await mount({});
  await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt(claims("analyst")) });
  const fetched = keyFetches;
  for (let i = 0; i < 5; i++) await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: jwt(claims("analyst"), { kid: `made-up-${i}` }) });
  assert.equal(keyFetches, fetched, "made-up kids fetch the keys again at most once a minute");
});

test("mason serve with MASON_MCP_URL and MASON_MCP_ISSUER: /mcp on its health port runs a query as the token's user; mason status and mason logs --requests name it", { timeout: 180_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { DemoSource } = await import("../src/demo/source.ts");
  const { unassignedPort } = await import("./test-ports.ts");
  const { runMason } = await import("./cli-matrix.ts");
  const MAIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli", "main.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-mcp-"));
  const source = await DemoSource.open({ dir: path.join(root, "db"), port: 0, log: () => undefined });
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(data, ".mason"), { recursive: true, mode: 0o700 });
  // the project: one table of the demo database, synced
  fs.mkdirSync(path.join(root, "project", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "sources", "app.yml"), "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  customers: {}\n");
  const health = await unassignedPort();
  const env = { PATH: process.env.PATH ?? "", HOME: root, DATABASE_URL: source.url, MASON_API_KEY: API_KEY, MASON_DATA: data, MASON_PROJECT: path.join(root, "project"),
    MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1", MASON_PG_PORT: String(await unassignedPort()), MASON_UI_PORT: String(await unassignedPort()),
    MASON_MCP_URL: PUBLIC, MASON_MCP_ISSUER: ISSUER };
  const child = spawn(process.execPath, [MAIN, "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  try {
    for (let i = 0; i < 1200 && !out.includes("mason start: ready"); i++) await sleep(50);
    assert.match(out, /mason start: ready/, out);
    assert.match(out, /  mcp       https:\/\/mason\.example\.test\/mcp \(MASON_MCP_URL\), served at http:\/\/127\.0\.0\.1:\d+\/mcp: tokens of http:\/\/127\.0\.0\.1:\d+, the user in their sub claim/);
    const added = await runMason(data, ["user", "add", "agent", "--json"], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    const m: Mounted = { endpoint: null as unknown as McpEndpoint, server: null as unknown as http.Server, base: `http://127.0.0.1:${health}`, logged: [] };
    const token = jwt(claims("agent"));
    let sid = "";
    // /mcp answers once the endpoint's door is open, just after ready
    for (let i = 0; i < 100; i++) {
      const init = await post(m, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hosted agent", version: "1" } } }, { token });
      if (init.status === 200) { sid = init.headers.get("mcp-session-id")!; break; }
      assert.equal(init.status, 503, JSON.stringify(init.body));
      await sleep(100);
    }
    assert.ok(sid !== "", out);
    // its first sync may still run at ready: asked again until it answers
    let q = await call(m, token, sid, "query", { sql: "SELECT count(*) > 0 AS answer FROM customers" });
    for (let i = 0; i < 100 && q.isError === true; i++) { await sleep(200); q = await call(m, token, sid, "query", { sql: "SELECT count(*) > 0 AS answer FROM customers" }); }
    assert.deepEqual(q.structured.rows, [["t"]], q.text);
    const status = await runMason(data, ["status", "--json"], env);
    assert.deepEqual(JSON.parse(status.stdout).mcp, { url: PUBLIC, issuer: ISSUER, from: "client" });
    const said = await runMason(data, ["status"], env);
    assert.match(said.stdout, /\n  MCP +https:\/\/mason\.example\.test\/mcp  \(signed in by http:\/\/127\.0\.0\.1:\d+; a user's address ranges judged on the client's address\)\n/);
    // the request log is written a few seconds after the statement (its flush)
    let logs = await runMason(data, ["logs", "--requests", "--client", "mason-mcp/hosted-agent"], env);
    for (let i = 0; i < 40 && !logs.stdout.includes("FROM customers"); i++) { await sleep(500); logs = await runMason(data, ["logs", "--requests", "--client", "mason-mcp/hosted-agent"], env); }
    assert.equal(logs.code, 0, logs.stdout + logs.stderr);
    assert.match(logs.stdout, /mason-mcp\/hosted-agent \(user agent\)  SELECT count\(\*\) > 0 AS answer FROM customers/);
    // no token in what the serve logged
    assert.ok(!out.includes(token.split(".")[2]!), "no token in mason serve's log");
  } finally { child.kill("SIGTERM"); await exited; await source.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
