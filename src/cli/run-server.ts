/**
 * THE RUN'S COMMAND SERVER (`mason start`; a server for the `mason` command alone, the CLI's UI part dropped
 * completely). `mason status`, `mason wait`, `mason sync`, `mason logs --requests`, and `mason add` and `mason remove`
 * while it is up, ask it (src/cli/control.ts): it reads the database's catalog, writes the tables added and removed into
 * the project's sources file (src/cli/source-edit.ts, the check-and-write the commands call themselves while Mason is
 * down) — the sync, told of the change, starts copying a table at once — and says where everything is.
 *
 * Every request passes the run's guard (src/cli/security.ts): loopback, the Host header, and the run's token, which
 * the commands send as `Authorization: Bearer` from the run's settings file.
 *
 * What it knows it reads where the run keeps it: the copies from the sync (src/duck/sync.ts), the statements from the
 * request log (src/duck/requests.ts). Added is a fact about the project's files: a table is added when its sources file
 * names it.
 *
 * THE WEB PAGE (src/web/, `mason ui`, docs/WEB-UI.md): under `mason start` it also serves one page and its files (the
 * shell, its pages' modules, the stylesheet), from an allowlist read when it starts (`pageFiles`), and the users the
 * page manages (`/api/users`, the functions `mason user` calls). The page reads the same JSON the commands read; a refusal carries `failure`, the CLI's Failure
 * shape (message, why, fix, next), so the page says it as the command would. `mason serve`'s run serves no page.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, sendJson } from "../lib/http-json.ts";
import { projectFingerprint } from "../lib/project-files.ts";
import { guard, SECURITY_HEADERS } from "./security.ts";
import { maskedUrl, type Source, type SourceFacts } from "./preflight.ts";
import { errorJson, nextJson, type Failure, type NextStep } from "./command.ts";
import { phaseCounts, readiness, syncTotals, tableSync, type SyncFacts, type SyncTotals } from "./readiness.ts";
import { restartsFact, type Restart } from "./supervise.ts";
import { withRestarts, type SyncEvents } from "../duck/events.ts";
import { NO_ROLES, type RolesLive } from "../duck/grants.ts";
import { addedNext, addUser, disabledNext, disableUser, enabledNext, enableUser, listUsers, removeUser, REMOVED_NEXT, roleToAdd, withLastUsed } from "./user.ts";
import { postgresFacts, postgresLink } from "./pg-url.ts";
import { catalogTable, parseSourceText, shownPath, type CatalogColumn, type ProjectSource, type SourceFile } from "./sources.ts";
import { addEntry, Refusal, removeEntries, sourceToEdit, type EditCatalog, type EditTarget, type PickResult, type PollMeasure, type RemoveResult } from "./source-edit.ts";
import { PollRefused, type CopyState, type DiskStatus, type PolledTable, type StreamedAnswer, type StreamStatus } from "../duck/sync.ts";
import { DEFAULT_SYNC, parseSync, syncText, type TableSync } from "../lib/table-sync.ts";
import type { LogBuffer } from "../lib/log-buffer.ts";
import type { ClientActivity, LedgerRequest, QueryWindow, RequestLedger, UnsupportedSql } from "../duck/requests.ts";
import { eventLimit, requestFilter, requestFilterText, SLOW_MS, timeOf } from "./request-filter.ts";
import type { PgApiServer } from "../api/postgres/server.ts";
import type { RunShares, ShareTunnel } from "./share-run.ts";
import type { KeptPathStatus } from "../duck/kept.ts";
import type { CopySize, UsageFacts, UsageSample, UsageSampler } from "../duck/usage.ts";
import { FRESH_SAMPLES, type RunMetrics } from "./metrics.ts";

/** A statement answered in this many milliseconds or more is slow (one constant: src/cli/request-filter.ts SLOW_MS, the
 *  request log's `slow` filter's too): what mason status lists (src/duck/requests.ts slow). */
export { SLOW_MS };

export interface RunContext {
  source: Source;
  facts: () => SourceFacts;
  warnings: string[];
  /** the slot and publication the run streams through NOW (src/cli/replication-mode.ts; `owned`: the publication is
   *  Mason's own, else the operator named it, only read), or null while no table's sync is replication (src/duck/sync.ts
   *  `streams`): it changes as the sources file does */
  replication: () => { slot: string; publication: string; owned: boolean } | null;
  port: number;
  token: string;
  /** the web page (src/web/, `mason ui`): `mason start`'s run serves it, `mason serve`'s never (its guard is loopback's
   *  Host and cookie; off loopback the page would need TLS and a login, which are not designed) */
  page: boolean;
  /** the project's database is the demo database this run hosts (`mason init demo`, src/cli/demo.ts): mason status says so */
  demo?: boolean;
  /** the project's users (src/cli/user.ts): what `/api/users` lists and changes, with the functions `mason user` calls —
   *  the list (.mason/users.json), the API key their passwords are made with, the database a user connects to, and
   *  where the Postgres API listens (the run's recorded URL), for the URL an added user is shown */
  users: { file: string; apiKey: string; database: string; postgresUrl: string };
  /** the project's roles as the listener holds them now (src/cli/roles.ts LiveRoles): what `mason user add --role`
   *  is checked against while the run is up, and what `/api/state` says of them; absent: a run with no roles file */
  roles?: () => RolesLive;
  /** what `mason share` opens (src/cli/share-run.ts): mason start's run alone; a server has an address of its own */
  shares?: RunShares;
  /** the project's folder (sources/, mason.yml) */
  folder: () => string | null;
  /** the project's root (where .mason/ is): what messages name files from */
  root: string;
  /** the run's own folder (.mason/): where its supervisor records its restarts */
  home: string;
  /** the run's version (src/cli/version.ts) and when this process started, ms: `engine.version`, `startedAt`, uptime */
  version: string;
  startedAt: number;
  /** the sources file the run copies from as it last read it, and what is wrong with it now (null: nothing) */
  sources: () => { file: SourceFile | null; problem: string | null };
  /** the sources file changed (a table added or removed): the run reads it again */
  sourcesChanged: () => void;
  /** a sources file that replicates a table, held to the database's checks for logical replication when this run never
   *  made them (it replicated nothing when it started): the refusal, or null when it may (absent: never refused) */
  checkReplication?: (file: SourceFile) => Promise<Failure | null>;
  /** the sources file read as the run reads it, its URL resolved (src/cli/sources.ts readSource) */
  readSource: () => ProjectSource | Failure;
  /** the database's URL the run copies from, as the sources file resolved it at the start */
  runUrl: string;
  log: (m: string) => void;
  /** the run's last log entries (src/lib/log-buffer.ts), fed by the one writer of its log: `/api/logs` */
  logs: Pick<LogBuffer, "recent" | "capacity">;
  /** the Postgres listener: the statements running now, and a cancel of one (`/api/running`, `POST /api/cancel`) */
  listener: Pick<PgApiServer, "running" | "cancel" | "openSessions">;
  /** the run's copy: each added table's copy as the sync has it (how each is kept current: its `kept`), the file it is in */
  duck: { copies: () => CopyState[]; file: string;
    /** a poll of exactly these tables, now (mason sync; src/duck/sync.ts pollNow); in replication mode none, and where the
     *  stream is (`streamed`) */
    poll: (sources: string[]) => Promise<{ at: string; tables: PolledTable[]; streamed?: StreamedAnswer[] }>;
    /** where the replication stream is (src/duck/sync.ts streamStatus): null outside replication mode; `refresh: false`
     *  never reaches the database (the position and the slot as last read) */
    stream: (o?: { refresh?: boolean }) => Promise<StreamStatus | null>;
    /** the disk the copy's file is on: free, and what the first syncs running are projected to add (src/duck/sync.ts diskStatus) */
    disk: () => DiskStatus;
    /** what the run measured of a table, for mason add's estimate of a poll's cost (src/duck/sync.ts measured) */
    measured?: (table: string) => PollMeasure | null;
    /** the Postgres listener's requests (src/duck/requests.ts, `_mason.requests`): mason status and mason logs --requests */
    requests: Pick<RequestLedger, "page" | "slow" | "refused" | "unsupported" | "summary" | "window" | "clients" | "slowest" | "durationsBy" | "days" | "lastUsed">;
    /** the sync's failures and notable events (src/duck/events.ts, `_mason.sync_events`): mason logs --events, mason status */
    events: Pick<SyncEvents, "recent" | "days">;
    /** usage over time (src/duck/usage.ts, `_mason.usage`): mason usage */
    usage: Pick<UsageSampler, "samples" | "copySizes" | "days" | "sampleSeconds" | "statementTotals" | "lastDurations">;
    /** the run's restarts, as its supervisor records them in `.mason/restarts.json` (src/cli/supervise.ts readRestarts:
     *  a file that cannot be read throws, said as the request's failure); merged with the events */
    restarts: () => Restart[];
    /** the JSON paths stored as columns of the copies, and how far each is (src/duck/kept.ts): mason status */
    jsonPaths?: () => KeptPathStatus[] };
}

