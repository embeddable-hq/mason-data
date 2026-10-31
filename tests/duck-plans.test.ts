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
 * filter or a table filter DuckDB checks against the zone maps is attached (and what that filter compares: a bare
 * column with a constant, or an expression no zone map prunes), the Mason functions (`__mason_*`) an operator's details
 * print a call of and the statement's whole list (DuckDB's EXPLAIN names a projection by its alias, so a projection's
 * calls are only in that list), the time functions the SQL Mason sends calls (the same alias hides ICU's date_trunc
 * of a timestamptz against `truncInstant`'s arithmetic: both are one PROJECTION), and whether a delimiter join
 * (DuckDB 2.0's has no DELIM operator: `delimiterJoin`) or a full sort appears. No cost, estimate or row count.
 *
 * A DIFF MEANS THE PLAN CHANGED. Read it, decide whether the new plan is a REGRESSION (a delimiter join, an expression
 * key under a top N, a full sort, a lost filter, more Mason calls: fix the change) or a BETTER plan (regenerate with
 * `UPDATE_FIXTURE=1 npm run check` and READ the diff), and say which in the commit. A DuckDB upgrade that only renames
 * an operator is regenerated and said as such.
 *
 * And for a few shapes an invariant MEASURED by DuckDB's EXPLAIN ANALYZE over the shop's million orders (nine row
 * groups): a 100-row page ordered by a column reads a handful of row groups, never all; a LEFT lateral of json rows
 * under a LIMIT reads few rows of the base. Synthetic data only: a shop whose every name is the oracle's
 * (tests/integration/oracle/data.ts).
 *
 * A jsonb sorted, grouped and compared (PRs #12 and #14) is held with its key computed per row and with it stored by
 * the keeper, over copies of the shop of their own (`On`): the stored read is what a sort of a jsonb costs on a server
 * that has seen it before, and nothing else holds its plan.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi } from "../src/api/postgres/server.ts";
import type { LibcOrder } from "../src/duck/libc-order.ts";
import { handLibcOrder, lettersOf } from "./libc-order-fixture.ts";
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
/** the orders of `rows` rows: the shop's, and the smaller copies' the jsonb's stored key is held over (`SMALL_ORDERS`) */
// shipped_at: a timestamp without a zone, NULL for the latest twentieth of the orders (not shipped yet) — a NULL in
// EVERY row group defeats DuckDB 2.0's top N pruning even with one key (measured: 9 of 9 row groups for DESC NULLS
// LAST), which is DuckDB's, not the rewrite's; notes a nullable text; meta a jsonb as the copy holds one (Postgres's
// text, NULL for every fifth order)
const ordersDdl = (rows: number): string =>
  `CREATE TABLE public.orders AS SELECT (range + 1)::BIGINT AS id, ${TENANTS} AS tenant_id, CASE WHEN range % 97 = 0 THEN NULL ELSE (range * 7919) % 20000 + 1 END::BIGINT AS customer_id,
     ['paid', 'pending', 'refunded', NULL, '', 'PAID'][range % 6 + 1] AS status, ((range * 37) % 100000 / 100)::DECIMAL(12,2) AS amount,
     TIMESTAMPTZ '2024-12-01 00:00:00+00' + to_seconds(range * 60) AS created_at,
     CASE WHEN range >= ${rows - rows / 20} THEN NULL ELSE TIMESTAMP '2024-12-03 00:00:00' + to_seconds(range * 60) END AS shipped_at,
     CASE WHEN range % 4 = 0 THEN NULL ELSE 'note ' || ((range * 7) % 50000) END AS notes, 0::BIGINT AS changed_seq,
     CASE WHEN range % 5 = 0 THEN NULL ELSE ('{"n": ' || ((range * 37) % 100000 / 100)::DECIMAL(12,2) || ', "tags": ' || CASE range % 3 WHEN 0 THEN '[]' WHEN 1 THEN '["a", "B"]' ELSE '["' || ${TENANTS} || '"]' END
       || ', "status": ' || coalesce(to_json(['paid', 'pending', 'refunded', NULL, '', 'PAID'][range % 6 + 1])::VARCHAR, 'null') || '}')::JSON END AS meta
     FROM range(${rows})`;
/** the smaller copies' orders: two of DuckDB's 122,880-row row groups. Nothing the jsonb entries hold depends on the
 *  size — no skeleton carries one, the stored key's invariants count calls and columns, the per-row one scales with
 *  it, and a late-materialized page is chosen by its LIMIT (DuckDB's late_materialization_max_rows) — so the two shops
 *  that store a key are built and filled at a quarter of the cost (their entries regenerated byte-identical) */
const SMALL_ORDERS = 2 * 122_880;
const DDL = [
  "CREATE TABLE public.tenants (id VARCHAR, name VARCHAR, plan VARCHAR, changed_seq BIGINT)",
  "INSERT INTO public.tenants VALUES ('acme', 'Acme', 'pro', 0), ('globex', 'Globex', 'free', 0), ('', '', NULL, 0)",
  `CREATE TABLE public.customers AS SELECT (range + 1)::BIGINT AS id, ${TENANTS} AS tenant_id, CASE WHEN range % 11 = 0 THEN NULL ELSE 'customer ' || range END AS name,
     CASE WHEN range % 13 = 0 THEN NULL ELSE 'c' || range || '@example.test' END AS email, TIMESTAMPTZ '2023-01-01 00:00:00+00' + to_seconds(range * 3600) AS created_at,
     0::BIGINT AS changed_seq FROM range(20000)`,
  ordersDdl(ORDERS),
  `CREATE TABLE public.order_items AS SELECT (range + 1)::BIGINT AS id, ${TENANTS} AS tenant_id, ((range * 3) % ${ORDERS} + 1)::BIGINT AS order_id,
     ['widget', 'Widget', 'gadget', '', NULL, 'sprocket', 'gizmo', 'widget', '1', '01'][range % 10 + 1] AS product, [1, 2, 0, -1, 7, 1000, 3][range % 7 + 1]::INTEGER AS quantity,
     CASE WHEN range % 17 = 0 THEN NULL ELSE ((range * 13) % 10000 / 100 + 0.01)::DECIMAL(12,2) END AS unit_price, 0::BIGINT AS changed_seq FROM range(300000)`,
  `CREATE TABLE public.products AS SELECT sku, ${TENANTS} AS tenant_id, 'product ' || sku AS name, ['a', 'x', '', 'tools', 'Tools', '1', 'toys', NULL][range % 8 + 1] AS category,
     TIMESTAMPTZ '2023-06-01 00:00:00+00' + to_seconds(range * 86400) AS created_at, 0::BIGINT AS changed_seq
     FROM (SELECT range, ['widget', 'Widget', 'gadget', '', 'sprocket', '1', '01', '17', 'x', 'widget ', 'O''Hara', 'unsold'][range + 1] AS sku FROM range(12))`,
  `CREATE TABLE public.categories AS SELECT code, ${TENANTS} AS tenant_id, 'category ' || code AS name, 0::BIGINT AS changed_seq
     FROM (SELECT range, ['a', 'x', '', 'tools', 'Tools', '1', 'toys'][range + 1] AS code FROM range(7))`,
  // three tags an order for the first 100,000 orders: keyed by (order_id, tag) together
  "CREATE TABLE public.order_tags AS SELECT (range // 3 + 1)::BIGINT AS order_id, ['a', 'b', 'c'][range % 3 + 1] AS tag FROM range(300000)",
];
const text = (name: string): PgColumn => ({ name, type: "text" });
const int8 = (name: string): PgColumn => ({ name, type: "int8" });
const tstz = (name: string): PgColumn => ({ name, type: "timestamptz" });
const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "tenants", primaryKey: ["id"], joins: [], columns: [text("id"), text("name"), text("plan"), int8("changed_seq")] },
    // email UNIQUE in the catalog, as a source declares it: not the key the copy is written by (KEY_COUNTS' contrasts)
    { name: "customers", primaryKey: ["id"], joins: [], columns: [int8("id"), text("tenant_id"), text("name"), text("email"), tstz("created_at"), int8("changed_seq")],
      uniqueKeys: [{ name: "customers_email_key", columns: ["email"], constraint: true, nullsNotDistinct: false }] },
    { name: "orders", primaryKey: ["id"], joins: [],
      columns: [int8("id"), text("tenant_id"), int8("customer_id"), text("status"), { name: "amount", type: "numeric", spelled: "numeric(12,2)" }, tstz("created_at"),
        { name: "shipped_at", type: "timestamptz", spelled: "timestamp" }, text("notes"), int8("changed_seq"), { name: "meta", type: "jsonb" }] },
    { name: "order_items", primaryKey: ["id"], joins: [],
      columns: [int8("id"), text("tenant_id"), int8("order_id"), text("product"), { name: "quantity", type: "int4" }, { name: "unit_price", type: "numeric", spelled: "numeric(12,2)" }, int8("changed_seq")] },
    { name: "products", primaryKey: ["sku"], joins: [], columns: [text("sku"), text("tenant_id"), text("name"), text("category"), tstz("created_at"), int8("changed_seq")] },
    { name: "categories", primaryKey: ["code"], joins: [], columns: [text("code"), text("tenant_id"), text("name"), int8("changed_seq")] },
    // a composite primary key: neither column is unique (a count of distinct order_ids keeps its DISTINCT)
    { name: "order_tags", primaryKey: ["order_id", "tag"], joins: [], columns: [int8("order_id"), text("tag")] },
  ],
};

