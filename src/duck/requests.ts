/**
 * THE REQUEST LEDGER OF THE DUCKDB RUN (every request is recorded in an ops schema in DuckDB, so a failed request can be
 * debugged later: a BI tool met an error on the test server and nothing could be found after).
 * Every statement the Postgres listener answered with DuckDB, and every statement it refused or failed, whatever it was,
 * is a row of `_mason.requests` in the run's own DuckDB file: the ClickHouse stack's `ops.api_requests`
 * (src/api/request-log.ts) for the prototype, built from the same `ApiLogRow` the listener builds, kept
 * `MASON_REQUEST_LOG_DAYS` days (default 7). `mason status` and `mason logs --requests` read it through the run's command
 * server (src/cli/run-server.ts), never by opening the file: DuckDB allows one process per file.
 *
 * Written as the ClickHouse stack this was cut from wrote its request log: rows wait here for at most FLUSH_MS, or until
 * BATCH_ROWS have gathered, and go in ONE INSERT, on a connection of the ledger's own — never the sync's writer turn
 * (`onWriter`), which a copy's swap or a stream batch may hold for seconds; DuckDB's MVCC lets two connections write two
 * tables at once. A read is on a third connection and sees committed batches only. A flush that fails is said once, with
 * the rows it cost, and again when a flush succeeds after it; it never fails a statement (its answer was already sent).
 * A run killed between flushes loses at most the last second's rows.
 *
 * The Postgres catalog never lists `_mason`, so a tool connected to the listener cannot read the ledger.
 */
import type { DuckDBValue } from "@duckdb/node-api";
import type { DuckConnection } from "./executor.ts";
import { OUTCOMES, outcomeOf, outcomeSql, statusOf, type ApiLogRow, type Outcome, type RequestStatus } from "../api/request-log.ts";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";
import type { RefusedQuery, SlowQuery } from "../cli/run-server.ts";

export const REQUESTS_TABLE = `${MASON_SCHEMA}.requests`;

/** How many days of requests are kept unless MASON_REQUEST_LOG_DAYS says. */
export const DEFAULT_REQUEST_LOG_DAYS = 7;
const FLUSH_MS = 1000;
const BATCH_ROWS = 1000;
/** how often the rows past the retention are deleted (and once at open) */
const TRIM_EVERY_MS = 60 * 60 * 1000;

/**
 * The days MASON_REQUEST_LOG_DAYS keeps, or why the text is not a number of days. Unset or empty: the default.
 */
export function requestLogDays(text: string | undefined): number | { problem: string } {
  if (text === undefined || text.trim() === "") return DEFAULT_REQUEST_LOG_DAYS;
  const days = Number(text);
  if (!Number.isInteger(days) || days < 1) {
    return { problem: `MASON_REQUEST_LOG_DAYS=${JSON.stringify(text)} is not a number of days: write a whole number, 1 or more (unset, ${DEFAULT_REQUEST_LOG_DAYS})` };
  }
  return days;
}

/** A request's outcome in a word, from its SQLSTATE (src/api/request-log.ts: the listener's refusal line reads it too). */
export { outcomeOf };

