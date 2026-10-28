/**
 * `mason user` AGAINST A REAL LISTENER (src/duck/users.ts, src/cli/user.ts): a Postgres listener over a throwaway
 * DuckStore, its logins wired as `mason start` wires them (`listenerLogins` over the project's `.mason/users.json`), and
 * `mason user add` / `remove` run as PROCESSES beside it, as they run beside a run or `mason serve`. The URL add prints
 * connects; the user name must be the user's (28P01 with the reason); a token still connects as before; a removal
 * refuses the next connection and ends a held session at its next statement, without a restart; a list that cannot be
 * read refuses (57P03), never lets in; and every statement of a user's session is that user's row of the request log.
 * src/duck/users.ts is imported inside the tests, so a run without it fails each test by name (scripts/fails-without.ts).
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const API_KEY = "k".repeat(48);
const RUN_TOKEN = "t".repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-users-wire-"));
/** the project folder: `.mason/` holds the config, the users file and the DuckDB file */
const root = path.join(dir, "project");
const home = path.join(root, ".mason");
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;
let control: http.Server;
const env = matrixEnv({ HOME: dir, PATH: path.dirname(process.execPath) });

const schema: PgSchema = {
  database: "shop",
  tables: [{ name: "orders", primaryKey: ["id"], joins: [],
    columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }] }],
};

