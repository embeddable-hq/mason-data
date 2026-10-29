/**
 * THE TABLES PAGE (#tables): the database's tables in ONE table, as `mason tables` lists them. An added table shows its
 * copy's sync — state, rows, last sync and its age, how long it took, the copy's own size, and in replication mode its
 * stream state — and its error, with Sync (POST /api/sync, `mason sync`) and Remove (POST /api/remove, `mason remove`);
 * one not added shows its rows and key and why it cannot be added as it is, with Add, Columns… and Name its key…
 * (POST /api/pick, `mason add`). A search box filters by name, and All / Added / Failed / Not added by state
 * (`#tables?show=failed`, where the Overview's card leads). With hundreds of tables the page writes the first
 * TABLE_ROWS that pass and "Show N more" / "Show all" (the search is over all of them, at once); a long name is cut with
 * an ellipsis, its whole the title. Reads `/api/state` every poll (lean: no table's columns) and `/api/usage`'s
 * `copySizes` every minute; a table's columns once, when its Columns… or Name its key… form opens
 * (`GET /api/tables/<table>/columns`, `columnsPath`).
 */
import { msText, bytesText, button, card, cards, code, createOpenSet, moreRows, details, empty, entryName, esc, fileSize, firstLine, json, n, panel, renderFailure, rowsHtml, spanText, duration, status, streamRows, utcText, pop, fresh, actId, ROOMS, POLL_MS } from "../shared.js";
import { copyBar, copyingCount, createMonotone, tableLine } from "./status.js";

/** `/api/usage` asked for the copies' own sizes alone: the last minute's samples (none needed), and `copySizes`. */
const SIZES_PATH = "/api/usage?since=1m";

/** Where one table's columns are read, when its form opens (src/cli/run-server.ts tableColumns): never with the state,
 *  which is polled every 2 s and would carry every table's (3.4 MB at 800 tables of 50 columns). */
/** A table's sync events: Observability › Syncs narrowed to it (src/web/pages/syncs.js `route`). */
export const syncsHref = (table) => `#observability/syncs?table=${encodeURIComponent(table)}`;
export const columnsPath = (table) => `/api/tables/${encodeURIComponent(table)}/columns`;

/** A table's sync in one word (`/api/state` `tables[].sync.state`, src/cli/readiness.ts `syncStateOf`). */
const SYNC_WORDS = { synced: "Synced", syncing: "Syncing", failed: "Failed", waiting: "Waiting" };

/** Whether a table's name has the search box's text (any case; nothing typed: every table). */
const nameMatches = (table, filter) => !filter || table.toLowerCase().includes(filter.trim().toLowerCase());

/**
 * WHAT A SYNC DID, as `mason sync` prints it from `POST /api/sync`'s answer (src/cli/sync.ts `syncedReport`, held equal
 * by the tests): the rows written and deleted, a line per table, and that a table the passes do not keep current stays
 * as of this sync.
 */
export function syncedReport(b, picked, unsynced) {
  const changed = b.tables.reduce((a, t) => a + t.changed, 0), deleted = b.tables.reduce((a, t) => a + t.deleted, 0);
  return {
    headline: `Synced ${picked.join(", ")}: ${n(changed)} row(s) written, ${n(deleted)} deleted.`,
    details: b.tables.map((t) => [t.table, `${n(t.changed)} changed, ${n(t.deleted)} deleted, ${n(t.rows)} rows now · ${msText(t.ms)}`]),
    tips: unsynced.filter((t) => t.unsynced !== undefined).map((t) => `${t.table} is ${t.unsynced.reason}: it stays as of this sync until the next mason sync (mason start --replication keeps every table current)`),
  };
}

/** A sync's answer said as `mason sync` says it, with Dismiss. `s`: the state, for the tables not kept current. */
function renderSynced(b, table, s) {
  const r = syncedReport(b, [table], s.tables.filter((t) => t.table === table));
  return `<div class="done"><p class="headline">${esc(r.headline)}</p>${rowsHtml(r.details)}${r.tips.map((x) => `<p class="tip">Tip: ${esc(x)}</p>`).join("")}` +
    `${button("Dismiss", { dismissSynced: "", popClose: "" }, "small")}</div>`;
}

