/**
 * `mason serve` (deploying quickly to a server — one's own or a managed platform — must be as easy as possible,
 * wherever the Postgres database is): the DuckDB run of `mason start --attach` (src/cli/dev.ts), for a server or a
 * container. Whatever a platform gives a process, and nothing else:
 *
 *   - ITS SETTINGS FROM THE ENVIRONMENT (`serveSettings`): the database's URL, the API key the tokens are minted with,
 *     the project folder (the team's `mason/`, committed: its sources file names the database and the tables copied,
 *     its URL `${DATABASE_URL}` from this environment) and the data folder.
 *     Nothing is asked; every setting missing or wrong is said at once, each with what to set (one report).
 *   - ITS STATE ON ONE VOLUME: the data folder's `.mason/` — the config this command writes from the environment at
 *     every start (`serveConfig`), the DuckDB file, the logs. A restart resumes the copy; a new volume copies again.
 *   - IN THE FOREGROUND, ITS LOG ON STDOUT: a container's log is its stdout. A run that cannot start exits 1, so the
 *     platform restarts it; there is no supervisor of its own (src/cli/supervise.ts is `mason start`'s).
 *   - A HEALTH ENDPOINT (`healthBody`): `GET /healthz` on MASON_HEALTH_PORT, 503 while it starts and stops, 200 once it
 *     answers. It needs no credential, so it names nothing of the database: counts only.
 *   - METRICS BESIDE IT (src/cli/metrics.ts): `GET /metrics` on the same port, Prometheus's text format, numbers only
 *     (counts, lag, ages, sizes) for the same reason: never a table's, a user's or a host's name, never a statement.
 *   - A CLEAN STOP ON SIGTERM: the run's own stop (a copy in flight interrupted and rolled back, DuckDB closed).
 *
 * The commands beside it work as on a laptop, in the data folder: `docker compose exec mason mason add orders`.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { failed, parseCommand, type CommandSpec, type Failure } from "./command.ts";
import { dev } from "./dev.ts";
import { parseSource } from "./preflight.ts";
import { NAME_RE, newConfig, readProject, STATE_DIR, writeConfig, type BrokenProject, type Project, type ProjectConfig } from "./project.ts";
import { newSourceText, OLD_TABLES_DIR, parseSourceText, readSource, sourceFileNames, sourceNameFor, sourcesDir } from "./sources.ts";
import { appEnvValue } from "../lib/dotenv.ts";
import { pollMsRetiredText } from "../lib/table-sync.ts";
import { changesAgreement } from "./replication-mode.ts";
import { historyDaysSetting, historyDaysWrongText } from "../duck/history.ts";
import { version } from "./version.ts";
import { phaseCounts } from "./readiness.ts";
import { METRICS_CONTENT_TYPE, metricsText, type RunMetrics } from "./metrics.ts";
import type { CopyState } from "../duck/sync.ts";

export const SERVE: CommandSpec = {
  name: "serve",
  summary: "run Mason on a server or in a container, in the foreground, configured by the environment",
  usage: `usage: mason serve [--json]

  Runs Mason as mason start --attach does, for a server or a container: nothing asked, its settings from the
  environment, its state in one folder (a volume), its log on stdout, GET /healthz for the platform's health check,
  GET /metrics for Prometheus (numbers only: no name, no statement), and a clean stop on SIGTERM. The tables it copies are the ones the project folder's sources file names
  (sources/<name>.yml): make it with mason init and mason add on a laptop and commit it, or with mason add beside the
  running server. A project folder with no sources file gets one, url: \${DATABASE_URL}, with no table yet.

    DATABASE_URL=postgres://mason:…@db.internal:5432/app MASON_API_KEY=… mason serve
    docker compose exec mason mason add public.orders     beside it, in its container

  Settings (the environment):
    DATABASE_URL            the database to copy from, as the sources file's url: \${DATABASE_URL} names it (the variable
                            the file names is required); read-only: SELECTs, or a replication slot
    MASON_API_KEY           what the users' passwords are made with (mason user add), at least 32 characters (required)
    MASON_PROJECT           the project folder: sources/, mason.yml (default ./mason)
    MASON_DATA              the folder whose .mason/ holds the copy and the state: the volume (default .)
    MASON_NAME              the project's name, the database name clients connect to (default mason)
    MASON_CHANGES           read only where it agrees with the sources file, whose sync: says per table how each is kept
                            current (replication: every table's is; poll: none is); it goes in the next release
    MASON_HEALTH_PORT       /healthz's and /metrics' port (default 4140), on MASON_HEALTH_HOST (default 0.0.0.0)
    MASON_PG_HOST, MASON_PG_PORT   the Postgres API's address (default 127.0.0.1:5433)
    MASON_PG_TLS_CERT, MASON_PG_TLS_KEY   its certificate, required off loopback; or MASON_PG_SELF_SIGNED_TLS=1
                            for one made in .mason/, or MASON_PG_PLAIN=1 behind a TLS proxy of your own
    MASON_DUCKDB_MEMORY     the copy's memory, 4GB or 512MiB (default half the container's memory limit, else half the
                            machine's RAM; mason doctor says it); a statement past it fails alone with 53200
    MASON_STATEMENT_TIMEOUT   each statement's limit, as Postgres's statement_timeout (default 5min; 0 for none)
    MASON_HISTORY_DAYS      how many days Mason keeps its history: the request log, the sync's events, the usage
                            samples and the copies' sizes (default 7)
    MASON_STORE_JSON_PATHS  on (the default) stores the JSON paths statements keep reading as columns; off stores none
    MASON_COPY_PARALLEL     a copy's chunks read at once, each a backend on the database (1 to 8, default 3)
    MASON_COPY_CHUNK_SECONDS   how long each chunk takes to read, at the rate measured (1 to 300, default 12)

  --json   a refusal to start as data: { error, next }; once it serves, its output is its log

  Exit status: 0 stopped by SIGTERM or SIGINT; 1 it could not start (said); 2 a wrong command line.
`,
  options: { json: { type: "boolean", default: false } },
  json: ["next"],
};

/** What a serve is told by its environment. */
export interface ServeSettings {
  name: string;
  apiKey: string;
  /** the project folder, absolute */
  project: string;
  /** the folder whose `.mason/` is the state, absolute */
  data: string;
  /** null: the project's own (poll until a replication start recorded otherwise) */
  changes: "poll" | "replication" | null;
  selfSignedTls: boolean;
  health: { host: string; port: number };
}

