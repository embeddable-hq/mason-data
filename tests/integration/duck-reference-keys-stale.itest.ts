/**
 * A HIDDEN KEY'S NUMBER NEVER OUTLIVES ITS KEY (issue 1144, src/duck/reference-keys.ts). Whether a row's number is still
 * right is decided from the store, in the transaction of the write that changes its key, never from what the numbering
 * found before. And a number is always of the dictionary of its key's type.
 *
 * - The stream's UPDATE that leaves a large value unchanged (src/duck/sync.ts `updateCarried`) right after a table's
 *   compaction or its swap, before the numbering's next turn: the key it changes is numbered again with it.
 * - A key's type changed at the source on both sides of a reference (uuid to text, bigint to text), under the poll and
 *   the stream: the old dictionary is never read for the new values, and a value the old type cannot hold never stops
 *   the table's sync.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the stream's tests, skipped otherwise), psql on PATH. It
 * writes only inside the databases it creates, `it_refstale_<random>_*`, and drops them at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable, type SyncMode } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";
import { checkpoint } from "./checkpoint.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_refstale_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-refstale-"));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const logical = adminUrl !== undefined && psql(adminUrl, "SHOW wal_level") === "logical";
const skip = adminUrl === undefined ? "IT_POSTGRES_URL is not set" : false;
const skipStream = skip || (!logical && "the test server's wal_level is not logical");

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

const uuid = (n: string): string => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;

/** each referencing table's `references:` as the sources file names them */
type References = Record<string, Array<{ columns: string[]; table: string; targetColumns: string[] }>>;

/** the source's tables as `mason start` reads them, each with its `references:` */
async function tablesOf(source: Source, names: readonly string[], references: References, mode: SyncMode): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return names.map((n) => {
      const t = facts.tables.find((x) => x.source === n);
      if (!t) throw new Error(`no table ${n}`);
      return { ...t, ...(mode === "replication" ? { sync: { mode: "replication" } } : {}), ...(references[n] ? { fileReferences: references[n] } : {}) } as AddedTable;
    });
  } finally { c.pg.close(); }
}

/** a database of `schema`, synced in `mode` and served */
async function started(name: string, mode: SyncMode, schema: string, names: readonly string[], references: References, numbered: number) {
  const db = `${tag}_${name}`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, schema);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, `${name}.db`), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), mode === "replication" ? 1_000 : 3_600_000, mode,
    mode === "replication" ? { slot: `${tag}_${name}`, publication: `${tag}_${name}`, owned: true } : null,
    // (compacted only when the test asks, at a third of its space dead, however small)
    { compact: { firstCheckMs: 3_600_000, checkMs: 3_600_000, wasteShare: 0.3, minWasteBlocks: 0 } });
  await sync.open();
  sync.setTables(await tablesOf(parsed.source, names, references, mode));
  await sync.once();
  if (mode === "replication") await sync.caughtUp();
  await until(() => (sync.schema().references ?? []).length === numbered, "the references numbered", logged);
  const server = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, null, undefined, () => sync.state(), sync.kept.enabled ? sync.kept : undefined) });
  const client = new pg.Client({ host: "127.0.0.1", port: server.port, database: db, user: "test", password: "x" });
  await client.connect();
  const ask = async (sql: string): Promise<string> => (await client.query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows
    .map((r: unknown[]) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd();
  return { db, url, source: parsed.source, logged, store, sync, ask,
    close: async () => { await client.end(); await server.close(); await sync.stop(); await store.close(); } };
}

/** until `ok`, or 60 s */
async function until(ok: () => boolean | Promise<boolean>, what: string, logged: readonly string[]): Promise<void> {
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await ok()) return;
  assert.fail(`${what}: not in 60 s\n${logged.slice(-15).join("\n")}`);
}

/** the rows of `table`'s hidden keys not numbered yet, as committed: read on a connection of the test's own, never the
 *  sync's writer, which the sync uses meanwhile (one connection never runs two statements at once) */
