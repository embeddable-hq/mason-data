/**
 * THE PAGE'S RADIO GROUPS IN A BROWSER (issue 875; `.radios` in src/web/app.css): Users' "Connects from"
 * (src/web/pages/users.js `connectsChoice`, in the add form and in From…'s popover) and a table's Sync choice
 * (src/web/pages/tables.js `renderSyncChoice`).
 * - Ticking "Only from these addresses" or "From anywhere" moves nothing in its form — the add form's Name, Role, the
 *   choice and Add a user, and From…'s popover — at 1280, 1024, 900 and 375 px (the widths web-ui.md walks), and the
 *   address field hidden under From anywhere is out of the tab order and the accessibility tree.
 * - In every group the radios line up: one column, every radio at one left edge (stacked), or one row at one height
 *   (the add form where its card has the room) — never a row that wraps one choice under the group's label.
 * The one test of the page that measures geometry, because what it holds is geometry: the page as served (src/web, its
 * app.js run whole) in Chromium, over the server's own state (`runState`). It needs Playwright and its Chromium; on a
 * machine without them it skips, saying so.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import type { CopyState } from "../src/duck/sync.ts";
import type { RolesLive } from "../src/duck/grants.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
const ORIGIN = "http://mason.test";

type Box = { x: number; y: number; width: number; height: number };
// what the functions handed to page.evaluate meet in the browser (the checkout's tsconfig has no DOM library)
type DOMRect = Box;
type El = { id: string; tagName: string; focus(): void; blur(): void; getAttribute(n: string): string | null; getBoundingClientRect(): DOMRect;
  checkVisibility(o: { visibilityProperty: boolean }): boolean; closest(sel: string): El | null; querySelectorAll(sel: string): Iterable<El> };
type HTMLInputElement = El;
declare const document: { fonts: { ready: Promise<unknown> }; activeElement: El | null; documentElement: { scrollWidth: number };
  querySelector(sel: string): El | null; querySelectorAll(sel: string): Iterable<El> & { length: number } };
declare const window: { innerWidth: number };
type Page = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, o?: { state?: string; timeout?: number }): Promise<unknown>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  close(): Promise<void>;
};
type Route = { request(): { url(): string }; fulfill(o: { status: number; contentType?: string; body: string | Buffer }): Promise<void> };
type Browser = { newPage(o: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };

/** Playwright's Chromium, when this machine has it (its module where Node finds it, its browser installed); else why not. */
const chromium = ((): { launch(): Promise<Browser> } | string => {
  try {
    const pw = createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser>; executablePath(): string } };
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : "Playwright's Chromium is not installed on this machine";
  } catch (e) {
    return `Playwright is not installed on this machine (${(e as Error).message.split("\n")[0]})`;
  }
})();
const skip = typeof chromium === "string" ? chromium : false;

// ------------------------------------------------------------------ fixtures: the server's own state (runState)

const at = "2026-10-27T09:00:00.000Z";
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const TABLES: SourceTable[] = [{ source: "public.customers", schema: "public", table: "customers", key: ["id"], rows: 1200, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [] }];
const FILE = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const COPIES: CopyState[] = [{ source: "public.customers", phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null,
  kept: { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null } } as CopyState];

/** /api/state as the server answers it: one table added, and a roles file naming two roles (the add form's Role too). */
function state(): unknown {
  const roles = { file: "mason/roles.yml", problem: null, default: "analyst",
    grants: new Map(["analyst", "agent"].map((name) => [name, { name, all: true }])) } as unknown as RolesLive;
  const ctx = {
    roles: () => roles, source,
    facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }),
    warnings: [], replication: () => null,
    page: true, users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }),
    listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, COPIES, null, Date.parse("2026-10-27T10:00:00.000Z"))));
}

const USERS = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true, from: null, role: "analyst" }],
  lastUsedNote: null, requestLogDays: 7 };
/** `GET api/tables/<table>/sync`'s answer (src/cli/sync-choice.ts SyncChoice): off now, four polls, Live allowed */
const SYNC_CHOICE = { table: "public.customers", sync: { value: "off", from: "default" }, rows: 1200, bigRows: false,
  polls: [["poll 5m", 300], ["poll 15m", 900], ["poll 1h", 3600], ["poll 1d", 86_400]].map(([sync, seconds]) => ({ sync, seconds, cost: null })),
  live: { allowed: true, checks: [{ name: "primary key", state: "ok", detail: "id" }, { name: "wal_level", state: "ok", detail: "logical" }] } };
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

/** The page as served at `hash`: its files from src/web, the reads its pages make from the fixtures, anything else a 404. */
async function served(browser: Browser, width: number, hash: string, ready: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const answers: Record<string, string> = { "api/state": JSON.stringify(state()), "api/users": JSON.stringify(USERS),
    "api/tables/public.customers/sync": JSON.stringify(SYNC_CHOICE) };
  await page.route(`${ORIGIN}/**`, async (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/+/, "")) || "index.html";
    if (answers[p] !== undefined) return route.fulfill({ status: 200, contentType: "application/json", body: answers[p]! });
    const file = path.join(WEB, p);
    if (!p.startsWith("api/") && file.startsWith(WEB + path.sep) && fs.existsSync(file)) {
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  await page.goto(`${ORIGIN}/#${hash}`);
  await page.waitForSelector(ready, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true), null);
  return page;
}

