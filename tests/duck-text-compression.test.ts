/**
 * A SYNCED TABLE'S TEXT COLUMNS ARE COMPRESSED COLUMN BY COLUMN (issue 1140; src/duck/text-compression.ts, docs/DESIGN.md
 * "Text compression by column"). The rule, by the shapes it was measured on: short or repeated values take the
 * dictionary, long ones that do not repeat and any column holding a value too long for the dictionary take ZSTD. And
 * the engine, under the instance's forced ZSTD: a column given its method keeps it for rows written later, through a
 * checkpoint and a restart, with the same answers. tests/duck-compact.test.ts holds a compaction to it, and
 * tests/integration/duck-poll.itest.ts the copy from a Postgres.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import type * as textModule from "../src/duck/text-compression.ts";

// imported when the file loads, and nothing at a commit without the module: each test fails by name there
// (scripts/fails-without.ts), never "did not load"
const T: Partial<typeof textModule> = await import("../src/duck/text-compression.ts").catch((e: unknown) => {
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e))) return {};
  throw e;
});
const need = <K extends keyof typeof textModule>(name: K): (typeof textModule)[K] => {
  const x = T[name];
  assert.ok(x !== undefined, `src/duck/text-compression.ts ${name}`);
  return x as (typeof textModule)[K];
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-text-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the rule: short or repeated values take the dictionary; long values that do not repeat, or one too long for the dictionary, take zstd; no value, the instance's", () => {
  const textStorage = need("textStorage");
  const s = (avgBytes: number, distinct: number | null, maxBytes = avgBytes * 2, values = 10_000) => textStorage({ values, avgBytes, maxBytes, distinct, distinctOf: values, exact: true, compressed: 0 });
  // the shapes measured (docs/DESIGN.md "Text compression by column"), as a sample of 10,000 rows sees them
  assert.equal(s(7, 6), "dictionary", "a status");
  assert.equal(s(2, 209), "dictionary", "a country code");
  assert.equal(s(18, 4_000), "dictionary", "a name");
  assert.equal(s(27, 10_000), "dictionary", "an email");
  assert.equal(s(43, 10_000), "dictionary", "a URL");
  assert.equal(s(175, 9_990), "zstd", "free text of a sentence or two, each its own");
  assert.equal(s(186, 40), "dictionary", "a long label of 40 values");
  assert.equal(s(222, 4_300), "zstd", "values of 222 bytes, too many distinct to repeat");
  // the boundary: 64 bytes on average, and values that repeat when at most an eighth of the sample is distinct
  assert.equal(s(63, 10_000), "dictionary", "just under 64 bytes, each its own");
  assert.equal(s(64, 10_000), "zstd", "64 bytes, each its own");
  assert.equal(s(65, 10_000), "zstd", "just over 64 bytes, each its own");
  assert.equal(s(65, 1_250), "dictionary", "just over 64 bytes, an eighth distinct: they repeat");
  assert.equal(s(65, 1_251), "zstd", "just over 64 bytes, a little more than an eighth distinct");
  assert.equal(s(65, null), "zstd", "just over 64 bytes, not counted");
  assert.equal(s(704, 300), "dictionary", "JSON documents of 300 values");
  assert.equal(s(704, 982), "dictionary", "JSON documents of 1,000 values");
  assert.equal(s(706, 2_894), "zstd", "JSON documents of 3,000 values");
  assert.equal(s(708, 10_000), "zstd", "JSON documents");
  assert.equal(s(1_734, 10_000), "zstd", "long JSON documents");
  assert.equal(s(40, 10_000, 45_000), "zstd", "short values with one the dictionary cannot hold");
  assert.equal(s(40, 10_000, 16_383), "dictionary", "the longest value the dictionary holds");
  assert.equal(s(708, null), "zstd", "long values not counted: the instance's zstd");
  assert.equal(textStorage({ values: 200, avgBytes: 708, maxBytes: 900, distinct: 10, distinctOf: 100, exact: true, compressed: 0 }), "dictionary", "counted over fewer rows than the lengths");
  assert.equal(textStorage({ values: 0, avgBytes: 0, maxBytes: 0, distinct: 0, distinctOf: 0, exact: true, compressed: 0 }), null, "no value sampled");
  assert.equal(textStorage(undefined), null, "not sampled");
});

test("the rule over sizes as stored (a json's, a jsonb's): the dictionary only when every value is small and stored uncompressed; a value Postgres compressed, or a source that cannot say, zstd however the values repeat", () => {
  const textStorage = need("textStorage"), needsDistinct = need("needsDistinct");
  const stored = (avgBytes: number, maxBytes: number, compressed: number | null, distinct: number | null = 5) =>
    textStorage({ values: 10_000, avgBytes, maxBytes, distinct, distinctOf: 10_000, exact: false, compressed });
  // the review of PR 1141: documents of 51,892 bytes of text, 3,383 stored, 5 distinct, were given the dictionary and
  // stored Uncompressed, 51 times larger than under zstd
  assert.equal(stored(3_383, 3_383, 10_000), "zstd", "large documents Postgres compressed, however they repeat");
  assert.equal(stored(150, 400, 1), "zstd", "one value compressed: its text is not known");
  assert.equal(stored(150, 400, null), "zstd", "a source that cannot say what it compressed (before Postgres 14)");
  assert.equal(stored(1_500, 2_000, 0), "zstd", "a value stored uncompressed at 2,000 bytes: its text could reach 16 KiB");
  assert.equal(stored(40, 1_999, 0, null), "dictionary", "a short jsonb, all stored uncompressed and small");
  assert.equal(stored(176, 181, 0, 10_000), "zstd", "the cold benchmark's payload: 176 bytes stored, uncompressed, each its own");
  assert.equal(stored(176, 181, 0, 40), "dictionary", "as long, of 40 values");
  assert.equal(stored(40, 300, 0, null), "dictionary", "short and stored uncompressed: never counted");
  assert.equal(stored(40, 300, 1, 5), "zstd", "short, but one value compressed: zstd however they repeat");
  assert.equal(stored(700, 1_500, 0, 300), "dictionary", "long documents that repeat, all stored uncompressed and small");
  assert.equal(stored(700, 1_500, 0, 9_000), "zstd", "long documents that do not repeat");
  assert.equal(needsDistinct({ values: 10, avgBytes: 700, maxBytes: 900, exact: false, compressed: 3 }), false, "compressed: never counted");
  assert.equal(needsDistinct({ values: 10, avgBytes: 700, maxBytes: 900, exact: false, compressed: 0 }), true);
  assert.equal(need("compressionClause")(null), "");
});

test("a sample's SQL: a random share of the source's pages, the same pages for its lengths and its distinct values; lengths never made whole; a distinct count held to about 16 MiB of values; a synced table's by its row ids alone", () => {
  const sourceLengthsSql = need("sourceLengthsSql"), sourceDistinctSql = need("sourceDistinctSql"), syncedLengthsSql = need("syncedLengthsSql");
  const distinctRows = need("distinctRows"), needsDistinct = need("needsDistinct");
  const lengths = sourceLengthsSql(`"public"."orders"`, [{ column: `"status"`, type: "text" }, { column: `"code"`, type: "character(2)" }, { column: `"name"`, type: "character varying(80)" },
    { column: `"doc"`, type: "jsonb" }, { column: `"j"`, type: "json" }], 3_400_000, true);
  assert.match(lengths, /FROM "public"\."orders" TABLESAMPLE SYSTEM \(0\.00294117647\d*\) REPEATABLE \(0\) LIMIT 10000\) s$/);
  assert.doesNotMatch(lengths, /ORDER BY|e-|md5|::text/i, "no ORDER BY on the source, no exponent in the percent, no value made whole or hashed");
  assert.match(lengths, /avg\(octet_length\(c0\)\).*avg\(octet_length\(c1\)\).*avg\(octet_length\(c2\)\).*avg\(pg_column_size\(c3\)\).*avg\(pg_column_size\(c4\)\)/, "a text's length from its header; a json's or jsonb's size as stored");
  assert.match(lengths, /max\(octet_length\(c0\)\), 0, .*max\(pg_column_size\(c3\)\), count\(\*\) FILTER \(WHERE pg_column_compression\(c3\) IS NOT NULL\), /, "how many of a jsonb's values Postgres compressed; a text's length is its own");
  assert.match(sourceLengthsSql(`"t"`, [{ column: `"doc"`, type: "jsonb" }], 40, false), /max\(pg_column_size\(c0\)\), NULL FROM/, "before Postgres 14: not known");
  assert.match(sourceLengthsSql(`"t"`, [{ column: `"a"`, type: "text" }], 40, true), /TABLESAMPLE SYSTEM \(100\) REPEATABLE \(0\) LIMIT 10000/, "a small table read from its start");
  const distinct = sourceDistinctSql(`"public"."orders"`, [`"doc"`], 3_400_000, distinctRows({ avgBytes: 2_000, exact: true }));
  assert.match(distinct, /count\(DISTINCT hashtextextended\(c0::text, 0\)\) FROM \(SELECT "doc" AS c0 FROM "public"\."orders" TABLESAMPLE SYSTEM \(0\.00294117647\d*\) REPEATABLE \(0\) LIMIT 8388\) s$/, "the same pages, about 16 MiB of 2 KB values");
  assert.equal(distinctRows({ avgBytes: 700, exact: true }), 10_000);
  assert.equal(distinctRows({ avgBytes: 1_000_000, exact: true }), 16, "values of a megabyte: 16 of them");
  assert.equal(distinctRows({ avgBytes: 1_000, exact: false }), 2_796, "a size as stored counted at its text's most: 16 MiB of 6,000 bytes");
  assert.equal(needsDistinct({ values: 10, avgBytes: 700, maxBytes: 900, exact: true, compressed: 0 }), true);
  assert.equal(needsDistinct({ values: 10, avgBytes: 63, maxBytes: 900, exact: true, compressed: 0 }), false, "short: never counted");
  assert.equal(needsDistinct({ values: 10, avgBytes: 64, maxBytes: 900, exact: true, compressed: 0 }), true, "from 64 bytes, counted");
  assert.equal(needsDistinct({ values: 10, avgBytes: 700, maxBytes: 20_000, exact: true, compressed: 0 }), false, "a value the dictionary cannot hold: never counted");
  const synced = syncedLengthsSql(`"public"."t"`, [`"s"`], 1_000_000);
  assert.equal(synced.match(/rowid >= \d+ AND rowid < \d+/g)?.length, 8, "eight runs of row ids");
  assert.match(synced, /rowid >= 998750 AND rowid < 1000000/, "the last run ends at the table's end");
  assert.match(syncedLengthsSql(`"t"`, [`"s"`], 300), /rowid >= 0 AND rowid < 300\) s$/, "a small table read whole");
  const piece = syncedLengthsSql(`"t"`, [`"s"`], 1_000_000, 40);
  assert.equal(piece.match(/rowid >= \d+ AND rowid < \d+/g)?.length, 8, "held to a compaction's piece of 40 rows: eight runs of 5");
  assert.match(piece, /rowid >= 0 AND rowid < 5 /);
});

test("under the instance's forced zstd, a column given its method keeps it for rows written later, through a checkpoint and a restart, with the same answers", { timeout: 300_000 }, async () => {
  const compressionClause = need("compressionClause");
  const file = path.join(dir, "kept.db");
  const methods = async (store: DuckStore): Promise<string[][]> => ((await store.writer.runAndReadAll(
    `SELECT column_name, string_agg(DISTINCT compression, ',' ORDER BY compression) FROM pragma_storage_info('public.t') WHERE column_name <> 'id' AND segment_type <> 'VALIDITY' GROUP BY column_name ORDER BY column_name`)).getRowsJS() as string[][]);
  const rows = (from: number, n: number): string => `INSERT INTO public.t SELECT i AS id, (['shipped','pending','paid'])[1 + (i % 3)::INT] AS status, ` +
    `'{"id":' || i || ',"ref":"' || md5(i::VARCHAR) || md5((i + 1)::VARCHAR) || md5((i + 2)::VARCHAR) || '"}' AS doc, 'plain ' || (i % 3) AS plain FROM range(${from}, ${from + n}) r(i)`;
  let store = await DuckStore.open(file, () => undefined, { memoryLimit: "256MB" });
  try {
    await store.writer.run(`CREATE TABLE public.t (id BIGINT, status VARCHAR${compressionClause("dictionary")}, doc JSON${compressionClause("zstd")}, plain VARCHAR${compressionClause(null)})`);
    await store.writer.run(rows(0, 300_000));
    await store.writer.run("CHECKPOINT");
    const first = [["doc", "ZSTD"], ["plain", "ZSTD"], ["status", "DICT_FSST"]];
    assert.deepEqual(await methods(store), first, "the dictionary where given, zstd where given and where not (the instance's)");
  } finally { await store.close(); }
  store = await DuckStore.open(file, () => undefined, { memoryLimit: "256MB" });
  try {
    // rows the poll or the stream writes: deleted and written again by key, and new ones
    await store.writer.run("DELETE FROM public.t WHERE id % 10 = 0");
    await store.writer.run(`INSERT INTO public.t SELECT id, status, doc, plain FROM (${rows(0, 300_000).replace("INSERT INTO public.t ", "")}) x WHERE id % 10 = 0`);
    await store.writer.run(rows(300_000, 200_000));
    await store.writer.run("CHECKPOINT");
    assert.deepEqual(await methods(store), [["doc", "ZSTD"], ["plain", "ZSTD"], ["status", "DICT_FSST"]], "every row group written since keeps each column's method");
    assert.match(String((await store.writer.runAndReadAll("SELECT sql FROM duckdb_tables() WHERE table_name = 't'")).getRowsJS()[0]![0]), /status VARCHAR USING COMPRESSION DICT_FSST, doc JSON USING COMPRESSION ZSTD, plain VARCHAR\)/);
    assert.deepEqual((await store.writer.runAndReadAll("SELECT status, count(*)::INT, count(DISTINCT doc)::INT FROM public.t GROUP BY status ORDER BY status")).getRowsJS(),
      [["paid", 166_666, 166_666], ["pending", 166_667, 166_667], ["shipped", 166_667, 166_667]]);
  } finally { await store.close(); }
});
