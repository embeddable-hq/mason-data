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
  /** the registry entry (src/duck/gaps.ts) that refused the statement, from the refusal itself (StatementError.gap):
   *  absent for an answer and for any other refusal (a missing table, a syntax error) */
  gap?: string | undefined;
  /** the copied tables' JSON paths the statement read by literal steps (src/duck/kept-route.ts readKey): what decides
   *  the paths Mason stores (src/duck/kept.ts) */
  jsonReads?: readonly string[] | undefined;
  /** the bytes the listener sent the session for this statement: from its message's arrival to its last frame (its
   *  rows, its CommandComplete or ErrorResponse) — what it cost to send; absent where nothing was counted */
  bytesSent?: number | undefined;
}

/** The SQLSTATE of a cancelled statement: a CancelRequest, `mason cancel`, or a statement_timeout (Postgres's 57014). */
export const CANCELLED_SQLSTATE = "57014";
/** The SQLSTATE classes whose fault is Mason's or the machine's: XX internal, 53 resources, 57 an operator's, 58 system. */
export const FAILED_CLASSES = ["XX", "53", "57", "58"] as const;

/** A statement's outcome in a word: `ok`, `refused` (the statement's own fault), `failed` (Mason's or the machine's),
 *  `cancelled` (57014: a cancel or a statement timeout). */
export type Outcome = "ok" | "refused" | "failed" | "cancelled";
export const OUTCOMES: readonly Outcome[] = ["ok", "refused", "failed", "cancelled"];

/**
 * A Postgres-listener statement's outcome in a word, from the SQLSTATE it was sent: `cancelled` for 57014 (a cancel or a
 * timeout), `failed` where the fault is Mason's or the machine's (FAILED_CLASSES), `refused` for the statement's own,
 * `ok` for none. Read by the listener's refusal line (server.ts `refusalLine`) and the request log (src/duck/requests.ts)
 * alike; the ledger's filter and summary read the SAME rule as SQL (`outcomeSql`), held equal by tests/duck-requests.test.ts.
 */
export function outcomeOf(sqlstate: string | null | undefined): Outcome {
  if (sqlstate === null || sqlstate === undefined || sqlstate === "") return "ok";
  if (sqlstate === CANCELLED_SQLSTATE) return "cancelled";
  return FAILED_CLASSES.some((c) => sqlstate.startsWith(c)) ? "failed" : "refused";
}

/** `outcomeOf` as a SQL expression over a SQLSTATE column: the one rule, for the ledger's filters and summary. */
export function outcomeSql(column: string): string {
  return `CASE WHEN ${column} IS NULL OR ${column} = '' THEN 'ok' WHEN ${column} = '${CANCELLED_SQLSTATE}' THEN 'cancelled' ` +
    `WHEN left(${column}, 2) IN (${FAILED_CLASSES.map((c) => `'${c}'`).join(", ")}) THEN 'failed' ELSE 'refused' END`;
}

/** A statement as a reader shows it: completed (answered), failed (refused or failed), or cancelled. */
export type RequestStatus = "completed" | "failed" | "cancelled";
export const statusOf = (o: Outcome): RequestStatus => o === "ok" ? "completed" : o === "cancelled" ? "cancelled" : "failed";

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
