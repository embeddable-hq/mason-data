/**
 * A CLIENT OF A HOSTED MASON SERVICE: the requests `mason login` and `mason logout` make, as docs/HOSTED-API.md
 * documents them (the device authorization grant of RFC 8628, a revoke of RFC 7009, and `GET /v1/me`). Nothing here
 * knows how a service is built; it speaks the documented API to the base URL it is given.
 *
 * WHERE: `MASON_CLOUD_URL`, else `DEFAULT_SERVICE_URL`, read by ONE function (`serviceOf`). HTTPS only, the certificate
 * verified (fetch's own, never turned off); plain http only to this machine (127.0.0.1, ::1, localhost), for a service
 * run beside it. A base URL with a path, a query, a fragment or a user is refused before any byte is sent.
 *
 * WHAT IS SENT: every request carries `User-Agent: mason-cli/<version>` and `Accept: application/json`, a form body
 * where one is sent, and a redirect is never followed (a Bearer header must not travel to another origin, nor https
 * fall back to http). Every request has a time limit, and an answer is read up to `MAX_BODY_BYTES`.
 *
 * WHAT COMES BACK IS UNTRUSTED: each answer is held to its documented shape, every string the CLI prints is made
 * printable and bounded (`serviceText`: no control or bidi character reaches a terminal), and the token — the one this
 * request carries, and anything shaped as a documented token — is masked in it. A `/v1/` failure is the CLI's own
 * failure shape and is said as the service worded it (`serviceFailure`), never re-worded.
 */
import * as os from "node:os";
import type { Failure, NextStep } from "./command.ts";
import { version } from "./version.ts";

/** The hosted service a login goes to when `MASON_CLOUD_URL` is unset: the one place it is named. */
export const DEFAULT_SERVICE_URL = "https://app.masondata.ai";
/** The client this CLI is to the service's OAuth endpoints. */
export const CLIENT_ID = "mason-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** How long one request may take, and how much of an answer is read. */
const REQUEST_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

/** The service as a base URL: its origin (`https://host[:port]`), the key a login is saved under. */
export interface Service { base: string }

/** The documented token shapes (docs/HOSTED-API.md), masked wherever they appear in what is printed. */
const TOKEN_SHAPE = /\bmasondata_(pat|ci)_[A-Za-z0-9_-]{43}/g;
/** The hosts plain http may name: this machine. */
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A URL the service may name, or the CLI may be pointed at: https, or http to this machine. The reason it is not one,
 * else null.
 */
export function urlProblem(u: URL): string | null {
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname) ? null : `http:// is taken only for this machine (127.0.0.1, ::1, localhost), and ${u.hostname} is not it: the login would travel unencrypted`;
  return `${u.protocol.replace(/:$/, "")}:// is not https://`;
}

/** THE SERVICE THIS COMMAND MEANS, from `MASON_CLOUD_URL` or the default; a Failure, before any byte is sent, when it is not one. */
export function serviceOf(env: NodeJS.ProcessEnv = process.env): Service | Failure {
  const raw = env.MASON_CLOUD_URL;
  if (raw === undefined) return { base: new URL(DEFAULT_SERVICE_URL).origin };
  const refuse = (message: string, why?: string): Failure => ({ message, code: "refused", ...(why ? { why } : {}),
    fix: `set MASON_CLOUD_URL to the service's address alone, such as ${DEFAULT_SERVICE_URL} (or http://127.0.0.1:<port> for one on this machine), or unset it for ${DEFAULT_SERVICE_URL}`,
    next: [["unset MASON_CLOUD_URL", `use ${DEFAULT_SERVICE_URL}`]] });
  if (raw.trim() === "") return refuse("MASON_CLOUD_URL is set, and empty");
  let u: URL;
  try { u = new URL(raw); }
  // never repeated: what is not a URL may be anything, a secret pasted in the wrong place included
  catch { return refuse("MASON_CLOUD_URL is not a URL", "it is written as https://<host>[:<port>]"); }
  if (u.username || u.password) return refuse(`MASON_CLOUD_URL carries a user or a password (${u.protocol}//****@${u.host})`, "a login is made by mason login, never written in the URL");
  const problem = urlProblem(u);
  if (problem) return refuse(`MASON_CLOUD_URL is not a URL Mason sends a login to: ${u.origin}`, problem);
  // the extra parts are named, never repeated: a query may carry a secret
  const extra = [u.pathname !== "/" ? "a path" : "", u.search ? "a query" : "", u.hash ? "a fragment" : ""].filter(Boolean);
  if (extra.length) return refuse(`MASON_CLOUD_URL has ${extra.join(" and ")} after the service's address (${u.origin})`, "it is the address alone: every path is the API's own (docs/HOSTED-API.md)");
  return { base: u.origin };
}

