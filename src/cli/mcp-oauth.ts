/**
 * `mason serve`'s MCP ENDPOINT AS AN OAUTH 2.1 RESOURCE SERVER (MCP's authorization profile; docs/DESIGN.md "An MCP
 * server over HTTPS"): its settings, and the check of a bearer token. Mason issues no token and runs no sign-in page:
 * the operator's authorization server (MASON_MCP_ISSUER) does both. Mason only checks what a client presents:
 *
 *   - THE TOKEN IS A SIGNED JWT, checked by the issuer's keys at the JWKS URL the operator names (MASON_MCP_JWKS_URL:
 *     configured, never discovered): an asymmetric `alg` alone (RS*, PS*, ES*, EdDSA), never `none` nor HS* (a public
 *     key used as an HMAC secret), a `kid` the issuer's keys hold, of the key's own type and curve, `crit` refused,
 *     `typ` a JWT's or an access token's;
 *   - ITS CLAIMS: `iss` the issuer exactly, `aud` EXACTLY this endpoint's public address (MASON_MCP_URL: the operator's
 *     setting, never an address Mason sees — a relay in front decides the address a client reaches; a list is taken only
 *     when it holds that address alone), `exp` in the future and `nbf` past, each within CLOCK_SKEW_S;
 *   - THE USER: the claim MASON_MCP_USER_CLAIM names a `mason user`, and the claim MASON_MCP_USER_ID_CLAIM holds its id
 *     (the 16 hex digits `mason user add` made, `mason user list` shows): the endpoint looks the user up by both at every
 *     request (src/cli/mcp-http.ts), so a user removed and added again — a new id — is not the old token's.
 *
 * FAIL CLOSED: keys that cannot be fetched or read: every token is refused (503 "could not tell"), never let through.
 * The keys are cached for at most KEYS_TTL_MS (5 minutes; a shorter `Cache-Control: max-age` honoured), so a key the
 * issuer removed is refused within it, and never used past it: no grace. At most MAX_KEYS. ONE fetch at a time, and at
 * most one every REFRESH_MIN_MS whatever asks — keys past their life, a `kid` they lack — backing off to BACKOFF_MAX_MS
 * while fetches fail, so a stream of tokens, made-up kids or none valid, costs the issuer one request a minute at most. Every answer of the JWKS
 * URL is untrusted: no redirect followed, bounded in size and time. A TOKEN NEVER REACHES a log line, an error or an
 * answer: what is said of one is what is wrong with it.
 *
 * Node's own `crypto` verifies every signature (a JWK read by `createPublicKey`): no dependency.
 */
import * as crypto from "node:crypto";
import { isLoopback } from "../api/postgres/plain.ts";
import { USER_NAME_RE } from "../duck/users.ts";
import { parseProxyFrom, type ProxyFrom } from "../api/postgres/proxy.ts";

// ------------------------------------------------------------------ the settings

/** The endpoint as the environment configures it. */
export interface McpSettings {
  /** MASON_MCP_URL: the endpoint's public address — what clients reach, the protected resource's identifier and the
   *  audience every token must name exactly */
  url: URL;
  /** MASON_MCP_ISSUER: the authorization server, as the tokens' `iss` names it */
  issuer: string;
  /** MASON_MCP_JWKS_URL: where its signing keys are published (a JWK set) */
  jwks: string;
  /** MASON_MCP_USER_CLAIM: the claim that names the mason user (default mason_user) */
  claim: string;
  /** MASON_MCP_USER_ID_CLAIM: the claim that holds the user's id (default mason_user_id) */
  idClaim: string;
  /** MASON_MCP_PROXY_FROM: the proxies (a relay) whose X-Forwarded-For entry is believed, or null: none, every
   *  request's address its peer's */
  proxyFrom: ProxyFrom | null;
}

/** The endpoint's settings, as `mason serve --help` lists them (one list: the checks read it). */
export const MCP_SETTINGS = ["MASON_MCP_URL", "MASON_MCP_ISSUER", "MASON_MCP_JWKS_URL", "MASON_MCP_USER_CLAIM", "MASON_MCP_USER_ID_CLAIM", "MASON_MCP_PROXY_FROM", "MASON_MCP_PLAIN"] as const;
/** the setting that names the trusted proxies, as its refusals name it */
export const MCP_PROXY_SETTING = "MASON_MCP_PROXY_FROM";

