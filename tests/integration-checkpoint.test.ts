/**
 * THE INTEGRATION TESTS' CHECKPOINT IS HELD TO A TIME LIMIT (issue 1188; tests/integration/checkpoint.ts). A FORCE
 * CHECKPOINT waits as long as a transaction older than the last committed write stays open. Without a limit, a change
 * that left one open would hang an integration test until CI's 30-minute job limit. With it, the test fails within the
 * limit and says what was still open. Offline: a real store, and the writer's turn as the Sync keeps it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import { checkpoint } from "./integration/checkpoint.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-checkpoint-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** the writer's turn as the Sync keeps it (src/duck/sync.ts `onWriter`): each job after the one before */
function turns(): { onWriter<T>(f: () => Promise<T>): Promise<T> } {
  let last: Promise<void> = Promise.resolve();
  return {
    onWriter<T>(f: () => Promise<T>): Promise<T> {
      const turn = last.then(f);
      last = turn.then(() => undefined, () => undefined);
      return turn;
    },
  };
}

/** a store whose table had an UPDATE committed after `reader`'s transaction began: a checkpoint must wait for it */
async function heldBack(name: string): Promise<{ store: DuckStore; reader: Awaited<ReturnType<DuckStore["instance"]["connect"]>> }> {
  const store = await DuckStore.open(path.join(dir, `${name}.db`), () => undefined, { memoryLimit: "128MB" });
  await store.writer.run("CREATE TABLE public.t AS SELECT range AS id FROM range(1000)");
  const reader = await store.instance.connect();
  await reader.run("BEGIN TRANSACTION");
  await reader.run("SELECT count(*) FROM public.t");
  await store.writer.run("UPDATE public.t SET id = id + 1 WHERE id < 10");
  await assert.rejects(store.writer.run("CHECKPOINT"), /other write transactions active/, "a plain checkpoint is refused beside the open transaction");
  return { store, reader };
}

test("a checkpoint beside a transaction left open fails within its limit, says so, and leaves the writer's turn and the writer free", { timeout: 60_000 }, async () => {
  const { store, reader } = await heldBack("open");
  try {
    const sync = turns();
    const began = Date.now();
    await assert.rejects(checkpoint(sync, store, 1_000), (e: Error) => {
      assert.match(e.message, /^the checkpoint did not end within 1 s \(\d+ ms\)\. FORCE CHECKPOINT waits for every transaction that began before the last committed write, and one stayed open\. It was interrupted\./);
      assert.match(e.message, /No other request was in flight on the engine: the open transaction is between two of its statements/);
      return true;
    });
    assert.ok(Date.now() - began < 15_000, `failed within the limit, not hung: ${Date.now() - began} ms`);
    // the turn ended: the next job runs, and the writer answers
    assert.deepEqual(await sync.onWriter(async () => (await store.writer.runAndReadAll("SELECT 42")).getRowsJS()), [[42]]);
    // once the transaction ends, the checkpoint passes
    await reader.run("COMMIT");
    await checkpoint(sync, store, 10_000);
  } finally { reader.closeSync(); await store.close(); }
});

test("a checkpoint waiting on a statement in flight names where that statement was sent from", { timeout: 60_000 }, async () => {
  const { store, reader } = await heldBack("inflight");
  // a statement in flight in the held transaction, sent from this file
  const slow = reader.run("SELECT sum(a.range * b.range) FROM range(100000000) a, range(100000) b").then(() => "ended", (e: Error) => e.message);
  try {
    await assert.rejects(checkpoint(turns(), store, 1_000), (e: Error) => {
      assert.match(e.message, /FORCE CHECKPOINT waits/);
      assert.match(e.message, /1 other request\(s\) in flight on the engine, from: tests\/integration-checkpoint\.test\.ts:\d+\./);
      return true;
    });
  } finally {
    reader.interrupt();
    assert.match(await slow, /interrupt/i, "the statement was still running when the checkpoint gave up");
    reader.closeSync();
    await store.close();
  }
});

test("a checkpoint whose writer turn never comes fails within its limit and never runs once the turn comes", { timeout: 60_000 }, async () => {
  const sync = turns();
  let release!: () => void;
  const held = sync.onWriter(() => new Promise<void>((r) => { release = r; }));
  const ran: string[] = [];
  const store = { writer: { run: async (sql: string) => { ran.push(sql); return { rowsChanged: 0 }; }, interrupt: () => { ran.push("interrupt"); } } } as unknown as DuckStore;
  await assert.rejects(checkpoint(sync, store, 500), (e: Error) => {
    assert.match(e.message, /^the checkpoint did not end within 0\.5 s \(\d+ ms\)\. The writer's turn never came: the sync held it the whole time, and the checkpoint never ran\.\nThe engine's requests in flight could not be read/);
    return true;
  });
  release();
  await held;
  await sync.onWriter(async () => undefined);
  assert.deepEqual(ran, [], "the turn that came after the limit ran nothing");
});
