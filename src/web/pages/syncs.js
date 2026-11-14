/**
 * THE SYNCS VIEW (#observability/syncs, a view of the Observability group; `#observability/logs`, `#logs` and `#syncs`
 * land here;
 * docs/OBSERVABILITY.md "Pages"): the sync's events (`mason logs --events`) over the time range the Observability views
 * share, as a timeline table NEWEST FIRST (When sorts it the other way; Took by how long a sync took, its own column) — the scheduled syncs that succeeded read only
 * while "Scheduled syncs" is ticked (or one of their kinds chosen: `?scheduled=1`, filtered by the run, so they never
 * take the place of a failure among the newest EVENTS_LIMIT), "Failures only" asked of the run too (`?failed=1`: every
 * failure of the range, whatever else was read), and narrowed in the page alone by a kind and a table (every kind, and every added table from `/api/state`, events or not), at most EVENTS_SHOWN rows written with
 * "Show more" — and, behind a closed details "The run's raw log (for debugging)", the run's last log entries, newest
 * first (`mason logs`: they carry internal tags and absolute paths, so they are not the page's content). EVERY SYNC
 * RUNNING NOW is a row of its own at the top (issue 1011: `runningSyncs`, from `/api/state`, read every 2 s), its time
 * so far ticking in Took, until its event as recorded is read (`settleRunning`). Reads
 * `/api/events` every 10 s (a longer range at its own rate, `rangeEvery`; every 2 s while a sync runs), and `/api/logs` every 5 s ONLY WHILE the
 * details is open (the page's own state: nothing is read when it is closed). A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { VIEW_HASHES } from "../routes.js";
import { esc, agoText, utcText, badge, empty, panel, n, sortTh, sortedBy, nextSort, msText, moreRows, readPart, eventCells, MASON_TABLE, RANGES, DEFAULT_RANGE, rangeOf, rangeEvery, POLL_MS } from "../shared.js";

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
export const KIND_WORDS = { full_sync_failed: "Full sync failed", poll_failed: "Scheduled sync failed", catch_up_failed: "Catch-up failed",
  stream_failed: "Live sync failed", source_unreachable: "Database unreachable", generated_failed: "Generated table failed",
  compact_failed: "Compaction failed", sync_failed: "Manual sync failed", restart: "Mason restarted", full_sync: "Full sync", recovered: "Working again", synced: "Manual sync",
  sync_changed: "Sync setting changed", columns_changed: "Columns changed", polled: "Scheduled sync", streamed: "Live sync", ui_error: "Web page error" };
/** A kind's words; a kind this page does not know, its code. */
export const kindWords = (kind) => Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind] : kind;

/** An event's kind as a badge in words (its code the title): a failure red (with its ✗), a sync done or a failure
 *  recovered green, any other gray. */
const kindBadge = (e) => `<span title="${esc(e.kind)}">${badge(e.failed ? `✗ ${kindWords(e.kind)}` : kindWords(e.kind), e.failed ? "bad" : /^(full_sync|recovered|synced|polled|streamed)$/.test(e.kind) ? "ok" : "")}</span>`;

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

/** HOW LONG A SYNC TOOK, IN A COLUMN OF ITS OWN (issue 1012): the event's `tookMs` in the commands' words (`msText`:
 *  `570 ms`, `7 min 57 s`), and its message without the ` · <took>` it ends with (src/duck/events.ts `tookMs`), so the
 *  time is said once; an event with none (a restart, a failure, one recorded before Mason kept it) has "" and its
 *  message whole. */
export function tookCells(e, message) {
  if (typeof e.tookMs !== "number") return { took: "", message };
  const took = msText(e.tookMs), end = ` · ${took}`;
  return { took, message: message.endsWith(end) ? message.slice(0, -end.length) : message };
}

