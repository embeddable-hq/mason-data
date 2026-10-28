/**
 * USAGE OVER TIME (`_mason.usage`, `_mason.copy_sizes`): every SAMPLE_SECONDS the run writes one row of what it is and
 * what it did — the copy's size and rows, the copies added, copied and failed, how old the oldest copy is, the statements
 * of the interval (how many, refused, failed, cancelled, the rows and bytes sent, the completed ones' p50 / p95), the
 * stream's lag and the WAL its slot holds, and the memory of
 * the process and of the copy — and every SIZE_EVERY_MS each copy's own bytes. `mason status` says the moment; this is
 * what it said over the last days (`mason usage`, `GET /api/usage`).
 *
 * ONE FACT, ONE PLACE: a sample never computes a fact a second way. The copies' facts are `/api/state`'s at the moment
 * of the sample (`take`, src/cli/run-server.ts `usageFacts`: `engine.bytes`, `totals`, `tables[].sync.ageSeconds`,
 * `stream.lag`); the statements are counted as the listener RECORDS them (`count`, fed by the one `record` the listener
 * calls, beside the request log's) by the request log summary's own rules (src/duck/requests.ts `summary`: no refused
 * login, `outcomeOf`, the completed ones' `quantile_cont`), so a statement is in the interval it ended in, exactly once —
 * a query of the request log by `started_at` at each sample would miss a statement still running when its interval was
 * sampled (and one recorded in the second before the log's batch commits). Measured: that query is ~1 ms over a million
 * rows, so it was ruled out for exactness, not cost.
 *
 * Kept as the request log and the sync's events are (src/duck/requests.ts, src/duck/events.ts): written on a connection
 * of the samples' own — never the sync's writer turn (`onWriter`), which a swap or a stream batch may hold for seconds;
 * read on another; a write that fails is said once and again when one succeeds after it, and it NEVER fails anything;
 * kept `MASON_REQUEST_LOG_DAYS` days. A sample is one row a minute, so it is written as it is taken (its batch is one).
 * A stop loses at most the last interval's counts (the run's facts are no longer there to sample after the sync stops).
 *
 * THE COPY'S MEMORY is `duckdb_memory()` summed, on the samples' own connection (measured: under 1 ms, a catalog
 * function that reads the buffer manager's counters, never a table), against `store.memoryLimitBytes`.
 *
 * EACH COPY'S OWN BYTES (`copySizes`) are the distinct blocks its columns' segments use, the overflow blocks of long
 * strings included, times the block size (`pragma_storage_info`; `estimated_size` of `duckdb_tables()` is a row count).
 * Measured on DuckDB 2.0: a 30 M-row, 14-column table (9,109 segments) in 61–72 ms cold, its metadata only (the copy's
 * memory moved by 256 KiB), and 1,350,303,744 bytes for a file of 1,351,102,464; it grows with the segments (rows ×
 * columns), so a 200 M-row table of 20 columns is about half a second — hence every 10 minutes, never per request. It is
 * the size as of the last checkpoint (rows in the write-ahead log are not in a block yet).
 *
 * The Postgres catalog never lists `_mason`, so a tool connected to the listener cannot read the samples.
 */
import type { DuckDBValue } from "@duckdb/node-api";
import type { DuckConnection } from "./executor.ts";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";
import { outcomeOf, type ApiLogRow, type Outcome } from "../api/request-log.ts";

export const USAGE_TABLE = `${MASON_SCHEMA}.usage`;
export const SIZES_TABLE = `${MASON_SCHEMA}.copy_sizes`;

/**
 * HOW OFTEN A SAMPLE IS TAKEN: a minute. A chart of a day is 1,440 points and of the retention's 7 days 10,080 (a few
 * hundred KB of rows); a statement's p95 over a minute of a BI tool's traffic is a number, over 5 s mostly one statement;
 * and a sample is a read of the state the commands already ask every few seconds. No setting: nothing an operator
 * would tune it for has been met.
 */
export const SAMPLE_SECONDS = 60;
/** how often each copy's own bytes are measured (`copySizes`): its cost grows with the copy, see above */
export const SIZE_EVERY_MS = 10 * 60_000;
const TRIM_EVERY_MS = 60 * 60 * 1000;

