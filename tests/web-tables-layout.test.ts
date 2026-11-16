/**
 * THE TABLES LIST AT A LAPTOP'S WIDTHS, IN A REAL BROWSER (issue 884; src/web/pages/tables.js, src/web/app.css,
 * src/web/shared.js `placePops`): the page over the server's own state (`runState`) and its own files (PAGE_ROUTES).
 *
 * - THE NAME COLUMN KEEPS A USABLE WIDTH at every width from 1000 to 1400 px (it was 2 px at 1024 px: the fixed columns
 *   filled the list's least width): the less important columns give way first — Key, then Size, Last sync, Rows,
 *   Columns and Sync — each hidden column's fact said in the row's note instead, and the page never scrolls sideways.
 * - AN ADDED TABLE'S COLUMNS AND SYNC ARE COLUMNS OF THE LIST (issue 1110): each control is shown once at every width,
 *   in its column or, where the column gave way, in the row's note, and a press at its centre reaches it. Opening the
 *   Sync choice or the column form moves no row and no column, its popover beside the control shown.
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
  goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; click(s: string): Promise<void>; tap(s: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>; close(): Promise<void>; touchscreen: { tap(x: number, y: number): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
};
type Browser = { newPage(o: { viewport: { width: number; height: number }; hasTouch?: boolean; isMobile?: boolean }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
const noBrowser = playwright === null ? "Playwright is not installed here (require('playwright')): the page needs a browser to be measured" : false;

// ------------------------------------------------------------------ fixtures: the server's state over synthetic copies

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number, key = ["id"]): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key, rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name"), col("status"), col("created_at", "timestamptz"), col("api_token")], foreignKeys: [] });
// a long name, not added: it wraps whole, never cut (issue 884); and an added one of 60 characters with its schema
// (`public.` and 53), whose answer must keep its Dismiss in reach on a phone
const LONG = "customer_subscription_billing_events_archive_2026_full";
const NAMES = ["customers", "order_items", "invoices", "shipments", "billing_events_archive", "audit_trail", "visits", "payments", "raw_log", "customer_subscription_billing_events_archive_2026", LONG];
const TABLES = NAMES.map((n, i) => table(n, 1000 * (i + 1), n === "raw_log" ? [] : ["id"]));
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const FILE = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  order_items:\n    columns: [id, status]\n  invoices:\n    exclude: [api_token]\n" +
  `  shipments: {}\n  billing_events_archive: {}\n  payments: {}\n  ${LONG}: {}\n`, "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const at = "2026-11-11T09:00:00.000Z";
const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
const copied = (name: string): CopyState => ({ source: `public.${name}`, phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null, kept });
const COPIES: CopyState[] = ["customers", "order_items", "invoices", "shipments", "billing_events_archive", "payments", LONG].map(copied);
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
const synced = (table: string) => ({ at, tables: [{ table, added: 1, updated: 2, deleted: 1, rows: 1200, ms: 140 }], streamed: [] });
/** Each table's last sync by hand (`/api/state` `syncByHand`, issue 1007): `/api/sync` answers as it starts, and the
 *  state read after it says it ended, with what it did */
const byHand = new Map<string, unknown>();
let syncs = 0;
const stateNow = () => ({ ...STATE, tables: (STATE.tables as Array<{ table: string }>).map((t) => byHand.has(t.table) ? { ...t, syncByHand: byHand.get(t.table) } : t) });

// ------------------------------------------------------------------ the page, served as the run serves it

