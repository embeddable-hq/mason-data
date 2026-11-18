/**
 * A GROUP BY OF A TIME'S UNIT, GROUPED BY ITS 15-MINUTE BUCKET FIRST (issue 1146, src/duck/bucket-group.ts): a copy
 * holds each timestamptz's 15 minutes of UTC in a hidden INTEGER beside it (src/duck/bucket-column.ts; as the sync writes
 * it: tests/integration/duck-time-bucket.itest.ts), and a GROUP BY of `date_trunc(unit, x)` in the session's zone groups
 * by it first. Held to Postgres (PGlite, the same rows) in UTC, a zone with daylight saving, +5:30, +5:45, Lord Howe's
 * 30-minute change and Chatham's +12:45 / +13:45: rows at and 1 µs either side of every change of offset of 2024 and of
 * each local month's first instant, every unit, every aggregate that adds up from parts. A row the bucket does not hold
 * (before 1980, infinite, NULL) is truncated as before, and so is every row in a zone that changed its offset a minute
 * past midnight (America/St_Johns until 2011, Antarctica/Casey until 2022). An aggregate that does not add up keeps the
 * plan it had.
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

// the hidden column's name and value as src/duck/bucket-column.ts makes them, spelled here so the file loads at a commit
// without that module (scripts/fails-without.ts), where the column is never read and the plan is the one before
const bucketColumn = (column: string): string => `__mason_bucket_${createHash("sha256").update(column).digest("hex").slice(0, 12)}`;
const bucketSql = (ts: string): string =>
  `CAST(CASE WHEN epoch_us(${ts}) >= 315532800000000 AND epoch_us(${ts}) < 253402300800000000 THEN epoch_us(${ts}) // 900000000 END AS INTEGER)`;
const hidden = bucketColumn("at");

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-time-bucket-"));
const truth = new PGlite();
let store: DuckStore;
let api: PgApiServer;

/** the zones the issue names: UTC, daylight saving, +5:30, +5:45, a 30-minute change, +12:45 / +13:45 */
const ZONES = ["UTC", "America/New_York", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham"];
const UNITS = ["hour", "day", "week", "month", "quarter", "year"];

/** each instant of `ev` (Postgres's text in UTC): every change of offset of 2024 in these zones and each local month's
 *  first instant, at and 1 µs either side, rows through the year, and the rows no bucket holds */
const EDGES = `WITH zones(z) AS (VALUES ${[...ZONES, "Europe/London", "America/St_Johns"].map((z) => `('${z}')`).join(", ")}),
  q AS (SELECT t FROM generate_series(timestamptz '2023-12-25 00:00+00', timestamptz '2025-01-05 00:00+00', interval '15 minutes') t),
  changes AS (SELECT q.t FROM q, zones WHERE (q.t AT TIME ZONE zones.z) - (q.t AT TIME ZONE 'UTC') <> ((q.t - interval '15 minutes') AT TIME ZONE zones.z) - ((q.t - interval '15 minutes') AT TIME ZONE 'UTC')),
  months AS (SELECT (m AT TIME ZONE zones.z) AS t FROM zones, generate_series(timestamp '2024-01-01', timestamp '2025-01-01', interval '1 month') m),
  edges AS (SELECT t FROM changes UNION SELECT t FROM months)
  SELECT t + d * interval '1 microsecond' AS t FROM edges, (VALUES (-1), (0), (1)) v(d)
  UNION ALL SELECT timestamptz '2024-01-01 00:00+00' + g * interval '7 hours 13 minutes 17.123456 seconds' FROM generate_series(0, 1200) g
  UNION ALL SELECT t::timestamptz FROM (VALUES ('1979-10-01 10:39:59.999999+00'), ('1979-12-31 23:59:59.999999+00'), ('1980-01-01 00:00:00+00'),
    ('1980-01-01 00:00:00.000001+00'), ('1960-02-29 12:34:56.789+00'), ('9999-12-31 23:59:59.999999+00'), ('infinity'), ('-infinity'),
    -- a change a minute past midnight, off a 15-minute boundary: St. John's in 2010 and 2011, Casey in 2022
    ('2011-03-13 03:30:30+00'), ('2011-03-13 03:31:30+00'), ('2010-11-07 02:30:30+00'), ('2010-11-07 02:31:30+00'), ('2022-10-01 16:00:30+00'), ('2022-10-01 16:01:30+00')) v(t)
  UNION ALL SELECT NULL`;

const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "ev", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "at", type: "timestamptz", bucket: hidden },
      { name: "v", type: "int4" }, { name: "x", type: "numeric", spelled: "numeric(10,2)" }, { name: "s", type: "text" }] },
    // only rows no bucket holds: before 1980, infinite and NULL
    { name: "old", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "at", type: "timestamptz", bucket: hidden }, { name: "v", type: "int4" }] },
  ],
};

