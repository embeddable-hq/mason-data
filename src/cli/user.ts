/**
 * `mason user add | list | disable | enable | remove` — NAMED, REVOCABLE LOGINS FOR THE POSTGRES API, WITH NO EXPIRY
 * (docs/DESIGN.md "On a server", item 1 of the agreed plan; src/duck/users.ts holds the rules). A BI
 * tool's datasource stores ONE password: a user's lasts until it is removed.
 *
 * It runs as a second process beside the run (or beside `mason serve`: `docker compose exec mason mason user add
 * metabase`, the data folder's `.mason/`), so it needs the project, never the run: it edits `.mason/users.json` under
 * the file's lock, and the run's listener reads the change at its next connection or statement. The password is said
 * ONCE, by `add`, with the URL to paste (one URL builder, pg-url.ts `connectionUrl`) when the run is up and recorded
 * where it listens. The web page's users (`mason ui`) are the same functions (`addUser`, `listUsers`, `removeUser`),
 * called by the run's command server; so are `disableUser` and `enableUser`.
 */
import * as path from "node:path";
import { failed, jsonText, parseCommand, reportText, withEnd, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { reach } from "./state.ts";
import { callRun, RunUnreachable } from "./control.ts";
import { connectionUrl, listenerTips, postgresLink, psqlLine, type PostgresLink } from "./pg-url.ts";
import { changeUsers, isActive, isDisabled, keyFingerprint, newUserId, readUsers, underKey, userPassword, USER_NAME_RE, USER_NAME_RULE, USERS_FILE, type MasonUser } from "../duck/users.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { out as styleOut } from "./style.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

export const USER: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "user",
  summary: "the users the Postgres API takes: a name and a password that does not expire, for a BI tool or an app",
  usage: `usage: mason user add <name> [--json]
       mason user list [--json]
       mason user disable <name> [--json]
       mason user enable <name> [--json]
       mason user remove <name> [--json]

  A user of this project's Postgres API: a name and a password, as a BI tool's datasource form asks for them
  (Metabase, Grafana, Superset, Power BI) or an app's DATABASE_URL carries them. Its password does not expire:
  it connects until mason user remove, which refuses its next connection at once and
  ends the sessions it holds at their next statement, without a restart. The password is printed once, by add.
  The user name a tool sends must be the user's own. A user disabled is kept with its password: its logins are
  refused (as Postgres refuses a role without LOGIN) and its sessions end at their next statement, until enable.

  The list is .mason/users.json (names and ids, no password), beside the running Mason, which reads it again by itself.
  A removed user stays in it, marked removed, so the list shows who was removed and when; its name can be added again.
  Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.

    mason user add metabase                    a user for Metabase: its password and the URL to paste
    mason user list
    mason user disable metabase                metabase connects no more, until mason user enable metabase
    mason user enable metabase                 metabase connects again, with the same password
    mason user remove metabase                 metabase connects no more
    docker compose exec mason mason user add grafana   beside mason serve, in its data folder

  <name>    ${USER_NAME_RULE}
  --json    as data: add { user (the name), id, addedAt, password, database, and once Mason runs url, psql (the
            psql line for url), host, port, sslmode }; list { users: [{ name, id, addedAt, removedAt (null for a user not removed), disabledAt (null for
            a user not disabled), live (connects now),
            lastUsedAt (its newest statement, null when none within requestLogDays), url (to paste, without the password;
            null for a removed user or when Mason is not running) }], lastUsedNote (why lastUsedAt is unknown, else null),
            urlNote (why url is null, else null), requestLogDays (null when unknown) }; disable { disabled: { name, id, addedAt,
            disabledAt }, already (it was disabled before) }; enable { enabled: { name, id, addedAt }, already (it
            was not disabled) }; remove { removed: { name, id, addedAt, removedAt } }; next
`,
  options: { json: { type: "boolean", default: false } },
  json: ["user", "id", "addedAt", "password", "url", "psql", "host", "port", "database", "sslmode", "users", "disabled", "enabled", "already", "removed", "lastUsedNote", "urlNote", "requestLogDays", "next"],
};


/** The users of a project and why one is not live: added under an API key since rotated. */
const liveOf = (u: MasonUser, apiKey: string): boolean => underKey(u, apiKey);