/** What the page asked of the run, as `<method> <path>`. */
const asked: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/api/")) asked.push(`${req.method} ${url.pathname}`);
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/state") return json(stateNow());
  if (url.pathname === "/api/usage") return json({ samples: [], copySizes: [] });
  // what the Sync choice and the column form read as they open (src/cli/sync-choice.ts, `mason tables <table> --json`)
  const form = /^\/api\/tables\/([^/]+)\/(sync|columns)$/.exec(url.pathname);
  if (form !== null) {
    const t = decodeURIComponent(form[1]!);
    if (form[2] === "columns") return json({ table: t, columns: ["id", "name", "status", "created_at", "api_token"].map((c) => ({ name: c, type: c === "id" ? "bigint" : "text", nullable: true, comment: null, references: null })) });
    return json({ table: t, sync: { value: "off", from: "default" }, rows: 1200, bigRows: false, live: { allowed: true, checks: [] },
      polls: [["poll 5m", 300], ["poll 15m", 900], ["poll 1h", 3600], ["poll 1d", 86_400]].map(([sync, seconds]) => ({ sync, seconds, cost: null })) });
  }
  if (url.pathname === "/api/pick" || url.pathname === "/api/sync") {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      const asked = JSON.parse(body) as { table?: string; tables?: string[] };
      if (url.pathname === "/api/pick") return json(added(asked.table!));
      const table = asked.tables![0]!;
      const sync = { id: ++syncs, tables: [table], state: "syncing", startedAt: at, endedAt: null };
      byHand.set(table, { ...sync, state: "synced", endedAt: at, answer: synced(table) });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ sync, already: false }));
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

async function open(width: number, o: { touch?: boolean; height?: number } = {}): Promise<Page> {
  browser ??= await playwright!.chromium.launch();
  // with touch, as a phone or a touch screen taps: the browser moves a tap to the nearest control under the finger
  const p = await browser.newPage({ viewport: { width, height: o.height ?? 900 }, ...(o.touch ? { hasTouch: true, isMobile: width < 641 } : {}) });
  await p.goto(`http://127.0.0.1:${await ready}/#tables`);
  await p.waitForSelector("#tables table.catalog tbody tr");
  await p.evaluate("document.fonts.ready.then(() => null)");
  return p;
}

/** 1000 to 1400 px, every 20 px, and 1024 (the width the owner met). */
const LAPTOP = [...Array.from({ length: 21 }, (_, i) => 1000 + 20 * i), 1024].sort((a, b) => a - b);

/** The list's columns as the browser lays them out: each header's width (0: hidden), the page's and the list's
 *  sideways scroll, and, for each hidden column, the rows whose note does not say its fact. */
/** Each list's columns as the browser lays them out (Added, then Not added): each header's width (0: hidden), the
 *  page's sideways scroll, and, for each hidden column, the rows whose note does not say its fact. */
const layout = (p: Page) => p.evaluate<{ lists: Array<{ cls: string; widths: Record<string, number> }>; page: number; unsaid: string[] }>(`(() => {
  const lists = [], unsaid = [];
  for (const table of document.querySelectorAll("#tables table.catalog")) {
    const widths = {};
    for (const th of table.querySelectorAll("thead th")) widths[[...th.classList].filter((c) => c !== "num")[0] || "act"] = Math.round(th.getBoundingClientRect().width);
    lists.push({ cls: table.className, widths });
    for (const [cls, w] of Object.entries(widths)) {
      if (cls === "name" || cls === "act" || cls === "state" || w > 2) continue;
      for (const tr of table.querySelectorAll("tbody tr:not(.under)")) {
        const note = tr.nextElementSibling;
        // a cell that says nothing (a table not added has no last sync) has nothing to say in the note either
        if (!(tr.querySelector("td." + cls)?.textContent ?? "").trim()) continue;
        const fold = note?.querySelector(".fold.f-" + cls);
        const name = tr.querySelector("code.name")?.textContent;
        // a fact's fold says it by its data-fold; a control's (Columns, Sync) is the control itself
        if (!fold || fold.getBoundingClientRect().width < 1 || !((fold.dataset.fold ?? "") || fold.textContent).trim()) unsaid.push(name + ": " + cls);
      }
    }
  }
  return { lists, page: document.documentElement.scrollWidth - window.innerWidth, unsaid };
})()`);

