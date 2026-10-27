/**
 * STORED JSON PATHS KEPT CURRENT BY EVERY WRITE, AGAINST A REAL POSTGRES (src/duck/kept.ts; docs/DESIGN.md "Stored JSON
 * paths"). A JSON path stored as a column of the copy must equal, row for row, what Postgres answers for
 * the same read — after the copy, after each poll, after each batch the stream applies (an insert, an update of the
 * JSON, an update that leaves the JSON unchanged as TOAST, an update that carries it while another large value is
 * left unchanged, a delete), after the catch-up poll that follows a copy made again, and after a copy made again
 * without one of its JSON columns (whose paths are dropped with it). The paths are stored eagerly (`json.eager`, the
 * oracle's option), so every read here is answered from its column; tests/duck-json-columns.test.ts holds the rest
 * offline. And a READY path's read through the planner reads its stored column ALONE: DuckDB's plan (EXPLAIN) scans no
 * document, and the answer is Postgres's.
 *
 * What it needs: IT_POSTGRES_URL (wal_level = logical for the stream's test), psql on PATH, DuckDB's postgres
 * extension. It writes only inside databases it creates, `it_djson_<random>*`, and drops them and its slots at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import type { JsonRead } from "../../src/duck/kept-route.ts";
import { connectSource, parseSource, readSourceFacts, type Source } from "../../src/cli/preflight.ts";
import { PGlite } from "@electric-sql/pglite";
import type { Node } from "libpg-query";
import { planDuck } from "../../src/duck/plan.ts";
import { parseSql, stopParser } from "../../src/api/postgres/parser.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_djson_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-djson-"));
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const urlOf = (db: string): string => { const u = new URL(adminUrl!); u.pathname = `/${db}`; return u.toString(); };

after(async () => {
  await stopParser();
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  if (logical) psql(adminUrl, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE '${tag}%' AND NOT active`);
  for (const db of psql(adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${tag}%'`).split("\n").filter(Boolean)) psql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

async function tablesOf(source: Source, names: readonly string[]): Promise<AddedTable[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(c.failure.message);
  try {
    const facts = await readSourceFacts(c.pg);
    return names.map((n) => { const t = facts.tables.find((x) => x.source === n); if (!t) throw new Error(`no table ${n}`); return t; });
  } finally { c.pg.close(); }
}

/** `docs`: a jsonb, a json and a large text, each JSON of several shapes; `j` and `big` stored out of line, so an UPDATE
 *  of another column sends them as unchanged TOAST */
const SCHEMA = "CREATE TABLE docs (id int PRIMARY KEY, j jsonb, k json, big text, v text); ALTER TABLE docs ALTER COLUMN j SET STORAGE EXTERNAL; ALTER TABLE docs ALTER COLUMN big SET STORAGE EXTERNAL";
const doc = (g: string): string => `CASE ${g} % 5 WHEN 0 THEN jsonb_build_object('s', 'text ' || ${g}, 'n', 7.00, 'o', jsonb_build_object('a', jsonb_build_array(${g}, 'x', NULL)), 'pad', repeat('p', 3000)) ` +
  `WHEN 1 THEN jsonb_build_object('s', NULL, 'n', -0.5, 'arr', jsonb_build_array(10, 20, 30)) WHEN 2 THEN '[1, "two", {"s": "in array"}]'::jsonb ` +
  `WHEN 3 THEN '"a scalar"'::jsonb ELSE jsonb_build_object('n', 1e20, 'o', '{}'::jsonb, 'pad', repeat('q', 3000)) END`;
const SEED = (from: number, to: number): string => `INSERT INTO docs SELECT g, ${doc("g")}, ('{"n": ' || (g % 7) || '.50, "k":   "spaced ' || g || '"}')::json, ` +
  `repeat(md5(g::text), 100), 'v' || g FROM generate_series(${from}, ${to}) g`;

