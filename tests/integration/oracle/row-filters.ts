/**
 * ROWS PER USER, HELD TO POSTGRES ROW SECURITY (GitHub issue 30, stage 2; src/duck/row-filter.ts): a synthetic shop of
 * its own (`shop.customers` with an integer tenant and a uuid region, `shop.orders` referencing a customer,
 * `shop.order_items` referencing an order, and a security_invoker view over orders), a Mason roles file filtering it
 * — `where:` over a scalar, a list, a list on a uuid column beside a scalar, a `through:` two levels deep under a list,
 * two attributes in one predicate over a column the role may not read — and the SAME filters written as Postgres's own
 * `CREATE POLICY … USING (current_setting('mason.attr.…'))`, each Mason user mirrored by a Postgres login whose
 * `ALTER ROLE … SET mason.attr.…` is the user's `--set`. Every statement is asked of both as each user, and of both as
 * a user of the same tables with no filter (`open`), and held equal by the oracle's verdict.
 *
 * THE BARRIER (`BARRIER_SHAPES`, src/duck/row-filter.ts BARRIER): `shop.invoices` and `shop.invoice_lines` are built to show
 * a statement's own expression reaching a hidden row: 40,000 rows, ids spread over 2 M, so more than 50 visible keys over a
 * wide range (below that, or over a narrow range, the engine's dynamic join filter prunes hidden rows by itself and a leak
 * passes unseen), and about half of them visible to each filtered user: at a sixth the join's filter prunes the hidden
 * rows too, which hid the leak from the `tenant` and integer-list users' shapes. Every even invoice is tenant 4's, region
 * U2, seen by no filtered user here, and every hundredth of them carries the value the statement's expression raises on;
 * every visible row holds 1. Postgres, whose policies are security barriers, answers each; so must Mason, for a scalar
 * where:, a list, a uuid list and through:, and `open` is refused alike.
 */

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222", U3 = "33333333-3333-4333-8333-333333333333";

/** the shop: rows spread over five tenants and three regions, a customer with no tenant match, an order of no customer
 *  (a NULL foreign key: visible through no parent), an item of no order, NULL statuses and prices */
export const ROWS_SCHEMA = `
CREATE SCHEMA shop;
CREATE TABLE shop.customers (id int PRIMARY KEY, tenant_id int NOT NULL, region uuid NOT NULL, name text, secret text);
CREATE TABLE shop.orders (id int PRIMARY KEY, customer_id int REFERENCES shop.customers (id), tenant_id int NOT NULL, status text, amount numeric(10, 2) NOT NULL, placed_on date NOT NULL);
CREATE TABLE shop.order_items (id int PRIMARY KEY, order_id int REFERENCES shop.orders (id), sku text, quantity int NOT NULL, unit_price numeric(10, 2));
INSERT INTO shop.customers SELECT g, g % 5, (ARRAY['${U1}', '${U2}', '${U3}'])[g % 3 + 1]::uuid, 'customer ' || g, 'k' || g FROM generate_series(1, 60) g;
INSERT INTO shop.orders SELECT g, CASE WHEN g % 37 = 0 THEN NULL ELSE (g * 7) % 60 + 1 END, (g * 3) % 5, (ARRAY['paid', 'open', 'refunded', NULL])[g % 4 + 1],
  ((g * 7919) % 100000) / 100.0, date '2026-01-01' + (g % 90) FROM generate_series(1, 300) g;
INSERT INTO shop.order_items SELECT g, CASE WHEN g % 41 = 0 THEN NULL ELSE (g * 13) % 300 + 1 END, 'sku-' || (g % 17), g % 9 + 1,
  CASE WHEN g % 23 = 0 THEN NULL ELSE ((g * 31) % 5000) / 100.0 END FROM generate_series(1, 900) g;
CREATE VIEW shop.paid_orders WITH (security_invoker = true) AS SELECT id, customer_id, tenant_id, amount FROM shop.orders WHERE status = 'paid';
CREATE TYPE shop.tier AS ENUM ('free', 'pro', 'max');
CREATE TABLE shop.accounts (id int PRIMARY KEY, tier shop.tier NOT NULL, tenant_id int NOT NULL, name text);
INSERT INTO shop.accounts SELECT g, (ARRAY['free', 'pro', 'max'])[g % 3 + 1]::shop.tier, g % 5, 'account ' || g FROM generate_series(1, 90) g;
CREATE TABLE shop.invoices (id bigint PRIMARY KEY, tenant_id int NOT NULL, region uuid NOT NULL, marker int NOT NULL);
INSERT INTO shop.invoices SELECT g * 50 + (g % 2), CASE WHEN g % 2 = 1 THEN 3 WHEN g % 200 = 2 THEN 1 ELSE 4 END, CASE WHEN g % 2 = 0 THEN '${U2}'::uuid WHEN g % 3 = 0 THEN '${U1}'::uuid ELSE '${U3}'::uuid END,
  CASE WHEN g % 200 = 0 THEN 99 ELSE 1 END FROM generate_series(0, 39999) g;
CREATE TABLE shop.invoice_lines (id bigint PRIMARY KEY, invoice_id bigint REFERENCES shop.invoices (id), qty int NOT NULL);
INSERT INTO shop.invoice_lines SELECT 100000 + g, g * 50 + (g % 2), CASE WHEN g % 200 = 0 THEN 99 ELSE 1 END FROM generate_series(0, 39999) g;
CREATE VIEW shop.marked_invoices WITH (security_invoker = true) AS SELECT id, tenant_id, marker FROM shop.invoices;
`;

