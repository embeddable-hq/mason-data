/**
 * POSTGRES'S OWN FUNCTIONS, ON A WORKER (src/duck/pg-eval.ts): a PGlite with no tables, asked by DuckDB's scalar
 * functions what Postgres makes of a chunk of values — a text read as a date, an interval, a boolean; a jsonpath
 * evaluated. The main thread blocks on `signal` while this thread answers, so nothing here may wait on the main thread.
 *
 * In (on `port`): `{ sql, params, timeZone }`. Out: `{ ok: true, rows }` (each value its text, an array the JSON of its
 * elements' text, or null) or
 * `{ ok: false, code, message }` (Postgres's SQLSTATE and words); then `signal[0]` is set to 1 and notified.
 */
import { workerData, type MessagePort } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";

interface Request { sql: string; params: unknown[]; timeZone: string }
const { port, signal } = workerData as { port: MessagePort; signal: Int32Array };

const db = new PGlite();
let zone: string | null = null;

const reply = (m: unknown): void => { port.postMessage(m); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };

port.on("message", (m: Request) => {
  void (async () => {
    try {
      await db.waitReady;
      if (zone !== m.timeZone) {
        await db.exec(`SET TimeZone = '${m.timeZone.replace(/'/g, "''")}'`);
        zone = m.timeZone;
      }
      const result = await db.query<unknown[]>(m.sql, m.params, { rowMode: "array" });
      // an array as the JSON of its elements' text (the `list` kind, src/duck/functions.ts)
      const textOf = (v: unknown): string | null => v === null ? null : Array.isArray(v) ? JSON.stringify(v.map(textOf)) : String(v);
      reply({ ok: true, rows: result.rows.map((r) => r.map(textOf)) });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      reply({ ok: false, code: typeof err.code === "string" ? err.code : "XX000", message: err.message ?? String(e) });
    }
  })();
});
