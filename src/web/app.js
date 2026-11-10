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
 *     nav     false for a page that is no link of Mason's own nav (a host's view: its links are the host's entries)
 *     create(ctx) → {
 *       reads()        [{ path, everyMs, ask? }]: what it reads WHILE SHOWN, each at its own rate (everyMs ≤ POLL_MS:
 *                      every poll; Infinity: once, when shown); a path is the store's key, so a path built from the
 *                      page's own state (a filter, a page of results) is read as that state changes; `ask(fetch)`
 *                      reads it instead of the run's own read (a host's view: src/web/host-view.js `readHost`). The
 *                      FIRST is the page's own: its failure is the banner at the top (`poll`); the page renders the
 *                      others' failures itself. A read the page names once the poll's answers are in (a view the
 *                      state has just named) is read in the same poll. A read with `ask` is NEVER awaited by the
 *                      poll: it is stored when it settles (`onLate` paints then), one at a time per path, so a host
 *                      that never answers holds up neither the run's reads nor another page's.
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
 *             range() → a key of RANGES: the time range the Observability pages share (from the hash),
 *             shown() → the id of the page shown }
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
import { page as hostPage, hostViewAt } from "./pages/host.js";
import { NAV_ITEM_VIEWS, VIEW_HASHES, HOST_PAGE, hostHash, viewOfHash } from "./routes.js";

/** What the shell itself reads when the page shown does not: the state (the sidebar's project, badge and version). */
const SHELL_STATE = { path: "api/state", everyMs: 60_000 };

/** A text that moves with the clock (an age, a running time), and a part's HTML without them: `paint` sets those
 *  texts in place when nothing else changed. */
const TICK = /(<time data-tick[^>]*>)([^<]*)(<\/time>)/g;
const steady = (html) => html.replace(TICK, "$1$3");

/** The longest a pointer's press holds the page's writes (a click is well under it): see `pressedAt`. */
export const PRESS_HOLD_MS = 2000;

// every renderer the tests import from here, wherever it lives now
export * from "./shared.js";
export { copyingText, tableLine, keptAge, keptWords, sourceRows, renderStatus, renderShare, createShare } from "./pages/status.js";
export { tableFacts, addedLines, removedReport, pickBody, columnsPath, renderTableAdded, renderTablesRemoved, renderTables } from "./pages/tables.js";
export { renderUsers, renderAdded, renderAddUser, attributesText } from "./pages/users.js";
export { renderRequests } from "./pages/queries.js";
export { renderRunning, renderSessions, renderClients, renderSlowest, queriesHref } from "./pages/usage.js";
export { hostLinkUrl, hostView, readHost, renderHostView, renderHostCard, renderHostPart, HOST_BYTES_MAX, HOST_READ_MS, REFRESH_MIN_S, REFRESH_MAX_S, HOST_LIMITS } from "./host-view.js";
export { hostViewAt } from "./pages/host.js";

/** The pages, in the nav's order: a page with a `parent` is in its parent's group. */
export const PAGES = [statusPage, tablesPage, usersPage, queriesPage, usagePage, syncsPage, hostPage];

/** The groups a parent stands for: its title, the heading of its pages in the nav. */
const GROUPS = { observability: { title: "Observability" } };

/** Each page's icon in the nav (Lucide's names, src/web/shared.js ICONS): the shell's, so a page module stays its own. */
export const NAV_ICONS = { status: "layout-dashboard", tables: "table", users: "users", queries: "square-terminal", usage: "chart-column", syncs: "logs" };

/** A page's own hash: src/web/routes.js's, the one list the router and the run's check of the host's sidebar read. */
const hashOfPage = (p) => VIEW_HASHES[p.id] ?? p.id;

/**
 * WHAT A HASH SHOWS: the page (`#tables`, `#observability/usage`, an old one — `#status`, `#queries` — the view it was;
 * none, or one it does not know, the Overview) and the parameters after its `?` (`range=7d`, `show=failed`). Read by
 * src/web/routes.js `viewOfHash`, which the run's check of MASON_UI_NAV_* reads too.
 */
