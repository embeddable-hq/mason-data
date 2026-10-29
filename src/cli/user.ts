/**
 * `mason user add | list | remove` — NAMED, REVOCABLE LOGINS FOR THE POSTGRES API, WITH NO EXPIRY
 * (docs/DESIGN.md "On a server", item 1 of the agreed plan; src/duck/users.ts holds the rules). A BI
 * tool's datasource stores ONE password: a user's lasts until it is removed.
 *
 * It runs as a second process beside the run (or beside `mason serve`: `docker compose exec mason mason user add
 * metabase`, the data folder's `.mason/`), so it needs the project, never the run: it edits `.mason/users.json` under
 * the file's lock, and the run's listener reads the change at its next connection or statement. The password is said
 * ONCE, by `add`, with the URL to paste (one URL builder, pg-url.ts `connectionUrl`) when the run is up and recorded
 * where it listens. The web page's users (`mason ui`) are the same functions (`addUser`, `listUsers`, `removeUser`),
 * called by the run's command server.
 */
import * as path from "node:path";
import { failed, jsonText, parseCommand, reportText, withEnd, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { reach } from "./state.ts";
import { connectionUrl, listenerTips, postgresLink, psqlLine, type PostgresLink } from "./pg-url.ts";
import { changeUsers, keyFingerprint, newUserId, readUsers, underKey, userPassword, USER_NAME_RE, USER_NAME_RULE, USERS_FILE, type MasonUser } from "../duck/users.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { out as styleOut } from "./style.ts";
import { NO_ROLES, type RoleGrants, type RolesLive } from "../duck/grants.ts";
import { exampleRole, noRoleWayOut, problemText, readRoles, ROLE_NAME_RE, ROLE_NAME_RULE, ROLES_FILE, roleProblems, rolesFailure, rolesFile, userRole, type RoleFrom } from "./roles.ts";
import { readSource, shownPath } from "./sources.ts";
import { readState, type RunState } from "./commands.ts";
import { RunUnreachable } from "./control.ts";
import type { DevRun } from "./runs.ts";
import type { Project } from "./project.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

export const USER: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "user",
  summary: "the users the Postgres API takes: a name and a password that does not expire, for a BI tool or an app",
  usage: `usage: mason user add <name> [--role <role>] [--json]
       mason user list [--json]
       mason user remove <name> [--json]

  A user of this project's Postgres API: a name and a password, as a BI tool's datasource form asks for them
  (Metabase, Grafana, Superset, Power BI) or an app's DATABASE_URL carries them. Its password does not expire:
  it connects until mason user remove, which refuses its next connection at once and
  ends the sessions it holds at their next statement, without a restart. The password is printed once, by add.
  The user name a tool sends must be the user's own.

  The list is .mason/users.json (names and ids, no password), beside the running Mason, which reads it again by itself.
  Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.

  --role <role> limits what the user reads to a role of mason/roles.yml (beside the sources file): the tables, and
  the columns of each, it may read. A statement over anything else is refused as Postgres refuses it (42501,
  permission denied for table …), information_schema and mason mcp list the role only what it may read, and the
  role is read with the user at every statement, so an edit of the file applies at the next one. A user added
  without --role reads as the file's default: role; under a file with no default: it reads nothing; with no
  roles file at all, every copied table. mason init writes the file:

    default: everything              the role of a user added without --role
    roles:
      everything:
        tables: all                  every copied table and column, those added later included
      agent:                         the role's name (${ROLE_NAME_RULE})
        tables:
          orders: {}                 every column of a copied table
          customers:
            columns: [id, country]   these columns only
          billing.invoices:
            exclude: [notes]         every column but these

    mason user add metabase                    a user for Metabase: its password and the URL to paste
    mason user add agent --role agent          a user held to the role agent
    mason user list
    mason user remove metabase                 metabase connects no more
    docker compose exec mason mason user add grafana   beside mason serve, in its data folder

  <name>    ${USER_NAME_RULE}
  --json    as data: add { user (the name), id, addedAt, password, database, role (the role it reads as: its own
            or the file's default; absent when none), roleFrom (file: its own --role; default: the file's default;
            none), readsNothing (true: no role under a file with no default), and once Mason runs url, host, port,
            sslmode }; list { users: [{ name, id, addedAt, live, role?, roleFrom, readsNothing?, roleKnown? }] };
            remove { removed: { name, id, addedAt } }; next
`,
  options: { json: { type: "boolean", default: false }, role: { type: "string" } },
  json: ["user", "id", "addedAt", "password", "url", "host", "port", "database", "sslmode", "role", "roleFrom", "readsNothing", "users", "removed", "next"],
};


