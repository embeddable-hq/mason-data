/**
 * THE SOURCES FILE, END TO END, AGAINST A REAL POSTGRES (src/cli/sources.ts: a `sources` folder, each file a source to
 * sync, naming the tables and columns it syncs). As a person
 * runs it: `mason init` writes `mason/sources/<database>.yml` naming `${DATABASE_URL}` and the URL into `.env`;
 * `mason tables` lists the database's tables against it; `mason add` writes an entry (a column list, every column but
 * what looks secret as `exclude:`, a `key:` for a table with no primary key) and `mason remove` takes one out, every
 * other byte of the file as it was. And the run copies what the file names: only `columns:`, everything but `exclude:`,
 * and a no-primary-key table by its `key:` — kept current by polling, its updates and deletes included.
 *
 * What it needs: IT_POSTGRES_URL (any wal_level), psql on PATH, and DuckDB's postgres extension (downloaded once per
 * machine). It writes only inside a database it creates, `it_sources_<random>`, and drops it at the end.
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
const tag = `it_sources_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-sources-")));   // real: the CLI answers with the folder it resolved
const root = path.join(dir, "app"), home = path.join(dir, "home");

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
/** a query's column names and rows, as the Postgres API answers it */
function psqlWithHeader(url: string, sql: string): { columns: string; rows: string } {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-F", "\t", "-P", "footer=off", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  const [columns = "", ...rows] = r.stdout.trim().split("\n");
  return { columns, rows: rows.join("\n") };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
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

after(() => {
  // the run first: a copy still polling holds a connection to the database being dropped
  if (fs.existsSync(path.join(root, ".mason"))) {
    const s = spawnSync(process.execPath, [MAIN, "stop"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    if (s.status !== 0) console.error(`mason stop at the end: ${s.stdout}${s.stderr}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

async function until(what: string, check: () => boolean, ms = 60_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("init writes the sources file; tables, add and remove read and edit it; the run copies its columns, its excludes and a table by its key", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 600_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE customers (id int PRIMARY KEY, name text, email text, notes text); " +
    "CREATE TABLE orders (id int PRIMARY KEY, customer_id int REFERENCES customers, status text, amount numeric(10,2), api_token text); " +
    "CREATE TABLE events (tenant_id int NOT NULL, id int NOT NULL, kind text, raw_body text, UNIQUE (tenant_id, id)); " +
    "INSERT INTO customers SELECT g, 'c' || g, 'c' || g || '@example.com', 'n' || g FROM generate_series(1, 5) g; " +
    "INSERT INTO orders SELECT g, 1 + g % 5, CASE WHEN g % 2 = 0 THEN 'paid' ELSE 'open' END, g * 1.5, 'tok' || g FROM generate_series(1, 20) g; " +
    "INSERT INTO events SELECT 1 + g % 3, g, 'k' || g, repeat('b', 10) FROM generate_series(1, 30) g");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()) };

  // INIT: the sources file names the variable, .env holds the URL, the config holds no URL
  const init = ok(mason("init", dbUrl, "--name", "shopit", "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  const said = init.json.source as { file: string; url: string; env: string | null };
  assert.deepEqual([said.file, said.url], [file, "${DATABASE_URL}"]);
  assert.match(said.env ?? "", /^DATABASE_URL=postgres(ql)?:\/\/postgres:\*\*\*\*@/, "the .env line it wrote, its password masked");
  const init_ = fs.readFileSync(file, "utf8");
  assert.match(init_, /^kind: postgres\nurl: \$\{DATABASE_URL\}[ #].*\nsync: off {3}# /m, "init writes sync: off, with what it means");
  assert.ok(init_.endsWith("\ntables: {}\n"), init_);
  // every table polled every second, as a person writes it at the file's top: the run below is kept current by polling
  fs.writeFileSync(file, init_.replace(/^sync: off {3}#.*$/m, "sync: poll 1s"));
  const written = fs.readFileSync(file, "utf8");
  // everything above tables: stays byte for byte through every add and remove below
  const HEAD = written.slice(0, written.length - "tables: {}\n".length);
  assert.match(fs.readFileSync(path.join(root, ".env"), "utf8"), new RegExp(`^DATABASE_URL=${dbUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8"), new RegExp(tag), "no URL in the config");

  // TABLES, Mason stopped: the database's tables against the file, none added; the no-key table's way out
  const listed = ok(mason("tables", "--json"), "mason tables");
  const tables = listed.json.tables as Array<{ table: string; added: boolean; addable: boolean; reason: string | null }>;
  assert.deepEqual(listed.json.source, { name: path.basename(file).replace(/\.ya?ml$/, ""), file }, "source is the database: its name and its file");
  assert.deepEqual(tables.map((t) => [t.table, t.added, t.addable]), [["public.customers", false, true], ["public.events", false, false], ["public.orders", false, true]]);
  assert.equal(tables[1]!.reason, `no primary key: name the columns that tell its rows apart, mason add events --key tenant_id,id (its unique index events_tenant_id_id_key)`);

  ok(mason("start", "--json"), "mason start");

  // ADD: a column list (the key added), every column but the secret-looking one as exclude:, a no-key table by its key
  const customers = ok(mason("add", "customers", "--columns", "name", "--json"), "mason add customers");
  assert.equal(customers.json.file, file);
  assert.deepEqual((customers.json.added as Array<Record<string, unknown>>).map((a) => [a.table, a.columns, a.addedKey]), [["public.customers", ["id", "name"], ["id"]]]);
  const orders = ok(mason("add", "orders", "--json"), "mason add orders");
  assert.deepEqual((orders.json.added as Array<Record<string, unknown>>).map((a) => [a.table, a.columns, a.exclude, a.skippedSecrets]), [["public.orders", null, ["api_token"], ["api_token"]]]);
  const noKey = mason("add", "events", "--json");
  assert.equal(noKey.status, 1, "a table with no primary key and no --key is refused");
  ok(mason("add", "events", "--key", "tenant_id,id", "--json"), "mason add events --key");
  // a comment of the person's own, kept by every edit after it
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("tables:\n", "tables:   # what the dashboards read\n"));
  ok(mason("add", "customers", "--columns", "name,email", "--json"), "mason add customers again, wider");
  assert.equal(fs.readFileSync(file, "utf8"), HEAD + "tables:   # what the dashboards read\n  customers:\n    columns: [id, name, email]\n  orders:\n    exclude: [api_token]\n  events:\n    key: [tenant_id, id]\n");

  ok(mason("wait", "--json"), "mason wait");
  const user = ok(mason("user", "add", "it", "--json"), "mason user add");
  const api = user.json.url as string;

  // THE WEB PAGE (mason ui): its URL carries the run's token, traded once for the cookie; mason status prints the URL
  // without it, mason start's log names the command, never the URL
  const page = ok(mason("ui", "--json"), "mason ui");
  const pageUrl = new URL(page.json.url as string);
  assert.equal(pageUrl.pathname, "/");
  assert.equal(Number(pageUrl.port), page.json.port);
  const token = pageUrl.searchParams.get("token")!;
  const handed = await fetch(pageUrl, { redirect: "manual" });
  assert.equal(handed.status, 303);
  const cookie = handed.headers.get("set-cookie")!.split(";")[0]!;
  const html = await fetch(new URL("/", pageUrl), { headers: { Cookie: cookie } });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<script type="module" src="\/app\.js"><\/script>/);
  const st = ok(mason("status"), "mason status");
  assert.match(st.stdout, new RegExp(`Web UI +http://127\\.0\\.0\\.1:${pageUrl.port}/  \\(mason ui opens it\\)`));
  assert.ok(!st.stdout.includes(token) && !fs.readFileSync(path.join(root, ".mason", "dev.log"), "utf8").includes(token), "the token is only mason ui's");
  assert.match(fs.readFileSync(path.join(root, ".mason", "dev.log"), "utf8"), /^ {2}Web UI {2}mason ui {2}\(the status page and the users, in your browser\)$/m);
  assert.deepEqual(psqlWithHeader(api, "SELECT * FROM public.customers ORDER BY id"),
    { columns: "id\tname\temail", rows: psql(dbUrl, "SELECT id, name, email FROM customers ORDER BY id") }, "columns: only those, the key first");
  assert.deepEqual(psqlWithHeader(api, "SELECT * FROM public.orders ORDER BY id"),
    { columns: "id\tcustomer_id\tstatus\tamount", rows: psql(dbUrl, "SELECT id, customer_id, status, amount FROM orders ORDER BY id") }, "exclude: every column but that one");
  const eventsNow = (): string => psqlWithHeader(api, "SELECT * FROM public.events ORDER BY tenant_id, id").rows;
  assert.equal(eventsNow(), psql(dbUrl, "SELECT * FROM events ORDER BY tenant_id, id"), "key: a table with no primary key copied whole");

  // kept current by its key: an update and a delete, by polling
  psql(dbUrl, "UPDATE events SET kind = 'changed' WHERE tenant_id = 2 AND id = 4; DELETE FROM events WHERE tenant_id = 1 AND id = 3; INSERT INTO events VALUES (3, 99, 'new', 'b')");
  const source = psql(dbUrl, "SELECT * FROM events ORDER BY tenant_id, id");
  await until("the poll to bring events' update, delete and insert", () => eventsNow() === source);

  // REMOVE: its entry gone, the rest of the file as it was; its copy dropped
  const removed = ok(mason("remove", "customers", "--json"), "mason remove customers");
  assert.equal(removed.json.file, file);
  assert.equal(fs.readFileSync(file, "utf8"), HEAD + "tables:   # what the dashboards read\n  orders:\n    exclude: [api_token]\n  events:\n    key: [tenant_id, id]\n");
  await until("customers' copy to be dropped", () => spawnSync("psql", ["-X", "-q", api, "-c", "SELECT 1 FROM public.customers LIMIT 1"], { encoding: "utf8" }).status !== 0);
  const later = ok(mason("tables", "--json"), "mason tables, running");
  assert.deepEqual((later.json.tables as Array<{ table: string; added: boolean; copyKey: string[] | null }>).map((t) => [t.table, t.added, t.copyKey]),
    [["public.customers", false, null], ["public.events", true, ["tenant_id", "id"]], ["public.orders", true, null]]);

  ok(mason("stop", "--json"), "mason stop");
});
