/**
 * `mason deploy` — THE PROJECT IN THIS FOLDER SENT TO A REPLICA ON A HOSTED MASON SERVICE, and its outcome waited for
 * (docs/HOSTED-API.md "Deploying a project"). Only the project's files travel: what Mason reads to run it, never this
 * machine's `.env`, `.mason/` or anything else beside them.
 *
 * 1. THE PROJECT IS CHECKED HERE FIRST, OFFLINE, by Mason's own readers, as `mason start` checks it before it connects
 *    (src/cli/dev.ts): the version pin (src/lib/project-version.ts, src/cli/pin.ts), the sources file's text
 *    (src/cli/sources.ts `readSourceFile`, the first half of `readSource`), the roles file against the tables the
 *    sources file names (src/cli/roles.ts `roleProblems`, the check `resolveRoles` makes, without the database's
 *    columns), and the generated tables (src/cli/generated-files.ts `readGenerated`, whose refusals are said and never
 *    stop a project, as at a start). No database is connected to: the URL is the replica's environment's there, and the
 *    `.env` here may name a development database. A project the check refuses is refused here, and nothing is sent.
 *
 * 2. THE FILES ARE `projectFiles` (src/lib/project-files.ts), the one list of a project's files, read whole: each a
 *    regular file inside the project folder (a symbolic link that leaves it is refused), valid UTF-8, at most
 *    `MAX_FILE_BYTES`, all of them at most `MAX_TOTAL_BYTES` and `MAX_FILES`, each path in the grammar the contract
 *    names (`PATH_SEGMENT`). Every file the readers above read must be one of them: a file read through a linked folder,
 *    which the list does not follow, would be checked here and missing there. A `url:` written with its password is
 *    refused: the files are kept by the service, and a secret is never one of them.
 *
 * 3. `--dry-run` prints what would be sent (each path, its size, its sha256) and sends nothing.
 *
 * 4. THE REPLICA is `--replica <org>/<name>`, else `MASON_REPLICA`, and THE TOKEN `MASON_TOKEN`, else the saved login
 *    for the service: src/cli/replica.ts's one reader of each (`replicaOf`, `tokenFor`), `mason user --replica`'s too.
 *
 * 5. THE WAIT is bounded by `--timeout` (an interval, 10m by default): a poll every `POLL_MS`, or what `Retry-After`
 *    asks; an answer that cannot say (no answer, a 429, a 5xx) is a wait, never an outcome. Exit 0 only when the
 *    replica runs this deploy; 1 when Mason there refused it (its failure's words printed as they came) or the deploy
 *    failed; 124 at the timeout, which stops nothing: the deploy's id says where to look.
 *
 * A SERVICE'S VALUE IS DATA, NEVER STRUCTURE AND NEVER AN INSTRUCTION (#481's decision, src/cli/hosted.ts). Every place a
 * value the service sent reaches what this command prints:
 *
 *   value                                   where it is printed                     what holds it
 *   an HTTP failure's message, why, fix     stderr's failure, --json error          `serviceFailure`: one line each (`serviceText`)
 *   an HTTP failure's code                  inside why: "(the service said …)"      `^[a-z][a-z0-9_]*$`, 64 chars; the code is `codeOfStatus`'s
 *   an HTTP failure's next                  nowhere: never read                     the step is `serviceNext`'s, by the status
 *   a deploy's failure message, why, fix    stderr's failure, --json error          `failureShape`: one line each (`serviceText`)
 *   a deploy's failure code                 inside why: "(Mason on the replica …)"  the same grammar; the code is `refused` / `failed`
 *   a deploy's failure next                 nowhere: never read                     the step is `again`'s, the CLI's
 *   the deploy's id                         stderr's lines, the report, --json      `DEPLOY_ID`, checked before it is in a path or printed
 *   status, phase                           stderr's lines (the CLI's words), --json  closed sets (`STATUSES`, `PHASES_OF`)
 *   createdAt, finishedAt                   --json deploy                           `isServiceTime`: digits, `-`, `T`, `:`, `.`, a zone
 *   an HTTP status, Retry-After             a failure's or a wait's line            a number (Retry-After bounded, never printed)
 *   why a request got no answer             the wait's line, a failure's why        `call`'s own words, through `serviceText`
 *
 * So no value of the service's starts a line, adds a row or a step to run next, or puts a line break in --json. AND NO
 * GRAMMAR IS EVER THE ONLY THING BETWEEN A SECRET AND THE OUTPUT (issue 627: `DEPLOY_ID` took the token whole, and the
 * id was printed): before any of the grammars above, every string of the POST's answer and of each poll's, each key
 * included, is put to the exact test (src/cli/hosted.ts `carriesNoSecret`: an echo of the token, `ECHO_RUN` of its body
 * in a row in one string; a token's or a password's shape), and an answer that carries one is refused whole, said by its
 * status. A failure's words (message, why, fix) alone are free text, masked by `serviceText` as every failure's are; its
 * code is put to the same test (`failureShape`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { errorJson, exitOf, failed, jsonText, parseCommand, reportText, serviceStyle, strict, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { call, carriesNoSecret, failureShape, isFailure, isServiceTime, serviceFailure, serviceOf, serviceText, unexpected } from "./hosted.ts";
import { replicaOf, replicaText, REPLICA_ENV, tokenFor, type Replica } from "./replica.ts";
import { maskedUrl } from "./preflight.ts";
import { folderPlace, theProject, type Project } from "./project.ts";
import { commandPinProblem } from "./pin.ts";
import { readPin } from "../lib/project-version.ts";
import { projectFiles } from "../lib/project-files.ts";
import { readSourceFile, shownPath } from "./sources.ts";
import { readRoles, roleProblems, rolesFailure, rolesFile } from "./roles.ts";
import { readGenerated } from "./generated-files.ts";
import { refusalText } from "../duck/generated-plan.ts";
import { parseDuration } from "../lib/table-sync.ts";
import { textEntry } from "../lib/log.ts";
import { sayAgain } from "./commands.ts";
import { err as styleErr, out as styleOut, stepRenderer, type Style } from "./style.ts";
import { version } from "./version.ts";

/** The bounds of what a deploy sends: one file, all of them, how many. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
export const MAX_FILES = 500;
/** One part of a sent path: what the contract takes (a dotfile is never a project file). */
export const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_PATH = 255;
/** How often the deploy's state is asked for, when the service asks no other. */
export const POLL_MS = 2_000;
const DEFAULT_TIMEOUT = "10m";
/** A deploy's id, as it goes into a path: the contract's grammar. */
const DEPLOY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = ["queued", "applying", "starting", "running", "refused", "failed"] as const;
type Status = typeof STATUSES[number];
const FINAL: ReadonlySet<Status> = new Set(["running", "refused", "failed"]);

