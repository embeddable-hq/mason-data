/**
 * The catalog sidecar (src/api/postgres/catalog.ts): a hand-built PgSchema becomes Postgres DDL, pinned here so a
 * change to what a BI tool sees is read in a diff, and a real PGlite answers the introspection a tool sends — raw
 * protocol bytes in, Postgres's own bytes out. The protocol builders and the backend-message parser below are the
 * test's own, minimal on purpose: they decode only what these assertions read.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { catalogDdl, catalogDefaults, databaseNameSql, PgCatalog } from "../../src/api/postgres/catalog.ts";
import * as catalogModule from "../../src/api/postgres/catalog.ts";
import type { PgSchema, PgTable } from "../../src/api/postgres/schema.ts";
import { SHOP_SCHEMA } from "./corpus/shop.ts";

// --- the schema under test --------------------------------------------------------------------------------------

const orders: PgTable = {
  name: "orders",
  description: "one row per order",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "int8" },
    { name: "tenant_id", type: "text", description: "the token's tenant" },
    { name: "customer_id", type: "int8", description: "the customer" },
    { name: "referrer_id", type: "int8" },
    { name: "region_code", type: "text" },
    { name: "amount", type: "float8" },
    { name: "created_at", type: "timestamptz" },
    { name: "paid", type: "bool" },
  ],
  joins: [
    { name: "customers", table: "customers", on: ["customer_id", "id"], relationship: "many_to_one" },
    { name: "referrer", table: "customers", on: ["referrer_id", "id"], relationship: "many_to_one" },
    { name: "regions", table: "regions", on: ["region_code", "code"], relationship: "many_to_one" },
  ],
};

const customers: PgTable = {
  name: "customers",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "int8" },
    { name: "name", type: "text" },
  ],
  joins: [{ name: "orders", table: "orders", on: ["id", "customer_id"], relationship: "one_to_many" }],
};

const regions: PgTable = {
  name: "regions",
  description: "where it's shipped",
  primaryKey: ["code"],
  columns: [
    { name: "code", type: "text" },
    { name: "name", type: "text", description: "the region's name" },
  ],
  joins: [],
};

const schema: PgSchema = { database: "shop", tables: [orders, customers, regions] };

// --- the protocol, minimally ------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const cstring = (s: string): Uint8Array => concat(enc.encode(s), new Uint8Array(1));
const int16 = (n: number): Uint8Array => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n);
  return b;
};
const int32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
};
/** a frontend message: type byte, int32 length (self-inclusive, type excluded), body */
const message = (type: string, body: Uint8Array): Uint8Array => concat(enc.encode(type), int32(4 + body.length), body);
const simpleQuery = (sql: string): Uint8Array => message("Q", cstring(sql));

interface BackendMessage {
  type: string;
  /** a DataRow's values (null for a NULL); absent on every other message */
  row?: (string | null)[];
  /** an ErrorResponse's fields by their one-letter code */
  error?: Record<string, string>;
}
function decode(reply: Uint8Array): BackendMessage[] {
  const out: BackendMessage[] = [];
  const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  let o = 0;
  while (o < reply.length) {
    const type = String.fromCharCode(reply[o]!);
    const len = dv.getInt32(o + 1);
    const body = reply.subarray(o + 5, o + 1 + len);
    const msg: BackendMessage = { type };
    if (type === "D") {
      const n = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt16(0);
      const row: (string | null)[] = [];
      let p = 2;
      for (let i = 0; i < n; i++) {
        const l = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(p);
        p += 4;
        if (l < 0) row.push(null);
        else {
          row.push(dec.decode(body.subarray(p, p + l)));
          p += l;
        }
      }
      msg.row = row;
    } else if (type === "E") {
      const error: Record<string, string> = {};
      for (const field of dec.decode(body).split("\0")) if (field) error[field[0]!] = field.slice(1);
      msg.error = error;
    }
    out.push(msg);
    o += 1 + len;
  }
  return out;
}
const rowsOf = (reply: Uint8Array): (string | null)[][] => decode(reply).filter((m) => m.type === "D").map((m) => m.row!);
const types = (reply: Uint8Array): string => decode(reply).map((m) => m.type).join("");

