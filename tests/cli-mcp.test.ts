/**
 * `mason mcp` AGAINST A REAL LISTENER (src/cli/mcp.ts): a Postgres listener over a throwaway DuckStore, its logins a
 * project's `.mason/users.json` as `mason start` wires them, a user added to it, and `mason mcp --url <the user's URL>`
 * spawned as an MCP client spawns it — driven over stdio by a minimal JSON-RPC client here. What it must hold:
 *   - initialize answers in kind; tools/list is exactly tables, describe, query, explain, with their input schemas;
 *     resources/list and resources/read are the agent's guide and mason help mcp;
 *   - tables and describe say what the catalog has, with each copy's rows and how it is kept current (the sync's words,
 *     read through EXPLAIN over the wire);
 *   - query answers a GROUP BY with Postgres's types, is truncated at max_rows, stops at timeout_ms with 57014, and a
 *     refused statement is an MCP tool error carrying the SQLSTATE and the gap's way out — never a stack;
 *   - stdout carries JSON-RPC frames alone; every statement is a row of the request log under mason-mcp/<client>;
 *   - no URL, a bad URL, a URL nothing answers at or a refused password: the failure shape, before the protocol starts.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckStore } from "../src/duck/store.ts";
import { RequestLedger } from "../src/duck/requests.ts";
import { startPostgresApi, type PgApiOptions, type PgApiServer } from "../src/api/postgres/server.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { CopyState } from "../src/duck/sync.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const API_KEY = "k".repeat(48);
const RUN_TOKEN = "t".repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-mcp-"));
const root = path.join(dir, "project");
const home = path.join(root, ".mason");
let store: DuckStore;
let api: PgApiServer;
let ledger: RequestLedger;
let control: http.Server;
/** the URL `mason user add claude` printed */
let url = "";
const env = matrixEnv({ HOME: dir, PATH: path.dirname(process.execPath) });

