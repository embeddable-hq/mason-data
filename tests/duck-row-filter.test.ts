/**
 * A ROLE'S ROW FILTER, READ AND BOUND (src/duck/row-filter.ts) — unit tests, no catalog (tests/duck-roles-rows-wire.test.ts
 * holds the filters over the wire, the oracle holds their answers to Postgres row security's).
 * What it must hold:
 *   - the one lexer for `:name` (`whereParts`) finds an attribute in the SQL and never inside a string, a quoted
 *     identifier, a dollar-quoted string, a comment or a `::` cast; an unclosed string or comment is a problem;
 *   - a bound scalar is a typed CAST of a literal (a quote doubled), a bound list a typed CAST of an ARRAY — the type the
 *     catalog inferred, so a list on a uuid column binds as uuid[];
 *   - EXPLAIN's words say a number bare and anything else quoted, a list as its first five values then "… and N more";
 *   - `missingAttributes` names each attribute a user lacks once, with the `where:` that reads it; `attributeSetting`
 *     answers the catalog's `mason.attr.<name>`, a list comma-joined, and no other setting.
 * The module is imported inside each test, so a tree without it fails each test by name (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const rf = async () => await import("../src/duck/row-filter.ts");

test("whereParts: :name is an attribute in the SQL, never in a string, an identifier, a dollar quote, a comment or a cast", async () => {
  const { whereParts, whereAttributes } = await rf();
  const parts = whereParts("tenant_id = :tenant AND note <> ':no' AND \":nor\" IS NOT NULL AND x::int = :n2 -- :never\n AND $q$:none$q$ = '' /* :nope /* :nested */ */ AND e'\\':not' = '' AND region = ANY(:regions)");
  assert.ok(Array.isArray(parts), JSON.stringify(parts));
  assert.deepEqual(whereAttributes(parts), ["tenant", "n2", "regions"]);
  // the text between them is kept as written, so the rendered predicate is the file's own SQL
  assert.deepEqual(whereParts("a = :x"), ["a = ", { attr: "x" }]);
  for (const bad of ["a = 'open", "a = 1 /* open", "a = $t$ open", "\"open = 1"]) {
    const r = whereParts(bad);
    assert.ok(!Array.isArray(r) && /is not closed/.test(r.problem), `${bad}: ${JSON.stringify(r)}`);
  }
});

