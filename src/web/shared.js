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

/** `1,204 changes (1,000 inserts, 200 updates, 4 deletes)`: a table's counts as the stream's lines say them (src/duck/stream.ts `countsText`). */
export function countsText(c) {
  const total = c.inserts + c.updates + c.deletes + c.truncates;
  const parts = [[c.inserts, "insert"], [c.updates, "update"], [c.deletes, "delete"], [c.truncates, "truncate"]]
    .filter(([k]) => k > 0).map(([k, w]) => `${n(k)} ${w}${k === 1 ? "" : "s"}`);
  return `${n(total)} change${total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/**
 * THE WAL THE SLOT HOLDS ON THE DATABASE, in a line (src/cli/commands.ts `slotText`, held equal by the tests): how much,
 * Postgres's status of it, the cap — or that nothing caps it — and a slot Postgres invalidated. `w` is `stream.slotWal`:
 * { walHeldBytes, walStatus, safeWalSizeBytes, at } or { error }; `since(iso)` is its age in seconds.
 */
export function slotText(w, since) {
  if ("error" in w) return `the WAL it holds could not be read: ${w.error.split("\n")[0]}`;
  const read = `(read ${spanText(since(w.at))} ago)`;
  if (w.walStatus === "lost") return `lost: Postgres invalidated it (it held more WAL than max_slot_wal_keep_size), so Mason makes it again and catches the copies up by one poll ${read}`;
  const cap = w.safeWalSizeBytes === null
    ? "max_slot_wal_keep_size is unset, so nothing caps it: while nothing reads the slot it holds WAL for ever, until the database's disk fills (set max_slot_wal_keep_size on the database)"
    : w.safeWalSizeBytes <= 0 ? "past max_slot_wal_keep_size: Postgres invalidates it at its next checkpoint, and Mason makes it again"
    : `${fileSize(w.safeWalSizeBytes)} more before Postgres invalidates it (max_slot_wal_keep_size)`;
  return `holds ${fileSize(w.walHeldBytes)} of the database's WAL${w.walStatus === null ? "" : ` (${w.walStatus})`} · ${cap} ${read}`;
}

/** Whether the slot's line is a warning: the WAL could not be read, Postgres invalidated it, it is past its cap or nothing caps it. */
export const slotWarns = (w) => "error" in w || w.walStatus === "lost" || w.walStatus === "unreserved" || w.safeWalSizeBytes === null || w.safeWalSizeBytes <= 0;

/** `Mason` in mason status (src/cli/commands.ts `masonRow`): the run's version and how long it has been up. The CLI adds the
 *  run's pid, which the state does not carry: the tests hold the rest equal. */
export const masonRow = (e) => ["Mason", `${e.version} · one process${e.startedAt ? ` · up ${spanText(e.uptimeSeconds ?? 0)}, since ${e.startedAt.slice(0, 19).replace("T", " ")} UTC` : ""}`];

/** `Sessions` in mason status (src/cli/commands.ts `sessionsRows`). */
export function sessionsRows(s) {
  if (s === undefined) return [];
  if ("error" in s) return [["Sessions", `could not be read: ${s.error.split("\n")[0]}`]];
  if (s.open === 0) return [["Sessions", "none open"]];
  const running = s.byClient.reduce((a, c) => a + c.running, 0);
  const who = s.byClient.slice(0, 3).map((c) => `${c.open} ${c.user === "" ? "by a token" : `as ${c.user}`}${c.client === "" ? "" : ` (${c.client})`}`);
  const others = s.byClient.length - who.length;
  return [["Sessions", `${s.open} open, ${running} running a statement · ${who.join(", ")}${others > 0 ? `, and ${others} other client${others === 1 ? "" : "s"}` : ""} (mason logs --running lists the statements)`]];
}

/** `Disk` in mason status (src/cli/commands.ts `diskRows`), but for the path: the page never shows an absolute path, so
 *  it says "where the copy is" for ` in <path>` (the tests hold the rest equal). */
