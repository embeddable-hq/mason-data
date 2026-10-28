/**
 * THE WEB PAGE OF `mason start` (`mason ui`; docs/WEB-UI.md, and .claude/rules/web-ui.md for whoever builds it out):
 * the SHELL — a nav and one section per page, the one shown chosen by the URL's hash (`#status`, the default; an
 * unknown hash is Status) — over the pages, each an ES module of src/web/pages/ rendered from the run's command
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
 *   export const page = { id, title, create(ctx) }
 *     id      its hash (#id), its section (<section id="page-<id>"> in index.html) and its route (/pages/<id>.js)
 *     title   its link in the nav
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
 *       toggle?(target)  a <details> opened or closed: null when not its, else a value or a promise (as `click`)
 *       model?         its state, for the tests
 *     }
 *     ctx = { ask(path, init) → { body } | { failure }, read(path) → { body, failure } | undefined (body: the last
 *             one read; failure: this read's, else null), refresh(paths) → Promise (read them now), now() → Date }
 *
 * A page is registered by its import and its place in PAGES below, its route in PAGE_ROUTES, and its section in
 * index.html.
 */
import { esc, createAsk, renderFailure, updatedText } from "./shared.js";
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

/** The pages, in the nav's order. */
export const PAGES = [statusPage, tablesPage, queriesPage, usersPage, usagePage, logsPage];

/** How often the shown page is asked while the tab is seen: its fastest reads every poll, the slower ones when due. */
export const POLL_MS = 2000;

/** The page a hash shows: `#tables` → tables; none or one unknown → status. */
export const routeOf = (hash) => {
  const id = String(hash ?? "").replace(/^#/, "");
  return PAGES.some((p) => p.id === id) ? id : "status";
};

/** The nav: a link per page, the one shown marked as the current page. */
export const renderNav = (shown) => `<ul>${PAGES.map((p) =>
  `<li><a href="#${p.id}"${p.id === shown ? ` aria-current="page"` : ""}>${esc(p.title)}</a></li>`).join("")}</ul>`;

/** The heading's line: the database the run copies, and its sources file's name when that is another. */
export function renderWhere(s) {
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
  const m = { shown: routeOf(shown), pollFailure: null, updatedAt: null };
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
  const ctx = { ask, now, refresh, read: (path) => { const e = store.get(path); return e === undefined ? undefined : { body: e.body, failure: e.failure }; } };
  for (const p of PAGES) pages.set(p.id, p.create(ctx));
  const app = {
    model: m,
    pages,
    show(id) { m.shown = routeOf(id); },
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
        nav: renderNav(m.shown),
        where: st ? renderWhere(st) : "",
        updated: m.updatedAt ? esc(updatedText(m.updatedAt)) : "",
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
  const route = () => routeOf(win.location.hash);
  const app = createApp((path, init) => win.fetch(path, init), () => new Date(), route());
  // what each part was last written, compared as written: the browser's innerHTML serialises attributes its own way
  // (data-x becomes data-x=""), and a part rewritten at every poll replaces the button under a click
  const written = new Map();
  // a part is not rewritten while a pointer is pressed: a row whose age moves every poll would replace the button
  // between its press and its release, and the click would be lost
  let pressed = false;
  const paint = () => {
    if (pressed) return;
    for (const p of PAGES) { const section = doc.getElementById(`page-${p.id}`); if (section) section.hidden = p.id !== app.model.shown; }
    for (const [id, html] of Object.entries(app.view())) {
      const el = doc.getElementById(id);
      if (el === null || written.get(id) === html) continue;
      el.innerHTML = html;
      written.set(id, html);
    }
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
  win.addEventListener?.("hashchange", () => { app.show(route()); paint(); void poll(); });
  doc.addEventListener("visibilitychange", () => { void poll(); });
  win.setInterval(() => { void poll(); }, POLL_MS);
  paint();
  void poll();
}

if (typeof document !== "undefined" && typeof window !== "undefined") start(document, window);
