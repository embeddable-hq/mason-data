/**
 * THE STREAM'S VALUES AS DUCKDB READS THEM (src/duck/stream.ts duckValue). Mason's connections ask for ISO 8601
 * intervals (src/cdc/pg-wire.ts IntervalStyle), which DuckDB's INTERVAL cannot read (every update of a
 * table with an interval failed in the stream, again each second): they are written as DuckDB's words, each part with
 * its sign. tests/integration/duck-stream.itest.ts holds every type against a fresh copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import * as stream from "../src/duck/stream.ts";

// read from the module, not imported by name: the file loads at a commit without `intervalWords` (scripts/fails-without.ts)
const { duckValue } = stream;
const intervalWords = (text: string): string => (stream as { intervalWords: (t: string) => string }).intervalWords(text);

test("an ISO 8601 interval is DuckDB's words, each part with its sign; anything else is refused by name", () => {
  assert.equal(intervalWords("P1Y2M3DT4H5M6.789S"), "1 years 2 months 3 days 4 hours 5 minutes 6.789 seconds");
  assert.equal(intervalWords("P-10M-3DT-4H-5M-6.789S"), "-10 months -3 days -4 hours -5 minutes -6.789 seconds");
  assert.equal(intervalWords("P7D"), "7 days");
  assert.equal(intervalWords("P1W"), "7 days");
  assert.equal(intervalWords("PT-0.5S"), "-0.5 seconds");
  assert.equal(intervalWords("PT0S"), "0 seconds");
  assert.throws(() => intervalWords("1 year"), /an interval arrived as "1 year", which is not ISO 8601/);
});

test("each interval the stream brings is the value Postgres wrote, as DuckDB stores it", async () => {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  // Postgres's ISO 8601 output of each (SET IntervalStyle = iso_8601), and the same interval as DuckDB prints it
  const cases: Array<[string, string]> = [
    ["P1Y2M3DT4H5M6.789S", "1 year 2 months 3 days 04:05:06.789"],
    ["P-10M-3DT-4H-5M-6.789S", "-10 months -3 days -04:05:06.789"],
    ["PT-0.5S", "-00:00:00.5"],
    ["PT0.000001S", "00:00:00.000001"],
    ["PT0S", "00:00:00"],
  ];
  for (const [iso, duck] of cases) {
    const got = (await c.runAndReadAll(`SELECT (${duckValue(iso, "INTERVAL")})::VARCHAR`)).getRowsJS()[0]![0];
    assert.equal(got, duck, iso);
  }
});

// A BATCH THAT CHANGES A TABLE OVER THE POLL'S ROW LIMIT IS APPLIED BY TIME AS WELL (src/duck/stream.ts applySize):
// with no index on a copy, each application scans the table's key column — 0.35–1.8 s per 10,000 changes on 195 M uuid
// keys here, tens of seconds on the test server's disk — so such a batch waits at least 5 s and a piece holds up to
// 50,000 changes; a batch of small tables keeps the stream's own 500 ms and 10,000.
test("a batch holding a big table's change waits 5 s and holds 50,000 changes; one of small tables keeps the stream's bounds", () => {
  const applySize = (stream as { applySize?: (big: boolean, ms: number, rows: number) => { ms: number; rows: number } }).applySize;
  assert.equal(typeof applySize, "function", "the stream sizes a batch by the tables in it");
  assert.deepEqual(applySize!(false, 500, 10_000), { ms: 500, rows: 10_000 });
  assert.deepEqual(applySize!(true, 500, 10_000), { ms: 5_000, rows: 50_000 });
  assert.deepEqual(applySize!(true, 60_000, 100_000), { ms: 60_000, rows: 100_000 }, "never smaller than the stream's own");
});
