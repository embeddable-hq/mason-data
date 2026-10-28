/**
 * THE QUERIES VIEW (#observability/queries, a sub-tab of Observability; `#queries`, its old address, lands here): KPI cards (the sessions open, the statements running, the last day's statements, failed ones
 * and p95), then who is connected now (`/api/state` `sessions`), the statements running now (`mason logs --running`, GET /api/running) with a Cancel that
 * asks first (`mason cancel`, POST /api/cancel), and the request log (`mason logs --requests`, GET /api/requests) as a
 * table (a status dot and word, each row expanding in place and staying open across polls), newest first, filtered by
 * status, slow (SLOW_MS or more), a piece of the statement's text, since, user and client — since is the shared time
 * range unless the filter names its own — and paged back by Older; Started, Duration and Rows sort the page shown (the
 * pages follow the log's order by start: a sort of the whole log would need a cursor per order). A statement is one or
 * two lines in its cell, its title at most TITLE_MAX characters, and its expanded row the first STATEMENT_MAX of it. The words are the commands': a running
 * statement's "N rows sent" and its client, a request's duration in ms, its error, the empty log's sentence.
 */
import { agoText, bytesText, esc, firstLine, json, n, renderFailure, rowsHtml, spanText, utcText, details, createOpenSet, card, cards, empty, panel, status, skeleton,
  clip, capped, TITLE_MAX, sortTh, sortedBy, nextSort, RANGES, DEFAULT_RANGE } from "../shared.js";

const RUNNING = "/api/running";
const STATE = "/api/state";
/** The request log's summary (the Status page's read too): the last day's statements, for the cards. */
const QUERIES = "/api/queries";
const QUERIES_EVERY_MS = 30_000;
const NEWEST_EVERY_MS = 5000;
const NO_CLIENT = "(no application_name)";
/** Who is connected: the clients with the most sessions open, this many; the rest in one row. */
export const SESSIONS_TOP = 10;
/** The most of a statement (or an error) an expanded row writes, in characters. */
export const STATEMENT_MAX = 16 * 1024;

/** A statement on one line, as mason logs says it (src/cli/commands.ts `oneLine`): whitespace collapsed, cut with an ellipsis. */
export const oneLine = (sql, max = 120) => {
  const line = String(sql ?? "").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};
/** A statement as a cell: one line, truncated by the page's stylesheet as well, the whole of it as its title. */
const statementCell = (query) => query === "" ? `<span class="dim">(no statement)</span>` : `<code class="stmt" title="${esc(clip(query, TITLE_MAX))}">${esc(oneLine(query))}</code>`;
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
export function renderSessions(sessions, top = SESSIONS_TOP) {
  if (!sessions) return "";
  if ("error" in sessions) return `<p class="count">Who is connected could not be read (${esc(firstLine(String(sessions.error)))})</p>`;
  if (!sessions.byClient.length) return empty("No client is connected now.");
  // the clients with the most sessions first; past `top`, the others in one row (200 clients are not 200 rows)
  const byOpen = sortedBy(sessions.byClient, (c) => c.open * 1e6 + c.running, "desc");
  const shown = byOpen.slice(0, top), rest = byOpen.slice(top);
  const sum = (list, k) => list.reduce((a, c) => a + c[k], 0);
  const others = rest.length ? `<tr class="others"><td colspan="2">${esc(n(rest.length))} other client${rest.length === 1 ? "" : "s"}</td><td class="num">${esc(n(sum(rest, "open")))}</td><td class="num">${esc(n(sum(rest, "running")))}</td></tr>` : "";
  const cell = (v) => `<td><span class="clip" title="${esc(v)}">${esc(v)}</span></td>`;
  return panel(`<table class="sessions"><thead><tr><th scope="col">User</th><th scope="col">Client</th><th scope="col" class="num">Open</th><th scope="col" class="num">Running</th></tr></thead><tbody>` +
    shown.map((c) => `<tr>${cell(c.user || "(no user)")}${cell(clientText(c.client))}<td class="num">${esc(n(c.open))}</td><td class="num">${esc(n(c.running))}</td></tr>`).join("") + others +
    `</tbody></table>`) + `<p class="dim">${esc(n(sessions.open))} session${sessions.open === 1 ? "" : "s"} open${rest.length ? `, from ${esc(n(byOpen.length))} clients` : ""}.</p>`;
}

