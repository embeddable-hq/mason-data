/**
 * THE USAGE VIEW (#observability/usage, a view of the Observability group; `#usage`, its old address, lands here;
 * docs/OBSERVABILITY.md "Pages"): what the Postgres API answered over the time range the Observability views share —
 * every part following it. Now: who is connected now (`/api/state` `sessions`) and the statements running now
 * (`mason logs --running`, GET /api/running) with a Cancel that asks first (`mason cancel`, POST /api/cancel), read
 * every few seconds. Any other range: who sent statements in it and the slowest that completed (GET /api/activity),
 * read once when chosen. Either way: KPI cards for the range (`/api/activity` `window`: the statements, the failed ones,
 * p95, rows and bytes sent, each with a sparkline), four small charts (statements, p95, the copy's size and its rows,
 * `mason usage`'s samples: the hour a minute a point, the day an hour, the week six hours), the unsupported SQL of the
 * range (mason status's, GET /api/unsupported), the samples a line, newest first (behind a details once there are
 * charts), and each copy's own size. A row LEADS ON: a client to its statements, a card to the statements it counts,
 * on Observability › Queries filtered so (`queriesHref`). Every number a chart draws is also text, in a card or the
 * samples' table. A page module (src/web/app.js has the contract). Never the engine's name.
 */
import { esc, n, msText, bytesText, fileSize, duration, details, createOpenSet, cards, card, empty, panel, skeleton, sortTh, sortedBy, nextSort, readPart, usagePath, utcMinute,
  RANGES, DEFAULT_RANGE, rangeOf, isLive, rangeEvery, firstLine, spanText, agoText, utcText, clientText, clip, TITLE_MAX, unsupportedEntry, renderFailure, json, pop, fresh, actId,
  statementCell, POLL_MS } from "../shared.js";
import { spark, seriesChart, seriesOf, drawable } from "../charts.js";

const EVERY_MS = 60_000;
/** A step said as the charts' titles say it: `a minute`, `an hour`, `every 6 hours`. */
const perStep = (seconds) => seconds === 60 ? "a minute" : seconds === 3600 ? "an hour" : seconds === 86_400 ? "a day" : seconds % 3600 === 0 ? `every ${seconds / 3600} hours` : `every ${duration(seconds)}`;
/** How often a copy's own size is measured, in seconds (src/duck/usage.ts SIZE_EVERY_MS, held equal by the tests). */
export const SIZE_EVERY_SECONDS = 600;

const th = (cols) => `<thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>`;
const num = (v) => `<td class="num">${esc(v)}</td>`;

/** The caveat of a window the request log keeps fewer days of than it asks (src/cli/commands.ts `queryLines`); "" when it keeps all. */
export const coveredText = (w) => w.covered < w.days ? `the request log keeps ${w.covered} day${w.covered === 1 ? "" : "s"}: MASON_REQUEST_LOG_DAYS` : "";

/** One sample's cells in `mason usage`'s words (src/cli/usage.ts `sampleLine`): the strings the table writes, held equal by the tests. */
export function sampleCells(s) {
  const bad = s.statementsRefused + s.statementsFailed + s.statementsCancelled;
  return {
    time: utcMinute(s.at), statements: n(s.statements), errors: bad === 0 ? "" : n(bad),
    rowsSent: n(s.rowsSent), bytesSent: bytesText(s.bytesSent), p95: s.durationP95Ms === null ? "–" : msText(s.durationP95Ms),
    copy: s.copyBytes === null ? "–" : fileSize(s.copyBytes), rows: n(s.copyRows), failing: s.tablesFailed === 0 ? "" : n(s.tablesFailed),
    oldest: s.oldestSyncSeconds === null ? "–" : duration(s.oldestSyncSeconds), lag: s.streamLagSeconds === null ? "–" : duration(s.streamLagSeconds),
    memory: `${fileSize(s.rssBytes)}${s.copyMemoryBytes === null ? "" : ` (copy ${fileSize(s.copyMemoryBytes)} of ${fileSize(s.copyMemoryLimitBytes)})`}`,
  };
}

/** The charts, in order: [holder key, title, sample field, kind, how a hovered value is said (exactly, as the table
 *  says it), the axis's unit]. One series each, from a zero baseline. "Statements" is "Statements an hour" by the step. */
