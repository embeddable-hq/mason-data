/**
 * `mason mcp` — AN MCP SERVER ON STDIO, IN MASON'S OWN WORDS (docs/DESIGN.md "An MCP server"). Chat agents (Claude
 * Code, Claude Desktop, any Model Context Protocol client) reach tools over MCP. A generic Postgres MCP server works
 * against Mason already, but hands the model one bare "run SQL" tool: it must guess which tables exist and how current
 * each copy is, and a refusal reaches it as an error string. Mason knows all three, and every refusal's way out, so these
 * tools say them: `tables`, `describe`, `query`, `explain`.
 *
 * It is a client of the Postgres API like any tool, connected as a `mason user` (the URL `mason user add` printed:
 * `--url`, else `MASON_URL`), so it works the same beside `mason start` and against a `mason serve` elsewhere, and every
 * statement is a row of the request log under `application_name` `mason-mcp/<client>`. Everything it reads comes over
 * that wire: the tables and columns from the catalog (a real Postgres), the rows and how current each copy is from
 * EXPLAIN (FORMAT JSON)'s `Mason.Copies` — the sync's own words, the same line `mason status` prints.
 *
 * STDOUT IS THE PROTOCOL'S: newline-delimited JSON-RPC 2.0 frames and nothing else (`CommandSpec.stdout`: no --json,
 * every failure on stderr); what it says goes to stderr. A tool's failure is Mason's refusal (SQLSTATE, message,
 * DETAIL, HINT) as an MCP tool error, never a stack.
 *
 * The protocol is written here, not taken from `@modelcontextprotocol/sdk`: that package brings seventeen runtime
 * dependencies (an HTTP server, an OAuth library, two schema validators) for the stdio surface this file holds whole —
 * initialize, ping, tools/list, tools/call, resources/list, resources/read, cancellation — as src/cdc/pg-wire.ts holds
 * the Postgres client rather than `pg`.
 */