// --- the DDL, pinned --------------------------------------------------------------------------------------------

test("catalogDdl: tables, primary keys, comments, then the foreign keys", () => {
  assert.deepEqual(catalogDdl(schema), [
    `CREATE TABLE public."orders" (
  "id" bigint,
  "tenant_id" text,
  "customer_id" bigint,
  "referrer_id" bigint,
  "region_code" text,
  "amount" double precision,
  "created_at" timestamp with time zone,
  "paid" boolean,
  PRIMARY KEY ("id")
);`,
    `COMMENT ON TABLE public."orders" IS 'one row per order';`,
    `COMMENT ON COLUMN public."orders"."tenant_id" IS 'the token''s tenant';`,
    `COMMENT ON COLUMN public."orders"."customer_id" IS 'the customer';`,
    `CREATE TABLE public."customers" (
  "id" bigint,
  "name" text,
  PRIMARY KEY ("id")
);`,
    `COMMENT ON COLUMN public."customers"."id" IS 'joins orders on customer_id (one_to_many)';`,
    `CREATE TABLE public."regions" (
  "code" text,
  "name" text,
  PRIMARY KEY ("code")
);`,
    `COMMENT ON TABLE public."regions" IS 'where it''s shipped';`,
    `COMMENT ON COLUMN public."regions"."name" IS 'the region''s name';`,
    `ALTER TABLE public."orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES public."customers" ("id");`,
    `ALTER TABLE public."orders" ADD CONSTRAINT "orders_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES public."customers" ("id");`,
    `ALTER TABLE public."orders" ADD CONSTRAINT "orders_region_code_fkey" FOREIGN KEY ("region_code") REFERENCES public."regions" ("code");`,
  ]);
});

test("catalogDdl: a join that cannot be a foreign key is a comment, never a refused constraint", () => {
  // a target column that is not the target's whole primary key; a target outside the schema; a column the table
  // does not list (one with no Postgres type), whose note has no column to live on and goes on the table
  const t: PgTable = {
    ...customers,
    description: "people",
    joins: [
      { name: "by_name", table: "regions", on: ["name", "name"], relationship: "many_to_one" },
      { name: "hidden", table: "secrets", on: ["id", "id"], relationship: "one_to_one" },
      { name: "untyped", table: "regions", on: ["region_arr", "code"], relationship: "many_to_one" },
    ],
  };
  const ddl = catalogDdl({ database: "x", tables: [t, regions] });
  assert.ok(!ddl.some((s) => s.startsWith("ALTER TABLE")), ddl.join("\n"));
  assert.ok(ddl.includes(`COMMENT ON TABLE public."customers" IS 'people; region_arr joins regions on code (many_to_one)';`), ddl.join("\n"));
  assert.ok(ddl.includes(`COMMENT ON COLUMN public."customers"."name" IS 'joins regions on name (many_to_one)';`), ddl.join("\n"));
  assert.ok(ddl.includes(`COMMENT ON COLUMN public."customers"."id" IS 'joins secrets on id (one_to_one)';`), ddl.join("\n"));
});

test("catalogDdl: identifiers are double-quoted with an inner quote doubled; no primary key for a view", () => {
  const t: PgTable = { name: `we"ird`, primaryKey: [], columns: [{ name: `a"b`, type: "uuid" }], joins: [] };
  assert.deepEqual(catalogDdl({ database: "x", tables: [t] }), [`CREATE TABLE public."we""ird" (\n  "a""b" uuid\n);`]);
});

// --- the instance -----------------------------------------------------------------------------------------------

const logged: string[] = [];
const catalog = new PgCatalog(schema, { log: (line) => logged.push(line) });
after(() => catalog.stop());

