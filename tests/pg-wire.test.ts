// The change reader's Postgres client (src/cdc/pg-wire.ts): how the bytes a socket delivers become messages.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { PgConnection } from "../src/cdc/pg-wire.ts";

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
