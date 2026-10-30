/**
 * A MASON PROJECT IS A FOLDER (the CLI works like docker's or supabase's: `mason init`, `mason ps`, `mason start` and
 * `mason stop`). `mason init` makes one where it is run:
 *
 *   <root>/.mason/config.json   this machine's: the project's name and the API key (mode 0600, gitignored by init);
 *                               while Mason runs, how the commands reach it
 *   <root>/.mason/              the run's state too: the copy of the data (duck.db), the users, the logs (mason destroy
 *                               empties it, keeping the config and the users)
 *   <root>/<folder>/sources/    the project's files, yours to commit (`mason/` unless init's --folder says otherwise): one
 *                               source file, the database and the tables it copies (src/cli/sources.ts); its URL is
 *                               `${DATABASE_URL}`, from the root's .env (gitignored by init) or the shell
 *
 * Every command but init, doctor and help means the project of the folder it is run in: the nearest `.mason/` at or
 * above it, as git finds `.git`. Nothing is kept in the home folder; the project folder is the only place a project
 * lives (`--project <name>` and `mason list` found a project through its container's labels, and there is no
 * container).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Failure, Problem } from "./command.ts";
import { connectDatabase, databaseSettingRefusal } from "../lib/database-name.ts";
import { changesRetired, pollMsRetired } from "../lib/table-sync.ts";
import { readSource, sourcesTop, writtenDatabase, type ProjectSource } from "./sources.ts";

export const STATE_DIR = ".mason";
const CONFIG = "config.json";

/** A project's name: what its commands call it and (with the source's) what its replication slot is named for. Never
 *  the database name a tool connects with: src/lib/database-name.ts. */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export interface RunningState {
  pid: number;
  /** the run's command server, which the commands ask with `token` (src/cli/control.ts) */
  controlUrl: string;
  token: string;
  /** the Postgres API (docs/POSTGRES-API.md) without credentials, `postgresql://<host>:<port>/<database>`: where mason
   *  start told the listener to listen (src/api/postgres/listener.ts), and what mason user add prints a URL for */
  postgresUrl: string;
  /** how the Postgres API listens (src/cli/pg-tls.ts): the address it is bound to (0.0.0.0 is every address, which the
   *  URL spells localhost) and its TLS — the certificate MASON_PG_TLS_CERT names, the project's self-signed one, or none —
   *  with the certificate's SHA-256 fingerprint. The URL carries `sslmode=require` when it is TLS */
  postgresListener: PostgresListener;
}

export interface PostgresListener { host: string; tls: "certificate" | "self-signed" | null; fingerprint?: string }

export interface ProjectConfig {
  name: string;
  /** the project's files (sources/, mason.yml), relative to the project's root */
  folder: string;
  /** init was told the database is on another machine, on purpose */
  remote: boolean;
  /** what the users' passwords are made with (src/duck/users.ts); rotating it removes every user */
  apiKey: string;
  /** the server the copy was taken from, recorded at the first start: a database moved to another server is read again */
  sourceServer?: { systemIdentifier: string | null; database: string } | null;
  /** how an OLDER Mason read the whole project's changes (its `mason start --replication` / `--poll`, both gone): never
   *  written now, read so a start under a sources file silent on sync: is refused (src/cli/replication-mode.ts
   *  recordRefusal), one whose file says otherwise drops that older run's slot and says why, and mason destroy drops it;
   *  deleted by the first start that gets past that (src/cli/dev.ts) */
  changes?: "poll" | "replication";
  /** replication: the publication an operator named (the sources file's `publication:`, or PG_PUBLICATION; an older
   *  Mason's --publication), read as it is and never altered; absent or null when the run reads Mason's own. Never read
   *  for a start's publication: a start the file and PG_PUBLICATION name none for is refused (recordRefusal) */
  publication?: string | null;
  /** replication mode: the slot this copy reads and its publication (`owned`: Mason's own, which it drops with the slot),
   *  as the start that made them named them — what a start replicating no table and `mason destroy` drop, never recomputed
   *  (src/cli/replication-mode.ts madeReplication); null once they are dropped */
  replication?: { slot: string; publication: string; owned: boolean } | null;
  /** `mason start --self-signed-tls` made it (src/cli/pg-tls.ts): the certificate and key in `.mason/` its listener serves,
   *  reused by every later start with the flag, and the certificate's SHA-256 fingerprint */
  selfSignedTls?: { cert: string; key: string; fingerprint: string } | null;
  /** `mason serve` wrote it from the environment (src/cli/serve.ts), and writes it again at every start; a project
   *  `mason init` made is never taken over by a serve */
  served?: boolean;
  /** `mason init demo` made it: its database is the demo database `mason start` hosts in `.mason/demo/` (src/demo/source.ts),
   *  on the loopback port the sources file's URL names (the port is in that URL alone, never recorded twice). Read by
   *  polling only: the demo database has no change log. Kept by `mason destroy`, so the next start seeds it again */
  demo?: boolean;
  /** the Postgres API's port, the project's own: recorded at its first start (src/cli/ports.ts `choosePgPort`) and used
   *  by every later one — refused when held, never moved by itself, so a BI tool's saved connection keeps working;
   *  `MASON_PG_PORT` in the shell moves it. Kept by `mason stop` and `mason destroy` (config.json stays) */
  pgPort?: number | null;
  /** while Mason runs: how the commands reach it; null once it stopped */
  running?: RunningState | null;
  /** when the last run came up (src/cli/dev.ts) */
  lastRun?: string | null;
  /** how the last run ended, when it was a stop: the run records its own (the signal it left on); `mason stop` records
   *  one it had to kill, since a run that does not answer records nothing (on the test server the only trace
   *  of that stop was its supervisor's "crash"). A crash is the supervisor's record (restarts.json), never this */
  lastStop?: { at: string; how: string } | null;
}

