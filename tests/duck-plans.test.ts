/**
 * THE PLAN DUCKDB RUNS FOR THE SHAPES BI TOOLS SEND, held as a golden fixture (tests/fixtures/duck-plans.json).
 *
 * The oracle (tests/integration/duck-oracle.itest.ts) holds every ANSWER to Postgres's and is blind to the PLAN: on
 * 2026-10-28 three rewrites were each a BI tool's slow path with nothing wrong in the answers (docs/DESIGN.md "The plan
 * fixture") — a LEFT JOIN LATERAL of json rows planned as a delimiter join over the whole base under a LIMIT (37.9 s
 * for a 100-row page), an expression sort key (`ORDER BY (x) IS NULL ASC, x DESC LIMIT 100`) that stopped DuckDB's
 * top N pruning the scan (6.4 s and 91 s), and date_trunc of a timestamptz through ICU's calendar (7.9 s over 197 M
 * rows). Each is rewritten now (src/duck/rewrite.ts `leftLateral`, `nullsKeyFolded`, `truncInstant`), and this file
 * holds the plans those rewrites give, so a later change that turns a streaming UNNEST back into a delimiter join, or a
 * bare sort key back into an expression, fails here by the statement's name.
 *
 * Per statement: Mason's EXPLAIN (VERBOSE, FORMAT JSON) through the listener — the statement planned as it runs
 * (src/duck/plan.ts) and DuckDB's own `EXPLAIN (FORMAT JSON)` of the SQL Mason sends — reduced to a COARSE skeleton
 * that should survive a DuckDB upgrade: the operators in tree order, per scan its table and whether a top-N dynamic
 * filter or a table filter DuckDB checks against the zone maps is attached, the Mason functions (`__mason_*`) an
 * operator's details print a call of and the statement's whole list (DuckDB's EXPLAIN names a projection by its alias,
 * so a projection's calls are only in that list), and whether a delimiter join (DuckDB 2.0's has no DELIM operator:
 * `joinsBack`) or a full sort appears. No cost, estimate or row count. An expression's own cost is not in it: ICU's
 * date_trunc and the instant's arithmetic are both a PROJECTION, so `truncInstant` is held by its SQL
 * (tests/duck-wire.test.ts), its plan here only by its operators.
 *
 * A DIFF MEANS THE PLAN CHANGED. Read it, decide whether the new plan is a REGRESSION (a delimiter join, an expression
 * key under a top N, a full sort, a lost filter, more Mason calls: fix the change) or a BETTER plan (regenerate with
 * `UPDATE_FIXTURE=1 npm test` and READ the diff), and say which in the commit. A DuckDB upgrade that only renames
 * an operator is regenerated and said as such.
 *
 * And for a few shapes an invariant MEASURED by DuckDB's EXPLAIN ANALYZE over the shop's million orders (nine row
 * groups): a 100-row page ordered by a column reads a handful of row groups, never all; a LEFT lateral of json rows
 * under a LIMIT reads few rows of the base. Synthetic data only: a shop whose every name is the oracle's
 * (tests/integration/oracle/data.ts).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgColumn, PgSchema } from "../src/api/postgres/schema.ts";
import { BI_SHAPES } from "./integration/oracle/bi-shapes.ts";

const UPDATE = process.env.UPDATE_FIXTURE === "1";
const FIXTURE = path.join(import.meta.dirname, "fixtures", "duck-plans.json");
const API_KEY = "k".repeat(48);

/** the oracle's shop (tests/integration/oracle/data.ts SCHEMA, `META`), its orders a million rows in heap order: an
 *  order's created_at grows with its id, as an application inserts them, so each row group holds a stretch of time */
