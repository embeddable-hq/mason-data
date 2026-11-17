/**
 * `mason serve`'s MCP ENDPOINT: `mason mcp`'s tools over MCP's Streamable HTTP transport, for a hosted agent that
 * cannot start a process (docs/DESIGN.md "An MCP server over HTTPS"). On the port `mason serve` already listens on
 * (MASON_HEALTH_PORT), beside /healthz: `POST /mcp` (a JSON-RPC message, answered as JSON), `DELETE /mcp` (a session
 * ended), and the protected resource's metadata at `/.well-known/oauth-protected-resource` (RFC 9728).
 *
 *   - TWO REVISIONS OF THE PROTOCOL, by the version the client asks for (`initialize`'s protocolVersion, else the
 *     MCP-Protocol-Version header): 2025-11-25 (and the older ones), with a session (`Mcp-Session-Id`) that
 *     `initialize` opens; and 2026-07-28, which has none — each POST stands alone, as its user, and a cancellation of
 *     one is a POST of its own that names its request id.
 *   - EVERY REQUEST TO /mcp CARRIES A BEARER TOKEN of the operator's authorization server (src/cli/mcp-oauth.ts), or is
 *     answered 401 with `WWW-Authenticate` naming the metadata at the PUBLIC address (MASON_MCP_URL). The token names a
 *     `mason user` and its id, LOOKED UP AT EVERY REQUEST (`LiveUsers.vouched`): one that does not exist, whose id is not
 *     the name's user's now (removed, and the name added again), that is disabled, or that may not connect from the
 *     client's address, is refused 403 with what to do. Mason issues no token.
 *   - THE CLIENT'S ADDRESS is the peer's, or — from a proxy MASON_MCP_PROXY_FROM names, alone — the LAST entry of
 *     X-Forwarded-For, the one that proxy appended (`forwardedClient`): never an earlier entry, which the client wrote. A
 *     header from any other peer is ignored, and the peer judged; a named proxy's request without one is refused. A
 *     user's "connects from" ranges are judged on that address, here and by the listener.
 *   - THE SAME SESSION CODE AS `mason mcp` (src/cli/mcp.ts `McpServer`), its messages handed to it whole; a cancellation
 *     (`notifications/cancelled`) reaches the statement as over stdio. Its statements reach the run's own listener through
 *     a door of their own (src/api/postgres/server.ts `openLocal`): on loopback, each connection beginning with a PROXY
 *     header naming the client's address, its password a secret this process alone holds and the user's id, so the
 *     listener judges the user, its role, its limits and its ranges at login and before every statement, and the
 *     request log names the user, `mason-mcp/<client>` and the client's address. No other process logs in there.
 *   - A SESSION is bound to the user and id whose token opened it: another's token naming it is told it does not exist.
 *     At most MAX_USER_SESSIONS a user (its own oldest idle making way) and MAX_SESSIONS in all (one unused past
 *     EVICTABLE_IDLE_MS making way, else refused: a session in use is never ended for another user's), each ended
 *     after IDLE_MS unused.
 *
 * Nothing the endpoint says or logs carries a token. A refusal's words are said in the log with the client's address.
 */
import * as crypto from "node:crypto";
import type * as http from "node:http";
import { PgConnection } from "../cdc/pg-wire.ts";
import { shownAddress } from "../lib/cidr.ts";
import { proxyHeaderFor, proxyNames, type ProxyFrom } from "../api/postgres/proxy.ts";
import { ADDRESS_NOT_ALLOWED, ApiError, USER_DISABLED } from "../api/error.ts";
import type { PgApiServer, ShareSocket } from "../api/postgres/server.ts";
import { USER_REMOVED, type LiveUsers } from "../duck/users.ts";
import { McpServer } from "./mcp.ts";
import { Issuer, MCP_PATH, MCP_PROXY_SETTING, RESOURCE_METADATA_PATH, resourceMetadata, resourceMetadataUrl, type Fetcher, type McpSettings } from "./mcp-oauth.ts";

/** the most MCP sessions open at once, every user's together: past it a new session is refused (503), never made by
 *  ending another user's session that is in use */
