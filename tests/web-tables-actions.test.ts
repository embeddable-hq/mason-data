/**
 * EVERY ACTION OF A TABLES ROW IS SEEN WHOLE, AT EVERY WIDTH (issue 881; src/web/pages/tables.js, src/web/app.css): the
 * page in a real browser, over the server's own state (`runState`) and its own files (PAGE_ROUTES), at 1280, 1120, 1024,
 * 900 and 375 px, in every state a row has (added, failed, copying, not added, one that cannot be added as it is, adding, its
 * sync running) and in each read-only mode (a server's sources file, MASON_UI_READ_ONLY=1, and its tables still
 * allowed). Each button and link in a row's actions must show its whole text: never cut by its own width, nor by the
 * cell around it (the list's cells put "…" in place of what overflows), nor left outside the list's card. At 1280 px
 * the list fits its card; the page never scrolls sideways.
 *
 * A browser is needed: this runs where Playwright and its Chromium are installed (`require("playwright")`), and says it
 * did not run elsewhere. The rest of the page's tests read what it WROTE (tests/web-page.test.ts); this one reads what a
 * person sees, which only a layout engine can tell.
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
import type { CopyState } from "../src/duck/sync.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

// ------------------------------------------------------------------ the browser, where there is one

type Page = {
  goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; click(s: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>; screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>; close(): Promise<void>;
};
type Browser = { newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  // where it is not installed, each test says so as its skip
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
const noBrowser = playwright === null ? "Playwright is not installed here (require('playwright')): the page needs a browser to be measured" : false;
// a screenshot of each width and mode, for a person reading the change (MASON_SHOTS=<folder>; none by default)
const SHOTS = process.env.MASON_SHOTS ?? null;

// ------------------------------------------------------------------ fixtures: the server's state over synthetic copies

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number, key = ["id"]): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key, rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [] });
const LONG = "customer_subscription_billing_events_archive_2026";
const TABLES = [table("customers", 1200), table("orders", 40_000_000), table("events", 3000), table(LONG, 90_000), table("audit", 50), table("raw_log", 7, []), table("visits", 12)];
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const FILE = parseSourceText(`kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n  ${LONG}: {}\n`, "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const at = "2026-11-11T09:00:00.000Z";
const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
const COPIES: CopyState[] = [
  { source: "public.customers", phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null, kept },
  { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null, error: "could not read the next chunk: connection reset\nthe sync tries it again in 5 min" },
  { source: "public.events", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 1000, rowsEstimate: 3000,
    progress: { chunksDone: 1, chunksTotal: 3, reading: 1, readingSeconds: 2, rowsReading: 500, rowsPerSecond: 500, bytesPerSecond: 1e5, secondsLeft: 4, share: 0.33 } },
  { source: `public.${LONG}`, phase: "copied", rows: 90_000, bytes: 1, seconds: 1, copiedAt: at, error: null, kept },
];
function stateOf(o: { pageReadOnly?: boolean; allow?: string[]; sourcesReadOnly?: string } = {}): Record<string, unknown> {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    ...(o.pageReadOnly ? { pageReadOnly: true, pageReadOnlyAllow: o.allow ?? [] } : {}),
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  const s = JSON.parse(JSON.stringify(runState(ctx, COPIES, null, Date.parse(at)))) as Record<string, unknown>;
  return o.sourcesReadOnly ? { ...s, sourcesReadOnly: o.sourcesReadOnly } : s;
}
const MODES: Record<string, Record<string, unknown>> = {
  "editable": stateOf(),
  "sources read-only": stateOf({ sourcesReadOnly: "the project's files are read-only here (MASON_PROJECT_READONLY=1); edit them where they are committed, and deploy" }),
  "page read-only": stateOf({ pageReadOnly: true }),
  "page read-only, tables allowed": stateOf({ pageReadOnly: true, allow: ["tables"] }),
};

// ------------------------------------------------------------------ the page, served as the run serves it

let mode = "editable";
/** An Add or a Sync held unanswered while not null: the row says Adding… or Syncing… until each is released. */
let held: Array<() => void> | null = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/state") return json(MODES[mode]);
  if (url.pathname === "/api/usage") return json({ samples: [], copySizes: [] });
  if ((url.pathname === "/api/pick" || url.pathname === "/api/sync") && held !== null) {
    held.push(() => json({ failure: { message: "held by the test", why: null, fix: null, next: [] } }));
    return;
  }
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

/** Every action of every row the list wrote, each one where it is cut, or nothing: its own text past its width, the
 *  control past its cell's content box, outside the card the list scrolls in, or not what a click at its middle reaches. */
