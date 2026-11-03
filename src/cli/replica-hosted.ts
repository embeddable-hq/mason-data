/**
 * `mason replica create | list | status` — A HOSTED MASON SERVICE'S REPLICAS, by its documented API alone
 * (docs/HOSTED-API.md "Replicas"). Each is a client of it, as `mason deploy` and `mason user --replica` are:
 *
 *   create <org>/<name>   POST /v1/replicas/{org}  { name, region, sizeGb, sources: [{ name, variable, url }] }
 *                         201 { replica, checks }, then GET …/{name} until it is ready, failed or past --timeout
 *   list [<org>]          GET  /v1/replicas/{org}  { replicas, more } — each organisation of the login's when none is named
 *   status <org>/<name>   GET  /v1/replicas/{org}/{name}  { replica }
 *
 * THE DATABASE'S URL (create) is read here alone, by the variable the project's sources file names (`url: ${NAME}`,
 * src/cli/sources.ts `readSource`, the one reader: `.env.local`, `.env`, then the shell), never from a flag: it never
 * reaches a command line, a log, the output or --json. It is sent once, in the creation's body, for Mason's checks of
 * the source on the replica's side, and the variable's NAME beside it, which the replica reads it by. A `url:` written
 * in the file is refused: the replica has no variable to read it from, and a literal would be kept in the project's files.
 * Its password is held as a secret of this command beside the token (`urlSecrets`): masked wherever the service's text
 * is printed, and, from `ECHO_RUN` characters, refused by the exact test and the output's gate as the token is.
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
 *   a check's name, detail, fix; missing;   stderr's lines, --json                    one line each, bounded, masked (`serviceText`)
 *     a pending change's failure
 *   a check's source                        stderr's lines, --json                    the source sent
 *
 * What to run next, the code and the exit are the CLI's own: 0 once the replica is ready (create) or said (list,
 * status); 1 refused (its words as they came), not made, failed or an answer outside the contract; 2 a wrong line;
 * 124 the wait timed out (nothing stopped: `mason replica status` says how it goes).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { endText, errorJson, exitOf, failed, jsonText, parseCommand, reportText, serviceStyle, strict, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { call, carriesNoSecret, ECHO_RUN, isFailure, isServiceTime, serviceFailure, serviceOf, serviceText, unexpected, type Answer, type Service } from "./hosted.ts";
import { loginOrgs, orgNamed, REPLICA_PART, replicaNamed, replicaText, tokenFor, type Replica } from "./replica.ts";
import { holdOutput } from "./output-gate.ts";
import { theProject } from "./project.ts";
import { readSource, shownPath } from "./sources.ts";
import { parseSource } from "./preflight.ts";
import { parseDuration } from "../lib/table-sync.ts";
import { sayAgain } from "./commands.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { err as styleErr, out as styleOut, type Style } from "./style.ts";

/** How long the creation's POST may take: the service checks the source before it answers (up to 45 s, the contract). */
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
  pending: Array<{ change: "create" | "allowlist"; state: "pending" | "failed"; attempts: number; failure: string | null; nextAttemptAt: string | null }>;
}
/** Mason's checks of one source, as the service says them, every word one line. */
export interface SourceChecks {
  source: string; outcome: typeof OUTCOMES[number];
  checks: Array<{ name: string; status: typeof CHECK_STATUSES[number]; detail: string; fix: string | null }>; missing: string[];
}