test("a raw simple Query over pg_class / pg_attribute / format_type names every column", async () => {
  assert.equal(catalog.started, false);
  const reply = await catalog.run(
    simpleQuery(
      `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname, a.attnum`,
    ),
  );
  assert.equal(catalog.started, true);
  assert.equal(types(reply).replace(/D+/, "D"), "TDCZ"); // RowDescription, DataRows, CommandComplete, ReadyForQuery
  const expected = [...schema.tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((t) => t.columns.map((c) => [t.name, c.name, spelling[c.type]]));
  assert.deepEqual(rowsOf(reply), expected);
  assert.match(logged[0] ?? "", /^catalog: PGlite started in \d+ ms with 3 table\(s\)$/);
});

const spelling = {
  int8: "bigint", text: "text", float8: "double precision", timestamptz: "timestamp with time zone", bool: "boolean", uuid: "uuid",
} as Record<string, string>;

test("pg_constraint lists exactly the declared foreign keys; obj_description / col_description return the comments", async () => {
  const { rows } = await catalog.query(
    `SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname`,
  );
  assert.deepEqual(rows, [
    { conname: "orders_customer_id_fkey", tbl: "orders", def: 'FOREIGN KEY (customer_id) REFERENCES customers(id)' },
    { conname: "orders_referrer_id_fkey", tbl: "orders", def: 'FOREIGN KEY (referrer_id) REFERENCES customers(id)' },
    { conname: "orders_region_code_fkey", tbl: "orders", def: 'FOREIGN KEY (region_code) REFERENCES regions(code)' },
  ]);
  const pks = await catalog.query(`SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'p' AND connamespace = 'public'::regnamespace ORDER BY 1`);
  assert.deepEqual(pks.rows, [
    { tbl: "customers", def: "PRIMARY KEY (id)" },
    { tbl: "orders", def: "PRIMARY KEY (id)" },
    { tbl: "regions", def: "PRIMARY KEY (code)" },
  ]);
  const comments = await catalog.query(
    `SELECT obj_description('public.orders'::regclass, 'pg_class') AS t,
            col_description('public.orders'::regclass, 2) AS tenant,
            col_description('public.customers'::regclass, 1) AS cust_id,
            obj_description('public.regions'::regclass, 'pg_class') AS regions`,
  );
  assert.deepEqual(comments.rows, [
    {
      t: "one row per order",
      tenant: "the token's tenant",
      cust_id: "joins orders on customer_id (one_to_many)",
      regions: "where it's shipped",
    },
  ]);
});

test("the instance's TimeZone is UTC", async () => {
  const reply = await catalog.run(simpleQuery("SELECT current_setting('TimeZone')"));
  assert.deepEqual(rowsOf(reply), [["UTC"]]);
});

test("an extended-protocol buffer — Parse, Bind, Describe, Execute, Sync in one run — answers", async () => {
  const parse = message("P", concat(cstring(""), cstring("SELECT $1::int + 1 AS v"), int16(0)));
  const bind = message("B", concat(cstring(""), cstring(""), int16(0), int16(1), int32(1), enc.encode("1"), int16(0)));
  const describe = message("D", concat(enc.encode("P"), cstring("")));
  const execute = message("E", concat(cstring(""), int32(0)));
  const sync = message("S", new Uint8Array(0));
  const reply = await catalog.run(concat(parse, bind, describe, execute, sync));
  // ParseComplete, BindComplete, RowDescription, DataRow, CommandComplete, ReadyForQuery
  assert.equal(types(reply), "12TDCZ");
  assert.deepEqual(rowsOf(reply), [["2"]]);
});

test("an error reply is Postgres's own, and the instance goes on", async () => {
  const reply = await catalog.run(simpleQuery("SELECT nope"));
  const [err] = decode(reply);
  assert.equal(err?.type, "E");
  assert.equal(err?.error?.["C"], "42703");
  assert.equal(types(reply), "EZ");
  assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT 1"))), [["1"]]);
});

test("two runs fired without awaiting each come back with their own reply", async () => {
  const [a, b] = await Promise.all([catalog.run(simpleQuery("SELECT 'a'")), catalog.run(simpleQuery("SELECT 'b'"))]);
  assert.deepEqual(rowsOf(a), [["a"]]);
  assert.deepEqual(rowsOf(b), [["b"]]);
});

test("stop() then run() starts again", async () => {
  await catalog.stop();
  assert.equal(catalog.started, false);
  assert.equal(logged.at(-1), "catalog: PGlite stopped");
  await catalog.stop(); // idempotent
  assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'"))), [["3"]]);
  assert.equal(catalog.started, true);
});

test("replace() with one more table shows it after the next run", async () => {
  const shipments: PgTable = { name: "shipments", primaryKey: ["id"], columns: [{ name: "id", type: "uuid" }], joins: [] };
  const replaced = catalog.replace({ ...schema, tables: [...schema.tables, shipments] });
  assert.equal(catalog.started, true); // stops on the queue, not synchronously
  await replaced;
  assert.equal(catalog.started, false);
  assert.equal(logged.at(-1), "catalog: PGlite replaced");
  const reply = await catalog.run(simpleQuery("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1"));
  assert.deepEqual(rowsOf(reply), [["customers"], ["orders"], ["regions"], ["shipments"]]);
});

test("catalogDdl: a source enum is created once, its labels in their declared order, in its own schema, before the tables", async () => {
  const labels = ["sad", "ok", "it's"];
  const t: PgTable = { name: "moods", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" },
    { name: "m", type: "text", spelled: "mood", enumLabels: labels }, { name: "ms", type: "text", spelled: "mood[]", enumLabels: labels },
    { name: "l", type: "text", spelled: "other.level", enumLabels: ["low", "high"] }, { name: "q", type: "text", spelled: `"Odd ""Mood"""`, enumLabels: ["a"] }] };
  const ddl = catalogDdl({ database: "x", tables: [t] });
  assert.deepEqual(ddl.slice(0, 4), ["CREATE TYPE mood AS ENUM ('sad', 'ok', 'it''s');", "CREATE SCHEMA IF NOT EXISTS other;",
    "CREATE TYPE other.level AS ENUM ('low', 'high');", `CREATE TYPE "Odd ""Mood""" AS ENUM ('a');`]);
  await catalog.replace({ database: "x", tables: [t] });
  try {
    assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid GROUP BY 1 ORDER BY 1"))),
      [["Odd \"Mood\"", "a"], ["level", "low,high"], ["mood", "sad,ok,it's"]]);
    assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT udt_schema, udt_name FROM information_schema.columns WHERE table_name = 'moods' ORDER BY ordinal_position"))),
      [["pg_catalog", "int4"], ["public", "mood"], ["public", "_mood"], ["other", "level"], ["public", "Odd \"Mood\""]]);
  } finally { await catalog.replace(schema); }
});