/** Everything this command prints can hold the service's text, so it is ALL drawn in serviceStyle (src/cli/command.ts):
 *  on a terminal every line is broken by the CLI at the width, never by the terminal, each continuation at column 4 or
 *  deeper — the report, the progress, the spinner's line, a failure and a warning alike. */
const outStyle = (): Style => serviceStyle(styleOut());
const errStyle = (): Style => serviceStyle(styleErr());
const out = (m: string): void => { process.stdout.write(`${m}\n`); };
/** Progress on stderr, a line or several: on a terminal through the strict renderer's last pass (`strict`,
 *  src/cli/command.ts), every line within the terminal's width whatever it is, each continuation where no line of the
 *  CLI's starts — the phase lines, a step's end (its ✔ or ✘ line), the wait's note and a warning alike. */
const say = (m: string): void => { process.stderr.write(`${strict(m, errStyle())}\n`); };
/** A step's label as the spinner draws it on one line (`⠋ label …`, six columns beside it): cut to fit within the
 *  terminal's width, never reaching its edge; null when not even a word fits, and then no spinner turns. */
const clipped = (label: string): string | null => {
  const width = errStyle().columns;
  if (width === undefined) return label;
  const room = width - 1 - 6, chars = [...label];
  if (room < 8) return null;
  let n = 0, i = 0;
  for (; i < chars.length; i++) { n += chars[i]!.codePointAt(0)! <= 0x7e ? 1 : 2; if (n > room) break; }
  return i < chars.length ? `${chars.slice(0, Math.max(0, i - 1)).join("")}…` : label;
};
/** A failure said for a person in serviceStyle, or under --json as data. */
const fail = (f: Failure | Parameters<typeof failed>[1], o: { json: boolean }): number => failed("deploy", f, { json: o.json, style: errStyle() });