const COLUMNS = ["sampled_at", "seconds", "copy_bytes", "copy_rows", "tables_added", "tables_copied", "tables_failed", "oldest_sync_seconds",
  "statements", "statements_refused", "statements_failed", "statements_cancelled", "rows_sent", "bytes_sent", "duration_p50_ms", "duration_p95_ms",
  "stream_lag_bytes", "stream_lag_seconds", "rss_bytes", "heap_used_bytes", "copy_memory_bytes", "copy_memory_limit_bytes", "slot_wal_held_bytes", "disk_free_bytes"] as const;

/** the samples' DDL: one row a sample; a level is as of `sampled_at`, a count is of the `seconds` before it */
export const USAGE_DDL = `CREATE TABLE IF NOT EXISTS ${USAGE_TABLE} (sampled_at TIMESTAMPTZ, seconds DOUBLE, copy_bytes BIGINT, copy_rows BIGINT, ` +
  `tables_added INTEGER, tables_copied INTEGER, tables_failed INTEGER, oldest_sync_seconds DOUBLE, statements BIGINT, statements_refused BIGINT, ` +
  `statements_failed BIGINT, statements_cancelled BIGINT, rows_sent BIGINT, bytes_sent BIGINT, duration_p50_ms INTEGER, duration_p95_ms INTEGER, stream_lag_bytes BIGINT, ` +
  `stream_lag_seconds DOUBLE, rss_bytes BIGINT, heap_used_bytes BIGINT, copy_memory_bytes BIGINT, copy_memory_limit_bytes BIGINT)`;
/** the columns added since the first samples (a file a run before them made): each added where it is missing */
export const USAGE_ADDED = ["slot_wal_held_bytes BIGINT", "disk_free_bytes BIGINT"] as const;
/** each copy's own bytes, every SIZE_EVERY_MS */
export const SIZES_DDL = `CREATE TABLE IF NOT EXISTS ${SIZES_TABLE} (sampled_at TIMESTAMPTZ, table_name VARCHAR, bytes BIGINT)`;

/** What the run is at the moment of a sample, as `/api/state` says it (src/cli/run-server.ts `usageFacts`). */
export interface UsageFacts {
  /** the copy's file (`engine.bytes`), null when it cannot be read */
  copyBytes: number | null;
  /** `totals`: the tables added, copied and failed, and the copies' rows */
  totals: { added: number; copied: number; failed: number; rows: number };
  /** the largest `tables[].sync.ageSeconds` of the added tables: how old the stalest copy is; null before any sync */
  oldestSyncSeconds: number | null;
  /** replication mode: `stream.lag`; null when polling */
  streamLag: { bytes: number | null; seconds: number | null } | null;
  /** the copies served (`schema.table`): those whose own bytes are measured */
  copied: string[];
  /** replication mode: the WAL the slot holds on the database (`stream.slot.walHeldBytes`); null when polling or not read */
  slotWalHeldBytes: number | null;
  /** the bytes free where the copy's file is (`disk.freeBytes`); null when it could not be read */
  diskFreeBytes: number | null;
}

/**
 * ONE SAMPLE as the commands read it (`mason usage --json`, `GET /api/usage`). A LEVEL is as of `at`; a COUNT is of the
 * `seconds` before it. Re-bucketed (`step`), `at` is the bucket's start, each count is summed and each level is its
 * highest in the bucket (p50 and p95 the slowest sample's).
 */
