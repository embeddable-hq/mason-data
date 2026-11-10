/**
 * `MASON_UI_READ_ONLY=1` (mason serve): THE WEB PAGE ONLY LOOKS. A page shown to someone who should only look (a
 * replica's page behind a reverse proxy, a team's dashboard) must offer no control that could only fail, and its server
 * must refuse whatever such a control would send.
 *
 * REFUSED BY RULE, NOT BY LIST (`pageWrite`): every request of the PAGE that is not a GET or a HEAD — whatever its path,
 * a route added later included — is answered with `PAGE_READ_ONLY`, before any route is read. Every route of the run's
 * server that changes something is a POST or a DELETE (src/cli/run-server.ts), and no GET changes anything. The page's
 * requests are those its cookie carries, on the server's own Host, through a tunnel (`mason ui --ssh`, `--bridge`) or on
 * the Unix socket (MASON_UI_SOCKET) alike.
 *
 * WHAT IT DOES NOT COVER: the `mason` commands beside the run. A request with the run's token (`Authorization: Bearer`,
 * read from the 0600 config by a process on the machine; the guard has checked it before this is asked) is the
 * commands', and is served as before: `mason add`, `mason sync`, `mason cancel`, and the tunnel `mason ui --ssh` opens to
 * show the page. Whoever can read that token can edit the project's files and `.mason/users.json` themselves, so
 * refusing them here would protect nothing; MASON_PROJECT_READONLY is the setting that refuses the commands' edits.
 *
 * `MASON_UI_READ_ONLY_ALLOW=tables` (issue 789): A READ-ONLY PAGE THAT STILL EDITS ITS TABLES, for a page embedded in a
 * site that does the rest itself (its users, say). It lets through exactly the Tables page's changes — the method and the
 * path the router reads (`AREA_ROUTES`: Add, Columns… and Name its key… are `POST /api/pick`, Remove `POST /api/remove`,
 * Sync now `POST /api/sync`), never a prefix and never a pattern — and every other change the page asks for is refused
 * by the same rule as before: still REFUSED BY RULE, the allowance a closed list of exact routes. Those routes ask
 * `projectWriteRefusal` as before, so `MASON_PROJECT_READONLY=1` still refuses an Add or a Remove. Set empty, it is
 * unset. Set without `MASON_UI_READ_ONLY=1` it refuses the start: an allowance on a page that is not read-only says the
 * operator meant a read-only page and did not get one.
 *
 * `MASON_UI_READ_ONLY_ALLOW=users` (issue 813), alone or with tables (`tables,users`, in either order): A READ-ONLY PAGE
 * THAT STILL MANAGES ITS USERS, for a site that proxies the page and lets its users' changes through its own checks.
 * Exactly the Users page's changes: Add a user `POST /api/users`, Disable, Enable and Connects from…
 * `POST /api/users/<name>/disable|enable|from`, Remove `DELETE /api/users/<name>` — `<name>` exactly one path segment,
 * as the router's `[^/]+` reads it. A list read strictly: an item that is not an area, an empty one or one named twice
 * refuses the start.
 */
import type { Failure } from "./command.ts";
import { didYouMean } from "../lib/did-you-mean.ts";

export const UI_READ_ONLY_SETTING = "MASON_UI_READ_ONLY";

/** MASON_UI_READ_ONLY as the environment says it: 1 true, 0 or unset false, anything else what is wrong with it. */
export function uiReadOnlySetting(env: Readonly<Record<string, string | undefined>>): boolean | { problem: string } {
  const v = env[UI_READ_ONLY_SETTING];
  if (v === undefined || v === "" || v === "0") return false;
  if (v === "1") return true;
  return { problem: `${UI_READ_ONLY_SETTING}=${JSON.stringify(v)}: 1 (the web page only shows, and changes nothing) or 0 (the default)` };
}

/** Why the page offers no control that changes anything: `/api/state` `pageReadOnly`, the page's words. */
export const PAGE_READ_ONLY_WHY = `the web page is read-only here (${UI_READ_ONLY_SETTING}=1)`;

/** The answer to every change the page asks for under the setting. */
export const PAGE_READ_ONLY: Failure = {
  message: `${PAGE_READ_ONLY_WHY}: it shows what Mason syncs, and changes nothing`, code: "refused",
  why: `Mason was started with ${UI_READ_ONLY_SETTING}=1, so the page refuses every change, whatever it asks`,
  fix: "make the change with the mason command where Mason runs, or ask whoever runs it",
};

export const UI_READ_ONLY_ALLOW_SETTING = "MASON_UI_READ_ONLY_ALLOW";

/** What a read-only page may still change, each a page of its own: its tables, its users — in this order, whatever
 *  the order the setting names them in. */
export const PAGE_AREAS = ["tables", "users"] as const;
export type PageArea = typeof PAGE_AREAS[number];

/** In a route's path, exactly one segment that is not empty (a user's name, encoded): the router's `[^/]+`. */
const NAME = "<name>";

/**
 * Each area's changes: the method and the path the run's server routes it by (src/cli/run-server.ts), segment by
 * segment — each the same text, or `<name>` for exactly one segment that is not empty — never a prefix and never a
 * pattern of more: `/api/users/<name>` is not `/api/users/a/b`, and no other route of the server has the shape of one
 * of these (tests/cli-ui-read-only.test.ts sends every method to every route of the server).
 */