export function parseHash(hash) {
  const { id, params } = viewOfHash(hash);
  return { id, params };
}

/** The pages the host replaced (`/api/state` `pageNav.items`, by src/web/routes.js `NAV_ITEM_VIEWS`), each with its
 *  URL (a Map of page id → URL); empty when the state names none. */
export function replacedPages(nav) {
  const items = nav !== null && typeof nav === "object" && nav.items !== null && typeof nav.items === "object" ? nav.items : {};
  return new Map(Object.entries(NAV_ITEM_VIEWS).filter(([k]) => typeof items[k] === "string").map(([k, id]) => [id, items[k]]));
}

/** The host's own entries the state names (`pageNav.links`), each `{ label, url }` (a link elsewhere) or `{ label, view,
 *  n }` (a view the page shows at `#host/<n>`, n its place in the list); [] when none. */
export const hostLinks = (nav) => Array.isArray(nav?.links)
  ? nav.links.flatMap((l, i) => typeof l?.label !== "string" ? [] : typeof l.url === "string" ? [{ label: l.label, url: l.url }]
    : hostViewAt(nav, i + 1) !== null ? [{ label: l.label, view: l.view, n: i + 1 }] : [])
  : [];

/** Where a hash goes instead when it names a page the host replaced: its URL, else null (a hash naming no page is none). */
export function elsewhere(hash, nav) {
  const r = viewOfHash(hash);
  return r.named ? replacedPages(nav).get(r.id) ?? null : null;
}

/** An `href="#…"` attribute as a page writes it (its `&` escaped): what `retarget` reads. */
const HASH_HREF = new RegExp('href="(#[^"]*)"', "g");

/**
 * EVERY LINK OF MASON'S OWN INTO A REPLACED VIEW GOES TO THE HOST'S PAGE: each `href="#…"` in a part's HTML whose hash
 * names a replaced page becomes that URL, in the same tab and sending no referrer — the Overview's "Create a user", its
 * cards, a client's Queries, whatever page wrote it, so no page module needs to know. One pass over what the page writes
 * (`view()`), and the same rule over the document's own links (`start`), by `elsewhere`.
 */
export function retarget(html, nav) {
  if (replacedPages(nav).size === 0) return html;
  return html.replace(HASH_HREF, (whole, h) => {
    const url = elsewhere(h.replace(/&amp;/g, "&"), nav);
    return url === null ? whole : `href="${esc(url)}" rel="noreferrer"`;
  });
}

/** A page's address with its parameters (`hashOf("queries", { range: "7d" })` → `#observability/queries?range=7d`); the
 *  default range is left out, so the plain address is Now. */
export function hashOf(id, params = {}) {
  // a host's view: its place in the host's links is its address
  if (id === HOST_PAGE && params.view !== undefined) return hostHash(params.view);
  const p = PAGES.find((x) => x.id === id && x.nav !== false) ?? PAGES[0];
  const q = new URLSearchParams(Object.entries(params).filter(([k, v]) => v !== undefined && v !== "" && !(k === "range" && v === DEFAULT_RANGE)));
  const qs = q.toString();
  return `#${hashOfPage(p)}${qs ? `?${qs}` : ""}`;
}

/** The nav's entries, in order: a page of its own, or a group holding its pages (`pages`), at the place of its first. */
export function tabs() {
  const list = [];
  for (const p of PAGES) {
    if (p.nav === false) continue;
    if (!p.parent) { list.push({ id: p.id, title: p.title, pages: [p.id] }); continue; }
    const tab = list.find((t) => t.id === p.parent);
    if (tab) tab.pages.push(p.id); else list.push({ id: p.parent, title: GROUPS[p.parent]?.title ?? p.parent, pages: [p.id] });
  }
  return list;
}

