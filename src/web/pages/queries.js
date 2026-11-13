/**
 * THE QUERIES VIEW (#observability/queries, a view of the Observability group; `#queries`, its old address, lands here):
 * the request log (`mason logs --requests`, GET /api/requests) and nothing else — who is connected, what runs and the
 * range's numbers are Usage's (src/web/pages/usage.js). A table (a status dot and word, each row expanding in place and
 * staying open across polls), newest first, filtered by status, slow (SLOW_MS or more), a piece of the statement's text,
 * user and client, over the shared time range (the hash's `range`, the only window: a `since` in an old hash is
 * ignored) — and paged back by Older;
 * Started, Duration and Rows sort the page shown (the pages follow the log's order by start: a sort of the whole log
 * would need a cursor per order). Read every 5 s while the range is Now, once when another is chosen. A statement is one
 * or two lines in its cell, its title at most TITLE_MAX characters, and its expanded row the first STATEMENT_MAX of it.
 * The words are the commands': a request's duration in ms, its error, the empty log's sentence — and, while the log is
 * empty and unfiltered, one quiet line leading to the Users page, where a tool's user is made. Usage's rows lead here
 * filtered (`route`: `?user=`, `?client=`, `?slow=1`, `?status=`). The User filter is a dropdown of the users
 * (`renderUserFilter`, from GET /api/users while Queries is shown), a text box when they could not be read.
 */
import { VIEW_HASHES } from "../routes.js";
import { statementMsText, agoText, bytesText, esc, firstLine, n, empty, renderFailure, rowsHtml, utcText, utcMsText, details, createOpenSet, status,
  clip, capped, TITLE_MAX, sortTh, sortedBy, nextSort, RANGES, DEFAULT_RANGE, clientText, USERS_HASH, UNLISTED_STATEMENTS, statementCell, rangeEvery, usersReadOnly } from "../shared.js";

const STATE = "api/state";
/** The users, for the User filter's choices: `mason user list --json`'s shape, without the last use (a scan of the log
 *  the dropdown does not show), read at the Users page's rate while Queries is shown. */
const USERS = "api/users";
const USERS_EVERY_MS = 30_000;
const NEWEST_EVERY_MS = 5000;
/** The newest page while a search is set: a search reads every statement's text of the range (7 days of a busy log,
 *  ~0.6 s a read), so it is read every 30 s, not 5 — said under the log (SEARCH_NOTE). */
const SEARCH_EVERY_MS = 30_000;
export const SEARCH_NOTE = `While you search, this list refreshes every ${SEARCH_EVERY_MS / 1000} s, because a search reads the text of every query in the range.`;
/** The most of a statement (or an error) an expanded row writes, in characters. */
const STATEMENT_MAX = 16 * 1024;

/** The status column's dot and word, by the ledger's `outcome` (src/api/request-log.ts `outcomeOf`): the word
 *  `mason logs --requests` prints, coloured as its line is (src/cli/commands.ts `requestLine`). A refusal (a statement
 *  Mason answers as designed, as a Postgres would refuse it) is Refused, never Failed (Mason's or the machine's fault). */
const OUTCOME = { ok: ["ok", "Completed"], refused: ["warn", "Refused"], failed: ["bad", "Failed"], cancelled: ["warn", "Cancelled"] };

/** The columns of the request log's table: its details row spans them all; the sortable ones by their sort key. */
const REQUEST_COLUMNS = [["Status"], ["Query id"], ["Started", "started"], ["Duration", "duration", "num"], ["User"], ["Client"], ["Rows", "rows", "num"], ["Query"]];
/** What each sortable column sorts by. */
const REQUEST_SORTS = { started: (r) => Date.parse(r.startedAt), duration: (r) => r.durationMs, rows: (r) => r.rows };
/** The request log's order unless a header is clicked: newest first. */
const NEWEST_FIRST = { key: "started", dir: "desc" };

/** The statement cell's toggle (issue 816): the same expanded row as the id's, by the same key and open state, so the
 *  way to the whole statement is where the reader looks for it: its label the +/− the id's summary draws, its name what it opens. */
const EXPAND_NAME = "Show the whole query";
const expandButton = (key, open) =>
  `<button type="button" class="expand" data-expand="${esc(key)}" aria-expanded="${open ? "true" : "false"}" aria-label="${EXPAND_NAME}" title="${EXPAND_NAME}"><span aria-hidden="true">${open ? "−" : "+"}</span></button>`;

/**
 * A SLOW STATEMENT'S PLAN in its expanded row (`plan`, src/duck/requests.ts LedgerRequest): as text, the first
 * STATEMENT_MAX characters and said so when cut, as the statement is, and said when the log kept it cut (8 KiB); "" for
 * a row with none (an older run's rows have no `plan` at all).
 */