const CHARTS = [
  ["usage-statements", "Statements", "statements", "bars", n, "count"],
  ["usage-p95", "p95 duration", "durationP95Ms", "line", (v) => msText(v), "ms"],
  ["usage-copy-bytes", "Size of the copy", "copyBytes", "line", fileSize, "bytes"],
  ["usage-copy-rows", "Rows in the copy", "copyRows", "line", n, "count"],
];
/** A chart's title at a step: the statements are counted per step, the rest are levels. */
const chartTitle = (key, title, step) => key === "usage-statements" ? `Statements ${perStep(step ?? 3600)}` : title;
/** The sparklines of the cards, by card: [holder key, title, sample field]. The failed ones are the samples' refused and failed together. */
const SPARKS = { statements: ["usage-spark-statements", "Statements", "statements"], failed: ["usage-spark-failed", "Failed statements", "failedCount"],
  p95: ["usage-spark-p95", "p95", "durationP95Ms"], rows: ["usage-spark-rows", "Rows sent", "rowsSent"], bytes: ["usage-spark-bytes", "Bytes sent", "bytesSent"] };

const samplesOf = (usage) => usage && Array.isArray(usage.samples) ? usage.samples.map((s) => ({ ...s, failedCount: s.statementsRefused + s.statementsFailed })) : [];

/** The specs of the charts and the sparklines from `/api/usage`'s body (anything else draws none), by holder key: what `charts()` returns. */
export function usageSpecs(usage) {
  const samples = samplesOf(usage);
  const specs = [
    ...CHARTS.map(([key, label, field, kind, format, unit]) => [key, { kind, label: chartTitle(key, label, usage?.stepSeconds), format, unit, ...seriesOf(samples, field) }]),
    ...Object.values(SPARKS).map(([key, label, field]) => [key, { kind: "spark", label, ...seriesOf(samples, field) }]),
  ];
  return Object.fromEntries(specs.filter(([, spec]) => drawable(spec)));
}

/**
 * The four charts' holders, each under its title (cut with an ellipsis when long, its whole the title): a series that can
 * be drawn gets its holder; one with a single sample says it and its value (a chart needs two); none with no sample at
 * all (the samples' table says so). `range` names the span in each chart's label.
 */
export function renderCharts(usage, range = DEFAULT_RANGE) {
  const specs = usageSpecs(usage);
  const samples = samplesOf(usage);
  if (!samples.length) return "";
  const span = (RANGES[rangeOf(range)] ?? RANGES[DEFAULT_RANGE]).span;
  const blocks = CHARTS.map(([key, title, field, , format]) => {
    const name = chartTitle(key, title, usage.stepSeconds);
    const head = `<p class="card-label" title="${esc(name)}">${esc(name)}</p>`;
    if (specs[key]) return `<div class="chart-card">${head}${seriesChart(key, `${name}, ${span}`)}</div>`;
    const values = samples.map((x) => x[field]).filter((v) => typeof v === "number");
    return `<div class="chart-card note">${head}<p class="dim">${values.length === 1 ? `One sample so far: ${esc(format(values[0]))}. A chart needs two.` : "No value in this time."}</p></div>`;
  });
  return `<div class="chart-grid">${blocks.join("")}</div>`;
}

const RUNNING = "/api/running";
const STATE = "/api/state";
/** Who is connected: the clients with the most sessions (or statements) shown, this many; the rest in one row. */
const SESSIONS_TOP = 10;
/** What a past range's statements were (GET /api/activity): read once when chosen, every 5 s while the range is Now. */
export const activityPath = (range = DEFAULT_RANGE) => `/api/activity?since=${RANGES[rangeOf(range)].since}`;
const ACTIVITY_EVERY_MS = 5000;
/** The unsupported SQL of a range (`/api/unsupported`: its 10 entries the most refused first): it says what to rewrite. */
const unsupportedPath = (range = DEFAULT_RANGE) => `/api/unsupported?since=${RANGES[rangeOf(range)].since}`;
const UNSUPPORTED_EVERY_MS = 60_000;
const plural = (count, word) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;
/** The key a running statement is asked about by: its session and its statement's number. */
const keyOf = (session, statement) => `${session}:${statement}`;
/** A range's words on a card: `last 15 min`, `last hour`, `last 24 hours`. */
const shortSpan = (range) => { const r = RANGES[rangeOf(range)]; return r.live ? "last 15 min" : r.span.replace(/^the /, ""); };

