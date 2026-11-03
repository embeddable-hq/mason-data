/**
 * A CLIENT'S SIDE OF THE WIRE, for the tests: frontend messages built from Buffer alone — as libpq builds them,
 * independently of src/api/postgres/protocol.ts's decoder, which they are then held to — and backend replies read
 * through that module's BackendDecoder. tests/postgres-api/protocol.test.ts feeds these to the FrontendDecoder;
 * tests/postgres-api/encode.test.ts sends them to PGlite's `execProtocolRaw` and reads the DataRow back.
 */
import { Buffer } from "node:buffer";
import { decodeBackend, type BackendMessage } from "../../src/api/postgres/protocol.ts";

const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
const int16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

/** A typed frame: type byte, length counting itself, body. */
export function typed(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, "latin1"), int32(body.length + 4), body]);
}

/** A startup-phase frame: no type byte. */
const untyped = (...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([int32(body.length + 4), body]);
};

export const sslRequest = (): Buffer => untyped(int32(80877103));
export const gssencRequest = (): Buffer => untyped(int32(80877104));
export const cancelRequest = (pid: number, secret: number): Buffer => untyped(int32(80877102), int32(pid), int32(secret));

/** Protocol 3.0 with the parameters, closed by the empty key. */
export function startup(params: Record<string, string>): Buffer {
  const parts: Buffer[] = [int32(196608)];
  for (const [k, v] of Object.entries(params)) parts.push(cstr(k), cstr(v));
  parts.push(Buffer.from([0]));
  return untyped(...parts);
}

export const password = (p: string): Buffer => typed("p", cstr(p));
export const query = (sql: string): Buffer => typed("Q", cstr(sql));
export const parse = (name: string, sql: string, paramTypes: number[] = []): Buffer =>
  typed("P", cstr(name), cstr(sql), int16(paramTypes.length), ...paramTypes.map(int32));

/** Every parameter in one format (text unless `paramFormat` is 1); one result format code per column, or one for all. */
export function bind(portal: string, statement: string, params: (Buffer | string | null)[], resultFormats: number[], paramFormat: 0 | 1 = 0): Buffer {
  const values = params.map((p) => {
    if (p === null) return int32(-1);
    const bytes = typeof p === "string" ? Buffer.from(p, "utf8") : p;
    return Buffer.concat([int32(bytes.length), bytes]);
  });
  return typed("B", cstr(portal), cstr(statement), int16(1), int16(paramFormat), int16(params.length), ...values,
    int16(resultFormats.length), ...resultFormats.map(int16));
}

export const describe = (kind: "S" | "P", name: string): Buffer => typed("D", Buffer.from(kind, "latin1"), cstr(name));
export const execute = (portal: string, maxRows = 0): Buffer => typed("E", cstr(portal), int32(maxRows));
export const close = (kind: "S" | "P", name: string): Buffer => typed("C", Buffer.from(kind, "latin1"), cstr(name));
export const sync = (): Buffer => typed("S");
export const flush = (): Buffer => typed("H");
export const terminate = (): Buffer => typed("X");

/** The extended-protocol sequence for one statement on the unnamed statement and portal: Parse, Bind, Describe the
 *  portal, Execute, Sync — what a driver sends for a prepared query, in one buffer. */
export function extended(sql: string, params: (Buffer | string | null)[], resultFormats: number[], paramFormat: 0 | 1 = 0): Buffer {
  return Buffer.concat([parse("", sql), bind("", "", params, resultFormats, paramFormat), describe("P", ""), execute(""), sync()]);
}

/** The backend's reply, as messages. */
export const replies = (bytes: Buffer | Uint8Array): BackendMessage[] => decodeBackend(bytes);

/** The one DataRow of a reply, or the ErrorResponse's message as the failure. */
export function singleRow(bytes: Buffer | Uint8Array): (Buffer | null)[] {
  const ms = replies(bytes);
  const err = ms.find((m) => m.type === "ErrorResponse");
  if (err !== undefined && err.type === "ErrorResponse") throw new Error(`Postgres refused it: ${err.fields.M} (${err.fields.C})`);
  const rows = ms.filter((m) => m.type === "DataRow");
  if (rows.length !== 1) throw new Error(`expected one DataRow, got ${rows.length} among ${ms.map((m) => m.type).join(", ")}`);
  const row = rows[0]!;
  return row.type === "DataRow" ? row.values : [];
}

/** an unsigned 16-bit big-endian number (a port, a length) */
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

/**
 * A PROXY protocol v2 header as haproxy's proxy-protocol.txt (section 2.2) lays it out, built here from the spec alone,
 * never from src/api/postgres/proxy.ts: the 12-byte signature, version 2 and the command (0 LOCAL, 1 PROXY), the family
 * and transport byte, the length of what follows, then `body` (the addresses and any TLVs).
 */
export function proxyV2(command: number, family: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from("0d0a0d0a000d0a515549540a", "hex"), Buffer.from([0x20 | command, family]), u16(body.length), body]);
}

/** A TLV: its type, a 2-byte length and the value. */
export const proxyTlv = (type: number, value: Buffer): Buffer => Buffer.concat([Buffer.from([type]), u16(value.length), value]);

/** A PROXY command's header for TCP over IPv4 (0x11): source, destination, their ports, then `tlvs`. */
export function proxyV2Inet4(source: string, sourcePort: number, destination = "192.0.2.1", destinationPort = 5433, tlvs: Buffer = Buffer.alloc(0)): Buffer {
  const ip = (a: string): Buffer => Buffer.from(a.split(".").map(Number));
  return proxyV2(1, 0x11, Buffer.concat([ip(source), ip(destination), u16(sourcePort), u16(destinationPort), tlvs]));
}

/** A PROXY command's header for TCP over IPv6 (0x21): each address as its 32 hex digits. */
export function proxyV2Inet6(sourceHex: string, sourcePort: number, destinationHex = "20010db8000000000000000000000001", destinationPort = 5433, tlvs: Buffer = Buffer.alloc(0)): Buffer {
  return proxyV2(1, 0x21, Buffer.concat([Buffer.from(sourceHex, "hex"), Buffer.from(destinationHex, "hex"), u16(sourcePort), u16(destinationPort), tlvs]));
}
