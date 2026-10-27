/**
 * THE POSTGRES PARSER FOR THE POSTGRES LISTENER: Postgres 18's own grammar (`libpg-query`, WebAssembly), in a worker, asked
 * asynchronously. What a tool sends either parses here exactly as it would on a real Postgres, or fails with
 * Postgres's own message at Postgres's own position (the Postgres API's first invariant, from the day it was planned).
 *
 * WHY A WORKER, AND WHY IT IS RECYCLED. The parser leaks ~110 KB of its WebAssembly memory on EVERY call (measured
 * on 18.1.5, the version installed), and a listener serving a BI tool parses an unbounded number of
 * distinct statements — so the worker is replaced after `RECYCLE_AFTER` parses, which bounds the leak to a few tens of
 * megabytes. And V8 would re-compile the parser's WebAssembly with its optimising compiler for ~900 MB of resident
 * memory, which parser-worker.ts turns off inside the worker: it sets the flags, loads the module, and
 * answers each text on the port with the tree or the syntax error and its offset.
 *
 * NOTHING HERE IS IMPORTED AT STARTUP: the worker is started on the first statement, and a parser that cannot start
 * fails THAT connection's statements with the reason (`libpg-query` is not installed), never the listener's start.
 */
import { MessageChannel, Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ParseResult } from "libpg-query";
import { runnable } from "../../lib/runnable.ts";

/** A Postgres syntax error: Postgres's own message, with the 0-based offset into the text. */
export class PostgresSyntaxError extends Error {
  readonly offset: number | null;
  constructor(message: string, offset: number | null) { super(message); this.offset = offset; }
}

type Reply = { ok: true; result: ParseResult } | { ok: false; message: string; cursorPosition: number | null } | { ok: false; fatal: true; message: string };
interface Pending { resolve: (r: ParseResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** parses per worker before it is replaced (~110 KB leaked each: ~45 MB at most per worker's life) */
export const RECYCLE_AFTER = 400;
/** one parse's deadline, the worker's start (WASM instantiation, ~100 ms) included: past it the worker is dead */
const TIMEOUT_MS = 20_000;

class ParserWorker {
  private worker: Worker;
  private port: MessagePort;
  /** replies arrive in the order the texts were sent: one queue */
  private queue: Pending[] = [];
  sent = 0;
  private dead: Error | null = null;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const file = new URL("./parser-worker.ts", import.meta.url);
    // `execArgv: []`: the worker must not inherit this process's Node flags — a process run as `node --input-type=module
    // -e …` would hand it `--input-type`, which Node refuses for a file, and the worker would die before answering
    this.worker = new Worker(runnable(fileURLToPath(file)), { workerData: { port: port2, signal }, transferList: [port2], execArgv: [], argv: [] });
    this.worker.on("error", (e) => this.die(new Error(`the Postgres parser's worker failed: ${e.message}`)));
    this.worker.on("exit", (code) => this.die(new Error(`the Postgres parser's worker exited with code ${code}`)));
    this.worker.unref();
    this.port = port1;
    this.port.unref();
    this.port.on("message", (reply: Reply) => {
      if (!reply.ok && "fatal" in reply) { this.die(new Error(reply.message)); return; }
      const p = this.queue.shift();
      if (p === undefined) return;   // the worker's own fatal reply sent before any request: handled above
      clearTimeout(p.timer);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new PostgresSyntaxError(reply.message, reply.cursorPosition));
    });
  }

  /** everything pending fails with the reason, and so does everything after */
  private die(e: Error): void {
    if (this.dead !== null) return;
    this.dead = e;
    for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(e); }
  }

  get alive(): boolean { return this.dead === null; }

  parse(sql: string): Promise<ParseResult> {
    if (this.dead !== null) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.die(new Error(`the Postgres parser did not answer within ${TIMEOUT_MS / 1000} s — its worker (src/api/postgres/parser-worker.ts) is dead or hung; its own error, if it printed one, is on stderr`));
        void this.worker.terminate();
      }, TIMEOUT_MS);
      timer.unref();
      this.queue.push({ resolve, reject, timer });
      this.sent++;
      this.port.postMessage(sql);
    });
  }

  async stop(): Promise<void> {
    this.die(new Error("the Postgres parser was stopped"));
    await this.worker.terminate();
  }
}

let current: ParserWorker | null = null;
/** workers past their recycle count, kept until their last reply is in */
const retiring = new Set<ParserWorker>();

/** The parse tree of one text (libpg-query's `ParseResult`, Postgres 18's grammar), or a PostgresSyntaxError. */
export async function parseSql(sql: string): Promise<ParseResult> {
  // an empty string is no statement to Postgres (EmptyQueryResponse; pgjdbc's isValid() sends one), where libpg_query
  // throws "Query cannot be empty" — whitespace, a `;` or a comment alone already parse to no statement
  if (sql === "") return { version: 0, stmts: [] };
  if (current === null || !current.alive || current.sent >= RECYCLE_AFTER) {
    if (current !== null && current.alive) {
      // let its queued replies land, then terminate it
      const old = current;
      retiring.add(old);
      void old.parse("SELECT 1").then(() => undefined, () => undefined).finally(() => { retiring.delete(old); void old.stop(); });
    }
    current = new ParserWorker();
  }
  return current.parse(sql);
}

/** Stops the parser (tests, and the API's shutdown). */
export async function stopParser(): Promise<void> {
  const w = current;
  current = null;
  if (w !== null) await w.stop();
  for (const r of retiring) await r.stop();
  retiring.clear();
}
