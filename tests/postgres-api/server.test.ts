/**
 * THE POSTGRES LISTENER'S SESSION, driven by a real Postgres driver (node-postgres) against the server over a DuckDB
 * store of two tables: what a tool sees on the wire — the handshake, the password, the parameters it sets, the catalog
 * answered by the Postgres inside, transactions, two sessions over one catalog, refusals with a SQLSTATE and a position,
 * and the log line each refusal is. What DuckDB answers, and how, is tests/duck-wire.test.ts's; a user's password is
 * tests/duck-users-wire.test.ts's; the bytes of a value are encode.test.ts's; this file is the session's.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { ApiError } from "../../src/api/error.ts";
import { startPostgresApi, type DuckOptions, type DuckRunner, type PgApiServer, type PgToken } from "../../src/api/postgres/server.ts";
import type { PgSchema } from "../../src/api/postgres/schema.ts";
import { DuckStore } from "../../src/duck/store.ts";
import * as wire from "./wire.ts";

const SCHEMA: PgSchema = {
  database: "shop",
  tables: [
    {
      name: "orders", description: "one order", primaryKey: ["id"],
      columns: [
        { name: "id", type: "int8" }, { name: "status", type: "text", description: "paid, refunded…" }, { name: "amount", type: "float8" },
        { name: "created_at", type: "timestamptz" }, { name: "customer_id", type: "int8" }, { name: "gift", type: "bool" },
        { name: "notes", type: "text" },
      ],
      joins: [{ name: "customers", table: "public.customers", on: ["customer_id", "id"], relationship: "many_to_one" }],
    },
    {
      name: "customers", primaryKey: ["id"],
      columns: [{ name: "id", type: "int8" }, { name: "name", type: "text" }, { name: "region", type: "text" }],
      joins: [],
    },
  ],
};

/** the rows DuckDB holds (id, status, amount, created_at, customer_id, gift, notes) */
const ORDERS = [
  "(1, 'paid', 10.5, '2026-09-01 10:00:00+00', 1, false, NULL)",
  "(2, 'refunded', 4, '2026-09-02 10:00:00+00', 2, false, 'late')",
  "(3, 'paid', 7.25, '2026-09-03 10:00:00+00', 1, true, NULL)",
  "(7, 'paid', 12, '2026-09-07 10:00:00+00', 2, false, NULL)",
  "(9, 'open', 1, '2026-09-09 10:00:00+00', 1, false, NULL)",
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-server-"));
let store: DuckStore;
let listener: DuckOptions;
let server: PgApiServer;

const tokenFor = async (password: string): Promise<PgToken> => {
  if (password === "good-token") return {};
  throw new ApiError(401, password === "api-key" ? "that is the API key, not a token" : "invalid token", "invalid_token");
};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  await store.writer.run(`CREATE TABLE public.orders (id BIGINT, status VARCHAR, amount DOUBLE, created_at TIMESTAMPTZ, customer_id BIGINT, gift BOOLEAN, notes VARCHAR)`);
  await store.writer.run(`INSERT INTO public.orders VALUES ${ORDERS.join(", ")}`);
  await store.writer.run(`CREATE TABLE public.customers (id BIGINT, name VARCHAR, region VARCHAR)`);
  await store.writer.run(`INSERT INTO public.customers VALUES (1, 'Ada', 'eu'), (2, 'Bo', 'us')`);
  listener = await store.listener(undefined);
  server = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: (p) => tokenFor(p),
    schema: () => SCHEMA,
    record: () => undefined,
    log: () => undefined,
    duck: listener,
  });
});
after(async () => {
  await server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const connect = async (over: Partial<pg.ClientConfig> = {}): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: server.port, user: "anyone", password: "good-token", database: "shop", application_name: "the-test", ...over });
  await c.connect();
  return c;
};

const refused = async (p: Promise<unknown>): Promise<pg.DatabaseError> => {
  try { await p; } catch (err) { return err as pg.DatabaseError; }
  throw new Error("expected a refusal");
};

describe("the handshake", () => {
  test("a valid token connects; the API key and a wrong token are a failed password (28P01) with the way out", async () => {
    const c = await connect();
    await c.end();
    const key = await refused(connect({ password: "api-key" }));
    assert.equal(key.code, "28P01");
    assert.match(key.message, /password authentication failed for user "anyone": that is the API key/);
    assert.match(key.hint ?? "", /mason user add <name>/);
    const bad = await refused(connect({ password: "nope" }));
    assert.equal(bad.code, "28P01");
  });

  test("the database must be the one this Mason answers as (3D000: the right name, how to say it, where it is set)", async () => {
    const e = await refused(connect({ database: "postgres" }));
    assert.equal(e.code, "3D000");
    assert.match(e.message, /database "postgres" does not exist/);
    assert.equal(e.hint, "this Mason answers as the database \"shop\": connect with database=shop, the last part of a postgres:// URL. " +
      "It is set by database: in the project's sources file (sources/<name>.yml), or MASON_PG_DATABASE on a server");
    // Postgres compares a database's name exactly: a tool that says another case is on another database
    assert.equal((await refused(connect({ database: "Shop" }))).code, "3D000");
  });

  test("the server reports itself as Postgres 18.6 and the session's parameters", async () => {
    const c = await connect();
    const v = await c.query("SELECT version()");
    assert.match(String(v.rows[0]!.version), /^PostgreSQL 18\.6 \(Mason test\) on (aarch64|x86_64)-(linux|darwin)$/);
    const r = await c.query("SHOW server_version");
    assert.equal(r.rows[0]!.server_version, "18.6");
    const n = await c.query("SELECT current_setting('server_version_num') AS n");
    assert.equal(n.rows[0]!.n, "180006");
    const tz = await c.query("SHOW TimeZone");
    assert.equal(tz.rows[0]!.TimeZone, "UTC");
    await c.end();
  });

  test("the catalog's database is the one the tool connected to: current_database(), pg_database (pgjdbc's getCatalogs)", async () => {
    // the sidecar's own `postgres` was every tool's catalog name before the tools' recording (DBeaver names the
    // database by current_database(); pgjdbc's TABLE_CAT is it)
    const c = await connect();
    const r = await c.query("SELECT current_database() AS db, current_catalog AS cat");
    assert.deepEqual(r.rows[0], { db: "shop", cat: "shop" });
    const d = await c.query("SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname");
    assert.deepEqual(d.rows.map((x) => x.datname), ["shop"]);
    await c.end();
  });
});

