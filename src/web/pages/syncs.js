/**
 * THE SYNCS VIEW (#observability/syncs, a view of the Observability group; `#observability/logs`, `#logs` and `#syncs`
 * land here;
 * docs/OBSERVABILITY.md "Pages"): the sync's events (`mason logs --events`) over the time range the Observability views
 * share, as a timeline table NEWEST FIRST (When sorts it the other way) — the scheduled syncs that succeeded read only
 * while "Scheduled syncs" is ticked (or one of their kinds chosen: `?scheduled=1`, filtered by the run, so they never
 * take the place of a failure among the newest EVENTS_LIMIT), "Failures only" asked of the run too (`?failed=1`: every
 * failure of the range, whatever else was read), and narrowed in the page alone by a kind and a table (every kind, and every added table from `/api/state`, events or not), at most EVENTS_SHOWN rows written with
 * "Show more" — and, behind a closed details "The run's raw log (for debugging)", the run's last log entries, newest
 * first (`mason logs`: they carry internal tags and absolute paths, so they are not the page's content). Reads
 * `/api/events` every 10 s (a longer range at its own rate, `rangeEvery`), and `/api/logs` every 5 s ONLY WHILE the
 * details is open (the page's own state: nothing is read when it is closed). A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { VIEW_HASHES } from "../routes.js";
import { esc, agoText, utcText, badge, empty, panel, n, sortTh, nextSort, moreRows, readPart, eventCells, MASON_TABLE, RANGES, DEFAULT_RANGE, rangeOf, rangeEvery } from "../shared.js";

/** How many of the range's events are read (the newest), and how many of those the page writes at once. */
const EVENTS_LIMIT = 500;
const EVENTS_SHOWN = 100;
/** The events of a range: the newest EVENTS_LIMIT since its start; with `failed`, the failures alone, filtered by the run
 *  (so no other event takes a failure's place among the newest read); else with `scheduled`, the scheduled syncs too. */
const eventsPath = (range = DEFAULT_RANGE, { scheduled = false, failed = false } = {}) =>
  `api/events?limit=${EVENTS_LIMIT}&since=${RANGES[rangeOf(range)].since}${failed ? "&failed=1" : scheduled ? "&scheduled=1" : ""}`;
/** The kinds that are scheduled syncs (src/duck/events.ts `SCHEDULED`): read only when asked for. */
const SCHEDULED_KINDS = ["polled", "streamed"];
const LOGS = "api/logs?lines=200";
const STATE = "api/state";

const th = (cols) => cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("");

/** EACH KIND IN THE PAGE'S WORDS (the code, which the CLI and `--json` print, is the badge's title): so a sync you
 *  started, a full sync and a scheduled one are told apart at a glance. "Live" is replication, as the Tables page says. */
export const KIND_WORDS = { copy_failed: "Full sync failed", poll_failed: "Scheduled sync failed", catch_up_failed: "Catch-up failed",
  stream_failed: "Live sync failed", source_unreachable: "Database unreachable", generated_failed: "Generated table failed",
  compact_failed: "Compaction failed", restart: "Mason restarted", copied: "Full sync", recovered: "Working again", synced: "Manual sync",
  sync_changed: "Sync setting changed", polled: "Scheduled sync", streamed: "Live sync", ui_error: "Web page error" };
/** A kind's words; a kind this page does not know, its code. */
export const kindWords = (kind) => Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind] : kind;

/** An event's kind as a badge in words (its code the title): a failure red (with its ✗), a sync done or a failure
 *  recovered green, any other gray. */
const kindBadge = (e) => `<span title="${esc(e.kind)}">${badge(e.failed ? `✗ ${kindWords(e.kind)}` : kindWords(e.kind), e.failed ? "bad" : /^(copied|recovered|synced|polled|streamed)$/.test(e.kind) ? "ok" : "")}</span>`;

/** The events read that pass the page's filters: failures only, a kind, a table ("" any; Mason's own, of no one table,
 *  is MASON_TABLE). */
const eventsShown = (events, { failuresOnly = false, kind = "", table = "" } = {}) =>
  events.filter((e) => (!failuresOnly || e.failed) && (!kind || e.kind === kind) && (!table || (e.table ?? MASON_TABLE) === table));

/** A failure's code and where in Mason it happened (`code`, `origin`, src/duck/events.ts), as one quiet line under its
 *  message; nothing for good news or an event recorded before Mason kept them. */