/** the roles file (mason/roles.yml) as a project would write it */
export const ROWS_ROLES = `roles:
  open:
    tables:
      shop.customers: {}
      shop.orders: {}
      shop.order_items: {}
      shop.accounts: {}
      shop.invoices: {}
      shop.invoice_lines: {}
  tenant:
    attributes: [tenant]
    tables:
      shop.customers: { where: "tenant_id = :tenant" }
      shop.orders: { where: "tenant_id = :tenant" }
      shop.order_items: { through: shop.orders }
      shop.invoices: { where: "tenant_id = :tenant" }
      shop.invoice_lines: { through: shop.invoices }
  tenants:
    attributes: { tenants: list }
    tables:
      shop.customers: { where: "tenant_id = ANY(:tenants)" }
      shop.orders: { where: "tenant_id = ANY(:tenants)" }
      shop.order_items: { through: shop.orders }
      shop.invoices: { where: "tenant_id = ANY(:tenants)" }
      shop.invoice_lines: { through: shop.invoices }
  regions:
    attributes: { regions: list, tenant: scalar }
    tables:
      shop.customers: { where: "region = ANY(:regions) AND tenant_id <> :tenant" }
      shop.orders: { through: shop.customers }
      shop.order_items: { through: { shop.orders: order_id } }
      shop.invoices: { where: "region = ANY(:regions)" }
      shop.invoice_lines: { through: shop.invoices }
  tiers:
    attributes: { tier: scalar, tiers: list, tenants: list }
    tables:
      shop.accounts: { where: "tier = :tier OR (tier = ANY(:tiers) AND tenant_id <> ALL(:tenants))" }
  hidden:
    attributes: [tenant, blocked]
    tables:
      shop.customers: { exclude: [secret], where: "tenant_id = :tenant AND secret <> :blocked" }
`;

/** each Mason user (`mason user add <key> --role <role> --set …`), mirrored by a Postgres login of the same settings */
export const ROWS_USERS: ReadonlyArray<{ key: string; role: string; attributes: Record<string, string | string[]> }> = [
  { key: "open", role: "open", attributes: {} },
  { key: "tiers", role: "tiers", attributes: { tier: "max", tiers: ["free", "pro"], tenants: ["0", "1"] } },
  { key: "tenant", role: "tenant", attributes: { tenant: "3" } },
  { key: "list2", role: "tenants", attributes: { tenants: ["1", "3"] } },
  { key: "list1", role: "tenants", attributes: { tenants: ["3"] } },
  { key: "regions", role: "regions", attributes: { regions: [U1, U3], tenant: "2" } },
  { key: "hidden", role: "hidden", attributes: { tenant: "3", blocked: "k8" } },
];