async function unnumbered(store: DuckStore, table: string): Promise<number> {
  const c = await store.instance.connect();
  try {
    const cols = (await c.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = '${table}' AND starts_with(column_name, '__mason_ref_')`)).getRowsJS().map((r) => String(r[0]));
    let n = 0;
    for (const col of cols) n += Number((await c.runAndReadAll(`SELECT count(*) FROM public.${table} WHERE "${col}" IS NULL`)).getRowsJS()[0]![0]);
    return n;
  } finally { c.closeSync(); }
}

/** each join answered as Postgres answers it, on the numbers once every row is numbered */
async function sameAnswers(s: Awaited<ReturnType<typeof started>>, joins: readonly string[], tables: readonly string[], when: string): Promise<void> {
  await until(async () => { let left = 0; for (const t of tables) left += await unnumbered(s.store, t); return left === 0; }, `every row numbered, ${when}`, s.logged);
  for (const sql of joins) {
    const before = s.logged.length;
    assert.equal(await s.ask(sql), psql(s.url, sql), `${sql}, ${when}`);
    const ran = s.logged.slice(before).filter((l) => l.startsWith("statement:")).join("\n");
    assert.ok(ran.includes("__mason_ref_"), `${sql}, ${when}: joins on the numbers:\n${ran}`);
  }
}

/** THE NUMBERING'S TURN HELD (a test's stand-in for its 50 ms timer not having had the writer yet): `ensure` does
 *  nothing until `release` */
function holdNumbering(sync: Sync): { release: () => Promise<void> } {
  const numbers = sync.numbers as unknown as { ensure: (w: unknown) => Promise<boolean> };
  numbers.ensure = async () => false;
  // released: its turn comes, as the next pass asks for it
  return { release: async () => { delete (numbers as { ensure?: unknown }).ensure; await sync.once(); } };
}

// THE STREAM'S UPDATE RIGHT AFTER A COMPACTION OR A SWAP
const WINDOW = `
CREATE TABLE cust (pk serial PRIMARY KEY, id uuid, region text);
CREATE TABLE ord (id int PRIMARY KEY, customer_id uuid, n int, blob text);
ALTER TABLE ord ALTER COLUMN blob SET STORAGE EXTERNAL;
INSERT INTO cust (id, region) SELECT ${uuid("i")}, (ARRAY['north','south','east'])[1 + i % 3] FROM generate_series(1, 400) i;
INSERT INTO ord SELECT i, ${uuid("1 + i % 420")}, i % 7, CASE WHEN i % 50 = 0 THEN repeat('x', 4000) END FROM generate_series(1, 20000) i;
`;
const WINDOW_REFS: References = { "public.ord": [{ columns: ["customer_id"], table: "public.cust", targetColumns: ["id"] }] };
const WINDOW_JOINS = [
  "SELECT count(*), count(o.id), count(c.pk) FROM ord o FULL JOIN cust c ON o.customer_id = c.id",
  "SELECT c.region, count(*), sum(o.n) FROM ord o JOIN cust c ON o.customer_id = c.id GROUP BY 1 ORDER BY 1",
  "SELECT count(*) FROM cust c LEFT JOIN ord o ON c.id = o.customer_id WHERE o.id IS NULL",
];
/** the keys of the rows with a large value changed, the large value left as it is: the stream sends it unchanged */
const moveKeys = (to: number, mod: number): string => `UPDATE ord SET customer_id = ${uuid(String(to))} WHERE id % 50 = 0 AND id % 200 = ${mod}`;

test("the stream's update of a key right after a compaction numbers the key again: no number of the old key is left", { skip: skipStream }, async () => {
  const s = await started("compact", "replication", WINDOW, ["public.cust", "public.ord"], WINDOW_REFS, 1);
  try {
    await sameAnswers(s, WINDOW_JOINS, ["cust", "ord"], "after the first sync");
    // churned, then compacted, the numbering's turn held from before the compaction until after the update
    psql(s.url, "UPDATE ord SET n = n + 1 WHERE id % 2 = 0");
    await s.sync.caughtUp();
    await checkpoint(s.sync, s.store);
    const hold = holdNumbering(s.sync);
    const from = s.logged.length;
    await s.sync.checkCompaction();
    await until(() => s.logged.slice(from).some((l) => l.startsWith("compacted public.ord in ")), "ord compacted", s.logged);
    psql(s.url, `${moveKeys(5, 0)}; ${moveKeys(500, 50)}; UPDATE cust SET id = ${uuid("9999")} WHERE pk = 7`);
    await s.sync.caughtUp();
    await hold.release();
    psql(s.url, "UPDATE ord SET n = 0 WHERE id = 1");
    await s.sync.caughtUp();
    await until(() => (s.sync.schema().references ?? []).length === 1, "the reference numbered again", s.logged);
    await sameAnswers(s, WINDOW_JOINS, ["cust", "ord"], "after the update right after the compaction");
  } finally { await s.close(); }
});

test("the stream's update of a key right after a swap numbers the key again: no number of the old key is left", { skip: skipStream }, async () => {
  const s = await started("swap", "replication", WINDOW, ["public.cust", "public.ord"], WINDOW_REFS, 1);
  try {
    await sameAnswers(s, WINDOW_JOINS, ["cust", "ord"], "after the first sync");
    // a column added: ord synced again whole and swapped, the numbering's turn held from before the swap until after
    // the update
    psql(s.url, "ALTER TABLE ord ADD COLUMN extra int");
    const hold = holdNumbering(s.sync);
    const from = s.logged.length;
    s.sync.setTables(await tablesOf(s.source, ["public.cust", "public.ord"], WINDOW_REFS, "replication"));
    await s.sync.once();
    await until(() => s.logged.slice(from).some((l) => l.startsWith("synced public.ord:")), "ord synced again", s.logged);
    await s.sync.caughtUp();
    psql(s.url, `${moveKeys(5, 0)}; ${moveKeys(500, 50)}; UPDATE cust SET id = ${uuid("9999")} WHERE pk = 7`);
    await s.sync.caughtUp();
    await hold.release();
    psql(s.url, "UPDATE ord SET n = 0 WHERE id = 1");
    await s.sync.caughtUp();
    await until(() => (s.sync.schema().references ?? []).length === 1, "the reference numbered again", s.logged);
    await sameAnswers(s, WINDOW_JOINS, ["cust", "ord"], "after the update right after the swap");
  } finally { await s.close(); }
});

// A KEY'S TYPE CHANGED ON BOTH SIDES
const TYPED = `
CREATE TABLE up (pk serial PRIMARY KEY, id uuid, label text);
CREATE TABLE uc (id int PRIMARY KEY, pid uuid);
CREATE TABLE bp (pk serial PRIMARY KEY, id bigint, label text);
CREATE TABLE bc (id int PRIMARY KEY, pid bigint);
INSERT INTO up (id, label) SELECT ${uuid("i")}, 'u' || (i % 4) FROM generate_series(1, 60) i;
INSERT INTO uc SELECT i, ${uuid("1 + i % 60")} FROM generate_series(1, 60) i;
INSERT INTO bp (id, label) SELECT i * 1000003, 'b' || (i % 4) FROM generate_series(1, 60) i;
INSERT INTO bc SELECT i, (1 + i % 60) * 1000003 FROM generate_series(1, 60) i;
`;
const TYPED_TABLES = ["public.up", "public.uc", "public.bp", "public.bc"];
const TYPED_REFS: References = {
  "public.uc": [{ columns: ["pid"], table: "public.up", targetColumns: ["id"] }],
  "public.bc": [{ columns: ["pid"], table: "public.bp", targetColumns: ["id"] }],
};
const TYPED_JOINS = [
  "SELECT count(*) FROM uc c JOIN up p ON c.pid = p.id",
  "SELECT p.label, count(c.id) FROM up p LEFT JOIN uc c ON p.id = c.pid GROUP BY 1 ORDER BY 1",
  "SELECT count(*) FROM bc c JOIN bp p ON c.pid = p.id",
  "SELECT p.label, count(c.id) FROM bp p LEFT JOIN bc c ON p.id = c.pid GROUP BY 1 ORDER BY 1",
];
/** both sides' key made text: and values the old type would read as a key already there (another spelling of a UUID,
 *  of a number), with no value the old type cannot hold (`odd` false), or with one on each side (`odd` true) */
const RETYPE = (odd: boolean): string => "ALTER TABLE up ALTER COLUMN id TYPE text; ALTER TABLE uc ALTER COLUMN pid TYPE text; " +
  "ALTER TABLE bp ALTER COLUMN id TYPE text; ALTER TABLE bc ALTER COLUMN pid TYPE text; " +
  `INSERT INTO uc VALUES (101, upper(${uuid("43")}::text)), (102, '{' || ${uuid("4")}::text || '}'); ` +
  "INSERT INTO bc VALUES (101, '01000003'), (102, ' 2000006'), (103, '+3000009'); " +
  (odd ? "INSERT INTO uc VALUES (103, 'not a uuid'); INSERT INTO up (id, label) VALUES ('not a uuid', 'odd'); INSERT INTO bc VALUES (104, 'not a number'); INSERT INTO bp (id, label) VALUES ('not a number', 'odd')" : "");

for (const mode of ["poll", "replication"] as const) {
  const by = mode === "poll" ? "poll" : "stream";
  for (const odd of [false, true]) {
    test(odd
      ? `a key's type changed on both sides to text, with values no UUID or number, under the ${by}: the tables sync again, and each join answers as Postgres does`
      : `a key's type changed on both sides (uuid and bigint to text), under the ${by}: another spelling of a key never joins it, a dictionary of the new type numbers it`,
    { skip: mode === "poll" ? skip : skipStream }, async () => {
      const s = await started(`retype_${mode}_${odd ? "odd" : "spelled"}`, mode, TYPED, TYPED_TABLES, TYPED_REFS, 2);
      try {
        await sameAnswers(s, TYPED_JOINS, ["up", "uc", "bp", "bc"], "after the first sync");
        psql(s.url, RETYPE(odd));
        const from = s.logged.length;
        s.sync.setTables(await tablesOf(s.source, TYPED_TABLES, TYPED_REFS, mode));
        await s.sync.once();
        if (mode === "replication") await s.sync.caughtUp();
        for (const t of TYPED_TABLES) await until(() => s.logged.slice(from).some((l) => l.startsWith(`synced ${t}:`)), `${t} synced again`, s.logged);
        await until(() => (s.sync.schema().references ?? []).length === 2, "the references numbered again", s.logged);
        await sameAnswers(s, TYPED_JOINS, ["up", "uc", "bp", "bc"], "after the type change");
        // and a write after it, numbered by the same dictionary
        psql(s.url, `INSERT INTO uc VALUES (104, lower(${uuid("5")}::text)), (105, 'nor a uuid'); INSERT INTO bc VALUES (105, '4000012'), (106, '4000012 '), (107, 'nor a number')`);
        if (mode === "replication") await s.sync.caughtUp(); else await s.sync.pollNow(TYPED_TABLES);
        await sameAnswers(s, TYPED_JOINS, ["up", "uc", "bp", "bc"], "after a write after the type change");
      } finally { await s.close(); }
    });
  }
}