import { failed, parseCommand, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { whereIs } from "./state.ts";
import { withPlaceholders } from "./pg-url.ts";
import { maskedUrl, parseSource, type Source } from "./preflight.ts";
import { version } from "./version.ts";
import { PgConnection, PgError, pgIdent, pgLiteral, socketErrorText, type ExtendedResult } from "../cdc/pg-wire.ts";
import { qualifiedName, type TableName } from "../duck/explain.ts";
import { didYouMean } from "../lib/did-you-mean.ts";

/** The URL a client is shown in the help: a user's, as mason user add prints it. */
const EXAMPLE_URL = "postgres://claude:<password>@127.0.0.1:5433/shop";

export const MCP: CommandSpec = {
  name: "mcp",
  summary: "an MCP server on stdio, for Claude Code, Claude Desktop and other agents: the copy's tables, queries, refusals",
  usage: `usage: mason mcp [--url <postgres://user:password@host:port/database>]

  An MCP (Model Context Protocol) server on stdin and stdout, for Claude Code, Claude Desktop and any MCP client.
  Its tools say what an agent would otherwise guess: the tables Mason serves, each one's columns, rows and how
  current its copy is, and each statement's answer with its Postgres types — or Mason's refusal, with what to write
  instead. It connects to the Postgres API as a mason user, by the URL mason user add printed (MASON_URL, else
  --url), so it works beside mason start or against a mason serve elsewhere, and every statement it runs is in
  the request log under application_name mason-mcp/<the client's name>. It serves until the client closes stdin.
  Its stdout is the protocol's: it takes no --json, and a failure to start is said on stderr.

  Its tools: tables; describe (a table); query (one statement; max_rows default 200, at most 10000; timeout_ms
  default 30000, at most 300000); explain (a statement). Its resources: mason://help/agent and mason://help/mcp.

  Claude Code (in the project's folder, with Mason running), the URL in the server's environment:
    mason user add claude                          the URL to paste, printed once
    claude mcp add mason --env MASON_URL="${EXAMPLE_URL}" -- mason mcp
  or on its command line, where ps shows it to this machine's users and claude mcp add prints it:
    claude mcp add mason -- mason mcp --url "${EXAMPLE_URL}"

  Claude Desktop (claude_desktop_config.json). The app often starts servers without your shell's PATH, where neither
  mason nor the node its first line asks for is found: name both by their absolute paths (which node, which mason):
    { "mcpServers": { "mason": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/mason", "mcp"],
        "env": { "MASON_URL": "${EXAMPLE_URL}" } } } }

  What the client runs:
    MASON_URL="${EXAMPLE_URL}" mason mcp
    mason mcp --url "${EXAMPLE_URL}"

  --url <url>   the Postgres API as a mason user: what mason user add printed (default MASON_URL); TLS as its sslmode
                says (a host off this machine: require when it names none)
`,
  options: { url: { type: "string" } },
  stdout: "protocol",
};

/** What the server says while it serves: a log line on stderr (stdout is the protocol's), which an MCP client keeps in
 *  its own log (Claude Code: claude --debug; Claude Desktop: mcp-server-mason.log). A failure to START is failed()'s. */
const log = (m: string): void => { process.stderr.write(`[mason mcp] ${m}\n`); };

const NEED_URL = "mason mcp needs a mason user's URL: MASON_URL, or --url";
const HELP_STEP: NextStep = ["mason help mcp", "how to add mason mcp to Claude Code or Claude Desktop"];
const ADD_STEP: NextStep = ["mason user add claude", "a user for the agent: its password and URL, printed once"];

/** Where `mason mcp` connects: the URL given, or why there is none (the project's state says what to run). */
async function theUrl(given: string | undefined, cwd: string): Promise<{ url: string; from: "--url" | "MASON_URL" } | Failure> {
  if (given !== undefined) return { url: given, from: "--url" };
  const env = process.env.MASON_URL;
  if (env !== undefined && env !== "") return { url: env, from: "MASON_URL" };
  // no URL: what the project here says, never a user made silently (a password is the person's to hand out)
  const w = await whereIs(cwd);
  if (w.state === "up") {
    return { message: NEED_URL, code: "refused",
      why: `Mason is running for ${w.project.config.name} (${withPlaceholders(w.run.postgresUrl)}); an agent connects as a user of its own, and mason mcp makes none by itself`,
      fix: "mason user add claude prints the URL, once; then MASON_URL=\"<that URL>\" in the client's config for mason mcp",
      next: [ADD_STEP, HELP_STEP] };
  }
  if (w.state === "stopped") {
    return { message: NEED_URL, code: "not_running", why: w.problem.problem,
      fix: "start Mason, then add a user for the agent: mason user add prints its URL — or give the URL of a mason serve elsewhere",
      next: [["mason start", "start it, in the background"], ADD_STEP, HELP_STEP] };
  }
  if (w.state === "bad_config") {
    return { message: NEED_URL, code: "bad_config", why: w.problem.problem, fix: w.problem.fix ?? "repair .mason/config.json, or give the URL of a mason serve elsewhere", next: [HELP_STEP] };
  }
  return { message: NEED_URL, code: "usage",
    why: "no Mason project here or above to add a user to",
    fix: "in the project's folder (or beside mason serve: docker compose exec mason mason user add claude), mason user add <name> prints the URL",
    next: [HELP_STEP] };
}

/** The URL read as a connection: the CLI's own reading (src/cli/preflight.ts parseSource, TLS as the URL's sslmode). */
function theSource(url: string, from: string): Source | Failure {
  const p = parseSource(url);
  if ("problem" in p) return { message: `${from} is not a Postgres URL: ${p.problem}`, code: "usage", fix: `the URL mason user add printed: ${EXAMPLE_URL}`, next: [HELP_STEP] };
  return p.source;
}

/** application_name's client part: the MCP client's own name, in letters, digits, `.`, `_` and `-` (Postgres keeps 63 bytes). */
export function clientPart(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return clean === "" ? null : clean;
}

/** One connection to the Postgres API, as the user the URL names, under `applicationName`. */
function connect(s: Source, applicationName: string): Promise<PgConnection> {
  return PgConnection.connect({ host: s.host, port: s.port, database: s.database, user: s.user, password: s.password, sslmode: s.sslmode,
    applicationName, connectTimeoutMs: 10_000, textForms: [] });
}

/** Why a connection failed, in the failure shape: nothing listening, a password refused, a database it does not serve. */
function connectFailure(e: unknown, s: Source): Failure {
  const where = `${s.host}:${s.port}`;
  if (e instanceof PgError) {
    const hint = e.fields.H;
    if (e.code === "28P01" || e.code === "28000") {
      return { message: `${where} refused user ${s.user}: ${e.fields.M ?? e.message}`, code: "refused", why: hint,
        fix: "the URL mason user add printed for this user: a user removed (mason user list), or added under another API key, connects no more",
        next: [["mason user list", "the users, beside the run"], ADD_STEP] };
    }
    return { message: `${where} refused the connection: ${e.fields.M ?? e.message}${e.code ? ` (${e.code})` : ""}`, code: "refused", why: hint ?? e.detail,
      fix: "the URL mason user add printed: its database is the project's", next: [HELP_STEP] };
  }
  const reason = e instanceof Error ? socketErrorText(e) : String(e);
  const said = /ECONNREFUSED/.test(reason) ? `nothing is listening on ${where}` : reason.replace(/^connecting to \S+: /, "");
  return { message: `could not connect to ${maskedUrl(s.url)}: ${said}`, code: "unreachable",
    fix: "start Mason (mason start) or check the URL's host and port: mason status says where the Postgres API listens",
    next: [["mason status", "whether Mason runs, and where its Postgres API listens"], HELP_STEP] };
}

// ------------------------------------------------------------------ the command

export async function mcp(argv: string[]): Promise<number> {
  const f = parseCommand(MCP, argv);
  if (typeof f === "number") return f;
  // every failure to start is said on stderr: stdout is the protocol's (MCP.stdout), --json or not
  const json = false;
  if (f.positionals.length) return failed("mcp", { message: `it takes no argument (${f.positionals.join(" ")}): the URL goes in MASON_URL, or after --url`, code: "usage", usage: MCP.usage }, { json });
  const u = await theUrl(f.values.url as string | undefined, process.cwd());
  if ("message" in u) return failed("mcp", u, { json });
  const source = theSource(u.url, u.from);
  if ("message" in source) return failed("mcp", source, { json });
  // the URL is checked once, before the protocol starts: a client that cannot connect is told now, in the failure shape
  try { (await connect(source, "mason-mcp")).close(); }
  catch (e) { return failed("mcp", connectFailure(e, source), { json }); }
  log(`serving ${maskedUrl(source.url)} as ${source.user}, over MCP on stdio, until stdin closes`);
  await serve(new McpServer(source), process.stdin, (line) => { process.stdout.write(`${line}\n`); });
  return 0;
}

/**
 * Reads newline-delimited JSON-RPC from `input` and writes each answer as one line through `write`, until the input
 * ends and every request it carried is answered.
 */
async function serve(server: McpServer, input: NodeJS.ReadableStream, write: (line: string) => void): Promise<void> {
  const pending = new Set<Promise<void>>();
  // a frame is the protocol's, never a command's answer: one JSON value a line, so no newline inside it
  const send = (message: unknown): void => { const frame = JSON.stringify(message); write(frame); };
  const take = (line: string): void => {
    if (line.trim() === "") return;
    const p = server.handle(line).then((answer) => { if (answer !== null) send(answer); });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  let buf = "";
  input.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    input.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { take(buf.slice(0, nl).replace(/\r$/, "")); buf = buf.slice(nl + 1); }
    });
    input.on("end", () => { take(buf); resolve(); });
    input.on("error", reject);
  });
  await Promise.all(pending);
}