/** The filter beside the search box: which of the database's tables are listed. */
export const SHOWS = { all: "All", added: "Added", failed: "Failed", "not-added": "Not added" };

/** How many of the tables that pass the filters the page writes at once; "Show N more" writes as many again. */
const TABLE_ROWS = 100;

/** Whether an added table's copy or sync failed (the Failed filter, the Overview's failed card). */
const failedTable = (t) => t.added && (t.sync?.state === "failed" || Boolean(t.error));

/** What brought a copy current, in a web developer's words (`/api/state` `tables[].sync.syncedBy` keeps the mechanism's
 *  name for an operator: copy, poll, catch-up, stream). */
export const SYNCED_BY = { copy: "copied whole", poll: "changes checked", "catch-up": "changes checked", stream: "streamed" };
/** How long a sync took, as the commands say it (`spanText`) but for one under a tenth of a second, which is not worth a
 *  digit: `<0.1 s`; what did it is the cell's title (`tookTitle`: the column stays narrow enough for Sync and Remove). */
export const tookText = (y) => y.syncSeconds < 0.1 ? "<0.1 s" : spanText(y.syncSeconds);
export const tookTitle = (y) => SYNCED_BY[y.syncedBy] ?? String(y.syncedBy);

/** A table's facts as `mason tables` says them on its line (src/cli/commands.ts `tableFacts`): its size, its key, and
 *  added or why it cannot be added as it is (null: neither). */
export function tableFacts(t) {
  return { size: t.rows === null ? "rows unknown" : `~${n(t.rows)} rows`, key: t.key.length ? `key ${t.key.join(", ")}` : "no key",
    state: t.added ? "added" : t.reason ? `cannot be added as it is: ${t.reason}` : null };
}

/** What `mason add` prints for a table added, from `/api/pick`'s answer (src/cli/commands.ts `addedLines`): its line,
 *  then its notes — the key added to the columns asked, the secret-looking columns left out. */
export function addedLines(b, file) {
  const copies = b.columns === null ? (b.exclude.length ? `every column but ${b.exclude.join(", ")}` : "every column") : b.columns.join(", ");
  const s = b.skippedSecrets;
  return { line: `Added ${b.table} to ${file}: ${copies}${b.key ? `, copied by ${b.key.join(", ")}` : ""}${b.already ? " (already so)" : ""}`, notes: [
    ...(b.addedKey.length ? [`key added: ${b.addedKey.join(", ")} (a copy always has its key)`] : []),
    ...(s.length ? [`left out ${s.join(", ")}: ${s.length === 1 ? "it looks" : "they look"} like ${s.length === 1 ? "a secret" : "secrets"}, ` +
      `which anyone with a user's password could read (--include ${s[0]} adds it)`] : []),
  ] };
}

/** What `mason remove` prints for the tables removed (src/cli/commands.ts `removedReport`). */
export function removedReport(removed, file) {
  return { headline: `Removed ${removed.join(", ")}`, details: [["from", file]],
    tips: [`Mason stops copying ${removed.length === 1 ? "it" : "them"} and drops ${removed.length === 1 ? "its copy" : "their copies"}`] };
}

/**
 * `POST /api/pick`'s body for a table added: the columns ticked as `--columns`, the key's as `--key`, each left out when
 * none is ticked (none: every column, as `mason add <table>` copies; no key: its primary key). What the lists may hold
 * is the server's to judge (src/cli/run-server.ts `pick`), never the page's.
 */
export const pickBody = (table, columns = [], key = []) => ({ table, picked: true, ...(columns.length ? { columns } : {}), ...(key.length ? { key } : {}) });

/** The sources file as the commands name it, from the project's root (`/api/state` `source.shownFile`), when it is the
 *  one the state names: the page never shows an absolute path. */
const shownFileOf = (s, file) => s?.source?.file === file && typeof s.source.shownFile === "string" ? s.source.shownFile : file;