/** 375 and 390 px, 1000 to 1400 px every 20 px with 1024, and 1440 to 1600 px every 40 px. */
const EVERY = [375, 390, ...LAPTOP, 1440, 1480, 1520, 1560, 1600];

test(`each list's name column keeps a usable width at 375 px and every width from 1000 to 1600 px; a hidden column's fact is in the row's note; Not added has no Columns and no Sync (issue 1110)`, { skip: noBrowser }, async () => {
  for (const width of EVERY) {
    const p = await open(width);
    const l = await layout(p);
    await p.close();
    assert.deepEqual(l.lists.map((x) => x.cls), ["catalog", "catalog not-added"], `${width} px: Added, then Not added`);
    for (const { cls, widths } of l.lists) {
      // a phone's least width is the name, the state and the actions, less than 180 px for the name: it scrolls in its card
      if (width > 640) assert.ok((widths.name ?? 0) >= 180, `${width} px, ${cls}: the name column is ${widths.name} px wide (${JSON.stringify(widths)})`);
    }
    const [added, other] = l.lists.map((x) => x.widths);
    assert.ok("cols" in added! && "sync" in added!, `${width} px: Added has Columns and Sync`);
    assert.ok(!("cols" in other!) && !("sync" in other!), `${width} px: Not added has neither (${JSON.stringify(other)})`);
    // Not added's room goes to its name and its other columns: never fewer of them shown than Added, its name never narrower
    const shown = (w: Record<string, number>) => ["rows", "key", "last", "size"].filter((c) => (w[c] ?? 0) > 2);
    assert.ok(shown(other!).length >= shown(added!).length, `${width} px: Not added shows ${shown(other!)} where Added shows ${shown(added!)}`);
    if (width > 640) assert.ok(other!.name! >= added!.name! - 1 || shown(other!).length > shown(added!).length, `${width} px: Not added's name ${other!.name} px, Added's ${added!.name} px`);
    assert.ok(l.page <= 0, `${width} px: the page scrolls ${l.page} px sideways`);
    assert.deepEqual(l.unsaid, [], `${width} px: each hidden column's fact is in every row's note`);
  }
});

/** Each added table's Columns and Sync controls: how many of each are shown (a box laid out), where (its cell or its
 *  note), and whether a press at its centre reaches it. Read in the page, each scrolled to the window's middle. */
const controls = (p: Page) => p.evaluate<{ rows: number; out: string[]; where: Record<string, string> }>(`(() => {
  const out = [], where = {};
  const rows = [...document.querySelectorAll("#tables table.catalog tbody tr.c-added")];
  for (const tr of rows) {
    const name = tr.querySelector("code.name")?.getAttribute("title") ?? "?";
    const note = tr.nextElementSibling;
    for (const [what, attr] of [["columns", "data-choose"], ["sync", "data-choose-sync"]]) {
      const all = [...tr.querySelectorAll("[" + attr + "]"), ...note.querySelectorAll("[" + attr + "]")];
      const shown = all.filter((b) => b.getClientRects().length > 0);
      if (shown.length !== 1) { out.push(name + "'s " + what + ": " + shown.length + " shown"); continue; }
      const b = shown[0];
      where[what] = b.closest("tr.under") ? "note" : "column";
      b.scrollIntoView({ block: "center", inline: "nearest" });
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 16) { out.push(name + "'s " + what + " is " + Math.round(r.width) + " × " + Math.round(r.height) + " px"); continue; }
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      if (hit === null || !(hit === b || b.contains(hit))) out.push(name + "'s " + what + " is under " + (hit?.tagName ?? "nothing") + " at its centre");
      // its words whole: a label wider than its column wraps in its button, never cut
      if (b.scrollWidth > b.clientWidth + 0.5) out.push(name + "'s " + what + " is cut (" + b.scrollWidth + " > " + b.clientWidth + ")");
    }
  }
  return { rows: rows.length, out, where };
})()`);

