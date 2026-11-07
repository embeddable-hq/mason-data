/**
 * `mason replica create | list | status | delete` — A HOSTED MASON SERVICE'S REPLICAS, by its documented API alone
 * (docs/HOSTED-API.md "Replicas"). Each is a client of it, as `mason deploy` and `mason user --replica` are:
 *
 *   create <org>/<name>   POST /v1/replicas/{org}  { name, region, sizeGb, sources: [{ name, variable, url }] }
 *                         201 { replica, checks }, then GET …/{name} until it is ready, failed or past --timeout
 *   list [<org>]          GET  /v1/replicas/{org}  { replicas, more } — each organisation of the login's when none is named
 *   status <org>/<name>   GET  /v1/replicas/{org}/{name}  { replica } (with its deletion, while it is deleted)
 *   delete <org>/<name>   DELETE /v1/replicas/{org}/{name}  { confirm: "<org>/<name>" }  202 (or 200, done already)
 *                         { replica }, then GET …/{name} until its deletion is finished, needs a person (a slot not
 *                         verified gone: it stops at once, exit 1) or is past --timeout
 *
 * A DELETION'S SQL IS MASON'S OWN (docs/HOSTED-API.md, `DELETE /v1/replicas/{org}/{name}` and `DeletionSource`): for a source whose replication slot was not
 * verified gone, the statement a person runs by hand is rendered here, by `dropStatements` (src/cli/replication-mode.ts,
 * the one authority), from the slot's and the publication's names the service gives, each held to Postgres's name
 * grammar (`PG_NAME`); a name it does not know is `listSlotsStatement`'s query. The service's own `byHand` is advisory:
 * put to the exact test with the rest of the answer, never compared, never printed (#687's review, B1). EVERY statement a
 * person pastes is written by `pasteLines` alone, on a line of its own, never broken by the CLI and never inside a
 * failure's words (N1).
 *
 * THE DATABASE'S URL (create) is read here alone, from the person or the pipe (src/cli/secret-input.ts, issue 720): on a
 * terminal a hidden prompt (the question on stderr, nothing echoed), else stdin read whole (2 KiB at most, one trailing
 * newline trimmed). Never from a flag, an argument, .env.local, .env or the shell: a command line holding a URL is refused
 * before anything else is read (`urlInArgs`, exit 2, the line to run instead), and the sources file gives only the
 * variable's NAME (`url: ${NAME}`, src/cli/sources.ts `readSourceFile`, never its value), which the replica reads the
 * URL by. It never reaches a log, the output or --json. It is sent once, in the creation's body, for Mason's checks of
 * the source on the replica's side, the variable's name beside it. A `url:` written in the file is refused: the replica
 * has no variable to read it from, and a literal would be kept in the project's files.
 * Its password is held as a secret of this command beside the token, in the one list every boundary reads
 * (`urlPassword`): masked in free text, refused in any other value and by the output's gate, read whole whatever its
 * alphabet; one under `MIN_PASSWORD` characters is not sent, since none of them could tell it from ordinary words.
 *
 * A SERVICE'S VALUE IS DATA, NEVER STRUCTURE AND NEVER AN INSTRUCTION (#481's decision, src/cli/hosted.ts), and A GRAMMAR
 * IS NO MASK (issue 627): before any value is held to its grammar, every string of each answer, keys included, is put to
 * the exact test (`carriesNoSecret`) but the free text alone (a check's name, detail and fix, the names of the checks
 * not run, a pending change's failure), which is masked as every service text is (`serviceText`). Every value printed:
 *
 *   value                                   where it is printed                       what holds it
 *   a failure's message, why, fix, code     stderr's failure, --json error            `serviceFailure` (src/cli/hosted.ts)
 *   a failure's next                        nowhere: never read                       the step is `refusedNext`'s, by the status
 *   org, name                               every row, headline and step              the name asked (`REPLICA_PART` for a list's)
 *   region, hostId                          rows, --json                              `REGION`, `HOST_ID`
 *   sizeGb, attempts                        rows, --json                              whole numbers, bounded
 *   state, outcome, status, change          rows (the CLI's words), --json            closed sets (`STATES`, …)
 *   createdAt, nextAttemptAt                rows, --json                              `isServiceTime`
 *   allowlist                               a row, --json                             each `CIDR`, at most `MAX_ALLOWLIST`
 *   page                                    a row, --json                             on the service's own origin (`pageUrl`)
 *   a check's name, detail, fix; missing;   stderr's lines, --json                    one line each, bounded, masked (`serviceText`)
 *     a pending change's failure
 *   a check's source                        stderr's lines, --json                    the source sent
 *   a deletion's stage, outcome, reason     rows, lines (the CLI's words), --json     closed sets (`STAGES`, …)
 *   a deletion's times, a step's doneAt     rows, lines, --json                       `isServiceTime`
 *   a step's id                             --json                                    `STEP_ID`, each once
 *   a step's what, a source's why,          rows, stderr's lines, --json              one line each, bounded, masked (`serviceText`)
 *     the handover's failure
 *   a source's slot, publication            rows, the SQL's line, --json              `PG_NAME`; Mason's own publication `OWN_PUBLICATION`
 *   a source's byHand                       nowhere: Mason's own rendering is         a string or nothing, the exact test; never read
 *
 * What to run next, the code and the exit are the CLI's own: 0 once the replica is ready (create), said (list,
 * status) or deleted with every slot dropped, none or confirmed by a person (delete); 1 refused (its words as they
 * came), not made, failed, a deletion that needs a person (its SQL printed) or an answer outside the contract; 2 a wrong line; 124 the wait timed out
 * (nothing stopped: `mason replica status` says how it goes).
 */
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { endText, errorJson, exitOf, failed, failureText, jsonText, parseCommand, reportText, serviceStyle, strict, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { parseArgs } from "node:util";
import { call, canonicalSecret, carriesNoSecret, isFailure, isServiceTime, pageUrl, serviceFailure, serviceOf, serviceText, unexpected, type Answer, type Service } from "./hosted.ts";
import { loginOrgs, orgOf, REPLICA_ENV, REPLICA_PART, replicaOf, replicaText, tokenFor, type Replica } from "./replica.ts";
import { holdOutput, readingsCarry, readingsOf, type Written } from "./output-gate.ts";
import { theProject } from "./project.ts";
import { readSourceFile, shownPath } from "./sources.ts";
import { readHidden, readPiped, type SecretInput, type SecretRead } from "./secret-input.ts";
import { parseSource } from "./preflight.ts";
import { MAX_POLL_SECONDS, MIN_POLL_SECONDS, parseDuration } from "../lib/table-sync.ts";
import { sayAgain } from "./commands.ts";
import { version } from "./version.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { dropStatements, listSlotsStatement } from "./replication-mode.ts";
import { err as styleErr, out as styleOut, PLAIN, type Style } from "./style.ts";

/** How long the creation's POST may take: the service answers once Mason's checks of the source are done. */
export const CREATE_MS = 60_000;
/** How often a creation's state is asked for while its region makes it, when the service asks no other. */
export const REPLICA_POLL_MS = 5_000;
const DEFAULT_TIMEOUT = "15m";
/** A list's answer (a row a replica) is read up to this; every other answer is `call`'s own 64 KiB. */
export const MAX_LIST_BYTES = 1024 * 1024;
const MAX_REPLICAS = 1000;
const MAX_ALLOWLIST = 1000;
const MAX_PENDING = 16;
const MAX_CHECKS = 200;
/** A region's name and a host id: lower case letters, digits and `-`, as a replica's name is. */
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** An address range of an allowlist: IPv4 or IPv6, with its prefix length. */
const CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-fA-F:.]{2,45}\/\d{1,3})$/;
const SIZE = /^[1-9]\d{0,5}$/;

export const STATES = ["checking", "creating", "ready", "failed", "deleting", "deleted"] as const;
export type ReplicaState = typeof STATES[number];
const OUTCOMES = ["passed", "failed", "unknown"] as const;
const CHECK_STATUSES = ["ok", "warn", "failed", "unknown"] as const;

/** A replica as the service says it, every value held. */
export interface HostedReplica {
  org: string; name: string; region: string; sizeGb: number; hostId: string; state: ReplicaState; createdAt: string; allowlist: string[];
  /** its page in the service's web app, where its allowlist is set: on the service's own origin; null when none is named */
  page: string | null;
  pending: Array<{ change: "create" | "allowlist"; state: "pending" | "failed"; attempts: number; failure: string | null; nextAttemptAt: string | null }>;
}
/** Mason's checks of one source, as the service says them, every word one line. */
export interface SourceChecks {
  source: string; outcome: typeof OUTCOMES[number];
  checks: Array<{ name: string; status: typeof CHECK_STATUSES[number]; detail: string; fix: string | null }>; missing: string[];
}