/** One request as the ledger keeps it and the commands show it (`mason logs --requests --json`). */
export interface LedgerRequest {
  requestId: string;
  /** when the statement arrived, ISO 8601 UTC */
  startedAt: string;
  /** the listener's session number (the log's `session <n>` lines) */
  session: number | null;
  /** the client's `application_name` ('' when it sent none) */
  applicationName: string;
  /** a service token's NAME (never the token); '' for an interactive token */
  tokenName: string;
  /** the `mason user` the session logged in as, or the one a refused login asked for (src/duck/users.ts); '' for a
   *  token's session, whose user name is any the tool sent */
  user: string;
  /** QUERY (a simple Query's statement), PARSE, BIND, EXECUTE, CONNECT … */
  method: string;
  /** ok, refused (the statement's own fault), failed (Mason's or the machine's), cancelled (57014: a cancel or a
   *  statement timeout); src/api/request-log.ts outcomeOf */
  outcome: Outcome;
  /** the outcome as a reader shows it: completed, failed (refused or failed) or cancelled (statusOf) */
  status: RequestStatus;
  /** null when it was answered */
  sqlstate: string | null;
  message: string | null;
  detail: string | null;
  hint: string | null;
  /** rows sent to the client (null for a refusal) */
  rows: number | null;
  durationMs: number;
  /** when its answer ended, ISO 8601 UTC: startedAt + durationMs */
  endedAt: string;
  /** the bytes the listener sent the session for it (its rows and its last frame); null for a row recorded before the
   *  ledger counted them, and for a removed user's refusal */
  bytesSent: number | null;
  /** the statement as the tool sent it, capped at 64 KiB (`queryTruncated` says when it was cut) */
  query: string;
  queryTruncated: boolean;
}

const COLUMNS = ["request_id", "started_at", "session", "application_name", "token_name", "user_name", "method", "sqlstate", "message", "detail", "hint",
  "rows", "duration_ms", "query", "query_truncated", "seq", "json_reads", "bytes_sent"] as const;

/** the ledger's DDL: one row per request, named for a developer who knows pg_stat_activity */
/** a ledger made before `mason user` gains its column; a column added last is named in every INSERT */
export const REQUESTS_USER_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS user_name VARCHAR`;
/**
 * The ledger's ORDER within a millisecond: `started_at` is the clock's millisecond and `request_id` a random
 * UUID, so two requests recorded in one millisecond — a refused login and the statement before it — read back in either
 * order. Every row is numbered as it is recorded (`seq`, continuing from the ledger's last number at open), and the
 * ledger is read by start time THEN seq: the order the listener saw, never the UUID's. A ledger made before gains the
 * column; its old rows (seq NULL) are older than any new one by more than a millisecond.
 */
export const REQUESTS_SEQ_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS seq BIGINT`;

/**
 * THE JSON PATHS EACH STATEMENT READ: a JSON array of the copied tables' JSON columns read by literal steps
 * (src/duck/kept-route.ts readKey), NULL for none — what decides which paths Mason stores as columns (src/duck/kept.ts
 * `review`: read by several statements, or by a slow one, within the log's retention). A ledger made before gains it.
 */
export const REQUESTS_JSON_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS json_reads VARCHAR`;

/** THE BYTES SENT for each statement (ApiLogRow.bytesSent): what the answers cost to send. A ledger made before gains it;
 *  its old rows are NULL, never 0. */
export const REQUESTS_BYTES_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS bytes_sent BIGINT`;

export const REQUESTS_DDL = `CREATE TABLE IF NOT EXISTS ${REQUESTS_TABLE} (request_id VARCHAR, started_at TIMESTAMPTZ, session INTEGER, ` +
  `application_name VARCHAR, token_name VARCHAR, user_name VARCHAR, method VARCHAR, sqlstate VARCHAR, message VARCHAR, detail VARCHAR, hint VARCHAR, ` +
  `"rows" BIGINT, duration_ms INTEGER, query VARCHAR, query_truncated BOOLEAN, seq BIGINT, json_reads VARCHAR, bytes_sent BIGINT)`;

/** a row as the ledger buffers it: the listener's row and its number in arrival order */
interface Numbered { row: ApiLogRow; seq: number }

/** an ApiLogRow's values in COLUMNS' order */
function valuesOf({ row: r, seq }: Numbered): DuckDBValue[] {
  const app = (r.client ?? "").replace(/^postgres:/, "");
  return [r.requestId, r.at.toISOString(), r.session ?? null, app === "unnamed" ? "" : app, r.tokenName ?? "", r.user ?? "", r.method,
    r.sqlstate ?? null, r.error === undefined || r.error === "" ? null : r.error, r.detail ?? null, r.hint ?? null,
    r.rows === undefined ? null : r.rows, Math.round(r.durationMs), r.payload ?? "", r.payloadTruncated === true, seq,
    r.jsonReads === undefined || r.jsonReads.length === 0 ? null : JSON.stringify(r.jsonReads), r.bytesSent === undefined ? null : r.bytesSent];
}

