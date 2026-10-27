/**
 * THE POSTGRES WIRE PROTOCOL, VERSION 3.0 — framing only. What a frontend (a BI tool, JDBC, psql) sends, decoded
 * into plain objects; what a backend answers, built as bytes; and the backend side decoded too, for the tests and the
 * catalog sidecar that read a real Postgres's replies. This module knows no
 * SQL, no type and no value: a parameter is bytes, a column of a DataRow is bytes, and the encoding of a value is
 * src/api/postgres/encode.ts's, held to Postgres byte for byte by its own harness.
 *
 * WHY HAND-WRITTEN, AND DEPENDENCY-FREE (node:buffer only), as the ClickHouse stack's token module was: the whole risk surface of
 * a wire library is its decoder, and this one can be read in full. Every message is one type byte, an int32 length
 * that COUNTS ITSELF but not the type byte, and a body; the first message of a connection has no type byte (length +
 * a protocol code: an SSLRequest, a GSSENCRequest, a CancelRequest, or the version followed by the startup
 * parameters), and after an SSLRequest or a GSSENCRequest the frontend sends another startup-phase message, so the
 * decoder stays in that phase by itself (`expectStartup` puts it back there for a decoder reused over a TLS upgrade).
 *
 * THE RULES THIS EMBODIES:
 *  - A message type the server does not implement is DECODED, as `Unknown {code}`, never skipped and never thrown on:
 *    the server refuses it by name with an ErrorResponse, which is what a tool can act on (CLAUDE.md, "an error a
 *    developer meets says what to do about it"). Only a malformed frame — a length under 4, a length over
 *    MAX_MESSAGE_LENGTH, a string without its NUL, a count the body cannot hold — throws, naming what was wrong, and
 *    the server closes the connection: there is no way to resynchronise a corrupt stream.
 *  - `next()` returns null for "need more bytes" and never a partial message: a chunk may split a message anywhere,
 *    one byte at a time included (tests/postgres-api/protocol.test.ts pushes a byte at a time).
 *  - Strings are UTF-8 (`client_encoding` is UTF8 or refused, §4.6); a parameter's bytes are passed through untouched.
 */

/** Longer than this and a frame is refused: no query, parameter or row this API carries comes near it, and a
 *  length field read from a stray byte must not make the decoder wait for gigabytes. */
export const MAX_MESSAGE_LENGTH = 64 * 1024 * 1024;
/** Postgres's own cap on a startup packet (MAX_STARTUP_PACKET_LENGTH); a Password carries a token, far below it. Before
 *  authentication a client may send nothing larger (review of #480: a 64 MiB frame was accepted from anyone). */
export const MAX_STARTUP_LENGTH = 10_000;

/** The protocol codes a startup-phase message may carry in place of a version. */
export const SSL_REQUEST_CODE = 80877103;
export const GSSENC_REQUEST_CODE = 80877104;
export const CANCEL_REQUEST_CODE = 80877102;

export type FrontendMessage =
  | { type: "SSLRequest" }
  | { type: "GSSENCRequest" }
  | { type: "CancelRequest"; pid: number; secret: number }
  | { type: "Startup"; major: number; minor: number; params: Record<string, string> }
  | { type: "Password"; password: string }
  | { type: "Query"; sql: string }
  | { type: "Parse"; name: string; sql: string; paramTypes: number[] }
  | { type: "Bind"; portal: string; statement: string; paramFormats: number[]; params: (Buffer | null)[]; resultFormats: number[] }
  | { type: "Describe"; kind: "S" | "P"; name: string }
  | { type: "Execute"; portal: string; maxRows: number }
  | { type: "Close"; kind: "S" | "P"; name: string }
  | { type: "Sync" }
  | { type: "Flush" }
  | { type: "Terminate" }
  /** any other type byte (a FunctionCall `F`, COPY's `d`/`c`/`f`, …): the server refuses it by name */
  | { type: "Unknown"; code: string };

/** A frame the decoder cannot make sense of; the server closes the connection on it. */
export class ProtocolError extends Error {}

/** A cursor over one message body: every read checks its bounds, so a lying count throws instead of reading past the
 *  body into the next message (or into zeroes). */