/** Postgres's own row security for the same roles: one policy per table and role, TO the logins of that role */
export function referenceSql(tag: string, login: (key: string) => string): string {
  const of = (role: string): string => ROWS_USERS.filter((u) => u.role === role).map((u) => login(u.key)).join(", ");
  const scalar = (a: string, type: string): string => `current_setting('mason.attr.${a}')::${type}`;
  const list = (a: string, type: string): string => `string_to_array(current_setting('mason.attr.${a}'), ',')::${type}[]`;
  const policy = (table: string, role: string, using: string): string => `CREATE POLICY ${role}_${table} ON shop.${table} AS PERMISSIVE FOR SELECT TO ${of(role)} USING (${using});`;
  const logins = ROWS_USERS.map((u) => {
    const settings = Object.entries(u.attributes).map(([a, v]) => `ALTER ROLE ${login(u.key)} SET mason.attr.${a} = '${typeof v === "string" ? v : v.join(",")}';`).join(" ");
    const grants = u.role === "hidden" ? `GRANT SELECT (id, tenant_id, region, name) ON shop.customers TO ${login(u.key)};`
      : u.role === "tiers" ? `GRANT SELECT ON shop.accounts TO ${login(u.key)};`
      : `GRANT SELECT ON shop.customers, shop.orders, shop.order_items, shop.paid_orders, shop.invoices, shop.invoice_lines, shop.marked_invoices TO ${login(u.key)};` +
        (u.role === "open" ? ` GRANT SELECT ON shop.accounts TO ${login(u.key)};` : "");
    return `CREATE ROLE ${login(u.key)} LOGIN PASSWORD 'x'; GRANT CONNECT ON DATABASE ${tag} TO ${login(u.key)}; GRANT USAGE ON SCHEMA shop TO ${login(u.key)}; ${grants} ${settings}`;
  }).join("\n");
  return [
    logins,
    ...["customers", "orders", "order_items", "accounts", "invoices", "invoice_lines"].map((t) => `ALTER TABLE shop.${t} ENABLE ROW LEVEL SECURITY;`),
    ...["customers", "orders", "order_items", "accounts", "invoices", "invoice_lines"].map((t) => policy(t, "open", "true")),
    policy("customers", "tenant", `tenant_id = ${scalar("tenant", "int")}`),
    policy("orders", "tenant", `tenant_id = ${scalar("tenant", "int")}`),
    policy("order_items", "tenant", "EXISTS (SELECT 1 FROM shop.orders p WHERE p.id = order_items.order_id)"),
    policy("customers", "tenants", `tenant_id = ANY (${list("tenants", "int")})`),
    policy("orders", "tenants", `tenant_id = ANY (${list("tenants", "int")})`),
    policy("order_items", "tenants", "EXISTS (SELECT 1 FROM shop.orders p WHERE p.id = order_items.order_id)"),
    policy("customers", "regions", `region = ANY (${list("regions", "uuid")}) AND tenant_id <> ${scalar("tenant", "int")}`),
    policy("orders", "regions", "EXISTS (SELECT 1 FROM shop.customers p WHERE p.id = orders.customer_id)"),
    policy("order_items", "regions", "EXISTS (SELECT 1 FROM shop.orders p WHERE p.id = order_items.order_id)"),
    policy("customers", "hidden", `tenant_id = ${scalar("tenant", "int")} AND secret <> ${scalar("blocked", "text")}`),
    policy("invoices", "tenant", `tenant_id = ${scalar("tenant", "int")}`),
    policy("invoices", "tenants", `tenant_id = ANY (${list("tenants", "int")})`),
    policy("invoices", "regions", `region = ANY (${list("regions", "uuid")})`),
    ...["tenant", "tenants", "regions"].map((r) => policy("invoice_lines", r, "EXISTS (SELECT 1 FROM shop.invoices p WHERE p.id = invoice_lines.invoice_id)")),
    policy("accounts", "tiers", `tier = ${scalar("tier", "shop.tier")} OR (tier = ANY (${list("tiers", "shop.tier")}) AND tenant_id <> ALL (${list("tenants", "int")}))`),
  ].join("\n");
}