/** The copy of the data, a DuckDB file in the project's `.mason/`: kept by mason stop, deleted by mason destroy. */
export const DUCK_FILE = "duck.db";

/** The demo database's folder in the project's `.mason/` (`mason init demo`): hosted by mason start, deleted by mason destroy. */
export const DEMO_DIR = "demo";

export interface Project {
  /** the folder `mason init` ran in: `.mason/` is in it */
  root: string;
  /** `<root>/.mason`: the config and the run's state */
  dir: string;
  /** the project's files, absolute */
  folder: string;
  config: ProjectConfig;
}

/** A name from a folder's: lower case, the rest of it dashes. */
export function nameFromFolder(dir: string): string {
  const n = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48);
  return NAME_RE.test(n) ? n : "mason";
}

/**
 * A FOLDER WHOSE `.mason/config.json` CANNOT BE READ (found by tests/cli-state-matrix.test.ts): half-written,
 * edited by hand into invalid JSON, or missing a field. It is a project — init refuses to make another over it — that no
 * command can use, so it is a RESULT of the lookup, never an exception: every caller is made by its type to say it, where
 * an exception had every command (doctor and list included) die with "Unterminated string in JSON … a bug in mason".
 */
export interface BrokenProject { root: string; dir: string; file: string; broken: string }

/** What a recorded run must carry besides its pid (src/cli/dev.ts writes all of it): how the commands reach it. */
const RUNNING = ["controlUrl", "token", "postgresUrl"] as const;

/** The fields a config must have, each a string: what every command reads. */
const REQUIRED = ["name", "folder", "apiKey"] as const;

/** The project whose `.mason/` is `root`'s; a broken one when its config cannot be read; null when there is none. */
export function readProject(root: string): Project | BrokenProject | null {
  const dir = path.join(root, STATE_DIR);
  const file = path.join(dir, CONFIG);
  if (!fs.existsSync(file)) return null;
  let config: ProjectConfig;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectConfig; }
  catch (e) { return { root, dir, file, broken: `it is not valid JSON (${(e as Error).message})` }; }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return { root, dir, file, broken: "it is not a JSON object" };
  const missing = REQUIRED.filter((k) => typeof (config as unknown as Record<string, unknown>)[k] !== "string");
  if (missing.length) return { root, dir, file, broken: `it has no ${missing.join(", ")} (each a string)` };
  if (!NAME_RE.test(config.name)) return { root, dir, file, broken: `its name ${JSON.stringify(config.name)} is not a project name (lower case letters, digits, - and _)` };
  // the project's port is what every tool's saved connection names: a value that is no port would make every start refuse
  const pgPort = (config as { pgPort?: unknown }).pgPort;
  if (pgPort !== undefined && pgPort !== null && !(Number.isInteger(pgPort) && (pgPort as number) >= 1 && (pgPort as number) <= 65_535)) {
    return { root, dir, file, broken: `its "pgPort" ${JSON.stringify(pgPort)} is not a port number (1-65535, the Postgres API's port mason start recorded; remove it and the next start chooses one)` };
  }
  // a run recorded without how to reach it would read as "not running" and let mason start launch a second service
  // beside a live one (review of #434): what mason start writes, whole, or nothing
  const r = config.running as unknown;
  if (r !== undefined && r !== null) {
    const run = r as Record<string, unknown>;
    const bad = typeof r !== "object" || !Number.isInteger(run.pid) ? ["pid"]
      : [...RUNNING.filter((k) => typeof run[k] !== "string"), ...(typeof (run.postgresListener as { host?: unknown } | null)?.host !== "string" ? ["postgresListener"] : [])];
    if (bad.length) return { root, dir, file, broken: `its "running" has no ${bad.join(", ")} (mason start writes the whole of it, or null when stopped)` };
  }
  return { root, dir, folder: path.resolve(root, config.folder), config };
}