export const REPLICA: CommandSpec = {
  name: "replica",
  summary: "a hosted Mason service's replicas: create one for this project's database, list them, say how one is, delete one",
  usage: `usage: mason replica create <org>/<name> --region <region> --size <gb> [--timeout <duration>] [--json] [< url]
       mason replica list [<org> | --org <org>] [--json]
       mason replica status <org>/<name> | --replica <org>/<name> [--json]
       mason replica delete <org>/<name> | --replica <org>/<name> [--yes] [--timeout <duration>] [--json]

  The replica can also be named as every other command names one, --replica <org>/<name> (else MASON_REPLICA, said
  on stderr when it chose): mason replica status --replica acme/shop. The organisation, as --org: mason replica
  list --org acme.

  A replica is Mason run for you by a hosted Mason service, on a machine of its own, syncing this project's
  database. mason deploy then sends it the project's files, and mason token create a CI token for it.

  create makes one in the organisation <org>, named <name>, in --region (one the service offers), sized by
  --size: the synced data it holds, in GB (one size the service offers, such as 50). The database's URL is
  asked for: on a terminal, create asks for it on stderr and reads it without showing it (Enter on an empty
  line, or Ctrl-C, cancels before anything is sent); otherwise it reads it from stdin, whole (at most 2 KiB,
  one trailing newline trimmed): mason replica create acme/shop --region <region> --size 50 < url.txt, or
  piped from a secret store's command. It is never taken from a flag, an argument, .env or the shell: a
  command line holding a URL is refused (exit 2). It is sent once to the service for Mason's checks of the
  source, never printed and never in --json. The sources file names the variable the replica reads it by
  (url: \${DATABASE_URL}); a url: written in the file is refused. A URL whose password is under 8
  characters, or is in the words this command prints itself, is refused too, before anything is sent: nothing
  could keep it out of what is printed.
  create waits until the service has run Mason's checks of the database (up to a minute) and says each check,
  one line each, as the service words them; then until its region has made the replica (--timeout bounds that wait; the replica is made all the same),
  and prints its page in the service's web app, where its allowlist (the addresses that may query it) is set.
  An admin or an owner of the organisation creates one. An account's FIRST replica is made in the service's web
  app, where it asks a check that a person is creating it, which a command cannot answer: the service refuses it
  here, and the replicas after it can be made here.

  list says the replicas of <org>, or of every organisation of this login when none is named (a CI token names
  one); status says one replica: its state (checking, creating, ready, failed, deleting, deleted), its region and
  size, its host, its allowlist (the addresses that may query it), what of its region's work is not done, and,
  while it is deleted, its deletion as delete says it.

  delete deletes one, for good: the replica and its synced data go, and Mason's replication slot on its
  database is dropped. At a terminal it asks for <org>/<name> to be typed back; elsewhere (and with --json) it
  needs --yes. An owner of the organisation deletes one, signed in as a person within the last 15 minutes (mason
  login; a CI token deletes none). It waits until the deletion is finished (--timeout bounds that wait; it goes
  on all the same), saying each step as the service words it, then what it did to each database's replication
  slot: dropped and verified gone, none there, or confirmed by a person. A slot NOT verified gone stops the wait
  at once: the service keeps the replica until the slot is seen gone or a person confirms it was dropped, so
  delete prints why and the statement to run on that database by hand, and exits 1; run it, then confirm on
  the replica's page in the service's web app. That statement is Mason's own, rendered from the slot's name the
  service gives; whatever statement the service sends beside it is never printed. A replica deleted another
  way (as from the web app) may be said only as being deleted, when the service says no more of it.

  The login is MASON_TOKEN, else this machine's (mason login); the service is MASON_CLOUD_URL, else the default.
  Progress goes to stderr; the answer is printed when it ends.

    mason replica create acme/shop --region <region> --size 50
    my-secret-store read app-db-url | mason replica create --replica acme/shop --region <region> --size 50 --json
    mason replica list
    mason replica status acme/shop --json
    mason replica delete acme/shop

  --replica <org>/<name>   create, status: the replica, in place of the argument (else MASON_REPLICA)
  --org <org>              list: the organisation, in place of the argument
  --region <region>        create: the region it runs in, one the service offers
  --size <gb>              create: the synced data it holds, in GB, one size the service offers (50)
  --timeout <duration>     create: how long to wait for its region to make it; delete: for its deletion to finish
                           or to need a person (default ${DEFAULT_TIMEOUT}; 1s to 24h; a bare number is seconds)
  --yes                    delete: delete it without asking for its name to be typed back (CI, a coding agent)
  --json                   as data, once it ends: { replica (create, status, delete: { org, name, region, sizeGb,
                           hostId, state, createdAt, allowlist, page (its page, null when the service names none),
                           pending: [{ change (create, allowlist), state (pending, failed), attempts, failure,
                           nextAttemptAt }] }), deletion (status, delete: null while it is in none, or when the
                           service gave none; { stage (requested, in_region, needs_person, finished),
                           requestedAt, handover: { attempts, failure, nextAttemptAt } or null, lastHeardAt,
                           finishedAt, steps: [{ step, what, doneAt }], sources: [{ ordinal, outcome (dropped,
                           no_slot, not_verified, confirmed), reason (not_verified: unreachable, refused, in_use,
                           still_there, another_server, record_unreadable, failed, unprobed), why, slot,
                           publication, publicationOwned, byHand (not_verified: Mason's statement to run by
                           hand), reportedAt }] }), checks (create: [{ source, outcome (passed, failed,
                           unknown), checks: [{ name, status (ok, warn, failed, unknown), detail, fix }],
                           missing }], null when the service's answer was lost), replicas (list: each as replica
                           is), more (list: true when an organisation has more than the service lists), error
                           (create, delete: when it was not made, failed, needs a person, was refused or the
                           wait timed out: { code, message, why, fix }), next }

  Exit status: 0 the replica is ready (create), said (list, status), or deleted, every replication slot dropped,
  none there or confirmed by a person (delete); 1 not signed in, the URL not given (cancelled, stdin empty, more
  than one line or past 2 KiB: nothing sent), refused by the service (its words printed as they came, the code
  the CLI's own), not made (the checks failed: each is said), its region could not make it, its deletion needs a
  person (a slot NOT verified gone: the statement to run is printed, and the replica is kept until it is
  confirmed), or the service answered outside its contract; 2 a wrong command line (delete without a terminal
  and without --yes); 124 the wait timed out (nothing stopped: mason replica status says how it goes). Whatever
  the service sends, it never makes the exit 0, 2 or 124.
`,
  options: { replica: { type: "string" }, org: { type: "string" }, region: { type: "string" }, size: { type: "string" }, timeout: { type: "string" },
    yes: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
  json: ["replica", "deletion", "checks", "replicas", "more", "error", "next"],
};

/** Everything this command prints can hold the service's text, so it is all drawn in serviceStyle (src/cli/command.ts). */
const outStyle = (): Style => serviceStyle(styleOut());
const errStyle = (): Style => serviceStyle(styleErr());
const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const say = (m: string): void => { process.stderr.write(`${strict(m, errStyle())}\n`); };
const fail = (f: Failure, json: boolean): number => failed("replica", f, { json, style: errStyle() });
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, least: number, most: number): v is number => Number.isInteger(v) && (v as number) >= least && (v as number) <= most;

// ------------------------------------------------------------------ the answers, held

/**
 * AN ANSWER WITHOUT ITS FREE TEXT: what is put to the exact test (`carriesNoSecret`) — every string but a check's
 * name, detail and fix, the names of the checks not run, and a pending change's failure, which are words the service
 * says (masked as a failure's words are, `serviceText`). Keys are kept, so each is tested.
 */
export function wordless(json: unknown): unknown {
  if (!obj(json)) return json;
  // a deletion's words: each step's what, each source's why, the handover's failure (its byHand is no free text: tested,
  // then never read)
  const deletion = (d: unknown): unknown => !obj(d) ? d : { ...d,
    ...(obj(d.handover) ? { handover: { ...d.handover, failure: null } } : {}),
    ...(Array.isArray(d.steps) ? { steps: d.steps.map((x: unknown) => obj(x) ? { ...x, what: null } : x) } : {}),
    ...(Array.isArray(d.sources) ? { sources: d.sources.map((x: unknown) => obj(x) ? { ...x, why: null } : x) } : {}) };
  const replica = (r: unknown): unknown => !obj(r) ? r : { ...r,
    ...(Array.isArray(r.pending) ? { pending: r.pending.map((p: unknown) => obj(p) ? { ...p, failure: null } : p) } : {}),
    ...("deletion" in r ? { deletion: deletion(r.deletion) } : {}) };
  const checks = (c: unknown): unknown => !obj(c) ? c : { ...c,
    ...(Array.isArray(c.missing) ? { missing: c.missing.map(() => null) } : {}),
    ...(Array.isArray(c.checks) ? { checks: c.checks.map((x: unknown) => obj(x) ? { ...x, name: null, detail: null, fix: null } : x) } : {}) };
  return { ...json, ...("replica" in json ? { replica: replica(json.replica) } : {}),
    ...(Array.isArray(json.replicas) ? { replicas: json.replicas.map(replica) } : {}),
    ...(Array.isArray(json.checks) ? { checks: json.checks.map(checks) } : {}) };
}

/** Free text of the service's, as it is printed: one line, bounded, masked; null when it is not a string. */
const words = (v: unknown, max: number, secrets: readonly string[]): string | null => typeof v === "string" ? serviceText(v, max, secrets) : null;

/**
 * A REPLICA, held to the contract: of the organisation asked (and the name asked, for one replica), every value to its
 * grammar; null when any does not hold. The answer around it has been put to the exact test (`wordless`). Its page, when
 * named, is on `service`'s own origin (`pageUrl`: tested as it is printed); one elsewhere, or with no service to hold it
 * to, does not hold.
 */
export function heldReplica(v: unknown, asked: { org: string; name?: string }, secrets: readonly string[], service?: Service): HostedReplica | null {
  if (!obj(v) || v.org !== asked.org || typeof v.name !== "string" || !REPLICA_PART.test(v.name) || (asked.name !== undefined && v.name !== asked.name)) return null;
  if (typeof v.region !== "string" || !REGION.test(v.region) || !whole(v.sizeGb, 1, 1_000_000) || typeof v.hostId !== "string" || !HOST_ID.test(v.hostId)) return null;
  if (typeof v.state !== "string" || !(STATES as readonly string[]).includes(v.state) || !isServiceTime(v.createdAt)) return null;
  if (!Array.isArray(v.allowlist) || v.allowlist.length > MAX_ALLOWLIST || !v.allowlist.every((c) => typeof c === "string" && CIDR.test(c))) return null;
  if (!Array.isArray(v.pending) || v.pending.length > MAX_PENDING) return null;
  let page: string | null = null;
  if (v.page !== undefined && v.page !== null) {
    const held = service === undefined ? null : pageUrl(service, v.page, secrets);
    if (held === null || !("href" in held)) return null;
    page = held.href;
  }
  const pending: HostedReplica["pending"] = [];
  for (const p of v.pending) {
    if (!obj(p) || (p.change !== "create" && p.change !== "allowlist") || (p.state !== "pending" && p.state !== "failed") || !whole(p.attempts, 0, 1_000_000)) return null;
    if (p.failure !== undefined && p.failure !== null && typeof p.failure !== "string") return null;
    if (p.nextAttemptAt !== undefined && p.nextAttemptAt !== null && !isServiceTime(p.nextAttemptAt)) return null;
    pending.push({ change: p.change, state: p.state, attempts: p.attempts as number, failure: words(p.failure, 500, secrets),
      nextAttemptAt: typeof p.nextAttemptAt === "string" ? p.nextAttemptAt : null });
  }
  return { org: v.org, name: v.name, region: v.region, sizeGb: v.sizeGb as number, hostId: v.hostId, state: v.state as ReplicaState,
    createdAt: v.createdAt as string, allowlist: [...v.allowlist as string[]], page, pending };
}

/** Mason's checks, held: one entry at most, for the source sent, each check's status and the outcome closed sets, every
 *  word one line; null when they do not hold. */
export function heldChecks(v: unknown, source: string, secrets: readonly string[]): SourceChecks[] | null {
  if (!Array.isArray(v) || v.length > 1) return null;
  const held: SourceChecks[] = [];
  for (const s of v) {
    if (!obj(s) || s.source !== source || typeof s.outcome !== "string" || !(OUTCOMES as readonly string[]).includes(s.outcome)) return null;
    if (!Array.isArray(s.checks) || s.checks.length > MAX_CHECKS || !Array.isArray(s.missing) || s.missing.length > MAX_CHECKS) return null;
    const checks: SourceChecks["checks"] = [];
    for (const c of s.checks) {
      if (!obj(c) || typeof c.name !== "string" || typeof c.detail !== "string" || typeof c.status !== "string" || !(CHECK_STATUSES as readonly string[]).includes(c.status)) return null;
      if (c.fix !== undefined && c.fix !== null && typeof c.fix !== "string") return null;
      checks.push({ name: words(c.name, 200, secrets)!, status: c.status as SourceChecks["checks"][number]["status"], detail: words(c.detail, 2000, secrets)!, fix: words(c.fix, 2000, secrets) });
    }
    if (!s.missing.every((m) => typeof m === "string")) return null;
    held.push({ source, outcome: s.outcome as SourceChecks["outcome"], checks, missing: (s.missing as string[]).map((m) => words(m, 200, secrets)!) });
  }
  return held;
}

// ------------------------------------------------------------------ a deletion, held

/**
 * A deletion's stages: asked for and not handed over yet, under way (nobody may query it), NEEDS A PERSON (a slot is not
 * verified gone: the service keeps the replica until it is seen gone or a person confirms it, and the CLI stops waiting
 * at once), finished (the tombstone: every slot dropped, none there, or confirmed by a person).
 */
export const STAGES = ["requested", "in_region", "needs_person", "finished"] as const;
type Stage = typeof STAGES[number];
/** What a deletion did to Mason's replication slot on a source's database: `confirmed` is a slot not verified gone that a
 *  person said they dropped by hand, or whose database is no more (never seen gone by the service). */
