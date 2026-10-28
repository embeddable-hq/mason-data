/**
 * STORED JSON PATHS (src/duck/kept.ts, src/duck/kept-route.ts; docs/DESIGN.md "Stored JSON paths"): a JSON
 * path statements keep reading is stored as a hidden column of the copy, computed once per row written, and read from
 * there once every row of it is stored. What is held here, offline, over the repo's own rows (generated in DuckDB):
 *  - the stored value is the function's own answer for every JSON shape it handles, and the read from the column equals
 *    the call on every row — a value the function raises on, or one beginning with a NUL, computed at read time;
 *  - the rewrite reads the column only when the path is READY, records every read for the request log, and a statement
 *    listing a copy's columns without naming them (`*`, `t.*`, a whole row) never lists the hidden one;
 *  - the policy (the request log's reads), and the backfill, a chunk a writer's turn, then READY;
 *  - every write keeps it current: the stream's insert by key and unchanged-TOAST update, the poll's write by key, and the
 *    copy's side table filled before its swap; a table removed or the feature turned off leaves nothing behind.
 * A real copy, poll and stream against Postgres: tests/integration/duck-json-paths.itest.ts.
 *
 * The new modules are imported when a test runs, never at the top: the file loads at a commit without them, where each
 * test fails by its assertion (scripts/fails-without.ts).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { DuckStore, MASON_SCHEMA } from "../src/duck/store.ts";
import * as syncModule from "../src/duck/sync.ts";
import { planDuck } from "../src/duck/plan.ts";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import type { AddedTable } from "../src/duck/sync.ts";
import type { Source } from "../src/cli/preflight.ts";
import type { Node } from "libpg-query";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-json-columns-"));
after(async () => { await stopParser(); fs.rmSync(dir, { recursive: true, force: true }); });

type Read = { source: string; column: string; steps: string; either: boolean; canonical: boolean; asText: boolean };
type KeptPath = Read & { name: string; state: string; rowsTotal: number; rowsDone: number; statements: number; slowestMs: number | null; why: string; marked?: number };
type Ready = { name: string; exact: boolean } | string | null;
type Keeper = {
  open(): Promise<void>; stop(): Promise<void>; review(): Promise<void>; status(): KeptPath[];
  /** the fills a review starts and never waits for (absent before a review stopped waiting for them) */
  fills?(): Promise<void>;
  ready(r: Read): Ready; visible(): ReadonlySet<string>; generation(): number; keepNow: ((r: readonly Read[]) => Promise<void>) | null;
  fillSide(c: unknown, source: string, side: string, columns: readonly string[], run: (sql: string) => Promise<number>): Promise<void>;
  removed(source: string): Promise<void>;
};
type KeptModule = {
  KeptJsonPaths: new (store: DuckStore, host: unknown, options: Record<string, unknown>) => Keeper;
  KEEP_AFTER_STATEMENTS: number; KEEP_AFTER_MS: number;
};
type RouteModule = { hiddenName(r: Read): string; readKey(r: Read): string; VISIBLE_CATALOG: string };
/** a ready path's column, whatever the keeper answers (a name, or the name and whether it is exact) */
/** a review, then the fills it started, to their end */
const reviewed = async (k: Keeper): Promise<void> => { await k.review(); await k.fills?.(); };
const readyName = (r: Ready): string | null => r === null ? null : typeof r === "string" ? r : r.name;

/**
 * A STORED PATH'S READ FROM ITS COLUMN `h`, as SQL over the column alone (src/duck/rewrite.ts `keptRead`, `keptText`):
 * the column holds the path's `->` answer or a NUL for a NULL one; `->>` is derived from it.
 */
const fromColumn = (h: string, r: Omit<Read, "source" | "column">): string => r.asText
  ? `CASE WHEN ${h} = chr(0) OR ${h} = 'null' THEN NULL WHEN starts_with(${h}, '"') THEN CASE WHEN contains(${h}, '\\') THEN __mason_json_get(NULL, ${h}, '[]', false, ${r.canonical}, true) ` +
    `ELSE substr(${h}, 2, length(${h}) - 2) END ELSE ${h} END`
  : `CASE WHEN ${h} = chr(0) THEN NULL ELSE ${h} END`;

/** the keeper's modules, or the test's failure where they are not (a commit before them) */
async function modules(): Promise<{ kept: KeptModule; route: RouteModule }> {
  const load = async (p: string): Promise<unknown> => { try { return await import(p); } catch (e) { assert.fail(`${p} does not load: ${(e as Error).message}`); } };
  return { kept: await load("../src/duck/kept.ts") as KeptModule, route: await load("../src/duck/kept-route.ts") as RouteModule };
}

const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;
let files = 0;
const newStore = (): Promise<DuckStore> => DuckStore.open(path.join(dir, `d${files++}.db`), () => undefined, { memoryLimit: "512MB" });
const rows = async (store: DuckStore, sql: string): Promise<unknown[][]> => (await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][];
const one = async (store: DuckStore, sql: string): Promise<unknown> => (await rows(store, sql))[0]![0];

/**
 * THE DOCUMENTS: a row for each shape the function handles, generated in DuckDB (`range()`), as a JSON (json) and the
 * same text (jsonb's column is a JSON too; canonical is the read's). `n` rows of `SHAPES.length` shapes.
 */
const SHAPES = [
  `'{"s": "text ' || i || '", "n": 7.00, "o": {"a": {"b": [1, "x", null]}}, "arr": [10, 20, 30], "z": null, "u": "\\u00e9"}'`,
  `'{"b": 2, "a": 1, "s": "  spaced  ", "n": -0.5e3, "arr": [], "o": {}, "p": {"y": 1,   "x": 2}}'`,
  `'{"s": "", "n": 1e400, "dup": 1, "dup": 2, "arr": [{"k": "v' || i || '"}]}'`,
  `'[1, "two", {"three": 3}, [4], null]'`,
  `'"a scalar string"'`,
  `'42.000'`,
  `'null'`,
  // a value beginning with a NUL: never stored, computed when read
  `'{"s": "\\u0000hidden ' || i || '", "n": 0}'`,
  `'{"o": {"a": {"b": "deep ' || i || '"}}, "arr": [[1, 2], [3]]}'`,
];
async function documents(store: DuckStore, table: string, n: number): Promise<void> {
  await store.writer.run("CREATE SCHEMA IF NOT EXISTS public");
  await store.writer.run(`CREATE OR REPLACE TABLE ${table} AS SELECT (i * ${SHAPES.length} + s)::INTEGER AS id, ` +
    `(CASE s ${SHAPES.map((sh, k) => `WHEN ${k} THEN ${sh}`).join(" ")} END)::JSON AS j, NULL::JSON AS k FROM range(${n}) r(i), range(${SHAPES.length}) q(s)`);
  // and a row whose JSON is NULL
  await store.writer.run(`INSERT INTO ${table} VALUES (-1, NULL, NULL)`);
}