/** the request log's shapes (src/duck/requests.ts), as mason status reads them */
export type { RefusedQuery, SlowQuery } from "../duck/requests.ts";

/**
 * The run's state, in the shape mason status / wait read (`RunState`, src/cli/commands.ts): each table of the database,
 * added or not, and each added one's copy as the sync has it, so `mason wait` is ready exactly when every added table is
 * copied. LEAN unless `columns` is asked: each table's columns are most of its bytes (800 tables of 50 columns, 3.4 MB
 * with them, 0.3 MB without), and the page polls the state every 2 s for none of them — its Columns… form reads one
 * table's on opening (`GET /api/tables/<table>/columns`, `tableColumns`); `mason status --json` asks with them
 * (`?columns=1`), its shape unchanged. One computation either way: the columns are left out, never built apart.
 */
export function runState(ctx: RunContext, copies: readonly CopyState[], stream: StreamStatus | null, now = Date.now(), { columns = false }: { columns?: boolean } = {}): unknown {
  const folder = ctx.folder();
  const sources = ctx.sources();
  const by = new Map(copies.map((c) => [c.source, c]));
  const project = folder && fs.existsSync(folder) ? projectFingerprint(folder) : null;
  const facts = ctx.facts();
  const repl = ctx.replication();
  const bytes = fileBytes(ctx.duck.file);
  const disk = ctx.duck.disk();
  const tables = facts.tables.map((t) => {
    const c = by.get(t.source), entry = sources.file?.tables.find((e) => e.table === t.source);
    const { columns: cols, ...catalog } = catalogTable(t, entry);
    return {
      ...catalog, ...(columns ? { columns: cols } : {}),
      // a table the sync has not reached is waiting for its copy (no copy yet), never "copying 0"
      // a copy in a retired layout (src/duck/sync.ts RETIRED_LAYOUT) serves until it is copied again: done, and said
      copy: c && c.phase !== "waiting" ? { phase: (c.phase === "copied" ? "done" : c.phase === "failed" ? "failed" : "copying") as "copying" | "done" | "failed",
        rowsCopied: c.phase === "copied" ? c.rows ?? 0 : c.rowsSoFar ?? 0, updatedAt: c.copiedAt ?? "",
        // while its chunks are read: the chunks done and reading, the measured rate, the time left (src/duck/sync.ts
        // copyProgressNow), so mason wait and status move between two commits
        ...(c.phase === "copying" && c.progress !== undefined ? { progress: c.progress } : {}),
        ...(c.phase === "copied" && c.retired !== undefined ? { retired: c.retired } : {}) } : null,
      error: c?.phase === "failed" ? c.error : null,
      // how the run keeps the copy current NOW, as the sync derives it once (src/duck/sync.ts KeptCurrent, `keptOf`): its
      // sync and when it was last synced, what mason status and the stream's tables say, and EXPLAIN says over the wire
      ...(c?.kept ? { kept: c.kept } : {}),
      ...(c ? { duck: { rows: c.rows, bytes: c.bytes, seconds: c.seconds, copiedAt: c.copiedAt, error: c.error } } : {}),
      // an added table's sync: synced, syncing, failed or waiting (src/cli/readiness.ts syncStateOf), when it was last
      // brought current, how long that took and by what, and how old that is now
      ...(c !== undefined || entry !== undefined ? { sync: tableSync(c, now) } : {}),
    };
  });
  return {
    // what mason wait waits on and mason status prints last (src/cli/readiness.ts): said by the run, so the page and the
    // commands say one thing
    readiness: readiness({ tables }),
    // the run serves the web page (mason ui): mason status prints its URL
    ui: ctx.page,
    source: { url: maskedUrl(ctx.source.url), host: ctx.source.host, database: ctx.source.database, remote: ctx.source.remote, demo: ctx.demo === true,
      // `replication` while a table's sync is replication (the run streams), else `poll`: each table's own is its kept
      version: facts.versionText, standby: facts.standby, changes: repl !== null ? "replication" : "poll", name: sources.file?.name ?? null, file: sources.file?.file ?? null,
      shownFile: sources.file ? shownPath(ctx.root, sources.file.file) : null,
      // every table's sync unless its entry says its own: the file's top `sync:`, or the default when it writes none
      sync: { default: syncText(sources.file?.sync ?? DEFAULT_SYNC), written: sources.file?.sync != null },
      ...(repl !== null ? { replication: { slot: repl.slot, publication: repl.publication, owned: repl.owned } } : {}) },
    // a sources file edited into a mistake while the run is up: the run copies what it read last, and says so
    warnings: [...ctx.warnings, ...(sources.problem ? [`${sources.problem} (Mason syncs the tables it read before; mason start reads the file again)`] : [])],
    folder, project, tables,
    // where a tool connects (the Postgres API's URL, the credentials' place shown, and its psql line): the web page's
    // Connect panel, as mason status --json says it (src/cli/pg-url.ts postgresFacts)
    postgres: postgresFacts(ctx.users.postgresUrl),
    // the copies in all: tables added, copied, failed, their rows, the latest sync (the file's size is engine.bytes)
    totals: syncTotals(tables.filter((t) => t.added).length, copies),
    // the run itself: its version, since when it is up, and its supervisor's restarts (ONE reader, restartsFact, which
    // mason status reads with Mason stopped too)
    // keptDays: how long the request log, the events and the usage samples are kept (MASON_HISTORY_DAYS): the page
    // offers a time range past the week only when it is kept
    engine: { file: ctx.duck.file, bytes, keptDays: ctx.duck.requests.days,
      version: ctx.version, startedAt: new Date(ctx.startedAt).toISOString(), uptimeSeconds: Math.max(0, Math.round((now - ctx.startedAt) / 1000)),
      restarts: restartsFact(ctx.home, ctx.duck.restarts) },
    // the disk under the copy: free where its file is (the sync's own measure, the one a copy is held to), the file
    // (engine.bytes), and what the first syncs running are projected to add (copyDiskProjection) — mason status says it
    // the sessions logged in now, by user and client (the listener's own, in memory): mason status says how many
    sessions: ctx.listener.openSessions(),
    disk: { path: disk.path, freeBytes: disk.freeBytes, copyBytes: bytes, projectedBytes: disk.projectedBytes, ...(disk.error !== undefined ? { error: disk.error } : {}) },
    jsonPaths: ctx.duck.jsonPaths?.() ?? [],
    // the roles file as the listener reads it now: its roles by name, and what is wrong with it (every statement of a
    // session with a role is refused while there is)
    ...(ctx.roles ? { roles: rolesState(ctx.roles()) } : {}),
    // the share open now (mason share): where, who, and what was refused there; nothing in it logs anyone in
    share: ctx.shares?.state() ?? null,
    // replication mode: where the stream is, its lag and what it applied (mason status and wait render it, streamLines)
    ...(stream !== null ? { stream } : {}),
  };
}

