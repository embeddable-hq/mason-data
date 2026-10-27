/**
 * THE ENCODING HARNESS: for every type the API sends and a list of edge
 * values per type, a real Postgres (PGlite, in the process) is asked `SELECT $1::<type>` over the raw protocol with
 * the value as a text parameter, once with the text result format and once with the binary one, and the DataRow it
 * answers must be byte for byte what src/api/postgres/encode.ts produces for the same value. The timestamptz cases
 * run under `SET TimeZone` to five zones, the London DST edge and the local-mean-time offsets of 1900 included. A
 * value our encoder must refuse is asserted to throw; one Postgres refuses (a BC date, a NUL in text) is not sent.
 * The OIDs and sizes of the type table are held to Postgres's own RowDescription.
 *
 * A float is sent to Postgres as JavaScript spells it (`String(x)`), which Postgres's correctly rounded float input
 * reads back to the same bits — the BINARY comparison proves that for every value, so the text comparison is purely
 * of the formatter. Offline, in `npm test`, about two seconds.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PGlite } from "@electric-sql/pglite";
import { PG_API_TYPES } from "../../src/api/postgres/schema.ts";
import { OID, TIMESTAMP, encodeText, encodeBinary, encodeValue, formatFloat, EncodeError, type ApiValue, type WireType } from "../../src/api/postgres/encode.ts";
import * as wire from "./wire.ts";

const db = new PGlite();
await db.waitReady;
after(() => db.close());

/** Postgres's answer to `SELECT $1::<type>` for a text parameter, in the result format asked for. */
async function pg(type: WireType, param: string, format: 0 | 1): Promise<Buffer> {
  const reply = await db.execProtocolRaw(wire.extended(`SELECT $1::${type}`, [param], [format]));
  const [cell] = wire.singleRow(reply);
  if (cell === null || cell === undefined) throw new Error(`Postgres answered NULL for ${JSON.stringify(param)}::${type}`);
  return cell;
}

/** As a client sends the value: what the API carries, spelled as text. */
const asParam = (v: ApiValue): string => typeof v === "string" ? v : Object.is(v, -0) ? "-0" : String(v);

/** Both formats of `value` as `type`, ours against Postgres's. */
async function same(type: WireType, value: ApiValue, timeZone = "UTC"): Promise<void> {
  const session = { timeZone };
  const label = `${JSON.stringify(value)} as ${type} in ${timeZone}`;
  const text = await pg(type, asParam(value), 0);
  assert.equal(encodeText(type, value, session).toString("utf8"), text.toString("utf8"), `text of ${label}`);
  const binary = await pg(type, asParam(value), 1);
  assert.equal(encodeBinary(type, value, session).toString("hex"), binary.toString("hex"), `binary of ${label}`);
}

async function setTimeZone(zone: string): Promise<void> {
  const ms = wire.replies(await db.execProtocolRaw(wire.query(`SET TimeZone = '${zone}'`)));
  assert.deepEqual(ms.map((m) => m.type), ["CommandComplete", "ReadyForQuery"], `SET TimeZone = ${zone}`);
}

test("the OID table is Postgres's: oid and size of every type's RowDescription", async () => {
  for (const type of PG_API_TYPES) {
    const ms = wire.replies(await db.execProtocolRaw(wire.extended(`SELECT NULL::${type}, NULL::${type}[]`, [], [0])));
    const rd = ms.find((m) => m.type === "RowDescription");
    assert.ok(rd !== undefined && rd.type === "RowDescription", `RowDescription for ${type}`);
    assert.equal(rd.fields[0]?.typeOid, OID[type].oid, `${type} oid`);
    assert.equal(rd.fields[0]?.typeSize, OID[type].size, `${type} size`);
    assert.equal(rd.fields[1]?.typeOid, OID[type].arrayOid, `${type}[] oid`);
    const row = ms.find((m) => m.type === "DataRow");
    assert.ok(row !== undefined && row.type === "DataRow" && row.values[0] === null, "a NULL is the -1 length");
    assert.equal(encodeValue(type, null, 0, { timeZone: "UTC" }), null);
  }
  // the one type outside PG_API_TYPES: a wall-clock bucket's timestamp without time zone
  const ms = wire.replies(await db.execProtocolRaw(wire.extended("SELECT NULL::timestamp, NULL::timestamp[]", [], [0])));
  const rd = ms.find((m) => m.type === "RowDescription");
  assert.ok(rd !== undefined && rd.type === "RowDescription");
  assert.deepEqual([rd.fields[0]?.typeOid, rd.fields[0]?.typeSize, rd.fields[1]?.typeOid], [TIMESTAMP.oid, TIMESTAMP.size, TIMESTAMP.arrayOid]);
});