export const DEPLOY: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "deploy",
  summary: "send this project to a replica on a hosted Mason service, and wait until the replica runs it",
  usage: `usage: mason deploy [--replica <org>/<name>] [--dry-run] [--timeout <interval>] [--json]

  Sends this project's files (what mason/ holds that Mason reads: the sources file, mason.yml, roles.yml, the
  generated tables — never .env, .mason/, a dotfile or a file that is not YAML) to a replica on a hosted Mason
  service, then waits until Mason on the replica runs them, or refuses them. The project is checked here first, as
  mason start checks it, without connecting to any database (the replica's own environment names its URL); a
  project that would be refused is refused here, and nothing is sent. A url: written with its password is refused:
  write url: \${DATABASE_URL} and set it on the replica.

  The replica is --replica <org>/<name>, else MASON_REPLICA (each part lower case letters, digits and -). The login
  is MASON_TOKEN, else this machine's (mason login); the service is MASON_CLOUD_URL, else the default. Progress
  goes to stderr; the answer is printed when it ends.

    mason deploy --replica acme/shop
    mason deploy --replica acme/shop --dry-run     what would be sent, sending nothing
    MASON_REPLICA=acme/shop mason deploy --timeout 30m

  --replica <org>/<name>   the replica to deploy to (else MASON_REPLICA)
  --dry-run                print each file that would be sent, its size and its sha256, and send nothing (no
                           login needed)
  --timeout <interval>     how long to wait for the outcome (default ${DEFAULT_TIMEOUT}; 1s to 24h); the deploy goes on after it
  --json                   as data, once it ends: { dryRun, replica (null when none is named on a dry run),
                           service, files: [{ path, size, sha256 }], totalBytes, warnings (the generated tables
                           refused, as mason start says them, each one line), deploy ({ id, status (queued,
                           applying, starting, running, refused, failed), phase (null, checking, writing,
                           restarting, syncing), createdAt, finishedAt };
                           null on a dry run), error (when the replica refused it, it failed or the wait timed out:
                           { code, message, why, fix }), next }

  Exit status: 0 the replica runs it (or a dry run printed); 1 refused here or by the service, refused by Mason on
  the replica (its words printed as they came, the code the CLI's own), the deploy failed, or the service answered
  outside its contract; 2 a wrong command line; 124 the wait timed out (nothing stopped: the deploy's id says where
  to look). Whatever the service sends, it never makes the exit 0, 2 or 124.
`,
  options: { replica: { type: "string" }, "dry-run": { type: "boolean", default: false }, timeout: { type: "string" }, json: { type: "boolean", default: false } },
  json: ["dryRun", "replica", "service", "files", "totalBytes", "warnings", "deploy", "error", "next"],
};

/** A file as it is sent: its path (relative to the project folder, `/` between its parts), size in bytes, sha256 of its
 *  bytes (lower case hex), and its text. */
export interface DeployFile { path: string; size: number; sha256: string; content: string }

/** What the project's check says beside a pass: the generated tables refused (said, as a start says them). */
export interface Checked { warnings: string[] }

/** A `url:` that carries a password: in the URL's user part, or as a `password=` parameter. */
function writesPassword(url: string): boolean {
  return maskedUrl(url) !== url || /(?:^|[\s?&;])password\s*=/i.test(url);
}

/**
 * THE PROJECT CHECKED AS `mason start` CHECKS IT BEFORE IT CONNECTS, offline: the pin, the sources file, the roles
 * file against the tables the sources file names, the generated tables (said, never refusing). A Failure for what a
 * start would refuse; else the warnings, and every file the check read (each must be among the files sent).
 */
