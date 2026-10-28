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
import type { ChangeSource } from "../cdc/poll.ts";
import { maskedUrl, type Source, type SourceFacts } from "./preflight.ts";
import { errorJson, nextJson, type Failure, type NextStep } from "./command.ts";
import { readiness, syncTotals, tableSync, type SyncTotals, type TableSync } from "./readiness.ts";
import type { Restart } from "./supervise.ts";
import { withRestarts, type SyncEvents } from "../duck/events.ts";
import { addedNext, addUser, listUsers, removeUser, REMOVED_NEXT, withLastUsed } from "./user.ts";
import { postgresLink } from "./pg-url.ts";
import { catalogTable, shownPath, type ProjectSource, type SourceFile } from "./sources.ts";
import { addEntry, Refusal, removeEntries, sourceToEdit, type EditCatalog, type EditTarget, type PickResult, type RemoveResult } from "./source-edit.ts";
import { PollRefused, type CopyState, type PolledTable, type StreamStatus } from "../duck/sync.ts";
import type { LogBuffer } from "../lib/log-buffer.ts";
import type { RequestLedger } from "../duck/requests.ts";
import { eventLimit, requestFilter, requestFilterText, timeOf } from "./request-filter.ts";
import type { PgApiServer } from "../api/postgres/server.ts";
import type { KeptPathStatus } from "../duck/kept.ts";
import type { CopySize, UsageFacts, UsageSample, UsageSampler } from "../duck/usage.ts";

/** A statement answered in this many milliseconds or more is slow: what mason status lists (src/duck/requests.ts slow). */
export const SLOW_MS = 1000;

export interface RunContext {
  source: Source;
  facts: () => SourceFacts;
  warnings: string[];
  /** replication mode: the slot the run reads (src/cli/replication-mode.ts); '' when polling */
  slot: string;
  /** how the run reads the database's changes: a database elsewhere is refused large tables only when polled */
  changes: ChangeSource;
  /** replication: the publication the run reads, and whether it is Mason's own (else the operator named it: only read) */
  publication?: { name: string; owned: boolean };
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
  /** the project's folder (sources/, mason.yml) */
  folder: () => string | null;
  /** the project's root (where .mason/ is): what messages name files from */
  root: string;
  /** the sources file the run copies from as it last read it, and what is wrong with it now (null: nothing) */
  sources: () => { file: SourceFile | null; problem: string | null };
  /** the sources file changed (a table added or removed): the run reads it again */
  sourcesChanged: () => void;
  /** the sources file read as the run reads it, its URL resolved (src/cli/sources.ts readSource) */
  readSource: () => ProjectSource | Failure;
  /** the database's URL the run copies from, as the sources file resolved it at the start */
  runUrl: string;
  log: (m: string) => void;
  /** the run's last log entries (src/lib/log-buffer.ts), fed by the one writer of its log: `/api/logs` */
  logs: Pick<LogBuffer, "recent" | "capacity">;
  /** the Postgres listener: the statements running now, and a cancel of one (`/api/running`, `POST /api/cancel`) */
  listener: Pick<PgApiServer, "running" | "cancel">;
  /** the run's copy: each added table's copy as the sync has it, the file it is in, how often it polls */
  duck: { copies: () => CopyState[]; file: string; pollSeconds: number;
    /** a poll of exactly these tables, now (mason sync; src/duck/sync.ts pollNow) */
    poll: (sources: string[]) => Promise<{ at: string; tables: PolledTable[] }>;
    /** where the replication stream is (src/duck/sync.ts streamStatus): null outside replication mode */
    stream: () => Promise<StreamStatus | null>;
    /** the Postgres listener's requests (src/duck/requests.ts, `_mason.requests`): mason status and mason logs --requests */
    requests: Pick<RequestLedger, "page" | "slow" | "refused" | "summary" | "days" | "lastUsed">;
    /** the sync's failures and notable events (src/duck/events.ts, `_mason.sync_events`): mason logs --events, mason status */
    events: Pick<SyncEvents, "recent" | "days">;
    /** usage over time (src/duck/usage.ts, `_mason.usage`): mason usage */
    usage: Pick<UsageSampler, "samples" | "copySizes" | "days" | "sampleSeconds">;
    /** the run's restarts, as its supervisor records them in `.mason/restarts.json` (src/cli/supervise.ts readRestarts:
     *  a file that cannot be read throws, said as the request's failure); merged with the events */
    restarts: () => Restart[];
    /** the JSON paths stored as columns of the copies, and how far each is (src/duck/kept.ts): mason status */
    jsonPaths?: () => KeptPathStatus[] };
}

