/**
 * THE USAGE VIEW (#observability/usage, a sub-tab of Observability; `#usage`, its old address, lands here;
 * docs/OBSERVABILITY.md "Pages"): what `mason status` says of the queries and what `mason usage` prints, over the time
 * range the Observability views share (RANGES: the hour a minute a point, the day an hour, the week six hours) — KPI
 * cards (statements, the failed ones, p95, rows and bytes sent, each with a sparkline; the request log's summary has a
 * day and a week, so the hour's cards say the day, by name), four small charts (statements, p95, the copy's size and its
 * rows), the last day's and week's statements side by side, the samples a line, newest first (the charts' numbers, behind
 * a details once there are charts; sorted by time either way), and each copy's own size.
 * Reads `/api/queries`, `/api/usage` and its copy sizes every 60 s (a sample is taken a minute). Every number a chart
 * draws is also text, in a card or the hours' table. A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, n, bytesText, fileSize, duration, renderFailure, details, createOpenSet, cards, card, empty, panel, skeleton, sortTh, nextSort, RANGES, DEFAULT_RANGE, rangeOf } from "../shared.js";
import { spark, seriesChart, seriesOf, drawable } from "../charts.js";
import { statementCards, summaryWindow } from "./queries.js";

const EVERY_MS = 60_000;
/** The samples of a range, its step a line: `step` is seconds (src/cli/run-server.ts `usage`). The 24 hours' is the
 *  Overview's read too (src/web/pages/status.js HOURLY), so the two pages share it. */
export const usagePath = (range = DEFAULT_RANGE) => { const r = RANGES[rangeOf(range)]; return `/api/usage?since=${r.since}&step=${r.stepSeconds}`; };
export const HOURLY = usagePath("24h");
/** A step said as the charts' titles say it: `a minute`, `an hour`, `every 6 hours`. */
export const perStep = (seconds) => seconds === 60 ? "a minute" : seconds === 3600 ? "an hour" : seconds % 3600 === 0 ? `every ${seconds / 3600} hours` : `every ${duration(seconds)}`;
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
    `<p class="dim">Each statement is listed on <a href="#observability/queries">Observability › Queries</a>, or by <code>mason logs --requests</code>.</p>`;
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

/** The charts, in order: [holder key, title, sample field, kind, how a hovered value is said (exactly, as the table
 *  says it), the axis's unit]. One series each, from a zero baseline. "Statements" is "Statements an hour" by the step. */
export const CHARTS = [
  ["usage-statements", "Statements", "statements", "bars", n, "count"],
  ["usage-p95", "p95 duration", "durationP95Ms", "line", (v) => `${n(Math.round(v))} ms`, "ms"],
  ["usage-copy-bytes", "Size of the copy", "copyBytes", "line", fileSize, "bytes"],
  ["usage-copy-rows", "Rows in the copy", "copyRows", "line", n, "count"],
];
/** A chart's title at a step: the statements are counted per step, the rest are levels. */
const chartTitle = (key, title, step) => key === "usage-statements" ? `Statements ${perStep(step ?? 3600)}` : title;
/** The sparklines of the cards, by card: [holder key, title, sample field]. The failed ones are the samples' refused and failed together. */
export const SPARKS = { statements: ["usage-spark-statements", "Statements", "statements"], failed: ["usage-spark-failed", "Failed statements", "failedCount"],
  p95: ["usage-spark-p95", "p95", "durationP95Ms"], rows: ["usage-spark-rows", "Rows sent", "rowsSent"], bytes: ["usage-spark-bytes", "Bytes sent", "bytesSent"] };

const samplesOf = (usage) => usage && Array.isArray(usage.samples) ? usage.samples.map((s) => ({ ...s, failedCount: s.statementsRefused + s.statementsFailed })) : [];

