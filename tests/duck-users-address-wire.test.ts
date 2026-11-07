/**
 * A `mason user`'s ADDRESS RANGES AGAINST A REAL LISTENER (src/duck/users.ts `from`, issue 721): a Postgres listener over
 * a throwaway DuckStore, its logins wired as `mason start` wires them (`listenerLogins` over a `users.json`), and a fake
 * TCP proxy in front of a second listener that names it (`MASON_PG_PROXY_FROM`), so a client's address can be any IPv4 or
 * IPv6 address the PROXY v2 header carries. A user with ranges connects from inside them and is refused from outside,
 * 28000 before its password is checked, in the same words as a name that is no user; a user with none connects as
 * before; a session held when the ranges change ends at its next statement. The listener's own socket is IPv4 loopback
 * here (this machine may have no IPv6), so IPv6 is the header's. src/duck/users.ts is imported inside the tests.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import { parseProxyFrom, type ProxyFrom } from "../src/api/postgres/proxy.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import * as wire from "./postgres-api/wire.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-users-address-"));
const file = path.join(dir, "users.json");
const logs: string[] = [];
let store: DuckStore;
let ledger: RequestLedger;
/** the run's own listener: every client is 127.0.0.1 */
let direct: PgApiServer;
/** a listener behind a proxy on this machine: every client is the one its header carries */
let proxied: PgApiServer;
const proxies: Array<{ close(): Promise<void> }> = [];

const schema: PgSchema = {
  database: "shop",
  tables: [{ name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }] }],
};

let logins: Pick<PgApiOptions, "authenticate" | "recheck" | "recheckMs"> | null = null;
async function wired(): Promise<void> {
  const u = await import("../src/duck/users.ts");
  logins ??= u.listenerLogins(new u.LiveUsers(file, API_KEY), API_KEY);
}

/** the users file as `mason user` writes it: each user with an id, under this API key, its ranges as given */
async function writeUsers(users: Array<{ name: string; id: string; from?: string[] }>): Promise<void> {
  const u = await import("../src/duck/users.ts");
  const text = JSON.stringify({ users: users.map((x) => ({ name: x.name, id: x.id, addedAt: "2026-11-01T00:00:00.000Z", key: u.keyFingerprint(API_KEY), ...(x.from !== undefined ? { from: x.from } : {}) })) });
  // renamed into place, as changeUsers writes it: the listener sees a new inode
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}
const password = async (name: string, id: string): Promise<string> => (await import("../src/duck/users.ts")).userPassword(API_KEY, name, id);

