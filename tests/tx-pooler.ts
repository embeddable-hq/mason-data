/**
 * A POOLER IN TRANSACTION MODE WITH ONE SERVER CONNECTION, for the tests that hold Mason to leaving nothing on a pooled
 * server connection (PR 900, issue 930). Behind PgBouncer's `pool_mode = transaction` or Supabase's default pooler URL,
 * one server connection is handed to one client after another, a transaction at a time, and nothing is reset between
 * them. So a session `SET` one client makes is the next client's setting too.
 *
 * The first client's login is passed to the server (so it authenticates the connection). Every later client is
 * answered at once with that login's parameters. Each client is given the server connection from its first message
 * until the server says it is idle outside a transaction ('Z' with 'I'). A real PgBouncer is not installed here or on
 * CI; the pooler's one behaviour these tests need, a server connection shared in turn with nothing reset, is the whole
 * of this one. It works in front of a real Postgres and in front of Mason's own listener alike.
 */
import * as net from "node:net";

/** The messages whole in `buf` (type byte, then a length that counts itself), and what is left over. */
function messages(buf: Buffer): { whole: Buffer[]; rest: Buffer } {
  const whole: Buffer[] = [];
  while (buf.length >= 5 && buf.length >= 1 + buf.readInt32BE(1)) {
    const len = 1 + buf.readInt32BE(1);
    whole.push(buf.subarray(0, len));
    buf = buf.subarray(len);
  }
  return { whole, rest: buf };
}

/** A pooler in transaction mode with one server connection, in front of `to` (see the header). */
export function transactionPooler(to: { host: string; port: number }): Promise<{ port: number; close: () => void; serverConnections: () => number }> {
  const sockets = new Set<net.Socket>();
  let upstream: net.Socket | null = null, servers = 0;
  // what the server said at the login: ParameterStatus ('S') and BackendKeyData ('K'), replayed to every later client
  const login: Buffer[] = [];
  let loggedIn = false;
  let holder: net.Socket | null = null;
  const waiting: Array<() => void> = [];
  const release = (): void => { holder = null; waiting.shift()?.(); };
  let fromServer: Buffer = Buffer.alloc(0);
  const server = net.createServer((client) => {
    sockets.add(client);
    const end = (): void => { client.destroy(); sockets.delete(client); if (holder === client) release(); };
    client.on("error", end).on("close", end);
    let started = false, pending: Buffer = Buffer.alloc(0), fromClient: Buffer = Buffer.alloc(0);
    /** A client's messages, whole; its Terminate ('X') is the pooler's to take, never the server connection's. */
    const send = (d: Buffer): void => {
      fromClient = Buffer.concat([fromClient, d]);
      const { whole, rest } = messages(fromClient);
      fromClient = rest;
      const kept = whole.filter((m) => m[0] !== 0x58);
      if (kept.length) forward(Buffer.concat(kept));
    };
    const forward = (d: Buffer): void => {
      // a client's messages reach the server connection only while it holds it: taken at its first, kept until the
      // server is idle outside a transaction
      const go = (): void => { holder = client; upstream!.write(d); };
      if (holder === client) upstream!.write(d);
      else if (holder === null) go();
      else waiting.push(() => { if (!client.destroyed) go(); else release(); });
    };
    client.on("data", (d: Buffer) => {
      if (started) { send(d); return; }
      pending = Buffer.concat([pending, d]);
      if (pending.length < 8) return;
      const len = pending.readInt32BE(0);
      if (pending.length < len) return;
      const startup = pending.subarray(0, len);
      const after = pending.subarray(len);
      started = true;
      if (upstream === null) {
        // the first client logs the server connection in, its exchange passed through as it is
        servers++;
        upstream = net.connect(to.port, to.host);
        sockets.add(upstream);
        holder = client;
        upstream.on("error", () => undefined);
        upstream.on("data", (b: Buffer) => {
          fromServer = Buffer.concat([fromServer, b]);
          const { whole, rest } = messages(fromServer);
          fromServer = rest;
          for (const m of whole) {
            if (!loggedIn && (m[0] === 0x53 || m[0] === 0x4b)) login.push(Buffer.from(m));
            holder?.write(m);
            if (m[0] === 0x5a) { loggedIn = true; if (m[5] === 0x49) release(); }
          }
        });
        upstream.write(startup);
        if (after.length) upstream.write(after);
        return;
      }
      // a later client: logged in at once, with the first login's parameters, on the same server connection
      client.write(Buffer.concat([Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]), ...login, Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]));
      if (after.length) send(after);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, serverConnections: () => servers,
      close: () => { for (const s of sockets) s.destroy(); server.close(); } }));
  });
}
