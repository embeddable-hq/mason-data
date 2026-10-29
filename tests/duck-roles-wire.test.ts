/**
 * ROLES AGAINST A REAL LISTENER (src/duck/grants.ts, src/cli/roles.ts, src/api/postgres/server.ts; docs/POSTGRES-API.md
 * "Roles"): a Postgres listener over a throwaway DuckStore, a project's `mason/roles.yml` read as `mason start` reads
 * it (`LiveRoles`), users of `.mason/users.json` with a role each, wired as the run wires them (`listenerLogins`). What
 * it must hold, each over the wire with a `pg` client:
 *   - a role is enforced on the ANALYSED tree, never on the text: a hidden column read inside a CTE, a subquery, a view,
 *     a USING join, a NATURAL join, a window's PARTITION BY, an ORDER BY, a WHERE, a GROUP BY, a CASE, a lateral's
 *     argument, a prepared statement's Parse, `SELECT *` and `t.*` on a partly granted table (never narrowed), a system
 *     column, a table the role lacks — each refused 42501 with Postgres's own message (`permission denied for table …`),
 *     the DETAIL naming the role and the column, the HINT what the role may read; `count(*)` over a granted table and a
 *     read of granted columns answered; a statement that reads no copied table untouched;
 *   - an `exclude:` role and one listing every column explicitly; a user with no role and a token read everything;
 *   - the role is read with the user at every statement: a role changed under a user applies to its next statement,
 *     and to an EXECUTE of a statement prepared before; a role removed from the file refuses by name (fail closed), a
 *     file that cannot be read refuses 57P03, a repaired one answers again — no restart anywhere;
 *   - two sessions with different roles in one listener: the same statement answered to one, refused to the other,
 *     interleaved (the plans are the role's own, src/api/postgres/server.ts Server.duckPlan);
 *   - the catalog answers FOR THE ROLE: information_schema.tables / .columns list what it may read, has_table_privilege
 *     and has_column_privilege answer as Postgres's would for its grants, a session with no role sees everything, and
 *     two sessions' catalog requests interleaved never see each other's view (`SET ROLE` in the one request); pg_catalog
 *     itself still lists every copied column (said in the docs: not filtered in this stage);
 *   - every refusal and answer is a row of the request log with the user's ROLE.
 * The roles modules are imported inside the tests, so a tree without them fails each test by name (scripts/fails-without.ts).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import { changeUsers, keyFingerprint, newUserId, userPassword } from "../src/duck/users.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-roles-wire-"));
const root = path.join(dir, "project");
const home = path.join(root, ".mason");
const folder = path.join(root, "mason");
const usersFile = path.join(home, "users.json");
const rolesFile = path.join(folder, "roles.yml");
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;

const schema: PgSchema = {
  database: "shop",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }, { name: "amount", type: "int8" }, { name: "notes", type: "text" }, { name: "meta", type: "jsonb" }] },
    { name: "customers", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "name", type: "text" }, { name: "email", type: "text" }] },
    { name: "events", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8" }, { name: "kind", type: "text" }] },
  ],
  // a view over a hidden column: a role is held to the TABLES a view reads (every role may name the view)
  views: [{ schema: "public", name: "order_notes", definition: " SELECT id, notes FROM public.orders;" },
    { schema: "public", name: "order_status", definition: " SELECT id, status FROM public.orders;" }],
};
/** the copied tables as the run hands them to LiveRoles: the source's name and the copy's columns */
const copied = schema.tables.map((t) => ({ source: `public.${t.name}`, columns: t.columns.map((c) => ({ name: c.name })) }));

const ROLES = `roles:
  # the agent reads three columns of orders and every customer column
  agent:
    tables:
      orders:
        columns: [id, status, amount]
      customers: {}
  # a role that names every column of orders explicitly, and excludes one of customers
  wide:
    tables:
      orders:
        columns: [id, status, amount, notes, meta]
      customers:
        exclude: [email]
  # a role with no id on orders: a USING or NATURAL join with customers reads it
  narrow:
    tables:
      orders:
        columns: [status, amount]
      customers: {}
`;

