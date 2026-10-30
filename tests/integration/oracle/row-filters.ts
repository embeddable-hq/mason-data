/**
 * ROWS PER USER, HELD TO POSTGRES ROW SECURITY (GitHub issue 30, stage 2; src/duck/row-filter.ts): a synthetic shop of
 * its own (`shop.customers` with an integer tenant and a uuid region, `shop.orders` referencing a customer,
 * `shop.order_items` referencing an order, and a security_invoker view over orders), a Mason roles file filtering it
 * — `where:` over a scalar, a list, a list on a uuid column beside a scalar, a `through:` two levels deep under a list,
 * two attributes in one predicate over a column the role may not read — and the SAME filters written as Postgres's own
 * `CREATE POLICY … USING (current_setting('mason.attr.…'))`, each Mason user mirrored by a Postgres login whose
 * `ALTER ROLE … SET mason.attr.…` is the user's `--set`. Every statement is asked of both as each user, and of both as
 * a user of the same tables with no filter (`open`), and held equal by the oracle's verdict.
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
`;

/** the roles file (mason/roles.yml) as a project would write it */
export const ROWS_ROLES = `roles:
  open:
    tables:
      shop.customers: {}
      shop.orders: {}
      shop.order_items: {}
  tenant:
    attributes: [tenant]
    tables:
      shop.customers: { where: "tenant_id = :tenant" }
      shop.orders: { where: "tenant_id = :tenant" }
      shop.order_items: { through: shop.orders }
  tenants:
    attributes: { tenants: list }
    tables:
      shop.customers: { where: "tenant_id = ANY(:tenants)" }
      shop.orders: { where: "tenant_id = ANY(:tenants)" }
      shop.order_items: { through: shop.orders }
  regions:
    attributes: { regions: list, tenant: scalar }
    tables:
      shop.customers: { where: "region = ANY(:regions) AND tenant_id <> :tenant" }
      shop.orders: { through: shop.customers }
      shop.order_items: { through: { shop.orders: order_id } }
  hidden:
    attributes: [tenant, blocked]
    tables:
      shop.customers: { exclude: [secret], where: "tenant_id = :tenant AND secret <> :blocked" }
`;

/** each Mason user (`mason user add <key> --role <role> --set …`), mirrored by a Postgres login of the same settings */
export const ROWS_USERS: ReadonlyArray<{ key: string; role: string; attributes: Record<string, string | string[]> }> = [
  { key: "open", role: "open", attributes: {} },
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
      : `GRANT SELECT ON shop.customers, shop.orders, shop.order_items, shop.paid_orders TO ${login(u.key)};`;
    return `CREATE ROLE ${login(u.key)} LOGIN PASSWORD 'x'; GRANT CONNECT ON DATABASE ${tag} TO ${login(u.key)}; GRANT USAGE ON SCHEMA shop TO ${login(u.key)}; ${grants} ${settings}`;
  }).join("\n");
  return [
    logins,
    "ALTER TABLE shop.customers ENABLE ROW LEVEL SECURITY; ALTER TABLE shop.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE shop.order_items ENABLE ROW LEVEL SECURITY;",
    ...["customers", "orders", "order_items"].map((t) => policy(t, "open", "true")),
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
  ].join("\n");
}

/** every shape the brief names, over the three tables and the view: asked as every user but `hidden` */
export const ROW_SHAPES: ReadonlyArray<{ name: string; sql: string; values?: string[]; prepared?: string[] }> = [
  { name: "SELECT * of a filtered table", sql: "SELECT * FROM shop.customers ORDER BY id" },
  { name: "count, sum, avg, count DISTINCT", sql: "SELECT count(*), sum(amount), avg(amount), count(DISTINCT customer_id) FROM shop.orders" },
  { name: "through: two levels, aggregated", sql: "SELECT count(*), sum(quantity * unit_price), count(DISTINCT order_id) FROM shop.order_items" },
  { name: "a join of two filtered tables", sql: "SELECT c.name, count(o.id), sum(o.amount) FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY c.name" },
  { name: "a join of three, items through orders", sql: "SELECT o.status, count(i.id), sum(i.quantity) FROM shop.order_items i JOIN shop.orders o ON o.id = i.order_id GROUP BY o.status ORDER BY o.status NULLS FIRST" },
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

/** the role `hidden` reads customers but its secret, filtered BY the secret and two attributes */
export const HIDDEN_SHAPES: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "hidden: the visible columns", sql: "SELECT id, tenant_id, region, name FROM shop.customers ORDER BY id" },
  { name: "hidden: counted", sql: "SELECT count(*), count(DISTINCT region) FROM shop.customers" },
  { name: "hidden: the hidden column, refused alike", sql: "SELECT secret FROM shop.customers" },
  { name: "hidden: SELECT *, refused alike", sql: "SELECT * FROM shop.customers" },
  { name: "hidden: a table the role lacks", sql: "SELECT count(*) FROM shop.orders" },
];
