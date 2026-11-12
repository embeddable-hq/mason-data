/**
 * A SYNCED TABLE COMPACTED BY MASON ITSELF (issue 851; src/duck/compact.ts, src/duck/sync.ts `compact`, docs/DESIGN.md
 * "Compaction"). The checkpoint merges no row groups (issue 371), so a table written by key keeps its dead rows and a
 * table appended to across checkpoints keeps a row group per checkpoint. Offline, on a DuckDB file, at low thresholds
 * and a low memory limit: a table under steady churn, and one appended to through many checkpoints, each stay within
 * the bound the rule states; a compaction out of memory halves its pieces, and one whose single row does not fit fails
 * alone, the table served and the database valid; readers see the whole table the whole time; and a Sync compacts a
 * table it holds, says it on its state, and keeps its stored JSON view. tests/integration/duck-compact.itest.ts holds
 * the polled and the streamed table against a Postgres.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore, MASON_SCHEMA, pgErrorOf } from "../src/duck/store.ts";
import type * as compactModule from "../src/duck/compact.ts";
import { Sync, type AddedTable } from "../src/duck/sync.ts";
import type { Source } from "../src/cli/preflight.ts";
import type { DuckConnection } from "../src/duck/executor.ts";

// imported when the file loads, and nothing at a commit without the module: the file loads there, and each test
// fails by name (scripts/fails-without.ts), never "did not load"
const C: Partial<typeof compactModule> = await import("../src/duck/compact.ts").catch((e: unknown) => {
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e))) return {};
  throw e;
});
const need = <T>(x: T | undefined, name: string): T => { assert.ok(x !== undefined, `src/duck/compact.ts ${name}`); return x; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-compact-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const one = async (c: Pick<DuckConnection, "runAndReadAll">, sql: string): Promise<number> => Number((await c.runAndReadAll(sql)).getRowsJS()[0]![0]);
const rowsOf = (from: string, n: number): string => `SELECT ${from} + i, md5((${from} + i)::VARCHAR), (random() * 1000)::INT FROM range(${n}) r(i)`;

/** a store with public.t: `rows` rows written as a first sync writes them, then checkpointed */
async function aTable(name: string, rows: number, memoryLimit = "128MB"): Promise<DuckStore> {
  const store = await DuckStore.open(path.join(dir, `${name}.db`), () => undefined, { memoryLimit });
  await store.writer.run("CREATE TABLE public.t (id BIGINT NOT NULL, s VARCHAR, n INTEGER)");
  for (let i = 0; i < rows; i += 50_000) await store.writer.run(`INSERT INTO public.t ${rowsOf(String(i), Math.min(50_000, rows - i))}`);
  await store.writer.run("CHECKPOINT");
  return store;
}

/** the table compacted as the sync compacts it: the rewrite on a connection of its own, the swap on the writer */
async function compactNow(store: DuckStore, c: DuckConnection, live: number): Promise<void> {
  const shape = need(await need(C.readShape, "readShape")(c, "public", "t", live) ?? undefined, "a shape");
  await need(C.rewrite, "rewrite")(c, "public", "t", need(C.pieceRows, "pieceRows")(store.memoryLimitBytes, shape));
  await store.writer.run("BEGIN TRANSACTION");
  for (const sql of need(C.swapSql, "swapSql")("public", "t")) await store.writer.run(sql);
  await store.writer.run("COMMIT");
}

