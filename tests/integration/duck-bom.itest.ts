/**
 * TEXT THAT STARTS WITH A BYTE-ORDER MARK (issue 991, src/duck/text.ts): a value, a text[] element, a JSON string or a
 * column name that starts with U+FEFF is served as Postgres serves it, the mark kept. A default TextDecoder drops one
 * leading U+FEFF: the engine's library decoded every string with one, so a value lost its mark on the wire, and a
 * numeric column whose name starts with one missed its type in the copy and was synced as text. A binary text[]
 * parameter's elements were decoded the same way.
 *
 * Each statement is asked of the source and of the Postgres API over the synced data, with node-postgres (which keeps
 * the mark), and the column names, type OIDs and text are held equal, after the copy, after a poll, and after the
 * stream when the server's wal_level is logical.
 *
 * What it needs: IT_POSTGRES_URL, psql on PATH. It writes only inside the databases it creates, `it_bom_<random>_*`,
 * and drops them, and its replication slot, at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { startPostgresApi } from "../../src/api/postgres/server.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_bom_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-bom-"));

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

const BOM = "\uFEFF";
/** the numeric column's name: a byte-order mark, then `amount` (as a CSV import can leave it) */
const AMOUNT = `"${BOM}amount"`;

const SCHEMA = `CREATE TYPE mood AS ENUM ('${BOM}glad', 'glad'); ` +
  `CREATE TABLE b (id int PRIMARY KEY, t text, v varchar(20), a text[], j jsonb, ${AMOUNT} numeric, m mood)`;
/** a non-breaking space: white space to JavaScript's `\s` and `trim()`, never to Postgres's array_in or array_out */
const NBSP = "\u00A0";
/** a row of `b` for each case: a leading mark, none, only one, two, one in the middle, NULL, a mark after a space, and
 *  a non-breaking space at the start and inside */
const rowsOf = (from: number): string => [
  `${BOM}a`, "a", BOM, `${BOM}${BOM}a`, `x${BOM}a`, null, ` ${BOM}a`, `${NBSP}a`, `a${NBSP}b`,
].map((t, i) => {
  const id = from + i, lit = t === null ? "NULL" : `'${t}'`;
  return `(${id}, ${lit}, ${lit}, ARRAY[${lit}, 'b', ${lit}], jsonb_build_object('k', ${lit}, 'l', jsonb_build_array(${lit})), ${id}.5, '${i % 2 === 0 ? BOM : ""}glad')`;
}).join(", ");

/** what is asked of both, and whether its rows' order is the statement's (`list`) or not (`bag`, compared sorted) */
const READS: Array<[string, "list" | "bag"]> = [
  // (the enum's type OID is the catalog's, never the source's, issue 861: it is read as text here)
  [`SELECT id, t, v, a, j, ${AMOUNT}, m::text FROM b ORDER BY id`, "list"],
  ["SELECT id, a::text, j::text, (t, v)::text, ROW(t, a)::text FROM b ORDER BY id", "list"],
  ["SELECT id, t, octet_length(t), length(t), v, a, j FROM b ORDER BY id", "list"],
  [`SELECT id, ${AMOUNT}, ${AMOUNT} + 1, ${AMOUNT}::text FROM b ORDER BY id`, "list"],
  [`SELECT sum(${AMOUNT}), avg(${AMOUNT}), max(${AMOUNT}) FROM b`, "list"],
  ["SELECT id, a[1], a[3], array_to_string(a, '|', '*'), array_length(a, 1) FROM b ORDER BY id", "list"],
  ["SELECT id, unnest(a) FROM b ORDER BY id", "bag"],
  ["SELECT id, j->>'k', j #>> '{k}', j->'k', j->'l'->>0, j->'l' FROM b ORDER BY id", "list"],
  ["SELECT t, count(*) FROM b GROUP BY t", "bag"],
  ["SELECT DISTINCT t FROM b", "bag"],
  ["SELECT DISTINCT v FROM b", "bag"],
  ["SELECT DISTINCT a[1] FROM b", "bag"],
  ["SELECT DISTINCT j->>'k' FROM b", "bag"],
  ["SELECT count(DISTINCT t), count(DISTINCT j->>'k') FROM b", "list"],
  ["SELECT id, m::text, (m = 'glad')::text FROM b ORDER BY id", "list"],
  ["SELECT m::text, count(*) FROM b GROUP BY m", "bag"],
  ["SELECT id, t || '|', upper(t), left(t, 1), substr(t, 1, 2) FROM b ORDER BY id", "list"],
  ["SELECT string_agg(t, ',' ORDER BY id) FROM b", "list"],
];

