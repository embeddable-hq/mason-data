/**
 * `mason serve`'s MCP ENDPOINT OVER STREAMABLE HTTP, WITH OAUTH (src/cli/mcp-http.ts, src/cli/mcp-oauth.ts; issue 1115):
 * a Postgres listener over a throwaway DuckStore with its users file, the endpoint mounted on the health server as
 * `mason serve` mounts it, and a test authorization server this file runs itself (its published keys on 127.0.0.1,
 * synthetic keys, synthetic user names). A client posts JSON-RPC to /mcp as a hosted agent does. What it must hold:
 *   - the protected resource's metadata at RFC 9728's paths, naming the PUBLIC address (MASON_MCP_URL) and the issuer;
 *     a request with no token is 401 with WWW-Authenticate naming that metadata;
 *   - both eras, as 2026-07-28 says a server of both chooses: an initialize opens a 2025-11-25 session; a request
 *     carrying 2026-07-28's `_meta` is answered by that revision's text — server/discover, tools/list, tools/call as the
 *     mapped user, its headers held to the body, UnsupportedProtocolVersion, and a cancel by closing the connection;
 *   - a valid token lists the tables and runs a query as the user it names, and the request log names the user, the
 *     client (mason-mcp/<client>) and the client's address;
 *   - refused, each with what to do: a missing, expired, not-yet-valid, wrong-audience (the address Mason sees, and a
 *     list holding another, included), wrong-issuer, bad-signature, unknown-key, `alg: none` and HS256 token; a token for
 *     an unknown user, a disabled one, one removed (at once, mid-session too), and a removed-and-added-again user's old
 *     token (its id no longer the name's);
 *   - a user's ranges judged on the client: the peer, or a proxy MASON_MCP_PROXY_FROM names' LAST X-Forwarded-For entry
 *     — never an entry the client forged in front of it, never a header from a peer it does not name;
 *   - a cancellation stops the statement where it runs: notifications/cancelled under 2025-11-25, as over stdio, and
 *     the client closing its request under 2026-07-28;
 *   - a session is its user's; the issuer's keys unreadable refuse every token (503), never let one through.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { CopyState } from "../src/duck/sync.ts";
import { listenerLogins, LiveUsers, USERS_FILE } from "../src/duck/users.ts";
import { addUser, disableUser, enableUser, removeUser } from "../src/cli/user.ts";
import { PgConnection, PgError } from "../src/cdc/pg-wire.ts";
import { healthServer } from "../src/cli/serve.ts";
// the endpoint's modules, imported when the tests run: at a commit without them each test fails by name
// (scripts/fails-without.ts), never the file
type Http = typeof import("../src/cli/mcp-http.ts");
type OAuth = typeof import("../src/cli/mcp-oauth.ts");
const httpModule = await import("../src/cli/mcp-http.ts" as string).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; return null; }) as Http | null;
const oauthModule = await import("../src/cli/mcp-oauth.ts" as string).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; return null; }) as OAuth | null;
type McpEndpoint = import("../src/cli/mcp-http.ts").McpEndpoint;

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
/** each user's id, as mason user add made it */
const idOf: Record<string, string> = {};

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
let JWKS = "";
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
/** a valid token's claims for `user`: its name and its id, as the authorization server signs them in */
const claims = (user: string, more: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ iss: ISSUER, aud: PUBLIC, sub: `subject-of-${user}`, mason_user: user, mason_user_id: idOf[user] ?? "0123456789abcdef", exp: nowS() + 600, iat: nowS(), ...more });

/** a user added as mason user add adds one: its id kept */
function add(name: string, o: { from?: string[] } = {}): void {
  const added = addUser(usersFile, API_KEY, name, { link: { url: "", host: "127.0.0.1", port: api.port, database: "shop" }, database: "shop", ...o });
  if ("message" in added) throw new Error(JSON.stringify(added));
  idOf[name] = added.id;
  if (name === "limited") limitedPassword = new URL(added.url!).password;
}

// ------------------------------------------------------------------ the endpoint, as mason serve mounts it

interface Mounted { endpoint: McpEndpoint; server: http.Server; base: string; logged: string[] }
const mounted: Mounted[] = [];

/** the endpoint's own bounds and clock, and the health port's limits, where a test names them */
interface MountOptions { now?: () => number; limits?: { sessions?: number; userSessions?: number; requests?: number }; health?: Record<string, number> }

async function mount(env: Record<string, string>, o: MountOptions = {}): Promise<Mounted> {
  assert.ok(httpModule !== null && oauthModule !== null, "src/cli/mcp-http.ts and src/cli/mcp-oauth.ts: the endpoint");
  const s = oauthModule.mcpSettings({ MASON_MCP_URL: PUBLIC, MASON_MCP_ISSUER: ISSUER, MASON_MCP_JWKS_URL: JWKS, ...env }, "127.0.0.1");
  assert.ok(s !== null && !("problems" in s), JSON.stringify(s, (_k, v: unknown) => typeof v === "bigint" ? String(v) : v));
  const logged: string[] = [];
  const endpoint = httpModule.mcpEndpoint(s, { log: (l) => logged.push(l), ...(o.now !== undefined ? { now: o.now } : {}), ...(o.limits !== undefined ? { limits: o.limits } : {}) });
  await endpoint.attach({ listener: api, users, database: "shop" });
  const server = (healthServer as unknown as (...a: unknown[]) => http.Server)(() => ({ phase: "starting" }), Date.now(), (l: string) => logged.push(l), undefined, endpoint, ...(o.health !== undefined ? [o.health] : []));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const m = { endpoint, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, logged };
  mounted.push(m);
  return m;
}

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  issuerServer = http.createServer((req, res) => {
    const json = (v: unknown): void => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v)); };
    if (req.url === "/jwks") {
      keyFetches++;
      json({ keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "r1", use: "sig", alg: "RS256" }, { ...ec.publicKey.export({ format: "jwk" }), kid: "e1", use: "sig" }] });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
  ISSUER = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;
  JWKS = `${ISSUER}/jwks`;
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
  add("analyst");
  add("limited", { from: ["10.0.0.0/8"] });
  add("paused");
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
const INIT = (version = "2025-11-25") => ({ jsonrpc: "2.0", id: ids++, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "hosted agent", version: "1" } } });

/** a session opened as a hosted agent opens one under 2025-11-25: initialize, then notifications/initialized */
async function session(m: Mounted, token: string, headers: Record<string, string> = {}): Promise<string> {
  const init = await post(m, INIT(), { token, headers });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid !== null && sid.length >= 32, "a session id");
  assert.equal((init.body!.result as { serverInfo: { name: string } }).serverInfo.name, "mason");
  const ack = await post(m, { jsonrpc: "2.0", method: "notifications/initialized" }, { token, session: sid, headers });
  assert.equal(ack.status, 202);
  assert.equal(ack.body, null);
  return sid;
}

async function call(m: Mounted, token: string, sid: string | null, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ isError?: boolean; text: string; structured: Record<string, unknown> }> {
  const a = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/call", params: { name, arguments: args } }, { token, ...(sid !== null ? { session: sid } : {}), headers });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const r = a.body!.result as { content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
  return { ...(r.isError ? { isError: true } : {}), text: r.content[0]!.text, structured: r.structuredContent };
}

async function rows(): Promise<Awaited<ReturnType<RequestLedger["recent"]>>> {
  await ledger.flush();
  return (await ledger.recent({ limit: 500 })).filter((r) => r.applicationName.startsWith("mason-mcp"));
}

const STATELESS = { "mcp-protocol-version": "2026-07-28" };

