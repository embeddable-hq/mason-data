/**
 * WHO IS SIGNED IN TO THE HOST, IN A REAL BROWSER (issue 970; `MASON_UI_ACCOUNT`, src/web/app.js `renderAccount`,
 * src/web/app.css `.account`): the page over the server's own state (`runState`) and its own files (PAGE_ROUTES).
 *
 * - ON A DESKTOP the label shows at the sidebar's foot, a link to its URL; a long label wraps inside the sidebar.
 * - ON THE ICON RAIL (641 to 999 px) the icon alone shows; the label is its tooltip, shown on hover and on focus.
 * - ON A PHONE (640 px or less) it is in the menu's sheet with the nav, once the menu is open.
 * - Unset, nothing shows, and the nav does not move. The page never scrolls sideways.
 *
 * A browser is needed: this runs where Playwright and its Chromium are installed (`require("playwright")`), and says it
 * did not run elsewhere (tests/web-tables-layout.test.ts is the same harness).
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runState, PAGE_ROUTES, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

type Page = {
  goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; click(s: string): Promise<void>; hover(s: string): Promise<void>;
  focus(s: string): Promise<void>; evaluate<T = unknown>(expression: string): Promise<T>; close(): Promise<void>;
};
type Browser = { newPage(o: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
const noBrowser = playwright === null ? "Playwright is not installed here (require('playwright')): the page needs a browser to be measured" : false;

const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const at = "2026-11-11T09:00:00.000Z";
const stateWith = (pageAccount: { label: string; url: string } | null): Record<string, unknown> => {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: [], systemIdentifier: null }), warnings: [],
    replication: () => null, page: true, served: true, pageAccount,
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: null, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, [], null, Date.parse(at)))) as Record<string, unknown>;
};

/** The longest label taken (64 characters), words and one unbroken run, and markup that must read as text. */
const LONG = "Signed in as ada.lovelace.of.analytical.engines@example.com <b>x";
assert.equal([...LONG].length, 64);
let state = stateWith({ label: LONG, url: "/account" });

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/state") return json(state);
  if (url.pathname.startsWith("/api/")) return json({});
  const route = PAGE_ROUTES[url.pathname];
  if (route === undefined) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": route[1] });
  res.end(fs.readFileSync(path.join(WEB, route[0])));
});
const ready = noBrowser ? null : new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
let browser: Browser | null = null;
after(async () => {
  await browser?.close();
  if (ready !== null) await new Promise((r) => server.close(r));
});

async function open(width: number): Promise<Page> {
  browser ??= await playwright!.chromium.launch();
  const p = await browser.newPage({ viewport: { width, height: 800 } });
  await p.goto(`http://127.0.0.1:${await ready}/#overview`);
  await p.waitForSelector("#where:not(:empty)");
  await p.evaluate("document.fonts.ready.then(() => null)");
  return p;
}

/** The account's link as laid out: shown, its text, href, the label's box and opacity, the sidebar's box, the sideways scroll. */
const measure = (p: Page) => p.evaluate<{ shown: boolean; text: string; href: string | null; rel: string | null; label: { left: number; right: number; height: number; opacity: string } | null;
  side: { left: number; right: number }; link: { left: number; right: number }; page: number }>(`(() => {
  const a = document.querySelector("#account a");
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
  const label = a?.querySelector(".label");
  const body = document.getElementById("side-body");
  return {
    shown: a !== null && a.getClientRects().length > 0 && getComputedStyle(document.getElementById("account")).display !== "none",
    text: label?.textContent ?? "", href: a?.getAttribute("href") ?? null, rel: a?.getAttribute("rel") ?? null,
    label: label ? { ...box(label), opacity: getComputedStyle(label).opacity } : null,
    side: box(body.getClientRects().length > 0 ? body : document.getElementById("sidebar")),
    link: a ? box(a) : { left: 0, right: 0, height: 0 },
    page: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`);

