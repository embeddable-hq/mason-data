/**
 * THE TABLES PAGE (#tables): each added table's copy — its sync's state, rows, last sync and its age, how long it took,
 * its error, the copy's own size — with Sync (POST /api/sync, `mason sync`); and the database's tables, as `mason
 * tables` lists them, with what `mason add` and `mason remove` do to them — Add, Columns… and Name its key…
 * (POST /api/pick), Remove (POST /api/remove). A search box filters both by name. Reads `/api/state` every poll and
 * `/api/usage`'s `copySizes` every minute (they are measured every 10 min).
 */
import { code, entryName, esc, fileSize, firstLine, json, n, renderFailure, rowsHtml, spanText, duration, utcText } from "../shared.js";

/** `/api/usage` asked for the copies' own sizes alone: the last minute's samples (none needed), and `copySizes`. */
export const SIZES_PATH = "/api/usage?since=1m";

/** A table's sync in one word (`/api/state` `tables[].sync.state`, src/cli/readiness.ts `syncStateOf`). */
export const SYNC_WORDS = { synced: "Synced", syncing: "Syncing", failed: "Failed", waiting: "Waiting" };

/** Whether a table's name has the search box's text (any case; nothing typed: every table). */
export const nameMatches = (table, filter) => !filter || table.toLowerCase().includes(filter.trim().toLowerCase());

/**
 * WHAT A SYNC DID, as `mason sync` prints it from `POST /api/sync`'s answer (src/cli/sync.ts `syncedReport`, held equal
 * by the tests): the rows written and deleted, a line per table, and that a table the passes do not keep current stays
 * as of this sync.
 */
export function syncedReport(b, picked, unsynced) {
  const changed = b.tables.reduce((a, t) => a + t.changed, 0), deleted = b.tables.reduce((a, t) => a + t.deleted, 0);
  return {
    headline: `Synced ${picked.join(", ")}: ${n(changed)} row(s) written, ${n(deleted)} deleted.`,
    details: b.tables.map((t) => [t.table, `${n(t.changed)} changed, ${n(t.deleted)} deleted, ${n(t.rows)} rows now · ${n(t.ms)} ms`]),
    tips: unsynced.filter((t) => t.unsynced !== undefined).map((t) => `${t.table} is ${t.unsynced.reason}: it stays as of this sync until the next mason sync (mason start --replication keeps every table current)`),
  };
}

/** A sync's answer said as `mason sync` says it, with Dismiss. `s`: the state, for the tables not kept current. */
export function renderSynced(b, table, s) {
  const r = syncedReport(b, [table], s.tables.filter((t) => t.table === table));
  return `<div class="done" role="status"><p class="headline">${esc(r.headline)}</p>${rowsHtml(r.details)}${r.tips.map((x) => `<p class="tip">Tip: ${esc(x)}</p>`).join("")}` +
    `<button type="button" data-dismiss-synced>Dismiss</button></div>`;
}

/**
 * THE COPIES: each added table's sync from `/api/state` (`tables[].sync`, `copy`, `error`), a row each — its state
 * (Synced / Syncing / Failed / Waiting), the copy's rows, when it was last synced and how long ago, how long that sync
 * took and by what, the copy's own size (`sizes`: `/api/usage`'s body or `{ failure }`), its error — with Sync.
 * `ui.filter` the search box's text; `ui.syncing` the tables whose sync is asked; `ui.synced` what the last one
 * answered ({ table, synced } | { table, failure }), under its table.
 */
