/**
 * THE USERS PAGE (#users): what `mason user list|add|from|disable|enable|remove` does — GET /api/users, POST /api/users,
 * POST /api/users/<name>/from, /disable and /enable, DELETE /api/users/<name>. An added user's password lives in this page's memory until the person dismisses it, never in
 * storage, a URL or a log line.
 */
import { actId, badge, button, code, copyable, copyClick, duration, empty, esc, json, panel, pop, renderFailure, ROOMS, serverHostNote, status, utcMinute, readOnlyLine, usersReadOnly } from "../shared.js";

/** The users as the page reads them: with each one's last use (`mason user list` asks the same), then every 30 s. */
const USERS = "api/users?lastUsed=1";
const USERS_POST = "api/users";
const USERS_EVERY_MS = 30_000;
/** The run's state: where a tool connects (`postgres`, src/cli/pg-url.ts postgresFacts), the Connect panel's; and the
 *  roles file's state (`roles`, src/cli/run-server.ts rolesState), what each user's role is held to. */
const STATE = "api/state";

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

/** What a Disable does, as `mason user disable` says it (src/cli/user.ts `disableEffect`, held equal by the tests). */
export const disableEffect = (name) =>
  `It connects no more until mason user enable ${name}, with the same password, and the sessions it holds end at their next statement.`;

/** A disabled user's state, as `mason user list` says it (src/cli/user.ts `disabledText`, held equal by the tests). */
export const disabledText = (disabledAt) => `Disabled ${stamp(disabledAt)} UTC`;

/** A user's address ranges as `mason user` says them (src/cli/user.ts `rangesText`, held equal by the tests): the
 *  ranges, or any address. */
export const rangesText = (from) => from === null || from === undefined ? "any address" : from.join(", ");

/** Where a user connects from, in its row: "from anywhere", or "from" its ranges (`rangesText`). */
export const fromText = (from) => from === null || from === undefined ? "from anywhere" : `from ${rangesText(from)}`;

/**
 * THE "CONNECTS FROM" CHOICE, as `mason user add --help` says it: from anywhere (no --from, the default: no `from` is
 * sent) or only from these addresses (--from <range>, a comma list as `--from a,b` takes it). `id`: the form's own, so
 * two forms on the page never share an input's id; `from`: the ranges it opens with (null: from anywhere). The page
 * never judges a range: the run reads each, and its refusal is said as the run words it (one grammar, the server's).
 */