/** every read the tests store: each operator's, keys and indexes, json's text and jsonb's canonical */
const READS: Array<Omit<Read, "source" | "column">> = [
  { steps: '["s"]', either: false, canonical: true, asText: true },
  { steps: '["s"]', either: false, canonical: false, asText: false },
  { steps: '["n"]', either: false, canonical: true, asText: true },
  { steps: '["n"]', either: false, canonical: false, asText: true },
  { steps: '["n"]', either: false, canonical: true, asText: false },
  { steps: '["o"]', either: false, canonical: true, asText: false },
  { steps: '["o"]', either: false, canonical: false, asText: false },
  { steps: '["o","a","b"]', either: true, canonical: true, asText: true },
  { steps: '["o","a","b","1"]', either: true, canonical: true, asText: true },
  { steps: '["arr","0"]', either: true, canonical: false, asText: false },
  { steps: '["arr",-1]', either: false, canonical: true, asText: true },
  { steps: "[2]", either: false, canonical: true, asText: false },
  { steps: "[0]", either: false, canonical: true, asText: true },
  { steps: '["missing"]', either: false, canonical: true, asText: true },
  { steps: '["z"]', either: false, canonical: true, asText: true },
  { steps: '["z"]', either: false, canonical: true, asText: false },
  { steps: '["dup"]', either: false, canonical: false, asText: true },
  { steps: '["u"]', either: false, canonical: false, asText: false },
  { steps: '["p"]', either: false, canonical: true, asText: false },
  { steps: '["p"]', either: false, canonical: false, asText: true },
  { steps: '["arr","0","k"]', either: true, canonical: true, asText: true },
];

const args = (r: Omit<Read, "source" | "column">): string => `'${r.steps}', ${r.either}, ${r.canonical}, ${r.asText}`;

test("the stored value is the function's answer for every JSON shape, and the read from it equals the call on every row", async () => {
  const store = await newStore();
  try {
    await documents(store, "public.docs", 50);
    for (const r of READS) {
      // the path's `->` answer, a NULL one (and a NULL document's) the NUL mark
      const kept = `coalesce(__mason_json_kept(NULL, j, '${r.steps}', ${r.either}, ${r.canonical}, false), chr(0))`, get = `__mason_json_get(NULL, j, ${args(r)})`;
      const [total, wrong, unset, marked] = (await rows(store,
        `SELECT count(*), count(*) FILTER (${fromColumn("kept", r)} IS DISTINCT FROM ${get}), count(*) FILTER (kept IS NULL), count(*) FILTER (kept = chr(0) || '!') ` +
        `FROM (SELECT j, ${kept} AS kept FROM public.docs)`))[0] as bigint[];
      assert.equal(total, BigInt(50 * SHAPES.length + 1));
      assert.equal(wrong, 0n, `the read from the column differs from the call for ${JSON.stringify(r)}`);
      assert.deepEqual([unset, marked], [0n, 0n], `every row of ${JSON.stringify(r)} is answered by the column alone`);
    }
    // a string beginning with a NUL is its `->` text (escaped), and its `->>` the function's on that text
    assert.equal(await one(store, `SELECT __mason_json_kept(NULL, '{"s": "\\u0000x"}'::JSON, '["s"]', false, true, false)`), '"\\u0000x"');
    assert.equal(await one(store, `SELECT __mason_json_kept(NULL, NULL::JSON, '["s"]', false, true, false)`), null, "a NULL document: the write's coalesce marks it");
    // a document the function cannot read (DuckDB's JSON takes a trailing comma, Postgres's never does): marked
    assert.equal(await one(store, `SELECT __mason_json_kept(NULL, '{"s": 1,}'::JSON, '["s"]', false, true, false)`), "\u0000!");
    // the shapes, spelled out as Postgres answers their `->`: a number's trailing zeros kept (json and jsonb alike), a
    // missing key NULL (the mark) and a JSON null its text, an index from the end, jsonb's object canonical where
    // json's is as written, a string quoted
    const at = async (id: number, r: Omit<Read, "source" | "column" | "asText">): Promise<unknown> => one(store, `SELECT __mason_json_kept(NULL, j, '${r.steps}', ${r.either}, ${r.canonical}, false) FROM public.docs WHERE id = ${id}`);
    assert.equal(await at(0, { steps: '["n"]', either: false, canonical: false }), "7.00");
    assert.equal(await at(0, { steps: '["n"]', either: false, canonical: true }), "7.00");
    assert.equal(await at(1, { steps: '["p"]', either: false, canonical: true }), '{"x": 2, "y": 1}');
    assert.equal(await at(1, { steps: '["p"]', either: false, canonical: false }), '{"y": 1,   "x": 2}');
    assert.equal(await at(0, { steps: '["missing"]', either: false, canonical: true }), "\u0000");
    assert.equal(await at(0, { steps: '["z"]', either: false, canonical: true }), "null");
    assert.equal(await at(0, { steps: '["arr",-1]', either: false, canonical: true }), "30");
    assert.equal(await at(1, { steps: '["o"]', either: false, canonical: true }), "{}");
    assert.equal(await at(0, { steps: '["s"]', either: false, canonical: true }), '"text 0"');
  } finally { store.close(); }
});

/** a keeper over `store`'s table `public.docs`, its host's writer turns counted */
async function keeperOver(store: DuckStore, kept: KeptModule, options: Record<string, unknown>, rebuilding = (): boolean => false) {
  let turn: Promise<unknown> = Promise.resolve();
  const host = {
    turns: 0, logged: [] as string[],
    onWriter<T>(f: () => Promise<T>): Promise<T> { this.turns++; const t = turn.then(f); turn = t.then(() => undefined, () => undefined); return t; },
    served: () => new Map([["public.docs", [{ name: "id", type: "integer" }, { name: "j", type: "jsonb" }, { name: "k", type: "json" }]]]),
    rebuilding,
    log(l: string) { this.logged.push(l); },
  };
  const keeper = new kept.KeptJsonPaths(store, host, { enabled: true, reviewMs: 0, ...options });
  await keeper.open();
  return { keeper, host };
}