const ORDERS = 1_000_000;
const TENANTS = "['acme', 'globex', ''][range % 3 + 1]";
const DDL = [
  "CREATE TABLE public.tenants (id VARCHAR, name VARCHAR, plan VARCHAR, changed_seq BIGINT)",
  "INSERT INTO public.tenants VALUES ('acme', 'Acme', 'pro', 0), ('globex', 'Globex', 'free', 0), ('', '', NULL, 0)",
  `CREATE TABLE public.customers AS SELECT (range + 1)::BIGINT AS id, ${TENANTS} AS tenant_id, CASE WHEN range % 11 = 0 THEN NULL ELSE 'customer ' || range END AS name,
     CASE WHEN range % 13 = 0 THEN NULL ELSE 'c' || range || '@example.test' END AS email, TIMESTAMPTZ '2023-01-01 00:00:00+00' + to_seconds(range * 3600) AS created_at,
     0::BIGINT AS changed_seq FROM range(20000)`,
  // shipped_at: a timestamp without a zone, NULL for the latest orders (not shipped yet) — a NULL in EVERY row group
  // defeats DuckDB 2.0's top N pruning even with one key (measured: 9 of 9 row groups for DESC NULLS LAST), which is
  // DuckDB's, not the rewrite's; notes a nullable text; meta a jsonb as the copy holds one (Postgres's text, NULL for
  // every fifth order)
  `CREATE TABLE public.orders AS SELECT (range + 1)::BIGINT AS id, ${TENANTS} AS tenant_id, CASE WHEN range % 97 = 0 THEN NULL ELSE (range * 7919) % 20000 + 1 END::BIGINT AS customer_id,
     ['paid', 'pending', 'refunded', NULL, '', 'PAID'][range % 6 + 1] AS status, ((range * 37) % 100000 / 100)::DECIMAL(12,2) AS amount,
     TIMESTAMPTZ '2024-12-01 00:00:00+00' + to_seconds(range * 60) AS created_at,
     CASE WHEN range >= ${ORDERS - 50_000} THEN NULL ELSE TIMESTAMP '2024-12-03 00:00:00' + to_seconds(range * 60) END AS shipped_at,
     CASE WHEN range % 4 = 0 THEN NULL ELSE 'note ' || ((range * 7) % 50000) END AS notes, 0::BIGINT AS changed_seq,
     CASE WHEN range % 5 = 0 THEN NULL ELSE ('{"n": ' || ((range * 37) % 100000 / 100)::DECIMAL(12,2) || ', "tags": ' || CASE range % 3 WHEN 0 THEN '[]' WHEN 1 THEN '["a", "B"]' ELSE '["' || ${TENANTS} || '"]' END
       || ', "status": ' || coalesce(to_json(['paid', 'pending', 'refunded', NULL, '', 'PAID'][range % 6 + 1])::VARCHAR, 'null') || '}')::JSON END AS meta
     FROM range(${ORDERS})`,
  `CREATE TABLE public.order_items AS SELECT (range + 1)::BIGINT AS id, ${TENANTS} AS tenant_id, ((range * 3) % ${ORDERS} + 1)::BIGINT AS order_id,
     ['widget', 'Widget', 'gadget', '', NULL, 'sprocket', 'gizmo', 'widget', '1', '01'][range % 10 + 1] AS product, [1, 2, 0, -1, 7, 1000, 3][range % 7 + 1]::INTEGER AS quantity,
     CASE WHEN range % 17 = 0 THEN NULL ELSE ((range * 13) % 10000 / 100 + 0.01)::DECIMAL(12,2) END AS unit_price, 0::BIGINT AS changed_seq FROM range(300000)`,
  `CREATE TABLE public.products AS SELECT sku, ${TENANTS} AS tenant_id, 'product ' || sku AS name, ['a', 'x', '', 'tools', 'Tools', '1', 'toys', NULL][range % 8 + 1] AS category,
     TIMESTAMPTZ '2023-06-01 00:00:00+00' + to_seconds(range * 86400) AS created_at, 0::BIGINT AS changed_seq
     FROM (SELECT range, ['widget', 'Widget', 'gadget', '', 'sprocket', '1', '01', '17', 'x', 'widget ', 'O''Hara', 'unsold'][range + 1] AS sku FROM range(12))`,
  `CREATE TABLE public.categories AS SELECT code, ${TENANTS} AS tenant_id, 'category ' || code AS name, 0::BIGINT AS changed_seq
     FROM (SELECT range, ['a', 'x', '', 'tools', 'Tools', '1', 'toys'][range + 1] AS code FROM range(7))`,
];
const text = (name: string): PgColumn => ({ name, type: "text" });
const int8 = (name: string): PgColumn => ({ name, type: "int8" });
const tstz = (name: string): PgColumn => ({ name, type: "timestamptz" });
const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "tenants", primaryKey: ["id"], joins: [], columns: [text("id"), text("name"), text("plan"), int8("changed_seq")] },
    { name: "customers", primaryKey: ["id"], joins: [], columns: [int8("id"), text("tenant_id"), text("name"), text("email"), tstz("created_at"), int8("changed_seq")] },
    { name: "orders", primaryKey: ["id"], joins: [],
      columns: [int8("id"), text("tenant_id"), int8("customer_id"), text("status"), { name: "amount", type: "numeric", spelled: "numeric(12,2)" }, tstz("created_at"),
        { name: "shipped_at", type: "timestamptz", spelled: "timestamp" }, text("notes"), int8("changed_seq"), { name: "meta", type: "jsonb" }] },
    { name: "order_items", primaryKey: ["id"], joins: [],
      columns: [int8("id"), text("tenant_id"), int8("order_id"), text("product"), { name: "quantity", type: "int4" }, { name: "unit_price", type: "numeric", spelled: "numeric(12,2)" }, int8("changed_seq")] },
    { name: "products", primaryKey: ["sku"], joins: [], columns: [text("sku"), text("tenant_id"), text("name"), text("category"), tstz("created_at"), int8("changed_seq")] },
    { name: "categories", primaryKey: ["code"], joins: [], columns: [text("code"), text("tenant_id"), text("name"), int8("changed_seq")] },
  ],
};