// ------------------------------------------------------------------ the protocol

/** The protocol versions this server speaks, the newest first: a client's is answered in kind, any other with the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** JSON-RPC's own error codes, and MCP's for a resource it does not have. */
const RPC = { parse: -32700, invalidRequest: -32600, noMethod: -32601, invalidParams: -32602, internal: -32603, noResource: -32002 } as const;

/** A request's id as MCP allows it: a string or an integer, never null. */
type Id = string | number;
const isId = (x: unknown): x is Id => typeof x === "string" || (typeof x === "number" && Number.isInteger(x));

/** A tool's answer as MCP carries it: the JSON as text for the model (and as structuredContent for a client), or an error. */
interface ToolAnswer { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: true }

/** A tool's failure the model reads and can act on: a refusal (Postgres's fields), or what was wrong with its arguments. */
class ToolError extends Error {
  readonly structured: Record<string, unknown>;
  constructor(text: string, structured: Record<string, unknown>) { super(text); this.structured = structured; }
}

/** An answer of Mason's this server could not read (EXPLAIN's JSON that does not parse): a bug to report, never a connection. */
class BadAnswer extends Error {}

/** A request this server answers with a JSON-RPC error (an unknown tool or resource), not a tool's own failure. */
class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

/** One request being answered: the connections it holds, so a cancellation reaches the statement running on them. */
interface Call { connections: Set<PgConnection>; cancelled: boolean }

export const MAX_ROWS = { default: 200, max: 10_000 } as const;
export const TIMEOUT_MS = { default: 30_000, max: 300_000 } as const;
/** how many EXPLAINs `tables` runs at once, each on a connection of its own */
const COPIES_AT_ONCE = 4;

