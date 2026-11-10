/**
 * THE HOST'S VIEWS AND CARD (mason serve's MASON_UI_NAV_LINKS `{ label, view }` and MASON_UI_OVERVIEW_CARD; issue 814,
 * docs/WEB-UI.md "Host views"): a site that embeds the page supplies facts of its own as DATA, read from a path relative
 * to the page's own address (same origin: the page's `default-src 'self'` holds), held here to ONE small shape, and
 * rendered in the page's own look — every string as TEXT, never HTML; no form and no button that changes anything.
 *
 *   { title, sections: [{ heading, facts?: [{ label, value, copy?, status? }], text?, links?: [{ label, url, primary? }] }],
 *     refresh? }
 *
 * READ IN THE PAGE, NOT AT THE START: the answer arrives when the view is shown, from whatever the proxy answers, so it is
 * untrusted data here — at most `HOST_BYTES_MAX` bytes, JSON, exactly the shape (a key it does not take, a string too
 * long or of a control character, a list too long is outside it), else the view's own failure (`renderFailure`). A
 * link's URL is read by the link back's rules (`hostLinkUrl`, held equal to src/cli/ui-back-link.ts `linkUrl` by
 * tests/web-page.test.ts: the page cannot import the CLI, and the server never sees this data); a link that fails them
 * is DROPPED and said, never rendered. `refresh` (seconds) is held within `REFRESH_MIN_S`..`REFRESH_MAX_S`; without
 * it, the view is read when it is shown and not again.
 */
import { esc, status, copyable, renderFailure } from "./shared.js";

/** The most bytes of an answer read: a view is a page of facts, never a log. */
export const HOST_BYTES_MAX = 256 * 1024;
/** The bounds of `refresh`, in seconds: never a poll faster than the page's own, nor a view frozen for longer than an hour. */
export const REFRESH_MIN_S = 5;
export const REFRESH_MAX_S = 3600;
/** The bounds of what is written, whatever the data: sections, facts and links a section, and a string's characters. */
export const HOST_LIMITS = { sections: 20, facts: 50, links: 20, line: 200, value: 2000, text: 8000 };
/** The longest link URL taken (src/cli/ui-back-link.ts BACK_URL_MAX). */
const URL_MAX = 2048;

/** A base the parser resolves a path against, only to tell that it stayed a path: never shown, never fetched (the
 *  link back's own, src/cli/ui-back-link.ts; written without the two slashes the parser adds to a special scheme, so
 *  this file names no site — tests/web-page.test.ts holds the page's files to that). */
const PATH_BASE = new URL("http:path.invalid").origin;

/**
 * A LINK'S URL AS THE PAGE WRITES IT, or null: the link back's rules (src/cli/ui-back-link.ts `linkUrl`, which the
 * tests hold this to case by case): printable ASCII, no backslash, at most 2048 characters; a path from the host's root
 * (`/x`, never `//`, nor one the parser reads as leaving the host) as the parser serialises it; or an https: or http:
 * URL with a host and no user or password, as the parser serialises it. Anything else — `javascript:`,
 * `data:`, a relative path, text that is no URL — is null.
 */
export function hostLinkUrl(v) {
  if (typeof v !== "string" || v.length > URL_MAX || !/^[\x21-\x7e]*$/.test(v) || v.includes("\\")) return null;
  if (/^\//.test(v)) {
    if (/^\/\//.test(v)) return null;
    let u;
    try { u = new URL(v, PATH_BASE); } catch { return null; }
    const served = `${u.pathname}${u.search}${u.hash}`;
    return u.origin !== PATH_BASE || served.startsWith("//") ? null : served;
  }
  if (!/^https?:\/\//i.test(v)) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  return u.username !== "" || u.password !== "" || u.hostname === "" ? null : u.href;
}

/** A line of text: a string of at most `max` characters with no control, format or line-separator character. */
const isLine = (v, max) => typeof v === "string" && [...v].length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v);
/** A prose text: as a line, but line breaks taken. */
const isText = (v, max) => typeof v === "string" && [...v].length <= max && !/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n]/u.test(v);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** The first key of `o` not among `keys`, else undefined. */
const strayKey = (o, keys) => Object.keys(o).find((k) => !keys.includes(k));
/** A list of at most `max`, absent being none. */
const listOf = (v, max) => v === undefined ? [] : Array.isArray(v) && v.length <= max ? v : null;

/**
 * THE ANSWER HELD TO THE SHAPE: `{ view }` — the view as the page renders it, each section's links that fail the link
 * rules dropped and counted (`dropped`), `refresh` held within its bounds — or `{ problem }`, where it is outside the
 * shape, in words (a place like `sections[1].facts[0].value`, never the value).
 */