/** the logins as the run wires them, made once the module loads (inside a test: see the header) */
let logins: Pick<PgApiOptions, "authenticate" | "recheck" | "recheckMs"> | null = null;
async function wired(): Promise<void> {
  const u = await import("../src/duck/users.ts");
  logins ??= u.listenerLogins(new u.LiveUsers(path.join(home, u.USERS_FILE), API_KEY), API_KEY);
}

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 'paid'), (2, 'paid'), (3, 'pending')");
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000 });
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test",
    // the run's own wiring, read when a login arrives (the module may not exist where this test proves itself)
    authenticate: (password, user) => { if (logins === null) throw new Error("not wired"); return logins.authenticate(password, user); },
    recheck: (t) => { if (logins?.recheck === undefined) throw new Error("not wired"); return logins.recheck(t); },
    recheckMs: 0,
    schema: () => schema,
    record: (row) => ledger.record(row), log: () => undefined,
    duck: await store.listener(undefined),
  });
  // the run's command server, as far as `mason user` asks it: is the run up (src/cli/runs.ts answers)
  control = http.createServer((req, res) => {
    if (req.url === "/api/ping" && req.headers.authorization === `Bearer ${RUN_TOKEN}`) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid, service: true })); return; }
    // GET /api/users as the run answers it (src/cli/run-server.ts): the same functions, over this test's ledger
    if (req.url === "/api/users?lastUsed=1" && req.headers.authorization === `Bearer ${RUN_TOKEN}`) {
      void (async () => {
        const m = await import("../src/cli/user.ts");
        const { postgresLink } = await import("../src/cli/pg-url.ts");
        const r = m.listUsers(path.join(home, "users.json"), API_KEY, postgresLink(`postgresql://127.0.0.1:${api.port}/shop`));
        if ("message" in r) { res.writeHead(500).end("{}"); return; }
        const used = await m.withLastUsed(r.users, ledger, () => undefined);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...used, urlNote: null }));
      })();
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    name: "shop", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false, apiKey: API_KEY, sourceServer: null, lastRun: null,
    running: { pid: process.pid, controlUrl: url, token: RUN_TOKEN, postgresUrl: `postgresql://127.0.0.1:${api.port}/shop`, postgresListener: { host: "127.0.0.1", tls: null } },
  }), { mode: 0o600 });
});
after(async () => {
  await api.close();
  await ledger.close();
  store.close();
  await new Promise<void>((resolve) => control.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `mason user …` as a process in the project, its JSON answer */
async function masonUser(...args: string[]): Promise<Record<string, unknown>> {
  const a = await runMason(root, ["user", ...args, "--json"], env);
  assert.equal(a.code, 0, `mason user ${args.join(" ")}: ${a.stderr}${a.stdout}`);
  return JSON.parse(a.stdout) as Record<string, unknown>;
}

const connect = async (o: { url?: string; user?: string; password?: string; app?: string }): Promise<pg.Client> => {
  const c = new pg.Client(o.url !== undefined ? { connectionString: o.url, application_name: o.app ?? "Metabase" }
    : { host: "127.0.0.1", port: api.port, database: "shop", user: o.user, password: o.password, application_name: o.app ?? "Metabase" });
  await c.connect();
  return c;
};
/** a connection refused: its SQLSTATE and message */
const refusedWith = async (o: Parameters<typeof connect>[0]): Promise<pg.DatabaseError> => {
  const c = new pg.Client(o.url !== undefined ? { connectionString: o.url } : { host: "127.0.0.1", port: api.port, database: "shop", user: o.user, password: o.password });
  try { await c.connect(); } catch (e) { return e as pg.DatabaseError; } finally { await c.end().catch((e: Error) => { if (!/not connected|ended/.test(e.message)) throw e; }); }
  assert.fail("it connected");
};

test("mason user add prints the URL a tool pastes: it connects as that user, and the user name must be the user's", async () => {
  await wired();
  const added = await masonUser("add", "metabase");
  assert.deepEqual(Object.keys(added).sort(), ["addedAt", "database", "host", "id", "next", "password", "port", "sslmode", "url", "user"]);
  assert.equal(added.user, "metabase");
  assert.equal(added.url, `postgres://metabase:${added.password as string}@127.0.0.1:${api.port}/shop`, "the one URL builder: the user and its password");
  assert.deepEqual([added.host, added.port, added.database, added.sslmode], ["127.0.0.1", api.port, "shop", "disable"]);
  const c = await connect({ url: added.url as string });
  try { assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders WHERE status = 'paid'")).rows, [{ n: 2 }]); }
  finally { await c.end(); }
  // the password names its user: another name is a failed password, whose it is unsaid (the name would be the login)
  const wrong = await refusedWith({ user: "mason", password: added.password as string });
  assert.equal(wrong.code, "28P01");
  assert.equal(wrong.message, `password authentication failed for user "mason": not a password of this project's users: mason user list shows them`);
  assert.ok(!/metabase/.test(wrong.message), "whose password it is stays unsaid");
  // the human answer carries the same URL, on a line of its own, and never says "token"
  const h = await runMason(root, ["user", "add", "grafana"], env);
  assert.equal(h.code, 0, h.stderr);
  assert.match(h.stdout, new RegExp(`^ {2}url +postgres://grafana:mason_[0-9a-f]{16}_[0-9a-f]{32}@127\\.0\\.0\\.1:${api.port}/shop$`, "m"));
  assert.match(h.stdout, /^The user grafana added: its password is printed this once$/m);
  assert.match(h.stdout, /Rotating the API key .* removes every user at once/);
  assert.doesNotMatch(h.stdout, /token|credential/i);
  // a name is one user
  const again = await runMason(root, ["user", "add", "metabase", "--json"], env);
  assert.equal(again.code, 1);
  assert.equal((JSON.parse(again.stdout) as { error: { code: string; message: string } }).error.message, 'there is already a user "metabase"');
});

test("a token minted from the API key still connects as before, with any user name; the API key as a password is still refused by name", async () => {
  await wired();
  const c = await connect({ user: "whoever", password: mintToken(API_KEY, 600).token, app: "psql" });
  try { assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 3 }]); }
  finally { await c.end(); }
  const key = await refusedWith({ user: "mason", password: API_KEY });
  assert.equal(key.code, "28P01");
  assert.match(key.message, /the API key is not a password here: mason user add <name> makes a user whose password does not expire/);
  assert.match((key as pg.DatabaseError & { hint?: string }).hint ?? "", /mason user add <name> prints its password and URL/);
});

test("mason user remove, beside the listener: the next connection is refused at once, and a held session ends at its next statement", async () => {
  await wired();
  const added = await masonUser("add", "superset");
  const held = await connect({ url: added.url as string, app: "Superset" });
  // the FATAL also reaches the client as an 'error' event once the socket ends: the query's rejection below is what is held
  const ended: Error[] = [];
  held.on("error", (e) => { ended.push(e); });
  assert.equal((await held.query("SELECT 1 AS one")).rows[0].one, 1, "a catalog statement too is the session's");
  const removed = await masonUser("remove", "superset");
  assert.deepEqual(removed.removed, { name: "superset", id: added.id, addedAt: added.addedAt, removedAt: (removed.removed as { removedAt: string }).removedAt });
  assert.match((removed.removed as { removedAt: string }).removedAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  // the held session: its next statement — any statement — ends it, FATAL, with the reason
  const e = await held.query("SELECT 1").then(() => assert.fail("it answered"), (x: pg.DatabaseError) => x);
  assert.equal(e.code, "28000");
  assert.equal(e.message, `the session's user is no longer accepted: the user "superset" was removed`);
  assert.equal(e.severity, "FATAL");
  await held.end().catch((x: Error) => { if (!/not connected|ended|terminated/.test(x.message)) throw x; });
  assert.ok(ended.every((x) => /no longer accepted|terminated|ended/.test(x.message)), ended.map((x) => x.message).join("; "));
  // a new connection with the old password: refused, said as removed
  const again = await refusedWith({ url: added.url as string });
  assert.equal(again.code, "28P01");
  assert.match(again.message, /the user "superset" was removed \(mason user list shows the users; mason user add superset makes it again, with a new password\)/);
  // and the list keeps it, marked removed: it does not connect, and has no URL to paste
  await ledger.flush();
  const listAll = await masonUser("list");
  assert.deepEqual([listAll.lastUsedNote, listAll.urlNote, listAll.requestLogDays], [null, null, 7]);
  const listed = listAll.users as Array<{ name: string; removedAt: string | null; live: boolean; url: string | null; lastUsedAt: string | null }>;
  // last used: the newest statement of the run's request log (metabase ran one above); the URL: without the password
  assert.match(listed.find((u) => u.name === "metabase")!.lastUsedAt ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.equal(listed.find((u) => u.name === "grafana")!.lastUsedAt, null, "grafana never ran a statement");
  assert.equal(listed.find((u) => u.name === "metabase")!.url, `postgres://metabase@127.0.0.1:${api.port}/shop`);
  assert.deepEqual(listed.filter((u) => u.removedAt === null).map((u) => u.name), ["metabase", "grafana"]);
  const gone = listed.find((u) => u.name === "superset")!;
  assert.deepEqual([gone.removedAt, gone.live, gone.url], [(removed.removed as { removedAt: string }).removedAt, false, null]);
  // the name added again is a new user, with a new password that connects; the removed entry stays
  const back = await masonUser("add", "superset");
  assert.notEqual(back.id, added.id);
  const c = await connect({ url: back.url as string, app: "Superset" });
  try { assert.equal((await c.query("SELECT 1 AS one")).rows[0].one, 1); } finally { await c.end(); }
  const again2 = await refusedWith({ url: added.url as string });
  assert.match(again2.message, /the user "superset" was removed/, "the old password is still refused");
});

test("FAIL CLOSED: a users file that cannot be read refuses a user's connection (57P03) and its session's statements, never lets it in; a token is untouched", async () => {
  await wired();
  const added = await masonUser("add", "looker");
  const held = await connect({ url: added.url as string, app: "Looker" });
  const file = path.join(home, "users.json");
  const good = fs.readFileSync(file, "utf8");
  try {
    fs.writeFileSync(file, "{ half written");
    const r = await refusedWith({ url: added.url as string });
    assert.equal(r.code, "57P03");
    assert.match(r.message, /^the password could not be checked for user "looker": the list of users cannot be read, so no user can connect: .*users\.json is not valid JSON/);
    // the held session: the statement refused, the session kept, asked again at the next
    const e = await held.query("SELECT count(*) FROM orders").then(() => assert.fail("it answered"), (x: pg.DatabaseError) => x);
    assert.equal(e.code, "57P03");
    assert.match(e.message, /the list of users cannot be read/);
    // a token's session never reads the file
    const t = await connect({ user: "mason", password: mintToken(API_KEY, 600).token });
    await t.end();
  } finally { fs.writeFileSync(file, good); }
  assert.deepEqual((await held.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 3 }], "repaired: the same session answers again");
  await held.end();
});

test("every statement of a user's session is that user's row of the request log; a refused login names the user it asked for", async () => {
  await wired();
  await ledger.flush();
  const rows = await ledger.recent({ limit: 200 });
  const of = (user: string): Array<[string, string, string | null]> => rows.filter((r) => r.user === user).map((r) => [r.method, r.outcome, r.sqlstate]);
  assert.deepEqual(of("metabase"), [["QUERY", "ok", null]], "metabase's one statement");
  // the refused login as "mason" with metabase's password is the user it asked for: "mason"
  assert.ok(rows.some((r) => r.method === "CONNECT" && r.user === "mason" && r.sqlstate === "28P01" && /not a password of this project's users/.test(r.message ?? "")));
  // superset: its statement, then the one its session was ended at, then the refused connection after the removal
  assert.deepEqual(of("superset"), [["QUERY", "refused", "28000"], ["CONNECT", "refused", "28P01"], ["CONNECT", "refused", "28P01"]],
    "the SELECT 1 is the catalog's, no request; the statement the session ended at; the connection refused after; the name added again connects (a catalog statement, no request); the old password refused again");
  assert.equal(rows.find((r) => r.user === "superset" && r.sqlstate === "28000")?.query, "SELECT 1");
  assert.deepEqual(of("looker"), [["CONNECT", "failed", "57P03"], ["QUERY", "failed", "57P03"], ["QUERY", "ok", null]]);
  // a token's session is no user's
  assert.ok(rows.filter((r) => r.applicationName === "psql").every((r) => r.user === ""));
  assert.ok(rows.every((r) => !r.query.includes("mason_")), "never a password");
});

test("mason user list with Mason NOT running still lists, removed ones too: last used and the URL are null, each with its reason — never a guess", async () => {
  const file = path.join(home, "config.json");
  const was = fs.readFileSync(file, "utf8");
  const stopped = JSON.parse(was) as Record<string, unknown>;
  delete stopped.running;
  fs.writeFileSync(file, JSON.stringify(stopped), { mode: 0o600 });
  try {
    const l = await masonUser("list");
    const rows = l.users as Array<{ name: string; removedAt: string | null; lastUsedAt: string | null; url: string | null }>;
    assert.ok(rows.some((u) => u.removedAt !== null), "removed users are listed");
    assert.ok(rows.every((u) => u.lastUsedAt === null && u.url === null));
    assert.match(String(l.lastUsedNote), /^unknown: Mason is not running/);
    assert.match(String(l.urlNote), /^unknown: Mason is not running/);
    assert.equal(l.requestLogDays, null);
    const human = await runMason(root, ["user", "list"], env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /removed 20\d\d-\d\d-\d\d \d\d:\d\d UTC/);
    assert.match(human.stdout, /last used unknown\b[\s\S]*Last used: unknown: Mason is not running/);
  } finally { fs.writeFileSync(file, was, { mode: 0o600 }); }
});
