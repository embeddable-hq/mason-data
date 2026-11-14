/**
 * `mason start` (one run per project): Mason for the project of this folder
 * (src/cli/project.ts), on the database its sources file names (src/cli/sources.ts), copying the tables it names.
 *
 *   0. A DEMO PROJECT'S DATABASE (`mason init demo`, src/cli/demo.ts): hosted by this process, opened first on the port
 *      the sources file's URL names, then connected to and read as any database is (by polling: it has no change log),
 *      and changed every few seconds so the copy is seen keeping current.
 *   1. THE DATABASE (src/cli/preflight.ts checkSource): connect as the run will, say what to change when it cannot,
 *      and what is worth knowing of it as information (on another machine; the main database, until the first sync is
 *      done). Its catalog is read again only when asked (src/cli/source-catalog.ts). A database restored to another server
 *      is read again (its rows compared, the unchanged kept); another database is refused (mason destroy, then mason start).
 *   2. THE COPY (src/duck/store.ts, src/duck/sync.ts): DuckDB in this process, file-backed in `.mason/duck.db`; each
 *      added table copied whole from the database and kept current as its sync: in the sources file says: by the
 *      xmin poll, by logical replication (src/duck/stream.ts), or only when mason sync asks (off).
 *   3. THE COMMAND SERVER (src/cli/run-server.ts) on 127.0.0.1, which `mason tables`, `mason add`, `mason status` …
 *      ask with the run's token from the project's config (src/cli/control.ts, src/cli/security.ts).
 *   4. THE POSTGRES LISTENER (src/api/postgres/server.ts): a BI tool or an app connects as to a read replica, as a
 *      `mason user`, and every statement is answered from the copy.
 *   5. `mason stop` (or Ctrl-C under --attach) stops it all. Nothing was created on the database (polling), so nothing
 *      is left there; the next `mason start` resumes from the file.
 *
 * IN THE BACKGROUND (as good for people as for coding agents): `mason start` starts the run
 * as a process of its own, shows its start, and RETURNS once it answers — a coding agent cannot wait on a command that
 * never ends. The run's terminal is its log (`mason logs`). `--attach` runs it in the foreground, as before.
 *
 * What a run keeps between runs (the API key, the copy, the users, the logs) is in the project's `.mason/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Server } from "node:http";
import { choosePgPort, freePort } from "./ports.ts";
import { failed, type Problem } from "./command.ts";
import { checkSource, connectSource, maskedUrl, PRIMARY_NOTE, readSourceFacts, readTables, type SourceFacts } from "./preflight.ts";
import { actRead, sourceCatalog, STATE_WAIT_MS, watchedRead } from "./source-catalog.ts";
import { uiReadOnlyAllowSetting, uiReadOnlySetting, type PageArea } from "./ui-read-only.ts";
import { backLinkOf, uiBackLinkSetting } from "./ui-back-link.ts";
import { accountOf, uiAccountSetting } from "./ui-account.ts";
import { navOf, uiNavSetting } from "./ui-nav.ts";
import { overviewCardOf, uiOverviewCardSetting } from "./ui-host-view.ts";
import { iconOf, uiIconSetting } from "./ui-icon.ts";
import { createRunServer, listenOnLoopback, metricsFacts, usageFacts, type RunContext } from "./run-server.ts";
import { UiErrors } from "./ui-errors.ts";
import type { RunMetrics } from "./metrics.ts";
import { readGenerated } from "./generated-files.ts";
import { addedTables, arrivedSecrets, effectiveSync, entryName, leftOutText, replicatedEntries, rereadSources, shownPath, syncWritten, withLeftOut, withTable, type ArrivedSecrets, type RunSources, type SourceFile } from "./sources.ts";
import { newToken } from "./security.ts";
import { alive, liveRun, processStart } from "./runs.ts";
import { DEMO_DIR, DUCK_FILE, projectReadOnlySetting, projectSource, projectWriteRefusal, startSettingRefusal, theProject, writeConfig, type PostgresListener, type ProjectConfig } from "./project.ts";
import { boundedLiveChecks } from "./sync-choice.ts";
import { closedWithin, closingOnce, DEMO_STILL_CLOSING, demoChanges, demoChangesRefusal, demoPort, demoSettings, openDemo } from "./demo.ts";
import { postgresApiUrl, readPgTls, type PgListenerSettings } from "../api/postgres/listener.ts";
import { connectDatabase } from "../lib/database-name.ts";
import { certificateFingerprint, elsewhereTip, ensureSelfSigned, listenerText, runListenerSettings, selfSignedPair, SELF_SIGNED_FILES } from "./pg-tls.ts";
import { RunShares } from "./share-run.ts";
import { PageShares } from "./page-share.ts";
import { sweepTunnelFiles } from "./tunnel.ts";
import { startPostgresApi, timeoutMs, type PgApiServer } from "../api/postgres/server.ts";
import { RequestLedger, REQUESTS_TABLE } from "../duck/requests.ts";
import { historyDaysSetting } from "../duck/history.ts";
import { EVENTS_TABLE, SyncEvents } from "../duck/events.ts";
import { USAGE_TABLE, UsageSampler } from "../duck/usage.ts";
import { clientLink, shownUrl } from "./pg-url.ts";
import { pgPublicUrlSetting, publicUrlText } from "./pg-public-url.ts";
import { UI } from "./ui.ts";
import { cliPinProblem, ensurePin } from "./pin.ts";
import { DEFAULT_MEMORY_LIMIT, DuckStore, DUCKDB_VERSION, machineMemory, memoryProblems, memoryProblemText, memoryWarning } from "../duck/store.ts";
import { copyChunkSecondsOf, copyParallelOf, humanBytes, Sync, syncModeOf, type CopyState } from "../duck/sync.ts";
import { storeJsonPathsOf } from "../duck/kept.ts";
import { libcOrderNote, readLibcOrder, type LibcOrder } from "../duck/libc-order.ts";
import { isLibcCollation, type SourceCollation } from "../duck/collation.ts";
import { pgIdent } from "../cdc/pg-wire.ts";
import { listenerLogins, LiveUsers, readUsers, USERS_FILE } from "../duck/users.ts";
import { exampleRole, LiveRoles, missingAttributesText, noRoleWayOut, readRoles, resolveRoles, rolesDefaultLine, rolesFile, usersMissingAttributes, usersWithNoRole, usersWithoutRole } from "./roles.ts";
import { READY_LINE, readRestarts } from "./supervise.ts";
import { dropOwnReplication, dropStatements, liveReadinessFailure, madeReplication, namedPublication, projectReplication, recordRefusal, replicationReadiness, staleReplication } from "./replication-mode.ts";
import { textEntry } from "../lib/log.ts";
import { withDiskWayOut, writeFailureText } from "../lib/disk-full.ts";
import { guardTerminal, RunLog, terminalLine } from "./run-output.ts";
import { LogBuffer } from "../lib/log-buffer.ts";
import { logPath } from "../lib/log-read.ts";
import { BIG_TABLE_ROWS, syncText, type TableSync } from "../lib/table-sync.ts";

/** MASON_UI_READ_ONLY_ALLOW's areas, or none when it is wrong (the start refused it first: never read as more). */
const allowedOf = (a: ReturnType<typeof uiReadOnlyAllowSetting>): PageArea[] => Array.isArray(a) ? a : [];

export interface DevOptions {
  /** the port the commands reach the run on (src/cli/run-server.ts), or the next free one */
  port: number;
  /** `port` was named by a setting (MASON_UI_PORT): that port, never the next free one (src/cli/serve.ts checks it first) */
  exactPort?: boolean;
  version: string;
  /** --self-signed-tls: the Postgres listener serves a certificate made for the project in .mason/ (src/cli/pg-tls.ts) */
  selfSignedTls: boolean;
  /** `mason serve` runs this run on a server (src/cli/serve.ts): its log on stdout, its health said to the platform */
  serve?: ServeHooks;
}

/** What `mason serve` is told by the run it serves (src/cli/serve.ts). */
export interface ServeHooks {
  /** each line of the run's log, as it is written to .mason/mason.log: a container's log is its stdout */
  log: (line: string) => void;
  /** the run answers: its listener is up and its tables are added (they may still be copying); `metrics` reads what
   *  `GET /metrics` says (src/cli/run-server.ts `metricsFacts`). Returns null, or why a step of the serve's own failed:
   *  the run then stops with that as its lastStop, and never says it is ready */
  ready: (run: { tables: () => CopyState[]; metrics: () => Promise<Omit<RunMetrics, "uptimeSeconds">>;
    /** the page's port on 127.0.0.1 and the run's token: what MASON_UI_RUN_FILE writes (src/cli/ui-run-file.ts) */
    page: { port: number; token: string } }) => string | null;
  /** a SIGTERM or SIGINT is stopping it */
  stopping: () => void;
  /** the engine stopped under it (its thread died, or the synced data was invalidated): the run ends, exit 1, for the
   *  platform to start it again; its reason is in the log */
  failed: () => void;
  /** the page's Unix socket (MASON_UI_SOCKET, src/cli/ui-socket.ts) is given the run's server, whose requests it serves */
  page?: (server: Server) => void;
  /** that socket's path: `/api/state` `pageSocket` */
  socket?: string;
}