/** A statement the Postgres API answered slowly in the last day, with how often and how slowly (src/duck/requests.ts slow). */
export interface SlowQuery {
  /** where it was asked: `postgres`, an SQL statement on the Postgres API */
  route: "postgres"; payload: string; runs: number; medianMs: number; maxMs: number; latestMs: number; last: string }

/** A statement the Postgres API refused or failed in the last day: the statement, how often, and the message (which says what to change). */
export interface RefusedQuery {
  /** as SlowQuery's: `postgres`, whose code is its SQLSTATE */
  route: "postgres"; code: string; message: string; runs: number; last: string; payload: string }

/**
 * The run's state, in the shape mason status / wait read (`RunState`, src/cli/commands.ts): each table of the database,
 * added or not, and each added one's copy as the sync has it, so `mason wait` is ready exactly when every added table is
 * copied.
 */
export function runState(ctx: RunContext, copies: readonly CopyState[], stream: StreamStatus | null, now = Date.now()): unknown {
  const folder = ctx.folder();
  const sources = ctx.sources();
  const by = new Map(copies.map((c) => [c.source, c]));
  const project = folder && fs.existsSync(folder) ? projectFingerprint(folder) : null;
  const facts = ctx.facts();
  const tables = facts.tables.map((t) => {
    const c = by.get(t.source), entry = sources.file?.tables.find((e) => e.table === t.source);
    return {
      ...catalogTable(t, entry),
      // a table the sync has not reached is waiting for its copy (no copy yet), never "copying 0"
      // a copy in a retired layout (src/duck/sync.ts RETIRED_LAYOUT) serves until it is copied again: done, and said
      copy: c && c.phase !== "waiting" ? { phase: (c.phase === "copied" ? "done" : c.phase === "failed" ? "failed" : "copying") as "copying" | "done" | "failed",
        rowsCopied: c.phase === "copied" ? c.rows ?? 0 : c.rowsSoFar ?? 0, updatedAt: c.copiedAt ?? "",
        // while its chunks are read: the chunks done and reading, the measured rate, the time left (src/duck/sync.ts
        // copyProgressNow), so mason wait and status move between two commits
        ...(c.phase === "copying" && c.progress !== undefined ? { progress: c.progress } : {}),
        ...(c.phase === "copied" && c.retired !== undefined ? { retired: c.retired } : {}) } : null,
      error: c?.phase === "failed" ? c.error : null,
      // copied and served, but not kept current by the poll (src/duck/sync.ts POLL_ROW_LIMIT): mason status and wait say so
      ...(c?.unsynced ? { unsynced: c.unsynced } : {}),
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
      version: facts.versionText, standby: facts.standby, changes: ctx.changes, name: sources.file?.name ?? null, file: sources.file?.file ?? null,
      ...(ctx.publication ? { replication: { slot: ctx.slot, publication: ctx.publication.name, owned: ctx.publication.owned } } : {}) },
    // a sources file edited into a mistake while the run is up: the run copies what it read last, and says so
    warnings: [...ctx.warnings, ...(sources.problem ? [`${sources.problem} (Mason copies the tables it read before; mason start reads the file again)`] : [])],
    folder, project, tables,
    // the copies in all: tables added, copied, failed, their rows, the latest sync (the file's size is engine.bytes)
    totals: syncTotals(tables.filter((t) => t.added).length, copies),
    engine: { name: "duckdb", file: ctx.duck.file, bytes: fileBytes(ctx.duck.file), pollSeconds: ctx.duck.pollSeconds },
    jsonPaths: ctx.duck.jsonPaths?.() ?? [],
    // replication mode: where the stream is, its lag and what it applied (mason status and wait render it, streamLines)
    ...(stream !== null ? { stream } : {}),
  };
}

/** a file's size, or null where it cannot be read (the run's own DuckDB file: it exists while the run does) */
function fileBytes(file: string): number | null {
  try { return fs.statSync(file).size; } catch { return null; }   // a size is a nicety of mason status: unknown, not an error
}

async function state(ctx: RunContext): Promise<unknown> {
  return runState(ctx, ctx.duck.copies(), await ctx.duck.stream());
}

/**
 * WHAT A USAGE SAMPLE READS OF THE RUN (src/duck/usage.ts): `/api/state` at that moment, never a second computation of
 * any of it — the copy file's bytes (`engine.bytes`), `totals`, the stalest added table's `sync.ageSeconds`, the
 * stream's `lag` and its slot's `walHeldBytes`, and the copies served.
 */
export async function usageFacts(ctx: RunContext, now = Date.now()): Promise<UsageFacts> {
  const copies = ctx.duck.copies();
  const s = runState(ctx, copies, await ctx.duck.stream(), now) as { totals: SyncTotals; engine: { bytes: number | null };
    tables: Array<{ added: boolean; sync?: TableSync }>; stream?: StreamStatus };
  const ages = s.tables.flatMap((t) => (t.added && t.sync?.ageSeconds != null ? [t.sync.ageSeconds] : []));
  const slot = s.stream?.slot;
  return { copyBytes: s.engine.bytes, totals: s.totals, oldestSyncSeconds: ages.length ? Math.max(...ages) : null, streamLag: s.stream?.lag ?? null,
    copied: copies.filter((c) => c.phase === "copied").map((c) => c.source), slotWalHeldBytes: slot !== undefined && "walHeldBytes" in slot ? slot.walHeldBytes : null };
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
 * each level at its highest. And each copy's own bytes as last measured, how often a sample is taken, and the days
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
  const samples = await u.samples({ since, until, ...(step === null ? {} : { stepSeconds: step }) });
  return { since, until, stepSeconds: step, sampleSeconds: u.sampleSeconds, keptDays: u.days, samples, copySizes: await u.copySizes() };
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
    throw new Refusal(409, `${shownPath(ctx.root, at.file)}: url: now names ${maskedUrl(at.read.resolved)} (${at.read.from}), and this run copies ${maskedUrl(ctx.runUrl)}: ` +
      "mason stop && mason start copies from the new one, then add or remove the table");
  }
  return at;
}