/**
 * WHERE A ROW LEADS: Observability › Queries filtered to what it counts (`user`, `client`, `slow`, `status`), at the
 * range shown (the default left out, as the shell's links do). A filter that is "" is no filter.
 */
export function queriesHref(filters = {}, range = DEFAULT_RANGE) {
  const q = new URLSearchParams(Object.entries({ ...filters, range: rangeOf(range) === DEFAULT_RANGE ? "" : rangeOf(range) }).filter(([, v]) => v !== "" && v !== undefined && v !== null && v !== false));
  const qs = q.toString();
  return `#observability/queries${qs ? `?${qs}` : ""}`;
}
/** A client's Queries link: its statements in the range. */
const queriesLink = (user, client, range, label = "Queries") => `<a class="btn small" href="${esc(queriesHref({ user, client }, range))}" title="the statements ${esc(user || "this token")} sent from ${esc(clientText(client))} in ${esc(RANGES[rangeOf(range)].span)}">${esc(label)}</a>`;

/** What a cancel answered, as `mason cancel` says it: its headline, or the refusal as the Failure. */
function outcomeHtml(o) {
  if (o.failure) return `${renderFailure(o.failure)}<p class="pop-actions"><button type="button" class="small" data-dismiss-cancelled data-pop-close>Dismiss</button></p>`;
  return `<p class="done"><span class="headline" title="SQLSTATE 57014">Cancelled session ${o.cancelled.session}'s statement: it ends now, and its client gets a "canceling statement" error.</span></p>`;
}

/**
 * WHO IS CONNECTED NOW (`/api/state` `sessions`: { open, byClient: [{ user, client, open, running }] } or { error }): a row
 * per user and client — the sessions it has open, the statements it is running, and Queries: its statements on
 * Observability › Queries. "" when the run did not say.
 */
export function renderSessions(sessions, top = SESSIONS_TOP, range = DEFAULT_RANGE) {
  if (!sessions) return "";
  if ("error" in sessions) return `<p class="count">Who is connected could not be read (${esc(firstLine(String(sessions.error)))})</p>`;
  if (!sessions.byClient.length) return empty("No client is connected now.");
  // the clients with the most sessions first; past `top`, the others in one row (200 clients are not 200 rows)
  const byOpen = sortedBy(sessions.byClient, (c) => c.open * 1e6 + c.running, "desc");
  const shown = byOpen.slice(0, top), rest = byOpen.slice(top);
  const sum = (list, k) => list.reduce((a, c) => a + c[k], 0);
  const others = rest.length ? `<tr class="others"><td colspan="2">${esc(n(rest.length))} other client${rest.length === 1 ? "" : "s"}</td><td class="num">${esc(n(sum(rest, "open")))}</td><td class="num">${esc(n(sum(rest, "running")))}</td><td></td></tr>` : "";
  const cell = (v) => `<td><span class="clip" title="${esc(v)}">${esc(v)}</span></td>`;
  return panel(`<table class="sessions"><thead><tr><th scope="col">User</th><th scope="col">Client</th><th scope="col" class="num">Open</th><th scope="col" class="num">Running</th><th scope="col" class="act"></th></tr></thead><tbody>` +
    shown.map((c) => `<tr>${cell(c.user || "(no user)")}${cell(clientText(c.client))}<td class="num">${esc(n(c.open))}</td><td class="num">${esc(n(c.running))}</td><td class="act">${queriesLink(c.user, c.client, range)}</td></tr>`).join("") + others +
    `</tbody></table>`) + `<p class="dim">${esc(n(sessions.open))} session${sessions.open === 1 ? "" : "s"} open${rest.length ? `, from ${esc(n(byOpen.length))} clients` : ""}.</p>`;
}

/**
 * THE THREE CARDS of a window of the request log (`day`: `/api/activity`'s `window`, `/api/queries`' `day` or `week`; `label` its name): the
 * statements, the failed ones (the log's Failed: refused or failed; its sub-line names each and the cancelled) and the
 * completed ones' p95. `line(key)` is a card's sparkline holder (the Usage page draws them; "" for none): ONE place
 * derives these facts. `hrefs` (by card: statements, failed, p95) makes a card a link to what it counts.
 */