// run in the page, as JavaScript (the project's typecheck has no DOM types)
const clipped = (p: Page) => p.evaluate<{ cells: number; out: string[] }>(`(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
  const out = [];
  const cells = [...document.querySelectorAll("#tables table.catalog tbody td.act")];
  for (const td of cells) {
    const row = td.closest("tr")?.querySelector("code.name")?.textContent ?? "?";
    for (const el of td.querySelectorAll("button, a")) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      // the cell's content box: what passes it is where the cell's ellipsis puts "…" in the control's place
      const box = r(td);
      const pad = getComputedStyle(td);
      const cell = { left: box.left + parseFloat(pad.paddingLeft), right: box.right - parseFloat(pad.paddingRight) };
      const card = r(td.closest(".panel") ?? document.body);
      const b = r(el);
      const said = row + ': "' + (el.textContent ?? "").trim() + '"';
      if (b.right - b.left < 1) { out.push(said + " has no width"); continue; }
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(said + " cut inside its button (" + el.scrollWidth + " > " + el.clientWidth + ")");
      if (b.left < cell.left - 0.5 || b.right > cell.right + 0.5) out.push(said + " past its cell's room (" + Math.round(b.left) + "-" + Math.round(b.right) + " in " + Math.round(cell.left) + "-" + Math.round(cell.right) + ")");
      if (b.left < card.left - 0.5 || b.right > card.right + 0.5) out.push(said + " outside the list's card");
      if (b.right > window.innerWidth + 0.5) out.push(said + " past the window's right");
      // what a click at its middle reaches: the control itself, never something laid over it
      const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
      if (hit === null || !el.contains(hit)) out.push(said + " not reached at its middle (" + (hit?.tagName ?? "nothing") + " is there)");
    }
  }
  return { cells: cells.length, out };
})()`);

const WIDTHS = [1280, 1120, 1024, 900, 375] as const;

async function open(width: number, m: string): Promise<Page> {
  browser ??= await playwright!.chromium.launch();
  mode = m;
  const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await p.goto(`http://127.0.0.1:${await ready}/#tables`);
  await p.waitForSelector("#tables table.catalog tbody tr");
  await p.evaluate("document.fonts.ready.then(() => null)");
  return p;
}
const shot = async (p: Page, name: string): Promise<void> => {
  if (SHOTS === null) return;
  await p.evaluate("window.scrollTo(0, 0)");
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

for (const m of Object.keys(MODES)) {
  test(`${m}: every action of every Tables row shows its whole text at ${WIDTHS.join(", ")} px`, { skip: noBrowser }, async () => {
    for (const width of WIDTHS) {
      const p = await open(width, m);
      const { cells, out } = await clipped(p);
      await shot(p, `tables-${m.replace(/[^a-z]+/g, "-")}-${width}`);
      // the page never scrolls sideways; at 1280 px neither does the list (narrower, it scrolls in its card, its
      // actions pinned at the card's right)
      const wide = await p.evaluate<{ page: number; list: number }>(`({ page: document.documentElement.scrollWidth - window.innerWidth,
        list: ((e) => e ? e.scrollWidth - e.clientWidth : 0)(document.querySelector("#tables table.catalog")?.closest(".panel") ?? null) })`);
      await p.close();
      assert.equal(cells, TABLES.length, `${width} px: a row's actions for each table`);
      assert.deepEqual(out, [], `${width} px, ${m}: every action seen whole`);
      assert.ok(wide.page <= 0, `${width} px: the page scrolls ${wide.page} px sideways`);
      if (width >= 1280) assert.ok(wide.list <= 0, `${width} px: the list scrolls ${wide.list} px sideways in its card`);
    }
  });
}

test(`a row's actions while it is being added and while its sync runs: whole at ${WIDTHS.join(", ")} px`, { skip: noBrowser }, async () => {
  for (const width of WIDTHS) {
    const p = await open(width, "editable");
    held = [];
    await p.click('button[data-add-table="public.audit"]');
    await p.click('button[data-sync-table="public.customers"]');
    await p.waitForSelector("#tables button:disabled:text-is('Adding…')");
    await p.waitForSelector("#tables button:disabled:text-is('Syncing…')");
    const { out } = await clipped(p);
    await shot(p, `tables-adding-syncing-${width}`);
    for (const release of held) release();
    held = null;
    await p.close();
    assert.deepEqual(out, [], `${width} px, adding and syncing: every action seen whole`);
  }
});
