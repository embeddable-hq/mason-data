/**
 * THE DUCKDB STORE (the prototype, docs/DESIGN.md decision B): ONE DuckDB instance inside the `mason start`
 * run, file-backed at `.mason/duck.db` so the copy survives `mason stop` / `start` (`mason destroy` deletes it). DuckDB
 * allows one writing PROCESS per file, so everything that writes — the copy, the poll — and every wire session run in
 * this one process: the sync on the store's own `writer` connection, each Postgres session on a connection of its own
 * (`runner`), so a session's `SET TimeZone` and search_path are its own, as on Postgres.
 *
 * The instance and every connection live on the EXECUTOR WORKER (src/duck/executor.ts), the thread the
 * Mason functions are called on; `DuckStore` is the main thread's handle on it (`writer` and `instance.connect()` post
 * their statements there), and `SessionRunner` below runs on the worker (src/duck/executor-worker.ts).
 *
 * A copied table lives under the source's own name, `<schema>.<table>` (decision C): a tool's SQL reads `sales.orders`
 * and DuckDB has `sales.orders`. Mason's own bookkeeping is the schema `_mason`, which the Postgres catalog never lists.
 *
 * JSON and ICU (time zones) are built into DuckDB 2.0; the `postgres` extension the copy needs is loaded by the sync
 * (src/duck/sync.ts attach), so the store itself opens offline.
 */
import * as os from "node:os";
import { DuckDBInstance, version, type DuckDBConnection, type DuckDBPreparedStatement, type DuckDBResult, type DuckDBValue } from "@duckdb/node-api";
import { Executor, type DuckConnection } from "./executor.ts";
import { beginStatement, cancelStatement, slotName, statementCancelled } from "./cancel.ts";
import type { PgSession } from "../api/postgres/encode.ts";
import type { DuckAnswer, DuckOptions, DuckRunner, DuckSession, ExplainHow } from "../api/postgres/server.ts";
import { StatementError } from "./statement.ts";
import { duckParameters, missingRelationHint, planDuck, quoteDuckKeywords } from "./plan.ts";
import type { KeptRoutes } from "./kept-route.ts";
import type { CopyState } from "./sync.ts";
import { VERIFIED } from "./verified.ts";
import { registerFunctions, SESSION_VARIABLE, SETTINGS_VARIABLE } from "./functions.ts";
import { duckCollation, type DuckCollation } from "./rewrite.ts";
import { decodeLibcOrder, encodeLibcOrder, isCurrentLibcOrder, type LibcOrder } from "./libc-order.ts";
import { dataRow } from "../api/postgres/protocol.ts";
import { cellText, exactColumn, pgTypedColumn, wireColumn, type WireColumn } from "./types.ts";
import type { ExactColumn } from "./rewrite.ts";
import { gapIn, gapMark, type GapId } from "./gaps.ts";
import { cellsOf, evaluateText, NumericError } from "../lib/pg-numeric.ts";
import { explainJson, explainText, planNodes, profiled, qualifiedName, scannedTables, type Copy, type CopyFacts, type Explained, type PlanNode, type TableName } from "./explain.ts";
import type { PlannedSql } from "./plan.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DuckDBType } from "@duckdb/node-api";
import { extensionSettings, findExtensions, type Extensions } from "./extensions.ts";

export const MASON_SCHEMA = "_mason";

/** the DuckDB the prototype runs (`@duckdb/node-api`'s bundled library) */
export const DUCKDB_VERSION = version();

/**
 * THE INSTANCE'S SETTINGS. `late_materialization_max_rows`: a sorted LIMIT of up to this many rows sorts only its keys
 * and the row ids, and reads the other columns for the winners alone. DuckDB's default, 50, is below every BI tool's
 * preview (Postico's click on a table is `ORDER BY "id" ASC LIMIT 1000`, pgAdmin's 1,000, Metabase's 2,000), which
 * then sorted EVERY column of every row: 2.4 s for 23 M rows, 32 s for a wide table, where Postgres reads 1,000 rows of
 * the primary key's index. 10,000 took the first to 36 ms; at 100,000 rows the fetch by row id stops
 * paying (measured even or slower over 5 M narrow rows), so bulk reads keep the plain sort.
 *
 * `force_compression: zstd`: DuckDB's analyzer never picks ZSTD by itself, and stored a copied table's
 * JSON text column Uncompressed (the test server's 194 M-row table: 0.66 GB a million rows, which would have filled the
 * disk at 125 GB, against 0.26 GB forced; a sample of its text columns 4.5× smaller, the integer, UUID and timestamp
 * columns keeping their own methods, BitPacking and RLE, since forcing only touches what ZSTD can store). The cost of
 * reading a ZSTD column is not measured. tests/duck-wire.test.ts holds a string column to ZSTD.
 *
 * `lambda_syntax: ENABLE_SINGLE_ARROW`: the rewrite is a Postgres parse tree, printed by Postgres's deparser, which
 * can spell DuckDB's lambda only as `x -> f(x)` (Postgres's `->` operator), never as `lambda x: f(x)`; DuckDB 2.0
 * refuses that spelling by default. Two rewrites need a lambda: a jsonb's order under ICU or a libc locale, which maps
 * DuckDB's `icu_sort_key` over the document's strings (src/duck/rewrite.ts `jsonbKey`; tests/duck-jsonb-order.test.ts
 * holds the key under every collation), and a LEFT lateral's unnest of an expression, which computes the expression
 * once with `list_transform(list_value(e), l -> CASE … l … END)[1]` (`rangeFunction`; tests/duck-wire.test.ts). A `->`
 * that is not a lambda function's argument is still the json operator.
 *
 * Beside them, the copy's extensions (src/duck/extensions.ts `extensionSettings`): with Mason's package for this
 * platform, `extension_directory` is that package and nothing is ever downloaded; without one, DuckDB's defaults.
 */
const INSTANCE_SETTINGS = { late_materialization_max_rows: "10000", force_compression: "zstd", lambda_syntax: "ENABLE_SINGLE_ARROW" };

/**
 * DUCKDB'S MEMORY, BOUNDED FOR THIS PROCESS: DuckDB's default is 80% of the machine's RAM, in a process
 * that also holds V8's heap and two PGlites, which ends with the system killing every session and the sync together.
 * Half the RAM unless `MASON_DUCKDB_MEMORY` says (`8GB`, `512MiB`); past it a sort, a join or an aggregate spills to
 * `<file>.tmp` (DuckDB's own default, named here so it is the copy's folder), and what cannot spill fails ITS statement
 * with 53200 and the way out (pgErrorOf), the run going on.
 */
/** The default memory limit for a machine with `totalBytes` of RAM: half of it, in MiB (mason doctor says it for any machine). */
export function defaultMemoryLimit(totalBytes: number): string { return `${Math.floor(totalBytes / 2 / 2 ** 20)}MiB`; }

/**
 * THE MEMORY THIS PROCESS MAY USE: the machine's RAM, or the container's limit where one is set — a cgroup v2
 * `memory.max` or a cgroup v1 `memory.limit_in_bytes` below it. `os.totalmem()` is the HOST's RAM inside a container,
 * so half of it was more than a limited container had, and the kernel killed the run instead of DuckDB spilling
 * (the review of the cut). `read` is the test's.
 */
export function machineMemoryBytes(read: (file: string) => string = (f) => fs.readFileSync(f, "utf8"), total: number = os.totalmem()): number {
  let limit = total;
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let text: string;
    try { text = read(file).trim(); } catch { continue; }   // not a cgroup of that version, or not a container: the machine's RAM
    // v2 says `max` for no limit; v1 says a number near 2^63; either way a number below the RAM is the limit
    const n = Number(text);
    if (text !== "max" && Number.isFinite(n) && n > 0 && n < limit) limit = n;
  }
  return limit;
}
export const DEFAULT_MEMORY_LIMIT = defaultMemoryLimit(machineMemoryBytes());

