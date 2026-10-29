/**
 * THE EXECUTOR WORKER (the test server: a JSON read through a Mason function over 22 M rows took 98 s, and
 * for those 98 s the whole process was silent — the other sessions, the stream, the copy, the commands, even the
 * cancel of a client that had left). Every `__mason_*` function is JavaScript, and DuckDB's executor threads call it
 * on the thread whose Node environment REGISTERED it, one vector (2,048 rows) a call; with several executor threads
 * calling, that thread's event loop runs a thousand calls between two turns of anything else. So DuckDB lives on a
 * thread of its own, this module's worker (src/duck/executor-worker.ts): the instance, every connection, the
 * functions; and this process's main thread — the wire listener, the catalog, the commands, the sync's own logic —
 * never runs a function call.
 *
 * WHY EVERYTHING DuckDB MOVES, the writers' connections included: a DuckDB instance is a Node object of the thread that
 * made it, never handed to another, and `DuckDBInstanceCache` is a cache per JavaScript object (each thread's singleton
 * makes its own), so a worker cannot reach the main thread's instance. A SECOND instance of the same file is not
 * refused inside one process (DuckDB's file lock is per process) and loses writes silently: measured, an
 * instance's committed and checkpointed rows were gone once the other checkpointed (docs/DESIGN.md "The executor
 * worker"). One instance per file, on the worker; the sync, the stream, the request log and the tests reach it through
 * `DuckConnection`, a connection's methods posted to the worker (`RemoteConnection`), and the listener's sessions
 * through `RemoteRunner`.
 *
 * WHAT CROSSES: a statement's text and parameters (structured clone), a materialized result's rows as DuckDB's JS and
 * Json forms, a column's DuckDB type as its JSON (`typeFromJson`), a streamed result's rows ENCODED on the worker (the
 * wire's DataRows, src/duck/store.ts encodeRows) and moved as one transferred buffer a chunk, an error as its SQLSTATE
 * and words (a StatementError's fields) or DuckDB's message. A cancel does NOT cross as a message: the worker may be
 * busy for seconds with a statement's calls, so the listener writes the CANCEL TABLE (src/duck/cancel.ts) the calls
 * read, in memory both threads share; the message that follows only does what the calls cannot (an interrupt of a
 * statement that calls none).
 *
 * A WORKER THAT DIES (V8 out of heap on that thread, an uncaught error) fails every request in flight and every later
 * one: a session's statement is told 57P02 with the reason and to reconnect, and the run is told (`onCrash`) — it exits
 * with the reason, and its supervisor starts it again (src/cli/dev.ts, src/cli/supervise.ts); DuckDB recovers the copy
 * from its write-ahead log. A native abort ends the whole process, as it always did. The worker is not restarted in
 * place: every connection the sync holds would be gone under it.
 */
import { Worker, type TransferListItem } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import * as duck from "@duckdb/node-api";
import type { DuckDBType, DuckDBValue, JS, Json } from "@duckdb/node-api";
import { runnable } from "../lib/runnable.ts";
import { StatementError, type DuckAnswer, type DuckRunner, type ExplainHow } from "../api/postgres/server.ts";
import { EncodeError } from "../api/postgres/encode.ts";
import { NumericError } from "../lib/pg-numeric.ts";
import type { PlannedSql } from "./plan.ts";
import type { ExactColumn } from "./rewrite.ts";
import type { LibcOrder } from "./libc-order.ts";
import { CANCEL_SLOTS, cancelStatement, cancelTable, resetSlot } from "./cancel.ts";
// a cycle (store.ts opens the executor): read at run time only
import { failureOf } from "./store.ts";

// ------------------------------------------------------------------------------------------------- the connection's API

/** A materialized result, in the forms Mason reads (DuckDB's `DuckDBMaterializedResult`'s), DuckDB's own values
 *  included (`getRows`: each value object given its class back by its column's type, `valueFromClone`). */