export function renderCopies(s, sizes, ui = {}) {
  const { filter = "", syncing = [], synced = null } = ui;
  const added = s.tables.filter((t) => t.added);
  if (!added.length) return "";
  const shown = added.filter((t) => nameMatches(t.table, filter));
  const sizeOf = new Map(sizes && !("failure" in sizes) ? sizes.copySizes.map((c) => [c.table, c.bytes]) : []);
  const row = (t) => {
    const y = t.sync;
    const cells = [
      y ? SYNC_WORDS[y.state] : "",
      // a failed copy's rows so far are none: the copy it serves meanwhile is said by its error and mason status
      t.copy && t.copy.phase !== "failed" ? n(t.copy.rowsCopied) : "",
      y?.syncedAt ? utcText(y.syncedAt) : "",
      y?.ageSeconds != null ? `${duration(y.ageSeconds)} ago` : "",
      y?.syncSeconds != null ? `${spanText(y.syncSeconds)} (${y.syncedBy})` : "",
      sizeOf.has(t.table) ? fileSize(sizeOf.get(t.table)) : "",
    ];
    const error = t.error ? `${esc(firstLine(t.error))}${t.error.includes("\n") ? `<details><summary>the whole error</summary><pre>${esc(t.error)}</pre></details>` : ""}` : "";
    const act = syncing.includes(t.table) ? `<button type="button" disabled>Syncing…</button>` : `<button type="button" data-sync-table="${esc(t.table)}">Sync</button>`;
    const said = synced?.table !== t.table ? "" : `<tr class="under"><td colspan="9">${"failure" in synced ? renderFailure(synced.failure) : renderSynced(synced.synced, t.table, s)}</td></tr>`;
    return `<tr class="s-${y?.state ?? "unknown"}"><th scope="row">${code(t.table)}</th>${cells.map((c, i) => `<td${i === 1 || i === 5 ? ` class="num"` : ""}>${esc(c)}</td>`).join("")}` +
      `<td class="what">${error}</td><td class="act">${act}</td></tr>${said}`;
  };
  const head = ["Table", "State", "Rows", "Last sync (UTC)", "Age", "Took", "Size of the copy", "Error", ""];
  return `<table class="copies"><caption>The copies (${n(added.length)} added; ${code("mason status")} says the same)</caption>` +
    `<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${shown.map(row).join("")}</tbody></table>` +
    (!shown.length ? `<p class="dim">No added table's name has “${esc(filter.trim())}”.</p>` : "") +
    (sizes && "failure" in sizes ? `<p class="count">The copies' own sizes: could not read them (${esc(firstLine(sizes.failure.message))}; ${code("mason usage")} has them)</p>` : "") +
    `<p class="dim">A copy's own size is measured every 10 minutes (${code("mason usage")}).</p>`;
}

const POLL_MS = 2000;

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

/** A table just added (`/api/pick`'s answer, `mason add --json`'s `added` entry): the line and notes `mason add` prints. */
export function renderTableAdded(b) {
  const l = addedLines(b, b.file);
  return `<div class="done" role="status"><p class="headline">${esc(l.line)}</p>${l.notes.map((x) => `<p class="note">${esc(x)}</p>`).join("")}` +
    `<button type="button" data-dismiss-outcome>Dismiss</button></div>`;
}

/** Tables just removed (`/api/remove`'s answer, `mason remove --json`'s shape): what `mason remove` prints. */
export function renderTablesRemoved(b) {
  const r = removedReport(b.removed, b.file);
  return `<div class="done" role="status"><p class="headline">${esc(r.headline)}</p>${rowsHtml(r.details)}${r.tips.map((x) => `<p class="tip">Tip: ${esc(x)}</p>`).join("")}` +
    `<button type="button" data-dismiss-outcome>Dismiss</button></div>`;
}

const tick = (name, c, on) => `<label class="tick"><input type="checkbox" name="${name}" value="${esc(c.name)}"${on ? " checked" : ""}> ${code(c.name)} <span class="dim">${esc(c.type)}</span></label>`;

/** The form that adds a table with the columns ticked (`--columns`) and, for one with no primary key, its key (`--key`).
 *  The ticks live in the document while the person ticks (the tables part is held still meanwhile: the page's `held`);
 *  `ticked`, what a refused submit sent, writes them back when the refusal is said under the form. */
function pickForm(t, ticked = null) {
  const name = entryName(t.table);
  const boxes = (field) => t.columns.map((c) => tick(field, c, ticked?.[field]?.includes(c.name) ?? false)).join("");
  return `<form class="pick" data-pick-form="${esc(t.table)}" autocomplete="off">` +
    (t.key.length ? "" : `<fieldset><legend>Its key: the columns that tell its rows apart, as ${code(`mason add ${name} --key`)}</legend>${boxes("key")}</fieldset>`) +
    `<fieldset><legend>Its columns, as ${code(`mason add ${name} --columns`)} (none ticked: as ${code(`mason add ${name}`)}, every column)</legend>${boxes("columns")}</fieldset>` +
    `<button type="submit">Add ${esc(name)}</button> <button type="button" data-cancel-choose>Cancel</button></form>`;
}