// ------------------------------------------------------------------ what add, list and remove do
// ONE implementation, for `mason user` and for the run's command server (src/cli/run-server.ts `/api/users`, the web
// page's users): the same file, under the same lock, refused in the same sentences, so the two cannot disagree.

/**
 * A user as `mason user list --json` lists it. `live`: it connects now (not removed, and added under the API key in use).
 * `lastUsedAt`: its newest statement in the request log, filled by `withLastUsed` (null until then, and when the log has
 * none). `url`: the URL a tool pastes, WITHOUT the password, from the one builder `mason user add` uses; null for a
 * removed user and where the listener's address is not known.
 */
export interface UserRow { name: string; id: string; addedAt: string; removedAt: string | null; disabledAt: string | null; live: boolean; lastUsedAt: string | null; url: string | null }

export const NOT_RUNNING_LAST_USED = "unknown: Mason is not running, and the request log is only read by a running Mason (mason start)";
export const NOT_RUNNING_URL = "unknown: Mason is not running, so where its Postgres API listens is not known (mason start, then mason status)";

/** A time as `mason user list` stamps it: `2026-10-27 09:10`, UTC. */
const stamp = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/**
 * WHEN A USER WAS LAST USED, as `mason user list` and the web page's Users page (src/web/pages/users.js, held equal by
 * tests/web-page.test.ts) say it: its time, "unknown" when the note says why it cannot be known, "never" when it was
 * added within the days the request log keeps (so the log holds its whole life: a user just added was "not used in the
 * last 7 days", which reads as if it once was), else not used within those days. `now` is the clock, in ms.
 */
export function lastUsedText(lastUsedAt: string | null, lastUsedNote: string | null, requestLogDays: number | null, addedAt: string | null = null, now: number = Date.now()): string {
  if (lastUsedAt !== null) return `${stamp(lastUsedAt)} UTC`;
  if (lastUsedNote !== null) return "unknown";
  if (requestLogDays !== null && addedAt !== null && now - Date.parse(addedAt) < requestLogDays * 86_400_000) return "never";
  return `not used in the last ${requestLogDays ?? "?"} days`;
}

/** A user just added, in `mason user add --json`'s shape (`replaced`: in place of one the API key's rotation had removed). */
export interface AddedUser {
  user: string; id: string; addedAt: string; password: string; database: string;
  url?: string; psql?: string; host?: string; port?: number; sslmode?: string;
  replaced: boolean;
}

/** What to run after an add: with Mason up, the list and how to end it; with Mason stopped, mason start first. */
export const addedNext = (name: string, up: boolean): NextStep[] => up
  ? [["mason user list", "the users"], [`mason user remove ${name}`, "it connects no more"]]
  : [["mason start", "start Mason: then mason status prints where the Postgres API listens"], ["mason user list", "the users"]];
/** What to run after a remove. */
export const REMOVED_NEXT: readonly NextStep[] = [["mason user list", "the users, removed ones included"], ["mason user add <name>", "a new user, with a new password"]];

/** What to run after a disable, and after an enable. */
export const disabledNext = (name: string): NextStep[] => [[`mason user enable ${name}`, "it connects again, with the same password"], ["mason user list", "the users"]];
export const enabledNext = (name: string): NextStep[] => [["mason user list", "the users"], [`mason user disable ${name}`, "it connects no more, until enabled"]];

/**
 * WHAT A DISABLE DOES, in the words `mason user disable` prints and the web page's Disable asks with (src/web/pages/users.js
 * `disableEffect`, held equal by tests/web-page.test.ts).
 */
export const disableEffect = (name: string): string =>
  `It connects no more until mason user enable ${name}, with the same password, and the sessions it holds end at their next statement.`;

/** A disabled user's state, as `mason user list` and the web page's Users page say it (held equal by the tests). */
export const disabledText = (disabledAt: string): string => `Disabled ${stamp(disabledAt)} UTC`;

/** Why `name` is not one `mason user <verb>` takes (a usage failure), or null. */
export function userNameProblem(verb: "add" | "remove" | "disable" | "enable", name: string | undefined): string | null {
  if (name === undefined) return `mason user ${verb} <name>: which user`;
  if (!USER_NAME_RE.test(name)) return `${JSON.stringify(name)} is not a user name: ${USER_NAME_RULE}`;
  return null;
}

