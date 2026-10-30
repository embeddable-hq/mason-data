/**
 * THE ROLES FILE, READ (src/cli/roles.ts; GitHub issue 30, stage 1b): `tables: all`, `default:`, the start's roles line
 * and the file `mason init` writes — unit tests, no listener (tests/duck-roles-wire.test.ts holds them over the wire).
 * What it must hold:
 *   - `tables: all` resolves to every copied table, every column, `all: true` on the role and on each table;
 *   - every refusal of the new keys is at its key, with a did-you-mean where a name is close, on ONE report with the
 *     file's other mistakes: a table keyed `all`, `tables:` another string or a list, `default:` not a name, `default:`
 *     naming a role the file lacks, `default:` beside no `roles:`;
 *   - the start's roles line in the file's three states (none, a default, no default) and when it cannot be read;
 *   - `newRolesText()` is a valid file whose default is `everything`, `tables: all`.
 * ROWS PER USER (stage 2: `attributes:`, `where:`, `through:`):
 *   - `attributes:` as a list (every one a scalar) or a map of scalar | list; a bad shape word with a did-you-mean;
 *   - a `where:` reading an attribute the role does not declare, at its key, with the did-you-mean and the line that
 *     declares it; `where:` beside `through:`; an empty `where:`; an unclosed string; a malformed `through:`; a
 *     `through:` parent the role lacks, one with no filter of its own, and a cycle — all on ONE report;
 *   - `through:` resolved by the one foreign key; none or several refused with the explicit form as the way out; the
 *     explicit form without a foreign key compares with the parent's one-column key; `resolveRoles` builds the filters;
 *   - the users missing an attribute their role reads, said in ONE wording with the commands that make them again.
 * The module is imported inside each test, so a tree without these exports fails each test by name (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const roles = async () => await import("../src/cli/roles.ts");
const FILE = "/p/mason/roles.yml";
const copied = [
  { source: "public.orders", columns: [{ name: "id" }, { name: "status" }, { name: "amount" }] },
  { source: "public.customers", columns: [{ name: "id" }, { name: "email" }] },
  { source: "billing.invoices", columns: [{ name: "id" }, { name: "total" }] },
];
/** the file's mistakes as `mason start` says them: one report */
async function report(text: string): Promise<{ message: string; why?: string }> {
  const r = await roles();
  const parsed = r.parseRolesText(text, FILE);
  assert.ok("problems" in parsed, `read: ${JSON.stringify(parsed)}`);
  const f = r.rolesFailure(FILE, "/p", parsed.problems);
  return { message: f.message, ...(f.why !== undefined ? { why: f.why } : {}) };
}

test("tables: all resolves to every copied table and every column, all: true on the role and on each table", async () => {
  const r = await roles();
  const file = r.parseRolesText("roles:\n  everything:\n    tables: all\n  agent:\n    tables:\n      orders: { columns: [id] }\n", FILE);
  assert.ok(!("problems" in file), JSON.stringify(file));
  assert.equal(file.roles[0]!.tables, "all");
  assert.equal(file.default, null, "no default: written");
  const g = r.resolveRoles(file, copied, "/p");
  assert.ok(!("message" in g));
  const everything = g.get("everything")!;
  assert.equal(everything.all, true);
  assert.deepEqual([...everything.tables.values()], [
    { table: "public.orders", all: true, columns: ["id", "status", "amount"] },
    { table: "public.customers", all: true, columns: ["id", "email"] },
    { table: "billing.invoices", all: true, columns: ["id", "total"] },
  ]);
  assert.equal(g.get("agent")!.all, false);
  // resolved against the tables copied NOW: one more copied, one more granted
  const more = r.resolveRoles(file, [...copied, { source: "public.events", columns: [{ name: "id" }] }], "/p");
  assert.ok(!("message" in more));
  assert.deepEqual([...more.get("everything")!.tables.keys()], ["public.orders", "public.customers", "billing.invoices", "public.events"]);
  // and nothing to hold against the sources file: tables: all never names a table it lacks
  assert.deepEqual(r.roleProblems({ ...file, roles: file.roles.filter((x) => x.name === "everything") }, []), []);
});

