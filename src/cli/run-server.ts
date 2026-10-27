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
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { readBody, sendJson } from "../lib/http-json.ts";
import { projectFingerprint } from "../lib/project-files.ts";
import { guard, SECURITY_HEADERS } from "./security.ts";
import type { ChangeSource } from "../cdc/poll.ts";
import { maskedUrl, type Source, type SourceFacts } from "./preflight.ts";
import type { Failure } from "./command.ts";
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
      copy: c && c.phase !== "waiting" ? { phase: c.phase === "copied" ? "done" : c.phase === "failed" ? "failed" : "copying",
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
    source: { url: maskedUrl(ctx.source.url), host: ctx.source.host, database: ctx.source.database, remote: ctx.source.remote,
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

/** A refusal the command shows as it is. */
export class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createRunServer(ctx: RunContext): http.Server {
  const saidErrors = new Set<string>();
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
        if (req.method === "GET" && url.pathname === "/api/ping") {
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
        } else if (req.method === "POST" && url.pathname === "/api/sync") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { tables?: unknown };
          if (!Array.isArray(body.tables) || !body.tables.length || !body.tables.every((x) => typeof x === "string")) throw new Refusal(400, "send { tables: [schema.table, …] }");
          try { sendJson(res, 200, await ctx.duck.poll(body.tables as string[])); }
          catch (e) { if (e instanceof PollRefused) { sendJson(res, e.code === "not_found" ? 404 : 409, { error: e.message, code: e.code }); return; } throw e; }
        } else if (req.method === "POST" && url.pathname === "/api/remove") {
          const body = JSON.parse(await readBody(req, 64 * 1024)) as { tables?: unknown };
          if (!Array.isArray(body.tables) || !body.tables.length || !body.tables.every((m) => typeof m === "string")) throw new Refusal(400, "send { tables: [name, …] }");
          const r = await removeTables(ctx, body.tables as string[]);
          // the sync stops copying a removed table, and drops its copy
          ctx.sourcesChanged();
          for (const t of r.removed) ctx.log(`removed ${t} from ${r.file}`);
          sendJson(res, 200, { ...r, state: await state(ctx) });
        } else {
          sendJson(res, 404, { error: `no ${req.method} ${url.pathname}: this is mason start's server for the mason command (mason --help)` });
        }
      } catch (e) {
        if (e instanceof Refusal) { sendJson(res, e.status, { error: e.message }); return; }
        if (e instanceof SyntaxError) { sendJson(res, 400, { error: `the body is not JSON: ${e.message}` }); return; }
        // said ONCE per distinct reason: a command may ask every second, and a stack a second buried the terminal
        const why = ((e as Error).message.split("\n---\n").pop() ?? String(e)).split("\n")[0]!;
        const key = `${url.pathname} ${why}`;
        if (!saidErrors.has(key)) { saidErrors.add(key); ctx.log(`command server: ${req.method} ${url.pathname} failed: ${why}`); }
        sendJson(res, 500, { error: (e as Error).message });
      }
    })();
  });
}
