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
 *      added table copied whole from the database and kept current by the xmin poll, or by logical replication
 *      (--replication, src/duck/stream.ts).
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
import { createRunServer, usageFacts, type RunContext } from "./run-server.ts";
import { addedTables, rereadSources, type RunSources } from "./sources.ts";
import { newToken } from "./security.ts";
import { liveRun } from "./runs.ts";
import { DEMO_DIR, DUCK_FILE, projectSource, theProject, writeConfig, type PostgresListener, type ProjectConfig } from "./project.ts";
import { closedWithin, closingOnce, DEMO_STILL_CLOSING, demoChanges, demoChangesRefusal, demoPort, demoSettings, openDemo } from "./demo.ts";
import { postgresApiUrl, readPgTls, type PgListenerSettings } from "../api/postgres/listener.ts";
import { certificateFingerprint, elsewhereTip, ensureSelfSigned, listenerText, runListenerSettings, SELF_SIGNED_FILES } from "./pg-tls.ts";
import { startPostgresApi, timeoutMs, type PgApiServer } from "../api/postgres/server.ts";
import { RequestLedger, REQUESTS_TABLE, requestLogDays } from "../duck/requests.ts";
import { EVENTS_TABLE, SyncEvents } from "../duck/events.ts";
import { USAGE_TABLE, UsageSampler } from "../duck/usage.ts";
import { withPlaceholders } from "./pg-url.ts";
import { cliPinProblem, ensurePin } from "./pin.ts";
import type { ChangeSource } from "../cdc/poll.ts";
import { DEFAULT_MEMORY_LIMIT, DuckStore, DUCKDB_VERSION } from "../duck/store.ts";
import { copyChunkSecondsOf, copyParallelOf, Sync, syncModeOf, type CopyState } from "../duck/sync.ts";
import { storeJsonPathsOf } from "../duck/kept.ts";
import { readLibcOrder, type LibcOrder } from "../duck/libc-order.ts";
import { isLibcCollation } from "../duck/rewrite.ts";
import { listenerLogins, LiveUsers, USERS_FILE } from "../duck/users.ts";
import { READY_LINE, readRestarts } from "./supervise.ts";
import { changesOf, dropOwnReplication, dropStatements, madeReplication, namedPublication, projectReplication, replicationReadiness } from "./replication-mode.ts";
import { textEntry } from "../lib/log.ts";
import { LogBuffer } from "../lib/log-buffer.ts";

export interface DevOptions {
  /** the port the commands reach the run on (src/cli/run-server.ts), or the next free one */
  port: number;
  version: string;
  /** --replication / --poll: how the run reads the database's changes; null keeps the project's (src/cli/replication-mode.ts) */
  changes: ChangeSource | null;
  /** --publication: the publication replication reads, the operator's, read as it is; null: PG_PUBLICATION, else the
   *  one an earlier start recorded, else Mason's own */
  publication: string | null;
  /** --self-signed-tls: the Postgres listener serves a certificate made for the project in .mason/ (src/cli/pg-tls.ts) */
  selfSignedTls: boolean;
  /** `mason serve` runs this run on a server (src/cli/serve.ts): its log on stdout, its health said to the platform */
  serve?: ServeHooks;
}