interface Shape { name: string; sql: string; zone?: string }

/** what PR #13's rewrites were made for, each in the spelling the tool sends (tests/duck-wire.test.ts holds their SQL
 *  and answers over small tables; here, their plans over a million rows) */
const REWRITTEN: Shape[] = [
  // truncInstant: a BI tool's monthly histogram, in UTC and in a zone with daylight saving; an hour in that zone (the
  // offset kept); a day in a zone of its own (DuckDB's own truncation, named)
  { name: "date_trunc histogram: a month in UTC", sql: "SELECT DATE_TRUNC('month', o.created_at) AS m, count(*) FROM orders o GROUP BY 1 ORDER BY 1 DESC LIMIT 100" },
  { name: "date_trunc histogram: a month in Europe/Berlin", sql: "SELECT DATE_TRUNC('month', o.created_at) AS m, count(*) FROM orders o GROUP BY 1 ORDER BY 1 DESC LIMIT 100", zone: "Europe/Berlin" },
  { name: "date_trunc histogram: an hour in Europe/Berlin", sql: "SELECT DATE_TRUNC('hour', o.created_at) AS h, count(*) FROM orders o WHERE o.created_at >= timestamptz '2025-10-01 00:00:00+00' GROUP BY 1 ORDER BY 1", zone: "Europe/Berlin" },
  { name: "date_trunc histogram: a day in a zone of its own", sql: "SELECT date_trunc('day', o.created_at, 'America/New_York') AS d, count(*) FROM orders o GROUP BY 1 ORDER BY 1" },
  // leftLateral: the "expand the JSON" preview, over jsonb and json, guarded to objects as the tool guards it
  { name: "LEFT lateral preview: jsonb_each, LIMIT 100 OFFSET 0", sql: "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.meta FROM orders t) AS q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta ELSE NULL END) d ON TRUE LIMIT 100 OFFSET 0" },
  { name: "LEFT lateral preview: json_each, LIMIT 100 OFFSET 200", sql: "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.meta FROM orders t) AS q LEFT JOIN json_each(CASE WHEN substring(ltrim(q.meta::text), 1, 1) = '{' THEN q.meta::json ELSE NULL END) d ON TRUE LIMIT 100 OFFSET 200" },
  { name: "LEFT lateral preview: jsonb_array_elements_text, LIMIT 100", sql: "SELECT t.id, e FROM orders t LEFT JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.meta -> 'tags') = 'array' THEN t.meta -> 'tags' END) AS e ON TRUE LIMIT 100" },
  // what is not a LEFT … ON TRUE keeps its own plan: a condition on the lateral's rows
  { name: "LEFT lateral with a condition (not rewritten)", sql: "SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON d.key <> 'n' WHERE q.id < 1000 ORDER BY 1, 2" },
  // nullsKeyFolded: a table's page sorted by a column with its NULLs last, as a BI tool spells it
  { name: "nulls idiom: a timestamp, LIMIT 100 OFFSET 0", sql: "SELECT o.id, o.status, o.shipped_at FROM orders o ORDER BY (o.shipped_at) IS NULL ASC, o.shipped_at DESC LIMIT 100 OFFSET 0" },
  { name: "nulls idiom: a text column under a wide select list, LIMIT 100 OFFSET 0", sql: "SELECT o.id, o.tenant_id, o.customer_id, o.status, o.amount, o.created_at, o.shipped_at, o.notes, o.changed_seq, o.meta FROM orders o ORDER BY (o.notes) IS NULL ASC, o.notes DESC LIMIT 100 OFFSET 0" },
  { name: "nulls idiom: IS NOT NULL DESC, a timestamptz", sql: "SELECT o.id, o.created_at FROM orders o ORDER BY (o.created_at) IS NOT NULL DESC, o.created_at DESC LIMIT 100 OFFSET 0" },
  { name: "a page by one bare key (the idiom's control)", sql: "SELECT o.id, o.status, o.shipped_at FROM orders o ORDER BY o.shipped_at DESC NULLS LAST LIMIT 100" },
  { name: "not the idiom: the test then another column (not rewritten)", sql: "SELECT o.id FROM orders o ORDER BY o.shipped_at IS NULL, o.id LIMIT 100" },
  // the count-by-column a BI tool's "distribution" sends
  { name: "count by a column: GROUP BY 1 ORDER BY \"count\" DESC LIMIT 100", sql: "SELECT \"status\", count(*) AS \"count\" FROM \"public\".\"orders\" GROUP BY 1 ORDER BY \"count\" DESC LIMIT 100" },
  { name: "count by a wide text column: GROUP BY 1 ORDER BY \"count\" DESC LIMIT 100", sql: "SELECT \"notes\", count(*) AS \"count\" FROM \"public\".\"orders\" GROUP BY 1 ORDER BY \"count\" DESC LIMIT 100" },
  // a table's preview, plain and sorted by its key (late materialization: the winners' columns read after the sort)
  { name: "a table's preview: SELECT * LIMIT 100", sql: "SELECT * FROM orders LIMIT 100" },
  { name: "a table's sorted preview: ORDER BY the key LIMIT 1000", sql: "SELECT * FROM orders ORDER BY id DESC LIMIT 1000" },
];

