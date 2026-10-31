/**
 * THE USERS PAGE (#users): what `mason user list|add|disable|enable|remove` does — GET /api/users, POST /api/users,
 * POST /api/users/<name>/disable and /enable, DELETE /api/users/<name>. An added user's password lives in this page's memory until the person dismisses it, never in
 * storage, a URL or a log line.
 */
import { actId, badge, button, code, copyable, copyClick, duration, empty, esc, json, panel, pop, renderFailure, ROOMS, serverHostNote, status, utcMinute } from "../shared.js";

/** The users as the page reads them: with each one's last use (`mason user list` asks the same), then every 30 s. */
const USERS = "/api/users?lastUsed=1";
const USERS_POST = "/api/users";
const USERS_EVERY_MS = 30_000;
/** The run's state: where a tool connects (`postgres`, src/cli/pg-url.ts postgresFacts), the Connect panel's; and the
 *  roles file's state (`roles`, src/cli/run-server.ts rolesState), what each user's role is held to. */
const STATE = "/api/state";

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
 */
export function renderUsers(list, confirming = null, now = Date.now(), refused = null, roles = null) {
  const users = [...list.users.filter((u) => u.removedAt == null), ...list.users.filter((u) => u.removedAt != null)];
  if (!users.length) return empty("No users yet", `A user is the name and password psql, a BI tool or your app connects with. Add one above, as ${code("mason user add <name>")} does: its URL, password included, is shown once.`);
  const note = (what, text) => text ? `<p class="dim">${esc(what)}: ${esc(text)}.</p>` : "";
  const broken = roles && roles.problem != null ? roles : null;
  const brokenNote = broken ? `<p class="warn">${esc(`${broken.file ?? "mason/roles.yml"} cannot be read as it is now, so every statement of a user held to it is refused: ${broken.problem}`)}</p>` : "";
  // a Remove's or a Disable's question is a popover beside the user's actions (`pop`), never a row: no row below it moves
  const pops = [];
  const ask = askOf(confirming);
  return brokenNote + panel(`<table class="users"><thead><tr><th scope="col">User</th><th scope="col" class="role">Role</th><th scope="col" class="status">Status</th><th scope="col" class="added">Added</th><th scope="col" class="num last">Last used</th><th scope="col" class="act"></th></tr></thead><tbody>${users.map((u) => {
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
    else if (refused?.name === u.name) pops.push(pop(anchor, `${renderFailure(refused.failure)}<p class="pop-actions">${button("Dismiss", { dismissRefused: "", popClose: "" }, "small")}</p>`));
    return `<tr${active ? "" : ` class="removed"`}><th scope="row"><code class="name" title="${esc(u.name)}">${esc(u.name)}</code> <span class="dim">id ${esc(u.id)}</span></th>` +
      // the role it reads as (src/cli/roles.ts userRole): its own (mason user add --role) — one the roles file does not name,
      // said — or the file's default; none under a file with no default reads nothing, said; no roles file, every table
      `<td>${broken ? `<span class="warn">refused: the roles file cannot be read</span>` : u.readsNothing === true ? `<span class="warn">no role, and the roles file names no default: its statements are refused</span>`
        : u.role === undefined ? `<span class="dim">every table</span>`
        : `${code(u.role)}${u.roleFrom === "default" ? ` <span class="dim">(default)</span>` : ""}${u.attributes ? ` <span class="dim">${esc(attributesText(u.attributes))}</span>` : ""}` +
          `${u.roleKnown === false ? ` <span class="warn">not in the roles file: its statements are refused</span>` : ""}` +
          `${u.missingAttributes ? ` <span class="warn">${esc(`no value for ${u.missingAttributes.join(", ")}: its statements are refused`)}</span>` : ""}`}</td>` +
      `<td>${!active ? status("unknown", `Removed ${stamp(u.removedAt)} UTC`) : disabled ? status("warn", disabledText(u.disabledAt)) : status("ok", "Active")}` +
      `${active && !disabled && !u.live ? ` <span class="warn">does not connect: the API key was rotated since it was added</span>` : ""}</td>` +
      `<td class="mono">${esc(stamp(u.addedAt))} UTC</td><td class="num">${lastCell}</td>` +
      // Queries: its statements of the last 24 hours on Observability › Queries (a removed user's too: its past)
      `<td class="act" id="${esc(anchor)}"><a class="btn small" href="${esc(userQueriesHref(u.name))}" title="the statements ${esc(u.name)} sent in the last 24 hours">Queries</a>${!active ? "" : ` ${toggle(u, disabled, asking === "disable")} ${asking === "remove" ? button("Remove", {}, "danger small", { disabled: true, expanded: true })
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
    (served ? `<p class="tip">${serverHostNote(pg)}</p>` : "") +
    `<p class="tip">A user's name and password go in place of ${code("<user>")} and ${code("<password>")}. The password is shown once, when the user is added: lost, remove the user and add it again.</p></div>`;
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
 * A USER JUST ADDED (`mason user add --json`'s shape): a prominent card with its password, shown this once, beside the
 * URL to paste and its psql line, each with a Copy button — the rows `mason user add` prints, their labels capitalised.
 * Mason keeps no copy, so it is never shown again. Then where its statements will show: the Queries page.
 */
export function renderAdded(a) {
  const rows = [["URL", a.url, "added-url"], ["psql", a.psql, "added-psql"], ["User", a.user], ["Password", a.password, "added-password"], ["Database", a.database],
    ...(a.host !== undefined ? [["Host", a.host], ["Port", String(a.port)]] : []), ...(a.sslmode && a.sslmode !== "disable" ? [["SSL mode", a.sslmode]] : [])]
    .filter(([, v]) => v !== undefined);
  return `<div class="added" role="status"><p class="headline">The user ${esc(a.user)} added: its password is shown this once ${badge("Shown once", "warn")}</p>` +
    `<dl class="facts">${rows.map(([k, v, id]) => `<dt>${esc(k)}</dt><dd>${id ? copyable(id, v) : esc(v)}</dd>`).join("")}</dl>` +
    `<p class="tip">Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again. Lost, remove the user and add it again.</p>` +
    `<p class="tip">${a.psql ? "Run the psql line, or connect your tool: " : ""}each statement it sends shows on <a href="#observability/queries">Observability › Queries</a>.</p>` +
    `${button("I have copied it", { dismissAdded: "" }, "primary")}</div>`;
}

export const page = {
  id: "users",
  title: "Users",
  create(ctx) {
    const m = { actionFailure: null, added: null, confirming: null, refused: null };
    const users = () => ctx.read(USERS)?.body ?? null;
    const actions = {
      async addUser(name) {
        m.actionFailure = null;
        const r = await ctx.ask(USERS_POST, json("POST", { name }));
        if ("failure" in r) { m.actionFailure = r.failure; return false; }
        m.added = r.body;
        await ctx.refresh([USERS]);
        return true;
      },
      askRemove(name) { m.confirming = name; m.actionFailure = null; m.refused = null; },
      askDisable(name) { m.confirming = { name, verb: "disable" }; m.actionFailure = null; m.refused = null; },
      cancelRemove() { m.confirming = null; },
      /** Disable once asked, Enable at once: POST /api/users/<name>/disable|enable (mason user's own functions); a
       *  refusal is said beside the user's actions, as a Remove's is */
      async toggleUser(name, verb) {
        m.actionFailure = null;
        m.refused = null;
        const r = await ctx.ask(`/api/users/${encodeURIComponent(name)}/${verb}`, json("POST"));
        m.confirming = null;
        if ("failure" in r) { m.refused = { name, failure: r.failure }; return false; }
        await ctx.refresh([USERS]);
        return true;
      },
      confirmDisable(name) { return actions.toggleUser(name, "disable"); },
      enableUser(name) { return actions.toggleUser(name, "enable"); },
      async confirmRemove(name) {
        m.actionFailure = null;
        const r = await ctx.ask(`/api/users/${encodeURIComponent(name)}`, json("DELETE"));
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
        if (ask !== null && u !== null && !u.users.some((x) => x.name === ask.name && x.removedAt == null && (ask.verb !== "disable" || x.disabledAt == null))) m.confirming = null;
      },
      actions,
      view() {
        const u = users();
        return {
          // the roles file's state is the run's (/api/state roles): a file that cannot be read refuses every user held to it
          users: u ? renderUsers(u, m.confirming, ctx.now().getTime(), m.refused, ctx.read(STATE)?.body?.roles ?? null) : "",
          "users-connect": renderUsersConnect(ctx.read(STATE)?.body?.postgres, ctx.read(STATE)?.body?.served === true),
          added: m.added ? renderAdded(m.added) : "",
          action: m.actionFailure ? renderFailure(m.actionFailure) : "",
        };
      },
      submit(form) {
        if (form.id !== "add-user") return null;
        const input = form.elements.name;
        return actions.addUser(input.value.trim()).then((ok) => { if (ok) input.value = ""; });
      },
      click(d, button, { doc, win }) {
        if (d.remove !== undefined) return actions.askRemove(d.remove) ?? true;
        if (d.cancelRemove !== undefined) return actions.cancelRemove() ?? true;
        if (d.confirmRemove !== undefined) return actions.confirmRemove(d.confirmRemove);
        if (d.disable !== undefined) return actions.askDisable(d.disable) ?? true;
        if (d.confirmDisable !== undefined) return actions.confirmDisable(d.confirmDisable);
        if (d.enable !== undefined) return actions.enableUser(d.enable);
        if (d.dismissAdded !== undefined) return actions.dismissAdded() ?? true;
        if (d.dismissRefused !== undefined) return actions.dismissRefused() ?? true;
        return copyClick(d, button, { doc, win });
      },
    };
  },
};
