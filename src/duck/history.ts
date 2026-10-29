/**
 * THE FRAME OF A HISTORY TABLE, shared by the request log (src/duck/requests.ts), the sync's events (src/duck/events.ts)
 * and usage over time (src/duck/usage.ts) — each said what it keeps in its own module; this is how each is kept:
 *
 * - TWO CONNECTIONS of its own (`History.open`): a writer, never the sync's writer turn (`onWriter`), which a copy's swap
 *   or a stream batch may hold for seconds (DuckDB's MVCC lets two connections write two tables at once), and a reader,
 *   which sees committed rows only. Its schema and tables are made (and its columns added) at open, on the writer.
 * - TRIMMED to the retention at open and every hour (`keepTrimmed`); an hourly trim that fails is said, and tried again
 *   the next hour.
 * - WRITTEN IN BATCHES where rows arrive often (`Batches`): a row waits at most a flush's time, or until a batch's rows
 *   have gathered, and goes in ONE INSERT; one batch at a time, so batches commit in the order they were taken.
 * - A FAILURE SAID ONCE PER STREAK (`Streak`): a write that fails is said once with what it cost, and again when a write
 *   succeeds after it — never once a second, and never silent. It never fails what recorded the row.
 * - CLOSED by its owner: the trim stopped, what is waiting written, both connections closed.
 */
import type { DuckConnection } from "./executor.ts";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";

/** How many days every history table keeps (the request log, the sync's events, the usage samples, the copies'
 *  sizes) unless MASON_HISTORY_DAYS says. */
export const DEFAULT_HISTORY_DAYS = 7;

/** The days MASON_HISTORY_DAYS keeps, or why the text is not a number of days. Unset or empty: the default. */
export function historyDays(text: string | undefined): number | { problem: string } {
  if (text === undefined || text.trim() === "") return DEFAULT_HISTORY_DAYS;
  const days = Number(text);
  if (!Number.isInteger(days) || days < 1) {
    return { problem: `MASON_HISTORY_DAYS=${JSON.stringify(text)} is not a number of days: write a whole number, 1 or more (unset, ${DEFAULT_HISTORY_DAYS})` };
  }
  return days;
}

/**
 * `MASON_REQUEST_LOG_DAYS` SET IS REFUSED, never run on the default (CLAUDE.md: a renamed setting refuses the start,
 * naming the line to write): it kept the request log alone once, and the days kept are every history table's now, so it
 * is MASON_HISTORY_DAYS. Null when it is unset; else what is wrong, why and the way out — a Failure's fields for `mason
 * start` (before it spawns, and the run itself), joined on one line of `mason serve`'s settings report
 * (`historyDaysRenamedText`).
 */
export function historyDaysRenamed(env: Readonly<Record<string, string | undefined>>): { message: string; why: string; fix: string } | null {
  const v = env.MASON_REQUEST_LOG_DAYS;
  if (v === undefined || v === "") return null;
  return { message: `MASON_REQUEST_LOG_DAYS=${v} is no longer read`,
    why: "it was renamed MASON_HISTORY_DAYS, since the days it keeps are every history's (the request log, the sync's events, the usage samples and the copies' sizes)",
    fix: `write MASON_HISTORY_DAYS=${v.trim()} instead, then unset MASON_REQUEST_LOG_DAYS` };
}

/** the same, as one line */
export function historyDaysRenamedText(env: Readonly<Record<string, string | undefined>>): string | null {
  const r = historyDaysRenamed(env);
  return r === null ? null : `${r.message}: ${r.why} — ${r.fix}`;
}

/** how often the rows past the retention are deleted (and once at open) */
export const TRIM_EVERY_MS = 60 * 60 * 1000;

/** A history table's connections and its hourly trim. */
export class History {
  readonly writer: DuckConnection;
  readonly reader: DuckConnection;
  private trimTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(writer: DuckConnection, reader: DuckConnection) { this.writer = writer; this.reader = reader; }

  /** The writer connected, `_mason` and each of `ddl` run on it in order, then the reader connected. */
  static async open(store: DuckStore, ddl: readonly string[]): Promise<History> {
    const writer = await store.instance.connect();
    await writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
    for (const d of ddl) await writer.run(d);
    const reader = await store.instance.connect();
    return new History(writer, reader);
  }

  /** `trim` now (its failure is the open's), then every TRIM_EVERY_MS, an hourly one that fails said by `failed`. */
  async keepTrimmed(trim: () => Promise<unknown>, failed: (e: Error) => void): Promise<void> {
    await trim();
    this.trimTimer = setInterval(() => { trim().catch((e: unknown) => failed(e as Error)); }, TRIM_EVERY_MS);
    this.trimTimer.unref();
  }

  /** No more hourly trims (the first step of a close). */
  stopTrimming(): void {
    if (this.trimTimer !== null) { clearInterval(this.trimTimer); this.trimTimer = null; }
  }

  /** Both connections closed (the last step of a close). */
  closeConnections(): void {
    this.writer.closeSync();
    this.reader.closeSync();
  }
}

/** A streak of failures, said once: `failed` says the first of a streak and counts what each cost; `succeeded` says,
 *  once, what the streak cost, and ends it. */
export class Streak {
  private lost = 0;
  failed(cost: number, sayFirst: () => void): void {
    if (this.lost === 0) sayFirst();
    this.lost += cost;
  }
  succeeded(sayEnd: (lost: number) => void): void {
    if (this.lost > 0) { sayEnd(this.lost); this.lost = 0; }
  }
}

/** Rows written in batches: `push` one; a batch is written by `write` once `rows` are waiting or after `ms`, one batch
 *  at a time. `write` must not throw: a failure is its own to say (a Streak). */
export class Batches<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** the write in flight: one at a time, so batches commit in the order they were taken */
  private flushing: Promise<void> = Promise.resolve();
  private readonly rows: number;
  private readonly ms: number;
  private readonly write: (rows: T[]) => Promise<void>;

  constructor(o: { rows: number; ms: number; write: (rows: T[]) => Promise<void> }) { this.rows = o.rows; this.ms = o.ms; this.write = o.write; }

  push(row: T): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.rows) { void this.flush(); return; }
    this.timer ??= setTimeout(() => { void this.flush(); }, this.ms);
  }

  /** Writes what is waiting, after any write in flight. Resolves whether it was written or not (`write` says a failure). */
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const rows = this.buffer;
    this.buffer = [];
    if (rows.length === 0) return this.flushing;
    this.flushing = this.flushing.then(() => this.write(rows));
    return this.flushing;
  }
}
