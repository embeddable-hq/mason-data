/**
 * `mason doctor`'s check of the user Mason connects as (src/cli/source-role.ts, issue 524), against a real Postgres: a
 * role that only reads is said so; a table's owner, a role that may UPDATE through a group it is a member of (NOINHERIT
 * too, since SET ROLE reaches it), a partition it may DELETE from, a column it may INSERT into, and a superuser are each
 * warned of with their code; so are a write through an updatable view over a view of a synced table and an INSERT into its
 * INHERITS child (PR 572's review), while a view that takes no write, and a Postgres 16 membership that neither gives the
 * group's privileges nor may SET ROLE to it, are not. All are warnings that leave the doctor's exit 0; and the way out the doctor prints, run as it
 * is, makes a role the doctor then says only reads. Every privilege is asked of Postgres, never tried.
 *
 * THE CLASS (PR 572's review: every way Postgres lets a role change a synced table's rows without a privilege on it),
 * each confirmed by a write that lands: a foreign key's ON DELETE and ON UPDATE CASCADE (and a chain of two), an
 * INHERITS grandparent, a SECURITY DEFINER function it may call, a trigger calling one on a table it may write, an event
 * trigger calling one, an aggregate calling one, a foreign table back to this database, ADMIN OPTION on a writer; and
 * a server role, shown reaching the server's files. TRUNCATE … CASCADE is no route: Postgres refuses it.
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
const ROLES = ["reader", "owner", "writers", "member", "super", "viewer", "unset", "shadow",
  "fkdel", "fkupd", "fktrunc", "fkchain", "parent", "definer", "trigger", "fdw", "admin", "server", "appowner", "appweb"].map((r) => `${tag}_${r}`);
/** a role of THE CLASS's tests, by its short name */
const rv = (name: string): string => `${tag}_${name}`;
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
    // a foreign key whose actions write a synced table, through a chain of two
    "CREATE TABLE public.orgs (id int PRIMARY KEY); CREATE TABLE public.accounts (id int PRIMARY KEY, org_id int REFERENCES public.orgs ON DELETE CASCADE); " +
    "CREATE TABLE public.entries (id int PRIMARY KEY, account_id int REFERENCES public.accounts ON DELETE CASCADE ON UPDATE CASCADE); " +
    "INSERT INTO public.orgs VALUES (1), (2); INSERT INTO public.accounts VALUES (1, 1), (2, 1), (3, 2); INSERT INTO public.entries VALUES (1, 1), (2, 2), (3, 3); " +
    // a synced INHERITS child two levels under the table a role may UPDATE
    "CREATE TABLE public.notes_root (id int, body text); CREATE TABLE public.notes_base () INHERITS (public.notes_root); " +
    "CREATE TABLE public.notes (PRIMARY KEY (id)) INHERITS (public.notes_base); INSERT INTO public.notes VALUES (1, 'kept'); " +
    // SECURITY DEFINER code owned by the test's superuser: a function, and a trigger on a table no synced one is
    "CREATE FUNCTION public.bump_orders() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'UPDATE public.orders SET amount = amount + 1000 WHERE id = 2'; " +
    "REVOKE EXECUTE ON FUNCTION public.bump_orders() FROM PUBLIC; " +
    "CREATE TABLE public.inbox (id int, amount int); " +
    "CREATE FUNCTION public.inbox_to_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN INSERT INTO public.ledger VALUES (NEW.id, NEW.amount); RETURN NEW; END'; " +
    "CREATE TRIGGER inbox_to_ledger AFTER INSERT ON public.inbox FOR EACH ROW EXECUTE FUNCTION public.inbox_to_ledger(); " +
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC");   // Postgres 15's default, on any server the test meets
  const readAll = (r: string) => `GRANT USAGE ON SCHEMA billing TO "${r}"; GRANT SELECT ON public.orders, billing."Line Items", public.events, public.ledger, public.entries, public.notes TO "${r}"`;
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
  // THE CLASS's roles: each holds SELECT on the synced tables and one route
  const routes: Record<string, string> = {
    fkdel: "GRANT SELECT, DELETE ON public.accounts TO %", fkupd: "GRANT SELECT, UPDATE ON public.accounts TO %", fktrunc: "GRANT TRUNCATE ON public.accounts TO %",
    fkchain: "GRANT SELECT, DELETE ON public.orgs TO %", parent: "GRANT UPDATE ON public.notes_root TO %", definer: "GRANT EXECUTE ON FUNCTION public.bump_orders() TO %",
    trigger: "GRANT INSERT ON public.inbox TO %", fdw: "SELECT 1", admin: "SELECT 1", server: "GRANT pg_read_server_files TO %",
  };
  psql(db, Object.entries(routes).map(([name, grant]) => `CREATE ROLE "${rv(name)}" LOGIN PASSWORD 'pw'; ${readAll(rv(name))}; ${grant.replace("%", `"${rv(name)}"`)}`).join("; "));
  // Postgres 16's membership options: one that neither gives the group's privileges nor may SET ROLE to it holds nothing
  v16 = Number(psql(db, "SHOW server_version_num")) >= 160000;
  if (v16) psql(db, `GRANT "${writers}" TO "${unset}" WITH INHERIT FALSE, SET FALSE`);

  // a project naming the three tables, one of them streamed, Mason's own publication
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const init = spawnSync(process.execPath, [MAIN, "init", urlAs(reader), "--name", "roles"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, `mason init:\n${init.stdout}${init.stderr}`);
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders: {}\n  billing.Line Items: {}\n  ledger: {}\n  entries: {}\n  notes: {}\n  events:\n    sync: replication\n");
});