/**
 * THE DATABASE'S TABLES from `/api/state` `tables` (`mason tables --json`'s list): a line each — its size, its key, and
 * added or why it cannot be added as it is, as `mason tables` prints them — with what can be done to it: Add (every
 * column, as `mason add <table>`) and Columns… (the form) for a table not added, Name its key… for one with no primary
 * key, Remove (asking first, `ui.removing`) for an added one. `ui.choosing` is the table whose form is open (`ui.ticked`
 * its boxes ticked: { columns, key }); `ui.outcome` what the last add or remove answered ({ table, added } |
 * { table, removed } | { table, failure }), under its table.
 */
export function renderTables(s, ui = {}) {
  const { removing = null, choosing = null, outcome = null, ticked = null, filter = "" } = ui;
  if (!s.tables.length) return `<p class="dim">${esc(s.source.database)} has no table this user can read.</p>`;
  const under = (html) => `<tr class="under"><td colspan="5">${html}</td></tr>`;
  const line = (t) => {
    const f = tableFacts(t);
    const name = entryName(t.table);
    const act = t.added
      ? removing === t.table
        ? `<span class="confirm">Remove ${esc(name)}? ${esc(removedReport([t.table], "").tips[0])}.</span> ` +
          `<button type="button" class="danger" data-confirm-remove-table="${esc(t.table)}">Remove ${esc(name)}</button> <button type="button" data-cancel-remove-table>Cancel</button>`
        : `<button type="button" data-remove-table="${esc(t.table)}">Remove</button>`
      : t.reason === null
        ? `<button type="button" data-add-table="${esc(t.table)}">Add</button> <button type="button" data-choose="${esc(t.table)}">Columns…</button>`
        : t.key.length ? "" : `<button type="button" data-choose="${esc(t.table)}">Name its key…</button>`;
    const said = outcome?.table !== t.table ? ""
      : under("failure" in outcome ? renderFailure(outcome.failure) : "added" in outcome ? renderTableAdded(outcome.added) : renderTablesRemoved(outcome.removed));
    return `<tr class="${t.added ? "c-added" : t.reason ? "c-cannot" : "c-not"}"><th scope="row">${code(t.table)}</th>` +
      `<td class="num">${esc(f.size)}</td><td>${esc(f.key)}</td><td class="state">${esc(f.state ?? "")}</td><td class="act">${act}</td></tr>` +
      (choosing === t.table && !t.added ? under(pickForm(t, ticked)) : "") + said;
  };
  const added = s.tables.filter((t) => t.added).length;
  // a refusal for a table the list does not have (dropped since the run read the catalog): said above the list
  const stray = outcome !== null && "failure" in outcome && !s.tables.some((t) => t.table === outcome.table) ? renderFailure(outcome.failure) : "";
  // the search box's text: the tables whose name has it (the one a form or a confirm is open on stays, whatever it says)
  const shown = s.tables.filter((t) => nameMatches(t.table, filter) || t.table === choosing || t.table === removing);
  const matching = filter.trim() ? ` · ${n(shown.length)} with “${esc(filter.trim())}” in the name` : "";
  return `${stray}<p class="count">${n(added)} of ${n(s.tables.length)} added${matching}</p>` +
    `<table class="catalog"><thead><tr><th scope="col">Table</th><th scope="col">Rows</th><th scope="col">Key</th><th scope="col"></th><th scope="col"></th></tr></thead>` +
    `<tbody>${shown.map(line).join("")}</tbody></table>`;
}