/**
 * Where a statement is planned (`on`): the shop with nothing stored, under C (absent: every statement above the jsonb
 * shapes), or a shop of its own whose orders' jsonb `meta` has its ORDER key stored as a hidden column by the keeper
 * (src/duck/kept.ts, `orderKeySql`; `storedKey` below) — under C, or under a libc order (`LIBC_COLLATION`, `libcOrder`), where a jsonb's
 * ORDER reads the stored libc key and its EQUALITY the C key, stored as a second hidden column (`EQUAL_STEPS`). `libc`
 * alone is the libc shop's listener without the keeper: the libc key, and the C key, computed per row.
 */
type On = "C, the key stored" | "libc" | "libc, the key stored";
/** and where an invariant runs that no entry is planned in: the C shop of the stored key, through a listener with no
 *  keeper (the key per row over `SMALL_ORDERS`) */
type Where = On | "C, nothing stored (the smaller shop)";
interface Shape { name: string; sql: string; zone?: string; on?: On }

/** what PR #13's rewrites were made for, each in the spelling the tool sends (tests/duck-wire.test.ts holds their SQL
 *  and answers over small tables; here, their plans over a million rows) */
const REWRITTEN: Shape[] = [
  // truncInstant: a BI tool's monthly histogram, in UTC and in a zone with daylight saving; an hour in that zone (the
  // offset kept); a day in a zone of its own (DuckDB's own truncation, named)
  { name: "date_trunc histogram: a month in UTC", sql: "SELECT DATE_TRUNC('month', o.created_at) AS m, count(*) FROM orders o GROUP BY 1 ORDER BY 1 DESC LIMIT 100" },
  { name: "date_trunc histogram: a month in Europe/Berlin", sql: "SELECT DATE_TRUNC('month', o.created_at) AS m, count(*) FROM orders o GROUP BY 1 ORDER BY 1 DESC LIMIT 100", zone: "Europe/Berlin" },
  { name: "date_trunc histogram: an hour in Europe/Berlin", sql: "SELECT DATE_TRUNC('hour', o.created_at) AS h, count(*) FROM orders o WHERE o.created_at >= timestamptz '2025-10-01 00:00:00+00' GROUP BY 1 ORDER BY 1", zone: "Europe/Berlin" },
  { name: "date_trunc histogram: a day in a zone of its own", sql: "SELECT date_trunc('day', o.created_at, 'America/New_York') AS d, count(*) FROM orders o GROUP BY 1 ORDER BY 1" },
  // joinRows (src/duck/late.ts, issue 105): a table preview over joined tables, its rows chosen by row number
  { name: "a top N over joins: a *, sorted by a column's number", sql: "SELECT c.*, o.id FROM customers c LEFT JOIN orders o ON c.id = o.customer_id ORDER BY 1, 2 LIMIT 100" },
  { name: "a top N over joins: every table's columns", sql: "SELECT c.*, o.*, i.* FROM customers c LEFT JOIN orders o ON c.id = o.customer_id LEFT JOIN order_items i ON o.id = i.order_id ORDER BY (c.created_at) IS NULL ASC, c.created_at DESC LIMIT 100 OFFSET 0" },
  { name: "a LIMIT with no ORDER BY over joins: every table's columns", sql: "SELECT c.*, o.*, i.* FROM customers c LEFT JOIN orders o ON c.id = o.customer_id LEFT JOIN order_items i ON o.id = i.order_id LIMIT 100 OFFSET 0" },
  // the fan-out guard (src/duck/distinct-key.ts fanOutBounded): above, every join on a key, sorted by row number; here a
  // join that multiplies, row numbers with no sort: no TOP_N, a limit that stops early
  { name: "a LIMIT with no ORDER BY over a many-to-many join: every table's columns, no sort", sql: "SELECT c.*, o.* FROM customers c JOIN orders o ON c.tenant_id = o.tenant_id LIMIT 100 OFFSET 0" },
  // leftLateral: the "expand the JSON" preview, over jsonb and json, guarded to objects as the tool guards it
  { name: "LEFT lateral preview: jsonb_each, LIMIT 100 OFFSET 0", sql: "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.meta FROM orders t) AS q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta ELSE NULL END) d ON TRUE LIMIT 100 OFFSET 0" },
  { name: "LEFT lateral preview: json_each, LIMIT 100 OFFSET 200", sql: "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.meta FROM orders t) AS q LEFT JOIN json_each(CASE WHEN substring(ltrim(q.meta::text), 1, 1) = '{' THEN q.meta::json ELSE NULL END) d ON TRUE LIMIT 100 OFFSET 200" },
  { name: "LEFT lateral preview: jsonb_array_elements_text, LIMIT 100", sql: "SELECT t.id, e FROM orders t LEFT JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.meta -> 'tags') = 'array' THEN t.meta -> 'tags' END) AS e ON TRUE LIMIT 100" },
  // an unnest of an EXPRESSION: its list computed once (the one element of a list_transform's list), the same
  // streaming UNNEST as a column's, read by a `*` too; counted, DuckDB's own join
  { name: "LEFT lateral of an unnest of an expression, LIMIT 100", sql: "SELECT o.id, x FROM orders o LEFT JOIN LATERAL unnest(ARRAY[o.id, o.id * 10]) x ON true LIMIT 100" },
  { name: "LEFT lateral of an unnest of string_to_array, LIMIT 100 OFFSET 1749950", sql: "SELECT o.id, p FROM orders o LEFT JOIN unnest(string_to_array(o.notes, ' ')) p ON TRUE LIMIT 100 OFFSET 1749950" },
  { name: "LEFT lateral of an unnest of string_to_array read by a *, LIMIT 100 OFFSET 1749950", sql: "SELECT * FROM (SELECT t.id, t.notes FROM orders t) o LEFT JOIN unnest(string_to_array(o.notes, ' ')) p ON TRUE LIMIT 100 OFFSET 1749950" },
  // an argument of TWO columns of the row: DuckDB's delimiter join for the lateral as it is, so computed by a step of
  // its own before it (a projection under the same UNNEST), json rows and an unnest alike
  { name: "LEFT lateral of an argument of two columns: jsonb_each, LIMIT 100", sql: "SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN q.id % 3 <> 0 AND jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE LIMIT 100" },
  { name: "LEFT lateral of an argument of two columns: unnest, LIMIT 100", sql: "SELECT o.id, x FROM orders o LEFT JOIN unnest(ARRAY[o.id, o.customer_id]) x ON TRUE LIMIT 100" },
  { name: "LEFT lateral of an unnest of string_to_array counted, no LIMIT (not rewritten)", sql: "SELECT count(*), count(p) FROM orders o LEFT JOIN unnest(string_to_array(o.notes, ' ')) p ON TRUE" },
  // sorted by a column of the table under a LIMIT: the top N's filter reaches the table's scan, so it streams too
  { name: "LEFT lateral sorted by a table column, LIMIT 100", sql: "SELECT q.id, d.key, d.value FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE ORDER BY q.id DESC LIMIT 100" },
  // where no LIMIT keeps the first rows every row is read either way, and DuckDB's own delimiter join calls the
  // function once per DISTINCT document where the UNNEST calls it once per row (limitBounds: the count over 20 M rows
  // of 2,000 documents took 62.5 s streamed, 2.2 s joined): counted, and sorted by the lateral's own column
  { name: "LEFT lateral counted, no LIMIT: jsonb_each (not rewritten)", sql: "SELECT count(*) FROM (SELECT q.id, d.key, d.value FROM orders q LEFT JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE) sub" },
  { name: "LEFT lateral counted, no LIMIT: json_each (not rewritten)", sql: "SELECT count(*) FROM (SELECT q.id, d.key, d.value FROM orders q LEFT JOIN LATERAL json_each(CASE WHEN substring(ltrim(q.meta::text), 1, 1) = '{' THEN q.meta::json END) d ON TRUE) sub" },
  { name: "LEFT lateral counted, no LIMIT: jsonb_array_elements (not rewritten)", sql: "SELECT count(*) FROM (SELECT t.id, e FROM orders t LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.meta -> 'tags') = 'array' THEN t.meta -> 'tags' END) e ON TRUE) sub" },
  // the nulls idiom a BI tool spells, folded to one table column (nullsKeyFolded) before the bound is decided; a
  // table column sorted by an expression (a jsonb by its order key) reaches no scan, so it keeps DuckDB's join
  { name: "LEFT lateral, the nulls idiom on a table column, LIMIT 100", sql: "SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE ORDER BY (q.created_at) IS NULL, q.created_at DESC LIMIT 100" },
  { name: "LEFT lateral sorted by a jsonb column, LIMIT 100 (not rewritten)", sql: "SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE ORDER BY q.meta, q.id LIMIT 100" },
  // the LIMIT reaching the join through a derived table, a CTE another CTE reads, and a UNION ALL's arms over a CTE
  // (markBounds: the walk meets a CTE before the SELECT that reads it)
  { name: "LEFT lateral in a CTE another CTE reads, through a derived table, LIMIT 100 outside", sql: "WITH a AS (SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE), b AS (SELECT a.key, a.id FROM a) SELECT * FROM (SELECT * FROM b) s LIMIT 100" },
  { name: "LEFT lateral in a CTE both arms of a UNION ALL read, LIMIT 100 outside", sql: "WITH s AS (SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE) SELECT s.id, s.key FROM s UNION ALL SELECT s.id, s.key FROM s LIMIT 100 OFFSET 999950" },
  // an aggregate that reads its rows in order, with no ORDER BY of its own: streamed for Postgres's order (readsInOrder)
  { name: "LEFT lateral under string_agg with no ORDER BY", sql: "SELECT q.id, string_agg(d.key, ',') FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE WHERE q.id < 1000 GROUP BY q.id ORDER BY q.id" },
  { name: "LEFT lateral sorted by its own key, LIMIT 100 (not rewritten)",sql: "SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON TRUE ORDER BY d.key, q.id LIMIT 100" },
  // what is not a LEFT … ON TRUE keeps its own plan: a condition on the lateral's rows
  { name: "LEFT lateral with a condition (not rewritten)",sql: "SELECT q.id, d.key FROM orders q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.meta) = 'object' THEN q.meta END) d ON d.key <> 'n' WHERE q.id < 1000 ORDER BY 1, 2" },
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
/**
 * A JSONB SORTED, GROUPED AND COMPARED (src/duck/jsonb-order.ts; src/duck/rewrite.ts `jsonbKey`, `equalKey`): every form
 * that compares two jsonb compares a byte key of each, computed per row by a Mason function (`__mason_jsonb_key*`, a
 * call per row that holds the executor worker for the statement: docs/DESIGN.md "jsonb's order") — or, once the keeper
 * stored it, read from a hidden BLOB column (src/duck/kept.ts `orderKeySql`; ready: `storedKey` below). A BI tool sends
 * `SELECT <17 columns> FROM t ORDER BY t.<jsonb> DESC LIMIT 100 OFFSET 0`: 17 s over 22 M rows computing the key per
 * row; from the stored key a fraction of a second (DESIGN's table, 20 M rows under C: 19.2–26.1 s by the function,
 * 0.13–0.31 s from the stored key). Each shape is held
 * with the key computed and with it stored: a change that stops a plan reading the stored column (back to the call
 * per row) changes the stored entry's `calls`, and one that computes the key where it was read changes the other's.
 * Under libc equality reads the C key (a libc key refuses a character equality never had to order), stored as a second
 * column beside the order's (`EQUAL_STEPS`) or computed per row without the keeper: an entry of each.
 */
const WIDE = "o.id, o.tenant_id, o.customer_id, o.status, o.amount, o.created_at, o.shipped_at, o.notes, o.changed_seq, o.meta";
const JSONB = {
  desc: `SELECT ${WIDE} FROM orders o ORDER BY o.meta DESC LIMIT 100 OFFSET 0`,
  asc: `SELECT ${WIDE} FROM orders o ORDER BY o.meta ASC LIMIT 100 OFFSET 0`,
  idiom: `SELECT ${WIDE} FROM orders o ORDER BY (o.meta) IS NULL ASC, o.meta DESC LIMIT 100 OFFSET 0`,
  grouped: "SELECT \"meta\", count(*) AS \"count\" FROM \"public\".\"orders\" GROUP BY 1 ORDER BY \"count\" DESC LIMIT 100",
  distinct: "SELECT DISTINCT o.meta FROM orders o LIMIT 100",
  // one of the orders' documents, its keys in another order and its number at another scale: equal only by the key
  equal: "SELECT count(*) FROM orders o WHERE o.meta = '{\"status\": \"pending\", \"n\": 0.370, \"tags\": [\"a\", \"B\"]}'::jsonb",
};
const JSONB_SHAPES: Shape[] = [
  // the BI tool's page by a jsonb, the key not stored: the key's function per row under the top N (a stored read
  // turning into this, or a second call per row, changes the entry); the rows it is handed are an invariant below
  { name: "jsonb page: ORDER BY a jsonb DESC LIMIT 100 OFFSET 0, the key computed per row", sql: JSONB.desc },
  { name: "jsonb page: ORDER BY a jsonb ASC LIMIT 100 OFFSET 0, the key computed per row", sql: JSONB.asc },
  // the same with the key stored: the top N over the hidden column, no Mason function — a plan that calls the key's
  // function again (the stored read lost: a rewrite that no longer asks the keeper, a column it no longer names) fails
  { name: "jsonb page: ORDER BY a jsonb DESC LIMIT 100 OFFSET 0, the key stored", sql: JSONB.desc, on: "C, the key stored" },
  { name: "jsonb page: ORDER BY a jsonb ASC LIMIT 100 OFFSET 0, the key stored", sql: JSONB.asc, on: "C, the key stored" },
  // the nulls idiom over a jsonb (the Trevor.io shape, docs/DESIGN.md "jsonb's order"), folded to one key
  // (nullsKeyFolded): the key per row, or the stored column; the fold undone is a second key on the top N (`TOP_N (2
  // keys)`), which fails either
  { name: "jsonb page: the nulls idiom, ORDER BY (meta) IS NULL, meta DESC LIMIT 100 OFFSET 0, the key computed per row", sql: JSONB.idiom },
  { name: "jsonb page: the nulls idiom, ORDER BY (meta) IS NULL, meta DESC LIMIT 100 OFFSET 0, the key stored", sql: JSONB.idiom, on: "C, the key stored" },
  // a count per document (a BI tool's distribution of a column), DISTINCT and = : equality reads the C key (`equalKey`),
  // computed per row, or under C the stored key, which is the C key; a group or a filter on the document's TEXT (the
  // key dropped: 1.0 and 1.00 two groups) or the call back where the column was stored fails
  { name: "jsonb grouped: GROUP BY a jsonb, count per document, the key computed per row", sql: JSONB.grouped },
  { name: "jsonb grouped: GROUP BY a jsonb, count per document, the key stored", sql: JSONB.grouped, on: "C, the key stored" },
  { name: "jsonb distinct: SELECT DISTINCT a jsonb LIMIT 100, the key computed per row", sql: JSONB.distinct },
  { name: "jsonb distinct: SELECT DISTINCT a jsonb LIMIT 100, the key stored", sql: JSONB.distinct, on: "C, the key stored" },
  { name: "jsonb equal: WHERE jsonb = a document, the key computed per row", sql: JSONB.equal },
  { name: "jsonb equal: WHERE jsonb = a document, the key stored", sql: JSONB.equal, on: "C, the key stored" },
  // under a libc order: the key not stored is the libc key's function per row over ICU's keys of the document's
  // strings (`list_transform(…, icu_sort_key(…))`: the 83 s of DESIGN's table); stored, the page reads the column
  { name: "jsonb under libc: ORDER BY a jsonb DESC LIMIT 100 OFFSET 0, the libc key computed per row", sql: JSONB.desc, on: "libc" },
  { name: "jsonb under libc: ORDER BY a jsonb DESC LIMIT 100 OFFSET 0, the libc key stored", sql: JSONB.desc, on: "libc, the key stored" },
  // and its equality: the C key, computed per row without the keeper, or read from its own stored column beside the
  // libc ORDER key's (src/duck/kept-route.ts EQUAL_STEPS) — never the order's key, which refuses what equality never orders
  { name: "jsonb under libc: GROUP BY a jsonb, the C key computed per row", sql: JSONB.grouped, on: "libc" },
  { name: "jsonb under libc: SELECT DISTINCT a jsonb, the C key computed per row", sql: JSONB.distinct, on: "libc" },
  { name: "jsonb under libc: GROUP BY a jsonb, the C key stored", sql: JSONB.grouped, on: "libc, the key stored" },
  { name: "jsonb under libc: SELECT DISTINCT a jsonb, the C key stored", sql: JSONB.distinct, on: "libc, the key stored" },
  { name: "jsonb under libc: WHERE jsonb = a document, the C key stored", sql: JSONB.equal, on: "libc, the key stored" },
];

/**
 * A COUNT OF DISTINCT KEYS (src/duck/distinct-key.ts): a BI tool's "count of entities" is `count(DISTINCT t.id)` of
 * the table's primary key, often grouped by a dimension joined on ITS key, which DuckDB computed as a hash aggregate of
 * every id (a 197 M-row table grouped by a 780-row dimension: two levels of hash aggregate, 1.5 GB spilled, 120 s,
 * against 9 s for `count(t.id)`). Where the column is its table's primary key and the FROM repeats no row of its table
 * (every join on the other table's primary key) it is sent as `count(id)`; each other shape keeps its DISTINCT (the
 * contrasts, a UNIQUE column that is not the key among them, counted and joined on). The invariant below holds both by the SQL
 * sent and by the plan's aggregates.
 */
const KEY_COUNTS: Shape[] = [
  { name: "count distinct key: count(DISTINCT id) over the table alone", sql: "SELECT count(DISTINCT o.id) FROM orders o" },
  { name: "count distinct key: LEFT JOIN a dimension on its key, GROUP BY its name", sql: "SELECT \"t\".\"name\" AS \"name\", count(DISTINCT \"o\".\"id\") AS \"count\" FROM \"public\".\"orders\" AS \"o\" LEFT JOIN \"public\".\"tenants\" AS \"t\" ON \"o\".\"tenant_id\" = \"t\".\"id\" GROUP BY \"t\".\"name\" ORDER BY \"t\".\"name\" ASC" },
  { name: "count distinct key: INNER JOIN a dimension on its key, GROUP BY its name", sql: "SELECT t.name, count(DISTINCT o.id) AS n FROM orders o JOIN tenants t ON t.id = o.tenant_id GROUP BY t.name ORDER BY n DESC" },
  { name: "count distinct key: FILTER (WHERE …) kept", sql: "SELECT t.name, count(DISTINCT o.id) FILTER (WHERE o.status = 'paid') AS paid FROM orders o LEFT JOIN tenants t ON o.tenant_id = t.id GROUP BY t.name ORDER BY 1" },
  { name: "count distinct key: a join on a non-key column (not rewritten)", sql: "SELECT t.name, count(DISTINCT o.id) AS n FROM orders o JOIN tenants t ON o.status = t.plan GROUP BY t.name ORDER BY 1" },
  { name: "count distinct key: a LATERAL jsonb_each beside it (not rewritten)", sql: "SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o.meta) = 'object' THEN o.meta END) d ON TRUE" },
  { name: "count distinct key: a column that is not a key (not rewritten)", sql: "SELECT o.tenant_id, count(DISTINCT o.customer_id) AS n FROM orders o GROUP BY 1 ORDER BY 1" },
  { name: "count distinct key: a derived table in FROM (not rewritten)", sql: "SELECT count(DISTINCT s.id) FROM (SELECT o.id FROM orders o WHERE o.status = 'paid') s" },
  { name: "count distinct key: a column of a composite key (not rewritten)", sql: "SELECT count(DISTINCT g.order_id) FROM order_tags g" },
  // a UNIQUE column that is not the primary key, counted and on a join's other side: the copy is not written by it, so
  // it may hold one value twice for a moment the source never showed
  { name: "count distinct key: a UNIQUE column that is not the key, counted (not rewritten)", sql: "SELECT c.tenant_id, count(DISTINCT c.email) AS n FROM customers c GROUP BY 1 ORDER BY 1" },
  { name: "count distinct key: a join on a UNIQUE column that is not the key (not rewritten)", sql: "SELECT c.tenant_id, count(DISTINCT o.id) AS n FROM orders o JOIN customers c ON c.email = o.status GROUP BY 1 ORDER BY 1" },
];

const SHAPES: Shape[] = [...REWRITTEN, ...KEY_COUNTS, ...HELD_BI.map((name) => {
  const s = BI_SHAPES.find((b) => b.name === name);
  if (s === undefined) throw new Error(`no BI shape named ${JSON.stringify(name)} in tests/integration/oracle/bi-shapes.ts: a shape renamed there is renamed here`);
  return { name: `BI shape: ${name}`, sql: s.sql };
}), ...JSONB_SHAPES];

// --------------------------------------------------------------------------------------------- the skeleton

/** one statement's plan, coarse: what a DuckDB upgrade should keep and a regression of a rewrite would change */
interface Skeleton {
  /** an operator a line in tree order, indented by depth: DuckDB's name, a top N's count of sort keys, a scan's table
   *  and filters, the Mason
   *  functions DuckDB's details print a call of */
  plan: string[];
  /** the Mason functions the statement calls (`PlannedSql.functions`, the rewritten tree's): DuckDB's EXPLAIN names a
   *  projection by its alias, so a projection's calls are only this list's */
  calls: string[];
  /** the time functions the SQL Mason sends calls (`TIME_CALLS`), read from that SQL: DuckDB's EXPLAIN names a
   *  projection by its alias, so ICU's date_trunc of a timestamptz and the instant's arithmetic (`truncInstant`:
   *  `make_timestamptz(epoch_us(…))` under a CASE on `current_setting('TimeZone')`) are the same PROJECTION in `plan` */
  sends: string[];
  /** what the SQL Mason sends sorts, groups and compares by beyond a column's value (`KEY_SENDS`; present only where
   *  there is one, so the entries before it never print it): ICU's key of a string (`icu_sort_key`, under ICU and a
   *  libc order: a jsonb's strings' keys through `list_transform`), and a stored column the keeper keeps
   *  (`__mason_json_<stored>`: a jsonb's order key, a JSON path) — DuckDB's EXPLAIN names neither in a projection */
  keys?: string[];
  /** a reading aid, never the guard: the tree in `plan` is what a changed plan changes */
  delim_join: boolean;
  /** an ORDER_BY with no TOP_N or LIMIT beneath it: the sort of everything its input yields (a late-materialized
   *  page's ORDER_BY sorts the winners a TOP_N found, and is no full sort) */
  full_sort: boolean;
}
interface Held extends Skeleton { name: string; sql: string; zone?: string; on?: On }

type JsonNode = Record<string, unknown> & { "Node Type": string; Plans?: JsonNode[] };
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : [];
/** DuckDB's operator name; a STREAMING_LIMIT is a LIMIT, DuckDB's choice of which by the THREADS it has (measured: one
 *  thread streams the LEFT lateral preview's limit, two or more do not), so a machine's cores never change a skeleton */
const opOf = (n: JsonNode): string => { const op = n["Node Type"].toUpperCase().replace(/ /g, "_"); return op === "STREAMING_LIMIT" ? "LIMIT" : op; };
const under = (n: JsonNode, p: (n: JsonNode) => boolean): boolean => (n.Plans ?? []).some((c) => p(c) || under(c, p));
const descendants = (n: JsonNode): JsonNode[] => (n.Plans ?? []).flatMap((c) => [c, ...descendants(c)]);
/**
 * DuckDB 2.0's delimiter join, which it plans with no operator named DELIM: the outer rows materialized as a CTE
 * (`DuckDB CTE Name` `__duckdb_delim_<n>`), what the lateral computes over their DISTINCT values (a hash group by of
 * that CTE's scan), and a join of the CTE's rows back to it — measured: PR #13's LEFT lateral preview at 3ad6493 is
 * `CTE > HASH_JOIN(CTE_SCAN, UNNEST > HASH_GROUP_BY > CTE_SCAN)`. Read by the CTE's name, or by that shape over ONE CTE
 * (its `Table Index` the scans' `CTE Index`; a PERFECT_HASH_GROUP_BY or a PROJECTION between counts). `delim_join` is a
 * reading aid: the tree in `plan` is the guard, so a form this misses still changes the fixture's lines.
 */
function delimiterJoin(cte: JsonNode): boolean {
  if (opOf(cte) !== "CTE") return false;
  if (/^__duckdb_delim/.test(String(cte["Engine CTE Name"] ?? ""))) return true;
  const index = cte["Engine Table Index"];
  const scansIt = (n: JsonNode): boolean => opOf(n) === "CTE_SCAN" && n["Engine CTE Index"] === index;
  const outer = (n: JsonNode): boolean => scansIt(n) || (opOf(n) === "PROJECTION" && (n.Plans ?? []).length === 1 && outer(n.Plans![0]!));
  const distinct = (n: JsonNode): boolean => [n, ...descendants(n)].some((d) => /^(PERFECT_)?HASH_GROUP_BY$/.test(opOf(d)) && under(d, scansIt));
  return index !== undefined && descendants(cte).some((j) => /JOIN/.test(opOf(j)) && (j.Plans ?? []).some((a) => outer(a) && (j.Plans ?? []).some((b) => b !== a && distinct(b))));
}

/** the functions a truncation of a time is spelled with in the SQL Mason sends (`sends`) */
const TIME_CALLS = ["date_trunc", "make_timestamptz", "make_timestamp", "epoch_us", "timezone", "current_setting"];
/** what a sort, a group or a comparison reads beyond a value in the SQL Mason sends (`keys`); `list_transform` is
 *  also the list a LEFT lateral's unnest of an expression computes once (leftLateral) */
const KEY_SENDS: Array<[string, RegExp]> = [["icu_sort_key", /\bicu_sort_key\(/], ["list_transform", /\blist_transform\(/], ["a stored column", /\b__mason_json_[0-9a-f]{12}\b/]];
/** a stored column's name is a hash of its read, a jsonb key's of its collation, its encoding and DuckDB's version
 *  (src/duck/kept.ts `orderId`): one name for all, so an upgrade that keeps the plan keeps the fixture */
const storedName = (s: string): string => s.replace(/\b__mason_json_[0-9a-f]{12}\b/g, "__mason_json_<stored>");

/** what a scan's filter other than the top N's is, from DuckDB's text: a column against a constant (what a zone map
 *  prunes by), a null test, a list, or an expression (a cast around the column, a function: no zone map prunes it) */
function filterOf(f: string): string[] {
  const bare = (s: string): string => { let t = s.trim().replace(/^optional: /, ""); while (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim(); return t; };
  const conjuncts: string[] = [];
  let depth = 0, from = 0, quoted = false;
  const t = bare(f);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    else if (!quoted && depth === 0 && t.startsWith(" AND ", i)) { conjuncts.push(t.slice(from, i)); from = i + 5; }
  }
  conjuncts.push(t.slice(from));
  const constant = /^('(?:[^']|'')*'(::[A-Z ]+)?|-?\d+(\.\d+)?)$/;
  return conjuncts.map(bare).filter((x) => !/Dynamic Filter/.test(x)).map((x) => {
    let m = /^(\w+) (IS NOT NULL|IS NULL)$/.exec(x);
    if (m) return `${m[1]} ${m[2]}`;
    m = /^(\w+) (=|!=|<>|<=|>=|<|>) (.+)$/.exec(x);
    if (m && constant.test(m[3]!)) return `${m[1]} ${m[2]} constant`;
    m = /^(\w+) IN \((.*)\)$/.exec(x);
    if (m && m[2]!.split(",").every((v) => constant.test(v.trim()))) return `${m[1]} IN constants`;
    return "an expression";
  });
}
const balanced = (s: string): boolean => { let d = 0, q = false; for (const ch of s) { if (ch === "'") q = !q; else if (!q && ch === "(") d++; else if (!q && ch === ")" && --d < 0) return false; } return d === 0; };

/** Mason's EXPLAIN (VERBOSE, FORMAT JSON) plan (src/duck/explain.ts explainJson: DuckDB's operator as `Top N`, its
 *  details as `DuckDB <key>`) as its skeleton, the operator named as DuckDB names it (`TOP_N`) */
function skeletonOf(root: JsonNode, calls: readonly string[], sent: string): Skeleton {
  const plan: string[] = [];
  let delim = false, sort = false;
  const walk = (n: JsonNode, depth: number): void => {
    const op = opOf(n);
    if (/DELIM/.test(op) || delimiterJoin(n)) delim = true;
    if (op === "ORDER_BY" && !under(n, (c) => /^(TOP_N|LIMIT|STREAMING_LIMIT)$/.test(opOf(c)))) sort = true;
    // a top N with its keys counted: a sort key folded or not (the nulls idiom: `x IS NULL, x` against one key with its
    // NULLS placed, nullsKeyFolded) is a key more or less, where a jsonb's key is never a top N's filter to tell it by
    const sortKeys = strings(n["Engine Order By"]).flatMap((s) => s.split("\n")).filter((s) => s.trim() !== "").length;
    const parts = [op === "TOP_N" ? `TOP_N (${sortKeys === 0 ? "keys not said" : `${sortKeys} key${sortKeys === 1 ? "" : "s"}`})` : op];
    if (typeof n["Relation Name"] === "string") parts.push(`${String(n.Schema)}.${n["Relation Name"]}`);
    // a scan's filters: DuckDB's top N pushes its bound into the scan as an optional Dynamic Filter, which skips a row
    // group whose zone map cannot beat it; any other filter is checked against the zone maps too, where it compares
    // a bare column with a constant (said per filter: a cast around the column keeps the filter and loses the pruning)
    const filters = strings(n["Engine Filters"]).map(storedName);
    const dynamic = filters.flatMap((f) => [...f.matchAll(/Dynamic Filter \(([^()]*)\)/g)].map((m) => m[1]!));
    if (dynamic.length > 0) parts.push(`[top-N filter: ${dynamic.join(", ")}]`);
    const others = filters.flatMap(filterOf);
    if (others.length > 0) parts.push(`[zone-map filter: ${others.join("; ")}]`);
    const called = [...new Set(Object.entries(n).filter(([k]) => k.startsWith("Engine ")).flatMap(([, v]) => strings(v)).flatMap((s) => [...s.matchAll(/(__mason_\w+)\(/g)].map((m) => m[1]!)))].sort();
    if (called.length > 0) parts.push(`calls ${called.join(", ")}`);
    plan.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
    for (const c of n.Plans ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  const keys = KEY_SENDS.filter(([, re]) => re.test(sent)).map(([k]) => k);
  return { plan, calls: [...calls].sort(), sends: TIME_CALLS.filter((f) => new RegExp(`\\b${f}\\(`).test(sent)), ...(keys.length > 0 ? { keys } : {}), delim_join: delim, full_sort: sort };
}

const lines = (s: Skeleton): string[] => [...s.plan, `Mason functions: ${s.calls.length === 0 ? "none" : s.calls.join(", ")}`,
  `time functions sent: ${s.sends.length === 0 ? "none" : s.sends.join(", ")}`,
  ...(s.keys === undefined ? [] : [`keys sent: ${s.keys.join(", ")}`]),
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
/** a listener over a shop: its copy, the client EXPLAINs are asked on, and the log its statements are read from */
interface Target { store: DuckStore; c: pg.Client; logged: string[] }
let shop: Target;
/** what `after` closes, in reverse: each resource as it was made, so a target whose setup failed leaves nothing open */
const closing: Array<() => Promise<unknown> | unknown> = [];
const fixture: { statements: Held[] } = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { statements: Held[] } : { statements: [] };
const measured = new Map<string, Held>();

/** a copy of the shop in a file of its own: the DDL above (the same rows, row groups and statistics), or `ddl` */
async function shopStore(name: string, logged: string[], ddl: readonly string[] = DDL): Promise<DuckStore> {
  const store = await DuckStore.open(path.join(dir, `${name}.db`), (l) => { logged.push(l); });
  closing.push(() => store.close());
  for (const s of ddl) await store.writer.run(s);
  return store;
}
/** the listener over `store` under a collation (`duck`), and a client of it */
async function listen(store: DuckStore, logged: string[], duck: Awaited<ReturnType<DuckStore["listener"]>>): Promise<Target> {
  const api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "0.6.1", product: "mason-data",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => { logged.push(l); },
    duck,
  });
  closing.push(() => api.close());
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  closing.push(() => c.end());
  return { store, c, logged };
}

/** the database's libc collation, and its measured order (src/duck/libc-order.ts) small enough to write by hand, as
 *  tests/duck-json-columns.test.ts writes one: the letters with case and accents, the digits, the space — every
 *  character of the orders' documents' strings, so no row of the stored key is marked */
const LIBC_COLLATION = { provider: "c", collate: "en_US.utf8", locale: null };
function libcOrder(): LibcOrder {
  return handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({ e: "é" })], [" "], { collate: LIBC_COLLATION.collate });
}

/**
 * THE ORDERS' JSONB ORDER KEY STORED (and under libc its equality's C key, `EQUAL_STEPS`, a second column), as a running
 * Mason stores it once the request log is its evidence: the keeper
 * (src/duck/kept.ts) over `store`, told the collation by the listener (`orderBy`), then made to store `meta`'s key now
 * (`eager`, the oracle's: `keepNow`) — its column added and every row filled — and held READY and exact before a plan
 * is asked, so the entries hold what a plan over a stored key is, never whether the policy chose to store it. The
 * modules are imported here, not at the top, so the file loads with src/ as it was before the keeper stored a key
 * (scripts/fails-without.ts), where these entries fail by this assertion.
 */
async function storedKey(store: DuckStore, logged: string[], libc: boolean): Promise<Target> {
  const { KeptJsonPaths } = await import("../src/duck/kept.ts");
  const { ORDER_STEPS } = await import("../src/duck/kept-route.ts");
  assert.ok(typeof ORDER_STEPS === "string", "the keeper stores no jsonb's order key here (src/duck/kept-route.ts has no ORDER_STEPS)");
  const orders = schema.tables.find((t) => t.name === "orders")!;
  let turn: Promise<unknown> = Promise.resolve();
  const keeper = new KeptJsonPaths(store, {
    // the writer's turn, one job at a time (src/duck/sync.ts onWriter): nothing else writes this copy
    onWriter<T>(f: () => Promise<T>): Promise<T> { const t = turn.then(f); turn = t.then(() => undefined, () => undefined); return t; },
    served: () => new Map([["public.orders", orders.columns.map((col) => ({ name: col.name, type: col.type }))]]),
    rebuilding: () => false,
    log: (l: string) => { logged.push(l); },
  }, { enabled: true, eager: true, reviewMs: 0 });
  await keeper.open();
  closing.push(() => keeper.stop());
  const duck = await store.listener(libc ? LIBC_COLLATION : undefined, undefined, libc ? libcOrder() : undefined, () => [], keeper);
  const read = { source: "public.orders", column: "meta", steps: ORDER_STEPS, either: false, canonical: true, asText: false };
  await keeper.keepNow?.([read]);
  const ready = keeper.ready(read);
  assert.ok(ready !== null && ready.exact, `the orders' jsonb order key is not stored and exact (${JSON.stringify(ready)}): ${JSON.stringify(keeper.status())}\n${logged.join("\n")}`);
  if (libc) {
    // under libc a jsonb's equality reads the C key, stored as a column of its own
    const { EQUAL_STEPS } = await import("../src/duck/kept-route.ts") as { EQUAL_STEPS?: string };
    assert.ok(typeof EQUAL_STEPS === "string", "the keeper stores no jsonb's C key for equality here (src/duck/kept-route.ts has no EQUAL_STEPS)");
    const equal = { ...read, steps: EQUAL_STEPS };
    await keeper.keepNow?.([equal]);
    const ok = keeper.ready(equal);
    assert.ok(ok !== null && ok.exact, `the orders' jsonb C key is not stored and exact (${JSON.stringify(ok)}): ${JSON.stringify(keeper.status())}\n${logged.join("\n")}`);
  }
  // one hidden column under C (the order's key equates), two under libc (the order's, and the C key)
  const hidden = (await store.writer.runAndReadAll("SELECT count(*) FROM duckdb_columns() WHERE table_name = 'orders' AND starts_with(column_name, '__mason_json_')")).getRowsJS()[0]![0];
  assert.equal(Number(hidden), libc ? 2 : 1, "the stored keys' hidden columns");
  return listen(store, logged, duck);
}

/** the listeners `on` names, each made once, when a statement first asks for it (a failure fails the statements that ask) */
const made = new Map<Where, Promise<Target>>();
/** the smaller shops, one under C and one under the libc order: their orders alone, `SMALL_ORDERS` rows. Each has two
 *  listeners, one whose keeper stored the key and one with no keeper (the key per row; it names its columns, so the
 *  hidden one beside them changes nothing it reads) */
const smaller = new Map<string, Promise<{ store: DuckStore; logged: string[] }>>();
function smallShop(name: "c" | "libc"): Promise<{ store: DuckStore; logged: string[] }> {
  let s = smaller.get(name);
  if (s === undefined) {
    s = (async () => { const logged: string[] = []; return { store: await shopStore(`small-${name}`, logged, [ordersDdl(SMALL_ORDERS)]), logged }; })();
    smaller.set(name, s);
  }
  return s;
}
function target(on: Where | undefined): Promise<Target> {
  if (on === undefined) return Promise.resolve(shop);
  let t = made.get(on);
  if (t === undefined) {
    t = (async (): Promise<Target> => {
      const libc = on.startsWith("libc");
      const { store, logged } = await smallShop(libc ? "libc" : "c");
      if (on.endsWith("the key stored")) return storedKey(store, logged, libc);
      return listen(store, logged, libc ? await store.listener(LIBC_COLLATION, undefined, libcOrder(), () => []) : await store.listener(undefined, undefined, undefined, () => []));
    })();
    made.set(on, t);
  }
  return t;
}

before(async () => {
  const logged: string[] = [];
  const store = await shopStore("duck", logged);
  shop = await listen(store, logged, await store.listener(undefined, undefined, undefined, () => []));
});
after(async () => {
  await Promise.allSettled([...made.values(), ...smaller.values()]);
  // every close tried, whatever an earlier one threw: a store left open keeps its worker thread, and the file never ends
  const failed: unknown[] = [];
  for (const close of closing.reverse()) {
    try { await close(); } catch (e) { failed.push(e); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed.length > 0) throw new AggregateError(failed, `${failed.length} of the plan test's stores, listeners or clients failed to close`);
});

/** Mason's EXPLAIN of a statement in a session zone, on a shop's listener: DuckDB's plan, the SQL Mason sends it and the
 *  functions it calls */
async function explained(sql: string, zone = "UTC", { c }: Target = shop): Promise<{ plan: JsonNode; sent: string; functions: string[] }> {
  await c.query(`SET TimeZone = '${zone}'`);
  const r = await c.query({ text: `EXPLAIN (VERBOSE, COSTS false, FORMAT JSON) ${sql}`, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig);
  const [doc] = JSON.parse(String((r.rows[0] as unknown[])[0])) as Array<{ Plan: JsonNode; Mason: { "Sent To Engine": string; "Mason Functions Engine Calls": string[] } }>;
  return { plan: doc!.Plan, sent: doc!.Mason["Sent To Engine"], functions: doc!.Mason["Mason Functions Engine Calls"] };
}

for (const shape of SHAPES) {
  test(`plan: ${shape.name}`, async () => {
    const { plan, functions, sent } = await explained(shape.sql, shape.zone, await target(shape.on));
    const now: Held = { name: shape.name, sql: shape.sql, ...(shape.zone === undefined ? {} : { zone: shape.zone }), ...(shape.on === undefined ? {} : { on: shape.on }),
      ...skeletonOf(plan, functions, sent) };
    measured.set(shape.name, now);
    if (UPDATE) return;
    const was = fixture.statements.find((s) => s.name === shape.name);
    assert.ok(was !== undefined, `"${shape.name}" is not in tests/fixtures/duck-plans.json: a new statement — UPDATE_FIXTURE=1 npm run check adds it; read its plan`);
    assert.equal(was.sql, shape.sql, `"${shape.name}": the fixture holds another statement under this name — UPDATE_FIXTURE=1 npm run check, then read the diff`);
    assert.equal(was.zone, shape.zone, `"${shape.name}": the fixture holds it in another zone — UPDATE_FIXTURE=1 npm run check, then read the diff`);
    assert.equal(was.on, shape.on, `"${shape.name}": the fixture holds it planned over another shop — UPDATE_FIXTURE=1 npm run check, then read the diff`);
    const diff = lineDiff(lines(was), lines(now));
    assert.ok(diff.every((l) => l.startsWith("  ")),
      `the plan of "${shape.name}" changed (- the fixture's, + this run's). A regression (a delimiter join, an expression key under a top N, a full sort, a lost filter, more Mason calls): fix the change. A better plan: UPDATE_FIXTURE=1 npm run check, read the diff, and say which in the commit.\n` +
      `${shape.sql}${shape.zone === undefined ? "" : `\n(in ${shape.zone})`}${shape.on === undefined ? "" : `\n(${shape.on})`}\n${diff.join("\n")}`);
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
  assert.deepEqual(stale, [], "the fixture holds statements this file no longer asks: UPDATE_FIXTURE=1 npm run check removes them");
});

// --------------------------------------------------------------------------------------------- what the plans read

/** one scan of a table under DuckDB's EXPLAIN ANALYZE: the row groups it read of those it was offered, and the rows */
interface Scan {
  rowGroups: number; of: number; rows: number;
  /** the columns it read (DuckDB's `Projections`; a stored column as `storedName` says it), and whether it feeds a top N */
  columns: string[]; topN: boolean;
}

/**
 * What DuckDB's scans of `table` read for a statement, MEASURED: the statement run through the listener, the SQL it ran
 * read from the log (the `statement:` line, as tests/duck-wire.test.ts reads it) and held to the SQL its EXPLAIN says
 * it sends, then that SQL under DuckDB's own EXPLAIN ANALYZE (its profile counts each scan's row groups and rows;
 * Mason's EXPLAIN ANALYZE says only the rows an operator produced). A late-materialized page scans the table twice:
 * the top N's scan, and the winners' rows read back by row id.
 */
async function scans(sql: string, table: string, on?: Where): Promise<Scan[]> {
  const t = await target(on), { c, logged, store } = t;
  await c.query("SET TimeZone = 'UTC'");
  const from = logged.length;
  await c.query(sql);
  const sent = logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "");
  assert.ok(sent !== undefined, `no statement logged for ${sql}:\n${logged.slice(from).join("\n")}`);
  assert.equal(sent, (await explained(sql, "UTC", t)).sent, "the SQL Mason's EXPLAIN plans is the SQL the statement ran");
  // the session's settings, as the session runner settles them (src/duck/store.ts `settle`); this test's writer runs
  // nothing else. A Mason function's session argument is NULL here: a connection without the variable, never cancelled.
  // The writer is NOT a session's connection: it lacks the session's `default_null_order`, which a sort that leaves
  // its NULLs to the default would read differently. nullsKeyFolded spells NULLS FIRST / LAST on every key it writes,
  // so the sort measured is the sort that runs; a later rewrite that relies on the default null order is measured on
  // a session's connection instead.
  await store.writer.run("SET TimeZone = 'UTC'");
  await store.writer.run("SET search_path = 'public'");
  const r = await store.writer.runAndReadAll(`EXPLAIN (ANALYZE, FORMAT JSON) ${sent}`);
  const out: Scan[] = [];
  const walk = (n: Record<string, unknown>, topN: boolean): void => {
    const extra = (n.extra_info ?? {}) as Record<string, unknown>;
    if (n.type === "TABLE_SCAN" && typeof extra.Table === "string" && extra.Table.endsWith(`.${table}`)) {
      // a metric DuckDB did not write is a failure, never a 0 (Number(null) is 0, and 0 rows would pass)
      const metric = (k: string): number => {
        const v = n[k];
        assert.ok(typeof v === "number" && Number.isFinite(v), `DuckDB's profile of a scan of ${table} has no ${k} (${JSON.stringify(v)}) for ${sent}`);
        return v;
      };
      const columns = strings(extra.Projections).flatMap((x) => x.split("\n")).map((x) => storedName(x.trim())).filter((x) => x !== "");
      out.push({ rowGroups: metric("row_groups_scanned"), of: metric("total_row_groups_to_scan"), rows: metric("rows_scanned"), columns, topN });
    }
    // a scan feeds the top N above it through projections and filters, never through a join (a late-materialized
    // page's read-back of the winners is the join's other side)
    const feeds = n.type === "TOP_N" || (topN && !/JOIN/.test(String(n.type)));
    for (const ch of (n.children ?? []) as Array<Record<string, unknown>>) walk(ch, feeds);
  };
  for (const op of (JSON.parse(String(r.getRows()[0]![1])) as { operator: Array<Record<string, unknown>> }).operator) walk(op, false);
  assert.ok(out.length > 0, `no scan of ${table} profiled for ${sent}`);
  return out;
}
const sqlOf = (name: string): string => SHAPES.find((s) => s.name === name)!.sql;
const said = (ss: readonly Scan[]): string => ss.map((s) => `${s.rowGroups} of ${s.of} row groups, ${s.rows} rows`).join("; ");

// A COUNT OF DISTINCT KEYS (KEY_COUNTS): DuckDB 2.0 computes a count(DISTINCT x) as an aggregate of its own over the
// groups and x (a HASH_GROUP_BY to make x distinct, under the one that counts: the two levels that spilled 1.5 GB over
// 197 M rows), and count(x) as one. Each rewritten shape is sent without a DISTINCT and aggregates ONCE (or not at all:
// DuckDB answers an ungrouped count of a column with no NULL from its statistics while planning); each contrast keeps
// count(DISTINCT …) and its two levels — which a rewrite gone too far (a contrast counted plainly) fails as surely as
// one lost (a lateral's delimiter join adds an aggregate of its own).
for (const shape of KEY_COUNTS) {
  const rewritten = !shape.name.endsWith("(not rewritten)");
  test(`a count of distinct ${rewritten ? "keys aggregates once, sent as count(x)" : "non-keys keeps its DISTINCT and its two aggregates"}: ${shape.name}`, async () => {
    const { plan, sent } = await explained(shape.sql);
    const aggregates = skeletonOf(plan, [], sent).plan.filter((l) => /^\s*(HASH_GROUP_BY|PERFECT_HASH_GROUP_BY|UNGROUPED_AGGREGATE)\b/.test(l)).length;
    if (rewritten) {
      assert.doesNotMatch(sent, /DISTINCT/i, `${shape.name}: sent with its DISTINCT`);
      assert.ok(aggregates <= 1, `${shape.name}: ${aggregates} aggregates in DuckDB's plan, where count(x) is one\n${sent}`);
    } else {
      assert.match(sent, /count\(DISTINCT /i, `${shape.name}: its DISTINCT dropped where it may change the count`);
      // two, and a lateral's delimiter join a third (its distinct arguments)
      assert.ok(aggregates >= 2, `${shape.name}: a count(DISTINCT …) planned in ${aggregates} aggregates, where DuckDB 2.0 plans two\n${sent}`);
    }
  });
}
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
      // loose on purpose: how many row groups a scan reads is how many threads claimed one before the top N's bound
      // reached it (1–3 measured, more on a loaded runner), and the old plan reads all 9; 6 keeps a margin both ways
      assert.ok(s.rowGroups <= 6, `a 100-row page read ${said(ss)}: the top N no longer prunes the scan`);
    }
  });
}

// leftLateral: DuckDB's LEFT lateral was a delimiter join over the whole base, its LIMIT reached only once every row
// was read (37.9 s for a 100-row preview over 22 M rows); the INNER one is a streaming UNNEST that stops at the LIMIT.
// The bound grows with the threads: each reads about one 2,048-row vector before the LIMIT stops it (18,432 rows on
// nine), so past ~48 threads, or if DuckDB ever hands threads finer tasks, the fast plan would cross a tenth too
for (const name of ["LEFT lateral preview: jsonb_each, LIMIT 100 OFFSET 0", "LEFT lateral preview: json_each, LIMIT 100 OFFSET 200",
  "LEFT lateral of an argument of two columns: jsonb_each, LIMIT 100", "LEFT lateral of an argument of two columns: unnest, LIMIT 100", "LEFT lateral of an unnest of an expression, LIMIT 100"]) {
  test(`a LEFT lateral of a list under a LIMIT reads few rows of the base, never all: ${name}`, async (t) => {
    const ss = await scans(sqlOf(name), "orders");
    t.diagnostic(said(ss));
    const rows = ss.reduce((n, s) => n + s.rows, 0);
    assert.ok(rows <= ORDERS / 10, `a 100-row preview read ${said(ss)} of the base's ${ORDERS} rows: its LIMIT no longer stops the scan`);
  });
}

/** how many rows a statement handed each Mason function, run through the listener and counted on the thread the
 *  functions run on (src/duck/executor.ts functionRows): the rows, not the calls, so neither DuckDB's chunking nor
 *  its partitioning nor the threads move it */
async function rowsOf(sql: string, on?: Where): Promise<Map<string, number>> {
  const { c, store } = await target(on);
  await c.query("SET TimeZone = 'UTC'");
  const before = await store.functionRows();
  await c.query(sql);
  const after = await store.functionRows();
  return new Map([...after].map(([k, n]) => [k, n - (before.get(k) ?? 0)]));
}

// limitBounds: where no LIMIT keeps the first rows, the streamed lateral handed the list's function every ROW of the
// base (the count over 22 M rows went from 79 s to over 200 s); DuckDB's own delimiter join hands it each DISTINCT
// argument once. The orders' meta repeats: 240,000 distinct documents over the million rows, so a count hands the
// function about 240,000 rows joined and 1,000,000 streamed. Sorted by a table column under a LIMIT it streams, and
// the top N's filter in the scan leaves it the rows of a row group or so (122,880 rows; more where a thread passed
// rows of another before the bound arrived), never the million.
const ROW_GROUP = 122_880;
test("a count over a LEFT lateral of json rows hands the function each distinct document once, never every row", async (t) => {
  const distinct = Number((await shop.store.writer.runAndReadAll("SELECT count(DISTINCT meta::VARCHAR) FROM public.orders")).getRows()[0]![0]);
  for (const name of ["LEFT lateral counted, no LIMIT: jsonb_each (not rewritten)", "LEFT lateral counted, no LIMIT: json_each (not rewritten)"]) {
    const keys = (await rowsOf(sqlOf(name))).get("__mason_json_keys") ?? 0;
    t.diagnostic(`${name}: __mason_json_keys handed ${keys} rows; ${distinct} distinct documents, ${ORDERS} rows`);
    assert.ok(keys > 0, `${name}: __mason_json_keys was handed no row — the function counter or the statement changed`);
    // each distinct argument once, and the NULL's group: a margin for a document an argument writes two ways
    assert.ok(keys <= distinct * 1.05 + 1, `${name}: __mason_json_keys was handed ${keys} rows over ${distinct} distinct documents: per row, not per distinct document`);
  }
});
// leftLateral: an unnest of an expression streamed computes the expression ONCE a row — the CASE that keeps the list
// never empty names a lambda's parameter twice, never the expression. The SQL sent names the expression once, and the
// Mason function it is (string_to_array, a JavaScript call) is handed each of the million rows once: 2,000,000 named
// twice. The OFFSET to the last rows streams them all.
test("a LEFT lateral of an unnest of an expression computes the expression once a row, in the SQL sent and in the calls", async (t) => {
  for (const name of ["LEFT lateral of an unnest of string_to_array, LIMIT 100 OFFSET 1749950", "LEFT lateral of an unnest of string_to_array read by a *, LIMIT 100 OFFSET 1749950"]) {
    const { sent } = await explained(sqlOf(name));
    assert.equal(sent.match(/__mason_string_to_array\(/g)?.length, 1, `${name}: the expression named other than once in the SQL sent\n${sent}`);
    assert.doesNotMatch(sent, /LEFT JOIN/, `${name}: not streamed\n${sent}`);
    const calls = (await rowsOf(sqlOf(name))).get("__mason_string_to_array") ?? 0;
    t.diagnostic(`${name}: __mason_string_to_array handed ${calls} rows of ${ORDERS}`);
    assert.equal(calls, ORDERS, `${name}: __mason_string_to_array was handed ${calls} rows of the base's ${ORDERS}: not once a row`);
  }
  const { sent } = await explained(sqlOf("LEFT lateral of an unnest of an expression, LIMIT 100"));
  assert.equal(sent.match(/ARRAY\[o\.id, o\.id \* 10\]/g)?.length, 1, sent);
});
test("a LEFT lateral sorted by a table column under a LIMIT hands the function few rows of the base, never all", async (t) => {
  for (const name of ["LEFT lateral sorted by a table column, LIMIT 100", "LEFT lateral, the nulls idiom on a table column, LIMIT 100"]) {
    const keys = (await rowsOf(sqlOf(name))).get("__mason_json_keys") ?? 0;
    t.diagnostic(`${name}: __mason_json_keys handed ${keys} rows of ${ORDERS}`);
    assert.ok(keys > 0 && keys <= 2 * ROW_GROUP, `${name}: __mason_json_keys was handed ${keys} rows of the base's ${ORDERS}: the top N's filter no longer reaches the scan`);
  }
});

// A JSONB SORTED BY ITS KEY (src/duck/jsonb-order.ts): with the key not stored, a page by a jsonb hands the key's
// function EVERY row (a call per row, the executor worker held for the statement: 17 s for the BI tool's page over 22 M
// rows) — measured `SMALL_ORDERS` + 100 here: every row (a NULL document's call included) under the top N, and the 100
// winners' again where the late-materialized page sorts them. Over the smaller shop, through its listener with no
// keeper: the count scales with the rows (1,000,100 over the million). Fewer is a better plan (a filter reaching the
// scan, the key read from a column): tighten this then. Twice per row is a regression.
const JSONB_PAGE = JSONB_SHAPES.find((s) => s.sql === JSONB.desc && s.on === undefined)!.name;
test("a page by a jsonb with its key not stored computes the key for every row, once", async (t) => {
  const keys = (await rowsOf(sqlOf(JSONB_PAGE), "C, nothing stored (the smaller shop)")).get("__mason_jsonb_key") ?? 0;
  t.diagnostic(`${JSONB_PAGE}: __mason_jsonb_key handed ${keys} rows of ${SMALL_ORDERS}`);
  assert.ok(keys >= SMALL_ORDERS, `the key was computed for ${keys} of the ${SMALL_ORDERS} rows: fewer than every row — a better plan? Read it, and tighten this invariant`);
  assert.ok(keys <= SMALL_ORDERS * 1.1, `the key was computed for ${keys} rows of ${SMALL_ORDERS}: more than once a row`);
});

// THE KEY STORED (src/duck/kept.ts `orderKeySql`, src/duck/rewrite.ts `keptRead`): a plan reads the hidden column, and
// no row's key is computed — the exact read's CASE calls `__mason_marked_key` only at a marked row (none here), so the
// function is handed nothing; an equality computes its constant's key once. And the top N's scan reads the stored key,
// never the documents (the late-materialized page reads the 100 winners' documents back by row id): a plan that
// computes the key again, or reads every document to sort, fails here.
//
// What it does NOT gain: DuckDB 2.0 pushes no top N's filter into a scan of the BLOB column through the CASE (the
// entries hold it: no `[top-N filter]`), nor, measured once on DuckDB 2.0 on 2026-10-29 and held by no test, when the
// bare column is sorted (9 of 9 row groups, 1,000,000 rows, no dynamic filter); and in this shop a jsonb's order is
// spread over every row group like a text column's (`notes`: `meta` cycles with the id), so no zone map would skip one
// anyway — a table whose documents follow insertion time could. The gain is the calls.
for (const name of JSONB_SHAPES.filter((s) => s.on !== undefined && s.on.endsWith("the key stored") && !/the C key computed/.test(s.name)).map((s) => s.name)) {
  const shape = SHAPES.find((s) => s.name === name)!;
  test(`a jsonb read from its stored key computes no row's key: ${name}`, async (t) => {
    const rows = [...(await rowsOf(shape.sql, shape.on))].filter(([, n]) => n > 0);
    t.diagnostic(`Mason functions handed: ${rows.length === 0 ? "nothing" : rows.map(([k, n]) => `${k} ${n} rows`).join(", ")}`);
    // the constant's key (`jsonb = '…'::jsonb`) is what a function may be handed: once measured, a few times if a DuckDB
    // evaluates it per thread — never per row
    const allowed = shape.sql === JSONB.equal ? 16 : 0;
    assert.ok(rows.every(([, n]) => n <= allowed), `the stored key's plan handed ${rows.map(([k, n]) => `${k} ${n} rows`).join(", ")}: a key computed per row again`);
    if (!/LIMIT 100 OFFSET 0/.test(shape.sql)) return;
    const ss = await scans(shape.sql, "orders", shape.on);
    t.diagnostic(ss.map((s) => `${s.topN ? "the top N's scan" : "a scan"}: ${s.rowGroups} of ${s.of} row groups, ${s.rows} rows, reading ${s.columns.join(", ")}`).join("; "));
    const sorted = ss.filter((s) => s.topN);
    assert.ok(sorted.length > 0, `no scan feeds the top N: ${JSON.stringify(ss)}`);
    for (const s of sorted) {
      assert.ok(s.columns.includes("__mason_json_<stored>"), `the top N's scan does not read the stored key: ${s.columns.join(", ")}`);
      assert.ok(!s.columns.includes("meta"), `the top N's scan reads every row's document: ${s.columns.join(", ")}`);
    }
  });
}