/** the reads stored, each with the SQL Postgres answers it with */
const READS: Array<{ read: Omit<JsonRead, "source">; pg: string }> = [
  { read: { column: "j", steps: '["s"]', either: false, canonical: true, asText: true }, pg: "j ->> 's'" },
  { read: { column: "j", steps: '["n"]', either: false, canonical: true, asText: true }, pg: "j ->> 'n'" },
  { read: { column: "j", steps: '["o","a","0"]', either: true, canonical: true, asText: false }, pg: "j #> '{o,a,0}'" },
  { read: { column: "j", steps: "[2]", either: false, canonical: true, asText: false }, pg: "j -> 2" },
  { read: { column: "k", steps: '["k"]', either: false, canonical: false, asText: false }, pg: "k -> 'k'" },
  { read: { column: "k", steps: '["n"]', either: false, canonical: false, asText: true }, pg: "k ->> 'n'" },
];
const reads = (source: string): JsonRead[] => READS.map((r) => ({ source, ...r.read }));

/** a read's hidden column, from the module when the test runs: the file loads at a commit without it, and fails by its
 *  assertions there (scripts/fails-without.ts) */
async function hiddenOf(read: JsonRead): Promise<string> {
  const route = await import("../../src/duck/kept-route.ts").catch((e: unknown) => assert.fail(`src/duck/kept-route.ts does not load: ${(e as Error).message}`));
  return route.hiddenName(read);
}

/** a stored path's read from its column `h` alone (src/duck/rewrite.ts keptRead, keptText): the column holds the
 *  `->` answer, or a NUL for a NULL one; `->>` is derived from it */
const fromColumn = (h: string, r: Omit<JsonRead, "source">): string => r.asText
  ? `CASE WHEN ${h} = chr(0) OR ${h} = 'null' THEN NULL WHEN starts_with(${h}, '"') THEN CASE WHEN contains(${h}, '\\') THEN __mason_json_get(NULL, ${h}, '[]', false, ${r.canonical}, true) ` +
    `ELSE substr(${h}, 2, length(${h}) - 2) END ELSE ${h} END`
  : `CASE WHEN ${h} = chr(0) THEN NULL ELSE ${h} END`;

/** every stored read equal to Postgres's answer for every row, and none unset */
async function same(store: DuckStore, url: string, which: typeof READS, step: string): Promise<void> {
  const text = async (sql: string): Promise<string> => ((await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "\\N" : String(x)).join("\t")).join("\n");
  for (const { read, pg } of which) {
    const h = `"${await hiddenOf({ source: "public.docs", ...read })}"`;
    assert.equal(await text(`SELECT count(*) FROM public.docs WHERE ${h} IS NULL OR ${h} = chr(0) || '!'`), "0", `${pg}: no row unset or marked after ${step}`);
    const ours = await text(`SELECT id, ${fromColumn(h, read)} FROM public.docs ORDER BY id`);
    const theirs = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-P", "null=\\N", "-v", "ON_ERROR_STOP=1", url, "-c", `SELECT id, ${pg} FROM docs ORDER BY id`], { encoding: "utf8" });
    if (theirs.status !== 0) throw new Error(theirs.stderr);
    assert.equal(ours, theirs.stdout.trim(), `${pg} after ${step}`);
  }
}

/**
 * A READY PATH READ THROUGH THE PLANNER: every read of the statement is answered from its stored column ALONE — the
 * plan's scan of the table (EXPLAIN (FORMAT JSON): its projections and filters) names no document (j, k) — and the
 * answer is Postgres's, row for row. `#>` of keys and `->`/`->>` of one path read one column.
 */
