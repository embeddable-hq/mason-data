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
import type { LedgerRequest } from "../src/duck/requests.ts";
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
const asks: Array<{ limit: number; failed?: boolean }> = [];
const request: LedgerRequest = { requestId: "r1", startedAt: "2026-10-24T10:04:00.000Z", session: 3, applicationName: "Metabase", tokenName: "", user: "", method: "QUERY",
  outcome: "refused", sqlstate: "42P01", message: 'relation "nope" does not exist', detail: null, hint: null, rows: null, durationMs: 2, query: "SELECT * FROM nope", queryTruncated: false };
const requests = {
  days: 7,
  recent: async (o: { limit: number; failed?: boolean }) => { asks.push(o); return [request]; },
  slow: async () => [{ route: "postgres" as const, payload: "SELECT count(*) FROM orders", runs: 2, medianMs: 1500, maxMs: 2000, latestMs: 2000, last: "2026-10-24T10:03:00.000Z" }],
  refused: async () => ({ total: 3, refused: [{ route: "postgres" as const, payload: "SELECT * FROM nope", runs: 3, last: "2026-10-24T10:04:00.000Z", code: "42P01", message: 'relation "nope" does not exist' }] }),
};
const usersFile = path.join(root, "app", ".mason", "users.json");
const API_KEY = "k".repeat(48);
const ctx: RunContext = {
  page: true, users: { file: usersFile, apiKey: API_KEY, database: "app", postgresUrl: "postgresql://127.0.0.1:5433/app" },
  source: parsed.source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables, systemIdentifier: null }), warnings: [],
  slot: "", changes: "poll", port: 0, token: "t0ken-of-this-run",
  folder: () => chosen, root: path.join(root, "app"), sources: () => ({ file: null, problem: null }), sourcesChanged: () => { changed++; }, log: (m) => logged.push(m),
  // the file as the run reads it: its URL resolved from no environment (the test's file writes it whole)
  readSource: () => chosen === null ? { message: "no folder chosen", code: "bad_source" } : readSource(chosen, path.join(root, "app"), {}),
  runUrl: "postgres://me@localhost:5432/app",
  duck: { copies: () => copies, file: duckFile, pollSeconds: 5, poll: pollNow, stream: async () => null, requests },
};
const server = createRunServer(ctx);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
ctx.port = (server.address() as { port: number }).port;
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

const COOKIE = "mason_dev=t0ken-of-this-run";
function call(method: string, p: string, o: { host?: string; origin?: string | null; cookie?: string | null; body?: unknown; bearer?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${ctx.port}` };
    const cookie = o.cookie === undefined ? COOKIE : o.cookie;
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
  assert.equal((await call("GET", "/api/state", { cookie: "mason_dev=another" })).status, 403);
  assert.equal((await call("GET", "/api/state", { host: `evil.example:${ctx.port}` })).status, 421, "DNS rebinding: the Host is not this server");
  const handed = await call("GET", "/?token=t0ken-of-this-run", { cookie: null });
  assert.equal(handed.status, 303);
  assert.match(String(handed.headers["set-cookie"]), /mason_dev=t0ken-of-this-run;.*HttpOnly.*SameSite=Strict/i);
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
  const state = JSON.parse((await bearer("GET", "/api/state")).text) as { project: string | null; tables: Array<{ table: string; added: boolean; addedColumns: string[] | null; columns: unknown[] }> };
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

test("the web page: /, /app.js and /app.css from src/web/, with their types and the security headers; any other path is the 404 it was", async () => {
  const web = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "web");
  for (const [p, file, type] of [["/", "index.html", "text/html; charset=utf-8"], ["/app.js", "app.js", "text/javascript; charset=utf-8"], ["/app.css", "app.css", "text/css; charset=utf-8"]] as const) {
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
  for (const p of ["/index.html", "/app.d.ts", "/web/app.js", "/../cli/run-server.ts", "/%2e%2e/cli/run-server.ts", "/app.js/", "/api/folders", "/api/preview"]) {
    const r = await call("GET", p);
    assert.equal(r.status, 404, p);
    assert.match(JSON.parse(r.text).error, /^no GET \/.*: this is mason start's server for the mason command \(mason --help\)$/, p);
    assert.equal(JSON.parse(r.text).failure.code, "not_found", p);
  }
  assert.equal((await call("POST", "/app.js", { body: {} })).status, 404, "a file is only read");
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
    assert.deepEqual(s.body.engine, { name: "duckdb", file: duckFile, bytes: 10, pollSeconds: 5 });
    // the slow and refused statements are the request log's, in the shapes mason status renders
    assert.deepEqual((await get("/api/slow")).body, { slow: await requests.slow(), slowMs: 1000 });
    assert.deepEqual((await get("/api/refused")).body, await requests.refused());
    assert.deepEqual((await get("/api/requests?limit=5&failed=1")).body, { requests: [request], keptDays: 7 });
    assert.deepEqual((await get("/api/requests")).body.requests, [request]);
    assert.deepEqual(asks, [{ limit: 5, failed: true }, { limit: 40, failed: false }], "-n and --failed reach the ledger; 40 by default");
    const bad = await get("/api/requests?limit=0");
    assert.deepEqual([bad.status, bad.body.error], [400, "limit is a whole number of requests, 1 to 10000"]);
    // what proves a run is up (src/cli/runs.ts answers): the pid, and nothing of a service
    assert.deepEqual((await get("/api/ping")).body, { pid: process.pid });
    for (const p of ["/api/builds", "/api/built-from", "/api/memory"]) assert.equal((await get(p)).status, 404, `${p} was the ClickHouse run's`);
  } finally { copies = []; }
});