export const page = {
  id: "tables",
  title: "Tables",
  create(ctx) {
    const m = { removing: null, choosing: null, outcome: null, ticked: null, held: null, heldFilter: null, filter: "", syncing: [], synced: null };
    const state = () => ctx.read("/api/state")?.body ?? null;
    // WHILE A FORM IS OPEN OR A REMOVE ASKS, THE TABLES ARE RENDERED FROM THE STATE THEY WERE OPENED OVER (`held`): the
    // run reads the catalog again every few seconds, and a live database's row estimates move, so a part written from
    // each poll's state would be rewritten under the person — the form's ticks gone, the confirm's button replaced under
    // the click. So the list is FROZEN for as long as a form stays open or a Remove asks — however long that is, with no
    // refresh in between (its rows and its added marks may be minutes old) — and is written from the latest state again
    // once they Add, Cancel or confirm.
    const hold = () => {
      const held = m.choosing !== null || m.removing !== null;
      m.heldFilter = held ? m.held === null ? m.filter : m.heldFilter : null;
      m.held = held ? m.held ?? state() : null;
      if (m.choosing === null) m.ticked = null;
    };
    const actions = {
      /** Add a table (`mason add`): the answer under its line, then the state read again — the Status shows its copy starting. */
      async addTable(table, columns = [], key = []) {
        const r = await ctx.ask("/api/pick", json("POST", pickBody(table, columns, key)));
        // refused: said under the form, which is written again with the boxes the person had ticked
        if ("failure" in r) { m.outcome = { table, failure: r.failure }; if (m.choosing === table) m.ticked = { columns, key }; return false; }
        m.outcome = { table, added: r.body }; m.choosing = null; hold();
        await ctx.refresh(["/api/state"]);
        return true;
      },
      choose(table) { m.choosing = table; m.removing = null; m.ticked = null; hold(); },
      cancelChoose() { m.choosing = null; hold(); },
      askRemoveTable(table) { m.removing = table; m.choosing = null; hold(); },
      cancelRemoveTable() { m.removing = null; hold(); },
      /** Remove a table (`mason remove`), once asked: the answer under its line, then the state read again. */
      async confirmRemoveTable(table) {
        const r = await ctx.ask("/api/remove", json("POST", { tables: [table] }));
        m.removing = null; hold();
        if ("failure" in r) { m.outcome = { table, failure: r.failure }; return false; }
        m.outcome = { table, removed: r.body };
        await ctx.refresh(["/api/state"]);
        return true;
      },
      dismissOutcome() { m.outcome = null; },
      /** Sync a table now (`mason sync <table>`): the answer under its row, then the state read again. */
      async syncTable(table) {
        m.syncing = [...m.syncing, table];
        const r = await ctx.ask("/api/sync", json("POST", { tables: [table] }));
        m.syncing = m.syncing.filter((x) => x !== table);
        m.synced = "failure" in r ? { table, failure: r.failure } : { table, synced: r.body };
        await ctx.refresh(["/api/state"]);
        return !("failure" in r);
      },
      dismissSynced() { m.synced = null; },
      /** The search box's text: kept here, so every poll writes the lists filtered by it. */
      filterTables(text) { m.filter = text; },
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
        const s = m.held ?? state(), live = state();
        const sizes = ctx.read(SIZES_PATH);
        return {
          // held still while a form is open or a Remove asks, the search box's text included: nothing moves under the person
          tables: s ? renderTables(s, { removing: m.removing, choosing: m.choosing, outcome: m.outcome, ticked: m.ticked, filter: m.held ? m.heldFilter : m.filter }) : "",
          copies: live ? renderCopies(live, sizes === undefined ? undefined : sizes.failure ? { failure: sizes.failure } : sizes.body,
            { filter: m.filter, syncing: m.syncing, synced: m.synced }) : "",
        };
      },
      submit(form, FormData) {
        // a table's form is written into the tables part: the ticked boxes sent as they are (FormData's getAll: the
        // values of the boxes ticked, in the page's order)
        if (form.dataset?.pickForm === undefined) return null;
        const ticked = new FormData(form);
        return actions.addTable(form.dataset.pickForm, ticked.getAll("columns"), ticked.getAll("key"));
      },
      click(d) {
        if (d.addTable !== undefined) return actions.addTable(d.addTable);
        if (d.choose !== undefined) return actions.choose(d.choose) ?? true;
        if (d.cancelChoose !== undefined) return actions.cancelChoose() ?? true;
        if (d.removeTable !== undefined) return actions.askRemoveTable(d.removeTable) ?? true;
        if (d.cancelRemoveTable !== undefined) return actions.cancelRemoveTable() ?? true;
        if (d.confirmRemoveTable !== undefined) return actions.confirmRemoveTable(d.confirmRemoveTable);
        if (d.dismissOutcome !== undefined) return actions.dismissOutcome() ?? true;
        if (d.syncTable !== undefined) return actions.syncTable(d.syncTable);
        if (d.dismissSynced !== undefined) return actions.dismissSynced() ?? true;
        return null;
      },
      input(target) {
        if (target.id !== "tables-filter") return null;
        return actions.filterTables(target.value) ?? true;
      },
    };
  },
};