/**
 * A REQUEST AS MCP 2026-07-28 SAYS A CLIENT SENDS ONE ("Base protocol": "_meta"; "Streamable HTTP": "Request metadata"):
 * its version, client and capabilities in params._meta, and MCP-Protocol-Version, Mcp-Method and (tools/call,
 * resources/read) Mcp-Name mirrored from the body. `o.meta` and `o.headers` replace what a test breaks.
 */
function modernRequest(method: string, params: Record<string, unknown> = {}, o: { id?: number; client?: string | null; meta?: Record<string, unknown>; headers?: Record<string, string | null> } = {}): { message: unknown; headers: Record<string, string> } {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
    ...(o.client !== null ? { "io.modelcontextprotocol/clientInfo": { name: o.client ?? "spec-client", version: "1.0.0" } } : {}), ...o.meta };
  for (const [k, v] of Object.entries(meta)) if (v === undefined) delete (meta as Record<string, unknown>)[k];
  const named = method === "resources/read" ? params.uri : method === "tools/call" ? params.name : undefined;
  const headers: Record<string, string | null> = { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(typeof named === "string" ? { "mcp-name": named } : {}), ...o.headers };
  return { message: { jsonrpc: "2.0", id: o.id ?? ids++, method, params: { ...params, _meta: meta } },
    headers: Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] !== null)) };
}
async function postModern(m: Mounted, token: string, method: string, params: Record<string, unknown> = {}, o: Parameters<typeof modernRequest>[2] & { more?: Record<string, string> } = {}): Promise<Answer> {
  const r = modernRequest(method, params, o);
  return post(m, r.message, { token, headers: { ...r.headers, ...o.more } });
}

// ------------------------------------------------------------------ the tests

test("the protected resource's metadata names the public address and the issuer; a request with no token is 401 naming it", async () => {
  const m = await mount({});
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`${m.base}${p}`);
    assert.equal(res.status, 200, p);
    assert.deepEqual(await res.json(), { resource: PUBLIC, authorization_servers: [ISSUER], bearer_methods_supported: ["header"], resource_name: "Mason" });
  }
  const none = await post(m, INIT());
  assert.equal(none.status, 401);
  // built from the PUBLIC address, never the address the request reached (RFC 9728 section 5.1)
  assert.equal(none.headers.get("www-authenticate"), 'Bearer resource_metadata="https://mason.example.test/.well-known/oauth-protected-resource/mcp"');
  assert.match(JSON.stringify(none.body), /sign in at http:\/\/127\.0\.0\.1:\d+ .*Authorization: Bearer/);
  // /healthz is the health server's as before
  assert.equal((await fetch(`${m.base}/healthz`)).status, 503);
});

test("2025-11-25: a valid token lists the tables and runs a query as the user it names; the request log names the user, the client and its address", async () => {
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

test("the era is the client's: an initialize opens a 2025-11-25 session (one asking for 2026-07-28, which has no initialize, or for a version it does not know, answered with 2025-11-25); a 2026-07-28 request stands alone, its client named by its _meta clientInfo, the User-Agent only when it carries none", async () => {
  const m = await mount({});
  const token = jwt(claims("analyst"));
  const older = await post(m, INIT("2025-11-25"), { token });
  assert.equal((older.body!.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
  assert.ok(older.headers.get("mcp-session-id") !== null);
  const newer = await post(m, INIT("2026-07-28"), { token });
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  assert.equal((newer.body!.result as { protocolVersion: string }).protocolVersion, "2025-11-25", "2026-07-28 has no initialize: an initialize is the legacy era's");
  assert.ok(newer.headers.get("mcp-session-id") !== null);
  const unknown = await post(m, INIT("2099-01-01"), { token });
  assert.equal((unknown.body!.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
  // under 2026-07-28 a tool call carries no session: it runs as the token's user, its client named by _meta's clientInfo
  const q = await postModern(m, token, "tools/call", { name: "query", arguments: { sql: "SELECT count(*) AS stateless FROM orders" } }, { client: "agent-platform", more: { "user-agent": "other-name/3.1" } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.deepEqual((q.body!.result as { structuredContent: { rows: unknown } }).structuredContent.rows, [["3"]]);
  assert.equal(q.headers.get("mcp-session-id"), null, "no session under 2026-07-28");
  // a request whose _meta names no client: the User-Agent's first word, the last fallback
  const ua = await postModern(m, token, "tools/call", { name: "query", arguments: { sql: "SELECT count(*) AS stateless_ua FROM orders" } }, { client: null, more: { "user-agent": "fallback-agent/2.0" } });
  assert.equal(ua.status, 200, JSON.stringify(ua.body));
  const logged = await rows();
  const r = logged.find((x) => x.query.includes("AS stateless FROM")), rua = logged.find((x) => x.query.includes("AS stateless_ua"));
  assert.ok(r !== undefined && rua !== undefined);
  assert.deepEqual([r.user, r.applicationName], ["analyst", "mason-mcp/agent-platform"]);
  assert.deepEqual([rua.user, rua.applicationName], ["analyst", "mason-mcp/fallback-agent"]);
  // under 2025-11-25 a request with no session is refused, naming both ways
  const lone = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token, headers: { "mcp-protocol-version": "2025-11-25" } });
  assert.equal(lone.status, 400);
  assert.match((lone.body!.error as { fix: string }).fix, /Mcp-Session-Id .* MCP-Protocol-Version: 2026-07-28/);
  // the token is checked on each stateless POST as on any other
  const bare = modernRequest("tools/list");
  assert.equal((await post(m, bare.message, { headers: bare.headers })).status, 401);
});

test("refused with what to do: a missing, expired, not-yet-valid, wrong-audience, wrong-issuer, bad-signature, unknown-key, alg none or HS256 token", async () => {
  const m = await mount({});
  const seen = `${m.base}/mcp`;
  const cases: Array<[string, string, RegExp]> = [
    ["expired", jwt(claims("analyst", { exp: nowS() - 120 })), /expired: sign in again/],
    ["not yet valid", jwt(claims("analyst", { nbf: nowS() + 600 })), /not valid yet/],
    ["no expiry", jwt({ ...claims("analyst"), exp: undefined }), /no expiry/],
    ["another audience", jwt(claims("analyst", { aud: "https://other.example.test/mcp" })), /audience \(aud\) must be exactly https:\/\/mason\.example\.test\/mcp \(MASON_MCP_URL\)/],
    // the address Mason SEES is not its address: the operator's public one is
    ["the address Mason sees", jwt(claims("analyst", { aud: seen })), /audience/],
    // exactly: a list naming this endpoint and another is a token another resource could replay here
    ["a list of this and another", jwt(claims("analyst", { aud: [PUBLIC, "https://other.example.test/mcp"] })), /audience/],
    ["the address with a slash after it", jwt(claims("analyst", { aud: `${PUBLIC}/` })), /audience/],
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
    ["no user claim", jwt({ ...claims("analyst"), mason_user: undefined }), /mason_user claim \(MASON_MCP_USER_CLAIM\) is missing/],
    ["no id claim", jwt({ ...claims("analyst"), mason_user_id: undefined }), /mason_user_id claim \(MASON_MCP_USER_ID_CLAIM\) is missing/],
  ];
  for (const [what, token, reason] of cases) {
    const a = await post(m, INIT(), { token });
    assert.equal(a.status, 401, what);
    const challenge = a.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer resource_metadata="https:\/\/mason\.example\.test\/\.well-known\/oauth-protected-resource\/mcp", error="invalid_token", error_description="/, what);
    assert.match(String((a.body!.error as { message: string }).message), reason, what);
    assert.match(String((a.body!.error as { fix: string }).fix), /sign in again/, what);
    assert.ok(!JSON.stringify(a.body).includes(token.slice(-20)) || token === "abc", `${what}: the answer carries no token`);
  }
  assert.ok(m.logged.every((l) => cases.every(([, t]) => t === "abc" || !l.includes(t.slice(-30)))), "no token in the log");
});

test("the user is looked up at every request: unknown, disabled, removed (at once, mid-session) and removed-and-added-again (the old token's id no longer the name's) are refused 403 with the command that fixes each", async () => {
  const m = await mount({});
  const unknown = await post(m, INIT(), { token: jwt(claims("ghost")) });
  assert.equal(unknown.status, 403);
  assert.equal((unknown.body!.error as { code: string }).code, "invalid_user");
  assert.match((unknown.body!.error as { fix: string }).fix, /^mason user add ghost, beside mason serve, makes it/);
  const paused = await post(m, INIT(), { token: jwt(claims("paused")) });
  assert.equal(paused.status, 403);
  assert.deepEqual(paused.body, { error: { code: "user_disabled", message: "the mason user paused is disabled", fix: "mason user enable paused, beside mason serve, lets it connect again" } });

  // a user that works, then is disabled, enabled, removed and added again: every change at the very next request
  add("temp");
  const old = jwt(claims("temp"));
  const oldId = idOf.temp!;
  const sid = await session(m, old);
  assert.deepEqual((await call(m, old, sid, "query", { sql: "SELECT count(*) FROM orders" })).structured.rows, [["3"]]);
  assert.ok(!("message" in disableUser(usersFile, "temp")));
  const off = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token: old, session: sid });
  assert.deepEqual([off.status, (off.body!.error as { code: string }).code], [403, "user_disabled"]);
  assert.ok(!("message" in enableUser(usersFile, "temp")));
  assert.equal((await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token: old, session: sid })).status, 200);
  assert.ok(!("message" in removeUser(usersFile, "temp")));
  const gone = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token: old, session: sid });
  assert.deepEqual([gone.status, (gone.body!.error as { code: string }).code], [403, "invalid_user"]);
  add("temp");
  assert.notEqual(idOf.temp, oldId);
  // the old token, its signature and claims valid: its id is not the name's user's now
  const replaced = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token: old, session: sid });
  assert.equal(replaced.status, 403);
  assert.deepEqual(replaced.body, { error: { code: "user_removed", message: `the token was issued for the mason user temp with the id ${oldId}, which was removed: the name is another user's now`,
    fix: "sign in again, so the authorization server issues a token for the user temp as it is now (mason user list shows its id)" } });
  // a token for the user as it is now opens a session of its own; the old session is not its
  const now = jwt(claims("temp"));
  assert.equal((await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token: now, session: sid })).status, 404);
  const fresh = await session(m, now);
  assert.deepEqual((await call(m, now, fresh, "query", { sql: "SELECT count(*) FROM orders" })).structured.rows, [["3"]]);
});