test("a source's NOT NULL, defaults, serials and identities are the catalog's; a default it cannot create is logged and left out", async () => {
  const t: PgTable = { name: "dd", primaryKey: ["id"], joins: [], columns: [
    { name: "id", type: "int4", notNull: true, default: "nextval('dd_id_seq'::regclass)", sequence: "public.dd_id_seq" },
    { name: "i", type: "int8", notNull: true, identity: "d", sequence: "public.dd_i_seq" },
    { name: "a", type: "int4", spelled: "integer", notNull: true, identity: "a", sequence: "public.dd_a_seq" },
    { name: "s", type: "text", notNull: true, default: "'draft'::text" },
    { name: "u", type: "uuid", default: "uuid_generate_v4()" },
    { name: "n", type: "int2", spelled: "smallint", default: "nextval('dd_n_seq'::regclass)", sequence: "public.dd_n_seq" }] };
  assert.equal(catalogDdl({ database: "x", tables: [t] })[0],
    `CREATE TABLE public."dd" (\n  "id" integer NOT NULL,\n  "i" bigint NOT NULL,\n  "a" integer NOT NULL,\n  "s" text NOT NULL,\n  "u" uuid,\n  "n" smallint,\n  PRIMARY KEY ("id")\n);`);
  assert.deepEqual(catalogDefaults({ database: "x", tables: [t] }), [
    `CREATE SEQUENCE public.dd_id_seq AS integer; ALTER TABLE public."dd" ALTER COLUMN "id" SET DEFAULT nextval('dd_id_seq'::regclass); ALTER SEQUENCE public.dd_id_seq OWNED BY public."dd"."id";`,
    `ALTER TABLE public."dd" ALTER COLUMN "i" ADD GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME public.dd_i_seq);`,
    `ALTER TABLE public."dd" ALTER COLUMN "a" ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.dd_a_seq);`,
    `ALTER TABLE public."dd" ALTER COLUMN "s" SET DEFAULT 'draft'::text;`,
    `ALTER TABLE public."dd" ALTER COLUMN "u" SET DEFAULT uuid_generate_v4();`,
    `CREATE SEQUENCE public.dd_n_seq AS smallint; ALTER TABLE public."dd" ALTER COLUMN "n" SET DEFAULT nextval('dd_n_seq'::regclass); ALTER SEQUENCE public.dd_n_seq OWNED BY public."dd"."n";`]);
  const from = logged.length;
  await catalog.replace({ database: "x", tables: [t] });
  try {
    assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT column_name, column_default, is_nullable, is_identity, identity_generation FROM information_schema.columns WHERE table_name = 'dd' ORDER BY ordinal_position"))), [
      ["id", "nextval('dd_id_seq'::regclass)", "NO", "NO", null], ["i", null, "NO", "YES", "BY DEFAULT"], ["a", null, "NO", "YES", "ALWAYS"],
      ["s", "'draft'::text", "NO", "NO", null], ["u", null, "YES", "NO", null], ["n", "nextval('dd_n_seq'::regclass)", "YES", "NO", null]]);
    assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT pg_get_serial_sequence('dd', 'id'), pg_get_serial_sequence('dd', 'i'), pg_get_serial_sequence('dd', 'n'), (SELECT data_type FROM information_schema.sequences WHERE sequence_name = 'dd_n_seq')"))),
      [["public.dd_id_seq", "public.dd_i_seq", "public.dd_n_seq", "smallint"]]);
    assert.deepEqual(logged.slice(from).filter((l) => l.includes("default left out")),
      [`catalog: a source default left out (function uuid_generate_v4() does not exist): ALTER TABLE public."dd" ALTER COLUMN "u" SET DEFAULT uuid_generate_v4();`]);
  } finally { await catalog.replace(schema); }
});

