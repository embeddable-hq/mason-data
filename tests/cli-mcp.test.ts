/**
 * `mason mcp` AGAINST A REAL LISTENER (src/cli/mcp.ts): a Postgres listener over a throwaway DuckStore, its logins a
 * project's `.mason/users.json` as `mason start` wires them, a user added to it, and `mason mcp --url <the user's URL>`
 * spawned as an MCP client spawns it — driven over stdio by a minimal JSON-RPC client here. What it must hold:
 *   - initialize answers in kind; tools/list is exactly tables, describe, query, explain, with their input schemas;
 *     resources/list and resources/read are the agent's guide and mason help mcp; JSON-RPC's edges (a parse error, an
 *     invalid request or id, a notification, a batch, a cancellation) answered as the protocol says;
 *   - tables and describe say what the catalog has, named as a statement writes them (a schema of its own, a mixed-case
 *     name, one that needs quotes), with each copy's rows and how it is kept current (the sync's words, read through
 *     EXPLAIN over the wire, one table at a time);
 *   - query answers a GROUP BY with Postgres's types (an enum the source made by the name the wire's OID has), is
 *     truncated at max_rows and logged so, stops at timeout_ms with 57014 (which does not outlive its call), and a
 *     refused statement is an MCP tool error carrying the SQLSTATE and the gap's way out — never a stack;
 *   - a server that drops the connection mid-statement: its FATAL said, or "did not answer";
 *   - stdout carries JSON-RPC frames alone; every statement is a row of the request log under mason-mcp/<client>;
 *   - no URL, a bad URL, a URL nothing answers at or a refused password: the failure shape on stderr, before the
 *     protocol starts, --json or not.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

/** the OIDs the SOURCE gave its enum and its array type: none of them the catalog's (src/api/postgres/catalog.ts sourceTypeNames) */
const MOOD_OID = 90_001, MOOD_ARRAY_OID = 90_002;

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
    // a table in a schema of its own, a mixed-case name, a name that needs quotes
    { name: "items", schema: "sales", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8", notNull: true }] },
    { name: "Clients", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8", notNull: true }] },
    { name: "x; y", primaryKey: [], joins: [], columns: [{ name: "id", type: "int8" }] },
    // an enum the source made, sent on the wire under the source's OID
    { name: "moods", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int8", notNull: true },
      { name: "m", type: "text", spelled: "mood", enumLabels: ["sad", "ok", "happy"], typeOid: MOOD_OID, typeArrayOid: MOOD_ARRAY_OID }] },
    // in the catalog, and no copy of it: a table removed between the catalog's read and its EXPLAIN
    { name: "ghost", primaryKey: [], joins: [], columns: [{ name: "id", type: "int8" }] },
  ],
};

/** how the sync holds each copy: orders polled, customers over the poll's row limit, the quoted ones polled */
const polled = (source: string): CopyState => ({ source, phase: "copied", rows: 1, bytes: 8192, seconds: 1, copiedAt: "2026-10-29T09:00:00.000Z", error: null,
  kept: { by: "poll", polledAt: "2026-10-29T09:30:00.000Z" } });
