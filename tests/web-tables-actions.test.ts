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
  goto(url: string): Promise<unknown>; waitForSelector(s: string, o?: { state?: string; timeout?: number }): Promise<unknown>; click(s: string): Promise<void>; fill(s: string, v: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  evaluate<T = unknown>(expression: string): Promise<T>; screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>; close(): Promise<void>;
};
type Browser = { newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor?: number; colorScheme?: "light" | "dark" }): Promise<Page>; close(): Promise<void> };
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
  return o.sourcesReadOnly ? { ...s, sourcesReadOnly: o.sourcesReadOnly, sourcesReadOnlyKind: "deployed" } : s;
}
const MODES: Record<string, Record<string, unknown>> = {
  "editable": stateOf(),
  "sources read-only": stateOf({ sourcesReadOnly: "The project's files are read-only here (MASON_PROJECT_READONLY=1). Run mason add or mason remove in your project, commit the change, and deploy it." }),
  "page read-only": stateOf({ pageReadOnly: true }),
  "page read-only, tables allowed": stateOf({ pageReadOnly: true, allow: ["tables"] }),
};

// ------------------------------------------------------------------ the page, served as the run serves it

let mode = "editable";
/** An Add or a Sync held unanswered while not null: the row says Adding… or Syncing… until each is released. */
let held: Array<() => void> | null = null;
/** Every change the page sends (any method but GET), held while not null: the test answers each (`answerHeld`). */
let pending: Array<{ path: string; res: http.ServerResponse }> | null = null;
/** Whether every change is cut as it comes (`answerHeld("network")`). */
let cutting = false;
/** The users, the running queries, a cloud login: what the Users and Usage pages read. */
const USERS = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: at, live: true, from: null },
  { name: "looker", id: "fedcba9876543210", addedAt: at, disabledAt: at, live: true, from: ["192.0.2.0/24"] }], lastUsedNote: null, requestLogDays: 7 };
