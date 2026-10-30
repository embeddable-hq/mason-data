/**
 * A ROLE'S ROW FILTERS AGAINST A REAL LISTENER (GitHub issue 30, stage 2: src/duck/row-filter.ts, src/cli/roles.ts,
 * src/api/postgres/server.ts; docs/POSTGRES-API.md "Roles"): a Postgres listener over a throwaway DuckStore holding a
 * small shop (customers, orders, order_items with their foreign keys, products unfiltered), its `mason/roles.yml` read as
 * `mason start` reads it (`LiveRoles`), users of `.mason/users.json` with a role and attribute values, wired as the run
 * wires them (`listenerLogins`). Its own file beside tests/duck-roles-wire.test.ts: a listener reads ONE roles file,
 * and these shapes need a shop with tenants and foreign keys. What it must hold, each over the wire with a `pg` client:
 *   - NO PATH REACHES THE COPY WITHOUT THE FILTER: a filtered table read by `SELECT *`, `count(*)`, through a view defined
 *     over it, in a join with its `through:` child, a subquery, EXISTS, a UNION branch, a CTE, and a prepared statement
 *     executed twice with different parameters answers only the user's rows; `through:` two levels deep and a list
 *     attribute (`= ANY(:regions)`, uuids) alike; a predicate on a column the role may not read filters, the column
 *     still refused when selected; EXPLAIN says the filter on each table it reads, in words;
 *   - A USER WITHOUT A VALUE ITS ROLE READS IS REFUSED LOUDLY: 42501, the attribute and the where: in the DETAIL, the
 *     exact commands in the HINT — never answered with no rows; a user of an unfiltered role, and a token, read every row;
 *   - A WHERE: POSTGRES CANNOT READ is the roles' problem at its key, Postgres's own message, every statement of a user
 *     held to a role refused 57P03 until it is fixed; a `through:` with no foreign key, or two, is refused at its key
 *     with the explicit form `through: { orders: <column> }` as the way out, and the explicit form answers;
 *   - the session cannot SET its attributes; SHOW answers them; SET ROLE is unchanged; a whole row of a filtered table
 *     is refused by name (Mason gap roles); the catalog holds the filters as Postgres row security (pg_policies);
 *   - every statement's request-log row carries the user's attributes beside its role.
 * The roles modules are imported inside the tests, so a tree without them fails each test by name (scripts/fails-without.ts).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import { changeUsers, keyFingerprint, newUserId, userPassword } from "../src/duck/users.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-roles-rows-wire-"));
const root = path.join(dir, "project");
const home = path.join(root, ".mason");
const folder = path.join(root, "mason");
const usersFile = path.join(home, "users.json");
const rolesFile = path.join(folder, "roles.yml");
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;
let logged: string[] = [];

const EU = "11111111-1111-4111-8111-111111111111", US = "22222222-2222-4222-8222-222222222222", APAC = "33333333-3333-4333-8333-333333333333";
const schema: PgSchema = {
  database: "shop",
  tables: [
    { name: "customers", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "tenant_id", type: "int4" }, { name: "region", type: "uuid" }, { name: "name", type: "text" }] },
    { name: "orders", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int8" }, { name: "tenant_id", type: "int4" }, { name: "customer_id", type: "int8" }, { name: "status", type: "text" }, { name: "amount", type: "int8" }, { name: "notes", type: "text" }] },
    { name: "order_items", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "order_id", type: "int8" }, { name: "product", type: "text" }, { name: "qty", type: "int4" }] },
    // two foreign keys to orders: a through: must name the one
    { name: "refunds", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "order_id", type: "int8" }, { name: "replaces_order_id", type: "int8" }] },
    { name: "products", primaryKey: ["sku"], joins: [], columns: [{ name: "sku", type: "text" }, { name: "label", type: "text" }] },
  ],
  views: [{ schema: "public", name: "order_status", definition: " SELECT id, status FROM public.orders;" },
    { schema: "public", name: "order_lines", definition: " SELECT o.id, o.status, i.product, i.qty FROM public.orders o JOIN public.order_items i ON i.order_id = o.id;" }],
};
/** the copied tables as the run hands them to LiveRoles: the copy's columns, the source's keys and foreign keys */
const FKS: Record<string, Array<{ column: string; target: string; targetColumn: string }>> = {
  "public.orders": [{ column: "customer_id", target: "public.customers", targetColumn: "id" }],
  "public.order_items": [{ column: "order_id", target: "public.orders", targetColumn: "id" }],
  "public.refunds": [{ column: "order_id", target: "public.orders", targetColumn: "id" }, { column: "replaces_order_id", target: "public.orders", targetColumn: "id" }],
};
const copied = schema.tables.map((t) => ({ source: `public.${t.name}`, columns: t.columns.map((c) => ({ name: c.name })), key: t.primaryKey, foreignKeys: FKS[`public.${t.name}`] ?? [] }));

