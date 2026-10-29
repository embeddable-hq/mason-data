/**
 * The run's command server (src/cli/run-server.ts) over real HTTP: the run's guard refuses a request without the
 * token, one naming another Host and a write from another Origin; an add (mason add) writes its entry into the
 * project's sources file and nowhere else, a remove takes it out, the rest of the file as it was; every refusal is a
 * sentence to show — no folder yet, a table that is not there, one with no primary key and no --key; the web page's
 * three files from an allowlist, and its users through the functions mason user calls (mason serve's run serves no
 * page). The copies are the sync's, faked: what the state says of each is this test's subject too.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import type { CopyState, PolledTable } from "../src/duck/sync.ts";
import type { LedgerRequest, QuerySummary, RequestQuery } from "../src/duck/requests.ts";
import type { CancelAnswer, RunningStatement } from "../src/api/postgres/server.ts";
import * as syncModule from "../src/duck/sync.ts";
// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
const { PollRefused } = syncModule as unknown as { PollRefused: typeof import("../src/duck/sync.ts").PollRefused };
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { readUsers, userPassword, USER_NAME_RULE } from "../src/duck/users.ts";
// imported when the tests run: at a commit without the module the file still loads, and a test that needs it fails by name
const sourcesModule = await import("../src/cli/sources.ts" as string).catch(() => ({})) as Record<string, unknown>;
// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
// at a commit without it, the bare file it writes, so the file loads and its tests fail by name
const readSource = (folder: string, root: string, env: NodeJS.ProcessEnv): ReturnType<RunContext["readSource"]> =>
  (sourcesModule.readSource as ((f: string, r: string, e: NodeJS.ProcessEnv) => ReturnType<RunContext["readSource"]>) | undefined)?.(folder, root, env)
    ?? { message: "no sources module at this commit", code: "bad_source" };
const newSourceText = (url?: string): string =>
  (sourcesModule.newSourceText as ((u?: string) => string) | undefined)?.(url) ?? `kind: postgres\nurl: ${url ?? "$" + "{DATABASE_URL}"}\ntables: {}\n`;

// the module is imported when the tests run, so the file loads at a commit without it and the test fails by name
const { LogBuffer } = await import("../src/lib/log-buffer.ts" as string).catch(() => ({ LogBuffer: class { capacity = 0; push(): void { return; } recent(): never[] { return []; } } })) as typeof import("../src/lib/log-buffer.ts");
const runLog = new LogBuffer(3);

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (o: Partial<SourceTable> & { table: string }): SourceTable => ({
  source: `public.${o.table}`, schema: "public", key: ["id"], rows: 3, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [], ...o,
});
const tables = [table({ table: "customers" }), table({ table: "logs", key: [] }), table({ table: "Shouty" }),
  table({ table: "events", key: [], columns: [{ ...col("tenant_id", "bigint"), notNull: true }, { ...col("id", "bigint"), notNull: true }, col("body")],
    uniqueKeys: [{ name: "events_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] }),
  table({ table: "orders", columns: [col("id", "bigint"), col("customer_id", "bigint")], foreignKeys: [{ column: "customer_id", target: "public.customers", targetColumn: "id" }] })];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-server-"));
const folder = path.join(root, "app", "mason");
const sourceFile = path.join(folder, "sources", "app.yml");
fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
fs.writeFileSync(sourceFile, newSourceText("postgres://me@localhost:5432/app"));
const parsed = parseSource("postgres://me@localhost:5432/app");
assert.ok("source" in parsed);
let chosen: string | null = null;
const logged: string[] = [];
let changed = 0;
const duckFile = path.join(root, "duck.db");
fs.writeFileSync(duckFile, "x".repeat(10));
// the copies as the sync has them (src/duck/sync.ts CopyState): a test sets what the state reads
let copies: CopyState[] = [];
// the sync's own poll (src/duck/sync.ts pollNow): what it found, or its refusal by name
const asked: string[][] = [];
const pollNow = (sources: string[]): Promise<{ at: string; tables: PolledTable[] }> => {
  asked.push(sources);
  if (sources.includes("public.logs")) return Promise.reject(new PollRefused("nothing_yet", "public.logs is not copied yet (its copy has not finished): mason wait waits for it"));
  return Promise.resolve({ at: "2026-10-24T10:05:00.000Z", tables: sources.map((table) => ({ table, changed: 2, deleted: 1, rows: 3, ms: 40 })) });
};
// the request log's reads (src/duck/requests.ts), as the ledger answers them: the server passes them on, never a copy
const asks: RequestQuery[] = [];
const request: LedgerRequest = { requestId: "r1", startedAt: "2026-10-24T10:04:00.000Z", session: 3, applicationName: "Metabase", tokenName: "", user: "", method: "QUERY",
  outcome: "refused", status: "failed", sqlstate: "42P01", message: 'relation "nope" does not exist', detail: null, hint: null, rows: null, durationMs: 2,
  endedAt: "2026-10-24T10:04:00.002Z", bytesSent: 120, query: "SELECT * FROM nope", queryTruncated: false };
const window = (days: number) => ({ days, covered: days, statements: 3, completed: 1, refused: 1, failed: 0, cancelled: 1, rows: 20, bytesSent: 900, durationMs: { avg: 5, p50: 5, p95: 5 } });
const summary: QuerySummary = { keptDays: 7, day: window(1), week: window(7) };
// the listener's statements running now, and its cancel (src/api/postgres/server.ts): a session running one, another idle
const runningNow: RunningStatement = { session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY", startedAt: "2026-10-24T10:04:30.000Z", runningMs: 1500,
  rows: 0, query: "SELECT count(*) FROM orders", queryTruncated: false };
const cancels: Array<number | [number, number]> = [];
// the sessions logged in, as the listener counts them (src/api/postgres/server.ts openSessions)
const sessionsNow = { open: 3, byClient: [{ user: "metabase", client: "Metabase", open: 2, running: 1 }, { user: "", client: "", open: 1, running: 0 }] };
const listener = { openSessions: () => sessionsNow, running: () => [runningNow], cancel: (session: number, statement?: number): CancelAnswer => {
  cancels.push(statement === undefined ? session : [session, statement]);
  if (session === 4 && statement !== undefined && statement !== runningNow.statement) return { other: runningNow, asked: statement };
  return session === 4 ? { cancelled: runningNow } : session === 5 ? { idle: 5 } : { unknown: session };
} };
const lastUsedAsks: Array<{ name: string; since: string; until: string | null }> = [];
// the refused statements grouped by the entry that refused them (src/duck/requests.ts unsupported)
const unsupportedAsks: Array<{ since: string; limit: number }> = [];
const unsupportedSql = { gap: "quote-ident", title: "quote_ident()", runs: 2, users: ["alice"], clients: ["Metabase"], last: "2026-10-24T10:04:00.000Z", example: "SELECT quote_ident(name) FROM orders" };
let summaryReads = 0;
// one time range's statements, who sent them and the slowest (src/duck/requests.ts window, clients, slowest)
const activityAsks: Array<[string, string]> = [];
const durationAsks: Array<[string, string, number]> = [];
const client = { user: "metabase", tokenName: "", client: "Metabase", statements: 3, failed: 1, sessions: 2, last: "2026-10-24T10:04:00.000Z" };
const requests = {
  days: 7,
  lastUsed: async (u: Array<{ name: string; since: string; until: string | null }>) => { lastUsedAsks.push(...u); return u.map((x) => x.name === "metabase" ? "2026-10-24T10:04:00.000Z" : null); },
  page: async (q: RequestQuery) => { asks.push(q); return { requests: [request], before: q.limit === 1 ? "2026-10-24T10:04:00.000Z~3" : null }; },
  summary: async () => { summaryReads++; return summary; },
  window: async (since: string) => { activityAsks.push(["window", since]); return window(1); },
  clients: async (since: string) => { activityAsks.push(["clients", since]); return { clients: [client], total: { clients: 120, sessions: 300 } }; },
  slowest: async (since: string) => { activityAsks.push(["slowest", since]); return [request]; },
  // the request log's p50 / p95 by bucket (src/duck/requests.ts durationsBy): one bucket has statements, one has none
  durationsBy: async (since: string, until: string, step: number) => { durationAsks.push([since, until, step]); return new Map([[Date.parse("2026-10-28T09:00:00.000Z"), { p50: 12, p95: 340 }]]); },
  slow: async () => [{ route: "postgres" as const, payload: "SELECT count(*) FROM orders", runs: 2, medianMs: 1500, maxMs: 2000, latestMs: 2000, last: "2026-10-24T10:03:00.000Z" }],
  refused: async () => ({ total: 3, refused: [{ route: "postgres" as const, payload: "SELECT * FROM nope", runs: 3, last: "2026-10-24T10:04:00.000Z", code: "42P01", message: 'relation "nope" does not exist' }] }),
  unsupported: async (q: { since: string; limit: number }) => { unsupportedAsks.push(q); return [unsupportedSql]; },
};
// the sync's events (src/duck/events.ts), as SyncEvents answers them, and the run's restarts (src/cli/supervise.ts)
const eventAsks: Array<{ limit: number; since?: string; failed?: boolean }> = [];
const syncEvent = { at: new Date(Date.now() - 120_000).toISOString(), kind: "poll_failed" as const, failed: true, table: "public.customers", message: "the poll failed, and is tried again at the next one" };
const events = { days: 7, recent: async (o: { limit: number; since?: string; failed?: boolean }) => { eventAsks.push(o); return [syncEvent]; } };
let restarts: Array<{ at: string; reason: string; upSeconds: number }> = [];
// the disk under the copy, as the sync measures it (src/duck/sync.ts diskStatus)
let disk: { path: string; freeBytes: number | null; projectedBytes: number | null; error?: string } = { path: "/data", freeBytes: 75 * 2 ** 30, projectedBytes: null };
// usage over time (src/duck/usage.ts), as UsageSampler answers it
const usageAsks: Array<{ since: string; until: string; stepSeconds?: number }> = [];
const copySize = { table: "public.orders", bytes: 4_194_304, at: "2026-10-28T09:10:00.000Z" };
let usageSamples: Array<Record<string, unknown>> = [];
const usage = { days: 7, sampleSeconds: 60, samples: async (o: { since: string; until: string; stepSeconds?: number }) => { usageAsks.push(o); return usageSamples as never[]; }, copySizes: async () => [copySize] };
const usersFile = path.join(root, "app", ".mason", "users.json");
const API_KEY = "k".repeat(48);
const ctx: RunContext = {
  page: true, users: { file: usersFile, apiKey: API_KEY, database: "app", postgresUrl: "postgresql://127.0.0.1:5433/app" },
  source: parsed.source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables, systemIdentifier: null }), warnings: [],
  slot: "", changes: "poll", port: 0, token: "t0ken-of-this-run",
  folder: () => chosen, root: path.join(root, "app"), home: path.join(root, "app", ".mason"), version: "9.9.9", startedAt: Date.parse("2026-10-28T08:00:00.000Z"), sources: () => ({ file: null, problem: null }), sourcesChanged: () => { changed++; }, log: (m) => logged.push(m),
  // the file as the run reads it: its URL resolved from no environment (the test's file writes it whole)
  readSource: () => chosen === null ? { message: "no folder chosen", code: "bad_source" } : readSource(chosen, path.join(root, "app"), {}),
  runUrl: "postgres://me@localhost:5432/app", listener,
  logs: runLog,
  duck: { copies: () => copies, file: duckFile, pollSeconds: 5, poll: pollNow, stream: async () => null, disk: () => disk, requests, events, usage, restarts: () => restarts },
};
const server = createRunServer(ctx);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
ctx.port = (server.address() as { port: number }).port;
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

// the run's cookie is named for its port (src/cli/security.ts cookieName), known once the server listens
const cookieNow = () => `mason_dev_${ctx.port}=t0ken-of-this-run`;
function call(method: string, p: string, o: { host?: string; origin?: string | null; cookie?: string | null; body?: unknown; bearer?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${ctx.port}` };
    const cookie = o.cookie === undefined ? cookieNow() : o.cookie;
    if (cookie) headers.Cookie = cookie;
    if (o.bearer !== undefined) headers.Authorization = `Bearer ${o.bearer}`;
    const origin = o.origin === undefined ? `http://127.0.0.1:${ctx.port}` : o.origin;
    if (origin && method !== "GET") headers.Origin = origin;
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (body) headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port: ctx.port, method, path: p, headers }, (res) => {
      let text = "";
      res.on("data", (b: Buffer) => { text += b.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const pickIt = (table: string, picked = true) => call("POST", "/api/pick", { body: { table, picked } });
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();

test("the guard: no token, another Host, a write from another Origin are refused; the URL's token becomes the cookie", async () => {
  assert.equal((await call("GET", "/api/state", { cookie: null })).status, 403);
  assert.equal((await call("GET", "/api/state", { cookie: `mason_dev_${ctx.port}=another` })).status, 403);
  assert.equal((await call("GET", "/api/state", { host: `evil.example:${ctx.port}` })).status, 421, "DNS rebinding: the Host is not this server");
  const handed = await call("GET", "/?token=t0ken-of-this-run", { cookie: null });
  assert.equal(handed.status, 303);
  assert.match(String(handed.headers["set-cookie"]), new RegExp(`mason_dev_${ctx.port}=t0ken-of-this-run;.*HttpOnly.*SameSite=Strict`, "i"));
  assert.equal((await call("GET", "/?token=wrong", { cookie: null })).status, 403);
  assert.equal((await call("GET", "/api/state")).status, 200);
  assert.equal((await call("POST", "/api/pick", { origin: null, body: { source: "public.customers", picked: true } })).status, 403, "a POST with no Origin");
  assert.equal((await call("POST", "/api/pick", { origin: "http://evil.example", body: { source: "public.customers", picked: true } })).status, 403, "a POST from another site");
  assert.equal(fs.readFileSync(sourceFile, "utf8"), newSourceText("postgres://me@localhost:5432/app"), "nothing a refused request asked for happened");
});

test("an add writes its entry into the sources file and nowhere else; each refusal is a sentence to show", async () => {
  const before = await pickIt("public.customers");
  assert.equal(before.status, 409);
  assert.match(before.text, /choose the project's folder first/);
  chosen = folder;
  const was = fs.readFileSync(sourceFile, "utf8");
  const ok = await pickIt("public.customers");
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(filesUnder(root).filter((f) => f !== "duck.db"), ["app/mason/sources/app.yml"], "the one file, the sources file");
  assert.equal(fs.readFileSync(sourceFile, "utf8"), was.replace("tables: {}\n", "tables:\n  customers: {}\n"), "every other byte as it was");

  const missing = await pickIt("public.nope");
  assert.equal(missing.status, 404);
  const noKey = await pickIt("public.logs");
  assert.equal(noKey.status, 409);
  assert.equal(JSON.parse(noKey.text).error, "public.logs cannot be added: no primary key: name the columns that tell its rows apart, mason add logs --key <column>,…");
  // a table with no primary key but a unique index: the way out names its columns
  const unique = await pickIt("public.events");
  assert.match(JSON.parse(unique.text).error, /mason add events --key tenant_id,id \(its unique index events_tenant_id_id_key\)$/);
  const keyed = await call("POST", "/api/pick", { body: { table: "public.events", picked: true, key: ["tenant_id", "id"] } });
  assert.equal(keyed.status, 200, keyed.text);
  assert.match(fs.readFileSync(sourceFile, "utf8"), /\n {2}customers: \{\}\n {2}events:\n {4}key: \[tenant_id, id\]\n$/);
  // a --key no unique index is over: refused at the add, never at the copy (where it was "Mason bug", retried for ever)
  const notUnique = await call("POST", "/api/pick", { body: { table: "public.events", picked: true, key: ["id"] } });
  assert.deepEqual([notUnique.status, JSON.parse(notUnique.text).error], [400, "tables.events.key: no unique index of public.events is over (id), so two of its rows may share them and Mason could not tell them apart — name the columns of one: key: [tenant_id, id] (its unique index events_tenant_id_id_key)"]);
  const keyOnPk = await call("POST", "/api/pick", { body: { table: "public.customers", picked: true, key: ["id"] } });
  assert.deepEqual([keyOnPk.status, JSON.parse(keyOnPk.text).error], [400, "public.customers has a primary key (id), which Mason copies it by: leave --key out"]);
  // a name an older Mason refused (not lower case) is a table like any other now
  assert.equal((await pickIt("public.Shouty")).status, 200);
  assert.match(fs.readFileSync(sourceFile, "utf8"), /\n {2}Shouty: \{\}\n$/);

  changed = 0;
  for (const s of ["public.customers", "public.events", "public.Shouty"]) assert.equal((await pickIt(s, false)).status, 200);
  assert.equal(fs.readFileSync(sourceFile, "utf8"), was, "unpicked: the file is as it was, tables: {} again");
  assert.equal(changed, 3, "the run is told each time the file changed");
});

test("the commands' way in: the run's token as a Bearer header, no cookie and no Origin; mason add's columns", async () => {
  const bearer = (method: string, p: string, body?: unknown, token = "t0ken-of-this-run") =>
    call(method, p, { cookie: null, origin: null, bearer: token, ...(body === undefined ? {} : { body }) });
  assert.equal((await bearer("GET", "/api/state", undefined, "another")).status, 403, "another token");
  assert.equal((await call("GET", "/api/state", { bearer: "another" })).status, 403, "a wrong header is refused even beside the right cookie");
  assert.equal((await bearer("GET", "/api/state")).status, 200);
  assert.equal((await bearer("POST", "/api/pick", { table: "public.nope", picked: true })).status, 404, "a POST with the token needs no Origin (a browser cannot send the header cross-site): it reaches the handler");

  const unknown = await bearer("POST", "/api/pick", { table: "public.customers", picked: true, columns: ["id", "nme"] });
  assert.equal(unknown.status, 400);
  assert.equal(JSON.parse(unknown.text).error, 'public.customers has no column "nme" — did you mean `name`?; its columns: id, name');
  assert.equal((await bearer("POST", "/api/pick", { table: "public.customers", picked: true, columns: "name" })).status, 400);
  const ok = await bearer("POST", "/api/pick", { table: "public.customers", picked: true, columns: ["name"] });
  assert.equal(ok.status, 200, ok.text);
  const b = JSON.parse(ok.text) as { addedKey: string[]; columns: string[]; already: boolean; file: string };
  assert.deepEqual([b.addedKey, b.columns, b.already, b.file], [["id"], ["id", "name"], false, sourceFile]);
  assert.match(fs.readFileSync(sourceFile, "utf8"), /\ntables:\n {2}customers:\n {4}columns: \[id, name\]\n$/);
  const state = JSON.parse((await bearer("GET", "/api/state?columns=1")).text) as { project: string | null; tables: Array<{ table: string; added: boolean; addedColumns: string[] | null; columns: unknown[] }> };
  const customers = state.tables.find((t) => t.table === "public.customers")!;
  assert.deepEqual(customers.columns, [
    { name: "id", type: "bigint", nullable: true, comment: null, references: null },
    { name: "name", type: "text", nullable: true, comment: null, references: null }]);
  assert.match(state.project ?? "", /^[0-9a-f]{64}$/, "the project's fingerprint");
  // the same columns again changes nothing; other columns change the entry in place, a comment beside it kept
  assert.equal(JSON.parse((await bearer("POST", "/api/pick", { table: "public.customers", picked: true, columns: ["name"] })).text).already, true);
  fs.writeFileSync(sourceFile, fs.readFileSync(sourceFile, "utf8").replace("tables:\n", "tables:   # the copied ones\n"));
  assert.equal((await bearer("POST", "/api/pick", { table: "public.customers", picked: true })).status, 200);
  assert.match(fs.readFileSync(sourceFile, "utf8"), /\ntables: {3}# the copied ones\n {2}customers: \{\}\n$/);
  // a file the next start would refuse is never written over: the mistake first
  const good = fs.readFileSync(sourceFile, "utf8");
  fs.writeFileSync(sourceFile, good.replace("customers: {}", "customers: { colums: [id] }"));
  const refused = await bearer("POST", "/api/pick", { table: "public.orders", picked: true });
  assert.equal(refused.status, 409);
  assert.match(JSON.parse(refused.text).error, /^mason\/sources\/app\.yml: tables\.customers: unexpected key colums — did you mean `columns`\? — a table takes columns, exclude and key — fix it first$/);
  fs.writeFileSync(sourceFile, good);
  assert.equal((await bearer("POST", "/api/pick", { table: "public.customers", picked: false })).status, 200);
});

test("mason remove: the table's entry goes, every other byte of the file as it was; a name the file lacks is refused with the closest", async () => {
  const remove = (names: string[]) => call("POST", "/api/remove", { cookie: null, origin: null, bearer: "t0ken-of-this-run", body: { tables: names } });
  const by = "# ours\nkind: postgres\nurl: postgres://me@localhost:5432/app\ntables:\n  customers: {}   # every column\n  # the orders, two columns\n  orders:\n    columns: [id, customer_id]\n# the end\n";
  const was = fs.readFileSync(sourceFile, "utf8");
  fs.writeFileSync(sourceFile, by);
  try {
    const typo = await remove(["customer"]);
    assert.equal(typo.status, 404);
    assert.equal(JSON.parse(typo.text).error, "app.yml names no table customer — did you mean `customers`? (it names customers, orders)");
    // a third part is a wrong name, not a missing table: 400, said why, with the entry it may have meant
    const three = await remove(["app.public.customers"]);
    assert.deepEqual([three.status, JSON.parse(three.text).error], [400, "app.public.customers has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two — did you mean `customers`?"]);
    changed = 0;
    const ok = await remove(["public.orders"]);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(ok.text).removed, ["public.orders"]);
    assert.equal(changed, 1, "the run is told: it drops the copy");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "# ours\nkind: postgres\nurl: postgres://me@localhost:5432/app\ntables:\n  customers: {}   # every column\n  # the orders, two columns\n# the end\n");
    assert.equal((await remove(["customers"])).status, 200);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "# ours\nkind: postgres\nurl: postgres://me@localhost:5432/app\ntables: {}\n  # the orders, two columns\n# the end\n", "the last one gone: tables: {}");

    // ANOTHER ENTRY THAT NO LONGER HOLDS (a column dropped on the database): the remove is refused, the file as it was —
    // else the run's re-read refuses the file, keeps the removed table and goes on copying it, while the command says
    // "Removed" (the review of the sources file)
    const stale = "kind: postgres\nurl: postgres://me@localhost:5432/app\ntables:\n  customers: {}\n  orders:\n    columns: [id, gone]\n";
    fs.writeFileSync(sourceFile, stale);
    changed = 0;
    const held = await remove(["customers"]);
    assert.equal(held.status, 409);
    assert.equal(JSON.parse(held.text).error, "mason/sources/app.yml: tables.orders.columns: public.orders has no column gone (its columns: id, customer_id) — fix it first, then remove customers");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), stale, "nothing written");
    assert.equal(changed, 0, "the run is not told of a change that was not made");
    // A url: THAT NOW NAMES ANOTHER DATABASE (a .env edited): this run's catalog is the old one's — refused, the way out said
    fs.writeFileSync(sourceFile, "kind: postgres\nurl: postgres://me@elsewhere:5432/other\ntables:\n  customers: {}\n");
    for (const r of [await remove(["customers"]), await pickIt("public.orders")]) {
      assert.equal(r.status, 409);
      assert.equal(JSON.parse(r.text).error, "mason/sources/app.yml: url: now names postgres://me@elsewhere:5432/other (mason/sources/app.yml), and this run copies postgres://me@localhost:5432/app: mason stop && mason start copies from the new one, then add or remove the table");
    }
  } finally { fs.writeFileSync(sourceFile, was); }
});

test("the web page: /, /app.js, /app.css, /shared.js and each page's module from src/web/, with their types and the security headers; any other path is the 404 it was", async () => {
  const web = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "web");
  const pages = ["status", "tables", "queries", "users", "usage", "syncs"].map((p) => [`/pages/${p}.js`, `pages/${p}.js`, "text/javascript; charset=utf-8"] as const);
  for (const [p, file, type] of [["/", "index.html", "text/html; charset=utf-8"], ["/app.js", "app.js", "text/javascript; charset=utf-8"], ["/app.css", "app.css", "text/css; charset=utf-8"],
    ["/shared.js", "shared.js", "text/javascript; charset=utf-8"], ...pages] as const) {
    const r = await call("GET", p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers["content-type"], type, p);
    assert.equal(r.text, fs.readFileSync(path.join(web, file), "utf8"), `${p} is src/web/${file}, byte for byte`);
    assert.match(String(r.headers["content-security-policy"]), /^default-src 'self';/, p);
    assert.equal(r.headers["x-frame-options"], "DENY", p);
    assert.equal(r.headers["cache-control"], "no-store", p);
    assert.equal((await call("GET", p, { cookie: null })).status, 403, `${p} without the cookie`);
  }
  // the allowlist, never a path built from the URL: a file beside them, one above, an encoded one are the 404 they were
  for (const p of ["/index.html", "/app.d.ts", "/web/app.js", "/../cli/run-server.ts", "/%2e%2e/cli/run-server.ts", "/app.js/", "/api/folders", "/api/preview",
    // a page's folder is no route, nor a file beside its modules, nor one named with its slash encoded
    "/pages", "/pages/", "/pages/nope.js", "/pages/status.ts", "/pages%2fstatus.js", "/pages/../cli/run-server.ts", "/shared.js/"]) {
    const r = await call("GET", p);
    assert.equal(r.status, 404, p);
    assert.match(JSON.parse(r.text).error, /^no GET \/.*: this is mason start's server for the mason command \(mason --help\)$/, p);
    assert.equal(JSON.parse(r.text).failure.code, "not_found", p);
  }
  assert.equal((await call("POST", "/app.js", { body: {} })).status, 404, "a file is only read");
  // A VENDORED FILE AT A PINNED VERSION is kept by the browser (its bytes are that release's for good); everything
  // else, the vendor folder's README included, is read again at every load
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts");
  const pinned = Object.keys(PAGE_ROUTES).filter((p) => p.startsWith("/vendor/") && p !== "/vendor/README.md");
  assert.ok(pinned.includes("/vendor/uplot-1.6.32/uPlot.esm.js") && pinned.includes("/vendor/geist-1.7.2/Geist-Variable.woff2"), pinned.join(", "));
  for (const p of pinned) {
    const r = await call("GET", p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers["cache-control"], "private, max-age=31536000, immutable", p);
    assert.match(String(r.headers["content-security-policy"]), /^default-src 'self';/, `${p}: the security headers still`);
  }
  assert.equal((await call("GET", "/vendor/README.md")).headers["cache-control"], "no-store", "the vendor folder's README is no pinned release");
});

test("mason serve's run serves no page: / is the 404 it was, and the users are still the commands'", async () => {
  const serveCtx: RunContext = { ...ctx, page: false };
  const served = createRunServer(serveCtx);
  await new Promise<void>((r) => served.listen(0, "127.0.0.1", () => r()));
  const port = serveCtx.port = (served.address() as { port: number }).port;
  try {
    const at = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: "Bearer t0ken-of-this-run" } });
    for (const p of ["/", "/app.js", "/app.css"]) assert.equal((await at(p)).status, 404, p);
    assert.equal((await at("/api/users")).status, 200, "the commands' users");
  } finally { served.close(); }
});

test("the state: a copy under way says its rows so far, one not reached is waiting, a copied one is done; the sync and the request log answer through it", async () => {
  copies = [
    { source: "public.customers", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null,
      unsynced: { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-24T10:01:00.000Z" } },
    // its chunks being read (src/duck/sync.ts copyProgressNow): passed through for mason wait and status to render
    { source: "public.orders", phase: "copying", rows: 3, bytes: 8192, seconds: null, copiedAt: null, error: null, rowsSoFar: 2, rowsEstimate: 9,
      progress: { chunksDone: 2, chunksTotal: 5, reading: 3, readingSeconds: 7.5, rowsReading: 3, rowsPerSecond: 0.4, bytesPerSecond: 900, secondsLeft: 12, share: 0.4 } },
    { source: "public.logs", phase: "waiting", rows: 3, bytes: 8192, seconds: null, copiedAt: null, error: null },
    { source: "public.Shouty", phase: "failed", rows: 3, bytes: 8192, seconds: null, copiedAt: null, error: "it broke" },
  ];
  try {
    const get = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const r = await fetch(`http://127.0.0.1:${ctx.port}${p}`, { headers: { Authorization: "Bearer t0ken-of-this-run" } });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    const s = await get("/api/state");
    assert.equal(s.status, 200);
    const by = new Map((s.body.tables as Array<{ table: string; copy: unknown; error: string | null }>).map((t) => [t.table, t]));
    assert.deepEqual(by.get("public.customers")!.copy, { phase: "done", rowsCopied: 3, updatedAt: "2026-10-24T10:00:00.000Z" });
    assert.deepEqual(by.get("public.orders")!.copy, { phase: "copying", rowsCopied: 2, updatedAt: "",
      progress: { chunksDone: 2, chunksTotal: 5, reading: 3, readingSeconds: 7.5, rowsReading: 3, rowsPerSecond: 0.4, bytesPerSecond: 900, secondsLeft: 12, share: 0.4 } },
      "rows so far, never 0 while it copies, and the chunks reading, for how long, the measured rate: so a copy moves between two commits");
    assert.equal(by.get("public.logs")!.copy, null, "a table the sync has not reached is waiting, never copying 0 of N");
    assert.deepEqual(by.get("public.Shouty")!.copy, { phase: "failed", rowsCopied: 0, updatedAt: "" });
    assert.equal(by.get("public.Shouty")!.error, "it broke");
    // over the poll's row limit: served, and its state says why it is not kept current
    assert.deepEqual((by.get("public.customers") as unknown as { unsynced?: unknown }).unsynced, { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-24T10:01:00.000Z" });
    assert.equal("unsynced" in by.get("public.orders")!, false, "a table the poll keeps current carries no unsynced");
    const post = async (p: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const r = await fetch(`http://127.0.0.1:${ctx.port}${p}`, { method: "POST", headers: { Authorization: "Bearer t0ken-of-this-run", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    const polled = await post("/api/sync", { tables: ["public.customers"] });
    assert.deepEqual([polled.status, polled.body], [200, { at: "2026-10-24T10:05:00.000Z", tables: [{ table: "public.customers", changed: 2, deleted: 1, rows: 3, ms: 40 }] }]);
    const refused = await post("/api/sync", { tables: ["public.logs"] });
    assert.deepEqual([refused.status, refused.body.code], [409, "nothing_yet"], "a refusal keeps the sync's code for the CLI");
    assert.match(String(refused.body.error), /public\.logs is not copied yet/);
    assert.equal((await post("/api/sync", { tables: [] })).status, 400);
    assert.deepEqual(asked, [["public.customers"], ["public.logs"]]);
    assert.deepEqual(s.body.sessions, sessionsNow, "the listener's own count, by user and client");
    assert.deepEqual(s.body.disk, { path: "/data", freeBytes: 75 * 2 ** 30, copyBytes: 10, projectedBytes: null }, "the disk under the copy: its file is engine.bytes, one fact");
    const { uptimeSeconds, ...engine } = s.body.engine as { uptimeSeconds: number };
    assert.deepEqual(engine, { file: duckFile, bytes: 10, pollSeconds: 5, keptDays: 7, version: "9.9.9", startedAt: "2026-10-28T08:00:00.000Z", restarts: { count: 0, last: null } });
    assert.ok(Math.abs(uptimeSeconds - (Date.now() - Date.parse("2026-10-28T08:00:00.000Z")) / 1000) < 5, `up since the run started: ${uptimeSeconds}`);
    // the slow and refused statements are the request log's, in the shapes mason status renders
    assert.deepEqual((await get("/api/slow")).body, { slow: await requests.slow(), slowMs: 1000 });
    assert.deepEqual((await get("/api/refused")).body, await requests.refused());
    // the same refusals grouped by the unsupported SQL they used: a day by default, since by the one time grammar, limit bounded
    const before = Date.now();
    const grouped = await get("/api/unsupported");
    assert.deepEqual([grouped.status, grouped.body.unsupported, grouped.body.keptDays], [200, [unsupportedSql], 7]);
    const dayAgo = Date.parse(String(grouped.body.since));
    assert.ok(dayAgo >= before - 86_400_000 - 1000 && dayAgo <= Date.now() - 86_400_000 + 1000, `since defaults to a day ago: ${String(grouped.body.since)}`);
    assert.deepEqual(unsupportedAsks.at(-1), { since: grouped.body.since, limit: 10 }, "10 entries unless limit says");
    assert.equal((await get("/api/unsupported?since=2026-10-24T00:00:00Z&limit=3")).status, 200);
    assert.deepEqual(unsupportedAsks.at(-1), { since: "2026-10-24T00:00:00.000Z", limit: 3 });
    const badLimit = await get("/api/unsupported?limit=0");
    assert.deepEqual([badLimit.status, badLimit.body.error], [400, 'limit is a whole number of entries of docs/SQL-SUPPORT.md, 1 to 100, not "0"']);
    const badSince = await get("/api/unsupported?since=yesterday");
    assert.equal(badSince.status, 400);
    assert.match(String(badSince.body.error), /since "yesterday" is not a time/, "the time grammar's own words");
    // one time range of the request log, for Usage: an hour by default, since by the one time grammar, each read given it
    const act = await get("/api/activity?since=15m");
    assert.equal(act.status, 200);
    assert.deepEqual([act.body.window, act.body.clients, act.body.clientsTotal, act.body.slowest, act.body.keptDays], [window(1), [client], { clients: 120, sessions: 300 }, [request], 7],
      "the clients listed, and the totals over every one");
    const fifteen = Date.parse(String(act.body.since));
    assert.ok(Math.abs(fifteen - (Date.now() - 15 * 60_000)) < 5000, `15m is a quarter of an hour ago: ${String(act.body.since)}`);
    assert.deepEqual(activityAsks.splice(0).map(([k, at]) => [k, at === act.body.since]), [["window", true], ["clients", true], ["slowest", true]]);
    const hour = await get("/api/activity");
    assert.ok(Math.abs(Date.parse(String(hour.body.since)) - (Date.now() - 3_600_000)) < 5000, "an hour unless since says");
    const badActivity = await get("/api/activity?since=yesterday");
    assert.equal(badActivity.status, 400);
    assert.match(String(badActivity.body.error), /since "yesterday" is not a time/);
    assert.deepEqual((await get("/api/requests?limit=5&failed=1")).body, { requests: [request], keptDays: 7, before: null });
    assert.deepEqual((await get("/api/requests")).body.requests, [request]);
    assert.deepEqual(asks, [{ limit: 5, failed: true }, { limit: 40 }], "-n and --failed reach the ledger; 40 by default");
    const bad = await get("/api/requests?limit=0");
    assert.deepEqual([bad.status, bad.body.error], [400, "limit is a whole number of requests, 1 to 10000"]);
    // what proves a run is up (src/cli/runs.ts answers): the pid, and nothing of a service
    assert.deepEqual((await get("/api/ping")).body, { pid: process.pid });
    for (const p of ["/api/builds", "/api/built-from", "/api/memory"]) assert.equal((await get(p)).status, 404, `${p} was the ClickHouse run's`);
  } finally { copies = []; }
});

test("each table's sync: its state in one word, when it was last brought current, by what and how long it took, its age now; and the copies in all", async () => {
  const runServer = await import("../src/cli/run-server.ts");
  const at = "2026-10-24T10:00:00.000Z", now = Date.parse(at) + 90_500;
  const base = { rows: 3, bytes: 8192, seconds: 1, copiedAt: at, error: null };
  // read as the state's own fields: at a commit without them the test fails by name
  const states = [
    { source: "public.customers", phase: "copied", ...base, rows: 1_000, synced: { at, seconds: 0.04, by: "poll" } },
    { source: "public.orders", phase: "copied", ...base, rows: 20, synced: { at: "2026-10-24T09:00:00.000Z", seconds: 12.5, by: "copy" }, behind: "after its copy", rebuilding: "catch-up" },
    { source: "public.logs", phase: "copied", ...base, error: "the poll failed, and is tried again at the next one", synced: { at: "2026-10-24T09:30:00.000Z", seconds: null, by: "poll" } },
    { source: "public.Shouty", phase: "waiting", ...base, rows: null, seconds: null, copiedAt: null },
  ] as unknown as CopyState[];
  const s = runServer.runState(ctx, states, null, now) as { tables: Array<{ table: string; sync?: unknown }>; totals?: unknown };
  const sync = new Map(s.tables.map((t) => [t.table, t.sync]));
  assert.deepEqual(sync.get("public.customers"), { state: "synced", syncedAt: at, syncSeconds: 0.04, syncedBy: "poll", ageSeconds: 90.5 }, "its poll's own time, and its age at the moment asked");
  assert.deepEqual(sync.get("public.orders"), { state: "syncing", syncedAt: "2026-10-24T09:00:00.000Z", syncSeconds: 12.5, syncedBy: "copy", ageSeconds: 3690.5 }, "copied, caught up by one poll now: syncing");
  assert.deepEqual(sync.get("public.logs"), { state: "failed", syncedAt: "2026-10-24T09:30:00.000Z", syncSeconds: null, syncedBy: "poll", ageSeconds: 1890.5 }, "copied, its poll failed: failed, the copy as old as its last poll");
  assert.deepEqual(sync.get("public.Shouty"), { state: "waiting", syncedAt: null, syncSeconds: null, syncedBy: null, ageSeconds: null }, "not reached yet");
  assert.equal(sync.get("public.events"), undefined, "a table neither added nor copied has no sync");
  // copied: the three copies served; failed: their syncs that failed; rows: the copies' rows; the latest sync of any
  assert.deepEqual(s.totals, { added: 0, copied: 3, failed: 1, rows: 1_023, syncedAt: at });
  const { syncStateOf } = await import("../src/cli/readiness.ts") as unknown as { syncStateOf: (c: unknown) => string };
  assert.deepEqual([{ phase: "copying", error: null }, { phase: "failed", error: "x" }, { phase: "copied", error: null, rebuilding: "copy" }, { phase: "copied", error: null }].map(syncStateOf),
    ["syncing", "failed", "syncing", "synced"], "copying, a failed copy, a copy made again (the old one serves), served and kept current");
});

test("usage over time: /api/usage passes since, until and step to the samples, an hour by default, with the copies' sizes; a bad time or step refused by name", async () => {
  const get = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}${p}`, { headers: { Authorization: "Bearer t0ken-of-this-run" } });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  usageAsks.length = 0;
  const one = await get("/api/usage?since=2026-10-28T09:00:00Z&until=2026-10-28T10:00:00Z&step=300");
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, { since: "2026-10-28T09:00:00.000Z", until: "2026-10-28T10:00:00.000Z", stepSeconds: 300, sampleSeconds: 60, keptDays: 7, samples: [], copySizes: [copySize] });
  assert.deepEqual(usageAsks, [{ since: "2026-10-28T09:00:00.000Z", until: "2026-10-28T10:00:00.000Z", stepSeconds: 300 }]);
  const t0 = Date.now();
  const plain = await get("/api/usage");
  assert.equal(plain.body.stepSeconds, null, "every sample, without a step");
  assert.deepEqual(usageAsks[1], { since: plain.body.since, until: plain.body.until });
  const span = Date.parse(String(plain.body.until)) - Date.parse(String(plain.body.since));
  assert.ok(span === 3_600_000 && Date.parse(String(plain.body.until)) >= t0 - 1000, `the last hour by default: ${plain.body.since} … ${plain.body.until}`);
  const refusals = await Promise.all(["/api/usage?since=yesterday", "/api/usage?since=2026-10-28T09:00:00", "/api/usage?since=2026-10-28T10:00:00Z&until=2026-10-28T09:00:00Z", "/api/usage?step=30", "/api/usage?step=5m"].map(get));
  assert.deepEqual(refusals.map((r) => [r.status, r.body.error]), [
    [400, 'since "yesterday" is not a time'],
    [400, 'since "2026-10-28T09:00:00" is not a time'],
    [400, "since (2026-10-28T10:00:00.000Z) must be before until (2026-10-28T09:00:00.000Z)"],
    [400, 'step is a whole number of seconds, 60 (a sample\'s interval) to 604800 (the 7 days kept), not "30"'],
    [400, 'step is a whole number of seconds, 60 (a sample\'s interval) to 604800 (the 7 days kept), not "5m"'],
  ]);
  assert.ok(refusals.every((r) => (r.body.failure as { code?: string } | undefined)?.code === "usage"), "each in the Failure shape");
  // A POINT OF MORE THAN A MINUTE: its p50 and p95 are its statements', from the request log — never the highest of its
  // minutes' p95s (the samples' own, re-bucketed by max: one slow minute was the hour's "p95")
  usageSamples = [{ at: "2026-10-28T09:00:00.000Z", durationP50Ms: 900, durationP95Ms: 5000 }, { at: "2026-10-28T10:00:00.000Z", durationP50Ms: 8, durationP95Ms: 30 }];
  durationAsks.length = 0;
  try {
    const hourly = await get("/api/usage?since=2026-10-28T09:00:00Z&until=2026-10-28T11:00:00Z&step=3600");
    assert.deepEqual((hourly.body.samples as Array<Record<string, unknown>>).map((x) => [x.durationP50Ms, x.durationP95Ms]), [[12, 340], [null, null]],
      "the bucket's statements' p95; a bucket with none completed has none");
    assert.deepEqual(durationAsks, [["2026-10-28T09:00:00.000Z", "2026-10-28T11:00:00.000Z", 3600]]);
    const minutes = await get("/api/usage?since=2026-10-28T09:00:00Z&until=2026-10-28T11:00:00Z&step=60");
    assert.deepEqual((minutes.body.samples as Array<Record<string, unknown>>).map((x) => x.durationP95Ms), [5000, 30], "a minute a point is the samples' own");
    assert.equal(durationAsks.length, 1, "and reads no request log");
  } finally { usageSamples = []; }
});

test("a usage sample reads /api/state's own facts: the copy file's bytes, the totals, the stalest ADDED table's age, the stream's lag, the copies served", async () => {
  const runServer = await import("../src/cli/run-server.ts") as unknown as { usageFacts?: (c: RunContext, now?: number) => Promise<unknown>; runState: typeof import("../src/cli/run-server.ts").runState };
  assert.equal(typeof runServer.usageFacts, "function", "src/cli/run-server.ts usageFacts");
  const at = "2026-10-24T10:00:00.000Z", now = Date.parse(at) + 90_500;
  const base = { rows: 3, bytes: 8192, seconds: 1, copiedAt: at, error: null };
  const states = [
    { source: "public.customers", phase: "copied", ...base, rows: 1_000, synced: { at, seconds: 0.04, by: "poll" } },
    { source: "public.orders", phase: "copied", ...base, rows: 20, synced: { at: "2026-10-24T09:00:00.000Z", seconds: 12.5, by: "copy" } },
    // not added (its entry removed), its copy still in the sync's list: not the stalest
    { source: "public.logs", phase: "copied", ...base, synced: { at: "2026-10-23T09:30:00.000Z", seconds: null, by: "poll" } },
    { source: "public.Shouty", phase: "copying", ...base, rows: null, seconds: null, copiedAt: null },
  ] as unknown as CopyState[];
  const lag = { bytes: 4096, seconds: 2.5 };
  const slot = { walHeldBytes: 65_536, walStatus: "reserved" as const, safeWalSizeBytes: null, at };
  const stream = { slot: "s", slotWal: slot, publication: "p", running: true, failure: null, position: "0/1", applied: "0/1", database: { lsn: "0/2", at }, lag, lastBatch: null, tables: [] };
  const added = { file: { name: "app", file: sourceFile, tables: ["customers", "orders", "Shouty"].map((t) => ({ name: t, table: `public.${t}`, columns: null, exclude: [], key: null })) }, problem: null } as unknown as ReturnType<RunContext["sources"]>;
  const c: RunContext = { ...ctx, sources: () => added, duck: { ...ctx.duck, copies: () => states, stream: async () => stream } };
  const facts = await runServer.usageFacts!(c, now);
  const state = runServer.runState(c, states, stream, now) as { totals: unknown; engine: { bytes: number } };
  assert.deepEqual(facts, { copyBytes: state.engine.bytes, totals: { added: 3, copied: 3, failed: 0, rows: 1_023, syncedAt: at }, oldestSyncSeconds: 3690.5, streamLag: lag,
    copied: ["public.customers", "public.orders", "public.logs"], slotWalHeldBytes: 65_536, diskFreeBytes: 75 * 2 ** 30, sessionsOpen: 3 });
  assert.equal(state.engine.bytes, 10, "the copy file's size, as engine.bytes says it");
  const polled = await runServer.usageFacts!({ ...c, duck: { ...c.duck, stream: async () => null } }, now) as { streamLag: unknown; slotWalHeldBytes: unknown };
  assert.equal(polled.streamLag, null, "no stream when polling");
  assert.equal(polled.slotWalHeldBytes, null, "no slot when polling");
  const unread = await runServer.usageFacts!({ ...c, duck: { ...c.duck, stream: async () => ({ ...stream, slotWal: { error: "the database could not be reached: connect ECONNREFUSED" } }) } }, now) as { slotWalHeldBytes: unknown };
  assert.equal(unread.slotWalHeldBytes, null, "a slot that could not be read is unknown, never a 0");
});

test("the run itself in /api/state: its version, since when it is up, and its supervisor's restarts — how many and the last — or why they could not be read", async () => {
  const runServer = await import("../src/cli/run-server.ts");
  const now = Date.parse("2026-10-28T09:30:00.400Z");
  type Engine = { version: string; startedAt: string; uptimeSeconds: number; restarts: unknown };
  const engine = (c: RunContext): Engine => (runServer.runState(c, [], null, now) as { engine: Engine }).engine;
  const none = engine(ctx);
  assert.deepEqual([none.version, none.startedAt, none.uptimeSeconds, none.restarts], ["9.9.9", "2026-10-28T08:00:00.000Z", 5400, { count: 0, last: null }]);
  const two = [{ at: "2026-10-28T08:59:00.000Z", reason: "it was killed (SIGKILL: often the system out of memory)", upSeconds: 40 },
    { at: "2026-10-28T09:00:00.000Z", reason: "it ran out of JavaScript heap (V8: heap out of memory)", upSeconds: 120 }];
  assert.deepEqual(engine({ ...ctx, duck: { ...ctx.duck, restarts: () => two } }).restarts,
    { count: 2, last: { at: "2026-10-28T09:00:00.000Z", why: "it ran out of JavaScript heap (V8: heap out of memory)", upSeconds: 120 } });
  const unreadable = engine({ ...ctx, duck: { ...ctx.duck, restarts: () => { throw new Error("Unexpected end of JSON input"); } } }).restarts as { error: string };
  assert.equal(unreadable.error, `${path.join(root, "app", ".mason", "restarts.json")} could not be read: Unexpected end of JSON input`, "said, never taken as none");
  // mason status's line is the same fact, rendered (src/cli/commands.ts restartsRows)
  const { restartsRows } = await import("../src/cli/commands.ts") as unknown as { restartsRows: (r: unknown) => Array<[string, string]> };
  assert.match(restartsRows(engine({ ...ctx, duck: { ...ctx.duck, restarts: () => two } }).restarts)[0]![1], /^2, the last .* ago: it ran out of JavaScript heap \(V8: heap out of memory\), after 120 s up/);
  assert.deepEqual(restartsRows(none.restarts), [], "none: no line");
  assert.deepEqual(restartsRows(unreadable), [["Restarts", unreadable.error]]);
  const { masonRow } = await import("../src/cli/commands.ts") as unknown as { masonRow: (e: unknown, pid: number) => [string, string] };
  assert.deepEqual(masonRow(none, 4242), ["Mason", "9.9.9, pid 4242 · one process · up 1 h 30 min, since 2026-10-28 08:00:00 UTC"]);
});

test("the sync's events: /api/events passes its filters to the record, merges the run's restarts newest last, and refuses a bad limit or time by name", async () => {
  const get = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}${p}`, { headers: { Authorization: "Bearer t0ken-of-this-run" } });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  eventAsks.length = 0;
  const recent = new Date(Date.now() - 60_000).toISOString();
  restarts = [{ at: "2020-01-01T00:00:00.000Z", reason: "older than the retention", upSeconds: 1 }, { at: recent, reason: "it was killed (SIGKILL: often the system out of memory)", upSeconds: 3600 }];
  try {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const all = await get(`/api/events?limit=5&failed=1&since=${since}`);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body, { keptDays: 7, events: [syncEvent,
      { at: recent, kind: "restart", failed: true, table: null, message: "the run stopped (it was killed (SIGKILL: often the system out of memory)) after 3600 s up, and its supervisor started it again" }] },
      "newest last; a restart older than the retention is not one of them");
    assert.deepEqual(eventAsks, [{ limit: 5, failed: true, since }]);
    assert.deepEqual((await get("/api/events")).body.events, [syncEvent, (all.body.events as unknown[])[1]]);
    assert.deepEqual(eventAsks[1], { limit: 40, failed: false }, "40 by default, every kind");
    const one = await get("/api/events?limit=1");
    assert.equal((one.body.events as Array<{ kind: string }>).map((e) => e.kind).join(), "restart", "the newest `limit` of the two together");
    const bad = await get("/api/events?limit=0");
    assert.deepEqual([bad.status, bad.body.error], [400, "limit is a whole number of events, 1 to 10000"]);
    const when = await get("/api/events?since=yesterday");
    assert.deepEqual([when.status, when.body.error], [400, 'since "yesterday" is not a time']);
    // the one time grammar: no zone refused, a bare number refused, an age taken
    for (const bad of ["2026-10-28T09:00:00", "1"]) assert.equal((await get(`/api/events?since=${bad}`)).status, 400, bad);
    eventAsks.length = 0;
    assert.equal((await get("/api/events?since=2h")).status, 200);
    assert.ok(Math.abs(Date.parse((eventAsks[0] as { since: string }).since) - (Date.now() - 7_200_000)) < 60_000, "an age is that long ago");
  } finally { restarts = []; }
});

test("the state says how each copy is kept current, as the sync's state has it (src/duck/sync.ts KeptCurrent); a table the sync holds none of says nothing", async () => {
  // the run server once mapped a copy's fields one by one, and kept was not among them: mason status --json could not
  // say how a table was kept current, or why it was not, though its text and EXPLAIN did
  const polled = { by: "poll" as const, polledAt: "2026-10-24T10:01:00.000Z", unsynced: "over the 1,000,000-row sync limit" };
  const streamed = { by: "replication" as const, slot: "mason_app", state: "left-out" as const, why: "publication app_pub does not carry public.orders",
    position: "0/16B3F28", lastCommit: null, notRunning: null };
  const recopied = { by: "recopy" as const, copiedAt: "2026-10-24T10:00:00.000Z" };
  const waiting = { by: "poll" as const, polledAt: null, pending: "it waits for its copy: it joins once copied and caught up by one poll" };
  copies = [
    { source: "public.customers", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null,
      unsynced: { reason: polled.unsynced, asOf: polled.polledAt }, kept: polled },
    { source: "public.orders", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null, kept: streamed },
    { source: "public.Shouty", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null, kept: recopied },
    // a copy not made yet, as the sync says it (src/duck/sync.ts keptOf): kept says why it is not kept current, itself
    { source: "public.logs", phase: "waiting", rows: 3, bytes: 8192, seconds: null, copiedAt: null, error: null, kept: waiting },
  ];
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/state`, { headers: { Authorization: "Bearer t0ken-of-this-run" } });
    assert.equal(r.status, 200);
    const by = new Map(((await r.json()) as { tables: Array<{ table: string; kept?: unknown }> }).tables.map((t) => [t.table, t]));
    assert.deepEqual(by.get("public.customers")!.kept, polled);
    assert.deepEqual(by.get("public.orders")!.kept, streamed);
    assert.deepEqual(by.get("public.Shouty")!.kept, recopied);
    assert.deepEqual(by.get("public.logs")!.kept, waiting, "a copy waiting: its kept, with why it is not kept current");
    assert.equal("kept" in by.get("public.events")!, false, "a table the sync does not hold: no kept");
  } finally { copies = []; }
});

test("a table of any size on a database elsewhere can be added, and mason tables says nothing against it (a 22 M-row table could not be)", async () => {
  const remote = parseSource("postgres://me@db.example.com:5432/app");
  assert.ok("source" in remote && remote.source.remote);
  const own = path.join(root, "remote", "mason");
  fs.mkdirSync(path.join(own, "sources"), { recursive: true });
  fs.writeFileSync(path.join(own, "sources", "app.yml"), newSourceText("postgres://me@db.example.com:5432/app"));
  const remoteCtx: RunContext = { ...ctx, source: remote.source, changes: "poll", folder: () => own,
    facts: () => ({ version: 160000, versionText: "16", standby: true, tables: [table({ table: "events", rows: 22_000_000 })], systemIdentifier: null }) };
  const remoteServer = createRunServer(remoteCtx);
  await new Promise<void>((r) => remoteServer.listen(0, "127.0.0.1", () => r()));
  const port = remoteCtx.port = (remoteServer.address() as { port: number }).port;   // the guard holds the Host to the run's own port
  try {
    const ask = (method: string, p: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method,
      headers: { Authorization: "Bearer t0ken-of-this-run", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const state = await (await ask("GET", "/api/state")).json() as { tables: Array<{ table: string; reason: string | null }> };
    assert.deepEqual(state.tables.map((t) => [t.table, t.reason]), [["public.events", null]]);
    const picked = await ask("POST", "/api/pick", { table: "public.events", picked: true });
    assert.equal(picked.status, 200, await picked.text());
    assert.match(fs.readFileSync(path.join(own, "sources", "app.yml"), "utf8"), /\n {2}events: \{\}\n$/);
  } finally { remoteServer.close(); }
});


test("the users: /api/users lists, adds and removes through mason user's own functions and file — its shapes, its sentences", async () => {
  fs.rmSync(usersFile, { force: true });
  const list = async (query = "?lastUsed=1") => JSON.parse((await call("GET", `/api/users${query}`)).text) as { users: Array<Record<string, unknown>>; lastUsedNote: string | null; urlNote: string | null; requestLogDays: number | null };
  assert.deepEqual((await list()).users, []);
  const added = await call("POST", "/api/users", { body: { name: "metabase" } });
  assert.equal(added.status, 200, added.text);
  const a = JSON.parse(added.text) as Record<string, unknown>;
  // mason user add --json's shape: the password, once, and the URL to paste
  assert.deepEqual(Object.keys(a), ["user", "id", "addedAt", "password", "database", "url", "psql", "host", "port", "sslmode", "next"]);
  assert.equal(a.user, "metabase");
  assert.equal(a.password, userPassword(API_KEY, "metabase", a.id as string), "the password the listener takes (src/duck/users.ts)");
  assert.equal(a.url, `postgres://metabase:${a.password as string}@127.0.0.1:5433/app`);
  // the psql line mason user add prints, in the answer: the page shows it with a Copy, an agent runs it
  assert.equal(a.psql, `psql postgres://metabase:${a.password as string}@127.0.0.1:5433/app`);
  assert.deepEqual([a.host, a.port, a.database, a.sslmode], ["127.0.0.1", 5433, "app", "disable"]);
  // the file mason user reads, with no password in it
  const file = readUsers(usersFile);
  assert.ok("users" in file);
  assert.deepEqual(file.users.map((u) => [u.name, u.id]), [["metabase", a.id]]);
  assert.ok(!fs.readFileSync(usersFile, "utf8").includes(a.password as string), "users.json holds no password");
  // the list: removedAt null, last used from the request log, the URL to paste WITHOUT the password (the add's own builder)
  const listed = await list();
  assert.deepEqual(listed.users, [{ name: "metabase", id: a.id, addedAt: a.addedAt, removedAt: null, disabledAt: null, live: true, lastUsedAt: "2026-10-24T10:04:00.000Z", url: "postgres://metabase@127.0.0.1:5433/app" }]);
  assert.deepEqual([listed.lastUsedNote, listed.urlNote, listed.requestLogDays], [null, null, 7]);
  assert.deepEqual(lastUsedAsks.at(-1), { name: "metabase", since: a.addedAt, until: null }, "asked for the window the user was a user in");
  // the web page asks every 2 s and shows no last use: without ?lastUsed=1 the request log is never scanned
  const scans = lastUsedAsks.length;
  const plain = await list("");
  assert.equal(lastUsedAsks.length, scans, "no scan of the request log");
  assert.deepEqual(plain.users.map((u) => u.lastUsedAt), [null]);
  assert.equal(plain.lastUsedNote, "not asked: GET /api/users?lastUsed=1 reads it from the request log");
  assert.ok(logged.includes("user metabase added"), "the run's log says it, without the password");
  assert.ok(!logged.some((l) => l.includes(a.password as string)));

  // refused in mason user add's own sentences, as the Failure shape the page renders
  const again = await call("POST", "/api/users", { body: { name: "metabase" } });
  assert.equal(again.status, 409);
  const f = JSON.parse(again.text) as { error: string; failure: { code: string; message: string; why: string; fix: string; next: Array<{ command: string; what: string }> } };
  assert.equal(f.error, "there is already a user \"metabase\"");
  assert.deepEqual(f.failure, { code: "refused", message: "there is already a user \"metabase\"",
    why: "a name names one user, so removing it means one thing; its password is not kept, so it cannot be printed again",
    fix: "mason user remove metabase, then mason user add metabase (a new password; the old one stops connecting), or add another name (metabase-2) and remove metabase once the tool uses it",
    next: [{ command: "mason user list", what: "the users" }, { command: "mason user remove metabase", what: "then add it again, with a new password" }] });
  const bad = await call("POST", "/api/users", { body: { name: "Metabase" } });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).failure.message, `"Metabase" is not a user name: ${USER_NAME_RULE}`);
  assert.equal(JSON.parse(bad.text).failure.code, "usage");
  assert.equal((await call("POST", "/api/users", { body: { user: "x" } })).status, 400, "no name");
  assert.equal(JSON.parse((await call("POST", "/api/users", { body: { user: "x" } })).text).error, "send { name }: the user's name");

  // a change from another site, or with no Origin, never reaches the file
  for (const origin of [null, "http://evil.example"]) {
    assert.equal((await call("POST", "/api/users", { origin, body: { name: "grafana" } })).status, 403, String(origin));
    assert.equal((await call("DELETE", "/api/users/metabase", { origin })).status, 403, String(origin));
  }
  assert.deepEqual((await list()).users.map((u) => u.name), ["metabase"], "nothing a refused request asked for happened");

  const typo = await call("DELETE", "/api/users/metabse");
  assert.equal(typo.status, 404);
  assert.deepEqual(JSON.parse(typo.text).failure, { code: "not_found", message: "there is no user \"metabse\" — did you mean `metabase`?", why: "the users: metabase",
    next: [{ command: "mason user list", what: "the users" }] });
  const removed = await call("DELETE", "/api/users/metabase");
  assert.equal(removed.status, 200, removed.text);
  const gone = JSON.parse(removed.text) as { removed: { removedAt: string } };
  assert.deepEqual(gone, { removed: { name: "metabase", id: a.id, addedAt: a.addedAt, removedAt: gone.removed.removedAt },
    next: [{ command: "mason user list", what: "the users, removed ones included" }, { command: "mason user add <name>", what: "a new user, with a new password" }] });
  // kept, marked removed: no URL, does not connect, last used asked within [addedAt, removedAt]
  assert.deepEqual((await list()).users, [{ name: "metabase", id: a.id, addedAt: a.addedAt, removedAt: gone.removed.removedAt, disabledAt: null, live: false, lastUsedAt: "2026-10-24T10:04:00.000Z", url: null }]);
  assert.deepEqual(lastUsedAsks.at(-1), { name: "metabase", since: a.addedAt, until: gone.removed.removedAt });
  // removing it again is not found; the name can be added again, as a new id, and the removed entry stays
  assert.equal((await call("DELETE", "/api/users/metabase")).status, 404);
  const second = JSON.parse((await call("POST", "/api/users", { body: { name: "metabase" } })).text) as { id: string };
  assert.notEqual(second.id, a.id);
  assert.deepEqual((await list()).users.map((u) => [u.id, u.removedAt === null]), [[a.id, false], [second.id, true]]);
  assert.ok(!fs.existsSync(`${usersFile}.lock`), "the lock is let go");
});

test("the users: POST /api/users/<name>/disable and /enable through mason user's own functions — kept with its id, its shapes, a no-op said, its refusals", async () => {
  fs.rmSync(usersFile, { force: true });
  const a = JSON.parse((await call("POST", "/api/users", { body: { name: "grafana" } })).text) as { id: string; addedAt: string };
  const off = await call("POST", "/api/users/grafana/disable");
  assert.equal(off.status, 200, off.text);
  const d = JSON.parse(off.text) as { disabled: { disabledAt: string } };
  // mason user disable --json's shape
  assert.deepEqual(d, { disabled: { name: "grafana", id: a.id, addedAt: a.addedAt, disabledAt: d.disabled.disabledAt }, already: false,
    next: [{ command: "mason user enable grafana", what: "it connects again, with the same password" }, { command: "mason user list", what: "the users" }] });
  assert.ok(logged.includes("user grafana disabled"));
  const file = readUsers(usersFile);
  assert.ok("users" in file);
  assert.deepEqual(file.users.map((u) => [u.id, u.disabledAt, u.removedAt]), [[a.id, d.disabled.disabledAt, undefined]], "kept, its id (so its password) unchanged");
  const listed = JSON.parse((await call("GET", "/api/users")).text) as { users: Array<Record<string, unknown>> };
  assert.deepEqual([listed.users[0]!.disabledAt, listed.users[0]!.live, listed.users[0]!.url], [d.disabled.disabledAt, false, "postgres://grafana@127.0.0.1:5433/app"]);
  // again: said so, nothing written
  const again = JSON.parse((await call("POST", "/api/users/grafana/disable")).text) as { disabled: { disabledAt: string }; already: boolean };
  assert.deepEqual([again.disabled.disabledAt, again.already], [d.disabled.disabledAt, true]);
  // a change from another site never reaches the file; a name it lacks is not found with the closest; a bad name is usage
  for (const origin of [null, "http://evil.example"]) assert.equal((await call("POST", "/api/users/grafana/enable", { origin })).status, 403, String(origin));
  const typo = await call("POST", "/api/users/grafana-x/enable");
  assert.equal(typo.status, 404);
  assert.deepEqual(JSON.parse(typo.text).failure, { code: "not_found", message: "there is no user \"grafana-x\" — did you mean `grafana`?", why: "the users: grafana",
    next: [{ command: "mason user list", what: "the users" }] });
  const bad = await call("POST", "/api/users/Grafana/disable");
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).failure.message, `"Grafana" is not a user name: ${USER_NAME_RULE}`);
  assert.equal((await call("GET", "/api/users/grafana/disable")).status, 404, "a change is a POST");
  const on = await call("POST", "/api/users/grafana/enable");
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(JSON.parse(on.text), { enabled: { name: "grafana", id: a.id, addedAt: a.addedAt }, already: false,
    next: [{ command: "mason user list", what: "the users" }, { command: "mason user disable grafana", what: "it connects no more, until enabled" }] });
  assert.ok(logged.includes("user grafana enabled"));
  assert.equal((readUsers(usersFile) as { users: Array<{ disabledAt?: string }> }).users[0]!.disabledAt, undefined, "cleared");
  assert.equal(JSON.parse((await call("POST", "/api/users/grafana/enable")).text).already, true, "enabling one not disabled: said so");
  // a removed user is no user to disable
  await call("DELETE", "/api/users/grafana");
  assert.equal((await call("POST", "/api/users/grafana/disable")).status, 404);
});

test("every error answer carries the Failure shape beside its sentence, the catch-all's wording kept", async () => {
  const r = await call("GET", "/nope");
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.text), { error: "no GET /nope: this is mason start's server for the mason command (mason --help)",
    failure: { code: "not_found", message: "no GET /nope: this is mason start's server for the mason command (mason --help)", next: [] } });
  const notJson = await call("POST", "/api/users", { body: undefined });
  assert.equal(notJson.status, 400);
  assert.match(JSON.parse(notJson.text).failure.message, /^the body is not JSON: /);
  const limit = JSON.parse((await call("GET", "/api/requests?limit=0")).text);
  assert.deepEqual(limit, { error: "limit is a whole number of requests, 1 to 10000", failure: { code: "usage", message: "limit is a whole number of requests, 1 to 10000", next: [] } });
});

test("GET /api/logs: the run's last entries from memory, { at, text } oldest first, under the guard; lines and since narrow, a bad one is a sentence", async () => {
  assert.equal((await call("GET", "/api/logs", { cookie: null })).status, 403, "the guard applies");
  assert.equal((await call("GET", "/api/logs", { host: `evil.example:${ctx.port}` })).status, 421);
  const bearer = await call("GET", "/api/logs", { cookie: null, bearer: "t0ken-of-this-run" });
  assert.equal(bearer.status, 200, "the commands' Bearer token passes");
  assert.deepEqual(JSON.parse(bearer.text), { lines: [], kept: 3 });
  for (const t of ["10:00:00.000", "10:00:01.000", "10:00:02.000", "10:00:03.000"]) runLog.push(`2026-10-24T${t}Z [sync] at ${t}\n    its second line\n`);
  const get = async (q: string) => { const r = await call("GET", `/api/logs${q}`); return { status: r.status, body: JSON.parse(r.text) as { lines?: Array<{ at: string; text: string }>; kept?: number; error?: string } }; };
  const all = await get("");
  assert.equal(all.body.kept, 3);
  assert.deepEqual(all.body.lines, ["10:00:01.000", "10:00:02.000", "10:00:03.000"].map((t) => ({ at: `2026-10-24T${t}Z`, text: `[sync] at ${t}\n    its second line` })), "bounded to what it keeps, a multi-line entry ONE");
  assert.deepEqual((await get("?lines=2")).body.lines!.map((l) => l.at), ["2026-10-24T10:00:02.000Z", "2026-10-24T10:00:03.000Z"]);
  assert.deepEqual((await get("?since=2026-10-24T10:00:02.000Z")).body.lines!.map((l) => l.at), ["2026-10-24T10:00:03.000Z"]);
  const bad = await get("?lines=4");
  assert.deepEqual([bad.status, bad.body.error], [400, "lines is a whole number of log entries, 1 to 3 (all the run keeps)"]);
  // the one time grammar (src/cli/request-filter.ts timeOf), as every other entrance: an age, or a time with its zone
  for (const bad of ["yesterday", "1", "2026-10-24T10:00:02"]) assert.equal((await get(`?since=${bad}`)).status, 400, bad);
  assert.deepEqual((await get("?since=2026-10-24T10:00:02Z")).body.lines!.map((l) => l.at), ["2026-10-24T10:00:03.000Z"]);
  assert.deepEqual((await get("?since=1h")).body.lines, [], "an hour ago is after every entry of 2026-10-24");
});

test("the request log's filters and pages: each reaches the ledger as read by the one parser, a malformed one is refused in the Failure shape", async () => {
  const get = async (p: string) => { const r = await call("GET", p); return { status: r.status, body: JSON.parse(r.text) as Record<string, unknown> }; };
  asks.length = 0;
  const ok = await get("/api/requests?limit=2&outcome=failed,cancelled&since=2026-10-24T09:00:00Z&until=2026-10-25&user=metabase&client=Metabase&before=2026-10-24T10:04:00.000Z~3");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(asks[0], { limit: 2, outcomes: ["failed", "cancelled"], since: "2026-10-24T09:00:00.000Z", until: "2026-10-25T00:00:00.000Z", user: "metabase", client: "Metabase",
    before: { at: "2026-10-24T10:04:00.000Z", seq: 3 } }, "every filter reaches the ledger, its times as ISO 8601 UTC");
  assert.equal((await get("/api/requests?limit=1")).body.before, "2026-10-24T10:04:00.000Z~3", "a page with older rows hands on its position");
  const refusals: Array<[string, string]> = [
    ["outcome=cancel", 'outcome "cancel" is none of ok, refused, failed, cancelled — did you mean `cancelled`?'],
    ["outcome=failed&failed=1", "failed is every outcome but ok: name it or outcome, never both"],
    ["since=yesterday", 'since "yesterday" is not a time'],
    ["since=2026-10-24T09:00", 'since "2026-10-24T09:00" is not a time'],
    ["since=2026-10-25&until=2026-10-24", "since (2026-10-25T00:00:00.000Z) is not before until (2026-10-24T00:00:00.000Z): no request started in between"],
    ["user=", "user names a mason user: it is empty"],
    ["before=42", 'before "42" is not a position in the request log'],
  ];
  for (const [q, message] of refusals) {
    const r = await get(`/api/requests?${q}`);
    assert.equal(r.status, 400, q);
    const f = r.body.failure as { code: string; message: string };
    assert.deepEqual([r.body.error, f.code, f.message], [message, "usage", message], q);
  }
  assert.match(String(((await get("/api/requests?since=soon")).body.failure as { fix: string }).fix), /an age \(30m, 2h, 7d\) or an ISO 8601 date or time with its zone/);
  assert.equal(asks.length, 2, "a refused read never reaches the ledger");
});

test("the query summary, the statements running now and a cancel: the ledger's and the listener's own, a cancel a POST under the run's guard", async () => {
  const get = async (p: string) => { const r = await call("GET", p); return { status: r.status, body: JSON.parse(r.text) as Record<string, unknown> }; };
  assert.deepEqual((await get("/api/queries")).body, { queries: summary });
  assert.deepEqual((await get("/api/running")).body, { running: [runningNow] });
  cancels.length = 0;
  const cancel = async (body: unknown, o: { origin?: string | null; cookie?: string | null } = {}) => { const r = await call("POST", "/api/cancel", { body, ...o }); return { status: r.status, text: r.text }; };
  assert.equal((await cancel({ session: 4 }, { cookie: null })).status, 403, "no token: refused");
  assert.equal((await cancel({ session: 4 }, { origin: "http://evil.example" })).status, 403, "a write from another Origin: refused");
  assert.deepEqual(cancels, [], "nothing the guard refused reached the listener");
  const done = await cancel({ session: 4 });
  assert.deepEqual([done.status, JSON.parse(done.text)], [200, { cancelled: runningNow }]);
  const running = [{ command: "mason logs --running", what: "the statements running now, with their sessions" }];
  const idle = await cancel({ session: 5 });
  assert.deepEqual([idle.status, JSON.parse(idle.text).failure], [409, { code: "refused", message: "session 5 is running no statement: nothing to cancel", why: "its statement ended, or it is between two", next: running }]);
  const gone = await cancel({ session: 77 });
  assert.deepEqual([gone.status, JSON.parse(gone.text).failure], [404, { code: "not_found", message: "no session 77 is open", why: "it ended, or never was", next: running }]);
  const bad = await cancel({ session: "4" });
  assert.deepEqual([bad.status, JSON.parse(bad.text).failure.message], [400, "send { session }: the session's number, as mason logs --running lists it"]);
  // a statement named: cancelled only while it is the one the session runs
  const named = await cancel({ session: 4, statement: 9 });
  assert.deepEqual([named.status, JSON.parse(named.text)], [200, { cancelled: runningNow }]);
  const moved = await cancel({ session: 4, statement: 8 });
  assert.deepEqual([moved.status, JSON.parse(moved.text).failure], [409, { code: "refused", message: "session 4 runs another statement now (statement 9), not statement 8: nothing cancelled",
    why: "statement 8 ended, and the session began another", fix: "mason cancel 4 --statement 9 stops the one it runs now", next: running }]);
  const badStatement = await cancel({ session: 4, statement: 0 });
  assert.deepEqual([badStatement.status, JSON.parse(badStatement.text).failure.message], [400, "statement is the statement's number, as mason logs --running lists it, or left out"]);
  assert.deepEqual(cancels, [4, 5, 77, [4, 9], [4, 8]]);
});

test("/api/state says where a tool connects: the Postgres API's URL with <user>:<password> in the credentials' place and its psql line, as mason status prints them", async () => {
  const state = JSON.parse((await call("GET", "/api/state")).text) as { postgres?: unknown };
  // the web page's Connect panel renders this; mason status --json says the same object (with the listener)
  assert.deepEqual(state.postgres, { url: "postgresql://127.0.0.1:5433/app", host: "127.0.0.1", port: 5433, database: "app",
    shown: "postgres://<user>:<password>@127.0.0.1:5433/app", psql: "psql 'postgres://<user>:<password>@127.0.0.1:5433/app'" });
});

test("/api/state is lean, as the page polls it every 2 s: no table's columns; ?columns=1 carries them (mason status --json), and one table's are GET /api/tables/<table>/columns", async () => {
  const lean = JSON.parse((await call("GET", "/api/state")).text) as { tables: Array<{ table: string; columns?: unknown }> };
  assert.equal(lean.tables.length, tables.length);
  assert.ok(lean.tables.every((t) => !("columns" in t)), "no table's columns in the state the page polls");
  const full = JSON.parse((await call("GET", "/api/state?columns=1")).text) as { tables: Array<{ table: string; columns: Array<{ name: string }> }> };
  assert.deepEqual(full.tables.map((t) => t.columns.map((c) => c.name).join(",")), ["id,name", "id,name", "id,name", "tenant_id,id,body", "id,customer_id"]);
  const { columns: _, ...rest } = full.tables[4]!;
  assert.deepEqual(rest, lean.tables[4], "the same state, the columns left out: one computation");
  const one = await call("GET", `/api/tables/${encodeURIComponent("public.orders")}/columns`);
  assert.equal(one.status, 200);
  assert.deepEqual(JSON.parse(one.text), { table: "public.orders", columns: full.tables[4]!.columns }, "the columns the state's full form says, references included");
  assert.deepEqual(JSON.parse(one.text).columns[1], { name: "customer_id", type: "bigint", nullable: true, comment: null, references: { table: "public.customers", column: "id" } });
  assert.equal(JSON.parse((await call("GET", "/api/tables/public.Shouty/columns")).text).table, "public.Shouty");
  const gone = await call("GET", "/api/tables/public.gone/columns");
  assert.equal(gone.status, 404);
  const failure = JSON.parse(gone.text).failure as { code: string; message: string; next: unknown[] };
  assert.equal(failure.code, "not_found");
  assert.equal(failure.message, 'the database has no table "public.gone" this user can read');
  assert.ok(failure.next.length, "with what to run next");
  // a path that is no URL-encoded name (a broken escape) is the caller's mistake, 400 by name — never the server's 500
  const broken = await call("GET", "/api/tables/public.%E0%A4%A/columns");
  assert.equal(broken.status, 400);
  assert.match(JSON.parse(broken.text).error as string, /does not name a table: GET \/api\/tables\/<schema\.table, URL-encoded>\/columns/);
});

test("the lean state's size: 800 tables of 50 columns is under 400 B a table (it was 4.3 KB with their columns)", async () => {
  const runServerModule = await import("../src/cli/run-server.ts");
  const wide = Array.from({ length: 800 }, (_, i) => table({ table: `t_${i}`, columns: Array.from({ length: 50 }, (_, j) => col(j ? `column_${j}` : "id")) }));
  const c: RunContext = { ...ctx, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: wide, systemIdentifier: null }) };
  const bytes = JSON.stringify(runServerModule.runState(c, [], null)).length;
  assert.ok(bytes < 800 * 400, `${bytes} bytes`);
});

test("the summary (/api/queries) is one read shared for 30 s by every page and command that asks: a 7-day scan each was ~0.15 s", async () => {
  const runServer = await import("../src/cli/run-server.ts") as unknown as { SUMMARY_TTL_MS?: number; timedCache?: <T>(read: () => Promise<T>, ms: number, clock?: () => number) => () => Promise<T> };
  assert.equal(runServer.SUMMARY_TTL_MS, 30_000);
  const before = summaryReads;
  const answers = await Promise.all([call("GET", "/api/queries"), call("GET", "/api/queries"), call("GET", "/api/queries")]);
  assert.ok(answers.every((a) => a.status === 200 && JSON.parse(a.text).queries.week.statements === 3));
  assert.ok(summaryReads - before <= 1, `${summaryReads - before} reads for three asks within 30 s`);
  // the cache itself, on a clock of its own: shared within the time, read again after it, a failure never kept
  let now = 0, reads = 0, fail = false;
  const cached = runServer.timedCache!(async () => { reads++; if (fail) throw new Error("the request log could not be read"); return reads; }, 30_000, () => now);
  assert.deepEqual(await Promise.all([cached(), cached()]), [1, 1], "two at once: one read");
  now = 29_999;
  assert.equal(await cached(), 1);
  now = 30_000;
  assert.equal(await cached(), 2, "30 s on: read again");
  now = 70_000; fail = true;
  await assert.rejects(cached(), /could not be read/);
  fail = false;
  assert.equal(await cached(), 4, "the failed read is not kept: the next ask reads again");
});