export function hostView(v) {
  const L = HOST_LIMITS;
  if (!isObject(v)) return { problem: "it is not an object { title, sections }" };
  const stray = strayKey(v, ["title", "sections", "refresh"]);
  if (stray !== undefined) return { problem: `it has a key a view does not take (${isLine(stray, 64) ? JSON.stringify(stray) : "unreadable"}): a view is { title, sections, refresh? }` };
  if (!isLine(v.title, L.line)) return { problem: `its title is not one line of text of at most ${L.line} characters` };
  const sections = listOf(v.sections, L.sections);
  if (sections === null || v.sections === undefined) return { problem: `its sections is not a list of at most ${L.sections}` };
  let refresh = null;
  if (v.refresh !== undefined) {
    if (typeof v.refresh !== "number" || !Number.isFinite(v.refresh) || v.refresh <= 0) return { problem: "its refresh is not a number of seconds" };
    refresh = Math.min(REFRESH_MAX_S, Math.max(REFRESH_MIN_S, Math.round(v.refresh)));
  }
  const out = [];
  for (const [i, s] of sections.entries()) {
    const at = `sections[${i}]`;
    if (!isObject(s)) return { problem: `${at} is not an object { heading, facts, text, links }` };
    const k = strayKey(s, ["heading", "facts", "text", "links"]);
    if (k !== undefined) return { problem: `${at} has a key a section does not take (${isLine(k, 64) ? JSON.stringify(k) : "unreadable"}): a section is { heading, facts?, text?, links? }` };
    if (!isLine(s.heading, L.line)) return { problem: `${at}.heading is not one line of text of at most ${L.line} characters` };
    if (s.text !== undefined && !isText(s.text, L.text)) return { problem: `${at}.text is not text of at most ${L.text} characters` };
    const facts = listOf(s.facts, L.facts);
    if (facts === null) return { problem: `${at}.facts is not a list of at most ${L.facts}` };
    const links = listOf(s.links, L.links);
    if (links === null) return { problem: `${at}.links is not a list of at most ${L.links}` };
    const fs = [];
    for (const [j, f] of facts.entries()) {
      const fat = `${at}.facts[${j}]`;
      if (!isObject(f) || strayKey(f, ["label", "value", "copy", "status"]) !== undefined) return { problem: `${fat} is not { label, value, copy?, status? }` };
      if (!isLine(f.label, L.line)) return { problem: `${fat}.label is not one line of text of at most ${L.line} characters` };
      if (!isLine(f.value, L.value)) return { problem: `${fat}.value is not one line of text of at most ${L.value} characters` };
      if (f.copy !== undefined && typeof f.copy !== "boolean") return { problem: `${fat}.copy is not true or false` };
      if (f.status !== undefined && !["ok", "warn", "bad"].includes(f.status)) return { problem: `${fat}.status is not ok, warn or bad` };
      fs.push({ label: f.label, value: f.value, copy: f.copy === true, status: f.status ?? null });
    }
    const ls = [];
    let dropped = 0;
    for (const [j, l] of links.entries()) {
      const lat = `${at}.links[${j}]`;
      if (!isObject(l) || strayKey(l, ["label", "url", "primary"]) !== undefined) return { problem: `${lat} is not { label, url, primary? }` };
      if (!isLine(l.label, L.line) || l.label.trim() === "") return { problem: `${lat}.label is not one line of text of at most ${L.line} characters` };
      if (l.primary !== undefined && typeof l.primary !== "boolean") return { problem: `${lat}.primary is not true or false` };
      const url = hostLinkUrl(l.url);
      if (url === null) { dropped++; continue; }
      ls.push({ label: l.label, url, primary: l.primary === true });
    }
    out.push({ heading: s.heading, facts: fs, text: s.text ?? null, links: ls, dropped });
  }
  return { view: { title: v.title, sections: out, refresh } };
}

/** The failure of a host's view or card, in the page's Failure shape: what could not be read, and why. */
export const hostFailure = (path, why) => ({ code: "failed", message: `the host's view at ${path} could not be read`, why,
  fix: "the site that serves this page answers this path with a view's JSON, { title, sections: [{ heading, facts, links }] } (docs/WEB-UI.md \"Host views\"); on a page that no site serves, nothing does" });

