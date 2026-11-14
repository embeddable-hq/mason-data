/**
 * THE OPERATOR'S TABLE EDITS (docs/WEB-UI.md "An operator's table edits", issue 778): a process on the same machine
 * reaches the run over MASON_UI_SOCKET with the port and token MASON_UI_RUN_FILE wrote, and lists the database's tables
 * (`GET /api/state`, lean; `GET /api/tables/<table>/columns`), adds one (`POST /api/pick`) and removes some
 * (`POST /api/remove`) — the routes `mason add` and `mason remove` use while Mason is up. Their shapes are a contract:
 * each status, each key and each refusal's failure shape is pinned here, over the real server on a real socket, so a
 * change to any is a test failing by name, and a deliberate contract change. Under MASON_UI_READ_ONLY=1 a request
 * without the token (the page's) is refused, one with it (the operator's) served. The token reaches no answer and no log.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { readSource, newSourceText, replicatedEntries, entryName } from "../src/cli/sources.ts";
import { liveReadinessFailure } from "../src/cli/replication-mode.ts";
import { listenOnUiSocket, prepareUiSocket } from "../src/cli/ui-socket.ts";
import { prepareUiRunFile, writeUiRunFile } from "../src/cli/ui-run-file.ts";
import type { CopyState } from "../src/duck/sync.ts";

const TOKEN = "op".repeat(32);
// every answer read and every line a run logged: none carries the token
const seen: string[] = [];
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// a short folder: a socket's path is at most 107 bytes, and os.tmpdir() may be long
const temp = (): string => { const d = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "mop-")); fs.chmodSync(d, 0o700); made.push(d); return d; };

const col = (name: string, type = "text", notNull = false) => ({ name, type, notNull, comment: null });
const table = (o: Partial<SourceTable> & { table: string }): SourceTable => ({
  source: `public.${o.table}`, schema: "public", key: ["id"], rows: 3, bytes: 8192, comment: null,
  columns: [col("id", "bigint", true), col("name")], foreignKeys: [], ...o,
});
const TABLES = [
  table({ table: "customers" }),
  table({ table: "orders", columns: [col("id", "bigint", true), col("customer_id", "bigint")], foreignKeys: [{ column: "customer_id", target: "public.customers", targetColumn: "id" }] }),
  table({ table: "logs", key: [] }),
  table({ table: "events", key: [], columns: [col("tenant_id", "bigint", true), col("id", "bigint", true), col("body")],
    uniqueKeys: [{ name: "events_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] }),
];
const URL_ = "postgres://me@localhost:5432/app";
const parsed = parseSource(URL_);
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);

interface Operator { socket: string; port: number; token: string; root: string; sourceFile: string; logged: string[]; changed: () => number; setCopies: (c: CopyState[]) => void;
  setTables: (t: SourceTable[]) => void; polled: string[] }

/** `mason serve`'s run as an operator meets it: a project with a sources file, the server on a Unix socket, the run file. */
async function operator(o: { pageReadOnly?: boolean; pageReadOnlyAllow?: string[]; runUrl?: string; checkReplication?: RunContext["checkReplication"] } = {}): Promise<Operator> {
  const root = temp();
  const folder = path.join(root, "mason");
  const sourceFile = path.join(folder, "sources", "app.yml");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, newSourceText(URL_));
  const logged: string[] = [];
  let changed = 0;
  let copies: CopyState[] = [];
  let tables: SourceTable[] = TABLES;
  const polled: string[] = [];
  const read = (): ReturnType<RunContext["readSource"]> => readSource(folder, root, {});
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables, systemIdentifier: null }), warnings: [], replication: () => null,
    port: 4039, token: TOKEN, page: true, served: true, ...(o.pageReadOnly === undefined ? {} : { pageReadOnly: o.pageReadOnly }),
    ...(o.pageReadOnlyAllow === undefined ? {} : { pageReadOnlyAllow: o.pageReadOnlyAllow }),
    users: { file: path.join(root, "users.json"), apiKey: "k".repeat(48), database: "app", postgresUrl: "postgresql://localhost:5433/app" },
    folder: () => folder, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(),
    // the run's own read of the file, as `sourcesChanged` leaves it (src/cli/dev.ts `added`: set before it returns)
    sources: () => { const r = read(); return "message" in r ? { file: null, problem: r.message } : { file: r, problem: null }; },
    sourcesChanged: () => { changed++; }, log: (m: string) => { logged.push(m); seen.push(m); },
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session: number) => ({ unknown: session }) },
    logs: { capacity: 10, recent: () => [] },
    readSource: read, runUrl: o.runUrl ?? URL_, ...(o.checkReplication ? { checkReplication: o.checkReplication } : {}),
    duck: { copies: () => copies, file: path.join(root, "duck.db"), poll: async (t: string[]) => { polled.push(...t); return { at: "2026-11-08T10:00:00.000Z", tables: [] }; },
      stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }), restarts: () => [], requests: { days: 7 } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  const socket = path.join(root, "ui.sock");
  assert.equal(await prepareUiSocket(socket, () => undefined), null);
  const sock = await listenOnUiSocket(socket, () => undefined);
  if ("message" in sock) assert.fail(sock.message);
  sock.attach(server);
  after(() => sock.close());
  // the run file, as MASON_UI_RUN_FILE has it written: the operator reads the port and the token from it alone
  const runFile = path.join(root, "run.json");
  assert.equal(await prepareUiRunFile(runFile, () => undefined), null);
  const written = writeUiRunFile(runFile, { port: ctx.port, token: TOKEN }, () => undefined);
  if ("message" in written) assert.fail(written.message);
  const { port, token } = JSON.parse(fs.readFileSync(runFile, "utf8")) as { port: number; token: string };
  return { socket, port, token, root, sourceFile, logged, changed: () => changed, setCopies: (c) => { copies = c; }, setTables: (t) => { tables = t; }, polled };
}

