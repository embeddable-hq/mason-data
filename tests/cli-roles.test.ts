/**
 * THE ROLES FILE, READ (src/cli/roles.ts; GitHub issue 30, stage 1b): `tables: all`, `default:`, the start's roles line
 * and the file `mason init` writes — unit tests, no listener (tests/duck-roles-wire.test.ts holds them over the wire).
 * What it must hold:
 *   - `tables: all` resolves to every synced table, every column, `all: true` on the role and on each table;
 *   - every refusal of the new keys is at its key, with a did-you-mean where a name is close, on ONE report with the
 *     file's other mistakes: a table keyed `all`, `tables:` another string or a list, `default:` not a name, `default:`
 *     naming a role the file lacks, `default:` beside no `roles:`;
 *   - the start's roles line in the file's three states (none, a default, no default) and when it cannot be read;
 *   - `newRolesText()` is a valid file whose default is `everything`, `tables: all`.
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

test("tables: all resolves to every synced table and every column, all: true on the role and on each table", async () => {
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
  const shape = "roles.r.tables: is all (every synced table and column) or one entry per table the role may read, like tables: { orders: {}, customers: { exclude: [email] } }";
  assert.deepEqual(await report("roles:\n  r:\n    tables:\n      all: {}\n"),
    { message: "mason/roles.yml: roles.r.tables.all: all names every table — write tables: all for every synced table, or public.all for a table named all" });
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
      "- roles.r.tables: is all (every synced table and column) or one entry per table the role may read, like tables: { orders: {}, customers: { exclude: [email] } } — alll is neither — did you mean `all`?\n" +
      "- roles.s.tables.all: all names every table — write tables: all for every synced table, or public.all for a table named all" });
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
    "roles: no mason/roles.yml: every user reads every synced table; mason init writes one");
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
  assert.equal(g.get("everything")!.tables.size, copied.length, "every synced table");
  assert.match(text, /^# Who may read what of the tables the sources file copies\. Yours to commit, beside sources\/\.\ndefault: everything /);
  // the commented role is one to uncomment: valid once its # are gone
  const uncommented = text.replace(/^ {2}# agent:/m, "  agent:").replace(/^ {2}# {3}tables:/m, "    tables:").replace(/^ {2}# {5}(orders|customers)/gm, "      $1");
  const two = r.parseRolesText(uncommented, FILE);
  assert.ok(!("problems" in two), uncommented);
  assert.deepEqual(two.roles.map((x) => x.name), ["everything", "agent"]);
});
