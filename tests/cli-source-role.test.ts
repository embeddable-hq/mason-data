/**
 * `mason doctor`'s check of the user Mason connects as (src/cli/source-role.ts, issue 524), over facts faked as its one
 * catalog read returns them: each warning and its code, the route by membership or PUBLIC, the way out's statements,
 * and that a warning never changes the doctor's verdict. tests/integration/cli-source-role.itest.ts runs it on a real
 * Postgres. The module is imported inside each test, so this file loads at a commit without it (scripts/fails-without.ts).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { RelationFact, RoleAsk, RoleFacts } from "../src/cli/source-role.ts";

const roleModule = () => import("../src/cli/source-role.ts");
const doctorModule = () => import("../src/cli/doctor.ts");

const rel = (name: string, o: Partial<RelationFact> = {}): RelationFact => {
  const [schema, table] = name.split(".") as [string, string];
  return { name, sql: `${schema}.${/^[a-z_][a-z0-9_]*$/.test(table) ? table : `"${table}"`}`, kind: "table", entry: name, schemaSql: schema, owner: "admin", owned: false, rowSecurity: false, privileges: [], ...o };
};
const facts = (o: Partial<RoleFacts> = {}): RoleFacts => ({
  user: "app", userSql: "app", databaseSql: "shop", version: 160000,
  roles: [{ name: "app", self: true, superuser: false, bypassrls: false }],
  relations: [rel("public.orders"), rel("billing.Invoices")],
  schemas: [{ name: "billing", sql: "billing", owner: "admin", owned: false, create: [], publicCreate: false },
    { name: "public", sql: "public", owner: "admin", owned: false, create: [], publicCreate: false }],
  definers: [], foreignTables: [], mappedServers: [], adminOf: [], createRole: false, serverRoles: [],
  missing: [], taken: [], rdsReplication: false, ...o,
});
/** The sentence every role warning ends with on a terminal, its `why` in --json. */
const WHY = "Mason never writes, but a role that can only read is safer";
const DEFINER_WHY = "We recommend reviewing each: whether it writes a synced table, and who may call it";
const ask = (o: Partial<RoleAsk> = {}): RoleAsk => ({
  tables: [{ schema: "public", table: "orders" }, { schema: "billing", table: "Invoices" }], replicated: [], publication: null,
  urlVariable: "DATABASE_URL", urlFrom: "DATABASE_URL in .env", file: "mason/sources/shop.yml", url: "postgres://app:secret@db.internal:5432/shop?sslmode=require", ...o,
});

test("a role that only reads: one line, ok, no code and no way out", async () => {
  const { roleChecks } = await roleModule();
  assert.deepEqual(roleChecks(facts(), ask()), [{ name: "role", ok: true,
    detail: "app only reads: not a superuser, no BYPASSRLS, no ADMIN OPTION, no server roles, no foreign server, " +
      "and it neither owns nor may write to the 2 synced table(s) — nor to their partitions, inheritance children or parents, the tables their foreign keys act on, " +
      "or the views and rules that write them — nor CREATE in their schemas, and it reaches no SECURITY DEFINER code whose owner may write" }]);
  const none = roleChecks(facts({ relations: [], schemas: [], missing: ["public.gone"] }), ask());
  assert.equal(none.length, 1);
  assert.equal(none[0]!.ok, true);
  assert.match(none[0]!.detail, /^app only reads: not a superuser, no BYPASSRLS, no ADMIN OPTION, no server roles, no foreign server, and no table is added yet \(the tables are asked once one is\), and it reaches no SECURITY DEFINER code whose owner may write \(not asked of public\.gone, which the database does not have: mason start says so\)$/);
});

