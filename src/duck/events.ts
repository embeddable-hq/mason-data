/**
 * THE SYNC'S EVENTS (`_mason.sync_events`): a copy failed, a poll failed, a catch-up failed, the stream failed or
 * refused a table, the database could not be reached — and the notable good news beside them: a copy finished, a
 * table current again after a failure. Before this a sync failure was kept only as a table's CURRENT error (the next
 * success wiped it) and, before that one, only in the log file: `mason status` could not say what went wrong an hour ago.
 *
 * Kept as the request log is kept (src/duck/history.ts, the frame both share): rows wait here for at most FLUSH_MS and go in ONE INSERT, on a
 * connection of the events' own — never the sync's writer turn (`onWriter`), which a swap or a stream batch may hold
 * for seconds; a read is on a third connection and sees committed batches only; a write that fails is said once with
 * the events it cost, and again when a write succeeds after it, and it NEVER fails the sync that recorded it (the
 * sync's own state and log line are written either way). Kept `MASON_HISTORY_DAYS` days.
 *
 * A failure repeated word for word is ONE event (`REPEAT_MS`): a database away fails every pass, every few seconds,
 * and a list of the same line buries the one before it. It is written again once it was over in between, or an hour
 * later: a table's failure is over when the table is current again (`recovered`) or copied anew (`full_sync`); a failure
 * of the whole sync (`table: null`: the stream, the database) when the sync says it is (`recovered` of no table: the
 * stream applied a batch again, the database attached again), which ends every whole-sync failure's repeat at once —
 * an extra event at worst, never a failure dropped. While it lasts, the table's own `error` (mason status) says it.
 *
 * The run's RESTARTS are not here: the supervisor that records them is a process of its own, which cannot open the
 * file DuckDB holds, so it writes `.mason/restarts.json` (src/cli/supervise.ts) and the reader merges them
 * (`withRestarts`).
 *
 * The Postgres catalog never lists `_mason`, so a tool connected to the listener cannot read the events.
 */
import { maskPasswordKeyword } from "../lib/secret-mask.ts";
import type { DuckDBValue } from "@duckdb/node-api";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";
import { Batches, History, Streak, cutoff } from "./history.ts";
import { UNKNOWN_CODE, failureCode, originOf } from "../lib/failure-facts.ts";

/** One restart of the run as its supervisor records it in `.mason/restarts.json` (src/cli/supervise.ts, a process of
 *  its own): when, why the run stopped, how long it had been up. */
export interface Restart { at: string; reason: string; upSeconds: number }