/** the BI shapes (tests/integration/oracle/bi-shapes.ts) whose plans are held: one of each structure — joins,
 *  groupings, windows, subqueries, series, laterals, json reads, the collation, a filter on a time window */
const HELD_BI = [
  "cast: ::varchar(n) (truncates)",
  "function: date(x)",
  "date/time - date/time over columns (interval, integer days)",
  "to_char patterns (Month, Day, Mon, IW, IYYY, Q, FM, 9/0 number formats)",
  "comparison: date vs timestamp / BETWEEN … AND <date>",
  "generate_series over dates (LATERAL / select list) + LEFT JOIN",
  "WITH RECURSIVE",
  "collation: ORDER BY a text column in a subquery / window ORDER BY text",
  "collation: ORDER BY text + LIMIT (outer) / min/max of text",
  "collation: max/min of text, string_agg(DISTINCT)",
  "percentile_disc / mode()",
  "GROUP BY ROLLUP / GROUPING()",
  "CASE in GROUP BY",
  "window frame: ROWS BETWEEN n PRECEDING / UNBOUNDED PRECEDING AND CURRENT ROW",
  "window frame: ROWS UNBOUNDED PRECEDING over an aggregate (Metabase's cumulative sum / count)",
  "ntile / percent_rank / lead with 2 arguments",
  "subquery: NOT EXISTS (correlated)",
  "subquery: IN (subquery) correlated / scalar in WHERE correlated",
  "subquery: scalar in a JOIN condition (correlated)",
  "VALUES in FROM with a column list",
  "IN (list) with 50+ values",
  "DISTINCT ON without ORDER BY (nondeterministic in Postgres too)",
  "regex: Postgres-only escapes (\\y, \\m)",
  "array: ARRAY[…] constructor / = ANY(ARRAY[…])",
  "json ->> / -> on a jsonb column (stored as JSON)",
  "jsonb @>",
  "a UNION's ORDER BY a column number, text under the database's collation",
  "json_each in a LEFT JOIN ON TRUE over a derived table, guarded by a CASE",
  "json_each / jsonb_each / their _text in a LEFT JOIN ON TRUE, ordered",
  "jsonb_array_elements_text / jsonb_object_keys in the select list or LATERAL",
  "GROUP BY a primary key, selecting the columns it decides",
  "GROUP BY a primary key: a decided numeric divided, computed exactly",
  "Metabase's sum where: sum(CASE … ELSE 0.0 END), the arms the rows took",
  "Grafana's $__timeGroup: floor(epoch / n) * n",
  "a top N with its ties: FETCH FIRST n ROWS WITH TIES",
  "a relative window: make_interval with named arguments",
];
const SHAPES: Shape[] = [...REWRITTEN, ...HELD_BI.map((name) => {
  const s = BI_SHAPES.find((b) => b.name === name);
  if (s === undefined) throw new Error(`no BI shape named ${JSON.stringify(name)} in tests/integration/oracle/bi-shapes.ts: a shape renamed there is renamed here`);
  return { name: `BI shape: ${name}`, sql: s.sql };
})];