test("a schema whose DDL Postgres refuses fails the run naming the statement, and the object tries again", async () => {
  const clash: PgTable = { ...customers, columns: [...customers.columns, { name: "name", type: "text" }] };
  await catalog.replace({ database: "x", tables: [clash] });
  await assert.rejects(catalog.run(simpleQuery("SELECT 1")), (e: Error) => {
    assert.match(e.message, /^PGlite could not start: the catalog DDL was refused \(.*column "name" specified more than once.*\) at:\nCREATE TABLE public\."customers"/);
    return true;
  });
  assert.equal(catalog.started, false);
  await catalog.replace(schema);
  assert.deepEqual(rowsOf(await catalog.run(simpleQuery("SELECT 1"))), [["1"]]);
});

test("a source view left out is one line naming what it reads, said once per schema, its statement only under trace", async () => {
  // the test server's log: every left-out view's whole definition at each start of the instance, 7 multi-line entries a start
  const views: PgSchema = { ...schema, views: [
    { schema: "public", name: "v_gone", definition: "SELECT id FROM public.gone" },
    { schema: "public", name: "v ok", definition: 'SELECT id FROM public."customers"', description: "fine" }] };
  // read from the module's namespace: this file loads where it is missing, and the test fails by name (scripts/fails-without.ts)
  const { leftOutLine } = catalogModule as { leftOutLine?: (r: { statement: string; message: string }) => string };
  assert.ok(leftOutLine !== undefined, "leftOutLine is exported");
  assert.equal(leftOutLine({ statement: 'CREATE SCHEMA IF NOT EXISTS "public"; CREATE VIEW "public"."a ""b""" AS SELECT 1;', message: 'relation "public.gone" does not exist' }),
    'catalog: view public.a "b" left out: it reads public.gone, which is not copied');
  assert.equal(leftOutLine({ statement: 'CREATE SCHEMA IF NOT EXISTS "public"; CREATE VIEW "public"."v" AS SELECT f();', message: "function f() does not exist" }),
    "catalog: view public.v left out (function f() does not exist)");
  assert.equal(leftOutLine({ statement: 'ALTER TABLE public."dd" ALTER COLUMN "u" SET DEFAULT uuid_generate_v4();', message: "function uuid_generate_v4() does not exist" }),
    'catalog: a source default left out (function uuid_generate_v4() does not exist): ALTER TABLE public."dd" ALTER COLUMN "u" SET DEFAULT uuid_generate_v4();');
  const lines: string[] = [];
  const leftOut = (): string[] => lines.filter((l) => l.includes("left out"));
  const own = new PgCatalog(views, { idleMs: 200, log: (l) => lines.push(l) });
  try {
    assert.deepEqual(rowsOf(await own.run(simpleQuery('SELECT count(*) FROM "v ok"'))), [["0"]], "the view over a copied table is there");
    assert.deepEqual(leftOut(), ["catalog: view public.v_gone left out: it reads public.gone, which is not copied"]);
    assert.ok(!lines.some((l) => l.includes("CREATE VIEW")), `no definition in the log:\n${lines.join("\n")}`);
    // the instance stops idle and starts again: the view is not said again
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(own.started, false);
    assert.deepEqual(rowsOf(await own.run(simpleQuery("SELECT 2"))), [["2"]]);
    assert.equal(leftOut().length, 1, `said once:\n${lines.join("\n")}`);
    // a new schema is said afresh
    await own.replace(views);
    assert.deepEqual(rowsOf(await own.run(simpleQuery("SELECT 3"))), [["3"]]);
    assert.equal(leftOut().length, 2, `said again for the new schema:\n${lines.join("\n")}`);
  } finally { await own.stop(); }
  // under trace the statement follows its line
  const traced: string[] = [];
  const tracing = new PgCatalog(views, { trace: true, log: (l) => traced.push(l) });
  try {
    await tracing.run(simpleQuery("SELECT 1"));
    const at = traced.indexOf("catalog: view public.v_gone left out: it reads public.gone, which is not copied");
    assert.ok(at >= 0, traced.join("\n"));
    assert.equal(traced[at + 1], 'trace catalog: the statement left out: CREATE SCHEMA IF NOT EXISTS "public"; CREATE VIEW "public"."v_gone" AS SELECT id FROM public.gone;');
  } finally { await tracing.stop(); }
});