interface Answer { status: number; type: string | undefined; text: string }
/** A request on the socket. `as`: the operator's (Host and the run's token), the page's (its cookie, its Origin), or bare. */
function ask(op: Operator, method: string, p: string, o: { body?: unknown; raw?: string; as?: "operator" | "page" | "nobody"; headers?: Record<string, string> } = {}): Promise<Answer> {
  const as = o.as ?? "operator";
  const headers: Record<string, string> = { Host: `127.0.0.1:${op.port}`, Connection: "close",
    ...(as === "operator" ? { Authorization: `Bearer ${op.token}` } : {}),
    ...(as === "page" ? { Cookie: `mason_dev_${op.port}=${op.token}`, ...(method === "GET" ? {} : { Origin: `http://127.0.0.1:${op.port}` }) } : {}),
    ...(o.body !== undefined || o.raw !== undefined ? { "Content-Type": "application/json" } : {}), ...o.headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: op.socket, method, path: p, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { text += c; });
      res.on("end", () => { seen.push(text); resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], text }); });
    });
    req.on("error", reject);
    req.end(o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)));
  });
}
const json = (a: Answer): Record<string, unknown> => { assert.equal(a.type, "application/json", a.text); return JSON.parse(a.text) as Record<string, unknown>; };
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
/** A refusal's answer: `error` (the sentence) and `failure`, the CLI's Failure shape; held to both, and returned. */
function refusal(a: Answer, status: number, code: string): { code: string; message: string; why?: string; fix?: string; next: Array<{ command: string; what?: string }> } {
  assert.equal(a.status, status, a.text);
  const body = json(a) as { error: string; failure: { code: string; message: string; why?: string; fix?: string; next: Array<{ command: string; what?: string }> } };
  assert.deepEqual(keys(body), ["error", "failure"], a.text);
  assert.equal(body.failure.code, code, a.text);
  assert.equal(body.error, body.failure.message, "error is the failure's message");
  for (const k of keys(body.failure)) assert.ok(["code", "message", "why", "fix", "next"].includes(k), `failure key ${k}`);
  assert.ok(Array.isArray(body.failure.next));
  return body.failure;
}

/** THE CONTRACT'S KEYS, as the doc lists them: a key added or renamed here is a contract change, said in the doc. */
const LEAN_TABLE = ["added", "addedColumns", "bytes", "columnCount", "comment", "copy", "copyKey", "error", "key", "reason", "rows", "table"];
/** An added table's entry as the sources file says it, and the columns every column leaves out (issue 884). */
const ADDED_ENTRY = ["entry", "everyColumnLeavesOut"];
const PICK_ANSWER = ["addedKey", "already", "bigOff", "columns", "entry", "exclude", "file", "key", "notReplicated", "pollCost", "skippedSecrets", "state", "sync", "table"];
const REMOVE_ANSWER = ["file", "removed", "state"];
const COLUMN = ["comment", "name", "nullable", "references", "type"];

