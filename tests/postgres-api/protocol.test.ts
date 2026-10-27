/**
 * The wire framing, both directions: every backend builder reads back through BackendDecoder as what it was built
 * from; the FrontendDecoder reads a client's stream however it is chunked (one byte at a time), through the startup
 * phase, an SSLRequest followed by a Startup, an unknown type byte (decoded, never thrown on) and a frame too long
 * (refused, naming the length). The frontend messages come from tests/postgres-api/wire.ts, built with Buffer alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  FrontendDecoder, BackendDecoder, decodeBackend, ProtocolError, MAX_MESSAGE_LENGTH, MAX_STARTUP_LENGTH, sslResponse,
  authenticationCleartextPassword, authenticationOk, parameterStatus, backendKeyData, readyForQuery, rowDescription,
  dataRow, commandComplete, emptyQueryResponse, parseComplete, bindComplete, closeComplete, noData,
  parameterDescription, portalSuspended, errorResponse, noticeResponse, type FrontendMessage,
} from "../../src/api/postgres/protocol.ts";
import * as wire from "./wire.ts";

/** Everything a decoder yields for a stream pushed in chunks of `chunk` bytes. */
function drain(stream: Buffer, chunk: number, decoder = new FrontendDecoder()): FrontendMessage[] {
  const out: FrontendMessage[] = [];
  for (let off = 0; off < stream.length; off += chunk) {
    decoder.push(stream.subarray(off, Math.min(off + chunk, stream.length)));
    for (let m = decoder.next(); m !== null; m = decoder.next()) out.push(m);
  }
  return out;
}

test("every backend builder decodes back to what it was built from", () => {
  const fields = [
    { name: "id", typeOid: 20, typeSize: 8, typeModifier: -1, format: 0 as const },
    { name: "when", typeOid: 1184, typeSize: 8, typeModifier: -1, format: 1 as const, tableOid: 16384, columnAttr: 2 },
  ];
  const err = { severity: "ERROR", code: "42601", message: "syntax error at or near \"FROM\"", detail: "d", hint: "h", position: 8 };
  const built = Buffer.concat([
    authenticationCleartextPassword(), authenticationOk(), parameterStatus("server_version", "16.0"),
    backendKeyData(1234, -5), readyForQuery("I"), rowDescription(fields),
    dataRow([Buffer.from("42"), null, Buffer.alloc(0)]), commandComplete("SELECT 1"), emptyQueryResponse(),
    parseComplete(), bindComplete(), closeComplete(), noData(), parameterDescription([25, 23]), portalSuspended(),
    errorResponse(err), noticeResponse({ severity: "NOTICE", code: "00000", message: "hello" }),
  ]);
  assert.deepEqual(decodeBackend(built), [
    { type: "AuthenticationCleartextPassword" },
    { type: "AuthenticationOk" },
    { type: "ParameterStatus", name: "server_version", value: "16.0" },
    { type: "BackendKeyData", pid: 1234, secret: -5 },
    { type: "ReadyForQuery", status: "I" },
    { type: "RowDescription", fields: [
      { name: "id", tableOid: 0, columnAttr: 0, typeOid: 20, typeSize: 8, typeModifier: -1, format: 0 },
      { name: "when", tableOid: 16384, columnAttr: 2, typeOid: 1184, typeSize: 8, typeModifier: -1, format: 1 },
    ] },
    { type: "DataRow", values: [Buffer.from("42"), null, Buffer.alloc(0)] },
    { type: "CommandComplete", tag: "SELECT 1" },
    { type: "EmptyQueryResponse" },
    { type: "ParseComplete" },
    { type: "BindComplete" },
    { type: "CloseComplete" },
    { type: "NoData" },
    { type: "ParameterDescription", oids: [25, 23] },
    { type: "PortalSuspended" },
    { type: "ErrorResponse", fields: { S: "ERROR", V: "ERROR", C: "42601", M: err.message, D: "d", H: "h", P: "8" } },
    { type: "NoticeResponse", fields: { S: "NOTICE", V: "NOTICE", C: "00000", M: "hello" } },
  ]);
  // The error fields are written in the standard order, each NUL-terminated, the list closed by a zero byte.
  const e = errorResponse({ severity: "ERROR", code: "0A000", message: "no" });
  assert.equal(e.subarray(5).toString("latin1"), "SERROR\0VERROR\0C0A000\0Mno\0\0");
  assert.equal(e.readInt32BE(1), e.length - 1);
  assert.deepEqual(sslResponse(true), Buffer.from("S"));
  assert.deepEqual(sslResponse(false), Buffer.from("N"));
});