class BodyReader {
  #buf: Buffer;
  #off = 0;
  readonly #what: string;
  constructor(buf: Buffer, what: string) { this.#buf = buf; this.#what = what; }
  #need(n: number): void {
    if (this.#off + n > this.#buf.length) {
      throw new ProtocolError(`malformed ${this.#what} message: needs ${n} more byte(s) at offset ${this.#off} of a ${this.#buf.length}-byte body`);
    }
  }
  byte(): number { this.#need(1); return this.#buf[this.#off++]!; }
  int16(): number { this.#need(2); const v = this.#buf.readInt16BE(this.#off); this.#off += 2; return v; }
  int32(): number { this.#need(4); const v = this.#buf.readInt32BE(this.#off); this.#off += 4; return v; }
  cstring(): string {
    const end = this.#buf.indexOf(0, this.#off);
    if (end === -1) throw new ProtocolError(`malformed ${this.#what} message: a string at offset ${this.#off} has no terminating NUL`);
    const s = this.#buf.toString("utf8", this.#off, end);
    this.#off = end + 1;
    return s;
  }
  bytes(n: number): Buffer {
    if (n < 0) throw new ProtocolError(`malformed ${this.#what} message: a negative length ${n} at offset ${this.#off}`);
    this.#need(n);
    const b = Buffer.from(this.#buf.subarray(this.#off, this.#off + n));
    this.#off += n;
    return b;
  }
  count(what: string): number {
    const n = this.int16();
    if (n < 0) throw new ProtocolError(`malformed ${this.#what} message: ${n} ${what}`);
    return n;
  }
  rest(): Buffer { return Buffer.from(this.#buf.subarray(this.#off)); }
  get done(): boolean { return this.#off >= this.#buf.length; }
}

/** The next frame of `buf` at `off`: its length (type byte excluded, length field included) when the frame is whole,
 *  or null for "need more bytes". `headerLength` is 5 with a type byte, 4 in the startup phase. */
/** The length field of the frame at the start of `buf` (type byte excluded, the field itself included), checked
 *  against `limit`; `headerLength` is 5 with a type byte, 4 in the startup phase. */
function frameLength(buf: Buffer, headerLength: 4 | 5, limit: number): number {
  const len = buf.readInt32BE(headerLength - 4);
  if (len < 4) throw new ProtocolError(`malformed message: a length of ${len} (the length counts itself, so it is at least 4)`);
  if (len > limit) throw new ProtocolError(`message too long: ${len} bytes (the limit is ${limit})`);
  return len;
}

/** Decodes what a frontend sends. Push every chunk the socket delivers; call `next()` until it returns null. */
export class FrontendDecoder {
  /** the bytes of the frame being assembled, once its header has arrived */
  #buf: Buffer = Buffer.alloc(0);
  /** chunks received since, concatenated ONCE, when the frame they complete is whole (never per chunk: a frame in
   *  64 KiB pieces re-copied everything received so far on every piece — review of #480) */
  #pending: Buffer[] = [];
  #pendingLength = 0;
  #startup = true;
  /** the largest frame accepted: MAX_STARTUP_LENGTH until the session says it is authenticated */
  maxLength: number = MAX_STARTUP_LENGTH;

  /** Back to the startup phase: the next message has no type byte. A fresh decoder starts there; after an SSLRequest
   *  or GSSENCRequest the decoder stays there by itself. */
  expectStartup(): void { this.#startup = true; }

  get inStartupPhase(): boolean { return this.#startup; }

  push(chunk: Buffer): void {
    this.#pending.push(Buffer.from(chunk));
    this.#pendingLength += chunk.length;
  }

  /** Makes `#buf` hold at least `need` bytes when that many have arrived, moving the pending chunks in with one copy. */
  #assemble(need: number): boolean {
    if (this.#buf.length >= need) return true;
    if (this.#buf.length + this.#pendingLength < need) return false;
    this.#buf = Buffer.concat([this.#buf, ...this.#pending]);
    this.#pending = [];
    this.#pendingLength = 0;
    return true;
  }

  /** The next whole message, or null when more bytes are needed. Throws ProtocolError on a malformed frame. */
  next(): FrontendMessage | null {
    return this.#startup ? this.#nextStartup() : this.#nextTyped();
  }

  /** the next frame's length once its header is here (checked against the limit at once, before its body is held),
   *  or null while the header or the body is still arriving */
  #whole(headerLength: 4 | 5): number | null {
    if (!this.#assemble(headerLength)) return null;
    const len = frameLength(this.#buf, headerLength, this.#startup ? Math.min(this.maxLength, MAX_STARTUP_LENGTH) : this.maxLength);
    return this.#assemble(headerLength - 4 + len) ? len : null;
  }

  #take(headerLength: 4 | 5, len: number): Buffer {
    const body = this.#buf.subarray(headerLength, headerLength - 4 + len);
    this.#buf = Buffer.from(this.#buf.subarray(headerLength - 4 + len));
    return body;
  }

  #nextStartup(): FrontendMessage | null {
    const len = this.#whole(4);
    if (len === null) return null;
    const r = new BodyReader(this.#take(4, len), "startup");
    const code = r.int32();
    if (code === SSL_REQUEST_CODE) return { type: "SSLRequest" };
    if (code === GSSENC_REQUEST_CODE) return { type: "GSSENCRequest" };
    // Anything else ends the startup phase: a CancelRequest closes the connection, a Startup opens the session.
    this.#startup = false;
    if (code === CANCEL_REQUEST_CODE) return { type: "CancelRequest", pid: r.int32(), secret: r.int32() };
    const major = code >>> 16;
    const minor = code & 0xffff;
    const params: Record<string, string> = {};
    // Key/value pairs, each a NUL-terminated string, closed by an empty key. A body that ends without the closing
    // empty key (libpq always sends it) is tolerated as a complete list: nothing can be missing from it.
    while (!r.done) {
      const key = r.cstring();
      if (key === "") break;
      params[key] = r.cstring();
    }
    return { type: "Startup", major, minor, params };
  }

  #nextTyped(): FrontendMessage | null {
    const len = this.#whole(5);
    if (len === null) return null;
    const code = String.fromCharCode(this.#buf[0]!);
    const r = new BodyReader(this.#take(5, len), `'${code}'`);
    switch (code) {
      case "p": return { type: "Password", password: r.cstring() };
      case "Q": return { type: "Query", sql: r.cstring() };
      case "P": {
        const name = r.cstring();
        const sql = r.cstring();
        const n = r.count("parameter types");
        const paramTypes: number[] = [];
        for (let i = 0; i < n; i++) paramTypes.push(r.int32());
        return { type: "Parse", name, sql, paramTypes };
      }
      case "B": {
        const portal = r.cstring();
        const statement = r.cstring();
        const nf = r.count("parameter format codes");
        const paramFormats: number[] = [];
        for (let i = 0; i < nf; i++) paramFormats.push(r.int16());
        const np = r.count("parameters");
        const params: (Buffer | null)[] = [];
        for (let i = 0; i < np; i++) {
          const size = r.int32();
          params.push(size === -1 ? null : r.bytes(size));
        }
        const nr = r.count("result format codes");
        const resultFormats: number[] = [];
        for (let i = 0; i < nr; i++) resultFormats.push(r.int16());
        return { type: "Bind", portal, statement, paramFormats, params, resultFormats };
      }
      case "D":
      case "C": {
        const kind = String.fromCharCode(r.byte());
        if (kind !== "S" && kind !== "P") {
          throw new ProtocolError(`malformed '${code}' message: kind ${JSON.stringify(kind)} is neither 'S' (statement) nor 'P' (portal)`);
        }
        const name = r.cstring();
        return code === "D" ? { type: "Describe", kind, name } : { type: "Close", kind, name };
      }
      case "E": return { type: "Execute", portal: r.cstring(), maxRows: r.int32() };
      case "S": return { type: "Sync" };
      case "H": return { type: "Flush" };
      case "X": return { type: "Terminate" };
      default: return { type: "Unknown", code };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Backend message builders. Each returns one whole frame.

export const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
export const int16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
export const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

/** A typed frame: the type byte, the length (itself included), the body. */
export function frame(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

/** The one-byte answer to an SSLRequest: 'S' (upgrade) or 'N' (continue in the clear). Not a frame. */
export const sslResponse = (accept: boolean): Buffer => Buffer.from(accept ? "S" : "N", "latin1");

export const authenticationCleartextPassword = (): Buffer => frame("R", int32(3));
export const authenticationOk = (): Buffer => frame("R", int32(0));
export const parameterStatus = (name: string, value: string): Buffer => frame("S", cstr(name), cstr(value));
export const backendKeyData = (pid: number, secret: number): Buffer => frame("K", int32(pid), int32(secret));
export const readyForQuery = (status: "I" | "T" | "E"): Buffer => frame("Z", Buffer.from(status, "latin1"));

export interface FieldDescription {
  name: string;
  typeOid: number;
  /** `pg_type.typlen`: -1 for a variable-length type */
  typeSize: number;
  /** `atttypmod`: -1 for none */
  typeModifier: number;
  format: 0 | 1;
  /** the table's OID when the column is a table's, else 0 */
  tableOid?: number | undefined;
  /** the column's attribute number in that table, else 0 */
  columnAttr?: number | undefined;
}

export function rowDescription(fields: FieldDescription[]): Buffer {
  const parts: Buffer[] = [int16(fields.length)];
  for (const f of fields) {
    parts.push(cstr(f.name), int32(f.tableOid ?? 0), int16(f.columnAttr ?? 0), int32(f.typeOid), int16(f.typeSize),
      int32(f.typeModifier), int16(f.format));
  }
  return frame("T", ...parts);
}

/** One row: each column's encoded bytes, or null for SQL NULL (sent as a length of -1). */
export function dataRow(values: (Buffer | null)[]): Buffer {
  const parts: Buffer[] = [int16(values.length)];
  for (const v of values) {
    if (v === null) parts.push(int32(-1));
    else parts.push(int32(v.length), v);
  }
  return frame("D", ...parts);
}

export const commandComplete = (tag: string): Buffer => frame("C", cstr(tag));
export const emptyQueryResponse = (): Buffer => frame("I");
export const parseComplete = (): Buffer => frame("1");
export const bindComplete = (): Buffer => frame("2");
export const closeComplete = (): Buffer => frame("3");
export const noData = (): Buffer => frame("n");
export const portalSuspended = (): Buffer => frame("s");

export function parameterDescription(oids: number[]): Buffer {
  return frame("t", int16(oids.length), ...oids.map(int32));
}

export interface ErrorFields {
  /** `ERROR`, `FATAL`, `PANIC` for an error; `WARNING`, `NOTICE`, `DEBUG`, `INFO`, `LOG` for a notice */
  severity: string;
  /** the SQLSTATE, five characters (`42601` syntax error, `0A000` feature not supported, `28P01` invalid password) */
  code: string;
  message: string;
  detail?: string | undefined;
  hint?: string | undefined;
  /** 1-based CHARACTER position in the statement text, as Postgres counts it */
  position?: number | undefined;
}

/** The standard fields, each a type byte and a NUL-terminated string, closed by a zero byte. `S` and `V` both carry the
 *  severity: `V` is the never-localised one, which clients since 9.6 read. */
function noticeFields(f: ErrorFields): Buffer[] {
  const parts: Buffer[] = [
    Buffer.from("S"), cstr(f.severity), Buffer.from("V"), cstr(f.severity), Buffer.from("C"), cstr(f.code),
    Buffer.from("M"), cstr(f.message),
  ];
  if (f.detail !== undefined) parts.push(Buffer.from("D"), cstr(f.detail));
  if (f.hint !== undefined) parts.push(Buffer.from("H"), cstr(f.hint));
  if (f.position !== undefined) parts.push(Buffer.from("P"), cstr(String(f.position)));
  parts.push(Buffer.from([0]));
  return parts;
}

export const errorResponse = (fields: ErrorFields): Buffer => frame("E", ...noticeFields(fields));
export const noticeResponse = (fields: ErrorFields): Buffer => frame("N", ...noticeFields(fields));

// ---------------------------------------------------------------------------------------------------------------------
// Backend decoding: what a client sees. The server never needs it; the tests hold every builder to it, and the catalog
// sidecar reads a Postgres's replies through it.

export type BackendMessage =
  | { type: "AuthenticationOk" }
  | { type: "AuthenticationCleartextPassword" }
  /** any other authentication request (MD5 5, SASL 10, …), with what follows the code */
  | { type: "Authentication"; code: number; data: Buffer }
  | { type: "ParameterStatus"; name: string; value: string }
  | { type: "BackendKeyData"; pid: number; secret: number }
  | { type: "ReadyForQuery"; status: string }
  | { type: "RowDescription"; fields: Required<FieldDescription>[] }
  | { type: "DataRow"; values: (Buffer | null)[] }
  | { type: "CommandComplete"; tag: string }
  | { type: "EmptyQueryResponse" }
  | { type: "ParseComplete" }
  | { type: "BindComplete" }
  | { type: "CloseComplete" }
  | { type: "NoData" }
  | { type: "ParameterDescription"; oids: number[] }
  | { type: "PortalSuspended" }
  | { type: "ErrorResponse"; fields: Record<string, string> }
  | { type: "NoticeResponse"; fields: Record<string, string> }
  | { type: "Unknown"; code: string; body: Buffer };

function decodeNoticeFields(r: BodyReader): Record<string, string> {
  const fields: Record<string, string> = {};
  for (;;) {
    const code = r.byte();
    if (code === 0) break;
    fields[String.fromCharCode(code)] = r.cstring();
  }
  return fields;
}

function decodeBackendBody(code: string, body: Buffer): BackendMessage {
  const r = new BodyReader(body, `backend '${code}'`);
  switch (code) {
    case "R": {
      const auth = r.int32();
      if (auth === 0) return { type: "AuthenticationOk" };
      if (auth === 3) return { type: "AuthenticationCleartextPassword" };
      return { type: "Authentication", code: auth, data: r.rest() };
    }
    case "S": return { type: "ParameterStatus", name: r.cstring(), value: r.cstring() };
    case "K": return { type: "BackendKeyData", pid: r.int32(), secret: r.int32() };
    case "Z": return { type: "ReadyForQuery", status: String.fromCharCode(r.byte()) };
    case "T": {
      const n = r.count("fields");
      const fields: Required<FieldDescription>[] = [];
      for (let i = 0; i < n; i++) {
        const name = r.cstring();
        const tableOid = r.int32();
        const columnAttr = r.int16();
        const typeOid = r.int32();
        const typeSize = r.int16();
        const typeModifier = r.int32();
        const format = r.int16();
        if (format !== 0 && format !== 1) throw new ProtocolError(`malformed RowDescription: field ${name} has format code ${format}`);
        fields.push({ name, tableOid, columnAttr, typeOid, typeSize, typeModifier, format });
      }
      return { type: "RowDescription", fields };
    }
    case "D": {
      const n = r.count("columns");
      const values: (Buffer | null)[] = [];
      for (let i = 0; i < n; i++) {
        const size = r.int32();
        values.push(size === -1 ? null : r.bytes(size));
      }
      return { type: "DataRow", values };
    }
    case "C": return { type: "CommandComplete", tag: r.cstring() };
    case "I": return { type: "EmptyQueryResponse" };
    case "1": return { type: "ParseComplete" };
    case "2": return { type: "BindComplete" };
    case "3": return { type: "CloseComplete" };
    case "n": return { type: "NoData" };
    case "s": return { type: "PortalSuspended" };
    case "t": {
      const n = r.count("parameters");
      const oids: number[] = [];
      for (let i = 0; i < n; i++) oids.push(r.int32());
      return { type: "ParameterDescription", oids };
    }
    case "E": return { type: "ErrorResponse", fields: decodeNoticeFields(r) };
    case "N": return { type: "NoticeResponse", fields: decodeNoticeFields(r) };
    default: return { type: "Unknown", code, body: r.rest() };
  }
}

/** Decodes what a backend sends, chunk by chunk, as FrontendDecoder does for the other direction. */
export class BackendDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk]);
  }

  next(): BackendMessage | null {
    if (this.#buf.length < 5) return null;
    const len = frameLength(this.#buf, 5, MAX_MESSAGE_LENGTH);
    if (this.#buf.length < 1 + len) return null;
    const code = String.fromCharCode(this.#buf[0]!);
    const body = this.#buf.subarray(5, 1 + len);
    this.#buf = Buffer.from(this.#buf.subarray(1 + len));
    return decodeBackendBody(code, body);
  }

  /** bytes pushed and not yet consumed by a whole message */
  get pending(): number { return this.#buf.length; }
}

/** Every message of a buffer that holds whole messages only (a `execProtocolRaw` reply, a builder's output). A
 *  trailing partial message throws: the caller promised a complete reply. */
/** The whole frames of a backend reply, each with its type byte, undecoded: what the server relays or inspects. */
export function splitFrames(reply: Uint8Array): Array<{ type: string; frame: Buffer }> {
  const buf = Buffer.from(reply.buffer, reply.byteOffset, reply.byteLength);
  const out: Array<{ type: string; frame: Buffer }> = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 5 > buf.length) throw new ProtocolError(`the reply ends inside a frame header at byte ${off}`);
    const len = buf.readInt32BE(off + 1);
    if (len < 4 || off + 1 + len > buf.length) throw new ProtocolError(`the reply has a frame of length ${len} at byte ${off}`);
    out.push({ type: String.fromCharCode(buf[off]!), frame: Buffer.from(buf.subarray(off, off + 1 + len)) });
    off += 1 + len;
  }
  return out;
}

/** The fields of an ErrorResponse or NoticeResponse frame (type byte included), by their one-letter code. */
export function decodeNoticeFrame(frame: Buffer): Record<string, string> {
  return decodeNoticeFields(new BodyReader(frame.subarray(5), `backend '${String.fromCharCode(frame[0]!)}'`));
}

export function decodeBackend(buffer: Buffer | Uint8Array): BackendMessage[] {
  const d = new BackendDecoder();
  d.push(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  const out: BackendMessage[] = [];
  for (let m = d.next(); m !== null; m = d.next()) out.push(m);
  if (d.pending !== 0) throw new ProtocolError(`decodeBackend: ${d.pending} trailing byte(s) do not make a whole message`);
  return out;
}
