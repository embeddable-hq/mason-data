/**
 * THE USERS PAGE (#users): what `mason user list|add|from|disable|enable|remove` does — GET /api/users, POST /api/users,
 * POST /api/users/<name>/from, /disable and /enable, DELETE /api/users/<name>. An added user's password lives in this page's memory while its one-time dialog is open, never in
 * storage, a URL or a log line.
 */
import { actId, badge, button, code, copyable, copyClick, duration, empty, esc, json, panel, pop, renderFailure, ROOMS, serverHostNote, spanText, status, utcMinute, readOnlyLine, usersReadOnly } from "../shared.js";
import { VIEW_HASHES } from "../routes.js";

/** The users as the page reads them: with each one's last use (`mason user list` asks the same), then every 30 s. */
const USERS = "api/users?lastUsed=1";
const USERS_POST = "api/users";
const USERS_EVERY_MS = 30_000;
/** The run's state: where a tool connects (`postgres`, src/cli/pg-url.ts postgresFacts), the Connect panel's; and the
 *  roles file's state (`roles`, src/cli/run-server.ts rolesState), what each user's role is held to. */
const STATE = "api/state";
/** The roles a share may read as (`mason share --role`'s choices, src/cli/share-run.ts shareRole): read beside the state
 *  while the page may open a share (`shareable`), at the users' rate. */
const SHARE_CHOICES = "api/share/choices";
/** How often the state is read while a user just added waits for its first connection (its sessions, `/api/state`
 *  `sessions`): a few seconds, so Connected follows the tool soon; at the users' rate again once it is seen or dismissed. */
const WAITING_EVERY_MS = 5_000;

/** A time as `mason user list` stamps it: `2026-10-27 09:10`, UTC. */
const stamp = utcMinute;

/** When a user was last used, as `mason user list` says it (src/cli/user.ts `lastUsedText`, held equal by the tests): the
 *  time, or why not — unknown, never (added within the log's days, and no statement since), or not within the log's days. */
export function lastUsedText(u, lastUsedNote, requestLogDays, now = Date.now()) {
  if (u.lastUsedAt != null) return `${stamp(u.lastUsedAt)} UTC`;
  if (lastUsedNote != null) return "unknown";
  if (requestLogDays != null && u.addedAt != null && now - Date.parse(u.addedAt) < requestLogDays * 86_400_000) return "never";
  return `not used in the last ${requestLogDays ?? "?"} days`;
}

/** What a Disable does (`mason user disable`'s facts, src/cli/user.ts `disableEffect`, in the page's words: the page's
 *  way back is its Enable, where the CLI names mason user enable). */
export const disableEffect = () =>
  "It can't connect until you enable it again, with the same password. Its open sessions end at their next query.";

/** A disabled user's state, as `mason user list` says it (src/cli/user.ts `disabledText`, held equal by the tests). */
export const disabledText = (disabledAt) => `Disabled ${stamp(disabledAt)} UTC`;

/** A user's address ranges as `mason user` says them (src/cli/user.ts `rangesText`, held equal by the tests): the
 *  ranges, or any address. */
export const rangesText = (from) => from === null || from === undefined ? "any address" : from.join(", ");

/** Where a user connects from, in its row: "from anywhere", or "from" its ranges (`rangesText`). */
export const fromText = (from) => from === null || from === undefined ? "from anywhere" : `from ${rangesText(from)}`;

/**
 * THE "CONNECTS FROM" CHOICE, as `mason user add --help` says it: a dropdown, anywhere (no --from, the default: no
 * `from` is sent) or only these addresses (--from <range>, a comma list as `--from a,b` takes it), the address box
 * beside it. The box is shown only while "only these addresses" is chosen, and its place is kept while "anywhere" is
 * (the stylesheet hides it by `visibility`, never `display`), so nothing in the form moves when the choice changes.
 * `id`: the form's own, so two forms on the page never share an input's id; `from`: the ranges it opens with (null:
 * anywhere). The page never judges a range: the run reads each, and its refusal is said as the run words it (one
 * grammar, the server's).
 */
export function connectsChoice(id, from = null) {
  const only = Array.isArray(from);
  return `<span class="connects"><label for="${esc(id)}-connects">Connects from</label> ` +
    `<select id="${esc(id)}-connects" name="connects"><option value="any"${only ? "" : " selected"}>anywhere</option><option value="only"${only ? " selected" : ""}>only these addresses</option></select>` +
    ` <span class="ranges"><label class="sr" for="${esc(id)}-from">Address ranges, comma-separated</label>` +
    `<input id="${esc(id)}-from" name="from" spellcheck="false" autocapitalize="off" placeholder="e.g. 192.0.2.0/24, 2001:db8::/32" value="${esc(only ? from.join(", ") : "")}"></span></span>`;
}

/**
 * What a "Connects from" choice sends (`elements`: the form's): null for from anywhere — the add form sends no `from`
 * then, the change `{ from: null }` (mason user from --any) — else the ranges typed, split at each comma and trimmed, an
 * empty one dropped: `--from a,b`'s list. Nothing more is judged here; none typed is sent as none, for the run to refuse.
 */
export function rangesOf(elements) {
  if ((elements?.connects?.value ?? "any") !== "only") return null;
  return String(elements.from?.value ?? "").split(",").map((r) => r.trim()).filter((r) => r !== "");
}

/** The question being asked, from a model's `confirming`: a name alone is Remove's (as before), else `{ name, verb }`. */
const askOf = (confirming) => confirming === null || confirming === undefined ? null : typeof confirming === "string" ? { name: confirming, verb: "remove" } : confirming;

/** a user's attributes as `mason user list` says them (src/cli/user.ts attributesText, held equal by tests/web-page.test.ts) */
export const attributesText = (a) => Object.entries(a).map(([k, v]) => `${k}=${typeof v === "string" ? v : `[${v.join(", ")}]`}`).join(", ");

/** The users' tab a hash names (`show`): "removed", else "active", the default. */
const showOf = (v) => v === "removed" ? "removed" : "active";

