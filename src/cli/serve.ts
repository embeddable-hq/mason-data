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
 *   - ITS WEB PAGE ON LOOPBACK ALONE (src/cli/run-server.ts `listenOnLoopback`): the run's server, MASON_UI_PORT, reached
 *     from a developer's machine with `mason ui --ssh`, never published. No setting moves it to another address.
 *     MASON_UI_SOCKET serves it on a Unix socket too, for a process on this machine (src/cli/ui-socket.ts): mode 0600, in
 *     a folder only Mason's user can write, behind the same guard as `mason ui --ssh`'s requests. MASON_UI_RUN_FILE
 *     writes the page's port and the run's token to a file for a supervisor on this machine (src/cli/ui-run-file.ts),
 *     held to the same bar, once the run answers; /healthz says from the start where the page is served (`PageServed`).
 *
 * The commands beside it work as on a laptop, in the data folder: `docker compose exec mason mason add orders`.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { checkProjectSource, problemLine, SOURCE_PROBLEM_CODES } from "./source-check.ts";
import { DEFAULT_UI_PORT, heldText, portHolder } from "./ports.ts";
import { pgListenerAddress } from "../api/postgres/listener.ts";
import { dev } from "./dev.ts";
import { parseSource } from "./preflight.ts";
import { NAME_RE, newConfig, projectReadOnlySetting, projectWriteRefusal, readProject, STATE_DIR, writeConfig, type BrokenProject, type Project, type ProjectConfig } from "./project.ts";
import { newSourceText, OLD_TABLES_DIR, parseSourceText, readSource, sourceFileNames, sourceNameFor, sourcesDir, sourcesTop, writtenDatabase } from "./sources.ts";
import { connectDatabase, DATABASE_SETTING, databaseNameProblem } from "../lib/database-name.ts";
import { appEnvValue } from "../lib/dotenv.ts";
import { imagePinProblem, PIN_FILE } from "../lib/project-version.ts";
import { commandPinProblem } from "./pin.ts";
import { listenOnUiSocket, prepareUiSocket, uiSocketSetting, type UiSocket } from "./ui-socket.ts";
import { prepareUiRunFile, uiRunFileSetting, UI_RUN_FILE_SETTING, writeUiRunFile, type UiRunFile } from "./ui-run-file.ts";
import { recordRefusal } from "./replication-mode.ts";
import { pageAllowsText, UI_READ_ONLY_ALLOW_SETTING, UI_READ_ONLY_SETTING, uiReadOnlyAllowSetting, uiReadOnlySetting } from "./ui-read-only.ts";
import { BACK_LABEL_MAX, BACK_URL_MAX, uiBackLinkSetting } from "./ui-back-link.ts";
import { NAV_LINKS_MAX, navLines, navOf, uiNavSetting } from "./ui-nav.ts";
import { UI_OVERVIEW_CARD_SETTING, overviewCardOf, uiOverviewCardSetting } from "./ui-host-view.ts";
import { pgPublicUrlSetting, PUBLIC_SSLMODES } from "./pg-public-url.ts";
import { changesRetiredText, pollMsRetiredText, type SourcesTop } from "../lib/table-sync.ts";
import { historyDaysSetting, historyDaysWrongText } from "../duck/history.ts";
import { DEFAULT_MEMORY_RULE, memoryProblems, memoryProblemText, memorySize, MEMORY_FLOOR_BYTES } from "../duck/store.ts";
import { wrap } from "./style.ts";
import { runningVersion, version, type RunningVersion } from "./version.ts";
import { phaseCounts } from "./readiness.ts";
import { METRICS_CONTENT_TYPE, metricsText, type RunMetrics } from "./metrics.ts";
import type { CopyState } from "../duck/sync.ts";

