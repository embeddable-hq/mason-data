/**
 * WHICH TABLE IS COPIED FIRST, AND HOW BIG A CHUNK IS (src/duck/sync.ts copyOrder, chunkPages; the test server: three
 * small tables waited the 23 minutes of a 196 M-row table's copy before they were current). The smallest first by the
 * catalog's row estimate, unknown last, ties by bytes then name; a chunk about COPY_CHUNK_ROWS rows by the estimate,
 * bounded in pages. tests/integration/duck-poll.itest.ts holds the sync to both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as syncModule from "../src/duck/sync.ts";

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
type Sized = { source: string; rows: number | null; bytes: number };
const { copyOrder, chunkPages, COPY_CHUNK_ROWS } = syncModule as unknown as {
  copyOrder: <T extends Sized>(tables: readonly T[]) => T[]; chunkPages: (pages: number, rows: number | null, target?: number) => number; COPY_CHUNK_ROWS: number;
};

test("tables are copied smallest first by the row estimate, an unknown estimate last, ties by bytes then by name", () => {
  const t = (source: string, rows: number | null, bytes: number): Sized => ({ source, rows, bytes });
  const order = copyOrder([t("public.events", 196_000_000, 28e9), t("public.unknown", null, 10), t("public.users", 15_000, 4e6),
    t("public.b_plans", 776, 90_000), t("public.a_plans", 776, 90_000), t("public.tiny", 776, 1_000), t("public.orders", 22_000_000, 3e9),
    t("public.never_analysed", -1, 5)]).map((x) => x.source);
  assert.deepEqual(order, ["public.tiny", "public.a_plans", "public.b_plans", "public.users", "public.orders", "public.events", "public.never_analysed", "public.unknown"]);
});

test("a chunk is about COPY_CHUNK_ROWS rows by the estimate, at least a page, at most a bounded number of pages", () => {
  // the test server's table: 196 M rows over ~3.4 M pages (~57 a page): ~35,000 pages a chunk
  assert.equal(chunkPages(3_400_000, 196_000_000), Math.round(COPY_CHUNK_ROWS / (196_000_000 / 3_400_000)));
  assert.equal(chunkPages(75_000, 3_000_000, 1_000_000), 25_000, "a target of its own");
  assert.equal(chunkPages(10, 1_000_000_000), 1, "never less than a page");
  const most = chunkPages(1, null);
  assert.equal(chunkPages(10_000_000, 1_000), most, "a wide heap (few rows a page) is bounded in pages");
  assert.equal(chunkPages(0, 100), most, "a table with no pages yet reads in one open-ended chunk");
  assert.ok(most * 8192 <= 2 ** 30, "at most 1 GiB of heap a chunk");
});

// CHUNKS READ N AT A TIME: they commit out of order, each recorded by its page range, so a copy that died
// continues with exactly the ranges no chunk committed — never one read twice, never one skipped.
type Range = { first: number; end: number | null };
const { chunksToRead, readThrough, copyParallelOf, COPY_PARALLEL } = syncModule as unknown as {
  chunksToRead: (pages: number, size: number, done: readonly Range[]) => Range[]; readThrough: (done: readonly Range[]) => number | null;
  copyParallelOf: (env: NodeJS.ProcessEnv) => number; COPY_PARALLEL: number;
};

test("a copy's chunks left to read are every range no committed chunk covers, the heap's last one open-ended", () => {
  assert.deepEqual(chunksToRead(25, 10, []), [{ first: 0, end: 10 }, { first: 10, end: 20 }, { first: 20, end: null }]);
  assert.deepEqual(chunksToRead(20, 10, []), [{ first: 0, end: 10 }, { first: 10, end: null }], "a last chunk that ends at the count is open-ended");
  assert.deepEqual(chunksToRead(0, 10, []), [{ first: 0, end: null }], "an empty heap: one open-ended chunk");
  // committed out of order: 10–20 and 30–40 in, 0–10 and 20–30 were in flight when it died
  const done = [{ first: 30, end: 40 }, { first: 10, end: 20 }];
  assert.deepEqual(chunksToRead(45, 10, done), [{ first: 0, end: 10 }, { first: 20, end: 30 }, { first: 40, end: null }]);
  // the open-ended chunk committed before a gap closed: only the gap is left
  assert.deepEqual(chunksToRead(45, 10, [{ first: 0, end: 10 }, { first: 40, end: null }]), [{ first: 10, end: 20 }, { first: 20, end: 30 }, { first: 30, end: 40 }]);
  // a resumed copy whose chunk size changed (the estimate moved): the gaps are cut at their own ends, never past them
  assert.deepEqual(chunksToRead(45, 7, done), [{ first: 0, end: 7 }, { first: 7, end: 10 }, { first: 20, end: 27 }, { first: 27, end: 30 }, { first: 40, end: null }]);
  assert.deepEqual(chunksToRead(45, 10, [{ first: 0, end: 20 }, { first: 20, end: null }]), [], "every page read: nothing left");
  // every page in exactly one range, committed or left
  const all = [...done, ...chunksToRead(45, 10, done)].sort((a, b) => a.first - b.first);
  for (let i = 1; i < all.length; i++) assert.equal(all[i]!.first, all[i - 1]!.end, "contiguous, none overlapping");
});

test("a copy is read through the first gap in its committed chunks, or whole once the open-ended one is reached", () => {
  assert.equal(readThrough([]), 0);
  assert.equal(readThrough([{ first: 10, end: 20 }]), 0, "page 0's chunk not in: read through nothing");
  assert.equal(readThrough([{ first: 10, end: 20 }, { first: 0, end: 10 }, { first: 30, end: 40 }]), 20, "moves when a gap closes, stops at the next");
  assert.equal(readThrough([{ first: 0, end: 10 }, { first: 10, end: null }]), null);
  assert.equal(readThrough([{ first: 0, end: 10 }, { first: 20, end: null }]), 10, "the open-ended chunk past a gap: not whole");
});

test("MASON_COPY_PARALLEL is a number of readers from 1 to 8, 3 when unset, and anything else is refused with the way out", () => {
  assert.equal(COPY_PARALLEL, 3);
  assert.equal(copyParallelOf({}), 3);
  assert.equal(copyParallelOf({ MASON_COPY_PARALLEL: "" }), 3);
  assert.equal(copyParallelOf({ MASON_COPY_PARALLEL: "1" }), 1);
  assert.equal(copyParallelOf({ MASON_COPY_PARALLEL: "8" }), 8);
  for (const bad of ["0", "9", "2.5", "-1", "three", "1e1"]) {
    assert.throws(() => copyParallelOf({ MASON_COPY_PARALLEL: bad }), (e: Error) => e.message === `MASON_COPY_PARALLEL=${JSON.stringify(bad)} is not a number of readers from 1 to 8: ` +
      "each reads a first sync's chunks on a backend of the database's own, so set it to 1 (one at a time, the lightest on the database) up to 8, or unset it for 3", bad);
  }
});

// CHUNKS SIZED BY THE TIME THEY TAKE HERE (src/duck/sync.ts nextChunkPages, nextRate; a laptop copying a 20,126,276-row
// table from a database over the internet showed no progress, its first line waiting on 0 for ages, then jumping to
// 100% — 433,760 pages in 11 chunks of 43,104, 3 at a time, each minutes long).
type Rate = { pagesPerSecond: number; rowsPerSecond: number; bytesPerSecond: number; chunks: number };
type Gap = { first: number; end: number | null };
const sized = syncModule as unknown as {
  nextChunkPages?: (ceiling: number, rate: Rate | null, seconds: number) => number;
  nextRate?: (prev: Rate | null, m: { pages: number; rows: number; seconds: number; blockSize: number }) => Rate;
  takeChunk?: (gaps: Gap[], pages: number, size: number) => Gap | undefined; copyGaps?: (done: readonly Gap[]) => Gap[];
  copyChunkSecondsOf?: (env: NodeJS.ProcessEnv) => number; COPY_CHUNK_SECONDS?: number; COPY_CHUNK_MIN_PAGES?: number;
};
/** a copy of `pages` pages replayed at a reader's TRUE rate (pages a second, by the page), one reader: each chunk's size and seconds */
function replay(pages: number, ceiling: number, truePagesPerSecond: (page: number) => number, target = 12): Array<{ first: number; pages: number; seconds: number }> {
  const { nextChunkPages, nextRate, takeChunk, copyGaps } = sized;
  assert.ok(nextChunkPages && nextRate && takeChunk && copyGaps, "the sync sizes its chunks by the time they take (nextChunkPages, nextRate, takeChunk, copyGaps)");
  const gaps = copyGaps([]), out: Array<{ first: number; pages: number; seconds: number }> = [];
  let rate: Rate | null = null;
  for (let r = takeChunk(gaps, pages, nextChunkPages(ceiling, rate, target)); r !== undefined; r = takeChunk(gaps, pages, nextChunkPages(ceiling, rate, target))) {
    const n = (r.end ?? pages) - r.first, seconds = n / truePagesPerSecond(r.first);
    out.push({ first: r.first, pages: n, seconds });
    rate = nextRate(rate, { pages: n, rows: n * 46, seconds, blockSize: 8192 });
  }
  return out;
}

