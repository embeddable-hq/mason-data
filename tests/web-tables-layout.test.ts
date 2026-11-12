/**
 * THE TABLES LIST AT A LAPTOP'S WIDTHS, IN A REAL BROWSER (issue 884; src/web/pages/tables.js, src/web/app.css,
 * src/web/shared.js `placePops`): the page over the server's own state (`runState`) and its own files (PAGE_ROUTES).
 *
 * - THE NAME COLUMN KEEPS A USABLE WIDTH at every width from 1000 to 1400 px (it was 2 px at 1024 px: the fixed columns
 *   filled the list's least width): the less important columns give way first — Key, then Size, then Last sync, then
 *   Rows — each hidden column's fact said in the row's note instead, and the page never scrolls sideways.
 * - WHAT ADD OR SYNC NOW ANSWERED COVERS NO OTHER CONTROL: the "said" popover beside a row's actions is placed where it
 *   covers no button, link or box of another row (or of its own), or else lets a click through to what is under it —
 *   at every width from 1000 to 1400 px and on a phone.
 *
 * A browser is needed: this runs where Playwright and its Chromium are installed (`require("playwright")`), and says it
 * did not run elsewhere (tests/web-tables-actions.test.ts is the same harness).
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

type Page = {
  goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; click(s: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>; close(): Promise<void>;
};
type Browser = { newPage(o: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
const noBrowser = playwright === null ? "Playwright is not installed here (require('playwright')): the page needs a browser to be measured" : false;

// ------------------------------------------------------------------ fixtures: the server's state over synthetic copies

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number, key = ["id"]): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key, rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name"), col("status"), col("created_at", "timestamptz"), col("api_token")], foreignKeys: [] });
const NAMES = ["customers", "order_items", "invoices", "shipments", "billing_events_archive", "audit_trail", "visits", "payments", "raw_log"];
const TABLES = NAMES.map((n, i) => table(n, 1000 * (i + 1), n === "raw_log" ? [] : ["id"]));
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const FILE = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  order_items:\n    columns: [id, status]\n  invoices:\n    exclude: [api_token]\n" +
  "  shipments: {}\n  billing_events_archive: {}\n  payments: {}\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const at = "2026-11-11T09:00:00.000Z";
const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
const copied = (name: string): CopyState => ({ source: `public.${name}`, phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null, kept });
const COPIES: CopyState[] = ["customers", "order_items", "invoices", "shipments", "billing_events_archive", "payments"].map(copied);
const STATE = (() => {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, COPIES, null, Date.parse(at)))) as Record<string, unknown>;
})();
/** What `/api/pick` answers for a table added (src/cli/source-edit.ts addEntry), and `/api/sync` for one synced. */
const added = (table: string) => ({ table, file: "/app/mason/sources/shop.yml", entry: table.slice("public.".length), columns: null, exclude: ["api_token"], key: null,
  addedKey: [], skippedSecrets: ["api_token"], already: false, sync: { value: "off", from: "default" }, bigOff: false, notReplicated: null, pollCost: null });
const synced = (table: string) => ({ tables: [{ table, changed: 3, deleted: 1, rows: 1200, ms: 140 }], streamed: [] });

// ------------------------------------------------------------------ the page, served as the run serves it

/** What the page asked of the run, as `<method> <path>`. */
const asked: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/api/")) asked.push(`${req.method} ${url.pathname}`);
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/state") return json(STATE);
  if (url.pathname === "/api/usage") return json({ samples: [], copySizes: [] });
  if (url.pathname === "/api/pick" || url.pathname === "/api/sync") {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      const asked = JSON.parse(body) as { table?: string; tables?: string[] };
      json(url.pathname === "/api/pick" ? added(asked.table!) : synced(asked.tables![0]!));
    });
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

async function open(width: number): Promise<Page> {
  browser ??= await playwright!.chromium.launch();
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await p.goto(`http://127.0.0.1:${await ready}/#tables`);
  await p.waitForSelector("#tables table.catalog tbody tr");
  await p.evaluate("document.fonts.ready.then(() => null)");
  return p;
}

/** 1000 to 1400 px, every 20 px, and 1024 (the width the owner met). */
const LAPTOP = [...Array.from({ length: 21 }, (_, i) => 1000 + 20 * i), 1024].sort((a, b) => a - b);

/** The list's columns as the browser lays them out: each header's width (0: hidden), the page's and the list's
 *  sideways scroll, and, for each hidden column, the rows whose note does not say its fact. */
const layout = (p: Page) => p.evaluate<{ widths: Record<string, number>; page: number; unsaid: string[] }>(`(() => {
  const widths = {};
  for (const th of document.querySelectorAll("#tables table.catalog thead th")) widths[[...th.classList].filter((c) => c !== "num")[0] || "act"] = Math.round(th.getBoundingClientRect().width);
  const unsaid = [];
  for (const [cls, w] of Object.entries(widths)) {
    if (cls === "name" || cls === "act" || cls === "state" || w > 2) continue;
    for (const tr of document.querySelectorAll("#tables table.catalog tbody tr:not(.under)")) {
      const note = tr.nextElementSibling;
      // a cell that says nothing (a table not added has no last sync) has nothing to say in the note either
      if (!(tr.querySelector("td." + cls)?.textContent ?? "").trim()) continue;
      const fold = note?.querySelector(".fold.f-" + cls);
      const name = tr.querySelector("code.name")?.textContent;
      if (!fold || fold.getBoundingClientRect().width < 1 || !(fold.dataset.fold ?? "").trim()) unsaid.push(name + ": " + cls);
    }
  }
  return { widths, page: document.documentElement.scrollWidth - window.innerWidth, unsaid };
})()`);