const MIN_API_KEY = 32;

/** THE SETTINGS, OR EVERY ONE MISSING OR WRONG AT ONCE: a platform's deploy is slow, and one variable a deploy wastes it. */
export function serveSettings(env: Readonly<Record<string, string | undefined>>, cwd: string): ServeSettings | Failure {
  const wrong: string[] = [];
  const project = path.resolve(cwd, env.MASON_PROJECT || "mason");
  const data = path.resolve(cwd, env.MASON_DATA || ".");
  // the database's URL, with the rest: the variable the sources file names (DATABASE_URL for the one a serve writes)
  wrong.push(...urlSettingProblems(project, data, env));
  const apiKey = env.MASON_API_KEY ?? "";
  if (!apiKey) wrong.push("MASON_API_KEY is not set: what the users' passwords are made with (mason user add; openssl rand -hex 24 makes one)");
  else if (apiKey.length < MIN_API_KEY) wrong.push(`MASON_API_KEY is ${apiKey.length} characters: at least ${MIN_API_KEY}, as openssl rand -hex 24 makes`);
  const name = env.MASON_NAME || "mason";
  if (!NAME_RE.test(name)) wrong.push(`MASON_NAME=${JSON.stringify(name)} is not a project name: lower case letters, digits, - and _, at most 48`);
  const changes = env.MASON_CHANGES || null;
  if (changes !== null && changes !== "poll" && changes !== "replication") wrong.push(`MASON_CHANGES=${JSON.stringify(changes)}: poll or replication`);
  // taken only where it says what the sources file says, refused HERE with the other settings, before anything is
  // written or connected (a review finding: the run refused it after writing the config and connecting)
  else if (changes !== null) { const against = changesSettingProblem(project, changes); if (against !== null) wrong.push(against); }
  // how often a table is polled is the sources file's sync: now, per table (src/lib/table-sync.ts)
  const pollMs = pollMsRetiredText(env);
  if (pollMs !== null) wrong.push(pollMs);
  // the history's days: MASON_HISTORY_DAYS, a number of days; the old name refused (src/duck/history.ts)
  const days = historyDaysSetting(env);
  if (typeof days !== "number") wrong.push(historyDaysWrongText(days));
  const selfSigned = env.MASON_PG_SELF_SIGNED_TLS || "0";
  if (selfSigned !== "0" && selfSigned !== "1") wrong.push(`MASON_PG_SELF_SIGNED_TLS=${JSON.stringify(selfSigned)}: 1, or 0 (the default)`);
  const portText = env.MASON_HEALTH_PORT || "4140";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) wrong.push(`MASON_HEALTH_PORT=${JSON.stringify(portText)}: a port number, 1-65535`);
  if (wrong.length) {
    return { message: `${wrong.length === 1 ? "a setting is" : `${wrong.length} settings are`} missing or wrong: ${wrong.join("; ")}`, code: "bad_config",
      why: "mason serve reads its settings from the environment, and asks nothing",
      fix: "set them in the environment (a compose file's .env, the platform's variables), then start it again",
      next: [["mason serve --help", "every setting, with its default"]] };
  }
  return {
    name, apiKey, changes: changes as ServeSettings["changes"], selfSignedTls: selfSigned === "1",
    project, data,
    health: { host: env.MASON_HEALTH_HOST || "0.0.0.0", port },
  };
}