/** every shape the brief names, over the three tables and the view: asked as every user but `hidden` */
export const ROW_SHAPES: ReadonlyArray<{ name: string; sql: string; values?: string[]; prepared?: string[] }> = [
  { name: "GROUP BY the key: a column it decides", sql: "SELECT o.id, o.status FROM shop.orders o GROUP BY o.id ORDER BY o.id" },
  { name: "GROUP BY the key: *, beside an aggregate", sql: "SELECT o.*, count(*) FROM shop.orders o GROUP BY o.id ORDER BY o.id" },
  { name: "GROUP BY the key: unqualified, with an aggregate", sql: "SELECT id, status, count(*), sum(amount) FROM shop.orders GROUP BY id ORDER BY id" },
  { name: "GROUP BY the key: an output name", sql: "SELECT id AS k, status FROM shop.orders GROUP BY k ORDER BY k" },
  { name: "GROUP BY the key: a position", sql: "SELECT id, status FROM shop.orders GROUP BY 1 ORDER BY 1" },
  { name: "GROUP BY the key: HAVING and ORDER BY read what it decides", sql: "SELECT id, sum(amount) FROM shop.orders GROUP BY id HAVING status = 'paid' ORDER BY placed_on, id" },
  { name: "GROUP BY the key: a correlated subquery reads what it decides", sql: "SELECT o.id, (SELECT o.status) FROM shop.orders o GROUP BY o.id ORDER BY o.id" },
  { name: "GROUP BY two keys, of two filtered tables", sql: "SELECT o.id, o.status, c.name FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id GROUP BY o.id, c.id ORDER BY o.id" },
  { name: "GROUP BY an expression of a column: the column joins nothing", sql: "SELECT lower(status), count(*) FROM shop.orders GROUP BY lower(status) ORDER BY 1" },
  { name: "SELECT * of a filtered table", sql: "SELECT * FROM shop.customers ORDER BY id" },
  { name: "count, sum, avg, count DISTINCT", sql: "SELECT count(*), sum(amount), avg(amount), count(DISTINCT customer_id) FROM shop.orders" },
  { name: "through: two levels, aggregated", sql: "SELECT count(*), sum(quantity * unit_price), count(DISTINCT order_id) FROM shop.order_items" },
  { name: "a join of two filtered tables", sql: "SELECT c.name, count(o.id), sum(o.amount) FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY c.name" },
  { name: "a join of three, items through orders", sql: "SELECT o.status, count(i.id), sum(i.quantity) FROM shop.order_items i JOIN shop.orders o ON o.id = i.order_id GROUP BY o.status ORDER BY o.status NULLS FIRST" },
  { name: "a top N over a join of two filtered tables", sql: "SELECT o.*, c.* FROM shop.orders o LEFT JOIN shop.customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 5 OFFSET 1" },
  { name: "a top N over joins, items through orders", sql: "SELECT o.id, i.id, i.quantity FROM shop.orders o JOIN shop.order_items i ON i.order_id = o.id ORDER BY i.id DESC LIMIT 3" },
  { name: "IN a subquery", sql: "SELECT id FROM shop.customers WHERE id IN (SELECT customer_id FROM shop.orders WHERE status = 'paid') ORDER BY id" },
  { name: "scalar subqueries", sql: "SELECT (SELECT count(*) FROM shop.order_items) AS items, (SELECT max(amount) FROM shop.orders) AS top, (SELECT count(*) FROM shop.customers) AS customers" },
  { name: "EXISTS", sql: "SELECT count(*) FROM shop.customers c WHERE EXISTS (SELECT 1 FROM shop.orders o WHERE o.customer_id = c.id AND o.amount > 500)" },
  { name: "NOT EXISTS", sql: "SELECT id FROM shop.customers c WHERE NOT EXISTS (SELECT 1 FROM shop.orders o WHERE o.customer_id = c.id) ORDER BY id" },
  { name: "a CTE", sql: "WITH t AS (SELECT customer_id, sum(amount) AS total FROM shop.orders GROUP BY customer_id) SELECT customer_id, total FROM t ORDER BY total DESC, customer_id LIMIT 10" },
  { name: "a recursive CTE", sql: "WITH RECURSIVE chain AS (SELECT id, customer_id, 1 AS depth FROM shop.orders WHERE id <= 20 UNION ALL SELECT o.id, o.customer_id, c.depth + 1 FROM shop.orders o JOIN chain c ON o.id = c.id + 60 WHERE c.depth < 4) SELECT depth, count(*), sum(id) FROM chain GROUP BY depth ORDER BY depth" },
  { name: "a view", sql: "SELECT count(*), sum(amount), count(DISTINCT tenant_id) FROM shop.paid_orders" },
  { name: "a view joined to a filtered table", sql: "SELECT c.region::text, count(*) FROM shop.paid_orders p JOIN shop.customers c ON c.id = p.customer_id GROUP BY 1 ORDER BY 1" },
  { name: "UNION", sql: "SELECT tenant_id FROM shop.customers UNION SELECT tenant_id FROM shop.orders ORDER BY 1" },
  { name: "UNION ALL counted", sql: "SELECT count(*) FROM (SELECT id FROM shop.customers UNION ALL SELECT id FROM shop.orders UNION ALL SELECT id FROM shop.order_items) u" },
  { name: "EXCEPT", sql: "SELECT id FROM shop.orders EXCEPT SELECT order_id FROM shop.order_items ORDER BY 1" },
  { name: "INTERSECT", sql: "SELECT customer_id FROM shop.orders INTERSECT SELECT id FROM shop.customers ORDER BY 1" },
  { name: "LEFT JOIN", sql: "SELECT c.id, count(o.id) FROM shop.customers c LEFT JOIN shop.orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id" },
  { name: "RIGHT JOIN", sql: "SELECT o.id, c.name FROM shop.customers c RIGHT JOIN shop.orders o ON o.customer_id = c.id ORDER BY o.id" },
  { name: "a window", sql: "SELECT id, customer_id, sum(amount) OVER (PARTITION BY customer_id ORDER BY id) AS running, rank() OVER (ORDER BY amount DESC, id) AS r FROM shop.orders ORDER BY id" },
  { name: "DISTINCT ON", sql: "SELECT DISTINCT ON (customer_id) customer_id, id, amount FROM shop.orders WHERE customer_id IS NOT NULL ORDER BY customer_id, amount DESC, id" },
  { name: "ORDER BY … LIMIT", sql: "SELECT id, amount FROM shop.orders ORDER BY amount DESC, id LIMIT 7" },
  { name: "LIMIT OFFSET", sql: "SELECT id FROM shop.order_items ORDER BY id LIMIT 5 OFFSET 3" },
  { name: "a lateral", sql: "SELECT c.id, x.top FROM shop.customers c CROSS JOIN LATERAL (SELECT max(o.amount) AS top FROM shop.orders o WHERE o.customer_id = c.id) x ORDER BY c.id" },
  { name: "a uuid column read and cast", sql: "SELECT region::text, count(*) FROM shop.customers GROUP BY region ORDER BY region" },
  { name: "a predicate of the statement's own beside the filter", sql: "SELECT id, tenant_id FROM shop.customers WHERE tenant_id IN (1, 2, 3) AND id > 10 ORDER BY id" },
  { name: "a parameter", sql: "SELECT count(*) FROM shop.orders WHERE status = $1", values: ["paid"] },
  // a prepared statement Parsed once and Executed twice, with other values: the filter is in its plan both times
  { name: "a prepared statement executed twice", sql: "SELECT count(*), sum(amount) FROM shop.orders WHERE placed_on >= $1::date", prepared: ["2026-02-01", "2026-03-15"] },
  { name: "information_schema of a filtered table", sql: "SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' ORDER BY ordinal_position" },
];

