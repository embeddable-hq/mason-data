/**
 * `MASON_UI_READ_ONLY=1` (src/cli/ui-read-only.ts): `mason serve`'s page only shows. Its server refuses every request of
 * the page that is not a GET or a HEAD — BY RULE: every method is sent to every path the run's server names
 * (src/cli/run-server.ts, read from its source, so a route added later is in the test by construction) — on the
 * server's own Host, through a tunnel (`mason ui --ssh`, `--bridge`) and on the Unix socket alike, in the failure shape,
 * and nothing it asked for happens. A request with the run's token is the commands', served as before. Without the
 * setting nothing changes. A junk value refuses the start; `mason start` refuses the setting.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunServer, PAGE_ROUTES, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";
import { listenOnUiSocket, prepareUiSocket } from "../src/cli/ui-socket.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const readOnlyModule = await import("../src/cli/ui-read-only.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-read-only.ts")>;
const missing = (): never => assert.fail("src/cli/ui-read-only.ts is not in this tree");
const uiReadOnlySetting = readOnlyModule.uiReadOnlySetting ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const REFUSAL = {
  code: "refused", message: "the web page is read-only here (MASON_UI_READ_ONLY=1): it shows what Mason syncs, and changes nothing",
  why: "Mason was started with MASON_UI_READ_ONLY=1, so the page refuses every change, whatever it asks",
  fix: "make the change with the mason command where Mason runs, or ask whoever runs it", next: [],
};
const KEY = "k".repeat(48);
const TOKEN = "t".repeat(64);
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// a short folder: a socket's path is at most 107 bytes, and os.tmpdir() may be long
const temp = (): string => { const d = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "mro-")); fs.chmodSync(d, 0o700); made.push(d); return d; };

const parsed = parseSource("postgres://me@localhost:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);

/** EVERY PATH THE RUN'S SERVER NAMES, read from its source: each `url.pathname === "…"`, each route's pattern with its
 *  parts filled in, each prefix, and the page's files. */
function routesOfTheServer(): string[] {
  const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "run-server.ts"), "utf8");
  const paths = new Set<string>(Object.keys(PAGE_ROUTES));
  for (const m of text.matchAll(/url\.pathname === "([^"]+)"/g)) paths.add(m[1]!);
  for (const m of text.matchAll(/url\.pathname\.startsWith\("([^"]+)"\)/g)) paths.add(`${m[1]!}x`);
  for (const m of text.matchAll(/\/\^(\\\/api[^\s]*?)\$\//g)) {
    const pattern = m[1]!.replace(/\\\//g, "/").replace(/\[\^\/\]\+/g, "x");
    const alternatives = /\(([a-z|]+)\)/.exec(pattern);
    for (const a of alternatives ? alternatives[1]!.split("|") : [""]) paths.add(alternatives ? pattern.replace(alternatives[0], a) : pattern);
  }
  return [...paths].sort();
}

/** A server's run, with every change it could make recorded: the users' file, the sources file told, a poll, a cancel. */
function runServer(o: { pageReadOnly?: boolean; pageReadOnlyAllow?: string[] } = {}): { server: http.Server; ctx: RunContext; changes: string[]; root: string } {
  const root = temp();
  const changes: string[] = [];
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    port: 0, token: TOKEN, page: true, served: true, ...(o.pageReadOnly === undefined ? {} : { pageReadOnly: o.pageReadOnly }),
    ...(o.pageReadOnlyAllow === undefined ? {} : { pageReadOnlyAllow: o.pageReadOnlyAllow }),
    users: { file: path.join(root, "users.json"), apiKey: KEY, database: "shop", postgresUrl: "postgresql://localhost:5433/shop" },
    folder: () => null, root, home: root, version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }),
    sourcesChanged: () => { changes.push("sources"); }, log: () => undefined,
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session: number) => { changes.push(`cancel ${session}`); return { unknown: session }; } },
    logs: { capacity: 10, recent: () => [] },
    readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async (t: string[]) => { changes.push(`sync ${t.join(",")}`); return { at: "2026-11-07T10:00:00.000Z", tables: [] }; },
      stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }), restarts: () => [],
      requests: { days: 7 } },
  } as unknown as RunContext;
  return { server: createRunServer(ctx), ctx, changes, root };
}

