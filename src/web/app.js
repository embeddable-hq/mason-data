/**
 * THE WEB PAGE OF `mason start` (`mason ui`; docs/WEB-UI.md, and .claude/rules/web-ui.md for whoever builds it out):
 * the SHELL — a nav of four tabs (Overview · Tables · Users · Observability, the last with three sub-tabs: Queries ·
 * Usage · Logs) and one section per page, the one shown chosen by the URL's hash (`#overview`, the default; an unknown
 * hash is the Overview; `#observability/queries?range=24h`, the shared time range of the three) — over the pages, each an ES module of src/web/pages/ rendered from the run's command
 * server's JSON (src/cli/run-server.ts) in the words the commands print.
 *
 * Plain JavaScript, ES modules, no framework and no build step: the server serves each file as it is (PAGE_ROUTES),
 * under a `default-src 'self'` policy. The renderers are PURE FUNCTIONS OF THE JSON, returning HTML strings (every
 * value escaped), exported so tests/web-page.test.ts runs them under node; `createApp` holds what the page knows and
 * does, over a `fetch` it is handed; `start` (a browser only) wires them to the document. The page never holds the
 * run's token: the browser's cookie carries it (src/cli/security.ts); of the address it reads the hash alone.
 *
 * THE PAGE MODULE CONTRACT (src/web/pages/<id>.js), so a page is built without touching the others:
 *
 *   export const page = { id, title, hash?, parent?, create(ctx) }
 *     id      its section (<section id="page-<id>"> in index.html) and its route (/pages/<id>.js); its hash too, unless
 *     hash    says another (`overview`, `observability/queries`): the address it is shown at
 *     title   its link in the nav (a tab; a sub-tab under its `parent`'s tab, `observability`, whose pages share the
 *             time range: ctx.range())
 *     create(ctx) → {
 *       reads()        [{ path, everyMs }]: what it reads WHILE SHOWN, each at its own rate (everyMs ≤ POLL_MS: every
 *                      poll); a path is the store's key, so a path built from the page's own state (a filter, a page
 *                      of results) is read as that state changes. The FIRST is the page's own: its failure is the
 *                      banner at the top (`poll`); the page renders the others' failures itself.
 *       view()         { <element id>: html }: the parts of its section it writes, from ctx.read and its own state
 *       actions        { name: fn }: what its buttons do, merged onto the app (the tests drive them); each re-reads
 *                      what it changed with ctx.refresh([path])
 *       afterRead?()   after a poll stored its reads: drop what the new data made stale (a confirm for a row gone)
 *       click?(dataset, button, { doc, win })  a button of its section clicked: null when not its, else a value or a
 *                      promise (the shell writes the page again once it settles)
 *       submit?(form, FormData)  a form submitted: null when not its, else a promise (the shell prevents the default)
 *       input?(target)  an input changed: null when not its
 *       toggle?(target)  a <details> opened or closed: null when not its, else a value or a promise (as `click`);
 *                      a details that must stay open across a refresh is `details(key, …)` of shared.js, its open set
 *                      `createOpenSet()` in the page's state, whose `toggle` this is
 *       charts?()      { <holder key>: spec }: the charts drawn in its holders after each write (src/web/charts.js; a
 *                      progressive addition: every number a chart draws is also text)
 *       route?(params, { doc })  the hash showed it with these parameters (`#tables?show=failed`: { show: "failed" }):
 *                      it takes the ones it knows into its state (and a control outside its parts, through `doc`)
 *       model?         its state, for the tests
 *     }
 *     ctx = { ask(path, init) → { body } | { failure }, read(path) → { body, failure } | undefined (body: the last
 *             one read; failure: this read's, else null), refresh(paths) → Promise (read them now), now() → Date,
 *             range() → a key of RANGES: the time range the Observability pages share (from the hash) }
 *
 * A page is registered by its import and its place in PAGES below, its route in PAGE_ROUTES, and its section in
 * index.html.
 */