/**
 * WHAT STATEMENTS MAY SPILL (issue 105: a 100-row preview's sort took every free byte of a volume, and the sync's room
 * with it). DuckDB's default ceiling is "90% of available disk space", and what it answered when the disk ran out first
 * was `XX000` with a path. Here the ceiling is HALF of the room statements have, what is free where the copy is and what
 * they have spilled there (the disk's free bytes exclude the spill, so a ceiling of the free bytes alone would grow with
 * each read as the spill grows, and end near the whole disk). The sync's writes keep the other half whatever statements
 * do, and it follows the disk (`DuckStore.keepSpillCeiling`, every `SPILL_REFRESH_MS`): a copy that grows narrows it.
 * `MASON_SPILL_LIMIT` sets the amount instead, never past 90% of that room. Spilled files are shared by the statements
 * running, so two at once share the ceiling. Past it the statement that needed the room fails alone, 53400 as past
 * Postgres's temp_file_limit, with the way out (pgErrorOf), and its files are gone with it; a disk that is really full
 * is 53100. A sizing decision reads `store.spillLimitBytes`, as it reads `store.memoryLimitBytes`.
 */
const SPILL_FREE_SHARE = 0.5, SPILL_FREE_MOST = 0.9;
const SPILL_REFRESH_MS = 15_000;
export function spillCeiling(freeBytes: number, spilledBytes: number, setBytes: number | null): number {
  const room = freeBytes + spilledBytes;
  return Math.max(2 ** 20, Math.floor(setBytes === null ? room * SPILL_FREE_SHARE : Math.min(setBytes, room * SPILL_FREE_MOST)));
}
/** the bytes free where `dir` is: the one reading of it (the sync's disk check, the spill's ceiling) */
export function freeBytesAt(dir: string): number { const st = fs.statfsSync(dir); return st.bavail * st.bsize; }
const spillSetting = (bytes: number): string => `${Math.floor(bytes / 2 ** 20)}MiB`;
export const MEMORY_LIMIT_RE = /^\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*$/i;

/** DuckDB's memory limit in bytes, as DuckDB reads the text: KB / MB / GB / TB are powers of 1000, KiB / MiB / GiB / TiB of 1024 */
export function memoryLimitBytes(text: string): number {
  const m = MEMORY_LIMIT_RE.exec(text);
  if (m === null) throw new Error(`${JSON.stringify(text)} is not an amount of memory`);
  const unit = m[2]!.toLowerCase();
  const power = ["kb", "kib"].includes(unit) ? 1 : ["mb", "mib"].includes(unit) ? 2 : ["gb", "gib"].includes(unit) ? 3 : 4;
  return Math.round(Number(m[1]) * (unit.endsWith("ib") ? 1024 : 1000) ** power);
}

/** the copies open (or closing) in this process, by file: a second instance of a file loses writes silently
 *  (src/duck/executor.ts), so an open waits for a close of the same file and refuses one still open */
const opened = new Map<string, { closed: Promise<void> | null; abandoned: string | null }>();

/**
 * The instance, opened ON THE EXECUTOR WORKER (src/duck/executor-worker.ts "open"): its settings, the schemas every
 * session's search_path may name, and the Mason functions, registered from that thread.
 */
export async function openDuck(file: string, settings: Record<string, string>): Promise<{ instance: DuckDBInstance; writer: DuckDBConnection }> {
  let instance: DuckDBInstance;
  try { instance = await DuckDBInstance.create(file, settings); }
  catch (e) {
    const m = (e as Error).message;
    throw new Error(/lock/i.test(m)
      ? `Mason could not open the synced data ${file}: another process holds it (${m}). Is another mason start running for this project? mason status says`
      : `Mason could not open the synced data ${file}: ${m}. mason destroy deletes the synced data, and the next mason start syncs again`);
  }
  const writer = await instance.connect();
  await writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
  // a session's search_path is Postgres's `"$user", public`: DuckDB has no `public` until a public table is copied,
  // and SET search_path to a schema that does not exist is refused
  await writer.run("CREATE SCHEMA IF NOT EXISTS public");
  // Postgres's functions where DuckDB's answer differently (src/duck/functions.ts): the instance's, once
  registerFunctions(writer);
  return { instance, writer };
}

export class DuckStore {
  /** a connection of the instance, as `DuckDBInstance.connect` gives one (its statements run on the executor worker) */
  readonly instance: { connect(): Promise<DuckConnection> };
  readonly writer: DuckConnection;
  readonly file: string;
  /** the memory limit every connection shares, in bytes */
  readonly memoryLimitBytes: number;
  /** what statements may spill now, in bytes (`spillCeiling`): it follows the disk */
  spillLimitBytes: number;
  private readonly spillSet: number | null;
  private readonly diskFree: (dir: string) => number;
  private readonly spillTimer: NodeJS.Timeout;
  private spillLane: Promise<DuckConnection> | null = null;
  private spillKept: Promise<void> | null = null;
  private readonly log: (line: string) => void;
  private readonly executor: Executor;
  private closed: Promise<void> | null = null;
  private readonly closeGraceMs: number | undefined;
  /** where the copy's extensions come from: Mason's package for this platform, or DuckDB's install (src/duck/extensions.ts) */
  readonly extensions: Extensions;
  private constructor(file: string, executor: Executor, memoryLimit: number, extensions: Extensions, spill: { limit: number; set: number | null; diskFree: (dir: string) => number }, log: (line: string) => void, closeGraceMs?: number) {
    this.file = file; this.executor = executor; this.memoryLimitBytes = memoryLimit; this.extensions = extensions; this.closeGraceMs = closeGraceMs;
    this.spillLimitBytes = spill.limit; this.spillSet = spill.set; this.diskFree = spill.diskFree; this.log = log;
    this.spillTimer = setInterval(() => { void this.keepSpillCeiling(); }, SPILL_REFRESH_MS);
    this.spillTimer.unref();
    this.writer = executor.writer();
    this.instance = { connect: () => executor.connect() };
  }

  /** `silentMs` and `closeGraceMs`: the executor's bounds (src/duck/executor.ts SILENT_MS, CLOSE_GRACE_MS), shorter only
   *  in a test; `workerFile`, the executor worker's module, another only in a test; `extensions`, this machine's
   *  (`findExtensions`) unless a test names a package */
  static async open(file: string, log: (line: string) => void, options: { memoryLimit?: string; spillLimit?: string; diskFree?: (dir: string) => number; silentMs?: number; closeGraceMs?: number; workerFile?: string; extensions?: Extensions } = {}): Promise<DuckStore> {
    const extensions = options.extensions ?? findExtensions();
    const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    if (!MEMORY_LIMIT_RE.test(memoryLimit)) throw new Error(`MASON_DUCKDB_MEMORY=${JSON.stringify(memoryLimit)} is not an amount of memory: write it as 8GB or 512MiB (unset, half the machine's RAM: ${DEFAULT_MEMORY_LIMIT})`);
    if (options.spillLimit !== undefined && !MEMORY_LIMIT_RE.test(options.spillLimit)) throw new Error(`MASON_SPILL_LIMIT=${JSON.stringify(options.spillLimit)} is not an amount of disk: write it as 40GB or 512MiB (unset, half of what is free on the disk)`);
    const spillSet = options.spillLimit === undefined ? null : memoryLimitBytes(options.spillLimit);
    const diskFree = options.diskFree ?? freeBytesAt;
    const where = path.resolve(file);
    const spillLimit = spillCeiling(diskFree(path.dirname(where)), 0, spillSet);
    const before = opened.get(where);
    if (before !== undefined && before.closed === null) throw new Error(`Mason could not open the synced data ${file}: this process has it open already (Mason bug: report it)`);
    // a copy whose thread was given up on may still hold the file: a second instance of it would lose writes
    if (before?.abandoned != null) throw new Error(`Mason could not open the synced data ${file}: this process gave up on the engine's thread before (${before.abandoned}), which may still hold it; start mason again (a new process opens it)`);
    const mine = { closed: null as Promise<void> | null, abandoned: null as string | null };
    opened.set(where, mine);
    let executor: Executor;
    try {
      if (before !== undefined) await before.closed;
      // every connection's, the sync's and each session's
      executor = await Executor.start({ file, settings: { ...INSTANCE_SETTINGS, ...extensionSettings(extensions), memory_limit: memoryLimit, temp_directory: `${file}.tmp`, max_temp_directory_size: spillSetting(spillLimit) }, log,
        ...(options.silentMs !== undefined ? { silentMs: options.silentMs } : {}), ...(options.workerFile !== undefined ? { workerFile: options.workerFile } : {}) });
    } catch (e) { if (opened.get(where) === mine) opened.delete(where); throw e; }
    const store = new DuckStore(file, executor, memoryLimitBytes(memoryLimit), extensions, { limit: spillLimit, set: spillSet, diskFree }, log, options.closeGraceMs);
    // closed: the file may be opened again — unless its thread was given up on (`abandoned`), which keeps it here
    store.closing = (p) => { mine.closed = p; void p.then(() => { if (executor.abandoned !== null) mine.abandoned = executor.abandoned; else if (opened.get(where) === mine) opened.delete(where); }); };
    return store;
  }
  private closing: (p: Promise<void>) => void = () => undefined;