export const MAX_SESSIONS = 1000;
/** the most MCP sessions one user (by name and id) holds at once: past it the user's own oldest idle session makes way,
 *  or, every one of them running a request, the new one is refused (429) — one user never ends another's */
export const MAX_USER_SESSIONS = 32;
/** a session unused this long is ended */
export const IDLE_MS = 3_600_000;
/** at MAX_SESSIONS, a session unused this long, running nothing, may make way for another user's new one: it is
 *  abandoned in all but name (a client that still holds it opens a new one at its 404) */
export const EVICTABLE_IDLE_MS = 600_000;
/** the most /mcp JSON-RPC requests answered at once, every user's together: past it 503 with Retry-After (a notification
 *  — a cancellation — and a DELETE are never held to it). Far under the health port's connection cap (serve.ts
 *  HEALTH_LIMITS), so /mcp's running requests alone never hold every connection /healthz needs */
export const MAX_REQUESTS = 256;
/** the largest message body read */
export const MAX_BODY = 1024 * 1024;
/** the revision with no session: each POST stands alone */
export const STATELESS_VERSION = "2026-07-28";
/** the revisions this endpoint speaks, the one a client asking for none is answered with first */
export const HTTP_VERSIONS = ["2025-11-25", STATELESS_VERSION, "2025-06-18", "2025-03-26"] as const;
/** the header that carries the client's address through a proxy MASON_MCP_PROXY_FROM names */
export const FORWARDED_HEADER = "x-forwarded-for";

/** What the endpoint reaches once the run answers: its listener, its users and the database a tool names. */
export interface McpRun {
  listener: Pick<PgApiServer, "openLocal">;
  users: LiveUsers;
  database: string;
}

export interface McpEndpoint {
  /** answers the request when its path is the endpoint's (/mcp, the metadata); false for any other path */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  /** the run answers: /mcp serves from now on (503 before) */
  attach(run: McpRun): Promise<void>;
  /** every session ended, its statements cancelled, the door closed */
  close(): Promise<void>;
  readonly settings: McpSettings;
  /** the listener's door this endpoint's sessions connect through, on loopback (null before `attach`) */
  readonly doorPort: number | null;
}

/** Who a request is: the token's user and id, and the client's address (`clientOf`). */
interface Who { user: string; id: string; address: string }

interface Session { id: string; user: string; userId: string; server: McpServer; usedAt: number; address: string; running: number }

/**
 * THE CLIENT'S ADDRESS OF A REQUEST: the peer's, or behind a proxy `proxyFrom` names the LAST entry of its
 * X-Forwarded-For — the one THAT proxy appended; every entry before it is what came to the proxy, which the client can
 * write. A header from a peer `proxyFrom` does not name is ignored (the peer is the client). A named proxy that sends
 * none, or a last entry that is not one address, is refused (`{ refused }`): it could not tell.
 */
export function clientOf(peerRaw: string | undefined, forwarded: string | string[] | undefined, proxyFrom: ProxyFrom | null): { address: string } | { refused: string } {
  const peer = shownAddress(peerRaw);
  if (peer === null) return { refused: "the connection's address could not be read" };
  if (proxyFrom === null || !proxyNames(proxyFrom, peer)) return { address: peer };
  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  const last = header?.split(",").pop()?.trim() ?? "";
  if (last === "") return { refused: `the proxy ${peer} (${MCP_PROXY_SETTING}) sent no X-Forwarded-For: it must append the client's address to every request` };
  const shown = forwardedAddress(last);
  return shown === null ? { refused: `the last X-Forwarded-For entry the proxy ${peer} (${MCP_PROXY_SETTING}) sent is not one address` } : { address: shown };
}