test(`the name column keeps a usable width at every width from 1000 to 1400 px; a hidden column's fact is in the row's note`, { skip: noBrowser }, async () => {
  for (const width of LAPTOP) {
    const p = await open(width);
    const l = await layout(p);
    await p.close();
    assert.ok((l.widths.name ?? 0) >= 180, `${width} px: the name column is ${l.widths.name} px wide (${JSON.stringify(l.widths)})`);
    assert.ok(l.page <= 0, `${width} px: the page scrolls ${l.page} px sideways`);
    assert.deepEqual(l.unsaid, [], `${width} px: each hidden column's fact is in every row's note`);
  }
});

/** Every control of the page outside the popover that the answer's box covers, any of it — once more after it is scrolled to the window's middle, as a person scrolls a row clear of an answer docked at
 *  the window's bottom (whose height the page's end leaves room for). */
const covered = (p: Page) => p.evaluate<{ pops: number; out: string[] }>(`(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const under = (el) => {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
    if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) return false;
    // covered as a person sees it: any of it under the answer's box (a click let through it is no excuse: hidden is
    // hidden, and a tap on the answer's words reached the control under it)
    return [...document.querySelectorAll(".pop.said")].some((pop) => {
      if (pop.hidden) return false;
      const a = pop.getBoundingClientRect();
      return b.left < a.right - 0.5 && b.right > a.left + 0.5 && b.top < a.bottom - 0.5 && b.bottom > a.top + 0.5;
    });
  };
  const out = [];
  const pops = [...document.querySelectorAll(".pop.said")].filter((e) => !e.hidden);
  const controls = [...document.querySelectorAll("#page-tables button, #page-tables a[href], #page-tables input, #page-tables select, #page-tables summary")]
    .filter((el) => el.closest(".pop") === null && under(el));
  for (const el of controls) {
    el.scrollIntoView({ block: "center" });
    await frame();
    if (!under(el)) continue;
    const row = el.closest("tr")?.querySelector("code.name")?.textContent ?? el.closest("tr")?.previousElementSibling?.querySelector("code.name")?.textContent ?? "";
    out.push(row + ' "' + (el.textContent ?? "").trim() + '" under the answer');
  }
  return { pops: pops.length, out };
})()`);

/** Where a tap on the answer reaches something that is not the answer: every 8 px of it, its own buttons aside. */
const through = (p: Page) => p.evaluate<string[]>(`(() => {
  const pop = [...document.querySelectorAll(".pop.said")].find((e) => !e.hidden);
  if (!pop) return ["no answer"];
  const b = pop.getBoundingClientRect();
  const out = [];
  for (let y = Math.ceil(b.top) + 2; y < b.bottom - 1; y += 8) {
    for (let x = Math.ceil(b.left) + 2; x < b.right - 1; x += 8) {
      if (x >= window.innerWidth || y >= window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !pop.contains(hit)) out.push(x + "," + y + ": " + (hit?.tagName ?? "nothing") + " " + (hit?.textContent ?? "").trim().slice(0, 30));
    }
  }
  return out;
})()`);

/** 1000 to 1400 px every 40 px, 1024 (the width the owner met) and a phone (390 px). */
const ANSWER_WIDTHS = [...LAPTOP.filter((w) => w % 40 === 0 || w === 1024), 390];

for (const [what, click] of [["Add", 'button[data-add-table="public.audit_trail"]'], ["Sync now", 'button[data-sync-table="public.invoices"]']] as const) {
  test(`after ${what}, a tap anywhere on what it answered never reaches a control under it: 1000 to 1400 px and a phone`, { skip: noBrowser }, async () => {
    for (const width of ANSWER_WIDTHS) {
      const p = await open(width);
      await p.evaluate(`document.querySelector('${click.replace(/'/g, "\\'")}').scrollIntoView({ block: "center" })`);
      await p.click(click);
      await p.waitForSelector(".pop.said:not([hidden])");
      const out = await through(p);
      // and a real tap on its words: nothing asked of the run (a tap once added the table under it)
      const before = asked.length;
      await p.click(".pop.said:not([hidden]) .headline");
      await new Promise((r) => setTimeout(r, 100));
      const after = asked.slice(before);
      await p.close();
      assert.deepEqual(out, [], `${width} px: every point of the answer is the answer`);
      assert.deepEqual(after.filter((a) => a !== "GET /api/state" && !a.startsWith("GET /api/usage")), [], `${width} px: a tap on its words asks nothing`);
    }
  });
  test(`after ${what}, what it answered covers no other control: 1000 to 1400 px and a phone`, { skip: noBrowser }, async () => {
    for (const width of ANSWER_WIDTHS) {
      const p = await open(width);
      await p.evaluate(`document.querySelector('${click.replace(/'/g, "\\'")}').scrollIntoView({ block: "center" })`);
      await p.click(click);
      await p.waitForSelector(".pop.said:not([hidden])");
      const c = await covered(p);
      await p.close();
      assert.equal(c.pops, 1, `${width} px: the answer is said`);
      assert.deepEqual(c.out, [], `${width} px: every control is reached at its middle`);
    }
  });
}