test("a backfill fills a path's rows a chunk a writer's turn, then the path is ready; the request log decides which paths", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    await documents(store, "public.docs", 1_200);
    const total = 1_200 * SHAPES.length + 1;
    const { keeper, host } = await keeperOver(store, kept, { backfillRows: 1_000 });
    const read = (r: Omit<Read, "source" | "column">): Read => ({ source: "public.docs", column: "j", ...r });
    const often = read(READS[0]!), slow = read(READS[7]!), rare = read(READS[2]!);
    // the request log as the listener writes it: `often` read by KEEP_AFTER_STATEMENTS fast statements, `slow` by one
    // slow one, `rare` by fewer fast ones than that
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    const logged = (reads: Read[], ms: number): string => `('r', ${ms}, '${JSON.stringify(reads.map(route.readKey)).replaceAll("'", "''")}')`;
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests VALUES ${[
      ...Array.from({ length: kept.KEEP_AFTER_STATEMENTS }, () => logged([often], 5)),
      logged([slow, rare], kept.KEEP_AFTER_MS + 200),
      ...Array.from({ length: kept.KEEP_AFTER_STATEMENTS - 2 }, () => logged([rare], 5)),
    ].join(", ")}`);
    assert.equal(keeper.ready(often), null);
    const gen = keeper.generation();
    // one path a review: the slowest first, the more read of two as slow (`rare`: the slow statement and a fast one)
    await reviewed(keeper);
    assert.deepEqual(keeper.status().map((p) => [p.steps, p.state, p.rowsDone, p.rowsTotal]), [[rare.steps, "ready", total, total]], host.logged.join("\n"));
    assert.ok(host.turns >= Math.ceil(total / 1_000) + 2, `a turn per chunk of 1,000 rows (${host.turns} turns for ${total} rows)`);
    assert.equal(readyName(keeper.ready(rare)), route.hiddenName(rare));
    assert.equal(keeper.ready(slow), null, "not stored yet");
    assert.ok(keeper.generation() > gen, "a path ready moves the plans' generation");
    await reviewed(keeper);
    await reviewed(keeper);
    const states = new Map(keeper.status().map((p) => [p.name, p]));
    assert.equal(states.get(route.hiddenName(often))?.state, "ready");
    assert.match(states.get(route.hiddenName(often))!.why, new RegExp(`read by ${kept.KEEP_AFTER_STATEMENTS} statements`));
    assert.equal(states.get(route.hiddenName(slow))?.state, "ready");
    assert.match(states.get(route.hiddenName(slow))!.why, /read by a statement that took 1\.2 s/);
    // every row stored, equal to the function; the ledger's rows say so
    for (const p of keeper.status()) {
      const [unset, wrong] = (await rows(store, `SELECT count(*) FILTER (${ident(p.name)} IS NULL), count(*) FILTER (${fromColumn(ident(p.name), p)} ` +
        `IS DISTINCT FROM __mason_json_get(NULL, j, ${args(p)})) FROM public.docs`))[0] as bigint[];
      assert.deepEqual([unset, wrong], [0n, 0n], p.name);
    }
    assert.deepEqual(await rows(store, `SELECT state, rows_done = rows_total FROM ${MASON_SCHEMA}.json_paths ORDER BY name`), [["ready", true], ["ready", true], ["ready", true]]);
    // never in a statement that lists the table's columns: the view of the visible ones
    assert.deepEqual(await rows(store, `SELECT column_name FROM duckdb_columns() WHERE database_name = '${route.VISIBLE_CATALOG}' AND table_name = 'docs' ORDER BY column_index`), [["id"], ["j"], ["k"]]);
    await keeper.stop();
  } finally { store.close(); }
});

test("a read is answered from its stored column only once it is ready, every read is recorded, and a * never lists the column", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  const pglite = new PGlite();
  try {
    await documents(store, "public.docs", 20);
    await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const { keeper } = await keeperOver(store, kept, { eager: true });
    const plan = async (sql: string) => {
      const stmt = (await parseSql(sql)).stmts![0]!.stmt as Node;
      return (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, stmt, 0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, keeper);
    };
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown[][]> => (await reader.runAndReadAll(sql)).getRowsJS() as unknown[][];
    const sql = "SELECT id, j ->> 's' AS s, j #>> '{o,a,b,1}' AS deep, d.j -> 'arr' -> 0 AS first FROM docs d WHERE j ->> 'n' IS NOT NULL ORDER BY id";
    const s = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    // with the feature off nothing is read from a column, and the reads are still what the function computes
    const off = await (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, (await parseSql(sql)).stmts![0]!.stmt, 0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, null);
    assert.doesNotMatch(off.sql.text, /__mason_json_[0-9a-f]{12}/);
    // eager (the oracle's): each read stored before the plan is made, then read from its column
    const on = await plan(sql);
    const reads = (on as unknown as { jsonReads?: readonly string[] }).jsonReads ?? [];
    assert.ok(reads.includes(route.readKey(s)), `the statement's reads are recorded: ${reads.join(" | ")}`);
    assert.equal(reads.length, 4, "->> 's', #>> '{o,a,b,1}', -> 'arr' -> 0 (one read: the chain is folded, jsonChain) and ->> 'n'");
    // read from the column alone: a ->> derived from the stored -> answer, a -> the column with its NULL mark
    assert.match(on.sql.text, new RegExp(`CASE WHEN ${route.hiddenName(s)} = chr\\(0\\) OR ${route.hiddenName(s)} = 'null' THEN NULL`), on.sql.text);
    // a qualified column is read through its qualifier, and a chain of reads off it is one stored path
    assert.match(on.sql.text, /CASE WHEN d\.(__mason_json_[0-9a-f]{12}) = chr\(0\) THEN NULL ELSE d\.\1 END AS first/, on.sql.text);
    // and no document is named: the function and DuckDB's own read are of the stored text, never of j
    assert.doesNotMatch(on.sql.text, /\(getvariable\('__mason_session'\), (d\.)?j,|json_type\((d\.)?j,/, on.sql.text);
    assert.deepEqual(await answer(on.sql.text), await answer(off.sql.text), "the stored reads answer what the calls answer");
    // a read whose path is not ready is the call: a keeper that knows no path
    const { keeper: empty } = await keeperOver(await newStore(), kept, {});
    const cold = await (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, (await parseSql(sql)).stmts![0]!.stmt, 0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, empty);
    assert.doesNotMatch(cold.sql.text, /__mason_json_[0-9a-f]{12}/);
    assert.equal(((cold as unknown as { jsonReads?: readonly string[] }).jsonReads ?? []).length, 4, "recorded even when none is stored");
    await empty.stop();
    // a statement that lists the columns without naming them: the view, and the reads computed
    for (const listing of ["SELECT * FROM docs ORDER BY id", "SELECT d.*, j ->> 's' FROM docs d ORDER BY id", "SELECT x.* FROM docs x JOIN docs y USING (id) ORDER BY 1",
      "SELECT *, j ->> 's' FROM public.docs NATURAL JOIN (SELECT 1 AS id) x", "WITH w AS (SELECT * FROM docs) SELECT * FROM w ORDER BY id"]) {
      const p = await plan(listing);
      // its text names the view (`__mason_visible`); what it calls is the plan's, the calls in its text and nothing
      // else (once read off the text, a * was a calling statement, and no timeout or cancel stopped it)
      const functions = (p.sql as unknown as { functions?: readonly string[] }).functions;
      assert.deepEqual(functions, [...new Set(p.sql.text.match(/\b__mason_[a-z0-9_]+(?=\()/g) ?? [])].sort(), `${listing}: the functions it calls`);
      if (!/->>/.test(listing)) assert.deepEqual(functions, [], `${listing} calls no Mason function`);
      assert.doesNotMatch(p.sql.text, /__mason_json_[0-9a-f]{12}/, listing);
      assert.match(p.sql.text, new RegExp(route.VISIBLE_CATALOG), listing);
      const got = await answer(p.sql.text);
      assert.equal((await reader.runAndReadAll(p.sql.text)).columnNames.length, p.fields!.length, `${listing}: DuckDB answers Postgres's columns, no more`);
      assert.ok(got.length > 0, listing);
    }
    // a WITH query of a copy's name is the WITH query, never the copy's view
    const shadow = await plan("WITH docs AS (SELECT 1 AS id) SELECT * FROM docs");
    assert.doesNotMatch(shadow.sql.text, new RegExp(route.VISIBLE_CATALOG));
    await keeper.stop();
    reader.closeSync();
  } finally { store.close(); await pglite.close(); }
});

// THE REVIEW OF THE NATIVE READ: the stored read's THEN arm places the column in every arm of the read's
// CASE; each placement is its own node, so each is qualified as Postgres resolved the name (`j` beside another table's
// `"J"` is ambiguous to DuckDB, which binds names case-insensitively)
test("a stored read names its JSON column in every place as Postgres resolved it, beside a column of that name in another case", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  const pglite = new PGlite();
  try {
    await documents(store, "public.docs", 4);
    await store.writer.run(`CREATE TABLE public.twin (id INTEGER, "J" JSON)`);
    await store.writer.run(`INSERT INTO public.twin VALUES (1, '{"s": "twin"}')`);
    await pglite.exec(`CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json); CREATE TABLE public.twin (id integer, "J" jsonb)`);
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const { keeper } = await keeperOver(store, kept, { eager: true });
    const plan = async (sql: string, k: Keeper | null) => (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, (await parseSql(sql)).stmts![0]!.stmt as Node,
      0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, k);
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown[][]> => (await reader.runAndReadAll(sql)).getRowsJS() as unknown[][];
    const read = (either: boolean): Read => ({ source: "public.docs", column: "j", steps: '["s"]', either, canonical: true, asText: true });
    for (const [sql, either] of [[`SELECT d.id, j ->> 's', "J" ->> 's' FROM docs d, twin ORDER BY d.id`, false], [`SELECT d.id, j #>> '{s}' FROM docs d JOIN twin t ON t.id = 1 ORDER BY d.id`, true]] as const) {
      const [on, off] = [await plan(sql, keeper), await plan(sql, null)];
      assert.match(on.sql.text, new RegExp(route.hiddenName(read(either))), `${sql}: read from its stored column`);
      const [got, want] = [await answer(on.sql.text).catch((e: Error) => e.message), await answer(off.sql.text).catch((e: Error) => e.message)];
      assert.ok(Array.isArray(want) && want.length > 0, `${sql}: the call answers (${String(want)})`);
      assert.deepEqual(got, want, `${sql}: the stored read answers what the call answers\n${on.sql.text}`);
    }
    await keeper.stop();
    reader.closeSync();
  } finally { store.close(); await pglite.close(); }
});