const schema: PgSchema = {
  database: "shop",
  tables: [
    { name: "orders", primaryKey: ["id"], description: "one row an order",
      joins: [{ name: "customers", table: "public.customers", on: ["customer_id", "id"], relationship: "many_to_one" }],
      columns: [{ name: "id", type: "int8", notNull: true }, { name: "customer_id", type: "int8" }, { name: "status", type: "text", description: "paid or pending" },
        { name: "amount", type: "numeric", spelled: "numeric(12,2)" }, { name: "meta", type: "jsonb" }] },
    { name: "customers", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8", notNull: true }, { name: "meta", type: "jsonb" }] },
    // big enough that a cross join of it outlives a timeout; the sync has no record of it
    { name: "events", primaryKey: [], joins: [], columns: [{ name: "id", type: "int4" }] },
  ],
};

/** how the sync holds each copy: orders polled, customers over the poll's row limit */
const copies = (): CopyState[] => [
  { source: "public.orders", phase: "copied", rows: 5, bytes: 8192, seconds: 1, copiedAt: "2026-10-29T09:00:00.000Z", error: null,
    kept: { by: "poll", polledAt: "2026-10-29T09:30:00.000Z" } },
  { source: "public.customers", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-29T09:00:00.000Z", error: null,
    unsynced: { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-29T09:00:00.000Z" },
    kept: { by: "poll", polledAt: "2026-10-29T09:00:00.000Z", unsynced: "over the 1,000,000-row sync limit" } },
];

before(async () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  await store.writer.run("CREATE TABLE public.orders (id BIGINT, customer_id BIGINT, status VARCHAR, amount DECIMAL(12,2), meta JSON)");
  await store.writer.run(`INSERT INTO public.orders VALUES (1, 1, 'paid', 120.00, '{"k": 1}'), (2, 1, 'paid', 80.50, NULL), (3, 2, 'pending', 42.00, '{}'),
    (4, 3, 'paid', 10.25, NULL), (5, 3, 'pending', 1.00, NULL)`);
  await store.writer.run("CREATE TABLE public.customers (id BIGINT, meta JSON)");
  await store.writer.run(`INSERT INTO public.customers VALUES (1, '{"k": 1}'), (2, '{}'), (3, NULL)`);
  await store.writer.run("CREATE TABLE public.events AS SELECT range::INTEGER AS id FROM range(150000)");
  ledger = await RequestLedger.open(store, () => undefined, { days: 7, flushMs: 60_000 });
  const u = await import("../src/duck/users.ts");
  const logins: Pick<PgApiOptions, "authenticate" | "recheck" | "recheckMs"> = u.listenerLogins(new u.LiveUsers(path.join(home, u.USERS_FILE), API_KEY), API_KEY);
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "shop", masonVersion: "test", ...logins, recheckMs: 0,
    schema: () => schema, record: (row) => ledger.record(row), log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, copies),
  });
  const { addUser } = await import("../src/cli/user.ts");
  const added = addUser(path.join(home, u.USERS_FILE), API_KEY, "claude", { link: { url: "", host: "127.0.0.1", port: api.port, database: "shop" }, database: "shop" });
  if ("message" in added || added.url === undefined) throw new Error(`mason user add claude: ${JSON.stringify(added)}`);
  url = added.url;
  // the run's command server, as far as a command asks it whether the run is up (src/cli/runs.ts answers)
  control = http.createServer((req, res) => {
    if (req.url === "/api/ping" && req.headers.authorization === `Bearer ${RUN_TOKEN}`) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid })); return; }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    name: "shop", folder: "mason", remote: false, apiKey: API_KEY, sourceServer: null, lastRun: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${(control.address() as { port: number }).port}`, token: RUN_TOKEN,
      postgresUrl: `postgresql://127.0.0.1:${api.port}/shop`, postgresListener: { host: "127.0.0.1", tls: null } },
  }), { mode: 0o600 });
});
after(async () => {
  control.close();
  await api.close();
  await ledger.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A minimal MCP client: `mason mcp` as a child, a request a line, each answer matched to its id. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  /** every line the server wrote to stdout */
  readonly lines: string[] = [];
  stderr = "";
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  readonly exited: Promise<number | null>;

  constructor(args: string[], extraEnv: Record<string, string> = {}, cwd = dir) {
    this.child = spawn(process.execPath, [MAIN, "mcp", ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.lines.push(line);
        const m = JSON.parse(line) as Record<string, unknown>;
        const w = this.waiting.get(m.id as number);
        if (w) { this.waiting.delete(m.id as number); w.resolve(m); }
      }
    });
    this.child.stderr.setEncoding("utf8").on("data", (c: string) => { this.stderr += c; });
    // a server that ends fails every request it left unanswered, with what it said: never a test that waits for ever
    this.exited = new Promise((resolve) => this.child.on("close", (code) => {
      for (const w of this.waiting.values()) w.reject(new Error(`mason mcp exited (${code}) without answering:\n${this.stderr}`));
      this.waiting.clear();
      resolve(code);
    }));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; text: string; structured: Record<string, unknown> }> {
    const m = await this.request("tools/call", { name, arguments: args });
    assert.equal(m.error, undefined, JSON.stringify(m.error));
    const r = m.result as { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0]!.type, "text");
    return { ...(r.isError ? { isError: true } : {}), text: r.content[0]!.text, structured: r.structuredContent };
  }

  async close(): Promise<number | null> { this.child.stdin.end(); return this.exited; }
}

/** a client initialized as Claude Code is */
async function started(): Promise<Client> {
  const c = new Client(["--url", url]);
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mason test", version: "1" } });
  const r = init.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown>; instructions: string };
  assert.equal(r.protocolVersion, "2025-06-18", "answered in the client's version");
  assert.equal(r.serverInfo.name, "mason");
  assert.deepEqual(Object.keys(r.capabilities).sort(), ["resources", "tools"]);
  c.notify("notifications/initialized");
  return c;
}

