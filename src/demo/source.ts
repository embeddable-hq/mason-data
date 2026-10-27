/**
 * THE DEMO DATABASE (`mason init demo`): a Postgres Mason hosts itself, so a first run needs no Docker and no Postgres
 * install. PGlite (Postgres 18 compiled to WebAssembly, the catalog's own engine, src/api/postgres/catalog.ts) persisted
 * in a folder, seeded at the folder's first open with a small synthetic web shop (src/demo/seed.ts), and served over the
 * Postgres wire protocol on a loopback port, so Mason reads it exactly as it reads an application's database: its own
 * client (src/cdc/pg-wire.ts: the checks, the catalog reads) and DuckDB's `postgres` extension through libpq (the copy's
 * chunks, the poll). `change()` writes a round of changes through PGlite's own API, so the copy visibly keeps current.
 *
 * WHAT IT IS NOT: a server for anything but a demo. It listens on 127.0.0.1 ONLY and accepts any user and any password
 * (no authentication round trip: AuthenticationOk at once), because nothing but this machine can reach it and it holds
 * nothing but the seed. It has no walsender (PGlite has none: `pg_replication_slots` is empty), so it is polled, never
 * streamed; a StartupMessage asking for replication is refused (0A000). COPY FROM STDIN is not supported: a batch ends
 * at a Query, a Sync or a Flush, never at a CopyDone (nothing Mason sends writes through the wire).
 *
 * THE STARTUP PHASE IS OURS, THE QUERY PHASE IS POSTGRES'S. PGlite answers protocol bytes (`execProtocolRaw`) but not
 * the startup phase (SSLRequest, StartupMessage, authentication), so this module does it: an SSLRequest or a
 * GSSENCRequest is told `N` (no TLS on loopback), a CancelRequest closes (nothing to cancel), the StartupMessage is
 * checked (the database must be `demo`, else 3D000; protocol 3.x, a newer minor negotiated down to 3.0) and answered
 * AuthenticationOk, ParameterStatus, BackendKeyData (a pid of this module's numbering) and ReadyForQuery `I`. After it,
 * every frame a client sends is relayed to PGlite AS ITS OWN BYTES, by a framer of this module's (a type byte and a
 * length): the query phase is never decoded and re-encoded, so nothing a client sends (a COPY's binary, a Bind's
 * parameters) can be changed on the way; `FrontendDecoder` (src/api/postgres/protocol.ts) decodes only the startup
 * frames, handed to it one whole frame at a time.
 *
 * ONE SESSION FOR EVERY CLIENT, SO ONE LOCK. PGlite is a single backend: two connections' messages interleaved inside
 * a transaction would run one client's statement in the other's transaction. So a connection takes THE lock when it has
 * a batch to send — the frames up to and including a Query `Q`, a Sync `S` or a Flush `H` — and gives it back only once
 * the reply's last ReadyForQuery says `I` (idle, no transaction open); while it says `T` or `E` (or a Flush left the
 * extended protocol mid-cycle, no ReadyForQuery at all) the connection keeps it, and its next batch runs under it.
 * Terminate `X` ends the connection; one that ends holding the lock (mid-transaction, or gone) is cleaned up through
 * PGlite first — a Sync when it was mid-cycle, a ROLLBACK when a transaction is open — so the next holder starts idle.
 * `change()` and the startup's settings take the same lock. Waiters are served first come, first served.
 *
 * WHAT THE CLIENTS SEND (traced: `trace`): Mason's own client, simple Queries only. libpq under the extension: SSLRequest
 * (sslmode prefer) then a StartupMessage of user, database and application_name alone; then per use of a pooled
 * connection `SELECT 1`, the statements, `DISCARD ALL`; every read inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE
 * READ READ ONLY` … `COMMIT`, each statement an unnamed Parse + Sync, a Describe + Sync, then the statement again as a
 * simple Query `COPY (…) TO STDOUT (FORMAT "binary")`, which PGlite answers (CopyOutResponse, CopyData, CopyDone). An
 * unnamed statement is shared by every client of the one session, so a Parse and its Describe in two batches are safe
 * only inside a transaction, which holds the lock between them — where every one traced was.
 *
 * THE DEADLOCK THIS ALLOWS, reasoned about: a client holding the lock inside a transaction whose own progress waits for
 * ANOTHER client of this database that is queued behind the lock — two DuckDB connections where the first's COMMIT
 * waited on the second's read, or a process whose thread pool is all blocked in libpq reads queued here while the
 * holder's next statement needs one of those threads. Mason's own readers do not do that (each copy chunk and each poll
 * is one DuckDB transaction on one connection, its source transaction ended at its commit, which waits on no other
 * reader), and the test of three parallel readers holds it; but the serialisation makes Mason's parallel readers take
 * turns, so a copy here reads one chunk at a time whatever `MASON_COPY_PARALLEL` says. A wait past `LONG_WAIT_MS` is
 * said in the log, naming who holds the lock and in what state, so a hang is never silent.
 *
 * THE SETTINGS A CLIENT ASKS FOR ARE THE ONE SESSION'S. The StartupMessage's parameters other than user / database are
 * session settings (DateStyle, TimeZone, extra_float_digits, IntervalStyle, client_encoding, application_name,
 * search_path, and every `-c name=value` of libpq's `options`), applied with `set_config` under the lock before the
 * ReadyForQuery, and applied again (one statement) whenever the lock passes to a client from another, so each client
 * meets the settings it asked for at every turn of its own. A DISCARD ALL or a RESET (DuckDB's `postgres` extension sends
 * DISCARD ALL each time its pool takes a connection back) returns the session to PGlite's defaults where Postgres would
 * return it to the startup's, so after one (Postgres's CommandComplete tag says it ran) the client's settings are
 * applied again at its next turn. A client's own SET lasts until another client's turn. Every Mason client asks for
 * nothing that differs between them where it matters: pg-wire.ts asks for ISO dates, UTC and extra_float_digits 3 (and
 * reads JSON text), the extension asks for nothing but its application_name and reads every value in binary.
 *
 * PGLITE'S EXTENDED PROTOCOL DIFFERS FROM POSTGRES'S IN ONE WAY, which the relay corrects: after an error it sends a
 * ReadyForQuery AT ONCE, and another at the Sync (measured: a failed Parse/Bind/Execute/Sync answers `E Z Z`; a failed
 * Parse/Flush `E Z`). Postgres sends one, at the Sync. So a batch that ends in a Sync relays only its last
 * ReadyForQuery, and one that ends in a Flush relays none. What comes after the error up to the Sync PGlite ignores
 * itself, as Postgres's `ignore_till_sync` does (measured: a Bind/Execute/Sync after a failed Parse/Flush answers `Z`
 * alone) — while the client that erred holds the lock, a Flush leaving it mid-cycle, so no other client's message is
 * among the ignored.
 *
 * PGLITE RUNS ON THIS THREAD, not a worker as the catalog's does: the demo's statements are small (its largest is a copy
 * chunk of the 15,000-row table, tens of milliseconds), and `change()` writes through the same instance; a statement
 * here holds the thread for that long, which a demo can afford and a real source never asks of Mason.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  FrontendDecoder, MAX_MESSAGE_LENGTH, MAX_STARTUP_LENGTH, authenticationOk, backendKeyData, cstr, errorResponse, frame, int32,
  parameterStatus, readyForQuery, splitFrames, sslResponse,
} from "../api/postgres/protocol.ts";
import { CHANGE_STATE_SQL, DEMO_TABLES, changeSql, seedStatements, type ChangeState } from "./seed.ts";

import { DEMO_DATABASE, DEMO_USER, demoUrl } from "./seed.ts";
/** the demo's URL and names are the seed's module's (no PGlite there: `mason init demo` and the run's port check read
 *  them without loading this one) */
