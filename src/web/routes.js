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

/**
 * WHAT A HASH SHOWS, as the router reads it (raw, as the address says it, never decoded): the view (`#tables`,
 * `#observability/usage`, an old one — `#status`, `#queries` — the view it was; none, or one it does not know, the
 * Overview), the parameters after its `?` (`range=7d`, `show=failed`), and whether the hash NAMES its view rather than
 * landing on the Overview for naming none.
 */
export function viewOfHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const at = raw.indexOf("?");
  const where = at < 0 ? raw : raw.slice(0, at);
  const params = Object.fromEntries(new URLSearchParams(at < 0 ? "" : raw.slice(at + 1)));
  const named = Object.entries(VIEW_HASHES).find(([, h]) => h === where)?.[0] ?? (Object.hasOwn(ALIASES, where) ? ALIASES[where] : undefined);
  return { id: named ?? "status", params, named: named !== undefined };
}
