/**
 * Issue 956: a name with a line break is refused by name (Mason gap name-line-break). A role's `where:` on a table that
 * has such a column must not take the role's other statements with it: the roles check reads the filter's types and
 * shape alone, and only a statement that reads the table is refused, by name. (The re-check of PR 974 found every
 * statement of such a role's users, `SELECT 1` included, refused 57P03 for as long as the roles file stood.)
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { changeUsers, keyFingerprint, listenerLogins, LiveUsers, newUserId, userPassword } from "../src/duck/users.ts";
import { LiveRoles } from "../src/cli/roles.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-roles-line-break-"));
const root = path.join(dir, "project"), home = path.join(root, ".mason"), folder = path.join(root, "mason");
const usersFile = path.join(home, "users.json"), rolesFile = path.join(folder, "roles.yml");
const LB = "a\nb";
const schema: PgSchema = { database: "shop", tables: [
  { name: "orders", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "tenant_id", type: "int4" }] },
  { name: "lbt", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "tenant_id", type: "int4" }, { name: LB, type: "int4" }] },
] };
const copied = schema.tables.map((t) => ({ source: `public.${t.name}`, columns: t.columns.map((c) => ({ name: c.name })), key: t.primaryKey, foreignKeys: [] }));
let store: DuckStore, api: PgApiServer;
const clients: pg.Client[] = [];

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.writeFileSync(rolesFile, `default: everything
roles:
  everything:
    tables: all
  tenant:
    attributes: [tenant]
    tables:
      orders: { where: "tenant_id = :tenant" }
      lbt: { where: "tenant_id = :tenant" }
`);
  store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, tenant_id INTEGER)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 1), (2, 2), (3, 1)");
  await store.writer.run(`CREATE TABLE public.lbt (id BIGINT, tenant_id INTEGER, "a\nb" INTEGER)`);
  await store.writer.run("INSERT INTO public.lbt VALUES (1, 1, 10), (2, 2, 20)");
  const live = new LiveRoles(folder, root, () => copied as never);
  const wired = { ...listenerLogins(new LiveUsers(usersFile, API_KEY), API_KEY), roles: () => live.now() };
  api = await startPostgresApi({ port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: (p, n) => wired.authenticate(p, n), recheck: (t) => wired.recheck!(t as never), recheckMs: 0,
    roles: () => wired.roles() as never, schema: () => schema, record: () => undefined, log: () => undefined, duck: await store.listener(undefined) });
});
after(async () => {
  for (const c of clients) await c.end();
  await api.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addUser(name: string, role: string, attributes?: Record<string, string>): string {
  const id = newUserId();
  changeUsers(usersFile, (users) => [...users.filter((x) => x.name !== name),
    { name, id, addedAt: new Date().toISOString(), key: keyFingerprint(API_KEY), role, ...(attributes ? { attributes } : {}) }] as never);
  return userPassword(API_KEY, name, id);
}
const ask = async (c: pg.Client, sql: string): Promise<string> => {
  try { return JSON.stringify((await c.query({ text: sql, rowMode: "array" })).rows); }
  catch (e) { const x = e as pg.DatabaseError; return `ERROR ${x.code}: ${x.message}${x.detail ? ` | ${x.detail}` : ""}`; }
};

test("issue 956: a role's row filter on a table with a line-break column blocks none of the role's other statements", async () => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "shop", user: "t1", password: addUser("t1", "tenant", { tenant: "1" }) });
  await c.connect();
  clients.push(c);
  assert.equal(await ask(c, "SELECT 1"), "[[1]]");
  assert.equal(await ask(c, "SELECT count(*) FROM orders"), '[["2"]]');
  assert.equal(await ask(c, "SELECT id FROM orders ORDER BY id"), '[["1"],["3"]]');
  // the table itself: refused by name, as for any user
  const lb = await ask(c, "SELECT id FROM lbt ORDER BY id");
  assert.match(lb, /^ERROR 0A000: .*line break.*"a\\nb".*Mason gap name-line-break/, lb);
});

test("issue 956: a statement of no table that orders text, with a line-break alias, is answered as before", async () => {
  // src/duck/plan.ts `ordersText` reads the analysis's collations and types alone (names false): the catalog answers
  // such a statement whole, so its own aliases are never refused there
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "shop", user: "e1", password: addUser("e1", "everything") });
  await c.connect();
  clients.push(c);
  for (const sql of [`SELECT 'a' < 'b' AS "x\ny"`, `SELECT max(v) AS "x\ny" FROM (VALUES ('a'), ('b')) t(v)`]) {
    const r = await c.query({ text: sql, rowMode: "array" }).catch((e: Error) => e);
    assert.ok(!(r instanceof Error), `${sql}: ${r instanceof Error ? r.message : ""}`);
    assert.equal(r.fields[0]!.name, "x\ny", sql);
  }
});