/**
 * One X-Forwarded-For entry as the one address it names, as Mason shows one (`shownAddress`: a v4-mapped IPv6 address,
 * `::ffff:203.0.113.7`, IS that IPv4 client — nginx on a dual-stack `[::]` listener writes it so), or null. A port a relay
 * writes beside it is dropped: `203.0.113.7:51234`, and IPv6 in brackets, `[2001:db8::1]:443` (or `[2001:db8::1]`
 * alone). A bare IPv6 address is read whole (`2001:db8::1:443` is an address, never one with a port). Anything that is
 * not one address — a CIDR, a name, `unknown`, a zone, a leading zero, a port past 65535 — is null.
 */
export function forwardedAddress(entry: string): string | null {
  const port = (p: string | undefined): boolean => p === undefined || (/^\d{1,5}$/.test(p) && Number(p) <= 65_535);
  const bracketed = /^\[([^\]]+)\](?::([^:]*))?$/.exec(entry);
  if (bracketed !== null) return port(bracketed[2]) && bracketed[1]!.includes(":") ? shownAddress(bracketed[1]) : null;
  const v4 = /^(\d+\.\d+\.\d+\.\d+):([^:]*)$/.exec(entry);
  if (v4 !== null) return port(v4[2]) ? shownAddress(v4[1]) : null;
  return shownAddress(entry);
}

/** A refusal's body, in the CLI's failure words: what is wrong, the way out. */
const body = (code: string, message: string, fix: string): string => `${JSON.stringify({ error: { code, message, fix } })}\n`;