test("the table list: GET /api/state is lean — per table its name, key, rows, whether it is added and why it cannot be — and one table's columns are GET /api/tables/<table>/columns", async () => {
  const op = await operator();
  const state = json(await ask(op, "GET", "/api/state")) as { tables: Array<Record<string, unknown>>; sourcesReadOnly: unknown; pageReadOnly: unknown; source: { sync: unknown } };
  assert.deepEqual(state.tables.map((t) => t.table), ["public.customers", "public.orders", "public.logs", "public.events"]);
  for (const t of state.tables) assert.deepEqual(keys(t), LEAN_TABLE, `${String(t.table)}: no columns, no sync before it is added`);
  const by = new Map(state.tables.map((t) => [t.table, t]));
  assert.deepEqual(by.get("public.customers"), { table: "public.customers", rows: 3, bytes: 8192, key: ["id"], comment: null, reason: null, added: false, addedColumns: null, copyKey: null, columnCount: 2, copy: null, error: null });
  assert.equal(by.get("public.logs")!.reason, "no primary key: name the columns that tell its rows apart, mason add logs --key <column>,…");
  assert.equal(by.get("public.events")!.reason, "no primary key: name the columns that tell its rows apart, mason add events --key tenant_id,id (its unique index events_tenant_id_id_key)");
  assert.equal(state.sourcesReadOnly, null);
  assert.equal(state.pageReadOnly, null);
  assert.deepEqual(state.source.sync, { default: "off", written: true }, "the file's sync, every entry's unless its own says");

  const one = await ask(op, "GET", `/api/tables/${encodeURIComponent("public.orders")}/columns`);
  assert.equal(one.status, 200);
  const cols = json(one) as { table: string; columns: Array<Record<string, unknown>> };
  assert.deepEqual(keys(cols), ["columns", "table"]);
  for (const c of cols.columns) assert.deepEqual(keys(c), COLUMN);
  assert.deepEqual(cols.columns[1], { name: "customer_id", type: "bigint", nullable: true, comment: null, references: { table: "public.customers", column: "id" } });
  const gone = refusal(await ask(op, "GET", "/api/tables/public.gone/columns"), 404, "not_found");
  assert.equal(gone.message, 'the database has no table "public.gone" this user can read');
  assert.equal(refusal(await ask(op, "GET", "/api/tables/public.%E0%A4%A/columns"), 400, "usage").message,
    "/api/tables/public.%E0%A4%A/columns does not name a table: GET /api/tables/<schema.table, URL-encoded>/columns");
});