test("a copy's chunks are sized by the rate measured here: a small first chunk, then ~12 s of reading each, never above the estimate's ceiling", () => {
  const { nextChunkPages, nextRate } = sized;
  assert.ok(nextChunkPages && nextRate, "nextChunkPages and nextRate");
  assert.equal(sized.COPY_CHUNK_SECONDS, 12);
  const rate = (pagesPerSecond: number): Rate => ({ pagesPerSecond, rowsPerSecond: pagesPerSecond * 46, bytesPerSecond: pagesPerSecond * 8192, chunks: 1 });
  // the laptop's table: 433,760 pages, a ceiling of 43,104 by the row estimate (COPY_CHUNK_ROWS)
  assert.equal(nextChunkPages(43_104, null, 12), 4_310, "before anything is measured: a tenth of the ceiling");
  assert.equal(nextChunkPages(43_104, rate(240), 12), 2_880, "~12 s at 240 pages a second (~11,000 rows/s over the WAN)");
  assert.equal(nextChunkPages(43_104, rate(20_000), 12), 43_104, "a fast source: the ceiling, as before (the test server's chunks were ~6 s)");
  assert.equal(nextChunkPages(43_104, rate(1), 12), 128, "a crawl: never under COPY_CHUNK_MIN_PAGES");
  assert.equal(nextChunkPages(500, null, 12), 128, "a first chunk of at least the floor");
  assert.equal(nextChunkPages(50, null, 12), 50, "a ceiling under the floor is the ceiling");
  assert.equal(nextChunkPages(43_104, rate(240), 2), 480, "MASON_COPY_CHUNK_SECONDS=2: smaller chunks");
  // the rate: the first chunk's own, then a moving average
  const r1 = nextRate(null, { pages: 1000, rows: 46_000, seconds: 4, blockSize: 8192 });
  assert.deepEqual(r1, { pagesPerSecond: 250, rowsPerSecond: 11_500, bytesPerSecond: 2_048_000, chunks: 1 });
  const r2 = nextRate(r1, { pages: 1000, rows: 46_000, seconds: 10, blockSize: 8192 });
  assert.deepEqual([Math.round(r2.pagesPerSecond), Math.round(r2.rowsPerSecond), r2.chunks], [145, 6_670, 2], "slower: quick to shrink, 0.3 × 250 + 0.7 × 100");
  const r3 = nextRate(r2, { pages: 1000, rows: 46_000, seconds: 1, blockSize: 8192 });
  assert.deepEqual([Math.round(r3.pagesPerSecond), r3.chunks], [402, 3], "faster: slow to grow, 0.7 × 145 + 0.3 × 1000");

  // THE LAPTOP REPLAYED: one reader at ~240 pages a second. The old chunks took 43,104 / 240 = 180 s each; these take ~12 s
  const wan = replay(433_760, 43_104, () => 240);
  assert.equal(wan[0]!.pages, 4_310);
  assert.ok(wan[0]!.seconds < 20, `the first chunk is ${wan[0]!.seconds} s`);
  for (const c of wan.slice(1, -1)) assert.ok(Math.abs(c.seconds - 12) < 0.01, `every later chunk ~12 s: ${c.seconds}`);
  assert.ok(wan.length > 140, `${wan.length} chunks`);
  // the same table on the test server's source (~20,000 pages a second): the ceiling's chunks, as before
  const fast = replay(433_760, 43_104, () => 20_000);
  assert.deepEqual(fast.map((c) => c.pages), [4_310, ...Array(9).fill(43_104), 433_760 - 4_310 - 9 * 43_104]);
  // A RATE THAT FALLS half way (a WAN that slows, a busy source): the chunks after it shrink with the measured rate
  const falling = replay(433_760, 43_104, (page) => page < 200_000 ? 2_000 : 400);
  const before = falling.filter((c) => c.first > 50_000 && c.first < 190_000), after_ = falling.filter((c) => c.first > 260_000 && c.first < 430_000);
  assert.ok(before.every((c) => c.pages === 24_000), `before: ${before.map((c) => c.pages)}`);
  // the moving average follows it down within a few chunks (one slow chunk moves it, never sets it), to 12 s at the new rate
  assert.ok(after_.every((c, i) => c.pages < 24_000 && (i === 0 || c.pages <= after_[i - 1]!.pages)), `after: ${after_.map((c) => c.pages)}`);
  assert.ok(after_.slice(-5).every((c) => Math.abs(c.pages - 4_800) <= 5), `settles at 12 s × 400 pages/s: ${after_.map((c) => c.pages)}`);
  assert.ok(falling.length > replay(433_760, 43_104, () => 2_000).length, "more chunks as the rate fell");
});

