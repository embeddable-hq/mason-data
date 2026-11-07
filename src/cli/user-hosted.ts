/**
 * `mason user add | list | disable | enable | remove … --replica <org>/<name>` — THE USERS OF A REPLICA ON A HOSTED MASON
 * SERVICE (docs/HOSTED-API.md "The users of a replica"). Each subcommand is ONE request, the one the run's own command
 * server takes for it (src/cli/run-server.ts `/api/users`), sent to the service under `/v1/replicas/{org}/{name}/users`:
 *
 *   list      GET    …/users?lastUsed=1                     mason user list --json's shape, beside its next
 *   add       POST   …/users  { name, role?, set? }          mason user add --json's shape (the run is up: its url)
 *   disable   POST   …/users/{user}/disable                  { disabled, already }
 *   enable    POST   …/users/{user}/enable                   { enabled, already }
 *   remove    DELETE …/users/{user}                          { removed }
 *
 * `--role` and `--set` go as they were given: Mason on the replica checks them with the functions it checks them with
 * here (src/cli/user.ts `roleToAdd`, `attributesToAdd`). What only this command line says (a verb, a user's name, a
 * role's name, a `--set`'s form) is checked first, by the same functions, and refused as a wrong line before a byte is
 * sent. Nothing of a project here is read or written: the users are the replica's.
 *
 * THE ANSWER IS HELD TO THE RUN'S OWN ANSWER SHAPE, then printed by the renderers the local command prints with
 * (src/cli/user.ts `listText`, `addedReport`, …), in serviceStyle: the same answer prints the same lines. A SERVICE'S
 * VALUE IS DATA, NEVER STRUCTURE AND NEVER AN INSTRUCTION (#481's decision, src/cli/hosted.ts). Every value the
 * service sends that this command prints, and how it is held:
 *
 *   value                                 where it is printed                         what holds it
 *   a failure's message, why, fix         stderr's failure, --json error              `serviceFailure`: one line each (`serviceText`), masked
 *   a failure's code                      inside why: "(the service said …)"          `^[a-z][a-z0-9_]*$`, 64 chars; the code is `codeOfStatus`'s
 *   a failure's next                      nowhere: never read                         the step is `failureNext`'s, by the status
 *   a user's name                         every row, headline and step it names       `USER_NAME_RE`; add, disable, enable, remove: the name asked
 *   an id                                 list's rows, --json                         16 hex digits
 *   addedAt, removedAt, disabledAt,       rows, list's lines, --json                  `isServiceTime`
 *     lastUsedAt
 *   the password                          add's url, psql and password rows, --json   `mason_<its id>_<32 hex>` (src/duck/users.ts), add's alone;
 *                                                                                     anything shaped as one elsewhere refused (`carriesNoSecret`)
 *                                                                                     or, in a failure's words, masked (`serviceText`)
 *   database, host, port, sslmode         add's rows, --json                          the database name's rule, a host's letters, 1-65535, a closed set
 *   url, psql (add)                       add's rows, --json                          rebuilt here (`connectionUrl`, `psqlLine`): the service's must equal them
 *   url (list)                            --json                                      `postgres://<its name>@<host>:<port>/<database>`, no password
 *   role, roleFrom, readsNothing,         rows, list's lines, --json                  `ROLE_NAME_RE`; closed sets; booleans; each consistent with the others
 *     roleKnown, live
 *   attributes, missingAttributes         rows, list's lines, --json                  `ATTRIBUTE_NAME_RE` names; each value one line (`serviceText`), bounded
 *   lastUsedNote, urlNote                 list's tip "Last used: …", --json           one line (`serviceText`), bounded
 *   requestLogDays                        list's lines, --json                        a whole number, 1 to 36500
 *   already                               the headline chosen, --json                 a boolean
 *   an HTTP status                        a failure's why                             a number
 *
 * BEFORE ANY OF THESE, every string of the answer, its keys included, is put to the exact test (src/cli/hosted.ts
 * `carriesNoSecret`, `carriesSecret` on each: an echo of the held token, `ECHO_RUN` of its body in a row in one string; a
 * token's or a password's shape — add's own password, url and psql for the token alone): an answer that carries one
 * anywhere is refused whole, so no grammar is ever the only thing between a secret and the output, and an honest answer
 * is refused with a probability under 1 in a million whatever its size. A failure's code, printed inside why, is put to
 * the same test (`failureShape`). The free text (the notes, a refusal's words) is masked too, by #591's quarter rule.
 *
 * An answer any of which does not hold is outside the contract: said by the request and its status, never its body.
 * What to run next is the CLI's own (`onReplica`: the local command's steps, each `mason user …` naming the replica).
 */