/**
 * THE KPI CARDS over the page: who is connected (`/api/state` `sessions`), the statements running now, and the last day's
 * statements, the failed ones and the p95 from the request log (`statementCards`). `queries` is `/api/queries`' body or
 * `{ failure }`; an argument the run did not say draws no card, one it could not read is `unknown` with its reason.
 */
export function renderQueryKpis(sessions, running, queries, range = DEFAULT_RANGE) {
  const list = [];
  if (sessions) {
    if ("error" in sessions) list.push(card("Connected sessions", "unknown", firstLine(String(sessions.error))));
    else list.push(card("Connected sessions", n(sessions.open), plural(sessions.byClient.length, "client")));
  }
  if (running) list.push(card("Running now", n(running.length), running.length ? `the longest for ${spanText(Math.max(...running.map((r) => r.runningMs)) / 1000)}` : "no statement is running"));
  if (queries) {
    const w = summaryWindow(range);
    if ("failure" in queries) list.push(card(`Statements, ${w.label}`, "unknown", `could not read them: ${firstLine(queries.failure.message)}`));
    else list.push(...statementCards(queries.queries[w.key], () => "", w.label));
  }
  return cards(list);
}

/**
 * THE LAST DAY'S THREE CARDS from the request log's summary (`day`: a window of `/api/queries`): the statements, the failed
 * ones (the log's Failed: refused or failed; its sub-line names each and the cancelled) and the completed ones' p95.
 * `line(key)` is a card's sparkline holder (the Usage page draws them; "" for none): ONE place derives these facts.
 */
/** The window of the request log's summary a range's cards say: the week for 7 days, else the day (the summary has no
 *  hour: the cards of the last hour say the last 24 hours, by name). */
export const summaryWindow = (range) => range === "7d" ? { key: "week", label: "last 7 days" } : { key: "day", label: "last 24 hours" };

export function statementCards(day, line = () => "", label = "last 24 hours") {
  const failed = day.refused + day.failed;
  return [
    card(`Statements, ${label}`, n(day.statements), `${n(day.completed)} completed`, line("statements")),
    card(`Failed, ${label}`, n(failed), `${n(day.refused)} refused, ${n(day.failed)} failed${day.cancelled ? `, ${n(day.cancelled)} cancelled` : ""}`, line("failed"), failed ? "warn" : ""),
    card(`p95, ${label}`, day.durationMs === null ? "–" : `${n(day.durationMs.p95)} ms`,
      day.durationMs === null ? "no statement completed" : `average ${n(day.durationMs.avg)} ms · p50 ${n(day.durationMs.p50)} ms`, line("p95")),
  ];
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
          `<button type="button" class="danger small" data-confirm-cancel="${esc(key)}">Cancel statement ${r.statement}</button> <button type="button" class="small" data-dismiss-cancel>Keep it running</button>`
        : `<button type="button" class="danger small" data-ask-cancel="${esc(key)}">Cancel</button>`}</td></tr>${answer(r)}`;
  }).join("");
  const table = running.length
    ? `<p class="table-title">Running now (${running.length}):</p><div class="scroll"><table class="running"><thead><tr><th scope="col">Session</th><th scope="col">Statement</th><th scope="col">User</th><th scope="col">Client</th>` +
      `<th scope="col">Started (UTC)</th><th scope="col">Running for</th><th scope="col">Rows</th><th scope="col">Statement text</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : empty("No statement is running now.");
  return table + (!shown && outcome !== null ? outcomeHtml(outcome) : "");
}

