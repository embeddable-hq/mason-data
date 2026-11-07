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
 */
import type { Failure } from "./command.ts";

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

/**
 * Whether a request the guard let in is a change the page asks for: anything but a GET or a HEAD, sent without the
 * run's token (a request with it is the commands', and the guard has checked that the token is the run's).
 */
export const pageWrite = (method: string | undefined, authorization: string | undefined): boolean =>
  method !== "GET" && method !== "HEAD" && authorization === undefined;