async function listening(o: { pageReadOnly?: boolean; pageReadOnlyAllow?: string[] } = {}): Promise<ReturnType<typeof runServer>> {
  const r = runServer(o);
  await new Promise<void>((resolve) => r.server.listen(0, "127.0.0.1", resolve));
  r.ctx.port = (r.server.address() as { port: number }).port;
  after(() => { r.server.closeAllConnections(); r.server.close(); });
  return r;
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; text: string; req: http.ClientRequest }
/** A request to the server at `port` (or on the socket `socketPath`); `hold`: the answer stays open, its first line read. */
function call(o: { port?: number; socketPath?: string; method?: string; path?: string; headers?: Record<string, string>; body?: string; hold?: boolean }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const where = o.socketPath !== undefined ? { socketPath: o.socketPath } : { host: "127.0.0.1", port: o.port! };
    const req = http.request({ ...where, method: o.method ?? "GET", path: o.path ?? "/", headers: { Connection: "close", ...o.headers }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { text += c; if (o.hold && text.includes("\n")) resolve({ status: res.statusCode ?? 0, headers: res.headers, text, req }); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, req }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

/** The page's own headers at the server's Host: its cookie, and its Origin on a change. */
const pageHeaders = (port: number, method: string): Record<string, string> =>
  ({ Host: `127.0.0.1:${port}`, Cookie: `mason_dev_${port}=${TOKEN}`, ...(method === "GET" || method === "HEAD" ? {} : { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }) });
const failureOf = (a: Answer): unknown => (JSON.parse(a.text) as { failure?: unknown }).failure;
const WRITES = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

test("the paths read from the run's server are every route it has: the page's files and each /api route, its patterns filled in", () => {
  const routes = routesOfTheServer();
  for (const p of ["/", "/api/state", "/api/pick", "/api/remove", "/api/sync", "/api/cancel", "/api/share", "/api/share/choices", "/api/share/x", "/api/share/x/beat",
    "/api/ui/tunnel", "/api/users", "/api/users/x", "/api/users/x/disable", "/api/users/x/enable", "/api/users/x/from", "/api/tables/x/columns"]) assert.ok(routes.includes(p), p);
  assert.ok(routes.length >= 40, `${routes.length} paths`);
});

test("read-only: every method but GET and HEAD to every path of the server is refused 403 in the failure shape, and nothing it asked for happened", async () => {
  const { ctx, changes, root } = await listening({ pageReadOnly: true });
  const body = JSON.stringify({ name: "grafana", tables: ["public.orders"], table: "public.orders", picked: true, session: 4, port: 50_000, from: "page", confirmed: true });
  for (const p of routesOfTheServer()) {
    for (const method of WRITES) {
      const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body });
      assert.equal(a.status, 403, `${method} ${p}`);
      assert.deepEqual(failureOf(a), REFUSAL, `${method} ${p}`);
      assert.equal(JSON.parse(a.text).error, REFUSAL.message);
    }
  }
  // a path the server does not have is refused by the same rule: a route added later is too
  assert.deepEqual(failureOf(await call({ port: ctx.port, method: "POST", path: "/api/a-route-added-later", headers: pageHeaders(ctx.port, "POST"), body })), REFUSAL);
  assert.deepEqual(changes, [], "no sync, no cancel, no sources file told");
  assert.ok(!fs.existsSync(path.join(root, "users.json")), "no user written");
});

test("read-only: viewing is unchanged — a GET or a HEAD of every path is never the refusal, and changes nothing; the state says why", async () => {
  const { ctx, changes, root } = await listening({ pageReadOnly: true });
  for (const p of routesOfTheServer()) {
    for (const method of ["GET", "HEAD"]) {
      const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method) });
      assert.notEqual(a.status, 403, `${method} ${p}`);
      if (method === "GET" && a.headers["content-type"]?.startsWith("application/json")) assert.notDeepEqual(failureOf(a), REFUSAL, p);
    }
  }
  const state = JSON.parse((await call({ port: ctx.port, path: "/api/state", headers: pageHeaders(ctx.port, "GET") })).text) as { pageReadOnly: string | null };
  assert.equal(state.pageReadOnly, "the web page is read-only here (MASON_UI_READ_ONLY=1)");
  assert.equal((await call({ port: ctx.port, path: "/", headers: pageHeaders(ctx.port, "GET") })).status, 200, "the page itself");
  assert.deepEqual(changes, []);
  assert.ok(!fs.existsSync(path.join(root, "users.json")));
});

test("HEAD on every path of the server answers what GET answers — its status and content type — without the body, by the page and by the commands, read-only or not; nothing changes (issue 754)", async () => {
  for (const o of [{}, { pageReadOnly: true }]) {
    const { ctx, changes, root } = await listening(o);
    const asks: Array<[string, (method: string) => Record<string, string>]> = [
      ["the page", (method) => pageHeaders(ctx.port, method)],
      ["the commands", () => ({ Host: `127.0.0.1:${ctx.port}`, Authorization: `Bearer ${TOKEN}` })],
    ];
    for (const [who, headers] of asks) {
      for (const p of routesOfTheServer()) {
        const get = await call({ port: ctx.port, method: "GET", path: p, headers: headers("GET") });
        const head = await call({ port: ctx.port, method: "HEAD", path: p, headers: headers("HEAD") });
        const at = `${who}: HEAD ${p} (${JSON.stringify(o)})`;
        assert.equal(head.status, get.status, at);
        assert.equal(head.headers["content-type"], get.headers["content-type"], at);
        assert.equal(head.text, "", `${at}: no body`);
      }
      // a GET route answers 200 to a HEAD: the API's, not only the page's files
      for (const p of ["/api/state", "/api/ping", "/api/users"]) assert.equal((await call({ port: ctx.port, method: "HEAD", path: p, headers: headers("HEAD") })).status, 200, `${who}: HEAD ${p}`);
      // a POST-only route is not reached by a HEAD: as a GET, it is no route
      for (const p of ["/api/sync", "/api/cancel", "/api/pick", "/api/remove", "/api/ui/tunnel"]) assert.equal((await call({ port: ctx.port, method: "HEAD", path: p, headers: headers("HEAD") })).status, 404, `${who}: HEAD ${p}`);
    }
    assert.deepEqual(changes, [], "a HEAD changes nothing");
    assert.ok(!fs.existsSync(path.join(root, "users.json")));
  }
});

