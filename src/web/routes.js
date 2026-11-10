/**
 * THE PAGE'S ADDRESSES, IN ONE PLACE: which hash shows which view — each view's own (`VIEW_HASHES`), the old ones that
 * land where they did (`ALIASES`) — read by the page's router (src/web/app.js `parseHash`, `hashOf`) and by the run's
 * check of the host's sidebar (src/cli/ui-nav.ts: a URL whose fragment names a view the host replaced is refused, since
 * the page would go round in a loop), so the two can never disagree on what a hash names. DOM-free and import-free.
 */

/** Each view's hash, by its page's id (`#overview` is the Overview, whose module keeps the id `status`). */
export const VIEW_HASHES = { status: "overview", tables: "tables", users: "users", queries: "observability/queries", usage: "observability/usage", syncs: "observability/syncs" };

/** The hashes of before the Observability group, and the group's own: each lands on the view it was (`#status` the Overview). */
export const ALIASES = { status: "status", queries: "queries", usage: "usage", logs: "syncs", syncs: "syncs", "observability/logs": "syncs", observability: "queries" };

/** The sidebar's items as `/api/state` `pageNav.items` names them (MASON_UI_NAV_<ITEM>_URL), each its view's id. */
export const NAV_ITEM_VIEWS = { overview: "status", tables: "tables", users: "users", queries: "queries", usage: "usage", syncEvents: "syncs" };

/** The page that shows a host's view (MASON_UI_NAV_LINKS' `{ label, view }`), at `#host/<n>`: n the entry's place in
 *  `/api/state` `pageNav.links`, from 1. */
export const HOST_PAGE = "host";
const HOST_HASH = /^host\/([1-9][0-9]?)$/;

/** The hash of the host's view at place `n` of the host's links (`#host/2`). */
export const hostHash = (n) => `#${HOST_PAGE}/${n}`;

/**
 * WHAT A HASH SHOWS, as the router reads it (raw, as the address says it, never decoded): the view (`#tables`,
 * `#observability/usage`, an old one — `#status`, `#queries` — the view it was; `#host/2`, the host's view at that place
 * of its links, `{ view: "2" }`; none, or one it does not know, the
 * Overview), the parameters after its `?` (`range=7d`, `show=failed`), and whether the hash NAMES its view rather than
 * landing on the Overview for naming none.
 */
export function viewOfHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const at = raw.indexOf("?");
  const where = at < 0 ? raw : raw.slice(0, at);
  const params = Object.fromEntries(new URLSearchParams(at < 0 ? "" : raw.slice(at + 1)));
  // a host's view: the page that shows them, its place in the host's links its parameter `view`
  const host = HOST_HASH.exec(where);
  if (host !== null) return { id: HOST_PAGE, params: { ...params, view: host[1] }, named: true };
  const named = Object.entries(VIEW_HASHES).find(([, h]) => h === where)?.[0] ?? (Object.hasOwn(ALIASES, where) ? ALIASES[where] : undefined);
  return { id: named ?? "status", params, named: named !== undefined };
}
