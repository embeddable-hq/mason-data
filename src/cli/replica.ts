/**
 * A REPLICA ON A HOSTED MASON SERVICE, AND THE LOGIN IT IS ASKED WITH: the one reader of each, for every command that
 * speaks to a replica (`mason deploy`, `mason user … --replica`; docs/HOSTED-API.md).
 *
 *   - THE REPLICA is `--replica <org>/<name>`, else `MASON_REPLICA`, each part `REPLICA_PART`: checked before a byte is
 *     sent, so a name is always safe in a path.
 *   - THE TOKEN is `MASON_TOKEN`, else the saved login for the service (src/cli/credentials.ts): never on a command line,
 *     never printed, masked in everything printed from the service (src/cli/hosted.ts `serviceText`).
 */
import type { Failure } from "./command.ts";
import { environmentToken, readLogins, TOKEN_ENV } from "./credentials.ts";
import { isFailure, serviceText, type Service } from "./hosted.ts";

/** What one part of a replica's name may be: an organisation's slug, a replica's name. */
export const REPLICA_PART = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const REPLICA_ENV = "MASON_REPLICA";

/** A replica: its organisation and its name, and where it was named. */
export interface Replica { org: string; name: string; from: "--replica" | typeof REPLICA_ENV }
export const replicaText = (r: Replica): string => `${r.org}/${r.name}`;

/** The replica the command means: `--replica`, else `MASON_REPLICA`; null when neither names one, a Failure when it is
 *  not `<org>/<name>` (never repeated beyond 200 characters, made printable). `usage`: the command's, said after a wrong
 *  `--replica`. */
export function replicaOf(flag: string | undefined, usage: string, env: NodeJS.ProcessEnv = process.env): Replica | Failure | null {
  const from = flag !== undefined ? "--replica" : env[REPLICA_ENV] !== undefined ? REPLICA_ENV : null;
  if (from === null) return null;
  const raw = (from === "--replica" ? flag : env[REPLICA_ENV]) ?? "";
  const parts = raw.split("/");
  if (parts.length === 2 && REPLICA_PART.test(parts[0]!) && REPLICA_PART.test(parts[1]!)) return { org: parts[0]!, name: parts[1]!, from };
  return { message: `${from} ${JSON.stringify(serviceText(raw, 200))} is not <org>/<name>`, code: from === "--replica" ? "usage" : "refused",
    why: "an organisation's slug and a replica's name, each 1 to 63 lower case letters, digits and -, starting with a letter or digit",
    fix: from === "--replica" ? "name it as the service lists it: --replica acme/shop" : `set ${REPLICA_ENV}=<org>/<name> (acme/shop), or unset it and pass --replica`,
    ...(from === "--replica" ? { usage } : {}) };
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