test("a user's ranges are judged on the client: the peer, or a named proxy's LAST X-Forwarded-For entry — never one the client forged in front, never a header from a peer not named", async () => {
  const valid = jwt(claims("limited"));
  // no proxy named: the peer (127.0.0.1) is judged, whatever X-Forwarded-For says (an untrusted peer's header is ignored)
  const direct = await mount({});
  for (const headers of [{}, { "x-forwarded-for": "10.1.2.3" }]) {
    const a = await post(direct, INIT(), { token: valid, headers });
    assert.equal(a.status, 403, JSON.stringify(headers));
    assert.deepEqual([(a.body!.error as { code: string }).code, (a.body!.error as { message: string }).message],
      ["address_not_allowed", "the mason user limited may not connect from 127.0.0.1, outside its address ranges"]);
  }
  // 127.0.0.1 named as the relay: its appended entry, the last, is the client
  const relayed = await mount({ MASON_MCP_PROXY_FROM: "127.0.0.1" });
  const inside = { "x-forwarded-for": "10.1.2.3" };
  const sid = await session(relayed, valid, inside);
  const q = await call(relayed, valid, sid, "query", { sql: "SELECT count(*) AS relayed FROM orders" }, inside);
  assert.deepEqual(q.structured.rows, [["3"]]);
  const r = (await rows()).find((x) => x.query.includes("AS relayed"));
  assert.deepEqual([r?.user, r?.clientAddress], ["limited", "10.1.2.3"], "the listener judged and logged the forwarded client");
  // a client that forges an entry inside the ranges, in front of the one the relay appends, is judged by the relay's
  const forged = await post(relayed, INIT(), { token: valid, headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.7" } });
  assert.equal(forged.status, 403);
  assert.equal((forged.body!.error as { message: string }).message, "the mason user limited may not connect from 203.0.113.7, outside its address ranges");
  // the same request with the forged entry last is the relay's own word: inside
  assert.equal((await post(relayed, INIT(), { token: valid, headers: { "x-forwarded-for": "203.0.113.7, 10.9.9.9" } })).status, 200);
  // the forms a relay writes: a port beside the address, and v4-mapped (a dual-stack listener): the client inside
  for (const xff of ["10.9.9.9:51234", "::ffff:10.9.9.9", "[::ffff:10.9.9.9]:443"]) {
    assert.equal((await post(relayed, INIT(), { token: valid, headers: { "x-forwarded-for": xff } })).status, 200, xff);
  }
  // a named relay that says nothing, or something that is no address: refused, never the peer let in
  for (const headers of [{}, { "x-forwarded-for": "10.1.2.3, unknown" }, { "x-forwarded-for": "10.0.0.0/8" }]) {
    const a = await post(relayed, INIT(), { token: valid, headers });
    assert.deepEqual([a.status, (a.body!.error as { code: string }).code], [400, "address_unreadable"], JSON.stringify(headers));
  }
  // no token, or an invalid one, gets nothing whatever the address: 401 before the user is looked at
  assert.equal((await post(relayed, INIT(), { headers: inside })).status, 401);
  assert.equal((await post(relayed, INIT(), { token: jwt(claims("limited"), { key: stranger.privateKey }), headers: inside })).status, 401);
  // the Postgres API's own listener still refuses the same user from 127.0.0.1, its password right
  await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: api.port, database: "shop", user: "limited", password: limitedPassword, sslmode: "disable", textForms: [] }),
    (e: unknown) => e instanceof PgError && e.code === "28000" && /no entry for host "127\.0\.0\.1"/.test(e.fields.M ?? ""));
});

test("the endpoint's door to the listener takes its own connections alone: a user's password with any PROXY header does not log in there", async () => {
  const m = await mount({});
  const door = m.endpoint.doorPort!;
  assert.ok(door > 0 && door !== api.port);
  const { proxyHeaderFor } = await import("../src/api/postgres/proxy.ts");
  const header = proxyHeaderFor("10.1.2.3")!;
  for (const [what, o] of [["a user's own password", { password: limitedPassword, proxyHeader: header }], ["no PROXY header", { password: limitedPassword }],
    ["a made-up secret and the user's id", { password: `${"x".repeat(43)}.${idOf.limited}`, proxyHeader: header }]] as const) {
    await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: door, database: "shop", user: "limited", sslmode: "disable", connectTimeoutMs: 5_000, textForms: [], ...o }),
      (e: unknown) => e instanceof Error && (what === "no PROXY header" ? /PROXY|closed/.test(e.message) : e instanceof PgError && e.code === "28P01"), what);
  }
  // the Postgres API refuses a PROXY header from an address MASON_PG_PROXY_FROM does not name, as before
  await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: api.port, database: "shop", user: "limited", password: limitedPassword, sslmode: "disable", textForms: [], proxyHeader: header }),
    (e: unknown) => e instanceof PgError && e.code === "08P01" && /PROXY/.test(e.message));
  assert.equal((await rows()).some((r) => r.clientAddress === "10.1.2.3" && r.query.includes("pg_catalog")), false);
});