test("the rule: dead rows and row groups past the fewest, against the table's blocks; a piece is held to the memory limit", () => {
  const wasteOf = need(C.wasteOf, "wasteOf"), pieceRows = need(C.pieceRows, "pieceRows");
  const B = 262_144;
  // fresh: nothing to give back
  assert.equal(wasteOf({ live: 1_000_000, stored: 1_000_000, rowGroups: 9, blocks: 90, blockSize: B }).due, false);
  // half its stored rows deleted: due
  const dead = wasteOf({ live: 1_000_000, stored: 2_000_000, rowGroups: 17, blocks: 180, blockSize: B });
  assert.equal(dead.deadShare, 0.5);
  assert.equal(dead.due, true);
  // a third deleted: not yet
  assert.equal(wasteOf({ live: 1_000_000, stored: 1_500_000, rowGroups: 13, blocks: 135, blockSize: B }).due, false);
  // a row group per checkpoint: 100 k rows in 26 row groups of a block each (8 polled tables over 25 restarts, measured)
  const many = wasteOf({ live: 100_000, stored: 100_000, rowGroups: 26, blocks: 33, blockSize: B });
  assert.equal(many.extraRowGroups, 25);
  assert.equal(many.due, true);
  // a few row groups of large values (4,000 rows of 100 KB, 30 row groups, ~210 MiB): never rewritten for them
  assert.equal(wasteOf({ live: 4_000, stored: 4_000, rowGroups: 30, blocks: 840, blockSize: B }).due, false);
  // a small table: never rewritten for fewer than 16 blocks, however its share
  assert.equal(wasteOf({ live: 100, stored: 1_000, rowGroups: 3, blocks: 3, blockSize: B }).due, false);
  // a piece: an eighth of the limit over its rows' bytes on disk times 8, from one row to 8 row groups' rows
  assert.equal(pieceRows(128 * 2 ** 20, { stored: 4_000, blocks: 840, blockSize: B }), 38);
  assert.equal(pieceRows(8 * 2 ** 30, { stored: 4_000, blocks: 840, blockSize: B }), 2_438);
  assert.equal(pieceRows(128 * 2 ** 20, { stored: 100_000_000, blocks: 90, blockSize: B }), 8 * 122_880);
  assert.equal(pieceRows(16 * 2 ** 20, { stored: 1, blocks: 4_000, blockSize: B }), 1);
});

test("an append-only table through 200 checkpoints: its row groups and blocks stay within the bound, its rows whole", { timeout: 600_000 }, async () => {
  const store = await aTable("append", 200_000);
  const c = await store.instance.connect();
  try {
    const readShape = need(C.readShape, "readShape"), wasteOf = need(C.wasteOf, "wasteOf");
    let live = 200_000, compactions = 0, most = 0;
    const fresh = need(await readShape(c, "public", "t", live) ?? undefined, "a shape");
    for (let r = 0; r < 200; r++) {
      await store.writer.run(`INSERT INTO public.t ${rowsOf(String(1_000_000 + r * 20), 20)}`);
      live += 20;
      // the commit's checkpoint, as DuckDB takes one at 16 MiB of log and at every stop
      await store.writer.run("CHECKPOINT");
      const s = need(await readShape(c, "public", "t", live) ?? undefined, "a shape");
      most = Math.max(most, s.blocks);
      // the threshold low (a quarter, 8 blocks), so the bound is reached within the test
      if (wasteOf(s, { share: 0.25, minBlocks: 8 }).due) { await compactNow(store, c, live); compactions++; }
    }
    assert.ok(compactions >= 2, `compacted again and again: ${compactions}`);
    const end = need(await readShape(c, "public", "t", live) ?? undefined, "a shape");
    // without it: 200 row groups past its 2, a block each (226 blocks). With it: what is wasted is held under the
    // threshold, a quarter of the table's blocks or 8 blocks, and the extra row groups with it (a block or two of
    // rounding: a compacted table's last row group, the round that passes the threshold)
    assert.ok(most <= fresh.blocks + Math.max(8, Math.ceil(0.25 * most)) + 3, `its blocks at most ${most}, fresh ${fresh.blocks}`);
    assert.ok(end.rowGroups <= Math.ceil(live / 122_880) + 8 + 2, `row groups ${end.rowGroups}`);
    assert.equal(await one(c, "SELECT count(*) FROM public.t"), live);
    assert.equal(await one(c, "SELECT count(DISTINCT id) FROM public.t"), live);
  } finally { c.closeSync(); await store.close(); }
});