export function checkProject(p: Project, cliVersion: string = version()): (Checked & { read: string[] }) | Failure {
  const read: string[] = [];
  // the pin: a mason.yml that cannot be read is refused whatever this command's version (a checkout's `dev` checks no
  // version, and the replica's image reads the same file)
  const pin = readPin(p.folder);
  if ("problem" in pin) return { message: pin.problem, code: "refused", fix: `edit ${shownPath(p.root, pin.file)}: write version: <x.y.z>, the Mason version the project is written for` };
  if (pin.pin !== null) read.push(pin.file);
  const pinned = commandPinProblem(p.folder, cliVersion);
  if (pinned) return { message: pinned.problem, code: "refused", ...(pinned.ways.length ? { fix: pinned.ways.join("; or ") } : {}) };

  const src = readSourceFile(p.folder, p.root);
  if ("message" in src) return src;
  read.push(src.file);
  if ("literal" in src.url && writesPassword(src.url.literal)) {
    const shown = shownPath(p.root, src.file);
    return { message: `${shown}: url: is written with its password`, code: "refused",
      why: "a deploy sends the project's files to the service, which keeps them: a password is never one of them",
      fix: `write url: \${DATABASE_URL} in ${shown}, and set DATABASE_URL on the replica (its own environment, on the service); keep the URL here in .env` };
  }

  const generated = readGenerated(p.folder, p.root);
  for (const g of [...generated.definitions, ...generated.refused]) read.push(path.resolve(p.root, g.file));
  const warnings = generated.refused.flatMap((g) => g.refusals.map((r) => refusalText(g.file, r)));

  const roles = readRoles(p.folder, p.root);
  if (roles !== null && "message" in roles) return roles;
  if (roles !== null) {
    read.push(rolesFile(p.folder));
    // the tables the sources file names and the generated tables, as the start holds the roles to them — their columns
    // are the database's, which a deploy does not read: the replica's start holds them
    const named = [...src.tables.map((e) => ({ source: e.table, columns: null })),
      ...[...generated.definitions, ...generated.refused].map((g) => ({ source: g.name, columns: [], pending: true as const }))];
    const problems = roleProblems(roles, named);
    if (problems.length) return rolesFailure(roles.file, p.root, problems);
  }
  return { warnings, read };
}

const bytes = (n: number): string => `${n.toLocaleString("en-US")} bytes`;

/** A file refused, with the way out. */
const refuse = (message: string, why: string, fix: string): Failure => ({ message, code: "refused", why, fix });

/**
 * THE PROJECT'S OWN FOLDER, or why a deploy sends nothing from it: its files must be a folder strictly inside the
 * project's root (`folderPlace`, src/cli/project.ts, the one authority, which `mason init` asks too). Its root itself
 * (`"folder": "."`, mason init --folder .) is the application's folder, and anything outside the root (`..`, `../app`,
 * an absolute path, a link that leaves it) is anyone's: a deploy would send every .yml and .yaml there. Fail closed:
 * asked before any of those files is read.
 */
export function ownFolderRefusal(p: Project): Failure | null {
  const place = folderPlace(p.root, p.folder);
  if (place.place === "inside") return null;
  const config = shownPath(p.root, path.join(p.dir, "config.json"));
  // the config's value as it is written, bounded (a path may be long)
  const named = JSON.stringify(p.config.folder.length > 200 ? `${p.config.folder.slice(0, 200)}…` : p.config.folder);
  const fix = `move mason.yml, roles.yml, sources/ and generated_tables/ into a folder of their own inside ${p.root} (mason/), and set "folder": "mason" in ${config}`;
  // a place that cannot be told is refused, saying it could not tell (fail closed), never thrown
  if (place.place === "unknown") {
    return refuse(`this project's files cannot be found: ${config} names "folder": ${named}, which cannot be resolved`, place.why,
      `set "folder" in ${config} to the project's folder, a folder of its own inside ${p.root} (mason, as mason init writes it)`);
  }
  return place.place === "root"
    ? refuse("this project's files are its folder's own (mason init --folder .), beside the application's",
      "a deploy sends every .yml and .yaml under the project's files, and here that is every one of the application's", fix)
    : refuse(`this project's files are outside its folder (${config} names ${named}, which is ${p.folder.length > 300 ? `${p.folder.slice(0, 300)}…` : p.folder})`,
      `a deploy sends every .yml and .yaml under the project's files, and outside ${p.root} that is anyone's`, fix);
}

/**
 * THE FILES A DEPLOY SENDS: `projectFiles` of the project folder, each read and held to the contract's bounds, and
 * every file the check read among them. A Failure naming the file and the bound otherwise.
 */