export function failureFacts(e) {
  if (!e.failed || e.code == null) return "";
  return `<p class="dim">Code <code>${esc(e.code)}</code>${e.origin == null ? "" : `, at <code>${esc(e.origin)}</code>`}</p>`;
}

/**
 * The sync's events as a timeline, NEWEST FIRST (`sort.dir` "asc": oldest first, as the command lists them): when (how
 * long ago; the UTC time, as the command prints it, is the title), the kind as a badge, the table, the reason's first line
 * and, under it, its further lines and a failure's code and origin (`failureFacts`). `failuresOnly`, `kind` and `table`
 * (the page's filters) keep the events of what was read that pass (`eventsShown`); at most `limit` rows are written.
 * `span` the range's words; `now` the page's clock.
 */
export function renderEvents(b, { failuresOnly = false, kind = "", table = "", now = Date.now(), sort = { key: "time", dir: "desc" }, limit = EVENTS_SHOWN, span = "" } = {}) {
  const days = `${b.keptDays} day${b.keptDays === 1 ? "" : "s"}`;
  const within = span ? `in ${span}. Mason keeps ${days} of history` : `in the last ${days}`;
  const passing = eventsShown(b.events, { failuresOnly, kind, table });
  const narrowed = failuresOnly || kind || table;
  // a table chosen that had none (every added table is a choice, events or not): said by its name
  if (!passing.length && table && !kind) {
    return empty(table === MASON_TABLE ? `No Mason ${failuresOnly ? "failure" : "event"}s ${within}.` : `No ${failuresOnly ? "failure" : "event"}s for ${table} ${within}.`);
  }
  if (!b.events.length) return empty(`No sync ${failuresOnly ? "failure" : "event"} ${within}.`);
  if (!passing.length) {
    return empty(failuresOnly && !kind && !table ? `None of the ${b.events.length} sync event${b.events.length === 1 ? "" : "s"} shown failed.` : `None of the ${n(b.events.length)} sync event${b.events.length === 1 ? "" : "s"} read passes the filters.`);
  }
  const ordered = sort.dir === "asc" ? passing : [...passing].reverse();
  const rows = ordered.slice(0, limit).map((e) => {
    const c = eventCells(e);
    const more = (e.message.includes("\n") ? `<pre>${esc(e.message.split("\n").slice(1).join("\n"))}</pre>` : "") + failureFacts(e);
    return `<tr${e.failed ? ` class="t-failed"` : ""}><th scope="row"><time data-tick datetime="${esc(e.at)}" title="${esc(c.time)} UTC">${esc(agoText(e.at, now))}</time></th><td>${kindBadge(e)}</td>` +
      `<td>${e.table == null ? `<span class="dim">${esc(c.table)}</span>` : `<code class="name" title="${esc(c.table)}">${esc(c.table)}</code>`}</td><td>${esc(c.message)}${more}</td></tr>`;
  }).join("");
  const count = narrowed ? `<p class="dim">${n(passing.length)} of the ${n(b.events.length)} events read.</p>` : "";
  return count + panel(`<table class="events"><thead><tr>${sortTh("events", "time", "When", sort)}${th(["Kind", "Table", "Message"])}</tr></thead><tbody>${rows}</tbody></table>`) +
    moreRows("events", Math.min(limit, passing.length), passing.length, EVENTS_SHOWN);
}

/** EVERY KIND OF SYNC EVENT, in its order (src/duck/events.ts `EVENT_KINDS`, held equal by the tests): the Kind filter
 *  offers each, whether the range has one or not. */