/** A users' tab's address: `#users` (Active) or `#users?show=removed`, as src/web/app.js `hashOf("users", { show })`
 *  writes it and `parseHash` reads it (held equal by tests/web-page.test.ts). */
export const usersShowHref = (show) => `#${VIEW_HASHES.users}${showOf(show) === "removed" ? "?show=removed" : ""}`;

/** THE USERS' TABS, Active and Removed, each with its count: a segmented control as the time range's (`.range`), each a
 *  link to its address, so the hash is the choice and Back returns to the tab before; nothing is stored. */
function usersTabs(show, active, removed) {
  return `<div class="range users-show" role="group" aria-label="Show users">${[["active", "Active", active], ["removed", "Removed", removed]]
    .map(([k, label, n]) => `<a href="${esc(usersShowHref(k))}"${k === show ? ` aria-current="true"` : ""}>${esc(label)} <span class="n">${n}</span></a>`).join("")}</div>`;
}

/**
 * THE USERS from `/api/users?lastUsed=1` (`mason user list --json`'s shape), in a table in a card: a row each — its name
 * in mono with its id muted, its status as a dot and the word (Active, Disabled and when, or Removed and when), when it
 * was added, when it was last used (an age, `lastUsedText`'s UTC time in a title; or the note why it is not known), then
 * Queries, Disable — Enable for a disabled one, in Disable's room — and Remove. Over the table, two tabs (`usersTabs`):
 * Active, the users not removed (a disabled one among them), and Removed, the removed ones, muted, without actions —
 * each with its count; `show` ("active", the default, or "removed") is the hash's (`#users?show=removed`), so Back
 * goes to the tab before. An empty tab is one quiet line; no user at all, the "No users yet" line and no tabs. A Remove or a Disable asks first
 * (`confirming`: the name, Remove's; or { name, verb: "disable" }), in a popover beside the row's actions; an Enable
 * asks nothing. A refused action (`refused`: { name, failure }) is said there too, until dismissed. `now` is the
 * page's clock, in ms. `roles`: `/api/state`'s (`mason status --json`'s): while the roles file cannot be read every
 * user held to it is refused (57P03), said above the table as `mason user list`'s tip says it (src/cli/roles.ts
 * rolesProblemText, held equal by tests/web-page.test.ts) and in each user's role; beside the role, the user's
 * attributes (its row filters' values) and, where it lacks one its role's filters read, that its statements are refused.
 * `readOnly`: `/api/state` `pageReadOnly` (MASON_UI_READ_ONLY=1) — no Disable, Enable or Remove, its addresses said
 * as text, and the page says why; null on a page whose users are still its own (MASON_UI_READ_ONLY_ALLOW=users:
 * `usersReadOnly`). Each user's addresses (`from`, `mason user list --json`'s: its ranges, or null for any address) are a
 * line under its role ("from anywhere", "from 192.0.2.0/24"), which is its From…: it asks, in a popover beside the
 * row's actions as Disable does, where it connects from (`confirming` { name, verb: "from" }) — the choice the add form
 * offers, opened at its ranges now — and sends POST /api/users/<name>/from.
 */
