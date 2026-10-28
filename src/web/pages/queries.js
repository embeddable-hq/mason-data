/**
 * THE QUERIES PAGE (#queries): who is connected now (`/api/state` `sessions`), the statements running now (`mason logs --running`, GET /api/running) with a Cancel that
 * asks first (`mason cancel`, POST /api/cancel), and the request log (`mason logs --requests`, GET /api/requests) as a
 * table, filtered by status, time, user and client, and paged back by Older. The words are the commands': a running
 * statement's "N rows sent" and its client, a request's duration in ms, its error, the empty log's sentence.
 */
import { bytesText, esc, firstLine, json, n, renderFailure, rowsHtml, spanText, utcText, details, createOpenSet } from "../shared.js";

const RUNNING = "/api/running";
const STATE = "/api/state";
const NEWEST_EVERY_MS = 5000;
const NO_CLIENT = "(no application_name)";

/** A statement on one line, as mason logs says it (src/cli/commands.ts `oneLine`): whitespace collapsed, cut with an ellipsis. */
export const oneLine = (sql, max = 120) => {
  const line = String(sql ?? "").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};
/** A statement as a cell: one line, truncated by the page's stylesheet as well, the whole of it as its title. */
const statementCell = (query) => query === "" ? `<span class="dim">(no statement)</span>` : `<code class="stmt" title="${esc(query)}">${esc(oneLine(query))}</code>`;
const plural = (count, word) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;
/** The key a running statement is asked about by: its session and its statement's number. */
const keyOf = (session, statement) => `${session}:${statement}`;

/** How a statement's client is said (src/cli/commands.ts `runningLine`): its application_name, else the note. */
export const clientText = (applicationName) => applicationName || NO_CLIENT;

/** What a cancel answered, as `mason cancel` says it: its headline, or the refusal as the Failure. */
function outcomeHtml(o) {
  if (o.failure) return renderFailure(o.failure);
  return `<p class="done" role="status"><span class="headline">Cancelled session ${o.cancelled.session}'s statement: it ends now, and its client is told so (57014).</span></p>`;
}

/**
 * WHO IS CONNECTED NOW (`/api/state` `sessions`: { open, byClient: [{ user, client, open, running }] } or { error }): a row
 * per user and client — the sessions it has open and the statements it is running. "" when the run did not say.
 */
export function renderSessions(sessions) {
  if (!sessions) return "";
  if ("error" in sessions) return `<p class="count">Who is connected could not be read (${esc(firstLine(String(sessions.error)))})</p>`;
  if (!sessions.byClient.length) return `<p class="dim">No client is connected now.</p>`;
  return `<table class="sessions"><thead><tr><th scope="col">User</th><th scope="col">Client</th><th scope="col">Open</th><th scope="col">Running</th></tr></thead><tbody>` +
    sessions.byClient.map((c) => `<tr><td>${esc(c.user || "(no user)")}</td><td>${esc(clientText(c.client))}</td><td class="num">${esc(n(c.open))}</td><td class="num">${esc(n(c.running))}</td></tr>`).join("") +
    `</tbody></table><p class="dim">${esc(n(sessions.open))} session${sessions.open === 1 ? "" : "s"} open.</p>`;
}

/**
 * THE STATEMENTS RUNNING NOW (`mason logs --running --json`'s `running`): a row each — session, statement, user, client,
 * when it started, how long it has run, the rows sent so far, the statement — and Cancel. The one being cancelled
 * (`asking`, `session:statement`) asks first; `outcome` is what the last cancel answered (a Failure, or `{ cancelled }`),
 * said under the row it was for, or under the table when that statement has ended since.
 */