  /**
   * THE SPILL'S CEILING MOVED WITH THE DISK (`spillCeiling`): the bytes free and spilled now, set on the instance on a
   * connection of its own, never the writer's. One at a time; a move under 1 % is none. DuckDB refuses a ceiling under
   * what is spilled at that moment (more may have spilled since the read): it stays where it was until the next turn.
   * Any other failure is said; the ceiling stands, which is the last one set.
   */
  keepSpillCeiling(): Promise<void> {
    if (this.closed !== null) return Promise.resolve();
    this.spillKept ??= this.spillTurn().catch((e: unknown) => {
      if (this.closed === null) this.log(`the spill's ceiling was not moved: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { this.spillKept = null; });
    return this.spillKept;
  }
  private async spillTurn(): Promise<void> {
    let c: DuckConnection;
    // a connection that failed is asked for again next turn, never kept as the answer
    try { c = await (this.spillLane ??= this.executor.connect()); }
    catch (e) { this.spillLane = null; throw e; }
    const spilled = Number((await c.runAndReadAll("SELECT coalesce(sum(size), 0) FROM duckdb_temporary_files()")).getRowsJS()[0]![0]);
    const next = spillCeiling(this.diskFree(path.dirname(path.resolve(this.file))), spilled, this.spillSet);
    if (Math.abs(next - this.spillLimitBytes) < this.spillLimitBytes * 0.01) return;
    try { await c.run(`SET GLOBAL max_temp_directory_size = '${spillSetting(next)}'`); }
    catch (e) {
      if (e instanceof Error && e.message.includes("failed to adjust")) return;
      throw e;
    }
    this.spillLimitBytes = next;
  }

  /** called once if the engine's thread dies while the run uses it (src/duck/executor.ts): the run exits with the reason */
  onCrash(f: (reason: string) => void): void { this.executor.onCrash(f); }
  /** how many vectors each Mason function was called with so far, on the engine's thread (a test's, a measurement's) */
  functionCalls(): Promise<Map<string, number>> { return this.executor.functionCalls(); }
  /** how many rows each Mason function was handed so far, on the engine's thread (a plan's cost in calls) */
  functionRows(): Promise<Map<string, number>> { return this.executor.functionRows(); }

  /** a connection for one Postgres session (on the executor worker: SessionRunner) */
  runner(): Promise<DuckRunner> { return this.executor.runner(); }

  /**
   * The source's order of text under a libc collation (src/duck/libc-order.ts), kept in the copy: the one recorded
   * for this collation and version, in this release's form, else `read` from the source (a few seconds) and recorded.
   * `read: true` when it was.
   */
  async libcOrder(collate: string, version: string | null, read: () => Promise<LibcOrder>): Promise<{ order: LibcOrder; read: boolean }> {
    await this.writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
    await this.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.libc_order (collation_name VARCHAR, collation_version VARCHAR, data VARCHAR)`);
    const kept = (await this.writer.runAndReadAll(`SELECT data FROM ${MASON_SCHEMA}.libc_order WHERE collation_name = $1 AND collation_version IS NOT DISTINCT FROM $2`, [collate, version])).getRowsJS();
    if (kept.length > 0 && isCurrentLibcOrder(String(kept[0]![0]))) return { order: decodeLibcOrder(String(kept[0]![0])), read: false };
    const order = await read();
    // one order per collation: a version that moved replaces the last one's
    await this.writer.run(`DELETE FROM ${MASON_SCHEMA}.libc_order WHERE collation_name = $1`, [collate]);
    await this.writer.run(`INSERT INTO ${MASON_SCHEMA}.libc_order VALUES ($1, $2, $3)`, [collate, version, encodeLibcOrder(order)]);
    return { order, read: true };
  }

  /** What the Postgres listener runs DuckDB statements with: a connection per session, and each statement's plan,
   *  its text sorted as the SOURCE sorts it (`collation`, pg_database's; absent, by bytes; a libc one by `libc`, its
   *  order as `libcOrder` read it), refusing what is not `verified` (null: nothing is refused for it, the oracle's
   *  recording run alone). */
  async listener(collation: { provider: string; collate: string; locale: string | null } | undefined,
    verified: ReadonlyMap<string, string> | null = VERIFIED, libc?: LibcOrder, copies: () => readonly CopyState[] = () => [], kept?: KeptRoutes): Promise<DuckOptions & { collation: DuckCollation }> {
    const known = new Set((await this.writer.runAndReadAll("SELECT collname FROM pragma_collations()")).getRowsJson().map((r) => String(r[0])));
    quoteDuckKeywords((await this.writer.runAndReadAll("SELECT keyword_name FROM duckdb_keywords() WHERE keyword_category <> 'unreserved'")).getRowsJson().map((r) => String(r[0])));
    const named = collation === undefined ? { kind: "bytes" as const } : duckCollation(collation.provider, collation.collate, collation.locale, known);
    // (a libc locale whose strcoll is byte order, musl's or macOS's: src/duck/libc-order.ts)
    const c: DuckCollation = named.kind === "libc" && libc?.bytes === true ? { kind: "bytes" } : named;
    if (c.kind === "libc") {
      if (libc === undefined) throw new Error(`the database orders text by the libc collation ${collation!.collate}, and its order was not read (Mason bug: report it)`);
      await this.executor.registerLibcOrder(libc);
    }
    // a jsonb's stored key is this collation's (src/duck/kept.ts `orderBy`)
    await kept?.orderBy(c, c.kind === "libc" ? libc : undefined);
    return {
      collation: c,
      open: () => this.runner(),
      plan: (catalog, text, stmt, base, paramOids, searchPath, timeZone, userTypes, wireBound, grants, relations) =>
        planDuck({ catalog, text, stmt, base, paramOids, searchPath, timeZone, collation: c, verified, userTypes, copies, kept: kept ?? null, wireBound: wireBound ?? false, grants, ...(relations === undefined ? {} : { relations }) }),
      parameters: duckParameters,
      // the sync's state, which EXPLAIN says how each copy is kept current from (src/duck/sync.ts KeptCurrent)
      copies,
      // a stored JSON path ready or gone (src/duck/kept.ts): the plans kept are made again
      ...(kept !== undefined ? { generation: () => kept.generation() } : {}),
    };
  }

  /** Closes the copy: every connection and the instance, on its thread, then the thread. Resolves once it is closed
   *  (a second open of the file waits for it), or once the executor's grace has passed whatever the thread does
   *  (src/duck/executor.ts CLOSE_GRACE_MS); never rejects — a failure is said in the log. */
  close(): Promise<void> {
    clearInterval(this.spillTimer);
    if (this.closed === null) { this.closed = this.executor.close(this.closeGraceMs); this.closing(this.closed); }
    return this.closed;
  }
}

/** A Postgres `search_path` as DuckDB's: `"$user", public` → `public` (no schema is a user's here). */
export function duckSearchPath(pg: string): string {
  const names = pg.split(",").map((s) => s.trim()).filter((s) => s !== "" && s !== '"$user"' && s !== "$user")
    .map((s) => s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s.toLowerCase());
  return (names.length ? names : ["public"]).join(",");
}

const quoteLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * A DuckDB error as Postgres would raise it: the SQLSTATE a driver branches on, the message, and the way out. DuckDB
 * prefixes each message with its kind (`Catalog Error: …`, `Binder Error: …`), which decides the code.
 */
/** A DuckDB statement's failure under its signal, read ONE way on every path (`streamed`, a plain EXPLAIN): an abort
 *  with a reason (the statement timeout, server.ts armTimeout) is that reason, never DuckDB's "interrupted" read as a
 *  user's cancel; an abort without one is the cancel; else the error itself (the Fable review of #517: a plain
 *  EXPLAIN's own catch said a timeout was the user's cancel). */
export function failureOf(signal: AbortSignal, e: unknown, sql: string): StatementError {
  if (signal.aborted && signal.reason instanceof StatementError) return new StatementError(signal.reason.fields, sql);
  if (signal.aborted) return new StatementError({ code: "57014", message: "canceling statement due to user request" }, sql);
  return e instanceof StatementError ? e : pgErrorOf(e, sql);
}

export function pgErrorOf(err: unknown, sql: string): StatementError {
  if (err instanceof StatementError) return err;
  const full = err instanceof Error ? err.message : String(err);
  const kind = /^([A-Za-z ]+) Error: /.exec(full)?.[1] ?? "";
  const message = full.replace(/^[A-Za-z ]+ Error: /, "").replace(/\n\n?LINE \d+:[\s\S]*$/, "").trim();
  // NO ROOM TO SPILL (issue 105): the ceiling, or the disk itself before it. Postgres's class for a full disk, in
  // Mason's words: the engine's text names a path and a setting no client of Mason has, so it stays out of the answer
  // Read by the engine's own kind and sentence: a statement's literal may hold the same words in any other error
  const ceiling = kind === "Out of Memory" && /This limit was set by the 'max_temp_directory_size' setting/.test(full);
  if (ceiling || (kind === "IO" && /No space left on device/.test(full))) {
    return new StatementError({ code: ceiling ? "53400" : "53100", message: ceiling ? "could not write to temporary file: this statement needs more room on disk than statements may take"
      : "could not write to temporary file: No space left on device",
    hint: "ask for less at once (a filter, a LIMIT, fewer or narrower columns, a coarser GROUP BY), free disk where the synced data is, or raise MASON_SPILL_LIMIT (40GB; by default half of what is free) and start mason again; nothing else stopped" }, sql, "spill-limit");
  }
  const pg = postgresWording(kind, message);
  // a refusal raised inside DuckDB (a Mason function's, the rewrite's error() call) crossed it as its text alone: the
  // entry its text names (gapIn), read here, the one place that text becomes a statement's error
  // (Mason's own refusal keeps the engine's text out of the DETAIL: it may quote the row, tests/conventions.test.ts)
  // (a Mason function's error that carries Postgres's own DETAIL sends it as Postgres does, apart from the message)
  if (pg !== null) return new StatementError({ code: pg.code, message: pg.message, ...(pg.code === "0A000" ? {} : { detail: pg.detail ?? `the engine: ${message}` }) }, sql, pg.gap ?? (pg.code === "0A000" ? gapIn(pg.message) : null));
  const fn = /(?:Scalar|Aggregate|Table) Function with name "?([A-Za-z_][\w]*)"? does not exist/.exec(message)?.[1];
  if (fn !== undefined) {
    // what reaches DuckDB was verified against Postgres (src/duck/verified.ts), so a function DuckDB lacks is a gap in
    // Mason's rewrite, never something for the client to write in DuckDB's dialect
    return new StatementError({ code: "0A000", message: `function ${fn}() is not supported: Mason's engine has no ${fn}`,
      hint: "this is a gap in Mason's translation: report it with the statement (docs/SQL-SUPPORT.md lists what is known)", detail: `the engine: ${message}` });
  }
  const table = /Table with name "?([^"!\s]+)"? does not exist/.exec(message)?.[1];
  if (table !== undefined) {
    // DuckDB's miss comes after the catalog held the table (the plan passed): one dropped as no longer added, whose way
    // back is `mason add`, so no copy state is read
    return new StatementError({ code: "42P01", message: `relation "${table}" does not exist`,
      hint: missingRelationHint(table, []), detail: `the engine: ${message}` });
  }
  const code = kind === "Parser" ? "42601"
    : kind === "Catalog" ? "42P01"
    : kind === "Binder" && /column .*not found|Referenced column|does not have a column named|referenced that exists in the SELECT clause/i.test(message) ? "42703"
    // Postgres's "missing FROM-clause entry for table": DuckDB says it too for a column it cannot find through a table
    // the FROM does name (`"public"."customers"."nope"`)
    : kind === "Binder" && /Referenced table .* not found/i.test(message) ? "42P01"
    // a function DuckDB has, but not with these arguments (Postgres's to_timestamp(text, format))
    : kind === "Binder" && /No function matches the given name and argument types/i.test(message) ? "42883"
    : kind === "Binder" && /GROUP BY|aggregate/i.test(message) ? "42803"
    : kind === "Binder" ? "42804"
    : kind === "Conversion" ? "22P02"
    : kind === "Out of Range" ? "22003"
    : kind === "Interrupt" || /INTERRUPT/i.test(full) ? "57014"
    : kind === "Out of Memory" ? "53200"
    : kind === "Not implemented" ? "0A000"
    : kind === "Invalid Input" ? "22023"
    : "XX000";
  return new StatementError({ code, message: code === "57014" ? "canceling statement due to user request"
      : code === "53200" ? "out of memory: this statement needs more than the memory Mason's engine may use, in a part that cannot spill to disk" : message,
    // DuckDB's own advice is SET, which a client of Mason cannot do: Mason's way out instead
    ...(code === "53200" ? { hint: "ask for less at once (a filter, a LIMIT, fewer or narrower columns, a coarser GROUP BY), or raise MASON_DUCKDB_MEMORY (8GB, 24GB) and start mason again; nothing else stopped" } : {}),
    // what Mason ran (the statement as rewritten for DuckDB, src/duck/rewrite.ts): a report of the error needs it
    detail: `the engine${kind ? ` ${kind} error` : ""}: ${message}${sql === "" ? "" : `; Mason ran: ${oneLine(sql, 2000)}`}`,
    // Postgres accepted the GROUP BY (it analysed the statement first): DuckDB refusing it is Mason's rewrite's gap
    ...(code === "42803" ? { hint: "Postgres accepts this GROUP BY and Mason's rewrite did not carry it to the engine: report it with the statement; adding the column to the GROUP BY answers meanwhile" } : {}),
  }, sql);
}

