/**
 * The frame the three history tables share (src/duck/history.ts): rows written in batches, one at a time and in
 * order; a failure said once per streak, and its end said once with what it cost. The tables' own behaviour is their
 * tests' (tests/duck-requests.test.ts, tests/duck-events.test.ts, tests/duck-usage.test.ts), unchanged by the frame.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

// imported when the tests run: at a commit without the module the file still loads, and its tests fail by name
const history = await import("../src/duck/history.ts" as string).catch(() => ({})) as Partial<typeof import("../src/duck/history.ts")>;

test("Batches: a batch at `rows`, else after `ms`; one write at a time, in the order taken; flush writes what waits", async () => {
  assert.equal(typeof history.Batches, "function", "src/duck/history.ts exports Batches");
  const written: number[][] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const b = new history.Batches!<number>({ rows: 3, ms: 10_000, write: async (rows) => {
    if (first) { first = false; await gate; }
    written.push(rows);
  } });
  for (const n of [1, 2, 3]) b.push(n);
  // the first batch is held in its write: the next waits behind it
  for (const n of [4, 5, 6]) b.push(n);
  b.push(7);
  const done = b.flush();
  assert.deepEqual(written, [], "nothing written while the first write is held");
  release();
  await done;
  assert.deepEqual(written, [[1, 2, 3], [4, 5, 6], [7]], "in the order taken, one after the other");
  assert.equal(await b.flush(), undefined, "nothing waiting: resolves");
  const timed: number[][] = [];
  const t = new history.Batches!<number>({ rows: 100, ms: 5, write: async (rows) => { timed.push(rows); } });
  t.push(1); t.push(2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(timed, [[1, 2]], "written after `ms`");
});

test("Streak: the first failure of a streak said once with its cost counted, its end said once with what it cost", () => {
  assert.equal(typeof history.Streak, "function", "src/duck/history.ts exports Streak");
  const said: string[] = [];
  const s = new history.Streak!();
  s.succeeded((n) => said.push(`again after ${n}`));
  assert.equal(said.length, 0, "no streak: nothing to say");
  s.failed(2, () => said.push("failed"));
  s.failed(3, () => said.push("failed"));
  s.succeeded((n) => said.push(`again after ${n}`));
  s.succeeded((n) => said.push(`again after ${n}`));
  s.failed(1, () => said.push("failed"));
  assert.deepEqual(said, ["failed", "again after 5", "failed"]);
});
