/**
 * THE SYNC EVENTS LIST AT EVERY WIDTH, IN A REAL BROWSER (issues 1038, 1048; src/web/pages/syncs.js, src/web/app.css):
 * the page over the server's own state (`runState`) and its own files (PAGE_ROUTES), with events whose messages, tables
 * and times are as long as a run writes them, and a sync running now. At every width from 320 to 1600 px, light and dark:
 *
 * - EVERY CELL KEEPS ITS TEXT INSIDE IT: no line of a cell runs past its cell's edges (Took spilled out of its cell at
 *   the middle widths, between the phone layout and a desktop's width: issue 1038).
 * - THE LIST SCROLLS INSIDE ITS CARD, AS THE TABLES AND USERS LISTS DO (issue 1048): above the phone layout the list has
 *   a least width. Where its card is narrower, the card scrolls sideways, with the list at that width and no wider.
 *   Where the card is as wide, nothing scrolls. On a phone each event is a block, and nothing scrolls. The page never
 *   scrolls sideways.
 * - A NAME OF USUAL LENGTH IS WHOLE (issue 1048: #1043 cut every name to "publi…" between 650 and 1080 px). Only the
 *   long name is cut, with its whole as its title.
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
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import * as tableSync from "../src/lib/table-sync.ts";
import type { CopyState } from "../src/duck/sync.ts";
import type { SyncEvent } from "../src/duck/events.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

type Page = { goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; evaluate<T = unknown>(expression: string): Promise<T>;
  setViewportSize(s: { width: number; height: number }): Promise<void>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(o: { viewport: { width: number; height: number }; colorScheme?: "light" | "dark" }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
const noBrowser = playwright === null ? "Playwright is not installed here (require('playwright')): the page needs a browser to be measured" : false;

// ------------------------------------------------------------------ fixtures: the server's state and the run's events

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const LONG = "customer_subscription_billing_events_archive_2026_full";
// "public.locked_for_running_sync": a usual name of 30 characters, the longest held whole (issue 1049)
const USUAL = "locked_for_running_sync";
const NAMES = ["orders", "order_items", "customers", USUAL, LONG];
const TABLES: SourceTable[] = NAMES.map((name, i) => ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], rows: 1000 * (i + 1), bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("status")], foreignKeys: [] }));
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const FILE = parseSourceText(`kind: postgres\nurl: x\ntables:\n${NAMES.map((n) => `  ${n}: {}\n`).join("")}`, "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const at = "2026-11-11T09:00:00.000Z";
const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
const COPIES: CopyState[] = NAMES.map((name) => ({ source: `public.${name}`, phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null, kept }));
const STATE = (() => {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, COPIES, null, Date.parse(at)))) as { tables: Array<Record<string, unknown>> };
})();
/** The state now: the long-named table's sync asked by hand, running for two minutes (a "Now" row, its Took ticking). */
const stateNow = () => ({ ...STATE, tables: STATE.tables.map((t) => t.table === `public.${LONG}`
  ? { ...t, syncByHand: { id: 1, tables: [t.table], state: "syncing", startedAt: new Date(Date.now() - 125_000).toISOString(), endedAt: null } } : t) });

/** The events, newest last as the run sends them: every length of Took the commands write, the longest messages a sync
 *  writes, a failure with its code and origin, a long table name and Mason's own. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const counts = { added: 1_234_567, updated: 89_012, deleted: 3_456, rows: 12_345_678 };
const eventsNow = (): SyncEvent[] => [
  { at: ago(9 * 86_400_000), kind: "restart", failed: false, table: null, message: "Mason restarted", code: null, origin: null, tookMs: null },
  { at: ago(3 * 86_400_000), kind: "full_sync", failed: false, table: `public.${LONG}`, message: `synced whole: ${tableSync.syncedText({ ...counts, ms: 7_384_000 }, "exact")}`, code: null, origin: null, tookMs: 7_384_000 },
  { at: ago(86_400_000), kind: "full_sync_failed", failed: true, table: "public.order_items", message: "full sync: connection to the source was lost while reading chunk 14 of 220\nthe sync tries it again in 30 s", code: "ECONNRESET", origin: "src/duck/sync.ts:3640", tookMs: null },
  // the widest kind's words
  { at: ago(7_200_000), kind: "generated_failed", failed: true, table: `public.${LONG}`, message: "generated table: the query failed", code: "42P01", origin: "src/duck/generated.ts:210", tookMs: null },
  { at: ago(3_600_000), kind: "synced", failed: false, table: "public.customers", message: `synced by hand: ${tableSync.syncedText({ ...counts, ms: 13_703 }, "exact")}`, code: null, origin: null, tookMs: 13_703 },
  { at: ago(600_000), kind: "full_sync", failed: false, table: "public.orders", message: `synced whole: ${tableSync.syncedText({ ...counts, ms: 477_000 }, "exact")}`, code: null, origin: null, tookMs: 477_000 },
  { at: ago(60_000), kind: "polled", failed: false, table: "public.orders", message: `synced on schedule: ${tableSync.syncedText({ ...counts, ms: 570 }, "poll")}`, code: null, origin: null, tookMs: 570 },
  { at: ago(30_000), kind: "synced", failed: false, table: `public.${USUAL}`, message: `synced by hand: ${tableSync.syncedText({ ...counts, ms: 2_500 }, "exact")}`, code: null, origin: null, tookMs: 2_500 },
];

// ------------------------------------------------------------------ the page, served as the run serves it

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/state") return json(stateNow());
  if (url.pathname === "/api/events") return json({ events: eventsNow(), keptDays: 7 });
  if (url.pathname === "/api/logs") return json({ lines: [], kept: 200 });
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

async function open(width: number, colorScheme: "light" | "dark"): Promise<Page> {
  browser ??= await playwright!.chromium.launch();
  const p = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
  await p.goto(`http://127.0.0.1:${await ready}/#observability/syncs`);
  await p.waitForSelector("#syncs-events table.events tbody tr.t-running");
  await p.evaluate("document.fonts.ready.then(() => null)");
  return p;
}

/** 320 to 1600 px, every 10 px. */
const WIDTHS = Array.from({ length: 129 }, (_, i) => 320 + 10 * i);

