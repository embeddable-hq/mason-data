/**
 * A TYPE THE COPY HOLDS AS ANOTHER, ON THE WIRE (issues 126 and 129): the source's OID and typlen, and what it writes.
 * What the copy holds is tests/duck-held-types.test.ts's; every statement over such a column the oracle's `MAPPED`.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DuckDBTimeTZValue, LIST, TIMETZ, VARCHAR } from "@duckdb/node-api";
import { pgTypedColumn, wireColumn } from "../src/duck/types.ts";
import type { PgSession } from "../src/api/postgres/encode.ts";

const session = { timeZone: "UTC" } as PgSession;

test("a timetz is written as Postgres writes it, in text and in binary", () => {
  const c = wireColumn("c", TIMETZ);
  assert.equal(c.oid, 1266);
  assert.equal(c.divergence, null);
  const value = (micros: bigint, offset: number): DuckDBTimeTZValue => new DuckDBTimeTZValue(0n, micros, offset);
  const text = (micros: bigint, offset: number): string => c.encode(value(micros, offset), 0, session)!.toString("utf8");
  assert.equal(text(45_000_000_000n, 7200), "12:30:00+02");
  assert.equal(text(0n, -19800), "00:00:00-05:30");
  assert.equal(text(86_399_999_999n, 51330), "23:59:59.999999+14:15:30");
  assert.equal(text(86_400_000_000n, -57599), "24:00:00-15:59:59");
  // timetz_send: microseconds, then the zone in seconds WEST of UTC, the other way round from the offset's sign
  const b = c.encode(value(45_000_000_000n, 7200), 1, session)!;
  assert.equal(b.length, 12);
  assert.equal(b.readBigInt64BE(0), 45_000_000_000n);
  assert.equal(b.readInt32BE(8), -7200);
});

test("a held type goes on the wire under its own OID and typlen; its binary form is sent or refused by name", () => {
  const bx = pgTypedColumn("c", 603, VARCHAR), mc = pgTypedColumn("c", 829, VARCHAR);
  assert.deepEqual([mc.oid, mc.size, mc.divergence], [829, 6, null]);
  assert.equal(mc.encode("08:00:2b:01:02:03", 0, session)!.toString(), "08:00:2b:01:02:03");
  assert.throws(() => mc.encode("08:00:2b:01:02:03", 1, session), (e: Error & { code?: string }) => e.code === "0A000" && /Mason gap binary-held-type/.test(e.message) && !/08:00/.test(e.message));
  // what pgjdbc asks for in binary once a statement has run five times: float8s, as point_send and box_send write them
  const b = bx.encode("(3,4),(1,2.5)", 1, session)!;
  assert.deepEqual([0, 8, 16, 24].map((at) => b.readDoubleBE(at)), [3, 4, 1, 2.5]);
  assert.equal(pgTypedColumn("c", 600, VARCHAR).encode("(1.5,-2.5e+300)", 1, session)!.readDoubleBE(8), -2.5e300);
  assert.equal(pgTypedColumn("c", 1028, LIST(VARCHAR)).oid, 1028);
});