export interface DuckRows {
  getRowsJS(): JS[][];
  getRowsJson(): Json[][];
  getRowObjectsJson(): Record<string, Json>[];
  getRows(): DuckDBValue[][];
  columnType(i: number): DuckDBType;
  readonly columnNames: readonly string[];
}
/** A prepared statement's columns (what the catalog reads of a copied table: `Sync.schemaBuilt`). */
export interface DuckPrepared {
  readonly columnCount: number;
  columnName(i: number): string;
  columnType(i: number): DuckDBType;
  destroySync(): void;
}
/** What Mason uses of a DuckDB connection, the same calls as `DuckDBConnection`'s, answered by the executor worker. */
export interface DuckConnection {
  run(sql: string, values?: readonly unknown[]): Promise<{ rowsChanged: number }>;
  runAndReadAll(sql: string, values?: readonly unknown[]): Promise<DuckRows>;
  prepare(sql: string): Promise<DuckPrepared>;
  /** ends what runs on the connection (posted: it lands once the worker reads it) */
  interrupt(): void;
  /** closes it (posted; a failure is logged) */
  closeSync(): void;
}

/** A DuckDB type from its `toJson()` (the worker's), as `@duckdb/node-api`'s own classes. */
export function typeFromJson(j: Json): DuckDBType {
  const o = j as Record<string, Json>;
  const id = Number(o.typeId);
  const alias = typeof o.alias === "string" ? o.alias : undefined;
  const T = duck.DuckDBTypeId;
  switch (id) {
    case T.DECIMAL: return new duck.DuckDBDecimalType(Number(o.width), Number(o.scale), alias);
    case T.ENUM: return new duck.DuckDBEnumType((o.values as string[]), Number(o.internalTypeId) as never, alias);
    case T.LIST: return new duck.DuckDBListType(typeFromJson(o.valueType!), alias);
    case T.ARRAY: return new duck.DuckDBArrayType(typeFromJson(o.valueType!), Number(o.length), alias);
    case T.MAP: return new duck.DuckDBMapType(typeFromJson(o.keyType!), typeFromJson(o.valueType!), alias);
    case T.STRUCT: return new duck.DuckDBStructType(o.entryNames as string[], (o.entryTypes as Json[]).map(typeFromJson), alias);
    case T.UNION: return new duck.DuckDBUnionType(o.memberTags as string[], (o.memberTypes as Json[]).map(typeFromJson), alias);
    case T.GEOMETRY: return duck.DuckDBGeometryType.create(alias, typeof o.crs === "string" ? o.crs : undefined);
  }
  const simple = SIMPLE_TYPES.get(id);
  if (simple === undefined) throw new Error(`a DuckDB type Mason cannot carry between threads: ${JSON.stringify(j)} (Mason bug: report it)`);
  return simple(alias);
}
/** every type of no parameters, by its id: each class's `create(alias)` */
const SIMPLE_TYPES = new Map<number, (alias?: string) => DuckDBType>(Object.values(duck).flatMap((v) => {
  const c = v as { instance?: { typeId?: unknown }; create?: (alias?: string) => DuckDBType };
  return typeof v === "function" && typeof c.instance?.typeId === "number" && typeof c.create === "function"
    ? [[c.instance.typeId, (alias?: string) => c.create!(alias)] as const] : [];
}));

/** the class of a DuckDB value of each type id that has one (the rest are plain: a string, a number, a bigint …) */
const VALUE_CLASS = new Map<number, object>([
  [duck.DuckDBTypeId.DATE, duck.DuckDBDateValue.prototype], [duck.DuckDBTypeId.TIME, duck.DuckDBTimeValue.prototype],
  [duck.DuckDBTypeId.TIME_NS, duck.DuckDBTimeNSValue.prototype], [duck.DuckDBTypeId.TIME_TZ, duck.DuckDBTimeTZValue.prototype],
  [duck.DuckDBTypeId.TIMESTAMP, duck.DuckDBTimestampValue.prototype], [duck.DuckDBTypeId.TIMESTAMP_S, duck.DuckDBTimestampSecondsValue.prototype],
  [duck.DuckDBTypeId.TIMESTAMP_MS, duck.DuckDBTimestampMillisecondsValue.prototype], [duck.DuckDBTypeId.TIMESTAMP_NS, duck.DuckDBTimestampNanosecondsValue.prototype],
  [duck.DuckDBTypeId.TIMESTAMP_TZ, duck.DuckDBTimestampTZValue.prototype], [duck.DuckDBTypeId.TIMESTAMP_TZ_NS, duck.DuckDBTimestampTZNanosecondsValue.prototype],
  [duck.DuckDBTypeId.INTERVAL, duck.DuckDBIntervalValue.prototype], [duck.DuckDBTypeId.DECIMAL, duck.DuckDBDecimalValue.prototype],
  [duck.DuckDBTypeId.BLOB, duck.DuckDBBlobValue.prototype], [duck.DuckDBTypeId.UUID, duck.DuckDBUUIDValue.prototype],
  [duck.DuckDBTypeId.BIT, duck.DuckDBBitValue.prototype], [duck.DuckDBTypeId.GEOMETRY, duck.DuckDBGeometryValue.prototype],
  [duck.DuckDBTypeId.LIST, duck.DuckDBListValue.prototype], [duck.DuckDBTypeId.ARRAY, duck.DuckDBArrayValue.prototype],
  [duck.DuckDBTypeId.STRUCT, duck.DuckDBStructValue.prototype], [duck.DuckDBTypeId.MAP, duck.DuckDBMapValue.prototype],
  [duck.DuckDBTypeId.UNION, duck.DuckDBUnionValue.prototype],
]);

