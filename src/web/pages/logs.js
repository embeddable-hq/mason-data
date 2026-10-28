/**
 * THE LOGS PAGE (#logs; docs/OBSERVABILITY.md "Pages"): the sync's events (`mason logs --events`) as a plain table, newest
 * last, and, behind a closed details "The run's raw log (for debugging)", the run's last log entries (`mason logs`: they
 * carry internal tags and absolute paths, so they are not the page's content). Reads `/api/events` every 10 s, and
 * `/api/logs` every 5 s ONLY WHILE the details is open (the page's own state: nothing is read when it is closed).
 * A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, firstLine, utcText, renderFailure } from "../shared.js";

export const EVENTS = "/api/events?limit=100";
export const LOGS = "/api/logs?lines=200";

const th = (cols) => `<thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>`;

/** One event's cells as `mason logs --events` says them (src/cli/commands.ts `eventLine`): when, kind, table, the reason's first line. */
export function eventCells(e) {
  return { time: utcText(e.at), kind: e.kind, table: e.table ?? "(the sync)", message: firstLine(e.message) };
}

/** The sync's events, newest last; a failure marked, a reason's further lines under its first. */
export function renderEvents(b) {
  if (!b.events.length) return `<p>No sync event in the last ${b.keptDays} day${b.keptDays === 1 ? "" : "s"} (MASON_REQUEST_LOG_DAYS).</p>`;
  return `<table class="events">${th(["Time (UTC)", "Kind", "Table", "Message"])}<tbody>` + b.events.map((e) => {
    const c = eventCells(e);
    const more = e.message.includes("\n") ? `<pre>${esc(e.message.split("\n").slice(1).join("\n"))}</pre>` : "";
    const kind = e.failed ? `<span class="mark" aria-hidden="true">✗</span> ${esc(c.kind)} <span class="what">(failed)</span>` : esc(c.kind);
    return `<tr${e.failed ? ` class="t-failed"` : ""}><th scope="row">${esc(c.time)}</th><td>${kind}</td><td>${esc(c.table)}</td><td>${esc(c.message)}${more}</td></tr>`;
  }).join("") + "</tbody></table>";
}

/** The run's last log entries, oldest first so the newest is at the bottom; an entry of several lines is one row, as written. */
export function renderLogs(b) {
  if (!b.lines.length) return `<p>The run has logged nothing yet.</p>`;
  return `<table class="log">${th(["Time (UTC)", "Entry"])}<tbody>` +
    b.lines.map((l) => `<tr><th scope="row">${esc(l.at === null || l.at === undefined ? "" : utcText(l.at))}</th><td><pre>${esc(l.text)}</pre></td></tr>`).join("") + "</tbody></table>" +
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
    const m = { rawOpen: false };
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
      view: () => ({ "logs-events": part(EVENTS, renderEvents, false), "logs-run": renderRawLog(m.rawOpen, m.rawOpen ? part(LOGS, renderLogs, true) : "") }),
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