/** A table just added (`/api/pick`'s answer, `mason add --json`'s `added` entry): the line and notes `mason add` prints,
 *  the sources file named as `file` (as `mason add` names it: from the project's root). */
export function renderTableAdded(b, file = b.file) {
  const l = addedLines(b, file);
  return `<div class="done"><p class="headline">${esc(l.line)}</p>${l.notes.map((x) => `<p class="note">${esc(x)}</p>`).join("")}` +
    `${button("Dismiss", { dismissOutcome: "", popClose: "" }, "small")}</div>`;
}

/** Tables just removed (`/api/remove`'s answer, `mason remove --json`'s shape): what `mason remove` prints, the file named
 *  as `file`. */
export function renderTablesRemoved(b, file = b.file) {
  const r = removedReport(b.removed, file);
  return `<div class="done"><p class="headline">${esc(r.headline)}</p>${rowsHtml(r.details)}${r.tips.map((x) => `<p class="tip">Tip: ${esc(x)}</p>`).join("")}` +
    `${button("Dismiss", { dismissOutcome: "", popClose: "" }, "small")}</div>`;
}

const tick = (name, c, on) => `<label class="tick"><input type="checkbox" name="${name}" value="${esc(c.name)}"${on ? " checked" : ""}> ${code(c.name)} <span class="dim">${esc(c.type)}</span></label>`;

/** The form that adds a table with the columns ticked (`--columns`) and, for one with no primary key, its key (`--key`).
 *  The ticks live in the document while the person ticks (the tables part is held still meanwhile: the page's `held`);
 *  `ticked`, what a refused submit sent, writes them back when the refusal is said over the form, in its popover. `cols` is what
 *  `GET /api/tables/<table>/columns` answered for it — { table, columns } or { table, failure } — or null while it is read. */
function pickForm(t, cols, ticked = null) {
  const name = entryName(t.table);
  if (cols?.table !== t.table) return `<p class="dim">Reading ${esc(name)}'s columns…</p>${button("Cancel", { cancelChoose: "", popClose: "" }, "small")}`;
  if ("failure" in cols) return `${renderFailure(cols.failure)}${button("Cancel", { cancelChoose: "", popClose: "" }, "small")}`;
  const boxes = (field) => cols.columns.map((c) => tick(field, c, ticked?.[field]?.includes(c.name) ?? false)).join("");
  return `<form class="pick" data-pick-form="${esc(t.table)}" autocomplete="off">` +
    (t.key.length ? "" : `<fieldset><legend>Its key: the columns that tell its rows apart, as ${code(`mason add ${name} --key`)}</legend>${boxes("key")}</fieldset>`) +
    `<fieldset><legend>Its columns, as ${code(`mason add ${name} --columns`)} (none ticked: as ${code(`mason add ${name}`)}, every column)</legend>${boxes("columns")}</fieldset>` +
    `<button type="submit" class="primary small">Add ${esc(name)}</button> ${button("Cancel", { cancelChoose: "", popClose: "" }, "small")}</form>`;
}

/** The cards over the list: the tables added of all, those synced, those failed and the copies' rows (`/api/state`
 *  `totals`, which `mason status --json` also carries); none before the state, or with no table to count. */
export function renderTablesCards(s) {
  const t = s.totals;
  if (!t || !s.tables.length) return "";
  const added = s.tables.filter((x) => x.added).length;
  return cards([
    card("Tables added", `${n(added)} of ${n(s.tables.length)}`, "in the database"),
    card("Synced", n(t.copied), `of ${n(added)} added${copyingCount(s) ? `, ${n(copyingCount(s))} copying` : ""}`),
    card("Failed", n(t.failed), `of ${n(added)} added`, "", t.failed ? "bad" : ""),
    card("Rows", n(t.rows), "in the copies"),
  ]);
}

