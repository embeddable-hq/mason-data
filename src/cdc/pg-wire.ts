/**
 * A POSTGRES CLIENT, DEPENDENCY-FREE, for the change reader: exactly what Mason needs from the
 * wire protocol and nothing else — startup (TLS per libpq's sslmode), password / md5 / SCRAM-SHA-256 auth,
 * the simple query protocol, and the streaming replication sub-protocol (CopyBoth, XLogData, keepalives,
 * standby status updates). Every value travels as TEXT: the reader turns text into ClickHouse values itself,
 * so no binary type decoding lives here.
 *
 * Why not `pg`: the scripts here run with no node_modules on the test server, the replication sub-protocol is a
 * separate package on top of it, and the part Mason uses is a few hundred lines this file can hold whole.
 *
 * Protocol reference (Postgres's own documentation): https://www.postgresql.org/docs/current/protocol-message-formats.html and
 * https://www.postgresql.org/docs/current/protocol-replication.html.
 */
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";

export interface PgConnectOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode?: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  /** `database`: a walsender for logical replication (START_REPLICATION, CREATE_REPLICATION_SLOT). */
  replication?: boolean;
  applicationName?: string;
  connectTimeoutMs?: number;
  /** the session's text forms, sent at startup in place of the change reader's (ISO dates in UTC, round-trippable floats,
   *  ISO 8601 intervals): `mason mcp` sends none, so an agent reads the text Postgres's defaults print, as psql does */
  textForms?: ReadonlyArray<readonly [name: string, value: string]>;
}

/** A server ErrorResponse, with its SQLSTATE: callers branch on `code` (42P01, 42710, 55006 …). */
export class PgError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  /** the ErrorResponse's own fields, by their one-letter codes (M the message alone, H the hint, P the position) */
  readonly fields: Readonly<Record<string, string>>;
  constructor(fields: Record<string, string>) {
    super(`${fields.S ?? "ERROR"}: ${fields.M ?? "unknown error"}${fields.D ? ` (${fields.D})` : ""}`);
    this.code = fields.C ?? "";
    this.detail = fields.D;
    this.fields = fields;
  }
}

/** A column of a RowDescription: its name, type OID and type modifier (format_type's two arguments). */
export interface RowField { name: string; typeOid: number; typmod: number }

/** One statement through the extended protocol (`extended`): its columns, its rows as text, whether a row count cut it. */
export interface ExtendedResult {
  fields: RowField[];
  rows: (string | null)[][];
  /** the server suspended the portal at the row count: rows were left */
  suspended: boolean;
  /** CommandComplete's tag (`SELECT 3`); "" when the portal was suspended */
  command: string;
  /** the text held no statement (EmptyQueryResponse: only comments or whitespace) */
  empty: boolean;
}

export interface QueryResult {
  fields: string[];
  rows: (string | null)[][];
  command: string;
}

/** A message of the replication stream: an XLogData ('w') or a primary keepalive ('k'). */
export type ReplicationMessage =
  | { kind: "data"; start: bigint; walEnd: bigint; data: Buffer }
  | { kind: "keepalive"; walEnd: bigint; replyRequested: boolean };

interface BackendMessage { type: string; body: Buffer }

/** Microseconds between the Unix epoch and Postgres's (2000-01-01). */
const PG_EPOCH_OFFSET_US = 946_684_800_000_000n;

export class PgConnection {
  private socket!: net.Socket | tls.TLSSocket;
  private buf: Buffer = Buffer.alloc(0);
  /** chunks received after `buf` while the message they complete is still short of `need` bytes (onData) */
  private chunks: Buffer[] = [];
  private chunked = 0;
  private waiting: ((m: BackendMessage | Error) => void) | null = null;
  private queue: BackendMessage[] = [];
  /** the bytes of the messages in `queue`: what backpressure bounds (onData) */
  private queued = 0;
  private closedWith: Error | null = null;
  /** Server parameters (server_version, TimeZone, …) as reported at startup. */
  readonly parameters: Record<string, string> = {};
  private readonly opts: PgConnectOptions;

  private constructor(opts: PgConnectOptions) { this.opts = opts; }

  static async connect(opts: PgConnectOptions): Promise<PgConnection> {
    const c = new PgConnection(opts);
    await c.open();
    return c;
  }