/** One link of the nav: its icon and its label (the label is the link's name; on the icon rail, its tooltip). A page the
 *  host replaced (`replaced`, its URL) keeps both and goes there, in the same tab, never the current page. */
const navLink = (p, shown, href, replaced = undefined) => replaced !== undefined
  ? `<a href="${esc(replaced)}" rel="noreferrer">${icon(NAV_ICONS[p.id] ?? "")}<span class="label">${esc(p.title)}</span></a>`
  : `<a href="${esc(href)}"${p.id === shown ? ` aria-current="page"` : ""}>${icon(NAV_ICONS[p.id] ?? "")}<span class="label">${esc(p.title)}</span></a>`;

/**
 * THE SIDEBAR'S NAV: a link per page, each with its icon, the page shown marked as the current page; a group (the
 * Observability views) is a heading over its pages' links, always shown, each keeping the range they share — so the
 * hash is the state, and a link followed keeps the time range chosen. With the host's sidebar (`nav`, `/api/state`
 * `pageNav`): a page it replaced links to its URL, and its own links are a group of their own at the end, each with the
 * link icon, its label as TEXT (escaped: `<b>` reads as `<b>`), in the same tab; a host's VIEW among them links to its
 * hash in the page (`#host/<n>`), the current page while it is shown (`hostView`, its place).
 */
export const renderNav = (shown, range = DEFAULT_RANGE, nav = null, hostView = null) => {
  const replaced = replacedPages(nav);
  const links = hostLinks(nav);
  return `<ul>${tabs().map((t) => {
    const own = PAGES.find((p) => p.id === t.id);
    if (own) return `<li>${navLink(own, shown, hashOf(own.id), replaced.get(own.id))}</li>`;
    const pages = t.pages.map((id) => PAGES.find((p) => p.id === id));
    return `<li class="group"><p class="group-title" id="nav-${esc(t.id)}">${esc(t.title)}</p><ul aria-labelledby="nav-${esc(t.id)}">` +
      pages.map((p) => `<li>${navLink(p, shown, hashOf(p.id, { range }), replaced.get(p.id))}</li>`).join("") + `</ul></li>`;
  }).join("")}${links.length ? `<li class="group host-links"><ul aria-label="Links">${links.map((l) => l.view !== undefined
    ? `<li><a href="${esc(hostHash(l.n))}"${shown === HOST_PAGE && String(hostView) === String(l.n) ? ` aria-current="page"` : ""}>${icon("panel-top")}<span class="label">${esc(l.label)}</span></a></li>`
    : `<li><a href="${esc(l.url)}" rel="noreferrer">${icon("link")}<span class="label">${esc(l.label)}</span></a></li>`).join("")}</ul></li>` : ""}</ul>`;
};

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

/**
 * THE LINK BACK TO THE SITE THAT LINKS TO THE PAGE (`/api/state` `pageBack`: mason serve's MASON_UI_BACK_URL and
 * MASON_UI_BACK_LABEL, validated by the run at its start, src/cli/ui-back-link.ts), at the top of the sidebar: "← label",
 * in the same tab. Set THROUGH THE DOM — the URL an `href` attribute, the label an element's text — never as HTML, so
 * an operator's text is never markup; `rel="noreferrer"` beside the page's own no-referrer policy, so the page's address
 * never reaches the other site. Hidden, with no href, when the state names none (unset: nothing changes).
 */