test("an added table in the list: added, its columns and its sync's state; once the sync holds it, how it is kept current (kept) and its copy", async () => {
  const op = await operator();
  assert.equal((await ask(op, "POST", "/api/pick", { body: { table: "public.customers", picked: true } })).status, 200);
  let t = (json(await ask(op, "GET", "/api/state")) as { tables: Array<Record<string, unknown>> }).tables.find((x) => x.table === "public.customers")!;
  assert.deepEqual(keys(t), [...LEAN_TABLE, ...ADDED_ENTRY, "sync", "syncRefusal"].sort());
  assert.equal(t.syncRefusal, "public.customers is not added (mason add adds it)", "the sync does not hold it yet: mason sync's own refusal (issue 812)");
  assert.equal(t.added, true);
  assert.deepEqual(t.addedColumns, ["id", "name"]);
  assert.deepEqual(keys(t.sync), ["ageSeconds", "asOf", "behindBySeconds", "behindWhy", "promisedSeconds", "state", "syncSeconds", "syncedAt", "syncedBy"]);
  const kept = { by: "poll" as const, sync: { mode: "poll" as const, every: "5m", seconds: 300 }, syncedAt: "2026-11-08T10:00:00.000Z", nextAt: "2026-11-08T10:05:00.000Z" };
  op.setCopies([{ source: "public.customers", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-11-08T10:00:00.000Z", error: null, kept }]);
  t = (json(await ask(op, "GET", "/api/state")) as { tables: Array<Record<string, unknown>> }).tables.find((x) => x.table === "public.customers")!;
  assert.deepEqual(keys(t), [...LEAN_TABLE, ...ADDED_ENTRY, "duck", "kept", "sync", "syncRefusal"].sort());
  assert.equal(t.syncRefusal, null, "the sync's state says none: mason sync runs it");
  assert.deepEqual(t.kept, kept);
  assert.deepEqual(keys(t.copy), ["phase", "rowsCopied", "updatedAt"]);
  assert.equal((t.copy as { phase: string }).phase, "done");
});

test("a table's copy: phase copying (with progress while its chunks are read), done (with retired in an old layout) or failed; none while waiting", async () => {
  const op = await operator();
  for (const t of ["public.customers", "public.orders"]) assert.equal((await ask(op, "POST", "/api/pick", { body: { table: t, picked: true } })).status, 200);
  const progress = { chunksDone: 2, chunksTotal: 8, reading: 2, readingSeconds: 3, rowsReading: 10, rowsPerSecond: 100, bytesPerSecond: 8000, secondsLeft: 60, share: 0.25 };
  const copyOf = async (c: CopyState): Promise<Record<string, unknown> | null> => {
    op.setCopies([c]);
    const t = (json(await ask(op, "GET", "/api/state")) as { tables: Array<Record<string, unknown>> }).tables.find((x) => x.table === c.source)!;
    return t.copy as Record<string, unknown> | null;
  };
  const base = { source: "public.customers", rows: null, bytes: 8192, seconds: null, copiedAt: null, error: null };
  assert.deepEqual(await copyOf({ ...base, phase: "copying", rowsSoFar: 40, progress } as CopyState), { phase: "copying", rowsCopied: 40, updatedAt: "", progress });
  assert.deepEqual(await copyOf({ ...base, phase: "copying", rowsSoFar: 40 } as CopyState), { phase: "copying", rowsCopied: 40, updatedAt: "" }, "progress only while chunks are read");
  assert.deepEqual(await copyOf({ ...base, phase: "copied", rows: 3, copiedAt: "2026-11-08T10:00:00.000Z", retired: "an older layout" } as CopyState),
    { phase: "done", rowsCopied: 3, updatedAt: "2026-11-08T10:00:00.000Z", retired: "an older layout" });
  assert.deepEqual(await copyOf({ ...base, phase: "failed", rowsSoFar: 5, error: "boom" } as CopyState), { phase: "failed", rowsCopied: 5, updatedAt: "" });
  assert.equal(await copyOf({ ...base, phase: "waiting" } as CopyState), null, "waiting: no copy yet");
  op.setCopies([]);
});

test("POST /api/pick adds a table: 200 with what was written and the state after; the same again is already: true; picked: false removes it", async () => {
  const op = await operator();
  const before = fs.readFileSync(op.sourceFile, "utf8");
  const added = json(await ask(op, "POST", "/api/pick", { body: { table: "public.events", picked: true, key: ["tenant_id", "id"], columns: ["body"], sync: "poll 5m" } }));
  assert.deepEqual(keys(added), PICK_ANSWER);
  const { state, ...r } = added;
  assert.deepEqual(r, { table: "public.events", file: op.sourceFile, entry: "events", columns: ["tenant_id", "id", "body"], exclude: [], key: ["tenant_id", "id"],
    addedKey: ["tenant_id", "id"], skippedSecrets: [], already: false, sync: { value: "poll 5m", from: "entry" }, bigOff: false, notReplicated: null, pollCost: null });
  assert.equal((state as { tables: Array<{ table: string; added: boolean }> }).tables.find((t) => t.table === "public.events")!.added, true, "the state after the edit");
  for (const t of (state as { tables: object[] }).tables) assert.ok(!("columns" in t), "the lean state");
  assert.notEqual(fs.readFileSync(op.sourceFile, "utf8"), before);
  assert.match(fs.readFileSync(op.sourceFile, "utf8"), /events:\n {4}columns: \[tenant_id, id, body\]\n {4}key: \[tenant_id, id\]\n {4}sync: poll 5m\n/);
  assert.equal(op.changed(), 1, "the run reads the file again: the first sync starts");
  assert.deepEqual(op.logged, [`added public.events to ${op.sourceFile}`]);

  const again = json(await ask(op, "POST", "/api/pick", { body: { table: "public.events", picked: true, key: ["tenant_id", "id"], columns: ["body"], sync: "poll 5m" } }));
  assert.equal(again.already, true, "nothing written");
  assert.equal(op.logged.length, 1);

  const synced = json(await ask(op, "POST", "/api/pick", { body: { table: "public.events", picked: true, key: ["tenant_id", "id"], sync: "off", keep: true } }));
  assert.deepEqual(synced.sync, { value: "off", from: "entry" }, "keep: only its sync changes (a --key table names its key again)");
  assert.deepEqual(synced.columns, ["tenant_id", "id", "body"]);

  const removed = json(await ask(op, "POST", "/api/pick", { body: { table: "public.events", picked: false } }));
  assert.deepEqual(keys(removed), REMOVE_ANSWER);
  for (const t of (removed.state as { tables: object[] }).tables) assert.deepEqual(keys(t), LEAN_TABLE, "the lean state");
  assert.deepEqual(removed.removed, ["public.events"]);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before, "every other byte as it was");
});

test("POST /api/pick's refusals: status, code and sentence in the failure shape, and nothing written", async () => {
  const op = await operator();
  const before = fs.readFileSync(op.sourceFile, "utf8");
  const pick = (body: unknown) => ask(op, "POST", "/api/pick", { body });
  const cases: Array<[unknown, number, string, string | RegExp]> = [
    [{ table: "public.customers" }, 400, "usage", "send { table, picked, columns?, key?, sync?, keep? }"],
    [{ table: "public.customers", picked: true, sync: "sometimes" }, 400, "usage", /^sync "sometimes": /],
    [{ table: "public.customers", picked: true, columns: "name" }, 400, "usage", 'columns is a list of column names, or ["*"]'],
    [{ table: "public.customers", picked: true, key: [] }, 400, "usage", "key is a list of column names"],
    [{ table: "public.customers", picked: true, key: ["id"] }, 400, "usage", "public.customers has a primary key (id), which Mason keys it by: leave --key out"],
    [{ table: "public.customers", picked: true, columns: ["nme"] }, 400, "usage", /nme/],
    [{ table: "public.events", picked: true, key: ["id"] }, 400, "usage", "tables.events.key: no unique index of public.events is over (id), so two of its rows may share them and Mason could not tell them apart — name the columns of one: key: [tenant_id, id] (its unique index events_tenant_id_id_key)"],
    [{ table: "public.events", picked: true, key: ["tenant_id", "id"], sync: "replication" }, 400, "usage", /^public\.events cannot be kept current by logical replication: /],
    [{ table: "public.nope", picked: true }, 404, "not_found", "public.nope is not a table of app that this user can read"],
    [{ table: "public.logs", picked: true }, 409, "refused", "public.logs cannot be added: no primary key: name the columns that tell its rows apart, mason add logs --key <column>,…"],
    [{ table: "public.customers", picked: false }, 404, "not_found", /customers/],
  ];
  for (const [body, status, code, message] of cases) {
    const f = refusal(await pick(body), status, code);
    if (typeof message === "string") assert.equal(f.message, message, JSON.stringify(body));
    else assert.match(f.message, message, JSON.stringify(body));
  }
  const notJson = refusal(await ask(op, "POST", "/api/pick", { raw: "{table" }), 400, "usage");
  assert.match(notJson.message, /^the body is not JSON: /);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before, "no refusal wrote the file");
  assert.equal(op.changed(), 0);
  assert.deepEqual(op.logged, []);
});

test("an edit of a project deployed read-only (MASON_PROJECT_READONLY=1) is refused 409 with why, fix and next", async () => {
  const op = await operator();
  const was = process.env.MASON_PROJECT_READONLY;
  process.env.MASON_PROJECT_READONLY = "1";
  try {
    const state = json(await ask(op, "GET", "/api/state"));
    assert.match(String(state.sourcesReadOnly), /^The project's files are read-only here \(MASON_PROJECT_READONLY=1\)\. /, "the list says so first");
    for (const [p, body] of [["/api/pick", { table: "public.customers", picked: true }], ["/api/remove", { tables: ["customers"] }]] as const) {
      const f = refusal(await ask(op, "POST", p, { body }), 409, "refused");
      assert.equal(f.message, "the project's files are read-only here (MASON_PROJECT_READONLY=1)", p);
      assert.ok(f.why && f.fix && f.next.length, p);
    }
  } finally { if (was === undefined) delete process.env.MASON_PROJECT_READONLY; else process.env.MASON_PROJECT_READONLY = was; }
});

test("POST /api/remove: 200 { removed, file, state }; a name the file lacks 404 with the closest, a body that names none 400", async () => {
  const op = await operator();
  const before = fs.readFileSync(op.sourceFile, "utf8");
  for (const t of ["public.customers", "public.orders"]) assert.equal((await ask(op, "POST", "/api/pick", { body: { table: t, picked: true } })).status, 200);
  const missing = refusal(await ask(op, "POST", "/api/remove", { body: { tables: ["customer"] } }), 404, "not_found");
  assert.match(missing.message, /customers/, "the closest it has");
  assert.equal(refusal(await ask(op, "POST", "/api/remove", { body: { tables: ["a.b.c"] } }), 400, "usage").message.length > 0, true, "a name that is no table's name");
  for (const body of [{}, { tables: [] }, { tables: "customers" }, { tables: [1] }]) {
    assert.equal(refusal(await ask(op, "POST", "/api/remove", { body }), 400, "usage").message, "send { tables: [name, …] }", JSON.stringify(body));
  }
  const r = json(await ask(op, "POST", "/api/remove", { body: { tables: ["customers", "public.orders"] } }));
  assert.deepEqual(keys(r), REMOVE_ANSWER);
  assert.deepEqual({ removed: r.removed, file: r.file }, { removed: ["public.customers", "public.orders"], file: op.sourceFile });
  assert.ok((r.state as { tables: Array<{ added: boolean }> }).tables.every((t) => !t.added), "the state after the edit");
  for (const t of (r.state as { tables: object[] }).tables) assert.deepEqual(keys(t), LEAN_TABLE, "the lean state");
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before);
  assert.deepEqual(op.logged.slice(2), ["removed public.customers from " + op.sourceFile, "removed public.orders from " + op.sourceFile]);
});

test("the guard before every route: no token, another token, or another Host is refused in plain text, before any route is read", async () => {
  const op = await operator();
  const before = fs.readFileSync(op.sourceFile, "utf8");
  const body = { table: "public.customers", picked: true };
  const none = await ask(op, "POST", "/api/pick", { body, as: "nobody" });
  assert.deepEqual([none.status, none.text], [403, "this is mason start's command server for the mason command: a request carries the run's token (Authorization: Bearer, from .mason/config.json)\n"]);
  assert.match(String(none.type), /^text\/plain/);
  const wrong = await ask(op, "POST", "/api/pick", { body, headers: { Authorization: "Bearer not-the-token" } });
  assert.deepEqual([wrong.status, wrong.text], [403, "the Authorization header does not carry this run's token\n"]);
  const host = await ask(op, "POST", "/api/pick", { body, headers: { Host: "mason.internal" } });
  assert.equal(host.status, 421);
  assert.match(host.text, /^this server answers only as 127\.0\.0\.1:4039/);
  assert.equal((await ask(op, "GET", "/api/state", { headers: { Host: `localhost:${op.port}` } })).status, 200, "localhost:<port> is the same Host");
  assert.equal((await ask(op, "GET", "/api/state", { headers: { "Content-Type": "text/plain" } })).status, 200);
  const untyped = await ask(op, "POST", "/api/remove", { raw: JSON.stringify({ tables: ["nope"] }), headers: { "Content-Type": "text/plain" } });
  assert.equal(untyped.status, 404, "the body is read as JSON whatever its Content-Type");
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before);
});