/**
 * THE SYNCS RUNNING NOW (issue 1011), from `/api/state`: a sync asked by hand (`syncByHand`, `syncing` while it runs
 * or waits for the pass ahead), and the run's own sync of a table (`rebuilding`: `copy` a first sync or a full sync again,
 * whose columns changed when `columnsPending` says so; `catch-up` the one sync of what changed meanwhile that follows
 * it). A row each, its table, its kind in words, a line under "Syncing…" and since when. `ends` are the kinds of event
 * it ends as: the Kind filter keeps it when one of them is chosen, and the page lets it go once one of them is read
 * (`settleRunning`). A scheduled sync running is not said: the state does not carry one, and a poll is over in moments.
 */
export function runningSyncs(s) {
  const out = [];
  for (const t of Array.isArray(s?.tables) ? s.tables : []) {
    if (!t.added) continue;
    const y = t.syncByHand;
    if (y?.state === "syncing") {
      out.push({ key: `hand:${y.id}:${t.table}`, table: t.table, startedAt: y.startedAt, words: KIND_WORDS.synced, note: "", ends: ["synced", "sync_failed"] });
    }
    const r = t.rebuilding;
    if (r && (r.kind === "copy" || r.kind === "catch-up")) {
      const key = `${r.kind}:${t.table}:${r.startedAt}`;
      if (r.kind === "catch-up") {
        out.push({ key, table: t.table, startedAt: r.startedAt, words: "Catch-up", note: "It syncs the rows that changed since its last full sync.", ends: ["catch_up_failed"] });
      } else if (t.copy?.phase === "copying") {
        const share = t.copy.progress?.share;
        out.push({ key, table: t.table, startedAt: r.startedAt, words: "First sync", note: typeof share === "number" ? `${Math.floor(share * 100)}% done.` : "", ends: ["full_sync", "full_sync_failed"] });
      } else if (Array.isArray(t.columnsPending)) {
        out.push({ key, table: t.table, startedAt: r.startedAt, words: KIND_WORDS.full_sync, note: "Its columns changed, so it is synced again whole.", ends: ["full_sync", "full_sync_failed", "columns_changed"] });
      } else {
        out.push({ key, table: t.table, startedAt: r.startedAt, words: KIND_WORDS.full_sync, note: "It is synced again whole.", ends: ["full_sync", "full_sync_failed"] });
      }
    }
  }
  return out;
}

/** How long before a running row the state no longer has is let go, though no event of its end was read: the event
 *  may have been left out (a range, a filter of the run) or never written. Long enough for its event to be read. */
export const HANDOVER_MS = 20_000;

/**
 * THE HAND-OVER FROM A RUNNING ROW TO ITS EVENT: the rows running now (`runningSyncs` of the state just read), and each
 * one shown before that the state no longer has, kept — its time stopped at `ended`, the moment it was first missed —
 * until an event of its end for its table, at or after its start, is among the events read, or HANDOVER_MS passed. So
 * the row never leaves a gap before the event as recorded takes its place.
 */
export function settleRunning(before, now, events, at) {
  const next = new Map(now.map((r) => [r.key, { ...r, ended: null }]));
  for (const [key, r] of before) {
    if (next.has(key)) continue;
    const ended = r.ended ?? at;
    const recorded = (events ?? []).some((e) => e.table === r.table && r.ends.includes(e.kind) && Date.parse(e.at) >= Date.parse(r.startedAt));
    if (!recorded && at - ended < HANDOVER_MS) next.set(key, { ...r, ended });
  }
  return next;
}

/** The running rows that pass the page's filters: none under Failures only (a sync running has not failed); a kind
 *  only when the sync ends as it; a table its own. */
const runningShown = (running, { failuresOnly = false, kind = "", table = "" } = {}) =>
  failuresOnly ? [] : running.filter((r) => (!kind || r.ends.includes(kind)) && (!table || r.table === table));

/** A running sync's row: Now (its start the title), its kind in words, its table, "Syncing…" and its line, and how long
 *  it has run so far in Took (`<time data-tick>`, so only the clock moves at each write). */