export function renderUsers(list, confirming = null, now = Date.now(), refused = null, roles = null, readOnly = null, show = "active") {
  const live = list.users.filter((u) => u.removedAt == null);
  const gone = list.users.filter((u) => u.removedAt != null);
  const why = readOnlyLine("Users are not added, changed, disabled or removed", readOnly);
  if (!live.length && !gone.length) return why + (readOnly !== null ? empty("No users yet:", `${code("mason user add <name>")} adds one.`)
    : empty("No users yet. Create a user for a service like a BI tool or your app: add one below."));
  const tab = showOf(show);
  const users = tab === "removed" ? gone : live;
  const note = (what, text) => text ? `<p class="dim">${esc(what)}: ${esc(text)}.</p>` : "";
  const broken = roles && roles.problem != null ? roles : null;
  const brokenNote = broken ? `<p class="warn">${esc(`${broken.file ?? "mason/roles.yml"} cannot be read as it is now, so every statement of a user held to it is refused: ${broken.problem}`)}</p>` : "";
  const tabs = usersTabs(tab, live.length, gone.length);
  if (!users.length) return why + brokenNote + tabs + empty(tab === "removed" ? "No removed users." : readOnly !== null ? "No active users." : "No active users. Add one below.");
  // a Remove's or a Disable's question is a popover beside the user's actions (`pop`), never a row: no row below it moves
  const pops = [];
  const ask = askOf(confirming);
  return why + brokenNote + tabs + panel(`<table class="users"><thead><tr><th scope="col">User</th><th scope="col" class="role">Role</th><th scope="col" class="status">Status</th><th scope="col" class="added">Added</th><th scope="col" class="num last">Last used</th><th scope="col" class="act"></th></tr></thead><tbody>${users.map((u) => {
    const active = u.removedAt == null;
    const last = lastUsedText(u, list.lastUsedNote, list.requestLogDays, now);
    const lastCell = !active ? "" : u.lastUsedAt != null
      ? `<span title="${esc(last)}">${esc(duration(Math.max(0, (now - Date.parse(u.lastUsedAt)) / 1000)))} ago</span>` : esc(last);
    const disabled = active && u.disabledAt != null;
    const asking = active && ask?.name === u.name ? ask.verb : null;
    const anchor = actId("users", u.name);
    if (asking === "remove") pops.push(pop(anchor, `<p class="confirm">Remove ${esc(u.name)}? It can no longer connect, and its open sessions end at their next query.</p>` +
      `<p class="pop-actions">${button(`Remove ${u.name}`, { confirmRemove: u.name }, "danger small")} ${button("Cancel", { cancelRemove: "", popClose: "" }, "small")}</p>`, { kind: "dialog", label: `Remove ${u.name}?` }));
    else if (asking === "disable") pops.push(pop(anchor, `<p class="confirm">Disable ${esc(u.name)}? ${esc(disableEffect())}</p>` +
      `<p class="pop-actions">${button(`Disable ${u.name}`, { confirmDisable: u.name }, "danger small")} ${button("Cancel", { cancelRemove: "", popClose: "" }, "small")}</p>`, { kind: "dialog", label: `Disable ${u.name}?` }));
    // the form's first input is its choice (a dialog's first box takes the focus): the user it changes is last, hidden
    else if (asking === "from") pops.push(pop(anchor, `<form id="user-from" class="from-form" autocomplete="off">` +
      `<p class="ask-from">Choose where ${esc(u.name)} can connect from. If you limit it, open sessions from other addresses end at their next query.</p>` +
      connectsChoice("user-from", u.from ?? null) +
      `<p class="pop-actions"><button type="submit" class="primary small">Change ${esc(u.name)}</button> ${button("Cancel", { cancelRemove: "", popClose: "" }, "small")}</p>` +
      `<input type="hidden" name="user" value="${esc(u.name)}"></form>`, { kind: "dialog", label: `Where ${u.name} connects from` }));
    else if (refused?.name === u.name) pops.push(pop(anchor, `${renderFailure(refused.failure)}<p class="pop-actions">${button("Dismiss", { dismissRefused: "", popClose: "" }, "small")}</p>`));
    return `<tr${active ? "" : ` class="removed"`}><th scope="row"><code class="name" title="${esc(u.name)}">${esc(u.name)}</code> <span class="dim">id ${esc(u.id)}</span></th>` +
      // the role it reads as (src/cli/roles.ts userRole): its own (mason user add --role) — one the roles file does not name,
      // said — or the file's default; none under a file with no default reads nothing, said; no roles file, every table
      `<td>${broken ? `<span class="warn">refused: the roles file can't be read</span>` : u.readsNothing === true ? `<span class="warn">no role, and the roles file has no default: its queries are refused</span>`
        : u.role === undefined ? `<span class="dim">every table</span>`
        : `${code(u.role)}${u.roleFrom === "default" ? ` <span class="dim">(default)</span>` : ""}${u.attributes ? ` <span class="dim">${esc(attributesText(u.attributes))}</span>` : ""}` +
          `${u.roleKnown === false ? ` <span class="warn">not in the roles file: its queries are refused</span>` : ""}` +
          `${u.missingAttributes ? ` <span class="warn">${esc(`no value for ${u.missingAttributes.join(", ")}: its queries are refused`)}</span>` : ""}`}` +
      // where it connects from, a line of its own under what it reads (mason user list's `from …`; none said there: any
      // address), as the user's id is under its name — so a row stays two lines, a Disable moves no row, and the table
      // keeps its width: no column of its own. Cut by the column, its whole the title; where the page may change it, the
      // line is its From…, asked in a popover beside the row's actions
      `${!active ? "" : readOnly !== null ? `<span class="from-line" title="${esc(fromText(u.from))}">${esc(fromText(u.from))}</span>`
        : button(fromText(u.from), asking === "from" ? {} : { from: u.name }, "from-line", { disabled: asking === "from", expanded: asking === "from", title: `${fromText(u.from)}: change where ${u.name} connects from` })}</td>` +
      `<td>${!active ? status("unknown", `Removed ${stamp(u.removedAt)} UTC`) : disabled ? status("warn", disabledText(u.disabledAt)) : status("ok", "Active")}` +
      `${active && !disabled && !u.live ? ` <span class="warn">can't connect: the API key changed after it was added</span>` : ""}</td>` +
      `<td class="mono">${esc(stamp(u.addedAt))} UTC</td><td class="num">${lastCell}</td>` +
      // Queries: its statements of the last 24 hours on Observability › Queries (a removed user's too: its past)
      `<td class="act" id="${esc(anchor)}"><a class="btn small" href="${esc(userQueriesHref(u.name))}" title="the queries ${esc(u.name)} sent in the last 24 hours">Queries</a>${!active || readOnly !== null ? "" : ` ${toggle(u, disabled, asking === "disable")} ${asking === "remove" ? button("Remove", {}, "danger small", { disabled: true, expanded: true })
        : button("Remove", { remove: u.name }, "danger small")}`}</td></tr>`;
  }).join("")}</tbody></table>`) + pops.join("") + note("Last used", list.lastUsedNote);
}

/**
 * HOW A TOOL CONNECTS, once for the run (`/api/state` `postgres`: src/cli/pg-url.ts postgresFacts, what `mason status`
 * prints): the host, port, database and sslmode — what a BI tool's form asks for, each with Copy — then the URL with
 * `<user>:<password>` as placeholders. No psql line (issue 874): the URL is the same thing, pasted after `psql`. None of it is a user's: a row carries what is (its name, its
 * state), and a user's password is copied only from the card shown once when it is added (`renderAdded`). "" when the
 * run did not say. `shareTip`: where the page may open a temporary cloud login (`shareable`), a tip pointing to it in
 * the add box, for a tool that can't reach this machine.
 */
export function renderUsersConnect(pg, served = false, shareTip = false) {
  if (!pg || typeof pg.shown !== "string") return "";
  const rows = [["Host", pg.host, "users-connect-host"], ["Port", String(pg.port), "users-connect-port"], ["Database", pg.database, "users-connect-database"],
    ["SSL mode", pg.sslmode ?? "disable", "users-connect-sslmode"], ["URL", pg.shown, "users-connect-url"]];
  return `<div class="connect"><p class="connect-title">Connect</p>` +
    `<dl class="facts">${rows.map(([k, v, id]) => `<dt>${esc(k)}</dt><dd>${copyable(id, v)}</dd>`).join("")}</dl>` +
    serverHostNote(pg, served) +
    `<p class="tip"><span>Put a user's name and password in place of ${code("<user>")} and ${code("<password>")}. The password is shown only once, when you add the user. If it's lost, remove the user and add it again.</span></p>` +
    (shareTip ? `<p class="tip">A tool in the cloud that can't reach this machine: choose Temporary cloud login in the box above.</p>` : "") + `</div>`;
}