export const SOURCE_OUTCOMES = ["dropped", "no_slot", "not_verified", "confirmed"] as const;
/** Why a slot was not verified gone. */
export const REASONS = ["unreachable", "refused", "in_use", "still_there", "another_server", "record_unreadable", "failed", "unprobed"] as const;
type Reason = typeof REASONS[number];
/** A step's id: lower case letters, digits and `_` (never printed for a person: its `what` is). */
const STEP_ID = /^[a-z0-9_]{1,64}$/;
/** A replication slot's or a publication's name as Postgres takes one unquoted in the statements a person runs: lower
 *  case letters, digits and `_`, 1 to 63 (src/cli/replication-mode.ts `PG_NAME_BYTES`). */
export const PG_NAME = /^[a-z0-9_]{1,63}$/;
/** Mason's own publication (src/cdc/source.ts `replicationNames`): `mason_` and the rest of a name. */
const OWN_PUBLICATION = /^mason_[a-z0-9_]{1,57}$/;
const MAX_STEPS = 64;
const MAX_SOURCES = 16;

export interface DeletionSource {
  ordinal: number; outcome: typeof SOURCE_OUTCOMES[number]; reason: Reason | null; why: string | null;
  slot: string | null; publication: string | null; publicationOwned: boolean | null; byHand: string | null; reportedAt: string;
}
/** A replica's deletion as the service says it, every value held. */
export interface Deletion {
  stage: Stage; requestedAt: string; handover: { attempts: number; failure: string | null; nextAttemptAt: string | null } | null;
  lastHeardAt: string | null; finishedAt: string | null;
  steps: Array<{ step: string; what: string; doneAt: string | null }>;
  sources: DeletionSource[];
}

/**
 * THE STATEMENT A PERSON RUNS BY HAND for a slot not verified gone: Mason's own (`dropStatements`, the one authority),
 * for the slot named and the publication only when the service says it is Mason's own; `listSlotsStatement` when the
 * slot's name is not known. Every name was held to `PG_NAME` first.
 */
export function byHandOf(s: Pick<DeletionSource, "slot" | "publication" | "publicationOwned">): string {
  if (s.slot === null) return listSlotsStatement();
  const owned = s.publicationOwned === true && s.publication !== null;
  return dropStatements({ slot: s.slot, publication: owned ? s.publication! : "", owned });
}

const absent = (v: unknown): boolean => v === undefined || v === null;
const timeOrNull = (v: unknown): v is string | null | undefined => absent(v) || isServiceTime(v);

/** One source's outcome, held: its ordinal its place, every name to `PG_NAME`, its byHand Mason's own rendering (the
 *  service's is advisory: never compared, never printed); null when any does not hold. */
function heldSource(v: unknown, at: number, secrets: readonly string[]): DeletionSource | null {
  if (!obj(v) || v.ordinal !== at || typeof v.outcome !== "string" || !(SOURCE_OUTCOMES as readonly string[]).includes(v.outcome) || !isServiceTime(v.reportedAt)) return null;
  const outcome = v.outcome as DeletionSource["outcome"];
  const name = (x: unknown): x is string | null | undefined => absent(x) || (typeof x === "string" && PG_NAME.test(x));
  if (!name(v.slot) || !name(v.publication)) return null;
  const slot = typeof v.slot === "string" ? v.slot : null, publication = typeof v.publication === "string" ? v.publication : null;
  if (outcome === "dropped" && slot === null) return null;
  // whether the publication is Mason's own: absent for no_slot; else true (then it is named, and Mason's own), false, null
  let owned: boolean | null = null;
  if (outcome === "no_slot") { if (!absent(v.publicationOwned)) return null; }
  else {
    if (v.publicationOwned !== true && v.publicationOwned !== false && v.publicationOwned !== null) return null;
    owned = v.publicationOwned;
    if (owned === true && (publication === null || !OWN_PUBLICATION.test(publication))) return null;
  }
  // a reason, its words and the SQL by hand: for a slot not verified gone alone
  let reason: Reason | null = null, why: string | null = null, byHand: string | null = null;
  if (outcome === "not_verified") {
    if (typeof v.reason !== "string" || !(REASONS as readonly string[]).includes(v.reason) || (!absent(v.why) && typeof v.why !== "string")) return null;
    reason = v.reason as Reason;
    why = typeof v.why === "string" ? serviceText(v.why, 500, secrets) : null;
    // the statement by hand is Mason's own, from the names held above (#687's review, B1: a service's text compared
    // with it was a fact derived in two places): the service's, a string or nothing, is read for no word of it
    byHand = byHandOf({ slot, publication, publicationOwned: owned });
  } else if (!absent(v.reason) || !absent(v.why)) return null;
  if (!absent(v.byHand) && typeof v.byHand !== "string") return null;
  return { ordinal: at, outcome, reason, why, slot, publication, publicationOwned: owned, byHand, reportedAt: v.reportedAt };
}

/**
 * A REPLICA'S DELETION, held to the contract: carried only while its state is `deleting` (stage `requested`, `in_region`
 * or `needs_person`) or `deleted` (stage `finished`, its time said), and always while `deleted`; a replica `deleting`
 * may carry none (deleted another way, as from the service's web app: it is said as being deleted, nothing more). The
 * handover at `requested` alone; every step's id once; every source in order; at `needs_person` a slot not verified
 * gone, at `finished` none. `undefined` when it carries none (absent or `null`) and may; null when anything does not
 * hold, a deletion present but malformed refused whole. The answer around it has been put to the exact test (`wordless`).
 */
export function heldDeletion(v: unknown, state: ReplicaState, secrets: readonly string[]): Deletion | null | undefined {
  const deleting = state === "deleting" || state === "deleted";
  if (absent(v)) return state === "deleted" ? null : undefined;
  if (!deleting || !obj(v) || typeof v.stage !== "string" || !(STAGES as readonly string[]).includes(v.stage)) return null;
  const stage = v.stage as Stage;
  if ((state === "deleted") !== (stage === "finished")) return null;
  if (!isServiceTime(v.requestedAt) || !timeOrNull(v.lastHeardAt) || !timeOrNull(v.finishedAt) || (stage === "finished") !== isServiceTime(v.finishedAt)) return null;
  let handover: Deletion["handover"] = null;
  if (!absent(v.handover)) {
    const h = v.handover;
    if (stage !== "requested" || !obj(h) || !whole(h.attempts, 0, 1_000_000) || (!absent(h.failure) && typeof h.failure !== "string") || !timeOrNull(h.nextAttemptAt)) return null;
    handover = { attempts: h.attempts as number, failure: words(h.failure, 500, secrets), nextAttemptAt: typeof h.nextAttemptAt === "string" ? h.nextAttemptAt : null };
  }
  if (!Array.isArray(v.steps) || v.steps.length > MAX_STEPS || !Array.isArray(v.sources) || v.sources.length > MAX_SOURCES) return null;
  const steps: Deletion["steps"] = [], ids = new Set<string>();
  for (const x of v.steps) {
    if (!obj(x) || typeof x.step !== "string" || !STEP_ID.test(x.step) || ids.has(x.step) || typeof x.what !== "string" || !timeOrNull(x.doneAt)) return null;
    ids.add(x.step);
    steps.push({ step: x.step, what: serviceText(x.what, 300, secrets), doneAt: typeof x.doneAt === "string" ? x.doneAt : null });
  }
  const sources: DeletionSource[] = [];
  for (const [i, x] of v.sources.entries()) { const s = heldSource(x, i, secrets); if (s === null) return null; sources.push(s); }
  // a person is needed exactly while a slot is not verified gone at the deletion's end: never finished with one left
  const left = sources.some((x) => x.outcome === "not_verified");
  if ((stage === "needs_person" && !left) || (stage === "finished" && left)) return null;
  return { stage, requestedAt: v.requestedAt as string, handover, lastHeardAt: typeof v.lastHeardAt === "string" ? v.lastHeardAt : null,
    finishedAt: typeof v.finishedAt === "string" ? v.finishedAt : null, steps, sources };
}

// ------------------------------------------------------------------ in the CLI's words

const STATE_WORDS: Record<ReplicaState, string> = {
  checking: "checking: Mason checks its database; nothing is made yet",
  creating: "creating: its region is making it",
  ready: "ready",
  failed: "failed: its region could not make it, after every attempt",
  deleting: "deleting",
  deleted: "deleted",
};
const MARKS: Record<SourceChecks["checks"][number]["status"], string> = { ok: "ok", warn: "! ", failed: "!!", unknown: "? " };

/** Each check, one line each: its mark, its name and its detail, its fix beside it; the checks not run, a line. */
export function checkLines(checks: readonly SourceChecks[]): string[] {
  return checks.flatMap((s) => [
    `Mason's checks of the database ${s.source} names: ${s.outcome}`,
    ...s.checks.map((c) => `  ${MARKS[c.status]} ${c.name}: ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`),
    ...(s.missing.length ? [`  ?  not checked: ${s.missing.join(", ")}`] : []),
  ]);
}

/** A replica's facts, as rows. */
function rows(r: HostedReplica): Array<[string, string]> {
  return [
    ["state", STATE_WORDS[r.state]], ["region", r.region], ["size", `${r.sizeGb} GB of synced data`], ["host", r.hostId], ["created", r.createdAt],
    ["allowlist", r.allowlist.length ? r.allowlist.join(", ") : "none: no address may query it yet"],
    ...(r.page !== null ? [["page", r.page] as [string, string]] : []),
    ...r.pending.map((p): [string, string] => ["pending", `${p.change === "create" ? "its creation" : "its allowlist"} ${p.state === "failed" ? "failed" : "is under way"}` +
      ` (${p.attempts} attempt${p.attempts === 1 ? "" : "s"}${p.nextAttemptAt ? `, the next at ${p.nextAttemptAt}` : ""})${p.failure ? `: ${p.failure}` : ""}`]),
  ];
}

const statusStep = (r: Replica | HostedReplica): NextStep => [`mason replica status ${r.org}/${r.name}`, "how it is"];
const listStep = (org: string): NextStep => [`mason replica list ${org}`, "the organisation's replicas"];
const nextOf = (r: HostedReplica): NextStep[] => r.state === "ready"
  ? [[`mason deploy --replica ${r.org}/${r.name}`, "send this project to it"], [`mason token create --replica ${r.org}/${r.name}`, "a CI token for it"]]
  : r.state === "deleted" ? [listStep(r.org)] : [statusStep(r)];

const STAGE_WORDS: Record<Stage, string> = {
  requested: "requested: the service has not handed it to its region yet, and the addresses of its allowlist may still query it",
  in_region: "under way: nobody may query it now",
  needs_person: "needs a person: a replication slot is NOT verified gone, and the service keeps the replica until it is seen gone or a person confirms it was dropped",
  finished: "finished",
};
const REASON_WORDS: Record<Reason, string> = {
  unreachable: "its database could not be reached",
  refused: "its database refused the drop",
  in_use: "a reader still holds the slot",
  still_there: "it was still there after the drop",
  another_server: "the database answering is another server than the one the slot is on",
  record_unreadable: "the replica's record of its slot could not be read",
  failed: "the drop failed",
  unprobed: "whether it is gone was not checked",
};

