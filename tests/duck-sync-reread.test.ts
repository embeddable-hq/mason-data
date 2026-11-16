/**
 * WHICH SYNCED TABLES A NEWER RELEASE'S FIRST START READS AGAIN WHOLE, SAID BEFORE THE UPGRADE (issue 1069; src/duck/
 * reread.ts, src/cli/upgrade.ts). A store an older Mason left, one table at each layout or ledger state a start's checks
 * read — each check's input changed on one table: its stored type, its constraint, its hidden scale column, a column it
 * lacks, its watermark, its columns on the source, its table itself. What a running Mason publishes of it
 * (`/api/state?storage=1`), read by `mason upgrade --check`, must name exactly the tables a real start of this release
 * then reads again (`needsCopy`), for the same reasons. Offline: a real Sync over a seeded DuckDB file, stopped before
 * its tables are set, and the command against a run server that answers with those facts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore, MASON_SCHEMA } from "../src/duck/store.ts";
import { Sync, type AddedTable } from "../src/duck/sync.ts";
import type { Source, SourceColumnInfo } from "../src/cli/preflight.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

/** the module the start and the command both call, read by name so this file loads where it is not (scripts/fails-without.ts) */
type Reread = typeof import("../src/duck/reread.ts");
async function rereadModule(): Promise<Reread | null> {
  try { return await import("../src/duck/reread.ts"); }
  catch (e) {
    // absent before issue 1069: the test fails by its assertion, never by the file failing to load
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return null;
    throw e;
  }
}

const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;
const col = (name: string, type: string, typeKind?: string, attnum?: number): SourceColumnInfo => ({ name, type, notNull: false, comment: null, ...(typeKind !== undefined ? { typeKind } : {}), ...(attnum !== undefined ? { attnum } : {}) });
const table = (name: string, columns: SourceColumnInfo[]): AddedTable => ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], columns, foreignKeys: [], bytes: 4096, rows: 3 });

/** each table: as an older Mason left it (its synced table, its record, its ledger), and its columns as the source has them now */
const CASES: Array<{ name: string; ddl: string | null; record: SourceColumnInfo[]; now: SourceColumnInfo[]; phase?: string; watermark?: boolean; added?: boolean }> = [
  // as this release keeps it: not read again
  { name: "fine", ddl: "CREATE TABLE public.fine (id INTEGER, v VARCHAR)", record: [col("id", "integer", "b"), col("v", "text", "b")], now: [col("id", "integer", "b"), col("v", "text", "b")] },
  // an enum recorded without its kind: completed from its stored ENUM, so not read again for nothing
  { name: "mood", ddl: "CREATE TABLE public.mood (id INTEGER, m ENUM('a', 'b'))", record: [col("id", "integer"), col("m", "mood")], now: [col("id", "integer", "b"), col("m", "mood", "e")] },
  // a point stored as the extension's STRUCT (HELD_LAYOUT)
  { name: "held", ddl: "CREATE TABLE public.held (id INTEGER, pt STRUCT(x DOUBLE, y DOUBLE))", record: [col("id", "integer"), col("pt", "point")], now: [col("id", "integer", "b"), col("pt", "point", "b")] },
  // sorted by its key with the key's index (RETIRED_LAYOUT)
  { name: "keyed", ddl: "CREATE TABLE public.keyed (id INTEGER PRIMARY KEY, v VARCHAR)", record: [col("id", "integer", "b"), col("v", "text", "b")], now: [col("id", "integer", "b"), col("v", "text", "b")] },
  // a plain numeric with no hidden scale column beside it (SCALE_LAYOUT)
  { name: "unscaled", ddl: "CREATE TABLE public.unscaled (id INTEGER, n DECIMAL(38,2))", record: [col("id", "integer", "b"), col("n", "numeric", "b")], now: [col("id", "integer", "b"), col("n", "numeric", "b")] },
  // a column its record syncs, which an older Mason dropped (MISSING_LAYOUT)
  { name: "lacking", ddl: "CREATE TABLE public.lacking (id INTEGER)", record: [col("id", "integer", "b"), col("lost", "text", "b")], now: [col("id", "integer", "b"), col("lost", "text", "b")] },
  // no watermark
  { name: "unmarked", ddl: "CREATE TABLE public.unmarked (id INTEGER)", record: [col("id", "integer", "b")], now: [col("id", "integer", "b")], watermark: false },
  // its columns' key: the source's type now is not the one it was synced with
  { name: "widened", ddl: "CREATE TABLE public.widened (id INTEGER, v INTEGER)", record: [col("id", "integer", "b"), col("v", "integer", "b")], now: [col("id", "integer", "b"), col("v", "bigint", "b")] },
  // recorded as synced, with no table under it: forgotten and synced anew, not served meanwhile
  { name: "vanished", ddl: null, record: [col("id", "integer", "b")], now: [col("id", "integer", "b")] },
  // a first sync not done: not read AGAIN, so not listed
  { name: "pending", ddl: null, record: [col("id", "integer", "b")], now: [col("id", "integer", "b")], phase: "copying", watermark: false },
  // A RECORD WRITTEN BEFORE COLUMNS HAD NUMBERS (issue 1073), its names and types the source's now: it takes the numbers
  // from its table as the start places the columns, and is not read again
  { name: "prenum", ddl: "CREATE TABLE public.prenum (id INTEGER, v VARCHAR)", record: [col("id", "integer", "b"), col("v", "text", "b")], now: [col("id", "integer", "b", 1), col("v", "text", "b", 2)] },
  // the same, with a type changed on the source: its columns differ, so it is read again
  { name: "prenumtype", ddl: "CREATE TABLE public.prenumtype (id INTEGER, v INTEGER)", record: [col("id", "integer", "b"), col("v", "integer", "b")], now: [col("id", "integer", "b", 1), col("v", "bigint", "b", 2)] },
  // in the ledger and no longer added: dropped at the start, not listed
  { name: "removed", ddl: "CREATE TABLE public.removed (id INTEGER PRIMARY KEY)", record: [col("id", "integer", "b")], now: [col("id", "integer", "b")], added: false },
];