/** The errors DuckDB raises for what Postgres raises too, in Postgres's code and words (a tool or a person matches them). */
function postgresWording(kind: string, message: string): { code: string; message: string; gap?: GapId | null; detail?: string } | null {
  if (/^Division by zero\b/i.test(message) || message === "division by zero") return { code: "22012", message: "division by zero" };
  const zone = /Unknown TimeZone '([^']*)'/.exec(message);
  if (zone) return { code: "22023", message: `time zone "${zone[1]}" not recognized` };
  const overflow = /Overflow in (?:addition|subtraction|multiplication|negation|cast) of (INT16|INT32|INT64)/.exec(message);
  if (overflow) return { code: "22003", message: `${{ INT16: "smallint", INT32: "integer", INT64: "bigint" }[overflow[1] as "INT16"]} out of range` };
  // a cast of a number to an integer type it does not fit
  const narrow = /can't be cast because the value is out of range for the destination type (INT16|INT32|INT64)|Failed to cast decimal value \S+ to type (INT16|INT32|INT64)/.exec(message);
  if (narrow) return { code: "22003", message: `${{ INT16: "smallint", INT32: "integer", INT64: "bigint" }[(narrow[1] ?? narrow[2]) as "INT16"]} out of range` };
  // make_date / make_timestamp of a field out of range
  const field = /^Date out of range: (.*)$/.exec(message);
  if (field) return { code: "22008", message: `date field value out of range: ${field[1]}` };
  // a cast to numeric(p, s) of a value with more than p - s integer digits
  // (and of a number constant that does not fit: `12345::numeric(3)`, DuckDB's "Could not cast value 12345 to DECIMAL(3,0)")
  if (/Casting value "[^"]*" to type DECIMAL\(\d+,\s*\d+\) failed: value is out of range|^Could not cast value \S+ to DECIMAL\(\d+,\s*\d+\)$/.test(message)) return { code: "22003", message: "numeric field overflow" };
  // an exact sum past DuckDB's 38 digits (a text read as numeric is summed as a DECIMAL(38,18), src/duck/rewrite.ts summed)
  if (/^Overflow in HUGEINT addition\b/.test(message)) return { code: "0A000", message: `a sum past the engine's 38 digits is not supported by Mason (${gapMark("numeric-exact-sum")})`, gap: "numeric-exact-sum" };
  // a numeric(p, s) read from a text holding NaN or Infinity (src/duck/rewrite.ts pgInput): DuckDB's decimal has none
  if (/Could not convert string ['"](NaN|-?Infinity)['"] to DECIMAL/.test(message)) return { code: "0A000", message: `a numeric NaN or Infinity read from a text is not supported by Mason (${gapMark("numeric-special")})`, gap: "numeric-special" };
  const conv = /Could not convert string '((?:[^']|'')*)' to (INT16|INT32|INT64|DOUBLE|FLOAT|DATE|TIMESTAMP|UUID|BOOL)/.exec(message);
  if (conv) {
    const t = { INT16: "smallint", INT32: "integer", INT64: "bigint", DOUBLE: "double precision", FLOAT: "real", DATE: "date", TIMESTAMP: "timestamp", UUID: "uuid", BOOL: "boolean" }[conv[2] as "INT16"];
    return { code: "22P02", message: `invalid input syntax for type ${t}: "${conv[1]!.replaceAll("''", "'")}"` };
  }
  // a Mason function's own error (src/duck/functions.ts): Postgres's words after the prefix
  // Postgres's own error, from its own function (src/duck/pg-eval.ts): its SQLSTATE, said
  const pg = /^mason\[([0-9A-Z]{5})\]: (.*?)(?:\nDETAIL: (.*))?$/s.exec(message);
  if (pg) return { code: pg[1]!, message: pg[2]!, ...(pg[3] === undefined ? {} : { detail: pg[3] }) };
  const own = /^mason: (.*)$/s.exec(message);
  if (own) return { code: /^cannot |argument list|key must not be null/.test(own[1]!) ? "22023" : /^invalid input syntax/.test(own[1]!) ? "22P02" : / is not supported| not supported for type /.test(own[1]!) ? "0A000" : "XX000", message: own[1]! };
  // the rewrite's own error() calls carry Postgres's message (src/duck/rewrite.ts)
  if (kind === "Invalid Input" && /^invalid input syntax for type /.test(message)) return { code: "22P02", message };
  return null;
}

