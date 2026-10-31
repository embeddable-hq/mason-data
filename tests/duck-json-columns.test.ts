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
import { planDuck, type PlanOptions } from "../src/duck/plan.ts";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import type { AddedTable } from "../src/duck/sync.ts";
import type { Source } from "../src/cli/preflight.ts";
import type { Node } from "libpg-query";
import type { LibcOrder } from "../src/duck/libc-order.ts";
import { handLibcOrder, lettersOf } from "./libc-order-fixture.ts";

/** planDuck over a stand-in for the stored paths (the test's keeper, or none) */
const planKept = planDuck as (o: Omit<PlanOptions, "kept"> & { kept: unknown }) => ReturnType<typeof planDuck>;

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
  /** the collation a jsonb's key is stored under (absent before a jsonb's order was stored) */
  orderBy?(collation: unknown, libc: unknown): Promise<void>;
  fillSide(c: unknown, source: string, side: string, columns: readonly string[], run: (sql: string) => Promise<number>): Promise<void>;
  removed(source: string): Promise<void>;
};
type KeptModule = {
  KeptJsonPaths: new (store: DuckStore, host: unknown, options: Record<string, unknown>) => Keeper;
  KEEP_AFTER_STATEMENTS: number; KEEP_AFTER_MS: number;
  /** a stored key's id: its collation's, its encoding's and its DuckDB's (`versions`; absent before they were named) */
  orderId?(collation: unknown, libc: unknown, versions?: string): string;
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
  const kept = await load("../src/duck/kept.ts") as KeptModule;
  cKey = `order:${kept.orderId?.({ kind: "bytes" }, undefined) ?? "c"}`;
  return { kept, route: await load("../src/duck/kept-route.ts") as RouteModule };
}
/** a jsonb's key stored under C, as the keeper names its steps (`modules` reads it) */
let cKey = "order:c";

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
      // the turn of a write (src/duck/kept.ts), over every row: a NULL session of VARCHAR, and the stored value the call's
      const [turnNotNull, turned] = (await rows(store,
        `SELECT count(*) FILTER (__mason_turn(NULL, j) IS NOT NULL), count(*) FILTER (${(await import("../src/duck/kept.ts")).keptValueSql({ ...r, source: "public.docs", column: "j" }, "j")} IS DISTINCT FROM ${kept}) FROM public.docs`))[0] as bigint[];
      assert.equal(turnNotNull, 0n, "a NULL session stays NULL through the turn, on every row");
      assert.equal(turned, 0n, `the stored value through the turn differs from the call's for ${JSON.stringify(r)}`);
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
      return planKept({ catalog, text: sql, stmt: stmt, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null, kept: keeper });
    };
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown[][]> => (await reader.runAndReadAll(sql)).getRowsJS() as unknown[][];
    const sql = "SELECT id, j ->> 's' AS s, j #>> '{o,a,b,1}' AS deep, d.j -> 'arr' -> 0 AS first FROM docs d WHERE j ->> 'n' IS NOT NULL ORDER BY id";
    const s = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    // with the feature off nothing is read from a column, and the reads are still what the function computes
    const off = await planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null, kept: null });
    assert.doesNotMatch(off.sql.text, /__mason_json_[0-9a-f]{12}/);
    // eager (the oracle's): each read stored before the plan is made, then read from its column
    const on = await plan(sql);
    const reads = (on as unknown as { jsonReads?: readonly string[] }).jsonReads ?? [];
    assert.ok(reads.includes(route.readKey(s)), `the statement's reads are recorded: ${reads.join(" | ")}`);
    assert.equal(reads.length, 4, "->> 's', #>> '{o,a,b,1}', -> 'arr' -> 0 (one read: the chain is folded, jsonChain) and ->> 'n'");
    // read from the column alone: a ->> derived from the stored -> answer, a -> the column with its NULL mark
    assert.match(on.sql.text, new RegExp(`CASE WHEN ${route.hiddenName(s)} = chr\\(0\\) OR ${route.hiddenName(s)} = 'null' THEN NULL`), on.sql.text);
    // a qualified column is read through its qualifier, and a chain of reads off it is one stored path
    // (a row marked since it was counted exact raises, never read as its value: kept-route.ts markedError)
    assert.match(on.sql.text, /CASE WHEN d\.(__mason_json_[0-9a-f]{12}) = \(chr\(0\) \|\| '!'\) THEN __mason_marked_value\(__mason_turn\(getvariable\('__mason_session'\), d\.\1\), d\.\1, 'XX000', '(?:[^']|'')*'\) ELSE CASE WHEN d\.\1 = chr\(0\) THEN NULL ELSE d\.\1 END END AS first/, on.sql.text);
    // and no document is named: the function and DuckDB's own read are of the stored text, never of j
    assert.doesNotMatch(on.sql.text, /\(getvariable\('__mason_session'\), (d\.)?j[,)]|json_type\((d\.)?j,/, on.sql.text);
    assert.deepEqual(await answer(on.sql.text), await answer(off.sql.text), "the stored reads answer what the calls answer");
    // a read whose path is not ready is the call: a keeper that knows no path
    const { keeper: empty } = await keeperOver(await newStore(), kept, {});
    const cold = await planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null, kept: empty });
    assert.doesNotMatch(cold.sql.text, /__mason_json_[0-9a-f]{12}/);
    assert.equal(((cold as unknown as { jsonReads?: readonly string[] }).jsonReads ?? []).length, 4, "recorded even when none is stored");
    await empty.stop();
    // a statement that lists the columns without naming them: the view, and the reads computed
    for (const listing of ["SELECT * FROM docs ORDER BY id", "SELECT d.*, j ->> 's' FROM docs d ORDER BY id", "SELECT x.* FROM docs x JOIN docs y USING (id) ORDER BY 1", "SELECT x.*, y.id FROM docs x JOIN docs y ON y.id = x.id LIMIT 5", "SELECT x.*, y.id FROM docs x JOIN docs y ON y.id = x.id ORDER BY x.id LIMIT 5", "SELECT * FROM docs x JOIN docs y ON y.id = x.id ORDER BY x.id DESC LIMIT 5",
      "SELECT *, j ->> 's' FROM public.docs NATURAL JOIN (SELECT 1 AS id) x", "WITH w AS (SELECT * FROM docs) SELECT * FROM w ORDER BY id"]) {
      const p = await plan(listing);
      // its text names the view (`__mason_visible`); what it calls is the plan's, the calls in its text and nothing
      // else (once read off the text, a * was a calling statement, and no timeout or cancel stopped it)
      const functions = (p.sql as unknown as { functions?: readonly string[] }).functions;
      assert.deepEqual(functions, [...new Set(p.sql.text.match(/\b__mason_(?!turn\()[a-z0-9_]+(?=\()/g) ?? [])].sort(), `${listing}: the functions it calls`);
      if (!/->>/.test(listing)) assert.deepEqual(functions, [], `${listing} calls no Mason function`);
      assert.doesNotMatch(p.sql.text, /__mason_json_[0-9a-f]{12}/, listing);
      // a top N over joins and a * over USING or NATURAL have their * written out, so no hidden column can be listed
      if (!/JOIN docs y|NATURAL/.test(listing)) assert.match(p.sql.text, new RegExp(route.VISIBLE_CATALOG), listing);
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
    const plan = async (sql: string, k: Keeper | null) => planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null, kept: k });
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
async function syncWithStored(reads: Read[], kind: "C" | "libc" = "C") {
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
  // the collation a jsonb's key is stored under, as the listener tells it at its start (C: the key is the bytes'; a
  // libc one: its equality is the C key, a column of its own)
  if (kind === "C") await sync.kept.orderBy?.({ kind: "bytes" }, undefined);
  else await sync.kept.orderBy?.({ kind: "libc", icu: "en_us" }, smallLibcOrder());
  await sync.kept.keepNow(reads);
  for (const r of reads) assert.equal(readyName(sync.kept.ready(r)), route.hiddenName(storedAs(r)), `${r.steps} is stored`);
  await sync.stop();
  await sync.setTables([DOCS]);
  return { store, sync: sync as unknown as SyncInside, logged, route };
}

/** each stored column of `public.docs` equal to the function on every row, none unset */
async function current(store: DuckStore, reads: Read[], route: RouteModule): Promise<void> {
  for (const r of reads) {
    const h = ident(route.hiddenName(storedAs(r)));
    // a jsonb's key: the key's function under C (src/duck/rewrite.ts jsonbKeyCall), its NULL mark a NULL; its C key
    // for equality under libc the same function
    const [stored, computed] = r.steps === "order" || r.steps === "equal" ? [`CASE WHEN ${h} = unhex('00') THEN NULL ELSE ${h} END`, `__mason_jsonb_key(NULL, ${ident(r.column)})`]
      : [fromColumn(h, r), `__mason_json_get(NULL, ${ident(r.column)}, ${args(r)})`];
    const [n, unset, wrong] = (await rows(store, `SELECT count(*), count(*) FILTER (${h} IS NULL), count(*) FILTER (${stored} IS DISTINCT FROM ${computed}) FROM public.docs`))[0] as bigint[];
    assert.ok(n! > 0n);
    assert.deepEqual([unset, wrong], [0n, 0n], `${r.column} ${r.steps}: ${unset} unset, ${wrong} not the function's`);
  }
}

const STORED: Read[] = [
  { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true },
  { source: "public.docs", column: "j", steps: '["o","a","b"]', either: true, canonical: true, asText: false },
  { source: "public.docs", column: "k", steps: '["n"]', either: false, canonical: false, asText: true },
  // j's jsonb order (ORDER BY j, GROUP BY j, j = k): its key
  { source: "public.docs", column: "j", steps: "order", either: false, canonical: true, asText: false },
];

/** under a libc collation (`syncWithStored(…, "libc")`): the paths, and j's equality (GROUP BY j, DISTINCT j, j = k,
 *  j IN (…)): the C key, a second column beside the order's (src/duck/kept-route.ts EQUAL_STEPS) */
const EQUAL: Read = { source: "public.docs", column: "j", steps: "equal", either: false, canonical: true, asText: false };
const STORED_LIBC: Read[] = [...STORED.slice(0, 3), EQUAL];

/** a read as the keeper stores it: a jsonb's order under the collation it was told (C: `orderBy` above); its equality
 *  under libc as the C key (`equal:` and the C key's id, the C order's) */
const storedAs = (r: Read): Read => r.steps === "order" ? { ...r, steps: cKey } : r.steps === "equal" ? { ...r, steps: `equal:${cKey.slice("order:".length)}` } : r;
/** each write path's test, under C (the order's key) and under libc (the C key for equality) */
const KINDS = [["C", STORED], ["libc", STORED_LIBC]] as const;

test("the stream's write by key and its unchanged-TOAST updates compute each stored path", async () => {
  for (const [kind, reads] of KINDS) {
    const { store, sync, route } = await syncWithStored([...reads], kind);
    try {
      const change = (key: number, values: Array<string | null | undefined>) => [JSON.stringify([String(key)]), { key: [String(key)], change: { kind: "row", values } }] as const;
      const batch = (...changes: Array<readonly [string, unknown]>) => new Map([["public.docs", { columns: ["id", "j", "k"], truncated: false, keys: new Map(changes), counts: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } }]]);
      // an insert, an update of a row there, a delete
      await sync.applyChanges(batch(
        change(100_000, ["100000", '{"s": "new", "o": {"a": {"b": [9]}}}', '{"n": 1.50}']),
        change(3, ["3", '{"s": "changed"}', '{"n": "x"}']),
        [JSON.stringify(["4"]), { key: ["4"], change: { kind: "delete" } }],
      ), { lsn: null, committedAt: null });
      await current(store, [...reads], route);
      assert.equal(await one(store, `SELECT ${ident(route.hiddenName(reads[0]!))} FROM public.docs WHERE id = 3`), '"changed"', kind);
      // an UPDATE that left j unchanged (TOAST, not sent): k carried, j's stored paths as they were
      await sync.applyChanges(batch(change(100_000, ["100000", undefined, '{"n": 2.25}'])), { lsn: null, committedAt: null });
      assert.equal(await one(store, `SELECT ${ident(route.hiddenName(reads[2]!))} FROM public.docs WHERE id = 100000`), "2.25", kind);
      assert.equal(await one(store, `SELECT ${ident(route.hiddenName(reads[0]!))} FROM public.docs WHERE id = 100000`), '"new"', kind);
      // and one that carried j, leaving k unsent
      await sync.applyChanges(batch(change(100_000, ["100000", '{"s": "carried", "o": {"a": {"b": {"c": 1}}}}', undefined])), { lsn: null, committedAt: null });
      assert.equal(await one(store, `SELECT ${ident(route.hiddenName(reads[0]!))} FROM public.docs WHERE id = 100000`), '"carried"', kind);
      assert.equal(await one(store, `SELECT ${ident(route.hiddenName(reads[1]!))} FROM public.docs WHERE id = 100000`), '{"c": 1}', kind);
      await current(store, [...reads], route);
    } finally { store.close(); }
  }
});

