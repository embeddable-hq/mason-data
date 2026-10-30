/**
 * THE DATABASE NAME A TOOL CONNECTS WITH (src/lib/database-name.ts): `mason` unless the sources file says another, and the
 * project's name only ever the slot's. The one rule, the key that sets it, every command that writes the file keeping
 * it, and what a person reads with Mason stopped. The wire's refusal is tests/postgres-api/server.test.ts's, the catalog's
 * names tests/postgres-api/catalog.test.ts's, the server's setting tests/serve.test.ts's.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connectionUrl, postgresLink, withPlaceholders } from "../src/cli/pg-url.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { PgError } from "../src/cdc/pg-wire.ts";
import { databaseMoved, type Project } from "../src/cli/project.ts";
import { postgresApiUrl } from "../src/api/postgres/listener.ts";
import * as S from "../src/cli/sources.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const FILE = "/p/mason/sources/app.yml";
const HEAD = "kind: postgres\nurl: ${DATABASE_URL}\n";
const parsed = (text: string) => S.parseSourceText(text, "app", FILE);
/** Read per test, so each fails by name where the module is not there (scripts/fails-without.ts). */
const naming = () => import("../src/lib/database-name.ts");

/** A project with Mason stopped: its config, and a sources file of `text`. */
function project(text: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-dbname-"));
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "my-shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }), { mode: 0o600 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  if (text !== null) fs.writeFileSync(path.join(root, "mason", "sources", "app.yml"), text);
  return root;
}

test("the rule: the sources file's, else a server's setting, else mason — a setting on a project that is no server is no answer", async () => {
  const { connectDatabase, databaseSettingRefusal, DEFAULT_DATABASE } = await naming();
  assert.equal(DEFAULT_DATABASE, "mason");
  assert.equal(connectDatabase({ database: null }, {}, {}), "mason");
  assert.equal(connectDatabase({ database: "production" }, {}, {}), "production");
  assert.equal(connectDatabase({ database: null }, { served: true }, { MASON_PG_DATABASE: "reporting" }), "reporting");
  assert.equal(connectDatabase({ database: null }, { served: true }, { MASON_PG_DATABASE: "" }), "mason", "empty is unset, as every setting");
  assert.equal(connectDatabase({ database: "production" }, { served: true }, { MASON_PG_DATABASE: "reporting" }), "production");
  assert.equal(connectDatabase({ database: null }, { served: false }, { MASON_PG_DATABASE: "reporting" }), "mason");
  // and mason start refuses it, with the line to write, where a server reads it
  assert.deepEqual(databaseSettingRefusal({ MASON_PG_DATABASE: "reporting" }, "mason/sources/app.yml"), {
    message: "MASON_PG_DATABASE is mason serve's setting, and mason start ignores no setting silently",
    fix: "write database: reporting in mason/sources/app.yml (it is committed, so every machine answers as it), and unset MASON_PG_DATABASE" });
  assert.equal(databaseSettingRefusal({}, "x"), null);
});

test("a name is as wide as Postgres's, so a tool keeps the one it has; what could not be served is refused", async () => {
  const { databaseNameProblem } = await naming();
  for (const ok of ["mason", "postgres", "template1", "template0", "Production", "my db", "a-b.c", "o'brien", "ünï", "x".repeat(63), "é".repeat(31), "100%", "a/b", "$x"]) {
    assert.equal(databaseNameProblem(ok), null, ok);
  }
  assert.match(databaseNameProblem("")!, /is empty/);
  assert.match(databaseNameProblem("x".repeat(64))!, /is 64 bytes, and a Postgres database name is at most 63/);
  assert.match(databaseNameProblem("é".repeat(32))!, /is 64 bytes/, "bytes, as Postgres counts, never characters");
  assert.match(databaseNameProblem("a\nb")!, /control character/);
  assert.match(databaseNameProblem("a\0b")!, /control character/);
  for (const dots of [".", ".."]) assert.match(databaseNameProblem(dots)!, /a step in a path/);
  assert.match(databaseNameProblem("${PG_DATABASE}")!, /is a variable, and the name is written out/);
});