// ------------------------------------------------------------------ Temporary cloud login (mason share, from the page)

/** The page's share before anything was asked: what the share's renderers and the page's model start from. */
export const NO_SHARE = Object.freeze({ phase: "none", role: null, opened: null, ended: null, failure: null });

/** The share the page holds, as `/api/state` `share` lists it (`from: "page"`), or null. */
export const pageShareOf = (s) => s?.share?.shares?.find((x) => x.from === "page") ?? null;

/** Whether the page may open a share, from `/api/state` alone, as the server decides it: never under `mason serve`
 *  (`served`: its run refuses `/api/share`) and never on a read-only page (`pageReadOnly`, whatever it still allows). */
export const shareable = (s) => s !== undefined && s !== null && s.served !== true && (s.pageReadOnly ?? null) === null;

/** How a temporary cloud login ends, beside "Live until you stop it": a free one's hour, and the page closing (its
 *  beats stop). */
const endsLine = (endsAt, now) => (endsAt === null || endsAt === undefined ? ""
  : ` A free one ends sooner, within about an hour, at ${new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (in about ${Math.max(0, Math.round((Date.parse(endsAt) - now) / 60_000))} minutes). Then open a new one for a new address and password.`) +
  " It also ends within two minutes of closing this page.";

/** The two things the add box creates, its segments' words. */
const KINDS = [["user", "New user"], ["share", "Temporary cloud login"]];

/**
 * WHAT THE ADD BOX CREATES: two segments on the box, a segmented control as the time range's — "New user" (the add
 * form) and "Temporary cloud login" (`mason share`, from the page) — each a button, the one chosen pressed. Written only
 * where the page may open a share (`shareable`); elsewhere the box is the plain add form. The choice is the page's own
 * (`m.addKind`), never the hash: it is a form's, not a view's. The stylesheet shows the pane chosen and keeps the
 * other's place, unseen (both in one grid cell), so the box keeps the height of the taller and nothing below moves.
 */
export function renderAddKinds(kind = "user") {
  return `<div class="range add-kinds" role="group" aria-label="What to create">${KINDS.map(([k, label]) =>
    `<button type="button" data-add-kind="${k}" aria-pressed="${k === kind ? "true" : "false"}">${esc(label)}</button>`).join("")}</div>`;
}

/**
 * THE TEMPORARY CLOUD LOGIN'S PANE in the add box (src/cli/page-share.ts; `mason share`'s, from the page): what it is
 * for, in two sentences, then a Role choice where the roles a share may read as (`choices`: the read of
 * `/api/share/choices`, undefined before it) are more than one, and "Open a cloud login" — the click is the person's
 * yes to a public address, said above it. Written the same in every phase but while one opens or is open, when the
 * button is held, disabled (one at a time); what it opened, how it ended or why it was refused is the card's
 * (`renderShareCard`), where a user just added is shown. The roles unread: the button disabled, "Reading the roles…" beside
 * it; refused (a roles file that cannot be read, no role a share may read as): the run's Failure. "" where the page may
 * not open one (`shareable`).
 */
export function renderSharePane(s, m = NO_SHARE, choices = undefined) {
  if (!shareable(s)) return "";
  const body = choices?.body ?? null;
  const list = Array.isArray(body?.choices) ? body.choices : null;
  const role = list === null || list.length < 2 ? "" : `<span class="role-field"><label for="share-role">Role</label> <select id="share-role">${list.map((c) => `<option value="${esc(c.role)}"${c.role === chosenRole(m, list) ? " selected" : ""}>${esc(`${c.role}: ${c.reads}${c.default ? " (default)" : ""}`)}</option>`).join("")}</select></span> `;
  const failure = list === null && choices?.failure ? renderFailure(choices.failure) : "";
  const busy = m.phase === "opening" || (pageShareOf(s) !== null && m.phase !== "ended");
  const title = list === null ? "" : busy ? "One is open: stop it to open another" : "";
  return `<div class="share-pane"><p class="tip">For a tool in the cloud that can't reach this machine. Opens a public address with a login of its own, until you stop it.</p>` +
    failure + `<p class="share-ask">${role}${button("Open a cloud login", { shareOpen: "" }, "primary", { disabled: list === null || busy, title })}` +
    `${list === null && !failure ? ` <span class="dim">Reading the roles…</span>` : ""}</p></div>`;
}

/** How long a share has been public, as the role it reads as, and what it reads (`open`: as `/api/state` lists it, or
 *  the answer that opened it). */
const publicLine = (open, now) => `<p class="added-seen">${badge("Public", "warn")} for <time data-tick datetime="${esc(open.openedAt)}">${esc(spanText((now - Date.parse(open.openedAt)) / 1000))}</time>` +
  `${open.role !== null && open.role !== undefined ? `, as the role ${esc(open.role)}` : ""}: ${esc(open.reads)}</p>`;

/**
 * A TEMPORARY CLOUD LOGIN JUST OPENED, as the parts of the one-time dialog (`renderAdded`'s, index.html `#once`), while
 * the answer that opened it is in the page's memory (`m.opened`, until its "I have copied it"): titled "Temporary cloud
 * login", URL, Login and Password, the URL and the Password each with Copy, "Shown once" beside the password's Copy —
 * the login its own, never a user's; what it reads and for how long; and that the password is only shown once and is
 * not saved. NO_ONCE otherwise, and where the page may not open one (`shareable`).
 */
export function renderShareOnce(s, m = NO_SHARE, now = Date.now()) {
  if (!shareable(s) || m.opened === null || m.phase !== "open") return NO_ONCE;
  const listed = pageShareOf(s);
  const open = listed !== null && listed.user === m.opened.user ? listed : m.opened;
  return {
    "once-head": `<p class="once-title" id="once-title">Temporary cloud login</p>` +
      onceFacts([["URL", m.opened.url, "share-url"], ["Login", m.opened.user, null], ["Password", m.opened.password, "share-password"]], "share-password"),
    "once-status": publicLine(open, now),
    "once-foot": `<p class="tip">The password is only shown once and is not saved. This login is its own, and stops working when it ends.</p>`,
  };
}

