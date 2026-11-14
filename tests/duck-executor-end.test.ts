/**
 * HOW THE ENGINE'S THREAD ENDS (src/duck/executor.ts "THE THREAD ENDS BY ITSELF"; issue 913). After a fatal error in the
 * synced data the run aborted, exit 134 and `terminate called after throwing an instance of 'Napi::Error'`, in 1 test
 * of 40: the worker's shutdown had answered, and the executor's `worker.terminate()` was the last step logged. A
 * terminate stops the thread's JavaScript wherever it is, and a native callback of DuckDB's node API that runs then (a
 * call's completion settling its promise) throws where nothing catches. The run's cause line could be lost as well: it
 * is written through a stream, and the process exited without waiting for it.
 *
 * Offline, each run in a process of its own (a native abort is its exit code, 134), over a generated table: the synced
 * data invalidated by DuckDB's own `debug_checkpoint_abort`, as a checkpoint on a full disk invalidates it (issue 830).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dir, nodeProcess, useScratch } from "./duck-executor-harness.ts";

useScratch();

const src = (f: string): string => JSON.stringify(fileURLToPath(new URL(`../src/${f}`, import.meta.url)));

// THE NATIVE WORK STILL ON ITS WAY: the copy's own worker, with one thing added. Once its shutdown has answered, it
// runs DuckDB calls for a moment more on an instance of its own (a connection opened, a statement, the connection
// closed, four at once), as a completion of DuckDB's may still be on its way after the copy's instance closed. Its
// thread must end once they are done, never under them: a terminate there aborted the process.
const LATE_WORKER = `import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const { DuckDBInstance } = createRequire(${JSON.stringify(fileURLToPath(import.meta.url))})("@duckdb/node-api");
let shutdownId = null;
const on = parentPort.on.bind(parentPort);
parentPort.on = (event, f) => on(event, event !== "message" ? f : (m) => { if (m.op === "shutdown") shutdownId = m.id; f(m); });
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (m, transfer) => {
  if (shutdownId !== null && m.id === shutdownId) void (async () => {
    const late = await DuckDBInstance.create(":memory:");
    const until = Date.now() + 300;
    await Promise.all([0, 1, 2, 3].map(async () => {
      while (Date.now() < until) { const c = await late.connect(); await c.run("SELECT 1"); c.closeSync(); }
    }));
    late.closeSync();
  })();
  return post(m, transfer);
};
await import(${src("duck/executor-worker.ts")});
`;

// ONE RUN, ENDED AS src/cli/dev.ts ENDS ONE AFTER A FATAL ERROR: its cause written to its log (RunLog) as the run's
// onCrash writes it, the synced data closed, the log ended, then the process's exit (exitWhenWritten), code 1.
const RUN = (file: string, log: string, worker: string): string => `
const { DuckStore } = await import(${src("duck/store.ts")});
const { RunLog } = await import(${src("cli/run-output.ts")});
const { exitWhenWritten } = await import(${src("lib/exit-when-written.ts")});
const log = new RunLog(${JSON.stringify(log)}, { said: (t) => process.stderr.write(t + "\\n") });
const store = await DuckStore.open(${JSON.stringify(file)}, (l) => log.write(l + "\\n"), { workerFile: ${JSON.stringify(worker)} });
const keep = setInterval(() => undefined, 1000);   // the run's listener, which holds the process
const crashed = new Promise((resolve) => store.onCrash((reason) => { log.write("[engine] the engine stopped: " + reason + "\\n"); resolve(); }));
await store.writer.run("CREATE TABLE public.gen AS SELECT range::INTEGER AS id FROM range(50000)");
await store.writer.run("SET debug_checkpoint_abort = 'before_header'");
// fails, FATAL (in its own words or the run's reason: the check after it may end the run first, issue 899)
await store.writer.run("CHECKPOINT").then(() => { throw new Error("the checkpoint did not fail"); }, (e) => log.write("[test] the checkpoint: " + e.message + "\\n"));
await crashed;
clearInterval(keep);
await store.close();
await log.end();
exitWhenWritten(1);
`;

test("a run ended by a fatal error in the synced data exits 1 with its cause in its log, never by an abort, however late the engine's last native call", { timeout: 300_000 }, async (t) => {
  const worker = path.join(dir, "late-worker.mjs");
  fs.writeFileSync(worker, LATE_WORKER);
  const RUNS = 6;
  for (let i = 0; i < RUNS; i++) {
    const log = path.join(dir, `run-${i}.log`);
    const script = path.join(dir, `run-${i}.mjs`);
    fs.writeFileSync(script, RUN(path.join(dir, `run-${i}.db`), log, worker));
    const run = await nodeProcess(script, 60_000);
    assert.doesNotMatch(run.stderr, /Napi::Error|terminate called/, `run ${i + 1} of ${RUNS}: aborted in native code\n${run.stderr}`);
    assert.equal(run.signal, null, `run ${i + 1} of ${RUNS}: ended by a signal (a hang killed, or an abort)\n${run.stderr}`);
    assert.equal(run.status, 1, `run ${i + 1} of ${RUNS}: its own exit code (134 is an abort)\n${run.stderr}`);
    // the cause is in the file once the process is gone: what mason logs reads after a crash
    const written = fs.readFileSync(log, "utf8");
    assert.match(written, /\[engine\] the engine stopped: the synced data met a fatal error and must be opened again \(.*checkpoint.*\)/i,
      `run ${i + 1} of ${RUNS}: the cause line in the log\n${written}`);
  }
  t.diagnostic(`${RUNS} runs, each exit 1 with its cause in its log`);
});
