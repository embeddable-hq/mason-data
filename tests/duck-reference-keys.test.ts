/**
 * A JOIN ON A DECLARED REFERENCE READS HIDDEN INTEGER KEYS (issue 1144, src/duck/reference-keys.ts): where the schema
 * says a reference's keys are numbered (`PgSchema.references`, as the sync numbers them:
 * tests/integration/duck-reference-keys.itest.ts), an equality of its key columns that is a conjunct of a JOIN's ON or
 * of a WHERE is run as the equality of the two rows' hidden numbers. Every answer is held to Postgres (PGlite, the same
 * rows): an order whose customer is missing, an order with no customer, a referenced key held twice, a key of two
 * columns with a NULL in it. Where a row is not numbered, the statement runs on the keys themselves. A `*` lists no
 * hidden column.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-reference-keys-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;
const logged: string[] = [];

// the hidden columns, as the sync names them (`__mason_ref_`, the dictionary's 12 hex digits, `_` and 12 more)
const H = { customer: "__mason_ref_00000000000a_00000000000a", order: "__mason_ref_00000000000a_00000000000b", seat: "__mason_ref_00000000000c_00000000000c",
  booking: "__mason_ref_00000000000c_00000000000d", staff: "__mason_ref_00000000000e_00000000000e", boss: "__mason_ref_00000000000e_00000000000f" };
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

// customers: 8 of them, the id of 3 held twice, one with a NULL id; orders: of each, of a missing customer, of none
const CUSTOMERS: Array<[number, string | null, string]> = [[1, uuid(1), "north"], [2, uuid(2), "south"], [3, uuid(3), "north"], [4, uuid(3), "east"],
  [5, uuid(5), "east"], [6, uuid(6), "south"], [7, null, "north"], [8, uuid(8), "west"]];
const ORDERS: Array<[number, string | null, number]> = Array.from({ length: 30 }, (_, i) => [i + 1, uuid(1 + (i % 6)), (i + 1) * 5] as [number, string | null, number])
  .concat([[31, uuid(999), 7], [32, null, 9], [33, uuid(8), 11]]);
const SEATS: Array<[number | null, number, string]> = [[1, 1, "a"], [1, 2, "b"], [2, 1, "c"], [2, 2, "d"], [null, 1, "e"]];
const BOOKINGS: Array<[number, number | null, number | null, number]> = [[1, 1, 1, 2], [2, 1, 2, 1], [3, 2, 1, 4], [4, 2, 9, 1], [5, null, 1, 3], [6, 1, null, 5], [7, 1, 1, 6]];
// a table that references itself: each one's boss, none, or one who is gone
const STAFF: Array<[string, string | null, string]> = [[uuid(1), null, "ada"], [uuid(2), uuid(1), "bo"], [uuid(3), uuid(1), "cy"], [uuid(4), uuid(3), "di"], [uuid(5), uuid(77), "ed"]];

/** each key's number, given once in the order met, as the dictionary gives them; a NULL key's is the side's own */
function numbering(): (key: string, nullNumber: number) => number {
  const at = new Map<string, number>();
  return (key, nullNumber) => {
    if (key.includes("null")) return nullNumber;
    if (!at.has(key)) at.set(key, at.size + 1);
    return at.get(key)!;
  };
}
const lit = (v: string | number | null): string => v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`;

const statements = [
  "SELECT c.region, count(*), sum(o.amount) FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY 1 ORDER BY 1",
  "SELECT c.cid, count(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY 1 ORDER BY 1",
  "SELECT o.id, c.cid FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id > 28 ORDER BY 1, 2",
  "SELECT count(*) FROM orders o, customers c WHERE o.customer_id = c.id AND c.region = 'north'",
  "SELECT o.id, c.cid FROM orders o FULL JOIN customers c ON o.customer_id = c.id WHERE c.id IS NULL OR o.id IS NULL ORDER BY 1, 2",
  "SELECT count(*) FROM orders o RIGHT JOIN customers c ON o.customer_id = c.id AND o.amount > 100",
  "SELECT s.label, sum(b.nights) FROM bookings b JOIN seats s ON b.tenant_id = s.tenant_id AND b.seat_id = s.id GROUP BY 1 ORDER BY 1",
  "SELECT b.id, s.label FROM bookings b LEFT JOIN seats s ON s.id = b.seat_id AND s.tenant_id = b.tenant_id ORDER BY 1",
  "SELECT e.name, b.name FROM staff e LEFT JOIN staff b ON e.boss_id = b.id ORDER BY 1",
  "SELECT b.name, count(*) FROM staff e JOIN staff b ON b.id = e.boss_id GROUP BY 1 ORDER BY 1",
];
/** the same joins where the numbers' equality would answer otherwise than `=` or is not read: never on the numbers */
const plainShapes = [
  // `=` as a value: NULL where a key is NULL, which the numbers' FALSE is not
  "SELECT o.id, c.cid, o.customer_id = c.id FROM orders o CROSS JOIN customers c WHERE o.id IN (1, 32) ORDER BY 1, 2",
  "SELECT count(*) FROM orders o JOIN customers c ON NOT (o.customer_id <> c.id)",
  "SELECT count(*) FROM orders o JOIN customers c ON o.customer_id = c.id OR o.amount = 7",
  // a key of two columns joined on one of them
  "SELECT count(*) FROM bookings b JOIN seats s ON b.seat_id = s.id",
  // a column of an outer query
  "SELECT c.cid FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.amount > 140) ORDER BY 1",
  // a `*` of a synced table lists its columns, never a hidden one
  "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.id, c.cid LIMIT 4",
  "SELECT * FROM customers ORDER BY cid",
];

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "customers", primaryKey: ["cid"], joins: [], columns: [{ name: "cid", type: "int4" }, { name: "id", type: "uuid" }, { name: "region", type: "text" }] },
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "customer_id", type: "uuid" }, { name: "amount", type: "int4" }] },
    { name: "seats", primaryKey: [], joins: [], columns: [{ name: "tenant_id", type: "int4" }, { name: "id", type: "int4" }, { name: "label", type: "text" }] },
    { name: "bookings", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "tenant_id", type: "int4" }, { name: "seat_id", type: "int4" }, { name: "nights", type: "int4" }] },
    { name: "staff", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "uuid" }, { name: "boss_id", type: "uuid" }, { name: "name", type: "text" }] },
  ],
  references: [
    { from: { schema: "public", table: "orders", columns: ["customer_id"], hidden: H.order }, to: { schema: "public", table: "customers", columns: ["id"], hidden: H.customer } },
    { from: { schema: "public", table: "bookings", columns: ["tenant_id", "seat_id"], hidden: H.booking }, to: { schema: "public", table: "seats", columns: ["tenant_id", "id"], hidden: H.seat } },
    { from: { schema: "public", table: "staff", columns: ["boss_id"], hidden: H.boss }, to: { schema: "public", table: "staff", columns: ["id"], hidden: H.staff } },
  ],
};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => logged.push(l));
  const db = String((await store.writer.runAndReadAll("SELECT current_database()")).getRowsJS()[0]![0]);
  const w = store.writer;
  const customerNumber = numbering(), seatNumber = numbering(), staffNumber = numbering();
  await w.run(`CREATE TABLE public.customers (cid INTEGER, id UUID, region VARCHAR, "${H.customer}" BIGINT)`);
  await w.run(`INSERT INTO public.customers VALUES ${CUSTOMERS.map(([n, id, r]) => `(${n}, ${lit(id)}, ${lit(r)}, ${customerNumber(String(id), -1)})`).join(", ")}`);
  await w.run(`CREATE TABLE public.orders (id INTEGER, customer_id UUID, amount INTEGER, "${H.order}" BIGINT)`);
  await w.run(`INSERT INTO public.orders VALUES ${ORDERS.map(([n, c, a]) => `(${n}, ${lit(c)}, ${a}, ${customerNumber(String(c), 0)})`).join(", ")}`);
  await w.run(`CREATE TABLE public.seats (tenant_id INTEGER, id INTEGER, label VARCHAR, "${H.seat}" BIGINT)`);
  await w.run(`INSERT INTO public.seats VALUES ${SEATS.map(([t, s, l]) => `(${lit(t)}, ${s}, ${lit(l)}, ${seatNumber(`${t},${s}`, -1)})`).join(", ")}`);
  await w.run(`CREATE TABLE public.bookings (id INTEGER, tenant_id INTEGER, seat_id INTEGER, nights INTEGER, "${H.booking}" BIGINT)`);
  await w.run(`INSERT INTO public.bookings VALUES ${BOOKINGS.map(([n, t, s, k]) => `(${n}, ${lit(t)}, ${lit(s)}, ${k}, ${seatNumber(`${t},${s}`, 0)})`).join(", ")}`);
  await w.run(`CREATE TABLE public.staff (id UUID, boss_id UUID, name VARCHAR, "${H.staff}" BIGINT, "${H.boss}" BIGINT)`);
  await w.run(`INSERT INTO public.staff VALUES ${STAFF.map(([id, boss, n]) => `(${lit(id)}, ${lit(boss)}, ${lit(n)}, ${staffNumber(id, -1)}, ${staffNumber(String(boss), 0)})`).join(", ")}`);
  // each copy's view of its visible columns, as the sync makes it (src/duck/kept.ts `view`)
  await w.run("ATTACH IF NOT EXISTS ':memory:' AS __mason_visible");
  await w.run("CREATE SCHEMA IF NOT EXISTS __mason_visible.public");
  for (const t of schema.tables) await w.run(`CREATE VIEW __mason_visible.public.${t.name} AS SELECT ${t.columns.map((c) => c.name).join(", ")} FROM "${db}".public.${t.name}`);
  await truth.exec("CREATE TABLE customers (cid integer PRIMARY KEY, id uuid, region text); CREATE TABLE orders (id integer PRIMARY KEY, customer_id uuid, amount integer)");
  await truth.exec("CREATE TABLE seats (tenant_id integer, id integer, label text); CREATE TABLE bookings (id integer PRIMARY KEY, tenant_id integer, seat_id integer, nights integer)");
  await truth.exec(`INSERT INTO customers VALUES ${CUSTOMERS.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}; INSERT INTO orders VALUES ${ORDERS.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}`);
  await truth.exec(`CREATE TABLE staff (id uuid PRIMARY KEY, boss_id uuid, name text); INSERT INTO staff VALUES ${STAFF.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}`);
  await truth.exec(`INSERT INTO seats VALUES ${SEATS.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}; INSERT INTO bookings VALUES ${BOOKINGS.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}`);
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const problem = tokenProblem(API_KEY, password); if (problem !== null) throw new Error(problem); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, () => []),
  });
});
after(async () => {
  await api.close();
  await store.close();
  await truth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = { getTypeParser: () => (v: string) => v };
const TEXT_PARSERS = Object.fromEntries([16, 20, 21, 23, 25, 1043, 2950].map((o) => [o, (v: string) => v]));

/** each statement's answer from Mason beside Postgres's, and the engine's SQL it ran */
async function asked(sqls: readonly string[]): Promise<Array<{ sql: string; same: boolean; detail: string; ran: string }>> {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  const out = [];
  try {
    for (const sql of sqls) {
      const before = logged.length;
      const got = await c.query({ text: sql, rowMode: "array", types: raw } as pg.QueryConfig)
        .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x: unknown[]) => x.map((v) => v === null ? null : String(v))) }), (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
      const want = await truth.query<unknown[]>(sql, [], { rowMode: "array", parsers: TEXT_PARSERS })
        .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x) => x.map((v) => v === null ? null : String(v))) }), (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
      const ran = logged.slice(before).filter((l) => l.startsWith("statement:")).join("\n");
      out.push({ sql, same: util.isDeepStrictEqual(got, want), detail: `\n    mason:    ${JSON.stringify(got).slice(0, 400)}\n    postgres: ${JSON.stringify(want).slice(0, 400)}`, ran });
    }
  } finally { await c.end(); }
  return out;
}

test("a join on a numbered reference's key columns reads the hidden numbers, and answers as Postgres does", async () => {
  for (const a of await asked(statements)) {
    assert.ok(a.same, `${a.sql}${a.detail}`);
    assert.ok(a.ran.includes(H.order) || a.ran.includes(H.booking) || a.ran.includes(H.boss), `${a.sql}: joins on the numbers:\n${a.ran}`);
    assert.ok(!/customer_id = |seat_id = |boss_id = /.test(a.ran.replace(/^statement: [^—]*— /, "")), `${a.sql}: not on the keys:\n${a.ran}`);
  }
});

test("a comparison whose FALSE and NULL differ, a key joined in part, an outer query's column and a `*` read the keys, as Postgres does", async () => {
  for (const a of await asked(plainShapes)) {
    assert.ok(a.same, `${a.sql}${a.detail}`);
    assert.ok(!a.ran.includes("__mason_ref_"), `${a.sql}: never on the numbers:\n${a.ran}`);
  }
});

test("a row not numbered yet: the statement runs on the keys themselves, and answers as Postgres does", async () => {
  await store.writer.run(`UPDATE public.orders SET "${H.order}" = NULL WHERE id = 33`);
  await store.writer.run(`UPDATE public.seats SET "${H.seat}" = NULL WHERE label = 'a'`);
  // (a table that references itself: one row's referencing side alone)
  await store.writer.run(`UPDATE public.staff SET "${H.boss}" = NULL WHERE name = 'di'`);
  try {
    for (const a of await asked(statements)) {
      assert.ok(a.same, `${a.sql}${a.detail}`);
      assert.ok(!a.ran.includes("__mason_ref_"), `${a.sql}: on the keys:\n${a.ran}`);
    }
  } finally {
    await store.writer.run(`UPDATE public.orders SET "${H.order}" = (SELECT "${H.customer}" FROM public.customers WHERE cid = 8) WHERE id = 33`);
    await store.writer.run(`UPDATE public.seats SET "${H.seat}" = 1 WHERE label = 'a'`);
    await store.writer.run(`UPDATE public.staff SET "${H.boss}" = (SELECT "${H.staff}" FROM public.staff WHERE name = 'cy') WHERE name = 'di'`);
  }
  // numbered again: on the numbers
  for (const a of await asked(statements.slice(0, 1))) assert.ok(a.same && a.ran.includes(H.order), `${a.sql}${a.detail}\n${a.ran}`);
});

test("a statement on the numbers that fails or is cancelled ends its transaction: the session's next statement runs", async () => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  const join = statements[0]!;
  try {
    const want = (await truth.query<unknown[]>(join, [], { rowMode: "array", parsers: TEXT_PARSERS })).rows.map((x) => x.map(String));
    const again = async (): Promise<void> => {
      const r = await c.query({ text: join, rowMode: "array", types: raw } as pg.QueryConfig);
      assert.deepEqual(r.rows.map((x: unknown[]) => x.map(String)), want);
    };
    // an error raised while it runs
    await assert.rejects(c.query("SELECT sum(o.amount / (o.amount - 150)) FROM orders o JOIN customers c ON o.customer_id = c.id"), /division by zero/);
    await again();
    // a cancel: the statement's timeout, under a join on the numbers that runs long
    await c.query("SET statement_timeout = 200");
    await assert.rejects(c.query("SELECT count(*) FROM orders o JOIN customers c ON o.customer_id = c.id, generate_series(1, 2000000000) g WHERE g % 7 = 3"), /statement timeout|canceling statement/);
    await c.query("SET statement_timeout = 0");
    await again();
  } finally { await c.end(); }
});
