/**
 * `mason doctor`'s check of the user Mason connects as (src/cli/source-role.ts, issue 524), against a real Postgres: a
 * role that only reads is said so; a table's owner, a role that may UPDATE through a group it is a member of (NOINHERIT
 * too, since SET ROLE reaches it), a partition it may DELETE from, a column it may INSERT into, and a superuser are each
 * warned of with their code; so are a write through an updatable view over a view of a synced table and an INSERT into its
 * INHERITS child (PR 572's review), while a view that takes no write, and a Postgres 16 membership that neither gives the
 * group's privileges nor may SET ROLE to it, are not. All are warnings that leave the doctor's exit 0; and the way out the doctor prints, run as it
 * is, makes a role the doctor then says only reads. Every privilege is asked of Postgres, never tried.
 *
 * Needs IT_POSTGRES_URL (a superuser: it creates roles), psql on PATH. It writes only inside a database it creates,
 * `it_role_<random>`, and roles named after it, and drops them all at the end.
 */
import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_role_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const urlAs = (user: string | null, password = "pw"): string => {
  const u = new URL(adminUrl!);
  u.pathname = `/${tag}`;
  if (user !== null) { u.username = user; u.password = password; }
  return u.toString();
};
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-role-")));
const root = path.join(dir, "app"), home = path.join(dir, "home");
const ROLES = ["reader", "owner", "writers", "member", "super", "viewer", "unset", "shadow"].map((r) => `${tag}_${r}`);
const made: string[] = [];   // the roles the way out made

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!adminUrl) return;
  // the database first: every grant and object of the roles is in it, so they drop with nothing left to own
  psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  for (const r of [...made, ...ROLES]) psql(adminUrl, `DROP ROLE IF EXISTS "${r}"`);
});

