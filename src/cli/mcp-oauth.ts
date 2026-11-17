/**
 * `mason serve`'s MCP ENDPOINT AS AN OAUTH 2.1 RESOURCE SERVER (MCP's authorization profile; docs/DESIGN.md "An MCP
 * server over HTTPS"): its settings, and the check of a bearer token. Mason issues no token and runs no sign-in page:
 * the operator's authorization server (MASON_MCP_ISSUER) does both. Mason only checks what a client presents:
 *
 *   - THE TOKEN IS A SIGNED JWT, checked by the issuer's published keys (its metadata's `jwks_uri`, found by RFC 8414 /
 *     OpenID discovery from the issuer, whose metadata must name the same issuer): an asymmetric `alg` alone (RS*, PS*,
 *     ES*, EdDSA), never `none` nor HS* (a public key used as an HMAC secret), a `kid` the issuer's keys hold, of the
 *     key's own type and curve, `crit` refused, `typ` a JWT's or an access token's;
 *   - ITS CLAIMS: `iss` the issuer exactly, `aud` naming THIS endpoint's public address (MASON_MCP_URL: the operator's
 *     setting, never an address Mason sees — a relay in front decides the address a client reaches), `exp` in the
 *     future and `nbf` past, each within CLOCK_SKEW_S;
 *   - THE USER: the claim MASON_MCP_USER_CLAIM names (default `sub`), a `mason user`'s name.
 *
 * FAIL CLOSED: keys that cannot be fetched, metadata that names another issuer, a key that cannot be read: every token
 * is refused (503 "could not tell"), never let through. The keys are cached (KEYS_TTL_MS), at most MAX_KEYS, and
 * fetched again for a `kid` they do not hold at most once every REFRESH_MIN_MS, so a stream of tokens with made-up
 * kids costs the issuer one request a minute. Every answer of the issuer is untrusted: no redirect followed, bounded in
 * size and time. A TOKEN NEVER REACHES a log line, an error or an answer: what is said of one is what is wrong with it.
 *
 * Node's own `crypto` verifies every signature (a JWK read by `createPublicKey`): no dependency.
 */
import * as crypto from "node:crypto";
import { isLoopback } from "../api/postgres/plain.ts";
import { USER_NAME_RE } from "../duck/users.ts";

// ------------------------------------------------------------------ the settings

/** How a user's "connects from" ranges apply to the endpoint's requests (MASON_MCP_FROM). */
export type McpFrom = "client" | "token";

/** The endpoint as the environment configures it. */
export interface McpSettings {
  /** MASON_MCP_URL: the endpoint's public address — what clients reach, the protected resource's identifier and the
   *  audience every token must name */
  url: URL;
  /** MASON_MCP_ISSUER: the authorization server, as its metadata's `issuer` says it */
  issuer: string;
  /** MASON_MCP_USER_CLAIM: the claim that names the mason user (default sub) */
  claim: string;
  /** MASON_MCP_FROM: client (the default) judges a user's ranges on the HTTP client's address; token lets the endpoint's
   *  own authorization replace them, for a request with a valid token alone */
  from: McpFrom;
}

/** The endpoint's settings, each with its default, as `mason serve --help` lists them (one list: the check reads it). */
export const MCP_SETTINGS = ["MASON_MCP_URL", "MASON_MCP_ISSUER", "MASON_MCP_USER_CLAIM", "MASON_MCP_FROM", "MASON_MCP_PLAIN"] as const;

/** the path the endpoint answers on, on the health port */
export const MCP_PATH = "/mcp";
/** RFC 9728's well-known path of a protected resource's metadata */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

const CLAIM_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_URL = 2048;

/** An address a setting names: https, or http to this machine alone; no user, password, query or fragment. */
function addressProblem(setting: string, value: string): string | URL {
  const quoted = `${setting}=${JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value)}`;
  if (value.length > MAX_URL) return `${quoted} is ${value.length} characters: at most ${MAX_URL}`;
  let u: URL;
  try { u = new URL(value); } catch { return `${quoted} is not a URL: https://<host>/<path>`; }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(host))) return `${quoted}: https:// (http:// only to this machine, for a test)`;
  if (u.username !== "" || u.password !== "") return `${quoted} carries a user or a password: an address alone`;
  if (u.search !== "" || u.hash !== "" || value.includes("?") || value.includes("#")) return `${quoted} carries a query or a fragment: an address alone`;
  return u;
}