/** when the wait for a statement to end is said in the log */
const ENDING_SLOW_MS = 5_000;

/** One wire session's DuckDB connection, with the session's zone and search_path applied before each statement. Runs
 *  on the executor worker (src/duck/executor-worker.ts), its statements asked by the listener's RemoteRunner. */
export class SessionRunner implements DuckRunner {
  /** the session's slot of the cancel table (src/duck/cancel.ts), which its connection's `__mason_session` names */
  private readonly slot: number;
  private readonly cancels: Int32Array;
  /** the number of the statement `run` or `explain` is asked next (the listener's, carried by the request) */
  next = 0;
  /** the answers being drained (`streamed`): `close` and the next statement wait for them first */
  private readonly releasing = new Set<Promise<void>>();
  /** what runs on the connection now: a statement being started, a chunk being read, an EXPLAIN. `close` waits for it
   *  too — a connection closed under DuckDB's pending call aborted the process (a stop during a drain) */
  private readonly busy = new Set<Promise<unknown>>();
  /** the answer left open on the connection, if any: what `close` drains before it closes the connection */
  private openAnswer: (() => void) | null = null;
  private readonly conn: DuckDBConnection;
  private readonly log: (line: string) => void;
  private zone: string | null = null;
  private path: string | null = null;
  private settings: string | null = null;
  private constructor(conn: DuckDBConnection, log: (line: string) => void, slot: number, cancels: Int32Array) {
    this.conn = conn; this.log = log; this.slot = slot; this.cancels = cancels;
  }

  /** a connection for one Postgres session, in the cancel table's `slot` */
  static async open(instance: DuckDBInstance, log: (line: string) => void, slot: number, cancels: Int32Array): Promise<SessionRunner> {
    const conn = await instance.connect();
    // NULLs sort as Postgres sorts them: last ascending, FIRST descending (DuckDB's default is last both ways). An
    // integer division is the rewrite's `//` where Postgres's operator is integer division (src/duck/rewrite.ts), so
    // DuckDB's `/` stays the float division every other `/` is
    await conn.run("SET default_null_order = 'nulls_last_on_asc_first_on_desc'");
    // every Mason function's first argument (src/duck/functions.ts "every call carries its session")
    await conn.run(`SET VARIABLE ${SESSION_VARIABLE} = ${quoteLiteral(slotName(slot))}`);
    return new SessionRunner(conn, log, slot, cancels);
  }

  private async settle(session: DuckSession): Promise<void> {
    if (session.timeZone !== this.zone) { await this.conn.run(`SET TimeZone = ${quoteLiteral(session.timeZone)}`); this.zone = session.timeZone; }
    // Postgres skips a schema of the path that does not exist; DuckDB refuses the SET (and with it every statement):
    // the path is the schemas DuckDB has (a table added later in a new schema is found at the next statement)
    const have = new Set(((await this.conn.runAndReadAll("SELECT schema_name FROM duckdb_schemas() WHERE database_name = current_database()")).getRowsJS() as [string][]).map(([n]) => n));
    const wanted = duckSearchPath(session.searchPath).split(",").filter((n) => have.has(n));
    const path = (wanted.length > 0 ? wanted : ["main"]).join(",");
    if (path !== this.path) { await this.conn.run(`SET search_path = ${quoteLiteral(path)}`); this.path = path; }
    // what `current_setting(name)` reads (src/duck/rewrite.ts `settingRead`): the session's settings, as one map
    const settings = JSON.stringify(session.settings);
    if (settings !== this.settings) {
      const entries = Object.entries(session.settings).map(([k, v]) => `${quoteLiteral(k)}: ${quoteLiteral(v)}`).join(", ");
      await this.conn.run(`SET VARIABLE ${SETTINGS_VARIABLE} = MAP {${entries}}::MAP(VARCHAR, VARCHAR)`);
      this.settings = settings;
    }
  }

  private async prepare(sql: string): Promise<DuckDBPreparedStatement> {
    try { return await this.conn.prepare(sql); }
    catch (e) { throw pgErrorOf(e, sql); }
  }


  /**
   * A statement STREAMED (`SELECT *` of 23 M rows held every row three times over — DuckDB's, as JavaScript
   * values, encoded — and ran the run out of heap): the answer reads DuckDB's result a chunk at a time, and the
   * listener writes each chunk before it asks for the next. The cursor holds the connection (DuckDB starts nothing
   * else on it until the result is read or closed) and the signal's interrupt until it ends: read to the end, failed,
   * or closed.
   */
  async run(sql: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal,
    fields: ReadonlyArray<{ name: string; oid: number; typmod?: number }> | null = null, exact: readonly ExactColumn[] = []): Promise<DuckAnswer> {
    return (await this.track(this.streamed(sql, params, session, signal, fields, exact))).answer;
  }

  /** `p`, held in `busy` until it settles */
  private track<T>(p: Promise<T>): Promise<T> {
    this.busy.add(p);
    void p.then(() => this.busy.delete(p), () => this.busy.delete(p));
    return p;
  }