// --------------------------------------------------------------------------------------------- the skeleton

/** one statement's plan, coarse: what a DuckDB upgrade should keep and a regression of a rewrite would change */
interface Skeleton {
  /** an operator a line in tree order, indented by depth: DuckDB's name, a scan's table and filters, the Mason
   *  functions DuckDB's details print a call of */
  plan: string[];
  /** the Mason functions the statement calls (`PlannedSql.functions`, the rewritten tree's): DuckDB's EXPLAIN names a
   *  projection by its alias, so a projection's calls are only this list's */
  calls: string[];
  delim_join: boolean;
  /** an ORDER_BY with no TOP_N or LIMIT beneath it: the sort of everything its input yields (a late-materialized
   *  page's ORDER_BY sorts the winners a TOP_N found, and is no full sort) */
  full_sort: boolean;
}
interface Held extends Skeleton { name: string; sql: string; zone?: string }

type JsonNode = Record<string, unknown> & { "Node Type": string; Plans?: JsonNode[] };
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : [];
/** DuckDB's operator name; a STREAMING_LIMIT is a LIMIT, DuckDB's choice of which by the THREADS it has (measured: one
 *  thread streams the LEFT lateral preview's limit, two or more do not), so a machine's cores never change a skeleton */
const opOf = (n: JsonNode): string => { const op = n["Node Type"].toUpperCase().replace(/ /g, "_"); return op === "STREAMING_LIMIT" ? "LIMIT" : op; };
const under = (n: JsonNode, p: (n: JsonNode) => boolean): boolean => (n.Plans ?? []).some((c) => p(c) || under(c, p));
const isCteScan = (n: JsonNode): boolean => opOf(n) === "CTE_SCAN";
/** DuckDB 2.0's delimiter join, which it plans without the name: the outer rows materialized as a CTE, what the
 *  lateral computes over their DISTINCT values (a HASH_GROUP_BY of the CTE's scan), and a join of the CTE's rows back
 *  to it — measured: PR #13's LEFT lateral preview at 3ad6493 is `CTE > HASH_JOIN(CTE_SCAN, UNNEST > HASH_GROUP_BY >
 *  CTE_SCAN)`, no operator named DELIM */
