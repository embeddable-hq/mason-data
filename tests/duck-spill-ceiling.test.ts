/**
 * WHAT STATEMENTS MAY SPILL IS IN FORCE FROM THE OPEN (issue 850; src/duck/store.ts `spillCeiling`,
 * `instanceSettingsProblem`, issue 105). DuckDB 2.0 shows `max_temp_directory_size` given at the instance's creation and
 * does not enforce it: a store opened with `MASON_SPILL_LIMIT` 50MB read 47.0 MiB and let a statement spill 300 MB with
 * no 53400, and the ceiling was only put in force once the disk moved it 1 %. Offline, on a DuckDB file: the ceiling read
 * back right after the open, every setting the open gives read back, a statement past the ceiling refused 53400 where
 * the same statement completes under a higher one, and Mason's own compaction under a ceiling it meets: it fails alone,
 * the table served and the database valid.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore, pgErrorOf } from "../src/duck/store.ts";
import * as storeModule from "../src/duck/store.ts";
import * as C from "../src/duck/compact.ts";
import type { DuckConnection } from "../src/duck/executor.ts";

// read from the module, not imported by name: the file loads at a commit without its second argument
const { instanceSettingsProblem } = storeModule as unknown as { instanceSettingsProblem: (c: Pick<DuckConnection, "runAndReadAll">, settings?: Record<string, string>) => Promise<string | null> };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-spill-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const GiB = 2 ** 30;
const setting = async (c: Pick<DuckConnection, "runAndReadAll">, name: string): Promise<string> => String((await c.runAndReadAll(`SELECT current_setting('${name}')`)).getRowsJS()[0]![0]);

/** a sort of ~2.5 M rows of 64-character strings: past 64MB of memory it spills about 100–200 MB */
const SPILLS = "SELECT s FROM (SELECT md5(i::VARCHAR) || md5((i + 1)::VARCHAR) AS s FROM range(2500000) t(i)) ORDER BY s LIMIT 1 OFFSET 2000000";

