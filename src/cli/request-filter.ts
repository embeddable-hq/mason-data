/**
 * THE REQUEST LOG'S FILTERS, READ ONCE (one input through one grammar at every entrance): `mason logs --requests`
 * (its options) and the run's `GET /api/requests` (its query string, which the command, the web page and the managed
 * service send) are read by `requestFilter` alone, into the ledger's `RequestQuery` (src/duck/requests.ts). A mistake
 * is a Failure (code `usage`) worded once, whichever entrance met it. The command resolves an age (`--since 2h`) on its
 * own clock and hands the run the times it resolved (`requestFilterParams`), which the run reads again here.
 */
import type { Failure } from "./command.ts";
import { OUTCOMES, SLOW_MS, type Outcome } from "../api/request-log.ts";
import { parseRequestCursor, requestCursor, type RequestQuery } from "../duck/requests.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { parseDuration } from "../lib/table-sync.ts";

/** How many requests a read returns unless it says. */
export const DEFAULT_REQUEST_LIMIT = 40;
export const MAX_REQUEST_LIMIT = 10_000;

/** A statement answered in this many milliseconds or more is slow: the one constant is the request log's
 *  (src/api/request-log.ts SLOW_MS), which also decides whose plan is recorded; re-exported here, where the filter is
 *  read, and by src/cli/run-server.ts. */
export { SLOW_MS };

/** A request's id as the listener makes one (crypto.randomUUID): what `id` takes. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest text `search` takes: a fragment of a statement, never a statement pasted whole. */
export const MAX_SEARCH = 200;

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
  /** only the ones that took SLOW_MS or more */
  slow?: boolean | undefined;
  /** only the statements whose text has it, any case */
  search?: string | undefined;
  before?: string | undefined;
  /** the one request of this id (its `requestId`): read whole, its plan with it */
  id?: string | undefined;
}

/** a date, or a date and time with its zone (a time without one would be read in this machine's zone: refused) */
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/** The furthest a JavaScript Date reaches from 1970, either way (ECMA-262 21.4.1.1). */
const MAX_TIME_MS = 8.64e15;

const usage = (message: string, fix?: string): Failure => ({ message, code: "usage", ...(fix !== undefined ? { fix } : {}) });

/** A filter's key as the entrance spells it: the query string's own (`since`), a command line's flag (`--since`). */
export type FilterKey = keyof RequestFilterText;
export const QUERY_NAMES = (k: FilterKey): string => k;

/**
 * THE TIME GRAMMAR, ONE FOR EVERY ENTRANCE (`--since` / `--until` of mason logs and mason usage, and the run's `since` and
 * `until` of /api/requests, /api/events, /api/usage and /api/logs): an ISO 8601 date or time with its zone, or an age
 * before `now` (30s, 30m, 2h, 7d, 2 hours), read by the command line's one duration grammar (src/lib/table-sync.ts
 * `parseDuration`) with its unit written, as an ISO time; a time with no zone is refused, as is anything else. A bare
 * number is refused here, as it always was: as a TIME it reads as well as a Unix timestamp as an age in seconds.
 */
export function timeOf(name: string, text: string, now: number): string | Failure {
  const age = Number.isFinite(Number(text.trim())) ? null : parseDuration(text, { zero: true });
  if (age !== null && !("problem" in age)) {
    // an age past what a time can hold (Date's ±8.64e15 ms) is the command line's mistake, refused as one: never a throw,
    // which the run's API would answer 500
    const at = now - age.seconds * 1000;
    if (!Number.isFinite(at) || Math.abs(at) > MAX_TIME_MS) {
      return usage(`${name} ${JSON.stringify(text)} is further back than a time reaches`, "a shorter age (30m, 2h, 7d), or an ISO 8601 date or time with its zone (2026-10-28, 2026-10-28T09:00:00Z)");
    }
    return new Date(at).toISOString();
  }
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
 * is every outcome but ok, so it is never named beside `outcome`; `slow` keeps the ones that took SLOW_MS or more, and
 * `search` the statements whose text has it (any case, at most MAX_SEARCH characters); `since` must come before `until`; `before` is a
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
  if (f.slow === true) q.minMs = SLOW_MS;
  if (f.search !== undefined) {
    if (f.search.trim() === "") return usage(`${name("search")} is a piece of a statement's text: it is empty`);
    if (f.search.length > MAX_SEARCH) return usage(`${name("search")} is a piece of a statement's text, at most ${MAX_SEARCH} characters: it has ${f.search.length}`);
    q.search = f.search;
  }
  if (f.id !== undefined) {
    // a request's id is the uuid the listener gave it (src/api/postgres/server.ts recordRequest)
    if (!REQUEST_ID.test(f.id)) return usage(`${name("id")} ${JSON.stringify(f.id)} is not a request's id`, "the requestId a request is listed with (mason logs --requests --json), a uuid");
    q.id = f.id.toLowerCase();
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
  if (q.minMs !== undefined) p.set("slow", "1");
  if (q.search !== undefined) p.set("search", q.search);
  if (q.before !== undefined) p.set("before", requestCursor(q.before.at, q.before.seq));
  if (q.id !== undefined) p.set("id", q.id);
  return p;
}

/** A query string's filters as text (`GET /api/requests`): what requestFilter reads. */
export function requestFilterText(p: URLSearchParams): RequestFilterText {
  const get = (k: string): string | undefined => p.get(k) ?? undefined;
  return { limit: get("limit"), outcome: get("outcome"), failed: p.get("failed") === "1", since: get("since"), until: get("until"),
    user: get("user"), client: get("client"), slow: p.get("slow") === "1", search: get("search"), before: get("before"), id: get("id") };
}