test("an edit while the file's url: names another database than the run syncs is refused 409, nothing written", async () => {
  const op = await operator({ runUrl: "postgres://me@localhost:5432/other" });
  const before = fs.readFileSync(op.sourceFile, "utf8");
  for (const [p, body] of [["/api/pick", { table: "public.customers", picked: true }], ["/api/remove", { tables: ["customers"] }]] as const) {
    const f = refusal(await ask(op, "POST", p, { body }), 409, "refused");
    assert.equal(f.message, "mason/sources/app.yml: url: now names postgres://me@localhost:5432/app (mason/sources/app.yml), and this run syncs postgres://me@localhost:5432/other: " +
      "mason stop && mason start syncs from the new one, then add or remove the table", p);
  }
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before);
  assert.equal(op.changed(), 0);
});

test("a live switch to sync: replication the database cannot serve is refused 409 with what it lacks; the file is put back byte for byte", async () => {
  const op = await operator({ checkReplication: async (file) => {
    const replicated = replicatedEntries(file).map((e) => entryName(e.table));
    return replicated.length === 0 ? null : liveReadinessFailure({ refused: [{ name: "wal_level", ok: false, detail: "replica: logical replication needs logical" }], warnings: [] },
      replicated, "mason/sources/app.yml", "app");
  } });
  assert.equal((await ask(op, "POST", "/api/pick", { body: { table: "public.customers", picked: true } })).status, 200);
  const before = fs.readFileSync(op.sourceFile, "utf8");
  const f = refusal(await ask(op, "POST", "/api/pick", { body: { table: "public.customers", picked: true, sync: "replication", keep: true } }), 409, "refused");
  assert.equal(f.message, "customers cannot be kept current by logical replication from app: wal_level");
  assert.ok(f.why && f.fix);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before, "the file as it was");
  assert.equal(op.changed(), 1, "the run is told of the add alone, not of the edit it did not take");
});