test("a cancelled request under 2025-11-25 (notifications/cancelled): its statement is cancelled where it runs, and it is answered no further, as over stdio", async () => {
  const m = await mount({});
  const token = jwt(claims("analyst"));
  const sid = await session(m, token);
  for (const [revision, id, how] of [["2025-11-25", 4242, { session: sid }]] as const) {
    const marker = `% 7 = ${id % 7}`;
    const long = post(m, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "query", arguments: { sql: `SELECT count(*) FROM events a, events b WHERE (a.id::bigint * b.id) ${marker}`, timeout_ms: 120_000 } } }, { token, ...how });
    await sleep(800);
    const t0 = Date.now();
    const cancel = await post(m, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "the user stopped it" } }, { token, ...how });
    assert.equal(cancel.status, 202, revision);
    const answered = await long;
    // answered no further: accepted, no JSON-RPC answer
    assert.deepEqual([answered.status, answered.body], [202, null], revision);
    assert.ok(Date.now() - t0 < 10_000, revision);
    for (let i = 0; ; i++) {
      const r = (await rows()).filter((x) => x.query.includes(marker));
      if (r.length > 0) { assert.deepEqual(r.map((x) => x.sqlstate), ["57014"], revision); assert.match(r[0]!.message ?? "", /user request/); break; }
      assert.ok(i < 20, `${revision}: the statement was cancelled`);
      await sleep(250);
    }
    assert.ok(m.logged.some((l) => l === `[mcp] analyst: request ${id} cancelled by the client: the user stopped it`), m.logged.join("\n"));
  }
});

test("MCP 2026-07-28 as its text says: server/discover, tools/list and a tools/call query as the mapped user, each result with resultType and serverInfo; a version it does not serve is UnsupportedProtocolVersion; headers held to the body; ping and the removed methods 404; a request cancelled by closing its connection", async () => {
  const m = await mount({});
  const token = jwt(claims("analyst"));
  const serverInfo = (r: Answer) => ((r.body!.result as { _meta: Record<string, { name: string }> })._meta["io.modelcontextprotocol/serverInfo"])?.name;
  // server/discover (a server MUST implement it: "Discovery"), cacheable, with no session minted
  const d = await postModern(m, token, "server/discover", {}, { more: { "mcp-session-id": "made-up" } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const dr = d.body!.result as { resultType: string; supportedVersions: string[]; capabilities: { tools: unknown }; ttlMs: number; cacheScope: string; instructions: string };
  assert.equal(dr.resultType, "complete");
  assert.deepEqual(dr.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  assert.ok(dr.capabilities.tools !== undefined && typeof dr.instructions === "string");
  assert.ok(Number.isInteger(dr.ttlMs) && dr.ttlMs >= 0 && dr.cacheScope === "public");
  assert.equal(serverInfo(d), "mason");
  assert.equal(d.headers.get("mcp-session-id"), null, "an Mcp-Session-Id is ignored, none minted");
  // tools/list: the four tools, a cacheable result
  const l = await postModern(m, token, "tools/list");
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const lr = l.body!.result as { resultType: string; tools: Array<{ name: string }>; ttlMs: number; cacheScope: string };
  assert.deepEqual([lr.resultType, lr.tools.map((t) => t.name), lr.cacheScope], ["complete", ["tables", "describe", "query", "explain"], "public"]);
  assert.ok(Number.isInteger(lr.ttlMs) && lr.ttlMs >= 0);
  // tools/call: a query as the token's user, logged with _meta's client
  const q = await postModern(m, token, "tools/call", { name: "query", arguments: { sql: "SELECT status, count(*) AS modern_n FROM orders GROUP BY 1 ORDER BY 1" } }, { client: "spec-client" });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const qr = q.body!.result as { resultType: string; structuredContent: { rows: unknown }; isError?: boolean };
  assert.deepEqual([qr.resultType, qr.structuredContent.rows, qr.isError], ["complete", [["paid", "2"], ["pending", "1"]], undefined]);
  assert.equal(serverInfo(q), "mason");
  const row = (await rows()).find((x) => x.query.includes("modern_n"));
  assert.deepEqual([row?.user, row?.applicationName], ["analyst", "mason-mcp/spec-client"]);
  // Mcp-Name in the base64 form a name outside plain ASCII takes ("Value encoding")
  const enc = await postModern(m, token, "tools/call", { name: "tables", arguments: {} }, { headers: { "mcp-name": `=?base64?${Buffer.from("tables").toString("base64")}?=` } });
  assert.equal(enc.status, 200, JSON.stringify(enc.body));
  // a resource not found is -32602 under 2026-07-28
  const nf = await postModern(m, token, "resources/read", { uri: "mason://help/none" });
  assert.equal((nf.body!.error as { code: number }).code, -32602);
  const rd = await postModern(m, token, "resources/read", { uri: "mason://help/mcp" });
  assert.deepEqual([(rd.body!.result as { resultType: string; cacheScope: string }).resultType, (rd.body!.result as { cacheScope: string }).cacheScope], ["complete", "public"]);
  // a version it does not serve this way: 400 UnsupportedProtocolVersion, naming the ones it does
  for (const version of ["2099-01-01", "2025-11-25"]) {
    const v = await postModern(m, token, "tools/list", {}, { meta: { "io.modelcontextprotocol/protocolVersion": version }, headers: { "mcp-protocol-version": version } });
    assert.equal(v.status, 400, version);
    const e = v.body!.error as { code: number; data: { supported: string[]; requested: string } };
    assert.deepEqual([v.body!.id !== null, e.code, e.data.requested, e.data.supported.includes("2026-07-28")], [true, -32022, version, true], JSON.stringify(v.body));
  }
  // the headers held to the body, and the required _meta ("Server validation"; "_meta")
  const refusals: Array<[string, Answer, number, number]> = [
    ["no MCP-Protocol-Version", await postModern(m, token, "tools/list", {}, { headers: { "mcp-protocol-version": null } }), 400, -32020],
    ["MCP-Protocol-Version unlike _meta's", await postModern(m, token, "tools/list", {}, { meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }, headers: { "mcp-protocol-version": "2025-11-25" } }), 400, -32020],
    ["no Mcp-Method", await postModern(m, token, "tools/list", {}, { headers: { "mcp-method": null } }), 400, -32020],
    ["Mcp-Method unlike the body's", await postModern(m, token, "tools/list", {}, { headers: { "mcp-method": "resources/list" } }), 400, -32020],
    ["no Mcp-Name on tools/call", await postModern(m, token, "tools/call", { name: "tables", arguments: {} }, { headers: { "mcp-name": null } }), 400, -32020],
    ["Mcp-Name unlike the body's", await postModern(m, token, "tools/call", { name: "tables", arguments: {} }, { headers: { "mcp-name": "query" } }), 400, -32020],
    ["no clientCapabilities", await postModern(m, token, "tools/list", {}, { meta: { "io.modelcontextprotocol/clientCapabilities": undefined } }), 400, -32602],
    ["ping, removed in 2026-07-28", await postModern(m, token, "ping"), 404, -32601],
    ["logging/setLevel, removed", await postModern(m, token, "logging/setLevel", { level: "info" }), 404, -32601],
    ["subscriptions/listen: Mason's lists never change while it runs", await postModern(m, token, "subscriptions/listen", { notifications: { toolsListChanged: true } }), 404, -32601],
  ];
  for (const [what, r, status, code] of refusals) {
    assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal((r.body!.error as { code: number }).code, code, what);
  }
  // CANCEL: the client closes the request's connection ("Streamable HTTP": "Cancellation"); the statement stops where it runs
  const ac = new AbortController();
  const long = modernRequest("tools/call", { name: "query", arguments: { sql: "SELECT count(*) AS cancelled_4545 FROM events a, events b WHERE (a.id::bigint * b.id) % 7 = 2", timeout_ms: 120_000 } }, { id: 4545 });
  const sent = fetch(`${m.base}/mcp`, { method: "POST", body: JSON.stringify(long.message), signal: ac.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...long.headers } }).then(() => "answered", () => "closed");
  await sleep(800);
  ac.abort();
  assert.equal(await sent, "closed");
  for (let i = 0; ; i++) {
    const r = (await rows()).filter((x) => x.query.includes("cancelled_4545"));
    if (r.length > 0) { assert.deepEqual(r.map((x) => x.sqlstate), ["57014"]); break; }
    assert.ok(i < 40, "the statement was cancelled when the client closed its request");
    await sleep(250);
  }
  assert.ok(m.logged.some((l) => /analyst: request .*4545 cancelled: the client closed its request/.test(l)), m.logged.join("\n"));
});

/** what no line of the log may hold: C0 and C1 controls (newline, return, ESC, NEL and CSI with them), DEL, the line and
 *  paragraph separators, the directional marks, embeddings, overrides and isolates */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

test("no client starts a line of mason serve's log: a cancellation's reason and a method, under 2025-11-25 and 2026-07-28, are said in one line with no control character", async () => {
  const m = await mount({});
  const token = jwt(claims("analyst"));
  const sid = await session(m, token);
  const FORGED = "[mcp] refused a request from 6.6.6.6: FORGED LINE";
  /** the lines `act` adds to the log, each held to carry no control character and none to begin a forged line */
  const added = async (what: string, act: () => Promise<void>): Promise<string[]> => {
    const before = m.logged.length;
    await act();
    const lines = m.logged.slice(before).flatMap((l) => l.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/));
    for (const l of lines) {
      assert.doesNotMatch(l, UNSAFE, `${what}: ${JSON.stringify(l)}`);
      assert.ok(!l.startsWith("[mcp] refused a request from 6.6.6.6"), `${what}: a forged line: ${JSON.stringify(lines)}`);
    }
    return lines;
  };
  // A CANCELLATION'S REASON, under each revision: the line it is said in is one line, the reason's breaks shown as `?`
  const reasons: Array<[string, string, string]> = [
    ["a newline", `bye\n${FORGED}`, `bye?${FORGED}`],
    ["a carriage return", `bye\r${FORGED}`, `bye?${FORGED}`],
    ["a line separator", `bye\u2028${FORGED}`, `bye?${FORGED}`],
    ["an ANSI escape", "bye \u001b[2K\u001b[31mred\u001b[0m", "bye ?[2K?[31mred?[0m"],
  ];
  let id = 9100;
  for (const revision of ["2025-11-25", "2026-07-28"] as const) {
    for (const [what, reason, shown] of reasons) {
      const rid = ++id;
      const legacy = revision === "2025-11-25";
      const long = legacy
        ? post(m, { jsonrpc: "2.0", id: rid, method: "tools/call", params: longQuery(rid) }, { token, session: sid })
        : (() => { const r = modernRequest("tools/call", longQuery(rid), { id: rid }); return post(m, r.message, { token, headers: r.headers }); })();
      await sleep(600);
      const lines = await added(`${revision}, ${what}`, async () => {
        const cancel = await post(m, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: rid, reason } }, { token, ...(legacy ? { session: sid } : { headers: STATELESS }) });
        assert.equal(cancel.status, 202, `${revision}, ${what}`);
        assert.equal((await long).status, 202, `${revision}, ${what}: answered no further`);
      });
      assert.deepEqual(lines, [`[mcp] analyst: request ${rid} cancelled by the client: ${shown}`], `${revision}, ${what}`);
    }
  }
  // A METHOD: under 2026-07-28 a method it does not answer is logged as refused (its Mcp-Method header equal to it, so
  // a header's own characters: NEL and CSI); a body's method that is not its header's is refused naming both
  const c1 = "x\u0085[mcp] analyst: FORGED\u009b31m";
  const notFound = modernRequest(c1);
  const nf = await added("2026-07-28, a method with C1 controls", async () => {
    const a = await post(m, notFound.message, { token, headers: notFound.headers });
    assert.equal(a.status, 404, JSON.stringify(a.body));
  });
  assert.equal(nf.length, 1, JSON.stringify(nf));
  assert.match(nf[0]!, /^\[mcp\] refused a request of analyst from 127\.0\.0\.1: Method not found: x\?\[mcp\] analyst: FORGED\?31m \(under 2026-07-28/);
  const mismatch = modernRequest(`tools/list\n[mcp] FORGED\u2028\u001b[31m`, {}, { headers: { "mcp-method": "tools/list" } });
  const mm = await added("2026-07-28, a body's method with a newline", async () => {
    const a = await post(m, mismatch.message, { token, headers: mismatch.headers });
    assert.equal(a.status, 400, JSON.stringify(a.body));
  });
  assert.equal(mm.length, 1, JSON.stringify(mm));
  assert.match(mm[0]!, /^\[mcp\] refused a request of analyst from 127\.0\.0\.1: Header mismatch: Mcp-Method "tools\/list" is not the body's method "tools\/list\?\[mcp\] FORGED\?\?\[31m"$/);
  // under 2025-11-25 a method it does not have is answered, and nothing is logged
  const legacy = await added("2025-11-25, a method with controls", async () => {
    const a = await post(m, { jsonrpc: "2.0", id: ++id, method: `${c1}\n${FORGED}`, params: {} }, { token, session: sid });
    assert.equal((a.body!.error as { code: number }).code, -32601);
  });
  assert.deepEqual(legacy, []);
});