function runningRow(r, now) {
  const until = r.ended ?? now;
  const started = utcText(r.startedAt);
  return `<tr class="t-running"><th scope="row"><span title="${esc(`started ${started} UTC`)}">Now</span></th>` +
    `<td><span title="running">${badge(r.words, "warn")}</span></td><td><code class="name" title="${esc(r.table)}">${esc(r.table)}</code></td>` +
    `<td>Syncing…${r.note ? ` <span class="dim">${esc(r.note)}</span>` : ""}</td>` +
    `<td class="num"><time data-tick datetime="${esc(r.startedAt)}" title="${esc(`started ${started} UTC`)}">${esc(msText(until - Date.parse(r.startedAt)))}</time></td></tr>`;
}

/**
 * The sync's events as a timeline, NEWEST FIRST (`sort.dir` "asc": oldest first, as the command lists them): when (how
 * long ago; the UTC time, as the command prints it, is the title), the kind as a badge, the table, the reason's first line
 * and, under it, its further lines and a failure's code and origin (`failureFacts`). `failuresOnly`, `kind` and `table`
 * (the page's filters) keep the events of what was read that pass (`eventsShown`); at most `limit` rows are written.
 * `span` the range's words; `now` the page's clock.
 */
export function renderEvents(b, { failuresOnly = false, kind = "", table = "", now = Date.now(), sort = { key: "time", dir: "desc" }, limit = EVENTS_SHOWN, span = "", running = [] } = {}) {
  const days = `${b.keptDays} day${b.keptDays === 1 ? "" : "s"}`;
  const within = span ? `in ${span}. Mason keeps ${days} of history` : `in the last ${days}`;
  const passing = eventsShown(b.events, { failuresOnly, kind, table });
  const narrowed = failuresOnly || kind || table;
  // the syncs running now, newest of all: first while the list reads newest first, else last
  const live = runningShown(running, { failuresOnly, kind, table });
  if (live.length) return renderTimeline(passing, b.events.length, { narrowed, now, sort, limit, live });
  // a table chosen that had none (every added table is a choice, events or not): said by its name
  if (!passing.length && table && !kind) {
    return empty(table === MASON_TABLE ? `No Mason ${failuresOnly ? "failure" : "event"}s ${within}.` : `No ${failuresOnly ? "failure" : "event"}s for ${table} ${within}.`);
  }
  if (!b.events.length) return empty(`No sync ${failuresOnly ? "failure" : "event"} ${within}.`);
  if (!passing.length) {
    return empty(failuresOnly && !kind && !table ? `None of the ${b.events.length} sync event${b.events.length === 1 ? "" : "s"} shown failed.` : `None of the ${n(b.events.length)} sync event${b.events.length === 1 ? "" : "s"} read passes the filters.`);
  }
  return renderTimeline(passing, b.events.length, { narrowed, now, sort, limit, live });
}