test("timestamp without time zone (a wall-clock bucket's): text with no offset in every session zone, binary as the wall clock's microseconds since 2000", async () => {
  const walls = ["2026-10-08T00:00:00", "2026-10-25T01:00:00", "2026-10-25T01:30:00.25", "2026-03-29T01:30:00", "1999-12-31T23:59:59.999999", "2000-01-01T00:00:00",
    "1969-12-31T23:59:59", "0001-01-01T00:00:00", "9999-12-31T23:59:59", "2026-07-01T10:30:00.5", "2026-07-01 10:30:00"];
  // the session's zone moves nothing: a wall clock has no zone to show in
  for (const zone of ["UTC", "Asia/Kolkata", "America/New_York"]) {
    await setTimeZone(zone);
    for (const v of walls) await same("timestamp", v, zone);
  }
  await setTimeZone("UTC");
  assert.equal(encodeText("timestamp", "2026-10-08T00:00:00", { timeZone: "Asia/Kolkata" }).toString(), "2026-10-08 00:00:00");
  // an instant is no wall clock (the server renders the body's instant IN the zone first, server.ts wallClockOf), nor a date
  for (const v of ["2026-10-08T00:00:00Z", "2026-10-08T00:00:00+01", "2026-10-08", "2026-02-30T00:00:00", "2026-10-08T24:00:00", "2026-10-08T00:00:00.1234567", "0000-01-01T00:00:00", 1759881600000]) {
    assert.throws(() => encodeText("timestamp", v, { timeZone: "UTC" }), (err: unknown) => err instanceof EncodeError && err.message.includes("as timestamp:"), String(v));
    assert.throws(() => encodeBinary("timestamp", v, { timeZone: "UTC" }), EncodeError, String(v));
  }
});

test("integers: int2, int4, int8, text and binary, a 64-bit value past 2^53 carried as a string", async () => {
  for (const v of [0, 1, -1, 32767, -32768, 12]) await same("int2", v);
  for (const v of [0, 1, -1, 2147483647, -2147483648, "007"]) await same("int4", v);
  for (const v of [0, 1, -1, 2 ** 53 - 1, -(2 ** 53 - 1), "9007199254740993", "9223372036854775807", "-9223372036854775808", "+42", "0000"]) {
    await same("int8", v);
  }
  for (const [type, v] of [["int2", 32768], ["int2", "-32769"], ["int4", 2 ** 31], ["int8", "9223372036854775808"],
    ["int8", 2 ** 53], ["int8", 1.5], ["int8", "1.0"], ["int8", "abc"], ["int8", " 12 "], ["int8", true], ["int4", "1e3"]] as const) {
    assert.throws(() => encodeText(type, v, { timeZone: "UTC" }), (err: unknown) =>
      err instanceof EncodeError && err.message.includes(JSON.stringify(v)) && err.message.includes(` as ${type}`), `${type} ${v}`);
  }
});

test("numeric: an exact value's text as numeric_out writes it (its scale's zeros kept) and numeric_send's groups", async () => {
  // what a program computes (src/lib/pg-numeric.ts) arrives as its text; a 64-bit sum as digits; a small one as a number
  for (const v of ["0", "0.00", "1.00000000000000000000", "-1.5", "21.8594916280008069", "221016.99", "-3002399751580331.3333",
    "9223372036854775807", "-9223372036854775808", "92233720368547758070", "0.0001", "0.00010000", "10000", "100000000.0000", "-0.0001",
    "1234567890.123456789012345678901234567890", 0, 7, -12, 9007199254740991] as const) {
    await same("numeric", v);
  }
  // a fractional JavaScript number has no scale (1.5 or 1.50?): refused, never guessed; nor a text that is no numeric
  for (const v of [1.5, 2 ** 53, "1,5", "", "abc", true] as const) {
    assert.throws(() => encodeText("numeric", v, { timeZone: "UTC" }), (err: unknown) => err instanceof EncodeError && err.message.includes("as numeric"), String(v));
  }
});

const FLOAT8_CASES: ApiValue[] = [
  0, -0, 1, -1, Number.MAX_VALUE, Number.MIN_VALUE, 2.2250738585072014e-308, 1e15, 1e16, 1e17, 1e20, 1e21, 1e100,
  123456789012345, 1234567890123456, 12345678901234567, 999999999999999.9, 9999999999999999,
  0.001, 0.0001, 0.00001, 1e-7, 1.5e-5, 0.0000011, 0.1 + 0.2, 0.1, 123.456, 100, 1000000, 123456789,
  NaN, Infinity, -Infinity, 2 ** 53 - 1, "9007199254740993", -2.5, 3.3,
  // decimals that sit exactly on a half-ulp boundary: JavaScript prints them, Postgres never does
  1e23, 1.25e22, 8.41e21, 5e22, 2 ** 70, 7e22,
];