export function renderRunning(running, asking = null, outcome = null) {
  let shown = false;
  const answer = (r) => {
    if (outcome === null || outcome.key !== keyOf(r.session, r.statement)) return "";
    shown = true;
    return `<tr class="under"><td colspan="9">${outcomeHtml(outcome)}</td></tr>`;
  };
  const rows = running.map((r) => {
    const key = keyOf(r.session, r.statement);
    return `<tr><td>${r.session}</td><td>${r.statement}</td><td>${esc(r.user)}</td><td>${esc(clientText(r.applicationName))}</td>` +
      `<td>${esc(utcText(r.startedAt))}</td><td class="num">${esc(spanText(r.runningMs / 1000))}</td><td class="num">${esc(plural(r.rows, "row"))} sent</td>` +
      `<td>${statementCell(r.query)}</td><td class="act">${asking === key
        ? `<span class="confirm">Cancel session ${r.session}'s statement ${r.statement}? Its client is told so (57014).</span> ` +
          `<button type="button" class="danger" data-confirm-cancel="${esc(key)}">Cancel statement ${r.statement}</button> <button type="button" data-dismiss-cancel>Keep it running</button>`
        : `<button type="button" data-ask-cancel="${esc(key)}">Cancel</button>`}</td></tr>${answer(r)}`;
  }).join("");
  const table = running.length
    ? `<p class="count">Running now (${running.length}):</p><div class="scroll"><table class="running"><thead><tr><th scope="col">Session</th><th scope="col">Statement</th><th scope="col">User</th><th scope="col">Client</th>` +
      `<th scope="col">Started (UTC)</th><th scope="col">Running for</th><th scope="col">Rows</th><th scope="col">Statement text</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="dim">No statement is running now.</p>`;
  return table + (!shown && outcome !== null ? outcomeHtml(outcome) : "");
}

/** The status column's word: the ledger's `status` (completed, failed, cancelled), capitalised. */
const STATUS = { completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

/**
 * THE REQUEST LOG (`mason logs --requests --json`'s shape: { requests, keptDays, before }), newest first (the command
 * prints the oldest of the page first; a table reads the other way): the id's first 8 characters, started, duration,
 * status, user, client, rows, the statement and its error's first line; each row's details hold the whole id, when it
 * ended, the bytes sent, the whole statement and the whole error. **Older** when the page has an older one (`before`), **Newest** when the
 * page shown is not the newest. `filtered`: the empty sentence names the filters, as the command's does.
 */
export function renderRequests(page, { paged = false, filtered = false, isOpen = () => false } = {}) {
  const older = page.before !== null && page.before !== undefined;
  const nav = paged || older ? `<p class="paging">${paged ? `<button type="button" data-newest>Newest</button> ` : ""}${older ? `<button type="button" data-older>Older</button>` : ""}</p>` : "";
  if (!page.requests.length) {
    return `<p class="dim">No ${filtered ? "request that passes the filters" : "request"} in the last ${page.keptDays} day${page.keptDays === 1 ? "" : "s"} (MASON_REQUEST_LOG_DAYS).</p>${nav}`;
  }
  const rows = [...page.requests].reverse().map((r) => {
    const error = r.sqlstate === null && !r.message ? "" : `<code>${esc(r.sqlstate ?? "")}</code> <span title="${esc(r.message ?? "")}">${esc(firstLine(r.message ?? ""))}</span>`;
    // the rest of a request is in its row's details: the whole id, when it ended, the bytes sent, the whole statement and error
    // keyed by the request's id: a poll rewrites the log, and an open one stays open
    const more = details(`request:${r.requestId}`, "More", `${rowsHtml([["Query id", r.requestId], ["Ended (UTC)", utcText(r.endedAt)], ["Bytes sent", r.bytesSent === null ? "" : bytesText(r.bytesSent)]])}` +
      `<pre class="stmt">${esc(r.query || "(no statement)")}</pre>${r.message ? `<pre class="error">${esc(r.sqlstate ? `${r.sqlstate} ` : "")}${esc(r.message)}</pre>` : ""}`, isOpen(`request:${r.requestId}`));
    return `<tr class="s-${esc(r.status)}"><td><code title="${esc(r.requestId)}">${esc(r.requestId.slice(0, 8))}</code></td><td>${esc(utcText(r.startedAt))}</td>` +
      `<td class="num">${esc(n(r.durationMs))} ms</td><td class="status">${esc(STATUS[r.status] ?? r.status)}</td>` +
      `<td>${esc(r.user || (r.tokenName ? `token ${r.tokenName}` : ""))}</td><td>${esc(clientText(r.applicationName))}</td>` +
      `<td class="num">${r.rows === null ? "" : esc(plural(r.rows, "row"))}</td>` +
      `<td>${statementCell(r.query)}</td><td>${error}</td><td>${more}</td></tr>`;
  }).join("");
  return `<div class="scroll"><table class="requests"><thead><tr><th scope="col">Query id</th><th scope="col">Started (UTC)</th><th scope="col">Duration</th>` +
    `<th scope="col">Status</th><th scope="col">User</th><th scope="col">Client</th><th scope="col">Rows</th><th scope="col">Statement</th><th scope="col">Error</th><th scope="col"></th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>${nav}`;
}

/** The status filter's choices as the server's `outcome` list (src/api/request-log.ts): Completed is ok, Failed is the
 *  statement's own fault and Mason's (refused, failed), Cancelled is a cancel or a timeout (57014). */
const STATUS_OUTCOMES = { completed: "ok", failed: "refused,failed", cancelled: "cancelled" };

/** The path of one view of the request log: its filters as the server reads them (it judges since), and the cursor of an older page. */
export function requestsPath(filters, before) {
  const p = new URLSearchParams();
  if (STATUS_OUTCOMES[filters.status]) p.set("outcome", STATUS_OUTCOMES[filters.status]);
  for (const k of ["since", "user", "client"]) if (filters[k]) p.set(k, filters[k]);
  if (before) p.set("before", before);
  const q = p.toString();
  return q ? `/api/requests?${q}` : "/api/requests";
}

export const page = {
  id: "queries",
  title: "Queries",
  create(ctx) {
    // the request rows' details open, by request id (createOpenSet): they stay open across a poll
    const opened = createOpenSet();
    const m = { filters: { status: "", since: "", user: "", client: "" }, before: null, asking: null, outcome: null, open: opened.open };
    const path = () => requestsPath(m.filters, m.before);
    const filtered = () => Object.values(m.filters).some((v) => v !== "");
    const actions = {
      askCancelStatement(session, statement) { m.asking = keyOf(session, statement); m.outcome = null; },
      dismissCancelStatement() { m.asking = null; },
      /** POST /api/cancel { session, statement }: the statement listed, never the one the session runs next (409). */
      async confirmCancelStatement(session, statement) {
        const r = await ctx.ask("/api/cancel", json("POST", { session, statement }));
        m.asking = null;
        m.outcome = "failure" in r ? { key: keyOf(session, statement), failure: r.failure } : { key: keyOf(session, statement), cancelled: r.body.cancelled };
        await ctx.refresh([RUNNING]);
        return !("failure" in r);
      },
      /** Show the requests that pass these filters, from the newest. */
      async filterRequests(filters) {
        m.filters = { status: "", since: "", user: "", client: "", ...filters };
        m.before = null;
        await ctx.refresh([path()]);
      },
      /** The page before this one: the cursor the page shown answered with. Not read again while shown. */
      async olderRequests() {
        const before = ctx.read(path())?.body?.before;
        if (typeof before !== "string") return;
        m.before = before;
        await ctx.refresh([path()]);
      },
      async newestRequests() {
        m.before = null;
        await ctx.refresh([path()]);
      },
    };
    return {
      model: m,
      // the running statements every poll; the newest page of the log every 5 s, an older one only when first asked
      // (and who is connected, from the state, every 5 s)
      reads: () => [{ path: RUNNING, everyMs: 2000 }, { path: path(), everyMs: m.before === null ? NEWEST_EVERY_MS : Infinity }, { path: STATE, everyMs: NEWEST_EVERY_MS }],
      afterRead() {
        // a statement that ended since it was asked about has nothing left to cancel
        const r = ctx.read(RUNNING)?.body?.running;
        if (m.asking !== null && r && !r.some((x) => keyOf(x.session, x.statement) === m.asking)) m.asking = null;
      },
      actions,
      view() {
        const running = ctx.read(RUNNING)?.body;
        const log = ctx.read(path());
        return {
          "connected-now": renderSessions(ctx.read(STATE)?.body?.sessions),
          "running-now": running ? renderRunning(running.running, m.asking, m.outcome) : "",
          "request-log": (log?.failure ? renderFailure(log.failure) : "") + (log?.body ? renderRequests(log.body, { paged: m.before !== null, filtered: filtered(), isOpen: opened.has }) : ""),
        };
      },
      toggle: (target) => opened.toggle(target),
      submit(form) {
        if (form.id !== "request-filters") return null;
        const value = (k) => form.elements[k]?.value?.trim() ?? "";
        return actions.filterRequests({ status: value("status"), since: value("since"), user: value("user"), client: value("client") });
      },
      click(d, _button, { doc }) {
        const pair = (v) => v.split(":").map(Number);
        if (d.askCancel !== undefined) return actions.askCancelStatement(...pair(d.askCancel)) ?? true;
        if (d.dismissCancel !== undefined) return actions.dismissCancelStatement() ?? true;
        if (d.confirmCancel !== undefined) return actions.confirmCancelStatement(...pair(d.confirmCancel));
        if (d.older !== undefined) return actions.olderRequests();
        if (d.newest !== undefined) return actions.newestRequests();
        if (d.clearFilters !== undefined) { doc.getElementById("request-filters")?.reset?.(); return actions.filterRequests({}); }
        return null;
      },
    };
  },
};