export interface UsageSample {
  /** when it was taken, ISO 8601 UTC; with a step, the bucket's start */
  at: string;
  /** the seconds its counts cover: since the sample before (a minute; longer after a sample that could not be taken) */
  seconds: number;
  /** the copy's file, bytes (`mason status` "the copy") */
  copyBytes: number | null;
  /** the copies' rows */
  copyRows: number;
  tablesAdded: number;
  tablesCopied: number;
  /** the added tables whose copy, poll, catch-up or stream failed */
  tablesFailed: number;
  /** how old the stalest copy is, in seconds (null before any copy) */
  oldestSyncSeconds: number | null;
  /** the statements of the interval, as the request log's summary counts them (src/duck/requests.ts `summary`: a refused
   *  login is none), and those refused (the statement's own fault), failed (Mason's or the machine's) and cancelled */
  statements: number;
  statementsRefused: number;
  statementsFailed: number;
  statementsCancelled: number;
  /** the rows sent to clients */
  rowsSent: number;
  /** the bytes sent to clients, over every statement (the request log's `bytes_sent`) */
  bytesSent: number;
  /** the COMPLETED statements' duration, p50 and p95, ms, as the summary's `quantile_cont` (interpolated, rounded); null
   *  when none completed. Exact up to DURATIONS_KEPT completed statements in the interval; past it, of a uniform
   *  sample of that many (`count`) */
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  /** replication mode: the stream's lag in WAL bytes and seconds (`mason status`'s); null when polling */
  streamLagBytes: number | null;
  streamLagSeconds: number | null;
  /** the run's memory: the process's resident set (the copy's thread included), and the main thread's JavaScript heap */
  rssBytes: number;
  heapUsedBytes: number;
  /** the copy's memory in use, and its limit (MASON_DUCKDB_MEMORY; half the machine's by default) */
  copyMemoryBytes: number | null;
  copyMemoryLimitBytes: number;
  /** replication mode: the WAL the slot holds on the database, bytes (`mason status`'s stream line); null when polling,
   *  or when it could not be read */
  slotWalHeldBytes: number | null;
  /** the bytes free on the disk the copy is on (`mason status`'s Disk line); re-bucketed, the LOWEST in the bucket (the
   *  one level a bucket's worst is its least) */
  diskFreeBytes: number | null;
}

/** One copy's own bytes, as last measured. */
export interface CopySize { table: string; bytes: number; at: string }

/** What a reader asks of the samples: from, until (ISO), and a bucket in seconds (absent: every sample). */
export interface UsageQuery { since: string; until: string; stepSeconds?: number }

/** The statements of one interval as `count` adds them up; `durations`, the completed ones' (at most DURATIONS_KEPT
 *  of them: `completed` says how many there were). */
interface Interval { statements: number; outcomes: Record<Exclude<Outcome, "ok">, number>; rowsSent: number; bytesSent: number; durations: number[]; completed: number }
const noInterval = (): Interval => ({ statements: 0, outcomes: { refused: 0, failed: 0, cancelled: 0 }, rowsSent: 0, bytesSent: 0, durations: [], completed: 0 });

/**
 * THE COMPLETED STATEMENTS' DURATIONS ONE INTERVAL KEEPS, at most: an interval is a minute, but one whose sample cannot
 * be taken is carried into the next (`sample`), so while samples keep failing it would otherwise keep every statement's
 * duration for as long as they fail. Up to this many the p50 / p95 are exact; past it the interval keeps a uniform
 * random sample of this many (a reservoir: the n-th duration replaces a kept one with probability KEPT / n), whose
 * quantiles estimate the interval's — 100,000 numbers are ~800 KB, ~1,700 statements a second for a minute.
 */
export const DURATIONS_KEPT = 100_000;

/**
 * The q-quantile of sorted values as DuckDB's `quantile_cont` gives it (linear between the two nearest ranks), rounded
 * as the request log's summary rounds it, or null for none: the summary's own definition of a p50 and a p95
 * (tests/duck-usage.test.ts holds the two equal).
 */
export function quantileCont(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo));
}

export interface UsageOptions {
  /** days kept (MASON_REQUEST_LOG_DAYS) */
  days: number;
  /** a test's: the interval between samples (SAMPLE_SECONDS) and between sizes (SIZE_EVERY_MS) */
  sampleMs?: number;
  sizeEveryMs?: number;
  /** a test's: write each row with this instead of the samples' own connection (a failure to say) */
  insert?: (sql: string, values: DuckDBValue[]) => Promise<void>;
  /** a test's clock */
  now?: () => number;
  /** a test's: the process's memory (process.memoryUsage) */
  memory?: () => { rss: number; heapUsed: number };
  /** a test's: the durations an interval keeps (DURATIONS_KEPT), and the reservoir's random draw in [0, 1) */
  durationsKept?: number;
  random?: () => number;
}

export class UsageSampler {
  private interval: Interval = noInterval();
  private last: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trimTimer: ReturnType<typeof setInterval> | null = null;
  private sampling: Promise<void> = Promise.resolve();
  private take: (() => Promise<UsageFacts>) | null = null;
  private lastSized = -Infinity;
  private sizedOnce = false;
  /** a streak of failures, said once: what failed (a sample taken, written, sized), and how many */
  private readonly lost = new Map<string, number>();
  private closed = false;