test("serverInfo carries the endpoint's icon (issue 1168): Mason's PNG by default in initialize and server/discover, sent once (a tools/call result's _meta names the server without it); MASON_MCP_ICON's data: PNG or same-origin https address in its place", async () => {
  type Info = { name: string; websiteUrl?: string; description?: string; icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }> };
  const token = jwt(claims("analyst"));
  /** what each place says the server is: 2025-11-25's initialize, 2026-07-28's server/discover and a tools/call's _meta */
  const everywhere = async (m: Mounted): Promise<Info[]> => {
    const init = await post(m, INIT(), { token });
    assert.equal(init.status, 200, JSON.stringify(init.body));
    const d = await postModern(m, token, "server/discover");
    const q = await postModern(m, token, "tools/call", { name: "query", arguments: { sql: "SELECT 1 AS icon_n" } });
    assert.equal((q.body!.result as { isError?: boolean }).isError, undefined, JSON.stringify(q.body));
    const meta = (r: Answer): Info => (r.body!.result as { _meta: Record<string, Info> })._meta["io.modelcontextprotocol/serverInfo"]!;
    return [(init.body!.result as { serverInfo: Info }).serverInfo, meta(d), meta(q)];
  };
  // the default: Mason's logo, a 128x128 PNG as a data: URI, in initialize and server/discover; a tools/call result's
  // _meta names the server without it (sent once, not in every answer)
  const [initInfo, discoverInfo, callInfo] = await everywhere(await mount({}));
  const infos = [initInfo!, discoverInfo!];
  for (const info of infos) {
    assert.deepEqual([info.name, info.websiteUrl, typeof info.description], ["mason", "https://github.com/embeddable-hq/mason-data", "string"]);
    assert.ok(Array.isArray(info.icons) && info.icons.length === 1, JSON.stringify(info).slice(0, 200));
    const icon = info.icons[0]!;
    assert.deepEqual([icon.mimeType, icon.sizes, icon.src.slice(0, 22)], ["image/png", ["128x128"], "data:image/png;base64,"]);
    const png = Buffer.from(icon.src.slice(22), "base64");
    assert.deepEqual([png.subarray(0, 8).toString("hex"), png.toString("latin1", 12, 16), png.readUInt32BE(16), png.readUInt32BE(20)], ["89504e470d0a1a0a", "IHDR", 128, 128]);
  }
  assert.deepEqual(infos[1], infos[0], "server/discover says what initialize says");
  const { icons: _icons, ...identity } = initInfo!;
  assert.deepEqual(callInfo, identity, "a result's _meta says who the server is as initialize does, its icons left out");
  assert.equal("icons" in callInfo!, false);
  // MASON_MCP_ICON: a data: PNG of the host's (1x1 here), sent as given with its size; and an https address on the
  // endpoint's own origin
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  for (const [value, icons] of [[png, [{ src: png, mimeType: "image/png", sizes: ["1x1"] }]],
    ["https://mason.example.test/brand/icon.png", [{ src: "https://mason.example.test/brand/icon.png", mimeType: "image/png" }]]] as const) {
    const [i, d, c] = await everywhere(await mount({ MASON_MCP_ICON: value }));
    assert.deepEqual([i!.icons, d!.icons, "icons" in c!], [icons, icons, false], value.slice(0, 40));
  }
});