/** the parameters asked of both: a text one, and binary text[] ones (array_send's bytes, as Npgsql sends them) */
const PARAMETERED: Array<[string, unknown[] | ((url: string) => unknown[])]> = [
  ["SELECT id, t FROM b WHERE t = $1 ORDER BY id", [`${BOM}a`]],
  ["SELECT id, t FROM b WHERE t = $1 ORDER BY id", [BOM]],
  ["SELECT id, t FROM b WHERE t = ANY($1::text[]) ORDER BY id", [`{${BOM}a,"${BOM}",${NBSP}a}`]],
  ["SELECT $1::text, octet_length($1::text)", [`${BOM}a`]],
  ["SELECT $1::text[], ($1::text[])[1], array_to_string($1::text[], '|') FROM b WHERE id = 1", (url) => [binaryArray(url, `ARRAY['${BOM}a', '${BOM}', 'a', '${BOM}${BOM}b', NULL, '${NBSP}a']::text[]`)]],
  ["SELECT id, (t = ANY($1::text[]))::text FROM b ORDER BY id", (url) => [binaryArray(url, `ARRAY['${BOM}a', '${BOM}']::text[]`)]],
];

/** a text[]'s array_send bytes, read from the source: node-postgres sends a Buffer as a binary parameter */
function binaryArray(url: string, array: string): Buffer {
  return Buffer.from(psql(url, `SELECT encode(array_send(${array}), 'hex')`), "hex");
}

/** the source's tables as `mason start` reads them, by name */
async function tablesOf(source: Source, names: readonly string[]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return names.map((n) => { const t = facts.tables.find((x) => x.source === n); if (!t) throw new Error(`no table ${n}`); return t; });
  } finally { c.pg.close(); }
}

/** an answer as the client reads it: each column's name and type OID, then each row's text, or the error's SQLSTATE */
async function answerOf(c: pg.Client, sql: string, values: unknown[], how: "list" | "bag"): Promise<string> {
  try {
    const r = await c.query({ text: sql, values, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig);
    const rows = (r.rows as unknown[][]).map((row) => JSON.stringify(row));
    if (how === "bag") rows.sort();
    return [JSON.stringify(r.fields.map((f) => [f.name, f.dataTypeID])), ...rows].join("\n");
  } catch (e) { return `error ${(e as { code?: string }).code}: ${(e as Error).message}`; }
}

/** the source and the Postgres API over the store, as `mason start` serves it, each asked every statement */
async function compare(store: DuckStore, sync: Sync, db: string, url: string, when: string, more: Array<[string, "list" | "bag"]> = []): Promise<void> {
  const server = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: db, masonVersion: "test",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, null, undefined, () => sync.state(), sync.kept.enabled ? sync.kept : undefined) });
  const mason = new pg.Client({ host: "127.0.0.1", port: server.port, database: db, user: "test", password: "x" });
  const source = new pg.Client({ connectionString: url });
  await mason.connect();
  await source.connect();
  const show = (s: string): string => s.replaceAll(BOM, "<BOM>");
  try {
    for (const [sql, how] of [...READS, ...more]) {
      const want = await answerOf(source, sql, [], how);
      assert.ok(!want.startsWith("error"), `${sql}: ${want}`);
      const got = await answerOf(mason, sql, [], how);
      assert.equal(show(got), show(want), `${sql} (${when})`);
      assert.equal(got, want, `${sql} (${when})`);
    }
    for (const [sql, given] of PARAMETERED) {
      const values = typeof given === "function" ? given(url) : given;
      const want = await answerOf(source, sql, values, "list");
      assert.ok(!want.startsWith("error"), `${sql}: ${want}`);
      const got = await answerOf(mason, sql, values, "list");
      assert.equal(show(got), show(want), `${sql} ${show(JSON.stringify(values))} (${when})`);
      assert.equal(got, want, `${sql} (${when})`);
    }
  } finally {
    await mason.end();
    await source.end();
    await server.close();
  }
}