const cantChange = (file: string, e: unknown): Failure => ({ message: `the list of users could not be changed: ${(e as Error).message}`, code: "failed",
  fix: `${file} is the list (mason user writes it): repair it, or move it aside, which removes every user` });

/**
 * The users `file` lists, removed ones too, each with whether it connects under `apiKey` and — `link`, where the run's
 * Postgres API listens, when it is known — the URL to paste without the password; or why the file cannot be read.
 * `lastUsedAt` is null here: `withLastUsed` fills it from the request log, which only the run has.
 */
export function listUsers(file: string, apiKey: string, link: PostgresLink | null): { users: UserRow[] } | Failure {
  const r = readUsers(file);
  if ("problem" in r) return { message: `the list of users cannot be read: ${r.problem}`, code: "bad_config", why: "no user connects while it cannot be read",
    fix: `repair ${file}, or move it aside, which removes every user` };
  return { users: r.users.map((u) => ({ name: u.name, id: u.id, addedAt: u.addedAt, removedAt: u.removedAt ?? null, disabledAt: u.disabledAt ?? null,
    live: isActive(u) && !isDisabled(u) && liveOf(u, apiKey),
    lastUsedAt: null, url: link !== null && isActive(u) ? connectionUrl(link, u.name, null) : null })) };
}

/**
 * The rows with their last use from the request log (`lastUsed`, src/duck/requests.ts: within the log's retention, in
 * the window each user was a user in, so a name added again is not credited with the earlier user's statements).
 * A log that cannot be read is SAID in the note, never a guess.
 */
export async function withLastUsed(rows: readonly UserRow[], requests: { lastUsed: (u: Array<{ name: string; since: string; until: string | null }>) => Promise<Array<string | null>>; days: number },
  log: (m: string) => void): Promise<{ users: UserRow[]; lastUsedNote: string | null; requestLogDays: number | null }> {
  try {
    const used = await requests.lastUsed(rows.map((u) => ({ name: u.name, since: u.addedAt, until: u.removedAt })));
    return { users: rows.map((u, i) => ({ ...u, lastUsedAt: used[i] ?? null })), lastUsedNote: null, requestLogDays: requests.days };
  } catch (e) {
    log(`mason user list: the request log could not be read for the users' last use: ${(e as Error).message}`);
    return { users: [...rows], lastUsedNote: `unknown: the request log could not be read (${(e as Error).message})`, requestLogDays: requests.days };
  }
}

/**
 * ADD A USER to `file` under its lock: a new id, its password (said here, once, and kept nowhere), and — `link`, where
 * the run's Postgres API listens, when it is up — the URL to paste. A name taken by a live user is refused.
 */
export function addUser(file: string, apiKey: string, name: string, o: { link: PostgresLink | null; database: string }): AddedUser | Failure {
  const usage = userNameProblem("add", name);
  if (usage !== null) return { message: usage, code: "usage" };
  const fingerprint = keyFingerprint(apiKey);
  let added: MasonUser | undefined;
  let replaced = false;
  let r;
  try {
    r = changeUsers(file, (users) => {
      // a removed user's name is free; so is a live one's added under a key since rotated (it connects no more), said
      const was = users.find((u) => u.name === name && isActive(u));
      if (was !== undefined && was.key === fingerprint) return { refused: "taken" };
      replaced = was !== undefined;
      const now = new Date().toISOString();
      added = { name, id: newUserId(), addedAt: now, key: fingerprint };
      return [...users.map((u) => u === was ? { ...u, removedAt: now } : u), added];
    });
  } catch (e) { return cantChange(file, e); }
  if (!Array.isArray(r)) {
    return { message: `there is already a user ${JSON.stringify(name)}`, code: "refused",
      why: "a name names one user, so removing it means one thing; its password is not kept, so it cannot be printed again",
      fix: `mason user remove ${name}, then mason user add ${name} (a new password; the old one stops connecting), or add another name (${name}-2) and remove ${name} once the tool uses it`,
      next: [["mason user list", "the users"], [`mason user remove ${name}`, "then add it again, with a new password"]] };
  }
  const u = added!;
  const password = userPassword(apiKey, u.name, u.id);
  const { link } = o;
  return { user: u.name, id: u.id, addedAt: u.addedAt, password, database: link?.database ?? o.database,
    ...(link !== null ? { url: connectionUrl(link, u.name, password), psql: psqlLine(connectionUrl(link, u.name, password)), host: link.host, port: link.port, sslmode: link.sslmode ?? "disable" } : {}), replaced };
}