/** A deletion's stage, as a line: its words, and the handover's attempts while it is not handed over. */
export function stageLine(d: Deletion): string {
  const h = d.handover;
  return `${STAGE_WORDS[d.stage]}${h ? ` (${h.attempts} attempt${h.attempts === 1 ? "" : "s"} to hand it over${h.nextAttemptAt ? `, the next at ${h.nextAttemptAt}` : ""})${h.failure ? `: ${h.failure}` : ""}` : ""}`;
}

/** What a deletion did to one source's replication slot, in the CLI's words (and a reason's words, the service's). */
export function sourceWords(s: DeletionSource): string {
  const slot = s.slot === null ? "its replication slot" : `replication slot ${s.slot}`;
  if (s.outcome === "dropped") return `${slot}: dropped, verified gone`;
  if (s.outcome === "no_slot") return s.slot === null ? "no replication slot: nothing to drop" : `${slot}: not there, nothing to drop`;
  if (s.outcome === "confirmed") return `${slot}: not verified gone by the service; a person confirmed it was dropped by hand, or that its database is no more`;
  return `${slot}: NOT verified gone, ${REASON_WORDS[s.reason!]}${s.why ? ` (${s.why})` : ""}`;
}

/** A replica being deleted whose service gave no deletion (deleted another way): what is known, nothing invented. */
const NO_DELETION = "being deleted: the service said no more of it";
/** What a person does once a deletion needs one: the statements, then the confirmation, where the service takes it. */
const NEEDS_PERSON_TIP = "run each statement above on its database, then confirm it on the replica's page in the service's web app (or there, that the database is no more): the service deletes the replica only then";

/** A replica's deletion as rows: its own (`deletionRows`), the one row that says it is being deleted when the service
 *  gave none, else none. */
export function deletionDetails(state: ReplicaState, d: Deletion | null): Array<[string, string]> {
  return d !== null ? deletionRows(d) : state === "deleting" ? [["deletion", NO_DELETION]] : [];
}

/** A deletion, as rows: its stage, its times, each step (done or not yet), each source's outcome. */
export function deletionRows(d: Deletion): Array<[string, string]> {
  return [
    ["deletion", `${stageLine(d)}; asked for at ${d.requestedAt}`],
    ...(d.lastHeardAt ? [["last heard", d.lastHeardAt] as [string, string]] : []),
    ...(d.finishedAt ? [["finished", d.finishedAt] as [string, string]] : []),
    ...d.steps.map((x): [string, string] => ["step", x.doneAt ? `done: ${x.what} (at ${x.doneAt})` : `not yet: ${x.what}`]),
    ...d.sources.map((x): [string, string] => [`source ${x.ordinal}`, sourceWords(x)]),
  ];
}

/**
 * THE STATEMENTS A PERSON RUNS BY HAND, for each source whose slot is not verified gone: what the CLI says of where, and
 * the statement (Mason's own, `byHandOf`). `[said, sql]` pairs, printed by `pasteLines`; none when every slot was dropped
 * or there was none. The CLI's words hold no piece of SQL: only the statement is pasted.
 */
export function byHandLines(d: Deletion): Array<[said: string, sql: string]> {
  return d.sources.filter((x) => x.outcome === "not_verified").map((x): [string, string] => [x.slot === null
    ? `by hand, for source ${x.ordinal}: this lists Mason's replication slots on its database; drop this replica's slot from them, as a user that may drop a replication slot`
    : `by hand, for source ${x.ordinal}: run this on its database, as a user that may drop a replication slot (its owner, or one with REPLICATION)`, byHandOf(x)]);
}

/**
 * THE ONE WRITER OF A STATEMENT A PERSON PASTES (#687's review, N1: a statement inside a failure's words was broken at the
 * width, mid-word on a narrow terminal; PR 660's B2 met the class with a CI token): for each, the CLI's line saying where,
 * broken as every line holding a service's value is, then the statement alone on a line of its own, indented, WRITTEN
 * UNBROKEN: a break inside a name would be pasted with it, and a terminal narrower than it wraps it softly. Its characters
 * are Mason's own SQL and names held to `PG_NAME`, so no piece of it begins a line of anyone's making.
 */
export function pasteLines(pairs: ReadonlyArray<readonly [said: string, sql: string]>, st: Style): string[] {
  return pairs.flatMap(([said, sql], i) => [...(i ? [""] : []), strict(`  ${said}:`, st), `    ${sql}`]);
}

/** A replica's report with its deletion: the rows, the statements by hand (`pasteLines`), then the tips and next steps. */
function deletionReport(r: { headline: string; details: Array<[string, string]>; deletion: Deletion | null; tips?: readonly string[]; next: readonly NextStep[] }, st: Style): string {
  const hand = r.deletion === null ? [] : byHandLines(r.deletion);
  const report = reportText({ headline: r.headline, details: r.details, ...(hand.length ? {} : { tips: r.tips, next: r.next }) }, st);
  if (!hand.length) return report;
  const end = endText({ tips: r.tips, next: r.next }, st);
  return [report, "", ...pasteLines(hand, st), ...(end ? [end] : [])].join("\n");
}

/**
 * WHAT TO RUN AFTER THE SERVICE REFUSED: the CLI's own, by the status (the service's `next` is never read). A 401 or 403
 * signs in again, naming the role that may (`may`); a 404 lists the organisation's replicas; else `again`.
 */
export function refusedNext(status: number, org: string, may: string, again: NextStep): NextStep[] {
  if (status === 401 || status === 403) return [["mason login", `sign in as ${may} of ${org}`]];
  if (status === 404) return [[`mason replica list ${org}`, "the organisation's replicas"]];
  return [again];
}

// ------------------------------------------------------------------ the command

/** An argument that holds a database's URL, or a connection string's password: `://` anywhere (a scheme, `--url=…`,
 *  `DATABASE_URL=…`), `postgres:` / `postgresql:` without it, or `password=`. Never repeated: it is a secret. */
export const holdsUrl = (a: string): boolean => a.includes("://") || /(?:^|[=\s])postgres(?:ql)?:/i.test(a) || /(?:^|[\s?&;])password\s*=/i.test(a);

/**
 * A DATABASE URL ON THE COMMAND LINE, refused before anything else reads the line (a wrong line, exit 2), and never
 * repeated (the parser's refusal of `--url=…`, or a check of `--region`, would quote it): the way out is the exact line
 * to run, the URL on stdin, every other value kept where it holds its grammar and a placeholder where it does not.
 */
export function urlInArgs(argv: readonly string[]): Failure | null {
  if (!argv.some(holdsUrl)) return null;
  // the line without it, and without the flag it was the value of (`--region <url>`, `--url <url>`)
  const rest: string[] = [];
  for (const a of argv) {
    if (!holdsUrl(a)) { rest.push(a); continue; }
    const before = rest[rest.length - 1];
    if (before !== undefined && /^--[\w-]+$/.test(before) && (REPLICA.options[before.slice(2)]?.type ?? "string") === "string") rest.pop();
  }
  const p = parseArgs({ args: rest, options: REPLICA.options, allowPositionals: true, strict: false });
  const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
  const named = [p.positionals[0] === "create" ? p.positionals[1] : undefined, str(p.values.replica)].find((x) => x !== undefined && /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/.test(x));
  const region = str(p.values.region), size = str(p.values.size), timeout = str(p.values.timeout);
  const line = `mason replica create ${named ?? "<org>/<name>"} --region ${region !== undefined && REGION.test(region) ? region : "<region>"} --size ${size !== undefined && SIZE.test(size) ? size : "<gb>"}` +
    `${timeout !== undefined && /^[0-9]{1,6}[smhd]?$/.test(timeout) ? ` --timeout ${timeout}` : ""}${p.values.json === true ? " --json" : ""} < url.txt`;
  return { message: "a database URL is never taken on mason replica's command line", code: "usage",
    why: "a command line is kept in the shell's history and shown to every process on this machine: if that URL holds a real password, change it",
    fix: `give it on stdin: ${line} (or from a secret store's command, piped); at a terminal, mason replica create asks for it and does not show it`,
    next: [[line, "create it, the URL read from stdin"]] };
}

export async function replica(argv: string[]): Promise<number> {
  // before the parser, whose refusal of an option would quote its value
  const inArgs = urlInArgs(argv);
  if (inArgs !== null) return fail(inArgs, argv.includes("--json"));
  const f = parseCommand(REPLICA, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string, fix?: string): number => fail({ message, code: "usage", ...(fix ? { fix } : {}), usage: REPLICA.usage }, json);
  const [verb, arg, ...rest] = f.positionals;
  const VERBS = ["create", "list", "status", "delete"];
  if (verb === undefined) return usage("create, list, status or delete: mason replica list says the replicas");
  if (!VERBS.includes(verb)) return usage(`there is no mason replica ${verb}: create, list, status or delete${didYouMean(verb, VERBS)}`);
  if (rest.length) return usage(`mason replica ${verb} takes ${verb === "list" ? "one organisation at most" : "one replica"}: ${rest.join(" ")} is too many`);
  for (const k of ["region", "size"] as const) if (verb !== "create" && f.values[k] !== undefined) return usage(`--${k} goes with mason replica create`);
  if (verb !== "create" && verb !== "delete" && f.values.timeout !== undefined) return usage("--timeout goes with mason replica create and mason replica delete");
  if (verb !== "delete" && f.values.yes === true) return usage("--yes goes with mason replica delete");
  const flag = (k: "replica" | "org"): string | undefined => typeof f.values[k] === "string" ? f.values[k] : undefined;
  if (verb === "list") {
    if (flag("replica") !== undefined) return usage("--replica goes with mason replica create and status", "name the organisation: mason replica list <org>, or --org <org>");
    const org = orgOf(flag("org"), arg, REPLICA.usage);
    if (org !== null && isFailure(org)) return fail(org, json);
    return list(org, json);
  }
  if (flag("org") !== undefined) return usage(`--org goes with mason replica list`, `mason replica ${verb} names the replica: <org>/<name>, or --replica <org>/<name>`);
  // the one resolver of every command that names a replica: the argument, else --replica, else MASON_REPLICA (said)
  const r = replicaOf(flag("replica"), REPLICA.usage, process.env, { argument: arg });
  if (r === null) return usage(`mason replica ${verb} names the replica: mason replica ${verb} <org>/<name>`, `or --replica <org>/<name>, or ${REPLICA_ENV}=<org>/<name>`);
  if (isFailure(r)) return fail(r, json);
  if (verb === "status") return status(r, json);
  if (verb === "delete") {
    const timeout = parseDuration(typeof f.values.timeout === "string" ? f.values.timeout : DEFAULT_TIMEOUT, { min: MIN_POLL_SECONDS, max: MAX_POLL_SECONDS });
    if ("problem" in timeout) return usage(`--timeout ${timeout.problem}`);
    // a deletion is asked for twice: on the line, and typed back by a person at a terminal, else by --yes
    if (f.values.yes !== true && !canAsk(json)) {
      return usage(`mason replica delete asks for ${replicaText(r)} to be typed back at a terminal, and ${json ? "--json is no terminal" : "there is none here"}`,
        `say it on the line: mason replica delete ${replicaText(r)} --yes`);
    }
    return remove(r, { timeout, yes: f.values.yes === true }, json);
  }
  const region = typeof f.values.region === "string" ? f.values.region : undefined;
  const size = typeof f.values.size === "string" ? f.values.size : undefined;
  if (region === undefined || size === undefined) return usage(`mason replica create needs ${region === undefined ? "--region" : "--size"}`, "name both: mason replica create <org>/<name> --region <region> --size <gb> (the service's web app lists its regions and sizes)");
  if (!REGION.test(region)) return usage(`--region ${JSON.stringify(serviceText(region, 100))} is not a region's name`, "a region's name is lower case letters, digits and -, as the service lists it");
  if (!SIZE.test(size)) return usage(`--size ${JSON.stringify(serviceText(size, 100))} is not a size`, "a size is a whole number of GB, as the service lists it: --size 50");
  const timeout = parseDuration(typeof f.values.timeout === "string" ? f.values.timeout : DEFAULT_TIMEOUT, { min: MIN_POLL_SECONDS, max: MAX_POLL_SECONDS });
  if ("problem" in timeout) return usage(`--timeout ${timeout.problem}`);
  return create(r, { region, sizeGb: Number(size), timeout }, json);
}