/** The users of a project and why one is not live: added under an API key since rotated. */
const liveOf = (u: MasonUser, apiKey: string): boolean => underKey(u, apiKey);

// ------------------------------------------------------------------ what add, list and remove do
// ONE implementation, for `mason user` and for the run's command server (src/cli/run-server.ts `/api/users`, the web
// page's users): the same file, under the same lock, refused in the same sentences, so the two cannot disagree.

/** A user as `mason user list --json` lists it: `role`, the role it reads as — its own, else the roles file's default
 *  (src/cli/roles.ts userRole; `roleFrom` says which, `none` where there is neither); `readsNothing`, a user with no
 *  role under a file with no default; `roleKnown`, for a user with a role of its own, whether the roles file names
 *  it now (false: its statements are refused until it does). */
export interface UserRow { name: string; id: string; addedAt: string; live: boolean; role?: string; roleFrom: RoleFrom; readsNothing?: true; roleKnown?: boolean }

/** A user just added, in `mason user add --json`'s shape (`replaced`: in place of one the API key's rotation had removed). */
export interface AddedUser {
  user: string; id: string; addedAt: string; password: string; database: string;
  url?: string; host?: string; port?: number; sslmode?: string;
  role?: string; roleFrom: RoleFrom; readsNothing?: true;
  replaced: boolean;
}

// ------------------------------------------------------------------ the role a user is added with

/**
 * WHY `role` IS NOT ONE A USER CAN BE ADDED WITH, against the roles as they are now (`live`: the listener's while the
 * run is up, the file's otherwise): a name of another shape, a file that cannot be read as it is, no roles file at
 * all (the lines to add), a role the file does not name (the closest it does). Null: the role is in the file. Checked
 * BEFORE the user is written, by `mason user add` and the run's `/api/users` alike, so a user never carries a role
 * that reads nothing by mistake — one whose role is removed LATER is refused at its next statement (fail closed).
 */
export function roleToAdd(role: string, live: RolesLive): Failure | null {
  if (!ROLE_NAME_RE.test(role)) return { message: `${JSON.stringify(role)} is not a role name: ${ROLE_NAME_RULE}`, code: "usage" };
  const file = live.file ?? `mason/${ROLES_FILE}`;
  if (live.problem !== null) {
    return { message: `${file} cannot be read as it is now, so no user can be added with a role: ${live.problem}`, code: "bad_roles",
      why: "a user's role is checked against the file before the user is written, and every statement of a user with a role is refused while the file is wrong",
      fix: `repair ${file}; mason user add ${"<name>"} --role ${role} then`, next: [["mason user list", "the users, and whose role the file lacks"]] };
  }
  const names = [...live.grants.keys()];
  if (names.length === 0) {
    return { message: `there is no role ${role}: this project has no roles file`, code: "not_found",
      why: `a role is a key of ${file}, beside the sources file, naming the tables (and the columns of each) its users may read`,
      fix: `write ${file}:
  roles:
    ${role}:
      tables:
        <a copied table>: {}
then mason user add <name> --role ${role}`,
      next: [["mason tables", "the tables the sources file copies: what a role may name"]] };
  }
  if (!live.grants.has(role)) {
    return { message: `there is no role ${role} in ${file}${didYouMean(role, names)}`, code: "not_found",
      why: `the roles: ${names.join(", ")}`,
      fix: `add it to ${file}:
  roles:
    ${role}:
      tables:
        <a copied table>: {}
or mason user add <name> --role ${names[0]}`,
      next: [["mason user list", "the users and their roles"]] };
  }
  return null;
}

/**
 * THE ROLES AS A COMMAND BESIDE THE RUN SEES THEM: the listener's own while the run is up (`/api/state`'s roles: what a
 * session is held to this moment), else the file read here and its tables held to the sources file's entries (their
 * columns are the database's, which only the run knows: a column the copy lacks is refused by mason start). One
 * object of src/duck/grants.ts's shape, whose grants here carry the names only.
 */