test("float8: Postgres's shortest-inside-the-interval digits in its %g layout", async () => {
  for (const v of FLOAT8_CASES) await same("float8", v);
  // The rule's own examples, with no Postgres in the loop: the layout and the boundary cases.
  assert.equal(formatFloat(1e21, "float8"), "1e+21");
  assert.equal(formatFloat(1e20, "float8"), "1e+20");
  assert.equal(formatFloat(1e-7, "float8"), "1e-07");
  assert.equal(formatFloat(1e23, "float8"), "9.999999999999999e+22");
  assert.equal(formatFloat(1.25e22, "float8"), "1.2499999999999999e+22");
  assert.equal(formatFloat(-0, "float8"), "-0");
  assert.equal(formatFloat(1234567890123456, "float8"), "1.234567890123456e+15");
  assert.equal(formatFloat(123456789012345, "float8"), "123456789012345");
  for (const v of ["1,5", "", "1e", true, "--1"] as const) {
    assert.throws(() => encodeText("float8", v, { timeZone: "UTC" }), (err: unknown) => err instanceof EncodeError && err.message.includes("as float8"));
  }
  // NaN and Infinity are read in any case, as Postgres reads them.
  assert.equal(encodeText("float8", "nan", { timeZone: "UTC" }).toString(), "NaN");
  assert.equal(encodeText("float8", "-inf", { timeZone: "UTC" }).toString(), "-Infinity");
});

const FLOAT4_CASES: ApiValue[] = [
  0, -0, 1, -1, 3.4028234663852886e38, 1.401298464324817e-45, 1.1754943508222875e-38, 1e15, 1e16, 16777216, 16777217,
  0.1, 0.0001, 0.00001, 1e-7, 123456.7, 1e6, 100000, 123456, 1234567, 12345678, 1e38, 3.3, 2.5, 0.3, -7.25,
  NaN, Infinity, -Infinity, 33554432, 0.000123, 65504, 1e-10, 2 ** 24 + 2, 100.5, 999999, 9999999,
];

test("float4: the same over the float's own interval, fixed notation up to six digits of exponent", async () => {
  for (const v of FLOAT4_CASES) await same("float4", v);
  assert.equal(formatFloat(1e6, "float4"), "1e+06");
  assert.equal(formatFloat(100000, "float4"), "100000");
  assert.equal(formatFloat(0.1, "float4"), "0.1");
});

/** A fixed sequence of pseudo-random bit patterns (no seed to find, no run to reproduce): the formatter beyond the
 *  hand-picked list, since the boundary cases are rare and anywhere. Every fourth is a short decimal, where they live. */
function randomFloats(kind: "float4" | "float8", count: number): number[] {
  let seed = 12345;
  const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const bytes = kind === "float8" ? 8 : 4;
  const out: number[] = [];
  for (let i = 0; out.length < count; i++) {
    const b = Buffer.alloc(bytes);
    for (let k = 0; k < bytes; k++) b[k] = Math.floor(next() * 256);
    let x = bytes === 8 ? b.readDoubleBE() : b.readFloatBE();
    if (i % 4 === 0) x = Number((Math.floor(next() * 100000) / 10 ** Math.floor(next() * 8)).toPrecision(1 + Math.floor(next() * 4))) * 10 ** Math.floor(next() * 40 - 20);
    if (kind === "float4") x = Math.fround(x);
    if (Number.isFinite(x)) out.push(x);
  }
  return out;
}

test("a sweep of random doubles and floats agrees with Postgres", async () => {
  for (const kind of ["float8", "float4"] as const) for (const x of randomFloats(kind, 150)) await same(kind, x);
});