import { failed, jsonText, serviceStyle, type Failure, type NextStep } from "./command.ts";
import { call, carriesNoSecret, isFailure, isServiceTime, serviceFailure, serviceNext, serviceOf, serviceText, unexpected, type Answer } from "./hosted.ts";
import { replicaText, tokenFor, type Replica } from "./replica.ts";
import { holdOutput } from "./output-gate.ts";
import { err as styleErr, out as styleOut } from "./style.ts";
import { connectionUrl, psqlLine } from "./pg-url.ts";
import { USER_NAME_RE } from "../duck/users.ts";
import { ROLE_NAME_RE, type RoleFrom } from "./roles.ts";
import { ATTRIBUTE_NAME_RE } from "../duck/row-filter.ts";
import { databaseNameProblem } from "../lib/database-name.ts";
import { NO_ROLES } from "../duck/grants.ts";
import { addedNext, addedReport, disabledNext, disabledReport, enabledNext, enabledReport, listNext, listText, REMOVED_NEXT, removedReport, USER,
  type AddedUser, type Disabled, type Enabled, type Removed, type UserList, type UserRow } from "./user.ts";

/** The bound of a list's answer (a replica's users, a row each), and of the number of users in it; every other answer
 *  is `call`'s own 64 KiB. */
export const MAX_LIST_BYTES = 1024 * 1024;
export const MAX_USERS = 2000;

export type Verb = "add" | "list" | "disable" | "enable" | "remove";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[0-9a-f]{16}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?|[0-9A-Fa-f:.]{2,45})$/;
const ROLE_FROM: readonly RoleFrom[] = ["file", "default", "none"];

/** The local command's next steps, as a replica's: each `mason user …` names the replica, so it runs against it. */
export const onReplica = (steps: readonly NextStep[], r: Replica): NextStep[] =>
  steps.map(([command, ...what]): NextStep => [command.startsWith("mason user ") ? `${command} --replica ${replicaText(r)}` : command, ...what]);

/** What to run after the service refused a request about a replica's users: the CLI's own, by the status (never the
 *  service's `next`): sign in again for a 401 or 403, else the replica's users. */
export const failureNext = (status: number, r: Replica): NextStep[] =>
  status === 401 || status === 403 ? serviceNext(status) : [[`mason user list --replica ${replicaText(r)}`, "the replica's users"]];

/** The request a subcommand is: the run's own `/api/users` request, under the replica's path. */
export function requestOf(r: Replica, o: { verb: Verb; name?: string | undefined; role?: string | undefined; sets: readonly string[] }): { method: "GET" | "POST" | "DELETE"; path: string; json?: unknown } {
  const base = `/v1/replicas/${r.org}/${r.name}/users`;
  // a user's name is USER_NAME_RE's (checked before this): letters, digits, `_`, `.` and `-`, safe in a path as it is
  switch (o.verb) {
    case "list": return { method: "GET", path: `${base}?lastUsed=1` };
    case "add": return { method: "POST", path: base, json: { name: o.name, ...(o.role !== undefined ? { role: o.role } : {}), ...(o.sets.length ? { set: [...o.sets] } : {}) } };
    case "disable": case "enable": return { method: "POST", path: `${base}/${o.name!}/${o.verb}` };
    case "remove": return { method: "DELETE", path: `${base}/${o.name!}` };
  }
}

// ------------------------------------------------------------------ the answers, held to the run's own shapes

/** A string the service sends, as one line: null when it is not a string. */
const line = (v: unknown, max: number, secrets: readonly string[]): string | null => typeof v === "string" ? serviceText(v, max, secrets) : null;