test("whereParts refuses a statement's parameter: $1 would read the STATEMENT's first value; a $ elsewhere is untouched", async () => {
  const { whereParts } = await rf();
  for (const sql of ["a = :t AND b = $1", "$12 = a", "a = ($2)"]) {
    const r = whereParts(sql);
    assert.ok(!Array.isArray(r) && /is a statement's parameter, which a where: cannot read — name an attribute of the role: :tenant/.test(r.problem), `${sql}: ${JSON.stringify(r)}`);
  }
  for (const sql of ["a$1 = :t", "note = '$1' AND a = :t", "\"$1\" = :t", "a = $$ $1 $$ AND b = :t", "a = $x$ $1 $x$ AND b = :t", "a = 1 -- $1\n AND b = :t"]) {
    assert.ok(Array.isArray(whereParts(sql)), sql);
  }
});

test("the filtered read is behind the barrier at its outermost only, for a scalar, a list and through:", async () => {
  const { whereParts, bindFilter, filteredSql, BARRIER } = await rf();
  const parts = whereParts("tenant_id = :tenant");
  assert.ok(Array.isArray(parts));
  const orders = bindFilter({ table: "public.orders", at: "x", where: { text: "…", parts } }, new Map([["tenant", "integer"]]), { tenant: "1" });
  const items = bindFilter({ table: "public.order_items", at: "y", through: { parent: "public.orders", column: "order_id", parentColumn: "id" } }, new Map(), {});
  const lines = bindFilter({ table: "public.lines", at: "z", through: { parent: "public.order_items", column: "item_id", parentColumn: "id" } }, new Map(), {});
  const filters = new Map([["public.orders", orders], ["public.order_items", items], ["public.lines", lines]]);
  for (const t of filters.keys()) {
    const sql = filteredSql(t, filters);
    assert.ok(sql.endsWith(` ${BARRIER}`), sql);
    assert.equal(sql.split(BARRIER).length - 1, 1, `one barrier, the outermost: ${sql}`);
  }
  assert.equal(filteredSql("public.products", filters), 'SELECT * FROM "public"."products"', "a table no filter holds has no rows to hide");
});

test("bindFilter: a scalar binds as a typed CAST, a list as a typed ARRAY; EXPLAIN's words bound to five values", async () => {
  const { whereParts, bindFilter } = await rf();
  const parts = whereParts("tenant_id = :tenant AND region = ANY(:regions) AND note <> :note");
  assert.ok(Array.isArray(parts));
  const f = { table: "public.orders", at: "roles.tenant.tables.orders", where: { text: "…", parts } };
  const types = new Map([["tenant", "integer"], ["regions", "uuid[]"], ["note", "text"]]);
  const b = bindFilter(f, types, { tenant: "42", regions: ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"], note: "it's" });
  assert.equal(b.predicate, "tenant_id = CAST('42' AS integer) AND region = ANY(CAST(ARRAY['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'] AS uuid[])) AND note <> CAST('it''s' AS text)");
  assert.equal(b.words, "tenant_id = 42 AND region = ANY('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11') AND note <> 'it''s'");
  const many = bindFilter(f, types, { tenant: "1", regions: ["1", "2", "3", "4", "5", "6", "7"], note: "x" });
  assert.match(many.words, /ANY\(1, 2, 3, 4, 5, … and 2 more\)/);
  assert.match(many.predicate!, /ARRAY\['1', '2', '3', '4', '5', '6', '7'\]/, "the predicate holds every value; only the words are bounded");
  const through = bindFilter({ table: "public.order_items", at: "x", through: { parent: "public.orders", column: "order_id", parentColumn: "id" } }, new Map(), {});
  assert.equal(through.words, "a row of orders it references by order_id is visible");
});

test("missingAttributes names each lacking attribute once with its where:; attributeSetting joins a list", async () => {
  const { whereParts, missingAttributes, attributeSetting } = await rf();
  const p1 = whereParts("tenant_id = :tenant"), p2 = whereParts("tenant_id = :tenant AND region = ANY(:regions)");
  assert.ok(Array.isArray(p1) && Array.isArray(p2));
  const filters = [
    { table: "public.customers", at: "roles.r.tables.customers", where: { text: "tenant_id = :tenant", parts: p1 } },
    { table: "public.orders", at: "roles.r.tables.orders", where: { text: "tenant_id = :tenant AND region = ANY(:regions)", parts: p2 } },
    { table: "public.order_items", at: "roles.r.tables.order_items", through: { parent: "public.orders", column: "order_id", parentColumn: "id" } },
  ];
  assert.deepEqual(missingAttributes(filters, { regions: ["eu"] }), [{ attr: "tenant", at: "roles.r.tables.customers.where", where: "tenant_id = :tenant" }]);
  assert.deepEqual(missingAttributes(filters, {}).map((m) => m.attr), ["tenant", "regions"]);
  assert.deepEqual(missingAttributes(filters, { tenant: "1", regions: ["eu"] }), []);
  assert.deepEqual(missingAttributes(filters, { tenant: "1", regions: [] }).map((m) => m.attr), ["regions"], "an empty list is no value");
  assert.equal(attributeSetting("mason.attr.regions", { regions: ["12", "41"] }), "12,41");
  assert.equal(attributeSetting("mason.attr.tenant", { tenant: "42" }), "42");
  assert.equal(attributeSetting("mason.attr.tenant", {}), null);
  assert.equal(attributeSetting("search_path", { search_path: "x" }), null, "only mason.attr.* is an attribute");
});
