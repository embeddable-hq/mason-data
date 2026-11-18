/**
 * A TIMESTAMPTZ'S 15-MINUTE BUCKET THROUGH EVERY WRITE (issue 1146, src/duck/bucket-column.ts): beside each timestamptz
 * column the copy holds the 15 minutes of UTC its value is in, NULL before 1980, from year 10000, for ±infinity and for
 * NULL. The first sync, the poll, the stream (a whole row, and an update that leaves a large value unchanged) and a
 * compaction each write it as the engine computes it from the value, and a GROUP BY of a unit of the time answers as
 * Postgres does in a zone of +5:45.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the stream's test, skipped otherwise), psql on PATH. It
 * writes only inside the databases it creates, `it_bucket_<random>_*`, and drops them at the end.
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
import { rewrite } from "../../src/duck/compact.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_bucket_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-bucket-"));

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

// the hidden column's name and value as src/duck/bucket-column.ts makes them, spelled here so the file loads at a commit
// without that module (scripts/fails-without.ts), where no copy holds one
const bucketColumn = (column: string): string => `__mason_bucket_${createHash("sha256").update(column).digest("hex").slice(0, 12)}`;
const bucketSql = (ts: string): string =>
  `CAST(CASE WHEN epoch_us(${ts}) >= 315532800000000 AND epoch_us(${ts}) < 253402300800000000 THEN epoch_us(${ts}) // 900000000 END AS INTEGER)`;

/** that every row of `table` (or its compaction's side table) holds each timestamptz's bucket as the engine computes it
 *  from the value, and that some row holds one */
async function bucketsHeld(store: DuckStore, table: string, what: string): Promise<void> {
  const cols = (await store.writer.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = '${table}'`)).getRowsJS().map((r) => String(r[0]));
  for (const c of ["at", "seen"]) {
    assert.ok(cols.includes(bucketColumn(c)), `${what}: ${table} holds ${c}'s bucket (its columns: ${cols.join(", ")})`);
    const [wrong, held] = (await store.writer.runAndReadAll(`SELECT count(*) FILTER (WHERE "${bucketColumn(c)}" IS DISTINCT FROM ${bucketSql(`"${c}"`)}), count("${bucketColumn(c)}") FROM public."${table}"`)).getRowsJS()[0]!.map(Number);
    assert.equal(wrong, 0, `${what}: every row of ${table} holds ${c}'s bucket`);
    assert.ok(held! > 0, `${what}: some row of ${table} holds ${c}'s bucket`);
  }
}

/** the Postgres API over the store, as `mason start` serves it, for the statements a test asks of both */
async function listen(store: DuckStore, sync: Sync, db: string): Promise<{ ask: (sql: string) => Promise<string>; close: () => Promise<void> }> {
  const server = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, null, undefined, () => sync.state(), sync.kept.enabled ? sync.kept : undefined) });
  const client = new pg.Client({ host: "127.0.0.1", port: server.port, database: db, user: "test", password: "x" });
  await client.connect();
  await client.query("SET TimeZone = 'Asia/Kathmandu'");
  return {
    ask: async (sql) => (await client.query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows
      .map((r: unknown[]) => r.map((x) => x === null ? "" : String(x)).join("\t")).join("\n").trimEnd(),
    close: async () => { await client.end(); await server.close(); },
  };
}
const inKathmandu = (url: string, sql: string): string => psql(url, `SET TimeZone = 'Asia/Kathmandu'; ${sql}`);

const ROWS = "SELECT g, timestamptz '2024-03-30 18:00+00' + g * interval '7 minutes 13 seconds', g % 7, NULL::text, CASE WHEN g % 5 = 0 THEN NULL ELSE timestamptz '2025-12-31 18:00+00' + g * interval '1 hour' END FROM generate_series(1, 400) g " +
  "UNION ALL VALUES (401, timestamptz '1979-12-31 23:59:59.999999+00', 1, NULL, NULL), (402, 'infinity', 2, NULL, timestamptz '-infinity'), (403, NULL, 3, NULL, timestamptz '1960-02-29 12:00+00'), (404, timestamptz '1980-01-01 00:00+00', 4, NULL, timestamptz '9999-12-31 23:59:59+00')";
