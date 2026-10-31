/**
 * THE EXECUTOR'S SLOW-VECTOR STRESS (src/duck/executor.ts; tests/duck-executor.test.ts has the worker's story): a file of its
 * own so CI's unit shards can place it apart from the executor's other long tests (scripts/ci-shards.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcess, useScratch } from "./duck-executor-harness.ts";

useScratch();

// THE SAME DEADLOCK WITH NO LOAD AT ALL (issue 58): quiet was no proof that a statement's calls had stopped. A vector
// whose NATIVE work comes before its Mason function call outlasts any quiet window with no call made, and a cancel before
// the statement's first call read the previous statement's time as quiet at once: the close waited for a task that
// went on to wait for the closing thread. Both orders, in a vector of about 100 ms and of about 1 s. In a process of its own:
// on the old code this is a kill.
const slowVector = (k: number, order: "before its first fetch" | "during its first fetch", trials: number): string => `
  await store.writer.run("CREATE TABLE public.calls AS SELECT range::INTEGER AS id, '{\\"n\\": ' || range || '}' AS j FROM range(400000)");
  const runner = await store.runner();
  const S = { timeZone: "UTC", searchPath: "public", settings: {} };
  // the CASE gives the call's argument native work per row, with no call and no check of an interrupt until it calls
  const call = "__mason_json_get(getvariable('__mason_session'), CASE WHEN md5(repeat(j, ${k})) = '' THEN '{}' ELSE j END, '[\\"n\\"]', false, true, false)";
  const planned = { text: "SELECT id FROM calls WHERE " + call + " IS NOT NULL", functions: ["__mason_json_get"] };
  const told = {};
  for (let i = 0; i < ${trials}; i++) {
    const c = new AbortController();
    const q = runner.run(planned, [], S, c.signal).then(async (a) => {
      ${order === "before its first fetch" ? "c.abort();" : ""}
      await a.fetch([], { timeZone: "UTC" });
      return "answered";
    }).catch((e) => e.fields?.code ?? e.message);
    ${order === "before its first fetch" ? "" : "await sleep(5 + (i * 13) % 40); c.abort();"}
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
`;
test("a vector slower than any quiet window, cancelled before its first fetch or during it: never a deadlock, every one is 57014, and the copy closes", { timeout: 300_000 }, async () => {
  for (const [k, order, trials] of [[2000, "before its first fetch", 40], [2000, "during its first fetch", 40], [20000, "before its first fetch", 6], [20000, "during its first fetch", 6]] as const) {
    const r = await inProcess(`vector-${k}-${order.split(" ")[0]}`, slowVector(k, order, trials), 120_000);
    assert.equal(r.signal, null, `${k}, ${order}: the process did not end by itself (${r.signal}: a deadlock, killed): it said\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.said, [{ told: { "57014": trials } }, { closed: true }], `${k}, ${order}`);
  }
});
