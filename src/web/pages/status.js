/**
 * THE OVERVIEW (#overview; `#status`, its old address, lands here; the module and its section keep the id `status`): what `mason status` prints — the run in one word (`readiness`), ONE table of facts (the
 * database and how its changes arrive, Mason's version, uptime and restarts, the copies in all, the copy's file, the
 * disk, the sessions open, the warnings), the changes the stream carries (replication mode: its position, lag, last
 * batch and the slot's hold on the database's WAL), the statements of the last day and week, the copies not finished (a
 * bar each, only while there are any), and the recent errors (the sync's and the statements'). The slow and the refused
 * statements are the Queries page's. Reads `/api/state` every poll, the request log's every 30 s, the last 24 hours of
 * usage (the cards' sparklines) every 60 s. Never the engine's name.
 *
 * Laid out as a dashboard (docs/WEB-UI.md "Presentation"): the word with a big dot, then KPI cards (the copies in all,
 * their rows, the last sync, the copy's file, the last day's statements and their p95 — each its own fact, said once,
 * with a sparkline of the last 24 hours where one helps), the copies not finished, the ONE table of the other facts,
 * the stream, the statements, the recent errors. Each card links into the view that lists what it counts (the tables,
 * filtered to the failed ones when a copy failed; Observability's Queries — the slow ones for the p95 — and Usage).
 */

/** Where each card leads: the views that list what it counts (src/web/app.js hashes). */
const LINKS = { tables: "#tables", failedTables: "#tables?show=failed", usage: "#observability/usage", queries: "#observability/queries",
  slow: "#observability/queries?slow=1", failedQueries: "#observability/queries?status=failed", failedEvents: "#observability/logs?failures=1" };
import { bytesText, code, esc, fileSize, firstLine, n, percent, leftText, spanText, duration, entryName, streamRows, slotWarns, masonRow, sessionsRows, diskRows, restartsRows, utcText,
  utcMinute, oneLine, clientText, eventCells, usagePath, POLL_MS, card, cards, details, createOpenSet, skeleton } from "../shared.js";
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
 * its state (done, unsynced, failed, copying, waiting), how full its bar is, and what it says.
 */