test("initialize, tools/list and resources: exactly the four tools with their schemas, the two help pages, and ping", async () => {
  const c = await started();
  try {
    const tools = ((await c.request("tools/list")).result as { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> }).tools;
    assert.deepEqual(tools.map((t) => t.name), ["tables", "describe", "query", "explain"]);
    assert.deepEqual(tools.map((t) => [t.name, Object.keys(t.inputSchema.properties), t.inputSchema.required ?? []]), [
      ["tables", [], []], ["describe", ["table"], ["table"]], ["query", ["sql", "max_rows", "timeout_ms"], ["sql"]], ["explain", ["sql", "analyze", "timeout_ms"], ["sql"]]]);
    assert.deepEqual((tools[2]!.inputSchema.properties.max_rows as Record<string, unknown>), { type: "integer", minimum: 1, maximum: 10_000, default: 200,
      description: "the most rows to return (default 200, at most 10000): aggregate rather than raise it" });
    // nothing a model reads is named for the engine
    assert.doesNotMatch(JSON.stringify(tools), /duck/i);
    assert.deepEqual((await c.request("ping")).result, {});
    const resources = ((await c.request("resources/list")).result as { resources: Array<{ uri: string }> }).resources;
    assert.deepEqual(resources.map((r) => r.uri), ["mason://help/agent", "mason://help/mcp"]);
    const agent = ((await c.request("resources/read", { uri: "mason://help/agent" })).result as { contents: Array<{ text: string }> }).contents[0]!.text;
    assert.match(agent, /^DRIVING MASON FROM A CODING AGENT/);
    const { guideText } = await import("../src/cli/guides.ts");
    assert.equal(agent, await guideText("agent"));
    const { MCP } = await import("../src/cli/mcp.ts");
    assert.equal(((await c.request("resources/read", { uri: "mason://help/mcp" })).result as { contents: Array<{ text: string }> }).contents[0]!.text, MCP.usage);
    assert.deepEqual((await c.request("resources/read", { uri: "mason://nope" })).error, { code: -32002, message: "there is no resource \"mason://nope\": mason://help/agent, mason://help/mcp" });
    assert.deepEqual((await c.request("tools/call", { name: "querry", arguments: {} })).error,
      { code: -32602, message: "there is no tool \"querry\" — did you mean `query`?: tables, describe, query, explain" });
    assert.deepEqual((await c.request("no/such")).error, { code: -32601, message: "there is no method no/such" });
  } finally { assert.equal(await c.close(), 0, "stdin closed: it ends, exit 0"); }
  assert.ok(c.lines.every((l) => (JSON.parse(l) as { jsonrpc?: string }).jsonrpc === "2.0"), "stdout: JSON-RPC frames alone");
  assert.match(c.stderr, /^\[mason mcp\] serving postgres:\/\/claude:\*\*\*\*@127\.0\.0\.1:\d+\/shop as claude, over MCP on stdio, until stdin closes\n$/);
});

test("tables and describe: the catalog's tables and columns, each copy's rows and how it is kept current", async () => {
  const c = await started();
  try {
    const t = await c.call("tables");
    assert.equal(t.isError, undefined, t.text);
    assert.deepEqual(t.structured, { tables: [
      { table: "public.customers", kind: "table", rows_about: 3, kept: "NOT kept current (over the 1,000,000-row sync limit; as of 2026-10-29 09:00:00 UTC): mason sync public.customers polls it now", kept_current_by: null },
      { table: "public.events", kind: "table", rows_about: 150_000, kept: "how it is kept current is unknown: the sync has no record of it", kept_current_by: null },
      { table: "public.orders", kind: "table", rows_about: 5, kept: "kept current by polling, last poll 2026-10-29 09:30:00 UTC", kept_current_by: "polling" },
    ] });
    assert.deepEqual(JSON.parse(t.text), t.structured, "the text is the same JSON");
    const d = await c.call("describe", { table: "orders" });
    assert.equal(d.isError, undefined, d.text);
    assert.deepEqual(d.structured, {
      table: "public.orders", kind: "table", comment: "one row an order",
      columns: [{ name: "id", type: "bigint", not_null: true }, { name: "customer_id", type: "bigint", not_null: false },
        { name: "status", type: "text", not_null: false, comment: "paid or pending" }, { name: "amount", type: "numeric(12,2)", not_null: false }, { name: "meta", type: "jsonb", not_null: false }],
      key: ["id"], foreign_keys: ["FOREIGN KEY (customer_id) REFERENCES customers(id)"],
      rows_about: 5, kept: "kept current by polling, last poll 2026-10-29 09:30:00 UTC", kept_current_by: "polling",
    });
    assert.deepEqual((await c.call("describe", { table: "public.customers" })).structured.key, ["id"]);
    const missing = await c.call("describe", { table: "order" });
    assert.equal(missing.isError, true);
    assert.equal(missing.text, "there is no table \"order\" Mason serves — did you mean `orders`?. The tables: public.customers, public.events, public.orders.");
    const stray = await c.call("describe", { name: "orders" });
    assert.deepEqual([stray.isError, stray.text], [true, "describe takes table, not name"]);
  } finally { await c.close(); }
});