/**
 * THE ENDPOINT'S SETTINGS, OR EVERY ONE MISSING OR WRONG: null when none is set (the endpoint is off, the default);
 * set at all, MASON_MCP_URL and MASON_MCP_ISSUER are required — a partial configuration refuses the start with what
 * is missing, never runs a half. `healthHost` is where the endpoint listens (MASON_HEALTH_HOST): off loopback, the
 * operator says TLS is terminated in front of it (MASON_MCP_PLAIN=1), as MASON_PG_PLAIN says it of the Postgres API.
 */
export function mcpSettings(env: Readonly<Record<string, string | undefined>>, healthHost: string): McpSettings | null | { problems: string[] } {
  const set = MCP_SETTINGS.filter((k) => (env[k] ?? "") !== "");
  if (set.length === 0) return null;
  const problems: string[] = [];
  const on = `the MCP endpoint is on (${set.join(", ")} set)`;
  const urlText = env.MASON_MCP_URL ?? "";
  const url = urlText === "" ? `MASON_MCP_URL is not set, and ${on}: the endpoint's public address, as a client reaches it (https://mason.example.com/mcp) — the audience every token must name` : addressProblem("MASON_MCP_URL", urlText);
  if (typeof url === "string") problems.push(url);
  const issuerText = env.MASON_MCP_ISSUER ?? "";
  const issuer = issuerText === "" ? `MASON_MCP_ISSUER is not set, and ${on}: the authorization server that signs the tokens, as its metadata's issuer says it (https://auth.example.com)` : addressProblem("MASON_MCP_ISSUER", issuerText);
  if (typeof issuer === "string") problems.push(issuer);
  const claim = env.MASON_MCP_USER_CLAIM || "sub";
  if (!CLAIM_RE.test(claim)) problems.push(`MASON_MCP_USER_CLAIM=${JSON.stringify(claim.slice(0, 200))} is not a claim's name: letters, digits, _ . : / - (default sub)`);
  const from = env.MASON_MCP_FROM || "client";
  if (from !== "client" && from !== "token") problems.push(`MASON_MCP_FROM=${JSON.stringify(from.slice(0, 200))}: client (a user's address ranges judged on the HTTP client's address, the default) or token (the endpoint's own authorization in their place, for its requests alone)`);
  const plain = env.MASON_MCP_PLAIN || "0";
  if (plain !== "0" && plain !== "1") problems.push(`MASON_MCP_PLAIN=${JSON.stringify(plain.slice(0, 200))}: 1, or 0 (the default)`);
  else if (plain === "0" && !isLoopback(healthHost)) {
    problems.push(`the MCP endpoint would answer on ${healthHost} (MASON_HEALTH_HOST), off this machine, in plain HTTP, where a bearer token travels in clear: ` +
      "put a TLS proxy or relay in front of it and say so with MASON_MCP_PLAIN=1, or MASON_HEALTH_HOST=127.0.0.1 for one on this machine");
  }
  if (problems.length) return { problems };
  return { url: url as URL, issuer: issuerText, claim, from: from as McpFrom };
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
/** how long the issuer's keys are used before they are fetched again */
export const KEYS_TTL_MS = 3_600_000;
/** a `kid` the keys lack fetches them again at most this often */
export const REFRESH_MIN_MS = 60_000;
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
export type TokenCheck = { user: string; subject: string | null } | { status: 401 | 503; reason: string };

/** what fetching takes: the global fetch, or a test's */
export type Fetcher = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

interface Keys { byKid: Map<string, crypto.KeyObject & { jwk: Record<string, unknown> }>; at: number }

const b64url = /^[A-Za-z0-9_-]+$/;

function part(text: string, what: string): Record<string, unknown> | string {
  if (!b64url.test(text)) return `its ${what} is not base64url`;
  let v: unknown;
  try { v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { return `its ${what} is not JSON`; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `its ${what} is not a JSON object`;
  return v as Record<string, unknown>;
}

/**
 * THE ISSUER, AS MASON TRUSTS IT: its metadata and keys, fetched when a token first needs them and cached; `check`
 * judges a token by them. One fetch at a time: concurrent checks share it.
 */
export class Issuer {
  private readonly settings: McpSettings;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private keys: Keys | null = null;
  private jwksUri: string | null = null;
  private fetching: Promise<Keys | string> | null = null;
  /** when the keys were last asked for (successfully or not): the rate a `kid` they lack may ask again */
  private askedAt = -Infinity;
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
    if (key === undefined && this.now() - this.askedAt >= REFRESH_MIN_MS) {
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
    const aud = payload.aud, resource = this.settings.url.href;
    if (!(aud === resource || (Array.isArray(aud) && aud.includes(resource)))) {
      return bad(`the token is not for this endpoint: its audience (aud) must name ${resource} (MASON_MCP_URL), the resource a client asks the authorization server for`);
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
    return { user: named, subject: typeof payload.sub === "string" ? payload.sub.slice(0, 200) : null };
  }

  /** the keys to judge by: cached, else (past KEYS_TTL_MS, or none yet) fetched */
  private async current(): Promise<Keys | string> {
    if (this.keys !== null && this.now() - this.keys.at < KEYS_TTL_MS) return this.keys;
    return this.refresh();
  }

  private refresh(): Promise<Keys | string> {
    if (this.fetching !== null) return this.fetching;
    this.askedAt = this.now();
    this.fetching = this.fetchKeys().then((k) => {
      if (typeof k === "string") {
        // fail closed: keys that cannot be fetched again are not used past their time
        this.keys = null;
        if (k !== this.lastProblem) this.log(`[mcp] the authorization server's keys could not be read, so every token is refused: ${k}`);
        this.lastProblem = k;
      } else {
        if (this.lastProblem !== null) this.log(`[mcp] the authorization server's keys are read again (${k.byKid.size})`);
        this.lastProblem = null;
        this.keys = k;
      }
      return k;
    }).finally(() => { this.fetching = null; });
    return this.fetching;
  }

  /** The issuer's metadata (once found), then its key set: every answer untrusted. */
  private async fetchKeys(): Promise<Keys | string> {
    if (this.jwksUri === null) {
      const found = await this.discover();
      if (typeof found === "string") return found;
      this.jwksUri = found.jwks;
    }
    const set = await this.getJson(this.jwksUri);
    if (typeof set === "string") return `its keys (${this.jwksUri}): ${set}`;
    const list = set.keys;
    if (!Array.isArray(list)) return `its keys (${this.jwksUri}) are not a JWK set ({ "keys": [...] })`;
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
    if (byKid.size === 0) return `its keys (${this.jwksUri}) hold no signing key Mason can read (RSA of 2048 bits or more, EC, or Ed25519 / Ed448, each with a kid)`;
    return { byKid, at: this.now() };
  }

  /** Where the issuer's keys are: RFC 8414's metadata, else OpenID Connect's, whose `issuer` must be the one set. */
  private async discover(): Promise<{ jwks: string } | string> {
    const u = new URL(this.settings.issuer);
    const p = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const tried = [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`,
      ...(p !== "" ? [`${u.origin}${p}/.well-known/openid-configuration`] : [])];
    const why: string[] = [];
    for (const at of tried) {
      const m = await this.getJson(at);
      if (typeof m === "string") { why.push(`${at}: ${m}`); continue; }
      if (m.issuer !== this.settings.issuer) return `its metadata (${at}) names another issuer than MASON_MCP_ISSUER (${this.settings.issuer}): set MASON_MCP_ISSUER to the issuer it names, exactly`;
      const jwks = typeof m.jwks_uri === "string" ? addressProblem("its jwks_uri", m.jwks_uri) : "it names no jwks_uri";
      if (typeof jwks === "string") return `its metadata (${at}): ${jwks}`;
      return { jwks: jwks.href };
    }
    return `no metadata found for ${this.settings.issuer} (${why.join("; ")})`;
  }

  /** One GET of a JSON object: no redirect followed, at most MAX_ANSWER bytes, within FETCH_MS; why not, as text. */
  private async getJson(url: string): Promise<Record<string, unknown> | string> {
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
    return v as Record<string, unknown>;
  }
}