/** the most the spill's folder held while `f` ran, in bytes (sampled every 20 ms) */
async function spilledWhile(store: DuckStore, f: () => Promise<void>): Promise<number> {
  let most = 0;
  const folder = `${store.file}.tmp`;
  const sample = (): void => {
    let bytes = 0;
    // the folder is made at the first spill, and its files come and go as the statement runs
    try { for (const name of fs.readdirSync(folder)) { try { bytes += fs.statSync(path.join(folder, name)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } } }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    most = Math.max(most, bytes);
  };
  const timer = setInterval(sample, 20);
  try { await f(); } finally { clearInterval(timer); sample(); }
  return most;
}

test("the spill's ceiling is set at the open and read back right after it, with every setting the open gives", async () => {
  const store = await DuckStore.open(path.join(dir, "read-back.db"), () => undefined, { memoryLimit: "100MB", spillLimit: "50MB", diskFree: () => 8 * GiB });
  try {
    // MASON_SPILL_LIMIT=50MB is 47 MiB (whole MiB, down)
    assert.equal(await setting(store.writer, "max_temp_directory_size"), "47.0 MiB");
    // every setting given read back as the engine reads it: an amount to the rounding of its text (100MB shows 95.3 MiB)
    assert.equal(await setting(store.writer, "memory_limit"), "95.3 MiB");
    assert.equal(await instanceSettingsProblem(store.writer, { memory_limit: "100MB", temp_directory: `${store.file}.tmp`, max_temp_directory_size: "47MiB", force_compression: "zstd", max_vacuum_tasks: "0" }), null);
    // a setting that is not what was given is named, with what the engine runs with
    await store.writer.run("SET GLOBAL max_temp_directory_size = '1GiB'");
    assert.equal(await instanceSettingsProblem(store.writer, { max_temp_directory_size: "47MiB" }),
      "the engine runs with max_temp_directory_size = 1.0 GiB, not 47MiB: statements could spill past MASON_SPILL_LIMIT (or half of what is free) and fill the disk (Mason bug: report it)");
    assert.equal(await instanceSettingsProblem(store.writer, { memory_limit: "200MB" }), "the engine runs with memory_limit = 95.3 MiB, not 200MB (Mason bug: report it)");
    assert.equal(await instanceSettingsProblem(store.writer, { memory_limit: "101MB" }), "the engine runs with memory_limit = 95.3 MiB, not 101MB (Mason bug: report it)");
    assert.equal(await instanceSettingsProblem(store.writer, { force_compression: "auto" }), "the engine runs with force_compression = zstd, not auto (Mason bug: report it)");
  } finally { await store.close(); }
  // the default (half of what is free) is set at the open too, and an amount that rounds in its text still holds
  const half = await DuckStore.open(path.join(dir, "read-back-default.db"), () => undefined, { memoryLimit: "8GB", diskFree: () => 3 * GiB });
  try {
    assert.equal(await setting(half.writer, "max_temp_directory_size"), "1.5 GiB");
    assert.equal(await setting(half.writer, "memory_limit"), "7.4 GiB");
    assert.equal(await instanceSettingsProblem(half.writer, { memory_limit: "8GB" }), null);
  } finally { await half.close(); }
});

test("a statement that spills past the ceiling in force from the open is 53400 with the way out; under a higher one the same statement completes", { timeout: 300_000 }, async () => {
  const roomy = await DuckStore.open(path.join(dir, "roomy.db"), () => undefined, { memoryLimit: "64MB", spillLimit: "2GiB", diskFree: () => 8 * GiB });
  let spilled: number;
  try {
    spilled = await spilledWhile(roomy, async () => { await roomy.writer.runAndReadAll(SPILLS); });
  } finally { await roomy.close(); }
  assert.ok(spilled > 60 * 2 ** 20, `the statement spills past the low ceiling where there is room: ${spilled} bytes`);
  const low = await DuckStore.open(path.join(dir, "low.db"), () => undefined, { memoryLimit: "64MB", spillLimit: "30MB", diskFree: () => 8 * GiB });
  const crashed: string[] = [];
  low.onCrash((r) => crashed.push(r));
  try {
    let failure: unknown = null;
    const most = await spilledWhile(low, async () => { try { await low.writer.runAndReadAll(SPILLS); } catch (e) { failure = e; } });
    assert.ok(failure !== null, `the statement completed past a ceiling of 30MB, spilling ${most} bytes`);
    const e = pgErrorOf(failure, SPILLS);
    assert.equal(e.fields.code, "53400", String(failure));
    assert.equal(e.gap, "spill-limit");
    assert.match(e.fields.hint ?? "", /MASON_SPILL_LIMIT/);
    assert.ok(most <= 30 * 2 ** 20 + 4 * 2 ** 20, `the spill stayed under the ceiling: ${most} bytes`);
    // the statement failed alone: the store answers, and nothing it spilled is left
    assert.equal(String((await low.writer.runAndReadAll("SELECT 1")).getRowsJS()[0]![0]), "1");
    assert.equal(String((await low.writer.runAndReadAll("SELECT count(*) FROM duckdb_temporary_files()")).getRowsJS()[0]![0]), "0");
    assert.deepEqual(crashed, []);
  } finally { await low.close(); }
});

/** a store at 32MB with public.t: ~100 KB of incompressible text a row, written a chunk a transaction as a first sync
 *  writes them (~40 MiB), checkpointed */
async function wideTable(file: string, spillLimit: string): Promise<DuckStore> {
  const store = await DuckStore.open(file, () => undefined, { memoryLimit: "32MB", spillLimit, diskFree: () => 8 * GiB });
  await store.writer.run("CREATE TABLE public.t (id BIGINT, v VARCHAR)");
  for (let k = 0; k < 40; k++) await store.writer.run(`INSERT INTO public.t SELECT ${k * 10} + i, array_to_string(list_transform(range(3200), x -> md5(random()::VARCHAR || x)), '') FROM range(10) r(i)`);
  await store.writer.run("CHECKPOINT");
  return store;
}

test("Mason's compaction under the spill's ceiling: in its own pieces it completes under 16MiB; under a ceiling it meets it fails alone, never fatally, the table served and the database valid", { timeout: 600_000 }, async () => {
  // measured (DuckDB 2.0.0, 32MB): pieces of the memory's eighth (8 rows) spilled ~1.5 MiB and completed under 16 and
  // 64 MiB; under 1 MiB they failed 53400 at once, as did one piece of the whole table under 16 MiB (~15 MiB spilled)
  const fits = await wideTable(path.join(dir, "compact-fits.db"), "16MiB");
  const c = await fits.instance.connect();
  try {
    const shape = (await C.readShape(c, "public", "t", 400))!;
    const most = await spilledWhile(fits, async () => { assert.equal((await C.rewrite(c, "public", "t", C.pieceRows(fits.memoryLimitBytes, shape))).rows, 400); });
    assert.ok(most <= 16 * 2 ** 20, `${most} bytes spilled`);
  } finally { c.closeSync(); await fits.close(); }

  const file = path.join(dir, "compact-meets.db");
  const store = await wideTable(file, "1MiB");
  const crashed: string[] = [];
  store.onCrash((r) => crashed.push(r));
  const d = await store.instance.connect();
  try {
    const shape = (await C.readShape(d, "public", "t", 400))!;
    // a compaction's failure is the sync's to say and back off from (src/duck/sync.ts `compact`): it reaches it as 53400
    await assert.rejects(C.rewrite(d, "public", "t", C.pieceRows(store.memoryLimitBytes, shape)), (e: unknown) => pgErrorOf(e, "").fields.code === "53400");
    await d.run(`DROP TABLE IF EXISTS ${C.sideOf("public", "t")}`);
    assert.equal(String((await store.writer.runAndReadAll("SELECT count(*) FROM public.t")).getRowsJS()[0]![0]), "400");
    await store.writer.run("CHECKPOINT");
    assert.deepEqual(crashed, []);
  } finally { d.closeSync(); await store.close(); }
  const again = await DuckStore.open(file, () => undefined, { memoryLimit: "128MB" });
  try { assert.equal(String((await again.writer.runAndReadAll("SELECT count(DISTINCT id) FROM public.t")).getRowsJS()[0]![0]), "400"); } finally { await again.close(); }
});