/** A ledger row as the commands read it. */
function requestOf(o: Record<string, unknown>): LedgerRequest {
  const text = (v: unknown): string | null => v === null || v === undefined ? null : String(v);
  const sqlstate = text(o.sqlstate);
  const outcome = outcomeOf(sqlstate);
  const startedAt = new Date(String(o.started_at));
  return {
    requestId: String(o.request_id), startedAt: startedAt.toISOString(), session: o.session === null ? null : Number(o.session),
    applicationName: String(o.application_name ?? ""), tokenName: String(o.token_name ?? ""), user: String(o.user_name ?? ""), method: String(o.method),
    outcome, status: statusOf(outcome), sqlstate, message: text(o.message), detail: text(o.detail), hint: text(o.hint),
    rows: o.rows === null ? null : Number(o.rows), durationMs: Number(o.duration_ms),
    endedAt: new Date(startedAt.getTime() + Number(o.duration_ms)).toISOString(), bytesSent: o.bytes_sent === null || o.bytes_sent === undefined ? null : Number(o.bytes_sent),
    query: String(o.query ?? ""), queryTruncated: o.query_truncated === true,
  };
}

/** What a read of the request log asks for (src/cli/request-filter.ts parses it, from a command line and a URL alike). */
export interface RequestQuery {
  limit: number;
  /** the ones not answered: refused, failed or cancelled */
  failed?: boolean | undefined;
  outcomes?: readonly Outcome[] | undefined;
  /** ISO 8601: started at or after */
  since?: string | undefined;
  /** ISO 8601: started before */
  until?: string | undefined;
  /** a mason user's name */
  user?: string | undefined;
  /** the client's application_name, exactly */
  client?: string | undefined;
  /** strictly older than this position (a page's `before`, parseRequestCursor) */
  before?: { at: string; seq: number } | undefined;
}

/**
 * A position in the request log's order, as a page hands it on: the row's start, ISO 8601, and its number (`seq`; -1
 * for a row recorded before rows were numbered) — `2026-10-28T10:00:00.123Z~42`. A reader passes it back as it came.
 */
export const requestCursor = (at: string, seq: number): string => `${at}~${seq}`;

/** A cursor read back (requestCursor), or null when the text is not one. */
export function parseRequestCursor(text: string): { at: string; seq: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~(-?\d+)$/.exec(text);
  if (m === null || Number.isNaN(Date.parse(m[1]!))) return null;
  return { at: m[1]!, seq: Number(m[2]) };
}

/** One window of the query summary (RequestLedger.summary). */
export interface QueryWindow {
  /** the window asked: 1 (the last day) or 7 (the last week) */
  days: number;
  /** the days of it the log keeps (MASON_REQUEST_LOG_DAYS): fewer than `days` when the log keeps fewer */
  covered: number;
  /** every statement recorded in it (a refused login is none), and each outcome's count */
  statements: number; completed: number; refused: number; failed: number; cancelled: number;
  /** the rows and the bytes sent, over every statement */
  rows: number; bytesSent: number;
  /** how long the completed ones took, in ms; null when none completed */
  durationMs: { avg: number; p50: number; p95: number } | null;
}

/** The query summary: the last day and the last week, and the days the log keeps. */
export interface QuerySummary { keptDays: number; day: QueryWindow; week: QueryWindow }

export interface LedgerOptions {
  /** days kept (MASON_REQUEST_LOG_DAYS) */
  days: number;
  /** a test's: how long a row waits before its batch is written */
  flushMs?: number;
  /** a test's: write each batch with this instead of the ledger's own connection (a failure to say) */
  insert?: (sql: string, values: DuckDBValue[]) => Promise<void>;
}

