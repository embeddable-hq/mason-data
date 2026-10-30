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

/**
 * THE BYTES `run` COPIES through Buffer.from and Buffer.concat: the work done, so a bound on it holds on a machine under
 * any load, where a clock would not.
 */
function bytesCopied(run: () => void): number {
  const b = Buffer as unknown as { from: (...args: unknown[]) => Buffer; concat: (list: readonly Uint8Array[], length?: number) => Buffer };
  const { from, concat } = b;
  let copied = 0;
  b.from = (...args) => { if (args[0] instanceof Uint8Array) copied += args[0].length; return from(...args); };
  b.concat = (list, length) => { for (const part of list) copied += part.length; return concat(list, length); };
  try { run(); } finally { b.from = from; b.concat = concat; }
  return copied;
}

/** What a decoder costs is proportional to the stream: each byte is copied a few times, whatever the messages. */
function assertLinear(copied: number, stream: Buffer): void {
  assert.ok(copied >= stream.length, `${copied} bytes copied of a ${stream.length}-byte stream: the count no longer sees the decoder's copies`);
  assert.ok(copied <= 3 * stream.length, `${copied} bytes copied to decode ${stream.length}: ${(copied / stream.length).toFixed(1)} times the stream`);
}

test("the backend decoder's work is linear in a reply, in one push or in a socket's chunks (issue 77)", () => {
  // 1 MB of 5,000 rows: the copy of the rest after every message moved 2.6 GB of it
  const stream = Buffer.concat(Array.from({ length: 5_000 }, (_, i) => dataRow([Buffer.alloc(200, i % 251)])));
  let rows = 0;
  assertLinear(bytesCopied(() => { rows = decodeBackend(stream).length; }), stream);
  assert.equal(rows, 5_000);

  const d = new BackendDecoder();
  rows = 0;
  assertLinear(bytesCopied(() => {
    for (let off = 0; off < stream.length; off += 65_536) {
      d.push(stream.subarray(off, off + 65_536));
      while (d.next() !== null) rows++;
    }
  }), stream);
  assert.equal(rows, 5_000);
  assert.equal(d.pending, 0);
});

test("the frontend decoder's work is linear in what a client pipelines, in one push or in a socket's chunks", () => {
  const stream = Buffer.concat(Array.from({ length: 5_000 }, () => wire.query(`SELECT ${"x".repeat(200)}`)));
  const opened = (): FrontendDecoder => {
    const d = new FrontendDecoder();
    d.push(wire.startup({}));
    d.next();
    d.maxLength = MAX_MESSAGE_LENGTH;
    return d;
  };
  let got: FrontendMessage[] = [];
  assertLinear(bytesCopied(() => { got = drain(stream, stream.length, opened()); }), stream);
  assert.equal(got.length, 5_000);
  assertLinear(bytesCopied(() => { got = drain(stream, 65_536, opened()); }), stream);
  assert.equal(got.length, 5_000);
});

test("a message split across pushes is whole at the push that ends it, behind messages already read, and `pending` counts what is left", () => {
  const first = commandComplete("SELECT 1"), second = dataRow([Buffer.from("two"), null]), third = readyForQuery("I");
  const d = new BackendDecoder();
  // the first message whole, and the second to the middle of its length field: fewer than a header's bytes are left
  d.push(Buffer.concat([first, second.subarray(0, 3)]));
  assert.equal(d.pending, first.length + 3);
  assert.deepEqual(d.next(), { type: "CommandComplete", tag: "SELECT 1" });
  assert.equal(d.pending, 3);
  assert.equal(d.next(), null);
  assert.equal(d.pending, 3, "a next() that finds no whole message consumes nothing");

  // the header whole, the body not: the length is read, the frame waits
  d.push(second.subarray(3, 7));
  assert.equal(d.pending, 7);
  assert.equal(d.next(), null);
  assert.equal(d.pending, 7);

  // the rest of it, and the next one whole
  d.push(Buffer.concat([second.subarray(7), third]));
  assert.equal(d.pending, second.length + third.length);
  assert.deepEqual(d.next(), { type: "DataRow", values: [Buffer.from("two"), null] });
  assert.equal(d.pending, third.length);
  assert.deepEqual(d.next(), { type: "ReadyForQuery", status: "I" });
  assert.equal(d.pending, 0);
  assert.equal(d.next(), null);
});

