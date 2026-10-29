// The change reader's Postgres client (src/cdc/pg-wire.ts): how the bytes a socket delivers become messages.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { PgConnection, PgError } from "../src/cdc/pg-wire.ts";

/** A connection with no socket, fed by hand: what onData made of the bytes, in order. */
function feed(chunks: Buffer[]): Array<{ type: string; body: string }> {
  const c = new (PgConnection as unknown as { new (o: unknown): PgConnection })({}) as unknown as Record<string, unknown>;
  c.socket = { pause() {}, isPaused: () => false };
  const onData = (c.onData as (d: Buffer) => void).bind(c);
  for (const d of chunks) onData(d);
  return (c.queue as Array<{ type: string; body: Buffer }>).map((m) => ({ type: m.type, body: m.body.toString() }));
}

const message = (type: string, body: string): Buffer => {
  const b = Buffer.from(body);
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(4 + b.length, 1);
  return Buffer.concat([head, b]);
};

test("a message split across many chunks is one message, and a chunk holding several is several", () => {
  const big = "x".repeat(200_000);
  const wire = Buffer.concat([message("D", big), message("C", "SELECT 1"), message("Z", "I")]);
  const chunks: Buffer[] = [];
  for (let i = 0; i < wire.length; i += 997) chunks.push(wire.subarray(i, i + 997));   // header split too
  assert.deepEqual(feed(chunks).map((m) => [m.type, m.body.length]), [["D", big.length], ["C", 8], ["Z", 1]]);
  assert.deepEqual(feed([wire]).map((m) => m.type), ["D", "C", "Z"]);
  assert.deepEqual(feed([wire.subarray(0, 3), wire.subarray(3)]).map((m) => m.type), ["D", "C", "Z"], "a header split in two");
});

/** A connection with a stub socket that records pauses and swallows what is sent. */
function stubbed(): { c: PgConnection; onData: (d: Buffer) => void; paused: () => boolean } {
  const c = new (PgConnection as unknown as { new (o: unknown): PgConnection })({}) as unknown as Record<string, unknown>;
  let paused = false;
  c.socket = { write() { return true; }, pause() { paused = true; }, resume() { paused = false; }, isPaused: () => paused };
  return { c: c as unknown as PgConnection, onData: (c.onData as (d: Buffer) => void).bind(c), paused: () => paused };
}

const row = (value: string): Buffer => {
  const v = Buffer.from(value);
  const body = Buffer.alloc(2 + 4 + v.length);
  body.writeInt16BE(1, 0);
  body.writeInt32BE(v.length, 2);
  v.copy(body, 6);
  const head = Buffer.alloc(5);
  head.write("D", 0);
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
};

test("rows() yields a statement's rows one by one, and the socket pauses on queued BYTES, not only messages", async () => {
  const { c, onData, paused } = stubbed();
  const mb = "y".repeat(1024 * 1024);
  for (let i = 0; i < 20; i++) onData(row(mb));   // 20 MB in 20 messages: far under 1,000 messages
  assert.equal(paused(), true, "20 MB queued pauses the socket");
  onData(message("C", "SELECT 20"));
  onData(message("Z", "I"));
  let n = 0;
  for await (const r of c.rows("SELECT")) { assert.equal(r[0]!.length, mb.length); n++; }
  assert.equal(n, 20);
  assert.equal(paused(), false, "drained, it resumes");
});

// ------------------------------------------------------------------ the connect timeout bounds the whole handshake

