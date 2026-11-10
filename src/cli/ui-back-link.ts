/**
 * `MASON_UI_BACK_URL` and `MASON_UI_BACK_LABEL` (mason serve): A LINK BACK TO THE SITE THAT LINKS TO THE PAGE. A page
 * opened from another application (a portal, a hosted service's console) offers the way back at the top of its sidebar,
 * "← <label>", in the same tab. Unset, the page is as before.
 *
 * THE URL IS AN OPERATOR'S TEXT PUT IN A PAGE, so it is held to two forms and refused otherwise, at the start:
 *   - a path on the page's own host, `/something`: a single `/` first (never `//`, a host of its own to a browser), and
 *     resolved by the browser from the host's root — under a reverse proxy that serves the page at `/mason/`, `/app` is
 *     `https://<host>/app`, never `/mason/app`;
 *   - an `https://` or `http://` URL with a host, and no user or password in it.
 * Every other scheme (`javascript:`, `data:`, `vbscript:`, …) is refused, as is a backslash (a browser reads `/\host` as
 * `//host`), any character that is not printable ASCII (a control character, a space, a host not in its `xn--` form),
 * and a URL past `BACK_URL_MAX`. It is read by the URL parser, and what the page is given is the parser's own
 * serialisation, so the page is handed what the parser read, never the text beside it.
 *
 * THE LABEL IS TEXT, never HTML: the page sets it as an element's text (src/web/app.js `setBack`), so `<b>` reads as
 * `<b>`. A control or format character (bidi overrides, zero-width ones) is refused, as is a label past
 * `BACK_LABEL_MAX` characters or of white space alone. Set without the URL it is refused: a setting is never ignored.
 *
 * Following the link sends no referrer (the page's `Referrer-Policy: no-referrer`, and the link's `rel="noreferrer"`),
 * so the page's address, which a tunnel's first request carries a ticket in, never reaches the other site.
 */
export const UI_BACK_URL_SETTING = "MASON_UI_BACK_URL";
export const UI_BACK_LABEL_SETTING = "MASON_UI_BACK_LABEL";

/** The longest URL taken, in characters (all ASCII): far past any real one, short of a page's worth. */
export const BACK_URL_MAX = 2048;
/** The longest label taken, in characters: a sidebar's row. */
export const BACK_LABEL_MAX = 64;
/** The label when none is set. */
export const BACK_LABEL_DEFAULT = "Back";

/** What `/api/state` `pageBack` says, and the page renders. */
export interface BackLink { url: string; label: string }
/** A link an operator puts in the page (the link back, a sidebar link of the host's: src/cli/ui-nav.ts), read by
 *  `linkUrl` and `linkLabel`. */
export type PageLink = BackLink;

/** A base the parser resolves a path against, only to tell that it stayed a path: never shown, never fetched. */
const PATH_BASE = "http://path.invalid";

/**
 * A LINK'S URL as the page is given it, or what is wrong with it (the value itself never quoted: it may carry anything).
 * THE ONE READING of a URL an operator puts in the page — the link back's, and the sidebar's (src/cli/ui-nav.ts) — so
 * the rules above are written once. `at` names the setting as the problem says it (`MASON_UI_BACK_URL is set`), `noun`
 * what the length bounds (`a link back`).
 */
export function linkUrl(v: string, at: string, noun: string): string | { problem: string } {
  if (v.length > BACK_URL_MAX) return { problem: `${at} to ${v.length} characters, and ${noun} is at most ${BACK_URL_MAX}: name a shorter one` };
  if (!/^[\x21-\x7e]*$/.test(v)) {
    return { problem: `${at} to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and the rest %-encoded` };
  }
  if (v.includes("\\")) return { problem: `${at} to a URL with a backslash, which a browser reads as /: write / or %5C` };
  if (v.startsWith("/")) {
    if (v.startsWith("//")) return { problem: `${at} to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://` };
    let u: URL;
    try { u = new URL(v, PATH_BASE); } catch { return { problem: `${at} to a path the URL parser cannot read: a path on this host, /something` }; }
    const served = `${u.pathname}${u.search}${u.hash}`;
    // the parser removes dot segments: `/.//host` is `//host`, another host to a browser, however it was written
    if (u.origin !== PATH_BASE || served.startsWith("//")) return { problem: `${at} to a path that leaves this host: a path on this host, /something` };
    return served;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v)?.[1];
  if (scheme === undefined || !/^https?$/i.test(scheme) || !/^https?:\/\//i.test(v)) {
    return { problem: `${at} to ${scheme === undefined ? "neither a path nor a URL" : `a ${scheme.toLowerCase()}: URL`}: a path on this host (/something), or an https:// or http:// URL` };
  }
  let u: URL;
  try { u = new URL(v); } catch { return { problem: `${at} to a URL the URL parser cannot read: an https:// or http:// URL, with its host` }; }
  if (u.username !== "" || u.password !== "") return { problem: `${at} to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them` };
  if (u.hostname === "") return { problem: `${at} to a URL with no host: an https:// or http:// URL, with its host` };
  return u.href;
}

/**
 * A LINK'S LABEL as the page shows it, or what is wrong with it: the one reading of a label an operator puts in the page
 * (the link back's, the sidebar's). `subject` names it as the problem says it (`MASON_UI_BACK_LABEL`), `blank` the way
 * out of a label of white space alone.
 */
export function linkLabel(v: string, subject: string, blank: string): string | { problem: string } {
  const chars = [...v];
  if (chars.length > BACK_LABEL_MAX) return { problem: `${subject} is ${chars.length} characters, and the link's label is at most ${BACK_LABEL_MAX}: name a shorter one` };
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v)) return { problem: `${subject} has a control or format character (a line break, a tab, a direction mark): the link's label is one line of plain text` };
  if (v.trim() === "") return { problem: `${subject} is white space alone: ${blank}` };
  return v;
}

/**
 * The link back as the environment says it: null when MASON_UI_BACK_URL is unset (or set empty) and so is the label,
 * the link, or what is wrong — every problem of the two, on one line.
 */
export function uiBackLinkSetting(env: Readonly<Record<string, string | undefined>>): BackLink | null | { problem: string } {
  const urlText = env[UI_BACK_URL_SETTING] ?? "";
  const labelText = env[UI_BACK_LABEL_SETTING] ?? "";
  if (urlText === "") {
    return labelText === "" ? null : { problem: `${UI_BACK_LABEL_SETTING} is set without ${UI_BACK_URL_SETTING}, and the page has no link to label: set ${UI_BACK_URL_SETTING} too, or unset it` };
  }
  const url = linkUrl(urlText, `${UI_BACK_URL_SETTING} is set`, "a link back");
  const label = labelText === "" ? BACK_LABEL_DEFAULT : linkLabel(labelText, UI_BACK_LABEL_SETTING, `name the link's label, or unset it (${BACK_LABEL_DEFAULT})`);
  const problems = [url, label].flatMap((x) => typeof x === "string" ? [] : [x.problem]);
  if (problems.length > 0) return { problem: problems.join("; ") };
  return { url: url as string, label: label as string };
}

/** Which of the two a start was given: what `mason start` names when it refuses them. */
export const backLinkSettingsSet = (env: Readonly<Record<string, string | undefined>>): string[] =>
  [UI_BACK_URL_SETTING, UI_BACK_LABEL_SETTING].filter((k) => (env[k] ?? "") !== "");

/** The link a run's page is given: the setting's link, else none (a problem refused the start before the run reads it). */
export const backLinkOf = (s: BackLink | null | { problem: string }): BackLink | null => s !== null && !("problem" in s) ? s : null;
