/**
 * A REPLICA ON A HOSTED MASON SERVICE, AND THE LOGIN IT IS ASKED WITH: the one reader of each, for every command that
 * speaks to a replica (`mason deploy`, `mason user … --replica`; docs/HOSTED-API.md).
 *
 *   - THE REPLICA is `--replica <org>/<name>`, else `MASON_REPLICA`, each part `REPLICA_PART`: checked before a byte is
 *     sent, so a name is always safe in a path.
 *   - THE TOKEN is `MASON_TOKEN`, else the saved login for the service (src/cli/credentials.ts): never on a command line,
 *     never printed, masked in everything printed from the service (src/cli/hosted.ts `serviceText`).
 */
import type { Failure, NextStep } from "./command.ts";
import { environmentToken, readLogins, TOKEN_ENV } from "./credentials.ts";
import { isFailure, serviceText, whoAmI, type Service } from "./hosted.ts";

/** What one part of a replica's name may be: an organisation's slug, a replica's name. */
export const REPLICA_PART = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const REPLICA_ENV = "MASON_REPLICA";

/** A replica: its organisation and its name, and where it was named (`argument`: the command's own, `mason replica
 *  status acme/shop`). */
export interface Replica { org: string; name: string; from: "--replica" | typeof REPLICA_ENV | "argument" }
export const replicaText = (r: Replica): string => `${r.org}/${r.name}`;

/**
 * THE REPLICA THE COMMAND MEANS, ONE RESOLVER FOR EVERY COMMAND THAT NAMES ONE (`mason deploy`, `mason user …
 * --replica`, `mason token create`, `mason replica create | status`): the command's own argument where it takes one
 * (`mason replica status acme/shop`), else `--replica`, else `MASON_REPLICA`; null when none names one, a Failure when
 * it is not `<org>/<name>` (never repeated beyond 200 characters, made printable), or when the argument and `--replica`
 * name two replicas. `usage`: the command's, said after a wrong line.
 *
 * WHEN THE ENVIRONMENT CHOSE THE TARGET IT IS SAID, on stderr (`say`): an agent inherits an environment it may never
 * read, and `MASON_REPLICA` exported turns `mason user add` from this project's users to a replica's.
 */
export function replicaOf(flag: string | undefined, usage: string, env: NodeJS.ProcessEnv = process.env,
  o: { argument?: string | undefined; say?: (line: string) => void } = {}): Replica | Failure | null {
  if (o.argument !== undefined) {
    const r = replicaNamed(o.argument, "argument", usage);
    if (flag === undefined || "message" in r) return r;
    const f = replicaNamed(flag, "--replica", usage);
    if ("message" in f) return f;
    if (replicaText(f) === replicaText(r)) return r;
    return { message: `the replica is named twice: ${replicaText(r)} and --replica ${replicaText(f)}`, code: "usage", fix: `name one: ${replicaText(r)}, or --replica ${replicaText(f)}`, usage };
  }
  const from = flag !== undefined ? "--replica" : env[REPLICA_ENV] !== undefined ? REPLICA_ENV : null;
  if (from === null) return null;
  const r = replicaNamed((from === "--replica" ? flag : env[REPLICA_ENV]) ?? "", from, usage);
  if (!("message" in r) && r.from === REPLICA_ENV) (o.say ?? sayStderr)(envChoseText(r));
  return r;
}

/** What is said on stderr when `MASON_REPLICA` chose the replica (a name `REPLICA_PART` holds: safe to print). */
export const envChoseText = (r: Replica): string => `using ${REPLICA_ENV}=${replicaText(r)} (--replica names another; unset ${REPLICA_ENV} for none)`;
const sayStderr = (line: string): void => { process.stderr.write(`${line}\n`); };

/** The organisation the command means: its own argument (`mason replica list acme`), else `--org`; null when neither
 *  names one, a wrong line's Failure when one is not a slug or the two differ. */
export function orgOf(flag: string | undefined, argument: string | undefined, usage: string): string | Failure | null {
  const named = [argument, flag].filter((x): x is string => x !== undefined).map((x) => orgNamed(x, usage));
  const bad = named.find((x): x is Failure => typeof x !== "string");
  if (bad !== undefined) return bad;
  const [a, b] = named as string[];
  if (a === undefined) return null;
  if (b !== undefined && a !== b) return { message: `the organisation is named twice: ${a} and --org ${b}`, code: "usage", fix: `name one: ${a}, or --org ${b}`, usage };
  return a;
}

