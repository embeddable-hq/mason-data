/**
 * THE WEB PAGE OF `mason start` (`mason ui`; docs/WEB-UI.md, and .claude/rules/web-ui.md for whoever builds it out):
 * one page, two sections, rendered from the run's command server's JSON (src/cli/run-server.ts) in the words the
 * commands print —
 *
 *   STATUS   GET /api/state, /api/slow, /api/refused: what `mason status` prints, polled every 2 s while the tab is seen
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
 * its state (done, unsynced, failed, copying, waiting), how full its bar is, and what it says.
 */
export function tableLine(t) {
  if (t.error) return { state: "failed", fraction: 1, what: `its copy failed: ${firstLine(t.error)}` };
  if (t.copy?.phase === "copying") {
    const c = copyingText(t.copy.rowsCopied, t.rows, t.copy.progress);
    return { state: "copying", fraction: c.fraction ?? 0, what: /^\d/.test(c.text) ? `copying ${c.text}` : c.text };
  }
  if (!t.copy) return { state: "waiting", fraction: 0, what: "waiting for its copy to start" };
  if (t.unsynced) {
    return { state: "unsynced", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied, NOT kept current (${t.unsynced.reason}${t.unsynced.asOf ? `; as of ${t.unsynced.asOf.slice(0, 16).replace("T", " ")} UTC` : ""}) — mason sync ${entryName(t.table)}, or mason start --replication` };
  }
  return { state: "done", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied${t.copy.retired ? ` · ${t.copy.retired}` : ""}` };
}

/** `mason status`'s rows for the database (src/cli/commands.ts `sourceRows`): its sources file, its URL as the run masked it, how its changes arrive. */
export function sourceRows(s) {
  return [
    ...(s.source.file ? [["Source", `${s.source.file} (the tables it names are added)`]] : []),
    ["Database", `${s.source.url} · Postgres ${s.source.version}${s.source.standby ? " · a read replica" : ""}`],
    ["Changes", s.source.replication ? `logical replication: slot ${s.source.replication.slot}, publication ${s.source.replication.publication} ` +
        `(${s.source.replication.owned ? "Mason's own" : "named: read as it is, never altered"}) · mason start --poll goes back to polling`
      : `polling with SELECTs (xmin), every ${s.engine.pollSeconds} s · mason start --replication reads the database's change log instead`],
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
  const rank = { done: 0, unsynced: 0, failed: 1, copying: 2, waiting: 3 };
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
 * `addUser` / `askRemove` / `cancelRemove` / `confirmRemove` / `dismissAdded` are the users' buttons; `view()` is the
 * HTML of each part of the page, from what it knows now. Nothing here touches a document.
 */
export function createApp(fetchFn, now = () => new Date()) {
  const m = { state: null, requests: {}, users: null, usersFailure: null, pollFailure: null, actionFailure: null, added: null, confirming: null, updatedAt: null };
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
  return {
    model: m,
    async poll() {
      const [st, slow, refused] = await Promise.all([ask("/api/state"), ask("/api/slow"), ask("/api/refused")]);
      if ("failure" in st) { m.pollFailure = st.failure; return; }
      m.state = st.body; m.pollFailure = null; m.updatedAt = now();
      m.requests = { slow: "failure" in slow ? slow : slow.body, refused: "failure" in refused ? refused : refused.body };
      await readUsers();
    },
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
  doc.addEventListener("click", async (e) => {
    const b = e.target.closest?.("button");
    if (!b) return;
    if (b.dataset.remove !== undefined) app.askRemove(b.dataset.remove);
    else if (b.dataset.cancelRemove !== undefined) app.cancelRemove();
    else if (b.dataset.confirmRemove !== undefined) await app.confirmRemove(b.dataset.confirmRemove);
    else if (b.dataset.dismissAdded !== undefined) app.dismissAdded();
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
