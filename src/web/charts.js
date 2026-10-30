/**
 * THE CHARTS OF THE WEB PAGE (docs/WEB-UI.md "Presentation"): a sparkline in a KPI card and a small time-series chart
 * (bars or a line), drawn by uPlot (vendored whole: src/web/vendor/uplot-1.6.32/, MIT) and themed from the CSS tokens
 * (`--chart-*`, src/web/app.css). A chart is a PROGRESSIVE ADDITION: every number it draws is also said as text in a
 * card or a table (the tests read the text), so a page reads the same where uPlot never loads.
 *
 * How a page uses them:
 *   1. its renderer writes a holder where the chart goes — `spark(key, label)` or `seriesChart(key, label)` — an empty
 *      div that takes no room until it is drawn;
 *   2. its `charts()` (the page module contract, src/web/app.js) returns `{ [key]: spec }`, a spec being
 *      `{ kind: "spark" | "bars" | "line", x: seconds[], y: (number | null)[], label, format?(v) → text, unit? }`
 *      (`format` says a hovered value exactly, as the tables do; `unit` — "bytes", "ms", else a count — the axis's
 *      compact labels and steps: `axisFormat`, `axisIncrs`; the time axis's labels follow the span, `timeTick`)
 *      (`seriesOf(samples, field)` makes x and y from /api/usage's samples);
 *   3. the shell, after it writes the page, calls `mount(specs)` of ONE `createCharts`: a chart is made once per key,
 *      moved into the holder a rewrite made, given its new data when the data changed, and destroyed when its key or
 *      holder is gone — no instance outlives what it draws.
 * DOM-free until `mount`, so the module loads under node; uPlot itself is imported only then.
 */
import { esc } from "./shared.js";

/** uPlot's module, imported relative to this one (a route of PAGE_ROUTES), only in a browser and only once. */
const UPLOT = "./vendor/uplot-1.6.32/uPlot.esm.js";

const holder = (cls, key, label) => `<div class="chart ${cls}" data-chart="${esc(key)}" role="img" aria-label="${esc(label)}"></div>`;
/** Where a KPI card's sparkline is drawn: `card(label, value, sub, spark("rows", "Rows, the last 24 hours"))`. */
export const spark = (key, label) => holder("spark", key, label);
/** Where a small time-series chart is drawn (above the table that says the same numbers). */
export const seriesChart = (key, label) => holder("series", key, label);

/** A series from /api/usage's samples: x each sample's time in seconds, y its `field` (null where it has none). */
export function seriesOf(samples, field) {
  return { x: samples.map((s) => Date.parse(s.at) / 1000), y: samples.map((s) => typeof s[field] === "number" ? s[field] : null) };
}

/** Whether a spec is worth drawing: two points with a value, at least (one point is no trend). */
export const drawable = (spec) => spec !== undefined && spec !== null && Array.isArray(spec.x) && spec.x.length >= 2 &&
  spec.y.filter((v) => v !== null).length >= 2;

/** The colours and the font a chart is drawn in, from the page's tokens (light or dark: the stylesheet chooses). */
function themeOf(doc, win) {
  const cs = win.getComputedStyle(doc.documentElement);
  const v = (k, d) => cs.getPropertyValue(k).trim() || d;
  return { trend: v("--chart-trend", "#a8a8a8"), mark: v("--chart-mark", "#0070f3"), grid: v("--chart-grid", "#ebebeb"),
    text: v("--chart-text", "#8f8f8f"), font: v("--font-mono", "monospace") };
}

/** The index of a series' last value: where a sparkline's one marker goes (the latest period, in the accent). */
const lastIndex = (y) => { for (let i = y.length - 1; i >= 0; i--) if (y[i] !== null) return i; return -1; };

// ------------------------------------------------------------------ the axes' words (pure: the tests hold each)

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A TIME TICK'S LABEL for a chart spanning `span` seconds, in UTC as the tables say it: minutes and hours (`09:05`,
 * `14:00`) up to two days; past that a day (`Oct 27`) at midnight and the hour between (`12:00`), so a week reads by
 * its days. Short enough that ticks 72 px apart never touch.
 */
export function timeTick(sec, span) {
  const d = new Date(sec * 1000);
  const hm = d.toISOString().slice(11, 16);
  if (span <= 2 * 86_400) return hm;
  return hm === "00:00" ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : hm;
}

