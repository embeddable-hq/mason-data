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
  return { name, sql: `${schema}.${/^[a-z_][a-z0-9_]*$/.test(table) ? table : `"${table}"`}`, partition: false, entry: name, schemaSql: schema, owner: "admin", owned: false, rowSecurity: false, privileges: [], ...o };
};
const facts = (o: Partial<RoleFacts> = {}): RoleFacts => ({
  user: "app", userSql: "app", databaseSql: "shop",
  roles: [{ name: "app", self: true, superuser: false, bypassrls: false }],
  relations: [rel("public.orders"), rel("billing.Invoices")],
  schemas: [{ name: "billing", sql: "billing", owner: "admin", owned: false, create: [], publicCreate: false },
    { name: "public", sql: "public", owner: "admin", owned: false, create: [], publicCreate: false }],
  missing: [], taken: [], rdsReplication: false, ...o,
});
const ask = (o: Partial<RoleAsk> = {}): RoleAsk => ({
  tables: [{ schema: "public", table: "orders" }, { schema: "billing", table: "Invoices" }], replicated: [], publication: null,
  urlVariable: "DATABASE_URL", urlFrom: "DATABASE_URL in .env", file: "mason/sources/shop.yml", url: "postgres://app:secret@db.internal:5432/shop?sslmode=require", ...o,
});

test("a role that only reads: one line, ok, no code and no way out", async () => {
  const { roleChecks } = await roleModule();
  assert.deepEqual(roleChecks(facts(), ask()), [{ name: "role", ok: true,
    detail: "app only reads: not a superuser, no BYPASSRLS, and it neither owns nor may write to the 2 synced table(s), nor CREATE in their schemas" }]);
  const none = roleChecks(facts({ relations: [], schemas: [], missing: ["public.gone"] }), ask());
  assert.equal(none.length, 1);
  assert.equal(none[0]!.ok, true);
  assert.match(none[0]!.detail, /^app only reads: not a superuser, no BYPASSRLS, and no table is added yet \(the tables are asked once one is\) \(not asked of public\.gone, which the database does not have: mason start says so\)$/);
});

test("a superuser, itself or by a membership it may SET ROLE to: ONE warning, role_superuser, whatever else follows from it", async () => {
  const { roleChecks } = await roleModule();
  const self = roleChecks(facts({ roles: [{ name: "app", self: true, superuser: true, bypassrls: true }], relations: [rel("public.orders", { owned: true })] }), ask());
  assert.deepEqual(self.map((c) => [c.code, c.ok, c.warn]), [["role_superuser", true, true]]);
  assert.equal(self[0]!.detail, "app is a superuser: it may write to, alter or drop anything on this database. " +
    "Mason only reads, so a role that may write lets a Mason bug or a stolen URL change your database: sync as a role that only reads");
  const member = roleChecks(facts({ roles: [{ name: "app", self: true, superuser: false, bypassrls: false }, { name: "admins", self: false, superuser: true, bypassrls: false }] }), ask());
  assert.deepEqual(member.map((c) => c.code), ["role_superuser"]);
  assert.match(member[0]!.detail, /^app is a member of admins, a superuser: it may SET ROLE to it/);
});

test("BYPASSRLS, an owner, a write privilege and CREATE: a warning each, with its code and its route (a member role, PUBLIC, a partition)", async () => {
  const { roleChecks, ROLE_CODES } = await roleModule();
  const f = facts({
    roles: [{ name: "app", self: true, superuser: false, bypassrls: false }, { name: "writers", self: false, superuser: false, bypassrls: true }],
    relations: [
      rel("public.orders", { owned: true, owner: "app" }),
      rel("billing.Invoices", { owned: true, owner: "writers", privileges: [{ role: "app", privileges: ["UPDATE", "INSERT"] }, { role: "writers", privileges: ["UPDATE"] }] }),
      rel("public.events_2026", { partition: true, entry: "public.events", privileges: [{ role: "app", privileges: ["TRIGGER"] }, { role: "PUBLIC", privileges: ["TRIGGER"] }] }),
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
  const detail = (code: string) => checks.find((c) => c.code === code)!.detail.split(". Mason only reads")[0];
  assert.equal(detail("role_bypassrls"), "app has BYPASSRLS (through writers, which it is a member of): row-level security does not apply to it, on any table");
  assert.equal(detail("role_owns_table"), "app owns public.orders and billing.Invoices (through writers, which it is a member of): an owner may write to, alter or drop a table whatever is granted");
  // billing.Invoices is owned: its owner's line says it, the privileges an owner holds are not said again
  assert.equal(detail("role_writes_table"), "app may TRIGGER on public.events_2026 (a partition of public.events) (granted to PUBLIC, which every role is)");
  const notOwned = roleChecks({ ...f, relations: f.relations.map((x) => ({ ...x, owned: false })) }, ask()).find((c) => c.code === "role_writes_table")!;
  assert.match(notOwned.detail, /^app may INSERT, UPDATE on billing\.Invoices \(through writers, which it is a member of\); TRIGGER on public\.events_2026/, "privileges in their one order");
  assert.equal(detail("role_creates_in_schema"), "app may CREATE in schema billing (writers, which owns the schema: it may drop what is in it too); " +
    "CREATE in schema public (granted to PUBLIC, which every role is): it may make tables and functions beside the synced ones");
  // PUBLIC's privileges are every role's, the new one's too: the way out revokes them
  const fix = checks[0]!.fix!;
  assert.match(fix, /^REVOKE CREATE ON SCHEMA public FROM PUBLIC;/m);
  assert.match(fix, /^REVOKE TRIGGER ON public\.events_2026 FROM PUBLIC;/m);
  assert.equal(new Set(checks.map((c) => c.fix)).size, 1, "one way out, shared");
});

test("the way out: a role that may LOGIN and SELECT the synced tables alone, its URL in a variable of Mason's own", async () => {
  const { readOnlyFix } = await roleModule();
  assert.equal(readOnlyFix(facts({ relations: [rel("public.orders", { rowSecurity: true }), rel("billing.Invoices"), rel("public.orders_1", { partition: true, entry: "public.orders" })] }), ask()), [
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

test("the catalog read is ONE statement that reads: no write, every name a literal, quotes doubled", async () => {
  const { roleFactsSql } = await roleModule();
  const sql = roleFactsSql([{ schema: "public", table: "o'brien" }, { schema: "My Schema", table: "Orders" }]);
  assert.match(sql, /^WITH /);
  assert.doesNotMatch(sql, /;/, "one statement");
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|SET)\s+(INTO|ON|TABLE|ROLE|SCHEMA|PUBLICATION|LOCAL|\w+\s*\()/i, "no write or setting, only privilege names asked of has_*_privilege");
  assert.ok(sql.includes(`'[{"schema":"public","table":"o''brien"},{"schema":"My Schema","table":"Orders"}]'::json`), sql.slice(0, 400));
  for (const fn of ["has_table_privilege", "has_any_column_privilege", "has_schema_privilege", "pg_has_role", "pg_partition_tree"]) assert.ok(sql.includes(fn), fn);
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
  assert.match(DOCTOR_USAGE, /checks: \[\{ name, ok, detail, warn, code, fix \}\]/);
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