test("an idle timer stops the instance, and the next run starts it again", async () => {
  const lines: string[] = [];
  const idle = new PgCatalog(schema, { idleMs: 200, log: (l) => lines.push(l) });
  try {
    assert.deepEqual(rowsOf(await idle.run(simpleQuery("SELECT 1"))), [["1"]]);
    assert.equal(idle.started, true);
    await new Promise((r) => setTimeout(r, 100));
    await idle.query("SELECT 1"); // a call inside the period pushes the stop back
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(idle.started, true, "stopped before 200 ms of idleness");
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(idle.started, false);
    assert.equal(lines.at(-1), "catalog: PGlite stopped after 0 s idle");
    assert.deepEqual(rowsOf(await idle.run(simpleQuery("SELECT 2"))), [["2"]]);
    assert.equal(idle.started, true);
  } finally {
    await idle.stop();
  }
});

test("a statement past the deadline is refused naming it, the instance is replaced, and the event loop ran meanwhile", async () => {
  // PGlite runs synchronously on the thread that hosts it: on the main thread one catalog statement stalled every
  // session and every HTTP request (review of #480). On its worker, a timer here keeps firing while it spins.
  const lines: string[] = [];
  const slow = new PgCatalog(schema, { statementMs: 300, log: (l) => lines.push(l) });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    const started = Date.now();
    await assert.rejects(slow.run(simpleQuery("SELECT count(*) FROM generate_series(1, 4000000000)")), (e: Error) => {
      assert.match(e.message, /^the catalog did not answer .* within 0\.3 s, so Mason started it again \(the next statement is answered as usual; MASON_PG_CATALOG_TIMEOUT_MS raises the deadline\)/);
      assert.doesNotMatch(e.message, /pglite/i, "what a client reads names no engine");
      return true;
    });
    assert.ok(Date.now() - started < 5_000, "the deadline fired");
    assert.ok(ticks >= 5, `the event loop was blocked: ${ticks} tick(s) in 300 ms`);
    assert.equal(slow.started, false);
    assert.deepEqual(rowsOf(await slow.run(simpleQuery("SELECT 1"))), [["1"]]);
  } finally {
    clearInterval(timer);
    await slow.stop();
  }
});