/** a file's size, or null where it cannot be read (the run's own DuckDB file: it exists while the run does) */
function fileBytes(file: string): number | null {
  try { return fs.statSync(file).size; } catch { return null; }   // a size is a nicety of mason status: unknown, not an error
}

/** `RunState.roles` (src/cli/commands.ts): the file, the roles it names and what is wrong with it now */
export const rolesState = (r: RolesLive): { file: string | null; roles: string[]; problem: string | null; default: string | null; all: string[] } =>
  ({ file: r.file, roles: [...r.grants.keys()], problem: r.problem, default: r.default, all: [...r.grants.values()].filter((g) => g.all).map((g) => g.name) });

async function state(ctx: RunContext, columns = false): Promise<unknown> {
  return runState(ctx, ctx.duck.copies(), await ctx.duck.stream(), Date.now(), { columns });
}

/**
 * `GET /api/tables/<table>/columns`: one table's columns as the state says them with `?columns=1` (sources.ts
 * catalogTable: name, type, nullable, comment, references) — what the page's Columns… form ticks, read when it opens.
 * A table the catalog lacks (dropped since the run read it) is a 404 in the failure shape.
 */
export function tableColumns(ctx: RunContext, table: string): { table: string; columns: CatalogColumn[] } {
  const t = ctx.facts().tables.find((x) => x.source === table);
  if (t === undefined) {
    const message = `the database has no table ${JSON.stringify(table)} this user can read`;
    throw new Refusal(404, message, { message, code: "not_found", why: "it was dropped since Mason read the catalog, or never was", next: [["mason tables", "the tables it has, as this user reads them"]] });
  }
  return { table: t.source, columns: catalogTable(t, undefined).columns };
}

/**
 * WHAT A USAGE SAMPLE READS OF THE RUN (src/duck/usage.ts): `/api/state` at that moment, never a second computation of
 * any of it — the copy file's bytes (`engine.bytes`), `totals`, the stalest added table's `sync.ageSeconds`, the
 * stream's `lag` and its slot's `walHeldBytes`, the bytes free under the copy (`disk.freeBytes`), the sessions open (`sessions.open`), the copies served, and
 * the copies by phase (`phaseCounts`, the count `/healthz` says) for `GET /metrics`.
 */
export async function usageFacts(ctx: RunContext, now = Date.now(), { refresh = true }: { refresh?: boolean } = {}): Promise<UsageFacts> {
  const copies = ctx.duck.copies();
  const s = runState(ctx, copies, await ctx.duck.stream({ refresh }), now) as { totals: SyncTotals; engine: { bytes: number | null }; disk: { freeBytes: number | null }; sessions: { open: number };
    tables: Array<{ added: boolean; sync?: SyncFacts }>; stream?: StreamStatus };
  const ages = s.tables.flatMap((t) => (t.added && t.sync?.ageSeconds != null ? [t.sync.ageSeconds] : []));
  const slot = s.stream?.slotWal;
  return { copyBytes: s.engine.bytes, totals: s.totals, oldestSyncSeconds: ages.length ? Math.max(...ages) : null, streamLag: s.stream?.lag ?? null,
    copied: copies.filter((c) => c.phase === "copied").map((c) => c.source), slotWalHeldBytes: slot !== undefined && "walHeldBytes" in slot ? slot.walHeldBytes : null,
    diskFreeBytes: s.disk.freeBytes, sessionsOpen: s.sessions.open, tables: phaseCounts(copies),
    streamLagReadAt: s.stream !== undefined && "lsn" in s.stream.database ? s.stream.database.at : null,
    slotWalReadAt: slot !== undefined && "walHeldBytes" in slot ? slot.at : null };
}

/**
 * WHAT `GET /metrics` READS OF THE RUN (src/cli/metrics.ts, `mason serve`'s health port): a usage sample's own facts
 * (`usageFacts`, above: no number computed a second way), the statements since the process started as the sampler counts
 * them as they are recorded (`statementTotals`), and the last sample's p50 / p95 (`lastDurations`).
 *
 * A SCRAPE NEVER REACHES THE SOURCE (the review of PR 50: the endpoint takes no credential, so its rate is anyone's):
 * the stream's position and the slot are read as cached (`refresh: false`), never asked of the database; the sampler
 * keeps them fresh once a minute, and a number read longer ago than `FRESH_SAMPLES` samples is said as unknown
 * (`freshSeconds`, src/cli/metrics.ts).
 */
