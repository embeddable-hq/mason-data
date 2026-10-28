/**
 * THE DEMO DATABASE (src/demo/source.ts, src/demo/seed.ts): PGlite in a folder, served on a loopback port, read by
 * Mason exactly as an application's database is — its own client (the checks and the catalog reads), and DuckDB's
 * `postgres` extension through libpq (the copy in parallel chunks, the poll). Offline but for one thing: the first copy
 * on a machine installs the extension from DuckDB's repository (then ~/.duckdb/extensions), as every copy does.
 *
 * One source is shared by the tests that only read it or undo what they write (`shared`, opened once, lazily, so each
 * test fails by name at a commit without the module); the reopen and the held port make their own.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { BackendDecoder, cstr, frame, int32 } from "../src/api/postgres/protocol.ts";
import { PgConnection, PgError } from "../src/cdc/pg-wire.ts";
import { checkSource, parseSource, readSourceFacts } from "../src/cli/preflight.ts";
import { DuckStore } from "../src/duck/store.ts";
import { Sync } from "../src/duck/sync.ts";

// imported when the tests run: at a commit without the module the file still loads, and each test fails by name
const demoModule = await import("../src/demo/source.ts" as string).catch(() => ({})) as Record<string, unknown>;

interface DemoSourceLike {
  readonly port: number; readonly url: string; readonly seeded: boolean;
  change(): Promise<string>; close(): Promise<void>;
}
interface DemoModule {
  DEMO_DATABASE: string; DEMO_USER: string; demoUrl: (port: number) => string;
  DemoSource: { open(o: { dir: string; port: number; log: (line: string) => void }): Promise<DemoSourceLike> };
  optionSettings: (options: string) => Array<[string, string]>;
}
function demo(): DemoModule {
  if (typeof demoModule.DemoSource !== "function") throw new Error("src/demo/source.ts does not export DemoSource");
  return demoModule as unknown as DemoModule;
}

const tmp = (what: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `mason-demo-${what}-`));
const dirs: string[] = [];
const opened: DemoSourceLike[] = [];
after(async () => {
  for (const s of opened) await s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function openAt(dir: string, log: string[] = []): Promise<DemoSourceLike> {
  const s = await demo().DemoSource.open({ dir, port: 0, log: (l) => log.push(l) });
  opened.push(s);
  return s;
}

const sharedLog: string[] = [];
let sharedSource: Promise<DemoSourceLike> | null = null;
function shared(): Promise<DemoSourceLike> {
  if (sharedSource === null) {
    const dir = tmp("shared");
    dirs.push(dir);
    sharedSource = openAt(path.join(dir, "pg"), sharedLog);
  }
  return sharedSource;
}

const connect = (s: DemoSourceLike, o: { sslmode?: "prefer" | "disable"; database?: string } = {}): Promise<PgConnection> =>
  PgConnection.connect({ host: "127.0.0.1", port: s.port, database: o.database ?? "demo", user: "demo", password: "", sslmode: o.sslmode ?? "prefer" });

async function counts(s: DemoSourceLike): Promise<Record<string, number>> {
  const c = await connect(s);
  try {
    const r = (await c.query("SELECT (SELECT count(*) FROM customers), (SELECT count(*) FROM products), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items)")).rows[0]!;
    return { customers: Number(r[0]), products: Number(r[1]), orders: Number(r[2]), order_items: Number(r[3]) };
  } finally { c.close(); }
}

test("the demo database is read as a Postgres: Mason's client connects under sslmode prefer and disable, reads the four tables with their keys, foreign keys and row estimates, and the source check passes", async () => {
  const s = await shared();
  assert.equal(s.seeded, true, "a new folder is seeded");
  assert.equal(s.url, `postgres://demo@127.0.0.1:${s.port}/demo`);
  assert.equal(demo().demoUrl(5999), "postgres://demo@127.0.0.1:5999/demo");
  assert.ok(sharedLog.some((l) => /^demo database: seeded customers 200, products 50, orders 5,000, order_items 1\d,\d{3} rows/.test(l)), sharedLog.join("\n"));

  for (const sslmode of ["prefer", "disable"] as const) {
    const c = await connect(s, { sslmode });
    try {
      assert.deepEqual((await c.query("SELECT current_database(), current_user")).rows, [["demo", "demo"]], `sslmode ${sslmode}: the database and the user the URL names`);
      assert.match(c.parameters.server_version ?? "", /^18\./, "the startup reports PGlite's server_version");
      assert.equal(c.parameters.TimeZone, "UTC", "the client's TimeZone is the session's");
      assert.equal(c.parameters.DateStyle, "ISO, YMD");
      assert.equal(c.parameters.in_hot_standby, "off");
      const facts = await readSourceFacts(c, new Map());
      assert.equal(facts.standby, false);
      assert.ok(facts.version >= 180000, `version ${facts.version}`);
      assert.deepEqual(facts.tables.map((t) => [t.source, t.key]),
        [["public.customers", ["id"]], ["public.order_items", ["id"]], ["public.orders", ["id"]], ["public.products", ["id"]]]);
      const fks = facts.tables.flatMap((t) => t.foreignKeys.map((f) => `${t.source}.${f.column} -> ${f.target}.${f.targetColumn}`)).sort();
      assert.deepEqual(fks, ["public.order_items.order_id -> public.orders.id", "public.order_items.product_id -> public.products.id",
        "public.orders.customer_id -> public.customers.id"]);
      const rows = Object.fromEntries(facts.tables.map((t) => [t.table, t.rows]));
      assert.deepEqual({ customers: rows.customers, products: rows.products, orders: rows.orders }, { customers: 200, products: 50, orders: 5_000 },
        "ANALYZE after the seed: the estimates are the counts");
      assert.ok((rows.order_items ?? 0) > 12_000 && (rows.order_items ?? 0) < 18_000, `about 15,000 order items, ${rows.order_items}`);
      const orders = facts.tables.find((t) => t.table === "orders")!;
      assert.deepEqual(orders.columns.map((col) => `${col.name} ${col.type}`),
        ["id bigint", "customer_id bigint", "status text", "total numeric(12,2)", "created_at timestamp with time zone"]);
    } finally { c.close(); }
  }

  const said: string[] = [];
  const checked = await checkSource(s.url, { remote: false, cmd: "test", say: (m) => said.push(m) });
  assert.ok("source" in checked && "facts" in checked, `the check passes:\n${said.join("\n")}`);
  assert.equal(checked.facts.tables.length, 4);

  await assert.rejects(connect(s, { database: "shop" }), (e: unknown) => e instanceof PgError && e.code === "3D000" && /database "shop" does not exist/.test(e.message));
  // a replication connection is refused in the developer's words: what the demo lacks, never the engine's name
  await assert.rejects(PgConnection.connect({ host: "127.0.0.1", port: s.port, database: "demo", user: "demo", password: "", sslmode: "disable", replication: true }),
    (e: unknown) => e instanceof PgError && e.code === "0A000" && e.message === "FATAL: the demo database has no change log to stream: Mason polls it");
  assert.ok(sharedLog.some((l) => /asked for database "shop"; refused/.test(l)), "a refused database is said in the log");
});

test("the orders span the twelve months before the seed, every month holding some, and each total is its items' sum", async () => {
  const s = await shared();
  const c = await connect(s);
  try {
    const r = (await c.query(`SELECT count(DISTINCT date_trunc('month', created_at)), min(created_at) > now() - interval '366 days', max(created_at) <= now(),
      (SELECT count(*) FROM orders o WHERE o.total <> (SELECT sum(quantity * unit_price) FROM order_items i WHERE i.order_id = o.id))
      FROM orders`)).rows[0]!;
    assert.ok(Number(r[0]) >= 12, `months with orders: ${r[0]}`);
    assert.deepEqual(r.slice(1), ["t", "t", "0"]);
  } finally { c.close(); }
});

test("two clients share the one session in turn: a transaction holds it until its COMMIT, and a client that leaves mid-transaction is rolled back", async () => {
  const s = await shared();
  const a = await connect(s);
  const b = await connect(s);
  const before = (await b.query("SELECT count(*) FROM customers")).rows[0]?.[0];
  try {
    await a.query("BEGIN");
    await a.query("INSERT INTO customers (name, email, country) VALUES ('Test Turns', 'turns@example.com', 'Nowhere')");
    let answered = false;
    const waiting = b.query("SELECT count(*) FROM customers").then((r) => { answered = true; return r.rows[0]?.[0]; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(answered, false, "B waits while A's transaction is open");
    assert.equal((await a.query("SELECT count(*) FROM customers")).rows[0]?.[0], String(Number(before) + 1), "A sees its own insert");
    await a.query("DELETE FROM customers WHERE email = 'turns@example.com'");
    assert.equal((await a.query("COMMIT")).command, "COMMIT");
    assert.equal(await waiting, before, "B answers once A committed, and sees what A committed");

    // a client that ends inside a transaction: its insert never lands, and the next BEGIN opens a transaction of its own
    const c = await connect(s);
    await c.query("BEGIN");
    await c.query("INSERT INTO customers (name, email, country) VALUES ('Test Gone', 'gone@example.com', 'Nowhere')");
    c.close();
    await b.query("BEGIN");
    assert.equal((await b.query("COMMIT")).command, "COMMIT");
    assert.equal((await b.query("SELECT count(*) FROM customers WHERE email = 'gone@example.com'")).rows[0]?.[0], "0", "the departed client's insert was rolled back, not committed by B");
    assert.ok(sharedLog.some((l) => /ended inside a transaction; rolled back/.test(l)), sharedLog.join("\n"));

    // an error inside a transaction leaves it failed for that client alone, until its ROLLBACK
    await a.query("BEGIN");
    await assert.rejects(a.query("SELECT 1/0"), (e: unknown) => e instanceof PgError && e.code === "22012");
    await assert.rejects(a.query("SELECT 1"), (e: unknown) => e instanceof PgError && e.code === "25P02");
    await a.query("ROLLBACK");
    assert.equal((await b.query("SELECT 2")).rows[0]?.[0], "2");
  } finally { a.close(); b.close(); }
});

test("each client meets the settings its startup asked for at every turn, after another client's and after its own DISCARD ALL; the extended protocol's errors are Postgres's", async () => {
  const s = await shared();
  assert.deepEqual(demo().optionSettings("-c TimeZone=Asia/Tokyo --search-path=public -cDateStyle=ISO,\\ DMY"),
    [["TimeZone", "Asia/Tokyo"], ["search_path", "public"], ["DateStyle", "ISO, DMY"]]);
  const mason = await connect(s);
  const tokyo = new pg.Client({ host: "127.0.0.1", port: s.port, database: "demo", user: "someone", options: "-c TimeZone=Asia/Tokyo" });
  await tokyo.connect();
  try {
    assert.equal((await tokyo.query("SHOW TimeZone")).rows[0]?.TimeZone, "Asia/Tokyo");
    assert.equal((await mason.query("SHOW TimeZone")).rows[0]?.[0], "UTC");
    assert.equal((await tokyo.query("SHOW TimeZone")).rows[0]?.TimeZone, "Asia/Tokyo", "applied again at its turn");
    await tokyo.query("DISCARD ALL");
    assert.equal((await tokyo.query("SHOW TimeZone")).rows[0]?.TimeZone, "Asia/Tokyo", "a DISCARD ALL returns a client to its startup's settings, as on Postgres");
    // node-postgres's extended protocol: parameters, and an error answered once, at the Sync
    assert.deepEqual((await tokyo.query("SELECT $1::int + 1 AS n", [41])).rows, [{ n: 42 }]);
    await assert.rejects(tokyo.query("SELECT 1 / $1::int", [0]), /division by zero/);
    assert.deepEqual((await tokyo.query("SELECT $1::text AS t", ["after"])).rows, [{ t: "after" }], "the connection is in step after the error");
    assert.equal((await mason.query("SELECT 'ok'")).rows[0]?.[0], "ok");
  } finally { mason.close(); await tokyo.end(); }
});

/** a client of raw protocol bytes: the startup done, then what the server sends, as frame types, until n ReadyForQuery */
async function rawClient(port: number): Promise<{ send: (...frames: Buffer[]) => void; until: (readies: number) => Promise<string[]>; close: () => void }> {
  const socket = net.connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const decoder = new BackendDecoder();
  const seen: string[] = [];
  let wake: (() => void) | null = null;
  socket.on("data", (d: Buffer) => {
    decoder.push(d);
    for (let m = decoder.next(); m !== null; m = decoder.next()) seen.push(m.type === "ReadyForQuery" ? `Z${m.status}` : m.type);
    wake?.();
  });
  const until = async (readies: number): Promise<string[]> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      let n = 0;
      const i = seen.findIndex((t) => t.startsWith("Z") && ++n === readies);
      if (i >= 0) return seen.splice(0, i + 1);
      if (Date.now() > deadline) throw new Error(`no ${readies} ReadyForQuery in 5 s: ${seen.join(" ")}`);
      await new Promise<void>((r) => { wake = r; setTimeout(r, 100); });
    }
  };
  const body = Buffer.concat([int32(196608), cstr("user"), cstr("demo"), cstr("database"), cstr("demo"), Buffer.from([0])]);
  socket.write(Buffer.concat([int32(body.length + 4), body]));
  const startup = await until(1);
  assert.equal(startup[0], "AuthenticationOk");
  assert.equal(startup.at(-1), "ZI");
  return { send: (...frames) => socket.write(Buffer.concat(frames)), until, close: () => socket.end() };
}