test("read-only: the commands' requests (the run's token) are served as before — mason sync, mason cancel — the page alone is read-only", async () => {
  const { ctx, changes } = await listening({ pageReadOnly: true });
  const bearer = (method: string) => ({ Host: `127.0.0.1:${ctx.port}`, Authorization: `Bearer ${TOKEN}`, ...(method === "GET" ? {} : { "Content-Type": "application/json" }) });
  const synced = await call({ port: ctx.port, method: "POST", path: "/api/sync", headers: bearer("POST"), body: JSON.stringify({ tables: ["public.orders"] }) });
  assert.equal(synced.status, 200, synced.text);
  const cancelled = await call({ port: ctx.port, method: "POST", path: "/api/cancel", headers: bearer("POST"), body: JSON.stringify({ session: 7 }) });
  assert.equal(cancelled.status, 404, "the listener answered: no session 7");
  assert.deepEqual(changes, ["sync public.orders", "cancel 7"]);
  // a token that is not the run's is the guard's to refuse, as before: never taken for the commands'
  const wrong = await call({ port: ctx.port, method: "POST", path: "/api/sync", headers: { ...bearer("POST"), Authorization: "Bearer nope" }, body: JSON.stringify({ tables: ["public.orders"] }) });
  assert.equal(wrong.status, 403);
  assert.deepEqual(changes, ["sync public.orders", "cancel 7"]);
});

test("read-only through a tunnel (mason ui --ssh, --bridge): the tunnel opens with the run's token, its page views, and every change it sends is refused", async () => {
  const { ctx, changes } = await listening({ pageReadOnly: true });
  const local = 50_123;
  const opened = await call({ port: ctx.port, method: "POST", path: "/api/ui/tunnel", headers: { Host: `127.0.0.1:${ctx.port}`, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ port: local }), hold: true });
  assert.equal(opened.status, 200, opened.text);
  try {
    const ticket = (JSON.parse(opened.text.split("\n")[0]!) as { ticket: string }).ticket;
    const traded = await call({ port: ctx.port, path: `/?ticket=${ticket}`, headers: { Host: `127.0.0.1:${local}` } });
    assert.equal(traded.status, 303);
    const cookie = String(traded.headers["set-cookie"]).split(";")[0]!;
    const through = (method: string) => ({ Host: `127.0.0.1:${local}`, Cookie: cookie, ...(method === "GET" ? {} : { Origin: `http://127.0.0.1:${local}`, "Content-Type": "application/json" }) });
    assert.equal((await call({ port: ctx.port, path: "/api/state", headers: through("GET") })).status, 200, "it views");
    for (const [method, p] of [["POST", "/api/users"], ["DELETE", "/api/users/metabase"], ["POST", "/api/sync"], ["POST", "/api/cancel"], ["POST", "/api/pick"], ["POST", "/api/share"]] as const) {
      const a = await call({ port: ctx.port, method, path: p, headers: through(method), body: JSON.stringify({ name: "grafana", tables: ["public.orders"], session: 4 }) });
      assert.equal(a.status, 403, `${method} ${p}`);
      assert.deepEqual(failureOf(a), REFUSAL, `${method} ${p}`);
    }
    assert.deepEqual(changes, []);
  } finally { opened.req.destroy(); }
});

test("read-only on the Unix socket (MASON_UI_SOCKET): the page's change is refused there as on the port; its view answers", async () => {
  const dir = temp();
  const file = path.join(dir, "ui.sock");
  const { server, ctx, changes } = runServer({ pageReadOnly: true });
  ctx.port = 4039;
  assert.equal(await prepareUiSocket(file, () => undefined), null);
  const sock = await listenOnUiSocket(file, () => undefined);
  assert.ok(!("message" in sock), JSON.stringify(sock));
  sock.attach(server);
  try {
    const a = await call({ socketPath: file, method: "POST", path: "/api/sync", headers: pageHeaders(4039, "POST"), body: JSON.stringify({ tables: ["public.orders"] }) });
    assert.equal(a.status, 403);
    assert.deepEqual(failureOf(a), REFUSAL);
    assert.equal((await call({ socketPath: file, path: "/api/state", headers: pageHeaders(4039, "GET") })).status, 200);
    assert.deepEqual(changes, []);
  } finally { sock.close(); }
});

test("without the setting nothing changes: the page's change is served, and the state says pageReadOnly null", async () => {
  for (const o of [{}, { pageReadOnly: false }]) {
    const { ctx, changes } = await listening(o);
    const a = await call({ port: ctx.port, method: "POST", path: "/api/sync", headers: pageHeaders(ctx.port, "POST"), body: JSON.stringify({ tables: ["public.orders"] }) });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(changes, ["sync public.orders"]);
    assert.equal((JSON.parse((await call({ port: ctx.port, path: "/api/state", headers: pageHeaders(ctx.port, "GET") })).text) as { pageReadOnly: unknown }).pageReadOnly, null);
  }
});