export function connectsChoice(id, from = null) {
  const only = Array.isArray(from);
  return `<fieldset class="connects"><legend>Connects from</legend>` +
    `<label class="tick"><input type="radio" name="connects" value="any"${only ? "" : " checked"}> From anywhere</label>` +
    `<label class="tick"><input type="radio" name="connects" value="only"${only ? " checked" : ""}> Only from these addresses</label>` +
    `<span class="ranges"><label class="sr" for="${esc(id)}-from">Address ranges, comma-separated</label>` +
    `<input id="${esc(id)}-from" name="from" spellcheck="false" autocapitalize="off" placeholder="e.g. 192.0.2.0/24, 2001:db8::/32" value="${esc(only ? from.join(", ") : "")}"></span></fieldset>`;
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

/**
 * THE USERS from `/api/users?lastUsed=1` (`mason user list --json`'s shape), in a table in a card: a row each — its name
 * in mono with its id muted, its status as a dot and the word (Active, Disabled and when, or Removed and when), when it
 * was added, when it was last used (an age, `lastUsedText`'s UTC time in a title; or the note why it is not known), then
 * Queries, Disable — Enable for a disabled one, in Disable's room — and Remove. The users
 * not removed first; a removed user is listed after them, muted, without actions. A Remove or a Disable asks first
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
export function renderUsers(list, confirming = null, now = Date.now(), refused = null, roles = null, readOnly = null) {
  const users = [...list.users.filter((u) => u.removedAt == null), ...list.users.filter((u) => u.removedAt != null)];
  const why = readOnlyLine("Users are not added, changed, disabled or removed", readOnly);
  if (!users.length) return why + empty("No users yet", readOnly !== null ? `A user is the name and password psql, a BI tool or your app connects with, as ${code("mason user add <name>")} adds one.`
    : `A user is the name and password psql, a BI tool or your app connects with. Add one above, as ${code("mason user add <name>")} does: its URL, password included, is shown once.`);
  const note = (what, text) => text ? `<p class="dim">${esc(what)}: ${esc(text)}.</p>` : "";
  const broken = roles && roles.problem != null ? roles : null;
  const brokenNote = broken ? `<p class="warn">${esc(`${broken.file ?? "mason/roles.yml"} cannot be read as it is now, so every statement of a user held to it is refused: ${broken.problem}`)}</p>` : "";
  // a Remove's or a Disable's question is a popover beside the user's actions (`pop`), never a row: no row below it moves
  const pops = [];
  const ask = askOf(confirming);
  return why + brokenNote + panel(`<table class="users"><thead><tr><th scope="col">User</th><th scope="col" class="role">Role</th><th scope="col" class="status">Status</th><th scope="col" class="added">Added</th><th scope="col" class="num last">Last used</th><th scope="col" class="act"></th></tr></thead><tbody>${users.map((u) => {
    const active = u.removedAt == null;
    const last = lastUsedText(u, list.lastUsedNote, list.requestLogDays, now);
    const lastCell = !active ? "" : u.lastUsedAt != null
      ? `<span title="${esc(last)}">${esc(duration(Math.max(0, (now - Date.parse(u.lastUsedAt)) / 1000)))} ago</span>` : esc(last);
    const disabled = active && u.disabledAt != null;
    const asking = active && ask?.name === u.name ? ask.verb : null;
    const anchor = actId("users", u.name);
    if (asking === "remove") pops.push(pop(anchor, `<p class="confirm">Remove ${esc(u.name)}? It connects no more, and the sessions it holds end at their next statement.</p>` +
      `<p class="pop-actions">${button(`Remove ${u.name}`, { confirmRemove: u.name }, "danger small")} ${button("Cancel", { cancelRemove: "", popClose: "" }, "small")}</p>`, { kind: "dialog", label: `Remove ${u.name}?` }));
    else if (asking === "disable") pops.push(pop(anchor, `<p class="confirm">Disable ${esc(u.name)}? ${esc(disableEffect(u.name))}</p>` +
      `<p class="pop-actions">${button(`Disable ${u.name}`, { confirmDisable: u.name }, "danger small")} ${button("Cancel", { cancelRemove: "", popClose: "" }, "small")}</p>`, { kind: "dialog", label: `Disable ${u.name}?` }));
    // the form's first input is its choice (a dialog's first box takes the focus): the user it changes is last, hidden
    else if (asking === "from") pops.push(pop(anchor, `<form id="user-from" class="from-form" autocomplete="off">` +
      `<p class="ask-from">Where ${esc(u.name)} connects from, as ${code(`mason user from ${u.name}`)} sets it: the sessions it holds from another address end at their next statement.</p>` +
      connectsChoice("user-from", u.from ?? null) +
      `<p class="pop-actions"><button type="submit" class="primary small">Change ${esc(u.name)}</button> ${button("Cancel", { cancelRemove: "", popClose: "" }, "small")}</p>` +
      `<input type="hidden" name="user" value="${esc(u.name)}"></form>`, { kind: "dialog", label: `Where ${u.name} connects from` }));
    else if (refused?.name === u.name) pops.push(pop(anchor, `${renderFailure(refused.failure)}<p class="pop-actions">${button("Dismiss", { dismissRefused: "", popClose: "" }, "small")}</p>`));
    return `<tr${active ? "" : ` class="removed"`}><th scope="row"><code class="name" title="${esc(u.name)}">${esc(u.name)}</code> <span class="dim">id ${esc(u.id)}</span></th>` +
      // the role it reads as (src/cli/roles.ts userRole): its own (mason user add --role) — one the roles file does not name,
      // said — or the file's default; none under a file with no default reads nothing, said; no roles file, every table
      `<td>${broken ? `<span class="warn">refused: the roles file cannot be read</span>` : u.readsNothing === true ? `<span class="warn">no role, and the roles file names no default: its statements are refused</span>`
        : u.role === undefined ? `<span class="dim">every table</span>`
        : `${code(u.role)}${u.roleFrom === "default" ? ` <span class="dim">(default)</span>` : ""}${u.attributes ? ` <span class="dim">${esc(attributesText(u.attributes))}</span>` : ""}` +
          `${u.roleKnown === false ? ` <span class="warn">not in the roles file: its statements are refused</span>` : ""}` +
          `${u.missingAttributes ? ` <span class="warn">${esc(`no value for ${u.missingAttributes.join(", ")}: its statements are refused`)}</span>` : ""}`}` +
      // where it connects from, a line of its own under what it reads (mason user list's `from …`; none said there: any
      // address), as the user's id is under its name — so a row stays two lines, a Disable moves no row, and the table
      // keeps its width: no column of its own. Cut by the column, its whole the title; where the page may change it, the
      // line is its From…, asked in a popover beside the row's actions
      `${!active ? "" : readOnly !== null ? `<span class="from-line" title="${esc(fromText(u.from))}">${esc(fromText(u.from))}</span>`
        : button(fromText(u.from), asking === "from" ? {} : { from: u.name }, "from-line", { disabled: asking === "from", expanded: asking === "from", title: `${fromText(u.from)}: change where ${u.name} connects from` })}</td>` +
      `<td>${!active ? status("unknown", `Removed ${stamp(u.removedAt)} UTC`) : disabled ? status("warn", disabledText(u.disabledAt)) : status("ok", "Active")}` +
      `${active && !disabled && !u.live ? ` <span class="warn">does not connect: the API key was rotated since it was added</span>` : ""}</td>` +
      `<td class="mono">${esc(stamp(u.addedAt))} UTC</td><td class="num">${lastCell}</td>` +
      // Queries: its statements of the last 24 hours on Observability › Queries (a removed user's too: its past)
      `<td class="act" id="${esc(anchor)}"><a class="btn small" href="${esc(userQueriesHref(u.name))}" title="the statements ${esc(u.name)} sent in the last 24 hours">Queries</a>${!active || readOnly !== null ? "" : ` ${toggle(u, disabled, asking === "disable")} ${asking === "remove" ? button("Remove", {}, "danger small", { disabled: true, expanded: true })
        : button("Remove", { remove: u.name }, "danger small")}`}</td></tr>`;
  }).join("")}</tbody></table>`) + pops.join("") + note("Last used", list.lastUsedNote);
}

/**
 * HOW A TOOL CONNECTS, once for the run (`/api/state` `postgres`: src/cli/pg-url.ts postgresFacts, what `mason status`
 * prints): the host, port, database and sslmode — what a BI tool's form asks for, each with Copy — then the URL and the
 * psql line with `<user>:<password>` as placeholders. None of it is a user's: a row carries what is (its name, its
 * state), and a user's password is copied only from the card shown once when it is added (`renderAdded`). "" when the
 * run did not say.
 */
export function renderUsersConnect(pg, served = false) {
  if (!pg || typeof pg.shown !== "string") return "";
  const rows = [["Host", pg.host, "users-connect-host"], ["Port", String(pg.port), "users-connect-port"], ["Database", pg.database, "users-connect-database"],
    ["SSL mode", pg.sslmode ?? "disable", "users-connect-sslmode"], ["URL", pg.shown, "users-connect-url"], ["psql", pg.psql, "users-connect-psql"]];
  return `<div class="connect"><p class="connect-title">Connect</p>` +
    `<dl class="facts">${rows.map(([k, v, id]) => `<dt>${esc(k)}</dt><dd>${copyable(id, v)}</dd>`).join("")}</dl>` +
    serverHostNote(pg, served) +
    `<p class="tip">A user's name and password go in place of ${code("<user>")} and ${code("<password>")}. The password is shown once, when the user is added: lost, remove the user and add it again.</p></div>`;
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
 * Shown under MASON_UI_READ_ONLY=1 too when its users are the page's own (MASON_UI_READ_ONLY_ALLOW=users).
 */
export function renderAddUser(state) {
  if (state === undefined || state === null || usersReadOnly(state) !== null) return "";
  return `<form id="add-user" class="formcard" autocomplete="off"><label for="user-name">Name</label>` +
    `<input id="user-name" name="name" required placeholder="e.g. metabase" spellcheck="false" autocapitalize="off">` +
    roleChoice(state.roles) + connectsChoice("add-user") + `<button type="submit" class="primary">Add a user</button></form>`;
}

/** The add form's Role choice from `/api/state` `roles`: "" with no roles file, one naming none, or one that cannot be
 *  read now (the roles it names are not known then) */
function roleChoice(r) {
  if (!r || r.file == null || r.problem != null || !Array.isArray(r.roles) || r.roles.length === 0) return "";
  const dflt = r.default != null && r.roles.includes(r.default) ? r.default : null;
  const first = dflt !== null ? `<option value="" selected>${esc(dflt)} (default)</option>` : `<option value="" selected>no role: its statements are refused</option>`;
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

/**
 * A USER JUST ADDED (`mason user add --json`'s shape): a prominent card with its password, shown this once — what is
 * this user's alone, and the URL: URL, User, Password and Database, each with a Copy button laid out the same way, so a
 * person fills a BI tool's form field by field (issue 839). Host, port and SSL mode are the run's, said once by Connect
 * on the same page (renderUsersConnect), so the card points there in a line instead of repeating them — named, never
 * "above" or "below", since where Connect sits may move; `mason user add` in a terminal, with no Connect beside it,
 * prints them all. No psql line: the URL is the same thing, pasted after `psql`. A field the JSON does not carry (the
 * URL and host while Mason does not run) is not shown, nor the line about Connect. Mason keeps no copy, so it is never
 * shown again. Then where its statements will show: the Queries page.
 */
export function renderAdded(a) {
  const rows = [["URL", a.url, "added-url"], ["User", a.user, "added-user"], ["Password", a.password, "added-password"], ["Database", a.database, "added-database"]]
    .filter(([, v]) => v !== undefined && v !== null);
  return `<div class="added" role="status"><p class="headline">The user ${esc(a.user)} added: its password is shown this once ${badge("Shown once", "warn")}</p>` +
    `<dl class="facts">${rows.map(([k, v, id]) => `<dt>${esc(k)}</dt><dd>${copyable(id, v)}</dd>`).join("")}</dl>` +
    (a.host !== undefined && a.host !== null ? `<p class="tip">Host, port and SSL mode: see Connect on this page.</p>` : "") +
    `<p class="tip">Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again. Lost, remove the user and add it again.</p>` +
    `<p class="tip">Connect your tool: each statement it sends shows on <a href="#observability/queries">Observability › Queries</a>.</p>` +
    `${button("I have copied it", { dismissAdded: "" }, "primary")}</div>`;
}

export const page = {
  id: "users",
  title: "Users",
  create(ctx) {
    // held: what From… opened over ({ list, now, state }), so a poll never rewrites its form under what is being typed
    const m = { actionFailure: null, added: null, confirming: null, refused: null, held: null };
    const users = () => ctx.read(USERS)?.body ?? null;
    const actions = {
      /** `role`: the Role choice's, sent as mason user add --role; "" or none: no role, as with no --role. `from`: the
       *  ranges, as mason user add --from; null or none: none sent, from anywhere */
      async addUser(name, role = "", from = null) {
        m.actionFailure = null;
        const r = await ctx.ask(USERS_POST, json("POST", { name, ...(role ? { role } : {}), ...(from !== null ? { from } : {}) }));
        if ("failure" in r) { m.actionFailure = r.failure; return false; }
        m.added = r.body;
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
      dismissAdded() { m.added = null; },
      dismissRefused() { m.refused = null; },
    };
    return {
      model: m,
      // the users first (their read's failure is the page's banner), and the state for the Connect panel
      reads: () => [{ path: USERS, everyMs: USERS_EVERY_MS }, { path: STATE, everyMs: USERS_EVERY_MS }],
      afterRead() {
        const u = users();
        // the user asked about went (removed), or is disabled already (by mason user disable): the question goes
        const ask = askOf(m.confirming);
        if (ask !== null && u !== null && !u.users.some((x) => x.name === ask.name && x.removedAt == null && (ask.verb !== "disable" || x.disabledAt == null))) { m.confirming = null; m.held = null; }
      },
      actions,
      view() {
        // while From… asks, the list as it opened (`held`): its form is never rewritten under what is being typed
        const h = m.held !== null && askOf(m.confirming)?.verb === "from" ? m.held : null;
        const u = h !== null ? h.list : users();
        const state = h !== null ? h.state : ctx.read(STATE)?.body ?? null;
        return {
          // the roles file's state is the run's (/api/state roles): a file that cannot be read refuses every user held to it
          users: u ? renderUsers(u, m.confirming, h !== null ? h.now : ctx.now().getTime(), m.refused, state?.roles ?? null, usersReadOnly(state)) : "",
          "add-user-box": renderAddUser(ctx.read(STATE)?.body),
          "users-connect": renderUsersConnect(ctx.read(STATE)?.body?.postgres, ctx.read(STATE)?.body?.served === true),
          added: m.added ? renderAdded(m.added) : "",
          action: m.actionFailure ? renderFailure(m.actionFailure) : "",
        };
      },
      submit(form) {
        if (form.id === "user-from") return actions.changeFrom(form.elements.user.value, rangesOf(form.elements));
        if (form.id !== "add-user") return null;
        const input = form.elements.name;
        return actions.addUser(input.value.trim(), form.elements.role?.value ?? "", rangesOf(form.elements)).then((ok) => { if (ok) input.value = ""; });
      },
      click(d, button, { doc, win }) {
        if (d.remove !== undefined) return actions.askRemove(d.remove) ?? true;
        if (d.cancelRemove !== undefined) return actions.cancelRemove() ?? true;
        if (d.confirmRemove !== undefined) return actions.confirmRemove(d.confirmRemove);
        if (d.disable !== undefined) return actions.askDisable(d.disable) ?? true;
        if (d.confirmDisable !== undefined) return actions.confirmDisable(d.confirmDisable);
        if (d.from !== undefined) return actions.askFrom(d.from) ?? true;
        if (d.enable !== undefined) return actions.enableUser(d.enable);
        if (d.dismissAdded !== undefined) return actions.dismissAdded() ?? true;
        if (d.dismissRefused !== undefined) return actions.dismissRefused() ?? true;
        return copyClick(d, button, { doc, win });
      },
      /** Escape with no question open: a refusal beside a user goes, as its Dismiss does (null: none is shown) */
      dismiss() { if (m.refused === null) return null; actions.dismissRefused(); return true; },
    };
  },
};