test("the state says how each copy is kept current, as the sync's state has it (src/duck/sync.ts KeptCurrent); a table the sync holds none of says nothing", async () => {
  // the run server once mapped a copy's fields one by one, and kept was not among them: mason status --json could not
  // say how a table was kept current, or why it was not, though its text and EXPLAIN did
  const polled = { by: "poll" as const, polledAt: "2026-10-24T10:01:00.000Z", unsynced: "over the 1,000,000-row sync limit" };
  const streamed = { by: "replication" as const, slot: "mason_app", state: "left-out" as const, why: "publication app_pub does not carry public.orders",
    position: "0/16B3F28", lastCommit: null, notRunning: null };
  const recopied = { by: "recopy" as const, copiedAt: "2026-10-24T10:00:00.000Z" };
  copies = [
    { source: "public.customers", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null,
      unsynced: { reason: polled.unsynced, asOf: polled.polledAt }, kept: polled },
    { source: "public.orders", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null, kept: streamed },
    { source: "public.Shouty", phase: "copied", rows: 3, bytes: 8192, seconds: 1, copiedAt: "2026-10-24T10:00:00.000Z", error: null, kept: recopied },
    // a copy from a sync before kept was said: nothing is made up for it
    { source: "public.logs", phase: "waiting", rows: 3, bytes: 8192, seconds: null, copiedAt: null, error: null },
  ];
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/state`, { headers: { Authorization: "Bearer t0ken-of-this-run" } });
    assert.equal(r.status, 200);
    const by = new Map(((await r.json()) as { tables: Array<{ table: string; kept?: unknown }> }).tables.map((t) => [t.table, t]));
    assert.deepEqual(by.get("public.customers")!.kept, polled);
    assert.deepEqual(by.get("public.orders")!.kept, streamed);
    assert.deepEqual(by.get("public.Shouty")!.kept, recopied);
    assert.equal("kept" in by.get("public.logs")!, false, "a copy the sync says nothing of: no kept");
    assert.equal("kept" in by.get("public.events")!, false, "a table the sync holds no copy of: no kept");
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
  const list = async () => JSON.parse((await call("GET", "/api/users")).text) as { users: Array<{ name: string; id: string; addedAt: string; live: boolean }> };
  assert.deepEqual((await list()).users, []);
  const added = await call("POST", "/api/users", { body: { name: "metabase" } });
  assert.equal(added.status, 200, added.text);
  const a = JSON.parse(added.text) as Record<string, unknown>;
  // mason user add --json's shape: the password, once, and the URL to paste
  assert.deepEqual(Object.keys(a), ["user", "id", "addedAt", "password", "database", "url", "host", "port", "sslmode", "next"]);
  assert.equal(a.user, "metabase");
  assert.equal(a.password, userPassword(API_KEY, "metabase", a.id as string), "the password the listener takes (src/duck/users.ts)");
  assert.equal(a.url, `postgres://metabase:${a.password as string}@127.0.0.1:5433/app`);
  assert.deepEqual([a.host, a.port, a.database, a.sslmode], ["127.0.0.1", 5433, "app", "disable"]);
  // the file mason user reads, with no password in it
  const file = readUsers(usersFile);
  assert.ok("users" in file);
  assert.deepEqual(file.users.map((u) => [u.name, u.id]), [["metabase", a.id]]);
  assert.ok(!fs.readFileSync(usersFile, "utf8").includes(a.password as string), "users.json holds no password");
  assert.deepEqual((await list()).users, [{ name: "metabase", id: a.id, addedAt: a.addedAt, live: true }]);
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
  assert.deepEqual(JSON.parse(removed.text), { removed: { name: "metabase", id: a.id, addedAt: a.addedAt },
    next: [{ command: "mason user list", what: "the users left" }, { command: "mason user add <name>", what: "a new user, with a new password" }] });
  assert.deepEqual((await list()).users, []);
  assert.ok(!fs.existsSync(`${usersFile}.lock`), "the lock is let go");
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