/** The database this run copies, as an edit is checked against it: the catalog it last read, and how it reads changes. */
const catalogOf = (ctx: RunContext): EditCatalog => ({ tables: ctx.facts().tables, database: ctx.source.database, replication: ctx.changes === "replication" });

/**
 * ADD A TABLE: the check-and-write every entrance shares (src/cli/source-edit.ts addEntry), against the file on disk and
 * this run's catalog; the caller tells the run the file changed, and the sync starts the copy.
 */
export function pick(ctx: RunContext, table: string, columns: readonly string[] = ["*"], key: readonly string[] | null = null): PickResult {
  return addEntry(sourceOnDisk(ctx), catalogOf(ctx), table, columns, key);
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

/** One file of the web page: its bytes and its content type. */
export interface PageFile { body: Buffer; type: string }

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
  "/pages/logs.js": ["pages/logs.js", "text/javascript; charset=utf-8"],
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
    return [route, { body, type }];
  }));
}

export function createRunServer(ctx: RunContext): http.Server {
  const saidErrors = new Set<string>();
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
          res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length }).end(req.method === "HEAD" ? undefined : file.body);
        } else if (req.method === "GET" && url.pathname === "/api/ping") {
          // what proves a run is up (src/cli/runs.ts answers): this token answered, by this process
          sendJson(res, 200, { pid: process.pid });
        } else if (req.method === "GET" && url.pathname === "/api/state") {
          sendJson(res, 200, await state(ctx));
        } else if (req.method === "GET" && url.pathname === "/api/slow") {
          // the last day's slow statements, from the request log (src/duck/requests.ts)
          sendJson(res, 200, { slow: await ctx.duck.requests.slow(SLOW_MS), slowMs: SLOW_MS });
        } else if (req.method === "GET" && url.pathname === "/api/refused") {
          sendJson(res, 200, await ctx.duck.requests.refused());
        } else if (req.method === "GET" && url.pathname === "/api/requests") {
          // the filters, read as mason logs --requests reads its options (src/cli/request-filter.ts)
          const q = requestFilter(requestFilterText(url.searchParams));
          if ("message" in q) { sendFailure(res, 400, q); return; }
          sendJson(res, 200, { ...await ctx.duck.requests.page(q), keptDays: ctx.duck.requests.days });
        } else if (req.method === "GET" && url.pathname === "/api/queries") {
          // the last day's and week's statements in one scan of the request log (mason status); asked on its own, never
          // with /api/state, which the page asks every 2 s
          sendJson(res, 200, { queries: await ctx.duck.requests.summary() });
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
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { table?: unknown; picked?: unknown; columns?: unknown; key?: unknown };
          if (typeof body.table !== "string" || typeof body.picked !== "boolean") throw new Refusal(400, "send { table, picked, columns?, key? }");
          if (body.columns !== undefined && !(Array.isArray(body.columns) && body.columns.every((c) => typeof c === "string"))) throw new Refusal(400, "columns is a list of column names, or [\"*\"]");
          if (body.key !== undefined && !(Array.isArray(body.key) && body.key.length > 0 && body.key.every((c) => typeof c === "string"))) throw new Refusal(400, "key is a list of column names");
          if (body.picked) {
            const r = pick(ctx, body.table, (body.columns as string[] | undefined) ?? ["*"], (body.key as string[] | undefined) ?? null);
            if (!r.already) ctx.log(`added ${r.table} to ${r.file}`);
            ctx.sourcesChanged();
            sendJson(res, 200, { ...r, state: await state(ctx) });
          } else {
            const r = removeTables(ctx, [body.table]);
            for (const t of r.removed) ctx.log(`removed ${t} from ${r.file}`);
            ctx.sourcesChanged();
            sendJson(res, 200, { ...r, state: await state(ctx) });
          }
        } else if (req.method === "GET" && url.pathname === "/api/users") {
          // mason user list --json's shape: the users, and whether each connects (and with ?lastUsed=1 when each was last used)
          const r = listUsers(ctx.users.file, ctx.users.apiKey, postgresLink(ctx.users.postgresUrl));
          if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
          // the last use is a scan of the request log: only when asked (?lastUsed=1, mason user list), never for the web page's
          // poll every 2 s, which does not show it
          const used = url.searchParams.get("lastUsed") === "1" ? await withLastUsed(r.users, ctx.duck.requests, ctx.log)
            : { users: r.users, lastUsedNote: LAST_USED_NOT_ASKED, requestLogDays: ctx.duck.requests.days };
          sendJson(res, 200, { ...used, urlNote: null, next: nextJson([["mason user add <name>", "a user for a tool: its password and URL, printed once"]]) });
        } else if (req.method === "POST" && url.pathname === "/api/users") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { name?: unknown };
          if (typeof body.name !== "string") throw new Refusal(400, "send { name }: the user's name");
          // mason user add --json's shape: its password, once, and the URL to paste (this run is up, so it has one)
          const r = addUser(ctx.users.file, ctx.users.apiKey, body.name, { link: postgresLink(ctx.users.postgresUrl), database: ctx.users.database });
          if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
          const { replaced, ...added } = r;
          ctx.log(`user ${added.user} added${replaced ? " (in place of one the API key's rotation had removed)" : ""}`);
          sendJson(res, 200, { ...added, next: nextJson(addedNext(added.user, true)) });
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