/** the run's own wiring, made inside a test (see the header) */
let wired: (Pick<PgApiOptions, "authenticate" | "recheck" | "recheckMs"> & { roles: () => unknown }) | null = null;
async function wire(): Promise<void> {
  if (wired !== null) return;
  const u = await import("../src/duck/users.ts");
  const r = await import("../src/cli/roles.ts");
  const live = new r.LiveRoles(folder, root, () => copied);
  wired = { ...u.listenerLogins(new u.LiveUsers(usersFile, API_KEY), API_KEY), roles: () => live.now() };
}

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.writeFileSync(rolesFile, ROLES);
  store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR, amount BIGINT, notes VARCHAR, meta JSON)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 'paid', 10, 'gift', '{\"k\": 1}'), (2, 'paid', 20, NULL, '{\"k\": 2}'), (3, 'pending', 5, 'rush', NULL)");
  await store.writer.run("CREATE TABLE public.customers (id BIGINT, name VARCHAR, email VARCHAR)");
  await store.writer.run("INSERT INTO public.customers VALUES (1, 'Ann', 'ann@example.com'), (2, 'Bo', 'bo@example.com')");
  await store.writer.run("CREATE TABLE public.events (id BIGINT, kind VARCHAR)");
  await store.writer.run("INSERT INTO public.events VALUES (1, 'click')");
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000 });
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    authenticate: (password, user) => { if (wired === null) throw new Error("not wired"); return wired.authenticate(password, user); },
    recheck: (t) => { if (wired?.recheck === undefined) throw new Error("not wired"); return wired.recheck(t); },
    recheckMs: 0,
    // no roles until a test wires them (the listener asks at its start too): src/duck/grants.ts NO_ROLES's shape
    roles: () => (wired === null ? { file: null, grants: new Map(), problem: null } : wired.roles()) as never,
    schema: () => schema,
    record: (row) => ledger.record(row), log: () => undefined,
    duck: await store.listener(undefined),
  });
});
after(async () => {
  await api.close();
  await ledger.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** a user with a role (or none), written as `mason user add --role` writes it: its password */
function addUser(name: string, role?: string): string {
  const id = newUserId();
  changeUsers(usersFile, (users) => [...users.filter((u) => u.name !== name), { name, id, addedAt: new Date().toISOString(), key: keyFingerprint(API_KEY), ...(role !== undefined ? { role } : {}) }]);
  return userPassword(API_KEY, name, id);
}
/** the user's role changed under it (the file `mason user` edits) */
function setRole(name: string, role: string | undefined): void {
  changeUsers(usersFile, (users) => users.map((u) => u.name === name ? { name: u.name, id: u.id, addedAt: u.addedAt, key: u.key, ...(role !== undefined ? { role } : {}) } : u));
}
async function connect(user: string, password: string, app = "Metabase"): Promise<pg.Client> {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "shop", user, password, application_name: app });
  await c.connect();
  return c;
}
type Refusal = { code: string; message: string; detail?: string; hint?: string; severity: string };
const refused = async (c: pg.Client, q: string | pg.QueryConfig): Promise<Refusal> =>
  c.query(q as string).then(() => assert.fail(`answered: ${typeof q === "string" ? q : q.text}`), (e: pg.DatabaseError) => ({ code: e.code!, message: e.message, severity: e.severity!,
    ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(e.hint !== undefined ? { hint: e.hint } : {}) }));
const ROLES_PATH = "mason/roles.yml";
// the HINT names the gap's row of docs/SQL-SUPPORT.md too, as every refusal names its entry (Mason gap roles)
const AGENT_ORDERS = `the role agent reads these columns of orders: id, status, amount (${ROLES_PATH} names what each role reads; Mason gap roles)`;

