/**
 * A COPY THAT WOULD FILL THE DISK IS STOPPED BEFORE IT DOES (src/duck/sync.ts copyDiskProjection: the test
 * server's copy of a 194 M-row table with JSON text columns was at 49 GB after 38% of it with 75 GB free, with
 * nothing to say so). From what the pages read so far added to the file, the pages left project to what they will
 * add; when that is more than the disk has free the copy fails with the way out, its chunks kept, and is tried again
 * as a failed copy is (tests/integration/duck-poll.itest.ts holds the sync to it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyDiskProjection, pagesRead } from "../src/duck/sync.ts";

test("the pages a copy has read: every committed range, the open-ended one to the heap's end", () => {
  assert.equal(pagesRead([], 1000), 0);
  assert.equal(pagesRead([{ first: 0, end: 100 }, { first: 200, end: 300 }], 1000), 200);
  assert.equal(pagesRead([{ first: 0, end: 100 }, { first: 900, end: null }], 1000), 200);
});

test("what a copy's pages left would add, from what its pages so far added; nothing said until 1% was read", () => {
  // 10 of 1,000 pages added 1 MB: the 990 left add 99 MB
  assert.deepEqual(copyDiskProjection({ pages: 1000, done: [{ first: 0, end: 10 }], doneAtStart: [], bytesAtStart: 5_000_000, bytesNow: 6_000_000 }),
    { needed: 99_000_000, perPage: 100_000, left: 990 });
  // resumed: only the pages THIS attempt read count, against what this attempt added
  assert.deepEqual(copyDiskProjection({ pages: 1000, done: [{ first: 0, end: 500 }, { first: 500, end: 510 }], doneAtStart: [{ first: 0, end: 500 }], bytesAtStart: 50_000_000, bytesNow: 50_500_000 }),
    { needed: 24_500_000, perPage: 50_000, left: 490 });
  assert.equal(copyDiskProjection({ pages: 1000, done: [{ first: 0, end: 9 }], doneAtStart: [], bytesAtStart: 0, bytesNow: 1_000_000 }), null, "under 1%: too early to say");
  assert.deepEqual(copyDiskProjection({ pages: 50, done: [{ first: 0, end: 1 }], doneAtStart: [], bytesAtStart: 0, bytesNow: 1_000 }), { needed: 49_000, perPage: 1_000, left: 49 }, "a small heap: one page is past 1%");
  assert.equal(copyDiskProjection({ pages: 1000, done: [{ first: 0, end: 100 }], doneAtStart: [], bytesAtStart: 9_000_000, bytesNow: 8_000_000 }), null, "a file that shrank (a checkpoint) says nothing");
  assert.deepEqual(copyDiskProjection({ pages: 1000, done: [{ first: 0, end: null }], doneAtStart: [], bytesAtStart: 0, bytesNow: 1 }), { needed: 0, perPage: 0.001, left: 0 }, "every page read: nothing left");
});