/**
 * THE TEMPORARY CLOUD LOGIN, once asked: a card in the place and style "New user added" had (`.user-added`), under the
 * add box, titled "Temporary cloud login" on its top edge. While it opens: that it is opening. Open: its host, port and
 * login, and that the password was shown once (it is the one-time dialog's, `renderShareOnce`, and never this card's);
 * then what it reads and for how long, "Live until you stop it" with when a free one ends and that it ends when this
 * page closes, and Stop (`DELETE /api/share/<user>`, `#share-stop`: where the focus goes once the dialog closes).
 * Ended: how, from the run's `shareEnded` or the page's Stop; refused: the run's Failure. "" before anything was
 * asked, and where the page may not open one (`shareable`).
 */
export function renderShareCard(s, m = NO_SHARE, now = Date.now()) {
  if (!shareable(s)) return "";
  const head = `<p class="added-title">Temporary cloud login</p>`;
  const open = pageShareOf(s);
  if (open !== null && m.phase !== "ended") {
    const rows = [["Host", open.host ?? "opening…", "share-host"], ["Port", open.port === null || open.port === undefined ? "…" : String(open.port), "share-port"], ["Login", open.user, null]];
    return `<div class="user-added share-added" role="status">${head}` +
      `<dl class="facts">${rows.map(([k, v, id]) => `<dt>${esc(k)}</dt><dd>${id === null ? esc(v) : copyable(id, v)}</dd>`).join("")}</dl>` +
      publicLine(open, now) +
      `<p class="tip">The password was shown once, when it opened, and is not saved. For a new one, press Stop, then Open a cloud login.</p>` +
      `<p class="tip">Live until you stop it.${esc(endsLine(open.endsAt, now))}</p>` +
      `${button("Stop", { shareStop: open.user }, "danger", { id: "share-stop" })}</div>`;
  }
  if (m.phase === "opening") return `<div class="user-added share-added" role="status">${head}<p class="added-seen" aria-busy="true">Opening a temporary public address… This can take up to 30 s.</p></div>`;
  if (m.phase === "ended" && m.ended !== null) return `<p class="said">The temporary cloud login ended: ${esc(m.ended.why)}. Its address and password no longer work.</p>`;
  if (m.phase === "refused" && m.failure !== null) return renderFailure(m.failure);
  return "";
}

/** The role a share opens with: the one chosen, while the roles offer it, else the file's default, else the first. */
const chosenRole = (m, list) => list.some((c) => c.role === m.role) ? m.role : list.find((c) => c.default)?.role ?? list[0]?.role ?? null;

/** What a page beats with, when the answer that opened the share does not say (src/cli/page-share.ts BEAT_MS). */
const BEAT_MS = 15_000;

/**
 * THE PAGE'S SIDE OF A TEMPORARY CLOUD LOGIN (src/cli/page-share.ts has why each choice): open (the click on Open a
 * cloud login is the yes), BEAT while it is open — on a timer of its own, which runs while the tab is hidden (the poll
 * does not: the person is in their tool's tab, pasting) —, Stop. The password is in `m.opened` alone, the page's memory, until its
 * one-time dialog is closed (`dismissOnce`), and is
 * dropped the moment the share is seen ended. `ctx.timers` is a test's clock; a browser's own otherwise.
 */
export function createShare(ctx) {
  const m = { ...NO_SHARE };
  const timers = ctx.timers ?? globalThis;
  let beating = null;
  const stopBeats = () => { if (beating !== null) { timers.clearInterval(beating.id); beating = null; } };
  const ended = (user, why) => { stopBeats(); m.opened = null; m.phase = "ended"; m.ended = { user, why }; };
  const beat = async () => {
    if (beating === null) return;
    const user = beating.user;
    const r = await ctx.ask(`api/share/${encodeURIComponent(user)}/beat`, json("POST"));
    if ("failure" in r && r.failure.code === "not_found" && beating?.user === user) { ended(user, r.failure.message.replace(/^.*?; it ended: /, "")); await ctx.refresh([STATE]); }
  };
  const startBeats = (user, everyMs = BEAT_MS) => {
    if (beating?.user === user) return;
    stopBeats();
    beating = { user, id: timers.setInterval(() => { void beat(); }, everyMs) };
  };
  const roles = () => { const c = ctx.read(SHARE_CHOICES)?.body?.choices; return Array.isArray(c) ? c : null; };
  const actions = {
    shareRole(role) { if (roles()?.some((c) => c.role === role)) m.role = role; },
    /** Open a cloud login: the click is the person's yes to a public address (the pane's sentence is what they read first; no question follows); the run opens the share (confirmed), and its one answer carries the password */
    async shareOpen() {
      const list = roles();
      if (list === null || m.phase === "opening") return;
      const role = list.length > 0 ? chosenRole(m, list) : null;
      Object.assign(m, { phase: "opening", failure: null, ended: null });
      const r = await ctx.ask("api/share", json("POST", { from: "page", confirmed: true, ...(role !== null ? { role } : {}) }));
      if ("failure" in r) { m.phase = "refused"; m.failure = r.failure; await ctx.refresh([SHARE_CHOICES]); return; }
      Object.assign(m, { phase: "open", opened: { ...r.body, seen: false } });
      startBeats(r.body.user, r.body.beatMs);
      await ctx.refresh([STATE]);
    },
    async shareStop(user) {
      const r = await ctx.ask(`api/share/${encodeURIComponent(user)}`, json("DELETE"));
      if ("failure" in r && r.failure.code !== "not_found") { m.phase = "refused"; m.failure = r.failure; return; }
      ended(user, "you stopped it on this page");
      await ctx.refresh([STATE]);
    },
    shareBeat: beat,
  };
  return {
    m,
    actions,
    /** the one-time dialog while the answer that opened it is held (the shell's `once`): the focus to Stop once closed */
    once: () => m.opened !== null && m.phase === "open" ? { key: `share ${m.opened.user}`, back: "share-stop" } : null,
    /** its "I have copied it": the answer, and the password in it, dropped from the page's memory */
    dismissOnce() { m.opened = null; },
    /** after each read of the state: a share of the page's open is beaten (a reload's too); the one this page opened,
     *  once listed and now gone, ended — said with the run's why, and its password dropped */
    afterRead(s) {
      if (s === undefined || s === null) return;
      const open = pageShareOf(s);
      if (open !== null) {
        if (m.opened?.user === open.user) m.opened.seen = true;
        if (m.phase === "ended" && m.ended?.user === open.user) return;
        if (m.phase === "none" || m.phase === "ended" || m.phase === "refused") m.phase = "open";
        startBeats(open.user);
        return;
      }
      if (m.phase === "open" && (m.opened === null || m.opened.seen)) {
        const user = m.opened?.user ?? beating?.user ?? null;
        ended(user, s.shareEnded !== null && s.shareEnded !== undefined && s.shareEnded.user === user ? s.shareEnded.why : "it is no longer open");
      }
    },
    input(target) {
      if (target?.id !== "share-role") return null;
      actions.shareRole(target.value);
      return true;
    },
    click(d) {
      if (d.shareOpen !== undefined) return actions.shareOpen();
      if (d.shareStop !== undefined) return actions.shareStop(d.shareStop);
      return null;
    },
  };
}

