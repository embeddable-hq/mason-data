/**
 * THE USAGE PAGE (#usage; docs/OBSERVABILITY.md "Pages"): what `mason status` says of the queries and what `mason usage`
 * prints, as plain tables — the last day's and week's statements side by side, the last 24 hours an hour a line, and
 * each copy's own size. Reads `/api/queries`, `/api/usage` and its copy sizes every 60 s (a sample is taken a minute).
 * A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, n, bytesText, fileSize, duration, renderFailure, details, createOpenSet } from "../shared.js";

const EVERY_MS = 60_000;
/** The hours, an hour a line: `step` is seconds (src/cli/run-server.ts `usage`). */
export const HOURLY = "/api/usage?since=24h&step=3600";
const QUERIES = "/api/queries";
/** How often a copy's own size is measured, in seconds (src/duck/usage.ts SIZE_EVERY_MS, held equal by the tests). */
export const SIZE_EVERY_SECONDS = 600;

const th = (cols) => `<thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>`;
const num = (v) => `<td class="num">${esc(v)}</td>`;

/** The duration cell as `mason status` says it: `average / p50 / p95 ms`; empty when no statement completed (src/cli/commands.ts `queryLines`). */
export const durationsText = (d) => d === null ? "–" : `${n(d.avg)} / ${n(d.p50)} / ${n(d.p95)} ms`;
/** The caveat of a window the request log keeps fewer days of than it asks (src/cli/commands.ts `queryLines`); "" when it keeps all. */
export const coveredText = (w) => w.covered < w.days ? `the request log keeps ${w.covered} day${w.covered === 1 ? "" : "s"}: MASON_REQUEST_LOG_DAYS` : "";

/** The statements of the last day and week: a table with the windows as columns, in `mason status`'s words and order. */
export function renderQueries(q) {
  const windows = [["Last day", q.day], ["Last week", q.week]];
  const rows = [
    ["Statements", (w) => n(w.statements)], ["Completed", (w) => n(w.completed)], ["Refused", (w) => n(w.refused)],
    ["Failed", (w) => n(w.failed)], ["Cancelled", (w) => n(w.cancelled)], ["Rows", (w) => n(w.rows)], ["Bytes sent", (w) => bytesText(w.bytesSent)],
    ["Duration, average / p50 / p95 (the completed ones')", (w) => durationsText(w.durationMs)],
  ];
  const caveats = windows.map(([label, w]) => [label, coveredText(w)]).filter(([, c]) => c !== "");
  return `<table class="queries">${th(["", ...windows.map(([l]) => l)])}<tbody>` +
    rows.map(([label, f]) => `<tr><th scope="row">${esc(label)}</th>${windows.map(([, w]) => num(f(w))).join("")}</tr>`).join("") + "</tbody></table>" +
    caveats.map(([label, c]) => `<p class="warn">${esc(label)}: ${esc(c)}</p>`).join("") +
    `<p class="dim">Each statement is listed on the Queries page, or by <code>mason logs --requests</code>.</p>`;
}

/** One sample's cells in `mason usage`'s words (src/cli/usage.ts `sampleLine`): the strings the table writes, held equal by the tests. */
export function sampleCells(s) {
  const bad = s.statementsRefused + s.statementsFailed + s.statementsCancelled;
  return {
    time: s.at.slice(0, 16).replace("T", " "), statements: n(s.statements), errors: bad === 0 ? "" : n(bad),
    rowsSent: n(s.rowsSent), bytesSent: bytesText(s.bytesSent), p95: s.durationP95Ms === null ? "–" : `${n(s.durationP95Ms)} ms`,
    copy: s.copyBytes === null ? "–" : fileSize(s.copyBytes), rows: n(s.copyRows), failing: s.tablesFailed === 0 ? "" : n(s.tablesFailed),
    oldest: s.oldestSyncSeconds === null ? "–" : duration(s.oldestSyncSeconds), lag: s.streamLagSeconds === null ? "–" : duration(s.streamLagSeconds),
    memory: `${fileSize(s.rssBytes)}${s.copyMemoryBytes === null ? "" : ` (copy ${fileSize(s.copyMemoryBytes)} of ${fileSize(s.copyMemoryLimitBytes)})`}`,
  };
}