/** a line to the run's terminal, which a full disk never ends (src/cli/run-output.ts), a write under .mason/ that
 *  failed for disk space given its way out (src/lib/disk-full.ts) */
const say = (m: string): void => { terminalLine("stdout", `${withDiskWayOut(m)}\n`); };

/**
 * THE RUN'S STEPS, as lines (an opening block of prose was too much to read, as `mason init`'s had been): a step begun,
 * done or failed, each a line its terminal shows as it is and its relay (src/cli/background.ts) draws as a checklist —
 * a spinner while one runs, ✔ or ✘ when it ends.
 */
export const STEP_MARK = { begin: "▸ ", done: "✓ ", fail: "✗ " } as const;
const begin = (label: string): void => { say(`${STEP_MARK.begin}${label}`); };
const done = (text: string): void => { say(`${STEP_MARK.done}${text}`); };
const fail = (text: string): void => { say(`${STEP_MARK.fail}${text}`); };

/**
 * WHAT THE SERVER UNDER THE DATABASE SAYS about the copy this project holds (a database moved to a different host is
 * still the same database): the same database on a new server is read again — the poll's watermarks
 * are the old server's transaction ids, which mean nothing there — and another database is refused, because its rows
 * are not the copy's. `recorded` is what the first start saw; null records it now.
 */
export function sourceMove(recorded: ProjectConfig["sourceServer"], now: { database: string; systemIdentifier: string | null }):
  { action: "record" | "same" | "reread" } | { refuse: string } {
  if (!recorded) return { action: "record" };
  if (recorded.database !== now.database) {
    return { refuse: `this project's synced data is of the database ${recorded.database}, and .mason/config.json now names ${now.database}. ` +
      "Its synced rows are not that database's: mason destroy (removes the synced data; your files stay), then mason start syncs it" };
  }
  if (recorded.systemIdentifier !== null && now.systemIdentifier !== null && recorded.systemIdentifier !== now.systemIdentifier) return { action: "reread" };
  return { action: "same" };
}

/** What the run hosts beside the copy (a demo project's database), stopped and closed however the run ends, and its
 *  log, ended last. */
interface Hosted {
  /** the demo database's writer, once it runs */
  stopChanges: (() => void) | null;
  /** closes the demo database, once (src/cli/demo.ts closingOnce); null when there is none, or it was closed */
  close: (() => Promise<string | null>) | null;
  /** the run's log file, once it is open: ended, its lines written, before the process exits */
  log: RunLog | null;
}

/** how long the run's end waits for its log's last lines to reach the file */
const LOG_END_MS = 2_000;

/**
 * The run, and whatever it hosts closed however it ends: a demo database that was opened is closed at the stop (after
 * the sync, before the copy), and by this on every other way out — a failed step, a crash — its data flushed to its
 * folder, a close that fails said.
 */
export async function dev(o: DevOptions): Promise<number> {
  const hosted: Hosted = { stopChanges: null, close: null, log: null };
  try { return await run(o, hosted); }
  finally {
    hosted.stopChanges?.();
    await closeDemo(hosted, null);
    // LAST, AND WAITED FOR (issue 913): the log is written through a stream, and the process exits at once after this
    // (src/lib/exit-when-written.ts), which drops what the stream still holds — a crash's cause line among it, and the
    // supervisor then said "it crashed" with no cause in mason logs
    const log = hosted.log;
    if (log !== null) await closedWithin(log.end(), LOG_END_MS, () => say(`  the run's log ${log.file} was still being written after ${LOG_END_MS / 1000} s; its last lines may be missing`));
  }
}

/** The demo database closed, if it is open: a failure said, never swallowed; `closed`, when given, said once it closed. */
async function closeDemo(hosted: Hosted, closed: string | null): Promise<void> {
  const close = hosted.close;
  if (close === null) return;
  hosted.close = null;
  const failure = await close();
  if (failure !== null) say(`  closing the demo database: ${failure}`);
  else if (closed !== null) say(`  ${closed}`);
}

/** how soon a pass that failed (the database away) is tried again, and replication mode's pass when a table waits */
const PASS_RETRY_MS = 5000;
/** how long a libc collation's order may take to read from the source (a few seconds of read-only SELECTs): past it the
 *  read is given up, and the statements that need it refused by name */
const LIBC_READ_MS = 120_000;

/** the tables by their sync, as the start line says them: ` (2 polled, every 5s and 30s; 1 replicated; 1 off)` */
function syncCounts(tables: ReadonlyArray<{ sync?: TableSync }>): string {
  const polled = tables.flatMap((t) => t.sync?.mode === "poll" ? [t.sync.every] : []);
  const replicated = tables.filter((t) => t.sync?.mode === "replication").length;
  const off = tables.length - polled.length - replicated;
  const parts = [...(polled.length ? [`${polled.length} polled, every ${[...new Set(polled)].join(" and ")}`] : []), ...(replicated ? [`${replicated} replicated`] : []), ...(off ? [`${off} off`] : [])];
  return parts.length ? ` (${parts.join("; ")})` : "";
}

/**
 * THE SOURCES FILE'S DEFAULT SYNC, SAID ONCE AT THE START: what every table without its own `sync:` gets — `off` (the
 * default, said as such when the file writes none), the file's `poll <interval>` or `replication` — and how to change it.
 *
 * AN UPGRADE THAT STOPS THE POLLS IS SAID LOUDLY (issue 33's review): a file an older Mason wrote has no `sync:`
 * anywhere, and its tables were polled every 5 s; from this release they are `off`. When the copy already holds
 * `copiedBefore` of its tables and no `sync:` is written at all, the line says how many are not polled, that an older
 * Mason polled them, and the exact line that keeps them current as before — true too of a hand-written file on a
 * project that never polled.
 */
export function syncDefaultLine(file: SourceFile, shown: string, copiedBefore = 0): string {
  const d = effectiveSync(file, undefined);
  if (!syncWritten(file) && copiedBefore > 0) {
    // true of a file an older Mason polled and of one written by hand that never was: "not polled", the old way said.
    // That Mason left a big table out of its polls, and the line that keeps the rest as before does not (BIG_TABLE_ROWS)
    return `sync: off (the default): ${copiedBefore === 1 ? "1 table is" : `${copiedBefore} tables are`} not polled (an older Mason polled every table under ${BIG_TABLE_ROWS.toLocaleString("en-US")} rows every 5 s); ` +
      `\`sync: poll 5s\` at the top of ${shown} keeps them current as before, but polls the bigger ones too, each poll a full scan on your database: ` +
      "give those `sync: off` on their entry (mason tables shows the rows), or use `mason sync <table>` when you need it";
  }
  if (d.from === "default") return `sync: off (the default): after its first sync, a table is read again only by mason sync <table> — sync: poll 5m at the top of ${shown} polls every table, or on an entry that one`;
  return d.sync.mode === "off" ? `sync: off (${shown}): after its first sync, a table is read again only by mason sync <table>, unless its entry says sync: poll <interval>`
    : d.sync.mode === "replication" ? `sync: replication (${shown}): every table without a sync: of its own is kept current from the database's change log`
    : `sync: ${syncText(d.sync)} (${shown}): every table without a sync: of its own is polled every ${d.sync.every}`;
}

/** WHAT REPLICATION MAKES ON THE DATABASE, recorded in the project's config as it is (at the start that replicates a
 *  table, and when the run makes the slot later): the names `mason destroy`, and a start whose file replicates nothing,
 *  drop — never computed again (src/cli/replication-mode.ts madeReplication) */
function recordReplication(cfg: ProjectConfig, repl: ReturnType<typeof projectReplication>, home: string): void {
  const recorded = repl.owned ? null : repl.publication;
  if ((cfg.publication ?? null) === recorded && JSON.stringify(cfg.replication ?? null) === JSON.stringify(repl)) return;
  cfg.publication = recorded;
  cfg.replication = repl;
  writeConfig(home, cfg);
}

