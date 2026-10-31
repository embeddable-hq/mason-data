/**
 * THE EXECUTOR'S CANCEL STRESS (src/duck/executor.ts; tests/duck-executor.test.ts has the worker's story): a file of its own
 * so CI's unit shards can place it apart from the executor's other long tests (scripts/ci-shards.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcess, useScratch } from "./duck-executor-harness.ts";

useScratch();

// THE SUITE'S HANG: under load a file's process sat at 0 % CPU for good. Its threads, sampled: the executor
// worker inside a result's close (DuckDB's Executor::CancelTasks, waiting for the query's tasks) and one of DuckDB's
// threads inside a Mason function call (CAPIScalarFunction, waiting for the worker, which runs every function). DuckDB
// hands a cancelled statement's error back while another task of it still waits for a call; the close then waited for
// that task and the task for the closing thread. Every later request to the copy waited with them — the next test's
// statements, the after-hook's close. Cancelled a few hundred times, a statement calling a function on every row met
// it within a minute on a laptop; a result that did not end is now closed only once DuckDB ended the query off the
// worker's thread (src/duck/store.ts cleanUp). In a process of its own: a deadlock is a kill, and a test process that
// cannot end.
test("cancelling a function-calling statement again and again never deadlocks the engine's thread: every one is 57014, and the copy closes", { timeout: 240_000 }, async () => {
  const r = await inProcess("cancels", `
    await store.writer.run("CREATE TABLE public.calls AS SELECT range::INTEGER AS id, '{\\"n\\": ' || range || '}' AS j FROM range(2000000)");
    const runner = await store.runner();
    const S = { timeZone: "UTC", searchPath: "public", settings: {} };
    // a planned statement (src/duck/plan.ts PlannedSql) calling json's -> on every row, as the rewrite writes it
    const calling = { text: "SELECT count(*) FROM calls WHERE __mason_json_get(getvariable('__mason_session'), j, '[\\"n\\"]', false, true, false) IS NOT NULL", functions: ["__mason_json_get"] };
    const told = {};
    for (let i = 0; i < 200; i++) {
      const c = new AbortController();
      const q = runner.run(calling, [], S, c.signal).then(async (a) => { await a.fetch([], { timeZone: "UTC" }); return "answered"; }).catch((e) => e.fields?.code ?? e.message);
      await sleep(10 + (i * 37) % 150);
      c.abort();
      const got = await Promise.race([q, sleep(30_000).then(() => "no answer within 30 s")]);
      told[got] = (told[got] ?? 0) + 1;
      if (got === "no answer within 30 s") break;
    }
    say({ told });
    await runner.close();
    await api.close();
    await keeper.stop();
    await store.close();
    say({ closed: true });
  `, 180_000);
  assert.equal(r.signal, null, `the process did not end by itself (${r.signal}: a deadlock, killed): it said\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.said, [{ told: { "57014": 200 } }, { closed: true }]);
});