export function setBack(link, label, back) {
  if (!link || !label) return;
  const shown = back !== null && typeof back === "object" && typeof back.url === "string" && typeof back.label === "string";
  if (!shown) {
    link.hidden = true;
    link.removeAttribute("href");
    link.removeAttribute("title");
    label.textContent = "";
    return;
  }
  link.setAttribute("href", back.url);
  link.setAttribute("rel", "noreferrer");
  // the label is the link's name; on the icon rail and the phone's bar, where only the arrow shows, its tooltip too
  link.setAttribute("title", back.label);
  label.textContent = back.label;
  link.hidden = false;
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
    return "failure" in r && store.get("api/state")?.body?.served === true ? { failure: overTunnel(r.failure) } : r;
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
  // THE READS OF ITS OWN IN FLIGHT (a host's view, `ask`), by path: never awaited by a poll, never asked twice at once;
  // each stored when it settles, the page painted again then (`app.onLate`)
  const aside = new Map();
  const readAside = (r, at) => {
    const p = Promise.resolve().then(() => r.ask(fetchFn))
      // a reader that throws is a bug of the page's: said as the read's failure, never lost
      .catch((e) => ({ failure: { code: "failed", message: `the read of ${r.path} failed: ${e?.message ?? String(e)}` } }))
      .then((res) => { put(r.path, at, res); afterRead(); app.onLate?.(); })
      .finally(() => aside.delete(r.path));
    aside.set(r.path, p);
  };
  const refresh = async (paths) => {
    const at = now().getTime();
    const rs = await Promise.all(paths.map((p) => ask(p)));
    paths.forEach((p, i) => put(p, at, rs[i]));
    afterRead();
  };
  const ctx = { ask, now, refresh, range: () => m.range, shown: () => m.shown, read: (path) => { const e = store.get(path); return e === undefined ? undefined : { body: e.body, failure: e.failure }; } };
  for (const p of PAGES) pages.set(p.id, p.create(ctx));
  // the page first shown takes its parameters too, as `show` hands them (a host's view, its place)
  pages.get(first.id).route?.(first.params, {});
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
      const due = reads.filter((r) => !aside.has(r.path) && (r.everyMs <= POLL_MS || !store.has(r.path) || store.get(r.path).stale || at - store.get(r.path).at >= r.everyMs - POLL_MS / 2));
      // the run's reads are awaited; a read of its own (a host's view) is started beside them and never awaited
      const runReads = async (list) => {
        for (const r of list.filter((x) => x.ask !== undefined)) readAside(r, at);
        const theRun = list.filter((x) => x.ask === undefined);
        const rs = await Promise.all(theRun.map((r) => ask(r.path)));
        theRun.forEach((r, i) => put(r.path, at, rs[i]));
      };
      await runReads(due);
      // what the page reads once these answered and it had not named (a view the state has just named): read now, not a poll later
      const named = page.reads().filter((r) => !store.has(r.path) && !aside.has(r.path));
      if (named.length > 0) await runReads(named);
      // a range that is not Now says when it was read: its reads are the once-only ones
      if (due.some((r) => r.everyMs === Infinity)) m.rangeReadAt = now();
      const own = reads[0] === undefined ? undefined : store.get(reads[0].path);
      m.pollFailure = own?.failure ?? null;
      afterRead();
    },
    /** Once every read of its own now in flight has settled (the tests' wait; the page paints on `onLate`). */
    settled: () => Promise.all([...aside.values()]),
    /** Called when a read of its own settles: the browser's paint (`start`). */
    onLate: null,
    /** The link back the state names (`pageBack`), or null: set on the sidebar by `setBack`, never written as HTML. */
    back() { return store.get("api/state")?.body?.pageBack ?? null; },
    /** The sidebar as the host says it (`pageNav`), or null: undefined until the state is first read (not yet known). */
    nav() { const st = store.get("api/state")?.body; return st === undefined ? undefined : st.pageNav ?? null; },
    /**
     * WHERE THE PAGE GOES INSTEAD OF A HASH, once the state says the host's sidebar: `{ url }` for a hash that names a
     * page the host replaced (`#users`, `#users?x=1`, an old alias of it) — the host's page; `{ hash }` for one that
     * names no page (none, or one unknown), which lands on the Overview, when the Overview is replaced — the first page
     * of Mason's own, so opening the page never leaves it; else null (also before the state is read).
     */
    leave(hash) {
      const nav = app.nav();
      if (nav === undefined) return null;
      if (nav === null) return viewOfHash(hash).id === HOST_PAGE ? { hash: hashOf(PAGES[0].id) } : null;
      const url = elsewhere(hash, nav);
      if (url !== null) return { url };
      const r = viewOfHash(hash);
      const replaced = replacedPages(nav);
      // a host's view the state does not name (a bookmark of an older sidebar): Mason's first page of its own
      if (r.id === HOST_PAGE && hostViewAt(nav, r.params.view) === null) {
        const own = PAGES.find((p) => p.nav !== false && !replaced.has(p.id));
        return own === undefined ? null : { hash: hashOf(own.id) };
      }
      if (r.named || !replaced.has(r.id)) return null;
      const first = PAGES.find((p) => p.nav !== false && !replaced.has(p.id));
      return first === undefined ? null : { hash: hashOf(first.id) };
    },
    view() {
      const st = store.get("api/state")?.body;
      const nav = st?.pageNav ?? null;
      // every link of Mason's own into a view the host replaced goes to its page, whichever part wrote it
      return Object.fromEntries(Object.entries(app.parts(st)).map(([k, html]) => [k, retarget(html, nav)]));
    },
    /** Every part of the page as its renderer wrote it (`view` sends each link into a replaced view elsewhere). */
    parts(st) {
      const nav = st?.pageNav ?? null;
      return {
        nav: renderNav(m.shown, m.range, nav, pages.get(HOST_PAGE).model.view),
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
  // the link back as last set (`setBack`): JSON of `pageBack`, undefined before the first paint
  let backWritten;
  // the host's sidebar as last applied to the document's own links: JSON of `pageNav`
  let navWritten;
  // A HASH OF A VIEW THE HOST REPLACED IS LEFT FOR ITS PAGE (`app.leave`): replaced in the history, so Back does not
  // land on it again; once per URL and hash, however many paints follow before the browser leaves — a hash that arrives
  // later (`arrived`: typed, or followed) leaves again, whatever became of the last leave (a navigation stopped, a 204,
  // a URL that is this page). No loop can follow: mason serve refuses a URL whose fragment names a replaced view
  // (src/cli/ui-nav.ts). A hash naming no page, with the Overview replaced, is the first page of Mason's own.
  // `leaving` is the URL the page is leaving for, else null.
  let leaving = null;
  const leave = (arrived = false) => {
    if (arrived) leaving = null;
    const to = app.leave(win.location.hash);
    if (to === null) return false;
    if ("hash" in to) { win.location.replace(to.hash); return false; }
    if (leaving !== to.url) { leaving = to.url; win.location.replace(to.url); }
    return true;
  };
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
    // the link back, when the state names one: an attribute and a text, set only when it changed
    const back = app.back();
    const backKey = JSON.stringify(back);
    if (backKey !== backWritten) { backWritten = backKey; setBack(doc.getElementById("back"), doc.getElementById("back-label"), back); }
    // the host's sidebar, once the state says it: the document's own links into a replaced view (index.html's, which
    // no part writes) sent where `retarget` sends the parts', and a hash of a replaced view left for the host's page
    const nav = app.nav();
    const navKey = JSON.stringify(nav ?? null);
    if (nav !== undefined && navKey !== navWritten) {
      navWritten = navKey;
      for (const a of typeof doc.querySelectorAll === "function" ? doc.querySelectorAll('a[href^="#"]') : []) {
        const url = elsewhere(a.getAttribute("href"), nav);
        if (url !== null) { a.setAttribute("href", url); a.setAttribute("rel", "noreferrer"); }
      }
    }
    leave();
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
  // a host's view or card answered after its poll (never awaited by it): written then
  app.onLate = () => paint();
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
  win.addEventListener?.("hashchange", () => {
    if (menuOpen) setMenu(false, true);
    // a replaced view's hash is not shown, nor read: the page leaves for the host's
    if (leave(true)) return;
    app.show(win.location.hash, { doc }); paint(); void poll();
  });
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
