/**
 * THE TABLES PAGE (#tables): the database's tables, as `mason tables` lists them, in TWO lists one above the other: the
 * tables added (Added), then the tables not added (Not added). An added table shows its
 * copy's sync — state, rows, last sync and its age, how long it took, the copy's own size, and in replication mode its
 * stream state — and its error, with Sync (POST /api/sync, `mason sync`) and Remove (POST /api/remove, `mason remove`),
 * and on its note which columns it syncs, a button that opens its column form (POST /api/pick, `mason add --columns`);
 * one not added shows its rows and key and why it cannot be added as it is, with Add, Columns… and Name its key…
 * (POST /api/pick, `mason add`). A search box filters both lists by name, and Failed only lists the failed tables alone
 * (`#tables?show=failed`, where the Overview's card leads). With hundreds of tables the page writes the first
 * TABLE_ROWS that pass, the added first, and "Show N more" / "Show all" (the search is over all of them, at once); a
 * long name wraps whole. Reads `/api/state` every poll (lean: no table's columns) and `/api/usage`'s
 * `copySizes` and `unsized` every minute; a table's columns once, when its Columns… or Name its key… form opens
 * (`GET /api/tables/<table>/columns`, `columnsPath`).
 */
import { msText, bytesText, button, card, cards, code, createOpenSet, moreRows, details, empty, entryName, esc, fileSize, firstLine, json, n, panel, renderFailure, spanText, duration, status, streamRows, utcText, pop, actId, ROOMS, POLL_MS, readOnlyLine, tablesReadOnly } from "../shared.js";
import { copyBar, copyingCount, createMonotone, tableLine } from "./status.js";

/** `/api/usage` asked for the copies' own sizes alone: the last minute's samples (none needed), and `copySizes`. */
const SIZES_PATH = "api/usage?since=1m";

/** Where one table's columns are read, when its form opens (src/cli/run-server.ts tableColumns): never with the state,
 *  which is polled every 2 s and would carry every table's (3.4 MB at 800 tables of 50 columns). */
/** A table's sync events: Observability › Sync events narrowed to it (src/web/pages/syncs.js `route`), over the week (its
 *  copy and failures are rarely in the last 15 minutes, the default range's). */
export const syncsHref = (table) => `#observability/syncs?table=${encodeURIComponent(table)}&range=7d`;
export const columnsPath = (table) => `api/tables/${encodeURIComponent(table)}/columns`;

/** A table's sync in one word (`/api/state` `tables[].sync.state`, src/cli/readiness.ts `syncStateOf`). */
const SYNC_WORDS = { synced: "Synced", syncing: "Syncing", "catching-up": "Finishing sync", behind: "Behind", failed: "Failed", waiting: "Waiting" };

/** A table's name, escaped, with a place to break after each `.` and `_` (`<wbr>`): it wraps there in its cell rather
 *  than being cut (issue 884). */
export const nameBreaks = (table) => esc(table).replace(/([._])/g, "$1<wbr>");

/** Whether a table's name has the search box's text (any case; nothing typed: every table). */
const nameMatches = (table, filter) => !filter || table.toLowerCase().includes(filter.trim().toLowerCase());

/**
 * WHAT A SYNC DID, as `mason sync` prints it from `POST /api/sync`'s answer (src/cli/sync.ts `syncedReport`, held equal
 * by the tests): the rows written and deleted, a line per table, and what happens next to each table synced (`syncedTips`:
 * an `off` one stays as of this sync). A table whose sync is replication was not polled: its line says where the stream
 * is (`streamed`), and a sync of those alone has nothing to sync.
 */
export function syncedReport(b, picked, tables) {
  const streamed = b.streamed ?? [];
  const streamedRows = streamed.map((t) => [t.table, `${t.state}${t.why ? `: ${t.why}` : ""} · the stream has applied the database's changes through ${t.position}`]);
  if (b.tables.length === 0 && streamed.length > 0) {
    return { headline: `Nothing to sync: logical replication keeps ${picked.join(", ")} current.`, details: streamedRows, tips: [] };
  }
  const changed = b.tables.reduce((a, t) => a + t.changed, 0), deleted = b.tables.reduce((a, t) => a + t.deleted, 0);
  const streamedNames = new Set(streamed.map((t) => t.table));
  const polled = picked.filter((t) => !streamedNames.has(t));
  return {
    headline: `Synced ${polled.join(", ")}: ${n(changed)} row(s) written, ${n(deleted)} deleted${streamedRows.length ? `; logical replication keeps ${streamedRows.map((r) => r[0]).join(", ")} current` : ""}.`,
    details: [...b.tables.map((t) => [t.table, `${n(t.changed)} changed, ${n(t.deleted)} deleted, ${n(t.rows)} rows now · ${msText(t.ms)}`]), ...streamedRows],
    tips: syncedTips(tables),
  };
}

/** What happens to each table synced after now, by its sync (src/cli/sync.ts `syncedTips`, in the page's words: the
 *  page's way to sync again is its Sync now, where the CLI names mason sync): an `off` table stays as of this sync
 *  until the next one, a polled one is polled again after its interval. */
function syncedTips(tables) {
  return tables.flatMap((t) => {
    const k = t.kept;
    if (k?.by !== "poll") return [];
    return [k.sync.mode === "off" ? `${t.table}'s sync is off, so it stays as it is now until you press Sync now again.`
      : `${t.table} is polled every ${k.sync.every}. Its next poll is one interval from now.`];
  });
}

