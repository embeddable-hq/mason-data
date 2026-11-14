/**
 * A SOURCE COLUMN NAMED LIKE ONE OF MASON'S HIDDEN COLUMNS (issue 998, src/duck/hidden-columns.ts). Mason adds columns of
 * its own to a synced table: a stored JSON path's (`__mason_json_<12 hex>`) and a plain numeric's scale
 * (`__mason_scale_<12 hex>`). A source table may name a column like either, in any case, or nearly so. Each such column
 * is the source's: synced, served and kept across a restart, in poll and stream mode, beside a stored JSON path and a
 * scale column of Mason's own. Nothing of it is dropped, and the stream keeps running for every table.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the stream's test, skipped otherwise), psql on PATH. It
 * writes only inside the databases it creates, `it_hidden_<random>_*`, and drops them and its slots at the end.
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
import type { JsonRead } from "../../src/duck/kept-route.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_hidden_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-hidden-"));

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

/** the Postgres API over the store, as `mason start` serves it */
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

const hex = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
/** each pattern of Mason's hidden names, and a near miss: a stored path's, in capitals, a plain numeric's scale (the very
 *  name `n`'s scale column would take first), a prefix alone */
const CLASHES = [`__mason_json_${hex("a")}`, `__MASON_JSON_${hex("b").toUpperCase()}`, `__mason_scale_${hex("n")}`, "__mason_json_x"] as const;
const quoted = (c: string): string => `"${c}"`;
const SCHEMA = `CREATE TABLE h (id int PRIMARY KEY, j jsonb, n numeric, ${CLASHES.map((c, i) => `${quoted(c)} ${i % 2 === 0 ? "text" : "int"}`).join(", ")}); ` +
  "CREATE TABLE other (id int PRIMARY KEY, v text)";
const rows = (from: number, to: number): string => `INSERT INTO h SELECT g, jsonb_build_object('a', 'doc ' || g), (g % 7) + 0.5, ` +
  `${CLASHES.map((_, i) => i % 2 === 0 ? `'v${i} ' || g` : `g * ${i + 10}`).join(", ")} FROM generate_series(${from}, ${to}) g; ` +
  `INSERT INTO other SELECT g, 'o ' || g FROM generate_series(${from}, ${to}) g`;
const CHANGES = (k: number): string => `${rows(100 + k * 10, 105 + k * 10)}; UPDATE h SET ${quoted(CLASHES[0])} = 'changed ${k}', ${quoted(CLASHES[1])} = -${k} WHERE id % 3 = 0; ` +
  `UPDATE other SET v = 'changed ${k}' WHERE id % 3 = 0; DELETE FROM h WHERE id = ${k + 1}; DELETE FROM other WHERE id = ${k + 1}`;
const READS = [
  "SELECT * FROM h ORDER BY id",
  `SELECT id, ${CLASHES.map(quoted).join(", ")} FROM h ORDER BY id`,
  `SELECT id, j ->> 'a', n, n::text FROM h ORDER BY id`,
  "SELECT * FROM other ORDER BY id",
];
const READ: JsonRead = { source: "public.h", column: "j", steps: '["a"]', either: false, canonical: true, asText: true };

/** a run of the sync over `file`, opened as `mason start` opens it */
async function start(file: string, source: Source, db: string, tables: AddedTable[], logged: string[], mode: "poll" | "replication", names: { slot: string; publication: string; owned: boolean } | null) {
  const store = await DuckStore.open(file, (l) => logged.push(l));
  const sync = new Sync(store, source, db, (l) => logged.push(l), mode === "poll" ? 3_600_000 : 1_000, mode, names, { json: { eager: true } });
  await sync.open();
  sync.setTables(tables);
  return { store, sync, close: async () => { await sync.stop(); await store.close(); } };
}

/** every read equal to Postgres's, every table copied with no error, nothing dropped, and the stored path ready */
async function same(run: { store: DuckStore; sync: Sync }, db: string, url: string, logged: string[], step: string): Promise<void> {
  assert.deepEqual(run.sync.state().map((s) => [s.source, s.phase, s.error]).sort(), [["public.h", "copied", null], ["public.other", "copied", null]], `${step}:\n${logged.slice(-10).join("\n")}`);
  assert.deepEqual(logged.filter((l) => /dropped the column/.test(l)), [], `${step}: nothing dropped`);
  const api = await listen(run.store, run.sync, db);
  try { for (const sql of READS) assert.equal(await api.ask(sql), psql(url, sql), `${sql}, ${step}`); } finally { await api.close(); }
  assert.deepEqual(run.sync.kept.status().map((p) => p.state), ["ready"], `${step}: the stored path is kept`);
}