const OFFICE = "0123456789abcdef", BI = "1111111111111111", OPEN = "2222222222222222";

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 'paid'), (2, 'pending')");
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000 });
  const options = async (o: Partial<PgApiOptions>): Promise<PgApiOptions> => ({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: (pw, user, from) => { if (logins === null) throw new Error("not wired"); return logins.authenticate(pw, user, from); },
    recheck: (t, from) => { if (logins?.recheck === undefined) throw new Error("not wired"); return logins.recheck(t, from); },
    recheckMs: 0, schema: () => schema, record: (row) => ledger.record(row), log: (line) => logs.push(line),
    duck: await store.listener(undefined), ...o,
  });
  direct = await startPostgresApi(await options({}));
  proxied = await startPostgresApi(await options({ proxyFrom: parseProxyFrom("127.0.0.1") as ProxyFrom }));
});
after(async () => {
  for (const p of proxies) await p.close();
  await direct?.close();
  await proxied?.close();
  await ledger.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** a TCP proxy of the test's own that begins every connection to `target` with `header` (tests/duck-proxy-wire.test.ts's) */
async function fakeProxy(target: number, header: Buffer): Promise<number> {
  const open = new Set<net.Socket>();
  const server = net.createServer((c) => {
    const up = net.connect(target, "127.0.0.1");
    open.add(c); open.add(up);
    up.write(header);
    c.pipe(up); up.pipe(c);
    const done = (): void => { c.destroy(); up.destroy(); open.delete(c); open.delete(up); };
    for (const s of [c, up]) { s.on("error", done); s.on("close", done); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxies.push({ close: () => new Promise<void>((resolve) => { for (const s of open) s.destroy(); server.close(() => resolve()); }) });
  return (server.address() as net.AddressInfo).port;
}

const client = (port: number, user: string, pw: string): pg.Client => new pg.Client({ host: "127.0.0.1", port, database: "shop", user, password: pw });
async function connects(port: number, user: string, pw: string): Promise<void> {
  const c = client(port, user, pw);
  await c.connect();
  try { assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 2 }]); } finally { await c.end(); }
}
async function refused(port: number, user: string, pw: string): Promise<pg.DatabaseError> {
  const c = client(port, user, pw);
  try { await c.connect(); } catch (e) { return e as pg.DatabaseError; } finally { await c.end().catch((e: Error) => { if (!/not connected|ended/.test(e.message)) throw e; }); }
  assert.fail(`${user} connected`);
}
const NO_ENTRY_HINT = "a user limited to address ranges connects only from them: mason user list shows each user's ranges, mason user from <name> changes them";

test("a user with ranges connects from an address in them and is refused from any other, 28000 before its password, over IPv4 and IPv6 headers", async () => {
  await wired();
  await writeUsers([{ name: "office", id: OFFICE, from: ["127.0.0.1"] }, { name: "bi", id: BI, from: ["203.0.113.0/24", "2001:db8:7::/48"] }, { name: "open", id: OPEN }]);
  // the listener's own socket: 127.0.0.1
  await connects(direct.port, "office", await password("office", OFFICE));
  const out = await refused(direct.port, "bi", await password("bi", BI));
  assert.equal(out.code, "28000");
  assert.equal(out.message, 'no entry for host "127.0.0.1", user "bi"');
  assert.equal(out.hint, NO_ENTRY_HINT);
  // judged before the password: a wrong one from outside is the same refusal, never 28P01
  const wrong = await refused(direct.port, "bi", "mason_1111111111111111_00000000000000000000000000000000");
  assert.deepEqual([wrong.code, wrong.message], ["28000", 'no entry for host "127.0.0.1", user "bi"']);
  assert.ok(logs.some((l) => /refused: the user "bi" may not connect from 127\.0\.0\.1, outside its address ranges \(mason user list shows them\)/.test(l)), "the log says the address");
  // through the proxy, the client its header carries
  await connects(await fakeProxy(proxied.port, wire.proxyV2Inet4("203.0.113.40", 50000)), "bi", await password("bi", BI));
  await connects(await fakeProxy(proxied.port, wire.proxyV2Inet6("20010db8000700000000000000000009", 50000)), "bi", await password("bi", BI));
  const v4 = await refused(await fakeProxy(proxied.port, wire.proxyV2Inet4("198.51.100.9", 50000)), "bi", await password("bi", BI));
  assert.deepEqual([v4.code, v4.message], ["28000", 'no entry for host "198.51.100.9", user "bi"']);
  const v6 = await refused(await fakeProxy(proxied.port, wire.proxyV2Inet6("20010db8000800000000000000000009", 50000)), "bi", await password("bi", BI));
  assert.deepEqual([v6.code, v6.message], ["28000", 'no entry for host "2001:db8:8::9", user "bi"']);
  // a v4-mapped source is its IPv4 client
  await connects(await fakeProxy(proxied.port, wire.proxyV2Inet6("00000000000000000000ffffcb007101", 50000)), "bi", await password("bi", BI));
  // a user with no ranges connects from anywhere, as before
  await connects(direct.port, "open", await password("open", OPEN));
  await connects(await fakeProxy(proxied.port, wire.proxyV2Inet6("20010db8ffff00000000000000000001", 50000)), "open", await password("open", OPEN));
});

test("the refusal does not tell a missing user from a wrong address, while any user has ranges; with none, a missing user is 28P01 as before", async () => {
  await wired();
  await writeUsers([{ name: "bi", id: BI, from: ["203.0.113.0/24"] }, { name: "open", id: OPEN }]);
  const port = await fakeProxy(proxied.port, wire.proxyV2Inet4("198.51.100.9", 50000));
  const limited = await refused(port, "bi", "mason_1111111111111111_00000000000000000000000000000000");
  const missing = await refused(port, "nobody", "mason_3333333333333333_00000000000000000000000000000000");
  assert.deepEqual([missing.code, missing.message.replace('"nobody"', '"bi"'), missing.hint, missing.detail], [limited.code, limited.message, limited.hint, limited.detail]);
  assert.equal(missing.message, 'no entry for host "198.51.100.9", user "nobody"');
  // no user has ranges: nothing changes for anyone
  await writeUsers([{ name: "open", id: OPEN }]);
  const before = await refused(direct.port, "nobody", "mason_3333333333333333_00000000000000000000000000000000");
  assert.equal(before.code, "28P01");
});

test("a session held when its user's ranges change ends at its next statement; one still inside them goes on", async () => {
  await wired();
  await writeUsers([{ name: "office", id: OFFICE, from: ["127.0.0.0/8"] }, { name: "open", id: OPEN }]);
  const held = client(direct.port, "office", await password("office", OFFICE));
  const stays = client(direct.port, "open", await password("open", OPEN));
  await held.connect();
  await stays.connect();
  held.on("error", () => undefined);   // the FATAL that ends it, also emitted on the client
  try {
    assert.equal((await held.query("SELECT 1 AS one")).rows[0].one, 1);
    await writeUsers([{ name: "office", id: OFFICE, from: ["10.0.0.0/8"] }, { name: "open", id: OPEN, from: ["127.0.0.1"] }]);
    const e = await held.query("SELECT 1 AS one").then(() => null, (x: pg.DatabaseError) => x);
    assert.ok(e !== null, "the session ends");
    assert.equal(e.code, "28000");
    assert.match(e.message, /^the session's user is no longer accepted: the user "office" may not connect from 127\.0\.0\.1: its address ranges are 10\.0\.0\.0\/8$/);
    assert.equal((await stays.query("SELECT 1 AS one")).rows[0].one, 1, "a user whose new ranges hold its address goes on");
  } finally {
    await held.end().catch((x: Error) => { if (!/not connected|ended|terminated/i.test(x.message)) throw x; });
    await stays.end();
  }
});

test("an address that could not be read is refused for a user with ranges, and only for one", async () => {
  await wired();
  await writeUsers([{ name: "bi", id: BI, from: ["203.0.113.0/24"] }, { name: "open", id: OPEN }]);
  const u = await import("../src/duck/users.ts");
  const live = new u.LiveUsers(file, API_KEY);
  const pwBi = await password("bi", BI), pwOpen = await password("open", OPEN);
  assert.throws(() => live.login("bi", pwBi, null), (e: Error & { code?: string }) => e.code === "address_not_allowed" && /an address that could not be read/.test(e.message));
  assert.throws(() => live.login("bi", pwBi), (e: Error & { code?: string }) => e.code === "address_not_allowed", "no address given is none read: fail closed");
  assert.equal(live.login("bi", pwBi, "203.0.113.5").user, "bi");
  assert.equal(live.login("open", pwOpen, null).user, "open");
  // the run's own wiring, given no address
  const l = u.listenerLogins(live, API_KEY);
  assert.throws(() => l.authenticate(pwBi, "bi", null), (e: Error & { code?: string }) => e.code === "address_not_allowed");
  const t = live.login("bi", pwBi, "203.0.113.5");
  assert.throws(() => live.recheck(t, null), (e: Error & { code?: string }) => e.code === "address_not_allowed");
});
