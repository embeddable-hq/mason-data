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
import { NO_ROLES, type RoleGrants, type RolesLive } from "../duck/grants.ts";
import { exampleRole, missingAttributesText, noRoleWayOut, problemText, rolesProblemText, readRoles, ROLE_NAME_RE, ROLE_NAME_RULE, ROLES_FILE, roleProblems, rolesFailure, rolesFile, userRole, usersMissingAttributes, type RoleFrom } from "./roles.ts";
import { ATTRIBUTE_NAME_RE, ATTRIBUTE_NAME_RULE, whereAttributes, whereParts, type AttributeShape, type RowFilter } from "../duck/row-filter.ts";
import { readSource, shownPath } from "./sources.ts";
import { readState, type RunState } from "./commands.ts";
import type { DevRun } from "./runs.ts";
import type { Project } from "./project.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

export const USER: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "user",
  summary: "the users the Postgres API takes: a name and a password that does not expire, for a BI tool or an app",
  usage: `usage: mason user add <name> [--role <role>] [--set <attribute>=<value> …] [--json]
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
      tenant:
        attributes: [tenant]         what each of its users carries: --set tenant=42
        tables:
          orders: { where: "tenant_id = :tenant" }    the rows it reads: a Postgres condition
          order_items: { through: orders }          the rows whose order it reads
      region:
        attributes: { regions: list }               several values: --set regions=eu --set regions=us
        tables:
          customers: { where: "region = ANY(:regions)" }

  --set <attribute>=<value> gives the user its value of an attribute its role declares (repeat --set for each
  attribute; a list attribute takes one --set per value; an empty list cannot be written). A role's where:
  reads it as :attribute, bound as a literal of the type Postgres infers for it there (tenant_id = :tenant: the
  column's), so every read of the table — through a view, a join, a subquery, a prepared statement — reads only
  its rows, as Postgres's row security reads them. A user without a value its role reads is refused at every
  statement, never answered with no rows: add it again with the --set. Postgres refuses a where: it cannot read
  when the running Mason reads the file, at its key.

    mason user add metabase                    a user for Metabase: its password and the URL to paste
    mason user add agent --role agent          a user held to the role agent
    mason user add acme --role tenant --set tenant=42      the rows of tenant 42
    mason user add emea --role region --set regions=eu --set regions=uk
    mason user list
    mason user disable metabase                metabase connects no more, until mason user enable metabase
    mason user enable metabase                 metabase connects again, with the same password
    mason user remove metabase                 metabase connects no more
    docker compose exec mason mason user add grafana   beside mason serve, in its data folder

  <name>    ${USER_NAME_RULE}
  --json    as data: add { user (the name), id, addedAt, password, database, role (the role it reads as: its own
            or the file's default; absent when none), attributes? ({ name: value, or [values] for a list }), roleFrom (file: its own --role; default: the file's default;
            none), readsNothing (true: no role under a file with no default), and once Mason runs url, psql (the
            psql line for url), host, port, sslmode }; list { users: [{ name, id, addedAt, removedAt (null for a user
            not removed), disabledAt (null for a user not disabled), live (connects now), role?, attributes?,
            missingAttributes? (the attributes its role's filters read that it lacks: refused until added again), roleFrom, readsNothing?,
            roleKnown? (the roles file names its own role now), lastUsedAt (its newest statement, null when none within
            requestLogDays), url (to paste, without the password; null for a removed user or when Mason is not running) }],
            lastUsedNote (why lastUsedAt is unknown, else null), urlNote (why url is null, else null), requestLogDays
            (null when unknown) }; disable { disabled: { name, id, addedAt, disabledAt }, already (it was disabled
            before) }; enable { enabled: { name, id, addedAt }, already (it was not disabled) }; remove { removed: { name,
            id, addedAt, removedAt } }; next
`,
  options: { json: { type: "boolean", default: false }, role: { type: "string" }, set: { type: "string", multiple: true } },
  json: ["user", "id", "addedAt", "password", "url", "psql", "host", "port", "database", "sslmode", "role", "attributes", "roleFrom", "readsNothing", "users", "disabled", "enabled", "already", "removed", "lastUsedNote", "urlNote", "requestLogDays", "next"],
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
 * removed user and where the listener's address is not known. `role`, the role it reads as — its own, else the roles
 * file's default (src/cli/roles.ts userRole; `roleFrom` says which, `none` where there is neither); `readsNothing`, a
 * user with no role under a file with no default; `roleKnown`, for a user with a role of its own, whether the roles file
 * names it now (false: its statements are refused until it does).
 */