test("a source column named like a hidden one is synced, served and kept across a restart, polled", { skip }, async () => {
  const db = `${tag}_poll`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; ${rows(1, 40)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const tables = await tablesOf(parsed.source, ["public.h", "public.other"]);
  const logged: string[] = [];
  const file = path.join(dir, "poll.db");
  let run = await start(file, parsed.source, db, tables, logged, "poll", null);
  try {
    await run.sync.once();
    await run.sync.kept.keepNow!([READ]);
    await same(run, db, url, logged, "after the first sync");
    await run.close();
    run = await start(file, parsed.source, db, tables, logged, "poll", null);
    await run.sync.once();
    await same(run, db, url, logged, "after a restart");
    psql(url, CHANGES(1));
    await run.sync.pollNow(["public.h", "public.other"]);
    await same(run, db, url, logged, "after a restart and a poll");
    await run.close();
    run = await start(file, parsed.source, db, tables, logged, "poll", null);
    psql(url, CHANGES(2));
    await run.sync.once();
    await run.sync.pollNow(["public.h", "public.other"]);
    await same(run, db, url, logged, "after a second restart and a poll");
  } finally {
    await run.close();
  }
});

test("a source column named like a hidden one is synced, served and kept across a restart, streamed, and the stream runs on for every table", { skip: skip || (!logical && "the test server's wal_level is not logical") }, async () => {
  const db = `${tag}_stream`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; ${rows(1, 40)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const tables = await tablesOf(parsed.source, ["public.h", "public.other"]);
  const names = { slot: `${tag}_s`, publication: `${tag}_s`, owned: true };
  const logged: string[] = [];
  const file = path.join(dir, "stream.db");
  let run = await start(file, parsed.source, db, tables, logged, "replication", names);
  try {
    await run.sync.once();
    await run.sync.caughtUp();
    await run.sync.kept.keepNow!([READ]);
    psql(url, CHANGES(1));
    await run.sync.caughtUp();
    await same(run, db, url, logged, "streamed");
    await run.close();
    psql(url, CHANGES(2));
    run = await start(file, parsed.source, db, tables, logged, "replication", names);
    await run.sync.once();
    await run.sync.caughtUp();
    await same(run, db, url, logged, "after a restart, the changes made while it was down");
    psql(url, CHANGES(3));
    await run.sync.caughtUp();
    await same(run, db, url, logged, "after a restart, streamed");
  } finally {
    await run.close();
  }
});

test("a copy an older Mason left without such a column is synced again once at the start, then answers right", { skip }, async () => {
  const db = `${tag}_old`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; ${rows(1, 40)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const tables = await tablesOf(parsed.source, ["public.h", "public.other"]);
  const logged: string[] = [];
  const file = path.join(dir, "old.db");
  let run = await start(file, parsed.source, db, tables, logged, "poll", null);
  try {
    await run.sync.once();
    await run.sync.kept.keepNow!([READ]);
    // what an older Mason's start did: the source's column dropped from the copy
    await run.store.writer.run(`ALTER TABLE public.h DROP COLUMN ${quoted(CLASHES[0])}`);
    await run.close();
    let before = logged.length;
    run = await start(file, parsed.source, db, tables, logged, "poll", null);
    assert.ok(logged.slice(before).some((l) => l.includes("missing a column it syncs") && l.includes(CLASHES[0])), `the copy is said:\n${logged.slice(before).join("\n")}`);
    await run.sync.once();
    assert.ok(logged.slice(before).some((l) => /^synced public\.h\b/.test(l)), `it is synced again:\n${logged.slice(before).join("\n")}`);
    psql(url, CHANGES(1));
    await run.sync.pollNow(["public.h", "public.other"]);
    await same(run, db, url, logged, "synced again, then polled");
    // a second start: nothing is synced again
    await run.close();
    before = logged.length;
    run = await start(file, parsed.source, db, tables, logged, "poll", null);
    await run.sync.once();
    assert.ok(!logged.slice(before).some((l) => l.includes("missing a column") || /^synced public\.h\b/.test(l)), `nothing is synced again:\n${logged.slice(before).join("\n")}`);
  } finally {
    await run.close();
  }
});

test("a source column added under a stored path's very name is the source's: the copy made again syncs its values, and the path is dropped", { skip }, async () => {
  const db = `${tag}_taken`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; ${rows(1, 40)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const file = path.join(dir, "taken.db");
  let run = await start(file, parsed.source, db, await tablesOf(parsed.source, ["public.h", "public.other"]), logged, "poll", null);
  try {
    await run.sync.once();
    await run.sync.kept.keepNow!([READ]);
    // the stored path's own column's name, from the module when the test runs
    const { hiddenName } = await import("../../src/duck/kept-route.ts");
    const taken = hiddenName(READ);
    psql(url, `ALTER TABLE h ADD COLUMN ${quoted(taken)} text; UPDATE h SET ${quoted(taken)} = 'mine ' || id`);
    const wider = await tablesOf(parsed.source, ["public.h", "public.other"]);
    run.sync.setTables(wider);
    await run.sync.once();
    const sql = `SELECT id, ${quoted(taken)}, j ->> 'a' FROM h ORDER BY id`;
    let api = await listen(run.store, run.sync, db);
    try {
      for (const q of [sql, ...READS]) assert.equal(await api.ask(q), psql(url, q), `${q}, after the copy made again\n${logged.slice(-8).join("\n")}`);
    } finally { await api.close(); }
    assert.deepEqual(run.sync.kept.status().map((p) => p.state), ["dropped"], "the path whose name the source took is dropped");
    await run.close();
    run = await start(file, parsed.source, db, wider, logged, "poll", null);
    await run.sync.once();
    psql(url, `UPDATE h SET ${quoted(taken)} = 'after ' || id WHERE id % 2 = 0`);
    await run.sync.pollNow(["public.h"]);
    api = await listen(run.store, run.sync, db);
    try { assert.equal(await api.ask(sql), psql(url, sql), `${sql}, after a restart and a poll`); } finally { await api.close(); }
  } finally {
    await run.close();
  }
});