/** raises on the value hidden rows hold, every hundredth of them; 1 on every visible row */
const RAISES = (c: string): string => `1/(CASE WHEN ${c} = 99 THEN 0 ELSE 1 END)`;
const R = RAISES("marker"), Q = RAISES("qty");
/** a statement's own expression in every place one can sit, over rows it would raise on were it to reach a hidden one
 *  (see the head of this file): each answered as Postgres under the same policy answers it, `open` refused alike */
export const BARRIER_SHAPES: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "barrier: WHERE, a scalar or a list's table", sql: `SELECT count(*) FROM shop.invoices WHERE ${R} > 0` },
  { name: "barrier: WHERE, through: its SEMI join", sql: `SELECT count(*) FROM shop.invoice_lines WHERE ${Q} > 0` },
  { name: "barrier: WHERE, through:, a key's parity", sql: "SELECT count(*) FROM shop.invoice_lines WHERE id >= 100000 AND 1/(invoice_id % 2) > 0" },
  { name: "barrier: WHERE, beside a condition", sql: `SELECT count(*) FROM shop.invoices WHERE id > 0 AND ${R} = 1` },
  { name: "barrier: the control, nothing raises", sql: "SELECT count(*) FROM shop.invoice_lines WHERE 1/(CASE WHEN qty = 98 THEN 0 ELSE 1 END) > 0" },
  { name: "barrier: a statement that cannot raise", sql: "SELECT count(*), min(id), max(id) FROM shop.invoices WHERE id BETWEEN 51 AND 200000" },
  { name: "barrier: the SELECT list", sql: `SELECT sum(${R}) FROM shop.invoices` },
  { name: "barrier: an aggregate's FILTER", sql: `SELECT count(*) FILTER (WHERE ${R} > 0) FROM shop.invoices` },
  { name: "barrier: GROUP BY", sql: `SELECT g, count(*) FROM (SELECT ${R} AS g FROM shop.invoices) s GROUP BY g ORDER BY g` },
  { name: "barrier: HAVING", sql: `SELECT tenant_id FROM shop.invoices GROUP BY tenant_id HAVING min(${R}) > 0 ORDER BY 1` },
  { name: "barrier: ORDER BY", sql: `SELECT id FROM shop.invoices ORDER BY ${R}, id LIMIT 5` },
  { name: "barrier: a window", sql: `SELECT max(w) FROM (SELECT sum(${R}) OVER () AS w FROM shop.invoices) s` },
  { name: "barrier: a derived table's column", sql: `SELECT count(*) FROM (SELECT id, ${R} AS x FROM shop.invoices) s WHERE x > 0` },
  { name: "barrier: a CTE's column", sql: `WITH s AS (SELECT id, ${R} AS x FROM shop.invoices) SELECT count(*) FROM s WHERE x > 0` },
  { name: "barrier: IN a subquery", sql: `SELECT count(*) FROM shop.invoices WHERE id IN (SELECT id FROM shop.invoices WHERE ${R} > 0)` },
  { name: "barrier: a scalar subquery", sql: `SELECT (SELECT count(*) FROM shop.invoices WHERE ${R} > 0) AS n` },
  { name: "barrier: a view", sql: `SELECT count(*) FROM shop.marked_invoices WHERE ${R} > 0` },
  { name: "barrier: a correlated subquery", sql: `SELECT count(*) FROM shop.invoices o WHERE EXISTS (SELECT 1 FROM shop.invoice_lines i WHERE i.invoice_id = o.id AND ${Q} > 0)` },
  { name: "barrier: a LATERAL", sql: `SELECT count(*) FROM shop.invoices o CROSS JOIN LATERAL (SELECT ${R} AS x) l WHERE l.x > 0` },
  { name: "barrier: JOIN ON", sql: `SELECT count(*) FROM shop.invoices o JOIN shop.invoice_lines i ON i.invoice_id = o.id AND ${Q} > 0` },
  { name: "barrier: LEFT JOIN ON", sql: `SELECT count(*) FROM shop.invoices o LEFT JOIN shop.invoice_lines i ON i.invoice_id = o.id AND ${Q} > 0 WHERE i.id IS NOT NULL` },
  { name: "barrier: two filtered tables", sql: `SELECT count(*) FROM shop.invoices o JOIN shop.invoice_lines i ON i.invoice_id = o.id WHERE ${R} > 0 AND ${Q} > 0` },
  { name: "barrier: a table read twice", sql: `SELECT count(*) FROM shop.invoices a JOIN shop.invoices b ON a.id = b.id WHERE ${RAISES("a.marker")} > 0 AND ${RAISES("b.marker")} > 0` },
  { name: "barrier: UNION ALL branches", sql: `SELECT count(*) FROM (SELECT id FROM shop.invoices WHERE ${R} > 0 UNION ALL SELECT id FROM shop.invoice_lines WHERE ${Q} > 0) u` },
];