/** The table of the events that pass (`passing`, of `read` read) and the syncs running now (`live`). */
function renderTimeline(passing, read, { narrowed, now, sort, limit, live }) {
  // Took sorts the longest first (an event with none last, whatever the order), newest first among equals
  const ordered = sort.key === "took" ? sortedBy([...passing].reverse(), (e) => typeof e.tookMs === "number" ? e.tookMs : null, sort.dir)
    : sort.dir === "asc" ? passing : [...passing].reverse();
  const rows = ordered.slice(0, limit).map((e) => {
    const c = eventCells(e);
    const t = tookCells(e, c.message);
    const more = (e.message.includes("\n") ? `<pre>${esc(e.message.split("\n").slice(1).join("\n"))}</pre>` : "") + failureFacts(e);
    return `<tr${e.failed ? ` class="t-failed"` : ""}><th scope="row"><time data-tick datetime="${esc(e.at)}" title="${esc(c.time)} UTC">${esc(agoText(e.at, now))}</time></th><td>${kindBadge(e)}</td>` +
      `<td>${e.table == null ? `<span class="dim">${esc(c.table)}</span>` : `<code class="name" title="${esc(c.table)}">${esc(c.table)}</code>`}</td><td>${esc(t.message)}${more}</td><td class="num">${esc(t.took)}</td></tr>`;
  }).join("");
  // the running rows newest first too (the one started last at the top), and the other way round when the list is
  const oldestFirst = sort.key === "time" && sort.dir === "asc";
  const started = [...live].sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
  const liveRows = (oldestFirst ? started.reverse() : started).map((r) => runningRow(r, now)).join("");
  const body = oldestFirst ? rows + liveRows : liveRows + rows;
  const count = narrowed && read > 0 ? `<p class="dim">${n(passing.length)} of the ${n(read)} events read.</p>` : "";
  return count + panel(`<table class="events"><thead><tr>${sortTh("events", "time", "When", sort)}${th(["Kind", "Table", "Message"])}${sortTh("events", "took", "Took", sort, "num")}</tr></thead><tbody>${body}</tbody></table>`) +
    moreRows("events", Math.min(limit, passing.length), passing.length, EVENTS_SHOWN);
}

/** EVERY KIND OF SYNC EVENT, in its order (src/duck/events.ts `EVENT_KINDS`, held equal by the tests): the Kind filter
 *  offers each, whether the range has one or not. */
export const EVENT_KINDS = ["full_sync_failed", "poll_failed", "catch_up_failed", "stream_failed", "source_unreachable", "generated_failed", "compact_failed", "sync_failed", "restart", "full_sync", "recovered", "synced", "sync_changed", "columns_changed", "polled", "streamed", "ui_error"];

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
    const m = { rawOpen: false, failuresOnly: false, scheduled: false, kind: "", table: "", sort: { key: "time", dir: "desc" }, limit: EVENTS_SHOWN,
      // the syncs running now, by key, and those just ended whose event is not read yet (`settleRunning`)
      running: new Map() };
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
      /** When or Took pressed: newest first, or the longest first, then the other way at the next press. */
      sortEvents(key = "time") { m.sort = nextSort(m.sort, key === "took" ? "took" : "time"); },
      showMoreEvents() { m.limit += EVENTS_SHOWN; },
      showAllEvents() { m.limit = Infinity; },
    };
    return {
      model: m,
      // THE STATE AT EVERY POLL: the syncs running now are its (issue 1011), and the Table filter's choices (every added
      // table). While a sync runs, or one just ended waits for its event, the events are read at every poll too, so its
      // row is replaced by its event as recorded within moments
      reads: () => [{ path: events(), everyMs: m.running.size > 0 ? POLL_MS : rangeEvery(ctx.range(), 10_000) }, { path: STATE, everyMs: POLL_MS }, ...(m.rawOpen ? [{ path: LOGS, everyMs: 5000 }] : [])],
      actions,
      /** After each read: the syncs running now from the state, and each one ended handed over to its event (`settleRunning`). */
      afterRead() {
        const s = ctx.read(STATE)?.body;
        if (s === undefined) return;
        m.running = settleRunning(m.running, runningSyncs(s), ctx.read(events())?.body?.events, ctx.now().getTime());
      },
      view: () => ({
        "syncs-filters": renderEventFilters(ctx.read(events())?.body, m, ctx.read(STATE)?.body ?? null),
        "syncs-events": part(events(), (b) => renderEvents(b, { failuresOnly: m.failuresOnly, kind: m.kind, table: m.table, now: ctx.now().getTime(), sort: m.sort, limit: m.limit,
          span: RANGES[ctx.range()]?.span ?? "", running: [...m.running.values()] }), false),
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
        if (d.sortTable === "events") return actions.sortEvents(d.sortKey) ?? true;
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