import { esc, badge, createAsk, renderFailure, updatedText, RANGES, DEFAULT_RANGE, rangeOf } from "./shared.js";
import { createCharts } from "./charts.js";
import { page as statusPage } from "./pages/status.js";
import { page as tablesPage } from "./pages/tables.js";
import { page as queriesPage } from "./pages/queries.js";
import { page as usersPage } from "./pages/users.js";
import { page as usagePage } from "./pages/usage.js";
import { page as logsPage } from "./pages/logs.js";

// every renderer the tests import from here, wherever it lives now
export * from "./shared.js";
export { copyingText, tableLine, sourceRows, renderStatus } from "./pages/status.js";
export { tableFacts, addedLines, removedReport, pickBody, renderTableAdded, renderTablesRemoved, renderTables } from "./pages/tables.js";
export { renderUsers, renderAdded } from "./pages/users.js";
export { renderRunning, renderRequests, renderSessions } from "./pages/queries.js";

/** The pages, in the nav's order: a page with a `parent` is a sub-tab of its parent's tab. */
export const PAGES = [statusPage, tablesPage, usersPage, queriesPage, usagePage, logsPage];

/** How often the shown page is asked while the tab is seen: its fastest reads every poll, the slower ones when due. */
export const POLL_MS = 2000;

/** The tabs a parent stands for: its title, and the first of its pages is where its tab goes. */
const GROUPS = { observability: { title: "Observability" } };

/** The hashes of before the Observability tab, and the tab's own: each lands on the view it was (`#status` the Overview). */
const ALIASES = { status: "status", queries: "queries", usage: "usage", logs: "logs", observability: "queries" };

const hashOfPage = (p) => p.hash ?? p.id;

/**
 * WHAT A HASH SHOWS: the page (`#tables`, `#observability/usage`, an old one — `#status`, `#queries` — the view it was;
 * none, or one it does not know, the Overview) and the parameters after its `?` (`range=7d`, `show=failed`).
 */
export function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const at = raw.indexOf("?");
  const where = at < 0 ? raw : raw.slice(0, at);
  const params = Object.fromEntries(new URLSearchParams(at < 0 ? "" : raw.slice(at + 1)));
  const page = PAGES.find((p) => hashOfPage(p) === where)?.id ?? ALIASES[where] ?? "status";
  return { id: page, params };
}

/** A page's address with its parameters (`hashOf("queries", { range: "7d" })` → `#observability/queries?range=7d`); the
 *  default range is left out, so the plain address is the 24 hours. */
export function hashOf(id, params = {}) {
  const p = PAGES.find((x) => x.id === id) ?? PAGES[0];
  const q = new URLSearchParams(Object.entries(params).filter(([k, v]) => v !== undefined && v !== "" && !(k === "range" && v === DEFAULT_RANGE)));
  const qs = q.toString();
  return `#${hashOfPage(p)}${qs ? `?${qs}` : ""}`;
}

/** The tabs, in order: a page of its own, or a group standing for its pages (`pages`), at the place of its first. */
export function tabs() {
  const list = [];
  for (const p of PAGES) {
    if (!p.parent) { list.push({ id: p.id, title: p.title, pages: [p.id] }); continue; }
    const tab = list.find((t) => t.id === p.parent);
    if (tab) tab.pages.push(p.id); else list.push({ id: p.parent, title: GROUPS[p.parent]?.title ?? p.parent, pages: [p.id] });
  }
  return list;
}

/** The nav: a link per tab, the one holding the page shown marked as the current page; a group's link keeps the range. */
export const renderNav = (shown, range = DEFAULT_RANGE) => `<ul>${tabs().map((t) => {
  const to = t.id !== t.pages[0] ? hashOf(t.pages[0], { range }) : hashOf(t.id);
  return `<li><a href="${esc(to)}"${t.pages.includes(shown) ? ` aria-current="page"` : ""}>${esc(t.title)}</a></li>`;
}).join("")}</ul>`;

/**
 * THE SUB-NAV of a group's page (the Observability tab's): its pages as a secondary underline nav, then the time range
 * they share as a segmented control — each a link to the same view at that range, so the hash is the state and Back
 * goes to the range before. "" for a page of its own.
 */
