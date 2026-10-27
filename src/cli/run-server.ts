/**
 * THE RUN'S COMMAND SERVER (`mason start`; a server for the `mason` command alone, the CLI's UI part dropped
 * completely). `mason tables`, `mason add`, `mason status`, `mason wait`, `mason sync` and
 * `mason logs --requests` ask it (src/cli/control.ts): it reads the database's catalog, writes the tables added and
 * removed into the project's sources file (src/cli/sources.ts) — the sync, told of the change, starts copying a table at
 * once — and says where everything is.
 *
 * Every request passes the run's guard (src/cli/security.ts): loopback, the Host header, and the run's token, which
 * the commands send as `Authorization: Bearer` from the run's settings file.
 *
 * What it knows it reads where the run keeps it: the copies from the sync (src/duck/sync.ts), the statements from the
 * request log (src/duck/requests.ts). Added is a fact about the project's files: a table is added when its sources file
 * names it.
 *
 * THE WEB PAGE (src/web/, `mason ui`, docs/WEB-UI.md): under `mason start` it also serves one page and its two files,
 * from an allowlist read when it starts (`pageFiles`), and the users the page manages (`/api/users`, the functions
 * `mason user` calls). The page reads the same JSON the commands read; a refusal carries `failure`, the CLI's Failure
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
import { errorJson, nextJson, type Failure } from "./command.ts";
import { readiness } from "./readiness.ts";
import { addedNext, addUser, listUsers, removeUser, REMOVED_NEXT } from "./user.ts";
import { postgresLink } from "./pg-url.ts";
import { addedTables, catalogTable, chooseColumns, entryName, entryProblems, findEntry, parseSourceText, shownPath, sourceFailure, sourceFileNames, sourcesDir, unaddableReason,
  withoutTable, withTable, type ProjectSource, type SourceFile } from "./sources.ts";
import { PollRefused, type CopyState, type PolledTable, type StreamStatus } from "../duck/sync.ts";
import type { RequestLedger } from "../duck/requests.ts";
import type { KeptPathStatus } from "../duck/kept.ts";

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
  /** the run's copy: each added table's copy as the sync has it, the file it is in, how often it polls */
  duck: { copies: () => CopyState[]; file: string; pollSeconds: number;
    /** a poll of exactly these tables, now (mason sync; src/duck/sync.ts pollNow) */
    poll: (sources: string[]) => Promise<{ at: string; tables: PolledTable[] }>;
    /** where the replication stream is (src/duck/sync.ts streamStatus): null outside replication mode */
    stream: () => Promise<StreamStatus | null>;
    /** the Postgres listener's requests (src/duck/requests.ts, `_mason.requests`): mason status and mason logs --requests */
    requests: Pick<RequestLedger, "recent" | "slow" | "refused" | "days">;
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
export function runState(ctx: RunContext, copies: readonly CopyState[], stream: StreamStatus | null): unknown {
  const folder = ctx.folder();
  const sources = ctx.sources();
  const by = new Map(copies.map((c) => [c.source, c]));
  const project = folder && fs.existsSync(folder) ? projectFingerprint(folder) : null;
  const facts = ctx.facts();
  const tables = facts.tables.map((t) => {
    const c = by.get(t.source);
    return {
      ...catalogTable(t, sources.file?.tables.find((e) => e.table === t.source)),
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

/** The sources file as it is on disk now, its text and what it says — or why the command server cannot edit it. */
function sourceOnDisk(ctx: RunContext): { file: string; text: string; parsed: SourceFile } {
  const folder = ctx.folder();
  if (!folder) throw new Refusal(409, "choose the project's folder first");
  const names = sourceFileNames(folder);
  if (names.length !== 1) throw new Refusal(409, `${path.relative(ctx.root, sourcesDir(folder)) || sourcesDir(folder)}/ has ${names.length ? `${names.length} source files` : "no source file"}: one source per project for now`);
  const file = path.join(sourcesDir(folder), names[0]!);
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseSourceText(text, names[0]!.replace(/\.ya?ml$/, ""), file);
  if ("problems" in parsed) {
    const f = sourceFailure(file, ctx.root, parsed.problems);
    throw new Refusal(409, `${f.message}${f.why ? `\n${f.why}` : ""} — fix it first`);
  }
  // the database the file names NOW must be the one this run copies: its catalog is what an edit is checked against
  const read = ctx.readSource();
  if ("message" in read) throw new Refusal(409, `${read.message}${read.why ? `\n${read.why}` : ""} — fix it first`);
  if (read.resolved !== ctx.runUrl) {
    throw new Refusal(409, `${shownPath(ctx.root, file)}: url: now names ${maskedUrl(read.resolved)} (${read.from}), and this run copies ${maskedUrl(ctx.runUrl)}: ` +
      "mason stop && mason start copies from the new one, then add or remove the table");
  }
  return { file, text, parsed };
}

/** The file's other entries against the database: an edit is never written over a file the run would not take. */
function othersHold(ctx: RunContext, parsed: SourceFile, without: readonly string[], then: string): void {
  const others = { ...parsed, tables: parsed.tables.filter((e) => !without.includes(e.table)) };
  const held = addedTables(others, ctx.facts().tables, ctx.source.database, ctx.root, { replication: ctx.changes === "replication" });
  if (!Array.isArray(held)) throw new Refusal(409, `${held.message}${held.why ? `\n${held.why}` : ""} — fix it first, then ${then}`);
}

/** What `mason add` did to one table: its entry in the sources file, and what the columns asked for left out. */
export interface PickResult {
  table: string;
  /** the sources file, absolute */
  file: string;
  /** the entry's key (`orders`, `billing.invoices`), and what it copies */
  entry: string; columns: string[] | null; exclude: string[]; key: string[] | null;
  /** the key's columns added to a --columns list (a copy always has its key) */
  addedKey: string[];
  /** secret-looking columns every-column left out (sources.ts looksSecret) */
  skippedSecrets: string[];
  /** the file named it so already: nothing was written */
  already: boolean;
}

/**
 * ADD A TABLE: its entry in the sources file, written — after the last one, or in place of the table's own (`withTable`):
 * every other byte of the file as it was. `columns` are the ones asked (`["*"]`: every one); `key` the columns a table
 * with no primary key is copied by. The file's other entries must hold against the database first: an edit is never
 * written over a file the next start would refuse.
 */
export async function pick(ctx: RunContext, table: string, columns: readonly string[] = ["*"], key: readonly string[] | null = null): Promise<PickResult> {
  const { file, text, parsed } = sourceOnDisk(ctx);
  const facts = ctx.facts();
  const t = facts.tables.find((x) => x.source === table);
  if (!t) throw new Refusal(404, `${table} is not a table of ${ctx.source.database} that this user can read`);
  if (key !== null && t.key.length) throw new Refusal(400, `${table} has a primary key (${t.key.join(", ")}), which Mason copies it by: leave --key out`);
  if (key === null && !t.key.length) throw new Refusal(409, `${table} cannot be added: ${unaddableReason(t)}`);
  if (key !== null && ctx.changes === "replication") throw new Refusal(409, `${table} has no primary key, and logical replication cannot apply its changes by --key: copy it by polling (mason start --poll), then add it`);
  const chosen = chooseColumns(t, columns, key);
  if ("problem" in chosen) throw new Refusal(400, chosen.problem);
  othersHold(ctx, parsed, [table], `add ${entryName(table)}`);
  const was = parsed.tables.find((e) => e.table === table);
  const entry = { name: was?.name ?? entryName(table), table, columns: chosen.columns, exclude: chosen.exclude, key: key === null ? null : [...key] };
  // the entry itself, as the run will read it: a --key that does not tell the rows apart is refused here, not at the copy
  const own = entryProblems(t, entry, facts.tables, ctx.source.database, { replication: ctx.changes === "replication" });
  if (own.length) throw new Refusal(400, own.join("; "));
  const same = was !== undefined && JSON.stringify([was.columns, was.exclude, was.key]) === JSON.stringify([entry.columns, entry.exclude, entry.key]);
  if (!same) {
    const r = withTable(text, entry);
    if ("problem" in r) throw new Refusal(409, `${path.relative(ctx.root, file)} cannot be edited: ${r.problem}`);
    fs.writeFileSync(file, r.text);
  }
  return { table, file, entry: entry.name, columns: entry.columns, exclude: entry.exclude, key: entry.key, addedKey: chosen.addedKey, skippedSecrets: chosen.skipped, already: same };
}

export interface RemoveResult { removed: string[]; file: string }

/**
 * REMOVE TABLES from the sources file: each one's entry cut (`withoutTable`), every other byte of the file as it was; the
 * run then drops its copy. A name the file does not have is refused with the closest one it has.
 */
export async function removeTables(ctx: RunContext, names: readonly string[]): Promise<RemoveResult> {
  const { file, text, parsed } = sourceOnDisk(ctx);
  const entries = names.map((n) => {
    const e = findEntry(parsed, n);
    if ("problem" in e) throw new Refusal(e.usage ? 400 : 404, e.problem);
    return e;
  });
  // what stays must hold: else the run's re-read refuses the file, keeps the removed table and goes on copying it
  othersHold(ctx, parsed, entries.map((e) => e.table), `remove ${names.join(" ")}`);
  let out = text;
  for (const e of entries) {
    const r = withoutTable(out, e.table);
    if (r === null) continue;
    if ("problem" in r) throw new Refusal(409, `${path.relative(ctx.root, file)} cannot be edited: ${r.problem}`);
    out = r.text;
  }
  fs.writeFileSync(file, out);
  return { removed: [...new Set(entries.map((e) => e.table))], file };
}

/** A refusal the command shows as it is; `failure` is how the web page says it (the CLI's Failure: why, fix, next), by
 *  default the message alone under the status's code. */
export class Refusal extends Error {
  readonly status: number;
  readonly failure: Failure;
  constructor(status: number, message: string, failure?: Failure) { super(message); this.status = status; this.failure = failure ?? { message, code: codeOf(status) }; }
}

/** The FAILURE_CODES code (src/cli/command.ts) of a refusal by its HTTP status. */
const codeOf = (status: number): string => status === 400 ? "usage" : status === 404 ? "not_found" : status >= 500 ? "failed" : "refused";
/** The HTTP status of a Failure by its code: the other way round. */
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
          const limit = Number(url.searchParams.get("limit") ?? 40);
          if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Refusal(400, "limit is a whole number of requests, 1 to 10000");
          sendJson(res, 200, { requests: await ctx.duck.requests.recent({ limit, failed: url.searchParams.get("failed") === "1" }), keptDays: ctx.duck.requests.days });
        } else if (req.method === "POST" && url.pathname === "/api/pick") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { table?: unknown; picked?: unknown; columns?: unknown; key?: unknown };
          if (typeof body.table !== "string" || typeof body.picked !== "boolean") throw new Refusal(400, "send { table, picked, columns?, key? }");
          if (body.columns !== undefined && !(Array.isArray(body.columns) && body.columns.every((c) => typeof c === "string"))) throw new Refusal(400, "columns is a list of column names, or [\"*\"]");
          if (body.key !== undefined && !(Array.isArray(body.key) && body.key.length > 0 && body.key.every((c) => typeof c === "string"))) throw new Refusal(400, "key is a list of column names");
          if (body.picked) {
            const r = await pick(ctx, body.table, (body.columns as string[] | undefined) ?? ["*"], (body.key as string[] | undefined) ?? null);
            if (!r.already) ctx.log(`added ${r.table} to ${r.file}`);
            ctx.sourcesChanged();
            sendJson(res, 200, { ...r, state: await state(ctx) });
          } else {
            const r = await removeTables(ctx, [body.table]);
            for (const t of r.removed) ctx.log(`removed ${t} from ${r.file}`);
            ctx.sourcesChanged();
            sendJson(res, 200, { ...r, state: await state(ctx) });
          }
        } else if (req.method === "GET" && url.pathname === "/api/users") {
          // mason user list --json's shape: the users, and whether each connects
          const r = listUsers(ctx.users.file, ctx.users.apiKey);
          if ("message" in r) { sendFailure(res, statusOf(r), r); return; }
          sendJson(res, 200, { ...r, next: nextJson([["mason user add <name>", "a user for a tool: its password and URL, printed once"]]) });
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
          const r = await removeTables(ctx, body.tables as string[]);
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
