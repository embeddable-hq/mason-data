/**
 * ONE ROW OF THE REQUEST LOG, as the Postgres listener builds it (src/api/postgres/server.ts `recordRequest`) and the
 * run's ledger keeps it (src/duck/requests.ts, `_mason.requests`): every statement answered or refused, and every
 * refused login. The helpers here say who asked without keeping the credential (`hashCaller`), cap the statement
 * (`storedPayload`) and name an outcome from its SQLSTATE (`outcomeOf`), read by the listener's refusal line and the
 * ledger alike.
 */

import * as crypto from "node:crypto";

/** Fail closed on the storage side: never let one request bloat the ledger. */
export const MAX_STORED_PAYLOAD_BYTES = 64 * 1024;

export interface ApiLogRow {
  requestId: string;
  at: Date;
  /** QUERY (a simple Query's statement), PARSE, BIND, EXECUTE, CONNECT … */
  method: string;
  /** 200 answered; 400 a refusal, 401 a refused login, 503 could not tell, 500 Mason's failure */
  status: number;
  durationMs: number;
  /** the caller's credential, hashed (`hashCaller`) */
  caller?: string | undefined;
  /** `postgres:<application_name>` (`postgres:unnamed` for none) */
  client?: string | undefined;
  /** the statement as the tool sent it, capped (`storedPayload`) */
  payload?: string | undefined;
  payloadTruncated?: boolean | undefined;
  /** the refusal's message */
  error?: string | undefined;
  /** a named token's name: the listener sets none, and the ledger keeps its column (src/duck/requests.ts) */
  tokenName?: string | undefined;
  /** A `mason user`'s name (src/duck/users.ts): the user a session logged in as, or the one a refused login asked for */
  user?: string | undefined;
  /** the role the session read as (src/duck/grants.ts), when its user carries one */
  role?: string | undefined;
  /** the session's number, the SQLSTATE, DETAIL and HINT a refusal was sent with, and the rows an answer sent */
  session?: number | undefined;
  sqlstate?: string | undefined;
  detail?: string | undefined;
  hint?: string | undefined;
  rows?: number | undefined;
  /** the copied tables' JSON paths the statement read by literal steps (src/duck/kept-route.ts readKey): what decides
   *  the paths Mason stores (src/duck/kept.ts) */
  jsonReads?: readonly string[] | undefined;
}

/**
 * A Postgres-listener statement's outcome in a word, from the SQLSTATE it was sent: `failed` where the fault is Mason's
 * or the machine's (classes XX internal, 53 resources, 57 a timeout or a cancel, 58 system), `refused` for the
 * statement's own, `ok` for none. Read by the listener's refusal line (server.ts `refusalLine`) and the request log
 * (src/duck/requests.ts) alike.
 */
export function outcomeOf(sqlstate: string | null | undefined): "ok" | "refused" | "failed" {
  if (sqlstate === null || sqlstate === undefined || sqlstate === "") return "ok";
  return /^(XX|53|57|58)/.test(sqlstate) ? "failed" : "refused";
}

/**
 * The caller's identity WITHOUT the credential: a truncated SHA-256 of what was presented. Distinct callers stay
 * distinguishable and repeat callers stay correlatable, while the secret itself is never written down — the log must
 * not become a place where a leaked table hands over working credentials.
 *
 * Truncation to 16 hex characters (64 bits) is deliberate: enough that two real callers will not collide, short enough
 * that the column stays cheap, and far too short to brute-force a high-entropy key back out of.
 */
export function hashCaller(presented: string | null): string {
  if (presented === null || presented === "") return "";
  return crypto.createHash("sha256").update(presented).digest("hex").slice(0, 16);
}

/**
 * The statement as it arrived, capped. Stored whole, not redacted: the statements most worth having are the ones that
 * FAILED, and a normalised one tells nothing about what actually arrived. The cap is a storage bound, not a privacy
 * one, and `payloadTruncated` says plainly when a row is not the whole story.
 */
export function storedPayload(body: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(body, "utf8");
  if (buf.byteLength <= MAX_STORED_PAYLOAD_BYTES) return { text: body, truncated: false };
  // Slice on a character boundary: a half-written UTF-8 sequence would be
  // stored as a replacement character and misread as corruption in the source.
  return {
    text: buf.subarray(0, MAX_STORED_PAYLOAD_BYTES).toString("utf8"),
    truncated: true,
  };
}
