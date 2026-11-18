/**
 * A KEY OF ONE SIDE OF A GROUPED JOIN, COMPUTED ON THAT SIDE BEFORE THE JOIN (issue 1160, src/duck/side-first.ts): where a
 * GROUP BY key reads one table of the join alone, the table is much smaller than the join, and nothing filters the other
 * tables, the key is computed in a derived table of that table. Every answer is held to Postgres (PGlite, the same rows)
 * in UTC, a zone with daylight saving, +5:45 and +14: inner and outer joins (the side an outer join extends with NULLs
 * among them), a customer no order names, an order of no customer, a customer's key held twice, NULL, infinite and
 * pre-1980 times, the engine's last instant, the key by number, by expression and beside a constant, in a HAVING, an
 * ORDER BY, a window, a WITH query and a UNION ALL arm. With the copies' 15-minute buckets and a reference's numbers in
 * the same statement (the cold benchmark's revenue query), a statement prepared before the zone and the rows change,
 * and each shape that keeps its plan: a filter on the other table, a key that may fail or is not NULL on NULL, a key of
 * both tables, two tables of a size.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { createHash } from "node:crypto";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { CopyState } from "../src/duck/sync.ts";

// the hidden columns as the sync names and computes them (src/duck/bucket-column.ts, src/duck/reference-keys.ts),
// spelled here so the file loads at a commit without those modules (scripts/fails-without.ts)
const B = `__mason_bucket_${createHash("sha256").update("created_at").digest("hex").slice(0, 12)}`;
const bucketSql = (ts: string): string =>
  `CAST(CASE WHEN ${ts} IS NULL THEN NULL WHEN epoch_us(${ts}) >= 315532800000000 AND epoch_us(${ts}) < 253402300800000000 THEN epoch_us(${ts}) // 900000000 ELSE -1 END AS INTEGER)`;
const H = { customer: "__mason_ref_00000000000a_00000000000a", order: "__mason_ref_00000000000a_00000000000b" };
const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-side-first-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;
const logged: string[] = [];

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const lit = (v: string | number | null): string => v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`;
// customers: times through 2023-2025 (a year's and a month's edge in Kathmandu, +5:45, among them), NULL, ±infinity,
// before 1980 and the engine's last instant; regions NULL, '' and two cases; customer 3's id held twice, one's NULL.
// Customers 21-24 (the infinite, the last instant, the NULL id) are named by no order. The last instant is never an
// answer (the wire cannot send a time past year 275760, at main too): a statement that keeps customer 23 leaves it out
const AT = ["2023-01-14 09:00:00+00", "2023-06-30 18:14:59+00", "2023-12-31 18:14:59.999999+00", "2023-12-31 18:15:00+00", "2024-02-29 12:00:00+00",
  "2024-03-10 07:30:00+00", "2024-06-30 18:15:00+00", "2024-11-03 05:59:59+00", "2024-12-31 18:20:00+00", "2025-01-01 00:00:00+00", null, "1975-06-01 12:00:00+00",
  "2025-03-30 01:00:00+00", "2025-07-04 23:59:59+00", "2025-10-26 00:59:59+00", "2025-12-31 23:59:59+00", "2023-09-01 00:00:00+00", "2024-08-15 03:45:00+00",
  "1979-12-31 23:59:59+00", "2025-05-05 05:05:05+00", "infinity", "-infinity", "294247-01-10 04:00:54+00", "2024-01-01 00:00:00+00"];
const REGIONS = ["north", "North", "south", "", null, "east"];
const CUSTOMERS = AT.map((at, i): [number, string | null, string | null, string | null, string | null, number] =>
  [i + 1, i === 23 ? null : uuid(i === 3 ? 3 : i + 1), REGIONS[i % REGIONS.length]!, at, i % 5 === 0 ? null : `2024-0${1 + (i % 9)}-1${i % 10} 0${i % 10}:30:00+00`, (i * 7) % 11]);
// orders: of customers 1-20 (the twice-held key's among them), of a customer missing, of none
const ORDERS = Array.from({ length: 120 }, (_, i): [number, string | null, string, string, string] => {
  const n = i + 1;
  const customer = n % 29 === 0 ? null : n % 31 === 0 ? uuid(999) : uuid(1 + (i % 20));
  const day = new Date(Date.UTC(2023, 0, 1) + i * 6.37 * 86_400_000 + (i % 7) * 3_600_000 + (i % 4) * 900_000);
  return [n, customer, `${(n * 37) % 500}.${String(n % 100).padStart(2, "0")}`, `${day.toISOString().replace("T", " ").replace("Z", "+00")}`, ["paid", "shipped", "refunded"][n % 3]!];
});

/** each key's number, given once in the order met, as the dictionary gives them; a NULL key's is the side's own */
function numbering(): (key: string | null, nullNumber: number) => number {
  const at = new Map<string, number>();
  return (key, nullNumber) => {
    if (key === null) return nullNumber;
    if (!at.has(key)) at.set(key, at.size + 1);
    return at.get(key)!;
  };
}

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "customers", primaryKey: ["cid"], joins: [], columns: [{ name: "cid", type: "int4" }, { name: "id", type: "uuid" }, { name: "region", type: "text" },
      { name: "created_at", type: "timestamptz", bucket: B }, { name: "seen_at", type: "timestamptz" }, { name: "score", type: "int4" }] },
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "customer_id", type: "uuid" }, { name: "amount", type: "numeric", spelled: "numeric(12,2)" },
      { name: "created_at", type: "timestamptz", bucket: B }, { name: "status", type: "text" }] },
    // a table the sync has not counted
    { name: "notes", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "customer_id", type: "uuid" }, { name: "body", type: "text" }] },
  ],
  references: [
    { from: { schema: "public", table: "orders", columns: ["customer_id"], hidden: H.order }, to: { schema: "public", table: "customers", columns: ["id"], hidden: H.customer } },
  ],
};
/** the copies as the sync counts them: customers a fifth of the orders */
const copies = (): CopyState[] => [{ source: "public.customers", phase: "copied", rows: CUSTOMERS.length }, { source: "public.orders", phase: "copied", rows: ORDERS.length }] as unknown as CopyState[];

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => logged.push(l));
  const db = String((await store.writer.runAndReadAll("SELECT current_database()")).getRowsJS()[0]![0]);
  const w = store.writer;
  const number = numbering();
  await w.run(`CREATE TABLE public.customers (cid INTEGER, id UUID, region VARCHAR, created_at TIMESTAMPTZ, seen_at TIMESTAMPTZ, score INTEGER, "${B}" INTEGER, "${H.customer}" BIGINT)`);
  await w.run(`INSERT INTO public.customers VALUES ${CUSTOMERS.map(([n, id, r, at, seen, s]) => `(${n}, ${lit(id)}, ${lit(r)}, ${lit(at)}, ${lit(seen)}, ${s}, NULL, ${number(id, -1)})`).join(", ")}`);
  await w.run(`CREATE TABLE public.orders (id INTEGER, customer_id UUID, amount DECIMAL(12,2), created_at TIMESTAMPTZ, status VARCHAR, "${B}" INTEGER, "${H.order}" BIGINT)`);
  await w.run(`INSERT INTO public.orders VALUES ${ORDERS.map(([n, c, a, at, s]) => `(${n}, ${lit(c)}, ${a}, ${lit(at)}, ${lit(s)}, NULL, ${number(c, 0)})`).join(", ")}`);
  await w.run("CREATE TABLE public.notes (id INTEGER, customer_id UUID, body VARCHAR)");
  await w.run(`INSERT INTO public.notes VALUES ${Array.from({ length: 60 }, (_, i) => `(${i + 1}, ${lit(uuid(1 + (i % 6)))}, 'n${i % 4}')`).join(", ")}`);
  for (const t of ["customers", "orders"]) await w.run(`UPDATE public.${t} SET "${B}" = ${bucketSql("created_at")}`);
  // each copy's view of its visible columns, as the sync makes it (src/duck/kept.ts `view`)
  await w.run("ATTACH IF NOT EXISTS ':memory:' AS __mason_visible");
  await w.run("CREATE SCHEMA IF NOT EXISTS __mason_visible.public");
  for (const t of schema.tables) await w.run(`CREATE VIEW __mason_visible.public.${t.name} AS SELECT ${t.columns.map((c) => c.name).join(", ")} FROM "${db}".public.${t.name}`);
  await truth.exec("CREATE TABLE customers (cid integer PRIMARY KEY, id uuid, region text, created_at timestamptz, seen_at timestamptz, score integer)");
  await truth.exec(`INSERT INTO customers VALUES ${CUSTOMERS.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}`);
  await truth.exec("CREATE TABLE orders (id integer PRIMARY KEY, customer_id uuid, amount numeric(12,2), created_at timestamptz, status text)");
  await truth.exec(`INSERT INTO orders VALUES ${ORDERS.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}`);
  await truth.exec("CREATE TABLE notes (id integer PRIMARY KEY, customer_id uuid, body text)");
  await truth.exec(`INSERT INTO notes VALUES ${Array.from({ length: 60 }, (_, i) => `(${i + 1}, ${lit(uuid(1 + (i % 6)))}, 'n${i % 4}')`).join(", ")}`);
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const problem = tokenProblem(API_KEY, password); if (problem !== null) throw new Error(problem); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, copies),
  });
});
after(async () => {
  await api.close();
  await store.close();
  await truth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = { getTypeParser: () => (v: string) => v };
const TEXT_PARSERS = Object.fromEntries([16, 20, 21, 23, 25, 1043, 1082, 1184, 1700, 701].map((o) => [o, (v: string) => v]));

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  return c;
}
type Answer = { fields: unknown[][]; rows: Array<Array<string | null>> } | string;
const mason = (c: pg.Client, sql: string, name?: string): Promise<Answer> => c.query({ text: sql, rowMode: "array", types: raw, ...(name === undefined ? {} : { name }) } as pg.QueryConfig)
  .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x: unknown[]) => x.map((v) => v === null ? null : String(v))) }), (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
const postgres = (sql: string): Promise<Answer> => truth.query<unknown[]>(sql, [], { rowMode: "array", parsers: TEXT_PARSERS })
  .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x) => x.map((v) => v === null ? null : String(v))) }), (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
/** an error's SQLSTATE alone: the two word some messages otherwise */
const code = (a: Answer): Answer => typeof a === "string" ? a.slice(0, 5) : a;

/** the statements whose answers (names, types, text, order, SQLSTATE) differ between Mason and Postgres, in `zone` */
async function unlike(zone: string, statements: readonly string[]): Promise<string[]> {
  const c = await client();
  const differ: string[] = [];
  try {
    await c.query(`SET TimeZone = '${zone}'`);
    await truth.exec(`SET TimeZone = '${zone}'`);
    for (const sql of statements) {
      const [got, want] = [code(await mason(c, sql)), code(await postgres(sql))];
      if (!util.isDeepStrictEqual(got, want)) differ.push(`${zone}: ${sql}\n    mason:    ${JSON.stringify(got).slice(0, 700)}\n    postgres: ${JSON.stringify(want).slice(0, 700)}`);
    }
  } finally {
    await c.end();
    await truth.exec("SET TimeZone = 'UTC'");
  }
  return differ;
}

/** the SQL Mason sends the engine for `sql` (its EXPLAIN's line), in `zone` */
async function sent(sql: string, zone = "Asia/Kathmandu"): Promise<string> {
  const c = await client();
  try {
    await c.query(`SET TimeZone = '${zone}'`);
    const lines = (await c.query({ text: `EXPLAIN ${sql}`, rowMode: "array" } as pg.QueryConfig)).rows.map((r: unknown[]) => String(r[0]));
    const line = lines.find((l) => l.trim().startsWith("Sent to the engine:"));
    assert.ok(line !== undefined, `no SQL in the EXPLAIN of ${sql}:\n${lines.join("\n")}`);
    return line;
  } finally { await c.end(); }
}
/** whether the SQL sent computes a key in a derived table of its side */
const sideFirst = (line: string): boolean => /__mason\d*_side\d/.test(line) && /\) AS (c|customers)\b/.test(line);

