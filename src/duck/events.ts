/**
 * THE SYNC'S EVENTS (`_mason.sync_events`): a copy failed, a poll failed, a catch-up failed, the stream failed or
 * refused a table, the database could not be reached — and the notable good news beside them: a copy finished, a
 * table current again after a failure. Before this a sync failure was kept only as a table's CURRENT error (the next
 * success wiped it) and, before that one, only in the log file: `mason status` could not say what went wrong an hour ago.
 *
 * Kept as the request log is kept (src/duck/requests.ts): rows wait here for at most FLUSH_MS and go in ONE INSERT, on a
 * connection of the events' own — never the sync's writer turn (`onWriter`), which a swap or a stream batch may hold
 * for seconds; a read is on a third connection and sees committed batches only; a write that fails is said once with
 * the events it cost, and again when a write succeeds after it, and it NEVER fails the sync that recorded it (the
 * sync's own state and log line are written either way). Kept `MASON_REQUEST_LOG_DAYS` days.
 *
 * A failure repeated word for word is ONE event (`REPEAT_MS`): a database away fails every pass, every few seconds,
 * and a list of the same line buries the one before it. It is written again once its table is current again in
 * between (`recovered`), or an hour later. While it lasts, the table's own `error` (mason status) says it.
 *
 * The run's RESTARTS are not here: the supervisor that records them is a process of its own, which cannot open the
 * file DuckDB holds, so it writes `.mason/restarts.json` (src/cli/supervise.ts) and the reader merges them
 * (`withRestarts`).
 *
 * The Postgres catalog never lists `_mason`, so a tool connected to the listener cannot read the events.
 */
import type { DuckDBValue } from "@duckdb/node-api";
import type { DuckConnection } from "./executor.ts";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";
import type { Restart } from "../cli/supervise.ts";