const ROLES = `default: everything
roles:
  everything:
    tables: all
  # a tenant's rows: orders by its own column (one the role may not read), items through their order
  tenant:
    attributes: [tenant]
    tables:
      customers: { where: "tenant_id = :tenant" }
      orders: { columns: [id, customer_id, status, amount], where: "tenant_id = :tenant" }
      order_items: { through: orders }
      products: {}
  # several regions (a list of uuids): customers by region, their orders and the orders' items two levels down
  regions:
    attributes: { regions: list }
    tables:
      customers: { where: "region = ANY(:regions)" }
      orders: { through: customers }
      order_items: { through: orders }
`;

let wired: (Pick<PgApiOptions, "authenticate" | "recheck" | "recheckMs"> & { roles: () => unknown }) | null = null;
async function wire(): Promise<void> {
  if (wired !== null) return;
  const u = await import("../src/duck/users.ts");
  const r = await import("../src/cli/roles.ts");
  const live = new r.LiveRoles(folder, root, () => copied as never);
  wired = { ...u.listenerLogins(new u.LiveUsers(usersFile, API_KEY), API_KEY), roles: () => live.now() };
}

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.writeFileSync(rolesFile, ROLES);
  store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  const w = store.writer;
  await w.run("CREATE TABLE public.customers (id BIGINT, tenant_id INTEGER, region UUID, name VARCHAR)");
  await w.run(`INSERT INTO public.customers VALUES (1, 1, '${EU}', 'Ann'), (2, 1, '${US}', 'Bo'), (3, 2, '${EU}', 'Cy'), (4, 2, '${APAC}', 'Di'), (5, 3, '${APAC}', 'Ed')`);
  await w.run("CREATE TABLE public.orders (id BIGINT, tenant_id INTEGER, customer_id BIGINT, status VARCHAR, amount BIGINT, notes VARCHAR)");
  // order 13 is tenant 1's, its customer tenant 2's: a LEFT JOIN to customers shows its customer hidden (NULL)
  await w.run(`INSERT INTO public.orders VALUES (10, 1, 1, 'paid', 100, 'a'), (11, 1, 2, 'pending', 50, NULL), (12, 2, 3, 'paid', 70, 'b'), (13, 1, 3, 'paid', 30, 'c'),
    (14, 2, 4, 'refunded', 20, NULL), (15, 3, 5, 'paid', 999, 'z'), (16, 1, NULL, 'paid', 5, NULL)`);
  await w.run("CREATE TABLE public.order_items (id BIGINT, order_id BIGINT, product VARCHAR, qty INTEGER)");
  await w.run(`INSERT INTO public.order_items VALUES (100, 10, 'widget', 1), (101, 10, 'gadget', 2), (102, 11, 'widget', 3), (103, 12, 'widget', 4), (104, 14, 'gizmo', 5),
    (105, 15, 'widget', 6), (106, NULL, 'loose', 7), (107, 13, 'gadget', 8)`);
  await w.run("CREATE TABLE public.refunds (id BIGINT, order_id BIGINT, replaces_order_id BIGINT)");
  await w.run("INSERT INTO public.refunds VALUES (1, 10, 12), (2, 12, 10)");
  await w.run("CREATE TABLE public.products (sku VARCHAR, label VARCHAR)");
  await w.run("INSERT INTO public.products VALUES ('widget', 'Widget'), ('gadget', 'Gadget'), ('gizmo', 'Gizmo')");
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000 });
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: (password, user) => { if (wired === null) throw new Error("not wired"); return wired.authenticate(password, user); },
    recheck: (t) => { if (wired?.recheck === undefined) throw new Error("not wired"); return wired.recheck(t); },
    recheckMs: 0,
    roles: () => (wired === null ? { file: null, grants: new Map(), problem: null, default: null } : wired.roles()) as never,
    schema: () => schema,
    record: (row) => ledger.record(row), log: (l) => { logged.push(l); },
    duck: await store.listener(undefined),
  });
});
const clients: pg.Client[] = [];
after(async () => {
  // the clients first: a listener closed under them ends their connections, which pg reports after the test
  for (const c of clients) await c.end().catch((e: Error) => console.error(`a client's end: ${e.message}`));
  await api.close();
  await ledger.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** a user of `.mason/users.json` with a role and attribute values; its password */
function addUser(name: string, role?: string, attributes?: Record<string, string | string[]>): string {
  const id = newUserId();
  changeUsers(usersFile, (users) => [...users.filter((u) => u.name !== name), { name, id, addedAt: new Date().toISOString(), key: keyFingerprint(API_KEY),
    ...(role !== undefined ? { role } : {}), ...(attributes !== undefined ? { attributes } : {}) }]);
  return userPassword(API_KEY, name, id);
}
async function connect(user: string, password: string): Promise<pg.Client> {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "shop", user, password });
  await c.connect();
  clients.push(c);
  return c;
}
const rows = async (c: pg.Client, sql: string, values?: unknown[]): Promise<string[][]> =>
  (await c.query({ text: sql, values, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig)).rows as string[][];
async function refusal(c: pg.Client, sql: string): Promise<{ code: string; message: string; detail?: string; hint?: string }> {
  try { await c.query(sql); } catch (e) { const d = e as pg.DatabaseError; return { code: d.code ?? "", message: d.message, ...(d.detail ? { detail: d.detail } : {}), ...(d.hint ? { hint: d.hint } : {}) }; }
  assert.fail(`answered where a refusal was expected: ${sql}`);
}

test("no path reaches the copy without the filter: *, count, a view, joins, subqueries, EXISTS, UNION, a CTE, a prepared statement executed twice", async () => {
  await wire();
  const acme = await connect("acme", addUser("acme", "tenant", { tenant: "1" }));
  const ids = async (sql: string, values?: unknown[]): Promise<string> => (await rows(acme, sql, values)).map((r) => r.join(":")).join(",");
  assert.equal(await ids("SELECT * FROM customers ORDER BY id"), `1:1:${EU}:Ann,2:1:${US}:Bo`);
  assert.equal(await ids("SELECT count(*) FROM orders"), "4");
  assert.equal(await ids("SELECT count(*), sum(amount), count(DISTINCT status) FROM orders"), "4:185:2");
  assert.equal(await ids("SELECT id, status FROM order_status ORDER BY id"), "10:paid,11:pending,13:paid,16:paid", "a view defined over the filtered table");
  assert.equal(await ids("SELECT id, product FROM order_lines ORDER BY id, product"), "10:gadget,10:widget,11:widget,13:gadget", "a view over a join of it");
  assert.equal(await ids("SELECT o.id, i.product FROM orders o JOIN order_items i ON i.order_id = o.id ORDER BY 1, 2"), "10:gadget,10:widget,11:widget,13:gadget");
  assert.equal(await ids("SELECT count(*) FROM order_items"), "4", "through: orders, so no item of another tenant's order and none with no order");
  assert.equal(await ids("SELECT i.product, p.label FROM order_items i JOIN products p ON p.sku = i.product ORDER BY i.id"), "widget:Widget,gadget:Gadget,widget:Widget,gadget:Gadget", "with an unfiltered table");
  assert.equal(await ids("SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id"), "10:Ann,11:Bo,13:,16:", "the customer of order 13 is another tenant's: hidden");
  assert.equal(await ids("SELECT id FROM (SELECT id, amount FROM orders WHERE amount > 20) s ORDER BY id"), "10,11,13");
  assert.equal(await ids("SELECT id FROM customers WHERE id IN (SELECT customer_id FROM orders) ORDER BY id"), "1,2");
  assert.equal(await ids("SELECT id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY id"), "1,2");
  assert.equal(await ids("SELECT id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY id"), "");
  assert.equal(await ids("SELECT (SELECT max(amount) FROM orders) AS m"), "100");
  assert.equal(await ids("WITH o AS (SELECT id FROM orders) SELECT count(*) FROM o"), "4");
  assert.equal(await ids("SELECT id FROM orders UNION ALL SELECT id FROM customers ORDER BY 1"), "1,2,10,11,13,16");
  assert.equal(await ids("SELECT id, row_number() OVER (ORDER BY amount DESC) FROM orders ORDER BY id"), "10:1,11:2,13:3,16:4");
  assert.equal(await ids("SELECT o.id, x.n FROM orders o CROSS JOIN LATERAL (SELECT count(*) AS n FROM order_items i WHERE i.order_id = o.id) x ORDER BY o.id"), "10:2,11:1,13:1,16:0");
  // a prepared statement, executed twice with other parameters: each Execute reads the filtered copy
  for (const [status, want] of [["paid", "10,13,16"], ["refunded", ""]] as const) {
    const r = await acme.query({ name: "by_status", text: "SELECT id FROM orders WHERE status = $1 ORDER BY id", values: [status], rowMode: "array" });
    assert.equal(r.rows.map((x) => x.join(":")).join(","), want, `the prepared statement with ${status}`);
  }
  // the predicate reads tenant_id, which the role may not read: the row is filtered, the column still refused
  const hidden = await refusal(acme, "SELECT id, tenant_id FROM orders");
  assert.equal(hidden.code, "42501");
  assert.equal(hidden.message, "permission denied for table orders");
  // the other tenant, the same statements: its own rows
  const globex = await connect("globex", addUser("globex", "tenant", { tenant: "2" }));
  assert.equal((await rows(globex, "SELECT id FROM orders ORDER BY id")).map((r) => r[0]).join(","), "12,14");
  assert.equal((await rows(globex, "SELECT count(*) FROM order_items")).map((r) => r[0]).join(","), "2");
});

test("a list attribute and through: two levels deep: customers by region (uuids), their orders, the orders' items", async () => {
  await wire();
  const emea = await connect("emea", addUser("emea", "regions", { regions: [EU, APAC] }));
  assert.deepEqual((await rows(emea, "SELECT id FROM customers ORDER BY id")).map((r) => r[0]), ["1", "3", "4", "5"]);
  assert.deepEqual((await rows(emea, "SELECT id FROM orders ORDER BY id")).map((r) => r[0]), ["10", "12", "13", "14", "15"]);
  assert.deepEqual((await rows(emea, "SELECT id FROM order_items ORDER BY id")).map((r) => r[0]), ["100", "101", "103", "104", "105", "107"]);
  const one = await connect("eu", addUser("eu", "regions", { regions: [EU] }));
  assert.deepEqual((await rows(one, "SELECT id FROM customers ORDER BY id")).map((r) => r[0]), ["1", "3"], "a one-value list");
  // EXPLAIN says each table's filter, in words: the list, and the through: of each level
  const plan = (await rows(emea, "EXPLAIN SELECT count(*) FROM order_items")).map((r) => r[0]).join("\n");
  assert.match(plan, /filtered by the role regions: region = ANY\('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'\)/);
  assert.match(plan, /filtered by the role regions: a row of orders it references by order_id is visible/);
  assert.match(plan, /filtered by the role regions: a row of customers it references by customer_id is visible/);
  const acme = await connect("acme2", addUser("acme2", "tenant", { tenant: "1" }));
  const tenantPlan = (await rows(acme, "EXPLAIN SELECT id FROM orders")).map((r) => r[0]).join("\n");
  assert.match(tenantPlan, /Mason: answered from its copy of public\.orders \(.*; filtered by the role tenant: tenant_id = 1\)/);
});

test("a user without a value its role reads is refused loudly at every statement; an unfiltered role and a token read every row", async () => {
  await wire();
  const stale = await connect("stale", addUser("stale", "tenant"));
  for (const sql of ["SELECT count(*) FROM orders", "SELECT count(*) FROM products", "SELECT 1"]) {
    const r = await refusal(stale, sql);
    assert.equal(r.code, "42501", sql);
    assert.equal(r.message, 'permission denied: the user "stale" has no value for the attribute tenant, which the role tenant filters rows by');
    assert.equal(r.detail, "roles.tenant.tables.customers.where reads :tenant (tenant_id = :tenant); the user was added without it, and Mason refuses rather than answer no rows");
    assert.equal(r.hint, "mason user remove stale && mason user add stale --role tenant --set tenant=<value>");
  }
  const plain = await connect("plain", addUser("plain", "everything"));
  assert.deepEqual((await rows(plain, "SELECT count(*) FROM orders"))[0], ["7"]);
  const token = mintToken(API_KEY, 600).token;
  const t = await connect("anyone", token);
  assert.deepEqual((await rows(t, "SELECT count(*) FROM order_items"))[0], ["8"]);
});

test("the session cannot SET its attributes; SHOW answers them; SET ROLE is unchanged; a whole row is refused by name; the catalog holds the policies", async () => {
  await wire();
  const acme = await connect("acme3", addUser("acme3", "tenant", { tenant: "1" }));
  const set = await refusal(acme, "SET mason.attr.tenant = '2'");
  assert.equal(set.code, "42501");
  assert.equal(set.message, 'permission denied to set parameter "mason.attr.tenant"');
  assert.deepEqual((await rows(acme, "SHOW mason.attr.tenant"))[0], ["1"]);
  assert.deepEqual((await rows(acme, "SELECT count(*) FROM orders"))[0], ["4"], "still its own rows");
  assert.equal((await refusal(acme, "SET ROLE everything")).code, "42501");
  const whole = await refusal(acme, "SELECT c FROM customers c");
  assert.equal(whole.code, "0A000");
  assert.match(whole.detail ?? "", /Mason gap roles/);
  // the catalog's own row security: the policy as Postgres holds it, for the role, the attribute read as the setting
  const policies = await rows(acme, "SELECT tablename::text, policyname::text, qual FROM pg_policies WHERE policyname = 'mason_tenant' ORDER BY 1");
  // products is filtered by no role: no row security on it, as on Postgres
  assert.deepEqual(policies.map((p) => p[0]), ["customers", "order_items", "orders"]);
  assert.match(policies.find((p) => p[0] === "orders")![2]!, /current_setting\('mason\.attr\.tenant'::text\)\)::integer/);
});