test("chunks of any size, cut from what no committed chunk covers, tile the heap: none read twice, none skipped", () => {
  const { takeChunk, copyGaps } = sized;
  assert.ok(takeChunk && copyGaps, "takeChunk and copyGaps");
  const done = [{ first: 10, end: 20 }, { first: 33, end: 40 }];
  const gaps = copyGaps(done);
  assert.deepEqual(gaps, [{ first: 0, end: 10 }, { first: 20, end: 33 }, { first: 40, end: null }]);
  const sizes = [3, 100, 4, 2, 9, 1, 50];
  const taken: Gap[] = [];
  for (let k = 0, r = takeChunk(gaps, 60, sizes[0]!); r !== undefined; r = takeChunk(gaps, 60, sizes[++k % sizes.length]!)) taken.push(r);
  assert.deepEqual(taken, [{ first: 0, end: 3 }, { first: 3, end: 10 }, { first: 20, end: 24 }, { first: 24, end: 26 }, { first: 26, end: 33 },
    { first: 40, end: 41 }, { first: 41, end: null }]);
  const all = [...done, ...taken].sort((a, b) => a.first - b.first);
  for (let i = 1; i < all.length; i++) assert.equal(all[i]!.first, all[i - 1]!.end, "contiguous, none overlapping");
  assert.equal(all[all.length - 1]!.end, null, "the last open-ended: pages the table grew by are read too");
});