/**
 * THE DATABASE'S TABLES from `/api/state` `tables` (`mason tables --json`'s list), ONE table in a card: a row each — its
 * name in mono, its state as a dot and the word (an added table's sync: Synced / Syncing / Failed / Waiting, else Not
 * added), its rows, its key, an added table's last sync as its age (the UTC time in a title), how long it took and the
 * copy's own size (`ui.sizes`: `/api/usage`'s body or `{ failure }`), its stream state in replication mode, and a note —
 * its error as a red line (the whole error in a details, `ui.open(key)` whether it is open), or why it cannot be added as
 * it is (`tableFacts`, as `mason tables` prints it). What can be done: Sync and Remove (asking first, `ui.removing`) for an
 * added table; Add (every column, as `mason add <table>`) and Columns… (the form) for one not added; Name its key… for
 * one with no primary key. `ui.choosing` is the table whose form is open (`ui.ticked` its boxes ticked: { columns, key };
 * `ui.columns` its columns as read when it opened: { table, columns } | { table, failure }, null while read);
 * `ui.outcome` what the last add or remove answered ({ table, added } | { table, removed } | { table, failure }) and
 * `ui.synced` what the last sync did, each a popover beside its table's actions (`at`: when, gone after OUTCOME_MS at `ui.now`); `ui.syncing` the tables whose sync is asked; `ui.filter` the
 * search box's text and `ui.show` the state filter (a key of SHOWS).
 */