test("a value, a text[] element, a JSON string, an enum label and a numeric column's name that start with U+FEFF are served as Postgres serves them, after the copy and a poll", { skip }, async () => {
  const db = `${tag}_poll`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; INSERT INTO b VALUES ${rowsOf(1)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [B] = await tablesOf(parsed.source, ["public.b"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "poll.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    sync.setTables([B!]);
    await sync.once();
    assert.deepEqual(sync.state().map((x) => [x.source, x.phase, x.error]), [["public.b", "copied", null]], logged.slice(-6).join("\n"));
    // the numeric column is synced as a number, never as text
    const stored = (await store.writer.runAndReadAll(`SELECT data_type FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = 'b' AND column_name = '${BOM}amount'`)).getRowsJS();
    assert.match(String(stored[0]?.[0]), /^DECIMAL/, `the column ${BOM}amount is synced as ${String(stored[0]?.[0])}`);
    await compare(store, sync, db, url, "after the copy");
    psql(url, `INSERT INTO b VALUES ${rowsOf(11)}; UPDATE b SET t = '${BOM}${BOM}' WHERE id = 2`);
    await sync.pollNow(["public.b"]);
    await compare(store, sync, db, url, "after a poll");
  } finally {
    await sync.stop();
    await store.close();
  }
});

/** a column of each type whose name starts with a mark, beside `b`'s: a fresh copy stores each as its own type, so
 *  the start after it finds no column an older Mason stored as text (nothing is read again at every start) */
const TYPED = ["integer", "bigint", "real", "double precision", "numeric(10,2)", "boolean", "uuid", "date", "time", "time with time zone",
  "timestamp", "timestamp with time zone", "interval", "bytea", "oid", "integer[]", "text[]", "text", "varchar(5)", "char(3)", "name", '"char"', "inet", "mood"];
const typedName = (i: number): string => `"${BOM}c${i}"`;
const TYPED_SQL = `CREATE TABLE w (id int PRIMARY KEY, ${TYPED.map((t, i) => `${typedName(i)} ${t}`).join(", ")}); ` +
  `INSERT INTO w VALUES (1, 1, 2, 1.5, 2.5, 3.25, true, '6f1d5c3e-0b4a-4c6e-9a51-2f6b0e1c2d3e', '2024-01-02', '12:30', '12:30+02', ` +
  `'2024-01-02 03:04:05', '2024-01-02 03:04:05+00', '1 day 2 hours', '\\x01ff', 7, '{1,2}', '{a,b}', 'x', 'abc', 'ab', 'n', 'c', '10.0.0.1', '${BOM}glad')`;
/** every typed column, the enum as its text (its type OID is the catalog's, issue 861) */
const TYPED_READ = `SELECT id, ${TYPED.map((t, i) => t === "mood" ? `${typedName(i)}::text` : typedName(i)).join(", ")} FROM w ORDER BY id`;

test("a copy an older Mason made of a column whose name starts with U+FEFF, as text, is read again once, then answers right, and a fresh copy is never", { skip }, async () => {
  const db = `${tag}_old`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; INSERT INTO b VALUES ${rowsOf(1)}; ${TYPED_SQL}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const tables = await tablesOf(parsed.source, ["public.b", "public.w"]);
  const logged: string[] = [];
  const file = path.join(dir, "old.db");
  const said = (from: number): string[] => logged.slice(from).filter((l) => l.includes("byte-order mark") || /^synced public\.[bw]\b/.test(l));
  let store = await DuckStore.open(file, (l) => logged.push(l));
  let sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
  const reopen = async (): Promise<number> => {
    await sync.stop();
    await store.close();
    store = await DuckStore.open(file, (l) => logged.push(l));
    sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll");
    const before = logged.length;
    await sync.open();
    sync.setTables(tables);
    await sync.once();
    return before;
  };
  try {
    await sync.open();
    sync.setTables(tables);
    await sync.once();
    // a fresh copy: each typed column stored as its own type, so the next start reads nothing again
    let before = await reopen();
    assert.deepEqual(said(before), [], `a fresh copy is read again:\n${logged.slice(before).join("\n")}`);
    // the older Mason's copy: the numeric column stored as text
    await store.writer.run(`ALTER TABLE public.b ALTER COLUMN "${BOM}amount" TYPE VARCHAR`);
    before = await reopen();
    assert.ok(said(before).some((l) => l.startsWith("public.b: it is stored by an older Mason") && l.includes(`${BOM}amount`)), `the old copy is said:\n${logged.slice(before).join("\n")}`);
    assert.ok(said(before).some((l) => /^synced public\.b\b/.test(l)), `it is read again:\n${logged.slice(before).join("\n")}`);
    assert.ok(!said(before).some((l) => /^synced public\.w\b/.test(l) || l.startsWith("public.w:")), `only that table is read again:\n${logged.slice(before).join("\n")}`);
    await compare(store, sync, db, url, "after the old copy is read again", [[TYPED_READ, "list"]]);
    // a second start: nothing is read again
    before = await reopen();
    assert.deepEqual(said(before), [], `nothing is read again:\n${logged.slice(before).join("\n")}`);
  } finally {
    await sync.stop();
    await store.close();
  }
});

test("rows the stream writes that start with U+FEFF are served as Postgres serves them",{ skip: skip || (!logical && "the test server's wal_level is not logical") }, async () => {
  const db = `${tag}_stream`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; INSERT INTO b VALUES ${rowsOf(1)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [B] = await tablesOf(parsed.source, ["public.b"]);
  const names = { slot: `${tag}_s`, publication: `${tag}_s`, owned: true };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "stream.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names);
  try {
    await sync.open();
    sync.setTables([B!]);
    await sync.once();
    psql(url, `INSERT INTO b VALUES ${rowsOf(11)}; UPDATE b SET t = '${BOM}${BOM}', a = ARRAY['${BOM}'] WHERE id = 2`);
    await sync.caughtUp();
    await compare(store, sync, db, url, "after the stream");
  } finally {
    await sync.stop();
    await store.close();
  }
});