export const SERVE: CommandSpec = {
  name: "serve",
  summary: "run Mason on a server or in a container, in the foreground, configured by the environment",
  usage: `usage: mason serve [--check] [--json]

  Runs Mason as mason start --attach does, for a server or a container: nothing asked, its settings from the
  environment, its state in one folder (a volume), its log on stdout, GET /healthz for the platform's health check,
  GET /metrics for Prometheus (numbers only: no name, no statement), and a clean stop on SIGTERM. The tables it
  syncs are the ones the project folder's sources file names (sources/<name>.yml): make it with mason init and mason
  add on a laptop and commit it, or with mason add beside the running server. A project folder with no sources file
  gets one, url: \${DATABASE_URL}, with no table yet — unless MASON_PROJECT_READONLY=1, which writes none.

    DATABASE_URL=postgres://mason:…@db.internal:5432/app MASON_API_KEY=… mason serve
    docker compose exec mason mason add public.orders     beside it, in its container
    MASON_PROJECT=/deploys/next mason serve --check      can the database serve these files? (nothing written)

  --check  check the project against the database, as the start would, and run nothing: every problem at once,
           each with its fix — a table the sources file names that it lacks or this user cannot read (no SELECT, no
           USAGE on its schema, row-level security that hides every row), a column or key, the tables under sync:
           replication (wal_level, the role's REPLICATION, a free slot and WAL sender, the publication the file
           names carrying each), the roles file — or the connection's own failure. Read-only on the database (SELECTs
           on its catalogs); nothing is written, and the synced data is never opened, so it runs beside a serve of
           the same volume (the project's slot in use is that serve's). A hosted service may run it on a deploy's new
           files before it writes them. Exit 0 the database can serve it; 1 a problem (said), or a setting or file a start refuses
  --json   as data: its shape is at the end (once it serves, its output is its log)

  Settings (the environment):
    DATABASE_URL            the database to sync from, as the sources file's url: \${DATABASE_URL} names it (the variable
                            the file names is required); read-only: SELECTs, or a replication slot
    PG_PUBLICATION          the publication the tables under sync: replication are read through, the database owner's,
                            never altered: the sources file's publication: first (publication: \${PG_PUBLICATION} reads
                            this one), else this; default none: Mason makes its own
    MASON_API_KEY           what the users' passwords are made with (mason user add), at least 32 characters (required)
    MASON_PROJECT           the project folder: sources/, mason.yml (default ./mason)
    MASON_PROJECT_READONLY  1 when the project folder is deployed as committed (CI, GitOps, a platform that deploys
                            the folder): every edit of its files is refused — mason add and mason remove, beside it or
                            on the web page — and says to edit the files and deploy them (default 0)
    MASON_DATA              the folder whose .mason/ holds the synced data and the state: the volume (default .)
    MASON_NAME              the project's name, which the replication slot is named for (default mason); renaming it
                            over the same synced data is refused
    MASON_PG_DATABASE       the database name a tool connects with, for a sources file with no database: (default mason;
                            the two must agree when both are set)
    MASON_HEALTH_PORT       /healthz's and /metrics' port (default 4140), on MASON_HEALTH_HOST (default 0.0.0.0)
    MASON_UI_PORT           the web page's and the commands' port, on 127.0.0.1 alone: no setting moves the address, and
                            mason ui --ssh <user@server> opens the page from your machine (default ${DEFAULT_UI_PORT}, or the next
                            free one; a port named here is that port, or the start is refused)
    MASON_UI_SOCKET         a Unix socket the web page is served on too, for a process on this machine (a supervisor,
                            a local reverse proxy): made mode 0600 in a folder only Mason's user can write (else the
                            start is refused), a stale one replaced, removed on exit; a request on it passes the same
                            guard as mason ui --ssh's (default unset: none)
    MASON_UI_RUN_FILE       a file Mason writes once it answers, for a process on this machine that supervises it:
                            { "port", "token" }, the web page's port and the run's token, which grants what the token
                            grants — the commands' writes (mason add, mason sync, mason user) as well as a tunnel to
                            the page; written whole, mode 0600, in a folder only Mason's user can write (else the
                            start is refused), a stale one replaced, removed on exit (default unset: none)
    MASON_UI_READ_ONLY      1 when the web page should only show: it offers no control that changes anything, and
                            refuses every change it is sent, through mason ui --ssh or the socket alike; the mason
                            commands beside it are unchanged (default 0)
    MASON_UI_READ_ONLY_ALLOW  tables: a read-only page still adds, removes and syncs tables on its Tables page (Add,
                            Columns…, Name its key…, Remove, Sync now: POST /api/pick, /api/remove, /api/sync);
                            users: it still adds, disables, enables and removes users and changes the addresses they
                            connect from on its Users page (POST /api/users, POST /api/users/<name>/disable, /enable
                            and /from, DELETE /api/users/<name>); tables,users both. It refuses every other change; an
                            item that is not one of these, empty or named twice, or the setting without
                            MASON_UI_READ_ONLY=1, is refused; MASON_PROJECT_READONLY=1 still refuses a table's Add or
                            Remove (default unset: nothing)
    MASON_UI_BACK_URL       a link back to the site that links to the web page, at the top of its sidebar, in the same
                            tab: a path on the page's host (/something, from the host's root, whatever path the page
                            is served under) or an https:// or http:// URL, with no user or password, printable ASCII,
                            at most ${BACK_URL_MAX} characters; any other scheme is refused (default unset: no link)
    MASON_UI_BACK_LABEL     the link's label, plain text on one line, at most ${BACK_LABEL_MAX} characters; set alone it is
                            refused (default Back)
    MASON_UI_NAV_<ITEM>_URL  an item of the web page's sidebar links to the host's own page instead, in the same tab,
                            keeping its label and icon; Mason's own links to that view and its address (#users) go
                            there too. <ITEM> is OVERVIEW, TABLES, USERS, QUERIES, USAGE or SYNC_EVENTS; the URL is
                            read as MASON_UI_BACK_URL is, and refused when its #fragment names a view that is
                            replaced (/#users beside MASON_UI_NAV_USERS_URL: the page would go round in a loop);
                            what the server answers is unchanged (default unset)
    MASON_UI_NAV_LINKS      the host's own links in the sidebar, a group of their own, in the same tab: a JSON list
                            of at most ${NAV_LINKS_MAX} {"label": …, "url": …}, each label and URL read as the link back's;
                            or {"label": …, "view": …}, a view of the host's the page shows inside itself at #host/<n>
                            (n its place in the list): its JSON read from the path, relative to the page's own
                            address (host/status.json: no scheme, no //, no leading /, no .. segment), and shown as
                            text in the page's look (docs/WEB-UI.md "Host views"); anything else is refused
                            (default unset: none)
    MASON_UI_OVERVIEW_CARD  a card of the host's on the web page's Overview, beside Mason's own: the same JSON as a
                            view's, read from a path relative to the page's own address, read as a view's is
                            (default unset: none)
    MASON_PG_HOST, MASON_PG_PORT   the Postgres API's address (default 127.0.0.1:5433)
    MASON_PG_TLS_CERT, MASON_PG_TLS_KEY   its certificate, required off loopback; or MASON_PG_SELF_SIGNED_TLS=1
                            for one made in .mason/, or MASON_PG_PLAIN=1 behind a TLS proxy of your own
    MASON_PG_PUBLIC_URL     the Postgres API's address as a client reaches it, behind a load balancer, a proxy or a DNS
                            name: postgres://<host>:<port>/<database>?sslmode=<mode>, the database optional (the
                            run's), the port 5432 when none, sslmode required
                            (${PUBLIC_SSLMODES.join(", ")}), no user, no password and no other
                            parameter (refused); every URL printed for a client to paste (mason status, mason user
                            add, the web page) is built from it (default unset: the listener's own address)
    MASON_PG_PROXY_FROM     behind a TCP proxy or load balancer that sends the PROXY protocol v2: its own addresses,
                            CIDRs comma-separated (10.0.0.0/16); a connection from one must begin with a header, whose
                            client the request log names; a header from any other address is refused (default unset:
                            none is read)
    MASON_DUCKDB_MEMORY     ${wrap(`the engine's memory, 4GB or 512MiB (default ${DEFAULT_MEMORY_RULE}; mason doctor says it); a statement past it fails alone with 53200. Unset, under ${memorySize(MEMORY_FLOOR_BYTES)} Mason starts and warns: the system may stop it`, 120, 28)}
    MASON_SPILL_LIMIT       what statements may spill to disk, 40GB or 512MiB (default half of what is free, followed as
                            the disk fills; never past 90% of it); a statement past it fails alone with 53400
    MASON_STATEMENT_TIMEOUT   each statement's limit, as Postgres's statement_timeout (default 5min; 0 for none)
    MASON_HISTORY_DAYS      how many days Mason keeps its history: the request log, the sync's events, the usage
                            samples and the synced tables' sizes (default 7)
    MASON_STORE_JSON_PATHS  on (the default) stores the JSON paths statements keep reading as columns; off stores none
    MASON_COPY_PARALLEL     a first sync's chunks read at once, each a backend on the database (1 to 8, default 3)
    MASON_COPY_CHUNK_SECONDS   how long each chunk takes to read, at the rate measured (1 to 300, default 12)
    UV_THREADPOOL_SIZE      threads for running statements, one each, 1 to 1024 (default 32, lowered to fit a limit
                            on threads; one that does not fit, or is no such number, refuses the start)

  Exit status: 0 stopped by SIGTERM or SIGINT (with --check: the database can serve the project); 1 it could not
  start (said; with --check: a problem, said); 2 a wrong command line.

  The --json answer: a refusal to start, { error, next }. With --check: { ok, tables, replicated, problems: [],
    next } when the database can serve the project; else { error, problems: [{ code, table, message, fix, sql }],
    next }, code one of ${Object.keys(SOURCE_PROBLEM_CODES).slice(0, 4).join(", ")},
    ${Object.keys(SOURCE_PROBLEM_CODES).slice(4).join(", ")}; table (schema.table) and sql (what the database's
    owner runs; Mason never does) null where none
`,
  options: { check: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
  json: ["ok", "tables", "replicated", "problems", "next"],
};

/** What a serve is told by its environment. */
export interface ServeSettings {
  name: string;
  apiKey: string;
  /** the project folder, absolute */
  project: string;
  /** the folder whose `.mason/` is the state, absolute */
  data: string;
  selfSignedTls: boolean;
  health: { host: string; port: number };
  /** the port of the page and the commands; `named`: MASON_UI_PORT said it, so it is that port or a refusal; `socket`:
   *  the Unix socket MASON_UI_SOCKET names, absolute, the page served there too (src/cli/ui-socket.ts), or null;
   *  `runFile`: the file MASON_UI_RUN_FILE names, absolute, the port and the token written there (src/cli/ui-run-file.ts), or null */
  ui: { port: number; named: boolean; socket: string | null; runFile: string | null };
}

const MIN_API_KEY = 32;

/** The Postgres API's port as the settings say it; null while MASON_PG_PORT is wrong, which the run's own check says. */
function pgPortOf(env: Readonly<Record<string, string | undefined>>): number | null {
  const a = pgListenerAddress(env, "127.0.0.1");
  return "problem" in a ? null : a.port;
}

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
  // the database name a tool connects with: the sources file's, else this, and never two names at once
  wrong.push(...databaseSettingProblems(project, env));
  // how each table is kept current, and how often a table is polled, are the sources file's sync: now, per table
  // (src/lib/table-sync.ts): the old settings refused HERE with the others, before anything is written or connected
  const top = (): SourcesTop => sourcesTop(path.dirname(project), project);
  const changes = changesRetiredText(env, top);
  if (changes !== null) wrong.push(changes);
  const pollMs = pollMsRetiredText(env, top);
  if (pollMs !== null) wrong.push(pollMs);
  // the history's days: MASON_HISTORY_DAYS, a number of days; the old name refused (src/duck/history.ts)
  const days = historyDaysSetting(env);
  if (typeof days !== "number") wrong.push(historyDaysWrongText(days));
  // MASON_DUCKDB_MEMORY not an amount (src/duck/store.ts memoryProblems), said here with the rest, before anything is
  // written or connected; a container under the floor starts, and the run warns (memoryWarning)
  wrong.push(...memoryProblems(env).map(memoryProblemText));
  // the project's files deployed read-only (src/cli/project.ts projectWriteRefusal): 1 or 0, anything else refused here
  const readOnly = projectReadOnlySetting(env);
  if (typeof readOnly !== "boolean") wrong.push(readOnly.problem);
  const selfSigned = env.MASON_PG_SELF_SIGNED_TLS || "0";
  if (selfSigned !== "0" && selfSigned !== "1") wrong.push(`MASON_PG_SELF_SIGNED_TLS=${JSON.stringify(selfSigned)}: 1, or 0 (the default)`);
  const portText = env.MASON_HEALTH_PORT || "4140";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) wrong.push(`MASON_HEALTH_PORT=${JSON.stringify(portText)}: a port number, 1-65535`);
  const uiText = env.MASON_UI_PORT || String(DEFAULT_UI_PORT);
  const uiPort = Number(uiText);
  if (!/^\d+$/.test(uiText) || uiPort < 1 || uiPort > 65_535) wrong.push(`MASON_UI_PORT=${JSON.stringify(uiText)}: a port number, 1-65535`);
  else if (env.MASON_UI_PORT && uiPort === port) wrong.push(`MASON_UI_PORT=${uiText} is MASON_HEALTH_PORT too: two ports`);
  else if (env.MASON_UI_PORT && uiPort === pgPortOf(env)) wrong.push(`MASON_UI_PORT=${uiText} is the Postgres API's port too (MASON_PG_PORT): two ports`);
  // a host would only be believed: the page has no address but loopback, and running on while one is asked for would hide that
  const socket = uiSocketSetting(env, cwd);
  if (socket !== null && typeof socket !== "string") wrong.push(socket.problem);
  // the run's file (src/cli/ui-run-file.ts): never the socket's own path
  const runFile = uiRunFileSetting(env, cwd);
  if (runFile !== null && typeof runFile !== "string") wrong.push(runFile.problem);
  else if (runFile !== null && runFile === socket) wrong.push(`${UI_RUN_FILE_SETTING} names the path MASON_UI_SOCKET names: two paths`);
  // the read-only page (src/cli/ui-read-only.ts): 1 or 0, anything else refused here, never read as off
  const pageReadOnly = uiReadOnlySetting(env);
  if (typeof pageReadOnly !== "boolean") wrong.push(pageReadOnly.problem);
  // what a read-only page still allows (src/cli/ui-read-only.ts): tables, and only beside MASON_UI_READ_ONLY=1
  const pageAllow = uiReadOnlyAllowSetting(env);
  if (!Array.isArray(pageAllow)) wrong.push(pageAllow.problem);
  // the link back to the site that links to the page (src/cli/ui-back-link.ts): a path or an http(s) URL, else refused here
  const backLink = uiBackLinkSetting(env);
  if (backLink !== null && "problem" in backLink) wrong.push(backLink.problem);
  // the sidebar as the host says it (src/cli/ui-nav.ts): each URL read as the link back's, the links a short JSON list
  const nav = uiNavSetting(env);
  if (nav !== null && "problem" in nav) wrong.push(nav.problem);
  // the host's card on the Overview (src/cli/ui-host-view.ts): a path relative to the page's address, else refused here
  const card = uiOverviewCardSetting(env);
  if (card !== null && typeof card !== "string") wrong.push(card.problem);
  // the address a client reaches (src/cli/pg-public-url.ts): its one reading, refused here with the rest
  const publicUrl = pgPublicUrlSetting(env);
  if (publicUrl !== null && "problem" in publicUrl) wrong.push(publicUrl.problem);
  if (env.MASON_UI_HOST) wrong.push("MASON_UI_HOST is set, and the web page has no address but 127.0.0.1: remove it (mason ui --ssh <user@server> opens the page from your machine)");
  if (wrong.length) {
    return { message: `${wrong.length === 1 ? "a setting is" : `${wrong.length} settings are`} missing or wrong: ${wrong.join("; ")}`, code: "bad_config",
      why: "mason serve reads its settings from the environment, and asks nothing",
      fix: "set them in the environment (a compose file's .env, the platform's variables), then start it again",
      next: [["mason serve --help", "every setting, with its default"]] };
  }
  return {
    name, apiKey, selfSignedTls: selfSigned === "1",
    project, data,
    health: { host: env.MASON_HEALTH_HOST || "0.0.0.0", port },
    ui: { port: uiPort, named: !!env.MASON_UI_PORT, socket: typeof socket === "string" ? socket : null, runFile: typeof runFile === "string" ? runFile : null },
  };
}