/**
 * THE ADD FORM, from `/api/state` (`state`: its body, undefined until it is read): Name and Add a user, as `mason user
 * add <name>` — none while the state is unread, and none under `pageReadOnly` (MASON_UI_READ_ONLY=1), where it could
 * only fail. Where the roles file names roles and reads as it is (`state.roles`, `mason status --json`'s), a Role
 * choice too, as `--role`: the first option is what `mason user add <name>` gives with no `--role` — the file's
 * `default:`, marked and sending no role, so the user follows the default as the CLI's does; or, with no default, no
 * role — then each other role, sent as `role`. The server judges the role (src/cli/user.ts roleToAdd). Written the
 * same while nothing changes, so a poll never rewrites it under a name being typed. Then Connects from, as `--from`
 * (`connectsChoice`): from anywhere, the default, sends no `from`; only from these addresses sends the ranges typed.
 * Shown under MASON_UI_READ_ONLY=1 too when its users are the page's own (MASON_UI_READ_ONLY_ALLOW=users). Each field
 * (a label and its control) is one span, so the form lays out as one line where its card is wide enough and wraps by
 * field, never between a label and its control, below that (app.css `#add-user`). `inBox`: the form is the "New user"
 * pane of the add box (`renderAddKinds`), whose box is the card, so it is none of its own.
 */
export function renderAddUser(state, inBox = false) {
  if (state === undefined || state === null || usersReadOnly(state) !== null) return "";
  return `<form id="add-user"${inBox ? "" : ` class="formcard"`} autocomplete="off"><span class="name-field"><label for="user-name">Name</label> ` +
    `<input id="user-name" name="name" required placeholder="e.g. metabase" spellcheck="false" autocapitalize="off"></span>` +
    roleChoice(state.roles) + connectsChoice("add-user") + `<button type="submit" class="primary">Add a user</button></form>`;
}

/** The add form's Role choice from `/api/state` `roles`: "" with no roles file, one naming none, or one that cannot be
 *  read now (the roles it names are not known then) */
function roleChoice(r) {
  if (!r || r.file == null || r.problem != null || !Array.isArray(r.roles) || r.roles.length === 0) return "";
  const dflt = r.default != null && r.roles.includes(r.default) ? r.default : null;
  const first = dflt !== null ? `<option value="" selected>${esc(dflt)} (default)</option>` : `<option value="" selected>no role (its queries are refused)</option>`;
  return ` <span class="role-field"><label for="user-role">Role</label> <select id="user-role" name="role">${first}` +
    `${r.roles.filter((n) => n !== dflt).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select></span> `;
}

/** A user's statements: Observability › Queries filtered to it, over the last 24 hours (Now's 15 minutes would mostly be empty). */
export const userQueriesHref = (name) => `#observability/queries?${new URLSearchParams({ user: name, range: "24h" })}`;

/** A user's Disable, or Enable once disabled: one room (ROOMS.disable), so the row's actions keep their width; held
 *  while its question is asked. */
function toggle(u, disabled, asking) {
  if (disabled) return button("Enable", { enable: u.name }, "small", { room: ROOMS.disable });
  return asking ? button("Disable", {}, "small", { room: ROOMS.disable, disabled: true, expanded: true })
    : button("Disable", { disable: u.name }, "small", { room: ROOMS.disable });
}

/** The one-time dialog's parts (index.html `#once`, opened by the shell while a page's `once()` names it) with nothing in
 *  them: its head (the title, `#once-title`, and the facts), its status line and its foot (the line over its button). */
export const NO_ONCE = Object.freeze({ "once-head": "", "once-status": "", "once-foot": "" });

/** The one-time dialog's facts: a label and its value each, a value with an id its Copy, "Shown once" beside the password's. */
const onceFacts = (rows, passwordId) => `<dl class="facts">${rows.filter(([, v]) => v !== undefined && v !== null).map(([k, v, id]) =>
  `<dt>${esc(k)}</dt><dd>${id === null ? esc(v) : copyable(id, v, id === passwordId ? badge("Shown once", "warn") : "")}</dd>`).join("")}</dl>`;

