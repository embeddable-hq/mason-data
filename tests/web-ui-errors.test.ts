/**
 * THE WEB PAGE TELLS THE RUN OF ITS OWN ERRORS (issue 923; src/web/app.js `reportErrors`, `errorReport`;
 * src/cli/ui-errors.ts): an uncaught error or an unhandled rejection in the page's code is sent as `{ view, file, line,
 * column, name }` — never its message or its stack, which can quote synced data — and the run records ONE `ui_error`
 * event, a failure.
 *
 * The reporter's own rules run under node, over a fake window (what it sends, at most ERROR_REPORTS_MAX a load, never
 * throwing, installed once). The page itself runs in a real browser, served by the run's own server (its guard, its
 * files, its `/api/ui/error`) over a real events table: this part runs where Playwright and its Chromium are installed
 * (`require("playwright")`), and says it did not run elsewhere (tests/web-tables-layout.test.ts is the same harness).
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import { DuckStore } from "../src/duck/store.ts";
import { SyncEvents } from "../src/duck/events.ts";

// imported when the tests run: at a commit without them this file still loads, and each test fails by name
type Reporter = {
  errorReport: (view: string, error: unknown, filename: unknown, line: unknown, column: unknown, base?: string) => Record<string, unknown>;
  reportErrors: (win: unknown, viewOf: () => string, post: (body: unknown) => unknown, base?: string) => void;
  ERROR_REPORTS_MAX: number;
};
const app = await import("../src/web/app.js" as string) as Partial<Reporter>;
const reporter = (): Reporter => (typeof app.reportErrors === "function" ? app as Reporter : assert.fail("src/web/app.js: the page reports none of its errors at this commit"));
type UiErrorsModule = typeof import("../src/cli/ui-errors.ts");
// a commit without the module: none, and the test says so by name (a failure to load for another reason is thrown)
const uiMod = await import("../src/cli/ui-errors.ts" as string).catch((e: NodeJS.ErrnoException) => { if (e.code === "ERR_MODULE_NOT_FOUND") return null; throw e; }) as UiErrorsModule | null;

const BASE = "http://127.0.0.1:4000/ui/";
const SECRET = "secret_customer_alice";

test("what the page sends of an error: the view, its own script, line, column and class — never the message or the stack, nor a URL", () => {
  const { errorReport } = reporter();
  const e = new TypeError(`Cannot read properties of null (reading '${SECRET}')`);
  e.stack = `TypeError: ${SECRET}\n    at render (${BASE}pages/tables.js:41:9)\n    at ${BASE}app.js:500:3`;
  const r = errorReport("tables", e, `${BASE}pages/tables.js`, 41, 9, BASE);
  assert.deepEqual(r, { view: "tables", file: "pages/tables.js", line: 41, column: 9, name: "TypeError" });
  assert.deepEqual(Object.keys(r).sort(), ["column", "file", "line", "name", "view"]);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  // an unhandled rejection has no place of its own: read from the stack's first frame in the page's scripts, here
  assert.deepEqual(errorReport("overview", e, null, null, null, BASE), { view: "overview", file: "pages/tables.js", line: 41, column: 9, name: "TypeError" });
  // a script that is not the page's (another origin, an extension, an evaluated script): no file, no place
  assert.deepEqual(errorReport("overview", e, "chrome-extension://abc/x.js", 3, 4, `${BASE}nothing/`), { view: "overview", file: null, line: null, column: null, name: "TypeError" });
  // what was thrown was not an error, or its class is no name: null, never its text
  assert.deepEqual(errorReport("users", SECRET, null, null, null, BASE), { view: "users", file: null, line: null, column: null, name: null });
  const odd = new Error("x"); odd.name = `${SECRET} is gone`;
  assert.equal(errorReport("users", odd, null, null, null, BASE).name, null);
  // a getter that throws is no error of the reporter's
  const hostile = { get name(): string { throw new Error("no"); }, get stack(): string { throw new Error("no"); } };
  assert.deepEqual(errorReport("users", hostile, null, null, null, BASE), { view: "users", file: null, line: null, column: null, name: null });
});

test("the reporter: installed once per window, at most ERROR_REPORTS_MAX a load, and it never throws or reports itself — a post that throws or rejects included", async () => {
  const { reportErrors, ERROR_REPORTS_MAX } = reporter();
  const on = new Map<string, Array<(e: unknown) => void>>();
  const win = { addEventListener: (type: string, f: (e: unknown) => void) => { on.set(type, [...(on.get(type) ?? []), f]); } };
  const sent: unknown[] = [];
  reportErrors(win, () => "observability/syncs", (b) => { sent.push(b); return Promise.reject(new Error("the run stopped")); }, BASE);
  reportErrors(win, () => "observability/syncs", (b) => { sent.push(b); }, BASE);
  assert.deepEqual([on.get("error")?.length, on.get("unhandledrejection")?.length], [1, 1], "one listener each, however often it is installed");
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a[0]); };
  try {
    on.get("error")![0]!({ error: new RangeError(SECRET), filename: `${BASE}app.js`, lineno: 7, colno: 2, message: SECRET });
    on.get("unhandledrejection")![0]!({ reason: SECRET });
    for (let i = 0; i < ERROR_REPORTS_MAX + 30; i++) on.get("error")![0]!({ error: new Error(SECRET) });
    await new Promise((r) => setTimeout(r, 10));
  } finally { console.warn = warn; }
  assert.equal(sent.length, ERROR_REPORTS_MAX, "a page throwing in a loop sends no more than the cap");
  assert.deepEqual(sent.slice(0, 2), [
    { view: "observability/syncs", file: "app.js", line: 7, column: 2, name: "RangeError" },
    { view: "observability/syncs", file: null, line: null, column: null, name: null },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(SECRET));
  assert.deepEqual(warned, ["the page could not tell the run of its error"], "a report the run did not take: said once in the console");
  // a post that throws, a view that cannot be told: still no throw
  const win2 = { addEventListener: (type: string, f: (e: unknown) => void) => { on.set(`2${type}`, [f]); } };
  reportErrors(win2, () => { throw new Error("no view"); }, () => { throw new Error("no fetch"); }, BASE);
  assert.doesNotThrow(() => on.get("2error")![0]!({ error: new Error("x") }));
});

// ------------------------------------------------------------------ in a real browser, against the run's own server

type Request = { url(): string; method(): string; postData(): string | null };
type Page = { goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; evaluate<T = unknown>(expression: string): Promise<T>;
  on(event: "request", f: (r: Request) => void): void; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(o: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
const noBrowser = playwright === null ? "Playwright is not installed here (require('playwright')): the page needs a browser to throw in" : false;

test("a page that throws in its own code: exactly ONE ui_error event, from a report of only the five fields", { skip: noBrowser }, async () => {
  assert.ok(uiMod !== null, "src/cli/ui-errors.ts: no record of the web page's errors at this commit");
  reporter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-ui-errors-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  const events = await SyncEvents.open(store, () => undefined, { days: 7, flushMs: 20 });
  const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
  const tables: SourceTable[] = [{ source: "public.customers", schema: "public", table: "customers", key: ["id"], rows: 3, bytes: 8192, comment: null,
    columns: [col("id", "bigint"), col("name")], foreignKeys: [] } as unknown as SourceTable];
  const parsed = parseSource("postgres://shop@localhost:5432/shop");
  const file = parseSourceText("kind: postgres\nurl: x\ntables: {}\n", "shop", "/app/mason/sources/shop.yml");
  const ctx = {
    source: "source" in parsed ? parsed.source : assert.fail(), facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables, systemIdentifier: null }), warnings: [],
    replication: () => null, page: true, port: 0, token: "t0ken-of-this-run", log: () => undefined,
    users: { file: path.join(dir, "users.json"), apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.now(),
    sources: () => ({ file, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: path.join(dir, "duck.db"), copies: () => [], stream: async () => null, requests: { days: 7 }, restarts: () => [], events,
      disk: () => ({ path: dir, freeBytes: null, projectedBytes: null }) },
    uiErrors: new uiMod.UiErrors((e) => events.record(e), () => undefined),
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  const browser = await playwright!.chromium.launch();
  after(async () => { await browser.close(); server.close(); await events.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const bodies: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/ui/error")) bodies.push(r.postData() ?? ""); });
  // the run's token in the URL once, traded for its cookie (src/cli/security.ts), as mason ui opens the page
  await page.goto(`http://127.0.0.1:${ctx.port}/?token=t0ken-of-this-run#tables`);
  await page.waitForSelector("#nav a");
  await page.waitForTimeout(500);
  assert.deepEqual(bodies, [], "the page as it loads throws nothing");

  // an uncaught error thrown in the page's own script (src/web/shared.js renderFailure reads a property of null)
  // the page's own module, by its address under the page (written so, it names no file of this folder)
  const SHARED = "./shared.js";
  await page.evaluate(`import("${SHARED}").then((m) => { setTimeout(() => m.renderFailure(null), 0); return null; })`);
  for (let i = 0; i < 50 && bodies.length === 0; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(300);
  await events.flush();
  assert.equal(bodies.length, 1, bodies.join("\n"));
  const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["column", "file", "line", "name", "view"], "only the five fields");
  assert.equal(sent.view, "tables");
  assert.equal(sent.file, "shared.js");
  assert.equal(sent.name, "TypeError");
  assert.ok(Number.isInteger(sent.line) && Number.isInteger(sent.column));
  const failed = await events.recent({ limit: 10, failed: true });
  assert.deepEqual(failed.map((e) => [e.kind, e.table]), [["ui_error", null]], "exactly one ui_error event");
  assert.equal(failed[0]!.message.split("\n")[0], `the web page hit a TypeError on its tables view in shared.js at line ${sent.line}, column ${sent.column}`);

  // an error whose words quote the page's text, thrown outside the page's scripts, and an unhandled rejection: sent
  // without a word of either
  await page.evaluate(`setTimeout(() => { throw new TypeError("${SECRET}"); }, 0); Promise.reject(new RangeError("${SECRET}")); null`);
  for (let i = 0; i < 50 && bodies.length < 3; i++) await page.waitForTimeout(50);
  assert.equal(bodies.length, 3, bodies.join("\n"));
  for (const b of bodies) {
    assert.doesNotMatch(b, new RegExp(SECRET), "never the error's words");
    assert.deepEqual(Object.keys(JSON.parse(b) as object).sort(), ["column", "file", "line", "name", "view"]);
  }
  await events.flush();
  assert.doesNotMatch(JSON.stringify(await events.recent({ limit: 10 })), new RegExp(SECRET));
  await page.close();
});