test("an edit while another entry of the file fails against the database is refused 409 — a remove and an add — nothing written", async () => {
  const op = await operator();
  for (const t of ["public.customers", "public.orders"]) assert.equal((await ask(op, "POST", "/api/pick", { body: { table: t, picked: true } })).status, 200);
  const before = fs.readFileSync(op.sourceFile, "utf8");
  op.setTables(TABLES.filter((t) => t.source !== "public.orders"));   // dropped on the database since
  const f = refusal(await ask(op, "POST", "/api/remove", { body: { tables: ["customers"] } }), 409, "refused");
  assert.match(f.message, /orders/);
  assert.match(f.message, / — fix it first, then remove customers$/);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before);
  // an add is held to the same: the file's other entries must hold first
  const added = refusal(await ask(op, "POST", "/api/pick", { body: { table: "public.events", picked: true, key: ["tenant_id", "id"] } }), 409, "refused");
  assert.match(added.message, / — fix it first, then add events$/);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before);
});

test("the run's own failure is 500 failed, with mason logs next: a sources file it cannot read", async () => {
  const op = await operator();
  fs.rmSync(op.sourceFile);
  fs.mkdirSync(op.sourceFile);   // a folder where the file was: reading it fails
  const f = refusal(await ask(op, "POST", "/api/pick", { body: { table: "public.customers", picked: true } }), 500, "failed");
  assert.match(f.message, /EISDIR/);
  assert.deepEqual(f.next, [{ command: "mason logs", what: "the run's log: what it was doing" }]);
  assert.ok(op.logged.some((l) => l.startsWith("command server: POST /api/pick failed: ")), "said once in the run's log");
});