async function run(o: DevOptions, hosted: Hosted): Promise<number> {
  // when this run began: the uptime /api/state says (engine.startedAt, a supervisor's restart is a new run)
  const startedAt = Date.now();
  // the terminal's failure to write (dev.log on a full disk) never ends the run: said on the other stream until the log
  // is open, and in the log too from then on (below)
  guardTerminal(() => undefined);
  const t = theProject(process.cwd());
  if ("problem" in t) { say(`mason start: ${t.problem}`); return 1; }
  const project = t.project;
  const cfg = project.config;
  const home = project.dir;
  const folder = project.folder;
  // ONE mason start per project: a second would open the same DuckDB file, which DuckDB refuses to a second writer
  const other = await liveRun(project);
  if (other !== null) { say(`mason start: Mason is already running for ${cfg.name} (pid ${other.pid}): mason status says what it is doing`); return 1; }
  // A DEMO PROJECT IS POLLED (src/cli/demo.ts): its database has no change log, so replication is refused before anything starts
  const demoRefused = demoChangesRefusal(cfg);
  if (demoRefused) return failed("start", demoRefused, { json: false });
  let demoChangeMs: number | null = null;
  if (cfg.demo === true) {
    try { demoChangeMs = demoSettings(process.env).changeMs; }
    catch (e) { say(`mason start: ${(e as Error).message}`); return 1; }
  }
  // mason serve has held the project to its pin already, before it wrote anything (src/cli/serve.ts servePin)
  const pinned = o.serve ? null : cliPinProblem(folder, o.version);
  if (pinned) { say(`mason start: ${pinned}`); return 1; }
  // a setting a start refuses (the parent of a background start has asked the same list: src/cli/project.ts)
  const setting = startSettingRefusal(project, process.env, { serve: o.serve !== undefined });
  if (setting !== null) return failed("start", setting, { json: false });
  // THE PROJECT'S FILES DEPLOYED READ-ONLY (MASON_PROJECT_READONLY=1): recorded in the config at every start, and removed
  // at a start without, so a command beside the run — up or down, whatever its own environment — is refused as the run
  // is (src/cli/project.ts projectWriteRefusal reads the record and the environment; a value not 0 or 1 is refused above)
  if (projectReadOnlySetting(process.env) === true) {
    if (cfg.projectReadOnly !== true) { cfg.projectReadOnly = true; writeConfig(home, cfg); }
  } else if (cfg.projectReadOnly !== undefined) { delete cfg.projectReadOnly; writeConfig(home, cfg); }
  // the history's days (MASON_HISTORY_DAYS, a number of days; the old MASON_REQUEST_LOG_DAYS refused, named), read
  // before anything opens (src/duck/history.ts); every history below keeps them
  const keptDays = historyDaysSetting(process.env);
  if (typeof keptDays !== "number") return failed("start", { code: "refused", ...keptDays }, { json: false });
  // MASON_DUCKDB_MEMORY not an amount (src/duck/store.ts memoryProblems), refused before anything opens (mason serve has
  // said it already, with its other settings)
  const memory = memoryProblems(process.env)[0];
  if (memory !== undefined) return failed("start", { code: "refused", ...memory }, { json: false });
  // THE SOURCE (src/cli/sources.ts): the database and the tables to copy, from the project's sources file; a server's
  // URL from its environment first (mason serve is configured by it alone). Read here, its failure said below where it
  // always was (after the listener's checks): a demo project's port is needed first
  const readSources = (): ReturnType<typeof projectSource> => projectSource(project, process.env, { shellFirst: o.serve !== undefined });
  const src = readSources();
  // what the config records and the file does not say (an older Mason's replication): refused before the port below is
  // recorded or the pin written, and long before anything on the database is dropped or made
  const unsaid = "message" in src ? null : recordRefusal(cfg, src, process.env, shownPath(project.root, src.file), o.serve ? "mason serve" : "mason start");
  if (unsaid !== null) return failed("start", unsaid, { json: false });
  // a demo project's database listens on the port its URL names (the one place it is kept), which no listener of the
  // run's may take: read BEFORE the Postgres API's port is chosen and recorded, so the choice avoids it (a recorded or
  // named port that is the demo's is refused by choosePgPort, nothing recorded), and the command server is kept off it
  const demoAt = cfg.demo === true && !("message" in src) ? demoPort(src.resolved, src.from) : null;
  const demoPorts = new Set(demoAt !== null && "port" in demoAt ? [demoAt.port] : []);
  // THE PORT IS THE PROJECT'S (src/cli/ports.ts): the first start's choice recorded, every later start on it or refused
  const pg = await choosePgPort(process.env.MASON_PG_PORT, demoPorts, cfg.pgPort ?? null);
  if ("problem" in pg) return failed("start", pg, { json: false });
  if (cfg.pgPort !== pg.port) { cfg.pgPort = pg.port; writeConfig(home, cfg); }
  // WHERE AND HOW THE POSTGRES LISTENER LISTENS (src/cli/pg-tls.ts): the one reader of MASON_PG_HOST and
  // MASON_PG_TLS_CERT / _KEY (src/api/postgres/listener.ts), its plain-listener rule refused here, before anything is connected or started
  const listen = runListenerSettings(process.env, { port: pg.port, selfSigned: o.selfSignedTls, home });
  if ("problem" in listen) return failed("start", listen, { json: false });
  const pgTls = listenerTls(listen, o.selfSignedTls, home, cfg);
  if ("problem" in pgTls) return failed("start", pgTls, { json: false });
  const chosen = new Set([pg.port, ...demoPorts]);
  // a server's project folder is the team's, committed, and may be mounted read-only: mason serve writes nothing there
  const wrotePin = o.serve ? null : ensurePin(folder, o.version, project.root);
  if (wrotePin) say(`  wrote ${path.relative(project.root, wrotePin)}: version ${o.version}, the Mason this project is written for — commit it`);
  if ("message" in src) return failed("start", src, { json: false });
  // a demo project's file naming sync: replication (its database has no change log), refused before anything opens
  const demoFile = demoChangesRefusal(cfg, src, shownPath(project.root, src.file));
  if (demoFile) return failed("start", demoFile, { json: false });
  const logFile = logPath(home, "run");
  // one entry a line: a multi-line message's further lines indented under it (src/lib/log.ts `textEntry`);
  // mason serve gets the same entry, for the container's stdout (src/cli/serve.ts)
  // the last entries are kept in memory too (src/lib/log-buffer.ts), for the command server's /api/logs: the one writer
  // feeds the file, stdout and the buffer, so a mode with no file (mason serve) has the log as well.
  // A write under .mason/ that failed for disk space is given its way out here, whoever logged it (src/lib/disk-full.ts)
  const logs = new LogBuffer();
  /** an entry to every reader but the file: what the file's own failure is said with */
  const beside = (entry: string): void => { logs.push(entry); o.serve?.log(entry.trimEnd()); };
  // THE LOG'S FILE, whose failure to write (a full disk, issue 847) never ends the run: said once on the run's stderr and
  // to the log's other readers, and the file tried again until it takes lines (src/cli/run-output.ts RunLog)
  const log = new RunLog(logFile, { said: (text) => {
    terminalLine("stderr", `${text}\n`);
    beside(textEntry(`${new Date().toISOString()} `, `[log] ${text}`));
  } });
  hosted.log = log;
  const logLine = (l: string): void => {
    const entry = textEntry(`${new Date().toISOString()} `, withDiskWayOut(l));
    log.write(entry);
    beside(entry);
  };
  // the terminal's failure is in the log from here on
  guardTerminal((text) => { logLine(`[log] ${text}`); });
  // THE DEMO DATABASE (src/cli/demo.ts), hosted here: opened before it is connected to, as any database is
  let demo: Parameters<typeof demoChanges>[0] | null = null;
  if (demoAt !== null) {
    begin("Starting the demo database");
    if ("problem" in demoAt) { fail("Starting the demo database"); say(`  ${demoAt.problem}`); return 1; }
    const opened = await openDemo({ home, port: demoAt.port, from: src.from, log: (l) => logLine(`[demo] ${l}`) });
    if ("problem" in opened) { fail("Starting the demo database"); say(`  ${opened.problem}`); return 1; }
    demo = opened.demo;
    hosted.close = closingOnce(opened.demo);
    done(opened.done);
  }
  const db = maskedUrl(src.resolved);
  begin(`Connecting to ${db}`);
  const checkSaid: string[] = [];
  const checked = await checkSource(src.resolved, { cmd: "mason start", say: (m) => checkSaid.push(m), name: src.from,
    // the checklist's line says it is connecting; everything else checkSource says is the answer
    progress: () => undefined });
  if ("exit" in checked) {
    fail(`Connecting to ${db}`);
    for (const m of checkSaid) say(`  ${m.replace(/^mason start: /, "")}`);
    if (checked.exit !== 2) say(`  (the database's URL is ${src.from}: change it there if its host, port or password changed)`);
    return checked.exit === 2 ? 1 : checked.exit;
  }
  const { source, warnings, notes } = checked;
  // THE DATABASE A TOOL CONNECTS WITH (src/lib/database-name.ts): never the project's name, which names the slot below
  const database = connectDatabase(src, cfg, process.env);
  done(`Connected to ${db}: Postgres ${checked.facts.versionText}${checked.facts.standby ? " (a read replica)" : ""}, ${checked.facts.tables.length} table(s) this user can read`);
  // information, not warnings (issue 888): the main database's line waits for the store, which says whether a first
  // sync is done (below)
  for (const n of notes.filter((n) => n !== PRIMARY_NOTE)) say(`  ${n}`);
  for (const w of warnings) say(`  ! ${w}`);
  // HOW THE CHANGES ARE READ (src/cli/replication-mode.ts): each table as its sync: in the sources file says — the tables
  // whose sync is replication through the project's ONE slot and publication, the others polled with SELECTs beside the
  // stream. A switch copies nothing again (src/duck/sync.ts setTables: one poll catches a table up)
  const shownFile = shownPath(project.root, src.file);
  const replicating = replicatedEntries(src).length > 0;
  // whether this run has held the database to logical replication's checks: at this start when the file replicates a
  // table, else when an edit first sets one to replication (checkReplication below)
  let replicationChecked = replicating;
  // THE PUBLICATION: one the operator named (the file's publication:, else PG_PUBLICATION) is read as it is, never
  // altered (src/duck/publication.ts); else Mason makes its own, carrying the replicated tables alone. What the run
  // before made, as it recorded it, is what goes when no table is replicated (madeReplication)
  const named = namedPublication(src, process.env);
  const repl = projectReplication(cfg.name, src.name, named?.name ?? null);
  const before = madeReplication(cfg, src.name);
  if (replicating) {
    begin("Checking logical replication");
    const ready = await replicationReadiness(source, repl);
    if ("failure" in ready || ready.refused.length) {
      fail("Checking logical replication");
      for (const c of "failure" in ready ? [{ name: "database", detail: ready.failure }] : ready.refused) say(`  ${c.name}: ${c.detail}`);
      say(`  (${replicatedEntries(src).map((e) => entryName(e.table)).join(", ")} ${replicatedEntries(src).length === 1 ? "is" : "are"} sync: replication in ${shownFile}; sync: poll 5m reads a table with SELECTs instead, which needs none of this)`);
      return 1;
    }
    done(repl.owned ? `Logical replication for ${replicatedEntries(src).length} table(s): Mason makes publication ${repl.publication} and slot ${repl.slot} on ${source.database} (mason destroy drops them, and so does a sources file in which no table's sync is replication)`
      : `Logical replication for ${replicatedEntries(src).length} table(s): publication ${repl.publication} is read as it is, never altered; Mason makes slot ${repl.slot} on ${source.database} (mason destroy drops the slot alone, and so does a sources file in which no table's sync is replication)`);
    for (const w of ready.warnings) say(`  ! ${w.name}: ${w.detail}`);
    // WHAT THE RECORD NAMES AND THIS RUN NO LONGER READS — a slot under another name (the sources file renamed since),
    // or the slot (with Mason's own publication) once another publication is read through it, issue 893 — goes,
    // verified, before the record names the new one; said here and in the run's log, with the switch's price
    const stale = staleReplication(cfg.replication ?? null, repl);
    if (stale !== null) {
      try {
        const dropped = await dropOwnReplication(source, stale.drop, null);
        if (dropped.length) { const line = `dropped ${dropped.join(" and ")} from ${source.database}: ${stale.why}`; say(`  ${line}`); logLine(`[sync] ${line}`); }
      } catch (e) {
        say(`mason start: ${(e as Error).message}. Mason made them and nothing reads them now: drop them by hand — ${dropStatements(stale.drop)}`);
        return 1;
      }
    }
    // recorded with the run, so mason status and mason stop say it, the next start reads the same one, and mason
    // destroy drops what was made by its own name
    recordReplication(cfg, repl, home);
  } else if ((cfg.replication ?? null) !== null || cfg.changes === "replication") {
    // THE SLOT GOES WHEN THE FILE SAYS NO TABLE IS REPLICATED: it holds the database's WAL while nobody reads it. A file
    // naming tables and silent on sync: was refused above (recordRefusal)
    if (cfg.changes === "replication") say(`  an older Mason streamed every table of this project; ${shownFile} says otherwise now, so what it made goes`);
    try { for (const d of await dropOwnReplication(source, before)) say(`  dropped ${d} from ${source.database}: no table's sync is replication`); }
    catch (e) {
      say(`mason start: ${(e as Error).message}. They hold the database's WAL while nobody reads them: drop them by hand — ${dropStatements(before)}`);
      return 1;
    }
    if (!before.owned) say(`  publication ${before.publication} is its owner's: left as it is`);
    cfg.publication = null;
    cfg.replication = null;
    writeConfig(home, cfg);
  }
  // the project's mode, as an older start recorded it: the sources file says it per table now
  if (cfg.changes !== undefined) { delete cfg.changes; writeConfig(home, cfg); }
  // the catalog the start read; read again only when something asks (src/cli/source-catalog.ts: no timer, issue 890)
  const facts: SourceFacts = checked.facts;
  const catalogLog = (m: string): void => logLine(`[sync] ${m}`);
  const catalog = sourceCatalog(facts, async (signal) => {
    // a read watched for a connection gone silent, its session told by what it runs, and cancelled on the database
    // when given up on (src/cli/source-catalog.ts watchedRead)
    const read = await watchedRead({
      connect: async () => { const c = await connectSource(source); if ("failure" in c) throw new Error(c.failure.message); return c.pg; },
      read: (pg) => readSourceFacts(pg, undefined, { collations: false }),
      signal, log: catalogLog,
    });
    // the collations were read at the start, and are the start's for the whole run
    return facts.collations !== undefined ? { ...read, collations: facts.collations } : read;
  }, {
    log: catalogLog,
    // A TABLE WHOSE COLUMNS CHANGED, read again alone (issue 977), on a connection watched as the whole read's is
    readTables: (signal, only) => watchedRead({
      connect: async () => { const c = await connectSource(source); if ("failure" in c) throw new Error(c.failure.message); return c.pg; },
      read: (pg) => readTables(pg, only.map((s) => catalog.facts().tables.find((t) => t.source === s) ?? { schema: s.slice(0, s.indexOf(".")), table: s.slice(s.indexOf(".") + 1) })),
      signal, log: catalogLog,
    }),
  });
  const move = sourceMove(cfg.sourceServer ?? null, { database: source.database, systemIdentifier: facts.systemIdentifier });
  if ("refuse" in move) { say(`mason start: ${move.refuse}`); return 1; }
  // THE TABLES THE SOURCES FILE NAMES, against the database's catalog: every mistake said at once, before anything opens
  const firstTables = addedTables(src, facts.tables, source.database, project.root);
  if (!Array.isArray(firstTables)) return failed("start", firstTables, { json: false });
  // what the run copies: the sources file as last read, and what is wrong with it now (an edit the run cannot take)
  let sources: RunSources = { file: src, tables: firstTables, problem: null };
  // THE ROLES FILE (mason/roles.yml, src/cli/roles.ts): what each role may read, held against the tables the sources
  // file copies before anything opens — a table it does not copy or a column the copy lacks refuses the start by name;
  // the listener reads the file again whenever it changes (LiveRoles), no restart
  const rolesRead = readRoles(folder, project.root);
  if (rolesRead !== null && "message" in rolesRead) return failed("start", rolesRead, { json: false });
  if (rolesRead !== null) {
    // a role may name a generated table, whose columns the catalog knows only once it is built (src/duck/generated.ts)
    const generatedFiles = readGenerated(folder, project.root);
    const generatedNames = [...generatedFiles.definitions, ...generatedFiles.refused].map((g) => ({ source: g.name, columns: [], pending: true as const }));
    const resolved = resolveRoles(rolesRead, [...firstTables, ...generatedNames], project.root);
    if ("message" in resolved) return failed("start", resolved, { json: false });
  }

  // how many of a copy's chunks are read at once, each a backend on the database (src/duck/sync.ts COPY_PARALLEL)
  let copyParallel: number;
  try { copyParallel = copyParallelOf(process.env); }
  catch (e) { say(`mason start: ${(e as Error).message}`); return 1; }
  // how long each of a copy's chunks should take to read, at the rate measured here (src/duck/sync.ts COPY_CHUNK_SECONDS)
  let copyChunkSeconds: number;
  try { copyChunkSeconds = copyChunkSecondsOf(process.env); }
  catch (e) { say(`mason start: ${(e as Error).message}`); return 1; }
  // the JSON paths statements keep reading, stored as columns of the copy (src/duck/kept.ts), unless turned off
  let storeJsonPaths: boolean;
  try { storeJsonPaths = storeJsonPathsOf(process.env); }
  catch (e) { say(`mason start: ${(e as Error).message}`); return 1; }

  begin("Opening the synced data");
  const duckFile = path.join(home, DUCK_FILE);
  let store: DuckStore;
  // its memory bounded (src/duck/store.ts DEFAULT_MEMORY_LIMIT): past it a statement spills, or fails alone
  const memoryLimit = process.env.MASON_DUCKDB_MEMORY || undefined;
  // what statements may spill (src/duck/store.ts spillCeiling): past it a statement fails alone, and the disk is kept
  const spillLimit = process.env.MASON_SPILL_LIMIT || undefined;
  try { store = await DuckStore.open(duckFile, (l) => logLine(`[engine] ${l}`), { ...(memoryLimit === undefined ? {} : { memoryLimit }), ...(spillLimit === undefined ? {} : { spillLimit }) }); }
  catch (e) { fail("Opening the synced data"); say(`  ${(e as Error).message}`); return 1; }
  // THE COPY'S THREAD DYING (src/duck/executor.ts: V8 out of heap there, an uncaught error), or the synced data
  // invalidated by a fatal error (a checkpoint on a full disk, issue 830), ends the run, said, for its supervisor (or
  // mason serve's platform) to start it again: every session's statement in flight was told 57P02, and nothing can be
  // answered after
  let crash: ((reason: string) => void) | null = null;
  store.onCrash((reason) => {
    logLine(`[engine] the engine stopped: ${reason}`);
    if (crash !== null) crash(reason);
    else say(`  ! the engine stopped: ${reason}`);
  });
  done(`the synced data in ${path.relative(project.root, duckFile)} (mason destroy deletes it; engine ${DUCKDB_VERSION}), at most ${(memoryLimit ?? DEFAULT_MEMORY_LIMIT).trim()} of memory (MASON_DUCKDB_MEMORY), spilling at most ${humanBytes(store.spillLimitBytes)} to ${path.relative(project.root, duckFile)}.tmp (MASON_SPILL_LIMIT)`);
  // UNDER THE MEMORY FLOOR the run goes on and warns (src/duck/store.ts memoryWarning, the one text): here at its start,
  // in its log, and in its warnings, which mason status, --json and the web page read for as long as it runs
  const memoryWarned = memoryWarning(machineMemory(), process.env);
  if (memoryWarned !== null) {
    // the log (mason serve's stdout among its writers), and mason start's own terminal
    logLine(`[engine] warning: ${memoryProblemText(memoryWarned)}`);
    if (o.serve === undefined) say(`  ! ${memoryProblemText(memoryWarned)}`);
  }
  // THE RUN'S WARNINGS, which mason status, --json and the web page read for as long as it runs: the start's, and what
  // the run says later (a new column that looks like a secret, left out: issue 977)
  const runWarnings: string[] = [...warnings, ...(memoryWarned === null ? [] : [memoryProblemText(memoryWarned)])];
  const syncMode = syncModeOf(process.env);
  // THE SYNC'S EVENTS (src/duck/events.ts): its failures and notable events, kept as the request log is, before the sync
  // that records them starts
  let events: SyncEvents;
  try { events = await SyncEvents.open(store, logLine, { days: keptDays }); }
  catch (e) { fail("Opening the synced data"); say(`  the sync's events (${EVENTS_TABLE}) could not be opened: ${(e as Error).message}`); await store.close(); return 1; }
  // each table is kept current as its own sync: says (the sources file's); the sync's interval is how soon a failed pass
  // is tried again (and MASON_DUCK_SYNC=recopy's whole copies). The slot and publication are the run's whenever a table
  // is replicated, now or after a mason add --sync replication (the demo database has no change log: none)
  const sync = new Sync(store, source, database, (l) => { logLine(`[sync] ${l}`); if (!o.serve && /^synced |failed/.test(l)) say(textEntry("  ", l).trimEnd()); }, PASS_RETRY_MS, syncMode,
    cfg.demo === true ? null : repl, { copyParallel, copyChunkSeconds, json: { enabled: storeJsonPaths }, onEvent: (e) => events.record(e),
      // A TABLE'S COLUMNS CHANGED ON THE DATABASE (issue 977): its catalog read again alone, then the sources file read
      // against it, so the sync syncs it again whole with its columns now
      onColumnsChanged: async (changed) => {
        const r = await catalog.refreshTables(changed);
        if ("failed" in r) throw new Error(r.failed);
        await added();
      },
      // what the run made on the database, recorded as it is made and dropped: mason destroy drops it by that name
      onReplication: (made) => {
        if (made) recordReplication(cfg, repl, home);
        else if ((cfg.replication ?? null) !== null) { cfg.publication = null; cfg.replication = null; writeConfig(home, cfg); }
      } });
  await sync.open();
  // the tables this copy already holds, before this start copies anything: an upgrade from a Mason that polled every
  // table says how many are not polled (`syncDefaultLine`)
  const copiedBefore = sync.state().filter((s) => s.phase === "copied" && sources.tables.some((t) => t.source === s.source)).length;
  // THE MAIN DATABASE, SAID AS INFORMATION until a first sync is done (issue 888): mason status says which it is after
  if (notes.includes(PRIMARY_NOTE) && sync.copiedSources().length === 0) say(`  ${PRIMARY_NOTE}`);
  // a database restored to another server: its transaction ids are not the watermarks', so every table is read again
  if (move.action === "reread") { await sync.rereadAll(); say(`  ${source.database} is on another server than the data was synced from: reading its tables again`); }
  if (move.action !== "same") { cfg.sourceServer = { systemIdentifier: facts.systemIdentifier, database: source.database }; writeConfig(home, cfg); }
  // the views first: setting the tables rebuilds the catalog, which reads them. The sources file read again: a mistake in it
  // keeps the tables read before (a typo never drops a copy), said in the log and by mason status
  // THE COLUMNS EACH TABLE HAD when the run's tables were last set from the catalog (issue 977): a column the database
  // has beyond them arrived while the run was up, and one that looks like a secret is left out (`arrivedSecrets`)
  let columnsSet = new Map(facts.tables.map((t) => [t.source, t.columns.map((c) => c.name)]));
  // what the run left out where it could not write the sources file (its files read-only here), by table: for this run
  const leftOut = new Map<string, string[]>();
  /** Leaves out the secret-looking columns that arrived: `exclude:` written on each entry, as `mason add` writes it —
   *  else, where the project's files may not be written, left out for this run, with the line to add. Said in the log,
   *  as an event and among the run's warnings (`mason status`, the web page). */
  const leaveOut = (file: SourceFile, arrived: readonly ArrivedSecrets[]): void => {
    const shown = shownPath(project.root, file.file);
    let why: string | null = projectWriteRefusal(project.root, process.env)?.message ?? null;
    let written = false;
    if (why === null) {
      // every entry or none: read, edited and written at once, between two reads of the run (one thread: an edit by
      // mason add is never interleaved). What fails is said, and the columns left out for this run all the same
      try {
        let text = fs.readFileSync(file.file, "utf8");
        for (const a of arrived) {
          const r = withTable(text, { ...a.entry, exclude: [...a.entry.exclude, ...a.columns] });
          if ("problem" in r) throw new Error(`it cannot be edited: ${r.problem}`);
          text = r.text;
        }
        fs.writeFileSync(file.file, text);
        written = true;
      } catch (e) { why = `${shown}: ${(e as Error).message}`; }
    }
    for (const a of arrived) {
      if (!written) leftOut.set(a.entry.table, [...(leftOut.get(a.entry.table) ?? []), ...a.columns]);
      const m = leftOutText(a, written ? shown : null, why);
      logLine(`[sync] ${m}`);
      events.record({ kind: "columns_changed", table: a.entry.table, message: m });
      runWarnings.push(m);
    }
  };
  const added = (o: { edited?: readonly string[] } = {}): Promise<void> => {
    // the catalog as last read: an edit asked for a fresh one first (src/cli/run-server.ts /api/pick, /api/remove)
    const now = catalog.facts();
    let read = readSources();
    if (!("message" in read)) {
      const arrived = arrivedSecrets(read, now.tables, columnsSet, o.edited ?? []);
      if (arrived.length) { leaveOut(read, arrived); read = readSources(); }
      if (!("message" in read)) read = withLeftOut(read, leftOut);
    }
    const r = rereadSources(sources, read, src.resolved, now.tables, source.database, project.root, { replicationChecked, slot: cfg.replication?.slot ?? null });
    if (r.said !== null) logLine(`[sync] ${r.said}`);
    // the columns the run's tables now stand on: only once the file was taken, so a column that arrived while the file
    // could not be is still new when it can
    if (r.problem === null) columnsSet = new Map(now.tables.map((t) => [t.source, t.columns.map((c) => c.name)]));
    sources = { file: r.file, tables: r.tables, problem: r.problem };
    sync.setViews(now.views ?? []);
    sync.setCollations(now.collations ?? []);
    return sync.setTables(sources.tables);
  };

  if (pg.said) say(`  ${pg.said}`);
  const pgAddress = { host: listen.host, port: listen.port };
  const postgresUrl = postgresApiUrl(pgAddress, database, { tls: pgTls.tls !== null });
  // MASON_PG_PUBLIC_URL: the address a client reaches, a server's (mason start refuses it, and a value it cannot read
  // refused the start already: startSettingRefusal); recorded beside the listener's, read by clientLink alone
  const publicSetting = o.serve !== undefined ? pgPublicUrlSetting(process.env) : null;
  const postgresPublicUrl = publicSetting !== null && !("problem" in publicSetting) ? publicUrlText(publicSetting) : null;
  const pgClient = clientLink({ postgresUrl, postgresPublicUrl });
  // A LIBC COLLATION'S ORDER IS READ FROM THE DATABASE (src/duck/libc-order.ts): once, a few read-only SELECTs, kept in
  // the copy and read again when the database's collation version moves (an OS upgrade's glibc)
  let libc: LibcOrder | undefined;
  let textOrder: string | null = null;
  const coll = facts.collation;
  if (coll !== undefined && isLibcCollation(coll.provider, coll.collate)) {
    const reading = `Reading how ${source.database} orders text (${coll.collate}${coll.version ? `, version ${coll.version}` : ""})`;
    try {
      const r = await store.libcOrder(coll.collate, coll.version ?? null, async () => {
        begin(reading);
        const c = await connectSource(source);
        if ("failure" in c) throw new Error(`could not connect to read it: ${c.failure.message}`);
        try { return await readLibcOrder(async (sql) => (await c.pg.query(sql)).rows, coll.collate, coll.version ?? null); } finally { c.pg.close(); }
      });
      libc = r.order;
      if (r.read) done(`Read how ${source.database} orders text (${coll.collate}): kept with the synced data, read again only when its collation version moves`);
      // what the read leaves to say is in the log and in mason status's Text order; an order not followed at the start too
      textOrder = libcOrderNote(r.order);
      if (textOrder !== null) (r.order.unread ? say : logLine)(`  ! ${textOrder}`);
    } catch (e) { fail(reading); say(`  ${(e as Error).message}`); await sync.stop(); await events.close(); await store.close(); return 1; }
  }
  // EVERY OTHER LIBC COLLATION'S ORDER (src/duck/collation.ts), read the same way under its own name: a synced column's
  // at the start, one a statement names first on its first use (the plan waits for it, under a bound). A column's that
  // cannot be read is said, and its statements refused by name (libc-locale-unread) until a read succeeds
  const readNamed = async (sc: SourceCollation): Promise<LibcOrder> => {
    const c = await connectSource(source);
    if ("failure" in c) throw new Error(`could not connect to read it: ${c.failure.message}`);
    const read = readLibcOrder(async (sql) => (await c.pg.query(sql)).rows, sc.collate ?? "C", sc.version ?? null, `${pgIdent(sc.schema)}.${pgIdent(sc.name)}`);
    // (a read given up at the bound ends when its connection closes: said, as the race has moved on)
    read.catch((e: unknown) => logLine(`[engine] the read of the collation ${sc.name} ended: ${(e as Error).message}`));
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the read took longer than ${LIBC_READ_MS / 1000} s`)), LIBC_READ_MS); });
    try { return await Promise.race([read, bound]); } finally { clearTimeout(timer); c.pg.close(); }
  };
  const libcOrders = new Map<string, LibcOrder>();
  const byName = new Map((facts.collations ?? []).map((c) => [`${c.schema}\u0000${c.name}`, c]));
  const columnLibc = new Map<string, SourceCollation>();
  for (const t of sources.tables) for (const col of t.columns) {
    const sc = col.collation === undefined ? undefined : byName.get(`${col.collation.schema}\u0000${col.collation.name}`);
    if (sc !== undefined && sc.provider === "c" && sc.collate !== null && isLibcCollation("c", sc.collate) && !(coll !== undefined && isLibcCollation(coll.provider, coll.collate) && sc.collate === coll.collate)) columnLibc.set(sc.collate, sc);
  }
  for (const sc of columnLibc.values()) {
    try {
      const r = await store.libcOrder(sc.collate!, sc.version ?? null, () => readNamed(sc));
      libcOrders.set(sc.collate!, r.order);
      if (r.read) logLine(`[engine] read how ${source.database} orders text under the collation ${sc.name} (${sc.collate}): kept with the synced data`);
      const note = libcOrderNote(r.order);
      if (note !== null) logLine(`[engine] ! ${note}`);
    } catch (e) { say(`  ! the order of the collation ${sc.name} (${sc.collate}) a synced column has could not be read: ${(e as Error).message}; its sorts are refused until it is`); }
  }
  begin("Starting the Postgres listener");
  // ONE STATEMENT'S LIMIT (server.ts armTimeout): a runaway query must not hold DuckDB for ever; a session's
  // statement_timeout may only shorten it. Postgres's units (5min, 90s, 300000); 0 for none
  const timeoutSetting = process.env.MASON_STATEMENT_TIMEOUT || "5min";
  const statementTimeoutMs = timeoutMs(timeoutSetting);
  if (statementTimeoutMs === null) {
    fail("Starting the Postgres listener");
    say(`  MASON_STATEMENT_TIMEOUT=${JSON.stringify(timeoutSetting)} is not a duration: write it as Postgres's statement_timeout is written (5min, 90s, 300000 for ms; 0 for none)`);
    await sync.stop(); await events.close(); await store.close(); return 1;
  }
  // THE REQUEST LOG (src/duck/requests.ts): every statement the listener answers or refuses, kept in the copy's own file
  // for MASON_HISTORY_DAYS (read above, before anything opened)
  let requests: RequestLedger;
  try { requests = await RequestLedger.open(store, logLine, { days: keptDays }); }
  catch (e) { fail("Starting the Postgres listener"); say(`  the request log (${REQUESTS_TABLE}) could not be opened: ${(e as Error).message}`); await sync.stop(); await events.close(); await store.close(); return 1; }
  // USAGE OVER TIME (src/duck/usage.ts): a sample a minute, kept as the request log is; it counts the listener's requests
  // as they are recorded, and samples the run's state once the command server's context exists (below)
  let usage: UsageSampler;
  try { usage = await UsageSampler.open(store, logLine, { days: keptDays }); }
  catch (e) { fail("Starting the Postgres listener"); say(`  the usage samples (${USAGE_TABLE}) could not be opened: ${(e as Error).message}`); await requests.close(); await sync.stop(); await events.close(); await store.close(); return 1; }
  let duckListener;
  try {
    duckListener = await store.listener(facts.collation, undefined, libc, () => [...sync.state(), ...sync.generated.copies()], sync.kept.enabled ? sync.kept : undefined,
      { ...(facts.collations !== undefined ? { collations: facts.collations } : {}), libcOrders, readLibc: async (sc) => {
        logLine(`[engine] reading how ${source.database} orders text under the collation ${sc.name} (${sc.collate}), which a statement names first`);
        return readNamed(sc);
      } });
  }
  catch (e) { fail("Starting the Postgres listener"); say(`  ${(e as Error).message}`); await requests.close(); await sync.stop(); await usage.close(); await events.close(); await store.close(); return 1; }
  logLine(`[engine] text sorts as the source's collation does: ${JSON.stringify(duckListener.collation)}`);
  // THE USERS (src/duck/users.ts): `mason user` edits the file beside this process; the listener re-reads it at every
  // connection and before every statement of a user's session, so a removal takes effect without a restart
  const users = new LiveUsers(path.join(home, USERS_FILE), cfg.apiKey);
  // THE ROLES (src/cli/roles.ts): the file read again when it or the copied tables change; a session with a role is
  // held to it at every statement, and the catalog is rebuilt with the roles (src/api/postgres/server.ts)
  const liveRoles = new LiveRoles(folder, project.root, () => [...sources.tables, ...sync.generated.named()]);
  let api: PgApiServer;
  try {
    api = await startPostgresApi({
      port: pgAddress.port, host: pgAddress.host, tls: pgTls.tls, database, masonVersion: o.version, product: "mason-data", statementTimeoutMs,
      // behind a TCP proxy (MASON_PG_PROXY_FROM, src/api/postgres/proxy.ts): its PROXY header read from its addresses alone
      ...(listen.proxyFrom !== undefined ? { proxyFrom: listen.proxyFrom } : {}),
      ...listenerLogins(users, cfg.apiKey),
      roles: () => liveRoles.now(),
      schema: () => sync.schema(),
      // the one place a request is recorded: the request log's row, and the usage sample's count of it
      record: (row) => { requests.record(row); usage.count(row); },
      log: logLine,
      trace: process.env.MASON_PG_TRACE === "1",
      duck: duckListener,
    });
  } catch (e) { fail("Starting the Postgres listener"); say(`  ${(e as Error).message}`); await requests.close(); await sync.stop(); await usage.close(); await events.close(); await store.close(); return 1; }
  done(`Postgres listener on ${listenerText(pgTls.listener, api.port)}; ${listen.proxyFrom !== undefined ? `a PROXY protocol v2 header required from ${listen.proxyFrom.entries.join(", ")} (MASON_PG_PROXY_FROM); ` : ""}${statementTimeoutMs === 0 ? "statements without a time limit" : `each statement at most ${timeoutSetting.trim()}`} (MASON_STATEMENT_TIMEOUT); ` +
    `every request recorded for ${keptDays} day${keptDays === 1 ? "" : "s"} (MASON_HISTORY_DAYS; mason logs --requests)`);
  {
    // a user whose role the file no longer names reads nothing until it is added again (fail closed): said here, by name
    // the row filters checked by the catalog Postgres here (on the tables copied already): a where: Postgres refuses is
    // said now, at its key, before any user meets it
    const roles = await api.checkRoles();
    const list = readUsers(path.join(home, USERS_FILE));
    const orphans = "users" in list ? usersWithoutRole(list.users, new Set(roles.grants.keys())) : [];
    // WHAT A USER ADDED WITHOUT --role READS, SAID ONCE (stage 1b: the file decides it, never the code), and each user
    // the file holds to nothing (no default:) by name, with the way out
    const rolesLine = rolesDefaultLine(roles, shownPath(project.root, rolesFile(folder)));
    say(`  ${rolesLine}`);
    logLine(`[postgres] ${rolesLine}`);
    for (const name of "users" in list ? usersWithNoRole(list.users, roles) : []) {
      say(`  ! the user ${name} has no role, and ${roles.file ?? ""} names no default: its statements are refused — ${noRoleWayOut(name, roles.file ?? "", exampleRole(roles))}`);
    }
    // a user without a value its role's row filters read: refused at every statement until it is made again with it
    for (const u of "users" in list ? usersMissingAttributes(list.users.filter((x) => x.removedAt === undefined), roles) : []) {
      say(`  ! ${missingAttributesText(u)}`);
    }
    for (const u of orphans) {
      say(`  ! the user ${u.name} has the role ${u.role}, which ${roles.file ?? "no roles file (mason/roles.yml)"} ${roles.file === null ? "exists to name" : "does not name"}: ` +
        `its statements are refused until the role is in the file, or mason user remove ${u.name} and mason user add ${u.name}${roles.grants.size ? ` --role ${[...roles.grants.keys()][0]}` : ""}`);
    }
  }

  // WHAT mason share OPENS (src/cli/share-run.ts): a second socket of this listener, on a run on a laptop alone
  // a tunnel's ssh config a run or a mason share killed with -9 left behind (src/cli/tunnel.ts): removed unless its
  // process lives, so a run stopped with the page's share open leaves nothing at the next start
  if (o.serve === undefined) {
    try { sweepTunnelFiles(home, alive); } catch (e) { logLine(`share: the tunnels' files left behind could not be swept: ${(e as Error).message}`); }
  }
  const shares = o.serve !== undefined ? undefined : new RunShares({
    listener: api, database, log: logLine,
    // the project's own certificate, as --self-signed-tls serves it: made once, and recorded as that flag records it
    certificate: () => {
      try {
        const pair = selfSignedPair(home);
        if (pair.said) logLine(`[postgres] ${pair.said} (SHA-256 ${pair.fingerprint})`);
        const recorded = { cert: SELF_SIGNED_FILES.cert, key: SELF_SIGNED_FILES.key, fingerprint: pair.fingerprint };
        if (JSON.stringify(cfg.selfSignedTls ?? null) !== JSON.stringify(recorded)) { cfg.selfSignedTls = recorded; writeConfig(home, cfg); }
        return pair;
      } catch (e) {
        return { message: `the self-signed certificate could not be written to ${home}: ${(e as Error).message}`, code: "failed", fix: "this folder must be writable: mason doctor checks the machine" };
      }
    },
  });
  const setupPort = o.exactPort === true ? o.port : await freePort(o.port, chosen);
  const token = newToken();
  const runCtx: RunContext = {
    source, facts: () => catalog.facts(), freshFacts: async () => { await catalog.fresh({ waitMs: STATE_WAIT_MS }); }, factsNow: (carried) => actRead(catalog, carried, source.database), warnings: runWarnings, textOrder,
    // the slot and publication while a table's sync is replication (the run streams), as the sync says it now
    replication: () => sync.streams() ? repl : null, port: setupPort, token, folder: () => folder, root: project.root, home,
    version: o.version, startedAt,
    // the web page (mason ui): on loopback alone, so mason serve's is reached through mason ui --ssh
    page: true, served: o.serve !== undefined,
    // MASON_UI_READ_ONLY=1: a server's page refuses every change it asks for (mason start refuses the setting above)
    pageReadOnly: o.serve !== undefined && uiReadOnlySetting(process.env) === true,
    // MASON_UI_READ_ONLY_ALLOW=tables: what that page may still change (refused at the start when wrong, so a problem
    // here is read as nothing allowed: fail closed)
    pageReadOnlyAllow: o.serve !== undefined ? allowedOf(uiReadOnlyAllowSetting(process.env)) : [],
    // MASON_UI_BACK_URL: a server's page links back to the site that links to it (mason start refuses the setting above)
    pageBack: o.serve !== undefined ? backLinkOf(uiBackLinkSetting(process.env)) : null,
    // MASON_UI_NAV_*: a server's sidebar, its items replaced by the host's pages and the host's links (mason start
    // refuses them above)
    pageNav: o.serve !== undefined ? navOf(uiNavSetting(process.env)) : null,
    // MASON_UI_ACCOUNT: a server's sidebar names who is signed in to the host (mason start refuses it above)
    pageAccount: o.serve !== undefined ? accountOf(uiAccountSetting(process.env)) : null,
    // MASON_UI_OVERVIEW_CARD: a server's Overview shows the host's card, read from a path relative to the page (mason
    // start refuses it above)
    pageCard: o.serve !== undefined ? overviewCardOf(uiOverviewCardSetting(process.env)) : null,
    // MASON_UI_ICON: a server's page has the host's icon in its tab (mason start refuses it above)
    pageIcon: o.serve !== undefined ? iconOf(uiIconSetting(process.env)) : null,
    // MASON_UI_SOCKET: the page on a Unix socket too (src/cli/ui-socket.ts), or null
    pageSocket: o.serve?.socket ?? null,
    demo: cfg.demo === true,
    users: { file: path.join(home, USERS_FILE), apiKey: cfg.apiKey, database, postgresUrl, postgresPublicUrl },
    // the roles as the listener holds them: their row filters checked by its catalog (a filter Postgres refuses is a problem)
    roles: () => api.roles(),
    ...(shares !== undefined ? { shares, pageShares: new PageShares({ shares, home, log: logLine }) } : {}),
    // the sources file is the list of what is added: a change to it is read by the sync at once
    sources: () => sources, sourcesChanged: (edited) => { void added({ edited }); }, readSource: readSources, runUrl: src.resolved,
    // a table set to sync: replication while the run is up, in a run that never checked the database for it: the
    // start's own checks, now, and the edit refused when they fail (src/cli/run-server.ts /api/pick)
    checkReplication: async (file) => {
      const tables = replicatedEntries(file).map((e) => entryName(e.table));
      if (replicationChecked || tables.length === 0) return null;
      const shown = shownPath(project.root, file.file);
      const demo = demoChangesRefusal(cfg, file, shown);
      if (demo !== null) return { ...demo, fix: `mason add ${tables[0]} --sync "poll 5s" polls it`, next: [[`mason add ${tables[0]} --sync "poll 5s"`, "polls it"]] };
      const ready = await replicationReadiness(source, repl);
      const refused = liveReadinessFailure(ready, tables, shown, source.database);
      if (refused !== null) return refused;
      if (!("failure" in ready)) for (const w of ready.warnings) say(`  ! ${w.name}: ${w.detail}`);
      replicationChecked = true;
      return null;
    },
    // the database's checks for one table's logical replication, as the web page's Sync choice shows them and its save
    // reads them again (src/cli/sync-choice.ts): read-only, over one connection, closed. What cannot be read is a
    // refused check, never Live allowed; the database's address and user are never in what it answers
    liveChecks: async (t, columns) => {
      const file = sources.file;
      const shown = shownPath(project.root, (file ?? src).file);
      const demo = demoChangesRefusal(cfg, { sync: { mode: "replication" }, tables: [{ name: entryName(t.source), table: t.source, columns: null, exclude: [], key: null, sync: null }] }, shown);
      if (demo !== null) return [{ name: "database", state: "refused", detail: `${demo.message}: ${demo.why ?? ""}`.replace(/: $/, "") }];
      const c = await connectSource(source);
      if ("failure" in c) return [{ name: "database", state: "refused", detail: "Mason could not connect to the database to read its checks now: mason doctor says why" }];
      try {
        // bounded once connected, and the limit ends with the checks (boundedLiveChecks)
        return await boundedLiveChecks(c.pg, t, { repl, streaming: sync.streams(), columns, shown }, (m) => say(`  the database's checks: ${m}`));
      }
      catch (e) { return [{ name: "database", state: "refused", detail: `the database's checks could not be read: ${(e as Error).message}` }]; }
      finally { c.pg.close(); }
    },
    log: (m) => say(`  ${m}`),
    logs,
    // the web page's own errors (POST /api/ui/error): ui_error events, at most UI_ERRORS_PER_MINUTE a minute, and a count for /metrics
    uiErrors: new UiErrors((e) => events.record(e), (m) => say(`  ${m}`)),
    // the statements running now, and a cancel of one: the listener's own (a CancelRequest's path)
    listener: api,
    duck: { copies: () => sync.state(), file: duckFile, poll: (sources) => sync.pollNow(sources), stream: (o) => sync.streamStatus(o), measured: (table) => sync.measured(table), disk: () => sync.diskStatus(), requests, events, usage,
      restarts: () => readRestarts(home), jsonPaths: () => sync.kept.status(), generated: () => sync.generated.status() },
  };
  const server = createRunServer(runCtx);
  o.serve?.page?.(server);
  // a sample is /api/state's facts at its moment (src/cli/run-server.ts usageFacts): one computation of each
  usage.start(() => usageFacts(runCtx));
  await listenOnLoopback(server, setupPort);
  const tablesSet = added();
  // the run's own start beside its pid (src/cli/runs.ts masonProcess): how a command tells this run, alive and silent,
  // from another process given the number later, whatever started it (mason start, mason serve, a supervisor, npx)
  const started = processStart(process.pid);
  cfg.running = { pid: process.pid, ...(started !== null ? { started } : {}), controlUrl: `http://127.0.0.1:${setupPort}`, token, postgresUrl, ...(postgresPublicUrl !== null ? { postgresPublicUrl } : {}), postgresListener: pgTls.listener };
  cfg.lastRun = new Date().toISOString();
  writeConfig(home, cfg);
  done(`Mason is up: ${sync.state().length} table(s) added, kept current: ${syncMode === "poll" ? `as each table's sync: says${syncCounts(sources.tables)}` +
      `${sync.streams() ? `; replicated tables streamed as they change (logical replication: slot ${repl.slot}, publication ${repl.publication}${repl.owned ? "" : ", read as it is"})` : ""}`
    : `each table read again whole every ${PASS_RETRY_MS / 1000} s (MASON_DUCK_SYNC=recopy)`}`);
  // THE GENERATED TABLES (src/duck/generated.ts): the folder read and each file held to the catalog, what is refused said
  // here too; a refusal stops nothing, and their SQL is checked again as the tables they read are copied
  await tablesSet;
  await sync.generated.start(() => readGenerated(folder, project.root), api.planner());
  for (const g of sync.generated.status()) for (const r of g.refusals) say(textEntry("  ! ", r.text).trimEnd());
  // THE FILE'S DEFAULT, SAID ONCE (issue 33: nothing Mason does to your database is a hidden default)
  const defaultLine = syncDefaultLine(sources.file, shownPath(project.root, sources.file.file), syncMode === "poll" ? copiedBefore : 0);
  say(`  ${defaultLine}`);
  logLine(`[sync] ${defaultLine}`);
  // THE DEMO'S WRITER: a round of changes every MASON_DEMO_CHANGE_MS, begun once the run is up, said in the log
  if (demo !== null && demoChangeMs !== null) hosted.stopChanges = demoChanges(demo, demoChangeMs, (l) => logLine(`[demo] ${l}`));
  // the stop is in place BEFORE the ready line: a supervisor or a test signals on reading it, and a SIGTERM that found
  // no handler would end the run with the default action, never recording `running: null`
  let stopping = false;
  // the run's own stop, for a step of a serve's ready that failed (`ServeHooks.ready`): its words are what lastStop says
  let stopFor: (how: string) => void = () => undefined;
  const stopped = new Promise<number>((resolve) => {
    // a crash of the engine's thread: the run exits 1 with its reason in V8's fatal form, which the supervisor reads
    // (src/cli/supervise.ts crashReason), and its config still says it runs, so the supervisor starts it again
    crash = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      say(`FATAL ERROR: Mason: the engine stopped (${reason})`);
      o.serve?.failed();
      hosted.stopChanges?.();
      server.close();
      void (async () => {
        // the sessions were told; the listener is closed so that none waits on a copy that cannot answer
        const closed = api.close().catch((e: unknown) => say(`  closing the listener: ${(e as Error).message}`));
        await Promise.race([closed, new Promise((r) => setTimeout(r, 2_000).unref())]);
        // the demo database's data flushed to its folder before the log it writes to ends (dev() closes it otherwise)
        // (a close still going after 2 s is said: the process ends without it, and the folder may not be whole)
        await closedWithin(closeDemo(hosted, null), 2_000, () => say(`  ${DEMO_STILL_CLOSING(2_000)}`));
        // the engine's thread ends before the process does (issue 913): the process's exit tears a live thread down as a
        // terminate does, and one that met DuckDB's last callbacks aborted the process (exit 134) instead of this exit 1.
        // Bounded by its grace (src/duck/executor.ts CLOSE_GRACE_MS); dev() ends the log after it
        await store.close();
        resolve(1);
      })();
    };
    const stop = (signal: NodeJS.Signals, how?: string): void => {
      if (stopping) return;
      stopping = true;
      o.serve?.stopping();
      say("\nmason start: stopping …");
      hosted.stopChanges?.();
      server.close();
      void (async () => {
        // before the listener: a share's command is told why, and its tunnel client stopped
        try { await shares?.closeAll("Mason is stopping"); } catch (e) { say(`  closing the share: ${(e as Error).message}`); }
        // before the listener: a generated table's review plans on its catalog, so it ends first
        try { await sync.generated.stop(); } catch (e) { say(`  stopping the generated tables: ${(e as Error).message}`); }
        try { await api.close(); } catch (e) { say(`  closing the listener: ${(e as Error).message}`); }
        // after the listener: its last statements' rows are written before the file closes
        try { await requests.close(); } catch (e) { say(`  closing the request log: ${(e as Error).message}`); }
        let syncStop: Error | null = null;
        try { await sync.stop(); } catch (e) { syncStop = e as Error; }
        // after the sync: a sample in flight ends before the file closes (it reads the sync's state)
        try { await usage.close(); } catch (e) { say(`  closing the usage samples: ${(e as Error).message}`); }
        // after the sync: its last events are written before the file closes
        try { await events.close(); } catch (e) { say(`  closing the sync's events: ${(e as Error).message}`); }
        // the demo database after the sync (nothing reads it any more) and before the copy closes
        await closeDemo(hosted, `closed the demo database (it stays in ${path.join(home, DEMO_DIR)}; mason destroy removes it)`);
        if (syncStop !== null) say(`  closing the synced data: ${syncStop.message}`);
        else {
          try { await store.close(); say(`  closed the synced data (it stays in ${duckFile})`); } catch (e) { say(`  closing the synced data: ${(e as Error).message}`); }
        }
        if ((cfg.replication ?? null) !== null) say(`  replication slot ${repl.slot} stays on ${source.database}, holding its WAL until the next mason start reads it (mason destroy drops it)` +
          (repl.owned ? "" : `; publication ${repl.publication} is its owner's, left as it is`));
        cfg.running = null;
        // how it ended, for mason status once it is gone (a kill records nothing: mason stop writes that one)
        cfg.lastStop = { at: new Date().toISOString(), how: how ?? (signal === "SIGINT" ? "stopped from its terminal (SIGINT)" : `stopped by mason stop, or a shutdown (${signal})`) };
        // a record that cannot be written (a full disk, issue 847) is said, and the config stays as it was, whole
        // (writeConfig renames over it): the run still ends as a stop, exit 0, so its supervisor never starts it again
        // over a config that still names it — a stop is never undone — and a command reads the pid it names as gone
        try { writeConfig(home, cfg); }
        catch (e) { say(`  ${writeFailureText("the stop's record in .mason/config.json", e)}; mason status reads the run as stopped all the same`); }
        resolve(0);
      })();
    };
    // wrapped: Node calls a signal's listener with (name, number), and the number must never be read as `how`
    process.on("SIGINT", () => { stop("SIGINT"); });
    process.on("SIGTERM", () => { stop("SIGTERM"); });
    stopFor = (how) => { stop("SIGTERM", how); };
  });
  say("");
  say(`  Postgres  ${shownUrl(pgClient)}  (mason user add <name> makes a user)`);
  // the web page by its command, never its URL: the URL carries the run's token, and this goes to dev.log
  // its words are mason ui's summary (mason --help's), so the two never drift
  if (o.serve === undefined) say(`  Web UI  mason ui  (${UI.summary})`);
  if (demoChangeMs !== null) say(`  Demo  a new order lands every ${demoChangeMs / 1000} s: mason status shows the synced data keeping up`);
  // where a client reaches a public address, the listener's own is no tip
  const elsewhere = pgClient.public === true ? null : elsewhereTip(pgTls.listener);
  if (elsewhere) say(`  ${elsewhere}`);
  // before the ready line: what a serve writes when it answers (MASON_UI_RUN_FILE) is there when a supervisor reads it
  // a step of it that failed stops the run, said in its words, and the ready line is never printed: it did not get ready
  const notReady = o.serve?.ready({ tables: () => sync.state(), metrics: () => metricsFacts(runCtx), page: { port: setupPort, token } }) ?? null;
  if (notReady !== null) { stopFor(notReady); return await stopped; }
  say(READY);
  say("");
  return await stopped;
}


