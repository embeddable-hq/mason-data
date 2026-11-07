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
function runServer(o: { pageReadOnly?: boolean } = {}): { server: http.Server; ctx: RunContext; changes: string[]; root: string } {
  const root = temp();
  const changes: string[] = [];
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    port: 0, token: TOKEN, page: true, served: true, ...(o.pageReadOnly === undefined ? {} : { pageReadOnly: o.pageReadOnly }),
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

async function listening(o: { pageReadOnly?: boolean } = {}): Promise<ReturnType<typeof runServer>> {
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