export const AREA_ROUTES: Readonly<Record<PageArea, ReadonlyArray<readonly [method: string, path: string]>>> = {
  // Add, Columns… and Name its key… (POST /api/pick), Remove (POST /api/remove), Sync now (POST /api/sync)
  tables: [["POST", "/api/pick"], ["POST", "/api/remove"], ["POST", "/api/sync"]],
  // Add a user (POST /api/users), Disable, Enable, Connects from… (POST /api/users/<name>/disable|enable|from), Remove
  users: [["POST", "/api/users"], ["POST", `/api/users/${NAME}/disable`], ["POST", `/api/users/${NAME}/enable`], ["POST", `/api/users/${NAME}/from`],
    ["DELETE", `/api/users/${NAME}`]],
};

/** What each area lets the page do, in the words the refusal and `mason serve --help` say. */
const AREA_WORDS: Readonly<Record<PageArea, string>> = {
  tables: "adding, removing and syncing tables",
  users: "adding, disabling, enabling and removing users and changing the addresses they connect from",
};

/** What the setting takes, as its refusal says it. */
const ALLOW_WORDS = `tables (a read-only page still allows ${AREA_WORDS.tables}), users (${AREA_WORDS.users}), or both as tables,users; or unset`;

/**
 * MASON_UI_READ_ONLY_ALLOW as the environment says it: the areas (none when unset or empty), in PAGE_AREAS' order, or
 * what is wrong with it — a comma list read strictly: each item an area exactly (no space, no other case), none empty,
 * none twice; or one set while MASON_UI_READ_ONLY is not 1 (a junk MASON_UI_READ_ONLY is its own problem, said by
 * `uiReadOnlySetting`). A refusal names an item by its place and never quotes one that is not an area (all input is
 * untrusted, and the refusal reaches the log): it suggests the area the item is closest to.
 */
export function uiReadOnlyAllowSetting(env: Readonly<Record<string, string | undefined>>): PageArea[] | { problem: string } {
  const v = env[UI_READ_ONLY_ALLOW_SETTING];
  if (v === undefined || v === "") return [];
  const items = v.split(",");
  const seen: PageArea[] = [];
  for (const [i, item] of items.entries()) {
    const which = items.length === 1 ? "its value" : `its item ${i + 1} of ${items.length}`;
    if (item === "") return { problem: `${UI_READ_ONLY_ALLOW_SETTING}: ${which} is empty; it takes ${ALLOW_WORDS}` };
    if (!(PAGE_AREAS as readonly string[]).includes(item)) return { problem: `${UI_READ_ONLY_ALLOW_SETTING}: ${which} is not an area; it takes ${ALLOW_WORDS}${didYouMean(item, PAGE_AREAS)}` };
    const area = item as PageArea;
    if (seen.includes(area)) return { problem: `${UI_READ_ONLY_ALLOW_SETTING}: it names ${area} twice; it takes ${ALLOW_WORDS}` };
    seen.push(area);
  }
  const areas = PAGE_AREAS.filter((a) => seen.includes(a));
  if (uiReadOnlySetting(env) === false) {
    return { problem: `${UI_READ_ONLY_ALLOW_SETTING}=${areas.join(",")} is set without ${UI_READ_ONLY_SETTING}=1: it says what a read-only page still allows, and this page is not read-only (set ${UI_READ_ONLY_SETTING}=1, or unset ${UI_READ_ONLY_ALLOW_SETTING})` };
  }
  return areas;
}

/** The way out of a refused MASON_UI_READ_ONLY_ALLOW, at the start (src/cli/project.ts startSettingRefusal). */
export const UI_READ_ONLY_ALLOW_FIX = `set ${UI_READ_ONLY_ALLOW_SETTING} to tables, users or tables,users beside ${UI_READ_ONLY_SETTING}=1, or unset it`;

/** Whether `pathname` is the route's `path`, segment by segment (`<name>`: one segment, not empty). */
const routeIs = (path: string, pathname: string): boolean => {
  const want = path.split("/"), got = pathname.split("/");
  return want.length === got.length && want.every((w, i) => w === NAME ? got[i] !== "" : w === got[i]);
};

/** Whether a change the page asks for is one an allowed area makes: its method and its path exactly, as routed. */
export const pageAllows = (allow: readonly PageArea[], method: string | undefined, pathname: string): boolean =>
  allow.some((a) => AREA_ROUTES[a].some(([m, p]) => m === method && routeIs(p, pathname)));

/** The allowed areas in PAGE_AREAS' order. */
const inOrder = (allow: readonly PageArea[]): PageArea[] => PAGE_AREAS.filter((a) => allow.includes(a));

/** What a read-only page still changes, in its own words: "its tables", "its tables and users"; null for nothing. */
export const pageAllowsText = (allow: readonly PageArea[]): string | null => allow.length === 0 ? null : `its ${inOrder(allow).join(" and ")}`;

/** The answer to a change the page asks for that no allowed area makes: PAGE_READ_ONLY, its why naming what is allowed. */
export const pageReadOnlyRefusal = (allow: readonly PageArea[]): Failure => allow.length === 0 ? PAGE_READ_ONLY : {
  ...PAGE_READ_ONLY,
  message: `${PAGE_READ_ONLY_WHY}: it shows what Mason syncs, and changes nothing but ${pageAllowsText(allow)!}`,
  why: `Mason was started with ${UI_READ_ONLY_SETTING}=1 and ${UI_READ_ONLY_ALLOW_SETTING}=${inOrder(allow).join(",")}, so the page refuses every change but ${inOrder(allow).map((a) => AREA_WORDS[a]).join(" and ")}`,
};

/**
 * Whether a request the guard let in is a change the page asks for: anything but a GET or a HEAD, sent without the
 * run's token (a request with it is the commands', and the guard has checked that the token is the run's).
 */
export const pageWrite = (method: string | undefined, authorization: string | undefined): boolean =>
  method !== "GET" && method !== "HEAD" && authorization === undefined;