/** The status column's word: the ledger's `status` (completed, failed, cancelled), capitalised; its dot says the same (ok, bad, warn). */
const STATUS = { completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

/** The columns of the request log's table: its details row spans them all; the sortable ones by their sort key. */
const REQUEST_COLUMNS = [["Status"], ["Query id"], ["Started", "started"], ["Duration", "duration", "num"], ["User"], ["Client"], ["Rows", "rows", "num"], ["Statement"]];
/** What each sortable column sorts by. */
const REQUEST_SORTS = { started: (r) => Date.parse(r.startedAt), duration: (r) => r.durationMs, rows: (r) => r.rows };
/** The request log's order unless a header is clicked: newest first. */
export const NEWEST_FIRST = { key: "started", dir: "desc" };

/**
 * THE REQUEST LOG (`mason logs --requests --json`'s shape: { requests, keptDays, before }), newest first (the command
 * prints the oldest of the page first; a table reads the other way): a dot and the status word, the id's first 8
 * characters, when it started (how long ago; the UTC time is its title and in its details), the duration, user, client,
 * rows, and the statement (cut to a line, at most two in the cell, at most TITLE_MAX characters its title) over its
 * error's first line. Each row EXPANDS (its id is the toggle: a `details` keyed by the request's id, `isOpen` the page's
 * open set, so a poll that rewrites the log keeps it open) into the whole id, when it started and ended, the bytes sent,
 * the statement and the error — each the first STATEMENT_MAX characters, and said so when cut. `sort` ({ key, dir }:
 * started, duration or rows) orders the page shown, said under it when it is not the newest first. **Older** when the
 * page has an older one (`before`), **Newest** when the page shown is not the newest. `filtered`: the empty sentence
 * names the filters, as the command's does; `span` the range's words (the empty log's). `now` is the page's clock.
 */
export function renderRequests(page, { paged = false, filtered = false, isOpen = () => false, now = Date.now(), sort = NEWEST_FIRST, span = "" } = {}) {
  const older = page.before !== null && page.before !== undefined;
  const nav = paged || older ? `<div class="paging">${paged ? `<button type="button" data-newest>Newest</button>` : ""}${older ? `<button type="button" data-older>Older</button>` : ""}</div>` : "";
  if (!page.requests.length) {
    const days = `${page.keptDays} day${page.keptDays === 1 ? "" : "s"}`;
    return empty(`No ${filtered ? "request that passes the filters" : "request"} ${span ? `in ${span} (the request log keeps ${days}: MASON_REQUEST_LOG_DAYS)` : `in the last ${days} (MASON_REQUEST_LOG_DAYS)`}.`) + nav;
  }
  const newest = [...page.requests].reverse();
  const list = sort.key === "started" && sort.dir === "desc" ? newest : sortedBy(newest, REQUEST_SORTS[sort.key] ?? REQUEST_SORTS.started, sort.dir);
  const rows = list.map((r) => {
    const key = `request:${r.requestId}`;
    const open = isOpen(key);
    const error = r.sqlstate === null && !r.message ? "" : `<div class="err"><code>${esc(r.sqlstate ?? "")}</code> <span title="${esc(clip(r.message ?? "", TITLE_MAX))}">${esc(clip(firstLine(r.message ?? ""), 300))}</span></div>`;
    const row = `<tr class="s-${esc(r.status)}"><td>${status(undefined, STATUS[r.status] ?? r.status)}</td>` +
      `<td class="id">${details(key, r.requestId.slice(0, 8), "", open)}</td>` +
      `<td class="when"><time datetime="${esc(r.startedAt)}" title="${esc(utcText(r.startedAt))} UTC">${esc(agoText(r.startedAt, now))}</time></td>` +
      `<td class="num">${esc(n(r.durationMs))} ms</td><td><span class="clip" title="${esc(r.user || r.tokenName)}">${esc(r.user || (r.tokenName ? `token ${r.tokenName}` : ""))}</span></td>` +
      `<td><span class="clip" title="${esc(clientText(r.applicationName))}">${esc(clientText(r.applicationName))}</span></td>` +
      `<td class="num">${r.rows === null ? "" : esc(n(r.rows))}</td><td class="stmt-cell">${statementCell(r.query)}${error}</td></tr>`;
    // the rest of a request is its expanded row: the whole id, when it started and ended, the bytes sent, the statement and error (each capped)
    const stmt = capped(r.query || "(no statement)", STATEMENT_MAX, "mason logs --requests --json");
    const err = capped(r.message ?? "", STATEMENT_MAX, "mason logs --requests --json");
    const more = open ? `<tr class="detail"><td colspan="${REQUEST_COLUMNS.length}">${rowsHtml([["Query id", r.requestId], ["Started (UTC)", utcText(r.startedAt)], ["Ended (UTC)", utcText(r.endedAt)], ["Bytes sent", r.bytesSent === null ? "" : bytesText(r.bytesSent)]])}` +
      `<pre class="stmt">${esc(stmt.text)}</pre>${stmt.cut ? `<p class="dim cut">${esc(stmt.cut)}${r.queryTruncated ? " (as the log kept it)" : ""}</p>` : r.queryTruncated ? `<p class="dim cut">the request log kept the statement cut</p>` : ""}` +
      `${r.message ? `<pre class="error">${esc(r.sqlstate ? `${r.sqlstate} ` : "")}${esc(err.text)}</pre>${err.cut ? `<p class="dim cut">${esc(err.cut)}</p>` : ""}` : ""}</td></tr>` : "";
    return row + more;
  }).join("");
  const sortNote = sort.key === "started" && sort.dir === "desc" ? ""
    : `<p class="dim sort-note">Sorted by ${esc(sort.key === "started" ? "start" : sort.key)}, ${sort.dir === "asc" ? "lowest" : "highest"} first, within the ${n(page.requests.length)} rows of this page: Older and Newest page by start time.</p>`;
  return `<div class="scroll"><table class="requests"><thead><tr>${REQUEST_COLUMNS.map(([c, key, cls]) => key ? sortTh("requests", key, c, sort, cls) : `<th scope="col">${c}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>${sortNote}${nav}`;
}

/** The status filter's choices as the server's `outcome` list (src/api/request-log.ts): Completed is ok, Failed is the
 *  statement's own fault and Mason's (refused, failed), Cancelled is a cancel or a timeout (57014). */
const STATUS_OUTCOMES = { completed: "ok", failed: "refused,failed", cancelled: "cancelled" };

/** The filters as they are before any is set. */
export const NO_FILTERS = { status: "", since: "", user: "", client: "", slow: false, search: "" };

/** The path of one view of the request log: its filters as the server reads them (it judges since and search), since the
 *  range's (`range`, a key of RANGES) unless the filter names its own, and the cursor of an older page. */
export function requestsPath(filters, before, range = DEFAULT_RANGE) {
  const p = new URLSearchParams();
  if (STATUS_OUTCOMES[filters.status]) p.set("outcome", STATUS_OUTCOMES[filters.status]);
  p.set("since", filters.since || (RANGES[range] ?? RANGES[DEFAULT_RANGE]).since);
  for (const k of ["user", "client"]) if (filters[k]) p.set(k, filters[k]);
  if (filters.slow) p.set("slow", "1");
  if (filters.search) p.set("search", filters.search);
  if (before) p.set("before", before);
  return `/api/requests?${p.toString()}`;
}

export const page = {
  id: "queries",
  hash: "observability/queries",
  parent: "observability",
  title: "Queries",
  create(ctx) {
    // the request rows' details open, by request id (createOpenSet): they stay open across a poll
    const opened = createOpenSet();
    const m = { filters: { ...NO_FILTERS }, before: null, asking: null, outcome: null, open: opened.open, sort: NEWEST_FIRST };
    const path = () => requestsPath(m.filters, m.before, ctx.range());
    const filtered = () => Object.values(m.filters).some((v) => v !== "" && v !== false);
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
        m.filters = { ...NO_FILTERS, ...filters };
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
      /** A sortable header clicked: the page shown in that order (the same column again turns it round). */
      sortRequests(key) { m.sort = nextSort(m.sort, key, "desc"); },
    };
    return {
      model: m,
      // the running statements every poll; the newest page of the log every 5 s, an older one only when first asked
      // (and who is connected, from the state, every 5 s; the last day's summary for the cards every 30 s)
      reads: () => [{ path: RUNNING, everyMs: 2000 }, { path: path(), everyMs: m.before === null ? NEWEST_EVERY_MS : Infinity }, { path: STATE, everyMs: NEWEST_EVERY_MS },
        { path: QUERIES, everyMs: QUERIES_EVERY_MS }],
      afterRead() {
        // a statement that ended since it was asked about has nothing left to cancel
        const r = ctx.read(RUNNING)?.body?.running;
        if (m.asking !== null && r && !r.some((x) => keyOf(x.session, x.statement) === m.asking)) m.asking = null;
      },
      actions,
      view() {
        const running = ctx.read(RUNNING)?.body;
        const log = ctx.read(path());
        const q = ctx.read(QUERIES);
        const sessions = ctx.read(STATE)?.body?.sessions;
        return {
          "queries-kpis": !running && !sessions && !q ? skeleton(2) : renderQueryKpis(sessions, running?.running, q === undefined ? undefined : q.body ? q.body : { failure: q.failure }, ctx.range()),
          "connected-now": renderSessions(ctx.read(STATE)?.body?.sessions),
          "running-now": running ? renderRunning(running.running, m.asking, m.outcome) : "",
          "request-log": (log?.failure ? renderFailure(log.failure) : "") + (log?.body ? renderRequests(log.body, { paged: m.before !== null, filtered: filtered(), isOpen: opened.has, now: ctx.now().getTime(), sort: m.sort,
            span: m.filters.since ? "" : (RANGES[ctx.range()] ?? RANGES[DEFAULT_RANGE]).span }) : ""),
        };
      },
      toggle: (target) => opened.toggle(target),
      submit(form) {
        if (form.id !== "request-filters") return null;
        const value = (k) => form.elements[k]?.value?.trim() ?? "";
        return actions.filterRequests({ status: value("status"), since: value("since"), user: value("user"), client: value("client"), slow: form.elements.slow?.checked === true, search: value("search") });
      },
      /** `#observability/queries?slow=1`, `?status=failed` (where the Overview's cards lead): those filters, from the newest,
       *  and the form's controls showing them. Nothing to do for a hash without them (a change of range keeps the filters). */
      route(params, { doc } = {}) {
        if (params.slow === undefined && params.status === undefined) return null;
        m.filters = { ...NO_FILTERS, slow: params.slow === "1", status: Object.hasOwn(STATUS_OUTCOMES, params.status ?? "") ? params.status : "" };
        m.before = null;
        const form = doc?.getElementById?.("request-filters");
        if (form?.elements) {
          if (form.elements.status) form.elements.status.value = m.filters.status;
          if (form.elements.slow) form.elements.slow.checked = m.filters.slow;
        }
        return true;
      },
      click(d, _button, { doc }) {
        const pair = (v) => v.split(":").map(Number);
        if (d.askCancel !== undefined) return actions.askCancelStatement(...pair(d.askCancel)) ?? true;
        if (d.dismissCancel !== undefined) return actions.dismissCancelStatement() ?? true;
        if (d.confirmCancel !== undefined) return actions.confirmCancelStatement(...pair(d.confirmCancel));
        if (d.sortTable === "requests") return actions.sortRequests(d.sortKey) ?? true;
        if (d.older !== undefined) return actions.olderRequests();
        if (d.newest !== undefined) return actions.newestRequests();
        if (d.clearFilters !== undefined) { doc.getElementById("request-filters")?.reset?.(); return actions.filterRequests({}); }
        return null;
      },
    };
  },
};