  // ------------------------------------------------------------------ transport

  /**
   * THE CONNECT TIMEOUT BOUNDS THE WHOLE HANDSHAKE: it once covered the TCP connect alone, and the SSL
   * answer and the startup exchange waited for ever. A socket something accepts and never answers — a port
   * proxy in front of a container that is restarting, a half-open connection — hung the reader's reconnect loop
   * past the test's 90 s with no "the source is away" line to say so (the ClickHouse stack's change-reader fill test,
   * twice in CI). One deadline from the first SYN to ReadyForQuery; past it the socket is destroyed and the error reads as
   * the source being away (reader.ts `sourceAway`), so the reconnect loop tries again.
   */
  private async open(): Promise<void> {
    const o = this.opts;
    const deadline = o.connectTimeoutMs ?? 15_000;
    let pending: net.Socket | tls.TLSSocket | null = null;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { pending?.destroy(); reject(new Error(`connecting to ${o.host}:${o.port} timed out`)); }, deadline);
    });
    try { await Promise.race([this.handshake((s) => { pending = s; }), timedOut]); }
    finally { clearTimeout(timer); }
  }

  /** TCP connect, the SSL negotiation and the startup exchange; `hold` is told the live socket, for a timeout to destroy. */
  private async handshake(hold: (s: net.Socket | tls.TLSSocket) => void): Promise<void> {
    const sock = await transport(this.opts, hold);
    this.socket = sock;
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new Error("connection closed by the server")));
    await this.startup();
  }

  /** the server's key for this session (BackendKeyData), for a CancelRequest */
  private key: { pid: number; secret: number } | null = null;

  /**
   * ASK THE SERVER TO CANCEL THIS SESSION'S RUNNING STATEMENT (Postgres's CancelRequest, on a connection of its own,
   * TLS as this one's sslmode): the statement ends with 57014 on this connection, which stays usable. Resolves once
   * the request is written.
   */
  async cancel(): Promise<void> {
    const key = this.key;
    if (key === null) throw new Error("the server sent no key for this session: it cannot be cancelled");
    let held: net.Socket | tls.TLSSocket | null = null;
    const timer = setTimeout(() => { (held as net.Socket | tls.TLSSocket | null)?.destroy(); }, this.opts.connectTimeoutMs ?? 15_000);
    try {
      const s = await transport(this.opts, (x) => { held = x; });
      const b = Buffer.alloc(16);
      b.writeInt32BE(16, 0); b.writeInt32BE(80877102, 4); b.writeInt32BE(key.pid, 8); b.writeInt32BE(key.secret, 12);
      await new Promise<void>((resolve, reject) => { s.once("error", reject); s.end(b, () => resolve()); });
    } finally { clearTimeout(timer); }
  }

  private fail(e: Error): void {
    if (this.closedWith) return;
    this.closedWith = e;
    const w = this.waiting;
    this.waiting = null;
    if (w) w(e);
  }

  private onData(d: Buffer): void {
    // A LARGE MESSAGE ARRIVES IN MANY CHUNKS, and joining each chunk to what came before copies it over and over:
    // quadratic in the message, all of it off the V8 heap, where no heap limit makes the collector hurry. A row with
    // a multi-megabyte payload took the reader past its container's 512 MiB (a cgroup OOM kill, the test server's first
    // copy). So chunks wait in a list until the message they belong to is complete, and join once.
    this.chunks.push(d);
    this.chunked += d.length;
    const have = this.buf.length + this.chunked;
    const need = this.buf.length >= 5 ? 1 + this.buf.readInt32BE(1) : 5;
    if (have < need) return;
    this.buf = Buffer.concat([this.buf, ...this.chunks], have);
    this.chunks = [];
    this.chunked = 0;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) break;
      const msg = { type: String.fromCharCode(this.buf[0]!), body: this.buf.subarray(5, 1 + len) };
      this.buf = this.buf.subarray(1 + len);
      if (msg.type === "N") continue; // NoticeResponse: informational
      if (msg.type === "S") { this.parameter(msg.body); continue; }
      const w = this.waiting;
      if (w) { this.waiting = null; w(msg); } else { this.queue.push(msg); this.queued += msg.body.length; }
    }
    // Backpressure: a consumer that is not reading (the reader flushing into ClickHouse) must not let the
    // stream pile up in memory — counted in messages AND bytes, since one row may carry megabytes. The queue
    // resumes the socket when it drains.
    if (this.queue.length > 1000 || this.queued > QUEUE_PAUSE_BYTES) this.socket.pause();
  }

  private parameter(body: Buffer): void {
    const [k, v] = cstrings(body, 2);
    if (k !== undefined) this.parameters[k] = v ?? "";
  }

  /** the next message of a statement's reply; when the server closed the connection after an ErrorResponse it sent
   *  (a FATAL: a user removed, a shutdown) and before ReadyForQuery, that error — never the bare "connection closed" */
  private async reply(error: PgError | null): Promise<BackendMessage> {
    try { return await this.next(); }
    catch (e) { throw error ?? e; }
  }

  private next(): Promise<BackendMessage> {
    const m = this.queue.shift();
    if (m) {
      this.queued -= m.body.length;
      if (this.queue.length < 100 && this.queued < QUEUE_PAUSE_BYTES / 4 && this.socket.isPaused()) this.socket.resume();
      return Promise.resolve(m);
    }
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise((resolve, reject) => {
      this.waiting = (x) => x instanceof Error ? reject(x) : resolve(x);
    });
  }

  private send(type: string, body: Buffer): void {
    if (this.closedWith) return;   // a status update after the server went away has nowhere to go
    const head = Buffer.alloc(5);
    head.write(type, 0, "latin1");
    head.writeInt32BE(body.length + 4, 1);
    this.socket.write(Buffer.concat([head, body]));
  }

  // ------------------------------------------------------------------ startup and auth

  private async startup(): Promise<void> {
    const o = this.opts;
    const params: [string, string][] = [
      ["user", o.user], ["database", o.database], ["client_encoding", "UTF8"],
      // Text values in the forms the reader parses: ISO dates in UTC, floats round-trippable
      ...(o.textForms ?? [["DateStyle", "ISO, YMD"], ["TimeZone", "UTC"], ["extra_float_digits", "3"], ["IntervalStyle", "iso_8601"]] as const).map(([k, v]): [string, string] => [k, v]),
      ["application_name", o.applicationName ?? "mason"],
    ];
    if (o.replication) params.push(["replication", "database"]);
    const body = Buffer.concat([
      int32(196608), // protocol 3.0
      ...params.map(([k, v]) => Buffer.concat([cstr(k), cstr(v)])),
      Buffer.from([0]),
    ]);
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4);
    this.socket.write(Buffer.concat([len, body]));

    for (;;) {
      const m = await this.next();
      if (m.type === "E") throw new PgError(errorFields(m.body));
      if (m.type === "R") { await this.auth(m.body); continue; }
      if (m.type === "K") { this.key = { pid: m.body.readInt32BE(0), secret: m.body.readInt32BE(4) }; continue; } // BackendKeyData
      if (m.type === "Z") return;
      throw new Error(`unexpected message ${m.type} during startup`);
    }
  }

  private scram: { nonce: string; clientFirstBare: string; serverSignature?: Buffer } | null = null;

  private async auth(body: Buffer): Promise<void> {
    const code = body.readInt32BE(0);
    const pw = this.opts.password;
    switch (code) {
      case 0: return; // AuthenticationOk
      case 3: this.send("p", cstr(pw)); return;
      case 5: {
        const salt = body.subarray(4, 8);
        const inner = md5hex(Buffer.concat([Buffer.from(pw), Buffer.from(this.opts.user)]));
        this.send("p", cstr("md5" + md5hex(Buffer.concat([Buffer.from(inner), salt]))));
        return;
      }
      case 10: {
        const mechanisms = cstrings(body.subarray(4));
        if (!mechanisms.includes("SCRAM-SHA-256")) throw new Error(`the server offers ${mechanisms.join(", ")}; only SCRAM-SHA-256 is supported`);
        const nonce = crypto.randomBytes(18).toString("base64");
        const clientFirstBare = `n=,r=${nonce}`;
        this.scram = { nonce, clientFirstBare };
        const first = Buffer.from(`n,,${clientFirstBare}`);
        this.send("p", Buffer.concat([cstr("SCRAM-SHA-256"), int32(first.length), first]));
        return;
      }
      case 11: { // SASLContinue
        const s = this.scram;
        if (!s) throw new Error("SASLContinue without a SASL exchange");
        const serverFirst = body.subarray(4).toString();
        const attrs = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
        const r = attrs.r ?? "", salt = Buffer.from(attrs.s ?? "", "base64"), iterations = Number(attrs.i);
        if (!r.startsWith(s.nonce)) throw new Error("SCRAM: the server's nonce does not extend ours");
        const salted = crypto.pbkdf2Sync(pw.normalize("NFKC"), salt, iterations, 32, "sha256");
        const clientKey = hmac(salted, "Client Key");
        const storedKey = crypto.createHash("sha256").update(clientKey).digest();
        const clientFinalNoProof = `c=biws,r=${r}`;
        const authMessage = `${s.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
        const signature = hmac(storedKey, authMessage);
        const proof = Buffer.alloc(clientKey.length);
        for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i]! ^ signature[i]!;
        s.serverSignature = hmac(hmac(salted, "Server Key"), authMessage);
        this.send("p", Buffer.from(`${clientFinalNoProof},p=${proof.toString("base64")}`));
        return;
      }
      case 12: { // SASLFinal: the server proves it knew the password too
        const v = /v=([^,]+)/.exec(body.subarray(4).toString())?.[1];
        if (!this.scram?.serverSignature || v !== this.scram.serverSignature.toString("base64")) {
          throw new Error("SCRAM: the server's signature does not verify");
        }
        return;
      }
      default: throw new Error(`authentication method ${code} is not supported (use password, md5 or scram-sha-256)`);
    }
  }

  // ------------------------------------------------------------------ queries

  /** One statement (or several `;`-separated) through the simple query protocol; the LAST result set. */
  async query(sql: string): Promise<QueryResult> {
    this.send("Q", cstr(sql));
    let result: QueryResult = { fields: [], rows: [], command: "" };
    let error: PgError | null = null;
    for (;;) {
      const m = await this.reply(error);
      switch (m.type) {
        case "T": result = { fields: rowDescription(m.body), rows: [], command: "" }; break;
        case "D": result.rows.push(dataRow(m.body)); break;
        case "C": result.command = cstrings(m.body)[0] ?? ""; break;
        case "E": error = new PgError(errorFields(m.body)); break;
        case "I": break; // EmptyQueryResponse
        case "Z": if (error) throw error; return result;
        default: break;
      }
    }
  }

  /**
   * One statement's rows AS THEY ARRIVE, never held together: a page of a copy may carry hundreds of megabytes of
   * payloads (68 MB in 64 heap blocks of a table of wide JSON payloads), which `query` would hold whole. The socket
   * pauses while the consumer is busy (onData's backpressure), so memory is bounded by the queue, not the result.
   * A consumer that stops early must drain it: the connection is unusable until the server's ReadyForQuery.
   */
  async *rows(sql: string): AsyncGenerator<(string | null)[]> {
    this.send("Q", cstr(sql));
    let error: PgError | null = null;
    for (;;) {
      const m = await this.reply(error);
      switch (m.type) {
        case "D": if (error === null) yield dataRow(m.body); break;
        case "E": error = new PgError(errorFields(m.body)); break;
        case "Z": if (error) throw error; return;
        default: break;
      }
    }
  }

  /**
   * ONE STATEMENT THROUGH THE EXTENDED PROTOCOL (`mason mcp`'s query): Parse, Bind, Describe and Execute of the unnamed
   * portal, then Sync — so the server takes exactly one statement (a second is Postgres's 42601), and `maxRows` is the
   * Execute's row count: the server stops at it and says so (PortalSuspended), so a query an agent leaves unbounded is
   * never sent whole. 0 is every row. Every value is text.
   */
  async extended(sql: string, maxRows: number): Promise<ExtendedResult> {
    const int16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
    this.send("P", Buffer.concat([cstr(""), cstr(sql), int16(0)]));
    // no parameters, every result column in text
    this.send("B", Buffer.concat([cstr(""), cstr(""), int16(0), int16(0), int16(0)]));
    this.send("D", Buffer.concat([Buffer.from("P"), cstr("")]));
    this.send("E", Buffer.concat([cstr(""), int32(maxRows)]));
    this.send("S", Buffer.alloc(0));
    const result: ExtendedResult = { fields: [], rows: [], suspended: false, command: "", empty: false };
    let error: PgError | null = null;
    for (;;) {
      const m = await this.reply(error);
      switch (m.type) {
        case "T": result.fields = rowFields(m.body); break;
        case "D": if (error === null) result.rows.push(dataRow(m.body)); break;
        case "s": result.suspended = true; break;
        case "C": result.command = cstrings(m.body)[0] ?? ""; break;
        case "E": error = new PgError(errorFields(m.body)); break;
        case "I": result.empty = true; break;
        case "Z": if (error) throw error; return result;
        default: break;   // ParseComplete, BindComplete, NoData
      }
    }
  }

  // ------------------------------------------------------------------ replication

  /** START_REPLICATION, then an async stream of XLogData and keepalives until the connection ends. */
  async *replicate(command: string): AsyncGenerator<ReplicationMessage> {
    this.send("Q", cstr(command));
    for (;;) {
      const m = await this.next();
      if (m.type === "E") throw new PgError(errorFields(m.body));
      if (m.type === "W") break; // CopyBothResponse
    }
    for (;;) {
      const m = await this.next();
      if (m.type === "E") throw new PgError(errorFields(m.body));
      if (m.type === "c" || m.type === "C" || m.type === "Z") return; // the server ended the stream
      if (m.type !== "d") continue;
      const b = m.body;
      if (b[0] === 0x77) { // 'w' XLogData
        yield { kind: "data", start: b.readBigUInt64BE(1), walEnd: b.readBigUInt64BE(9), data: b.subarray(25) };
      } else if (b[0] === 0x6b) { // 'k' primary keepalive
        yield { kind: "keepalive", walEnd: b.readBigUInt64BE(1), replyRequested: b[17] === 1 };
      }
    }
  }

  /**
   * A standby status update: everything up to `flushed` is durable on our side, so the server may discard
   * the WAL behind it. The ONLY place the reader tells Postgres a change is done.
   */
  sendStatus(flushed: bigint, replyRequested = false): void {
    const b = Buffer.alloc(34);
    b[0] = 0x72; // 'r'
    b.writeBigUInt64BE(flushed, 1);  // written
    b.writeBigUInt64BE(flushed, 9);  // flushed
    b.writeBigUInt64BE(flushed, 17); // applied
    b.writeBigUInt64BE(BigInt(Date.now()) * 1000n - PG_EPOCH_OFFSET_US, 25);
    b[33] = replyRequested ? 1 : 0;
    this.send("d", b);
  }

  close(): void {
    if (this.closedWith) return;
    if (this.socket.writable) this.send("X", Buffer.alloc(0)); // Terminate: the server ends the backend cleanly
    // a read waiting for the server's next message (a replication stream between changes) ends with it, never waits on
    // a socket nothing reads any more (stopping a DuckDB stream once hung on its idle START_REPLICATION)
    this.fail(new Error("connection closed"));
    this.socket.end();
  }
}

// ------------------------------------------------------------------ helpers

/** TCP connect and the SSL negotiation (libpq's sslmode): the socket a startup, or a CancelRequest, is written to. */
async function transport(o: PgConnectOptions, hold: (s: net.Socket | tls.TLSSocket) => void): Promise<net.Socket | tls.TLSSocket> {
  const mode = o.sslmode ?? "prefer";
  const raw = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: o.host, port: o.port });
    hold(s);
    s.once("connect", () => resolve(s));
    s.once("error", (e) => reject(new Error(`connecting to ${o.host}:${o.port}: ${socketErrorText(e)}`)));
  });
  let sock: net.Socket | tls.TLSSocket = raw;
  if (mode !== "disable" && mode !== "allow") {
    // SSLRequest: length 8, code 80877103; the server answers one byte, S or N
    raw.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
    const answer = await new Promise<string>((resolve, reject) => {
      raw.once("data", (d) => resolve(String.fromCharCode(d[0]!)));
      raw.once("error", reject);
    });
    if (answer === "S") {
      const verify = mode === "verify-ca" || mode === "verify-full";
      sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({
          socket: raw, rejectUnauthorized: verify,
          ...(mode === "verify-full" ? { servername: o.host } : { checkServerIdentity: () => undefined }),
        });
        hold(t);
        t.once("secureConnect", () => resolve(t));
        t.once("error", reject);
      });
    } else if (mode !== "prefer") {
      raw.destroy();
      throw new Error(`sslmode=${mode}, but ${o.host} does not accept TLS`);
    }
  }
  return sock;
}

/** `16/B374D848` -> its 64-bit position; throws on anything else. */
export function parseLsn(text: string): bigint {
  const m = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(text.trim());
  if (!m) throw new Error(`not a WAL position: ${JSON.stringify(text)}`);
  return (BigInt(`0x${m[1]}`) << 32n) | BigInt(`0x${m[2]}`);
}

export function formatLsn(lsn: bigint): string {
  return `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;
}

/** A SQL string literal (standard_conforming_strings on, the default since 9.1). */
export function pgLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("a NUL byte cannot appear in a Postgres string");
  return `'${value.replace(/'/g, "''")}'`;
}

/** A quoted identifier. */
export function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function int32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function cstr(s: string): Buffer { return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]); }
function md5hex(b: Buffer): string { return crypto.createHash("md5").update(b).digest("hex"); }
function hmac(key: Buffer, data: string): Buffer { return crypto.createHmac("sha256", key).update(data).digest(); }