test("the poll's write by key computes each stored path, a whole stage or a piece of it", async () => {
  for (const [kind, reads] of KINDS) {
    const { store, sync, route } = await syncWithStored([...reads], kind);
    try {
      const writeStaged = (syncModule as unknown as { writeStaged: (...a: unknown[]) => Promise<void> }).writeStaged;
      // the poll's stage: the changed rows, columns by position
      await store.writer.run(`CREATE TEMP TABLE stage AS SELECT * FROM (VALUES (5, '{"s": "polled"}'::JSON, '{"n": 3}'::JSON), (200000, '{"s": "polled new"}'::JSON, NULL::JSON)) v(c0, c1, c2)`);
      await writeStaged(store.writer, DOCS, "public.docs", "temp.main.stage", " WHERE rowid >= 0 AND rowid < 1", sync.kept);
      await writeStaged(store.writer, DOCS, "public.docs", "temp.main.stage", " WHERE rowid >= 1 AND rowid < 2", sync.kept);
      assert.deepEqual(await rows(store, `SELECT id, ${ident(route.hiddenName(reads[0]!))} FROM public.docs WHERE id IN (5, 200000) ORDER BY id`), [[5, '"polled"'], [200000, '"polled new"']], kind);
      await current(store, [...reads], route);
    } finally { store.close(); }
  }
});

