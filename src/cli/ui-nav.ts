/**
 * THE SIDEBAR AS THE HOST SAYS IT (mason serve): for a page embedded in another site (a hosted service's console behind
 * a reverse proxy) that has its own page for part of what Mason's sidebar shows, or pages of its own beside Mason's.
 *
 *   - `MASON_UI_NAV_<ITEM>_URL` REPLACES ONE ITEM of the sidebar with a link to the host's page — `OVERVIEW`, `TABLES`,
 *     `USERS`, `QUERIES`, `USAGE`, `SYNC_EVENTS`, the sidebar's items in its words. The item keeps its label and icon and
 *     goes to that URL in the same tab; so does every link of Mason's own into that view (the Overview's "Create a
 *     user", a card's link), and opening the view's hash (`#users`) goes there too (src/web/app.js `retarget`, `leave`).
 *   - `MASON_UI_NAV_LINKS` ADDS THE HOST'S OWN LINKS, a JSON list of at most `NAV_LINKS_MAX` `{ "label", "url" }`, shown
 *     as a group of their own at the sidebar's foot, in the same tab.
 *
 * Every URL and label is read by the link back's ONE reading (src/cli/ui-back-link.ts `linkUrl`, `linkLabel`): a path
 * from the host's root or an `https://` / `http://` URL, printable ASCII, no user or password, at most 2048 characters;
 * a label of one line of plain text, at most 64 characters. Anything else refuses the start, every problem on one line,
 * never quoting a value. A `MASON_UI_NAV_*` name that is none of these refuses it too (with a `did you mean`): a
 * setting is never ignored. The page renders the labels as text and the URLs as attributes, never as HTML.
 *
 * WHAT THE SERVER ALLOWS IS NOT CHANGED: an item replaced is a link elsewhere, not a refusal — the run still answers that
 * view's endpoints (`/api/users`), and `MASON_UI_READ_ONLY` / `MASON_UI_READ_ONLY_ALLOW` (src/cli/ui-read-only.ts) are
 * what refuse a change.
 */
import { didYouMean } from "../lib/did-you-mean.ts";
import { linkLabel, linkUrl, type PageLink } from "./ui-back-link.ts";

/** The sidebar's items, in its order: the key `/api/state` `pageNav.items` names it by, its setting, its label. */
export const NAV_ITEMS = [
  { item: "overview", setting: "MASON_UI_NAV_OVERVIEW_URL", label: "Overview" },
  { item: "tables", setting: "MASON_UI_NAV_TABLES_URL", label: "Tables" },
  { item: "users", setting: "MASON_UI_NAV_USERS_URL", label: "Users" },
  { item: "queries", setting: "MASON_UI_NAV_QUERIES_URL", label: "Queries" },
  { item: "usage", setting: "MASON_UI_NAV_USAGE_URL", label: "Usage" },
  { item: "syncEvents", setting: "MASON_UI_NAV_SYNC_EVENTS_URL", label: "Sync events" },
] as const;
export type NavItem = typeof NAV_ITEMS[number]["item"];

export const UI_NAV_LINKS_SETTING = "MASON_UI_NAV_LINKS";
/** The most links of the host's the sidebar takes: a short group, never a second nav. */
export const NAV_LINKS_MAX = 5;
/** The longest MASON_UI_NAV_LINKS read, in characters: its links at their longest, with room for the JSON around them. */
export const NAV_LINKS_TEXT_MAX = 16_384;
/** Every setting of the sidebar, and the prefix a misspelt one is known by. */
export const NAV_SETTINGS: readonly string[] = [...NAV_ITEMS.map((i) => i.setting), UI_NAV_LINKS_SETTING];
const NAV_PREFIX = "MASON_UI_NAV_";

/** What `/api/state` `pageNav` says, and the page renders: the items replaced (each its URL), the host's links. */
export interface PageNav { items: Partial<Record<NavItem, string>>; links: PageLink[] }

/** An example of the list, said in every problem with it. */
const EXAMPLE = `[{"label":"Billing","url":"/billing"}]`;

/** A key of an entry as a problem names it: quoted when it is short plain text, else not at all. */
const keyName = (k: string): string => /^[\x20-\x7e]{1,32}$/.test(k) ? JSON.stringify(k) : "a key";

