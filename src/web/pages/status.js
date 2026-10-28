/**
 * THE STATUS PAGE (#status): what `mason status` prints — the run in one word (`readiness`), the facts (the copies in
 * all, the copy file's size, the last day's and week's statements), the database, each added table's copy (its bar,
 * its percent and the line `mason wait` shows), the warnings, the slow and refused counts, readiness, and the recent
 * errors (the sync's and the statements'). Reads `/api/state` every poll, the request log's every 30 s. Never the
 * engine's name.
 */
import { bytesText, code, esc, fileSize, firstLine, n, percent, leftText, duration, entryName, rowsHtml, utcText } from "../shared.js";

/** How many recent errors of each kind are shown: mason status's (src/cli/commands.ts `RECENT_ERRORS`). */
export const RECENT_ERRORS = 5;

const POLL_MS = 2000;

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
    return { state: "unsynced", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied, NOT kept current (${t.unsynced.reason}${t.unsynced.asOf ? `; as of ${t.unsynced.asOf.slice(0, 16).replace("T", " ")} UTC` : ""}) — mason sync ${entryName(t.table)}, or mason start --replication` };
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

/** How many of `xs` were in the last day, or why they could not be read. */
const countLine = (label, r, count, tail) => "failure" in r
  ? `<p class="count">${esc(label)}: could not read them (${esc(firstLine(r.failure.message))}; ${code("mason logs")} has the detail)</p>`
  : `<p class="count">${esc(label)}: <strong>${n(count(r))}</strong> in the last day${tail(r)}</p>`;

/**
 * THE STATUS SECTION from `/api/state` (and the counts of `/api/slow`, `/api/refused`; each `{ failure }` when it could
 * not be read): what `mason status` prints — the database, each added table's copy (its bar, percent and the line
 * `mason wait` shows), the warnings, the slow and refused counts, and readiness. Never the engine's name.
 */
export function renderStatus(s, requests = {}) {
  const parts = [rowsHtml([...sourceRows(s), ...s.warnings.map((w) => ["Warning", w])])];
  const picked = s.tables.filter((t) => t.added);
  if (!picked.length) {
    parts.push(`<p class="readiness">No table added yet (${n(s.tables.length)} in the database).</p>`,
      `<p class="dim">${code("mason tables")} lists them; ${code("mason add <table>")} copies one.</p>`);
    return parts.join("");
  }
  // as tableLines orders them: the finished first, in the order they finished, then the failed, the copying, the waiting
  const rank = { done: 0, unsynced: 0, failed: 1, copying: 2, waiting: 3 };
  const lines = picked.map((t) => ({ t, l: tableLine(t) }))
    .sort((a, b) => rank[a.l.state] - rank[b.l.state] || (a.t.copy?.updatedAt ?? "").localeCompare(b.t.copy?.updatedAt ?? "") || a.t.table.localeCompare(b.t.table));
  parts.push(`<h3>Tables (${picked.length} of ${s.tables.length} added)</h3>`,
    `<table class="tables"><thead><tr><th scope="col">Table</th><th scope="col">Copy</th><th scope="col"></th></tr></thead><tbody>${lines.map(({ t, l }) =>
      `<tr class="t-${l.state}"><th scope="row">${code(t.table)}</th>` +
      `<td class="bar"><progress max="100" value="${Math.floor(Math.max(0, Math.min(1, l.fraction)) * 100)}"></progress> <span class="pct">${percent(l.fraction)}</span></td>` +
      `<td class="what">${esc(l.what)}${t.error && t.error.includes("\n") ? `<details><summary>the whole error</summary><pre>${esc(t.error)}</pre></details>` : ""}</td></tr>`).join("")}</tbody></table>`);
  if (requests.slow) parts.push(countLine("Slow queries", requests.slow, (r) => r.slow.length, (r) => ` (${n(r.slowMs / 1000)} s or more)`));
  if (requests.refused) parts.push(countLine("Refused queries", requests.refused, (r) => r.total ?? r.refused.length, () => ""));
  if (requests.slow || requests.refused) parts.push(`<p class="dim">${code("mason status")} lists them; ${code("mason logs --requests")} every one.</p>`);
  const r = s.readiness;
  if (r) {
    if (r.ready) parts.push(`<p class="readiness ok">Ready: every added table is copied and served.</p>`);
    else if (r.failed.length) parts.push(`<p class="readiness bad">Failed:</p><ul class="bullets">${r.failed.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    else parts.push(`<p class="readiness">Under way:</p><ul class="bullets">${r.waiting.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  }
  return parts.join("");
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
  return `<p class="health ${word === "Ready" ? "ok" : word === "Failed" ? "bad" : ""}">${esc(word)}</p>`;
}

const factRow = (k, v) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;

/**
 * THE FACTS, a table of what `mason status` says of the copies (`totals`, `engine.bytes`): the tables synced of those
 * added, their rows, the last sync and how long ago (`totalsText`'s parts), and the copy file's size (`fileSize`).
 */
export function renderFacts(s, now = Date.now()) {
  const t = s.totals;
  const rows = t ? [
    factRow("Tables synced", `${n(t.copied)} of ${n(t.added)} added${t.failed ? `, ${n(t.failed)} failed` : ""}`),
    factRow("Rows", n(t.rows)),
    factRow("Last sync", t.syncedAt === null ? "none yet" : `${utcText(t.syncedAt)} UTC · ${duration((now - Date.parse(t.syncedAt)) / 1000)} ago`),
  ] : [];
  rows.push(factRow("The copy's file", s.engine.bytes === null ? "its size could not be read" : fileSize(s.engine.bytes)));
  return `<table class="facts-table"><caption>The copies</caption><tbody>${rows.join("")}</tbody></table>`;
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
    (short ? `<p class="dim">The request log keeps ${short.covered} day${short.covered === 1 ? "" : "s"}: MASON_REQUEST_LOG_DAYS.</p>` : "");
}

/** A sync event's cells, as mason status's `Sync errors` line says them (src/cli/commands.ts `eventLine`): when, what, its table, its reason's first line. */
export const eventCells = (e) => [utcText(e.at), e.kind, e.table ?? "(the sync)", firstLine(e.message)];

/** A failed statement's cells, as mason status's `Query errors` line says them (src/cli/commands.ts `requestLine`): when,
 *  the outcome and SQLSTATE, how long, the rows sent, who, the statement on one line and the error's first line. */
export function requestCells(r) {
  const line = r.query.replace(/\s+/g, " ").trim();
  return [utcText(r.startedAt), r.outcome === "ok" ? "ok" : `${r.outcome} ${r.sqlstate ?? ""}`.trim(), `${n(r.durationMs)} ms`,
    r.rows === null ? "" : `${n(r.rows)} row${r.rows === 1 ? "" : "s"}`,
    `${r.applicationName || "(no application_name)"}${r.tokenName ? ` (token ${r.tokenName})` : ""}${r.user ? ` (user ${r.user})` : ""}`,
    (line.length <= 120 ? line : `${line.slice(0, 119)}…`) || "(no statement)", r.message ? firstLine(r.message) : ""];
}

const cellsRow = (cells) => `<tr><th scope="row">${esc(cells[0])}</th>${cells.slice(1).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;

/**
 * THE RECENT ERRORS, as mason status lists them (`recentErrors`): the sync's latest failures (`/api/events?failed=1`)
 * and the latest statements refused, failed or cancelled (`/api/requests?failed=1`), newest last; a kind with none
 * says so, one that could not be read says why. Each argument is the body, or `{ failure }`.
 */
export function renderRecentErrors(events, requests) {
  const part = (title, r, list, head, cells, more) => r === undefined ? ""
    : "failure" in r ? `<h3>${title}</h3><p class="count">Could not read them (${esc(firstLine(r.failure.message))}; ${code("mason logs")} has the detail)</p>`
    : !list(r).length ? `<h3>${title}</h3><p class="dim">None.</p>`
    : `<table class="errors"><caption>${title} (the latest, newest last; ${code(more)} lists each)</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${list(r).map((x) => cellsRow(cells(x))).join("")}</tbody></table>`;
  return part("Sync errors", events, (r) => r.events, ["At (UTC)", "What", "Table", "Why"], eventCells, "mason logs --events") +
    part("Query errors", requests, (r) => r.requests, ["Started (UTC)", "Outcome", "Took", "Rows", "Who", "Statement", "Error"], requestCells, "mason logs --requests --failed");
}

/** What the page reads every 30 s beside the state: the request log's counts and summary, and the recent errors. */
const SLOWER = ["/api/slow", "/api/refused", "/api/queries", `/api/events?failed=1&limit=${RECENT_ERRORS}`, `/api/requests?failed=1&limit=${RECENT_ERRORS}`];

/** A read as `renderStatus` takes it: the body, or `{ failure }` when it could not be read; undefined before any read. */
const asRequest = (r) => r === undefined ? undefined : r.failure ? { failure: r.failure } : r.body;

export const page = {
  id: "status",
  title: "Status",
  create(ctx) {
    return {
      reads: () => [{ path: "/api/state", everyMs: POLL_MS }, ...SLOWER.map((path) => ({ path, everyMs: 30_000 }))],
      actions: {},
      view() {
        const st = ctx.read("/api/state");
        if (!st?.body) return { status: st?.failure ? "" : `<p class="dim">Asking Mason…</p>` };
        const s = st.body;
        const [slow, refused, queries, events, requests] = SLOWER.map((p) => asRequest(ctx.read(p)));
        const added = s.tables.some((t) => t.added);
        return { status: renderHealth(s) + (added ? renderFacts(s, ctx.now().getTime()) + renderQueries(queries) : "") +
          renderStatus(s, { slow, refused }) + (added ? renderRecentErrors(events, requests) : "") };
      },
    };
  },
};