test("a superuser, itself or by a membership it may SET ROLE to: ONE warning, role_superuser, whatever else follows from it", async () => {
  const { roleChecks } = await roleModule();
  const self = roleChecks(facts({ roles: [{ name: "app", self: true, superuser: true, bypassrls: true }], relations: [rel("public.orders", { owned: true })] }), ask());
  assert.deepEqual(self.map((c) => [c.code, c.ok, c.warn]), [["role_superuser", true, true]]);
  assert.equal(self[0]!.detail, "app is a superuser", "the facts alone");
  assert.equal(self[0]!.why, WHY);
  const member = roleChecks(facts({ roles: [{ name: "app", self: true, superuser: false, bypassrls: false }, { name: "admins", self: false, superuser: true, bypassrls: false }] }), ask());
  assert.deepEqual(member.map((c) => c.code), ["role_superuser"]);
  assert.equal(member[0]!.detail, "app is a member of admins, a superuser");
});

test("BYPASSRLS, an owner, a write privilege and CREATE: a warning each, with its code and its route (a member role, PUBLIC, a partition)", async () => {
  const { roleChecks, ROLE_CODES } = await roleModule();
  const f = facts({
    roles: [{ name: "app", self: true, superuser: false, bypassrls: false }, { name: "writers", self: false, superuser: false, bypassrls: true }],
    relations: [
      rel("public.orders", { owned: true, owner: "app" }),
      rel("billing.Invoices", { owned: true, owner: "writers", privileges: [{ role: "app", privileges: ["UPDATE", "INSERT"] }, { role: "writers", privileges: ["UPDATE"] }] }),
      rel("public.events_2026", { kind: "partition", entry: "public.events", privileges: [{ role: "app", privileges: ["TRIGGER"] }, { role: "PUBLIC", privileges: ["TRIGGER"] }] }),
    ],
    schemas: [{ name: "billing", sql: "billing", owner: "writers", owned: true, create: ["app", "writers"], publicCreate: false },
      { name: "public", sql: "public", owner: "admin", owned: false, create: ["app"], publicCreate: true }],
  });
  const checks = roleChecks(f, ask());
  assert.deepEqual(checks.map((c) => c.code), ["role_bypassrls", "role_owns_table", "role_writes_table", "role_creates_in_schema"]);
  for (const c of checks) {
    assert.ok(ROLE_CODES.includes(c.code as never), c.code);
    assert.deepEqual([c.name, c.ok, c.warn], ["role", true, true], "a warning, never a failure");
    assert.ok(c.fix?.includes("CREATE ROLE mason_reader LOGIN PASSWORD '<a new password>';"), "each gives the way out");
  }
  const detail = (code: string) => checks.find((c) => c.code === code)!.detail;
  assert.equal(detail("role_bypassrls"), "app has BYPASSRLS (through writers, which it is a member of)");
  assert.equal(detail("role_owns_table"), "app owns public.orders and billing.Invoices (through writers, which it is a member of)");
  // billing.Invoices is owned: its owner's line says it, the privileges an owner holds are not said again
  assert.equal(detail("role_writes_table"), "app may TRIGGER on public.events_2026 (a partition of public.events) (granted to PUBLIC, which every role is)");
  const notOwned = roleChecks({ ...f, relations: f.relations.map((x) => ({ ...x, owned: false })) }, ask()).find((c) => c.code === "role_writes_table")!;
  assert.match(notOwned.detail, /^app may INSERT, UPDATE on billing\.Invoices \(through writers, which it is a member of\); TRIGGER on public\.events_2026/, "privileges in their one order");
  assert.equal(detail("role_creates_in_schema"), "app may CREATE in schema billing (writers, which owns the schema); " +
    "CREATE in schema public (granted to PUBLIC, which every role is)");
  // PUBLIC's privileges are every role's, the new one's too: the way out revokes them
  const fix = checks[0]!.fix!;
  // PUBLIC's are every role's, the application's too: said for the owner to decide, never revoked by the way out
  assert.match(fix, /^-- PUBLIC may CREATE in schema public \(the default before Postgres 15\), so the new role may too: whether PUBLIC should is the owner's to decide, for every role$/m);
  assert.match(fix, /^-- PUBLIC holds TRIGGER on public\.events_2026, so the new role does too/m);
  assert.doesNotMatch(fix, /REVOKE|ALTER FUNCTION/, "no statement that changes another role's privileges");
  assert.equal(new Set(checks.map((c) => c.fix)).size, 1, "one way out, shared");
});

test("CREATE in schema public that is PUBLIC's default before Postgres 15, and nothing else, is information, never a warning (issue 888)", async () => {
  const { roleChecks, PUBLIC_DEFAULT_CREATE } = await roleModule();
  const pub = (o: Partial<RoleFacts["schemas"][number]> = {}) => ({ name: "public", sql: "public", owner: "admin", owned: false, create: ["app"], publicCreate: true, ...o });
  const billing = { name: "billing", sql: "billing", owner: "admin", owned: false, create: [], publicCreate: false };
  const at = (version: number, p = pub()) => roleChecks(facts({ version, schemas: [billing, p] }), ask());
  const only = at(140000);
  assert.equal(PUBLIC_DEFAULT_CREATE, "On Postgres before 15, every role can create tables in schema public by default. Mason never does.");
  assert.deepEqual(only.map((c) => [c.ok, c.warn ?? null, c.code ?? null]), [[true, null, null], [true, null, null]], "no warning, no code, no way out");
  assert.match(only[0]!.detail, /^app only reads: .*nor CREATE in their schemas \(but PUBLIC's default, below\), and it reaches no SECURITY DEFINER code/);
  assert.equal(only[1]!.detail, PUBLIC_DEFAULT_CREATE);
  assert.ok(only.every((c) => c.fix === undefined));
  // what stays a warning: a schema it owns, PUBLIC's CREATE on 15 and later (someone granted it), another schema
  for (const [what, checks] of [["owned", at(140000, pub({ owned: true, owner: "app" }))],
    ["Postgres 15", at(150000)], ["another schema", roleChecks(facts({ version: 140000, schemas: [{ ...billing, create: ["app"], publicCreate: true }, pub({ publicCreate: false, create: [] })] }), ask())]] as const) {
    assert.deepEqual(checks.map((c) => c.code), ["role_creates_in_schema"], what);
    assert.ok(!checks.some((c) => c.detail === PUBLIC_DEFAULT_CREATE), what);
  }
});

test("a write through another relation is named by its route: a partition, an INHERITS child, a view, a rule; the way out grants on the synced tables alone", async () => {
  const { roleChecks, readOnlyFix } = await roleModule();
  const f = facts({ relations: [rel("public.orders"), rel("billing.Invoices"),
    rel("public.orders_2026", { kind: "child", entry: "public.orders", owned: true, owner: "app" }),
    rel("public.orders_v", { kind: "view", entry: "public.orders", privileges: [{ role: "app", privileges: ["UPDATE"] }] }),
    rel("public.orders_log", { kind: "rule", entry: "public.orders", privileges: [{ role: "PUBLIC", privileges: ["INSERT"] }] })] });
  const checks = roleChecks(f, ask());
  assert.deepEqual(checks.map((c) => c.code), ["role_owns_table", "role_writes_table"]);
  assert.equal(checks[0]!.detail, "app owns public.orders_2026 (a child of public.orders, by INHERITS: its rows are public.orders's)");
  assert.equal(checks[1]!.detail, "app may UPDATE on public.orders_v (a view that writes public.orders); INSERT on public.orders_log (its rules write public.orders) (granted to PUBLIC, which every role is)");
  const fix = readOnlyFix(f, ask());
  assert.match(fix, /^GRANT SELECT ON public\.orders, billing\."Invoices" TO mason_reader;$/m, "SELECT on the synced tables, never on a route");
  assert.match(fix, /^-- PUBLIC holds INSERT on public\.orders_log, so the new role does too/m, "PUBLIC's write through a route is said too");
});

test("THE CLASS: an INHERITS parent and a table a foreign key acts on are routes, named in their words", async () => {
  const { roleChecks } = await roleModule();
  const f = facts({ relations: [rel("public.orders"), rel("billing.Invoices"),
    rel("public.base", { kind: "parent", entry: "public.orders", privileges: [{ role: "app", privileges: ["UPDATE", "TRUNCATE"] }] }),
    rel("public.accounts", { kind: "referenced", entry: "billing.Invoices", privileges: [{ role: "app", privileges: ["DELETE"] }] })] });
  const [writes] = roleChecks(f, ask());
  assert.equal(writes!.code, "role_writes_table");
  assert.equal(writes!.detail, "app may UPDATE, TRUNCATE on public.base (an INHERITS parent of public.orders: an UPDATE, DELETE or TRUNCATE of it reaches public.orders's rows); " +
    "DELETE on public.accounts (a foreign key's ON DELETE or ON UPDATE action carries its changes to billing.Invoices, as its owner)");
});

test("THE CLASS: SECURITY DEFINER code it reaches whose owner may write is LISTED to review, never fixed; a foreign server and a role it may become are warnings", async () => {
  const { roleChecks, readOnlyFix } = await roleModule();
  const definer = { owner: "admin", ownerSuperuser: true, callable: false, publicCallable: false, triggers: [] as string[], eventTrigger: false, unchecked: false };
  const definers = [{ ...definer, name: "public.bump(integer)", callable: true, publicCallable: true },
    { ...definer, name: "public.copy_in()", ownerSuperuser: false, owner: "writers", triggers: ["public.inbox"] },
    { ...definer, name: "public.on_ddl()", eventTrigger: true }, { ...definer, name: "public.sum_in(integer, integer)", unchecked: true },
    { ...definer, name: "public.mine()", callable: true }];
  const LISTING = "may run 5 SECURITY DEFINER function(s) of roles that may write the synced tables — " +
    "public.bump(integer) runs as admin, a superuser: every role may call it (PUBLIC's EXECUTE); " +
    "public.copy_in() runs as writers, which may write the synced tables: a trigger on public.inbox, which it may write, calls it; " +
    "public.on_ddl() runs as admin, a superuser: an event trigger calls it on any DDL, even one refused, never asking EXECUTE; " +
    "public.sum_in(integer, integer) runs as admin, a superuser: Postgres calls it for an aggregate, a type, an operator or the like, never asking EXECUTE; " +
    "public.mine() runs as admin, a superuser: it may call it";
  // alone: never "only reads", and no way out, since no statement for this role alone decides it
  const alone = roleChecks(facts({ definers }), ask());
  assert.deepEqual(alone.map((c) => [c.code, c.ok, c.warn, c.fix]), [["role_may_run_definer_code", true, true, undefined]]);
  assert.equal(alone[0]!.detail, "app may not write the synced tables itself: not a superuser, no BYPASSRLS, no ADMIN OPTION, no server roles, no foreign server, " +
    "and it neither owns nor may write to the 2 synced table(s) — nor to their partitions, inheritance children or parents, the tables their foreign keys act on, " +
    `or the views and rules that write them — nor CREATE in their schemas. But it ${LISTING}`);
  assert.equal(alone[0]!.why, DEFINER_WHY, "its own recommendation, apart from the listing");
  // beside the other warnings: listed after them
  const f = facts({ definers, foreignTables: ["public.remote_orders"], mappedServers: ["loopback"], adminOf: ["writers"], createRole: true, serverRoles: ["pg_execute_server_program"] });
  const checks = roleChecks(f, ask());
  assert.deepEqual(checks.map((c) => c.code), ["role_reaches_foreign_server", "role_may_become_another", "role_may_run_definer_code"]);
  const said = (code: string) => checks.find((c) => c.code === code)!.detail;
  assert.equal(said("role_may_run_definer_code"), `app ${LISTING}`);
  assert.equal(said("role_reaches_foreign_server"), "app may write the foreign table(s) public.remote_orders, and has a user mapping (its own or PUBLIC's) on loopback");
  assert.equal(said("role_may_become_another"), "app has ADMIN OPTION on writers; " +
    "has CREATEROLE; holds pg_execute_server_program");
  // the way out changes no role's privileges but the new one's: what every role reaches is said, never revoked
  const fix = readOnlyFix(f, ask());
  assert.doesNotMatch(fix, /REVOKE|ALTER FUNCTION/);
  assert.match(fix, /^-- the new role may still run public\.bump\(integer\), public\.on_ddl\(\) and public\.sum_in\(integer, integer\), as every role may \(SECURITY DEFINER\): mason doctor lists them to review$/m);
  assert.match(fix, /^-- a user mapping FOR PUBLIC on loopback would serve it too/m);
  // a superuser's line stands alone
  assert.deepEqual(roleChecks({ ...f, roles: [{ name: "app", self: true, superuser: true, bypassrls: false }] }, ask()).map((c) => c.code), ["role_superuser"]);
});

// every kind of role warning at once (a superuser's stands alone, so it is its own facts)
const everyKind = (): RoleFacts => facts({
  roles: [{ name: "app", self: true, superuser: false, bypassrls: true }],
  relations: [rel("public.orders", { owned: true, owner: "app" }), rel("billing.Invoices", { privileges: [{ role: "app", privileges: ["UPDATE"] }] })],
  schemas: [{ name: "billing", sql: "billing", owner: "admin", owned: false, create: ["app"], publicCreate: false },
    { name: "public", sql: "public", owner: "admin", owned: false, create: [], publicCreate: false }],
  foreignTables: ["public.remote_orders"], adminOf: ["writers"],
  definers: [{ name: "public.bump(integer)", owner: "admin", ownerSuperuser: true, callable: true, publicCallable: false, triggers: [], eventTrigger: false, unchecked: false }],
});

test("--json: each role warning's parts apart, for a tool: the facts, why, the way out whole, its SQL for the primary and the steps after it", async () => {
  const { roleChecks, readOnlyFix } = await roleModule();
  const { DOCTOR } = await doctorModule();
  const { jsonText } = await import("../src/cli/command.ts");
  const superuser = facts({ roles: [{ name: "app", self: true, superuser: true, bypassrls: false }] });
  const checks = [...roleChecks(superuser, ask()), ...roleChecks(everyKind(), ask())];
  // as mason doctor --json prints them (jsonText refuses a key its spec does not declare)
  const printed = (JSON.parse(jsonText(DOCTOR, { ready: true, verdict: "Ready", checks }, [])) as { checks: Array<Record<string, unknown>> }).checks;
  assert.deepEqual(printed.map((c) => c.code), ["role_superuser", "role_bypassrls", "role_owns_table", "role_writes_table", "role_creates_in_schema",
    "role_reaches_foreign_server", "role_may_become_another", "role_may_run_definer_code"]);
  assert.deepEqual(printed.map((c) => c.detail), ["app is a superuser", "app has BYPASSRLS", "app owns public.orders", "app may UPDATE on billing.Invoices",
    "app may CREATE in schema billing", "app may write the foreign table(s) public.remote_orders", "app has ADMIN OPTION on writers",
    "app may run 1 SECURITY DEFINER function(s) of roles that may write the synced tables — public.bump(integer) runs as admin, a superuser: it may call it"],
  "the facts alone, no sentence after them");
  const SQL = ["-- as the database's owner (on the primary):",
    "CREATE ROLE mason_reader LOGIN PASSWORD '<a new password>';",
    "GRANT CONNECT ON DATABASE shop TO mason_reader;",
    "GRANT USAGE ON SCHEMA public, billing TO mason_reader;",
    'GRANT SELECT ON public.orders, billing."Invoices" TO mason_reader;',
    "-- and GRANT SELECT ON each view Mason should serve: it serves the views the role it connects as may read"].join("\n");
  const THEN = "set MASON_DATABASE_URL=postgres://mason_reader:<its password>@db.internal:5432/shop?sslmode=require in .env and write url: ${MASON_DATABASE_URL} in mason/sources/shop.yml; " +
    "mason doctor checks it again, and a running Mason reads it at its next start (mason stop, then mason start)";
  for (const [c, f] of [[printed[0]!, superuser], ...printed.slice(1, -1).map((c) => [c, everyKind()] as const)] as const) {
    assert.equal(c.why, WHY, String(c.code));
    assert.equal(c.fixSql, SQL, String(c.code));
    assert.equal(c.fixThen, THEN, String(c.code));
    assert.equal(c.fix, `${SQL}\nthen: ${THEN}`, "the whole way out, as before, for a tool that reads it");
    assert.equal(c.fix, readOnlyFix(f, ask()));
  }
  // the SECURITY DEFINER listing: its own why, and no way out (no statement for this role alone decides it)
  const definer = printed.at(-1)!;
  assert.deepEqual([definer.why, definer.fix, definer.fixSql, definer.fixThen], [DEFINER_WHY, undefined, undefined, undefined]);
  // a way out with the publication Mason would make: still SQL apart from the steps
  const streamed = roleChecks(everyKind(), ask({ replicated: ["billing.Invoices"] }))[0]!;
  assert.match(streamed.fixSql!, /^CREATE PUBLICATION mason_reader FOR TABLE billing\."Invoices" .*;   -- Mason's own needs the tables' owner$/m);
  assert.doesNotMatch(streamed.fixSql!, /^then:/m);
  assert.match(streamed.fixThen!, /^set MASON_DATABASE_URL=.*, publication: mason_reader at its top; mason doctor checks it again/);
  const { DOCTOR_USAGE } = await doctorModule();
  assert.match(DOCTOR_USAGE, /checks: \[\{ name, ok, detail, why, warn, code, fix, fixSql, fixThen \}\]/);
  for (const key of ["why (the role's warnings)", "fixSql: its SQL alone, to", "fixThen: the steps after it"]) assert.ok(DOCTOR_USAGE.includes(key), key);
});

test("on a terminal each role warning reads its facts then why, and the way out once under them, as before", async () => {
  const { roleChecks } = await roleModule();
  const { checkLines } = await doctorModule();
  const { PLAIN } = await import("../src/cli/style.ts");
  const checks = roleChecks(facts({ roles: [{ name: "app", self: true, superuser: false, bypassrls: true }],
    definers: [{ name: "public.bump(integer)", owner: "admin", ownerSuperuser: true, callable: true, publicCallable: false, triggers: [], eventTrigger: false, unchecked: false }] }), ask());
  assert.equal(checkLines([{ name: "node", ok: true, detail: "Node 26.0.0" }, ...checks], PLAIN, false).join("\n"), [
    "  ok  node  Node 26.0.0",
    "  !   role  app has BYPASSRLS. Mason never writes, but a role that can only read is safer",
    "  !   role  app may run 1 SECURITY DEFINER function(s) of roles that may write the synced tables — public.bump(integer) runs as admin, a superuser: it may call it. " +
      "We recommend reviewing each: whether it writes a synced table, and who may call it",
    "",
    "    -- as the database's owner (on the primary):",
    "    CREATE ROLE mason_reader LOGIN PASSWORD '<a new password>';",
    "    GRANT CONNECT ON DATABASE shop TO mason_reader;",
    "    GRANT USAGE ON SCHEMA public, billing TO mason_reader;",
    '    GRANT SELECT ON public.orders, billing."Invoices" TO mason_reader;',
    "    -- and GRANT SELECT ON each view Mason should serve: it serves the views the role it connects as may read",
    "    then: set MASON_DATABASE_URL=postgres://mason_reader:<its password>@db.internal:5432/shop?sslmode=require in .env and write url: ${MASON_DATABASE_URL} in mason/sources/shop.yml; " +
      "mason doctor checks it again, and a running Mason reads it at its next start (mason stop, then mason start)",
  ].join("\n"));
});

test("the way out: a role that may LOGIN and SELECT the synced tables alone, its URL in a variable of Mason's own", async () => {
  const { readOnlyFix } = await roleModule();
  assert.equal(readOnlyFix(facts({ relations: [rel("public.orders", { rowSecurity: true }), rel("billing.Invoices"), rel("public.orders_1", { kind: "partition", entry: "public.orders" }), rel("public.orders_v", { kind: "view", entry: "public.orders" })] }), ask()), [
    "-- as the database's owner (on the primary):",
    "CREATE ROLE mason_reader LOGIN PASSWORD '<a new password>';",
    "GRANT CONNECT ON DATABASE shop TO mason_reader;",
    "GRANT USAGE ON SCHEMA public, billing TO mason_reader;",
    'GRANT SELECT ON public.orders, billing."Invoices" TO mason_reader;',
    "CREATE POLICY mason_reader_reads ON public.orders FOR SELECT TO mason_reader USING (true);   -- row-level security: else it reads no row",
    "-- and GRANT SELECT ON each view Mason should serve: it serves the views the role it connects as may read",
    "then: set MASON_DATABASE_URL=postgres://mason_reader:<its password>@db.internal:5432/shop?sslmode=require in .env and write url: ${MASON_DATABASE_URL} in mason/sources/shop.yml; " +
      "mason doctor checks it again, and a running Mason reads it at its next start (mason stop, then mason start)",
  ].join("\n"));
  const secretless = readOnlyFix(facts(), ask());
  assert.doesNotMatch(secretless, /secret/, "the URL's password is never repeated");
  // a variable of Mason's own already: set where it is; a name taken: the next one
  const own = readOnlyFix(facts({ taken: ["mason_reader", "mason_reader2"] }), ask({ urlVariable: "MASON_DATABASE_URL", urlFrom: "MASON_DATABASE_URL in .env.local" }));
  assert.match(own, /^CREATE ROLE mason_reader3 LOGIN/m);
  assert.match(own, /then: set MASON_DATABASE_URL=postgres:\/\/mason_reader3:<its password>@db\.internal:5432\/shop\?sslmode=require where it is set now \(MASON_DATABASE_URL in \.env\.local\);/);
  assert.match(readOnlyFix(facts(), ask({ urlVariable: null })), /in \.env and write url: \$\{MASON_DATABASE_URL\} in mason\/sources\/shop\.yml;/, "a URL written in the file moves to .env");
  // no table yet: no empty GRANT, the line to add says so
  const empty = readOnlyFix(facts({ relations: [], schemas: [] }), ask({ tables: [] }));
  assert.doesNotMatch(empty, /GRANT SELECT ON {2}|GRANT USAGE ON SCHEMA {2}/);
  assert.match(empty, /^-- and GRANT USAGE ON SCHEMA <schema>, SELECT ON <table> TO mason_reader, for each table you add$/m);
});

test("the way out where a table streams: REPLICATION (rds_replication where that is the way), and the publication Mason would make, made by the owner", async () => {
  const { readOnlyFix } = await roleModule();
  const own = readOnlyFix(facts(), ask({ replicated: ["billing.Invoices"] }));
  assert.match(own, /^CREATE ROLE mason_reader LOGIN REPLICATION PASSWORD '<a new password>';$/m);
  assert.match(own, /^CREATE PUBLICATION mason_reader FOR TABLE billing\."Invoices" WITH \(publish = 'insert, update, delete, truncate'\);/m, "the replicated tables alone");
  assert.match(own, /write url: \$\{MASON_DATABASE_URL\} in mason\/sources\/shop\.yml, publication: mason_reader at its top;/);
  const named = readOnlyFix(facts(), ask({ replicated: ["billing.Invoices"], publication: "app_pub" }));
  assert.doesNotMatch(named, /PUBLICATION/, "a named publication is its owner's, read as it is");
  assert.match(named, /LOGIN REPLICATION/);
  const rds = readOnlyFix(facts({ rdsReplication: true }), ask({ replicated: ["public.orders"], publication: "app_pub" }));
  assert.match(rds, /^CREATE ROLE mason_reader LOGIN PASSWORD/m);
  assert.match(rds, /^GRANT rds_replication TO mason_reader;$/m);
  assert.doesNotMatch(readOnlyFix(facts(), ask()), /REPLICATION|PUBLICATION/, "polled tables need neither");
});

test("the catalog read is ONE statement that reads, under the catalog's search_path: no write, every name a literal, quotes doubled", async () => {
  const { roleFactsSql } = await roleModule();
  const whole = roleFactsSql([{ schema: "public", table: "o'brien" }, { schema: "My Schema", table: "Orders" }]);
  // the guard, as VIEWS_SQL's: no function, operator or table of the role's own schemas stands in for the catalog's
  const GUARD = "SET LOCAL search_path = pg_catalog; ";
  assert.ok(whole.startsWith(GUARD), whole.slice(0, 80));
  const sql = whole.slice(GUARD.length);
  assert.match(sql, /^WITH RECURSIVE /);
  assert.doesNotMatch(sql, /;/, "one statement after the guard");
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|SET)\s+(INTO|ON|TABLE|ROLE|SCHEMA|PUBLICATION|LOCAL|\w+\s*\()/i, "no write or setting, only privilege names asked of has_*_privilege");
  assert.ok(sql.includes(`'[{"schema":"public","table":"o''brien"},{"schema":"My Schema","table":"Orders"}]'::json`), sql.slice(0, 400));
  for (const fn of ["has_table_privilege", "has_any_column_privilege", "has_schema_privilege", "pg_has_role", "pg_inherits", "pg_rewrite", "pg_depend", "pg_relation_is_updatable",
    "confdeltype", "confupdtype", "prosecdef", "has_function_privilege", "pg_trigger", "pg_event_trigger", "pg_aggregate", "typinput", "oprrest", "pg_amproc", "rngcanonical", "conproc", "pg_user_mappings", "has_server_privilege", "MEMBER WITH ADMIN OPTION",
    "pg_execute_server_program", "pg_write_server_files", "pg_read_server_files"]) assert.ok(sql.includes(fn), fn);
  // a membership counts where it gives the privileges or SET ROLE (Postgres 16's options), never merely by being one
  assert.match(sql, /THEN pg_has_role\(me\.oid, p\.oid, 'USAGE'\) OR pg_has_role\(me\.oid, p\.oid, 'SET'\) ELSE pg_has_role\(me\.oid, p\.oid, 'MEMBER'\) END/);
  assert.doesNotMatch(sql, /relacl|nspacl|aclexplode/, "Postgres decides each privilege, never an ACL read by hand");
});

test("a warning or a role it could not tell leaves the doctor ready (exit 0); the usage names every code", async () => {
  const { roleChecks, roleUnknown, ROLE_CODES } = await roleModule();
  const { verdictOf, DOCTOR_USAGE } = await doctorModule();
  const warned = roleChecks(facts({ roles: [{ name: "app", self: true, superuser: true, bypassrls: false }] }), ask());
  assert.deepEqual(verdictOf(warned, null, null), { ready: true, verdict: "Ready: mason init, in your app's folder" });
  const unknown = roleUnknown("permission denied for table pg_class");
  assert.deepEqual(unknown, { name: "role", ok: null, code: "role_unknown", detail: "could not tell whether the user Mason connects as may write to the database: permission denied for table pg_class" });
  assert.equal(verdictOf([unknown], null, null).ready, true);
  for (const code of ROLE_CODES) assert.ok(DOCTOR_USAGE.includes(code), code);
  assert.match(DOCTOR_USAGE, /a warning \(!\) and a check that could not tell \(\?\) are said, and leave it 0/);
});

test("roleAsk reads the sources file: its tables by schema and name, the ones that stream, the publication it names, where its URL is", async () => {
  const { roleAsk } = await doctorModule();
  const src = { name: "shop", file: "/app/mason/sources/shop.yml", kind: "postgres" as const, url: { env: "DATABASE_URL" }, database: null, sync: null,
    publication: { literal: "app_pub" }, publicationName: "app_pub", resolved: "postgres://app:secret@db:5432/shop", from: "DATABASE_URL in .env",
    tables: [{ name: "orders", table: "public.orders", columns: null, exclude: [], key: null, sync: { mode: "replication" as const } },
      { name: "billing.Invoices", table: "billing.Invoices", columns: null, exclude: [], key: null, sync: null }] };
  assert.deepEqual(roleAsk(src as never, "/app", {}), {
    tables: [{ schema: "public", table: "orders" }, { schema: "billing", table: "Invoices" }], replicated: ["public.orders"], publication: "app_pub",
    urlVariable: "DATABASE_URL", urlFrom: "DATABASE_URL in .env", file: "mason/sources/shop.yml", url: "postgres://app:secret@db:5432/shop" });
});