test("a role reads what it is granted: granted columns, count(*), a join on granted columns, a statement over no copied table", async () => {
  await wire();
  const c = await connect("agent", addUser("agent", "agent"));
  try {
    assert.deepEqual((await c.query("SELECT id, status FROM orders ORDER BY id")).rows, [{ id: "1", status: "paid" }, { id: "2", status: "paid" }, { id: "3", status: "pending" }]);
    assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 3 }], "count(*) needs any one granted column, as Postgres rules it");
    assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders WHERE status = 'paid'")).rows, [{ n: 2 }]);
    assert.deepEqual((await c.query("SELECT sum(o.amount)::int AS total FROM orders o JOIN customers c ON c.id = o.id WHERE c.name = 'Ann'")).rows, [{ total: 10 }]);
    assert.deepEqual((await c.query("SELECT * FROM customers ORDER BY id")).rows.map((r) => r.name), ["Ann", "Bo"], "a whole table granted: * is fine");
    assert.deepEqual((await c.query("SELECT 1 + 1 AS two")).rows, [{ two: 2 }], "no copied table read: untouched");
    assert.deepEqual((await c.query("SELECT id, status FROM order_status ORDER BY id")).rows.length, 3, "a view over granted columns");
  } finally { await c.end(); }
});

test("a hidden column is refused wherever Postgres's analysis finds it read, with Postgres's message and the role in the DETAIL", async () => {
  await wire();
  const c = await connect("agent", addUser("agent", "agent"));
  try {
    const shapes: Array<[string, string, string]> = [
      ["a WHERE", "SELECT id FROM orders WHERE notes IS NULL", "notes"],
      ["a CTE", "WITH n AS (SELECT notes FROM orders) SELECT count(*) FROM n", "notes"],
      ["a subquery", "SELECT (SELECT max(notes) FROM orders) AS m", "notes"],
      ["a view", "SELECT id FROM order_notes", "notes"],
      ["a window's PARTITION BY", "SELECT id, row_number() OVER (PARTITION BY notes ORDER BY id) FROM orders", "notes"],
      ["an ORDER BY", "SELECT id FROM orders ORDER BY notes", "notes"],
      ["a GROUP BY", "SELECT notes, count(*) FROM orders GROUP BY notes", "notes"],
      ["a CASE", "SELECT CASE WHEN notes IS NULL THEN 0 ELSE 1 END FROM orders", "notes"],
      ["a lateral's argument", "SELECT x.n FROM orders o CROSS JOIN LATERAL (SELECT o.notes AS n) x", "notes"],
      ["a json path of a hidden column", "SELECT meta->>'k' FROM orders", "meta"],
      ["SELECT * on a partly granted table", "SELECT * FROM orders", "notes"],
      ["t.* on a partly granted table", "SELECT o.* FROM orders o", "notes"],
      ["a whole-row reference", "SELECT o FROM orders o", "notes"],
      ["a count(*) inside a join reading a hidden column", "SELECT count(*) FROM orders o JOIN customers c ON c.name = o.notes", "notes"],
    ];
    for (const [shape, sql, column] of shapes) {
      const e = await refused(c, sql);
      assert.equal(e.code, "42501", `${shape}: ${sql}`);
      assert.equal(e.message, "permission denied for table orders", shape);
      assert.equal(e.detail, `the role agent may not read column ${column} of orders`, shape);
      assert.equal(e.hint, AGENT_ORDERS, shape);
      assert.equal(e.severity, "ERROR", shape);
    }
    // a table the role lacks entirely
    const none = await refused(c, "SELECT count(*) FROM events");
    assert.deepEqual([none.code, none.message, none.detail], ["42501", "permission denied for table events", "the role agent has no grant on events"]);
    assert.equal(none.hint, `the role agent reads: orders, customers (${ROLES_PATH} names what each role reads; Mason gap roles)`);
    // a system column needs the whole table, as on Postgres
    const sys = await refused(c, "SELECT xmin FROM orders");
    assert.deepEqual([sys.code, sys.detail], ["42501", "the role agent may read columns of orders, and a system column needs the whole table"]);
    // the session is kept: the next statement answers
    assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 3 }]);
    // Postgres's own refusal first: a column that does not exist is 42703, never 42501
    assert.equal((await refused(c, "SELECT nope FROM orders")).code, "42703");
  } finally { await c.end(); }
});