function planHtml(r) {
  if (typeof r.plan !== "string") return "";
  const plan = capped(r.plan, STATEMENT_MAX, `mason logs --requests --id ${r.requestId}`);
  return `<p class="plan-label">Its plan, recorded when it ended (it took ${esc(statementMsText(r.durationMs))})</p><pre class="plan">${esc(plan.text)}</pre>` +
    (plan.cut ? `<p class="dim cut">${esc(plan.cut)}${r.planTruncated ? " (as the log kept it)" : ""}</p>` : r.planTruncated ? `<p class="dim cut">Mason kept only the first 8 KiB of the plan.</p>` : "");
}

/**
 * THE REQUEST LOG (`mason logs --requests --json`'s shape: { requests, keptDays, before }), newest first (the command
 * prints the oldest of the page first; a table reads the other way): a dot and the status word, the id's first 8
 * characters, when it started (how long ago; the UTC time is its title and in its details), the duration, user, client,
 * rows, and the statement (cut to a line, at most two in the cell, at most TITLE_MAX characters its title) over its
 * error's first line. Each row EXPANDS (its id is a toggle — a `details` keyed by the request's id — and so is the `+`
 * beside its statement, `expandButton`, the same key: `isOpen` the page's open set, so a poll that rewrites the log keeps
 * it open, and both toggles say the same) into the whole id, when it started and ended, the bytes sent,
 * the statement and the error — each the first STATEMENT_MAX characters, and said so when cut. `sort` ({ key, dir }:
 * started, duration or rows) orders the page shown, said under it when it is not the newest first. **Older** when the
 * page has an older one (`before`), **Newest** when the page shown is not the newest. `filtered`: the empty sentence
 * names the filters, as the command's does; `span` the range's words (the empty log's). `now` is the page's clock.
 * Under the list, always, one small quiet line: what the log does not list (UNLISTED_STATEMENTS, as `mason logs
 * --requests` says it), so a `select 1` typed to test a connection is not looked for in vain.
 * `firstTool`: an empty, unfiltered log adds one quiet line, Create a user (a link to the Users page) to connect your
 * first tool — false where the page makes no user (`usersReadOnly`).
 */
