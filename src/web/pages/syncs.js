/**
 * THE SYNCS VIEW (#observability/syncs, a view of the Observability group; `#observability/logs`, `#logs` and `#syncs`
 * land here;
 * docs/OBSERVABILITY.md "Pages"): the sync's events (`mason logs --events`) over the time range the Observability views
 * share, as a timeline table NEWEST FIRST (When sorts it the other way) — narrowed in the page alone by "Failures only",
 * a kind and a table (every kind, and every added table from `/api/state`, events or not), at most EVENTS_SHOWN rows written with
 * "Show more" — and, behind a closed details "The run's raw log (for debugging)", the run's last log entries, newest
 * first (`mason logs`: they carry internal tags and absolute paths, so they are not the page's content). Reads
 * `/api/events` every 10 s while the range is Now, and `/api/logs` every 5 s ONLY WHILE the details is open (the page's own state: nothing is
 * read when it is closed); the events once when a range other than Now is chosen. A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, agoText, utcText, badge, empty, panel, n, sortTh, nextSort, moreRows, readPart, eventCells, RANGES, DEFAULT_RANGE, rangeOf, rangeEvery } from "../shared.js";

/** How many of the range's events are read (the newest), and how many of those the page writes at once. */
const EVENTS_LIMIT = 500;
const EVENTS_SHOWN = 100;
/** The events of a range: the newest EVENTS_LIMIT since its start. */
const eventsPath = (range = DEFAULT_RANGE) => `/api/events?limit=${EVENTS_LIMIT}&since=${RANGES[rangeOf(range)].since}`;
const LOGS = "/api/logs?lines=200";
const STATE = "/api/state";

const th = (cols) => cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("");

/** An event's kind as a badge: a failure red (with its ✗), a copy made or a failure recovered green, any other gray. */
const kindBadge = (e) => badge(e.failed ? `✗ ${e.kind}` : e.kind, e.failed ? "bad" : /^(copied|recovered)$/.test(e.kind) ? "ok" : "");

/** The events read that pass the page's filters: failures only, a kind, a table ("" any; the sync's own is "(the sync)"). */
const eventsShown = (events, { failuresOnly = false, kind = "", table = "" } = {}) =>
  events.filter((e) => (!failuresOnly || e.failed) && (!kind || e.kind === kind) && (!table || (e.table ?? "(the sync)") === table));

/**
 * The sync's events as a timeline, NEWEST FIRST (`sort.dir` "asc": oldest first, as the command lists them): when (how
 * long ago; the UTC time, as the command prints it, is the title), the kind as a badge, the table, the reason's first line
 * and, under it, its further lines. `failuresOnly`, `kind` and `table` (the page's filters) keep the events of what was
 * read that pass (`eventsShown`); at most `limit` rows are written. `span` the range's words; `now` the page's clock.
 */
export function renderEvents(b, { failuresOnly = false, kind = "", table = "", now = Date.now(), sort = { key: "time", dir: "desc" }, limit = EVENTS_SHOWN, span = "" } = {}) {
  const days = `${b.keptDays} day${b.keptDays === 1 ? "" : "s"}`;
  const within = span ? `in ${span} (the events are kept ${days}: MASON_HISTORY_DAYS)` : `in the last ${days} (MASON_HISTORY_DAYS)`;
  const passing = eventsShown(b.events, { failuresOnly, kind, table });
  const narrowed = failuresOnly || kind || table;
  // a table chosen that had none (every added table is a choice, events or not): said by its name
  if (!passing.length && table && !kind) return empty(`No ${failuresOnly ? "failure" : "event"}s for ${table} ${within}.`);
  if (!b.events.length) return empty(`No sync event ${within}.`);
  if (!passing.length) {
    return empty(failuresOnly && !kind && !table ? `None of the ${b.events.length} sync event${b.events.length === 1 ? "" : "s"} shown failed.` : `None of the ${n(b.events.length)} sync event${b.events.length === 1 ? "" : "s"} read passes the filters.`);
  }
  const ordered = sort.dir === "asc" ? passing : [...passing].reverse();
  const rows = ordered.slice(0, limit).map((e) => {
    const c = eventCells(e);
    const more = e.message.includes("\n") ? `<pre>${esc(e.message.split("\n").slice(1).join("\n"))}</pre>` : "";
    return `<tr${e.failed ? ` class="t-failed"` : ""}><th scope="row"><time datetime="${esc(e.at)}" title="${esc(c.time)} UTC">${esc(agoText(e.at, now))}</time></th><td>${kindBadge(e)}</td>` +
      `<td>${c.table.startsWith("(") ? `<span class="dim">${esc(c.table)}</span>` : `<code class="name" title="${esc(c.table)}">${esc(c.table)}</code>`}</td><td>${esc(c.message)}${more}</td></tr>`;
  }).join("");
  const count = narrowed ? `<p class="dim">${n(passing.length)} of the ${n(b.events.length)} events read.</p>` : "";
  return count + panel(`<table class="events"><thead><tr>${sortTh("events", "time", "When", sort)}${th(["Kind", "Table", "Message"])}</tr></thead><tbody>${rows}</tbody></table>`) +
    moreRows("events", Math.min(limit, passing.length), passing.length, EVENTS_SHOWN);
}

/** EVERY KIND OF SYNC EVENT, in its order (src/duck/events.ts `EVENT_KINDS`, held equal by the tests): the Kind filter
 *  offers each, whether the range has one or not. */