  /** `run`, and where its time goes as it is read: DuckDB's (its prepare, which plans; each chunk it computes) and
   *  Mason's (the exact numerics, the encoding), ms — what an EXPLAIN ANALYZE says. `profile`: the file DuckDB's
   *  profiler writes this statement's profile to (EXPLAIN ANALYZE), turned on here, after the settle */
  private async streamed(planned: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal,
    fields: ReadonlyArray<{ name: string; oid: number; typmod?: number }> | null, exact: readonly ExactColumn[],
    profile: string | null = null): Promise<{ answer: DuckAnswer; timing: { prepareMs: number; duckdbMs: number; masonMs: number } }> {
    const sql = planned.text;
    const seq = this.next;
    await Promise.all([...this.releasing]);
    // this statement's calls read their cancel from here on: never before the last one is released, which a cancel of
    // its own still drains (src/duck/cancel.ts)
    beginStatement(this.cancels, this.slot, seq);
    try { await this.settle(session); }
    catch (e) { throw pgErrorOf(e, sql); }
    // THE PROFILER IS ON FOR THE STATEMENT ALONE: DuckDB writes the profile of the LAST statement it profiled on the
    // connection, so it is turned on after every other statement Mason runs here (the settle's probe of the schemas,
    // turned on before it, was reported as the plan of a count(*) that wrote no profile of its own), and the caller turns
    // it off before it runs another (`explained`, which also holds the profile to the statement's text)
    if (profile !== null) {
      try { await this.conn.run("SET enable_profiling = 'json'"); await this.conn.run(`SET profiling_output = ${quoteLiteral(profile)}`); }
      catch (e) { throw pgErrorOf(e, sql); }
    }
    const timing = { prepareMs: 0, duckdbMs: 0, masonMs: 0 };
    const t0 = performance.now();
    const p = await this.prepare(sql);
    timing.prepareMs = performance.now() - t0;
    // HOW A STATEMENT IS CANCELLED (src/duck/functions.ts "every call carries its session"; the test
    // server's hung process). It is interrupted — its tasks stop at their next chunk — and, if it calls a Mason
    // function, cancelled through its session as well: its next call raises, so a task of it does not call on. Its
    // result is closed only once DuckDB ended the query, on a thread that is not this one (`cleanUp`: a task still
    // inside a call waits for this thread, which a close would hold). Whether it calls
    // one is the PLAN's (src/duck/plan.ts PlannedSql `functions`, read off the rewritten tree), never a match on its
    // text: a stored JSON path's column and the view of a copy's visible columns are named `__mason_…` too, and
    // read as calls, every `SELECT *` over such a copy was cancelled only by a call it never made (a review
    // finding: 82 s past a 300 ms statement_timeout)
    const callsFunctions = planned.functions.length > 0;
    const cancel = (): void => { if (callsFunctions) cancelStatement(this.cancels, this.slot, seq); this.conn.interrupt(); };
    // A CANCEL ASKED IS A CANCEL ANSWERED: a function-calling statement past its last call runs on to its end, and one
    // whose cancel lands as its last chunk is computed has nothing left to stop — either is told 57014, never "ok" (the
    // listener's thread words it as its own signal says: the timeout's or the cancel's, src/duck/executor.ts)
    const cancelAsked = (): boolean => signal.aborted || (callsFunctions && statementCancelled(this.cancels, this.slot, seq));
    const cancelled = (): StatementError => signal.aborted ? failureOf(signal, null, sql)
      : new StatementError({ code: "57014", message: "canceling statement due to user request" }, sql);
    signal.addEventListener("abort", cancel);
    const failure = (e: unknown): StatementError => failureOf(signal, e, sql);
    // an abort before the listener was there (the timeout fired in the settle or the prepare) cancels nothing
    if (signal.aborted) { signal.removeEventListener("abort", cancel); p.destroySync(); throw failure(null); }
    const started = Date.now();
    let total = 0;
    let result: DuckDBResult | null = null;
    let closed = false, fetching = false, released = false, said = false;
    /** DuckDB ended the query: a fetch failed, or read its end (`cleanUp` says why that is what `release` waits for) */
    let ended = false;
    let ending = false;
    // ITS LINE IS SAID WHEN IT ENDS, before its client hears the end, never when its result is released: that waits for
    // DuckDB to end it (`cleanUp`), by when its client is gone and the next session's statements are running, and a
    // reader of the log took the late line for theirs (`tests/duck-wire.test.ts`, 1 run in 100 under load). The
    // worker's port keeps the order: a line posted before the answer is read before it
    const say = (): void => {
      if (said) return;
      said = true;
      this.log(`statement: ${total} row(s) in ${Date.now() - started} ms — ${oneLine(sql)}`);
    };
    const release = (): void => {
      if (released) return;
      released = true;
      if (this.openAnswer === close) this.openAnswer = null;
      signal.removeEventListener("abort", cancel);
      result?.closeSync();
      p.destroySync();
      say();
    };
    // A STATEMENT THAT DID NOT RUN TO ITS END (it failed, its cancel raised, it was closed early) IS CLOSED ONLY ONCE
    // DuckDB ENDED IT OFF THIS THREAD (`cleanUp`), the session's next statement waiting for that (`releasing`). One read
    // to its end has no task left, and is released at once
    const endOffThisThread = (): void => {
      if (released || ending) return;
      ending = true;
      const done = (async () => { await this.cleanUp(seq, sql, callsFunctions, ended ? null : result); release(); })();
      this.releasing.add(done);
      void done.finally(() => this.releasing.delete(done));
    };
    // it ended with an answer its client is about to hear: said now
    const releaseAfterCleanup = (): void => { if (!released) say(); endOffThisThread(); };
    // a result closed before its end while no fetch is in flight: no end its client hears, so its line is its release's
    const drain = (): void => {
      // CLOSED WHILE DuckDB STILL STARTS IT (its `stream()` pending: an aggregate computes there whole): nothing is
      // released under the pending start — that destroyed the prepared statement under it and, its release done, let the
      // start's own failure skip `cleanUp`, so the connection and the instance closed while its other tasks still had
      // calls queued for this thread, and the thread's end met them (Linux CI: `FATAL ERROR: Error::Error
      // napi_define_properties`, 7 runs in 30 of a stop under a calling count). The start's own path releases it: its
      // failure through `releaseAfterCleanup`, its answer drained once handed back (below `stream()`)
      if (result !== null) endOffThisThread();
    };
    // an early end by the listener (a portal closed half read, the session gone): cancelled, and released — by the
    // fetch in flight once DuckDB hands the chunk back, else by `drain`
    const close = (): void => {
      if (closed) return;
      closed = true;
      cancel();
      if (!fetching) drain();
    };
    this.openAnswer = close;
    try {
      if (p.parameterCount !== params.length) {
        throw new StatementError({ code: "08P01", message: `bind message supplies ${params.length} parameters, but the statement requires ${p.parameterCount}` }, sql);
      }
      // a value comes as text and DuckDB casts it to the parameter's type, as Postgres reads an untyped literal
      params.forEach((v, i) => { if (v === null) p.bindNull(i + 1); else p.bindVarchar(i + 1, v); });
      const t1 = performance.now();
      try { result = await p.stream(); }
      catch (e) { throw failure(e); }
      // CLOSED WHILE IT STARTED (`drain` above), now that DuckDB handed it back, and drained. One that calls no function
      // is told the cancel here, its release done first, before a column of a destroyed result is asked (DuckDB
      // answers 0 columns for one: a review finding, an XX000 "report it" where the session had closed); one that calls
      // holds its result open until DuckDB ended it, so its answer below is built from a live result and its fetch
      // tells the cancel
      if (closed) {
        drain();
        if (!callsFunctions) { await Promise.all([...this.releasing]); throw cancelled(); }
      }
      timing.duckdbMs += performance.now() - t1;
      const r = result;
      if (fields !== null && r.columnCount < fields.length) throw new StatementError({ code: "XX000", message: `the engine answered ${r.columnCount} column(s) where Postgres's analysis has ${fields.length}: report it (Mason's rewrite)` }, sql);
      // Postgres's columns where its analysis gave them (a WITH TIES rank DuckDB adds after them is not sent)
      const columns = fields !== null
        ? fields.map((f, i) => pgTypedColumn(f.name, f.oid, r.columnType(i), f.typmod))
        : Array.from({ length: r.columnCount }, (_, i) => wireColumn(r.columnName(i), r.columnType(i)));
      const computed = fields !== null && exact.length > 0 ? exactColumns(columns, fields, exact, (i) => r.columnType(i)) : null;
      // EVERY TYPE GAP IS LOGGED, per statement (decision 6 of the prototype's design): which DuckDB types reach a tool where Postgres's differ
      for (const c of columns.filter((x) => x.divergence !== null)) this.log(`type gap: column ${JSON.stringify(c.name)}: ${c.divergence} — in ${oneLine(sql)}`);
      const answer: DuckAnswer = {
        columns,
        fetch: async (formats, s) => {
          // closed under a cancel (a stop drains every answer it aborted): the cancel's answer, never an end
          if (closed) { if (cancelAsked()) throw cancelled(); return null; }
          try {
            // a cancel that came while nothing ran (the listener waiting for the client to read): DuckDB had nothing to
            // interrupt, so it is said here, before the next chunk is read
            if (cancelAsked()) throw cancelled();
            let chunk;
            const c0 = performance.now();
            fetching = true;
            try { chunk = await this.track(r.fetchChunk()); }
            catch (e) { ended = true; throw failure(e); }
            finally { fetching = false; }
            ended = chunk === null || chunk.rowCount === 0;
            if (closed) { drain(); return null; }
            const c1 = performance.now();
            timing.duckdbMs += c1 - c0;
            // read to its end: the executor is done, and the result released at once — unless its cancel was asked
            // meanwhile, which it ran past (`cancelAsked`)
            if (chunk === null || chunk.rowCount === 0) {
              closed = true;
              // ended under a cancel (or an interrupt that DuckDB answered as an end): closed once its calls stopped
              if (cancelAsked()) { releaseAfterCleanup(); throw cancelled(); }
              release();
              return null;
            }
            let rows = chunk.getRows() as DuckDBValue[][];
            if (computed !== null) rows = exactRows(computed, rows, fields!.length, sql, params);
            total += rows.length;
            const encoded = encodeRows(columns, rows, formats, s);
            timing.masonMs += performance.now() - c1;
            return encoded;
          } catch (e) { closed = true; releaseAfterCleanup(); throw e; }
        },
        close,
      };
      return { answer, timing };
    } catch (e) { closed = true; releaseAfterCleanup(); throw e; }
  }