test("a copy's side table gets every stored path before its swap; a column the new copy lacks drops its paths", async () => {
  for (const [kind, reads] of KINDS) {
    const { store, sync, route } = await syncWithStored([...reads], kind);
    try {
      // a copy of the table again: its side table, as the copy's chunks fill it
      await store.writer.run(`CREATE TABLE public.docs__mason_copy AS SELECT id + 1 AS id, j, k FROM public.docs`);
      await sync.kept.fillSide(store.writer, "public.docs", "public.docs__mason_copy", ["id", "j", "k"], async (sql) => Number((await store.writer.run(sql)).rowsChanged));
      await sync.onWriter(() => sync.swap(DOCS, "public.docs__mason_copy", { snapshot: null, behind: null }));
      await current(store, [...reads], route);
      assert.deepEqual(sync.kept.status().map((p) => p.state), reads.map(() => "ready"), kind);
      // copied again without k: its path goes with it, j's stay
      const noK = { ...DOCS, columns: DOCS.columns.filter((c) => c.name !== "k") };
      await store.writer.run(`CREATE TABLE public.docs__mason_copy AS SELECT id, j FROM public.docs`);
      await sync.kept.fillSide(store.writer, "public.docs", "public.docs__mason_copy", ["id", "j"], async (sql) => Number((await store.writer.run(sql)).rowsChanged));
      await sync.onWriter(() => sync.swap(noK, "public.docs__mason_copy", { snapshot: null, behind: null }));
      const state = new Map(sync.kept.status().map((p) => [p.column + p.steps, p]));
      assert.equal(state.get(`k${reads[2]!.steps}`)?.state, "dropped", kind);
      assert.match(state.get(`k${reads[2]!.steps}`)!.why, /k is no longer a column/);
      assert.equal(sync.kept.ready(reads[2]!), null, kind);
      await current(store, reads.filter((r) => r.column === "j"), route);
      // the view lists the new copy's columns
      assert.deepEqual(await rows(store, `SELECT column_name FROM duckdb_columns() WHERE database_name = '${route.VISIBLE_CATALOG}' AND table_name = 'docs' ORDER BY column_index`), [["id"], ["j"]]);
    } finally { store.close(); }
  }
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
    const plan = async (sql: string, k: Keeper | null) => planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null, kept: k });
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown> => (await reader.runAndReadAll(sql)).getRowsJS() as unknown[][];
    const sql = "SELECT id, j ->> 's' AS s, j -> 'o' AS o, k ->> 'n' AS n, count(*) OVER () FROM docs WHERE j ->> 'n' IS NOT NULL ORDER BY id";
    const [on, off] = [await plan(sql, keeper), await plan(sql, null)];
    // every read stored and exact: the scan reads the stored columns and the key, never j or k
    const cols = await scanned(reader, on.sql.text, "docs");
    assert.deepEqual(cols.filter((c) => /^(j|k)$|\b(j|k)\b(?!_)/.test(c.replace(/__mason_json_[0-9a-f]{12}/g, "").replace(/'(?:[^']|'')*'/g, "''"))), [], `the documents are not read: ${cols.join(", ")}\n${on.sql.text}`);
    assert.ok(cols.some((c) => /__mason_json_[0-9a-f]{12}/.test(c)), cols.join(", "));
    assert.ok((await scanned(reader, off.sql.text, "docs")).some((c) => /^j$/.test(c)), "without the stored columns the plan reads j (the measurement is real)");
    assert.deepEqual(await answer(on.sql.text), await answer(off.sql.text), "and answers what the calls answer");

    // a row the function cannot read (DuckDB's JSON takes a trailing comma), written after READY as a write writes it:
    // the detector finds it, and the path's reads go back through the document until it is gone
    const s: Read = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    const h = route.hiddenName(s);
    assert.deepEqual(keeper.ready(s), { name: h, exact: true });
    const value = (kept as unknown as { keptValueSql(p: Read, v: string): string }).keptValueSql(s, "j");
    await store.writer.run(`INSERT INTO public.docs (id, j, k, ${ident(h)}) SELECT 900, '{"s": "x", "n": 1,}'::JSON, NULL, ${value.replace(/\bj\b/g, `'{"s": "x", "n": 1,}'::JSON`)}`);
    // before the detector counts it the read is still exact, and the mark is never read as the row's value: it raises
    const fail = async (q: string): Promise<string> => { try { await answer(q); return "answered"; } catch (e) { return (e as Error).message.replace(/\n[\s\S]*/, ""); } };
    assert.deepEqual(keeper.ready(s), { name: h, exact: true }, "not counted yet");
    const uncounted = await plan("SELECT id, j ->> 's' AS s FROM docs ORDER BY id", keeper);
    assert.match(await fail(uncounted.sql.text), /mason\[XX000\]: a stored value of j ->> 's' could not be computed .*Mason bug/, "the mark is not answered as the value");
    assert.deepEqual(await answer((await plan("SELECT id, j ->> 's' AS s FROM docs WHERE id <> 900 ORDER BY id", keeper)).sql.text),
      await answer((await plan("SELECT id, j ->> 's' AS s FROM docs WHERE id <> 900 ORDER BY id", null)).sql.text), "the rows without it answered");
    const gen = keeper.generation();
    for (let i = 0; i < 6; i++) await keeper.review();
    assert.deepEqual(keeper.ready(s), { name: h, exact: false }, "a marked row: not exact");
    assert.ok(keeper.generation() > gen, "the plans that read the column alone are made again");
    const marked = await plan(sql, keeper);
    assert.match(marked.sql.text, new RegExp(`${h} IS NULL OR ${h} = \\(chr\\(0\\) \\|\\| '!'\\) THEN`), marked.sql.text);
    // the marked row is the function's: it raises, as the call does
    assert.equal(await fail(marked.sql.text), await fail((await plan(sql, null)).sql.text));
    assert.match(await fail(marked.sql.text), /invalid input syntax for type json/);
    await store.writer.run("DELETE FROM public.docs WHERE id = 900");
    for (let i = 0; i < 6; i++) await keeper.review();
    assert.deepEqual(keeper.ready(s), { name: h, exact: true }, "settled: read by its column alone again");
    await keeper.stop();
    reader.closeSync();
  } finally { store.close(); await pglite.close(); }
});