/** What is wrong with the list at this width, a line each, none when nothing is: a cell whose text runs past its edges
 *  (by each line's box, so a wrapped cell is measured line by line), a card that scrolls where it should not or does
 *  not where it should, a page that scrolls sideways, and a name of usual length cut. */
const spills = (p: Page) => p.evaluate<string[]>(`(() => {
  const out = [];
  const table = document.querySelector("#syncs-events table.events");
  const card = table.closest(".list");
  const phone = window.innerWidth <= 640;
  const least = parseFloat(getComputedStyle(table).minWidth) || 0;
  const scrolls = card.scrollWidth > card.clientWidth + 1;
  const wide = table.getBoundingClientRect().width;
  if (phone) {
    if (scrolls) out.push("on a phone the list runs " + (card.scrollWidth - card.clientWidth) + " px past its card");
  } else if (least < 400) {
    out.push("the list has no least width (min-width " + getComputedStyle(table).minWidth + ")");
  } else if (card.clientWidth + 1 < least) {
    if (!scrolls) out.push("the card (" + card.clientWidth + " px) is narrower than the list's least width (" + least + " px) and does not scroll");
    if (!["auto", "scroll"].includes(getComputedStyle(card).overflowX)) out.push("the card cannot scroll (overflow-x " + getComputedStyle(card).overflowX + ")");
    if (Math.abs(wide - least) > 1) out.push("the list is " + wide.toFixed(1) + " px wide in a card that scrolls, not its least width " + least + " px");
  } else if (scrolls) out.push("the list runs " + (card.scrollWidth - card.clientWidth) + " px past a card as wide as it needs");
  if (document.documentElement.scrollWidth > window.innerWidth) out.push("the page scrolls sideways");
  // a name is cut where its box holds less than its text, across or down (a clamped line): above the phone layout only
  // a name longer than 30 characters may be, and a cut name's whole is its title (on a phone, a name beside the widest
  // kinds is cut at 320 px, as it was before issue 1048, which kept the phone layout). The text's own width, from a
  // range, against the box's: scrollWidth is whole pixels, and missed a cut under one (issue 1049)
  for (const name of table.querySelectorAll("code.name")) {
    const range = document.createRange();
    range.selectNodeContents(name);
    const text = range.getBoundingClientRect().width, box = name.getBoundingClientRect().width;
    const cut = text > box + 0.05 || name.scrollWidth > name.clientWidth + 0.5 || name.scrollHeight > name.clientHeight + 0.5;
    if (cut && !phone && name.textContent.length <= 30) out.push("the name " + JSON.stringify(name.textContent) + " is cut (" + box.toFixed(2) + " of " + text.toFixed(2) + " px)");
    if (cut && name.title !== name.textContent) out.push("the cut name " + JSON.stringify(name.textContent) + " has no title with its whole");
  }
  const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
  for (const tr of table.querySelectorAll("tr")) {
    [...tr.children].forEach((cell, i) => {
      if (getComputedStyle(cell).display === "none") return;
      const box = cell.getBoundingClientRect();
      // each text's lines, or, inside an element that cuts what overflows it (a long table name's ellipsis), that element
      const rects = [];
      const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (!t.textContent.trim()) continue;
        let clip = null;
        for (let e = t.parentElement; e && e !== cell; e = e.parentElement) if (getComputedStyle(e).overflowX !== "visible") clip = e;
        if (clip) { rects.push(clip.getBoundingClientRect()); continue; }
        const range = document.createRange();
        range.selectNodeContents(t);
        rects.push(...range.getClientRects());
      }
      for (const r of rects) {
        if (r.width === 0) continue;
        const past = Math.max(box.left - r.left, r.right - box.right);
        if (past > 0.5) { out.push((heads[i] || "column " + (i + 1)) + " of " + JSON.stringify(tr.textContent.trim().slice(0, 40)) + " runs " + past.toFixed(1) + " px past its cell"); break; }
      }
    });
  }
  return out;
})()`);

for (const scheme of ["light", "dark"] as const) {
  test(`the Sync events list keeps each cell's text inside it, scrolls inside its card below its least width, and keeps usual names whole, from 320 to 1600 px (${scheme})`, { skip: noBrowser }, async () => {
    const p = await open(WIDTHS[0]!, scheme);
    const found: string[] = [];
    for (const width of WIDTHS) {
      await p.setViewportSize({ width, height: 900 });
      await p.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      for (const s of await spills(p)) found.push(`${width} px: ${s}`);
    }
    await p.close();
    assert.deepEqual(found, [], `what is wrong with the list:\n${found.join("\n")}`);
  });
}
