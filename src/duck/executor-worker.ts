/**
 * THE EXECUTOR WORKER'S SIDE (src/duck/executor.ts says why it exists): the one DuckDB instance of the copy's file,
 * every connection of it, and the Mason functions, registered from THIS thread so that every call DuckDB's executor
 * makes lands here and never on the listener's thread. It answers the requests the main thread posts — a connection's
 * statements (`conn.*`), a wire session's (`runner.*`, `answer.*`, run by src/duck/store.ts SessionRunner as before)
 * — each with its id, and says its log lines as messages.
 *
 * THIS thread never waits for the executor (src/duck/store.ts "HOW A STATEMENT IS CANCELLED"): a result or a
 * connection is closed only once DuckDB ended what ran on it. A request is answered asynchronously, so the turns between
 * a statement's function calls serve the others; a statement's cancel does not need one (the cancel table,
 * src/duck/cancel.ts).
 */
import { parentPort, workerData, type TransferListItem } from "node:worker_threads";
import type { DuckDBConnection, DuckDBInstance, DuckDBValue } from "@duckdb/node-api";
import { openDuck, SessionRunner } from "./store.ts";
import { FUNCTION_CALLS, FUNCTION_ROWS, registerLibcOrder, useCancelTable } from "./functions.ts";
import { stopPgEval } from "./pg-eval.ts";
import type { DuckAnswer, DuckSession } from "../api/postgres/server.ts";
import { StatementError } from "./statement.ts";
import { STOPPING, wireError, type Reply } from "./executor.ts";

const { cancels } = workerData as { cancels: Int32Array };
useCancelTable(cancels);
const port = parentPort!;

let instance: DuckDBInstance | null = null;
/** the connections by number: 0 is the writer (the store's), the rest `connect`'s */
const conns = new Map<number, DuckDBConnection>();
let nextConn = 1;
const runners = new Map<number, SessionRunner>();
let nextRunner = 1;
/** each session's close, from its start until it ends (`runner.close`, or the shutdown's): the shutdown waits for every
 *  one before it closes the instance — one it did not wait for closed the connections and the instance under a drain's
 *  pending fetch, and the process aborted (a review: exit 134, an uncaught Napi::Error) */
const closing = new Map<number, Promise<void>>();
/** every connection call still running, by connection: the shutdown closes a connection only once its calls settled */
const connCalls = new Map<number, Set<Promise<unknown>>>();
/** set by `shutdown`: a session's new statement is refused 57P01, a connection's new call refused */
let stopping = false;
/** a session's statement in flight: its signal (the main thread's, carried across) and, once DuckDB answered, its rows */
interface InFlight { controller: AbortController; answer: DuckAnswer | null }
const statements = new Map<string, InFlight>();
const key = (runner: number, seq: number): string => `${runner}:${seq}`;

const log = (line: string): void => { port.postMessage({ log: line } satisfies Reply); };

/** an abort's reason as the main thread's signal has it: the statement timeout's error, else none (the client's cancel) */
const abortWith = (c: AbortController, reason: { fields?: StatementError["fields"] }): void => {
  if (!c.signal.aborted) { if (reason.fields !== undefined) c.abort(new StatementError(reason.fields, "")); else c.abort(); }
};

/** a connection's call, held in `connCalls` until it settles */
function onConn<T>(n: number, f: (c: DuckDBConnection) => Promise<T>): Promise<T> {
  if (stopping) return Promise.reject(new Error("the engine is closing: no statement starts on it any more"));
  const p = f(need(conns, n, "connection"));
  const calls = connCalls.get(n) ?? new Set<Promise<unknown>>();
  connCalls.set(n, calls);
  calls.add(p);
  void p.then(() => calls.delete(p), () => calls.delete(p));
  return p;
}

/** a session's close, once: started by its `runner.close` or by the shutdown, whichever comes first */
function closeRunner(n: number): Promise<void> {
  const already = closing.get(n);
  if (already !== undefined) return already;
  const runner = need(runners, n, "session");
  runners.delete(n);
  const p = runner.close();
  closing.set(n, p);
  void p.then(() => closing.delete(n), () => closing.delete(n));
  return p;
}