/** REMOVE A USER from `file` under its lock: it connects no more. A name the file lacks is refused with the closest it has. */
export function removeUser(file: string, name: string): { removed: { name: string; id: string; addedAt: string; removedAt: string } } | Failure {
  const usage = userNameProblem("remove", name);
  if (usage !== null) return { message: usage, code: "usage" };
  let removed: MasonUser | undefined;
  let removedAt = "";
  let live: string[] = [];
  let r;
  try {
    r = changeUsers(file, (users) => {
      removed = users.find((u) => u.name === name && isActive(u));
      live = users.filter(isActive).map((u) => u.name);
      // the entry stays, marked: the list shows who was removed and when; the listener reads only the live ones
      removedAt = new Date().toISOString();
      return removed === undefined ? { refused: "unknown" } : users.map((u) => u === removed ? { ...u, removedAt } : u);
    });
  } catch (e) { return cantChange(file, e); }
  if (!Array.isArray(r)) return noSuchUser(name, live);
  const gone = removed!;
  return { removed: { name: gone.name, id: gone.id, addedAt: gone.addedAt, removedAt } };
}

/** No user `name` among those not removed: the closest name they have, and who they are. */
const noSuchUser = (name: string, live: string[]): Failure => ({ message: `there is no user ${JSON.stringify(name)}${didYouMean(name, live)}`, code: "not_found",
  why: live.length ? `the users: ${live.join(", ")}` : "this project has no users", next: [["mason user list", "the users"]] });

/**
 * DISABLE A USER in `file` under its lock: kept, its id (so its password) unchanged, marked `disabledAt`; the listener
 * refuses its logins and ends its sessions at their next statement. One already disabled is said so (`already`), its
 * first time kept, nothing written: a no-op is no failure (as `mason add` of a table already added).
 */
export function disableUser(file: string, name: string): { disabled: { name: string; id: string; addedAt: string; disabledAt: string }; already: boolean } | Failure {
  const usage = userNameProblem("disable", name);
  if (usage !== null) return { message: usage, code: "usage" };
  let found: MasonUser | undefined;
  let disabledAt = "";
  let live: string[] = [];
  let r;
  try {
    r = changeUsers(file, (users) => {
      found = users.find((u) => u.name === name && isActive(u));
      live = users.filter(isActive).map((u) => u.name);
      if (found === undefined) return { refused: "unknown" };
      if (isDisabled(found)) { disabledAt = found.disabledAt!; return { refused: "already" }; }
      disabledAt = new Date().toISOString();
      return users.map((u) => u === found ? { ...u, disabledAt } : u);
    });
  } catch (e) { return cantChange(file, e); }
  if (found === undefined) return noSuchUser(name, live);
  const u = found;
  return { disabled: { name: u.name, id: u.id, addedAt: u.addedAt, disabledAt }, already: !Array.isArray(r) };
}

/** ENABLE A DISABLED USER in `file` under its lock: it connects again, with the same password. One not disabled is said so. */
export function enableUser(file: string, name: string): { enabled: { name: string; id: string; addedAt: string }; already: boolean } | Failure {
  const usage = userNameProblem("enable", name);
  if (usage !== null) return { message: usage, code: "usage" };
  let found: MasonUser | undefined;
  let live: string[] = [];
  let r;
  try {
    r = changeUsers(file, (users) => {
      found = users.find((u) => u.name === name && isActive(u));
      live = users.filter(isActive).map((u) => u.name);
      if (found === undefined) return { refused: "unknown" };
      if (!isDisabled(found)) return { refused: "already" };
      return users.map((u) => { if (u !== found) return u; const { disabledAt: _, ...rest } = u; return rest; });
    });
  } catch (e) { return cantChange(file, e); }
  if (found === undefined) return noSuchUser(name, live);
  const u = found;
  return { enabled: { name: u.name, id: u.id, addedAt: u.addedAt }, already: !Array.isArray(r) };
}

// ------------------------------------------------------------------ the command