interface DoctorCheck { name: string; ok: boolean | null; detail: string; warn?: boolean; code?: string; fix?: string }
interface Ran { status: number | null; stdout: string; stderr: string }
function doctor(user: string, password = "pw", json = true): Ran & { checks: DoctorCheck[] } {
  fs.writeFileSync(path.join(root, ".env"), `DATABASE_URL=${urlAs(user, password)}\n`);
  const r = spawnSync(process.execPath, [MAIN, "doctor", ...(json ? ["--json"] : [])], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8", timeout: 120_000 });
  let checks: DoctorCheck[] = [];
  if (json) {
    try { checks = (JSON.parse(r.stdout) as { checks: DoctorCheck[] }).checks; } catch { throw new Error(`mason doctor --json as ${user}: not JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`); }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, checks };
}
const roleLines = (r: { checks: DoctorCheck[] }): DoctorCheck[] => r.checks.filter((c) => c.name === "role");

const [reader, owner, writers, member, superuser, viewer, unset, shadow] = ROLES as [string, string, string, string, string, string, string, string];
let db = "", v16 = false;

before(() => {
  if (!adminUrl) return;
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  db = urlAs(null);
  psql(db, "CREATE SCHEMA billing; " +
    "CREATE TABLE public.orders (id int PRIMARY KEY, amount int); ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; " +
    'CREATE TABLE billing."Line Items" (id int PRIMARY KEY, sku text); ' +
    "CREATE TABLE public.events (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at); " +
    "CREATE TABLE public.events_2026 PARTITION OF public.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01'); " +
    // a child by INHERITS: a SELECT on the parent reads its rows, so Mason syncs them as the parent's
    "CREATE TABLE public.ledger (id int PRIMARY KEY, amount int); CREATE TABLE public.ledger_2026 () INHERITS (public.ledger); " +
    // an updatable view over an updatable view over a synced table, and one that takes no write
    "CREATE VIEW public.orders_v AS SELECT id, amount FROM public.orders; CREATE VIEW public.orders_vv AS SELECT id, amount FROM public.orders_v; " +
    "CREATE VIEW public.orders_sum AS SELECT sum(amount) AS total FROM public.orders; " +
    "INSERT INTO public.orders VALUES (1, 10), (2, 20); " +
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC");   // Postgres 15's default, on any server the test meets
  const readAll = (r: string) => `GRANT USAGE ON SCHEMA billing TO "${r}"; GRANT SELECT ON public.orders, billing."Line Items", public.events, public.ledger TO "${r}"`;
  psql(db, `CREATE ROLE "${reader}" LOGIN PASSWORD 'pw'; ${readAll(reader)}; ` +
    `CREATE ROLE "${owner}" LOGIN PASSWORD 'pw'; ${readAll(owner)}; ALTER TABLE billing."Line Items" OWNER TO "${owner}"; ` +
    `CREATE ROLE "${writers}" NOLOGIN; GRANT UPDATE ON public.orders TO "${writers}"; ` +
    // NOINHERIT: it holds none of the group's privileges until it SETs ROLE, which it may at any time
    `CREATE ROLE "${member}" LOGIN NOINHERIT PASSWORD 'pw' IN ROLE "${writers}"; ${readAll(member)}; ` +
    `GRANT DELETE ON public.events_2026 TO "${member}"; GRANT INSERT (sku) ON billing."Line Items" TO "${member}"; ` +
    `CREATE ROLE "${superuser}" LOGIN SUPERUSER PASSWORD 'pw'; ` +
    `CREATE ROLE "${viewer}" LOGIN PASSWORD 'pw'; ${readAll(viewer)}; GRANT UPDATE ON public.orders_vv, public.orders_sum TO "${viewer}"; GRANT SELECT ON public.orders_vv TO "${viewer}"; GRANT INSERT ON public.ledger_2026 TO "${viewer}"; ` +
    `CREATE ROLE "${unset}" LOGIN PASSWORD 'pw'; ${readAll(unset)}; ` +
    // a function of its own search_path, ahead of the catalog's, that would say it may write nothing
    `CREATE ROLE "${shadow}" LOGIN PASSWORD 'pw'; ${readAll(shadow)}; GRANT UPDATE ON public.ledger TO "${shadow}"; CREATE SCHEMA shadowing; GRANT USAGE ON SCHEMA shadowing TO "${shadow}"; ` +
    "CREATE FUNCTION shadowing.has_any_column_privilege(name, oid, text) RETURNS boolean LANGUAGE sql AS 'SELECT false'; " +
    `ALTER ROLE "${shadow}" IN DATABASE ${tag} SET search_path = shadowing, pg_catalog`);
  // Postgres 16's membership options: one that neither gives the group's privileges nor may SET ROLE to it holds nothing
  v16 = Number(psql(db, "SHOW server_version_num")) >= 160000;
  if (v16) psql(db, `GRANT "${writers}" TO "${unset}" WITH INHERIT FALSE, SET FALSE`);

  // a project naming the three tables, one of them streamed, Mason's own publication
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const init = spawnSync(process.execPath, [MAIN, "init", urlAs(reader), "--name", "roles"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, `mason init:\n${init.stdout}${init.stderr}`);
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders: {}\n  billing.Line Items: {}\n  ledger: {}\n  events:\n    sync: replication\n");
});

test("mason doctor says whether the user Mason connects as could write: a reader, an owner, UPDATE through a group, a partition, a column, a superuser; each a warning, exit 0",
  { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 300_000 }, () => {
    // a role that only reads: said so, exit 0
    const read = doctor(reader);
    assert.equal(read.status, 0, read.stdout);
    assert.deepEqual(roleLines(read), [{ name: "role", ok: true, detail: `${reader} only reads: not a superuser, no BYPASSRLS, and it neither owns nor may write to the 4 synced table(s) — ` +
      "their partitions, inheritance children and the views and rules that write them included — nor CREATE in their schemas (what a function it may call writes is not asked)" }]);
    // the owner of a synced table
    const owns = doctor(owner);
    assert.equal(owns.status, 0, `a warning leaves the exit 0:\n${owns.stdout}`);
    assert.deepEqual(roleLines(owns).map((c) => [c.code, c.ok, c.warn]), [["role_owns_table", true, true]]);
    assert.match(roleLines(owns)[0]!.detail, new RegExp(`^${owner} owns billing\\.Line Items: an owner may write to, alter or drop a table whatever is granted\\. `));

    // UPDATE through a group (NOINHERIT), DELETE on a partition, INSERT on one column
    const member_ = doctor(member);
    assert.equal(member_.status, 0, member_.stdout);
    const writes = roleLines(member_);
    assert.deepEqual(writes.map((c) => c.code), ["role_writes_table"], JSON.stringify(writes));
    assert.equal(writes[0]!.detail.split(". Mason only reads")[0],
      `${member} may INSERT on billing.Line Items; UPDATE on public.orders (through ${writers}, which it is a member of); DELETE on public.events_2026 (a partition of public.events)`);

    // a superuser: one warning, whatever follows from it
    const sup = doctor(superuser);
    assert.equal(sup.status, 0, sup.stdout);
    assert.deepEqual(roleLines(sup).map((c) => c.code), ["role_superuser"]);

    // as a person: the warning marked, the way out once under it
    const text = doctor(member, "pw", false);
    assert.equal(text.status, 0, text.stdout);
    assert.match(text.stdout, /^ {2}! +role +\S+ may INSERT on billing\.Line Items;/m);
    assert.equal(text.stdout.split("CREATE ROLE ").length, 2, `the way out, once:\n${text.stdout}`);
  });

test("a write through another relation is warned of: an updatable view over a view of a synced table, an INSERT into its INHERITS child; a view that takes no write is not",
  { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 300_000 }, () => {
    // through a view over a view of a synced table, and into its INHERITS child; never through a view that takes no write
    const views = roleLines(doctor(viewer));
    assert.deepEqual(views.map((c) => c.code), ["role_writes_table"], JSON.stringify(views));
    assert.equal(views[0]!.detail.split(". Mason only reads")[0], `${viewer} may INSERT on public.ledger_2026 (a child of public.ledger, by INHERITS: its rows are public.ledger's); ` +
      "UPDATE on public.orders_vv (a view that writes public.orders)");
    // what the doctor says, Postgres does: both write the synced rows (this test's own database)
    psql(urlAs(viewer), "UPDATE public.orders_vv SET amount = amount + 1 WHERE id = 1; INSERT INTO public.ledger_2026 VALUES (7, 70)");
    assert.equal(psql(db, "SELECT amount FROM public.orders WHERE id = 1"), "11");
    assert.equal(psql(db, "SELECT count(*) FROM public.ledger"), "1");
  });

test("the catalog's own functions decide, whatever the role's search_path puts ahead of them",
  { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 300_000 }, () => {
    // the catalog's functions, whatever the role's search_path puts ahead of them
    const shadowed = roleLines(doctor(shadow));
    assert.deepEqual(shadowed.map((c) => c.code), ["role_writes_table"], JSON.stringify(shadowed));
    assert.match(shadowed[0]!.detail, new RegExp(`^${shadow} may UPDATE on public\\.ledger\\. `));
  });

test("Postgres 16's membership options: one with neither INHERIT nor SET gives the role nothing of the group's",
  { skip: !adminUrl ? "IT_POSTGRES_URL is not set" : false, timeout: 300_000 }, (t) => {
    if (!v16) { t.skip("the server is older than Postgres 16, where every membership may SET ROLE"); return; }
    assert.deepEqual(roleLines(doctor(unset)).map((c) => [c.ok, c.code]), [[true, undefined]], "a membership with neither INHERIT nor SET gives nothing");
  });

test("the way out the doctor prints, run as it is, makes a role the doctor then says only reads, and that reads every row",
  { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 300_000 }, () => {
    const writes = roleLines(doctor(member));
    // THE WAY OUT, run as it is printed (its password filled in): the role it makes only reads
    const fix = writes[0]!.fix!;
    const statements = fix.split("\n").filter((l) => /;(\s+--.*)?$/.test(l) && !l.startsWith("--")).map((l) => l.replace("<a new password>", "fixed-pw"));
    const role = /^CREATE ROLE (\S+) LOGIN REPLICATION PASSWORD/m.exec(fix)?.[1];
    assert.ok(role, `the way out makes a role, with REPLICATION for the streamed table:\n${fix}`);
    assert.match(fix, /^CREATE PUBLICATION \S+ FOR TABLE public\.events WITH \(publish = 'insert, update, delete, truncate'\);/m, "the streamed table's publication, made by the owner");
    assert.match(fix, /^CREATE POLICY \S+ ON public\.orders FOR SELECT TO \S+ USING \(true\);/m, "a policy for the table with row-level security");
    made.push(role);
    psql(db, statements.join("\n"));
    const fixed = doctor(role, "fixed-pw");
    assert.equal(fixed.status, 0, fixed.stdout);
    assert.deepEqual(roleLines(fixed).map((c) => [c.ok, c.code]), [[true, undefined]], JSON.stringify(roleLines(fixed)));
    // and it reads every row of the table with row-level security
    assert.equal(psql(urlAs(role, "fixed-pw"), "SELECT count(*) FROM public.orders"), "2");
    assert.equal(psql(urlAs(role, "fixed-pw"), 'SELECT count(*) FROM billing."Line Items"'), "0");
  });