/** A quoted-string of an auth-param (RFC 9110): printable ASCII, no quote or backslash. */
const quoted = (s: string): string => s.replace(/[^\x20-\x7e]|["\\]/g, "'");

/** A JSON-RPC message's method and whether it is a request (an id with a method), for what is read before it is handled. */
const methodOf = (m: unknown): string | null => typeof m === "object" && m !== null && typeof (m as { method?: unknown }).method === "string" ? (m as { method: string }).method : null;

export function mcpEndpoint(settings: McpSettings, o: { log: (line: string) => void; fetch?: Fetcher; now?: () => number;
  /** the bounds, MAX_SESSIONS, MAX_USER_SESSIONS and MAX_REQUESTS unless a test names smaller */
  limits?: { sessions?: number; userSessions?: number; requests?: number } }): McpEndpoint {
  const maxSessions = o.limits?.sessions ?? MAX_SESSIONS, maxUserSessions = o.limits?.userSessions ?? MAX_USER_SESSIONS, maxRequests = o.limits?.requests ?? MAX_REQUESTS;
  const log = o.log;
  const now = o.now ?? Date.now;
  const issuer = new Issuer(settings, { log, ...(o.fetch !== undefined ? { fetch: o.fetch } : {}), now });
  const metadataUrl = resourceMetadataUrl(settings);
  // the metadata at RFC 9728's path for the public address's own path, at the well-known root, and for /mcp: a relay
  // forwards the one its address makes
  const publicPath = settings.url.pathname === "/" ? "" : settings.url.pathname.replace(/\/$/, "");
  const metadataPaths = new Set([RESOURCE_METADATA_PATH, `${RESOURCE_METADATA_PATH}${publicPath}`, `${RESOURCE_METADATA_PATH}${MCP_PATH}`]);
  const sessions = new Map<string, Session>();
  /** the requests of the stateless revision being answered, by user and id: a cancellation is a POST of its own */
  const standing = new Map<string, Set<McpServer>>();
  /** what only this process knows: the door's password, beside the user's id */
  const secret = crypto.randomBytes(32).toString("base64url");
  const secretHash = crypto.createHash("sha256").update(secret).digest();
  let run: (McpRun & { door: ShareSocket }) | null = null;
  let closed = false;
  /** /mcp requests being answered now (MAX_REQUESTS) */
  let inFlight = 0;

  const send = (res: http.ServerResponse, status: number, headers: Record<string, string>, text?: string): void => {
    res.writeHead(status, { "cache-control": "no-store", ...(text !== undefined ? { "content-type": "application/json" } : {}), ...headers }).end(text);
  };

  /** 401: no token, or one that is refused; `WWW-Authenticate` names the metadata, and the token's fault when it had one */
  const unauthorized = (res: http.ServerResponse, address: string, reason: string | null): void => {
    log(`[mcp] refused a request from ${address}: ${reason ?? "no bearer token"}`);
    const challenge = `Bearer resource_metadata="${quoted(metadataUrl)}"${reason === null ? "" : `, error="invalid_token", error_description="${quoted(reason)}"`}`;
    send(res, 401, { "www-authenticate": challenge }, body("unauthorized", reason ?? "this endpoint takes a bearer token of its authorization server",
      reason === null ? `sign in at ${settings.issuer} (an MCP client finds it from ${metadataUrl}) and send Authorization: Bearer <the access token>`
        : "sign in again at the authorization server, for this endpoint's address as the resource"));
  };

  /** 403: a valid token whose user may not use the endpoint, said with what to do about it */
  const forbidden = (res: http.ServerResponse, address: string, code: string, message: string, fix: string): void => {
    log(`[mcp] refused a request from ${address}: ${message}`);
    send(res, 403, {}, body(code, message, fix));
  };

  /** The request's client, its bearer token, then its user as the users file has it NOW: who it is, or answered already. */
  async function authorize(req: http.IncomingMessage, res: http.ServerResponse): Promise<Who | null> {
    const client = clientOf(req.socket.remoteAddress, req.headers[FORWARDED_HEADER], settings.proxyFrom);
    const peer = shownAddress(req.socket.remoteAddress) ?? "an address that could not be read";
    if ("refused" in client) {
      log(`[mcp] refused a request from ${peer}: ${client.refused}`);
      send(res, 400, {}, body("address_unreadable", client.refused, `the proxy in front (${MCP_PROXY_SETTING}) appends the client's address to X-Forwarded-For on every request`));
      return null;
    }
    const address = client.address;
    const auth = req.headers.authorization;
    const m = typeof auth === "string" ? /^Bearer +([^\s]+) *$/i.exec(auth) : null;
    if (m === null) { unauthorized(res, address, auth === undefined ? null : "the Authorization header is not Bearer <token>"); return null; }
    const checked = await issuer.check(m[1]!);
    if ("status" in checked) {
      if (checked.status === 503) {
        log(`[mcp] refused a request from ${address}: its token could not be checked: ${checked.reason}`);
        send(res, 503, { "retry-after": "30" }, body("unchecked", "the token could not be checked: Mason could not read the authorization server's keys",
          "try again shortly; mason serve's log says why (MASON_MCP_JWKS_URL)"));
        return null;
      }
      unauthorized(res, address, checked.reason);
      return null;
    }
    const who = { user: checked.user, id: checked.id, address };
    if (run === null) return who;
    // the user as the users file has it now, at every request (never for the token's life). The client holds a valid
    // token of the operator's issuer, so it is told which refusal it is: the listener's make them alike for a stranger
    try { run.users.vouched(checked.user, checked.id, address); }
    catch (e) {
      const ae = e instanceof ApiError ? e : null;
      if (ae?.status === 503) {
        log(`[mcp] refused a request from ${address}: ${ae.message}`);
        send(res, 503, { "retry-after": "30" }, body("users_unreadable", "Mason could not read its list of users", "try again shortly; mason serve's log says why"));
        return null;
      }
      const u = checked.user;
      if (ae?.code === USER_DISABLED) forbidden(res, address, "user_disabled", `the mason user ${u} is disabled`, `mason user enable ${u}, beside mason serve, lets it connect again`);
      else if (ae?.code === ADDRESS_NOT_ALLOWED) {
        forbidden(res, address, ADDRESS_NOT_ALLOWED, `the mason user ${u} may not connect from ${address}, outside its address ranges`,
          `mason user from ${u} <ranges> adds the client's address (a hosted agent connects from its vendor's published ranges: the Users page's Connects from offers them); behind a relay, ${MCP_PROXY_SETTING} names it so its X-Forwarded-For is read`);
      } else if (ae?.code === USER_REMOVED) {
        forbidden(res, address, "user_removed", `the token was issued for the mason user ${u} with the id ${checked.id}, which was removed: the name is another user's now`,
          `sign in again, so the authorization server issues a token for the user ${u} as it is now (mason user list shows its id)`);
      } else forbidden(res, address, "invalid_user", `the token names the mason user ${u}, which this Mason does not have (removed, or never added)${ae !== null && !/^no user/.test(ae.message) ? `: ${ae.message}` : ""}`,
        `mason user add ${u}, beside mason serve, makes it, and the authorization server signs its id in; or it puts another user's name in the ${settings.claim} claim (MASON_MCP_USER_CLAIM)`);
      return null;
    }
    return who;
  }

  /** A connection to the listener's door: as the user and its id, the client's address in a PROXY header. */
  const connectAs = (who: () => Who) => async (applicationName: string): Promise<PgConnection> => {
    if (run === null) throw new Error("Mason is not answering yet");
    const w = who();
    const header = proxyHeaderFor(w.address);
    if (header === null) throw new Error(`the client's address ${w.address} could not be read`);
    return PgConnection.connect({ host: "127.0.0.1", port: run.door.port, database: run.database, user: w.user, password: `${secret}.${w.id}`, sslmode: "disable",
      applicationName, connectTimeoutMs: 10_000, textForms: [], proxyHeader: header });
  };

  function endSession(s: Session, why: string): void {
    if (sessions.get(s.id) !== s) return;
    sessions.delete(s.id);
    s.server.cancelAll(`ended: ${why}`);
  }

  /** the least recently used of `of` that runs no request and was unused at least `idleMs`, or undefined */
  const oldestIdle = (of: Iterable<Session>, idleMs: number): Session | undefined =>
    [...of].filter((s) => s.running === 0 && now() - s.usedAt >= idleMs).sort((a, b) => a.usedAt - b.usedAt)[0];

  /**
   * A new session for `who`, or why not. A session unused past IDLE_MS ends. The user's own bound first: at
   * MAX_USER_SESSIONS its own oldest session running nothing makes way, else it is refused (429). Then everyone's: at
   * MAX_SESSIONS the oldest session unused past EVICTABLE_IDLE_MS and running nothing makes way, whoever's, else it is
   * refused (503): a session in use is never ended for another user's.
   */
  function newSession(who: Who): Session | { status: 429 | 503; message: string; fix: string } {
    for (const s of [...sessions.values()]) if (now() - s.usedAt > IDLE_MS) endSession(s, "idle");
    const own = [...sessions.values()].filter((s) => s.user === who.user && s.userId === who.id);
    if (own.length >= maxUserSessions) {
      const mine = oldestIdle(own, 0);
      if (mine === undefined) return { status: 429, message: `the mason user ${who.user} holds ${own.length} MCP sessions, each running a request: at most ${maxUserSessions}`, fix: "end one (DELETE /mcp with its Mcp-Session-Id), or wait for one to answer" };
      endSession(mine, "made way for a new session of its user");
      log(`[mcp] ${mine.user}: its oldest idle session ended: it made way for a new session of its user (at most ${maxUserSessions})`);
    }
    if (sessions.size >= maxSessions) {
      const idle = oldestIdle(sessions.values(), EVICTABLE_IDLE_MS);
      if (idle === undefined) return { status: 503, message: `this Mason holds ${sessions.size} MCP sessions in use, its most`, fix: "try again shortly, or use MCP-Protocol-Version: 2026-07-28, which opens no session" };
      endSession(idle, `made way for a new session: unused ${Math.round(EVICTABLE_IDLE_MS / 60_000)} minutes or more`);
      log(`[mcp] ${idle.user}: a session unused ${Math.round(EVICTABLE_IDLE_MS / 60_000)} minutes or more ended: it made way for a new session (at most ${maxSessions} in all)`);
    }
    const s: Session = { id: crypto.randomBytes(24).toString("base64url"), user: who.user, userId: who.id, server: null as unknown as McpServer, usedAt: now(), address: who.address, running: 0 };
    s.server = new McpServer({ connect: connectAs(() => ({ user: s.user, id: s.userId, address: s.address })), where: "this Mason" }, (l) => log(`[mcp] ${who.user}: ${l}`), HTTP_VERSIONS);
    sessions.set(s.id, s);
    return s;
  }

  async function readBody(req: http.IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** The stateless revision's request: an McpServer of its own, as its user; a cancellation reaches the user's others. */
  async function standalone(who: Who, text: string, messages: unknown[], req: http.IncomingMessage): Promise<unknown> {
    const key = `${who.user}:${who.id}`;
    const others = standing.get(key);
    if (messages.every((m) => methodOf(m) === "notifications/cancelled")) {
      for (const server of others ?? []) await server.handle(text);
      return null;
    }
    const server = new McpServer({ connect: connectAs(() => who), where: "this Mason" }, (l) => log(`[mcp] ${who.user}: ${l}`), HTTP_VERSIONS);
    // no initialize names the client here: its User-Agent's first word does (initialize, when sent, names it instead)
    server.named(String(req.headers["user-agent"] ?? "").split(/[\s/]/)[0] ?? null);
    const set = others ?? new Set<McpServer>();
    set.add(server);
    standing.set(key, set);
    try { return await server.handle(text); }
    finally { set.delete(server); if (set.size === 0) standing.delete(key); }
  }

  /** `slot.held`: this request counts against MAX_REQUESTS (a JSON-RPC request, read and authorized), freed when it ends */
  async function serveMcp(req: http.IncomingMessage, res: http.ServerResponse, slot: { held: boolean }): Promise<void> {
    const who = await authorize(req, res);
    if (who === null) return;
    if (run === null || closed) { send(res, 503, { "retry-after": "5" }, body("starting", "Mason is not answering yet", "try again once mason serve's /healthz says ready")); return; }
    if (proxyHeaderFor(who.address) === null) { forbidden(res, who.address, "address_unreadable", "the client's address could not be read", "connect again"); return; }
    const sid = req.headers["mcp-session-id"];
    const asked = typeof sid === "string" ? sessions.get(sid) : undefined;
    // another user's session (or the same name's, removed and added again) is no session of this one's
    const session = asked !== undefined && asked.user === who.user && asked.userId === who.id ? asked : undefined;
    if (req.method === "DELETE") {
      if (session === undefined) { send(res, 404, {}, body("no_session", "no such MCP session", "initialize a new one")); return; }
      endSession(session, "closed by the client");
      send(res, 204, {});
      return;
    }
    if (req.method !== "POST") { send(res, 405, { allow: "POST, DELETE" }, body("method", `${req.method} is not served: this endpoint answers each POST with JSON, and sends nothing of its own`, "POST a JSON-RPC message")); return; }
    const header = req.headers["mcp-protocol-version"];
    if (typeof header === "string" && !HTTP_VERSIONS.includes(header as never)) {
      send(res, 400, {}, body("protocol_version", `MCP-Protocol-Version ${JSON.stringify(header.slice(0, 40))} is not one this server speaks`, `one of ${HTTP_VERSIONS.join(", ")}`));
      return;
    }
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") { send(res, 415, {}, body("content_type", "a message is application/json", "send Content-Type: application/json")); return; }
    const text = await readBody(req);
    if (text === null) { send(res, 413, {}, body("too_large", `a message of more than ${MAX_BODY} bytes`, "send a smaller one")); return; }
    let msg: unknown;
    try { msg = JSON.parse(text); }
    catch { send(res, 400, {}, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON: one JSON-RPC message a POST" } })); return; }
    const messages = Array.isArray(msg) ? msg : [msg];
    const requests = messages.some((m) => typeof m === "object" && m !== null && "method" in m && "id" in m);
    const init = messages.find((m) => methodOf(m) === "initialize") as { params?: { protocolVersion?: unknown } } | undefined;
    // THE REVISION: the one initialize asks for, else the header's (a request after initialize carries it)
    const version = init !== undefined ? (typeof init.params?.protocolVersion === "string" ? init.params.protocolVersion : null) : header ?? null;
    const reply = (answer: unknown, headers: Record<string, string> = {}): void => {
      // notifications and responses alone: accepted, no body; a request the client cancelled is answered no further
      if (!requests || answer === null) { send(res, 202, headers); return; }
      send(res, 200, headers, JSON.stringify(answer));
    };
    if (init !== undefined && messages.length !== 1) { send(res, 400, {}, body("initialize", "initialize is sent alone", "POST initialize by itself")); return; }
    // the bound on what runs at once counts requests alone: a cancellation, a notification or a DELETE always gets
    // through, or a client at the bound could not stop what holds it there
    if (requests) {
      if (inFlight >= maxRequests) {
        send(res, 503, { "retry-after": "5" }, body("busy", `this Mason answers ${maxRequests} MCP requests at once, its most`, "try again shortly"));
        return;
      }
      inFlight++;
      slot.held = true;
    }
    if (version === STATELESS_VERSION && session === undefined) { reply(await standalone(who, text, messages, req)); return; }
    let s: Session;
    if (init !== undefined) {
      const made = newSession(who);
      if (!("id" in made)) {
        log(`[mcp] refused a new session of ${who.user} from ${who.address}: ${made.message}`);
        send(res, made.status, { "retry-after": "30" }, body("too_many_sessions", made.message, made.fix));
        return;
      }
      s = made;
    } else if (typeof sid !== "string") {
      send(res, 400, {}, body("no_session", `no Mcp-Session-Id: under ${HTTP_VERSIONS[0]} a request belongs to the session initialize opened`,
        `initialize first, and send the Mcp-Session-Id it answered with (or MCP-Protocol-Version: ${STATELESS_VERSION}, which has no session)`));
      return;
    } else if (session === undefined) {
      send(res, 404, {}, body("no_session", "no such MCP session (it ended, or this Mason restarted)", "initialize a new one"));
      return;
    } else s = session;
    s.usedAt = now();
    s.address = who.address;
    s.running++;
    let answer: unknown;
    try { answer = await s.server.handle(text); }
    finally { s.running--; s.usedAt = now(); }
    if (init !== undefined && (typeof answer !== "object" || answer === null || !("result" in answer))) endSession(s, "its initialize failed");
    reply(answer, sessions.has(s.id) ? { "mcp-session-id": s.id } : {});
  }

  return {
    settings,
    get doorPort() { return run?.door.port ?? null; },
    handle(req, res) {
      const p = (req.url ?? "/").split("?")[0]!;
      if (metadataPaths.has(p)) {
        if (req.method !== "GET" && req.method !== "HEAD") { send(res, 405, { allow: "GET, HEAD" }); return true; }
        send(res, 200, {}, req.method === "HEAD" ? undefined : `${JSON.stringify(resourceMetadata(settings))}\n`);
        return true;
      }
      if (p !== MCP_PATH) return false;
      const slot = { held: false };
      serveMcp(req, res, slot).catch((e: unknown) => {
        log(`[mcp] a request failed: ${(e as Error).message}`);
        if (!res.headersSent) send(res, 500, {}, body("failed", "the request failed", "mason serve's log says why"));
        else res.destroy();
      }).finally(() => { if (slot.held) inFlight--; });
      return true;
    },
    async attach(r) {
      const door = await r.listener.openLocal({
        who: "MCP over HTTPS",
        loginHint: "this socket is mason serve's MCP endpoint's alone",
        authenticate: (password, name, from) => {
          // <the door's secret>.<the user's id>: the secret compared in constant time, the user looked up by name and id
          const dot = password.lastIndexOf(".");
          const given = crypto.createHash("sha256").update(dot < 0 ? password : password.slice(0, dot)).digest();
          if (!crypto.timingSafeEqual(given, secretHash) || dot < 0) throw new Error("not the MCP endpoint's own connection");
          return r.users.vouched(name, password.slice(dot + 1), from);
        },
        recheck: async (token, from) => r.users.recheck(token, from),
      });
      run = { ...r, door };
    },
    async close() {
      closed = true;
      for (const s of [...sessions.values()]) endSession(s, "mason serve stopping");
      for (const set of standing.values()) for (const server of set) server.cancelAll("ended: mason serve stopping");
      await run?.door.close();
    },
  };
}
