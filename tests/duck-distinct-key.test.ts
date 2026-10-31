/**
 * A COUNT OF DISTINCT KEYS IS A COUNT (src/duck/distinct-key.ts, src/duck/rewrite.ts `funcCall`; docs/DESIGN.md "A count
 * of distinct keys"): `count(DISTINCT x)` is sent to DuckDB as `count(x)` where x is its table's PRIMARY KEY (the key
 * the copy is written by: never another UNIQUE column, which a copy may hold twice for a moment) and the FROM repeats
 * no row of its table — decided over Postgres's analysis and the catalog Postgres's own pg_index, which declares the
 * source's primary key and nothing a sources file's `key:` names.
 *
 * Offline: the catalog is a PGlite holding the DDL `catalogDdl` makes of a schema shaped as the sync makes it
 * (src/duck/sync.ts: a table's `primaryKey ?? key`, its unique keys), so the uniqueness read is the catalog's.
 * The oracle (tests/integration/oracle/bi-shapes.ts, type-matrix.ts `keyed`) holds the answers to Postgres's, and
 * tests/duck-plans.test.ts the plans. The new module is imported inside each test, so the file loads at a commit
 * without it (scripts/fails-without.ts), where each test fails by name.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Node } from "libpg-query";
import { catalogDdl } from "../src/api/postgres/catalog.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import { analyze, catalogRows } from "../src/duck/analyze.ts";
import { planDuck } from "../src/duck/plan.ts";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import { addedTables, parseSourceText, type SourceFile } from "../src/cli/sources.ts";
import type { SourceTable } from "../src/cli/preflight.ts";

const col = (name: string, type: string, notNull = false) => ({ name, type, notNull, comment: null });
/** a table copied by a sources file's `key:` (it has no primary key): its unique index is over (tenant_id, id) */
const EVENTS: SourceTable = {
  source: "public.events", schema: "public", table: "events", key: [], rows: 10, bytes: 8192, comment: null,
  columns: [col("tenant_id", "text", true), col("id", "bigint", true), col("kind", "text")], foreignKeys: [],
  uniqueKeys: [{ name: "events_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }],
};

let pglite: PGlite;
const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);

before(async () => {
  // the events table as the run adds it from a sources file naming its key, and as the sync declares it to the
  // catalog: `primaryKey ?? key` (src/duck/sync.ts) — the source's own, none
  const src = parseSourceText("kind: postgres\nurl: x\ntables:\n  events: { key: [tenant_id, id] }\n", "app", "/app/mason/sources/app.yml") as SourceFile;
  const added = addedTables(src, [EVENTS], "app", "/app");
  assert.ok(Array.isArray(added), JSON.stringify(added));
  const events = added[0]!;
  assert.deepEqual([events.key, events.primaryKey], [["tenant_id", "id"], []], "a key: table is copied by its key, and keeps the source's own primary key: none");
  const text = (name: string) => ({ name, type: "text" as const });
  const int8 = (name: string) => ({ name, type: "int8" as const });
  const schema: PgSchema = {
    database: "app",
    tables: [
      { name: "tenants", primaryKey: ["id"], joins: [], columns: [text("id"), text("name")] },
      { name: "customers", primaryKey: ["id"], joins: [], columns: [int8("id"), text("tenant_id"), text("email")],
        uniqueKeys: [{ name: "customers_email_key", columns: ["email"], constraint: true, nullsNotDistinct: false }] },
      { name: "orders", primaryKey: ["id"], joins: [], columns: [int8("id"), text("tenant_id"), int8("customer_id"), text("status"), { name: "meta", type: "jsonb" }] },
      // a composite primary key: neither column is unique
      { name: "lines", primaryKey: ["order_id", "line"], joins: [], columns: [int8("order_id"), { name: "line", type: "int4" }, text("product")] },
      // a varchar primary key: joined from a text column, its side is read through a RELABELTYPE to text
      { name: "codes", primaryKey: ["code"], joins: [], columns: [{ name: "code", type: "text", spelled: "character varying(10)" }, text("label")] },
      { name: "events", primaryKey: events.primaryKey ?? events.key, joins: [], columns: events.columns.map((c) => ({ name: c.name, type: c.type === "bigint" ? "int8" as const : "text" as const })),
        ...(events.uniqueKeys ? { uniqueKeys: events.uniqueKeys } : {}) },
    ],
  };
  pglite = new PGlite();
  for (const s of catalogDdl(schema)) await pglite.exec(s);
});
after(async () => { await pglite.close(); await stopParser(); });

/** for each `count(` of the statement, in order: whether its DISTINCT is dropped */
async function dropped(sql: string): Promise<boolean[]> {
  const { distinctCountTables, distinctKeyCounts, uniqueColumnsOf, uniqueColumnsSql } = await import("../src/duck/distinct-key.ts");
  const a = await analyze(catalog, sql, []);
  assert.ok(!("refused" in a), `Postgres refused ${sql}: ${JSON.stringify("refused" in a ? a.refused : null)}`);
  const relids = distinctCountTables(a.tree);
  const at = relids.length === 0 ? new Set<number>() : distinctKeyCounts(a.tree, uniqueColumnsOf(await catalogRows(catalog, uniqueColumnsSql(relids))));
  return [...sql.matchAll(/\bcount\(/g)].map((m) => at.has(m.index));
}

test("the uniqueness is the catalog's primary key alone: never a UNIQUE index that is not the key, never a key: entry's, never a composite key's column", async () => {
  const { distinctCountTables, uniqueColumnsOf, uniqueColumnsSql } = await import("../src/duck/distinct-key.ts");
  const a = await analyze(catalog, "SELECT count(DISTINCT o.id), count(DISTINCT c.email), count(DISTINCT l.order_id), count(DISTINCT e.id), count(DISTINCT t.id) " +
    "FROM orders o, customers c, lines l, events e, tenants t", []);
  assert.ok(!("refused" in a));
  const unique = uniqueColumnsOf(await catalogRows(catalog, uniqueColumnsSql(distinctCountTables(a.tree))));
  const names = new Map((await catalogRows(catalog, "SELECT c.oid::text || '.' || a.attnum::text, c.relname || '.' || a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0")).map(([k, n]) => [k!, n!]));
  // customers.email is UNIQUE in the catalog too, and not the key the copy is written by: not read
  assert.ok((await catalogRows(catalog, "SELECT 1 FROM pg_index WHERE indrelid = 'customers'::regclass AND indisunique AND NOT indisprimary")).length === 1, "the catalog declares the UNIQUE email");
  assert.deepEqual([...unique.keys()].map((k) => names.get(k)).sort(), ["customers.id", "orders.id", "tenants.id"]);
  // each with its btree family's equality: int8 = int8 and the cross-type integer ones, text's =
  const int8eq = 410, int48eq = 15, texteq = 98;
  const orders = [...unique].find(([k]) => names.get(k) === "orders.id")![1];
  assert.ok(orders.equalities.has(int8eq) && orders.equalities.has(int48eq), JSON.stringify([...orders.equalities]));
  const tenants = [...unique].find(([k]) => names.get(k) === "tenants.id")![1];
  assert.ok(tenants.equalities.has(texteq) && tenants.collation === 100, JSON.stringify({ ...tenants, equalities: [...tenants.equalities] }));
  // a statement with no count(DISTINCT …) asks the catalog nothing
  const plain = await analyze(catalog, "SELECT count(o.id), count(*) FROM orders o", []);
  assert.ok(!("refused" in plain));
  assert.deepEqual(distinctCountTables(plain.tree), []);
});

test("a count(DISTINCT x) of a primary key over its table alone is count(x): filtered, grouped, in HAVING, with a FILTER, in a subquery", async () => {
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o"), [true]);
  assert.deepEqual(await dropped("SELECT o.tenant_id, count(DISTINCT o.id) FROM orders o WHERE o.status = 'paid' GROUP BY o.tenant_id HAVING count(DISTINCT o.id) > 1"), [true, true]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FILTER (WHERE o.status = 'paid') FROM orders o"), [true]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT k.code) FROM codes k"), [true], "a varchar key");
  assert.deepEqual(await dropped("SELECT * FROM (SELECT count(DISTINCT o.id) AS n FROM orders o) s"), [true], "decided in the query it belongs to");
  assert.deepEqual(await dropped("SELECT o.tenant_id, count(DISTINCT o.id) FROM orders o GROUP BY ROLLUP (o.tenant_id)"), [true]);
});

test("what is not a primary key keeps its DISTINCT: a UNIQUE column that is not the key, another column, an expression of the key, a composite key's column, a key: entry's, a COLLATE", async () => {
  assert.deepEqual(await dropped("SELECT count(DISTINCT c.email) FROM customers c"), [false], "a UNIQUE column the copy is not written by");
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.status), count(DISTINCT o.customer_id) FROM orders o"), [false, false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id / 2), count(DISTINCT o.id::text) FROM orders o"), [false, false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT l.order_id), count(DISTINCT l.line) FROM lines l"), [false, false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT e.id) FROM events e"), [false], "a key: entry's column is not declared unique");
  assert.deepEqual(await dropped("SELECT count(DISTINCT c.email COLLATE \"C\") FROM customers c"), [false]);
  assert.deepEqual(await dropped("SELECT sum(DISTINCT o.id), count(o.id) FROM orders o"), [false]);
});