// ------------------------------------------------------------------------------------------------- the write paths

const column = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
const DOCS: AddedTable = { source: "public.docs", schema: "public", table: "docs", key: ["id"], columns: [column("id", "integer"), column("j", "jsonb"), column("k", "json")],
  foreignKeys: [], bytes: 0, rows: 0 };
// a source nothing listens on: never reached, the sync is stopped before anything would connect
const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;

/** what these tests reach inside the sync: its write paths, as the stream, the poll and the copy call them */
type SyncInside = {
  kept: Keeper;
  /** a batch of the stream, here a piece of a large transaction (no position): src/duck/sync.ts `applyChanges` */
  applyChanges(batch: unknown, from: { lsn: null; committedAt: null }): Promise<void>;
  onWriter<T>(f: () => Promise<T>): Promise<T>;
  swap(t: AddedTable, side: string, o: { snapshot: null; behind: null }): Promise<void>;
};

/** a Sync over a store whose `public.docs` is copied, with `reads` stored (eager), stopped before its tables are set so
 *  no pass runs (it would attach a source there is none of) */
async function syncWithStored(reads: Read[]) {
  const { route } = await modules();
  const store = await newStore();
  await documents(store, "public.docs", 30);
  const Sync = syncModule.Sync as unknown as new (...a: unknown[]) => syncModule.Sync & { kept?: Keeper };
  const first = new Sync(store, source, "x", () => undefined, 5_000, "poll", null, { json: { eager: true } });
  await first.open();
  await first.stop();
  await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.docs', 'copied', 0, 0, 1.0, now(), NULL, '${JSON.stringify(DOCS.columns)}')`);
  const logged: string[] = [];
  const sync = new Sync(store, source, "x", (l: string) => logged.push(l), 5_000, "poll", null, { json: { eager: true } });
  await sync.open();
  assert.ok(sync.kept !== undefined && sync.kept.keepNow !== null, "the sync keeps stored JSON paths");
  await sync.kept.keepNow(reads);
  for (const r of reads) assert.equal(readyName(sync.kept.ready(r)), route.hiddenName(r), `${r.steps} is stored`);
  await sync.stop();
  await sync.setTables([DOCS]);
  return { store, sync: sync as unknown as SyncInside, logged, route };
}

/** each stored column of `public.docs` equal to the function on every row, none unset */
async function current(store: DuckStore, reads: Read[], route: RouteModule): Promise<void> {
  for (const r of reads) {
    const h = ident(route.hiddenName(r));
    const [n, unset, wrong] = (await rows(store, `SELECT count(*), count(*) FILTER (${h} IS NULL), count(*) FILTER (${fromColumn(h, r)} ` +
      `IS DISTINCT FROM __mason_json_get(NULL, ${ident(r.column)}, ${args(r)})) FROM public.docs`))[0] as bigint[];
    assert.ok(n! > 0n);
    assert.deepEqual([unset, wrong], [0n, 0n], `${r.column} ${r.steps}: ${unset} unset, ${wrong} not the function's`);
  }
}

const STORED: Read[] = [
  { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true },
  { source: "public.docs", column: "j", steps: '["o","a","b"]', either: true, canonical: true, asText: false },
  { source: "public.docs", column: "k", steps: '["n"]', either: false, canonical: false, asText: true },
];

test("the stream's write by key and its unchanged-TOAST updates compute each stored path", async () => {
  const { store, sync, route } = await syncWithStored(STORED);
  try {
    const change = (key: number, values: Array<string | null | undefined>) => [JSON.stringify([String(key)]), { key: [String(key)], change: { kind: "row", values } }] as const;
    const batch = (...changes: Array<readonly [string, unknown]>) => new Map([["public.docs", { columns: ["id", "j", "k"], truncated: false, keys: new Map(changes), counts: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } }]]);
    // an insert, an update of a row there, a delete
    await sync.applyChanges(batch(
      change(100_000, ["100000", '{"s": "new", "o": {"a": {"b": [9]}}}', '{"n": 1.50}']),
      change(3, ["3", '{"s": "changed"}', '{"n": "x"}']),
      [JSON.stringify(["4"]), { key: ["4"], change: { kind: "delete" } }],
    ), { lsn: null, committedAt: null });
    await current(store, STORED, route);
    assert.equal(await one(store, `SELECT ${ident(route.hiddenName(STORED[0]!))} FROM public.docs WHERE id = 3`), '"changed"');
    // an UPDATE that left j unchanged (TOAST, not sent): k carried, j's stored paths as they were
    await sync.applyChanges(batch(change(100_000, ["100000", undefined, '{"n": 2.25}'])), { lsn: null, committedAt: null });
    assert.equal(await one(store, `SELECT ${ident(route.hiddenName(STORED[2]!))} FROM public.docs WHERE id = 100000`), "2.25");
    assert.equal(await one(store, `SELECT ${ident(route.hiddenName(STORED[0]!))} FROM public.docs WHERE id = 100000`), '"new"');
    // and one that carried j, leaving k unsent
    await sync.applyChanges(batch(change(100_000, ["100000", '{"s": "carried", "o": {"a": {"b": {"c": 1}}}}', undefined])), { lsn: null, committedAt: null });
    assert.equal(await one(store, `SELECT ${ident(route.hiddenName(STORED[0]!))} FROM public.docs WHERE id = 100000`), '"carried"');
    assert.equal(await one(store, `SELECT ${ident(route.hiddenName(STORED[1]!))} FROM public.docs WHERE id = 100000`), '{"c": 1}');
    await current(store, STORED, route);
  } finally { store.close(); }
});

test("the poll's write by key computes each stored path, a whole stage or a piece of it", async () => {
  const { store, sync, route } = await syncWithStored(STORED);
  try {
    const writeStaged = (syncModule as unknown as { writeStaged: (...a: unknown[]) => Promise<void> }).writeStaged;
    // the poll's stage: the changed rows, columns by position
    await store.writer.run(`CREATE TEMP TABLE stage AS SELECT * FROM (VALUES (5, '{"s": "polled"}'::JSON, '{"n": 3}'::JSON), (200000, '{"s": "polled new"}'::JSON, NULL::JSON)) v(c0, c1, c2)`);
    await writeStaged(store.writer, DOCS, "public.docs", "temp.main.stage", " WHERE rowid >= 0 AND rowid < 1", sync.kept);
    await writeStaged(store.writer, DOCS, "public.docs", "temp.main.stage", " WHERE rowid >= 1 AND rowid < 2", sync.kept);
    assert.deepEqual(await rows(store, `SELECT id, ${ident(route.hiddenName(STORED[0]!))} FROM public.docs WHERE id IN (5, 200000) ORDER BY id`), [[5, '"polled"'], [200000, '"polled new"']]);
    await current(store, STORED, route);
  } finally { store.close(); }
});