test("every statement's request-log row carries the user's attributes beside its role", async () => {
  await wire();
  const acme = await connect("acme4", addUser("acme4", "tenant", { tenant: "1" }));
  await rows(acme, "SELECT count(*) FROM orders");
  await ledger.flush();
  const got = (await ledger.recent({ limit: 500 })).filter((r) => r.user === "acme4");
  assert.ok(got.length > 0, "acme4's statement is recorded");
  assert.deepEqual(got.map((r) => [r.role, r.attributes]).at(-1), ["tenant", { tenant: "1" }]);
});

test("a where: Postgres cannot read is the roles' problem at its key; through: with no or two foreign keys is refused with the explicit form; the explicit form answers", async () => {
  await wire();
  const acme = await connect("acme5", addUser("acme5", "tenant", { tenant: "1" }));
  const r = await import("../src/cli/roles.ts");
  try {
    fs.writeFileSync(rolesFile, ROLES.replace(`orders: { columns: [id, customer_id, status, amount], where: "tenant_id = :tenant" }`, `orders: { columns: [id, customer_id, status, amount], where: "tenat_id = :tenant" }`));
    const refused = await refusal(acme, "SELECT count(*) FROM orders");
    assert.equal(refused.code, "57P03");
    assert.match(refused.message, /roles\.tenant\.tables\.orders\.where: column "tenat_id" does not exist \(at character 1 of the where:\)/);
    assert.ok(logged.some((l) => l.includes('roles.tenant.tables.orders.where: column "tenat_id" does not exist')), "said in the log once");
    // a list read as a scalar: Postgres's own refusal, with the key
    fs.writeFileSync(rolesFile, ROLES.replace(`region = ANY(:regions)`, `region = :regions`));
    const listed = await refusal(acme, "SELECT count(*) FROM orders");
    assert.match(listed.message, /roles\.regions\.tables\.customers\.where: operator does not exist: uuid = uuid\[\].*:regions is a list, read here as one uuid — write = ANY\(:regions\)/);
    // through: with two foreign keys, and with none: the explicit form as the way out
    const two = r.parseRolesText(`roles:\n  t:\n    attributes: [tenant]\n    tables:\n      orders: { where: "tenant_id = :tenant" }\n      refunds: { through: orders }\n`, rolesFile);
    assert.ok(!("problems" in two));
    assert.deepEqual(r.roleProblems(two, copied), ["roles.t.tables.refunds.through: public.refunds references public.orders by 2 foreign keys (order_id, replaces_order_id) — name the one: through: { orders: order_id } or through: { orders: replaces_order_id }"]);
    const none = r.parseRolesText(`roles:\n  t:\n    attributes: [tenant]\n    tables:\n      orders: { where: "tenant_id = :tenant" }\n      products: { through: orders }\n`, rolesFile);
    assert.ok(!("problems" in none));
    assert.deepEqual(r.roleProblems(none, copied), ["roles.t.tables.products.through: public.products has no foreign key to public.orders (as the database's catalog reports them) — name the column that references it: through: { orders: <a column of products> }"]);
    // the explicit form, over the wire
    fs.writeFileSync(rolesFile, `${ROLES}  refunder:\n    attributes: [tenant]\n    tables:\n      orders: { where: "tenant_id = :tenant" }\n      refunds: { through: { orders: replaces_order_id } }\n`);
    const ref = await connect("ref", addUser("ref", "refunder", { tenant: "1" }));
    assert.deepEqual((await rows(ref, "SELECT id FROM refunds ORDER BY id")).map((x) => x[0]), ["2"], "refund 2 replaces order 10, tenant 1's");
  } finally { fs.writeFileSync(rolesFile, ROLES); }
  assert.deepEqual((await rows(acme, "SELECT count(*) FROM orders"))[0], ["4"], "repaired: answered again, no restart");
});