export async function user(argv: string[]): Promise<number> {
  const f = parseCommand(USER, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string): number => failed("user", { message, code: "usage", usage: USER.usage }, { json });
  const [verb, name, ...rest] = f.positionals;
  const VERBS = ["add", "list", "disable", "enable", "remove"];
  if (verb === undefined) return usage("add, list, disable, enable or remove: mason user add <name> makes a user");
  if (!VERBS.includes(verb)) return usage(`there is no mason user ${verb}: add, list, disable, enable or remove${didYouMean(verb, VERBS)}`);
  if (verb === "list" ? name !== undefined : rest.length) return usage(`mason user ${verb} takes ${verb === "list" ? "no name" : "one name"}: ${[name, ...rest].filter(Boolean).join(" ")} is too many`);
  if (verb !== "list") {
    const problem = userNameProblem(verb as "add" | "remove" | "disable" | "enable", name);
    if (problem !== null) return usage(problem);
  }
  const w = await reach(USER, json);
  if (w === null || w.project === null) return 1;
  const project = w.project;
  const file = path.join(project.dir, USERS_FILE);
  const apiKey = project.config.apiKey;

  if (verb === "list") {
    const up = w.state === "up" ? w.run : null;
    const r = listUsers(file, apiKey, up !== null ? postgresLink(up.postgresUrl) : null);
    if ("message" in r) return failed("user", r, { json });
    // the last use is the run's (its request log is in the copy's file, which only the run opens): asked of its command
    // server, which lists the same file. A run that cannot say is SAID, never guessed.
    let users = r.users;
    let lastUsedNote: string | null = NOT_RUNNING_LAST_USED;
    let requestLogDays: number | null = null;
    if (up !== null) {
      try {
        const asked = await callRun(up, "GET", "/api/users?lastUsed=1");
        if (asked.status === 200 && Array.isArray(asked.body.users)) {
          const used = new Map((asked.body.users as UserRow[]).map((u) => [u.id, u.lastUsedAt]));
          users = users.map((u) => ({ ...u, lastUsedAt: used.get(u.id) ?? null }));
          lastUsedNote = typeof asked.body.lastUsedNote === "string" ? asked.body.lastUsedNote : null;
          requestLogDays = typeof asked.body.requestLogDays === "number" ? asked.body.requestLogDays : null;
        } else lastUsedNote = `unknown: Mason answered ${asked.status}${typeof asked.body.error === "string" ? `: ${asked.body.error}` : ""}`;
      } catch (e) {
        if (!(e instanceof RunUnreachable)) throw e;
        lastUsedNote = `unknown: ${e.message}`;
      }
    }
    const urlNote = up !== null ? null : NOT_RUNNING_URL;
    const next: NextStep[] = [["mason user add <name>", "a user for a tool: its password and URL, printed once"],
      ...(users.some((u) => u.removedAt === null && u.disabledAt !== null) ? [["mason user enable <name>", "a disabled user connects again, with the same password"] as NextStep] : []),
      ...(users.some((u) => u.removedAt === null) ? [["mason user remove <name>", "that user connects no more"] as NextStep] : [])];
    if (json) { out(jsonText(USER, { users, lastUsedNote, urlNote, requestLogDays }, next)); return 0; }
    const s = styleOut();
    if (!users.length) { out(withEnd(`${s.bold(`No users yet for ${project.config.name}.`)}`, { next })); return 0; }
    const active = users.filter((u) => u.removedAt === null);
    const gone = users.filter((u) => u.removedAt !== null);
    const width = Math.max(...users.map((u) => u.name.length));
    // the last use in the words the web page's Users page says it too (lastUsedText): "last used" before a time or "unknown"
    const used = (u: UserRow): string => { const t = lastUsedText(u.lastUsedAt, lastUsedNote, requestLogDays, u.addedAt); return t === "never" ? "never used" : t.startsWith("not used") ? t : `last used ${t}`; };
    const lines = active.map((u) => `  ${s.cyan(u.name.padEnd(width))}   ${s.dim(`id ${u.id} · added ${stamp(u.addedAt)} UTC · ${used(u)}`)}` +
      (u.disabledAt !== null ? `   ${s.yellow(`${disabledText(u.disabledAt)}: does not connect until mason user enable ${u.name}`)}`
        : u.live ? "" : `   ${s.yellow("does not connect: the API key was rotated since it was added")}`));
    const disabled = active.filter((u) => u.disabledAt !== null);
    const removedLines = gone.map((u) => `  ${s.dim(`${u.name.padEnd(width)}   id ${u.id} · added ${stamp(u.addedAt)} UTC · removed ${stamp(u.removedAt!)} UTC`)}`);
    const rotated = active.filter((u) => !u.live && u.disabledAt === null);
    out(withEnd(`${s.bold(`${active.length} user${active.length === 1 ? "" : "s"} of ${project.config.name}${disabled.length ? `, ${disabled.length} disabled` : ""}${gone.length ? `, ${gone.length} removed` : ""}`)}\n${[...lines, ...removedLines].join("\n")}`,
      { tips: [...(rotated.length ? [`A user added under another API key does not connect: mason user remove ${rotated[0]!.name}, then mason user add ${rotated[0]!.name}.`] : []),
        ...(lastUsedNote !== null ? [`Last used: ${lastUsedNote}.`] : [])], next }));
    return 0;
  }

  if (verb === "disable") {
    const r = disableUser(file, name!);
    if ("message" in r) return failed("user", r, { json });
    const next = disabledNext(r.disabled.name);
    if (json) { out(jsonText(USER, r, next)); return 0; }
    const d = r.disabled;
    out(reportText({ headline: r.already ? `The user ${d.name} is disabled already: nothing changed` : `The user ${d.name} disabled: it connects no more, until enabled`,
      details: [["user", d.name], ["disabled", d.disabledAt], ...(r.already ? [] : [["sessions", w.state === "up" ? "those it holds end at their next statement" : "none: Mason is not running"] as const])],
      tips: [disableEffect(d.name)], next }));
    return 0;
  }

  if (verb === "enable") {
    const r = enableUser(file, name!);
    if ("message" in r) return failed("user", r, { json });
    const next = enabledNext(r.enabled.name);
    if (json) { out(jsonText(USER, r, next)); return 0; }
    const e = r.enabled;
    out(reportText({ headline: r.already ? `The user ${e.name} is not disabled: nothing changed, it connects` : `The user ${e.name} enabled: it connects again, with the same password`,
      details: [["user", e.name], ["added", e.addedAt]], next }));
    return 0;
  }

  if (verb === "remove") {
    const r = removeUser(file, name!);
    if ("message" in r) return failed("user", r, { json });
    const gone = r.removed;
    const next = REMOVED_NEXT;
    if (json) { out(jsonText(USER, r, next)); return 0; }
    out(reportText({ headline: `The user ${gone.name} removed: it connects no more`,
      details: [["user", gone.name], ["added", gone.addedAt], ["sessions", w.state === "up" ? "those it holds end at their next statement" : "none: Mason is not running"]],
      tips: [`Adding ${gone.name} again makes a new password: the old one never connects again.`], next }));
    return 0;
  }

  // add
  const run = w.state === "up" ? w.run : null;
  const link: PostgresLink | null = run ? postgresLink(run.postgresUrl) : null;
  const r = addUser(file, apiKey, name!, { link, database: project.config.name });
  if ("message" in r) return failed("user", r, { json });
  const { replaced, ...added } = r;
  const next = addedNext(r.user, link !== null);
  if (json) { out(jsonText(USER, added, next)); return 0; }
  out(reportText({
    headline: `The user ${r.user} added${replaced ? " (in place of one the API key's rotation had removed)" : ""}: its password is printed this once`,
    details: [
      ...(r.url !== undefined && r.psql !== undefined ? [["url", r.url] as const, ["psql", r.psql] as const] : []),
      ["user", r.user], ["password", r.password], ["database", r.database],
      ...(link !== null ? [["host", link.host] as const, ["port", String(link.port)] as const, ...(link.sslmode ? [["ssl mode", link.sslmode] as const] : [])] : []),
    ],
    tips: [
      "Paste it into the tool now: Mason keeps no copy of the password. Lost, remove the user and add it again.",
      ...(link === null ? ["Mason is not running: mason start, then mason status says the host and port this user connects to."] : []),
      ...listenerTips(run?.postgresListener ?? null),
      "It never expires: mason user remove ends it, at once and for every session it holds.",
      "Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.",
    ],
    next,
  }));
  return 0;
}