export function deployFiles(p: Project, read: readonly string[]): DeployFile[] | Failure {
  const folder = p.folder, shownFolder = `${shownPath(p.root, folder)}/`;
  // never a file of a folder that is not the project's own, whoever calls this (deploy() asks first, before the check)
  const own = ownFolderRefusal(p);
  if (own !== null) return own;
  let list: string[], realFolder: string;
  try { list = projectFiles(folder); realFolder = fs.realpathSync(folder); }
  catch (e) { return { message: `the project's files in ${shownFolder} cannot be listed`, code: "failed", why: (e as Error).message, fix: "make the folder readable, then mason deploy again" }; }
  if (list.length > MAX_FILES) return refuse(`${shownFolder} has ${list.length} project files, over the ${MAX_FILES} a deploy sends`, "a project file is any .yml or .yaml under it", `move the files Mason does not read out of ${shownFolder}`);
  const files: DeployFile[] = [];
  let total = 0;
  for (const file of list) {
    const shown = shownPath(p.root, file);
    const rel = path.relative(folder, file).split(path.sep).join("/");
    const parts = rel.split("/");
    if (rel.length > MAX_PATH || !parts.every((s) => PATH_SEGMENT.test(s))) {
      return refuse(`${shown}: its path is not one a deploy sends`, `each part of a path is letters, digits, ., _ and -, starting with a letter, a digit or _, and the path at most ${MAX_PATH} characters`, "rename it (a generated table's file is named for its table)");
    }
    let real: string, st: fs.Stats;
    try { real = fs.realpathSync(file); st = fs.statSync(real); }
    catch (e) { return { message: `${shown} cannot be read`, code: "failed", why: (e as Error).message, fix: "make it readable, or move it out of the project folder" }; }
    const inside = path.relative(realFolder, real);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
      return refuse(`${shown} is a symbolic link to ${real}, outside the project folder`, "a deploy sends the project folder's own files, and never follows a link out of it", `put the file itself in ${shownFolder}, or remove the link`);
    }
    if (!st.isFile()) return refuse(`${shown} is not a file`, "a project file is a regular file", `move it out of ${shownFolder}`);
    if (st.size > MAX_FILE_BYTES) return refuse(`${shown} is ${bytes(st.size)}, over the ${bytes(MAX_FILE_BYTES)} (256 KiB) a deploy sends of one file`, "a project's files name tables, columns and SQL: none is that large", `shorten it, or move it out of ${shownFolder} if Mason does not read it`);
    let buf: Buffer;
    try { buf = fs.readFileSync(real); }
    catch (e) { return { message: `${shown} cannot be read`, code: "failed", why: (e as Error).message, fix: "make it readable, or move it out of the project folder" }; }
    if (buf.length > MAX_FILE_BYTES) return refuse(`${shown} is ${bytes(buf.length)}, over the ${bytes(MAX_FILE_BYTES)} (256 KiB) a deploy sends of one file`, "it grew while it was read", "mason deploy again once it is written");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { return refuse(`${shown} is not UTF-8 text`, "a deploy sends each file as UTF-8 text, as Mason reads it", "save it as UTF-8"); }
    total += buf.length;
    files.push({ path: rel, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), content });
  }
  if (total > MAX_TOTAL_BYTES) {
    const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 3).map((f) => `${f.path} ${bytes(f.size)}`).join(", ");
    return refuse(`the project's files are ${bytes(total)} in all, over the ${bytes(MAX_TOTAL_BYTES)} (1 MiB) a deploy sends`, `the largest: ${largest}`, `move the files Mason does not read out of ${shownFolder}`);
  }
  // every file the check read is sent: one read through a linked folder, which the list does not follow, would be
  // checked here and missing on the replica
  const sent = new Set(list.map((f) => path.resolve(f)));
  const missing = read.filter((f) => !sent.has(path.resolve(f)));
  if (missing.length) {
    return refuse(`${shownPath(p.root, missing[0]!)} is read by Mason, and is not among the files a deploy sends`, "a folder of the project is a symbolic link, which a deploy does not follow",
      `replace the link with the folder itself, inside ${shownFolder}`);
  }
  return files;
}

/** A deploy's phase within its status: a closed set, each said in the CLI's own words (never the service's text). */
export const PHASES = {
  checking: "Mason on the replica checks the files",
  writing: "the files are written on the replica",
  restarting: "Mason on the replica restarts on them",
  syncing: "the tables the files add have their first sync",
} as const;
type Phase = keyof typeof PHASES;
/** The phases each status may carry; a phase beside any other status is outside the contract. */
const PHASES_OF: Partial<Record<Status, readonly Phase[]>> = { applying: ["checking", "writing"], starting: ["restarting", "syncing"] };