test("a server that accepts the socket and never answers the startup is a connect timeout, named as such", async () => {
  const net = await import("node:net");
  const server = net.createServer(() => { /* accepted, never answered: a port proxy in front of a container that is restarting */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const t0 = Date.now();
    await assert.rejects(
      PgConnection.connect({ host: "127.0.0.1", port, user: "u", password: "p", database: "d", sslmode: "disable", connectTimeoutMs: 300 }),
      (e: unknown) => e instanceof Error && /^connecting to 127\.0\.0\.1:\d+ timed out$/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 5_000, "the deadline, not a hang");
  } finally { server.close(); }
});

// ------------------------------------------------------------------ a close ends a read that is waiting

test("closing a connection ends a replication stream waiting for its next message, instead of leaving it waiting for ever", async () => {
  const net = await import("node:net");
  // a server that authenticates, then answers START_REPLICATION with CopyBothResponse and sends nothing more: an idle slot
  const server = net.createServer((sock) => {
    let started = false;
    sock.on("data", (d: Buffer) => {
      if (!started) { started = true; sock.write(Buffer.concat([message("R", "\0\0\0\0"), message("Z", "I")])); return; }
      if (d[0] === 0x51) sock.write(message("W", "\0\0\0"));   // 'Q' START_REPLICATION -> CopyBothResponse
    });
    sock.on("error", () => { /* the client's close resets the socket: nothing of the test's to say */ });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const c = await PgConnection.connect({ host: "127.0.0.1", port, user: "u", password: "p", database: "d", sslmode: "disable", connectTimeoutMs: 2_000 });
    const read = (async () => { for await (const m of c.replicate("START_REPLICATION SLOT s LOGICAL 0/0")) void m; })();
    await new Promise((r) => setTimeout(r, 100));
    c.close();
    const ended = await Promise.race([read.then(() => "returned", (e: Error) => e.message), new Promise((r) => setTimeout(() => r("still waiting"), 2_000))]);
    assert.equal(ended, "connection closed");
  } finally { server.close(); }
});

// ------------------------------------------------------------------ one statement through the extended protocol

const fieldsOf = (...cols: Array<[string, number, number]>): Buffer => {
  const count = Buffer.alloc(2);
  count.writeInt16BE(cols.length);
  const parts: Buffer[] = [count];
  for (const [name, oid, typmod] of cols) {
    const b = Buffer.alloc(18);
    b.writeInt32BE(0, 0); b.writeInt16BE(0, 4); b.writeInt32BE(oid, 6); b.writeInt16BE(-1, 10); b.writeInt32BE(typmod, 12); b.writeInt16BE(0, 16);
    parts.push(Buffer.from(`${name}\0`), b);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write("T", 0);
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
};
const error = (code: string, text: string, severity = "ERROR", more = ""): Buffer => message("E", `S${severity}\0C${code}\0M${text}\0${more}\0`);
const ready = message("Z", "I");

/** A stubbed connection that records what it sent, by message type, and can be closed as the server closes it. */
function recording(): { c: PgConnection; onData: (d: Buffer) => void; sent: string[]; close: (e: Error) => void } {
  const { c, onData } = stubbed();
  const sent: string[] = [];
  (c as unknown as { socket: { write: (b: Buffer) => boolean } }).socket.write = (b: Buffer) => { sent.push(String.fromCharCode(b[0]!)); return true; };
  const fail = (c as unknown as { fail: (e: Error) => void }).fail.bind(c);
  return { c, onData, sent, close: fail };
}

test("extended() is Parse, Bind, Describe, Execute at the row count and Sync, and reads PortalSuspended as rows left", async () => {
  const { c, onData, sent } = recording();
  const r = c.extended("SELECT id, n FROM t", 2);
  for (const m of [message("1", ""), message("2", ""), fieldsOf(["id", 20, -1], ["n", 1700, 655366]), row("1"), row("2"), message("s", ""), ready]) onData(m);
  assert.deepEqual(await r, { fields: [{ name: "id", typeOid: 20, typmod: -1 }, { name: "n", typeOid: 1700, typmod: 655366 }], rows: [["1"], ["2"]], suspended: true, command: "", empty: false });
  assert.deepEqual(sent, ["P", "B", "D", "E", "S"]);
  // every row: CommandComplete's tag, nothing left
  const all = c.extended("SELECT id FROM t", 0);
  for (const m of [message("1", ""), message("2", ""), fieldsOf(["id", 20, -1]), row("1"), message("C", "SELECT 1\0"), ready]) onData(m);
  assert.deepEqual(await all, { fields: [{ name: "id", typeOid: 20, typmod: -1 }], rows: [["1"]], suspended: false, command: "SELECT 1", empty: false });
});

test("extended(): a statement of only comments is EmptyQueryResponse, a statement of no rows NoData", async () => {
  const { c, onData } = recording();
  const empty = c.extended("-- nothing", 10);
  for (const m of [message("1", ""), message("2", ""), message("n", ""), message("I", ""), ready]) onData(m);
  assert.deepEqual(await empty, { fields: [], rows: [], suspended: false, command: "", empty: true });
  const set = c.extended("SET x = 1", 10);
  for (const m of [message("1", ""), message("2", ""), message("n", ""), message("C", "SET\0"), ready]) onData(m);
  assert.deepEqual(await set, { fields: [], rows: [], suspended: false, command: "SET", empty: false });
});

test("an error is thrown at ReadyForQuery with its fields, and the connection answers the next statement", async () => {
  const { c, onData } = recording();
  const bad = c.extended("SELECT nope FROM t", 10);
  for (const m of [error("42703", 'column "nope" does not exist', "ERROR", "P8\0"), ready]) onData(m);
  await assert.rejects(bad, (e: unknown) => e instanceof PgError && e.code === "42703" && e.fields.P === "8" && e.fields.M === 'column "nope" does not exist');
  const next = c.extended("SELECT 1", 10);
  for (const m of [message("1", ""), message("2", ""), fieldsOf(["?column?", 23, -1]), row("1"), message("C", "SELECT 1\0"), ready]) onData(m);
  assert.deepEqual((await next).rows, [["1"]]);
  const q = c.query("SELECT nope");
  for (const m of [error("42703", "nope"), ready]) onData(m);
  await assert.rejects(q, (e: unknown) => e instanceof PgError && e.code === "42703");
  const q2 = c.query("SELECT 2");
  for (const m of [message("C", "SELECT 0\0"), ready]) onData(m);
  assert.equal((await q2).command, "SELECT 0");
});

test("a server that closes the connection after its ErrorResponse (a FATAL) and before ReadyForQuery: that error, never \"connection closed\"", async () => {
  for (const run of ["extended", "query"] as const) {
    const { c, onData, close } = recording();
    const r = run === "extended" ? c.extended("SELECT 1", 10) : c.query("SELECT 1");
    onData(error("57P01", "terminating connection due to administrator command", "FATAL"));
    close(new Error("connection closed by the server"));
    await assert.rejects(r, (e: unknown) => e instanceof PgError && e.code === "57P01" && e.fields.S === "FATAL", run);
    // closed with no error said: the close itself
    const bare = recording();
    const b = run === "extended" ? bare.c.extended("SELECT 1", 10) : bare.c.query("SELECT 1");
    bare.close(new Error("connection closed by the server"));
    await assert.rejects(b, (e: unknown) => !(e instanceof PgError) && (e as Error).message === "connection closed by the server", run);
  }
});

test("cancel() sends Postgres's CancelRequest with the key the server gave at startup, on a connection of its own", async () => {
  const net = await import("node:net");
  const cancels: Buffer[] = [];
  const server = net.createServer((sock) => {
    let first = true;
    sock.on("data", (d: Buffer) => {
      if (d.length === 16 && d.readInt32BE(4) === 80877102) { cancels.push(d); return; }
      if (!first) return;
      first = false;
      const key = Buffer.alloc(13); key.write("K", 0); key.writeInt32BE(12, 1); key.writeInt32BE(4242, 5); key.writeInt32BE(-7, 9);
      sock.write(Buffer.concat([message("R", "\0\0\0\0"), key, ready]));
    });
    sock.on("error", () => { /* the client's close resets the socket: nothing of the test's to say */ });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const c = await PgConnection.connect({ host: "127.0.0.1", port, user: "u", password: "p", database: "d", sslmode: "disable", connectTimeoutMs: 2_000 });
  // closed whatever the test says: an open connection would hold the test process open for ever
  try {
    await c.cancel();
    for (let i = 0; i < 50 && cancels.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(cancels.length, 1);
    assert.deepEqual([cancels[0]!.readInt32BE(0), cancels[0]!.readInt32BE(4), cancels[0]!.readInt32BE(8), cancels[0]!.readInt32BE(12)], [16, 80877102, 4242, -7]);
  } finally { c.close(); server.close(); }
});
