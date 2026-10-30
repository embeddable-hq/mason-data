/**
 * THE REQUEST LEDGER OF THE DUCKDB RUN (every request is recorded in an ops schema in DuckDB, so a failed request can be
 * debugged later: a BI tool met an error on the test server and nothing could be found after).
 * Every statement the Postgres listener answered with DuckDB, and every statement it refused or failed, whatever it was,
 * is a row of `_mason.requests` in the run's own DuckDB file: the ClickHouse stack's `ops.api_requests`
 * (src/api/request-log.ts) for the prototype, built from the same `ApiLogRow` the listener builds, kept
 * `MASON_HISTORY_DAYS` days (default 7). `mason status` and `mason logs --requests` read it through the run's command
 * server (src/cli/run-server.ts), never by opening the file: DuckDB allows one process per file.
 *
 * Written as the ClickHouse stack this was cut from wrote its request log (src/duck/history.ts, the frame the sync's
 * events and the usage samples share): rows wait here for at most FLUSH_MS, or until
 * BATCH_ROWS have gathered, and go in ONE INSERT, on a connection of the ledger's own — never the sync's writer turn
 * (`onWriter`), which a copy's swap or a stream batch may hold for seconds; DuckDB's MVCC lets two connections write two
 * tables at once. A read is on a third connection and sees committed batches only. A flush that fails is said once, with
 * the rows it cost, and again when a flush succeeds after it; it never fails a statement (its answer was already sent).
 * A run killed between flushes loses at most the last second's rows.
 *
 * The Postgres catalog never lists `_mason`, so a tool connected to the listener cannot read the ledger.
 */
import type { DuckDBValue } from "@duckdb/node-api";
import { outcomeOf, outcomeSql, statusOf, type ApiLogRow, type Outcome, type RequestStatus } from "../api/request-log.ts";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";
import { Batches, History, Streak } from "./history.ts";
import { GAPS, type GapId } from "./gaps.ts";
import { quantileContOf } from "./usage.ts";

/** A statement the Postgres API answered slowly in the last day, with how often and how slowly (src/duck/requests.ts slow). */
export interface SlowQuery {
  /** where it was asked: `postgres`, an SQL statement on the Postgres API */
  route: "postgres"; payload: string; runs: number; medianMs: number; maxMs: number; latestMs: number; last: string }

/** A statement the Postgres API refused or failed in the last day: the statement, how often, and the message (which says what to change). */
export interface RefusedQuery {
  /** as SlowQuery's: `postgres`, whose code is its SQLSTATE */
  route: "postgres"; code: string; message: string; runs: number; last: string; payload: string }

export const REQUESTS_TABLE = `${MASON_SCHEMA}.requests`;

const FLUSH_MS = 1000;
const BATCH_ROWS = 1000;

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
  /** the role the session read as (the roles file's, src/cli/roles.ts); '' for a session with none */
  role: string;
  /** the user's attribute values its role's row filters read (`mason user add … --set`, src/duck/row-filter.ts), as the
   *  session carried them; null for a session with none */
  attributes: Record<string, string | string[]> | null;
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
  "rows", "duration_ms", "query", "query_truncated", "seq", "json_reads", "bytes_sent", "gap", "role", "attributes"] as const;

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
/** THE ROLE a session read as (src/duck/grants.ts): beside `user_name`, so a refusal (42501) says who was held to what;
 *  a ledger made before roles gains the column, its old rows NULL (read as '') */
export const REQUESTS_ROLE_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS role VARCHAR`;
/** THE USER'S ATTRIBUTES beside its role (src/duck/row-filter.ts: the values its role's row filters read), as JSON text,
 *  so a statement's rows can be told apart by whose values filtered them; NULL for none, and in a ledger made before */
export const REQUESTS_ATTRIBUTES_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS attributes VARCHAR`;

/** THE BYTES SENT for each statement (ApiLogRow.bytesSent): what the answers cost to send. A ledger made before gains it;
 *  its old rows are NULL, never 0. */
