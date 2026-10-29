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
import { setTimeout as sleep } from "node:timers/promises";
import { DuckDBInstance, version, type DuckDBConnection, type DuckDBPreparedStatement, type DuckDBResult, type DuckDBValue } from "@duckdb/node-api";
import { Executor, type DuckConnection } from "./executor.ts";
import { beginStatement, cancelStatement, slotName, statementCancelled } from "./cancel.ts";
import type { PgSession } from "../api/postgres/encode.ts";
import { StatementError, type DuckAnswer, type DuckOptions, type DuckRunner, type ExplainHow } from "../api/postgres/server.ts";
import { duckParameters, missingRelationHint, planDuck, quoteDuckKeywords } from "./plan.ts";
import type { KeptRoutes } from "./kept-route.ts";
import type { CopyState } from "./sync.ts";
import { VERIFIED } from "./verified.ts";
import { msSinceCall, registerFunctions, SESSION_VARIABLE } from "./functions.ts";
import { duckCollation, type DuckCollation } from "./rewrite.ts";
import { decodeLibcOrder, encodeLibcOrder, type LibcOrder } from "./libc-order.ts";
import { dataRow } from "../api/postgres/protocol.ts";
import { cellText, exactColumn, pgTypedColumn, wireColumn, type WireColumn } from "./types.ts";
import type { ExactColumn } from "./rewrite.ts";
import { gapMark } from "./gaps.ts";
import { cellsOf, evaluateText, NumericError } from "../lib/pg-numeric.ts";
import { explainJson, explainText, planNodes, profiled, qualifiedName, scannedTables, type Copy, type CopyFacts, type Explained, type PlanNode, type TableName } from "./explain.ts";
import type { PlannedSql } from "./plan.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DuckDBType } from "@duckdb/node-api";

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
      ? `DuckDB could not open ${file}: another process holds it (${m}). Is another mason start running for this project? mason status says`
      : `DuckDB could not open ${file}: ${m}. mason destroy deletes the copy, and the next mason start copies again`);
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
  private readonly executor: Executor;
  private closed: Promise<void> | null = null;
  private readonly closeGraceMs: number | undefined;
  private constructor(file: string, executor: Executor, memoryLimit: number, closeGraceMs?: number) {
    this.file = file; this.executor = executor; this.memoryLimitBytes = memoryLimit; this.closeGraceMs = closeGraceMs;
    this.writer = executor.writer();
    this.instance = { connect: () => executor.connect() };
  }

  /** `silentMs` and `closeGraceMs`: the executor's bounds (src/duck/executor.ts SILENT_MS, CLOSE_GRACE_MS), shorter only
   *  in a test; `workerFile`, the executor worker's module, another only in a test */
  static async open(file: string, log: (line: string) => void, options: { memoryLimit?: string; silentMs?: number; closeGraceMs?: number; workerFile?: string } = {}): Promise<DuckStore> {
    const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    if (!MEMORY_LIMIT_RE.test(memoryLimit)) throw new Error(`MASON_DUCKDB_MEMORY=${JSON.stringify(memoryLimit)} is not an amount of memory: write it as 8GB or 512MiB (unset, half the machine's RAM: ${DEFAULT_MEMORY_LIMIT})`);
    const where = path.resolve(file);
    const before = opened.get(where);
    if (before !== undefined && before.closed === null) throw new Error(`DuckDB could not open ${file}: this process has it open already (Mason bug: report it)`);
    // a copy whose thread was given up on may still hold the file: a second instance of it would lose writes
    if (before?.abandoned != null) throw new Error(`DuckDB could not open ${file}: this process gave up on the copy's thread before (${before.abandoned}), which may still hold it; start mason again (a new process opens it)`);
    const mine = { closed: null as Promise<void> | null, abandoned: null as string | null };
    opened.set(where, mine);
    let executor: Executor;
    try {
      if (before !== undefined) await before.closed;
      // every connection's, the sync's and each session's
      executor = await Executor.start({ file, settings: { ...INSTANCE_SETTINGS, memory_limit: memoryLimit, temp_directory: `${file}.tmp` }, log,
        ...(options.silentMs !== undefined ? { silentMs: options.silentMs } : {}), ...(options.workerFile !== undefined ? { workerFile: options.workerFile } : {}) });
    } catch (e) { if (opened.get(where) === mine) opened.delete(where); throw e; }
    const store = new DuckStore(file, executor, memoryLimitBytes(memoryLimit), options.closeGraceMs);
    // closed: the file may be opened again — unless its thread was given up on (`abandoned`), which keeps it here
    store.closing = (p) => { mine.closed = p; void p.then(() => { if (executor.abandoned !== null) mine.abandoned = executor.abandoned; else if (opened.get(where) === mine) opened.delete(where); }); };
    return store;
  }
  private closing: (p: Promise<void>) => void = () => undefined;

  /** called once if the copy's thread dies while the run uses it (src/duck/executor.ts): the run exits with the reason */
  onCrash(f: (reason: string) => void): void { this.executor.onCrash(f); }
  /** how many vectors each Mason function was called with so far, on the copy's thread (a test's, a measurement's) */
  functionCalls(): Promise<Map<string, number>> { return this.executor.functionCalls(); }
  /** how many rows each Mason function was handed so far, on the copy's thread (a plan's cost in calls) */
  functionRows(): Promise<Map<string, number>> { return this.executor.functionRows(); }

  /** a connection for one Postgres session (on the executor worker: SessionRunner) */
  runner(): Promise<DuckRunner> { return this.executor.runner(); }

  /**
   * The source's order of text under a libc collation (src/duck/libc-order.ts), kept in the copy: the one recorded
   * for this collation and version, else `read` from the source (a few seconds) and recorded. `read: true` when it was.
   */
  async libcOrder(collate: string, version: string | null, read: () => Promise<LibcOrder>): Promise<{ order: LibcOrder; read: boolean }> {
    await this.writer.run(`CREATE SCHEMA IF NOT EXISTS ${MASON_SCHEMA}`);
    await this.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.libc_order (collation_name VARCHAR, collation_version VARCHAR, data VARCHAR)`);
    const kept = (await this.writer.runAndReadAll(`SELECT data FROM ${MASON_SCHEMA}.libc_order WHERE collation_name = $1 AND collation_version IS NOT DISTINCT FROM $2`, [collate, version])).getRowsJS();
    if (kept.length > 0) return { order: decodeLibcOrder(String(kept[0]![0])), read: false };
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
    const c = collation === undefined ? { kind: "bytes" as const } : duckCollation(collation.provider, collation.collate, collation.locale, known);
    if (c.kind === "libc") {
      if (libc === undefined) throw new Error(`the database orders text by the libc collation ${collation!.collate}, and its order was not read (Mason bug: report it)`);
      await this.executor.registerLibcOrder(libc);
    }
    // a jsonb's stored key is this collation's (src/duck/kept.ts `orderBy`)
    await kept?.orderBy(c, c.kind === "libc" ? libc : undefined);
    return {
      collation: c,
      open: () => this.runner(),
      plan: (catalog, text, stmt, base, paramOids, searchPath, timeZone, userTypes, wireBound, grants) =>
        planDuck(catalog, text, stmt, base, paramOids, searchPath, timeZone, c, verified, userTypes, copies, 0, kept ?? null, wireBound ?? false, grants),
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
  const pg = postgresWording(kind, message);
  if (pg !== null) return new StatementError({ ...pg, detail: `DuckDB: ${message}` }, sql);
  const fn = /(?:Scalar|Aggregate|Table) Function with name "?([A-Za-z_][\w]*)"? does not exist/.exec(message)?.[1];
  if (fn !== undefined) {
    // what reaches DuckDB was verified against Postgres (src/duck/verified.ts), so a function DuckDB lacks is a gap in
    // Mason's rewrite, never something for the client to write in DuckDB's dialect
    return new StatementError({ code: "0A000", message: `function ${fn}() is not supported: Mason answers SQL with DuckDB, which has no ${fn}`,
      hint: "this is a gap in Mason's translation: report it with the statement (docs/SQL-SUPPORT.md lists what is known)", detail: `DuckDB: ${message}` });
  }
  const table = /Table with name "?([^"!\s]+)"? does not exist/.exec(message)?.[1];
  if (table !== undefined) {
    // DuckDB's miss comes after the catalog held the table (the plan passed): one dropped as no longer added, whose way
    // back is `mason add`, so no copy state is read
    return new StatementError({ code: "42P01", message: `relation "${table}" does not exist`,
      hint: missingRelationHint(table, []), detail: `DuckDB: ${message}` });
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
      : code === "53200" ? "out of memory: this statement needs more than the memory Mason's DuckDB may use, in a part that cannot spill to disk" : message,
    // DuckDB's own advice is SET, which a client of Mason cannot do: Mason's way out instead
    ...(code === "53200" ? { hint: "ask for less at once (a filter, a LIMIT, fewer or narrower columns, a coarser GROUP BY), or raise MASON_DUCKDB_MEMORY (8GB, 24GB) and start mason again; nothing else stopped" } : {}),
    // what Mason ran (the statement as rewritten for DuckDB, src/duck/rewrite.ts): a report of the error needs it
    detail: `DuckDB${kind ? ` ${kind} Error` : ""} (Mason answers SQL with DuckDB): ${message}${sql === "" ? "" : `; DuckDB ran: ${oneLine(sql, 2000)}`}`,
    // Postgres accepted the GROUP BY (it analysed the statement first): DuckDB refusing it is Mason's rewrite's gap
    ...(code === "42803" ? { hint: "Postgres accepts this GROUP BY and Mason's rewrite did not carry it to DuckDB: report it with the statement; adding the column to the GROUP BY answers meanwhile" } : {}),
  }, sql);
}

/** The errors DuckDB raises for what Postgres raises too, in Postgres's code and words (a tool or a person matches them). */
function postgresWording(kind: string, message: string): { code: string; message: string } | null {
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
  if (/Casting value "[^"]*" to type DECIMAL\(\d+,\s*\d+\) failed: value is out of range/.test(message)) return { code: "22003", message: "numeric field overflow" };
  // an exact sum past DuckDB's 38 digits (a text read as numeric is summed as a DECIMAL(38,18), src/duck/rewrite.ts summed)
  if (/^Overflow in HUGEINT addition\b/.test(message)) return { code: "0A000", message: `a sum past DuckDB's 38 digits is not supported by Mason (${gapMark("numeric-exact-sum")})` };
  // a numeric(p, s) read from a text holding NaN or Infinity (src/duck/rewrite.ts pgInput): DuckDB's decimal has none
  const special = /Could not convert string ['"](NaN|-?Infinity)['"] to DECIMAL/.exec(message);
  if (special) return { code: "0A000", message: `a numeric ${special[1]} read from a text is not supported by Mason (${gapMark("numeric-special")})` };
  const conv = /Could not convert string '((?:[^']|'')*)' to (INT16|INT32|INT64|DOUBLE|FLOAT|DATE|TIMESTAMP|UUID|BOOL)/.exec(message);
  if (conv) {
    const t = { INT16: "smallint", INT32: "integer", INT64: "bigint", DOUBLE: "double precision", FLOAT: "real", DATE: "date", TIMESTAMP: "timestamp", UUID: "uuid", BOOL: "boolean" }[conv[2] as "INT16"];
    return { code: "22P02", message: `invalid input syntax for type ${t}: "${conv[1]!.replaceAll("''", "'")}"` };
  }
  // a Mason function's own error (src/duck/functions.ts): Postgres's words after the prefix
  // Postgres's own error, from its own function (src/duck/pg-eval.ts): its SQLSTATE, said
  const pg = /^mason\[([0-9A-Z]{5})\]: (.*)$/s.exec(message);
  if (pg) return { code: pg[1]!, message: pg[2]! };
  const own = /^mason: (.*)$/s.exec(message);
  if (own) return { code: /^cannot |argument list|key must not be null/.test(own[1]!) ? "22023" : /^invalid input syntax/.test(own[1]!) ? "22P02" : / is not supported| not supported for type /.test(own[1]!) ? "0A000" : "XX000", message: own[1]! };
  // the rewrite's own error() calls carry Postgres's message (src/duck/rewrite.ts)
  if (kind === "Invalid Input" && /^invalid input syntax for type /.test(message)) return { code: "22P02", message };
  return null;
}