test("an error in the extended protocol is answered as Postgres answers it: one ReadyForQuery, at the Sync, and nothing before the Sync after an error under a Flush", async () => {
  const s = await shared();
  const c = await rawClient(s.port);
  const parse = (sql: string): Buffer => frame("P", cstr(""), cstr(sql), Buffer.from([0, 0]));
  const bind = frame("B", cstr(""), cstr(""), Buffer.from([0, 0, 0, 0, 0, 0]));
  const execute = frame("E", cstr(""), int32(0));
  const query = (sql: string): Buffer => frame("Q", cstr(sql));
  try {
    // PGlite answers this `ParseComplete E Z Z` (the constant 1 / 0 fails at the Bind, as on Postgres); Postgres, and so
    // the relay, one Z
    c.send(parse("SELECT 1 / 0"), bind, execute, frame("S"), query("SELECT 1"));
    assert.deepEqual(await c.until(2), ["ParseComplete", "ErrorResponse", "ZI", "RowDescription", "DataRow", "CommandComplete", "ZI"]);
    // a failed Parse under a Flush: its error at once and no Z; the Bind and Execute after it ignored until the Sync
    c.send(parse("SELEC 1"), frame("H"));
    c.send(bind, execute, frame("S"), query("SELECT 1"));
    assert.deepEqual(await c.until(2), ["ErrorResponse", "ZI", "RowDescription", "DataRow", "CommandComplete", "ZI"]);
    // the same inside a transaction: failed until its ROLLBACK
    c.send(query("BEGIN"), parse("SELECT 1 / 0"), bind, execute, frame("S"), query("ROLLBACK"));
    assert.deepEqual(await c.until(3), ["CommandComplete", "ZT", "ParseComplete", "ErrorResponse", "ZE", "CommandComplete", "ZI"]);
  } finally { c.close(); }
});

