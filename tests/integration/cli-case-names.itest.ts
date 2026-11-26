/**
 * NAMES THAT DIFFER ONLY IN CASE (issue 1019), end to end against a real Postgres. Postgres keeps `"U"` and `u` apart, and
 * `"Orders"` and `orders`. The synced data holds a name without regard to ASCII case, so a table with both columns failed
 * its first sync for ever (`Column with name "u" already exists`), and two tables of one name served one table under
 * both. Each is refused by name, at every entrance, with the way out: `mason tables` says why, `mason add` refuses with
 * the `--columns` that syncs the rest, `mason start` refuses an entry written by hand with the `exclude:` to write, and
 * a column of that kind added to a synced table while the run is up is said, the table served as it was. The way out
 * syncs, and serves what Postgres answers. A letter outside ASCII keeps its case: `"É"` and `"é"` sync as two columns.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, and DuckDB's postgres extension. It writes only inside a
 * database it creates, `it_case_<random>`, drops it at the end, and runs `mason destroy` on its project.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_case_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-case-")));
const root = path.join(dir, "app"), home = path.join(dir, "home");

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
/** a query's column names and rows, as an answer reads them; null when it fails */
function psqlWithHeader(url: string, sql: string): { columns: string; rows: string } | null {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-F", "\t", "-P", "footer=off", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const [columns = "", ...rows] = r.stdout.trim().split("\n");
  return { columns, rows: rows.join("\n") };
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
async function until(what: string, check: () => boolean, ms = 120_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let env: Record<string, string> = {};
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
function mason(...args: string[]): Ran {
  const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 300_000 });
  let json: Record<string, unknown> = {};
  if (args.includes("--json")) {
    try { json = JSON.parse(r.stdout) as Record<string, unknown>; } catch { throw new Error(`mason ${args.join(" ")}: not JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`); }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const ok = (r: Ran, what: string): Ran => { assert.equal(r.status, 0, `${what}:\n${r.stdout}${r.stderr}`); return r; };
const errorOf = (r: Ran): { code: string; message: string; why?: string } => (r.json.error ?? {}) as { code: string; message: string; why?: string };

after(() => {
  // the run first: a copy still polling holds a connection to the database being dropped
  if (fs.existsSync(path.join(root, ".mason"))) {
    const s = spawnSync(process.execPath, [MAIN, "destroy", "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    if (s.status !== 0) console.error(`mason destroy at the end: ${s.stdout}${s.stderr}`);
  }
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test("columns and tables whose names differ only in case: refused by name at mason tables, mason add, mason start and while the run is up, and the way out syncs what Postgres serves (issue 1019)", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 900_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, `CREATE TABLE t (id int PRIMARY KEY, "U" int, u int, note text);
    INSERT INTO t SELECT g, g * 10, g * 100, 'n' || g FROM generate_series(1, 5) g;
    CREATE TABLE "Orders" (id int PRIMARY KEY, a text); INSERT INTO "Orders" VALUES (1, 'upper');
    CREATE TABLE orders (id int PRIMARY KEY, b text, c int); INSERT INTO orders VALUES (1, 'lower', 7), (2, 'two', 8);
    CREATE TABLE accents (id int PRIMARY KEY, "É" text, "é" text); INSERT INTO accents SELECT g, 'E' || g, 'e' || g FROM generate_series(1, 4) g`);
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()) };
  ok(mason("init", dbUrl, "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  // polled every second, so a column added below is seen while the run is up
  const head = fs.readFileSync(file, "utf8").replace(/^sync: off {3}#.*$/m, "sync: poll 1s").replace(/tables: \{\}\n$/, "");
  const write = (tables: string): void => fs.writeFileSync(file, `${head}tables:\n${tables}`);
  write("  orders: {}\n");

  // MASON TABLES: why t and "Orders" cannot be added, and no entry offered; accents can be
  const tRefusal = "public.t cannot be added: its columns U and u have names that differ only in case. The synced data cannot hold them all. mason add t --columns id,U,note syncs the others, without u";
  const listed = ok(mason("tables", "--json"), "mason tables").json.tables as Array<{ table: string; reason: string | null; entry: unknown }>;
  const of = (name: string) => listed.find((x) => x.table === name)!;
  assert.deepEqual([of("public.t").reason, of("public.t").entry], [tRefusal.replace("public.t cannot be added: ", ""), null]);
  assert.match(of("public.Orders").reason ?? "", /^public\.Orders cannot be added: its name differs from public\.orders only in case, and the file syncs public\.orders already \(tables\.orders\)\. The synced data cannot hold both\. mason remove orders first to sync public\.Orders instead$/);
  assert.equal(of("public.accents").reason, null);

  // MASON ADD, Mason stopped: refused with the --columns to run, nothing written
  const before = fs.readFileSync(file, "utf8");
  const add = mason("add", "t", "--json");
  assert.deepEqual([add.status, errorOf(add).message, errorOf(add).why], [1, "public.t was not added", tRefusal], `${add.stdout}${add.stderr}`);
  const addOrders = mason("add", "Orders", "--json");
  assert.equal(addOrders.status, 1, `${addOrders.stdout}${addOrders.stderr}`);
  assert.equal(fs.readFileSync(file, "utf8"), before, "nothing written");

  // MASON START over entries written by hand: refused before anything syncs, each at its key with the line to write
  write('  orders: {}\n  "Orders": {}\n  t: {}\n');
  const refused = mason("start", "--json");
  assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
  const report = `${errorOf(refused).message}\n${errorOf(refused).why ?? ""}`;
  assert.match(report, /tables\.t: public\.t has columns U and u, whose names differ only in case\. The synced data cannot hold them all\. Leave one out: exclude: \[u\]/);
  assert.match(report, /tables\.Orders: public\.Orders and public\.orders \(tables\.orders\) have names that differ only in case\. The synced data cannot hold both\. Remove one of the two entries/);

  // THE WAY OUT: one of the two tables, and t without u — both synced and served as Postgres serves them
  write("  orders: {}\n  t:\n    exclude: [u]\n  accents: {}\n");
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "180", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;
  const same = (mine: string, theirs: string = mine): void => {
    const pg = psqlWithHeader(dbUrl, theirs);
    assert.ok(pg !== null, theirs);
    assert.deepEqual(psqlWithHeader(api, mine), pg, mine);
  };
  same("SELECT * FROM t ORDER BY id", 'SELECT id, "U", note FROM t ORDER BY id');
  same('SELECT "U", count(*) FROM t GROUP BY "U" ORDER BY "U"');
  same("SELECT * FROM orders ORDER BY id");
  same('SELECT * FROM accents ORDER BY id');
  same('SELECT "É", "é" FROM accents WHERE "é" > \'e2\' ORDER BY id');

  // WHILE THE RUN IS UP: a column whose name differs from accents' id only in case, added on the database. Said on
  // accents' line in mason status with the line to write, accents alone held (issue 1074) and served as it was
  psql(dbUrl, `ALTER TABLE accents ADD COLUMN "ID" int; UPDATE accents SET "ID" = id * 2; INSERT INTO accents VALUES (5, 'E5', 'e5', 10)`);
  const warned = /^public\.accents is not synced: .*tables\.accents: public\.accents has columns id and ID, whose names differ only in case\. The synced data cannot hold them all\. Leave one out: exclude: \[ID\]\. Mason holds the table and serves its synced data as it was\./;
  const accentsLine = (): string => ((mason("status", "--json").json.tables ?? []) as Array<{ table: string; error: string | null }>).find((x) => x.table === "public.accents")?.error ?? "";
  await until("mason status to say accents' new column", () => warned.test(accentsLine()));
  same("SELECT * FROM accents WHERE id <= 4 ORDER BY id", 'SELECT id, "É", "é" FROM accents WHERE id <= 4 ORDER BY id');
  // the line it names syncs the table again, its new row included, without ID
  write("  orders: {}\n  t:\n    exclude: [u]\n  accents:\n    exclude: [ID]\n");
  ok(mason("stop", "--json"), "mason stop");
  ok(mason("start", "--json"), "mason start again");
  ok(mason("wait", "--timeout", "180", "--json"), "mason wait again");
  same("SELECT * FROM accents ORDER BY id", 'SELECT id, "É", "é" FROM accents ORDER BY id');
});
