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
 * `projectWriteRefusal` as before, so `MASON_PROJECT_READONLY=1` still refuses an Add or a Remove. Set without
 * `MASON_UI_READ_ONLY=1` it refuses the start: an allowance on a page that is not read-only says the operator meant a
 * read-only page and did not get one.
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

/** What a read-only page may still change, each a page of its own: `tables` alone for now. */
export const PAGE_AREAS = ["tables"] as const;
export type PageArea = typeof PAGE_AREAS[number];

/** Each area's changes: the method and the exact path the run's server routes it by (src/cli/run-server.ts). */
const AREA_ROUTES: Readonly<Record<PageArea, ReadonlyArray<readonly [method: string, path: string]>>> = {
  // Add, Columns… and Name its key… (POST /api/pick), Remove (POST /api/remove), Sync now (POST /api/sync)
  tables: [["POST", "/api/pick"], ["POST", "/api/remove"], ["POST", "/api/sync"]],
};

/** What each area lets the page do, in the words the refusal and `mason serve --help` say. */
const AREA_WORDS: Readonly<Record<PageArea, string>> = { tables: "adding, removing and syncing tables" };

/**
 * MASON_UI_READ_ONLY_ALLOW as the environment says it: the areas (none when unset or empty), or what is wrong with it —
 * a value that is not an area, or one set while MASON_UI_READ_ONLY is not 1 (a junk MASON_UI_READ_ONLY is its own
 * problem, said by `uiReadOnlySetting`).
 */
export function uiReadOnlyAllowSetting(env: Readonly<Record<string, string | undefined>>): PageArea[] | { problem: string } {
  const v = env[UI_READ_ONLY_ALLOW_SETTING];
  if (v === undefined || v === "") return [];
  if (!(PAGE_AREAS as readonly string[]).includes(v)) {
    return { problem: `${UI_READ_ONLY_ALLOW_SETTING}=${JSON.stringify(v)}: ${PAGE_AREAS.join(", ")} (a read-only page still allows ${AREA_WORDS.tables}), or unset${didYouMean(v, PAGE_AREAS)}` };
  }
  if (uiReadOnlySetting(env) === false) {
    return { problem: `${UI_READ_ONLY_ALLOW_SETTING}=${v} is set without ${UI_READ_ONLY_SETTING}=1: it says what a read-only page still allows, and this page is not read-only (set ${UI_READ_ONLY_SETTING}=1, or unset ${UI_READ_ONLY_ALLOW_SETTING})` };
  }
  return [v as PageArea];
}

/** Whether a change the page asks for is one an allowed area makes: its method and its path exactly, as routed. */
export const pageAllows = (allow: readonly PageArea[], method: string | undefined, pathname: string): boolean =>
  allow.some((a) => AREA_ROUTES[a].some(([m, p]) => m === method && p === pathname));

/** The answer to a change the page asks for that no allowed area makes: PAGE_READ_ONLY, its why naming what is allowed. */
export const pageReadOnlyRefusal = (allow: readonly PageArea[]): Failure => allow.length === 0 ? PAGE_READ_ONLY : {
  ...PAGE_READ_ONLY,
  message: `${PAGE_READ_ONLY_WHY}: it shows what Mason syncs, and changes nothing but its tables`,
  why: `Mason was started with ${UI_READ_ONLY_SETTING}=1 and ${UI_READ_ONLY_ALLOW_SETTING}=${allow.join(",")}, so the page refuses every change but ${allow.map((a) => AREA_WORDS[a]).join(" and ")}`,
};

/**
 * Whether a request the guard let in is a change the page asks for: anything but a GET or a HEAD, sent without the
 * run's token (a request with it is the commands', and the guard has checked that the token is the run's).
 */
export const pageWrite = (method: string | undefined, authorization: string | undefined): boolean =>
  method !== "GET" && method !== "HEAD" && authorization === undefined;