/** what the command must say of each table read again: its stable reason and whether it serves its synced data */
const EXPECTED: Record<string, { why: string; serves: boolean }> = {
  held: { why: "layout", serves: true }, keyed: { why: "layout", serves: true }, unscaled: { why: "layout", serves: true }, lacking: { why: "layout", serves: true },
  unmarked: { why: "watermark", serves: true }, widened: { why: "columns", serves: true }, vanished: { why: "missing", serves: false },
  prenumtype: { why: "columns", serves: true },
};

test("mason upgrade --check names exactly the synced tables this release's start then reads again whole, why, their size, and whether each serves meanwhile (issue 1069)", async () => {
  const reread = await rereadModule();
  assert.ok(reread !== null, "src/duck/reread.ts: the one module the start and mason upgrade --check call");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-reread-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "256MB" });
  let server: http.Server | null = null;
  try {
    const added = CASES.filter((c) => c.added !== false).map((c) => table(c.name, c.now));
    const opened = async (): Promise<Sync> => {
      const sync = new Sync(store, source, "x", () => undefined, 5_000, "poll", null);
      await sync.open();
      await sync.stop();
      await sync.setTables(added);
      return sync;
    };
    // the ledger's tables, as any start makes them; then the store as an older Mason left it
    await (await opened()).stop();
    const w = (sql: string) => store.writer.run(sql);
    for (const c of CASES) {
      if (c.ddl !== null) await w(c.ddl);
      await w(`INSERT INTO ${MASON_SCHEMA}.copy_state (source, phase, "rows", bytes, seconds, copied_at, error, columns) VALUES ('public.${c.name}', '${c.phase ?? "copied"}', 3, 4096, 0.1, now(), NULL, '${JSON.stringify(c.record)}')`);
      if (c.watermark !== false) await w(`INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at) VALUES ('public.${c.name}', '100:100:', now())`);
    }

    // WHAT THE RUNNING MASON PUBLISHES (`/api/state?storage=1`): its own reader's facts, in one transaction, and its tables
    const running = new Sync(store, source, "x", () => undefined, 5_000, "poll", null);
    (running as unknown as { tables: Map<string, AddedTable> }).tables = new Map(added.map((t) => [t.source, t]));
    // a table the run holds for its columns (src/duck/column-identity.ts): listed, and said held — read again once let go
    (running as unknown as { unplaced: Map<string, string> }).unplaced.set("public.keyed", "held for its columns");
    const published = await (running as unknown as { storedFacts: () => Promise<unknown> }).storedFacts();
    assert.deepEqual(published, { format: 1, tables: await reread.readStored(store.writer), added: added.map((t) => ({ table: t.source, columns: t.columns })), held: ["public.keyed"] });
    const said = reread.readAgain(JSON.parse(JSON.stringify(published)) as Parameters<Reread["readAgain"]>[0]);
    assert.deepEqual(Object.fromEntries(said.map((t) => [t.table.slice("public.".length), { why: t.why, serves: t.serves }])), EXPECTED);
    assert.deepEqual(said.filter((t) => t.held).map((t) => t.table), ["public.keyed"]);
    for (const t of said) assert.deepEqual([t.rows, t.bytes], [3, 4096], `${t.table}: its size, as the ledger records it`);

    // THE COMMAND, against a run that answers with those facts: the same tables, as data and in words
    server = http.createServer((req, res) => {
      const body = req.url === "/api/ping" ? { pid: process.pid } : req.url === "/api/state?storage=1" ? { engine: { version: "0.0.1" }, storage: published } : null;
      res.writeHead(body === null ? 404 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(body ?? { error: "no such route" }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const app = path.join(dir, "app");
    fs.mkdirSync(path.join(app, ".mason"), { recursive: true });
    fs.mkdirSync(path.join(app, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(app, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
      running: { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token: "t0ken", postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } }, lastRun: null }), { mode: 0o600 });
    const json = await runMason(app, ["upgrade", "--check", "--json"], matrixEnv());
    assert.equal(json.code, 0, json.stdout + json.stderr);
    const answer = JSON.parse(json.stdout) as { from: string; to: string; tables: unknown[]; next: unknown[] };
    assert.equal(answer.from, "0.0.1");
    assert.deepEqual(answer.tables, said);
    const person = await runMason(app, ["upgrade", "--check"], matrixEnv());
    assert.equal(person.code, 0, person.stderr);
    assert.match(person.stdout, /^Upgrading from Mason 0\.0\.1 to \S+ reads 8 synced tables again whole from your database, once, at the first start\.\n/);
    assert.match(person.stdout, /\n {2}public\.vanished +3 rows, 4\.0 KiB on your database · its synced data is missing · not served until its new sync is done\n/);
    assert.match(person.stdout, /\n {2}public\.held +3 rows, 4\.0 KiB on your database · in an older Mason's layout, pt \(point\) not held as the source's text · serves its synced data until then\n/);
    assert.match(person.stdout, /\n {2}public\.keyed +3 rows, .* · serves its synced data until then · held now for its columns \(mason status says why\): read again once that is fixed\n/);

    // WHAT A REAL START OF THIS RELEASE THEN DOES: it reads again exactly those tables
    const upgraded = await opened();
    const needs = (t: AddedTable): boolean => (upgraded as unknown as { needsCopy: (t: AddedTable) => boolean }).needsCopy(t);
    // (setTables placed the columns: a record without numbers took them, its ledger row written on the writer's turn)
    const readByStart = added.filter((t) => needs(t)).map((t) => t.table).filter((n) => n !== "pending");
    assert.deepEqual(readByStart.sort(), Object.keys(EXPECTED).sort(), "the start reads again what the command said, and nothing else");
    assert.equal(needs(added.find((t) => t.table === "pending")!), true, "a first sync not done is synced, and is not a table read again");
    await upgraded.stop();
  } finally {
    if (server !== null) await new Promise<void>((r) => server!.close(() => r()));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mason upgrade --check against a Mason that does not say what its synced data holds: refused with the way out, never a guess", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-reread-old-"));
  // the state an older run answers (no storage), and one in a form this release does not read
  let storage: unknown = undefined;
  const server = http.createServer((req, res) => {
    const body = req.url === "/api/ping" ? { pid: process.pid } : req.url === "/api/state?storage=1" ? { engine: { version: "0.0.1" }, ...(storage !== undefined ? { storage } : {}) } : null;
    res.writeHead(body === null ? 404 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(body ?? { error: "no such route" }));
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    fs.mkdirSync(path.join(dir, ".mason"), { recursive: true });
    fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
      running: { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token: "t0ken", postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } }, lastRun: null }), { mode: 0o600 });
    const old = await runMason(dir, ["upgrade", "--check", "--json"], matrixEnv());
    assert.equal(old.code, 1, old.stdout + old.stderr);
    const error = (JSON.parse(old.stdout) as { error: { code: string; message: string; fix: string } }).error;
    assert.equal(error.code, "failed");
    assert.match(error.message, /^the Mason running now \(0\.0\.1\) does not say what its synced data holds, so this cannot tell which tables \S+ would read again$/);
    assert.match(error.fix, /"Before you upgrade" says which tables it reads again/);
    storage = { format: 2, tables: [], added: [] };
    const other = await runMason(dir, ["upgrade", "--check", "--json"], matrixEnv());
    assert.equal(other.code, 1, other.stdout + other.stderr);
    assert.match((JSON.parse(other.stdout) as { error: { message: string } }).error.message, /says what its synced data holds in a form Mason \S+ does not read/);
    const positional = await runMason(dir, ["upgrade", "--check", "shop", "--json"], matrixEnv());
    assert.equal(positional.code, 2, positional.stdout);
    assert.match((JSON.parse(positional.stdout) as { error: { fix: string } }).error.fix, /cd <folder> && mason upgrade --check, or mason -C <folder> upgrade --check/);
    const bare = await runMason(dir, ["upgrade"], matrixEnv());
    assert.equal(bare.code, 2, bare.stderr);
    assert.match(bare.stderr, /mason upgrade: mason upgrade changes nothing by itself: run it with --check/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mason upgrade --check writes a character that prints as nothing as its escape: a column whose name starts with a byte-order mark is seen to", async () => {
  let upgrade: typeof import("../src/cli/upgrade.ts") | null = null;
  try { upgrade = await import("../src/cli/upgrade.ts"); }
  catch (e) {
    // absent before issue 1069: the test fails by its assertion, never by the file failing to load
    if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
  }
  assert.ok(upgrade !== null, "src/cli/upgrade.ts");
  const r = upgrade.checkReport("0.23.0", "0.24.0", [{ table: "public.b", why: "layout", reason: "in an older Mason's layout, \"\uFEFFamount\" stored as text", rows: 1, bytes: null, serves: true, held: false }]);
  assert.equal(r.details[0]![1], "1 row · in an older Mason's layout, \"\\uFEFFamount\" stored as text · serves its synced data until then");
});