test("default: a role of the file, read; the user's role decided by the file (userRole) in each state", async () => {
  const r = await roles();
  const file = r.parseRolesText("default: everything\nroles:\n  everything:\n    tables: all\n", FILE);
  assert.ok(!("problems" in file));
  assert.equal(file.default, "everything");
  assert.deepEqual(r.userRole({ role: "agent" }, { file: "mason/roles.yml", default: "everything", problem: null }), { role: "agent", roleFrom: "file", readsNothing: false });
  assert.deepEqual(r.userRole({}, { file: "mason/roles.yml", default: "everything", problem: null }), { role: "everything", roleFrom: "default", readsNothing: false });
  assert.deepEqual(r.userRole({}, { file: "mason/roles.yml", default: null, problem: null }), { roleFrom: "none", readsNothing: true });
  assert.deepEqual(r.userRole({}, { file: null, default: null, problem: null }), { roleFrom: "none", readsNothing: false });
  assert.deepEqual(r.usersWithNoRole([{ name: "a" }, { name: "b", role: "agent" }], { file: "mason/roles.yml", default: null, problem: null }), ["a"]);
  assert.deepEqual(r.usersWithNoRole([{ name: "a" }], { file: "mason/roles.yml", default: "everything", problem: null }), []);
  assert.deepEqual(r.usersWithNoRole([{ name: "a" }], { file: null, default: null, problem: null }), []);
  // a file that cannot be read as it is now says nothing of a default: the listener refuses such a user for the FILE
  // (57P03, repair it), so it is neither defaulted nor "reads nothing" (the review of #44)
  const broken = { file: "mason/roles.yml", default: null, problem: "it is not YAML" };
  assert.deepEqual(r.userRole({}, broken), { roleFrom: "none", readsNothing: false });
  assert.deepEqual(r.userRole({}, { ...broken, default: "everything" }), { roleFrom: "none", readsNothing: false }, "a last good default is not said either");
  assert.deepEqual(r.userRole({ role: "agent" }, broken), { role: "agent", roleFrom: "file", readsNothing: false });
  assert.deepEqual(r.usersWithNoRole([{ name: "a" }], broken), []);
});

test("the new keys' refusals, each at its key with the way out, on ONE report", async () => {
  const shape = "roles.r.tables: is all (every copied table and column) or one entry per table the role may read, like tables: { orders: {}, customers: { exclude: [email] } }";
  assert.deepEqual(await report("roles:\n  r:\n    tables:\n      all: {}\n"),
    { message: "mason/roles.yml: roles.r.tables.all: all names every table — write tables: all for every copied table, or public.all for a table named all" });
  assert.deepEqual(await report("roles:\n  r:\n    tables: alll\n"), { message: `mason/roles.yml: ${shape} — alll is neither — did you mean \`all\`?` });
  assert.deepEqual(await report("roles:\n  r:\n    tables: ALL\n"), { message: `mason/roles.yml: ${shape} — ALL is neither — did you mean \`all\`?` });
  assert.deepEqual(await report("roles:\n  r:\n    tables: everything\n"), { message: `mason/roles.yml: ${shape} — everything is neither` }, "no guess at a different word");
  assert.deepEqual(await report("roles:\n  r:\n    tables: [all]\n"), { message: `mason/roles.yml: ${shape} — not a list: tables: all, or a key per table` });
  assert.deepEqual(await report("default: [a]\nroles:\n  r:\n    tables: all\n"), { message: "mason/roles.yml: default: is a role's name, like default: everything (a list or a map is not a name)" });
  assert.deepEqual(await report("default:\nroles:\n  r:\n    tables: all\n"), { message: "mason/roles.yml: default: is a role's name, like default: everything (null is read by YAML as nothing (null), not a name)" });
  assert.deepEqual(await report("default: everythin\nroles:\n  everything:\n    tables: all\n  agent:\n    tables: all\n"),
    { message: "mason/roles.yml: default: there is no role everythin in roles: — did you mean `everything`? — add it under roles:, or name one of: everything, agent" });
  assert.deepEqual(await report("defualt: r\nroles:\n  r:\n    tables: all\n"),
    { message: "mason/roles.yml: unexpected key defualt — did you mean `default`? — a roles file takes default and roles" });
  // beside no roles:, and every mistake of the file at once
  assert.deepEqual(await report("default: everything\n"), { message: "mason/roles.yml has 2 mistakes",
    why: "- default: there is no role everything in roles: — add it under roles:\n- roles: missing — write roles: {} and one entry per role: agent: { tables: { orders: {} } }" });
  assert.deepEqual(await report("default: nope\nroles:\n  r:\n    tables: alll\n  s:\n    tables:\n      all: {}\n"), { message: "mason/roles.yml has 3 mistakes",
    why: "- default: there is no role nope in roles: — add it under roles:, or name one of: r, s\n" +
      "- roles.r.tables: is all (every copied table and column) or one entry per table the role may read, like tables: { orders: {}, customers: { exclude: [email] } } — alll is neither — did you mean `all`?\n" +
      "- roles.s.tables.all: all names every table — write tables: all for every copied table, or public.all for a table named all" });
  // not YAML: the library's own words, its first line, never ending in the colon before the snippet it drops (the review of #44)
  const notYaml = await report("roles: [not a map");
  assert.match(notYaml.message, /^mason\/roles\.yml: it is not YAML: .* at line 1, column \d+$/, notYaml.message);
  // a table named all is reachable as public.all
  const r = await roles();
  const named = r.parseRolesText("roles:\n  r:\n    tables:\n      public.all: {}\n", FILE);
  assert.ok(!("problems" in named), JSON.stringify(named));
});

