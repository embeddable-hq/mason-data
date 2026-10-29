/**
 * THE TOOLS' RECORDED STATEMENTS: every statement psql, pgjdbc, node-postgres, Metabase, Grafana, DBeaver and Superset
 * were recorded sending, and Postico's SHOW ALL (tests/postgres-api/corpus/) is sent to the Postgres listener, over DuckDB tables shaped as the
 * shop's (one row each, corpus/shop.ts), and must be ANSWERED: a catalog statement by the catalog Postgres, anything
 * that reads a table by DuckDB. What a tool sends that is refused for want of a rewrite is in `KNOWN_GAPS`, with why.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type DuckOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import { PSQL } from "./postgres-api/corpus/psql.ts";
import { TOOLS } from "./postgres-api/corpus/tools.ts";
import { SHOP_SCHEMA as SCHEMA } from "./postgres-api/corpus/shop.ts";

const DUCK_TYPE: Record<string, [string, string]> = {
  int8: ["BIGINT", "1"], int4: ["INTEGER", "1"], text: ["VARCHAR", "'x'"], float8: ["DOUBLE", "1.5"], bool: ["BOOLEAN", "true"],
  timestamptz: ["TIMESTAMPTZ", "'2026-09-01 10:00:00+00'"], date: ["DATE", "'2026-09-01'"],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-corpus-"));
let store: DuckStore;
let api: PgApiServer;
let client: pg.Client;
before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  for (const t of SCHEMA.tables) {
    const cols = t.columns.map((c) => { const d = DUCK_TYPE[c.type]; assert.ok(d, `a shop column of type ${c.type}: add it to DUCK_TYPE`); return [c.name, ...d] as const; });
    await store.writer.run(`CREATE TABLE public."${t.name}" (${cols.map(([n, ty]) => `"${n}" ${ty}`).join(", ")}, PRIMARY KEY (${t.primaryKey.map((k) => `"${k}"`).join(", ")}))`);
    await store.writer.run(`INSERT INTO public."${t.name}" VALUES (${cols.map(([, , v]) => v).join(", ")})`);
  }
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: () => ({}),
    schema: () => SCHEMA,
    record: () => undefined, log: () => undefined,
    duck: await planning(await store.listener(undefined)),
  });
  client = new pg.Client({ host: "127.0.0.1", port: api.port, user: "tool", password: "token", database: "shop" });
  await client.connect();
});
after(async () => {
  await client.end();
  await api.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** every plan the listener made, kept to read what it says it calls (src/duck/plan.ts PlannedSql) */
const planned: Array<{ text: string; functions?: readonly string[] }> = [];
async function planning(duck: DuckOptions): Promise<DuckOptions> {
  const plan = duck.plan.bind(duck);
  return { ...duck, plan: async (...a) => { const p = await plan(...a); planned.push(p.sql as unknown as { text: string; functions?: readonly string[] }); return p; } };
}

const oids = new Map<string, string>();
const filled = async (sql: string): Promise<string> => {
  for (const [, table] of sql.matchAll(/\{\{oid:(\w+)\}\}/g)) {
    if (!oids.has(table!)) {
      const r = await client.query("SELECT c.oid::text AS oid FROM pg_catalog.pg_class c WHERE c.relname = $1 AND pg_catalog.pg_table_is_visible(c.oid)", [table]);
      oids.set(table!, r.rows[0]!.oid as string);
    }
    sql = sql.replaceAll(`{{oid:${table}}}`, oids.get(table!)!);
  }
  return sql;
};
const valuesFor = (sql: string): string[] =>
  [...new Set([...sql.matchAll(/\$\d+/g)].map((m) => m[0]))].map((p) =>
    new RegExp(`created_at >= \\${p}\\b`).test(sql) ? "2026-09-01T00:00:00Z" : new RegExp(`created_at < \\${p}\\b`).test(sql) ? "2026-10-01T00:00:00Z" : /status"? = \$|LIKE \$/.test(sql) ? "paid" : "1");

const every: Array<{ tool: string; sql: string }> = [
  ...PSQL.map((sql) => ({ tool: "psql", sql })),
  ...TOOLS.flatMap((t) => t.statements.map((sql) => ({ tool: t.tool, sql }))),
];

/** what a tool sends that is refused and has no rewrite for yet (docs/SQL-SUPPORT.md) */
// (Superset's TO_TIMESTAMP(text, 'YYYY-MM-DD HH24:MI:SS.US') was one until the rewrite made it strptime)
const KNOWN_GAPS: Array<{ tool: string; sends: RegExp; code: string; why: string }> = [];

test("every statement a tool was recorded sending is answered by the catalog or by DuckDB", async () => {
  assert.ok(every.length > 100, "the corpus is short");
  const refused: string[] = [];
  for (const { tool, sql } of every) {
    const verdict = await client.query(await filled(sql), valuesFor(sql)).then(() => null, (e: pg.DatabaseError) => `${e.code} ${e.message}`);
    const gap = KNOWN_GAPS.find((g) => g.tool === tool && g.sends.test(sql));
    if (gap) { assert.equal(verdict?.slice(0, 5), gap.code, `a known gap is answered now — remove it from KNOWN_GAPS:\n${sql}`); continue; }
    if (verdict !== null) refused.push(`${tool}: ${verdict}\n  ${sql.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  assert.deepEqual(refused, [], "a tool sends this and the listener refuses it");
});

// ONE PLACE PER NODE (src/duck/rewrite.ts `nodesPlacedTwice`): over every statement of the corpus above
test("no rewrite of the corpus placed one of its nodes twice", async () => {
  const rewrite = await import("../src/duck/rewrite.ts") as { nodesPlacedTwice?: () => readonly string[] };
  assert.ok(rewrite.nodesPlacedTwice !== undefined, "the rewrite has no detector of a node placed twice");
  assert.deepEqual(rewrite.nodesPlacedTwice(), [], "a rule placed a node in two places: clone it per use (Rewriter.cp)");
});

// WHAT A STATEMENT CALLS IS ITS PLAN'S (a review finding): the executor cancels a statement that calls a Mason
// function through its session and interrupts one that calls none, by the plan's `functions` (read off the rewritten
// tree, src/duck/rewrite.ts masonCalls) — never by a match on the text, which also met a stored path's column and the
// view of a copy's visible columns. Over every statement the tools send, the list is exactly the calls in the text
// DuckDB runs, so neither a call the tree walk missed nor a name that is no call can classify a statement.
test("every planned statement says the Mason functions it calls: exactly the calls in the text DuckDB runs", () => {
  assert.ok(planned.length > 20, `the corpus planned ${planned.length} statement(s) for DuckDB: run after the test above`);
  const wrong = planned.filter((p) => JSON.stringify(p.functions) !== JSON.stringify([...new Set(p.text.match(/\b__mason_[a-z0-9_]+(?=\()/g) ?? [])].sort()))
    .map((p) => `${JSON.stringify(p.functions)}: ${p.text.slice(0, 300)}`);
  assert.deepEqual(wrong, []);
  assert.ok(planned.some((p) => (p.functions?.length ?? 0) > 0) && planned.some((p) => p.functions?.length === 0), "the corpus has statements that call Mason functions and statements that call none");
});
