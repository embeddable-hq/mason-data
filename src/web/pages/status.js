/**
 * THE OVERVIEW (#overview; `#status`, its old address, lands here; the module and its section keep the id `status`): what `mason status` prints — the run in one word (`readiness`)
 * and what it means for the synced data in a line with the Source under it, the facts card "Mason" (the Source, the
 * warnings, Mason's version, uptime and restarts, the disk, the tools connected), the changes the stream carries (replication
 * mode: its position, lag, last batch and the slot's hold on the database's WAL), the copies not finished (a bar each,
 * only while there are any), and the last day's unsupported SQL in a line. The statements, the slow, the refused and the
 * failed ones are the Queries page's; the sync's failures Sync events'. Reads `/api/state` every poll, the request log's
 * summary, the last day's failed events and the unsupported SQL every 30 s, the last 24 hours of usage (the
 * cards' sparklines) every 60 s. Never the engine's name.
 *
 * Laid out as a dashboard (docs/WEB-UI.md "Presentation"): the word with a big dot under its title, then KPI cards (the
 * copies in all, their rows, the last sync, the copy's file, the last day's statements and their p95, the last day's
 * errors and query errors — each its own fact, said once, with a sparkline of the last 24 hours where one helps), the
 * copies not finished, the facts card, the stream. Each card links into the view that lists what it
 * counts (the tables, filtered to the failed ones when a copy failed; Observability's Queries — the slow ones for the
 * p95, the refused or failed ones for the query errors —, Sync events' failures, and Usage).
 */

/** Where each card leads: the views that list what it counts (src/web/app.js hashes). */
// each with the range of what it counts — the statements of the last day, the sync's failures of the last day — never
// the Observability views' default, the last 15 minutes: a card that says 12 failed must land on the 12
const LINKS = { tables: "#tables", failedTables: "#tables?show=failed", usage: "#observability/usage?range=24h", queries: "#observability/queries?range=24h",
  slow: "#observability/queries?slow=1&range=24h", failedQueries: "#observability/queries?status=refused-or-failed&range=24h", failedEvents: "#observability/syncs?failures=1&range=24h" };
import { VIEW_HASHES } from "../routes.js";
import { statementMsText, bytesText, code, esc, fileSize, firstLine, n, percent, leftText, spanText, duration, entryName, streamRows, slotWarns, agoText, utcMinute, utcText, staleText, staleWhy,
  unsupportedEntry, usagePath, POLL_MS, card, cards, details, createOpenSet, skeleton, copyClick, readOnlyLine, tablesReadOnly, usersReadOnly } from "../shared.js";
import { spark, seriesOf, drawable } from "../charts.js";
import { readHost, hostEvery, hostKey, renderHostCard } from "../host-view.js";

/** The last 24 hours an hour a point: the cards' sparklines (Usage's read at its default range). */
const HOURLY = usagePath("24h");

/**
 * What a copying table's line says, and how full its bar is: src/cli/readiness.ts `copyingText`, line for line, so the
 * page and `mason status` say one thing (tests/web-page.test.ts holds the two equal).
 */
export function copyingText(copied, rowsEstimate, p) {
  const shown = copied + (p?.rowsReading ?? 0);
  const estimate = rowsEstimate !== null && rowsEstimate > 0 ? rowsEstimate : null;
  const past = estimate !== null && shown > estimate;
  const fraction = p !== undefined ? p.share : estimate === null ? null : Math.min(0.99, shown / estimate);
  const of = estimate === null ? "" : past ? ` · past the ~${n(estimate)} estimated` : ` of ~${n(estimate)}`;
  const rowsText = (k) => past ? `${n(k)} rows${of}` : `${n(k)}${of} rows`;
  if (p === undefined) return { fraction, text: rowsText(copied) };
  const since = p.readingSeconds === null ? "" : ` (${duration(p.readingSeconds)})`;
  const chunks = (k) => `${k} chunk${k === 1 ? "" : "s"}`;
  if (p.rowsPerSecond === null) {
    const first = p.reading === 0 ? "about to read the first chunk" : `reading the first ${p.reading === 1 ? "chunk" : chunks(p.reading)}${since}`;
    return { fraction, text: copied === 0 ? `${first}${estimate === null ? "" : ` · ~${n(estimate)} rows to sync`}` : `${rowsText(copied)} · resumed, ${first}` };
  }
  const parts = [rowsText(shown)];
  const allIn = p.reading === 0 && p.chunksDone >= p.chunksTotal;
  if (allIn) parts.push(`every chunk read (${p.chunksDone}): checking it and swapping it in`);
  else parts.push(`${p.reading === 0 ? "starting the next chunk" : `${chunks(p.reading)} reading${since}`}, ${p.chunksDone} of ~${p.chunksTotal} in`);
  parts.push(`${n(Math.round(p.rowsPerSecond))} rows/s`);
  if (!allIn && p.secondsLeft !== null) parts.push(leftText(p.secondsLeft));
  return { fraction, text: parts.join(" · ") };
}

/**
 * AN ADDED TABLE'S LINE, as `mason status` and `mason wait` print it after its bar (src/cli/commands.ts `tableLines`):
 * its state (done, unsynced, failed, copying, catching-up, waiting), how full its bar is, and what it says — a copied one with how it is kept
 * current and how old its copy is (`keptAge`).
 */