async function plannedAlone(store: DuckStore, url: string, kept: unknown, step: string): Promise<void> {
  const pglite = new PGlite();
  const reader = await store.instance.connect();
  try {
    await pglite.exec("CREATE TABLE public.docs (id int PRIMARY KEY, j jsonb, k json, big text, v text)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
    const sql = "SELECT id, j ->> 's' AS s, j #>> '{s}' AS s2, j -> 's' AS s3, j ->> 'n' AS n, j #> '{o,a,0}' AS o, j -> 2 AS second, k -> 'k' AS kk, k ->> 'k' AS kt, k ->> 'n' AS kn " +
      "FROM docs WHERE j ->> 's' IS NOT NULL OR k ->> 'n' IS NOT NULL ORDER BY id";
    const p = await (planDuck as (...a: unknown[]) => ReturnType<typeof planDuck>)(catalog, sql, (await parseSql(sql)).stmts![0]!.stmt as Node, 0, [], "public", "UTC", { kind: "bytes" }, null, new Map(), () => [], 0, kept);
    await reader.run("SET search_path = 'public'");
    const plan = JSON.parse(String((await reader.runAndReadAll(`EXPLAIN (FORMAT JSON) ${p.sql.text}`)).getRowsJS()[0]![1])) as unknown;
    const cols: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n === null || typeof n !== "object") return;
      const info = (n as { extra_info?: Record<string, unknown> }).extra_info ?? {};
      if (typeof info.Table === "string" && info.Table.endsWith(".docs")) for (const k of ["Projections", "Filters"]) { const v = info[k]; if (v !== undefined) cols.push(...(Array.isArray(v) ? v.map(String) : String(v).split("\n"))); }
      walk((n as { children?: unknown }).children);
    };
    walk(plan);
    assert.ok(cols.length > 0, `a scan of docs in ${p.sql.text}`);
    assert.deepEqual(cols.filter((c) => /\b(j|k)\b/.test(c.replace(/__mason_json_[0-9a-f]{12}/g, ""))), [], `after ${step}, no document is read: ${cols.join(", ")}\n${p.sql.text}`);
    assert.equal(new Set(p.sql.text.match(/__mason_json_[0-9a-f]{12}/g)).size, 6, `six paths, ten reads: ${p.sql.text}`);
    const ours = ((await reader.runAndReadAll(p.sql.text)).getRowsJS() as unknown[][]).map((r) => r.map((x) => x === null ? "\\N" : String(x)).join("\t")).join("\n");
    const theirs = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-P", "null=\\N", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
    if (theirs.status !== 0) throw new Error(theirs.stderr);
    assert.equal(ours, theirs.stdout.trim(), `the planned read from the stored columns after ${step}`);
  } finally { reader.closeSync(); await pglite.close(); }
}

test("a stored path equals Postgres's read after the copy, every poll, and a copy made again without one of its columns", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const db = `${tag}_p`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; ${SEED(1, 3000)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [DOCS] = await tablesOf(parsed.source, ["public.docs"]);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "p.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 3_600_000, "poll", null, { json: { eager: true } });
  try {
    await sync.open();
    sync.setTables([DOCS!]);
    await sync.once();
    assert.ok(sync.kept?.keepNow, "the sync stores JSON paths");
    await sync.kept.keepNow(reads("public.docs"));
    assert.deepEqual(sync.kept.status().map((p) => p.state), READS.map(() => "ready"), logged.join("\n"));
    await same(store, url, READS, "the copy");
    await plannedAlone(store, url, sync.kept, "the copy");

    psql(url, `${SEED(3001, 3100)}; UPDATE docs SET j = jsonb_set(j, '{s}', '"changed"') WHERE id % 10 = 0; UPDATE docs SET k = '{"k": "k only"}' WHERE id % 10 = 1; ` +
      "UPDATE docs SET v = 'v only' WHERE id % 10 = 2; DELETE FROM docs WHERE id % 10 = 3; UPDATE docs SET j = NULL WHERE id = 5");
    await sync.pollNow(["public.docs"]);
    await same(store, url, READS, "a poll");
    await plannedAlone(store, url, sync.kept, "a poll");

    // copied again without k (its columns narrowed in the sources file): k's paths go with it, j's are filled in the new copy before its swap
    const noK = { ...DOCS!, columns: DOCS!.columns.filter((c) => c.name !== "k") };
    sync.setTables([noK]);
    await sync.once();
    assert.ok(logged.some((l) => /^copying public\.docs/.test(l)), "copied again");
    const states = new Map(sync.kept.status().map((p) => [`${p.column} ${p.steps}`, p.state]));
    assert.deepEqual(READS.map((r) => states.get(`${r.read.column} ${r.read.steps}`)), READS.map((r) => r.read.column === "k" ? "dropped" : "ready"));
    psql(url, `UPDATE docs SET j = '{"s": "after the copy"}' WHERE id = 7; ${SEED(4000, 4010)}`);
    await sync.pollNow(["public.docs"]);
    await same(store, url, READS.filter((r) => r.read.column === "j"), "a copy made again, then a poll");
    assert.deepEqual(((await store.writer.runAndReadAll("SELECT column_name FROM duckdb_columns() WHERE table_name = 'docs' AND schema_name = 'public' AND starts_with(column_name, '__mason_json_') ORDER BY 1")).getRowsJS() as string[][]).map((r) => r[0]),
      (await Promise.all(READS.filter((r) => r.read.column === "j").map((r) => hiddenOf({ source: "public.docs", ...r.read })))).sort(), "only j's stored columns are left");
  } finally {
    await sync.stop();
    store.close();
  }
});