test("a table under steady churn by key: its stored rows stay under twice its live rows, its rows exact", { timeout: 600_000 }, async () => {
  const store = await aTable("churn", 300_000);
  const c = await store.instance.connect();
  try {
    const readShape = need(C.readShape, "readShape"), wasteOf = need(C.wasteOf, "wasteOf");
    const live = 300_000;
    let compactions = 0, most = 0, mostStored = 0;
    for (let r = 0; r < 40; r++) {
      // 5 % of the keys, scattered, written again by key as the poll and the stream write: their rows deleted, then
      // inserted (scattered, so no row group is ever wholly deleted, which the checkpoint drops by itself)
      await store.writer.run("BEGIN TRANSACTION");
      await store.writer.run(`DELETE FROM public.t WHERE hash(id, ${r}) % 20 = 0`);
      await store.writer.run(`INSERT INTO public.t SELECT id, md5(id::VARCHAR || ${r}), ${10_000 + r} FROM range(${live}) r(id) WHERE hash(id, ${r}) % 20 = 0`);
      await store.writer.run("COMMIT");
      await store.writer.run("CHECKPOINT");
      const s = need(await readShape(c, "public", "t", live) ?? undefined, "a shape");
      most = Math.max(most, s.blocks); mostStored = Math.max(mostStored, s.stored);
      if (wasteOf(s, { share: 0.5, minBlocks: 8 }).due) { await compactNow(store, c, live); compactions++; }
    }
    assert.ok(compactions >= 2, `compacted again and again: ${compactions}`);
    // a scan reads every stored row, the deleted ones too: held under about twice the live rows (one round past half)
    assert.ok(mostStored <= 2.2 * live, `stored rows at most ${mostStored} for ${live} live`);
    const end = need(await readShape(c, "public", "t", live) ?? undefined, "a shape");
    assert.ok(end.stored <= 2.2 * live, `stored ${end.stored}`);
    assert.equal(await one(c, "SELECT count(*) FROM public.t"), live);
    assert.equal(await one(c, "SELECT count(DISTINCT id) FROM public.t"), live);
    // each key's last write is the one kept
    assert.equal(await one(c, "SELECT count(*) FROM public.t WHERE n <> coalesce((SELECT max(10000 + r) FROM range(40) x(r) WHERE hash(id, r) % 20 = 0), n)"), 0);
    assert.ok(await one(c, "SELECT count(*) FROM public.t WHERE n >= 10000") > live / 2);
  } finally { c.closeSync(); await store.close(); }
});

test("a compaction out of memory: its pieces halve and it ends whole; one under a limit nothing fits in fails alone, the table served and the database valid", { timeout: 600_000 }, async () => {
  const store = await DuckStore.open(path.join(dir, "oom.db"), () => undefined, { memoryLimit: "32MB" });
  const crashed: string[] = [];
  store.onCrash((r) => crashed.push(r));
  const c = await store.instance.connect();
  try {
    const rewrite = need(C.rewrite, "rewrite");
    // ~100 KB of incompressible text a row, written a chunk a transaction as a first sync writes them (~40 MiB)
    await store.writer.run("CREATE TABLE public.t (id BIGINT, v VARCHAR)");
    for (let k = 0; k < 40; k++) await store.writer.run(`INSERT INTO public.t SELECT ${k * 10} + i, array_to_string(list_transform(range(3200), x -> md5(random()::VARCHAR || x)), '') FROM range(10) r(i)`);
    await store.writer.run("CHECKPOINT");
    const said: string[] = [];
    // the whole table asked as one piece at a limit under its size: a piece runs out, the next is half of it
    const done = await rewrite(c, "public", "t", 400, { said: (l) => said.push(l) });
    assert.equal(done.rows, 400);
    assert.ok(said.length > 0 && said.every((l) => /^a piece of its compaction ran out of memory: read on in pieces of \d+ row\(s\)$/.test(l)), said.join("\n"));
    await c.run(`DROP TABLE ${need(C.sideOf, "sideOf")("public", "t")}`);
    // a limit nothing fits in: the compaction fails alone, out of memory (a row alone that does not fit is said by name)
    await store.writer.run("SET memory_limit = '1MB'");
    await assert.rejects(rewrite(c, "public", "t", 400), (e: unknown) => e instanceof need(C.CompactTooLarge, "CompactTooLarge") ? /one row of it, read alone, ran out of memory/.test((e as Error).message)
      : pgErrorOf(e, "").fields.code === "53200");
    await store.writer.run("SET memory_limit = '32MB'");
    await c.run(`DROP TABLE IF EXISTS ${need(C.sideOf, "sideOf")("public", "t")}`);
    // the table serves, whole, and the database checkpoints and is valid
    assert.equal(await one(store.writer, "SELECT count(*) FROM public.t"), 400);
    assert.equal(await one(store.writer, "SELECT count(DISTINCT id) FROM public.t"), 400);
    await store.writer.run("CHECKPOINT");
    assert.deepEqual(crashed, []);
  } finally { c.closeSync(); await store.close(); }
  // and opened again, whole
  const again = await DuckStore.open(path.join(dir, "oom.db"), () => undefined, { memoryLimit: "128MB" });
  try { assert.equal(await one(again.writer, "SELECT count(*) FROM public.t"), 400); } finally { await again.close(); }
});