test("a join on the OTHER table's primary key repeats no row of the counted one: LEFT, INNER, RIGHT, FULL, a chain, a further conjunct", async () => {
  assert.deepEqual(await dropped("SELECT t.name, count(DISTINCT o.id) FROM orders o LEFT JOIN tenants t ON o.tenant_id = t.id GROUP BY t.name"), [true]);
  assert.deepEqual(await dropped("SELECT t.name, count(DISTINCT o.id) FROM orders o JOIN tenants t ON t.id = o.tenant_id GROUP BY t.name"), [true]);
  assert.deepEqual(await dropped("SELECT t.name, count(DISTINCT o.id) FROM tenants t RIGHT JOIN orders o ON o.tenant_id = t.id GROUP BY t.name"), [true]);
  assert.deepEqual(await dropped("SELECT t.name, count(DISTINCT o.id) FROM tenants t FULL JOIN orders o ON o.tenant_id = t.id GROUP BY t.name"), [true]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN tenants t ON o.tenant_id = t.id AND t.name <> ''"), [true]);
  assert.deepEqual(await dropped("SELECT t.name, count(DISTINCT o.id) FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN tenants t ON c.tenant_id = t.id GROUP BY t.name"), [true]);
  const relabelled = "SELECT k.label, count(DISTINCT o.id) FROM orders o LEFT JOIN codes k ON k.code = o.status GROUP BY 1";
  const analysed = await analyze(catalog, relabelled, []);
  assert.ok(!("refused" in analysed) && /"_node":"RELABELTYPE"/.test(JSON.stringify((analysed.tree as unknown as { jointree: unknown }).jointree)), "the varchar key is read through a RELABELTYPE in the join");
  assert.deepEqual(await dropped(relabelled), [true], "a varchar key read through a RELABELTYPE");
  assert.deepEqual(await dropped("SELECT count(DISTINCT a.id) FROM orders a JOIN orders b ON a.customer_id = b.id"), [true], "the table joined to itself on its key");
});

test("a FROM that may repeat a row of the counted table keeps the DISTINCT: a non-key join, the counted side's own key, an OR, a composite key, a lateral, a cross or comma join, a derived table, a CTE", async () => {
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o JOIN tenants t ON o.tenant_id = t.name"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o JOIN customers c ON o.status = c.email"), [false], "a UNIQUE column that is not the key, on the join's other side");
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o JOIN customers c USING (tenant_id)"), [false], "a USING join on a column no unique index is over");
  // a customer is in as many rows as it has orders: the equality is on the ORDERS' customer_id, not their key
  assert.deepEqual(await dropped("SELECT count(DISTINCT c.id) FROM orders o JOIN customers c ON o.customer_id = c.id"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN tenants t ON o.tenant_id = t.id OR t.name = ''"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o JOIN lines l ON l.order_id = o.id"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN LATERAL jsonb_each(o.meta) d ON TRUE"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o CROSS JOIN tenants t"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o, tenants t WHERE o.tenant_id = t.id"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT s.id) FROM (SELECT o.id FROM orders o) s"), [false]);
  assert.deepEqual(await dropped("WITH s AS (SELECT o.id FROM orders o) SELECT count(DISTINCT s.id) FROM s"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN (SELECT * FROM tenants) t ON o.tenant_id = t.id"), [false]);
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN tenants t ON o.tenant_id = t.id COLLATE \"C\""), [false], "an equality under another collation than the index's");
  assert.deepEqual(await dropped("SELECT count(DISTINCT o.id) FROM orders o LEFT JOIN tenants t ON lower(o.tenant_id) = t.id"), [false], "the counted side's operand an expression");
  // an aggregate of the outer query inside a subquery: the subquery's FROM is not its FROM
  assert.deepEqual(await dropped("SELECT (SELECT count(DISTINCT o.id) FROM tenants t WHERE t.id = 'x') FROM orders o"), [false]);
});