/** A user's role fields, each consistent with the others (src/cli/roles.ts userRole): a role for `file` and `default`,
 *  none for `none`, `readsNothing` only where there is none. */
function roleOf(u: Record<string, unknown>): { role?: string; roleFrom: RoleFrom; readsNothing?: true } | null {
  if (typeof u.roleFrom !== "string" || !(ROLE_FROM as readonly string[]).includes(u.roleFrom)) return null;
  const roleFrom = u.roleFrom as RoleFrom;
  if (u.role !== undefined && (typeof u.role !== "string" || !ROLE_NAME_RE.test(u.role))) return null;
  if ((roleFrom === "none") !== (u.role === undefined)) return null;
  if (u.readsNothing !== undefined && (u.readsNothing !== true || roleFrom !== "none")) return null;
  return { ...(typeof u.role === "string" ? { role: u.role } : {}), roleFrom, ...(u.readsNothing === true ? { readsNothing: true as const } : {}) };
}

/** A user's attributes: at most 64 names, each a value (one line, bounded) or a list of 1 to 100 of them. A value is a
 *  value (a tenant's id), put to the exact test with every string (`carriesNoSecret`), so it is made one line here
 *  without the quarter rule of free text, which a thousand random ids would trip by chance (PR 609's review). */
function attributesOf(v: unknown): Record<string, string | string[]> | null {
  if (!obj(v) || Object.keys(v).length > 64) return null;
  const outv: Record<string, string | string[]> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!ATTRIBUTE_NAME_RE.test(k)) return null;
    if (typeof x === "string") outv[k] = serviceText(x, 1000);
    else if (Array.isArray(x) && x.length >= 1 && x.length <= 100 && x.every((y) => typeof y === "string")) outv[k] = x.map((y: string) => serviceText(y, 1000));
    else return null;
  }
  return outv;
}

const names = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= 64 && v.every((x) => typeof x === "string" && ATTRIBUTE_NAME_RE.test(x));
const timeOrNull = (v: unknown): v is string | null => v === null || isServiceTime(v);

