#!/usr/bin/env node
/**
 * THE "SAME RESULTS" CLAIM, MADE TESTABLE (Mason, docs/DESIGN.md step 2). A fixed list of
 * statements — the shapes BI SQL is made of, over a shop's tables (customers, orders, order_items: the demo schema of the
 * ClickHouse stack this was cut from) — is run against the SOURCE
 * Postgres and against Mason's Postgres URL, and each answer is diffed: the column names, the rows (in order where the
 * statement orders them, as a multiset where it does not), each cell as text, a number within src/lib/float-equal.ts's
 * tolerance (a float's last bits follow the order it was summed in). The result types are compared too and reported
 * apart — a type that differs while the values match is the declared gap, not a wrong answer.
 *
 *   node scripts/duck-diff.ts --source postgres://user:pw@localhost:5432/demo --mason "$(mason user add diff --json | jq -r .url)"
 *
 * Read-only on both: SELECTs only. Exit 0 when no statement answers differently (a refusal by Mason is counted and
 * listed, never a pass: each is a gap with its SQLSTATE), 1 when one does, 2 for a wrong command line.
 */
import pg from "pg";
import { floatsClose } from "../src/lib/float-equal.ts";

/** Each statement over the demo seed (customers, orders, order_items), named for what it exercises. */
export const STATEMENTS: Array<{ name: string; sql: string }> = [
  { name: "group by, count, sum", sql: "SELECT status, count(*), sum(amount) FROM orders GROUP BY status ORDER BY status" },
  { name: "Metabase's quoted identifiers and LIMIT", sql: 'SELECT "public"."orders"."status" AS "status", count(*) AS "count" FROM "public"."orders" GROUP BY "public"."orders"."status" ORDER BY "public"."orders"."status" ASC LIMIT 1048575' },
  { name: "join and aggregate", sql: "SELECT c.name, count(o.id) AS n, sum(o.amount) AS total FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY c.name" },
  { name: "group by the primary key, an ungrouped column it decides", sql: "SELECT c.id, c.name, count(o.id) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id" },
  { name: "average of a numeric", sql: "SELECT tenant_id, avg(amount) FROM orders GROUP BY tenant_id ORDER BY tenant_id" },
  { name: "numeric divided by an integer", sql: "SELECT id, amount / 3 AS third FROM orders ORDER BY id" },
  { name: "integer division", sql: "SELECT id, quantity / 2 AS half, quantity % 2 AS rest FROM order_items ORDER BY id" },
  { name: "round", sql: "SELECT id, round(amount, 1) AS r, round(amount) AS whole FROM orders ORDER BY id" },
  { name: "sum of an integer", sql: "SELECT sum(quantity) FROM order_items" },
  { name: "count distinct", sql: "SELECT count(DISTINCT tenant_id), count(DISTINCT customer_id) FROM orders" },
  { name: "FILTER", sql: "SELECT tenant_id, count(*) FILTER (WHERE status = 'paid') AS paid, sum(amount) FILTER (WHERE status <> 'paid') AS other FROM orders GROUP BY tenant_id ORDER BY tenant_id" },
  { name: "CASE", sql: "SELECT id, CASE WHEN amount >= 100 THEN 'big' WHEN amount >= 50 THEN 'mid' ELSE 'small' END AS size FROM orders ORDER BY id" },
  { name: "WITH", sql: "WITH t AS (SELECT customer_id, sum(amount) AS total FROM orders GROUP BY customer_id) SELECT c.email, t.total FROM t JOIN customers c ON c.id = t.customer_id ORDER BY t.total DESC" },
  { name: "two WITHs, one reading the other", sql: "WITH a AS (SELECT * FROM orders WHERE status = 'paid'), b AS (SELECT tenant_id, max(amount) AS top FROM a GROUP BY tenant_id) SELECT * FROM b ORDER BY tenant_id" },
  { name: "window: running total", sql: "SELECT id, tenant_id, sum(amount) OVER (PARTITION BY tenant_id ORDER BY id) AS running FROM orders ORDER BY id" },
  { name: "window: rank", sql: "SELECT id, rank() OVER (ORDER BY amount DESC) AS rk, row_number() OVER (PARTITION BY tenant_id ORDER BY amount) AS rn FROM orders ORDER BY id" },
  { name: "correlated subquery", sql: "SELECT c.id, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id) AS orders FROM customers c ORDER BY c.id" },
  { name: "EXISTS", sql: "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'refunded') ORDER BY c.id" },
  { name: "IN subquery", sql: "SELECT product, sum(quantity) FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'paid') GROUP BY product ORDER BY product" },
  { name: "LATERAL", sql: "SELECT c.id, l.amount FROM customers c CROSS JOIN LATERAL (SELECT amount FROM orders o WHERE o.customer_id = c.id ORDER BY amount DESC LIMIT 1) l ORDER BY c.id" },
  { name: "UNION ALL", sql: "SELECT 'order' AS kind, count(*) FROM orders UNION ALL SELECT 'item', count(*) FROM order_items ORDER BY kind" },
  { name: "DISTINCT ON", sql: "SELECT DISTINCT ON (tenant_id) tenant_id, id, amount FROM orders ORDER BY tenant_id, amount DESC" },
  { name: "HAVING", sql: "SELECT customer_id, count(*) FROM orders GROUP BY customer_id HAVING count(*) > 1 ORDER BY customer_id" },
  { name: "string functions", sql: "SELECT id, lower(name), upper(email), length(name), split_part(email, '@', 2) AS domain, substring(name from 1 for 3) AS s, position('a' in name) AS p, name || ' <' || email || '>' AS full FROM customers ORDER BY id" },
  { name: "ILIKE and LIKE", sql: "SELECT id FROM customers WHERE name ILIKE '%a%' AND email LIKE '%.test' ORDER BY id" },
  { name: "string_agg with its order", sql: "SELECT tenant_id, string_agg(product, ', ' ORDER BY product) FROM order_items GROUP BY tenant_id ORDER BY tenant_id" },
  { name: "array_agg", sql: "SELECT tenant_id, array_agg(id ORDER BY id) FROM orders GROUP BY tenant_id ORDER BY tenant_id" },
  { name: "COALESCE and NULLIF", sql: "SELECT id, coalesce(nullif(status, 'paid'), 'was paid') FROM orders ORDER BY id" },
  { name: "date_trunc day in UTC", sql: "SELECT date_trunc('day', created_at) AS day, count(*) FROM orders GROUP BY 1 ORDER BY 1" },
  { name: "Metabase's week (Sunday)", sql: "SELECT CAST((CAST(\"public\".\"orders\".\"created_at\" AS date) + INTERVAL '1 day') AS date) - (EXTRACT(dow FROM (CAST(\"public\".\"orders\".\"created_at\" AS date) + INTERVAL '1 day')) * INTERVAL '1 day') AS w, count(*) FROM \"public\".\"orders\" GROUP BY 1 ORDER BY 1" },
  { name: "AT TIME ZONE", sql: "SELECT id, created_at AT TIME ZONE 'America/New_York' AS ny FROM orders ORDER BY id" },
  { name: "extract", sql: "SELECT id, extract(year FROM created_at) AS y, extract(dow FROM created_at) AS dow, extract(epoch FROM created_at) AS e FROM orders ORDER BY id" },
  { name: "to_char", sql: "SELECT to_char(created_at, 'YYYY-MM') AS month, count(*) FROM orders GROUP BY 1 ORDER BY 1" },
  { name: "casts", sql: "SELECT id::text, amount::int AS a, amount::float8 AS f, created_at::date AS d, '42'::int + 1 AS n FROM orders ORDER BY id" },
  { name: "percentile_cont", sql: "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) FROM orders" },
  { name: "generate_series", sql: "SELECT g, count(o.id) FROM generate_series(1, 4) g LEFT JOIN orders o ON o.customer_id = g GROUP BY g ORDER BY g" },
  { name: "boolean expression column", sql: "SELECT id, amount > 50 AS big, status IN ('paid', 'refunded') AS settled FROM orders ORDER BY id" },
  { name: "NULLS FIRST", sql: "SELECT c.id, max(o.amount) AS m FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'refunded' GROUP BY c.id ORDER BY m NULLS FIRST, c.id" },
  { name: "unordered: a multiset", sql: "SELECT tenant_id, product FROM order_items" },
  { name: "jsonb_build_object", sql: "SELECT id, jsonb_build_object('status', status) FROM orders ORDER BY id" },
];