/** The specs of the charts and the sparklines from `/api/usage`'s body (anything else draws none), by holder key: what `charts()` returns. */
export function usageSpecs(usage) {
  const samples = samplesOf(usage);
  const specs = [
    ...CHARTS.map(([key, label, field, kind, format, unit]) => [key, { kind, label: chartTitle(key, label, usage?.stepSeconds), format, unit, ...seriesOf(samples, field) }]),
    ...Object.values(SPARKS).map(([key, label, field]) => [key, { kind: "spark", label, ...seriesOf(samples, field) }]),
  ];
  return Object.fromEntries(specs.filter(([, spec]) => drawable(spec)));
}

/**
 * The four charts' holders, each under its title (cut with an ellipsis when long, its whole the title): a series that can
 * be drawn gets its holder; one with a single sample says it and its value (a chart needs two); none with no sample at
 * all (the samples' table says so). `range` names the span in each chart's label.
 */
export function renderCharts(usage, range = DEFAULT_RANGE) {
  const specs = usageSpecs(usage);
  const samples = samplesOf(usage);
  if (!samples.length) return "";
  const span = (RANGES[rangeOf(range)] ?? RANGES[DEFAULT_RANGE]).span;
  const blocks = CHARTS.map(([key, title, field, , format]) => {
    const name = chartTitle(key, title, usage.stepSeconds);
    const head = `<p class="card-label" title="${esc(name)}">${esc(name)}</p>`;
    if (specs[key]) return `<div class="chart-card">${head}${seriesChart(key, `${name}, ${span}`)}</div>`;
    const values = samples.map((x) => x[field]).filter((v) => typeof v === "number");
    return `<div class="chart-card note">${head}<p class="dim">${values.length === 1 ? `One sample so far: ${esc(format(values[0]))}. A chart needs two.` : "No value in this time."}</p></div>`;
  });
  return `<div class="chart-grid">${blocks.join("")}</div>`;
}

/**
 * THE KPI CARDS of the last 24 hours (`queries`: `/api/queries`' body): the statements, the failed ones and the p95 as the
 * Queries page's cards say them (`statementCards`), the rows and the bytes sent; each with a sparkline of the hours where
 * `usage` (`/api/usage`'s body) has two to draw. Their numbers are the cards' text either way.
 */
export function renderUsageKpis(queries, usage, range = DEFAULT_RANGE) {
  const specs = usageSpecs(usage);
  const r = RANGES[rangeOf(range)];
  const line = (k) => specs[SPARKS[k][0]] ? spark(SPARKS[k][0], `${SPARKS[k][1]}, ${r.span} ${perStep(r.stepSeconds)} a point`) : "";
  const w = summaryWindow(range);
  const day = queries.queries[w.key];
  return cards([...statementCards(day, line, w.label), card(`Rows sent, ${w.label}`, n(day.rows), "", line("rows")), card(`Bytes sent, ${w.label}`, bytesText(day.bytesSent), "", line("bytes"))]);
}

/**
 * The usage answer as `mason usage` prints it: its heading, then the samples a line each (or that there are none yet), then
 * each copy's size. With charts drawn the hours are their numbers, behind a closed details `usage-hours`; the process's
 * memory is behind another.
 */
