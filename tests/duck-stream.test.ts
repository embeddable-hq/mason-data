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

// A RELATION MESSAGE SHOWS THE KEY HELD only through the replica identity's index (issue 1062): the default identity's
// primary key, or the index USING INDEX names, each unique over NOT NULL columns. Anything else asks the database.
type Col = { name: string; typeOid: number; typmod: number; isKey: boolean };
test("a relation message shows a key kept apart only by a default or USING INDEX identity whose flagged columns are the key's", () => {
  const keyShown = (stream as { keyShown?: (r: { replicaIdentity: string; columns: Col[] }, key: readonly string[]) => boolean }).keyShown;
  assert.equal(typeof keyShown, "function", "the stream reads a relation's replica identity before it writes by key");
  const cols = (...keys: string[]): Col[] => ["id", "tenant_id", "code", "v"].map((name) => ({ name, typeOid: 25, typmod: -1, isKey: keys.includes(name) }));
  // the primary key, as the default identity flags it
  assert.equal(keyShown!({ replicaIdentity: "d", columns: cols("id") }, ["id"]), true);
  assert.equal(keyShown!({ replicaIdentity: "d", columns: cols("tenant_id", "id") }, ["tenant_id", "id"]), true);
  // a unique index over fewer of the key's columns keeps the key apart too
  assert.equal(keyShown!({ replicaIdentity: "i", columns: cols("id") }, ["tenant_id", "id"]), true);
  // the primary key dropped: nothing flagged, so the database is asked
  assert.equal(keyShown!({ replicaIdentity: "d", columns: cols() }, ["id"]), false);
  // an identity over another column says nothing of the key
  assert.equal(keyShown!({ replicaIdentity: "i", columns: cols("code") }, ["id"]), false);
  assert.equal(keyShown!({ replicaIdentity: "d", columns: cols("tenant_id", "id") }, ["id"]), false);
  // FULL flags every column, unique or not, even where every flagged column is the key's
  assert.equal(keyShown!({ replicaIdentity: "f", columns: cols("id", "tenant_id", "code", "v") }, ["id"]), false);
  assert.equal(keyShown!({ replicaIdentity: "f", columns: cols("id") }, ["id"]), false);
  assert.equal(keyShown!({ replicaIdentity: "n", columns: cols() }, ["id"]), false);
});

// A RELATION MESSAGE SHOWS THE PRIMARY KEY GONE when the default identity flags no column (the review of PR 1068): a key
// held by the time the stream reads it does not clear the changes written before it came back.
test("a relation message shows the primary key gone only under the default identity with no column flagged", () => {
  const keyShownGone = (stream as { keyShownGone?: (r: { replicaIdentity: string; columns: Col[] }) => boolean }).keyShownGone;
  assert.equal(typeof keyShownGone, "function", "the stream reads a dropped primary key from the relation message");
  const cols = (...keys: string[]): Col[] => ["id", "v"].map((name) => ({ name, typeOid: 25, typmod: -1, isKey: keys.includes(name) }));
  assert.equal(keyShownGone!({ replicaIdentity: "d", columns: cols() }), true);
  assert.equal(keyShownGone!({ replicaIdentity: "d", columns: cols("id") }), false);
  // an identity over an index, FULL or NOTHING says nothing of the primary key
  assert.equal(keyShownGone!({ replicaIdentity: "i", columns: cols() }), false);
  assert.equal(keyShownGone!({ replicaIdentity: "f", columns: cols("id", "v") }), false);
  assert.equal(keyShownGone!({ replicaIdentity: "n", columns: cols() }), false);
});

// WHERE A CATCH-UP WAITS FOR THE STREAM (the review of PR 1068): the insert position, which is past every commit another
// session can see, taken back to a page's start when it sits just past a page header, where no stream position lands.
test("an insert position just past a page header is taken back to the page's start, any other is kept", async () => {
  const source = await import("../src/cdc/source.ts" as string).catch(() => ({})) as { afterPageHeader?: (at: bigint, block: bigint, segment: bigint) => bigint };
  assert.equal(typeof source.afterPageHeader, "function", "the catch-up's position is read where every visible commit ends");
  const at = source.afterPageHeader!;
  const block = 8192n, segment = 16n * 1024n * 1024n;
  // past a page's short header, and a segment's long one
  assert.equal(at(5n * block + 24n, block, segment), 5n * block);
  assert.equal(at(3n * segment + 40n, block, segment), 3n * segment);
  // a record's end anywhere else in a page, or the page's start, as it is
  assert.equal(at(5n * block + 32n, block, segment), 5n * block + 32n);
  assert.equal(at(5n * block + 4096n, block, segment), 5n * block + 4096n);
  assert.equal(at(5n * block, block, segment), 5n * block);
  // where values align to 4: 20- and 36-byte headers
  assert.equal(at(7n * block + 20n, block, segment), 7n * block);
  assert.equal(at(2n * segment + 36n, block, segment), 2n * segment);
});