export const EVENTS_TABLE = `${MASON_SCHEMA}.sync_events`;
export const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (happened_at TIMESTAMPTZ, seq BIGINT, kind VARCHAR, table_name VARCHAR, message VARCHAR)`;

/**
 * WHAT AN EVENT IS, one word each: `copy_failed`, `poll_failed`, `catch_up_failed` (the one poll that brings a new copy
 * current), `stream_failed` (the stream stopped, or refused a table: `table` says which), `source_unreachable` (the
 * database could not be attached), `restart` (the supervisor started the run again after it died) — each a failure;
 * `copied` (a copy finished and was swapped in) and `recovered` (a table whose poll, catch-up or stream failed is
 * current again).
 */
export const EVENT_KINDS = ["copy_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "restart", "copied", "recovered"] as const;
export type SyncEventKind = (typeof EVENT_KINDS)[number];
const FAILURES: ReadonlySet<SyncEventKind> = new Set(["copy_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "restart"]);
/** whether an event of this kind is a failure: the one place that says it (the reader's filter, `failed`) */
export const isFailure = (kind: SyncEventKind): boolean => FAILURES.has(kind);

/** One event as the commands read it (`mason logs --events --json`, `/api/events`, `mason status --json` recentErrors). */
export interface SyncEvent {
  /** when it happened, ISO 8601 UTC */
  at: string;
  kind: SyncEventKind;
  /** a failure (`isFailure`), else good news */
  failed: boolean;
  /** the table it is of (`schema.table`), or null for the whole sync (the stream, the database, the run) */
  table: string | null;
  /** what happened, in the log's own words (its first line is the reason; further lines are its detail) */
  message: string;
}
/** what the sync records: the time, `failed` and a restart are the events' own */
export interface SyncEventInput { kind: Exclude<SyncEventKind, "restart">; table: string | null; message: string }

const FLUSH_MS = 1000;
const BATCH_ROWS = 500;
const TRIM_EVERY_MS = 60 * 60 * 1000;
/** a failure said word for word again within this is the event already written (unless its table recovered between) */
export const REPEAT_MS = 60 * 60 * 1000;

interface Pending { at: Date; seq: number; e: SyncEventInput }

export interface EventsOptions {
  /** days kept (MASON_REQUEST_LOG_DAYS) */
  days: number;
  /** a test's: how long an event waits before its batch is written */
  flushMs?: number;
  /** a test's: write each batch with this instead of the events' own connection (a failure to say) */
  insert?: (sql: string, values: DuckDBValue[]) => Promise<void>;
  /** a test's clock */
  now?: () => number;
}

export class SyncEvents {
  private buffer: Pending[] = [];
  private next = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trimTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private lost = 0;
  private closed = false;
  /** each failure's last event, by kind and table: a repeat within REPEAT_MS is not written again */
  private readonly lastFailure = new Map<string, { message: string; at: number }>();

  private readonly writer: DuckConnection;
  private readonly reader: DuckConnection;
  private readonly log: (line: string) => void;
  private readonly options: EventsOptions;
  readonly days: number;

  private constructor(writer: DuckConnection, reader: DuckConnection, log: (line: string) => void, options: EventsOptions) {
    this.writer = writer; this.reader = reader; this.log = log; this.options = options; this.days = options.days;
  }

  /** The events of a store: their table made, the events past the retention deleted, and a trim every hour. */
  static async open(store: DuckStore, log: (line: string) => void, options: EventsOptions): Promise<SyncEvents> {
    const writer = await store.instance.connect();
    await writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
    await writer.run(EVENTS_DDL);
    const reader = await store.instance.connect();
    const events = new SyncEvents(writer, reader, log, options);
    events.next = Number((await reader.runAndReadAll(`SELECT coalesce(max(seq), -1) + 1 FROM ${EVENTS_TABLE}`)).getRowsJS()[0]![0]);
    await events.trim();
    events.trimTimer = setInterval(() => {
      events.trim().catch((e: unknown) => log(`sync events: deleting the events older than ${events.days} days failed: ${(e as Error).message}`));
    }, TRIM_EVERY_MS);
    events.trimTimer.unref();
    return events;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** One event, written with the next batch. Never throws: the sync that records it goes on whatever happens here. */
  record(e: SyncEventInput): void {
    if (this.closed) { this.log(`sync events: an event after they closed, not recorded (${e.kind}${e.table ? ` ${e.table}` : ""}: ${e.message.split("\n")[0]})`); return; }
    const now = this.now();
    if (e.kind === "recovered") { for (const k of [...this.lastFailure.keys()]) if (k.endsWith(`\0${e.table ?? ""}`)) this.lastFailure.delete(k); }
    else if (isFailure(e.kind)) {
      const key = `${e.kind}\0${e.table ?? ""}`;
      const last = this.lastFailure.get(key);
      if (last !== undefined && last.message === e.message && now - last.at < REPEAT_MS) return;
      this.lastFailure.set(key, { message: e.message, at: now });
    }
    this.buffer.push({ at: new Date(now), seq: this.next++, e });
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

  private async write(rows: Pending[]): Promise<void> {
    const sql = `INSERT INTO ${EVENTS_TABLE} (happened_at, seq, kind, table_name, message) VALUES ` +
      rows.map((_, i) => `($${i * 5 + 1}::TIMESTAMPTZ, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ");
    const values = rows.flatMap((r): DuckDBValue[] => [r.at.toISOString(), r.seq, r.e.kind, r.e.table, r.e.message]);
    try {
      if (this.options.insert !== undefined) await this.options.insert(sql, values);
      else await this.writer.run(sql, values);
    } catch (e) {
      // Tolerated, narrowly, as the request log's: the sync's own state and log line hold the event, and a record that
      // cannot be written must not stop the sync. SAID, once per streak with what it cost
      if (this.lost === 0) this.log(`sync events: could not record ${rows.length} event(s) in ${EVENTS_TABLE} (${rows[0]!.e.kind}${rows[0]!.e.table ? ` ${rows[0]!.e.table}` : ""}): ` +
        `${(e as Error).message}; said once until a write succeeds (the log has each one)`);
      this.lost += rows.length;
      return;
    }
    if (this.lost > 0) { this.log(`sync events: recording again; ${this.lost} event(s) were not recorded (the log has them)`); this.lost = 0; }
  }

  /** Deletes the events older than the retention; the count is said when there were any. */
  async trim(): Promise<number> {
    const r = await this.writer.runAndReadAll(`DELETE FROM ${EVENTS_TABLE} WHERE happened_at < now() - INTERVAL (${this.days}) DAY`);
    const n = Number(r.getRowsJS()[0]?.[0] ?? 0);
    if (n > 0) this.log(`sync events: deleted ${n} event(s) older than ${this.days} days (MASON_REQUEST_LOG_DAYS)`);
    return n;
  }

  /** The newest `limit` events, newest LAST; `since`: at or after it; `failed`: the failures only. Committed ones only. */
  async recent(o: EventsQuery): Promise<SyncEvent[]> {
    const where: string[] = [];
    const values: DuckDBValue[] = [o.limit];
    if (o.failed) where.push(`kind IN (${[...FAILURES].map((k) => `'${k}'`).join(", ")})`);
    if (o.since !== undefined) { values.push(o.since); where.push(`happened_at >= $${values.length}::TIMESTAMPTZ`); }
    const rows = (await this.reader.runAndReadAll(`SELECT * FROM (SELECT epoch_ms(happened_at) AS ms, seq, kind, table_name, message FROM ${EVENTS_TABLE}` +
      `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY happened_at DESC, seq DESC LIMIT $1) ORDER BY ms, seq`, values)).getRowsJS() as Array<[bigint | number, bigint, string, string | null, string]>;
    return rows.map(([ms, , kind, table, message]) => eventOf(new Date(Number(ms)).toISOString(), kind as SyncEventKind, table, message));
  }

  /** Writes what is waiting and closes the events' connections (mason stop). */
  async close(): Promise<void> {
    if (this.trimTimer !== null) { clearInterval(this.trimTimer); this.trimTimer = null; }
    await this.flush();
    this.closed = true;
    this.writer.closeSync();
    this.reader.closeSync();
  }
}

/** What a reader asks of the events: how many (the newest), from when (ISO), the failures only. */
export interface EventsQuery { limit: number; since?: string; failed?: boolean }

const eventOf = (at: string, kind: SyncEventKind, table: string | null, message: string): SyncEvent => ({ at, kind, failed: isFailure(kind), table, message });

/**
 * THE EVENTS WITH THE RUN'S RESTARTS (src/cli/supervise.ts `.mason/restarts.json`), as ONE list newest last, asked as
 * `recent` is (the newest `limit`, since, the failures only — a restart is one), within the retention as the events are.
 */
export function withRestarts(events: readonly SyncEvent[], restarts: readonly Restart[], o: EventsQuery & { days: number; now?: number }): SyncEvent[] {
  const from = Math.max(o.since === undefined ? -Infinity : Date.parse(o.since), (o.now ?? Date.now()) - o.days * 86_400_000);
  const said = restarts.filter((r) => Date.parse(r.at) >= from)
    .map((r) => eventOf(new Date(r.at).toISOString(), "restart", null, `the run stopped (${r.reason}) after ${r.upSeconds} s up, and its supervisor started it again`));
  // a stable sort: an event and a restart of one millisecond keep the events' order, the restart after
  return [...events, ...said].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-o.limit);
}
