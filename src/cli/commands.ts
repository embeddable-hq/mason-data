/**
 * THE COMMANDS BESIDE `mason start` (an interface as good for people as for coding agents).
 * Each one finds the run it means (src/cli/runs.ts) and asks its command server (src/cli/control.ts) — or, for what
 * needs only the project's files and its database (tables; add and remove while Mason is down), reads them itself — and
 * prints it for a person or, with `--json`, as data a program reads. Exit codes are part of each command's contract:
 *
 *   mason status [--json]                 what the run is doing: its database, its tables and their copies, the Postgres API
 *   mason tables [<table>…] [--json]      the database's tables, their columns, keys and foreign keys
 *   mason add <table>… [--columns …]      copy tables into Mason: every column, or the ones --columns names
 *   mason remove <table>…                 take tables out of the sources file; their copies are dropped
 *   mason wait [--timeout <s>] [--json]   until every added table is synced: 0 ready, 1 a copy failed (said), 124 timed out
 *   mason logs [-n <lines>] [-f] [--start] [--requests] [--events]   the run's log; --start, the start's terminal; --requests, its request log; --events, the sync's events
 *   mason stop                            stop Mason for this folder's project (the copy stays)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { asFailure, endText, errorJson, failed, jsonText, nextBlock, parseCommand, reportText, withEnd, type CommandSpec, type Failure, type NextStep, type Problem } from "./command.ts";
import { err as styleErr, out as styleOut, stepRenderer, wrap, type Style } from "./style.ts";
import { alive, endRun, END_GRACE_MS, notAnswering, runState, theRun, type DevRun } from "./runs.ts";
import { version } from "./version.ts";
import { restartsFact, signalSupervisor, stopSupervisor, supervisorGone, type RestartsFact } from "./supervise.ts";
import { DEMO_DIR, DUCK_FILE, STATE_DIR, databaseMoved, isProject, projectDatabase, projectSource, readProject, theProject, writeConfig, type Project } from "./project.ts";
import { callRun, RunUnreachable } from "./control.ts";
import { withPlaceholders, postgresFacts, postgresLink, type PostgresLink } from "./pg-url.ts";
import { listenerText } from "./pg-tls.ts";
import type { RefusedQuery, SlowQuery } from "./run-server.ts";
import { logEntries, logLineText } from "../lib/log-buffer.ts";
import { catalogTable, entryName, looksSecret, tableNameProblem, type CatalogColumn, type CatalogTable, type ProjectSource } from "./sources.ts";
import { addEntry, Refusal, removeEntries, sourceToEdit, type EditCatalog, type EditTarget, type PickResult, type RemoveResult } from "./source-edit.ts";
import { connectSource, maskedUrl, parseSource, readSourceFacts, type SourceFacts, type SourceTable } from "./preflight.ts";
import type { GeneratedStatus } from "../duck/generated.ts";
import { reach } from "./state.ts";
import { copyingText, copyProgress, duration, generatedReadiness, msText, readiness, readinessWord, type Readiness, type SyncFacts, type SyncTotals } from "./readiness.ts";
import type { SyncEvent } from "../duck/events.ts";
import type { CopyProgressView, KeptCurrent, StreamStatus } from "../duck/sync.ts";
import type { KeptPathStatus } from "../duck/kept.ts";
import { pathText } from "../duck/kept-route.ts";
import type { LedgerRequest, QuerySummary, QueryWindow, RequestQuery, UnsupportedSql } from "../duck/requests.ts";
import type { RunningStatement, SessionsOpen } from "../api/postgres/server.ts";
import type { ShareState } from "./share-run.ts";
import { DEFAULT_REQUEST_LIMIT, eventLimit, MAX_SEARCH, SLOW_MS, requestFilter, requestFilterParams, type FilterKey } from "./request-filter.ts";
import { countsText } from "../duck/stream.ts";
import { agoText, BIG_TABLE_ROWS, parseSync, syncText, type TableSync } from "../lib/table-sync.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const err = (m: string): void => { process.stderr.write(`${m}\n`); };

// ------------------------------------------------------------------ what the command server answers (runState)

export type ColumnState = CatalogColumn;
/** A table as the run's state says it: the catalog's and the sources file's facts (sources.ts catalogTable, what mason
 *  tables reads without the run), and its copy (src/cli/run-server.ts runState) */
export interface TableState extends Omit<CatalogTable, "columns"> {
  /** its columns: only in the state asked with `?columns=1` (readState; mason status --json carries them), never in
   *  the lean one the page polls (src/cli/run-server.ts runState) */
  columns?: ColumnState[];
  copy: { phase: "copying" | "done" | "failed"; rowsCopied: number; updatedAt: string;
    /** while its chunks are read: the chunks done and reading, the measured rate, the time left, as of the moment the
     *  state was asked (src/duck/sync.ts copyProgressNow) */
    progress?: CopyProgressView;
    /** the copy is in a layout the run no longer keeps, and is copied again (it serves as it was meanwhile): why, in
     *  the reader's words (src/duck/sync.ts RETIRED_LAYOUT) */
    retired?: string } | null;
  /** why its copy failed (the sync tries again by itself, src/duck/sync.ts copyRetryDelayMs); null otherwise */
  error: string | null;
  /** an added table's sync: its state, its last sync and its age (src/cli/readiness.ts tableSync); a run from before it has none */
  sync?: SyncFacts;
  /** how the run keeps the copy current now — its sync, when it was last synced — the sync's one derivation (src/duck/sync.ts KeptCurrent): absent for a
   *  table the sync does not hold, and from a run before it was said */
  kept?: KeptCurrent;
}
export interface RunState {
  /** the database the run copies from: a JSON key named `source` is always this object, never a table (a table is `table`) */
  source: { url: string; database: string; remote: boolean; version: string; standby: boolean; changes: "poll" | "replication";
    /** the demo database this run hosts (`mason init demo`); absent from a run before it was said */
    demo?: boolean;
    /** what the read of a libc collation's order leaves to say (src/duck/libc-order.ts libcOrderNote); absent: nothing */
    textOrder?: string;
    /** the source's name: its sources file's, without `.yml` */
    name: string | null;
    /** the sources file the run copies from, absolute */
    file: string | null;
    /** the same, relative to the project's root (src/cli/sources.ts shownPath): what mason status and the web page show,
     *  which never shows an absolute path; absent from a run before it was said */
    shownFile?: string | null;
    /** every table's sync unless its entry says its own: the file's top `sync:` (`written`), else the default, off */
    sync?: { default: string; written: boolean };
    /** replication mode: its slot and publication (`owned`: Mason's own; else named, only read) */
    replication?: { slot: string; publication: string; owned: boolean } };
  warnings: string[];
  folder: string | null;
  /** the project folder's fingerprint (src/lib/project-files.ts projectFingerprint) */
  project: string | null;
  tables: TableState[];
  /** where a tool connects (src/cli/pg-url.ts postgresFacts): the URL's parts, the URL with `<user>:<password>` in the
   *  credentials' place, and its psql line; a run from before it has none */
  postgres?: PostgresLink & { shown: string; psql: string };
  /** the copies in all (src/cli/readiness.ts syncTotals); a run from before it has none */
  totals?: SyncTotals;
  /** the run's copy: its file */
  engine: { file: string; bytes: number | null;
    /** the days the request log, the events and the usage samples are kept (MASON_HISTORY_DAYS); a run from before it has none */
    keptDays?: number;
    /** the run's version, when it started (ISO), and how long it has been up; a run from before them has none */
    version?: string; startedAt?: string; uptimeSeconds?: number;
    /** its supervisor's restarts (src/cli/supervise.ts restartsFact): how many, and the last one */
    restarts?: RestartsFact };
  /** replication mode: where the stream is, its lag, what it applied (src/duck/sync.ts streamStatus) */
  stream?: StreamStatus;
  /** the disk under the copy (src/duck/sync.ts diskStatus): free where its file is, the file, what the copies running
   *  are projected to add; a run from before it has none */
  disk?: { path: string; freeBytes: number | null; copyBytes: number | null; projectedBytes: number | null; error?: string };
  /** the Postgres API's sessions logged in now, by user and client (src/api/postgres/server.ts openSessions); a run from
   *  before it has none */
  sessions?: SessionsOpen;
  /** the JSON paths stored as columns of the copies (src/duck/kept.ts): a run from before them has none */
  jsonPaths?: KeptPathStatus[];
  /** the generated tables (src/duck/generated.ts): a run from before them has none */
  generatedTables?: GeneratedStatus[];
  /** what mason wait waits on (src/cli/readiness.ts), said by the run: a run from before it has none */
  readiness?: Readiness;
  /** the run serves the web page (`mason ui`): a run from before it has none */
  ui?: boolean;
  /** this is `mason serve`'s run: `mason ui --ssh` opens its page from another machine */
  served?: boolean;
  /** why the page offers no Add or Remove (a server's sources file cannot be written), or null */
  sourcesReadOnly?: string | null;
  /** the roles file (mason/roles.yml, src/cli/roles.ts) as the listener reads it now: the roles by name, and what is
   *  wrong with it (every statement of a user with a role is refused while there is); absent from a run before roles */
  roles?: { file: string | null; roles: string[]; problem: string | null; default: string | null; all?: string[];
    /** each role's attributes and their shapes, and its where:s (src/duck/row-filter.ts): what mason user add --set is held to */
    attributes?: Record<string, Record<string, "scalar" | "list">>; wheres?: Record<string, Array<{ table: string; at: string; where: string }>> };
  /** the share open now (mason share, src/cli/share-run.ts), or null; a run from before it has none */
  share?: ShareState | null;
}

// ------------------------------------------------------------------ shared

/** The run a command that needs one works with (src/cli/state.ts reach), or null once the state's failure is said. */
async function runOr(spec: CommandSpec & { needs: "run" }, json: boolean): Promise<DevRun | null> {
  const w = await reach(spec, json);
  return w !== null && "run" in w ? w.run : null;
}

/** The run's state with each table's columns (`?columns=1`: `mason status --json` carries them; the page polls it lean). */
export async function readState(run: DevRun): Promise<RunState> {
  const r = await callRun(run, "GET", "/api/state?columns=1");
  if (r.status !== 200) throw new RunUnreachable(String(r.body.error ?? `HTTP ${r.status}`));
  return r.body as unknown as RunState;
}

/** A command body that may fail to reach the run: the failure said (JSON under --json), exit 1. */
export async function guarded(cmd: string, json: boolean, f: () => Promise<number>): Promise<number> {
  try { return await f(); }
  catch (e) {
    if (e instanceof RunUnreachable) return failed(cmd, e.failure, { json });
    throw e;
  }
}

const n = (x: number): string => x.toLocaleString("en-US");
/** A list of sentences, each a bullet; a sentence's own further lines indented under it. */
const bullets = (xs: readonly string[]): string => xs.map((x) => `  - ${x.split("\n").join("\n    ")}`).join("\n");
const firstLine = (s: string): string => s.split("\n")[0]!.trim();

/** A table as the commands name it: `orders` (in public), or `schema.table` — never a third part (tableNameProblem). */
export function findTable<T extends Omit<CatalogTable, "columns">>(tables: readonly T[], name: string): T | Failure {
  const malformed = tableNameProblem(name, tables.map((t) => t.table));
  if (malformed !== null) return { message: malformed, code: "usage" };
  const exact = tables.find((t) => t.table === name) ?? tables.find((t) => t.table === `public.${name}`);
  if (exact) return exact;
  const byTable = tables.filter((t) => t.table.split(".").slice(1).join(".") === name);
  if (byTable.length === 1) return byTable[0]!;
  if (byTable.length > 1) return { message: `${name} is in several schemas (${byTable.map((t) => t.table).join(", ")})`, code: "not_found", fix: "name it with its schema: schema.table" };
  return { message: `the database has no table ${JSON.stringify(name)} this user can read`, code: "not_found", next: [["mason tables", "the tables it has, as this user reads them"]] };
}

/** A table as `mason add` and `mason tables` take it: its name alone in the public schema, else with its schema. */
export const tableArg = entryName;

/** What to run once every added table is copied: a user for the tool that will query it (src/cli/user.ts). */
export const READY_STEPS: readonly NextStep[] = [
  ["mason user add <name>", "a user for your BI tool or psql: it prints the password and the URL to paste"],
  ["mason status", "each synced table, and the statements the Postgres API answered slowly or refused"],
];

/** What to run next over a database's tables: a table's columns, then adding it — named after a real table not yet added.
 *  `from: "tables"` is mason tables itself asking: it never points at itself. */
export function addSteps(tables: ReadonlyArray<Omit<CatalogTable, "columns">>, from: "tables" | null = null): NextStep[] {
  const one = tables.find((t) => !t.added && t.reason === null);
  if (!one) return [...READY_STEPS];
  const name = tableArg(one.table);
  // every table first: which to add is the first question (so mason status's Next includes mason tables)
  return [
    ...(from === "tables" ? [] : [["mason tables", "the database's tables: rows, key, whether added"] as NextStep]),
    [`mason tables ${name}`, "one table's columns"],
    [`mason add ${name}`, "sync it into Mason: it is added to the sources file (--columns a,b,c: those only)"],
  ];
}

// ------------------------------------------------------------------ readiness (mason wait, mason status): src/cli/readiness.ts

export { copyingText, copyProgress, duration, msText, readiness, readinessWord, type Readiness };

/** A table line's bar in its state's colour (on a terminal): green copied, red failed, yellow served but not kept current, cyan at work
 *  (a table whose sync is off is copied as it asked: green). */
export function paintBar(line: string, s: Style): string {
  const colour = / its first sync failed: /.test(line) ? s.red : / NOT kept current /.test(line) ? s.yellow : / 100%  [\d,]+ rows · synced( · |$)/.test(line) ? s.green : s.cyan;
  return line.replace(/(█+)(░*)|(░+)/, (_m, full: string | undefined, empty: string | undefined, none: string | undefined) =>
    full !== undefined ? `${colour(full)}${s.dim(empty ?? "")}` : s.dim(none ?? ""));
}

/** The width of a table's progress bar, in characters. */
const BAR = 20;
const bar = (fraction: number): string => { const full = Math.round(Math.max(0, Math.min(1, fraction)) * BAR); return "█".repeat(full) + "░".repeat(BAR - full); };

/**
 * EVERY ADDED TABLE ON A LINE OF ITS OWN (after `mason add a b c` where a and c copy quickly, `mason wait` showed only
 * b; it shows a line for each table, 100% for those up to date and a progress bar for those still at work, in order of
 * last processed, so the ones at work are at the bottom): its bar, its percent and what it is doing. The finished
 * first, in the order they finished (`copy.updatedAt`: a finished copy's state is written once, when it finishes), then
 * the failed, the copying and the waiting. A copied table says how it is kept current and how old its copy is
 * (`keptAge`): a copy's age is never hidden.
 */
export function tableLines(s: RunState, now: number = Date.now()): string[] {
  const picked = s.tables.filter((t) => t.added);
  // 0 done, 1 failed, 2 copying, 3 waiting for its copy
  const rank = (t: TableState): number => t.error ? 1 : t.copy?.phase === "copying" ? 2 : !t.copy ? 3 : 0;
  const rows = picked.map((t) => {
    const r = rank(t);
    let fraction: number, what: string;
    if (r === 0) {
      fraction = 1;
      const age = keptAge(t, now);
      what = `${n(t.copy?.rowsCopied ?? 0)} rows · synced${t.copy?.retired ? ` · ${t.copy.retired}` : ""}${age ? ` · ${age}` : ""}`;
    }
    else if (r === 1) { fraction = 1; what = `its first sync failed: ${firstLine(t.error!)}`; }
    else if (r === 2) {
      const c = copyingText(t.copy!.rowsCopied, t.rows, t.copy!.progress);
      fraction = c.fraction ?? 0;
      // a count says it is copying; "reading the first chunk" says so itself
      what = /^\d/.test(c.text) ? `syncing ${c.text}` : c.text;
    } else { fraction = 0; what = "waiting for its first sync to start"; }
    return { t, r, at: t.copy?.updatedAt ?? "", line: `${bar(fraction)} ${`${Math.floor(fraction * 100)}%`.padStart(4)}  ${what}` };
  });
  rows.sort((a, b) => a.r - b.r || a.at.localeCompare(b.at) || a.t.table.localeCompare(b.t.table));
  const w = Math.max(0, ...rows.map((x) => x.t.table.length));
  return rows.map((x) => `${x.t.table.padEnd(w)}  ${x.line}`);
}

