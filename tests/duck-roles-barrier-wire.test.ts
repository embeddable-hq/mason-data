/**
 * THE SECURITY BARRIER OF A ROLE'S ROW FILTER (src/duck/row-filter.ts BARRIER; docs/POSTGRES-API.md "Rows per user"): a
 * statement's own expression never runs on a row the filter hides, for a scalar `where:`, a list and a `through:`, in every
 * place an expression can sit. Without it the engine pushes the statement's condition under the filter, and an expression
 * that raises answers "does a hidden row satisfy P?" for any P.
 *
 * THE DATA IS THE PROOF: 40,000 orders with ids spread over 2 M, half of them each tenant's. The engine's dynamic join
 * filter prunes hidden rows by itself below 50 build keys or over a narrow key range, which hides the leak: a test of a
 * few rows passes with no barrier at all. Tenant 3's rows (hidden from tenant 1) hold the value the expression raises on,
 * every hundredth; every visible row holds 1 (`RAISES`). What it must hold:
 *   - every statement below answers, as Postgres under the same policy answers it: WHERE, JOIN ON, the SELECT list, GROUP
 *     BY, HAVING, ORDER BY, a window, a subquery's own WHERE, a derived table's column filtered outside it, a view, a
 *     correlated subquery, a LATERAL, and a statement reading two filtered tables;
 *   - the same expression on a VISIBLE row still raises (22012): the barrier hides rows, never errors;
 *   - the engine's plan of what is sent holds the statement's expression ABOVE the role's filter and in no scan's own
 *     filters (a filtered user's EXPLAIN shows no plan, so the test asks the engine);
 *   - a statement that cannot raise answers, with the rows a filter keeps.
 * The filter's modules are imported inside the tests, so a tree without them fails each test by name.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import { planNodes, type PlanNode } from "../src/duck/explain.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-roles-barrier-"));
const FILE = "mason/roles.yml";
const ROLES = `roles:
  scalar:
    attributes: [tenant]
    tables:
      orders: { where: "tenant_id = :tenant" }
      order_items: { through: orders }
      labels: {}
  list:
    attributes: { tenants: list }
    tables:
      orders: { where: "tenant_id = ANY(:tenants)" }
      order_items: { through: orders }
      labels: {}
`;
const schema: PgSchema = {
  database: "shop",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "tenant_id", type: "int4" }, { name: "marker", type: "int4" }] },
    { name: "order_items", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "order_id", type: "int8" }, { name: "qty", type: "int4" }] },
    // no filter: a read of it beside a filtered read is what a row number could be taken of
    { name: "labels", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "label", type: "text" }] },
  ],
  views: [{ schema: "public", name: "marked", definition: " SELECT id, marker FROM public.orders;" }],
};
const copied = [
  { source: "public.orders", columns: [{ name: "id" }, { name: "tenant_id" }, { name: "marker" }], key: ["id"], foreignKeys: [] },
  { source: "public.order_items", columns: [{ name: "id" }, { name: "order_id" }, { name: "qty" }], key: ["id"], foreignKeys: [{ column: "order_id", target: "public.orders", targetColumn: "id" }] },
  { source: "public.labels", columns: [{ name: "id" }, { name: "label" }], key: ["id"], foreignKeys: [] },
];
/** raises on the value hidden rows hold, every hundredth of them; 1 on every visible row */
const RAISES = (c: string): string => `1/(CASE WHEN ${c} = 99 THEN 0 ELSE 1 END)`;
const VISIBLE = 20_000;