/**
 * TEXT FROM THE SERVICE, AS IT MAY BE PRINTED: control and bidi characters replaced (none can move a cursor, clear a
 * line or reorder what a person reads), at most `max` characters, and every secret masked — the ones named, and
 * anything shaped as a documented token.
 */
export function serviceText(s: string, max: number, secrets: readonly string[] = []): string {
  let t = s;
  for (const secret of secrets) if (secret) t = t.split(secret).join("****");
  t = t.replace(TOKEN_SHAPE, "masondata_$1_****");
  // C0 but the newline, DEL and C1; the bidi embeddings, overrides and isolates; the line and paragraph separators
  t = t.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, "?");
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : t;
}

/** This machine's name, as the service lists the login: printable, at most 64 characters. */
export function deviceName(): string {
  const name = [...serviceText(os.hostname(), 64).replace(/\n|…$/g, "")].slice(0, 64).join("").trim();
  return name || "unknown";
}

/** An answer: its status, its JSON (undefined when it is not JSON), the request that drew it. */
export interface Answer { status: number; json: unknown; what: string }

/**
 * ONE REQUEST TO THE SERVICE: `form` as an urlencoded body, `token` as a Bearer header. The answer, or a Failure when
 * none came back whole: not reached, a redirect, too large. A status is the caller's to read.
 */
export async function call(service: Service, method: "GET" | "POST", path: string, o: { form?: Record<string, string>; token?: string } = {}): Promise<Answer | Failure> {
  const what = `${method} ${path}`;
  const secrets = o.token ? [o.token] : [];
  const headers: Record<string, string> = { "User-Agent": `mason-cli/${version()}`, Accept: "application/json" };
  if (o.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let res: Response;
  try {
    res = await fetch(new URL(path, service.base), { method, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_MS),
      ...(o.form ? { body: new URLSearchParams(o.form).toString() } : {}) });
  } catch (e) {
    return { message: `could not reach ${service.base}`, code: "failed", why: serviceText(reachError(e), 300, secrets),
      fix: `check this machine is online, and that MASON_CLOUD_URL names the service (it is ${service.base})`, next: [] };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return { message: `${service.base} answered ${what} with a redirect (${res.status})`, code: "failed",
      why: "Mason follows no redirect: a login must never travel to an address it was not given", fix: "set MASON_CLOUD_URL to the service's own address" };
  }
  const body = await boundedText(res);
  if (body === null) return { message: `${service.base} answered ${what} with more than ${MAX_BODY_BYTES / 1024} KiB`, code: "failed", why: "no documented answer is that large" };
  let json: unknown;
  if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(res.headers.get("content-type") ?? "")) {
    try { json = JSON.parse(body); } catch { json = undefined; }
  }
  return { status: res.status, json, what };
}