export async function metricsFacts(ctx: RunContext, now = Date.now()): Promise<Omit<RunMetrics, "uptimeSeconds">> {
  return { usage: await usageFacts(ctx, now, { refresh: false }), statements: ctx.duck.usage.statementTotals(), durations: ctx.duck.usage.lastDurations(),
    at: now, freshSeconds: FRESH_SAMPLES * ctx.duck.usage.sampleSeconds };
}

/** A `since` / `until` of a query string, read by the one time grammar (src/cli/request-filter.ts timeOf), as an ISO time. */
function timeParam(key: string, text: string, now: number): string {
  const t = timeOf(key, text, now);
  if (typeof t !== "string") throw new Refusal(400, t.message, t);
  return t;
}

/** why `lastUsedAt` is null in a `GET /api/users` that did not ask for it */
const LAST_USED_NOT_ASKED = "not asked: GET /api/users?lastUsed=1 reads it from the request log";

const DAY_S = 86_400;

/**
 * `GET /api/usage?since=&until=&step=`: the samples from `since` (default an hour ago) until `until` (default
 * now), oldest first; with `step` (seconds, at least a sample's interval) re-bucketed in one query, each count summed and
 * each level at its highest — but the p50 and p95 of a point of more than a minute are its statements', read from the
 * request log by when each started (`durationsBy`). And each copy's own bytes as last measured, how often a sample is taken, and the days
 * kept. `mason usage --json` is this.
 */
export async function usage(ctx: RunContext, q: URLSearchParams, now = Date.now()): Promise<{ since: string; until: string; stepSeconds: number | null; sampleSeconds: number;
  keptDays: number; samples: UsageSample[]; copySizes: CopySize[] }> {
  const time = (k: "since" | "until", fallback: number): string => {
    const text = q.get(k);
    if (text === null) return new Date(fallback).toISOString();
    return timeParam(k, text, now);
  };
  const since = time("since", now - 3_600_000), until = time("until", now);
  if (since >= until) throw new Refusal(400, `since (${since}) must be before until (${until})`);
  const u = ctx.duck.usage;
  const stepText = q.get("step");
  const step = stepText === null ? null : Number(stepText);
  if (step !== null && (!Number.isInteger(step) || step < u.sampleSeconds || step > u.days * DAY_S)) {
    throw new Refusal(400, `step is a whole number of seconds, ${u.sampleSeconds} (a sample's interval) to ${u.days * DAY_S} (the ${u.days} days kept), not ${JSON.stringify(stepText)}`);
  }
  const read = await u.samples({ since, until, ...(step === null ? {} : { stepSeconds: step }) });
  // a point of more than a minute: its p50 and p95 are its statements', from the request log (`durationsBy`), never
  // the highest of its minutes' (a sample keeps its minute's alone)
  const durations = step !== null && step > u.sampleSeconds ? await ctx.duck.requests.durationsBy(since, until, step) : null;
  const samples = durations === null ? read : read.map((s) => {
    const d = durations.get(Date.parse(s.at));
    return { ...s, durationP50Ms: d?.p50 ?? null, durationP95Ms: d?.p95 ?? null };
  });
  return { since, until, stepSeconds: step, sampleSeconds: u.sampleSeconds, keptDays: u.days, samples, copySizes: await u.copySizes() };
}

/**
 * `GET /api/activity?since=`: what the Postgres API answered from `since` on (default an hour ago; the one time grammar,
 * src/cli/request-filter.ts `timeOf`), for the Usage page's time range — the window's statements (src/duck/requests.ts
 * `window`), who sent them (`clients`: a row per user and client, the 50 with the most statements; `clientsTotal`:
 * how many clients and sessions in all) and the slowest that completed (`slowest`); and the
 * days the request log keeps. Read once per range chosen, every 5 s while the range is Now.
 */
export async function activity(ctx: RunContext, q: URLSearchParams, now = Date.now()): Promise<{ since: string; window: QueryWindow; clients: ClientActivity[];
  clientsTotal: { clients: number; sessions: number }; slowest: LedgerRequest[]; keptDays: number }> {
  const sinceText = q.get("since");
  const since = sinceText === null ? new Date(now - 3_600_000).toISOString() : timeParam("since", sinceText, now);
  const r = ctx.duck.requests;
  const [window, who, slowest] = await Promise.all([r.window(since, now), r.clients(since), r.slowest(since)]);
  return { since, window, clients: who.clients, clientsTotal: who.total, slowest, keptDays: r.days };
}

/** how many registry entries `/api/unsupported` answers unless `limit` says, and at most */
export const DEFAULT_UNSUPPORTED_LIMIT = 10;
export const MAX_UNSUPPORTED_LIMIT = 100;

/**
 * `GET /api/unsupported?since=&limit=`: the statements refused from `since` on (default a day ago; read by the one time
 * grammar, src/cli/request-filter.ts `timeOf`) grouped by the registry entry that refused them (src/duck/requests.ts
 * `unsupported`), the most refused first, `limit` (1 to 100, default 10) of them; and the days the request log keeps.
 * `mason status --json` `unsupported` is this.
 */
export async function unsupported(ctx: RunContext, q: URLSearchParams, now = Date.now()): Promise<{ since: string; unsupported: UnsupportedSql[]; keptDays: number }> {
  const sinceText = q.get("since");
  const since = sinceText === null ? new Date(now - DAY_S * 1000).toISOString() : timeParam("since", sinceText, now);
  const limitText = q.get("limit");
  const limit = limitText === null ? DEFAULT_UNSUPPORTED_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_UNSUPPORTED_LIMIT) {
    throw new Refusal(400, `limit is a whole number of entries of docs/SQL-SUPPORT.md, 1 to ${MAX_UNSUPPORTED_LIMIT}, not ${JSON.stringify(limitText)}`);
  }
  return { since, unsupported: await ctx.duck.requests.unsupported({ since, limit }), keptDays: ctx.duck.requests.days };
}

/**
 * `GET /api/events?limit=&since=&failed=1`: the newest `limit` (1 to 10000, default 40) of the sync's events merged with
 * the run's restarts, newest last, from `since` on (`since` and `until` are read everywhere by one grammar, src/cli/request-filter.ts `timeOf`: an age, or an ISO 8601 time with its zone), the failures only with `failed=1`; and the days
 * they are kept. `mason logs --events --json` is this; `mason status --json` `recentErrors` its latest failures.
 */