const joinsBack = (n: JsonNode): boolean => {
  const [a, b, ...rest] = n.Plans ?? [];
  const groupsCte = (x: JsonNode): boolean => [x, ...descendants(x)].some((d) => opOf(d) === "HASH_GROUP_BY" && under(d, isCteScan));
  return /JOIN/.test(opOf(n)) && a !== undefined && b !== undefined && rest.length === 0 && ((isCteScan(a) && groupsCte(b)) || (isCteScan(b) && groupsCte(a)));
};
const descendants = (n: JsonNode): JsonNode[] => (n.Plans ?? []).flatMap((c) => [c, ...descendants(c)]);

/** Mason's EXPLAIN (VERBOSE, FORMAT JSON) plan (src/duck/explain.ts explainJson: DuckDB's operator as `Top N`, its
 *  details as `DuckDB <key>`) as its skeleton, the operator named as DuckDB names it (`TOP_N`) */
function skeletonOf(root: JsonNode, calls: readonly string[]): Skeleton {
  const plan: string[] = [];
  let delim = false, sort = false;
  const walk = (n: JsonNode, depth: number): void => {
    const op = opOf(n);
    if (/DELIM/.test(op) || joinsBack(n)) delim = true;
    if (op === "ORDER_BY" && !under(n, (c) => /^(TOP_N|LIMIT|STREAMING_LIMIT)$/.test(opOf(c)))) sort = true;
    const parts = [op];
    if (typeof n["Relation Name"] === "string") parts.push(`${String(n.Schema)}.${n["Relation Name"]}`);
    // a scan's filters: DuckDB's top N pushes its bound into the scan as an optional Dynamic Filter, which skips a row
    // group whose zone map cannot beat it; any other filter is checked against the zone maps too
    const filters = strings(n["DuckDB Filters"]);
    const dynamic = filters.flatMap((f) => [...f.matchAll(/Dynamic Filter \(([^()]*)\)/g)].map((m) => m[1]!));
    if (dynamic.length > 0) parts.push(`[top-N filter: ${dynamic.join(", ")}]`);
    if (filters.some((f) => !/Dynamic Filter/.test(f))) parts.push("[zone-map filter]");
    const called = [...new Set(Object.entries(n).filter(([k]) => k.startsWith("DuckDB ")).flatMap(([, v]) => strings(v)).flatMap((s) => [...s.matchAll(/(__mason_\w+)\(/g)].map((m) => m[1]!)))].sort();
    if (called.length > 0) parts.push(`calls ${called.join(", ")}`);
    plan.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
    for (const c of n.Plans ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return { plan, calls: [...calls].sort(), delim_join: delim, full_sort: sort };
}

const lines = (s: Skeleton): string[] => [...s.plan, `Mason functions: ${s.calls.length === 0 ? "none" : s.calls.join(", ")}`,
  `delimiter join: ${s.delim_join ? "yes" : "no"}; full sort: ${s.full_sort ? "yes" : "no"}`];

/** a line diff (`-` the fixture's, `+` this run's), by the longest common subsequence: a plan is a few dozen lines */
function lineDiff(was: readonly string[], now: readonly string[]): string[] {
  const m = was.length, n = now.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i]![j] = was[i] === now[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && was[i] === now[j]) { out.push(`  ${was[i]}`); i++; j++; }
    else if (j < n && (i === m || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${now[j++]}`);
    else out.push(`- ${was[i++]}`);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- the run

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-plans-"));
let store: DuckStore;
let api: PgApiServer;
let c: pg.Client;
const logged: string[] = [];
const fixture: { statements: Held[] } = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { statements: Held[] } : { statements: [] };
const measured = new Map<string, Held>();

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => { logged.push(l); });
  for (const s of DDL) await store.writer.run(s);
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "0.6.1", product: "mason-data",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => { logged.push(l); },
    duck: await store.listener(undefined, undefined, undefined, () => []),
  });
  c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
});
after(async () => {
  await c.end();
  await api.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Mason's EXPLAIN of a statement in a session zone: DuckDB's plan, the SQL Mason sends it and the functions it calls */
async function explained(sql: string, zone = "UTC"): Promise<{ plan: JsonNode; sent: string; functions: string[] }> {
  await c.query(`SET TimeZone = '${zone}'`);
  const r = await c.query({ text: `EXPLAIN (VERBOSE, COSTS false, FORMAT JSON) ${sql}`, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig);
  const [doc] = JSON.parse(String((r.rows[0] as unknown[])[0])) as Array<{ Plan: JsonNode; Mason: { "Sent To DuckDB": string; "Mason Functions DuckDB Calls": string[] } }>;
  return { plan: doc!.Plan, sent: doc!.Mason["Sent To DuckDB"], functions: doc!.Mason["Mason Functions DuckDB Calls"] };
}

for (const shape of SHAPES) {
  test(`plan: ${shape.name}`, async () => {
    const { plan, functions } = await explained(shape.sql, shape.zone);
    const now: Held = { name: shape.name, sql: shape.sql, ...(shape.zone === undefined ? {} : { zone: shape.zone }), ...skeletonOf(plan, functions) };
    measured.set(shape.name, now);
    if (UPDATE) return;
    const was = fixture.statements.find((s) => s.name === shape.name);
    assert.ok(was !== undefined, `"${shape.name}" is not in tests/fixtures/duck-plans.json: a new statement — UPDATE_FIXTURE=1 npm test adds it; read its plan`);
    assert.equal(was.sql, shape.sql, `"${shape.name}": the fixture holds another statement under this name — UPDATE_FIXTURE=1 npm test, then read the diff`);
    assert.equal(was.zone, shape.zone, `"${shape.name}": the fixture holds it in another zone — UPDATE_FIXTURE=1 npm test, then read the diff`);
    const diff = lineDiff(lines(was), lines(now));
    assert.ok(diff.every((l) => l.startsWith("  ")),
      `the plan of "${shape.name}" changed (- the fixture's, + this run's). A regression (a delimiter join, an expression key under a top N, a full sort, a lost filter, more Mason calls): fix the change. A better plan: UPDATE_FIXTURE=1 npm test, read the diff, and say which in the commit.\n` +
      `${shape.sql}${shape.zone === undefined ? "" : `\n(in ${shape.zone})`}\n${diff.join("\n")}`);
  });
}

test("the fixture holds every statement above and no other (UPDATE_FIXTURE=1 rewrites it)", () => {
  if (UPDATE) {
    const statements = SHAPES.map((s) => measured.get(s.name)).filter((s): s is Held => s !== undefined);
    assert.equal(statements.length, SHAPES.length, "a statement's EXPLAIN failed above: the fixture is not rewritten");
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ statements }, null, 2)}\n`);
    console.log(`UPDATE_FIXTURE=1: wrote ${FIXTURE}; read the diff`);
    return;
  }
  const stale = fixture.statements.map((s) => s.name).filter((n) => !SHAPES.some((s) => s.name === n));
  assert.deepEqual(stale, [], "the fixture holds statements this file no longer asks: UPDATE_FIXTURE=1 npm test removes them");
});

// --------------------------------------------------------------------------------------------- what the plans read

/** one scan of a table under DuckDB's EXPLAIN ANALYZE: the row groups it read of those it was offered, and the rows */
interface Scan { rowGroups: number; of: number; rows: number }

/**
 * What DuckDB's scans of `table` read for a statement, MEASURED: the statement run through the listener, the SQL it ran
 * read from the log (the `statement:` line, as tests/duck-wire.test.ts reads it) and held to the SQL its EXPLAIN says
 * it sends, then that SQL under DuckDB's own EXPLAIN ANALYZE (its profile counts each scan's row groups and rows;
 * Mason's EXPLAIN ANALYZE says only the rows an operator produced). A late-materialized page scans the table twice:
 * the top N's scan, and the winners' rows read back by row id.
 */
async function scans(sql: string, table: string): Promise<Scan[]> {
  await c.query("SET TimeZone = 'UTC'");
  const from = logged.length;
  await c.query(sql);
  const sent = logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "");
  assert.ok(sent !== undefined, `no statement logged for ${sql}:\n${logged.slice(from).join("\n")}`);
  assert.equal(sent, (await explained(sql)).sent, "the SQL Mason's EXPLAIN plans is the SQL the statement ran");
  // the session's settings, as the session runner settles them (src/duck/store.ts `settle`); this test's writer runs
  // nothing else. A Mason function's session argument is NULL here: a connection without the variable, never cancelled
  await store.writer.run("SET TimeZone = 'UTC'");
  await store.writer.run("SET search_path = 'public'");
  const r = await store.writer.runAndReadAll(`EXPLAIN (ANALYZE, FORMAT JSON) ${sent}`);
  const out: Scan[] = [];
  const walk = (n: Record<string, unknown>): void => {
    const extra = (n.extra_info ?? {}) as Record<string, unknown>;
    if (n.type === "TABLE_SCAN" && typeof extra.Table === "string" && extra.Table.endsWith(`.${table}`)) {
      out.push({ rowGroups: Number(n.row_groups_scanned), of: Number(n.total_row_groups_to_scan), rows: Number(n.rows_scanned) });
    }
    for (const ch of (n.children ?? []) as Array<Record<string, unknown>>) walk(ch);
  };
  for (const op of (JSON.parse(String(r.getRows()[0]![1])) as { operator: Array<Record<string, unknown>> }).operator) walk(op);
  assert.ok(out.length > 0 && out.every((s) => Number.isFinite(s.rowGroups) && Number.isFinite(s.rows)), `no scan of ${table} with its row groups and rows profiled for ${sent}`);
  return out;
}
const sqlOf = (name: string): string => SHAPES.find((s) => s.name === name)!.sql;
const said = (ss: readonly Scan[]): string => ss.map((s) => `${s.rowGroups} of ${s.of} row groups, ${s.rows} rows`).join("; ");
/** DuckDB's row group: 122,880 rows */
const ROW_GROUPS = Math.ceil(ORDERS / 122_880);