export function diskRows(d) {
  if (d === undefined) return [];
  const adds = d.projectedBytes === null ? "" : ` · the copies running are projected to add about ${fileSize(d.projectedBytes)} more`;
  if (d.freeBytes === null) return [["Disk", `${d.error ?? "the free space could not be read"}${adds}`]];
  return [["Disk", `${fileSize(d.freeBytes)} free where the copy is${adds}${d.projectedBytes !== null && d.projectedBytes > d.freeBytes ? " — more than is free: the copy stops before the disk fills" : ""}`]];
}

/** `Restarts` in mason status (src/cli/commands.ts `restartsRows`; its `ago` is `agoText`): none, no row. */
export function restartsRows(r, now = Date.now()) {
  if (r === undefined) return [];
  if ("error" in r) return [["Restarts", r.error]];
  if (r.last === null) return [];
  return [["Restarts", `${r.count}, the last ${agoText(r.last.at, now)}: ${r.last.why}, after ${r.last.upSeconds} s up (mason logs --start has its last lines)`]];
}

/** A time as `mason status` says how long ago (src/cli/commands.ts `ago`). */
export function agoText(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/**
 * WHERE THE STREAM IS, as `mason status` says it (src/cli/commands.ts `streamLines`, held equal by the tests): `head`
 * the stream's own rows (not running and why, its position against the database's, the last change), `tables` a row
 * per added table — streamed, being caught up, not streamed yet or left out, and why. `st` is `/api/state` `stream`.
 */
export function streamRows(st, now = Date.now()) {
  const head = [], tables = [];
  const since = (iso) => (now - Date.parse(iso)) / 1000;
  if (!st.running) {
    head.push(["stream", st.failure === null ? "not running yet: it starts once the slot is made"
      : `not running: ${st.failure.error.split("\n")[0]} · it starts again in ${spanText(Math.max(0, -since(st.failure.retryAt)))}`]);
  }
  const db = "lsn" in st.database
    ? `the database is at ${st.database.lsn}: ${n(st.lag.bytes ?? 0)} bytes behind (read ${spanText(since(st.database.at))} ago)`
    : `the database's position could not be read: ${st.database.error.split("\n")[0]}`;
  head.push(["position", `${st.position} · ${db}`]);
  head.push(["slot", slotText(st.slotWal, since)]);
  head.push(["last change", st.lastBatch === null ? "none applied this run"
    : `committed ${spanText(since(st.lastBatch.committedAt))} ago, applied ${spanText((Date.parse(st.lastBatch.appliedAt) - Date.parse(st.lastBatch.committedAt)) / 1000)} after its commit`]);
  const total = (t) => t.applied.inserts + t.applied.updates + t.applied.deletes + t.applied.truncates;
  for (const t of st.tables) {
    const counts = ` · ${countsText(t.applied)} this run`;
    const c = t.catchUp;
    tables.push([t.table, t.state === "streamed" ? `streamed${counts}`
      : t.state === "catching-up" && c !== undefined
        ? `catching up by one poll ${c.from ? `from ${c.from.slice(0, 16).replace("T", " ")} UTC` : t.why?.replace(/^caught up by one poll /, "") ?? ""}: ` +
          `${c.phase === "queued" ? (c.retryAt ? `its last catch-up failed, tried again after ${c.retryAt.slice(11, 16)} UTC (mason logs says why)` : "waiting its turn") : c.phase === "polling" ? "polling" : "applying what the stream held meanwhile"}` +
          `${c.startedAt ? `, for ${spanText(since(c.startedAt))}` : ""} · the stream holds ${n(c.held)} change${c.held === 1 ? "" : "s"} of it meanwhile${total(t) ? counts : ""}`
      : t.state === "left-out" ? `left out: ${t.why ?? ""}`
      : `not streamed yet: ${t.why ?? ""}${total(t) ? counts : ""}`]);
  }
  return { head, tables };
}

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