/**
 * HOW A COPIED TABLE IS KEPT CURRENT, AND HOW OLD ITS COPY IS, on its line (issue 33: a copy days old answers today's
 * count(*) wrongly, and nothing else tells): `sync: off, last synced 3 days ago — mason sync orders`, `polled every
 * 30s, last 4 s ago`, `replicated, at 0/1A2B3C4D, 2 s ago` (the stream's position, and the last moment it had
 * everything the database wrote); a table being caught up, copied again or not streamed says why it is NOT kept current.
 * The Stream section says the rest of the stream.
 */
export function keptAge(t: Pick<TableState, "table" | "kept">, now: number = Date.now()): string | null {
  const k = t.kept;
  if (k?.by === "replication") {
    if (k.state !== "streamed") return `NOT kept current (${k.syncedAt === null ? "never synced" : `last synced ${agoText(k.syncedAt, now)}`}): ${k.why ?? "it is not streamed yet"}`;
    const at = `replicated, at ${k.position}, ${k.syncedAt === null ? "not synced yet" : agoText(k.syncedAt, now)}`;
    return k.notRunning === null ? at : `${at} — NOT kept current now, the stream is not running: ${k.notRunning}`;
  }
  if (k?.by !== "poll") return null;
  const synced = k.syncedAt === null ? "never synced" : `last synced ${agoText(k.syncedAt, now)}`;
  if (k.pending !== undefined) return `NOT kept current (${synced}): ${k.pending}`;
  // the line to write as well as the command: a project an older Mason polled is off after the upgrade
  if (k.sync.mode === "off") return `sync: off, ${synced} — mason sync ${tableArg(t.table)} syncs it now; sync: poll 5m on its entry polls it`;
  return `polled every ${k.sync.every}, ${k.syncedAt === null ? "not polled yet" : `last ${agoText(k.syncedAt, now)}`}`;
}

/** A span of seconds as the stream's lines say it: `0.3 s` under ten seconds, then as a wait reads (`duration`). */
export const spanText = (seconds: number): string => seconds < 10 ? `${Math.max(0, seconds).toFixed(1)} s` : duration(seconds);

/**
 * WHERE THE STREAM IS, a thing a line (the first replication run on a server showed nothing of it in 35
 * minutes): its position against the database's and the bytes between, the newest change applied and how long after
 * its commit, then every added table — streamed with what it applied this run, being caught up (from when, doing what),
 * not streamed yet, or left out — and why. `mason status` prints it under "Stream", `mason wait` under its tables;
 * `--json` is the `StreamStatus` itself.
 */
export function streamLines(st: StreamStatus, now = Date.now()): string[] {
  const rows: Array<[string, string]> = [];
  const since = (iso: string): number => (now - Date.parse(iso)) / 1000;
  if (!st.running) {
    rows.push(["stream", st.failure === null ? "not running yet: it starts once the slot is made"
      : `not running: ${st.failure.error.split("\n")[0]} · it starts again in ${spanText(Math.max(0, -since(st.failure.retryAt)))}`]);
  }
  const db = "lsn" in st.database
    ? `the database is at ${st.database.lsn}: ${n(st.lag.bytes ?? 0)} bytes behind (read ${spanText(since(st.database.at))} ago)`
    : `the database's position could not be read: ${st.database.error.split("\n")[0]}`;
  rows.push(["position", `${st.position} · ${db}`]);
  rows.push(["slot", slotText(st.slotWal, since)]);
  rows.push(["last change", st.lastBatch === null ? "none applied this run"
    : `committed ${spanText(since(st.lastBatch.committedAt))} ago, applied ${spanText((Date.parse(st.lastBatch.appliedAt) - Date.parse(st.lastBatch.committedAt)) / 1000)} after its commit`]);
  const total = (t: StreamStatus["tables"][number]): number => t.applied.inserts + t.applied.updates + t.applied.deletes + t.applied.truncates;
  for (const t of st.tables) {
    const counts = ` · ${countsText(t.applied)} this run`;
    const c = t.catchUp;
    rows.push([t.table, t.state === "streamed" ? `streamed${counts}`
      : t.state === "catching-up" && c !== undefined
        ? `catching up by one poll ${c.from ? `from ${c.from.slice(0, 16).replace("T", " ")} UTC` : t.why?.replace(/^caught up by one poll /, "") ?? ""}: ` +
          `${c.phase === "queued" ? (c.retryAt ? `its last catch-up failed, tried again after ${c.retryAt.slice(11, 16)} UTC (mason logs says why)` : "waiting its turn") : c.phase === "polling" ? "polling" : "applying what the stream held meanwhile"}` +
          `${c.startedAt ? `, for ${spanText(since(c.startedAt))}` : ""} · the stream holds ${n(c.held)} change${c.held === 1 ? "" : "s"} of it meanwhile${total(t) ? counts : ""}`
      : t.state === "left-out" ? `left out: ${t.why ?? ""}`
      : `not streamed yet: ${t.why ?? ""}${total(t) ? counts : ""}`]);
  }
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`);
}

/**
 * THE WAL THE SLOT HOLDS ON THE DATABASE, in a line (`StreamStatus.slotWal`): how much, Postgres's status of it, and the cap —
 * or, with `max_slot_wal_keep_size` unset, that nothing caps it: while nothing reads the slot it holds WAL for ever, until
 * the database's disk fills (CLAUDE.md "Hard-won gotchas"). A read that failed is said, never a 0.
 */
export function slotText(w: StreamStatus["slotWal"], since: (iso: string) => number): string {
  if ("error" in w) return `the WAL it holds could not be read: ${w.error.split("\n")[0]}`;
  const read = `(read ${spanText(since(w.at))} ago)`;
  if (w.walStatus === "lost") return `lost: Postgres invalidated it (it held more WAL than max_slot_wal_keep_size), so Mason makes it again and catches the synced tables up by one poll ${read}`;
  const cap = w.safeWalSizeBytes === null
    ? "max_slot_wal_keep_size is unset, so nothing caps it: while nothing reads the slot it holds WAL for ever, until the database's disk fills (set max_slot_wal_keep_size on the database)"
    : w.safeWalSizeBytes <= 0 ? "past max_slot_wal_keep_size: Postgres invalidates it at its next checkpoint, and Mason makes it again"
    : `${fileSize(w.safeWalSizeBytes)} more before Postgres invalidates it (max_slot_wal_keep_size)`;
  return `holds ${fileSize(w.walHeldBytes)} of the database's WAL${w.walStatus === null ? "" : ` (${w.walStatus})`} · ${cap} ${read}`;
}

// ------------------------------------------------------------------ mason status

const STATUS_USAGE = `usage: mason status [--json]

  Status: running, not running, or hung — then this project's facts, one a line: its folder, its database and how
  its changes are read, the run and the synced data's file and the synced tables in all (synced, rows, the last sync), the Postgres API
  and how it listens. Then each added table as mason wait shows it, with how it is kept current and when it was last synced
  (sync: off, last synced 3 days ago; polled every 30s, last 4 s ago); the sync's latest failures (mason logs --events
  lists every event) and the latest statements refused, failed or cancelled (mason logs --requests --failed); the Postgres API's statements of the last day and the last week (each outcome, the completed
  ones' average, p50 and p95 time, the rows and bytes sent); the ones it answered slowly in the last day; and the ones it refused or
  failed, each with the reason (mason logs --requests lists every one). With Mason stopped, the same rows say "not
  running", how the last run ended, and the tables are the ones the sources file names. Hung is a run that is alive and does
  not answer its commands (a statement may be holding its main thread): the same rows, and mason stop ends it (exit 1).

    mason status
    mason status --json

  --json   as data: { running, pid, postgres: { url, host, port, database, sslmode (require when it is TLS), shown (the URL with
           <user>:<password> in the credentials' place), psql (its psql line), listener:
           { host (what it is bound to), tls (certificate, self-signed or null), fingerprint } }, source: { name (the
           source's: its sources file's), file (the sources file), shownFile (it from the project's root), url, database, remote, version, standby, changes,
           replication, demo (the demo database this run hosts), textOrder (what reading the database's text order left to say), sync: { default (every table's sync unless its entry
           says its own: off, poll 30s), written (the file's top sync: says it; false: the default) } }, warnings, folder, project, tables: [{ table, rows,
           bytes, key, added, addedColumns, copy, error, kept, sync: { state (synced, syncing, failed, waiting), syncedAt (when
           it was last brought current), syncSeconds (how long that took), syncedBy (copy, poll, catch-up, stream),
           ageSeconds (how long ago that was) }, … }], totals: { added, copied, failed, rows (the synced tables' rows),
           syncedAt (the latest sync of any) }, engine: { file, bytes, keptDays (MASON_HISTORY_DAYS), version (the run's), startedAt,
           uptimeSeconds, restarts (the times its supervisor started the run again: { count, last: { at, why, upSeconds }
           or null }, or { error }) }, disk: { path (where the synced data's file is), freeBytes, copyBytes (the file),
           projectedBytes (what the first syncs running are projected to add; null: none, or too early to say), error },
           sessions: { open (the Postgres API's sessions logged in), byClient: [{ user ('' a token's), client (its
           application_name), open, running }] }, share: (null, or what mason share has open) { port, fingerprint, sessions,
           refusedLogins, droppedConnections, shares: [{ user, role, reads, openedAt, via, host, port, endsAt, state }] }, queries: { keptDays, day, week } (the last day's and the last 7
           days' statements, each { days, covered (the days of it the request log keeps), statements, completed, refused,
           failed, cancelled, rows, bytesSent, durationMs: { avg, p50, p95 } (the completed ones') or null }; { error }
           when it could not be read), slowQueries, refusedQueries, refusedTotal (how many in all), unsupported: [{ gap
           (its entry of docs/SQL-SUPPORT.md), title (what it is; null for an entry this Mason no longer has), runs
           (the statements it refused in the last day), users, clients (application_name), last, example (the latest,
           cut at 1,000 characters) }] (the most refused first: GET /api/unsupported) or { error },
           recentErrors: { sync: [{ at, kind, failed, table, message }] (the latest failures of the sync and restarts,
           newest last: mason logs --events), error (why they could not be read, or null), queries: [{ requestId,
           startedAt, outcome, sqlstate, message, query, … }] (the latest statements refused, failed or cancelled, newest
           last, as mason logs --requests --json shows each: mason logs --requests --failed), queriesError (or null) },
           readiness (what mason wait waits on), ui (whether this run serves the web page: mason ui), served (this is
           mason serve's run: mason ui --ssh opens its page), sourcesReadOnly (why the page offers no Add or Remove, or
           null), next }.
           Each table's kept is how it is kept current now (absent for a table the sync does not hold):
           { by: poll, sync: { mode: off } or { mode: poll, every (30s), seconds } (its entry's sync:, else the file's,
           else off), syncedAt (its last whole read or poll), nextAt (when its next poll is due; null: off, or not polled
           now), pending (only when it applies: why it is not kept current now, its phase included: it waits for
           its first sync, it is being read whole, its first sync failed, it is read again whole, caught up first) }
           or { by: recopy, copiedAt, pending (only when it applies, as the poll's) }
           or { by: replication, slot, state (streamed, catching-up, waiting, left-out), why, position, lastCommit,
           notRunning (why the stream is not running, null when it is) }; with Mason stopped: { running: false, project, source: { name,
           file, url, error (the sources file's problem, or null) }, engine, tables: [{ table }], lastRun, lastStop:
           { at, how } or null, next }; hung: the same with hung: { pid, problem, why },
           exit 1. In replication mode stream: { slot, slotWal: { walHeldBytes (the WAL the slot holds on the
           database), walStatus (reserved, extended, unreserved, lost), safeWalSizeBytes (the WAL left before Postgres
           invalidates it; null: max_slot_wal_keep_size unset, nothing caps it), at } or { error }, publication, running, failure, position,
           applied, database: { lsn, at } or { error }, lag: { bytes, seconds }, lastBatch: { appliedAt, committedAt },
           tables: [{ table, state (streamed, catching-up, waiting, left-out), why, catchUp: { phase (queued, polling,
           applying), from, startedAt, held, retryAt }, applied: { inserts, updates, deletes, truncates } }] }.
           jsonPaths: [{ table, column, steps, either, canonical, asText (false: a path's -> and ->> share it), name,
           state (waiting, backfilling, ready, dropped), rowsTotal, rowsDone, marked, statements, slowestMs, totalMs,
           fill: { rows, bytesPerRow, seconds, basis (measured: from the last fill of its column; disk or text: modelled from
           the column's bytes a row on disk, or its text's before it is on disk), rowsPerSecond } (the fill's estimate it
           was decided on), filled: { rows, seconds } (what its own fill measured), queued (a backfill waiting for the fill
           under way), keptAt, readyAt, why }]. generatedTables: [{ table, file, kind, method (whole: its SQL run again),
           state (refused, waiting, building, failed, current, behind), targetLag, behindSeconds (across its chain: the
           oldest base change below it not in it), behindSince (when that change was committed; null: none), missingTarget, serving,
           lastRun: { at, seconds, rows }, error (the last run's, no value of a row in it), retryAt,
           refusals: [{ key, message, why, options, text }], waitingFor, warnings }]. roles (a run with a roles file, mason/roles.yml: what a user added
           with --role may read): { file, roles: [name], problem (what is wrong with the file now, every statement of a
           user with a role refused while there is; null), default (the role of a user added without --role; null: the
           file names none, and such a user reads nothing), all (the roles of tables: all) }

  In replication mode a Stream section says where the stream is: its position against the database's (bytes behind),
  when the newest change applied was committed and how long after it was applied, and each added table — streamed,
  with the changes applied this run; being caught up by one poll; not streamed yet; or left out — and why.

  Stored JSON paths: a JSON value statements keep reading (payload ->> 'customer_id' read by several statements, or by
  one slow one) is stored as a column of the synced table and read from there, computed once when its row is written instead
  of for every row of every statement; on a table whose fill would take a minute or more, only once the statements
  reading it took a tenth of the fill's estimate in all. The estimate is the rate the last fill of the same JSON
  column measured, once one has run, else modelled from the column's bytes on disk; the line says which. Each path is
  waiting (its fill's cost holds it back: the line says the estimate and what would store it), queued (its column
  added, its fill after the one under way), backfilling (its existing rows being filled, N %) or ready (read from its
  column). MASON_STORE_JSON_PATHS=off turns it off.
`;

export const STATUS: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "status",
  summary: "what Mason is doing: the database, each synced table, the Postgres API, its statements and errors",
  usage: STATUS_USAGE,
  options: { json: { type: "boolean" } },
  json: ["running", "pid", "postgres", "source", "warnings", "folder", "project", "tables", "totals", "engine", "disk", "sessions", "stream", "jsonPaths", "generatedTables", "queries", "slowQueries", "refusedQueries",
    "refusedTotal", "unsupported", "recentErrors", "readiness", "ui", "served", "sourcesReadOnly",
    "roles", "share", "lastRun", "lastStop", "hung", "next"],
};

