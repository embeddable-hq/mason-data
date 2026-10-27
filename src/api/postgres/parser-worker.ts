/**
 * THE POSTGRES PARSER, in a worker thread (src/api/postgres/parser.ts asks it, and says why it is recycled).
 *
 * `libpg-query` is Postgres 18's own parser compiled to WebAssembly: the same grammar a statement would meet on a real
 * Postgres, so "does this parse" is never a question this repo answers for itself.
 *
 * Protocol: a request is the SQL text; the reply is `{ ok: true, result }` (the parse tree) or
 * `{ ok: false, message, cursorPosition }` (a syntax error, with the 0-based offset: libpg-query
 * has already converted Postgres's 1-based cursor), or `{ ok: false, fatal: true, message }` when
 * the parser itself could not start. After every reply the shared signal is set to 1 and notified.
 */
import { setFlagsFromString } from "node:v8";
import { workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

const { port, signal } = workerData as { port: MessagePort; signal: Int32Array };
const answered = (): void => { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };

// NEVER OPTIMIZE THE PARSER'S WEBASSEMBLY. By default V8 re-compiles a hot WebAssembly function with its
// optimizing compiler in the background, and for this module that costs ~900 MB of resident memory, kept for
// the life of the process (the test server, node 24.21 on Linux: emit peaks at 995 MB with it and 107 MB
// without, `/sys/fs/cgroup/memory.peak` of the bootstrap container, which is limited to 1 GiB and killed it).
// A statement is short: the baseline code is fast enough.
//
// WHAT TURNS IT OFF IS MEASURED, NOT INFERRED, because the flags read at runtime differ from the ones read at
// start-up and differ between platforms. `--liftoff-only` on the command line works (93 MB) but is read once,
// when the engine starts, and set here does nothing (995 MB). `--wasm-tiering-budget=<max>` set here worked on
// macOS (the first fix, 117 MB) and does NOTHING on the test server's Linux build (997 MB as a CLI flag,
// 995 MB from here) — which is how a reload that had fitted stopped fitting once a few more parses were added.
// Each of `--no-wasm-dynamic-tiering` and `--no-wasm-tier-up` alone is still 995 MB; BOTH, set here before
// `libpg-query` compiles its module below, are 107 MB on the test server (three runs) — the two switches that
// `--liftoff-only` implies. Re-measure on the test server before changing this line: a wrong flag is silent.
setFlagsFromString("--no-wasm-dynamic-tiering --no-wasm-tier-up");

// THE PARSER'S OWN START-UP FAILURE IS THE REPLY. The caller is blocked in `Atomics.wait` and can observe nothing
// but the port and the signal, so a `libpg-query` that is not installed (no `npm ci`) or a WebAssembly that will not
// load is reported as a fatal reply carrying the real message — not as a 20 s silence guessed at from outside.
let parser: typeof import("libpg-query");
try {
  parser = await import("libpg-query");
  await parser.loadModule();
} catch (e) {
  const fatal = { ok: false, fatal: true, message: `the Postgres parser could not start: ${(e as Error).message}` };
  port.on("message", () => { port.postMessage(fatal); answered(); });
  port.postMessage(fatal);
  answered();
  throw e;
}

port.on("message", (sql: unknown) => {
  try {
    const result = parser.parseSync(String(sql));
    port.postMessage({ ok: true, result });
  } catch (e) {
    const err = e instanceof parser.SqlError ? e : null;
    port.postMessage({ ok: false, message: (e as Error).message, cursorPosition: err?.sqlDetails?.cursorPosition ?? null });
  } finally {
    answered();
  }
});
