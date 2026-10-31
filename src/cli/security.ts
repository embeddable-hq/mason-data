/**
 * THE LOCAL SERVERS' GUARD (security comes first here). `mason start` serves the command server
 * on the developer's machine, which reads the database and WRITES the sources file of a folder for the `mason`
 * commands, and its web page (`mason ui`, src/web/), whose users section adds and removes the project's users. Any
 * website the developer visits can make their browser send requests to 127.0.0.1, so each request must prove it comes
 * from the run itself (a command) or from a page the run served:
 *
 *   - LOOPBACK ONLY: the servers bind 127.0.0.1.
 *   - A TOKEN: 32 random bytes, made per run and printed in the URL `mason ui` opens. The first request trades it
 *     for an HttpOnly, SameSite=Strict cookie and is redirected to a URL without it; every request after needs the
 *     cookie. A page on another site cannot read it, and SameSite=Strict keeps the browser from sending it on a
 *     request another site starts.
 *   - THE HOST HEADER must name this server (127.0.0.1:<port> or localhost:<port>): a DNS-rebinding page reaches
 *     127.0.0.1 under its own name, and is refused by that name.
 *   - THE ORIGIN of every request that changes something (anything but GET / HEAD) must be this server's own: a
 *     cross-site form or fetch carries the other site's origin.
 *   - No CORS headers, `frame-ancestors 'none'` (no other page may frame these), and `Referrer-Policy: no-referrer`
 *     (the token URL never leaks as a referrer).
 *
 * THE COMMAND LINE (`mason status`, `mason add`, …; src/cli/control.ts) sends the same token as `Authorization: Bearer`,
 * read from the run's settings file, which only the developer can read (0600 in a 0700 folder). It needs no cookie and
 * no Origin: a browser sends an Authorization header across sites only after a CORS preflight, which these servers
 * never approve, so a page on another site cannot send one at all.
 *
 * A browser keeps cookies per host, never per port, so the cookie is NAMED for the run's port (`cookieName`,
 * `mason_dev_<port>`): two runs on one machine each keep their own, and opening one's page never logs the other's out
 * (one name for every run did). A page of another run, or one the token does not match, is refused. Pure over the request's headers, so the refusals are unit-tested
 * (tests/cli-security.test.ts).
 *
 * THROUGH A TUNNEL (`mason ui --ssh`, src/cli/ui-ssh.ts): the browser is on another machine, on a local port of its own,
 * so its Host is 127.0.0.1:<that port>. The guard never takes any other Host: a tunnel is a `PageTunnel`, opened by a
 * process holding the run's token (`POST /api/ui/tunnel`) and gone with that process's connection, and only the loopback
 * names at ITS port are added, for as long as it lasts. A DNS-rebinding page still names itself, and is refused by that
 * name. The run's token never crosses: the laptop gets a TICKET, one use and minutes old, because the URL a browser is
 * opened at is on a command line; the first request trades it for a cookie holding the tunnel's own SESSION, named for
 * the laptop's port, which dies with the tunnel. So nothing that reaches the laptop outlives it. The tunnel itself is raw
 * TCP to this server, so a client chooses its path by the Host it sends: Bearer is refused by a tunnel's Host, and by the
 * server's own Host it is the commands' path, which needs the token, which never crosses.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** The cookie of the run whose server is on `port`: one per run, as a browser shares a host's cookies across ports. */
export const cookieName = (port: number): string => `mason_dev_${port}`;

export function newToken(): string { return randomBytes(32).toString("hex"); }

/** Constant-time string equality (a token compared byte by byte leaks its prefix through timing). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** How long a tunnel's ticket can be traded: a person with `--no-open` pastes it; nobody needs it longer. */
export const TICKET_MS = 5 * 60_000;

/** One tunnel to the page: the port its browser names, its one-use ticket (null once traded), and the cookie's value. */
export interface PageTunnel { port: number; ticket: string | null; ticketUntil: number; session: string }

export function newTunnel(port: number, now = Date.now()): PageTunnel {
  return { port, ticket: newToken(), ticketUntil: now + TICKET_MS, session: newToken() };
}

export function setCookieHeader(token: string, port: number): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export interface GuardRequest {
  method: string; url: string; host?: string | undefined; origin?: string | undefined; cookie?: string | undefined;
  authorization?: string | undefined;
}