/**
 * The listener's certificate, read: under --self-signed-tls the project's own (made or kept, src/cli/pg-tls.ts, and
 * recorded in its config), else the one MASON_PG_TLS_CERT names; with what the run records of it. A certificate that
 * cannot be read or made is said as what is wrong and the way out.
 */
function listenerTls(listen: PgListenerSettings, selfSigned: boolean, home: string, cfg: ProjectConfig):
  { tls: { cert: Buffer; key: Buffer } | null; listener: PostgresListener } | Problem {
  if (listen.tls === null) return { tls: null, listener: { host: listen.host, tls: null } };
  if (selfSigned) {
    let made: ReturnType<typeof ensureSelfSigned>;
    try { made = ensureSelfSigned(home); }
    catch (e) { return { problem: `the self-signed certificate could not be written to ${home}: ${(e as Error).message}`, code: "failed" }; }
    if (made.said) say(`  ${made.said} (SHA-256 ${made.fingerprint}); a later mason start --self-signed-tls serves it again`);
    const recorded = { cert: SELF_SIGNED_FILES.cert, key: SELF_SIGNED_FILES.key, fingerprint: made.fingerprint };
    if (JSON.stringify(cfg.selfSignedTls ?? null) !== JSON.stringify(recorded)) { cfg.selfSignedTls = recorded; writeConfig(home, cfg); }
  }
  const read = readPgTls(listen.tls);
  if ("problem" in read) return { problem: read.problem, code: "refused", fix: "MASON_PG_TLS_CERT and MASON_PG_TLS_KEY name PEM files this user can read" };
  const fingerprint = certificateFingerprint(read.cert);
  if (typeof fingerprint !== "string") return { ...fingerprint, code: "refused", fix: "MASON_PG_TLS_CERT names the certificate's PEM file (-----BEGIN CERTIFICATE-----), MASON_PG_TLS_KEY its key's" };
  return { tls: read, listener: { host: listen.host, tls: selfSigned ? "self-signed" : "certificate", fingerprint } };
}

/** The line a run writes once it answers commands: what `mason start` in the background waits for (src/cli/background.ts),
 *  and what tells its supervisor a death after it is a crash to restart (src/cli/supervise.ts, which defines it). */
export const READY = READY_LINE;

/** The one sentence of how the pieces fit, printed first by `mason start` and at the top of its help. */
export const PROJECT_LINE = "A Mason project is your app's folder: mason/sources/ names the database and the tables to sync, yours to commit; " +
  "this machine's synced data and Mason's state are in .mason/, rebuilt from that file.";