export interface UserRow { name: string; id: string; addedAt: string; removedAt: string | null; disabledAt: string | null; live: boolean; lastUsedAt: string | null; url: string | null;
  role?: string; attributes?: Record<string, string | string[]>; missingAttributes?: string[]; roleFrom: RoleFrom; readsNothing?: true; roleKnown?: boolean }

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
  role?: string; attributes?: Record<string, string | string[]>; roleFrom: RoleFrom; readsNothing?: true;
  replaced: boolean;
}

// ------------------------------------------------------------------ the attributes a user is added with

/** `--set name=value` read: the name and the value (everything after the first `=`, a comma included); or the problem */
export function setOf(arg: string): { name: string; value: string } | string {
  const eq = arg.indexOf("=");
  if (eq < 0) return `--set ${arg}: is <attribute>=<value>, like --set tenant=42`;
  const name = arg.slice(0, eq);
  if (!ATTRIBUTE_NAME_RE.test(name)) return `--set ${arg}: ${JSON.stringify(name)} is not an attribute's name: ${ATTRIBUTE_NAME_RULE}`;
  // through /api/users' JSON: a shell cannot pass one
  if (arg.includes("\0")) return `--set ${name}: a value cannot hold a NUL byte — it would end every statement the value is bound into`;
  return { name, value: arg.slice(eq + 1) };
}

/**
 * THE ATTRIBUTE VALUES A USER IS ADDED WITH, held to its role (`role`: its own, or the file's default) as the roles are
 * now (`live`): every attribute the role declares set — a missing one refused with the where: that reads it and the exact
 * `--set` to add —, none it does not declare (the closest it does), a scalar once, a list once per value and never
 * empty. Checked BEFORE the user is written, by `mason user add` and the run's `/api/users` alike (one grammar: the
 * `--set` strings). A scalar is a string, a list an array of strings, in the order given.
 */