/** MASON_CHANGES against the project's one sources file (src/cli/replication-mode.ts changesAgreement), as one line of
 *  the settings report; a file that cannot be read is serveSource's to say, on its own report. */
function changesSettingProblem(project: string, changes: "poll" | "replication"): string | null {
  const names = sourceFileNames(project);
  if (names.length !== 1) return null;
  const file = path.join(sourcesDir(project), names[0]!);
  let text: string;
  // a file that cannot be read is serveSource's to say (readSource), with the file and the error, on its own report
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const parsed = parseSourceText(text, names[0]!.replace(/\.ya?ml$/, ""), file);
  if ("problems" in parsed) return null;
  const f = changesAgreement(parsed, path.join(path.basename(project), "sources", names[0]!), changes, `MASON_CHANGES=${changes}`);
  return f === null ? null : `${f.message} — ${f.fix}`;
}

/**
 * THE DATABASE'S URL AS A SETTING (the review of the sources file: an unset URL was found only after the other
 * settings passed, two deploys for two variables): the variable the project's sources file names — DATABASE_URL when it
 * has none yet (serveSource writes one naming it) — set and a postgres:// URL, read from the environment first (a .env in
 * the data folder never overrides the platform's). The file's own mistakes are serveSource's, on its own report.
 */
function urlSettingProblems(project: string, data: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const names = sourceFileNames(project);
  let variable = "DATABASE_URL";
  if (names.length === 0) {
    if (fs.existsSync(path.join(project, OLD_TABLES_DIR))) return [];   // refused by readSource, with the way out
    if (!env.DATABASE_URL) return [`DATABASE_URL is not set, and the project folder (${project}) has no sources file to name the database another way`];
  } else if (names.length === 1) {
    const file = path.join(sourcesDir(project), names[0]!);
    let text: string;
    // a file that cannot be read is serveSource's to say (readSource), with the file and the error, on its own report
    try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
    const parsed = parseSourceText(text, names[0]!.replace(/\.ya?ml$/, ""), file);
    if ("problems" in parsed || "literal" in parsed.url) return [];
    variable = parsed.url.env;
  } else return [];
  const found = appEnvValue(data, variable, env as NodeJS.ProcessEnv, { shellFirst: true });
  if (found === null) return [`${variable} is not set: the database to copy from, as the sources file's url: \${${variable}} names it`];
  const p = parseSource(found.value);
  return "problem" in p ? [`${variable}: ${p.problem}`] : [];
}

/**
 * THE CONFIG A SERVE RUNS ON, written from its settings at every start, over what the runs before recorded (the server
 * the copy was taken from, the publication, the certificate): the environment is the operator's, the rest the run's. A
 * project `mason init` made is a developer's and is never taken over; a name that moved would be another slot and
 * another database name over the same copy, so it is refused.
 */