/** A DuckDB value as structured clone carried it (its fields, every one public, without its class), given its class
 *  back — and its parts theirs — by its type. */
export function valueFromClone(v: DuckDBValue, t: DuckDBType): DuckDBValue {
  if (v === null || typeof v !== "object") return v;
  if (t.typeId === duck.DuckDBTypeId.VARIANT) throw new Error("a VARIANT value cannot be carried between threads (Mason bug: report it)");
  const proto = VALUE_CLASS.get(t.typeId);
  if (proto === undefined) return v;
  const o = v as unknown as Record<string, unknown>;
  if (t instanceof duck.DuckDBListType || t instanceof duck.DuckDBArrayType) o.items = (o.items as DuckDBValue[]).map((x) => valueFromClone(x, t.valueType));
  else if (t instanceof duck.DuckDBStructType) {
    const entries = o.entries as Record<string, DuckDBValue>;
    t.entryNames.forEach((n, i) => { if (n in entries) entries[n] = valueFromClone(entries[n]!, t.entryTypes[i]!); });
  } else if (t instanceof duck.DuckDBMapType) {
    o.entries = (o.entries as Array<{ key: DuckDBValue; value: DuckDBValue }>).map((e) => ({ key: valueFromClone(e.key, t.keyType), value: valueFromClone(e.value, t.valueType) }));
  } else if (t instanceof duck.DuckDBUnionType) {
    const at = t.memberTags.indexOf(String(o.tag));
    if (at >= 0) o.value = valueFromClone(o.value as DuckDBValue, t.memberTypes[at]!);
  }
  return Object.setPrototypeOf(o, proto) as DuckDBValue;
}

// ------------------------------------------------------------------------------------------------- the messages

/** what the worker answers a failure with: the error's own class where the listener tells it apart (a StatementError's
 *  fields, an EncodeError's or a NumericError's code: src/api/postgres/server.ts pgErrorOf), else its message */
export type WireError = { kind: "statement"; fields: StatementError["fields"]; sql: string } | { kind: "encode"; message: string; code: string }
  | { kind: "numeric"; message: string; sqlstate: string } | { kind: "error"; message: string; name: string };

export function wireError(e: unknown): WireError {
  if (e instanceof StatementError) return { kind: "statement", fields: e.fields, sql: e.sql };
  if (e instanceof EncodeError) return { kind: "encode", message: e.message, code: e.code };
  if (e instanceof NumericError) return { kind: "numeric", message: e.message, sqlstate: e.sqlstate };
  return { kind: "error", message: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : "Error" };
}
export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: WireError } | { log: string } | { pong: true };

/** the worker is gone: what every request in flight, and every later one, is answered. `stopped`: by the run's own stop
 *  (`close`), not a crash */
export class ExecutorGone extends Error {
  readonly stopped: boolean;
  constructor(reason: string, stopped = false) { super(reason); this.stopped = stopped; }
}

/** What a session's statement is told when the run stops under it (mason stop, a shutdown): Postgres's own words for a
 *  server shutting down (57P01), from the worker's stop (executor-worker.ts `shutdown`) or the closed executor alike */