/** A sync's answer said as `mason sync` says it, with Dismiss. `s`: the state, for the tables not kept current. */
function renderSynced(b, table, s) {
  const r = syncedReport(b, [table], s.tables.filter((t) => t.table === table));
  // a table's name in it wraps after its . and _ (`nameBreaks`), never squeezing what is beside it (issue 884)
  return `<div class="done"><p class="headline">${nameBreaks(r.headline)}</p>` +
    `<dl class="facts">${r.details.map(([k, v]) => `<dt>${nameBreaks(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${r.tips.map((x) => `<p class="tip">${nameBreaks(x)}</p>`).join("")}` +
    `${button("Dismiss", { dismissSynced: "", popClose: "" }, "small")}</div>`;
}


/** How many of the tables that pass the filters the page writes at once; "Show N more" writes as many again. */
const TABLE_ROWS = 100;

/**
 * THE TWO LISTS, as they are LAID OUT: the names of the added tables (whatever their sync's word), Added, and of those
 * not added, Not added, each in the order `/api/state` `tables` has them — Added is written first, so the first
 * TABLE_ROWS written begin with every added table. The page lays them out when the page is shown, and again only when
 * the search box's text or Failed only changes (`m.order`, below): a table added or removed in between keeps its row in
 * its list, its state changing in place, because a row that jumped to the other list the moment its Add answered would
 * pull the next row under the pointer (a click moves no other row).
 */
export const layoutOf = (tables) => ({ added: tables.filter((t) => t.added).map((t) => t.table), other: tables.filter((t) => !t.added).map((t) => t.table) });

/** The tables in a layout (`layoutOf`'s `{ added, other }`): `{ added, other }`, each table in the list and at the place
 *  the layout put it; a table the layout has not met (new in the catalog since) after them, in the list its added mark
 *  says; one gone from the catalog gone. No layout: laid out now. */
export function inLayout(tables, order = null) {
  const o = order ?? layoutOf(tables);
  const byName = new Map(tables.map((t) => [t.table, t]));
  const met = new Set([...o.added, ...o.other]);
  const fresh = layoutOf(tables.filter((t) => !met.has(t.table)));
  const of = (names) => names.filter((x) => byName.has(x)).map((x) => byName.get(x));
  return { added: of([...o.added, ...fresh.added]), other: of([...o.other, ...fresh.other]) };
}

/** Whether an added table's copy or sync failed (Failed only, the Overview's failed card). */
const failedTable = (t) => t.added && (t.sync?.state === "failed" || Boolean(t.error));

/** What brought a copy current, in a web developer's words (`/api/state` `tables[].sync.syncedBy` keeps the mechanism's
 *  name for an operator: copy, poll, catch-up, stream). */
export const SYNCED_BY = { copy: "read whole", poll: "changes checked", "catch-up": "changes checked", stream: "streamed" };
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

/** What the page says for a table added, from `/api/pick`'s answer (`mason add --json`'s `added` entry): its line, then
 *  its notes — its sync, a poll's cost, the key added to the columns asked, the secret-looking columns left out. The
 *  facts are `mason add`'s (src/cli/commands.ts `addedLines`), in the page's words: no sources file, and the page's way
 *  to change a table's sync (its Sync button) where `mason add` names `--sync`. */
/** The columns an entry syncs, from `/api/pick`'s answer: every column, every column but some, or the columns named. */
const columnsWords = (b) => b.columns === null ? (b.exclude.length ? `every column but ${b.exclude.join(", ")}` : "every column") : `the columns ${b.columns.join(", ")}`;
export function addedLines(b) {
  const copies = columnsWords(b);
  const s = b.skippedSecrets;
  const name = entryName(b.table);
  const change = "Its Sync button changes this.";
  const sync = b.bigOff ? `Its sync is set to Off: it has more than 1,000,000 rows, and each poll would scan the whole table on your database. Press Sync now to sync it. ${change}`
    : b.notReplicated ? `Its sync is set to every 5 minutes, not Live: ${b.notReplicated}. ${change}`
    : b.sync.value === "off" ? `Its sync is Off: after its first sync, it syncs only when you press Sync now. ${change}`
    : b.sync.value === "replication" ? `Its sync is Live: after its first sync, changes stream from your database's change log. ${change}`
    : `Its sync is ${syncWords(b.sync.value).toLowerCase()}: after its first sync, Mason checks it for changes on that schedule. ${change}`;
  return { line: `Added ${b.table}: ${copies}${b.key ? `, keyed by ${b.key.join(", ")}` : ""}${b.already ? " (it was already added)" : ""}.`, notes: [
    sync,
    ...(b.pollCost !== null ? [b.pollCost] : []),
    ...(b.addedKey.length ? [`Its key ${b.addedKey.join(", ")} was added to its columns: a synced table always keeps its key.`] : []),
    // only the command can add a column left out of a table already added: named
    ...(s.length ? [`Left out ${s.join(", ")}: ${s.length === 1 ? "it looks" : "they look"} like ${s.length === 1 ? "a secret" : "secrets"}, ` +
      `which anyone with a user's password could read. To sync ${s.length === 1 ? "it" : "one"}, run mason add ${name} --include ${s[0]}.`] : []),
  ] };
}

/** What the page says for the tables removed (`mason remove`'s facts, src/cli/commands.ts `removedReport`, without the
 *  sources file it names). */
export function removedReport(removed) {
  return { headline: `Removed ${removed.join(", ")}.`, details: [],
    tips: [`Mason stopped syncing ${removed.length === 1 ? "it" : "them"} and deleted ${removed.length === 1 ? "its synced data" : "their synced data"}.`] };
}

/**
 * `POST /api/pick`'s body for a table added: the columns ticked as `--columns`, the key's as `--key`, each left out when
 * none is ticked (none: every column, as `mason add <table>` copies; no key: its primary key). What the lists may hold
 * is the server's to judge (src/cli/run-server.ts `pick`), never the page's.
 */
export const pickBody = (table, columns = [], key = []) => ({ table, picked: true, ...(columns.length ? { columns } : {}), ...(key.length ? { key } : {}) });

/** A table just added (`/api/pick`'s answer, `mason add --json`'s `added` entry): `addedLines`. `saved`: the answer to a
 *  Sync choice saved (`"sync"`, or true) or a column form saved (`"columns"`), which says what was saved and the notes
 *  after it, never "Added" (the table was added before); the same columns saved again say nothing changed. */
export function renderTableAdded(b, saved = false) {
  const l = addedLines(b);
  const savedSync = saved === true || saved === "sync";
  const name = entryName(b.table);
  const head = savedSync ? `Saved ${name}'s sync.`
    : saved === "columns" ? (b.already ? `Nothing changed: ${name} already syncs ${columnsWords(b)}.` : `Saved ${name}'s columns: ${columnsWords(b)}.`)
    : l.line;
  // after a column form, its sync is as it was: not said again
  const notes = savedSync ? [l.notes[0].replace(" Its Sync button changes this.", ""), ...l.notes.slice(1)] : saved === "columns" ? l.notes.slice(1) : l.notes;
  return `<div class="done"><p class="headline">${nameBreaks(head)}</p>${notes.map((x) => `<p class="note">${nameBreaks(x)}</p>`).join("")}` +
    `${button("Dismiss", { dismissOutcome: "", popClose: "" }, "small")}</div>`;
}

/** Tables just removed (`/api/remove`'s answer, `mason remove --json`'s shape): `removedReport`. */
export function renderTablesRemoved(b) {
  const r = removedReport(b.removed);
  return `<div class="done"><p class="headline">${nameBreaks(r.headline)}</p>${r.tips.map((x) => `<p class="tip">${nameBreaks(x)}</p>`).join("")}` +
    `${button("Dismiss", { dismissOutcome: "", popClose: "" }, "small")}</div>`;
}

const tick = (name, c, on) => `<label class="tick"><input type="checkbox" name="${name}" value="${esc(c.name)}"${on ? " checked" : ""}> ${code(c.name)} <span class="dim">${esc(c.type)}</span></label>`;

/**
 * THE COLUMNS' CHOICE OF BOTH COLUMN FORMS (an add's and an added table's): All columns — no list sent, every column and
 * any added later, as `mason add <table>` with no `--columns` — or Only these columns, its boxes under it (app.css hides
 * them while All is chosen, so nothing is written while the person ticks) and sent as `--columns`. Boxes left empty
 * read as "nothing chosen", never as "every column": so every column is a choice of its own. `which`: "all" | "only";
 * `on`: the names of the boxes ticked; `leaves`: the secret-looking columns All leaves out, said at All. With some left
 * out, All starts with the words of the row's label (`allBut`, issue 960): "All but 2 columns".
 */
function columnsField(legend, cols, which, on, leaves = []) {
  const all = leaves.length === 0 ? "All columns, and any added to the table later"
    : `${allBut(leaves.length)}. Left out because ${leaves.length === 1 ? "it looks like a secret" : "they look like secrets"}: ${leaves.join(", ")}. ` +
      "Columns added to the table later are synced too.";
  const radio = (value, words) => `<label><input type="radio" name="which" value="${value}"${which === value ? " checked" : ""}> <span>${esc(words)}</span></label>`;
  return `<fieldset><legend>${esc(legend)}</legend><div class="radios">${radio("all", all)}${radio("only", "Only these columns")}</div>` +
    `<div class="only-cols">${cols.map((c) => tick("columns", c, on.includes(c.name))).join("")}</div></fieldset>`;
}

/** What a column form sends, from its fields (`FormData`): All sends no columns; Only these sends the boxes ticked.
 *  `sent` is what the person chose, written back when the save is refused. null: Only these with no box ticked, which
 *  the page refuses (an empty list would be sent as every column). */
export function columnsSent(f) {
  const which = f.get("which") === "only" ? "only" : "all";
  const boxes = f.getAll("columns"), key = f.getAll("key");
  if (which === "only" && boxes.length === 0) return null;
  return { columns: which === "only" ? boxes : [], key, sent: { which, columns: boxes, key } };
}
/** The page's own refusal of Only these with no box ticked (`columnsSent`), said over the form as a run's would be. */
export const NO_COLUMNS = Object.freeze({ message: "Tick the columns to sync, or choose All columns." });

/** The form that adds a table with the columns ticked (`--columns`) and, for one with no primary key, its key (`--key`).
 *  The ticks live in the document while the person ticks (the tables part is held still meanwhile: the page's `held`);
 *  `ticked`, what a refused submit sent, writes them back when the refusal is said over the form, in its popover. `cols` is what
 *  `GET /api/tables/<table>/columns` answered for it — { table, columns } or { table, failure } — or null while it is read. */
function pickForm(t, cols, ticked = null) {
  const name = entryName(t.table);
  if (cols?.table !== t.table) return `<p class="dim">Reading ${esc(name)}'s columns…</p>${button("Cancel", { cancelChoose: "", popClose: "" }, "small")}`;
  if ("failure" in cols) return `${renderFailure(cols.failure)}${button("Cancel", { cancelChoose: "", popClose: "" }, "small")}`;
  const boxes = (field) => cols.columns.map((c) => tick(field, c, ticked?.[field]?.includes(c.name) ?? false)).join("");
  // All at first, its boxes all ticked under Only these, so choosing it starts from every column
  const which = ticked?.which ?? "all";
  const on = ticked?.columns ?? cols.columns.map((c) => c.name);
  return `<form class="pick" data-pick-form="${esc(t.table)}" autocomplete="off">` +
    (t.key.length ? "" : `<fieldset><legend>Its key: the columns that tell its rows apart</legend>${boxes("key")}</fieldset>`) +
    columnsField("The columns to sync", cols.columns, which, on) +
    `<button type="submit" class="primary small">Add ${esc(name)}</button> ${button("Cancel", { cancelChoose: "", popClose: "" }, "small")}</form>`;
}

// ------------------------------------------------------------------ an added table's columns (issue 884)

/** The element an added table's column form opens from (the summary in its note), and its popovers' anchor. */
export const columnsId = (table) => `columns-tables-${table}`;

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const counted = (k, word) => `${n(k)} ${word}${k === 1 ? "" : "s"}`;

/**
 * WHICH COLUMNS AN ADDED TABLE SYNCS, IN A FEW WORDS (its row's note): "All columns", "5 of 12 columns" or "All but 1
 * column", from `/api/state` `tables[].entry`, `addedColumns` and `columnCount`; the columns themselves are its title.
 * null for a table not added, and from a run that does not say them.
 */
export function columnsSummary(t) {
  const e = t.entry, all = t.columnCount, syncs = t.addedColumns;
  if (!t.added || !e || typeof all !== "number" || !Array.isArray(syncs)) return null;
  if (e.columns !== null) return { text: `${n(syncs.length)} of ${counted(all, "column")}`, title: `Synced: ${syncs.join(", ")}` };
  const out = leftOut(t);
  if (out.count > 0) return { text: allBut(out.count), title: out.names ? `Every column but ${out.names.join(", ")}` : `Its entry leaves out ${e.exclude.join(", ")}` };
  return { text: "All columns", title: "Every column, and any column added to the table later" };
}

/** The words an added table's row and its column form's All both start with when columns are left out (issue 960). */
const allBut = (k) => `All but ${counted(k, "column")}`;

/**
 * THE COLUMNS AN ADDED TABLE LEAVES OUT while its entry syncs every column (no `columns:`): how many, and which. The one
 * place its row's label (`columnsSummary`) and its column form's All (`columnsForm`) take them from, so the two cannot
 * disagree (issue 960). The table has `columnCount` columns and syncs `addedColumns`, so `count` is the difference.
 * `names` are its `exclude:` less what it syncs (a key column is synced whatever `exclude:` says) and less any name the
 * table has no column of. Such a name is a mistake of the file (the run refuses the entry), and the lean state cannot
 * tell which name it is: `columns`, the table's own (the column form's read), tells them apart; without them, `names`
 * is null when the names are not as many as the columns left out. `{ count: 0, names: [] }` for an entry with `columns:`.
 */
export function leftOut(t, columns = null) {
  const e = t.entry, syncs = t.addedColumns ?? [];
  if (!e || e.columns !== null) return { count: 0, names: [] };
  const names = e.exclude.filter((c) => !syncs.includes(c) && (columns === null || columns.includes(c)));
  const count = typeof t.columnCount === "number" ? t.columnCount - syncs.length : names.length;
  return { count, names: names.length === count ? names : null };
}

/**
 * WHAT AN ADDED TABLE'S COLUMN FORM TICKS WHEN IT OPENS: its entry's `columns:`; none for every column (`{}`, or the
 * `exclude:` every column writes: the secret-looking columns, `everyColumnLeavesOut`); its `key:`. An entry the boxes
 * cannot show (an `exclude:` written by hand, or every column with a secret-looking one kept on purpose) is
 * `exact: false`: its boxes are the columns synced now, and `said` is what the entry says — saving replaces it, which
 * the form says first.
 */
export function columnsChoice(t, columns = null) {
  const e = t.entry, key = e.key ?? [];
  if (e.columns !== null) return { exact: true, columns: e.columns, key };
  const leaves = t.everyColumnLeavesOut ?? [];
  if (sameSet(e.exclude, leaves)) return { exact: true, columns: [], key };
  // what it syncs, from the one count of what it leaves out (`leftOut`): never a name the table has no column of
  const out = leftOut(t, columns).names ?? e.exclude, kept = leaves.filter((c) => !e.exclude.includes(c));
  return { exact: false, columns: t.addedColumns ?? [], key,
    said: out.length ? `every column but ${out.join(", ")}` : kept.length ? `every column, ${kept.join(", ")} included` : "every column" };
}

/**
 * `POST /api/pick`'s body when an added table's column form is saved (as `mason add <table> --columns …`): the boxes
 * ticked — but when they say what its entry says, the entry's own lists in its own order, so the run finds nothing
 * changed (`already`), writes nothing and starts no sync.
 */
export function columnsBody(t, columns = [], key = []) {
  const c = columnsChoice(t), e = t.entry;
  const keyCols = t.key.length ? t.key : key;
  const withKey = (xs) => [...new Set([...xs, ...keyCols])];
  const sameKey = t.key.length > 0 || sameSet(key, c.key);
  const same = e.columns === null ? columns.length === 0 : sameSet(withKey(columns), withKey(e.columns));
  return c.exact && sameKey && same ? pickBody(t.table, e.columns ?? [], e.key ?? []) : pickBody(t.table, columns, key);
}

/** What saving a column form costs, said before it is saved (issue 884): the table synced again in full, its synced
 *  data queried meanwhile; the same choice changes nothing. `exact`: whether saving the same boxes writes nothing. */
export function columnsCost(t, exact = true) {
  const name = entryName(t.table);
  return `Saving different columns syncs ${name} again in full from your database${t.rows !== null ? ` (~${n(t.rows)} rows)` : ""}: ` +
    `that takes a while, and on a big table it adds load to your database. Its synced data can still be queried until the new sync finishes. ` +
    (exact ? "Saving the same columns changes nothing and starts no sync." : "Saving the same columns starts no sync.");
}

/**
 * AN ADDED TABLE'S COLUMN FORM (a dialog beside its columns' summary, `pop`): its columns ticked as its entry says
 * (`columnsChoice`), its key for a table with no primary key, what saving costs, Save and Cancel. `cols`: what
 * `GET /api/tables/<table>/columns` answered ({ table, columns } | { table, failure }, null while read); `ticked`: the
 * boxes a refused save sent, written back; `saving`: its save is asked.
 */
export function columnsForm(t, cols, ticked = null, saving = false) {
  const name = entryName(t.table);
  const cancel = button("Cancel", { cancelChoose: "", popClose: "" }, "small");
  if (cols?.table !== t.table) return `<p class="dim">Reading ${esc(name)}'s columns…</p>${cancel}`;
  if ("failure" in cols) return `${renderFailure(cols.failure)}${cancel}`;
  const names = cols.columns.map((x) => x.name);
  const c = columnsChoice(t, names);
  // every column (as its entry says it): All, its boxes every column but what All leaves out, so Only these starts
  // from what is synced now; a list, or an entry the boxes cannot show: Only these, the boxes as columnsChoice says
  const everyColumn = c.exact && c.columns.length === 0;
  // what All leaves out: chosen, what the row's label counts (`leftOut`, so the two say the same number, issue 960);
  // else what choosing it would leave out
  const leaves = everyColumn ? leftOut(t, names).names ?? [] : t.everyColumnLeavesOut ?? [];
  const which = ticked?.which ?? (everyColumn ? "all" : "only");
  const on = ticked ?? { columns: everyColumn ? names.filter((x) => !leaves.includes(x)) : c.columns, key: c.key };
  const boxes = (field) => cols.columns.map((x) => tick(field, x, on[field].includes(x.name))).join("");
  return `<form class="pick" data-pick-form="${esc(t.table)}" autocomplete="off">` +
    (c.exact ? "" : `<p class="note replaces">Its entry in the sources file syncs ${esc(c.said)}, which these boxes cannot show: they show the columns synced now. Saving replaces the entry with the columns ticked.</p>`) +
    (t.key.length ? "" : `<fieldset><legend>Its key: the columns that tell its rows apart</legend>${boxes("key")}</fieldset>`) +
    columnsField(`The columns ${name} syncs`, cols.columns, which, on.columns, leaves) +
    `<p class="note cost">${esc(columnsCost(t, c.exact))}</p>` +
    `<button type="submit" class="primary small"${saving ? " disabled" : ""}>${saving ? "Saving…" : "Save"}</button> ${cancel}</form>`;
}

// ------------------------------------------------------------------ a table's Sync choice (issue 840)

/** Where one table's Sync choice is read when it opens (src/cli/run-server.ts tableSyncChoice): its sync now, each poll's
 *  cost on the database, and Live's checks — the database's read then, never with the state the page polls. */
export const syncPath = (table) => `api/tables/${encodeURIComponent(table)}/sync`;
/** The element a table's Sync choice opens from, and its popovers' anchor: unique in the document. */
export const syncId = (table) => `sync-tables-${table}`;

/** An interval in words: 300 → "5 minutes", 3600 → "hour". */
const intervalWords = (seconds) => seconds % 86_400 === 0 ? (seconds === 86_400 ? "day" : `${seconds / 86_400} days`)
  : seconds % 3600 === 0 ? (seconds === 3600 ? "hour" : `${seconds / 3600} hours`)
  : seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`;
const UNIT = { s: 1, m: 60, h: 3600, d: 86_400 };
/** A sync as the sources file writes it (`off`, `poll 5m`, `replication`) in the page's words: Off, Every 5 minutes,
 *  Live (replication) — "replication" kept beside Live, the word the file and `mason add --sync` use. */
export function syncWords(value) {
  if (value === "off") return "Off";
  if (value === "replication") return "Live (replication)";
  const m = /^poll (\d+)([smhd])$/.exec(value ?? "");
  return m ? `Every ${intervalWords(Number(m[1]) * UNIT[m[2]])}` : String(value);
}
/** A table's sync now, as the run keeps it (`/api/state` `tables[].kept`, the sync's one derivation), as the file
 *  writes it, or null when the run says none (not reached yet, or a generated table). */
export function keptSync(t) {
  const k = t.kept;
  if (k?.by === "replication") return "replication";
  if (k?.by === "poll") return k.sync.mode === "off" ? "off" : `poll ${k.sync.every}`;
  return null;
}

/** `POST /api/pick`'s body for a sync chosen: only its sync, its columns and key kept (`mason add <table> --sync …`). */
export const syncBody = (table, sync) => ({ table, picked: true, sync, keep: true });

/** What Live keeps on the database, said wherever it can be chosen (issue 840). */
export const LIVE_SLOT_WORDS = "Live keeps a replication slot on your database. While Mason is not reading it (stopped or down), " +
  "the slot keeps all the WAL (your database's change log) written since, on your database's disk. It keeps it until Mason reads it again " +
  "or the slot is dropped. The slot is dropped when no table is set to Live, or by mason destroy. max_slot_wal_keep_size limits how much it can keep.";

/** A scan's length in words: 38 → "38 seconds", 150 → "3 minutes", 5400 → "1.5 hours". */
const lengthWords = (x) => x < 90 ? `${Math.round(x)} second${Math.round(x) === 1 ? "" : "s"}` : x < 5400 ? `${Math.round(x / 60)} minutes` : `${(x / 3600).toFixed(1)} hours`;
/** A scan's length as the lead says it: "under a second" for a short one (never "about 0 seconds"), else "about …". */
const scanWords = (x) => x < 1 ? "under a second" : `about ${lengthWords(x)}`;
const BASIS_WORDS = { measured: "measured at its last scheduled sync", "first-sync": "estimated from how fast its first sync read it", assumed: "a rough guess, since nothing is measured yet" };

/**
 * WHAT A SCHEDULED SYNC OF A BIG TABLE COSTS, IN THE PAGE'S WORDS, from the Sync choice's numbers (`polls[].cost`,
 * src/cli/source-edit.ts `PollLoad`): `pollCostLead`, what every interval shares, said once over the choices; and
 * `pollCostLine`, one interval's own share of the database, under it. Never the CLI's sentence and its flags.
 */
export function pollCostLead(c) {
  const l = c.polls.find((p) => p.cost)?.cost;
  if (!l) return null;
  return `${entryName(c.table)} has about ${n(l.rows)} rows. Each scheduled sync scans the whole table on your database, ` +
    `${scanWords(l.scanSeconds)} a scan (${BASIS_WORDS[l.basis] ?? "estimated"}).`;
}
export function pollCostLine(p) {
  const l = p.cost;
  if (!l) return null;
  const stretched = l.everySeconds > p.seconds * 1.01 ? `It runs every ${lengthWords(l.everySeconds)} at most, since a scan waits four times its own length. ` : "";
  return `${stretched}One connection to your database is busy ${l.busyPercent < 1 ? "less than 1" : `about ${l.busyPercent}`}% of the time.`;
}

/** What a choice asks before it is saved, or null: a poll of a big table (its cost on the database), Live with a
 *  warning (each said). `c`: `GET api/tables/<table>/sync`'s answer. */
export function syncQuestion(c, value) {
  const poll = c.polls.find((p) => p.sync === value);
  if (poll && c.bigRows) {
    const lead = pollCostLead(c), line = pollCostLine(poll);
    return { lines: lead && line ? [lead, line] : [`${entryName(c.table)} has more than 1,000,000 rows, and each scheduled sync scans it whole on your database.`],
      ask: `Scan all of ${entryName(c.table)} on your database every ${intervalWords(poll.seconds)}?`, yes: `Poll it every ${intervalWords(poll.seconds)}` };
  }
  const warnings = value === "replication" ? c.live.checks.filter((x) => x.state === "warn") : [];
  if (warnings.length) return { lines: warnings.map((x) => `${x.name}: ${x.detail}`), ask: `Keep ${entryName(c.table)} up to date by logical replication, with ${warnings.length === 1 ? "this warning" : "these warnings"}?`, yes: "Save Live (replication)" };
  return null;
}

const CHECK_WORDS = { ok: ["ok", "ok"], warn: ["warn", "warning"], refused: ["bad", "fails"] };
const checkLine = (x) => `<li class="check">${status(CHECK_WORDS[x.state][0], CHECK_WORDS[x.state][1])} <strong>${esc(x.name)}</strong> ${esc(x.detail)}` +
  `${x.sql ? `<pre class="sql"><code>${esc(x.sql)}</code></pre>` : ""}</li>`;

/**
 * A TABLE'S SYNC CHOICE (a dialog beside its sync, `pop`): Off, a poll at each preset — each saying it scans the whole
 * table at that interval, a big table's its cost —, or Live (replication), chosen only when `live.allowed` (every check
 * passes), else shown disabled with each failing check in the server's words and the SQL that fixes it; what Live keeps
 * on the database said plainly. `c`: the answer of `GET api/tables/<table>/sync` ({ table, failure } when refused, null
 * while read); `ask`: the choice whose question is asked before it is saved (`syncQuestion`), or null; `open`: whether
 * the passing checks' details is open; `picked`: the choice the person ticked (kept by the page, so a rewrite of
 * the part writes it ticked), else its sync now.
 */
export function renderSyncChoice(t, c, ask = null, open = false, picked = null) {
  const name = entryName(t.table);
  const cancel = button("Cancel", { cancelSync: "", popClose: "" }, "small");
  if (c?.table !== t.table) return `<p class="dim">Reading ${esc(name)}'s sync and checking your database for logical replication…</p>${cancel}`;
  if ("failure" in c) return `${renderFailure(c.failure)}${cancel}`;
  if (ask !== null) {
    const q = syncQuestion(c, ask);
    return `${q.lines.map((x) => `<p class="note">${esc(x)}</p>`).join("")}<p class="asks">${esc(q.ask)}</p>` +
      `<p class="pop-actions">${button(q.yes, { saveSync: t.table, sync: ask }, "primary small")} ${button("Back", { backSync: "" }, "small")} ${cancel}</p>`;
  }
  const now = c.sync?.value ?? "off";
  // the one ticked: what the person ticked (`picked`, kept by the page across a rewrite), else its sync now
  const ticked = picked ?? now;
  const radio = (value, label, what, { disabled = false, extra = "" } = {}) =>
    `<label class="choice${disabled ? " disabled" : ""}"><input type="radio" name="sync" value="${esc(value)}"${value === ticked ? " checked" : ""}${disabled ? " disabled" : ""}> ` +
    `<span class="choice-body"><span><span class="choice-label">${esc(label)}</span>${value === now ? ` <span class="dim">(current)</span>` : ""}</span><span class="choice-what">${esc(what)}</span>${extra}</span></label>`;
  // a big table's cost: what every interval shares once, over the choices; each interval's own share under it
  const lead = pollCostLead(c);
  const polls = c.polls.map((p) => {
    const line = pollCostLine(p);
    return radio(p.sync, syncWords(p.sync), `Scans the whole table on your database every ${intervalWords(p.seconds)}.`,
      { extra: line ? `<span class="choice-cost${p.cost.busyPercent >= 10 ? " high" : ""}">${esc(line)}</span>` : "" });
  });
  // its sync now, written in the sources file at an interval the page does not offer: kept as a choice of its own
  const other = now.startsWith("poll ") && !c.polls.some((p) => p.sync === now)
    ? [radio(now, syncWords(now), "Scans the whole table on your database at the interval set in the sources file.")] : [];
  const refused = c.live.checks.filter((x) => x.state === "refused"), warned = c.live.checks.filter((x) => x.state === "warn"), passed = c.live.checks.filter((x) => x.state === "ok");
  const live = radio("replication", "Live (replication)", "Changes stream from your database's change log. No scans.", { disabled: !c.live.allowed });
  const checks = (refused.length ? `<p class="live-no">Live cannot be chosen: ${esc(refused.map((x) => x.name).join(", "))}.</p><ul class="checks">${refused.map(checkLine).join("")}</ul>` : "") +
    (warned.length ? `<ul class="checks">${warned.map(checkLine).join("")}</ul>` : "") +
    (passed.length ? details(`synccheck:${t.table}`, `The checks that pass (${passed.length})`, `<ul class="checks">${passed.map(checkLine).join("")}</ul>`, open) : "");
  return `<form class="pick syncpick" data-sync-form="${esc(t.table)}" autocomplete="off">` +
    `<fieldset><legend>How Mason keeps ${esc(name)} up to date after its first sync</legend>` +
    (lead ? `<p class="note poll-lead">${esc(lead)}</p>` : "") +
    `<div class="radios">${radio("off", "Off", "Synced once. After that, only when you press Sync now.") + [...polls, ...other].join("") + live}</div>` +
    `<p class="note live-slot">${esc(LIVE_SLOT_WORDS)}</p>${checks}</fieldset>` +
    `<button type="submit" class="primary small">Save</button> ${cancel}</form>`;
}

/** The cards over the list: the tables added of all, those synced, those failed and the copies' rows (`/api/state`
 *  `totals`, which `mason status --json` also carries); none before the state, or with no table to count. */
export function renderTablesCards(s) {
  const t = s.totals;
  if (!t || !s.tables.length) return "";
  const added = s.tables.filter((x) => x.added).length;
  return cards([
    card("Tables added", `${n(added)} of ${n(s.tables.length)}`, "in the database"),
    card("Synced", n(t.copied), `of ${n(added)} added${copyingCount(s) ? `, ${n(copyingCount(s))} syncing` : ""}`),
    card("Failed", n(t.failed), `of ${n(added)} added`, "", t.failed ? "bad" : ""),
    card("Rows", n(t.rows), "in the synced tables"),
  ]);
}

/** Why a synced table is being measured, in plain words, by the run's reason (src/duck/usage.ts `UnsizedWhy`). */
export const MEASURING = {
  "written-since": "Data was written to disk since sizes were last measured, and this table's rows may be in it. Sizes are measured every 10 minutes.",
  "synced-since": "Synced since sizes were last measured. Sizes are measured every 10 minutes.",
  "not-measured-yet": "Not measured since Mason started. Sizes are first measured a minute after it starts.",
};

/**
 * WHAT AN ADDED TABLE'S SIZE CELL SAYS (issue 883), `{ text, title }`, from `/api/usage` (`sizes`: its `copySizes` and
 * `unsized`, the run's one rule, src/duck/usage.ts `unsizedTables`) and the table's state: its size when measured; else
 * the run's why — `< 3 MiB` (its rows all in the write-ahead log, the log's size rounded up the limit) or `Measuring…`
 * (its rows written to disk, or the table synced, since the last measure, or none since Mason started: `MEASURING`, by
 * the run's reason), each as `mason usage` writes it (`unsizedCell`, held equal by the tests); else, a table whose first
 * sync is done since the sizes were read (they are read once a minute, the state every poll) `Measuring…` too, synced
 * since; else, its first sync not done, nothing. Sizes not read yet, or not readable (said under the list): nothing.
 */
export function sizeCellOf(sizes) {
  const read = sizes && !("failure" in sizes);
  const sizeOf = new Map(read ? sizes.copySizes.map((c) => [c.table, c.bytes]) : []);
  const whyOf = new Map(read ? (sizes.unsized ?? []).map((u) => [u.table, u]) : []);
  const measuring = (why) => ({ text: "Measuring…", title: MEASURING[why] ?? MEASURING["synced-since"] });
  return (t) => {
    if (!read) return { text: "", title: "" };
    if (sizeOf.has(t.table)) return { text: bytesText(sizeOf.get(t.table)), title: "" };
    const u = whyOf.get(t.table);
    if (u?.why === "in-log" && u.underBytes != null) {
      const limit = `${n(Math.round(u.underBytes / 1024 ** 2))} MiB`;
      return { text: `< ${limit}`, title: `Under ${limit}. Its rows aren't in the main file yet, so it can't be measured exactly.` };
    }
    // the run's reason; a table it has not said yet (its first sync done after the sizes were read) was synced since
    if (u) return measuring(u.why);
    if (t.copy?.phase === "done") return measuring("synced-since");
    return { text: "", title: "No size until its first sync is done." };
  };
}

/**
 * THE DATABASE'S TABLES from `/api/state` `tables` (`mason tables --json`'s list), in TWO tables, each in a card under its
 * heading and count: Added, then Not added (`inLayout`). A row each — its
 * name in mono, its state as a dot and the word (an added table's sync: Synced / Syncing / Failed / Waiting, else Not
 * added), its rows, its key, an added table's last sync as its age (the UTC time in a title), how long it took and the
 * copy's own size (`ui.sizes`: `/api/usage`'s body or `{ failure }`), its stream state in replication mode, and a note —
 * its error as a red line (the whole error in a details, `ui.open(key)` whether it is open), or why it cannot be added as
 * it is (`tableFacts`, as `mason tables` prints it). What can be done: Sync and Remove (asking first, `ui.removing`) for an
 * added table; Add (every column, as `mason add <table>`) and Columns… (the form) for one not added; Name its key… for
 * one with no primary key; an added table's columns in a few words on its note (`columnsSummary`), which open its column
 * form (`columnsForm`; `ui.savingColumns` the table whose save is asked). `ui.choosing` is the table whose form is open (`ui.ticked` its boxes ticked: { columns, key };
 * `ui.columns` its columns as read when it opened: { table, columns } | { table, failure }, null while read);
 * `ui.outcome` what the last add or remove answered ({ table, added } | { table, removed } | { table, failure }) and
 * `ui.synced` what the last sync did, each a popover beside its table's actions, up until it is dismissed (its Dismiss,
 * Escape, or the next action's answer or question in its place); `ui.syncing` the tables whose sync is asked. Sync now
 * is offered disabled while the table's `syncRefusal` (`/api/state`: why `mason sync` of it is refused now, the sync's
 * one check) is set, that reason its title, in the same room; `ui.filter` the
 * search box's text, over both lists, and `ui.failed` Failed only (the failed tables alone; Not added is not written);
 * `ui.order` the lists as they were last laid out (`layoutOf`'s; none: laid out from `s`).
 */
export function renderTables(s, ui = {}) {
  const { removing = null, choosing = null, columns = null, outcome = null, ticked = null, filter = "", failed = false, sizes, syncing = [], adding = [], shares = new Map(), before = new Map(), synced = null, open = () => false, limit = TABLE_ROWS, order = null,
    syncOpen = null, syncChoice = null, syncAsk = null, syncPicked = null, savingColumns = null } = ui;
  const now = ui.now ?? Date.now();
  if (!s.tables.length) return empty(`${s.source.database} has no table this user can read.`);
  // why the page changes nothing (MASON_UI_READ_ONLY=1: not even a Sync), or null — null when its tables are still its
  // own (MASON_UI_READ_ONLY_ALLOW=tables)
  const viewOnly = tablesReadOnly(s);
  // why no table can be added or removed from here (that, or a server's sources file this run cannot write), or null
  const readOnly = viewOnly ?? s.sourcesReadOnly ?? null;
  const stream = s.stream ? new Map(streamRows(s.stream, now).tables) : null;
  // SEVEN NARROW COLUMNS OF FIXED WIDTHS, NOTHING LONG IN A CELL, AND NOTHING A CLICK INSERTS: a table's state is its word
  // over its copy's bar (a line kept for it when it has none); its last sync an age over how long it took; whatever is
  // said at length — the words `mason wait` prints, an error, why it cannot be added, its stream state — is ITS NOTE, a
  // line of its own under the row, across every column, written for every row (empty when it says nothing), so a note
  // that comes or goes moves no row. A question (Remove), a form (Columns…) and what an action answered are POPOVERS
  // beside the row's actions (`pop`), written after the table: a click moves no other row and no column
  // (`table-layout: fixed`, the stylesheet's widths by the header's classes; a button whose label changes keeps its room).
  const head = [["Table", "name"], ["State", "state"], ["Rows", "num rows"], ["Key", "key"], ["Last sync", "num last"], ["Size", "num size"], ["", "act"]];
  const sizeCell = sizeCellOf(sizes);
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
    const syncedNow = synced?.table === t.table && !("failure" in synced);
    // why mason sync of it is refused now (its first sync not finished or failed, being read again, being caught up), or
    // null: the server's words, from the check the sync refuses with — never derived here (absent from an older run: offered)
    const syncRefused = t.syncRefusal ?? null;
    const act = adding_ ? button("Adding…", {}, "primary small", { disabled: true }) : t.added
      // Sync now → Syncing… → Synced ✓ in the one room (ROOMS.sync), so the actions never move
      // View events: its sync events, on Observability › Sync events (a link: it goes to another page)
      ? `<a class="btn small" href="${esc(syncsHref(t.table))}">View events</a> ` +
        (viewOnly ? "" : syncing.includes(t.table) ? button("Syncing…", {}, "small", { room: ROOMS.sync, disabled: true }) : button(syncedNow ? "Synced ✓" : "Sync now", syncRefused === null ? { syncTable: t.table } : {}, "small", { room: ROOMS.sync, disabled: syncRefused !== null, title: syncRefused ?? "" })) + " " +
        // while it asks, Remove stays where it was, held down: the question beside it answers it
        (readOnly ? "" : asking ? button("Remove", {}, "danger small", { disabled: true, expanded: true }) : button("Remove", { removeTable: t.table }, "danger small"))
      // a sources file this run cannot write (`s.sourcesReadOnly`, a server's): no control that could only fail
      : readOnly ? ""
      : t.reason === null
        ? `${button("Add", { addTable: t.table }, "primary small")} ${choosing === t.table ? button("Columns…", {}, "small", { disabled: true, expanded: true }) : button("Columns…", { choose: t.table }, "small")}`
        : t.key.length ? "" : choosing === t.table ? button("Name its key…", {}, "small", { disabled: true, expanded: true }) : button("Name its key…", { choose: t.table }, "small");
    // a failed copy's rows so far are none: the copy it serves meanwhile is said by its error and mason status
    const rows = t.added && t.copy && t.copy.phase !== "failed" ? n(t.copy.rowsCopied) : f.size;
    // its size, or why it has none (`sizeCellOf`): an added table's alone
    const size = t.added ? sizeCell(t) : null;
    // EVERY ADDED TABLE HAS ITS BAR, as `mason status` and `mason wait` print one for each (src/cli/commands.ts
    // `tableLines`): full at 100% once copied, red when its copy failed, amber when it is not kept current, moving while
    // it copies, the indeterminate shimmer while it waits — the Overview's renderer (`copyBar`), its words the line's;
    // a table with none keeps its line, empty, so the row is as tall either way
    const l = t.added && !adding_ ? tableLine(t, now) : null;
    const bar = l ? `<span class="copyline t-${l.state}">${copyBar(t.table, l, shares.get(t.table) ?? l.fraction, before.get(t.table))}</span>` : `<span class="copyline none" aria-hidden="true"></span>`;
    // while this page's Sync now of it runs, its State says so, as Adding… does for an add: the run's own state says
    // "syncing" only for a first sync or a read again whole, never for a sync by hand (a poll), and the click's answer
    // comes when the sync is done, so the page's own request is the one sure sign
    const syncingNow = t.added && !adding_ && syncing.includes(t.table);
    const state = adding_ ? status("warn", "Adding…") : syncingNow ? status("warn", SYNC_WORDS.syncing)
      : t.added ? (y ? status(undefined, SYNC_WORDS[y.state]) : "") : status("unknown", "Not added");
    const took = t.added && y?.syncSeconds != null ? `<span class="took" title="${esc(tookTitle(y))}">took ${esc(tookText(y))}</span>` : "";
    const last = t.added && y?.syncedAt && y?.ageSeconds != null
      ? `<td class="num last"><span title="${esc(`${utcText(y.syncedAt)} UTC`)}">${esc(`${duration(y.ageSeconds)} ago`)}</span>${took}</td>` : `<td class="num last">${took}</td>`;
    // what is said at length, its note under the row: the words the CLI prints after a bar that is not full and current,
    // an error (its first line; the whole in a details), why it cannot be added as it is, its stream state (replication mode)
    // ITS SYNC, first on its note: what the run keeps it by now, and — where the page may edit the sources file — the
    // button that opens its Sync choice (a dialog beside it); read-only, the words alone, the reason their title
    const keptNow = keptSync(t);
    const syncWord = keptNow === null ? "Sync…" : `Sync: ${syncWords(keptNow)}`;
    // ITS COLUMNS, beside its sync: which it syncs in a few words (`columnsSummary`), the button that opens its column
    // form where the page may edit the sources file; read-only, the words alone
    const summary = t.added && !adding_ ? columnsSummary(t) : null;
    const colsCtl = summary === null ? ""
      : readOnly !== null ? `<span class="syncnow dim" title="${esc(summary.title)}">${esc(summary.text)}</span>`
      : `<button type="button" class="small link syncnow" id="${esc(columnsId(t.table))}" data-choose="${esc(t.table)}"${choosing === t.table ? ` aria-expanded="true"` : ""} title="${esc(`${summary.title}. Choose which columns Mason syncs`)}">${esc(summary.text)}</button>`;
    const syncCtl = !t.added || adding_ ? ""
      : readOnly !== null ? `<span class="syncnow dim" title="${esc(readOnly)}">${esc(syncWord)}</span>`
      : `<button type="button" class="small link syncnow" id="${esc(syncId(t.table))}" data-choose-sync="${esc(t.table)}"${syncOpen === t.table ? ` aria-expanded="true"` : ""} title="${esc(`Choose how Mason keeps ${name} current`)}">${esc(syncWord)}</button>`;
    if (syncOpen === t.table && t.added && readOnly === null) {
      pops.push(pop(syncId(t.table), renderSyncChoice(t, syncChoice, syncAsk, open(`synccheck:${t.table}`), syncPicked), { kind: "dialog", label: `Sync ${name}` }));
    }
    const said_ = adding_ ? `<span class="dim">adding it…</span>`
      : t.added ? [
        syncCtl,
        colsCtl,
        l && l.state !== "done" && !t.error ? `<span class="what-copy t-${l.state}">${esc(l.what)}</span>` : "",
        t.error ? `<span class="err">${esc(firstLine(t.error))}</span>${t.error.includes("\n") ? details(`error:${t.table}`, "the whole error", `<pre>${esc(t.error)}</pre>`, open(`error:${t.table}`)) : ""}` : "",
        stream && stream.get(t.table) ? `<span class="stream dim">Stream: ${esc(stream.get(t.table))}</span>` : "",
      ].filter(Boolean).join("")
      : f.state ? `<span class="dim">${esc(f.state)}</span>` : "";
    // A COLUMN THE LIST'S CARD HAS NO ROOM FOR (app.css: Key, then Size, then Last sync, then Rows give way to the name)
    // says its fact here, in the note: each `.fold` is shown only while its column is hidden, its words the stylesheet's
    // (`data-fold`, drawn by `::before`) so the row's text is its cells' alone wherever every column is shown
    const sizeText = size?.text ? `size ${size.text}` : "";
    const lastText = t.added && y?.syncedAt && y?.ageSeconds != null ? `last sync ${duration(y.ageSeconds)} ago${y.syncSeconds != null ? `, took ${tookText(y)}` : ""}`
      : t.added && y?.syncSeconds != null ? `took ${tookText(y)}` : "";
    const folds = [["rows", t.added && t.copy && t.copy.phase !== "failed" ? `${rows} rows` : rows], ["key", f.key], ["last", lastText], ["size", sizeText]]
      .filter(([, x]) => x).map(([c, x]) => `<span class="fold f-${c}" data-fold="${esc(x)}"></span>`).join("");
    const note = under(folds + said_, "note");
    if (asking) {
      pops.push(pop(anchor, `<p class="confirm">Remove ${esc(name)}? Mason will stop syncing it and delete its synced data.</p>` +
        `<p class="pop-actions">${button(`Remove ${name}`, { confirmRemoveTable: t.table }, "danger small")} ${button("Cancel", { cancelRemoveTable: "", popClose: "" }, "small")}</p>`, { kind: "dialog", label: `Remove ${name}?` }));
    }
    // a refused add with its form open: the refusal is said in the form's popover, over the boxes as they were ticked
    // a table not added: Columns… (Add with its columns); an added one: its columns' summary (its column form)
    const formOpen = choosing === t.table && (!t.added || (summary !== null && readOnly === null));
    const formAnchor = t.added ? columnsId(t.table) : anchor;
    const refusedHere = outcome?.table === t.table && "failure" in outcome;
    if (formOpen) {
      pops.push(pop(formAnchor, (refusedHere ? renderFailure(outcome.failure) : "") + (t.added ? columnsForm(t, columns, ticked, savingColumns === t.table) : pickForm(t, columns, ticked)),
        { kind: "dialog", label: t.added ? `The columns ${name} syncs` : `Add ${name}` }));
    }
    if (outcome?.table === t.table && !(formOpen && refusedHere)) {
      // a sync saved (or refused) is said beside the sync it changed; an add or a remove beside the row's actions
      // a column form saved, beside its columns' summary
      pops.push(pop(outcome.at === "sync" && t.added && readOnly === null ? syncId(t.table) : outcome.at === "columns" && t.added && summary !== null && readOnly === null ? columnsId(t.table) : anchor,"failure" in outcome ? `${renderFailure(outcome.failure)}${button("Dismiss", { dismissOutcome: "", popClose: "" }, "small")}`
        : "added" in outcome ? renderTableAdded(outcome.added, outcome.at ?? false) : renderTablesRemoved(outcome.removed)));
    }
    if (synced?.table === t.table) {
      pops.push(pop(anchor, "failure" in synced ? `${renderFailure(synced.failure)}${button("Dismiss", { dismissSynced: "", popClose: "" }, "small")}` : renderSynced(synced.synced, t.table, s)));
    }
    return `<tr class="${t.added ? `c-added s-${y?.state ?? "unknown"}` : t.reason ? "c-cannot" : "c-not"}${said_ ? " has-note" : ""}"><th scope="row" class="name"><code class="name" title="${esc(t.table)}">${nameBreaks(t.table)}</code></th>` +
      `<td class="state">${state}${bar}</td>${cell(rows, "num rows")}${cell(f.key, "mono key", f.key)}${last}` +
      `${size ? cell(size.text, "num size", size.title) : cell("", "num size")}` +
      `<td class="act" id="${esc(anchor)}">${act}</td></tr>` + note;
  };
  const added = s.tables.filter((t) => t.added).length;
  // a refusal for a table the list does not have (dropped since the run read the catalog): said above the list
  const stray = outcome !== null && "failure" in outcome && !s.tables.some((t) => t.table === outcome.table) ? renderFailure(outcome.failure) : "";
  const term = filter.trim();
  // the search box's text, over both lists, and Failed only: the tables that pass (the one a form or a confirm is open
  // on stays, whatever they say)
  const held_ = (t) => t.table === choosing || t.table === removing;
  const passes = (t) => (!failed || failedTable(t)) && nameMatches(t.table, filter);
  const laid = inLayout(s.tables, order);
  const addedShown = laid.added.filter((t) => passes(t) || held_(t));
  // Failed only: no table not added is listed (none of them can fail)
  const otherShown = laid.other.filter((t) => (!failed && passes(t)) || held_(t));
  const shown = addedShown.length + otherShown.length;
  // at most `limit` rows written across both lists, Added's first (the one a form or a confirm is open on always): a
  // database of 800 tables costs 100 rows
  const addedWritten = addedShown.filter((t, i) => i < limit || held_(t));
  const otherWritten = otherShown.filter((t, i) => addedShown.length + i < limit || held_(t));
  const matching = term ? `<p class="count dim">${n(shown)} with “${esc(term)}” in the name</p>` : "";
  const sizesFailed = added && sizes && "failure" in sizes ? `<p class="count">The synced tables' sizes could not be read: ${esc(firstLine(sizes.failure.message))}.</p>` : "";
  const thead = `<thead><tr>${head.map(([h, c]) => `<th scope="col"${c ? ` class="${c}"` : ""}>${h}</th>`).join("")}</tr></thead>`;
  // `line` writes each row's popovers into `pops` as it goes: Added's rows first, in the order they are written
  const list = (rows) => panel(`<table class="catalog">${thead}<tbody>${rows.map(line).join("")}</tbody></table>`);
  const heading = (title, count) => `<h3 class="list-h">${esc(title)} <span class="dim">(${n(count)})</span></h3>`;
  const addedNone = added === 0 ? empty(readOnly === null ? "No table added yet. Add one from the list below." : "No table added yet. The tables to sync are set in the sources file.")
    : failed ? `<p class="dim">No failed table${term ? `'s name has “${esc(term)}”` : ""}.</p>`
    : `<p class="dim">No added table's name has “${esc(term)}”.</p>`;
  const addedHtml = heading("Added", addedShown.length) + (addedWritten.length ? list(addedWritten) : addedNone);
  // Not added: not under Failed only, and not while every row it would write is past the limit (Show more writes them)
  const otherNone = laid.other.length === 0 ? `<p class="dim">Every table in the database is added.</p>`
    : `<p class="dim">No table that is not added has “${esc(term)}” in its name.</p>`;
  const otherHtml = failed && !otherShown.length || otherShown.length && !otherWritten.length ? ""
    : heading("Not added", otherShown.length) + (otherWritten.length ? list(otherWritten) : otherNone);
  return stray + (viewOnly !== null ? readOnlyLine("Tables are not added, removed or synced", viewOnly)
    : readOnly === null ? "" : `<p class="count">You can't add or remove tables from this page. ${esc(readOnly)} <a href="${DEPLOY_DOCS_URL}" rel="noreferrer">The README</a> describes how.</p>`) +
    matching + addedHtml + otherHtml + pops.join("") + moreRows("tables", Math.min(limit, shown), shown, TABLE_ROWS) + sizesFailed +
    (added ? `<p class="dim">A synced table's size is measured every 10 minutes, once its rows are written to disk.</p>` : "");
}