/**
 * THE DATABASE NAME AS A SETTING (src/lib/database-name.ts): a name, and one the sources file does not contradict, since
 * two names for one thing would have to be chosen between. A file that cannot be read is serveSource's to say.
 */
function databaseSettingProblems(project: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const set = env[DATABASE_SETTING];
  if (!set) return [];
  const bad = databaseNameProblem(set);
  if (bad !== null) return [`${DATABASE_SETTING}: ${bad}`];
  const written = writtenDatabase(project, path.dirname(project));
  if ("message" in written || written.database === null || written.database === set) return [];
  return [`${DATABASE_SETTING}=${JSON.stringify(set)}, and the sources file says database: ${written.database}: keep one`];
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
  if (found === null) return [`${variable} is not set: the database to sync from, as the sources file's url: \${${variable}} names it`];
  const p = parseSource(found.value, variable);
  return "problem" in p ? [p.problem] : [];
}

/**
 * THE CONFIG A SERVE RUNS ON, written from its settings at every start, over what the runs before recorded (the server
 * the copy was taken from, the publication, the certificate): the environment is the operator's, the rest the run's. A
 * project `mason init` made is a developer's and is never taken over; a name that moved would be another slot over the
 * same copy, so it is refused.
 */
export function serveConfig(s: ServeSettings, existing: Project | BrokenProject | null): { config: ProjectConfig; said: string[] } | Failure {
  const dir = path.join(s.data, STATE_DIR);
  if (existing === null) {
    const config = { ...newConfig(s.name, s.project), apiKey: s.apiKey, served: true };
    return { config, said: [`new synced data in ${dir}`] };
  }
  if ("broken" in existing) {
    return { message: `the state in ${dir} cannot be read: ${existing.file}: ${existing.broken}`, code: "bad_config",
      fix: `MASON_DATA names a folder of its own for mason serve; move ${dir} aside to sync again` };
  }
  const was = existing.config;
  if (was.served !== true) {
    return { message: `${dir} is a project mason init made, and mason serve keeps its own state`, code: "refused",
      why: "its config is a developer's (its database, its key), which a serve would overwrite from the environment",
      fix: "point MASON_DATA at an empty folder (the volume), or run mason start here" };
  }
  if (was.name !== s.name) {
    return { message: `the synced data in ${dir} is the project ${was.name}, and MASON_NAME says ${s.name}`, code: "refused",
      why: "the name names the replication slot: another name over the same synced data is another project (the database name a tool connects with is not this: MASON_PG_DATABASE, or database: in the sources file)",
      fix: `set MASON_NAME=${was.name} again, or give the new name a new MASON_DATA (an empty volume), which syncs again` };
  }
  const said: string[] = [`the synced data in ${dir}, resumed`];
  if (was.apiKey !== s.apiKey) said.push("MASON_API_KEY changed: every mason user is removed (mason user add each again)");
  // the source is the sources file's; a database restored elsewhere, or another one, is the run's to see (sourceMove);
  // an older Mason's `remote` is read by nothing (issue 888), and not written again
  const { source: _old, remote: _remote, ...kept } = was as ProjectConfig & { source?: unknown; remote?: unknown };
  return { config: { ...kept, apiKey: s.apiKey, folder: s.project, served: true }, said };
}