test("Origin: a request carrying one is a browser's, answered only from an origin MASON_MCP_ORIGINS names — refused 403 before its token is read, under every revision; Origin: null refused; a request with none (a hosted agent's server, a desktop app) served as before", async () => {
  const m = await mount({ MASON_MCP_ORIGINS: "https://app.example.test,http://localhost:5173" });
  const token = jwt(claims("analyst"));
  // allowed: served, under both revisions
  const sid = await session(m, token, { origin: "https://app.example.test" });
  assert.equal((await call(m, token, sid, "tables", {}, { origin: "http://localhost:5173" })).isError, undefined);
  const discover = modernRequest("server/discover");
  assert.equal((await post(m, discover.message, { token, headers: { ...discover.headers, origin: "https://app.example.test" } })).status, 200);
  // refused, with a token or without one (the origin is judged first), under both revisions, with what to do
  for (const origin of ["https://evil.example.test", "null", "https://app.example.test.evil.example.test", "https://APP.example.test", "http://app.example.test"]) {
    for (const [what, message, headers] of [
      ["no token", INIT(), {}],
      ["a valid token, 2025-11-25", INIT(), {}],
      ["a valid token, 2026-07-28", discover.message, discover.headers],
    ] as Array<[string, unknown, Record<string, string>]>) {
      const before = m.logged.length;
      const a = await post(m, message, { ...(what === "no token" ? {} : { token }), headers: { ...headers, origin } });
      assert.equal(a.status, 403, `${origin}, ${what}: ${JSON.stringify(a.body)}`);
      assert.equal(a.headers.get("www-authenticate"), null, `${origin}, ${what}: refused before the token`);
      const e = (a.body as { error: { code: string; message: string; fix: string } }).error;
      assert.equal(e.code, "origin_not_allowed");
      assert.equal(e.message, `the request came from the browser origin ${JSON.stringify(origin)}, which MASON_MCP_ORIGINS does not name`);
      assert.match(e.fix, /^name the origin in MASON_MCP_ORIGINS beside mason serve/);
      assert.deepEqual(m.logged.slice(before), [`[mcp] refused a request from 127.0.0.1: ${e.message}`]);
    }
  }
  // a session's later request from a foreign origin is refused too
  assert.equal((await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/list" }, { token, session: sid, headers: { origin: "https://evil.example.test" } })).status, 403);
  // none sent: served (this file's client is Node's fetch, which sends none, as a hosted agent's server does)
  assert.equal((await call(m, token, sid, "tables")).isError, undefined);
  // unset: no browser origin at all
  const off = await mount({});
  const r = await post(off, INIT(), { token, headers: { origin: "https://app.example.test" } });
  assert.equal(r.status, 403);
  assert.equal((r.body as { error: { message: string } }).error.message, "the request came from the browser origin \"https://app.example.test\", which MASON_MCP_ORIGINS does not name (it names none)");
  assert.equal((await post(off, INIT(), { token })).status, 200);
});

test("a session is its user's; one that does not exist is 404; DELETE ends one; GET is not served", async () => {
  const m = await mount({ MASON_MCP_PROXY_FROM: "127.0.0.1" });
  const inside = { "x-forwarded-for": "10.1.2.3" };
  const a = jwt(claims("analyst"));
  const sid = await session(m, a, inside);
  // another valid user's token naming the session: no such session for it
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: jwt(claims("limited")), session: sid, headers: inside })).status, 404);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a, session: "nope", headers: inside })).status, 404);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a, session: sid, headers: { ...inside, "mcp-protocol-version": "1999-01-01" } })).status, 400);
  assert.equal((await fetch(`${m.base}/mcp`, { headers: { ...inside, authorization: `Bearer ${a}` } })).status, 405);
  assert.equal((await fetch(`${m.base}/mcp`, { method: "DELETE", headers: { ...inside, authorization: `Bearer ${a}`, "mcp-session-id": sid } })).status, 204);
  assert.equal((await post(m, { jsonrpc: "2.0", id: 9, method: "ping" }, { token: a, session: sid, headers: inside })).status, 404);
});

test("the issuer's keys cannot be read: every token is refused 503, never let through; an unknown kid fetches them again at most once a minute", async () => {
  const dead = http.createServer((_q, r) => r.writeHead(500).end());
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
  try {
    const m = await mount({ MASON_MCP_JWKS_URL: `${at}/jwks` });
    const a = await post(m, INIT(), { token: jwt(claims("analyst")) });
    assert.equal(a.status, 503);
    assert.equal((a.body!.error as { code: string }).code, "unchecked");
    assert.ok(m.logged.some((l) => /keys could not be read, so every token is refused/.test(l)), m.logged.join("\n"));
  } finally { dead.close(); }
  const m = await mount({});
  await post(m, INIT(), { token: jwt(claims("analyst")) });
  const fetched = keyFetches;
  for (let i = 0; i < 5; i++) await post(m, INIT(), { token: jwt(claims("analyst"), { kid: `made-up-${i}` }) });
  assert.equal(keyFetches, fetched, "made-up kids fetch the keys again at most once a minute");
});

/** a query that runs until it is cancelled or its timeout_ms ends it (150,000 rows joined to themselves) */
const longQuery = (marker: number, timeoutMs = 120_000) => ({ name: "query", arguments: { sql: `SELECT count(*) FROM events a, events b WHERE (a.id::bigint * b.id) % 7 = ${marker % 7} AND ${marker} > 0`, timeout_ms: timeoutMs } });