test("USING and NATURAL joins read the join column of each table: a role without it is refused; a prepared statement is held at its Parse", async () => {
  await wire();
  const c = await connect("narrow", addUser("narrow", "narrow"));
  try {
    for (const sql of ["SELECT status FROM orders JOIN customers USING (id)", "SELECT status FROM orders NATURAL JOIN customers"]) {
      const e = await refused(c, sql);
      assert.deepEqual([e.code, e.message, e.detail], ["42501", "permission denied for table orders", "the role narrow may not read column id of orders"], sql);
    }
    assert.deepEqual((await c.query("SELECT status, sum(amount)::int AS s FROM orders GROUP BY status ORDER BY status")).rows, [{ status: "paid", s: 30 }, { status: "pending", s: 5 }]);
    // the extended protocol: a Parse with a parameter
    const e = await refused(c, { text: "SELECT id FROM orders WHERE amount > $1", values: [1] });
    assert.deepEqual([e.code, e.detail], ["42501", "the role narrow may not read column id of orders"]);
    assert.deepEqual((await c.query({ text: "SELECT status FROM orders WHERE amount > $1 ORDER BY status", values: [8] })).rows, [{ status: "paid" }, { status: "paid" }]);
  } finally { await c.end(); }
});

test("exclude: and an explicit list of every column; a user with no role and a token read everything", async () => {
  await wire();
  const wide = await connect("wide", addUser("wide", "wide"));
  try {
    assert.equal((await wide.query("SELECT * FROM orders")).rows.length, 3, "every column named: * is fine");
    assert.deepEqual((await wide.query("SELECT id, name FROM customers ORDER BY id")).rows.map((r) => r.name), ["Ann", "Bo"]);
    const e = await refused(wide, "SELECT email FROM customers");
    assert.deepEqual([e.code, e.message, e.detail], ["42501", "permission denied for table customers", "the role wide may not read column email of customers"]);
    assert.equal(e.hint, `the role wide reads these columns of customers: id, name (${ROLES_PATH} names what each role reads; Mason gap roles)`);
    const star = await refused(wide, "SELECT * FROM customers");
    assert.equal(star.detail, "the role wide may not read column email of customers", "* is never narrowed to the granted columns");
  } finally { await wide.end(); }
  const plain = await connect("plain", addUser("plain"));
  try {
    assert.equal((await plain.query("SELECT * FROM orders")).rows.length, 3);
    assert.equal((await plain.query("SELECT email FROM customers")).rows.length, 2);
    assert.equal((await plain.query("SELECT kind FROM events")).rows.length, 1);
  } finally { await plain.end(); }
  const token = await connect("whoever", mintToken(API_KEY, 600).token, "psql");
  try { assert.equal((await token.query("SELECT notes FROM orders")).rows.length, 3); } finally { await token.end(); }
});

test("the role is read with the user at every statement: changed under a held session it applies at the next statement, and at an Execute of a statement prepared before", async () => {
  await wire();
  const password = addUser("shifting", "wide");
  const c = await connect("shifting", password);
  try {
    const q = { name: "notes_of", text: "SELECT notes FROM orders WHERE id = $1", values: [1] };
    assert.deepEqual((await c.query(q)).rows, [{ notes: "gift" }]);
    setRole("shifting", "agent");
    // the same named statement: Bind + Execute only, no Parse — held to the role of THIS moment
    const e = await refused(c, q);
    assert.deepEqual([e.code, e.message, e.detail], ["42501", "permission denied for table orders", "the role agent may not read column notes of orders"]);
    assert.deepEqual((await c.query("SELECT status FROM orders WHERE id = 1")).rows, [{ status: "paid" }], "the session goes on under the new role");
    // the role taken away: every table again
    setRole("shifting", undefined);
    assert.deepEqual((await c.query(q)).rows, [{ notes: "gift" }]);
    // and given: the statement prepared under no role is held at its next Execute as well
    setRole("shifting", "narrow");
    assert.equal((await refused(c, q)).code, "42501");
  } finally { await c.end(); }
});

