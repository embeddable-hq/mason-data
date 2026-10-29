/**
 * WHAT EVERY PAGE OF THE WEB UI SHARES (src/web/app.js is the shell; each page is a module of src/web/pages/): the
 * helpers that say a value as the commands say it, a Failure as the CLI renders it, and the one way a page asks the
 * run (`createAsk`). DOM-free, so tests/web-page.test.ts runs them under node.
 */

// the nav's icons: Lucide's, vendored whole, one module per icon, each its SVG as a string (src/web/vendor/README.md)
import layoutDashboard from "./vendor/lucide-1.56.0/layout-dashboard.mjs";
import tableIcon from "./vendor/lucide-1.56.0/table.mjs";
import usersIcon from "./vendor/lucide-1.56.0/users.mjs";
import squareTerminal from "./vendor/lucide-1.56.0/square-terminal.mjs";
import chartColumn from "./vendor/lucide-1.56.0/chart-column.mjs";
import logsIcon from "./vendor/lucide-1.56.0/logs.mjs";
import menuIcon from "./vendor/lucide-1.56.0/menu.mjs";
import xIcon from "./vendor/lucide-1.56.0/x.mjs";

/** The icons the page draws, by Lucide's name: each an inline SVG in `currentColor` (its size and stroke the stylesheet's). */
export const ICONS = { "layout-dashboard": layoutDashboard, table: tableIcon, users: usersIcon, "square-terminal": squareTerminal,
  "chart-column": chartColumn, logs: logsIcon, menu: menuIcon, x: xIcon };

/** An icon, inline and decorative (the label beside it, or its control's own label, is what a reader hears):
 *  `icon("table")`. A name it does not know is no icon. */
export const icon = (name, cls = "") => Object.hasOwn(ICONS, name)
  ? `<span class="icon${cls ? ` ${cls}` : ""}" aria-hidden="true">${ICONS[name].trim()}</span>` : "";

/** A value as HTML text: every character that means something in HTML escaped. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * THE TIME RANGES the Observability pages share (`?range=` of their hash; 24 hours unless it says): each its label, the
 * age every endpoint's `since` takes (src/cli/request-filter.ts `timeOf`), and the usage samples' step — a minute a
 * point for the hour, an hour for the day, six for the week (60, 24 and 28 points: a chart readable at each).
 */
export const RANGES = {
  "1h": { label: "Last hour", span: "the last hour", since: "1h", stepSeconds: 60, days: 0 },
  "24h": { label: "24 hours", span: "the last 24 hours", since: "24h", stepSeconds: 3600, days: 1 },
  "7d": { label: "7 days", span: "the last 7 days", since: "7d", stepSeconds: 21_600, days: 7 },
  // past the week, offered only where the run keeps that much (`rangeOffered`): a day a point, 30 and 90 of them
  "30d": { label: "30 days", span: "the last 30 days", since: "30d", stepSeconds: 86_400, days: 30, longer: true },
  "90d": { label: "90 days", span: "the last 90 days", since: "90d", stepSeconds: 86_400, days: 90, longer: true },
};

/**
 * WHETHER A RANGE CAN BE CHOSEN, by the days the run keeps (`/api/state` `engine.keptDays`, MASON_REQUEST_LOG_DAYS):
 * the hour, the day and the week always (a log that keeps fewer says so where it shows them); a longer one only when
 * the run keeps at least its days — else it is shown disabled, with why and the setting that keeps it (`why`). A run
 * that has not said how long it keeps (`keptDays` undefined) offers no longer one: never a range it could not tell.
 */
export function rangeOffered(key, keptDays) {
  const r = RANGES[key];
  if (!r.longer) return { offered: true, shown: true };
  if (typeof keptDays !== "number") return { offered: false, shown: false };
  if (keptDays >= r.days) return { offered: true, shown: true };
  return { offered: false, shown: true, why: `Mason keeps ${keptDays} day${keptDays === 1 ? "" : "s"} of history: MASON_REQUEST_LOG_DAYS=${r.days} keeps ${r.days}` };
}
export const DEFAULT_RANGE = "24h";
/** A range's key as the hash gave it: one of RANGES, else the default. */
export const rangeOf = (text) => Object.hasOwn(RANGES, String(text ?? "")) ? String(text) : DEFAULT_RANGE;
/** The usage samples of a range, its step a point (src/cli/run-server.ts `usage`): Usage's read, and the Overview's
 *  sparklines (the 24 hours'). */