export function attributesToAdd(name: string, role: string | undefined, sets: readonly string[], live: RolesLive): { values: Record<string, string | string[]> } | { refused: Failure } {
  const g = role === undefined ? undefined : live.grants.get(role);
  const declared = g?.attributes ?? new Map<string, AttributeShape>();
  const usage = (message: string, fix?: string): { refused: Failure } => ({ refused: { message, code: "usage", ...(fix !== undefined ? { fix } : {}) } });
  const out: Record<string, string | string[]> = {};
  for (const arg of sets) {
    const s = setOf(arg);
    if (typeof s === "string") return usage(s);
    const shape = declared.get(s.name);
    if (shape === undefined) {
      if (role === undefined) return usage(`--set ${s.name}: the user has no role, so it carries no attribute`, `mason user add ${name} --role <a role that declares ${s.name}> --set ${arg}`);
      const names = [...declared.keys()];
      return usage(`--set ${s.name}: the role ${role} has no attribute ${s.name}${didYouMean(s.name, names)}`,
        names.length ? `its attributes: ${names.join(", ")}` : `the role ${role} declares no attributes (attributes: [${s.name}] beside its tables: in ${live.file ?? `mason/${ROLES_FILE}`})`);
    }
    if (shape === "list") {
      if (s.value === "") return usage(`--set ${s.name}=: ${s.name} is a list, and a list's value is never empty — an empty list is not written (Mason refuses a user without its values rather than answer no rows)`);
      out[s.name] = [...((out[s.name] as string[] | undefined) ?? []), s.value];
    } else {
      if (out[s.name] !== undefined) {
        const lists = [...declared].filter(([, k]) => k === "list").map(([n]) => n);
        return usage(`--set ${s.name} twice: ${s.name} is a scalar of the role ${role!}, one value${didYouMean(s.name, lists)}`, `one --set ${s.name}=<value>; several values are a list attribute (attributes: { ${s.name}: list })`);
      }
      out[s.name] = s.value;
    }
  }
  const missing = [...declared.keys()].filter((a) => out[a] === undefined);
  if (missing.length > 0) {
    const reads = (a: string): string => {
      const f = [...(g?.filters?.values() ?? [])].find((x) => x.where !== undefined && whereAttributes(x.where.parts).includes(a));
      return f === undefined ? "" : ` (${f.at}.where: ${f.where!.text})`;
    };
    const sets2 = missing.map((a) => declared.get(a) === "list" ? `--set ${a}=<value> --set ${a}=<another>` : `--set ${a}=<value>`).join(" ");
    return { refused: { message: `the role ${role!} needs ${missing.map((a) => `--set ${a}=…`).join(" ")}: its users carry ${missing.length === 1 ? "the attribute" : "the attributes"} ${missing.map((a) => `${a}${reads(a)}`).join(", ")}`,
      code: "usage", why: "a user without a value its role's rows are filtered by would be refused at every statement (Mason never answers it with no rows)",
      fix: `mason user add ${name}${role === undefined ? "" : ` --role ${role}`} ${[...sets.map((x) => `--set ${x}`), sets2].join(" ")}` } };
  }
  return { values: out };
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
    if (r !== undefined) return { file: r.file, grants: new Map(r.roles.map((n) => [n, { name: n, file: r.file ?? "", tables: new Map(), all: r.all?.includes(n) === true, ...rowsOfState(r, n) } as RoleGrants])), problem: r.problem, default: r.default ?? null };
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
  return { file, grants: new Map(read.roles.map((r) => {
    const filters = new Map<string, RowFilter>(r.tables === "all" ? [] : r.tables.flatMap((t) => t.where === undefined ? [] : [[t.table, { table: t.table, at: `roles.${r.name}.tables.${t.name}`, where: t.where }] as [string, RowFilter]]));
    return [r.name, { name: r.name, file, tables: new Map(), all: r.tables === "all", ...(r.attributes !== undefined ? { attributes: r.attributes } : {}), ...(filters.size > 0 ? { filters } : {}) } as RoleGrants];
  })), problem: null, default: read.default };
}

/** a role's attributes and its where:s as `/api/state` says them, as the grants' fields `attributesToAdd` reads */
function rowsOfState(r: NonNullable<RunState["roles"]>, role: string): Pick<RoleGrants, "attributes" | "filters"> {
  const attrs = r.attributes?.[role];
  const filters = new Map<string, RowFilter>();
  for (const f of r.wheres?.[role] ?? []) {
    const parts = whereParts(f.where);
    if (!("problem" in parts)) filters.set(f.table, { table: f.table, at: f.at, where: { text: f.where, parts } });
  }
  return { ...(attrs !== undefined && Object.keys(attrs).length > 0 ? { attributes: new Map(Object.entries(attrs)) } : {}), ...(filters.size > 0 ? { filters } : {}) };
}

/** a user's attributes as `mason user add` and `mason user list` say them: `tenant=42, regions=[eu, uk]` */
export const attributesText = (a: Readonly<Record<string, string | readonly string[]>>): string =>
  Object.entries(a).map(([k, v]) => `${k}=${typeof v === "string" ? v : `[${v.join(", ")}]`}`).join(", ");

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
 * Postgres API listens, when it is known — the URL to paste without the password, and with a role whether `roles` names it now; or why the file cannot be read.
 * `lastUsedAt` is null here: `withLastUsed` fills it from the request log, which only the run has.
 */