const copies = (): CopyState[] => [
  { ...polled("public.orders"), rows: 5 },
  { source: "public.customers", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-29T09:00:00.000Z", error: null,
    unsynced: { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-29T09:00:00.000Z" },
    kept: { by: "poll", polledAt: "2026-10-29T09:00:00.000Z", unsynced: "over the 1,000,000-row sync limit" } },
  polled("sales.items"), polled("public.Clients"), polled("public.x; y"),
];
const POLLED = "kept current by polling, last poll 2026-10-29 09:30:00 UTC";

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
  await store.writer.run("CREATE SCHEMA sales; CREATE TABLE sales.items (id BIGINT); INSERT INTO sales.items VALUES (1)");
  await store.writer.run(`CREATE TABLE public."Clients" (id BIGINT); INSERT INTO public."Clients" VALUES (1)`);
  await store.writer.run(`CREATE TABLE public."x; y" (id BIGINT); INSERT INTO public."x; y" VALUES (1)`);
  await store.writer.run("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy'); CREATE TABLE public.moods (id BIGINT, m mood)");
  await store.writer.run("INSERT INTO public.moods VALUES (1, 'happy'), (2, 'sad'), (3, 'happy')");
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

type Frame = Record<string, unknown>;

/** A minimal MCP client: `mason mcp` as a child, a request a line, each answer matched to its id. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  /** every line the server wrote to stdout */
  readonly lines: string[] = [];
  stderr = "";
  private nextId = 1;
  private readonly waiting = new Map<unknown, { resolve: (m: Frame) => void; reject: (e: Error) => void }>();
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
        const m = JSON.parse(line) as Frame;
        const w = this.waiting.get(m.id);
        if (w) { this.waiting.delete(m.id); w.resolve(m); }
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

  request(method: string, params: Record<string, unknown> = {}, id: string | number = this.nextId++): Promise<Frame> {
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }

  /** A line written as it is, and the frames written in answer within `ms` (none for a notification). */
  async raw(line: string, ms = 500): Promise<Frame[]> {
    const before = this.lines.length;
    this.child.stdin.write(`${line}\n`);
    await sleep(ms);
    return this.lines.slice(before).map((l) => JSON.parse(l) as Frame);
  }

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
async function started(at = url): Promise<Client> {
  const c = new Client(["--url", at]);
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mason test", version: "1" } });
  const r = init.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown>; instructions: string };
  assert.equal(r.protocolVersion, "2025-06-18", "answered in the client's version");
  assert.equal(r.serverInfo.name, "mason");
  assert.deepEqual(Object.keys(r.capabilities).sort(), ["resources", "tools"]);
  c.notify("notifications/initialized");
  return c;
}

/** the request log's rows of mason mcp, written */
async function mcpRows(): Promise<Awaited<ReturnType<RequestLedger["recent"]>>> {
  await ledger.flush();
  return (await ledger.recent({ limit: 500 })).filter((r) => r.applicationName.startsWith("mason-mcp"));
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

test("JSON-RPC's edges: a parse error, an invalid request or id, a notification, a batch, a string id, a version it does not speak", async () => {
  const c = new Client(["--url", url]);
  try {
    // a client's version this server does not speak is answered with its newest
    const init = await c.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } });
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
    const err = (code: number, message: string, id: unknown = null): Frame => ({ jsonrpc: "2.0", id, error: { code, message } });
    assert.deepEqual(await c.raw("{not json"), [err(-32700, "not JSON: one JSON-RPC message a line")]);
    for (const v of ["42", "null", '"x"']) assert.deepEqual(await c.raw(v), [err(-32600, "a JSON-RPC message is an object")], v);
    assert.deepEqual(await c.raw("[]"), [err(-32600, "an empty batch")]);
    // an id is a string or an integer, never null or an object
    for (const id of ["null", "{}", "1.5"]) assert.deepEqual(await c.raw(`{"jsonrpc":"2.0","id":${id},"method":"ping"}`), [err(-32600, "a request's id is a string or an integer")], id);
    assert.deepEqual(await c.raw('{"jsonrpc":"1.0","id":7,"method":"ping"}'), [err(-32600, "not a JSON-RPC 2.0 request: jsonrpc \"2.0\" and a method", 7)]);
    // a notification is never answered; one that carries an id is no notification
    assert.deepEqual(await c.raw('{"jsonrpc":"2.0","method":"notifications/initialized"}'), []);
    assert.deepEqual(await c.raw('{"jsonrpc":"2.0","method":"ping"}'), [], "a request without an id is a notification");
    assert.deepEqual(await c.raw('{"jsonrpc":"2.0","id":8,"method":"notifications/initialized"}'), [err(-32600, "notifications/initialized is a notification: it carries no id", 8)]);
    assert.deepEqual(await c.raw('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":"str"}'), [err(-32602, "params is an object", 9)]);
    assert.deepEqual(await c.raw('{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{}}'), [err(-32602, "tools/call names its tool (name): tables, describe, query, explain", 10)]);
    // a string id is answered with it
    assert.deepEqual((await c.request("ping", {}, "a-string")).result, {});
    // a batch: an answer for each request, none for its notification
    const batch = await c.raw('[{"jsonrpc":"2.0","id":11,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":"12","method":"no/such"}]');
    assert.deepEqual(batch, [[{ jsonrpc: "2.0", id: 11, result: {} }, err(-32601, "there is no method no/such", "12")]]);
  } finally { await c.close(); }
});