test("a copy's side table gets every stored path before its swap; a column the new copy lacks drops its paths", async () => {
  const { store, sync, route } = await syncWithStored(STORED);
  try {
    // a copy of the table again: its side table, as the copy's chunks fill it
    await store.writer.run(`CREATE TABLE public.docs__mason_copy AS SELECT id + 1 AS id, j, k FROM public.docs`);
    await sync.kept.fillSide(store.writer, "public.docs", "public.docs__mason_copy", ["id", "j", "k"], async (sql) => Number((await store.writer.run(sql)).rowsChanged));
    await sync.onWriter(() => sync.swap(DOCS, "public.docs__mason_copy", { snapshot: null, behind: null }));
    await current(store, STORED, route);
    assert.deepEqual(sync.kept.status().map((p) => p.state), ["ready", "ready", "ready"]);
    // copied again without k: its path goes with it, j's stay
    const noK = { ...DOCS, columns: DOCS.columns.filter((c) => c.name !== "k") };
    await store.writer.run(`CREATE TABLE public.docs__mason_copy AS SELECT id, j FROM public.docs`);
    await sync.kept.fillSide(store.writer, "public.docs", "public.docs__mason_copy", ["id", "j"], async (sql) => Number((await store.writer.run(sql)).rowsChanged));
    await sync.onWriter(() => sync.swap(noK, "public.docs__mason_copy", { snapshot: null, behind: null }));
    const state = new Map(sync.kept.status().map((p) => [p.column + p.steps, p]));
    assert.equal(state.get(`k${STORED[2]!.steps}`)?.state, "dropped");
    assert.match(state.get(`k${STORED[2]!.steps}`)!.why, /k is no longer a column/);
    assert.equal(sync.kept.ready(STORED[2]!), null);
    await current(store, STORED.slice(0, 2), route);
    // the view lists the new copy's columns
    assert.deepEqual(await rows(store, `SELECT column_name FROM duckdb_columns() WHERE database_name = '${route.VISIBLE_CATALOG}' AND table_name = 'docs' ORDER BY column_index`), [["id"], ["j"]]);
  } finally { store.close(); }
});

test("a table removed leaves no stored path, and turned off every stored column is dropped at the next start", async () => {
  const { kept } = await modules();
  const { store, sync, route } = await syncWithStored(STORED);
  try {
    await sync.onWriter(() => sync.kept.removed("public.docs"));
    assert.deepEqual(await rows(store, `SELECT count(*) FROM ${MASON_SCHEMA}.json_paths`), [[0n]]);
    assert.deepEqual(await rows(store, `SELECT count(*) FROM duckdb_views() WHERE database_name = '${route.VISIBLE_CATALOG}'`), [[0n]]);
    // turned off: a keeper made again with stored columns there drops them all and says so
    const again = await syncWithStored(STORED.slice(0, 1));
    try {
      const logged: string[] = [];
      const off = new kept.KeptJsonPaths(again.store, { onWriter: <T>(f: () => Promise<T>) => f(), served: () => new Map(), rebuilding: () => false, log: (l: string) => logged.push(l) }, { enabled: false });
      await off.open();
      assert.deepEqual(await rows(again.store, "SELECT count(*) FROM duckdb_columns() WHERE starts_with(column_name, '__mason_json_')"), [[0n]]);
      assert.deepEqual(await rows(again.store, `SELECT state FROM ${MASON_SCHEMA}.json_paths`), [["dropped"]]);
      assert.equal(off.ready(STORED[0]!), null);
      assert.match(logged.join("\n"), /turned off .*dropped 1 stored column/);
      await off.stop();
    } finally { again.store.close(); }
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------------------------------------- review findings
// (the test server: an add held the writer 28 s; a ready read still read every document; one path, two spellings,
// two columns; one 3.5 s read started a 1 h 34 min fill)

/** the columns a plan's scans of `table` read (EXPLAIN (FORMAT JSON): each scan's projections and filters) */
async function scanned(c: { runAndReadAll(sql: string): Promise<{ getRowsJS(): unknown[][] }> }, sql: string, table: string): Promise<string[]> {
  const plan = JSON.parse(String((await c.runAndReadAll(`EXPLAIN (FORMAT JSON) ${sql}`)).getRowsJS()[0]![1])) as unknown;
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== "object") return;
    const o = n as { extra_info?: Record<string, unknown>; children?: unknown[] };
    const info = o.extra_info ?? {};
    if (typeof info.Table === "string" && info.Table.endsWith(`.${table}`)) {
      for (const k of ["Projections", "Filters"]) { const v = info[k]; if (v !== undefined) out.push(...(Array.isArray(v) ? v.map(String) : String(v).split("\n"))); }
    }
    walk(o.children);
  };
  walk(plan);
  assert.ok(out.length > 0, `a scan of ${table} in the plan of ${sql}`);
  return out;
}

test("a READY path is read from its stored column alone: the plan reads no document; a marked row keeps the document until it is gone", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  const pglite = new PGlite();
  try {
    await documents(store, "public.docs", 20);
    await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const { keeper } = await keeperOver(store, kept, { eager: true });
    const plan = async (sql: string, k: Keeper | null) => (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, (await parseSql(sql)).stmts![0]!.stmt as Node,
      0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, k);
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown> => (await reader.runAndReadAll(sql)).getRowsJS() as unknown[][];
    const sql = "SELECT id, j ->> 's' AS s, j -> 'o' AS o, k ->> 'n' AS n, count(*) OVER () FROM docs WHERE j ->> 'n' IS NOT NULL ORDER BY id";
    const [on, off] = [await plan(sql, keeper), await plan(sql, null)];
    // every read stored and exact: the scan reads the stored columns and the key, never j or k
    const cols = await scanned(reader, on.sql.text, "docs");
    assert.deepEqual(cols.filter((c) => /^(j|k)$|\b(j|k)\b(?!_)/.test(c.replace(/__mason_json_[0-9a-f]{12}/g, ""))), [], `the documents are not read: ${cols.join(", ")}\n${on.sql.text}`);
    assert.ok(cols.some((c) => /__mason_json_[0-9a-f]{12}/.test(c)), cols.join(", "));
    assert.ok((await scanned(reader, off.sql.text, "docs")).some((c) => /^j$/.test(c)), "without the stored columns the plan reads j (the measurement is real)");
    assert.deepEqual(await answer(on.sql.text), await answer(off.sql.text), "and answers what the calls answer");

    // a row the function cannot read (DuckDB's JSON takes a trailing comma), written after READY as a write writes it:
    // the detector finds it, and the path's reads go back through the document until it is gone
    const s: Read = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    const h = route.hiddenName(s);
    assert.deepEqual(keeper.ready(s), { name: h, exact: true });
    const value = (kept as unknown as { keptValueSql(p: Read, v: string): string }).keptValueSql(s, "j");
    await store.writer.run(`INSERT INTO public.docs (id, j, k, ${ident(h)}) SELECT 900, '{"s": "x", "n": 1,}'::JSON, NULL, ${value.replace(/\bj\b/, `'{"s": "x", "n": 1,}'::JSON`)}`);
    const gen = keeper.generation();
    for (let i = 0; i < 6; i++) await keeper.review();
    assert.deepEqual(keeper.ready(s), { name: h, exact: false }, "a marked row: not exact");
    assert.ok(keeper.generation() > gen, "the plans that read the column alone are made again");
    const marked = await plan(sql, keeper);
    assert.match(marked.sql.text, new RegExp(`${h} IS NULL OR ${h} = \\(chr\\(0\\) \\|\\| '!'\\) THEN`), marked.sql.text);
    // the marked row is the function's: it raises, as the call does
    const fail = async (q: string): Promise<string> => { try { await answer(q); return "answered"; } catch (e) { return (e as Error).message.replace(/\n[\s\S]*/, ""); } };
    assert.equal(await fail(marked.sql.text), await fail((await plan(sql, null)).sql.text));
    assert.match(await fail(marked.sql.text), /invalid input syntax for type json/);
    await store.writer.run("DELETE FROM public.docs WHERE id = 900");
    for (let i = 0; i < 6; i++) await keeper.review();
    assert.deepEqual(keeper.ready(s), { name: h, exact: true }, "settled: read by its column alone again");
    await keeper.stop();
    reader.closeSync();
  } finally { store.close(); await pglite.close(); }
});

