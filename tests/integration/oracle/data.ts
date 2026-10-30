/**
 * ADVERSARIAL SOURCE DATA over a small synthetic shop (tenants, customers, orders, their items, products and
 * categories): everything the CLAUDE.md rule "Correct for any data, not the data we tested" names — shared
 * values, NULL beside '' beside a value, case variants, a key that points at nothing, a time exactly on a
 * bucket boundary, 1970, the far future, ties, negatives, float-unfriendly decimals — and, after the first sync,
 * every kind of change the stream carries: an UPDATE to NULL, a row moved across a day and a month, a row moved
 * between TENANTS, a DELETE, a deleted id re-inserted. Deterministic (a seeded PRNG), so a difference reproduces.
 */

/**
 * `changed_seq`: 0 on every seeded row, and a sequence number stamped by a trigger (STAMPING, enabled after the seed)
 * on every row inserted or updated afterwards, in the order the changes happened — a column the copy and the poll must
 * carry like any other, and the latest-change order a statement can sort by.
 */
export const SCHEMA = `
CREATE TABLE public.tenants (
  id text PRIMARY KEY, name text, plan text, changed_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE public.customers (
  id bigint PRIMARY KEY, tenant_id text NOT NULL, name text, email text, created_at timestamptz NOT NULL, changed_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE public.orders (
  id bigint PRIMARY KEY, tenant_id text NOT NULL, customer_id bigint, status text, amount numeric(12, 2) NOT NULL, created_at timestamptz NOT NULL, notes text, changed_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE public.order_items (
  id bigint PRIMARY KEY, tenant_id text NOT NULL, order_id bigint, product text, quantity int NOT NULL, unit_price numeric(12, 2), changed_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE public.products (
  sku text PRIMARY KEY, tenant_id text NOT NULL, name text, category text, created_at timestamptz NOT NULL, changed_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE public.categories (
  code text PRIMARY KEY, tenant_id text NOT NULL, name text, changed_seq bigint NOT NULL DEFAULT 0);
CREATE SEQUENCE public.oracle_change_seq;
CREATE FUNCTION public.oracle_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.changed_seq := nextval('public.oracle_change_seq'); RETURN NEW; END $$;
`;
/** Run after the seed: from here every insert or update is a change the stream carries, and takes the next version. */
export const STAMPING = ["tenants", "customers", "orders", "order_items", "products", "categories"].map((t) =>
  `CREATE TRIGGER oracle_stamp BEFORE INSERT OR UPDATE ON public.${t} FOR EACH ROW EXECUTE FUNCTION public.oracle_stamp();`).join("\n");

/**
 * Every source table and its primary key. `products` and `categories` are LOOKUPS KEYED BY TEXT UNDER
 * A NAME THAT IS NOT `id`: an item names its product by `product = sku`, a product its category by `category =
 * code` — a two-hop path whose restricted reads (the ClickHouse stack's lookup joins, `WHERE <the hop's own
 * key> IN (...)`) once read `id`, which only a lookup keyed by a column of that name answered; the demo's
 * lookups all are, so the oracle never reached the defect. The keys hold the data's product names ('' and a case
 * variant among them) and digits ('1', '01': a text id a number would normalise).
 */
/** `tenants` IS THE TENANT TABLE (`tenants.id`): one row per tenant, keyed
 *  by the text the other tables carry as `tenant_id` — '' among them, and no row for the sentinel's 'sentinel'. */
export const KEY_OF: Record<string, string> = { tenants: "id", customers: "id", orders: "id", order_items: "id", products: "sku", categories: "code" };
export const TABLES = Object.keys(KEY_OF);

/** mulberry32: small, seedable, good enough to spread values */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const lit = (v: unknown): string => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

export const TENANTS = ["acme", "globex", ""] as const;
const NAMES = ["Ada Lovelace", "ada lovelace", "Zoë Ñandú", "O'Hara", "", null, "Grace Hopper", "  padded  ", "Alan Turing"];
const STATUSES = ["paid", "pending", "refunded", null, "", "PAID", "paid ", "paid"];
// NOT NULL: a sum over a column that cannot be NULL is still NULL over no rows in Postgres
const AMOUNTS = ["7.00", "0", "-5.50", "0.10", "0.20", "120.00", "99.99", "1000000000.00", "0.01", "80.50", "42.00"];
// an item's product is a SKU of products (below) — or not: 'WIDGET' (a round's update) and 'gizmo' have no product row
const PRODUCTS = ["widget", "Widget", "gadget", "", null, "sprocket", "gizmo", "widget", "1", "01"];
/** The products' keys: the items' names (minus 'gizmo'), digits, a trailing space, an apostrophe, and one no item names. */
const SKUS = ["widget", "Widget", "gadget", "", "sprocket", "1", "01", "17", "x", "widget ", "O'Hara", "unsold"];
/** The categories' keys: one-letter strings and '' among them, a case pair, a digit. */
const CATEGORY_CODES = ["a", "x", "", "tools", "Tools", "1", "toys"];
// a product's category: a code, NULL, or one no category has
const CATEGORY_REFS = [...CATEGORY_CODES, null, "nothing", "TOOLS"];
const CATEGORY_NAMES = ["Tools", "tools", "", null, "Toys & Games", "O'Hara's", "a"];
// NOT NULL, as above; the NULL a line's total meets is the price's
const QUANTITIES = [1, 2, 0, -1, 7, 1000, 3];
// no price of exactly 0: a negative quantity times 0 would make a -0, which the type matrix (type-matrix.ts) asks of
// on purpose
const PRICES = [null, "60.00", "0.10", "99.99", "15.25", "0.01"];