export function renderSubnav(shown, range = DEFAULT_RANGE) {
  const p = PAGES.find((x) => x.id === shown);
  if (!p?.parent) return "";
  const siblings = PAGES.filter((x) => x.parent === p.parent);
  const r = rangeOf(range);
  return `<nav class="subtabs" aria-label="${esc(GROUPS[p.parent]?.title ?? p.parent)}"><ul>${siblings.map((x) =>
    `<li><a href="${esc(hashOf(x.id, { range: r }))}"${x.id === shown ? ` aria-current="page"` : ""}>${esc(x.title)}</a></li>`).join("")}</ul></nav>` +
    `<div class="range" role="group" aria-label="Time range">${Object.entries(RANGES).map(([k, v]) =>
      `<a href="${esc(hashOf(shown, { range: k }))}"${k === r ? ` aria-current="true"` : ""}>${esc(v.label)}</a>`).join("")}</div>`;
}

/** The heading's line: the database the run copies, and its sources file's name when that is another. */
function renderWhere(s) {
  return `${esc(s.source.database)}${s.source.name && s.source.name !== s.source.database ? ` · source ${esc(s.source.name)}` : ""}`;
}

/**
 * THE PAGE'S STATE AND ACTIONS, over `fetch` (the browser's, or a test's): `show(id)` chooses the page shown, `poll`
 * reads ITS reads that are due (no other page's), each page's actions are the app's own (addUser, addTable, …), and
 * `view()` is the HTML of every part of the page, from what it knows now. Nothing here touches a document.
 */
export function createApp(fetchFn, now = () => new Date(), shown = "status") {
  const ask = createAsk(fetchFn);
  // what was read, by path: the last body, this read's failure (null when it answered), when it was asked
  const store = new Map();
  const first = parseHash(shown);
  const m = { shown: first.id, range: rangeOf(first.params.range), pollFailure: null, updatedAt: null };
  const put = (path, at, r) => {
    const was = store.get(path);
    store.set(path, { at, body: "body" in r ? r.body : was?.body, failure: "failure" in r ? r.failure : null });
    if ("body" in r) m.updatedAt = now();
  };
  const pages = new Map();
  const afterRead = () => { for (const p of pages.values()) p.afterRead?.(); };
  const refresh = async (paths) => {
    const at = now().getTime();
    const rs = await Promise.all(paths.map((p) => ask(p)));
    paths.forEach((p, i) => put(p, at, rs[i]));
    afterRead();
  };
  const ctx = { ask, now, refresh, range: () => m.range, read: (path) => { const e = store.get(path); return e === undefined ? undefined : { body: e.body, failure: e.failure }; } };
  for (const p of PAGES) pages.set(p.id, p.create(ctx));
  const app = {
    model: m,
    pages,
    /** Show what a hash (or a page's id) says: the page, the range when it is a group's page, and its parameters
     *  handed to the page (`route`); `env.doc` the document, for a control outside the parts. */
    show(hash, env = {}) {
      const r = parseHash(hash);
      m.shown = r.id;
      if (PAGES.find((p) => p.id === r.id)?.parent) m.range = rangeOf(r.params.range);
      pages.get(r.id).route?.(r.params, env);
    },
    /** Read the shown page's reads that are due: those at the poll's rate every time, the slower ones once their time is up. */
    async poll() {
      const page = pages.get(m.shown);
      const reads = page.reads();
      const at = now().getTime();
      const due = reads.filter((r) => r.everyMs <= POLL_MS || !store.has(r.path) || at - store.get(r.path).at >= r.everyMs - POLL_MS / 2);
      const rs = await Promise.all(due.map((r) => ask(r.path)));
      due.forEach((r, i) => put(r.path, at, rs[i]));
      const own = reads[0] === undefined ? undefined : store.get(reads[0].path);
      m.pollFailure = own?.failure ?? null;
      afterRead();
    },
    view() {
      const st = store.get("/api/state")?.body;
      return {
        nav: renderNav(m.shown, m.range),
        subnav: renderSubnav(m.shown, m.range),
        where: st ? renderWhere(st) : "",
        // the demo database is said beside its name, so a person never takes it for their own
        badge: st?.source?.demo ? badge("demo", "accent") : "",
        updated: m.updatedAt ? esc(updatedText(m.updatedAt, now())) : "",
        poll: m.pollFailure ? renderFailure(m.pollFailure) : "",
        ...Object.assign({}, ...[...pages.values()].map((p) => p.view())),
      };
    },
  };
  // each page's actions are the app's (a name used twice is a mistake: the later page's would hide the earlier's)
  for (const [id, p] of pages) {
    for (const [name, f] of Object.entries(p.actions ?? {})) {
      if (name in app) throw new Error(`the ${id} page's action ${name} is already the app's`);
      app[name] = f;
    }
  }
  // the tables' and the users' state, where the tests have always read it
  const of = (id, key) => ({ get: () => pages.get(id).model[key], enumerable: true });
  Object.defineProperties(m, { confirming: of("users", "confirming"), added: of("users", "added"), removing: of("tables", "removing"), choosing: of("tables", "choosing") });
  return app;
}