export function tableLine(t, now = Date.now()) {
  if (t.error) return { state: "failed", fraction: 1, what: t.copy?.phase === "done" ? copiedFailedText(t, now) : `its first sync failed: ${firstLine(t.error)}` };
  if (t.copy?.phase === "copying") {
    const c = copyingText(t.copy.rowsCopied, t.rows, t.copy.progress);
    return { state: "copying", fraction: c.fraction ?? 0, what: /^\d/.test(c.text) ? `syncing ${c.text}` : c.text };
  }
  if (!t.copy) return { state: "waiting", fraction: 0, what: "waiting for its first sync to start" };
  const age = keptWords(t, now), space = compactionWords(t.copy.compaction, now);
  const what = `${n(t.copy.rowsCopied ?? 0)} rows · synced${t.copy.retired ? ` · ${t.copy.retired}` : ""}${age ? ` · ${age}` : ""}${space ? ` · ${space}` : ""}`;
  // in its one catch-up poll: at work, the accent as mason status paints it cyan (paintBar), never amber (issue 834)
  if (t.sync?.state === "catching-up") return { state: "catching-up", fraction: 1, what };
  // a copy the poll does not keep current (it waits for its catch-up) is a warning, as mason status paints it (paintBar)
  // and so is one behind what its sync promises (`tables[].sync.state`, src/cli/readiness.ts behindOf), of any kind
  if ((t.kept?.by === "poll" && t.kept.pending !== undefined) || (t.kept?.by === "replication" && ((t.kept.state !== "streamed" && t.kept.state !== "compacting") || t.kept.notRunning !== null)) || t.sync?.state === "behind") {
    return { state: "unsynced", fraction: 1, what };
  }
  return { state: "done", fraction: 1, what };
}

/** What a served table's line says after `synced`, for every kind: its keeping and age, then behind (src/cli/commands.ts `keptWords`). */
export function keptWords(t, now = Date.now()) {
  const age = keptAge(t, now), s = t.sync;
  if (s?.state !== "behind" || s.behindBySeconds == null) return age;
  const why = s.behindWhy ?? "its next sync is late";
  const by = `behind by ${duration(s.behindBySeconds)}${age !== null && age.includes(why) ? "" : `: ${why}`}`;
  return age === null ? by : `${age} — ${by}`;
}

/** A synced table's space on its line (src/cli/commands.ts `compactionWords`, `DEAD_SAID_SHARE`; held equal by
 *  tests/web-page.test.ts): a failed compaction, the share of its stored rows deleted, or its last compaction. */
export function compactionWords(c, now = Date.now()) {
  if (c === undefined || c === null) return null;
  if (c.error !== null) return `its compaction failed${c.retryAt === null ? "" : `, tried again after ${c.retryAt.slice(11, 16)} UTC`} (Sync events says why)`;
  if (c.waiting) return `${c.deadShare === null ? "" : `${Math.floor(c.deadShare * 100)}% of its stored rows deleted, `}not compacted: ${c.waiting}`;
  if (c.deadShare !== null && c.deadShare >= 0.1) return `${Math.floor(c.deadShare * 100)}% of its stored rows deleted, not compacted yet`;
  return c.at === null ? null : `compacted ${syncedAgo(c.at, now)}`;
}

/** How long ago a table was synced, as `mason status` says it on its line (src/lib/table-sync.ts `agoText`, which
 *  writes `4 s ago`, `3 days ago`; shared.js `agoText` is mason status's `ago`, `4s ago`, for a stream's times). */