test("bool, uuid, text, jsonb", async () => {
  await same("bool", true);
  await same("bool", false);
  assert.equal(encodeText("bool", 1, { timeZone: "UTC" }).toString(), "t");
  assert.throws(() => encodeText("bool", "yes", { timeZone: "UTC" }), /as bool/);

  await same("uuid", "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  await same("uuid", "A1B2C3D4-E5F6-7890-ABCD-EF1234567890");
  await same("uuid", "00000000-0000-0000-0000-000000000000");
  for (const v of ["not-a-uuid", "a1b2c3d4-e5f6-7890-abcd-ef123456789g", "a1b2c3d4e5f67890abcdef1234567890", 42]) {
    assert.throws(() => encodeText("uuid", v, { timeZone: "UTC" }), /as uuid/);
  }

  for (const v of ["", "line\nbreak\ttab", "o'hara ß 日本", "back\\slash", "quote\"s", " padded ", "\u{1F600}"]) await same("text", v);
  assert.throws(() => encodeText("text", 42, { timeZone: "UTC" }), /as text/);
  assert.throws(() => encodeText("text", "a\u0000b", { timeZone: "UTC" }), /NUL/);

  // jsonb: text already in jsonb's canonical form is byte-equal; see the module docblock for the declared divergence.
  for (const v of ['{"a": [1, 2.50, null]}', '{"a": 2, "b": 1}', "[1, 2]", '"x"', "100", "null", "true", '{"z": "é 日本"}', '{"k": {"n": -0.0005}, "long key": 1}']) {
    await same("jsonb", v);
  }
  // ... and non-canonical text is what Postgres would not write: the divergence, pinned so a change is noticed.
  const canonical = (await pg("jsonb", '{"b":1,"a":2, "a":3, "e":1e2}', 0)).toString();
  assert.equal(canonical, '{"a": 3, "b": 1, "e": 100}');
  assert.equal(encodeText("jsonb", '{"b":1,"a":2, "a":3, "e":1e2}', { timeZone: "UTC" }).toString(), '{"b":1,"a":2, "a":3, "e":1e2}');
  for (const v of ["{a:1}", "", "[1,]", 42]) assert.throws(() => encodeText("jsonb", v, { timeZone: "UTC" }), /as jsonb/);
});

test("date: text and days since 2000-01-01", async () => {
  for (const v of ["1970-01-01", "2000-01-01", "1999-12-31", "2024-02-29", "9999-12-31", "0001-01-01", "0099-06-15", "2026-09-24"]) await same("date", v);
  for (const v of ["2026-02-29", "2026-02-30", "0000-01-01", "2026-9-4", "2026-13-01", "2026-09-24T00:00:00Z", 20260924]) {
    assert.throws(() => encodeText("date", v, { timeZone: "UTC" }), (err: unknown) => err instanceof EncodeError && err.message.includes("as date"), String(v));
  }
});

const INSTANTS = [
  "1970-01-01T00:00:00Z", "2000-01-01T00:00:00Z", "2026-09-24T23:58:01.000001Z", "2026-09-24T23:58:01.412Z",
  "2026-09-24T23:58:01Z", "9999-12-31T23:59:59.999999Z", "2026-01-15T12:00:00Z", "2026-03-29T00:59:59.5Z",
  "2026-03-29T01:00:00Z", "1900-01-01T00:00:00Z", "1969-12-31T23:59:59.999999Z", "2026-09-24T23:58:01.100000Z",
  "2026-10-25T01:30:00Z", "2026-11-01T05:30:00Z", "2026-04-04T16:30:00Z",
];

test("timestamptz: rendered in the session's zone as Postgres renders it, binary as microseconds since 2000", async () => {
  for (const zone of ["UTC", "Europe/London", "America/New_York", "Asia/Kolkata", "Australia/Adelaide"]) {
    await setTimeZone(zone);
    for (const v of INSTANTS) await same("timestamptz", v, zone);
  }
  await setTimeZone("UTC");
  // Year 1 is fine where the wall clock stays in year 1; in a zone behind UTC it is a BC wall clock, refused.
  await same("timestamptz", "0001-01-01T00:00:00Z", "UTC");
  assert.throws(() => encodeText("timestamptz", "0001-01-01T00:00:00Z", { timeZone: "America/New_York" }), /before year 1/);
  // A naive instant, a space separator and +00:00 are UTC too; the API writes a Z.
  assert.equal(encodeText("timestamptz", "2026-09-24 23:58:01.412", { timeZone: "UTC" }).toString(), "2026-09-24 23:58:01.412+00");
  assert.equal(encodeText("timestamptz", "2026-09-24T23:58:01+00:00", { timeZone: "Asia/Kolkata" }).toString(), "2026-09-25 05:28:01+05:30");
  for (const v of ["2026-09-24T23:58:01.4123456Z", "2026-13-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-24T24:00:00Z", "yesterday",
    "2026-09-24T23:58:01+02:00", "0000-06-01T00:00:00Z", 1758758281412]) {
    assert.throws(() => encodeText("timestamptz", v, { timeZone: "UTC" }), (err: unknown) => err instanceof EncodeError && err.message.includes("as timestamptz"), String(v));
  }
  assert.throws(() => encodeText("timestamptz", "2026-09-24T23:58:01Z", { timeZone: "Not/AZone" }), /time zone "Not\/AZone"/);
});

test("a statement with two columns in two formats, as a driver asks", async () => {
  const reply = await db.execProtocolRaw(wire.extended("SELECT $1::int4, $2::text, $3::bool", ["7", "seven", "t"], [1, 0, 1]));
  assert.deepEqual(wire.replies(reply).map((m) => m.type), ["ParseComplete", "BindComplete", "RowDescription", "DataRow", "CommandComplete", "ReadyForQuery"]);
  const [cell1, cell2, cell3] = wire.singleRow(reply);
  assert.equal(cell1?.toString("hex"), "00000007");
  assert.equal(cell2?.toString("utf8"), "seven");
  assert.equal(cell3?.toString("hex"), "01");
});