export const STOPPING: StatementError["fields"] = { code: "57P01", message: "terminating connection due to administrator command",
  detail: "Mason is stopping (mason stop, or a shutdown)", hint: "connect again once Mason runs again (mason status says whether it does)" };

const errorOf = (e: WireError): Error => {
  if (e.kind === "statement") return new StatementError(e.fields, e.sql);
  if (e.kind === "encode") return new EncodeError(e.message, e.code);
  if (e.kind === "numeric") return new NumericError(e.message, e.sqlstate);
  const err = new Error(e.message);
  err.name = e.name;
  return err;
};

/** a value a statement may be given across threads: plain, never a DuckDB value object (its class would be lost) */
function plainValues(values: readonly unknown[] | undefined): unknown[] | undefined {
  if (values === undefined) return undefined;
  for (const v of values) {
    if (v === null || typeof v !== "object" || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof Date) continue;
    if (Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`a ${(v as object).constructor.name} cannot be sent to DuckDB's thread: pass its text or a plain value (Mason bug: report it)`);
  }
  return [...values];
}

// ------------------------------------------------------------------------------------------------- the executor

export interface ExecutorOptions {
  file: string; settings: Record<string, string>; log: (line: string) => void;
  /** the bound on a silent worker (SILENT_MS), shorter only in a test */
  silentMs?: number;
  /** the worker's module, executor-worker.ts unless a test puts another in its place */
  workerFile?: string;
}

/**
 * EVERY CALL TO THE WORKER SETTLES (under load the worker deadlocked inside DuckDB, src/duck/store.ts
 * `cleanUp`, and every request to it — the session's statements, the store's close, the test's after-hook — waited for
 * ever, 0 % CPU). Two bounds:
 * - THE WORKER MUST BE HEARD: while a request is pending the executor pings it every `PING_MS`, and a worker that has
 *   said nothing (no answer, no log line, no pong) for `SILENT_MS` is declared stopped — every request in flight and
 *   later is told 57P02, and the run is told (`onCrash`), as for a crash. Not shorter: a statement calling a Mason
 *   function holds the worker's turn for up to a thousand calls at a time (seconds on a loaded machine), and closing a
 *   call-free result waits for DuckDB to honour an interrupt (~10 s for one join, docs/DESIGN.md "The executor
 *   worker"); a deadlock is for ever, so a longer bound only says it later.
 * - THE CLOSE IS BOUNDED: `close` gives the worker's shutdown `CLOSE_GRACE_MS` (a calling statement stops at its next
 *   call, milliseconds; a call-free one at DuckDB's interrupt; and the whole stop must fit inside a platform's 10 s
 *   before SIGKILL and `mason stop`'s 15 s), then declares it stopped the same way and resolves; the thread is ended
 *   once its shutdown answers (below).
 * What neither can do: end a thread blocked inside native code. Such a process does not exit by itself, nor on
 * process.exit (measured); its supervisor's SIGKILL does. The copy is not opened again in this process
 * (`abandoned`): a second instance of the file would lose writes.
 *
 * NOTHING ENDS THE WORKER'S JAVASCRIPT UNDER A PENDING CALL OF DuckDB'S (a test file under load aborted at its exit,
 * `libc++abi: terminating due to uncaught exception of type Napi::Error`: its close outlasted the grace, and the
 * executor TERMINATED the worker while DuckDB's threads were inside a Mason function call — the node API's callback met
 * a dying environment and threw where nothing catches. Reproduced every time by a close with a 1 ms grace under a
 * calling statement, tests/duck-executor.test.ts). So a worker given up on (the grace, the silence) is told nothing
 * more and asked to SHUT DOWN (`shutDown`: posted once, its answer awaited outside `pending`), and is ended only once
 * that shutdown has answered — DuckDB's statements stopped, its connections and instance closed — or it exits by
 * itself; until then it stays REFERENCED, so the process cannot end with the worker mid-call either (a process
 * exiting tears its workers down the same way). A drained answer is a request for the same reason (`answer.close`):
 * DuckDB may call into the worker after the listener let go of the statement. A thread that never answers its
 * shutdown is the deadlock above: its supervisor's SIGKILL.
 */
export const PING_MS = 5_000;
export const SILENT_MS = 60_000;
export const CLOSE_GRACE_MS = 5_000;

