/**
 * THE USERS PAGE'S "CONNECTS FROM" IN A BROWSER (issue 875; src/web/pages/users.js `connectsChoice`, src/web/app.css):
 * ticking "Only from these addresses" or "From anywhere" moves nothing in its form — the add form's Name, Role,
 * the choice and Add a user, and From…'s popover — at 1280 px and 375 px. The one test of the page that measures
 * geometry, because what it holds is geometry: the page as served (src/web, its app.js run whole) in Chromium, over the
 * server's own state (`runState`), every box of the form measured before and after each toggle. The address field
 * hidden under From anywhere is held out of the tab order and the accessibility tree too. It needs Playwright and
 * its Chromium; on a machine without them it skips, saying so.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import type { RolesLive } from "../src/duck/grants.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
const ORIGIN = "http://mason.test";

type Box = { x: number; y: number; width: number; height: number };
type Page = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, o?: { state?: string; timeout?: number }): Promise<unknown>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
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

/** /api/state as the server answers it (runState), with a roles file naming two roles: the Role choice in the add form too. */
function state(): unknown {
  const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
  const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
  const roles = { file: "mason/roles.yml", problem: null, default: "analyst",
    grants: new Map(["analyst", "agent"].map((name) => [name, { name, all: true }])) } as unknown as RolesLive;
  const ctx = {
    roles: () => roles, source,
    facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: [], systemIdentifier: null }),
    warnings: [], replication: () => null,
    page: true, users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: null, problem: null }),
    listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, [], null, Date.parse("2026-10-27T10:00:00.000Z"))));
}

const USERS = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true, from: null, role: "analyst" }],
  lastUsedNote: null, requestLogDays: 7 };
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

/** The page as served: its files from src/web, the two reads the Users page makes from the fixtures, anything else a 404. */
async function usersPage(browser: Browser, width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const body = { state: JSON.stringify(state()), users: JSON.stringify(USERS) };
  await page.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/+/, "") || "index.html";
    if (p === "api/state") return route.fulfill({ status: 200, contentType: "application/json", body: body.state });
    if (p === "api/users") return route.fulfill({ status: 200, contentType: "application/json", body: body.users });
    const file = path.join(WEB, p);
    if (!p.startsWith("api/") && file.startsWith(WEB + path.sep) && fs.existsSync(file)) {
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  await page.goto(`${ORIGIN}/#users`);
  await page.waitForSelector("#add-user button[type=submit]", { timeout: 15_000 });
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

for (const width of [1280, 375]) {
  test(`the add form moves nothing as Connects from is toggled, at ${width} px (issue 875)`, { skip }, async () => {
    const browser = await (chromium as { launch(): Promise<Browser> }).launch();
    try {
      const page = await usersPage(browser, width);
      const any = await boxes(page, "#add-user");
      assert.ok(Object.keys(any).length > 10, "the form is measured");
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
      await page.close();
    } finally {
      await browser.close();
    }
  });

  test(`From…'s form moves nothing as Connects from is toggled, at ${width} px (issue 875)`, { skip }, async () => {
    const browser = await (chromium as { launch(): Promise<Browser> }).launch();
    try {
      const page = await usersPage(browser, width);
      await page.click("button.from-line");
      await page.waitForSelector("#user-from", { timeout: 5_000 });
      const any = await boxes(page, "#user-from");
      assert.deepEqual(await reachable(page, "#user-from-from"), { focusable: false, hidden: true }, "from anywhere: the address field is neither focused nor announced");
      await page.check("#user-from input[value=only]");
      assert.deepEqual(moved(any, await boxes(page, "#user-from")), [], "Only from these addresses moved nothing");
      assert.deepEqual(await reachable(page, "#user-from-from"), { focusable: true, hidden: false });
      await page.check("#user-from input[value=any]");
      assert.deepEqual(moved(any, await boxes(page, "#user-from")), [], "From anywhere again moved nothing");
      await page.close();
    } finally {
      await browser.close();
    }
  });
}