/** `raw` as a replica's name, `<org>/<name>`, each part `REPLICA_PART`: the one grammar of `--replica`, `MASON_REPLICA`
 *  and a command's own argument (`mason replica status <org>/<name>`); a Failure otherwise, a wrong line's (`usage`)
 *  unless the environment named it. */
export function replicaNamed(raw: string, from: Replica["from"], usage: string): Replica | Failure {
  const parts = raw.split("/");
  if (parts.length === 2 && REPLICA_PART.test(parts[0]!) && REPLICA_PART.test(parts[1]!)) return { org: parts[0]!, name: parts[1]!, from };
  const named = from === "argument" ? "the replica" : from;
  return { message: `${named} ${JSON.stringify(serviceText(raw, 200))} is not <org>/<name>`, code: from === REPLICA_ENV ? "refused" : "usage",
    why: "an organisation's slug and a replica's name, each 1 to 63 lower case letters, digits and -, starting with a letter or digit",
    fix: from === "--replica" ? "name it as the service lists it: --replica acme/shop" : from === "argument" ? "name it as the service lists it: acme/shop (mason replica list)"
      : `set ${REPLICA_ENV}=<org>/<name> (acme/shop), or unset it and pass --replica`,
    ...(from === REPLICA_ENV ? {} : { usage }) };
}

/** `raw` as an organisation's slug (`REPLICA_PART`: safe in a path as it is), or a wrong line's Failure. */
export function orgNamed(raw: string, usage: string): string | Failure {
  if (REPLICA_PART.test(raw)) return raw;
  return { message: `the organisation ${JSON.stringify(serviceText(raw, 200))} is not an organisation's slug`, code: "usage",
    why: "an organisation's slug is 1 to 63 lower case letters, digits and -, starting with a letter or digit", fix: "name it as the service lists it: acme", usage };
}

/** How many organisations a command reads when none is named (`loginOrgs`): past it, it asks for one. */
export const MAX_ORGS = 20;

/**
 * THE ORGANISATIONS A COMMAND ACTS IN WHEN NONE IS NAMED: the login's own, as `GET /v1/me` says them (src/cli/hosted.ts
 * `whoAmI`, its answer held there), those where its role is one of `roles` (every role when absent), each slug held to
 * `REPLICA_PART` before it is in a path. A Failure when the service cannot say (a CI token is no person: 403), when a
 * slug is outside the grammar, or past `MAX_ORGS`; `again` is the command that names one.
 */
export async function loginOrgs(service: Service, token: string, again: string, roles?: readonly string[]): Promise<Array<{ slug: string; role: string }> | Failure> {
  const me = await whoAmI(service, token);
  const name: NextStep = [again, "name the organisation"];
  if (isFailure(me)) return { ...me, next: [name, ...(me.next ?? [])] };
  if (!me.orgs.every((o) => REPLICA_PART.test(o.slug))) return { message: `${service.base} named an organisation whose slug is not one`, code: "failed",
    why: "a slug is 1 to 63 lower case letters, digits and -: the answer is not the one docs/HOSTED-API.md documents", fix: `name the organisation: ${again}`, next: [name] };
  const orgs = me.orgs.filter((o) => roles === undefined || roles.includes(o.role)).map((o) => ({ slug: o.slug, role: o.role }));
  if (orgs.length > MAX_ORGS) return { message: `this login is in ${orgs.length} organisations, more than the ${MAX_ORGS} a command reads when none is named`, code: "refused",
    fix: `name the organisation: ${again}`, next: [name] };
  return orgs;
}

/**
 * The token a request to a replica is sent with: MASON_TOKEN, else this machine's login to the service; a Failure naming
 * mason login. `asked`: what the command sends, in its words ("a deploy is sent"); `again`: the command to run once
 * signed in ("mason deploy").
 */
export function tokenFor(service: Service, o: { asked: string; again: string }): string | Failure {
  const env = environmentToken();
  if (env !== null) return env;
  const read = readLogins();
  if (isFailure(read)) return read;
  const saved = read.logins.logins[service.base];
  if (saved !== undefined) return saved.token;
  return { message: `this machine is not signed in to ${service.base}`, code: "refused", why: `${o.asked} as a person signed in (mason login), or with a token in ${TOKEN_ENV} (CI)`,
    fix: `run mason login, then ${o.again} again; in CI, set ${TOKEN_ENV} to a CI token`, next: [["mason login", `sign this machine in to ${service.base}`]] };
}