export class Executor {
  private readonly worker: Worker;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  /** why the worker is gone, once it is */
  private gone: string | null = null;
  private closing = false;
  private readonly exited: Promise<void>;
  private readonly crashed: Array<(reason: string) => void> = [];
  /** the cancel table, shared with the worker (src/duck/cancel.ts), and its free slots */
  readonly cancels = cancelTable();
  private readonly free: number[] = Array.from({ length: CANCEL_SLOTS }, (_, i) => CANCEL_SLOTS - 1 - i);
  /** when the worker last said anything (performance.now()) */
  private heard = performance.now();
  private readonly watch: NodeJS.Timeout;
  private readonly silentMs: number;
  /** why the worker was given up on without exiting (`close`'s bound, the silence), once it was: its instance may
   *  still hold the file, which this process must never open again */
  abandoned: string | null = null;
  /** the shutdown, once posted (`shutDown`): settled when the worker answered it, or exited */
  private shutdown: Promise<void> | null = null;
  private shutdownId = 0;
  private shutdownAnswered: () => void = () => undefined;
  private hasExited = false;

  private constructor(o: ExecutorOptions) {
    this.silentMs = o.silentMs ?? SILENT_MS;
    this.log = o.log;
    this.worker = new Worker(runnable(o.workerFile ?? fileURLToPath(new URL("./executor-worker.ts", import.meta.url))), { workerData: { cancels: this.cancels } });
    // the process may end while nothing is asked of it (a script, a test that forgot to close): referenced only while
    // a request is in flight (`call`)
    this.worker.unref();
    this.worker.on("message", (m: Reply) => {
      this.heard = performance.now();
      if ("pong" in m) return;
      if ("log" in m) { this.log(m.log); return; }
      if (m.id === this.shutdownId) {
        if (!m.ok) this.log(`closing the copy failed: ${errorOf(m.error).message}`);
        this.shutdownAnswered();
        return;
      }
      const p = this.pending.get(m.id);
      if (p === undefined) return;
      this.settle(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(errorOf(m.error));
    });
    let why: string | null = null;
    this.worker.on("error", (e) => {
      why = (e as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" ? `its thread ran out of JavaScript heap (${e.message})` : `it failed: ${e.message}`;
    });
    this.exited = new Promise<void>((resolve) => this.worker.once("exit", (code) => {
      this.hasExited = true;
      this.die(this.closing && why === null ? "it was closed" : why ?? `it exited with code ${code}`);
      this.shutdownAnswered();
      resolve();
    }));
    // the watch (see SILENT_MS): only while a request is pending — an idle worker has nothing to answer
    this.watch = setInterval(() => {
      if (this.gone !== null || this.pending.size === 0) { this.heard = performance.now(); return; }
      if (performance.now() - this.heard > this.silentMs) {
        this.abandon(`it answered nothing for ${Math.round(this.silentMs / 1000)} s with ${this.pending.size} request(s) waiting (stuck inside DuckDB: Mason bug, report it with mason logs)`);
        return;
      }
      this.worker.postMessage({ op: "ping" });
    }, Math.min(PING_MS, this.silentMs / 4));
    this.watch.unref();
  }

  /** the worker given up on without its exit: every request told so (57P02), the run told, and its shutdown asked —
   *  NEVER a terminate, which under a pending call of DuckDB's aborts the process (NOTHING ENDS THE WORKER'S
   *  JAVASCRIPT above): it is ended once its shutdown answers, and holds the process until then */
  private abandon(reason: string): void {
    if (this.gone !== null) return;
    this.abandoned = reason;
    this.die(reason, false);
    void this.shutDown();
  }

  /** Asks the worker to stop (executor-worker.ts `shutdown`: every statement stopped, every connection and the instance
   *  closed once nothing runs on them), once; settles when it answered, or exited. Only then is it terminated: nothing
   *  of DuckDB's calls into it any more. The worker stays referenced meanwhile, so the process waits for it. */
  private shutDown(): Promise<void> {
    if (this.shutdown !== null) return this.shutdown;
    this.shutdown = new Promise<void>((resolve) => { this.shutdownAnswered = resolve; });
    if (this.hasExited) this.shutdownAnswered();
    else {
      this.shutdownId = this.nextId++;
      this.worker.ref();
      this.worker.postMessage({ op: "shutdown", id: this.shutdownId });
    }
    void this.shutdown.then(async () => { if (!this.hasExited) await this.worker.terminate(); })
      .catch((e: unknown) => this.log(`ending the copy's thread failed: ${(e as Error).message}`));
    return this.shutdown;
  }

  static async start(o: ExecutorOptions): Promise<Executor> {
    const e = new Executor(o);
    try { await e.call({ op: "open", file: o.file, settings: o.settings }); }
    catch (err) { await e.close(); throw err; }
    return e;
  }

  /** called once if the worker dies while the run uses it (never after `close`) */
  onCrash(f: (reason: string) => void): void { this.crashed.push(f); }

  private die(reason: string, stopped = this.closing): void {
    if (this.gone !== null) return;
    this.gone = reason;
    clearInterval(this.watch);
    const err = new ExecutorGone(reason, stopped);
    for (const [id, p] of [...this.pending]) { this.settle(id); p.reject(err); }
    if (!stopped) { this.log(`the copy's engine stopped: ${reason}`); if (!this.closing) for (const f of this.crashed) f(reason); }
  }

  private settle(id: number): void {
    this.pending.delete(id);
    // a shutdown in flight holds the process until the worker ends (`shutDown`)
    if (this.pending.size === 0 && this.shutdown === null) this.worker.unref();
  }

  /** a request, answered by the worker */
  call<T>(m: Record<string, unknown>, transfer: TransferListItem[] = []): Promise<T> {
    if (this.gone !== null) return Promise.reject(new ExecutorGone(this.gone, this.closing));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.pending.size === 0) this.worker.ref();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...m, id }, transfer);
    });
  }

  /** a message needing no answer (an interrupt, a connection's close); nothing once the worker is gone */
  post(m: Record<string, unknown>): void {
    if (this.gone === null) this.worker.postMessage(m);
  }

  /** a request whose answer nobody awaits (an answer's close: the worker answers once DuckDB handed it back), kept in
   *  `pending` so the process does not end while the worker still drains it; a failure is logged, a stop is not one */
  background(m: Record<string, unknown>): void {
    this.call(m).catch((e: unknown) => { if (!(e instanceof ExecutorGone)) this.log(`${String(m.op)} failed: ${(e as Error).message}`); });
  }

  /** a connection of the instance */
  async connect(): Promise<DuckConnection> { return new RemoteConnection(this, await this.call<number>({ op: "connect" })); }
  writer(): DuckConnection { return new RemoteConnection(this, 0); }

  /** the libc order's two functions (src/duck/functions.ts registerLibcOrder), registered on the worker */
  async registerLibcOrder(order: LibcOrder): Promise<void> { await this.call({ op: "libc", order }); }
  /** how many vectors each Mason function was called with so far (src/duck/functions.ts FUNCTION_CALLS: the worker's
   *  count, the functions being its) — what a test or a measurement reads to know whether a statement reached one */
  async functionCalls(): Promise<Map<string, number>> { return new Map(Object.entries(await this.call<Record<string, number>>({ op: "calls" }))); }
  /** how many rows each Mason function was handed so far, across its calls (src/duck/functions.ts FUNCTION_ROWS) */
  async functionRows(): Promise<Map<string, number>> { return new Map(Object.entries(await this.call<Record<string, number>>({ op: "function rows" }))); }

  /** a wire session's connection: a slot of the cancel table, its connection on the worker */
  async runner(): Promise<DuckRunner> {
    const slot = this.free.pop();
    if (slot === undefined) throw new StatementError({ code: "53300", message: `too many sessions are reading the copy at once (${CANCEL_SLOTS})`, hint: "close idle connections (a pool's size), then connect again" });
    resetSlot(this.cancels, slot);
    try { return new RemoteRunner(this, await this.call<number>({ op: "runner.open", slot }), slot); }
    catch (e) { this.free.push(slot); throw e instanceof ExecutorGone ? goneError(e, "") : e; }
  }
  release(slot: number): void { this.free.push(slot); }

  /** Closes every connection and the instance on the worker, then the worker; resolves once it has exited, or once
   *  `graceMs` has passed (CLOSE_GRACE_MS says why), whatever the worker does. Never rejects: a failure is said in the
   *  log. */
  close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.closed ??= this.closeWithin(graceMs);
    return this.closed;
  }
  private closed: Promise<void> | null = null;
  private async closeWithin(graceMs: number): Promise<void> {
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), graceMs); });
    // the shutdown, then the terminate once it answered (`shutDown`), then the exit — or the worker's own exit
    const closed = (async () => { await this.shutDown(); await this.exited; return "closed" as const; })();
    try {
      if (await Promise.race([closed, late]) === "late") {
        this.log(`the copy's thread did not close within ${graceMs / 1000} s: given up on (its sessions are told 57P02); it ends once its shutdown finishes, and the process waits for it (a thread stuck inside DuckDB needs a SIGKILL)`);
        this.abandon(`it did not close within ${graceMs / 1000} s`);
      }
    } finally { clearTimeout(timer); }
  }
}