test("tables and describe: the catalog's tables named as a statement writes them, their columns, each copy's rows and how it is kept current", async () => {
  const c = await started();
  try {
    const t = await c.call("tables");
    assert.equal(t.isError, undefined, t.text);
    const listed = Object.fromEntries((t.structured.tables as Array<{ table: string } & Record<string, unknown>>).map(({ table, ...rest }) => [table, rest]));
    // a table whose EXPLAIN is refused: said as its kept line, and every other table answered still
    const ghost = listed["public.ghost"] as { kind: string; rows_about: unknown; kept: string };
    delete listed["public.ghost"];
    assert.deepEqual([ghost.kind, ghost.rows_about], ["table", null]);
    assert.match(ghost.kept, /^how it is kept current could not be read: .*ghost/);
    assert.deepEqual(listed, {
      "public.customers": { kind: "table", rows_about: 3, kept: "NOT kept current (over the 1,000,000-row sync limit; as of 2026-10-29 09:00:00 UTC): mason sync public.customers polls it now", kept_current_by: null },
      "public.events": { kind: "table", rows_about: 150_000, kept: "how it is kept current is unknown: the sync has no record of it", kept_current_by: null },
      "public.orders": { kind: "table", rows_about: 5, kept: POLLED, kept_current_by: "polling" },
      "public.moods": { kind: "table", rows_about: 3, kept: "how it is kept current is unknown: the sync has no record of it", kept_current_by: null },
      // a name that needs quotes is named with them, and its copy is found by it
      'public."Clients"': { kind: "table", rows_about: 1, kept: POLLED, kept_current_by: "polling" },
      'public."x; y"': { kind: "table", rows_about: 1, kept: POLLED, kept_current_by: "polling" },
      "sales.items": { kind: "table", rows_about: 1, kept: POLLED, kept_current_by: "polling" },
    });
    assert.deepEqual(JSON.parse(t.text), t.structured, "the text is the same JSON");
    const d = await c.call("describe", { table: "orders" });
    assert.equal(d.isError, undefined, d.text);
    assert.deepEqual(d.structured, {
      table: "public.orders", kind: "table", comment: "one row an order",
      columns: [{ name: "id", type: "bigint", not_null: true }, { name: "customer_id", type: "bigint", not_null: false },
        { name: "status", type: "text", not_null: false, comment: "paid or pending" }, { name: "amount", type: "numeric(12,2)", not_null: false }, { name: "meta", type: "jsonb", not_null: false }],
      key: ["id"], foreign_keys: ["FOREIGN KEY (customer_id) REFERENCES customers(id)"],
      rows_about: 5, kept: POLLED, kept_current_by: "polling",
    });
    assert.deepEqual((await c.call("describe", { table: "public.customers" })).structured.key, ["id"]);
    // every name tables printed is one describe takes, and the catalog's own spelling too
    for (const [asked, table] of [['public."Clients"', 'public."Clients"'], ["public.Clients", 'public."Clients"'], ["Clients", 'public."Clients"'], ['"Clients"', 'public."Clients"'],
      ['public."x; y"', 'public."x; y"'], ['"x; y"', 'public."x; y"'], ["sales.items", "sales.items"]]) {
      const r = await c.call("describe", { table: asked! });
      assert.deepEqual([r.isError, r.structured.table, r.structured.kept], [undefined, table, POLLED], `${asked}: ${r.text}`);
    }
    // an enum's column is named as the catalog names its type
    assert.deepEqual((await c.call("describe", { table: "moods" })).structured.columns, [{ name: "id", type: "bigint", not_null: true }, { name: "m", type: "mood", not_null: false }]);
    const missing = await c.call("describe", { table: "order" });
    assert.equal(missing.isError, true);
    assert.equal(missing.text, "there is no table \"order\" Mason serves — did you mean `orders`?. The tables: public.\"Clients\", public.customers, public.events, " +
      "public.ghost, public.moods, public.orders, public.\"x; y\", sales.items.");
    // a bare name of a table in another schema: that table, with its schema
    assert.match((await c.call("describe", { table: "items" })).text, /^there is no table "items" Mason serves — did you mean `sales\.items`\?/);
    // a relation the catalog has and tables does not list is none, and a name Postgres cannot read is none
    for (const asked of ["pg_class", "pg_catalog.pg_class", "information_schema.tables", "a.b.c.d", '"x']) {
      const r = await c.call("describe", { table: asked });
      assert.equal(r.isError, true, asked);
      assert.ok(r.text.startsWith(`there is no table ${JSON.stringify(asked)} Mason serves`), r.text);
    }
    const stray = await c.call("describe", { name: "orders" });
    assert.deepEqual([stray.isError, stray.text], [true, "describe takes table, not name"]);
  } finally { await c.close(); }
  // one EXPLAIN a table: the request log holds no refusal the agent never sent but the ghost's own EXPLAIN, and none
  // for a name describe could not read
  const rows = await mcpRows();
  assert.deepEqual([...new Set(rows.filter((r) => r.outcome !== "ok").map((r) => r.query))], ['EXPLAIN (FORMAT JSON) SELECT 1 FROM "public"."ghost"']);
});