test("query: rows and Postgres's types for a GROUP BY, truncated at max_rows, 57014 at timeout_ms, a refusal with its way out", async () => {
  const c = await started();
  try {
    const g = await c.call("query", { sql: "SELECT status, count(*) AS n, sum(amount) AS total FROM orders GROUP BY status ORDER BY status" });
    assert.equal(g.isError, undefined, g.text);
    assert.deepEqual(g.structured, { columns: [{ name: "status", type: "text" }, { name: "n", type: "bigint" }, { name: "total", type: "numeric" }],
      rows: [["paid", "3", "210.75"], ["pending", "2", "43.00"]], row_count: 2, truncated: false, command: "SELECT 2" });
    assert.equal(g.text, '{\n  "columns": [\n    {"name":"status","type":"text"},\n    {"name":"n","type":"bigint"},\n    {"name":"total","type":"numeric"}\n  ],\n' +
      '  "rows": [\n    ["paid","3","210.75"],\n    ["pending","2","43.00"]\n  ],\n  "row_count": 2,\n  "truncated": false,\n  "command": "SELECT 2"\n}', "a row a line");
    // the Execute's row count is the cut: the server stops at it and says rows were left
    const cut = await c.call("query", { sql: "SELECT id FROM orders ORDER BY id", max_rows: 2 });
    assert.deepEqual([cut.structured.rows, cut.structured.truncated, cut.structured.row_count], [[["1"], ["2"]], true, 2]);
    const whole = await c.call("query", { sql: "SELECT id FROM orders ORDER BY id", max_rows: 5 });
    assert.deepEqual([whole.structured.row_count, whole.structured.truncated], [5, false]);
    // a statement that outlives its timeout: Postgres's 57014, within the limit
    const t0 = Date.now();
    const slow = await c.call("query", { sql: "SELECT count(*) FROM events a, events b WHERE (a.id::bigint * b.id) % 7 = 3", timeout_ms: 300 });
    assert.equal(slow.isError, true, slow.text);
    assert.equal((slow.structured.error as { sqlstate: string }).sqlstate, "57014", slow.text);
    assert.ok(Date.now() - t0 < 10_000, `stopped near its limit (${Date.now() - t0} ms)`);
    // a registered gap: a jsonb compared by JOIN … USING is refused by name (its entry in DETAIL), the way out in HINT
    const refused = await c.call("query", { sql: "SELECT count(*) FROM orders JOIN customers USING (meta)" });
    assert.deepEqual(refused, { isError: true,
      text: "ERROR 0A000: a JOIN … USING or a NATURAL JOIN on a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)\n" +
        "DETAIL: Mason gap jsonb-compare (docs/SQL-SUPPORT.md)\nHINT: JOIN … ON a.j = b.j",
      structured: { error: { sqlstate: "0A000", message: "a JOIN … USING or a NATURAL JOIN on a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)",
        detail: "Mason gap jsonb-compare (docs/SQL-SUPPORT.md)", hint: "JOIN … ON a.j = b.j" } } });
    const { GAPS } = await import("../src/duck/gaps.ts");
    assert.equal(GAPS["jsonb-compare"].kind, "refused", "a registered gap");
    // a write: refused, the copy is read-only
    const write = await c.call("query", { sql: "DELETE FROM orders" });
    assert.equal(write.isError, true, write.text);
    // one statement a call: a second is Postgres's own refusal
    const two = await c.call("query", { sql: "SELECT 1; SELECT 2" });
    assert.deepEqual([two.isError, (two.structured.error as { sqlstate: string }).sqlstate], [true, "42601"], two.text);
    const bad = await c.call("query", { sql: "SELECT 1", max_rows: 10_001 });
    assert.deepEqual([bad.isError, bad.text], [true, "max_rows must be an integer from 1 to 10000"]);
    const ex = await c.call("explain", { sql: "SELECT status, count(*) FROM orders GROUP BY status" });
    assert.equal(ex.isError, undefined, ex.text);
    assert.match(ex.structured.plan as string, /public\.orders \(about 5 rows; kept current by polling, last poll 2026-10-29 09:30:00 UTC\)/);
    assert.equal(ex.text, ex.structured.plan, "EXPLAIN's lines as text, as psql prints them");
  } finally { await c.close(); }
  // every statement it ran is the request log's, under the agent's application_name
  await ledger.flush();
  const rows = (await ledger.recent({ limit: 200 })).filter((r) => r.applicationName.startsWith("mason-mcp"));
  assert.ok(rows.some((r) => r.query.startsWith("SELECT status, count(*)") && r.outcome === "ok"), "the GROUP BY");
  assert.ok(rows.some((r) => r.sqlstate === "0A000"), "the refusal");
  assert.ok(rows.every((r) => r.applicationName === "mason-mcp/mason-test" && r.user === "claude"), JSON.stringify(rows.map((r) => [r.applicationName, r.user])));
  assert.ok(c.lines.every((l) => (JSON.parse(l) as { jsonrpc?: string }).jsonrpc === "2.0"), "stdout: JSON-RPC frames alone");
});