export function renderUsage(b, isOpen = () => false, sort = { key: "time", dir: "desc" }) {
  const at = (iso) => iso.slice(0, 16).replace("T", " ");
  const span = b.stepSeconds === null ? "every sample" : `${duration(b.stepSeconds)} a line`;
  const head = `<p class="dim">From ${esc(at(b.since))} to ${esc(at(b.until))} UTC, ${esc(span)} (a sample every ${esc(duration(b.sampleSeconds))}, kept ${b.keptDays} day${b.keptDays === 1 ? "" : "s"}).</p>`;
  let samples;
  if (!b.samples.length) samples = empty("No sample in this time: Mason takes the first a minute after it starts.");
  else {
    const withLag = b.samples.some((s) => s.streamLagBytes !== null || s.streamLagSeconds !== null);
    const cols = ["Time (UTC)", "Statements", "Errors", "Rows sent", "Bytes sent", "p95", "Copy", "Rows", "Failing", "Oldest", ...(withLag ? ["Lag"] : [])];
    // newest first unless the time's header turned it round (the charts read left to right, oldest first)
    const ordered = sort.dir === "asc" ? b.samples : [...b.samples].reverse();
    const head = (list) => `<thead><tr>${sortTh("hours", "time", list[0], sort)}${list.slice(1).map((c) => `<th scope="col"${c === "Time (UTC)" ? "" : ` class="num"`}>${esc(c)}</th>`).join("")}</tr></thead>`;
    const hours = panel(`<table class="samples">${head(cols)}<tbody>` + ordered.map((s) => {
      const c = sampleCells(s);
      return `<tr><th scope="row">${esc(c.time)}</th>${[c.statements, c.errors, c.rowsSent, c.bytesSent, c.p95, c.copy, c.rows, c.failing, c.oldest, ...(withLag ? [c.lag] : [])].map(num).join("")}</tr>`;
    }).join("") + "</tbody></table>");
    // the charts draw these numbers: then they are one click away, and open by the person's choice (keyed: a poll rewrites the hours)
    samples = (Object.keys(usageSpecs(b)).some((k) => CHARTS.some(([key]) => key === k)) ? details("usage-hours", `The numbers, ${perStep(b.stepSeconds ?? 60).replace(/^every /, "")} a line`, hours, isOpen("usage-hours"), "hours") : hours) +
      // the process's memory, an hour a line: a debugging aid, behind a closed details
      // (keyed: a poll rewrites the hours, and an open Memory stays open)
      details("usage-memory", "Memory", panel(`<table class="samples">${th(["Time (UTC)", "Memory"])}<tbody>` +
        ordered.map((s) => { const c = sampleCells(s); return `<tr><th scope="row">${esc(c.time)}</th><td>${esc(c.memory)}</td></tr>`; }).join("") + "</tbody></table>"), isOpen("usage-memory"), "memory");
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
  hash: "observability/usage",
  parent: "observability",
  title: "Usage",
  create(ctx) {
    const opened = createOpenSet();
    const m = { open: opened.open, sort: { key: "time", dir: "desc" } };
    const path = () => usagePath(ctx.range());
    const actions = { sortHours() { m.sort = nextSort(m.sort, "time"); } };
    /** What a read gave: its body, or its Failure where it shows (said once, and not the first read's: that is the banner), or that it is being asked. */
    const part = (path, render, says) => {
      const r = ctx.read(path);
      if (r === undefined) return `<p class="dim">Asking Mason…</p>`;
      const failure = r.failure && says ? renderFailure(r.failure) : "";
      return failure + (r.body === undefined ? "" : render(r.body));
    };
    return {
      model: m,
      reads: () => [{ path: QUERIES, everyMs: EVERY_MS }, { path: path(), everyMs: EVERY_MS }],
      actions,
      toggle: (target) => opened.toggle(target),
      click(d) { return d.sortTable === "hours" ? (actions.sortHours(), true) : null; },
      charts: () => usageSpecs(ctx.read(path())?.body),
      view: () => ({
        "usage-kpis": ctx.read(QUERIES) === undefined ? skeleton(2) : ctx.read(QUERIES).body ? renderUsageKpis(ctx.read(QUERIES).body, ctx.read(path())?.body, ctx.range()) : "",
        "usage-charts": renderCharts(ctx.read(path())?.body, ctx.range()),
        "usage-queries": part(QUERIES, (b) => renderQueries(b.queries), false),
        "usage-hourly": part(path(), (b) => renderUsage(b, opened.has, m.sort), true),
        "usage-sizes": part(path(), (b) => renderCopySizes(b.copySizes), false),
      }),
    };
  },
};