/** A wide column: NULL, '', a word, or kilobytes of text. */
function notes(r: () => number): string | null {
  const x = r();
  if (x < 0.2) return null;
  if (x < 0.3) return "";
  if (x < 0.4) return pick(r, ["ok", "O'Hara's", "ñ", "  "]);
  const words = ["lorem", "ipsum", "dolor", "sit", "amet", "O'Hara", "Zoë", "widget", "\\", "line\nbreak"];
  return Array.from({ length: 300 + Math.floor(r() * 400) }, () => pick(r, words)).join(" ");
}

/** Instants that sit on and beside bucket boundaries, in UTC. */
function instants(r: () => number): string[] {
  const out: string[] = [
    "1970-01-05 00:00:00+00", "2026-07-01 00:00:00+00", "2026-08-01 00:00:00+00", "2026-09-01 00:00:00+00", "2026-10-01 00:00:00+00",
    "2026-08-31 23:59:59.999999+00", "2026-09-30 23:59:59.999999+00", "2026-09-15 00:00:00+00", "2026-09-15 00:00:00.000001+00",
    "2026-12-31 23:59:59.999999+00", "2027-01-01 00:00:00+00", "2026-09-14 23:00:00+00", "2026-09-14 22:59:59+00",
  ];
  for (let i = 0; i < 300; i++) {
    const day = 1 + Math.floor(r() * 95);                 // 2026-07-01 .. 2026-10-03
    const d = new Date(Date.UTC(2026, 6, day, Math.floor(r() * 24), Math.floor(r() * 60), Math.floor(r() * 60)));
    out.push(d.toISOString().replace("T", " ").replace("Z", "+00"));
  }
  return out;
}

/**
 * ONE ORDER ON EACH INSTANT A ZONE'S CLOCK CHANGE MAKES AMBIGUOUS: the hour a clock falls back over happens twice, and
 * a wall-clock time in it (`2026-11-01 01:30` in New York) is read by Postgres as the LATER of the two instants
 * (`timestamp AT TIME ZONE`). A row on each instant makes a misreading a difference in ROWS.
 */
export const CLOCK_CHANGE_ROWS: ReadonlyArray<[number, string]> = [
  [700001, "2026-11-01 05:30:00+00"],   // New York 01:30 EDT, the first 01:30
  [700002, "2026-11-01 06:30:00+00"],   // New York 01:30 EST, the second: what "2026-11-01 01:30" means there
  [700003, "2026-11-01 07:30:00+00"],   // New York 02:30 EST, after the change
  [700004, "2026-10-25 00:30:00+00"],   // London 01:30 BST, the first 01:30
  [700005, "2026-10-25 01:30:00+00"],   // London 01:30 GMT, the second: what "2026-10-25 01:30" means there
  [700006, "2026-03-08 06:30:00+00"],   // New York 01:30 EST, before the clock springs forward over 02:00
  [700007, "2026-03-08 07:30:00+00"],   // New York 03:30 EDT: what "2026-03-08 02:30", which does not exist, means there
  [700008, "2026-11-01 04:30:00+00"],   // Havana 00:30 CDT, the first half hour of 2026-11-01, whose midnight happens twice:
                                        //   a date bound starts at the first (04:00Z), so the day holds it, as its `.day` bucket does
];

export interface Seed { counts: Map<string, number>; sql: string }

