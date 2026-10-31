/**
 * `mason start` (one run per project): Mason for the project of this folder
 * (src/cli/project.ts), on the database its sources file names (src/cli/sources.ts), copying the tables it names.
 *
 *   0. A DEMO PROJECT'S DATABASE (`mason init demo`, src/cli/demo.ts): hosted by this process, opened first on the port
 *      the sources file's URL names, then connected to and read as any database is (by polling: it has no change log),
 *      and changed every few seconds so the copy is seen keeping current.
 *   1. THE DATABASE (src/cli/preflight.ts checkSource): connect as the run will, say what to change when it cannot;
 *      a database on another machine only when the project was made with --remote. A database restored to another server
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
import { choosePgPort, freePort } from "./ports.ts";
import { failed, type Problem } from "./command.ts";
import { checkSource, connectSource, maskedUrl, readSourceFacts, remoteConfirmation, remoteWarning, type SourceFacts } from "./preflight.ts";
import { createRunServer, listenOnLoopback, metricsFacts, usageFacts, type RunContext } from "./run-server.ts";
import type { RunMetrics } from "./metrics.ts";
import { addedTables, effectiveSync, entryName, replicatedEntries, rereadSources, shownPath, syncWritten, type RunSources, type SourceFile } from "./sources.ts";
import { newToken } from "./security.ts";
import { liveRun } from "./runs.ts";
import { DEMO_DIR, DUCK_FILE, projectSource, startSettingRefusal, theProject, writeConfig, type PostgresListener, type ProjectConfig } from "./project.ts";
import { closedWithin, closingOnce, DEMO_STILL_CLOSING, demoChanges, demoChangesRefusal, demoPort, demoSettings, openDemo } from "./demo.ts";
import { postgresApiUrl, readPgTls, type PgListenerSettings } from "../api/postgres/listener.ts";
import { connectDatabase } from "../lib/database-name.ts";
import { certificateFingerprint, elsewhereTip, ensureSelfSigned, listenerText, runListenerSettings, selfSignedPair, SELF_SIGNED_FILES } from "./pg-tls.ts";
import { RunShares } from "./share-run.ts";
import { startPostgresApi, timeoutMs, type PgApiServer } from "../api/postgres/server.ts";
import { RequestLedger, REQUESTS_TABLE } from "../duck/requests.ts";
import { historyDaysSetting } from "../duck/history.ts";
import { EVENTS_TABLE, SyncEvents } from "../duck/events.ts";
import { USAGE_TABLE, UsageSampler } from "../duck/usage.ts";
import { withPlaceholders } from "./pg-url.ts";
import { UI } from "./ui.ts";
import { cliPinProblem, ensurePin } from "./pin.ts";
import { DEFAULT_MEMORY_LIMIT, DuckStore, DUCKDB_VERSION } from "../duck/store.ts";
import { copyChunkSecondsOf, copyParallelOf, humanBytes, Sync, syncModeOf, type CopyState } from "../duck/sync.ts";
import { storeJsonPathsOf } from "../duck/kept.ts";
import { libcOrderNote, readLibcOrder, type LibcOrder } from "../duck/libc-order.ts";
import { isLibcCollation } from "../duck/rewrite.ts";
import { listenerLogins, LiveUsers, readUsers, USERS_FILE } from "../duck/users.ts";
import { exampleRole, LiveRoles, missingAttributesText, noRoleWayOut, readRoles, resolveRoles, rolesDefaultLine, rolesFile, usersMissingAttributes, usersWithNoRole, usersWithoutRole } from "./roles.ts";
import { READY_LINE, readRestarts } from "./supervise.ts";
import { dropOwnReplication, dropStatements, liveReadinessFailure, madeReplication, namedPublication, projectReplication, recordRefusal, replicationReadiness, staleReplication } from "./replication-mode.ts";
import { textEntry } from "../lib/log.ts";
import { LogBuffer } from "../lib/log-buffer.ts";
import { BIG_TABLE_ROWS, syncText, type TableSync } from "../lib/table-sync.ts";

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
   *  `GET /metrics` says (src/cli/run-server.ts `metricsFacts`) */
  ready: (run: { tables: () => CopyState[]; metrics: () => Promise<Omit<RunMetrics, "uptimeSeconds">> }) => void;
  /** a SIGTERM or SIGINT is stopping it */
  stopping: () => void;
}