test("readers during a compaction and its swap see the whole table every time, never a missing table or half of one", { timeout: 600_000 }, async () => {
  const store = await aTable("readers", 400_000);
  // as a churn left it: a quarter deleted, written again
  await store.writer.run("BEGIN TRANSACTION");
  await store.writer.run("DELETE FROM public.t WHERE id % 4 = 0");
  await store.writer.run(`INSERT INTO public.t SELECT id, md5(id::VARCHAR), 5007 FROM range(400000) r(id) WHERE id % 4 = 0`);
  await store.writer.run("COMMIT");
  // a view of its columns in an attached catalog, as the stored JSON paths' view is made (src/duck/kept.ts)
  await store.writer.run("ATTACH IF NOT EXISTS ':memory:' AS visible_test");
  await store.writer.run("CREATE SCHEMA IF NOT EXISTS visible_test.public");
  await store.writer.run(`CREATE OR REPLACE VIEW visible_test.public.t AS SELECT id, s FROM "${path.basename(store.file, ".db")}".public.t`);
  const c = await store.instance.connect(), readers = await Promise.all([0, 1, 2].map(() => store.instance.connect()));
  const seen: string[] = [];
  let reading = true;
  const loops = readers.map(async (r, k) => {
    let reads = 0;
    while (reading) {
      try {
        const sql = k === 2 ? "SELECT count(*), count(DISTINCT id) FROM visible_test.public.t" : "SELECT count(*), count(DISTINCT id) FROM public.t";
        const [rows, ids] = (await r.runAndReadAll(sql)).getRowsJS()[0]!.map(Number) as [number, number];
        if (rows !== 400_000 || ids !== 400_000) seen.push(`${rows} rows, ${ids} ids`);
      } catch (e) { seen.push((e as Error).message.split("\n")[0]!); }
      reads++;
    }
    return reads;
  });
  try {
    for (let k = 0; k < 3; k++) await compactNow(store, c, 400_000);
    reading = false;
    const reads = await Promise.all(loops);
    assert.deepEqual(seen, []);
    assert.ok(reads.every((n) => n > 0), `each reader read: ${reads.join(", ")}`);
    assert.equal(await one(store.writer, "SELECT count(*) FROM public.t WHERE n = 5007"), 100_000);
  } finally { reading = false; await Promise.allSettled(loops); for (const r of [c, ...readers]) r.closeSync(); await store.close(); }
});

// ---------------------------------------------------------------------------------------------- the sync compacts

const columns = [{ name: "id", type: "bigint", notNull: true, comment: null }, { name: "s", type: "text", notNull: false, comment: null }, { name: "n", type: "integer", notNull: false, comment: null }];
const T: AddedTable = { source: "public.t", schema: "public", table: "t", key: ["id"], columns, foreignKeys: [], bytes: 0, rows: 200_000 };
// a source nothing listens on: a pass fails to attach it, and the compaction never reads it
const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;

