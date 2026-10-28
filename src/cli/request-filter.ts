/**
 * THE REQUEST LOG'S FILTERS, READ ONCE (one input through one grammar at every entrance): `mason logs --requests`
 * (its options) and the run's `GET /api/requests` (its query string, which the command, the web page and the managed
 * service send) are read by `requestFilter` alone, into the ledger's `RequestQuery` (src/duck/requests.ts). A mistake
 * is a Failure (code `usage`) worded once, whichever entrance met it. The command resolves an age (`--since 2h`) on its
 * own clock and hands the run the times it resolved (`requestFilterParams`), which the run reads again here.
 */
import type { Failure } from "./command.ts";
import { OUTCOMES, type Outcome } from "../api/request-log.ts";
import { parseRequestCursor, requestCursor, type RequestQuery } from "../duck/requests.ts";
import { didYouMean } from "../lib/did-you-mean.ts";

/** How many requests a read returns unless it says. */
export const DEFAULT_REQUEST_LIMIT = 40;
export const MAX_REQUEST_LIMIT = 10_000;

/** How many sync events a read returns unless it says, and the most it may. */
export const DEFAULT_EVENT_LIMIT = 40;
export const MAX_EVENT_LIMIT = MAX_REQUEST_LIMIT;

/** The filters as text, as a command line or a query string carries them (absent: not asked). */
export interface RequestFilterText {
  limit?: string | undefined;
  /** a comma list of OUTCOMES */
  outcome?: string | undefined;
  failed?: boolean | undefined;
  since?: string | undefined;
  until?: string | undefined;
  user?: string | undefined;
  client?: string | undefined;
  before?: string | undefined;
}

const AGE = /^(\d+)(s|m|h|d)$/;
const AGE_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** a date, or a date and time with its zone (a time without one would be read in this machine's zone: refused) */
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2}))?$/;

const usage = (message: string, fix?: string): Failure => ({ message, code: "usage", ...(fix !== undefined ? { fix } : {}) });

/** A filter's key as the entrance spells it: the query string's own (`since`), a command line's flag (`--since`). */
export type FilterKey = keyof RequestFilterText;
export const QUERY_NAMES = (k: FilterKey): string => k;

/** A time the filters name: an ISO 8601 date or time with its zone, or an age before `now` (30m, 2h, 7d). */
function timeOf(name: string, text: string, now: number): string | Failure {
  const age = AGE.exec(text.trim());
  if (age !== null) return new Date(now - Number(age[1]) * AGE_MS[age[2]!]!).toISOString();
  const t = ISO.test(text.trim()) ? Date.parse(text.trim()) : NaN;
  if (Number.isNaN(t)) {
    return usage(`${name} ${JSON.stringify(text)} is not a time`, "an age (30m, 2h, 7d) or an ISO 8601 date or time with its zone (2026-10-28, 2026-10-28T09:00:00Z)");
  }
  return new Date(t).toISOString();
}

/** `-n` / `limit` of the sync's events: a whole number, 1 to the cap, said in the entrance's own spelling of the key. */
export function eventLimit(text: string | undefined, key: string): number | Failure {
  const limit = text === undefined ? DEFAULT_EVENT_LIMIT : Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) return usage(`${key} is a whole number of events, 1 to ${MAX_EVENT_LIMIT}`);
  return limit;
}

/**
 * The filters read, or the first thing wrong with them, its key spelled as the entrance spells it (`name`). `failed`
 * is every outcome but ok, so it is never named beside `outcome`; `since` must come before `until`; `before` is a
 * cursor a page handed on, passed back as it came.
 */
export function requestFilter(f: RequestFilterText, now: number = Date.now(), name: (k: FilterKey) => string = QUERY_NAMES): RequestQuery | Failure {
  const limit = f.limit === undefined ? DEFAULT_REQUEST_LIMIT : Number(f.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REQUEST_LIMIT) return usage(`${name("limit")} is a whole number of requests, 1 to ${MAX_REQUEST_LIMIT}`);
  const q: RequestQuery = { limit };
  if (f.outcome !== undefined) {
    if (f.failed === true) {
      return usage(`${name("failed")} is every outcome but ok: name it or ${name("outcome")}, never both`, `${name("outcome")} refused,failed,cancelled is ${name("failed")}`);
    }
    const names = f.outcome.split(",").map((o) => o.trim()).filter((o) => o !== "");
    if (!names.length) return usage(`${name("outcome")} names one or more of ${OUTCOMES.join(", ")}`);
    for (const o of names) {
      if (!(OUTCOMES as readonly string[]).includes(o)) return usage(`${name("outcome")} ${JSON.stringify(o)} is none of ${OUTCOMES.join(", ")}${didYouMean(o, OUTCOMES)}`);
    }
    q.outcomes = [...new Set(names)] as Outcome[];
  }
  if (f.failed === true) q.failed = true;
  for (const k of ["since", "until"] as const) {
    const text = f[k];
    if (text === undefined) continue;
    const t = timeOf(name(k), text, now);
    if (typeof t !== "string") return t;
    q[k] = t;
  }
  if (q.since !== undefined && q.until !== undefined && q.since >= q.until) {
    return usage(`${name("since")} (${q.since}) is not before ${name("until")} (${q.until}): no request started in between`);
  }
  for (const k of ["user", "client"] as const) {
    const text = f[k];
    if (text === undefined) continue;
    if (text === "") return usage(`${name(k)} names ${k === "user" ? "a mason user" : "a client's application_name"}: it is empty`);
    q[k] = text;
  }
  if (f.before !== undefined) {
    const c = parseRequestCursor(f.before);
    if (c === null) return usage(`${name("before")} ${JSON.stringify(f.before)} is not a position in the request log`, `pass back the before a page answered with, as it came`);
    q.before = c;
  }
  return q;
}

/** The query string the run reads a RequestQuery from (requestFilter again, on its side): its times as resolved. */
export function requestFilterParams(q: RequestQuery): URLSearchParams {
  const p = new URLSearchParams({ limit: String(q.limit) });
  if (q.failed === true) p.set("failed", "1");
  if (q.outcomes !== undefined) p.set("outcome", q.outcomes.join(","));
  if (q.since !== undefined) p.set("since", q.since);
  if (q.until !== undefined) p.set("until", q.until);
  if (q.user !== undefined) p.set("user", q.user);
  if (q.client !== undefined) p.set("client", q.client);
  if (q.before !== undefined) p.set("before", requestCursor(q.before.at, q.before.seq));
  return p;
}

/** A query string's filters as text (`GET /api/requests`): what requestFilter reads. */
export function requestFilterText(p: URLSearchParams): RequestFilterText {
  const get = (k: string): string | undefined => p.get(k) ?? undefined;
  return { limit: get("limit"), outcome: get("outcome"), failed: p.get("failed") === "1", since: get("since"), until: get("until"),
    user: get("user"), client: get("client"), before: get("before") };
}
