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

export function setCookieHeader(token: string, port: number): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export interface GuardRequest {
  method: string; url: string; host?: string | undefined; origin?: string | undefined; cookie?: string | undefined;
  authorization?: string | undefined;
}

export type GuardVerdict =
  | { ok: true }
  /** the URL carried the right token: set the cookie and redirect to `location` (the same URL without it) */
  | { ok: false; status: 303; location: string; setCookie: string }
  | { ok: false; status: 403 | 421; reason: string };

/** Whether `req` may be served by the server on `port` whose run token is `token`. */
export function guard(req: GuardRequest, port: number, token: string): GuardVerdict {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
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
  if (req.method !== "GET" && req.method !== "HEAD") {
    const own = hosts.map((h) => `http://${h}`);
    if (!req.origin || !own.includes(req.origin.toLowerCase())) {
      return { ok: false, status: 403, reason: `a change must come from this page (Origin ${JSON.stringify(req.origin ?? "")})` };
    }
  }
  return { ok: true };
}

/** The headers every response of a guarded server carries. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