test("no URL, a bad one, nothing listening, a refused password: the failure shape before the protocol, nothing on stdout but --json's", async () => {
  // Mason up for the project here, no URL: refused, the way out a user of the agent's own — never one made silently
  const up = await runMason(root, ["mcp"], env);
  assert.equal(up.code, 1, up.stderr);
  assert.equal(up.stdout, "");
  assert.match(up.stderr, /^✗ mason mcp: mason mcp needs a mason user's URL: --url, or MASON_URL\n {2}why {3}Mason is running for shop \(postgres:\/\/<user>:<password>@127\.0\.0\.1:\d+\/shop\); an agent connects as a user of its own, and mason mcp makes none by itself\n {2}fix {3}mason user add claude prints the URL, once; then mason mcp --url "<that URL>", or MASON_URL in the client's config\n\nNext:\n {2}mason user add claude {2,}a user for the agent/);
  const upJson = await runMason(root, ["mcp", "--json"], env);
  assert.equal(upJson.code, 1);
  assert.deepEqual((JSON.parse(upJson.stdout) as { error: { code: string } }).error.code, "refused");
  assert.equal(fs.readFileSync(path.join(home, "users.json"), "utf8").match(/"name"/g)?.length, 1, "no user was added");
  // no project, no URL: the command line lacks it (exit 2)
  const none = await runMason(dir, ["mcp", "--json"], env);
  assert.equal(none.code, 2, none.stdout);
  assert.deepEqual(JSON.parse(none.stdout), { error: { code: "usage", message: "mason mcp needs a mason user's URL: --url, or MASON_URL", why: "no Mason project here or above to add a user to",
    fix: "in the project's folder (or beside mason serve: docker compose exec mason mason user add claude), mason user add <name> prints the URL" },
  next: [{ command: "mason help mcp", what: "how to add mason mcp to Claude Code or Claude Desktop" }] });
  const notUrl = await runMason(dir, ["mcp", "--url", "mysql://x@y/z"], env);
  assert.equal(notUrl.code, 2);
  assert.match(notUrl.stderr, /^✗ mason mcp: --url is not a Postgres URL: the URL's scheme is mysql; it must be postgres:\/\/ or postgresql:\/\//);
  const away = await runMason(dir, ["mcp", "--json"], { ...env, MASON_URL: "postgres://claude:x@127.0.0.1:1/shop" });
  assert.equal(away.code, 1);
  assert.deepEqual((JSON.parse(away.stdout) as { error: { code: string; message: string } }).error,
    { code: "unreachable", message: "could not connect to postgres://claude:****@127.0.0.1:1/shop: nothing is listening on 127.0.0.1:1",
      fix: "start Mason (mason start) or check the URL's host and port: mason status says where the Postgres API listens" });
  const wrong = await runMason(dir, ["mcp", "--url", url.replace(/:mason_[^@]+@/, ":mason_nope@")], env);
  assert.equal(wrong.code, 1);
  assert.equal(wrong.stdout, "");
  assert.match(wrong.stderr, /^✗ mason mcp: 127\.0\.0\.1:\d+ refused user claude: password authentication failed for user "claude": not a Mason user's password or token: .+\n {2}why {3}a tool that keeps one password connects as a user: .+\n {2}fix {3}the URL mason user add printed for this user: a user removed \(mason user list\), or added under another API key, connects no more\n/);
  assert.doesNotMatch(wrong.stderr, /mason_nope/, "the password is never printed");
});