/** The host's links, or every problem with them. */
function navLinks(text: string): PageLink[] | string[] {
  const at = UI_NAV_LINKS_SETTING;
  if (text.length > NAV_LINKS_TEXT_MAX) return [`${at} is ${text.length} characters, and the list is at most ${NAV_LINKS_TEXT_MAX}: name fewer or shorter links`];
  let v: unknown;
  // the parser's own message quotes the value: never said
  try { v = JSON.parse(text); } catch { return [`${at} is not JSON: write a list of links, ${EXAMPLE}`]; }
  if (!Array.isArray(v)) return [`${at} is not a list: write a list of links, ${EXAMPLE}`];
  if (v.length > NAV_LINKS_MAX) return [`${at} has ${v.length} links, and the sidebar takes at most ${NAV_LINKS_MAX}: keep the ones the page's readers need`];
  const problems: string[] = [];
  const links: PageLink[] = [];
  v.forEach((e: unknown, i) => {
    const entry = `${at}' entry ${i + 1}`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) { problems.push(`${entry} is not an object: each link is {"label": …, "url": …}`); return; }
    const o = e as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k !== "label" && k !== "url") problems.push(`${entry} has ${keyName(k)}, which a link does not take${didYouMean(k, ["label", "url"])}: a link is {"label": …, "url": …}`);
    }
    const label = typeof o.label === "string" ? linkLabel(o.label, `${entry}'s label`, "name the link") : { problem: `${entry} has no label: give it "label", the text the sidebar shows` };
    const url = typeof o.url === "string" ? linkUrl(o.url, `${entry} has its url set`, "a link") : { problem: `${entry} has no url: give it "url", a path on this host (/something) or an https:// URL` };
    for (const x of [label, url]) if (typeof x !== "string") problems.push(x.problem);
    if (typeof label === "string" && typeof url === "string") links.push({ label, url });
  });
  return problems.length > 0 ? problems : links;
}

/**
 * The sidebar as the environment says it: null when no setting of it is set (or each is set empty, or the list is
 * `[]`), else the items replaced and the host's links, or what is wrong — every problem of every setting, on one line.
 */
export function uiNavSetting(env: Readonly<Record<string, string | undefined>>): PageNav | null | { problem: string } {
  const problems: string[] = [];
  for (const k of Object.keys(env)) {
    if (k.startsWith(NAV_PREFIX) && !NAV_SETTINGS.includes(k) && (env[k] ?? "") !== "") {
      problems.push(`${k} is not a setting${didYouMean(k, NAV_SETTINGS)}: the sidebar's settings are ${NAV_SETTINGS.join(", ")}`);
    }
  }
  const items: PageNav["items"] = {};
  for (const i of NAV_ITEMS) {
    const text = env[i.setting] ?? "";
    if (text === "") continue;
    const url = linkUrl(text, `${i.setting} is set`, `the ${i.label} item's link`);
    if (typeof url === "string") items[i.item] = url; else problems.push(url.problem);
  }
  const linksText = env[UI_NAV_LINKS_SETTING] ?? "";
  const links = linksText === "" ? [] : navLinks(linksText);
  if (links.length > 0 && typeof links[0] === "string") problems.push(...links as string[]);
  if (problems.length > 0) return { problem: problems.join("; ") };
  const hostLinks = links as PageLink[];
  return Object.keys(items).length === 0 && hostLinks.length === 0 ? null : { items, links: hostLinks };
}

/** Which of them a start was given (any `MASON_UI_NAV_*`): what `mason start` names when it refuses them. */
export const navSettingsSet = (env: Readonly<Record<string, string | undefined>>): string[] =>
  Object.keys(env).filter((k) => k.startsWith(NAV_PREFIX) && (env[k] ?? "") !== "").sort((a, b) => {
    const ia = NAV_SETTINGS.indexOf(a), ib = NAV_SETTINGS.indexOf(b);
    return (ia < 0 ? NAV_SETTINGS.length : ia) - (ib < 0 ? NAV_SETTINGS.length : ib) || a.localeCompare(b);
  });

/** The sidebar a run's page is given: the setting's, else none (a problem refused the start before the run reads it). */
export const navOf = (s: PageNav | null | { problem: string }): PageNav | null => s !== null && !("problem" in s) ? s : null;

/** What `mason serve` says of it at its start, a line each: the items replaced, the host's links (labels as JSON). */
export function navLines(nav: PageNav | null): string[] {
  if (nav === null) return [];
  const replaced = NAV_ITEMS.filter((i) => nav.items[i.item] !== undefined);
  return [
    ...(replaced.length ? [`the sidebar's ${replaced.map((i) => i.label).join(", ")} ${replaced.length === 1 ? "links" : "link"} to the host's page${replaced.length === 1 ? "" : "s"} (${replaced.map((i) => i.setting).join(", ")})`] : []),
    ...(nav.links.length ? [`the sidebar links to ${nav.links.map((l) => JSON.stringify(l.label)).join(", ")} (${UI_NAV_LINKS_SETTING})`] : []),
  ];
}
