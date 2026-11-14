/**
 * A TABLE'S COLUMNS CHANGED ON THE DATABASE WHILE ITS WHOLE READ RUNS (issue 977), against a real Postgres, at the sync's
 * own level: a whole read that fails because a column it names is gone checks the table's columns again and re-plans,
 * never retrying the same columns for ever.
 *
 * - A column added starts a whole read again with it; the column is dropped again while that read is held in its
 *   chunks, and a row changed. The read fails on the column gone, the columns are read again (they are the copy's again),
 *   and the table is polled again: the changed row arrives, and the read is not tried again and again.
 * - A column renamed while the table's FIRST sync is held in its chunks: the first sync fails on the old name, the
 *   columns are read again, and the table is synced with the new name.
 *
 * The run's own re-read of the columns (src/cli/dev.ts `onColumnsChanged`: the table's catalog read again, the sources
 * file read against it) is played by the test: the catalog read with the run's own reader (`readTables`), each table an
 * entry of every column (`addedTables`). The copy is held by the test (`heldCopy`), so "while it runs" holds by
 * construction, never by its size.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, and DuckDB's postgres extension. It writes only inside
 * databases it creates, `it_cols_<random>_*`, and drops them at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readTables, type Source } from "../../src/cli/preflight.ts";
import { addedTables, type SourceFile } from "../../src/cli/sources.ts";
import { heldCopy } from "./held-copy.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";
const tag = `it_cols_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-cols-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
/** psql without blocking this process: an ALTER waits for the lock the held chunk's read holds until it commits, and
 *  the chunk is released by this process (each later chunk's read queues behind the ALTER, so it lands between two) */