/**
 * A USER JUST ADDED (`mason user add --json`'s shape), as the parts of the one-time dialog (index.html `#once`, a modal
 * the shell opens while the page's `once()` names it, and closes only by its "I have copied it"): titled "New user
 * added", with URL, User and Password, in that order (issue 876): the URL and the Password each with a Copy button laid
 * out the same way, the User its name as plain text (issue 839). Right of the password's Copy, in its row and of the
 * button's height, "Shown once"; under the rows, whether it has connected (`o.connected`, `addedSeen`): Waiting for its
 * first query…, then Connected — a part of its own, so its change rewrites nothing the person is copying from; then one
 * line: the password is only shown once. No Database row: the URL already carries the database, and the Database, Host,
 * Port and SSL mode are the run's, said by Connect on the same page (renderUsersConnect); `mason user add` in a terminal
 * prints them all. No psql line: the URL is the same thing, pasted after `psql`. A field the JSON does not carry (the
 * URL while Mason does not run) is not shown. Mason keeps no copy, so it is never shown again.
 */
export function renderAdded(a, o = {}) {
  return {
    "once-head": `<p class="once-title" id="once-title">New user added</p>` +
      onceFacts([["URL", a.url, "added-url"], ["User", a.user, null], ["Password", a.password, "added-password"]], "added-password"),
    "once-status": connectedLine(o.connected === true),
    "once-foot": `<p class="tip">The password is only shown once</p>`,
  };
}

/** Whether the user just added has connected yet: waiting, then connected. */
const connectedLine = (connected) => `<p class="added-seen">${connected ? status("ok", "Connected") : status("warn", "Waiting for its first query…")}</p>`;

/**
 * WHETHER A USER JUST ADDED HAS CONNECTED (`added`: `mason user add --json`'s answer; `state`: `/api/state`'s body;
 * `list`: `/api/users?lastUsed=1`'s): a session of it open now (`sessions.byClient`, the listener's: a login with its
 * password, which a tool's catalog queries alone already make), or a statement of it in the request log since it was
 * added (`lastUsedAt`, which a session too short to be seen between two reads leaves). The page holds it once seen.
 */
export function addedSeen(added, state, list) {
  if (added === null || added === undefined) return false;
  const by = state?.sessions?.byClient;
  if (Array.isArray(by) && by.some((c) => c.user === added.user && c.open > 0)) return true;
  const u = list?.users?.find((x) => x.name === added.user && x.removedAt == null);
  return u !== undefined && u.lastUsedAt != null && Date.parse(u.lastUsedAt) >= Date.parse(added.addedAt);
}