test("MASON_UI_READ_ONLY is mason serve's: 1 or 0, anything else refused on its one report, never read as off; in its --help; mason start refuses it", () => {
  for (const v of [undefined, "", "0"]) assert.equal(uiReadOnlySetting(v === undefined ? {} : { MASON_UI_READ_ONLY: v }), false, String(v));
  assert.equal(uiReadOnlySetting({ MASON_UI_READ_ONLY: "1" }), true);
  const env = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
  for (const v of ["1", "0"]) assert.ok(!("message" in serveSettings({ ...env, MASON_UI_READ_ONLY: v }, "/srv")), v);
  for (const v of ["yes", "true", "2", "-1", "1.5", " 1"]) {
    const s = serveSettings({ ...env, MASON_UI_READ_ONLY: v }, "/srv");
    assert.ok("message" in s, v);
    assert.equal(s.message, `a setting is missing or wrong: MASON_UI_READ_ONLY=${JSON.stringify(v)}: 1 (the web page only shows, and changes nothing) or 0 (the default)`);
  }
  assert.match(SERVE.usage, /\n {4}MASON_UI_READ_ONLY {6}1 when the web page should only show: it offers no control that changes anything, and\n/);

  const dir = temp();
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  const p = { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason", false) } as unknown as Parameters<typeof startSettingRefusal>[0];
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_READ_ONLY: "1" }, { serve: false }),
    { message: "MASON_UI_READ_ONLY is mason serve's setting, and mason start ignores no setting silently", code: "refused", fix: "unset MASON_UI_READ_ONLY: mason start's page is yours alone, on this machine" });
  assert.equal(startSettingRefusal(p, { MASON_UI_READ_ONLY: "1" }, { serve: true }), null, "mason serve's run takes it");
  assert.equal(startSettingRefusal(p, { MASON_UI_READ_ONLY: "0" }, { serve: false }), null);
  // junk refuses the run itself too, whichever start reached it: the run never reads it as off
  for (const serve of [true, false]) {
    assert.deepEqual(startSettingRefusal(p, { MASON_UI_READ_ONLY: "on" }, { serve }),
      { message: "MASON_UI_READ_ONLY=\"on\": 1 (the web page only shows, and changes nothing) or 0 (the default)", code: "refused", fix: "set MASON_UI_READ_ONLY=1 or MASON_UI_READ_ONLY=0, or unset it" });
  }
});

// ------------------------------------------------------------------ MASON_UI_READ_ONLY_ALLOW=tables (issue 789)

const uiReadOnlyAllowSetting = readOnlyModule.uiReadOnlyAllowSetting ?? missing;
/** The answer to a change outside the tables on a read-only page that still edits its tables. */
const TABLES_REFUSAL = {
  code: "refused", message: "the web page is read-only here (MASON_UI_READ_ONLY=1): it shows what Mason syncs, and changes nothing but its tables",
  why: "Mason was started with MASON_UI_READ_ONLY=1 and MASON_UI_READ_ONLY_ALLOW=tables, so the page refuses every change but adding, removing and syncing tables",
  fix: "make the change with the mason command where Mason runs, or ask whoever runs it", next: [],
};
/** The Tables page's changes: Add, Columns… and Name its key… (pick), Remove, Sync now — and nothing else. */
const TABLE_ROUTES = new Set(["POST /api/pick", "POST /api/remove", "POST /api/sync"]);

test("read-only with MASON_UI_READ_ONLY_ALLOW=tables: of every method to every path of the server, exactly the Tables page's changes are served; every other is refused 403 saying what is still allowed, and changes nothing", async () => {
  const { ctx, changes, root } = await listening({ pageReadOnly: true, pageReadOnlyAllow: ["tables"] });
  const body = JSON.stringify({ name: "grafana", tables: ["public.orders"], table: "public.orders", picked: true, session: 4, port: 50_000, from: "page", confirmed: true });
  let served = 0;
  for (const p of routesOfTheServer()) {
    for (const method of WRITES) {
      const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body });
      if (TABLE_ROUTES.has(`${method} ${p}`)) {
        served++;
        assert.notEqual(a.status, 403, `${method} ${p}: ${a.text}`);
        assert.notDeepEqual(failureOf(a), TABLES_REFUSAL, `${method} ${p}`);
      } else {
        assert.equal(a.status, 403, `${method} ${p}`);
        assert.deepEqual(failureOf(a), TABLES_REFUSAL, `${method} ${p}`);
      }
    }
  }
  assert.equal(served, 3, "the three routes are among the server's");
  // the users (a change of the addresses one connects from too), a cancel, a share: refused whatever the body, as before
  for (const [method, p, b] of [["POST", "/api/users", { name: "grafana" }], ["DELETE", "/api/users/metabase", {}], ["POST", "/api/users/metabase/disable", {}],
    ["POST", "/api/users/metabase/enable", {}], ["POST", "/api/users/metabase/from", { from: null }], ["POST", "/api/users/metabase/from", { from: ["192.0.2.0/24"] }], ["POST", "/api/cancel", { session: 4, statement: 9 }], ["POST", "/api/share", {}], ["POST", "/api/ui/tunnel", { port: 50_000 }]] as const) {
    const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body: JSON.stringify(b) });
    assert.equal(a.status, 403, `${method} ${p}`);
    assert.deepEqual(failureOf(a), TABLES_REFUSAL, `${method} ${p}`);
  }
  // EXACTLY the route, as the router reads it: a neighbour of an allowed path, another method on it, a route added later
  for (const [method, p] of [["POST", "/api/pick/"], ["POST", "/api/pick/x"], ["POST", "//api/pick"], ["POST", "/api/PICK"], ["POST", "/api/%70ick"], ["POST", "/api/sync/x"],
    ["PUT", "/api/pick"], ["PATCH", "/api/remove"], ["DELETE", "/api/sync"], ["OPTIONS", "/api/sync"], ["POST", "/api/tables/public.orders/columns"], ["POST", "/api/a-route-added-later"]] as const) {
    const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body });
    assert.equal(a.status, 403, `${method} ${p}`);
    assert.deepEqual(failureOf(a), TABLES_REFUSAL, `${method} ${p}`);
  }
  assert.ok(!changes.some((c) => c.startsWith("cancel")), "no cancel");
  assert.ok(!fs.existsSync(path.join(root, "users.json")), "no user written");
  // the Sync now the page sent was served
  assert.ok(changes.includes("sync public.orders"), changes.join(", "));
  const state = JSON.parse((await call({ port: ctx.port, path: "/api/state", headers: pageHeaders(ctx.port, "GET") })).text) as { pageReadOnly: unknown; pageReadOnlyAllow: unknown };
  assert.deepEqual([state.pageReadOnly, state.pageReadOnlyAllow], ["the web page is read-only here (MASON_UI_READ_ONLY=1)", ["tables"]]);
});