let store: DuckStore;
let api: PgApiServer;
const clients: pg.Client[] = [];
const logged: string[] = [];
const users: Record<string, { role: string; attributes: Record<string, string | string[]> }> = {
  scalar: { role: "scalar", attributes: { tenant: "1" } },
  list: { role: "list", attributes: { tenants: ["1", "2"] } },
};
before(async () => {
  const r = await import("../src/cli/roles.ts");
  const file = r.parseRolesText(ROLES, FILE);
  assert.ok(!("problems" in file), JSON.stringify(file));
  const grants = r.resolveRoles(file, copied, dir);
  assert.ok(!("message" in grants), JSON.stringify(grants));
  // one object until it changes: the listener checks the filters of each new one
  const live = { file: FILE, grants, problem: null, default: null };
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => { logged.push(l); });
  const w = store.writer;
  // an even id is tenant 3's, an odd one tenant 1's, over 2 M of keys
  await w.run("CREATE TABLE public.orders AS SELECT (i * 50 + (i % 2))::BIGINT AS id, (CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END)::INTEGER AS tenant_id, (CASE WHEN i % 200 = 0 THEN 99 ELSE 1 END)::INTEGER AS marker FROM range(40000) t(i)");
  await w.run("CREATE TABLE public.order_items AS SELECT (100000 + i)::BIGINT AS id, (i * 50 + (i % 2))::BIGINT AS order_id, (CASE WHEN i % 200 = 0 THEN 99 ELSE 1 END)::INTEGER AS qty FROM range(40000) t(i)");
  await w.run("CREATE TABLE public.labels AS SELECT i::INTEGER AS id, 'l' || i AS label FROM range(10) t(i)");
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: (_p, user) => { const u = users[user]; return u === undefined ? {} : { user, ...u }; },
    roles: () => live,
    schema: () => schema, record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined),
  });
  for (const user of Object.keys(users)) {
    const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "shop", user, password: "x" });
    await c.connect();
    clients.push(c);
  }
});
after(async () => {
  for (const c of clients) await c.end().catch((e: Error) => console.error(`a client's end: ${e.message}`));
  await api.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const client = (user: string): pg.Client => clients[Object.keys(users).indexOf(user)]!;
const rows = async (user: string, sql: string): Promise<string[][]> =>
  (await client(user).query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows as string[][];
const one = async (user: string, sql: string): Promise<string> => (await rows(user, sql))[0]!.join(":");

/** the reviewer's two statements and every place an expression can sit; `tag` keeps a run's statements its own */
async function reviewersStatements(tag = ""): Promise<void> {
  for (const user of ["scalar", "list"]) {
    assert.equal(await one(user, `SELECT count(*) FROM order_items WHERE ${RAISES("qty")} > 0${tag}`), String(VISIBLE), `${user}: qty 99 is on hidden rows alone`);
    assert.equal(await one(user, `SELECT count(*) FROM order_items WHERE id >= 100000 AND 1/(order_id % 2) > 0${tag}`), String(VISIBLE), `${user}: an even order_id is a hidden row's`);
    assert.equal(await one(user, "SELECT count(*) FROM order_items WHERE 1/(CASE WHEN qty = 98 THEN 0 ELSE 1 END) > 0"), String(VISIBLE), `${user}: the control`);
  }
}
test("the reviewer's two statements: a condition that raises on a hidden row answers, through: a SEMI join (a list and a scalar); the control alike", () => reviewersStatements());

async function everyPlace(tag = ""): Promise<void> {
  const R = RAISES("marker"), Q = RAISES("qty");
  const n = String(VISIBLE);
  for (const user of ["scalar", "list"]) {
    const cases: Array<[string, string, string]> = [
      ["WHERE", `SELECT count(*) FROM orders WHERE ${R} > 0`, n],
      ["WHERE beside a condition", `SELECT count(*) FROM orders WHERE id > 0 AND ${R} = 1`, n],
      ["WHERE, OR", `SELECT count(*) FROM orders WHERE ${R} = 0 OR id >= 0`, n],
      ["the SELECT list", `SELECT sum(${R}) FROM orders`, n],
      ["an aggregate's FILTER", `SELECT count(*) FILTER (WHERE ${R} > 0) FROM orders`, n],
      ["GROUP BY", `SELECT count(*) FROM (SELECT ${R} AS g, count(*) FROM orders GROUP BY 1) s`, "1"],
      ["HAVING", `SELECT count(*) FROM (SELECT tenant_id FROM orders GROUP BY tenant_id HAVING min(${R}) > 0) s`, "1"],
      ["ORDER BY", `SELECT count(*) FROM (SELECT id FROM orders ORDER BY ${R}, id LIMIT 5) s`, "5"],
      ["a window", `SELECT max(w) FROM (SELECT sum(${R}) OVER () AS w FROM orders) s`, n],
      ["a derived table's column, filtered outside it", `SELECT count(*) FROM (SELECT id, ${R} AS x FROM orders) s WHERE x > 0`, n],
      ["a CTE's column, filtered outside it", `WITH s AS (SELECT id, ${R} AS x FROM orders) SELECT count(*) FROM s WHERE x > 0`, n],
      ["IN a subquery", `SELECT count(*) FROM orders WHERE id IN (SELECT id FROM orders WHERE ${R} > 0)`, n],
      ["a scalar subquery's WHERE", `SELECT (SELECT count(*) FROM orders WHERE ${R} > 0)`, n],
      ["a view", `SELECT count(*) FROM marked WHERE ${R} > 0`, n],
      ["a correlated subquery", `SELECT count(*) FROM orders o WHERE EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND ${Q} > 0)`, n],
      ["a LATERAL", `SELECT count(*) FROM orders o CROSS JOIN LATERAL (SELECT ${R} AS x) l WHERE l.x > 0`, n],
      ["JOIN ON", `SELECT count(*) FROM orders o JOIN order_items i ON i.order_id = o.id AND ${Q} > 0`, n],
      ["LEFT JOIN ON", `SELECT count(*) FROM orders o LEFT JOIN order_items i ON i.order_id = o.id AND ${Q} > 0 WHERE i.id IS NOT NULL`, n],
      ["two filtered tables", `SELECT count(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE ${R} > 0 AND ${Q} > 0`, n],
      ["a table read twice", `SELECT count(*) FROM orders a JOIN orders b ON a.id = b.id WHERE ${RAISES("a.marker")} > 0 AND ${RAISES("b.marker")} > 0`, n],
      ["a table read twice, one side's expression", `SELECT count(*) FROM orders a, orders b WHERE a.id = b.id AND ${RAISES("b.marker")} > 0`, n],
      ["UNION ALL branches", `SELECT count(*) FROM (SELECT id FROM orders WHERE ${R} > 0 UNION ALL SELECT id FROM order_items WHERE ${Q} > 0) u`, String(2 * VISIBLE)],
    ];
    for (const [name, sql, want] of cases) assert.equal(await one(user, `${sql}${tag}`), want, `${user}: ${name}`);
  }
}
test("a scalar where:, a list and through: hold in every place an expression can sit", () => everyPlace());

test("the barrier hides rows, never errors: the same expression raises on a visible row, and a statement that cannot raise answers", async () => {
  await assert.rejects(client("scalar").query("SELECT count(*) FROM orders WHERE 1/(id % 2 - 1) > 0"), (e: pg.DatabaseError) => e.code === "22012", "every visible id is odd");
  assert.equal(await one("scalar", "SELECT count(*), min(id), max(id) FROM orders WHERE id BETWEEN 51 AND 2000"), "20:51:1951");
  assert.equal(await one("scalar", "SELECT count(*), sum(marker) FROM orders"), `${VISIBLE}:${VISIBLE}`);
  assert.equal(await one("scalar", "SELECT count(*) FROM order_items WHERE qty = 99"), "0");
  assert.deepEqual(await rows("scalar", "SELECT id FROM orders ORDER BY id LIMIT 2"), [["51"], ["151"]]);
});

/** where the engine runs the statement's expression, read from its plan of what is sent: never "a Limit is there", which
 *  statistics propagation drops once it has stopped the pushdown */
async function expressionAboveTheFilter(wall: boolean): Promise<void> {
  const { STATISTICS_WALL } = await import("../src/duck/row-filter.ts");
  // a filtered user reads no plan (EXPLAIN says what is sent, and no more), so the engine is asked directly
  const sentOf = async (user: string, sql: string): Promise<string> => {
    const line = (await rows(user, `EXPLAIN ${sql}`)).map((r) => r[0]!).find((l) => l.includes("Sent to the engine: "));
    assert.ok(line !== undefined, `${sql}: what is sent is said`);
    return line.slice(line.indexOf("Sent to the engine: ") + "Sent to the engine: ".length);
  };
  const planOf = async (sent: string): Promise<string[]> => {
    const out = await store.writer.runAndReadAll(`EXPLAIN (FORMAT JSON) ${sent}`);
    const lines: string[] = [];
    const walk = (n: PlanNode): void => { lines.push(`${n.type} ${Object.entries(n.extra).map(([k, v]) => `${k}: ${String(v)}`).join("; ")}`); n.children.forEach(walk); };
    planNodes(JSON.parse(String(out.getRowsJS()[0]?.[1] ?? "[]"))).forEach(walk);
    return lines;
  };
  // the limit itself may be gone from the plan: statistics propagation drops it once it has stopped the filter pushdown,
  // which runs first, so what is held is what the limit is for — where the statement's expression runs
  for (const [user, sql, role] of [
    ["scalar", `SELECT count(*) FROM order_items WHERE ${RAISES("qty")} > 0`, /SEMI/i],
    ["list", `SELECT count(*) FROM order_items WHERE ${RAISES("qty")} > 0`, /SEMI/i],
    ["scalar", `SELECT count(*) FROM orders WHERE ${RAISES("marker")} > 0`, /Filters: .*tenant_id/],
    ["list", `SELECT count(*) FROM orders WHERE ${RAISES("marker")} > 0`, /tenant_id/],
  ] as const) {
    const sent = await sentOf(user, sql);
    assert.equal(sent.includes(STATISTICS_WALL), wall, `the wall in what is sent: ${sent}`);
    const plan = await planOf(sent);
    const own = plan.findIndex((l) => /CASE/.test(l));
    const filter = plan.findIndex((l, i) => i > own && role.test(l));
    assert.ok(own >= 0 && filter > own, `the statement's expression above the role's filter:\n${plan.join("\n")}`);
    assert.deepEqual(plan.filter((l) => /TABLE_SCAN.*Filters: .*CASE/i.test(l)), [], `the statement's expression in no scan:\n${plan.join("\n")}`);
  }
}
test("the engine's plan of what is sent: the statement's expression is above the role's filter and in no scan's own filters, the wall in the text", () => expressionAboveTheFilter(true));

// ISSUE 134: a role's filtered read is no plain read (a barrier and a statistics wall stand in it, and fetching its rows
// again needs a review of its own, step 4), and a statement holding one keeps its form: src/duck/late.ts `tablesOnly`
test("a filtered role's statement does not change form: no row number of a filtered read, a derived read beside it, a wrapper or a WITH query", async () => {
  const reads = ["SELECT o.id, d.qty FROM orders o JOIN (SELECT order_id, qty, 1 AS one FROM order_items) d ON d.order_id = o.id ORDER BY o.id LIMIT 3",
    "SELECT o.id, d.qty FROM orders o JOIN (SELECT order_id, qty FROM order_items) d ON d.order_id = o.id LIMIT 3",
    "SELECT * FROM (SELECT o.id, i.qty FROM orders o JOIN order_items i ON i.order_id = o.id) t ORDER BY id LIMIT 3",
    "WITH w AS (SELECT order_id, qty FROM order_items) SELECT o.id, w.qty FROM orders o JOIN w ON w.order_id = o.id ORDER BY o.id LIMIT 3",
    "WITH j AS (SELECT o.id, i.qty FROM orders o JOIN order_items i ON i.order_id = o.id) SELECT * FROM j LIMIT 3",
    "SELECT m.id, i.qty FROM marked m JOIN order_items i ON i.order_id = m.id ORDER BY m.id LIMIT 3",
    "SELECT o.id, s.n FROM orders o JOIN (SELECT order_id, count(*) AS n FROM order_items GROUP BY order_id) s ON s.order_id = o.id ORDER BY o.id LIMIT 3",
    // beside a table it filters nothing of: anything but `tablesOnly` would carry the filtered read and fetch the table
    "SELECT l.label, o.id FROM labels l JOIN orders o ON o.tenant_id = l.id ORDER BY o.id LIMIT 3",
    "SELECT l.label, o.id FROM labels l JOIN orders o ON o.tenant_id = l.id LIMIT 3",
    "SELECT * FROM (SELECT l.label, o.id FROM labels l JOIN orders o ON o.tenant_id = l.id) t ORDER BY id LIMIT 3",
    "SELECT l.label, d.id FROM labels l JOIN (SELECT id, tenant_id FROM orders) d ON d.tenant_id = l.id ORDER BY d.id LIMIT 3",
    "WITH w AS (SELECT id, label FROM labels) SELECT w.label, o.id FROM orders o JOIN w ON w.id = o.tenant_id ORDER BY o.id LIMIT 3",
    // issue 134, step 3: a computed key by each spelling, a number beside a `*`, USING and NATURAL
    "SELECT l.label, o.id, o.id * 2 AS twice FROM labels l JOIN orders o ON o.tenant_id = l.id ORDER BY twice LIMIT 3",
    "SELECT l.label, o.id, o.id * 2 AS twice FROM labels l JOIN orders o ON o.tenant_id = l.id ORDER BY 3 DESC LIMIT 3",
    "SELECT *, o.id * 2 AS twice FROM labels l JOIN orders o ON o.tenant_id = l.id ORDER BY twice, 1 LIMIT 3",
    "SELECT o.id, i.qty FROM orders o JOIN (SELECT order_id AS id, qty FROM order_items) i USING (id) ORDER BY id LIMIT 3",
    "SELECT o.id, i.qty FROM orders o NATURAL JOIN (SELECT order_id AS id, qty FROM order_items) i ORDER BY id LIMIT 3"];
  for (const user of ["scalar", "list"]) {
    for (const sql of reads) {
      logged.length = 0;
      assert.equal((await rows(user, sql)).length, 3, sql);
      const line = logged.findLast((l) => l.startsWith("statement: "));
      assert.ok(line !== undefined, sql);
      assert.match(line, /try\(COLUMNS\(\*\)\)/, `${sql}: the wall in place`);
      assert.doesNotMatch(line, /__mason_r(id|\d)|__mason_c\d/, sql);
    }
  }
});

/**
 * THE LIMIT'S DETECTOR. `try` also stops the pushdown, as an observation of this engine, so with it on nothing here can
 * tell whether the LIMIT holds anything (with `BARRIER` empty every other test of this file passes). Off, the LIMIT is all
 * that stands between the statement and the hidden rows: every shape must still answer, and its guarantee is the engine's
 * own semantics, since a filter pushed through a LIMIT would change what it keeps. `try`'s detector for the statistics is
 * tests/duck-roles-rows-wire.test.ts.
 */
test("the LIMIT alone holds every shape, the try wall off by its test-only switch", async () => {
  const { wallSwitch } = await import("../src/duck/row-filter.ts");
  wallSwitch.statistics = false;
  try {
    const tag = " /* the limit alone */";
    await reviewersStatements(tag);
    await everyPlace(tag);
    await expressionAboveTheFilter(false);
  } finally { wallSwitch.statistics = true; }
});