export type GuardVerdict =
  | { ok: true }
  /** the URL carried the right token: set the cookie and redirect to `location` (the same URL without it); no
   *  `setCookie`: a ticket used already, by a browser that holds its cookie */
  | { ok: false; status: 303; location: string; setCookie?: string }
  | { ok: false; status: 403 | 421; reason: string };

/** The Host a browser may send for a loopback port: its two names, that port, and nothing else. */
const loopbackHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

/** A change must come from the page at `hosts`: its Origin is one of them. */
function foreignOrigin(req: GuardRequest, hosts: readonly string[]): GuardVerdict | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (req.origin && hosts.map((h) => `http://${h}`).includes(req.origin.toLowerCase())) return null;
  return { ok: false, status: 403, reason: `a change must come from this page (Origin ${JSON.stringify(req.origin ?? "")})` };
}

/** A request by the Host of a tunnel's port (the header says why it is its own path): a ticket, or the session's cookie. */
function throughTunnel(req: GuardRequest, tunnels: readonly PageTunnel[], now: number): GuardVerdict {
  const port = tunnels[0]!.port;
  if (req.authorization !== undefined) return { ok: false, status: 403, reason: "a tunnel carries a browser, never a command: the run's token is not sent through one" };
  const cookie = cookieOf(req.cookie, cookieName(port));
  const held = cookie !== null && tunnels.some((t) => sameSecret(t.session, cookie));
  const url = new URL(req.url, "http://tunnel");
  const offered = url.searchParams.get("ticket");
  if (offered !== null && (req.method === "GET" || req.method === "HEAD")) {
    url.searchParams.delete("ticket");
    const location = url.pathname + (url.search || "") + url.hash;
    const t = tunnels.find((x) => x.ticket !== null && now < x.ticketUntil && sameSecret(x.ticket, offered));
    if (t !== undefined) { t.ticket = null; return { ok: false, status: 303, location, setCookie: setCookieHeader(t.session, port) }; }
    if (held) return { ok: false, status: 303, location };
    return { ok: false, status: 403, reason: "this ticket was used already, or is too old: mason ui --ssh gives a new one" };
  }
  if (!held) return { ok: false, status: 403, reason: "this tunnel's page takes its ticket or its cookie: mason ui --ssh opens it" };
  return foreignOrigin(req, loopbackHosts(port)) ?? { ok: true };
}

/** Whether `req` may be served by the server on `port` whose run token is `token`, `tunnels` the ones open now. */
export function guard(req: GuardRequest, port: number, token: string, tunnels: readonly PageTunnel[] = [], now = Date.now()): GuardVerdict {
  const hosts = loopbackHosts(port);
  const through = tunnels.filter((t) => loopbackHosts(t.port).includes((req.host ?? "").toLowerCase()));
  if (through.length > 0 && !hosts.includes((req.host ?? "").toLowerCase())) return throughTunnel(req, through, now);
  if (!req.host || !hosts.includes(req.host.toLowerCase())) {
    return { ok: false, status: 421, reason: `this server answers only as ${hosts[0]} (the request named ${JSON.stringify(req.host ?? "")})` };
  }
  if (req.authorization !== undefined) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.authorization)?.[1];
    return bearer !== undefined && sameSecret(bearer, token) ? { ok: true }
      : { ok: false, status: 403, reason: "the Authorization header does not carry this run's token" };
  }
  const url = new URL(req.url, `http://${req.host}`);
  const offered = url.searchParams.get("token");
  if (offered !== null) {
    if (!sameSecret(offered, token)) return { ok: false, status: 403, reason: "the token in the URL is not this run's" };
    url.searchParams.delete("token");
    return { ok: false, status: 303, location: url.pathname + (url.search || "") + url.hash, setCookie: setCookieHeader(token, port) };
  }
  const cookie = cookieOf(req.cookie, cookieName(port));
  if (cookie === null || !sameSecret(cookie, token)) {
    return { ok: false, status: 403, reason: "this is mason start's command server for the mason command: a request carries the run's token (Authorization: Bearer, from .mason/config.json)" };
  }
  return foreignOrigin(req, hosts) ?? { ok: true };
}

/** The headers every response of a guarded server carries. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
