/**
 * THE WEB PAGE OF `mason start` (`mason ui`; docs/WEB-UI.md, and .claude/rules/web-ui.md for whoever builds it out):
 * one page, three sections, rendered from the run's command server's JSON (src/cli/run-server.ts) in the words the
 * commands print —
 *
 *   STATUS   GET /api/state, /api/slow, /api/refused: what `mason status` prints, polled every 2 s while the tab is seen
 *   TABLES   GET /api/state `tables`, POST /api/pick, POST /api/remove: what `mason tables`, `mason add` and `mason remove` do
 *   USERS    GET /api/users, POST /api/users, DELETE /api/users/<name>: what `mason user list|add|remove` does
 *
 * Plain JavaScript, an ES module, no framework and no build step: the server serves this file as it is, under a
 * `default-src 'self'` policy. The renderers are PURE FUNCTIONS OF THE JSON, returning HTML strings (every value
 * escaped), exported so tests/web-page.test.ts runs them under node; `createApp` holds what the page knows and does,
 * over a `fetch` it is handed; `start` (a browser only) wires them to the document. The page never holds the run's
 * token: the browser's cookie carries it (src/cli/security.ts).
 */

// ------------------------------------------------------------------ helpers, DOM-free

/** A value as HTML text: every character that means something in HTML escaped. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const n = (x) => x.toLocaleString("en-US");
const firstLine = (s) => s.split("\n")[0].trim();

/** A span of seconds as a person reads it: `45 s`, `12 min`, `2 h 5 min` (src/cli/readiness.ts `duration`, held equal by the tests). */
export function duration(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A share (0 to 1) as the commands print it beside a bar: whole percent, rounded down (`12%`). */
export const percent = (share) => `${Math.floor(Math.max(0, Math.min(1, share)) * 100)}%`;

/** The time a copy has left, as the commands print it: `~12 min left`; "" when nothing is measured yet. */
export const leftText = (secondsLeft) => secondsLeft === null || secondsLeft === undefined ? "" : `~${duration(secondsLeft)} left`;

/** A table as the commands name it: `orders` in public, else `schema.table` (src/cli/sources.ts `entryName`). */
export const entryName = (table) => table.startsWith("public.") ? table.slice("public.".length) : table;

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
    return { fraction, text: copied === 0 ? `${first}${estimate === null ? "" : ` · ~${n(estimate)} rows to copy`}` : `${rowsText(copied)} · resumed, ${first}` };
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
 * its state (done, failed, copying, waiting), how full its bar is, and what it says — a copied one with how it is kept
 * current and how old its copy is (`keptAge`).
 */
export function tableLine(t, now = Date.now()) {
  if (t.error) return { state: "failed", fraction: 1, what: `its copy failed: ${firstLine(t.error)}` };
  if (t.copy?.phase === "copying") {
    const c = copyingText(t.copy.rowsCopied, t.rows, t.copy.progress);
    return { state: "copying", fraction: c.fraction ?? 0, what: /^\d/.test(c.text) ? `copying ${c.text}` : c.text };
  }
  if (!t.copy) return { state: "waiting", fraction: 0, what: "waiting for its copy to start" };
  const age = keptAge(t, now);
  return { state: "done", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied${t.copy.retired ? ` · ${t.copy.retired}` : ""}${age ? ` · ${age}` : ""}` };
}

/** How long ago an instant was (src/lib/table-sync.ts `agoText`). */
export function agoText(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** How a copied table is kept current and how old its copy is (src/cli/commands.ts `keptAge`). */
export function keptAge(t, now = Date.now()) {
  const k = t.kept;
  if (k?.by !== "poll") return null;
  const synced = k.syncedAt === null ? "never synced" : `last synced ${agoText(k.syncedAt, now)}`;
  if (k.pending !== undefined) return `NOT kept current (${synced}): ${k.pending}`;
  if (k.sync.mode === "off") return `sync: off, ${synced} — mason sync ${entryName(t.table)} syncs it now`;
  return `polled every ${k.sync.every}, ${k.syncedAt === null ? "not polled yet" : `last ${agoText(k.syncedAt, now)}`}`;
}

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
  const name = entryName(b.table);
  const sync = b.bigOff ? `sync: off written on its entry: it has more than 1,000,000 rows, and each poll scans it whole on your database — ` +
      `mason add ${name} --sync "poll 1h" polls it hourly; mason sync ${name} syncs it once, now; mason start --replication keeps every table current from the change log`
    : b.sync.value === "off" ? `sync: off (${b.sync.from === "entry" ? "its entry's" : b.sync.from === "file" ? "the file's" : "the default"}): after its first copy it is read again only by mason sync ${name} — ` +
      `mason add ${name} --sync "poll 5m" polls it every 5 minutes`
    : `sync: ${b.sync.value} (${b.sync.from === "entry" ? "its entry's" : "the file's"}): polled every ${b.sync.value.slice("poll ".length)} after its first copy — mason add ${name} --sync off stops that`;
  return { line: `Added ${b.table} to ${file}: ${copies}${b.key ? `, copied by ${b.key.join(", ")}` : ""}${b.already ? " (already so)" : ""}`, notes: [
    sync,
    ...(b.pollCost !== null ? [b.pollCost] : []),
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

/** `mason status`'s rows for the database (src/cli/commands.ts `sourceRows`): its sources file, its URL as the run masked it, how its changes arrive. */
export function sourceRows(s) {
  return [
    ...(s.source.file ? [["Source", `${s.source.file} (the tables it names are added)`]] : []),
    ["Database", s.source.demo ? `the demo database Mason hosts (${s.source.url} · Postgres ${s.source.version})`
      : `${s.source.url} · Postgres ${s.source.version}${s.source.standby ? " · a read replica" : ""}`],
    ["Changes", s.source.replication ? `logical replication: slot ${s.source.replication.slot}, publication ${s.source.replication.publication} ` +
        `(${s.source.replication.owned ? "Mason's own" : "named: read as it is, never altered"}) · mason start --poll goes back to polling`
      : `each table as its sync: says, polled with SELECTs (xmin)${s.source.sync ? ` · sync: ${s.source.sync.default} ${s.source.sync.written ? "for every table without its own" : "(the default: the file writes none)"}` : ""} · ` +
        `${s.source.demo ? "the demo database is read by polling only" : "mason start --replication reads the database's change log instead"}`],
  ];
}

// ------------------------------------------------------------------ the renderers: JSON in, HTML out

const rowsHtml = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
const code = (s) => `<code>${esc(s)}</code>`;

/**
 * A FAILURE AS THE CLI SAYS IT (src/cli/command.ts `failureText`): what is wrong after a ✗, then `why` and `fix` as
 * rows, then Next: each command and what it does. `f` is the server's `failure` ({ code, message, why?, fix?, next }).
 */
export function renderFailure(f) {
  const rows = [...(f.why ? [["why", f.why]] : []), ...(f.fix ? [["fix", f.fix]] : [])];
  const next = f.next ?? [];
  return `<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${esc(f.message)}</p>` +
    (rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "") +
    (next.length ? `<p class="next-head">Next:</p><ul class="next">${next.map((s) => `<li>${code(s.command)}${s.what ? ` <span>${esc(s.what)}</span>` : ""}</li>`).join("")}</ul>` : "") +
    "</div>";
}

/** How many of `xs` were in the last day, or why they could not be read. */
const countLine = (label, r, count, tail) => "failure" in r
  ? `<p class="count">${esc(label)}: could not read them (${esc(firstLine(r.failure.message))}; ${code("mason logs")} has the detail)</p>`
  : `<p class="count">${esc(label)}: <strong>${n(count(r))}</strong> in the last day${tail(r)}</p>`;

/**
 * THE STATUS SECTION from `/api/state` (and the counts of `/api/slow`, `/api/refused`; each `{ failure }` when it could
 * not be read): what `mason status` prints — the database, each added table's copy (its bar, percent and the line
 * `mason wait` shows), the warnings, the slow and refused counts, and readiness. Never the engine's name.
 */
export function renderStatus(s, requests = {}) {
  const parts = [rowsHtml([...sourceRows(s), ...s.warnings.map((w) => ["Warning", w])])];
  const picked = s.tables.filter((t) => t.added);
  if (!picked.length) {
    parts.push(`<p class="readiness">No table added yet (${n(s.tables.length)} in the database).</p>`,
      `<p class="dim">${code("mason tables")} lists them; ${code("mason add <table>")} copies one.</p>`);
    return parts.join("");
  }
  // as tableLines orders them: the finished first, in the order they finished, then the failed, the copying, the waiting
  const rank = { done: 0, failed: 1, copying: 2, waiting: 3 };
  const lines = picked.map((t) => ({ t, l: tableLine(t) }))
    .sort((a, b) => rank[a.l.state] - rank[b.l.state] || (a.t.copy?.updatedAt ?? "").localeCompare(b.t.copy?.updatedAt ?? "") || a.t.table.localeCompare(b.t.table));
  parts.push(`<h3>Tables (${picked.length} of ${s.tables.length} added)</h3>`,
    `<table class="tables"><thead><tr><th scope="col">Table</th><th scope="col">Copy</th><th scope="col"></th></tr></thead><tbody>${lines.map(({ t, l }) =>
      `<tr class="t-${l.state}"><th scope="row">${code(t.table)}</th>` +
      `<td class="bar"><progress max="100" value="${Math.floor(Math.max(0, Math.min(1, l.fraction)) * 100)}"></progress> <span class="pct">${percent(l.fraction)}</span></td>` +
      `<td class="what">${esc(l.what)}${t.error && t.error.includes("\n") ? `<details><summary>the whole error</summary><pre>${esc(t.error)}</pre></details>` : ""}</td></tr>`).join("")}</tbody></table>`);
  if (requests.slow) parts.push(countLine("Slow queries", requests.slow, (r) => r.slow.length, (r) => ` (${n(r.slowMs / 1000)} s or more)`));
  if (requests.refused) parts.push(countLine("Refused queries", requests.refused, (r) => r.total ?? r.refused.length, () => ""));
  if (requests.slow || requests.refused) parts.push(`<p class="dim">${code("mason status")} lists them; ${code("mason logs --requests")} every one.</p>`);
  const r = s.readiness;
  if (r) {
    if (r.ready) parts.push(`<p class="readiness ok">Ready: every added table is copied and served.</p>`);
    else if (r.failed.length) parts.push(`<p class="readiness bad">Failed:</p><ul class="bullets">${r.failed.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    else parts.push(`<p class="readiness">Under way:</p><ul class="bullets">${r.waiting.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  }
  return parts.join("");
}

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
 *  The ticks live in the document while the person ticks (the tables part is held still meanwhile: `createApp`);
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
  const { removing = null, choosing = null, outcome = null, ticked = null } = ui;
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
  return `${stray}<p class="count">${n(added)} of ${n(s.tables.length)} added</p>` +
    `<table class="catalog"><thead><tr><th scope="col">Table</th><th scope="col">Rows</th><th scope="col">Key</th><th scope="col"></th><th scope="col"></th></tr></thead>` +
    `<tbody>${s.tables.map(line).join("")}</tbody></table>`;
}

/** The heading's line: the database the run copies, and its sources file's name when that is another. */
export function renderWhere(s) {
  return `${esc(s.source.database)}${s.source.name && s.source.name !== s.source.database ? ` · source ${esc(s.source.name)}` : ""}`;
}

/**
 * THE USERS from `/api/users` (`mason user list --json`'s shape): a line each — its name, when it was added, whether it
 * connects — with a Remove button; the one being removed asks first (`confirming`, its name).
 */
export function renderUsers(list, confirming = null) {
  if (!list.users.length) return `<p class="dim">No users yet.</p>`;
  return `<table class="users"><thead><tr><th scope="col">User</th><th scope="col">Added</th><th scope="col"></th></tr></thead><tbody>${list.users.map((u) =>
    `<tr><th scope="row">${code(u.name)}${u.live ? "" : ` <span class="warn">does not connect: the API key was rotated since it was added</span>`}</th>` +
    `<td class="dim">${esc(u.addedAt.slice(0, 16).replace("T", " "))} UTC · id ${esc(u.id)}</td>` +
    `<td class="act">${confirming === u.name
      ? `<span class="confirm">Remove ${esc(u.name)}? It connects no more, and the sessions it holds end at their next statement.</span> ` +
        `<button type="button" class="danger" data-confirm-remove="${esc(u.name)}">Remove ${esc(u.name)}</button> <button type="button" data-cancel-remove>Cancel</button>`
      : `<button type="button" data-remove="${esc(u.name)}">Remove</button>`}</td></tr>`).join("")}</tbody></table>`;
}

/**
 * A USER JUST ADDED (`mason user add --json`'s shape): its password, shown this once, in a box with a copy button,
 * beside the URL to paste — the rows `mason user add` prints. Mason keeps no copy, so it is never shown again.
 */
export function renderAdded(a) {
  const rows = [["url", a.url, "added-url"], ["user", a.user], ["password", a.password, "added-password"], ["database", a.database],
    ...(a.host !== undefined ? [["host", a.host], ["port", String(a.port)]] : []), ...(a.sslmode && a.sslmode !== "disable" ? [["ssl mode", a.sslmode]] : [])]
    .filter(([, v]) => v !== undefined);
  return `<div class="added" role="status"><p class="headline">The user ${esc(a.user)} added: its password is shown this once</p>` +
    `<dl class="facts">${rows.map(([k, v, id]) => `<dt>${esc(k)}</dt><dd>${id ? `<code id="${id}">${esc(v)}</code> <button type="button" data-copy="${id}">Copy</button>` : esc(v)}</dd>`).join("")}</dl>` +
    `<p class="tip">Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again. Lost, remove the user and add it again.</p>` +
    `<button type="button" data-dismiss-added>I have copied it</button></div>`;
}

/**
 * WHY A REQUEST TO THE RUN FAILED, as a Failure: the server's own `failure` when it sent one; else what the status
 * means here — 403, a cookie this run does not take (the run started again, with a new token); no answer at all, the
 * run stopped. `status` null: fetch itself failed, `text` its error.
 */
export function failureOf(status, text) {
  if (status !== null) {
    let body = null;
    // the guard answers its refusals as plain text, not JSON: read as text below
    try { body = JSON.parse(text); } catch { body = null; }
    if (body && typeof body.failure === "object" && body.failure !== null) return body.failure;
    if (status === 403 || status === 421) {
      return { code: "refused", message: "this page's cookie is not the running Mason's", why: text.trim() || `HTTP ${status}`,
        fix: "Mason was started again since this page was opened, and each run has its own token: mason ui, in the project's folder, opens this page again",
        next: [{ command: "mason ui", what: "this page, for the Mason that is running" }] };
    }
    return { code: "failed", message: (body && typeof body.error === "string" ? body.error : text.trim()) || `HTTP ${status}`, next: [{ command: "mason logs", what: "the run's log: what it was doing" }] };
  }
  return { code: "unreachable", message: "Mason does not answer at this address", why: `the run stopped, or runs on another port now (${text})`,
    fix: "mason start in the project's folder, then mason ui opens this page again: each run has its own address and token",
    next: [{ command: "mason status", what: "whether Mason runs, and why it stopped" }, { command: "mason start", what: "start it" }, { command: "mason ui", what: "this page, for the Mason that is running" }] };
}

/** The last-updated line: when the page last heard from the run, in the reader's time. */
export const updatedText = (at) => `Updated ${at.toLocaleTimeString("en-GB")}`;

// ------------------------------------------------------------------ what the page knows and does

/**
 * THE PAGE'S STATE AND ACTIONS, over `fetch` (the browser's, or a test's): `poll` reads the status and the users,
 * `addUser` / `askRemove` / `cancelRemove` / `confirmRemove` / `dismissAdded` are the users' buttons, `addTable` /
 * `choose` / `cancelChoose` / `askRemoveTable` / `cancelRemoveTable` / `confirmRemoveTable` / `dismissOutcome` the
 * tables'; `view()` is the HTML of each part of the page, from what it knows now. Nothing here touches a document.
 */
export function createApp(fetchFn, now = () => new Date()) {
  const m = { state: null, requests: {}, users: null, usersFailure: null, pollFailure: null, actionFailure: null, added: null, confirming: null, updatedAt: null,
    removing: null, choosing: null, outcome: null, ticked: null, held: null };
  // WHILE A FORM IS OPEN OR A REMOVE ASKS, THE TABLES ARE RENDERED FROM THE STATE THEY WERE OPENED OVER (`held`): the
  // run reads the catalog again every few seconds, and a live database's row estimates move, so a part written from
  // each poll's state would be rewritten under the person — the form's ticks gone, the confirm's button replaced under
  // the click. So the list is FROZEN for as long as a form stays open or a Remove asks — however long that is, with no
  // refresh in between (its rows and its added marks may be minutes old; the Status part above is written from each
  // poll as ever) — and is written from the latest state again once they Add, Cancel or confirm.
  const hold = () => { m.held = m.choosing !== null || m.removing !== null ? m.held ?? m.state : null; if (m.choosing === null) m.ticked = null; };
  /** One request: its JSON, or a Failure (`failure`) when it was refused or nothing answered. */
  const ask = async (path, init) => {
    let res;
    try { res = await fetchFn(path, { credentials: "same-origin", ...init }); }
    catch (e) { return { failure: failureOf(null, e?.message ?? String(e)) }; }
    const text = await res.text();
    if (!res.ok) return { failure: failureOf(res.status, text) };
    try { return { body: JSON.parse(text) }; }
    catch (e) { return { failure: { code: "failed", message: `the run's answer to ${path} is not JSON: ${e.message}` } }; }
  };
  const readUsers = async () => {
    const u = await ask("/api/users");
    if ("failure" in u) { m.usersFailure = u.failure; return; }
    m.users = u.body; m.usersFailure = null;
    if (m.confirming !== null && !m.users.users.some((x) => x.name === m.confirming)) m.confirming = null;
  };
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const poll = async () => {
    const [st, slow, refused] = await Promise.all([ask("/api/state"), ask("/api/slow"), ask("/api/refused")]);
    if ("failure" in st) { m.pollFailure = st.failure; return; }
    m.state = st.body; m.pollFailure = null; m.updatedAt = now();
    m.requests = { slow: "failure" in slow ? slow : slow.body, refused: "failure" in refused ? refused : refused.body };
    // a table removed or added elsewhere (mason remove, mason add) takes its confirm or its form with it
    const added = (table) => m.state.tables.some((t) => t.table === table && t.added);
    if (m.removing !== null && !added(m.removing)) m.removing = null;
    if (m.choosing !== null && added(m.choosing)) m.choosing = null;
    hold();
    await readUsers();
  };
  return {
    model: m,
    poll,
    /** Add a table (`mason add`): the answer under its line, then the state read again — the Status shows its copy starting. */
    async addTable(table, columns = [], key = []) {
      const r = await ask("/api/pick", json("POST", pickBody(table, columns, key)));
      // refused: said under the form, which is written again with the boxes the person had ticked
      if ("failure" in r) { m.outcome = { table, failure: r.failure }; if (m.choosing === table) m.ticked = { columns, key }; return false; }
      m.outcome = { table, added: r.body }; m.choosing = null; hold();
      await poll();
      return true;
    },
    choose(table) { m.choosing = table; m.removing = null; m.ticked = null; hold(); },
    cancelChoose() { m.choosing = null; hold(); },
    askRemoveTable(table) { m.removing = table; m.choosing = null; hold(); },
    cancelRemoveTable() { m.removing = null; hold(); },
    /** Remove a table (`mason remove`), once asked: the answer under its line, then the state read again. */
    async confirmRemoveTable(table) {
      const r = await ask("/api/remove", json("POST", { tables: [table] }));
      m.removing = null; hold();
      if ("failure" in r) { m.outcome = { table, failure: r.failure }; return false; }
      m.outcome = { table, removed: r.body };
      await poll();
      return true;
    },
    dismissOutcome() { m.outcome = null; },
    async addUser(name) {
      m.actionFailure = null;
      const r = await ask("/api/users", json("POST", { name }));
      if ("failure" in r) { m.actionFailure = r.failure; return false; }
      m.added = r.body;
      await readUsers();
      return true;
    },
    askRemove(name) { m.confirming = name; m.actionFailure = null; },
    cancelRemove() { m.confirming = null; },
    async confirmRemove(name) {
      m.actionFailure = null;
      const r = await ask(`/api/users/${encodeURIComponent(name)}`, json("DELETE"));
      m.confirming = null;
      if ("failure" in r) { m.actionFailure = r.failure; return false; }
      await readUsers();
      return true;
    },
    dismissAdded() { m.added = null; },
    view() {
      return {
        where: m.state ? renderWhere(m.state) : "",
        updated: m.updatedAt ? esc(updatedText(m.updatedAt)) : "",
        poll: m.pollFailure ? renderFailure(m.pollFailure) : "",
        status: m.state ? renderStatus(m.state, m.requests) : m.pollFailure ? "" : `<p class="dim">Asking Mason…</p>`,
        tables: m.state ? renderTables(m.held ?? m.state, { removing: m.removing, choosing: m.choosing, outcome: m.outcome, ticked: m.ticked }) : "",
        users: m.usersFailure ? renderFailure(m.usersFailure) : m.users ? renderUsers(m.users, m.confirming) : "",
        added: m.added ? renderAdded(m.added) : "",
        action: m.actionFailure ? renderFailure(m.actionFailure) : "",
      };
    },
  };
}

// ------------------------------------------------------------------ the browser

/** How often the status is asked while the tab is seen. */
export const POLL_MS = 2000;

/** Wire the app to the page: each part written from `view()`, the buttons and the form, the poll while the tab is seen. */
export function start(doc, win) {
  const app = createApp((path, init) => win.fetch(path, init));
  // what each part was last written, compared as written: the browser's innerHTML serialises attributes its own way
  // (data-x becomes data-x=""), and a part rewritten at every poll replaces the button under a click
  const written = new Map();
  const paint = () => {
    for (const [id, html] of Object.entries(app.view())) {
      const el = doc.getElementById(id);
      if (el === null || written.get(id) === html) continue;
      el.innerHTML = html;
      written.set(id, html);
    }
  };
  let busy = false;
  const poll = async () => {
    if (busy || doc.visibilityState !== "visible") return;
    busy = true;
    try { await app.poll(); } finally { busy = false; paint(); }
  };
  doc.getElementById("add-user").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    if (await app.addUser(input.value.trim())) input.value = "";
    paint();
  });
  // a table's form is written into the tables part: its submit is caught where it bubbles to, the ticked boxes sent as
  // they are (FormData's getAll: the values of the boxes ticked, in the page's order)
  doc.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.dataset?.pickForm === undefined) return;
    e.preventDefault();
    const ticked = new win.FormData(f);
    await app.addTable(f.dataset.pickForm, ticked.getAll("columns"), ticked.getAll("key"));
    paint();
  });
  doc.addEventListener("click", async (e) => {
    const b = e.target.closest?.("button");
    if (!b) return;
    if (b.dataset.remove !== undefined) app.askRemove(b.dataset.remove);
    else if (b.dataset.cancelRemove !== undefined) app.cancelRemove();
    else if (b.dataset.confirmRemove !== undefined) await app.confirmRemove(b.dataset.confirmRemove);
    else if (b.dataset.dismissAdded !== undefined) app.dismissAdded();
    else if (b.dataset.addTable !== undefined) await app.addTable(b.dataset.addTable);
    else if (b.dataset.choose !== undefined) app.choose(b.dataset.choose);
    else if (b.dataset.cancelChoose !== undefined) app.cancelChoose();
    else if (b.dataset.removeTable !== undefined) app.askRemoveTable(b.dataset.removeTable);
    else if (b.dataset.cancelRemoveTable !== undefined) app.cancelRemoveTable();
    else if (b.dataset.confirmRemoveTable !== undefined) await app.confirmRemoveTable(b.dataset.confirmRemoveTable);
    else if (b.dataset.dismissOutcome !== undefined) app.dismissOutcome();
    else if (b.dataset.copy !== undefined) {
      const text = doc.getElementById(b.dataset.copy)?.textContent ?? "";
      try { await win.navigator.clipboard.writeText(text); b.textContent = "Copied"; }
      catch (err) {
        // the clipboard refused (a browser setting): the text is selected, for the reader's own copy
        win.getSelection()?.selectAllChildren(doc.getElementById(b.dataset.copy));
        b.textContent = `Select and copy it (${err?.message ?? err})`;
      }
      return;
    }
    paint();
  });
  doc.addEventListener("visibilitychange", () => { void poll(); });
  win.setInterval(() => { void poll(); }, POLL_MS);
  void poll();
}

if (typeof document !== "undefined" && typeof window !== "undefined") start(document, window);
