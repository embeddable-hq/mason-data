/**
 * `mason serve --check` against a real Postgres (src/cli/source-check.ts, issue 779): every problem a deploy the
 * database cannot serve has, on one answer — a missing table, one on a schema the user has no USAGE on, row-level
 * security that hides every row, a table with no primary key, a user without REPLICATION, a named publication lacking a
 * table, and one that does not exist — then, each fixed on the database, the same files answered "can serve". Nothing is
 * written to the project or the data folder, and the database is only read (its slots and publications as they were).
 * Needs IT_POSTGRES_URL with wal_level=logical; it creates a database and a role of its own and drops them.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_check_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const role = `${tag}_reader`;
const password = `pw_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const urlAs = (user: string | null, db: string): string => {
  const u = new URL(adminUrl!);
  u.pathname = `/${db}`;
  if (user !== null) { u.username = user; u.password = password; }
  return u.toString();
};
const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

after(() => {
  if (!adminUrl) return;
  if (psql(adminUrl, `SELECT count(*) FROM pg_database WHERE datname = '${tag}'`) === "1") psql(adminUrl, `DROP DATABASE "${tag}" WITH (FORCE)`);
  if (psql(adminUrl, `SELECT count(*) FROM pg_roles WHERE rolname = '${role}'`) === "1") psql(adminUrl, `DROP ROLE "${role}"`);
});

interface Answer { ok?: boolean; tables?: number; replicated?: number; error?: { code: string; message: string }; problems: Array<{ code: string; table: string | null; message: string; fix: string; sql: string | null }> }

test("mason serve --check names every problem the database has with the project, each with its fix, and passes once each is fixed, writing nothing", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, () => {
  psql(adminUrl!, `CREATE DATABASE "${tag}"`);
  psql(adminUrl!, `CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  const db = urlAs(null, tag);
  psql(db, `CREATE TABLE orders (id int PRIMARY KEY, status text); CREATE TABLE items (id int PRIMARY KEY, name text); CREATE TABLE nokey (a int, b text);
    CREATE TABLE vault (id int PRIMARY KEY); ALTER TABLE vault ENABLE ROW LEVEL SECURITY;
    CREATE SCHEMA hidden; CREATE TABLE hidden.t (id int PRIMARY KEY);
    GRANT SELECT ON orders, items, nokey, vault, hidden.t TO "${role}";
    CREATE PUBLICATION app_pub FOR TABLE orders`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-check-it-"));
  const project = path.join(dir, "project"), data = path.join(dir, "data");
  fs.mkdirSync(path.join(project, "sources"), { recursive: true });
  fs.mkdirSync(data);
  const write = (tables: string, pub = "app_pub"): void => fs.writeFileSync(path.join(project, "sources", "app.yml"),
    `kind: postgres\nurl: \${DATABASE_URL}\nsync: replication\npublication: ${pub}\ntables:\n${tables}`);
  const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: urlAs(role, tag), MASON_API_KEY: "k".repeat(48), MASON_PROJECT: project, MASON_DATA: data, MASON_NAME: tag };
  const check = (): { status: number | null; answer: Answer; out: string } => {
    const r = spawnSync(process.execPath, [MAIN, "serve", "--check", "--json"], { cwd: dir, env, encoding: "utf8" });
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(password), "the password is never said");
    return { status: r.status, answer: JSON.parse(r.stdout) as Answer, out: r.stdout + r.stderr };
  };
  const before = psql(db, "SELECT (SELECT count(*) FROM pg_replication_slots) || '/' || (SELECT string_agg(pubname, ',') FROM pg_publication)");

  write("  orders: {}\n  items: {}\n  nokey: {}\n  vault: {}\n  hidden.t: {}\n  missing_one: {}\n");
  const first = check();
  assert.equal(first.status, 1, first.out);
  assert.equal(first.answer.error?.code, "refused");
  const said = first.answer.problems.map((p) => [p.code, p.table]);
  assert.deepEqual(said, [
    ["table", "public.nokey"], ["table", "public.vault"], ["missing_table", "hidden.t"], ["missing_table", "public.missing_one"],
    ["replication", null], ["publication", "public.items"], ["publication", "public.vault"]], first.out);
  const by = (code: string, t: string | null) => first.answer.problems.find((p) => p.code === code && p.table === t)!;
  assert.match(by("table", "public.vault").message, new RegExp(`row-level security on public\\.vault hides every row from ${role}`));
  assert.match(by("replication", null).message, new RegExp(`^replication role: ${role} may not open a replication connection`));
  assert.equal(by("replication", null).sql, `ALTER ROLE ${role} WITH REPLICATION;`);
  assert.equal(by("publication", "public.items").sql, "ALTER PUBLICATION app_pub ADD TABLE public.items;");
  assert.equal(by("publication", "public.items").message, "publication app_pub: missing: public.items");

  // a publication that does not exist: the whole of it, once, naming the ones there are
  write("  orders: {}\n", "no_such_pub");
  const missingPub = check();
  assert.deepEqual(missingPub.answer.problems.map((p) => [p.code, p.table]), [["replication", null], ["publication", null]]);
  assert.match(missingPub.answer.problems[1]!.message, /no publication named no_such_pub\. Publications on this database: app_pub\./);

  // a table replication cannot carry gets its table problem alone: following the check's own statements never breaks
  // the application's UPDATEs and DELETEs (no primary key, a key: or not; REPLICA IDENTITY NOTHING), the publication
  // there or not
  psql(db, `CREATE TABLE ident_nothing (id int PRIMARY KEY); ALTER TABLE ident_nothing REPLICA IDENTITY NOTHING;
    CREATE TABLE keyed (a int NOT NULL UNIQUE, b text); GRANT SELECT ON ident_nothing, keyed TO "${role}"`);
  for (const pub of ["app_pub", "no_such_pub"]) {
    write("  orders: {}\n  nokey: {}\n  keyed:\n    key: [a]\n  ident_nothing: {}\n  items: {}\n", pub);
    const r = check();
    assert.deepEqual(r.answer.problems.filter((p) => p.code === "table").map((p) => p.table), ["public.nokey", "public.keyed", "public.ident_nothing"], r.out);
    const statements = r.answer.problems.filter((p) => p.code === "publication");
    assert.equal(statements.length, 1, r.out);
    for (const p of statements) for (const text of [p.sql ?? "", p.fix, p.message]) assert.doesNotMatch(text, /nokey|keyed|ident_nothing/, r.out);
    // the check's own statement, run as said: the application's writes on every table still go through
    if (pub === "app_pub") {
      psql(db, statements[0]!.sql!);
      psql(db, "INSERT INTO ident_nothing VALUES (1); UPDATE ident_nothing SET id = 2; DELETE FROM ident_nothing; INSERT INTO nokey VALUES (1, 'x'); DELETE FROM nokey; " +
        "INSERT INTO keyed VALUES (1, 'x'); UPDATE keyed SET b = 'y'; DELETE FROM keyed");
      psql(db, "ALTER PUBLICATION app_pub DROP TABLE items");
    }
  }

  // each fixed on the database, as the fixes say: the same project passes
  psql(db, `ALTER ROLE "${role}" REPLICATION; ALTER PUBLICATION app_pub ADD TABLE items, vault, hidden.t;
    CREATE POLICY mason_read ON vault FOR SELECT TO "${role}" USING (true); GRANT USAGE ON SCHEMA hidden TO "${role}"`);
  write("  orders: {}\n  items: {}\n  vault: {}\n  hidden.t: {}\n");
  const fixed = check();
  assert.equal(fixed.status, 0, fixed.out);
  assert.deepEqual(fixed.answer, { ok: true, tables: 4, replicated: 4, problems: [], next: [{ command: "mason serve", what: "runs the project" }] });

  // nothing written, nothing made or changed on the database
  assert.deepEqual(fs.readdirSync(data), []);
  assert.equal(psql(db, "SELECT (SELECT count(*) FROM pg_replication_slots) || '/' || (SELECT string_agg(pubname, ',') FROM pg_publication)"), before);
});