/** Every row and cell of the list, and each header: where it is and how big, to the tenth of a pixel. */
const boxes = (p: Page) => p.evaluate<string[]>(`(() => {
  const b = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top + window.scrollY, r.width, r.height].map((x) => Math.round(x * 10) / 10).join(","); };
  return [...document.querySelectorAll("#tables table.catalog tr, #tables table.catalog tr > *")].map((e) => e.tagName + " " + b(e));
})()`);

/** 1000 to 1600 px every 40 px, 900 and 1024 (the icon rail; the width the owner met) and phones. */
const CONTROL_WIDTHS = [375, 390, 900, 1024, ...Array.from({ length: 16 }, (_, i) => 1000 + 40 * i)].sort((a, b) => a - b);

test(`each added table's Columns and Sync are shown once and can be pressed — in their columns, or in the note where those gave way — at 375 to 1600 px (issue 1110)`, { skip: noBrowser }, async () => {
  const seen: string[] = [];
  for (const width of CONTROL_WIDTHS) {
    const p = await open(width);
    const c = await controls(p);
    await p.close();
    assert.equal(c.rows, 7, `${width} px: the added tables`);
    assert.deepEqual(c.out, [], `${width} px: each control once, whole, and pressable`);
    seen.push(`${width}: ${c.where.columns}/${c.where.sync}`);
  }
  // both in their columns on a wide screen, both in the note on a phone
  assert.ok(seen.includes("1600: column/column") && seen.includes("375: note/note"), seen.join(", "));
});