test("a decoded message owns its bytes, and a pushed chunk is the decoder's own: nothing reads memory that moved on", () => {
  const row = dataRow([Buffer.from("kept")]);
  const auth = Buffer.concat([Buffer.from("R"), Buffer.from([0, 0, 0, 10, 0, 0, 0, 5, 1, 2])]);
  const unknown = Buffer.concat([Buffer.from("?"), Buffer.from([0, 0, 0, 7, 7, 8, 9])]);
  const d = new BackendDecoder();
  const chunk = Buffer.concat([row, auth, unknown, row.subarray(0, 2)]);
  d.push(chunk);
  chunk.fill(0xff);     // a caller's buffer is the caller's to reuse from the moment push returns
  const kept = [d.next(), d.next(), d.next()];
  d.push(row.subarray(2));     // a compaction behind them
  assert.deepEqual(d.next(), { type: "DataRow", values: [Buffer.from("kept")] });
  assert.deepEqual(kept, [
    { type: "DataRow", values: [Buffer.from("kept")] },
    { type: "Authentication", code: 5, data: Buffer.from([1, 2]) },
    { type: "Unknown", code: "?", body: Buffer.from([7, 8, 9]) },
  ]);

  // a value too big for the buffer pool has an allocation of its own: a copy, never a view that pins the reply it came in
  const size = Buffer.poolSize + 1;
  const big = decodeBackend(dataRow([Buffer.alloc(size, 1)]))[0];
  assert.equal(big?.type === "DataRow" ? big.values[0]?.buffer.byteLength : null, size);

  const f = new FrontendDecoder();
  f.push(wire.startup({}));
  f.next();
  const frames =Buffer.concat([wire.bind("", "", ["kept"], []), wire.sync()]);
  f.push(frames);
  frames.fill(0xff);
  const bound = f.next();
  assert.equal(f.next()?.type, "Sync");
  f.push(wire.sync());
  assert.equal(f.next()?.type, "Sync");
  assert.deepEqual(bound?.type === "Bind" ? bound.params : null, [Buffer.from("kept")]);
});

test("a frame's length is read where the frame starts, past messages already consumed", () => {
  const ok = readyForQuery("I");
  const header = (code: string, len: number): Buffer => {
    const b = Buffer.alloc(5);
    b.write(code, "latin1");
    b.writeInt32BE(len, 1);
    return b;
  };

  // too long and too short, behind a message read from the same chunk: the limit holds, and the frame stays unread
  const long = new BackendDecoder();
  long.push(Buffer.concat([ok, header("D", MAX_MESSAGE_LENGTH + 1)]));
  assert.equal(long.next()?.type, "ReadyForQuery");
  assert.throws(() => long.next(), /message too long: 67108865 bytes \(the limit is 67108864\)/);
  assert.equal(long.pending, 5);
  const short = new BackendDecoder();
  short.push(Buffer.concat([ok, header("D", 3)]));
  short.next();
  assert.throws(() => short.next(), /length of 3/);

  // a malformed body is consumed before it throws, and the stream goes on behind it
  const malformed = new BackendDecoder();
  malformed.push(Buffer.concat([ok, header("Z", 4), ok]));
  malformed.next();
  assert.throws(() => malformed.next(), (err: unknown) => err instanceof ProtocolError && /malformed backend 'Z' message/.test(err.message));
  assert.equal(malformed.pending, ok.length);
  assert.equal(malformed.next()?.type, "ReadyForQuery");

  // the frontend's: from the startup phase into the typed one inside one chunk, then a frame past the limit
  const f = new FrontendDecoder();
  f.push(Buffer.concat([wire.sslRequest(), wire.startup({}), wire.query("SELECT 1"), header("Q", MAX_MESSAGE_LENGTH + 1)]));
  f.maxLength = MAX_MESSAGE_LENGTH;
  assert.equal(f.next()?.type, "SSLRequest");
  assert.equal(f.next()?.type, "Startup");
  assert.deepEqual(f.next(), { type: "Query", sql: "SELECT 1" });
  assert.throws(() => f.next(), /message too long: 67108865 bytes/);
});

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