/** The deploy as the service says it (docs/HOSTED-API.md), its status and phase each one of the contract's closed set. */
export interface DeployState { id: string; status: Status; phase: Phase | null; createdAt: string; finishedAt: string | null; failure: Failure | null }

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `{ deploy: { … } }` held to its shape, the id this command asked for (or, for the POST's answer, one in `DEPLOY_ID`'s
 * grammar, since it goes into the next request's path); null when it is not that shape. Nothing in it steers the CLI:
 * the status and the phase are each one of a closed set, and a refusal's or a failure's words are one line each, its code
 * the CLI's own (`refused`, `failed`, by the status), the service's kept in `why`, and its next step `again`, the CLI's:
 * the service's `next` is never read.
 */
export function deployStateOf(json: unknown, id: string | null, secrets: readonly string[], again: NextStep[]): DeployState | null {
  if (!obj(json) || !obj(json.deploy)) return null;
  const d = json.deploy;
  // BEFORE ANY GRAMMAR, every string of the answer, each key included, to the exact test (src/cli/hosted.ts
  // `carriesNoSecret`, issue 627: an id its grammar took was the token whole, and printed): the id, the status, the
  // phase, the times, the failure's code, a key outside the shape. A failure's words alone are left to its mask
  // (`failureShape`), as every failure's are.
  const words = obj(d.failure) ? { ...json, deploy: { ...d, failure: { ...d.failure, message: null, why: null, fix: null } } } : json;
  if (!carriesNoSecret(words, secrets)) return null;
  if (typeof d.id !== "string" || !DEPLOY_ID.test(d.id) || (id !== null && d.id !== id)) return null;
  if (typeof d.status !== "string" || !(STATUSES as readonly string[]).includes(d.status)) return null;
  const status = d.status as Status;
  let phase: Phase | null = null;
  if (d.phase !== undefined && d.phase !== null) {
    if (typeof d.phase !== "string" || !(PHASES_OF[status] ?? []).includes(d.phase as Phase)) return null;
    phase = d.phase as Phase;
  }
  if (!isServiceTime(d.createdAt) || (d.finishedAt !== undefined && d.finishedAt !== null && !isServiceTime(d.finishedAt))) return null;
  // a refusal or a failure carries the failure shape (its code, message, why, fix and next in one object), and nothing else does
  let failure: Failure | null = null;
  if (status === "refused" || status === "failed") {
    if (!obj(d.failure)) return null;
    failure = failureShape(d.failure, secrets, status === "refused"
      ? { code: "refused", said: (c) => `Mason on the replica said ${c}`, next: again }
      : { code: "failed", said: (c) => `the service said ${c}`, next: again });
    if (failure === null) return null;
  } else if (d.failure !== undefined && d.failure !== null) return null;
  return { id: d.id, status, phase, createdAt: d.createdAt, finishedAt: typeof d.finishedAt === "string" ? d.finishedAt : null, failure };
}

/** A status for a person, its phase beside it. */
const STATUS_WORDS: Record<Status, string> = {
  queued: "Queued: waiting for its turn on the replica",
  applying: "Applying: Mason on the replica checks and takes the files",
  starting: "Starting: Mason on the replica starts on the new files",
  running: "Running: the replica runs the new files",
  refused: "Refused by Mason on the replica",
  failed: "The deploy failed",
};
const NEXT_AGAIN = (r: Replica): NextStep[] => [[`mason deploy --replica ${replicaText(r)}`, "deploy again, after the next edit"]];
const stateLine = (s: DeployState): string => `${STATUS_WORDS[s.status]}${s.phase ? ` (${PHASES[s.phase]})` : ""}`;

export async function deploy(argv: string[]): Promise<number> {
  const f = parseCommand(DEPLOY, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const dryRun = f.values["dry-run"] === true;
  if (f.positionals.length) return fail({ message: "it takes no argument", code: "usage", why: "the project is the folder's, the replica --replica's", usage: DEPLOY.usage }, { json });
  const timeoutText = typeof f.values.timeout === "string" ? f.values.timeout : DEFAULT_TIMEOUT;
  const timeout = parseDuration(timeoutText);
  if ("problem" in timeout) return fail({ message: `--timeout ${timeout.problem}`, code: "usage", usage: DEPLOY.usage }, { json });
  const replica = replicaOf(typeof f.values.replica === "string" ? f.values.replica : undefined, DEPLOY.usage);
  if (replica !== null && isFailure(replica)) return fail(replica, { json });
  if (replica === null && !dryRun) {
    return fail({ message: "no replica named", code: "usage", why: "a deploy goes to one replica of the service",
      fix: `name it: mason deploy --replica <org>/<name>, or set ${REPLICA_ENV}=<org>/<name>`, usage: DEPLOY.usage }, { json });
  }
  const service = serviceOf();
  if (isFailure(service)) return fail(service, { json });

  // THE PROJECT, checked as a start checks it, offline; then its files
  const t = theProject(process.cwd());
  if ("problem" in t) return fail(t, { json });
  const project = t.project;
  // the project's own folder first: nothing of a folder that is not one is read, let alone sent
  const own = ownFolderRefusal(project);
  if (own !== null) return fail(own, { json });
  const checked = checkProject(project);
  if (isFailure(checked)) return fail(checked, { json });
  const files = deployFiles(project, checked.read);
  if (isFailure(files)) return fail(files, { json });
  const totalBytes = files.reduce((n, x) => n + x.size, 0);
  const listed = files.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 }));
  // --json carries each warning as one line (a string with no line break); a person reads its lines on stderr
  const base = { replica: replica === null ? null : replicaText(replica), service: service.base, files: listed, totalBytes,
    warnings: checked.warnings.map((w) => w.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")) };
  if (!json) for (const w of checked.warnings) say(textEntry("  ! ", w).trimEnd());

  if (dryRun) {
    const next: NextStep[] = replica === null
      ? [["mason deploy --replica <org>/<name>", "send it to a replica"]]
      : [[`mason deploy --replica ${replicaText(replica)}`, "send it"]];
    if (json) { out(jsonText(DEPLOY, { dryRun: true, ...base, deploy: null }, next)); return 0; }
    const w = Math.max(...files.map((x) => x.path.length)), sw = Math.max(...files.map((x) => bytes(x.size).length));
    out(reportText({
      headline: `Would send ${files.length} file${files.length === 1 ? "" : "s"}, ${bytes(totalBytes)}, ${replica === null ? `to ${service.base} (no replica named)` : `to ${replicaText(replica)} on ${service.base}`}; nothing was sent`,
      details: files.map((x): [string, string] => [x.path.padEnd(w), `${bytes(x.size).padStart(sw)}   sha256 ${x.sha256}`]),
      next,
    }, outStyle()));
    return 0;
  }
  const r = replica!;
  const token = tokenFor(service, { asked: "a deploy is sent", again: "mason deploy" });
  if (isFailure(token)) return fail(token, { json });
  const secrets = [token];
  const where = `/v1/replicas/${r.org}/${r.name}/deploys`;
  const started = Date.now(), deadline = started + timeout.seconds * 1000;

  // THE DEPLOY, SENT: 201 and its id, else the service's failure as it worded it
  const sent = await call(service, "POST", where, { token, json: { files: files.map(({ path: p, sha256, content }) => ({ path: p, sha256, content })), client: { version: version() } } });
  if (isFailure(sent)) {
    return fail({ ...sent, why: `${sent.why ?? ""}${sent.why ? "; " : ""}whether the deploy was made is not known`,
      fix: `${sent.fix ?? "check this machine is online"}, then mason deploy again (a deploy still running is refused as busy)` }, { json });
  }
  if (sent.status !== 201) return fail(serviceFailure(sent, secrets) ?? unexpected(service, sent, "a deploy was sent"), { json });
  // what to run after a refused or failed deploy: the CLI's own step, never one the service names
  const again: NextStep[] = [[`mason deploy --replica ${replicaText(r)}`, "deploy again, once what it says is fixed"]];
  const first = deployStateOf(sent.json, null, secrets, again);
  if (first === null || first.status !== "queued") return fail(unexpected(service, sent, "a deploy was sent"), { json });
  const id = first.id;
  const s = errStyle();
  // a spinner turns only on a terminal wide enough for a label beside its frame; else each line is said once, as on a pipe
  const terminal = !json && process.stderr.isTTY === true && clipped("x") !== null;
  const steps = stepRenderer({ line: say, live: terminal ? process.stderr : null, style: s });
  if (!json) say(`Sent ${files.length} file${files.length === 1 ? "" : "s"} (${bytes(totalBytes)}) to ${replicaText(r)} on ${service.base}: deploy ${id}`);

  // THE WAIT: a line when the state changes (and every 30 s while it does not), a spinner beside it on a terminal
  let state = first, said = "", saidAt = 0, unsure: string | null = null, unsureSaid: string | null = null;
  const show = (line: string): void => {
    if (json) return;
    // on a terminal: the step that ends is said whole (a line the CLI breaks), the one that turns cut to one line
    if (terminal) { if (line !== said) { if (said !== "") steps.done(said); steps.begin(clipped(line)!); said = line; } return; }
    if (sayAgain(line, said, saidAt, Date.now())) { say(`  ${line}`); said = line; saidAt = Date.now(); }
  };
  show(stateLine(state));
  let waitMs = sent.retryAfter !== null ? sent.retryAfter * 1000 : POLL_MS;
  const ended = (error: Failure | null): number => {
    const value = { dryRun: false, ...base, deploy: { id, status: state.status, phase: state.phase, createdAt: state.createdAt, finishedAt: state.finishedAt } };
    if (json) {
      if (error === null) { out(jsonText(DEPLOY, value, NEXT_AGAIN(r))); return 0; }
      out(jsonText(DEPLOY, { ...value, error: errorJson(error) }, error.next ?? []));
      return exitOf(error);
    }
    // the step it ended on: the outcome's own line when it has one, else (a timeout, an answer outside the contract) the last
    const line = FINAL.has(state.status) ? stateLine(state) : null;
    // (on a terminal the step turning is ticked and the outcome is a line of its own; a refusal replaces the step it ended)
    if (terminal) {
      if (error === null) { if (line !== null && line !== said) { steps.done(said); steps.begin(clipped(line)!); said = line; } steps.done(said); }
      else steps.fail(line ?? said);
    }
    else if (line !== null && line !== said) say(`  ${line}`);
    if (error !== null) return fail(error, { json: false });
    out(reportText({ headline: `Deployed to ${replicaText(r)}: the replica runs it`,
      details: [["deploy", id], ["service", service.base], ["files", `${files.length} (${bytes(totalBytes)})`], ["took", `${Math.max(1, Math.round((Date.now() - started) / 1000))} s`]],
      next: NEXT_AGAIN(r) }, outStyle()));
    return 0;
  };
  for (;;) {
    if (FINAL.has(state.status)) {
      if (state.status === "running") return ended(null);
      // Mason on the replica refused it, or it failed: its words as they came, never re-worded; its code the CLI's (exit 1)
      return ended(state.failure!);
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return ended({ message: `deploy ${id} to ${replicaText(r)} did not finish within ${timeout.every}`, code: "timeout",
        why: unsure !== null ? `the service could not say how it is going: ${unsure}` : `it was last: ${stateLine(state)}`,
        fix: `nothing was stopped, and it may still finish: the service's web app shows deploy ${id} of ${replicaText(r)}, as GET ${where}/${id} does (the hosted API); a longer wait is --timeout 30m`,
        next: [] });
    }
    await sleep(Math.min(waitMs, left));
    const a = await call(service, "GET", `${where}/${id}`, { token });
    waitMs = POLL_MS;
    // an answer that cannot say how it goes is a wait, never an outcome: the timeout bounds it
    if (isFailure(a) || a.status === 429 || a.status >= 500) {
      unsure = isFailure(a) ? serviceText(`${a.message}${a.why ? ` (${a.why})` : ""}`, 300, secrets) : `${a.what} answered ${a.status}`;
      if (!isFailure(a) && a.retryAfter !== null) waitMs = a.retryAfter * 1000;
      // on a terminal a note above the turning step, which goes on (the step is not over); elsewhere the step's line again
      if (terminal) { if (unsure !== unsureSaid) steps.print(s.dim(`  the service could not say more just now (${unsure}): asking again`)); unsureSaid = unsure; }
      else show(`${stateLine(state)}; the service could not say more just now (${unsure}): asking again`);
      continue;
    }
    if (a.retryAfter !== null) waitMs = a.retryAfter * 1000;
    // a refusal of the question (the token revoked meanwhile, the replica gone) is the service's, as it worded it
    if (a.status !== 200) return ended(serviceFailure(a, secrets) ?? unexpected(service, a, "the deploy's state was asked for"));
    const now = deployStateOf(a.json, id, secrets, again);
    if (now === null) return ended(unexpected(service, a, "the deploy's state was asked for"));
    state = now; unsure = null; unsureSaid = null;
    if (!FINAL.has(state.status)) show(stateLine(state));
  }
}