export const usagePath = (range = DEFAULT_RANGE) => { const r = RANGES[rangeOf(range)]; return `/api/usage?since=${r.since}&step=${r.stepSeconds}`; };

/** How often the shown page is asked while the tab is seen (src/web/app.js polls; a page's every-poll reads use it). */
export const POLL_MS = 2000;

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

/** A duration in milliseconds as a person reads it: `512 ms`, `13.7 s`, `2 min 5 s`, `1 h 4 min` (src/cli/readiness.ts
 *  `msText`, held equal by the tests): every statement's, sync's and percentile's time on the page. */
export function msText(ms) {
  const v = Math.max(0, ms);
  if (Math.round(v) < 1000) return `${Math.round(v)} ms`;
  const tenths = Math.round(v / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const s = Math.round(v / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** A span of seconds as the stream's lines say it: `0.3 s` under ten seconds, then `duration` (src/cli/commands.ts `spanText`). */
export const spanText = (seconds) => seconds < 10 ? `${Math.max(0, seconds).toFixed(1)} s` : duration(seconds);

/** A file's size as mason status and mason usage say it (src/cli/commands.ts `fileSize`). */
export const fileSize = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`;

/** Bytes as mason status's queries say them: B under a KiB, then `fileSize` (src/cli/commands.ts `bytesText`). */
export const bytesText = (b) => b < 1024 ? `${n(b)} B` : fileSize(b);

/** An ISO time as the commands' lines print it: `2026-10-27 09:04:00` (UTC). */
export const utcText = (iso) => iso.slice(0, 19).replace("T", " ");
/** The same to the minute, as the commands' lists print it: `2026-10-27 09:04` (UTC). */
export const utcMinute = (iso) => iso.slice(0, 16).replace("T", " ");

/** A statement on one line, as mason logs says it (src/cli/commands.ts `oneLine`): whitespace collapsed, cut with an ellipsis. */
export const oneLine = (sql, max = 120) => {
  const line = String(sql ?? "").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};
/** How a statement's client is said (src/cli/commands.ts `runningLine`, `requestLine`): its application_name, else the note. */
export const clientText = (applicationName) => applicationName || "(no application_name)";

/** A sync event's cells as `mason logs --events` and mason status's `Sync errors` say them (src/cli/commands.ts
 *  `eventLine`): when, kind, table, the reason's first line. */
export const eventCells = (e) => ({ time: utcText(e.at), kind: e.kind, table: e.table ?? "(the sync)", message: firstLine(e.message) });

/**
 * AN ENTRY OF THE UNSUPPORTED SQL (`/api/unsupported`'s `unsupported[]`: { gap, title, runs, users, clients, last,
 * example }) in mason status's three lines (src/cli/commands.ts `unsupportedLines`, held equal by the tests): what they
 * used (the entry's title), how many statements and who sent them; when the latest was and it on one line (`example`,
 * cut as the CLI cuts it); and `how`, where the way out is (the page cannot link into the repository: it names it). The
 * entry's id (`gap`) is only the title's text, never in a line.
 */
export function unsupportedEntry(g) {
  const who = [...(g.users.length ? [`as ${g.users.join(", ")}`] : []), ...(g.clients.length ? [`from ${g.clients.join(", ")}`] : [])];
  const title = g.title ?? "SQL this Mason no longer lists";
  return { headline: `${title}: ${n(g.runs)} statement${g.runs === 1 ? "" : "s"}${who.length ? ` ${who.join(" ")}` : ""}`,
    last: `last ${utcMinute(g.last)}`, how: `How to rewrite it: see docs/SQL-SUPPORT.md › ${title}`, id: g.gap, example: oneLine(g.example, 100) };
}

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
        ? `catching up by one poll ${c.from ? `from ${utcMinute(c.from)} UTC` : t.why?.replace(/^caught up by one poll /, "") ?? ""}: ` +
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

/** A part of a page written from one read: its body rendered, its Failure said where it shows when `says` (not the
 *  page's first read's: that is the banner), or that it is being asked. */
export function readPart(ctx, path, render, says) {
  const r = ctx.read(path);
  if (r === undefined) return `<p class="dim">Asking Mason…</p>`;
  return (r.failure && says ? renderFailure(r.failure) : "") + (r.body === undefined ? "" : render(r.body));
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

/** The last-updated line: how long ago the page last heard from the run (`Updated 3 s ago`), so a run that stopped
 *  answering is seen ageing. `now` is the page's clock. */
export const updatedText = (at, now = new Date()) => `Updated ${duration(Math.max(0, (now.getTime() - at.getTime()) / 1000))} ago`;

// ------------------------------------------------------------------ the components (src/web/app.css styles them; docs/WEB-UI.md "Presentation")
// Each returns HTML from values it escapes; a part that is already HTML (a chart's holder, a body) is said so by its name.

/** What a word of the commands' says about a state, as the dot's colour: ok, warn, bad or unknown. */
export function statusKind(word) {
  const w = String(word ?? "").toLowerCase();
  if (/^(ready|synced|done|copied|completed|ok|streamed|running|live|added)\b/.test(w)) return "ok";
  if (/^(failed|error|refused|lost|not running|stopped)\b/.test(w)) return "bad";
  if (/^(under way|syncing|copying|waiting|catching up|not streamed|not kept current|unsynced|cancelled|warning|left out|pending)\b/.test(w)) return "warn";
  return "unknown";
}

const KINDS = new Set(["ok", "warn", "bad", "unknown"]);
const kindOf = (k) => KINDS.has(k) ? k : "unknown";

/** A state as a small coloured dot and its word — never the colour alone: `status("ok", "Synced")`; the kind from the
 *  word when it is omitted (`status(undefined, "Failed")`). */
export const status = (kind, word) => `<span class="indicator ${kindOf(kind ?? statusKind(word))}"><span class="dot" aria-hidden="true"></span>${esc(word)}</span>`;

/** A small label: `badge("demo")`; `kind` one of accent, ok, warn, bad. */
export const badge = (text, kind = "") => `<span class="badge${kind ? ` ${esc(kind)}` : ""}">${esc(text)}</span>`;

/** A KPI card: its label small and muted, its value large, a sub-line, and a chart's holder (`spark(...)` of
 *  src/web/charts.js: HTML) under it; `kind` warn or bad colours the value of one to act on. With `href` (a hash of the
 *  page: `#observability/queries`) the whole card is a link into the view that lists what it counts (its arrow is the
 *  stylesheet's, so a reader of the text reads the card the same). */
export function card(label, value, sub = "", chartHtml = "", kind = "", href = "") {
  const tag = href ? "a" : "div";
  return `<${tag} class="card${kind === "warn" || kind === "bad" ? ` ${kind}` : ""}${href ? " link" : ""}"${href ? ` href="${esc(href)}"` : ""}>` +
    `<p class="card-label">${esc(label)}</p><p class="card-value">${esc(value)}</p>` +
    `${sub === "" ? "" : `<p class="card-sub">${esc(sub)}</p>`}${chartHtml}</${tag}>`;
}
/** The cards in a grid (each `card(...)`'s HTML), its class saying how many (`cards n6`), so the stylesheet lays every
 *  count out without a card alone on a row: six in one row or two of three, five as three over two. */
export const cards = (list) => list.length ? `<div class="cards n${list.length}">${list.join("")}</div>` : "";

/** A table (or any wide HTML) in a hairline card that scrolls sideways on a phone, never the page. */
export const panel = (html) => `<div class="panel">${html}</div>`;

/** A button: `button("Sync", { sync: "public.orders" }, "primary")` → data-sync="public.orders"; `variant` primary,
 *  danger or "" (secondary), with " small" for a compact one in a row. */
export function button(label, data = {}, variant = "") {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${esc(v)}"`).join("");
  return `<button type="button"${variant ? ` class="${esc(variant)}"` : ""}${attrs}>${esc(label)}</button>`;
}

/** A text with its Copy button (`copyClick` copies what the `<code id>` holds): a URL, a psql line, a password. `clip`:
 *  one line, cut by the stylesheet with an ellipsis in a narrow cell (a table's URL column), its whole the title —
 *  Copy copies the whole either way. */
export const copyable = (id, text, { clip = false } = {}) =>
  `<span class="copyrow${clip ? " clipped" : ""}"><code id="${esc(id)}"${clip ? ` title="${esc(text)}"` : ""}>${esc(text)}</code> ${button("Copy", { copy: id }, "small")}</span>`;

/** How long a Copy button says Copied (or what to press) before it says Copy again. */
export const COPIED_MS = 2000;

/**
 * A COPY BUTTON CLICKED (`data-copy`, a `copyable`'s), on whichever page: its code's text to the clipboard, the button
 * then saying Copied for COPIED_MS and Copy again. When the clipboard refuses (no permission, an insecure origin, a
 * browser setting), the text is selected and copied as a selection is (`execCommand("copy")`); when that fails too, it
 * stays selected and the button says what to press. null for a button that is no Copy, so a page's `click` asks it first.
 */
export function copyClick(d, button, { doc, win }) {
  if (d.copy === undefined) return null;
  const el = doc.getElementById(d.copy);
  const text = el?.textContent ?? "";
  const say = (word) => {
    button.textContent = word;
    if (button.dataset) button.dataset.copied = "";
    win.setTimeout?.(() => { button.textContent = "Copy"; if (button.dataset) delete button.dataset.copied; }, COPIED_MS);
  };
  return Promise.resolve().then(() => win.navigator.clipboard.writeText(text)).then(() => say("Copied"), () => {
    // no clipboard: the text selected, and copied as a selection is (what a person's own Copy would do)
    const selection = win.getSelection?.();
    if (el && selection) selection.selectAllChildren(el);
    let copied = false;
    try { copied = doc.execCommand?.("copy") === true; } catch { copied = false; }   // refused outright: said below, the text left selected
    say(copied ? "Copied" : `Selected: press ${/Mac|iPhone|iPad/.test(win.navigator.platform ?? win.navigator.userAgent ?? "") ? "⌘C" : "Ctrl+C"}`);
  });
}

/** What the request log does not list (src/cli/commands.ts `UNLISTED_STATEMENTS`, held equal by the tests): a statement
 *  that reads no copied table is the catalog's to answer, and not recorded — so a `select 1` never shows on Queries. */
export const UNLISTED_STATEMENTS = "A statement that reads no copied table (select 1, SET, SHOW, a BI tool's catalog queries) is answered but not listed";

/** The hash of the page that makes a user (src/web/app.js PAGES): where Connect's Create a user leads. */
export const USERS_HASH = "#users";

/**
 * HOW A TOOL CONNECTS (`/api/state` `postgres`, as `mason status --json` says it; src/cli/pg-url.ts postgresFacts): the
 * Postgres API's URL with `<user>:<password>` in the credentials' place — the line `mason start` and `mason status`
 * print — and its psql line, each with Copy, and Create a user (the Users page), whose name and password go in that
 * place. `first` (nothing has asked Mason anything yet) leads with what the URL is for. Nothing from a run that does
 * not say it.
 */
export function renderConnect(pg, { first = false, table = null } = {}) {
  if (!pg || typeof pg.shown !== "string") return "";
  // a first statement to type that the request log lists (one that reads a copied table: UNLISTED_STATEMENTS)
  const tryIt = first && table ? `<dt>Then try</dt><dd>${copyable("connect-try", `select count(*) from ${entryName(table)};`)} <span class="dim">it shows on Queries</span></dd>` : "";
  return `<div class="connect${first ? " first" : ""}"><p class="connect-title">${first ? "Connect your first tool" : "Connect"}</p>` +
    (first ? `<p class="lead">Mason answers SQL over the Postgres protocol, as a read replica of your database would: point psql, a BI tool or your app's analytics code at this URL.</p>` : "") +
    `<dl class="facts"><dt>URL</dt><dd>${copyable("connect-url", pg.shown)}</dd><dt>psql</dt><dd>${copyable("connect-psql", pg.psql)}</dd>${tryIt}</dl>` +
    `<p class="tip"><a class="btn${first ? " primary" : ""}" href="${USERS_HASH}">Create a user</a> <span>Its name and password go in place of ${code("<user>:<password>")}: the Users page shows the whole URL once, as ${code("mason user add <name>")} prints it.</span></p></div>`;
}

/** Nothing to show, quietly: a title and a line under it (`hintHtml`: HTML, a command in code()). */
export const empty = (title, hintHtml = "") => `<div class="empty"><p class="empty-title">${esc(title)}</p>${hintHtml ? `<p>${hintHtml}</p>` : ""}</div>`;

/** Being asked: the words a reader (and a test) reads, over grey bars the size of what will come. */
export const skeleton = (lines = 3, what = "Asking Mason…") => `<div class="loading" aria-busy="true"><p class="dim">${esc(what)}</p>` +
  Array.from({ length: lines }, (_, i) => `<span class="skeleton${i === lines - 1 ? " half" : ""}"></span>`).join("") + "</div>";

/**
 * A <details> that STAYS OPEN across a refresh: a poll rewrites the part it is in, so whether it is open is the page's
 * state (`createOpenSet`), keyed by a stable id (`key`: a request's id, a table's name), never the element's.
 * `summary` is text, `bodyHtml` HTML. `details(key, "More", body, opened.has(key))`.
 */
export const details = (key, summary, bodyHtml, open = false, cls = "") =>
  `<details${cls ? ` class="${esc(cls)}"` : ""} data-open="${esc(key)}"${open ? " open" : ""}><summary>${esc(summary)}</summary>${bodyHtml}</details>`;

/**
 * The open <details> of a page, by key: `has(key)` for the renderer; `toggle(target)` is the page's `toggle` (the shell
 * hears every details open or close): null when it is no keyed details or nothing changed (the toggle a rewrite causes
 * itself), else true, and the shell writes the page again.
 */
export function createOpenSet() {
  const open = new Set();
  return {
    open,
    has: (key) => open.has(String(key)),
    toggle(target) {
      const key = target?.dataset?.open;
      if (typeof key !== "string" || key === "") return null;
      const now = target.open === true;
      if (now === open.has(key)) return null;
      if (now) open.add(key); else open.delete(key);
      return true;
    },
  };
}

// ------------------------------------------------------------------ large data: what the page writes is bounded

/** A text cut to `max` characters with an ellipsis (a title, a cell): the page never writes a 64 KiB statement into an
 *  attribute or a row; the whole of it is behind its details, itself capped (`capped`). */
export const clip = (s, max) => { const t = String(s ?? ""); return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`; };

/** The most of a text a title attribute carries (a statement's, an error's). */
export const TITLE_MAX = 1000;

/** A text as a details shows it, at most `max` characters: `{ text, cut }`, `cut` what is said after it when it was cut
 *  ("the first 16.0 KiB of 64.0 KiB: … has it whole"; `whole` names where). */
export function capped(s, max, whole) {
  const t = String(s ?? "");
  if (t.length <= max) return { text: t, cut: "" };
  return { text: t.slice(0, max), cut: `the first ${fileSize(max)} of ${fileSize(t.length)}: ${whole} has it whole` };
}

/** "Showing 100 of 800" and the buttons that write more (`data-show-more`, `data-show-all` = `key`): under a list the page
 *  writes at most `shown` rows of. "" when every row is shown. */
export function moreRows(key, shown, total, step) {
  if (shown >= total) return "";
  return `<div class="more"><p class="dim">Showing ${n(shown)} of ${n(total)}.</p>` +
    `${button(`Show ${n(Math.min(step, total - shown))} more`, { showMore: key }, "small")} ${button(`Show all ${n(total)}`, { showAll: key }, "small")}</div>`;
}

// ------------------------------------------------------------------ sorting a table by a column

/** A sort: `{ key, dir }`, dir "asc" or "desc". The column clicked again turns it round; another starts at `first`. */
export const nextSort = (sort, key, first = "desc") => sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: first };

/** A sortable column's header: a button (`data-sort-table`, `data-sort-key`) whose arrow and `aria-sort` say the order. */
export function sortTh(table, key, label, sort, cls = "") {
  const on = sort.key === key;
  const aria = on ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  return `<th scope="col" aria-sort="${aria}"${cls ? ` class="${esc(cls)}"` : ""}><button type="button" class="sort${on ? " on" : ""}" data-sort-table="${esc(table)}" data-sort-key="${esc(key)}">` +
    `${esc(label)}<span class="arrow" aria-hidden="true">${on ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span></button></th>`;
}

/** A list sorted by `value(item)` (a number or a string; null last whatever the order), stably, without changing it. */
export function sortedBy(list, value, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return list.map((x, i) => ({ x, i, v: value(x) })).sort((a, b) => {
    if (a.v === null || a.v === undefined) return b.v === null || b.v === undefined ? a.i - b.i : 1;
    if (b.v === null || b.v === undefined) return -1;
    return (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * sign || a.i - b.i;
  }).map((e) => e.x);
}