  private readonly writer: DuckConnection;
  private readonly reader: DuckConnection;
  private readonly log: (line: string) => void;
  private readonly options: UsageOptions;
  readonly days: number;
  readonly memoryLimitBytes: number;
  readonly sampleSeconds: number;

  private constructor(writer: DuckConnection, reader: DuckConnection, log: (line: string) => void, memoryLimitBytes: number, options: UsageOptions) {
    this.writer = writer; this.reader = reader; this.log = log; this.options = options; this.days = options.days; this.memoryLimitBytes = memoryLimitBytes;
    this.sampleSeconds = (options.sampleMs ?? SAMPLE_SECONDS * 1000) / 1000;
    this.last = this.now();
  }

  /** The samples of a store: their tables made, the rows past the retention deleted, and a trim every hour. Sampling
   *  begins with `start`, once the run's facts can be read. */
  static async open(store: DuckStore, log: (line: string) => void, options: UsageOptions): Promise<UsageSampler> {
    const writer = await store.instance.connect();
    await writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
    await writer.run(USAGE_DDL);
    for (const c of USAGE_ADDED) await writer.run(`ALTER TABLE ${USAGE_TABLE} ADD COLUMN IF NOT EXISTS ${c}`);
    await writer.run(SIZES_DDL);
    const reader = await store.instance.connect();
    const u = new UsageSampler(writer, reader, log, store.memoryLimitBytes, options);
    await u.trim();
    u.trimTimer = setInterval(() => {
      u.trim().catch((e: unknown) => log(`usage: deleting the samples older than ${u.days} days failed: ${(e as Error).message}`));
    }, TRIM_EVERY_MS);
    u.trimTimer.unref();
    return u;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** One row of the listener's, as the request log records it: counted in the interval it ends, by the summary's rule
   *  (a refused login is no statement; `outcomeOf`, the one outcome rule). Never throws. */
  count(row: ApiLogRow): void {
    if (row.method === "CONNECT") return;
    const i = this.interval;
    i.statements++;
    const outcome = outcomeOf(row.sqlstate);
    if (outcome === "ok") {
      i.completed++;
      const kept = this.options.durationsKept ?? DURATIONS_KEPT;
      if (i.durations.length < kept) i.durations.push(row.durationMs);
      else {
        const j = Math.floor((this.options.random?.() ?? Math.random()) * i.completed);
        if (j < kept) i.durations[j] = row.durationMs;
      }
    } else i.outcomes[outcome]++;
    i.rowsSent += row.rows ?? 0;
    i.bytesSent += row.bytesSent ?? 0;
  }

  /** Takes a sample every interval from `take` (the run's facts), and each copy's bytes every SIZE_EVERY_MS. */
  start(take: () => Promise<UsageFacts>): void {
    this.take = take;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    // one after the other, never two at once: a sample slower than its interval delays the next
    this.timer = setTimeout(() => { this.timer = null; this.sampling = this.sample().then(() => this.schedule()); }, this.options.sampleMs ?? SAMPLE_SECONDS * 1000);
    this.timer.unref();
  }

  /** a failure of `what`, said once per streak; `ok` ends the streak, said with what it cost */
  private failure(what: string, e: unknown): void {
    const n = this.lost.get(what) ?? 0;
    if (n === 0) this.log(`usage: ${what} failed: ${(e as Error).message}; said once until one succeeds`);
    this.lost.set(what, n + 1);
  }
  private ok(what: string): void {
    const n = this.lost.get(what) ?? 0;
    if (n > 0) { this.log(`usage: ${what} again; ${n} time(s) it was not`); this.lost.delete(what); }
  }

  /** One sample now: the run's facts, the interval's requests, the memory; written. Resolves whatever happens (a failure is said). */
  async sample(): Promise<void> {
    if (this.take === null) return;
    let facts: UsageFacts;
    let copyMemory: number | null;
    try {
      facts = await this.take();
      copyMemory = await this.copyMemory();
    } catch (e) {
      // Tolerated, narrowly: a sample is history, and the run goes on without it. The interval's counts are KEPT for
      // the next sample, whose `seconds` covers both, so no request goes uncounted.
      this.failure("taking a sample", e);
      return;
    }
    this.ok("taking a sample");
    const now = this.now();
    const i = this.interval;
    this.interval = noInterval();
    const seconds = (now - this.last) / 1000;
    this.last = now;
    const sorted = i.durations.sort((a, b) => a - b);
    const mem = this.options.memory?.() ?? process.memoryUsage();
    const values: DuckDBValue[] = [new Date(now).toISOString(), seconds, facts.copyBytes, facts.totals.rows, facts.totals.added, facts.totals.copied, facts.totals.failed,
      facts.oldestSyncSeconds, i.statements, i.outcomes.refused, i.outcomes.failed, i.outcomes.cancelled, i.rowsSent, i.bytesSent, quantileCont(sorted, 0.5), quantileCont(sorted, 0.95),
      facts.streamLag?.bytes ?? null, facts.streamLag?.seconds ?? null, mem.rss, mem.heapUsed, copyMemory, this.memoryLimitBytes, facts.slotWalHeldBytes, facts.diskFreeBytes];
    const sql = `INSERT INTO ${USAGE_TABLE} (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c, j) => `$${j + 1}${c === "sampled_at" ? "::TIMESTAMPTZ" : ""}`).join(", ")})`;
    try {
      if (this.options.insert !== undefined) await this.options.insert(sql, values);
      else await this.writer.run(sql, values);
      this.ok(`writing a sample to ${USAGE_TABLE}`);
    } catch (e) {
      // Tolerated, narrowly, as the request log's: a sample that cannot be written must not stop the run. SAID.
      this.failure(`writing a sample to ${USAGE_TABLE}`, e);
    }
    if (now - this.lastSized >= (this.options.sizeEveryMs ?? SIZE_EVERY_MS)) {
      this.lastSized = now;
      await this.size(facts.copied, now);
    }
  }

  /** the copy's memory in use: DuckDB's buffer manager's counters, summed */
  private async copyMemory(): Promise<number | null> {
    const v = (await this.reader.runAndReadAll("SELECT sum(memory_usage_bytes) FROM duckdb_memory()")).getRowsJS()[0]?.[0];
    return v === null || v === undefined ? null : Number(v);
  }

  /** Each served copy's own bytes, written as one batch (see the module's comment for how, and what it costs). */
  private async size(copied: readonly string[], now: number): Promise<void> {
    const t0 = performance.now();
    const rows: Array<[string, number]> = [];
    try {
      const want = new Set(copied);
      const tables = (await this.reader.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE NOT internal AND database_name = current_database() AND schema_name <> '${MASON_SCHEMA}'`))
        .getRowsJS() as Array<[string, string]>;
      const block = Number((await this.reader.runAndReadAll("SELECT block_size FROM pragma_database_size()")).getRowsJS()[0]![0]);
      for (const [schema, table] of tables) {
        const name = `${schema}.${table}`;
        if (!want.has(name)) continue;
        const q = `${quote(schema)}.${quote(table)}`;
        let blocks: number;
        try {
          blocks = Number((await this.reader.runAndReadAll(`WITH s AS (SELECT block_id, additional_block_ids FROM pragma_storage_info($1) WHERE persistent), ` +
            `b AS (SELECT block_id FROM s WHERE block_id >= 0 UNION SELECT unnest(additional_block_ids) FROM s) SELECT count(*) FROM b`, [q])).getRowsJS()[0]![0]);
        } catch (e) {
          // a copy dropped since the list was read (mason remove; a copy swapped in again): not sized this time, by design.
          // Anything else is the sizing's failure, said
          if (/does not exist/i.test((e as Error).message)) continue;
          throw e;
        }
        rows.push([name, blocks * block]);
      }
      if (rows.length > 0) {
        const sql = `INSERT INTO ${SIZES_TABLE} (sampled_at, table_name, bytes) VALUES ` + rows.map((_, i) => `($1::TIMESTAMPTZ, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
        const values: DuckDBValue[] = [new Date(now).toISOString(), ...rows.flat()];
        if (this.options.insert !== undefined) await this.options.insert(sql, values);
        else await this.writer.run(sql, values);
      }
    } catch (e) {
      this.failure("measuring each copy's size", e);
      return;
    }
    this.ok("measuring each copy's size");
    // the first measure of a run is said with its time: what it costs on this machine's copies, read from the log
    if (!this.sizedOnce) { this.sizedOnce = true; this.log(`usage: measured ${rows.length} copies' own size in ${Math.round(performance.now() - t0)} ms (every ${Math.round((this.options.sizeEveryMs ?? SIZE_EVERY_MS) / 60_000)} min)`); }
  }

  /** Deletes the samples and sizes older than the retention. */
  async trim(): Promise<void> {
    await this.writer.run(`DELETE FROM ${USAGE_TABLE} WHERE sampled_at < now() - INTERVAL (${this.days}) DAY`);
    await this.writer.run(`DELETE FROM ${SIZES_TABLE} WHERE sampled_at < now() - INTERVAL (${this.days}) DAY`);
  }

  /**
   * The samples from `since` until `until`, oldest first; with `stepSeconds`, re-bucketed in ONE query: buckets of that
   * many seconds from `since`, each count summed and each level at its highest. Committed rows only.
   */
  async samples(o: UsageQuery): Promise<UsageSample[]> {
    const values: DuckDBValue[] = [o.since, o.until];
    const range = `sampled_at >= $1::TIMESTAMPTZ AND sampled_at < $2::TIMESTAMPTZ`;
    let sql: string;
    if (o.stepSeconds === undefined) {
      sql = `SELECT epoch_ms(sampled_at) AS at, ${COLUMNS.slice(1).join(", ")} FROM ${USAGE_TABLE} WHERE ${range} ORDER BY sampled_at`;
    } else {
      values.push(o.stepSeconds);
      const sum = new Set(["seconds", "statements", "statements_refused", "statements_failed", "statements_cancelled", "rows_sent", "bytes_sent"]);
      sql = `SELECT epoch_ms(time_bucket(to_seconds($3::BIGINT), sampled_at, $1::TIMESTAMPTZ)) AS at, ` +
        COLUMNS.slice(1).map((c) => `${sum.has(c) ? "sum" : c === "disk_free_bytes" ? "min" : "max"}(${c}) AS ${c}`).join(", ") +
        ` FROM ${USAGE_TABLE} WHERE ${range} GROUP BY 1 ORDER BY 1`;
    }
    const rows = (await this.reader.runAndReadAll(sql, values)).getRowObjectsJson() as Array<Record<string, unknown>>;
    return rows.map(sampleOf);
  }

  /** Each copy's own bytes as last measured within the retention, by table. */
  async copySizes(): Promise<CopySize[]> {
    const rows = (await this.reader.runAndReadAll(`SELECT table_name, arg_max(bytes, sampled_at) AS bytes, epoch_ms(max(sampled_at)) AS at FROM ${SIZES_TABLE} GROUP BY table_name ORDER BY table_name`))
      .getRowsJS() as Array<[string, bigint | number, bigint | number]>;
    return rows.map(([table, bytes, at]) => ({ table, bytes: Number(bytes), at: new Date(Number(at)).toISOString() }));
  }

  /** Stops sampling, waits for a sample in flight, and closes the samples' connections (mason stop). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.trimTimer !== null) { clearInterval(this.trimTimer); this.trimTimer = null; }
    await this.sampling;
    this.writer.closeSync();
    this.reader.closeSync();
  }
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function sampleOf(r: Record<string, unknown>): UsageSample {
  return {
    at: new Date(Number(r.at)).toISOString(), seconds: Number(r.seconds), copyBytes: num(r.copy_bytes), copyRows: Number(r.copy_rows ?? 0),
    tablesAdded: Number(r.tables_added ?? 0), tablesCopied: Number(r.tables_copied ?? 0), tablesFailed: Number(r.tables_failed ?? 0), oldestSyncSeconds: num(r.oldest_sync_seconds),
    statements: Number(r.statements ?? 0), statementsRefused: Number(r.statements_refused ?? 0), statementsFailed: Number(r.statements_failed ?? 0),
    statementsCancelled: Number(r.statements_cancelled ?? 0), rowsSent: Number(r.rows_sent ?? 0), bytesSent: Number(r.bytes_sent ?? 0), durationP50Ms: num(r.duration_p50_ms), durationP95Ms: num(r.duration_p95_ms),
    streamLagBytes: num(r.stream_lag_bytes), streamLagSeconds: num(r.stream_lag_seconds),
    rssBytes: Number(r.rss_bytes), heapUsedBytes: Number(r.heap_used_bytes), copyMemoryBytes: num(r.copy_memory_bytes), copyMemoryLimitBytes: Number(r.copy_memory_limit_bytes),
    slotWalHeldBytes: num(r.slot_wal_held_bytes), diskFreeBytes: num(r.disk_free_bytes),
  };
}
