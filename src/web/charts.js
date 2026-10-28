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
 *      `{ kind: "spark" | "bars" | "line", x: seconds[], y: (number | null)[], label, format?(v) → text }`
 *      (`seriesOf(samples, field)` makes x and y from /api/usage's samples);
 *   3. the shell, after it writes the page, calls `mount(specs)` of ONE `createCharts`: a chart is made once per key,
 *      moved into the holder a rewrite made, given its new data when the data changed, and destroyed when its key or
 *      holder is gone — no instance outlives what it draws.
 * DOM-free until `mount`, so the module loads under node; uPlot itself is imported only then.
 */
import { esc } from "./shared.js";

/** uPlot's module, imported relative to this one (a route of PAGE_ROUTES), only in a browser and only once. */
export const UPLOT = "./vendor/uplot-1.6.32/uPlot.esm.js";

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
export function themeOf(doc, win) {
  const cs = win.getComputedStyle(doc.documentElement);
  const v = (k, d) => cs.getPropertyValue(k).trim() || d;
  return { trend: v("--chart-trend", "#a8a8a8"), mark: v("--chart-mark", "#0070f3"), grid: v("--chart-grid", "#ebebeb"),
    text: v("--chart-text", "#8f8f8f"), font: v("--font-mono", "monospace") };
}

/** The index of a series' last value: where a sparkline's one marker goes (the latest period, in the accent). */
const lastIndex = (y) => { for (let i = y.length - 1; i >= 0; i--) if (y[i] !== null) return i; return -1; };

/** An hour's label in UTC, as the tables say it: `09:00`. */
const hourText = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);

/**
 * UPLOT'S OPTIONS FOR A SPEC (pure): a sparkline is the trend alone — no axis, legend or cursor, a 2px line in the
 * de-emphasis gray from a zero baseline, its latest value an 8px dot in the accent; a series chart has recessive axes
 * (UTC hours, the value's own format), one hue, bars with a 2px gap or a 2px line, and a cursor whose live legend is
 * the hover read-out.
 */
export function chartOptions(spec, theme, width, height, uPlot) {
  const fmt = spec.format ?? ((v) => String(v));
  const zero = (_u, _min, max) => [0, max > 0 ? max * 1.08 : 1];
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
  return {
    width, height, padding: [10, 8, 0, 0], legend: { show: true, live: true }, select: { show: false },
    cursor: { drag: { x: false, y: false }, points: { size: 8, fill: theme.mark } },
    ...(typeof uPlot?.tzDate === "function" ? { tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC") } : {}),
    scales: { x: { time: true }, y: { range: zero } },
    axes: [
      { stroke: theme.text, font: axisFont, grid: { show: false }, ticks: { stroke: theme.grid, width: 1, size: 4 }, values: (_u, vals) => vals.map(hourText) },
      { stroke: theme.text, font: axisFont, size: 64, grid: { stroke: theme.grid, width: 1 }, ticks: { show: false }, values: (_u, vals) => vals.map(fmt) },
    ],
    series: [
      { label: "UTC", value: (_u, v) => v === null ? "–" : hourText(v) },
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
  const destroy = (key) => { live.get(key)?.plot.destroy(); live.delete(key); };
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
        live.set(key, { el, plot: new lib(chartOptions(spec, theme, width, height, lib), [spec.x, spec.y], el), sig: signature(spec) });
        continue;
      }
      // the part was written again: the same chart, moved into the new holder
      if (c.el !== el) { show(el).appendChild(c.plot.root); c.el = el; c.plot.setSize(size(el, spec.kind)); }
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
    resize() { for (const [key, c] of live) c.plot.setSize(size(c.el, last[key]?.kind)); },
    /** How many charts are alive (the tests: none leaks). */
    count: () => live.size,
  };
}