before(async () => {
  await truth.exec("SET TimeZone = 'UTC'");
  const instants = (await truth.query<{ t: string | null }>(`SELECT t::text AS t FROM (${EDGES}) e ORDER BY t NULLS LAST`)).rows.map((r) => r.t);
  const rows = instants.map((t, i) => [i + 1, t, (i + 1) % 11 === 0 ? null : (i + 1) % 97, `${(i + 1) % 1000 / 8}`, `s${(i + 1) % 5}`] as const);
  const value = (v: string | number | null): string => v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`;
  await truth.exec(`CREATE TABLE ev (id integer PRIMARY KEY, at timestamptz, v integer, x numeric(10,2), s text); INSERT INTO ev VALUES ${rows.map((r) => `(${r.map(value).join(", ")})`).join(", ")}`);
  const OLD = "(1, '1979-10-01 10:39:59.999999+00', 1), (2, '1960-02-29 12:34:56.789+00', 2), (3, 'infinity', 3), (4, '-infinity', 4), (5, NULL, 5), (6, '1979-12-31 23:59:59.999999+00', 6)";
  await truth.exec(`CREATE TABLE old (id integer PRIMARY KEY, at timestamptz, v integer); INSERT INTO old VALUES ${OLD}`);
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const db = String((await store.writer.runAndReadAll("SELECT current_database()")).getRowsJS()[0]![0]);
  const w = store.writer;
  await w.run(`CREATE TABLE public.ev (id INTEGER, "at" TIMESTAMPTZ, v INTEGER, x DECIMAL(10,2), s VARCHAR, "${hidden}" INTEGER)`);
  for (let i = 0; i < rows.length; i += 1000) {
    await w.run(`INSERT INTO public.ev (id, "at", v, x, s) VALUES ${rows.slice(i, i + 1000).map((r) => `(${r.map(value).join(", ")})`).join(", ")}`);
  }
  await w.run(`CREATE TABLE public.old (id INTEGER, "at" TIMESTAMPTZ, v INTEGER, "${hidden}" INTEGER); INSERT INTO public.old (id, "at", v) VALUES ${OLD}`);
  for (const t of ["ev", "old"]) await w.run(`UPDATE public.${t} SET "${hidden}" = ${bucketSql('"at"')}`);
  // each copy's view of its visible columns, as the sync makes it (src/duck/kept.ts `view`)
  await w.run("ATTACH IF NOT EXISTS ':memory:' AS __mason_visible");
  await w.run("CREATE SCHEMA IF NOT EXISTS __mason_visible.public");
  await w.run(`CREATE VIEW __mason_visible.public.ev AS SELECT id, "at", v, x, s FROM "${db}".public.ev`);
  await w.run(`CREATE VIEW __mason_visible.public.old AS SELECT id, "at", v FROM "${db}".public.old`);
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
const TEXT_PARSERS = Object.fromEntries([16, 20, 21, 23, 25, 1043, 1184, 1700].map((o) => [o, (v: string) => v]));

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  return c;
}

/** the statements whose answers (names, types, text, order) differ between Mason and Postgres, each asked in `zone` */
async function unlike(zone: string, statements: readonly string[]): Promise<string[]> {
  const c = await client();
  const differ: string[] = [];
  try {
    await c.query(`SET TimeZone = '${zone}'`);
    await truth.exec(`SET TimeZone = '${zone}'`);
    for (const sql of statements) {
      const got = await c.query({ text: sql, rowMode: "array", types: raw } as pg.QueryConfig)
        .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x: unknown[]) => x.map((v) => v === null ? null : String(v))) }), (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
      const want = await truth.query<unknown[]>(sql, [], { rowMode: "array", parsers: TEXT_PARSERS })
        .then((r) => ({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows.map((x) => x.map((v) => v === null ? null : String(v))) }), (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
      if (!util.isDeepStrictEqual(got, want)) differ.push(`${zone}: ${sql}\n    mason:    ${JSON.stringify(got).slice(0, 600)}\n    postgres: ${JSON.stringify(want).slice(0, 600)}`);
    }
  } finally {
    await c.end();
    await truth.exec("SET TimeZone = 'UTC'");
  }
  return differ;
}

/** the SQL Mason sends the engine for `sql` (its EXPLAIN's line), in `zone` */
async function sent(sql: string, zone = "UTC"): Promise<string> {
  const c = await client();
  try {
    await c.query(`SET TimeZone = '${zone}'`);
    const lines = (await c.query({ text: `EXPLAIN ${sql}`, rowMode: "array" } as pg.QueryConfig)).rows.map((r: unknown[]) => String(r[0]));
    const line = lines.find((l) => l.trim().startsWith("Sent to the engine:"));
    assert.ok(line !== undefined, `no SQL in the EXPLAIN of ${sql}:\n${lines.join("\n")}`);
    return line;
  } finally { await c.end(); }
}

const EVERY = "count(*), count(v), sum(v), min(v), max(v), avg(v), sum(x), avg(x), min(x), max(at), min(at), count(*) FILTER (WHERE v > 50), sum(v) FILTER (WHERE s <> 's1')";

test("a GROUP BY of each unit of a timestamptz answers as Postgres does in every zone, at and either side of every change and month's start", async () => {
  // and in two zones whose changes were a minute past midnight, where the bucket does not decide the units
  for (const zone of [...ZONES, "America/St_Johns", "Antarctica/Casey"]) {
    assert.deepEqual(await unlike(zone, [
      ...UNITS.map((u) => `SELECT date_trunc('${u}', at) AS k, ${EVERY} FROM ev GROUP BY 1 ORDER BY 1`),
      // the expression grouped, beside another key, a HAVING, a WHERE, an ORDER BY of the output's name and a LIMIT
      "SELECT date_trunc('month', at) AS m, s, count(*), sum(v) FROM ev WHERE id % 3 <> 0 GROUP BY date_trunc('month', at), s HAVING count(*) > 2 ORDER BY m DESC NULLS FIRST, s LIMIT 25",
      // the truncation inside an expression of the list, a key read only by the ORDER BY, a sum over the sums
      "SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS d, max(v) - min(v), count(*) FROM ev GROUP BY date_trunc('day', at) ORDER BY date_trunc('day', at) NULLS FIRST LIMIT 40",
      "SELECT date_trunc('hour', at) AS h, count(*) FROM ev GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12",
      // over a join, its tables' columns qualified; in a WITH query
      "SELECT date_trunc('week', a.at) AS w, count(*), sum(b.v) FROM ev a JOIN ev b ON b.id = a.id + 1 GROUP BY 1 ORDER BY 1",
      "WITH q AS (SELECT date_trunc('quarter', at) AS q, v % 3 AS r, count(*) AS n, avg(x) AS a FROM ev GROUP BY 1, 2) SELECT * FROM q ORDER BY q, r",
      // the rows no bucket holds: before 1980, infinite and NULL, each truncated as before
      ...UNITS.map((u) => `SELECT date_trunc('${u}', at), count(*), sum(v) FROM old GROUP BY 1 ORDER BY 1`),
    ]), [], zone);
  }
});

test("a GROUP BY of a timestamptz's unit groups by its 15-minute bucket first; an aggregate that does not add up from parts keeps the plan", async () => {
  // the bucket is read, in any zone and in UTC
  for (const zone of ["Asia/Kathmandu", "UTC"]) {
    const sql = await sent("SELECT date_trunc('month', at) AS m, sum(v), count(*), avg(x) FROM ev GROUP BY 1 ORDER BY 1", zone);
    assert.ok(sql.includes(hidden), `the bucket is read in ${zone}: ${sql}`);
  }
  assert.ok((await sent("SELECT date_trunc('day', a.at), count(*) FROM ev a JOIN ev b ON b.id = a.id GROUP BY 1")).includes(hidden), "over a join");
  // an aggregate that does not add up from its parts, a window, a minute and a truncation in a zone of its own: as before
  for (const sql of [
    "SELECT date_trunc('month', at), count(DISTINCT v) FROM ev GROUP BY 1",
    "SELECT date_trunc('month', at), string_agg(s, ',' ORDER BY id) FROM ev GROUP BY 1",
    "SELECT date_trunc('month', at), count(*), rank() OVER (ORDER BY count(*)) FROM ev GROUP BY 1",
    "SELECT date_trunc('minute', at), count(*) FROM ev GROUP BY 1",
    "SELECT date_trunc('month', at, 'Asia/Kathmandu'), count(*) FROM ev GROUP BY 1",
  ]) assert.ok(!(await sent(sql)).includes(hidden), `${sql} keeps its plan`);
  // and each answers as Postgres does
  assert.deepEqual(await unlike("Asia/Kathmandu", [
    "SELECT date_trunc('month', at), count(DISTINCT v), count(*) FROM ev GROUP BY 1 ORDER BY 1",
    "SELECT date_trunc('month', at), string_agg(s, ',' ORDER BY id) FROM old GROUP BY 1 ORDER BY 1",
    "SELECT date_trunc('month', at), count(*), rank() OVER (ORDER BY count(*), date_trunc('month', at)) FROM ev GROUP BY 1 ORDER BY 1",
    "SELECT * FROM ev ORDER BY id LIMIT 3",
  ]), []);
});
