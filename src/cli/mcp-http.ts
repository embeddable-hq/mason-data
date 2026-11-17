/**
 * `mason serve`'s MCP ENDPOINT: `mason mcp`'s tools over MCP's Streamable HTTP transport, for a hosted agent that
 * cannot start a process (docs/DESIGN.md "An MCP server over HTTPS"). On the health port (MASON_HEALTH_PORT), beside
 * /healthz: `POST /mcp` (a JSON-RPC message, answered as JSON), `DELETE /mcp` (a session ended), and the protected
 * resource's metadata at `/.well-known/oauth-protected-resource` (RFC 9728), a relay in front forwarding all of them.
 *
 *   - EVERY REQUEST TO /mcp CARRIES A BEARER TOKEN of the operator's authorization server (src/cli/mcp-oauth.ts), or is
 *     answered 401 with `WWW-Authenticate` naming the metadata, so a client finds where to sign in. The token names a
 *     `mason user` (MASON_MCP_USER_CLAIM): one that does not exist, is disabled, or (MASON_MCP_FROM=client, the default)
 *     may not connect from the client's address, is refused 403 with what to do. Mason issues no token.
 *   - THE SAME SESSION CODE AS `mason mcp` (src/cli/mcp.ts `McpServer`): an MCP session is one McpServer, its messages
 *     handed to it whole; a cancellation (`notifications/cancelled`, a POST of its own) reaches the statement as over
 *     stdio. Its statements reach the run's own listener through a door of their own (src/api/postgres/server.ts
 *     `openLocal`): on loopback, as the token's user, each connection beginning with a PROXY header naming the HTTP
 *     client, so the listener judges the user, its role, its limits and (by MASON_MCP_FROM) its ranges as for any
 *     session, and the request log names the user, `mason-mcp/<client>` and the client's address. The door takes a
 *     secret this process alone holds, never a user's password: no other process logs in there.
 *   - MASON_MCP_FROM=token replaces a user's address check with the endpoint's own authorization, FOR A REQUEST THAT
 *     CARRIES A VALID TOKEN ALONE (one without is a 401 before anything else is read), and on this door alone: the
 *     Postgres API's own listener and every other route judge as before.
 *   - A SESSION is bound to the user whose token opened it: another user's token naming it is told it does not exist.
 *     At most MAX_SESSIONS, each ended after IDLE_MS unused (the oldest idle making way).
 *
 * Nothing the endpoint says or logs carries a token. A refusal's words are said in the log with the client's address.
 */
import * as crypto from "node:crypto";
import type * as http from "node:http";
import { PgConnection } from "../cdc/pg-wire.ts";
import { proxyHeaderFor, shownAddress } from "../api/postgres/proxy.ts";
import { ADDRESS_NOT_ALLOWED, ApiError, USER_DISABLED } from "../api/error.ts";
import type { PgApiServer, ShareSocket } from "../api/postgres/server.ts";
import type { LiveUsers } from "../duck/users.ts";
import { McpServer, PROTOCOL_VERSIONS } from "./mcp.ts";
import { Issuer, MCP_PATH, RESOURCE_METADATA_PATH, resourceMetadata, resourceMetadataUrl, type Fetcher, type McpSettings } from "./mcp-oauth.ts";

/** the most MCP sessions open at once */
export const MAX_SESSIONS = 1000;
/** a session unused this long is ended */
export const IDLE_MS = 3_600_000;
/** the largest message body read */
export const MAX_BODY = 1024 * 1024;

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

interface Session { id: string; user: string; server: McpServer; usedAt: number; address: string }

/** A refusal's body, in the CLI's failure words: what is wrong, the way out. */
const body = (code: string, message: string, fix: string): string => `${JSON.stringify({ error: { code, message, fix } })}\n`;