/** Every box in `root` (the form itself, each field, label, legend and button), by a path of its own. */
const boxes = (page: Page, root: string): Promise<Record<string, Box>> => page.evaluate((sel) => {
  const out: Record<string, Box> = {};
  const form = document.querySelector(sel);
  if (form === null) return out;
  const all = [form, ...form.querySelectorAll("*")];
  all.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    out[`${i} ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("name") ? `[${el.getAttribute("name")}]` : ""}`] =
      { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
  });
  return out;
}, root);

/** The boxes that differ between two measures, said as `name: before → after`. */
const moved = (a: Record<string, Box>, b: Record<string, Box>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);

/** How the radios of the group under `root` lie: "column" (one left edge), "row" (one height), else each radio's box. */
const radiosLie = (page: Page, root: string): Promise<string> => page.evaluate((sel) => {
  const rs = [...document.querySelectorAll(`${sel} input[type=radio]`)].map((el) => el.getBoundingClientRect());
  if (rs.length < 2) return `only ${rs.length} radio`;
  const one = (f: (r: DOMRect) => number) => rs.every((r) => Math.abs(f(r) - f(rs[0]!)) < 0.5);
  if (one((r) => r.x) && rs.every((r, i) => i === 0 || r.y > rs[i - 1]!.y)) return "column";
  if (one((r) => r.y + r.height / 2) && rs.every((r, i) => i === 0 || r.x > rs[i - 1]!.x)) return "row";
  return rs.map((r) => `(${Math.round(r.x)}, ${Math.round(r.y)})`).join(" ");
}, root);

/** Whether the address field can be reached: focusable by Tab, and in the accessibility tree (not hidden from it). */
const reachable = (page: Page, input: string): Promise<{ focusable: boolean; hidden: boolean }> => page.evaluate((sel) => {
  const el = document.querySelector(sel) as HTMLInputElement | null;
  if (el === null) return { focusable: false, hidden: true };
  el.focus();
  const focusable = document.activeElement === el;
  el.blur();
  // hidden from assistive technology: not rendered (display: none or visibility: hidden, its own or an ancestor's), inert, or under aria-hidden
  const hidden = !el.checkVisibility({ visibilityProperty: true }) || el.closest("[inert], [aria-hidden=true]") !== null;
  return { focusable, hidden };
}, input);

/** Runs `body` over a fresh browser, closed whatever happens. */
async function inChromium(body: (browser: Browser) => Promise<void>): Promise<void> {
  const browser = await (chromium as { launch(): Promise<Browser> }).launch();
  try { await body(browser); } finally { await browser.close(); }
}

for (const width of [1280, 1024, 900, 375]) {
  test(`the add form moves nothing as Connects from is toggled, its radios lined up, at ${width} px (issue 875)`, { skip }, () => inChromium(async (browser) => {
    const page = await served(browser, width, "users", "#add-user button[type=submit]");
    const any = await boxes(page, "#add-user");
    assert.ok(Object.keys(any).length > 10, "the form is measured");
    // in a row where the card has the room for the label, both choices and the box; else one a line
    assert.equal(await radiosLie(page, "#add-user"), width >= 1280 ? "row" : "column");
    assert.deepEqual(await reachable(page, "#add-user-from"), { focusable: false, hidden: true }, "from anywhere: the address field is neither focused nor announced");
    await page.check("#add-user input[value=only]");
    const only = await boxes(page, "#add-user");
    assert.deepEqual(moved(any, only), [], "Only from these addresses moved nothing");
    assert.deepEqual(await reachable(page, "#add-user-from"), { focusable: true, hidden: false }, "only from these addresses: the address field is there to type in");
    await page.check("#add-user input[value=any]");
    assert.deepEqual(moved(any, await boxes(page, "#add-user")), [], "From anywhere again moved nothing");
    assert.deepEqual(await reachable(page, "#add-user-from"), { focusable: false, hidden: true });
    // the page is no wider than the screen in either state (a phone never scrolls sideways)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth, null), true, "no sideways scroll");
  }));

  test(`From…'s form moves nothing as Connects from is toggled, its radios one a line, at ${width} px (issue 875)`, { skip }, () => inChromium(async (browser) => {
    const page = await served(browser, width, "users", "#add-user button[type=submit]");
    await page.click("button.from-line");
    await page.waitForSelector("#user-from", { timeout: 5_000 });
    const any = await boxes(page, "#user-from");
    assert.equal(await radiosLie(page, "#user-from"), "column", "in a popover: one a line, every radio at one left edge");
    assert.deepEqual(await reachable(page, "#user-from-from"), { focusable: false, hidden: true }, "from anywhere: the address field is neither focused nor announced");
    await page.check("#user-from input[value=only]");
    assert.deepEqual(moved(any, await boxes(page, "#user-from")), [], "Only from these addresses moved nothing");
    assert.deepEqual(await reachable(page, "#user-from-from"), { focusable: true, hidden: false });
    await page.check("#user-from input[value=any]");
    assert.deepEqual(moved(any, await boxes(page, "#user-from")), [], "From anywhere again moved nothing");
  }));
}

for (const width of [1280, 375]) {
  test(`a table's Sync choice: its radios one a line at one left edge, at ${width} px (issue 875)`, { skip }, () => inChromium(async (browser) => {
    const page = await served(browser, width, "tables", "[data-choose-sync]");
    await page.click('[data-choose-sync="public.customers"]');
    await page.waitForSelector("form.syncpick input[type=radio]", { timeout: 5_000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll("form.syncpick input[type=radio]").length, null), 6, "Off, four polls and Live");
    assert.equal(await radiosLie(page, "form.syncpick"), "column");
  }));
}