// A JSONB'S ORDER STORED (src/duck/kept-route.ts ORDER_STEPS): `ORDER BY j` over 20 M rows took 19 s through the key's
// function under C and 83 s under a libc locale, 0.1 s from a stored key (the PR's measurement)
test("a jsonb's order is stored as its key: the function's on every row under C, ICU and a libc order, sorted from it alone, a key that raised computed when read", async () => {
  const { kept, route } = await modules();
  const order: Read = { source: "public.docs", column: "j", steps: "order", either: false, canonical: true, asText: false };
  const each = (strings: string) => `list_transform(${strings}(NULL, j), __mason_s -> icu_sort_key(__mason_s, 'en_us'))`;
  const kinds = [
    { name: "C", collation: undefined, libc: undefined, key: "__mason_jsonb_key(NULL, j)", marked: 0 },
    { name: "ICU", collation: { provider: "i", collate: "en-US", locale: "en-US" }, libc: undefined, key: `__mason_jsonb_key_icu(NULL, j, ${each("__mason_jsonb_strings")})`, marked: 0 },
    // the small order covers letters, digits and the space: a string holding U+0000 (SHAPES' NUL row) is not covered,
    // its key raises (libc-uncovered), and the row is marked to be computed when read
    { name: "libc", collation: { provider: "c", collate: "en_US.utf8", locale: null }, libc: smallLibcOrder(), key: "__mason_jsonb_key_libc(NULL, j)", marked: 20 },
  ];
  for (const k of kinds) {
    const store = await newStore();
    const pglite = new PGlite();
    try {
      await documents(store, "public.docs", 20);
      await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
      const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
      const { keeper } = await keeperOver(store, kept, { eager: true });
      // the listener tells the keeper its collation (and registers the libc order's functions)
      const listener = await store.listener(k.collation, null, k.libc, () => [], keeper as never);
      const plan = async (sql: string, kk: Keeper | null) => planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: listener.collation, verified: null, kept: kk });
      const reader = await store.instance.connect();
      await reader.run("SET search_path = 'public'");
      const answer = async (sql: string): Promise<unknown> => { try { return (await reader.runAndReadAll(sql)).getRowsJS(); } catch (e) { return (e as Error).message.replace(/\n[\s\S]*/, ""); } };
      const sorted = "SELECT id FROM docs ORDER BY j DESC, id";
      const [on, off] = [await plan(sorted, keeper), await plan(sorted, null)];
      const hidden = (await rows(store, "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_')")) as string[][];
      assert.equal(hidden.length, 1, `${k.name}: one stored column, the key's: ${JSON.stringify(hidden)}`);
      const [h, type] = hidden[0]!;
      assert.equal(type, "BLOB", k.name);
      assert.equal(readyName(keeper.ready(order)), h, `${k.name}: ready`);
      assert.match(keeper.status().map((p) => `${p.steps} ${p.why}`).join("\n"), /^order:/, k.name);
      // equal to the key's function on every row it does not raise on, none unset, the rows it raises on marked
      const [n, unset, wrong, marked] = (await rows(store, `SELECT count(*), count(*) FILTER (${h} IS NULL), ` +
        `count(*) FILTER (CASE WHEN ${h} = unhex('0021') THEN false ELSE CASE WHEN ${h} = unhex('00') THEN NULL ELSE ${h} END IS DISTINCT FROM ${k.key} END), ` +
        `count(*) FILTER (${h} = unhex('0021')) FROM public.docs`))[0] as bigint[];
      assert.ok(n! > 100n);
      assert.deepEqual([unset, wrong, marked], [0n, 0n, BigInt(k.marked)], `${k.name}: unset, not the function's, marked`);
      // recorded as the request log's read, so the keeper weighs it as a path's (`review`)
      assert.ok(((on as unknown as { jsonReads?: readonly string[] }).jsonReads ?? []).includes(route.readKey(order)), `${k.name}: the order is one of the statement's reads`);
      if (k.marked === 0) {
        assert.deepEqual(keeper.ready(order), { name: h, exact: true });
        // sorted from the key's column alone: no key computed, no document read
        assert.doesNotMatch(on.sql.text, /__mason_jsonb_key/, on.sql.text);
        const cols = await scanned(reader, on.sql.text, "docs");
        assert.deepEqual(cols.filter((c) => /^j$/.test(c)), [], `${k.name}: the documents are not read: ${cols.join(", ")}`);
        assert.ok((await scanned(reader, off.sql.text, "docs")).some((c) => /^j$/.test(c)), "without the stored key the plan reads j");
      } else {
        // a marked row keeps the document: the CASE computes it, and the statement raises as the call does
        assert.deepEqual(keeper.ready(order), { name: h, exact: false });
        assert.match(on.sql.text, new RegExp(`${h} IS NULL OR .*${h} = unhex\\('0021'\\)`), on.sql.text);
        assert.match(String(await answer(on.sql.text)), /holds a character Mason cannot order .*libc-uncovered/);
      }
      assert.deepEqual(await answer(on.sql.text), await answer(off.sql.text), `${k.name}: sorted as the function sorts`);
      // the other forms that compare a jsonb read the same key; the rows the libc order covers answered alike
      const covered = k.marked === 0 ? "" : " WHERE id % 9 <> 7";
      for (const sql of [`SELECT id FROM docs${covered} ORDER BY j, id`, `SELECT count(*), min(id) FROM docs${covered} GROUP BY j ORDER BY 2`,
        `SELECT a.id, b.id FROM docs a JOIN docs b ON a.j = b.j WHERE a.id < 40 AND b.id < 40${covered === "" ? "" : " AND a.id % 9 <> 7 AND b.id % 9 <> 7"} ORDER BY 1, 2`,
        `SELECT DISTINCT ON (j) id FROM docs${covered} ORDER BY j, id`, `SELECT id, j < '{"s": "m"}' FROM docs${covered} ORDER BY id`,
        // a derived table's column sorted through its `*` is the subquery's (no stored key there): the oracle's wrapper
        `SELECT * FROM (SELECT id, j FROM docs${covered} ORDER BY j, id) AS s ORDER BY s.j, s.id`]) {
        const [a, b] = [await plan(sql, keeper), await plan(sql, null)];
        // under libc an equality reads the C key (a libc key refuses what equality never orders): its own stored column
        // beside the order's, read alone (no key computed); the order's key serves equality under C and ICU
        if (k.name === "libc" && /GROUP BY j|a\.j = b\.j/.test(sql)) {
          const e = route.hiddenName({ ...order, steps: `equal:${cKey.slice("order:".length)}` });
          assert.match(a.sql.text, new RegExp(e), `${k.name}: ${sql} equates by the stored C key`);
          assert.doesNotMatch(a.sql.text, new RegExp(`__mason_jsonb_key|${h}`), `${k.name}: ${sql} computes no key and reads no order key`);
        } else assert.match(a.sql.text, new RegExp(h!), `${k.name}: ${sql} reads the stored key`);
        const got = await answer(a.sql.text);
        assert.ok(Array.isArray(got) && got.length > 0, `${k.name}: ${sql}: ${String(got)}`);
        assert.deepEqual(got, await answer(b.sql.text), `${k.name}: ${sql}`);
      }
      // ONE column under C and ICU whatever the statements equated; under libc a second, the C key's: the function's on
      // every row, none marked — the strings the libc order marks are equated by their bytes
      const after = (await rows(store, "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_') ORDER BY 1")) as string[][];
      if (k.name !== "libc") assert.deepEqual(after, [[h, "BLOB"]], `${k.name}: no second column is ever made`);
      else {
        const e = route.hiddenName({ ...order, steps: `equal:${cKey.slice("order:".length)}` });
        assert.deepEqual(after.map(([c, t]) => `${c} ${t}`).sort(), [`${h} BLOB`, `${e} BLOB`].sort(), `${k.name}: the order's key and the C key`);
        assert.deepEqual(await rows(store, `SELECT count(*) FILTER (${e} IS NULL), count(*) FILTER (${e} = unhex('0021')), ` +
          `count(*) FILTER (CASE WHEN ${e} = unhex('00') THEN NULL ELSE ${e} END IS DISTINCT FROM __mason_jsonb_key(NULL, j)) FROM public.docs`), [[0n, 0n, 0n]], `${k.name}: the C key, whole`);
        assert.match(keeper.status().map((p) => p.steps).join("\n"), /^equal:c:k\d+:/m);
      }
      reader.closeSync();
      await keeper.stop();
    } finally { store.close(); await pglite.close(); }
  }
});