export { DEMO_DATABASE, DEMO_USER, demoUrl };

/** a wait for the lock longer than this is said in the log, once per wait */
const LONG_WAIT_MS = 10_000;
/** the parameters a ParameterStatus reports at startup that do not change per client: read from PGlite once, at open */
const SERVER_PARAMETERS = ["server_version", "server_encoding", "integer_datetimes", "standard_conforming_strings",
  "is_superuser", "session_authorization", "in_hot_standby"] as const;
/** the ones a client's settings move: read again after each client's startup */
const SESSION_PARAMETERS = ["client_encoding", "DateStyle", "TimeZone", "IntervalStyle", "application_name", "search_path"] as const;
/** startup parameters that are not settings */
const NOT_SETTINGS = new Set(["user", "database", "options", "replication"]);

type TxStatus = "I" | "T" | "E";
/** who holds the lock: a connection, or this module's own work (a startup's settings, `change()`) */
type Owner = Connection | string;

/** THE ONE PGLITE SESSION'S LOCK: first come, first served; a holder keeps it across batches until it releases. */
class SessionLock {
  #holder: Owner | null = null;
  #waiting: Array<{ owner: Owner; grant: () => void }> = [];
  readonly #say: (line: string) => void;
  constructor(say: (line: string) => void) { this.#say = say; }

  get holder(): Owner | null { return this.#holder; }

  async acquire(owner: Owner): Promise<void> {
    if (this.#holder === owner) return;
    if (this.#holder === null) { this.#holder = owner; return; }
    const since = Date.now();
    const timer = setTimeout(() => {
      const h = this.#holder;
      this.#say(`demo database: ${nameOf(owner)} has waited ${Math.round((Date.now() - since) / 1000)} s for ${h === null ? "nobody" : nameOf(h)}` +
        `${h instanceof Connection ? `, which holds a transaction open (${h.stateText()})` : ""}: the demo database runs one statement at a time`);
    }, LONG_WAIT_MS);
    timer.unref();
    await new Promise<void>((grant) => this.#waiting.push({ owner, grant }));
    clearTimeout(timer);
  }

  release(owner: Owner): void {
    if (this.#holder !== owner) return;
    const next = this.#waiting.shift();
    this.#holder = next?.owner ?? null;
    next?.grant();
  }

  /** runs `fn` holding the lock, and releases it whatever `fn` does */
  async exclusive<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(owner);
    try { return await fn(); } finally { this.release(owner); }
  }
}

const nameOf = (o: Owner): string => (typeof o === "string" ? o : `connection ${o.pid}${o.application ? ` (${o.application})` : ""}`);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** a PGlite error's SQLSTATE, when it carries one */
const sqlstateOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "XX000";
};

/** libpq's `options` string: its `-c name=value` / `--name=value` settings (a backslash escapes a space, as libpq's) */
export function optionSettings(options: string): Array<[string, string]> {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < options.length; i++) {
    const ch = options[i]!;
    if (ch === "\\" && i + 1 < options.length) { word += options[++i]; inWord = true; continue; }
    if (/\s/.test(ch)) { if (inWord) words.push(word); word = ""; inWord = false; continue; }
    word += ch;
    inWord = true;
  }
  if (inWord) words.push(word);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    let setting: string | undefined;
    if (w === "-c") setting = words[++i];
    else if (w.startsWith("-c")) setting = w.slice(2);
    else if (w.startsWith("--")) setting = w.slice(2);
    const eq = setting?.indexOf("=") ?? -1;
    if (setting !== undefined && eq > 0) out.push([setting.slice(0, eq).replace(/-/g, "_"), setting.slice(eq + 1)]);
  }
  return out;
}

/** One client's connection: the startup phase, then its frames relayed in batches under the lock. */
class Connection {
  readonly pid: number;
  application = "";
  /** the settings its StartupMessage asked for: the one session's whenever it is this connection's turn */
  settings: ReadonlyArray<[string, string]> = [];
  readonly #socket: net.Socket;
  readonly #source: DemoSource;
  #pending: Buffer[] = [];
  #pendingLength = 0;
  #startup = true;
  /** the frames of the batch being gathered */
  #batch: Buffer[] = [];
  /** every batch, the startup and the end run one after another */
  #chain: Promise<void> = Promise.resolve();
  /** the last ReadyForQuery relayed: null while the extended protocol is mid-cycle (a Flush) */
  #status: TxStatus | null = "I";
  #closed = false;
  #ended: Promise<void> | null = null;