export const EVENT_KINDS = ["copy_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "generated_failed", "compact_failed", "restart", "copied", "recovered", "synced", "sync_changed", "polled", "streamed", "ui_error"];

/** The kind and table filters' controls: EVERY kind (EVENT_KINDS), and EVERY added table (`/api/state` `tables`, `s`) —
 *  Mason's own events first ("Mason events", MASON_TABLE) — whether the range has an event of it or not, so the choices never depend on what
 *  happened to be read; a table only the events name (removed since) and the one chosen are kept too. Written into
 *  their part: the tables follow the state. */
export function renderEventFilters(b, { kind = "", table = "" } = {}, s = null) {
  const events = b?.events ?? [];
  const added = (s?.tables ?? []).filter((t) => t.added).map((t) => t.table);
  const others = [...new Set([...events.map((e) => e.table).filter((t) => t !== null && t !== undefined && !added.includes(t)), ...(table && table !== MASON_TABLE && !added.includes(table) ? [table] : [])])].sort();
  const tables = [MASON_TABLE, ...[...added].sort(), ...others];
  const kinds = [...EVENT_KINDS, ...[...new Set([...events.map((e) => e.kind), ...(kind ? [kind] : [])])].filter((k) => !EVENT_KINDS.includes(k)).sort()];
  const select = (id, label, all, values, chosen, words = (v) => v) => `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}">` +
    `<option value="">${esc(all)}</option>${values.map((v) => `<option value="${esc(v)}"${v === chosen ? " selected" : ""}>${esc(words(v))}</option>`).join("")}</select></div>`;
  return select("syncs-kind", "Kind", "Every kind", kinds, kind, kindWords) +
    select("syncs-table", "Table", "Every table", tables, table, (v) => v === MASON_TABLE ? "Mason events" : v);
}

/** The run's last log entries as a terminal's lines, NEWEST FIRST (the debugging reader wants what just happened); an entry of several lines is one, as written. */
export function renderLogs(b) {
  if (!b.lines.length) return empty("The run has logged nothing yet.");
  return `<div class="terminal" role="log">` +
    [...b.lines].reverse().map((l) => `<div class="log-line"><time>${esc(l.at === null || l.at === undefined ? "" : utcText(l.at))}</time><pre>${esc(l.text)}</pre></div>`).join("") + `</div>` +
    `<p class="dim">The last ${b.lines.length} of the up to ${b.kept} entries Mason keeps here, newest first. <code>mason logs</code> reads the whole log file.</p>`;
}

/** The raw log's details: its summary closed or open, and, open, the entries (or that they are being asked). */
export function renderRawLog(open, inner) {
  return `<details id="syncs-raw"${open ? " open" : ""}><summary>The run's raw log (for debugging)</summary>${open ? inner : ""}</details>`;
}

export const page = {
  id: "syncs",
  hash: VIEW_HASHES.syncs,
  parent: "observability",
  title: "Sync events",
  create(ctx) {
    const m = { rawOpen: false, failuresOnly: false, scheduled: false, kind: "", table: "", sort: { key: "time", dir: "desc" }, limit: EVENTS_SHOWN };
    // the scheduled syncs are read when the box is ticked, or one of their kinds is chosen (else that kind lists none)
    const scheduledRead = () => m.scheduled || SCHEDULED_KINDS.includes(m.kind);
    // FAILURES ONLY IS ASKED OF THE RUN (`failed=1`), never filtered from the newest EVENTS_LIMIT read: the scheduled syncs,
    // one a table a poll, fill 500 rows in minutes, and a failure among them must still be listed
    const events = () => eventsPath(ctx.range(), { scheduled: scheduledRead(), failed: m.failuresOnly });
    const part = (path, render, says) => readPart(ctx, path, render, says);
    const actions = {
      /** The details opened or closed: the log is read from then on, or no longer. */
      async showRawLog(open) {
        m.rawOpen = open === true;
        if (m.rawOpen) await ctx.refresh([LOGS]);
      },
      /** Scheduled syncs ticked or cleared (or a kind chosen that changes what is read): the events read now, from the run. */
      async readEvents() { await ctx.refresh([events()]); },
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
      /** The kind or the table chosen: the events read are filtered in the page alone. "Failures only" and "Scheduled
       *  syncs" (and a kind that changes it) are what the run is asked for: read again now, and written when answered. */
      input(target) {
        if (target?.id === "syncs-failures-only") { m.failuresOnly = target.checked === true; m.limit = EVENTS_SHOWN; return actions.readEvents(); }
        if (target?.id === "syncs-scheduled") { m.scheduled = target.checked === true; m.limit = EVENTS_SHOWN; return actions.readEvents(); }
        if (target?.id === "syncs-kind") {
          const before = scheduledRead();
          m.kind = target.value ?? ""; m.limit = EVENTS_SHOWN;
          return scheduledRead() === before ? true : actions.readEvents();
        }
        if (target?.id === "syncs-table") { m.table = target.value ?? ""; m.limit = EVENTS_SHOWN; return true; }
        return null;
      },
      /** `#observability/syncs?failures=1` (where the Overview's sync errors lead): the failures only, the box ticked;
       *  `?table=<name>` (a table's View events) its events only, the Table filter showing it. */
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
        if (open === m.rawOpen) return target.clicked === true ? true : null;   // a click: the element disagrees, written again
        return actions.showRawLog(open);
      },
    };
  },
};
