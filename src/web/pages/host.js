/**
 * A HOST'S VIEW (mason serve's MASON_UI_NAV_LINKS `{ label, view }`; issue 814, docs/WEB-UI.md "Host views"): the page
 * that shows one, at `#host/<n>` (src/web/routes.js), n its entry's place in `/api/state` `pageNav.links`. Not a link of
 * Mason's own nav (`nav: false`): its link is the host's entry, among the host's links. It reads the view's path,
 * relative to the page's own address, when it is shown and every `refresh` seconds while it is (the shell's poll: only
 * the page shown, only while the tab is seen), and renders it as src/web/host-view.js holds it — every string text,
 * no form and no button that changes anything; a view it cannot read is said in the Failure shape, in its own part.
 */
import { esc, skeleton, copyClick, renderFailure, POLL_MS } from "../shared.js";
import { HOST_PAGE } from "../routes.js";
import { readHost, hostEvery, hostKey, renderHostPart } from "../host-view.js";

/** The host's view at place `n` (from 1) of the host's links, `{ label, view }`, or null: none there, or a link elsewhere. */
export function hostViewAt(nav, n) {
  const l = Array.isArray(nav?.links) ? nav.links[Number(n) - 1] : undefined;
  return typeof l?.label === "string" && typeof l?.view === "string" && l.url === undefined ? l : null;
}

/** What the page says at a place where the state names no view of the host's. */
const noView = (n) => renderFailure({ code: "not_found", message: `this page has no host's view ${String(n ?? "")}`.trim(),
  why: "the address names a view of the host's sidebar that the site serving this page does not name (MASON_UI_NAV_LINKS)",
  fix: "follow a link of the sidebar" });

export const page = {
  id: HOST_PAGE,
  title: "Host view",
  // its links are the host's entries (renderNav), never one of Mason's own
  nav: false,
  create(ctx) {
    const m = { view: null };
    const state = () => ctx.read("api/state")?.body;
    const entry = () => { const st = state(); return st === undefined ? undefined : hostViewAt(st.pageNav, m.view); };
    return {
      model: m,
      route(params) { m.view = params.view ?? null; },
      // the state first (the sidebar's, the run's banner), then the view once the state names it: at its own rate
      reads() {
        const e = entry();
        if (e === undefined || e === null) return [{ path: "api/state", everyMs: POLL_MS }];
        const key = hostKey(e.view);
        return [{ path: "api/state", everyMs: 60_000 }, { path: key, everyMs: hostEvery(ctx.read(key)?.body), ask: (fetchFn) => readHost(fetchFn, e.view) }];
      },
      view() {
        // written only while shown: another page's address never names a view, and the hidden section stays empty
        if (ctx.shown() !== HOST_PAGE) return { "host-h": esc(page.title), "host-view": "" };
        const e = entry();
        if (e === undefined) return { "host-h": esc(page.title), "host-view": skeleton(3) };
        if (e === null) return { "host-h": esc(page.title), "host-view": noView(m.view) };
        const r = ctx.read(hostKey(e.view));
        // its title the view's own once read, the sidebar's label until then
        return { "host-h": esc(r?.body?.title ?? e.label), "host-view": renderHostPart(r, `view-${m.view}`) };
      },
      // a fact's Copy, the one button a view writes
      click: (d, button, env) => copyClick(d, button, env),
    };
  },
};