// ------------------------------------------------------------------------------------------------- a connection

class RemoteConnection implements DuckConnection {
  private readonly ex: Executor;
  private readonly conn: number;
  constructor(ex: Executor, conn: number) { this.ex = ex; this.conn = conn; }

  async run(sql: string, values?: readonly unknown[]): Promise<{ rowsChanged: number }> {
    return this.ex.call({ op: "conn.run", conn: this.conn, sql, values: plainValues(values) });
  }

  async runAndReadAll(sql: string, values?: readonly unknown[]): Promise<DuckRows> {
    const r = await this.ex.call<{ js: JS[][]; json: Json[][]; rows: DuckDBValue[][]; names: string[]; types: Json[] }>({ op: "conn.read", conn: this.conn, sql, values: plainValues(values) });
    const types = r.types.map(typeFromJson);
    let rows: DuckDBValue[][] | null = null;
    return {
      columnType: (i) => types[i]!,
      columnNames: r.names,
      getRowsJS: () => r.js,
      getRowsJson: () => r.json,
      getRows: () => (rows ??= r.rows.map((row) => row.map((v, i) => valueFromClone(v, types[i]!)))),
      getRowObjectsJson: () => r.json.map((row) => Object.fromEntries(r.names.map((n, i) => [n, row[i]!]))),
    };
  }