/** One row of a list, as `listUsers` makes it (src/cli/user.ts `UserRow`); null when it is not that shape. */
function rowOf(v: unknown): UserRow | null {
  if (!obj(v)) return null;
  const u = v;
  if (typeof u.name !== "string" || !USER_NAME_RE.test(u.name) || typeof u.id !== "string" || !ID.test(u.id) || !isServiceTime(u.addedAt)
    || !timeOrNull(u.removedAt) || !timeOrNull(u.disabledAt) || !timeOrNull(u.lastUsedAt) || typeof u.live !== "boolean") return null;
  // the URL a tool pastes, WITHOUT the password: its own name, then where the replica listens
  if (u.url !== null && !(typeof u.url === "string" && u.url.length <= 600 && u.url.startsWith(`postgres://${u.name}@`)
    && /^postgres:\/\/[a-z0-9_.-]+@(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}\/[A-Za-z0-9%._~!*'()-]+(?:\?sslmode=require)?$/.test(u.url))) return null;
  const role = roleOf(u);
  if (role === null) return null;
  const attributes = u.attributes === undefined ? undefined : attributesOf(u.attributes);
  if (attributes === null) return null;
  if (u.missingAttributes !== undefined && !names(u.missingAttributes)) return null;
  if (u.roleKnown !== undefined && (typeof u.roleKnown !== "boolean" || role.roleFrom !== "file")) return null;
  return { name: u.name, id: u.id, addedAt: u.addedAt, removedAt: u.removedAt, disabledAt: u.disabledAt, live: u.live, lastUsedAt: u.lastUsedAt,
    url: u.url as string | null, ...role, ...(attributes !== undefined ? { attributes } : {}),
    ...(u.missingAttributes !== undefined ? { missingAttributes: u.missingAttributes as string[] } : {}),
    ...(typeof u.roleKnown === "boolean" ? { roleKnown: u.roleKnown } : {}) } as UserRow;
}

/** `GET …/users?lastUsed=1`'s answer: mason user list --json's shape (its `next` never read); null when it is not it. */
export function heldList(json: unknown, secrets: readonly string[]): UserList | null {
  if (!obj(json) || !Array.isArray(json.users) || json.users.length > MAX_USERS || !carriesNoSecret(json, secrets)) return null;
  const users: UserRow[] = [];
  for (const v of json.users) { const u = rowOf(v); if (u === null) return null; users.push(u); }
  const note = (v: unknown): string | null | undefined => v === null ? null : line(v, 500, secrets) ?? undefined;
  const lastUsedNote = note(json.lastUsedNote), urlNote = note(json.urlNote);
  const days = json.requestLogDays;
  if (lastUsedNote === undefined || urlNote === undefined || !(days === null || (Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 36500))) return null;
  return { users, lastUsedNote, urlNote, requestLogDays: days as number | null };
}

/** `POST …/users`'s answer: mason user add --json's shape with Mason up — where it listens, the URL rebuilt here by the
 *  one builder and equal to the service's —, for the name asked; null when it is not it. */
export function heldAdded(json: unknown, asked: string, secrets: readonly string[]): Omit<AddedUser, "replaced"> | null {
  if (!obj(json) || !carriesNoSecret(json, secrets, ["password", "url", "psql"])) return null;
  const a = json;
  if (a.user !== asked || typeof a.id !== "string" || !ID.test(a.id) || !isServiceTime(a.addedAt)) return null;
  // the password is the user's, by its one grammar: its id, then its MAC
  if (typeof a.password !== "string" || !new RegExp(`^mason_${a.id}_[0-9a-f]{32}$`).test(a.password)) return null;
  if (typeof a.database !== "string" || databaseNameProblem(a.database) !== null || serviceText(a.database, 63) !== a.database) return null;
  if (typeof a.host !== "string" || !HOST.test(a.host) || !Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65535) return null;
  if (a.sslmode !== "require" && a.sslmode !== "disable") return null;
  const url = connectionUrl({ url: "", host: a.host, port: a.port as number, database: a.database, ...(a.sslmode === "require" ? { sslmode: "require" as const } : {}) }, asked, a.password);
  if (a.url !== url || a.psql !== psqlLine(url)) return null;
  const role = roleOf(a);
  if (role === null) return null;
  const attributes = a.attributes === undefined ? undefined : attributesOf(a.attributes);
  if (attributes === null) return null;
  return { user: asked, id: a.id, addedAt: a.addedAt, password: a.password, database: a.database, url, psql: psqlLine(url), host: a.host, port: a.port as number, sslmode: a.sslmode,
    ...role, ...(attributes !== undefined ? { attributes } : {}) };
}

/** A user as disable, enable and remove name it: the name asked, its id, when it was added, and `more` times. */
function userOf<K extends string>(v: unknown, asked: string, more: readonly K[]): ({ name: string; id: string; addedAt: string } & Record<K, string>) | null {
  if (!obj(v) || v.name !== asked || typeof v.id !== "string" || !ID.test(v.id) || !isServiceTime(v.addedAt) || !more.every((k) => isServiceTime(v[k]))) return null;
  return { name: asked, id: v.id, addedAt: v.addedAt, ...Object.fromEntries(more.map((k) => [k, v[k] as string])) } as { name: string; id: string; addedAt: string } & Record<K, string>;
}

export function heldDisabled(json: unknown, asked: string, secrets: readonly string[]): Disabled | null {
  if (!obj(json) || typeof json.already !== "boolean" || !carriesNoSecret(json, secrets)) return null;
  const d = userOf(json.disabled, asked, ["disabledAt"]);
  return d === null ? null : { disabled: d, already: json.already };
}
export function heldEnabled(json: unknown, asked: string, secrets: readonly string[]): Enabled | null {
  if (!obj(json) || typeof json.already !== "boolean" || !carriesNoSecret(json, secrets)) return null;
  const e = userOf(json.enabled, asked, []);
  return e === null ? null : { enabled: e, already: json.already };
}
export function heldRemoved(json: unknown, asked: string, secrets: readonly string[]): Removed | null {
  if (!obj(json) || !carriesNoSecret(json, secrets)) return null;
  const r = userOf(json.removed, asked, ["removedAt"]);
  return r === null ? null : { removed: r };
}

// ------------------------------------------------------------------ the command

/** What each subcommand asked, in the words of a failure outside the contract (`unexpected`). */
const STEP: Record<Verb, string> = { list: "the replica's users were asked for", add: "a user was added", disable: "a user was disabled", enable: "a user was enabled", remove: "a user was removed" };

/** `mason user <verb> … --replica <org>/<name>`: one request, its answer held and printed as the local command prints it. */
export async function hostedUser(r: Replica, o: { verb: Verb; name?: string | undefined; role?: string | undefined; sets: readonly string[]; json: boolean }): Promise<number> {
  const outStyle = serviceStyle(styleOut());
  const fail = (f: Failure): number => failed("user", f, { json: o.json, style: serviceStyle(styleErr()) });
  const service = serviceOf();
  if (isFailure(service)) return fail(service);
  const token = tokenFor(service, { asked: "a replica's users are asked for", again: `mason user ${o.verb}` });
  if (isFailure(token)) return fail(token);
  // from here every byte written is put to the exact test against the token (src/cli/output-gate.ts); add prints the
  // password it made, so a password's shape is its answer's there
  holdOutput({ command: "user", json: o.json, secrets: [token], passwords: o.verb !== "add" });
  const secrets = [token];
  const req = requestOf(r, o);
  const a = await call(service, req.method, req.path, { token, ...(req.json !== undefined ? { json: req.json } : {}), ...(o.verb === "list" ? { maxBytes: MAX_LIST_BYTES } : {}) });
  if (isFailure(a)) return fail(a);
  const refused = (x: Answer): Failure => serviceFailure(x, secrets, (status) => failureNext(status, r)) ?? unexpected(service, x, STEP[o.verb]);
  if (a.status !== 200) return fail(refused(a));
  const outside = (): number => fail(unexpected(service, a, STEP[o.verb]));
  // the target in every answer: the replica's name in --json and in the headline
  const on = replicaText(r);
  const print = (value: Record<string, unknown>, next: NextStep[], text: () => string): number => {
    out(o.json ? jsonText(USER, { replica: on, ...value }, next) : text());
    return 0;
  };
  switch (o.verb) {
    case "list": {
      const l = heldList(a.json, secrets);
      if (l === null) return outside();
      const next = onReplica(listNext(l.users), r);
      return print({ ...l }, next, () => listText(on, l, NO_ROLES, next, outStyle));
    }
    case "add": {
      const added = heldAdded(a.json, o.name!, secrets);
      // the service answered 200: the replica may have made the user, whose password nobody has now been shown
      if (added === null) {
        const f = unexpected(service, a, STEP[o.verb]);
        return fail({ ...f, why: `${f.why}; the replica may have added ${o.name!} all the same, and its password was not shown`,
          fix: `mason user list --replica ${replicaText(r)} says whether it did; if so, mason user remove ${o.name!} --replica ${replicaText(r)}, then add it again`,
          next: [[`mason user list --replica ${replicaText(r)}`, "the replica's users"]] });
      }
      const next = onReplica(addedNext(added.user, true), r);
      return print({ ...added }, next, () => addedReport(added, { roles: NO_ROLES, listener: null, next, on }, outStyle));
    }
    case "disable": {
      const d = heldDisabled(a.json, o.name!, secrets);
      if (d === null) return outside();
      const next = onReplica(disabledNext(d.disabled.name), r);
      return print({ ...d }, next, () => disabledReport(d, true, next, outStyle, on));
    }
    case "enable": {
      const e = heldEnabled(a.json, o.name!, secrets);
      if (e === null) return outside();
      const next = onReplica(enabledNext(e.enabled.name), r);
      return print({ ...e }, next, () => enabledReport(e, next, outStyle, on));
    }
    case "remove": {
      const x = heldRemoved(a.json, o.name!, secrets);
      if (x === null) return outside();
      const next = onReplica(REMOVED_NEXT, r);
      return print({ removedUser: x.removed, ...x }, next, () => removedReport(x, true, next, outStyle, on));
    }
  }
}
