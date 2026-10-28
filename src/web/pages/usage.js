/**
 * THE USAGE PAGE (#usage; docs/OBSERVABILITY.md "Pages"): what `mason status` says of the queries and what `mason usage`
 * prints — KPI cards for the last 24 hours (statements, the failed ones, p95, rows and bytes sent, each with a sparkline),
 * four small charts of the hours (statements, p95, the copy's size and its rows), the last day's and week's statements side
 * by side, the hours a line (the charts' numbers, behind a details once there are charts), and each copy's own size.
 * Reads `/api/queries`, `/api/usage` and its copy sizes every 60 s (a sample is taken a minute). Every number a chart
 * draws is also text, in a card or the hours' table. A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, n, bytesText, fileSize, duration, renderFailure, details, createOpenSet, cards, card, empty, panel, skeleton } from "../shared.js";
import { spark, seriesChart, seriesOf, drawable } from "../charts.js";
import { statementCards } from "./queries.js";

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
  return panel(`<table class="queries">${th(["", ...windows.map(([l]) => l)])}<tbody>` +
    rows.map(([label, f]) => `<tr><th scope="row">${esc(label)}</th>${windows.map(([, w]) => num(f(w))).join("")}</tr>`).join("") + "</tbody></table>") +
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

/** A count short enough for an axis (`12.3M`): the hours' table has it whole. */
const compact = (v) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);

/** The charts, in order: [holder key, title, sample field, kind, how a value is said]. One series each, from a zero baseline. */
export const CHARTS = [
  ["usage-statements", "Statements an hour", "statements", "bars", n],
  ["usage-p95", "p95 duration", "durationP95Ms", "line", (v) => `${n(Math.round(v))} ms`],
  ["usage-copy-bytes", "Size of the copy", "copyBytes", "line", fileSize],
  ["usage-copy-rows", "Rows in the copy", "copyRows", "line", compact],
];
/** The sparklines of the cards, by card: [holder key, title, sample field]. The failed ones are the samples' refused and failed together. */
export const SPARKS = { statements: ["usage-spark-statements", "Statements", "statements"], failed: ["usage-spark-failed", "Failed statements", "failedCount"],
  p95: ["usage-spark-p95", "p95", "durationP95Ms"], rows: ["usage-spark-rows", "Rows sent", "rowsSent"], bytes: ["usage-spark-bytes", "Bytes sent", "bytesSent"] };

const samplesOf = (usage) => usage && Array.isArray(usage.samples) ? usage.samples.map((s) => ({ ...s, failedCount: s.statementsRefused + s.statementsFailed })) : [];

/** The specs of the charts and the sparklines from `/api/usage`'s body (anything else draws none), by holder key: what `charts()` returns. */
export function usageSpecs(usage) {
  const samples = samplesOf(usage);
  const specs = [
    ...CHARTS.map(([key, label, field, kind, format]) => [key, { kind, label, format, ...seriesOf(samples, field) }]),
    ...Object.values(SPARKS).map(([key, label, field]) => [key, { kind: "spark", label, ...seriesOf(samples, field) }]),
  ];
  return Object.fromEntries(specs.filter(([, spec]) => drawable(spec)));
}

/** The four charts' holders, each under its title, only for a series that can be drawn (the numbers are the hours' table). */
export function renderCharts(usage) {
  const specs = usageSpecs(usage);
  const blocks = CHARTS.filter(([key]) => specs[key]).map(([key, title]) =>
    `<div class="chart-card"><p class="card-label">${esc(title)}</p>${seriesChart(key, `${title}, the last 24 hours an hour a point`)}</div>`);
  return blocks.length ? `<div class="chart-grid">${blocks.join("")}</div>` : "";
}

/**
 * THE KPI CARDS of the last 24 hours (`queries`: `/api/queries`' body): the statements, the failed ones and the p95 as the
 * Queries page's cards say them (`statementCards`), the rows and the bytes sent; each with a sparkline of the hours where
 * `usage` (`/api/usage`'s body) has two to draw. Their numbers are the cards' text either way.
 */