test("query: rows and Postgres's types for a GROUP BY, an enum by its name, truncated at max_rows and logged so, 57014 at timeout_ms, a refusal with its way out", async () => {
  const c = await started();
  try {
    const g = await c.call("query", { sql: "SELECT status, count(*) AS n, sum(amount) AS total FROM orders GROUP BY status ORDER BY status" });
    assert.equal(g.isError, undefined, g.text);
    assert.deepEqual(g.structured, { columns: [{ name: "status", type: "text" }, { name: "n", type: "bigint" }, { name: "total", type: "numeric" }],
      rows: [["paid", "3", "210.75"], ["pending", "2", "43.00"]], row_count: 2, truncated: false, command: "SELECT 2" });
    assert.equal(g.text, '{\n  "columns": [\n    {"name":"status","type":"text"},\n    {"name":"n","type":"bigint"},\n    {"name":"total","type":"numeric"}\n  ],\n' +
      '  "rows": [\n    ["paid","3","210.75"],\n    ["pending","2","43.00"]\n  ],\n  "row_count": 2,\n  "truncated": false,\n  "command": "SELECT 2"\n}', "a row a line");
    // a type the source made: the wire sends the source's OID, which the catalog lacks; its name is the type's
    const moods = await c.call("query", { sql: "SELECT m, count(*) AS n FROM moods GROUP BY m ORDER BY m" });
    assert.equal(moods.isError, undefined, moods.text);
    assert.deepEqual([moods.structured.columns, moods.structured.rows], [[{ name: "m", type: "mood" }, { name: "n", type: "bigint" }], [["sad", "1"], ["happy", "2"]]]);
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
    // the timeout is the call's: the next call's session has its own
    const shown = async (args: Record<string, unknown>): Promise<unknown> => (await c.call("query", { sql: "SHOW statement_timeout", ...args })).structured.rows;
    const short = await shown({ timeout_ms: 300 });
    const next = await shown({});
    assert.notDeepEqual(next, short, "timeout_ms does not outlive its call");
    assert.deepEqual(await shown({ timeout_ms: 30_000 }), next, "the default is 30 s");
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
    // a parameter it cannot bind is the server's refusal, said as one
    const param = await c.call("query", { sql: "SELECT id FROM orders WHERE id = $1" });
    assert.equal(param.isError, true, param.text);
    assert.match(param.text, /^ERROR [0-9A-Z]{5}: /);
    // what is no statement, or no argument it takes, is said as the arguments' fault
    for (const [args, said] of [[{ sql: "-- only a comment" }, "sql must be a statement (it holds only comments or whitespace)"],
      [{ sql: "SELECT '\0'" }, "sql must be a non-empty string, with no NUL"], [{ sql: "   " }, "sql must be a non-empty string, with no NUL"],
      [{ sql: "SELECT 1", max_rows: 10_001 }, "max_rows must be an integer from 1 to 10000"], [{ sql: "SELECT 1", timeout_ms: 0 }, "timeout_ms must be an integer from 1 to 300000"],
      [{ sql: "SELECT 1", limit: 5 }, "query takes sql, max_rows, timeout_ms, not limit"], [{ query: "SELECT 1" }, "query takes sql, max_rows, timeout_ms, not query"]] as const) {
      const r = await c.call("query", args);
      assert.deepEqual([r.isError, r.text], [true, said], JSON.stringify(args));
    }
    const ex = await c.call("explain", { sql: "SELECT status, count(*) FROM orders GROUP BY status" });
    assert.equal(ex.isError, undefined, ex.text);
    assert.match(ex.structured.plan as string, /public\.orders \(about 5 rows; kept current by polling, last poll 2026-10-29 09:30:00 UTC\)/);
    assert.equal(ex.text, ex.structured.plan, "EXPLAIN's lines as text, as psql prints them");
    assert.match((await c.call("explain", { sql: 'SELECT * FROM "x; y"' })).text, /from its copy of public\."x; y" \(about 1 rows?; kept current by polling/);
    // a refusal's position is the statement's, not the EXPLAIN's this server put around it
    for (const analyze of [false, true]) {
      const pos = await c.call("explain", { sql: "SELECT nope FROM orders", analyze });
      assert.equal(pos.isError, true, pos.text);
      assert.equal((pos.structured.error as { position?: number }).position, "SELECT ".length + 1, pos.text);
    }
  } finally { await c.close(); }
  // every statement it ran is the request log's, under the agent's application_name — the truncated one with its rows
  const rows = await mcpRows();
  assert.ok(rows.some((r) => r.query.startsWith("SELECT status, count(*)") && r.outcome === "ok"), "the GROUP BY");
  assert.deepEqual(rows.filter((r) => r.query === "SELECT id FROM orders ORDER BY id").map((r) => [r.outcome, r.rows]).sort(), [["ok", 2], ["ok", 5]], "the truncated query, with the rows it sent");
  assert.ok(rows.some((r) => r.sqlstate === "0A000"), "the refusal");
  assert.ok(rows.every((r) => r.applicationName === "mason-mcp/mason-test" && r.user === "claude"), JSON.stringify(rows.map((r) => [r.applicationName, r.user])));
  assert.ok(c.lines.every((l) => (JSON.parse(l) as { jsonrpc?: string }).jsonrpc === "2.0"), "stdout: JSON-RPC frames alone");
});

test("a cancelled request: its statement is cancelled where it runs, and it is answered no further", async () => {
  const c = await started();
  try {
    const id = 4242;
    let answered = false;
    void c.request("tools/call", { name: "query", arguments: { sql: "SELECT count(*) FROM events a, events b WHERE (a.id::bigint * b.id) % 7 = 2", timeout_ms: 120_000 } }, id)
      .then(() => { answered = true; }, () => undefined);
    await sleep(800);
    const t0 = Date.now();
    c.notify("notifications/cancelled", { requestId: id, reason: "the user stopped it" });
    // the server goes on answering, and never answers the cancelled id
    assert.deepEqual((await c.request("ping")).result, {});
    await sleep(1_500);
    assert.equal(answered, false, "no answer for a cancelled request");
    // the listener ended the statement at the CancelRequest: its 57014 is in the request log, long before its timeout
    for (let i = 0; i < 20; i++) {
      const cancelled = (await mcpRows()).find((r) => r.sqlstate === "57014" && r.query.includes("% 7 = 2"));
      if (cancelled !== undefined) {
        assert.match(cancelled.message ?? "", /user request/);
        // one row for the statement: its cancellation, never also an answer of the rows it never sent
        assert.deepEqual((await mcpRows()).filter((r) => r.query.includes("% 7 = 2")).map((r) => r.sqlstate), ["57014"]);
        break;
      }
      assert.ok(i < 19, `the statement was cancelled: ${JSON.stringify((await mcpRows()).slice(-3))}\n${c.stderr}`);
      await sleep(250);
    }
    assert.ok(Date.now() - t0 < 10_000);
    assert.match(c.stderr, /\[mason mcp\] request 4242 cancelled by the client: the user stopped it\n/);
  } finally { await c.close(); }
});

test("a table's name: written as a statement writes it, read back as Postgres reads it, and DuckDB's plan's name read as the table", async () => {
  const { qualifiedName, duckTableName } = await import("../src/duck/explain.ts");
  const { sqlName } = await import("../src/cli/mcp.ts");
  const names = [["public", "orders"], ["sales", "items"], ["public", "Clients"], ["public", "x; y"], ["public", 'say "hi"'], ["My Schema", "t.1"], ["public", "select"], ["public", "été"]] as const;
  assert.deepEqual(names.map(([schema, name]) => qualifiedName({ schema, name })),
    ["public.orders", "sales.items", 'public."Clients"', 'public."x; y"', 'public."say ""hi"""', '"My Schema"."t.1"', "public.select", 'public."été"']);
  for (const [schema, name] of names) {
    // every name tables prints is one describe reads as that table
    assert.deepEqual(sqlName(qualifiedName({ schema, name })), [schema, name], `${schema}.${name}`);
    // DuckDB's plan names a scan's table <file>.<schema>.<table>, quoting a part only for a character it cannot leave bare
    const duck = [`duck`, schema, name].map((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p : `"${p.replaceAll('"', '""')}"`).join(".");
    assert.deepEqual(duckTableName(duck), { schema, name }, duck);
  }
  // Postgres's reading: folded unless quoted, the search_path's public for one part, nothing for what is no name
  assert.deepEqual([sqlName("Orders"), sqlName(" public.ORDERS "), sqlName('"Clients"'), sqlName('PUBLIC."Clients"')], [["orders"], ["public", "orders"], ["Clients"], ["public", "Clients"]]);
  for (const bad of ["a.b.c", "a.b.c.d", '"x', '""', "a..b", "a.", ".a", "1abc", "a b", "a;b", ""]) assert.equal(sqlName(bad), null, bad);
});

/**
 * A SERVER THAT ACCEPTS A LOGIN AND THEN DROPS THE CONNECTION at the first statement: with Postgres's FATAL first
 * (`fatal`: a user removed mid-call, a shutdown), or without a word.
 */
async function dropping(fatal: boolean): Promise<{ url: string; close: () => void }> {
  const msg = (type: string, body: Buffer): Buffer => { const h = Buffer.alloc(5); h.write(type, 0); h.writeInt32BE(body.length + 4, 1); return Buffer.concat([h, body]); };
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0), started = false;
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        if (buf.readInt32BE(4) === 80877103) { buf = buf.subarray(8); s.write("N"); return; }   // SSLRequest: no TLS here
        if (buf.length < len) return;
        buf = buf.subarray(len);
        started = true;
        const key = Buffer.alloc(8); key.writeInt32BE(1, 0); key.writeInt32BE(2, 4);
        s.write(Buffer.concat([msg("R", Buffer.from([0, 0, 0, 0])), msg("K", key), msg("Z", Buffer.from("I"))]));
        return;
      }
      if (buf[0] === 0x51 || buf[0] === 0x50) {   // a Query or a Parse
        if (fatal) s.write(msg("E", Buffer.from("SFATAL\0C57P01\0Mterminating connection due to administrator command\0\0")));
        s.destroy();
      }
      buf = Buffer.alloc(0);
    });
    s.on("error", () => undefined);   // the client's half of a connection this server destroys: nothing to say
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `postgres://claude:x@127.0.0.1:${(server.address() as net.AddressInfo).port}/shop`, close: () => server.close() };
}