const say = (m: string): void => { process.stdout.write(`${m}\n`); };

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

/** What the run hosts beside the copy (a demo project's database), stopped and closed however the run ends. */
interface Hosted {
  /** the demo database's writer, once it runs */
  stopChanges: (() => void) | null;
  /** closes the demo database, once (src/cli/demo.ts closingOnce); null when there is none, or it was closed */
  close: (() => Promise<string | null>) | null;
}

/**
 * The run, and whatever it hosts closed however it ends: a demo database that was opened is closed at the stop (after
 * the sync, before the copy), and by this on every other way out — a failed step, a crash — its data flushed to its
 * folder, a close that fails said.
 */
export async function dev(o: DevOptions): Promise<number> {
  const hosted: Hosted = { stopChanges: null, close: null };
  try { return await run(o, hosted); }
  finally {
    hosted.stopChanges?.();
    await closeDemo(hosted, null);
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
  // the history's days (MASON_HISTORY_DAYS, a number of days; the old MASON_REQUEST_LOG_DAYS refused, named), read
  // before anything opens (src/duck/history.ts); every history below keeps them
  const keptDays = historyDaysSetting(process.env);
  if (typeof keptDays !== "number") return failed("start", { code: "refused", ...keptDays }, { json: false });
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
  const wrotePin = o.serve ? null : ensurePin(folder, o.version);
  if (wrotePin) say(`  wrote ${path.relative(project.root, wrotePin)}: version ${o.version}, the Mason this project is written for — commit it`);
  if ("message" in src) return failed("start", src, { json: false });
  // a demo project's file naming sync: replication (its database has no change log), refused before anything opens
  const demoFile = demoChangesRefusal(cfg, src, shownPath(project.root, src.file));
  if (demoFile) return failed("start", demoFile, { json: false });
  const logFile = path.join(home, "mason.log");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  // one entry a line: a multi-line message's further lines indented under it (src/lib/log.ts `textEntry`);
  // mason serve gets the same entry, for the container's stdout (src/cli/serve.ts)
  // the last entries are kept in memory too (src/lib/log-buffer.ts), for the command server's /api/logs: the one writer
  // feeds the file, stdout and the buffer, so a mode with no file (mason serve) has the log as well
  const logs = new LogBuffer();
  const logLine = (l: string): void => {
    const entry = textEntry(`${new Date().toISOString()} `, l);
    log.write(entry);
    logs.push(entry);
    o.serve?.log(entry.trimEnd());
  };
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
  const checked = await checkSource(src.resolved, { remote: cfg.remote, cmd: "mason start", say: (m) => checkSaid.push(m),
    // the checklist's line says it is connecting; everything else checkSource says is the answer
    progress: () => undefined });
  if ("needsRemote" in checked) {
    // connected, but the project was not made for a database elsewhere: the step is done, the confirmation is the stop
    const { source, facts, warnings } = checked.needsRemote;
    done(`Connected to ${db}: Postgres ${facts.versionText}${facts.standby ? " (a read replica)" : ""}, ${facts.tables.length} table(s) this user can read`);
    for (const w of warnings.filter((w) => w !== remoteWarning(source))) say(`  ! ${w}`);
    const config = path.join(home, "config.json");
    return failed("start", remoteConfirmation(source.host, { cmd: "mason start",
      wayOut: `this project was not made with --remote: if you mean to sync from that machine, set "remote": true in ${config} and start again`,
      next: [["mason start", `once ${config} says "remote": true`]] }), { json: false });
  }
  if ("exit" in checked) {
    fail(`Connecting to ${db}`);
    for (const m of checkSaid) say(`  ${m.replace(/^mason start: /, "")}`);
    if (checked.exit !== 2) say(`  (the database's URL is ${src.from}: change it there if its host, port or password changed)`);
    return checked.exit === 2 ? 1 : checked.exit;
  }
  const { source, warnings } = checked;
  // THE DATABASE A TOOL CONNECTS WITH (src/lib/database-name.ts): never the project's name, which names the slot below
  const database = connectDatabase(src, cfg, process.env);
  done(`Connected to ${db}: Postgres ${checked.facts.versionText}${checked.facts.standby ? " (a read replica)" : ""}, ${checked.facts.tables.length} table(s) this user can read`);
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
    // or Mason's own publication once another is named — goes, verified, before the record names the new one
    const stale = staleReplication(cfg.replication ?? null, repl);
    if (stale !== null) {
      try { for (const d of await dropOwnReplication(source, stale.drop, null, stale.what)) say(`  dropped ${d} from ${source.database}: ${stale.why}`); }
      catch (e) {
        const by = stale.what === "both" ? dropStatements(stale.drop) : `DROP PUBLICATION IF EXISTS ${stale.drop.publication};`;
        say(`mason start: ${(e as Error).message}. Mason made ${stale.what === "both" ? "them" : "it"} and nothing reads ${stale.what === "both" ? "them" : "it"} now: drop ${stale.what === "both" ? "them" : "it"} by hand — ${by}`);
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
  let facts: SourceFacts = checked.facts;
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
    const resolved = resolveRoles(rolesRead, firstTables, project.root);
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
  // THE COPY'S THREAD DYING (src/duck/executor.ts: V8 out of heap there, an uncaught error) ends the run, said, for its
  // supervisor to start it again: every session's statement in flight was told 57P02, and nothing can be answered after
  let crash: ((reason: string) => void) | null = null;
  store.onCrash((reason) => {
    logLine(`[engine] the engine's thread stopped: ${reason}`);
    if (crash !== null) crash(reason);
    else say(`  ! the engine's thread stopped: ${reason}`);
  });
  done(`the synced data in ${path.relative(project.root, duckFile)} (mason destroy deletes it; engine ${DUCKDB_VERSION}), at most ${(memoryLimit ?? DEFAULT_MEMORY_LIMIT).trim()} of memory (MASON_DUCKDB_MEMORY), spilling at most ${humanBytes(store.spillLimitBytes)} to ${path.relative(project.root, duckFile)}.tmp (MASON_SPILL_LIMIT)`);
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
      // what the run made on the database, recorded as it is made and dropped: mason destroy drops it by that name
      onReplication: (made) => {
        if (made) recordReplication(cfg, repl, home);
        else if ((cfg.replication ?? null) !== null) { cfg.publication = null; cfg.replication = null; writeConfig(home, cfg); }
      } });
  await sync.open();
  // the tables this copy already holds, before this start copies anything: an upgrade from a Mason that polled every
  // table says how many are not polled (`syncDefaultLine`)
  const copiedBefore = sync.state().filter((s) => s.phase === "copied" && sources.tables.some((t) => t.source === s.source)).length;
  // a database restored to another server: its transaction ids are not the watermarks', so every table is read again
  if (move.action === "reread") { await sync.rereadAll(); say(`  ${source.database} is on another server than the data was synced from: reading its tables again`); }
  if (move.action !== "same") { cfg.sourceServer = { systemIdentifier: facts.systemIdentifier, database: source.database }; writeConfig(home, cfg); }
  // the views first: setting the tables rebuilds the catalog, which reads them. The sources file read again: a mistake in it
  // keeps the tables read before (a typo never drops a copy), said in the log and by mason status
  const added = (): void => {
    const r = rereadSources(sources, readSources(), src.resolved, facts.tables, source.database, project.root, { replicationChecked, slot: cfg.replication?.slot ?? null });
    if (r.said !== null) logLine(`[sync] ${r.said}`);
    sources = { file: r.file, tables: r.tables, problem: r.problem };
    sync.setViews(facts.views ?? []);
    void sync.setTables(sources.tables);
  };

  if (pg.said) say(`  ${pg.said}`);
  const pgAddress = { host: listen.host, port: listen.port };
  const postgresUrl = postgresApiUrl(pgAddress, database, { tls: pgTls.tls !== null });
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
      // what the read leaves to say is in the log, and in mason status (`textOrder`); an order not followed is a warning
      textOrder = libcOrderNote(r.order);
      if (textOrder !== null) (r.order.unread ? say : logLine)(`  ! ${textOrder}`);
      if (r.order.unread) warnings.push(textOrder!);
    } catch (e) { fail(reading); say(`  ${(e as Error).message}`); await sync.stop(); await events.close(); await store.close(); return 1; }
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
  try { duckListener = await store.listener(facts.collation, undefined, libc, () => sync.state(), sync.kept.enabled ? sync.kept : undefined); }
  catch (e) { fail("Starting the Postgres listener"); say(`  ${(e as Error).message}`); await requests.close(); await sync.stop(); await usage.close(); await events.close(); await store.close(); return 1; }
  logLine(`[engine] text sorts as the source's collation does: ${JSON.stringify(duckListener.collation)}`);
  // THE USERS (src/duck/users.ts): `mason user` edits the file beside this process; the listener re-reads it at every
  // connection and before every statement of a user's session, so a removal takes effect without a restart
  const users = new LiveUsers(path.join(home, USERS_FILE), cfg.apiKey);
  // THE ROLES (src/cli/roles.ts): the file read again when it or the copied tables change; a session with a role is
  // held to it at every statement, and the catalog is rebuilt with the roles (src/api/postgres/server.ts)
  const liveRoles = new LiveRoles(folder, project.root, () => sources.tables);
  let api: PgApiServer;
  try {
    api = await startPostgresApi({
      port: pgAddress.port, host: pgAddress.host, tls: pgTls.tls, database, masonVersion: o.version, product: "mason-data", statementTimeoutMs,
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
  done(`Postgres listener on ${listenerText(pgTls.listener, api.port)}; ${statementTimeoutMs === 0 ? "statements without a time limit" : `each statement at most ${timeoutSetting.trim()}`} (MASON_STATEMENT_TIMEOUT); ` +
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
    source, facts: () => facts, warnings, textOrder,
    // the slot and publication while a table's sync is replication (the run streams), as the sync says it now
    replication: () => sync.streams() ? repl : null, port: setupPort, token, folder: () => folder, root: project.root, home,
    version: o.version, startedAt,
    // the web page (mason ui): on loopback alone, so mason serve's is reached through mason ui --ssh
    page: true, served: o.serve !== undefined,
    demo: cfg.demo === true,
    users: { file: path.join(home, USERS_FILE), apiKey: cfg.apiKey, database, postgresUrl },
    // the roles as the listener holds them: their row filters checked by its catalog (a filter Postgres refuses is a problem)
    roles: () => api.roles(),
    ...(shares !== undefined ? { shares } : {}),
    // the sources file is the list of what is added: a change to it is read by the sync at once
    sources: () => sources, sourcesChanged: () => { added(); }, readSource: readSources, runUrl: src.resolved,
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
    log: (m) => say(`  ${m}`),
    logs,
    // the statements running now, and a cancel of one: the listener's own (a CancelRequest's path)
    listener: api,
    duck: { copies: () => sync.state(), file: duckFile, poll: (sources) => sync.pollNow(sources), stream: (o) => sync.streamStatus(o), measured: (table) => sync.measured(table), disk: () => sync.diskStatus(), requests, events, usage,
      restarts: () => readRestarts(home), jsonPaths: () => sync.kept.status() },
  };
  const server = createRunServer(runCtx);
  // a sample is /api/state's facts at its moment (src/cli/run-server.ts usageFacts): one computation of each
  usage.start(() => usageFacts(runCtx));
  await listenOnLoopback(server, setupPort);
  const refreshFacts = setInterval(() => {
    void (async () => {
      const c = await connectSource(source);
      if ("failure" in c) return;   // the commands keep the last catalog; the sync says loudly if the source is away
      try { facts = await readSourceFacts(c.pg); } finally { c.pg.close(); }
    })().catch((e: unknown) => logLine(`catalog refresh failed: ${(e as Error).message}`));
  }, 10_000);
  added();
  cfg.running = { pid: process.pid, controlUrl: `http://127.0.0.1:${setupPort}`, token, postgresUrl, postgresListener: pgTls.listener };
  cfg.lastRun = new Date().toISOString();
  writeConfig(home, cfg);
  done(`Mason is up: ${sync.state().length} table(s) added, kept current: ${syncMode === "poll" ? `as each table's sync: says${syncCounts(sources.tables)}` +
      `${sync.streams() ? `; replicated tables streamed as they change (logical replication: slot ${repl.slot}, publication ${repl.publication}${repl.owned ? "" : ", read as it is"})` : ""}`
    : `each table read again whole every ${PASS_RETRY_MS / 1000} s (MASON_DUCK_SYNC=recopy)`}`);
  // THE FILE'S DEFAULT, SAID ONCE (issue 33: nothing Mason does to your database is a hidden default)
  const defaultLine = syncDefaultLine(sources.file, shownPath(project.root, sources.file.file), syncMode === "poll" ? copiedBefore : 0);
  say(`  ${defaultLine}`);
  logLine(`[sync] ${defaultLine}`);
  // THE DEMO'S WRITER: a round of changes every MASON_DEMO_CHANGE_MS, begun once the run is up, said in the log
  if (demo !== null && demoChangeMs !== null) hosted.stopChanges = demoChanges(demo, demoChangeMs, (l) => logLine(`[demo] ${l}`));
  // the stop is in place BEFORE the ready line: a supervisor or a test signals on reading it, and a SIGTERM that found
  // no handler would end the run with the default action, never recording `running: null`
  let stopping = false;
  const stopped = new Promise<number>((resolve) => {
    // a crash of the engine's thread: the run exits 1 with its reason in V8's fatal form, which the supervisor reads
    // (src/cli/supervise.ts crashReason), and its config still says it runs, so the supervisor starts it again
    crash = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      say(`FATAL ERROR: Mason: the engine's thread stopped (${reason})`);
      clearInterval(refreshFacts);
      hosted.stopChanges?.();
      server.close();
      void (async () => {
        // the sessions were told; the listener is closed so that none waits on a copy that cannot answer
        const closed = api.close().catch((e: unknown) => say(`  closing the listener: ${(e as Error).message}`));
        await Promise.race([closed, new Promise((r) => setTimeout(r, 2_000).unref())]);
        // the demo database's data flushed to its folder before the log it writes to ends (dev() closes it otherwise)
        // (a close still going after 2 s is said: the process ends without it, and the folder may not be whole)
        await closedWithin(closeDemo(hosted, null), 2_000, () => say(`  ${DEMO_STILL_CLOSING(2_000)}`));
        log.end();
        resolve(1);
      })();
    };
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      o.serve?.stopping();
      say("\nmason start: stopping …");
      clearInterval(refreshFacts);
      hosted.stopChanges?.();
      server.close();
      void (async () => {
        // before the listener: a share's command is told why, and its tunnel client stopped
        try { await shares?.closeAll("Mason is stopping"); } catch (e) { say(`  closing the share: ${(e as Error).message}`); }
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
        cfg.lastStop = { at: new Date().toISOString(), how: signal === "SIGINT" ? "stopped from its terminal (SIGINT)" : `stopped by mason stop, or a shutdown (${signal})` };
        writeConfig(home, cfg);
        log.end();
        resolve(0);
      })();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  say("");
  say(`  Postgres  ${withPlaceholders(postgresUrl)}  (mason user add <name> makes a user)`);
  // the web page by its command, never its URL: the URL carries the run's token, and this goes to dev.log
  // its words are mason ui's summary (mason --help's), so the two never drift
  if (o.serve === undefined) say(`  Web UI  mason ui  (${UI.summary})`);
  if (demoChangeMs !== null) say(`  Demo  a new order lands every ${demoChangeMs / 1000} s: mason status shows the synced data keeping up`);
  const elsewhere = elsewhereTip(pgTls.listener);
  if (elsewhere) say(`  ${elsewhere}`);
  say(READY);
  say("");
  o.serve?.ready({ tables: () => sync.state(), metrics: () => metricsFacts(runCtx) });
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