test("the sync compacts a table its check finds due, one at a time and from the synced data alone: said, recorded, and its rows whole", { timeout: 600_000 }, async () => {
  const file = path.join(dir, "sync.db");
  const store = await DuckStore.open(file, () => undefined, { memoryLimit: "128MB" });
  const logged: string[] = [];
  try {
    const open = async (): Promise<Sync> => {
      const s = new Sync(store, source, "x", (l) => logged.push(l), 5_000, "poll", null, { compact: { firstCheckMs: 3_600_000, wasteShare: 0.3, minWasteBlocks: 4 } });
      await s.open();
      return s;
    };
    await (await open()).stop();
    const w = (sql: string) => store.writer.run(sql);
    await w("CREATE TABLE public.t (id BIGINT, s VARCHAR, n INTEGER)");
    await w(`INSERT INTO public.t ${rowsOf("0", 200_000)}`);
    await w(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.t', 'copied', 200000, 0, 3.5, now() - INTERVAL 2 HOUR, NULL, '${JSON.stringify(columns)}')`);
    await w(`INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.t', '100:100:', now() - INTERVAL 1 HOUR, 'off')`);
    // churned: half its rows written again by key
    await w("DELETE FROM public.t WHERE id % 2 = 0");
    await w("INSERT INTO public.t SELECT id, md5(id::VARCHAR), 5009 FROM range(200000) r(id) WHERE id % 2 = 0");
    await w("CHECKPOINT");
    // a side table a crash left: dropped at the open
    await w("CREATE TABLE public.t__mason_compact AS SELECT * FROM public.t LIMIT 3");
    const sync = await open();
    try {
      assert.ok(logged.some((l) => l.startsWith("dropped public.t__mason_compact: what a compaction cut short")), logged.join("\n"));
      assert.equal(await one(store.writer, "SELECT count(*) FROM duckdb_tables() WHERE table_name = 't__mason_compact'"), 0);
      await sync.setTables([T]);
      const storedBefore = await one(store.writer, "SELECT estimated_size FROM duckdb_tables() WHERE table_name = 't'");
      assert.ok(storedBefore >= 300_000, `stored ${storedBefore}`);
      await sync.checkCompaction();
      await sync.once();
      const st = sync.state()[0]!;
      assert.ok(st.compaction?.at, JSON.stringify(st.compaction));
      assert.equal(st.compaction?.error, null);
      assert.equal(st.compaction?.deadShare, 0);
      assert.ok(logged.some((l) => /^compacted public\.t in [\d.]+ s: 200,000 row\(s\) rewritten from \d[\d,]* stored \(\d+% deleted\) in \d+ row group\(s\), about .+ of .+ given back; its reads went on meanwhile$/.test(l)), logged.join("\n"));
      assert.equal(await one(store.writer, "SELECT estimated_size FROM duckdb_tables() WHERE table_name = 't'"), 200_000);
      assert.equal(await one(store.writer, "SELECT count(DISTINCT id) FROM public.t"), 200_000);
      assert.equal(await one(store.writer, "SELECT count(*) FROM public.t WHERE n = 5009"), 100_000);
      assert.equal(await one(store.writer, `SELECT "rows" FROM ${MASON_SCHEMA}.compactions WHERE source = 'public.t'`), 200_000);
      // read again: nothing left to give back, so nothing queued
      await sync.checkCompaction();
      assert.equal(sync.state()[0]!.rebuilding, undefined);
      assert.ok((sync.state()[0]!.compaction?.deadShare ?? 1) < 0.01);
    } finally { await sync.stop(); }
    // the next start reads when it was compacted
    const again = await open();
    try {
      await again.setTables([T]);
      assert.ok(again.state()[0]!.compaction?.at);
    } finally { await again.stop(); }
  } finally { await store.close(); }
});