test("every name a tool may keep survives the URL: recorded, read back, printed, and what a client parses from it", () => {
  for (const name of ["mason", "Production", "my db", "a-b.c", "o'brien", "100%", "a/b", "q?x", "h#1", "ünï", "$x"]) {
    const recorded = postgresApiUrl({ host: "127.0.0.1", port: 5433 }, name);
    const link = postgresLink(recorded);
    assert.equal(link.database, name, `${name} read back`);
    const url = connectionUrl(link, "metabase", "pw");
    const client = parseSource(url);
    assert.ok("source" in client, url);
    assert.equal(client.source.database, name, `${name} as a client reads it: mason mcp's URL`);
    assert.ok(withPlaceholders(recorded).endsWith(`/${encodeURIComponent(name)}`));
  }
});

test("database: in the sources file: read as written; a mistake at its key with what to write, on the one report", () => {
  const read = (line: string) => parsed(`${HEAD}${line}\ntables: {}\n`);
  assert.equal((parsed(`${HEAD}tables: {}\n`) as { database: unknown }).database, null, "none written");
  assert.equal((read("database: production") as { database: unknown }).database, "production");
  assert.equal((read("database: Production") as { database: unknown }).database, "Production", "as written, capitals kept");
  assert.equal((read('database: "my db"') as { database: unknown }).database, "my db");
  assert.equal((read("database: postgres") as { database: unknown }).database, "postgres");
  const problems = (line: string): string[] => (read(line) as { problems: string[] }).problems;
  const way = "write database: <name>, or take the line out: tools then connect with mason";
  assert.deepEqual(problems("database:"), [`database: is empty — ${way}`]);
  assert.deepEqual(problems("database: [a, b]"), [`database: is one name, not a list or a map — ${way}`]);
  assert.deepEqual(problems("database: 007"), ['database: 007 is read by YAML as a number, not a name — quote it: "007"']);
  assert.deepEqual(problems("database: true"), ['database: true is read by YAML as a boolean, not a name — quote it: "true"']);
  assert.deepEqual(problems("database: ${PG_DATABASE}"), [`database: "\${PG_DATABASE}" is a variable, and the name is written out: it is the same on every machine that runs this project — ${way}`]);
  assert.deepEqual(problems(`database: ${"x".repeat(64)}`), [`database: "${"x".repeat(64)}" is 64 bytes, and a Postgres database name is at most 63 — ${way}`]);
  // with the file's other mistakes, on one report; a misspelt key said as any is
  assert.deepEqual((parsed(`${HEAD}database:\nsynk: off\ntables: {}\n`) as { problems: string[] }).problems,
    ["unexpected key synk — did you mean `sync`? — a source file takes kind, url, database, sync, publication, tables", `database: is empty — ${way}`]);
  assert.match((parsed(`${HEAD}databse: x\ntables: {}\n`) as { problems: string[] }).problems[0]!, /unexpected key databse — did you mean `database`\?/);
});