const READS = [
  "SELECT date_trunc('month', at) AS m, count(*), sum(v) FROM e GROUP BY 1 ORDER BY 1",
  "SELECT date_trunc('hour', at) AS h, date_trunc('day', seen) AS d, count(*), min(v), max(v) FROM e GROUP BY 1, 2 ORDER BY 1, 2",
  "SELECT date_trunc('week', seen), count(*), avg(v) FROM e GROUP BY 1 ORDER BY 1",
  "SELECT * FROM e ORDER BY id LIMIT 5",
];

test("the first sync, the poll and a compaction hold each timestamptz's 15-minute bucket, and a GROUP BY of its unit answers as Postgres does", { skip }, async () => {
  const db = `${tag}_poll`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `CREATE TABLE e (id int PRIMARY KEY, at timestamptz, v int, big text, seen timestamptz); INSERT INTO e ${ROWS}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [E] = await tablesOf(parsed.source, ["public.e"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "poll.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  let api: Awaited<ReturnType<typeof listen>> | null = null;
  try {
    await sync.open();
    sync.setTables([E!]);
    await sync.once();
    await bucketsHeld(store, "e", "the first sync");
    api = await listen(store, sync, db);
    for (const sql of READS) assert.equal(await api.ask(sql), inKathmandu(url, sql), sql);
    // a poll: rows added, a time moved across a month, one set to NULL and one to before 1980, a row gone
    psql(url, "INSERT INTO e (id, at, v, seen) VALUES (500, '2024-05-31 18:14:59.999999+00', 5, now()), (501, '2024-05-31 18:15:00+00', 6, NULL); " +
      "UPDATE e SET at = at + interval '40 days' WHERE id % 9 = 0; UPDATE e SET at = NULL WHERE id = 2; UPDATE e SET seen = '1975-01-01 00:00+00' WHERE id = 3; DELETE FROM e WHERE id = 4");
    await sync.pollNow(["public.e"]);
    await bucketsHeld(store, "e", "the poll");
    for (const sql of READS) assert.equal(await api.ask(sql), inKathmandu(url, sql), `${sql}, after a poll`);
    // a compaction's rewrite: the side table it swaps in holds the same buckets (src/duck/compact.ts)
    await rewrite(store.writer, "public", "e", 1_000);
    await bucketsHeld(store, "e__mason_compact", "a compaction");
  } finally {
    await api?.close();
    await sync.stop();
    await store.close();
  }
});

test("the stream writes each timestamptz's 15-minute bucket: a whole row, and an update that leaves a large value unchanged", { skip: skip || (!logical && "the test server's wal_level is not logical") }, async () => {
  const db = `${tag}_stream`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  // `big` is stored out of line and uncompressed: an UPDATE of `at` alone sends it as unchanged TOAST
  psql(url, `CREATE TABLE e (id int PRIMARY KEY, at timestamptz, v int, big text, seen timestamptz); ALTER TABLE e ALTER COLUMN big SET STORAGE EXTERNAL; INSERT INTO e ${ROWS}; ` +
    "UPDATE e SET big = repeat(md5(id::text), 200)");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [E] = await tablesOf(parsed.source, ["public.e"]);
  const names = { slot: `${tag}_s`, publication: `${tag}_s`, owned: true };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "stream.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names);
  try {
    await sync.open();
    sync.setTables([E!]);
    await sync.once();
    await bucketsHeld(store, "e", "the first sync");
    // whole rows inserted and updated, and updates of the times alone (the large value unchanged)
    psql(url, "INSERT INTO e (id, at, v, big, seen) VALUES (600, '2024-06-30 18:15:00+00', 1, 'x', '2024-06-30 18:14:59.999999+00'); UPDATE e SET v = v + 1, big = 'y', at = at + interval '1 day' WHERE id = 10; " +
      "UPDATE e SET at = at + interval '33 days', seen = '1970-01-01 00:00+00' WHERE id % 7 = 0; UPDATE e SET at = 'infinity' WHERE id = 12");
    await sync.caughtUp();
    await bucketsHeld(store, "e", `the stream\n${logged.slice(-8).join("\n")}`);
    const api = await listen(store, sync, db);
    try { for (const sql of READS) assert.equal(await api.ask(sql), inKathmandu(url, sql), sql); } finally { await api.close(); }
  } finally {
    await sync.stop();
    await store.close();
  }
});
