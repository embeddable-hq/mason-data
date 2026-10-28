/**
 * THE LOGS PAGE (#logs; docs/OBSERVABILITY.md "Pages"): the sync's events (`mason logs --events`) as a timeline table, newest
 * last (a "Failures only" box narrows what was read, in the page alone), and, behind a closed details "The run's raw log (for debugging)", the run's last log entries (`mason logs`: they
 * carry internal tags and absolute paths, so they are not the page's content). Reads `/api/events` every 10 s, and
 * `/api/logs` every 5 s ONLY WHILE the details is open (the page's own state: nothing is read when it is closed).
 * A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, firstLine, utcText, agoText, renderFailure, badge, empty, panel } from "../shared.js";

export const EVENTS = "/api/events?limit=100";
export const LOGS = "/api/logs?lines=200";

const th = (cols) => `<thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>`;

/** One event's cells as `mason logs --events` says them (src/cli/commands.ts `eventLine`): when, kind, table, the reason's first line. */
export function eventCells(e) {
  return { time: utcText(e.at), kind: e.kind, table: e.table ?? "(the sync)", message: firstLine(e.message) };
}

/** An event's kind as a badge: a failure red (with its ✗), a copy made or a failure recovered green, any other gray. */
const kindBadge = (e) => badge(e.failed ? `✗ ${e.kind}` : e.kind, e.failed ? "bad" : /^(copied|recovered)$/.test(e.kind) ? "ok" : "");

/**
 * The sync's events as a timeline, newest last as the command lists them: when (how long ago; the UTC time, as the
 * command prints it, is the title), the kind as a badge, the table, the reason's first line and, under it, its further
 * lines. `failuresOnly` (the page's toggle) keeps the failures of what was read. `now` is the page's clock.
 */
export function renderEvents(b, { failuresOnly = false, now = Date.now() } = {}) {
  if (!b.events.length) return empty(`No sync event in the last ${b.keptDays} day${b.keptDays === 1 ? "" : "s"} (MASON_REQUEST_LOG_DAYS).`);
  const shown = failuresOnly ? b.events.filter((e) => e.failed) : b.events;
  if (!shown.length) return empty(`None of the ${b.events.length} sync event${b.events.length === 1 ? "" : "s"} shown failed.`);
  return panel(`<table class="events">${th(["When", "Kind", "Table", "Message"])}<tbody>` + shown.map((e) => {
    const c = eventCells(e);
    const more = e.message.includes("\n") ? `<pre>${esc(e.message.split("\n").slice(1).join("\n"))}</pre>` : "";
    return `<tr${e.failed ? ` class="t-failed"` : ""}><th scope="row"><time datetime="${esc(e.at)}" title="${esc(c.time)} UTC">${esc(agoText(e.at, now))}</time></th><td>${kindBadge(e)}</td>` +
      `<td>${c.table.startsWith("(") ? `<span class="dim">${esc(c.table)}</span>` : `<code>${esc(c.table)}</code>`}</td><td>${esc(c.message)}${more}</td></tr>`;
  }).join("") + "</tbody></table>");
}

/** The run's last log entries as a terminal's lines, oldest first so the newest is at the bottom; an entry of several lines is one, as written. */
export function renderLogs(b) {
  if (!b.lines.length) return empty("The run has logged nothing yet.");
  return `<div class="terminal" role="log">` +
    b.lines.map((l) => `<div class="log-line"><time>${esc(l.at === null || l.at === undefined ? "" : utcText(l.at))}</time><pre>${esc(l.text)}</pre></div>`).join("") + `</div>` +
    `<p class="dim">The last ${b.lines.length} of at most ${b.kept} entries the run keeps; <code>mason logs</code> reads the log file.</p>`;
}

/** The raw log's details: its summary closed or open, and, open, the entries (or that they are being asked). */
export function renderRawLog(open, inner) {
  return `<details id="logs-raw"${open ? " open" : ""}><summary>The run's raw log (for debugging)</summary>${open ? inner : ""}</details>`;
}

export const page = {
  id: "logs",
  title: "Logs",
  create(ctx) {
    const m = { rawOpen: false, failuresOnly: false };
    /** A read's body, with its Failure where it shows (the first read's is the banner, so `says` is false for it). */
    const part = (path, render, says) => {
      const r = ctx.read(path);
      if (r === undefined) return `<p class="dim">Asking Mason…</p>`;
      return (r.failure && says ? renderFailure(r.failure) : "") + (r.body === undefined ? "" : render(r.body));
    };
    const actions = {
      /** The details opened or closed: the log is read from then on, or no longer. */
      async showRawLog(open) {
        m.rawOpen = open === true;
        if (m.rawOpen) await ctx.refresh([LOGS]);
      },
    };
    return {
      model: m,
      reads: () => [{ path: EVENTS, everyMs: 10_000 }, ...(m.rawOpen ? [{ path: LOGS, everyMs: 5000 }] : [])],
      actions,
      view: () => ({ "logs-events": part(EVENTS, (b) => renderEvents(b, { failuresOnly: m.failuresOnly, now: ctx.now().getTime() }), false), "logs-run": renderRawLog(m.rawOpen, m.rawOpen ? part(LOGS, renderLogs, true) : "") }),
      /** The "Failures only" box ticked or cleared: the events read are filtered in the page alone (the toggle is outside the part a poll writes). */
      input(target) {
        if (target?.id !== "logs-failures-only") return null;
        m.failuresOnly = target.checked === true;
        return true;
      },
      /** A details of this section opened or closed (the shell listens to `toggle`): null when it is not the raw log's. */
      toggle(target) {
        if (target.id !== "logs-raw") return null;
        const open = target.open === true;
        if (open === m.rawOpen) return null;
        return actions.showRawLog(open);
      },
    };
  },
};