export function statementCards(day, line = () => "", label = "last 24 hours", hrefs = {}) {
  const failed = day.refused + day.failed;
  return [
    card(`Statements, ${label}`, n(day.statements), `${n(day.completed)} completed`, line("statements"), "", hrefs.statements ?? ""),
    card(`Failed, ${label}`, n(failed), `${n(day.refused)} refused, ${n(day.failed)} failed${day.cancelled ? `, ${n(day.cancelled)} cancelled` : ""}`, line("failed"), failed ? "warn" : "", hrefs.failed ?? ""),
    card(`p95, ${label}`, day.durationMs === null ? "–" : msText(day.durationMs.p95),
      day.durationMs === null ? "no statement completed" : `average ${msText(day.durationMs.avg)} · p50 ${msText(day.durationMs.p50)}`, line("p95"), "", hrefs.p95 ?? ""),
  ];
}

/**
 * THE STATEMENTS RUNNING NOW (`mason logs --running --json`'s `running`): a row each — session, statement, user, client,
 * how long it has run (a relative time that moves with each poll; when it started, in UTC, its title), the rows sent so
 * far, the statement — and Cancel. The one being cancelled (`asking`, `session:statement`) asks first, its question a
 * popover beside its Cancel (`pop`: no row is inserted, so none below moves; its Cancel stays, held down); `outcome` is
 * what the last cancel answered (a Failure, or `{ cancelled, at }`), a popover beside the row it was for — or beside the
 * part when that statement has ended since — gone by itself after OUTCOME_MS at `now` (a refusal stays until dismissed).
 */