export const page = {
  id: "users",
  title: "Users",
  create(ctx) {
    // held: what From… opened over ({ list, now, state }), so a poll never rewrites its form under what is being typed
    // added: the user just added (its password in it, this page's memory alone); addedSeen: whether it has connected
    // show: the list's tab, the hash's (`route`: #users?show=removed)
    const m = { actionFailure: null, added: null, addedSeen: false, confirming: null, refused: null, held: null, show: "active", addKind: "user" };
    // addKind: what the add box creates, "user" (New user) or "share" (Temporary cloud login): the box's own choice
    const users = () => ctx.read(USERS)?.body ?? null;
    // the temporary cloud login, the add box's second kind: its own model, beats and actions
    const share = createShare(ctx);
    m.share = share.m;
    const actions = {
      /** `role`: the Role choice's, sent as mason user add --role; "" or none: no role, as with no --role. `from`: the
       *  ranges, as mason user add --from; null or none: none sent, from anywhere */
      async addUser(name, role = "", from = null) {
        m.actionFailure = null;
        const r = await ctx.ask(USERS_POST, json("POST", { name, ...(role ? { role } : {}), ...(from !== null ? { from } : {}) }));
        if ("failure" in r) { m.actionFailure = r.failure; return false; }
        m.added = r.body;
        m.addedSeen = false;
        await ctx.refresh([USERS]);
        return true;
      },
      askRemove(name) { m.confirming = name; m.actionFailure = null; m.refused = null; },
      askDisable(name) { m.confirming = { name, verb: "disable" }; m.actionFailure = null; m.refused = null; },
      /** From…: where it connects from, asked in a popover over the list as it stands (held: no poll rewrites it) */
      askFrom(name) {
        m.confirming = { name, verb: "from" }; m.actionFailure = null; m.refused = null;
        m.held = { list: users(), now: ctx.now().getTime(), state: ctx.read(STATE)?.body ?? null };
      },
      cancelRemove() { m.confirming = null; m.held = null; },
      /** From… answered: POST /api/users/<name>/from (mason user from's own function) — `from` its ranges, or null for any
       *  address (--any); a refusal, worded by the run, said beside the user's actions as a Disable's is */
      async changeFrom(name, from) {
        m.actionFailure = null;
        m.refused = null;
        const r = await ctx.ask(`api/users/${encodeURIComponent(name)}/from`, json("POST", { from }));
        m.confirming = null;
        m.held = null;
        if ("failure" in r) { m.refused = { name, failure: r.failure }; return false; }
        await ctx.refresh([USERS]);
        return true;
      },
      /** Disable once asked, Enable at once: POST /api/users/<name>/disable|enable (mason user's own functions); a
       *  refusal is said beside the user's actions, as a Remove's is */
      async toggleUser(name, verb) {
        m.actionFailure = null;
        m.refused = null;
        const r = await ctx.ask(`api/users/${encodeURIComponent(name)}/${verb}`, json("POST"));
        m.confirming = null;
        if ("failure" in r) { m.refused = { name, failure: r.failure }; return false; }
        await ctx.refresh([USERS]);
        return true;
      },
      confirmDisable(name) { return actions.toggleUser(name, "disable"); },
      enableUser(name) { return actions.toggleUser(name, "enable"); },
      async confirmRemove(name) {
        m.actionFailure = null;
        const r = await ctx.ask(`api/users/${encodeURIComponent(name)}`, json("DELETE"));
        m.confirming = null;
        // refused: said beside the user's Remove, as its question was (nothing above the table moves it)
        if ("failure" in r) { m.refused = { name, failure: r.failure }; return false; }
        await ctx.refresh([USERS]);
        return true;
      },
      dismissAdded() { m.added = null; m.addedSeen = false; },
      dismissRefused() { m.refused = null; },
      ...share.actions,
    };
    return {
      model: m,
      // the users first (their read's failure is the page's banner), and the state for the Connect panel; the roles a
      // share may read as while the state says the page may open one
      // the state more often while a user just added waits for its first connection (its sessions)
      reads: () => [{ path: USERS, everyMs: USERS_EVERY_MS }, { path: STATE, everyMs: m.added !== null && !m.addedSeen ? WAITING_EVERY_MS : USERS_EVERY_MS },
        ...(shareable(ctx.read(STATE)?.body) ? [{ path: SHARE_CHOICES, everyMs: USERS_EVERY_MS }] : [])],
      afterRead() {
        share.afterRead(ctx.read(STATE)?.body);
        const u = users();
        if (m.added !== null && !m.addedSeen && addedSeen(m.added, ctx.read(STATE)?.body, u)) m.addedSeen = true;
        // the user asked about went (removed), or is disabled already (by mason user disable): the question goes
        const ask = askOf(m.confirming);
        if (ask !== null && u !== null && !u.users.some((x) => x.name === ask.name && x.removedAt == null && (ask.verb !== "disable" || x.disabledAt == null))) { m.confirming = null; m.held = null; }
        // a refusal beside a user whose row left the Active tab (removed beside the page): it goes with its row
        if (m.refused !== null && u !== null && !u.users.some((x) => x.name === m.refused.name && x.removedAt == null)) m.refused = null;
      },
      actions,
      /** THE ONE-TIME MOMENT the shell's dialog shows (index.html `#once`): a user just added — `key` its identity (a new one
       *  takes the focus again), `back` where the focus goes once it closes (the add form's Name) — else null */
      once() { return m.added !== null ? { key: `user ${m.added.user} ${m.added.addedAt}`, back: "user-name" } : share.once(); },
      /** its "I have copied it": the password dropped from the page's memory */
      dismissOnce() { if (m.added !== null) actions.dismissAdded(); else share.dismissOnce(); },
      /** `#users?show=removed`: the list's tab, as the hash says (none: Active). Another tab drops a question, a From…
       *  and a refusal beside a row of the tab left: their rows are not shown. */
      route(params) {
        const show = showOf(params.show);
        if (show !== m.show) { m.confirming = null; m.held = null; m.refused = null; }
        m.show = show;
      },
      /** a person arriving starts in the add form's Name (issue 887); none while the state is unread, none read-only */
      arrive() {
        const state = ctx.read(STATE)?.body;
        if (state === undefined || state === null) return undefined;
        return renderAddUser(state) === "" || (m.addKind === "share" && shareable(state)) ? null : "user-name";
      },
      view() {
        // while From… asks, the list as it opened (`held`): its form is never rewritten under what is being typed
        const h = m.held !== null && askOf(m.confirming)?.verb === "from" ? m.held : null;
        const u = h !== null ? h.list : users();
        const state = h !== null ? h.state : ctx.read(STATE)?.body ?? null;
        const s = ctx.read(STATE)?.body;
        const offer = shareable(s) && renderAddUser(s) !== "";
        return {
          // the roles file's state is the run's (/api/state roles): a file that cannot be read refuses every user held to it
          users: u ? renderUsers(u, m.confirming, h !== null ? h.now : ctx.now().getTime(), m.refused, state?.roles ?? null, usersReadOnly(state), m.show) : "",
          // the add box: what it creates where the page may open a temporary cloud login (else the plain form), each
          // kind's pane a part of its own, so a choice of kind rewrites neither (a name being typed stays)
          "add-kinds": offer ? renderAddKinds(m.addKind) : "",
          "add-user-box": renderAddUser(s, offer),
          "add-share-box": offer ? renderSharePane(s, share.m, ctx.read(SHARE_CHOICES)) : "",
          "users-connect": renderUsersConnect(s?.postgres, s?.served === true, offer),
          // a user just added, or a cloud login just opened: the one-time dialog's parts (the shell opens it while `once()` names it)
          ...(m.added ? renderAdded(m.added, { connected: m.addedSeen }) : renderShareOnce(s, share.m, ctx.now().getTime())),
          // what the box made, under it: a temporary cloud login
          added: renderShareCard(s, share.m, ctx.now().getTime()),
          action: m.actionFailure ? renderFailure(m.actionFailure) : "",
        };
      },
      submit(form) {
        if (form.id === "user-from") return actions.changeFrom(form.elements.user.value, rangesOf(form.elements));
        if (form.id !== "add-user") return null;
        const input = form.elements.name;
        return actions.addUser(input.value.trim(), form.elements.role?.value ?? "", rangesOf(form.elements)).then((ok) => { if (ok) input.value = ""; });
      },
      input: (target) => share.input(target),
      click(d, button, { doc, win }) {
        if (d.addKind !== undefined) { if (d.addKind === "user" || d.addKind === "share") m.addKind = d.addKind; return true; }
        const shared = share.click(d);
        if (shared !== null) return shared;
        if (d.remove !== undefined) return actions.askRemove(d.remove) ?? true;
        if (d.cancelRemove !== undefined) return actions.cancelRemove() ?? true;
        if (d.confirmRemove !== undefined) return actions.confirmRemove(d.confirmRemove);
        if (d.disable !== undefined) return actions.askDisable(d.disable) ?? true;
        if (d.confirmDisable !== undefined) return actions.confirmDisable(d.confirmDisable);
        if (d.from !== undefined) return actions.askFrom(d.from) ?? true;
        if (d.enable !== undefined) return actions.enableUser(d.enable);
        if (d.dismissRefused !== undefined) return actions.dismissRefused() ?? true;
        return copyClick(d, button, { doc, win });
      },
      /** Escape with no question open: a refusal beside a user goes, as its Dismiss does (null: none is shown) */
      dismiss() { if (m.refused === null) return null; actions.dismissRefused(); return true; },
    };
  },
};