test("a stored jsonb key is its collation's: until the listener says which no plan reads it, rows written meanwhile are filled, another collation's is dropped", async () => {
  const { kept, route } = await modules();
  const order: Read = { source: "public.docs", column: "j", steps: "order", either: false, canonical: true, asText: false };
  const store = await newStore();
  try {
    await documents(store, "public.docs", 5);
    const first = await keeperOver(store, kept, { eager: true });
    await first.keeper.orderBy!({ kind: "bytes" }, undefined);
    await first.keeper.keepNow!([order]);
    const h = route.hiddenName(storedAs(order));
    assert.equal(readyName(first.keeper.ready(order)), h);
    await first.keeper.stop();
    // the next start: the keeper open, the listener not yet started
    const next = await keeperOver(store, kept, { backfillRows: 10 });
    assert.equal(next.keeper.ready(order), null, "no plan reads a key before its collation is told");
    assert.equal(next.keeper.status().find((p) => p.name === h)?.state, "backfilling");
    // a write meanwhile names the column (every write of the table names its stored columns) and leaves it unset
    const write = (next.keeper as unknown as { stored(s: string, v: (c: string) => string): { names: string[]; values: string[] } }).stored("public.docs", (c) => c === "j" ? `'{"s": "meanwhile"}'::JSON` : "NULL");
    assert.deepEqual(write.names, [h]);
    await store.writer.run(`INSERT INTO public.docs (id, j, k, ${write.names.map(ident).join(", ")}) SELECT 5000 + i, '{"s": "meanwhile"}', NULL, ${write.values.join(", ")} FROM range(25) r(i)`);
    assert.equal(await one(store, `SELECT count(*) FILTER (${ident(h)} IS NULL) FROM public.docs WHERE id >= 5000`), 25n);
    // told: the rows written meanwhile filled (the backfill's sweep), and ready again — a chunk a writer's turn (the
    // sweep of a large table never holds the writer for all of it): 3 chunks and the turn that finds none left
    await next.keeper.orderBy!({ kind: "bytes" }, undefined);
    const turns = next.host.turns;
    await next.keeper.fills!();
    assert.ok(next.host.turns - turns >= 4, `the sweep takes a writer's turn a chunk: ${next.host.turns - turns} turn(s) for 25 rows 10 a chunk`);
    assert.deepEqual(next.keeper.ready(order), { name: h, exact: true });
    assert.deepEqual(await rows(store, `SELECT count(*) FILTER (${ident(h)} IS NULL), count(*) FILTER (${ident(h)} IS DISTINCT FROM __mason_jsonb_key(NULL, j) AND j IS NOT NULL) FROM public.docs`), [[0n, 0n]]);
    await next.keeper.stop();
    // a start under another collation: C's key is dropped and said, never read
    const icu = await keeperOver(store, kept, {});
    await store.listener({ provider: "i", collate: "en-US", locale: "en-US" }, null, undefined, () => [], icu.keeper as never);
    assert.equal(icu.keeper.ready(order), null);
    const was = icu.keeper.status().find((p) => p.name === h)!;
    assert.equal(was.state, "dropped");
    assert.match(was.why, new RegExp(`another collation or version \\(${cKey.slice("order:".length)}, now icu:en_us:`));
    assert.match(icu.host.logged.join("\n"), /ORDER BY j \(its jsonb order.*no longer stored/);
    // and stored again under this one as any path is: the request log's statements that sorted by it
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests SELECT 'r', 5, '${JSON.stringify([route.readKey(order)]).replaceAll("'", "''")}' FROM range(${kept.KEEP_AFTER_STATEMENTS})`);
    await reviewed(icu.keeper);
    const again = icu.keeper.ready(order);
    assert.ok(again !== null && readyName(again) !== h, "ready again, as another column (ICU's key)");
    assert.match(icu.keeper.status().find((p) => p.state === "ready")!.why, new RegExp(`read by ${kept.KEEP_AFTER_STATEMENTS} statements`));
    await icu.keeper.stop();
  } finally { store.close(); }
});

// A MARK WRITTEN AFTER READY (the review of PR #14): under a libc collation the stream or the poll may write at any time a
// document whose strings the measured order does not cover — `café` with its accent as a combining mark (e + U+0301) —
// whose stored key is the mark. Until the detector counts it the key is read exact; the mark must never sort as a key.
test("a jsonb's key marked by a write after it was counted exact is never read as a key: the sort is refused by name, then computed", async () => {
  const { kept, route } = await modules();
  const order: Read = { source: "public.docs", column: "j", steps: "order", either: false, canonical: true, asText: false };
  const store = await newStore();
  const pglite = new PGlite();
  try {
    await documents(store, "public.docs", 20);
    // the small order covers letters, digits and the space: SHAPES' U+0000 row is not covered, so it goes
    await store.writer.run("DELETE FROM public.docs WHERE id % 9 = 7");
    await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const { keeper, host } = await keeperOver(store, kept, { eager: true });
    const listener = await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, null, smallLibcOrder(), () => [], keeper as never);
    const plan = async (sql: string, kk: Keeper | null) => planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: listener.collation, verified: null, kept: kk });
    const reader = await store.instance.connect();
    await reader.run("SET search_path = 'public'");
    const answer = async (sql: string): Promise<unknown> => { try { return (await reader.runAndReadAll(sql)).getRowsJS(); } catch (e) { return (e as Error).message.replace(/\n[\s\S]*/, ""); } };
    const sorted = "SELECT id FROM docs ORDER BY j, id";
    await plan(sorted, keeper);
    const ready = keeper.ready(order);
    assert.ok(ready !== null && typeof ready !== "string" && ready.exact, `stored and exact: ${JSON.stringify(ready)}`);
    const h = readyName(ready)!;
    assert.ok(Array.isArray(await answer((await plan(sorted, keeper)).sql.text)), "answered while every string is covered");

    // the poll writes two documents by key (src/duck/sync.ts writeStaged): an update of a row there, and a new one
    const writeStaged = (syncModule as unknown as { writeStaged: (...a: unknown[]) => Promise<void> }).writeStaged;
    await store.writer.run(`CREATE TEMP TABLE stage AS SELECT * FROM (VALUES (1, '{"s": "café"}'::JSON, NULL::JSON), (300000, '["crème", 1]'::JSON, NULL::JSON)) v(c0, c1, c2)`);
    await writeStaged(store.writer, DOCS, "public.docs", "temp.main.stage", "", keeper);
    assert.deepEqual(await rows(store, `SELECT id FROM public.docs WHERE ${ident(h)} = unhex('0021') ORDER BY id`), [[1], [300000]], "the poll wrote their keys as the mark");

    // not counted yet: the plan still reads the key alone, and the mark refuses the sort by name instead of sorting first
    const gen = keeper.generation();
    const exact = await plan(sorted, keeper);
    assert.doesNotMatch(exact.sql.text, /__mason_jsonb_key/, "read exact (the detector has not counted it)");
    assert.match(String(await answer(exact.sql.text)), /mason\[0A000\]: a jsonb compared or sorted here holds a string Mason cannot order .*Mason gap libc-uncovered/);
    assert.match(String(await answer((await plan(sorted, null)).sql.text)), /holds a character Mason cannot order .*libc-uncovered/, "as the statement's own key refuses it");
    // the rows without it are sorted from the key alone, as the function sorts them
    const others = "SELECT id FROM docs WHERE id NOT IN (1, 300000) ORDER BY j DESC, id";
    assert.deepEqual(await answer((await plan(others, keeper)).sql.text), await answer((await plan(others, null)).sql.text));
    // and a window's ORDER BY, which refuses a volatile expression (DuckDB's error() was: the eager oracle's rank())
    const ranked = "SELECT id, rank() OVER (ORDER BY j) FROM docs WHERE id NOT IN (1, 300000) ORDER BY id";
    const r = await answer((await plan(ranked, keeper)).sql.text);
    assert.ok(Array.isArray(r) && r.length > 0, String(r));
    assert.deepEqual(r, await answer((await plan(ranked, null)).sql.text));
    // equality reads the C key under every collation (no stored key of it here): grouped, the marked rows are answered
    const grouped = "SELECT count(*), min(id) FROM docs GROUP BY j ORDER BY 2";
    const g = await answer((await plan(grouped, keeper)).sql.text);
    assert.ok(Array.isArray(g) && g.length > 0, String(g));
    assert.deepEqual(g, await answer((await plan(grouped, null)).sql.text));

    // the detector counts the marks: the reads compute them from the document, and the error names the character
    for (let i = 0; i < 6; i++) await keeper.review();
    assert.deepEqual(keeper.ready(order), { name: h, exact: false });
    assert.ok(keeper.generation() > gen, "the plans that read the key alone are made again");
    assert.match(String(await answer((await plan(sorted, keeper)).sql.text)), /holds a character Mason cannot order .*libc-uncovered/);
    // and says what they are: the gap, never a Mason bug
    const said = host.logged.filter((l) => l.includes("marked rows")).join("\n");
    assert.match(said, /2 row\(s\) hold a character the database's libc order is not measured for.*Mason gap libc-uncovered/, said);
    assert.doesNotMatch(said, /Mason bug/, said);
    assert.equal(route.hiddenName({ ...order, steps: `order:${kept.orderId!({ kind: "libc", icu: "en_us" }, smallLibcOrder())}` }), h);
    reader.closeSync();
    await keeper.stop();
  } finally { store.close(); await pglite.close(); }
});

test("a jsonb's key stored by another version of its encoding or of DuckDB is dropped when the collation is told, and stored again", async () => {
  const { kept, route } = await modules();
  const order: Read = { source: "public.docs", column: "j", steps: "order", either: false, canonical: true, asText: false };
  const store = await newStore();
  try {
    await documents(store, "public.docs", 5);
    const first = await keeperOver(store, kept, { eager: true });
    await first.keeper.orderBy!({ kind: "bytes" }, undefined);
    await first.keeper.keepNow!([order]);
    const now = route.hiddenName(storedAs(order));
    assert.equal(readyName(first.keeper.ready(order)), now);
    await first.keeper.stop();
    // the file as an earlier release left it: the same key stored under an earlier encoding (or DuckDB)
    assert.ok(kept.orderId !== undefined && kept.orderId.length >= 2);
    const earlier = `order:${kept.orderId!({ kind: "bytes" }, undefined, "k0:v0.0.0")}`;
    assert.notEqual(earlier, cKey, "the id names the versions");
    const old = route.hiddenName({ ...order, steps: earlier });
    await store.writer.run(`ALTER TABLE public.docs RENAME COLUMN ${ident(now)} TO ${ident(old)}`);
    await store.writer.run(`UPDATE ${MASON_SCHEMA}.json_paths SET name = '${old}', steps = '${earlier}' WHERE name = '${now}'`);
    const next = await keeperOver(store, kept, { eager: true });
    await next.keeper.orderBy!({ kind: "bytes" }, undefined);
    const was = next.keeper.status().find((p) => p.name === old)!;
    assert.equal(was.state, "dropped", "an earlier version's key is never read");
    assert.match(was.why, new RegExp(`another collation or version \\(c:k0:v0\\.0\\.0, now ${cKey.slice("order:".length).replaceAll(".", "\\.")}\\)`));
    assert.equal(next.keeper.ready(order), null);
    await next.keeper.keepNow!([order]);
    assert.equal(readyName(next.keeper.ready(order)), now, "stored again, this version's");
    await next.keeper.stop();
  } finally { store.close(); }
});

