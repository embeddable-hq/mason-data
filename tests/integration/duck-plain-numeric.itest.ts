/**
 * A PLAIN NUMERIC'S OWN SCALE THROUGH EVERY WRITE (issue 946, src/duck/scale-column.ts): a column declared `numeric` with
 * no precision (Rails' `t.decimal`) is synced as DECIMAL(38, s), its values' own scales held in a hidden column beside
 * it. The copy, the poll, the stream (a whole row and an update that leaves a large value unchanged) and the copy again
 * after a wider value each write each value's scale as Postgres holds it (`scale(u)`), and the Postgres API prints each
 * value as Postgres does (`12.5`, never `12.50`). A copy an older Mason made, with no hidden column, is read again once,
 * and then answers right; a second start reads nothing again.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the stream's test, skipped otherwise), psql on PATH. It
 * writes only inside the databases it creates, `it_scale_<random>_*`, and drops them at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_scale_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-scale-"));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const logical = adminUrl !== undefined && psql(adminUrl, "SHOW wal_level") === "logical";
const skip = adminUrl === undefined ? "IT_POSTGRES_URL is not set" : false;

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

/** the source's tables as `mason start` reads them, by name */
async function tablesOf(source: Source, names: readonly string[]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return names.map((n) => { const t = facts.tables.find((x) => x.source === n); if (!t) throw new Error(`no table ${n}`); return t; });
  } finally { c.pg.close(); }
}

/** the hidden scale column's name, read from the copy (the one column of its kind the table holds) */
async function hiddenOf(store: DuckStore, table: string, own: readonly string[] = []): Promise<string | null> {
  const r = (await store.writer.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = '${table}' AND starts_with(column_name, '__mason_scale_')`)).getRowsJS()
    .map((x) => String(x[0])).filter((c) => !own.includes(c));
  return r.length === 0 ? null : r[0]!;
}

/** the name a hidden scale column of `column` takes first (src/duck/scale-column.ts), spelled here so the file loads at
 *  a commit without that module (scripts/fails-without.ts) */
const firstScaleName = (column: string): string => `__mason_scale_${createHash("sha256").update(column).digest("hex").slice(0, 12)}`;

/** each row's id and the scale the copy holds for its `u`, as psql prints them */
async function scalesOf(store: DuckStore, table: string): Promise<string> {
  const hidden = await hiddenOf(store, table);
  assert.ok(hidden !== null, `${table} holds a hidden scale column`);
  return ((await store.writer.runAndReadAll(`SELECT id, "${hidden}" FROM public.${table} ORDER BY id`)).getRowsJS() as unknown[][])
    .map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd();
}

/** the Postgres API over the store, as `mason start` serves it, for the statements a test asks of both */
async function listen(store: DuckStore, sync: Sync, db: string): Promise<{ ask: (sql: string) => Promise<string>; close: () => Promise<void> }> {
  const server = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, null, undefined, () => sync.state(), sync.kept.enabled ? sync.kept : undefined) });
  const client = new pg.Client({ host: "127.0.0.1", port: server.port, database: db, user: "test", password: "x" });
  await client.connect();
  return {
    ask: async (sql) => (await client.query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows
      .map((r: unknown[]) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd(),
    close: async () => { await client.end(); await server.close(); },
  };
}

const MIXED = "(1, 0), (2, 12.5), (3, 12.49), (4, -12.5), (5, 0.01), (6, 9999999999.99), (7, 7.77), (8, 0.30), (9, 12.50), (10, NULL)";
const READS = [
  "SELECT id, u FROM p ORDER BY id",
  "SELECT id, u::text FROM p ORDER BY id",
  "SELECT * FROM p ORDER BY id",
  "SELECT id % 3, sum(u), min(u), max(u) FROM p GROUP BY 1 ORDER BY 1",
  "SELECT u, count(*) FROM p GROUP BY u ORDER BY u",
  "SELECT id, u + 1, u * 2, -u, abs(u), coalesce(u, 0) FROM p ORDER BY id",
];

test("the copy, the poll and a copy made again wider keep each plain numeric value's own scale, and the API prints it", { skip }, async () => {
  const db = `${tag}_poll`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE p (id int PRIMARY KEY, u numeric); INSERT INTO p VALUES ${MIXED}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [P] = await tablesOf(parsed.source, ["public.p"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "poll.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  let api: Awaited<ReturnType<typeof listen>> | null = null;
  const scales = "SELECT id, scale(u) FROM p ORDER BY id";
  try {
    await sync.open();
    sync.setTables([P!]);
    await sync.once();
    assert.equal(await scalesOf(store, "p"), psql(url, scales), "the copy holds each value's scale");
    api = await listen(store, sync, db);
    for (const sql of READS) assert.equal(await api.ask(sql), psql(url, sql), sql);
    // a poll: new values of scales within the copy's, a value updated to another scale, a value set to NULL
    psql(url, "INSERT INTO p VALUES (11, 3), (12, 0.5); UPDATE p SET u = 1.00 WHERE id = 2; UPDATE p SET u = NULL WHERE id = 3");
    await sync.pollNow(["public.p"]);
    assert.equal(await scalesOf(store, "p"), psql(url, scales), "the poll writes each value's scale");
    for (const sql of READS) assert.equal(await api.ask(sql), psql(url, sql), `${sql}, after a poll`);
    // a value with more decimals than the copy holds: the table is copied again, wider, every scale kept
    psql(url, "INSERT INTO p VALUES (13, 1.125)");
    await assert.rejects(sync.pollNow(["public.p"]), /wider than its synced DECIMAL column/);
    await sync.once();
    assert.equal(await scalesOf(store, "p"), psql(url, scales), "a copy made again wider keeps each value's scale");
    for (const sql of READS) assert.equal(await api.ask(sql), psql(url, sql), `${sql}, after a wider copy`);
  } finally {
    await api?.close();
    await sync.stop();
    await store.close();
  }
});

test("a copy an older Mason made, with no value's own scale, is read again once, then answers right", { skip }, async () => {
  const db = `${tag}_old`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE p (id int PRIMARY KEY, u numeric); INSERT INTO p VALUES ${MIXED}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [P] = await tablesOf(parsed.source, ["public.p"]);
  const logged: string[] = [];
  const file = path.join(dir, "old.db");
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    sync.setTables([P!]);
    await sync.once();
    // the older Mason's copy: the same table with no hidden column
    const hidden = await hiddenOf(store, "p");
    assert.ok(hidden !== null);
    await store.writer.run(`ALTER TABLE public.p DROP COLUMN "${hidden}"`);
    await sync.stop();
    await store.close();
    store = await DuckStore.open(file, (l) => logged.push(l));
    sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
    let before = logged.length;
    await sync.open();
    sync.setTables([P!]);
    assert.ok(logged.slice(before).some((l) => l.includes("without each numeric value's own decimals")), `the old copy is said:\n${logged.slice(before).join("\n")}`);
    await sync.once();
    assert.equal(await scalesOf(store, "p"), psql(url, "SELECT id, scale(u) FROM p ORDER BY id"), "read again, it holds each value's scale");
    assert.ok(logged.slice(before).some((l) => /^synced public\.p\b/.test(l)), `it is read again:\n${logged.slice(before).join("\n")}`);
    const api = await listen(store, sync, db);
    try { for (const sql of READS) assert.equal(await api.ask(sql), psql(url, sql), sql); } finally { await api.close(); }
    // a second start: nothing is read again
    await sync.stop();
    await store.close();
    store = await DuckStore.open(file, (l) => logged.push(l));
    sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
    before = logged.length;
    await sync.open();
    sync.setTables([P!]);
    await sync.once();
    assert.ok(!logged.slice(before).some((l) => l.includes("own decimals") || /^synced public\.p\b/.test(l)), `nothing is read again:\n${logged.slice(before).join("\n")}`);
  } finally {
    await sync.stop();
    await store.close();
  }
});

test("the stream writes each plain numeric value's own scale: a whole row, and an update that leaves a large value unchanged", { skip: skip || (!logical && "the test server's wal_level is not logical") }, async () => {
  const db = `${tag}_stream`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  // `big` is stored out of line and uncompressed: an UPDATE of `u` alone sends it as unchanged TOAST
  psql(url, `CREATE TABLE p (id int PRIMARY KEY, u numeric, big text); ALTER TABLE p ALTER COLUMN big SET STORAGE EXTERNAL; INSERT INTO p (id, u) VALUES ${MIXED}; ` +
    "UPDATE p SET big = repeat(md5(id::text), 200)");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [P] = await tablesOf(parsed.source, ["public.p"]);
  const names = { slot: `${tag}_s`, publication: `${tag}_s`, owned: true };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "stream.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names);
  const scales = "SELECT id, scale(u) FROM p ORDER BY id";
  try {
    await sync.open();
    sync.setTables([P!]);
    await sync.once();
    assert.equal(await scalesOf(store, "p"), psql(url, scales), "the copy holds each value's scale");
    psql(url, "INSERT INTO p (id, u) VALUES (11, 3), (12, 0.5); UPDATE p SET u = 1.00 WHERE id = 2; UPDATE p SET u = NULL WHERE id = 3; UPDATE p SET u = 7 WHERE id = 7");
    await sync.caughtUp();
    assert.equal(await scalesOf(store, "p"), psql(url, scales), `the stream writes each value's scale\n${logged.slice(-8).join("\n")}`);
    const api = await listen(store, sync, db);
    try { for (const sql of READS) assert.equal(await api.ask(sql), psql(url, sql), sql); } finally { await api.close(); }
  } finally {
    await sync.stop();
    await store.close();
  }
});