export async function rolesBeside(project: Project, run: DevRun | null): Promise<RolesLive> {
  if (run !== null) {
    let r: RunState["roles"];
    // a run that does not answer its state (hung, or an older run without /api/state's roles): the file is read here
    // instead, as with Mason stopped — the user is still refused a role the file lacks, which is what this guards
    try { r = (await readState(run)).roles; } catch (e) { if (!(e instanceof RunUnreachable)) throw e; r = undefined; }
    if (r !== undefined) return { file: r.file, grants: new Map(r.roles.map((n) => [n, { name: n, file: r.file ?? "", tables: new Map(), all: false } as RoleGrants])), problem: r.problem, default: r.default ?? null };
  }
  const read = readRoles(project.folder, project.root);
  if (read === null) return NO_ROLES;
  const file = shownPath(project.root, rolesFile(project.folder));
  if ("message" in read) return { file, grants: new Map(), problem: problemText(read), default: null };
  const src = readSource(project.folder, project.root);
  // the sources file unreadable here: the role's tables are held to it by mason start; the names are checked
  const copied = "message" in src ? null : src.tables.map((e) => ({ source: e.table, columns: e.columns === null ? null : e.columns.map((name) => ({ name })) }));
  const problems = copied === null ? [] : roleProblems(read, copied);
  if (problems.length) return { file, grants: new Map(), problem: problemText(rolesFailure(read.file, project.root, problems)), default: read.default };
  return { file, grants: new Map(read.roles.map((r) => [r.name, { name: r.name, file, tables: new Map(), all: r.tables === "all" } as RoleGrants])), problem: null, default: read.default };
}

/** What to run after an add: with Mason up, the list and how to end it; with Mason stopped, mason start first. */
export const addedNext = (name: string, up: boolean): NextStep[] => up
  ? [["mason user list", "the users"], [`mason user remove ${name}`, "it connects no more"]]
  : [["mason start", "start Mason: then mason status prints where the Postgres API listens"], ["mason user list", "the users"]];
/** What to run after a remove. */
export const REMOVED_NEXT: readonly NextStep[] = [["mason user list", "the users left"], ["mason user add <name>", "a new user, with a new password"]];

/** Why `name` is not one `mason user <verb>` takes (a usage failure), or null. */
export function userNameProblem(verb: "add" | "remove", name: string | undefined): string | null {
  if (name === undefined) return `mason user ${verb} <name>: which user`;
  if (!USER_NAME_RE.test(name)) return `${JSON.stringify(name)} is not a user name: ${USER_NAME_RULE}`;
  return null;
}

const cantChange = (file: string, e: unknown): Failure => ({ message: `the list of users could not be changed: ${(e as Error).message}`, code: "failed",
  fix: `${file} is the list (mason user writes it): repair it, or move it aside, which removes every user` });

/** The users `file` lists, each with whether it connects under `apiKey` and, with a role, whether `roles` names it
 *  now; or why the file cannot be read. */
export function listUsers(file: string, apiKey: string, roles: RolesLive = NO_ROLES): { users: UserRow[] } | Failure {
  const r = readUsers(file);
  if ("problem" in r) return { message: `the list of users cannot be read: ${r.problem}`, code: "bad_config", why: "no user connects while it cannot be read",
    fix: `repair ${file}, or move it aside, which removes every user` };
  return { users: r.users.map((u) => ({ name: u.name, id: u.id, addedAt: u.addedAt, live: liveOf(u, apiKey), ...roleFields(u, roles),
    ...(u.role !== undefined ? { roleKnown: roles.problem === null && roles.grants.has(u.role) } : {}) })) };
}

/** a user's role as the JSON says it: the role it reads as, where from, and whether it reads nothing (src/cli/roles.ts userRole) */
function roleFields(u: { role?: string | undefined }, roles: RolesLive): { role?: string; roleFrom: RoleFrom; readsNothing?: true } {
  const r = userRole(u, roles);
  return { ...(r.role !== undefined ? { role: r.role } : {}), roleFrom: r.roleFrom, ...(r.readsNothing ? { readsNothing: true as const } : {}) };
}

