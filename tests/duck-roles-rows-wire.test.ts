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
 *   - every statement's request-log row carries the user's attributes beside its role;
 *   - a prepared statement Executed after the roles file's `where:` was edited is planned again under the new filter;
 *   - an EMPTY list counts as a missing value, for an integer list and a uuid list, never as a filter keeping no row;
 *   - a value its type refuses is refused naming the attribute, the user and the way out;
 *   - a filtered user's own subquery named as the wall answers Postgres's rows; a literal spelling the engine's text answers;
 *   - `<> ALL(:list)` through a real where:; every whole-row spelling refused by the gap's name;
 *   - EXPLAIN says no row count for a filtered table, in text or JSON (`Row Filter` there), and one for an unfiltered one;
 *   - EXPLAIN of a statement reading a filtered table says Mason's lines alone, byte-identical whatever the statistics
 *     prove, for where:, a list, through: and a join, in text and JSON; ANALYZE refused by the gap's name, the way out said;
 *   - a table's statistics reach no statement: a condition they would prove false answers the same on either side of a
 *     hidden row's value, an unfiltered user's plan unchanged;
 *   - a catalog that cannot check the filters fails closed, said once a streak, and its recovery said.
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
import { PgCatalog } from "../src/api/postgres/catalog.ts";

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
  # two attributes, each read by one table's filter
  mixed:
    attributes: [tenant, region]
    tables:
      orders: { where: "tenant_id = :tenant" }
      customers: { where: "region = :region" }
  # a list of integers, and <> ALL: every tenant but these
  others:
    attributes: { tenants: list }
    tables:
      customers: { where: "tenant_id <> ALL(:tenants)" }
      orders: { where: "tenant_id = ANY(:tenants)" }
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

test("a share's session reads a filtered role's rows as a plain session of that role does; the listener's refusals reach mason share's start", async () => {
  await wire();
  const { RunShares, shareSecret } = await import("../src/cli/share-run.ts");
  const { selfSignedCertificate } = await import("../src/cli/self-signed-cert.ts");
  const pair = selfSignedCertificate("mason-share-rows");
  const shares = new RunShares({ listener: api, database: "shop", log: () => undefined, certificate: () => ({ cert: Buffer.from(pair.cert), key: Buffer.from(pair.key), fingerprint: "AA" }) });
  // a where: with no attribute, and a through: from it: rows a password alone can be held to
  const paid = `${ROLES}  paid:\n    tables:\n      orders: { columns: [id, status], where: "status = 'paid'" }\n      order_items: { through: orders }\n`;
  fs.writeFileSync(rolesFile, paid);
  const plain = await connect("paid1", addUser("paid1", "paid"));
  const whole = await connect("whole1", addUser("whole1", "everything"));
  const opened = await shares.open({ secret: shareSecret("share-password"), role: "paid" });
  assert.ok("user" in opened, JSON.stringify(opened));
  const share = new pg.Client({ host: "127.0.0.1", port: opened.port, database: "shop", user: opened.user, password: "share-password", ssl: { rejectUnauthorized: false } });
  await share.connect();
  try {
    const statements: Array<[string, unknown[]]> = [
      ["SELECT id FROM orders ORDER BY id", [{ id: "10" }, { id: "12" }, { id: "13" }, { id: "15" }, { id: "16" }]],
      ["SELECT count(*)::int AS n FROM orders", [{ n: 5 }]],
      ["SELECT id FROM order_items ORDER BY id", [{ id: "100" }, { id: "101" }, { id: "103" }, { id: "105" }, { id: "107" }]],
      ["SELECT count(*)::int AS n FROM orders o JOIN order_items i ON i.order_id = o.id", [{ n: 5 }]],
    ];
    for (const [sql, rows] of statements) {
      const seen = (await share.query(sql)).rows;
      assert.deepEqual(seen, rows, sql);
      assert.deepEqual((await plain.query(sql)).rows, seen, `a plain session of the role: ${sql}`);
      assert.notDeepEqual((await whole.query(sql)).rows, seen, `an unfiltered user reads more: ${sql}`);
    }
    assert.equal((await refusal(share, "SELECT notes FROM orders")).code, "42501", "its columns too");
  } finally {
    await share.end();
    await shares.closeAll("the test");
  }

  // a role whose rows need an attribute: refused at the start, never a share whose every statement fails
  const tenant = await shares.open({ secret: shareSecret("x"), role: "tenant" });
  assert.ok("failure" in tenant);
  assert.equal(tenant.failure.code, "refused");
  assert.equal(tenant.failure.message, "a share cannot read as the role tenant: its rows depend on :tenant, and a share's login has no attributes");
  assert.equal(tenant.failure.why, "roles.tenant.tables.customers.where reads :tenant (tenant_id = :tenant)");
  assert.match(tenant.failure.fix ?? "", /^--role paid: reads 2 synced tables/m);
  assert.deepEqual(tenant.failure.next?.at(-1), ["mason user add <name> --role tenant --set tenant=<value>", "a login that carries the values, for a tool that can reach this machine"]);

  // a filter Postgres refuses: the role reads as well-formed until the catalog has read it, so the share asks the catalog
  fs.writeFileSync(rolesFile, paid.replace("status = 'paid'", "stauts = 'paid'"));
  try {
    const bad = await shares.open({ secret: shareSecret("y"), role: "paid" });
    assert.ok("failure" in bad, JSON.stringify(bad));
    assert.equal(bad.failure.code, "bad_roles");
    assert.match(bad.failure.message, /roles\.yml cannot be read as it is now, so nothing is shared: .*roles\.paid\.tables\.orders\.where: column "stauts" does not exist/);
    assert.match(bad.failure.fix ?? "", /^repair .*roles\.yml, then mason share$/);
  } finally { fs.writeFileSync(rolesFile, ROLES); }
});

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
  // a top N over joins: its rows chosen by row number only of a table, and a filtered read is none (src/duck/late.ts)
  assert.equal(await ids("SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 3"), "16:,13:,11:Bo", "the filter under a LIMIT");
  assert.equal(await ids("SELECT i.product, p.label FROM order_items i JOIN products p ON p.sku = i.product ORDER BY i.id DESC LIMIT 1 OFFSET 3"), "widget:Widget", "one filtered, one not");
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
  assert.match(tenantPlan, /Mason: answered from the synced table public\.orders \(.*; filtered by the role tenant: tenant_id = 1\)/);
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