export const EVENT_KINDS = ["copy_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "restart", "copied", "recovered"];

/** The kind and table filters' controls: EVERY kind (EVENT_KINDS), and EVERY added table (`/api/state` `tables`, `s`) —
 *  the sync's own "(the sync)" first — whether the range has an event of it or not, so the choices never depend on what
 *  happened to be read; a table only the events name (removed since) and the one chosen are kept too. Written into
 *  their part: the tables follow the state. */
export function renderEventFilters(b, { kind = "", table = "" } = {}, s = null) {
  const events = b?.events ?? [];
  const added = (s?.tables ?? []).filter((t) => t.added).map((t) => t.table);
  const others = [...new Set([...events.map((e) => e.table).filter((t) => t !== null && t !== undefined && !added.includes(t)), ...(table && table !== "(the sync)" && !added.includes(table) ? [table] : [])])].sort();
  const tables = ["(the sync)", ...[...added].sort(), ...others];
  const kinds = [...EVENT_KINDS, ...[...new Set([...events.map((e) => e.kind), ...(kind ? [kind] : [])])].filter((k) => !EVENT_KINDS.includes(k)).sort()];
  const select = (id, label, all, values, chosen) => `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}">` +
    `<option value="">${esc(all)}</option>${values.map((v) => `<option value="${esc(v)}"${v === chosen ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></div>`;
  return select("syncs-kind", "Kind", "Every kind", kinds, kind) + select("syncs-table", "Table", "Every table", tables, table);
}

/** The run's last log entries as a terminal's lines, NEWEST FIRST (the debugging reader wants what just happened); an entry of several lines is one, as written. */
export function renderLogs(b) {
  if (!b.lines.length) return empty("The run has logged nothing yet.");
  return `<div class="terminal" role="log">` +
    [...b.lines].reverse().map((l) => `<div class="log-line"><time>${esc(l.at === null || l.at === undefined ? "" : utcText(l.at))}</time><pre>${esc(l.text)}</pre></div>`).join("") + `</div>` +
    `<p class="dim">The last ${b.lines.length} of at most ${b.kept} entries the run keeps, newest first; <code>mason logs</code> reads the log file.</p>`;
}

/** The raw log's details: its summary closed or open, and, open, the entries (or that they are being asked). */
export function renderRawLog(open, inner) {
  return `<details id="syncs-raw"${open ? " open" : ""}><summary>The run's raw log (for debugging)</summary>${open ? inner : ""}</details>`;
}

export const page = {
  id: "syncs",
  hash: "observability/syncs",
  parent: "observability",
  title: "Syncs",
  create(ctx) {
    const m = { rawOpen: false, failuresOnly: false, kind: "", table: "", sort: { key: "time", dir: "desc" }, limit: EVENTS_SHOWN };
    const events = () => eventsPath(ctx.range());
    const part = (path, render, says) => readPart(ctx, path, render, says);
    const actions = {
      /** The details opened or closed: the log is read from then on, or no longer. */
      async showRawLog(open) {
        m.rawOpen = open === true;
        if (m.rawOpen) await ctx.refresh([LOGS]);
      },
      sortEvents() { m.sort = nextSort(m.sort, "time"); },
      showMoreEvents() { m.limit += EVENTS_SHOWN; },
      showAllEvents() { m.limit = Infinity; },
    };
    return {
      model: m,
      // the state for the Table filter's choices (every added table), as often as tables are added
      reads: () => [{ path: events(), everyMs: rangeEvery(ctx.range(), 10_000) }, { path: STATE, everyMs: 30_000 }, ...(m.rawOpen ? [{ path: LOGS, everyMs: 5000 }] : [])],
      actions,
      view: () => ({
        "syncs-filters": renderEventFilters(ctx.read(events())?.body, m, ctx.read(STATE)?.body ?? null),
        "syncs-events": part(events(), (b) => renderEvents(b, { failuresOnly: m.failuresOnly, kind: m.kind, table: m.table, now: ctx.now().getTime(), sort: m.sort, limit: m.limit,
          span: RANGES[ctx.range()]?.span ?? "" }), false),
        "syncs-run": renderRawLog(m.rawOpen, m.rawOpen ? part(LOGS, renderLogs, true) : ""),
      }),
      /** The "Failures only" box, the kind or the table chosen: the events read are filtered in the page alone. */
      input(target) {
        if (target?.id === "syncs-failures-only") { m.failuresOnly = target.checked === true; m.limit = EVENTS_SHOWN; return true; }
        if (target?.id === "syncs-kind") { m.kind = target.value ?? ""; m.limit = EVENTS_SHOWN; return true; }
        if (target?.id === "syncs-table") { m.table = target.value ?? ""; m.limit = EVENTS_SHOWN; return true; }
        return null;
      },
      /** `#observability/syncs?failures=1` (where the Overview's sync errors lead): the failures only, the box ticked;
       *  `?table=<name>` (a table's View syncs) its events only, the Table filter showing it. */
      route(params, { doc } = {}) {
        if (params.failures === undefined && params.table === undefined) return null;
        m.failuresOnly = params.failures === "1";
        m.table = params.table ?? "";
        m.limit = EVENTS_SHOWN;
        const box = doc?.getElementById?.("syncs-failures-only");
        if (box) box.checked = m.failuresOnly;
        return true;
      },
      click(d) {
        if (d.sortTable === "events") return actions.sortEvents() ?? true;
        if (d.showMore === "events") return actions.showMoreEvents() ?? true;
        if (d.showAll === "events") return actions.showAllEvents() ?? true;
        return null;
      },
      /** A details of this section opened or closed (the shell listens to `toggle`): null when it is not the raw log's. */
      toggle(target) {
        if (target.id !== "syncs-raw") return null;
        const open = target.open === true;
        if (open === m.rawOpen) return null;
        return actions.showRawLog(open);
      },
    };
  },
};