export const REPLICA: CommandSpec = {
  name: "replica",
  summary: "a hosted Mason service's replicas: create one for this project's database, list them, say how one is",
  usage: `usage: mason replica create <org>/<name> --region <region> --size <gb> [--timeout <interval>] [--json]
       mason replica list [<org>] [--json]
       mason replica status <org>/<name> [--json]

  A replica is Mason run for you by a hosted Mason service, on a machine of its own, syncing this project's
  database. mason deploy then sends it the project's files, and mason token create a CI token for it.

  create makes one in the organisation <org>, named <name>, in --region (one the service offers), sized by
  --size: the synced data it holds, in GB (one size the service offers, such as 50). The database is the one this
  project's sources file names, by its variable (url: \${DATABASE_URL}): its value is read here, from .env.local,
  .env or the shell, and sent once to the service for Mason's checks of the source; it is never taken on the
  command line, never printed and never in --json, and the replica reads it by that variable. A url: written in
  the file is refused: write url: \${DATABASE_URL} and put the URL in .env. create waits until the service has run
  Mason's checks of the database (up to a minute) and says each check, one line each, as the service words them;
  then until its region has made the replica (--timeout bounds that wait; the replica is made all the same).
  An admin or an owner of the organisation creates one. An account's FIRST replica is made in the service's web
  app, where it asks a check that a person is creating it, which a command cannot answer: the service refuses it
  here, and the replicas after it can be made here.

  list says the replicas of <org>, or of every organisation of this login when none is named (a CI token names
  one); status says one replica: its state (checking, creating, ready, failed, deleting, deleted), its region and
  size, its host, its allowlist (the addresses that may query it), and what of its region's work is not done.

  The login is MASON_TOKEN, else this machine's (mason login); the service is MASON_CLOUD_URL, else the default.
  Progress goes to stderr; the answer is printed when it ends.

    mason replica create acme/shop --region eu --size 50
    mason replica list
    mason replica status acme/shop --json

  --region <region>        create: the region it runs in, one the service offers
  --size <gb>              create: the synced data it holds, in GB, one size the service offers (50)
  --timeout <interval>     create: how long to wait for its region to make it (default ${DEFAULT_TIMEOUT}; 1s to 24h)
  --json                   as data, once it ends: { replica (create, status: { org, name, region, sizeGb, hostId,
                           state, createdAt, allowlist, pending: [{ change (create, allowlist), state (pending,
                           failed), attempts, failure, nextAttemptAt }] }), checks (create: [{ source, outcome
                           (passed, failed, unknown), checks: [{ name, status (ok, warn, failed, unknown), detail,
                           fix }], missing }], null when the service's answer was lost), replicas (list: each as
                           replica is), more (list: true when an organisation has more than the service lists),
                           error (create, when it was not made, failed or the wait timed out: { code, message,
                           why, fix }), next }

  Exit status: 0 the replica is ready (create), or said (list, status); 1 not signed in, refused by the service
  (its words printed as they came, the code the CLI's own), not made (the checks failed: each is said), its
  region could not make it, or the service answered outside its contract; 2 a wrong command line; 124 the wait
  timed out (nothing stopped: mason replica status says how it goes). Whatever the service sends, it never
  makes the exit 0, 2 or 124.
`,
  options: { region: { type: "string" }, size: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean", default: false } },
  json: ["replica", "checks", "replicas", "more", "error", "next"],
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
  const replica = (r: unknown): unknown => obj(r) && Array.isArray(r.pending) ? { ...r, pending: r.pending.map((p: unknown) => obj(p) ? { ...p, failure: null } : p) } : r;
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
 * grammar; null when any does not hold. The answer around it has been put to the exact test (`wordless`).
 */
export function heldReplica(v: unknown, asked: { org: string; name?: string }, secrets: readonly string[]): HostedReplica | null {
  if (!obj(v) || v.org !== asked.org || typeof v.name !== "string" || !REPLICA_PART.test(v.name) || (asked.name !== undefined && v.name !== asked.name)) return null;
  if (typeof v.region !== "string" || !REGION.test(v.region) || !whole(v.sizeGb, 1, 1_000_000) || typeof v.hostId !== "string" || !HOST_ID.test(v.hostId)) return null;
  if (typeof v.state !== "string" || !(STATES as readonly string[]).includes(v.state) || !isServiceTime(v.createdAt)) return null;
  if (!Array.isArray(v.allowlist) || v.allowlist.length > MAX_ALLOWLIST || !v.allowlist.every((c) => typeof c === "string" && CIDR.test(c))) return null;
  if (!Array.isArray(v.pending) || v.pending.length > MAX_PENDING) return null;
  const pending: HostedReplica["pending"] = [];
  for (const p of v.pending) {
    if (!obj(p) || (p.change !== "create" && p.change !== "allowlist") || (p.state !== "pending" && p.state !== "failed") || !whole(p.attempts, 0, 1_000_000)) return null;
    if (p.failure !== undefined && p.failure !== null && typeof p.failure !== "string") return null;
    if (p.nextAttemptAt !== undefined && p.nextAttemptAt !== null && !isServiceTime(p.nextAttemptAt)) return null;
    pending.push({ change: p.change, state: p.state, attempts: p.attempts as number, failure: words(p.failure, 500, secrets),
      nextAttemptAt: typeof p.nextAttemptAt === "string" ? p.nextAttemptAt : null });
  }
  return { org: v.org, name: v.name, region: v.region, sizeGb: v.sizeGb as number, hostId: v.hostId, state: v.state as ReplicaState,
    createdAt: v.createdAt as string, allowlist: [...v.allowlist as string[]], pending };
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
    ...r.pending.map((p): [string, string] => ["pending", `${p.change === "create" ? "its creation" : "its allowlist"} ${p.state === "failed" ? "failed" : "is under way"}` +
      ` (${p.attempts} attempt${p.attempts === 1 ? "" : "s"}${p.nextAttemptAt ? `, the next at ${p.nextAttemptAt}` : ""})${p.failure ? `: ${p.failure}` : ""}`]),
  ];
}

const statusStep = (r: Replica | HostedReplica): NextStep => [`mason replica status ${r.org}/${r.name}`, "how it is"];
const nextOf = (r: HostedReplica): NextStep[] => r.state === "ready"
  ? [[`mason deploy --replica ${r.org}/${r.name}`, "send this project to it"], [`mason token create --replica ${r.org}/${r.name}`, "a CI token for it"]]
  : [statusStep(r)];

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

export async function replica(argv: string[]): Promise<number> {
  const f = parseCommand(REPLICA, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string, fix?: string): number => fail({ message, code: "usage", ...(fix ? { fix } : {}), usage: REPLICA.usage }, json);
  const [verb, arg, ...rest] = f.positionals;
  const VERBS = ["create", "list", "status"];
  if (verb === undefined) return usage("create, list or status: mason replica list says the replicas");
  if (!VERBS.includes(verb)) return usage(`there is no mason replica ${verb}: create, list or status${didYouMean(verb, VERBS)}`);
  if (rest.length) return usage(`mason replica ${verb} takes ${verb === "list" ? "one organisation at most" : "one replica"}: ${rest.join(" ")} is too many`);
  for (const k of ["region", "size", "timeout"] as const) if (verb !== "create" && f.values[k] !== undefined) return usage(`--${k} goes with mason replica create`);
  if (verb === "list") {
    const org = arg === undefined ? null : orgNamed(arg, REPLICA.usage);
    if (org !== null && isFailure(org)) return fail(org, json);
    return list(org, json);
  }
  if (arg === undefined) return usage(`mason replica ${verb} names the replica: mason replica ${verb} <org>/<name>`);
  const r = replicaNamed(arg, "argument", REPLICA.usage);
  if (isFailure(r)) return fail(r, json);
  if (verb === "status") return status(r, json);
  const region = typeof f.values.region === "string" ? f.values.region : undefined;
  const size = typeof f.values.size === "string" ? f.values.size : undefined;
  if (region === undefined || size === undefined) return usage(`mason replica create needs ${region === undefined ? "--region" : "--size"}`, "name both: mason replica create <org>/<name> --region <region> --size <gb> (the service's web app lists its regions and sizes)");
  if (!REGION.test(region)) return usage(`--region ${JSON.stringify(serviceText(region, 100))} is not a region's name`, "a region's name is lower case letters, digits and -, as the service lists it");
  if (!SIZE.test(size)) return usage(`--size ${JSON.stringify(serviceText(size, 100))} is not a size`, "a size is a whole number of GB, as the service lists it: --size 50");
  const timeout = parseDuration(typeof f.values.timeout === "string" ? f.values.timeout : DEFAULT_TIMEOUT);
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

/** One replica's answer (`GET …/{name}`), its strings put to the exact test first (`exact`), its words masked (`masks`). */
function replicaAnswer(a: Answer, asked: Replica, exact: readonly string[], masks: readonly string[] = exact): HostedReplica | null {
  if (!obj(a.json) || !carriesNoSecret(wordless(a.json), exact)) return null;
  return heldReplica(a.json.replica, asked, masks);
}

async function status(r: Replica, json: boolean): Promise<number> {
  const s = signedIn("a replica's state is asked for", `mason replica status ${replicaText(r)}`, json);
  if (isFailure(s)) return fail(s, json);
  const { service, token } = s, secrets = [token];
  const a = await call(service, "GET", `/v1/replicas/${r.org}/${r.name}`, { token });
  if (isFailure(a)) return fail(a, json);
  if (a.status !== 200) return fail(serviceFailure(a, secrets, (st) => refusedNext(st, r.org, "a member", statusStep(r))) ?? unexpected(service, a, "a replica's state was asked for"), json);
  const held = replicaAnswer(a, r, secrets);
  if (held === null) return fail(unexpected(service, a, "a replica's state was asked for"), json);
  const next = nextOf(held);
  if (json) { out(jsonText(REPLICA, { replica: held }, next)); return 0; }
  out(reportText({ headline: `${replicaText(r)} on ${service.base}: ${held.state}`, details: rows(held), next }, outStyle()));
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
    for (const v of j.replicas) { const h = heldReplica(v, { org: slug }, secrets); if (h === null) return fail(unexpected(service, a, "the replicas were asked for"), json); replicas.push(h); }
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

/** The URL's password as this command holds it (masked in every service text; from `ECHO_RUN` characters, refused by
 *  the exact test and the output's gate too). `gate`: the secrets for the tests that refuse; `masks`: for serviceText. */
export function urlSecrets(url: string): { masks: string[]; gate: string[] } {
  let password = "";
  try { password = decodeURIComponent(new URL(url).password); } catch { password = ""; }
  const body = password.replace(/[^A-Za-z0-9_-]/g, "");
  // a password shorter than 4 is no secret a mask can keep apart from ordinary words; one shorter than ECHO_RUN would
  // refuse honest text that shares a run with it by chance, so it is masked, never refused (docs/HOSTED-API.md)
  return { masks: body.length >= 4 ? [password] : [], gate: body.length >= ECHO_RUN ? [password] : [] };
}

async function create(r: Replica, o: { region: string; sizeGb: number; timeout: { every: string; seconds: number } }, json: boolean): Promise<number> {
  const again: NextStep = [`mason replica create ${replicaText(r)} --region ${o.region} --size ${o.sizeGb}`, "create it again"];
  // THE DATABASE: the project's sources file names it by a variable, read here by the one reader
  const t = theProject(process.cwd());
  if ("problem" in t) return fail({ message: t.problem, code: t.code, why: t.why ?? "a replica syncs the database this project's sources file names", fix: t.fix, next: t.next }, json);
  const p = t.project;
  const src = readSource(p.folder, p.root);
  if (isFailure(src)) return fail(src, json);
  const file = shownPath(p.root, src.file);
  if ("literal" in src.url) {
    return fail({ message: `${file}: url: is written in the file`, code: "refused",
      why: "a replica reads its database's URL from a variable of its own environment, by the name the sources file gives it; a URL written in the file would also be kept with the project's files",
      fix: `write url: \${DATABASE_URL} in ${file}, and put DATABASE_URL=<the URL> in .env (or export it), then mason replica create again` }, json);
  }
  const variable = src.url.env;
  // the value is held to the grammar Mason connects by before it leaves this machine, never repeated (preflight's rule)
  const parsed = parseSource(src.resolved, `${variable} (${src.from})`);
  if ("problem" in parsed || !/^postgres(?:ql)?:\/\//i.test(src.resolved.trim()) || src.resolved.length > 2048) {
    return fail({ message: `${variable} (${src.from}) is not a database URL a replica can be made for`, code: "refused",
      why: "problem" in parsed ? parsed.problem : "it is sent as postgres://… or postgresql://…, at most 2 KiB",
      fix: `set ${variable} to the database's URL, postgres://user:password@host:5432/your_app` }, json);
  }
  const url = src.resolved;
  const held = urlSecrets(url);
  const s = signedIn("a replica is created", `mason replica create ${replicaText(r)}`, json, held.gate);
  if (isFailure(s)) return fail(s, json);
  const { service, token } = s;
  const secrets = [token, ...held.masks], exact = [token, ...held.gate];
  const where = `/v1/replicas/${r.org}`;
  // a 403 says who may, and where an account's first replica is made (the API refuses it: a person is asked there)
  const refusedOf = (a: Answer, step: string): Failure => serviceFailure(a, secrets, (st) => st === 403
    ? [["mason login", `sign in as an admin or an owner of ${r.org}; an account's first replica is made in the service's web app, ${service.base}`]]
    : refusedNext(st, r.org, "an admin or an owner", again)) ?? unexpected(service, a, step);
  if (!json) say(`Creating ${replicaText(r)} on ${service.base}: Mason checks the database ${variable} names (${src.from}) from the replica's side, up to a minute`);

  // THE CREATION: the service checks the source, then answers 201, or why it was not made (with the checks, said)
  const sent = await call(service, "POST", where, { token, timeoutMs: CREATE_MS,
    json: { name: r.name, region: o.region, sizeGb: o.sizeGb, sources: [{ name: src.name, variable, url }] } });
  let checks: SourceChecks[] | null = null;
  let state: HostedReplica;
  let waitMs = REPLICA_POLL_MS;
  if (isFailure(sent)) {
    // a POST that got no answer may have made the replica: its state says so (the contract)
    const a = await call(service, "GET", `${where}/${r.name}`, { token });
    const found = !isFailure(a) && a.status === 200 ? replicaAnswer(a, r, exact, secrets) : null;
    if (found === null) {
      const known = !isFailure(a) && a.status === 404 ? "asked since, the service has no such replica: it was not made" : "whether it was made is not known";
      return fail({ ...sent, why: `${sent.why ?? "no answer"}; ${known}`, fix: `mason replica status ${replicaText(r)} says whether it was; if not, create it again`, next: [statusStep(r), again] }, json);
    }
    if (!json) say(`  The creation's answer was lost (${sent.why ?? sent.message}); the service has ${replicaText(r)}, ${STATE_WORDS[found.state]}`);
    state = found;
    if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
  } else {
    if (obj(sent.json) && sent.status !== 201 && "checks" in sent.json && carriesNoSecret(wordless({ checks: sent.json.checks }), exact)) checks = heldChecks(sent.json.checks, src.name, secrets);
    if (sent.status !== 201) {
      const f = refusedOf(sent, "a replica was created");
      if (!json && checks !== null) for (const l of checkLines(checks)) say(l);
      // the checks failed: they are Mason's own, which mason doctor runs here against the same database
      const next: readonly NextStep[] = sent.status === 422 ? [["mason doctor", "the same checks of the database, run here"], again] : f.next ?? [];
      const failure = { ...f, next };
      if (json) { out(jsonText(REPLICA, { checks, error: errorJson(failure) }, next)); return exitOf(failure); }
      return fail(failure, false);
    }
    const j = sent.json;
    const made = obj(j) && carriesNoSecret(wordless(j), exact) ? heldReplica(j.replica, r, secrets) : null;
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
    out(reportText({ headline: `Created ${replicaText(r)} on ${service.base}: it is ready`, details: rows(state).filter(([k]) => k !== "state"),
      tips: ["The service does not keep the database's URL: the replica reads it by its variable, from its own environment."], next }, outStyle()));
    return 0;
  };
  for (;;) {
    if (state.state === "ready") return ended(null);
    if (state.state === "failed") {
      const why = state.pending.map((x) => x.failure).filter((x): x is string => x !== null).join("; ");
      return ended({ message: `${replicaText(r)} was not made: its region could not make it, after every attempt`, code: "failed", ...(why ? { why } : {}),
        fix: `an admin or an owner of ${r.org} tries it again on its page in the service's web app (${service.base})`, next: [statusStep(r)] });
    }
    if (state.state === "deleting" || state.state === "deleted") {
      return ended({ message: `${replicaText(r)} is ${state.state === "deleting" ? "being deleted" : "deleted"}`, code: "refused", why: "it was deleted while it was made", fix: `create it again, as ${replicaText(r)} or under another name`, next: [again] });
    }
    show(STATE_WORDS[state.state]);
    const left = deadline - Date.now();
    if (left <= 0) {
      return ended({ message: `${replicaText(r)} was not ready within ${o.timeout.every}`, code: "timeout", why: `it was last ${STATE_WORDS[state.state]}`,
        fix: `nothing was stopped, and its region goes on making it: mason replica status ${replicaText(r)} says how it goes; a longer wait is --timeout 30m`, next: [statusStep(r)] });
    }
    await sleep(Math.min(waitMs, left));
    const a = await call(service, "GET", `${where}/${r.name}`, { token });
    waitMs = REPLICA_POLL_MS;
    // an answer that cannot say how it goes is a wait, never an outcome: the timeout bounds it
    if (isFailure(a) || a.status === 429 || a.status >= 500) {
      if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
      show(`${STATE_WORDS[state.state]}; the service could not say more just now (${isFailure(a) ? serviceText(a.why ?? a.message, 300, secrets) : `${a.what} answered ${a.status}`}): asking again`);
      continue;
    }
    if (a.retryAfter !== null) waitMs = a.retryAfter * 1000;
    if (a.status === 404) {
      return ended({ message: `the service has no ${replicaText(r)} now`, code: "not_found", why: "it was made, and is gone: deleted, or its creation undone",
        fix: `mason replica list ${r.org} says the organisation's replicas`, next: [[`mason replica list ${r.org}`, "the organisation's replicas"]] });
    }
    if (a.status !== 200) return ended(refusedOf(a, "a replica's state was asked for"));
    const now = replicaAnswer(a, r, exact, secrets);
    if (now === null) return ended(unexpected(service, a, "a replica's state was asked for"));
    state = now;
  }
}
