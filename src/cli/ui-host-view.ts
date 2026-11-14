/**
 * THE HOST'S OWN VIEWS IN THE PAGE (mason serve; issue 814): a site that embeds Mason's page behind its proxy has facts
 * of its own about the server (its status, its versions, how to connect from outside) and supplies them as DATA, which
 * the page renders in its own look, inside the page — never the host's HTML.
 *
 *   - a VIEW in the sidebar: an entry of `MASON_UI_NAV_LINKS` with `view` in place of `url` (src/cli/ui-nav.ts), shown at
 *     the page's own hash `#host/<n>` (n the entry's place in the list);
 *   - a CARD on the Overview: `MASON_UI_OVERVIEW_CARD`, first, above Mason's own cards (issue 1001).
 *
 * Each names a PATH RELATIVE TO THE PAGE'S OWN ADDRESS (`host/status.json`), which the page reads with a GET from its
 * own origin (the page's `default-src 'self'` holds), so a proxy that serves the page at `/mason/` answers
 * `/mason/host/status.json`; on a bare `mason ui` the run's own server answers it, a 404 the page says as the view's
 * failure. The path is an operator's text, read here at the start and refused otherwise, never quoting it: printable
 * ASCII, no scheme, no host (`//`), not from the host's root (`/`: under a prefix it would miss the proxy), no `..`
 * segment (written or %-encoded: it would climb out of the page's address), no backslash (a browser reads it as `/`),
 * no `#fragment` (never sent), at most `VIEW_PATH_MAX` characters.
 *
 * The answer is read IN THE PAGE (src/web/host-view.js: it arrives at view time, not at the start), held to its shape,
 * every string shown as text and every link read by the link back's rules.
 */
export const UI_OVERVIEW_CARD_SETTING = "MASON_UI_OVERVIEW_CARD";

/** The longest path taken, in characters (all ASCII). */
export const VIEW_PATH_MAX = 2048;

/** A base the parser resolves a path against, only to tell that it stays under the page's address: never shown, never fetched. */
const PAGE_BASE = "http://path.invalid/page/";

/**
 * A HOST VIEW'S PATH as the page is given it, or what is wrong with it (the value itself never quoted). `at` names the
 * setting as the problem says it (`MASON_UI_OVERVIEW_CARD is set`, `MASON_UI_NAV_LINKS's entry 2 has its view set`).
 */
export function viewPath(v: string, at: string): string | { problem: string } {
  const way = "a path relative to the page's own address, host/status.json";
  if (v.length > VIEW_PATH_MAX) return { problem: `${at} to ${v.length} characters, and a view's path is at most ${VIEW_PATH_MAX}: name a shorter one` };
  if (v === "") return { problem: `${at} to nothing: ${way}` };
  if (!/^[\x21-\x7e]*$/.test(v)) return { problem: `${at} to a path with a control character, a space or a character outside ASCII: write it %-encoded` };
  if (v.includes("\\")) return { problem: `${at} to a path with a backslash, which a browser reads as /: write / or %5C` };
  if (v.startsWith("//")) return { problem: `${at} to a path that starts with //, which a browser reads as another host: ${way}` };
  if (v.startsWith("/")) return { problem: `${at} to a path from the host's root, which misses the page under a proxy's prefix: ${way}` };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return { problem: `${at} to a URL with a scheme: ${way}` };
  if (v.includes("#")) return { problem: `${at} to a path with a #fragment, which is never sent: remove it` };
  const path = v.split("?")[0]!;
  if (path.split("/").some((s) => /^(\.|%2e){2}$/i.test(s))) return { problem: `${at} to a path with a .. segment, which climbs out of the page's address: ${way}` };
  let u: URL;
  try { u = new URL(v, PAGE_BASE); } catch { return { problem: `${at} to a path the URL parser cannot read: ${way}` }; }
  // what the parser reads must stay under the page's address, however it was written (fail closed)
  if (u.origin !== new URL(PAGE_BASE).origin || !u.pathname.startsWith("/page/")) return { problem: `${at} to a path that leaves the page's address: ${way}` };
  return v;
}

/** The host's card as the environment says it: null unset (or set empty), its path, or what is wrong. */
export function uiOverviewCardSetting(env: Readonly<Record<string, string | undefined>>): string | null | { problem: string } {
  const v = env[UI_OVERVIEW_CARD_SETTING] ?? "";
  return v === "" ? null : viewPath(v, `${UI_OVERVIEW_CARD_SETTING} is set`);
}

/** The card a run's page is given: the setting's path, else none (a problem refused the start before the run reads it). */
export const overviewCardOf = (s: string | null | { problem: string }): string | null => typeof s === "string" ? s : null;