export async function status(argv: string[]): Promise<number> {
  const f = parseCommand(STATUS, argv);
  if (typeof f === "number") return f;
  const r0 = await theRun(process.cwd());
  // the first line goes straight to the point (Status: running); when the service is not running, the same rows and
  // tables show, with "not running" for each service that is not
  const json = f.values.json === true;
  if ("problem" in r0) {
    if (!r0.project) return failed("status", r0, { json });
    return stoppedStatus(r0.project, json, r0.hung === undefined ? null : { run: r0.hung, problem: r0 });
  }
  const run = r0.run;
  return guarded("status", json, async () => {
    const st = styleOut();
    const read = await readState(run);
    // the name is read at the start, so an edit of the sources file's database: is said here until the run takes it
    const answersAs = postgresLink(run.postgresUrl).database;
    const fileSays = databaseMoved(r0.project, answersAs);
    const s = fileSays !== null
      ? { ...read, warnings: [...read.warnings, `the sources file now says tools connect with ${fileSays}, and this run answers as ${answersAs}: mason stop && mason start takes it`] } : read;
    const r = readiness(s);
    // the statements the Postgres API answered slowly, and the ones it refused, with the reason (src/duck/requests.ts)
    const slowReply = await callRun(run, "GET", "/api/slow");
    const slow = slowReply.status === 200 ? slowReply.body.slow as SlowQuery[] : [];
    const refusedReply = await callRun(run, "GET", "/api/refused");
    const refused = refusedReply.status === 200 ? refusedReply.body.refused as RefusedQuery[] : [];
    const refusedTotal = typeof refusedReply.body.total === "number" ? refusedReply.body.total : null;
    // the same refusals grouped by the unsupported SQL they used (src/duck/gaps.ts): what to rewrite
    const unsupportedReply = await callRun(run, "GET", `/api/unsupported?limit=${STATUS_UNSUPPORTED}`);
    const unsupported: UnsupportedSql[] | { error: string } = unsupportedReply.status === 200 ? unsupportedReply.body.unsupported as UnsupportedSql[]
      : { error: String(unsupportedReply.body.error ?? `the run answered ${unsupportedReply.status}`) };
    // the sync's latest failures (src/duck/events.ts), and the run's restarts among them
    const eventsReply = await callRun(run, "GET", `/api/events?failed=1&limit=${RECENT_ERRORS}`);
    // and the latest statements refused, failed or cancelled: the request log's own page, the shape mason logs --requests --json prints
    const failedReply = await callRun(run, "GET", `/api/requests?failed=1&limit=${RECENT_ERRORS}`);
    const recentErrors: RecentErrors = {
      sync: eventsReply.status === 200 ? eventsReply.body.events as SyncEvent[] : [],
      error: eventsReply.status === 200 ? null : String(eventsReply.body.error ?? `the run answered ${eventsReply.status}`),
      queries: failedReply.status === 200 ? failedReply.body.requests as LedgerRequest[] : [],
      queriesError: failedReply.status === 200 ? null : String(failedReply.body.error ?? `the run answered ${failedReply.status}`),
    };
    // the last day's and week's statements (src/duck/requests.ts summary): asked here, never with the state
    const queriesReply = await callRun(run, "GET", "/api/queries");
    const queries: QuerySummary | { error: string } = queriesReply.status === 200 ? queriesReply.body.queries as QuerySummary
      : { error: String(queriesReply.body.error ?? `the run answered ${queriesReply.status}`) };
    const picked = s.tables.filter((t) => t.added);
    // what to run next, the same for a person and under --json
    const next: NextStep[] = !picked.length ? addSteps(s.tables)
      : r.ready ? [...READY_STEPS]
      : r.failed.length ? [["mason logs", "the detail of each failure"], ["mason wait", "each failure, with the way out"]]
      : [["mason wait", "until it is done"]];
    if (json) {
      out(jsonText(STATUS, { running: true, pid: run.pid,
        ...s, postgres: { ...postgresFacts(run.postgresUrl), listener: run.postgresListener }, queries, slowQueries: slow, refusedQueries: refused, refusedTotal, unsupported, recentErrors, readiness: r }, next));
      return 0;
    }
    const rows: Array<[string, string]> = [
      ["Project", `${run.name}, files in ${s.folder ?? "(none chosen)"}`],
      ...sourceRows(s),
      masonRow(s.engine, run.pid),
      ["Synced data", `${s.engine.file}${s.engine.bytes === null ? "" : ` · ${fileSize(s.engine.bytes)}`}`],
      ...diskRows(s.disk),
      // the copies in all (src/cli/readiness.ts syncTotals): a run from before them has none
      ...(s.totals ? [["Synced tables", totalsText(s.totals)] as [string, string]] : []),
      // the times its supervisor started it again (src/cli/supervise.ts): a run that crashed says so, never only in a log
      ...restartsRows(s.engine.restarts),
      ["Postgres API", `${withPlaceholders(run.postgresUrl)}  (mason user add <name> makes a user)`],
      ...sessionsRows(s.sessions),
      // what it serves: its address, TLS or plain (src/cli/pg-tls.ts)
      ["Listener", listenerText(run.postgresListener, postgresLink(run.postgresUrl).port)],
      ...shareRows(s.share),
      // the web page (mason ui), without its one-time token: mason ui prints the URL that carries it, and opens it
      ...(s.ui === true ? [["Web UI", s.served === true ? "from your machine: mason ui --ssh <user@server>" : `${run.control.url}/  (mason ui opens it)`] as [string, string]] : []),
      // the roles file as the listener reads it now (mason user add --role): its roles, or what is wrong with it
      ...(s.roles && s.roles.file !== null
        ? [["Roles", s.roles.problem !== null ? st.red(`${s.roles.problem} (every statement of a user with a role is refused until it is fixed)`)
          : `${s.roles.roles.join(", ")}  (${s.roles.file}; ${s.roles.default != null ? `default ${s.roles.default} for a user added without --role` : "no default: a user with no role reads nothing"})`] as [string, string]] : []),
      ...s.warnings.map((w) => ["Warning", w] as [string, string]),
    ];
    out(reportText({ headline: `Status: ${st.green("running")}`, details: rows }, st));
    out("");
    if (!picked.length) {
      out(withEnd(`No table added yet (${s.tables.length} in the database).`, { next }));
      return 0;
    }
    if (s.stream) {
      out(st.bold(`Stream (slot ${s.stream.slot}):`));
      for (const l of streamLines(s.stream)) out(`  ${l}`);
      out("");
    }
    out(st.bold(`Tables (${picked.length} of ${s.tables.length} added):`));
    for (const l of tableLines(s)) out(`  ${paintBar(l, st)}`);
    for (const l of syncErrorLines(recentErrors, st)) out(l);
    for (const l of queryErrorLines(recentErrors, st)) out(l);
    for (const l of jsonPathLines(s.jsonPaths ?? [], st)) out(l);
    for (const l of generatedLines(s.generatedTables ?? [], st)) out(l);
    for (const l of queryLines(queries, st)) out(l);
    for (const l of slowLines(slowReply.status === 200 ? slow : { error: String(slowReply.body.error ?? slowReply.status) }, st)) out(l);
    for (const l of refusedLines(refusedReply.status === 200 ? { refused, total: refusedTotal } : { error: String(refusedReply.body.error ?? refusedReply.status) }, st)) out(l);
    for (const l of unsupportedLines(unsupported, st)) out(l);
    out("");
    // the word the web page's Status says too (readinessWord)
    const word = readinessWord(r);
    if (r.ready) out(withEnd(st.green(`${word}: every added table is synced and served.`), { next }));
    else if (r.failed.length) out(withEnd(`${st.red(`${word}:`)}\n${bullets(r.failed)}`, { next }));
    else out(withEnd(`${word}:\n${r.waiting.map((x) => `  - ${x}`).join("\n")}`, { next }));
    return 0;
  });
}

/**
 * mason status's rows for the database the run copies: its sources file, its URL (masked by the run), and how its changes
 * arrive. The web page (src/web/app.js `sourceRows`) says the same rows, held equal by tests/web-page.test.ts.
 */
export function sourceRows(s: Pick<RunState, "source">): Array<[string, string]> {
  return [
    ...(s.source.file ? [["Source", `${s.source.shownFile ?? s.source.file} (the tables it names are added)`] as [string, string]] : []),
    ["Database", s.source.demo ? `the demo database Mason hosts (${s.source.url} · Postgres ${s.source.version})`
      : `${s.source.url} · Postgres ${s.source.version}${s.source.standby ? " · a read replica" : ""}`],
    // in a web developer's words first (each table as its sync: says, streamed as they happen); the mechanism an operator needs in parentheses
    ["Changes", `each table as its sync: says${s.source.replication ? "" : " (a SELECT of its changed rows)"}${s.source.sync ? ` · sync: ${s.source.sync.default} ${s.source.sync.written ? "for every table without its own" : "(the default: the file writes none)"}` : ""} · ` +
      (s.source.replication ? `sync: replication tables streamed as they happen (logical replication: slot ${s.source.replication.slot}, publication ${s.source.replication.publication}, ` +
          `${s.source.replication.owned ? "Mason's own, carrying them alone" : "named: read as it is, never altered"}); the others by a SELECT of their changed rows`
        : s.source.demo ? "the demo database is checked this way only"
        : "sync: replication on an entry streams that table as it happens instead")],
    ...(s.source.textOrder ? [["Text order", s.source.textOrder] as [string, string]] : []),
  ];
}