export function renderRequests(page, { paged = false, filtered = false, isOpen = () => false, now = Date.now(), sort = NEWEST_FIRST, span = "", firstTool = false } = {}) {
  const older = page.before !== null && page.before !== undefined;
  const unlisted = `<p class="dim unlisted">${esc(UNLISTED_STATEMENTS)}.</p>`;
  const nav = paged || older ? `<div class="paging">${paged ? `<button type="button" data-newest>Newest</button>` : ""}${older ? `<button type="button" data-older>Older</button>` : ""}</div>` : "";
  if (!page.requests.length) {
    const days = `${page.keptDays} day${page.keptDays === 1 ? "" : "s"}`;
    return empty(`${filtered ? "No query matches the filters" : "No queries"} in ${span || `the last ${days}`}.`) +
      // nothing asked yet (no filter, the newest page): where a tool's user is made, in a line
      (filtered || paged || !firstTool ? "" : `<p class="empty first-tool"><a href="${USERS_HASH}">Create a user</a> to connect your first tool.</p>`) + unlisted + nav;
  }
  const newest = [...page.requests].reverse();
  const list = sort.key === "started" && sort.dir === "desc" ? newest : sortedBy(newest, REQUEST_SORTS[sort.key] ?? REQUEST_SORTS.started, sort.dir);
  const rows = list.map((r) => {
    const key = `request:${r.requestId}`;
    const open = isOpen(key);
    const error = r.sqlstate === null && !r.message ? "" : `<div class="err"${r.sqlstate ? ` title="SQLSTATE ${esc(r.sqlstate)}"` : ""}><span title="${esc(clip(r.message ?? "", TITLE_MAX))}">${esc(clip(firstLine(r.message ?? ""), 300))}</span></div>`;
    const [kind, word] = OUTCOME[r.outcome] ?? [undefined, String(r.outcome)];
    const row = `<tr class="s-${esc(word.toLowerCase())}"><td>${status(kind, word)}</td>` +
      `<td class="id">${details(key, r.requestId.slice(0, 8), "", open)}</td>` +
      `<td class="when"><time data-tick datetime="${esc(r.startedAt)}" title="${esc(utcText(r.startedAt))} UTC">${esc(agoText(r.startedAt, now))}</time></td>` +
      `<td class="num">${esc(statementMsText(r.durationMs))}</td><td><span class="clip" title="${esc(r.user || r.tokenName)}">${esc(r.user || (r.tokenName ? `token ${r.tokenName}` : ""))}</span></td>` +
      `<td><span class="clip" title="${esc(clientText(r.applicationName))}">${esc(clientText(r.applicationName))}</span></td>` +
      `<td class="num">${r.rows === null ? "" : esc(n(r.rows))}</td><td class="stmt-cell"><div class="stmt-line">${statementCell(r.query)}${expandButton(key, open)}</div>${error}</td></tr>`;
    // the rest of a request is its expanded row: the whole id, when it started and ended, the bytes sent, the statement and error (each capped)
    const stmt = capped(r.query || "(no statement)", STATEMENT_MAX, "mason logs --requests --json");
    const err = capped(r.message ?? "", STATEMENT_MAX, "mason logs --requests --json");
    // its body is as wide as the row and no wider (`.detail-body`): a long statement scrolls in its box, never widens a column
    const more = open ? `<tr class="detail"><td colspan="${REQUEST_COLUMNS.length}"><div class="detail-body">${rowsHtml([["Query id", r.requestId], ["Started (UTC)", utcMsText(r.startedAt)], ["Ended (UTC)", utcMsText(r.endedAt)], ["Bytes sent", r.bytesSent === null ? "" : bytesText(r.bytesSent)]])}` +
      `<pre class="stmt">${esc(stmt.text)}</pre>${stmt.cut ? `<p class="dim cut">${esc(stmt.cut)}${r.queryTruncated ? " (as the log kept it)" : ""}</p>` : r.queryTruncated ? `<p class="dim cut">Mason kept only the start of this query.</p>` : ""}` +
      `${r.message ? `<pre class="error">${esc(r.sqlstate ? `${r.sqlstate} ` : "")}${esc(err.text)}</pre>${err.cut ? `<p class="dim cut">${esc(err.cut)}</p>` : ""}` : ""}${planHtml(r)}</div></td></tr>` : "";
    return row + more;
  }).join("");
  const sortNote = sort.key === "started" && sort.dir === "desc" ? ""
    : `<p class="dim sort-note">Sorted by ${esc(sort.key === "started" ? "start" : sort.key)}, ${sort.dir === "asc" ? "lowest" : "highest"} first, within the ${n(page.requests.length)} rows of this page. Older and Newest go by start time.</p>`;
  return `<div class="scroll"><table class="requests"><thead><tr>${REQUEST_COLUMNS.map(([c, key, cls]) => key ? sortTh("requests", key, c, sort, cls) : `<th scope="col">${c}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>${sortNote}${unlisted}${nav}`;
}

/**
 * THE USER FILTER (the form's `user`, the part `rq-user-field`: its label and its control): a dropdown, "All users" (no
 * filter) then the users of `/api/users` (`users`: its body, `{ failure }`, or undefined before it answered) — the
 * active first, then the removed, marked "(removed)", since their statements are still in the log; a name once. An
 * option's value is the user's name, sent as `user=` as a typed name was: the server's one filter. `selected` (the
 * filter set) not among them (a hash's `user=` naming a share's login, or a user whose record is gone) is one more
 * option, selected, so a link still filters and says so. The users not read (a failure): the text box, as before.
 */
export function renderUserFilter(users, selected = "") {
  const label = `<label for="rq-user">User</label>`;
  if (users !== undefined && (users === null || "failure" in users || !Array.isArray(users.users)))
    return `${label}<input id="rq-user" name="user" spellcheck="false" value="${esc(selected)}">`;
  const list = users?.users ?? [];
  const seen = new Set();
  const options = [];
  for (const u of [...list.filter((x) => x.removedAt == null), ...list.filter((x) => x.removedAt != null)]) {
    if (typeof u.name !== "string" || seen.has(u.name)) continue;
    seen.add(u.name);
    options.push([u.name, u.removedAt == null ? u.name : `${u.name} (removed)`]);
  }
  if (selected !== "" && !seen.has(selected)) options.push([selected, selected]);
  const option = (value, text) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(text)}</option>`;
  return `${label}<select id="rq-user" name="user">${option("", "All users")}${options.map(([v, t]) => option(v, t)).join("")}</select>`;
}

/** The status filter's choices as the server's `outcome` list (src/api/request-log.ts): Completed is ok, Refused the
 *  statement's own fault, Failed Mason's or the machine's, Cancelled a cancel or a timeout (57014); Refused or failed is
 *  both, the count the Overview's query errors and Usage's Failed card lead here with. */
const STATUS_OUTCOMES = { completed: "ok", refused: "refused", failed: "failed", "refused-or-failed": "refused,failed", cancelled: "cancelled" };

/** The filters as they are before any is set. */
const NO_FILTERS = { status: "", user: "", client: "", slow: false, search: "" };

/** The path of one view of the request log: its filters as the server reads them (it judges search), since the range's
 *  (`range`, a key of RANGES: the only window), and the cursor of an older page. */
