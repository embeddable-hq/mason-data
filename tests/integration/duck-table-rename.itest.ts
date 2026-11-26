/**
 * A TABLE RENAMED ON THE DATABASE WHILE ITS FIRST SYNC RUNS (issue 1199), against a real Postgres, at the sync's own level,
 * polled and streamed. The first sync's next chunk read a name that was no table: it failed with the engine's "does not
 * exist" and backed off as a failure, at least 5 minutes, so a table renamed back waited that long, said as failed. Now
 * the table is held while it is away, said on its line with where it is, and its first sync goes on from where it was
 * once it is back, every change made meanwhile in it.
 *
 * The run's own re-read of the columns (src/cli/dev.ts `onColumnsChanged`) is played by the test, as in
 * duck-columns-change.itest.ts: it is what makes the sync check a table's name and columns before it reads. The copy is
 * held by the test (`heldCopy`), so the rename lands between two of its chunks by construction, never by its size.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the streamed test), psql on PATH, and DuckDB's postgres
 * extension. It writes only inside databases it creates, `it_trename_<random>_*`, and drops them and its slots at the end.
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
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const tag = `it_trename_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-trename-"));
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  // a database with a slot on it cannot be dropped: the slots first (each test's sync is stopped by then)
  if (logical) psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
/** psql without blocking this process: the RENAME waits for the lock the held chunk's read holds until it commits */
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
  throw new Error("the RENAME never waited on the held chunk's lock");
}
async function until(what: string, ok: () => Promise<boolean> | boolean, logged: string[], ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`waited ${ms / 1000} s for ${what}:\n${logged.slice(-30).join("\n")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The tables as the run reads them: the catalog by the run's own reader, each an entry of every column. */
async function tablesOf(source: Source, names: readonly string[], sync: SourceFile["sync"]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const catalog = await readTables(c.pg);
    const file: SourceFile = { name: "app", file: path.join(dir, "app.yml"), kind: "postgres", url: { env: "DATABASE_URL" }, database: null, sync, publication: null,
      tables: names.map((n) => ({ name: n, table: `public.${n}`, columns: null, exclude: [], key: null, sync: null })) };
    const added = addedTables(file, catalog, source.database, dir);
    if (!Array.isArray(added)) throw new Error(`${added.message}: ${added.why ?? ""}`);
    return added;
  } finally { c.pg.close(); }
}

async function renamedDuringFirstSync(mode: "poll" | "replication"): Promise<void> {
  const db = `${tag}_${mode}`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, "CREATE TABLE first (id int PRIMARY KEY, v text); INSERT INTO first SELECT g, 'v' || g FROM generate_series(1, 200000) g; ANALYZE first");
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const source = parsed.source;
  const syncOf: SourceFile["sync"] = mode === "poll" ? { mode: "poll", every: "1s", seconds: 1 } : { mode: "replication" };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, `${mode}.db`), (l) => logged.push(l));
  const held = heldCopy("public.first");
  let sync: Sync | null = null;
  const onColumnsChanged = async (): Promise<void> => { await sync!.setTables(await tablesOf(source, ["first"], syncOf)); };
  sync = new Sync(store, source, source.database, (l) => { logged.push(l); if (process.env.IT_DEBUG) console.error(`${new Date().toISOString()} ${l.slice(0, 300)}`); }, 3_600_000, mode,
    mode === "replication" ? { slot: db, publication: db, owned: true } : null, { copyChunkRows: 2_000, copyParallel: 1, onChunk: held.onChunk, onColumnsChanged, awayRecheckMs: 1_000 });
  // a connection of the test's own: a read on the writer's would land inside whatever transaction a writer's turn has open there (a swap's), and fail it
  const reader = await store.instance.connect();
  const line = (): string => sync!.state().find((s) => s.source === "public.first")?.error ?? "";
  const served = async (): Promise<string> => {
    try { return JSON.stringify((await reader.runAndReadAll("SELECT count(*), sum(id), max(v) FILTER (WHERE id > 200000) FROM public.first")).getRowsJS()[0]!.map(String)); }
    catch (e) { if (e instanceof Error) return e.message; throw e; }
  };
  const sourceNow = (): string => JSON.stringify(psql(url, "SELECT count(*), sum(id), max(v) FILTER (WHERE id > 200000) FROM first").split("\t"));
  try {
    await sync.open();
    await sync.setTables(await tablesOf(source, ["first"], syncOf));
    sync.start();
    await until("the first sync held in its chunks", held.held, logged);
    // renamed between two chunks, and written to while away
    const renamed = psqlLater(url, "ALTER TABLE first RENAME TO first_away; INSERT INTO first_away VALUES (200001, 'while away'); UPDATE first_away SET v = 'updated away' WHERE id = 7; DELETE FROM first_away WHERE id = 9");
    await waitingOnLock(url);
    held.release();
    await renamed;
    await until("the table held, said on its line", () => /^public\.first is not synced: it was renamed on the database, and is public\.first_away now\. Its first sync waits\. Once it is public\.first again, Mason goes on with its first sync from where it was\. /.test(line()), logged);
    assert.ok(!logged.some((l) => l.startsWith("sync of public.first failed")), `held, never failed and backed off:\n${logged.join("\n")}`);
    // back under its name: the first sync goes on, and holds every change made while it was away
    psql(url, "ALTER TABLE first_away RENAME TO first; INSERT INTO first VALUES (200002, 'after it was back')");
    // (its first sync is done once a query can read it: `copied` only then)
    await until("synced, every change in it", async () => await served() === sourceNow() && line() === "" && sync!.state().find((s) => s.source === "public.first")?.phase === "copied", logged);
    assert.equal(String((await reader.runAndReadAll("SELECT v FROM public.first WHERE id = 7")).getRowsJS()[0]?.[0]), "updated away");
    assert.equal((await reader.runAndReadAll("SELECT count(*) FROM public.first WHERE id = 9")).getRowsJS()[0]?.[0], 0n);
  } finally { held.release(); reader.closeSync(); await sync.stop(); await store.close(); }
}

test("a table renamed while its first sync is polled: held and said while it is away, never failed and backed off, and synced with every change once it is back", { skip, timeout: 600_000 }, () => renamedDuringFirstSync("poll"));
test("a table renamed while its first sync is streamed: held and said while it is away, never failed and backed off, and synced with every change once it is back", { skip: skip || (!logical && "IT_POSTGRES_URL's server has no wal_level = logical"), timeout: 600_000 }, () => renamedDuringFirstSync("replication"));