describe("session parameters", () => {
  test("TimeZone moves the session's zone and is reported; an unknown zone is 22023", async () => {
    const c = await connect();
    await c.query("SET TimeZone = 'Europe/London'");
    assert.equal((await c.query("SHOW TimeZone")).rows[0]!.TimeZone, "Europe/London");
    const e = await refused(c.query("SET TimeZone = 'Mars/Olympus'"));
    assert.equal(e.code, "22023");
    await c.query("SET TIME ZONE 'UTC'");
    assert.equal((await c.query("SHOW timezone")).rows[0]!.TimeZone, "UTC");
    await c.end();
  });

  test("extra_float_digits below 1 is refused by name; the default is accepted", async () => {
    const c = await connect();
    await c.query("SET extra_float_digits = 3");
    const e = await refused(c.query("SET extra_float_digits = 0"));
    assert.equal(e.code, "0A000");
    assert.match(e.message, /shortest text that reads back exactly/);
    await c.end();
  });

  test("a parameter Mason has no opinion on is validated by Postgres and remembered; an unknown one is 42704", async () => {
    const c = await connect();
    await c.query("SET lc_monetary = 'C'");
    assert.equal((await c.query("SHOW lc_monetary")).rows[0]!.lc_monetary, "C");
    const e = await refused(c.query("SET no_such_parameter = 1"));
    assert.equal(e.code, "42704");
    await c.end();
  });

  test("a client encoding other than UTF8 and a non-ISO DateStyle are refused", async () => {
    const c = await connect();
    assert.equal((await refused(c.query("SET client_encoding = 'LATIN1'"))).code, "22023");
    assert.equal((await refused(c.query("SET DateStyle = 'German'"))).code, "0A000");
    await c.query("SET DateStyle = 'ISO, DMY'");
    await c.query("SET client_encoding = 'UTF8'");
    await c.end();
  });

  test("Metabase's and Grafana's session statements are accepted", async () => {
    const c = await connect();
    await c.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ UNCOMMITTED");
    // remembered, as Postgres answers it (GitHub issue 64): nothing is ever written, so every level answers the same rows
    assert.equal((await c.query("SHOW TRANSACTION ISOLATION LEVEL")).rows[0]!.transaction_isolation, "read uncommitted");
    await c.query("SET statement_timeout = 30000");
    await c.query("SET application_name = 'grafana'");
    assert.equal((await c.query("SHOW application_name")).rows[0]!.application_name, "grafana");
    await c.end();
  });
});