test("the state's pageReadOnlyAllow: [tables] on a read-only page that allows them, [] on one that does not, and [] on a page that is not read-only whatever the run was handed", async () => {
  const cases: Array<[{ pageReadOnly?: boolean; pageReadOnlyAllow?: string[] }, string[]]> = [
    [{ pageReadOnly: true, pageReadOnlyAllow: ["tables"] }, ["tables"]], [{ pageReadOnly: true }, []], [{ pageReadOnly: true, pageReadOnlyAllow: [] }, []],
    [{ pageReadOnlyAllow: ["tables"] }, []], [{}, []]];
  for (const [o, allow] of cases) {
    const { ctx } = await listening(o);
    const state = JSON.parse((await call({ port: ctx.port, path: "/api/state", headers: pageHeaders(ctx.port, "GET") })).text) as { pageReadOnlyAllow: unknown };
    assert.deepEqual(state.pageReadOnlyAllow, allow, JSON.stringify(o));
  }
  // read-only with nothing allowed: the refusal is as before, word for word
  const { ctx } = await listening({ pageReadOnly: true, pageReadOnlyAllow: [] });
  assert.deepEqual(failureOf(await call({ port: ctx.port, method: "POST", path: "/api/sync", headers: pageHeaders(ctx.port, "POST"), body: JSON.stringify({ tables: ["public.orders"] }) })), REFUSAL);
});