test("FAIL CLOSED: a role the file no longer names refuses the user by name, a file that cannot be read refuses 57P03, a repaired file answers again — no restart", async () => {
  await wire();
  const c = await connect("agent", addUser("agent", "agent"));
  const plain = await connect("plain", addUser("plain"));
  try {
    assert.equal((await c.query("SELECT count(*) FROM orders")).rows.length, 1);
    // the role removed from the file (the agent's users keep their role: nothing is widened)
    fs.writeFileSync(rolesFile, ROLES.replace(/  agent:\n    tables:\n      orders:\n        columns: \[id, status, amount\]\n      customers: \{\}\n/, ""));
    const gone = await refused(c, "SELECT count(*) FROM orders");
    assert.equal(gone.code, "42501");
    assert.equal(gone.message, `permission denied: the role agent of the user "agent" is not in ${ROLES_PATH}`);
    assert.match(gone.detail ?? "", /^the user keeps the role it was added with; a role the file no longer names reads nothing until it is added again or the user is made again \(the roles: wide, narrow\)$/);
    assert.equal(gone.hint, `add the role agent to ${ROLES_PATH}, or mason user remove agent and mason user add agent --role wide`);
    assert.equal((await refused(c, "SELECT 1")).code, "42501", "a catalog statement of the session too: the role is checked before the catalog runs it");
    assert.deepEqual((await plain.query("SELECT 1 AS one")).rows, [{ one: 1 }], "a user with no role is not held to the file");
    // the file broken: refused, said, the last good grants kept for the catalog
    fs.writeFileSync(rolesFile, "roles: [not a map");
    const broken = await refused(c, "SELECT count(*) FROM orders");
    assert.equal(broken.code, "57P03");
    assert.match(broken.message, /^the roles file cannot be read as it is now, so the role agent's statements are refused: /);
    assert.match(broken.hint ?? "", new RegExp(`^fix ${ROLES_PATH}: the role agent is the user "agent"'s`));
    assert.deepEqual((await plain.query("SELECT count(*)::int AS n FROM events")).rows, [{ n: 1 }]);
    // a file naming a table the sources file does not copy, or a column the copy lacks: the same, by key
    fs.writeFileSync(rolesFile, `${ROLES}  typo:\n    tables:\n      orders:\n        columns: [id, statuss]\n`);
    const typo = await refused(c, "SELECT count(*) FROM orders");
    assert.equal(typo.code, "57P03");
    assert.match(typo.message, /roles\.typo\.tables\.orders\.columns: the copy of public\.orders has no column statuss — did you mean `status`\? \(its columns: id, status, amount, notes, meta\)/);
    // repaired: the same session answers again, with its role
    fs.writeFileSync(rolesFile, ROLES);
    assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 3 }]);
    assert.equal((await refused(c, "SELECT notes FROM orders")).code, "42501");
  } finally { fs.writeFileSync(rolesFile, ROLES); await c.end(); await plain.end(); }
});

test("two sessions with different roles in one listener: the same statement answered to one and refused to the other, interleaved", async () => {
  await wire();
  const a = await connect("agent", addUser("agent", "agent"));
  const w = await connect("wide", addUser("wide", "wide"));
  const n = await connect("plain", addUser("plain"));
  try {
    const sql = "SELECT count(notes)::int AS n FROM orders";
    for (let round = 0; round < 3; round++) {
      const [ra, rw, rn] = await Promise.all([refused(a, sql), w.query(sql), n.query(sql)]);
      assert.equal(ra.detail, "the role agent may not read column notes of orders", `round ${round}`);
      assert.deepEqual(rw.rows, [{ n: 2 }], `round ${round}`);
      assert.deepEqual(rn.rows, [{ n: 2 }], `round ${round}`);
    }
    // the plan is cached per role: agent's statement over granted columns is answered after wide's plan of the same text
    const same = "SELECT sum(amount)::int AS s FROM orders";
    assert.deepEqual((await w.query(same)).rows, [{ s: 35 }]);
    assert.deepEqual((await a.query(same)).rows, [{ s: 35 }]);
  } finally { await a.end(); await w.end(); await n.end(); }
});