test("MASON_UI_READ_ONLY=1 refuses the page, not the operator: without the token an edit is refused 403, with it served", async () => {
  const op = await operator({ pageReadOnly: true });
  const before = fs.readFileSync(op.sourceFile, "utf8");
  for (const [p, body] of [["/api/pick", { table: "public.customers", picked: true }], ["/api/remove", { tables: ["customers"] }]] as const) {
    const f = refusal(await ask(op, "POST", p, { body, as: "page" }), 403, "refused");
    assert.equal(f.message, "the web page is read-only here (MASON_UI_READ_ONLY=1): it shows what Mason syncs, and changes nothing", p);
  }
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before, "the page's edit wrote nothing");
  const state = json(await ask(op, "GET", "/api/state", { as: "page" }));
  assert.equal(state.pageReadOnly, "the web page is read-only here (MASON_UI_READ_ONLY=1)", "the page still views");
  const added = await ask(op, "POST", "/api/pick", { body: { table: "public.customers", picked: true } });
  assert.equal(added.status, 200, added.text);
  assert.equal(json(added).already, false);
  const removed = await ask(op, "POST", "/api/remove", { body: { tables: ["customers"] } });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before);
});

test("MASON_UI_READ_ONLY_ALLOW=tables: the read-only page adds a table (every column, Columns…, Name its key…), removes one (Remove, and a pick undone) and syncs one; a user, a cancel and a share are still refused 403 (issue 789)", async () => {
  const op = await operator({ pageReadOnly: true, pageReadOnlyAllow: ["tables"] });
  const before = fs.readFileSync(op.sourceFile, "utf8");
  const page = async (p: string, body: unknown): Promise<Record<string, unknown>> => { const a = await ask(op, "POST", p, { body, as: "page" }); assert.equal(a.status, 200, `${p}: ${a.text}`); return json(a); };
  // Add (every column), Columns… (the ticked ones), Name its key… (a table with no primary key)
  assert.equal((await page("/api/pick", { table: "public.customers", picked: true })).already, false);
  assert.deepEqual((await page("/api/pick", { table: "public.orders", picked: true, columns: ["id"] })).columns, ["id"]);
  assert.deepEqual((await page("/api/pick", { table: "public.events", picked: true, key: ["tenant_id", "id"] })).key, ["tenant_id", "id"]);
  const added = fs.readFileSync(op.sourceFile, "utf8");
  for (const t of ["customers:", "orders:", "events:", "key: [tenant_id, id]"]) assert.ok(added.includes(t), `${t} in ${added}`);
  // Sync now
  assert.deepEqual((await page("/api/sync", { tables: ["public.customers"] })).tables, []);
  assert.deepEqual(op.polled, ["public.customers"]);
  // Remove, and a pick undone
  assert.deepEqual((await page("/api/remove", { tables: ["customers", "orders"] })).removed, ["public.customers", "public.orders"]);
  assert.deepEqual((await page("/api/pick", { table: "public.events", picked: false })).removed, ["public.events"]);
  assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before, "every edit undone, byte for byte");
  // everything else the page sends is refused, saying what is still allowed
  for (const [method, p, body] of [["POST", "/api/users", { name: "grafana" }], ["DELETE", "/api/users/grafana", {}], ["POST", "/api/users/grafana/disable", {}],
    ["POST", "/api/cancel", { session: 4, statement: 9 }], ["POST", "/api/share", {}]] as const) {
    const f = refusal(await ask(op, method, p, { body, as: "page" }), 403, "refused");
    assert.equal(f.message, "the web page is read-only here (MASON_UI_READ_ONLY=1): it shows what Mason syncs, and changes nothing but its tables", `${method} ${p}`);
    assert.equal(f.why, "Mason was started with MASON_UI_READ_ONLY=1 and MASON_UI_READ_ONLY_ALLOW=tables, so the page refuses every change but adding, removing and syncing tables");
  }
  assert.ok(!fs.existsSync(path.join(op.root, "users.json")), "no user written");
  const state = json(await ask(op, "GET", "/api/state", { as: "page" }));
  assert.deepEqual([state.pageReadOnly, state.pageReadOnlyAllow, state.sourcesReadOnly], ["the web page is read-only here (MASON_UI_READ_ONLY=1)", ["tables"], null]);
});