export class RequestLedger {
  private buffer: Numbered[] = [];
  /** the next row's number (REQUESTS_SEQ_DDL): one past the ledger's last at open, then one per request recorded */
  private next = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trimTimer: ReturnType<typeof setInterval> | null = null;
  /** the flush in flight: one at a time, so batches commit in the order they were taken */
  private flushing: Promise<void> = Promise.resolve();
  /** rows lost since the last flush that succeeded: said once when the streak begins, and when it ends */
  private lost = 0;
  private closed = false;

  private readonly writer: DuckConnection;
  private readonly reader: DuckConnection;
  private readonly log: (line: string) => void;
  private readonly options: LedgerOptions;
  /** days kept */
  readonly days: number;

  private constructor(writer: DuckConnection, reader: DuckConnection, log: (line: string) => void, options: LedgerOptions) {
    this.writer = writer; this.reader = reader; this.log = log; this.options = options; this.days = options.days;
  }

  /** The ledger of a store: its table made, the rows past the retention deleted, and a trim every hour. */
  static async open(store: DuckStore, log: (line: string) => void, options: LedgerOptions): Promise<RequestLedger> {
    const writer = await store.instance.connect();
    await writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
    await writer.run(REQUESTS_DDL);
    await writer.run(REQUESTS_USER_DDL);
    await writer.run(REQUESTS_SEQ_DDL);
    await writer.run(REQUESTS_JSON_DDL);
    await writer.run(REQUESTS_BYTES_DDL);
    const reader = await store.instance.connect();
    const ledger = new RequestLedger(writer, reader, log, options);
    ledger.next = Number((await reader.runAndReadAll(`SELECT coalesce(max(seq), -1) + 1 FROM ${REQUESTS_TABLE}`)).getRowsJS()[0]![0]);
    await ledger.trim();
    ledger.trimTimer = setInterval(() => {
      ledger.trim().catch((e: unknown) => log(`request log: deleting the requests older than ${ledger.days} days failed: ${(e as Error).message}`));
    }, TRIM_EVERY_MS);
    ledger.trimTimer.unref();
    return ledger;
  }

  /** One request, written with the next batch. Never throws: the statement it records was already answered. */
  record(row: ApiLogRow): void {
    // the listener closes before the ledger (mason stop), so nothing should arrive after: said if it does, never written
    if (this.closed) { this.log(`request log: a request after the log closed, not recorded (${row.requestId})`); return; }
    this.buffer.push({ row, seq: this.next++ });
    if (this.buffer.length >= BATCH_ROWS) { void this.flush(); return; }
    this.timer ??= setTimeout(() => { void this.flush(); }, this.options.flushMs ?? FLUSH_MS);
  }