function cstrings(b: Buffer, limit = Infinity): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < b.length && out.length < limit) {
    const end = b.indexOf(0, i);
    if (end < 0) break;
    if (end === i && out.length > 0 && limit === Infinity) break; // the list terminator
    out.push(b.toString("utf8", i, end));
    i = end + 1;
  }
  return out;
}

function errorFields(b: Buffer): Record<string, string> {
  const f: Record<string, string> = {};
  let i = 0;
  while (i < b.length && b[i] !== 0) {
    const code = String.fromCharCode(b[i]!);
    const end = b.indexOf(0, i + 1);
    f[code] = b.toString("utf8", i + 1, end);
    i = end + 1;
  }
  return f;
}

function rowDescription(b: Buffer): string[] {
  const n = b.readInt16BE(0);
  const names: string[] = [];
  let i = 2;
  for (let k = 0; k < n; k++) {
    const end = b.indexOf(0, i);
    names.push(b.toString("utf8", i, end));
    i = end + 1 + 18; // table oid, column no, type oid, size, modifier, format
  }
  return names;
}

/** A RowDescription's columns with their types (rowDescription keeps the names alone). */
function rowFields(b: Buffer): RowField[] {
  const n = b.readInt16BE(0);
  const out: RowField[] = [];
  let i = 2;
  for (let k = 0; k < n; k++) {
    const end = b.indexOf(0, i);
    const name = b.toString("utf8", i, end);
    i = end + 1;
    // table oid (4), column number (2), type oid (4), type size (2), type modifier (4), format (2)
    out.push({ name, typeOid: b.readUInt32BE(i + 6), typmod: b.readInt32BE(i + 12) });
    i += 18;
  }
  return out;
}

/** onData pauses the socket above this many queued bytes, and next() resumes it below a quarter of it. */
const QUEUE_PAUSE_BYTES = 16 * 1024 * 1024;

function dataRow(b: Buffer): (string | null)[] {
  const n = b.readInt16BE(0);
  const out: (string | null)[] = [];
  let i = 2;
  for (let k = 0; k < n; k++) {
    const len = b.readInt32BE(i);
    i += 4;
    if (len < 0) { out.push(null); continue; }
    out.push(b.toString("utf8", i, i + len));
    i += len;
  }
  return out;
}

/**
 * A socket's error as words: its message, or each address's where Node tried several (`localhost` is ::1 and 127.0.0.1:
 * an AggregateError whose own message is EMPTY — `connecting to localhost:5432: ` said nothing, and `mason start` could
 * not tell "nothing is listening" from a wrong URL), or its code.
 */
export function socketErrorText(e: Error): string {
  if (e instanceof AggregateError && e.errors.length > 0) return e.errors.map((x) => x instanceof Error ? socketErrorText(x) : String(x)).join("; ");
  return e.message || (e as NodeJS.ErrnoException).code || e.name;
}