test("MASON_UI_READ_ONLY_ALLOW is mason serve's: tables, users or both (in either order) beside MASON_UI_READ_ONLY=1, unset or empty nothing; anything else, or set beside no read-only page, refused on its one report with a did you mean and never the value quoted; in its --help; mason start refuses it", () => {
  for (const v of [undefined, ""]) assert.deepEqual(uiReadOnlyAllowSetting({ MASON_UI_READ_ONLY: "1", ...(v === undefined ? {} : { MASON_UI_READ_ONLY_ALLOW: v }) }), [], String(v));
  for (const [v, areas] of [["tables", ["tables"]], ["users", ["users"]], ["tables,users", ["tables", "users"]], ["users,tables", ["tables", "users"]]] as const) {
    assert.deepEqual(uiReadOnlyAllowSetting({ MASON_UI_READ_ONLY: "1", MASON_UI_READ_ONLY_ALLOW: v }), areas, v);
  }
  assert.deepEqual(uiReadOnlyAllowSetting({}), [], "unset beside no read-only page: nothing");
  const env = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
  for (const v of ["tables", "users", "tables,users", "users,tables"]) assert.ok(!("message" in serveSettings({ ...env, MASON_UI_READ_ONLY: "1", MASON_UI_READ_ONLY_ALLOW: v }, "/srv")), v);
  const takes = "it takes tables (a read-only page still allows adding, removing and syncing tables), users (adding, disabling, enabling and removing users and changing the addresses they connect from), or both as tables,users; or unset";
  const wrong: Array<[string, string]> = [
    ["table", "its value is not an area — did you mean `tables`?"], ["Tables", "its value is not an area — did you mean `tables`?"],
    [" tables", "its value is not an area — did you mean `tables`?"], ["user", "its value is not an area — did you mean `users`?"],
    ["tables, users", "its item 2 of 2 is not an area — did you mean `users`?"], ["tables,usres", "its item 2 of 2 is not an area — did you mean `users`?"],
    ["tables,", "its item 2 of 2 is empty"], [",users", "its item 1 of 2 is empty"], ["tables,,users", "its item 2 of 3 is empty"],
    ["users,users", "it names users twice"], ["tables,users,tables", "it names tables twice"],
    ["*", "its value is not an area"], ["1", "its value is not an area"], ["tables,s3cr3t-v4lue", "its item 2 of 2 is not an area"], ["s3cr3t-v4lue", "its value is not an area"],
  ];
  for (const [v, said] of wrong) {
    // what is wrong, what it takes, then the area it is closest to — the guess last, never between the two ("?;")
    const [what, mean] = said.split(" — ");
    const problem = `MASON_UI_READ_ONLY_ALLOW: ${what}; ${takes}${mean === undefined ? "" : ` — ${mean}`}`;
    assert.ok(!problem.includes("?;"), v);
    assert.deepEqual(uiReadOnlyAllowSetting({ MASON_UI_READ_ONLY: "1", MASON_UI_READ_ONLY_ALLOW: v }), { problem }, v);
    const s = serveSettings({ ...env, MASON_UI_READ_ONLY: "1", MASON_UI_READ_ONLY_ALLOW: v }, "/srv");
    assert.ok("message" in s, v);
    assert.equal(s.message, `a setting is missing or wrong: ${problem}`);
    // never quoted beyond the area it recognised: a value that is not one is not repeated
    assert.ok(!problem.includes("s3cr3t"), v);
  }
  // beside no read-only page it is refused: the operator meant a read-only page, and would get a page that changes anything
  const alone = (areas: string) => `MASON_UI_READ_ONLY_ALLOW=${areas} is set without MASON_UI_READ_ONLY=1: it says what a read-only page still allows, and this page is not read-only (set MASON_UI_READ_ONLY=1, or unset MASON_UI_READ_ONLY_ALLOW)`;
  for (const ro of [undefined, "", "0"]) {
    for (const [v, areas] of [["tables", "tables"], ["users", "users"], ["users,tables", "tables,users"]] as const) {
      const set = { ...(ro === undefined ? {} : { MASON_UI_READ_ONLY: ro }), MASON_UI_READ_ONLY_ALLOW: v };
      assert.deepEqual(uiReadOnlyAllowSetting(set), { problem: alone(areas) }, `${ro} ${v}`);
      const s = serveSettings({ ...env, ...set }, "/srv");
      assert.ok("message" in s);
      assert.equal(s.message, `a setting is missing or wrong: ${alone(areas)}`);
    }
  }
  // a junk MASON_UI_READ_ONLY is said once, as its own problem
  const junk = serveSettings({ ...env, MASON_UI_READ_ONLY: "yes", MASON_UI_READ_ONLY_ALLOW: "tables" }, "/srv");
  assert.ok("message" in junk);
  assert.equal(junk.message, `a setting is missing or wrong: MASON_UI_READ_ONLY="yes": 1 (the web page only shows, and changes nothing) or 0 (the default)`);
  assert.match(SERVE.usage, /\n {4}MASON_UI_READ_ONLY_ALLOW {2}tables: a read-only page still adds, removes and syncs tables on its Tables page \(Add,\n/);
  // the help names each area's exact routes, as docs/WEB-UI.md does
  const help = SERVE.usage.replace(/\s+/g, " ");
  assert.ok(help.includes("users: it still adds, disables, enables and removes users and changes the addresses they connect from on its Users page (POST /api/users, POST /api/users/<name>/disable, /enable and /from, DELETE /api/users/<name>); tables,users both."), help);

  const dir = temp();
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  const p = { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason", false) } as unknown as Parameters<typeof startSettingRefusal>[0];
  for (const v of ["tables", "users", "tables,users"]) {
    assert.deepEqual(startSettingRefusal(p, { MASON_UI_READ_ONLY_ALLOW: v }, { serve: false }),
      { message: "MASON_UI_READ_ONLY_ALLOW is mason serve's setting, and mason start ignores no setting silently", code: "refused", fix: "unset MASON_UI_READ_ONLY_ALLOW: mason start's page is yours alone, on this machine" }, v);
    assert.equal(startSettingRefusal(p, { MASON_UI_READ_ONLY: "1", MASON_UI_READ_ONLY_ALLOW: v }, { serve: true }), null, `mason serve's run takes ${v}`);
  }
  // the run refuses it too: never read as nothing allowed, nor as a page that is not read-only
  const fix = "set MASON_UI_READ_ONLY_ALLOW to tables, users or tables,users beside MASON_UI_READ_ONLY=1, or unset it";
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_READ_ONLY: "1", MASON_UI_READ_ONLY_ALLOW: "tables,usres" }, { serve: true }),
    { message: `MASON_UI_READ_ONLY_ALLOW: its item 2 of 2 is not an area; ${takes} — did you mean \`users\`?`, code: "refused", fix });
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_READ_ONLY_ALLOW: "tables" }, { serve: true }), { message: alone("tables"), code: "refused", fix });
});

// ------------------------------------------------------------------ MASON_UI_READ_ONLY_ALLOW=users, tables,users (issue 813)