export const REQUESTS_BYTES_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS bytes_sent BIGINT`;

/** THE REGISTRY ENTRY THAT REFUSED EACH STATEMENT (ApiLogRow.gap, src/duck/gaps.ts): NULL for an answer and for any
 *  other refusal; what `unsupported` groups by. A ledger made before gains it; its old rows are NULL. */
export const REQUESTS_GAP_DDL = `ALTER TABLE ${REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS gap VARCHAR`;

export const REQUESTS_DDL = `CREATE TABLE IF NOT EXISTS ${REQUESTS_TABLE} (request_id VARCHAR, started_at TIMESTAMPTZ, session INTEGER, ` +
  `application_name VARCHAR, token_name VARCHAR, user_name VARCHAR, method VARCHAR, sqlstate VARCHAR, message VARCHAR, detail VARCHAR, hint VARCHAR, ` +
  `"rows" BIGINT, duration_ms INTEGER, query VARCHAR, query_truncated BOOLEAN, seq BIGINT, json_reads VARCHAR, bytes_sent BIGINT, gap VARCHAR, role VARCHAR, attributes VARCHAR)`;

/** a row as the ledger buffers it: the listener's row and its number in arrival order */
interface Numbered { row: ApiLogRow; seq: number }

/** an ApiLogRow's values in COLUMNS' order */
function valuesOf({ row: r, seq }: Numbered): DuckDBValue[] {
  const app = (r.client ?? "").replace(/^postgres:/, "");
  return [r.requestId, r.at.toISOString(), r.session ?? null, app === "unnamed" ? "" : app, r.tokenName ?? "", r.user ?? "", r.method,
    r.sqlstate ?? null, r.error === undefined || r.error === "" ? null : r.error, r.detail ?? null, r.hint ?? null,
    r.rows === undefined ? null : r.rows, Math.round(r.durationMs), r.payload ?? "", r.payloadTruncated === true, seq,
    r.jsonReads === undefined || r.jsonReads.length === 0 ? null : JSON.stringify(r.jsonReads), r.bytesSent === undefined ? null : r.bytesSent, r.gap ?? null, r.role ?? "",
    r.attributes === undefined || Object.keys(r.attributes).length === 0 ? null : JSON.stringify(r.attributes)];
}

/** A ledger row as the commands read it. */
function requestOf(o: Record<string, unknown>): LedgerRequest {
  const text = (v: unknown): string | null => v === null || v === undefined ? null : String(v);
  const sqlstate = text(o.sqlstate);
  const outcome = outcomeOf(sqlstate);
  const startedAt = new Date(String(o.started_at));
  return {
    requestId: String(o.request_id), startedAt: startedAt.toISOString(), session: o.session === null ? null : Number(o.session),
    applicationName: String(o.application_name ?? ""), tokenName: String(o.token_name ?? ""), user: String(o.user_name ?? ""), role: String(o.role ?? ""),
    attributes: typeof o.attributes === "string" && o.attributes !== "" ? JSON.parse(o.attributes) as Record<string, string | string[]> : null, method: String(o.method),
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
  /** took this many ms or more (the `slow` filter: src/cli/request-filter.ts SLOW_MS) */
  minMs?: number | undefined;
  /** the statement's text has it, any case */
  search?: string | undefined;
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
  /** the window asked, in days: 1 (the last day) or 7 (the last week) in the summary; a time range's length (a fraction under a day) in `window` */
  days: number;
  /** the days of it the log keeps (MASON_HISTORY_DAYS): fewer than `days` when the log keeps fewer */
  covered: number;
  /** every statement recorded in it (a refused login is none), and each outcome's count */
  statements: number; completed: number; refused: number; failed: number; cancelled: number;
  /** the rows and the bytes sent, over every statement */
  rows: number; bytesSent: number;
  /** how long the completed ones took, in ms; null when none completed */
  durationMs: { avg: number; p50: number; p95: number } | null;
}

/** The statements one registry entry refused (RequestLedger.unsupported): what to rewrite, and who sends it. */
export interface UnsupportedSql {
  /** the entry's id (src/duck/gaps.ts, docs/SQL-SUPPORT.md) */
  gap: string;
  /** what it is, in SQL's words (the entry's `what`); null for an id the registry no longer has (a row from an older Mason) */
  title: string | null;
  /** how many statements it refused */
  runs: number;
  /** the mason users and the clients (application_name) that sent them, each once, sorted ('' ones left out) */
  users: string[]; clients: string[];
  /** when the latest was refused, ISO 8601 UTC */
  last: string;
  /** the latest statement it refused, cut at UNSUPPORTED_EXAMPLE_CHARS (`…` says it was cut) */
  example: string;
}

/** how much of a statement `unsupported` shows as its example */
export const UNSUPPORTED_EXAMPLE_CHARS = 1000;

/** The query summary: the last day and the last week, and the days the log keeps. */
export interface QuerySummary { keptDays: number; day: QueryWindow; week: QueryWindow }

export interface LedgerOptions {
  /** days kept (MASON_HISTORY_DAYS) */
  days: number;
  /** a test's: how long a row waits before its batch is written */
  flushMs?: number;
  /** a test's: write each batch with this instead of the ledger's own connection (a failure to say) */
  insert?: (sql: string, values: DuckDBValue[]) => Promise<void>;
}

/** A user and client's statements in a time range (RequestLedger.clients). */
export interface ClientActivity {
  /** the mason user ('' for a token's session) and the token's name ('' for a user's) */
  user: string; tokenName: string;
  /** the client's application_name ('' when it sent none) */
  client: string;
  statements: number; failed: number; sessions: number;
  /** when the latest started, ISO 8601 UTC */
  last: string;
}

/**
 * A WINDOW FOLDED FROM THE GROUPS of a scan by SQLSTATE and a completed one's duration (`summary`, `window`): each
 * outcome by `outcomeOf` (the one rule), the average from the durations' sum, the p50 / p95 from the durations'
 * histogram as quantile_cont interpolates them (`quantileContOf`). ONE place adds a window up.
 */
function foldWindow(groups: ReadonlyArray<Record<string, unknown>>, days: number, keptDays: number): QueryWindow {
  const w: QueryWindow = { days, covered: Math.min(days, keptDays), statements: 0, completed: 0, refused: 0, failed: 0, cancelled: 0, rows: 0, bytesSent: 0, durationMs: null };
  const histogram: Array<[number, number]> = [];
  let duration = 0;
  for (const g of groups) {
    const n = Number(g.n);
    w.statements += n; w.rows += Number(g.sent_rows); w.bytesSent += Number(g.sent_bytes);
    const outcome = outcomeOf(g.sqlstate === null ? null : String(g.sqlstate));
    if (outcome === "ok") { w.completed += n; duration += Number(g.duration); histogram.push([Number(g.ms), n]); }
    else w[outcome] += n;
  }
  histogram.sort((a, b) => a[0] - b[0]);
  const p50 = quantileContOf(histogram, 0.5), p95 = quantileContOf(histogram, 0.95);
  if (w.completed > 0 && p50 !== null && p95 !== null) w.durationMs = { avg: Math.round(duration / w.completed), p50, p95 };
  return w;
}

export class RequestLedger {
  /** the next row's number (REQUESTS_SEQ_DDL): one past the ledger's last at open, then one per request recorded */
  private next = 0;
  /** rows lost since the last flush that succeeded: said once when the streak begins, and when it ends */
  private readonly lost = new Streak();
  private closed = false;

  private readonly history: History;
  private readonly batches: Batches<Numbered>;
  private readonly log: (line: string) => void;
  private readonly options: LedgerOptions;
  /** days kept */
  readonly days: number;

  private constructor(history: History, log: (line: string) => void, options: LedgerOptions) {
    this.history = history; this.log = log; this.options = options; this.days = options.days;
    this.batches = new Batches({ rows: BATCH_ROWS, ms: options.flushMs ?? FLUSH_MS, write: (rows) => this.write(rows) });
  }

  /** The ledger of a store: its table made, the rows past the retention deleted, and a trim every hour. */
  static async open(store: DuckStore, log: (line: string) => void, options: LedgerOptions): Promise<RequestLedger> {
    const history = await History.open(store, [REQUESTS_DDL, REQUESTS_USER_DDL, REQUESTS_SEQ_DDL, REQUESTS_JSON_DDL, REQUESTS_BYTES_DDL, REQUESTS_GAP_DDL, REQUESTS_ROLE_DDL, REQUESTS_ATTRIBUTES_DDL]);
    const ledger = new RequestLedger(history, log, options);
    ledger.next = Number((await history.reader.runAndReadAll(`SELECT coalesce(max(seq), -1) + 1 FROM ${REQUESTS_TABLE}`)).getRowsJS()[0]![0]);
    await history.keepTrimmed(() => ledger.trim(), (e) => log(`request log: deleting the requests older than ${ledger.days} days failed: ${e.message}`));
    return ledger;
  }

  /** One request, written with the next batch. Never throws: the statement it records was already answered. */
  record(row: ApiLogRow): void {
    // the listener closes before the ledger (mason stop), so nothing should arrive after: said if it does, never written
    if (this.closed) { this.log(`request log: a request after the log closed, not recorded (${row.requestId})`); return; }
    this.batches.push({ row, seq: this.next++ });
  }

  /** Writes what is waiting, after any flush in flight. Resolves whether it was written or not (a failure is said). */
  flush(): Promise<void> { return this.batches.flush(); }

  private async write(rows: Numbered[]): Promise<void> {
    const width = COLUMNS.length;
    const sql = `INSERT INTO ${REQUESTS_TABLE} (${COLUMNS.map((c) => c === "rows" ? `"rows"` : c).join(", ")}) VALUES ` +
      rows.map((_, i) => `(${COLUMNS.map((c, j) => `$${i * width + j + 1}${c === "started_at" ? "::TIMESTAMPTZ" : ""}`).join(", ")})`).join(", ");
    const values = rows.flatMap(valuesOf);
    try {
      if (this.options.insert !== undefined) await this.options.insert(sql, values);
      else await this.history.writer.run(sql, values);
    } catch (e) {
      // Tolerated, narrowly, as the ClickHouse writer tolerates it: the answers are sent, so there is no statement left
      // to fail, and a ledger that cannot write must not take the listener down. SAID, once per streak with the rows it
      // costs, so a ledger that stopped recording never reads as a quiet listener.
      this.lost.failed(rows.length, () => this.log(`request log: could not record ${rows.length} request(s) in ${REQUESTS_TABLE} (${rows[0]!.row.requestId}` +
        `${rows.length > 1 ? ` … ${rows[rows.length - 1]!.row.requestId}` : ""}): ${(e as Error).message}; said once until a write succeeds`));
      return;
    }
    this.lost.succeeded((n) => this.log(`request log: recording again; ${n} request(s) were not recorded`));
  }

  /** Deletes the requests older than the retention; the count is said when there were any. */
  async trim(): Promise<number> {
    const r = await this.history.writer.runAndReadAll(`DELETE FROM ${REQUESTS_TABLE} WHERE started_at < now() - INTERVAL (${this.days}) DAY`);
    const n = Number(r.getRowsJS()[0]?.[0] ?? 0);
    if (n > 0) this.log(`request log: deleted ${n} request(s) older than ${this.days} days (MASON_HISTORY_DAYS)`);
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
    if (q.minMs !== undefined) where.push(`duration_ms >= ${arg(q.minMs)}`);
    // a substring, any case: contains() takes the text as it is (no LIKE pattern to escape); a scan of the kept days, as every filter is
    if (q.search !== undefined) where.push(`contains(lower(coalesce(query, '')), lower(${arg(q.search)}))`);
    if (q.before !== undefined) {
      const at = arg(q.before.at, "::TIMESTAMPTZ");
      where.push(`(started_at < ${at} OR (started_at = ${at} AND coalesce(seq, -1) < ${arg(q.before.seq)}))`);
    }
    const limit = arg(q.limit);
    const rows = (await this.history.reader.runAndReadAll(`SELECT * FROM (SELECT * FROM ${REQUESTS_TABLE}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY started_at DESC, coalesce(seq, -1) DESC LIMIT ${limit}) ORDER BY started_at, coalesce(seq, -1)`, values)).getRowObjectsJson();
    return rows as Array<Record<string, unknown>>;
  }

  /**
   * THE QUERY SUMMARY of `mason status` (`/api/queries`): the statements of the last day and of the last 7 days — how
   * many, how many completed, refused, failed and cancelled, how long the completed ones took (average, p50, p95), the
   * rows and the bytes sent — in ONE scan of the ledger. A refused login (CONNECT) is not a statement. The log keeps
   * `days` days, so a window longer than that is `covered` only as far as it keeps (said, never a short week passed off
   * as a whole one).
   *
   * The scan is ONE GROUP BY — by the window (the last day or before it), the SQLSTATE, and a completed one's duration
   * (whole ms) — whose few groups are added up here: each outcome by `outcomeOf` (the one rule), the average from the
   * durations' sum, and the p50 / p95 from the durations' histogram as quantile_cont interpolates them
   * (`quantileContOf`), exact. Measured over a week of 50 statements a second (30 M rows): four quantile_cont and
   * sixteen FILTERed aggregates over the raw rows took 0.71–0.77 s, this ~0.12 s — and the Overview asks it every 30 s
   * (docs/OBSERVABILITY.md "Architecture review").
   */
  async summary(): Promise<QuerySummary> {
    const groups = (await this.history.reader.runAndReadAll(`SELECT started_at > now() - INTERVAL 1 DAY AS in_day, sqlstate, ` +
      `CASE WHEN ${outcomeSql("sqlstate")} = 'ok' THEN duration_ms END AS ms, count(*) AS n, sum(duration_ms) AS duration, ` +
      `coalesce(sum("rows"), 0) AS sent_rows, coalesce(sum(bytes_sent), 0) AS sent_bytes ` +
      `FROM ${REQUESTS_TABLE} WHERE started_at > now() - INTERVAL 7 DAY AND method <> 'CONNECT' GROUP BY ALL`)).getRowObjectsJson() as Array<Record<string, unknown>>;
    const windowOf = (days: 1 | 7): QueryWindow => foldWindow(days === 1 ? groups.filter((g) => g.in_day === true) : groups, days, this.days);
    return { keptDays: this.days, day: windowOf(1), week: windowOf(7) };
  }

  /**
   * ONE WINDOW OF THE REQUEST LOG from `since` (ISO 8601) to now — what the Usage page's cards say for its time range:
   * the statements, each outcome, the rows and bytes sent and the completed ones' durations, as `summary` folds a day,
   * by the same GROUP BY (`foldWindow`). `days` is the window's length in days (a fraction under one), `covered` as far
   * as the log keeps it.
   */
  async window(since: string, now = Date.now()): Promise<QueryWindow> {
    const groups = (await this.history.reader.runAndReadAll(`SELECT sqlstate, CASE WHEN ${outcomeSql("sqlstate")} = 'ok' THEN duration_ms END AS ms, count(*) AS n, ` +
      `sum(duration_ms) AS duration, coalesce(sum("rows"), 0) AS sent_rows, coalesce(sum(bytes_sent), 0) AS sent_bytes ` +
      `FROM ${REQUESTS_TABLE} WHERE started_at >= $1::TIMESTAMPTZ AND method <> 'CONNECT' GROUP BY ALL`, [since])).getRowObjectsJson() as Array<Record<string, unknown>>;
    return foldWindow(groups, Math.max(0, (now - Date.parse(since)) / 86_400_000), this.days);
  }

  /**
   * WHO CONNECTED from `since` on, by the statements they sent: a row per user and client (application_name) — its
   * statements, the failed ones (refused or failed, as the Failed card counts them: a cancel is not), the sessions they came from and when the latest started —
   * the most statements first, `limit` of them, and the totals over every one (`total`: how many clients, how many
   * sessions — a card says them, so they are never the first `limit`'s). A session that sent only what the log does not list (select 1, SET, a
   * catalog query) is not here; the live sessions are `/api/state`'s. Committed rows only.
   */
  async clients(since: string, limit = 50): Promise<{ clients: ClientActivity[]; total: { clients: number; sessions: number } }> {
    // the totals over EVERY client, before the LIMIT (a window over the groups): a card says them, never the first `limit`'s
    const rows = (await this.history.reader.runAndReadAll(`SELECT user_name, token_name, application_name, count(*) AS statements, ` +
      `count(*) OVER () AS total_clients, sum(count(DISTINCT session)) OVER () AS total_sessions, ` +
      `count(*) FILTER (WHERE (${outcomeSql("sqlstate")}) IN ('refused', 'failed')) AS failed, count(DISTINCT session) AS sessions, max(started_at) AS last ` +
      `FROM ${REQUESTS_TABLE} WHERE started_at >= $1::TIMESTAMPTZ AND method <> 'CONNECT' GROUP BY ALL ORDER BY statements DESC, last DESC LIMIT $2`,
    [since, limit])).getRowObjectsJson();
    const first = rows[0] as Record<string, unknown> | undefined;
    return { total: { clients: Number(first?.total_clients ?? 0), sessions: Number(first?.total_sessions ?? 0) },
      clients: rows.map((r) => ({ user: String(r.user_name ?? ""), tokenName: String(r.token_name ?? ""), client: String(r.application_name ?? ""),
        statements: Number(r.statements), failed: Number(r.failed), sessions: Number(r.sessions), last: new Date(String(r.last)).toISOString() })) };
  }

  /**
   * THE COMPLETED STATEMENTS' p50 AND p95 IN BUCKETS of `stepSeconds` from `since` until `until`, by when each started
   * (quantile_cont, as `summary`'s): what a chart of more than a minute a point plots. A bucket's p95 is the p95 of its
   * statements, never the highest of its minutes' p95s — one slow minute in an hour was the hour's "p95". By bucket
   * start, epoch ms; a bucket with no completed statement is absent. Committed rows only.
   */
  async durationsBy(since: string, until: string, stepSeconds: number): Promise<Map<number, { p50: number; p95: number }>> {
    const rows = (await this.history.reader.runAndReadAll(`SELECT epoch_ms(time_bucket(to_seconds($3::BIGINT), started_at, $1::TIMESTAMPTZ)) AS at, ` +
      `quantile_cont(duration_ms, 0.5) AS p50, quantile_cont(duration_ms, 0.95) AS p95 FROM ${REQUESTS_TABLE} ` +
      `WHERE started_at >= $1::TIMESTAMPTZ AND started_at < $2::TIMESTAMPTZ AND method <> 'CONNECT' AND (${outcomeSql("sqlstate")}) = 'ok' GROUP BY 1`,
    [since, until, stepSeconds])).getRowsJS();
    // rounded as the summary's and a sample's are (src/duck/usage.ts quantileCont): one ms, one definition
    return new Map(rows.map(([at, p50, p95]) => [Number(at), { p50: Math.round(Number(p50)), p95: Math.round(Number(p95)) }]));
  }

  /** The slowest `limit` completed statements started from `since` on, slowest first: what ran longest in a time range
   *  that is past (the Usage page's analogue of what runs now). Committed rows only. */
  async slowest(since: string, limit = 10): Promise<LedgerRequest[]> {
    const rows = (await this.history.reader.runAndReadAll(`SELECT * FROM ${REQUESTS_TABLE} WHERE started_at >= $1::TIMESTAMPTZ AND sqlstate IS NULL AND method <> 'CONNECT' ` +
      `ORDER BY duration_ms DESC, started_at DESC LIMIT $2`, [since, limit])).getRowObjectsJson();
    return (rows as Array<Record<string, unknown>>).map((r) => requestOf(r));
  }

  /**
   * The last day's slow statements in `mason status`'s shape (src/cli/run-server.ts SlowQuery): each distinct statement
   * whose LATEST answer still took `slowMs` or more, slowest first. Only a statement that took it at least once can,
   * so those are found first and only their runs are grouped (a day of 50 statements a second, 4.3 M rows: 0.21 s
   * grouping every statement's text, 0.07 s this way).
   */
  async slow(slowMs: number, limit = 5): Promise<SlowQuery[]> {
    const day = `sqlstate IS NULL AND started_at > now() - INTERVAL 1 DAY AND query <> '' AND NOT query_truncated`;
    const rows = (await this.history.reader.runAndReadAll(`SELECT query, count(*) AS runs, CAST(quantile_disc(duration_ms, 0.5) AS INTEGER) AS median_ms, ` +
      `max(duration_ms) AS max_ms, arg_max(duration_ms, started_at) AS latest_ms, max(started_at) AS last FROM ${REQUESTS_TABLE} ` +
      `WHERE ${day} AND query IN (SELECT query FROM ${REQUESTS_TABLE} WHERE ${day} AND duration_ms >= $1) ` +
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
    const rows = (await this.history.reader.runAndReadAll(`SELECT query, count(*) AS runs, max(started_at) AS last, arg_max(sqlstate, started_at) AS code, arg_max(message, started_at) AS message ` +
      `FROM ${REQUESTS_TABLE} WHERE ${day} GROUP BY query ORDER BY last DESC LIMIT $1`, [limit])).getRowObjectsJson();
    const total = Number((await this.history.reader.runAndReadAll(`SELECT count(*) FROM ${REQUESTS_TABLE} WHERE ${day}`)).getRowsJS()[0]?.[0] ?? 0);
    return { total, refused: rows.map((r) => ({ route: "postgres", payload: String(r.query), runs: Number(r.runs), last: new Date(String(r.last)).toISOString(),
      code: String(r.code), message: String(r.message ?? "") })) };
  }

  /**
   * THE REFUSED STATEMENTS GROUPED BY THE UNSUPPORTED SQL THEY USED (`/api/unsupported`, `mason status`): for each
   * registry entry that refused a statement started at or after `since`, how many it refused, by whom (users and
   * clients), when last, and the latest of them — the most refused first, `limit` entries, in ONE query. A statement
   * refused for any other reason (a missing table, a syntax error) has no entry, so it is not here. Committed rows only.
   */
  async unsupported(q: { since: string; limit: number }): Promise<UnsupportedSql[]> {
    const rows = (await this.history.reader.runAndReadAll(`SELECT gap, count(*) AS runs, ` +
      `coalesce(list_sort(list(DISTINCT user_name) FILTER (WHERE user_name <> '')), []) AS users, ` +
      `coalesce(list_sort(list(DISTINCT application_name) FILTER (WHERE application_name <> '')), []) AS clients, ` +
      `max(started_at) AS last, arg_max(query, started_at) AS example ` +
      `FROM ${REQUESTS_TABLE} WHERE gap IS NOT NULL AND started_at >= $1::TIMESTAMPTZ GROUP BY gap ORDER BY runs DESC, last DESC, gap LIMIT $2`,
    [q.since, q.limit])).getRowObjectsJson();
    return rows.map((r) => {
      const gap = String(r.gap);
      const query = String(r.example ?? "");
      return { gap, title: Object.hasOwn(GAPS, gap) ? GAPS[gap as GapId].what : null, runs: Number(r.runs),
        users: (r.users as unknown[]).map(String), clients: (r.clients as unknown[]).map(String), last: new Date(String(r.last)).toISOString(),
        example: query.length > UNSUPPORTED_EXAMPLE_CHARS ? `${query.slice(0, UNSUPPORTED_EXAMPLE_CHARS)}…` : query };
    });
  }

  /** Writes what is waiting and closes the ledger's connections (mason stop). */
  async close(): Promise<void> {
    this.history.stopTrimming();
    await this.flush();
    this.closed = true;
    this.history.closeConnections();
  }

  /**
   * When each `mason user` last ran a statement, within the log's retention: for each of `users` (a name and the window
   * it was a user in: `since` its addedAt, `until` its removedAt or null), the time of its newest request in that
   * window, ISO 8601, or null when the log has none. The window tells a user from an earlier one of the same name. A
   * refused login (28P01, 57P03) or an ended session (28000) is no use, so it does not count. Committed rows only.
   * ONE scan of the log for every user, JOINED to the users' windows (a hash join on the name, the window a residual),
   * never one per user — nor a `max … FILTER` per user, which evaluated every user's filter on every row: on a week of
   * 50 statements a second (30 M rows) 0.18 s for 6 users and 2.2–2.8 s for 66, where the join is ~0.15 s for any
   * number; the Users page asks it every 30 s (docs/OBSERVABILITY.md "Architecture review").
   */
  async lastUsed(users: ReadonlyArray<{ name: string; since: string; until: string | null }>): Promise<Array<string | null>> {
    if (users.length === 0) return [];
    const params: DuckDBValue[] = [];
    const at = (v: string | number | null): string => { params.push(v); return `$${params.length}`; };
    const windows = users.map((u, i) => `(${at(i)}::INTEGER, ${at(u.name)}::VARCHAR, ${at(u.since)}::TIMESTAMPTZ, ${at(u.until)}::TIMESTAMPTZ)`).join(", ");
    const found = (await this.history.reader.runAndReadAll(`SELECT u.i, epoch_ms(max(r.started_at)) AS at FROM (VALUES ${windows}) AS u(i, name, since, until) ` +
      `JOIN ${REQUESTS_TABLE} r ON r.user_name = u.name AND r.started_at >= u.since AND (u.until IS NULL OR r.started_at <= u.until) ` +
      `WHERE r.sqlstate IS NULL OR r.sqlstate NOT IN ('28P01', '57P03', '28000') GROUP BY u.i`, params)).getRowsJS();
    const row = new Map(found.map(([i, ms]) => [Number(i), ms]));
    return users.map((_, i) => { const ms = row.get(i); return ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString(); });
  }
}
