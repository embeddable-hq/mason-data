/**
 * A COMPACTION STOPS BEFORE THE PIECE THAT HAS NO ROOM ON DISK (issue 851's review; src/duck/compact.ts `rewrite`'s
 * `room`, src/duck/sync.ts `diskShortFor`): on a nearly full volume, a rewrite with no such check filled the disk at a
 * commit's checkpoint and the synced data was invalidated. Here the room runs out after the first piece: the rewrite
 * stops there, by name, the table served whole and the store checkpointing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import type * as compactModule from "../src/duck/compact.ts";

const C: Partial<typeof compactModule> = await import("../src/duck/compact.ts").catch((e: unknown) => {
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e))) return {};
  throw e;
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-compact-room-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the disk's room is asked before every piece: none left stops the compaction there, the table whole and the store valid", async () => {
  assert.ok(C.rewrite !== undefined && C.CompactNoRoom !== undefined, "src/duck/compact.ts rewrite, CompactNoRoom");
  const store = await DuckStore.open(path.join(dir, "room.db"), () => undefined, { memoryLimit: "128MB" });
  const crashed: string[] = [];
  store.onCrash((r) => crashed.push(r));
  const c = await store.instance.connect();
  try {
    await store.writer.run("CREATE TABLE public.t AS SELECT range AS id, md5(range::VARCHAR) AS s FROM range(100000)");
    const asked: number[] = [];
    await assert.rejects(C.rewrite(c, "public", "t", 30_000, { room: (left) => { asked.push(left); return asked.length > 1 ? "it needs 90 MiB free on disk to be compacted, and 10 MiB is free" : null; } }),
      (e: unknown) => e instanceof C.CompactNoRoom! && (e as Error).message === "it needs 90 MiB free on disk to be compacted, and 10 MiB is free");
    assert.deepEqual(asked.map((x) => Math.round(x * 10) / 10), [1, 0.7], "asked with the share of rows left to write, before each piece");
    assert.equal(Number((await store.writer.runAndReadAll("SELECT count(*) FROM public.t")).getRowsJS()[0]![0]), 100_000);
    await store.writer.run("CHECKPOINT");
    assert.deepEqual(crashed, []);
  } finally { c.closeSync(); await store.close(); }
});