test("the start's roles line in the file's three states, and when it cannot be read", async () => {
  const r = await roles();
  const grants = (names: string[]) => new Map(names.map((n) => [n, { name: n, file: "mason/roles.yml", tables: new Map(), all: false }]));
  assert.equal(r.rolesDefaultLine({ file: null, grants: new Map(), problem: null, default: null }, "mason/roles.yml"),
    "roles: no mason/roles.yml: every user reads every copied table; mason init writes one");
  assert.equal(r.rolesDefaultLine({ file: "mason/roles.yml", grants: grants(["everything", "agent"]), problem: null, default: "everything" }, "mason/roles.yml"),
    "2 roles from mason/roles.yml (everything, agent); default: everything (a user added without --role)");
  assert.equal(r.rolesDefaultLine({ file: "mason/roles.yml", grants: grants(["agent"]), problem: null, default: null }, "mason/roles.yml"),
    "1 role from mason/roles.yml (agent); no default: a user with no role reads nothing");
  assert.equal(r.rolesDefaultLine({ file: "mason/roles.yml", grants: grants([]), problem: "it is not YAML", default: null }, "mason/roles.yml"),
    "roles: mason/roles.yml cannot be read as it is now, so every user's statements are refused until it is fixed: it is not YAML");
  // the way out said for a user with no role: ONE wording, the refusal's HINT's
  assert.equal(r.noRoleWayOut("metabase", "mason/roles.yml", "agent"),
    "write default: agent at the top of mason/roles.yml, or mason user remove metabase and mason user add metabase --role agent");
});