describe("the catalog", () => {
  test("pg_catalog and information_schema show the copied tables, their columns typed, their foreign keys as foreign keys", async () => {
    const c = await connect();
    const tables = await c.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY 1");
    assert.deepEqual(tables.rows.map((r) => r.tablename), ["customers", "orders"]);
    const cols = await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders' ORDER BY ordinal_position");
    assert.deepEqual(cols.rows.map((r) => [r.column_name, r.data_type]), [
      ["id", "bigint"], ["status", "text"], ["amount", "double precision"], ["created_at", "timestamp with time zone"],
      ["customer_id", "bigint"], ["gift", "boolean"], ["notes", "text"],
    ]);
    const note = await c.query("SELECT obj_description('public.orders'::regclass, 'pg_class') AS t");
    assert.equal(note.rows[0]!.t, "one order");
    // a tool naming every listed column reads the rows (DuckDB answers them)
    const listed = (await c.query("SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS l FROM information_schema.columns WHERE table_name = 'orders'")).rows[0]!.l as string;
    const every = await c.query(`SELECT ${listed} FROM public.orders`);
    assert.deepEqual(every.fields.map((f) => f.name), ["id", "status", "amount", "created_at", "customer_id", "gift", "notes"]);
    assert.equal(every.rows.length, ORDERS.length);
    const fks = await c.query("SELECT conname FROM pg_constraint WHERE contype = 'f'");
    assert.equal(fks.rows.length, 1);
    const comment = await c.query("SELECT col_description('public.orders'::regclass, 2) AS c");
    assert.equal(comment.rows[0]!.c, "paid, refunded…");
    await c.end();
  });

  test("a statement reading a table that is neither copied nor a catalog table is 42P01, with the way to add it", async () => {
    const c = await connect();
    const e = await refused(c.query("SELECT * FROM ordrs"));
    assert.equal(e.code, "42P01");
    assert.equal(e.message, 'relation "ordrs" does not exist');
    assert.match(e.hint ?? "", /mason add ordrs/);
    // a reserved word is Postgres's own syntax error, at Postgres's position
    const reserved = await refused(c.query("SELECT * FROM order"));
    assert.equal(reserved.code, "42601");
    assert.equal(reserved.position, "15");
    await c.end();
  });

  // docs/POSTGRES-API.md "What is refused, by name": a read-only copy refuses every write as Postgres's read-only
  // transaction does (25006), and the SQL forms of PREPARE / EXECUTE by name
  test("a write, DDL or a read-write transaction is 25006; PREPARE as SQL is 0A000", async () => {
    const c = await connect();
    for (const sql of ["INSERT INTO orders (id) VALUES (99)", "UPDATE orders SET status = 'x'", "DELETE FROM orders", "CREATE TABLE t (x int)",
      "TRUNCATE orders", "SET transaction_read_only = off"]) {
      assert.equal((await refused(c.query(sql))).code, "25006", sql);
    }
    const prepare = await refused(c.query("PREPARE p AS SELECT 1"));
    assert.equal(prepare.code, "0A000");
    assert.match(prepare.message, /protocol's prepared statements/);
    // the session goes on: nothing was written, and the rows are the copy's
    assert.equal((await c.query("SELECT count(*)::int AS n FROM orders")).rows[0]!.n, ORDERS.length);
    await c.end();
  });
});

describe("a catalog statement with a WITH", () => {
  // Metabase's sync lists what it may read with `with table_privileges as (… pg_tables … pg_views …) select … from
  // table_privileges` (0.64, recorded): the CTE's own name was taken for an unknown table (42P01), and the
  // sync stopped with no table listed
  test("a name the statement's WITH defines is its own relation: the catalog answers it", async () => {
    const c = await connect();
    const r = await c.query("WITH t AS (SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public') SELECT t.tablename FROM t ORDER BY 1");
    assert.deepEqual(r.rows.map((x) => x.tablename), ["customers", "orders"]);
    // a WITH over a copied table is a query of it: DuckDB's
    const m = await c.query("WITH paid AS (SELECT id FROM orders WHERE status = 'paid') SELECT id FROM paid WHERE id > 3");
    assert.deepEqual(m.rows, [{ id: "7" }]);
    await c.end();
  });
});

/** One session over a raw socket: its frames sent as a driver sends them, each reply read to its ReadyForQuery. */
async function rawSession(): Promise<{ send(b: Buffer): Promise<string[]>; exchange(b: Buffer): Promise<ReturnType<typeof wire.replies>>; raw(b: Buffer): Promise<Buffer>; upTo(b: Buffer, type: string): Promise<string[]>; end(): Promise<void> }> {
  const socket = net.connect(server.port, "127.0.0.1");
  let buffered = Buffer.alloc(0);
  let waiting: (() => void) | null = null;
  // a reset once the session sent Terminate is the server closing first; any other socket error fails the next send
  let ending = false;
  let failure: Error | null = null;
  socket.on("error", (e: Error) => { if (!ending) { failure = e; waiting?.(); } });
  socket.on("data", (d: Buffer) => { buffered = Buffer.concat([buffered, d]); waiting?.(); });
  const ready = (): boolean => buffered.length >= 6 && buffered[buffered.length - 6] === 0x5a && buffered.readInt32BE(buffered.length - 5) === 5;
  const until = async (done: () => boolean): Promise<void> => {
    while (!done()) {
      if (failure !== null) throw failure;
      await new Promise<void>((r) => { waiting = r; });
    }
  };
  const takeRaw = (): Buffer => { const b = buffered; buffered = Buffer.alloc(0); return b; };
  const take = (): string[] => wire.replies(takeRaw()).map((m) => m.type);
  await new Promise<void>((r) => socket.once("connect", () => r()));
  socket.write(wire.startup({ user: "raw", database: "shop" }));
  await until(() => buffered.length > 0);
  buffered = Buffer.alloc(0);
  socket.write(wire.password("good-token"));
  await until(ready);
  take();
  return {
    async send(b) { socket.write(b); await until(ready); return take(); },
    async exchange(b) { socket.write(b); await until(ready); const ms = wire.replies(buffered); buffered = Buffer.alloc(0); return ms; },
    async raw(b) { socket.write(b); await until(ready); return takeRaw(); },
    async upTo(b, type) { socket.write(b); const t = Buffer.from([type.charCodeAt(0), 0, 0, 0, 4]); await until(() => buffered.includes(t)); return take(); },
    async end() { ending = true; await new Promise<void>((r) => socket.end(wire.terminate(), () => r())); socket.destroy(); },
  };
}

describe("a catalog statement's portal, beside another session's", () => {
  // THE SIDECAR IS ONE POSTGRES CONNECTION EVERY SESSION SHARES, and a Sync ends its implicit transaction — which, in
  // Postgres, closes every portal open in it. A session between its Bind and its Execute lost its portal to another
  // session's Sync: "portal p7 does not exist", on every Metabase dashboard of six cards loaded at once (its pool's
  // connections each validate and read the catalog; Mason's live run)
  test("a portal bound and not yet executed survives another session's whole statement, Sync included", async () => {
    const [a, b] = [await rawSession(), await rawSession()];
    const types = (ms: ReturnType<typeof wire.replies>): string[] => ms.map((m) => m.type === "ErrorResponse" ? `ErrorResponse ${JSON.stringify(m)}` : m.type);
    const other = ["ParseComplete", "BindComplete", "RowDescription", "DataRow", "CommandComplete", "ReadyForQuery"];
    try {
      assert.deepEqual(await a.upTo(Buffer.concat([wire.parse("", "SELECT 2 AS two"), wire.bind("", "", [], [0]), wire.flush()]), "2"), ["ParseComplete", "BindComplete"]);
      assert.deepEqual(await b.send(wire.extended("SELECT 1 AS one", [], [0])), other);
      assert.deepEqual(types(await a.exchange(Buffer.concat([wire.describe("P", ""), wire.execute(""), wire.sync()]))), ["RowDescription", "DataRow", "CommandComplete", "ReadyForQuery"]);
      // a named portal read two rows at a time, another session's statement between its pages (pgjdbc's fetch size)
      const page = ["DataRow", "DataRow", "PortalSuspended"];
      assert.deepEqual(types(await a.exchange(Buffer.concat([wire.parse("", "SELECT g FROM generate_series(1, 5) g"), wire.bind("c1", "", [], [0]), wire.execute("c1", 2), wire.sync()]))),
        ["ParseComplete", "BindComplete", ...page, "ReadyForQuery"]);
      assert.deepEqual(await b.send(wire.extended("SELECT 1 AS one", [], [0])), other);
      assert.deepEqual(types(await a.exchange(Buffer.concat([wire.execute("c1", 2), wire.execute("c1", 2), wire.close("P", "c1"), wire.sync()]))),
        [...page, "DataRow", "CommandComplete", "CloseComplete", "ReadyForQuery"]);
    } finally { await a.end(); await b.end(); }
  });
});

describe("the extended protocol, frame by frame against Postgres", () => {
  // pgjdbc's getTransactionIsolation() is a SHOW over the extended protocol, run on every connection a pool hands out
  // (Metabase's c3p0): the Describe said NoData and the Execute sent a RowDescription with the row, so pgjdbc threw
  // "Received resultset tuples, but no field structure for them" and Metabase could not keep a connection
  let db: PGlite;
  before(async () => { db = new PGlite(); await db.waitReady; });
  after(async () => { await db.close(); });
  const postgres = async (b: Buffer): Promise<string[]> => wire.replies(await db.execProtocolRaw(b)).map((m) => m.type);

  for (const sql of ["SHOW TimeZone", "SHOW TRANSACTION ISOLATION LEVEL", "SHOW search_path"]) {
    test(`${sql}: Describe of the portal and of the statement, then Execute, as Postgres answers them`, async () => {
      const s = await rawSession();
      try {
        const portal = wire.extended(sql, [], [0]);
        assert.deepEqual(await s.send(portal), await postgres(portal));
        // the PGlite instance is one session for every case: a statement name of the case's own
        const name = `s_${sql.replaceAll(" ", "_")}`;
        const statement = Buffer.concat([wire.parse(name, sql), wire.describe("S", name), wire.bind("", name, [], [0]), wire.execute(""), wire.sync()]);
        assert.deepEqual(await s.send(statement), await postgres(statement));
      } finally {
        await s.end();
      }
    });
  }
});

describe("a parameter pgjdbc types as varchar", () => {
  // pgjdbc's setString binds OID 1043 (varchar), so every text filter a JDBC tool sends with a value — Metabase's
  // `WHERE "public"."orders"."status" = $1` — was refused 42804. Postgres reads varchar as text against
  // a text column, and refuses it against a bigint (no operator), as Mason does: Postgres analyses the statement
  test("a varchar parameter against a text column is bound as text; against a bigint it is refused", async () => {
    const s = await rawSession();
    try {
      const text = Buffer.concat([wire.parse("", "SELECT COUNT(*) AS n FROM orders WHERE status = $1", [1043]), wire.bind("", "", ["paid"], [0]), wire.describe("P", ""), wire.execute(""), wire.sync()]);
      const replies = await s.exchange(text);
      assert.deepEqual(replies.map((m) => m.type), ["ParseComplete", "BindComplete", "RowDescription", "DataRow", "CommandComplete", "ReadyForQuery"]);
      assert.deepEqual(replies.find((m) => m.type === "CommandComplete"), { type: "CommandComplete", tag: "SELECT 1" });
      const bigint = Buffer.concat([wire.parse("", "SELECT COUNT(*) AS n FROM orders WHERE id = $1", [1043]), wire.sync()]);
      assert.deepEqual(await s.send(bigint), ["ErrorResponse", "ReadyForQuery"]);
    } finally {
      await s.end();
    }
  });
});

describe("the empty query, as Postgres answers it", () => {
  // pgjdbc's Connection.isValid() sends an empty simple Query, and a pool reads anything but EmptyQueryResponse as a
  // dead connection: the parser's "Query cannot be empty" (42601) made isValid() false
  let db: PGlite;
  before(async () => { db = new PGlite(); await db.waitReady; });
  after(async () => { await db.close(); });
  test("an empty simple Query and an empty extended one are EmptyQueryResponse", async () => {
    const s = await rawSession();
    try {
      for (const frames of [wire.query(""), wire.extended("", [], [0])]) {
        const own = await s.send(frames);
        assert.deepEqual(own, wire.replies(await db.execProtocolRaw(frames)).map((m) => m.type));
        assert.ok(own.includes("EmptyQueryResponse"), own.join(", "));
      }
    } finally {
      await s.end();
    }
  });
});

describe("transactions", () => {
  test("BEGIN opens one, an error aborts it until ROLLBACK, COMMIT of an aborted one rolls back", async () => {
    const c = await connect();
    await c.query("BEGIN");
    await c.query("SELECT status FROM orders LIMIT 1");
    const e = await refused(c.query("SELECT nope FROM orders"));
    assert.equal(e.code, "42703");
    const aborted = await refused(c.query("SELECT 1"));
    assert.equal(aborted.code, "25P02");
    const commit = await c.query("COMMIT");
    assert.equal(commit.command, "ROLLBACK");
    const ok = await c.query("SELECT 1 AS one");
    assert.equal(ok.rows[0]!.one, 1);
    await c.query("BEGIN");
    await c.query("ROLLBACK");
    await c.end();
  });

  test("several statements in one simple query, catalog and session ones mixed; an empty query", async () => {
    const c = await connect();
    const r = await c.query("SET application_name = 'x'; SELECT 1 AS a; SHOW application_name");
    assert.equal((r as unknown as pg.QueryResult[])[2]!.rows[0]!.application_name, "x");
    const empty = await c.query(";");
    assert.equal(empty.rows.length, 0);
    await c.end();
  });
});

describe("two sessions", () => {
  test("unnamed prepared statements of two sessions never meet in the one catalog Postgres", async () => {
    const a = await connect(), b = await connect();
    const [ra, rb] = await Promise.all([
      a.query({ text: "SELECT $1::int AS n", values: [1] }),
      b.query({ text: "SELECT $1::text AS t", values: ["two"] }),
    ]);
    assert.equal(ra.rows[0]!.n, 1);
    assert.equal(rb.rows[0]!.t, "two");
    await a.end();
    await b.end();
  });

  test("a catalog statement one session gets refused leaves the catalog answering the next (the server Syncs it)", async () => {
    // Postgres ignores every extended-protocol message after an error until a Sync; the sidecar is shared, so without
    // the server's own Sync one refused Parse silenced it for every session (review of #480)
    const a = await connect(), b = await connect();
    const e = await refused(a.query({ text: "SELECT nope FROM pg_class", values: [] }));
    assert.equal(e.code, "42703");
    assert.equal((await b.query({ text: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'orders'", values: [] })).rows[0]!.n, 1);
    assert.equal((await a.query({ text: "SELECT relname FROM pg_class WHERE relname = 'customers'", values: [] })).rows[0]!.relname, "customers");
    await a.end();
    await b.end();
  });

  test("a SET the catalog validates is the session's alone", async () => {
    const a = await connect(), b = await connect();
    await a.query("SET work_mem = '64MB'");
    assert.equal((await a.query("SHOW work_mem")).rows[0]!.work_mem, "64MB");
    assert.equal((await b.query("SHOW work_mem")).rows[0]!.work_mem, "4MB");
    assert.equal((await refused(a.query("SET work_mem = 'lots'"))).code, "22023");
    assert.equal((await b.query("SELECT 1 AS one")).rows[0]!.one, 1);   // the failed validation left no open transaction
    await a.end();
    await b.end();
  });
});

describe("a refused or failed statement is a line of the log, trace or not (a BI tool's error left none)", () => {
  /** a listener of its own, its log kept: `fail` makes DuckDB's run throw as an internal error would */
  async function listening(trace: boolean): Promise<{ server: PgApiServer; lines: string[]; fail: { on: boolean } }> {
    const lines: string[] = [];
    const fail = { on: false };
    const duck: DuckOptions = {
      ...listener,
      open: async () => {
        const r = await listener.open();
        return {
          run: (...a: Parameters<DuckRunner["run"]>) => fail.on ? Promise.reject(new Error("the stubbed DuckDB broke")) : r.run(...a),
          explain: (...a: Parameters<DuckRunner["explain"]>) => r.explain(...a),
          close: () => r.close(),
        };
      },
    };
    const s = await startPostgresApi({
      port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
      authenticate: (p) => tokenFor(p), schema: () => SCHEMA,
      record: () => undefined, log: (l) => lines.push(l), trace, duck,
    });
    return { server: s, lines, fail };
  }
  const on = async (s: PgApiServer): Promise<pg.Client> => {
    const c = new pg.Client({ host: "127.0.0.1", port: s.port, user: "anyone", password: "good-token", database: "shop" });
    await c.connect();
    return c;
  };
  const refusals = (lines: string[]): string[] => lines.filter((l) => / (refused|failed): /.test(l) && !/^\[postgres\] trace /.test(l));

  test("without the trace: exactly one line per refusal, its SQLSTATE, message, hint and statement, on either protocol", async () => {
    const { server: s, lines, fail } = await listening(false);
    const c = await on(s);
    try {
      const pid = (c as unknown as { processID: number }).processID;
      const e = await refused(c.query("SELECT  nope\n FROM orders"));
      assert.equal(e.code, "42703");
      const simple = refusals(lines);
      assert.equal(simple.length, 1, simple.join("\n"));
      assert.equal(simple[0], `[postgres] session ${pid} refused: 42703 ${e.message}${e.detail ? `; detail: ${e.detail}` : ""}${e.hint ? `; hint: ${e.hint}` : ""} — SELECT nope FROM orders`);
      // the extended protocol (a Parse): its own one line
      await refused(c.query("SELECT nope FROM orders WHERE id = $1", [1]));
      assert.equal(refusals(lines).length, 2);
      assert.match(refusals(lines)[1]!, / refused: 42703 .* — SELECT nope FROM orders WHERE id = \$1$/);
      // a syntax error, refused before any statement is cut from the text
      await refused(c.query("SELEC 1"));
      assert.match(refusals(lines)[2]!, / refused: 42601 syntax error at or near "SELEC" — SELEC 1$/);
      // Mason's own failure is `failed`, with its code
      fail.on = true;
      const x = await refused(c.query("SELECT status FROM orders"));
      assert.equal(x.code, "XX000");
      assert.match(refusals(lines)[3]!, new RegExp(`session ${pid} failed: XX000 the stubbed DuckDB broke — SELECT status FROM orders$`));
      assert.equal(refusals(lines).length, 4);
      assert.deepEqual(lines.filter((l) => l.includes(" trace ")), [], "no trace line without the trace");
    } finally { await c.end(); await s.close(); }
  });

  test("with the trace: the same one line, and the trace's own beside it", async () => {
    const { server: s, lines } = await listening(true);
    const c = await on(s);
    try {
      await refused(c.query("SELECT nope FROM orders"));
      assert.equal(refusals(lines).length, 1);
      assert.equal(lines.filter((l) => /^\[postgres\] trace \d+ refused: 42703 /.test(l)).length, 1, lines.join("\n"));
    } finally { await c.end(); await s.close(); }
  });

  test("no statement's ErrorResponse is sent but through Session.refuse, which logs it (a FATAL is said by the close)", () => {
    const source = fs.readFileSync(new URL("../../src/api/postgres/server.ts", import.meta.url), "utf8");
    const sends = source.split("\n").filter((l) => /errorResponse\(/.test(l) && !/severity: "FATAL"/.test(l));
    // refuse() builds the frame first: its bytes are counted in the statement's row of the request log, then it is sent
    assert.deepEqual(sends.map((l) => l.trim()), ["const response = errorResponse(e.fields);"], "the one non-FATAL sender is refuse()");
  });
});

describe("session state (GitHub issue 253): the session's settings reach every path that answers", () => {
  const one = async (c: pg.Client, sql: string): Promise<unknown[]> => (await c.query({ text: sql, rowMode: "array" }) as unknown as { rows: unknown[][] }).rows[0]!;
  const text = async (c: pg.Client, sql: string): Promise<string[]> => (await one(c, sql)).map((v) => v instanceof Date ? v.toISOString() : String(v));

  test("session state: TimeZone and SET LOCAL TimeZone reach a statement the catalog answers, and the one beside a copied table", async () => {
    const c = await connect();
    try {
      await c.query("SET TimeZone = 'Asia/Tokyo'");
      assert.deepEqual(await text(c, "SELECT '2026-01-02 03:04:05+00'::timestamptz::text, to_char('2026-01-02 03:04:05+00'::timestamptz, 'HH24:MI TZ')"), ["2026-01-02 12:04:05+09", "12:04 JST"]);
      await c.query("SET TimeZone = 'America/New_York'");
      assert.deepEqual(await text(c, "SELECT '12:30'::time::timetz::text, extract(timezone_hour FROM current_time(0))::text IN ('-5', '-4')"), ["12:30:00-05", "true"]);
      await c.query("RESET TimeZone");
      await c.query("BEGIN");
      await c.query("SET LOCAL TimeZone = 'Asia/Tokyo'");
      assert.deepEqual(await text(c, "SELECT '2026-01-02 03:04:05+00'::timestamptz::text"), ["2026-01-02 12:04:05+09"]);
      assert.deepEqual(await text(c, "SELECT '2026-01-02 03:04:05+00'::timestamptz::text FROM orders LIMIT 1"), ["2026-01-02 12:04:05+09"]);
      await c.query("COMMIT");
      assert.deepEqual(await text(c, "SELECT '2026-01-02 03:04:05+00'::timestamptz::text"), ["2026-01-02 03:04:05+00"]);
    } finally { await c.end(); }
  });

  test("session state: search_path reaches the catalog as Postgres's, pg_catalog first; the overrides answer with public off the path", async () => {
    const c = await connect();
    try {
      assert.deepEqual(await text(c, "SELECT current_schemas(false)::text, current_schemas(true)::text, current_schema()"), ["{public}", "{pg_catalog,public}", "public"]);
      await c.query("SET search_path = pg_catalog, public");
      assert.deepEqual(await text(c, "SELECT current_schemas(false)::text"), ["{pg_catalog,public}"]);
      await c.query("SET search_path = nowhere");
      await c.query("SET application_name = 'probe'");
      const e = await refused(c.query("SELECT 'orders'::regclass"));
      assert.deepEqual([e.code, e.message], ["42P01", 'relation "orders" does not exist']);
      assert.deepEqual(await text(c, "SELECT current_setting('search_path'), pg_catalog.current_setting('TimeZone'), current_setting('application_name'), version() LIKE 'PostgreSQL 18%'"),
        ["nowhere", "UTC", "probe", "true"]);
      assert.deepEqual(await text(c, "SELECT count(*) FROM pg_class WHERE relname = 'orders' AND pg_table_is_visible(oid)"), ["0"]);
      await c.query("RESET search_path");
      assert.deepEqual(await text(c, "SELECT count(*) FROM pg_class WHERE relname = 'orders' AND pg_table_is_visible(oid)"), ["1"]);
      // a catalog statement prepared under one path, run under another: Postgres plans it again
      const q = { name: "vis", text: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'orders' AND pg_table_is_visible(oid)" };
      assert.equal((await c.query(q)).rows[0].n, 1);
      await c.query("SET search_path = nowhere");
      assert.equal((await c.query(q)).rows[0].n, 0);
    } finally { await c.end(); }
  });

  test("session state: DateStyle's order is held and applied on both paths; a non-ISO style stays refused", async () => {
    const c = await connect();
    try {
      await c.query("SET DateStyle = 'ISO, DMY'");
      assert.deepEqual(await text(c, "SHOW DateStyle"), ["ISO, DMY"]);
      assert.deepEqual(await text(c, "SELECT '01/02/2026'::date::text"), ["2026-02-01"]);
      assert.deepEqual(await text(c, "SELECT '01/02/2026'::date::text AS d FROM orders LIMIT 1"), ["2026-02-01"]);
      assert.deepEqual((await c.query({ text: "SELECT $1::date::text AS d FROM orders LIMIT 1", values: ["01/02/2026"] })).rows[0].d, "2026-02-01");
      await c.query("SET DateStyle = 'ISO, YMD'");
      assert.deepEqual(await text(c, "SHOW DateStyle"), ["ISO, YMD"]);
      await c.query("RESET DateStyle");
      assert.deepEqual(await text(c, "SHOW DateStyle"), ["ISO, MDY"]);
      await c.query("BEGIN");
      await c.query("SET LOCAL DateStyle = 'ISO, DMY'");
      assert.deepEqual(await text(c, "SELECT '01/02/2026'::date::text"), ["2026-02-01"]);
      await c.query("ROLLBACK");
      assert.deepEqual(await text(c, "SELECT '01/02/2026'::date::text"), ["2026-01-02"]);
      assert.equal((await refused(c.query("SET DateStyle = 'German'"))).code, "0A000");
      assert.equal((await refused(c.query("SET DateStyle = 'nonsense'"))).code, "22023");
    } finally { await c.end(); }
  });

  test("session state: IntervalStyle other than postgres is refused by name; an invalid one is Postgres's 22023", async () => {
    const c = await connect();
    try {
      await c.query("SET IntervalStyle = 'postgres'");
      assert.deepEqual(await text(c, "SHOW IntervalStyle"), ["postgres"]);
      const e = await refused(c.query("SET IntervalStyle = 'iso_8601'"));
      assert.equal(e.code, "0A000");
      assert.match(e.detail ?? "", /interval-style/);
      const bad = await refused(c.query("SET IntervalStyle = 'nonsense'"));
      assert.deepEqual([bad.code, bad.message, bad.hint], ["22023", 'invalid value for parameter "IntervalStyle": "nonsense"', "Available values: postgres, postgres_verbose, sql_standard, iso_8601."]);
      await c.query("BEGIN");
      assert.equal((await refused(c.query("SET LOCAL IntervalStyle = 'sql_standard'"))).code, "0A000");
      assert.equal((await refused(c.query("SELECT 1"))).code, "25P02");
      await c.query("ROLLBACK");
    } finally { await c.end(); }
  });

  test("session state: extra_float_digits and the isolation levels are remembered, read back by SHOW and current_setting on both paths", async () => {
    const c = await connect({ options: "-c extra_float_digits=2" });
    try {
      assert.deepEqual(await text(c, "SHOW extra_float_digits"), ["2"]);
      await c.query("SET extra_float_digits = 3");
      assert.deepEqual(await text(c, "SHOW extra_float_digits"), ["3"]);
      assert.deepEqual(await text(c, "SELECT current_setting('extra_float_digits') FROM orders LIMIT 1"), ["3"]);
      await c.query("BEGIN");
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      assert.deepEqual(await text(c, "SHOW transaction_isolation"), ["repeatable read"]);
      assert.deepEqual(await text(c, "SELECT current_setting('transaction_isolation') FROM orders LIMIT 1"), ["repeatable read"]);
      await c.query("COMMIT");
      assert.deepEqual(await text(c, "SHOW transaction_isolation"), ["read committed"]);
      await c.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      assert.deepEqual(await text(c, "SHOW default_transaction_isolation"), ["serializable"]);
      await c.query("BEGIN");
      assert.deepEqual(await text(c, "SHOW transaction_isolation"), ["serializable"]);
      await c.query("COMMIT");
    } finally { await c.end(); }
  });

  test("session state: the clock functions of a catalog statement are the transaction's instant, named and typed as Postgres's; clock_timestamp stays the real clock", async () => {
    const c = await connect();
    try {
      const r = await c.query("SELECT now(), CURRENT_DATE, LOCALTIME(0), CURRENT_TIMESTAMP(0), transaction_timestamp(), clock_timestamp() >= now() AS later");
      assert.deepEqual(r.fields.map((f) => [f.name, f.dataTypeID]), [["now", 1184], ["current_date", 1082], ["localtime", 1083], ["current_timestamp", 1184], ["transaction_timestamp", 1184], ["later", 16]]);
      assert.equal(r.rows[0].later, true);
      await c.query("BEGIN");
      const [a] = await one(c, "SELECT now()") as [Date];
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [b] = await one(c, "SELECT now() FROM orders LIMIT 1") as [Date];
      const [d] = await one(c, "SELECT transaction_timestamp()") as [Date];
      await c.query("COMMIT");
      assert.equal(b.getTime(), a.getTime(), "one instant on both paths in a block");
      assert.equal(d.getTime(), a.getTime());
      // a string that says now() is no call
      assert.deepEqual(await text(c, "SELECT 'now()' AS t"), ["now()"]);
    } finally { await c.end(); }
  });

  test("session state: a clock keyword's precision is the one written, 0 included, on the catalog path (review r1 of PR 333)", async () => {
    const c = await connect();
    try {
      // libpg-query's JSON leaves out a typmod of 0: the precision is read from the text, never from the field's presence
      assert.deepEqual(await text(c, "SELECT length(current_time(0)::text), length(current_timestamp(0)::text), length(localtime(0)::text), length(localtimestamp(0)::text)"), ["11", "22", "8", "19"]);
      assert.deepEqual(await text(c, "SELECT current_time(0)::text ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}[+-]', localtimestamp(1)::text ~ '[.][0-9]$|:[0-9]{2}$', CURRENT_TIMESTAMP ( 0 )::text ~ ':[0-9]{2}[+-]'"), ["true", "true", "true"]);
    } finally { await c.end(); }
  });

  test("session state: a relative word cast to a date or time type is the transaction's instant, as now() is, on the catalog path (CI's oracle at 76730cb)", async () => {
    const c = await connect();
    try {
      await c.query("SET TimeZone = 'Asia/Tokyo'");
      assert.deepEqual(await text(c, "SELECT 'now'::timestamptz = now(), 'today'::date = current_date, 'tomorrow'::date - 'yesterday'::date, 'today'::timestamptz = date_trunc('day', now()), timestamp 'today' = current_date::timestamp, date 'tomorrow' = current_date + 1, 'now'::timestamp = localtimestamp"),
        ["true", "true", "2", "true", "true", "true", "true"]);
      // a time reads 'now' alone: 'today'::time is Postgres's own 22007
      assert.equal((await refused(c.query("SELECT 'today'::time"))).code, "22007");
      assert.deepEqual(await text(c, "SELECT 'now'::time = localtime, 'now'::timetz = current_time"), ["true", "true"]);
      // every spelling the parser reads as the word, and every way it reaches the type, from Postgres's analysis
      // (review r2 of PR 333): E'', $$ $$, U&'', a chain of casts through text, varchar or unknown, the comparison's coercion
      assert.deepEqual(await text(c, "SELECT E'now'::timestamptz = now(), E'today'::date = current_date, $$now$$::timestamptz = now(), U&'now'::timestamptz = now(), U&'n!006Fw' UESCAPE '!'::timestamptz = now()"),
        ["true", "true", "true", "true", "true"]);
      assert.deepEqual(await text(c, "SELECT 'now'::text::timestamptz = now(), 'now'::varchar::timestamptz = now(), 'now'::unknown::timestamptz = now(), now() = 'now', 'now' = now(), 'é' || 'x' = 'éx' AND E'now'::timestamptz = now()"),
        ["true", "true", "true", "true", "true", "true"]);
      assert.equal((await refused(c.query("SELECT 'today'::text::time"))).code, "22007");
      // prepared, with a parameter beside it
      assert.equal((await c.query({ text: "SELECT $1::int AS n, now() = 'now' AS same", values: ["1"] })).rows[0].same, true);
      // a word that is no cast to a time is text, as written
      assert.deepEqual(await text(c, "SELECT 'now', 'today'::text"), ["now", "today"]);
    } finally { await c.end(); }
  });

  test("session state: DateStyle's validity is Postgres's: two orders or two styles are its 22023, a non-ISO style Mason's 0A000 (review r1 of PR 333)", async () => {
    const c = await connect();
    try {
      for (const v of ["YMD, DMY", "ISO, SQL", "ISO, nonsense"]) {
        const e = await refused(c.query(`SET DateStyle = '${v}'`));
        assert.deepEqual([e.code, e.message], ["22023", `invalid value for parameter "DateStyle": "${v}"`], v);
      }
      assert.match((await refused(c.query("SET DateStyle = 'YMD, DMY'"))).detail ?? "", /Conflicting "DateStyle" specifications/i);
      assert.deepEqual(await text(c, "SHOW DateStyle"), ["ISO, MDY"], "nothing was remembered");
      assert.equal((await refused(c.query("SET DateStyle = 'SQL, DMY'"))).code, "0A000");
      await c.query("SET DateStyle = 'ISO, YMD'");
      await c.query("SET DateStyle = 'ISO'");
      assert.deepEqual(await text(c, "SHOW DateStyle"), ["ISO, YMD"], "a part not named is kept, as check_datestyle keeps it");
      await c.query("SELECT set_config('DateStyle', 'dmy', false)");
      assert.deepEqual(await text(c, "SHOW DateStyle"), ["ISO, DMY"]);
    } finally { await c.end(); }
    // a startup packet's: read by the catalog after the password, its refusal the startup's
    const d = await connect({ options: "-c DateStyle=ISO,DMY" });
    try { assert.deepEqual(await text(d, "SHOW DateStyle"), ["ISO, DMY"]); } finally { await d.end(); }
    await assert.rejects(connect({ options: "-c DateStyle=YMD,DMY" }), (e: { code?: string }) => e.code === "22023");
  });

  test("session state: every parameter setParameter names is honoured, read back, or refused by name; RESET ALL restores each", async () => {
    // [name, a valid value other than the default, what SHOW then answers (null: the SET is refused, with this SQLSTATE;
    // a spelling of another parameter, whose verdict is that one's: its SHOW name)]
    const CASES: ReadonlyArray<{ name: string; value: string; shows: string | null; code?: string; spelling?: string }> = [
      { name: "timezone", value: "Asia/Tokyo", shows: "Asia/Tokyo" }, { name: "time zone", value: "Asia/Tokyo", shows: "Asia/Tokyo", spelling: "timezone" },
      { name: "application_name", value: "probe", shows: "probe" }, { name: "search_path", value: "other, public", shows: "other, public" },
      { name: "client_encoding", value: "UTF8", shows: "UTF8" }, { name: "names", value: "UTF8", shows: "UTF8", spelling: "client_encoding" },
      { name: "datestyle", value: "ISO, DMY", shows: "ISO, DMY" }, { name: "extra_float_digits", value: "3", shows: "3" },
      { name: "standard_conforming_strings", value: "on", shows: "on" }, { name: "intervalstyle", value: "sql_standard", shows: null, code: "0A000" },
      { name: "transaction_isolation", value: "repeatable read", shows: "read committed" /* the transaction's alone: outside a block it ends with the SET */ }, { name: "default_transaction_isolation", value: "serializable", shows: "serializable" },
      { name: "transaction", value: "", shows: null, spelling: "transaction_isolation" }, { name: "session characteristics", value: "", shows: null, spelling: "default_transaction_isolation" },
      { name: "default_transaction_read_only", value: "on", shows: "on" }, { name: "transaction_read_only", value: "on", shows: "on" },
      { name: "statement_timeout", value: "5s", shows: "5s" }, { name: "lock_timeout", value: "5s", shows: "5s" },
      { name: "idle_in_transaction_session_timeout", value: "5s", shows: "5s" }, { name: "idle_session_timeout", value: "5s", shows: "5s" },
      { name: "transaction_timeout", value: "5s", shows: "5s" }, { name: "client_min_messages", value: "warning", shows: "warning" },
      { name: "log_min_messages", value: "error", shows: "error" }, { name: "bytea_output", value: "escape", shows: "escape" },
      { name: "default_transaction_deferrable", value: "on", shows: "on" }, { name: "xmloption", value: "document", shows: "document" },
      { name: "backslash_quote", value: "on", shows: "on" }, { name: "escape_string_warning", value: "off", shows: "off" },
      { name: "synchronize_seqscans", value: "off", shows: "off" }, { name: "work_mem", value: "8MB", shows: "8MB" },
      { name: "max_parallel_workers_per_gather", value: "0", shows: "0" }, { name: "jit", value: "off", shows: "off" }, { name: "row_security", value: "off", shows: "off" },
      { name: "lc_messages", value: "C", shows: "C" }, { name: "lc_monetary", value: "C", shows: "C" }, { name: "lc_numeric", value: "C", shows: "C" },
      { name: "lc_time", value: "C", shows: "C" }, { name: "check_function_bodies", value: "off", shows: "off" },
    ];
    // every case setParameter names, read from its source: a new case cannot skip this test
    const source = fs.readFileSync(new URL("../../src/api/postgres/server.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("  private setParameter("), source.indexOf("  private async resetParameter("));
    const named = [...new Set([...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!))];
    assert.deepEqual(named.sort(), CASES.map((x) => x.name).sort(), "every parameter setParameter names has its verdict here");
    const c = await connect();
    try {
      for (const { name, value, shows, code, spelling } of CASES) {
        if (spelling !== undefined) continue; // the parameter it spells is held under its own name
        const before = (await text(c, `SHOW ${name}`))[0];
        if (shows === null) {
          assert.equal((await refused(c.query(`SET ${name} = '${value}'`))).code, code, name);
          continue;
        }
        await c.query(`SET ${name} = '${value}'`);
        assert.deepEqual(await text(c, `SHOW ${name}`), [shows], name);
        assert.deepEqual(await text(c, `SELECT current_setting('${name}')`), [shows], `${name}: current_setting on the catalog`);
        assert.deepEqual(await text(c, `SELECT current_setting('${name}') FROM orders LIMIT 1`), [shows], `${name}: current_setting beside a copied table`);
        await c.query("RESET ALL");
        assert.deepEqual(await text(c, `SHOW ${name}`), [before], `${name}: RESET ALL`);
      }
    } finally { await c.end(); }
  });
});

test("session state: the splice of a catalog statement reaches every call of an override and every clock function, read from the parse tree", async () => {
  const { userSplicedForTest } = await import("../../src/api/postgres/server.ts");
  const { parse } = await import("libpg-query");
  const splice = async (sql: string): Promise<string> => userSplicedForTest(sql, (await parse(sql)).stmts![0]!.stmt, 0, "agent", new Set(["SVFOP_SESSION_USER"]));
  assert.equal(await splice("SELECT version(), pg_catalog.version(), \"pg_catalog\" . \"version\" ( )"), "SELECT public.version(), public.version(), public.version ( )");
  assert.equal(await splice("SELECT current_setting('a'), pg_catalog.current_setting('b', true), CURRENT_SETTING('c')"),
    "SELECT public.current_setting('a'), public.current_setting('b', true), public.current_setting('c')");
  assert.equal(await splice("SELECT format_type(23, NULL), pg_catalog.format_type(23, NULL)"), "SELECT public.format_type(23, NULL), pg_catalog.format_type(23, NULL)");
  const spliced = await splice("SELECT now(), CURRENT_DATE, current_timestamp(3), LOCALTIME, transaction_timestamp(), clock_timestamp(), 'now()', x.now FROM (SELECT 1 AS now) x");
  assert.match(spliced, /^SELECT \(SELECT pg_catalog\.current_setting\('mason_[0-9a-f]{16}\.now'\)::timestamptz AS now\), \(SELECT .*::date AS current_date\), \(SELECT .*::timestamptz\(3\) AS current_timestamp\), \(SELECT .*::time AS localtime\), \(SELECT .*::timestamptz AS transaction_timestamp\), clock_timestamp\(\), 'now\(\)', x\.now FROM \(SELECT 1 AS now\) x$/);
  // a schema of the user's own: never an override
  assert.equal(await splice("SELECT myapp.version(), myapp.now()"), "SELECT myapp.version(), myapp.now()");
});