const need = <T>(m: Map<number, T>, n: number, what: string): T => {
  const v = m.get(n);
  if (v === undefined) throw new Error(`no ${what} ${n} on the engine's thread (Mason bug: report it)`);
  return v;
};

type Request = Record<string, unknown> & { id?: number; op: string };

async function answer(m: Request): Promise<{ value: unknown; transfer?: TransferListItem[] } | undefined> {
  // a session's statement asked once the stop began: told so, never started under the closing instance
  if (stopping && ["runner.open", "runner.run", "runner.explain", "answer.fetch"].includes(m.op)) throw new StatementError(STOPPING, "");
  switch (m.op) {
    case "open": {
      const opened = await openDuck(String(m.file), m.settings as Record<string, string>);
      instance = opened.instance;
      conns.set(0, opened.writer);
      return { value: null };
    }
    case "connect": {
      if (instance === null) throw new Error("the engine is not open (Mason bug: report it)");
      const n = nextConn++;
      conns.set(n, await instance.connect());
      return { value: n };
    }
    case "conn.run": {
      const r = await onConn(Number(m.conn), (c) => c.run(String(m.sql), m.values as DuckDBValue[] | undefined));
      return { value: { rowsChanged: r.rowsChanged } };
    }
    case "conn.read": {
      const r = await onConn(Number(m.conn), (c) => c.runAndReadAll(String(m.sql), m.values as DuckDBValue[] | undefined));
      return { value: { js: r.getRowsJS(), json: r.getRowsJson(), rows: r.getRows(), names: r.columnNames(),
        types: Array.from({ length: r.columnCount }, (_, i) => r.columnType(i).toJson()) } };
    }
    case "conn.prepare": {
      const p = await onConn(Number(m.conn), (c) => c.prepare(String(m.sql)));
      try { return { value: { names: Array.from({ length: p.columnCount }, (_, i) => p.columnName(i)), types: Array.from({ length: p.columnCount }, (_, i) => p.columnType(i).toJson()) } }; }
      finally { p.destroySync(); }
    }
    case "conn.interrupt": conns.get(Number(m.conn))?.interrupt(); return undefined;
    case "conn.close": {
      const n = Number(m.conn);
      // NEVER CLOSED UNDER A CALL OF ITS OWN: the close is synchronous here and waits for that call's tasks, and a task
      // inside a Mason function waits for this thread. The close says nobody wants the call's answer, so it is
      // interrupted, and its failure (a call's own promise, handled by whoever asked) waited for off this thread
      const calls = [...(connCalls.get(n) ?? [])];
      if (calls.length > 0) { conns.get(n)?.interrupt(); await Promise.allSettled(calls); }
      const c = conns.get(n);
      conns.delete(n);
      try { c?.closeSync(); }
      catch (e) { log(`closing a connection of the engine failed: ${(e as Error).message}`); }
      return undefined;
    }
    case "libc": registerLibcOrder(need(conns, 0, "connection"), m.order as Parameters<typeof registerLibcOrder>[1]); return { value: null };
    case "calls": return { value: Object.fromEntries(FUNCTION_CALLS) };
    case "function rows": return { value: Object.fromEntries(FUNCTION_ROWS) };
    case "runner.open": {
      if (instance === null) throw new Error("the engine is not open (Mason bug: report it)");
      const n = nextRunner++;
      runners.set(n, await SessionRunner.open(instance, log, Number(m.slot), cancels));
      return { value: n };
    }
    case "runner.run": {
      const runner = need(runners, Number(m.runner), "session");
      const k = key(Number(m.runner), Number(m.seq));
      const s: InFlight = { controller: new AbortController(), answer: null };
      if (m.aborted !== null) abortWith(s.controller, m.aborted as { fields?: StatementError["fields"] });
      statements.set(k, s);
      runner.next = Number(m.seq);
      try {
        const a = await runner.run(m.sql as never, m.params as (string | null)[], m.session as DuckSession, s.controller.signal,
          m.fields as never, m.exact as never);
        s.answer = a;
        return { value: a.columns.map((c) => ({ name: c.name, oid: c.oid, size: c.size })) };
      } catch (e) { statements.delete(k); throw e; }
    }
    case "runner.abort": {
      const s = statements.get(key(Number(m.runner), Number(m.seq)));
      if (s !== undefined && m.reason !== null) abortWith(s.controller, m.reason as { fields?: StatementError["fields"] });
      return undefined;
    }
    case "answer.fetch": {
      const k = key(Number(m.runner), Number(m.seq));
      const s = statements.get(k);
      if (s?.answer == null) return { value: null };
      let rows: Buffer[] | null;
      try { rows = await s.answer.fetch(m.formats as number[], { timeZone: String(m.timeZone) }); }
      catch (e) { statements.delete(k); throw e; }
      if (rows === null) { statements.delete(k); return { value: null }; }
      // one buffer a chunk, moved (never copied) to the listener's thread, and where each row ends in it
      let size = 0;
      for (const r of rows) size += r.length;
      const bytes = new ArrayBuffer(size);
      const into = new Uint8Array(bytes);
      const ends: number[] = new Array<number>(rows.length);
      let at = 0;
      rows.forEach((r, i) => { into.set(r, at); at += r.length; ends[i] = at; });
      return { value: { bytes, ends }, transfer: [bytes] };
    }
    case "answer.close": {
      // answered once DuckDB handed the answer back (its drain, src/duck/store.ts): until then the main thread holds the
      // process open, which must never end while DuckDB calls into this thread (src/duck/executor.ts "NOTHING ENDS")
      const k = key(Number(m.runner), Number(m.seq));
      statements.get(k)?.answer?.close();
      statements.delete(k);
      await (runners.get(Number(m.runner)) ?? null)?.idle();
      await closing.get(Number(m.runner));
      return { value: null };
    }
    case "runner.explain": {
      const runner = need(runners, Number(m.runner), "session");
      const k = key(Number(m.runner), Number(m.seq));
      const s: InFlight = { controller: new AbortController(), answer: null };
      if (m.aborted !== null) abortWith(s.controller, m.aborted as { fields?: StatementError["fields"] });
      statements.set(k, s);
      runner.next = Number(m.seq);
      try { return { value: await runner.explain(m.sql as never, m.params as (string | null)[], m.session as DuckSession, s.controller.signal, m.how as never) }; }
      finally { statements.delete(k); }
    }
    case "runner.close": {
      await closeRunner(Number(m.runner));
      return { value: null };
    }
    case "shutdown": {
      stopping = true;
      // THE STOP (mason stop, a shutdown): every statement still in flight is stopped as a cancel stops it — through its
      // session when it calls a Mason function, interrupted when it calls none — with the stop as its reason, so its
      // session is told 57P01 (STOPPING), never "ok" and never a hang; then every session's connection is closed once
      // nothing runs on it (the listener's own closes, still in flight, included), and only then the connections and
      // the instance. Nothing is closed under a pending call of DuckDB's: that aborted the process
      for (const s of statements.values()) abortWith(s.controller, { fields: STOPPING });
      for (const n of [...runners.keys()]) void closeRunner(n);
      await Promise.allSettled([...closing.values()]);
      // a connection's call left running (the sync and the request log stop theirs first): interrupted, and waited
      // for — never closed under (a task of it inside a call waits for this thread)
      for (const [n, calls] of connCalls) if (calls.size > 0) conns.get(n)?.interrupt();
      for (const calls of connCalls.values()) await Promise.allSettled([...calls]);
      for (const [n, c] of [...conns].reverse()) { conns.delete(n); c.closeSync(); }
      instance?.closeSync();
      instance = null;
      await stopPgEval();
      return { value: null };
    }
  }
  throw new Error(`the engine's thread was asked ${JSON.stringify(m.op)}, which it does not know (Mason bug: report it)`);
}

port.on("message", (m: Request) => {
  // the executor's watch (src/duck/executor.ts SILENT_MS): answered at once, by a thread whose loop turns
  if (m.op === "ping") { port.postMessage({ pong: true } satisfies Reply); return; }
  answer(m).then((r) => {
    if (m.id === undefined) return;
    port.postMessage({ id: m.id, ok: true, value: r?.value ?? null } satisfies Reply, r?.transfer ?? []);
  }, (e: unknown) => {
    if (m.id === undefined) { log(`${m.op} failed: ${e instanceof Error ? e.message : String(e)}`); return; }
    port.postMessage({ id: m.id, ok: false, error: wireError(e) } satisfies Reply);
  });
});