/**
 * ADD A USER to `file` under its lock: a new id, its password (said here, once, and kept nowhere), and — `link`, where
 * the run's Postgres API listens, when it is up — the URL to paste. A name taken by a live user is refused.
 */
export function addUser(file: string, apiKey: string, name: string, o: { link: PostgresLink | null; database: string; role?: string; roles?: RolesLive }): AddedUser | Failure {
  const usage = userNameProblem("add", name);
  if (usage !== null) return { message: usage, code: "usage" };
  const fingerprint = keyFingerprint(apiKey);
  let added: MasonUser | undefined;
  let replaced = false;
  let r;
  try {
    r = changeUsers(file, (users) => {
      const was = users.find((u) => u.name === name);
      // a user added under a key since rotated connects no more: its name is free, said
      if (was !== undefined && was.key === fingerprint) return { refused: "taken" };
      replaced = was !== undefined;
      added = { name, id: newUserId(), addedAt: new Date().toISOString(), key: fingerprint, ...(o.role !== undefined ? { role: o.role } : {}) };
      return [...users.filter((u) => u !== was), added];
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
    ...(link !== null ? { url: connectionUrl(link, u.name, password), host: link.host, port: link.port, sslmode: link.sslmode ?? "disable" } : {}),
    ...roleFields(u, o.roles ?? NO_ROLES), replaced };
}

/** REMOVE A USER from `file` under its lock: it connects no more. A name the file lacks is refused with the closest it has. */
export function removeUser(file: string, name: string): { removed: { name: string; id: string; addedAt: string } } | Failure {
  const usage = userNameProblem("remove", name);
  if (usage !== null) return { message: usage, code: "usage" };
  let removed: MasonUser | undefined;
  let live: string[] = [];
  let r;
  try {
    r = changeUsers(file, (users) => {
      removed = users.find((u) => u.name === name);
      live = users.map((u) => u.name);
      return removed === undefined ? { refused: "unknown" } : users.filter((u) => u !== removed);
    });
  } catch (e) { return cantChange(file, e); }
  if (!Array.isArray(r)) {
    return { message: `there is no user ${JSON.stringify(name)}${didYouMean(name, live)}`, code: "not_found",
      why: live.length ? `the users: ${live.join(", ")}` : "this project has no users", next: [["mason user list", "the users"]] };
  }
  const gone = removed!;
  return { removed: { name: gone.name, id: gone.id, addedAt: gone.addedAt } };
}

// ------------------------------------------------------------------ the command

export async function user(argv: string[]): Promise<number> {
  const f = parseCommand(USER, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string): number => failed("user", { message, code: "usage", usage: USER.usage }, { json });
  const [verb, name, ...rest] = f.positionals;
  if (verb === undefined) return usage("add, list or remove: mason user add <name> makes a user");
  if (!["add", "list", "remove"].includes(verb)) return usage(`there is no mason user ${verb}: add, list or remove${didYouMean(verb, ["add", "list", "remove"])}`);
  if (verb === "list" ? name !== undefined : rest.length) return usage(`mason user ${verb} takes ${verb === "list" ? "no name" : "one name"}: ${[name, ...rest].filter(Boolean).join(" ")} is too many`);
  const role = typeof f.values.role === "string" ? f.values.role : undefined;
  if (role !== undefined && verb !== "add") return usage(`--role goes with mason user add: mason user add <name> --role ${role}`);
  if (verb !== "list") {
    const problem = userNameProblem(verb as "add" | "remove", name);
    if (problem !== null) return usage(problem);
  }
  const w = await reach(USER, json);
  if (w === null || w.project === null) return 1;
  const project = w.project;
  const file = path.join(project.dir, USERS_FILE);
  const apiKey = project.config.apiKey;

  if (verb === "list") {
    const roles = await rolesBeside(project, w.state === "up" ? w.run : null);
    const r = listUsers(file, apiKey, roles);
    if ("message" in r) return failed("user", r, { json });
    const next: NextStep[] = [["mason user add <name>", "a user for a tool: its password and URL, printed once"], ...(r.users.length ? [["mason user remove <name>", "that user connects no more"] as NextStep] : [])];
    if (json) { out(jsonText(USER, { users: r.users }, next)); return 0; }
    const s = styleOut();
    if (!r.users.length) { out(withEnd(`${s.bold(`No users yet for ${project.config.name}.`)}`, { next })); return 0; }
    const width = Math.max(...r.users.map((u) => u.name.length));
    const rolesFileShown = roles.file ?? `mason/${ROLES_FILE}`;
    const lines = r.users.map((u) => `  ${s.cyan(u.name.padEnd(width))}   ${u.role !== undefined ? `role ${u.role}${u.roleFrom === "default" ? " (default)" : ""}   ` : ""}${s.dim(`id ${u.id} · added ${u.addedAt.slice(0, 16).replace("T", " ")} UTC`)}` +
      (u.live ? "" : `   ${s.yellow("does not connect: the API key was rotated since it was added")}`) +
      (u.roleKnown === false ? `   ${s.yellow(`its role ${u.role} is not in the roles file: its statements are refused`)}` : "") +
      (u.readsNothing === true ? `   ${s.yellow(`has no role, and ${rolesFileShown} names no default: its statements are refused`)}` : ""));
    const rotated = r.users.filter((u) => !u.live);
    const orphan = r.users.find((u) => u.roleKnown === false);
    const roleless = r.users.find((u) => u.readsNothing === true);
    out(withEnd(`${s.bold(`${r.users.length} user${r.users.length === 1 ? "" : "s"} of ${project.config.name}`)}\n${lines.join("\n")}`,
      { tips: [
        ...(rotated.length ? [`A user added under another API key does not connect: mason user remove ${rotated[0]!.name}, then mason user add ${rotated[0]!.name}.`] : []),
        ...(orphan ? [`A role the roles file (mason/${ROLES_FILE}) does not name reads nothing: add ${orphan.role} to it, or mason user remove ${orphan.name}, then mason user add ${orphan.name} --role <role>.`] : []),
        ...(roleless ? [`A user with no role reads nothing while ${rolesFileShown} names no default: ${noRoleWayOut(roleless.name, rolesFileShown, exampleRole(roles))}.`] : []),
      ], next }));
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
  // the role must be one the roles file names NOW (the listener's reading while the run is up): refused before writing
  const roles = await rolesBeside(project, run);
  if (role !== undefined) {
    const problem = roleToAdd(role, roles);
    if (problem !== null) return failed("user", problem, { json });
  }
  const r = addUser(file, apiKey, name!, { link, database: project.config.name, roles, ...(role !== undefined ? { role } : {}) });
  if ("message" in r) return failed("user", r, { json });
  const { replaced, ...added } = r;
  const next = addedNext(r.user, link !== null);
  if (json) { out(jsonText(USER, added, next)); return 0; }
  out(reportText({
    headline: `The user ${r.user} added${replaced ? " (in place of one the API key's rotation had removed)" : ""}: its password is printed this once`,
    details: [
      ...(r.url !== undefined ? [["url", r.url] as const, ["psql", psqlLine(r.url)] as const] : []),
      ["user", r.user], ["password", r.password], ["database", r.database],
      ...(r.roleFrom === "file" ? [["role", `${r.role!} (mason/${ROLES_FILE} names what it reads)`] as const]
        : r.roleFrom === "default" ? [["role", `${r.role!} (the file's default: ${roles.file ?? `mason/${ROLES_FILE}`})`] as const]
        : r.readsNothing === true ? [["role", `none, and ${roles.file ?? `mason/${ROLES_FILE}`} names no default: it reads nothing until one is written`] as const] : []),
      ...(link !== null ? [["host", link.host] as const, ["port", String(link.port)] as const, ...(link.sslmode ? [["ssl mode", link.sslmode] as const] : [])] : []),
    ],
    tips: [
      "Paste it into the tool now: Mason keeps no copy of the password. Lost, remove the user and add it again.",
      ...(r.readsNothing === true ? [`Its statements are refused until it has a role: ${noRoleWayOut(r.user, roles.file ?? `mason/${ROLES_FILE}`, exampleRole(roles))}.`] : []),
      ...(link === null ? ["Mason is not running: mason start, then mason status says the host and port this user connects to."] : []),
      ...listenerTips(run?.postgresListener ?? null),
      "It never expires: mason user remove ends it, at once and for every session it holds.",
      "Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.",
    ],
    next,
  }));
  return 0;
}