/** The service and the login a request is sent with, the output's gate holding the token; or the Failure. */
function signedIn(asked: string, again: string, json: boolean, more: readonly string[] = []): { service: Service; token: string } | Failure {
  const service = serviceOf();
  if (isFailure(service)) return service;
  const token = tokenFor(service, { asked, again });
  if (isFailure(token)) return token;
  // from here every byte written is put to the exact test against what this command holds (src/cli/output-gate.ts)
  holdOutput({ command: "replica", json, secrets: [token, ...more] });
  return { service, token };
}

/** One replica's answer (`GET …/{name}`, a deletion's): its strings put to the exact test first, its words masked, by
 *  the one list; the replica and its deletion (null when it is in none, or the service gave none while it is being
 *  deleted), or null when either does not hold. */
function replicaAnswer(service: Service, a: Answer, asked: Replica, secrets: readonly string[]): { replica: HostedReplica; deletion: Deletion | null } | null {
  if (!obj(a.json) || !carriesNoSecret(wordless(a.json), secrets)) return null;
  const replica = heldReplica(a.json.replica, asked, secrets, service);
  if (replica === null) return null;
  const deletion = heldDeletion((a.json.replica as Record<string, unknown>).deletion, replica.state, secrets);
  return deletion === null ? null : { replica, deletion: deletion ?? null };
}

async function status(r: Replica, json: boolean): Promise<number> {
  const s = signedIn("a replica's state is asked for", `mason replica status ${replicaText(r)}`, json);
  if (isFailure(s)) return fail(s, json);
  const { service, token } = s, secrets = [token];
  const a = await call(service, "GET", `/v1/replicas/${r.org}/${r.name}`, { token });
  if (isFailure(a)) return fail(a, json);
  if (a.status !== 200) return fail(serviceFailure(a, secrets, (st) => refusedNext(st, r.org, "a member", statusStep(r))) ?? unexpected(service, a, "a replica's state was asked for"), json);
  const answer = replicaAnswer(service, a, r, secrets);
  if (answer === null) return fail(unexpected(service, a, "a replica's state was asked for"), json);
  const { replica: held, deletion } = answer;
  const next = nextOf(held);
  if (json) { out(jsonText(REPLICA, { replica: held, deletion }, next)); return 0; }
  out(deletionReport({ headline: `${replicaText(r)} on ${service.base}: ${held.state}`, details: [...rows(held), ...deletionDetails(held.state, deletion)], deletion,
    ...(deletion?.stage === "needs_person" ? { tips: [NEEDS_PERSON_TIP] } : {}), next }, outStyle()));
  return 0;
}

async function list(org: string | null, json: boolean): Promise<number> {
  const again = "mason replica list <org>";
  const s = signedIn("the replicas are asked for", org === null ? "mason replica list" : `mason replica list ${org}`, json);
  if (isFailure(s)) return fail(s, json);
  const { service, token } = s, secrets = [token];
  const orgs = org !== null ? [org] : await loginOrgs(service, token, again);
  if (isFailure(orgs)) return fail(orgs, json);
  const slugs = orgs.map((o) => typeof o === "string" ? o : o.slug);
  const replicas: HostedReplica[] = [];
  const more: string[] = [];
  for (const slug of slugs) {
    const a = await call(service, "GET", `/v1/replicas/${slug}`, { token, maxBytes: MAX_LIST_BYTES });
    if (isFailure(a)) return fail(a, json);
    if (a.status !== 200) return fail(serviceFailure(a, secrets, (st) => refusedNext(st, slug, "a member", [`mason replica list ${slug}`, "again"])) ?? unexpected(service, a, "the replicas were asked for"), json);
    const j = a.json;
    if (!obj(j) || !Array.isArray(j.replicas) || j.replicas.length > MAX_REPLICAS || typeof j.more !== "boolean" || !carriesNoSecret(wordless(j), secrets)) return fail(unexpected(service, a, "the replicas were asked for"), json);
    for (const v of j.replicas) { const h = heldReplica(v, { org: slug }, secrets, service); if (h === null) return fail(unexpected(service, a, "the replicas were asked for"), json); replicas.push(h); }
    if (j.more) more.push(slug);
  }
  const where = slugs.length === 1 ? slugs[0]! : slugs.length === 0 ? "no organisation" : `${slugs.length} organisations`;
  const next: NextStep[] = replicas.length
    ? [statusStep(replicas[0]!), [`mason replica create ${slugs[0]}/<name> --region <region> --size <gb>`, "another"]]
    : slugs.length ? [[`mason replica create ${slugs[0]}/<name> --region <region> --size <gb>`, "make one (an account's first, in the service's web app)"]] : [];
  if (json) { out(jsonText(REPLICA, { replicas, more: more.length > 0 }, next)); return 0; }
  const st = outStyle();
  const head = replicas.length ? `${replicas.length} replica${replicas.length === 1 ? "" : "s"} in ${where}, on ${service.base}`
    : slugs.length ? `No replicas yet in ${where}, on ${service.base}` : `This login is a member of no organisation on ${service.base}`;
  const w = Math.max(0, ...replicas.map((r) => `${r.org}/${r.name}`.length)), sw = Math.max(0, ...replicas.map((r) => r.state.length));
  const lines = replicas.map((r) => `  ${`${r.org}/${r.name}`.padEnd(w)}   ${r.state.padEnd(sw)}   ${r.region}, ${r.sizeGb} GB, host ${r.hostId}`);
  const tips = more.map((o) => `${o} has more replicas than the service lists at once: mason replica status <org>/<name> says any one of them`);
  out(strict(`${st.bold(head)}${lines.length ? `\n${lines.join("\n")}` : ""}${endText({ tips, next }, st) ? `\n${endText({ tips, next }, st)}` : ""}`, st));
  return 0;
}

/** A password shorter than this, in the one reading (src/cli/hosted.ts `canonicalSecret`), is not sent: no boundary can
 *  tell it apart from ordinary words in what is printed. */
export const MIN_PASSWORD = 8;

/**
 * THE URL'S PASSWORD, AS THIS COMMAND HOLDS IT (PR 660's review, B1: one rule for every boundary): decoded (a malformed
 * escape as written), held beside the token in the ONE list of secrets every boundary reads — the exact test of every
 * value (`carriesNoSecret`), the masks of free text (`serviceText`) and the output's gate — each by the one reading
 * (src/cli/hosted.ts `readUnits`: whole, and by its runs when its body is long enough). None for a URL without one;
 * `short` for one under `MIN_PASSWORD` characters in that reading, which is not sent.
 */
export function urlPassword(url: string): { password: string | null } | { short: true } {
  let raw = "";
  try { raw = new URL(url).password; } catch { raw = ""; }   // not a URL: parseSource refused it before this
  // decoded, as a mask reads text; a malformed escape held as it is written, never dropped
  const password = ((): string => { try { return decodeURIComponent(raw); } catch { return raw; } })();
  if (password === "") return { password: null };
  return [...canonicalSecret(password)].length < MIN_PASSWORD ? { short: true } : { password };
}

/** What a creation prints from, before it sends anything: every value of this command line and this machine. */
export interface CreateRun { r: Replica; region: string; sizeGb: number; timeout: { every: string; seconds: number }; base: string; variable: string; from: string; source: string }

/**
 * EVERY WORD A CREATION PRINTS OF ITS OWN, by the builders it prints with (`create` prints through these alone): its
 * progress, the lines of a lost answer and of the wait, and each failure and report it can end with. What the service
 * sends goes in where a builder takes it, through the masks and the exact test. `printedCorpus` renders them.
 */
export function createWords(c: CreateRun) {
  const name = replicaText(c.r);
  const again: NextStep = [`mason replica create ${name} --region ${c.region} --size ${c.sizeGb}`, "create it again"];
  const status = statusStep(c.r);
  return {
    again, status,
    progress: `Creating ${name} on ${c.base}: Mason checks the database (${c.variable}, its URL ${c.from}) from the replica's side, up to a minute`,
    lost: (why: string, st: ReplicaState): string => `  The creation's answer was lost (${why}); the service has ${name}, ${STATE_WORDS[st]}`,
    wait: (st: ReplicaState, unsure: string | null): string => unsure === null ? STATE_WORDS[st] : `${STATE_WORDS[st]}; the service could not say more just now (${unsure}): asking again`,
    unsureOf: (what: string, statusCode: number): string => `${what} answered ${statusCode}`,
    /** a 503 with Retry-After: when the service asks for another try (the CLI does not wait for it) */
    retryIn: (why: string | undefined, seconds: number | string): string => `${why ? `${why}; ` : ""}the service asks for another try in ${seconds} s: run the same command again then`,
    /** a 403 says who may, and where an account's first replica is made (the API refuses it: a person is asked there) */
    refusedNext: (st: number): NextStep[] => st === 403
      ? [["mason login", `sign in as an admin or an owner of ${c.r.org}; an account's first replica is made in the service's web app, ${c.base}`]]
      : refusedNext(st, c.r.org, "an admin or an owner", again),
    /** the checks failed: they are Mason's own, which mason doctor runs here against the same database */
    checksFailedNext: [["mason doctor", "the same checks of the database, run here"], again] as NextStep[],
    lostFailure: (sent: Failure, absent: boolean): Failure => ({ ...sent,
      why: `${sent.why ?? "no answer"}; ${absent ? "asked since, the service has no such replica: it was not made" : "whether it was made is not known"}`,
      fix: `mason replica status ${name} says whether it was; if not, create it again`, next: [status, again] }),
    failed: (why: string): Failure => ({ message: `${name} was not made: its region could not make it, after every attempt`, code: "failed", ...(why ? { why } : {}),
      fix: `an admin or an owner of ${c.r.org} tries it again on its page in the service's web app (${c.base})`, next: [status] }),
    deleted: (st: "deleting" | "deleted"): Failure => ({ message: `${name} is ${st === "deleting" ? "being deleted" : "deleted"}`, code: "refused",
      why: "it was deleted while it was made", fix: `create it again, as ${name} or under another name`, next: [again] }),
    timedOut: (st: ReplicaState): Failure => ({ message: `${name} was not ready within ${c.timeout.every}`, code: "timeout", why: `it was last ${STATE_WORDS[st]}`,
      fix: `nothing was stopped, and its region goes on making it: mason replica status ${name} says how it goes; a longer wait is --timeout 30m`, next: [status] }),
    gone: (): Failure => ({ message: `the service has no ${name} now`, code: "not_found", why: "it was made, and is gone: deleted, or its creation undone",
      fix: `mason replica list ${c.r.org} says the organisation's replicas`, next: [[`mason replica list ${c.r.org}`, "the organisation's replicas"]] }),
    report: (state: HostedReplica, next: readonly NextStep[], st: Style): string => reportText({ headline: `Created ${name} on ${c.base}: it is ready`,
      details: rows(state).filter(([k]) => k !== "state"),
      tips: [state.page !== null ? "Its allowlist, the addresses that may query it, is set on its page, above." : `Its allowlist, the addresses that may query it, is set on its page in the service's web app, ${c.base}`,
        "The service does not keep the database's URL: the replica reads it by its variable, from its own environment."], next }, st),
  };
}

