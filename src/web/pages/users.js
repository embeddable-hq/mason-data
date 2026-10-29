/**
 * THE USERS PAGE (#users): what `mason user list|add|remove` does — GET /api/users, POST /api/users, DELETE
 * /api/users/<name>. An added user's password lives in this page's memory until the person dismisses it, never in
 * storage, a URL or a log line.
 */
import { badge, button, code, copyable, copyClick, duration, empty, esc, json, panel, renderFailure, status, utcMinute } from "../shared.js";

/** The users as the page reads them: with each one's last use (`mason user list` asks the same), then every 30 s. */
const USERS = "/api/users?lastUsed=1";
const USERS_POST = "/api/users";
const USERS_EVERY_MS = 30_000;

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

/**
 * THE USERS from `/api/users?lastUsed=1` (`mason user list --json`'s shape), in a table in a card: a row each — its name
 * in mono with its id muted, its status as a dot and the word (Active, or Removed and when), when it was added, when it
 * was last used (an age, `lastUsedText`'s UTC time in a title; or the note why it is not known), its URL without the
 * password (Copy), and Remove. The active ones first; a removed user is listed after them, muted, without Remove. The
 * one being removed asks first (`confirming`, its name). `now` is the page's clock, in ms.
 */
export function renderUsers(list, confirming = null, now = Date.now()) {
  const users = [...list.users.filter((u) => u.removedAt == null), ...list.users.filter((u) => u.removedAt != null)];
  if (!users.length) return empty("No users yet", `A user is the name and password psql, a BI tool or your app connects with. Add one above, as ${code("mason user add <name>")} does: its URL, password included, is shown once.`);
  const note = (what, text) => text ? `<p class="dim">${esc(what)}: ${esc(text)}.</p>` : "";
  return panel(`<table class="users"><thead><tr><th scope="col">User</th><th scope="col">Status</th><th scope="col">Added</th><th scope="col" class="num">Last used</th><th scope="col">URL</th><th scope="col"></th></tr></thead><tbody>${users.map((u) => {
    const active = u.removedAt == null;
    const last = lastUsedText(u, list.lastUsedNote, list.requestLogDays, now);
    const lastCell = !active ? "" : u.lastUsedAt != null
      ? `<span title="${esc(last)}">${esc(duration(Math.max(0, (now - Date.parse(u.lastUsedAt)) / 1000)))} ago</span>` : esc(last);
    // a Remove's question is a row of its own under the user's, across every column: the row keeps its width
    const asking = active && confirming === u.name;
    const ask = asking ? `<tr class="under asking"><td colspan="6"><div class="under-body"><span class="confirm">Remove ${esc(u.name)}? It connects no more, and the sessions it holds end at their next statement.</span> ` +
      `${button(`Remove ${u.name}`, { confirmRemove: u.name }, "danger small")} ${button("Cancel", { cancelRemove: "" }, "small")}</div></td></tr>` : "";
    return `<tr${active ? "" : ` class="removed"`}><th scope="row"><code class="name" title="${esc(u.name)}">${esc(u.name)}</code> <span class="dim">id ${esc(u.id)}</span></th>` +
      `<td>${active ? status("ok", "Active") : status("unknown", `Removed ${stamp(u.removedAt)} UTC`)}${active && !u.live ? ` <span class="warn">does not connect: the API key was rotated since it was added</span>` : ""}</td>` +
      `<td class="mono">${esc(stamp(u.addedAt))} UTC</td><td class="num">${lastCell}</td>` +
      `<td>${active && u.url ? copyable(`user-url-${u.name}`, u.url, { clip: true }) : ""}</td>` +
      `<td class="act">${!active ? "" : asking ? `<button type="button" class="danger small" aria-expanded="true" disabled>Remove</button>`
        : button("Remove", { remove: u.name }, "danger small")}</td></tr>${ask}`;
  }).join("")}</tbody></table>`) + `${note("Last used", list.lastUsedNote)}${note("URL", list.urlNote)}`;
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
    const m = { actionFailure: null, added: null, confirming: null };
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
      askRemove(name) { m.confirming = name; m.actionFailure = null; },
      cancelRemove() { m.confirming = null; },
      async confirmRemove(name) {
        m.actionFailure = null;
        const r = await ctx.ask(`/api/users/${encodeURIComponent(name)}`, json("DELETE"));
        m.confirming = null;
        if ("failure" in r) { m.actionFailure = r.failure; return false; }
        await ctx.refresh([USERS]);
        return true;
      },
      dismissAdded() { m.added = null; },
    };
    return {
      model: m,
      reads: () => [{ path: USERS, everyMs: USERS_EVERY_MS }],
      afterRead() {
        const u = users();
        if (m.confirming !== null && u !== null && !u.users.some((x) => x.name === m.confirming && x.removedAt == null)) m.confirming = null;
      },
      actions,
      view() {
        const u = users();
        return {
          users: u ? renderUsers(u, m.confirming, ctx.now().getTime()) : "",
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
        if (d.dismissAdded !== undefined) return actions.dismissAdded() ?? true;
        return copyClick(d, button, { doc, win });
      },
    };
  },
};