/** the path the endpoint answers on, on the health port */
export const MCP_PATH = "/mcp";
/** RFC 9728's well-known path of a protected resource's metadata */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

const CLAIM_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_URL = 2048;

/**
 * An address a setting names: https, or http to this machine alone; no user, password, query or fragment. What is
 * wrong is said in words that NEVER QUOTE THE VALUE (as `readPublicUrl` of MASON_PG_PUBLIC_URL, src/cli/pg-public-url.ts):
 * a URL pasted with a password, a key in its query or a token in its fragment — or a value that is no URL at all —
 * must not reach the start's report, which is the platform's log. A user or a password is masked as MASON_CLOUD_URL's
 * is (`https://****@host`), and nothing past the host is ever said; the secret is refused before the scheme is read.
 */
function addressProblem(setting: string, value: string): string | URL {
  const shape = "https://<host>/<path>";
  if (value.length > MAX_URL) return `${setting} is set to ${value.length} characters: an address is at most ${MAX_URL} (${shape})`;
  let u: URL;
  try { u = new URL(value); } catch { return `${setting} is set to what is not a URL: ${shape}`; }
  // what may be said of it: the scheme and the host of a web address alone (`user:password` with no `//` reads as a
  // scheme and a path, so another scheme is never said)
  const web = u.protocol === "https:" || u.protocol === "http:";
  if (u.username !== "" || u.password !== "") return `${setting} carries a user or a password${web ? ` (${u.protocol}//****@${u.host})` : ""}: an address alone, ${shape}`;
  if (u.search !== "" || u.hash !== "" || value.includes("?") || value.includes("#")) return `${setting} carries a query or a fragment${web ? ` (${u.protocol}//${u.host}/…)` : ""}: an address alone, ${shape}`;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol === "http:" && !isLoopback(host)) return `${setting} is http://${u.host}/…: https:// (http:// only to this machine, for a test)`;
  if (!web) return `${setting} is not an https:// address: ${shape}`;
  return u;
}

/**
 * THE ENDPOINT'S SETTINGS, OR EVERY ONE MISSING OR WRONG: null when none is set (the endpoint is off, the default);
 * set at all, MASON_MCP_URL, MASON_MCP_ISSUER and MASON_MCP_JWKS_URL are required — a partial configuration refuses the
 * start naming what is missing, never runs a half. `healthHost` is where the endpoint listens (MASON_HEALTH_HOST): off
 * loopback, the operator says TLS is terminated in front of it (MASON_MCP_PLAIN=1), as MASON_PG_PLAIN says it of the
 * Postgres API. MASON_MCP_PROXY_FROM is read by MASON_PG_PROXY_FROM's own reader (src/api/postgres/proxy.ts
 * `parseProxyFrom`): addresses and CIDRs, never every address.
 */
export function mcpSettings(env: Readonly<Record<string, string | undefined>>, healthHost: string): McpSettings | null | { problems: string[] } {
  const set = MCP_SETTINGS.filter((k) => (env[k] ?? "") !== "");
  if (set.length === 0) return null;
  const problems: string[] = [];
  const on = `the MCP endpoint is on (${set.join(", ")} set)`;
  const required = (k: string, what: string): URL | null => {
    const v = env[k] ?? "";
    const r = v === "" ? `${k} is not set, and ${on}: ${what}` : addressProblem(k, v);
    if (typeof r === "string") { problems.push(r); return null; }
    return r;
  };
  const url = required("MASON_MCP_URL", "the endpoint's public address, as a client reaches it through the relay in front (https://mason.example.com/mcp) — the audience every token must name");
  required("MASON_MCP_ISSUER", "the authorization server that signs the tokens, as their iss names it (https://auth.example.com)");
  const jwks = required("MASON_MCP_JWKS_URL", "where that server publishes its signing keys, a JWK set (https://auth.example.com/.well-known/jwks.json)");
  const claim = env.MASON_MCP_USER_CLAIM || "mason_user";
  if (!CLAIM_RE.test(claim)) problems.push(`MASON_MCP_USER_CLAIM=${JSON.stringify(claim.slice(0, 200))} is not a claim's name: letters, digits, _ . : / - (default mason_user)`);
  const idClaim = env.MASON_MCP_USER_ID_CLAIM || "mason_user_id";
  if (!CLAIM_RE.test(idClaim)) problems.push(`MASON_MCP_USER_ID_CLAIM=${JSON.stringify(idClaim.slice(0, 200))} is not a claim's name: letters, digits, _ . : / - (default mason_user_id)`);
  else if (idClaim === claim) problems.push(`MASON_MCP_USER_ID_CLAIM and MASON_MCP_USER_CLAIM both name ${claim}: the user's name and its id are two claims`);
  const proxy = parseProxyFrom(env[MCP_PROXY_SETTING], MCP_PROXY_SETTING);
  if (proxy !== null && "problem" in proxy) problems.push(proxy.problem);
  const plain = env.MASON_MCP_PLAIN || "0";
  if (plain !== "0" && plain !== "1") problems.push(`MASON_MCP_PLAIN=${JSON.stringify(plain.slice(0, 200))}: 1, or 0 (the default)`);
  else if (plain === "0" && !isLoopback(healthHost)) {
    problems.push(`the MCP endpoint would answer on ${healthHost} (MASON_HEALTH_HOST), off this machine, in plain HTTP, where a bearer token travels in clear: ` +
      "put a TLS proxy or relay in front of it and say so with MASON_MCP_PLAIN=1, or MASON_HEALTH_HOST=127.0.0.1 for one on this machine");
  }
  if (problems.length) return { problems };
  return { url: url!, issuer: env.MASON_MCP_ISSUER!, jwks: jwks!.href, claim, idClaim, proxyFrom: proxy === null || "problem" in proxy ? null : proxy };
}

/** The resource's metadata (RFC 9728): what a client reads to find where to sign in. */
export function resourceMetadata(s: McpSettings): Record<string, unknown> {
  return { resource: s.url.href, authorization_servers: [s.issuer], bearer_methods_supported: ["header"], resource_name: "Mason" };
}

/** Where the metadata is, as the public address says it: RFC 9728 section 3.1, the well-known path inserted before the
 *  resource's own path. */
export function resourceMetadataUrl(s: McpSettings): string {
  const p = s.url.pathname === "/" ? "" : s.url.pathname.replace(/\/$/, "");
  return `${s.url.origin}${RESOURCE_METADATA_PATH}${p}`;
}

// ------------------------------------------------------------------ the token

/** the clock skew allowed either side of `exp`, `nbf` and `iat`, in seconds */
export const CLOCK_SKEW_S = 60;
/** a bearer token past this many characters is refused unread */
export const MAX_TOKEN = 16_384;
/** the longest the issuer's keys are used before they are fetched again — a shorter `Cache-Control: max-age` of the
 *  JWKS answer is honoured, never a longer one — so a key the issuer removed is refused within this. Past it the keys
 *  are not used at all until a fetch succeeds: no grace, a fetch that fails refuses every token (503) */
export const KEYS_TTL_MS = 300_000;
/** the keys are fetched at most this often, whatever asks (keys past their life, a `kid` they lack): one fetch at a
 *  time, and the next one no sooner — the floor of a `max-age` too */
export const REFRESH_MIN_MS = 60_000;
/** while fetches fail, the wait before the next doubles from REFRESH_MIN_MS up to this */
export const BACKOFF_MAX_MS = 600_000;
/** the most keys kept of the issuer's set */
export const MAX_KEYS = 100;
/** an answer of the issuer's past this many bytes is refused */
const MAX_ANSWER = 512 * 1024;
const FETCH_MS = 5_000;

/** The algorithms a token may be signed with, and what each needs of its key. */
const ALGS: Readonly<Record<string, { kty: string; hash: string | null; pss?: true; crv?: readonly string[] }>> = {
  RS256: { kty: "RSA", hash: "sha256" }, RS384: { kty: "RSA", hash: "sha384" }, RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true }, PS384: { kty: "RSA", hash: "sha384", pss: true }, PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", crv: ["P-256"] }, ES384: { kty: "EC", hash: "sha384", crv: ["P-384"] }, ES512: { kty: "EC", hash: "sha512", crv: ["P-521"] },
  EdDSA: { kty: "OKP", hash: null, crv: ["Ed25519", "Ed448"] },
};
const TYPES = new Set(["jwt", "at+jwt", "application/at+jwt"]);

/** A token's check: the user it names, or why it is refused — 401 the token's own fault (the client signs in again),
 *  503 the check could not tell (the issuer's keys could not be read). `reason` never holds the token. */
export type TokenCheck = { user: string; id: string } | { status: 401 | 503; reason: string };

/** what fetching takes: the global fetch, or a test's */
export type Fetcher = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

interface Keys { byKid: Map<string, crypto.KeyObject & { jwk: Record<string, unknown> }>; at: number; until: number }

/** The life `Cache-Control` gives an answer, in ms: `max-age`'s, 0 for `no-store` / `no-cache`, null when it says none. */
export function cacheLife(header: string | null): number | null {
  if (header === null) return null;
  if (/(?:^|,)\s*no-(?:store|cache)\b/i.test(header)) return 0;
  const m = /(?:^|,)\s*max-age\s*=\s*"?(\d{1,10})"?\s*(?:,|$)/i.exec(header);
  return m === null ? null : Number(m[1]) * 1000;
}

const b64url = /^[A-Za-z0-9_-]+$/;

function part(text: string, what: string): Record<string, unknown> | string {
  if (!b64url.test(text)) return `its ${what} is not base64url`;
  let v: unknown;
  try { v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { return `its ${what} is not JSON`; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `its ${what} is not a JSON object`;
  return v as Record<string, unknown>;
}

/**
 * THE ISSUER, AS MASON TRUSTS IT: its keys, fetched from MASON_MCP_JWKS_URL when a token first needs them and cached; `check`
 * judges a token by them. One fetch at a time: concurrent checks share it.
 */
export class Issuer {
  private readonly settings: McpSettings;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private keys: Keys | null = null;
  private fetching: Promise<Keys | string> | null = null;
  /** when the next fetch may start: REFRESH_MIN_MS after the last one, longer while they fail (`failures`) */
  private nextFetchAt = -Infinity;
  /** fetches failed in a row */
  private failures = 0;
  private lastProblem: string | null = null;

  constructor(settings: McpSettings, o: { fetch?: Fetcher; now?: () => number; log: (line: string) => void }) {
    this.settings = settings;
    this.fetcher = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.log = o.log;
  }

  /** A bearer token judged whole: its form, its signature by the issuer's key, its claims, the user it names. */
  async check(token: string): Promise<TokenCheck> {
    const bad = (reason: string): TokenCheck => ({ status: 401, reason });
    if (token.length > MAX_TOKEN) return bad(`the token is ${token.length} characters: at most ${MAX_TOKEN}`);
    const parts = token.split(".");
    if (parts.length !== 3) return bad(parts.length === 5 ? "the token is encrypted (a JWE): Mason checks a signed JWT" : "the token is not a JWT (three parts, signed by the authorization server)");
    const [h, p, sig] = parts as [string, string, string];
    const header = part(h, "header");
    if (typeof header === "string") return bad(`the token's ${header}`);
    const alg = header.alg;
    if (typeof alg !== "string" || !Object.hasOwn(ALGS, alg)) {
      return bad(`the token's alg ${typeof alg === "string" ? JSON.stringify(alg.slice(0, 20)) : "is missing"}: Mason takes ${Object.keys(ALGS).join(", ")} (an asymmetric signature by the issuer's published key), never none nor HS*`);
    }
    if (header.crit !== undefined) return bad("the token's header names crit extensions, which Mason does not read");
    if (header.typ !== undefined && (typeof header.typ !== "string" || !TYPES.has(header.typ.toLowerCase()))) return bad("the token's typ is neither a JWT's nor an access token's (at+jwt)");
    if (typeof header.kid !== "string" || header.kid === "") return bad("the token names no key (kid): Mason checks it by the issuer's key of that kid");
    if (sig === "" || !b64url.test(sig)) return bad("the token carries no signature");
    const payload = part(p, "payload");
    if (typeof payload === "string") return bad(`the token's ${payload}`);
    // THE KEY: the issuer's, by kid; fetched again once for a kid the cache lacks, at most every REFRESH_MIN_MS
    let keys = await this.current();
    if (typeof keys === "string") return { status: 503, reason: keys };
    let key = keys.byKid.get(header.kid);
    if (key === undefined && this.now() >= this.nextFetchAt) {
      keys = await this.refresh();
      if (typeof keys === "string") return { status: 503, reason: keys };
      key = keys.byKid.get(header.kid);
    }
    if (key === undefined) return bad("the token's key (kid) is none of the issuer's published keys");
    const want = ALGS[alg]!;
    const jwk = key.jwk;
    if (jwk.kty !== want.kty || (want.crv !== undefined && !want.crv.includes(String(jwk.crv)))) return bad(`the token's alg ${alg} does not fit its key's type`);
    if (jwk.alg !== undefined && jwk.alg !== alg) return bad(`the token's alg ${alg} is not the one its key is published for`);
    // THE SIGNATURE, over the two parts as sent
    const signed = Buffer.from(`${h}.${p}`, "ascii"), signature = Buffer.from(sig, "base64url");
    let verified: boolean;
    try {
      verified = want.kty === "RSA"
        ? crypto.verify(want.hash, signed, want.pss ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : key, signature)
        : want.kty === "EC" ? crypto.verify(want.hash, signed, { key, dsaEncoding: "ieee-p1363" }, signature)
        : crypto.verify(null, signed, key, signature);
    } catch { verified = false; }
    if (!verified) return bad("the token's signature is not the issuer's");
    // THE CLAIMS
    if (payload.iss !== this.settings.issuer) return bad("the token was issued by another authorization server than MASON_MCP_ISSUER");
    // EXACTLY this endpoint: its public address, or a list of that alone (a token for this and another resource is
    // a token another resource could replay here)
    const aud = payload.aud, resource = this.settings.url.href;
    if (!(aud === resource || (Array.isArray(aud) && aud.length === 1 && aud[0] === resource))) {
      return bad(`the token is not for this endpoint: its audience (aud) must be exactly ${resource} (MASON_MCP_URL), the resource a client asks the authorization server for`);
    }
    const now = this.now() / 1000;
    if (typeof payload.exp !== "number") return bad("the token has no expiry (exp)");
    if (now >= payload.exp + CLOCK_SKEW_S) return bad("the token has expired: sign in again");
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || now < payload.nbf - CLOCK_SKEW_S)) return bad("the token is not valid yet (nbf)");
    if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_S)) return bad("the token was issued in the future (iat)");
    // THE USER
    const named = payload[this.settings.claim];
    if (typeof named !== "string" || !USER_NAME_RE.test(named)) {
      return bad(`the token's ${this.settings.claim} claim (MASON_MCP_USER_CLAIM) is ${typeof named === "string" ? "not a mason user's name" : "missing"}: the authorization server must put the mason user's name there (lower case letters, digits, _ . -)`);
    }
    const id = payload[this.settings.idClaim];
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) {
      return bad(`the token's ${this.settings.idClaim} claim (MASON_MCP_USER_ID_CLAIM) is ${typeof id === "string" ? "not a mason user's id" : "missing"}: the authorization server must put the user's id there, as mason user list shows it (16 hex digits)`);
    }
    return { user: named, id };
  }

  /** the keys to judge by: cached within their life, else fetched — or, a fetch not due yet, why there are none */
  private async current(): Promise<Keys | string> {
    if (this.keys !== null && this.now() < this.keys.until) return this.keys;
    // fail closed: keys past their life are never used again, whatever a fetch does
    this.keys = null;
    return this.refresh();
  }

  /** ONE fetch at a time, and none before `nextFetchAt`: a stream of tokens, valid or not, costs the issuer one request
   *  per REFRESH_MIN_MS at most (more apart while fetches fail); what a fetch not made answers is the keys or the problem
   *  as they stand */
  private refresh(): Promise<Keys | string> {
    if (this.fetching !== null) return this.fetching;
    if (this.now() < this.nextFetchAt) return Promise.resolve(this.keys ?? this.lastProblem ?? "its keys are not fetched yet");
    this.fetching = this.fetchKeys().then((k) => {
      if (typeof k === "string") {
        this.failures++;
        this.nextFetchAt = this.now() + Math.min(REFRESH_MIN_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
        // fail closed: keys that cannot be fetched again are not used past their life (current drops them then); the
        // ones still within it keep judging until it ends
        if (k !== this.lastProblem) this.log(`[mcp] the authorization server's keys could not be read, so every token is refused: ${k}`);
        this.lastProblem = k;
        return this.keys !== null && this.now() < this.keys.until ? this.keys : k;
      } else {
        this.failures = 0;
        // from the moment the keys were read, so their life (never under REFRESH_MIN_MS) never ends before a fetch is due
        this.nextFetchAt = k.at + REFRESH_MIN_MS;
        if (this.lastProblem !== null) this.log(`[mcp] the authorization server's keys are read again (${k.byKid.size})`);
        this.lastProblem = null;
        this.keys = k;
      }
      return k;
    }).finally(() => { this.fetching = null; });
    return this.fetching;
  }

  /** The issuer's key set, at the JWKS URL set: every answer untrusted. */
  private async fetchKeys(): Promise<Keys | string> {
    const at = this.settings.jwks;
    const got = await this.getJson(at);
    if (typeof got === "string") return `its keys (${at}, MASON_MCP_JWKS_URL): ${got}`;
    const { value: set, cacheControl } = got;
    const list = set.keys;
    if (!Array.isArray(list)) return `its keys (${this.settings.jwks}) are not a JWK set ({ "keys": [...] })`;
    const byKid = new Map<string, crypto.KeyObject & { jwk: Record<string, unknown> }>();
    for (const k of list.slice(0, MAX_KEYS)) {
      if (typeof k !== "object" || k === null || Array.isArray(k)) continue;
      const jwk = k as Record<string, unknown>;
      // a key for signatures alone, with a kid, of a type a token may use; a private part is never read
      if (typeof jwk.kid !== "string" || jwk.kid === "" || (jwk.use !== undefined && jwk.use !== "sig") || !["RSA", "EC", "OKP"].includes(String(jwk.kty))) continue;
      const pub: Record<string, unknown> = { kty: jwk.kty };
      for (const f of ["n", "e", "crv", "x", "y"]) if (typeof jwk[f] === "string") pub[f] = jwk[f];
      let key: crypto.KeyObject;
      try { key = crypto.createPublicKey({ key: pub as crypto.JsonWebKey, format: "jwk" }); } catch { continue; }
      // an RSA key under 2048 bits signs nothing Mason believes
      if (key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      byKid.set(jwk.kid, Object.assign(key, { jwk: { ...pub, ...(typeof jwk.alg === "string" ? { alg: jwk.alg } : {}) } }));
    }
    if (byKid.size === 0) return `its keys (${this.settings.jwks}) hold no signing key Mason can read (RSA of 2048 bits or more, EC, or Ed25519 / Ed448, each with a kid)`;
    // the answer's own life when shorter than KEYS_TTL_MS, never under REFRESH_MIN_MS (no fetch is made sooner anyway)
    const life = Math.max(REFRESH_MIN_MS, Math.min(KEYS_TTL_MS, cacheLife(cacheControl) ?? KEYS_TTL_MS));
    const fetchedAt = this.now();
    return { byKid, at: fetchedAt, until: fetchedAt + life };
  }

  /** One GET of a JSON object: no redirect followed, at most MAX_ANSWER bytes, within FETCH_MS; why not, as text. */
  private async getJson(url: string): Promise<{ value: Record<string, unknown>; cacheControl: string | null } | string> {
    let res: Response;
    try { res = await this.fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_MS), headers: { accept: "application/json" } }); }
    catch (e) { return `could not be fetched (${(e as Error).name === "TimeoutError" ? `no answer in ${FETCH_MS / 1000} s` : (e as Error).message})`; }
    if (res.status !== 200) { await res.body?.cancel(); return `answered HTTP ${res.status}${res.status >= 300 && res.status < 400 ? " (a redirect, which Mason does not follow)" : ""}`; }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const c of res.body ?? []) {
        size += (c as Uint8Array).length;
        // leaving the loop cancels the stream (its iterator's return)
        if (size > MAX_ANSWER) return `answered more than ${MAX_ANSWER} bytes`;
        chunks.push(c as Uint8Array);
      }
    } catch (e) { return `could not be read (${(e as Error).message})`; }
    let v: unknown;
    try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return "answered what is not JSON"; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "answered what is not a JSON object";
    return { value: v as Record<string, unknown>, cacheControl: res.headers.get("cache-control") };
  }
}