// EVERY WAY A SESSION HAS TO SET A PARAMETER REACHES `applySetting`, set_config directly, so the refusal lives there: in
// `setStatement` alone, `set_config('mason.attr.tenant', '2', true)` would have widened the session's rows for a block.
// A session's transaction holds settings it may undo: an attribute is none of them, and the row filter reads it after each.
test("no SET, SET LOCAL, RESET or set_config moves an attribute, and no transaction's end does", async () => {
  await wire();
  const acme = await connect("acme5", addUser("acme5", "tenant", { tenant: "1" }));
  const unmoved = async (asked: string): Promise<void> => {
    assert.deepEqual((await rows(acme, "SHOW mason.attr.tenant"))[0], ["1"], asked);
    assert.deepEqual((await rows(acme, "SELECT current_setting('mason.attr.tenant'), count(*) FROM orders"))[0], ["1", "4"], `${asked}: still its own rows`);
    assert.deepEqual((await rows(acme, "SELECT current_setting('mason.attr.tenant')"))[0], ["1"], `${asked}: in the catalog too`);
  };
  for (const sql of ["SET mason.attr.tenant = '2'", "SET LOCAL mason.attr.tenant = '2'", "SET SESSION mason.attr.tenant = '2'", "RESET mason.attr.tenant", "SET mason.attr.tenant TO DEFAULT",
    "SET LOCAL mason.attr.tenant TO DEFAULT", "SET MASON.ATTR.tenant = '2'", "SELECT set_config('mason.attr.tenant', '2', false)", "SELECT set_config('mason.attr.tenant', '2', true)",
    "SELECT set_config('MASON.ATTR.tenant', '2', true)", "SET mason.attr.never_given = '2'"]) {
    const r = await refusal(acme, sql);
    assert.deepEqual([r.code, r.message.toLowerCase()], ["42501", `permission denied to set parameter "${/never_given/.test(sql) ? "mason.attr.never_given" : "mason.attr.tenant"}"`], sql);
    await unmoved(sql);
    // in a block it fails the block, and the block's end moves nothing: nothing of it was kept to restore
    await acme.query("BEGIN");
    assert.equal((await refusal(acme, sql)).code, "42501", `${sql} in a block`);
    await acme.query("ROLLBACK");
    await unmoved(`${sql}, then ROLLBACK`);
  }
  // the transaction's other settings come and go around it; RESET ALL touches no attribute, kept or undone
  for (const end of ["COMMIT", "ROLLBACK"]) {
    await acme.query("BEGIN");
    await acme.query("SET LOCAL application_name = 'in-block'");
    await acme.query("RESET ALL");
    await unmoved(`RESET ALL in a block, before its ${end}`);
    await acme.query(end);
    await unmoved(`RESET ALL, ${end}`);
  }
  assert.equal((await acme.query("DISCARD ALL")).command, "DISCARD");
  await unmoved("DISCARD ALL");
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
    // a where: Postgres reads and Mason's rewrite cannot send: the file's problem at its key, never the engine's words at each statement
    for (const [where, said] of [["ctid IS NOT NULL", /which Mason has not verified/], ["tenant_id = :tenant AND ctid IS NOT NULL", /which Mason has not verified/]] as const) {
      fs.writeFileSync(rolesFile, ROLES.replace(`orders: { columns: [id, customer_id, status, amount], where: "tenant_id = :tenant" }`, `orders: { columns: [id, customer_id, status, amount], where: "${where}" }`));
      const sent = await refusal(acme, "SELECT count(*) FROM products");
      assert.equal(sent.code, "57P03", `${where}: ${JSON.stringify(sent)}`);
      assert.match(sent.message, /roles\.tenant\.tables\.orders\.where: /);
      assert.match(sent.message, said);
      assert.match(sent.message, /the predicate is read as SELECT 1 FROM public\.orders WHERE /);
    }
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

test("a prepared statement Executed after its role's where: was edited answers under the new filter: re-planned, never the old plan", async () => {
  await wire();
  const acme = await connect("acme6", addUser("acme6", "tenant", { tenant: "1" }));
  const run = async (): Promise<string> =>
    (await acme.query({ name: "paid_ids", text: "SELECT id FROM orders WHERE status = $1 ORDER BY id", values: ["paid"], rowMode: "array" })).rows.map((x) => x.join(":")).join(",");
  assert.equal(await run(), "10,13,16");
  try {
    fs.writeFileSync(rolesFile, ROLES.replace(`where: "tenant_id = :tenant" }\n      order_items`, `where: "tenant_id = :tenant AND amount > 40" }\n      order_items`));
    assert.equal(await run(), "10", "orders 13 (amount 30) and 16 (amount 5) are no longer the role's: the statement prepared before the edit reads the new filter");
    assert.equal((await rows(acme, "SELECT count(*) FROM order_items")).map((r) => r[0]).join(","), "3", "and its through: child follows (order 13's item is gone)");
  } finally { fs.writeFileSync(rolesFile, ROLES); }
  assert.equal(await run(), "10,13,16", "the edit undone: the old filter again");
});

test("a value its type refuses is refused naming the attribute, the user and the way out, at a statement that reads the filter; a statement's own bad value stays its own", async () => {
  await wire();
  const abc = await connect("typed_abc", addUser("typed_abc", "tenant", { tenant: "abc" }));
  for (const sql of ["SELECT count(*) FROM orders", "EXPLAIN SELECT count(*) FROM orders", "SELECT count(*) FROM order_items"]) {
    const r = await refusal(abc, sql);
    assert.equal(r.code, "42501", `${sql}: ${JSON.stringify(r)}`);
    assert.equal(r.message, 'permission denied: the user "typed_abc" has a value for the attribute tenant that is not of type integer, which the role tenant filters rows by');
    assert.match(r.detail ?? "", /roles\.tenant\.tables\.\w+\.where reads :tenant as integer \(tenant_id = :tenant\): invalid input syntax for type integer: "abc"/);
    assert.equal(r.hint, "mason user remove typed_abc && mason user add typed_abc --role tenant --set tenant=<a value of type integer>");
  }
  assert.deepEqual(await rows(abc, "SELECT count(*) FROM products"), [["3"]], "no filter reads it here");
  // a list, one of its values
  const list = await connect("typed_list", addUser("typed_list", "others", { tenants: ["1", "x"] }));
  const l = await refusal(list, "SELECT count(*) FROM orders");
  assert.equal(l.code, "42501", JSON.stringify(l));
  assert.match(l.message, /has a value for the attribute tenants that is not of type integer\[\]/);
  // a value this statement never binds is no cause of its error: only the filters it reads are asked
  const mixed = await connect("typed_mixed", addUser("typed_mixed", "mixed", { tenant: "1", region: "not-a-uuid" }));
  for (const [sql, code] of [["SELECT regexp_match(status, 'a', 'g') FROM orders", "22023"], ["SELECT count(*) FROM orders WHERE id = 'abc'::int", "22P02"]] as const) {
    const r = await refusal(mixed, sql);
    assert.equal(r.code, code, `${sql}: ${JSON.stringify(r)}`);
    assert.doesNotMatch(r.message, /attribute/, sql);
  }
  assert.match((await refusal(mixed, "SELECT count(*) FROM customers")).message, /the attribute region that is not of type uuid/);
  // a user whose values are good, a statement whose own is not: Postgres's own refusal
  const good = await connect("typed_good", addUser("typed_good", "tenant", { tenant: "1" }));
  const own = await refusal(good, "SELECT count(*) FROM orders WHERE id = 'abc'::int");
  assert.equal(own.code, "22P02");
  assert.equal(own.message, 'invalid input syntax for type integer: "abc"');
});

test("an empty list is a missing value, on an integer list and a uuid list: refused loudly, never a filter keeping no row", async () => {
  await wire();
  const empty: Array<[string, string, string]> = [["none_int", "others", "tenants"], ["none_uuid", "regions", "regions"]];
  for (const [name, role, attr] of empty) {
    const c = await connect(name, addUser(name, role, { [attr]: [] }));
    for (const sql of ["SELECT count(*) FROM customers", "SELECT count(*) FROM orders", "SELECT 1"]) {
      const r = await refusal(c, sql);
      assert.equal(r.code, "42501", `${name}: ${sql}`);
      assert.equal(r.message, `permission denied: the user "${name}" has no value for the attribute ${attr}, which the role ${role} filters rows by`);
      assert.match(r.hint ?? "", new RegExp(`mason user remove ${name} && mason user add ${name} --role ${role} --set ${attr}=<value>`));
    }
  }
});

test("<> ALL(:list) through a real where:: every row but the list's, a NULL-free integer column; = ANY beside it", async () => {
  await wire();
  const c = await connect("others1", addUser("others1", "others", { tenants: ["1", "3"] }));
  assert.deepEqual((await rows(c, "SELECT id FROM customers ORDER BY id")).map((r) => r[0]), ["3", "4"], "customers of no tenant in the list: tenant 2's");
  assert.deepEqual((await rows(c, "SELECT count(*) FROM orders"))[0], ["5"], "orders of the list's tenants: 1's four, 3's one");
  const plan = (await rows(c, "EXPLAIN SELECT id FROM customers")).map((r) => r[0]).join("\n");
  assert.match(plan, /filtered by the role others: tenant_id <> ALL\(1, 3\)/);
});

test("every spelling of a whole row of a filtered table is refused by the gap's name, never in the engine's words", async () => {
  await wire();
  const c = await connect("acme7", addUser("acme7", "tenant", { tenant: "1" }));
  for (const sql of ["SELECT c FROM customers c", "SELECT row(c.*) FROM customers c", "SELECT row(c.*) IS NULL FROM customers c", "SELECT ARRAY[row(c.*)] FROM customers c",
    "SELECT count(row(c.*)) FROM customers c", "SELECT to_json(c.*) FROM customers c", "SELECT x FROM customers c, LATERAL (VALUES (row(c.*))) v(x)"]) {
    const r = await refusal(c, sql);
    assert.equal(r.code, "0A000", `${sql}: ${JSON.stringify(r)}`);
    assert.match(`${r.message} ${r.detail ?? ""}`, /Mason gap roles/, `${sql}: ${JSON.stringify(r)}`);
    assert.doesNotMatch(`${r.message} ${r.detail ?? ""}`, /STAR expression|__mason|LIMIT/, sql);
  }
  // t.* in a SELECT's own list is the columns, answered
  assert.deepEqual((await rows(c, "SELECT c.* FROM customers c WHERE c.id = 1")).length, 1);
});

test("EXPLAIN says no row count for a filtered table, as text or JSON, where the Row Filter stands; an unfiltered table keeps its", async () => {
  await wire();
  const c = await connect("acme8", addUser("acme8", "tenant", { tenant: "1" }));
  const text = (await rows(c, "EXPLAIN SELECT count(*) FROM orders")).map((r) => r[0]).join("\n");
  assert.match(text, /Mason: answered from the synced table public\.orders \((?!about)[^\n]*filtered by the role tenant: tenant_id = 1\)/);
  assert.doesNotMatch(text.split("\n")[0]!, /about \d|rows unknown/, "the copy's estimate is every row's");
  const unfiltered = (await rows(c, "EXPLAIN SELECT sku FROM products")).map((r) => r[0]).join("\n");
  assert.match(unfiltered, /public\.products \(about 3 rows/);
  const json = JSON.parse((await rows(c, "EXPLAIN (FORMAT JSON) SELECT count(*) FROM orders o JOIN products p ON p.sku = o.status"))[0]![0]!) as Array<{ Mason: { Tables: Array<Record<string, unknown>> } }>;
  const copies = json[0]!.Mason.Tables;
  const orders = copies.find((x) => x.Table === "public.orders")!, products = copies.find((x) => x.Table === "public.products")!;
  assert.equal(orders["Row Filter"], "filtered by the role tenant: tenant_id = 1");
  assert.equal("Estimated Rows" in orders, false);
  assert.equal(products["Estimated Rows"], 3);
  assert.equal("Row Filter" in products, false);
});

/** every form of EXPLAIN, and what a filtered table's hidden rows would show in each */
const PLAN_FORMS = ["EXPLAIN", "EXPLAIN (COSTS OFF)", "EXPLAIN (VERBOSE)", "EXPLAIN (FORMAT JSON)", "EXPLAIN (FORMAT JSON, COSTS OFF, VERBOSE)"];
const ENGINE_LINE = /rows=\d+|"Plan Rows"|actual rows=|"Actual Rows"|Empty Result|EMPTY_RESULT|answered reading no synced table|Table Scan|TABLE_SCAN|Seq Scan/i;
// the statements' hidden rows hold the table's maximum: a column's visible maximum, a value between the two, one above
const FILTERED_READS = [
  { name: "where:", user: ["plan_tenant", "tenant", { tenant: "1" }], sql: (n: string) => `SELECT 1 FROM orders WHERE amount > ${n}`, between: "500", above: "5000" },
  { name: "a list", user: ["plan_list", "others", { tenants: ["1"] }], sql: (n: string) => `SELECT 1 FROM orders WHERE amount > ${n}`, between: "500", above: "5000" },
  { name: "through:", user: ["plan_through", "tenant", { tenant: "2" }], sql: (n: string) => `SELECT 1 FROM order_items WHERE qty > ${n}`, between: "6", above: "80" },
  { name: "a join of two filtered tables", user: ["plan_join", "tenant", { tenant: "1" }], sql: (n: string) => `SELECT 1 FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.amount > ${n}`, between: "500", above: "5000" },
] as const;

test("EXPLAIN of a statement that reads a filtered table says Mason's lines alone, the same whatever the table's statistics prove", async () => {
  await wire();
  for (const r of FILTERED_READS) {
    const c = await connect(r.user[0], addUser(...(r.user as unknown as [string, string, Record<string, string | string[]>])));
    // the literal is in what is sent, and nothing else may differ
    const plain = async (form: string, n: string): Promise<string> => (await rows(c, `${form} ${r.sql(n)}`)).map((x) => x[0]).join("\n").replaceAll(`> ${n}`, "> N");
    for (const form of PLAN_FORMS) {
      const between = await plain(form, r.between);
      assert.equal(between, await plain(form, r.above), `${r.name}, ${form}: between the visible and the hidden maximum, and above the hidden one`);
      assert.doesNotMatch(between, ENGINE_LINE, `${r.name}, ${form}`);
      assert.match(between, /filtered by the role \w+: /, `${r.name}, ${form}`);
      assert.match(between, /Sent [Tt]o (the )?[Ee]ngine/, `${r.name}, ${form}: what is sent is Mason's`);
      assert.match(between, /a user with no row filter reads the full plan/, `${r.name}, ${form}: the way out`);
    }
    // a parameter: byte for byte, the literal not in the text
    const bound = async (n: string): Promise<string> => (await rows(c, `EXPLAIN (COSTS OFF) ${r.sql("$1")}`, [Number(n)])).map((x) => x[0]).join("\n");
    assert.equal(await bound(r.between), await bound(r.above), `${r.name}: a bound value`);
    for (const form of ["EXPLAIN ANALYZE", "EXPLAIN (ANALYZE, FORMAT JSON)", "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)"]) {
      for (const n of [r.between, r.above]) {
        const refused = await refusal(c, `${form} ${r.sql(n)}`);
        assert.equal(refused.code, "0A000", `${r.name}, ${form}: ${JSON.stringify(refused)}`);
        assert.match(`${refused.message} ${refused.detail ?? ""}`, /EXPLAIN ANALYZE is not answered .*a table the role filters .*Mason gap roles/, `${r.name}, ${form}`);
        assert.match(refused.hint ?? "", /a user with no row filter reads the full plan/, `${r.name}, ${form}: the way out`);
        assert.doesNotMatch(JSON.stringify(refused), ENGINE_LINE);
      }
    }
  }
});

test("a filtered read's first line and JSON tables are the statement's, with no table named by the engine; an unfiltered user's plan is the engine's, whole", async () => {
  await wire();
  const c = await connect("plan_first", addUser("plan_first", "tenant", { tenant: "1" }));
  // a statement the engine answers reading nothing, a filtered table it never scans, and two tables
  assert.match((await rows(c, "EXPLAIN SELECT 1 FROM orders WHERE false"))[0]![0]!, /^Mason: answered from the synced table public\.orders \(.*filtered by the role tenant/);
  const two = (await rows(c, "EXPLAIN SELECT 1 FROM orders o JOIN products p ON p.sku = o.status")).map((r) => r[0]!);
  assert.deepEqual(two.slice(0, 1), ["Mason: answered from the synced tables"]);
  assert.match(two.join("\n"), /public\.orders \((?!about)[^\n]*filtered by the role tenant/);
  assert.match(two.join("\n"), /public\.products \(about 3 rows/, "a table no filter holds keeps its count");
  const json = JSON.parse((await rows(c, "EXPLAIN (FORMAT JSON) SELECT 1 FROM orders"))[0]![0]!) as Array<{ Plan: Record<string, unknown>; Mason: { Tables: Array<Record<string, unknown>>; "Answered By": string } }>;
  assert.deepEqual(json[0]!.Plan, { "Node Type": "Plan Not Shown" });
  assert.equal(json[0]!.Mason["Answered By"], "the engine");
  assert.deepEqual(json[0]!.Mason.Tables.map((t) => t.Table), ["public.orders"], "mason mcp reads a copy's facts here");
  // the same user, a statement that reads no filtered table: the engine's plan
  assert.match((await rows(c, "EXPLAIN SELECT * FROM products")).map((r) => r[0]).join("\n"), /Seq Scan on public\.products|Scan on public\.products/);
  const open = await connect("plan_open", addUser("plan_open", "everything"));
  const full = (await rows(open, "EXPLAIN (COSTS OFF) SELECT 1 FROM orders WHERE amount > 500")).map((r) => r[0]).join("\n");
  assert.match(full, /Scan on public\.orders/, "an operator reads the full plan as a user with no row filter");
  assert.doesNotMatch(full, /Note: the engine's plan is not shown|__mason_barrier/);
  assert.match((await rows(open, "EXPLAIN ANALYZE SELECT count(*) FROM orders")).map((r) => r[0]).join("\n"), /actual rows=/);
  // a statement of its own, whatever it names its subquery: its text is not Mason's filtered read
  const own = (await rows(open, "EXPLAIN SELECT a FROM (SELECT id AS a FROM orders) AS __mason_barrier")).map((r) => r[0]).join("\n");
  assert.doesNotMatch(own, /try\(/);
  assert.deepEqual(await rows(c, "SELECT count(a) FROM (SELECT id AS a FROM products p, (VALUES (1)) v(id)) AS __mason_barrier"), [["3"]], "as a filtered user, a statement reading no filtered table");
  // ... and as a filtered user, over the filtered table: Postgres's rows, the wall named by what the statement does not hold
  const visible = [["10"], ["11"], ["13"], ["16"]];
  for (const [form, sql] of [
    ["a list of its own", "SELECT a FROM (SELECT id AS a FROM orders) AS __mason_barrier ORDER BY a"],
    ["a *", "SELECT * FROM (SELECT id FROM orders) AS __mason_barrier ORDER BY 1"],
    ["a * of a *", "SELECT id FROM (SELECT * FROM (SELECT id FROM orders) AS __mason_barrier) AS __mason_barrier_1 ORDER BY 1"],
    ["a unicode escape of the name", `SELECT a FROM (SELECT id AS a FROM orders) AS U&"__mason\\005fbarrier" ORDER BY a`],
    ["the name as a literal", "SELECT id FROM orders WHERE '__mason_barrier' <> '' ORDER BY id"],
    ["as a WITH query", "WITH __mason_barrier AS (SELECT id FROM orders) SELECT id FROM __mason_barrier ORDER BY id"],
  ] as const) assert.deepEqual(await rows(c, sql), visible, form);
  const sent = (await rows(c, "EXPLAIN SELECT a FROM (SELECT id AS a FROM orders) AS __mason_barrier")).map((r) => r[0]).join("\n");
  assert.match(sent, /AS __mason_barrier_1\b/, "the wall takes a name the statement does not hold");
});

test("a literal that spells what the engine's text is printed from answers as itself, for any user", async () => {
  await wire();
  const filtered = await connect("spelled_filtered", addUser("spelled_filtered", "tenant", { tenant: "1" }));
  const open = await connect("spelled_open", addUser("spelled_open", "everything"));
  for (const literal of ['try("columns"(*))', 'any_value("columns"(', "__mason_columns_0(", "__mason_columns_0(*) __mason_columns_1("]) {
    const quoted = `'${literal}'`;
    assert.deepEqual(await rows(open, `SELECT ${quoted} FROM products LIMIT 1`), [[literal]], `unfiltered: ${literal}`);
    assert.deepEqual(await rows(filtered, `SELECT ${quoted} FROM products LIMIT 1`), [[literal]], `a filtered user, no filtered table: ${literal}`);
    assert.deepEqual(await rows(filtered, `SELECT ${quoted} FROM orders LIMIT 1`), [[literal]], `a filtered table: ${literal}`);
    assert.deepEqual(await rows(filtered, `SELECT ${quoted}, count(*) FROM orders GROUP BY id ORDER BY id LIMIT 1`), [[literal, "1"]], `grouped by a key: ${literal}`);
  }
});

test("a table's statistics reach no statement: what the engine would prove from them answers alike on either side of a hidden row's value", async () => {
  await wire();
  const outcome = async (c: pg.Client, sql: string): Promise<string> => {
    try { return JSON.stringify(await rows(c, sql)); }
    catch (e) { return (e as pg.DatabaseError).code ?? "no code"; }
  };
  const c = await connect("stats_tenant", addUser("stats_tenant", "tenant", { tenant: "1" }));
  const list = await connect("stats_list", addUser("stats_list", "others", { tenants: ["1"] }));
  const through = await connect("stats_through", addUser("stats_through", "tenant", { tenant: "2" }));
  for (const [who, sql, between, above] of [
    // a condition proved false from a column's maximum takes the other conditions with it: 22012 or an answer, a binary search
    [c, (n: string) => `SELECT count(*) FROM orders WHERE 1/(id - id) > 0 AND amount > ${n}`, "500", "5000"],
    [list, (n: string) => `SELECT count(*) FROM orders WHERE 1/(id - id) > 0 AND amount > ${n}`, "500", "5000"],
    [through, (n: string) => `SELECT count(*) FROM order_items WHERE 1/(id - id) > 0 AND qty > ${n}`, "6", "80"],
    [c, (n: string) => `SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE 1/(o.id - o.id) > 0 AND o.amount > ${n}`, "500", "5000"],
    // a range no value of the other side falls in
    [c, (n: string) => `SELECT count(*) FROM orders o JOIN (VALUES (${n}::bigint)) v(x) ON o.amount = v.x WHERE 1/(o.id - o.id) > 0`, "999", "5000"],
  ] as const) {
    assert.equal(await outcome(who, sql(between)), await outcome(who, sql(above)), sql("N"));
  }
  // NULL: a hidden row's null is in the table's null count, and a table with none proves IS NULL false
  assert.equal(await outcome(c, "SELECT count(*) FROM order_items WHERE 1/(id - id) > 0 AND order_id IS NULL"), await outcome(c, "SELECT count(*) FROM order_items WHERE 1/(id - id) > 0 AND id IS NULL"));
});

test("a GROUP BY of a filtered table's key answers what the key decides, as Postgres under row security does; a group it does not decide is never split", async () => {
  await wire();
  const c = await connect("keyed", addUser("keyed", "tenant", { tenant: "1" }));
  const statuses = [["10", "paid"], ["11", "pending"], ["13", "paid"], ["16", "paid"]];
  assert.deepEqual(await rows(c, "SELECT o.id, o.status FROM orders o GROUP BY o.id ORDER BY o.id"), statuses);
  assert.deepEqual(await rows(c, "SELECT id, status, count(*) FROM orders GROUP BY id ORDER BY id"), statuses.map((r) => [...r, "1"]));
  assert.deepEqual(await rows(c, "SELECT c.*, count(*) FROM customers c GROUP BY c.id ORDER BY c.id"), [["1", "1", EU, "Ann", "1"], ["2", "1", US, "Bo", "1"]], "a star beside an aggregate");
  assert.deepEqual(await rows(c, "SELECT id AS k, status FROM orders GROUP BY k ORDER BY k LIMIT 1"), [["10", "paid"]], "an output name of the key");
  assert.deepEqual(await rows(c, "SELECT id, status FROM orders GROUP BY 1 ORDER BY 1 LIMIT 1"), [["10", "paid"]], "a position of the key");
  assert.deepEqual(await rows(c, "SELECT o.id, (SELECT o.status) FROM orders o GROUP BY o.id ORDER BY o.id LIMIT 1"), [["10", "paid"]], "a correlated subquery's column");
  assert.deepEqual(await rows(c, "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY o.id, c.id ORDER BY o.id"), [["10", "Ann"], ["11", "Bo"]], "two filtered keys");
  assert.deepEqual(await rows(c, "SELECT id, sum(amount) FROM orders GROUP BY id HAVING status = 'paid' ORDER BY id"), [["10", "100"], ["13", "30"], ["16", "5"]], "HAVING");
  // not the key: the groups are the statement's, and nothing joins them
  assert.deepEqual(await rows(c, "SELECT lower(status), count(*) FROM orders GROUP BY lower(status) ORDER BY 1"), [["paid", "3"], ["pending", "1"]]);
  assert.deepEqual(await rows(c, "SELECT lower(status) AS k, count(*) FROM orders GROUP BY k ORDER BY 1"), [["paid", "3"], ["pending", "1"]]);
  assert.deepEqual(await rows(c, "SELECT count(*) FROM (SELECT status, count(id) FROM orders GROUP BY status) s"), [["2"]]);
  // a grouping set keeps its refusal by name, with the way out
  const sets = await refusal(c, "SELECT id, status FROM orders GROUP BY GROUPING SETS ((id))");
  assert.equal(sets.code, "0A000", JSON.stringify(sets));
  assert.match(`${sets.message} ${sets.detail ?? ""}`, /a GROUP BY of a key of a table its role filters.*Mason gap roles/);
  assert.match(sets.hint ?? "", /name each column it reads in the GROUP BY/);
});

test("a catalog that cannot check the filters: every statement refused, the line said once a streak, the recovery said", async () => {
  await wire();
  const acme = await connect("acme9", addUser("acme9", "tenant", { tenant: "1" }));
  const policies = PgCatalog.prototype.policies;
  const failing = (): string[] => logged.filter((l) => l.includes("could not be checked by the catalog"));
  const before = failing().length;
  PgCatalog.prototype.policies = async () => { throw new Error("the catalog is gone"); };
  try {
    fs.writeFileSync(rolesFile, `${ROLES}\n# a new file, so a new check\n`);
    for (let i = 0; i < 4; i++) assert.equal((await refusal(acme, "SELECT count(*) FROM orders")).code, "57P03", "fails closed");
    assert.equal(failing().length - before, 1, `one line for the streak:\n${failing().join("\n")}`);
    // mason share meets the same catalog: the failure is said as Mason's, and the file is not blamed
    const { RunShares, shareSecret } = await import("../src/cli/share-run.ts");
    const shares = new RunShares({ listener: api, database: "shop", log: () => undefined, certificate: () => ({ message: "no socket should open", code: "failed" }) });
    const opened = await shares.open({ secret: shareSecret("x"), role: "everything" });
    assert.ok("failure" in opened, JSON.stringify(opened));
    assert.equal(opened.failure.code, "failed");
    assert.match(opened.failure.message, /^nothing is shared: the roles' row filters could not be checked by the catalog: the catalog is gone$/);
    assert.deepEqual(opened.failure.next, [["mason logs", "the run's log"]]);
  } finally { PgCatalog.prototype.policies = policies; fs.writeFileSync(rolesFile, ROLES); }
  assert.deepEqual((await rows(acme, "SELECT count(*) FROM orders"))[0], ["4"], "answered again, no restart");
  assert.ok(logged.some((l) => l.includes("the catalog checks the row filters again")), "the streak's end said");
});
