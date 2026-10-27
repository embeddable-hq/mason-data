/**
 * THE PROTOTYPE'S TOKEN (decision 5 of the prototype's design): `mason connect` minted it locally until `mason user add`
 * replaced it, and the tests and an operator holding the API key still can — an HMAC-SHA256 over its expiry,
 * keyed by the project's API key (`.mason/config.json` `apiKey`) — and the Postgres listener's `authenticate` verifies
 * it. Unrestricted only: no scope, no service tokens, no revocation but rotating the API key. `mason_<expiry>_<mac>`:
 * the expiry in seconds since the epoch, the MAC base64url.
 */
import * as crypto from "node:crypto";

const PREFIX = "mason";
/** a day, as the interactive tokens of the ClickHouse stack's Query API were */
export const MAX_TOKEN_SECONDS = 86_400;

const mac = (apiKey: string, expiry: number): string =>
  crypto.createHmac("sha256", apiKey).update(`mason-duckdb-postgres:${expiry}`).digest("base64url");

export function mintToken(apiKey: string, seconds: number, now = Date.now()): { token: string; expiresAt: string } {
  const expiry = Math.floor(now / 1000) + seconds;
  return { token: `${PREFIX}_${expiry}_${mac(apiKey, expiry)}`, expiresAt: new Date(expiry * 1000).toISOString() };
}

/** null when the token is good; else why not, in a sentence a person reads after "password authentication failed" */
export function tokenProblem(apiKey: string, token: string, now = Date.now()): string | null {
  if (token === apiKey) return "the API key is not a password here: mason user add <name> makes a user whose password does not expire";
  const m = /^mason_(\d{1,12})_([A-Za-z0-9_-]{43})$/.exec(token);
  if (m === null) return "not a Mason user's password or token: mason user add <name> makes a user whose password does not expire";
  const expiry = Number(m[1]);
  const want = Buffer.from(mac(apiKey, expiry)), got = Buffer.from(m[2]!);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return "not a password or token of this project (or its API key was rotated): mason user add <name> makes a user whose password does not expire";
  if (expiry * 1000 <= now) return `the token expired at ${new Date(expiry * 1000).toISOString()}: mason user add <name> makes a user whose password does not expire`;
  return null;
}
