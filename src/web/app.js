/**
 * THE WEB PAGE OF A RUN (`mason ui`, and `mason ui --ssh` for a server's; docs/WEB-UI.md, and .claude/rules/web-ui.md for whoever builds it out):
 * the SHELL — a left sidebar (the project, then a nav of links with icons: Overview · Tables · Users, and the
 * Observability group: Queries · Usage · Logs; at its foot when it was updated and the version; an icon rail on a narrow
 * window, a menu on a phone) and one section per page, the one shown chosen by the URL's hash (`#overview`, the
 * default; an unknown hash is the Overview; `#observability/queries?range=24h`, the shared time range of the three) —
 * over the pages, each an ES module of src/web/pages/ rendered from the run's command server's JSON
 * (src/cli/run-server.ts) in the words the commands print.
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
 *     title   its link in the nav (under its `parent`'s group, `observability`, whose pages share the time range:
 *             ctx.range()); its icon is the shell's (NAV_ICONS)
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
 *                      `createOpenSet()` in the page's state, whose `toggle` this is. `target` is the element (its
 *                      toggle event) or, for a click on its summary, `{ id, dataset, open, clicked: true }`: `open`
 *                      what the click asks for, BEFORE the element changes; clicked, a details the page keeps is
 *                      answered (true) even when its state already says so, the shell writing it again
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
import { esc, badge, icon, createAsk, overTunnel, renderFailure, updatedText, placePops, RANGES, DEFAULT_RANGE, rangeOf, rangeOffered, isLive, POLL_MS } from "./shared.js";
import { createCharts } from "./charts.js";
import { page as statusPage } from "./pages/status.js";
import { page as tablesPage } from "./pages/tables.js";
import { page as queriesPage } from "./pages/queries.js";
import { page as usersPage } from "./pages/users.js";
import { page as usagePage } from "./pages/usage.js";
import { page as syncsPage } from "./pages/syncs.js";

/** What the shell itself reads when the page shown does not: the state (the sidebar's project, badge and version). */
const SHELL_STATE = { path: "/api/state", everyMs: 60_000 };

/** A text that moves with the clock (an age, a running time), and a part's HTML without them: `paint` sets those
 *  texts in place when nothing else changed. */
const TICK = /(<time data-tick[^>]*>)([^<]*)(<\/time>)/g;
const steady = (html) => html.replace(TICK, "$1$3");

/** The longest a pointer's press holds the page's writes (a click is well under it): see `pressedAt`. */
export const PRESS_HOLD_MS = 2000;

// every renderer the tests import from here, wherever it lives now
export * from "./shared.js";
export { copyingText, tableLine, keptAge, sourceRows, renderStatus, renderAnywhere, SHARE_PATHS, SHARE_ENDS } from "./pages/status.js";
export { tableFacts, addedLines, removedReport, pickBody, columnsPath, renderTableAdded, renderTablesRemoved, renderTables } from "./pages/tables.js";
export { renderUsers, renderAdded, attributesText } from "./pages/users.js";
export { renderRequests } from "./pages/queries.js";
export { renderRunning, renderSessions, renderClients, renderSlowest, queriesHref } from "./pages/usage.js";

/** The pages, in the nav's order: a page with a `parent` is in its parent's group. */
export const PAGES = [statusPage, tablesPage, usersPage, queriesPage, usagePage, syncsPage];

/** The groups a parent stands for: its title, the heading of its pages in the nav. */
const GROUPS = { observability: { title: "Observability" } };

/** Each page's icon in the nav (Lucide's names, src/web/shared.js ICONS): the shell's, so a page module stays its own. */
export const NAV_ICONS = { status: "layout-dashboard", tables: "table", users: "users", queries: "square-terminal", usage: "chart-column", syncs: "logs" };

/** The hashes of before the Observability group, and the group's own: each lands on the view it was (`#status` the Overview). */
const ALIASES = { status: "status", queries: "queries", usage: "usage", logs: "syncs", syncs: "syncs", "observability/logs": "syncs", observability: "queries" };

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
 *  default range is left out, so the plain address is Now. */
export function hashOf(id, params = {}) {
  const p = PAGES.find((x) => x.id === id) ?? PAGES[0];
  const q = new URLSearchParams(Object.entries(params).filter(([k, v]) => v !== undefined && v !== "" && !(k === "range" && v === DEFAULT_RANGE)));
  const qs = q.toString();
  return `#${hashOfPage(p)}${qs ? `?${qs}` : ""}`;
}