/** Whether a lookup found a project it could read. */
export const isProject = (p: Project | BrokenProject | null): p is Project => p !== null && !("broken" in p);

/** What a broken project's commands say: the file, what is wrong with it, and the two ways out. */
export function brokenProblem(b: BrokenProject): Problem {
  return { problem: `this folder's Mason project cannot be read: ${b.file}: ${b.broken}`, code: "bad_config",
    fix: `repair it (JSON: ${REQUIRED.join(", ")}), or move ${b.dir} aside and run mason init again — your project's files stay where they are`,
    next: [["mason init", `once ${b.dir} is moved aside: a new config for this folder`]] };
}

/** The nearest project at or above `cwd`, as git finds a repository (a broken one stops the search: it is the nearest). */
export function findProject(cwd: string): Project | BrokenProject | null {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const p = readProject(d);
    if (p) return p;
    if (path.dirname(d) === d) return null;
  }
}

export function writeConfig(dir: string, c: ProjectConfig): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, CONFIG);
  fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** A new project's config: the secrets made here, once. */
export function newConfig(name: string, folder: string, remote: boolean, o: { demo?: boolean } = {}): ProjectConfig {
  return { name, folder, remote, ...(o.demo ? { demo: true } : {}), apiKey: randomBytes(24).toString("hex"), sourceServer: null, running: null, lastRun: null };
}

/**
 * THE PROJECT A COMMAND MEANS: the nearest at or above `cwd`; or the sentence that says why there is none, with the
 * way out.
 */
export function theProject(cwd: string): { project: Project } | Problem {
  const p = findProject(cwd);
  if (p && "broken" in p) return brokenProblem(p);
  if (p) return { project: p };
  return { problem: "no Mason project here or above", code: "no_project", fix: "cd into a project's folder, or make this folder one (mason init demo: a demo database, nothing to install)",
    next: [["mason init", "make this folder a project (MASON_DATABASE_URL or DATABASE_URL from .env, or mason init postgres://…)"]] };
}

/** Whether `root`'s .gitignore already ignores `.mason/`. */
export function ignoresStateDir(gitignore: string): boolean {
  return gitignore.split("\n").map((l) => l.trim()).some((l) => /^\/?\.mason\/?(\*\*?)?$/.test(l));
}

/**
 * THE PROJECT'S SOURCE — its sources file read and its URL resolved (src/cli/sources.ts readSource) — or what is wrong,
 * with the way out: what every command that reads the database asks (mason start, tables, doctor, destroy). `shellFirst`
 * for a server's run (mason serve: its environment before any .env).
 */
export function projectSource(p: Project, env: NodeJS.ProcessEnv = process.env, o: { shellFirst?: boolean } = {}): ProjectSource | Failure {
  return readSource(p.folder, p.root, env, o);
}

/**
 * THE DATABASE NAME THE PROJECT'S NEXT RUN WILL ANSWER AS, with Mason stopped (a run's is in its URL: `postgresLink`): by
 * the one rule, from the sources file's one key, so it needs neither the database's URL nor the rest of the file right.
 */
export function projectDatabase(p: Project, env: NodeJS.ProcessEnv = process.env): string | Failure {
  const written = writtenDatabase(p.folder, p.root);
  return "message" in written ? written : connectDatabase(written, p.config, env);
}

/**
 * THE NAME THE SOURCES FILE HAS MOVED TO SINCE A RUN STARTED answering as `answersAs` (the name is read at the start), or
 * null. Only what the file says: a server's run may be named by its setting, in an environment the shell asking need
 * not have, so a served project whose file writes no name has nothing to compare; a file that cannot be read is said
 * as such by the commands that read it.
 */
export function databaseMoved(p: Project, answersAs: string): string | null {
  const written = writtenDatabase(p.folder, p.root);
  if ("message" in written || (written.database === null && p.config.served === true)) return null;
  const says = connectDatabase(written, {}, {});
  return says === answersAs ? null : says;
}

/**
 * A SETTING A START REFUSES, for the start that is typed and the run it spawns alike: read by the parent where the person
 * (or --json) reads the answer, and by the run, which `mason start --attach` and `mason serve` reach without the parent.
 * One list, because a check in the run alone reaches a background start as "the run stopped", its way out in a log.
 */
export function startSettingRefusal(p: Project, env: NodeJS.ProcessEnv, o: { serve: boolean }): Failure | null {
  const top = () => sourcesTop(p.root, p.folder);
  const pollMs = pollMsRetired(env, top);
  if (pollMs !== null) return { code: "refused", ...pollMs };
  const changes = changesRetired(env, top);
  if (changes !== null) return { code: "refused", ...changes };
  const database = o.serve ? null : databaseSettingRefusal(env, top().shown);
  return database === null ? null : { code: "refused", ...database };
}