export function renderTables(s, ui = {}) {
  const { removing = null, choosing = null, columns = null, outcome = null, ticked = null, filter = "", show = "all", sizes, syncing = [], adding = [], shares = new Map(), before = new Map(), synced = null, open = () => false, limit = TABLE_ROWS } = ui;
  const now = ui.now ?? Date.now();
  if (!s.tables.length) return empty(`${s.source.database} has no table this user can read.`);
  const stream = s.stream ? new Map(streamRows(s.stream, now).tables) : null;
  // SEVEN NARROW COLUMNS OF FIXED WIDTHS, NOTHING LONG IN A CELL, AND NOTHING A CLICK INSERTS: a table's state is its word
  // over its copy's bar (a line kept for it when it has none); its last sync an age over how long it took; whatever is
  // said at length — the words `mason wait` prints, an error, why it cannot be added, its stream state — is ITS NOTE, a
  // line of its own under the row, across every column, written for every row (empty when it says nothing), so a note
  // that comes or goes moves no row. A question (Remove), a form (Columns…) and what an action answered are POPOVERS
  // beside the row's actions (`pop`), written after the table: a click moves no other row and no column
  // (`table-layout: fixed`, the stylesheet's widths by the header's classes; a button whose label changes keeps its room).
  const head = [["Table", "name"], ["State", "state"], ["Rows", "num rows"], ["Key", "key"], ["Last sync", "num last"], ["Size", "num size"], ["", "act"]];
  const sizeOf = new Map(sizes && !("failure" in sizes) ? sizes.copySizes.map((c) => [c.table, c.bytes]) : []);
  const under = (html, cls = "") => `<tr class="under${cls ? ` ${cls}` : ""}"><td colspan="${head.length}"><div class="under-body">${html}</div></td></tr>`;
  const cell = (v, cls = "", title = "") => `<td${cls ? ` class="${cls}"` : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(v)}</td>`;
  // the popovers of the rows written, in their order: after the table, each anchored to its row's actions
  const pops = [];
  const line = (t) => {
    const f = tableFacts(t);
    const name = entryName(t.table);
    const y = t.sync;
    const adding_ = adding.includes(t.table);
    const asking = removing === t.table;
    const anchor = actId("tables", t.table);
    const syncedNow = synced?.table === t.table && !("failure" in synced) && fresh(synced, now);
    const act = adding_ ? button("Adding…", {}, "primary small", { disabled: true }) : t.added
      // Sync now → Syncing… → Synced ✓ in the one room (ROOMS.sync), so the actions never move
      // View syncs: its sync events, on Observability › Syncs (a link: it goes to another page)
      ? `<a class="btn small" href="${esc(syncsHref(t.table))}">View syncs</a> ` +
        (syncing.includes(t.table) ? button("Syncing…", {}, "small", { room: ROOMS.sync, disabled: true }) : button(syncedNow ? "Synced ✓" : "Sync now", { syncTable: t.table }, "small", { room: ROOMS.sync })) + " " +
        // while it asks, Remove stays where it was, held down: the question beside it answers it
        (asking ? button("Remove", {}, "danger small", { disabled: true, expanded: true }) : button("Remove", { removeTable: t.table }, "danger small"))
      : t.reason === null
        ? `${button("Add", { addTable: t.table }, "primary small")} ${choosing === t.table ? button("Columns…", {}, "small", { disabled: true, expanded: true }) : button("Columns…", { choose: t.table }, "small")}`
        : t.key.length ? "" : choosing === t.table ? button("Name its key…", {}, "small", { disabled: true, expanded: true }) : button("Name its key…", { choose: t.table }, "small");
    // a failed copy's rows so far are none: the copy it serves meanwhile is said by its error and mason status
    const rows = t.added && t.copy && t.copy.phase !== "failed" ? n(t.copy.rowsCopied) : f.size;
    // EVERY ADDED TABLE HAS ITS BAR, as `mason status` and `mason wait` print one for each (src/cli/commands.ts
    // `tableLines`): full at 100% once copied, red when its copy failed, amber when it is not kept current, moving while
    // it copies, the indeterminate shimmer while it waits — the Overview's renderer (`copyBar`), its words the line's;
    // a table with none keeps its line, empty, so the row is as tall either way
    const l = t.added && !adding_ ? tableLine(t) : null;
    const bar = l ? `<span class="copyline t-${l.state}">${copyBar(t.table, l, shares.get(t.table) ?? l.fraction, before.get(t.table))}</span>` : `<span class="copyline none" aria-hidden="true"></span>`;
    const state = adding_ ? status("warn", "Adding…") : t.added ? (y ? status(undefined, SYNC_WORDS[y.state]) : "") : status("unknown", "Not added");
    const took = t.added && y?.syncSeconds != null ? `<span class="took" title="${esc(tookTitle(y))}">took ${esc(tookText(y))}</span>` : "";
    const last = t.added && y?.syncedAt && y?.ageSeconds != null
      ? `<td class="num"><span title="${esc(`${utcText(y.syncedAt)} UTC`)}">${esc(`${duration(y.ageSeconds)} ago`)}</span>${took}</td>` : `<td class="num">${took}</td>`;
    // what is said at length, its note under the row: the words the CLI prints after a bar that is not full and current,
    // an error (its first line; the whole in a details), why it cannot be added as it is, its stream state (replication mode)
    const said_ = adding_ ? `<span class="dim">adding it to the sources file…</span>`
      : t.added ? [
        l && l.state !== "done" && !t.error ? `<span class="what-copy t-${l.state}">${esc(l.what)}</span>` : "",
        t.error ? `<span class="err">${esc(firstLine(t.error))}</span>${t.error.includes("\n") ? details(`error:${t.table}`, "the whole error", `<pre>${esc(t.error)}</pre>`, open(`error:${t.table}`)) : ""}` : "",
        stream && stream.get(t.table) ? `<span class="stream dim">Stream: ${esc(stream.get(t.table))}</span>` : "",
      ].filter(Boolean).join("")
      : f.state ? `<span class="dim">${esc(f.state)}</span>` : "";
    const note = under(said_, "note");
    if (asking) {
      pops.push(pop(anchor, `<p class="confirm">Remove ${esc(name)}? ${esc(removedReport([t.table], "").tips[0])}.</p>` +
        `<p class="pop-actions">${button(`Remove ${name}`, { confirmRemoveTable: t.table }, "danger small")} ${button("Cancel", { cancelRemoveTable: "", popClose: "" }, "small")}</p>`, { kind: "dialog", label: `Remove ${name}?` }));
    }
    // a refused add with its form open: the refusal is said in the form's popover, over the boxes as they were ticked
    const formOpen = choosing === t.table && !t.added;
    const refusedHere = outcome?.table === t.table && "failure" in outcome;
    if (formOpen) pops.push(pop(anchor, (refusedHere ? renderFailure(outcome.failure) : "") + pickForm(t, columns, ticked), { kind: "dialog", label: `Add ${name}` }));
    if (outcome?.table === t.table && fresh(outcome, now) && !(formOpen && refusedHere)) {
      pops.push(pop(anchor, "failure" in outcome ? `${renderFailure(outcome.failure)}${button("Dismiss", { dismissOutcome: "", popClose: "" }, "small")}`
        : "added" in outcome ? renderTableAdded(outcome.added, shownFileOf(s, outcome.added.file)) : renderTablesRemoved(outcome.removed, shownFileOf(s, outcome.removed.file))));
    }
    if (synced?.table === t.table && fresh(synced, now)) {
      pops.push(pop(anchor, "failure" in synced ? `${renderFailure(synced.failure)}${button("Dismiss", { dismissSynced: "", popClose: "" }, "small")}` : renderSynced(synced.synced, t.table, s)));
    }
    return `<tr class="${t.added ? `c-added s-${y?.state ?? "unknown"}` : t.reason ? "c-cannot" : "c-not"}${said_ ? " has-note" : ""}"><th scope="row" class="name"><code class="name" title="${esc(t.table)}">${esc(t.table)}</code></th>` +
      `<td class="state">${state}${bar}</td>${cell(rows, "num")}${cell(f.key, "mono", f.key)}${last}` +
      `${t.added ? (sizeOf.has(t.table) ? cell(bytesText(sizeOf.get(t.table)), "num") : cell("—", "num", "not measured yet: a copy's size is measured every 10 min")) : cell("", "num")}` +
      `<td class="act" id="${esc(anchor)}">${act}</td></tr>` + note;
  };
  const added = s.tables.filter((t) => t.added).length;
  // a refusal for a table the list does not have (dropped since the run read the catalog): said above the list
  const stray = outcome !== null && "failure" in outcome && !s.tables.some((t) => t.table === outcome.table) ? renderFailure(outcome.failure) : "";
  // the search box's text and the state filter: the tables that pass both (the one a form or a confirm is open on stays, whatever they say)
  const passes = (t) => (show === "added" ? t.added : show === "failed" ? failedTable(t) : show === "not-added" ? !t.added : true) && nameMatches(t.table, filter);
  const shown = s.tables.filter((t) => passes(t) || t.table === choosing || t.table === removing);
  // at most `limit` rows written (the one a form or a confirm is open on always): a database of 800 tables costs 100 rows
  const written = shown.filter((t, i) => i < limit || t.table === choosing || t.table === removing);
  const matching = filter.trim() ? `<p class="count dim">${n(shown.length)} with “${esc(filter.trim())}” in the name</p>` : "";
  const sizesFailed = added && sizes && "failure" in sizes ? `<p class="count">The copies' own sizes: could not read them (${esc(firstLine(sizes.failure.message))}; ${code("mason usage")} has them)</p>` : "";
  const rowsHtml_ = written.map(line).join("");
  return stray + (added ? "" : empty("No table added yet", `Add one from the list, as ${code("mason add <table>")} does.`)) + matching +
    panel(`<table class="catalog"><thead><tr>${head.map(([h, c]) => `<th scope="col"${c ? ` class="${c}"` : ""}>${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${rowsHtml_}</tbody></table>`) + pops.join("") + moreRows("tables", Math.min(limit, shown.length), shown.length, TABLE_ROWS) +
    (!shown.length ? `<p class="dim">No ${show === "added" ? "added " : show === "failed" ? "failed " : show === "not-added" ? "table that is not added, " : ""}table${filter.trim() ? `'s name has “${esc(filter.trim())}”` : ""}.</p>` : "") + sizesFailed +
    (added ? `<p class="dim">A copy's own size is measured every 10 minutes (${code("mason usage")}).</p>` : "");
}

export const page = {
  id: "tables",
  title: "Tables",
  create(ctx) {
    const m = { removing: null, choosing: null, columns: null, outcome: null, ticked: null, held: null, heldFilter: null, heldShow: null, filter: "", show: "all", syncing: [], adding: [], synced: null, limit: TABLE_ROWS };
    const state = () => ctx.read("/api/state")?.body ?? null;
    const monotone = createMonotone();
    // the details open (a copy's whole error), by key: a poll rewrites the part, and they stay open
    const opened = createOpenSet();
    // WHILE A FORM IS OPEN OR A REMOVE ASKS, THE TABLES ARE RENDERED FROM THE STATE THEY WERE OPENED OVER (`held`): the
    // run reads the catalog again every few seconds, and a live database's row estimates move, so a part written from
    // each poll's state would be rewritten under the person — the form's ticks gone, the confirm's button replaced under
    // the click. So the list is FROZEN for as long as a form stays open or a Remove asks — however long that is, with no
    // refresh in between (its rows and its added marks may be minutes old) — and is written from the latest state again
    // once they Add, Cancel or confirm.
    const hold = () => {
      const held = m.choosing !== null || m.removing !== null;
      m.heldFilter = held ? m.held === null ? m.filter : m.heldFilter : null;
      m.heldShow = held ? m.held === null ? m.show : m.heldShow : null;
      m.held = held ? m.held ?? state() : null;
      if (m.choosing === null) m.ticked = null;
    };
    const actions = {
      /** Add a table (`mason add`): the answer beside its actions, then the state read again — the Overview shows its copy starting. */
      async addTable(table, columns = [], key = []) {
        if (m.adding.includes(table)) return false;
        // from the click: the row says Adding… (the page paints before the answer), then the state read again shows the copy
        m.adding = [...m.adding, table];
        if (m.choosing !== table) { m.outcome = null; m.synced = null; }
        const r = await ctx.ask("/api/pick", json("POST", pickBody(table, columns, key)));
        m.adding = m.adding.filter((x) => x !== table);
        // refused: said over the form, in its popover, written again with the boxes the person had ticked
        if ("failure" in r) { m.outcome = { table, failure: r.failure }; if (m.choosing === table) m.ticked = { columns, key }; return false; }
        m.outcome = { table, added: r.body, at: ctx.now().getTime() }; m.choosing = null; m.columns = null; hold();
        await ctx.refresh(["/api/state"]);
        return true;
      },
      /** Open a table's form: its columns read now, once (the state the page polls carries none). */
      async choose(table) {
        // a question opened takes the last answer away: two popovers never stand on one another
        m.choosing = table; m.removing = null; m.ticked = null; m.columns = null; m.outcome = null; m.synced = null; hold();
        const r = await ctx.ask(columnsPath(table));
        // closed, or another table's opened, while it was read: that answer is not this form's
        if (m.choosing !== table) return false;
        m.columns = "failure" in r ? { table, failure: r.failure } : { table, columns: r.body.columns };
        return true;
      },
      cancelChoose() { m.choosing = null; m.columns = null; hold(); },
      askRemoveTable(table) { m.removing = table; m.choosing = null; m.outcome = null; m.synced = null; hold(); },
      cancelRemoveTable() { m.removing = null; hold(); },
      /** Remove a table (`mason remove`), once asked: the answer beside its actions, then the state read again. */
      async confirmRemoveTable(table) {
        const r = await ctx.ask("/api/remove", json("POST", { tables: [table] }));
        m.removing = null; hold();
        if ("failure" in r) { m.outcome = { table, failure: r.failure }; return false; }
        m.outcome = { table, removed: r.body, at: ctx.now().getTime() };
        await ctx.refresh(["/api/state"]);
        return true;
      },
      dismissOutcome() { m.outcome = null; },
      /** Sync a table now (`mason sync <table>`): the answer beside its Sync, then the state read again. */
      async syncTable(table) {
        m.syncing = [...m.syncing, table];
        m.outcome = null; m.synced = null;
        const r = await ctx.ask("/api/sync", json("POST", { tables: [table] }));
        m.syncing = m.syncing.filter((x) => x !== table);
        m.synced = "failure" in r ? { table, failure: r.failure } : { table, synced: r.body, at: ctx.now().getTime() };
        await ctx.refresh(["/api/state"]);
        return !("failure" in r);
      },
      dismissSynced() { m.synced = null; },
      /** The search box's text: kept here, so every poll writes the lists filtered by it. */
      filterTables(text) { m.filter = text; m.limit = TABLE_ROWS; },
      /** The state filter beside it (a key of SHOWS; anything else is All). */
      showTables(which) { m.show = Object.hasOwn(SHOWS, which) ? which : "all"; m.limit = TABLE_ROWS; },
      /** Write TABLE_ROWS more of the tables that pass, or all of them. */
      showMoreTables() { m.limit += TABLE_ROWS; },
      showAllTables() { m.limit = Infinity; },
    };
    return {
      model: m,
      reads: () => [{ path: "/api/state", everyMs: POLL_MS }, { path: SIZES_PATH, everyMs: 60_000 }],
      afterRead() {
        const s = state();
        if (s === null) return;
        // a table removed or added elsewhere (mason remove, mason add) takes its confirm or its form with it
        const added = (table) => s.tables.some((t) => t.table === table && t.added);
        if (m.removing !== null && !added(m.removing)) m.removing = null;
        if (m.choosing !== null && added(m.choosing)) m.choosing = null;
        hold();
      },
      actions,
      view() {
        const s = m.held ?? state();
        const sizes = ctx.read(SIZES_PATH);
        // held still while a form is open or a Remove asks, the search box's text and the state filter included: nothing moves under the person
        const latest = state();
        return {
          "tables-cards": latest ? renderTablesCards(latest) : "",
          tables: s ? renderTables(s, { removing: m.removing, choosing: m.choosing, columns: m.columns, outcome: m.outcome, ticked: m.ticked, now: ctx.now().getTime(),
            filter: m.held ? m.heldFilter : m.filter, show: m.held ? m.heldShow : m.show, syncing: m.syncing, adding: m.adding, shares: monotone.of(latest ?? s), before: monotone.before, synced: m.synced, open: opened.has, limit: m.limit,
            sizes: sizes === undefined ? undefined : sizes.failure ? { failure: sizes.failure } : sizes.body }) : "",
        };
      },
      submit(form, FormData) {
        // a table's form is written into the tables part: the ticked boxes sent as they are (FormData's getAll: the
        // values of the boxes ticked, in the page's order)
        if (form.dataset?.pickForm === undefined) return null;
        const ticked = new FormData(form);
        return actions.addTable(form.dataset.pickForm, ticked.getAll("columns"), ticked.getAll("key"));
      },
      /** `#tables?show=failed`: the state filter as the hash says (the select beside the search box shows it too). */
      route(params, { doc } = {}) {
        if (params.show === undefined) return;
        actions.showTables(params.show);
        const select = doc?.getElementById?.("tables-show");
        if (select) select.value = m.show;
      },
      click(d) {
        if (d.showMore === "tables") return actions.showMoreTables() ?? true;
        if (d.showAll === "tables") return actions.showAllTables() ?? true;
        if (d.addTable !== undefined) return actions.addTable(d.addTable);
        if (d.choose !== undefined) return actions.choose(d.choose);
        if (d.cancelChoose !== undefined) return actions.cancelChoose() ?? true;
        if (d.removeTable !== undefined) return actions.askRemoveTable(d.removeTable) ?? true;
        if (d.cancelRemoveTable !== undefined) return actions.cancelRemoveTable() ?? true;
        if (d.confirmRemoveTable !== undefined) return actions.confirmRemoveTable(d.confirmRemoveTable);
        if (d.dismissOutcome !== undefined) return actions.dismissOutcome() ?? true;
        if (d.syncTable !== undefined) return actions.syncTable(d.syncTable);
        if (d.dismissSynced !== undefined) return actions.dismissSynced() ?? true;
        return null;
      },
      toggle: (target) => opened.toggle(target),
      input(target) {
        if (target.id === "tables-show") return actions.showTables(target.value) ?? true;
        if (target.id !== "tables-filter") return null;
        return actions.filterTables(target.value) ?? true;
      },
    };
  },
};