/** The hovered time, read out under the chart: the minute alone within three hours, else its date too (`2026-10-27 09:00 UTC`). */
export function readoutTime(sec, span) {
  const iso = new Date(sec * 1000).toISOString();
  return `${span <= 3 * 3600 ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`} UTC`;
}

const trim1 = (x) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ""));

/** A count on an axis: `0`, `950`, `1.2K`, `3.4M` (the read-out and the table have it whole). */
export const compactCount = (v) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);

/** Bytes on an axis, in the units the commands use (KiB, MiB, GiB) and on to TiB and PiB: `512 B`, `3.4 MiB`, `1.5 TiB`. */
export function compactBytes(v) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0, x = Math.abs(v);
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${v < 0 ? "-" : ""}${i === 0 ? Math.round(x) : trim1(x)} ${units[i]}`;
}

/** A duration in ms on an axis: `512 ms`, `1.2 s`, `2.5 min`, `1.1 h`. */
export function compactMs(v) {
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${trim1(v / 1000)} s`;
  if (v < 3_600_000) return `${trim1(v / 60_000)} min`;
  return `${trim1(v / 3_600_000)} h`;
}

/** An axis's labeller by a spec's unit: "bytes", "ms", else a count. */
const axisFormat = (unit) => unit === "bytes" ? compactBytes : unit === "ms" ? compactMs : compactCount;

/** The steps an axis's ticks are chosen from, by unit: whole numbers for a count or ms (never 0.5 of a statement), and
 *  powers of 1024 for bytes, so a tick is 512 MiB or 1 GiB, never 477 MiB. */
export function axisIncrs(unit) {
  const bases = unit === "bytes" ? [1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5] : [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12];
  const mults = unit === "bytes" ? [1, 2, 4, 8, 16, 32, 64, 128, 256, 512] : [1, 2, 5];
  return [...new Set(bases.flatMap((b) => mults.map((m) => m * b)))].sort((a, b) => a - b);
}

/** The steps a time axis's ticks are chosen from, in seconds: whole minutes at the least (a tick between two minutes would
 *  read as the minute twice), then hours, then days. */
const TIME_INCRS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 2 * 86_400, 7 * 86_400];

/** The y range from a zero baseline, a little over the highest value (1 when all are 0). A spike keeps its height: the
 *  axis is never cut, so the bar that is ten times the others reads as ten times (the table has every value). */
export const zeroRange = (max) => [0, max > 0 ? max * 1.08 : 1];

/**
 * UPLOT'S OPTIONS FOR A SPEC (pure): a sparkline is the trend alone — no axis, legend or cursor, a 2px line in the
 * de-emphasis gray from a zero baseline, its latest value an 8px dot in the accent; a series chart has recessive axes
 * (UTC hours, the value's own format), one hue, bars with a 2px gap or a 2px line, and a cursor whose live legend is
 * the hover read-out.
 */
export function chartOptions(spec, theme, width, height, uPlot) {
  const fmt = spec.format ?? ((v) => String(v));
  const zero = (_u, _min, max) => zeroRange(max);
  if (spec.kind === "spark") {
    return {
      width, height, padding: [6, 6, 6, 6], legend: { show: false }, cursor: { show: false }, select: { show: false },
      scales: { x: { time: false }, y: { range: zero } }, axes: [{ show: false }, { show: false }],
      series: [{}, { label: spec.label, stroke: theme.trend, width: 2, spanGaps: false,
        points: { show: true, size: 8, width: 0, fill: theme.mark, stroke: theme.mark, filter: (u, si) => { const i = lastIndex(u.data[si]); return i < 0 ? null : [i]; } } }],
    };
  }
  const bars = spec.kind === "bars" && typeof uPlot?.paths?.bars === "function";
  const axisFont = `11px ${theme.font}`;
  const span = spec.x.length ? spec.x[spec.x.length - 1] - spec.x[0] : 0;
  const axis = axisFormat(spec.unit);
  return {
    width, height, padding: [10, 24, 0, 0], legend: { show: true, live: true }, select: { show: false },
    cursor: { drag: { x: false, y: false }, points: { size: 8, fill: theme.mark } },
    ...(typeof uPlot?.tzDate === "function" ? { tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC") } : {}),
    scales: { x: { time: true }, y: { range: zero } },
    axes: [
      { stroke: theme.text, font: axisFont, space: 72, incrs: TIME_INCRS, grid: { show: false }, ticks: { stroke: theme.grid, width: 1, size: 4 }, values: (_u, vals) => vals.map((v) => timeTick(v, span)) },
      { stroke: theme.text, font: axisFont, size: 64, space: 28, incrs: axisIncrs(spec.unit), grid: { stroke: theme.grid, width: 1 }, ticks: { show: false }, values: (_u, vals) => vals.map(axis) },
    ],
    series: [
      // the read-out under the chart: the hovered time and its EXACT value (the axis is compact; the read-out is the table's)
      { label: "At", value: (_u, v) => v === null ? "–" : readoutTime(v, span) },
      { label: spec.label, stroke: theme.mark, width: bars ? 0 : 2, ...(bars ? { fill: theme.mark, paths: uPlot.paths.bars({ size: [0.7, 48], gap: 2 }) } : {}),
        points: { show: false }, value: (_u, v) => v === null ? "–" : fmt(v) },
    ],
  };
}

/** A series chart's plot, in px (its live read-out is under it). */
const SERIES_HEIGHT = 160;

/** What a spec draws, as one string: a chart is given new data only when this changed. */
const signature = (spec) => `${spec.kind}|${spec.x.join(",")}|${spec.y.join(",")}`;

/**
 * THE CHARTS OF A DOCUMENT, made, moved, updated and destroyed by key (see the top of this file). `load` gives uPlot's
 * constructor (the vendored module by default; a test passes its own, or one that fails). When uPlot cannot load the
 * page still reads whole — every number is text — so the failure is said once in the console and nothing is drawn.
 */
export function createCharts({ doc, win, load = () => import(UPLOT).then((m) => m.default) }) {
  const live = new Map(); // key → { el, plot, sig }
  let lib = null, loading = null, failed = false, last = {};
  const holders = () => new Map([...doc.querySelectorAll("[data-chart]")].map((el) => [el.dataset.chart, el]));
  // EACH CHART AS WIDE AS ITS HOLDER, whenever the holder's width changes — a window resized, a grid that reflowed, the
  // sidebar become a rail — not only on the window's resize: a chart sized once at a wider holder stood out of its card
  const watched = new Map(); // holder → key
  const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver((entries) => {
    for (const e of entries) {
      const key = watched.get(e.target), c = key === undefined ? undefined : live.get(key);
      if (c !== undefined && c.width !== size(c.el, last[key]?.kind).width) fit(key, c);
    }
  }) : null;
  const watch = (key, el) => { if (observer !== null && watched.get(el) !== key) { observer.observe(el); watched.set(el, key); } };
  const unwatch = (el) => { if (observer !== null && watched.has(el)) { observer.unobserve(el); watched.delete(el); } };
  const fit = (key, c) => { const s = size(c.el, last[key]?.kind); c.plot.setSize(s); c.width = s.width; };
  const destroy = (key) => { const c = live.get(key); if (c !== undefined) { unwatch(c.el); c.plot.destroy(); } live.delete(key); };
  // a holder is shown (`drawn`: app.css hides one not drawn, so it takes no room without uPlot) before it is measured;
  // a sparkline fills its holder, a series chart is its plot's height and its read-out under it
  const show = (el) => { el.classList?.add("drawn"); return el; };
  const size = (el, kind) => ({ width: Math.max(40, Math.floor(el.clientWidth || 200)), height: kind === "spark" ? Math.max(24, Math.floor(el.clientHeight || 48)) : SERIES_HEIGHT });
  function draw(specs) {
    const at = holders();
    // a chart whose key, data or holder is gone is destroyed: a rewrite of the part replaced its holder, and nothing else holds it
    for (const key of [...live.keys()]) if (!drawable(specs[key]) || !at.has(key)) destroy(key);
    const theme = themeOf(doc, win);
    for (const [key, spec] of Object.entries(specs)) {
      const el = at.get(key);
      if (!drawable(spec) || el === undefined) continue;
      const c = live.get(key);
      if (c === undefined) {
        const { width, height } = size(show(el), spec.kind);
        live.set(key, { el, width, plot: new lib(chartOptions(spec, theme, width, height, lib), [spec.x, spec.y], el), sig: signature(spec) });
        watch(key, el);
        continue;
      }
      // the part was written again: the same chart, moved into the new holder
      if (c.el !== el) { unwatch(c.el); show(el).appendChild(c.plot.root); c.el = el; fit(key, c); watch(key, el); }
      const sig = signature(spec);
      if (sig !== c.sig) { c.plot.setData([spec.x, spec.y]); c.sig = sig; }
    }
  }
  return {
    /** Draw these specs where their holders are (the shell calls it after each write); true once uPlot is there. */
    async mount(specs) {
      last = specs;
      if (failed) return false;
      if (lib === null) {
        loading ??= load().then((l) => { lib = l; }, (e) => {
          // tolerated: the charts are an addition over text the page already says; said once, then never tried again
          failed = true;
          win.console?.warn?.(`the page's charts are not drawn (its numbers are in its tables): ${e?.message ?? e}`);
        });
        await loading;
        if (lib === null) return false;
      }
      draw(last);
      return true;
    },
    /** The theme changed (light ↔ dark): every chart made again in the new colours. */
    retheme() { for (const key of [...live.keys()]) destroy(key); if (lib !== null) draw(last); },
    /** The window was resized: each chart to its holder's size. */
    resize() { for (const [key, c] of live) fit(key, c); },
    /** How many charts are alive (the tests: none leaks). */
    count: () => live.size,
  };
}
