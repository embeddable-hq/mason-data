/**
 * THE OVERVIEW (#overview; `#status`, its old address, lands here; the module and its section keep the id `status`): what `mason status` prints — the run in one word (`readiness`), ONE table of facts (the
 * database and how its changes arrive, Mason's version, uptime and restarts, the copies in all, the copy's file, the
 * disk, the sessions open, the warnings), the changes the stream carries (replication mode: its position, lag, last
 * batch and the slot's hold on the database's WAL), the statements of the last day and week, the copies not finished (a
 * bar each, only while there are any), and the recent errors (the sync's and the statements', and the last day's
 * unsupported SQL in a line). The slow and the refused statements are the Queries page's. Reads `/api/state` every poll, the request log's every 30 s, the last 24 hours of
 * usage (the cards' sparklines) every 60 s. Never the engine's name.
 *
 * Laid out as a dashboard (docs/WEB-UI.md "Presentation"): the word with a big dot, then KPI cards (the copies in all,
 * their rows, the last sync, the copy's file, the last day's statements and their p95 — each its own fact, said once,
 * with a sparkline of the last 24 hours where one helps), the copies not finished, the ONE table of the other facts,
 * the stream, the statements, the recent errors. Each card links into the view that lists what it counts (the tables,
 * filtered to the failed ones when a copy failed; Observability's Queries — the slow ones for the p95 — and Usage).
 */

/** Where each card leads: the views that list what it counts (src/web/app.js hashes). */
// each with the range of what it counts — the statements of the last day, the sync's failures of the days kept — never
// the Observability views' default, Now: a card that says 12 failed must land on the 12
const LINKS = { tables: "#tables", failedTables: "#tables?show=failed", usage: "#observability/usage?range=24h", queries: "#observability/queries?range=24h",
  slow: "#observability/queries?slow=1&range=24h", failedQueries: "#observability/queries?status=refused-or-failed&range=24h", failedEvents: "#observability/syncs?failures=1&range=7d" };
import { msText, bytesText, code, esc, fileSize, firstLine, n, percent, leftText, spanText, duration, entryName, streamRows, slotWarns, masonRow, sessionsRows, diskRows, restartsRows, utcText,
  utcMinute, oneLine, clientText, eventCells, unsupportedEntry, usagePath, POLL_MS, card, cards, details, createOpenSet, skeleton, renderConnect, copyClick } from "../shared.js";
import { spark, seriesOf, drawable } from "../charts.js";

/** How many recent errors of each kind are shown: mason status's (src/cli/commands.ts `RECENT_ERRORS`, held equal by the tests). */
export const RECENT_ERRORS = 5;

/** The last 24 hours an hour a point: the cards' sparklines (Usage's read at its default range). */
const HOURLY = usagePath("24h");

/**
 * What a copying table's line says, and how full its bar is: src/cli/readiness.ts `copyingText`, line for line, so the
 * page and `mason status` say one thing (tests/web-page.test.ts holds the two equal).
 */
export function copyingText(copied, rowsEstimate, p) {
  const shown = copied + (p?.rowsReading ?? 0);
  const estimate = rowsEstimate !== null && rowsEstimate > 0 ? rowsEstimate : null;
  const past = estimate !== null && shown > estimate;
  const fraction = p !== undefined ? p.share : estimate === null ? null : Math.min(0.99, shown / estimate);
  const of = estimate === null ? "" : past ? ` · past the ~${n(estimate)} estimated` : ` of ~${n(estimate)}`;
  const rowsText = (k) => past ? `${n(k)} rows${of}` : `${n(k)}${of} rows`;
  if (p === undefined) return { fraction, text: rowsText(copied) };
  const since = p.readingSeconds === null ? "" : ` (${duration(p.readingSeconds)})`;
  const chunks = (k) => `${k} chunk${k === 1 ? "" : "s"}`;
  if (p.rowsPerSecond === null) {
    const first = p.reading === 0 ? "about to read the first chunk" : `reading the first ${p.reading === 1 ? "chunk" : chunks(p.reading)}${since}`;
    return { fraction, text: copied === 0 ? `${first}${estimate === null ? "" : ` · ~${n(estimate)} rows to copy`}` : `${rowsText(copied)} · resumed, ${first}` };
  }
  const parts = [rowsText(shown)];
  const allIn = p.reading === 0 && p.chunksDone >= p.chunksTotal;
  if (allIn) parts.push(`every chunk read (${p.chunksDone}): checking it and swapping it in`);
  else parts.push(`${p.reading === 0 ? "starting the next chunk" : `${chunks(p.reading)} reading${since}`}, ${p.chunksDone} of ~${p.chunksTotal} in`);
  parts.push(`${n(Math.round(p.rowsPerSecond))} rows/s`);
  if (!allIn && p.secondsLeft !== null) parts.push(leftText(p.secondsLeft));
  return { fraction, text: parts.join(" · ") };
}