/** The answer to a change outside the users on a read-only page that still manages its users. */
const USERS_REFUSAL = {
  code: "refused", message: "the web page is read-only here (MASON_UI_READ_ONLY=1): it shows what Mason syncs, and changes nothing but its users",
  why: "Mason was started with MASON_UI_READ_ONLY=1 and MASON_UI_READ_ONLY_ALLOW=users, so the page refuses every change but adding, disabling, enabling and removing users and changing the addresses they connect from",
  fix: "make the change with the mason command where Mason runs, or ask whoever runs it", next: [],
};
/** The answer to a change outside both on a read-only page that still changes its tables and its users. */
const BOTH_REFUSAL = {
  code: "refused", message: "the web page is read-only here (MASON_UI_READ_ONLY=1): it shows what Mason syncs, and changes nothing but its tables and users",
  why: "Mason was started with MASON_UI_READ_ONLY=1 and MASON_UI_READ_ONLY_ALLOW=tables,users, so the page refuses every change but adding, removing and syncing tables and adding, disabling, enabling and removing users and changing the addresses they connect from",
  fix: "make the change with the mason command where Mason runs, or ask whoever runs it", next: [],
};
/** The Users page's changes: Add a user, Disable, Enable, From…, Remove — `x` the name the server's patterns are filled with. */
const USER_ROUTES = new Set(["POST /api/users", "POST /api/users/x/disable", "POST /api/users/x/enable", "POST /api/users/x/from", "DELETE /api/users/x"]);

/** Every method to every path of the server: the allowed routes served (never the refusal), every other refused 403 as `refusal`. */
async function sweep(port: number, allowed: ReadonlySet<string>, refusal: unknown): Promise<number> {
  const body = JSON.stringify({ name: "grafana", tables: ["public.orders"], table: "public.orders", picked: true, session: 4, port: 50_000, from: "page", confirmed: true });
  let served = 0;
  for (const p of routesOfTheServer()) {
    for (const method of WRITES) {
      const a = await call({ port, method, path: p, headers: pageHeaders(port, method), body });
      if (allowed.has(`${method} ${p}`)) {
        served++;
        assert.notEqual(a.status, 403, `${method} ${p}: ${a.text}`);
        assert.notDeepEqual(failureOf(a), refusal, `${method} ${p}`);
      } else {
        assert.equal(a.status, 403, `${method} ${p}`);
        assert.deepEqual(failureOf(a), refusal, `${method} ${p}`);
      }
    }
  }
  return served;
}

/** Paths beside a user's route that the router does not route to it, each refused on a page that allows the users. */
const USER_NEIGHBOURS = [["DELETE", "/api/users"], ["DELETE", "/api/users/"], ["DELETE", "/api/users/a/b"], ["DELETE", "/api/users/metabase/disable"], ["POST", "/api/users/"],
  ["POST", "/api/users//disable"], ["POST", "/api/users/metabase/disable/"], ["POST", "/api/users/metabase/DISABLE"], ["POST", "/api/users/metabase/remove"],
  ["POST", "/api/users/a/b/from"], ["POST", "/api/usersx"], ["POST", "/api/users/metabase"], ["PUT", "/api/users/metabase"], ["PATCH", "/api/users/metabase/from"],
  ["DELETE", "/api/users/metabase/from"], ["OPTIONS", "/api/users"], ["POST", "//api/users"], ["POST", "/api/USERS"], ["POST", "/api/share/metabase"]] as const;

test("the users' routes a read-only page may allow are exactly the server's user routes: each of AREA_ROUTES is a route of the server, and every route of the server under /api/users that changes something is one of them", () => {
  const AREA_ROUTES = readOnlyModule.AREA_ROUTES ?? missing();
  const routes = routesOfTheServer();
  const filled = (p: string) => p.replace("<name>", "x");
  for (const [method, p] of [...AREA_ROUTES.tables, ...AREA_ROUTES.users]) assert.ok(routes.includes(filled(p)), `${method} ${p}`);
  assert.deepEqual(new Set(AREA_ROUTES.users.map(([m, p]) => `${m} ${filled(p)}`)), USER_ROUTES);
  // the router's own patterns for the users, read from its source: one segment each, never a prefix
  const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "run-server.ts"), "utf8");
  assert.ok(!/url\.pathname\.startsWith\("\/api\/users/.test(text), "no user route is a prefix");
  assert.match(text, /method === "DELETE" && \/\^\\\/api\\\/users\\\/\[\^\/\]\+\$\/\.test\(url\.pathname\)/, "Remove is one segment, as the allowance reads it");
});

test("read-only with MASON_UI_READ_ONLY_ALLOW=users: of every method to every path of the server, exactly the Users page's changes are served; every other — a table's Add, Remove or Sync now included — is refused 403 saying what is still allowed, and changes nothing", async () => {
  const { ctx, changes } = await listening({ pageReadOnly: true, pageReadOnlyAllow: ["users"] });
  assert.equal(await sweep(ctx.port, USER_ROUTES, USERS_REFUSAL), USER_ROUTES.size, "the five routes are among the server's");
  // a table's change, a cancel, a share: refused whatever the body
  for (const [method, p, b] of [["POST", "/api/pick", { table: "public.orders", picked: true }], ["POST", "/api/remove", { tables: ["public.orders"] }], ["POST", "/api/sync", { tables: ["public.orders"] }],
    ["POST", "/api/cancel", { session: 4, statement: 9 }], ["POST", "/api/share", {}], ["POST", "/api/ui/tunnel", { port: 50_000 }]] as const) {
    const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body: JSON.stringify(b) });
    assert.equal(a.status, 403, `${method} ${p}`);
    assert.deepEqual(failureOf(a), USERS_REFUSAL, `${method} ${p}`);
  }
  // EXACTLY the route, as the router reads it: a neighbour of an allowed path, another method on it, another segment
  for (const [method, p] of USER_NEIGHBOURS) {
    const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body: "{}" });
    assert.equal(a.status, 403, `${method} ${p}`);
    assert.deepEqual(failureOf(a), USERS_REFUSAL, `${method} ${p}`);
  }
  assert.deepEqual(changes, [], "no sync, no cancel, no sources file told");
  const state = JSON.parse((await call({ port: ctx.port, path: "/api/state", headers: pageHeaders(ctx.port, "GET") })).text) as { pageReadOnly: unknown; pageReadOnlyAllow: unknown };
  assert.deepEqual([state.pageReadOnly, state.pageReadOnlyAllow], ["the web page is read-only here (MASON_UI_READ_ONLY=1)", ["users"]]);
});