// ------------------------------------------------------------------ the browser

/** Wire the app to the page: each part written from `view()`, the shown section from the hash, the buttons, forms and
 *  inputs to the shown page, and the poll while the tab is seen. */
export function start(doc, win) {
  const app = createApp((path, init) => win.fetch(path, init), () => new Date(), "status");
  app.show(win.location.hash, { doc });
  // what each part was last written, compared as written: the browser's innerHTML serialises attributes its own way
  // (data-x becomes data-x=""), and a part rewritten at every poll replaces the button under a click
  const written = new Map();
  // a part is not rewritten while a pointer is pressed: a row whose age moves every poll would replace the button
  // between its press and its release, and the click would be lost
  let pressed = false;
  // the shown page's charts, drawn after each write (src/web/charts.js); a document that cannot hold one draws none
  const charts = typeof doc.querySelectorAll === "function" && typeof win.getComputedStyle === "function" ? createCharts({ doc, win }) : null;
  const paint = () => {
    if (pressed) return;
    for (const p of PAGES) { const section = doc.getElementById(`page-${p.id}`); if (section) section.hidden = p.id !== app.model.shown; }
    for (const [id, html] of Object.entries(app.view())) {
      const el = doc.getElementById(id);
      if (el === null || written.get(id) === html) continue;
      el.innerHTML = html;
      written.set(id, html);
    }
    if (charts !== null) void charts.mount(app.pages.get(app.model.shown).charts?.() ?? {});
  };
  let busy = false;
  const poll = async () => {
    if (busy || doc.visibilityState !== "visible") return;
    busy = true;
    try { await app.poll(); } finally { busy = false; paint(); }
  };
  const shownPage = () => app.pages.get(app.model.shown);
  doc.addEventListener("submit", async (e) => {
    const r = shownPage().submit?.(e.target, win.FormData) ?? null;
    if (r === null) return;
    e.preventDefault();
    // written at once (what the action set before it asked: Syncing…), and again when it is answered
    paint();
    await r;
    paint();
  });
  doc.addEventListener("click", async (e) => {
    const b = e.target.closest?.("button");
    if (!b) return;
    const r = shownPage().click?.(b.dataset, b, { doc, win }) ?? null;
    if (r === null) return;
    paint();
    await r;
    paint();
  });
  doc.addEventListener("input", (e) => {
    if ((shownPage().input?.(e.target) ?? null) !== null) paint();
  });
  // a details opening does not bubble, so it is heard on the way down; the page reads what its opening needs at once
  doc.addEventListener("toggle", async (e) => {
    const r = shownPage().toggle?.(e.target) ?? null;
    if (r === null) return;
    paint();
    await r;
    paint();
  }, true);
  doc.addEventListener("pointerdown", () => { pressed = true; });
  for (const type of ["pointerup", "pointercancel"]) doc.addEventListener(type, () => { pressed = false; win.setTimeout(paint, 0); });
  win.addEventListener?.("hashchange", () => { app.show(win.location.hash, { doc }); paint(); void poll(); });
  if (charts !== null) {
    win.addEventListener?.("resize", () => charts.resize());
    win.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => charts.retheme());
  }
  doc.addEventListener("visibilitychange", () => { void poll(); });
  win.setInterval(() => { void poll(); }, POLL_MS);
  paint();
  void poll();
}

if (typeof document !== "undefined" && typeof window !== "undefined") start(document, window);