test("a source column named as a plain numeric's hidden column would be: the table syncs, its own column listed and the scale held beside", { skip }, async () => {
  const db = `${tag}_clash`, url = urlOf(db);
  const clash = firstScaleName("u");
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE p (id int PRIMARY KEY, u numeric, "${clash}" int); INSERT INTO p (id, u) VALUES ${MIXED}; UPDATE p SET "${clash}" = id * 10`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [P] = await tablesOf(parsed.source, ["public.p"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "clash.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    sync.setTables([P!]);
    await sync.once();
    assert.deepEqual(sync.state().map((x) => [x.source, x.phase, x.error]), [["public.p", "copied", null]], logged.slice(-6).join("\n"));
    const hidden = await hiddenOf(store, "p", [clash]);
    assert.ok(hidden !== null && hidden !== clash, "the hidden column takes another name");
    assert.equal(((await store.writer.runAndReadAll(`SELECT id, "${hidden}" FROM public.p ORDER BY id`)).getRowsJS() as unknown[][])
      .map((r) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd(), psql(url, "SELECT id, scale(u) FROM p ORDER BY id"));
    const api = await listen(store, sync, db);
    try {
      for (const sql of ["SELECT * FROM p ORDER BY id", "SELECT id, u, u::text FROM p ORDER BY id", `SELECT id, "${clash}" FROM p ORDER BY id`]) assert.equal(await api.ask(sql), psql(url, sql), sql);
    } finally { await api.close(); }
  } finally {
    await sync.stop();
    await store.close();
  }
});