const JOIN = "FROM orders o JOIN customers c ON c.id = o.customer_id";
const REVENUE = `SELECT date_trunc('month', o.created_at) AS month, date_trunc('year', c.created_at) AS signup_year, sum(o.amount) AS revenue ${JOIN} GROUP BY 1, 2 ORDER BY 1, 2`;

/** the shapes whose key of `customers` is computed on it first */
const MOVED = [
  REVENUE,
  // the side an outer join extends with NULLs, a truncation of which is NULL on NULL; and the side it keeps
  "SELECT date_trunc('month', o.created_at) AS m, date_trunc('year', c.created_at) AS y, count(*), count(c.cid), sum(o.amount) FROM orders o LEFT JOIN customers c ON c.id = o.customer_id GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2 NULLS FIRST",
  "SELECT date_trunc('quarter', c.created_at) AS q, count(o.id), sum(o.amount) FROM orders o RIGHT JOIN customers c ON c.id = o.customer_id WHERE c.cid IS DISTINCT FROM 23 GROUP BY 1 ORDER BY 1 NULLS FIRST",
  "SELECT date_trunc('week', c.created_at) AS w, lower(c.region) AS r, count(*), max(o.id) FROM orders o FULL JOIN customers c ON c.id = o.customer_id WHERE c.cid IS DISTINCT FROM 23 GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2 NULLS FIRST",
  "SELECT date_trunc('day', c.created_at) AS d, count(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.cid IS DISTINCT FROM 23 GROUP BY 1 ORDER BY 1 NULLS FIRST",
  // a date, a text's case
  `SELECT c.created_at::date AS d, upper(c.region), count(*), max(o.amount) ${JOIN} GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2 NULLS FIRST`,
  // the key by expression, in a HAVING and an ORDER BY; beside a constant key; read only by the ORDER BY
  `SELECT date_trunc('year', c.created_at) AS y, count(*) ${JOIN} GROUP BY date_trunc('year', c.created_at) HAVING date_trunc('year', c.created_at) > '2000-01-01' OR count(*) > 3 ORDER BY date_trunc('year', c.created_at) DESC NULLS LAST`,
  `SELECT 1 AS one, date_trunc('year', c.created_at) AS y, count(*) ${JOIN} GROUP BY 1, 2 ORDER BY 2, 1`,
  `SELECT count(*), sum(o.amount) ${JOIN} GROUP BY date_trunc('month', c.created_at) ORDER BY date_trunc('month', c.created_at) NULLS FIRST`,
  `SELECT lower(c.region) AS r, count(*) ${JOIN} GROUP BY 1 ORDER BY r NULLS FIRST`,
  `SELECT lower(c.region) AS region, count(*) ${JOIN} GROUP BY lower(c.region) ORDER BY region NULLS FIRST`,
  // a comma join, a table named by its schema, a bare name of one table, a filter on the side itself
  "SELECT date_trunc('month', c.created_at) AS m, count(*) FROM orders o, customers c WHERE o.customer_id = c.id GROUP BY 1 ORDER BY 1 NULLS FIRST",
  "SELECT date_trunc('year', public.customers.created_at) AS y, sum(public.orders.amount) FROM public.orders JOIN public.customers ON public.customers.id = public.orders.customer_id " +
    "GROUP BY date_trunc('year', public.customers.created_at) ORDER BY 1 NULLS FIRST",
  `SELECT date_trunc('year', seen_at) AS y, count(*) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT date_trunc('year', c.created_at) AS y, count(*) ${JOIN} WHERE c.region IS NOT NULL AND c.score > 2 GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  // a key that is a CASE over the side's columns
  `SELECT CASE WHEN c.region IN ('north', 'North') THEN 'n' WHEN c.region IS NULL THEN NULL ELSE 's' END AS k, count(*) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  // another aggregate of the side's columns, a window over the groups, DISTINCT
  `SELECT date_trunc('year', c.created_at) AS y, min(c.created_at), max(c.seen_at), count(DISTINCT c.cid), avg(o.amount) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT date_trunc('year', c.created_at) AS y, count(*), rank() OVER (ORDER BY count(*) DESC, date_trunc('year', c.created_at) NULLS FIRST) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT DISTINCT date_trunc('year', c.created_at) AS y, count(*) > 5 ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  // three tables, a WITH query, a UNION ALL's arms, a derived table around it
  "SELECT date_trunc('year', c.created_at) AS y, count(*) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN orders o2 ON o2.id = o.id GROUP BY 1 ORDER BY 1 NULLS FIRST",
  `WITH t AS (SELECT date_trunc('year', c.created_at) AS y, sum(o.amount) AS s ${JOIN} GROUP BY 1) SELECT * FROM t ORDER BY y NULLS FIRST`,
  `SELECT date_trunc('year', c.created_at), count(*) ${JOIN} GROUP BY 1 UNION ALL SELECT date_trunc('month', c.created_at), count(*) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST, 2`,
  `SELECT y, n FROM (SELECT date_trunc('year', c.created_at) AS y, count(*) AS n ${JOIN} GROUP BY 1) s ORDER BY 1 NULLS FIRST`,
];
/** the shapes that keep their plan, each for its reason */
const KEPT = [
  // the other table filtered: the join may hold fewer rows than the side
  `SELECT date_trunc('year', c.created_at) AS y, count(*) ${JOIN} WHERE o.status = 'paid' GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  "SELECT date_trunc('year', c.created_at) AS y, count(*) FROM orders o JOIN customers c ON c.id = o.customer_id AND o.amount > 100 GROUP BY 1 ORDER BY 1 NULLS FIRST",
  // not NULL on the NULLs an outer join extends the side with; on the side an inner join reads, it moves (below)
  "SELECT coalesce(c.region, 'none') AS r, count(*) FROM orders o LEFT JOIN customers c ON c.id = o.customer_id GROUP BY 1 ORDER BY 1",
  // a key of both tables, a key that can fail (an infinite time's extract is refused by name), a Mason function's key
  `SELECT date_trunc('year', least(c.created_at, o.created_at)) AS y, count(*) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT extract(year FROM c.created_at) AS y, count(*) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT c.score + 1 AS s, count(*) ${JOIN} GROUP BY 1 ORDER BY 1`,
  // two tables of a size, a table the sync has not counted
  "SELECT date_trunc('year', a.created_at) AS y, count(*) FROM customers a JOIN customers c ON c.cid = a.cid WHERE a.cid <> 23 GROUP BY 1 ORDER BY 1 NULLS FIRST",
  "SELECT lower(n.body) AS b, count(*) FROM orders c JOIN notes n ON n.customer_id = c.customer_id GROUP BY 1 ORDER BY 1",
  // a subquery in the list
  `SELECT date_trunc('year', c.created_at) AS y, count(*), (SELECT count(*) FROM notes) ${JOIN} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
];

test("a key of one side of a grouped join answers as Postgres does, computed on its side first or not, in every zone", async () => {
  for (const zone of ["UTC", "Asia/Kathmandu", "America/New_York", "Pacific/Kiritimati"]) {
    assert.deepEqual(await unlike(zone, [...MOVED, ...KEPT,
      // the coalesce on the side an inner join reads; a key spelled otherwise in the list than in the GROUP BY (42803)
      `SELECT coalesce(c.region, 'none') AS r, count(*) ${JOIN} GROUP BY 1 ORDER BY 1`,
      // date() of a time, the engine's function, kept off the allowlist; its answer is held all the same
      `SELECT date(c.created_at) AS d, count(*) FROM orders o LEFT JOIN customers c ON c.id = o.customer_id GROUP BY 1 ORDER BY 1 NULLS FIRST`,
      `SELECT date_trunc('YEAR', c.created_at), count(*) ${JOIN} GROUP BY date_trunc('year', c.created_at)`,
      // an hour in a zone of its own: the engine's local time of the last instant past its last day, never computed for
      // the customer no order names
      `SELECT date_trunc('hour', c.created_at) AS h, date_trunc('day', c.created_at) AS d, count(*) ${JOIN} GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2`,
    ]), [], zone);
  }
});

test("a key of the smaller side is computed on it first; a key that may fail, is not NULL on NULL, reads both or saves nothing keeps its plan", async () => {
  for (const zone of ["UTC", "Asia/Kathmandu"]) {
    for (const sql of MOVED) assert.ok(sideFirst(await sent(sql, zone)), `${zone}: computed on its side first: ${sql}\n${await sent(sql, zone)}`);
    for (const sql of KEPT) assert.ok(!/__mason\d*_side\d/.test(await sent(sql, zone)), `${zone}: keeps its plan: ${sql}\n${await sent(sql, zone)}`);
  }
  assert.ok(sideFirst(await sent(`SELECT coalesce(c.region, 'none') AS r, count(*) ${JOIN} GROUP BY 1 ORDER BY 1`)), "a coalesce on the side an inner join reads");
});

test("the cold benchmark's revenue query: the signup year on the customers, the month by the orders' bucket, the join on the reference's numbers", async () => {
  const kathmandu = await sent(REVENUE, "Asia/Kathmandu");
  assert.ok(sideFirst(kathmandu), kathmandu);
  assert.ok(kathmandu.includes(`o.${B}`) && kathmandu.includes("__mason_bucketed"), `the month by the orders' bucket: ${kathmandu}`);
  assert.ok(kathmandu.includes(`o.${H.order} = c.${H.customer}`), `on the numbers: ${kathmandu}`);
  const utc = await sent(REVENUE, "UTC");
  assert.ok(sideFirst(utc) && utc.includes(`o.${H.order} = c.${H.customer}`) && !utc.includes("__mason_bucketed"), utc);
});