/** The `/v1/` failures the contract documents for a creation and a state's answer, each status with its codes. */
const DOCUMENTED: ReadonlyArray<[number, readonly string[]]> = [[400, ["bad_request"]], [401, ["unauthenticated"]], [403, ["refused"]], [404, ["not_found"]],
  [409, ["refused", "busy"]], [413, ["too_large"]], [415, ["bad_request"]], [422, ["checks_failed"]], [426, ["refused", "upgrade_required"]], [429, ["slow_down"]], [500, ["failed"]],
  [502, ["unavailable"]], [503, ["checks_unknown", "unavailable"]], [504, ["unavailable"]]];

/**
 * EVERYTHING A CREATION CAN PRINT OF ITS OWN, rendered (R2-B2: a password made of the CLI's own words failed an honest run,
 * after the replica was made): each builder of `createWords`, with this run's own values, in each order it is printed —
 * a person's stderr, stdout and the two together, and --json — every service's value a placeholder that carries no
 * word. The output's gate reads what a run writes; what it could read of the CLI's own is in here.
 */
export function printedCorpus(c: CreateRun, tail = 256): string[] {
  const w = createWords(c), service: Service = { base: c.base }, P = "#";
  const failure = (f: Failure): string => failureText("replica", f, PLAIN);
  const asJson = (v: Record<string, unknown>, next: readonly NextStep[]): string => jsonText(REPLICA, v, next);
  const sample = (state: ReplicaState, pending: HostedReplica["pending"] = [], page: string | null = P): HostedReplica =>
    ({ org: c.r.org, name: c.r.name, region: c.region, sizeGb: c.sizeGb, hostId: P, state, createdAt: P, allowlist: [], page, pending });
  const pendings: Array<HostedReplica["pending"]> = [[], ...(["create", "allowlist"] as const).flatMap((change) => (["pending", "failed"] as const).flatMap((st) =>
    [0, 1, 2].map((attempts) => [{ change, state: st, attempts, failure: P, nextAttemptAt: P }])))];
  const checks: SourceChecks[] = OUTCOMES.map((outcome) => ({ source: c.source, outcome, checks: CHECK_STATUSES.map((status) => ({ name: P, status, detail: P, fix: P })), missing: [P] }));
  const ends: Array<{ stdout: string } | { stderr: string }> = [];
  const nexts: NextStep[][] = [nextOf(sample("ready")), [w.status]];
  const failures: Failure[] = [w.failed(P), w.failed(""), w.deleted("deleting"), w.deleted("deleted"), w.gone(),
    ...STATES.map((st) => w.timedOut(st)),
    ...[{ why: P }, { why: "no answer within 60 s" }, { why: "no answer within 15 s" }].flatMap((x) => [true, false].map((absent) =>
      w.lostFailure({ message: `could not reach ${c.base}`, code: "failed", why: x.why, fix: `check this machine is online, and that MASON_CLOUD_URL names the service (it is ${c.base})`, next: [] }, absent))),
    ...DOCUMENTED.flatMap(([status, codes]) => codes.flatMap((code) => [P, undefined].flatMap((why) => {
      const f = serviceFailure({ status, json: { error: { code, message: P, ...(why ? { why, fix: P } : {}) } }, what: `POST /v1/replicas/${c.r.org}`, retryAfter: null }, [], w.refusedNext)!;
      return status === 422 ? [{ ...f, next: w.checksFailedNext }] : status === 503 ? [f, { ...f, why: w.retryIn(f.why, P) }] : [f];
    }))),
    ...[200, 201, ...DOCUMENTED.map(([st]) => st)].flatMap((status) => [true, false].flatMap((isJson) => ["a replica was created", "a replica's state was asked for"].map((step) =>
      unexpected(service, { status, json: isJson ? {} : undefined, what: step === "a replica was created" ? `POST /v1/replicas/${c.r.org}` : `GET /v1/replicas/${c.r.org}/${c.r.name}`, retryAfter: null }, step))))];
  for (const f of failures) ends.push({ stderr: failure(f) }, { stdout: asJson({ replica: sample("creating"), checks, error: errorJson(f) }, f.next ?? []) },
    { stdout: asJson({ replica: sample("creating", [], null), checks, error: errorJson(f) }, f.next ?? []) }, { stdout: asJson({ checks, error: errorJson(f) }, f.next ?? []) });
  for (const pending of pendings) for (const next of nexts) {
    ends.push({ stdout: w.report(sample("ready", pending), next, PLAIN) }, { stdout: w.report(sample("ready", pending, null), next, PLAIN) }, { stdout: asJson({ replica: sample("ready", pending), checks }, next) }, { stdout: asJson({ replica: sample("ready", pending, null), checks }, next) }, { stdout: asJson({ replica: sample("ready", pending), checks: null }, next) });
  }
  // the lines on stderr before an end, in the order they are printed: the progress, the checks or a lost answer's line,
  // then the wait's lines (each state, as it is or unsure), in both orders
  const unsure = [null, P, ...[429, 500, 502, 503, 504].map((st) => w.unsureOf(`GET /v1/replicas/${c.r.org}/${c.r.name}`, st)), `could not reach ${c.base} (no answer within 15 s)`];
  const waits = (["checking", "creating"] as const).flatMap((st) => unsure.map((u) => `  ${w.wait(st, u)}`));
  const before = [[w.progress, ...checkLines(checks), ...waits], [w.progress, ...STATES.map((st) => w.lost(P, st)), ...[...waits].reverse()]];
  const spinner = `mason ${REPLICA.name}`;
  const corpus: string[] = [];
  for (const lines of before) {
    const err = lines.join("\n");
    corpus.push(`${spinner}\n${err}`);
    // each end after what came before it: the gate reads across writes as far as its tail reaches (`tail`)
    for (const end of ends) corpus.push(`${err.slice(-tail)}\n${"stdout" in end ? end.stdout : end.stderr}`);
  }
  for (const end of ends) corpus.push("stdout" in end ? end.stdout : end.stderr);
  return corpus;
}

/**
 * WHETHER THE CLI'S OWN WORDS HOLD THE PASSWORD, as the output's gate would read them (its own test, `readingsCarry`, on
 * every text of `printedCorpus`): then an honest run would be refused by the gate, after the replica was made, blaming
 * the service. Such a password is refused before anything is sent, in words that say so. The corpus's readings are made
 * once a run.
 */
export function ownWordsHold(password: string, c: CreateRun): boolean {
  const tail = Math.max(256, 3 * password.length), key = `${tail}\u0000${JSON.stringify(c)}`;
  let reads = CORPUS.get(key);
  if (reads === undefined) { reads = printedCorpus(c, tail).map((text) => readingsOf(text)); CORPUS.set(key, reads); }
  return reads.some((read) => readingsCarry(read, [password]));
}
const CORPUS = new Map<string, Written[]>();

/** How long stdin may stay silent when it is not a terminal: a pipe left open with nothing in it never holds create. */
export const STDIN_MS = 60_000;
/** The URL's own bound: what the contract takes (docs/HOSTED-API.md). */
export const MAX_URL = 2048;
/** The one variable a replica sets for its source (docs/HOSTED-API.md): a service refuses any other `variable`. */
export const REPLICA_VARIABLE = "DATABASE_URL";
/** The lowest port a replica connects to: below it, a service refuses the URL. */
export const MIN_PORT = 1024;
/** libpq's parameter names, said by name when a URL carries one; any other is "a parameter", never its text. */
const LIBPQ_PARAMS = new Set(["host", "hostaddr", "port", "dbname", "user", "password", "passfile", "options", "application_name", "fallback_application_name",
  "connect_timeout", "client_encoding", "keepalives", "target_session_attrs", "sslcert", "sslkey", "sslrootcert", "sslcrl", "sslpassword", "sslnegotiation",
  "gssencmode", "krbsrvname", "service", "replication", "channel_binding", "require_auth", "load_balance_hosts"]);

/**
 * WHAT A SERVICE REFUSES OF A URL (docs/HOSTED-API.md "The URL"), checked here before anything is sent: more than one
 * host, no host, no password, no database name, a query parameter other than `sslmode`, a port below `MIN_PORT`. Each
 * is said by what is wrong, never by a part of the URL (a parameter by libpq's name alone). Null when none applies,
 * or when it is not a URL at all (Mason's own grammar, `parseSource`, says so after).
 */