/** an enum attribute, scalar and list, and <> ALL over an integer list, one predicate: `tiers` reads shop.accounts alone */
export const TIER_SHAPES: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "tiers: SELECT *", sql: "SELECT * FROM shop.accounts ORDER BY id" },
  { name: "tiers: the enum read and grouped", sql: "SELECT tier, count(*) FROM shop.accounts GROUP BY tier ORDER BY tier" },
  { name: "tiers: the enum compared by the statement", sql: "SELECT count(*) FROM shop.accounts WHERE tier > 'free'" },
  { name: "tiers: a table the role lacks", sql: "SELECT count(*) FROM shop.customers" },
];

/** the role `hidden` reads customers but its secret, filtered BY the secret and two attributes */
export const HIDDEN_SHAPES: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "hidden: the visible columns", sql: "SELECT id, tenant_id, region, name FROM shop.customers ORDER BY id" },
  { name: "hidden: counted", sql: "SELECT count(*), count(DISTINCT region) FROM shop.customers" },
  { name: "hidden: the hidden column, refused alike", sql: "SELECT secret FROM shop.customers" },
  { name: "hidden: SELECT *, refused alike", sql: "SELECT * FROM shop.customers" },
  { name: "hidden: a table the role lacks", sql: "SELECT count(*) FROM shop.orders" },
];