test("desktop: the label at the sidebar's foot as text, a link to its URL; the longest label wraps inside the sidebar", { skip: noBrowser }, async () => {
  state = stateWith({ label: LONG, url: "/account" });
  const p = await open(1280);
  const m = await measure(p);
  assert.deepEqual([m.shown, m.text, m.href, m.rel, m.label!.opacity], [true, LONG, "/account", "noreferrer", "1"]);
  assert.ok(m.label!.right <= m.side.right && m.label!.left >= m.side.left, `the label inside the sidebar: ${JSON.stringify(m)}`);
  assert.ok(m.label!.height > 20, "the longest label wraps onto more lines, never cut or widening the sidebar");
  assert.equal(m.page, 0, "nothing scrolls sideways");
  assert.equal(await p.evaluate("document.querySelector('#account b')"), null, "the label's markup is text");
  await p.close();
});

test("the icon rail: the icon alone, the label its tooltip on hover and on focus; nothing scrolls sideways", { skip: noBrowser }, async () => {
  state = stateWith({ label: "ada@example.com", url: "https://console.example.com/me" });
  for (const width of [641, 800, 999]) {
    const p = await open(width);
    const m = await measure(p);
    assert.deepEqual([m.shown, m.text, m.href, m.label!.opacity], [true, "ada@example.com", "https://console.example.com/me", "0"], `${width}: the label hidden until asked`);
    assert.ok(m.label!.left >= m.link.right, `${width}: the tooltip beside the icon, outside the rail`);
    assert.ok(m.link.right - m.link.left <= 64, `${width}: the link is the rail's width`);
    await p.hover("#account a");
    assert.equal((await measure(p)).label!.opacity, "1", `${width}: shown on hover`);
    await p.hover("main");
    await p.focus("#account a");
    assert.equal((await measure(p)).label!.opacity, "1", `${width}: shown on focus`);
    assert.equal(m.page, 0, `${width}: nothing scrolls sideways`);
    await p.close();
  }
});

test("a phone: in the menu's sheet with the nav once it is open; the longest label wraps inside the sheet", { skip: noBrowser }, async () => {
  state = stateWith({ label: LONG, url: "/account" });
  for (const width of [320, 375, 640]) {
    const p = await open(width);
    assert.equal((await measure(p)).shown, false, `${width}: the sheet closed, the account with it`);
    await p.click("#menu-button");
    const m = await measure(p);
    assert.deepEqual([m.shown, m.text, m.label!.opacity], [true, LONG, "1"], `${width}: in the sheet`);
    assert.ok(m.label!.right <= m.side.right, `${width}: inside the sheet: ${JSON.stringify(m)}`);
    assert.equal(m.page, 0, `${width}: nothing scrolls sideways`);
    await p.close();
  }
});

test("unset: nothing shows at any width, and the nav's links do not move", { skip: noBrowser }, async () => {
  for (const width of [375, 800, 1280]) {
    state = stateWith(null);
    const p = await open(width);
    if (width < 641) await p.click("#menu-button");
    const m = await measure(p);
    assert.equal(m.shown, false, `${width}: nothing`);
    assert.equal(await p.evaluate("document.getElementById('account').innerHTML"), "", `${width}: nothing written`);
    assert.equal(await p.evaluate("document.getElementById('account').getBoundingClientRect().height"), 0, `${width}: no room taken`);
    assert.equal(m.page, 0);
    // the same page with the account: the nav's links are where they were
    state = stateWith({ label: "Ada", url: "/account" });
    const q = await open(width);
    if (width < 641) await q.click("#menu-button");
    const links = (x: Page) => x.evaluate<number[]>("[...document.querySelectorAll('#nav a')].map((a) => Math.round(a.getBoundingClientRect().top))");
    assert.deepEqual(await links(q), await links(p), `${width}: the nav's links are where they were`);
    await p.close(); await q.close();
  }
});