/** The nav's entries, in order: a page of its own, or a group holding its pages (`pages`), at the place of its first. */
export function tabs() {
  const list = [];
  for (const p of PAGES) {
    if (!p.parent) { list.push({ id: p.id, title: p.title, pages: [p.id] }); continue; }
    const tab = list.find((t) => t.id === p.parent);
    if (tab) tab.pages.push(p.id); else list.push({ id: p.parent, title: GROUPS[p.parent]?.title ?? p.parent, pages: [p.id] });
  }
  return list;
}

/** One link of the nav: its icon and its label (the label is the link's name; on the icon rail, its tooltip). */
const navLink = (p, shown, href) =>
  `<a href="${esc(href)}"${p.id === shown ? ` aria-current="page"` : ""}>${icon(NAV_ICONS[p.id] ?? "")}<span class="label">${esc(p.title)}</span></a>`;

/**
 * THE SIDEBAR'S NAV: a link per page, each with its icon, the page shown marked as the current page; a group (the
 * Observability views) is a heading over its pages' links, always shown, each keeping the range they share — so the
 * hash is the state, and a link followed keeps the time range chosen.
 */
export const renderNav = (shown, range = DEFAULT_RANGE) => `<ul>${tabs().map((t) => {
  const own = PAGES.find((p) => p.id === t.id);
  if (own) return `<li>${navLink(own, shown, hashOf(own.id))}</li>`;
  const pages = t.pages.map((id) => PAGES.find((p) => p.id === id));
  return `<li class="group"><p class="group-title" id="nav-${esc(t.id)}">${esc(t.title)}</p><ul aria-labelledby="nav-${esc(t.id)}">` +
    pages.map((p) => `<li>${navLink(p, shown, hashOf(p.id, { range }))}</li>`).join("") + `</ul></li>`;
}).join("")}</ul>`;

/**
 * THE TIME RANGE OF A GROUP'S PAGE (the Observability views'), written beside the view's title in ONE header row (its
 * section's `range-<id>`; the group's name is the sidebar's heading): a segmented control — each a link to the same view
 * at that range, so the hash is the state and Back goes to the range before — Now first, the one that follows what
 * happens (said "Live" beside it); any other is read once when chosen, so beside it are when it was read (`asOf`, a
 * Date) and Refresh, which reads it again. "" for a page of its own.
 */