/** An SQL statement on one line, cut at `max` characters (the whole of it is mason logs --requests --json's). */
export function oneLine(sql: string, max = 100): string {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * mason status's stored JSON paths (src/duck/kept.ts): each one being filled or stored, by table, with why it was
 * stored; the dropped ones counted (mason status --json says why each went).
 */
export function jsonPathLines(paths: readonly KeptPathStatus[], st: Style): string[] {
  const live = paths.filter((p) => p.state !== "dropped").sort((a, b) => Number(a.state === "waiting") - Number(b.state === "waiting"));
  const dropped = paths.length - live.length;
  if (!live.length && !dropped) return [];
  const lines = [`\n${st.bold("Stored JSON paths")} ${st.dim("(read from a column of the synced table, computed once per row written; MASON_STORE_JSON_PATHS=off turns it off)")}:`];
  for (const p of live) {
    const pct = p.rowsTotal > 0 ? Math.min(99, Math.floor((p.rowsDone / p.rowsTotal) * 100)) : 0;
    // a path its fill's cost holds back says so: its why is the decision, with the estimate
    const state = p.state === "ready" ? st.green("ready") : p.state === "waiting" ? st.yellow("waiting")
      : p.queued === true ? `queued, filled after the fill under way (${n(p.rowsTotal)} rows)` : `backfilling ${pct} % (${n(p.rowsDone)} of ${n(p.rowsTotal)} rows)`;
    lines.push(`  ${p.table}  ${pathText(p)}  ${state}  ${st.dim(p.why)}`);
  }
  if (dropped) lines.push(`  ${st.dim(`${dropped} dropped (mason status --json says why)`)}`);
  return lines;
}

/** a generated table's state in the words mason status prints: how it is kept, how far behind, its last run */
function generatedWords(g: GeneratedStatus): string {
  const how = `${g.kind ?? "?"} ${g.method}, target ${g.targetLag ?? "?"}`;
  const last = g.lastRun === null ? "" : `; last re-run ${duration(g.lastRun.seconds)}, ${n(g.lastRun.rows)} row${g.lastRun.rows === 1 ? "" : "s"}`;
  if (g.state === "waiting") return `${how}, waiting for ${g.waitingFor ?? "a table"} to sync`;
  if (g.state === "building") return `${how}, being built`;
  if (g.state === "refused") return g.serving ? `${how}, its file is refused; it keeps serving what it was built from${last}` : "refused";
  const lag = g.behindSeconds === 0 ? "nothing behind" : `${duration(g.behindSeconds)} behind`;
  const missed = g.missingTarget ? ", past its target" : "";
  const failed = g.error === null ? "" : `; its last run failed, tried again at ${g.retryAt ?? "?"}: ${g.error}`;
  return `${how}, ${lag}${missed}${last}${failed}`;
}

/** mason status's generated tables: a line each, and a refused one's reasons and ways out under it, whole */
export function generatedLines(tables: readonly GeneratedStatus[], st: Style): string[] {
  if (tables.length === 0) return [];
  const width = Math.max(...tables.map((g) => entryName(g.table).length));
  const lines = [`\n${st.bold("Generated tables")} ${st.dim("(tables declared in SQL; mason help generated)")}:`];
  for (const g of tables) {
    const words = generatedWords(g);
    const paint = g.state === "refused" || g.state === "failed" || g.missingTarget ? st.red : g.state === "current" ? st.green : g.state === "behind" ? (x: string): string => x : st.yellow;
    lines.push(`  ${entryName(g.table).padEnd(width)}  ${paint(words)}`);
    for (const r of g.refusals) lines.push(...r.text.split("\n").map((l) => `    ${l}`));
    for (const w of g.warnings) lines.push(`    ${st.yellow(w)}`);
  }
  return lines;
}

/** The copies in all, as mason status's `Copies` row says them: `3 of 3 added synced, 1,234 rows, the last synced 5 s ago`. */
export function totalsText(t: SyncTotals, now = Date.now()): string {
  const last = t.syncedAt === null ? "" : `, the last synced ${duration((now - Date.parse(t.syncedAt)) / 1000)} ago`;
  return `${n(t.copied)} of ${n(t.added)} added synced, ${n(t.rows)} row${t.rows === 1 ? "" : "s"}${t.failed ? `, ${n(t.failed)} failed` : ""}${last}`;
}

/** How many of the latest sync failures and failed statements mason status shows (`recentErrors`); mason logs --events and --requests --failed list each. */
export const RECENT_ERRORS = 5;

/**
 * mason status's RECENT ERRORS: the latest failures of the sync (`sync`, src/duck/events.ts, through `/api/events?failed=1`)
 * and the latest statements the Postgres API refused, failed or cancelled (`queries`, the request log's page through
 * `/api/requests?failed=1`, as `mason logs --requests --failed --json` prints them), each with why it could not be read
 * (`error`, `queriesError`) when it could not.
 */
export interface RecentErrors { sync: SyncEvent[]; error: string | null; queries: LedgerRequest[]; queriesError: string | null }

/** One event of the sync on one line (src/duck/events.ts): when, what (a failure in red), its table, its reason's first line. */
export function eventLine(e: SyncEvent, st: Style): string {
  return `${e.at.slice(0, 19).replace("T", " ")}  ${(e.failed ? st.red : st.green)(e.kind.padEnd(18))}  ${e.table ?? "(the sync)"}  ${firstLine(e.message)}`;
}

/** mason status's sync errors: the latest few, a line each, newest last; none, no section. */
export function syncErrorLines(r: RecentErrors, st: Style): string[] {
  if (r.error !== null) return [`\n${st.bold("Sync errors")}: could not read them (${firstLine(r.error)}; mason logs has the detail)`];
  if (!r.sync.length) return [];
  return [`\n${st.bold("Sync errors")} ${st.dim("(the latest, newest last; mason logs --events lists every event)")}:`, ...r.sync.map((e) => `  ${eventLine(e, st)}`)];
}

/** mason status's statement errors: the latest few refused, failed or cancelled, a line each (`requestLine`), newest last; none, no section. */
export function queryErrorLines(r: Pick<RecentErrors, "queries" | "queriesError">, st: Style): string[] {
  if (r.queriesError !== null) return [`\n${st.bold("Query errors")}: could not read them (${firstLine(r.queriesError)}; mason logs has the detail)`];
  if (!r.queries.length) return [];
  return [`\n${st.bold("Query errors")} ${st.dim("(the latest refused, failed or cancelled, newest last; mason logs --requests --failed lists each)")}:`, ...r.queries.map((q) => `  ${requestLine(q, st)}`)];
}

/** Bytes as a person reads them: B, KiB, MiB, GiB (the web page's statements say the same, src/web/shared.js). */
export function bytesText(b: number): string { return b < 1024 ? `${n(b)} B` : fileSize(b); }

/**
 * mason status's queries (src/duck/requests.ts summary): the last day's and the last week's statements, a line each —
 * how many, each outcome, the completed ones' times, the rows and bytes sent — and, when the request log keeps fewer
 * days than the week, that the week is only what it keeps.
 */
export function queryLines(q: QuerySummary | { error: string }, st: Style): string[] {
  if ("error" in q) return [`\n${st.bold("Queries")}: could not read them (${firstLine(q.error)}; mason logs has the detail)`];
  const line = (label: string, w: QueryWindow): string => {
    const counts = `${n(w.statements)} statement${w.statements === 1 ? "" : "s"}: ${n(w.completed)} completed, ${n(w.refused)} refused, ${n(w.failed)} failed, ${n(w.cancelled)} cancelled`;
    const times = w.durationMs === null ? "" : ` · ${msText(w.durationMs.avg)} / ${msText(w.durationMs.p50)} / ${msText(w.durationMs.p95)}`;
    const short = w.covered < w.days ? st.dim(` (the request log keeps ${w.covered} day${w.covered === 1 ? "" : "s"}: MASON_HISTORY_DAYS)`) : "";
    return `  ${label.padEnd(10)}  ${counts}${times} · ${n(w.rows)} rows, ${bytesText(w.bytesSent)} sent${short}`;
  };
  return [`\n${st.bold("Queries")} ${st.dim("(the completed ones' time: average / p50 / p95; mason logs --requests lists each)")}:`, line("last day", q.day), line("last week", q.week)];
}

/** mason status's slow statements (src/duck/requests.ts slow), each on one line with its times. */
export function slowLines(slow: readonly SlowQuery[] | { error: string }, st: Style): string[] {
  if (!Array.isArray(slow)) return [`\n${st.bold("Slow queries")}: could not read them (${firstLine((slow as { error: string }).error)}; mason logs has the detail)`];
  if (!slow.length) return [];
  const lines = [`\n${st.bold("Slow queries")} ${st.dim(`(the last day, still ${(SLOW_MS / 1000).toLocaleString("en-US")} s or more; slowest first)`)}:`];
  for (const q of slow as readonly SlowQuery[]) {
    const times = `${msText(q.latestMs)} last time (${q.runs} run${q.runs === 1 ? "" : "s"}, median ${msText(q.medianMs)})`;
    lines.push(`  ${times}, last ${q.last.slice(0, 16).replace("T", " ")} UTC`, `    ${oneLine(q.payload)}`);
  }
  return lines;
}

/**
 * mason status's refused statements: each distinct one once, newest first, with its SQLSTATE, how often, when last, and
 * the message's first line (the whole of it is mason logs --requests --failed's). `total`: how many in all.
 */
export function refusedLines(r: { refused: readonly RefusedQuery[]; total: number | null } | { error: string }, st: Style): string[] {
  if ("error" in r) return [`\n${st.bold("Refused queries")}: could not read them (${firstLine(r.error)}; mason logs has the detail)`];
  if (!r.refused.length) return [];
  const lines = [`\n${st.bold("Refused queries")} ${st.dim(`(the last day${r.total === null ? "" : `: ${n(r.total)} in all`}, newest first; each message says what to change; mason logs --requests --failed lists each)`)}:`];
  for (const q of r.refused) {
    lines.push(`  ${q.code}, ${q.runs} time${q.runs === 1 ? "" : "s"}, last ${q.last.slice(0, 16).replace("T", " ")} — ${oneLine(q.payload)}`);
    lines.push(`    ${firstLine(q.message)}`);
  }
  return lines;
}

/** how many entries of the unsupported SQL mason status shows (and its --json carries) */
const STATUS_UNSUPPORTED = 5;

/**
 * `Unsupported SQL` in mason status: the last day's refused statements grouped by the registry entry that refused them
 * (src/duck/requests.ts unsupported), the most refused first — how many, what they used, who sent them, and the latest
 * — so a person knows what to rewrite; docs/SQL-SUPPORT.md has each entry's way out. None: no section.
 */
export function unsupportedLines(u: readonly UnsupportedSql[] | { error: string }, st: Style): string[] {
  if ("error" in u) return [`\n${st.bold("Unsupported SQL")}: could not read it (${firstLine(u.error)}; mason logs has the detail)`];
  if (!u.length) return [];
  const lines = [`\n${st.bold("Unsupported SQL")} ${st.dim("(the last day's refused statements by what they used, the most first)")}:`];
  for (const g of u) {
    const title = g.title ?? "SQL this Mason no longer lists";
    const who = [...(g.users.length ? [`as ${g.users.join(", ")}`] : []), ...(g.clients.length ? [`from ${g.clients.join(", ")}`] : [])];
    lines.push(`  ${title}: ${n(g.runs)} statement${g.runs === 1 ? "" : "s"}${who.length ? ` ${who.join(" ")}` : ""}`);
    lines.push(`    last ${g.last.slice(0, 16).replace("T", " ")} — ${oneLine(g.example)}`);
    lines.push(`    How to rewrite it: see docs/SQL-SUPPORT.md › ${title}`);
  }
  return lines;
}

/** A file's size, as a person reads one (mason status's copy, mason usage's) */
export function fileSize(b: number): string {
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`;
}

/** `Mason` in mason status: the run's own version (a CLI of another version says the run's), its pid, and how long it
 *  has been up (a run from before it: the CLI's version, no uptime) */
export function masonRow(e: Pick<RunState["engine"], "version" | "startedAt" | "uptimeSeconds">, pid: number): [string, string] {
  return ["Mason", `${e.version ?? version()}, pid ${pid} · one process${e.startedAt ? ` · up ${spanText(e.uptimeSeconds ?? 0)}, since ${e.startedAt.slice(0, 19).replace("T", " ")} UTC` : ""}`];
}

/** `Sessions` in mason status: how many are logged in to the Postgres API, how many run a statement, and by whom (the
 *  three with the most, then how many others) */
export function sessionsRows(s: SessionsOpen | undefined): Array<[string, string]> {
  if (s === undefined) return [];
  if (s.open === 0) return [["Sessions", "none open"]];
  const running = s.byClient.reduce((n, c) => n + c.running, 0);
  const who = s.byClient.slice(0, 3).map((c) => `${c.open} ${c.user === "" ? "by a token" : `as ${c.user}`}${c.client === "" ? "" : ` (${c.client})`}`);
  const others = s.byClient.length - who.length;
  return [["Sessions", `${s.open} open, ${running} running a statement · ${who.join(", ")}${others > 0 ? `, and ${others} other client${others === 1 ? "" : "s"}` : ""} (mason logs --running lists the statements)`]];
}

/** `Share` in mason status: each share open now (mason share) and what its socket met; no row when none is. */
export function shareRows(s: ShareState | null | undefined, now = Date.now()): Array<[string, string]> {
  if (s === undefined || s === null) return [];
  const each = s.shares.map((h): [string, string] => {
    const where = h.host === null ? "its tunnel is opening" : `${h.host}:${h.port} via ${h.via ?? "a tunnel"}${h.state === "reconnecting" ? " (reconnecting)" : ""}`;
    const ends = h.endsAt === null ? "" : `, ends in about ${Math.max(0, Math.round((Date.parse(h.endsAt) - now) / 60_000))} min`;
    return ["Share", `${where}, as ${h.user}, reads ${h.role === null ? h.reads : `as the role ${h.role}`}${ends}`];
  });
  return [...each, ["Share socket", `127.0.0.1:${s.port}, TLS required, SHA-256 ${s.fingerprint} · ${s.sessions} session${s.sessions === 1 ? "" : "s"}, ${s.refusedLogins} login${s.refusedLogins === 1 ? "" : "s"} refused, ${s.droppedConnections} dropped before a login`]];
}

/** `Disk` in mason status: the bytes free where the synced data is, and what the first syncs running are projected to add (none: no
 *  row, for a run from before it) */
export function diskRows(d: RunState["disk"]): Array<[string, string]> {
  if (d === undefined) return [];
  const adds = d.projectedBytes === null ? "" : ` · the first syncs running are projected to add about ${fileSize(d.projectedBytes)} more`;
  if (d.freeBytes === null) return [["Disk", `${d.error ?? "the free space could not be read"}${adds}`]];
  return [["Disk", `${fileSize(d.freeBytes)} free in ${d.path}${adds}${d.projectedBytes !== null && d.projectedBytes > d.freeBytes ? " — more than is free: the sync stops before the disk fills" : ""}`]];
}

/** `Restarts` in mason status: how many times the run was started again, and the last one's reason (none: no row) —
 *  the run's own `engine.restarts` while it is up, the same fact read from the file while it is not (`restartsFact`) */
export function restartsRows(r: RestartsFact | undefined): Array<[string, string]> {
  if (r === undefined) return [];
  if ("error" in r) return [["Restarts", r.error]];
  if (r.last === null) return [];
  return [["Restarts", `${r.count}, the last ${ago(r.last.at)}: ${r.last.why}, after ${r.last.upSeconds} s up (mason logs --start has its last lines)`]];
}

/**
 * mason status with Mason stopped: the same rows and tables, "not running" where something is not. The
 * database is the sources file's, unchecked; the tables are the ones it names, as nothing reads their copies now — or, when
 * the file cannot be read, what is wrong with it, with the way out (`source.error`).
 * With a run HUNG (alive, a Mason run, silent; src/cli/runs.ts), the same rows say so — never "not running", which is
 * what the test server read while its ports were held — the next step is mason stop, and the exit is 1.
 */
function stoppedStatus(project: Project, json: boolean, hung: { run: DevRun; problem: Problem } | null = null): number {
  const st = styleOut();
  const src = projectSource(project);
  const tables = "message" in src ? [] : src.tables.map((e) => e.table);
  const database = "message" in src ? null : maskedUrl(src.resolved);
  // the name a tool connects with once it starts: null when the file cannot say it (`source.error` says why)
  const connect = projectDatabase(project);
  const connectName = typeof connect === "string" ? connect : null;
  const duckFile = path.join(project.dir, DUCK_FILE);
  // the copy's file, when a run has made one: its size says what the next mason start resumes with
  const bytes = fs.existsSync(duckFile) ? fs.statSync(duckFile).size : null;
  const restarts = restartsFact(project.dir);
  const lastStop = project.config.lastStop ?? null;
  const next: readonly NextStep[] = hung === null ? ("message" in src && src.next?.length ? src.next : [["mason start", "start Mason for this project: what it synced is kept, and polled again"]])
    : hung.problem.next ?? [["mason stop", "end it"], ["mason logs", "what it was doing"]];
  const state = hung === null ? "not running" : "hung";
  if (json) {
    out(jsonText(STATUS, { running: false, ...(hung === null ? {} : { hung: { pid: hung.run.pid, problem: hung.problem.problem, why: hung.problem.why } }),
      postgres: { database: connectName },
      project: { name: project.config.name, folder: project.folder },
      source: { name: "message" in src ? null : src.name, file: "message" in src ? null : src.file, url: database, error: "message" in src ? errorJson(src) : null },
      engine: { file: duckFile, bytes, restarts }, tables: tables.map((table) => ({ table })),
      lastRun: project.config.lastRun ?? null, lastStop }, next));
    return hung === null ? 0 : 1;
  }
  const ended = lastStop === null ? "" : `; ${ago(lastStop.at)}: ${lastStop.how}`;
  out(reportText({ headline: `Status: ${hung === null ? st.yellow(state) : st.red(state)}`, details: [
    ["Project", `${project.config.name}, files in ${project.folder}`],
    ["Source", "message" in src ? `${src.message}${src.fix ? ` — ${src.fix.split("\n")[0]}` : ""}` : src.file],
    ...(database === null ? [] : [["Database", `${database} (not checked: Mason ${hung === null ? "is not running" : "does not answer"})`] as [string, string]]),
    ["Mason", hung === null ? `${version()} · not running${project.config.lastRun ? ` (last started ${ago(project.config.lastRun)}${ended})` : ""}`
      : `${version()}, pid ${hung.run.pid} · running but does not answer its commands: ${hung.problem.why}`],
    ["Synced data", bytes === null ? "none yet (mason start makes it)" : `${duckFile} · ${fileSize(bytes)}`],
    ...restartsRows(restarts),
    ["Postgres API", hung === null ? `not running${connectName === null ? "" : ` (a tool connects with the database ${connectName})`}` : `${withPlaceholders(hung.run.postgresUrl)}  (held by the hung run; it may not answer)`],
  ] }, st));
  out("");
  if (!tables.length) out("No table added yet.");
  else {
    out(st.bold(`Tables (${tables.length} added):`));
    const w = Math.max(...tables.map((m) => m.length));
    for (const m of tables) out(`  ${m.padEnd(w)}  ${st.dim(`${"░".repeat(20)}    —  ${state === "hung" ? "not checked: Mason does not answer" : "not running"}`)}`);
  }
  out(endText({ tips: [], next }, st));
  return hung === null ? 0 : 1;
}

/** How long ago a time was, as mason status says it (`12s ago`, `5 min ago`, `3 h ago`; the web page's `agoText`, held equal) */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

// ------------------------------------------------------------------ mason tables

const TABLES_USAGE = `usage: mason tables [<table>…] [--all] [--json]

  The tables of the database that this user can read, one line each: rows, primary key, whether it is added, and why
  one cannot be added as it is (no primary key: --key names the columns). Name a table for its columns —
  each one's type, what it references, and whether mason add would leave it out as a secret. It reads the project's
  database itself: Mason need not be running.

    mason tables                             every table, one line each
    mason tables orders public.customers     those tables' columns (a table's name alone, or schema.table)
    mason tables --all                       every table with its columns, at once (long)

  --all       every table with its columns, not only the named ones
  --json      as data: { database, source: { name (the source's: its sources file's), file (the sources file) },
              tables: [{ table, rows, bytes, primaryKey, comment, addable,
              reason, added, addedColumns (the columns it syncs: null when not added), copyKey (the key: the sources
              file keys it by, null: its primary key), columns: [{ name, type, nullable, comment, references }] }], next }
`;

export const TABLES: CommandSpec & { needs: "project" } = {
  // the project, not the run (the hands-on review of #451, item 15): what it lists is the database's catalog and the
  // project's sources file, and choosing what to add comes before anything is started
  needs: "project",
  name: "tables",
  summary: "the database's tables: rows, key, whether added; a table's columns and what they reference",
  usage: TABLES_USAGE,
  options: { json: { type: "boolean" }, all: { type: "boolean" } },
  json: ["database", "source", "tables", "next"],
};

export async function tables(argv: string[]): Promise<number> {
  const f = parseCommand(TABLES, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const where = await reach(TABLES, json);
  // (a state with no project never meets the need: reach said it)
  if (where === null || where.project === null) return 1;
  const s = await databaseTables(where.project);
  if ("message" in s) return failed("tables", s, { json });
  let shown = s.tables;
  if (f.positionals.length) {
    shown = [];
    for (const name of f.positionals) {
      const t = findTable(s.tables, name);
      if (!("table" in t)) return failed("tables", t, { json });
      shown.push(t);
    }
  }
  // what to run next: the first table not yet added, as a whole list or as the named tables
  const one = shown.find((t) => !t.added && t.reason === null);
  const next: NextStep[] = f.positionals.length
    ? (one ? [[`mason add ${tableArg(one.table)}`, `sync it into Mason (--columns ${one.columns.slice(0, 2).map((c) => c.name).join(",")}: those only)`]] : [])
    : addSteps(shown, "tables");
  if (json) {
    out(jsonText(TABLES, { database: s.database, source: { name: s.name, file: s.file }, tables: shown.map((t) => ({
      table: t.table, rows: t.rows, bytes: t.bytes, primaryKey: t.key, comment: t.comment,
      addable: t.reason === null, reason: t.reason, added: t.added, addedColumns: t.addedColumns, copyKey: t.copyKey,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, comment: c.comment, references: c.references })),
    })) }, next));
    return 0;
  }
  if (!shown.length) { out(`${s.database} has no table this user can read.`); return 0; }
  // one line per table unless a table is named or --all asks: 54 tables were 600 lines, and choosing what to
  // add needs the names, sizes and keys (an agent read them through --json and python, #409)
  if (!f.positionals.length && !f.values.all) {
    const w = Math.max(...shown.map((t) => t.table.length));
    for (const t of shown) {
      const l = tableFacts(t);
      out(`${t.table.padEnd(w)}  ${l.size.padStart(18)}  ${l.key}${l.state ? `  · ${l.state}` : ""}`);
    }
    out(nextBlock(next));
    return 0;
  }
  for (const t of shown) {
    const size = t.rows === null ? "rows unknown" : `~${n(t.rows)} rows`;
    const added = t.added ? ` · added (${t.addedColumns!.length === t.columns.length ? "every column" : t.addedColumns!.join(", ")}${t.copyKey ? `; keyed by ${t.copyKey.join(", ")}` : ""})` : "";
    out(`${t.table} · ${size}${t.key.length ? ` · key ${t.key.join(", ")}` : ""}${added}`);
    if (t.comment) out(`  ${t.comment}`);
    if (t.reason) out(`  cannot be added as it is: ${t.reason}`);
    const w = Math.max(...t.columns.map((c) => c.name.length));
    const tw = Math.max(...t.columns.map((c) => c.type.length));
    for (const c of t.columns) {
      const notes = [c.nullable ? "" : "not null", c.references ? `→ ${c.references.table}.${c.references.column}` : "",
        looksSecret(c.name) && !t.key.includes(c.name) ? "(looks like a secret: left out unless named)" : "", c.comment ? `-- ${c.comment}` : ""].filter(Boolean);
      out(`  ${c.name.padEnd(w)}  ${c.type.padEnd(tw)}  ${notes.join("  ")}`.trimEnd());
    }
    out("");
  }
  // each table above ends with its blank line: the block's own is left out
  if (next.length) out(nextBlock(next).slice(1));
  return 0;
}

/** A table's line in `mason tables`: its size, its key, and added or why it cannot be added as it is (the web page's
 *  tables say the same, src/web/app.js; tests/web-page.test.ts holds the two equal). */
export function tableFacts(t: CatalogTable): { size: string; key: string; state: string | null } {
  return { size: t.rows === null ? "rows unknown" : `~${n(t.rows)} rows`, key: t.key.length ? `key ${t.key.join(", ")}` : "no key",
    state: t.added ? "added" : t.reason ? `cannot be added as it is: ${t.reason}` : null };
}

/**
 * THE PROJECT'S DATABASE'S CATALOG, READ BY THE COMMAND ITSELF (the hands-on review of #451, item 15: `mason tables`
 * answered "Mason is not running", though it reads only Postgres): the sources file as the run reads it, and the
 * database's catalog (preflight.ts readSourceFacts, what mason start reads) — what `mason tables` lists, and what `mason
 * add` and `mason remove` check an edit against while Mason is down. A file that cannot be read, or a database that does
 * not answer, is said with why and the way out.
 */
async function readCatalog(p: Project): Promise<{ src: ProjectSource; database: string; facts: SourceTable[] } | Failure> {
  const src = projectSource(p);
  if ("message" in src) return src;
  const demo = p.config.demo === true;
  const fix = `change the URL where it is (${src.from}) when the database's password or host changed`;
  const parsed = parseSource(src.resolved);
  if ("problem" in parsed) return { message: `the database's URL (${src.from}): ${parsed.problem}`, code: "bad_source", fix };
  const connected = await connectSource(parsed.source, { demo });
  if ("failure" in connected) {
    // the demo database's way out is its run (src/cli/demo.ts): its hint is the fix, mason start the next command
    if (demo) {
      return { message: `could not connect to ${maskedUrl(parsed.source.url)}: ${connected.failure.message}`, code: "unreachable",
        fix: connected.failure.hints.join("; ") || "mason start hosts the demo database", next: [["mason start", "the demo database and Mason, in the background"]] };
    }
    return { message: `could not connect to ${maskedUrl(parsed.source.url)}: ${connected.failure.message}`, code: "unreachable",
      ...(connected.failure.hints.length ? { why: connected.failure.hints.join("; ") } : {}), fix,
      next: [["mason doctor", "checks the machine and the project's database"]] };
  }
  let facts: SourceFacts;
  try { facts = await readSourceFacts(connected.pg); }
  catch (e) {
    // a catalog this user cannot read (a revoked grant, a server shutting down): said as the database's, never a crash
    return { message: `could not read ${parsed.source.database}'s tables: ${(e as Error).message}`, code: "failed",
      next: [["mason doctor", "checks the machine and the project's database"]] };
  }
  finally { connected.pg.close(); }
  return { src, database: parsed.source.database, facts: facts.tables };
}