function syncedAgo(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** What a table in its one catch-up poll says (src/cli/readiness.ts `CATCHING_UP`, held equal by tests/web-page.test.ts). */
export const CATCHING_UP = "Getting the changes made since it was last synced. You can query it meanwhile.";

/** How a copied table is kept current and how old its copy is (src/cli/commands.ts `keptAge`). */
export function keptAge(t, now = Date.now()) {
  const k = t.kept;
  if (t.sync?.state === "catching-up" && k !== undefined && k.by !== "generated") {
    const at = k.by === "recopy" ? k.syncedAt ?? k.copiedAt : k.syncedAt;
    return `${CATCHING_UP} (${at === null ? "never synced" : `last synced ${syncedAgo(at, now)}`})`;
  }
  if (k?.by === "replication") {
    if (k.state === "compacting") return `replicated, ${k.syncedAt === null ? "never synced" : `last synced ${syncedAgo(k.syncedAt, now)}`} — ${k.why ?? "it is being compacted"}`;
    if (k.state !== "streamed") return `not kept current (${k.syncedAt === null ? "never synced" : `last synced ${syncedAgo(k.syncedAt, now)}`}): ${k.why ?? "it is not streamed yet"}`;
    const at = `replicated, at ${k.position}, ${k.syncedAt === null ? "not synced yet" : syncedAgo(k.syncedAt, now)}`;
    return k.notRunning === null || t.sync?.state === "behind" ? at : `${at} — not kept current now, the stream is not running: ${k.notRunning}`;
  }
  if (k?.by !== "poll") return null;
  const synced = k.syncedAt === null ? "never synced" : `last synced ${syncedAgo(k.syncedAt, now)}`;
  if (k.pending !== undefined) return `not kept current (${synced}): ${k.pending}`;
  // the page says how to do it on the page (its Sync now, its Sync choice), where mason status names the commands
  if (k.sync.mode === "off") return `sync off, ${synced}: press Sync now to sync it`;
  return `polled every ${k.sync.every}, ${k.syncedAt === null ? "not polled yet" : `last ${syncedAgo(k.syncedAt, now)}`}`;
}

/** A served table whose sync failed, as mason status says it (src/cli/commands.ts `copiedFailedText`). */
function copiedFailedText(t, now) {
  const k = t.kept;
  const reason = k?.by === "replication" ? (k.state !== "streamed" ? k.why : k.notRunning === null ? null : `the stream is not running: ${k.notRunning}`)
    : k?.by === "poll" || k?.by === "recopy" ? k.pending ?? null : null;
  const asOf = t.sync?.asOf ?? (k && k.by !== "generated" && k.by !== "recopy" ? k.syncedAt : null) ?? t.sync?.syncedAt ?? null;
  return `${n(t.copy?.rowsCopied ?? 0)} rows · synced · not kept current, its sync failed (${asOf === null ? "never synced" : `last synced ${syncedAgo(asOf, now)}`}): ${reason ?? firstLine(t.error)}`;
}

/**
 * A COPY'S BAR, the one renderer of the Overview's "copies not finished" and the Tables page's rows: a thin rounded
 * track and a solid fill to the share drawn, its % as text at the bar's END (as `mason wait` prints it beside its bar),
 * with an explicit `role="progressbar"` and `aria-valuemin/max/now` (and a text label, `aria-valuetext`, the line's
 * words); the track is `aria-hidden` drawing. `l` is `tableLine`'s, `fraction` the share to draw (`monotone`'s; the
 * line's own by default): the fill's colour is the line's state (the stylesheet's `.t-<state>`: green served, the accent
 * while it copies, amber not kept current, rose failed). A table waiting for its copy has no value: no fill but the
 * stylesheet's quiet shimmer over the track, `aria-valuenow` and the % left out. `from`, the share at the page's last
 * read (`monotone.before`), is kept for the callers; the fill's own transition moves it from there.
 */
export function copyBar(table, l, fraction = l.fraction, _from) {
  const waiting = l.state === "waiting";
  const value = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
  return `<span class="copybar${waiting ? " indeterminate" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100"` +
    `${waiting ? "" : ` aria-valuenow="${value}"`} aria-label="${esc(`${table}: its first sync`)}" aria-valuetext="${esc(waiting ? l.what : `${value}%, ${l.what}`)}">` +
    `<span class="track" aria-hidden="true"><span class="fill"${waiting ? "" : ` style="width: ${value}%"`}></span></span></span>` +
    // a copy not begun has no share yet: no "0%" at its end (its line says it waits)
    (waiting ? "" : ` <span class="pct">${percent(fraction)}</span>`);
}

/**
 * THE SHARES A PAGE DRAWS, NEVER BACKWARDS: for each added table that is copying, the most its share has been since the
 * copy began (the server's share is of pages and does not go back within a copy; this holds it so across a reconnect or
 * a re-read, too). A table that stops copying (done, failed, waiting) is forgotten, so its next copy begins at its own.
 * `of(s)` → Map(table → share) for the tables copying in the state `s`.
 */
export function createMonotone() {
  const seen = new Map();
  let before = new Map();
  return {
    /** The shares of the read before the last `of`: each copying table's (`copyBar`'s `from`). */
    get before() { return before; },
    of(s) {
      before = new Map(seen);
      const now = new Map();
      for (const t of s.tables) {
        if (!t.added) continue;
        const l = tableLine(t);
        if (l.state === "copying") now.set(t.table, Math.max(seen.get(t.table) ?? 0, l.fraction));
      }
      seen.clear();
      for (const [k, v] of now) seen.set(k, v);
      return now;
    },
  };
}

/** `mason status`'s rows for the Postgres the run syncs from (src/cli/commands.ts `sourceRows`, held equal by the tests):
 *  its sources file (from the project's root: the page never shows an absolute path), the Source (its URL as the run
 *  masked it, and what kind of server it is), and how text sorts where it differs. No row says how changes arrive
 *  (issue 935): the Tables page says each table's sync. */
export function sourceRows(s) {
  return [
    ...(s.source.file ? [["Sources file", `${s.source.shownFile ?? s.source.file} (the tables it names are added)`]] : []),
    ["Source", s.source.demo ? `the demo database Mason hosts (${s.source.url} · Postgres ${s.source.version})`
      // which kind of server it is, as a plain fact (issue 888), as mason status says it (src/cli/commands.ts sourceRows)
      : `${s.source.url} · Postgres ${s.source.version} · ${s.source.standby ? "a read replica" : "your main database"}`],
    ...(s.source.textOrder ? [["Text order", s.source.textOrder]] : []),
  ];
}

/** THE RUN IN ONE WORD, as `mason status` heads its last line (src/cli/readiness.ts `readinessWord`): Ready, Failed or
 *  Under way. */
export function readinessWord(r) {
  return r.ready ? "Ready" : r.failed.length ? "Failed" : "Under way";
}

/** The copies in all, as mason status's `Copies` row says them (src/cli/commands.ts `totalsText`). */
export function totalsText(t, now = Date.now()) {
  const last = t.syncedAt === null ? "" : `, the last synced ${duration((now - Date.parse(t.syncedAt)) / 1000)} ago`;
  return `${n(t.copied)} of ${n(t.added)} added synced, ${n(t.rows)} row${t.rows === 1 ? "" : "s"}${t.failed ? `, ${n(t.failed)} failed` : ""}${last}`;
}

/** What Ready means for the synced data, as `mason status` ends on it after the word (src/cli/readiness.ts `READY_TEXT`,
 *  held equal by tests/web-page.test.ts). */
export const READY_TEXT = "every added table is synced and served";

/**
 * WHAT THE WORD MEANS FOR THE SYNCED DATA, in one short line under it, from what `/api/state` says (`readiness`,
 * `totals`, the tables' `sync.state`): Ready, `READY_TEXT`; Failed, how many tables' syncs failed, and Tables (the failed
 * ones) to see them; Under way, how many of the added tables are synced and that the rest are syncing — or, every one
 * synced, how many are being caught up by their one poll. `{ text, link }`: `link` the words linked after the text, or null.
 */
export function readinessLine(s) {
  const r = s.readiness, t = s.totals;
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  if (r.ready) return { text: cap(READY_TEXT), link: null };
  if (r.failed.length) {
    const k = r.failed.length;
    return { text: `${n(k)} ${k === 1 ? "table's sync" : "tables' syncs"} failed: see `, link: "Tables" };
  }
  const added = t?.added ?? s.tables.filter((x) => x.added).length, copied = t?.copied ?? 0;
  if (copied < added) return { text: `${n(copied)} of ${n(added)} tables synced, the rest syncing`, link: null };
  const catching = s.tables.filter((x) => x.added && x.sync?.state === "catching-up").length;
  return { text: catching ? `Every added table is synced, ${n(catching)} being caught up by one poll` : "Every added table is synced, its last steps under way", link: null };
}

/** The word at the top of the page under its title, "mason status", and what it means in a line (`readinessLine`): the
 *  run's readiness ("" with no table added: `renderStatus` says so, and what adds one). While the poll fails (`stale`:
 *  `{ at, failure }`, `app.stale()`), the box it last read greyed, and under the word as of when and why ("As of 14:02
 *  UTC. Mason can't be reached."): never a Ready that reads as current (issue 886). */
export function renderHealth(s, stale = null) {
  const note = stale === null ? "" : `<p class="as-of">${esc(staleText(stale.at, stale.failure))}</p>`;
  if (!healthShown(s)) return note === "" ? "" : `<div class="health stale" role="status">${note}</div>`;
  const word = readinessWord(s.readiness);
  const line = readinessLine(s);
  const facts = sourceRows(s).filter(([k]) => HEALTH_ROWS.includes(k));
  return `<div class="health ${word === "Ready" ? "ok" : word === "Failed" ? "bad" : "warn"}${stale === null ? "" : " stale"}" role="status"><p class="health-title">mason status</p>` +
    `<p class="health-word"><span class="dot" aria-hidden="true"></span><span class="word">${esc(word)}</span></p>${note}` +
    `<p class="health-line">${esc(line.text)}${line.link === null ? "" : `<a href="${esc(LINKS.failedTables)}">${esc(line.link)}</a>`}</p>` +
    (facts.length ? `<dl class="health-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : "") + `</div>`;
}

/** The box with nothing read yet and the poll failing: Unknown, and why, greyed (the banner says what to do). */
export const renderUnknown = (failure) =>
  `<div class="health stale" role="status"><p class="health-title">mason status</p><p class="health-word"><span class="dot" aria-hidden="true"></span><span class="word">Unknown</span></p><p class="as-of">${esc(staleWhy(failure))}</p></div>`;

/** The box at the top is drawn once a table is added and the run says its readiness (`renderHealth`). */
const healthShown = (s) => s.tables.some((t) => t.added) && Boolean(s.readiness);

/** `mason status`'s rows (`sourceRows`) said in the box at the top, under its line: the Postgres the run syncs from. */
const HEALTH_ROWS = ["Source"];

/** The sparklines the cards draw, by holder key: a usage sample's field each (src/web/charts.js specs). */
const SPARKS = { rows: ["copyRows", "Rows synced"], "copy-bytes": ["copyBytes", "Synced data size"], statements: ["statements", "Queries"], p95: ["durationP95Ms", "p95"] };

/** The sparklines' specs from the usage answer (`/api/usage`'s body; anything else draws none): what `charts()` returns. */
export function sparkSpecs(usage) {
  const samples = usage && Array.isArray(usage.samples) ? usage.samples : [];
  return Object.fromEntries(Object.entries(SPARKS).map(([key, [field, label]]) => [key, { kind: "spark", label, ...seriesOf(samples, field) }]).filter(([, spec]) => drawable(spec)));
}

/** How many added tables are copying now (tableLine's word), the cards' "N copying". */
export const copyingCount = (s) => s.tables.filter((t) => t.added && tableLine(t).state === "copying").length;

/**
 * THE KPI CARDS: the copies in all (synced of added, the failed), their rows, the last sync (how long ago, and when),
 * the copy's file (its size, or why it is unknown), the last day's statements and their p95 from the request log
 * (`q`: `/api/queries`' body, or `{ failure }`), and the last day's errors: the sync's failed events (`o.syncErrors`:
 * `/api/events?failed=1&since=24h`'s body, or `{ failure }`) and the statements refused or failed (`q`'s `day`). A count
 * that could not be read is "unknown" with its reason, never 0; one not read yet is not shown. Each card's sparkline is the last 24 hours (`usage`), only where there
 * are two hours to draw; its numbers are the card's text either way. These facts are said here, and not in the facts table.
 * The host's card is not among them: `renderStatus` draws it first, above everything (issue 1001).
 */
export function renderKpis(s, o = {}) {
  const now = o.now ?? Date.now();
  const sparks = sparkSpecs(o.usage);
  const line = (key) => sparks[key] ? spark(key, `${SPARKS[key][1]}, the last 24 hours, one point an hour`) : "";
  const list = [];
  const t = s.totals;
  // as renderStatus judges it: a table added (the totals count what the sources file names)
  const added = Boolean(t) && s.tables.some((x) => x.added);
  if (added) list.push(
    card("Tables synced", `${n(t.copied)} of ${n(t.added)}`, `added${t.failed ? `, ${n(t.failed)} failed` : ""}${copyingCount(s) ? `, ${n(copyingCount(s))} syncing` : ""}`, "", t.failed ? "bad" : "", t.failed ? LINKS.failedTables : LINKS.tables),
    card("Rows", n(t.rows), "", line("rows"), "", LINKS.tables),
    t.syncedAt === null ? card("Last sync", "none yet", "", "", "", LINKS.tables) : card("Last sync", `${duration((now - Date.parse(t.syncedAt)) / 1000)} ago`, `${utcText(t.syncedAt)} UTC`, "", "", LINKS.tables));
  const d = s.disk;
  const copyBytes = s.engine.bytes ?? (d && typeof d.copyBytes === "number" ? d.copyBytes : null);
  if (added || copyBytes !== null) list.push(copyBytes === null ? card("Synced data", "unknown", "its size could not be read", "", "", LINKS.usage) : card("Synced data", fileSize(copyBytes), "", line("copy-bytes"), "", LINKS.usage));
  const q = o.queries;
  if (added && q !== undefined) {
    if ("failure" in q) list.push(card("Queries, last day", "unknown", `could not be read: ${firstLine(q.failure.message)}`, "", "", LINKS.queries));
    else {
      const day = q.queries.day;
      const bad = day.refused + day.failed + day.cancelled;
      list.push(card("Queries, last day", n(day.statements), `${n(day.completed)} completed${bad ? `, ${n(bad)} refused, failed or cancelled` : ""}`, line("statements"), day.failed ? "warn" : "", LINKS.queries),
        card("p95, last day", day.durationMs === null ? "–" : statementMsText(day.durationMs.p95),
          day.durationMs === null ? "no query completed" : `average ${statementMsText(day.durationMs.avg)} · p50 ${statementMsText(day.durationMs.p50)}`, line("p95"), "", LINKS.slow));
    }
  }
  const ev = o.syncErrors;
  if (added && ev !== undefined) {
    if ("failure" in ev) list.push(card("Errors, last day", "unknown", `could not read them: ${firstLine(ev.failure.message)}`, "", "", LINKS.failedEvents));
    else {
      // every failed event (src/duck/events.ts isFailure): a sync that failed, the database out of reach, a restart, the
      // web page's own error — so its line names them all, never "sync" alone
      const k = ev.events.filter((e) => e.failed).length;
      // the read is capped (SYNC_ERRORS_LIMIT): at the cap there may be more, said as at least that many
      const capped = ev.events.length >= SYNC_ERRORS_LIMIT;
      list.push(card("Errors, last day", `${n(k)}${capped ? "+" : ""}`, `${capped ? `at least ${n(k)}: ` : ""}${ERRORS_COUNTED}`, "", k ? "bad" : "", LINKS.failedEvents));
    }
  }
  if (added && q !== undefined) {
    if ("failure" in q) list.push(card("Query errors, last day", "unknown", `could not read them: ${firstLine(q.failure.message)}`, "", "", LINKS.failedQueries));
    else {
      // the big number is the queries that failed (Mason's or the machine's fault); the refused ones (the query's own
      // fault, such as SQL Mason does not support) are its small line
      const day = q.queries.day;
      list.push(card("Query errors, last day", n(day.failed), `${n(day.refused)} refused`, "", day.failed ? "warn" : "", LINKS.failedQueries));
    }
  }
  return cards(list);
}

/** What the Errors card counts, its small line: every failed event of the last day (`/api/events?failed=1`). */
export const ERRORS_COUNTED = "failed syncs, restarts and web page errors";

/** A fact's row; `warn` marks one the reader should act on. */
const factRow = (k, v, warn = false) => `<tr${warn ? ` class="warn"` : ""}><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;

/** The stream's lag, said once: the bytes behind the database and the age of the newest change applied. */
const lagText = (lag) => `${lag.bytes === null || lag.bytes === undefined ? "bytes behind unknown" : `${bytesText(lag.bytes)} behind the database`}${lag.seconds === null || lag.seconds === undefined ? "" : `, the newest change applied was committed ${spanText(lag.seconds)} ago`}`;

/**
 * THE CHANGES THE STREAM CARRIES (replication mode: `/api/state` `stream`; "" without one), a table of facts: whether it
 * runs and why not, its position, its lag, the last batch applied (`streamRows`, held equal to `mason status`'s
 * `streamLines`), and the WAL the slot holds on the database (`slotText`, one of its rows). Each table's own stream state is the Tables page's.
 */
function renderStream(s, now = Date.now()) {
  const st = s.stream;
  if (!st) return "";
  const { head } = streamRows(st, now);
  // `head` is the CLI's rows: "stream" (only when it is not running, and why), the position, the last change
  const label = (k) => k[0].toUpperCase() + k.slice(1);
  const rows = [...(st.running ? [factRow("Stream", "running")] : []), ...head.map(([k, v]) => factRow(label(k), v, k === "stream" || (k === "slot" && slotWarns(st.slotWal))))];
  rows.splice(2, 0, factRow("Lag", lagText(st.lag)));
  return `<table class="facts-table"><caption>Changes (the stream${s.source.replication ? `, slot ${esc(s.source.replication.slot)}` : ""})</caption><tbody>${rows.join("")}</tbody></table>`;
}

/** Postgres's version as the page says it: the number alone (`16.15`), without the server's build in brackets. */
const pgVersion = (v) => String(v ?? "").split(" ")[0];

/** A time as the facts say it: `16:03 UTC` on the day of `now`, else with its date. */
const sinceText = (iso, now) => `${iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? iso.slice(11, 16) : utcMinute(iso)} UTC`;

/**
 * THE FACTS CARD'S ROWS, `[label, value, warn]` each, in the page's own words (`mason status` keeps its fuller rows):
 * the Postgres Mason reads from, as "Source" (its name, where it is, its Postgres version, and whether it is the main
 * database or a read replica: issue 935 names it Source, as the box at the top and `mason status` do); the run's
 * warnings (where the database is and whether it is the main one are never among them: issue 888 — the card says both
 * from `source.remote` and `source.standby`, never by reading a warning's words); Mason's version and how long it has
 * been up; its restarts, only when there were any; the free disk beside what the synced data takes; and the tools
 * connected. A fact the run did not say is absent; one it could not read says so, with its reason (never a 0).
 */
export function factRows(s, now = Date.now()) {
  const src = s.source, e = s.engine, d = s.disk, ss = s.sessions;
  const rows = [["Source", src.demo ? `the demo database Mason runs · Postgres ${pgVersion(src.version)}`
    : `${src.database} on ${src.host} · Postgres ${pgVersion(src.version)} · ${src.standby ? "a read replica" : "your main database"}`, false]];
  rows.push(...s.warnings.map((w) => ["Warning", w, true]));
  if (typeof e.version === "string") rows.push(["Mason", `${e.version}${e.startedAt ? ` · up ${spanText(e.uptimeSeconds ?? 0)}, since ${sinceText(e.startedAt, now)}` : ""}`, false]);
  const r = e.restarts;
  if (r !== undefined && "error" in r) rows.push(["Restarts", `unknown: ${firstLine(r.error)}`, true]);
  else if (r !== undefined && r.last !== null) rows.push(["Restarts", `${r.count}, the last ${agoText(r.last.at, now)}: ${r.last.why}, after ${r.last.upSeconds} s up`, true]);
  if (d !== undefined) {
    const uses = typeof d.copyBytes === "number" ? ` · the synced data uses ${fileSize(d.copyBytes)}` : "";
    const adds = d.projectedBytes === null ? "" : ` · the first syncs running need about ${fileSize(d.projectedBytes)} more`;
    const over = d.freeBytes !== null && d.projectedBytes !== null && d.projectedBytes > d.freeBytes;
    rows.push(["Disk", d.freeBytes === null ? `${firstLine(d.error ?? "the free space could not be read")}${uses}${adds}`
      : `${fileSize(d.freeBytes)} free${uses}${adds}${over ? ". That is more than is free: the sync stops before the disk fills" : ""}`, d.freeBytes === null || over]);
  }
  if (ss !== undefined) {
    const tools = "error" in ss ? null : ss.byClient.length;
    rows.push(["Connected tools", tools === null ? `unknown: ${firstLine(ss.error)}` : ss.open === 0 ? "none" : `${n(Math.max(1, tools))} connected`, false]);
  }
  return rows;
}

/** A database on another machine, in the words `mason init` and `mason start` say it (src/cli/preflight.ts REMOTE_NOTE). */
export const REMOTE_NOTE = "Your database is on another machine. Mason will sync the tables you choose to this machine.";

/** The facts card's quiet lines, in the page's words: that the database is on another machine (information, not a
 *  warning: `REMOTE_NOTE`), and how text sorts when it differs from the database (`source.textOrder`; nothing when it
 *  sorts the same). */
export function factNotes(s) {
  const notes = [];
  if (s.source.remote === true && !s.source.demo) notes.push(REMOTE_NOTE);
  const t = s.source.textOrder;
  if (t) notes.push(/could not read/.test(t) ? "Mason can't sort text the way your database does, so it refuses to sort text in a query. Add COLLATE \"C\" to sort it (docs/SQL-SUPPORT.md explains why)."
    : "Text sorts as in your database, except some rare symbols (docs/SQL-SUPPORT.md explains which).");
  return notes;
}

/**
 * THE FACTS CARD, "Mason" (the owner, 2026-11-13: main's card, kept): `factRows` in a table, a row the reader should act
 * on marked, then `factNotes` as quiet lines. What `mason status` says beside it (the sources file, the sync settings,
 * the page's socket) is not here: the Tables page shows and changes each table's sync, and the page names no file.
 */
export function renderFacts(s, now = Date.now()) {
  const notes = factNotes(s);
  return `<table class="facts-table"><caption>Mason</caption><tbody>${factRows(s, now).map(([k, v, warn]) => factRow(k, v, warn)).join("")}</tbody></table>` +
    notes.map((x) => `<p class="info fact-note">${esc(x)}</p>`).join("");
}

/**
 * THE COPIES NOT FINISHED, a bar each as `mason status` and `mason wait` print them (`tableLine`): copying, waiting,
 * failed, or copied but not kept current — and nothing once every copy is done. With no table added, the commands'
 * sentence and what adds one.
 */
function renderProgress(s, isOpen = () => false, shares = new Map(), before = new Map()) {
  const picked = s.tables.filter((t) => t.added);
  if (!picked.length) {
    return `<p class="readiness">No table added yet. Your database has ${n(s.tables.length)}.</p>` +
      (tablesReadOnly(s) !== null || s.sourcesReadOnly ? `<p class="dim">The tables to sync are set in the sources file.</p>`
        : `<p class="dim">Add one on the <a href="${LINKS.tables}">Tables</a> page.</p>`);
  }
  // as tableLines orders them: the finished first, in the order they finished, then the failed, the copying, the waiting
  const rank = { done: 0, unsynced: 0, failed: 1, copying: 2, "catching-up": 2, waiting: 3 };
  const lines = picked.map((t) => ({ t, l: tableLine(t) })).filter(({ l }) => l.state !== "done")
    .sort((a, b) => rank[a.l.state] - rank[b.l.state] || (a.t.copy?.updatedAt ?? "").localeCompare(b.t.copy?.updatedAt ?? "") || a.t.table.localeCompare(b.t.table));
  if (!lines.length) return "";
  return `<h3>Tables not synced yet (${lines.length} of ${picked.length} added)</h3>` +
    `<table class="tables"><thead><tr><th scope="col">Table</th><th scope="col">Sync</th><th scope="col"></th></tr></thead><tbody>${lines.map(({ t, l }) =>
      `<tr class="t-${l.state}"><th scope="row"><code class="name" title="${esc(t.table)}">${esc(t.table)}</code></th>` +
      `<td class="bar">${copyBar(t.table, l, shares.get(t.table) ?? l.fraction, before.get(t.table))}</td>` +
      `<td class="what">${esc(l.what)}${t.error && t.error.includes("\n") ? details(`error:${t.table}`, "the whole error", `<pre>${esc(t.error)}</pre>`, isOpen(`error:${t.table}`)) : ""}</td></tr>`).join("")}</tbody></table>`;
}

/**
 * THE UNSUPPORTED SQL OF THE LAST DAY in one line, as mason status heads it (`/api/unsupported`'s body, its default day):
 * the most refused entry's line (`unsupportedEntry`), how many others there are, and See all (Observability › Queries
 * lists each). Nothing when none was refused; one that could not be read says why, as mason status does.
 */
export function renderUnsupportedLine(u) {
  if (u === undefined) return "";
  if ("failure" in u) return `<p class="count">The unsupported SQL could not be read: ${esc(firstLine(u.failure.message))}.</p>`;
  const [top, ...rest] = u.unsupported;
  if (top === undefined) return "";
  return `<p class="unsupported-line"><strong>Unsupported SQL, last day:</strong> <span title="docs/SQL-SUPPORT.md entry ${esc(top.gap)}">${esc(unsupportedEntry(top).headline)}</span>` +
    `${rest.length ? ` (and ${n(rest.length)} other${rest.length === 1 ? "" : "s"})` : ""} <a class="see" href="${esc(LINKS.queries)}">See all</a></p>`;
}

/**
 * THE FIRST-RUN CHECKLIST, while setting up is not done: Mason is running (the state answered), Sync a table (an added
 * table synced: `tables[].copy.phase` done), Create a user (a user exists, not removed: `/api/state` `users.active`) —
 * each step in its words done or not (the ✓ or ○ says which), a ○ with its one action: Add a table (Tables), Add a user
 * (Users). THE OWNER'S RULE (2026-11-13): done while a table is synced AND a user exists, read from the state alone;
 * never whether a tool has queried Mason, so a deployment nobody queried for a week stays done. Every table or every
 * user removed: not done again. "" once both are done, and while it cannot tell whether a user exists (`users` an
 * error, or a run that does not say): a checklist never says ○ for what it could not tell.
 */
export function renderChecklist(s) {
  const added = s.tables.some((t) => t.added);
  const copied = s.tables.some((t) => t.added && t.copy?.phase === "done");
  const u = s.users;
  if (u === undefined || u === null || typeof u.active !== "number") return "";
  const user = u.active > 0;
  if (copied && user) return "";
  const copying = added && !copied && copyingCount(s) > 0;
  // a read-only page (MASON_UI_READ_ONLY=1) sends no one to add what it would refuse to add: a user unless its users
  // are still its own (MASON_UI_READ_ONLY_ALLOW=users), and a table unless its tables are (=tables)
  const looks = usersReadOnly(s) !== null;
  const tablesLook = tablesReadOnly(s) !== null;
  const steps = [
    ["Mason is running", true, ""],
    ["Sync a table", copied, copying ? `<span class="dim">syncing now</span>` : added || tablesLook ? "" : `<a class="btn small primary" href="${LINKS.tables}">Add a table</a>`],
    ["Create a user", user, looks ? "" : `<a class="btn small${copied ? " primary" : ""}" href="#users">Add a user</a>`],
  ];
  const done = steps.filter(([, ok]) => ok).length;
  return `<div class="checklist" role="group" aria-label="Getting started"><p class="checklist-title"><span class="courses" aria-hidden="true">${steps.map(([, ok]) => `<i${ok ? ' class="on"' : ""}></i>`).join("")}</span>Getting started <span class="dim">${done} of ${steps.length} done</span></p><ol>` +
    steps.map(([what, ok, action]) => `<li class="${ok ? "step-done" : "step-todo"}"><span class="mark" aria-hidden="true">${ok ? "✓" : "○"}</span><span class="what">${esc(what)}<span class="sr">${ok ? " (done)" : " (to do)"}</span></span>${ok ? "" : action}</li>`).join("") +
    `</ol></div>`;
}

/** What a read-only page's Overview does not do (`readOnlyLine`'s words), by what it still may (MASON_UI_READ_ONLY_ALLOW):
 *  a table unless `tables`, a user unless `users`; null when it still does both (no line). */
const readOnlyWhat = (tables, users) => tables && users ? null : tables ? "No user is created" : users ? "No table is added" : "Nothing is added or created";

/**
 * THE OVERVIEW from `/api/state` and the slower reads (`o.queries`, `o.syncErrors`, `o.unsupported`, `o.usage`:
 * each the body, or `{ failure }`; `o.now` the clock; `o.open(key)` whether a details is open; `o.stale` `{ at, failure }`
 * while the poll fails, the box then greyed and as of when): the word, the checklist,
 * the cards, the copies not finished, the facts, the stream, the unsupported SQL's line. Never the engine's name.
 * WHILE GETTING STARTED IS NOT DONE, the word's box and the checklist alone (the owner, 2026-11-13); the cards and the
 * rest once its three steps are done. The word's box is always shown (the owner, 2026-11-13, later that day), so the
 * state of the synced data is never hidden behind "Sync a table ○".
 * THE HOST'S CARD (`/api/state` `pageCard`, mason serve's MASON_UI_OVERVIEW_CARD; `o.hostCard` its read) is drawn FIRST,
 * above everything, at the full width, while getting started too (issue 1001: it is for what needs the person's
 * attention, a maintenance notice or a disk warning). Before its first answer, and while the host says nothing
 * (`sections: []`), nothing is drawn (src/web/host-view.js `renderHostCard`). Without it, nothing changes.
 */
export function renderStatus(s, o = {}) {
  const now = o.now ?? Date.now();
  const added = s.tables.some((t) => t.added);
  // a read-only page (MASON_UI_READ_ONLY=1): why it offers no user and no table to add, as Tables and Users say it
  const what = readOnlyWhat(tablesReadOnly(s) === null, usersReadOnly(s) === null);
  const lead = (typeof s.pageCard === "string" ? renderHostCard(o.hostCard) : "") + (what === null ? "" : readOnlyLine(what, s.pageReadOnly));
  const checklist = renderChecklist(s);
  if (checklist !== "") return lead + renderHealth(s, o.stale ?? null) + checklist;
  return lead + renderHealth(s, o.stale ?? null) + renderKpis(s, { ...o, now }) +
    renderProgress(s, o.open, o.shares, o.before) + renderFacts(s, now) + renderStream(s, now) + (added ? renderUnsupportedLine(o.unsupported) : "");
}

/** The most entries of the unsupported SQL `/api/unsupported` answers (src/cli/run-server.ts MAX_UNSUPPORTED_LIMIT, held
 *  equal by the tests): the Overview says the first and counts the others, so it reads them all. */
export const UNSUPPORTED_LIMIT = 100;

/** The most of the last day's failed sync events the Overview reads to count them (`/api/events`' limit): at it, the card
 *  says at least that many. */
export const SYNC_ERRORS_LIMIT = 1000;

/** What the page reads every 30 s beside the state: the request log's summary (the statements' and query errors' cards,
 *  and whether a tool has used Mason: the checklist), the last day's failed events (the Errors card) and the last
 *  day's unsupported SQL. */
const SLOWER = ["api/queries", `api/events?failed=1&since=24h&limit=${SYNC_ERRORS_LIMIT}`, `api/unsupported?limit=${UNSUPPORTED_LIMIT}`];

/** A read as `renderStatus` takes it: the body, or `{ failure }` when it could not be read; undefined before any read. */
const asRequest = (r) => r === undefined ? undefined : r.failure ? { failure: r.failure } : r.body;

export const page = {
  id: "status",
  hash: VIEW_HASHES.status,
  title: "Overview",
  create(ctx) {
    // the details open (a copy's whole error), by key: a poll rewrites the section, and they stay open
    const opened = createOpenSet();
    const monotone = createMonotone();
    // the host's card (MASON_UI_OVERVIEW_CARD), once the state names it: read when the Overview is shown, and again at
    // its own `refresh` while it is (src/web/host-view.js)
    const cardPath = () => { const p = ctx.read("api/state")?.body?.pageCard; return typeof p === "string" ? p : null; };
    const hostCardReads = () => {
      const p = cardPath();
      return p === null ? [] : [{ path: hostKey(p), everyMs: hostEvery(ctx.read(hostKey(p))?.body), ask: (fetchFn) => readHost(fetchFn, p) }];
    };
    return {
      model: { open: opened.open },
      // its word says as of when while the poll fails: the banner does not say it again
      saysStale: true,
      reads: () => [{ path: "api/state", everyMs: POLL_MS }, ...SLOWER.map((path) => ({ path, everyMs: 30_000 })), { path: HOURLY, everyMs: 60_000 }, ...hostCardReads()],
      view() {
        const st = ctx.read("api/state");
        if (!st?.body) return { status: st?.failure ? renderUnknown(st.failure) : skeleton(4) };
        const [queries, syncErrors, unsupported] = SLOWER.map((p) => asRequest(ctx.read(p)));
        return { status: renderStatus(st.body, { now: ctx.now().getTime(), stale: st.failure && st.readAt !== undefined ? { at: new Date(st.readAt), failure: st.failure } : null, queries, syncErrors, unsupported, usage: ctx.read(HOURLY)?.body, hostCard: cardPath() === null ? undefined : ctx.read(hostKey(cardPath())), open: opened.has, shares: monotone.of(st.body), before: monotone.before }) };
      },
      toggle: (target) => opened.toggle(target),
      // the host card's Copy buttons
      click: (d, button, env) => copyClick(d, button, env),
      charts: () => sparkSpecs(ctx.read(HOURLY)?.body),
    };
  },
};