test("the copy reads the demo database with three readers in parallel chunks, every table whole, and a round of changes reaches the copy at the next poll", async () => {
  const s = await shared();
  const dir = tmp("copy");
  dirs.push(dir);
  const c = await connect(s);
  let facts;
  try { facts = await readSourceFacts(c, new Map()); } finally { c.close(); }
  const parsed = parseSource(s.url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "duck.db"), (l) => logged.push(l), { memoryLimit: "256MB" });
  const readers = new Set<number>();
  // small chunks (1,200 rows), so each of the larger tables is read by the three readers side by side
  const sync = new Sync(store, parsed.source, "demo", (l) => logged.push(l), 3_600_000, "poll", null,
    { copyParallel: 3, copyChunkRows: 1_200, onChunk: (e) => { if (e.phase === "committed") readers.add(e.reader); } });
  const copied = async (table: string): Promise<number> => Number((await store.writer.runAndReadAll(`SELECT count(*) FROM public.${table}`)).getRowsJS()[0]?.[0]);
  try {
    await sync.open();
    await sync.setTables(facts.tables);
    await sync.once();
    const source = await counts(s);
    for (const t of ["customers", "products", "orders", "order_items"]) {
      assert.equal(await copied(t), source[t], `${t}: the copy holds the source's rows\n${logged.slice(-8).join("\n")}`);
    }
    assert.deepEqual([...readers].sort(), [0, 1, 2], "three readers each committed chunks");
    assert.ok(sync.state().every((x) => x.phase === "copied"), JSON.stringify(sync.state()));

    const said = await s.change();
    assert.match(said, /^order (\d+) placed by customer \d+ \(\d items?, \d+\.\d\d\)(; order \d+ \w+ → \w+)?$/);
    const id = Number(/^order (\d+)/.exec(said)![1]);
    await sync.pollNow(["public.orders", "public.order_items"]);
    const afterChange = await counts(s);
    assert.equal(await copied("orders"), afterChange.orders, "the new order is in the copy");
    assert.equal(await copied("order_items"), afterChange.order_items, "its items too");
    assert.deepEqual((await store.writer.runAndReadAll(`SELECT status FROM public.orders WHERE id = ${id}`)).getRowsJS(), [["pending"]]);
  } finally {
    await sync.stop();
    store.close();
  }
});