test("MASON_COPY_CHUNK_SECONDS is a number of seconds from 1 to 300, 12 when unset, and anything else is refused with the way out", () => {
  const { copyChunkSecondsOf } = sized;
  assert.ok(copyChunkSecondsOf, "copyChunkSecondsOf");
  assert.equal(copyChunkSecondsOf({}), 12);
  assert.equal(copyChunkSecondsOf({ MASON_COPY_CHUNK_SECONDS: "" }), 12);
  assert.equal(copyChunkSecondsOf({ MASON_COPY_CHUNK_SECONDS: "1" }), 1);
  assert.equal(copyChunkSecondsOf({ MASON_COPY_CHUNK_SECONDS: "2.5" }), 2.5);
  assert.equal(copyChunkSecondsOf({ MASON_COPY_CHUNK_SECONDS: "300" }), 300);
  for (const bad of ["0", "0.5", "301", "-1", "ten", "1e1"]) {
    assert.throws(() => copyChunkSecondsOf({ MASON_COPY_CHUNK_SECONDS: bad }), (e: Error) => e.message.startsWith(`MASON_COPY_CHUNK_SECONDS=${JSON.stringify(bad)} is not a number of seconds from 1 to 300: `) &&
      e.message.endsWith("or unset it for 12"), bad);
  }
});

// A COPY'S PROGRESS BETWEEN COMMITS (src/duck/sync.ts copyProgressNow): the chunks in flight count at the measured rate,
// each under 90 % of its expected rows, so `mason wait` moves at every poll and a commit moves it forward, never back.
type Live = { pages: number; chunksDone: number; pagesDone: number; rowsDone: number; untaken: number; chunkPages: number; readers: number;
  reading: Array<{ since: number; pages: number }>; rate: Rate | null; rowsPerPage: number | null };
type View = { chunksDone: number; chunksTotal: number; reading: number; readingSeconds: number | null; rowsReading: number; rowsPerSecond: number | null;
  bytesPerSecond: number | null; secondsLeft: number | null; share: number };