/** The initial rows: what the first copy stores. */
export function seed(seedNumber = 7): Seed {
  const r = prng(seedNumber);
  const when = instants(r);
  const customerIds = [...Array.from({ length: 30 }, (_, i) => i + 1), 1000000000000];
  const customers = customerIds.map((id) => `(${id}, ${lit(pick(r, TENANTS))}, ${lit(pick(r, NAMES))}, ${lit(r() < 0.3 ? null : `c${id}@example.test`)}, ${lit(pick(r, when))})`);
  const orderIds = Array.from({ length: 400 }, (_, i) => i + 1);
  const orders = orderIds.map((id) => {
    const customer = r() < 0.05 ? null : r() < 0.05 ? 999 : pick(r, customerIds);
    return `(${id}, ${lit(pick(r, TENANTS))}, ${customer === null ? "NULL" : customer}, ${lit(pick(r, STATUSES))}, ${lit(pick(r, AMOUNTS))}, ${lit(pick(r, when))}, ${lit(notes(r))})`;
  });
  // the clock-change rows, drawn from nothing so every seed's earlier rows are unchanged
  for (const [id, at] of CLOCK_CHANGE_ROWS) orders.push(`(${id}, 'acme', 1, 'paid', '42.00', ${lit(at)}, NULL)`);
  const items = Array.from({ length: 599 }, (_, i) => {
    const order = r() < 0.05 ? null : r() < 0.05 ? 9999 : pick(r, orderIds);
    const qty = pick(r, QUANTITIES);
    return `(${i + 1}, ${lit(pick(r, TENANTS))}, ${order === null ? "NULL" : order}, ${lit(pick(r, PRODUCTS))}, ${qty}, ${lit(pick(r, PRICES))})`;
  });
  // the lookups are drawn AFTER the rows above, so the rows above are unchanged by them
  const products = SKUS.map((sku) => `(${lit(sku)}, ${lit(pick(r, TENANTS))}, ${lit(pick(r, NAMES))}, ${lit(pick(r, CATEGORY_REFS))}, ${lit(pick(r, when))})`);
  const categories = CATEGORY_CODES.map((code) => `(${lit(code)}, ${lit(pick(r, TENANTS))}, ${lit(pick(r, CATEGORY_NAMES))})`);
  // the tenants, drawn last so every row above is unchanged by them: a name, a NULL name, an empty id
  const tenants = TENANTS.map((id) => `(${lit(id)}, ${lit(pick(r, NAMES))}, ${lit(pick(r, ["pro", "free", null, ""]))})`);
  return {
    counts: new Map([["tenants", tenants.length], ["customers", customers.length], ["orders", orders.length], ["order_items", items.length], ["products", products.length], ["categories", categories.length]]),
    sql: [
      `INSERT INTO public.tenants VALUES ${tenants.join(",\n")};`,
      `INSERT INTO public.customers VALUES ${customers.join(",\n")};`,
      `INSERT INTO public.orders VALUES ${orders.join(",\n")};`,
      `INSERT INTO public.order_items VALUES ${items.join(",\n")};`,
      `INSERT INTO public.products VALUES ${products.join(",\n")};`,
      `INSERT INTO public.categories VALUES ${categories.join(",\n")};`,
    ].join("\n"),
  };
}

/**
 * A round of changes the poll must carry: each a new version of a row the copy stored (an UPDATE to NULL, a row moved
 * across a day, a month and a tenant, a DELETE, a deleted id re-inserted). The oracle asks every statement again after
 * each of two rounds.
 */