test("MASON_PROJECT_READONLY=1 wins over MASON_UI_READ_ONLY_ALLOW=tables: the page's Add and Remove are refused 409 as the project's, Sync now still served (issue 789)", async () => {
  const op = await operator({ pageReadOnly: true, pageReadOnlyAllow: ["tables"] });
  const before = fs.readFileSync(op.sourceFile, "utf8");
  const was = process.env.MASON_PROJECT_READONLY;
  process.env.MASON_PROJECT_READONLY = "1";
  try {
    const state = json(await ask(op, "GET", "/api/state", { as: "page" }));
    assert.match(String(state.sourcesReadOnly), /^The project's files are read-only here \(MASON_PROJECT_READONLY=1\)\. /, "the page offers no Add or Remove");
    for (const [p, body] of [["/api/pick", { table: "public.customers", picked: true }], ["/api/pick", { table: "public.events", picked: true, key: ["tenant_id", "id"] }],
      ["/api/pick", { table: "public.customers", picked: false }], ["/api/remove", { tables: ["customers"] }]] as const) {
      const f = refusal(await ask(op, "POST", p, { body, as: "page" }), 409, "refused");
      assert.equal(f.message, "the project's files are read-only here (MASON_PROJECT_READONLY=1)", p);
    }
    assert.equal(fs.readFileSync(op.sourceFile, "utf8"), before, "nothing written");
    assert.equal((await ask(op, "POST", "/api/sync", { body: { tables: ["public.customers"] }, as: "page" })).status, 200, "a sync writes no project file");
  } finally { if (was === undefined) delete process.env.MASON_PROJECT_READONLY; else process.env.MASON_PROJECT_READONLY = was; }
});

test("the token reaches no answer and no log line", () => {
  // every answer the tests above read, the refusals included, and every line their runs logged
  assert.ok(seen.length > 30, `${seen.length} answers read`);
  for (const text of seen) assert.ok(!text.includes(TOKEN), text.slice(0, 200));
});

test("the doc names every key of the contract: the lean table, a column, the pick and remove answers", () => {
  const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "WEB-UI.md"), "utf8");
  const section = doc.split("\n## An operator's table edits\n")[1]?.split("\n## ")[0];
  assert.ok(section !== undefined, "docs/WEB-UI.md has the section");
  for (const k of [...LEAN_TABLE, ...ADDED_ENTRY, ...PICK_ANSWER, ...REMOVE_ANSWER, ...COLUMN, "kept", "sync", "syncRefusal", "sourcesReadOnly", "pageReadOnly", "phase", "rowsCopied", "updatedAt", "progress", "retired", "copying", "done", "failed"]) assert.ok(section.includes(`\`${k}\``), k);
  for (const route of ["GET /api/state", "GET /api/tables/<table>/columns", "POST /api/pick", "POST /api/remove", "MASON_UI_SOCKET", "MASON_UI_RUN_FILE", "MASON_UI_READ_ONLY"]) {
    assert.ok(section.includes(route), route);
  }
});