test("a copy's progress counts the chunks in flight at the measured rate, held under what each will commit", () => {
  const { copyProgressNow } = syncModule as unknown as { copyProgressNow?: (l: Live, now: number) => View };
  assert.ok(copyProgressNow, "copyProgressNow");
  const rate: Rate = { pagesPerSecond: 240, rowsPerSecond: 11_040, bytesPerSecond: 240 * 8192, chunks: 4 };
  const T = 1_000_000;
  // nothing measured: how long the first chunks have been reading, nothing counted for them
  const first = copyProgressNow({ pages: 433_760, chunksDone: 0, pagesDone: 0, rowsDone: 0, untaken: 433_760 - 3 * 4_310, chunkPages: 4_310, readers: 3,
    reading: [{ since: T, pages: 4_310 }, { since: T + 50, pages: 4_310 }, { since: T + 90, pages: 4_310 }], rate: null, rowsPerPage: 46.4 }, T + 12_000);
  assert.deepEqual(first, { chunksDone: 0, chunksTotal: 3 + 98, reading: 3, readingSeconds: 12, rowsReading: 0, rowsPerSecond: null, bytesPerSecond: null, secondsLeft: null, share: 0 });
  // three in flight, 2,880 pages each (~133,000 rows): 30 s in, each counts its 30 s at the rate
  const live = (since: number): Live => ({ pages: 433_760, chunksDone: 4, pagesDone: 4 * 2_880, rowsDone: 4 * 2_880 * 46, untaken: 433_760 - 7 * 2_880, chunkPages: 2_880, readers: 3,
    reading: [{ since, pages: 2_880 }, { since: since + 5_000, pages: 2_880 }, { since: since + 9_000, pages: 2_880 }], rate, rowsPerPage: 46 });
  const v = copyProgressNow(live(T), T + 10_000);
  assert.equal(v.readingSeconds, 10);
  assert.equal(v.rowsReading, Math.floor(11_040 * (10 + 5 + 1)));
  assert.equal(v.rowsPerSecond, 3 * 11_040, "three readers");
  assert.ok(v.secondsLeft !== null && Math.abs(v.secondsLeft - (433_760 - 4 * 2_880 - 240 * 16) / (3 * 240)) < 1e-6, String(v.secondsLeft));
  assert.equal(v.chunksTotal, 4 + 3 + Math.ceil((433_760 - 7 * 2_880) / 2_880));
  assert.equal(v.share, (4 * 2_880 + 240 * 16) / 433_760, "the heap's pages read: the committed chunks' and the ones in flight by now");
  // it moves at every poll, until each chunk reaches 90 % of what it will commit: then it waits for the commit
  let last = -1;
  let lastShare = -1;
  for (let s = 0; s <= 120; s += 3) {
    const p = copyProgressNow(live(T), T + s * 1000);
    assert.ok(p.rowsReading >= last && p.share >= lastShare, `${s} s`);
    last = p.rowsReading; lastShare = p.share;
  }
  assert.equal(last, Math.floor(3 * 0.9 * 2_880 * 46), "held under each chunk's rows");
  // a commit (the oldest, its 2,880 pages' rows) moves the count forward whenever it lands
  for (const s of [3, 12, 30, 600]) {
    const before = live(T), at = T + s * 1000;
    const shown = before.rowsDone + copyProgressNow(before, at).rowsReading;
    const after_: Live = { ...before, chunksDone: 5, pagesDone: before.pagesDone + 2_880, rowsDone: before.rowsDone + 2_880 * 46, reading: before.reading.slice(1) };
    assert.ok(after_.rowsDone + copyProgressNow(after_, at).rowsReading >= shown, `a commit after ${s} s moves it forward`);
    assert.ok(copyProgressNow(after_, at).share >= copyProgressNow(before, at).share, `its share too, after ${s} s`);
  }
  // every chunk read: nothing in flight, nothing left
  assert.deepEqual(copyProgressNow({ ...live(T), chunksDone: 151, reading: [], untaken: 0 }, T), { chunksDone: 151, chunksTotal: 151, reading: 0, readingSeconds: null, rowsReading: 0,
    rowsPerSecond: 11_040, bytesPerSecond: 240 * 8192, secondsLeft: 0, share: (4 * 2_880) / 433_760 });
});