/**
 * THE PROJECT'S PIN, read from the project folder (MASON_PROJECT), in the words of what is running (src/lib/project-version.ts):
 * the image names the image to run, the package the npm line to run, each to the reader who can act on it. Before
 * anything is written or connected, so a project of another release line leaves a volume as it found it. A build that
 * is no release checks nothing.
 */
export function servePin(s: ServeSettings, running: RunningVersion): Failure | null {
  const p = (running.from === "image" ? imagePinProblem : commandPinProblem)(s.project, running.text);
  return p && { message: p.problem, code: "refused", fix: p.ways.join(", or ") || `correct ${PIN_FILE} in the project folder (MASON_PROJECT), then start it again` };
}

/**
 * THE PROJECT FOLDER'S SOURCES FILE, for a serve: one there is checked as the run reads it (src/cli/sources.ts
 * readSource: its URL resolved from this environment, every mistake on one report); a folder with none gets the file
 * `mason init` writes, `url: ${DATABASE_URL}` and no table, when DATABASE_URL is set — else what to set is said.
 */
export function serveSource(s: ServeSettings, env: NodeJS.ProcessEnv): { wrote: string | null; database: string } | Failure {
  let wrote: string | null = null;
  if (sourceFileNames(s.project).length === 0 && !fs.existsSync(path.join(s.project, OLD_TABLES_DIR))) {
    const url = env.DATABASE_URL ?? "";
    if (!url) {
      return { message: "DATABASE_URL is not set, and the project folder has no sources file to name the database another way", code: "bad_config",
        fix: "set DATABASE_URL=postgres://user:password@host:5432/app (the sources file mason init writes names it), or mount the project folder with its sources/ (MASON_PROJECT)",
        next: [["mason serve --help", "every setting, with its default"]] };
    }
    // a deployed project's files are its commit's (src/cli/project.ts projectWriteRefusal: this serve's own environment
    // decides, the config not written yet): a folder deployed without its sources file is said, never filled in
    const readOnly = projectWriteRefusal(null, env);
    if (readOnly !== null) {
      return { ...readOnly, message: `the project folder (${s.project}) has no sources file, and ${readOnly.message}`,
        fix: "edit the files and deploy them: mason init and mason add where the project is committed write its sources file; commit it, and deploy the folder with it",
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
  return "message" in r ? r : { wrote, database: connectDatabase(r, { served: true }, env) };
}

/**
 * WHAT THE VOLUME'S CONFIG RECORDS AND THE SOURCES FILE DOES NOT SAY (src/cli/replication-mode.ts recordRefusal), asked
 * BEFORE `serveSource` and the config are written: a file a serve writes itself says `sync: off`, no one's choice, and a
 * refused serve leaves the volume and the project folder as it found them. A file that cannot be read, and a project a
 * serve does not take over, are said by the steps after this.
 */
export function serveRecordRefusal(s: ServeSettings, existing: Project | BrokenProject | null, env: NodeJS.ProcessEnv): Failure | null {
  if (existing === null || "broken" in existing || existing.config.served !== true) return null;
  const written = sourceFileNames(s.project).length > 0;
  if (!written && fs.existsSync(path.join(s.project, OLD_TABLES_DIR))) return null;
  const file = written ? readSource(s.project, s.data, env, { shellFirst: true }) : null;
  if (file !== null && "message" in file) return null;
  return recordRefusal(existing.config, file, env, sourcesTop(path.dirname(s.project), s.project).shown, "mason serve");
}

/** Where a serve is: what /healthz and /metrics say. Once ready, `metrics` reads the run's numbers (src/cli/run-server.ts
 *  `metricsFacts`): required, so no ready phase exists where /healthz says ready and /metrics `mason_ready 0`. */
export type ServePhase = { phase: "starting" }
  | { phase: "ready"; tables: () => CopyState[]; metrics: () => Promise<Omit<RunMetrics, "uptimeSeconds">> }
  | { phase: "stopping" }
  /** the engine stopped under the run (its thread died, or the synced data was invalidated, issue 830): it exits 1 for
   *  the platform to start it again, its reason in the log — never on this unauthenticated answer */
  | { phase: "failed" };

/**
 * WHERE THE WEB PAGE IS SERVED, as /healthz says it from the start: the Unix socket's path (MASON_UI_SOCKET) or null, and
 * whether it is read-only (MASON_UI_READ_ONLY). Said while it starts too, so a supervisor tells a Mason that serves no
 * socket (null; an older one has no `page`) from one still starting. Never the token.
 */
export interface PageServed { socket: string | null; readOnly: boolean }
export const NO_PAGE_SERVED: PageServed = { socket: null, readOnly: false };

/** seconds since the serve started: /healthz's `uptimeSeconds` and /metrics' `mason_uptime_seconds`, one number */
const uptimeSeconds = (startedAt: number, now: number): number => Math.floor((now - startedAt) / 1000);

/**
 * /healthz's answer: 200 once the run answers, whatever its copies are doing (a table still copying, or one that failed,
 * leaves the rest served: the counts say it); 503 while it starts and stops. Counts only, never a table's name: the
 * endpoint takes no credential.
 */
export function healthBody(state: ServePhase, startedAt: number, now = Date.now(), page: PageServed = NO_PAGE_SERVED): { status: number; body: Record<string, unknown> } {
  const base = { status: state.phase, version: version(), uptimeSeconds: uptimeSeconds(startedAt, now), page: { socket: page.socket, readOnly: page.readOnly } };
  if (state.phase !== "ready") return { status: 503, body: base };
  return { status: 200, body: { ...base, tables: phaseCounts(state.tables()) } };
}

/**
 * /metrics' answer: ALWAYS 200 (a scrape that errors while Mason starts is an alert about nothing; whether it is up is
 * /healthz's to say) — `mason_ready 0` and `mason_info` while it starts or stops, the run's numbers once it serves.
 */
export async function metricsBody(state: ServePhase, startedAt: number, now = Date.now()): Promise<string> {
  if (state.phase !== "ready") return metricsText({ version: version(), run: null });
  const run = await state.metrics();
  return metricsText({ version: version(), run: { ...run, uptimeSeconds: uptimeSeconds(startedAt, now) } });
}

/** The health server: GET /healthz and GET /metrics, nothing else. `log` says a scrape whose numbers could not be read. */
export function healthServer(state: () => ServePhase, startedAt: number, log: (line: string) => void = say, page: PageServed = NO_PAGE_SERVED): http.Server {
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
    const h = healthBody(state(), startedAt, Date.now(), page);
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
  const pinned = servePin(s, runningVersion());
  if (pinned) return failed("serve", pinned, { json });
  const existing = readProject(s.data);
  const unsaid = serveRecordRefusal(s, existing, process.env);
  if (unsaid !== null) return failed("serve", unsaid, { json });
  if (f.values.check === true) return serveCheck(s, process.env, json);
  // the project folder: its sources file is the list of what is copied, one with no table written when there is none
  const made = serveSource(s, process.env);
  if ("message" in made) return failed("serve", made, { json });
  const c = serveConfig(s, existing);
  if ("message" in c) return failed("serve", c, { json });
  try { writeConfig(path.join(s.data, STATE_DIR), c.config); }
  catch (e) {
    return failed("serve", { message: `the state cannot be written to ${path.join(s.data, STATE_DIR)}: ${(e as Error).message}`, code: "refused",
      fix: "MASON_DATA names a folder this user can write: the volume's mount point" }, { json });
  }
  // a port named is that port: said here, before anything listens, as the next free one would hide the setting
  const held = s.ui.named ? await portHolder(s.ui.port) : null;
  if (held !== null) return failed("serve", { message: `MASON_UI_PORT: ${heldText(s.ui.port, held)}`, code: "refused", fix: "name another port, or leave MASON_UI_PORT unset for the next free one" }, { json });
  // the page's socket, before anything listens: its folder and its path held to the bar, a stale one replaced, then made
  let page: UiSocket | null = null;
  // what making it says, under the start's heading below
  const socketSaid: string[] = [];
  if (s.ui.socket !== null) {
    const prepared = await prepareUiSocket(s.ui.socket, (l) => socketSaid.push(l));
    if (prepared !== null) return failed("serve", prepared, { json });
    const opened = await listenOnUiSocket(s.ui.socket, (l) => say(`  ${l}`));
    if ("message" in opened) return failed("serve", opened, { json });
    page = opened;
  }
  // the run's file: written once the run answers (asserted wide: they are set in the run's hooks, which the compiler
  // does not follow)
  let runFile = null as UiRunFile | null;
  let runFileFailed = null as Failure | null;
  // a SIGTERM before the run has its own stop (the run file's check, the run still connecting) ends the process by its
  // default action, which runs no finally: the socket is removed first, then the signal raised again as it was
  const early = (signal: NodeJS.Signals): void => {
    if (process.listenerCount(signal) > 1) return;   // the run's stop is in place: it stops, and the finally removes it
    page?.close();
    runFile?.remove();
    unhookEarly();
    process.kill(process.pid, signal);
  };
  const unhookEarly = (): void => { process.removeListener("SIGTERM", early); process.removeListener("SIGINT", early); };
  if (page !== null) { process.on("SIGTERM", early); process.on("SIGINT", early); }
  // its folder and its path held to the bar now, a stale one removed (its run asked, up to 2 s: the handler is in place)
  if (s.ui.runFile !== null) {
    const prepared = await prepareUiRunFile(s.ui.runFile, (l) => socketSaid.push(l));
    if (prepared !== null) { page?.close(); unhookEarly(); return failed("serve", prepared, { json }); }
  }
  const startedAt = Date.now();
  let state: ServePhase = { phase: "starting" };
  /** the engine stopped under the run (`ServeHooks.failed`): how the serve's last word says its exit */
  let engineStopped = false;
  const health = healthServer(() => state, startedAt, say, { socket: page?.file ?? null, readOnly: uiReadOnlySetting(process.env) === true });
  const listening = await new Promise<Error | null>((resolve) => {
    health.once("error", resolve);
    health.listen(s.health.port, s.health.host, () => resolve(null));
  });
  if (listening !== null) {
    page?.close();
    unhookEarly();
    return failed("serve", { message: `the health endpoint cannot listen on ${s.health.host}:${s.health.port}: ${listening.message}`, code: "refused",
      fix: "MASON_HEALTH_PORT names a port free on this machine" }, { json });
  }
  say(`mason serve: ${s.name}, the project in ${s.project}, the state in ${path.join(s.data, STATE_DIR)}`);
  if (made.wrote) say(`  wrote ${made.wrote}: the database (url: \${DATABASE_URL}), no table yet (mason add beside it adds one)`);
  for (const l of c.said) say(`  ${l}`);
  say(`  database  ${made.database}, what a tool connects with`);
  say(`  health    http://${s.health.host}:${s.health.port}/healthz`);
  say(`  metrics   http://${s.health.host}:${s.health.port}/metrics`);
  for (const l of socketSaid) say(`  ${l}`);
  if (s.ui.runFile !== null) say(`  run file  ${s.ui.runFile}: written once Mason answers (mode 0600; it holds the run's token)`);
  if (page !== null) say(`  web page  ${page.file} (a Unix socket, mode 0600: a request on it passes the same guard as mason ui --ssh's)`);
  const backLink = uiBackLinkSetting(process.env);
  if (backLink !== null && !("problem" in backLink)) say(`  web page  a link back at the top of its sidebar, ${JSON.stringify(backLink.label)} (MASON_UI_BACK_URL)`);
  for (const l of navLines(navOf(uiNavSetting(process.env)))) say(`  web page  ${l}`);
  const card = overviewCardOf(uiOverviewCardSetting(process.env));
  if (card !== null) say(`  web page  the host's card on its Overview, read from the page's address (${UI_OVERVIEW_CARD_SETTING})`);
  const pageAllow = uiReadOnlyAllowSetting(process.env);
  if (uiReadOnlySetting(process.env) === true) {
    const allowed = Array.isArray(pageAllow) ? pageAllowsText(pageAllow) : null;
    say(Array.isArray(pageAllow) && allowed !== null
      ? `  web page  read-only (${UI_READ_ONLY_SETTING}=1) but ${allowed} (${UI_READ_ONLY_ALLOW_SETTING}=${pageAllow.join(",")}): it refuses every other change it is sent; the mason commands beside it are unchanged`
      : `  web page  read-only (${UI_READ_ONLY_SETTING}=1): it refuses every change it is sent; the mason commands beside it are unchanged`);
  }
  // the run reads the project of the folder it runs in (src/cli/project.ts): the data folder's
  process.chdir(s.data);
  let code: number;
  try {
    code = await dev({ port: s.ui.port, exactPort: s.ui.named, version: version(), selfSignedTls: s.selfSignedTls,
      serve: { log: say,
        ready: (run) => {
          // the run's file before /healthz says ready: a supervisor that sees ready finds it
          if (s.ui.runFile !== null) {
            const w = writeUiRunFile(s.ui.runFile, run.page, (l) => say(`  ${l}`));
            if ("message" in w) {
              // fail closed: a supervisor would wait on a file that never comes, so the run stops, never says it is
              // ready, records why, and the serve exits 1
              runFileFailed = w;
              say(`  ${w.message}: Mason stops (${w.fix})`);
              state = { phase: "stopping" };
              return `stopped: the run file (${UI_RUN_FILE_SETTING}) could not be written: ${w.message.slice(`${UI_RUN_FILE_SETTING}=`.length)}`;
            }
            runFile = w;
            say(`  run file  ${w.file} (the web page's port and the run's token, mode 0600)`);
          }
          state = { phase: "ready", tables: run.tables, metrics: run.metrics };
          return null;
        },
        stopping: () => { state = { phase: "stopping" }; page?.close(); runFile?.remove(); },
        failed: () => { state = { phase: "failed" }; engineStopped = true; page?.close(); runFile?.remove(); },
        ...(page !== null ? { page: page.attach, socket: page.file } : {}) } });
  } finally {
    // removed whatever ended the run: a stop, a crash of the engine's thread, or a start that failed
    page?.close();
    runFile?.remove();
    unhookEarly();
    // a platform's health check may hold a keep-alive connection open, which close() alone would wait for
    health.closeAllConnections();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }
  if (runFileFailed !== null) return failed("serve", runFileFailed, { json: false });
  // the engine stopped after the run was ready: a crash, said as one (its FATAL line is above), for the platform's restart
  if (code !== 0 && engineStopped) return failed("serve", { message: "Mason stopped: the engine stopped under it, as said above", code: "failed",
    fix: "it is started again by its platform or supervisor, which opens the synced data again; when it says the same again, fix what it says (free disk, if it is full)" }, { json: false });
  if (code !== 0) return failed("serve", { message: "Mason did not start: what stopped it is said above", code: "failed",
    fix: "fix what it says, then start it again (a platform restarts it by itself)" }, { json: false });
  return 0;
}

/**
 * `mason serve --check` (issue 779): the project folder's files against the database, as the start would hold them, and
 * nothing run — every problem on ONE answer, each with its fix (src/cli/source-check.ts). Nothing is written: no config,
 * no sources file (a folder with none is refused, never filled in), and the synced data is never opened, so it runs
 * beside a serve of the same volume. A hosted service may run it on a deploy's new files before it writes them.
 */
export async function serveCheck(s: ServeSettings, env: NodeJS.ProcessEnv, json: boolean): Promise<number> {
  const src = readSource(s.project, s.data, env, { shellFirst: true });
  if ("message" in src) return failed("serve", src, { json });
  let checked;
  try { checked = await checkProjectSource(src, { name: s.name, folder: s.project, root: s.project, env }); }
  catch (e) {
    return failed("serve", { message: `the check could not finish: ${(e as Error).message}`, code: "failed",
      fix: "check again; a check that cannot finish never says the database can serve the project", next: [["mason serve --check", "checks again"]] }, { json });
  }
  const { problems, tables, replicated } = checked;
  if (problems.length === 0) {
    const next: NextStep[] = [["mason serve", "runs the project"]];
    if (json) { process.stdout.write(`${jsonText(SERVE, { ok: true, tables, replicated, problems: [] }, next)}\n`); return 0; }
    say(reportText({ headline: "The database can serve this project; nothing was written", details: [["tables", String(tables)], ["replication", `${replicated} of them`]], next }));
    return 0;
  }
  const f: Failure = {
    message: `the database cannot serve this project as its files say: ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}`, code: "refused",
    why: problems.map((p) => `- ${problemLine(p)}`).join("\n"),
    fix: "fix each as said — a statement is run by the database's owner, never by Mason — then check again; nothing was written or changed",
    next: [["mason serve --check", "checks again"]],
  };
  // under --json the failure's shape, with the problems beside it as data
  return failed("serve", f, { json, beside: { problems } });
}