// nullsKeyFolded: with the expression key first, DuckDB's top N read and heaped every row (6.4 s for a 100-row page by
// a timestamp over 197 M rows); one key with its NULLs placed is the scan's dynamic filter, and a row group whose zone
// map cannot beat the page's bound is skipped. Measured on DuckDB 2.0 over this table: 1 of 9 row groups by
// created_at, 1–3 by shipped_at whatever the threads, 9 of 9 for the expression key. (A text column's values spread
// over every row group, so no zone map is skipped by one: notes reads 9 of 9 either way, and is held by its plan only.)
for (const name of ["nulls idiom: a timestamp, LIMIT 100 OFFSET 0", "nulls idiom: IS NOT NULL DESC, a timestamptz", "a page by one bare key (the idiom's control)"]) {
  test(`a 100-row page ordered by a column reads a handful of the ${ROW_GROUPS} row groups, never all: ${name}`, async (t) => {
    const ss = await scans(sqlOf(name), "orders");
    t.diagnostic(said(ss));
    for (const s of ss) {
      assert.equal(s.of, ROW_GROUPS, `a scan was offered ${s.of} row groups: the table is not the ${ROW_GROUPS} row groups this measures`);
      assert.ok(s.rowGroups <= 3, `a 100-row page read ${said(ss)}: the top N no longer prunes the scan`);
    }
  });
}

// leftLateral: DuckDB's LEFT lateral was a delimiter join over the whole base, its LIMIT reached only once every row
// was read (37.9 s for a 100-row preview over 22 M rows); the INNER one is a streaming UNNEST that stops at the LIMIT
for (const name of ["LEFT lateral preview: jsonb_each, LIMIT 100 OFFSET 0", "LEFT lateral preview: json_each, LIMIT 100 OFFSET 200"]) {
  test(`a LEFT lateral of json rows under a LIMIT reads few rows of the base, never all: ${name}`, async (t) => {
    const ss = await scans(sqlOf(name), "orders");
    t.diagnostic(said(ss));
    const rows = ss.reduce((n, s) => n + s.rows, 0);
    assert.ok(rows <= ORDERS / 10, `a 100-row preview read ${said(ss)} of the base's ${ORDERS} rows: its LIMIT no longer stops the scan`);
  });
}