/** The usage answer as `mason usage` prints it: its heading, then the samples a line each (or that there are none yet), then each copy's size. */
export function renderUsage(b, isOpen = () => false) {
  const at = (iso) => iso.slice(0, 16).replace("T", " ");
  const span = b.stepSeconds === null ? "every sample" : `${duration(b.stepSeconds)} a line`;
  const head = `<p class="dim">From ${esc(at(b.since))} to ${esc(at(b.until))} UTC, ${esc(span)} (a sample every ${esc(duration(b.sampleSeconds))}, kept ${b.keptDays} day${b.keptDays === 1 ? "" : "s"}).</p>`;
  let samples;
  if (!b.samples.length) samples = `<p>No sample in this time: Mason takes the first a minute after it starts.</p>`;
  else {
    const withLag = b.samples.some((s) => s.streamLagBytes !== null || s.streamLagSeconds !== null);
    const cols = ["Time (UTC)", "Statements", "Errors", "Rows sent", "Bytes sent", "p95", "Copy", "Rows", "Failing", "Oldest", ...(withLag ? ["Lag"] : [])];
    samples = `<table class="samples">${th(cols)}<tbody>` + b.samples.map((s) => {
      const c = sampleCells(s);
      return `<tr><th scope="row">${esc(c.time)}</th>${[c.statements, c.errors, c.rowsSent, c.bytesSent, c.p95, c.copy, c.rows, c.failing, c.oldest, ...(withLag ? [c.lag] : [])].map(num).join("")}</tr>`;
    }).join("") + "</tbody></table>" +
      // the process's memory, an hour a line: a debugging aid, behind a closed details
      // (keyed: a poll rewrites the hours, and an open Memory stays open)
      details("usage-memory", "Memory", `<table class="samples">${th(["Time (UTC)", "Memory"])}<tbody>` +
        b.samples.map((s) => { const c = sampleCells(s); return `<tr><th scope="row">${esc(c.time)}</th><td>${esc(c.memory)}</td></tr>`; }).join("") + "</tbody></table>", isOpen("usage-memory"), "memory");
  }
  return head + samples;
}

/** Each copy's own size, measured every 10 min (src/cli/usage.ts): table, bytes, when. */
export function renderCopySizes(sizes) {
  if (!sizes.length) return `<p>No copy measured yet: each is measured every ${esc(duration(SIZE_EVERY_SECONDS))}.</p>`;
  return `<p class="dim">Measured every ${esc(duration(SIZE_EVERY_SECONDS))}.</p><table class="sizes">${th(["Table", "Size", "Measured at (UTC)"])}<tbody>` +
    sizes.map((c) => `<tr><th scope="row"><code>${esc(c.table)}</code></th>${num(fileSize(c.bytes))}<td>${esc(c.at.slice(11, 16))}</td></tr>`).join("") + "</tbody></table>";
}

export const page = {
  id: "usage",
  title: "Usage",
  create(ctx) {
    const opened = createOpenSet();
    /** What a read gave: its body, or its Failure where it shows (said once, and not the first read's: that is the banner), or that it is being asked. */
    const part = (path, render, says) => {
      const r = ctx.read(path);
      if (r === undefined) return `<p class="dim">Asking Mason…</p>`;
      const failure = r.failure && says ? renderFailure(r.failure) : "";
      return failure + (r.body === undefined ? "" : render(r.body));
    };
    return {
      model: { open: opened.open },
      reads: () => [{ path: QUERIES, everyMs: EVERY_MS }, { path: HOURLY, everyMs: EVERY_MS }],
      actions: {},
      toggle: (target) => opened.toggle(target),
      view: () => ({
        "usage-queries": part(QUERIES, (b) => renderQueries(b.queries), false),
        "usage-hourly": part(HOURLY, (b) => renderUsage(b, opened.has), true),
        "usage-sizes": part(HOURLY, (b) => renderCopySizes(b.copySizes), false),
      }),
    };
  },
};