export async function events(ctx: RunContext, q: URLSearchParams): Promise<{ events: ReturnType<typeof withRestarts>; keptDays: number }> {
  const limit = eventLimit(q.get("limit") ?? undefined, "limit");
  if (typeof limit !== "number") throw new Refusal(400, limit.message, limit);
  const sinceText = q.get("since");
  const since = sinceText === null ? undefined : timeParam("since", sinceText, Date.now());
  const o = { limit, failed: q.get("failed") === "1", ...(since === undefined ? {} : { since }) };
  const found = await ctx.duck.events.recent(o);
  return { events: withRestarts(found, ctx.duck.restarts(), { ...o, days: ctx.duck.events.days }), keptDays: ctx.duck.events.days };
}

/** The sources file as it is on disk now (src/cli/source-edit.ts sourceToEdit) — and the database it names NOW must be
 *  the one this run copies: its catalog is what an edit is checked against. */
function sourceOnDisk(ctx: RunContext): EditTarget {
  const at = sourceToEdit(ctx.folder(), ctx.root, ctx.readSource);
  if (at.read.resolved !== ctx.runUrl) {
    throw new Refusal(409, `${shownPath(ctx.root, at.file)}: url: now names ${maskedUrl(at.read.resolved)} (${at.read.from}), and this run syncs ${maskedUrl(ctx.runUrl)}: ` +
      "mason stop && mason start syncs from the new one, then add or remove the table");
  }
  return at;
}

/** The database this run copies, as an edit is checked against it: the catalog it last read, and how it reads changes. */
const catalogOf = (ctx: RunContext): EditCatalog => ({ tables: ctx.facts().tables, database: ctx.source.database,
  ...(ctx.duck.measured ? { measured: ctx.duck.measured } : {}) });

/**
 * ADD A TABLE: the check-and-write every entrance shares (src/cli/source-edit.ts addEntry), against the file on disk and
 * this run's catalog; the caller tells the run the file changed, and the sync starts the copy.
 */
export function pick(ctx: RunContext, table: string, columns: readonly string[] = ["*"], key: readonly string[] | null = null, o: { sync?: TableSync; keep?: boolean } = {},
  at: EditTarget = sourceOnDisk(ctx)): PickResult {
  return addEntry(at, catalogOf(ctx), table, columns, key, o);
}

/** REMOVE TABLES: the check-and-write every entrance shares (src/cli/source-edit.ts removeEntries); the run then drops their copies. */
export function removeTables(ctx: RunContext, names: readonly string[]): RemoveResult {
  return removeEntries(sourceOnDisk(ctx), catalogOf(ctx), names);
}

/** The HTTP status of a Failure by its code: src/cli/source-edit.ts codeOf the other way round. */
const statusOf = (f: Failure): number => f.code === "usage" ? 400 : f.code === "not_found" ? 404 : f.code === "failed" ? 500 : 409;

/**
 * EVERY ERROR ANSWER: `error`, the sentence a command prints (src/cli/control.ts reads it), and `failure`, the same
 * refusal in the CLI's Failure shape — { code, message, why?, fix?, next: [{ command, what }] }, what `--json` prints
 * — which the web page renders as the CLI does.
 */
export function sendFailure(res: http.ServerResponse, status: number, f: Failure, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { error: f.message, ...extra, failure: { ...errorJson(f), next: nextJson(f.next) } });
}

/** One file of the web page: its bytes, its content type, and whether its bytes can never change at its path. */
export interface PageFile { body: Buffer; type: string; immutable: boolean }

/**
 * A VENDORED FILE AT A PINNED VERSION (`/vendor/<name>-<x.y.z>/…`, src/web/vendor/README.md): its bytes are that
 * release's for good — a new version is a new folder — so the browser keeps it a year without asking again
 * (`immutable`): a reload re-reads the page's own modules (no-store, as every answer) but not the fonts, uPlot and
 * the icons — measured with the demo: a reload moved 222 KB where the first load moved 520 KB.
 */
const PINNED_VENDOR = /^\/vendor\/[a-z][a-z0-9-]*-\d+\.\d+\.\d+\//;
const IMMUTABLE = "private, max-age=31536000, immutable";