function psqlLater(url: string, sql: string): Promise<void> {
  const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
  return new Promise((resolve, reject) => child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`psql: ${err.trim()}\n  in: ${sql}`))));
}
/** until the database says a statement of `url`'s database waits on a lock */
async function waitingOnLock(url: string): Promise<void> {
  const db = new URL(url).pathname.slice(1);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    if (psql(adminUrl!, `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}' AND wait_event_type = 'Lock'`) !== "0") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the ALTER never waited on the held chunk's lock");
}
/** a database of its own for one test, dropped after it */
function ownDatabase(suffix: string, sql: string): { source: Source; url: string } {
  const db = `${tag}_${suffix}`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  psql(url, sql);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return { source: parsed.source, url };
}
async function until(what: string, ok: () => Promise<boolean> | boolean, logged: string[], ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`waited ${ms / 1000} s for ${what}:\n${logged.slice(-30).join("\n")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The tables as the run reads them: the catalog by the run's own reader, each an entry of every column, polled each second. */
async function tablesOf(source: Source, names: readonly string[]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const catalog = await readTables(c.pg);
    const file: SourceFile = { name: "app", file: path.join(dir, "app.yml"), kind: "postgres", url: { env: "DATABASE_URL" }, database: null,
      sync: { mode: "poll", every: "1s", seconds: 1 }, publication: null,
      tables: names.map((n) => ({ name: n, table: `public.${n}`, columns: null, exclude: [], key: null, sync: null })) };
    const added = addedTables(file, catalog, source.database, dir);
    if (!Array.isArray(added)) throw new Error(`${added.message}: ${added.why ?? ""}`);
    return added;
  } finally { c.pg.close(); }
}

test("a column dropped while its table's whole read again runs: the read fails once, the columns are read again, and the table is polled again", { skip, timeout: 600_000 }, async () => {
  const { source, url } = ownDatabase("resync", "CREATE TABLE big (id int PRIMARY KEY, a text, b int); INSERT INTO big SELECT g, 'a' || g, g FROM generate_series(1, 200000) g; ANALYZE big");
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "resync.db"), (l) => logged.push(l));
  const held = heldCopy("public.big", false);
  let reads = 0;
  // the run's own re-read: the table's catalog, the sources file read against it, the tables set again
  let sync: Sync | null = null;
  const onColumnsChanged = async (): Promise<void> => { reads++; await sync!.setTables(await tablesOf(source, ["big"])); };
  sync = new Sync(store, source, source.database, (l) => { logged.push(l); if (process.env.IT_DEBUG) console.error(`${new Date().toISOString()} ${l.slice(0, 300)}`); }, 3_600_000, "poll", null, { copyChunkRows: 2_000, copyParallel: 1, onChunk: held.onChunk, onColumnsChanged });
  const b10 = async (): Promise<string> => String((await store.writer.runAndReadAll("SELECT b FROM public.big WHERE id = 10")).getRowsJS()[0]?.[0]);
  const failures = (): number => logged.filter((l) => l.startsWith("sync of public.big failed")).length;
  try {
    await sync.open();
    await sync.setTables(await tablesOf(source, ["big"]));
    sync.start();
    await until("big synced", async () => { await sync!.once(); return await b10() === "10"; }, logged);

    // a column added: the next poll sees it, and the table is read again whole with it — held in its first chunk
    held.hold();
    psql(url, "ALTER TABLE big ADD COLUMN c int DEFAULT 7");
    // the poll each second sees it (never once(), which waits for the rebuild it would hold)
    await until("the whole read again with c held in its chunks", held.held, logged);
    // dropped again while that read runs, and a row changed
    const altered = psqlLater(url, "ALTER TABLE big DROP COLUMN c; UPDATE big SET b = -5 WHERE id = 10");
    await waitingOnLock(url);
    held.release();
    await altered;
    await until("the changed row served", async () => { await sync!.once(); return await b10() === "-5"; }, logged);
    assert.equal(failures(), 1, `the read with c failed once, never again with the same columns:\n${logged.join("\n")}`);
    assert.ok(logged.some((l) => /^public\.big: its columns changed on the database \(c gone\)/.test(l)), logged.join("\n"));
    assert.equal(reads, 2, "the columns read again twice: c added, c gone");
    const cols = [...(await store.writer.runAndReadAll("SELECT * FROM public.big LIMIT 1")).columnNames];
    assert.deepEqual(cols, ["id", "a", "b"]);
    assert.equal(sync.state().find((s) => s.source === "public.big")?.error, null, "its failure is over");
  } finally { held.release(); await sync.stop(); await store.close(); }
});

test("a column renamed while its table's FIRST sync runs: the sync fails once, the columns are read again, and it is synced with the new name", { skip, timeout: 600_000 }, async () => {
  const { source, url } = ownDatabase("first", "CREATE TABLE first (id int PRIMARY KEY, a text, b int); INSERT INTO first SELECT g, 'a' || g, g FROM generate_series(1, 200000) g; ANALYZE first");
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "first.db"), (l) => logged.push(l));
  const held = heldCopy("public.first");
  let sync: Sync | null = null;
  const onColumnsChanged = async (): Promise<void> => { await sync!.setTables(await tablesOf(source, ["first"])); };
  sync = new Sync(store, source, source.database, (l) => { logged.push(l); if (process.env.IT_DEBUG) console.error(`${new Date().toISOString()} ${l.slice(0, 300)}`); }, 3_600_000, "poll", null, { copyChunkRows: 2_000, copyParallel: 1, onChunk: held.onChunk, onColumnsChanged });
  try {
    await sync.open();
    await sync.setTables(await tablesOf(source, ["first"]));
    sync.start();
    await until("the first sync held in its chunks", held.held, logged);
    const altered = psqlLater(url, "ALTER TABLE first RENAME COLUMN a TO a2");
    await waitingOnLock(url);
    held.release();
    await altered;
    const served = async (): Promise<string> => {
      try { return JSON.stringify((await store.writer.runAndReadAll("SELECT count(*), count(a2) FROM public.first")).getRowsJS()[0]!.map(String)); }
      catch (e) { if (e instanceof Error) return e.message; throw e; }
    };
    await until("synced with a2", async () => { await sync!.once(); return await served() === JSON.stringify(["200000", "200000"]); }, logged);
    assert.equal(logged.filter((l) => l.startsWith("sync of public.first failed")).length, 1, logged.join("\n"));
    assert.equal(sync.state().find((s) => s.source === "public.first")?.phase, "copied");
  } finally { held.release(); await sync.stop(); await store.close(); }
});