// A JSONB'S EQUALITY STORED UNDER LIBC (src/duck/kept-route.ts EQUAL_STEPS): under a libc collation equality reads the C
// key (the libc order's key refuses a string its measured order does not cover, which equality never had to order), so
// the order's stored key could not serve GROUP BY / DISTINCT / = / IN, which computed the C key per row (32–45 s of CPU
// over 20 M rows, docs/DESIGN.md); the C key is stored as a second column beside the order's.

/** documents equality must tell apart, or not: numbers written apart (`1.0 = 1.00`), an object's keys in another order,
 *  strings the small libc order does not cover (an NFD accent, `è`, an emoji with and without its variation selector),
 *  beside the same value written another way, nested containers, a JSON null and a NULL */
const EQUAL_DOCS = ["1.0", "1.00", "1", '{"a": 1, "b": 2}', '{"b": 2.0, "a": 1}', '{"s": "café"}', '{"s": "café"}', '["crème", 1]', '"❤️"', '"❤"',
  "[]", "{}", "null", '"a b"', '[1, [2, {"x": "y"}]]', null];

/** a store and a PGlite with the same `public.docs` (j jsonb): Postgres's text of each document copied into the store,
 *  as a copy holds it; a keeper over it told a libc collation */
async function equalityOver(kept: KeptModule, options: Record<string, unknown>) {
  const store = await newStore();
  const pglite = new PGlite();
  await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
  const values: string[] = [];
  for (let r = 0; r < 6; r++) EQUAL_DOCS.forEach((v, i) => { if (r === 0 || (r + i) % 3 !== 0) values.push(`(${r * EQUAL_DOCS.length + i + 1}, ${v === null ? "NULL" : `'${v}'`}, NULL)`); });
  await pglite.exec(`INSERT INTO public.docs VALUES ${values.join(", ")}`);
  const copied = (await pglite.query<unknown[]>("SELECT id, j::text FROM public.docs ORDER BY id", [], { rowMode: "array" })).rows;
  await store.writer.run("CREATE SCHEMA IF NOT EXISTS public");
  await store.writer.run("CREATE TABLE public.docs (id INTEGER, j JSON, k JSON)");
  await store.writer.run(`INSERT INTO public.docs VALUES ${copied.map(([id, j]) => `(${String(id)}, ${j === null ? "NULL" : `'${String(j).replaceAll("'", "''")}'`}, NULL)`).join(", ")}`);
  const over = await keeperOver(store, kept, options);
  const listener = await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, null, smallLibcOrder(), () => [], over.keeper as never);
  assert.equal(listener.collation.kind, "libc");
  const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
  const plan = async (sql: string, k: Keeper | null) => planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: listener.collation, verified: null, kept: k });
  const reader = await store.instance.connect();
  await reader.run("SET search_path = 'public'");
  const text = (rs: unknown[][]): string[][] => rs.map((r) => r.map((v) => String(v)));
  const answer = async (sql: string): Promise<string[][] | string> => { try { return text((await reader.runAndReadAll(sql)).getRowsJS() as unknown[][]); } catch (e) { return (e as Error).message.replace(/\n[\s\S]*/, ""); } };
  const postgres = async (sql: string): Promise<string[][]> => text((await pglite.query<unknown[]>(sql, [], { rowMode: "array" })).rows);
  return { store, pglite, plan, reader, answer, postgres, ...over };
}

/** every form that only equates a jsonb, each answering ids or counts (one group's text is one of its values': gap
 *  jsonb-equal-text); `alone`: the key is the column's alone, no constant keyed beside it */
const EQUALITY_FORMS = [
  { sql: "SELECT count(*), min(id) FROM docs GROUP BY j ORDER BY 2", alone: true, scan: true },
  { sql: "SELECT count(*) FROM (SELECT DISTINCT j FROM docs) s", alone: true, scan: true },
  { sql: "SELECT count(DISTINCT j), count(*) FROM docs", alone: true, scan: true },
  { sql: "SELECT id % 3, count(DISTINCT j) FROM docs GROUP BY 1 ORDER BY 1", alone: true, scan: false },
  { sql: "SELECT a.id, b.id FROM docs a JOIN docs b ON a.j = b.j WHERE a.id < b.id ORDER BY 1, 2", alone: true, scan: false },
  { sql: "SELECT id, count(*) OVER (PARTITION BY j) FROM docs ORDER BY id", alone: true, scan: false },
  { sql: `SELECT id FROM docs WHERE j = '{"a": 1.0, "b": 2}' ORDER BY id`, alone: false, scan: false },
  { sql: `SELECT id FROM docs WHERE j IN ('1', '{"s": "café"}', '"❤️"', '[]', '{}') ORDER BY id`, alone: false, scan: false },
  { sql: "SELECT id FROM docs WHERE j NOT IN ('1.00', '[]') ORDER BY id", alone: false, scan: false },
  { sql: "SELECT id, j IS DISTINCT FROM '1.00', nullif(j, '\"a b\"') IS NULL FROM docs ORDER BY id", alone: false, scan: false },
];