export function tableLine(t) {
  if (t.error) return { state: "failed", fraction: 1, what: `its copy failed: ${firstLine(t.error)}` };
  if (t.copy?.phase === "copying") {
    const c = copyingText(t.copy.rowsCopied, t.rows, t.copy.progress);
    return { state: "copying", fraction: c.fraction ?? 0, what: /^\d/.test(c.text) ? `copying ${c.text}` : c.text };
  }
  if (!t.copy) return { state: "waiting", fraction: 0, what: "waiting for its copy to start" };
  if (t.unsynced) {
    return { state: "unsynced", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied, NOT kept current (${t.unsynced.reason}${t.unsynced.asOf ? `; as of ${utcMinute(t.unsynced.asOf)} UTC` : ""}) — mason sync ${entryName(t.table)}, or mason start --replication` };
  }
  return { state: "done", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied${t.copy.retired ? ` · ${t.copy.retired}` : ""}` };
}

/** `mason status`'s rows for the database (src/cli/commands.ts `sourceRows`): its sources file, its URL as the run masked it, how its changes arrive. */
export function sourceRows(s) {
  return [
    ...(s.source.file ? [["Source", `${s.source.file} (the tables it names are added)`]] : []),
    ["Database", s.source.demo ? `the demo database Mason hosts (${s.source.url} · Postgres ${s.source.version})`
      : `${s.source.url} · Postgres ${s.source.version}${s.source.standby ? " · a read replica" : ""}`],
    ["Changes", s.source.replication ? `logical replication: slot ${s.source.replication.slot}, publication ${s.source.replication.publication} ` +
        `(${s.source.replication.owned ? "Mason's own" : "named: read as it is, never altered"}) · mason start --poll goes back to polling`
      : `polling with SELECTs (xmin), every ${s.engine.pollSeconds} s · ${s.source.demo ? "the demo database is read by polling only" : "mason start --replication reads the database's change log instead"}`],
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
    card("Tables synced", `${n(t.copied)} of ${n(t.added)}`, `added${t.failed ? `, ${n(t.failed)} failed` : ""}`, "", t.failed ? "bad" : "", t.failed ? LINKS.failedTables : LINKS.tables),
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
        card("p95, last day", day.durationMs === null ? "–" : `${n(day.durationMs.p95)} ms`,
          day.durationMs === null ? "no statement completed" : `average ${n(day.durationMs.avg)} ms · p50 ${n(day.durationMs.p50)} ms`, line("p95"), "", LINKS.slow));
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
function renderProgress(s, isOpen = () => false) {
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
      `<tr class="t-${l.state}"><th scope="row">${code(t.table)}</th>` +
      `<td class="bar"><progress max="100" value="${Math.floor(Math.max(0, Math.min(1, l.fraction)) * 100)}"></progress> <span class="pct">${percent(l.fraction)}</span></td>` +
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
  const ms = (x) => `${n(x)} ms`;
  const row = (label, x) => `<tr><th scope="row">${esc(label)}</th>${[n(x.statements), n(x.completed), n(x.refused), n(x.failed), n(x.cancelled),
    x.durationMs === null ? "" : ms(x.durationMs.avg), x.durationMs === null ? "" : ms(x.durationMs.p50), x.durationMs === null ? "" : ms(x.durationMs.p95),
    n(x.rows), bytesText(x.bytesSent)].map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`;
  const short = [w.day, w.week].find((x) => x.covered < x.days);
  return `<table class="queries"><caption>Statements (the completed ones' time; ${code("mason logs --requests")} lists each)</caption><thead><tr><th scope="col"></th>` +
    ["Statements", "Completed", "Refused", "Failed", "Cancelled", "Average", "p50", "p95", "Rows sent", "Sent"].map((h) => `<th scope="col">${h}</th>`).join("") +
    `</tr></thead><tbody>${row("Last day", w.day)}${row("Last week", w.week)}</tbody></table>` +
    (short ? `<p class="dim">The request log keeps ${short.covered} day${short.covered === 1 ? "" : "s"}: MASON_REQUEST_LOG_DAYS.</p>` : "") +
    `<p class="dim">The slow and the refused statements, and every other, are on <a href="${LINKS.queries}">Observability › Queries</a> (${code("mason logs --requests")}).</p>`;
}

/** A failed statement's cells, as mason status's `Query errors` line says them (src/cli/commands.ts `requestLine`): when,
 *  the outcome and SQLSTATE, how long, the rows sent, who, the statement on one line and the error's first line. */
export function requestCells(r) {
  return [utcText(r.startedAt), r.outcome === "ok" ? "ok" : `${r.outcome} ${r.sqlstate ?? ""}`.trim(), `${n(r.durationMs)} ms`,
    r.rows === null ? "" : `${n(r.rows)} row${r.rows === 1 ? "" : "s"}`,
    `${clientText(r.applicationName)}${r.tokenName ? ` (token ${r.tokenName})` : ""}${r.user ? ` (user ${r.user})` : ""}`,
    oneLine(r.query, 120) || "(no statement)", r.message ? firstLine(r.message) : ""];
}

const cellsRow = (cells) => `<tr><th scope="row">${esc(cells[0])}</th>${cells.slice(1).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;

/**
 * THE RECENT ERRORS, as mason status lists them (`recentErrors`): the sync's latest failures (`/api/events?failed=1`)
 * and the latest statements refused, failed or cancelled (`/api/requests?failed=1`), newest last; a kind with none
 * says so, one that could not be read says why. Each argument is the body, or `{ failure }`.
 */
export function renderRecentErrors(events, requests) {
  const part = (title, r, list, head, cells, more, href) => r === undefined ? ""
    : "failure" in r ? `<h3>${title}</h3><p class="count">Could not read them (${esc(firstLine(r.failure.message))}; ${code("mason logs")} has the detail)</p>`
    : !list(r).length ? `<h3>${title}</h3><p class="dim">None.</p>`
    : `<table class="errors"><caption>${title} (the latest, newest last; ${code(more)} lists each) <a class="see" href="${href}">See all</a></caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${list(r).map((x) => cellsRow(cells(x))).join("")}</tbody></table>`;
  return part("Sync errors", events, (r) => r.events, ["At (UTC)", "What", "Table", "Why"], (e) => Object.values(eventCells(e)), "mason logs --events", LINKS.failedEvents) +
    part("Query errors", requests, (r) => r.requests, ["Started (UTC)", "Outcome", "Took", "Rows", "Who", "Statement", "Error"], requestCells, "mason logs --requests --failed", LINKS.failedQueries);
}

/**
 * THE OVERVIEW from `/api/state` and the request log's reads (`o.queries`, `o.events`, `o.requests`, `o.usage`:
 * each the body, or `{ failure }`; `o.now` the clock; `o.open(key)` whether a details is open): the word, the cards,
 * the copies not finished, the facts, the stream, the statements, the recent errors. Never the engine's name.
 */
export function renderStatus(s, o = {}) {
  const now = o.now ?? Date.now();
  const added = s.tables.some((t) => t.added);
  return renderHealth(s) + renderKpis(s, { ...o, now }) + renderProgress(s, o.open) + renderFacts(s, now) + renderStream(s, now) +
    (added ? renderQueries(o.queries) : "") + (added ? renderRecentErrors(o.events, o.requests) : "");
}

/** What the page reads every 30 s beside the state: the request log's summary and the recent errors. */
const SLOWER = ["/api/queries", `/api/events?failed=1&limit=${RECENT_ERRORS}`, `/api/requests?failed=1&limit=${RECENT_ERRORS}`];

/** A read as `renderStatus` takes it: the body, or `{ failure }` when it could not be read; undefined before any read. */
const asRequest = (r) => r === undefined ? undefined : r.failure ? { failure: r.failure } : r.body;

export const page = {
  id: "status",
  hash: "overview",
  title: "Overview",
  create(ctx) {
    // the details open (a copy's whole error), by key: a poll rewrites the section, and they stay open
    const opened = createOpenSet();
    return {
      model: { open: opened.open },
      reads: () => [{ path: "/api/state", everyMs: POLL_MS }, ...SLOWER.map((path) => ({ path, everyMs: 30_000 })), { path: HOURLY, everyMs: 60_000 }],
      actions: {},
      view() {
        const st = ctx.read("/api/state");
        if (!st?.body) return { status: st?.failure ? "" : skeleton(4) };
        const [queries, events, requests] = SLOWER.map((p) => asRequest(ctx.read(p)));
        return { status: renderStatus(st.body, { now: ctx.now().getTime(), queries, events, requests, usage: ctx.read(HOURLY)?.body, open: opened.has }) };
      },
      toggle: (target) => opened.toggle(target),
      charts: () => sparkSpecs(ctx.read(HOURLY)?.body),
    };
  },
};
