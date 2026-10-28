/**
 * USAGE OVER TIME (`_mason.usage`, `_mason.copy_sizes`): every SAMPLE_SECONDS the run writes one row of what it is and
 * what it did — the copy's size and rows, the copies added, copied and failed, how old the oldest copy is, the requests
 * of the interval (how many, failed, refused, rows sent, their p50 / p95 duration), the stream's lag, and the memory of
 * the process and of the copy — and every SIZE_EVERY_MS each copy's own bytes. `mason status` says the moment; this is
 * what it said over the last days (`mason usage`, `GET /api/usage`).
 *
 * ONE FACT, ONE PLACE: a sample never computes a fact a second way. The copies' facts are `/api/state`'s at the moment
 * of the sample (`take`, src/cli/run-server.ts `usageFacts`: `engine.bytes`, `totals`, `tables[].sync.ageSeconds`,
 * `stream.lag`); the requests are counted as the listener RECORDS them (`count`, fed by the one `record` the listener
 * calls, beside the request log's), so a request is in the interval it ended in, exactly once — a query of the request
 * log by `started_at` at each sample would miss a statement still running when its interval was sampled (and one
 * recorded in the second before the log's batch commits). Measured: that query is ~1 ms over a million rows, so it was
 * ruled out for exactness, not cost.
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
import { outcomeOf, type ApiLogRow } from "../api/request-log.ts";

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
  "requests", "requests_failed", "requests_refused", "rows_sent", "bytes_sent", "duration_p50_ms", "duration_p95_ms",
  "stream_lag_bytes", "stream_lag_seconds", "rss_bytes", "heap_used_bytes", "copy_memory_bytes", "copy_memory_limit_bytes"] as const;

/** the samples' DDL: one row a sample; a level is as of `sampled_at`, a count is of the `seconds` before it */
export const USAGE_DDL = `CREATE TABLE IF NOT EXISTS ${USAGE_TABLE} (sampled_at TIMESTAMPTZ, seconds DOUBLE, copy_bytes BIGINT, copy_rows BIGINT, ` +
  `tables_added INTEGER, tables_copied INTEGER, tables_failed INTEGER, oldest_sync_seconds DOUBLE, requests BIGINT, requests_failed BIGINT, ` +
  `requests_refused BIGINT, rows_sent BIGINT, bytes_sent BIGINT, duration_p50_ms INTEGER, duration_p95_ms INTEGER, stream_lag_bytes BIGINT, ` +
  `stream_lag_seconds DOUBLE, rss_bytes BIGINT, heap_used_bytes BIGINT, copy_memory_bytes BIGINT, copy_memory_limit_bytes BIGINT)`;
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
  /** the request log's rows: every statement the Postgres API answered, refused or failed, and every refused login */
  requests: number;
  requestsFailed: number;
  requestsRefused: number;
  /** the rows sent to clients */
  rowsSent: number;
  /** the bytes sent to clients: null until the request log records the bytes each statement sent (`count` adds them) */
  bytesSent: number | null;
  /** the requests' duration, p50 and p95, ms (nearest rank); null when there was none */
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
}

/** One copy's own bytes, as last measured. */
export interface CopySize { table: string; bytes: number; at: string }

/** What a reader asks of the samples: from, until (ISO), and a bucket in seconds (absent: every sample). */
export interface UsageQuery { since: string; until: string; stepSeconds?: number }

/** The requests of one interval as `count` adds them up. */
interface Interval { requests: number; failed: number; refused: number; rowsSent: number; bytesSent: number | null; durations: number[] }
const noInterval = (): Interval => ({ requests: 0, failed: 0, refused: 0, rowsSent: 0, bytesSent: null, durations: [] });

/** The value at rank ⌈q·n⌉ of the sorted durations (nearest rank), or null for none. */
export function nearestRank(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
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

  /** One request of the listener's, as the request log records it: counted in the interval it ends. Never throws. */
  count(row: ApiLogRow): void {
    const i = this.interval;
    i.requests++;
    const outcome = outcomeOf(row.sqlstate);
    if (outcome === "failed") i.failed++;
    else if (outcome === "refused") i.refused++;
    if (row.rows !== undefined) i.rowsSent += row.rows;
    // bytesSent: once the request log records the bytes each statement sent, they are added here (i.bytesSent)
    i.durations.push(row.durationMs);
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
      facts.oldestSyncSeconds, i.requests, i.failed, i.refused, i.rowsSent, i.bytesSent, nearestRank(sorted, 0.5), nearestRank(sorted, 0.95),
      facts.streamLag?.bytes ?? null, facts.streamLag?.seconds ?? null, mem.rss, mem.heapUsed, copyMemory, this.memoryLimitBytes];
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
      const sum = new Set(["seconds", "requests", "requests_failed", "requests_refused", "rows_sent", "bytes_sent"]);
      sql = `SELECT epoch_ms(time_bucket(to_seconds($3::BIGINT), sampled_at, $1::TIMESTAMPTZ)) AS at, ` +
        COLUMNS.slice(1).map((c) => `${sum.has(c) ? "sum" : "max"}(${c}) AS ${c}`).join(", ") +
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
    requests: Number(r.requests ?? 0), requestsFailed: Number(r.requests_failed ?? 0), requestsRefused: Number(r.requests_refused ?? 0), rowsSent: Number(r.rows_sent ?? 0),
    bytesSent: num(r.bytes_sent), durationP50Ms: num(r.duration_p50_ms), durationP95Ms: num(r.duration_p95_ms),
    streamLagBytes: num(r.stream_lag_bytes), streamLagSeconds: num(r.stream_lag_seconds),
    rssBytes: Number(r.rss_bytes), heapUsedBytes: Number(r.heap_used_bytes), copyMemoryBytes: num(r.copy_memory_bytes), copyMemoryLimitBytes: Number(r.copy_memory_limit_bytes),
  };
}