export function renderSubnav(shown, range = DEFAULT_RANGE, keptDays = undefined, asOf = null) {
  const p = PAGES.find((x) => x.id === shown);
  if (!p?.parent) return "";
  const r = rangeOf(range);
  // a range past what the run keeps is shown disabled, saying why and what keeps it (the one chosen by its hash stays a link)
  return `<div class="range" role="group" aria-label="Time range">${Object.entries(RANGES).map(([k, v]) => {
    const o = rangeOffered(k, keptDays);
    if (!o.shown && k !== r) return "";
    if (!o.offered && k !== r) return `<span class="off" aria-disabled="true" title="${esc(o.why)}">${esc(v.label)}<span class="sr"> (${esc(o.why)})</span></span>`;
    return `<a href="${esc(hashOf(shown, { range: k }))}"${k === r ? ` aria-current="true"` : ""}${v.live ? ` title="follows what happens: read every few seconds"` : ""}>${esc(v.label)}</a>`;
  }).join("")}</div>` + (isLive(r) ? `<span class="live" title="read every few seconds"><span class="live-dot" aria-hidden="true"></span>Live</span>`
    : `<span class="as-of">${asOf ? `<span class="dim" title="read once when chosen; Now follows what happens">as of ${esc(asOf.toISOString().slice(11, 19))} UTC</span> ` : ""}<button type="button" class="small" data-refresh-range>Refresh</button></span>`);
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
  const asked = createAsk(fetchFn);
  // what was read, by path: the last body, this read's failure (null when it answered), when it was asked
  const store = new Map();
  // every answer passes here: on a server's page a failure the page words itself is the tunnel's (`overTunnel`)
  const ask = async (path, init) => {
    const r = await asked(path, init);
    return "failure" in r && store.get("/api/state")?.body?.served === true ? { failure: overTunnel(r.failure) } : r;
  };
  const first = parseHash(shown);
  const m = { shown: first.id, range: rangeOf(first.params.range), pollFailure: null, updatedAt: null, rangeReadAt: null };
  const put = (path, at, r) => {
    const was = store.get(path);
    store.set(path, { at, body: "body" in r ? r.body : was?.body, failure: "failure" in r ? r.failure : null, stale: false });
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
      // what is shown is read again now, whatever its rate: a range that is not Now is read once, when it is chosen —
      // and until it is, it says no "as of" (the last one was another page's, or another range's)
      app.markStale();
      m.rangeReadAt = null;
      if (PAGES.find((p) => p.id === r.id)?.parent) m.range = rangeOf(r.params.range);
      pages.get(r.id).route?.(r.params, env);
    },
    /** Every read due at the next poll (a range chosen again, Refresh): what it has stays shown until it is answered. */
    markStale() { for (const e of store.values()) e.stale = true; },
    /** Read the shown page's reads that are due: those at the poll's rate every time, the slower ones once their time is up. */
    async poll() {
      const page = pages.get(m.shown);
      // the sidebar's project, demo badge and version are the state's: a page that does not read it (Users) has it read
      // once a minute beside its own, so a page opened at its own address never shows an empty sidebar
      const pageReads = page.reads();
      const reads = pageReads.some((r) => r.path === SHELL_STATE.path) ? pageReads : [...pageReads, SHELL_STATE];
      const at = now().getTime();
      const due = reads.filter((r) => r.everyMs <= POLL_MS || !store.has(r.path) || store.get(r.path).stale || at - store.get(r.path).at >= r.everyMs - POLL_MS / 2);
      const rs = await Promise.all(due.map((r) => ask(r.path)));
      due.forEach((r, i) => put(r.path, at, rs[i]));
      // a range that is not Now says when it was read: its reads are the once-only ones
      if (due.some((r) => r.everyMs === Infinity)) m.rangeReadAt = now();
      const own = reads[0] === undefined ? undefined : store.get(reads[0].path);
      m.pollFailure = own?.failure ?? null;
      afterRead();
    },
    view() {
      const st = store.get("/api/state")?.body;
      return {
        nav: renderNav(m.shown, m.range),
        // the range control in the shown view's header row (each group page's own slot; the others empty)
        ...Object.fromEntries(PAGES.filter((p) => p.parent).map((p) => [`range-${p.id}`, p.id === m.shown ? renderSubnav(m.shown, m.range, st?.engine?.keptDays, m.rangeReadAt) : ""])),
        where: st ? renderWhere(st) : "",
        // the demo database is said beside its name, so a person never takes it for their own
        badge: st?.source?.demo ? badge("demo", "accent") : "",
        updated: m.updatedAt ? esc(updatedText(m.updatedAt, now())) : "",
        // the run's version, as mason status's Mason line says it (engine.version)
        version: typeof st?.engine?.version === "string" ? `Mason ${esc(st.engine.version)}` : "",
        // the phone's menu button: both icons, the stylesheet shows the one its aria-expanded says
        "menu-icon": icon("menu", "when-closed") + icon("x", "when-open"),
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
  // between its press and its release, and the click would be lost. At most PRESS_HOLD_MS: a press whose release the
  // page never sees (released outside the window, a gesture the browser took over) froze every part for good
  let pressedAt = null;
  // the shown page's charts, drawn after each write (src/web/charts.js); a document that cannot hold one draws none
  const charts = typeof doc.querySelectorAll === "function" && typeof win.getComputedStyle === "function" ? createCharts({ doc, win }) : null;
  const paint = () => {
    if (pressedAt !== null && Date.now() - pressedAt < PRESS_HOLD_MS) return;
    pressedAt = null;
    for (const p of PAGES) { const section = doc.getElementById(`page-${p.id}`); if (section) section.hidden = p.id !== app.model.shown; }
    for (const [id, html] of Object.entries(app.view())) {
      const el = doc.getElementById(id);
      const was = written.get(id);
      if (el === null || was === html) continue;
      written.set(id, html);
      // only the clock moved (an age, a running time: `<time data-tick>`): those texts set where they are, the part
      // not replaced — a rewrite each second dropped what the reader had in it (a selection, the focus, a details' click)
      if (was !== undefined && steady(was) === steady(html) && typeof el.querySelectorAll === "function") {
        const texts = [...html.matchAll(TICK)].map((m) => m[2]);
        const times = [...el.querySelectorAll("time[data-tick]")];
        if (times.length === texts.length) { times.forEach((t, i) => { t.innerHTML = texts[i]; }); continue; }
      }
      el.innerHTML = html;
    }
    if (charts !== null) void charts.mount(app.pages.get(app.model.shown).charts?.() ?? {});
    place();
  };
  // THE POPOVERS (a confirm, a form, an answer: `pop` of shared.js) placed beside their buttons after every write, and
  // again on a scroll or a resize; a question or a form that has just opened takes the focus (a form's first box, a
  // question's Cancel: never the destructive button, which Enter would press), and
  // Escape answers it with its own Cancel (`data-pop-close`)
  let dialogs = new Set();
  const place = () => {
    const now = new Set();
    for (const el of placePops(doc, win)) {
      if (el.getAttribute?.("role") !== "dialog") continue;
      const key = `${el.dataset.anchor}|${el.getAttribute("aria-label") ?? ""}`;
      now.add(key);
      if (!dialogs.has(key)) (el.querySelector?.("input") ?? el.querySelector?.("[data-pop-close]"))?.focus?.({ preventScroll: true });
    }
    dialogs = now;
  };
  let busy = false;
  // a poll asked while one is in flight (a Refresh, a link followed) runs when it ends, never dropped: what it was
  // asked for may be what the one in flight did not read
  let again = false;
  const poll = async () => {
    if (doc.visibilityState !== "visible") return;
    if (busy) { again = true; return; }
    busy = true;
    try { await app.poll(); } finally { busy = false; paint(); }
    if (again) { again = false; await poll(); }
  };
  const shownPage = () => app.pages.get(app.model.shown);
  // what a page answered an event with: the page written at once (what the action set before it asked: Syncing…), and
  // again when it is answered
  const act = async (r) => { paint(); await r; paint(); };
  // THE PHONE'S MENU: the sidebar's nav as a sheet, opened by its button (shown below 640 px only). Open, the focus is
  // on its first link; Escape, a click outside it, the focus leaving it or a link followed close it, the focus back on
  // the button (but when the focus left by itself, to where it went)
  const sidebar = doc.getElementById("sidebar");
  const menuButton = doc.getElementById("menu-button");
  let menuOpen = false;
  const setMenu = (open, focus) => {
    menuOpen = open;
    if (open) sidebar?.setAttribute?.("data-open", ""); else sidebar?.removeAttribute?.("data-open");
    menuButton?.setAttribute?.("aria-expanded", String(open));
    if (focus) (open ? doc.getElementById("nav")?.querySelector?.("a") : menuButton)?.focus?.();
  };
  const inMenu = (t) => Boolean(t) && (sidebar?.contains?.(t) ?? false);
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (menuOpen) { e.preventDefault?.(); setMenu(false, true); return; }
    const close = doc.querySelector?.(".pop.ask:not([hidden]) [data-pop-close]");
    if (close) { e.preventDefault?.(); close.click(); }
  });
  doc.addEventListener("focusin", (e) => { if (menuOpen && !inMenu(e.target)) setMenu(false, false); });
  doc.addEventListener("submit", async (e) => {
    const r = shownPage().submit?.(e.target, win.FormData) ?? null;
    if (r === null) return;
    e.preventDefault();
    await act(r);
  });
  doc.addEventListener("click", async (e) => {
    const b = e.target.closest?.("button");
    if (b?.dataset.menu !== undefined) { setMenu(!menuOpen, true); return; }
    if (menuOpen && !inMenu(e.target)) { setMenu(false, true); return; }
    // A DETAILS' SUMMARY: opened or closed by the click itself, never by the toggle event the browser fires after it —
    // a repaint between the two (a pointerup's, a new row of a live log) replaced the element, and the event, fired on
    // the old one, never reached this document: a request's + took several clicks to open. A link or a box inside a
    // summary keeps its own click
    const summary = b || e.target.closest?.("a, input, select, textarea, label") ? null : e.target.closest?.("summary");
    const det = summary?.parentElement;
    if (det?.tagName === "DETAILS") {
      const r = shownPage().toggle?.({ id: det.id, dataset: det.dataset, open: !det.open, clicked: true }) ?? null;
      if (r === null) return;   // a details the page keeps no state of: the browser opens it, as ever
      e.preventDefault?.();
      // what was written there is no proof of what is shown (the element may disagree with the page's state): written again
      for (const id of [...written.keys()]) if (doc.getElementById(id)?.contains?.(det)) written.delete(id);
      await act(r);
      return;
    }
    if (!b) return;
    // Refresh beside a range that is not Now: everything shown read again
    if (b.dataset.refreshRange !== undefined) { app.markStale(); await poll(); return; }
    const r = shownPage().click?.(b.dataset, b, { doc, win }) ?? null;
    if (r === null) return;
    await act(r);
  });
  doc.addEventListener("input", (e) => {
    if ((shownPage().input?.(e.target) ?? null) !== null) paint();
  });
  // a details opening does not bubble, so it is heard on the way down; the page reads what its opening needs at once
  doc.addEventListener("toggle", async (e) => {
    const r = shownPage().toggle?.(e.target) ?? null;
    if (r === null) return;
    await act(r);
  }, true);
  doc.addEventListener("pointerdown", () => { pressedAt = Date.now(); });
  for (const type of ["pointerup", "pointercancel"]) doc.addEventListener(type, () => { pressedAt = null; win.setTimeout(paint, 0); });
  win.addEventListener?.("hashchange", () => { if (menuOpen) setMenu(false, true); app.show(win.location.hash, { doc }); paint(); void poll(); });
  win.addEventListener?.("scroll", place, { capture: true, passive: true });
  win.addEventListener?.("resize", place);
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