/** THE WEB PAGE'S ROUTES, AND THE FILE EACH IS: the only files the server ever reads for a URL. */
export const PAGE_ROUTES: Readonly<Record<string, readonly [file: string, type: string]>> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  // the shell's shared helpers and one module per page (src/web/app.js has the page module contract)
  "/shared.js": ["shared.js", "text/javascript; charset=utf-8"],
  "/pages/status.js": ["pages/status.js", "text/javascript; charset=utf-8"],
  "/pages/tables.js": ["pages/tables.js", "text/javascript; charset=utf-8"],
  "/pages/queries.js": ["pages/queries.js", "text/javascript; charset=utf-8"],
  "/pages/users.js": ["pages/users.js", "text/javascript; charset=utf-8"],
  "/pages/usage.js": ["pages/usage.js", "text/javascript; charset=utf-8"],
  "/pages/syncs.js": ["pages/syncs.js", "text/javascript; charset=utf-8"],
  // the charts (src/web/charts.js over uPlot) and what the page vendors whole, pinned, with its licence
  // (src/web/vendor/README.md): served from here, never fetched from elsewhere — a box without internet reads it all
  "/charts.js": ["charts.js", "text/javascript; charset=utf-8"],
  "/vendor/README.md": ["vendor/README.md", "text/plain; charset=utf-8"],
  "/vendor/geist-1.7.2/Geist-Variable.woff2": ["vendor/geist-1.7.2/Geist-Variable.woff2", "font/woff2"],
  "/vendor/geist-1.7.2/GeistMono-Variable.woff2": ["vendor/geist-1.7.2/GeistMono-Variable.woff2", "font/woff2"],
  "/vendor/geist-1.7.2/LICENSE.txt": ["vendor/geist-1.7.2/LICENSE.txt", "text/plain; charset=utf-8"],
  "/vendor/zilla-slab-5.3.0/zilla-slab-latin-700-normal.woff2": ["vendor/zilla-slab-5.3.0/zilla-slab-latin-700-normal.woff2", "font/woff2"],
  "/vendor/zilla-slab-5.3.0/LICENSE.txt": ["vendor/zilla-slab-5.3.0/LICENSE.txt", "text/plain; charset=utf-8"],
  "/vendor/uplot-1.6.32/uPlot.esm.js": ["vendor/uplot-1.6.32/uPlot.esm.js", "text/javascript; charset=utf-8"],
  "/vendor/uplot-1.6.32/uPlot.min.css": ["vendor/uplot-1.6.32/uPlot.min.css", "text/css; charset=utf-8"],
  "/vendor/uplot-1.6.32/LICENSE.txt": ["vendor/uplot-1.6.32/LICENSE.txt", "text/plain; charset=utf-8"],
  // the nav's icons (src/web/shared.js ICONS): Lucide's, one ES module per icon, each its SVG as a string
  "/vendor/lucide-1.56.0/chart-column.mjs": ["vendor/lucide-1.56.0/chart-column.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/layout-dashboard.mjs": ["vendor/lucide-1.56.0/layout-dashboard.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/logs.mjs": ["vendor/lucide-1.56.0/logs.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/menu.mjs": ["vendor/lucide-1.56.0/menu.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/square-terminal.mjs": ["vendor/lucide-1.56.0/square-terminal.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/table.mjs": ["vendor/lucide-1.56.0/table.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/users.mjs": ["vendor/lucide-1.56.0/users.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/x.mjs": ["vendor/lucide-1.56.0/x.mjs", "text/javascript; charset=utf-8"],
  "/vendor/lucide-1.56.0/LICENSE.txt": ["vendor/lucide-1.56.0/LICENSE.txt", "text/plain; charset=utf-8"],
};

/**
 * The web page's files, READ ONCE when the server starts (src/web/ beside src/cli/, in a checkout and in the package
 * alike: cli/build.ts copies them): a map of route to bytes. A request's path is looked up in it, never joined onto a
 * folder, so no URL can name another file. A file missing is a broken install, said with the path.
 */
export function pageFiles(dir: string = fileURLToPath(new URL("../web/", import.meta.url))): Map<string, PageFile> {
  return new Map(Object.entries(PAGE_ROUTES).map(([route, [file, type]]) => {
    const at = path.join(dir, file);
    let body: Buffer;
    try { body = fs.readFileSync(at); }
    catch (e) { throw new Error(`the web page's ${file} cannot be read (${at}: ${(e as Error).message}): this Mason is installed incompletely — npm i -g @mason-data/cli again`); }
    return [route, { body, type, immutable: PINNED_VENDOR.test(route) }];
  }));
}

/** How long `/api/queries`' summary is answered from the last read: the Overview asks every 30 s, Usage and Queries
 *  too, and `mason status` at each run — each a 7-day scan of the request log (~0.15 s at 30 M rows). */
export const SUMMARY_TTL_MS = 30_000;

/**
 * ONE READ SHARED FOR `ms`, by time only (`summaryCache`): every ask within `ms` of a read gets that read — the one in
 * flight too, so two pages asking at once cost one scan. A read that fails is not kept: the next ask reads again. So the
 * summary is up to `ms` old (docs/OBSERVABILITY.md says it).
 */
export function timedCache<T>(read: () => Promise<T>, ms: number, clock: () => number = Date.now): () => Promise<T> {
  let kept: { at: number; value: Promise<T> } | null = null;
  return () => {
    const now = clock();
    if (kept !== null && now - kept.at < ms) return kept.value;
    const value = read();
    const mine = { at: now, value };
    kept = mine;
    // a failure is the caller's answer (it awaits `value`); here it only means the read is not kept
    value.catch(() => { if (kept === mine) kept = null; });
    return value;
  };
}

/**
 * `POST /api/share` { secret, role? }: a share opened, its first line of JSON, and THE ANSWER LEFT OPEN: the connection is
 * the share (src/cli/share-run.ts), so a command gone by any means ends it. Only the password's hash arrives here. Past
 * its first line the answer says one thing, why the run ended it.
 */
async function openShare(ctx: RunContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (ctx.shares === undefined) {
    sendFailure(res, 409, { message: "this run is on a server, and has an address of its own: mason share is for a run on a laptop", code: "refused", next: [["mason help production", "reaching a server's Postgres API"]] });
    return;
  }
  const shares = ctx.shares;
  const body = JSON.parse(await readBody(req, 64 * 1024)) as { secret?: unknown; role?: unknown };
  if (typeof body.secret !== "string" || !/^[0-9a-f]{64}$/.test(body.secret)) throw new Refusal(400, "send { secret, role? }: the password's SHA-256 in hex");
  if (body.role !== undefined && typeof body.role !== "string") throw new Refusal(400, "role is a role's name, or left out");
  let gone = false;
  res.once("close", () => { gone = true; });
  const opened = await shares.open({ secret: body.secret, role: body.role as string | undefined });
  if ("failure" in opened) { sendFailure(res, statusOf(opened.failure), opened.failure, opened.choices ? { choices: opened.choices } : {}); return; }
  const end = (why: string): void => { void shares.close(opened.user, why).catch((e: unknown) => ctx.log(`closing the share ${opened.user} failed: ${(e as Error).message}`)); };
  // the command went while the socket opened
  if (gone) { end("mason share went away"); return; }
  res.once("close", () => end("mason share went away"));
  shares.onEnd(opened.user, (why) => { res.end(`${JSON.stringify({ ended: why })}\n`); });
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  res.write(`${JSON.stringify(opened)}\n`);
}

export function createRunServer(ctx: RunContext): http.Server {
  const saidErrors = new Set<string>();
  // the last day's and week's statements, read at most once every SUMMARY_TTL_MS for every page and command that asks
  const summary = timedCache(() => ctx.duck.requests.summary(), SUMMARY_TTL_MS);
  // read once, here: nothing a request names is ever read from disk (mason serve's run serves no page)
  const page = ctx.page ? pageFiles() : new Map<string, PageFile>();
  return http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const v = guard({ method: req.method ?? "GET", url: req.url ?? "/", host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, authorization: req.headers.authorization }, ctx.port, ctx.token);
    if (!v.ok) {
      if (v.status === 303) { res.writeHead(303, { Location: v.location, "Set-Cookie": v.setCookie }).end(); return; }
      res.writeHead(v.status, { "Content-Type": "text/plain; charset=utf-8" }).end(`${v.reason}\n`);
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${ctx.port}`);
    void (async () => {
      try {
        const file = req.method === "GET" || req.method === "HEAD" ? page.get(url.pathname) : undefined;
        if (file !== undefined) {
          res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length, ...(file.immutable ? { "Cache-Control": IMMUTABLE } : {}) })
            .end(req.method === "HEAD" ? undefined : file.body);
        } else if (req.method === "GET" && url.pathname === "/api/ping") {
          // what proves a run is up (src/cli/runs.ts answers): this token answered, by this process
          sendJson(res, 200, { pid: process.pid });
        } else if (req.method === "GET" && url.pathname === "/api/state") {
          // lean, as the page polls it; ?columns=1 with each table's columns (mason status --json)
          sendJson(res, 200, await state(ctx, url.searchParams.get("columns") === "1"));
        } else if (req.method === "GET" && /^\/api\/tables\/[^/]+\/columns$/.test(url.pathname)) {
          // one table's columns, read when the page's Columns… form opens (never with the state, polled every 2 s)
          let table: string;
          try { table = decodeURIComponent(url.pathname.split("/")[3]!); }
          catch { throw new Refusal(400, `${url.pathname} does not name a table: GET /api/tables/<schema.table, URL-encoded>/columns`); }
          sendJson(res, 200, tableColumns(ctx, table));
        } else if (req.method === "GET" && url.pathname === "/api/slow") {
          // the last day's slow statements, from the request log (src/duck/requests.ts)
          sendJson(res, 200, { slow: await ctx.duck.requests.slow(SLOW_MS), slowMs: SLOW_MS });
        } else if (req.method === "GET" && url.pathname === "/api/refused") {
          sendJson(res, 200, await ctx.duck.requests.refused());
        } else if (req.method === "GET" && url.pathname === "/api/unsupported") {
          // the refused statements grouped by the unsupported SQL they used (src/duck/gaps.ts): mason status
          sendJson(res, 200, await unsupported(ctx, url.searchParams));
        } else if (req.method === "GET" && url.pathname === "/api/requests") {
          // the filters, read as mason logs --requests reads its options (src/cli/request-filter.ts)
          const q = requestFilter(requestFilterText(url.searchParams));
          if ("message" in q) { sendFailure(res, 400, q); return; }
          sendJson(res, 200, { ...await ctx.duck.requests.page(q), keptDays: ctx.duck.requests.days });
        } else if (req.method === "GET" && url.pathname === "/api/queries") {
          // the last day's and week's statements in one scan of the request log (mason status); asked on its own, never
          // with /api/state, which the page asks every 2 s
          // (cached SUMMARY_TTL_MS: up to 30 s old)
          sendJson(res, 200, { queries: await summary() });
        } else if (req.method === "GET" && url.pathname === "/api/activity") {
          // one time range's statements, clients and slowest (the Usage page's), from the request log
          sendJson(res, 200, await activity(ctx, url.searchParams));
        } else if (req.method === "GET" && url.pathname === "/api/running") {
          sendJson(res, 200, { running: ctx.listener.running() });
        } else if (req.method === "POST" && url.pathname === "/api/cancel") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { session?: unknown; statement?: unknown };
          const whole = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1;
          if (!whole(body.session)) throw new Refusal(400, "send { session }: the session's number, as mason logs --running lists it");
          if (body.statement !== undefined && !whole(body.statement)) throw new Refusal(400, "statement is the statement's number, as mason logs --running lists it, or left out");
          const r = ctx.listener.cancel(body.session, body.statement);
          if ("cancelled" in r) { sendJson(res, 200, r); return; }
          const running: NextStep = ["mason logs --running", "the statements running now, with their sessions"];
          if ("other" in r) {
            sendFailure(res, 409, { message: `session ${r.other.session} runs another statement now (statement ${r.other.statement}), not statement ${r.asked}: nothing cancelled`, code: "refused",
              why: `statement ${r.asked} ended, and the session began another`, fix: `mason cancel ${r.other.session} --statement ${r.other.statement} stops the one it runs now`, next: [running] });
            return;
          }
          if ("unknown" in r) { sendFailure(res, 404, { message: `no session ${r.unknown} is open`, code: "not_found", why: "it ended, or never was", next: [running] }); return; }
          sendFailure(res, 409, { message: `session ${r.idle} is running no statement: nothing to cancel`, code: "refused", why: "its statement ended, or it is between two", next: [running] });
        } else if (req.method === "GET" && url.pathname === "/api/logs") {
          // the run's last log entries from memory (mason serve has no file to read): { at, text } each, oldest first
          const lines = Number(url.searchParams.get("lines") ?? Math.min(40, ctx.logs.capacity));
          if (!Number.isInteger(lines) || lines < 1 || lines > ctx.logs.capacity) throw new Refusal(400, `lines is a whole number of log entries, 1 to ${ctx.logs.capacity} (all the run keeps)`);
          const sinceText = url.searchParams.get("since");
          const since = sinceText === null ? undefined : timeParam("since", sinceText, Date.now());
          sendJson(res, 200, { lines: ctx.logs.recent({ lines, ...(since !== undefined ? { since } : {}) }), kept: ctx.logs.capacity });
        } else if (req.method === "GET" && url.pathname === "/api/events") {
          // the sync's events and the run's restarts, newest last (src/duck/events.ts): mason logs --events, mason status
          sendJson(res, 200, await events(ctx, url.searchParams));
        } else if (req.method === "GET" && url.pathname === "/api/usage") {
          // usage over time, a sample a minute (src/duck/usage.ts): mason usage
          sendJson(res, 200, await usage(ctx, url.searchParams));
        } else if (req.method === "POST" && url.pathname === "/api/pick") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { table?: unknown; picked?: unknown; columns?: unknown; key?: unknown; sync?: unknown; keep?: unknown };
          if (typeof body.table !== "string" || typeof body.picked !== "boolean") throw new Refusal(400, "send { table, picked, columns?, key?, sync?, keep? }");
          // a sync by the sources file's own grammar (src/lib/table-sync.ts), as mason add --sync reads it
          const sync = body.sync === undefined ? undefined : parseSync(body.sync);
          if (sync !== undefined && "problem" in sync) throw new Refusal(400, `sync ${JSON.stringify(body.sync)}: ${sync.problem}`);
          if (body.columns !== undefined && !(Array.isArray(body.columns) && body.columns.every((c) => typeof c === "string"))) throw new Refusal(400, "columns is a list of column names, or [\"*\"]");
          if (body.key !== undefined && !(Array.isArray(body.key) && body.key.length > 0 && body.key.every((c) => typeof c === "string"))) throw new Refusal(400, "key is a list of column names");
          if (body.picked) {
            // the file as it was (its text, read once with the edit): an edit that sets a table to sync: replication the
            // database cannot serve is undone below
            const at = sourceOnDisk(ctx);
            const r = pick(ctx, body.table, (body.columns as string[] | undefined) ?? ["*"], (body.key as string[] | undefined) ?? null, { ...(sync !== undefined ? { sync } : {}), keep: body.keep === true }, at);
            // A LIVE SWITCH INTO REPLICATION is held to the start's checks (wal_level, the role, a free slot): one the
            // database cannot serve would leave the table, polled until now, NOT kept current for ever — the file is put
            // back as it was, byte for byte, and the refusal says what the database lacks and the line that polls it
            const now = r.already || ctx.checkReplication === undefined ? null : parseSourceText(fs.readFileSync(at.file, "utf8"), at.parsed.name, at.file);
            const refused = now === null || "problems" in now ? null : await ctx.checkReplication!(now);
            if (refused !== null) { fs.writeFileSync(at.file, at.text); sendFailure(res, statusOf(refused), refused); return; }
            if (!r.already) ctx.log(`added ${r.table} to ${r.file}`);
            ctx.sourcesChanged();
            sendJson(res, 200, { ...r, state: await state(ctx) });
          } else {
            const r = removeTables(ctx, [body.table]);
            for (const t of r.removed) ctx.log(`removed ${t} from ${r.file}`);
            ctx.sourcesChanged();
            sendJson(res, 200, { ...r, state: await state(ctx) });
          }
        } else if (req.method === "POST" && url.pathname === "/api/share") {
          await openShare(ctx, req, res);
        } else if (req.method === "POST" && /^\/api\/share\/[^/]+$/.test(url.pathname)) {
          // what the command knows of its tunnel, as it knows it: mason status says it, and the run stops the client
          const body = JSON.parse(await readBody(req, 64 * 1024)) as ShareTunnel;
          const user = decodeURIComponent(url.pathname.slice("/api/share/".length));
          if (ctx.shares?.update(user, body) !== true) { sendFailure(res, 404, { message: `no share ${user} is open`, code: "not_found" }); return; }
          sendJson(res, 200, { ok: true });
        } else if (req.method === "GET" && url.pathname === "/api/users") {
          // mason user list --json's shape: the users, and whether each connects (and with ?lastUsed=1 when each was last used)
          const r = listUsers(ctx.users.file, ctx.users.apiKey, postgresLink(ctx.users.postgresUrl), ctx.roles?.() ?? NO_ROLES);
          if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
          // the last use is a scan of the request log (~0.15 s on a week of 50 statements a second): only when asked
          // (?lastUsed=1: mason user list, the Users page every 30 s), never for the Overview's poll, which does not show it
          const used = url.searchParams.get("lastUsed") === "1" ? await withLastUsed(r.users, ctx.duck.requests, ctx.log)
            : { users: r.users, lastUsedNote: LAST_USED_NOT_ASKED, requestLogDays: ctx.duck.requests.days };
          sendJson(res, 200, { ...used, urlNote: null, next: nextJson([["mason user add <name>", "a user for a tool: its password and URL, printed once"]]) });
        } else if (req.method === "POST" && url.pathname === "/api/users") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { name?: unknown; role?: unknown };
          if (typeof body.name !== "string") throw new Refusal(400, "send { name }: the user's name");
          if (body.role !== undefined && typeof body.role !== "string") throw new Refusal(400, "send { name, role }: the role's name, a string");
          // the role must be one the roles file names NOW (src/cli/user.ts roleToAdd): refused before anything is written
          const roleProblem = body.role === undefined ? null : roleToAdd(body.role, ctx.roles?.() ?? NO_ROLES);
          if (roleProblem !== null) { sendFailure(res, statusOf(roleProblem), roleProblem); return; }
          // mason user add --json's shape: its password, once, and the URL to paste (this run is up, so it has one)
          const r = addUser(ctx.users.file, ctx.users.apiKey, body.name, { link: postgresLink(ctx.users.postgresUrl), database: ctx.users.database, roles: ctx.roles?.() ?? NO_ROLES,
            ...(typeof body.role === "string" ? { role: body.role } : {}) });
          if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
          const { replaced, ...added } = r;
          ctx.log(`user ${added.user} added${replaced ? " (in place of one the API key's rotation had removed)" : ""}`);
          sendJson(res, 200, { ...added, next: nextJson(addedNext(added.user, true)) });
        } else if (req.method === "POST" && /^\/api\/users\/[^/]+\/(disable|enable)$/.test(url.pathname)) {
          // mason user disable|enable --json's shape, through its own functions: kept, its password unchanged
          const [, , , encoded, verb] = url.pathname.split("/") as [string, string, string, string, "disable" | "enable"];
          let name: string;
          try { name = decodeURIComponent(encoded); }
          catch { throw new Refusal(400, `${url.pathname} does not name a user: POST /api/users/<name>/${verb}`); }
          if (verb === "disable") {
            const r = disableUser(ctx.users.file, name);
            if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
            if (!r.already) ctx.log(`user ${r.disabled.name} disabled`);
            sendJson(res, 200, { ...r, next: nextJson(disabledNext(r.disabled.name)) });
          } else {
            const r = enableUser(ctx.users.file, name);
            if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
            if (!r.already) ctx.log(`user ${r.enabled.name} enabled`);
            sendJson(res, 200, { ...r, next: nextJson(enabledNext(r.enabled.name)) });
          }
        } else if (req.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
          let name: string;
          try { name = decodeURIComponent(url.pathname.slice("/api/users/".length)); }
          catch { throw new Refusal(400, `${url.pathname} does not name a user: DELETE /api/users/<name>`); }
          const r = removeUser(ctx.users.file, name);
          if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
          ctx.log(`user ${r.removed.name} removed`);
          sendJson(res, 200, { ...r, next: nextJson(REMOVED_NEXT) });
        } else if (req.method === "POST" && url.pathname === "/api/sync") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { tables?: unknown };
          if (!Array.isArray(body.tables) || !body.tables.length || !body.tables.every((x) => typeof x === "string")) throw new Refusal(400, "send { tables: [schema.table, …] }");
          try { sendJson(res, 200, await ctx.duck.poll(body.tables as string[])); }
          catch (e) { if (e instanceof PollRefused) { sendFailure(res, e.code === "not_found" ? 404 : 409, { message: e.message, code: e.code }, { code: e.code }); return; } throw e; }
        } else if (req.method === "POST" && url.pathname === "/api/remove") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { tables?: unknown };
          if (!Array.isArray(body.tables) || !body.tables.length || !body.tables.every((m) => typeof m === "string")) throw new Refusal(400, "send { tables: [name, …] }");
          const r = removeTables(ctx, body.tables as string[]);
          // the sync stops copying a removed table, and drops its copy
          ctx.sourcesChanged();
          for (const t of r.removed) ctx.log(`removed ${t} from ${r.file}`);
          sendJson(res, 200, { ...r, state: await state(ctx) });
        } else {
          sendFailure(res, 404, { message: `no ${req.method} ${url.pathname}: this is mason start's server for the mason command (mason --help)`, code: "not_found" });
        }
      } catch (e) {
        if (e instanceof Refusal) { sendFailure(res, e.status, e.failure); return; }
        if (e instanceof SyntaxError) { sendFailure(res, 400, { message: `the body is not JSON: ${e.message}`, code: "usage" }); return; }
        // said ONCE per distinct reason: a command may ask every second, and a stack a second buried the terminal
        const why = ((e as Error).message.split("\n---\n").pop() ?? String(e)).split("\n")[0]!;
        const key = `${url.pathname} ${why}`;
        if (!saidErrors.has(key)) { saidErrors.add(key); ctx.log(`command server: ${req.method} ${url.pathname} failed: ${why}`); }
        sendFailure(res, 500, { message: (e as Error).message, code: "failed", next: [["mason logs", "the run's log: what it was doing"]] });
      }
    })();
  });
}