test("sessions are bounded per user and in all: a user over its bound loses its own oldest idle session, or is refused 429 when each runs a request; at the bound in all a new session is refused 503 with Retry-After, never made by ending another user's session in use — one unused past EVICTABLE_IDLE_MS makes way", async () => {
  assert.ok(httpModule !== null, "src/cli/mcp-http.ts");
  assert.equal(httpModule.MAX_USER_SESSIONS > 0 && httpModule.MAX_USER_SESSIONS < httpModule.MAX_SESSIONS, true);
  if (idOf.other === undefined) add("other");
  let clock = Date.now();
  const m = await mount({}, { now: () => clock, limits: { sessions: 3, userSessions: 2 } });
  const far = { exp: nowS() + 86_400 };
  const a = jwt(claims("analyst", far)), o = jwt(claims("other", far));
  const ping = async (token: string, sid: string): Promise<number> => (await post(m, { jsonrpc: "2.0", id: ids++, method: "ping" }, { token, session: sid })).status;
  // a user's own bound: its third session ends its own oldest idle one, no one else's
  const s1 = await session(m, a);
  clock += 1_000;
  const s2 = await session(m, a);
  clock += 1_000;
  const o1 = await session(m, o);
  clock += 1_000;
  const s3 = await session(m, a);
  assert.deepEqual([await ping(a, s1), await ping(a, s2), await ping(a, s3), await ping(o, o1)], [404, 200, 200, 200]);
  assert.ok(m.logged.some((l) => /made way for a new session of its user/.test(l)), m.logged.join("\n"));
  // each of the user's sessions running a request: a new one is refused 429, neither ended
  const long2 = post(m, { jsonrpc: "2.0", id: 7001, method: "tools/call", params: longQuery(7001) }, { token: a, session: s2 });
  const long3 = post(m, { jsonrpc: "2.0", id: 7002, method: "tools/call", params: longQuery(7002) }, { token: a, session: s3 });
  await sleep(500);
  const busy = await post(m, INIT(), { token: a });
  assert.equal(busy.status, 429, JSON.stringify(busy.body));
  assert.equal((busy.body!.error as { code: string }).code, "too_many_sessions");
  assert.ok(busy.headers.get("retry-after") !== null);
  // the bound in all (3: s2, s3, o1), every session used within EVICTABLE_IDLE_MS: another user's new session is 503
  // with Retry-After, and nobody's is ended — the two running ones above least of all
  const full = await post(m, INIT(), { token: o });
  assert.equal(full.status, 503, JSON.stringify(full.body));
  assert.equal((full.body!.error as { code: string }).code, "too_many_sessions");
  assert.ok(Number(full.headers.get("retry-after")) > 0);
  assert.equal(await ping(o, o1), 200);
  // past EVICTABLE_IDLE_MS unused (o1, idle; s2 and s3 still run their requests): o1 makes way, never a running one
  clock += httpModule.EVICTABLE_IDLE_MS;
  const o2 = await post(m, INIT(), { token: o });
  assert.equal(o2.status, 200, JSON.stringify(o2.body));
  assert.equal(await ping(o, o1), 404);
  for (const [id, sid] of [[7001, s2], [7002, s3]] as const) {
    assert.equal((await post(m, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "done" } }, { token: a, session: sid })).status, 202);
  }
  assert.deepEqual([(await long2).status, (await long3).status], [202, 202], "the running requests were never ended by another's session");
  assert.deepEqual([await ping(a, s2), await ping(a, s3)], [200, 200]);
});

test("the health port's limits: a tool call longer than its request timeout is answered whole; a body or headers sent too slowly are cut; past MAX_REQUESTS /mcp is 503 and /healthz still answers; the connection cap holds and /healthz answers once silent connections are closed", async () => {
  const serveModule = await import("../src/cli/serve.ts") as unknown as { HEALTH_LIMITS?: Record<string, number> };
  assert.ok(serveModule.HEALTH_LIMITS !== undefined, "serve.ts HEALTH_LIMITS");
  assert.deepEqual(serveModule.HEALTH_LIMITS, { headersMs: 10_000, requestMs: 30_000, keepAliveMs: 5_000, maxConnections: 1024, checkEveryMs: 1_000 });
  assert.ok(httpModule !== null && httpModule.MAX_REQUESTS < serveModule.HEALTH_LIMITS.maxConnections!, "/mcp's clients alone never fill the port");
  // the defaults reach the server mason serve listens with
  const plain = (healthServer as unknown as (...a: unknown[]) => http.Server)(() => ({ phase: "starting" }), Date.now(), () => undefined);
  assert.deepEqual([plain.headersTimeout, plain.requestTimeout, plain.keepAliveTimeout, plain.maxConnections], [10_000, 30_000, 5_000, 1024]);
  plain.close();
  const health = { headersMs: 1_000, requestMs: 1_500, keepAliveMs: 1_000, maxConnections: 6, checkEveryMs: 200 };
  const m = await mount({}, { health, limits: { requests: 2 } });
  const token = jwt(claims("analyst"));
  const sid = await session(m, token);
  const port = Number(new URL(m.base).port);
  // a query that runs 3 s, twice the request timeout: answered whole (its timeout_ms the statement's own 57014)
  const t0 = Date.now();
  const slow = await post(m, { jsonrpc: "2.0", id: ids++, method: "tools/call", params: longQuery(7101, 3_000) }, { token, session: sid });
  assert.ok(Date.now() - t0 >= 2_900, `ran ${Date.now() - t0} ms`);
  assert.equal(slow.status, 200, JSON.stringify(slow.body));
  assert.match(JSON.stringify(slow.body), /57014|timeout/i);
  // a body that never ends, and headers that never end: the connection answered 408 or closed within the limits
  const cut = (head: string): Promise<{ ms: number; said: string }> => new Promise((resolve) => {
    const started = Date.now();
    let said = "";
    const c = net.connect(port, "127.0.0.1", () => c.write(head));
    c.on("data", (d) => { said += String(d); });
    c.on("close", () => resolve({ ms: Date.now() - started, said }));
    c.on("error", () => undefined);
  });
  const body = await cut(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc"`);
  assert.ok(body.ms < 4_000, `a body sent too slowly held ${body.ms} ms`);
  const headers = await cut("POST /mcp HTTP/1.1\r\nHost: x\r\n");
  assert.ok(headers.ms < 4_000, `headers sent too slowly held ${headers.ms} ms`);
  // /mcp at its bound (2 running): the next is 503, and /healthz answers beside them
  const running = [7201, 7202].map((id) => post(m, { jsonrpc: "2.0", id, method: "tools/call", params: longQuery(id) }, { token, session: sid }));
  await sleep(500);
  const over = await post(m, { jsonrpc: "2.0", id: ids++, method: "ping" }, { token, session: sid });
  assert.equal(over.status, 503);
  assert.equal((over.body!.error as { code: string }).code, "busy");
  assert.equal((await fetch(`${m.base}/healthz`)).status, 503, "/healthz answers (503: the test's run is starting)");
  // a cancellation is no request: it gets through at the bound, and stops what holds it there
  const t2 = Date.now();
  for (const id of [7201, 7202]) assert.equal((await post(m, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, { token, session: sid })).status, 202);
  assert.deepEqual((await Promise.all(running)).map((r) => r.status), [202, 202]);
  assert.ok(Date.now() - t2 < 10_000, "cancelled at the bound");
  // the connection cap: silent connections fill it; past it a connection is closed at once; within headersMs they are
  // cut, and /healthz answers again
  await sleep(1_500);
  const silent = await Promise.all(Array.from({ length: health.maxConnections }, () => new Promise<net.Socket>((resolve) => { const c = net.connect(port, "127.0.0.1", () => resolve(c)); c.on("error", () => undefined); })));
  await sleep(100);
  const refusedNow = await fetch(`${m.base}/healthz`).then((r) => r.status, () => "closed");
  assert.equal(refusedNow, "closed", "past the cap a connection is closed");
  let answered: number | string = "closed";
  const t1 = Date.now();
  while (answered === "closed" && Date.now() - t1 < 5_000) { await sleep(250); answered = await fetch(`${m.base}/healthz`).then((r) => r.status, () => "closed"); }
  assert.equal(answered, 503, "/healthz answered once the silent connections were cut");
  assert.ok(Date.now() - t1 < 4_000);
  for (const c of silent) c.destroy();
});

test("a JSON-RPC batch counts each of its requests against MAX_REQUESTS, all admitted at once or none; it is 2025-03-26's alone (later revisions take one message a POST) and of at most MAX_BATCH messages; a batch of cancellations gets through at the bound", async () => {
  assert.ok(httpModule !== null, "src/cli/mcp-http.ts");
  const m = await mount({}, { limits: { requests: 4 } });
  const token = jwt(claims("analyst"));
  // a 2025-03-26 session (whose client may send no MCP-Protocol-Version)
  const init = await post(m, INIT("2025-03-26"), { token });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  const old = init.headers.get("mcp-session-id")!;
  assert.equal((await post(m, { jsonrpc: "2.0", method: "notifications/initialized" }, { token, session: old })).status, 202);
  const ping = () => ({ jsonrpc: "2.0", id: ids++, method: "ping" });
  // more requests than may run at once: refused whole, none run
  const five = await post(m, Array.from({ length: 5 }, ping), { token, session: old });
  assert.equal(five.status, 400, JSON.stringify(five.body));
  assert.deepEqual([five.body!.id, (five.body!.error as { code: number }).code], [null, -32600]);
  assert.match((five.body!.error as { message: string }).message, /a JSON-RPC batch of 5 messages: at most 4/);
  // one query and a batch of three: four running, the bound
  const single = post(m, { jsonrpc: "2.0", id: 7301, method: "tools/call", params: longQuery(7301) }, { token, session: old });
  await sleep(300);
  const batch = post(m, [7302, 7303, 7304].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: longQuery(id) })), { token, session: old });
  await sleep(500);
  // past it: one request more, alone or in a batch, is 503, and a batch that would cross it is refused whole
  for (const message of [ping(), [ping()], [{ jsonrpc: "2.0", method: "notifications/progress", params: {} }, ping()]]) {
    const over = await post(m, message, { token, session: old });
    assert.equal(over.status, 503, JSON.stringify(message));
    assert.equal((over.body!.error as { code: string }).code, "busy");
  }
  // a batch of cancellations is no request: it gets through at the bound, and stops all four
  const t0 = Date.now();
  const cancel = await post(m, [7301, 7302, 7303, 7304].map((requestId) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } })), { token, session: old });
  assert.equal(cancel.status, 202);
  assert.deepEqual([(await single).status, (await batch).status], [202, 202], "answered no further");
  assert.ok(Date.now() - t0 < 10_000, "cancelled at the bound");
  // the bound freed: a batch of four runs, each answered
  const four = await post(m, Array.from({ length: 4 }, ping), { token, session: old });
  assert.equal(four.status, 200, JSON.stringify(four.body));
  assert.equal((four.body as unknown as unknown[]).length, 4);
  // under 2025-11-25 and 2026-07-28 a POST is one message: a batch is refused, whatever the header says
  const sid = await session(m, token);
  for (const [what, how] of [["2025-11-25", { session: sid }], ["2025-11-25, its session's header", { session: sid, headers: { "mcp-protocol-version": "2025-11-25" } }],
    ["2025-11-25's session, the header 2025-03-26", { session: sid, headers: { "mcp-protocol-version": "2025-03-26" } }], ["2026-07-28", { headers: STATELESS }]] as const) {
    const r = await post(m, [ping(), ping()], { token, ...how });
    assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal((r.body!.error as { code: number }).code, -32600, what);
    assert.match((r.body!.error as { message: string }).message, /a POST carries a single JSON-RPC message \(batches are 2025-03-26's alone\)/, what);
  }
  // MAX_BATCH, under the default bound: 32 messages answered, 33 refused whole
  const wide = await mount({});
  const wi = await post(wide, INIT("2025-03-26"), { token });
  const wsid = wi.headers.get("mcp-session-id")!;
  const b32 = await post(wide, Array.from({ length: 32 }, ping), { token, session: wsid });
  assert.equal(b32.status, 200, JSON.stringify(b32.body));
  assert.equal((b32.body as unknown as unknown[]).length, 32);
  const b33 = await post(wide, Array.from({ length: 33 }, ping), { token, session: wsid });
  assert.equal(b33.status, 400);
  assert.match((b33.body!.error as { message: string }).message, /a JSON-RPC batch of 33 messages: at most 32/);
  assert.deepEqual([httpModule.MAX_BATCH, httpModule.BATCH_VERSION], [32, "2025-03-26"]);
});