test("read-only with MASON_UI_READ_ONLY_ALLOW=users: the page adds a user with its ranges, changes them, disables, enables and removes it, as mason user does; a range the run cannot read is its refusal", async () => {
  const { ctx, root } = await listening({ pageReadOnly: true, pageReadOnlyAllow: ["users"] });
  const page = (method: string, p: string, b: unknown) => call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body: JSON.stringify(b) });
  const users = () => JSON.parse(fs.readFileSync(path.join(root, "users.json"), "utf8")) as { users: Array<{ name: string; from?: string[]; disabledAt?: string; removedAt?: string }> };
  const added = await page("POST", "/api/users", { name: "grafana", from: ["192.0.2.0/24", "2001:db8::/32"] });
  assert.equal(added.status, 200, added.text);
  assert.deepEqual(users().users.find((u) => u.name === "grafana")?.from, ["192.0.2.0/24", "2001:db8::/32"]);
  // a range the run cannot read: refused by the run, in its words (src/cli/user.ts rangesToSet), nothing written
  const bad = await page("POST", "/api/users", { name: "looker", from: ["192.0.2.0/33"] });
  assert.equal(bad.status, 400, bad.text);
  assert.match((failureOf(bad) as { message: string }).message, /^mason user add looker: /);
  assert.ok(!users().users.some((u) => u.name === "looker"));
  assert.equal((await page("POST", "/api/users/grafana/from", { from: ["198.51.100.0/24"] })).status, 200);
  assert.deepEqual(users().users.find((u) => u.name === "grafana")?.from, ["198.51.100.0/24"]);
  assert.equal((await page("POST", "/api/users/grafana/from", { from: null })).status, 200);
  assert.equal(users().users.find((u) => u.name === "grafana")?.from, undefined, "from anywhere again");
  assert.equal((await page("POST", "/api/users/grafana/disable", {})).status, 200);
  assert.ok(users().users.find((u) => u.name === "grafana")?.disabledAt);
  assert.equal((await page("POST", "/api/users/grafana/enable", {})).status, 200);
  assert.equal((await page("DELETE", "/api/users/grafana", {})).status, 200);
  assert.ok(users().users.find((u) => u.name === "grafana")?.removedAt);
});

test("read-only with MASON_UI_READ_ONLY_ALLOW=tables,users: of every method to every path of the server, exactly the Tables and the Users pages' changes are served; every other is refused 403 naming both", async () => {
  const { ctx, changes } = await listening({ pageReadOnly: true, pageReadOnlyAllow: ["tables", "users"] });
  const both = new Set([...TABLE_ROUTES, ...USER_ROUTES]);
  assert.equal(await sweep(ctx.port, both, BOTH_REFUSAL), both.size);
  for (const [method, p] of [...USER_NEIGHBOURS, ["POST", "/api/pick/x"], ["PUT", "/api/pick"], ["POST", "/api/cancel"], ["POST", "/api/a-route-added-later"]] as const) {
    const a = await call({ port: ctx.port, method, path: p, headers: pageHeaders(ctx.port, method), body: "{}" });
    assert.equal(a.status, 403, `${method} ${p}`);
    assert.deepEqual(failureOf(a), BOTH_REFUSAL, `${method} ${p}`);
  }
  assert.ok(!changes.some((c) => c.startsWith("cancel")), "no cancel");
  assert.ok(changes.includes("sync public.orders"), changes.join(", "));
});

test("the run's DELETE of a user takes one segment, as the allowance reads it: /api/users/a/b is no route, read-only or not", async () => {
  for (const o of [{}, { pageReadOnly: true, pageReadOnlyAllow: ["users"] }]) {
    const { ctx } = await listening(o);
    const a = await call({ port: ctx.port, method: "DELETE", path: "/api/users/a/b", headers: pageHeaders(ctx.port, "DELETE") });
    assert.equal(a.status, o.pageReadOnly ? 403 : 404, `${JSON.stringify(o)}: ${a.text}`);
  }
});

test("the state's pageReadOnlyAllow lists the areas: [users], [tables, users] on a read-only page that allows them", async () => {
  for (const allow of [["users"], ["tables", "users"]]) {
    const { ctx } = await listening({ pageReadOnly: true, pageReadOnlyAllow: allow });
    const state = JSON.parse((await call({ port: ctx.port, path: "/api/state", headers: pageHeaders(ctx.port, "GET") })).text) as { pageReadOnlyAllow: unknown };
    assert.deepEqual(state.pageReadOnlyAllow, allow);
  }
});