/** Why a fetch did not get an answer, in a line: the system's code, a certificate's reason, or the time limit. */
function reachError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err.name === "TimeoutError") return `no answer within ${REQUEST_MS / 1000} s`;
  const cause = err.cause;
  if (cause?.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(cause.code)) return `its certificate could not be verified (${cause.code}): Mason sends a login only over a verified connection`;
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ""}`;
  return cause?.message ?? err.message ?? String(e);
}

/** The body as text, or null past MAX_BODY_BYTES (the rest is not read). */
async function boundedText(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    let r: Awaited<ReturnType<typeof reader.read>>;
    try { r = await reader.read(); }
    catch { return null; }   // a body cut off midway is no answer: said as one the caller cannot read
    if (r.done) break;
    size += r.value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const isFailure = (a: unknown): a is Failure => typeof a === "object" && a !== null && "message" in a && "code" in a;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An answer outside the documented shape: said by its status alone, never its body (which may carry anything). */
export function unexpected(service: Service, a: Answer, step: string): Failure {
  return { message: `${service.base} answered ${a.what} with ${a.status}${a.json === undefined ? ", not JSON" : ""}, where ${step}`, code: "failed",
    why: "the answer is not the one docs/HOSTED-API.md documents for it", fix: "try again in a moment; if it persists, this Mason may be older than the service: upgrade it" };
}

/**
 * A `/v1/` FAILURE, AS THE SERVICE WORDED IT: `{ error: { code, message, why?, fix? }, next: [{ command, what? }] }`,
 * the CLI's own failure shape, said as any Failure is (never re-worded), each string made printable and masked. Null
 * when the answer is not that shape.
 */
export function serviceFailure(a: Answer, secrets: readonly string[]): Failure | null {
  if (a.status < 400 || !obj(a.json) || !obj(a.json.error)) return null;
  const e = a.json.error;
  if (!str(e.code, 64) || !/^[a-z][a-z0-9_]*$/.test(e.code) || !str(e.message, 2000)) return null;
  const text = (v: unknown, max: number): string | undefined => typeof v === "string" && v ? serviceText(v, max, secrets) : undefined;
  const next: NextStep[] = [];
  if (Array.isArray(a.json.next)) {
    for (const n of a.json.next.slice(0, 10)) {
      if (!obj(n) || !str(n.command, 300)) return null;
      const what = text(n.what, 300);
      next.push(what ? [serviceText(n.command, 300, secrets), what] : [serviceText(n.command, 300, secrets)]);
    }
  }
  return { message: serviceText(e.message, 2000, secrets), code: e.code, why: text(e.why, 2000), fix: text(e.fix, 2000), next };
}

/** The device code the service gave: the code a person approves, where, and for how long. */
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; expiresIn: number; interval: number }

/** A URL the service names for a person to open: https (or http to this machine), as the URL parser writes it. */
function pageUrl(v: unknown): string | null {
  if (!str(v, 2048)) return null;
  try { const u = new URL(v); return urlProblem(u) === null && !u.username && !u.password ? u.href : null; } catch { return null; }
}

/** `POST /oauth/device/code`: a device code, or a Failure. */
export async function startDevice(service: Service): Promise<DeviceCode | Failure> {
  const a = await call(service, "POST", "/oauth/device/code", { form: { client_id: CLIENT_ID, device_name: deviceName() } });
  if (isFailure(a)) return a;
  if (a.status !== 200) return oauthFailure(service, a, "a sign-in was asked for", []);
  const j = a.json;
  if (!obj(j)) return unexpected(service, a, "a device code was expected");
  const userCode = typeof j.user_code === "string" ? /^([A-Za-z]{4})-?([A-Za-z]{4})$/.exec(j.user_code) : null;
  const verificationUri = pageUrl(j.verification_uri);
  const complete = j.verification_uri_complete === undefined ? null : pageUrl(j.verification_uri_complete);
  const expiresIn = j.expires_in, interval = j.interval ?? 5;
  if (!str(j.device_code, 2048) || !/^[\x21-\x7e]+$/.test(j.device_code) || !userCode || !verificationUri
    || (j.verification_uri_complete !== undefined && complete === null)
    || !Number.isInteger(expiresIn) || (expiresIn as number) < 1 || (expiresIn as number) > 3600
    || !Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 300) return unexpected(service, a, "a device code was expected");
  return { deviceCode: j.device_code, userCode: `${userCode[1]}-${userCode[2]}`, verificationUri, verificationUriComplete: complete,
    expiresIn: expiresIn as number, interval: interval as number };
}

/** One poll of `POST /oauth/token`: the token, still pending, asked to slow down, or a Failure (denied, expired, refused). */
export type Poll = { token: string } | { pending: true } | { slowDown: true } | Failure;

export async function pollToken(service: Service, code: DeviceCode): Promise<Poll> {
  const a = await call(service, "POST", "/oauth/token", { form: { grant_type: DEVICE_GRANT, device_code: code.deviceCode, client_id: CLIENT_ID } });
  if (isFailure(a)) return a;
  if (a.status === 200) {
    const j = a.json;
    // a token is opaque, but it is sent back as a header: printable ASCII, no space, bounded
    if (!obj(j) || !str(j.access_token, 4096) || !/^[\x21-\x7e]+$/.test(j.access_token) || typeof j.token_type !== "string" || j.token_type.toLowerCase() !== "bearer") {
      return unexpected(service, a, "a token was expected");
    }
    return { token: j.access_token };
  }
  const error = obj(a.json) && typeof a.json.error === "string" ? a.json.error : null;
  if (a.status === 400 && error === "authorization_pending") return { pending: true };
  if (a.status === 400 && error === "slow_down") return { slowDown: true };
  const again: NextStep[] = [["mason login", "a new code, to approve"]];
  if (a.status === 400 && error === "access_denied") {
    return { message: `the sign-in with code ${code.userCode} was denied`, code: "refused", why: "the code was refused on the service's page",
      fix: "run mason login again and approve the code it shows, signed in as the account this machine should use", next: again };
  }
  if (a.status === 400 && error === "expired_token") return expired(code);
  return oauthFailure(service, a, "the sign-in was polled", []);
}

/** The code ran out before it was approved: a timeout, its way out a new one. */
export function expired(code: DeviceCode): Failure {
  return { message: `the code ${code.userCode} expired before it was approved`, code: "timeout", why: `a code lasts ${Math.round(code.expiresIn / 60) || 1} min from mason login`,
    fix: "run mason login again, and approve the new code on the page it opens", next: [["mason login", "a new code, to approve"]] };
}

/** An OAuth endpoint's refusal (`{ error, error_description? }`, RFC 6749), or anything else it answered, as a Failure. */
function oauthFailure(service: Service, a: Answer, step: string, secrets: readonly string[]): Failure {
  const j = obj(a.json) ? a.json : null;
  if (j && str(j.error, 64) && /^[a-z_]+$/.test(j.error)) {
    return { message: `${service.base} refused this sign-in (${j.error}) when ${step}`, code: "failed",
      why: typeof j.error_description === "string" && j.error_description ? serviceText(j.error_description, 1000, secrets) : undefined,
      fix: "run mason login again; if it is refused again, this Mason may be older than the service expects: upgrade it", next: [["mason login", "try again"]] };
  }
  return unexpected(service, a, step);
}

/** Who a token signs in as: `GET /v1/me`. */
export interface Me { email: string; name: string; orgs: Array<{ slug: string; name: string; role: string }> }

export async function whoAmI(service: Service, token: string): Promise<Me | Failure> {
  const a = await call(service, "GET", "/v1/me", { token });
  if (isFailure(a)) return a;
  if (a.status !== 200) return serviceFailure(a, [token]) ?? unexpected(service, a, "the account signed in was asked for");
  const j = a.json;
  const orgs = obj(j) && Array.isArray(j.orgs) ? j.orgs : null;
  if (!obj(j) || !str(j.email, 320) || typeof j.name !== "string" || j.name.length > 300 || orgs === null || orgs.length > 1000
    || !orgs.every((o) => obj(o) && str(o.slug, 200) && typeof o.name === "string" && o.name.length <= 300 && str(o.role, 32))) {
    return unexpected(service, a, "the account signed in was asked for");
  }
  return { email: j.email, name: j.name, orgs: (orgs as Array<Record<string, string>>).map((o) => ({ slug: o.slug!, name: o.name!, role: o.role! })) };
}

/** `POST /oauth/revoke` (RFC 7009): null once the service took it, else why it did not (a revoke is best effort). */
export async function revoke(service: Service, token: string): Promise<string | null> {
  const a = await call(service, "POST", "/oauth/revoke", { form: { token, token_type_hint: "access_token", client_id: CLIENT_ID } });
  if (isFailure(a)) return serviceText(`${a.message}${a.why ? ` (${a.why})` : ""}`, 400, [token]);
  if (a.status !== 200) return `${service.base} answered ${a.what} with ${a.status}`;
  return null;
}