/** the DuckDB SQL a statement is planned to (src/duck/plan.ts), over the catalog, nothing verified */
async function sent(sql: string): Promise<string> {
  const stmt = (await parseSql(sql)).stmts![0]!.stmt as Node;
  return (await planDuck({ catalog, text: sql, stmt, base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collation: { kind: "bytes" }, verified: null })).sql.text;
}

test("the SQL sent counts the key without DISTINCT, its FILTER kept, and an ORDER BY repeating it in its own SELECT alike", async () => {
  assert.equal(await sent("SELECT count(DISTINCT o.id) FROM orders o"), "SELECT count(o.id) AS count FROM orders AS o");
  assert.match(await sent("SELECT count(DISTINCT o.id) FILTER (WHERE o.status = 'paid') FROM orders o"), /count\(o\.id\) FILTER \(WHERE o\.status = 'paid'\)/i);
  const ordered = await sent("SELECT t.name, count(DISTINCT o.id) FROM orders o LEFT JOIN tenants t ON o.tenant_id = t.id GROUP BY t.name ORDER BY count(DISTINCT o.id) DESC, 1");
  assert.doesNotMatch(ordered, /DISTINCT/i, ordered);
  assert.equal([...ordered.matchAll(/count\(o\.id\)/gi)].length, 2, ordered);
  // the same call in ANOTHER SELECT whose join repeats the orders keeps its DISTINCT, in its list and its ORDER BY
  const two = await sent("SELECT x.n, y.c FROM (SELECT count(DISTINCT o.id) AS n FROM orders o) x CROSS JOIN " +
    "(SELECT l.product, count(DISTINCT o.id) AS c FROM orders o JOIN lines l ON l.order_id = o.id GROUP BY 1 ORDER BY count(DISTINCT o.id) DESC LIMIT 1) y");
  assert.equal([...two.matchAll(/count\(o\.id\)/gi)].length, 1, two);
  assert.equal([...two.matchAll(/count\(DISTINCT o\.id\)/gi)].length, 2, two);
  // not a key: as written
  assert.match(await sent("SELECT count(DISTINCT o.status) FROM orders o"), /count\(DISTINCT o\.status\)/i);
});