/** The answer's text, or null once it passes `max` bytes (read no further than that). */
async function boundedText(res, max) {
  const length = Number(res.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(length) && length > max) return null;
  const reader = res.body?.getReader?.();
  if (reader === undefined) { const t = await res.text(); return new TextEncoder().encode(t).length > max ? null : t; }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch((e) => console.warn("the host's answer could not be cancelled", e)); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * READ A HOST'S VIEW over `fetchFn` (the browser's, or a test's) at `path`, relative to the page's own address:
 * `{ body }`, the view held to its shape (`hostView`), or `{ failure }` — nothing answered, not 2xx, more than
 * `HOST_BYTES_MAX` bytes, not JSON, or outside the shape.
 */
export async function readHost(fetchFn, path) {
  let res;
  try { res = await fetchFn(path, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" }); }
  catch (e) { return { failure: hostFailure(path, `nothing answered it (${e?.message ?? String(e)})`) }; }
  if (!res.ok) return { failure: hostFailure(path, `it answered HTTP ${res.status}`) };
  let text;
  try { text = await boundedText(res, HOST_BYTES_MAX); }
  catch (e) { return { failure: hostFailure(path, `its answer could not be read (${e?.message ?? String(e)})`) }; }
  if (text === null) return { failure: hostFailure(path, `its answer is more than ${HOST_BYTES_MAX / 1024} KiB, the most a view is read`) };
  let v;
  try { v = JSON.parse(text); } catch { return { failure: hostFailure(path, "its answer is not JSON") }; }
  const r = hostView(v);
  return "problem" in r ? { failure: hostFailure(path, `its answer is outside a view's shape: ${r.problem}`) } : { body: r.view };
}

/** How often a host's view is read while shown, in ms: its `refresh`, else once when it is shown (Infinity). */
export const hostEvery = (view) => typeof view?.refresh === "number" ? view.refresh * 1000 : Infinity;

/** The store's key of a host's read: never one of the run's paths, whatever the path is. */
export const hostKey = (path) => `host:${path}`;

/** A fact's value: its marker and word when it carries a status (never colour alone), with Copy when it says copy. */
function factValue(f, id) {
  if (f.copy) return `${f.status ? status(f.status, "") : ""}${copyable(id, f.value)}`;
  return f.status ? status(f.status, f.value) : esc(f.value);
}

/** What a section says of the links it left out: never rendered, said. */
const droppedLine = (n) => n === 0 ? "" : `<p class="dim">${n} link${n === 1 ? "" : "s"} left out: ${n === 1 ? "its URL is" : "their URLs are"} neither a path on this host (/something) nor an https or http URL with its host.</p>`;

/** A section's links: each in the same tab, sending no referrer; the primary one the page's primary action. */
const linksHtml = (links) => links.length === 0 ? "" : `<p class="host-links">${links.map((l) =>
  `<a class="btn small${l.primary ? " primary" : ""}" href="${esc(l.url)}" rel="noreferrer">${esc(l.label)}</a>`).join(" ")}</p>`;

/**
 * A HOST'S VIEW AS THE PAGE WRITES IT (`key` names its Copy buttons apart): a panel a section — its heading, its facts
 * as a table of facts, its text, its links — every string escaped.
 */
export function renderHostView(view, key = "view") {
  if (view.sections.length === 0) return `<p class="dim">The host's view has nothing in it.</p>`;
  return view.sections.map((s, i) => `<div class="panel host-section"><h3>${esc(s.heading)}</h3>` +
    (s.facts.length ? `<table class="facts-table"><tbody>${s.facts.map((f, j) => `<tr><th scope="row">${esc(f.label)}</th><td>${factValue(f, `host-${key}-${i}-${j}`)}</td></tr>`).join("")}</tbody></table>` : "") +
    (s.text === null ? "" : `<p class="host-text">${esc(s.text)}</p>`) + linksHtml(s.links) + droppedLine(s.dropped) + "</div>").join("");
}

/**
 * THE HOST'S CARD ON THE OVERVIEW from its read (`r`: `{ body, failure }`, undefined before it): one card beside Mason's
 * own — its title the card's label, each section's facts as rows, its links under them. Its failure is said IN the card
 * (the last view read stays under it); before the first answer, that it is being read.
 */
export function renderHostCard(r) {
  if (r === undefined) return `<div class="card host-card"><p class="card-label">The host's card</p><p class="dim">Reading it…</p></div>`;
  const v = r.body;
  const failed = r.failure ? `<p class="card-sub host-failed"><span class="mark" aria-hidden="true">✗</span> ${esc(r.failure.message)}: ${esc(r.failure.why ?? "")}</p>` : "";
  if (v === undefined) return `<div class="card host-card bad"><p class="card-label">The host's card</p><p class="card-value">unknown</p>${failed}</div>`;
  const body = v.sections.map((s, i) => (v.sections.length > 1 ? `<p class="card-sub host-heading">${esc(s.heading)}</p>` : "") +
    (s.facts.length ? `<dl class="facts">${s.facts.map((f, j) => `<dt>${esc(f.label)}</dt><dd>${factValue(f, `host-card-${i}-${j}`)}</dd>`).join("")}</dl>` : "") +
    (s.text === null ? "" : `<p class="card-sub host-text">${esc(s.text)}</p>`) + linksHtml(s.links) + droppedLine(s.dropped)).join("");
  return `<div class="card host-card"><p class="card-label">${esc(v.title)}</p>${failed}${body}</div>`;
}

/** A host's view's whole part: its failure (the Failure shape) over the last view read, or that it is being read. */
export function renderHostPart(r, key) {
  if (r === undefined) return `<p class="dim">Reading the host's view…</p>`;
  return (r.failure ? renderFailure(r.failure) : "") + (r.body === undefined ? "" : renderHostView(r.body, key));
}