type Answer = { names: string[]; types: number[]; rows: (string | null)[][] } | { error: { code: string; message: string } };

const raw = { getTypeParser: () => (v: string) => v };

async function run(c: pg.Client, sql: string): Promise<Answer> {
  try {
    const r = await c.query({ text: sql, rowMode: "array", types: raw } as pg.QueryConfig);
    return { names: r.fields.map((f) => f.name), types: r.fields.map((f) => f.dataTypeID), rows: r.rows as (string | null)[][] };
  } catch (e) {
    const d = e as pg.DatabaseError;
    return { error: { code: d.code ?? "?", message: d.message } };
  }
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** one cell: equal text, or two numbers within the float tolerance */
export function sameCell(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (NUMBER.test(a) && NUMBER.test(b)) return floatsClose(Number(a), Number(b));
  return false;
}

const ordered = (sql: string): boolean => /\border\s+by\b/i.test(sql.replace(/\([^()]*\)/g, ""));

/** the first difference between two answers' rows, or null */
export function rowDifference(want: (string | null)[][], got: (string | null)[][], inOrder: boolean): string | null {
  if (want.length !== got.length) return `${got.length} row(s) where Postgres has ${want.length}`;
  const key = (r: (string | null)[]): string => JSON.stringify(r);
  const [w, g] = inOrder ? [want, got] : [[...want].sort((x, y) => key(x).localeCompare(key(y))), [...got].sort((x, y) => key(x).localeCompare(key(y)))];
  for (let i = 0; i < w.length; i++) {
    const a = w[i]!, b = g[i]!;
    if (a.length !== b.length) return `row ${i + 1} has ${b.length} cell(s) where Postgres has ${a.length}`;
    for (let j = 0; j < a.length; j++) if (!sameCell(a[j]!, b[j]!)) return `row ${i + 1}, column ${j + 1}: ${JSON.stringify(b[j])} where Postgres has ${JSON.stringify(a[j])}`;
  }
  return null;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const arg = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const [sourceUrl, masonUrl] = [arg("--source"), arg("--mason")];
  if (!sourceUrl || !masonUrl) {
    process.stderr.write("usage: node scripts/duck-diff.ts --source <the source Postgres URL> --mason <Mason's URL, from mason user add> [--json]\n");
    return 2;
  }
  const source = new pg.Client({ connectionString: sourceUrl, application_name: "duck-diff" });
  const mason = new pg.Client({ connectionString: masonUrl, application_name: "duck-diff" });
  await source.connect();
  await mason.connect();
  // both answer in UTC, so a timestamptz's text is comparable
  await source.query("SET TimeZone = 'UTC'");
  await mason.query("SET TimeZone = 'UTC'");
  const results: Array<{ name: string; verdict: "same" | "different" | "refused" | "both refuse"; detail: string; typeGap: string | null; sql: string }> = [];
  try {
    for (const s of STATEMENTS) {
      const [want, got] = [await run(source, s.sql), await run(mason, s.sql)];
      if ("error" in want) {
        results.push({ name: s.name, verdict: "both refuse", detail: `Postgres: ${want.error.code} ${want.error.message}${"error" in got ? `; Mason: ${got.error.code}` : "; Mason answered"}`, typeGap: null, sql: s.sql });
        continue;
      }
      if ("error" in got) { results.push({ name: s.name, verdict: "refused", detail: `${got.error.code} ${got.error.message}`, typeGap: null, sql: s.sql }); continue; }
      const names = want.names.join(",") === got.names.join(",") ? null : `names ${JSON.stringify(got.names)} where Postgres has ${JSON.stringify(want.names)}`;
      const rows = rowDifference(want.rows, got.rows, ordered(s.sql));
      const gaps = want.types.map((t, i) => t === got.types[i] ? null : `${want.names[i]}: OID ${got.types[i]} where Postgres sends ${t}`).filter((x) => x !== null);
      const problem = [names, rows].filter((x) => x !== null).join("; ");
      results.push({ name: s.name, verdict: problem ? "different" : "same", detail: problem, typeGap: gaps.length ? gaps.join(", ") : null, sql: s.sql });
    }
  } finally {
    await source.end();
    await mason.end();
  }
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    for (const r of results) {
      process.stdout.write(`${r.verdict.padEnd(11)} ${r.name}${r.detail ? `\n            ${r.detail}` : ""}${r.typeGap ? `\n            type gap: ${r.typeGap}` : ""}\n`);
    }
    const count = (v: string): number => results.filter((r) => r.verdict === v).length;
    process.stdout.write(`\n${results.length} statements: ${count("same")} the same, ${count("different")} different, ${count("refused")} refused by Mason, ` +
      `${count("both refuse")} refused by Postgres too; ${results.filter((r) => r.typeGap).length} with a type gap\n`);
  }
  return results.some((r) => r.verdict === "different") ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