  async prepare(sql: string): Promise<DuckPrepared> {
    const r = await this.ex.call<{ names: string[]; types: Json[] }>({ op: "conn.prepare", conn: this.conn, sql });
    const types = r.types.map(typeFromJson);
    return { columnCount: r.names.length, columnName: (i) => r.names[i]!, columnType: (i) => types[i]!, destroySync: () => undefined };
  }

  interrupt(): void { this.ex.post({ op: "conn.interrupt", conn: this.conn }); }

  closeSync(): void { this.ex.post({ op: "conn.close", conn: this.conn }); }
}

// ------------------------------------------------------------------------------------------------- a wire session

type Session = { timeZone: string; searchPath: string };
type Fields = ReadonlyArray<{ name: string; oid: number; typmod?: number }> | null;

/** the reason an abort carries across: the statement timeout's fields, else none (the client's cancel) */
const reasonOf = (signal: AbortSignal): { fields?: StatementError["fields"] } | null =>
  !signal.aborted ? null : signal.reason instanceof StatementError ? { fields: signal.reason.fields } : {};

/** what a session is told when the worker is gone mid-statement */
function goneError(e: ExecutorGone, sql: string): StatementError {
  if (e.stopped) return new StatementError(STOPPING, sql);
  return new StatementError({ code: "57P02", message: "terminating connection because the copy's engine stopped", detail: e.message,
    hint: "Mason starts again by itself: reconnect in a few seconds and repeat the statement (mason status says when it is back)" }, sql);
}

/**
 * A wire session's connection on the worker (src/duck/store.ts SessionRunner runs there). Each statement has a number;
 * its cancel is written to the cancel table AT ONCE when it calls a Mason function, then posted for the rest. Its
 * failure is read against THIS thread's signal (`failureOf`), so a timeout is said as the timeout whichever reached the
 * worker first, the abort or the cancelled call's error.
 */
class RemoteRunner implements DuckRunner {
  private readonly ex: Executor;
  private readonly id: number;
  private readonly slot: number;
  private seq = 0;
  private closed = false;
  constructor(ex: Executor, id: number, slot: number) { this.ex = ex; this.id = id; this.slot = slot; }

