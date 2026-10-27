/**
 * The pgoutput decoder (src/cdc/pgoutput.ts) against messages built BY HAND from the protocol
 * reference, one per shape the change reader acts on. A decoder tested only against a live server would
 * pass whatever that server happened to send; these pin the layout itself.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { decode } from "../src/cdc/pgoutput.ts";

const i8 = (n: number): Buffer => { const b = Buffer.alloc(1); b.writeInt8(n); return b; };
const i16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const str = (s: string): Buffer => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
const tag = (t: string): Buffer => Buffer.from(t, "latin1");
const text = (s: string): Buffer => Buffer.concat([tag("t"), i32(Buffer.byteLength(s)), Buffer.from(s)]);
const tuple = (...cols: Buffer[]): Buffer => Buffer.concat([i16(cols.length), ...cols]);

test("begin and commit carry the positions the reader acknowledges", () => {
  assert.deepEqual(decode(Buffer.concat([tag("B"), i64(0x4d22161fe0n), i64(123n), i32(77)])),
    { type: "begin", finalLsn: 0x4d22161fe0n, commitTime: 123n, xid: 77 });
  assert.deepEqual(decode(Buffer.concat([tag("C"), i8(0), i64(10n), i64(20n), i64(30n)])),
    { type: "commit", commitLsn: 10n, endLsn: 20n, commitTime: 30n });
});

test("a relation names its columns, their types and which are the key", () => {
  const msg = Buffer.concat([tag("R"), u32(16385), str("public"), str("items"), tag("d"), i16(2),
    i8(1), str("id"), u32(2950), i32(-1),
    i8(0), str("big"), u32(25), i32(-1)]);
  assert.deepEqual(decode(msg), {
    type: "relation", relid: 16385, namespace: "public", name: "items", replicaIdentity: "d",
    columns: [{ isKey: true, name: "id", typeOid: 2950, typmod: -1 }, { isKey: false, name: "big", typeOid: 25, typmod: -1 }],
  });
});

test("insert, update (with and without the old key) and delete", () => {
  assert.deepEqual(decode(Buffer.concat([tag("I"), u32(5), tag("N"), tuple(text("a"), tag("n"))])),
    { type: "insert", relid: 5, tuple: [{ kind: "text", text: "a" }, { kind: "null" }] });
  // an UPDATE that left a TOASTed value out of the change: 'u'
  assert.deepEqual(decode(Buffer.concat([tag("U"), u32(5), tag("N"), tuple(text("a"), tag("u"))])),
    { type: "update", relid: 5, oldKey: null, tuple: [{ kind: "text", text: "a" }, { kind: "unchanged" }] });
  // an UPDATE that changed the key: the old key first
  assert.deepEqual(decode(Buffer.concat([tag("U"), u32(5), tag("K"), tuple(text("old"), tag("n")), tag("N"), tuple(text("new"), text("x"))])),
    { type: "update", relid: 5, oldKey: [{ kind: "text", text: "old" }, { kind: "null" }], tuple: [{ kind: "text", text: "new" }, { kind: "text", text: "x" }] });
  assert.deepEqual(decode(Buffer.concat([tag("D"), u32(5), tag("K"), tuple(text("gone"), tag("n"))])),
    { type: "delete", relid: 5, key: [{ kind: "text", text: "gone" }, { kind: "null" }] });
});

test("text is UTF-8 and its length is in bytes", () => {
  const s = "ünïcödé 🎉\ttab";
  assert.deepEqual(decode(Buffer.concat([tag("I"), u32(1), tag("N"), tuple(text(s))])),
    { type: "insert", relid: 1, tuple: [{ kind: "text", text: s }] });
});

test("truncate lists its relations; anything else is passed over", () => {
  assert.deepEqual(decode(Buffer.concat([tag("T"), i32(2), i8(0), u32(7), u32(8)])), { type: "truncate", relids: [7, 8] });
  assert.deepEqual(decode(Buffer.concat([tag("Y"), u32(1), str("public"), str("mood")])), { type: "other", tag: "Y" });
});

test("a binary value or an unknown marker is refused, never guessed at", () => {
  assert.throws(() => decode(Buffer.concat([tag("I"), u32(1), tag("N"), i16(1), tag("b"), i32(0)])), /binary/);
  assert.throws(() => decode(Buffer.concat([tag("I"), u32(1), tag("X")])), /insert carries/);
  assert.throws(() => decode(Buffer.concat([tag("D"), u32(1), tag("N"), tuple()])), /expected K or O/);
});