test("the backend decoder reads a stream in pieces and reports a partial tail", () => {
  const stream = Buffer.concat([readyForQuery("T"), commandComplete("SELECT 2")]);
  const d = new BackendDecoder();
  const seen: string[] = [];
  for (const byte of stream) {
    d.push(Buffer.from([byte]));
    for (let m = d.next(); m !== null; m = d.next()) seen.push(m.type);
  }
  assert.deepEqual(seen, ["ReadyForQuery", "CommandComplete"]);
  assert.equal(d.pending, 0);
  assert.throws(() => decodeBackend(stream.subarray(0, stream.length - 1)), /13 trailing byte/);
  assert.deepEqual(decodeBackend(Buffer.concat([Buffer.from("?"), Buffer.from([0, 0, 0, 5, 9])])),
    [{ type: "Unknown", code: "?", body: Buffer.from([9]) }]);
});

test("the frontend decoder reads the startup phase, then every typed message, split at any byte", () => {
  const stream = Buffer.concat([
    wire.startup({ user: "alice", database: "shop", TimeZone: "Europe/London" }),
    wire.password("tok.en"),
    wire.query("SELECT 1"),
    wire.parse("s1", "SELECT $1::int8", [20]),
    wire.bind("p1", "s1", ["42", null, Buffer.from([0, 255])], [0, 1]),
    wire.describe("S", "s1"),
    wire.describe("P", "p1"),
    wire.execute("p1", 100),
    wire.close("S", "s1"),
    wire.flush(),
    wire.sync(),
    wire.typed("F", Buffer.from([0, 0, 0, 1])),
    wire.terminate(),
  ]);
  const expected: FrontendMessage[] = [
    { type: "Startup", major: 3, minor: 0, params: { user: "alice", database: "shop", TimeZone: "Europe/London" } },
    { type: "Password", password: "tok.en" },
    { type: "Query", sql: "SELECT 1" },
    { type: "Parse", name: "s1", sql: "SELECT $1::int8", paramTypes: [20] },
    { type: "Bind", portal: "p1", statement: "s1", paramFormats: [0], params: [Buffer.from("42"), null, Buffer.from([0, 255])], resultFormats: [0, 1] },
    { type: "Describe", kind: "S", name: "s1" },
    { type: "Describe", kind: "P", name: "p1" },
    { type: "Execute", portal: "p1", maxRows: 100 },
    { type: "Close", kind: "S", name: "s1" },
    { type: "Flush" },
    { type: "Sync" },
    { type: "Unknown", code: "F" },
    { type: "Terminate" },
  ];
  for (const chunk of [1, 2, 3, 7, stream.length]) assert.deepEqual(drain(stream, chunk), expected, `chunked by ${chunk}`);
});