test("the listener drops the connection mid-statement: its FATAL is said with its SQLSTATE, a bare close as Mason not answering", async () => {
  for (const fatal of [true, false]) {
    const s = await dropping(fatal);
    const c = await started(s.url);
    try {
      const r = await c.call("query", { sql: "SELECT 1" });
      assert.equal(r.isError, true, r.text);
      if (fatal) assert.deepEqual([r.text, r.structured], ["FATAL 57P01: terminating connection due to administrator command",
        { error: { sqlstate: "57P01", message: "terminating connection due to administrator command" } }]);
      else assert.match(r.text, /^Mason did not answer \(127\.0\.0\.1:\d+\): connection closed by the server\. mason status, beside the run, says whether it is up\.$/);
      // the server goes on: the next call is answered
      assert.deepEqual((await c.request("ping")).result, {});
    } finally { await c.close(); s.close(); }
  }
});

test("no URL, a bad one, nothing listening, a refused password: the failure shape on stderr before the protocol, --json or not", async () => {
  // Mason up for the project here, no URL: refused, the way out a user of the agent's own — never one made silently
  const up = await runMason(root, ["mcp"], env);
  assert.equal(up.code, 1, up.stderr);
  assert.equal(up.stdout, "");
  assert.match(up.stderr, /^✗ mason mcp: mason mcp needs a mason user's URL: MASON_URL, or --url\n {2}why {3}Mason is running for shop \(postgres:\/\/<user>:<password>@127\.0\.0\.1:\d+\/shop\); an agent connects as a user of its own, and mason mcp makes none by itself\n {2}fix {3}mason user add claude prints the URL, once; then MASON_URL="<that URL>" in the client's config for mason mcp\n\nNext:\n {2}mason user add claude {2,}a user for the agent/);
  assert.equal(fs.readFileSync(path.join(home, "users.json"), "utf8").match(/"name"/g)?.length, 1, "no user was added");
  // no project, no URL: the command line lacks it (exit 2)
  const none = await runMason(dir, ["mcp"], env);
  assert.equal(none.code, 2, none.stderr);
  assert.equal(none.stdout, "");
  assert.equal(none.stderr, "✗ mason mcp: mason mcp needs a mason user's URL: MASON_URL, or --url\n  why   no Mason project here or above to add a user to\n" +
    "  fix   in the project's folder (or beside mason serve: docker compose exec mason mason user add claude), mason user add <name> prints the URL\n\n" +
    "Next:\n  mason help mcp                                how to add mason mcp to Claude Code or Claude Desktop\n");
  const notUrl = await runMason(dir, ["mcp", "--url", "mysql://x@y/z"], env);
  assert.equal(notUrl.code, 2);
  assert.match(notUrl.stderr, /^✗ mason mcp: --url is not a Postgres URL: the URL's scheme is mysql; it must be postgres:\/\/ or postgresql:\/\//);
  // a URL that cannot be read is said with its password masked: stderr is the MCP client's log file
  const unreadable = await runMason(dir, ["mcp"], { ...env, MASON_URL: "postgres://claude:s3cret@127.0.0.1:99999/shop" });
  assert.equal(unreadable.code, 2);
  assert.match(unreadable.stderr, /^✗ mason mcp: MASON_URL is not a Postgres URL: "postgres:\/\/claude:\*\*\*\*@127\.0\.0\.1:99999\/shop" is not a URL/);
  assert.doesNotMatch(unreadable.stderr, /s3cret/);
  const away = await runMason(dir, ["mcp"], { ...env, MASON_URL: "postgres://claude:x@127.0.0.1:1/shop" });
  assert.deepEqual([away.code, away.stdout], [1, ""]);
  assert.match(away.stderr, /^✗ mason mcp: could not connect to postgres:\/\/claude:\*\*\*\*@127\.0\.0\.1:1\/shop: nothing is listening on 127\.0\.0\.1:1\n {2}fix {3}start Mason \(mason start\) or check the URL's host and port: mason status says where the Postgres API listens\n/);
  const wrong = await runMason(dir, ["mcp", "--url", url.replace(/:mason_[^@]+@/, ":mason_nope@")], env);
  assert.equal(wrong.code, 1);
  assert.equal(wrong.stdout, "");
  assert.match(wrong.stderr, /^✗ mason mcp: 127\.0\.0\.1:\d+ refused user claude: password authentication failed for user "claude": not a Mason user's password or token: .+\n {2}why {3}a tool that keeps one password connects as a user: .+\n {2}fix {3}the URL mason user add printed for this user: a user removed \(mason user list\), or added under another API key, connects no more\n/);
  assert.doesNotMatch(wrong.stderr, /mason_nope/, "the password is never printed");
  // --json changes none of it: stdout is the protocol's, so every failure to start is on stderr
  for (const [cwd, argv, extra] of [[root, ["mcp", "--json"], {}], [dir, ["mcp", "--json"], { MASON_URL: "postgres://claude:x@127.0.0.1:1/shop" }]] as const) {
    const j = await runMason(cwd, [...argv], { ...env, ...extra });
    assert.equal(j.stdout, "", `mason ${argv.join(" ")}: nothing on stdout`);
    assert.match(j.stderr, /^✗ mason mcp: /);
  }
});