test("mason doctor says whether the user Mason connects as could write: a reader, an owner, UPDATE through a group, a partition, a column, a superuser; each a warning, exit 0",
  { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 300_000 }, () => {
    // a role that only reads: said so, exit 0
    const read = doctor(reader);
    assert.equal(read.status, 0, read.stdout);
    assert.deepEqual(roleLines(read), [{ name: "role", ok: true, detail: `${reader} only reads: not a superuser, no BYPASSRLS, no ADMIN OPTION, no server roles, no foreign server, ` +
      "and it neither owns nor may write to the 6 synced table(s) — nor to their partitions, inheritance children or parents, " +
      "the tables their foreign keys act on, or the views and rules that write them — nor CREATE in their schemas, and it reaches no SECURITY DEFINER code whose owner may write" }]);
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

// THE CLASS: every way Postgres lets a role change a synced table's rows without a privilege on it, each said by the
// doctor and then done by Postgres (in this test's own database), or refused by both
const said = (name: string): DoctorCheck[] => roleLines(doctor(rv(name)));
const head = (c: DoctorCheck | undefined): string => (c?.detail ?? "").split(". Mason only reads")[0]!;
const skipNoDb = { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 300_000 };

test("THE CLASS: a foreign key's ON DELETE and ON UPDATE CASCADE write the synced rows, through a chain of two; TRUNCATE … CASCADE is refused, and no route", skipNoDb, () => {
  const trunc = said("fktrunc");
  assert.deepEqual(trunc.map((c) => [c.ok, c.code]), [[true, undefined]], JSON.stringify(trunc));
  assert.throws(() => psql(urlAs(rv("fktrunc")), "TRUNCATE public.accounts CASCADE"), /permission denied for table entries/, "Postgres asks TRUNCATE on every table it cascades to");
  assert.equal(head(said("fkupd")[0]), `${rv("fkupd")} may UPDATE on public.accounts (a foreign key's ON DELETE or ON UPDATE action carries its changes to public.entries, as its owner)`);
  psql(urlAs(rv("fkupd")), "UPDATE public.accounts SET id = 10 WHERE id = 1");
  assert.equal(psql(db, "SELECT account_id FROM public.entries WHERE id = 1"), "10", "the synced column rewritten");
  assert.equal(head(said("fkdel")[0]), `${rv("fkdel")} may DELETE on public.accounts (a foreign key's ON DELETE or ON UPDATE action carries its changes to public.entries, as its owner)`);
  psql(urlAs(rv("fkdel")), "DELETE FROM public.accounts WHERE id = 2");
  assert.equal(psql(db, "SELECT count(*) FROM public.entries WHERE id = 2"), "0", "the synced row deleted");
  // orgs → accounts → entries: a DELETE on orgs reaches entries
  assert.equal(head(said("fkchain")[0]), `${rv("fkchain")} may DELETE on public.orgs (a foreign key's ON DELETE or ON UPDATE action carries its changes to public.entries, as its owner)`);
  psql(urlAs(rv("fkchain")), "DELETE FROM public.orgs WHERE id = 2");
  assert.equal(psql(db, "SELECT count(*) FROM public.entries WHERE id = 3"), "0", "deleted two foreign keys away");
});

test("THE CLASS: an UPDATE of an INHERITS grandparent writes the synced child's rows", skipNoDb, () => {
  assert.equal(head(said("parent")[0]), `${rv("parent")} may UPDATE on public.notes_root (an INHERITS parent of public.notes: an UPDATE, DELETE or TRUNCATE of it reaches public.notes's rows)`);
  psql(urlAs(rv("parent")), "UPDATE public.notes_root SET body = 'changed'");
  assert.equal(psql(db, "SELECT body FROM public.notes WHERE id = 1"), "changed");
});

test("THE CLASS: SECURITY DEFINER code whose owner may write: a function it may call, a trigger on a table it may write", skipNoDb, () => {
  const definer = said("definer");
  assert.deepEqual(definer.map((c) => c.code), ["role_may_run_definer_code"], JSON.stringify(definer));
  assert.match(head(definer[0]), / may not write the synced tables itself: .* But it may run 1 SECURITY DEFINER function\(s\) of roles that may write the synced tables — public\.bump_orders\(\) runs as \S+, a superuser: it may call it\. What they write is not known/);
  psql(urlAs(rv("definer")), "SELECT public.bump_orders()");
  assert.equal(psql(db, "SELECT amount FROM public.orders WHERE id = 2"), "1020");
  const trigger = said("trigger");
  assert.deepEqual(trigger.map((c) => c.code), ["role_may_run_definer_code"], JSON.stringify(trigger));
  assert.match(head(trigger[0]), /— public\.inbox_to_ledger\(\) runs as \S+, a superuser: a trigger on public\.inbox, which it may write, calls it\. /);
  psql(urlAs(rv("trigger")), "INSERT INTO public.inbox VALUES (900, 9)");
  assert.equal(psql(db, "SELECT amount FROM public.ledger WHERE id = 900"), "9");
});

test("THE CLASS: an event trigger's and an aggregate's SECURITY DEFINER function reach every role, a reader too", skipNoDb, () => {
  psql(db, "CREATE FUNCTION public.on_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN INSERT INTO public.ledger VALUES (901, 1) ON CONFLICT DO NOTHING; END'; " +
    "CREATE EVENT TRIGGER on_ddl ON ddl_command_start EXECUTE FUNCTION public.on_ddl()");
  try {
    const event = roleLines(doctor(reader));
    assert.deepEqual(event.map((c) => c.code), ["role_may_run_definer_code"], JSON.stringify(event));
    assert.match(head(event[0]), /— public\.on_ddl\(\) runs as \S+, a superuser: an event trigger calls it on any DDL, even one refused, never asking EXECUTE\. /);
    assert.equal(event[0]!.fix, undefined, "listed to review, never fixed: no statement for this role alone decides it");
    psql(urlAs(reader), "CREATE TEMP TABLE scratch (x int)");
    assert.equal(psql(db, "SELECT count(*) FROM public.ledger WHERE id = 901"), "1", "a reader's own temporary table wrote a synced row");
  } finally { psql(db, "DROP EVENT TRIGGER on_ddl; DROP FUNCTION public.on_ddl()"); }
  psql(db, "CREATE FUNCTION public.sneaky_step(int, int) RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN INSERT INTO public.ledger VALUES (902, 2) ON CONFLICT DO NOTHING; RETURN $1 + $2; END'; " +
    "REVOKE EXECUTE ON FUNCTION public.sneaky_step(int, int) FROM PUBLIC; CREATE AGGREGATE public.sneaky(int) (SFUNC = public.sneaky_step, STYPE = int, INITCOND = '0')");
  try {
    const agg = roleLines(doctor(reader));
    assert.deepEqual(agg.map((c) => c.code), ["role_may_run_definer_code"], JSON.stringify(agg));
    assert.match(head(agg[0]), /— public\.sneaky_step\(integer, integer\) runs as \S+, a superuser: Postgres calls it for an aggregate, a type, an operator or the like, never asking EXECUTE\. /);
    psql(urlAs(reader), "SELECT public.sneaky(x) FROM (VALUES (1)) AS v(x)");
    assert.equal(psql(db, "SELECT count(*) FROM public.ledger WHERE id = 902"), "1", "an aggregate anyone may call ran it as its owner, EXECUTE revoked");
  } finally { psql(db, "DROP AGGREGATE public.sneaky(int); DROP FUNCTION public.sneaky_step(int, int)"); }
});

test("THE CLASS: a foreign table back to this database writes the synced rows as the mapping's user", skipNoDb, (t) => {
  if (psql(db, "SELECT count(*) FROM pg_available_extensions WHERE name = 'postgres_fdw'") !== "1") { t.skip("postgres_fdw is not installed on this server"); return; }
  const admin = new URL(adminUrl!);
  psql(db, `CREATE EXTENSION postgres_fdw; CREATE SERVER loopback FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1', port '${psql(db, "SHOW port")}', dbname '${tag}'); ` +
    `CREATE USER MAPPING FOR "${rv("fdw")}" SERVER loopback OPTIONS (user '${decodeURIComponent(admin.username)}', password '${decodeURIComponent(admin.password).replace(/'/g, "''")}', password_required 'false'); ` +
    `CREATE FOREIGN TABLE public.remote_ledger (id int, amount int) SERVER loopback OPTIONS (schema_name 'public', table_name 'ledger'); GRANT INSERT ON public.remote_ledger TO "${rv("fdw")}"`);
  const fdw = said("fdw");
  assert.deepEqual(fdw.map((c) => c.code), ["role_reaches_foreign_server"], JSON.stringify(fdw));
  assert.equal(head(fdw[0]), `${rv("fdw")} may write the foreign table(s) public.remote_ledger: what it sends there runs as the mapping's user, and the server may be this very database`);
  psql(urlAs(rv("fdw")), "INSERT INTO public.remote_ledger VALUES (903, 3)");
  assert.equal(psql(db, "SELECT amount FROM public.ledger WHERE id = 903"), "3");
});

test("THE CLASS: ADMIN OPTION on a writer lets the role grant itself the writer's privileges; a server role reaches the server's files", skipNoDb, (t) => {
  const server = said("server");
  assert.deepEqual(server.map((c) => c.code), ["role_may_become_another"], JSON.stringify(server));
  assert.equal(head(server[0]), `${rv("server")} holds pg_read_server_files: the server's programs or files, as its operating-system user`);
  assert.match(psql(urlAs(rv("server")), "CREATE TEMP TABLE seen (line text); COPY seen FROM 'PG_VERSION'; SELECT line FROM seen"), /^\d+$/, "it reads the server's own files");
  if (!v16) { t.skip("the server is older than Postgres 16, where ADMIN OPTION cannot be held without the membership's privileges"); return; }
  psql(db, `GRANT "${writers}" TO "${rv("admin")}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
  const admin = said("admin");
  assert.deepEqual(admin.map((c) => c.code), ["role_may_become_another"], JSON.stringify(admin));
  assert.equal(head(admin[0]), `${rv("admin")} has ADMIN OPTION on ${writers}`);
  // the writer's UPDATE of a synced table without row-level security, for the write to land (no WHERE: it may not SELECT)
  psql(db, `GRANT UPDATE ON public.ledger TO "${writers}"`);
  try {
    psql(urlAs(rv("admin")), `GRANT "${writers}" TO "${rv("admin")}" WITH SET TRUE; SET ROLE "${writers}"; UPDATE public.ledger SET amount = 6`);
    assert.equal(psql(db, "SELECT amount FROM public.ledger WHERE id = 900"), "6");
  } finally { psql(db, `REVOKE "${writers}" FROM "${rv("admin")}" CASCADE; REVOKE UPDATE ON public.ledger FROM "${writers}"`); }
});

test("a typical application's SECURITY DEFINER code (a policy's, a view's, a sequence's, an audit trigger's): the way out's reader writes nothing, the code is listed to review, and the application still works", skipNoDb, () => {
  const [appOwner, appWeb] = [rv("appowner"), rv("appweb")];
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  const before = fs.readFileSync(file, "utf8");
  psql(db, `CREATE ROLE "${appOwner}" NOLOGIN; CREATE ROLE "${appWeb}" LOGIN PASSWORD 'pw'; GRANT CREATE, USAGE ON SCHEMA public TO "${appOwner}"; SET ROLE "${appOwner}"; ` +
    "CREATE TABLE public.customers (id int PRIMARY KEY, tenant text NOT NULL, cents int); CREATE TABLE public.audit_log (at timestamptz DEFAULT now(), what text); " +
    "CREATE SEQUENCE public.order_numbers; " +
    "CREATE FUNCTION public.current_tenant() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT current_setting('app.tenant', true)$$; " +
    "CREATE FUNCTION public.next_order_number() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$SELECT nextval('public.order_numbers')$$; " +
    "CREATE FUNCTION public.fmt_money(int) RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER AS $$SELECT to_char($1 / 100.0, 'FM999990.00')$$; " +
    "CREATE FUNCTION public.audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN INSERT INTO public.audit_log (what) VALUES (TG_OP); RETURN NEW; END$$; " +
    "CREATE TRIGGER customers_audit AFTER INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public.audit(); " +
    "ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_rows ON public.customers USING (tenant = public.current_tenant()); " +
    "CREATE VIEW public.customer_money AS SELECT id, public.fmt_money(cents) AS money FROM public.customers; " +
    `GRANT SELECT, INSERT ON public.customers TO "${appWeb}"; GRANT SELECT ON public.customer_money TO "${appWeb}"; RESET ROLE; ` +
    `INSERT INTO public.customers VALUES (1, 't1', 1250), (2, 't2', 99)`);
  try {
    fs.writeFileSync(file, `${before.trimEnd()}\n  customers: {}\n`.replace("\n  events:\n    sync: replication\n  customers: {}\n", "\n  customers: {}\n  events:\n    sync: replication\n"));
    // Mason connected as the application's own role: it writes, and its definer code is listed after
    const asApp = roleLines(doctor(appWeb));
    assert.deepEqual(asApp.map((c) => c.code), ["role_writes_table", "role_may_run_definer_code"], JSON.stringify(asApp));
    const fix = asApp[0]!.fix!;
    assert.doesNotMatch(fix, /REVOKE|ALTER FUNCTION/, "the way out changes no role's privileges but the new one's");
    assert.match(fix, /^-- the new role may still run public\.current_tenant\(\), public\.fmt_money\(integer\) and public\.next_order_number\(\), as every role may \(SECURITY DEFINER\): mason doctor lists them to review$/m);
    // THE WAY OUT, run as printed
    const role = /^CREATE ROLE (\S+) LOGIN/m.exec(fix)?.[1];
    assert.ok(role, fix);
    made.push(role);
    psql(db, fix.split("\n").filter((l) => /;(\s+--.*)?$/.test(l) && !l.startsWith("--")).map((l) => l.replace("<a new password>", "fixed-pw")).join("\n"));
    const reader_ = doctor(role, "fixed-pw");
    assert.equal(reader_.status, 0, reader_.stdout);
    const lines = roleLines(reader_);
    assert.deepEqual(lines.map((c) => [c.code, c.fix]), [["role_may_run_definer_code", undefined]], `no write warning, only the listing:\n${JSON.stringify(lines)}`);
    assert.match(lines[0]!.detail, new RegExp(`^${role} may not write the synced tables itself: .* But it may run 3 SECURITY DEFINER function\\(s\\) of roles that may write the synced tables — ` +
      `public\\.current_tenant\\(\\) runs as ${appOwner}, which may write the synced tables: every role may call it \\(PUBLIC's EXECUTE\\); ` +
      `public\\.fmt_money\\(integer\\) runs as ${appOwner}, .*; public\\.next_order_number\\(\\) runs as ${appOwner}, .*\\. What they write is not known`));
    assert.doesNotMatch(lines[0]!.detail, /public\.audit\(\)/, "an audit trigger on a table it may not write never reaches it");
    // the application's own role works as before: its policy's function, its view's, its trigger's
    assert.equal(psql(urlAs(appWeb), "SET app.tenant = 't1'; SELECT count(*) FROM public.customers"), "1");
    assert.equal(psql(urlAs(appWeb), "SELECT money FROM public.customer_money WHERE id = 1"), "12.50");
    psql(urlAs(appWeb), "SET app.tenant = 't1'; INSERT INTO public.customers VALUES (3, 't1', 5)");
    assert.equal(psql(db, "SELECT count(*) FROM public.audit_log"), "3", "its audit trigger ran: the setup's two rows and its one");
    assert.equal(psql(urlAs(role, "fixed-pw"), "SELECT count(*) FROM public.customers"), "3", "the reader reads every row, through its own policy");
  } finally {
    fs.writeFileSync(file, before);
    psql(db, "DROP VIEW public.customer_money; DROP TABLE public.customers, public.audit_log; DROP SEQUENCE public.order_numbers; " +
      "DROP FUNCTION public.current_tenant(), public.next_order_number(), public.fmt_money(int), public.audit(); " +
      `REVOKE CREATE, USAGE ON SCHEMA public FROM "${appOwner}"`);
  }
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