test("a path's spellings and its -> and ->> are ONE stored column, each read from it; an element that reads as an index is not folded", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  const pglite = new PGlite();
  try {
    await documents(store, "public.docs", 20);
    await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const { keeper } = await keeperOver(store, kept, { eager: true });
    const plan = async (sql: string, k: Keeper | null) => (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, (await parseSql(sql)).stmts![0]!.stmt as Node,
      0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, k);
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown[][]> => (await reader.runAndReadAll(sql)).getRowsJS() as unknown[][];
    const hidden = (text: string): string[] => [...new Set(text.match(/__mason_json_[0-9a-f]{12}/g) ?? [])].sort();
    const path = (steps: string, either: boolean, asText: boolean, column = "j", canonical = true): Read => ({ source: "public.docs", column, steps, either, canonical, asText });
    // one path, four reads: #>> and #> of {o,a,b}, and the same keys by -> and ->> (a chain of -> is one read)
    const one = ["j #>> '{o,a,b}'", "j #> '{o,a,b}'", "j -> 'o' -> 'a' ->> 'b'", "j -> 'o' -> 'a' -> 'b'"];
    const names = new Set([path('["o","a","b"]', true, true), path('["o","a","b"]', true, false), path('["o","a","b"]', false, true), path('["o","a","b"]', false, false)].map(route.hiddenName));
    assert.equal(names.size, 1, "one hidden column for the path, whatever the spelling and -> or ->>");
    for (const sql of [`SELECT id, ${one.map((r, i) => `${r} AS r${i}`).join(", ")} FROM docs ORDER BY id`, "SELECT id, k -> 'n' AS a, k ->> 'n' AS b, k #>> '{n}' AS c FROM docs ORDER BY id"]) {
      const on = await plan(sql, keeper);
      assert.equal(hidden(on.sql.text).length, 1, `every read of ${sql} is read from one column: ${on.sql.text}`);
      assert.deepEqual(await answer(on.sql.text), await answer((await plan(sql, null)).sql.text), `${sql}: each read answers what its call answers`);
    }
    // {arr,0}: on an array its first element; -> 'arr' ->> '0' a key, NULL there. Two paths, two answers, each right
    assert.notEqual(route.hiddenName(path('["arr","0"]', true, true)), route.hiddenName(path('["arr","0"]', false, true)));
    const twoSql = "SELECT id, j #>> '{arr,0}' AS by_index, j -> 'arr' ->> '0' AS by_key FROM docs ORDER BY id";
    const two = await plan(twoSql, keeper);
    assert.equal(hidden(two.sql.text).length, 2, two.sql.text);
    const got = await answer(two.sql.text);
    assert.deepEqual(got, await answer((await plan(twoSql, null)).sql.text));
    assert.ok(got.some((r) => r[1] === "10" && r[2] === null), "the index reads the element, the key reads nothing");
    // the ledger and mason status: one row per path, labelled by its -> read
    const rowsOf = keeper.status().filter((p) => p.column === "j" && p.steps === '["o","a","b"]');
    assert.equal(rowsOf.length, 1, JSON.stringify(keeper.status()));
    assert.equal(rowsOf[0]!.either, false);
    const { pathText } = await import("../src/duck/kept-route.ts") as unknown as { pathText(r: unknown): string };
    assert.equal(pathText(rowsOf[0]), "j #> '{o,a,b}'");
    // the request log's keys: each read keeps its -> or ->>, its spelling folded
    assert.equal(route.readKey(path('["o","a","b"]', true, true)), route.readKey(path('["o","a","b"]', false, true)));
    await keeper.stop();
    reader.closeSync();
  } finally { store.close(); await pglite.close(); }
});