test("a statement prepared before its session's zone and its rows change answers as Postgres does after", async () => {
  const c = await client();
  try {
    const ask = async (zone: string): Promise<void> => {
      await truth.exec(`SET TimeZone = '${zone}'`);
      for (const [i, sql] of [REVENUE, MOVED[1]!, MOVED[3]!].entries()) assert.deepEqual(await mason(c, sql, `side_first_${i}`), await postgres(sql), `${zone}: ${sql}`);
    };
    await c.query("SET TimeZone = 'Asia/Kathmandu'");
    await ask("Asia/Kathmandu");
    await c.query("SET TimeZone = 'America/New_York'");
    await ask("America/New_York");
    // a customer and its orders written after the plan was made, on both sides as the sync writes them
    const w = store.writer;
    const id = uuid(500);
    await w.run(`INSERT INTO public.customers VALUES (500, '${id}', 'west', '2025-12-31 20:00:00+00', NULL, 1, ${bucketSql("TIMESTAMPTZ '2025-12-31 20:00:00+00'")}, 500)`);
    await w.run(`INSERT INTO public.orders VALUES (500, '${id}', 12.34, '2026-01-01 04:00:00+00', 'paid', ${bucketSql("TIMESTAMPTZ '2026-01-01 04:00:00+00'")}, 500), ` +
      `(501, '${id}', 1.00, '1977-01-01 00:00:00+00', 'paid', ${bucketSql("TIMESTAMPTZ '1977-01-01 00:00:00+00'")}, 500)`);
    await truth.exec(`INSERT INTO customers VALUES (500, '${id}', 'west', '2025-12-31 20:00:00+00', NULL, 1); INSERT INTO orders VALUES (500, '${id}', 12.34, '2026-01-01 04:00:00+00', 'paid'), (501, '${id}', 1.00, '1977-01-01 00:00:00+00', 'paid')`);
    await ask("America/New_York");
    await c.query("SET TimeZone = 'Asia/Kathmandu'");
    await ask("Asia/Kathmandu");
  } finally {
    await c.end();
    await truth.exec("SET TimeZone = 'UTC'");
  }
});
