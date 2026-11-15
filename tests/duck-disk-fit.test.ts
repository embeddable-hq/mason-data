/**
 * WILL A TABLE FIT ON DISK, ASKED BEFORE ITS SYNC (issue 1075; src/duck/disk-fit.ts): the estimate of a table's synced
 * size from the source's catalog alone, the one decision against the free disk less the room kept beside it, and the
 * words every entrance says. The calibration's numbers (docs/DESIGN.md "What a synced table takes on disk") are held
 * here too, so a change of `STORED_SHARE` is read against what was measured.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type * as Fit from "../src/duck/disk-fit.ts";

// imported when the tests run, not at load: the file loads at a commit without the module (scripts/fails-without.ts)
const fit = async (): Promise<typeof Fit> => await import("../src/duck/disk-fit.ts" as string) as typeof Fit;

const MiB = 2 ** 20, GiB = 2 ** 30;
const col = (name: string, width: number | null, toastable = false) => ({ name, type: toastable ? "text" : "bigint", notNull: false, comment: null, width, toastable });

test("the estimate reads the table's size without its indexes, the share its columns hold by width, its out-of-line bytes by count, at STORED_SHARE", async () => {
  const F = await fit();
  // every column: the table's bytes without indexes, at the ratio
  const t = { bytes: 300 * MiB, tableBytes: 200 * MiB, toastBytes: 0, columns: [col("id", 8), col("amount", 8), col("note", 84, true)] };
  assert.equal(F.syncedEstimate(t, null), Math.round(200 * MiB * F.STORED_SHARE));
  // a subset by width: id and amount are 16 of 100 bytes a row
  assert.equal(F.syncedEstimate(t, ["id", "amount"]), Math.round(200 * MiB * 0.16 * F.STORED_SHARE));
  // exclude is the rest of the columns
  assert.equal(F.syncedEstimate(t, null, ["note"]), F.syncedEstimate(t, ["id", "amount"]));
  // out of line: its width is a pointer's, so its TOAST bytes go by count among the columns that can be stored there
  const docs = { bytes: 1100 * MiB, tableBytes: 1000 * MiB, toastBytes: 900 * MiB, columns: [col("id", 8), col("a", 18, true), col("b", 18, true)] };
  // in line, id is 8 of 44 bytes; out of line, it holds none of the two toastable columns
  assert.equal(F.syncedEstimate(docs, ["id"]), Math.round((100 * MiB * (8 / 44)) * F.STORED_SHARE));
  // one of the two out-of-line columns: half the TOAST bytes, and its in-line share
  assert.equal(F.syncedEstimate(docs, ["id", "a"]), Math.round((100 * MiB * (26 / 44) + 900 * MiB / 2) * F.STORED_SHARE));
  // never analysed (no width): by column count
  const fresh = { bytes: 30 * MiB, tableBytes: 30 * MiB, toastBytes: 0, columns: [col("id", null), col("a", null), col("b", null)] };
  assert.equal(F.syncedEstimate(fresh, ["id"]), Math.round(30 * MiB / 3 * F.STORED_SHARE));
  // an older catalog with no size without indexes: its size with them, larger, so it errs to warning
  assert.equal(F.syncedEstimate({ bytes: 50 * MiB, columns: [col("id", 8)] }, null), Math.round(50 * MiB * F.STORED_SHARE));
});

// THE CALIBRATION (DuckDB 2.0, ZSTD forced; Postgres 16; synthetic tables synced by the real sync): pg_table_size and
// what the synced table took on disk after a checkpoint, the largest run of each shape: 1,000,000 rows (random text,
// jsonb, uuids, the mixed table), else 400,000 (40,000 for the two out-of-line ones). STORED_SHARE is above every shape
// but the uuids.
const MEASURED: Array<[shape: string, tableBytes: number, syncedBytes: number]> = [
  ["integers, timestamps, dates", 27_336_704, 5_499_679],
  ["random text", 141_320_192, 56_093_273],
  ["repeated words", 64_618_496, 7_072_386],
  ["jsonb", 248_340_480, 34_859_767],
  ["numerics", 24_141_824, 4_450_982],
  ["low-cardinality text", 24_141_824, 6_023_929],
  ["random text out of line", 113_549_312, 45_345_244],
  ["text Postgres compressed in line", 6_004_736, 2_353_912],
  ["a mixed orders table", 127_082_496, 20_179_784],
  ["uuids", 68_313_088, 35_384_097],
];

test("STORED_SHARE against what was measured: at or above every shape but uuids, which it under-estimates by under a quarter", async () => {
  const F = await fit();
  for (const [shape, tableBytes, synced] of MEASURED) {
    const estimate = F.syncedEstimate({ bytes: tableBytes, tableBytes, toastBytes: 0, columns: [col("id", 8)] }, null);
    if (shape === "uuids") assert.ok(estimate >= synced * 0.75 && estimate < synced, `${shape}: ${estimate} against ${synced}`);
    else assert.ok(estimate >= synced, `${shape}: the estimate ${estimate} is under the ${synced} measured`);
  }
});

test("the decision: the estimate fits in what is free less the room kept for queries and the first syncs under way", async () => {
  const F = await fit();
  const room = { freeBytes: 18 * GiB, reserveBytes: 9 * GiB, spillSet: false, pendingBytes: 0 };
  assert.equal(F.diskFit("public.events", 9 * GiB, room, false).fits, true, "exactly the room left fits");
  assert.equal(F.diskFit("public.events", 9 * GiB + 1, room, false).fits, false);
  assert.equal(F.diskFit("public.events", 6 * GiB, { ...room, pendingBytes: 4 * GiB }, false).fits, false, "a first sync under way takes its share");
  assert.deepEqual(F.diskFit("public.events", 30 * GiB, room, true),
    { table: "public.events", estimateBytes: 30 * GiB, freeBytes: 18 * GiB, reserveBytes: 9 * GiB, pendingBytes: 0, spillSet: false, resync: true, fits: false });
  assert.equal(F.roomFor(F.diskFit("t", 1, { ...room, pendingBytes: 20 * GiB }, false)), 0, "never under 0");
});

test("the words of a table that likely won't fit: the estimate, what is free, the room for queries, a re-sync's old data; and the note of one added anyway", async () => {
  const F = await fit();
  const f = F.diskFit("public.events", 30 * GiB, { freeBytes: 18 * GiB, reserveBytes: 9 * GiB, spillSet: false, pendingBytes: 0 }, false);
  assert.deepEqual(F.diskShortWords(f), {
    message: "public.events likely won't fit on disk: it needs about 30.0 GiB, and 9.0 GiB is free for it",
    why: "Its synced data would need about 30.0 GiB on disk, estimated from the database's catalog. 18.0 GiB is free where the synced data is. " +
      "Mason keeps 9.0 GiB of it for queries that spill to disk (half of what is free; MASON_SPILL_LIMIT sets it).",
    fix: "Choose fewer columns, or give Mason more disk. Or go ahead anyway: a sync that runs short of disk stops before the disk fills, and keeps the rows it has.",
    shortage: { code: "disk_short", neededBytes: 30 * GiB, freeBytes: 18 * GiB, reserveBytes: 9 * GiB, pendingBytes: 0, estimated: true },
  });
  // a re-sync, a first sync under way, MASON_SPILL_LIMIT set
  const g = F.diskFit("public.events", 12 * GiB, { freeBytes: 18 * GiB, reserveBytes: 4 * GiB, spillSet: true, pendingBytes: 3 * GiB }, true);
  assert.equal(F.diskShortWords(g).why, "Its synced data would need about 12.0 GiB on disk, estimated from the database's catalog. " +
    "Its synced data now stays on disk until the new sync is done, so both are on disk at once. 18.0 GiB is free where the synced data is. " +
    "The first syncs under way need about 3.0 GiB of it. Mason keeps 4.0 GiB of it for queries that spill to disk (MASON_SPILL_LIMIT).");
  assert.equal(F.diskShortWords(g).message, "public.events likely won't fit on disk: it needs about 12.0 GiB, and 11.0 GiB is free for it");
  // a replica's: whether the setting is set is not known
  assert.match(F.diskShortWords({ ...g, spillSet: null }).why, /\(half of what is free, or MASON_SPILL_LIMIT\)\.$/);
  assert.equal(F.diskFitNote(f), "it likely won't fit on disk: it needs about 30.0 GiB, and 9.0 GiB is free for it, beside 9.0 GiB kept for queries that spill to disk");
  // the bytes as the sync has always said them
  assert.deepEqual([F.humanBytes(512), F.humanBytes(1536), F.humanBytes(3 * MiB), F.humanBytes(2 * 1024 * GiB)], ["512 B", "1.5 KiB", "3.0 MiB", "2.0 TiB"]);
});

test("a shortage as numbers, from the function that says its words: the estimate's (diskShortWords) and the sync's measured one (syncShortWords); an event's stored one read back whole or not at all", async () => {
  const F = await fit();
  const f = F.diskFit("public.events", 30 * GiB, { freeBytes: 18 * GiB, reserveBytes: 9 * GiB, spillSet: false, pendingBytes: 2 * GiB }, false);
  assert.deepEqual(F.diskShortWords(f).shortage, { code: "disk_short", neededBytes: 30 * GiB, freeBytes: 18 * GiB, reserveBytes: 9 * GiB, pendingBytes: 2 * GiB, estimated: true });
  const e = F.syncShortWords("public.big", { neededBytes: 5 * GiB + 0.4, freeBytes: GiB, reserveBytes: 512 * MiB, file: "/data/.mason/duck.db", pagesRead: 10, pages: 900, addedBytes: 50 * MiB });
  assert.ok(e instanceof F.DiskShortError && e instanceof Error);
  assert.equal(e.code, "disk_short", "the code the sync's event records (src/duck/sync.ts passes it with the numbers)");
  assert.equal(e.message, "public.big no longer fits on disk: its sync needs about 5.0 GiB more, and 1.0 GiB is free (where /data/.mason/duck.db is; 10 of 900 pages read, 50.0 MiB added): " +
    "free some disk, mason remove public.big, or mason add public.big --columns … with fewer columns");
  assert.deepEqual(e.shortage, { code: "disk_short", neededBytes: 5 * GiB, freeBytes: GiB, reserveBytes: 512 * MiB, pendingBytes: 0, estimated: false });
  assert.equal(F.shortageWarning("public.events", F.shortageOf(f)), "public.events was added though it likely won't fit on disk: it needs about 30.0 GiB, and 7.0 GiB is free for it, beside 9.0 GiB kept for queries that spill to disk");
  const { shortageOfText } = await import("../src/duck/events.ts" as string) as typeof import("../src/duck/events.ts");
  assert.deepEqual(shortageOfText(JSON.stringify(e.shortage)), e.shortage);
  for (const bad of ["not json", "null", JSON.stringify({ ...e.shortage, code: "other" }), JSON.stringify({ ...e.shortage, freeBytes: "1" }), JSON.stringify({ ...e.shortage, estimated: undefined })]) {
    assert.equal(shortageOfText(bad), undefined, bad);
  }
});