  /** Writes what is waiting, after any flush in flight. Resolves whether it was written or not (a failure is said). */
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const rows = this.buffer;
    this.buffer = [];
    if (rows.length === 0) return this.flushing;
    this.flushing = this.flushing.then(() => this.write(rows));
    return this.flushing;
  }

  private async write(rows: Numbered[]): Promise<void> {
    const width = COLUMNS.length;
    const sql = `INSERT INTO ${REQUESTS_TABLE} (${COLUMNS.map((c) => c === "rows" ? `"rows"` : c).join(", ")}) VALUES ` +
      rows.map((_, i) => `(${COLUMNS.map((c, j) => `$${i * width + j + 1}${c === "started_at" ? "::TIMESTAMPTZ" : ""}`).join(", ")})`).join(", ");
    const values = rows.flatMap(valuesOf);
    try {
      if (this.options.insert !== undefined) await this.options.insert(sql, values);
      else await this.writer.run(sql, values);
    } catch (e) {
      // Tolerated, narrowly, as the ClickHouse writer tolerates it: the answers are sent, so there is no statement left
      // to fail, and a ledger that cannot write must not take the listener down. SAID, once per streak with the rows it
      // costs, so a ledger that stopped recording never reads as a quiet listener.
      if (this.lost === 0) this.log(`request log: could not record ${rows.length} request(s) in ${REQUESTS_TABLE} (${rows[0]!.row.requestId}` +
        `${rows.length > 1 ? ` … ${rows[rows.length - 1]!.row.requestId}` : ""}): ${(e as Error).message}; said once until a write succeeds`);
      this.lost += rows.length;
      return;
    }
    if (this.lost > 0) { this.log(`request log: recording again; ${this.lost} request(s) were not recorded`); this.lost = 0; }
  }

  /** Deletes the requests older than the retention; the count is said when there were any. */
  async trim(): Promise<number> {
    const r = await this.writer.runAndReadAll(`DELETE FROM ${REQUESTS_TABLE} WHERE started_at < now() - INTERVAL (${this.days}) DAY`);
    const n = Number(r.getRowsJS()[0]?.[0] ?? 0);
    if (n > 0) this.log(`request log: deleted ${n} request(s) older than ${this.days} days (MASON_REQUEST_LOG_DAYS)`);
    return n;
  }

  /**
   * The newest `limit` requests that pass the filters, newest LAST. `failed`: the ones not answered (refused, failed or
   * cancelled); `outcomes`, `since` / `until` (started at or after / before), `user`, `client` (application_name) and
   * `before` (strictly older than that position: a page's `before`) narrow it further. Committed rows only.
   */
  async recent(q: RequestQuery): Promise<LedgerRequest[]> {
    return (await this.rows(q)).map((r) => requestOf(r));
  }

  /**
   * ONE PAGE of the request log (`/api/requests`, `mason logs --requests`): `recent`, and `before`, the cursor of the
   * page's oldest row when an older one passes the filters (null: this is the last page). Pages follow the ledger's
   * order (started_at, then seq), so the page asked with `before` holds the rows older than the page before it, whatever
   * was recorded since — but a statement still running when a page was read is recorded at its START, so it may land in
   * a page already read.
   */
  async page(q: RequestQuery): Promise<{ requests: LedgerRequest[]; before: string | null }> {
    const rows = await this.rows({ ...q, limit: q.limit + 1 });
    const more = rows.length > q.limit;
    const shown = more ? rows.slice(1) : rows;
    const first = shown[0];
    return { requests: shown.map((r) => requestOf(r)),
      before: more && first !== undefined ? requestCursor(new Date(String(first.started_at)).toISOString(), first.seq === null || first.seq === undefined ? -1 : Number(first.seq)) : null };
  }

  private async rows(q: RequestQuery): Promise<Array<Record<string, unknown>>> {
    const where: string[] = [];
    const values: DuckDBValue[] = [];
    const arg = (v: DuckDBValue, cast = ""): string => { values.push(v); return `$${values.length}${cast}`; };
    if (q.failed === true) where.push("sqlstate IS NOT NULL");
    if (q.outcomes !== undefined && q.outcomes.length > 0) where.push(`(${outcomeSql("sqlstate")}) IN (${q.outcomes.map((o) => arg(o)).join(", ")})`);
    if (q.since !== undefined) where.push(`started_at >= ${arg(q.since, "::TIMESTAMPTZ")}`);
    if (q.until !== undefined) where.push(`started_at < ${arg(q.until, "::TIMESTAMPTZ")}`);
    if (q.user !== undefined) where.push(`user_name = ${arg(q.user)}`);
    if (q.client !== undefined) where.push(`application_name = ${arg(q.client)}`);
    if (q.before !== undefined) {
      const at = arg(q.before.at, "::TIMESTAMPTZ");
      where.push(`(started_at < ${at} OR (started_at = ${at} AND coalesce(seq, -1) < ${arg(q.before.seq)}))`);
    }
    const limit = arg(q.limit);
    const rows = (await this.reader.runAndReadAll(`SELECT * FROM (SELECT * FROM ${REQUESTS_TABLE}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY started_at DESC, coalesce(seq, -1) DESC LIMIT ${limit}) ORDER BY started_at, coalesce(seq, -1)`, values)).getRowObjectsJson();
    return rows as Array<Record<string, unknown>>;
  }

  /**
   * THE QUERY SUMMARY of `mason status` (`/api/queries`): the statements of the last day and of the last 7 days — how
   * many, how many completed, refused, failed and cancelled, how long the completed ones took (average, p50, p95), the
   * rows and the bytes sent — in ONE scan of the ledger. A refused login (CONNECT) is not a statement. The log keeps
   * `days` days, so a window longer than that is `covered` only as far as it keeps (said, never a short week passed off
   * as a whole one).
   */
  async summary(): Promise<QuerySummary> {
    const windows = [["day", 1], ["week", 7]] as const;
    const cols = windows.flatMap(([w, days]) => {
      const within = `started_at > now() - INTERVAL ${days} DAY`;
      const ok = `FILTER (WHERE ${within} AND outcome = 'ok')`;
      return [`count(*) FILTER (WHERE ${within}) AS ${w}_statements`,
        ...OUTCOMES.map((o) => `count(*) FILTER (WHERE ${within} AND outcome = '${o}') AS ${w}_${o}`),
        `avg(duration_ms) ${ok} AS ${w}_avg`, `quantile_cont(duration_ms, 0.5) ${ok} AS ${w}_p50`, `quantile_cont(duration_ms, 0.95) ${ok} AS ${w}_p95`,
        `coalesce(sum("rows") FILTER (WHERE ${within}), 0) AS ${w}_rows`, `coalesce(sum(bytes_sent) FILTER (WHERE ${within}), 0) AS ${w}_bytes`];
    });
    const r = (await this.reader.runAndReadAll(`SELECT ${cols.join(", ")} FROM (SELECT started_at, duration_ms, "rows", bytes_sent, ${outcomeSql("sqlstate")} AS outcome ` +
      `FROM ${REQUESTS_TABLE} WHERE started_at > now() - INTERVAL 7 DAY AND method <> 'CONNECT')`)).getRowObjectsJson()[0] as Record<string, unknown>;
    const num = (v: unknown): number => v === null || v === undefined ? 0 : Number(v);
    const windowOf = (w: string, days: number): QueryWindow => ({
      days, covered: Math.min(days, this.days), statements: num(r[`${w}_statements`]), completed: num(r[`${w}_ok`]), refused: num(r[`${w}_refused`]),
      failed: num(r[`${w}_failed`]), cancelled: num(r[`${w}_cancelled`]), rows: num(r[`${w}_rows`]), bytesSent: num(r[`${w}_bytes`]),
      durationMs: r[`${w}_avg`] === null || r[`${w}_avg`] === undefined ? null
        : { avg: Math.round(num(r[`${w}_avg`])), p50: Math.round(num(r[`${w}_p50`])), p95: Math.round(num(r[`${w}_p95`])) },
    });
    return { keptDays: this.days, day: windowOf("day", 1), week: windowOf("week", 7) };
  }

  /**
   * The last day's slow statements in `mason status`'s shape (src/cli/run-server.ts SlowQuery): each distinct statement
   * whose LATEST answer still took `slowMs` or more, slowest first.
   */
  async slow(slowMs: number, limit = 5): Promise<SlowQuery[]> {
    const rows = (await this.reader.runAndReadAll(`SELECT query, count(*) AS runs, CAST(quantile_disc(duration_ms, 0.5) AS INTEGER) AS median_ms, ` +
      `max(duration_ms) AS max_ms, arg_max(duration_ms, started_at) AS latest_ms, max(started_at) AS last FROM ${REQUESTS_TABLE} ` +
      `WHERE sqlstate IS NULL AND started_at > now() - INTERVAL 1 DAY AND query <> '' AND NOT query_truncated ` +
      `GROUP BY query HAVING arg_max(duration_ms, started_at) >= $1 ORDER BY latest_ms DESC LIMIT $2`, [slowMs, limit])).getRowObjectsJson();
    return rows.map((r) => ({ route: "postgres", payload: String(r.query), runs: Number(r.runs), medianMs: Number(r.median_ms), maxMs: Number(r.max_ms),
      latestMs: Number(r.latest_ms), last: new Date(String(r.last)).toISOString() }));
  }

  /**
   * The last day's refused and failed statements in `mason status`'s shape (RefusedQuery): each distinct statement once,
   * newest first, with its latest SQLSTATE and message; and how many there were in all.
   */
  async refused(limit = 8): Promise<{ refused: RefusedQuery[]; total: number }> {
    const day = `sqlstate IS NOT NULL AND started_at > now() - INTERVAL 1 DAY`;
    const rows = (await this.reader.runAndReadAll(`SELECT query, count(*) AS runs, max(started_at) AS last, arg_max(sqlstate, started_at) AS code, arg_max(message, started_at) AS message ` +
      `FROM ${REQUESTS_TABLE} WHERE ${day} GROUP BY query ORDER BY last DESC LIMIT $1`, [limit])).getRowObjectsJson();
    const total = Number((await this.reader.runAndReadAll(`SELECT count(*) FROM ${REQUESTS_TABLE} WHERE ${day}`)).getRowsJS()[0]?.[0] ?? 0);
    return { total, refused: rows.map((r) => ({ route: "postgres", payload: String(r.query), runs: Number(r.runs), last: new Date(String(r.last)).toISOString(),
      code: String(r.code), message: String(r.message ?? "") })) };
  }

  /** Writes what is waiting and closes the ledger's connections (mason stop). */
  async close(): Promise<void> {
    if (this.trimTimer !== null) { clearInterval(this.trimTimer); this.trimTimer = null; }
    await this.flush();
    this.closed = true;
    this.writer.closeSync();
    this.reader.closeSync();
  }

  /**
   * When each `mason user` last ran a statement, within the log's retention: for each of `users` (a name and the window
   * it was a user in: `since` its addedAt, `until` its removedAt or null), the time of its newest request in that
   * window, ISO 8601, or null when the log has none. The window tells a user from an earlier one of the same name. A
   * refused login (28P01, 57P03) or an ended session (28000) is no use, so it does not count. Committed rows only.
   * ONE scan of the log for every user (a `max … FILTER` per user), never one per user: `/api/users` is asked at every
   * poll of the web page.
   */
  async lastUsed(users: ReadonlyArray<{ name: string; since: string; until: string | null }>): Promise<Array<string | null>> {
    if (users.length === 0) return [];
    const params: DuckDBValue[] = [];
    const at = (v: string): string => { params.push(v); return `$${params.length}`; };
    const cols = users.map((u, i) => `epoch_ms(max(started_at) FILTER (WHERE user_name = ${at(u.name)} AND started_at >= CAST(${at(u.since)} AS TIMESTAMPTZ)` +
      (u.until === null ? "" : ` AND started_at <= CAST(${at(u.until)} AS TIMESTAMPTZ)`) + `)) AS u${i}`);
    const names = [...new Set(users.map((u) => u.name))].map(at).join(", ");
    const row = (await this.reader.runAndReadAll(`SELECT ${cols.join(", ")} FROM ${REQUESTS_TABLE} WHERE user_name IN (${names}) ` +
      `AND (sqlstate IS NULL OR sqlstate NOT IN ('28P01', '57P03', '28000'))`, params)).getRowsJS()[0] ?? [];
    return users.map((_, i) => (row[i] === null || row[i] === undefined ? null : new Date(Number(row[i])).toISOString()));
  }
}