export const EVENTS_TABLE = `${MASON_SCHEMA}.sync_events`;
export const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (happened_at TIMESTAMPTZ, seq BIGINT, kind VARCHAR, table_name VARCHAR, message VARCHAR, code VARCHAR, origin VARCHAR)`;
/** A FAILURE'S CODE AND ORIGIN (issue 924; src/lib/failure-facts.ts): a store made before gains the columns, its old
 *  rows NULL (read as null) */
export const EVENTS_CODE_DDL = `ALTER TABLE ${EVENTS_TABLE} ADD COLUMN IF NOT EXISTS code VARCHAR`;
export const EVENTS_ORIGIN_DDL = `ALTER TABLE ${EVENTS_TABLE} ADD COLUMN IF NOT EXISTS origin VARCHAR`;

/**
 * WHAT AN EVENT IS, one word each: `full_sync_failed`, `poll_failed`, `catch_up_failed` (the one poll that brings a new copy
 * current), `stream_failed` (the stream stopped, or refused a table: `table` says which), `source_unreachable` (the
 * database could not be attached), `generated_failed` (a generated table's re-run failed, and it serves what it held),
 * `compact_failed` (a synced table's compaction failed: it serves and is kept current as it was, and is compacted again
 * after a back-off, src/duck/sync.ts `compact`), `restart` (the supervisor started the run again after it died), `ui_error` (the web page met an error of its own: where,
 * never its words, src/cli/ui-errors.ts) — each a failure;
 * `full_sync` (a copy, the first sync or a full read again, finished and was swapped in), `recovered` (a table whose poll, catch-up, stream or re-run failed is
 * current again; of no table, the stream applying changes or the database attached again after it failed) and
 * `synced` (a sync asked by hand — mason sync, the page's Sync now — and what it did), and `sync_changed` (a table's
 * `sync:` in the sources file changed while it is copied: from what, to what, and how its copy is caught up).
 *
 * THE SCHEDULED SYNCS (`SCHEDULED`): `polled` (a poll on the table's schedule that succeeded, and what it did) and
 * `streamed` (a table's changes the stream applied in the last minute, ONE row a table a minute, and only in a minute
 * it applied some: a busy database's batches, many a second, never a row each). They are kept as the others are, but a
 * reader gets them only when it asks (`EventsQuery.scheduled`): one every few seconds would bury the failures, and push
 * them past the newest `limit` a reader asks for. A poll is at most one a second a table (`poll 1s`, the floor), so a
 * table writes at most 86,400 rows a day, MASON_HISTORY_DAYS kept; a streamed table 1,440.
 */
export const EVENT_KINDS = ["full_sync_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "generated_failed", "compact_failed", "restart", "full_sync", "recovered", "synced", "sync_changed", "polled", "streamed", "ui_error"] as const;
export type SyncEventKind = (typeof EVENT_KINDS)[number];
const FAILURES: ReadonlySet<SyncEventKind> = new Set(["full_sync_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "generated_failed", "compact_failed", "restart", "ui_error"]);
/** whether an event of this kind is a failure: the one place that says it (the reader's filter, `failed`) */
export const isFailure = (kind: SyncEventKind): boolean => FAILURES.has(kind);
/** the scheduled syncs' kinds: listed only when a reader asks for them (`EventsQuery.scheduled`) */
export const SCHEDULED: ReadonlySet<SyncEventKind> = new Set(["polled", "streamed"]);

/** One event as the commands read it (`mason logs --events --json`, `/api/events`, `mason status --json` recentErrors). */
export interface SyncEvent {
  /** when it happened, ISO 8601 UTC */
  at: string;
  kind: SyncEventKind;
  /** a failure (`isFailure`), else good news */
  failed: boolean;
  /** the table it is of (`schema.table`), or null for the whole sync (the stream, the database, the run) or the web page */
  table: string | null;
  /** what happened, in the log's own words (its first line is the reason; further lines are its detail) */
  message: string;
  /** A FAILURE'S CODE (src/lib/failure-facts.ts `failureCode`): its SQLSTATE when it came from Postgres, its errno
   *  when it came from the system (`ECONNREFUSED`, `ENOSPC`), the engine's error class (`conversion_error`), the page's
   *  error class for a `ui_error` (`TypeError`), else `unknown` (a restart's always); null for good news, and for an
   *  event recorded before codes were kept */
  code: string | null;
  /** A FAILURE'S ORIGIN: the first stack frame in Mason's own code, as a file and a line (`src/duck/sync.ts:1234`),
   *  for a `ui_error` the page's own script (`src/web/app.js:12`); null for good news, a restart, a failure with no
   *  frame in Mason's code, and an event recorded before origins were kept */
  origin: string | null;
}
/**
 * What the sync records: the time, `failed` and a restart are the events' own. A failure gives the error it caught
 * (`cause`), which its code and origin are read from (never its words beyond the message); or, where it caught none (a
 * gap it found, the page's report), its `code` and `origin` as it knows them.
 */
export interface SyncEventInput { kind: Exclude<SyncEventKind, "restart">; table: string | null; message: string; cause?: unknown; code?: string; origin?: string | null }

const FLUSH_MS = 1000;
const BATCH_ROWS = 500;
/** a failure said word for word again within this is the event already written (unless it was over between: `record`) */
export const REPEAT_MS = 60 * 60 * 1000;

interface Pending { at: Date; seq: number; e: SyncEventInput; code: string | null; origin: string | null }

export interface EventsOptions {
  /** days kept (MASON_HISTORY_DAYS) */
  days: number;
  /** a test's: how long an event waits before its batch is written */
  flushMs?: number;
  /** a test's: write each batch with this instead of the events' own connection (a failure to say) */
  insert?: (sql: string, values: DuckDBValue[]) => Promise<void>;
  /** a test's clock */
  now?: () => number;
}

export class SyncEvents {
  private next = 0;
  private readonly lost = new Streak();
  private closed = false;
  /** each failure's last event, by kind and table: a repeat within REPEAT_MS is not written again */
  private readonly lastFailure = new Map<string, { message: string; at: number }>();

  private readonly history: History;
  private readonly batches: Batches<Pending>;
  private readonly log: (line: string) => void;
  private readonly options: EventsOptions;
  readonly days: number;

  private constructor(history: History, log: (line: string) => void, options: EventsOptions) {
    this.history = history; this.log = log; this.options = options; this.days = options.days;
    this.batches = new Batches({ rows: BATCH_ROWS, ms: options.flushMs ?? FLUSH_MS, write: (rows) => this.write(rows) });
  }

  /** The events of a store: their table made, the events past the retention deleted, and a trim every hour. */
  static async open(store: DuckStore, log: (line: string) => void, options: EventsOptions): Promise<SyncEvents> {
    const history = await History.open(store, [EVENTS_DDL, EVENTS_CODE_DDL, EVENTS_ORIGIN_DDL]);
    const events = new SyncEvents(history, log, options);
    events.next = Number((await history.reader.runAndReadAll(`SELECT coalesce(max(seq), -1) + 1 FROM ${EVENTS_TABLE}`)).getRowsJS()[0]![0]);
    await history.keepTrimmed(() => events.trim(), (e) => log(`sync events: deleting the events older than ${events.days} days failed: ${e.message}`));
    return events;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** One event, written with the next batch. Never throws: the sync that records it goes on whatever happens here. */
  record(e: SyncEventInput): void {
    if (this.closed) { this.log(`sync events: an event after they closed, not recorded (${e.kind}${e.table ? ` ${e.table}` : ""}: ${e.message.split("\n")[0]})`); return; }
    const now = this.now();
    // a failure over (its table current again or copied anew; of no table, the whole sync's) is said again when it recurs
    if (e.kind === "recovered" || e.kind === "full_sync") { for (const k of [...this.lastFailure.keys()]) if (k.endsWith(`\0${e.table ?? ""}`)) this.lastFailure.delete(k); }
    else if (isFailure(e.kind)) {
      const key = `${e.kind}\0${e.table ?? ""}`;
      const last = this.lastFailure.get(key);
      if (last !== undefined && last.message === e.message && now - last.at < REPEAT_MS) return;
      this.lastFailure.set(key, { message: e.message, at: now });
    }
    // a failure's code and origin, read now from what it caught (its stack is the error's, never this call's)
    const failed = isFailure(e.kind);
    const code = !failed ? null : e.code ?? (e.cause === undefined ? UNKNOWN_CODE : failureCode(e.cause));
    const origin = !failed ? null : e.origin !== undefined ? e.origin : e.cause === undefined ? null : originOf(e.cause);
    this.batches.push({ at: new Date(now), seq: this.next++, e, code, origin });
  }

  /** Writes what is waiting, after any flush in flight. Resolves whether it was written or not (a failure is said). */
  flush(): Promise<void> { return this.batches.flush(); }

  private async write(rows: Pending[]): Promise<void> {
    const sql = `INSERT INTO ${EVENTS_TABLE} (happened_at, seq, kind, table_name, message, code, origin) VALUES ` +
      rows.map((_, i) => `($${i * 7 + 1}::TIMESTAMPTZ, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`).join(", ");
    const values = rows.flatMap((r): DuckDBValue[] => [r.at.toISOString(), r.seq, r.e.kind, r.e.table, r.e.message, r.code, r.origin]);
    try {
      if (this.options.insert !== undefined) await this.options.insert(sql, values);
      else await this.history.writer.run(sql, values);
    } catch (e) {
      // Tolerated, narrowly, as the request log's: the sync's own state and log line hold the event, and a record that
      // cannot be written must not stop the sync. SAID, once per streak with what it cost
      this.lost.failed(rows.length, () => this.log(`sync events: could not record ${rows.length} event(s) in ${EVENTS_TABLE} (${rows[0]!.e.kind}${rows[0]!.e.table ? ` ${rows[0]!.e.table}` : ""}): ` +
        `${(e as Error).message}; said once until a write succeeds (the log has each one)`));
      return;
    }
    this.lost.succeeded((n) => this.log(`sync events: recording again; ${n} event(s) were not recorded (the log has them)`));
  }

  /** Deletes the events older than the retention; the count is said when there were any. The retention is counted back
   *  from the module's ONE clock (`now`, which stamps each event), never the engine's `now()`: two clocks disagree
   *  whenever the clock is given, and a trim by the other deleted what the given clock still kept. */
  async trim(): Promise<number> {
    const r = await this.history.writer.runAndReadAll(`DELETE FROM ${EVENTS_TABLE} WHERE happened_at < $1::TIMESTAMPTZ`, [cutoff(this.now(), this.days)]);
    const n = Number(r.getRowsJS()[0]?.[0] ?? 0);
    if (n > 0) this.log(`sync events: deleted ${n} event(s) older than ${this.days} days (MASON_HISTORY_DAYS)`);
    return n;
  }

  /** The newest `limit` events, newest LAST; `since`: at or after it; `failed`: the failures only; `scheduled`: the
   *  scheduled syncs too (else left out, in the query, so they never take a place of the `limit`). Committed ones only. */
  async recent(o: EventsQuery): Promise<SyncEvent[]> {
    const where: string[] = [];
    const values: DuckDBValue[] = [o.limit];
    if (o.failed) where.push(`kind IN (${[...FAILURES].map((k) => `'${k}'`).join(", ")})`);
    else if (o.scheduled !== true) where.push(`kind NOT IN (${[...SCHEDULED].map((k) => `'${k}'`).join(", ")})`);
    if (o.since !== undefined) { values.push(o.since); where.push(`happened_at >= $${values.length}::TIMESTAMPTZ`); }
    const rows = (await this.history.reader.runAndReadAll(`SELECT * FROM (SELECT epoch_ms(happened_at) AS ms, seq, kind, table_name, message, code, origin FROM ${EVENTS_TABLE}` +
      `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY happened_at DESC, seq DESC LIMIT $1) ORDER BY ms, seq`, values)).getRowsJS() as Array<[bigint | number, bigint, string, string | null, string, string | null, string | null]>;
    return rows.map(([ms, , kind, table, message, code, origin]) => eventOf(new Date(Number(ms)).toISOString(), kind as SyncEventKind, table, message, code, origin));
  }

  /** Writes what is waiting and closes the events' connections (mason stop). */
  async close(): Promise<void> {
    this.history.stopTrimming();
    await this.flush();
    this.closed = true;
    this.history.closeConnections();
  }
}

/** What a reader asks of the events: how many (the newest), from when (ISO), the failures only, the scheduled syncs too. */
export interface EventsQuery { limit: number; since?: string; failed?: boolean; scheduled?: boolean }

/** an event as read back, any `password=` value in its message masked (src/lib/secret-mask.ts `maskPasswordKeyword`,
 *  the exact form an earlier Mason leaked, issue 599: the sync scrubs those rows at open, and this holds should one stay) */
const eventOf = (at: string, kind: SyncEventKind, table: string | null, message: string, code: string | null = null, origin: string | null = null): SyncEvent =>
  ({ at, kind, failed: isFailure(kind), table, message: maskPasswordKeyword(message), code, origin });

/**
 * THE EVENTS WITH THE RUN'S RESTARTS (src/cli/supervise.ts `.mason/restarts.json`), as ONE list newest last, asked as
 * `recent` is (the newest `limit`, since, the failures only — a restart is one), within the retention as the events are.
 */
export function withRestarts(events: readonly SyncEvent[], restarts: readonly Restart[], o: EventsQuery & { days: number; now?: number }): SyncEvent[] {
  const from = Math.max(o.since === undefined ? -Infinity : Date.parse(o.since), (o.now ?? Date.now()) - o.days * 86_400_000);
  const said = restarts.filter((r) => Date.parse(r.at) >= from)
    .map((r) => eventOf(new Date(r.at).toISOString(), "restart", null, `the run stopped (${r.reason}) after ${r.upSeconds} s up, and its supervisor started it again`,
      // the supervisor records why in words alone, and the run's frames died with it
      UNKNOWN_CODE, null));
  // a stable sort: an event and a restart of one millisecond keep the events' order, the restart after
  return [...events, ...said].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-o.limit);
}