export function requestsPath(filters, before, range = DEFAULT_RANGE) {
  const p = new URLSearchParams();
  if (STATUS_OUTCOMES[filters.status]) p.set("outcome", STATUS_OUTCOMES[filters.status]);
  p.set("since", (RANGES[range] ?? RANGES[DEFAULT_RANGE]).since);
  for (const k of ["user", "client"]) if (filters[k]) p.set(k, filters[k]);
  if (filters.slow) p.set("slow", "1");
  if (filters.search) p.set("search", filters.search);
  if (before) p.set("before", before);
  return `api/requests?${p.toString()}`;
}

export const page = {
  id: "queries",
  hash: VIEW_HASHES.queries,
  parent: "observability",
  title: "Queries",
  create(ctx) {
    // the request rows' details open, by request id (createOpenSet): they stay open across a poll
    const opened = createOpenSet();
    const m = { filters: { ...NO_FILTERS }, before: null, open: opened.open, sort: NEWEST_FIRST };
    const path = () => requestsPath(m.filters, m.before, ctx.range());
    const filtered = () => Object.values(m.filters).some((v) => v !== "" && v !== false);
    /** The form's controls showing the filters (a route sets them, not a person). */
    const showFilters = (doc) => {
      const form = doc?.getElementById?.("request-filters");
      if (!form?.elements) return;
      for (const k of ["status", "user", "client", "search"]) if (form.elements[k]) form.elements[k].value = m.filters[k];
      if (form.elements.slow) form.elements.slow.checked = m.filters.slow;
    };
    const actions = {
      /** Show the requests that pass these filters, from the newest. */
      async filterRequests(filters) {
        // the filters the form has, and only those (a since of an older caller is no window: the range is)
        m.filters = { ...NO_FILTERS, ...Object.fromEntries(Object.entries(filters).filter(([k]) => Object.hasOwn(NO_FILTERS, k))) };
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
      // the newest page of the log every 5 s while the range is Now (30 s while a search is set), once when another
      // range is chosen; an older page only when first asked. The state (whether the page makes users, for the empty log's line) every 30 s,
      // and the users (the User filter's choices) at the Users page's rate
      reads: () => [{ path: path(), everyMs: m.before !== null ? Infinity : rangeEvery(ctx.range(), m.filters.search ? SEARCH_EVERY_MS : NEWEST_EVERY_MS) }, { path: STATE, everyMs: 30_000 },
        { path: USERS, everyMs: USERS_EVERY_MS }],
      actions,
      view() {
        const log = ctx.read(path());
        const s = ctx.read(STATE)?.body;
        const users = ctx.read(USERS);
        return {
          "rq-user-field": renderUserFilter(users === undefined ? undefined : users.failure ? { failure: users.failure } : users.body, m.filters.user),
          "request-log": (log?.failure ? renderFailure(log.failure) : "") + (log?.body ? renderRequests(log.body, { paged: m.before !== null, filtered: filtered(), isOpen: opened.has, now: ctx.now().getTime(), sort: m.sort,
            span: (RANGES[ctx.range()] ?? RANGES[DEFAULT_RANGE]).span, firstTool: s != null && usersReadOnly(s) === null }) : "") +
            (log?.body && m.filters.search && m.before === null ? `<p class="dim refresh-note">${esc(SEARCH_NOTE)}</p>` : ""),
        };
      },
      toggle: (target) => opened.toggle(target),
      submit(form) {
        if (form.id !== "request-filters") return null;
        const value = (k) => form.elements[k]?.value?.trim() ?? "";
        return actions.filterRequests({ status: value("status"), user: value("user"), client: value("client"), slow: form.elements.slow?.checked === true, search: value("search") });
      },
      /** `#observability/queries?slow=1`, `?status=refused-or-failed`,`?user=metabase&client=Metabase` (where the Overview's cards
       *  and Usage's rows lead): those filters, from the newest, and the form's controls showing them. Nothing to do for a
       *  hash without them (a change of range keeps the filters). */
      route(params, { doc } = {}) {
        if (!["slow", "status", "user", "client"].some((k) => params[k] !== undefined)) return null;
        m.filters = { ...NO_FILTERS, slow: params.slow === "1", status: Object.hasOwn(STATUS_OUTCOMES, params.status ?? "") ? params.status : "",
          user: params.user ?? "", client: params.client ?? "" };
        m.before = null;
        showFilters(doc);
        return true;
      },
      click(d, button, env) {
        const { doc } = env;
        if (d.sortTable === "requests") return actions.sortRequests(d.sortKey) ?? true;
        // the statement's toggle: the row's one open state, as its id's summary opens and closes it
        if (d.expand !== undefined) return opened.toggle({ dataset: { open: d.expand }, open: !opened.has(d.expand), clicked: true });
        if (d.older !== undefined) return actions.olderRequests();
        if (d.newest !== undefined) return actions.newestRequests();
        if (d.clearFilters !== undefined) { doc.getElementById("request-filters")?.reset?.(); return actions.filterRequests({}); }
        return null;
      },
    };
  },
};