  /**
   * EXPLAIN of a plan (src/duck/explain.ts). Without ANALYZE: DuckDB's `EXPLAIN (FORMAT JSON)` of the planned SQL, its
   * parameters bound. With it: the statement RUN as `run` runs it — every chunk read, its exact numerics computed and
   * encoded, none sent — with DuckDB's profiler writing each operator's rows and time to a file of its own, read after.
   * Then the copies its scans read: their rows, and how each is kept current as the sync says it (`how.copies`).
   */
  explain(sql: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal,
    how: ExplainHow): Promise<string[]> {
    return this.track(this.explained(sql, params, session, signal, how));
  }

  private async explained(sql: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal,
    how: ExplainHow): Promise<string[]> {
    const o = how.options;
    // A STATEMENT THAT READS A FILTERED TABLE IS NEVER SHOWN TO THE ENGINE: its plan says what it proved from the table's
    // statistics (docs/DESIGN.md "Roles: rows per user"), so the tables are the statement's and its filters' (a through:'s
    // parents), and the rest is Mason's plan
    if ((how.rowFilters ?? []).length > 0) {
      const tables = [...new Set([...(how.reads ?? []), ...(how.rowFilters ?? []).map((f) => f.table)])].map((t) => { const dot = t.indexOf("."); return { schema: t.slice(0, dot), name: t.slice(dot + 1) }; });
      const explained: Explained = { copies: await this.copies(tables, how.copies, how.rowFilters ?? []), sql: oneLine(sql.text), computed: computedOf(how.exact, how.fields),
        functions: [...sql.functions], plan: [], filtered: true };
      return o.format === "json" ? [explainJson(explained, o)] : explainText(explained, o);
    }
    await Promise.all([...this.releasing]);
    let plan: PlanNode[];
    let analyzed: Explained["analyzed"];
    if (!o.analyze) plan = await this.plainPlan(sql, params, session, signal);
    else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-explain-"));
      const file = path.join(dir, "profile.json");
      try {
        let rows = 0;
        let timing;
        try {
          const s = await this.streamed(sql, params, session, signal, how.fields, how.exact, file);
          timing = s.timing;
          try { for (let chunk = await s.answer.fetch([], { timeZone: session.timeZone }); chunk !== null; chunk = await s.answer.fetch([], { timeZone: session.timeZone })) rows += chunk.length; }
          finally { s.answer.close(); }
        } finally { await Promise.all([...this.releasing]); await this.conn.run("PRAGMA disable_profiling"); }
        // THE PROFILE IS HELD TO THE STATEMENT, never assumed its: DuckDB writes one when the result is read to its end,
        // naming the statement it timed. None: DuckDB ran no operator (it answered while planning — a count(*) of a
        // whole table is the table's row count), and its plan is its EXPLAIN, the rows the ones it answered
        const profile = fs.existsSync(file) ? profiled(JSON.parse(fs.readFileSync(file, "utf8"))) : null;
        if (profile !== null && profile.sql !== sql.text) {
          throw new StatementError({ code: "XX000", message: `the engine's profile of an EXPLAIN ANALYZE is of another statement (${oneLine(profile.sql ?? "none named")}): report it (Mason's EXPLAIN)` }, sql.text);
        }
        if (profile !== null) plan = profile.plan;
        else {
          plan = await this.plainPlan(sql, params, session, signal);
          if (plan[0] !== undefined) plan[0].actualRows = rows;
        }
        analyzed = { rows, profiled: profile !== null, planning: { ...how.planning, duckdbMs: timing.prepareMs }, execution: { duckdbMs: timing.duckdbMs, masonMs: timing.masonMs } };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    // what it calls is the plan's (src/duck/plan.ts PlannedSql), the list that decides how it is cancelled
    const explained: Explained = { copies: await this.copies(scannedTables(plan), how.copies, how.rowFilters ?? []), sql: oneLine(sql.text), computed: computedOf(how.exact, how.fields),
      functions: [...sql.functions], plan, ...(analyzed === undefined ? {} : { analyzed }) };
    return o.format === "json" ? [explainJson(explained, o)] : explainText(explained, o);
  }

  /** DuckDB's `EXPLAIN (FORMAT JSON)` of the planned SQL, its parameters bound: its plan, estimates only */
  private async plainPlan(sql: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal): Promise<PlanNode[]> {
    try { await this.settle(session); }
    catch (e) { throw pgErrorOf(e, sql.text); }
    const p = await this.prepare(`EXPLAIN (FORMAT JSON) ${sql.text}`);
    const interrupt = (): void => this.conn.interrupt();
    signal.addEventListener("abort", interrupt);
    try {
      if (signal.aborted) throw failureOf(signal, null, sql.text);
      params.forEach((v, i) => { if (v === null) p.bindNull(i + 1); else p.bindVarchar(i + 1, v); });
      let r;
      try { r = await p.runAndReadAll(); }
      catch (e) { throw failureOf(signal, e, sql.text); }
      return planNodes(JSON.parse(String(r.getRowsJS()[0]?.[1] ?? "[]")));
    } finally { signal.removeEventListener("abort", interrupt); p.destroySync(); }
  }

  /** each copy's rows, and the sync's facts of it (how it is kept current: src/duck/sync.ts `KeptCurrent`, never the
   *  poll's ledger read here — a project switched to logical replication still holds its last poll there) */
  private async copies(tables: readonly TableName[], facts: readonly CopyFacts[], filters: ReadonlyArray<{ table: string; words: string }> = []): Promise<Copy[]> {
    const out: Copy[] = [];
    for (const { schema, name } of tables) {
      // the sync's source is the two names as they are; EXPLAIN says the table as a statement writes it (qualifiedName)
      const filter = filters.find((f) => f.table === `${schema}.${name}`)?.words;
      // a table the role filters: its counts are every row's, not the role's, and are never read or said here
      const rows = filter !== undefined ? null : (await this.conn.runAndReadAll("SELECT estimated_size FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2", [schema, name])).getRowsJS()[0]?.[0];
      out.push({ table: qualifiedName({ schema, name }), rows: rows === undefined || rows === null ? null : Number(rows), facts: facts.find((f) => f.source === `${schema}.${name}`) ?? null,
        ...(filter !== undefined ? { filter } : {}) });
    }
    return out;
  }

  /**
   * A STATEMENT THAT DID NOT RUN TO ITS END, ENDED BY DuckDB OFF THIS THREAD before its result is closed. THIS THREAD
   * NEVER WAITS FOR THE ENGINE'S TASKS: every close is synchronous here, a close of an open result waits for the query's
   * tasks (Executor::CancelTasks), and this thread runs every Mason function, so a task inside a call waits for it (the
   * suite hung for good at 0 % CPU; `tests/duck-executor.test.ts` "a vector slower than"). Waiting for quiet instead —
   * no call for 50 ms, as this did — was no proof: a vector whose native work outlasts the window has made no call yet.
   * And a call-free statement's tasks hold this thread as long as DuckDB's vector takes, with every session behind it.
   *
   * WHAT WAITS IS A FETCH (read in DuckDB 2.0's source, `ClientContext::EndQueryInternal`, and held by the test above).
   * Every end of a query runs `CancelTasks` on the thread that ends it, and a fetch runs on libuv's pool. Interrupted
   * first, the next fetch does not compute: it fails at once (`BufferedData::Participate`), ending the query there, its
   * tasks waited for while this thread answers their calls; or it reads the end, or the end was read already (`r`
   * null). So the wait is bounded by DuckDB's next chunk, on a statement that never ends by itself too, and an EMPTY chunk
   * is the end, as `fetch` reads it: past its end a streamed result hands back empty chunks for ever, never null.
   *
   * THE PROBE PROVES IT (a statement performs no wait: while a result holds the connection DuckDB refuses it, "connection
   * has an open result", before anything else). So a `SELECT 1` that ran is proof that nothing of the statement is left,
   * and the close finds nothing to wait for. Refused, the reading above no longer holds: said as a Mason bug, and closed
   * all the same, the watch (src/duck/executor.ts SILENT_MS) catching the deadlock if there is one. A wait past
   * `ENDING_SLOW_MS` is said once.
   */
  private async cleanUp(seq: number, sql: string, calls: boolean, r: DuckDBResult | null): Promise<void> {
    if (calls) cancelStatement(this.cancels, this.slot, seq);
    this.conn.interrupt();
    const slow = setTimeout(() => this.log(`a statement that did not run to its end has not stopped after ${ENDING_SLOW_MS / 1000} s; its result is closed once the engine ended it — ${oneLine(sql)}`), ENDING_SLOW_MS);
    try {
      if (r !== null) {
        try { for (let c = await r.fetchChunk(); c !== null && c.rowCount > 0; c = await r.fetchChunk()) { /* its rows are nobody's */ } }
        catch (e) {
          // the cancel's own refusal (the interrupt, or its next call raised, 57014) is what this waits for. Anything else
          // is the statement's real error, met after the listener let go of its answer: no one reads it any more, and a
          // rethrow here would reach no caller (it would end this thread, and with it every session), so it is said
          if (pgErrorOf(e, sql).fields.code !== "57014") this.log(`a statement closed before its end failed while it was drained: ${e instanceof Error ? e.message : String(e)} — ${oneLine(sql)}`);
        }
      }
      // an abort landing now interrupts the probe past DuckDB's check, which is its proof all the same
      try { await this.conn.run("SELECT 1"); }
      catch (e) {
        if (/open result/.test(String(e))) this.log(`a statement's result is still open after the engine failed or ended it (Mason bug, report it with mason logs): closed all the same — ${oneLine(sql)}`);
        else if (pgErrorOf(e, "SELECT 1").fields.code !== "57014") this.log(`the check that a statement ended failed: ${e instanceof Error ? e.message : String(e)} — ${oneLine(sql)}`);
      }
    } finally { clearTimeout(slow); }
  }

  /** Closes the connection once nothing runs on it: an answer left open drained (its statement cancelled), every
   *  answer released and every call of DuckDB settled (never under the executor: `drain`; a connection
   *  closed under a drain's pending fetch aborted the process). */
  async close(): Promise<void> {
    // an answer left open is closed and drained — and one a statement still STARTING opens while this waits (the
    // session closed between its ask and its answer: left open, the connection closed under it and its running tasks)
    for (let last: (() => void) | null = null; ;) {
      const open = this.openAnswer;
      if (open !== null && open !== last) { last = open; open(); }
      await this.idle();
      // released (null), or one already closed: done; a new one opened meanwhile: closed in turn
      if (this.openAnswer === null || this.openAnswer === last) break;
    }
    this.conn.closeSync();
  }

  /** Settles once nothing runs on the connection: every answer released and every call of DuckDB settled (an answer
   *  closed early is answered then: src/duck/executor-worker.ts `answer.close`). */
  async idle(): Promise<void> {
    for (let waiting = [...this.busy, ...this.releasing]; waiting.length > 0; waiting = [...this.busy, ...this.releasing]) await Promise.allSettled(waiting);
  }
}

/**
 * The exact numeric columns (src/duck/rewrite.ts ExactColumn): each computed from its cells as Postgres computes it
 * and written as Postgres's numeric (or its text), in place of DuckDB's value. A column whose cells DuckDB answered
 * inexactly (a double where the program needs digits) keeps DuckDB's value, and its divergence says so. Decided once
 * per statement, from DuckDB's column types, before any row is read.
 */
interface ComputedColumns { columns: readonly ExactColumn[]; readers: ReadonlyArray<((v: DuckDBValue) => string) | null> }

function exactColumns(columns: WireColumn[], fields: ReadonlyArray<{ name: string; oid: number }>, exact: readonly ExactColumn[],
  typeAt: (i: number) => DuckDBType): ComputedColumns | null {
  const base = fields.length;
  const readers = exact[0]!.cells.map((conv, j) => cellText(typeAt(base + j), conv));
  const computed = exact.filter((e) => {
    const unreadable = readers.some((r, j) => r === null && programReads(e, j));
    if (unreadable) columns[e.column] = { ...columns[e.column]!, divergence: `Postgres computes this numeric exactly; a part of it the engine computed as a double` };
    return !unreadable;
  });
  if (computed.length === 0) return null;
  for (const e of computed) {
    const f = fields[e.column]!;
    columns[e.column] = exactColumn(f.name, f.oid);
  }
  return { columns: computed, readers };
}

/** one chunk's rows with its exact columns computed */
function exactRows(computed: ComputedColumns, rows: DuckDBValue[][], base: number, sql: string, params: readonly (string | null)[]): DuckDBValue[][] {
  return rows.map((row) => {
    // a program's `$n` cell is the n-th parameter's bound text
    const values: Record<string, string | null> = Object.fromEntries(params.map((v, i) => [`$${i + 1}`, v]));
    computed.readers.forEach((r, j) => { const v = row[base + j] ?? null; values[String(j)] = v === null || r === null ? null : r(v); });
    const out = row.slice();
    for (const e of computed.columns) {
      try { out[e.column] = evaluateText(e.program, values); }
      catch (err) {
        if (err instanceof NumericError) throw new StatementError({ code: err.sqlstate, message: err.message, ...(err.detail === null ? {} : { detail: err.detail }) }, sql, err.gap);
        throw err;
      }
    }
    return out;
  });
}

/** what Mason computes after DuckDB, a column each: its exact numeric from DuckDB's values */
function computedOf(exact: readonly ExactColumn[], fields: ReadonlyArray<{ name: string }> | null): string[] {
  return exact.map((e) => {
    const cells = new Set(cellsOf(e.program).filter((k) => !k.startsWith("$"))).size;
    return `column ${e.column + 1}${fields?.[e.column] === undefined ? "" : ` "${fields[e.column]!.name}"`}: Postgres's exact numeric${e.text ? " as text" : ""}, from ${cells} of the engine's value(s)`;
  });
}

/** whether the column's program reads cell j */
const programReads = (e: ExactColumn, j: number): boolean => JSON.stringify(e.program).includes(`"key":"${j}"`);

/** a statement on one line: whole in the log (its ORDER BY, past 160 characters, was what told a slow preview's
 *  cause), cut where it goes to a client in an error's detail */
const oneLine = (sql: string, max = Infinity): string => { const t = sql.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 3)}…` : t; };

const formatAt = (formats: readonly number[], i: number): 0 | 1 =>
  (formats.length === 0 ? 0 : formats.length === 1 ? formats[0]! : formats[i] ?? 0) === 1 ? 1 : 0;

function encodeRows(columns: readonly WireColumn[], rows: readonly DuckDBValue[][], formats: readonly number[], session: PgSession): Buffer[] {
  return rows.map((row) => dataRow(columns.map((c, i) => c.encode(row[i] ?? null, formatAt(formats, i), session))));
}