test("after an SSLRequest the next message is a startup message again; a CancelRequest is one too", () => {
  const d = new FrontendDecoder();
  assert.equal(d.inStartupPhase, true);
  const stream = Buffer.concat([wire.sslRequest(), wire.gssencRequest(), wire.startup({ user: "u" }), wire.query("SELECT 1")]);
  assert.deepEqual(drain(stream, 1, d), [
    { type: "SSLRequest" }, { type: "GSSENCRequest" }, { type: "Startup", major: 3, minor: 0, params: { user: "u" } },
    { type: "Query", sql: "SELECT 1" },
  ]);
  assert.equal(d.inStartupPhase, false);
  // A TLS upgrade reuses the decoder over the new stream: the server puts it back in the startup phase.
  d.expectStartup();
  assert.deepEqual(drain(wire.startup({ user: "v" }), 5, d), [{ type: "Startup", major: 3, minor: 0, params: { user: "v" } }]);
  assert.deepEqual(drain(wire.cancelRequest(77, -1), 3), [{ type: "CancelRequest", pid: 77, secret: -1 }]);
  // A typed message where a startup message is due reads its type byte as the top of the length: refused as too long,
  // never read as a command.
  assert.throws(() => drain(wire.query("SELECT 1"), 100), /message too long: 1358954496 bytes/);
});

test("a frame too long, a negative length and a lying count are refused, naming what was wrong", () => {
  const tooLong = Buffer.alloc(5);
  tooLong.write("Q");
  tooLong.writeInt32BE(MAX_MESSAGE_LENGTH + 1, 1);
  const d = new FrontendDecoder();
  d.expectStartup();
  d.push(wire.startup({}));
  assert.equal(d.next()?.type, "Startup");
  d.push(tooLong);
  assert.throws(() => d.next(), (err: unknown) => err instanceof ProtocolError && /67108865 bytes/.test(err.message));

  const short = new FrontendDecoder();
  short.push(Buffer.from([0, 0, 0, 3]));
  assert.throws(() => short.next(), /length of 3/);

  // A Bind that announces three parameters and carries one.
  const lying = new FrontendDecoder();
  lying.push(wire.startup({}));
  lying.next();
  const body = Buffer.concat([Buffer.from("\0\0"), Buffer.from([0, 0, 0, 3, 0, 0, 0, 1, 0x41])]);
  lying.push(wire.typed("B", body));
  assert.throws(() => lying.next(), (err: unknown) => err instanceof ProtocolError && /'B' message: needs/.test(err.message));

  const unterminated = new FrontendDecoder();
  unterminated.push(wire.startup({}));
  unterminated.next();
  unterminated.push(wire.typed("Q", Buffer.from("SELECT 1")));
  assert.throws(() => unterminated.next(), /no terminating NUL/);
});

test("before authentication a frame is at most startup-sized; the session lifts the limit; pieces are assembled once", () => {
  // a 64 MiB frame was accepted from anyone who connected (review of #480): now a Password (or anything else before
  // AuthenticationOk) is capped at Postgres's own startup-packet size
  const d = new FrontendDecoder();
  assert.equal(d.maxLength, MAX_STARTUP_LENGTH);
  d.push(wire.startup({}));
  assert.equal(d.next()?.type, "Startup");
  d.push(wire.typed("p", Buffer.alloc(MAX_STARTUP_LENGTH)));
  assert.throws(() => d.next(), (err: unknown) => err instanceof ProtocolError && /10004 bytes \(the limit is 10000\)/.test(err.message));

  // the startup message itself is capped whatever the session allows
  const s = new FrontendDecoder();
  s.maxLength = MAX_MESSAGE_LENGTH;
  const header = Buffer.alloc(4);
  header.writeInt32BE(MAX_STARTUP_LENGTH + 1);
  s.push(header);
  assert.throws(() => s.next(), /10001 bytes \(the limit is 10000\)/);

  // lifted (as the session does after AuthenticationOk): a 200 KB statement in 1000-byte pieces is one message, and the
  // pieces of an incomplete frame are held, not re-copied, until it is whole
  const lifted = new FrontendDecoder();
  lifted.push(wire.startup({}));
  lifted.next();
  lifted.maxLength = MAX_MESSAGE_LENGTH;
  const sql = " ".repeat(200_000) + "SELECT 1";
  const got = drain(wire.typed("Q", Buffer.from(sql + "\0")), 1000, lifted);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { type: "Query", sql });
});