export function listUsers(file: string, apiKey: string, link: PostgresLink | null, roles: RolesLive = NO_ROLES): { users: UserRow[] } | Failure {
  const r = readUsers(file);
  if ("problem" in r) return { message: `the list of users cannot be read: ${r.problem}`, code: "bad_config", why: "no user connects while it cannot be read",
    fix: `repair ${file}, or move it aside, which removes every user` };
  // roleKnown only where the file can be read: under a problem the listener refuses every user held to it for the FILE
  return { users: r.users.map((u) => ({ name: u.name, id: u.id, addedAt: u.addedAt, removedAt: u.removedAt ?? null, disabledAt: u.disabledAt ?? null,
    live: isActive(u) && !isDisabled(u) && liveOf(u, apiKey),
    lastUsedAt: null, url: link !== null && isActive(u) ? connectionUrl(link, u.name, null) : null,
    ...roleFields(u, roles), ...(u.attributes !== undefined ? { attributes: u.attributes } : {}),
    ...((m) => m === undefined ? {} : { missingAttributes: m.missing })(usersMissingAttributes([u], roles)[0]),
    ...(u.role !== undefined && roles.problem === null ? { roleKnown: roles.grants.has(u.role) } : {}) })) };
}

/** a user's role as the JSON says it: the role it reads as, where from, and whether it reads nothing (src/cli/roles.ts userRole) */
function roleFields(u: { role?: string | undefined }, roles: RolesLive): { role?: string; roleFrom: RoleFrom; readsNothing?: true } {
  const r = userRole(u, roles);
  return { ...(r.role !== undefined ? { role: r.role } : {}), roleFrom: r.roleFrom, ...(r.readsNothing ? { readsNothing: true as const } : {}) };
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
export function addUser(file: string, apiKey: string, name: string, o: { link: PostgresLink | null; database: string; role?: string; roles?: RolesLive; attributes?: Record<string, string | string[]> }): AddedUser | Failure {
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
      added = { name, id: newUserId(), addedAt: now, key: fingerprint, ...(o.role !== undefined ? { role: o.role } : {}),
        ...(o.attributes !== undefined && Object.keys(o.attributes).length > 0 ? { attributes: o.attributes } : {}) };
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
    ...(link !== null ? { url: connectionUrl(link, u.name, password), psql: psqlLine(connectionUrl(link, u.name, password)), host: link.host, port: link.port, sslmode: link.sslmode ?? "disable" } : {}),
    ...roleFields(u, o.roles ?? NO_ROLES), ...(u.attributes !== undefined ? { attributes: u.attributes } : {}), replaced };
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
  const role = typeof f.values.role === "string" ? f.values.role : undefined;
  if (role !== undefined && verb !== "add") return usage(`--role goes with mason user add: mason user add <name> --role ${role}`);
  const sets = Array.isArray(f.values.set) ? f.values.set.filter((x): x is string => typeof x === "string") : [];
  if (sets.length > 0 && verb !== "add") return usage(`--set goes with mason user add: mason user add <name> --role <role> --set ${sets[0]!}`);
  for (const arg of sets) { const s = setOf(arg); if (typeof s === "string") return usage(s); }
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
    const roles = await rolesBeside(project, up);
    const r = listUsers(file, apiKey, up !== null ? postgresLink(up.postgresUrl) : null, roles);
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
    const rolesFileShown = roles.file ?? `mason/${ROLES_FILE}`;
    // the last use in the words the web page's Users page says it too (lastUsedText): "last used" before a time or "unknown"
    const used = (u: UserRow): string => { const t = lastUsedText(u.lastUsedAt, lastUsedNote, requestLogDays, u.addedAt); return t === "never" ? "never used" : t.startsWith("not used") ? t : `last used ${t}`; };
    const lines = active.map((u) => `  ${s.cyan(u.name.padEnd(width))}   ${u.role !== undefined ? `role ${u.role}${u.roleFrom === "default" ? " (default)" : ""}${u.attributes !== undefined ? ` (${attributesText(u.attributes)})` : ""}   ` : ""}${s.dim(`id ${u.id} · added ${stamp(u.addedAt)} UTC · ${used(u)}`)}` +
      (u.disabledAt !== null ? `   ${s.yellow(`${disabledText(u.disabledAt)}: does not connect until mason user enable ${u.name}`)}`
        : u.live ? "" : `   ${s.yellow("does not connect: the API key was rotated since it was added")}`) +
      (u.roleKnown === false ? `   ${s.yellow(`its role ${u.role} is not in the roles file: its statements are refused`)}` : "") +
      (u.readsNothing === true ? `   ${s.yellow(`has no role, and ${rolesFileShown} names no default: its statements are refused`)}` : "") +
      (u.missingAttributes !== undefined ? `   ${s.yellow(`has no value for ${u.missingAttributes.join(", ")}: its statements are refused`)}` : ""));
    const disabled = active.filter((u) => u.disabledAt !== null);
    const removedLines = gone.map((u) => `  ${s.dim(`${u.name.padEnd(width)}   id ${u.id} · added ${stamp(u.addedAt)} UTC · removed ${stamp(u.removedAt!)} UTC`)}`);
    const rotated = active.filter((u) => !u.live && u.disabledAt === null);
    const orphan = active.find((u) => u.roleKnown === false);
    const roleless = active.find((u) => u.readsNothing === true);
    const unset = active.find((u) => u.missingAttributes !== undefined);
    out(withEnd(`${s.bold(`${active.length} user${active.length === 1 ? "" : "s"} of ${project.config.name}${disabled.length ? `, ${disabled.length} disabled` : ""}${gone.length ? `, ${gone.length} removed` : ""}`)}\n${[...lines, ...removedLines].join("\n")}`,
      { tips: [...(rotated.length ? [`A user added under another API key does not connect: mason user remove ${rotated[0]!.name}, then mason user add ${rotated[0]!.name}.`] : []),
        ...(orphan ? [`A role the roles file (mason/${ROLES_FILE}) does not name reads nothing: add ${orphan.role} to it, or mason user remove ${orphan.name}, then mason user add ${orphan.name} --role <role>.`] : []),
        ...(unset ? [`A user without a value its role's rows are filtered by is refused at every statement: ${missingAttributesText({ name: unset.name, role: unset.role ?? "", missing: unset.missingAttributes! })}.`] : []),
        ...(roleless ? [`A user with no role reads nothing while ${rolesFileShown} names no default: ${noRoleWayOut(roleless.name, rolesFileShown, exampleRole(roles))}.`] : []),
        ...(roles.problem !== null && active.length ? [rolesProblemText(rolesFileShown, roles.problem)] : []),
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
  // the role must be one the roles file names NOW (the listener's reading while the run is up): refused before writing
  const roles = await rolesBeside(project, run);
  if (role !== undefined) {
    const problem = roleToAdd(role, roles);
    if (problem !== null) return failed("user", problem, { json });
  }
  // the attributes the role declares, every one, and none other: refused before writing, as the role is
  const attributes = attributesToAdd(name!, role ?? userRole({}, roles).role, sets, roles);
  if ("refused" in attributes) return failed("user", attributes.refused, { json });
  const r = addUser(file, apiKey, name!, { link, database: project.config.name, roles, ...(role !== undefined ? { role } : {}), attributes: attributes.values });
  if ("message" in r) return failed("user", r, { json });
  const { replaced, ...added } = r;
  const next = addedNext(r.user, link !== null);
  if (json) { out(jsonText(USER, added, next)); return 0; }
  out(reportText({
    headline: `The user ${r.user} added${replaced ? " (in place of one the API key's rotation had removed)" : ""}: its password is printed this once`,
    details: [
      ...(r.url !== undefined && r.psql !== undefined ? [["url", r.url] as const, ["psql", r.psql] as const] : []),
      ["user", r.user], ["password", r.password], ["database", r.database],
      ...(r.attributes !== undefined ? [["attributes", attributesText(r.attributes)] as const] : []),
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