test("under a libc collation a jsonb's equality is stored as the C key, a second column: every form that equates reads it and answers Postgres's", async () => {
  const { kept, route } = await modules();
  const { store, pglite, plan, reader, answer, postgres, keeper, host } = await equalityOver(kept, { eager: true });
  try {
    const e = route.hiddenName(storedAs(EQUAL));
    for (const f of EQUALITY_FORMS) {
      const [on, off] = [await plan(f.sql, keeper), await plan(f.sql, null)];
      const want = await postgres(f.sql);
      assert.ok(want.length > 0, f.sql);
      // recorded as the request log's read (the keeper weighs it as a path's), and read from its column
      assert.ok(((on as unknown as { jsonReads?: readonly string[] }).jsonReads ?? []).includes(route.readKey(EQUAL)), `${f.sql}: the equality is one of the statement's reads`);
      assert.deepEqual(keeper.ready(EQUAL), { name: e, exact: true }, f.sql);
      assert.match(on.sql.text, new RegExp(e), `${f.sql} reads the stored C key`);
      if (f.alone) assert.doesNotMatch(on.sql.text, /__mason_jsonb_key/, `${f.sql}: no key computed\n${on.sql.text}`);
      assert.match(off.sql.text, /__mason_jsonb_key\(/, `${f.sql}: without it the C key is computed`);
      if (f.scan) {
        const cols = await scanned(reader, on.sql.text, "docs");
        assert.deepEqual(cols.filter((c) => /^j$/.test(c)), [], `${f.sql}: the documents are not read: ${cols.join(", ")}`);
      }
      assert.deepEqual(await answer(on.sql.text), want, `${f.sql}: the stored key answers Postgres's\n${on.sql.text}`);
      assert.deepEqual(await answer(off.sql.text), want, `${f.sql}: the computed key answers Postgres's`);
    }
    // ONE column, the C key's: these forms sort nothing, so the order's key is not stored; the libc order's
    // uncovered strings marked nothing (they are equated by their bytes)
    assert.deepEqual(await rows(store, "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_')"), [[e, "BLOB"]]);
    assert.deepEqual(await rows(store, `SELECT count(*) FILTER (${ident(e)} IS NULL), count(*) FILTER (${ident(e)} = unhex('0021')) FROM public.docs`), [[0n, 0n]]);

    // a sort stores the order's key beside it (its uncovered strings marked): mason status names each by its own
    await plan("SELECT id FROM docs ORDER BY j, id", keeper);
    const steps = keeper.status().filter((p) => p.state === "ready").map((p) => p.steps.replace(/:.*/, "")).sort();
    assert.deepEqual(steps, ["equal", "order"]);
    const { jsonPathLines } = await import("../src/cli/commands.ts") as unknown as { jsonPathLines(p: unknown[], st: unknown): string[] };
    const plain = new Proxy({}, { get: () => (x: string) => x });
    const lines = jsonPathLines(keeper.status(), plain).join("\n");
    assert.match(lines, /public\.docs {2}GROUP BY j \(its jsonb equality: grouped, DISTINCT, = and IN\) {2}ready/, lines);
    assert.match(lines, /public\.docs {2}ORDER BY j \(its jsonb order: sorted, and compared by < and >\) {2}ready/, lines);
    // equality still reads the C key alone, beside the order's marked rows
    const grouped = EQUALITY_FORMS[0]!.sql;
    assert.doesNotMatch((await plan(grouped, keeper)).sql.text, /__mason_jsonb_key/);
    assert.deepEqual(await answer((await plan(grouped, keeper)).sql.text), await postgres(grouped));

    // A MARK (a write that could not compute the C key: a Mason bug, as the C key raises on no jsonb Postgres accepts),
    // written after the key was counted exact: never read as a key — the statement raises, by the column alone
    await pglite.exec(`INSERT INTO public.docs VALUES (900, '{"s": "x"}', NULL)`);
    await store.writer.run(`INSERT INTO public.docs (id, j, k, ${ident(e)}) SELECT 900, '{"s": "x"}', NULL, unhex('0021')`);
    const gen = keeper.generation();
    assert.deepEqual(keeper.ready(EQUAL), { name: e, exact: true }, "not counted yet");
    assert.match(String(await answer((await plan(grouped, keeper)).sql.text)), /mason\[XX000\]: a stored value of GROUP BY j \(its jsonb equality.*could not be computed .*Mason bug/);
    // the detector counts it: the reads compute the marked rows from their document, and answer Postgres's
    for (let i = 0; i < 6; i++) await keeper.review();
    assert.deepEqual(keeper.ready(EQUAL), { name: e, exact: false });
    assert.ok(keeper.generation() > gen, "the plans that read the key alone are made again");
    for (const f of EQUALITY_FORMS) {
      const marked = await plan(f.sql, keeper);
      assert.match(marked.sql.text, new RegExp(`${e} IS NULL OR .*${e} = unhex\\('0021'\\)\\)? THEN __mason_jsonb_key\\(`), `${f.sql}\n${marked.sql.text}`);
      assert.deepEqual(await answer(marked.sql.text), await postgres(f.sql), `${f.sql}: a marked row is computed from its document`);
    }
    const said = host.logged.filter((l) => l.includes("marked rows")).join("\n");
    assert.match(said, /GROUP BY j \(its jsonb equality.*1 row\(s\) its function could not read .*Mason bug/, said);
    reader.closeSync();
    await keeper.stop();
  } finally { store.close(); await pglite.close(); }
});

test("a jsonb's stored C key lives as the order's: swept across starts, dropped when its version moves, when the collation is not libc, and turned off", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    await documents(store, "public.docs", 5);
    const libc = { kind: "libc", icu: "en_us" };
    const first = await keeperOver(store, kept, { eager: true });
    await first.keeper.orderBy!(libc, smallLibcOrder());
    await first.keeper.keepNow!([EQUAL]);
    const h = route.hiddenName(storedAs(EQUAL));
    assert.deepEqual(first.keeper.ready(EQUAL), { name: h, exact: true });
    // its id: the C key's, the encoding's and DuckDB's versions in it (never the libc order's: the C key reads none)
    const id = (kept as unknown as { equalId(versions?: string): string }).equalId();
    assert.equal(`equal:${id}`, storedAs(EQUAL).steps);
    assert.match(id, /^c:k\d+:/);
    await first.keeper.stop();

    // the next start: unset until the collation is told, rows written meanwhile swept, ready again
    const next = await keeperOver(store, kept, { backfillRows: 10 });
    assert.equal(next.keeper.ready(EQUAL), null, "no plan reads it before the collation is told");
    const write = (next.keeper as unknown as { stored(s: string, v: (c: string) => string): { names: string[]; values: string[] } }).stored("public.docs", (c) => c === "j" ? `'{"s": "meanwhile"}'::JSON` : "NULL");
    assert.deepEqual(write.names, [h]);
    await store.writer.run(`INSERT INTO public.docs (id, j, k, ${ident(h)}) SELECT 5000 + i, '{"s": "meanwhile"}', NULL, ${write.values.join(", ")} FROM range(25) r(i)`);
    await next.keeper.orderBy!(libc, smallLibcOrder());
    await next.keeper.fills!();
    assert.deepEqual(next.keeper.ready(EQUAL), { name: h, exact: true });
    assert.deepEqual(await rows(store, `SELECT count(*) FILTER (${ident(h)} IS NULL), count(*) FILTER (${ident(h)} IS DISTINCT FROM __mason_jsonb_key(NULL, j) AND j IS NOT NULL) FROM public.docs`), [[0n, 0n]]);
    await next.keeper.stop();

    // stored by an earlier encoding (or DuckDB): dropped when the collation is told, never read, stored again
    const earlier = `equal:${(kept as unknown as { equalId(versions?: string): string }).equalId("k0:v0.0.0")}`;
    const old = route.hiddenName({ ...EQUAL, steps: earlier });
    await store.writer.run(`ALTER TABLE public.docs RENAME COLUMN ${ident(h)} TO ${ident(old)}`);
    await store.writer.run(`UPDATE ${MASON_SCHEMA}.json_paths SET name = '${old}', steps = '${earlier}' WHERE name = '${h}'`);
    const moved = await keeperOver(store, kept, { eager: true });
    await moved.keeper.orderBy!(libc, smallLibcOrder());
    const was = moved.keeper.status().find((p) => p.name === old)!;
    assert.equal(was.state, "dropped");
    assert.match(was.why, new RegExp(`another collation or version \\(c:k0:v0\\.0\\.0, now ${id.replaceAll(".", "\\.")}\\)`));
    assert.equal(moved.keeper.ready(EQUAL), null);
    await moved.keeper.keepNow!([EQUAL]);
    assert.deepEqual(moved.keeper.ready(EQUAL), { name: h, exact: true }, "stored again, this version's");
    await moved.keeper.stop();

    // a start under ICU: the order's key equates there, so the C key is dropped and said — and no second column is ever
    // made: the equality's reads (the request log's, or the oracle's eager) store the ORDER's key, one column
    const icu = await keeperOver(store, kept, { eager: true });
    await store.listener({ provider: "i", collate: "en-US", locale: "en-US" }, null, undefined, () => [], icu.keeper as never);
    const gone = icu.keeper.status().find((p) => p.name === h)!;
    assert.equal(gone.state, "dropped");
    assert.match(gone.why, /no longer a libc one \(now icu:en_us:.*its order's key equates jsonb/);
    assert.match(icu.host.logged.join("\n"), /GROUP BY j \(its jsonb equality.*no longer stored/);
    await icu.keeper.keepNow!([EQUAL]);
    const live = icu.keeper.status().filter((p) => p.state === "ready" || p.state === "backfilling");
    assert.deepEqual(live.map((p) => p.steps.replace(/:k\d+:.*/, "")), ["order:icu:en_us"], "the order's key, one column");
    assert.equal(readyName(icu.keeper.ready(EQUAL)), live[0]!.name, "equality's read answered by the order's key");
    await icu.keeper.stop();
    // the request log's equality reads under C store the order's key too
    const c = await keeperOver(store, kept, {});
    await c.keeper.orderBy!({ kind: "bytes" }, undefined);
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests SELECT 'r', 5, '${JSON.stringify([route.readKey(EQUAL)]).replaceAll("'", "''")}' FROM range(${kept.KEEP_AFTER_STATEMENTS})`);
    await reviewed(c.keeper);
    assert.deepEqual(c.keeper.status().filter((p) => p.state === "ready").map((p) => p.steps), [cKey], "under C the equality's reads store the order's key");
    assert.deepEqual(c.keeper.status().filter((p) => p.steps.startsWith("equal:") && p.state !== "dropped"), [], "no C key's column under C");
    await c.keeper.stop();

    // turned off: the C key's column dropped with every other
    const back = await keeperOver(store, kept, { eager: true });
    await back.keeper.orderBy!(libc, smallLibcOrder());
    await back.keeper.keepNow!([EQUAL]);
    assert.deepEqual(back.keeper.ready(EQUAL), { name: h, exact: true });
    await back.keeper.stop();
    const off = await keeperOver(store, kept, { enabled: false });
    assert.equal(off.keeper.ready(EQUAL), null);
    assert.deepEqual(await rows(store, "SELECT count(*) FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_')"), [[0n]]);
    await off.keeper.stop();
  } finally { store.close(); }
});

test("a jsonb's C key waits for a libc collation: no row or column before the collation is told, stored after it, dropped when it turns C", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    await documents(store, "public.docs", 5);
    const hidden = async (): Promise<unknown[][]> => rows(store, "SELECT column_name FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_')");
    const ledger = async (): Promise<unknown[][]> => rows(store, `SELECT steps, state FROM ${MASON_SCHEMA}.json_paths ORDER BY steps`);
    // the oracle's eager store, before the listener tells the collation: nothing written
    const eager = await keeperOver(store, kept, { eager: true });
    await eager.keeper.keepNow!([EQUAL]);
    assert.equal(eager.keeper.ready(EQUAL), null);
    assert.deepEqual([await ledger(), await hidden()], [[], []], "no ledger row and no column before the collation is told");
    await eager.keeper.stop();
    // the policy: the request log's equality reads, reviewed before the collation is told, write nothing either
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests SELECT 'r', 5, '${JSON.stringify([route.readKey(EQUAL)]).replaceAll("'", "''")}' FROM range(${kept.KEEP_AFTER_STATEMENTS})`);
    const policy = await keeperOver(store, kept, {});
    await reviewed(policy.keeper);
    assert.deepEqual([await ledger(), await hidden()], [[], []], "a review before the collation is told stores nothing");
    // told a libc collation: the next review stores the C key from the same evidence
    await policy.keeper.orderBy!({ kind: "libc", icu: "en_us" }, smallLibcOrder());
    await reviewed(policy.keeper);
    const h = route.hiddenName(storedAs(EQUAL));
    assert.deepEqual(policy.keeper.ready(EQUAL), { name: h, exact: true });
    assert.deepEqual(await ledger(), [[storedAs(EQUAL).steps, "ready"]]);
    assert.match(storedAs(EQUAL).steps, /^equal:c:k\d+:/);
    await policy.keeper.stop();
    // libc → C: the C key is dropped (the order's key equates there) and said, never read
    const c = await keeperOver(store, kept, {});
    await c.keeper.orderBy!({ kind: "bytes" }, undefined);
    const gone = c.keeper.status().find((p) => p.name === h)!;
    assert.equal(gone.state, "dropped");
    assert.match(gone.why, /no longer a libc one \(now c:k\d+:.*its order's key equates jsonb/);
    assert.match(c.host.logged.join("\n"), /GROUP BY j \(its jsonb equality.*no longer stored/);
    assert.equal(c.keeper.ready(EQUAL), null, "equality now reads the order's key, not stored here yet");
    await c.keeper.stop();
  } finally { store.close(); }
});

// A KIND THIS MASON DOES NOT KNOW (the review of PR #21): an earlier release met `order:…` and `equal:…` rows and parsed
// them as a JSON path — its status threw, and every write of the table failed. A later release's kind is inert here.
test("a stored read of a kind this Mason does not know is inert: its ledger row and column dropped at the start, its request-log reads not counted, said raw", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  try {
    await documents(store, "public.docs", 5);
    const s: Read = { source: "public.docs", column: "j", steps: '["s"]', either: false, canonical: true, asText: true };
    const first = await keeperOver(store, kept, { eager: true });
    await first.keeper.keepNow!([s]);
    await first.keeper.stop();
    // the file as a later release left it: a ledger row of a kind `future:x`, its column, and reads of it in the request log
    const future: Read = { source: "public.docs", column: "j", steps: "future:x", either: false, canonical: true, asText: false };
    const col = "__mason_json_0123456789ab";
    await store.writer.run(`ALTER TABLE public.docs ADD COLUMN ${col} VARCHAR`);
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.json_paths (name, source, column_name, steps, either, canonical, as_text, state, rows_total, rows_done, statements, kept_at, why, marked) ` +
      `VALUES ('${col}', 'public.docs', 'j', 'future:x', false, true, false, 'ready', 46, 46, 3, now(), 'a later release', 0)`);
    await store.writer.run(`CREATE TABLE ${MASON_SCHEMA}.requests (request_id VARCHAR, duration_ms INTEGER, json_reads VARCHAR)`);
    await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.requests SELECT 'r', 5, '${JSON.stringify([route.readKey(future)]).replaceAll("'", "''")}' FROM range(${kept.KEEP_AFTER_STATEMENTS})`);
    const r = await import("../src/duck/kept-route.ts") as unknown as { readOfKey(k: string): Read | null; pathText(r: Read): string };
    assert.equal(r.readOfKey(route.readKey(future)), null, "a read of an unknown kind is not counted");
    assert.ok(r.readOfKey(route.readKey(s)) !== null, "a path's read is");
    assert.equal(r.pathText(future), "j (stored as future:x: a kind this Mason does not know)");
    // the next start: the row dropped and said with its steps, its column gone, the known path untouched
    const next = await keeperOver(store, kept, {});
    const row = next.keeper.status().find((p) => p.name === col);
    assert.equal(row?.state, "dropped", JSON.stringify(next.keeper.status()));
    assert.match(row!.why, /future:x, a kind this Mason does not know/);
    assert.match(next.host.logged.join("\n"), /dropped the stored j of a kind this Mason does not know \(future:x\)/);
    assert.deepEqual(await rows(store, `SELECT count(*) FROM duckdb_columns() WHERE table_name = 'docs' AND column_name = '${col}'`), [[0n]]);
    assert.deepEqual(next.keeper.ready(s), { name: route.hiddenName(s), exact: true });
    // a review reads the request log's reads of it and stores nothing; mason status says the rest
    await reviewed(next.keeper);
    assert.deepEqual(await rows(store, `SELECT name, state FROM ${MASON_SCHEMA}.json_paths WHERE steps = 'future:x'`), [[col, "dropped"]]);
    assert.deepEqual(await rows(store, "SELECT count(*) FROM duckdb_columns() WHERE table_name = 'docs' AND starts_with(column_name, '__mason_json_')"), [[1n]]);
    const { jsonPathLines } = await import("../src/cli/commands.ts") as unknown as { jsonPathLines(p: unknown[], st: unknown): string[] };
    const plain = new Proxy({}, { get: () => (x: string) => x });
    assert.match(jsonPathLines(next.keeper.status(), plain).join("\n"), /j -> 's' {2}ready[\s\S]*1 dropped/);
    await next.keeper.stop();
    // and a start turned off still says its status, the row of the unknown kind in it
    const off = await keeperOver(store, kept, { enabled: false });
    assert.ok(off.keeper.status().some((p) => p.steps === "future:x"));
    await off.keeper.stop();
  } finally { store.close(); }
});

/** a libc order small enough to write by hand (as tests/duck-libc-order.test.ts writes one): letters with case and
 *  accents at ICU's levels, the digits, and the space with no first-level weight; nothing else covered */
function smallLibcOrder(): LibcOrder {
  return handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({ e: "é" })], [" "]);
}

test("a path's spellings and its -> and ->> are ONE stored column, each read from it; an element that reads as an index is not folded", async () => {
  const { kept, route } = await modules();
  const store = await newStore();
  const pglite = new PGlite();
  try {
    await documents(store, "public.docs", 20);
    await pglite.exec("CREATE TABLE public.docs (id integer PRIMARY KEY, j jsonb, k json)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const { keeper } = await keeperOver(store, kept, { eager: true });
    const plan = async (sql: string, k: Keeper | null) => planKept({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Node, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null, kept: k });
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
    // j's jsonb order: a key's fill is another function's, so a path's rate is no evidence for it (modelled)
    await again.orderBy!({ kind: "bytes" }, undefined);
    const order: Read = { source: "public.docs", column: "j", steps: "order", either: false, canonical: true, asText: false };
    await log(order, 3, 5);
    await reviewed(again);
    const key = (again.status() as Measured[]).find((p) => p.name === route.hiddenName(storedAs(order)))!;
    assert.ok(key !== undefined && key.fill !== null, JSON.stringify(again.status().map((p) => [p.steps, p.state, p.why])));
    assert.equal(key.fill.basis, "disk", `a key's fill is modelled, not priced by a path's: ${JSON.stringify(key.fill)}`);
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
