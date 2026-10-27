/**
 * THE CATALOG'S WORKER: PGlite (Postgres as WebAssembly) runs HERE, on a worker thread, never on the listener's own
 * (review of #480: a forwarded `SELECT pg_sleep(3600)` froze every other Postgres session, and PGlite ignores
 * `statement_timeout`). The main thread (catalog.ts PgCatalog) posts one request at a
 * time on the port and holds a deadline for it; past the deadline it TERMINATES this thread and starts another, so a
 * statement that never ends costs one instance, not the process.
 *
 * Messages in: `{ id, op: "init", statements, optional? }` (start PGlite and run the DDL; the reply names the refused
 * statement, or the optional ones refused),
 * `{ id, op: "raw", bytes }` (frontend protocol bytes in, backend bytes out), `{ id, op: "query", sql }` (rows as
 * objects, for the server's own lookups and the tests), `{ id, op: "close" }`. Every reply carries the id:
 * `{ id, ok: true, bytes | rows }` or `{ id, ok: false, message }`.
 */
import { parentPort } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";

type Request =
  | { id: number; op: "init"; statements: string[]; optional?: string[] }
  | { id: number; op: "raw"; bytes: Uint8Array }
  | { id: number; op: "query"; sql: string }
  | { id: number; op: "close" };

const port = parentPort;
if (port === null) throw new Error("catalog-worker.ts runs on a worker thread only");

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
let db: PGlite | null = null;

port.on("message", (m: Request) => {
  void (async () => {
    try {
      switch (m.op) {
        case "init": {
          // citext bundled: a copied citext column is declared as itself (catalog.ts `catalogDdl`)
          const instance = new PGlite({ extensions: { citext } });
          await instance.waitReady;
          for (const statement of m.statements) {
            try {
              await instance.exec(statement);
            } catch (e) {
              // the half-made instance is discarded (the start failed, said below with the statement); a close that fails is said too
              await instance.close().catch((ce: unknown) => console.error(`catalog worker: PGlite did not close cleanly after a refused DDL: ${errorMessage(ce)}`));
              throw new Error(`the catalog DDL was refused (${errorMessage(e)}) at:\n${statement}`, { cause: e });
            }
          }
          // a statement the catalog may do without (a source's column default or view, catalog.ts `catalogDefaults`,
          // `catalogViews`): each on its own (a multi-statement one is its own implicit transaction: all or none), in
          // passes while one more stands — a view over a view stands once the other does — and the refused ones named in
          // the reply for the log
          let left = [...(m.optional ?? [])];
          let refused: Array<{ statement: string; message: string }> = [];
          for (let progress = true; progress && left.length > 0;) {
            refused = [];
            for (const statement of left) {
              try { await instance.exec(statement); }
              catch (e) { refused.push({ statement, message: errorMessage(e) }); }
            }
            progress = refused.length < left.length;
            left = refused.map((r) => r.statement);
          }
          db = instance;
          port.postMessage({ id: m.id, ok: true, ...(refused.length > 0 ? { refused } : {}) });
          return;
        }
        case "raw": {
          if (db === null) throw new Error("the catalog is not started");
          const bytes = await db.execProtocolRaw(m.bytes);
          const copy = new Uint8Array(bytes);   // PGlite may reuse its buffer: a copy of our own is transferred
          port.postMessage({ id: m.id, ok: true, bytes: copy }, [copy.buffer]);
          return;
        }
        case "query": {
          if (db === null) throw new Error("the catalog is not started");
          const result = await db.query<Record<string, unknown>>(m.sql);
          port.postMessage({ id: m.id, ok: true, rows: result.rows });
          return;
        }
        case "close": {
          const instance = db;
          db = null;
          if (instance !== null) await instance.close();
          port.postMessage({ id: m.id, ok: true });
          return;
        }
      }
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, message: errorMessage(e) });
    }
  })();
});
