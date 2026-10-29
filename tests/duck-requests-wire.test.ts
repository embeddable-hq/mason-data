/**
 * THE DUCKDB RUN'S REQUEST LOG, THROUGH THE LISTENER (src/api/postgres/server.ts `recordRequest` → src/duck/requests.ts;
 * a BI tool met an error on the test server and nothing could be found afterwards). A real Postgres listener over a
 * throwaway DuckStore, its `record` the ledger as `mason start` wires it: every statement DuckDB answered is a row with
 * its rows and time; every refused statement — a simple Query's, a Parse's, a syntax error — a row with its SQLSTATE,
 * message, DETAIL and HINT, from `refuse`, the one sender of a statement's ErrorResponse; a refused password a row of
 * its own (CONNECT); a catalog read or a SET answered is none; and a ledger that cannot write leaves every answer as it
 * was.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { ApiLogRow } from "../src/api/request-log.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-requests-wire-"));
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;
/** what record() was handed, beside the ledger: the listener's rows as built */
let recorded: ApiLogRow[] = [];
/** when set, the ledger's write fails with it */
let failWrites: string | null = null;
const said: string[] = [];

const schema: PgSchema = {
  database: "app",
  tables: [{ name: "orders", primaryKey: ["id"], joins: [],
    columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }, { name: "qty", type: "int4" }] }],
};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, status VARCHAR, qty INTEGER)");
  await store.writer.run("INSERT INTO public.orders VALUES (1, 'paid', 2), (2, 'paid', 1), (3, 'pending', 5)");
  const real = await store.instance.connect();
  // written only when a test flushes (a minute's timer never fires here): a batch holds exactly what the test sent
  ledger = await RequestLedger.open(store, (l) => said.push(l), { days: 7, flushMs: 60_000,
    insert: async (sql, values) => { if (failWrites !== null) throw new Error(failWrites); await real.run(sql, values); } });
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema,
    record: (row) => { recorded.push(row); ledger.record(row); }, log: () => undefined,
    duck: await store.listener(undefined),
  });
});
after(async () => {
  await api.close();
  await ledger.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = async (applicationName = "Metabase"): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token, application_name: applicationName });
  await c.connect();
  return c;
};

test("every statement DuckDB answered and every refusal is a row of _mason.requests; a catalog read or a SET is none", async () => {
  recorded = [];
  const c = await client();
  try {
    await c.query("SET TimeZone = 'UTC'");
    await c.query("SELECT relname FROM pg_catalog.pg_class LIMIT 1");
    assert.equal((await c.query("SELECT id, qty FROM orders WHERE status = 'paid' ORDER BY id")).rows.length, 2);
    // the extended protocol: a Parse, a Bind and an Execute, one request
    assert.equal((await c.query("SELECT id FROM orders WHERE qty > $1", [1])).rows.length, 2);
    await assert.rejects(c.query("SELECT * FROM nope"), /relation "nope" does not exist/);
    await assert.rejects(c.query({ text: "SELECT id FROM nope WHERE id = $1", values: [1] }), /relation "nope" does not exist/);
    await assert.rejects(c.query("SELEC 1"), /syntax error/);
  } finally { await c.end(); }
  // a tool whose password is wrong: its CONNECT is a request too
  const bad = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: "not-a-token", application_name: "Grafana" });
  await assert.rejects(bad.connect(), /password authentication failed/);
  await ledger.flush();
  const rows = await ledger.recent({ limit: 100 });
  assert.deepEqual(rows.map((r) => [r.method, r.outcome, r.sqlstate, r.rows, r.query]), [
    ["QUERY", "ok", null, 2, "SELECT id, qty FROM orders WHERE status = 'paid' ORDER BY id"],
    ["EXECUTE", "ok", null, 2, "SELECT id FROM orders WHERE qty > $1"],
    ["QUERY", "refused", "42P01", null, "SELECT * FROM nope"],
    ["PARSE", "refused", "42P01", null, "SELECT id FROM nope WHERE id = $1"],
    ["QUERY", "refused", "42601", null, "SELEC 1"],
    ["CONNECT", "refused", "28P01", null, ""],
  ], "the SET and the catalog read are not requests");
  assert.ok(rows.slice(0, 5).every((r) => r.applicationName === "Metabase" && r.session !== null), "who asked: the application_name and the session");
  assert.match(rows[2]!.message ?? "", /relation "nope" does not exist/);
  assert.match(rows[2]!.hint ?? "", /mason add/, "the HINT the tool was sent with the refusal");
  assert.equal(rows[5]!.applicationName, "Grafana");
  assert.match(rows[5]!.message ?? "", /password authentication failed for user "mason"/);
  assert.match(rows[5]!.hint ?? "", /a tool that keeps one password connects as a user: mason user add <name> prints its password and URL/, "the HINT the tool was sent");
  assert.ok(rows.every((r) => !r.query.includes(API_KEY) && r.tokenName === ""), "never the token");
  assert.ok(recorded.every((r) => r.client?.startsWith("postgres:") === true && r.caller !== undefined && !JSON.stringify(r).includes("not-a-token")),
    "the password a tool presented is never in the row: its hash is (hashCaller)");
  assert.deepEqual(said, []);
});

test("a statement an Execute's row count stopped is a row of _mason.requests when its portal is dropped, with the rows it sent", async () => {
  recorded = [];
  await ledger.flush();
  const before = (await ledger.recent({ limit: 1000 })).length;
  const { PgConnection } = await import("../src/cdc/pg-wire.ts");
  const c = await PgConnection.connect({ host: "127.0.0.1", port: api.port, user: "mason", password: mintToken(API_KEY, 600).token, database: "app",
    sslmode: "disable", connectTimeoutMs: 5_000, applicationName: "jdbc-maxrows" });
  try {
    // JDBC's setMaxRows, mason mcp's max_rows: one Execute at a row count, then Sync drops the portal unread
    const cut = await c.extended("SELECT id FROM orders ORDER BY id", 2);
    assert.deepEqual([cut.rows, cut.suspended], [[["1"], ["2"]], true]);
    // and read to its end: its row at its last row, as before
    const whole = await c.extended("SELECT id FROM orders ORDER BY id DESC", 5);
    assert.deepEqual([whole.rows.length, whole.suspended], [3, false]);
  } finally { c.close(); }
  await ledger.flush();
  const rows = (await ledger.recent({ limit: 1000 })).slice(before);
  assert.deepEqual(rows.map((r) => [r.method, r.outcome, r.rows, r.query, r.applicationName]), [
    ["EXECUTE", "ok", 2, "SELECT id FROM orders ORDER BY id", "jdbc-maxrows"],
    ["EXECUTE", "ok", 3, "SELECT id FROM orders ORDER BY id DESC", "jdbc-maxrows"],
  ], "one row each: the one stopped at its row count with the rows it sent");
});

test("a ledger that cannot write leaves every answer as it was, and says so once", async () => {
  failWrites = "disk full";
  const c = await client("psql");
  try {
    assert.deepEqual((await c.query("SELECT count(*)::int AS n FROM orders")).rows, [{ n: 3 }]);
    await assert.rejects(c.query("SELECT * FROM nope"), /relation "nope" does not exist/, "a refusal is the same refusal");
    await ledger.flush();
    assert.deepEqual((await c.query("SELECT max(qty) AS m FROM orders")).rows, [{ m: 5 }]);
  } finally { await c.end(); await ledger.flush(); failWrites = null; }
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0]!, /^request log: could not record 2 request\(s\) in _mason\.requests \(.+\): disk full; said once until a write succeeds$/);
});