// WHAT THE READERS N AT A TIME RELY ON (src/duck/sync.ts readChunks): DuckDB 2.0 lets transactions on two connections
// APPEND to one table at once and both commit — the side table every reader fills, and `_mason.copy_chunks`, made here
// by the sync's own `open` — and the ledger's key refuses a chunk committed twice, at its commit. A property of DuckDB,
// not of Mason: it cannot fail by a change to the sync, only by a DuckDB that no longer allows it (then each reader
// needs a side table of its own, which the swap would UNION ALL).
test("two connections append to one table at once and both commit; a chunk recorded twice is refused at its commit", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { DuckStore } = await import("../src/duck/store.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-appenders-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const source = { host: "127.0.0.1", port: 1, database: "none", user: "none", password: "", sslmode: "disable" };
  const sync = new syncModule.Sync(store, source as never, "none", () => undefined, 3_600_000, "poll");
  const a = await store.instance.connect(), b = await store.instance.connect();
  try {
    await sync.open();
    await store.writer.run("CREATE TABLE side (id BIGINT, v VARCHAR)");
    await a.run("BEGIN TRANSACTION"); await b.run("BEGIN TRANSACTION");
    await a.run("INSERT INTO side SELECT range, repeat('a', 100) FROM range(0, 300000)");
    await b.run("INSERT INTO side SELECT range, repeat('b', 100) FROM range(300000, 600000)");
    await a.run("INSERT INTO _mason.copy_chunks VALUES ('public.t', 0, 10, 300000, 1, now())");
    await b.run("INSERT INTO _mason.copy_chunks VALUES ('public.t', 10, NULL, 300000, 1, now())");
    await b.run("COMMIT"); await a.run("COMMIT");
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*), count(DISTINCT id) FROM side")).getRowsJS(), [[600000n, 600000n]]);
    assert.deepEqual((await store.writer.runAndReadAll("SELECT first_page, end_page FROM _mason.copy_chunks ORDER BY 1")).getRowsJS(), [[0n, 10n], [10n, null]]);
    await a.run("BEGIN TRANSACTION"); await b.run("BEGIN TRANSACTION");
    await a.run("INSERT INTO _mason.copy_chunks VALUES ('public.t', 20, 30, 1, 1, now())");
    await b.run("INSERT INTO _mason.copy_chunks VALUES ('public.t', 20, 30, 1, 1, now())");
    await a.run("COMMIT");
    await assert.rejects(b.run("COMMIT"), /PRIMARY KEY or UNIQUE constraint violation: duplicate key "public\.t, 20"/);
  } finally {
    a.closeSync(); b.closeSync(); await sync.stop(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A COPY IN PROGRESS RECORDED BY THE MASON OF ONE READER (its `copy_progress` row held `next_page`, the page before
// which every page was read, null when every page was): opened by this one, it becomes the chunk it amounts to, so that
// copy continues where it was instead of reading the source again, and the row loses the columns it no longer keeps.
test("a copy in progress from the Mason of one reader becomes its committed chunk, and continues where it was", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { DuckStore } = await import("../src/duck/store.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-one-reader-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const logged: string[] = [];
  const source = { host: "127.0.0.1", port: 1, database: "none", user: "none", password: "", sslmode: "disable" };
  const sync = new syncModule.Sync(store, source as never, "none", (l) => logged.push(l), 3_600_000, "poll");
  try {
    await store.writer.run("CREATE SCHEMA IF NOT EXISTS _mason");
    await store.writer.run(`CREATE TABLE _mason.copy_progress (source VARCHAR PRIMARY KEY, snapshot VARCHAR, columns VARCHAR, exact VARCHAR, filenode BIGINT, pages BIGINT, next_page BIGINT, "rows" BIGINT, updated_at TIMESTAMPTZ)`);
    await store.writer.run(`INSERT INTO _mason.copy_progress VALUES ('public.part', '100:120:', '[]', '[]', 16384, 14286, 4300, 30100, now()), ` +
      `('public.whole', '100:120:', '[]', '[]', 16385, 70, NULL, 900, now()), ('public.begun', '100:120:', '[]', '[]', NULL, 10, 0, 0, now())`);
    await sync.open();
    assert.deepEqual((await store.writer.runAndReadAll(`SELECT source, first_page, end_page, "rows", filenode FROM _mason.copy_chunks ORDER BY source`)).getRowsJS(),
      [["public.part", 0n, 4300n, 30100n, 16384n], ["public.whole", 0n, null, 900n, 16385n]]);
    assert.deepEqual((await store.writer.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE schema_name = '_mason' AND table_name = 'copy_progress' ORDER BY column_index`)).getRowsJS().flat(),
      ["source", "snapshot", "columns", "exact", "pages", "updated_at"]);
    assert.ok(logged.includes("2 sync(s) in progress were begun by a Mason that read one chunk at a time: each continues where it was"), logged.join("\n"));
  } finally {
    await sync.stop(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