export function renderUsageKpis(queries, usage) {
  const specs = usageSpecs(usage);
  const line = (k) => specs[SPARKS[k][0]] ? spark(SPARKS[k][0], `${SPARKS[k][1]}, the last 24 hours an hour a point`) : "";
  const day = queries.queries.day;
  return cards([...statementCards(day, line), card("Rows sent, last 24 hours", n(day.rows), "", line("rows")), card("Bytes sent, last 24 hours", bytesText(day.bytesSent), "", line("bytes"))]);
}

/**
 * The usage answer as `mason usage` prints it: its heading, then the samples a line each (or that there are none yet), then
 * each copy's size. With charts drawn the hours are their numbers, behind a closed details `usage-hours`; the process's
 * memory is behind another.
 */
export function renderUsage(b, isOpen = () => false) {
  const at = (iso) => iso.slice(0, 16).replace("T", " ");
  const span = b.stepSeconds === null ? "every sample" : `${duration(b.stepSeconds)} a line`;
  const head = `<p class="dim">From ${esc(at(b.since))} to ${esc(at(b.until))} UTC, ${esc(span)} (a sample every ${esc(duration(b.sampleSeconds))}, kept ${b.keptDays} day${b.keptDays === 1 ? "" : "s"}).</p>`;
  let samples;
  if (!b.samples.length) samples = empty("No sample in this time: Mason takes the first a minute after it starts.");
  else {
    const withLag = b.samples.some((s) => s.streamLagBytes !== null || s.streamLagSeconds !== null);
    const cols = ["Time (UTC)", "Statements", "Errors", "Rows sent", "Bytes sent", "p95", "Copy", "Rows", "Failing", "Oldest", ...(withLag ? ["Lag"] : [])];
    const hours = panel(`<table class="samples">${th(cols)}<tbody>` + b.samples.map((s) => {
      const c = sampleCells(s);
      return `<tr><th scope="row">${esc(c.time)}</th>${[c.statements, c.errors, c.rowsSent, c.bytesSent, c.p95, c.copy, c.rows, c.failing, c.oldest, ...(withLag ? [c.lag] : [])].map(num).join("")}</tr>`;
    }).join("") + "</tbody></table>");
    // the charts draw these numbers: then they are one click away, and open by the person's choice (keyed: a poll rewrites the hours)
    samples = (Object.keys(usageSpecs(b)).some((k) => CHARTS.some(([key]) => key === k)) ? details("usage-hours", "The numbers, hour by hour", hours, isOpen("usage-hours"), "hours") : hours) +
      // the process's memory, an hour a line: a debugging aid, behind a closed details
      // (keyed: a poll rewrites the hours, and an open Memory stays open)
      details("usage-memory", "Memory", panel(`<table class="samples">${th(["Time (UTC)", "Memory"])}<tbody>` +
        b.samples.map((s) => { const c = sampleCells(s); return `<tr><th scope="row">${esc(c.time)}</th><td>${esc(c.memory)}</td></tr>`; }).join("") + "</tbody></table>"), isOpen("usage-memory"), "memory");
  }
  return head + samples;
}

/** Each copy's own size, measured every 10 min (src/cli/usage.ts): table, bytes, when. */
export function renderCopySizes(sizes) {
  if (!sizes.length) return empty(`No copy measured yet: each is measured every ${duration(SIZE_EVERY_SECONDS)}.`);
  return `<p class="dim">Measured every ${esc(duration(SIZE_EVERY_SECONDS))}.</p>` + panel(`<table class="sizes">${th(["Table", "Size", "Measured at (UTC)"])}<tbody>` +
    sizes.map((c) => `<tr><th scope="row"><code>${esc(c.table)}</code></th>${num(fileSize(c.bytes))}<td>${esc(c.at.slice(11, 16))}</td></tr>`).join("") + "</tbody></table>");
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
      charts: () => usageSpecs(ctx.read(HOURLY)?.body),
      view: () => ({
        "usage-kpis": ctx.read(QUERIES) === undefined ? skeleton(2) : ctx.read(QUERIES).body ? renderUsageKpis(ctx.read(QUERIES).body, ctx.read(HOURLY)?.body) : "",
        "usage-charts": renderCharts(ctx.read(HOURLY)?.body),
        "usage-queries": part(QUERIES, (b) => renderQueries(b.queries), false),
        "usage-hourly": part(HOURLY, (b) => renderUsage(b, opened.has), true),
        "usage-sizes": part(HOURLY, (b) => renderCopySizes(b.copySizes), false),
      }),
    };
  },
};