test("the catalog answers for the role: information_schema and the privilege functions, a session with no role sees everything, two sessions interleaved; pg_catalog still lists every column", async () => {
  await wire();
  const a = await connect("agent", addUser("agent", "agent"));
  const n = await connect("plain", addUser("plain"));
  try {
    const tables = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1";
    const columns = "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('orders', 'customers', 'events') ORDER BY 1, 2";
    assert.deepEqual((await a.query(tables)).rows.map((r) => r.table_name), ["customers", "order_notes", "order_status", "orders"], "the tables it may read, and every view");
    assert.deepEqual((await a.query(columns)).rows.map((r) => `${r.table_name}.${r.column_name}`),
      ["customers.email", "customers.id", "customers.name", "orders.amount", "orders.id", "orders.status"]);
    assert.deepEqual((await n.query(tables)).rows.map((r) => r.table_name), ["customers", "events", "order_notes", "order_status", "orders"]);
    assert.equal((await n.query(columns)).rows.length, 10);
    const priv = "SELECT has_table_privilege('orders', 'SELECT') AS t, has_any_column_privilege('orders', 'SELECT') AS a, has_column_privilege('orders', 'notes', 'SELECT') AS hidden, " +
      "has_column_privilege('orders', 'status', 'SELECT') AS shown, has_table_privilege('events', 'SELECT') AS e, current_user AS who";
    assert.deepEqual((await a.query(priv)).rows, [{ t: false, a: true, hidden: false, shown: true, e: false, who: "agent" }], "as Postgres answers under column grants");
    assert.deepEqual((await n.query(priv)).rows[0].t, true);
    // interleaved: each session's catalog request runs under its own role, in one request each
    for (let round = 0; round < 4; round++) {
      const [ra, rn] = await Promise.all([a.query(tables), n.query(tables)]);
      assert.equal(ra.rows.length, 4, `round ${round}`);
      assert.equal(rn.rows.length, 5, `round ${round}`);
    }
    // a catalog error under the role leaves the catalog in step: the next statements of both answer
    assert.equal((await refused(a, "SELECT * FROM information_schema.no_such_view")).code, "42P01");
    assert.equal((await a.query(tables)).rows.length, 4);
    assert.equal((await n.query(tables)).rows.length, 5);
    // not filtered in this stage, said in docs/POSTGRES-API.md: pg_catalog lists every copied column to every role
    const pgc = "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attnum > 0";
    assert.deepEqual((await a.query(pgc)).rows, [{ n: 5 }]);
  } finally { await a.end(); await n.end(); }
});