/** A quoted-string of an auth-param (RFC 9110): printable ASCII, no quote or backslash. */
const quoted = (s: string): string => s.replace(/[^\x20-\x7e]|["\\]/g, "'");

export function mcpEndpoint(settings: McpSettings, o: { log: (line: string) => void; fetch?: Fetcher; now?: () => number }): McpEndpoint {
  const log = o.log;
  const now = o.now ?? Date.now;
  const issuer = new Issuer(settings, { log, ...(o.fetch !== undefined ? { fetch: o.fetch } : {}), now });
  const metadataUrl = resourceMetadataUrl(settings);
  // the metadata at RFC 9728's path for the public address's own path, at the well-known root, and for /mcp: a relay
  // forwards the one its address makes
  const publicPath = settings.url.pathname === "/" ? "" : settings.url.pathname.replace(/\/$/, "");
  const metadataPaths = new Set([RESOURCE_METADATA_PATH, `${RESOURCE_METADATA_PATH}${publicPath}`, `${RESOURCE_METADATA_PATH}${MCP_PATH}`]);
  const sessions = new Map<string, Session>();
  /** what only this process knows: the door's password */
  const secret = crypto.randomBytes(32).toString("base64url");
  const secretHash = crypto.createHash("sha256").update(secret).digest();
  let run: (McpRun & { door: ShareSocket }) | null = null;
  let closed = false;
  const judgeRanges = settings.from === "client";

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

  /** The request's bearer token checked, then its user: the user's name, or the request already answered. */
  async function authorize(req: http.IncomingMessage, res: http.ServerResponse, address: string): Promise<string | null> {
    const auth = req.headers.authorization;
    const m = typeof auth === "string" ? /^Bearer +([^\s]+) *$/i.exec(auth) : null;
    if (m === null) { unauthorized(res, address, auth === undefined ? null : "the Authorization header is not Bearer <token>"); return null; }
    const checked = await issuer.check(m[1]!);
    if ("status" in checked) {
      if (checked.status === 503) {
        log(`[mcp] refused a request from ${address}: its token could not be checked: ${checked.reason}`);
        send(res, 503, { "retry-after": "30" }, body("unchecked", "the token could not be checked: Mason could not read the authorization server's keys",
          "try again shortly; mason serve's log says why (MASON_MCP_ISSUER)"));
        return null;
      }
      unauthorized(res, address, checked.reason);
      return null;
    }
    if (run === null) return checked.user;
    // the user as the users file has it now. The client holds a valid token of the operator's issuer, so it is told
    // which it is (no such user, disabled, its address): the listener's own refusals make them alike for a stranger
    try { run.users.vouched(checked.user, address, judgeRanges); }
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
          `mason user from ${u} <ranges> adds the client's address (a hosted agent connects from its vendor's servers), or MASON_MCP_FROM=token lets this endpoint's own authorization replace the check for its requests`);
      } else forbidden(res, address, "invalid_user", `the token names the mason user ${u}, which this Mason does not have${ae !== null && !/^no user/.test(ae.message) ? ` (${ae.message})` : ""}`,
        `mason user add ${u}, beside mason serve, makes it; or the authorization server puts another user's name in the ${settings.claim} claim (MASON_MCP_USER_CLAIM)`);
      return null;
    }
    return checked.user;
  }

  /** A connection to the listener's door for one session: as its user, the HTTP client's address in a PROXY header. */
  const connectFor = (s: Session) => async (applicationName: string): Promise<PgConnection> => {
    if (run === null) throw new Error("Mason is not answering yet");
    const header = proxyHeaderFor(s.address);
    if (header === null) throw new Error(`the client's address ${s.address} could not be read`);
    return PgConnection.connect({ host: "127.0.0.1", port: run.door.port, database: run.database, user: s.user, password: secret, sslmode: "disable",
      applicationName, connectTimeoutMs: 10_000, textForms: [], proxyHeader: header });
  };

  function endSession(s: Session, why: string): void {
    if (sessions.get(s.id) !== s) return;
    sessions.delete(s.id);
    s.server.cancelAll(`ended: ${why}`);
  }

  function newSession(user: string, address: string): Session {
    // the oldest idle makes way at the bound; a session unused past IDLE_MS ends
    for (const s of [...sessions.values()]) if (now() - s.usedAt > IDLE_MS) endSession(s, "idle");
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.usedAt - b.usedAt)[0]!;
      endSession(oldest, "made way for a new session");
    }
    const s: Session = { id: crypto.randomBytes(24).toString("base64url"), user, server: null as unknown as McpServer, usedAt: now(), address };
    s.server = new McpServer({ connect: connectFor(s), where: "this Mason" }, (l) => log(`[mcp] ${user}: ${l}`));
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

  async function serveMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const address = shownAddress(req.socket.remoteAddress) ?? "an address that could not be read";
    const user = await authorize(req, res, address);
    if (user === null) return;
    if (run === null || closed) { send(res, 503, { "retry-after": "5" }, body("starting", "Mason is not answering yet", "try again once mason serve's /healthz says ready")); return; }
    if (proxyHeaderFor(address) === null) { forbidden(res, address, "address_unreadable", "the client's address could not be read", "connect again"); return; }
    const sid = req.headers["mcp-session-id"];
    const asked = typeof sid === "string" ? sessions.get(sid) : undefined;
    // another user's session is no session of this one's: told as one that does not exist
    const session = asked !== undefined && asked.user === user ? asked : undefined;
    if (req.method === "DELETE") {
      if (session === undefined) { send(res, 404, {}, body("no_session", "no such MCP session", "initialize a new one")); return; }
      endSession(session, "closed by the client");
      send(res, 204, {});
      return;
    }
    if (req.method !== "POST") { send(res, 405, { allow: "POST, DELETE" }, body("method", `${req.method} is not served: this endpoint answers each POST with JSON, and sends nothing of its own`, "POST a JSON-RPC message")); return; }
    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && !PROTOCOL_VERSIONS.includes(version as never)) {
      send(res, 400, {}, body("protocol_version", `MCP-Protocol-Version ${JSON.stringify(version.slice(0, 40))} is not one this server speaks`, `one of ${PROTOCOL_VERSIONS.join(", ")}`));
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
    const isInit = messages.some((m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize");
    let s: Session;
    if (isInit) {
      if (messages.length !== 1) { send(res, 400, {}, body("initialize", "initialize is sent alone", "POST initialize by itself")); return; }
      s = newSession(user, address);
    } else if (typeof sid !== "string") {
      send(res, 400, {}, body("no_session", "no Mcp-Session-Id: a request belongs to the session initialize opened", "initialize first, and send the Mcp-Session-Id it answered with"));
      return;
    } else if (session === undefined) {
      send(res, 404, {}, body("no_session", "no such MCP session (it ended, or this Mason restarted)", "initialize a new one"));
      return;
    } else s = session;
    s.usedAt = now();
    s.address = address;
    const requests = messages.some((m) => typeof m === "object" && m !== null && "method" in m && "id" in m);
    const answer = await s.server.handle(text);
    if (isInit && (typeof answer !== "object" || answer === null || !("result" in answer))) endSession(s, "its initialize failed");
    const headers = { ...(sessions.has(s.id) ? { "mcp-session-id": s.id } : {}) };
    // notifications and responses alone: accepted, no body; a request the client cancelled is answered no further
    if (!requests || answer === null) { send(res, 202, headers); return; }
    send(res, 200, headers, JSON.stringify(answer));
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
      serveMcp(req, res).catch((e: unknown) => {
        log(`[mcp] a request failed: ${(e as Error).message}`);
        if (!res.headersSent) send(res, 500, {}, body("failed", "the request failed", "mason serve's log says why"));
        else res.destroy();
      });
      return true;
    },
    async attach(r) {
      const door = await r.listener.openLocal({
        who: "MCP over HTTPS",
        loginHint: "this socket is mason serve's MCP endpoint's alone",
        authenticate: (password, name, from) => {
          const given = crypto.createHash("sha256").update(password).digest();
          if (!crypto.timingSafeEqual(given, secretHash)) throw new Error("not the MCP endpoint's own connection");
          return r.users.vouched(name, from, judgeRanges);
        },
        recheck: async (token, from) => r.users.recheck(token, from, judgeRanges),
      });
      run = { ...r, door };
    },
    async close() {
      closed = true;
      for (const s of [...sessions.values()]) endSession(s, "mason serve stopping");
      await run?.door.close();
    },
  };
}