export function serveConfig(s: ServeSettings, existing: Project | BrokenProject | null): { config: ProjectConfig; said: string[] } | Failure {
  const dir = path.join(s.data, STATE_DIR);
  if (existing === null) {
    const config = { ...newConfig(s.name, s.project, true), apiKey: s.apiKey, served: true };
    return { config, said: [`a new copy in ${dir}`] };
  }
  if ("broken" in existing) {
    return { message: `the state in ${dir} cannot be read: ${existing.file}: ${existing.broken}`, code: "bad_config",
      fix: `MASON_DATA names a folder of its own for mason serve; move ${dir} aside to copy again` };
  }
  const was = existing.config;
  if (was.served !== true) {
    return { message: `${dir} is a project mason init made, and mason serve keeps its own state`, code: "refused",
      why: "its config is a developer's (its database, its key), which a serve would overwrite from the environment",
      fix: "point MASON_DATA at an empty folder (the volume), or run mason start here" };
  }
  if (was.name !== s.name) {
    return { message: `the copy in ${dir} is the project ${was.name}, and MASON_NAME says ${s.name}`, code: "refused",
      why: "the name is the database name clients connect to and names the replication slot: another name over the same copy is another project",
      fix: `set MASON_NAME=${was.name} again, or give the new name a new MASON_DATA (an empty volume), which copies again` };
  }
  const said: string[] = [`the copy in ${dir}, resumed`];
  if (was.apiKey !== s.apiKey) said.push("MASON_API_KEY changed: every mason user is removed (mason user add each again)");
  // the source is the sources file's; a database restored elsewhere, or another one, is the run's to see (sourceMove)
  const { source: _old, ...kept } = was as ProjectConfig & { source?: unknown };
  return { config: { ...kept, apiKey: s.apiKey, folder: s.project, remote: true, served: true }, said };
}

/**
 * THE PROJECT FOLDER'S SOURCES FILE, for a serve: one there is checked as the run reads it (src/cli/sources.ts
 * readSource: its URL resolved from this environment, every mistake on one report); a folder with none gets the file
 * `mason init` writes, `url: ${DATABASE_URL}` and no table, when DATABASE_URL is set — else what to set is said.
 */
export function serveSource(s: ServeSettings, env: NodeJS.ProcessEnv): { wrote: string | null } | Failure {
  let wrote: string | null = null;
  if (sourceFileNames(s.project).length === 0 && !fs.existsSync(path.join(s.project, OLD_TABLES_DIR))) {
    const url = env.DATABASE_URL ?? "";
    if (!url) {
      return { message: "DATABASE_URL is not set, and the project folder has no sources file to name the database another way", code: "bad_config",
        fix: "set DATABASE_URL=postgres://user:password@host:5432/app (the sources file mason init writes names it), or mount the project folder with its sources/ (MASON_PROJECT)",
        next: [["mason serve --help", "every setting, with its default"]] };
    }
    const p = parseSource(url);
    const file = path.join(sourcesDir(s.project), `${sourceNameFor("source" in p ? p.source.database : "")}.yml`);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, newSourceText()); }
    catch (e) {
      return { message: `the project folder has no sources file, and one cannot be written: ${(e as Error).message}`, code: "refused",
        fix: `MASON_PROJECT names the project folder (sources/, mason.yml): mount it there with its sources file, or make ${file} in it` };
    }
    wrote = file;
  }
  const r = readSource(s.project, s.data, env, { shellFirst: true });
  return "message" in r ? r : { wrote };
}

/** Where a serve is: what /healthz and /metrics say. Once ready, `metrics` reads the run's numbers (src/cli/run-server.ts
 *  `metricsFacts`); a test's ready phase may leave it out, and /metrics then says what it would while starting. */
export type ServePhase = { phase: "starting" }
  | { phase: "ready"; tables: () => CopyState[]; metrics?: () => Promise<Omit<RunMetrics, "uptimeSeconds">> }
  | { phase: "stopping" };

/** seconds since the serve started: /healthz's `uptimeSeconds` and /metrics' `mason_uptime_seconds`, one number */
const uptimeSeconds = (startedAt: number, now: number): number => Math.floor((now - startedAt) / 1000);

/**
 * /healthz's answer: 200 once the run answers, whatever its copies are doing (a table still copying, or one that failed,
 * leaves the rest served: the counts say it); 503 while it starts and stops. Counts only, never a table's name: the
 * endpoint takes no credential.
 */
export function healthBody(state: ServePhase, startedAt: number, now = Date.now()): { status: number; body: Record<string, unknown> } {
  const base = { status: state.phase, version: version(), uptimeSeconds: uptimeSeconds(startedAt, now) };
  if (state.phase !== "ready") return { status: 503, body: base };
  return { status: 200, body: { ...base, tables: phaseCounts(state.tables()) } };
}

/**
 * /metrics' answer: ALWAYS 200 (a scrape that errors while Mason starts is an alert about nothing; whether it is up is
 * /healthz's to say) — `mason_ready 0` and `mason_info` while it starts or stops, the run's numbers once it serves.
 */