test("the review of #35: no way around the role's catalog view (set_config revoked), SET ROLE / SESSION AUTHORIZATION refused as Postgres refuses them, session_user is the session's user, pg_catalog is no copied table", async () => {
  await wire();
  const a = await connect("agent", addUser("agent", "agent"));
  const n = await connect("plain", addUser("plain"));
  try {
    // set_config('role', 'none') inside ONE catalog statement was a permitted RESET ROLE: the statement's later targets ran as the superuser
    const escape = "SELECT set_config('role', 'none', false) AS a, (SELECT count(*) FROM information_schema.tables WHERE table_name = 'events') AS b, current_user AS u";
    const e = await refused(a, escape);
    assert.deepEqual([e.code, e.message], ["42501", "permission denied for function set_config"]);
    for (const sql of ["SELECT set_config('session_authorization', 'postgres', false)", "SELECT set_config('role', 'wide', false)",
      "WITH x AS (SELECT set_config('role', 'none', false)) SELECT count(*) FROM x, information_schema.columns WHERE table_name = 'orders'"]) {
      assert.equal((await refused(a, sql)).code, "42501", sql);
    }
    assert.equal((await refused(a, { text: "SELECT set_config('role', $1, false)", values: ["none"] })).code, "42501", "the extended protocol too");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'events'")).rows[0].n, 0, "the next statement is the role's still");
    assert.deepEqual((await n.query("SELECT set_config('application_name', 'x', false) AS s")).rows, [{ s: "x" }], "a session with no role is the superuser's: set_config kept");
    // SET ROLE / SET SESSION AUTHORIZATION: its own name, NONE and RESET are no-ops; any other name is Postgres's refusal
    for (const sql of ["SET ROLE agent", "SET ROLE NONE", "RESET ROLE", "SET SESSION AUTHORIZATION agent", "SET SESSION AUTHORIZATION DEFAULT", "SET LOCAL ROLE agent"]) await a.query(sql);
    for (const [sql, message] of [["SET ROLE postgres", 'permission denied to set role "postgres"'], ["SET ROLE wide", 'permission denied to set role "wide"'], ["SET role = 'wide'", 'permission denied to set role "wide"'],
      ["SET SESSION AUTHORIZATION postgres", 'permission denied to set session authorization "postgres"'], ["SET SESSION AUTHORIZATION plain", 'permission denied to set session authorization "plain"']] as const) {
      const r = await refused(a, sql);
      assert.deepEqual([r.code, r.message], ["42501", message], sql);
    }
    assert.equal((await refused(n, "SET ROLE agent")).code, "42501", "a session with no role is its user too");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'events'")).rows[0].n, 0, "still the role's view");
    // session_user is the session's user; current_user the role (SET ROLE's), as on Postgres
    assert.deepEqual((await a.query("SELECT session_user, current_user, session_user::text || '!' AS t, (SELECT session_user) AS sub")).rows, [{ session_user: "agent", current_user: "agent", t: "agent!", sub: "agent" }]);
    assert.deepEqual((await n.query("SELECT session_user")).rows, [{ session_user: "plain" }]);
    assert.deepEqual((await n.query({ text: "SELECT session_user, $1::text AS p", values: ["v"] })).rows, [{ session_user: "plain", p: "v" }], "the extended protocol too");
    assert.deepEqual((await n.query("SELECT 'session_user' AS s, lower('SESSION_USER') AS l")).rows, [{ s: "session_user", l: "session_user" }], "a string is no keyword");
    assert.deepEqual((await n.query("SHOW session_authorization")).rows, [{ session_authorization: "plain" }]);
    // pg_class is no copied table: a join of it is never the role's refusal (main's honest 0A000 for a pg_catalog table beside a copy)
    const pgc = await refused(a, "SELECT c.relname, o.id FROM pg_class c JOIN orders o ON o.id = c.oid");
    assert.notEqual(pgc.code, "42501", pgc.message);
    assert.equal(pgc.code, (await refused(n, "SELECT c.relname, o.id FROM pg_class c JOIN orders o ON o.id = c.oid")).code, "the same answer as a session with no role");
  } finally { await a.end(); await n.end(); }
});

test("every statement of a user's session is a row of the request log with its role; a refusal is recorded as the refusal", async () => {
  await wire();
  await ledger.flush();
  const rows = await ledger.recent({ limit: 500 });
  const agent = rows.filter((r) => r.user === "agent" && r.method === "QUERY");
  assert.ok(agent.length > 10, "agent's statements");
  assert.ok(agent.every((r) => r.role === "agent"), "each carries the role");
  const refusal = agent.find((r) => r.query === "SELECT * FROM orders");
  assert.deepEqual([refusal?.outcome, refusal?.sqlstate, refusal?.message, refusal?.detail], ["refused", "42501", "permission denied for table orders", "the role agent may not read column notes of orders"]);
  assert.ok(rows.filter((r) => r.user === "plain").every((r) => r.role === ""), "a user with no role: none");
  const shifting = rows.filter((r) => r.user === "shifting").map((r) => r.role);
  assert.deepEqual([...new Set(shifting)].sort(), ["", "agent", "narrow", "wide"], "the role of the moment, per statement");
});