  constructor(socket: net.Socket, source: DemoSource, pid: number) {
    this.#socket = socket;
    this.#source = source;
    this.pid = pid;
    socket.setNoDelay(true);
    socket.on("data", (d: Buffer) => this.#onData(d));
    socket.on("error", (e) => { this.#source.note(`demo database: connection ${this.pid}: ${errorText(e)}`); this.#socket.destroy(); });
    socket.on("close", () => { this.#closed = true; void this.end(); });
  }

  stateText(): string {
    return this.#status === null ? "mid extended-protocol cycle" : this.#status === "T" ? "in a transaction" : this.#status === "E" ? "in a failed transaction" : "idle";
  }

  #then(step: () => Promise<void>): void {
    this.#chain = this.#chain.then(step).catch((e: unknown) => {
      // a step's own failure is said and ends the connection; the end's cleanup leaves the session idle
      this.#source.note(`demo database: connection ${this.pid}: ${errorText(e)}`);
      this.#send(errorResponse({ severity: "FATAL", code: sqlstateOf(e), message: errorText(e) }));
      this.#socket.destroy();
    });
  }

  #send(...frames: Buffer[]): void {
    if (!this.#closed && this.#socket.writable) this.#socket.write(frames.length === 1 ? frames[0]! : Buffer.concat(frames));
  }

  #fatal(code: string, message: string): void {
    this.#send(errorResponse({ severity: "FATAL", code, message }));
    this.#socket.end();
  }

  #onData(d: Buffer): void {
    this.#pending.push(d);
    this.#pendingLength += d.length;
    for (;;) {
      const head = this.#startup ? 4 : 5;
      if (this.#pendingLength < head) return;
      let buf = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingLength);
      const len = buf.readInt32BE(head - 4);
      const limit = this.#startup ? MAX_STARTUP_LENGTH : MAX_MESSAGE_LENGTH;
      if (len < 4 || len > limit) {
        this.#source.note(`demo database: connection ${this.pid} sent a frame of length ${len}; closed`);
        this.#pending = [];
        this.#pendingLength = 0;
        this.#socket.destroy();
        return;
      }
      const whole = head - 4 + len;
      if (buf.length < whole) { this.#pending = [buf]; return; }
      const f = Buffer.from(buf.subarray(0, whole));
      buf = buf.subarray(whole);
      this.#pending = buf.length > 0 ? [buf] : [];
      this.#pendingLength = buf.length;
      if (this.#startup) this.#startupFrame(f);
      else this.#queryFrame(f);
      if (this.#closed) return;
    }
  }

  #startupFrame(f: Buffer): void {
    const decoder = new FrontendDecoder();
    decoder.push(f);
    let m;
    try { m = decoder.next(); } catch (e) {
      this.#source.note(`demo database: connection ${this.pid}: ${errorText(e)}; closed`);
      this.#socket.destroy();
      return;
    }
    if (m === null) { this.#socket.destroy(); return; }
    switch (m.type) {
      case "SSLRequest":
      case "GSSENCRequest":
        // no TLS and no GSSAPI on loopback: the client continues in the clear (sslmode prefer, disable, allow)
        this.#send(sslResponse(false));
        return;
      case "CancelRequest":
        // the one session runs one statement at a time, each short: there is nothing to cancel
        this.#socket.end();
        return;
      case "Startup":
        this.#startup = false;
        this.#then(() => this.#open(m.major, m.minor, m.params));
        return;
      default:
        this.#socket.destroy();
    }
  }

  async #open(major: number, minor: number, params: Record<string, string>): Promise<void> {
    if (this.#closed) return;
    if (major !== 3) { this.#fatal("0A000", `unsupported frontend protocol ${major}.${minor}: the demo database speaks 3.0`); return; }
    if (params.replication !== undefined && params.replication !== "false" && params.replication !== "0") {
      // nothing a user reads names the engine (CLAUDE.md): the demo has no walsender, said as what it lacks
      this.#fatal("0A000", "the demo database has no change log to stream: Mason polls it");
      return;
    }
    const database = params.database ?? params.user ?? "";
    if (database !== DEMO_DATABASE) {
      this.#source.note(`demo database: connection ${this.pid} asked for database ${JSON.stringify(database)}; refused (only ${DEMO_DATABASE} is served)`);
      this.#fatal("3D000", `database "${database}" does not exist`);
      return;
    }
    // protocol options (_pq_.*) and a newer minor are negotiated away, as Postgres does: this server speaks 3.0
    const options = Object.keys(params).filter((k) => k.startsWith("_pq_."));
    const negotiate = minor > 0 || options.length > 0 ? [frame("v", int32(0), int32(options.length), ...options.map(cstr))] : [];
    const settings: Array<[string, string]> = [
      ...Object.entries(params).filter(([k]) => !NOT_SETTINGS.has(k) && !k.startsWith("_pq_.")),
      ...optionSettings(params.options ?? ""),
    ];
    this.application = params.application_name ?? "";
    this.settings = settings;
    this.#source.trace?.(`demo database: connection ${this.pid} starts with ${JSON.stringify(params)}`);
    const session = await this.#source.applySettings(this);
    if (this.#closed) return;
    this.#send(...negotiate, authenticationOk(),
      ...Object.entries({ ...this.#source.serverParameters, ...session }).map(([k, v]) => parameterStatus(k, v)),
      backendKeyData(this.pid, (Math.random() * 0x7fffffff) | 0), readyForQuery("I"));
  }

  #queryFrame(f: Buffer): void {
    const type = String.fromCharCode(f[0]!);
    if (type === "X") { this.#socket.end(); return; }
    this.#batch.push(f);
    if (type === "Q" || type === "S" || type === "H") {
      const batch = this.#batch;
      this.#batch = [];
      this.#then(() => this.#run(batch, type));
    }
  }

  async #run(frames: Buffer[], end: "Q" | "S" | "H"): Promise<void> {
    if (this.#closed) return;
    this.#source.trace?.(`demo database: connection ${this.pid}: ${frames.map(describeFrame).join(" ")}`);
    const held = this.#source.lock.holder === this;
    await this.#source.lock.acquire(this);
    if (this.#closed) { if (this.#status === "I") this.#source.lock.release(this); return; }
    // the session's settings are this client's again when another client's turn (or a DISCARD / RESET) moved them
    if (!held) await this.#source.reapply(this);
    const reply = splitFrames(await this.#source.exec(Buffer.concat(frames)));
    // a DISCARD ALL or a RESET (the extension's pool sends DISCARD ALL as it puts a connection back) returned the
    // session to PGlite's defaults, where Postgres returns a session to its startup's: this client's are applied again
    // at its next turn (Postgres's own reply says what ran: its CommandComplete tag)
    if (reply.some((r) => r.type === "C" && /^(DISCARD|RESET)\b/.test(r.frame.toString("latin1", 5, r.frame.length - 1)))) this.#source.settingsOf = null;
    let out = reply;
    if (end === "H") {
      out = reply.filter((r) => r.type !== "Z");
    } else if (end === "S") {
      const last = reply.findLastIndex((r) => r.type === "Z");
      out = reply.filter((r, i) => r.type !== "Z" || i === last);
    }
    const z = out.findLast((r) => r.type === "Z");
    this.#status = z === undefined ? (end === "H" ? null : this.#status) : (String.fromCharCode(z.frame[5]!) as TxStatus);
    if (out.length > 0) this.#send(...out.map((r) => r.frame));
    if (this.#status === "I") this.#source.lock.release(this);
  }

  /** ends the connection (idempotent): once its batches are done, the session it held is left idle and the lock freed */
  end(): Promise<void> {
    this.#closed = true;
    this.#ended ??= (async () => {
      // batches already queued run to their end (or see the connection closed), then the cleanup
      await this.#chain;
      const lock = this.#source.lock;
      if (lock.holder === this) {
        try {
          if (this.#status === null) this.#status = statusOf(await this.#source.exec(frame("S")));
          if (this.#status === "T" || this.#status === "E") {
            this.#source.note(`demo database: connection ${this.pid} ended inside a transaction; rolled back`);
            this.#status = statusOf(await this.#source.exec(frame("Q", cstr("ROLLBACK"))));
          }
        } catch (e) {
          this.#source.note(`demo database: connection ${this.pid}: the rollback after it ended failed: ${errorText(e)}`);
        } finally {
          lock.release(this);
        }
      }
      this.#source.forget(this);
      this.#socket.destroy();
    })();
    return this.#ended;
  }
}

/** the status byte of a reply's last ReadyForQuery (I when it has none: a cleanup's reply always ends in one) */
function statusOf(reply: Uint8Array): TxStatus {
  const z = splitFrames(reply).findLast((r) => r.type === "Z");
  return z === undefined ? "I" : (String.fromCharCode(z.frame[5]!) as TxStatus);
}

/** a frame as the trace says it: its type, and a Query's or a Parse's statement */
function describeFrame(f: Buffer): string {
  const type = String.fromCharCode(f[0]!);
  if (type === "Q") return `Q[${f.toString("utf8", 5, f.length - 1)}]`;
  if (type === "P") {
    const nameEnd = f.indexOf(0, 5);
    const sqlEnd = f.indexOf(0, nameEnd + 1);
    return `P${nameEnd > 5 ? `(${f.toString("utf8", 5, nameEnd)})` : ""}[${f.toString("utf8", nameEnd + 1, sqlEnd)}]`;
  }
  return type;
}

export class DemoSource {
  readonly port: number;
  readonly url: string;
  /** the schema was seeded at THIS open (the folder was new) */
  readonly seeded: boolean;
  /** @internal the lock every use of the one PGlite session takes */
  readonly lock: SessionLock;
  /** @internal the ParameterStatus values that are PGlite's own, read at open */
  readonly serverParameters: Record<string, string>;
  /** @internal one line per frame batch relayed, when asked for (development: what a client sends) */
  readonly trace: ((line: string) => void) | undefined;
  readonly #db: PGlite;
  readonly #server: net.Server;
  readonly #log: (line: string) => void;
  readonly #connections = new Set<Connection>();
  #closing: Promise<void> | null = null;

  private constructor(o: { db: PGlite; server: net.Server; port: number; seeded: boolean; log: (line: string) => void; lock: SessionLock;
    serverParameters: Record<string, string>; trace: ((line: string) => void) | undefined }) {
    this.#db = o.db;
    this.#server = o.server;
    this.port = o.port;
    this.url = demoUrl(o.port);
    this.seeded = o.seeded;
    this.#log = o.log;
    this.lock = o.lock;
    this.serverParameters = o.serverParameters;
    this.trace = o.trace;
  }

  /** boots PGlite at `dir` (made if absent), seeds the schema at the folder's first open, listens on 127.0.0.1:`port`
   *  (throws an Error naming the port when it is held); `log` gets one line per notable event. Port 0 takes a free one,
   *  which `port` then says. `trace` (development) gets every batch a client sends. */
  static async open(o: { dir: string; port: number; log: (line: string) => void; trace?: (line: string) => void }): Promise<DemoSource> {
    // the port first: a port that is held refuses at once, before a new folder is made and seeded for nothing. A
    // connection that arrives before PGlite is up is held until it is (accepted below), or closed when the open fails
    let source: DemoSource | null = null;
    const early: Array<{ socket: net.Socket; pid: number }> = [];
    let nextPid = 1000;
    const server = net.createServer((socket) => {
      const pid = nextPid++;
      if (source === null) { early.push({ socket, pid }); return; }
      source.#accept(socket, pid);
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        reject(new Error(e.code === "EADDRINUSE"
          // what failed alone: the way out is the caller's to say, once (src/cli/demo.ts openDemo: the project's own words)
          ? `the demo database cannot listen on 127.0.0.1:${o.port}: port ${o.port} is in use`
          : `the demo database cannot listen on 127.0.0.1:${o.port}: ${e.message}`, { cause: e }));
      });
      server.listen({ host: "127.0.0.1", port: o.port }, () => {
        const a = server.address();
        resolve(typeof a === "object" && a !== null ? a.port : o.port);
      });
    });
    server.on("error", (e) => o.log(`demo database: the listener on 127.0.0.1:${port} failed: ${e.message}`));

    let db: PGlite | null = null;
    try {
      fs.mkdirSync(o.dir, { recursive: true });
      const t0 = Date.now();
      db = await boot(path.resolve(o.dir), o.log);
      const lock = new SessionLock(o.log);
      const exists = (await db.query<{ t: string | null }>("SELECT to_regclass('public.orders')::text AS t")).rows[0]?.t ?? null;
      let seeded = false;
      if (exists === null) {
        await seed(db);
        seeded = true;
        const counts = await countRows(db);
        o.log(`demo database: seeded ${DEMO_TABLES.map((t) => `${t} ${counts[t]!.toLocaleString("en-US")}`).join(", ")} rows in ${Date.now() - t0} ms, at ${o.dir}`);
      }
      // ANALYZE AT EVERY OPEN, so the catalog's row estimates are the counts (`mason tables`' rows, the copy's
      // smallest-first order): the seed's rows commit before an ANALYZE can run, and "seeded" is told by the tables
      // alone, so a process ended between the two would leave a folder never analysed; ~20k rows, milliseconds
      await db.exec("ANALYZE");
      const row = (await db.query<Record<string, string>>(`SELECT ${SERVER_PARAMETERS.map((p) => `current_setting('${p}') AS "${p}"`).join(", ")}`)).rows[0] ?? {};
      const serverParameters: Record<string, string> = {};
      for (const p of SERVER_PARAMETERS) serverParameters[p] = String(row[p] ?? "");
      // PGlite's single-user backend leaves session_authorization empty; Postgres reports the session's user
      if (serverParameters.session_authorization === "") serverParameters.session_authorization = DEMO_USER;
      source = new DemoSource({ db, server, port, seeded, log: o.log, lock, serverParameters, trace: o.trace });
      for (const e of early.splice(0)) source.#accept(e.socket, e.pid);
      o.log(`demo database: listening on 127.0.0.1:${port} (${source.url}), data in ${o.dir}`);
      return source;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      for (const c of early.splice(0)) c.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (db !== null) {
        await db.close().catch((ce: unknown) => o.log(`demo database: PGlite did not close cleanly after a failed open: ${errorText(ce)}`));
      }
      throw new Error(`the demo database at ${o.dir} did not open: ${err.message}`, { cause: err });
    }
  }

  #accept(socket: net.Socket, pid: number): void {
    if (this.#closing !== null) { socket.destroy(); return; }
    this.#connections.add(new Connection(socket, this, pid));
  }

  /** @internal */
  forget(c: Connection): void {
    this.#connections.delete(c);
    if (this.settingsOf === c) this.settingsOf = null;
  }

  /** @internal a notable event, for the log */
  note(line: string): void { this.#log(line); }

  /** @internal protocol bytes through PGlite: only under the lock */
  exec(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.#closing !== null && this.#db.closed) return Promise.reject(new Error("the demo database is closed"));
    return this.#db.execProtocolRaw(bytes);
  }

  /** @internal the connection whose settings the one session holds now (null: PGlite's defaults, or unknown) */
  settingsOf: Connection | null = null;

  /** @internal a connection's startup settings, as one statement, under the lock it holds */
  async reapply(c: Connection): Promise<void> {
    if (this.settingsOf === c) return;
    if (c.settings.length > 0) {
      await this.#db.query(`SELECT ${c.settings.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, false)`).join(", ")}`, c.settings.flat());
    }
    this.settingsOf = c;
  }

  /** @internal a client's startup settings applied to the one session, and the values it then reports */
  applySettings(c: Connection): Promise<Record<string, string>> {
    return this.lock.exclusive("a client's startup", async () => {
      this.settingsOf = null;
      await this.reapply(c);
      const row = (await this.#db.query<Record<string, string>>(`SELECT ${SESSION_PARAMETERS.map((p) => `current_setting('${p}') AS "${p}"`).join(", ")}`)).rows[0] ?? {};
      const out: Record<string, string> = {};
      for (const p of SESSION_PARAMETERS) out[p] = String(row[p] ?? "");
      return out;
    });
  }

  /** one round of changes (a new order with its items, an older order's status moved on): what it did, one line */
  change(): Promise<string> {
    if (this.#closing !== null) return Promise.reject(new Error("the demo database is closed"));
    return this.lock.exclusive("change()", async () => {
      const r = (await this.#db.query<{ newest: string; customers: string; prices: string; moving: string | null }>(CHANGE_STATE_SQL)).rows[0];
      if (r === undefined) throw new Error("the demo database's change could not read its state (no row)");
      const state: ChangeState = {
        newest: Number(r.newest), customers: Number(r.customers),
        prices: JSON.parse(r.prices) as Array<[number, number]>,
        moving: r.moving === null ? null : JSON.parse(r.moving) as [number, string],
      };
      const c = changeSql(state);
      const id = await this.#db.transaction(async (tx) => {
        let last: string | undefined;
        for (const s of c.statements) last = (await tx.query<{ id?: string }>(s)).rows[0]?.id ?? last;
        return last ?? "?";
      });
      return c.said(id);
    });
  }

  /** ends every connection, the listener and PGlite, its data flushed to `dir`; idempotent */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      const listening = new Promise<void>((resolve) => this.#server.close(() => resolve()));
      // every connection's socket goes; each one's end runs its cleanup (a rollback under the lock) before it settles
      await Promise.all([...this.#connections].map((c) => c.end()));
      await listening;
      // the lock's last holder (a change() in flight) finishes before PGlite closes
      await this.lock.exclusive("close()", async () => { await this.#db.close(); });
    })();
    return this.#closing;
  }
}

/**
 * PGLITE AS DATABASE `demo` AND USER `demo`, so `current_database()` and `current_user` are what the URL says (PGlite
 * boots into `postgres` as `postgres`, and cannot boot into a database that does not exist yet). A folder without them
 * — a new one, or one whose first open stopped before they were made — is booted once as `postgres` to make them (the
 * role a superuser, as an app's owner often is: every catalog read and `pg_control_system()` are its), then booted
 * again as `demo`.
 */
async function boot(dir: string, log: (line: string) => void): Promise<PGlite> {
  const asDemo = async (): Promise<PGlite> => {
    const db = new PGlite({ dataDir: dir, database: DEMO_DATABASE, username: DEMO_USER });
    await db.waitReady;
    return db;
  };
  if (fs.existsSync(path.join(dir, "PG_VERSION"))) {
    try { return await asDemo(); }
    catch (e) {
      // the folder is a Postgres without the demo database or role yet: made below, then booted again; any other
      // failure fails that boot too, and is thrown from it
      log(`demo database: ${dir} did not boot as database ${DEMO_DATABASE} (${errorText(e)}); making it`);
    }
  }
  const admin = new PGlite({ dataDir: dir });
  try {
    await admin.waitReady;
    const has = (await admin.query<{ db: boolean; role: boolean }>(
      `SELECT EXISTS (SELECT FROM pg_database WHERE datname = '${DEMO_DATABASE}') AS db, EXISTS (SELECT FROM pg_roles WHERE rolname = '${DEMO_USER}') AS role`)).rows[0];
    if (has?.role !== true) await admin.exec(`CREATE ROLE ${DEMO_USER} SUPERUSER LOGIN`);
    // CREATE DATABASE refuses a transaction block: a statement of its own
    if (has?.db !== true) await admin.exec(`CREATE DATABASE ${DEMO_DATABASE} OWNER ${DEMO_USER}`);
  } finally {
    await admin.close();
  }
  return asDemo();
}

/** the seed, in one transaction (the ANALYZE that makes the row estimates the counts is every open's, after it) */
async function seed(db: PGlite): Promise<void> {
  const s = seedStatements(new Date());
  await db.transaction(async (tx) => {
    await tx.exec(s.ddl);
    for (const statement of s.rows) await tx.exec(statement);
    for (const statement of s.after) await tx.exec(statement);
  });
}

async function countRows(db: PGlite): Promise<Record<string, number>> {
  const r = (await db.query<Record<string, string>>(`SELECT ${DEMO_TABLES.map((t) => `(SELECT count(*) FROM ${t})::text AS ${t}`).join(", ")}`)).rows[0] ?? {};
  return Object.fromEntries(DEMO_TABLES.map((t) => [t, Number(r[t] ?? 0)]));
}