/** `mason tables` without the run: the database's tables, each as the run's state says it against the sources file
 *  (sources.ts catalogTable). */
async function databaseTables(p: Project): Promise<{ database: string; name: string; file: string; tables: CatalogTable[] } | Failure> {
  const c = await readCatalog(p);
  if ("message" in c) return c;
  return { database: c.database, name: c.src.name, file: c.src.file, tables: c.facts.map((t) => catalogTable(t, c.src.tables.find((e) => e.table === t.source))) };
}

/**
 * MASON DOWN, `mason add` AND `mason remove` EDIT THE FILE THEMSELVES (the file is the list: `mason init && mason add
 * orders && mason start` is a natural order, and `mason init demo` already writes entries before any run) — through
 * the same check-and-write the run's command server calls (src/cli/source-edit.ts), against the catalog the command
 * reads itself (`readCatalog`), so a refusal is worded alike from both. A run alive and silent (hung) still holds the
 * file: refused, with mason stop as the way out, as is a run that came up since the command looked. Null once the
 * failure is said.
 */
async function withoutRun(cmd: string, p: Project, json: boolean): Promise<{ db: EditCatalog; tables: CatalogTable[]; file: string; edit: () => EditTarget } | null> {
  const st = await runState(p);
  // a hung run is Mason running and not answering: FAILURE_CODES' unreachable
  if (st.kind === "hung") { failed(cmd, { ...asFailure(notAnswering(p, st.run)), code: "unreachable" }, { json }); return null; }
  if (st.kind === "up") {
    failed(cmd, { message: `Mason started for ${p.config.name} while mason ${cmd} ran`, code: "refused", fix: `run mason ${cmd} again: it asks the run, which syncs at once` }, { json });
    return null;
  }
  const c = await readCatalog(p);
  if ("message" in c) { failed(cmd, c, { json }); return null; }
  return { db: { tables: c.facts, database: c.database },
    tables: c.facts.map((t) => catalogTable(t, c.src.tables.find((e) => e.table === t.source))), file: c.src.file,
    edit: () => sourceToEdit(p.folder, p.root, () => projectSource(p)) };
}

/** What an edit answered, as the run's command server answers it: the result, or the refusal's HTTP status and sentence. */
type Edited<T> = { ok: T } | { status: number; error: string };
function edited<T>(f: () => T): Edited<T> {
  try { return { ok: f() }; }
  catch (e) {
    // a refusal is the edit's answer, said as the run's is; anything else is a bug, and goes on up
    if (e instanceof Refusal) return { status: e.status, error: e.message };
    throw e;
  }
}

/** The run's command server's answer, as an edit's (`Edited`): what `/api/pick` or `/api/remove` answered. */
async function viaRun<T>(run: DevRun, route: "/api/pick" | "/api/remove", body: unknown): Promise<Edited<T>> {
  const r = await callRun(run, "POST", route, body);
  return r.status === 200 ? { ok: r.body as unknown as T } : { status: r.status, error: String(r.body.error) };
}

// ------------------------------------------------------------------ mason add

const ADD_USAGE = `usage: mason add <table>… [--columns <column>,…] [--include <column>,…] [--key <column>,…] [--sync <sync>] [--json]

  Syncs tables into Mason: each one is added to the project's sources file (mason/sources/<name>.yml), under tables:
    mason add orders                                    every column:            orders: {}
    mason add orders --columns id,status,total          those columns:           orders: { columns: [id, status, total] }
    mason add orders customers                          several tables, every column of each
    mason add users --include password_hash             every column, and one that looks like a secret
    mason add event_log --key tenant_id,id              a table with no primary key, keyed by those columns
    mason add orders --sync "poll 30s"                  polled every 30 seconds:  orders: { sync: poll 30s }
  A table is its name (orders) or schema.table (billing.invoices). Its primary key is always synced. The rest of the
  file — your comments, other tables — stays as it was.

  After its first sync, a table is kept current as the file's sync: says — at the top for every table (mason init
  writes sync: off: read again only by mason sync <table>), or on its own entry. --sync writes the table's own:
  off, poll <interval> (poll 5s, poll 5m, poll 1h; 1s to 24h), or replication (the database's change log, through
  the project's slot). On a table already added, --sync alone changes its sync: line and nothing else; its synced data is
  kept and caught up by one poll. Without --sync a new entry follows the file's — but a table of more than
  ${BIG_TABLE_ROWS.toLocaleString("en-US")} rows under a file that polls is written sync: off and said, since each poll scans a table whole on your
  database, and a table replication cannot keep (no primary key: --key; REPLICA IDENTITY NOTHING) under a file whose
  sync: is replication is written sync: poll 5m and said. A table of tens of millions of rows set to poll more often
  than every minute is warned of, with an estimate of what each poll costs your database.

  A column that looks like a secret (password, token, api_key, private_key, …) is left out unless named, and said:
  it is written as exclude: [password_hash], since anyone with a user's password can read every synced column. Name
  one with --columns or --include to have it.

  With Mason running the first sync starts at once; mason wait returns when it is done and the table is served. Before
  mason start (mason init && mason add orders && mason start) the entry is written, checked against the database as
  the run checks it, and the first sync begins at mason start. Adding a table again with other columns changes its entry,
  and the table is synced again whole with them.

  --columns <a,b,…>   only these columns (one table at a time: the list is that table's)
  --include <a,b,…>   these columns as well as every other one — a column that looks like a secret, named on purpose
  --key <a,b,…>       for a table with no primary key: the columns that tell its rows apart, which it is keyed by (one
                      table at a time; polled or off: logical replication cannot apply a change by them)
  --sync <sync>       how it is kept current after its first sync, written on its entry: off, "poll 30s" or replication
  --json              as data: { added: [{ table, entry, columns (null: every one), exclude, key, addedKey (key columns
                      added to --columns), skippedSecrets, already (the file said so already), sync: { value (off, poll
                      30s), from (entry: its own sync:, file: the file's, default: off, as the file writes none) },
                      bigOff (it is over ${BIG_TABLE_ROWS.toLocaleString("en-US")} rows and its entry was written sync: off), notReplicated (why
                      its entry was written sync: poll 5m under a file whose sync: is replication, or null), pollCost (an estimate of
                      what a frequent poll of a big table costs your database, or null) } or { table, error }],
                      file (the sources file), error (when a table was not added: { code, message, why }), next };
                      exit 1 when a table could not be added
`;

export const ADD: CommandSpec & { needs: "project" } = {
  // the project, not the run: the sources file is the list, so a table is added before mason start as well as after
  needs: "project",
  name: "add",
  summary: "sync tables into Mason, adding them to the sources file: mason add orders (--columns id,status: those only)",
  usage: ADD_USAGE,
  options: { json: { type: "boolean" }, columns: { type: "string" }, include: { type: "string" }, key: { type: "string" }, sync: { type: "string" } },
  json: ["added", "file", "error", "next"],
};

/** `--sync`, read by the sources file's own grammar (src/lib/table-sync.ts parseSync): a sync, or the usage's problem */
export function addSync(v: string | undefined): TableSync | undefined | string {
  if (v === undefined) return undefined;
  const s = parseSync(v);
  return "problem" in s ? `--sync ${JSON.stringify(v)}: ${s.problem}` : s;
}

/**
 * The tables and the columns each one's entry copies (add takes --columns, not a DSL):
 * `["*"]` for every column, the --columns list for one table, and --include's columns on top of either; `key`, --key's
 * list, for one table. A list names each column once; an empty one is refused.
 */
export function addSpecs(tables: readonly string[], columns: string | undefined, include: string | undefined, key?: string | undefined): Array<{ table: string; columns: string[]; key: string[] | null }> | string {
  if (!tables.length) return "name a table: mason add orders (mason tables lists them)";
  const list = (flag: string, v: string | undefined): string[] | string | null => {
    if (v === undefined) return null;
    const names = v.split(",").map((c) => c.trim()).filter(Boolean);
    return names.length ? [...new Set(names)] : `${flag} names no column: ${flag} id,status`;
  };
  const cols = list("--columns", columns), inc = list("--include", include), keys = list("--key", key);
  if (typeof cols === "string") return cols;
  if (typeof inc === "string") return inc;
  if (typeof keys === "string") return keys;
  if (cols !== null && tables.length > 1) return `--columns is one table's list, and ${tables.length} tables are named: add them one at a time (mason add ${tables[0]} --columns …)`;
  if (keys !== null && tables.length > 1) return `--key is one table's key, and ${tables.length} tables are named: add them one at a time (mason add ${tables[0]} --key …)`;
  const chosen = [...(cols ?? ["*"]), ...(inc ?? []).filter((c) => !(cols ?? []).includes(c))];
  return tables.map((table) => ({ table, columns: chosen, key: keys }));
}