test("mason init writes no database: so the default stays a default, and says how to set one; --database writes the line, read back", () => {
  const plain = S.newSourceText();
  assert.doesNotMatch(plain, /^database:/m);
  assert.match(plain, /^# Tools connect with the database name mason; database: <name> here keeps the name a tool already has\.$/m);
  assert.equal((parsed(plain) as { database: unknown }).database, null);
  for (const name of ["production", "Production-2", "my db", "true", "o'brien"]) {
    const text = S.newSourceText("${DATABASE_URL}", [], undefined, name);
    assert.equal((parsed(text) as { database: unknown }).database, name, text);
  }
});

test("every command that rewrites the sources file keeps database: and every byte beside it", () => {
  const text = `${HEAD}database: Production   # our BI tools' saved connections\nsync: off\ntables:\n  orders: {}\n  customers:\n    columns: [id]\n`;
  const line = "database: Production   # our BI tools' saved connections\n";
  const added = S.withTable(text, { name: "events", table: "public.events", columns: null, exclude: [], key: null }) as { text: string };
  assert.ok(added.text.includes(line) && added.text.includes("  events: {}\n"));
  const synced = S.withEntrySync(text, { name: "orders", table: "public.orders", columns: null, exclude: [], key: null }, { mode: "poll", every: "5m", seconds: 300 }) as { text: string };
  assert.ok(synced.text.includes(line) && synced.text.includes("sync: poll 5m"));
  const removed = S.withoutTable(text, "public.orders") as { text: string };
  assert.ok(removed.text.includes(line) && !removed.text.includes("orders"));
  const last = S.withoutTable(removed.text, "public.customers") as { text: string };
  assert.ok(last.text.includes(line) && last.text.endsWith("tables: {}\n"), last.text);
  for (const t of [added, synced, removed, last]) assert.equal((parsed(t.text) as { database: unknown }).database, "Production");
});

test("the key alone, for a command that reads neither the URL nor the tables; a file that cannot say it is refused, never guessed", () => {
  const root = project(`${HEAD}database: production\ntables:\n  orders: { columns: oops }\n`);
  const folder = path.join(root, "mason");
  try {
    assert.deepEqual(S.writtenDatabase(folder, root), { database: "production" }, "the entry's mistake is not this key's");
    fs.rmSync(path.join(folder, "sources", "app.yml"));
    assert.deepEqual(S.writtenDatabase(folder, root), { database: null }, "no file: nothing written");
    fs.writeFileSync(path.join(folder, "sources", "app.yml"), `${HEAD}database: [a]\ntables: {}\n`);
    const bad = S.writtenDatabase(folder, root);
    assert.ok("message" in bad);
    assert.equal(bad.code, "bad_source");
    assert.match(bad.message, /^mason\/sources\/app\.yml: database: is one name/);
    // a file with no key to read is no file with none: what the run refuses, said, never `mason`
    for (const [text, said] of [["- a\n- b\n", "not a mapping"], ["just words\n", "not a mapping"], ["", "empty"], ["# only a comment\n", "empty"]] as const) {
      fs.writeFileSync(path.join(folder, "sources", "app.yml"), text);
      const refused = S.writtenDatabase(folder, root);
      assert.ok("message" in refused, JSON.stringify(text));
      assert.equal(refused.message, `mason/sources/app.yml: it is ${said}: a source file is kind: postgres, url: \${DATABASE_URL} and tables: {}`);
      assert.deepEqual((S.parseSourceText(text, "app", FILE) as { problems: string[] }).problems, [`it is ${said}: a source file is kind: postgres, url: \${DATABASE_URL} and tables: {}`], "as the run says it");
    }
    fs.writeFileSync(path.join(folder, "sources", "app.yml"), "database: [\n");
    assert.match((S.writtenDatabase(folder, root) as { message: string }).message, /^mason\/sources\/app\.yml: it is not YAML/);
    fs.writeFileSync(path.join(folder, "sources", "other.yml"), HEAD);
    assert.match((S.writtenDatabase(folder, root) as { message: string }).message, /has 2 source files .*: one source per project for now/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a setting a start refuses is refused where the start was typed, in the failure shape, before anything is spawned; a typed run the same", async () => {
  const root = project(`${HEAD}tables: {}\n`);
  try {
    const typed = await runMason(root, ["start", "--json"], matrixEnv({ MASON_PG_DATABASE: "reporting" }));
    assert.equal(typed.code, 1, typed.stdout + typed.stderr);
    const error = (JSON.parse(typed.stdout) as { error: { code: string; message: string; fix: string } }).error;
    assert.equal(error.code, "refused", "never `failed`, the run stopped, with the way out in a log");
    assert.equal(error.message, "MASON_PG_DATABASE is mason serve's setting, and mason start ignores no setting silently");
    assert.equal(error.fix, "write database: reporting in mason/sources/app.yml (it is committed, so every machine answers as it), and unset MASON_PG_DATABASE");
    assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "no run spawned");
    const attached = await runMason(root, ["start", "--attach"], matrixEnv({ MASON_PG_DATABASE: "reporting" }));
    assert.equal(attached.code, 1, attached.stdout + attached.stderr);
    assert.match(attached.stderr, /^✗ mason start: MASON_PG_DATABASE is mason serve's setting/m);
    // the one list: the setting beside it answers the same way
    const poll = await runMason(root, ["start", "--json"], matrixEnv({ MASON_POLL_MS: "5000" }));
    assert.equal((JSON.parse(poll.stdout) as { error: { code: string } }).error.code, "refused");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason mcp's 3D000: the way out is the URL's last part and the hint's name, never the project's", async () => {
  const { connectFailure } = await import("../src/cli/mcp.ts");
  const client = parseSource("postgres://claude:pw@127.0.0.1:5433/my-shop");
  assert.ok("source" in client);
  const hint = "this Mason answers as the database \"mason\": connect with database=mason";
  const wrong = connectFailure(new PgError({ S: "FATAL", C: "3D000", M: "database \"my-shop\" does not exist", H: hint }), client.source);
  assert.equal(wrong.message, "127.0.0.1:5433 refused the connection: database \"my-shop\" does not exist (3D000)");
  assert.equal(wrong.why, hint);
  assert.equal(wrong.fix, "the last part of the URL is the database: change it to the one the hint names, or use the URL mason user add printed");
  const other = connectFailure(new PgError({ S: "FATAL", C: "57P03", M: "not yet" }), client.source);
  assert.equal(other.fix, "the URL mason user add printed");
});

test("mason status while up compares what the file says: a server named by its setting, asked from a shell without it, is no move", () => {
  const root = project(`${HEAD}tables: {}\n`);
  const at = (served: boolean): Project => ({ root, dir: path.join(root, ".mason"), folder: path.join(root, "mason"),
    config: { name: "my-shop", folder: "mason", remote: false, apiKey: "k", ...(served ? { served } : {}) } });
  const file = path.join(root, "mason", "sources", "app.yml");
  try {
    assert.equal(databaseMoved(at(true), "reporting"), null, "named by MASON_PG_DATABASE, which this shell need not have");
    assert.equal(databaseMoved(at(false), "shop"), "mason", "a project's file took its line out: the next start answers as the default");
    assert.equal(databaseMoved(at(false), "mason"), null);
    fs.writeFileSync(file, `${HEAD}database: production\ntables: {}\n`);
    assert.equal(databaseMoved(at(true), "reporting"), "production", "a file that writes a name is said on a server too");
    assert.equal(databaseMoved(at(false), "production"), null);
    fs.writeFileSync(file, "database: [\n");
    assert.equal(databaseMoved(at(false), "mason"), null, "a file that cannot be read is said by what reads it");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason user add, Mason stopped: the name the next run answers as, never the project's; a file that cannot say it refused before a user is written", async () => {
  const none = project(`${HEAD}tables: {}\n`);
  const own = project(`${HEAD}database: Production\ntables: {}\n`);
  const broken = project(`${HEAD}database: [a]\ntables: {}\n`);
  try {
    const a = await runMason(none, ["user", "add", "metabase", "--json"], matrixEnv());
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal((JSON.parse(a.stdout) as { database: string }).database, "mason");
    const b = await runMason(own, ["user", "add", "metabase"], matrixEnv());
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /^ {2}database +Production$/m);
    const c = await runMason(broken, ["user", "add", "metabase", "--json"], matrixEnv());
    assert.equal(c.code, 1, c.stdout + c.stderr);
    assert.equal((JSON.parse(c.stdout) as { error: { code: string } }).error.code, "bad_source");
    assert.ok(!fs.existsSync(path.join(broken, ".mason", "users.json")), "nothing written");
  } finally { for (const r of [none, own, broken]) fs.rmSync(r, { recursive: true, force: true }); }
});

test("mason status, Mason stopped: what a tool will connect with, as a person and under --json; a file that cannot say it says null", async () => {
  const own = project("kind: postgres\nurl: postgres://me@127.0.0.1:1/shop\ndatabase: Production\ntables: {}\n");
  const none = project("kind: postgres\nurl: postgres://me@127.0.0.1:1/shop\ntables: {}\n");
  const broken = project("kind: postgres\nurl: postgres://me@127.0.0.1:1/shop\ndatabase: [a]\ntables: {}\n");
  try {
    assert.match((await runMason(own, ["status"], matrixEnv())).stdout, /^ {2}Postgres API +not running \(a tool connects with the database Production\)$/m);
    assert.match((await runMason(none, ["status"], matrixEnv())).stdout, /^ {2}Postgres API +not running \(a tool connects with the database mason\)$/m);
    assert.deepEqual((JSON.parse((await runMason(own, ["status", "--json"], matrixEnv())).stdout) as { postgres: unknown }).postgres, { database: "Production" });
    assert.deepEqual((JSON.parse((await runMason(broken, ["status", "--json"], matrixEnv())).stdout) as { postgres: unknown }).postgres, { database: null });
  } finally { for (const r of [own, none, broken]) fs.rmSync(r, { recursive: true, force: true }); }
});

test("mason init --database writes the line; a name that cannot be served, or a source file already here, is refused with the way out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-dbname-init-"));
  const url = "postgres://me:pw@127.0.0.1:1/shop";
  try {
    const first = fs.mkdtempSync(path.join(dir, "made-"));
    const made = await runMason(first, ["init", url, "--skip-check", "--database", "Production", "--json"], matrixEnv());
    assert.equal(made.code, 0, made.stdout + made.stderr);
    assert.equal((JSON.parse(made.stdout) as { source: { database: string } }).source.database, "Production", "said back to an agent");
    const plain = await runMason(fs.mkdtempSync(path.join(dir, "plain-")), ["init", url, "--skip-check", "--database", "Production"], matrixEnv());
    assert.match(plain.stdout, /^✓ Wrote mason\/sources\/shop\.yml: the database \(url: \$\{DATABASE_URL\}\), database: Production, sync: off /m, "and to a person");
    const fallback = await runMason(fs.mkdtempSync(path.join(dir, "default-")), ["init", url, "--skip-check", "--json"], matrixEnv());
    assert.equal((JSON.parse(fallback.stdout) as { source: { database: string } }).source.database, "mason");
    assert.match(fs.readFileSync(path.join(first, "mason", "sources", "shop.yml"), "utf8"), /^database: Production {3}# the database name a tool connects with$/m);
    const bad = await runMason(fs.mkdtempSync(path.join(dir, "bad-")), ["init", url, "--skip-check", "--database", "..", "--json"], matrixEnv());
    assert.equal(bad.code, 2, bad.stdout);
    assert.match((JSON.parse(bad.stdout) as { error: { message: string } }).error.message, /^--database: "\.\." cannot be the last part of a connection URL/);
    // a clone: the file is the project's, and init keeps it
    const clone = fs.mkdtempSync(path.join(dir, "clone-"));
    fs.mkdirSync(path.join(clone, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(clone, "mason", "sources", "shop.yml"), `kind: postgres\nurl: ${url}\ntables: {}\n`);
    const kept = await runMason(clone, ["init", url, "--skip-check", "--database", "x", "--json"], matrixEnv());
    assert.equal(kept.code, 2, kept.stdout);
    const said = (JSON.parse(kept.stdout) as { error: { message: string; fix: string } }).error;
    assert.equal(said.message, "--database writes a new source file, and mason/sources/shop.yml is here already");
    assert.equal(said.fix, "write database: x in it");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