/**
 * AN ADDED TABLE'S LINE, as `mason status` and `mason wait` print it after its bar (src/cli/commands.ts `tableLines`):
 * its state (done, unsynced, failed, copying, waiting), how full its bar is, and what it says — a copied one with how it is kept
 * current and how old its copy is (`keptAge`).
 */
export function tableLine(t, now = Date.now()) {
  if (t.error) return { state: "failed", fraction: 1, what: `its copy failed: ${firstLine(t.error)}` };
  if (t.copy?.phase === "copying") {
    const c = copyingText(t.copy.rowsCopied, t.rows, t.copy.progress);
    return { state: "copying", fraction: c.fraction ?? 0, what: /^\d/.test(c.text) ? `copying ${c.text}` : c.text };
  }
  if (!t.copy) return { state: "waiting", fraction: 0, what: "waiting for its copy to start" };
  const age = keptAge(t, now);
  // a copy the poll does not keep current (it waits for its catch-up) is a warning, as mason status paints it (paintBar)
  if ((t.kept?.by === "poll" && t.kept.pending !== undefined) || (t.kept?.by === "replication" && (t.kept.state !== "streamed" || t.kept.notRunning !== null))) {
    return { state: "unsynced", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied${t.copy.retired ? ` · ${t.copy.retired}` : ""} · ${age}` };
  }
  return { state: "done", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied${t.copy.retired ? ` · ${t.copy.retired}` : ""}${age ? ` · ${age}` : ""}` };
}

/** How long ago a table was synced, as `mason status` says it on its line (src/lib/table-sync.ts `agoText`, which
 *  writes `4 s ago`, `3 days ago`; shared.js `agoText` is mason status's `ago`, `4s ago`, for a stream's times). */
function syncedAgo(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** How a copied table is kept current and how old its copy is (src/cli/commands.ts `keptAge`). */
export function keptAge(t, now = Date.now()) {
  const k = t.kept;
  if (k?.by === "replication") {
    if (k.state !== "streamed") return `NOT kept current (${k.syncedAt === null ? "never synced" : `last synced ${syncedAgo(k.syncedAt, now)}`}): ${k.why ?? "it is not streamed yet"}`;
    const at = `replicated, at ${k.position}, ${k.syncedAt === null ? "not synced yet" : syncedAgo(k.syncedAt, now)}`;
    return k.notRunning === null ? at : `${at} — NOT kept current now, the stream is not running: ${k.notRunning}`;
  }
  if (k?.by !== "poll") return null;
  const synced = k.syncedAt === null ? "never synced" : `last synced ${syncedAgo(k.syncedAt, now)}`;
  if (k.pending !== undefined) return `NOT kept current (${synced}): ${k.pending}`;
  if (k.sync.mode === "off") return `sync: off, ${synced} — mason sync ${entryName(t.table)} syncs it now; sync: poll 5m on its entry polls it`;
  return `polled every ${k.sync.every}, ${k.syncedAt === null ? "not polled yet" : `last ${syncedAgo(k.syncedAt, now)}`}`;
}

/**
 * A COPY'S BAR, the one renderer of the Overview's "copies not finished" and the Tables page's rows: a thin rounded
 * track and a solid fill to the share drawn, its % as text at the bar's END (as `mason wait` prints it beside its bar),
 * with an explicit `role="progressbar"` and `aria-valuemin/max/now` (and a text label, `aria-valuetext`, the line's
 * words); the track is `aria-hidden` drawing. `l` is `tableLine`'s, `fraction` the share to draw (`monotone`'s; the
 * line's own by default): the fill's colour is the line's state (the stylesheet's `.t-<state>`: green served, the accent
 * while it copies, amber not kept current, rose failed). A table waiting for its copy has no value: no fill but the
 * stylesheet's quiet shimmer over the track, `aria-valuenow` and the % left out. `from`, the share at the page's last
 * read (`monotone.before`), is kept for the callers; the fill's own transition moves it from there.
 */
export function copyBar(table, l, fraction = l.fraction, _from) {
  const waiting = l.state === "waiting";
  const value = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
  return `<span class="copybar${waiting ? " indeterminate" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100"` +
    `${waiting ? "" : ` aria-valuenow="${value}"`} aria-label="${esc(`${table}: its copy`)}" aria-valuetext="${esc(waiting ? l.what : `${value}%, ${l.what}`)}">` +
    `<span class="track" aria-hidden="true"><span class="fill"${waiting ? "" : ` style="width: ${value}%"`}></span></span></span>` +
    // a copy not begun has no share yet: no "0%" at its end (its line says it waits)
    (waiting ? "" : ` <span class="pct">${percent(fraction)}</span>`);
}

/**
 * THE SHARES A PAGE DRAWS, NEVER BACKWARDS: for each added table that is copying, the most its share has been since the
 * copy began (the server's share is of pages and does not go back within a copy; this holds it so across a reconnect or
 * a re-read, too). A table that stops copying (done, failed, waiting) is forgotten, so its next copy begins at its own.
 * `of(s)` → Map(table → share) for the tables copying in the state `s`.
 */
export function createMonotone() {
  const seen = new Map();
  let before = new Map();
  return {
    /** The shares of the read before the last `of`: each copying table's (`copyBar`'s `from`). */
    get before() { return before; },
    of(s) {
      before = new Map(seen);
      const now = new Map();
      for (const t of s.tables) {
        if (!t.added) continue;
        const l = tableLine(t);
        if (l.state === "copying") now.set(t.table, Math.max(seen.get(t.table) ?? 0, l.fraction));
      }
      seen.clear();
      for (const [k, v] of now) seen.set(k, v);
      return now;
    },
  };
}

/** `mason status`'s rows for the database (src/cli/commands.ts `sourceRows`): its sources file (from the project's root:
 *  the page never shows an absolute path), its URL as the run masked it, how its changes arrive. */
export function sourceRows(s) {
  return [
    ...(s.source.file ? [["Source", `${s.source.shownFile ?? s.source.file} (the tables it names are added)`]] : []),
    ["Database", s.source.demo ? `the demo database Mason hosts (${s.source.url} · Postgres ${s.source.version})`
      : `${s.source.url} · Postgres ${s.source.version}${s.source.standby ? " · a read replica" : ""}`],
    // in a web developer's words first (each table as its sync: says, streamed as they happen); the mechanism an operator needs in parentheses
    ["Changes", `each table as its sync: says${s.source.replication ? "" : " (a SELECT of its changed rows)"}${s.source.sync ? ` · sync: ${s.source.sync.default} ${s.source.sync.written ? "for every table without its own" : "(the default: the file writes none)"}` : ""} · ` +
      (s.source.replication ? `sync: replication tables streamed as they happen (logical replication: slot ${s.source.replication.slot}, publication ${s.source.replication.publication}, ` +
          `${s.source.replication.owned ? "Mason's own, carrying them alone" : "named: read as it is, never altered"}); the others by a SELECT of their changed rows`
        : s.source.demo ? "the demo database is checked this way only"
        : "sync: replication on an entry streams that table as it happens instead")],
  ];
}

/** THE RUN IN ONE WORD, as `mason status` heads its last line (src/cli/readiness.ts `readinessWord`): Ready, Failed or
 *  Under way. */
export function readinessWord(r) {
  return r.ready ? "Ready" : r.failed.length ? "Failed" : "Under way";
}

/** The copies in all, as mason status's `Copies` row says them (src/cli/commands.ts `totalsText`). */
export function totalsText(t, now = Date.now()) {
  const last = t.syncedAt === null ? "" : `, the last synced ${duration((now - Date.parse(t.syncedAt)) / 1000)} ago`;
  return `${n(t.copied)} of ${n(t.added)} added copied, ${n(t.rows)} row${t.rows === 1 ? "" : "s"}${t.failed ? `, ${n(t.failed)} failed` : ""}${last}`;
}

/** The word at the top of the page: the run's readiness ("" with no table added: `renderStatus` says so, and what adds one). */
export function renderHealth(s) {
  if (!s.tables.some((t) => t.added) || !s.readiness) return "";
  const word = readinessWord(s.readiness);
  return `<div class="health ${word === "Ready" ? "ok" : word === "Failed" ? "bad" : "warn"}" role="status"><span class="dot" aria-hidden="true"></span><span class="word">${esc(word)}</span></div>`;
}

/** The sparklines the cards draw, by holder key: a usage sample's field each (src/web/charts.js specs). */
const SPARKS = { rows: ["copyRows", "Rows copied"], "copy-bytes": ["copyBytes", "The copy's file"], statements: ["statements", "Statements"], p95: ["durationP95Ms", "p95"] };

/** The sparklines' specs from the usage answer (`/api/usage`'s body; anything else draws none): what `charts()` returns. */
export function sparkSpecs(usage) {
  const samples = usage && Array.isArray(usage.samples) ? usage.samples : [];
  return Object.fromEntries(Object.entries(SPARKS).map(([key, [field, label]]) => [key, { kind: "spark", label, ...seriesOf(samples, field) }]).filter(([, spec]) => drawable(spec)));
}

/** How many added tables are copying now (tableLine's word), the cards' "N copying". */
export const copyingCount = (s) => s.tables.filter((t) => t.added && tableLine(t).state === "copying").length;

/**
 * THE KPI CARDS: the copies in all (synced of added, the failed), their rows, the last sync (how long ago, and when),
 * the copy's file (its size, or why it is unknown), and the last day's statements and their p95 from the request log
 * (`q`: `/api/queries`' body, or `{ failure }`). Each card's sparkline is the last 24 hours (`usage`), only where there
 * are two hours to draw; its numbers are the card's text either way. These facts are said here, and not in the facts table.
 */
export function renderKpis(s, o = {}) {
  const now = o.now ?? Date.now();
  const sparks = sparkSpecs(o.usage);
  const line = (key) => sparks[key] ? spark(key, `${SPARKS[key][1]}, the last 24 hours an hour a point`) : "";
  const list = [];
  const t = s.totals;
  // as renderStatus judges it: a table added (the totals count what the sources file names)
  const added = Boolean(t) && s.tables.some((x) => x.added);
  if (added) list.push(
    card("Tables synced", `${n(t.copied)} of ${n(t.added)}`, `added${t.failed ? `, ${n(t.failed)} failed` : ""}${copyingCount(s) ? `, ${n(copyingCount(s))} copying` : ""}`, "", t.failed ? "bad" : "", t.failed ? LINKS.failedTables : LINKS.tables),
    card("Rows", n(t.rows), "", line("rows"), "", LINKS.tables),
    t.syncedAt === null ? card("Last sync", "none yet", "", "", "", LINKS.tables) : card("Last sync", `${duration((now - Date.parse(t.syncedAt)) / 1000)} ago`, `${utcText(t.syncedAt)} UTC`, "", "", LINKS.tables));
  const d = s.disk;
  const copyBytes = s.engine.bytes ?? (d && typeof d.copyBytes === "number" ? d.copyBytes : null);
  if (added || copyBytes !== null) list.push(copyBytes === null ? card("The copy's file", "unknown", "its size could not be read", "", "", LINKS.usage) : card("The copy's file", fileSize(copyBytes), "", line("copy-bytes"), "", LINKS.usage));
  const q = o.queries;
  if (added && q !== undefined) {
    if ("failure" in q) list.push(card("Statements, last day", "unknown", `could not read them: ${firstLine(q.failure.message)}`, "", "", LINKS.queries));
    else {
      const day = q.queries.day;
      const bad = day.refused + day.failed + day.cancelled;
      list.push(card("Statements, last day", n(day.statements), `${n(day.completed)} completed${bad ? `, ${n(bad)} refused, failed or cancelled` : ""}`, line("statements"), day.failed ? "warn" : "", LINKS.queries),
        card("p95, last day", day.durationMs === null ? "–" : msText(day.durationMs.p95),
          day.durationMs === null ? "no statement completed" : `average ${msText(day.durationMs.avg)} · p50 ${msText(day.durationMs.p50)}`, line("p95"), "", LINKS.slow));
    }
  }
  return cards(list);
}

/** A fact's row; `warn` marks one the reader should act on. */
const factRow = (k, v, warn = false) => `<tr${warn ? ` class="warn"` : ""}><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;

/** The stream's lag, said once: the bytes behind the database and the age of the newest change applied. */
const lagText = (lag) => `${lag.bytes === null || lag.bytes === undefined ? "bytes behind unknown" : `${bytesText(lag.bytes)} behind the database`}${lag.seconds === null || lag.seconds === undefined ? "" : `, the newest change applied was committed ${spanText(lag.seconds)} ago`}`;

/**
 * THE CHANGES THE STREAM CARRIES (replication mode: `/api/state` `stream`; "" without one), a table of facts: whether it
 * runs and why not, its position, its lag, the last batch applied (`streamRows`, held equal to `mason status`'s
 * `streamLines`), and the WAL the slot holds on the database (`slotText`, one of its rows). Each table's own stream state is the Tables page's.
 */
function renderStream(s, now = Date.now()) {
  const st = s.stream;
  if (!st) return "";
  const { head } = streamRows(st, now);
  // `head` is the CLI's rows: "stream" (only when it is not running, and why), the position, the last change
  const label = (k) => k[0].toUpperCase() + k.slice(1);
  const rows = [...(st.running ? [factRow("Stream", "running")] : []), ...head.map(([k, v]) => factRow(label(k), v, k === "stream" || (k === "slot" && slotWarns(st.slotWal))))];
  rows.splice(2, 0, factRow("Lag", lagText(st.lag)));
  return `<table class="facts-table"><caption>Changes (the stream${s.source.replication ? `, slot ${esc(s.source.replication.slot)}` : ""})</caption><tbody>${rows.join("")}</tbody></table>`;
}

/**
 * THE FACTS, ONE table of what `mason status` says beside the cards: the database and how its changes arrive (`sourceRows`), the
 * warnings, Mason's version, how long it has been up and its restarts (`engine`), the free disk and what a running copy is projected to add (`disk`), the sessions open
 * (`sessions`). A fact the run did not say is absent; one it could not read is said as the CLI says it (its reason, never a 0). Mason's, the disk's, the restarts' and the sessions' rows are the CLI's (`masonRow`, `diskRows`, `restartsRows`, `sessionsRows`).
 */
export function renderFacts(s, now = Date.now()) {
  const rows = [...sourceRows(s).map(([k, v]) => factRow(k, v)), ...s.warnings.map((w) => factRow("Warning", w, true))];
  const e = s.engine;
  if (typeof e.version === "string") rows.push(factRow(...masonRow(e)));
  rows.push(...restartsRows(e.restarts, now).map(([k, v]) => factRow(k, v, k === "Restarts")));
  // the copies in all, their rows, the last sync and the copy's file are the cards' (`renderKpis`): a fact in ONE place
  const d = s.disk;
  rows.push(...diskRows(d).map(([k, v]) => factRow(k, v, d.freeBytes === null || (d.projectedBytes !== null && d.projectedBytes > d.freeBytes))));
  rows.push(...sessionsRows(s.sessions).map(([k, v]) => factRow(k, v)));
  return `<table class="facts-table"><caption>Mason</caption><tbody>${rows.join("")}</tbody></table>`;
}

/**
 * THE COPIES NOT FINISHED, a bar each as `mason status` and `mason wait` print them (`tableLine`): copying, waiting,
 * failed, or copied but not kept current — and nothing once every copy is done. With no table added, the commands'
 * sentence and what adds one.
 */
function renderProgress(s, isOpen = () => false, shares = new Map(), before = new Map()) {
  const picked = s.tables.filter((t) => t.added);
  if (!picked.length) {
    return `<p class="readiness">No table added yet (${n(s.tables.length)} in the database).</p>` +
      `<p class="dim">${code("mason tables")} lists them; ${code("mason add <table>")} copies one.</p>`;
  }
  // as tableLines orders them: the finished first, in the order they finished, then the failed, the copying, the waiting
  const rank = { done: 0, unsynced: 0, failed: 1, copying: 2, waiting: 3 };
  const lines = picked.map((t) => ({ t, l: tableLine(t) })).filter(({ l }) => l.state !== "done")
    .sort((a, b) => rank[a.l.state] - rank[b.l.state] || (a.t.copy?.updatedAt ?? "").localeCompare(b.t.copy?.updatedAt ?? "") || a.t.table.localeCompare(b.t.table));
  if (!lines.length) return "";
  return `<h3>Copies not finished (${lines.length} of ${picked.length} added)</h3>` +
    `<table class="tables"><thead><tr><th scope="col">Table</th><th scope="col">Copy</th><th scope="col"></th></tr></thead><tbody>${lines.map(({ t, l }) =>
      `<tr class="t-${l.state}"><th scope="row"><code class="name" title="${esc(t.table)}">${esc(t.table)}</code></th>` +
      `<td class="bar">${copyBar(t.table, l, shares.get(t.table) ?? l.fraction, before.get(t.table))}</td>` +
      `<td class="what">${esc(l.what)}${t.error && t.error.includes("\n") ? details(`error:${t.table}`, "the whole error", `<pre>${esc(t.error)}</pre>`, isOpen(`error:${t.table}`)) : ""}</td></tr>`).join("")}</tbody></table>`;
}

/**
 * THE STATEMENTS of the last day and week (`/api/queries`, mason status's `Queries`, src/cli/commands.ts `queryLines`):
 * how many, each outcome, the completed ones' average / p50 / p95 in ms, the rows and bytes sent; when the request log
 * keeps fewer days than the week, that it is only what it keeps. `q` is the body, or `{ failure }`.
 */
export function renderQueries(q) {
  if (q === undefined) return "";
  if ("failure" in q) return `<p class="count">Queries: could not read them (${esc(firstLine(q.failure.message))}; ${code("mason logs")} has the detail)</p>`;
  const w = q.queries;
  const ms = msText;
  const row = (label, x) => `<tr><th scope="row">${esc(label)}</th>${[n(x.statements), n(x.completed), n(x.refused), n(x.failed), n(x.cancelled),
    x.durationMs === null ? "" : ms(x.durationMs.avg), x.durationMs === null ? "" : ms(x.durationMs.p50), x.durationMs === null ? "" : ms(x.durationMs.p95),
    n(x.rows), bytesText(x.bytesSent)].map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`;
  const short = [w.day, w.week].find((x) => x.covered < x.days);
  // eleven columns of numbers: wider than a laptop's page beside the sidebar, so the table scrolls inside its own box, never the page
  return `<div class="table-wrap"><table class="queries"><caption>Statements (the completed ones' time; ${code("mason logs --requests")} lists each)</caption><thead><tr><th scope="col"></th>` +
    ["Statements", "Completed", "Refused", "Failed", "Cancelled", "Average", "p50", "p95", "Rows sent", "Sent"].map((h) => `<th scope="col">${h}</th>`).join("") +
    `</tr></thead><tbody>${row("Last day", w.day)}${row("Last week", w.week)}</tbody></table></div>` +
    (short ? `<p class="dim">The request log keeps ${short.covered} day${short.covered === 1 ? "" : "s"}: MASON_HISTORY_DAYS.</p>` : "") +
    `<p class="dim">The slow and the refused statements, and every other, are on <a href="${esc(LINKS.queries)}">Observability › Queries</a> (${code("mason logs --requests")}).</p>`;
}

/** A failed statement's cells, as mason status's `Query errors` line says them (src/cli/commands.ts `requestLine`): when,
 *  the outcome and SQLSTATE, how long, the rows sent, who, the statement on one line and the error's first line. */
export function requestCells(r) {
  return [utcText(r.startedAt), r.outcome === "ok" ? "ok" : `${r.outcome} ${r.sqlstate ?? ""}`.trim(), msText(r.durationMs),
    r.rows === null ? "" : `${n(r.rows)} row${r.rows === 1 ? "" : "s"}`,
    `${clientText(r.applicationName)}${r.tokenName ? ` (token ${r.tokenName})` : ""}${r.user ? ` (user ${r.user})` : ""}`,
    oneLine(r.query, 120) || "(no statement)", r.message ? firstLine(r.message) : ""];
}

/** A row of cells; `outcomeAt` is the column that says `refused 42P01`: the word is shown, the SQLSTATE is its title (`--json` and the CLI's line keep it). */
const cellsRow = (cells, outcomeAt = -1) => `<tr><th scope="row">${esc(cells[0])}</th>${cells.slice(1).map((c, i) => {
  const m = i + 1 === outcomeAt ? /^(\S+) (\S+)$/.exec(c) : null;
  return m ? `<td title="SQLSTATE ${esc(m[2])}">${esc(m[1])}</td>` : `<td>${esc(c)}</td>`;
}).join("")}</tr>`;

/**
 * THE UNSUPPORTED SQL OF THE LAST DAY in one line, as mason status heads it (`/api/unsupported`'s body, its default day):
 * the most refused entry's line (`unsupportedEntry`), how many others there are, and See all (Observability › Queries
 * lists each). Nothing when none was refused; one that could not be read says why, as mason status does.
 */
export function renderUnsupportedLine(u) {
  if (u === undefined) return "";
  if ("failure" in u) return `<p class="count">Unsupported SQL: could not read it (${esc(firstLine(u.failure.message))}; ${code("mason logs")} has the detail)</p>`;
  const [top, ...rest] = u.unsupported;
  if (top === undefined) return "";
  return `<p class="unsupported-line"><strong>Unsupported SQL, the last day:</strong> <span title="docs/SQL-SUPPORT.md entry ${esc(top.gap)}">${esc(unsupportedEntry(top).headline)}</span>` +
    `${rest.length ? ` (and ${n(rest.length)} other${rest.length === 1 ? "" : "s"})` : ""} <a class="see" href="${esc(LINKS.queries)}">See all</a></p>`;
}

/**
 * THE RECENT ERRORS, as mason status lists them (`recentErrors`): the sync's latest failures (`/api/events?failed=1`)
 * and the latest statements refused, failed or cancelled (`/api/requests?failed=1`), newest last; a kind with none
 * says so, one that could not be read says why; then the last day's unsupported SQL in a line, when there is any
 * (`renderUnsupportedLine`). Each argument is the body, or `{ failure }`.
 */
export function renderRecentErrors(events, requests, unsupported) {
  const part = (title, r, list, head, cells, more, href, outcomeAt) => r === undefined ? ""
    : "failure" in r ? `<h3>${title}</h3><p class="count">Could not read them (${esc(firstLine(r.failure.message))}; ${code("mason logs")} has the detail)</p>`
    : !list(r).length ? `<h3>${title}</h3><p class="dim">None.</p>`
    : `<table class="errors"><caption>${title} (the latest, newest last; ${code(more)} lists each) <a class="see" href="${esc(href)}">See all</a></caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${list(r).map((x) => cellsRow(cells(x), outcomeAt)).join("")}</tbody></table>`;
  return part("Sync errors", events, (r) => r.events, ["At (UTC)", "What", "Table", "Why"], (e) => Object.values(eventCells(e)), "mason logs --events", LINKS.failedEvents) +
    part("Query errors", requests, (r) => r.requests, ["Started (UTC)", "Outcome", "Took", "Rows", "Who", "Statement", "Error"], requestCells, "mason logs --requests --failed", LINKS.failedQueries, 1) +
    renderUnsupportedLine(unsupported);
}

/**
 * THE FIRST-RUN CHECKLIST, while setting up is not done: Mason is running (the state answered), a table copied (`totals`:
 * one served), a user created (`/api/users`: one not removed), a first statement answered (`/api/queries`: one completed
 * in the week the log keeps) — each ✓ or ○, a ○ with its one action: Add a table (Tables), Create a user (Users), the
 * psql line's Copy (Connect's, under it). "" once all four are done, and while a read it needs has not answered or
 * could not be read: a checklist never says ○ for what it could not tell. `users` is `/api/users`' body (or `{ failure }`).
 */
export function renderChecklist(s, queries, users) {
  if (queries === undefined || users === undefined || "failure" in queries || "failure" in users) return "";
  const added = s.tables.some((t) => t.added);
  const copied = (s.totals?.copied ?? 0) > 0;
  const user = users.users.some((u) => u.removedAt == null);
  const answered = queries.queries.week.completed > 0;
  if (copied && user && answered) return "";
  const copying = added && !copied && copyingCount(s) > 0;
  const steps = [
    ["Mason is running", true, ""],
    ["A table copied", copied, copying ? `<span class="dim">copying now</span>` : added ? "" : `<a class="btn small primary" href="${LINKS.tables}">Add a table</a>`],
    ["A user created", user, `<a class="btn small${copied ? " primary" : ""}" href="#users">Create a user</a>`],
    // the psql line is Connect's (rendered under the checklist once a table is added): its Copy copies it
    ["A first statement answered", answered, copied ? `${`<button type="button" class="small${user ? " primary" : ""}" data-copy="connect-psql">Copy the psql line</button>`} <span class="dim">then run a select on a copied table</span>` : ""],
  ];
  const done = steps.filter(([, ok]) => ok).length;
  return `<div class="checklist" role="group" aria-label="Getting started"><p class="checklist-title"><span class="courses" aria-hidden="true">${steps.map(([, ok]) => `<i${ok ? ' class="on"' : ""}></i>`).join("")}</span>Getting started <span class="dim">${done} of ${steps.length} done</span></p><ol>` +
    steps.map(([what, ok, action]) => `<li class="${ok ? "step-done" : "step-todo"}"><span class="mark" aria-hidden="true">${ok ? "✓" : "○"}</span><span class="what">${esc(what)}<span class="sr">${ok ? " (done)" : " (to do)"}</span></span>${ok ? "" : action}</li>`).join("") +
    `</ol></div>`;
}

/**
 * THE OVERVIEW from `/api/state` and the request log's reads (`o.queries`, `o.events`, `o.requests`, `o.unsupported`, `o.usage`:
 * each the body, or `{ failure }`; `o.now` the clock; `o.open(key)` whether a details is open): the word, the cards,
 * the copies not finished, the facts, the stream, the statements, the recent errors. Never the engine's name.
 */
export function renderStatus(s, o = {}) {
  const now = o.now ?? Date.now();
  const added = s.tables.some((t) => t.added);
  // how to connect, once a table is added: first under the cards while nothing has asked Mason anything (the last
  // day's and week's statements, read as none), else after the facts, for the next tool
  const first = isFirstConnect(o.queries);
  const connect = added ? renderConnect(s.postgres, { first, table: s.tables.find((t) => t.added && t.copy?.phase === "done")?.table ?? null }) : "";
  return renderHealth(s) + renderChecklist(s, o.queries, o.users) + renderKpis(s, { ...o, now }) + (first ? connect : "") + renderProgress(s, o.open, o.shares, o.before) + renderFacts(s, now) + (first ? "" : connect) + renderStream(s, now) +
    (added ? renderQueries(o.queries) : "") + (added ? renderRecentErrors(o.events, o.requests, o.unsupported) : "");
}

/** Nothing has asked Mason anything yet: the last day's statements were read (`/api/queries`' body), and are none. */
export const isFirstConnect = (q) => q !== undefined && !("failure" in q) && q.queries.day.statements === 0 && q.queries.week.statements === 0;

/** The most entries of the unsupported SQL `/api/unsupported` answers (src/cli/run-server.ts MAX_UNSUPPORTED_LIMIT, held
 *  equal by the tests): the Overview says the first and counts the others, so it reads them all. */
export const UNSUPPORTED_LIMIT = 100;

/** What the page reads every 30 s beside the state: the request log's summary, the recent errors, and the last day's
 *  unsupported SQL. */
const SLOWER = ["/api/queries", `/api/events?failed=1&limit=${RECENT_ERRORS}`, `/api/requests?failed=1&limit=${RECENT_ERRORS}`, `/api/unsupported?limit=${UNSUPPORTED_LIMIT}`, "/api/users"];

/** A read as `renderStatus` takes it: the body, or `{ failure }` when it could not be read; undefined before any read. */
const asRequest = (r) => r === undefined ? undefined : r.failure ? { failure: r.failure } : r.body;

export const page = {
  id: "status",
  hash: "overview",
  title: "Overview",
  create(ctx) {
    // the details open (a copy's whole error), by key: a poll rewrites the section, and they stay open
    const opened = createOpenSet();
    const monotone = createMonotone();
    return {
      model: { open: opened.open },
      reads: () => [{ path: "/api/state", everyMs: POLL_MS }, ...SLOWER.map((path) => ({ path, everyMs: 30_000 })), { path: HOURLY, everyMs: 60_000 }],
      actions: {},
      view() {
        const st = ctx.read("/api/state");
        if (!st?.body) return { status: st?.failure ? "" : skeleton(4) };
        const [queries, events, requests, unsupported, users] = SLOWER.map((p) => asRequest(ctx.read(p)));
        return { status: renderStatus(st.body, { now: ctx.now().getTime(), queries, events, requests, unsupported, users, usage: ctx.read(HOURLY)?.body, open: opened.has, shares: monotone.of(st.body), before: monotone.before }) };
      },
      toggle: (target) => opened.toggle(target),
      // Connect's Copy buttons
      click: (d, button, env) => copyClick(d, button, env),
      charts: () => sparkSpecs(ctx.read(HOURLY)?.body),
    };
  },
};