/** Where the README says how to deploy a change to a server (its "Run it on a server" section, on the public
 *  repository), for a project deployed read-only. As `ROLES_DOCS_URL` (users.js): no referrer, since the page's address
 *  may carry a host's token, and the same tab, since a host may serve the page in a sandbox with no `allow-popups`. */
export const DEPLOY_DOCS_URL = "https://github.com/embeddable-hq/mason-data#run-it-on-a-server";

export const page = {
  id: "tables",
  title: "Tables",
  create(ctx) {
    const m = { removing: null, choosing: null, columns: null, outcome: null, ticked: null, held: null, heldFilter: null, heldFailed: null, filter: "", failed: false, syncing: [], adding: [], synced: null, limit: TABLE_ROWS,
      // the two lists as last laid out (`layoutOf`): null until the state is first read
      order: null,
      // the table whose Sync choice is open, what `GET api/tables/<table>/sync` answered for it (null while read), the
      // choice whose question is asked before it is saved, and the read in flight: ONE at a time for the page, never on
      // a timer — each is a connection to the database
      syncOpen: null, syncChoice: null, syncAsk: null, syncRead: null, syncPicked: null, heldNow: null,
      // whether the table whose form is open was added when it opened (its column form, issue 884: else Columns…, its
      // add), and the added table whose columns' save is asked
      choosingAdded: false, savingColumns: null };
    const state = () => ctx.read("api/state")?.body ?? null;
    const monotone = createMonotone();
    // the details open (a copy's whole error), by key: a poll rewrites the part, and they stay open
    const opened = createOpenSet();
    // THE LISTS ARE LAID OUT (from the latest state: Added and Not added) at ONE set of moments: the page shown
    // (`route`, which `show` calls every time, drops it, and the next state read lays it out; a reload is a new page),
    // the search box's text or Failed only changed. Never at a poll or an action's answer, so a table whose added mark
    // changes — from this page or `mason add` / `mason remove` beside it — keeps its row until the next of them.
    const layOut = () => { const s = state(); m.order = Array.isArray(s?.tables) ? layoutOf(s.tables) : null; };
    // WHILE A FORM IS OPEN OR A REMOVE ASKS, THE TABLES ARE RENDERED FROM THE STATE THEY WERE OPENED OVER (`held`): the
    // run reads the catalog again every few seconds, and a live database's row estimates move, so a part written from
    // each poll's state would be rewritten under the person — the form's ticks gone, the confirm's button replaced under
    // the click. So the list is FROZEN for as long as a form stays open or a Remove asks — however long that is, with no
    // refresh in between (its rows and its added marks may be minutes old) — and is written from the latest state again
    // once they Add, Cancel or confirm.
    const hold = () => {
      const held = m.choosing !== null || m.removing !== null || m.syncOpen !== null;
      m.heldFilter = held ? m.held === null ? m.filter : m.heldFilter : null;
      m.heldFailed = held ? m.held === null ? m.failed : m.heldFailed : null;
      m.held = held ? m.held ?? state() : null;
      // and the moment it is written as of: an age that moved would rewrite the part under the person (a choice ticked lost)
      m.heldNow = held ? m.heldNow ?? ctx.now().getTime() : null;
      if (m.choosing === null) m.ticked = null;
    };
    const actions = {
      /** Add a table (`mason add`): the answer beside its actions, then the state read again — the Overview shows its copy starting. */
      async addTable(table, columns = [], key = [], sent = { which: columns.length ? "only" : "all", columns, key }) {
        if (m.adding.includes(table)) return false;
        // from the click: the row says Adding… (the page paints before the answer), then the state read again shows the copy
        m.adding = [...m.adding, table];
        if (m.choosing !== table) { m.outcome = null; m.synced = null; }
        const r = await ctx.ask("api/pick", json("POST", pickBody(table, columns, key)));
        m.adding = m.adding.filter((x) => x !== table);
        // refused: said over the form, in its popover, written again with the boxes the person had ticked
        if ("failure" in r) { m.outcome = { table, failure: r.failure }; if (m.choosing === table) m.ticked = sent; return false; }
        m.outcome = { table, added: r.body }; m.choosing = null; m.columns = null; hold();
        await ctx.refresh(["api/state"]);
        return true;
      },
      /** Open a table's form: its columns read now, once (the state the page polls carries none). */
      async choose(table) {
        // a question opened takes the last answer away: two popovers never stand on one another
        m.choosing = table; m.removing = null; m.syncOpen = null; m.ticked = null; m.columns = null; m.outcome = null; m.synced = null; hold();
        m.choosingAdded = (m.held?.tables ?? []).some((t) => t.table === table && t.added);
        const r = await ctx.ask(columnsPath(table));
        // closed, or another table's opened, while it was read: that answer is not this form's
        if (m.choosing !== table) return false;
        m.columns = "failure" in r ? { table, failure: r.failure } : { table, columns: r.body.columns };
        return true;
      },
      cancelChoose() { m.choosing = null; m.columns = null; hold(); },
      /** Save an added table's column form (`mason add <table> --columns …`, its sync kept): the answer beside its
       *  columns' summary, then the state read again; refused, said over the form, its boxes as they were ticked. */
      async saveColumns(table, columns = [], key = [], sent = { which: columns.length ? "only" : "all", columns, key }) {
        const t = (m.held ?? state())?.tables.find((x) => x.table === table);
        if (!t?.added || m.savingColumns !== null) return false;
        m.savingColumns = table;
        const r = await ctx.ask("api/pick", json("POST", columnsBody(t, columns, key)));
        m.savingColumns = null;
        if ("failure" in r) { m.outcome = { table, failure: r.failure, at: "columns" }; if (m.choosing === table) m.ticked = sent; return false; }
        m.outcome = { table, added: r.body, at: "columns" }; m.choosing = null; m.columns = null; hold();
        await ctx.refresh(["api/state"]);
        return true;
      },
      /** Open a table's Sync choice: its sync, its polls' cost and Live's checks read now, once — after any read still in
       *  flight, so the page never has two checks of the database open at once. */
      async chooseSync(table) {
        m.syncOpen = table; m.syncChoice = null; m.syncAsk = null; m.syncPicked = null; m.choosing = null; m.removing = null; m.outcome = null; m.synced = null; hold();
        const before = m.syncRead;
        const read = (async () => { await before; return ctx.ask(syncPath(table)); })();
        m.syncRead = read;
        const r = await read;
        if (m.syncRead === read) m.syncRead = null;
        // closed, or another table's opened, while it was read: that answer is not this choice's
        if (m.syncOpen !== table) return false;
        m.syncChoice = "failure" in r ? { table, failure: r.failure } : r.body;
        return true;
      },
      cancelSync() { m.syncOpen = null; m.syncChoice = null; m.syncAsk = null; m.syncPicked = null; hold(); },
      backSync() { m.syncAsk = null; },
      /** A choice submitted: asked first when it must be (a big table's poll, Live with a warning), else saved. */
      chooseSyncValue(table, value) {
        if (m.syncOpen !== table || m.syncChoice?.table !== table || "failure" in m.syncChoice || typeof value !== "string") return false;
        if (syncQuestion(m.syncChoice, value) !== null) { m.syncAsk = value; return true; }
        return actions.saveSync(table, value);
      },
      /** Save a table's sync (`mason add <table> --sync …`, its columns kept): the answer, or the refusal as the run words
       *  it — Live's checks read again there — beside its sync, then the state read again. */
      async saveSync(table, value) {
        const r = await ctx.ask("api/pick", json("POST", syncBody(table, value)));
        m.syncOpen = null; m.syncChoice = null; m.syncAsk = null; m.syncPicked = null; hold();
        m.outcome = "failure" in r ? { table, failure: r.failure, at: "sync" } : { table, added: r.body, at: "sync" };
        if ("failure" in r) return false;
        await ctx.refresh(["api/state"]);
        return true;
      },
      askRemoveTable(table) { m.removing = table; m.choosing = null; m.syncOpen = null; m.outcome = null; m.synced = null; hold(); },
      cancelRemoveTable() { m.removing = null; hold(); },
      /** Remove a table (`mason remove`), once asked: the answer beside its actions, then the state read again. */
      async confirmRemoveTable(table) {
        const r = await ctx.ask("api/remove", json("POST", { tables: [table] }));
        m.removing = null; hold();
        if ("failure" in r) { m.outcome = { table, failure: r.failure }; return false; }
        m.outcome = { table, removed: r.body };
        await ctx.refresh(["api/state"]);
        return true;
      },
      dismissOutcome() { m.outcome = null; },
      /** Sync a table now (`mason sync <table>`): the answer beside its Sync, then the state read again. */
      async syncTable(table) {
        m.syncing = [...m.syncing, table];
        m.outcome = null; m.synced = null;
        const r = await ctx.ask("api/sync", json("POST", { tables: [table] }));
        m.syncing = m.syncing.filter((x) => x !== table);
        m.synced = "failure" in r ? { table, failure: r.failure } : { table, synced: r.body };
        await ctx.refresh(["api/state"]);
        return !("failure" in r);
      },
      dismissSynced() { m.synced = null; },
      /** Escape with no question open: the answer or refusal beside a row goes, as its Dismiss does */
      dismissAnswer() { m.outcome = null; m.synced = null; },
      /** The search box's text: kept here, so every poll writes the lists filtered by it. */
      filterTables(text) { m.filter = text; m.limit = TABLE_ROWS; layOut(); },
      /** Failed only, beside it: the failed tables alone (true), or every table (anything else). */
      failedOnly(on) { m.failed = on === true; m.limit = TABLE_ROWS; layOut(); },
      /** Write TABLE_ROWS more of the tables that pass, or all of them. */
      showMoreTables() { m.limit += TABLE_ROWS; },
      showAllTables() { m.limit = Infinity; },
    };
    return {
      model: m,
      reads: () => [{ path: "api/state", everyMs: POLL_MS }, { path: SIZES_PATH, everyMs: 60_000 }],
      afterRead() {
        const s = state();
        if (s === null) return;
        if (m.order === null) layOut();
        // a table removed or added elsewhere (mason remove, mason add) takes its confirm or its form with it
        const added = (table) => s.tables.some((t) => t.table === table && t.added);
        if (m.removing !== null && !added(m.removing)) m.removing = null;
        // a form's table added (Columns…) or removed (its column form) elsewhere takes the form with it
        if (m.choosing !== null && added(m.choosing) !== m.choosingAdded) m.choosing = null;
        if (m.syncOpen !== null && !added(m.syncOpen)) { m.syncOpen = null; m.syncChoice = null; m.syncAsk = null; }
        hold();
      },
      actions,
      view() {
        const s = m.held ?? state();
        const sizes = ctx.read(SIZES_PATH);
        // held still while a form is open or a Remove asks, the search box's text and Failed only included: nothing moves under the person
        const latest = state();
        return {
          "tables-cards": latest ? renderTablesCards(latest) : "",
          tables: s ? renderTables(s, { removing: m.removing, choosing: m.choosing, columns: m.columns, outcome: m.outcome, ticked: m.ticked, now: m.heldNow ?? ctx.now().getTime(),
            filter: m.held ? m.heldFilter : m.filter, failed: m.held ? m.heldFailed : m.failed, syncing: m.syncing, adding: m.adding, shares: monotone.of(latest ?? s), before: monotone.before, synced: m.synced, open: opened.has, limit: m.limit, order: m.order,
            syncOpen: m.syncOpen, syncChoice: m.syncChoice, syncAsk: m.syncAsk, syncPicked: m.syncPicked, savingColumns: m.savingColumns,
            sizes: sizes === undefined ? undefined : sizes.failure ? { failure: sizes.failure } : sizes.body }) : "",
        };
      },
      submit(form, FormData) {
        // a table's form is written into the tables part: the ticked boxes sent as they are (FormData's getAll: the
        // values of the boxes ticked, in the page's order)
        // a table's Sync choice: the one choice ticked
        if (form.dataset?.syncForm !== undefined) return actions.chooseSyncValue(form.dataset.syncForm, new FormData(form).get("sync"));
        if (form.dataset?.pickForm === undefined) return null;
        const table = form.dataset.pickForm, saving = m.choosingAdded && table === m.choosing;
        const f = new FormData(form);
        const s = columnsSent(f);
        // Only these with no box ticked: refused here, over the form as it was
        if (s === null) {
          m.outcome = { table, failure: NO_COLUMNS, ...(saving ? { at: "columns" } : {}) };
          m.ticked = { which: "only", columns: [], key: f.getAll("key") };
          return true;
        }
        // an added table's column form: its columns saved; else Columns…: the table added with them
        if (saving) return actions.saveColumns(table, s.columns, s.key, s.sent);
        return actions.addTable(table, s.columns, s.key, s.sent);
      },
      /** `#tables?show=failed` (where the Overview's failed card leads): Failed only, its box ticked; any other `show`
       *  (an older bookmark's `added` or `not-added`): every table, its box clear. */
      route(params, { doc } = {}) {
        // shown (again): the lists laid out anew, from the state read for it (until then, from the last: the same rule)
        m.order = null;
        if (params.show === undefined) return;
        actions.failedOnly(params.show === "failed");
        const box = doc?.getElementById?.("tables-failed");
        if (box) box.checked = m.failed;
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
        if (d.chooseSync !== undefined) return actions.chooseSync(d.chooseSync);
        if (d.cancelSync !== undefined) return actions.cancelSync() ?? true;
        if (d.backSync !== undefined) return actions.backSync() ?? true;
        if (d.saveSync !== undefined) return actions.saveSync(d.saveSync, d.sync);
        return null;
      },
      toggle: (target) => opened.toggle(target),
      /** Escape with no question or form open: the answer beside a row goes (null: none is shown) */
      dismiss() { if (m.outcome === null && m.synced === null) return null; actions.dismissAnswer(); return true; },
      input(target) {
        // a choice ticked in an open Sync choice: kept, so a rewrite of the part writes it as ticked (nothing to paint now)
        if (target.name === "sync" && target.form?.dataset?.syncForm === m.syncOpen) { m.syncPicked = target.value; return null; }
        if (target.id === "tables-failed") return actions.failedOnly(target.checked === true) ?? true;
        if (target.id !== "tables-filter") return null;
        return actions.filterTables(target.value) ?? true;
      },
    };
  },
};