/** What `mason serve` is told by the run it serves (src/cli/serve.ts). */
export interface ServeHooks {
  /** each line of the run's log, as it is written to .mason/mason.log: a container's log is its stdout */
  log: (line: string) => void;
  /** the run answers: its listener is up and its tables are added (they may still be copying) */
  ready: (run: { tables: () => CopyState[] }) => void;
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
    return { refuse: `this project's copy is of the database ${recorded.database}, and .mason/config.json now names ${now.database}. ` +
      "Its copied rows are not that database's: mason destroy (removes the copy; your files stay), then mason start copies it" };
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
  const demoRefused = demoChangesRefusal(cfg, o.changes);
  if (demoRefused) return failed("start", demoRefused, { json: false });
  let demoChangeMs: number | null = null;
  if (cfg.demo === true) {
    try { demoChangeMs = demoSettings(process.env).changeMs; }
    catch (e) { say(`mason start: ${(e as Error).message}`); return 1; }
  }
  const pinned = cliPinProblem(folder, o.version);
  if (pinned) { say(`mason start: ${pinned}`); return 1; }
  // THE SOURCE (src/cli/sources.ts): the database and the tables to copy, from the project's sources file; a server's
  // URL from its environment first (mason serve is configured by it alone). Read here, its failure said below where it
  // always was (after the listener's checks): a demo project's port is needed first
  const readSources = (): ReturnType<typeof projectSource> => projectSource(project, process.env, { shellFirst: o.serve !== undefined });
  const src = readSources();
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
      wayOut: `this project was not made with --remote: if you mean to copy from that machine, set "remote": true in ${config} and start again`,
      next: [["mason start", `once ${config} says "remote": true`]] }), { json: false });
  }
  if ("exit" in checked) {
    fail(`Connecting to ${db}`);
    for (const m of checkSaid) say(`  ${m.replace(/^mason start: /, "")}`);
    if (checked.exit !== 2) say(`  (the database's URL is ${src.from}: change it there if its host, port or password changed)`);
    return checked.exit === 2 ? 1 : checked.exit;
  }
  const { source, warnings } = checked;
  done(`Connected to ${db}: Postgres ${checked.facts.versionText}${checked.facts.standby ? " (a read replica)" : ""}, ${checked.facts.tables.length} table(s) this user can read`);
  for (const w of warnings) say(`  ! ${w}`);
  // HOW THE CHANGES ARE READ (src/cli/replication-mode.ts): polling with SELECTs, or the change log as production reads
  // it (src/duck/stream.ts). A switch copies nothing again here: polling goes on from each table's watermark, and a
  // new slot's tables are caught up by one poll (Sync prepareReplication)
  const changes = changesOf(o.changes, cfg.changes);
  if (o.publication !== null && changes !== "replication") {
    say("mason start: --publication names the publication logical replication reads, and this project polls: mason start --replication --publication <name>");
    return 1;
  }
  // THE PUBLICATION: one the operator named (the flag, PG_PUBLICATION, or the one an earlier start recorded) is read as it
  // is, never altered (src/duck/publication.ts); else Mason makes its own. What the run before made, as it recorded it,
  // is what --poll drops (madeReplication)
  const named = changes === "replication" ? namedPublication(o.publication, process.env, cfg.publication) : null;
  const repl = projectReplication(cfg.name, src.name, named?.name ?? null);
  const before = madeReplication(cfg, src.name);
  if (changes === "replication") {
    begin("Checking logical replication");
    const ready = await replicationReadiness(source, repl);
    if ("failure" in ready || ready.refused.length) {
      fail("Checking logical replication");
      for (const c of "failure" in ready ? [{ name: "database", detail: ready.failure }] : ready.refused) say(`  ${c.name}: ${c.detail}`);
      say("  (mason start --poll reads the database with SELECTs instead, which needs none of this)");
      return 1;
    }
    done(repl.owned ? `Logical replication: Mason makes publication ${repl.publication} and slot ${repl.slot} on ${source.database} (mason destroy, or mason start --poll, drops them)`
      : `Logical replication: publication ${repl.publication} is read as it is, never altered; Mason makes slot ${repl.slot} on ${source.database} (mason destroy, or mason start --poll, drops the slot alone)`);
    if (named?.from === "recorded") say(`  publication ${repl.publication} was named at an earlier start of this copy, and is read again (mason start --replication --publication <name> names another)`);
    for (const w of ready.warnings) say(`  ! ${w.name}: ${w.detail}`);
    // A SLOT RECORDED UNDER ANOTHER NAME (the sources file renamed since) is one this run no longer reads, and it holds
    // the database's WAL while it exists: it goes as at --poll, verified, before the record names the new one
    const was = cfg.replication ?? null;
    if (was !== null && was.slot !== repl.slot) {
      try { for (const d of await dropOwnReplication(source, was)) say(`  dropped ${d} from ${source.database}: this source's slot is ${repl.slot} now`); }
      catch (e) {
        say(`mason start: ${(e as Error).message}. They hold the database's WAL while nobody reads them: drop them by hand — ${dropStatements(was)}`);
        return 1;
      }
    }
    // recorded with the run, so mason status and mason stop say it, the next start reads the same one, and --poll and
    // mason destroy drop what was made by its own name
    const recorded = repl.owned ? null : repl.publication;
    if ((cfg.publication ?? null) !== recorded || JSON.stringify(cfg.replication ?? null) !== JSON.stringify(repl)) {
      cfg.publication = recorded;
      cfg.replication = repl;
      writeConfig(home, cfg);
    }
  }
  const previous = cfg.changes ?? "poll";
  if (previous !== changes) {
    // THE SLOT GOES WHENEVER THE PROJECT LEAVES REPLICATION: it holds the database's WAL while nobody reads it
    if (previous === "replication") {
      try { for (const d of await dropOwnReplication(source, before)) say(`  dropped ${d} from ${source.database}`); }
      catch (e) {
        say(`mason start: ${(e as Error).message}. They hold the database's WAL while nobody reads them: drop them by hand — ${dropStatements(before)}`);
        return 1;
      }
      if (!before.owned) say(`  publication ${before.publication} is its owner's: left as it is`);
      cfg.publication = null;
      cfg.replication = null;
    }
    cfg.changes = changes;
    writeConfig(home, cfg);
  }
  let facts: SourceFacts = checked.facts;
  const move = sourceMove(cfg.sourceServer ?? null, { database: source.database, systemIdentifier: facts.systemIdentifier });
  if ("refuse" in move) { say(`mason start: ${move.refuse}`); return 1; }
  // THE TABLES THE SOURCES FILE NAMES, against the database's catalog: every mistake said at once, before anything opens
  const firstTables = addedTables(src, facts.tables, source.database, project.root, { replication: changes === "replication" });
  if (!Array.isArray(firstTables)) return failed("start", firstTables, { json: false });
  // what the run copies: the sources file as last read, and what is wrong with it now (an edit the run cannot take)
  let sources: RunSources = { file: src, tables: firstTables, problem: null };

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

  begin("Opening the copy");
  const duckFile = path.join(home, DUCK_FILE);
  let store: DuckStore;
  // its memory bounded (src/duck/store.ts DEFAULT_MEMORY_LIMIT): past it a statement spills, or fails alone
  const memoryLimit = process.env.MASON_DUCKDB_MEMORY || undefined;
  try { store = await DuckStore.open(duckFile, (l) => logLine(`[duckdb] ${l}`), memoryLimit === undefined ? {} : { memoryLimit }); }
  catch (e) { fail("Opening the copy"); say(`  ${(e as Error).message}`); return 1; }
  // THE COPY'S THREAD DYING (src/duck/executor.ts: V8 out of heap there, an uncaught error) ends the run, said, for its
  // supervisor to start it again: every session's statement in flight was told 57P02, and nothing can be answered after
  let crash: ((reason: string) => void) | null = null;
  store.onCrash((reason) => {
    logLine(`[duckdb] the copy's thread stopped: ${reason}`);
    if (crash !== null) crash(reason);
    else say(`  ! the copy's thread stopped: ${reason}`);
  });
  done(`the copy in ${path.relative(project.root, duckFile)} (mason destroy deletes it; engine ${DUCKDB_VERSION}), at most ${(memoryLimit ?? DEFAULT_MEMORY_LIMIT).trim()} of memory (MASON_DUCKDB_MEMORY), spilling to ${path.relative(project.root, duckFile)}.tmp`);
  const pollMs = Number(process.env.MASON_POLL_MS || 5000);
  const syncMode = changes === "replication" ? "replication" : syncModeOf(process.env);
  // THE SYNC'S EVENTS (src/duck/events.ts): its failures and notable events, kept as the request log is, before the sync
  // that records them starts
  const keptDays = requestLogDays(process.env.MASON_REQUEST_LOG_DAYS);
  if (typeof keptDays !== "number") { fail("Opening the copy"); say(`  ${keptDays.problem}`); await store.close(); return 1; }
  let events: SyncEvents;
  try { events = await SyncEvents.open(store, logLine, { days: keptDays }); }
  catch (e) { fail("Opening the copy"); say(`  the sync's events (${EVENTS_TABLE}) could not be opened: ${(e as Error).message}`); await store.close(); return 1; }
  const sync = new Sync(store, source, cfg.name, (l) => { logLine(`[sync] ${l}`); if (!o.serve && /^copied |failed/.test(l)) say(textEntry("  ", l).trimEnd()); }, pollMs, syncMode,
    syncMode === "replication" ? repl : null, { copyParallel, copyChunkSeconds, json: { enabled: storeJsonPaths }, onEvent: (e) => events.record(e) });
  await sync.open();
  // a database restored to another server: its transaction ids are not the watermarks', so every table is read again
  if (move.action === "reread") { await sync.rereadAll(); say(`  ${source.database} is on another server than the copy was taken from: reading its tables again`); }
  if (move.action !== "same") { cfg.sourceServer = { systemIdentifier: facts.systemIdentifier, database: source.database }; writeConfig(home, cfg); }
  // the views first: setting the tables rebuilds the catalog, which reads them. The sources file read again: a mistake in it
  // keeps the tables read before (a typo never drops a copy), said in the log and by mason status
  const added = (): void => {
    const r = rereadSources(sources, readSources(), src.resolved, facts.tables, source.database, project.root, { replication: changes === "replication" });
    if (r.said !== null) logLine(`[sync] ${r.said}`);
    sources = { file: r.file, tables: r.tables, problem: r.problem };
    sync.setViews(facts.views ?? []);
    void sync.setTables(sources.tables);
  };

  if (pg.said) say(`  ${pg.said}`);
  const pgAddress = { host: listen.host, port: listen.port };
  const postgresUrl = postgresApiUrl(pgAddress, cfg.name, { tls: pgTls.tls !== null });
  // A LIBC COLLATION'S ORDER IS READ FROM THE DATABASE (src/duck/libc-order.ts): once, a few read-only SELECTs, kept in
  // the copy and read again when the database's collation version moves (an OS upgrade's glibc)
  let libc: LibcOrder | undefined;
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
      if (r.read) done(`Read how ${source.database} orders text (${coll.collate}): kept in the copy, read again only when its collation version moves`);
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
  // for MASON_REQUEST_LOG_DAYS (read above, with the sync's events)
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
  logLine(`[duckdb] text sorts as the source's collation does: ${JSON.stringify(duckListener.collation)}`);
  // THE USERS (src/duck/users.ts): `mason user` edits the file beside this process; the listener re-reads it at every
  // connection and before every statement of a user's session, so a removal takes effect without a restart
  const users = new LiveUsers(path.join(home, USERS_FILE), cfg.apiKey);
  let api: PgApiServer;
  try {
    api = await startPostgresApi({
      port: pgAddress.port, host: pgAddress.host, tls: pgTls.tls, database: cfg.name, masonVersion: o.version, product: "mason-data", statementTimeoutMs,
      ...listenerLogins(users, cfg.apiKey),
      schema: () => sync.schema(),
      // the one place a request is recorded: the request log's row, and the usage sample's count of it
      record: (row) => { requests.record(row); usage.count(row); },
      log: logLine,
      trace: process.env.MASON_PG_TRACE === "1",
      duck: duckListener,
    });
  } catch (e) { fail("Starting the Postgres listener"); say(`  ${(e as Error).message}`); await requests.close(); await sync.stop(); await usage.close(); await events.close(); await store.close(); return 1; }
  done(`Postgres listener on ${listenerText(pgTls.listener, api.port)}; ${statementTimeoutMs === 0 ? "statements without a time limit" : `each statement at most ${timeoutSetting.trim()}`} (MASON_STATEMENT_TIMEOUT); ` +
    `every request recorded for ${keptDays} day${keptDays === 1 ? "" : "s"} (MASON_REQUEST_LOG_DAYS; mason logs --requests)`);

  const setupPort = await freePort(o.port, chosen);
  const token = newToken();
  const runCtx: RunContext = {
    source, facts: () => facts, warnings,
    slot: changes === "replication" ? repl.slot : "", changes, port: setupPort, token, folder: () => folder, root: project.root, home,
    version: o.version, startedAt,
    // the web page (mason ui) is mason start's alone: mason serve's run serves none (src/cli/run-server.ts RunContext.page)
    page: o.serve === undefined,
    demo: cfg.demo === true,
    users: { file: path.join(home, USERS_FILE), apiKey: cfg.apiKey, database: cfg.name, postgresUrl },
    ...(changes === "replication" ? { publication: { name: repl.publication, owned: repl.owned } } : {}),
    // the sources file is the list of what is added: a change to it is read by the sync at once
    sources: () => sources, sourcesChanged: () => { added(); }, readSource: readSources, runUrl: src.resolved,
    log: (m) => say(`  ${m}`),
    logs,
    // the statements running now, and a cancel of one: the listener's own (a CancelRequest's path)
    listener: api,
    duck: { copies: () => sync.state(), file: duckFile, pollSeconds: pollMs / 1000, poll: (sources) => sync.pollNow(sources), stream: () => sync.streamStatus(), disk: () => sync.diskStatus(), requests, events, usage,
      restarts: () => readRestarts(home), jsonPaths: () => sync.kept.status() },
  };
  const server = createRunServer(runCtx);
  // a sample is /api/state's facts at its moment (src/cli/run-server.ts usageFacts): one computation of each
  usage.start(() => usageFacts(runCtx));
  await new Promise<void>((resolve) => server.listen(setupPort, "127.0.0.1", resolve));
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
  done(`Mason is up: ${sync.state().length} table(s) added, kept current ${syncMode === "replication" ? `by logical replication (slot ${repl.slot}, publication ${repl.publication}${repl.owned ? "" : ", read as it is"})`
    : `every ${pollMs / 1000} s ${syncMode === "poll" ? "by polling with SELECTs (xmin)" : "by copying each table again whole (MASON_DUCK_SYNC=recopy)"}`}`);
  // THE DEMO'S WRITER: a round of changes every MASON_DEMO_CHANGE_MS, begun once the run is up, said in the log
  if (demo !== null && demoChangeMs !== null) hosted.stopChanges = demoChanges(demo, demoChangeMs, (l) => logLine(`[demo] ${l}`));
  // the stop is in place BEFORE the ready line: a supervisor or a test signals on reading it, and a SIGTERM that found
  // no handler would end the run with the default action, never recording `running: null`
  let stopping = false;
  const stopped = new Promise<number>((resolve) => {
    // a crash of the copy's thread: the run exits 1 with its reason in V8's fatal form, which the supervisor reads
    // (src/cli/supervise.ts crashReason), and its config still says it runs, so the supervisor starts it again
    crash = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      say(`FATAL ERROR: Mason: the copy's thread stopped (${reason})`);
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
        if (syncStop !== null) say(`  closing the copy: ${syncStop.message}`);
        else {
          try { await store.close(); say(`  closed the copy (it stays in ${duckFile})`); } catch (e) { say(`  closing the copy: ${(e as Error).message}`); }
        }
        if (syncMode === "replication") say(`  replication slot ${repl.slot} stays on ${source.database}, holding its WAL until the next mason start reads it (mason destroy drops it)` +
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
  if (o.serve === undefined) say("  Web UI  mason ui  (the status page and the users, in your browser)");
  if (demoChangeMs !== null) say(`  Demo  a new order lands every ${demoChangeMs / 1000} s: mason status shows the copy keeping up`);
  const elsewhere = elsewhereTip(pgTls.listener);
  if (elsewhere) say(`  ${elsewhere}`);
  say(READY);
  say("");
  o.serve?.ready({ tables: () => sync.state() });
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
    try { made = ensureSelfSigned(home, cfg.name); }
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

/** The one sentence of how the pieces fit, printed first by `mason start` and at the top of its help and the README. */
export const PROJECT_LINE = "A Mason project is your app's folder: mason/sources/ names the database and the tables to copy, yours to commit; " +
  "this machine's copy of your data and Mason's state are in .mason/, rebuilt from that file.";