test("a stored path equals Postgres's read after every batch the stream applies, and after a copy made again and caught up", { skip: !adminUrl ? "IT_POSTGRES_URL is not set" : !logical ? "IT_POSTGRES_URL's server has no wal_level = logical" : false }, async () => {
  const db = `${tag}_s`, url = urlOf(db);
  psql(adminUrl!, `CREATE DATABASE ${db}`);
  psql(url, `${SCHEMA}; ${SEED(1, 2000)}`);
  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const [DOCS] = await tablesOf(parsed.source, ["public.docs"]);
  const names = { slot: `${tag}_s`, publication: `${tag}_s`, owned: true };
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "s.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, db, (l) => logged.push(l), 1_000, "replication", names, { json: { eager: true } });
  try {
    await sync.open();
    sync.setTables([DOCS!]);
    await sync.once();
    await sync.caughtUp();
    assert.ok(sync.kept?.keepNow, "the sync stores JSON paths");
    await sync.kept.keepNow(reads("public.docs"));
    await same(store, url, READS, "the copy");

    psql(url, `${SEED(2001, 2050)}; UPDATE docs SET j = jsonb_set(j, '{s}', '"streamed"') WHERE id % 10 = 0; DELETE FROM docs WHERE id % 10 = 3`);
    await sync.caughtUp();
    await same(store, url, READS, "inserts, updates of the JSON and deletes, streamed");

    // j and big left unchanged (TOAST, not sent): k and v carried, j's stored paths as they were
    psql(url, "UPDATE docs SET v = 'toast kept', k = '{\"k\": \"streamed k\", \"n\": 2}' WHERE id % 5 = 0");
    await sync.caughtUp();
    await same(store, url, READS, "an update that leaves j unchanged");
    // j carried, big left unchanged
    psql(url, `UPDATE docs SET j = jsonb_build_object('s', 'carried ' || id, 'pad', repeat('r', 3000)) WHERE id % 5 = 0`);
    await sync.caughtUp();
    await same(store, url, READS, "an update that carries j and leaves big unchanged");

    // copied again (its columns changed): the new copy filled before its swap, then its catch-up poll writes the rows
    // changed meanwhile — on the rebuilds' connection, with every stored column
    const noBig = { ...DOCS!, columns: DOCS!.columns.filter((c) => c.name !== "big") };
    sync.setTables([noBig]);
    psql(url, "UPDATE docs SET j = '{\"s\": \"during the copy\"}' WHERE id = 11");
    await sync.once();
    await sync.caughtUp();
    psql(url, "UPDATE docs SET j = '{\"s\": \"after the copy\"}' WHERE id = 12; INSERT INTO docs VALUES (9999, '{\"s\": \"new\"}', '{\"k\": 1}', 'b', 'v')");
    await sync.caughtUp();
    await same(store, url, READS, "a copy made again, caught up, and streamed");
    assert.deepEqual(sync.kept.status().map((p) => p.state), READS.map(() => "ready"));
  } finally {
    await sync.stop();
    store.close();
  }
});