// --- names, and the shop's schema ----------------------------------------------------------------------------

test("catalogDdl: two foreign keys from one column are named as Postgres names them (a number appended)", () => {
  const latest: PgTable = { name: "latest", primaryKey: ["customer_id"], columns: [{ name: "customer_id", type: "int8" }], joins: [] };
  const first: PgTable = { ...latest, name: "first" };
  const holder: PgTable = {
    ...customers,
    joins: [
      { name: "latest", table: "latest", on: ["id", "customer_id"], relationship: "one_to_one" },
      { name: "first", table: "first", on: ["id", "customer_id"], relationship: "one_to_one" },
    ],
  };
  const fks = catalogDdl({ database: "x", tables: [holder, latest, first] }).filter((s) => s.includes("FOREIGN KEY"));
  assert.deepEqual(fks.map((s) => /CONSTRAINT "([^"]+)"/.exec(s)?.[1]), ["customers_id_fkey", "customers_id_fkey1"]);
});

// the catalog's database is the project's name, whatever it is — one of PGlite's own (`template1`, `template0`) too:
// pg_database's names are unique, so the one already there is moved aside first, never a failed index (#484's review)
for (const name of ["shop", "template1", "template0", "postgres", "o'brien"]) {
  test(`the catalog's database is named ${JSON.stringify(name)}`, async () => {
    const own = new PgCatalog({ database: name, tables: [] }, { log: () => undefined, setup: databaseNameSql(name) });
    try {
      const { rows } = await own.query("SELECT current_database() AS db, (SELECT count(*)::int FROM pg_database WHERE datname = current_database()) AS n");
      assert.deepEqual(rows[0], { db: name, n: 1 });
    } finally {
      await own.stop();
    }
  });
}

// the shop's schema starts the catalog (its `customers` joins `latest_orders` and `latest_status` from one column: two
// constraints of one name, and no tool could list a table before the tools' recording)
test("the shop's schema starts the catalog, every foreign key in it", async () => {
  const own = new PgCatalog(SHOP_SCHEMA, { log: () => undefined });
  try {
    const { rows } = await own.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`);
    assert.equal(rows[0]?.n, catalogDdl(SHOP_SCHEMA).filter((s) => s.includes("FOREIGN KEY")).length);
    assert.ok((rows[0]?.n ?? 0) > 1, "the shop has foreign keys");
  } finally {
    await own.stop();
  }
});