/** how long no call of a session must have been answered before a result of its that did not end is closed: a task
 *  waiting for a call is answered within a turn of the worker's loop (microseconds when it is free), and the work a task
 *  does between two calls is one vector's (2,048 rows) — milliseconds; 50 ms leaves an order of magnitude over both */
const CALLS_QUIET_MS = 50;
/** when the wait for a statement's calls to stop is said in the log */
const CALLS_SLOW_MS = 5_000;

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

  private async settle(session: { timeZone: string; searchPath: string }): Promise<void> {
    if (session.timeZone !== this.zone) { await this.conn.run(`SET TimeZone = ${quoteLiteral(session.timeZone)}`); this.zone = session.timeZone; }
    // Postgres skips a schema of the path that does not exist; DuckDB refuses the SET (and with it every statement):
    // the path is the schemas DuckDB has (a table added later in a new schema is found at the next statement)
    const have = new Set(((await this.conn.runAndReadAll("SELECT schema_name FROM duckdb_schemas() WHERE database_name = current_database()")).getRowsJS() as [string][]).map(([n]) => n));
    const wanted = duckSearchPath(session.searchPath).split(",").filter((n) => have.has(n));
    const path = (wanted.length > 0 ? wanted : ["main"]).join(",");
    if (path !== this.path) { await this.conn.run(`SET search_path = ${quoteLiteral(path)}`); this.path = path; }
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
  async run(sql: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal,
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
  private async streamed(planned: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal,
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
    // server's hung process). One that calls no Mason function is interrupted, and its result closed at once: the
    // close is what cancels the executor's tasks, and a close put off lets the session's next statement take the
    // connection first, after which the close waits for the cancelled query to run to its end (38 s, in
    // tests/duck-wire.test.ts "statement_timeout"). One that does is cancelled through its session — its next call
    // raises — AND interrupted (its tasks stop at their next chunk, so a call-free rest past its last call stops too),
    // and its result is closed only once DuckDB has handed it back (the fetch's own path, or `drain`) and its calls
    // have stopped (`cleanUp`: a task still inside a call waits for this thread, which a close would hold). Whether it calls
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
    let closed = false, fetching = false, released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (this.openAnswer === close) this.openAnswer = null;
      signal.removeEventListener("abort", cancel);
      result?.closeSync();
      p.destroySync();
      this.log(`statement: ${total} row(s) in ${Date.now() - started} ms — ${oneLine(sql)}`);
    };
    // A CALLING STATEMENT THAT DID NOT RUN TO ITS END (it failed, its cancel raised, it was closed early) IS CLOSED
    // ONLY ONCE ITS CALLS HAVE STOPPED (the suite hung for good, 0 % CPU). DuckDB hands back a failed chunk
    // while another of the query's tasks may still wait INSIDE a call — for this thread, which runs every Mason
    // function — and closing the result waits for that task (Executor::CancelTasks): this thread waited for the task,
    // the task for this thread, and every later request to the copy with them (`cleanUp`). One that calls no function,
    // or one read to its end, has no task left to wait for and is released at once
    const releaseAfterCleanup = (): void => {
      if (!callsFunctions || released) { release(); return; }
      const done = (async () => { await this.cleanUp(seq, sql); release(); })();
      this.releasing.add(done);
      void done.finally(() => this.releasing.delete(done));
    };
    // a result closed before its end while no fetch is in flight: a statement calling no function is released at
    // once (the close cancels the executor); one that does is read on until DuckDB hands it back refused (its next
    // call raises) or read to its end, then released — the session's next statement waits for that (`releasing`)
    const drain = (): void => {
      const r = result;
      // CLOSED WHILE DuckDB STILL STARTS IT (its `stream()` pending: an aggregate computes there whole): nothing is
      // released under the pending start — that destroyed the prepared statement under it and, its release done, let the
      // start's own failure skip `cleanUp`, so the connection and the instance closed while its other tasks still had
      // calls queued for this thread, and the thread's end met them (Linux CI: `FATAL ERROR: Error::Error
      // napi_define_properties`, 7 runs in 30 of a stop under a calling count). The start's own path releases it: its
      // failure through `releaseAfterCleanup`, its answer drained once handed back (below `stream()`)
      if (r === null) return;
      if (!callsFunctions) { release(); return; }
      const done = (async () => {
        // read on until the next call raises or the result ends — an EMPTY chunk, as `fetch` reads it: past its end a
        // streamed result hands back empty chunks for ever, never null, and a result closed after its last row but
        // before its end was read here without end, a thread spinning and the session's close waiting on it
        try { for (let c = await r.fetchChunk(); c !== null && c.rowCount > 0; c = await r.fetchChunk()) { /* its rows are nobody's */ } }
        catch (e) {
          // the cancel's own refusal (its next call raised, 57014) is what the drain waits for. Anything else is the
          // statement's real error, met after the listener let go of its answer: no one reads it any more, and a
          // rethrow here would reach no caller (it would end this thread, and with it every session), so it is said
          if (pgErrorOf(e, sql).fields.code !== "57014") this.log(`a statement closed before its end failed while it was drained: ${e instanceof Error ? e.message : String(e)} — ${oneLine(sql)}`);
          // it failed, so a task of it may still be inside a call: closed once its calls have stopped
          await this.cleanUp(seq, sql);
        }
        release();
      })();
      this.releasing.add(done);
      void done.finally(() => this.releasing.delete(done));
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
      // CLOSED WHILE IT STARTED (`drain` above), now that DuckDB handed it back. The two differ: one that calls no
      // function is released at once (its close cancels the executor) and so is never read after — told the cancel
      // here, before a column of a destroyed result is asked (DuckDB answers 0 columns for one: a review finding, an
      // XX000 "report it" where the session had closed); one that calls is drained, which holds the result open until
      // its calls stop, so its answer below is built from a live result and its fetch tells the cancel
      if (closed) {
        if (!callsFunctions) { release(); throw cancelled(); }
        drain();
      }
      timing.duckdbMs += performance.now() - t1;
      const r = result;
      if (fields !== null && r.columnCount < fields.length) throw new StatementError({ code: "XX000", message: `DuckDB answered ${r.columnCount} column(s) where Postgres's analysis has ${fields.length}: report it (Mason's rewrite)` }, sql);
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
            catch (e) { throw failure(e); }
            finally { fetching = false; }
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
  explain(sql: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal,
    how: ExplainHow): Promise<string[]> {
    return this.track(this.explained(sql, params, session, signal, how));
  }

  private async explained(sql: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal,
    how: ExplainHow): Promise<string[]> {
    await Promise.all([...this.releasing]);
    const o = how.options;
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
        } finally { await this.conn.run("PRAGMA disable_profiling"); }
        // THE PROFILE IS HELD TO THE STATEMENT, never assumed its: DuckDB writes one when the result is read to its end,
        // naming the statement it timed. None: DuckDB ran no operator (it answered while planning — a count(*) of a
        // whole table is the table's row count), and its plan is its EXPLAIN, the rows the ones it answered
        const profile = fs.existsSync(file) ? profiled(JSON.parse(fs.readFileSync(file, "utf8"))) : null;
        if (profile !== null && profile.sql !== sql.text) {
          throw new StatementError({ code: "XX000", message: `DuckDB's profile of an EXPLAIN ANALYZE is of another statement (${oneLine(profile.sql ?? "none named")}): report it (Mason's EXPLAIN)` }, sql.text);
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
    const explained: Explained = { copies: await this.copies(scannedTables(plan), how.copies), sql: oneLine(sql.text), computed: computedOf(how.exact, how.fields),
      functions: [...sql.functions], plan, ...(analyzed === undefined ? {} : { analyzed }) };
    return o.format === "json" ? [explainJson(explained, o)] : explainText(explained, o);
  }

  /** DuckDB's `EXPLAIN (FORMAT JSON)` of the planned SQL, its parameters bound: its plan, estimates only */
  private async plainPlan(sql: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal): Promise<PlanNode[]> {
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
  private async copies(tables: readonly TableName[], facts: readonly CopyFacts[]): Promise<Copy[]> {
    const out: Copy[] = [];
    for (const { schema, name } of tables) {
      const rows = (await this.conn.runAndReadAll("SELECT estimated_size FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2", [schema, name])).getRowsJS()[0]?.[0];
      // the sync's source is the two names as they are; EXPLAIN says the table as a statement writes it (qualifiedName)
      out.push({ table: qualifiedName({ schema, name }), rows: rows === undefined || rows === null ? null : Number(rows), facts: facts.find((f) => f.source === `${schema}.${name}`) ?? null });
    }
    return out;
  }

  /**
   * A CALLING STATEMENT THAT DID NOT RUN TO ITS END, WAITED FOR UNTIL ITS CALLS HAVE STOPPED, before its result is
   * closed (`releaseAfterCleanup` in `streamed` says why). Every close is synchronous on this thread (DuckDB's node API
   * has no other, and refuses a second query on a connection with a result open), so the close must find no task of the
   * query inside, or waiting for, a call. The statement is marked cancelled (each call it still makes raises at once)
   * and interrupted (its tasks stop at their next chunk), and this thread stays free — a task waiting for a call is
   * answered within a turn of its loop — until no call of this session has been answered for `CALLS_QUIET_MS`. Never a
   * deadline: a close while calls still come is the deadlock itself, and the calls end (each raises); a wait past
   * `CALLS_SLOW_MS` is said once.
   */
  private async cleanUp(seq: number, sql: string): Promise<void> {
    cancelStatement(this.cancels, this.slot, seq);
    this.conn.interrupt();
    const t0 = performance.now();
    let said = false;
    // ONE WHOLE WINDOW BEFORE THE FIRST LOOK: a call a task has queued for this thread but that has not run yet leaves
    // `msSinceCall` at the previous call's time — long ago, when this thread was busy with another connection's close
    // (an interrupt honoured, ~10 s for one join) — so a check made synchronously here could pass with that call still
    // waiting, and the close deadlock on it the same way. A sleep of the window lets every queued call run first.
    for (;;) {
      await sleep(CALLS_QUIET_MS);
      if (msSinceCall(this.slot) >= CALLS_QUIET_MS) break;
      if (!said && performance.now() - t0 > CALLS_SLOW_MS) { said = true; this.log(`a statement that did not run to its end still calls Mason's functions after ${CALLS_SLOW_MS / 1000} s; its result is closed once they stop — ${oneLine(sql)}`); }
    }
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
    if (unreadable) columns[e.column] = { ...columns[e.column]!, divergence: `Postgres computes this numeric exactly; a part of it DuckDB computed as a double` };
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
        if (err instanceof NumericError) throw new StatementError({ code: err.sqlstate, message: err.message }, sql);
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
    return `column ${e.column + 1}${fields?.[e.column] === undefined ? "" : ` "${fields[e.column]!.name}"`}: Postgres's exact numeric${e.text ? " as text" : ""}, from ${cells} of DuckDB's value(s)`;
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
