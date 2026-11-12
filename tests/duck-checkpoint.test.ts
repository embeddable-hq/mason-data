/**
 * NO CHECKPOINT MERGES A SYNCED TABLE'S ROW GROUPS (issue 371; src/duck/store.ts INSTANCE_SETTINGS `max_vacuum_tasks`,
 * docs/DESIGN.md "No checkpoint merges row groups"). A first sync commits a table of large values as many small row
 * groups, one or a few a chunk; DuckDB's checkpoint used to merge them into 122,880-row groups holding their values at
 * once, and one that did not fit the memory limit (or the spill's ceiling) failed INSIDE the checkpoint, which
 * invalidates the whole database — on a real deployment, every table's first sync failed after it, and every restart
 * that resumed the sync met it again. Offline here: the copy's write pattern (one committed transaction of ~100 KB
 * values a chunk) at a low memory limit, then a checkpoint. tests/integration/duck-poll.itest.ts holds the real first
 * syncs (a wide table among five, and one heap page of 100 KB values a chunk) against a Postgres.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import * as storeModule from "../src/duck/store.ts";
import type { DuckConnection } from "../src/duck/executor.ts";

// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
const { instanceSettingsProblem } = storeModule as unknown as { instanceSettingsProblem?: (c: Pick<DuckConnection, "runAndReadAll">) => Promise<string | null> };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-checkpoint-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** ~100 KB of incompressible text a row (md5s), `rows` rows a transaction from `first`: one chunk of a copy */
const chunkSql = (first: number, rows: number): string =>
  `INSERT INTO public.wide SELECT ${first} + i, array_to_string(list_transform(range(3200), x -> md5(random()::VARCHAR || x)), '') FROM range(${rows}) r(i)`;
const CHUNKS = 16, ROWS = 136;

/** the copy's write pattern: a transaction a chunk, each committed (a commit may run DuckDB's own checkpoint) */
async function writeChunks(store: DuckStore): Promise<void> {
  await store.writer.run("CREATE TABLE public.wide (id BIGINT, v VARCHAR)");
  for (let c = 0; c < CHUNKS; c++) {
    await store.writer.run("BEGIN TRANSACTION");
    await store.writer.run(chunkSql(c * ROWS, ROWS));
    await store.writer.run("COMMIT");
  }
}

test("a store's checkpoints never merge row groups: max_vacuum_tasks reads 0, and a store that does not hold it is refused", async () => {
  const store = await DuckStore.open(path.join(dir, "settings.db"), () => undefined, { memoryLimit: "64MB" });
  const c = await store.instance.connect();
  try {
    assert.equal(String((await c.runAndReadAll("SELECT current_setting('max_vacuum_tasks')")).getRowsJS()[0]![0]), "0");
    assert.equal(typeof instanceSettingsProblem, "function", "the open reads the settings back");
    assert.equal(await instanceSettingsProblem!(c), null);
    await c.run("SET GLOBAL max_vacuum_tasks = 100");
    assert.equal(await instanceSettingsProblem!(c), "the engine runs with max_vacuum_tasks = 100, not 0: a checkpoint could merge a synced table's row groups past the memory and invalidate the synced data (Mason bug: report it)");
  } finally { c.closeSync(); await store.close(); }
});

test("small committed chunks of ~100 KB values, then a checkpoint, at 64MB: the synced data stays valid and whole", { timeout: 300_000 }, async () => {
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "chunks.db"), (l) => logged.push(l), { memoryLimit: "64MB" });
  const crashed: string[] = [];
  store.onCrash((r) => crashed.push(r));
  try {
    await writeChunks(store);
    const groups = Number((await store.writer.runAndReadAll("SELECT count(DISTINCT row_group_id) FROM pragma_storage_info('public.wide')")).getRowsJS()[0]![0]);
    assert.ok(groups > 1, `the chunks are row groups of their own: ${groups}`);
    // the test's checkpoint (Mason runs none of its own): the one DuckDB runs at a commit, forced
    await store.writer.run("CHECKPOINT");
    assert.equal(String((await store.writer.runAndReadAll("SELECT count(*) FROM public.wide")).getRowsJS()[0]![0]), String(CHUNKS * ROWS));
    assert.deepEqual(crashed, [], logged.join("\n"));
  } finally { await store.close(); }
});

test("a store a merging checkpoint invalidated opens again, its committed rows whole, and checkpoints", { timeout: 300_000 }, async () => {
  const file = path.join(dir, "stuck.db");
  const logged: string[] = [];
  {
    // the release before: its checkpoints merged row groups, and one that did not fit invalidated the database
    const store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
    const crashed: string[] = [];
    store.onCrash((r) => crashed.push(r));
    try {
      await store.writer.run("SET GLOBAL max_vacuum_tasks = 100");
      await assert.rejects(async () => { await writeChunks(store); await store.writer.run("CHECKPOINT"); }, /fatal error|FATAL Error/);
      for (const t = Date.now(); crashed.length === 0; await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t > 10_000) throw new Error(`not invalidated\n${logged.join("\n")}`);
      assert.match(crashed[0]!, /Failed to create checkpoint because of error: failed to (pin|offload)/, "the merge's own failure");
    } finally { await store.close(); }
  }
  // opened again, as the restart opens it: what committed is there, and the checkpoint that failed now succeeds
  const store = await DuckStore.open(file, (l) => logged.push(l), { memoryLimit: "64MB" });
  const crashed: string[] = [];
  store.onCrash((r) => crashed.push(r));
  try {
    const rows = Number((await store.writer.runAndReadAll("SELECT count(*) FROM public.wide")).getRowsJS()[0]![0]);
    assert.ok(rows > 0 && rows % ROWS === 0, `whole chunks, as committed: ${rows}`);
    await store.writer.run("CHECKPOINT");
    assert.equal(Number((await store.writer.runAndReadAll("SELECT count(*) FROM public.wide")).getRowsJS()[0]![0]), rows);
    assert.deepEqual(crashed, [], logged.join("\n"));
  } finally { await store.close(); }
});
