/**
 * POSTGRES'S OWN FUNCTIONS, A CHUNK AT A TIME (the corpus run's unverified casts). What a text MEANS as a
 * date, a timestamp, an interval, a boolean, an integer or a numeric is Postgres's input functions' to say — they read
 * `01/02/2026`, `January 2, 2026`, `J2461043`, `2026-01-02 America/New_York`, `1 day ago`, `P1DT2H`, ` yes `, `0x1F`,
 * `1_000` — and DuckDB reads ISO alone. So nothing reimplements them: a DuckDB scalar function (src/duck/functions.ts
 * `__mason_pg_*`) hands its chunk's distinct values to a PGlite on a worker thread (pg-eval-worker.ts), which applies
 * Postgres's own function under the session's TimeZone and answers each value, or Postgres's error. The same route
 * answers the few functions DuckDB has no equivalent of (jsonpath's).
 *
 * DuckDB calls a scalar function synchronously, so the call BLOCKS the main thread until the worker answers
 * (`Atomics.wait`, then `receiveMessageOnPort`): about 8 ms for 2,048 values. A worker that does not answer within
 * `TIMEOUT_MS` is terminated and the statement fails; the next call starts another.
 */
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { runnable } from "../lib/runnable.ts";

const TIMEOUT_MS = 30_000;

export class PgEvalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type Reply = { ok: true; rows: Array<Array<string | null>> } | { ok: false; code: string; message: string };

let current: { worker: Worker; port: MessagePort; signal: Int32Array } | null = null;

function start(): { worker: Worker; port: MessagePort; signal: Int32Array } {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = // `runnable`: the package ships this worker as .js (cli/build.ts), and a URL to the .ts would wait out TIMEOUT_MS and fail
  new Worker(runnable(fileURLToPath(new URL("./pg-eval-worker.ts", import.meta.url))), { workerData: { port: port2, signal }, transferList: [port2] });
  // the process may end while it lives: it holds nothing that must be closed
  worker.unref();
  port1.unref();
  worker.on("error", (e) => { console.error(`mason: the Postgres function worker failed: ${e.message}`); if (current?.worker === worker) current = null; });
  return { worker, port: port1, signal };
}

/** Runs one statement on the worker's Postgres and returns its rows as text; Postgres's error is a PgEvalError. */
export function pgEvalSync(sql: string, params: unknown[], timeZone: string): Array<Array<string | null>> {
  current ??= start();
  const w = current;
  Atomics.store(w.signal, 0, 0);
  w.port.postMessage({ sql, params, timeZone });
  const waited = Atomics.wait(w.signal, 0, 0, TIMEOUT_MS);
  const got = receiveMessageOnPort(w.port);
  if (waited === "timed-out" || got === undefined) {
    current = null;
    void w.worker.terminate();
    throw new PgEvalError("57014", `Postgres's function did not answer within ${TIMEOUT_MS / 1000} s (Mason computes it on its own Postgres)`);
  }
  const r = got.message as Reply;
  if (!r.ok) throw new PgEvalError(r.code, r.message);
  return r.rows;
}

/** Stops the worker (a store that closes). */
export async function stopPgEval(): Promise<void> {
  const w = current;
  current = null;
  if (w !== null) await w.worker.terminate();
}