/** The tools, as tools/list says them: names in Mason's words, each argument with what it is. */
export const TOOLS = [
  {
    name: "tables",
    title: "The tables Mason serves",
    description: "The tables Mason serves, each a copy of a table of the application's Postgres database: about how many rows each holds, " +
      "and how its copy is kept current and when it was last synced (sync: off — read again only when someone runs mason sync — or polled " +
      "every so often, or streamed by logical replication). A copy last synced days ago answers as of then: say so with the answer. " +
      "Start here: a statement can read only these, named as listed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "describe",
    title: "One table's columns",
    description: "One table's columns with their Postgres types, its primary key and foreign keys, about how many rows it holds, how its copy is kept current " +
      "and when it was last synced.",
    inputSchema: { type: "object", properties: { table: { type: "string", description: "the table as tables lists it (public.orders), or a bare name in public (orders)" } },
      required: ["table"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "query",
    title: "Run a statement",
    description: "Runs ONE SQL statement on Mason, which answers as Postgres does: write Postgres's SQL. Returns the columns with their Postgres types " +
      "and the rows as Postgres's text; truncated is true when max_rows cut the answer. A statement Mason does not answer is refused with its " +
      "SQLSTATE, and its hint says what to write instead: rewrite the statement and run it again. Mason is read-only: a write is refused.",
    inputSchema: { type: "object", properties: {
      sql: { type: "string", description: "one statement, in Postgres's SQL" },
      max_rows: { type: "integer", minimum: 1, maximum: MAX_ROWS.max, default: MAX_ROWS.default, description: `the most rows to return (default ${MAX_ROWS.default}, at most ${MAX_ROWS.max}): aggregate rather than raise it` },
      timeout_ms: { type: "integer", minimum: 1, maximum: TIMEOUT_MS.max, default: TIMEOUT_MS.default, description: `the statement's time limit in ms (default ${TIMEOUT_MS.default}, at most ${TIMEOUT_MS.max}): past it, SQLSTATE 57014` },
    }, required: ["sql"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "explain",
    title: "How Mason answers a statement",
    description: "How Mason answers one statement, as its EXPLAIN prints it: each copy the statement reads with its rows and how current it is, " +
      "the SQL Mason runs for it, and the plan. analyze: true runs the statement too and adds each step's rows and time.",
    inputSchema: { type: "object", properties: {
      sql: { type: "string", description: "one statement, in Postgres's SQL (without EXPLAIN)" },
      analyze: { type: "boolean", default: false, description: "run it, and say each step's rows and time" },
      timeout_ms: { type: "integer", minimum: 1, maximum: TIMEOUT_MS.max, default: TIMEOUT_MS.default, description: `with analyze, the statement's time limit in ms (default ${TIMEOUT_MS.default})` },
    }, required: ["sql"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

/** The resources: the agent's guide and this command's help, as `mason help` prints them. */
export const RESOURCES = [
  { uri: "mason://help/agent", name: "agent", title: "Driving Mason from an agent", description: "mason help agent: the commands in order, their --json shapes, exit codes and failures", mimeType: "text/plain" },
  { uri: "mason://help/mcp", name: "mcp", title: "mason mcp", description: "mason help mcp: this server's tools, and how to add it to a client", mimeType: "text/plain" },
] as const;

const INSTRUCTIONS = "Mason serves read-only copies of tables of an application's Postgres database, for analytical SQL (scans and aggregates). " +
  "Call tables first, describe a table before querying it, and write Postgres's SQL. Each table says how current its copy is. " +
  "When a statement is refused, its hint says what to write instead.";

/** A relation the catalog lists: a copy, or a view over copies. */
interface Relation extends TableName { kind: "table" | "view" }

/** The relations Mason serves, as the catalog lists them (a catalog read: no row of the request log). */
async function relations(pg: PgConnection): Promise<Relation[]> {
  const r = await pg.query(`SELECT n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      AND (pg_catalog.has_table_privilege(c.oid, 'SELECT') OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT')) ORDER BY 1, 2`);
  return r.rows.map(([schema, name, kind]) => ({ schema: schema!, name: name!, kind: kind === "v" || kind === "m" ? "view" : "table" }));
}

class McpServer {
  private applicationName = "mason-mcp";
  private readonly source: Source;
  /** the requests being answered, by their id (a cancellation names one) */
  private readonly calls = new Map<string, Call>();

  constructor(source: Source) { this.source = source; }

  /** One line of input: the answer to write, or null for a notification (or a batch of them). */
  async handle(line: string): Promise<unknown> {
    let msg: unknown;
    try { msg = JSON.parse(line); }
    catch { return rpcError(null, RPC.parse, "not JSON: one JSON-RPC message a line"); }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return rpcError(null, RPC.invalidRequest, "an empty batch");
      const answers = (await Promise.all(msg.map((m) => this.one(m)))).filter((a) => a !== null);
      return answers.length ? answers : null;
    }
    return this.one(msg);
  }

  private async one(msg: unknown): Promise<unknown> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return rpcError(null, RPC.invalidRequest, "a JSON-RPC message is an object");
    const m = msg as Record<string, unknown>;
    // an answer to a request of ours: this server sends none, so there is nothing to answer
    if (!("method" in m) && ("result" in m || "error" in m)) return null;
    const hasId = "id" in m;
    if (hasId && !isId(m.id)) return rpcError(null, RPC.invalidRequest, "a request's id is a string or an integer");
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(hasId ? m.id as Id : null, RPC.invalidRequest, "not a JSON-RPC 2.0 request: jsonrpc \"2.0\" and a method");
    const method = m.method;
    if (hasId && method.startsWith("notifications/")) return rpcError(m.id as Id, RPC.invalidRequest, `${method} is a notification: it carries no id`);
    if ("params" in m && (typeof m.params !== "object" || m.params === null || Array.isArray(m.params))) {
      return hasId ? rpcError(m.id as Id, RPC.invalidParams, "params is an object") : null;
    }
    const params = (m.params ?? {}) as Record<string, unknown>;
    if (!hasId) { this.notification(method, params); return null; }
    const id = m.id as Id;
    const key = `${typeof id}:${id}`;
    const call: Call = { connections: new Set(), cancelled: false };
    this.calls.set(key, call);
    try {
      const result = await this.method(method, params, call);
      if (call.cancelled) return null;
      if (result === undefined) return rpcError(id, RPC.noMethod, `there is no method ${method}`);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      // a request the client cancelled is answered no further (MCP: the receiver SHOULD NOT send a response)
      if (call.cancelled) return null;
      if (e instanceof RpcFailure) return rpcError(id, e.code, e.message);
      log(`${method} failed: ${(e as Error).message}`);
      return rpcError(id, RPC.internal, (e as Error).message);
    } finally { this.calls.delete(key); }
  }

  /** A notification: a cancellation ends its request's statement (Postgres's CancelRequest) and its connections. */
  private notification(method: string, params: Record<string, unknown>): void {
    if (method !== "notifications/cancelled") return;   // initialized, roots changed: nothing to do
    const requestId = params.requestId;
    const call = isId(requestId) ? this.calls.get(`${typeof requestId}:${requestId}`) : undefined;
    if (call === undefined) return;   // answered already, or never asked: MCP says to ignore it
    call.cancelled = true;
    log(`request ${JSON.stringify(requestId)} cancelled by the client${typeof params.reason === "string" ? `: ${params.reason}` : ""}`);
    for (const pg of call.connections) {
      // the statement is cancelled where it runs, then its connection closed: the call's work ends at once
      void pg.cancel().catch((e: unknown) => { log(`cancelling request ${JSON.stringify(requestId)}: ${(e as Error).message}`); })
        .finally(() => pg.close());
    }
  }

  /** A method's result; undefined for a method this server does not have. */
  private async method(method: string, params: Record<string, unknown>, call: Call): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const client = clientPart((params.clientInfo as { name?: unknown } | undefined)?.name);
        this.applicationName = client === null ? "mason-mcp" : `mason-mcp/${client}`;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked as never) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: "mason", title: "Mason", version: version() },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping": return {};
      case "tools/list": return { tools: TOOLS };
      case "tools/call": return this.call(params, call);
      case "resources/list": return { resources: RESOURCES };
      case "resources/templates/list": return { resourceTemplates: [] };
      case "resources/read": {
        const r = RESOURCES.find((x) => x.uri === params.uri);
        if (r === undefined) throw new RpcFailure(RPC.noResource, `there is no resource ${JSON.stringify(params.uri)}: ${RESOURCES.map((x) => x.uri).join(", ")}`);
        const { guideText } = await import("./guides.ts");
        return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.name === "agent" ? await guideText("agent") : MCP.usage }] };
      }
      default: return undefined;
    }
  }

  private async call(params: Record<string, unknown>, call: Call): Promise<ToolAnswer> {
    const name = params.name;
    if (typeof name !== "string") throw new RpcFailure(RPC.invalidParams, `tools/call names its tool (name): ${TOOLS.map((t) => t.name).join(", ")}`);
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) throw new RpcFailure(RPC.invalidParams, `there is no tool ${JSON.stringify(name)}${didYouMean(name, TOOLS.map((t) => t.name))}: ${TOOLS.map((t) => t.name).join(", ")}`);
    if (params.arguments !== undefined && (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments))) {
      throw new RpcFailure(RPC.invalidParams, "a tool's arguments are an object");
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const value = await this.tool(tool.name, args, call);
      // EXPLAIN is lines of text, read as psql prints them; every other answer is its JSON
      return { content: [{ type: "text", text: tool.name === "explain" ? String(value.plan) : pretty(value) }], structuredContent: value };
    } catch (e) {
      if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], structuredContent: e.structured, isError: true };
      if (e instanceof PgError) return refusal(e, 0);
      if (call.cancelled) throw e;
      // an answer of Mason's this server could not read, or a fault of its own: said so, to report — never "Mason is down"
      if (e instanceof BadAnswer || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) {
        log(`${tool.name}: ${(e as Error).stack ?? (e as Error).message}`);
        const text = `mason mcp could not read Mason's answer: ${(e as Error).message}. This is a bug in mason mcp: report it, with the statement.`;
        return { content: [{ type: "text", text }], structuredContent: { error: { message: text } }, isError: true };
      }
      // what is left is the connection's (pg-wire throws a PgError for every answer the server gave): Mason down, or
      // restarting; said as a tool error, so the agent can say it and try again
      const reason = e instanceof Error ? socketErrorText(e) : String(e);
      log(`${tool.name}: ${reason}`);
      const text = `Mason did not answer (${this.source.host}:${this.source.port}): ${reason}. mason status, beside the run, says whether it is up.`;
      return { content: [{ type: "text", text }], structuredContent: { error: { message: text } }, isError: true };
    }
  }

  private async tool(name: (typeof TOOLS)[number]["name"], args: Record<string, unknown>, call: Call): Promise<Record<string, unknown>> {
    switch (name) {
      case "tables": { argsOf(name, args, []); return this.session(call, TIMEOUT_MS.default, (pg) => this.tables(pg, call)); }
      case "describe": {
        argsOf(name, args, ["table"]);
        const table = text(args, "table");
        return this.session(call, TIMEOUT_MS.default, (pg) => this.describe(pg, call, table));
      }
      case "query": {
        argsOf(name, args, ["sql", "max_rows", "timeout_ms"]);
        const sql = text(args, "sql");
        const maxRows = int(args, "max_rows", MAX_ROWS.default, MAX_ROWS.max);
        const timeoutMs = int(args, "timeout_ms", TIMEOUT_MS.default, TIMEOUT_MS.max);
        return this.session(call, timeoutMs, (pg) => this.query(pg, sql, maxRows, timeoutMs));
      }
      case "explain": {
        argsOf(name, args, ["sql", "analyze", "timeout_ms"]);
        const sql = text(args, "sql");
        if (args.analyze !== undefined && typeof args.analyze !== "boolean") throw badArgument("analyze", "true or false");
        const timeoutMs = int(args, "timeout_ms", TIMEOUT_MS.default, TIMEOUT_MS.max);
        return this.session(call, timeoutMs, (pg) => this.explain(pg, sql, args.analyze === true, timeoutMs));
      }
    }
  }

  /** A connection of this call's, closed when it ends; a cancellation of the call reaches it (`notification`). */
  private async open(call: Call): Promise<PgConnection> {
    const pg = await connect(this.source, this.applicationName);
    call.connections.add(pg);
    if (call.cancelled) pg.close();
    return pg;
  }

  /**
   * A connection for one tool call, closed after it: a statement's timeout or a dropped session never outlives the call,
   * and a Mason restarted between calls is simply reached again. A server that never answers is let go 10 s past the limit.
   */
  private async session<T>(call: Call, timeoutMs: number, work: (pg: PgConnection) => Promise<T>): Promise<T> {
    const pg = await this.open(call);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { pg.close(); reject(new Error(`no answer ${Math.round(timeoutMs / 1000) + 10} s after the statement was sent`)); }, timeoutMs + 10_000);
    });
    try { return await Promise.race([work(pg), late]); }
    finally { clearTimeout(timer); for (const c of call.connections) c.close(); call.connections.clear(); }
  }

  /** Each relation the catalog lists, named as a statement writes it, with its copy's rows and how it is kept current. */
  private async tables(pg: PgConnection, call: Call): Promise<Record<string, unknown>> {
    const all = await relations(pg);
    const copies = await this.copies(pg, call, all.filter((t) => t.kind === "table"));
    return { tables: all.map((t) => t.kind === "view" ? { table: qualifiedName(t), kind: "view" } : { table: qualifiedName(t), kind: "table", ...copyFacts(copies.get(qualifiedName(t))) }) };
  }

  /**
   * HOW EACH COPY IS KEPT CURRENT, and its rows: EXPLAIN (FORMAT JSON)'s `Mason.Copies`, the sync's own words (what
   * `mason status` prints), read over the wire so a remote mason serve answers as a local run does. One EXPLAIN a table
   * (a union of them all failed whole for one table it could not plan, and left a refusal in the request log the agent
   * never sent), several at once on connections of this call's. In a run the catalog lists only the tables copied
   * (src/duck/sync.ts schemaBuilt), so an EXPLAIN refused here is a table removed between the two reads, said as its
   * kept line.
   */
  private async copies(pg: PgConnection, call: Call, tables: readonly TableName[]): Promise<Map<string, CopyRow | { error: string }>> {
    const out = new Map<string, CopyRow | { error: string }>();
    const explainOne = async (on: PgConnection, t: TableName): Promise<void> => {
      const key = qualifiedName(t);
      let r: ExtendedResult;
      try { r = await on.extended(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${pgIdent(t.schema)}.${pgIdent(t.name)}`, 0); }
      catch (e) { if (!(e instanceof PgError)) throw e; out.set(key, { error: e.fields.M ?? e.message }); return; }
      const text = r.rows.map((row) => row[0] ?? "").join("\n");
      let doc: Array<{ Mason?: { Copies?: CopyRow[] } }>;
      try { doc = JSON.parse(text) as typeof doc; }
      catch (e) { throw new BadAnswer(`EXPLAIN (FORMAT JSON) of ${key} is not JSON (${(e as Error).message}): ${text.slice(0, 200)}`); }
      const copy = doc[0]?.Mason?.Copies?.find((c) => c.Table === key);
      if (copy !== undefined) out.set(key, copy);
    };
    const queue = [...tables];
    const worker = async (on: PgConnection): Promise<void> => { for (let t = queue.shift(); t !== undefined; t = queue.shift()) await explainOne(on, t); };
    const extra = await Promise.all(Array.from({ length: Math.max(0, Math.min(COPIES_AT_ONCE, tables.length) - 1) }, () => this.open(call)));
    await Promise.all([pg, ...extra].map(worker));
    return out;
  }

  /**
   * ONE RELATION THE CATALOG LISTS, found by its name as `tables` prints it (`public."Clients"`), as the catalog holds
   * it (`public.Clients`), as a bare name in public (`orders`), or as Postgres reads a name (`sqlName`: quoting,
   * folding): never a relation `tables` does not list (pg_class, information_schema). Read here, never by to_regclass:
   * a name Postgres cannot read would be a refusal in the request log the agent never sent.
   */
  private async describe(pg: PgConnection, call: Call, asked: string): Promise<Record<string, unknown>> {
    const listed = await relations(pg);
    const found = listed.find((t) => qualifiedName(t) === asked || `${t.schema}.${t.name}` === asked)
      ?? listed.find((t) => t.schema === "public" && (t.name === asked || qualifiedName(t) === `public.${asked}`))
      ?? read(sqlName(asked), listed);
    if (found === undefined) {
      const names = listed.map(qualifiedName);
      // a bare name of a table in another schema: that table, with its schema (items is sales.items)
      const elsewhere = listed.filter((t) => t.name.toLowerCase() === asked.replace(/^"|"$/g, "").toLowerCase()).map(qualifiedName);
      const hint = elsewhere.length ? ` — did you mean ${elsewhere.map((n) => `\`${n}\``).join(" or ")}?` : didYouMean(asked, [...names, ...listed.filter((t) => t.schema === "public").map((t) => qualifiedName(t).slice("public.".length))]);
      throw new ToolError(`there is no table ${JSON.stringify(asked)} Mason serves${hint}. The tables: ${names.join(", ") || "none yet"}.`,
        { error: { message: `there is no table ${JSON.stringify(asked)}`, tables: names } });
    }
    const { schema, name, kind } = found;
    const rel = `${pgLiteral(qualifiedName(found))}::regclass`;
    // pg_catalog.format_type, written out: these are the catalog's own OIDs (mason_wire_type names the wire's)
    const columns = await pg.query(`SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_catalog.col_description(a.attrelid, a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'SELECT') ORDER BY a.attnum`);
    const key = await pg.query(`SELECT a.attname FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = ${rel} AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`);
    const foreign = await pg.query(`SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE conrelid = ${rel} AND contype = 'f' ORDER BY conname`);
    const comment = (await pg.query(`SELECT pg_catalog.obj_description(${rel}, 'pg_class')`)).rows[0]?.[0] ?? null;
    const copy = kind === "view" ? undefined : (await this.copies(pg, call, [{ schema, name }])).get(qualifiedName(found));
    return {
      table: qualifiedName(found), kind,
      ...(comment ? { comment } : {}),
      columns: columns.rows.map(([n, type, notNull, c]) => ({ name: n, type, not_null: notNull === "t", ...(c ? { comment: c } : {}) })),
      key: key.rows.map(([k]) => k),
      foreign_keys: foreign.rows.map(([d]) => d),
      ...(kind === "view" ? {} : copyFacts(copy)),
    };
  }

  private async query(pg: PgConnection, sql: string, maxRows: number, timeoutMs: number): Promise<Record<string, unknown>> {
    await pg.query(`SET statement_timeout = ${timeoutMs}`);
    const r = await pg.extended(sql, maxRows);
    if (r.empty) throw badArgument("sql", "a statement (it holds only comments or whitespace)");
    return { columns: await this.columns(pg, r), rows: r.rows, row_count: r.rows.length, truncated: r.suspended, ...(r.command ? { command: r.command } : {}) };
  }

  private async explain(pg: PgConnection, sql: string, analyze: boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    await pg.query(`SET statement_timeout = ${timeoutMs}`);
    const prefix = `EXPLAIN ${analyze ? "(ANALYZE) " : ""}`;
    let r: ExtendedResult;
    // a refusal's position is the statement's, not the EXPLAIN's around it
    try { r = await pg.extended(`${prefix}${sql}`, 0); }
    catch (e) { if (e instanceof PgError) throw new ToolAnswerError(refusal(e, prefix.length)); throw e; }
    if (r.empty) throw badArgument("sql", "a statement (it holds only comments or whitespace)");
    return { plan: r.rows.map((row) => row[0] ?? "").join("\n") };
  }

  /**
   * The answer's columns with their Postgres types: the RowDescription's OID and modifier named by the listener's
   * catalog, whose `mason_wire_type` names the OID the wire sends for a type the source made (an enum, a citext) —
   * src/api/postgres/catalog.ts `sourceTypeNames`, the one place a wire OID is named; format_type would give an OID the
   * catalog holds too its catalog meaning. Asked again each call: the catalog is rebuilt when the copied tables change.
   */
  private async columns(pg: PgConnection, r: ExtendedResult): Promise<Array<{ name: string; type: string }>> {
    if (r.fields.length === 0) return [];
    const k = (f: { typeOid: number; typmod: number }): string => `${f.typeOid}:${f.typmod}`;
    const distinct = [...new Map(r.fields.map((f) => [k(f), f])).values()];
    const names = await pg.query(`SELECT ${distinct.map((f) => `mason_wire_type(${f.typeOid}, ${f.typmod})`).join(", ")}`);
    const named = new Map(distinct.map((f, i) => [k(f), names.rows[0]?.[i] ?? String(f.typeOid)]));
    return r.fields.map((f) => ({ name: f.name, type: named.get(k(f))! }));
  }
}

/** A table's name as Postgres reads one: `schema.name` or `name` (in public, the search_path's first), a part in double
 *  quotes as written (`""` a quote), any other folded to lower case; null for what is not a name of one or two parts. */
export function sqlName(text: string): string[] | null {
  const parts: string[] = [];
  const s = text.trim();
  let at = 0;
  for (;;) {
    if (s[at] === '"') {
      let out = "", end = at + 1;
      for (;; end++) {
        if (end >= s.length) return null;   // an unclosed quote
        if (s[end] === '"') { if (s[end + 1] === '"') { out += '"'; end++; continue; } break; }
        out += s[end];
      }
      if (out === "") return null;
      parts.push(out);
      at = end + 1;
    } else {
      const m = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(s.slice(at));
      if (m === null) return null;
      parts.push(m[0].toLowerCase());
      at += m[0].length;
    }
    if (at === s.length) break;
    if (s[at] !== ".") return null;
    at++;
  }
  return parts.length <= 2 ? parts : null;
}

/** the listed relation a name read by `sqlName` names */
const read = (parts: string[] | null, listed: readonly Relation[]): Relation | undefined => {
  if (parts === null) return undefined;
  const [schema, name] = parts.length === 1 ? ["public", parts[0]] : parts;
  return listed.find((t) => t.schema === schema && t.name === name);
};

/** A tool's answer already made (explain's refusal, its position moved): thrown through the tool, returned as it is. */
class ToolAnswerError extends ToolError {
  constructor(answer: ToolAnswer) { super(answer.content[0]!.text, answer.structuredContent ?? {}); }
}

/** A JSON-RPC error answer. */
function rpcError(id: Id | null, code: number, message: string): unknown { return { jsonrpc: "2.0", id, error: { code, message } }; }

/** A copy as EXPLAIN (FORMAT JSON) says it (src/duck/explain.ts `keptJson`): `Table` as qualifiedName writes it. */
interface CopyRow { Table: string; "Estimated Rows": number | null; "Kept Current By": string | null; "Kept Current": string;
  /** in the poll's mode: the table's sync (off, poll 30s) and its last copy or poll */
  Sync?: string; "Last Synced"?: string | null }

/** A copy's facts as the tools say them: about how many rows, how it is kept current, what keeps it current now, and —
 *  polled or off — its sync and when it was last synced (a copy's age is never hidden: issue 33). */
function copyFacts(c: CopyRow | { error: string } | undefined): Record<string, unknown> {
  if (c === undefined) return { rows_about: null, kept: "how it is kept current is unknown: Mason has no copy of it" };
  if ("error" in c) return { rows_about: null, kept: `how it is kept current could not be read: ${c.error}` };
  return { rows_about: c["Estimated Rows"], kept: c["Kept Current"], kept_current_by: c["Kept Current By"],
    ...(c.Sync !== undefined ? { sync: c.Sync, last_synced: c["Last Synced"] ?? null } : {}) };
}

/** A refusal as the model reads it: Postgres's fields, as psql prints them, and the same as structured content.
 *  `shift`: the characters this server put before the statement (EXPLAIN's), taken off its position. */
function refusal(e: PgError, shift: number): ToolAnswer {
  const f = e.fields;
  const position = f.P !== undefined && Number(f.P) > shift ? Number(f.P) - shift : undefined;
  const error = { sqlstate: e.code, message: f.M ?? e.message, ...(f.D ? { detail: f.D } : {}), ...(f.H ? { hint: f.H } : {}), ...(position !== undefined ? { position } : {}) };
  const text = [`${f.S ?? "ERROR"} ${e.code}: ${error.message}`, ...(f.D ? [`DETAIL: ${f.D}`] : []), ...(f.H ? [`HINT: ${f.H}`] : [])].join("\n");
  return { content: [{ type: "text", text }], structuredContent: { error }, isError: true };
}

/** Arguments a tool does not take, said with the ones it does. */
function argsOf(tool: string, args: Record<string, unknown>, known: readonly string[]): void {
  const stray = Object.keys(args).filter((k) => !known.includes(k));
  if (stray.length) {
    throw new ToolError(`${tool} takes ${known.length ? known.join(", ") : "no arguments"}, not ${stray.join(", ")}${didYouMean(stray[0]!, [...known])}`,
      { error: { message: `unknown argument ${stray.join(", ")}`, arguments: known } });
  }
}

const badArgument = (name: string, what: string): ToolError => new ToolError(`${name} must be ${what}`, { error: { message: `${name} must be ${what}`, argument: name } });

function text(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.trim() === "" || v.includes("\0")) throw badArgument(name, "a non-empty string, with no NUL");
  return v;
}

function int(args: Record<string, unknown>, name: string, fallback: number, max: number): number {
  const v = args[name];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw badArgument(name, `an integer from 1 to ${max}`);
  return v;
}

/**
 * JSON for a model to read: an object or a list of scalars on one line when it is short, every other list an item a
 * line — a result's rows each on a line of their own, never a cell a line.
 */
export function pretty(v: unknown, indent = ""): string {
  const flat = JSON.stringify(v);
  const scalar = (x: unknown): boolean => x === null || typeof x !== "object";
  if (Array.isArray(v)) {
    if (v.length === 0 || v.every(scalar)) return flat;
    return `[\n${v.map((x) => `${indent}  ${pretty(x, `${indent}  `)}`).join(",\n")}\n${indent}]`;
  }
  if (v !== null && typeof v === "object") {
    if (flat.length <= 100 && Object.values(v).every((x) => scalar(x) || (Array.isArray(x) && x.every(scalar)))) return flat;
    return `{\n${Object.entries(v).map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${pretty(x, `${indent}  `)}`).join(",\n")}\n${indent}}`;
  }
  return flat;
}