test("adding a stored path's column writes no value into its rows, and holds the writer's turn a fraction of a default's", async () => {
  // What this can show on a laptop: the add writes no value (no default, nothing in the file at its commit) and its
  // turn is shorter than the same add with the old default on the same table. What it cannot: the test server's disk
  // (EBS ~128 MB/s, shared with a whole-table read) and its 196.5 M rows; the add is still a pass over the row groups
  // (~3 ns a row here), not O(1). Measured on a laptop over 30 M rows: DEFAULT chr(0) 0.7 - 1.0 s (ALTER, then its
  // COMMIT writing ~4 bytes a row), no default 0.1 s and nothing written at its commit.
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    const N = 4_000_000;
    await store.writer.run("CREATE SCHEMA IF NOT EXISTS public");
    await store.writer.run(`CREATE TABLE public.docs AS SELECT i::INTEGER AS id, ('{"s": "v' || i || '"}')::JSON AS j, NULL::JSON AS k FROM range(${N}) r(i)`);
    await store.writer.run("CHECKPOINT");
    const bytes = (): number => [store.file, `${store.file}.wal`].reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
    // the old add, timed the same way: one transaction, ALTER then COMMIT (best of two)
    const before: Array<{ ms: number; grew: number }> = [];
    for (const c of ["old_a", "old_b"]) {
      const b = bytes(), t = performance.now();
      await store.writer.run("BEGIN TRANSACTION");
      await store.writer.run(`ALTER TABLE public.docs ADD COLUMN ${c} VARCHAR DEFAULT chr(0)`);
      await store.writer.run("COMMIT");
      before.push({ ms: performance.now() - t, grew: bytes() - b });
      await store.writer.run(`ALTER TABLE public.docs DROP COLUMN ${c}`);
      await store.writer.run("CHECKPOINT");
    }
    // the keeper's add: its first writer's turn of a review that stores a path; the backfill is held (a rebuild)
    let holding = false;
    const turns: Array<{ ms: number; grew: number }> = [];
    let turn: Promise<unknown> = Promise.resolve();
    const host = {
      onWriter<T>(f: () => Promise<T>): Promise<T> {
        const t = turn.then(async () => { const b = bytes(), s = performance.now(); try { return await f(); } finally { turns.push({ ms: performance.now() - s, grew: bytes() - b }); holding = true; } });
        turn = t.then(() => undefined, () => undefined); return t;
      },
      served: () => new Map([["public.docs", [{ name: "id", type: "integer" }, { name: "j", type: "jsonb" }, { name: "k", type: "json" }]]]),
      rebuilding: () => holding, log: (): void => undefined,
    };
    const keeper = new kept.KeptJsonPaths(store, host, { enabled: true, reviewMs: 0 });
    await keeper.open();
    const s: Read = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests VALUES ('r', 5000, '${JSON.stringify([route.readKey(s)])}')`);
    await keeper.review();
    const h = route.hiddenName(s);
    assert.deepEqual(await rows(store, `SELECT column_default FROM duckdb_columns() WHERE table_name = 'docs' AND column_name = '${h}'`), [[null]], "the column is added with no default");
    const add = turns[0]!;
    const old = before.reduce((a, b) => a.ms <= b.ms ? a : b);
    assert.ok(before.every((b) => b.grew > N), `the old add wrote its default into the file at its commit (${before.map((b) => b.grew).join(", ")} bytes): the measurement sees a write`);
    assert.ok(add.grew < N / 8, `the add wrote no value at its commit (${add.grew} bytes; the old add ${old.grew})`);
    assert.ok(add.ms < old.ms, `the add's turn (${add.ms.toFixed(0)} ms) is shorter than the old add's (${old.ms.toFixed(0)} ms)`);
    assert.equal(keeper.status()[0]?.state, "backfilling");
    await keeper.stop();
  } finally { store.close(); }
});

test("the policy weighs a path's reads against its fill's estimate; a path the cost holds back says so", async () => {
  const { kept, route } = await modules();
  const k = kept as unknown as {
    decide(c: { statements: number; slowestMs: number; totalMs: number }, fill: { rows: number; bytesPerRow: number; seconds: number }): { keep: boolean; held: boolean; why: string };
    fillEstimate(rows: number, bytesPerRow: number): { rows: number; bytesPerRow: number; seconds: number };
    SMALL_FILL_SECONDS: number;
  };
  assert.equal(typeof k.decide, "function", "src/duck/kept.ts decides by the fill's cost (decide)");
  // THE MODEL AGAINST EVERY MEASURED FILL, within 2× (src/duck/kept.ts FILL_US_PER_ROW): a laptop's 30 M rows of ~2.3 KB
  // documents, ~329 B a row on disk, filled in 558 s; the test server's 196.5 M rows in 3,606 s (the `->` key) and
  // 5,640 s (before it), its column's bytes on disk a row not known here: anywhere from its whole table's (~260 B under
  // zstd) to the ~2.5 KB a row the fill read. The text model said 16 min 48 s for the server's.
  const within2 = (estimate: number, measured: number): boolean => estimate <= 2 * measured && measured <= 2 * estimate;
  const laptop = k.fillEstimate(30_000_000, 328.5);
  assert.ok(within2(laptop.seconds, 558), `the laptop's fill: ${laptop.seconds.toFixed(0)} s against 558 s`);
  for (const bytes of [260, 660, 2_500]) for (const measured of [3_606, 5_640]) {
    const e = k.fillEstimate(196_500_000, bytes);
    assert.ok(within2(e.seconds, measured), `the server's fill at ${bytes} B a row on disk: ${e.seconds.toFixed(0)} s against ${measured} s`);
  }
  // the test server's large table, its column taken at ~660 B a row on disk (its JSON text uncompressed, 0.66 GB a
  // million rows: src/duck/store.ts)
  const large = k.fillEstimate(196_500_000, 660);
  const one = k.decide({ statements: 1, slowestMs: 3_500, totalMs: 3_500 }, large);
  assert.deepEqual([one.keep, one.held], [false, true], "one 3.5 s read of a 7-day window does not start an hour's fill");
  assert.match(one.why, /not stored: read by 1 statement taking 3\.5 s in all, and its fill estimated at (1 h )?\d+ min( \d+ s)?: 196,500,000 row\(s\) of ~660 bytes of JSON on disk \(modelled\)/);
  assert.deepEqual([k.decide({ statements: 3, slowestMs: 3_500, totalMs: 10_500 }, large).keep], [false], "nor three");
  const whole = k.decide({ statements: 3, slowestMs: 192_600, totalMs: 3 * 192_600 }, large);
  assert.equal(whole.keep, true, `three whole-table reads (192.6 s each) pay a tenth of it: ${whole.why}`);
  assert.equal(k.decide({ statements: 1, slowestMs: 192_600, totalMs: 192_600 }, large).keep, false, "one, however slow, never does on a large table");
  // a small table keeps the old rule: three statements, or one that took a second
  const small = k.fillEstimate(1_000_000, 300);
  assert.ok(small.seconds < k.SMALL_FILL_SECONDS, String(small.seconds));
  assert.equal(k.decide({ statements: 1, slowestMs: 1_200, totalMs: 1_200 }, small).keep, true);
  assert.equal(k.decide({ statements: 3, slowestMs: 5, totalMs: 15 }, small).keep, true);
  assert.deepEqual(Object.values(k.decide({ statements: 2, slowestMs: 5, totalMs: 10 }, small)).slice(0, 2), [false, false], "an ad-hoc read: not stored, not held");

  // the keeper writes the decision: a path the cost holds back is `waiting`, with the estimate, and no column
  const store = await newStore();
  try {
    await documents(store, "public.docs", 10);
    const { keeper } = await keeperOver(store, kept, { estimate: () => large });
    const s: Read = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    const log = async (n: number, ms: number): Promise<void> => store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests VALUES ${Array.from({ length: n }, () => `('r', ${ms}, '${JSON.stringify([route.readKey(s)])}')`).join(", ")}`).then(() => undefined);
    await log(1, 3_500);
    await reviewed(keeper);
    const waiting = keeper.status();
    assert.deepEqual(waiting.map((p) => p.state), ["waiting"]);
    assert.match(waiting[0]!.why, /not stored: .*196,500,000 row/);
    assert.deepEqual(await rows(store, `SELECT state, fill_rows, fill_bytes_per_row, round(fill_seconds) > 1800 FROM ${MASON_SCHEMA}.json_paths`), [["waiting", 196_500_000n, 660n, true]]);
    assert.deepEqual(await rows(store, `SELECT count(*) FROM duckdb_columns() WHERE starts_with(column_name, '__mason_json_')`), [[0n]], "no column");
    assert.equal(keeper.ready(s), null);
    const { jsonPathLines } = await import("../src/cli/commands.ts") as unknown as { jsonPathLines(p: unknown[], st: unknown): string[] };
    const plain = new Proxy({}, { get: () => (x: string) => x });
    assert.match(jsonPathLines(keeper.status(), plain).join("\n"), /public\.docs {2}j -> 's' {2}waiting {2}not stored: /);
    // the reads come to a tenth of the fill: stored
    await log(3, 200_000);
    await reviewed(keeper);
    assert.deepEqual(keeper.status().map((p) => p.state), ["ready"]);
    assert.match(keeper.status()[0]!.why, /read by 4 statements taking 10 min 3.5 s in all|read by 4 statements taking 10 min 4 s in all/);
    await keeper.stop();
  } finally { store.close(); }
});

type Fill = { rows: number; bytesPerRow: number; seconds: number; basis?: string; rowsPerSecond?: number | null };
type Measured = KeptPath & { fill: Fill | null; filled?: { rows: number; seconds: number } | null; queued?: boolean; readyAt: string | null };

test("a fill's estimate is modelled from its JSON column's bytes on disk, then from the rate the last fill of that column measured", async () => {
  // On the test server the text model priced a 196.6 M-row fill at 16 min 48 s (~313 B of text a row) and it took
  // 60 – 94 min: the fill's cost follows the column's bytes ON DISK, and a fill that ran is the better evidence.
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    // ~2 KB of text a row that compresses to a few bytes: priced by its text, the fill looked far dearer than it is
    const N = 30_000;
    await store.writer.run("CREATE SCHEMA IF NOT EXISTS public");
    await store.writer.run(`CREATE TABLE public.docs AS SELECT i::INTEGER AS id, ('{"s": "v' || i || '", "t": "w' || i || '", "u": ' || i || ', "pad": "' || repeat('x', 2000) || '"}')::JSON AS j, ` +
      `NULL::JSON AS k FROM range(${N}) r(i)`);
    await store.writer.run("CHECKPOINT");
    const text = Number(await one(store, "SELECT avg(strlen(j::VARCHAR)) FROM public.docs"));
    const { keeper } = await keeperOver(store, kept, { backfillRows: 10_000 });
    const path = (key: string): Read => ({ source: "public.docs", column: "j", steps: `["${key}"]`, either: false, canonical: true, asText: true });
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    const log = (r: Read, n: number, ms: number): Promise<unknown> =>
      store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests VALUES ${Array.from({ length: n }, () => `('r', ${ms}, '${JSON.stringify([route.readKey(r)])}')`).join(", ")}`);
    const of = (r: Read): Measured => (keeper.status() as Measured[]).find((p) => p.name === route.hiddenName(r))!;

    // the first fill of j: modelled from its bytes on disk
    await log(path("s"), 3, 5);
    await reviewed(keeper);
    const first = of(path("s"));
    assert.equal(first.state, "ready", first.why);
    assert.equal(first.fill?.basis, "disk", `the estimate is modelled from the column's bytes on disk: ${JSON.stringify(first.fill)}`);
    assert.ok(first.fill!.bytesPerRow > 0 && first.fill!.bytesPerRow < text / 10, `the column's bytes on disk a row (${first.fill!.bytesPerRow.toFixed(1)}), not its text's (${text.toFixed(0)})`);
    assert.match(first.why, /bytes of JSON on disk \(modelled\)/);
    assert.ok(first.filled !== null && first.filled !== undefined && first.filled.rows === N && first.filled.seconds > 0, `the fill measured itself: ${JSON.stringify(first.filled)}`);
    assert.deepEqual(await rows(store, `SELECT fill_basis, filled_rows, filled_seconds > 0 FROM ${MASON_SCHEMA}.json_paths WHERE name = '${first.name}'`), [["disk", BigInt(N), true]], "in the ledger");

    // another path of the same column: estimated from that fill's rate
    await log(path("t"), 1, 1_200);
    await reviewed(keeper);
    const second = of(path("t"));
    const rate = N / first.filled!.seconds;
    assert.equal(second.fill?.basis, "measured", JSON.stringify(second.fill));
    assert.ok(Math.abs(second.fill!.rowsPerSecond! - rate) / rate < 1e-9, `the last fill's rate (${second.fill!.rowsPerSecond} against ${rate})`);
    assert.ok(Math.abs(second.fill!.seconds - N / rate) / (N / rate) < 1e-9);
    assert.match(second.why, new RegExp(`estimated at .* from the last fill of its column: ${N.toLocaleString("en-US")} row\\(s\\) at [\\d,]+ rows/s`));
    assert.deepEqual(await rows(store, `SELECT fill_basis, round(fill_rows_per_second) = round(${rate}) FROM ${MASON_SCHEMA}.json_paths WHERE name = '${second.name}'`), [["measured", true]]);
    const { jsonPathLines } = await import("../src/cli/commands.ts") as unknown as { jsonPathLines(p: unknown[], st: unknown): string[] };
    const plain = new Proxy({}, { get: () => (x: string) => x });
    assert.match(jsonPathLines(keeper.status(), plain).join("\n"), /j -> 't' {2}ready {2}.*from the last fill of its column/, "mason status says which the estimate is");
    await keeper.stop();

    // after a restart, from the ledger
    const { keeper: again } = await keeperOver(store, kept, { backfillRows: 10_000 });
    await log(path("u"), 3, 5);
    await reviewed(again);
    const third = (again.status() as Measured[]).find((p) => p.name === route.hiddenName(path("u")))!;
    assert.equal(third.fill?.basis, "measured", "the measured rate survives a restart");
    await again.stop();
  } finally { store.close(); }
});