export async function metricsBody(state: ServePhase, startedAt: number, now = Date.now()): Promise<string> {
  if (state.phase !== "ready" || state.metrics === undefined) return metricsText({ version: version(), run: null });
  const run = await state.metrics();
  return metricsText({ version: version(), run: { ...run, uptimeSeconds: uptimeSeconds(startedAt, now) } });
}

/** The health server: GET /healthz and GET /metrics, nothing else. `log` says a scrape whose numbers could not be read. */
export function healthServer(state: () => ServePhase, startedAt: number, log: (line: string) => void = say): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://health");
    if (url.pathname !== "/healthz" && url.pathname !== "/metrics") { res.writeHead(404, { "content-type": "text/plain" }).end("GET /healthz or GET /metrics\n"); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
    if (url.pathname === "/metrics") {
      const asked = state();
      metricsBody(asked, startedAt).then(
        (body) => { res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : body); },
        (e: unknown) => {
          // a run stopping under the scrape (its copy closing): said as stopping, as it now is
          if (state().phase !== "ready") {
            res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : metricsText({ version: version(), run: null }));
            return;
          }
          // anything else fails the scrape (Prometheus's `up` turns 0) and is said in the log; the error's text stays in
          // the log, never in the answer, which takes no credential (it could name a table or a host)
          log(`  /metrics: the run's numbers could not be read: ${(e as Error).message}`);
          res.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" }).end("the run's numbers could not be read: mason serve's log says why\n");
        });
      return;
    }
    const h = healthBody(state(), startedAt);
    res.writeHead(h.status, { "content-type": "application/json", "cache-control": "no-store" }).end(`${JSON.stringify(h.body)}\n`);
  });
}

const say = (m: string): void => { process.stdout.write(`${m}\n`); };

export async function serve(argv: string[]): Promise<number> {
  const f = parseCommand(SERVE, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.positionals.length) return failed("serve", { message: "it takes no arguments: its settings are the environment's", code: "usage", usage: SERVE.usage }, { json });
  const s = serveSettings(process.env, process.cwd());
  if ("message" in s) return failed("serve", s, { json });
  // the project folder: its sources file is the list of what is copied, one with no table written when there is none
  const made = serveSource(s, process.env);
  if ("message" in made) return failed("serve", made, { json });
  const c = serveConfig(s, readProject(s.data));
  if ("message" in c) return failed("serve", c, { json });
  try { writeConfig(path.join(s.data, STATE_DIR), c.config); }
  catch (e) {
    return failed("serve", { message: `the state cannot be written to ${path.join(s.data, STATE_DIR)}: ${(e as Error).message}`, code: "refused",
      fix: "MASON_DATA names a folder this user can write: the volume's mount point" }, { json });
  }
  const startedAt = Date.now();
  let state: ServePhase = { phase: "starting" };
  const health = healthServer(() => state, startedAt);
  const listening = await new Promise<Error | null>((resolve) => {
    health.once("error", resolve);
    health.listen(s.health.port, s.health.host, () => resolve(null));
  });
  if (listening !== null) {
    return failed("serve", { message: `the health endpoint cannot listen on ${s.health.host}:${s.health.port}: ${listening.message}`, code: "refused",
      fix: "MASON_HEALTH_PORT names a port free on this machine" }, { json });
  }
  say(`mason serve: ${s.name}, the project in ${s.project}, the state in ${path.join(s.data, STATE_DIR)}`);
  if (made.wrote) say(`  wrote ${made.wrote}: the database (url: \${DATABASE_URL}), no table yet (mason add beside it adds one)`);
  for (const l of c.said) say(`  ${l}`);
  say(`  health    http://${s.health.host}:${s.health.port}/healthz`);
  say(`  metrics   http://${s.health.host}:${s.health.port}/metrics`);
  // the run reads the project of the folder it runs in (src/cli/project.ts): the data folder's
  process.chdir(s.data);
  let code: number;
  try {
    code = await dev({ port: 4039, version: version(), changes: s.changes, publication: null, selfSignedTls: s.selfSignedTls,
      serve: { log: say, ready: (run) => { state = { phase: "ready", tables: run.tables, metrics: run.metrics }; }, stopping: () => { state = { phase: "stopping" }; } } });
  } finally {
    // a platform's health check may hold a keep-alive connection open, which close() alone would wait for
    health.closeAllConnections();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }
  if (code !== 0) return failed("serve", { message: "Mason did not start: what stopped it is said above", code: "failed",
    fix: "fix what it says, then start it again (a platform restarts it by itself)" }, { json: false });
  return 0;
}