test("mason serve with MASON_MCP_URL, MASON_MCP_ISSUER and MASON_MCP_JWKS_URL: /mcp on its health port runs a query as the token's user; mason status and mason logs --requests name it", { timeout: 400_000 }, async () => {
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
    MASON_MCP_URL: PUBLIC, MASON_MCP_ISSUER: ISSUER, MASON_MCP_JWKS_URL: JWKS };
  const child = spawn(process.execPath, [MAIN, "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  try {
    // generous bounds: under a loaded machine (the full suite) a first start and a first sync take their time
    for (let t0 = Date.now(); Date.now() - t0 < 150_000 && !out.includes("mason start: ready");) await sleep(100);
    assert.match(out, /mason start: ready/, out);
    assert.match(out, /  mcp       https:\/\/mason\.example\.test\/mcp \(MASON_MCP_URL\), served at http:\/\/127\.0\.0\.1:\d+\/mcp: tokens of http:\/\/127\.0\.0\.1:\d+, the user in their mason_user and mason_user_id claims/);
    const added = await runMason(data, ["user", "add", "agent", "--json"], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    idOf.agent = (JSON.parse(added.stdout) as { id: string }).id;
    const m: Mounted = { endpoint: null as unknown as McpEndpoint, server: null as unknown as http.Server, base: `http://127.0.0.1:${health}`, logged: [] };
    const token = jwt(claims("agent"));
    let sid = "";
    // /mcp answers once the endpoint's door is open, just after ready
    for (let t0 = Date.now(); Date.now() - t0 < 30_000;) {
      const init = await post(m, INIT(), { token });
      if (init.status === 200) { sid = init.headers.get("mcp-session-id")!; break; }
      assert.equal(init.status, 503, JSON.stringify(init.body));
      await sleep(100);
    }
    assert.ok(sid !== "", out);
    // its first sync may still run at ready: asked again until it answers
    let q = await call(m, token, sid, "query", { sql: "SELECT count(*) > 0 AS answer FROM customers" });
    for (let t0 = Date.now(); Date.now() - t0 < 90_000 && q.isError === true;) { await sleep(300); q = await call(m, token, sid, "query", { sql: "SELECT count(*) > 0 AS answer FROM customers" }); }
    assert.deepEqual(q.structured.rows, [["t"]], q.text);
    const status = JSON.parse((await runMason(data, ["status", "--json"], env)).stdout) as { mcp: unknown; addressPresets: Array<{ id: string; ranges: string[] }> };
    assert.deepEqual(status.mcp, { url: PUBLIC, issuer: ISSUER });
    assert.deepEqual(status.addressPresets.map((p) => p.id), ["claude", "openai"]);
    const said = await runMason(data, ["status"], env);
    assert.match(said.stdout, /\n  MCP +https:\/\/mason\.example\.test\/mcp  \(for a hosted agent, signed in by http:\/\/127\.0\.0\.1:\d+\)\n/);
    // the request log is written a few seconds after the statement (its flush)
    let logs = await runMason(data, ["logs", "--requests", "--client", "mason-mcp/hosted-agent"], env);
    for (let t0 = Date.now(); Date.now() - t0 < 60_000 && !logs.stdout.includes("FROM customers");) { await sleep(500); logs = await runMason(data, ["logs", "--requests", "--client", "mason-mcp/hosted-agent"], env); }
    assert.equal(logs.code, 0, logs.stdout + logs.stderr);
    assert.match(logs.stdout, /mason-mcp\/hosted-agent \(user agent\)  SELECT count\(\*\) > 0 AS answer FROM customers/);
    // no token in what the serve logged
    assert.ok(!out.includes(token.split(".")[2]!), "no token in mason serve's log");
  } finally { child.kill("SIGTERM"); await exited; await source.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