for (const [what, attr, form] of [["the Sync choice", "data-choose-sync", "form[data-sync-form]"], ["the column form", "data-choose", "form[data-pick-form]"]] as const) {
  test(`opening ${what} moves no row, cell or column, and its popover is beside the control shown: 375, 900, 1024, 1280 and 1600 px (issue 1110)`, { skip: noBrowser }, async () => {
    for (const width of [375, 900, 1024, 1280, 1600]) {
      const p = await open(width);
      const sel = `#tables [${attr}="public.order_items"]`;
      await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.getClientRects().length).scrollIntoView({ block: "center" })`);
      const before = await boxes(p);
      await p.click(`${sel}:visible`);
      await p.waitForSelector(`.pop.ask:not([hidden]) ${form}`);
      await p.waitForTimeout(200);
      const after = await boxes(p);
      const beside = await p.evaluate<{ gap: number; right: number }>(`(() => {
        const pop = document.querySelector(".pop.ask:not([hidden])").getBoundingClientRect();
        const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length).getBoundingClientRect();
        // the popover under or over the control (4 px apart), or, too tall for either side, kept inside the window (placePops);
        // its right edge on the control's unless the window's gutter moved it
        const clamped = pop.top <= 16.5 || pop.bottom >= window.innerHeight - 16.5;
        return { gap: clamped ? 0 : Math.min(Math.abs(pop.top - b.bottom), Math.abs(b.top - pop.bottom)), right: Math.abs(pop.right - b.right) <= 1 || pop.left <= 16.5 || pop.right >= window.innerWidth - 16.5 ? 0 : pop.right - b.right };
      })()`);
      await p.close();
      assert.deepEqual(after.filter((x, i) => x !== before[i]), [], `${width} px: nothing moved`);
      assert.equal(after.length, before.length, `${width} px: no row or cell added`);
      assert.ok(beside.gap <= 5 && beside.right === 0, `${width} px: beside the control (${JSON.stringify(beside)})`);
    }
  });
}

/** Every table's name and state word that a person cannot read whole: cut inside its cell (its text past its box), not
 *  the table's name, outside the list's card, past the window, or under something laid over it (a pinned column). */
const unread = (p: Page) => p.evaluate<{ rows: number; out: string[] }>(`(() => {
  const out = [];
  const rows = [...document.querySelectorAll("#tables table.catalog tbody tr:not(.under)")];
  for (const tr of rows) {
    const code = tr.querySelector("code.name");
    const name = code?.getAttribute("title") ?? "?";
    const word = tr.querySelector("td.state .indicator");
    for (const [what, el, cell] of [["name", code, tr.querySelector("th.name")], ["state", word, tr.querySelector("td.state")]]) {
      if (!el) { if (what === "name") out.push(name + ": no name"); continue; }
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const said = name + "'s " + what + ' "' + el.textContent.trim() + '"';
      if (what === "name" && el.textContent !== name) out.push(said + " is not its name");
      if (el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5) out.push(said + " cut inside itself (" + el.scrollWidth + " > " + el.clientWidth + ")");
      if (cell.scrollWidth > cell.clientWidth + 0.5) out.push(said + " cut by its cell (" + cell.scrollWidth + " > " + cell.clientWidth + ")");
      const b = el.getBoundingClientRect(), card = (el.closest(".list") ?? document.body).getBoundingClientRect();
      if (b.left < card.left - 0.5 || b.right > card.right + 0.5) out.push(said + " outside the list's card");
      if (b.right > window.innerWidth + 0.5) out.push(said + " past the window");
      // read at each of its lines' ends and middle: what is there is it, never a column pinned over it
      for (const r of el.getClientRects()) {
        for (const x of [r.left + 1, (r.left + r.right) / 2, r.right - 1]) {
          const hit = document.elementFromPoint(x, (r.top + r.bottom) / 2);
          if (hit === null || !(el.contains(hit) || hit.contains(el))) { out.push(said + " under " + (hit?.tagName ?? "nothing") + " at " + Math.round(x)); break; }
        }
      }
    }
  }
  return { rows: rows.length, out };
})()`);

test(`every table's name and state are read whole — wrapped, never cut — at 390 px and every 20 px from 1000 to 1400 px, the page never scrolling sideways`, { skip: noBrowser }, async () => {
  for (const width of [390, ...LAPTOP]) {
    const p = await open(width);
    const u = await unread(p);
    const page = await p.evaluate<number>("document.documentElement.scrollWidth - window.innerWidth");
    await p.close();
    assert.equal(u.rows, NAMES.length, `${width} px: a row for each table`);
    assert.deepEqual(u.out, [], `${width} px: every name and state read whole`);
    assert.ok(page <= 0, `${width} px: the page scrolls ${page} px sideways`);
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

// ------------------------------------------------------------------ a finger on the answer (the owner's re-check of PR 901)

/** The page's requests that change something (an Add, a Sync, a Remove), from `asked` past `from`. */
const changes = (from: number) => asked.slice(from).filter((a) => !a.startsWith("GET "));
/** The answer shown: its box, whether it is docked at the window's bottom, and its own buttons' boxes. */
const answerBox = (p: Page) => p.evaluate<{ left: number; top: number; right: number; bottom: number; docked: boolean; own: number[][] }>(`(() => {
  const e = [...document.querySelectorAll(".pop.said")].find((x) => !x.hidden);
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, docked: e.classList.contains("docked"),
    own: [...e.querySelectorAll("button, a[href]")].map((b) => { const q = b.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom]; }) };
})()`);

for (const [what, attr] of [["Add", "data-add-table"], ["Sync now", "data-sync-table"]] as const) {
  test(`after ${what}, a finger's tap 1 to 8 px inside the answer's edges reaches nothing under it (touch): 390, 1024, 1080 and 1280 px`, { skip: noBrowser }, async () => {
    for (const [width, height] of [[390, 844], [1024, 768], [1080, 800], [1280, 800]] as const) {
      const p = await open(width, { touch: true, height });
      // the second row that has it, as the re-check pressed
      const name = await p.evaluate<string>(`[...document.querySelectorAll("button[${attr}]")][1].getAttribute("${attr}")`);
      await p.evaluate(`document.querySelector('button[${attr}="${name}"]').scrollIntoView({ block: "center" })`);
      await p.tap(`button[${attr}="${name}"]`);
      await p.waitForSelector(".pop.said:not([hidden]) .headline");
      await p.waitForTimeout(300);
      const a = await answerBox(p);
      const points: Array<[number, number]> = [];
      for (const d of [1, 2, 4, 8]) {
        for (let x = a.left + d; x < a.right - d; x += 40) { points.push([x, a.top + d]); points.push([x, a.bottom - d]); }
        for (let y = a.top + d; y < a.bottom - d; y += 40) { points.push([a.left + d, y]); points.push([a.right - d, y]); }
      }
      // its own buttons answer a tap (Dismiss): a finger near one is left to it
      const nearOwn = ([x, y]: [number, number]) => a.own.some(([l, t, r, b]) => x > l! - 24 && x < r! + 24 && y > t! - 24 && y < b! + 24);
      const out: string[] = [];
      for (const [x, y] of points.filter(([x, y]) => x > 0 && y > 0 && x < width && y < height && !nearOwn([x, y]))) {
        const from = asked.length;
        await p.touchscreen.tap(x, y);
        await p.waitForTimeout(40);
        const gone = !(await p.evaluate<boolean>(`[...document.querySelectorAll(".pop.said")].some((e) => !e.hidden)`));
        const got = changes(from);
        const opened = await p.evaluate<boolean>(`!!document.querySelector(".pop.ask:not([hidden])")`);
        if (got.length || gone || opened) { out.push(`${Math.round(x)},${Math.round(y)}: ${got.join(", ") || (gone ? "the answer went" : "a form opened")}`); break; }
      }
      await p.close();
      assert.deepEqual(out, [], `${width} px, ${a.docked ? "docked" : "beside its row"}: a tap on the answer is the answer's`);
    }
  });
}

test("on a phone, a tap just inside the docked answer's top edge never reaches an Add 2 px above it (touch)", { skip: noBrowser }, async () => {
  const p = await open(390, { touch: true, height: 844 });
  await p.tap('button[data-sync-table="public.order_items"]');
  await p.waitForSelector(".pop.said.docked:not([hidden]) .headline");
  await p.waitForTimeout(300);
  const out: string[] = [];
  for (const depth of [1, 1.5, 3, 5, 8]) {
    // a not-added table's Add, its bottom 2 px above the answer's top
    const at = await p.evaluate<{ x: number; top: number }>(`(() => {
      const bar = [...document.querySelectorAll(".pop.said.docked")].find((e) => !e.hidden).getBoundingClientRect();
      const add = document.querySelector("button[data-add-table]");
      window.scrollBy(0, add.getBoundingClientRect().bottom - (bar.top - 2));
      const b = add.getBoundingClientRect();
      return { x: (b.left + b.right) / 2, top: [...document.querySelectorAll(".pop.said.docked")].find((e) => !e.hidden).getBoundingClientRect().top };
    })()`);
    await p.waitForTimeout(200);
    const from = asked.length;
    await p.touchscreen.tap(at.x, at.top + depth);
    await p.waitForTimeout(300);
    if (changes(from).length) out.push(`${depth} px in: ${changes(from).join(", ")}`);
  }
  await p.close();
  assert.deepEqual(out, [], "the Add above the answer is never pressed by a tap on the answer");
});

test(`on a phone, the answer for a table of a 60-character name keeps its Dismiss in view, unmoved by the page's redraws, and a tap on it dismisses (touch)`, { skip: noBrowser }, async () => {
  const p = await open(390, { touch: true, height: 844 });
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    await p.evaluate(`document.querySelector('button[data-sync-table="public.${LONG}"]').scrollIntoView({ block: "center" })`);
    await p.tap(`button[data-sync-table="public.${LONG}"]`);
    await p.waitForSelector(".pop.said:not([hidden]) .headline");
    // a while, the page redrawn by its polls meanwhile (every 2 s)
    await p.waitForTimeout(500 + i * 1100);
    const seen = await p.evaluate<{ ok: boolean; why: string }>(`(() => {
      const pop = [...document.querySelectorAll(".pop.said")].find((e) => !e.hidden);
      const d = [...pop.querySelectorAll("button")].find((b) => b.textContent.trim() === "Dismiss");
      if (!d) return { ok: false, why: "no Dismiss" };
      const b = d.getBoundingClientRect(), a = pop.getBoundingClientRect();
      if (b.top < Math.max(0, a.top) - 0.5 || b.bottom > Math.min(window.innerHeight, a.bottom) + 0.5) return { ok: false, why: "Dismiss at " + Math.round(b.top) + "-" + Math.round(b.bottom) + ", the answer seen " + Math.round(a.top) + "-" + Math.round(Math.min(window.innerHeight, a.bottom)) };
      const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
      return hit !== null && d.contains(hit) ? { ok: true, why: "" } : { ok: false, why: "Dismiss under " + (hit?.tagName ?? "nothing") };
    })()`);
    if (!seen.ok) { out.push(`try ${i + 1}: ${seen.why}`); continue; }
    // what a person scrolled in the answer stays where they put it across a redraw
    const kept = await p.evaluate<{ before: number; after: number } | null>(`new Promise((done) => {
      const pop = [...document.querySelectorAll(".pop.said")].find((e) => !e.hidden);
      if (pop.scrollHeight <= pop.clientHeight + 1) return done(null);
      pop.scrollTop = pop.scrollHeight;
      const before = pop.scrollTop;
      setTimeout(() => done({ before, after: [...document.querySelectorAll(".pop.said")].find((e) => !e.hidden).scrollTop }), 2600);
    })`);
    if (kept !== null && Math.abs(kept.after - kept.before) > 1) out.push(`try ${i + 1}: the answer's scroll went from ${kept.before} to ${kept.after} at a redraw`);
    await p.tap('.pop.said:not([hidden]) button[data-pop-close]');
    await p.waitForTimeout(300);
    if (await p.evaluate<boolean>(`[...document.querySelectorAll(".pop.said")].some((e) => !e.hidden)`)) out.push(`try ${i + 1}: a tap on Dismiss left the answer`);
  }
  await p.close();
  assert.deepEqual(out, [], "Dismiss in view and dismissing, every time");
});

// THE ROOM AT THE PAGE'S END IS ONLY FOR AN ANSWER SHOWN (issue 1049's review): an answer docked on Tables and not
// dismissed kept its room on every other page, which then ended in about 290 px of blank space
test("on a phone, an answer docked on Tables keeps no room at the end of another page, and has it again back on Tables", { skip: noBrowser }, async () => {
  const p = await open(390);
  const room = () => p.evaluate<string>(`getComputedStyle(document.body).paddingBottom`);
  const settle = () => p.evaluate("new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 300))");
  await p.evaluate(`document.querySelector('button[data-sync-table="public.${LONG}"]').scrollIntoView({ block: "center" })`);
  await p.click(`button[data-sync-table="public.${LONG}"]`);
  await p.waitForSelector(".pop.said.docked:not([hidden])");
  await settle();
  const onTables = await room();
  assert.notEqual(onTables, "0px", "docked on Tables: the page's end gives it room");
  const found: string[] = [];
  for (const hash of ["#overview", "#users", "#observability/queries", "#observability/usage", "#observability/syncs"]) {
    await p.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await settle();
    const r = await room();
    if (r !== "0px") found.push(`${hash}: the page's end keeps ${r} for an answer it does not show`);
  }
  await p.evaluate(`location.hash = "#tables"`);
  await settle();
  const back = await room();
  await p.close();
  assert.deepEqual(found, [], "no room on another page");
  assert.notEqual(back, "0px", "back on Tables, the answer still shown has its room again");
});