test("newRolesText: the file mason init writes is a valid roles file — default everything, tables: all — and today's access", async () => {
  const r = await roles();
  const text = r.newRolesText();
  const file = r.parseRolesText(text, FILE);
  assert.ok(!("problems" in file), JSON.stringify(file));
  assert.equal(file.default, "everything");
  assert.deepEqual(file.roles, [{ name: "everything", tables: "all" }], "the narrower role is a comment");
  const g = r.resolveRoles(file, copied, "/p");
  assert.ok(!("message" in g));
  assert.equal(g.get("everything")!.tables.size, copied.length, "every copied table");
  assert.match(text, /^# Who may read what of the tables the sources file copies\. Yours to commit, beside sources\/\.\ndefault: everything /);
  // the commented role is one to uncomment: valid once its # are gone
  const uncommented = text.replace(/^ {2}# agent:/m, "  agent:").replace(/^ {2}# {3}tables:/m, "    tables:").replace(/^ {2}# {5}(orders|customers)/gm, "      $1");
  const two = r.parseRolesText(uncommented, FILE);
  assert.ok(!("problems" in two), uncommented);
  assert.deepEqual(two.roles.map((x) => x.name), ["everything", "agent"]);
});

const shop = [
  { source: "public.customers", columns: [{ name: "id" }, { name: "tenant_id" }, { name: "email" }], foreignKeys: [], key: ["id"] },
  { source: "public.orders", columns: [{ name: "id" }, { name: "customer_id" }, { name: "billed_to" }, { name: "tenant_id" }],
    foreignKeys: [{ column: "customer_id", target: "public.customers", targetColumn: "id" }, { column: "billed_to", target: "public.customers", targetColumn: "id" }], key: ["id"] },
  { source: "public.order_items", columns: [{ name: "id" }, { name: "order_id" }, { name: "sku" }],
    foreignKeys: [{ column: "order_id", target: "public.orders", targetColumn: "id" }], key: ["id"] },
];

test("attributes: a list (each a scalar) or a map of scalar | list; where: and through: read into the role's tables", async () => {
  const r = await roles();
  const file = r.parseRolesText([
    "roles:",
    "  tenant:",
    "    attributes: [tenant]",
    "    tables:",
    "      customers: { where: \"tenant_id = :tenant\" }",
    "      order_items: { through: orders }",
    "      orders: { through: { customers: customer_id } }",
    "  regional:",
    "    attributes: { tenant: scalar, tenants: list }",
    "    tables:",
    "      customers: { where: \"tenant_id = ANY(:tenants) AND id <> :tenant\" }",
  ].join("\n"), FILE);
  assert.ok(!("problems" in file), JSON.stringify(file));
  const [tenant, regional] = file.roles;
  assert.deepEqual([...tenant!.attributes!], [["tenant", "scalar"]]);
  assert.deepEqual([...regional!.attributes!], [["tenant", "scalar"], ["tenants", "list"]]);
  const t = tenant!.tables as Array<{ name: string; where?: { text: string }; through?: unknown }>;
  assert.equal(t[0]!.where!.text, "tenant_id = :tenant");
  assert.deepEqual(t[1]!.through, { name: "orders", table: "public.orders", column: null });
  assert.deepEqual(t[2]!.through, { name: "customers", table: "public.customers", column: "customer_id" });
  // resolved: the explicit form follows its foreign key; the implicit one the only foreign key there is
  const g = r.resolveRoles(file, shop, "/p");
  assert.ok(!("message" in g), JSON.stringify(g));
  const filters = g.get("tenant")!.filters!;
  assert.deepEqual(filters.get("public.order_items")!.through, { parent: "public.orders", column: "order_id", parentColumn: "id" });
  assert.deepEqual(filters.get("public.orders")!.through, { parent: "public.customers", column: "customer_id", parentColumn: "id" });
  assert.equal(filters.get("public.customers")!.where!.text, "tenant_id = :tenant");
  assert.equal(filters.get("public.customers")!.at, "roles.tenant.tables.customers");
  assert.deepEqual([...g.get("tenant")!.attributes!.keys()], ["tenant"]);
});

test("every mistake of attributes:, where: and through: is at its key, on ONE report, with the way out", async () => {
  const { why } = await report([
    "roles:",
    "  a:",
    "    attributes: { tenant: scalr }",
    "    tables: { customers: {} }",
    "  b:",
    "    attributes: [tenant]",
    "    tables:",
    "      customers: { where: \"tenant_id = :tenat\" }",
    "      orders: { where: \"x = 1\", through: customers }",
    "      order_items: { where: \"\" }",
    "  c:",
    "    tables:",
    "      customers: { where: \"note = 'open\" }",
    "      orders: { through: [customers] }",
    "  d:",
    "    tables:",
    "      customers: {}",
    "      orders: { through: customers }",
    "      order_items: { through: refunds }",
    "  e:",
    "    tables:",
    "      customers: { through: orders }",
    "      orders: { through: customers }",
  ].join("\n"));
  const lines = why!.split("\n");
  const has = (re: RegExp): void => assert.ok(lines.some((l) => re.test(l)), `${re} in:\n${why}`);
  has(/^- roles\.a\.attributes\.tenant: is scalar \(one value: --set tenant=42\) or list \(several: --set tenant=12 --set tenant=41\) — did you mean `scalar`\?/);
  has(/^- roles\.b\.tables\.customers\.where: :tenat is not an attribute of the role — did you mean `tenant`\? — declare it beside tables: attributes: \[tenant, tenat\]/);
  has(/^- roles\.b\.tables\.orders: where and through together .* keep one/);
  has(/^- roles\.b\.tables\.order_items\.where: is a Postgres condition on the table's columns, quoted: where: "tenant_id = :tenant"/);
  has(/^- roles\.c\.tables\.customers\.where: .*is not closed/);
  has(/^- roles\.c\.tables\.orders\.through: is the table whose visible rows make this one's visible: through: orders, or through: \{ orders: order_id \}/);
  has(/^- roles\.d\.tables\.orders\.through: customers has no where: or through: of its own, so every row of it is visible — filter it/);
  has(/^- roles\.d\.tables\.order_items\.through: refunds is not a table of the role d .*— add it with a where:/);
  has(/^- roles\.e\.tables\.customers\.through: comes back round \(customers → orders → customers\) — one of them needs a where: instead/);
});

test("through: by no foreign key or by several is refused with the explicit form; the explicit form without one compares the parent's key", async () => {
  const r = await roles();
  const read = (yaml: string) => { const f = r.parseRolesText(yaml, FILE); assert.ok(!("problems" in f), JSON.stringify(f)); return f; };
  // two foreign keys from orders to customers: name the one
  const two = r.resolveRoles(read("roles:\n  t:\n    attributes: [tenant]\n    tables:\n      customers: { where: \"tenant_id = :tenant\" }\n      orders: { through: customers }\n"), shop, "/p");
  assert.ok("message" in two);
  assert.equal(two.message, "mason/roles.yml: roles.t.tables.orders.through: public.orders references public.customers by 2 foreign keys (customer_id, billed_to) — name the one: through: { customers: customer_id } or through: { customers: billed_to }");
  // none: from customers to orders there is no foreign key
  const none = r.resolveRoles(read("roles:\n  t:\n    attributes: [tenant]\n    tables:\n      orders: { where: \"tenant_id = :tenant\" }\n      customers: { through: orders }\n"), shop, "/p");
  assert.ok("message" in none);
  assert.match(none.message, /roles\.t\.tables\.customers\.through: public\.customers has no foreign key to public\.orders \(as the database's catalog reports them\) — name the column that references it: through: \{ orders: <a column of customers> \}$/);
  // the explicit form on a column with no foreign key: compared with the parent's one-column primary key
  const explicit = r.resolveRoles(read("roles:\n  t:\n    attributes: [tenant]\n    tables:\n      orders: { where: \"tenant_id = :tenant\" }\n      customers: { through: { orders: id } }\n"), shop, "/p");
  assert.ok(!("message" in explicit), JSON.stringify(explicit));
  assert.deepEqual(explicit.get("t")!.filters!.get("public.customers")!.through, { parent: "public.orders", column: "id", parentColumn: "id" });
  // a column the copy lacks, with a did-you-mean
  const typo = r.resolveRoles(read("roles:\n  t:\n    attributes: [tenant]\n    tables:\n      customers: { where: \"tenant_id = :tenant\" }\n      orders: { through: { customers: custmer_id } }\n"), shop, "/p");
  assert.ok("message" in typo);
  assert.match(typo.message, /roles\.t\.tables\.orders\.through\.customers: the copy of public\.orders has no column custmer_id — did you mean `customer_id`\?/);
});

test("the users missing an attribute their role reads: named with the commands that make them again; none when the file has a problem", async () => {
  const r = await roles();
  const file = r.parseRolesText("roles:\n  t:\n    attributes: { tenant: scalar, regions: list }\n    tables:\n      customers: { where: \"tenant_id = :tenant AND email = ANY(:regions)\" }\n  everything:\n    tables: all\n", FILE);
  assert.ok(!("problems" in file));
  const grants = r.resolveRoles(file, shop, "/p");
  assert.ok(!("message" in grants));
  const live = { file: "mason/roles.yml", default: null, problem: null, grants };
  const users = [
    { name: "acme", role: "t", attributes: { tenant: "1", regions: ["eu"] } },
    { name: "stale", role: "t", attributes: { tenant: "1" } },
    { name: "bare", role: "t" },
    { name: "admin", role: "everything" },
  ];
  const missing = r.usersMissingAttributes(users, live);
  assert.deepEqual(missing, [{ name: "stale", role: "t", missing: ["regions"] }, { name: "bare", role: "t", missing: ["tenant", "regions"] }]);
  assert.equal(r.missingAttributesText(missing[1]!),
    "the user bare has no value for tenant, regions, which the role t filters rows by: its statements are refused — mason user remove bare && mason user add bare --role t --set tenant=<value> --set regions=<value>");
  assert.deepEqual(r.usersMissingAttributes(users, { ...live, problem: "it is not YAML" }), [], "a file that cannot be read refuses everyone already (57P03): no second claim");
});