test("a closed folder opens again as it was: not seeded again, its rows and a change kept", async () => {
  const dir = path.join(tmp("reopen"), "pg");
  dirs.push(path.dirname(dir));
  const first = await openAt(dir);
  assert.equal(first.seeded, true);
  await first.change();
  const before = await counts(first);
  await first.close();
  await first.close();   // idempotent
  const log: string[] = [];
  const second = await openAt(dir, log);
  assert.equal(second.seeded, false, "a folder already seeded is not seeded again");
  assert.deepEqual(await counts(second), before);
  assert.ok(!log.some((l) => /seeded/.test(l)), log.join("\n"));
  await second.close();
});

test("a port already held refuses the open with an Error naming the port, before anything is made in the folder", async () => {
  const held = net.createServer();
  await new Promise<void>((resolve) => held.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const port = (held.address() as net.AddressInfo).port;
  const dir = path.join(tmp("port"), "pg");
  dirs.push(path.dirname(dir));
  try {
    await assert.rejects(demo().DemoSource.open({ dir, port, log: () => undefined }),
      // what failed alone, and no way out: src/cli/demo.ts openDemo says that once, in the project's words
      (e: unknown) => e instanceof Error && e.message === `the demo database cannot listen on 127.0.0.1:${port}: port ${port} is in use`);
    assert.equal(fs.existsSync(dir), false, "nothing was made in the folder");
  } finally {
    await new Promise<void>((resolve) => held.close(() => resolve()));
  }
});

test("every open analyses the folder: one whose seed committed but whose ANALYZE never ran (a process ended between them) has row estimates again", async () => {
  const dir = path.join(tmp("analyze"), "pg");
  dirs.push(path.dirname(dir));
  const first = await openAt(dir);
  await first.close();
  // the window mimicked: the seed's rows there, the catalog's estimates unset as before any ANALYZE
  const db = new PGlite({ dataDir: dir, database: "demo", username: "demo" });
  try {
    await db.waitReady;
    await db.exec("UPDATE pg_class SET reltuples = -1, relpages = 0 WHERE relname IN ('customers', 'products', 'orders', 'order_items') AND relkind = 'r'");
    assert.deepEqual((await db.query<{ n: number }>("SELECT reltuples::int AS n FROM pg_class WHERE relname = 'orders' AND relkind = 'r'")).rows, [{ n: -1 }]);
  } finally { await db.close(); }
  const second = await openAt(dir);
  assert.equal(second.seeded, false);
  const c = await connect(second);
  try {
    // the catalog's own estimates (a small table never analysed is counted by the facts' reader, so those are read here)
    const r = (await c.query("SELECT relname, reltuples::bigint FROM pg_class WHERE relname IN ('customers', 'products', 'orders') AND relkind = 'r' ORDER BY relname")).rows;
    assert.deepEqual(r, [["customers", "200"], ["orders", "5000"], ["products", "50"]], "pg_class.reltuples are the counts again");
  } finally { c.close(); }
  await second.close();
});
