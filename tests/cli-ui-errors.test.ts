/**
 * THE WEB PAGE'S OWN ERRORS AT THE RUN (`POST /api/ui/error`, src/cli/ui-errors.ts, issue 923), over real HTTP behind
 * the run's guard: a report is `{ view, file, line, column, name }` and nothing else — never the error's message or
 * stack, which can quote synced data — each field checked and bounded, refused whole when anything is off; it becomes
 * ONE `ui_error` event whose message the run writes from those fields alone; a page throwing in a loop is held to
 * UI_ERRORS_PER_MINUTE events a minute, the rest refused with 429 and counted for `/metrics`.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";

// imported when the tests run: at a commit without the module this file still loads, and each test fails by name
type UiErrorsModule = typeof import("../src/cli/ui-errors.ts");
// a commit without the module: none, and each test says so by name (a failure to load for another reason is thrown)
const mod = await import("../src/cli/ui-errors.ts" as string).catch((e: NodeJS.ErrnoException) => { if (e.code === "ERR_MODULE_NOT_FOUND") return null; throw e; }) as UiErrorsModule | null;
const need = (): UiErrorsModule => mod ?? assert.fail("src/cli/ui-errors.ts: no record of the web page's errors at this commit");

const TOKEN = "t0ken-of-this-run";
const recorded: Array<{ kind: string; table: string | null; message: string }> = [];
const logged: string[] = [];
let clock = Date.parse("2026-11-13T09:00:00.000Z");
const uiErrors = mod === null ? undefined : new mod.UiErrors((e) => recorded.push(e), (l) => logged.push(l), () => clock);
// the route reads nothing of the run but its record of the page's errors: the rest of the context is never touched
const ctx = { page: false, port: 0, token: TOKEN, log: (m: string) => logged.push(m), ...(uiErrors === undefined ? {} : { uiErrors }) } as unknown as RunContext;
const server = createRunServer(ctx);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
ctx.port = (server.address() as { port: number }).port;
after(() => { server.close(); });

/** A POST from the page: its cookie, its Origin (a raw body when `raw`). */
function post(body: unknown, o: { raw?: string; cookie?: string | null; origin?: string | null } = {}): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${ctx.port}`, "Content-Type": "application/json" };
    const cookie = o.cookie === undefined ? `mason_dev_${ctx.port}=${TOKEN}` : o.cookie;
    if (cookie !== null) headers.Cookie = cookie;
    const origin = o.origin === undefined ? `http://127.0.0.1:${ctx.port}` : o.origin;
    if (origin !== null) headers.Origin = origin;
    const req = http.request({ host: "127.0.0.1", port: ctx.port, method: "POST", path: "/api/ui/error", headers }, (res) => {
      let text = "";
      res.on("data", (b: Buffer) => { text += b.toString(); });
      res.on("end", () => { let json: Record<string, unknown> | null = null; try { json = JSON.parse(text) as Record<string, unknown>; } catch (e) { void e; /* a guard's refusal is plain text */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    // a body over the cap: the server stops reading and closes the connection, which is the refusal (status 0 here)
    req.on("error", () => resolve({ status: 0, json: null }));
    req.end(o.raw ?? JSON.stringify(body));
  });
}
const failure = (r: { json: Record<string, unknown> | null }): string => String((r.json?.failure as { message?: unknown } | undefined)?.message);

const REPORT = { view: "observability/queries", file: "pages/queries.js", line: 120, column: 7, name: "TypeError" };

test("a report is recorded as ONE ui_error event of no table, a failure, its message written from the five fields alone", async () => {
  need();
  recorded.length = 0;
  const r = await post(REPORT);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { recorded: true });
  assert.deepEqual(recorded, [{ kind: "ui_error", table: null, message: "the web page hit a TypeError on its observability/queries view in pages/queries.js at line 120, column 7\n" +
    "The error's own words stay in the browser, in its console: the page never sends them, since they can quote synced data.",
    // its code the error's class, its origin the page's own script and line as Mason's source names it (issue 924)
    code: "TypeError", origin: "src/web/pages/queries.js:120" }]);
  // what the page could not tell is null, and said as unknown — never a word of the page's
  recorded.length = 0;
  assert.equal((await post({ view: "overview", file: null, line: null, column: null, name: null })).status, 200);
  assert.equal(recorded[0]!.message.split("\n")[0], "the web page hit an error on its overview view");
  assert.deepEqual([recorded[0]!.code, recorded[0]!.origin], ["unknown", null], "no class: its code says unknown; no file: no origin");
  const { isFailure } = await import("../src/duck/events.ts");
  assert.ok(isFailure("ui_error" as Parameters<typeof isFailure>[0]), "a ui_error is a failure: mason logs --events --failed, /api/events?failed=1, mason status' recent errors");
});

test("refused whole, nothing recorded: the error's message or stack, an unknown field, a field missing, oversized or of the wrong shape, a body over 1 KiB", async () => {
  const { UI_ERROR_BODY_MAX } = need();
  recorded.length = 0;
  const cases: Array<[string, unknown, RegExp]> = [
    ["its message", { ...REPORT, message: "Cannot read properties of null (reading 'secret_customer_name')" }, /never carries its message: it can quote the page's text, which can be synced data/],
    ["its stack", { ...REPORT, stack: "TypeError: x\n    at http://127.0.0.1/pages/queries.js:1:1" }, /never carries its stack/],
    ["an unknown field", { ...REPORT, row: "alice@example.com" }, /has no field "row"/],
    ["a field missing", { view: "overview", file: null, line: null, column: null }, /needs its name/],
    ["a view the page has not", { ...REPORT, view: "public.orders" }, /view is not one of the web page's views/],
    ["a file that is a URL", { ...REPORT, file: "http://evil.example/x.js" }, /file is not one of the web page's own scripts/],
    ["a file that is no script of the page", { ...REPORT, file: "pages/nope.js" }, /file is not one of the web page's own scripts/],
    ["a file that is a page file but no script", { ...REPORT, file: "app.css" }, /file is not one of the web page's own scripts/],
    ["an oversized file", { ...REPORT, file: `${"a/".repeat(100)}app.js` }, /file is not one of the web page's own scripts/],
    ["an oversized name", { ...REPORT, name: "E".repeat(65) }, /name is the error's class/],
    ["a name that is a sentence", { ...REPORT, name: "secret customer name" }, /name is the error's class/],
    ["a line that is not a whole number", { ...REPORT, line: 1.5 }, /line is a whole number/],
    ["a negative column", { ...REPORT, column: -1 }, /column is a whole number/],
    ["a line as text", { ...REPORT, line: "120" }, /line is a whole number/],
    ["not an object", ["overview"], /is a JSON object/],
  ];
  for (const [what, body, why] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.json)}`);
    assert.match(failure(r), why, what);
    assert.doesNotMatch(JSON.stringify(r.json), /secret_customer_name|alice@example\.com|evil\.example/, `${what}: the refusal repeats none of it`);
  }
  // a body over the cap is never read whole: refused (413, or the connection closed under it)
  const big = await post(null, { raw: JSON.stringify({ ...REPORT, name: "x".repeat(UI_ERROR_BODY_MAX) }) });
  assert.ok(big.status === 413 || big.status === 0, `a body over ${UI_ERROR_BODY_MAX} bytes: ${big.status}`);
  assert.equal((await post(null, { raw: "{not json" })).status, 400);
  assert.deepEqual(recorded, [], "nothing refused was recorded");
});

test("behind the run's guard: no cookie, another Origin, no Origin are refused before the route is read", async () => {
  need();
  recorded.length = 0;
  assert.equal((await post(REPORT, { cookie: null })).status, 403, "no cookie");
  assert.equal((await post(REPORT, { cookie: `mason_dev_${ctx.port}=another` })).status, 403, "another run's cookie");
  assert.equal((await post(REPORT, { origin: "http://evil.example" })).status, 403, "another site");
  assert.equal((await post(REPORT, { origin: null })).status, 403, "no Origin");
  assert.deepEqual(recorded, []);
});

test("a burst: at most UI_ERRORS_PER_MINUTE recorded a minute, the rest refused with 429 and counted; said once in the log; the next minute records again", async () => {
  const { UI_ERRORS_PER_MINUTE } = need();
  clock += 10 * 60_000;
  recorded.length = 0;
  logged.length = 0;
  const before = uiErrors!.total;
  const statuses: number[] = [];
  for (let i = 0; i < UI_ERRORS_PER_MINUTE + 15; i++) { statuses.push((await post({ ...REPORT, line: i })).status); clock += 100; }
  assert.deepEqual(statuses, [...Array(UI_ERRORS_PER_MINUTE).fill(200), ...Array(15).fill(429)]);
  assert.equal(recorded.length, UI_ERRORS_PER_MINUTE, "the events hold the minute's first ones alone");
  assert.equal(uiErrors!.total - before, UI_ERRORS_PER_MINUTE + 15, "every valid report counted: what /metrics says");
  assert.equal(logged.filter((l) => l.startsWith("web page: more than")).length, 1, "the drop said once, not per report");
  assert.ok(logged.every((l) => !l.includes("queries.js")), "the log line names nothing of a report");
  clock += 60_000;
  assert.equal((await post(REPORT)).status, 200, "a minute later: recorded again");
});

test("a run that takes no reports answers 404, and records nothing", async () => {
  need();
  const bareCtx = { page: false, port: 0, token: TOKEN, log: () => undefined } as unknown as RunContext;
  const bare = createRunServer(bareCtx);
  await new Promise<void>((r) => bare.listen(0, "127.0.0.1", () => r()));
  try {
    const port = bareCtx.port = (bare.address() as { port: number }).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/ui/error",
        headers: { Host: `127.0.0.1:${port}`, Cookie: `mason_dev_${port}=${TOKEN}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end(JSON.stringify(REPORT));
    });
    assert.equal(status, 404);
  } finally { bare.close(); }
});