  /** a statement's abort, from the moment it is asked until `end`: written to the cancel table at once when the plan
   *  says it calls a Mason function (`PlannedSql.functions`, never read off its text), then posted for the rest */
  private watch(seq: number, sql: PlannedSql, signal: AbortSignal): () => void {
    const calls = sql.functions.length > 0;
    const abort = (): void => {
      if (calls) cancelStatement(this.ex.cancels, this.slot, seq);
      this.ex.post({ op: "runner.abort", runner: this.id, seq, reason: reasonOf(signal) });
    };
    signal.addEventListener("abort", abort);
    if (signal.aborted && calls) cancelStatement(this.ex.cancels, this.slot, seq);
    return () => signal.removeEventListener("abort", abort);
  }

  private failure(signal: AbortSignal, e: unknown, sql: PlannedSql): unknown {
    if (e instanceof ExecutorGone) return goneError(e, sql.text);
    // a cancelled statement's failure read under THIS signal (the same function as the worker's, src/duck/store.ts),
    // since the cancelled call's error may reach the worker before the abort does; any other failure as the worker
    // threw it (an EncodeError is the listener's to word)
    return signal.aborted ? failureOf(signal, e, sql.text) : e;
  }

  async run(sql: PlannedSql, params: readonly (string | null)[], session: Session, signal: AbortSignal, fields: Fields = null, exact: readonly ExactColumn[] = []): Promise<DuckAnswer> {
    const seq = ++this.seq;
    const unwatch = this.watch(seq, sql, signal);
    let columns: DuckAnswer["columns"];
    try { columns = await this.ex.call({ op: "runner.run", runner: this.id, seq, sql, params, session, fields, exact, aborted: reasonOf(signal) }); }
    catch (e) { unwatch(); throw this.failure(signal, e, sql); }
    let ended = false;
    const end = (): void => { if (!ended) { ended = true; unwatch(); } };
    const calls = sql.functions.length > 0;
    return {
      columns,
      fetch: async (formats, s) => {
        if (ended) return null;
        let got: { bytes: ArrayBuffer; ends: number[] } | null;
        try { got = await this.ex.call({ op: "answer.fetch", runner: this.id, seq, formats, timeZone: s.timeZone }); }
        catch (e) { end(); throw this.failure(signal, e, sql); }
        // A STATEMENT WHOSE CANCEL WAS ASKED IS NEVER "ok" (a review finding): a cancel or a timeout that landed
        // after its last function call, or after DuckDB computed its last chunk, found nothing left to stop, and the
        // result came back whole — the client is told 57014 all the same, as THIS thread's signal says it (the timeout's
        // words, or the cancel's)
        if (got === null) { end(); if (signal.aborted) throw failureOf(signal, null, sql.text); return null; }
        const all = Buffer.from(got.bytes);
        return got.ends.map((to, i) => all.subarray(i === 0 ? 0 : got.ends[i - 1]!, to));
      },
      close: () => {
        if (ended) return;
        end();
        // its calls see the cancel now; the worker cancels the rest (an interrupt) and releases it once DuckDB hands it
        // back — answered then, so the process never ends while DuckDB still calls into the worker for it
        if (calls) cancelStatement(this.ex.cancels, this.slot, seq);
        this.ex.background({ op: "answer.close", runner: this.id, seq });
      },
    };
  }

  async explain(sql: PlannedSql, params: readonly (string | null)[], session: Session, signal: AbortSignal,
    how: ExplainHow): Promise<string[]> {
    const seq = ++this.seq;
    const unwatch = this.watch(seq, sql, signal);
    let lines: string[];
    try { lines = await this.ex.call<string[]>({ op: "runner.explain", runner: this.id, seq, sql, params, session, how, aborted: reasonOf(signal) }); }
    catch (e) { throw this.failure(signal, e, sql); }
    finally { unwatch(); }
    // as `fetch`'s end: an EXPLAIN ANALYZE whose cancel was asked is never answered
    if (signal.aborted) throw failureOf(signal, null, sql.text);
    return lines;
  }

  /** closes the connection once its answers are released (the worker waits for them: never under the executor) */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.ex.call({ op: "runner.close", runner: this.id }); }
    catch (e) { if (!(e instanceof ExecutorGone)) throw e; }
    finally { this.ex.release(this.slot); }
  }
}