test("a review runs while a fill runs: the waiting rows' evidence is current, and a path decided meanwhile is queued behind the fill", async () => {
  // The test server: one review filled to its end, so for the fill's hour the waiting rows kept their old counts ("1
  // statement, 1.2 s" after 4 statements) and a path that qualified was stored only at the next restart's review.
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    await documents(store, "public.docs", 2_000);
    const total = 2_000 * SHAPES.length + 1;
    // every writer's turn a few ms longer, so the fill (a turn a chunk of 100 rows) outlasts a review by far
    let slow = 0;
    let turn: Promise<unknown> = Promise.resolve();
    const host = {
      logged: [] as string[],
      onWriter<T>(f: () => Promise<T>): Promise<T> { const t = turn.then(() => new Promise((r) => setTimeout(r, slow))).then(f); turn = t.then(() => undefined, () => undefined); return t; },
      served: () => new Map([["public.docs", [{ name: "id", type: "integer" }, { name: "j", type: "jsonb" }, { name: "k", type: "json" }]]]),
      rebuilding: () => false,
      log(l: string) { this.logged.push(l); },
    };
    const small = kept as unknown as { fillEstimate(rows: number, bytes: number): Fill };
    const filling: Read = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    const held: Read = { ...filling, steps: '["n"]' };
    const later: Read = { ...filling, steps: '["o"]' };
    // `held`'s table priced as the test server's: waiting; the others small
    const estimate = (r: Read): Fill => small.fillEstimate(r.steps === held.steps ? 196_500_000 : total, 2_500);
    const keeper = new kept.KeptJsonPaths(store, host, { enabled: true, reviewMs: 0, backfillRows: 100, estimate });
    await keeper.open();
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    const log = (r: Read, n: number, ms: number): Promise<unknown> =>
      store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests VALUES ${Array.from({ length: n }, () => `('r', ${ms}, '${JSON.stringify([route.readKey(r)])}')`).join(", ")}`);
    const of = (r: Read): Measured | undefined => (keeper.status() as Measured[]).find((p) => p.name === route.hiddenName(r));
    await log(filling, 3, 5);
    await log(held, 1, 1_200);
    slow = 3;
    await keeper.review();
    assert.equal(of(filling)?.state, "backfilling", "the review stored a path and did not wait for its fill");
    assert.ok(of(filling)!.rowsDone < total, `its fill is under way (${of(filling)!.rowsDone} of ${total})`);
    assert.equal(of(held)?.state, "waiting");
    assert.equal(of(held)?.statements, 1);

    // while it fills: more reads of the held path, and a new path qualifies
    await log(held, 3, 1_500);
    await log(later, 3, 5);
    await keeper.review();
    assert.equal(of(filling)?.state, "backfilling", "the second review ran during the fill");
    assert.equal(of(held)?.statements, 4, "the waiting row's evidence is today's");
    assert.match(of(held)!.why, /read by 4 statements taking 5\.7 s in all/);
    assert.deepEqual(await rows(store, `SELECT statements, total_ms FROM ${MASON_SCHEMA}.json_paths WHERE name = '${route.hiddenName(held)}'`), [[4n, 5_700n]], "in the ledger too");
    assert.equal(of(later)?.state, "backfilling", "a path decided during the fill has its column");
    assert.equal(of(later)?.rowsDone, 0);
    assert.equal(of(later)?.queued, true, "and is queued behind the fill under way");
    assert.equal(of(filling)?.queued, false);
    const { jsonPathLines } = await import("../src/cli/commands.ts") as unknown as { jsonPathLines(p: unknown[], st: unknown): string[] };
    const plain = new Proxy({}, { get: () => (x: string) => x });
    assert.match(jsonPathLines(keeper.status(), plain).join("\n"), /j -> 'o' {2}queued, filled after the fill under way/);

    slow = 0;
    await (keeper as unknown as { fills(): Promise<void> }).fills();
    assert.deepEqual([of(filling)?.state, of(later)?.state], ["ready", "ready"], host.logged.join("\n"));
    assert.ok(of(filling)!.readyAt! <= of(later)!.readyAt!, "the queued one filled after");
    for (const p of [of(filling)!, of(later)!]) assert.equal(await one(store, `SELECT count(*) FROM public.docs WHERE ${ident(p.name)} IS NULL`), 0n, p.name);
    await keeper.stop();
  } finally { store.close(); }
});