export function mutations(round: number): string {
  const r = prng(100 + round);
  const ids = (n: number, lo: number, hi: number): number[] => [...new Set(Array.from({ length: n }, () => lo + Math.floor(r() * (hi - lo))))];
  const list = (xs: number[]): string => xs.join(", ");
  const o = (n: number): string => list(ids(n, 1, 400));
  const keys = (xs: readonly string[], n: number): string => [...new Set(Array.from({ length: n }, () => pick(r, xs)))].map(lit).join(", ");
  const skus = (n: number): string => keys(SKUS, n);
  const codes = (n: number): string => keys(CATEGORY_CODES, n);
  return [
    `UPDATE public.orders SET status = 'paid' WHERE id IN (${o(40)});`,
    `UPDATE public.orders SET status = NULL WHERE id IN (${o(8)});`,
    `UPDATE public.orders SET status = '' WHERE id IN (${o(5)});`,
    `UPDATE public.orders SET amount = -0.30 WHERE id IN (${o(8)});`,
    `UPDATE public.orders SET amount = 0.30 WHERE id IN (${o(6)});`,
    // moved across a day, a month, and back into the past: a key that lives in two partitions
    `UPDATE public.orders SET created_at = created_at + interval '20 days' WHERE id IN (${o(12)});`,
    `UPDATE public.orders SET created_at = created_at - interval '40 days' WHERE id IN (${o(6)});`,
    `UPDATE public.orders SET created_at = '2026-10-01 00:00:00+00' WHERE id IN (${o(4)});`,
    // moved between tenants: the old tenant must not see it any more
    `UPDATE public.orders SET tenant_id = 'globex' WHERE id IN (${o(5)}) AND tenant_id = 'acme';`,
    `UPDATE public.orders SET tenant_id = '' WHERE id IN (${o(3)});`,
    `UPDATE public.orders SET customer_id = NULL WHERE id IN (${o(5)});`,
    `UPDATE public.orders SET customer_id = 999 WHERE id IN (${o(4)});`,
    `UPDATE public.orders SET notes = NULL WHERE id IN (${o(5)});`,
    `UPDATE public.orders SET notes = repeat('changed ', 400) WHERE id IN (${o(5)});`,
    `UPDATE public.orders SET notes = 'short' WHERE id IN (${o(3)});`,
    `DELETE FROM public.orders WHERE id IN (${o(15)});`,
    // A ROW THAT COMES AND GOES IN ONE BATCH (review of #390): inserted and deleted in one transaction, so the
    // stream carries both in one flush and the trigger MV aggregates both versions of it — a `pick: min` over a
    // customer's created_at would keep this 2025 value for ever unless the reader sees that nothing current
    // supplies it (the ClickHouse stack's change reader, its stored min / max rule). Customer 7's orders are all 2026.
    `BEGIN; INSERT INTO public.orders VALUES (${950000 + round}, 'acme', 7, 'paid', 1.00, '2025-01-01 00:00:00+00', 'in and out'); DELETE FROM public.orders WHERE id = ${950000 + round}; COMMIT;`,
    // a deleted id re-inserted, with other values
    `INSERT INTO public.orders SELECT i, 'acme', 1, 'paid', 7.77, '2026-09-20 12:00:00+00', 'reinserted' FROM unnest(ARRAY[${o(3)}]) i WHERE NOT EXISTS (SELECT 1 FROM public.orders WHERE id = i);`,
    `UPDATE public.customers SET name = NULL WHERE id IN (${list(ids(3, 1, 30))});`,
    `UPDATE public.customers SET name = 'Renamed' WHERE id IN (${list(ids(3, 1, 30))});`,
    `UPDATE public.customers SET tenant_id = 'globex' WHERE id IN (${list(ids(2, 1, 30))});`,
    `DELETE FROM public.customers WHERE id IN (${list(ids(3, 1, 30))});`,
    `UPDATE public.order_items SET unit_price = NULL WHERE id IN (${list(ids(10, 1, 600))});`,
    `UPDATE public.order_items SET quantity = 5, unit_price = 2.50 WHERE id IN (${list(ids(10, 1, 600))});`,
    `UPDATE public.order_items SET product = 'WIDGET' WHERE id IN (${list(ids(10, 1, 600))});`,
    `UPDATE public.order_items SET order_id = NULL WHERE id IN (${list(ids(5, 1, 600))});`,
    `DELETE FROM public.order_items WHERE id IN (${list(ids(20, 1, 600))});`,
    `DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE status = 'refunded' AND id IN (${o(10)}));`,
    // the text-keyed lookups (KEY_OF): a product's category re-pointed, cleared and dangled, a product and a
    // category deleted (an item's second hop then reads NULL), a deleted key re-inserted — drawn after the rows
    // above, so rounds 1 and 2 are unchanged by them
    `UPDATE public.products SET name = NULL WHERE sku IN (${skus(2)});`,
    `UPDATE public.products SET name = 'Renamed product' WHERE sku IN (${skus(2)});`,
    `UPDATE public.products SET category = 'x' WHERE sku IN (${skus(3)});`,
    `UPDATE public.products SET category = NULL WHERE sku IN (${skus(2)});`,
    `UPDATE public.products SET category = 'nothing' WHERE sku IN (${skus(2)});`,
    `UPDATE public.products SET tenant_id = 'globex' WHERE sku IN (${skus(2)}) AND tenant_id = 'acme';`,
    `DELETE FROM public.products WHERE sku IN (${skus(2)});`,
    `INSERT INTO public.products SELECT s, 'acme', 'reinserted', 'tools', '2026-09-20 12:00:00+00' FROM unnest(ARRAY[${skus(2)}]) s WHERE NOT EXISTS (SELECT 1 FROM public.products WHERE sku = s);`,
    // the tenants table's own rows change too: a renamed tenant, a plan cleared (a token's rows are the same)
    `UPDATE public.tenants SET name = 'Renamed tenant' WHERE id = ${lit(pick(r, TENANTS))};`,
    `UPDATE public.tenants SET plan = NULL WHERE id = ${lit(pick(r, TENANTS))};`,
    `UPDATE public.categories SET name = NULL WHERE code IN (${codes(2)});`,
    `UPDATE public.categories SET name = 'Renamed category' WHERE code IN (${codes(2)});`,
    `DELETE FROM public.categories WHERE code IN (${codes(2)});`,
  ].join("\n");
}