const RUNNING = { running: [{ session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY", startedAt: at, runningMs: 1500, rows: 0, query: "SELECT count(*) FROM orders", queryTruncated: false }] };
const LISTED = { user: "share_a1b2c3", from: "page", role: null, reads: "every synced table", openedAt: at, via: "pinggy", host: "relay.example", port: 41234, endsAt: null, state: "up" };
const shareOf = (s: Record<string, unknown>, open: boolean) => ({ ...s, share: open ? { port: 40001, fingerprint: "AA", sessions: 0, refusedLogins: 0, droppedConnections: 0, shares: [LISTED] } : null, shareEnded: null });
const choiceOf = (name: string) => ({ table: name, sync: { value: "off", from: "default" }, rows: 1200, polls: [{ sync: "poll 5m", seconds: 300, cost: null }], bigRows: false,
  live: { allowed: true, checks: [{ name: "wal_level", state: "ok", detail: "logical" }] } });
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  // the network failing: the browser tries a change again on a fresh connection once its first is cut, so each is cut
  if (req.method !== "GET" && cutting) { res.socket?.destroy(); return; }
  if (req.method !== "GET" && pending !== null) { pending.push({ path: url.pathname, res }); return; }
  if (url.pathname === "/api/state") return json(mode === "cloud login open" ? shareOf(MODES.editable!, true) : MODES[mode]);
  if (url.pathname === "/api/usage") return json({ since: at, until: at, stepSeconds: 60, sampleSeconds: 60, keptDays: 7, samples: [], copySizes: [] });
  if (url.pathname === "/api/activity") return json({ since: at, keptDays: 7, clients: [], slowest: [], clientsTotal: { clients: 0, sessions: 0 },
    window: { days: 1, covered: 1, statements: 0, completed: 0, refused: 0, failed: 0, cancelled: 0, rows: 0, bytesSent: 0, durationMs: { avg: 0, p50: 0, p95: 0 } } });
  if (url.pathname === "/api/unsupported") return json({ since: at, unsupported: [], keptDays: 7 });
  if (url.pathname === "/api/users") return json(USERS);
  if (url.pathname === "/api/share/choices") return json({ choices: [], role: null, reads: "every synced table" });
  if (url.pathname === "/api/running") return json(RUNNING);
  const tableRead = /^\/api\/tables\/([^/]+)\/(columns|sync)$/.exec(url.pathname);
  if (tableRead) return json(tableRead[2] === "sync" ? choiceOf(decodeURIComponent(tableRead[1]!)) : { table: decodeURIComponent(tableRead[1]!), columns: [col("id", "bigint"), col("name")] });
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
      const card = r(td.closest(".list") ?? document.body);
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
        list: ((e) => e ? e.scrollWidth - e.clientWidth : 0)(document.querySelector("#tables table.catalog")?.closest(".list") ?? null) })`);
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

// ------------------------------------------------------------------ every action: nothing moves while it is sent, nor when it fails (issue 1033)

/** Each action of the pages, as a person does it: the page it is on, what opens it (a question, a form), what to type,
 *  and the control that sends the change. */
const ACTIONS: Array<{ name: string; hash: string; mode?: string; wait: string; open?: string; fill?: [string, string]; send: string }> = [
  { name: "Sync now", hash: "#tables", wait: "#tables table.catalog tbody tr", send: 'button[data-sync-table="public.customers"]' },
  { name: "Remove a table", hash: "#tables", wait: "#tables table.catalog tbody tr", open: 'button[data-remove-table="public.customers"]', send: 'button[data-confirm-remove-table="public.customers"]' },
  { name: "Add", hash: "#tables", wait: "#tables table.catalog tbody tr", send: 'button[data-add-table="public.audit"]' },
  { name: "Add with Columns…", hash: "#tables", wait: "#tables table.catalog tbody tr", open: 'button[data-choose="public.audit"]', send: 'form[data-pick-form="public.audit"] button[type="submit"]' },
  { name: "a table's columns saved", hash: "#tables", wait: "#tables table.catalog tbody tr", open: 'button[data-choose="public.customers"]', send: 'form[data-pick-form="public.customers"] button[type="submit"]' },
  { name: "a table's sync saved", hash: "#tables", wait: "#tables table.catalog tbody tr", open: 'button[data-choose-sync="public.customers"]', send: 'form[data-sync-form="public.customers"] button[type="submit"]' },
  { name: "Disable", hash: "#users", wait: "#users table.users tbody tr", open: 'button[data-disable="metabase"]', send: 'button[data-confirm-disable="metabase"]' },
  { name: "Enable", hash: "#users", wait: "#users table.users tbody tr", send: 'button[data-enable="looker"]' },
  { name: "Remove a user", hash: "#users", wait: "#users table.users tbody tr", open: 'button[data-remove="metabase"]', send: 'button[data-confirm-remove="metabase"]' },
  { name: "From…", hash: "#users", wait: "#users table.users tbody tr", open: 'button[data-from="metabase"]', send: '#user-from button[type="submit"]' },
  { name: "Add a user", hash: "#users", wait: "#add-user", fill: ["#user-name", "grafana"], send: "#add-user-submit" },
  { name: "Open a cloud login", hash: "#users", wait: "#add-user", open: 'button[data-add-kind="share"]', send: "#share-open:not([disabled])" },
  { name: "Stop a cloud login", hash: "#users", mode: "cloud login open", wait: "#share-stop", send: "#share-stop" },
  { name: "Cancel a query", hash: "#observability/usage", wait: "#usage-running table tbody tr", open: 'button[data-ask-cancel="4:9"]', send: 'button[data-confirm-cancel="4:9"]' },
];

/** Every row and every button of the shown page outside a popover, and the add box and the Connect panel: what a click
 *  must not move. Read in the page, as JavaScript. */
const layout = (p: Page) => p.evaluate<{ rows: string[]; buttons: string[] }>(`(() => {
  const section = document.querySelector("main section:not([hidden])");
  const box = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top + window.scrollY, b.width, b.height].map((x) => Math.round(x)).join(","); };
  const outside = (e) => e.closest(".pop") === null && e.getClientRects().length > 0;
  return { rows: [...section.querySelectorAll("tr, .connect, .add-box, form#add-user")].filter(outside).map((e) => e.tagName + " " + box(e)),
  // (a Copy sends nothing, and its room, "Press ⌘C", is drawn by a fallback font the browser loads in its own time, which
  // moves its width whatever the page does: left out)
    buttons: [...section.querySelectorAll("button:not([data-copy])")].filter(outside).map((e) => (e.dataset.room ?? e.textContent.trim()) + " " + box(e)) };
})()`);

/** The popover that says a failure, and every control it covers: none, wherever it is put. */
const failureCovers = (p: Page) => p.evaluate<{ found: boolean; docked: boolean; inForm: boolean; covers: string[]; given: boolean }>(`(() => {
  const pop = [...document.querySelectorAll(".pop:not([hidden])")].find((e) => e.querySelector(".failure"));
  if (!pop) return { found: false, docked: false, inForm: false, covers: [], given: false };
  // a refusal of what a form sent is said over the form, in the form's own popover, which stood where it is before
  if (pop.getAttribute("role") === "dialog") return { found: true, docked: false, inForm: true, covers: [], given: false };
  const r = pop.getBoundingClientRect();
  const covers = [...document.querySelectorAll("button, a[href], input, select, textarea, summary")]
    .filter((c) => !pop.contains(c) && c.closest(".pop") === null && c.closest("[hidden]") === null && getComputedStyle(c).visibility !== "hidden")
    .filter((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left < r.right - 0.5 && b.right > r.left + 0.5 && b.top < r.bottom - 0.5 && b.bottom > r.top + 0.5; })
    .map((c) => c.tagName + " " + (c.id || c.textContent.trim().slice(0, 30)));
  // docked: the page's end is given its height, so every control can be scrolled clear of it
  const given = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--docked-h")) >= r.height - 1;
  return { found: true, docked: pop.classList.contains("docked"), inForm: false, covers, given };
})()`);

/** Answer every change held: refused by the run (409 and its Failure), or the connection cut (the network failed). */
const answerHeld = (how: "refused" | "network"): number => {
  const list = pending?.splice(0) ?? [];
  for (const h of list) {
    if (how === "network") { cutting = true; h.res.socket?.destroy(); continue; }
    h.res.writeHead(409, { "content-type": "application/json" });
    h.res.end(JSON.stringify({ error: "refused by the test", failure: { code: "refused", message: "refused by the test", next: [] } }));
  }
  return list.length;
};

const LAYOUT_WIDTHS = [1280, 390, 375] as const;
test(`every action of Tables, Users and Usage: rows and buttons keep their place and size while it is sent and once it fails; its failure covers no other control (at ${LAYOUT_WIDTHS.join(", ")} px)`, { skip: noBrowser }, async () => {
  browser ??= await playwright!.chromium.launch();
  const problems: string[] = [];
  const docked = new Set<string>();
  for (const width of LAYOUT_WIDTHS) {
    for (const a of ACTIONS) {
      for (const how of ["refused", "network"] as const) {
        const what = `${width} px, ${a.name} (${how})`;
        mode = a.mode ?? "editable";
        pending = [];
        cutting = false;
        const p = await browser.newPage({ viewport: { width, height: 900 } });
        await p.goto(`http://127.0.0.1:${await ready}/${a.hash}`);
        await p.waitForSelector(a.wait);
        await p.evaluate("document.fonts.ready.then(() => null)");
        // a glyph a fallback font draws (Copy's room, ⌘) is laid out once that font is loaded: measured after it
        await p.evaluate("new Promise((r) => setTimeout(r, 400)).then(() => document.fonts.ready).then(() => null)");
        if (a.open) { await p.click(a.open); await p.waitForSelector(a.send); }
        if (a.fill) await p.fill(a.fill[0], a.fill[1]);
        const idle = await layout(p);
        await p.click(a.send);
        await p.waitForSelector('button[aria-busy="true"]:disabled');
        const busy = await layout(p);
        if (pending.length !== 1) problems.push(`${what}: ${pending.length} changes sent`);
        answerHeld(how);
        await p.waitForSelector(".pop .failure");
        await p.waitForSelector('button[aria-busy="true"]', { state: "detached" });
        const failed = await layout(p);
        const cover = await failureCovers(p);
        // what the person sees as it failed, where they are on the page (never scrolled away first)
        if (SHOTS !== null) await p.screenshot({ path: path.join(SHOTS, `actions-${a.name.replace(/[^a-z]+/gi, "-").toLowerCase()}-${how}-${width}.png`) });
        // Escape: the failure goes, and still nothing moved
        await p.keyboard.press("Escape");
        await p.waitForSelector(".pop .failure", { state: "detached" });
        const dismissed = await layout(p);
        await p.close();
        pending = null;
        cutting = false;
        for (const [when, l] of [["while it is sent", busy], ["once it failed", failed], ["once dismissed", dismissed]] as const) {
          const moved = (k: "rows" | "buttons") => l[k].length !== idle[k].length ? [`${k}: ${idle[k].length} then ${l[k].length}`]
            : l[k].flatMap((x, i) => x === idle[k][i] ? [] : [`${idle[k][i]} → ${x}`]);
          for (const m of [...moved("rows"), ...moved("buttons")]) problems.push(`${what}, ${when}: ${m}`);
        }
        if (!cover.found) problems.push(`${what}: no failure said`);
        // WHERE EVERY PLACE IN THE WINDOW COVERS A CONTROL (a phone's page of controls), a failure is the bar fixed at the
        // window's bottom (`placePops`, issue 884), the page given its height so every control scrolls clear of it;
        // anywhere else it covers none
        if (cover.docked) { if (!cover.given) problems.push(`${what}: docked, but the page is not given its height`); docked.add(`${width} px, ${a.name} (${how})`); }
        else if (cover.covers.length > 0) problems.push(`${what}: its failure covers ${cover.covers.join("; ")}`);
      }
    }
  }
  // a laptop's window always has a place that covers no control
  assert.deepEqual([...docked].filter((d) => d.startsWith("1280 ")), [], "at 1280 px no failure is docked");
  assert.deepEqual(problems, []);
});