export function renderRunning(running, asking = null, outcome = null, now = Date.now()) {
  const pops = [];
  const said = fresh(outcome, now) ? outcome : null;
  let shown = false;
  const rows = running.map((r) => {
    const key = keyOf(r.session, r.statement);
    const anchor = actId("running", key);
    if (asking === key) {
      pops.push(pop(anchor, `<p class="confirm" title="SQLSTATE 57014">Cancel session ${r.session}'s statement ${r.statement}? Its client gets a "canceling statement" error.</p>` +
        `<p class="pop-actions"><button type="button" class="danger small" data-confirm-cancel="${esc(key)}">Cancel statement ${r.statement}</button> <button type="button" class="small" data-dismiss-cancel data-pop-close>Keep it running</button></p>`,
        { kind: "dialog", label: `Cancel session ${r.session}'s statement ${r.statement}?` }));
    }
    if (said !== null && said.key === key) { shown = true; pops.push(pop(anchor, outcomeHtml(said))); }
    return `<tr><td>${r.session}</td><td>${r.statement}</td><td><span class="clip" title="${esc(r.user)}">${esc(r.user)}</span></td><td><span class="clip" title="${esc(clientText(r.applicationName))}">${esc(clientText(r.applicationName))}</span></td>` +
      `<td class="num"><time datetime="${esc(r.startedAt)}" title="started ${esc(utcText(r.startedAt))} UTC">${esc(spanText(r.runningMs / 1000))}</time></td><td class="num">${esc(plural(r.rows, "row"))} sent</td>` +
      `<td>${statementCell(r.query)}</td><td class="act" id="${esc(anchor)}">${asking === key ? `<button type="button" class="danger small" aria-expanded="true" disabled>Cancel</button>` : `<button type="button" class="danger small" data-ask-cancel="${esc(key)}">Cancel</button>`}</td></tr>`;
  }).join("");
  const table = running.length
    ? `<div class="scroll"><table class="running"><thead><tr><th scope="col">Session</th><th scope="col" title="the statement's number in its session, as mason cancel --statement takes it">No.</th><th scope="col">User</th><th scope="col">Client</th>` +
      `<th scope="col" class="num">Running for</th><th scope="col">Rows</th><th scope="col">Statement</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : empty("No statement is running now.");
  // the statement ended since: said beside the part, which is there whatever it lists
  if (said !== null && !shown) pops.push(pop("usage-running", outcomeHtml(said)));
  return table + pops.join("");
}

/**
 * THE UNSUPPORTED SQL of the range (`/api/unsupported`'s body: { since, unsupported, keptDays }): the statements Mason
 * refused because they used SQL it does not support, grouped by its entry of docs/SQL-SUPPORT.md, the most refused first
 * — each in mason status's two lines (`unsupportedEntry`): how many used what and the entry's name, then when the latest
 * was, who sent them, and the latest statement on a line (its whole, up to TITLE_MAX, is the title). `span` is the range's
 * words. None: the empty sentence, with how long the log keeps them.
 */
export function renderUnsupported(b, span = RANGES[DEFAULT_RANGE].span) {
  const days = `${b.keptDays} day${b.keptDays === 1 ? "" : "s"}`;
  if (!b.unsupported.length) return empty(`No statement refused for unsupported SQL in ${span} (the request log keeps ${days}: MASON_REQUEST_LOG_DAYS).`);
  return `<p class="lead">The statements refused in ${esc(span)} by the SQL they used that Mason does not support, the most first.</p>` +
    panel(`<ul class="unsupported">${b.unsupported.map((g) => {
      const e = unsupportedEntry(g);
      return `<li><p class="headline" title="docs/SQL-SUPPORT.md entry ${esc(e.id)}">${esc(e.headline)}</p><p class="dim">${esc(e.last)} — <code class="clip" title="${esc(clip(g.example, TITLE_MAX))}">${esc(e.example)}</code></p><p class="dim">${esc(e.how)}</p></li>`;
    }).join("")}</ul>`);
}

/**
 * WHO SENT STATEMENTS IN A PAST RANGE (`/api/activity` `clients`: [{ user, tokenName, client, statements, failed,
 * sessions, last }], the most statements first): a row per user and client — its statements, the failed ones, the
 * sessions they came from, when the latest started — and Queries, its statements on Observability › Queries. Past
 * `top`, the others in one row. `span` the range's words.
 */
export function renderClients(clients, { top = SESSIONS_TOP, range = DEFAULT_RANGE, now = Date.now() } = {}) {
  const span = RANGES[rangeOf(range)].span;
  if (!clients.length) return empty(`No client sent a statement the request log lists in ${span}.`);
  const shown = clients.slice(0, top), rest = clients.slice(top);
  const sum = (k) => rest.reduce((a, c) => a + c[k], 0);
  const cell = (v) => `<td><span class="clip" title="${esc(v)}">${esc(v)}</span></td>`;
  const who = (c) => c.user || (c.tokenName ? `token ${c.tokenName}` : "(no user)");
  return panel(`<table class="sessions"><thead><tr><th scope="col">User</th><th scope="col">Client</th><th scope="col" class="num">Statements</th><th scope="col" class="num">Failed</th>` +
    `<th scope="col" class="num">Sessions</th><th scope="col">Last</th><th scope="col" class="act"></th></tr></thead><tbody>` +
    shown.map((c) => `<tr>${cell(who(c))}${cell(clientText(c.client))}<td class="num">${esc(n(c.statements))}</td><td class="num">${c.failed ? esc(n(c.failed)) : ""}</td>` +
      `<td class="num">${esc(n(c.sessions))}</td><td><time datetime="${esc(c.last)}" title="${esc(utcText(c.last))} UTC">${esc(agoText(c.last, now))}</time></td><td class="act">${queriesLink(c.user, c.client, range)}</td></tr>`).join("") +
    (rest.length ? `<tr class="others"><td colspan="2">${esc(n(rest.length))} other client${rest.length === 1 ? "" : "s"}</td><td class="num">${esc(n(sum("statements")))}</td><td class="num">${esc(n(sum("failed")))}</td><td class="num">${esc(n(sum("sessions")))}</td><td></td><td></td></tr>` : "") +
    `</tbody></table>`) + `<p class="dim">${esc(plural(clients.length, "client"))}${clients.length >= 50 ? " (the 50 with the most statements)" : ""} sent statements in ${esc(span)}. A session that sent only what the log does not list (select 1, SET, a catalog query) is not here.</p>`;
}

/**
 * THE SLOWEST STATEMENTS OF A PAST RANGE (`/api/activity` `slowest`, slowest first): a past range's analogue of what
 * runs now — when each started, how long it took, who sent it from where, the statement — and Queries, its client's
 * slow statements on Observability › Queries.
 */
export function renderSlowest(list, { range = DEFAULT_RANGE, now = Date.now() } = {}) {
  const span = RANGES[rangeOf(range)].span;
  if (!list.length) return empty(`No statement completed in ${span}.`);
  return `<div class="scroll"><table class="running"><thead><tr><th scope="col">Started</th><th scope="col" class="num">Took</th><th scope="col">User</th><th scope="col">Client</th>` +
    `<th scope="col" class="num">Rows</th><th scope="col">Statement</th><th scope="col" class="act"></th></tr></thead><tbody>` +
    list.map((r) => `<tr><td><time datetime="${esc(r.startedAt)}" title="${esc(utcText(r.startedAt))} UTC">${esc(agoText(r.startedAt, now))}</time></td><td class="num">${esc(msText(r.durationMs))}</td>` +
      `<td><span class="clip" title="${esc(r.user || r.tokenName)}">${esc(r.user || (r.tokenName ? `token ${r.tokenName}` : ""))}</span></td><td><span class="clip" title="${esc(clientText(r.applicationName))}">${esc(clientText(r.applicationName))}</span></td>` +
      `<td class="num">${r.rows === null ? "" : esc(n(r.rows))}</td><td class="stmt-cell">${statementCell(r.query)}</td>` +
      `<td class="act"><a class="btn small" href="${esc(queriesHref({ user: r.user, client: r.applicationName, slow: r.durationMs >= 1000 ? "1" : "" }, range))}" title="its client's statements on Observability › Queries">Queries</a></td></tr>`).join("") +
    `</tbody></table></div>`;
}

/**
 * THE KPI CARDS of the range: while it is Now, who is connected (`sessions`, `/api/state`'s) and what runs (`running`);
 * for any other, the clients that sent statements in it (`clients`, `/api/activity`'s). Then the range's statements, the
 * failed ones, the p95 (`statementCards`, of `/api/activity` `window`), the bytes and rows sent (one card) — each with a
 * sparkline where `usage` (`/api/usage`'s body) has two samples to draw, and each statement card leading to the
 * statements it counts on Observability › Queries. `activity` is the body or `{ failure }`; one not read yet draws its
 * card as a skeleton, one that could not be read `unknown` with its reason.
 */
export function renderUsageKpis({ activity, usage, sessions, running, range = DEFAULT_RANGE }) {
  const specs = usageSpecs(usage);
  const r = RANGES[rangeOf(range)];
  const line = (k) => specs[SPARKS[k][0]] ? spark(SPARKS[k][0], `${SPARKS[k][1]}, ${r.span} ${perStep(r.stepSeconds)} a point`) : "";
  const label = shortSpan(range);
  const list = [];
  if (isLive(range)) {
    if (sessions) list.push("error" in sessions ? card("Connected now", "unknown", firstLine(String(sessions.error)))
      : card("Connected now", plural(sessions.open, "session"), plural(sessions.byClient.length, "client")));
    if (running) list.push(card("Running now", n(running.length), running.length ? `the longest for ${spanText(Math.max(...running.map((x) => x.runningMs)) / 1000)}` : "no statement is running"));
  } else if (activity && !("failure" in activity)) {
    list.push(card(`Clients, ${label}`, n(activity.clients.length), plural(activity.clients.reduce((a, c) => a + c.sessions, 0), "session")));
  }
  if (activity === undefined) return cards(list) + skeleton(2);
  if ("failure" in activity) return cards([...list, card(`Statements, ${label}`, "unknown", `could not read them: ${firstLine(activity.failure.message)}`)]);
  const w = activity.window;
  const href = (filters) => queriesHref(filters, range);
  list.push(...statementCards(w, line, label, { statements: href({}), failed: href({ status: "failed" }), p95: href({ slow: "1" }) }),
    card(`Sent, ${label}`, bytesText(w.bytesSent), plural(w.rows, "row"), line("bytes")));
  // a range longer than the log keeps is said, never a short one passed off as whole
  const covered = coveredText(w);
  return cards(list) + (covered ? `<p class="warn">${esc(`${RANGES[rangeOf(range)].label}: ${covered}`)}</p>` : "");
}

/**
 * The usage answer as `mason usage` prints it: its heading, then the samples a line each (or that there are none yet), then
 * each copy's size. With charts drawn the hours are their numbers, behind a closed details `usage-hours`; the process's
 * memory is behind another.
 */
export function renderUsage(b, isOpen = () => false, sort = { key: "time", dir: "desc" }) {
  const at = utcMinute;
  const span = b.stepSeconds === null ? "every sample" : `${duration(b.stepSeconds)} a line`;
  const head = `<p class="dim">From ${esc(at(b.since))} to ${esc(at(b.until))} UTC, ${esc(span)} (a sample every ${esc(duration(b.sampleSeconds))}, kept ${b.keptDays} day${b.keptDays === 1 ? "" : "s"}).</p>`;
  let samples;
  if (!b.samples.length) samples = empty("No sample in this time: Mason takes the first a minute after it starts.");
  else {
    const withLag = b.samples.some((s) => s.streamLagBytes !== null || s.streamLagSeconds !== null);
    const cols = ["Time (UTC)", "Statements", "Errors", "Rows sent", "Bytes sent", "p95", "Copy", "Rows", "Failing", "Oldest", ...(withLag ? ["Lag"] : [])];
    // newest first unless the time's header turned it round (the charts read left to right, oldest first)
    const ordered = sort.dir === "asc" ? b.samples : [...b.samples].reverse();
    const head = (list) => `<thead><tr>${sortTh("hours", "time", list[0], sort)}${list.slice(1).map((c) => `<th scope="col"${c === "Time (UTC)" ? "" : ` class="num"`}>${esc(c)}</th>`).join("")}</tr></thead>`;
    const hours = panel(`<table class="samples">${head(cols)}<tbody>` + ordered.map((s) => {
      const c = sampleCells(s);
      return `<tr><th scope="row">${esc(c.time)}</th>${[c.statements, c.errors, c.rowsSent, c.bytesSent, c.p95, c.copy, c.rows, c.failing, c.oldest, ...(withLag ? [c.lag] : [])].map(num).join("")}</tr>`;
    }).join("") + "</tbody></table>");
    // the charts draw these numbers: then they are one click away, and open by the person's choice (keyed: a poll rewrites the hours)
    samples = (Object.keys(usageSpecs(b)).some((k) => CHARTS.some(([key]) => key === k)) ? details("usage-hours", `The numbers, ${perStep(b.stepSeconds ?? 60).replace(/^every /, "")} a line`, hours, isOpen("usage-hours"), "hours") : hours) +
      // the process's memory, an hour a line: a debugging aid, behind a closed details
      // (keyed: a poll rewrites the hours, and an open Memory stays open)
      details("usage-memory", "Memory", panel(`<table class="samples">${th(["Time (UTC)", "Memory"])}<tbody>` +
        ordered.map((s) => { const c = sampleCells(s); return `<tr><th scope="row">${esc(c.time)}</th><td>${esc(c.memory)}</td></tr>`; }).join("") + "</tbody></table>"), isOpen("usage-memory"), "memory");
  }
  return head + samples;
}

/** Each copy's own size, measured every 10 min (src/cli/usage.ts): table, bytes, when. */
export function renderCopySizes(sizes) {
  if (!sizes.length) return empty(`No copy measured yet: each is measured every ${duration(SIZE_EVERY_SECONDS)}.`);
  return `<p class="dim">Measured every ${esc(duration(SIZE_EVERY_SECONDS))}.</p>` + panel(`<table class="sizes">${th(["Table", "Size", "Measured at (UTC)"])}<tbody>` +
    sizes.map((c) => `<tr><th scope="row"><code class="name" title="${esc(c.table)}">${esc(c.table)}</code></th>${num(fileSize(c.bytes))}<td>${esc(c.at.slice(11, 16))}</td></tr>`).join("") + "</tbody></table>");
}

export const page = {
  id: "usage",
  hash: "observability/usage",
  parent: "observability",
  title: "Usage",
  create(ctx) {
    const opened = createOpenSet();
    const m = { open: opened.open, sort: { key: "time", dir: "desc" }, asking: null, outcome: null };
    const samples = () => usagePath(ctx.range());
    const activity = () => activityPath(ctx.range());
    const part = (path, render, says) => readPart(ctx, path, render, says);
    const actions = {
      sortHours() { m.sort = nextSort(m.sort, "time"); },
      askCancelStatement(session, statement) { m.asking = keyOf(session, statement); m.outcome = null; },
      dismissCancelStatement() { m.asking = null; },
      dismissCancelled() { m.outcome = null; },
      /** POST /api/cancel { session, statement }: the statement listed, never the one the session runs next (409). */
      async confirmCancelStatement(session, statement) {
        const r = await ctx.ask("/api/cancel", json("POST", { session, statement }));
        m.asking = null;
        m.outcome = "failure" in r ? { key: keyOf(session, statement), failure: r.failure } : { key: keyOf(session, statement), cancelled: r.body.cancelled, at: ctx.now().getTime() };
        // who is connected says its running statements too: both read again, so neither says the cancelled one runs
        await ctx.refresh([RUNNING, STATE]);
        return !("failure" in r);
      },
    };
    return {
      model: m,
      // Now: the running statements every poll, who is connected and the range's numbers every 5 s, the samples and
      // the unsupported SQL every minute. Any other range: each read once, when it is chosen (or on Refresh)
      reads: () => [{ path: activity(), everyMs: rangeEvery(ctx.range(), ACTIVITY_EVERY_MS) }, { path: samples(), everyMs: rangeEvery(ctx.range(), EVERY_MS) },
        { path: unsupportedPath(ctx.range()), everyMs: rangeEvery(ctx.range(), UNSUPPORTED_EVERY_MS) },
        ...(isLive(ctx.range()) ? [{ path: RUNNING, everyMs: POLL_MS }, { path: STATE, everyMs: ACTIVITY_EVERY_MS }] : [])],
      afterRead() {
        // a statement that ended since it was asked about has nothing left to cancel
        const r = ctx.read(RUNNING)?.body?.running;
        if (m.asking !== null && r && !r.some((x) => keyOf(x.session, x.statement) === m.asking)) m.asking = null;
      },
      actions,
      toggle: (target) => opened.toggle(target),
      click(d) {
        if (d.sortTable === "hours") return actions.sortHours() ?? true;
        const pair = (v) => v.split(":").map(Number);
        if (d.askCancel !== undefined) return actions.askCancelStatement(...pair(d.askCancel)) ?? true;
        if (d.dismissCancel !== undefined) return actions.dismissCancelStatement() ?? true;
        if (d.dismissCancelled !== undefined) return actions.dismissCancelled() ?? true;
        if (d.confirmCancel !== undefined) return actions.confirmCancelStatement(...pair(d.confirmCancel));
        return null;
      },
      charts: () => usageSpecs(ctx.read(samples())?.body),
      view() {
        const range = ctx.range();
        const live = isLive(range);
        const span = RANGES[rangeOf(range)].span;
        const a = ctx.read(activity());
        const running = live ? ctx.read(RUNNING)?.body : undefined;
        const sessions = live ? ctx.read(STATE)?.body?.sessions : undefined;
        const now = ctx.now().getTime();
        return {
          "usage-kpis": renderUsageKpis({ activity: a === undefined ? undefined : a.body ?? { failure: a.failure }, usage: ctx.read(samples())?.body, sessions, running: running?.running, range }),
          "usage-charts": renderCharts(ctx.read(samples())?.body, range),
          "usage-connected-h": live ? "Connected now" : `Connected in ${esc(span)}`,
          "usage-connected": live ? renderSessions(sessions, SESSIONS_TOP, range) : part(activity(), (b) => renderClients(b.clients, { range, now }), false),
          "usage-running-h": live ? "Running now" : `Slowest in ${esc(span)}`,
          "usage-running-lead": live ? `As <code>mason logs --running</code> lists them. Cancel stops one, as <code>mason cancel</code> does.`
            : `The statements that took longest to complete, as the request log recorded them.`,
          "usage-running": live ? (running ? renderRunning(running.running, m.asking, m.outcome, now) : "") : part(activity(), (b) => renderSlowest(b.slowest, { range, now }), false),
          unsupported: part(unsupportedPath(range), (b) => renderUnsupported(b, span), true),
          "usage-hourly": part(samples(), (b) => renderUsage(b, opened.has, m.sort), true),
          "usage-sizes": part(samples(), (b) => renderCopySizes(b.copySizes), false),
        };
      },
    };
  },
};