export function replicaUrlProblem(url: string): string | null {
  const after = url.trim().replace(/^[a-z]+:\/\//i, "");
  const authority = after.split(/[/?#]/, 1)[0] ?? "";
  if (authority.slice(authority.lastIndexOf("@") + 1).includes(",")) return "it names more than one host: a replica connects to one host, postgres://user:password@host:5432/your_app";
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.hostname === "") return "it names no host: postgres://user:password@host:5432/your_app";
  if (u.password === "") return "it has no password: a replica connects as a user with one, postgres://user:password@host:5432/your_app";
  if (u.pathname.replace(/^\//, "") === "") return "it names no database: add it after the port, postgres://user:password@host:5432/your_app";
  const others = [...new Set([...u.searchParams.keys()].filter((k) => k !== "sslmode"))];
  if (others.length) {
    const named = others.map((k) => k.toLowerCase()).filter((k) => LIBPQ_PARAMS.has(k));
    const what = named.length === others.length ? `${named.length === 1 ? "the parameter" : "the parameters"} ${named.join(", ")}` : named.length ? `the parameters ${named.join(", ")} and another` : "a parameter";
    return `it has ${what} after the ?: a replica takes sslmode alone; leave the rest out`;
  }
  if (u.port !== "" && Number(u.port) < MIN_PORT) return `its port is below ${MIN_PORT}: a replica connects to a database on port ${MIN_PORT} or above (Postgres's own is 5432)`;
  return null;
}

/** Where the URL was read, in the words a refusal and the progress say it by. */
export type UrlFrom = "typed at the prompt" | "read from stdin";

/**
 * THE DATABASE'S URL, from the person or the pipe (src/cli/secret-input.ts): stdin a terminal, a hidden prompt, its
 * question on stderr; else stdin read whole. Never a flag, an argument or a file. What went wrong is said by kind,
 * never by value, with the line to run instead (`again`).
 */
export async function readUrl(variable: string, again: string, input: SecretInput = process.stdin, output: { write(s: string): unknown } = process.stderr,
  o: { stdinMs?: number } = {}): Promise<{ url: string; from: UrlFrom } | Failure> {
  const tty = input.isTTY === true;
  const from: UrlFrom = tty ? "typed at the prompt" : "read from stdin";
  const piped = `${again} < url.txt`;
  let read: SecretRead;
  try {
    read = tty ? await readHidden(input, output, `${variable}, the database's URL (not shown; Ctrl-C cancels): `, MAX_URL)
      : await readPiped(input, MAX_URL, o.stdinMs ?? STDIN_MS);
  } catch (e) {
    // the stream's own error (a terminal gone, a pipe broken): its words are the system's, and hold nothing typed
    return { message: `the database's URL could not be ${tty ? "read at the prompt" : "read from stdin"}: nothing was sent`, code: "failed",
      why: serviceText(e instanceof Error ? e.message : String(e), 200), fix: tty ? `run it again, or give the URL on stdin: ${piped}` : `run it again: ${piped}` };
  }
  if ("value" in read) return { url: read.value, from };
  const fix = tty ? `run it again and paste the URL when it asks, or give it on stdin: ${piped}` : `give the URL on stdin: ${piped} (or from a secret store's command, piped); at a terminal, it is asked for`;
  const said: Record<typeof read.none, { message: string; why: string }> = {
    cancelled: { message: "cancelled: no URL was given, and nothing was sent", why: tty ? "Ctrl-C, or the input ended, at the prompt" : "stdin ended" },
    empty: tty ? { message: "cancelled: no URL was typed, and nothing was sent", why: "an empty line cancels the prompt" }
      : { message: "stdin was empty: no URL was given, and nothing was sent", why: "stdin is not a terminal, so mason replica create reads the database's URL from it, whole" },
    too_long: { message: `the database's URL ${from} is longer than ${MAX_URL} bytes: nothing was sent`, why: "a URL is sent as postgres://… or postgresql://…, at most 2 KiB" },
    lines: { message: "stdin holds more than one line: nothing was sent", why: "the database's URL is read from stdin whole, one line (one trailing newline is trimmed)" },
    timeout: { message: `nothing arrived on stdin within ${Math.round((o.stdinMs ?? STDIN_MS) / 1000)} s: nothing was sent`, why: "stdin is not a terminal, so mason replica create reads the database's URL from it, and it stayed open with nothing in it" },
    closed: { message: "the prompt's input ended before the line did: nothing was sent", why: "the terminal closed while the URL was typed" },
  };
  return { ...said[read.none], code: "refused", fix };
}

async function create(r: Replica, o: { region: string; sizeGb: number; timeout: { every: string; seconds: number } }, json: boolean): Promise<number> {
  // THE DATABASE: the project's sources file names the variable the replica reads it by; its value is never read here
  const t = theProject(process.cwd());
  if ("problem" in t) return fail({ message: t.problem, code: t.code, why: t.why ?? "a replica syncs the database this project's sources file names", fix: t.fix, next: t.next }, json);
  const p = t.project;
  const src = readSourceFile(p.folder, p.root);
  if (isFailure(src)) return fail(src, json);
  const file = shownPath(p.root, src.file);
  const again = `mason replica create ${replicaText(r)} --region ${o.region} --size ${o.sizeGb}`;
  if ("literal" in src.url) {
    return fail({ message: `${file}: url: is written in the file`, code: "refused",
      why: "a replica reads its database's URL from a variable of its own environment, by the name the sources file gives it; a URL written in the file would also be kept with the project's files",
      fix: `write url: \${DATABASE_URL} in ${file}, then ${again} again: it asks for the URL at a terminal, or reads it from stdin (${again} < url.txt)` }, json);
  }
  const variable = src.url.env;
  // the one variable a replica sets for its database: a service refuses any other name (400), so it is refused here,
  // before the URL is asked for
  if (variable !== REPLICA_VARIABLE) {
    return fail({ message: `${file}: url: \${${variable}} names a variable a replica does not set`, code: "refused",
      why: `a replica sets one variable for its database, ${REPLICA_VARIABLE}, and reads the URL by that name; a service refuses any other`,
      fix: `write url: \${${REPLICA_VARIABLE}} in ${file} (and ${REPLICA_VARIABLE}= in .env, for mason start), then ${again} again` }, json);
  }
  const service = serviceOf();
  if (isFailure(service)) return fail(service, json);
  const s = signedIn("a replica is created", `mason replica create ${replicaText(r)}`, json);
  if (isFailure(s)) return fail(s, json);
  const { token } = s;
  // THE URL: asked for, or read from stdin; never a flag, an argument or a file
  const got = await readUrl(variable, again);
  if (isFailure(got)) return fail(got, json);
  const { url, from } = got;
  const named = `the URL given for ${variable} (${from})`;
  // the value is held to the grammar Mason connects by before it leaves this machine, never repeated (preflight's rule)
  // first its form, then what a service refuses (each said by what is wrong, never by a part of it), then the grammar
  // Mason connects by
  const form = !/^postgres(?:ql)?:\/\//i.test(url.trim()) || url.length > MAX_URL ? "it is sent as postgres://… or postgresql://…, at most 2 KiB" : replicaUrlProblem(url);
  const parsed = form === null ? parseSource(url, named) : null;
  const problem = form ?? (parsed !== null && "problem" in parsed ? parsed.problem : null);
  if (problem !== null) {
    return fail({ message: `${named} is not a database URL a replica can be made for`, code: "refused", why: problem,
      fix: `give the database's URL, postgres://user:password@host:5432/your_app: ${again} < url.txt, or at the prompt` }, json);
  }
  const run: CreateRun = { r, region: o.region, sizeGb: o.sizeGb, timeout: o.timeout, base: service.base, variable, from, source: src.name };
  const w = createWords(run);
  // THE PASSWORD, before anything is held or sent (neither refusal names it): one too short to be told apart from
  // words, or one the CLI's own words hold, is not sent, since no honest run could print without the gate refusing it
  const pw = urlPassword(url);
  const notSent = (message: string, why: string): number => fail({ message, code: "refused", why,
    fix: "name a database user with another password in the URL, or create the replica in the service's web app" }, json);
  if ("short" in pw) {
    return notSent(`the password in ${named} is shorter than the ${MIN_PASSWORD} characters this command sends`,
      "a password this short cannot be told apart from ordinary words in what the service answers, so nothing could keep it out of what is printed; it is not sent");
  }
  if (pw.password !== null && ownWordsHold(pw.password, run)) {
    return notSent(`the password in ${named} is in the words this command prints itself`,
      "this command keeps the password out of everything it prints by finding it there, and its own words (its lines, its steps, the replica's name or the service's address) hold this one: it could not print its answer, so it is not sent");
  }
  const held = pw.password === null ? [] : [pw.password];
  // the gate holds it beside the token before anything more is written (src/cli/output-gate.ts)
  holdOutput({ command: "replica", json, secrets: held });
  // ONE list of what this command holds, read by every boundary: the exact test, the masks and the output's gate
  const secrets = [token, ...held];
  const where = `/v1/replicas/${r.org}`;
  const refusedOf = (a: Answer, step: string): Failure => serviceFailure(a, secrets, w.refusedNext) ?? unexpected(service, a, step);
  if (!json) say(w.progress);

  // THE CREATION: the service checks the source, then answers 201, or why it was not made (with the checks, said)
  const sent = await call(service, "POST", where, { token, timeoutMs: CREATE_MS,
    json: { name: r.name, region: o.region, sizeGb: o.sizeGb, sources: [{ name: src.name, variable, url }], client: { version: version() } } });
  let checks: SourceChecks[] | null = null;
  let state: HostedReplica;
  let waitMs = REPLICA_POLL_MS;
  if (isFailure(sent)) {
    // a POST that got no answer may have made the replica: its state says so (the contract)
    const a = await call(service, "GET", `${where}/${r.name}`, { token });
    const found = !isFailure(a) && a.status === 200 ? replicaAnswer(service, a, r, secrets)?.replica ?? null : null;
    // why it got no answer is the system's words, never the CLI's own: masked by what this command holds, as a service's are
    const why = serviceText(sent.why ?? sent.message, 300, secrets);
    if (found === null) return fail(w.lostFailure({ ...sent, why }, !isFailure(a) && a.status === 404), json);
    if (!json) say(w.lost(why, found.state));
    state = found;
    if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
  } else {
    if (obj(sent.json) && sent.status !== 201 && "checks" in sent.json && carriesNoSecret(wordless({ checks: sent.json.checks }), secrets)) checks = heldChecks(sent.json.checks, src.name, secrets);
    if (sent.status !== 201) {
      const refused = refusedOf(sent, "a replica was created");
      // a launch the service could not start: its words, and when it asks to be tried again (the CLI does not wait)
      const f = sent.status === 503 && sent.retryAfter !== null ? { ...refused, why: w.retryIn(refused.why, sent.retryAfter) } : refused;
      if (!json && checks !== null) for (const l of checkLines(checks)) say(l);
      const next: readonly NextStep[] = sent.status === 422 ? w.checksFailedNext : f.next ?? [];
      const failure = { ...f, next };
      if (json) { out(jsonText(REPLICA, { checks, error: errorJson(failure) }, next)); return exitOf(failure); }
      return fail(failure, false);
    }
    const j = sent.json;
    const made = obj(j) && carriesNoSecret(wordless(j), secrets) ? heldReplica(j.replica, r, secrets, service) : null;
    checks = obj(j) ? heldChecks(j.checks, src.name, secrets) : null;
    if (made === null || checks === null) return fail(unexpected(service, sent, "a replica was created"), json);
    if (!json) for (const l of checkLines(checks)) say(l);
    state = made;
    if (sent.retryAfter !== null) waitMs = sent.retryAfter * 1000;
  }

  // THE WAIT: until its region has made it (ready) or could not (failed), bounded by --timeout
  const started = Date.now(), deadline = started + o.timeout.seconds * 1000;
  let said = "", saidAt = 0;
  const show = (line: string): void => { if (!json && sayAgain(line, said, saidAt, Date.now())) { say(`  ${line}`); said = line; saidAt = Date.now(); } };
  const ended = (error: Failure | null): number => {
    const next = error === null ? nextOf(state) : error.next ?? [];
    if (json) { out(jsonText(REPLICA, { replica: state, checks, ...(error ? { error: errorJson(error) } : {}) }, next)); return error ? exitOf(error) : 0; }
    if (error !== null) return fail(error, false);
    out(w.report(state, next, outStyle()));
    return 0;
  };
  for (;;) {
    if (state.state === "ready") return ended(null);
    if (state.state === "failed") return ended(w.failed(state.pending.map((x) => x.failure).filter((x): x is string => x !== null).join("; ")));
    if (state.state === "deleting" || state.state === "deleted") return ended(w.deleted(state.state));
    show(w.wait(state.state, null));
    const left = deadline - Date.now();
    if (left <= 0) return ended(w.timedOut(state.state));
    await sleep(Math.min(waitMs, left));
    const a = await call(service, "GET", `${where}/${r.name}`, { token });
    waitMs = REPLICA_POLL_MS;
    // an answer that cannot say how it goes is a wait, never an outcome: the timeout bounds it
    if (isFailure(a) || a.status === 429 || a.status >= 500) {
      if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
      show(w.wait(state.state, isFailure(a) ? serviceText(a.why ?? a.message, 300, secrets) : w.unsureOf(a.what, a.status)));
      continue;
    }
    if (a.retryAfter !== null) waitMs = a.retryAfter * 1000;
    if (a.status === 404) return ended(w.gone());
    if (a.status !== 200) return ended(refusedOf(a, "a replica's state was asked for"));
    const now = replicaAnswer(service, a, r, secrets);
    if (now === null) return ended(unexpected(service, a, "a replica's state was asked for"));
    state = now.replica;
  }
}

// ------------------------------------------------------------------ delete

/** Whether a person is there to type the replica's name back: a terminal both ways, and no --json (never an environment
 *  variable: src/cli/share.ts's rule). */
const canAsk = (json: boolean): boolean => !json && process.stdin.isTTY === true && process.stderr.isTTY === true;

/**
 * A PERSON TYPES THE REPLICA'S NAME BACK: whether they typed exactly it (nothing trimmed or re-cased, as the service takes
 * the confirm). What was typed is never printed: it may be anything, a secret pasted in the wrong place. The terminal
 * echoes it, as a terminal does; the CLI writes nothing of it.
 */
async function typedBack(name: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const closed = once(rl, "close").then(() => null);
  const answer = await Promise.race([rl.question("> "), closed]);
  rl.close();
  // the input ended with nothing typed (a terminal echoes no line for it): the prompt's line ends here
  if (answer === null) process.stderr.write("\n");
  return answer === name;
}

/** EVERY WORD A DELETION PRINTS OF ITS OWN, by the builders it prints with; what the service sends goes in where a
 *  builder takes it, held and masked. */
export function deleteWords(r: Replica, base: string, every: string) {
  const name = replicaText(r);
  const again: NextStep = [`mason replica delete ${name}`, "delete it again (a repeat changes nothing)"];
  const status = statusStep(r);
  const at = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    again, status,
    ask: `Deleting ${name} on ${base} cannot be undone: the replica and its synced data go, and Mason's replication slot on its database is dropped. Type ${name} to delete it, anything else to keep it.`,
    notTyped: { message: `${name} was not deleted: what was typed is not its name`, code: "refused",
      why: "a deletion is asked for twice: on the command line, and typed back exactly (nothing trimmed, nothing re-cased)",
      fix: `run it again and type ${name}; where no person is asked, mason replica delete ${name} --yes`, next: [[`mason replica delete ${name}`, "ask again"]] } as Failure,
    progress: `Deleting ${name} on ${base}: each step is said as the service reports it, waiting up to ${every}`,
    lost: (why: string, d: Deletion | null): string => `  The deletion's answer was lost (${why}); the service has ${name}, its deletion ${d ? stageLine(d) : NO_DELETION}`,
    unsure: (d: Deletion | null, why: string): string => `${d ? stageLine(d) : NO_DELETION}; the service could not say more just now (${why}): asking again`,
    noDeletion: NO_DELETION,
    headline: `Deleted ${name} on ${base}`,
    waiting: `${name} on ${base} is not deleted yet: its deletion needs a person`,
    /** a refusal's next step, the CLI's own, by the status (and a 403's code, which the service's words carry) */
    refusedNext: (status: number, code: string, retryAfter: number | null): NextStep[] => {
      if (status === 403 && code === "fresh_login_needed") {
        return [["mason login", `sign in again, then mason replica delete ${name} within 15 minutes of it; or delete it on its page in the service's web app, ${base}`]];
      }
      if (status === 401 || status === 403) return [["mason login", `sign in as an owner of ${r.org}: an owner deletes a replica, signed in as a person (a CI token deletes none)`]];
      if (status === 404) return [listStep(r.org)];
      if (status === 429 || status === 503) return [[again[0], retryAfter !== null ? `again after ${at(retryAfter)} (in ${retryAfter} s), when the service takes it` : "again later: the service did not say when"]];
      return [again];
    },
    lostFailure: (sent: Failure, seen: { absent: true } | { state: ReplicaState } | null): Failure => ({ ...sent,
      why: `${sent.why ?? "no answer"}; ${seen === null ? "whether its deletion began is not known" : "absent" in seen ? `asked since, the service has no ${name} for this login` : `asked since, it is ${seen.state}: its deletion did not begin`}`,
      fix: `mason replica status ${name} says whether it is being deleted; if it is not, delete it again (a repeat changes nothing)`, next: [status, again] }),
    /**
     * NEEDS A PERSON: a slot not verified gone, the replica kept until it is seen gone or confirmed. The statements were
     * printed; the wait stops at once (nothing more comes without the person), and the exit is 1: it is not deleted.
     */
    needsPerson: (d: Deletion): Failure => {
      const left = d.sources.filter((x) => x.outcome === "not_verified");
      const one = left.length === 1;
      return { message: `${name} is not deleted yet: ${one ? `the replication slot of source ${left[0]!.ordinal} is` : `the replication slots of ${left.length} sources are`} NOT verified gone`, code: "failed",
        why: "a replication slot holds its database's WAL while it exists, whatever the disk, so the service keeps the replica until each slot is seen gone or a person confirms it was dropped",
        fix: `run the statement printed for ${one ? "it" : "each"} on ${one ? "its database" : "each one's database"} (with --json, deletion.sources[].byHand), then confirm it on the replica's page in the service's web app (or there, that the database is no more): its deletion then finishes`,
        next: [[status[0], "how its deletion goes, once confirmed"]] };
    },
    timedOut: (d: Deletion | null): Failure => ({ message: `${name}'s deletion did not finish within ${every}`, code: "timeout", why: `it was last ${d ? stageLine(d) : NO_DELETION}`,
      fix: `nothing was stopped, and its deletion goes on: mason replica status ${name} says how it goes; a longer wait is --timeout 30m`, next: [status] }),
    /** gone midway: the statement that lists Mason's slots, pasted (`pasteLines`) — under --json, where nothing is
     *  broken, in the fix too */
    gone: (json: boolean): Failure => ({ message: `the service has no ${name} now`, code: "not_found",
      why: "it was being deleted, and the service has no record of it now: what its deletion did to each replication slot is not known",
      fix: json ? `look for Mason's slots on each database it synced, and drop this replica's: ${listSlotsStatement()}` : "look for Mason's slots on each database it synced with the statement printed above, and drop this replica's",
      next: [listStep(r.org)] }),
    goneSaid: "by hand, on each database it synced: this lists Mason's replication slots; drop this replica's slot from them, as a user that may drop a replication slot",
  };
}

async function remove(r: Replica, o: { timeout: { every: string; seconds: number }; yes: boolean }, json: boolean): Promise<number> {
  const name = replicaText(r);
  const s = signedIn("a replica is deleted", `mason replica delete ${name}`, json);
  if (isFailure(s)) return fail(s, json);
  const { service, token } = s, secrets = [token];
  const w = deleteWords(r, service.base, o.timeout.every);
  // A PERSON TYPES IT BACK (else --yes said it on the line): nothing is sent before
  if (!o.yes) {
    say(w.ask);
    if (!(await typedBack(name))) return fail(w.notTyped, json);
  }
  const where = `/v1/replicas/${r.org}/${r.name}`;
  const step = "a replica's deletion was asked for";
  if (!json) say(w.progress);

  // THE DELETION: 202 under way, 200 done already (a repeat changes nothing), else why not, as the service worded it
  const sent = await call(service, "DELETE", where, { token, json: { confirm: name } });
  // its deletion: null while the service gives none (a replica deleting may carry none)
  let state: HostedReplica, deletion: Deletion | null, waitMs = REPLICA_POLL_MS;
  const begun = (x: HostedReplica): boolean => x.state === "deleting" || x.state === "deleted";
  if (isFailure(sent)) {
    // a DELETE that got no answer may have begun it: its state says so
    const a = await call(service, "GET", where, { token });
    const found = !isFailure(a) && a.status === 200 ? replicaAnswer(service, a, r, secrets) : null;
    const why = serviceText(sent.why ?? sent.message, 300, secrets);
    if (found === null || !begun(found.replica)) {
      return fail(w.lostFailure({ ...sent, why }, found !== null ? { state: found.replica.state } : !isFailure(a) && a.status === 404 ? { absent: true } : null), json);
    }
    if (!json) say(w.lost(why, found.deletion));
    state = found.replica; deletion = found.deletion;
    if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
  } else {
    if (sent.status !== 200 && sent.status !== 202) {
      const e = obj(sent.json) && obj(sent.json.error) && typeof sent.json.error.code === "string" ? sent.json.error.code : "";
      return fail(serviceFailure(sent, secrets, (st) => w.refusedNext(st, e, sent.retryAfter)) ?? unexpected(service, sent, step), json);
    }
    const held = replicaAnswer(service, sent, r, secrets);
    // 202 is a deletion under way (its deletion, if the service gives one, not finished), 200 one finished: anything else
    // is outside the contract
    if (held === null || !begun(held.replica) || (sent.status === 202) !== (held.replica.state === "deleting")) return fail(unexpected(service, sent, step), json);
    state = held.replica; deletion = held.deletion;
    if (sent.retryAfter !== null) waitMs = sent.retryAfter * 1000;
  }

  // THE WAIT: until its deletion is finished, bounded by --timeout; each step said once, as it is done
  const deadline = Date.now() + o.timeout.seconds * 1000;
  let said = "", saidAt = 0;
  const told = new Set<string>();
  const show = (line: string): void => { if (!json && sayAgain(line, said, saidAt, Date.now())) { say(`  ${line}`); said = line; saidAt = Date.now(); } };
  const done = (d: Deletion): void => { if (!json) for (const x of d.steps) if (x.doneAt !== null && !told.has(x.step)) { told.add(x.step); say(`  done: ${x.what}`); } };
  const ended = (error: Failure | null): number => {
    const next = error === null ? nextOf(state) : error.next ?? [];
    if (json) { out(jsonText(REPLICA, { replica: state, deletion, ...(error ? { error: errorJson(error) } : {}) }, next)); return error ? exitOf(error) : 0; }
    // finished, or needing a person: what it did to each slot, and the statements by hand (a failure after them says why
    // the exit is 1)
    if (deletion?.stage === "finished" || deletion?.stage === "needs_person") {
      out(deletionReport({ headline: deletion.stage === "finished" ? w.headline : w.waiting, details: deletionRows(deletion), deletion, next: error === null ? next : [] }, outStyle()));
    }
    return error === null ? 0 : fail(error, false);
  };
  for (;;) {
    if (deletion?.stage === "finished") { done(deletion); return ended(null); }
    // a person is needed: nothing more comes of waiting, so it stops at once, whatever --timeout
    if (deletion?.stage === "needs_person") { done(deletion); return ended(w.needsPerson(deletion)); }
    show(deletion ? stageLine(deletion) : w.noDeletion);
    if (deletion) done(deletion);
    const left = deadline - Date.now();
    if (left <= 0) return ended(w.timedOut(deletion));
    await sleep(Math.min(waitMs, left));
    const a = await call(service, "GET", where, { token });
    waitMs = REPLICA_POLL_MS;
    // an answer that cannot say how it goes is a wait, never an outcome: the timeout bounds it
    if (isFailure(a) || a.status === 429 || a.status >= 500) {
      if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
      show(w.unsure(deletion, isFailure(a) ? serviceText(a.why ?? a.message, 300, secrets) : `${a.what} answered ${a.status}`));
      continue;
    }
    if (a.retryAfter !== null) waitMs = a.retryAfter * 1000;
    if (a.status === 404) {
      if (!json) out(pasteLines([[w.goneSaid, listSlotsStatement()]], outStyle()).join("\n"));
      return ended(w.gone(json));
    }
    if (a.status !== 200) return ended(serviceFailure(a, secrets, (st) => refusedNext(st, r.org, "a member", w.status)) ?? unexpected(service, a, step));
    const now = replicaAnswer(service, a, r, secrets);
    // a deletion does not end otherwise than finished: a replica in none now is outside the contract
    if (now === null || !begun(now.replica)) return ended(unexpected(service, a, step));
    state = now.replica; deletion = now.deletion;
  }
}
