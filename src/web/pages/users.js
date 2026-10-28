/**
 * THE USERS PAGE (#users): what `mason user list|add|remove` does — GET /api/users, POST /api/users, DELETE
 * /api/users/<name>. An added user's password lives in this page's memory until the person dismisses it, never in
 * storage, a URL or a log line.
 */
import { code, esc, json, renderFailure } from "../shared.js";

/** The users as the page reads them: with each one's last use (`mason user list` asks the same), then every 30 s. */
const USERS = "/api/users?lastUsed=1";
const USERS_POST = "/api/users";
const USERS_EVERY_MS = 30_000;

/** A time as `mason user list` stamps it: `2026-10-27 09:10`, UTC. */
const stamp = (iso) => iso.slice(0, 16).replace("T", " ");

/** When a user was last used, as `mason user list` says it: the time, or why not (unknown, or not within the log's days). */
export function lastUsedText(u, lastUsedNote, requestLogDays) {
  return u.lastUsedAt != null ? `${stamp(u.lastUsedAt)} UTC` : lastUsedNote != null ? "unknown" : `not used in the last ${requestLogDays ?? "?"} days`;
}

/**
 * THE USERS from `/api/users?lastUsed=1` (`mason user list --json`'s shape): a row each — its name, Active or Removed,
 * when it was added, when it was last used, its URL without the password (Copy), and Remove. The active ones first;
 * a removed user is listed after them, without Remove. The one being removed asks first (`confirming`, its name).
 */
export function renderUsers(list, confirming = null) {
  const users = [...list.users.filter((u) => u.removedAt == null), ...list.users.filter((u) => u.removedAt != null)];
  if (!users.length) return `<p class="dim">No users yet.</p>`;
  const note = (what, text) => text ? `<p class="dim">${esc(what)}: ${esc(text)}.</p>` : "";
  return `<div class="scroll"><table class="users"><thead><tr><th scope="col">User</th><th scope="col">Status</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col">URL</th><th scope="col"></th></tr></thead><tbody>${users.map((u) => {
    const active = u.removedAt == null;
    return `<tr><th scope="row">${code(u.name)} <span class="dim">id ${esc(u.id)}</span></th>` +
      `<td>${active ? "Active" : `Removed ${esc(stamp(u.removedAt))} UTC`}${active && !u.live ? ` <span class="warn">does not connect: the API key was rotated since it was added</span>` : ""}</td>` +
      `<td>${esc(stamp(u.addedAt))} UTC</td><td>${active ? esc(lastUsedText(u, list.lastUsedNote, list.requestLogDays)) : ""}</td>` +
      `<td>${active && u.url ? `<code id="user-url-${esc(u.name)}">${esc(u.url)}</code> <button type="button" data-copy="user-url-${esc(u.name)}">Copy</button>` : ""}</td>` +
      `<td class="act">${!active ? "" : confirming === u.name
        ? `<span class="confirm">Remove ${esc(u.name)}? It connects no more, and the sessions it holds end at their next statement.</span> ` +
          `<button type="button" class="danger" data-confirm-remove="${esc(u.name)}">Remove ${esc(u.name)}</button> <button type="button" data-cancel-remove>Cancel</button>`
        : `<button type="button" data-remove="${esc(u.name)}">Remove</button>`}</td></tr>`;
  }).join("")}</tbody></table></div>${note("Last used", list.lastUsedNote)}${note("URL", list.urlNote)}`;
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
          users: u ? renderUsers(u, m.confirming) : "",
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
        if (d.copy !== undefined) {
          const text = doc.getElementById(d.copy)?.textContent ?? "";
          return Promise.resolve().then(() => win.navigator.clipboard.writeText(text)).then(() => { button.textContent = "Copied"; }, (err) => {
            // the clipboard refused (a browser setting): the text is selected, for the reader's own copy
            win.getSelection()?.selectAllChildren(doc.getElementById(d.copy));
            button.textContent = `Select and copy it (${err?.message ?? err})`;
          });
        }
        return null;
      },
    };
  },
};
