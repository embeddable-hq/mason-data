/**
 * WHAT EVERY PAGE OF THE WEB UI SHARES (src/web/app.js is the shell; each page is a module of src/web/pages/): the
 * helpers that say a value as the commands say it, a Failure as the CLI renders it, and the one way a page asks the
 * run (`createAsk`). DOM-free, so tests/web-page.test.ts runs them under node.
 */

/** A value as HTML text: every character that means something in HTML escaped. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A count as the commands print it: `1,234`. */
export const n = (x) => x.toLocaleString("en-US");
/** A text's first line, trimmed: a reason's headline (its further lines are its detail). */
export const firstLine = (s) => s.split("\n")[0].trim();
/** Something to type, as the CLI colours it. */
export const code = (s) => `<code>${esc(s)}</code>`;
/** Rows of facts, `[label, value]` each, as `mason status` lists its rows. */
export const rowsHtml = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;

/** A span of seconds as a person reads it: `45 s`, `12 min`, `2 h 5 min` (src/cli/readiness.ts `duration`, held equal by the tests). */
export function duration(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A span of seconds as the stream's lines say it: `0.3 s` under ten seconds, then `duration` (src/cli/commands.ts `spanText`). */
export const spanText = (seconds) => seconds < 10 ? `${Math.max(0, seconds).toFixed(1)} s` : duration(seconds);

/** A file's size as mason status and mason usage say it (src/cli/commands.ts `fileSize`). */
export const fileSize = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`;

/** Bytes as mason status's queries say them: B under a KiB, then `fileSize` (src/cli/commands.ts `bytesText`). */
export const bytesText = (b) => b < 1024 ? `${n(b)} B` : fileSize(b);

/** An ISO time as the commands' lines print it: `2026-10-27 09:04:00` (UTC). */
export const utcText = (iso) => iso.slice(0, 19).replace("T", " ");

/** A share (0 to 1) as the commands print it beside a bar: whole percent, rounded down (`12%`). */
export const percent = (share) => `${Math.floor(Math.max(0, Math.min(1, share)) * 100)}%`;

/** The time a copy has left, as the commands print it: `~12 min left`; "" when nothing is measured yet. */
export const leftText = (secondsLeft) => secondsLeft === null || secondsLeft === undefined ? "" : `~${duration(secondsLeft)} left`;

/** A table as the commands name it: `orders` in public, else `schema.table` (src/cli/sources.ts `entryName`). */
export const entryName = (table) => table.startsWith("public.") ? table.slice("public.".length) : table;

/**
 * A FAILURE AS THE CLI SAYS IT (src/cli/command.ts `failureText`): what is wrong after a ✗, then `why` and `fix` as
 * rows, then Next: each command and what it does. `f` is the server's `failure` ({ code, message, why?, fix?, next }).
 */
export function renderFailure(f) {
  const rows = [...(f.why ? [["why", f.why]] : []), ...(f.fix ? [["fix", f.fix]] : [])];
  const next = f.next ?? [];
  return `<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${esc(f.message)}</p>` +
    (rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "") +
    (next.length ? `<p class="next-head">Next:</p><ul class="next">${next.map((s) => `<li>${code(s.command)}${s.what ? ` <span>${esc(s.what)}</span>` : ""}</li>`).join("")}</ul>` : "") +
    "</div>";
}

/**
 * WHY A REQUEST TO THE RUN FAILED, as a Failure: the server's own `failure` when it sent one; else what the status
 * means here — 403, a cookie this run does not take (the run started again, with a new token); no answer at all, the
 * run stopped. `status` null: fetch itself failed, `text` its error.
 */
export function failureOf(status, text) {
  if (status !== null) {
    let body = null;
    // the guard answers its refusals as plain text, not JSON: read as text below
    try { body = JSON.parse(text); } catch { body = null; }
    if (body && typeof body.failure === "object" && body.failure !== null) return body.failure;
    if (status === 403 || status === 421) {
      return { code: "refused", message: "this page's cookie is not the running Mason's", why: text.trim() || `HTTP ${status}`,
        fix: "Mason was started again since this page was opened, and each run has its own token: mason ui, in the project's folder, opens this page again",
        next: [{ command: "mason ui", what: "this page, for the Mason that is running" }] };
    }
    return { code: "failed", message: (body && typeof body.error === "string" ? body.error : text.trim()) || `HTTP ${status}`, next: [{ command: "mason logs", what: "the run's log: what it was doing" }] };
  }
  return { code: "unreachable", message: "Mason does not answer at this address", why: `the run stopped, or runs on another port now (${text})`,
    fix: "mason start in the project's folder, then mason ui opens this page again: each run has its own address and token",
    next: [{ command: "mason status", what: "whether Mason runs, and why it stopped" }, { command: "mason start", what: "start it" }, { command: "mason ui", what: "this page, for the Mason that is running" }] };
}

/** One request to the run over `fetchFn`: `{ body }`, its JSON, or `{ failure }` when it was refused or nothing answered. */
export function createAsk(fetchFn) {
  return async (path, init) => {
    let res;
    try { res = await fetchFn(path, { credentials: "same-origin", ...init }); }
    catch (e) { return { failure: failureOf(null, e?.message ?? String(e)) }; }
    const text = await res.text();
    if (!res.ok) return { failure: failureOf(res.status, text) };
    try { return { body: JSON.parse(text) }; }
    catch (e) { return { failure: { code: "failed", message: `the run's answer to ${path} is not JSON: ${e.message}` } }; }
  };
}

/** A request's init carrying JSON: `json("POST", { tables })`. */
export const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** The last-updated line: when the page last heard from the run, in the reader's time. */
export const updatedText = (at) => `Updated ${at.toLocaleTimeString("en-GB")}`;

/** A one-line placeholder for a page not built yet: what it will show, and the command that shows it today. */
export const placeholder = (what, command) => `<p class="dim">${esc(what)}: not built yet. ${code(command)} shows it in a terminal.</p>`;