export async function add(argv: string[]): Promise<number> {
  const f = parseCommand(ADD, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const specs = addSpecs(f.positionals, f.values.columns as string | undefined, f.values.include as string | undefined, f.values.key as string | undefined);
  if (typeof specs === "string") return failed("add", { message: specs, code: "usage", usage: ADD_USAGE }, { json });
  const sync = addSync(f.values.sync as string | undefined);
  if (typeof sync === "string") return failed("add", { message: sync, code: "usage", usage: ADD_USAGE }, { json });
  // --sync alone: a table already added keeps its columns and key, and only its sync: line is written
  const keep = sync !== undefined && f.values.columns === undefined && f.values.include === undefined && f.values.key === undefined;
  const how = { ...(sync !== undefined ? { sync } : {}), keep };
  const where = await reach(ADD, json);
  // (a state with no project never meets the need: reach said it)
  if (where === null || where.project === null) return 1;
  if (where.state === "up") {
    // Mason up: the run adds it (the copy starts now, and the run's own re-read never races the file's write)
    const run = where.run;
    return guarded("add", json, async () => {
      const s = await readState(run);
      return addTables({ tables: s.tables, file: s.source.file ?? null,
        pick: (table, columns, key) => viaRun<PickResult>(run, "/api/pick", { table, picked: true, columns, ...(key ? { key } : {}), ...(sync ? { sync: syncText(sync) } : {}), keep }),
        // --sync alone on tables already added: no copy starts (each is caught up by one poll), so wait has nothing to wait for
        next: (n, wereAdded) => keep && wereAdded === n
          ? [["mason status", `${n === 1 ? "its sync and when it was last synced: it is" : "their sync and when each was last synced: each is"} caught up by one poll, never synced again whole`], READY_STEPS[0]!]
          : [["mason wait", `until ${n === 1 ? "its first sync finishes" : "their first syncs finish"} (the sync has started)`], READY_STEPS[0]!] }, specs, json);
    });
  }
  // Mason down: the command writes the entry itself, checked as the run checks it; the copy begins at mason start
  const down = await withoutRun("add", where.project, json);
  if (down === null) return 1;
  return addTables({ tables: down.tables, file: down.file,
    pick: async (table, columns, key) => edited(() => addEntry(down.edit(), down.db, table, columns, key, how)),
    next: () => [["mason start", "Mason in the background, for this project: the first sync of every added table begins"],
      ["mason wait", "then, until every added table is synced and served"]] }, specs, json);
}

/** Where `mason add` adds a table: the database's tables as it names them, the sources file, the one edit, and what to
 *  run once `n` tables are added — the run (Mason up) or the file itself (Mason down). */
interface AddWay {
  tables: ReadonlyArray<Omit<CatalogTable, "columns">>;
  file: string | null;
  pick: (table: string, columns: string[], key: string[] | null) => Promise<Edited<PickResult>>;
  /** what to run once `n` tables are added, `wereAdded` of them named by the file before */
  next: (n: number, wereAdded: number) => NextStep[];
}

/** `mason add`'s checklist and answer, the same whichever way the tables are added (`AddWay`). */
async function addTables(way: AddWay, specs: ReadonlyArray<{ table: string; columns: string[]; key: string[] | null }>, json: boolean): Promise<number> {
  const results: unknown[] = [];
  const added: string[] = [];
  let wereAdded = 0;
  let file: string | null = way.file;
  // the tables that could not be added, each with its reason and code: the command's failure, in the failure shape
  const refused: Array<{ table: string; message: string; code: string }> = [];
  // A CHECKLIST, a line per table (it reads best as a list of completed actions): a spinner
  // while it is added, ✔ with what was written, its notes under it; ✘ with the reason when it could not be
  const st = styleOut();
  const steps = stepRenderer({ line: out, live: !json && process.stdout.isTTY ? { write: (t) => { process.stdout.write(t); } } : null, style: st });
  const note = (text: string): void => { if (!json) steps.print(st.dim(`    ${wrap(text, st.width, 4)}`)); };
  const shown = (p: string): string => { const rel = path.relative(process.cwd(), p); return rel.startsWith("..") ? p : rel; };
  for (const spec of specs) {
    const t = findTable(way.tables, spec.table);
    // a table the database lacks is a failed line of the checklist, its reason under it, like a table Mason refused
    if (!("table" in t)) { refused.push({ table: spec.table, message: t.message, code: t.code }); results.push({ table: spec.table, error: t.message }); if (!json) { steps.begin(`Adding ${spec.table}`); steps.fail(`Adding ${spec.table}`); note(`${t.message}${t.fix ? `: ${t.fix}` : ""}${t.next?.length ? ` (${t.next[0]![0]})` : ""}`); } continue; }
    if (!json) steps.begin(`Adding ${t.table}`);
    const r = await way.pick(t.table, spec.columns, spec.key);
    if (!("ok" in r)) {
      refused.push({ table: t.table, message: r.error, code: r.status === 404 ? "not_found" : "refused" });
      results.push({ table: t.table, error: r.error });
      if (!json) { steps.fail(`Adding ${t.table}`); note(r.error); }
      continue;
    }
    const b = r.ok;
    file = b.file;
    results.push({ table: b.table, entry: b.entry, columns: b.columns, exclude: b.exclude, key: b.key, addedKey: b.addedKey, skippedSecrets: b.skippedSecrets, already: b.already,
      sync: b.sync, bigOff: b.bigOff, notReplicated: b.notReplicated, pollCost: b.pollCost });
    added.push(b.table);
    if (t.added) wereAdded++;
    if (json) continue;
    const l = addedLines(b, shown(b.file));
    steps.done(l.line);
    for (const x of l.notes) note(x);
  }
  const next: NextStep[] = added.length ? way.next(added.length, wereAdded) : [];
  if (refused.length) {
    // A TABLE NOT ADDED IS THE COMMAND'S FAILURE, in the shape every failure has (found by the CLI session test of the private repo:
    // exit 1 with no error, and nothing on stderr): what is wrong, each table's reason, and next — the added ones' too
    const f: Failure = {
      message: specs.length === 1 ? `${refused[0]!.table} was not added` : `${refused.length} of ${specs.length} tables were not added: ${refused.map((x) => x.table).join(", ")}`,
      code: refused.every((x) => x.code === "not_found") ? "not_found" : refused.every((x) => x.code === "usage") ? "usage" : "refused",
      why: refused.map((x) => specs.length === 1 ? x.message : `${x.table}: ${x.message}`).join("; "),
      next: [...next, ["mason tables", "the database's tables, as this user reads them"]],
    };
    if (json) { out(jsonText(ADD, { added: results, file, error: errorJson(f) }, f.next!)); return 1; }
    return failed("add", f, { json: false });
  }
  if (json) out(jsonText(ADD, { added: results, file }, next));
  else out(endText({ next }, st));
  return 0;
}

/** What `mason add` prints for a table added: its line (✔ …), then its notes under it (the web page says the same,
 *  src/web/pages/tables.js; tests/web-page.test.ts holds the two equal). `file` is the sources file as the reader is shown it. */
export function addedLines(b: PickResult, file: string): { line: string; notes: string[] } {
  const copies = b.columns === null ? (b.exclude.length ? `every column but ${b.exclude.join(", ")}` : "every column") : b.columns.join(", ");
  const s = b.skippedSecrets;
  const name = tableArg(b.table);
  // HOW IT IS KEPT CURRENT, always said (issue 33: the default is never met by surprise): the sync: it follows, where it
  // is said, and the one line that changes it — a big table written off, with the alternatives
  const sync = b.bigOff ? `sync: off written on its entry: it has more than ${BIG_TABLE_ROWS.toLocaleString("en-US")} rows, and each poll scans it whole on your database — ` +
      `mason add ${name} --sync "poll 1h" polls it hourly; mason sync ${name} syncs it once, now; mason add ${name} --sync replication keeps it current from the change log`
    : b.notReplicated !== null ? `sync: poll 5m written on its entry, not the file's replication: ${b.notReplicated} — ` +
      `mason add ${name} --sync "poll 1h" polls it hourly; mason add ${name} --sync off reads it only by mason sync ${name}`
    : b.sync.value === "off" ? `sync: off (${b.sync.from === "entry" ? "its entry's" : b.sync.from === "file" ? "the file's" : "the default"}): after its first sync it is read again only by mason sync ${name} — ` +
      `mason add ${name} --sync "poll 5m" polls it every 5 minutes`
    : b.sync.value === "replication" ? `sync: replication (${b.sync.from === "entry" ? "its entry's" : "the file's"}): kept current from the database's change log after its first sync — ` +
      `mason add ${name} --sync "poll 5m" polls it instead`
    : `sync: ${b.sync.value} (${b.sync.from === "entry" ? "its entry's" : "the file's"}): polled every ${b.sync.value.slice("poll ".length)} after its first sync — mason add ${name} --sync off stops that`;
  return { line: `Added ${b.table} to ${file}: ${copies}${b.key ? `, keyed by ${b.key.join(", ")}` : ""}${b.already ? " (already so)" : ""}`, notes: [
    sync,
    ...(b.pollCost !== null ? [b.pollCost] : []),
    ...(b.addedKey.length ? [`key added: ${b.addedKey.join(", ")} (a synced table always has its key)`] : []),
    // a secret is readable by anyone with a user's password: left out, and said, with the way to include one
    ...(s.length ? [`left out ${s.join(", ")}: ${s.length === 1 ? "it looks" : "they look"} like ${s.length === 1 ? "a secret" : "secrets"}, ` +
      `which anyone with a user's password could read (--include ${s[0]} adds it)`] : []),
  ] };
}

// ------------------------------------------------------------------ mason remove

const REMOVE_USAGE = `usage: mason remove <table>… [--json]

  Takes tables out of the project: each one's entry in the sources file (mason/sources/<name>.yml) is removed, the
  rest of the file as it was. With Mason running it stops syncing the table and drops its synced data at once; with Mason
  stopped, what an earlier run synced is dropped at the next mason start.

    mason remove customers
    mason remove customers billing.invoices     several at once

  --json   as data: { removed (the tables, schema.table), file (the sources file), next }
`;

export const REMOVE: CommandSpec & { needs: "project" } = {
  // the project, not the run, as mason add
  needs: "project",
  name: "remove",
  summary: "take tables out of the sources file: mason remove customers (its synced data is dropped)",
  usage: REMOVE_USAGE,
  options: { json: { type: "boolean" } },
  json: ["removed", "file", "next"],
};

export async function remove(argv: string[]): Promise<number> {
  const f = parseCommand(REMOVE, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const names = [...new Set(f.positionals)];
  if (!names.length) return failed("remove", { message: "name a table: mason remove customers (mason status lists the added ones)", code: "usage", usage: REMOVE_USAGE }, { json });
  const where = await reach(REMOVE, json);
  // (a state with no project never meets the need: reach said it)
  if (where === null || where.project === null) return 1;
  if (where.state === "up") {
    // Mason up: the run removes it and drops the copy at once (src/cli/run-server.ts removeTables)
    const run = where.run;
    return guarded("remove", json, async () => removedAnswer(await viaRun<RemoveResult>(run, "/api/remove", { tables: names }), names, true, json));
  }
  // Mason down: the command cuts the entries itself, checked as the run checks them (src/cli/source-edit.ts removeEntries)
  const down = await withoutRun("remove", where.project, json);
  if (down === null) return 1;
  return removedAnswer(edited(() => removeEntries(down.edit(), down.db, names)), names, false, json);
}

/** `mason remove`'s answer, the same whichever way the entries were cut; `running`: Mason is up, and dropped the copies. */
function removedAnswer(r: Edited<RemoveResult>, names: readonly string[], running: boolean, json: boolean): number {
  if (!("ok" in r)) {
    return failed("remove", { message: `${names.join(", ")} ${names.length === 1 ? "was" : "were"} not removed`, code: r.status === 404 ? "not_found" : r.status === 400 ? "usage" : "refused", why: r.error,
      next: [["mason status", "the tables added"]] }, { json });
  }
  const b = r.ok;
  const next: NextStep[] = running ? [["mason status", "the tables left"]]
    : [["mason start", "Mason in the background, for this project: it syncs the tables left"], ["mason status", "the tables left"]];
  if (json) { out(jsonText(REMOVE, { removed: b.removed, file: b.file }, next)); return 0; }
  const rel = path.relative(process.cwd(), b.file);
  out(reportText({ ...removedReport(b.removed, rel.startsWith("..") ? b.file : rel, { running }), next }, styleOut()));
  return 0;
}

/** What `mason remove` prints for the tables removed, `file` the sources file as the reader is shown it (the web page
 *  says the same, src/web/app.js; tests/web-page.test.ts holds the two equal). */
export function removedReport(removed: readonly string[], file: string, o: { running?: boolean } = {}): { headline: string; details: Array<[string, string]>; tips: string[] } {
  const one = removed.length === 1;
  return { headline: `Removed ${removed.join(", ")}`, details: [["from", file]],
    // Mason down (the web page always has a run): a copy an earlier run made is dropped by the next start's sync
    tips: [o.running === false ? `what an earlier run synced of ${one ? "it" : "them"} is dropped at the next mason start`
      : `Mason stops syncing ${one ? "it" : "them"} and drops ${one ? "its synced data" : "their synced data"}`] };
}

// ------------------------------------------------------------------ mason wait

/** An added table as mason wait --json says it: its copy, its error, and how it is kept current, as the run's state has
 *  them (mason status --json's own fields, never derived again here) */
export function waitTable(t: TableState): Pick<TableState, "table" | "copy" | "error" | "kept"> {
  return { table: t.table, copy: t.copy, error: t.error, ...(t.kept ? { kept: t.kept } : {}) };
}

const WAIT_USAGE = `usage: mason wait [<generated table>] [--timeout <seconds>] [--json]

  Waits until every added table is synced and served, showing every added table on a line of its own: 100% for the
  finished (in the order they finished), a bar for the ones still syncing, at the bottom. Run it after mason add.
  Named, a generated table instead: waits until it holds every change Mason had synced when the wait began, across its
  chain (the tables it is generated from, and theirs), so what is read from it next includes them.

    mason add orders && mason wait
    mason wait --timeout 3600     a large table: wait up to an hour
    mason wait daily_requests     a generated table: until it holds what is synced now

  --timeout <seconds>   how long to wait (default 600); the sync goes on after, and mason wait again picks it up
  --json                as data, once it ends: { ready, failed, waiting, timedOut, tables: [{ table, copy, error,
                        kept }] (copy: { phase, rowsCopied, progress: the chunks done, reading and for how long, the
                        rate, the seconds left, while its chunks are read }; kept as mason status --json says it —
                        { by: poll, sync: { mode: off } or { mode: poll, every, seconds }, syncedAt (its last whole read
                        or poll), nextAt (its next poll; null: off) }; kept's pending, when it applies, says why
                        it is not kept current now, its phase included),
                        stream (replication mode: where the stream is, as mason status --json says it), error (on a
                        failure or a timeout: { code, message, next }), next }
                        Named, a generated table: the same ready, failed, waiting, timedOut, error and next, tables
                        empty, and generatedTable (as mason status --json's generatedTables says it: its state,
                        behindSeconds, behindSince — when the oldest change not in it was committed, null: none)

  Exit status: 0 ready; 1 a first sync failed, or the generated table's run failed, or it or a parent was refused
  before it was built (printed, with what to do; Mason tries a failed one again by itself); 124 timed out.
  A generated table that serves and holds everything synced is ready (0) though its last run failed: after editing its
  file, read mason status for whether the new definition was refused or failed.
`;

/** how often a wait not drawn in place says its block again though nothing in it changed, so a long one never goes
 *  quiet: the copies' wait and a generated table's */
export const SAY_AGAIN_MS = 30_000;

/** whether a wait says its block now: what it is changed (`what`, its numbers taken out), or `every` ms went by since it
 *  last said it */
export function sayAgain(what: string, said: string, saidAt: number, now: number, every = SAY_AGAIN_MS): boolean {
  return what !== said || now - saidAt >= every;
}

export const WAIT: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "wait",
  summary: "wait until every added table is synced, or a generated table holds what is synced now (1: a failure)",
  usage: WAIT_USAGE,
  options: { json: { type: "boolean" }, timeout: { type: "string" } },
  json: ["ready", "failed", "waiting", "timedOut", "tables", "stream", "generatedTable", "error", "next"],
};

export async function wait(argv: string[]): Promise<number> {
  const f = parseCommand(WAIT, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const timeout = f.values.timeout === undefined ? 600 : Number(f.values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return failed("wait", { message: `--timeout is a number of seconds, not ${JSON.stringify(f.values.timeout)}`, code: "usage" }, { json });
  if (f.positionals.length > 1) return failed("wait", { message: `name one generated table, not ${f.positionals.length}`, code: "usage", usage: WAIT_USAGE }, { json });
  const named = f.positionals[0];
  const run = await runOr(WAIT, json);
  if (!run) return 1;
  if (named !== undefined) return waitGenerated(run, named, timeout, json);
  return guarded("wait", json, async () => {
    const until = Date.now() + timeout * 1000;
    // a terminal gets the block — every added table on its line (tableLines), then the stream — redrawn in place;
    // anything else (a coding agent's shell, a log) the block when what is under way changes, and every 30 s, so a
    // long copy neither floods it nor goes quiet. Each line ends in a newline, so whatever is printed next (Ready, a
    // failure, a run that stops mid-wait) starts on a line of its own.
    const live = process.stderr.isTTY === true && !json;
    let said = "", saidAt = 0, drawn = 0;
    const fit = (l: string): string => { const w = (process.stderr.columns ?? 120) - 3; return l.length > w ? `${l.slice(0, w - 1)}…` : l; };
    const show = (lines: readonly string[], next: readonly NextStep[] = []): void => {
      if (json || !lines.length) return;
      if (live) {
        // back to the block's first line, each line rewritten and cleared to its end, anything left below cleared; under
        // it, while tables are still at work, what can be run already (the Next section at the bottom while it works,
        // so the tables already complete can be queried) — wrapped at the width by nextBlock itself
        const below = next.length ? nextBlock(next, styleErr()).split("\n") : [];
        process.stderr.write(`${drawn ? `\x1b[${drawn}F` : ""}${lines.map((l) => `\x1b[2K  ${paintBar(fit(l), styleErr())}\n`).join("")}` +
          `${below.map((l) => `\x1b[2K${l}\n`).join("")}\x1b[J`);
        drawn = lines.length + below.reduce((k, l) => k + 1 + (l.match(/\n/g)?.length ?? 0), 0);
        return;
      }
      // the same work, other numbers (a stream's positions included: they move with every change)
      const what = lines.join("\n").replace(/[█░]+/g, "").replace(/\b[0-9A-F]+\/[0-9A-F]+\b/g, "#").replace(/[\d,.]+(%| rows\/s| s| min| h)?/g, "#");
      if (sayAgain(what, said, saidAt, Date.now())) { err(lines.map((l) => `  ${l}`).join("\n")); said = what; saidAt = Date.now(); }
    };
    for (;;) {
      // a copy's rate and progress are the run's own, measured per chunk (src/duck/sync.ts copyProgressNow)
      const s = await readState(run);
      const r = readiness(s);
      const done = r.ready || r.failed.length > 0;
      const picked = s.tables.filter((t) => t.added);
      // the outcome and what to run next, the same for a person and under --json
      const readyNext: NextStep[] = picked.length ? [...READY_STEPS] : addSteps(s.tables);
      const failure: Failure | null = r.failed.length
        ? { message: r.failed.length === 1 ? r.failed[0]! : `${r.failed.length} first syncs failed`, code: "failed", why: r.failed.length === 1 ? undefined : r.failed.join("\n"),
            fix: "Mason tries a failed first sync again by itself; mason logs says why it failed and when it tries next",
            next: [["mason logs", "the detail of each failure"], ["mason status", "the rest of the project"]] }
        : !done && Date.now() >= until
        ? { message: `not ready after ${timeout} s`, code: "timeout", why: r.waiting.join("\n"), fix: "nothing stopped: the syncs go on",
            next: [["mason wait", "keep waiting (--timeout <seconds> for longer)"], ["mason status", "what Mason is doing"]] }
        : null;
      if (json && (done || failure)) {
        out(jsonText(WAIT, { ...r, timedOut: !done, tables: picked.map(waitTable),
          ...(s.stream ? { stream: s.stream } : {}), ...(failure ? { error: errorJson(failure) } : {}) }, failure ? failure.next ?? [] : readyNext));
      }
      // the block as it ends, too: every table at 100% beside Ready (when the last change was not printed yet)
      // while at work: a table already copied can be queried now; the final Next is Ready's, printed once below
      const copied = picked.some((t) => t.copy?.phase === "done");
      const meanwhile: NextStep[] = done ? [] : [...(copied ? [["mason user add <name>", "a user for your BI tool or psql: a synced table can be queried now"] as NextStep] : []), ["mason status", "what Mason is doing"]];
      show([...tableLines(s), ...(s.stream ? ["Stream:", ...streamLines(s.stream).map((l) => `  ${l}`)] : [])], meanwhile);   // done: the meanwhile Next is dropped
      if (r.ready) {
        const head = !picked.length ? "Nothing to wait for: no table added yet." : "Ready: every added table is synced and served.";
        if (!json) out(withEnd(picked.length ? styleOut().green(head) : head, { next: readyNext }));
        return 0;
      }
      if (failure) return json ? (failure.code === "timeout" ? 124 : 1) : failed("wait", failure, { json: false });
      await new Promise((res) => setTimeout(res, 1000));
    }
  });
}

/** `mason wait <generated table>`: until it holds every change synced when the wait began (src/cli/readiness.ts
 *  generatedReadiness), a line when what it waits for changes; the same outcome and exit codes as the wait for copies */
async function waitGenerated(run: DevRun, named: string, timeout: number, json: boolean): Promise<number> {
  return guarded("wait", json, async () => {
    const since = Date.now(), until = since + timeout * 1000;
    let said = "", saidAt = 0;
    for (;;) {
      const s = await readState(run);
      const all = s.generatedTables ?? [];
      const g = all.find((t) => t.table === named) ?? all.find((t) => t.table === `public.${named}`);
      if (g === undefined) {
        const names = all.map((t) => entryName(t.table));
        return failed("wait", { message: `no generated table ${JSON.stringify(named)}${names.length ? "" : ": the project has none"}`, code: "not_found",
          ...(names.length ? { fix: `name one of: ${names.join(", ")}` } : {}), next: [["mason status", "the generated tables and what each is doing"]] }, { json });
      }
      const r = generatedReadiness(g, since);
      const next: NextStep[] = [["mason status", "the generated tables and what each is doing"]];
      const failure: Failure | null = r.failed.length
        ? { message: r.failed[0]!, code: "failed", fix: "Mason tries a failed run again by itself; mason logs says why it failed", next: [["mason logs", "the detail of the failure"], ...next] }
        : !r.ready && Date.now() >= until
        ? { message: `${g.table} does not hold what was synced ${timeout} s ago yet`, code: "timeout", why: r.waiting.join("\n"), fix: "nothing stopped: its runs go on",
            next: [[`mason wait ${entryName(g.table)}`, "keep waiting (--timeout <seconds> for longer)"], ...next] }
        : null;
      if (json && (r.ready || failure)) {
        out(jsonText(WAIT, { ...r, timedOut: !r.ready && failure?.code === "timeout", tables: [], generatedTable: g, ...(failure ? { error: errorJson(failure) } : {}) },
          failure ? failure.next ?? [] : next));
      }
      if (r.ready) {
        if (!json) out(withEnd(styleOut().green(`Ready: ${g.table} holds every change synced when the wait began.`), { next }));
        return 0;
      }
      if (failure) return json ? (failure.code === "timeout" ? 124 : 1) : failed("wait", failure, { json: false });
      const line = r.waiting.join("\n").replace(/\d+ s behind/, "# s behind");
      // when what it waits for changes, and every 30 s while it does not, as the copies' wait says its block
      if (!json && sayAgain(line, said, saidAt, Date.now())) { err(`  ${r.waiting.join("\n  ")}`); said = line; saidAt = Date.now(); }
      await new Promise((res) => setTimeout(res, 1000));
    }
  });
}

// ------------------------------------------------------------------ mason logs

/** What the sync's events leave out, said where they are listed (mason logs --help, the page's Sync events, held equal
 *  by tests/web-page.test.ts): a scheduled poll that succeeds is no event, so a person who synced reads where it is. */
export const EVENTS_LEAVE_OUT = "A scheduled poll that succeeds is not listed: the last one's result is each table's last sync (mason status, the Tables page's Last sync).";

const LOGS_USAGE = `usage: mason logs [-n <lines>] [-f] [--start] [--requests [<filters>]] [--events [--failed]] [--running] [--json]

  The last lines of Mason's log: every sync, poll and statement it ran, warnings and errors with their reasons —
  running or not. With --requests, the run's request log instead: every statement a tool sent the
  Postgres API that Mason answered, and every one it refused, failed or cancelled, a line each, newest last — when, the
  outcome and SQLSTATE, how long, the rows sent, the client's application_name (and the mason user's name), the
  statement and the error's first line; the filters narrow it, and a page that has older rows ends with the line that
  reads them (--before). With --events, the sync's events: each first sync that failed or finished, each poll, catch-up or
  stream that failed, the database out of reach, a table current again, each sync asked by hand (mason sync, the
  page's Sync now) and what it did, and each restart of the run — a line each, newest last (a failure repeated word for
  word is said once an hour). A scheduled poll that succeeds is not listed: the last one's result is each table's last
  sync (mason status, the Tables page's Last sync). Both are kept MASON_HISTORY_DAYS days
  (default 7) in the run's synced data, and read through the running Mason. With --running, the statements running now
  instead, one per session, each with its number (mason cancel <session> --statement <n> stops one).

    mason logs
    mason logs -f                 keep printing new lines as Mason works, until Ctrl-C
    mason logs -n 200 --start     what mason start printed: its steps, and the warnings and errors since
    mason logs --requests --failed -n 20    the last 20 statements refused, failed or cancelled
    mason logs --requests --since 2h --user metabase --outcome failed,cancelled
    mason logs --requests --slow --search orders   the statements over orders that took a second or more
    mason logs --events --failed  the sync's latest failures
    mason logs --running          the statements running now, and their sessions

  -n, --lines <n>  how many lines, or with --requests or --events how many of them (default 40; 1 to 10000 for each)
  -f, --follow     keep printing new lines until Ctrl-C
  --start          mason start's own terminal instead (its steps, then only the warnings and errors)
  --requests       the Postgres API's requests, from the run's request log (Mason must be running)
  --events         the sync's events and the run's restarts (Mason must be running)
  --failed         with --requests: only the ones not answered (refused, failed or cancelled); with --events: only
                   the failures
  --outcome <o,…>  with --requests: only these outcomes — ok, refused (the statement's own fault), failed (Mason's or
                   the machine's), cancelled (a cancel or a statement timeout, SQLSTATE 57014)
  --since <time>   with --requests: started at or after it — an age (30m, 2h, 7d) or an ISO 8601 date or time with
                   its zone (2026-10-28, 2026-10-28T09:00:00Z)
  --until <time>   with --requests: started before it (as --since)
  --user <name>    with --requests: the mason user's statements
  --client <name>  with --requests: the statements of the client whose application_name it is
  --slow           with --requests: only the ones that took ${(SLOW_MS / 1000).toLocaleString("en-US")} s or more (the slow ones mason status lists)
  --search <text>  with --requests: only the statements whose text has it, in any case (at most ${MAX_SEARCH} characters)
  --before <pos>   with --requests: the page before: the position a page answered with (its last Next line)
  --running        the statements running now (Mason must be running)
  --json           as data: { lines: [{ at, text }] } (the log's entries, oldest first; at is null for a line with no
                   time); with --requests { requests: [{ requestId, startedAt, endedAt, session, applicationName,
                   tokenName, user (the mason user), role, attributes (the user's values its role's row filters read, or
                   null), method, outcome (ok, refused, failed, cancelled), status
                   (completed, failed, cancelled: what a reader shows), sqlstate, message, detail, hint, rows,
                   bytesSent, durationMs, query, queryTruncated }], keptDays, before (the position of the page before,
                   or null: none older) }; with --events { events: [{ at, kind (copy_failed, poll_failed,
                   catch_up_failed, stream_failed, source_unreachable, restart, copied, recovered, synced (a sync
                   asked by hand), sync_changed (a table's sync: changed)), failed, table (null: the whole sync),
                   message }], keptDays }; with --running { running: [{ session, user,
                   applicationName, method, startedAt, runningMs, rows (sent so far), query, queryTruncated }] }; next
`;

export const LOGS: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "logs",
  summary: "Mason's log (-f follows it); --requests: the Postgres API's statements; --events: the sync's; --running: running now",
  usage: LOGS_USAGE,
  options: { lines: { type: "string", short: "n" }, follow: { type: "boolean", short: "f" }, start: { type: "boolean" },
    requests: { type: "boolean" }, events: { type: "boolean" }, failed: { type: "boolean" }, outcome: { type: "string" }, since: { type: "string" },
    until: { type: "string" }, user: { type: "string" }, client: { type: "string" }, slow: { type: "boolean" }, search: { type: "string" }, before: { type: "string" }, running: { type: "boolean" }, json: { type: "boolean" } },
  json: ["lines", "requests", "events", "keptDays", "before", "running", "next"],
};

/** the request log's filters as mason logs spells them: -n, --since, … (src/cli/request-filter.ts names each so) */
const flagOf = (k: FilterKey): string => k === "limit" ? "-n" : `--${k}`;
/** the filters of --requests (every one but -n) */
const FILTER_FLAGS = ["failed", "outcome", "since", "until", "user", "client", "slow", "search", "before"] as const;

/**
 * One request of the run's ledger on one line (src/duck/requests.ts): when, the outcome and SQLSTATE, how long,
 * the rows sent, who (application_name, a mason user's name), the statement on one line and the error's first line.
 */
export function requestLine(r: LedgerRequest, st: Style): string {
  const word = r.outcome === "ok" ? "ok" : `${r.outcome} ${r.sqlstate ?? ""}`;
  const paint = r.outcome === "ok" ? st.green : r.outcome === "failed" ? st.red : st.yellow;
  const rows = r.rows === null ? "" : `${n(r.rows)} row${r.rows === 1 ? "" : "s"}`;
  const who = `${r.applicationName || "(no application_name)"}${r.tokenName ? ` (token ${r.tokenName})` : ""}${r.user ? ` (user ${r.user})` : ""}`;
  return `${r.startedAt.slice(0, 19).replace("T", " ")}  ${paint(word.padEnd(15))}  ${msText(r.durationMs).padStart(9)}  ${rows.padStart(11)}  ${who}  ` +
    `${oneLine(r.query, 120) || "(no statement)"}${r.message ? ` — ${firstLine(r.message)}` : ""}`;
}

/** One statement running now on one line (src/api/postgres/server.ts RunningStatement): its session, how long, who, what. */
export function runningLine(r: RunningStatement): string {
  const who = `${r.applicationName || "(no application_name)"}${r.user ? ` (user ${r.user})` : ""}`;
  return `session ${String(r.session).padEnd(5)}  statement ${String(r.statement).padEnd(6)}  ${spanText(r.runningMs / 1000).padStart(8)}  ${`${n(r.rows)} row${r.rows === 1 ? "" : "s"} sent`.padStart(14)}  ${who}  ` +
    `${oneLine(r.query, 120) || "(no statement)"}`;
}

/** The mason logs line that reads the same filters again, a page further back (`before`, the page's cursor). */
function olderPage(q: RequestQuery, before: string): string {
  const quote = (v: string): string => /^[\w.:,~+-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
  const parts = ["mason logs --requests", ...(q.limit !== DEFAULT_REQUEST_LIMIT ? [`-n ${q.limit}`] : [])];
  if (q.failed === true) parts.push("--failed");
  if (q.outcomes !== undefined) parts.push(`--outcome ${q.outcomes.join(",")}`);
  for (const k of ["since", "until", "user", "client"] as const) { const v = q[k]; if (v !== undefined) parts.push(`--${k} ${quote(v)}`); }
  if (q.minMs !== undefined) parts.push("--slow");
  if (q.search !== undefined) parts.push(`--search ${quote(q.search)}`);
  parts.push(`--before ${quote(before)}`);
  return parts.join(" ");
}

/**
 * WHAT THE REQUEST LOG DOES NOT LIST, said where a first statement is looked for (`mason logs --requests` with none, the
 * Queries page; src/web/shared.js, held equal by the tests): a catalog read, a SET or a SHOW is the protocol's chatter —
 * a BI tool sends hundreds as it connects — and is not recorded (src/api/postgres/server.ts `recordRequest`), so a
 * `select 1` typed to test the connection is answered and never appears.
 */
export const UNLISTED_STATEMENTS = "A statement that reads no synced table (select 1, SET, SHOW, a BI tool's catalog queries) is answered but not listed";

/** mason logs --requests: the run's ledger through its command server (one process holds the copy's file) */
async function requestLogs(q: RequestQuery, json: boolean): Promise<number> {
  const r0 = await theRun(process.cwd());
  if ("problem" in r0) return failed("logs", r0, { json });
  return guarded("logs", json, async () => {
    const reply = await callRun(r0.run, "GET", `/api/requests?${requestFilterParams(q).toString()}`);
    if (reply.status !== 200) return failed("logs", runFailure(reply, [["mason status", "the slow and refused queries of the last day"], ["mason logs", "Mason's log"]]), { json });
    const requests = reply.body.requests as LedgerRequest[];
    const keptDays = Number(reply.body.keptDays);
    const before = typeof reply.body.before === "string" ? reply.body.before : null;
    const filtered = q.failed === true || q.outcomes !== undefined || q.since !== undefined || q.until !== undefined || q.user !== undefined || q.client !== undefined ||
      q.minMs !== undefined || q.search !== undefined;
    const next: NextStep[] = [
      ...(before !== null ? [[olderPage(q, before), "the page before this one"] as NextStep] : []),
      ...(filtered ? [["mason logs --requests", "every request, answered or not"] as NextStep] : [["mason logs --requests --failed", "only the ones not answered"] as NextStep]),
      ["mason status", "the last day's and week's statements, and the slow and refused ones grouped"],
    ];
    if (json) { out(jsonText(LOGS, { requests, keptDays, before }, next)); return 0; }
    const st = styleOut();
    if (!requests.length) out(`No ${filtered ? "request that passes the filters" : "request"} in the last ${keptDays} day${keptDays === 1 ? "" : "s"} (MASON_HISTORY_DAYS).`);
    for (const r of requests) out(requestLine(r, st));
    out(endText({ next, ...(!requests.length && !filtered ? { tips: [`${UNLISTED_STATEMENTS}.`] } : {}) }, st));
    return 0;
  });
}

/** mason logs --events: the sync's events and the run's restarts through its command server (src/duck/events.ts) */
async function eventLogs(limit: number, failedOnly: boolean, json: boolean): Promise<number> {
  const r0 = await theRun(process.cwd());
  if ("problem" in r0) return failed("logs", r0, { json });
  return guarded("logs", json, async () => {
    const reply = await callRun(r0.run, "GET", `/api/events?limit=${limit}${failedOnly ? "&failed=1" : ""}`);
    if (reply.status !== 200) {
      return failed("logs", runFailure(reply, [["mason status", "each synced table and its error now"], ["mason logs", "Mason's log, where each event is a line too"]]), { json });
    }
    const events = reply.body.events as SyncEvent[];
    const keptDays = Number(reply.body.keptDays);
    const next: NextStep[] = failedOnly ? [["mason logs --events", "every event, the first syncs finished and the tables current again too"], ["mason status", "each synced table and its error now"]]
      : [["mason logs --events --failed", "only the failures"], ["mason status", "each synced table and its error now"]];
    if (json) { out(jsonText(LOGS, { events, keptDays }, next)); return 0; }
    const st = styleOut();
    if (!events.length) out(`No ${failedOnly ? "sync failure" : "sync event"} in the last ${keptDays} day${keptDays === 1 ? "" : "s"} (MASON_HISTORY_DAYS).`);
    for (const e of events) out(eventLine(e, st));
    out(endText({ next }, st));
    return 0;
  });
}

/** mason logs --running: the statements the listener runs now, through the run's command server */
async function runningLogs(json: boolean): Promise<number> {
  const r0 = await theRun(process.cwd());
  if ("problem" in r0) return failed("logs", r0, { json });
  return guarded("logs", json, async () => {
    const reply = await callRun(r0.run, "GET", "/api/running");
    if (reply.status !== 200) return failed("logs", runFailure(reply, [["mason logs", "Mason's log"]]), { json });
    const running = reply.body.running as RunningStatement[];
    const next: NextStep[] = running.length
      ? [[`mason cancel ${running[0]!.session} --statement ${running[0]!.statement}`, "stop a session's statement, as a client's cancel does"], ["mason logs --requests", "the statements answered, refused and cancelled"]]
      : [["mason logs --requests", "the statements answered, refused and cancelled"]];
    if (json) { out(jsonText(LOGS, { running }, next)); return 0; }
    const st = styleOut();
    out(running.length ? st.bold(`Running now (${running.length}):`) : "No statement is running now.");
    for (const r of running) out(`  ${runningLine(r)}`);
    out(endText({ next }, st));
    return 0;
  });
}

/** A refusal the run answered, in the Failure shape it carries (`failure`, src/cli/run-server.ts sendFailure). */
export function runFailure(reply: { status: number; body: Record<string, unknown> }, next: readonly NextStep[]): Failure {
  const f = reply.body.failure as { code?: unknown; message?: unknown; why?: unknown; fix?: unknown } | undefined;
  const code = typeof f?.code === "string" ? f.code : reply.status === 400 ? "usage" : reply.status === 404 ? "not_found" : reply.status === 409 ? "refused" : "failed";
  return { message: typeof f?.message === "string" ? f.message : String(reply.body.error ?? `the run answered ${reply.status}`), code,
    ...(typeof f?.why === "string" ? { why: f.why } : {}), ...(typeof f?.fix === "string" ? { fix: f.fix } : {}), next };
}

export async function logs(argv: string[]): Promise<number> {
  const f = parseCommand(LOGS, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.values.requests && f.values.events) return failed("logs", { message: "--requests and --events are two lists: ask for one", code: "usage", fix: "mason logs --requests, or mason logs --events" }, { json });
  if (f.values.failed && !f.values.requests && !f.values.events) return failed("logs", { message: "--failed is a filter of --requests or --events", code: "usage", fix: "mason logs --requests --failed, or mason logs --events --failed" }, { json });
  // the request log's own filters (--failed is --events' too)
  const filter = FILTER_FLAGS.find((k) => k !== "failed" && f.values[k] !== undefined);
  if (filter !== undefined && !f.values.requests) {
    return failed("logs", { message: `--${filter} is a filter of --requests`, code: "usage", fix: `mason logs --requests --${filter} …` }, { json });
  }
  if (f.values.running && (f.values.requests || f.values.events || f.values.start || f.values.follow)) {
    const other = f.values.requests ? "--requests" : f.values.events ? "--events" : f.values.start ? "--start" : "-f";
    const whose = other === "--requests" ? "the request log's" : other === "--events" ? "the sync's events'" : "the log file's";
    return failed("logs", { message: `--running lists the statements running now; ${other} is ${whose}`, code: "usage", fix: `mason logs --running, or mason logs ${other}` }, { json });
  }
  if (f.values.running && f.values.lines !== undefined) {
    return failed("logs", { message: "--running lists every statement running now: -n (--lines) does not apply to it", code: "usage", fix: "mason logs --running" }, { json });
  }
  if (f.values.requests && (f.values.start || f.values.follow)) return failed("logs", { message: `--requests lists the request log; ${f.values.start ? "--start" : "-f"} is the log file's`, code: "usage", fix: "mason logs --requests, or mason logs " + (f.values.start ? "--start" : "-f") }, { json });
  if (f.values.events && (f.values.start || f.values.follow)) return failed("logs", { message: `--events lists the sync's events; ${f.values.start ? "--start" : "-f"} is the log file's`, code: "usage", fix: "mason logs --events, or mason logs " + (f.values.start ? "--start" : "-f") }, { json });
  if (json && f.values.follow) return failed("logs", { message: "-f prints lines as they come, and --json is one answer", code: "usage", fix: "mason logs --json, or mason logs -f" }, { json });
  if (f.values.running) return runningLogs(json);
  if (f.values.requests) {
    // the filters, read as the run reads its query string (src/cli/request-filter.ts): a mistake is said here, exit 2
    const text = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
    const q = requestFilter({ limit: text(f.values.lines), failed: f.values.failed === true, outcome: text(f.values.outcome), since: text(f.values.since),
      until: text(f.values.until), user: text(f.values.user), client: text(f.values.client),
      slow: f.values.slow === true, search: text(f.values.search), before: text(f.values.before) }, Date.now(), flagOf);
    if ("message" in q) return failed("logs", { ...q, usage: LOGS_USAGE }, { json });
    return requestLogs(q, json);
  }
  const lines = f.values.lines === undefined ? 40 : Number(f.values.lines);
  if (!Number.isInteger(lines) || lines < 0) return failed("logs", { message: `-n (--lines) is a number of lines, not ${JSON.stringify(f.values.lines)}`, code: "usage" }, { json });
  if (f.values.events) {
    const limit = eventLimit(typeof f.values.lines === "string" ? f.values.lines : undefined, "-n");
    if (typeof limit !== "number") return failed("logs", { ...limit, usage: LOGS_USAGE }, { json });
    return eventLogs(limit, f.values.failed === true, json);
  }
  // a stopped run's log is still worth reading: the project's, running or not
  const t = theProject(process.cwd());
  if ("problem" in t) return failed("logs", t, { json });
  // the run's log by default (mason logs once showed no actual logs: it showed
  // mason start's terminal, which after the start carries only warnings and errors)
  const file = path.join(t.project.dir, f.values.start ? "dev.log" : "mason.log");
  if (!fs.existsSync(file)) {
    return failed("logs", { message: `${file} does not exist yet`, code: "nothing_yet", why: `Mason has not run for ${t.project.config.name}`, next: [["mason start", "start it, in the background"]] }, { json });
  }
  const text = fs.readFileSync(file, "utf8");
  // WHY THE FILE, even with the run up: it is the whole record (the run's memory keeps only its last LOG_KEPT entries,
  // src/lib/log-buffer.ts) and the only one when the run is down. The entries are parsed by the buffer's own parser, so
  // `{ at, text }` is the shape of GET /api/logs too (the run's answer, which a `mason serve` run has no file for).
  // -n counts entries, a multi-line one being ONE; dev.log's lines (the start's steps, indented under each other) are a line each.
  const all = logEntries(text, { perLine: f.values.start === true });
  const last = all.slice(Math.max(0, all.length - lines));
  if (json) { out(jsonText(LOGS, { lines: last }, [["mason logs --requests", "every statement the Postgres API met"]])); return 0; }
  for (const l of last) out(logLineText(l));
  if (!f.values.follow) return 0;
  let offset = Buffer.byteLength(text);
  for (;;) {
    await new Promise((res) => setTimeout(res, 500));
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0;   // a new run started the file over
    if (size === offset) continue;
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    process.stdout.write(buf.toString());
  }
}

// ------------------------------------------------------------------ mason stop

const STOP_USAGE = `usage: mason stop [--json]

  Stops Mason for this folder's project. The synced data and Mason's state stay: the next mason start resumes
  in seconds, reading only what changed.

    mason stop

  mason destroy removes the synced data and the state too (your files stay), to free the disk or begin again.

  --json    as data: { stopped: [name], killed (a run that did not answer and ignored SIGTERM), supervisor (its pid, when one was stopped), next }
`;

export const STOP: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "stop",
  summary: "stop Mason for this folder's project (the synced data stays: the next mason start resumes)",
  usage: STOP_USAGE,
  options: { json: { type: "boolean" } },
  json: ["stopped", "killed", "supervisor", "next"],
};

export async function stop(argv: string[]): Promise<number> {
  const f = parseCommand(STOP, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const next: NextStep[] = [["mason start", "resume, in seconds (in the project's folder)"], ["mason destroy", "remove its synced data and its state; your files stay"]];
  const r = await theRun(process.cwd());
  if ("problem" in r && r.hung !== undefined) {
    // A RUN THAT DOES NOT ANSWER (src/cli/runs.ts "alive and silent"): its supervisor first, so it is not started again
    // over the kill, then SIGTERM and, after the grace, SIGKILL; the run could not record that it stopped, so stop does
    const hung = r.hung;
    if (!json) err(styleErr().dim(`  Mason for ${hung.name} (pid ${hung.pid}) does not answer: stopping it (SIGKILL after ${END_GRACE_MS / 1000} s) …`));
    // the supervisor is told BEFORE the run dies (it waits for the run, so it cannot leave yet): the run's exit is then a
    // stop to it, never a crash to record and restart from (found on the test server)
    const sup = signalSupervisor(r.project!.dir);
    const { killed } = await endRun(hung.pid);
    if (sup !== null) await supervisorGone(r.project!.dir, sup);
    const how = killed ? `it did not answer its commands and ignored SIGTERM for ${END_GRACE_MS / 1000} s, so it was killed` : "it did not answer its commands and left on SIGTERM";
    const recorded = readProject(hung.root);
    // what the run could not record: that it stopped, and how (mason status shows it once it is gone)
    if (isProject(recorded)) { recorded.config.running = null; recorded.config.lastStop = { at: new Date().toISOString(), how: `${killed ? "killed by mason stop (SIGKILL)" : "stopped by mason stop (SIGTERM)"}: ${how.replace(/, so it was killed$/, "")}` }; writeConfig(recorded.dir, recorded.config); }
    if (json) { out(jsonText(STOP, { stopped: [hung.name], killed, supervisor: sup }, next)); return 0; }
    out(reportText({ headline: `Stopped ${hung.name}`, details: [["how", `${how}${sup === null ? "" : `; its supervisor (pid ${sup}) will not start it again`}`],
      ["kept", "its synced data and its state (it recovers from its write-ahead log at the next start)"], ["log", "mason logs shows what it was doing"]] }));
    out(endText({ next }));
    return 0;
  }
  if ("problem" in r) {
    // not running is what stop wants: said, exit 0; no project here is a wrong place, exit 1
    if (r.project) {
      // a run that crashed is dead while its supervisor waits to start it again: the supervisor is what stops then
      const sup = await stopSupervisor(r.project.dir);
      if (sup !== null) {
        if (json) out(jsonText(STOP, { stopped: [r.project.config.name] }, next));
        else out(withEnd(`Stopped Mason for ${r.project.config.name}: it was between restarts, and its supervisor (pid ${sup}) will not start it again.`, { next }));
        return 0;
      }
      if (json) out(jsonText(STOP, { stopped: [] }, next.slice(0, 1))); else out(withEnd(`Mason is not running for ${r.project.config.name}.`, { next: next.slice(0, 1) }));
      return 0;
    }
    return failed("stop", r, { json });
  }
  const run = r.run;
  process.kill(run.pid, "SIGTERM");
  if (!json) err(styleErr().dim(`  stopping Mason for ${run.name} (pid ${run.pid}) …`));
  // it closes the Postgres API, ends the poll or the stream, and closes its copy
  const until = Date.now() + 90_000;
  while (alive(run.pid) && Date.now() < until) await new Promise((res) => setTimeout(res, 250));
  if (alive(run.pid)) return failed("stop", { message: `Mason for ${run.name} (pid ${run.pid}) is still running after 90 s`, code: "failed", next: [["mason logs", "what it is doing"]] }, { json });
  // a replication slot outlives the run that reads it, and holds the database's WAL meanwhile: said where it is left
  const recorded = readProject(run.root);
  // what a start made on the database, as it recorded it (src/cli/dev.ts): a project none of whose tables is replicated has none
  const replicating = isProject(recorded) && (recorded.config.replication ?? null) !== null;
  const named = isProject(recorded) ? recorded.config.publication ?? null : null;
  // a demo project's database (src/cli/demo.ts) stays too, as the copy does: said where a person reads the stop
  const demo = isProject(recorded) && recorded.config.demo === true;
  if (json) { out(jsonText(STOP, { stopped: [run.name] }, next)); return 0; }
  out(reportText({ headline: `Stopped ${run.name}`, details: [["kept", `its synced data and its state${demo ? ` and the demo database (${STATE_DIR}/${DEMO_DIR})` : ""}`],
    ...(replicating ? [["slot", `its replication slot stays on the database, holding WAL until the next mason start (mason destroy drops it)`] as const,
      ["publication", named ? `${named}, its owner's: read as it is, never altered (mason destroy leaves it)` : "Mason's own (mason destroy drops it)"] as const] : [])] }));
  out(endText({ next }));
  return 0;
}
