/**
 * THE WEB PAGE (src/web/app.js, `mason ui`) under node: what it WRITES from the command server's JSON, never geometry.
 * The fixtures are the server's own: `runState` (src/cli/run-server.ts) over synthetic copies — a run ready, one copying
 * with its chunks' progress, one whose copy failed, a table served but not kept current — and, for a run that stopped,
 * the answers a page gets then (nothing at all; the guard's 403 to a cookie of an earlier run). The page's words are
 * held equal to the commands' (`tableLines`, `copyingText`, `duration`, `sourceRows`, `tableFacts`, `addedLines`,
 * `removedReport`), so the two cannot drift; the
 * app is driven over a fake `fetch`, asserting on the parts of the page it writes and the state it keeps.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import * as pgUrl from "../src/cli/pg-url.ts";
const { psqlLine } = pgUrl;
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { catalogTable, parseSourceText } from "../src/cli/sources.ts";
import type { CopyProgressView, CopyState } from "../src/duck/sync.ts";
import type { RunState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";
import * as syncCommand from "../src/cli/sync.ts";
import { PLAIN } from "../src/cli/style.ts";
import { EVENT_KINDS, type SyncEvent } from "../src/duck/events.ts";
import { timeOf } from "../src/cli/request-filter.ts";
import type { LedgerRequest } from "../src/duck/requests.ts";
import type { RolesLive } from "../src/duck/grants.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
// imported when the tests run: at a commit without the page the file still loads, and each test fails by name
const page = await import(path.join(WEB, "app.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
type Fn<A extends unknown[], R> = (...a: A) => R;
const fn = <A extends unknown[], R>(name: string): Fn<A, R> => {
  const f = page[name];
  assert.equal(typeof f, "function", `src/web/app.js exports ${name}`);
  return f as unknown as Fn<A, R>;
};
interface Failure { code: string; message: string; why?: string; fix?: string; next?: Array<{ command: string; what?: string }> }
interface App {
  model: Record<string, unknown>;
  show(page: string, env?: unknown): void; poll(): Promise<void>; settled(): Promise<unknown>; addUser(name: string, role?: string): Promise<boolean>; askRemove(name: string): void; cancelRemove(): void;
  confirmRemove(name: string): Promise<boolean>; dismissAdded(): void; view(): Record<string, string>;
  addTable(table: string, columns?: string[], key?: string[]): Promise<boolean>; choose(table: string): Promise<boolean>; cancelChoose(): void;
  askRemoveTable(table: string): void; cancelRemoveTable(): void; confirmRemoveTable(table: string): Promise<boolean>; dismissOutcome(): void;
}

/** What a reader sees of some HTML: its text, tags gone and entities read, spaces collapsed. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The popovers of some HTML (`pop` of src/web/shared.js: a confirm, a form, an answer, written after its table), each
 *  { anchor, html }, in their order; `popOf(html, anchor)` the one beside that element (a row's actions), or "". */
const popsOf = (html: string): Array<{ anchor: string; html: string }> => {
  const out: Array<{ anchor: string; html: string }> = [];
  for (const m of html.matchAll(/<div class="pop [^"]*" data-anchor="([^"]*)"/g)) {
    let depth = 0, i = m.index!;
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = i;
    for (let t = tag.exec(html); t !== null; t = tag.exec(html)) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { out.push({ anchor: m[1]!.replace(/&quot;/g, "\"").replace(/&amp;/g, "&"), html: html.slice(i, tag.lastIndex) }); break; }
    }
  }
  return out;
};
const popOf = (html: string, anchor: string): string => popsOf(html).find((p) => p.anchor === anchor)?.html ?? "";
/** The HTML without its popovers: what the table itself says. */
const withoutPops = (html: string): string => popsOf(html).reduce((h, p) => h.replace(p.html, ""), html);

// ------------------------------------------------------------------ fixtures: the server's runState over synthetic copies

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [] });
const TABLES = [table("customers", 1200), table("orders", 2_000_000), table("events", 30_000_000), table("audit", 50)];
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const parsedDemo = parseSource("postgres://demo@127.0.0.1:5434/demo");
const demoSource = "source" in parsedDemo ? parsedDemo.source : assert.fail(parsedDemo.problem);
const sourceFile = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in sourceFile));

/** The state /api/state answers for these copies (src/cli/run-server.ts runState), as JSON travels. */
function stateOf(copies: CopyState[], o: { warnings?: string[]; replication?: boolean; tables?: SourceTable[]; sources?: typeof sourceFile; demo?: boolean; now?: number; keptDays?: number; roles?: RolesLive } = {}): RunState {
  const ctx = {
    ...(o.roles ? { roles: () => o.roles } : {}),
    source: o.demo ? demoSource : source, ...(o.demo ? { demo: true } : {}),
    facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: o.tables ?? TABLES, systemIdentifier: null }),
    warnings: o.warnings ?? [], replication: () => o.replication ? { slot: "mason_dev_shop", publication: "app_pub", owned: false } : null,
    page: true, users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: o.sources ?? sourceFile, problem: null }),
    listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: o.keptDays ?? 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, copies, null, o.now))) as RunState;
}
const copied = (source: string, rows: number, at: string): CopyState => ({ source, phase: "copied", rows, bytes: 1, seconds: 1, copiedAt: at, error: null });
const progress: CopyProgressView = { chunksDone: 3, chunksTotal: 20, reading: 2, readingSeconds: 14, rowsReading: 41_000, rowsPerSecond: 52_300.4, bytesPerSecond: 1e6, secondsLeft: 340, share: 0.157 };
const RUNNING = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"), copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z")]);
const COPYING = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"),
  { source: "public.orders", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 280_000, rowsEstimate: 2_000_000, progress },
  { source: "public.events", phase: "waiting", rows: null, bytes: null, seconds: null, copiedAt: null, error: null }]);
const FAILED = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"),
  { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null, error: "could not read the next chunk: connection reset\nthe sync tries it again in 5 min" },
  { ...copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"), kept: { by: "poll", sync: { mode: "off" }, syncedAt: "2026-10-27T09:04:00.000Z", nextAt: null } }],
  { warnings: ["mason/sources/shop.yml: tables.ordrs: no such table (Mason syncs the tables it read before; mason start reads the file again)"], replication: true });
const NONE = stateOf([]);
for (const s of [NONE]) for (const t of s.tables) t.added = false;

// the tables section's database: beside the four, a table with a secret-looking column, one with no primary key (a unique
// index over two NOT NULL columns, which its reason names) and one never analysed (its rows unknown)
const KEYLESS: SourceTable = { source: "public.event_log", schema: "public", table: "event_log", key: [], rows: 900, bytes: 8192, comment: null,
  columns: [{ ...col("tenant_id", "bigint"), notNull: true }, { ...col("id", "bigint"), notNull: true }, col("payload", "jsonb")], foreignKeys: [],
  uniqueKeys: [{ name: "event_log_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] };
const CATALOG = [...TABLES, { ...table("accounts", 300), columns: [col("id", "bigint"), col("email"), col("password_hash")] }, KEYLESS, { ...table("staging", 0), rows: null }];
const THREE_COPIED = () => [copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"),
  copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z")];
const CATALOG_STATE = stateOf(THREE_COPIED(), { tables: CATALOG });
// the same database once public.accounts is added: its copy not yet started
const withAccounts = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n  accounts: { exclude: [password_hash] }\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in withAccounts));
const ACCOUNTS_ADDED = stateOf(THREE_COPIED(), { tables: CATALOG, sources: withAccounts });
const FILE = "/app/mason/sources/shop.yml";
/** `GET /api/tables/<table>/columns`'s answer for a table of CATALOG (src/cli/run-server.ts tableColumns): what its form ticks. */
const columnsOf = (name: string) => ({ table: name, columns: catalogTable(CATALOG.find((t) => t.source === name)!, undefined).columns });
/** `/api/pick`'s answers (src/cli/run-server.ts PickResult): every column with a secret left out, a --columns list
 *  the key was added to, a table with no primary key added by --key, one the file named so already. */
/** each table's sync as /api/pick answers it (src/cli/source-edit.ts PickResult): the file's default, its own, a big one written off */
const OFF = { sync: { value: "off", from: "default" }, bigOff: false, pollCost: null, notReplicated: null };
const PICKED = {
  secret: { table: "public.accounts", file: FILE, entry: "accounts", columns: null, exclude: ["password_hash"], key: null, addedKey: [], skippedSecrets: ["password_hash"], already: false, ...OFF },
  columns: { table: "public.audit", file: FILE, entry: "audit", columns: ["id", "name"], exclude: [], key: null, addedKey: ["id"], skippedSecrets: [], already: false,
    sync: { value: "poll 30s", from: "entry" }, bigOff: false, pollCost: null, notReplicated: null },
  keyed: { table: "public.event_log", file: FILE, entry: "event_log", columns: null, exclude: [], key: ["tenant_id", "id"], addedKey: [], skippedSecrets: [], already: false,
    sync: { value: "off", from: "entry" }, bigOff: true, pollCost: null, notReplicated: null },
  already: { table: "public.customers", file: FILE, entry: "customers", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [], already: true,
    sync: { value: "poll 5s", from: "file" }, bigOff: false, pollCost: "customers has about 40,000,000 rows, and each poll scans it whole on your database: …", notReplicated: null },
  // a key: table under a file whose default is replication: written sync: poll 5m, and why
  notReplicated: { table: "public.event_log", file: FILE, entry: "event_log", columns: null, exclude: [], key: ["tenant_id", "id"], addedKey: [], skippedSecrets: [], already: false,
    sync: { value: "poll 5m", from: "entry" }, bigOff: false, pollCost: null, notReplicated: "it has no primary key, so logical replication cannot apply its changes by its key:" },
  // one the file's replication keeps current
  replicated: { table: "public.orders", file: FILE, entry: "orders", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [], already: false,
    sync: { value: "replication", from: "file" }, bigOff: false, pollCost: null, notReplicated: null },
};
const answer = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

// the copies with their syncs (src/duck/sync.ts Synced), as of 09:05:30: one kept current by the poll 30 s ago, one whose
// poll failed (its copy served as it was), one over the poll's row limit copied 90 s ago
const NOW = Date.parse("2026-10-27T09:05:30.000Z");
const SYNCED = stateOf([{ ...copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), synced: { at: "2026-10-27T09:05:00.000Z", seconds: 0.42, by: "poll" } },
  { ...copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"), phase: "failed", error: "poll: connection reset\nthe sync tries it again in 5 s", synced: { at: "2026-10-27T08:00:09.000Z", seconds: 63, by: "copy" } },
  { ...copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"), kept: { by: "poll", sync: { mode: "off" }, syncedAt: "2026-10-27T09:04:00.000Z", nextAt: null }, synced: { at: "2026-10-27T09:04:00.000Z", seconds: 754, by: "copy" } }],
  { now: NOW });
const QUERIES = { queries: { keptDays: 3,
  day: { days: 1, covered: 1, statements: 1234, completed: 1200, refused: 30, failed: 3, cancelled: 1, rows: 98_765, bytesSent: 5_400_000, durationMs: { avg: 42, p50: 12, p95: 380 } },
  week: { days: 7, covered: 3, statements: 5000, completed: 4900, refused: 90, failed: 9, cancelled: 1, rows: 400_000, bytesSent: 900, durationMs: { avg: 40, p50: 11, p95: 1_250 } } } };
/** `GET /api/activity?since=`'s answer (src/cli/run-server.ts `activity`): the range's window, who sent statements, the slowest. */
const CLIENTS = [{ user: "metabase", tokenName: "", client: "Metabase v0.50", statements: 1100, failed: 9, sessions: 3, last: "2026-10-27T09:05:00.000Z" },
  { user: "", tokenName: "ci", client: "", statements: 104, failed: 0, sessions: 1, last: "2026-10-27T08:05:30.000Z" }];
const activityOf = (o: { window?: Record<string, unknown>; clients?: unknown[]; slowest?: unknown[]; clientsTotal?: { clients: number; sessions: number } } = {}) => ({ since: "2026-10-26T09:05:30.000Z", keptDays: 7,
  window: { days: 1, covered: 1, statements: 1204, completed: 1190, refused: 10, failed: 2, cancelled: 2, rows: 52_000, bytesSent: 3_145_728, durationMs: { avg: 120, p50: 40, p95: 900 }, ...o.window },
  clients: o.clients ?? CLIENTS, slowest: o.slowest ?? [],
  clientsTotal: o.clientsTotal ?? { clients: (o.clients ?? CLIENTS).length, sessions: (o.clients ?? CLIENTS).reduce((a: number, c) => a + (c as { sessions: number }).sessions, 0) } });
const EVENT: SyncEvent = { at: "2026-10-27T09:03:10.123Z", kind: "poll_failed", failed: true, table: "public.orders", message: "poll: connection reset\nthe sync tries it again in 5 s" };
const EVENTS = { events: [EVENT, { at: "2026-10-27T09:04:00.000Z", kind: "restart", failed: true, table: null, message: "the run was started again after it stopped" }], keptDays: 7 };
const REQUEST: LedgerRequest = { requestId: "0b9e5c1e-0000-4000-8000-000000000001", startedAt: "2026-10-27T09:02:00.500Z", session: 7, applicationName: "Metabase", clientAddress: null, tokenName: "", user: "metabase", role: "", attributes: null,
  method: "QUERY", outcome: "refused", status: "failed", sqlstate: "42P01", message: "relation \"nope\" does not exist\nLINE 1", detail: null, hint: null, rows: null, durationMs: 3,
  endedAt: "2026-10-27T09:02:00.503Z", bytesSent: 120, query: "SELECT *\n  FROM nope", queryTruncated: false, plan: null, planTruncated: false };
const FAILED_REQUESTS = { requests: [REQUEST, { ...REQUEST, requestId: "0b9e5c1e-0000-4000-8000-000000000002", applicationName: "", user: "", outcome: "cancelled", sqlstate: "57014",
  message: "canceling statement due to user request", rows: 10, durationMs: 12_345, query: `SELECT ${"x, ".repeat(60)}1` }], keptDays: 7 };
const USAGE = { since: "2026-10-27T09:04:30.000Z", until: "2026-10-27T09:05:30.000Z", stepSeconds: null, sampleSeconds: 60, keptDays: 7, samples: [],
  copySizes: [{ table: "public.customers", bytes: 524_288, at: "2026-10-27T09:00:00.000Z" }, { table: "public.events", bytes: 3_221_225_472, at: "2026-10-27T09:00:00.000Z" }] };

/** What the Overview reads, in order: the state every poll, the request log's every 30 s. */
const STATUS_READS = ["GET api/state", "GET api/queries", "GET api/events?failed=1&limit=5", "GET api/requests?failed=1&limit=5", "GET api/unsupported?limit=100", "GET api/users"];
/** The Overview's first poll: those, and the last 24 hours of usage its cards' sparklines draw (read once a minute). */
const STATUS_FIRST = [...STATUS_READS, "GET api/usage?since=24h&step=3600"];
/** The run's word at the top of the Overview, as it is written: a big dot, then the word. */
const HEALTH = (kind: string, word: string) => new RegExp(`^<div class="health ${kind}" role="status"><span class="dot" aria-hidden="true"></span><span class="word">${word}</span></div>`);

// ------------------------------------------------------------------ the DOM-free helpers, held to the commands'

test("the helpers: a share as the commands' percent, seconds left and a span as theirs, every value escaped", () => {
  const percent = fn<[number], string>("percent"), leftText = fn<[number | null], string>("leftText"), duration = fn<[number], string>("duration"), esc = fn<[unknown], string>("esc");
  assert.deepEqual([0, 0.157, 0.999, 1, 1.4, -1].map(percent), ["0%", "15%", "99%", "100%", "100%", "0%"]);
  assert.deepEqual([45, 340, 7500].map(leftText), ["~45 s left", "~6 min left", "~2 h 5 min left"]);
  assert.equal(leftText(null), "");
  for (const s of [0, 0.4, 1, 44.6, 89, 90, 600, 5399, 5400, 7500, 86_400]) assert.equal(duration(s), commands.duration(s), `duration(${s}) is the commands'`);
  // a duration in ms: ONE formatter, the commands' (msText), on every page that says a statement's or a sync's time
  const msText = fn<[number], string>("msText");
  for (const ms of [0, 3, 512.4, 999.4, 999.6, 1234, 13_703, 59_949, 59_960, 125_000, 3_599_400, 3_599_600, 3_840_000, 90_061_000, -5]) assert.equal(msText(ms), commands.msText(ms), `msText(${ms}) is the commands'`);
  assert.deepEqual([512, 13_703, 125_000].map(msText), ["512 ms", "13.7 s", "2 min 5 s"]);
  // a STATEMENT's time: ONE formatter, the commands' (statementMsText), whole ms with separators (issue 816)
  const statementMsText = fn<[number], string>("statementMsText");
  for (const ms of [0, 0.4, 0.5, 27, 810, 999, 999.5, 1000, 19_800, 1_234_567, 90_061_000, -5]) assert.equal(statementMsText(ms), (commands as unknown as { statementMsText: (x: number) => string }).statementMsText(ms), `statementMsText(${ms}) is the commands'`);
  assert.deepEqual([27, 810, 19_800, 1_234_567].map(statementMsText), ["27 ms", "810 ms", "19,800 ms", "1,234,567 ms"]);
  const agoText = fn<[string, number], string>("agoText"), at = Date.parse("2026-10-27T09:00:00Z");
  for (const s of [0, 1, 89, 90, 3600, 5399, 5400, 86_400, -5]) {
    const iso = new Date(at - s * 1000).toISOString();
    assert.equal(agoText(iso, at), commands.ago(iso, at), `agoText of ${s} s is mason status's ago`);
  }
  assert.equal(esc(`<script>"a" & 'b'</script>`), "&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;");
});

test("a copy's line is the commands' line, word for word: copying with its chunks, resumed, past its estimate, every chunk in", () => {
  const copyingText = fn<[number, number | null, unknown?], { fraction: number | null; text: string }>("copyingText");
  const cases: Array<[number, number | null, typeof progress | undefined]> = [
    [280_000, 2_000_000, progress], [0, 2_000_000, { ...progress, chunksDone: 0, reading: 0, rowsPerSecond: null, secondsLeft: null, readingSeconds: null, share: 0 }],
    [120_000, 2_000_000, { ...progress, reading: 1, rowsPerSecond: null, readingSeconds: 3 }], [2_400_000, 2_000_000, { ...progress, reading: 0, chunksDone: 20 }],
    [0, null, undefined], [500, 1000, undefined], [1500, 1000, undefined],
  ];
  for (const [c, est, p] of cases) assert.deepEqual(copyingText(c, est, p), commands.copyingText(c, est, p), JSON.stringify([c, est, p?.reading]));
});

test("each added table's line is mason status's: the table, its percent and what it says, in the commands' order", () => {
  const tableLine = fn<[unknown], { state: string; fraction: number; what: string }>("tableLine");
  const percent = fn<[number], string>("percent");
  for (const s of [RUNNING, COPYING, FAILED]) {
    // tableLines: `<table>  <bar> <pct>  <what>`
    const cli = commands.tableLines(s).map((l) => /^(\S+)\s+[█░]+\s+(\d+%) {2}(.*)$/.exec(l)!.slice(1));
    const ours = s.tables.filter((t) => t.added).map((t) => { const l = tableLine(t); return [t.table, percent(l.fraction), l.what]; });
    assert.deepEqual([...ours].sort(), [...cli].sort());
    // and renderStatus writes them in the commands' order
    // (the page lists the copies not finished only: a finished one is the Tables page's)
    const html = fn<[unknown, unknown?], string>("renderStatus")(s);
    const at = cli.map(([t]) => html.indexOf(`<code class="name" title="${t}">${t}</code>`)).filter((i) => i >= 0);
    if (s !== RUNNING) assert.ok(at.length > 0, "the copies not finished are written");
    assert.deepEqual(at, [...at].sort((a, b) => a - b), "the order mason status lists them in");
  }
});

test("the database's rows are mason status's: its sources file, its URL as the run masked it, how its changes arrive", () => {
  const sourceRows = (commands as unknown as { sourceRows?: (s: RunState) => Array<[string, string]> }).sourceRows;
  assert.equal(typeof sourceRows, "function", "src/cli/commands.ts exports sourceRows");
  for (const s of [RUNNING, FAILED]) assert.deepEqual(fn<[unknown], unknown>("sourceRows")(s), sourceRows!(s));
});

test("a table's line is mason tables': its size, its key, and added or why it cannot be added as it is", () => {
  const cli = (commands as unknown as { tableFacts?: (t: unknown) => unknown }).tableFacts;
  assert.equal(typeof cli, "function", "src/cli/commands.ts exports tableFacts");
  const tableFacts = fn<[unknown], { size: string; key: string; state: string | null }>("tableFacts");
  for (const t of CATALOG_STATE.tables) assert.deepEqual(tableFacts(t), cli!(t), t.table);
  assert.deepEqual(tableFacts(CATALOG_STATE.tables.find((t) => t.table === "public.event_log")), { size: "~900 rows", key: "no key",
    state: "cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id (its unique index event_log_tenant_id_id_key)" });
});

test("a table row-level security hides: the page says mason tables' reason and offers no Add, which the run would refuse (issue 802)", async () => {
  const { listTables } = await import("../src/cli/source-edit.ts");
  const hidden: SourceTable = { ...table("vault", 40), rowSecurityHidesFrom: "mason" };
  const hiddenKeyless: SourceTable = { ...KEYLESS, source: "public.vault_log", table: "vault_log", rowSecurityHidesFrom: "mason" };
  const tables = [...CATALOG, hidden, hiddenKeyless];
  const s = stateOf(THREE_COPIED(), { tables });
  const listed = listTables(sourceFile as Exclude<typeof sourceFile, { problems: unknown }>, { tables, database: "shop" });
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const tableFacts = fn<[unknown], { size: string; key: string; state: string | null }>("tableFacts");
  for (const name of ["public.vault", "public.vault_log"]) {
    const t = s.tables.find((x) => x.table === name)!;
    const cli = listed.find((x) => x.table === name)!;
    assert.ok(cli.reason?.startsWith(`row-level security on ${name} hides every row from mason`), String(cli.reason));
    assert.equal(t.reason, cli.reason, `${name}: the run's state and mason tables, one reason`);
    assert.deepEqual(tableFacts(t), commands.tableFacts(cli), name);
    const row = renderTables(s).split("<tr").find((r) => r.includes(`<code class="name" title="${name}">`))!;
    assert.doesNotMatch(row, /data-add-table/, `${name}: no Add`);
  }
});

test("a table added and tables removed are said as mason add and mason remove print them: the key added, a secret left out", () => {
  const cli = commands as unknown as { addedLines?: (b: unknown, file: string) => unknown; removedReport?: (r: string[], file: string) => unknown };
  assert.equal(typeof cli.addedLines, "function", "src/cli/commands.ts exports addedLines");
  assert.equal(typeof cli.removedReport, "function", "src/cli/commands.ts exports removedReport");
  const addedLines = fn<[unknown, string], unknown>("addedLines"), removedReport = fn<[string[], string], unknown>("removedReport");
  for (const b of Object.values(PICKED)) assert.deepEqual(addedLines(b, FILE), cli.addedLines!(b, FILE), b.table);
  for (const r of [["public.orders"], ["public.orders", "billing.invoices"]]) assert.deepEqual(removedReport(r, FILE), cli.removedReport!(r, FILE));
  const added = (b: unknown) => textOf(fn<[unknown], string>("renderTableAdded")(b));
  assert.equal(added(PICKED.secret), "Added public.accounts to /app/mason/sources/shop.yml: every column but password_hash " +
    "sync: off (the default): after its first sync it is read again only by mason sync accounts — mason add accounts --sync \"poll 5m\" polls it every 5 minutes " +
    "left out password_hash: it looks like a secret, which anyone with a user's password could read (--include password_hash adds it) Dismiss");
  assert.equal(added(PICKED.columns), "Added public.audit to /app/mason/sources/shop.yml: id, name sync: poll 30s (its entry's): polled every 30s after its first sync — " +
    "mason add audit --sync off stops that key added: id (a synced table always has its key) Dismiss");
  assert.match(added(PICKED.keyed), /^Added public\.event_log to \/app\/mason\/sources\/shop\.yml: every column, keyed by tenant_id, id sync: off written on its entry: it has more than 1,000,000 rows/);
  assert.equal(added(PICKED.notReplicated), "Added public.event_log to /app/mason/sources/shop.yml: every column, keyed by tenant_id, id " +
    "sync: poll 5m written on its entry, not the file's replication: it has no primary key, so logical replication cannot apply its changes by its key: — " +
    "mason add event_log --sync \"poll 1h\" polls it hourly; mason add event_log --sync off reads it only by mason sync event_log Dismiss");
  assert.match(added(PICKED.replicated), /^Added public\.orders to \/app\/mason\/sources\/shop\.yml: every column sync: replication \(the file's\): kept current from the database's change log after its first sync/);
  assert.match(added(PICKED.already), /^Added public\.customers to \/app\/mason\/sources\/shop\.yml: every column \(already so\) sync: poll 5s \(the file's\).* customers has about 40,000,000 rows/);
  assert.equal(textOf(fn<[unknown], string>("renderTablesRemoved")({ removed: ["public.orders"], file: FILE })),
    "Removed public.orders from /app/mason/sources/shop.yml Tip: Mason stops syncing it and drops its synced data Dismiss");
});

test("a demo project's database row says it is the demo database Mason hosts, polled only: the page and mason status alike", () => {
  const sourceRows = (commands as unknown as { sourceRows?: (s: RunState) => Array<[string, string]> }).sourceRows!;
  const demoFile = parseSourceText("kind: postgres\nurl: x\nsync: poll 5s\ntables:\n  customers: {}\n", "shop", "/app/mason/sources/shop.yml");
  assert.ok(!("problems" in demoFile));
  const DEMO = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z")], { demo: true, sources: demoFile });
  assert.equal((DEMO.source as { demo?: boolean }).demo, true, "the run's state says it");
  assert.equal((RUNNING.source as { demo?: boolean }).demo, false);
  const rows = sourceRows(DEMO);
  assert.deepEqual(rows.find(([k]) => k === "Database"), ["Database", "the demo database Mason hosts (postgres://demo@127.0.0.1:5434/demo · Postgres 16.4)"]);
  // what the read of a libc order left to say, the CLI's row
  assert.equal(rows.find(([k]) => k === "Text order"), undefined);
  assert.deepEqual(sourceRows({ ...DEMO, source: { ...DEMO.source, textOrder: "en_US.utf8 read from the database" } }).find(([k]) => k === "Text order"), ["Text order", "en_US.utf8 read from the database"]);
  assert.deepEqual(rows.find(([k]) => k === "Changes"), ["Changes", "each table as its sync: says (a SELECT of its changed rows) · sync: poll 5s for every table without its own · the demo database is checked this way only"]);
  assert.deepEqual(fn<[unknown], unknown>("sourceRows")(DEMO), rows);
});

// ------------------------------------------------------------------ what the page writes

test("running: the database masked, each table copied with its rows, the counts, Ready — and never the engine's name", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { now: NOW, queries: QUERIES, events: EVENTS, requests: FAILED_REQUESTS });
  const text = textOf(html);
  assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
  assert.ok(!text.includes("secret"), "the password is the run's to mask, and it did");
  assert.match(text, /Changes each table as its sync: says \(a SELECT of its changed rows\) · sync: off \(the default: the file writes none\) · sync: replication on an entry streams that table as it happens instead/);
  assert.match(text, /Tables synced 3 of 3 added/);
  assert.ok(!/Tables not synced yet|100%/.test(text), "every copy is done: no bar (the Tables page lists them)");
  assert.ok(!text.includes("public.audit"), "a table not added is not a line");
  assert.ok(!/Slow queries|Refused queries|Ready: every added table/.test(text), "the counts and the readiness line repeated the statements, the errors and the word");
  assert.match(html, /<a href="#observability\/queries\?range=24h">Observability › Queries<\/a>/, "the statements are listed on Observability's Queries");
  assert.equal([...html.matchAll(/<table class="facts-table"/g)].length, 1, "ONE table of facts");
  assert.match(html, HEALTH("ok", "Ready"));
  assert.ok(!/duckdb/i.test(html), "the engine is named in the code and the docs, never on the page");
  assert.ok(!/model/i.test(text), "a table is a table");
});

test("copying: the bar's share, the rows, the chunks, the rate and the time left; one waiting; Under way", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(COPYING, {});
  const text = textOf(html);
  assert.match(html, /<tr class="t-copying"><th scope="row"><code class="name" title="public\.orders">public\.orders<\/code><\/th><td class="bar"><span class="copybar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="15"/);
  assert.match(text, /public\.orders 15% syncing 321,000 of ~2,000,000 rows · 2 chunks reading \(14 s\), 3 of ~20 in · 52,300 rows\/s · ~6 min left/);
  // a copy not begun: its shimmer and its words, never a "0%" beside them (it reads as stuck before it starts)
  assert.match(text, /public\.orders 15% syncing .* public\.events waiting for its first sync to start/);
  assert.match(html, /<tr class="t-waiting"><th scope="row"><code class="name" title="public\.events">public\.events<\/code><\/th><td class="bar"><span class="copybar indeterminate" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="public\.events: its first sync" aria-valuetext="waiting for its first sync to start"><span class="track" aria-hidden="true"><span class="fill"[^>]*><\/span><\/span><\/span><\/td>/);
  assert.match(text, /^Under way .* Tables not synced yet \(2 of 3 added\) Table Sync public\.orders 15% /);
  assert.ok(!/public\.customers/.test(text), "a copy that is done is not a bar");
});

test("behind, left out, a failed catch-up, a stream down, off: each table's line is mason status's word for word; the Tables page says Behind and Failed (issue 254)", () => {
  const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();
  const pass = "every polled table's polls took 13 min in the last pass, and Mason waits four times that between passes to keep the database's load to a fifth";
  const gap = "publication app_pub does not carry public.orders: ALTER PUBLICATION app_pub ADD TABLE public.orders — or give its entry sync: poll <interval> in the sources file, which needs no publication";
  const pending = "it is caught up by one poll after its whole read first — after a failure, tried again after 09:10 UTC";
  const every15 = { mode: "poll", every: "15m", seconds: 900 };
  const states: Array<[string, CopyState[]]> = [
    ["behind, the pass", [{ ...copied("public.customers", 1200, ago(7200)), kept: { by: "poll", sync: every15, syncedAt: ago(52 * 60), nextAt: null, promisedSeconds: 960, lateWhy: pass } } as CopyState]],
    ["behind, its own poll", [{ ...copied("public.customers", 1200, ago(7200)), kept: { by: "poll", sync: every15, syncedAt: ago(31 * 60), nextAt: null, promisedSeconds: 1620,
      lateWhy: "its own poll took 6 min, and Mason waits four times a table's poll before its next to keep the database's load to a fifth" } } as CopyState]],
    ["left out", [{ ...copied("public.orders", 2_000_000, ago(7200)), error: `replication: ${gap}`, kept: { by: "replication", slot: "s", state: "left-out", why: gap, position: "0/1",
      lastCommit: null, notRunning: null, syncedAt: ago(7200), promisedSeconds: 120, lateWhy: gap } } as CopyState]],
    ["a failed catch-up", [{ ...copied("public.orders", 2_000_000, ago(7200)), error: "its catch-up poll failed (…): Parser Error: VALUES lists must all be the same length", behind: "after its whole read",
      kept: { by: "poll", sync: every15, syncedAt: ago(7200), nextAt: null, pending, promisedSeconds: 960, lateWhy: pending } } as CopyState]],
    ["a stream down past its bound", [{ ...copied("public.customers", 1200, ago(7200)), kept: { by: "replication", slot: "s", state: "streamed", why: null, position: "0/1", lastCommit: null,
      notRunning: "it has not started yet: it starts at the next pass", syncedAt: ago(300), promisedSeconds: 120, lateWhy: "the stream is not running: it has not started yet: it starts at the next pass" } } as CopyState]],
    // a recopied table behind (review r1: the page said `null`, the CLI nothing): behind, from sync, for every kind
    ["behind, recopied", [{ ...copied("public.customers", 1200, ago(7200)), kept: { by: "recopy", copiedAt: ago(7200), syncedAt: ago(7200), promisedSeconds: 120,
      lateWhy: "the last pass, which reads every table again whole, took 1 s, and Mason waits four times a pass between passes to keep the database's load to a fifth" } } as CopyState]],
    ["off", [{ ...copied("public.events", 30_000_000, ago(7200)), kept: { by: "poll", sync: { mode: "off" }, syncedAt: ago(3 * 86_400), nextAt: null, promisedSeconds: null, lateWhy: null } } as CopyState]],
    ["synced", [{ ...copied("public.customers", 1200, ago(7200)), kept: { by: "poll", sync: every15, syncedAt: ago(14 * 60), nextAt: null, promisedSeconds: 960, lateWhy: pass } } as CopyState]],
    // in its first sync's one catch-up poll (issue 834): at work, its words the CLI's, never "NOT kept current"
    ["catching up, off", [{ ...copied("public.events", 23_000_000, ago(5)), behind: "after its whole read", rebuilding: "catch-up",
      kept: { by: "poll", sync: { mode: "off" }, syncedAt: ago(5), nextAt: null, pending: "it is caught up by one poll after its whole read first", promisedSeconds: null, lateWhy: null } } as CopyState]],
    ["catching up, polled", [{ ...copied("public.customers", 1200, ago(5)), behind: "after its whole read",
      kept: { by: "poll", sync: every15, syncedAt: ago(5), nextAt: null, pending: "it is caught up by one poll after its whole read first", promisedSeconds: 960, lateWhy: "it is caught up by one poll after its whole read first" } } as CopyState]],
    ["catching up, replicated", [{ ...copied("public.orders", 2_000_000, ago(5)), behind: "after its whole read", rebuilding: "catch-up",
      kept: { by: "replication", slot: "s", state: "catching-up", why: "caught up by one poll after its whole read", position: "0/1", lastCommit: null, notRunning: null,
        syncedAt: ago(5), promisedSeconds: 120, lateWhy: "caught up by one poll after its whole read" } } as CopyState]],
  ];
  const tableLine = fn<[unknown, number], { state: string; fraction: number; what: string }>("tableLine");
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const words: Record<string, string> = {};
  for (const [name, copies] of states) {
    const s = stateOf(copies, { now: NOW });
    const t = s.tables.find((x) => x.table === copies[0]!.source)!;
    const cli = commands.tableLines(s, NOW).find((l) => l.startsWith(t.table))!;
    const ours = tableLine(t, NOW);
    assert.ok(cli.endsWith(`  ${ours.what}`), `${name}:\n${cli}\n${ours.what}`);
    assert.doesNotMatch(ours.what, /first sync failed/, `${name}: a synced table's sync is never its first`);
    const row = renderTables(s).split("<tr").find((r) => r.includes(`<code class="name" title="${t.table}">`))!;
    words[name] = `${/class="indicator (\w+)"/.exec(row)![1]} ${/<\/span>(Behind|Failed|Synced|Syncing|Catching up|Waiting)</.exec(row)![1]} ${ours.state}`;
    if (name.startsWith("catching up")) {
      assert.ok(ours.what.endsWith(` · ${commands.CATCHING_UP} (last synced 5 s ago)`), `${name}: ${ours.what}`);
      assert.doesNotMatch(ours.what, /NOT kept current/, `${name}: at work, not a fault (issue 834)`);
      assert.match(row, /<span class="copyline t-catching-up">/, `${name}: the bar in the accent (app.css: no amber of .t-unsynced)`);
      assert.match(cli, /^\S+\s+█{20} 100% {2}/);
      assert.match(commands.paintBar(cli, { red: (x: string) => `R${x}`, yellow: (x: string) => `Y${x}`, green: (x: string) => `G${x}`, cyan: (x: string) => `C${x}`, dim: (x: string) => x } as never, commands.tableRows(s, NOW).find((x) => x.line === cli)!.tone), /C█/, `${name}: cyan in mason status`);
    }
  }
  assert.deepEqual(words, { "behind, the pass": "warn Behind unsynced", "behind, its own poll": "warn Behind unsynced", "left out": "bad Failed failed", "a failed catch-up": "bad Failed failed",
    "a stream down past its bound": "warn Behind unsynced", "behind, recopied": "warn Behind unsynced", off: "ok Synced done", synced: "ok Synced done",
    "catching up, off": "warn Catching up catching-up", "catching up, polled": "warn Catching up catching-up", "catching up, replicated": "warn Catching up catching-up" });
  // one wording: the page's own constant is the CLI's (src/web/pages/status.js, src/cli/readiness.ts)
  assert.equal(page.CATCHING_UP, commands.CATCHING_UP);
  const recopied = stateOf(states.find(([n]) => n === "behind, recopied")![1], { now: NOW });
  const line = tableLine(recopied.tables.find((x) => x.table === "public.customers")!, NOW).what;
  assert.equal(line, "1,200 rows · synced · behind by 1 h 58 min: the last pass, which reads every table again whole, took 1 s, and Mason waits four times a pass between passes to keep the database's load to a fifth");
});

test("a synced table's space on its line, the page's words the CLI's: its deleted rows' share, its last compaction, a compaction that failed (issue 851)", () => {
  const kept = { by: "poll", sync: { mode: "off" }, syncedAt: "2026-10-27T09:00:09.000Z", nextAt: null, promisedSeconds: null, lateWhy: null };
  const none = { deadShare: null, wasteShare: null, checkedAt: null, at: null, seconds: null, error: null, retryAt: null, waiting: null };
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    ["deleted rows", { ...none, deadShare: 0.237, wasteShare: 0.3, checkedAt: "2026-10-27T09:00:09.000Z" }, "23% of its stored rows deleted, not compacted yet"],
    ["few deleted, compacted", { ...none, deadShare: 0.02, checkedAt: "2026-10-27T09:00:09.000Z", at: new Date(NOW - 2 * 3600_000).toISOString(), seconds: 1.5 }, "compacted 2 h ago"],
    ["failed", { ...none, deadShare: 0.6, error: "its compaction failed, …", retryAt: "2026-10-27T10:35:00.000Z" }, "its compaction failed, tried again after 10:35 UTC (mason logs --events says why)"],
    ["waits for disk", { ...none, deadShare: 0.52, waiting: "it needs 184.0 MiB free on disk to be compacted, and 70.0 MiB is free where the synced data is" },
      "52% of its stored rows deleted, not compacted: it needs 184.0 MiB free on disk to be compacted, and 70.0 MiB is free where the synced data is"],
    ["nothing read", none, null],
  ];
  for (const [name, compaction, said] of cases) {
    const s = stateOf([{ ...copied("public.events", 30_000_000, "2026-10-27T09:00:09.000Z"), kept, compaction } as unknown as CopyState], { now: NOW });
    const t = s.tables.find((x) => x.table === "public.events")!;
    const cli = commands.tableLines(s, NOW).find((l) => l.startsWith("public.events"))!;
    const ours = fn<[unknown, number], { what: string }>("tableLine")(t, NOW).what;
    assert.ok(cli.endsWith(`  ${ours}`), `${name}:\n${cli}\n${ours}`);
    if (said === null) assert.doesNotMatch(ours, /compact|deleted/, name);
    else assert.ok(ours.endsWith(` · ${said}`), `${name}: ${ours}`);
  }
});

test("a copy the poll does not keep current is the page's warning, as mason status paints it: its line's words equal, its state unsynced", () => {
  const BEHIND = stateOf([{ ...copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"),
    kept: { by: "poll", sync: { mode: "poll", every: "30s", seconds: 30 }, syncedAt: "2026-10-27T09:00:09.000Z", nextAt: null, pending: "caught up by one poll first (after its whole read)" } }]);
  const t = BEHIND.tables.find((x) => x.table === "public.orders")!;
  const line = fn<[unknown], { state: string; what: string }>("tableLine")(t);
  assert.equal(line.state, "unsynced", "the page's warning colour (app.css .t-unsynced), never done's");
  assert.match(line.what, /^2,000,000 rows · synced · NOT kept current \(last synced .* ago\): caught up by one poll first \(after its whole read\)$/);
  // the CLI paints the same words yellow (paintBar): the same text, the same warning
  const cli = commands.tableLines(BEHIND).find((l) => l.startsWith("public.orders"))!;
  assert.ok(cli.endsWith(line.what), `${cli}\n${line.what}`);
  assert.match(fn<[unknown, unknown?], string>("renderStatus")(BEHIND, {}), /<tr class="t-unsynced"><th scope="row"><code class="name" title="public\.orders">public\.orders<\/code>/);
});

test("failed: its error on its line and in full, the warning, a table whose sync is off with its age, Failed — and the statements that could not be read", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(FAILED, { queries: { failure: { code: "failed", message: "the request log cannot be read\nmore" } } });
  const text = textOf(html);
  assert.match(text, /public\.orders 100% its first sync failed: could not read the next chunk: connection reset/);
  assert.match(html, /<details data-open="error:public\.orders"><summary>the whole error<\/summary><pre>could not read the next chunk: connection reset\nthe sync tries it again in 5 min<\/pre><\/details>/);
  // a copy whose sync is off is done (the Overview lists the copies not finished): its line says its sync and its age
  const events = (FAILED as { tables: Array<{ table: string }> }).tables.find((t) => t.table === "public.events");
  assert.match(fn<[unknown], { what: string }>("tableLine")(events).what, /^30,000,000 rows · synced · sync: off, last synced \d+ days? ago — mason sync events syncs it now; sync: poll 5m on its entry polls it$/);
  assert.match(text, /Warning mason\/sources\/shop\.yml: tables\.ordrs: no such table/);
  assert.match(text, /Changes each table as its sync: says · sync: off \(the default: the file writes none\) · sync: replication tables streamed as they happen \(logical replication: slot mason_dev_shop, publication app_pub, named: read as it is, never altered\); the others by a SELECT of their changed rows/);
  assert.ok(!/xmin|polling with SELECTs|goes back to polling/.test(text), "how the changes arrive is said in a web developer's words");
  assert.match(text, /Queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
  assert.match(text, /^Failed /);
  assert.match(html, /<tr class="warn"><th scope="row">Warning<\/th>/, "a warning is marked");
});

test("no table added: the commands' sentence, and what adds one", () => {
  assert.match(textOf(fn<[unknown, unknown?], string>("renderStatus")(NONE)), /^No table added yet \(4 in the database\)\. mason tables lists them; mason add <table> syncs one\. Mason Source .* Sessions none open$/);
});

test("the tables: each of the database's, added, not added or cannot be added with its reason and no Add; Remove asks first", async () => {
  type Ui = { removing?: string | null; choosing?: string | null; columns?: unknown; outcome?: unknown };
  const renderTables = fn<[unknown, Ui?], string>("renderTables");
  const html = renderTables(CATALOG_STATE);
  const text = textOf(html);
  // ONE table: an added table shows its sync columns, one not added its rows and key; seven short columns, whatever is
  // long (a reason, an error, a copy's words, a Remove's question) a line of its own under the row
  assert.match(text, /^Table State Rows Key Last sync Size public\.customers /);
  assert.equal([...html.matchAll(/<table /g)].length, 1, "the added tables are not listed twice");
  assert.match(text, /public\.customers Synced 100% 1,200 key id — View events Sync now Remove Sync… public\.orders /, "every added table has its bar: 100% once copied");
  assert.equal([...html.matchAll(/<span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`).join(", "),
    "ok Synced, ok Synced, ok Synced, unknown Not added, unknown Not added, unknown Not added, unknown Not added", "a state is a dot AND the CLI's word");
  assert.match(html, /^<div class="panel"><table class="catalog">/, "one table, in a card");
  assert.match(text, /public\.audit Not added ~50 rows key id Add Columns… public\.accounts /);
  assert.match(text, /public\.event_log Not added ~900 rows no key Name its key… cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id \(its unique index event_log_tenant_id_id_key\) public\.staging /);
  assert.match(html, /<\/tr><tr class="under note"><td colspan="7"><div class="under-body"><span class="dim">cannot be added as it is: no primary key/, "the reason on a line of its own under its row, across every column");
  assert.match(text, /public\.staging Not added rows unknown key id Add Columns… A synced table's own size/);
  assert.match(html, /<button type="button" class="small" data-sync-table="public\.customers" data-room="Syncing…">Sync now<\/button>/);
  assert.ok(!/data-sync-table="public\.(audit|event_log)"/.test(html), "no Sync for a table not added");
  // View events: its sync events, on Observability › Sync events narrowed to it (a link, before Sync now)
  assert.match(html, /<td class="act" id="act-tables-public\.customers"><a class="btn small" href="#observability\/syncs\?table=public\.customers&amp;range=7d">View events<\/a> <button type="button" class="small" data-sync-table="public\.customers"/);
  const syncsHref = (await import(path.join(WEB, "pages", "tables.js") as string) as { syncsHref?: (t: string) => string }).syncsHref;
  assert.equal(typeof syncsHref, "function", "src/web/pages/tables.js exports syncsHref");
  assert.equal(syncsHref!("billing.invoices & co"), "#observability/syncs?table=billing.invoices%20%26%20co&range=7d", "over the week: a table's copy is rarely in Now's 15 minutes");
  assert.ok(!/href="#observability\/syncs\?table=public\.(audit|event_log)"/.test(html), "no View events for a table not added");
  assert.match(html, /<button type="button" class="primary small" data-add-table="public\.audit">Add<\/button>/);
  assert.ok(!/data-add-table="public\.(event_log|customers)"/.test(html), "no Add for a table that cannot be added as it is, nor for one added");
  assert.match(html, /<button type="button" class="danger small" data-remove-table="public\.customers">Remove<\/button>/);
  assert.ok(!/duckdb/i.test(html), "never the engine's name");
  // Remove asks first, in a popover beside its Remove: the table says what it said before, the question is after it
  const asking = renderTables(CATALOG_STATE, { removing: "public.customers" });
  assert.equal(textOf(withoutPops(asking)), textOf(html), "the rows say what they said: nothing is inserted between them");
  assert.equal(textOf(popOf(asking, "act-tables-public.customers")), "Remove customers? Mason stops syncing it and drops its synced data. Remove customers Cancel");
  // its Remove where it was, held down; the question a dialog anchored to the row's actions, written after the table
  assert.match(asking, /<td class="act" id="act-tables-public\.customers"><a class="btn small" href="#observability\/syncs\?table=public\.customers&amp;range=7d">View events<\/a> <button type="button" class="small" data-sync-table="public\.customers" data-room="Syncing…">Sync now<\/button> <button type="button" class="danger small" aria-expanded="true" disabled>Remove<\/button><\/td><\/tr>/);
  assert.match(asking, /<\/table><\/div><div class="pop ask" data-anchor="act-tables-public\.customers" role="dialog" aria-label="Remove customers\?"><p class="confirm">Remove customers\?/);
  assert.match(asking, /<button type="button" class="danger small" data-confirm-remove-table="public\.customers">Remove customers<\/button>/);
  assert.match(asking, /data-confirm-remove-table="public\.customers"/);
  assert.ok(!/data-confirm-remove-table="public\.orders"/.test(asking), "only the one asked");
  // the form: a table with no primary key ticks its key and its columns, one with a key its columns only
  assert.equal(textOf(popOf(renderTables(CATALOG_STATE, { choosing: "public.event_log" }), "act-tables-public.event_log")), "Reading event_log's columns… Cancel", "the form waits for its columns, read when it opens");
  const keyForm = renderTables(CATALOG_STATE, { choosing: "public.event_log", columns: columnsOf("public.event_log") });
  assert.match(keyForm, /<form class="pick" data-pick-form="public\.event_log"/);
  assert.match(keyForm, /<button type="submit" class="primary small">Add event_log<\/button>/);
  assert.match(textOf(keyForm), /Its key: the columns that tell its rows apart, as mason add event_log --key tenant_id bigint id bigint payload jsonb Its columns, as mason add event_log --columns \(none ticked: as mason add event_log ?, every column\) tenant_id bigint id bigint payload jsonb Add event_log Cancel/);
  assert.deepEqual([...keyForm.matchAll(/name="(key|columns)" value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`),
    ["key=tenant_id", "key=id", "key=payload", "columns=tenant_id", "columns=id", "columns=payload"]);
  const columnsForm = renderTables(CATALOG_STATE, { choosing: "public.accounts", columns: columnsOf("public.accounts") });
  assert.ok(!/name="key"/.test(columnsForm) && !/Its key/.test(columnsForm), "a table with a primary key is copied by it: no key to name");
  assert.deepEqual([...columnsForm.matchAll(/name="columns" value="([^"]*)"/g)].map((m) => m[1]), ["id", "email", "password_hash"]);
  assert.ok(!/pattern=|required/.test(keyForm + columnsForm), "the server judges what is sent, never the page");
  // what an add or a remove answered is said beside its table's actions; a refusal for a table the list lacks, above the list
  const said = renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", added: PICKED.secret } });
  assert.match(textOf(popOf(said, "act-tables-public.accounts")), /^Added public\.accounts to mason\/sources\/shop\.yml: every column but password_hash .* Dismiss$/);
  assert.equal(textOf(withoutPops(said)), textOf(html), "and nothing inserted into the table");
  const gone = renderTables(CATALOG_STATE, { outcome: { table: "public.gone", failure: { code: "not_found", message: "public.gone is not a table of shop that this user can read" } } });
  assert.match(textOf(gone), /^✗ public\.gone is not a table of shop that this user can read Table State /);
  assert.equal(textOf(renderTables({ ...NONE, tables: [] })), "shop has no table this user can read.");
  assert.match(renderTables({ ...NONE, tables: [] }), /^<div class="empty">/, "nothing to list is the empty state");
});

test("a Failure renders as the CLI's four parts: ✗ what is wrong, why, fix, then Next with each command and what it does", () => {
  const html = fn<[Failure], string>("renderFailure")({ code: "refused", message: "there is already a user \"metabase\"", why: "a name names one user", fix: "mason user remove metabase, then mason user add metabase",
    next: [{ command: "mason user list", what: "the users" }, { command: "mason user remove metabase" }] });
  assert.equal(textOf(html), "✗ there is already a user \"metabase\" why a name names one user fix mason user remove metabase, then mason user add metabase Next: mason user list the users mason user remove metabase");
  assert.match(html, /^<div class="failure" role="alert">/);
  assert.equal(textOf(fn<[Failure], string>("renderFailure")({ code: "failed", message: "only this" })), "✗ only this", "no empty why, fix or Next");
});

test("the users: a user's role (mason user add --role) in its own column; one the roles file no longer names is said; stage 1b: the file's default marked, a user it holds to nothing said", () => {
  const renderUsers = fn<[unknown, string | null, number?], string>("renderUsers");
  const at = { addedAt: "2026-10-29T08:00:00.000Z", removedAt: null, live: true, lastUsedAt: null, url: null };
  const html = renderUsers({ users: [{ name: "agent", id: "0000000000000001", ...at, role: "agent", roleFrom: "file", roleKnown: true },
    { name: "old", id: "0000000000000002", ...at, role: "gone", roleFrom: "file", roleKnown: false },
    // stage 1b (src/cli/roles.ts userRole): one reading as the roles file's default, one the file holds to nothing (no default:)
    { name: "dflt", id: "0000000000000003", ...at, role: "everything", roleFrom: "default" },
    { name: "bare", id: "0000000000000004", ...at, roleFrom: "none", readsNothing: true }], lastUsedNote: null, urlNote: null, requestLogDays: 7 }, null, Date.parse("2026-10-29T09:00:00.000Z"));
  assert.match(textOf(html), /^User Role Status Added Last used agent id 0000000000000001 agent from anywhere Active .* old id 0000000000000002 gone not in the roles file: its statements are refused from anywhere Active /);
  assert.match(textOf(html), /dflt id 0000000000000003 everything \(default\) from anywhere Active .* bare id 0000000000000004 no role, and the roles file names no default: its statements are refused from anywhere Active /);
});

test("the users: a user's attributes beside its role in mason user list's words; one its role's filters read and it lacks, said refused", async () => {
  const renderUsers = fn<[unknown, string | null, number?], string>("renderUsers");
  const attributesText = fn<[Record<string, string | string[]>], string>("attributesText");
  const cli = await import("../src/cli/user.ts");
  const values = { tenant: "42", regions: ["eu", "uk"] };
  assert.equal(attributesText(values), cli.attributesText(values), "the page's words are the CLI's");
  assert.equal(attributesText(values), "tenant=42, regions=[eu, uk]");
  const at = { addedAt: "2026-10-29T08:00:00.000Z", removedAt: null, live: true, lastUsedAt: null, url: null };
  const html = renderUsers({ users: [{ name: "acme", id: "0000000000000001", ...at, role: "tenant", roleFrom: "file", roleKnown: true, attributes: values },
    { name: "stale", id: "0000000000000002", ...at, role: "tenant", roleFrom: "file", roleKnown: true, attributes: { tenant: "7" }, missingAttributes: ["regions"] }],
    lastUsedNote: null, urlNote: null, requestLogDays: 7 }, null, Date.parse("2026-10-29T09:00:00.000Z"));
  assert.match(textOf(html), /acme id 0000000000000001 tenant tenant=42, regions=\[eu, uk\] from anywhere Active .* stale id 0000000000000002 tenant tenant=7 no value for regions: its statements are refused from anywhere Active /);
});

test("the users: a row each, active first then removed without Remove; Remove asks first; none is said", () => {
  const renderUsers = fn<[unknown, string | null, number?], string>("renderUsers");
  const list = { users: [{ name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null },
    { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: "2026-10-28T08:15:59.000Z", url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "grafana", id: "fedcba9876543210", addedAt: "2026-10-20T08:00:00.000Z", removedAt: null, live: false, lastUsedAt: null, url: "postgres://grafana@127.0.0.1:5433/shop" }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const NOW_U = Date.parse("2026-10-28T09:15:59.000Z");
  const html = renderUsers(list, null, NOW_U);
  assert.match(textOf(html), /User Role Status Added Last used metabase id 0123456789abcdef every table from anywhere Active 2026-10-27 09:10 UTC 60 min ago Queries Disable Remove grafana id fedcba9876543210 every table from anywhere Active does not connect: the API key was rotated since it was added 2026-10-20 08:00 UTC not used in the last 7 days Queries Disable Remove old id aaaaaaaaaaaaaaaa every table Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC/);
  // the last use is an age with its UTC time in a title (mason user list's words); status is a dot and a word
  assert.match(html, /<td class="num"><span title="2026-10-28 08:15 UTC">60 min ago<\/span><\/td>/);
  assert.deepEqual([...html.matchAll(/<span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`),
    ["ok Active", "ok Active", "unknown Removed 2026-10-02 10:00 UTC"]);
  assert.match(html, /<button type="button" class="danger small" data-remove="metabase">Remove<\/button>/);
  assert.equal([...html.matchAll(/<tr( class="removed")?><th scope="row">/g)].map((m) => m[1] ? "removed" : "active").join(" "), "active active removed", "a removed user is listed last, muted");
  assert.ok(!/data-remove="old"/.test(html), "a removed user has no Remove");
  assert.ok(!/password/i.test(html.replace(/the API key/g, "")), "no password is shown: the URL is the one without it");
  const asking = renderUsers(list, "metabase", NOW_U);
  assert.match(textOf(asking), /Remove metabase\? It connects no more, and the sessions it holds end at their next statement\. Remove metabase Cancel/);
  assert.match(asking, /data-confirm-remove="metabase"/);
  assert.ok(!/data-confirm-remove="grafana"/.test(asking), "only the one asked");
  // none yet: what a user is for, in a web developer's words, and how one is made
  assert.equal(textOf(renderUsers({ users: [] }, null)), "No users yet A user is the name and password psql, a BI tool or your app connects with. Add one above, as mason user add <name> does: its URL, password included, is shown once.");
  assert.match(renderUsers({ users: [] }, null), /^<div class="empty">/);
  // last use unknown, or the URL unknown: the note why, as mason user list says it
  const unknown = textOf(renderUsers({ ...list, lastUsedNote: "unknown: the request log could not be read (busy)", urlNote: "Mason is not running" }, null, NOW_U));
  assert.match(unknown, /Active 2026-10-27 09:10 UTC 60 min ago/);
  assert.match(unknown, /Active does not connect: the API key was rotated since it was added 2026-10-20 08:00 UTC unknown /);
  // the URL is the Connect panel's, never a row's: its note goes with it
  assert.match(unknown, /Last used: unknown: the request log could not be read \(busy\)\.$/);
});

test("the users while the roles file cannot be read: mason user list's tip, word for word, and every user's role said refused", async () => {
  // /api/state's roles (mason status --json's) beside /api/users' list: the problem the listener refuses every user for (57P03)
  const renderUsers = fn<[unknown, string | null, number, unknown, unknown], string>("renderUsers");
  const { rolesProblemText } = await import("../src/cli/roles.ts") as unknown as { rolesProblemText: (file: string, problem: string) => string };
  const at = { removedAt: null, disabledAt: null, live: true, lastUsedAt: null, url: null };
  const list = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", ...at, roleFrom: "none" },
    { name: "agent", id: "0000000000000001", addedAt: "2026-10-29T08:00:00.000Z", ...at, role: "agent", roleFrom: "file" }], lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const NOW_R = Date.parse("2026-10-29T09:00:00.000Z");
  const problem = "mason/roles.yml: it is not YAML: Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 18";
  const html = renderUsers(list, null, NOW_R, null, { file: "mason/roles.yml", roles: [], problem, default: null, all: [] });
  assert.ok(textOf(html).startsWith(`${rolesProblemText("mason/roles.yml", problem)} User Role Status Added Last used `), textOf(html));
  assert.match(textOf(html), /metabase id 0123456789abcdef refused: the roles file cannot be read from anywhere Active 2026-10-27 .* agent id 0000000000000001 refused: the roles file cannot be read from anywhere Active 2026-10-29/);
  // a readable file: nothing said; the page's own roles are the state's (/api/state roles), read beside the users
  assert.doesNotMatch(textOf(renderUsers(list, null, NOW_R, null, { file: "mason/roles.yml", roles: ["agent"], problem: null, default: null, all: [] })), /cannot be read/);
  assert.doesNotMatch(textOf(renderUsers(list, null, NOW_R, null, null)), /cannot be read/);
});

test("a user just added: URL, User and Password alone — each with a Copy that copies it, no Database, Host, Port, SSL mode (Connect's) nor psql line, and that it will not be shown again", async () => {
  const password = "mason_0123456789abcdef_" + "a".repeat(32);
  const url = `postgres://metabase:${password}@127.0.0.1:5433/shop`;
  const html = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password,
    database: "shop", url, psql: psqlLine(url), host: "127.0.0.1", port: 5433, sslmode: "disable" });
  const text = textOf(html);
  // the user's own three fields, in one layout: each a label and its value with a Copy (issues 839, 876); the run's
  // Database, Host, Port and SSL mode are on the Connect card above it, so not here
  assert.match(text, /^The user metabase added: its password is shown this once Shown once URL postgres:\/\/metabase:mason_0123456789abcdef_a{32}@127\.0\.0\.1:5433\/shop Copy User metabase Copy Password mason_0123456789abcdef_a{32} Copy Paste it /);
  const fields: Array<[string, string, string]> = [["URL", "added-url", url], ["User", "added-user", "metabase"], ["Password", "added-password", password]];
  for (const [label, id, value] of fields) {
    const re = value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    assert.match(html, new RegExp(`<dt>${label}</dt><dd><span class="copyrow"><code id="${id}">${re}</code> <button type="button" class="small" data-copy="${id}" data-room="Press ⌘C">Copy</button></span></dd>`), `${label}: its value and a Copy, laid out as every other field`);
  }
  assert.deepEqual([...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]), fields.map(([, id]) => id), "a Copy on every field, none else");
  assert.deepEqual([...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]), ["URL", "User", "Password"], "exactly three rows");
  assert.doesNotMatch(text, /Database|Host|Port|SSL mode/, "the run's facts are Connect's, not this card's");
  // each Copy copies its own field's text, through the page's one copyClick
  const copyClick = fn<[Record<string, string>, { textContent: string; dataset?: Record<string, string> }, unknown], Promise<void> | null>("copyClick");
  const codes = new Map([...html.matchAll(/<code id="([^"]+)">([^<]*)<\/code>/g)].map((m) => [m[1]!, { textContent: textOf(m[2]!) }]));
  for (const [label, id, value] of fields) {
    const wrote: string[] = [];
    await copyClick({ copy: id }, { textContent: "Copy", dataset: {} }, { doc: { getElementById: (x: string) => codes.get(x) ?? null },
      win: { setTimeout: () => {}, navigator: { clipboard: { writeText: async (t: string) => { wrote.push(t); } } } } });
    assert.deepEqual(wrote, [value], `${label}'s Copy copies ${value}`);
  }
  // no psql line: the URL is the same thing, pasted after psql (mason user add --json keeps its psql field)
  assert.doesNotMatch(text, /psql/, "no psql line, and no word of it");
  assert.doesNotMatch(html, /added-psql/);
  // and where its statements will show
  assert.match(text, /Connect your tool: each statement it sends shows on Observability › Queries \. I have copied it$/);
  assert.match(html, /<a href="#observability\/queries">Observability › Queries<\/a>/);
  assert.match(text, /Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again\./);
  assert.match(html, /<span class="badge warn">Shown once<\/span>/, "a clear note that it is shown once");
  assert.match(html, /<button type="button" class="primary" data-dismiss-added="">I have copied it<\/button>/);
  // while Mason does not run, the JSON carries no URL: it is not shown, never "undefined"
  const bare = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password, database: "shop" });
  assert.deepEqual([...bare.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]), ["added-user", "added-password"]);
  assert.doesNotMatch(textOf(bare), /undefined|null|Host|Port|SSL mode/);
});

test("a run that stopped, or a cookie of an earlier run: a plain Failure that says what to do", () => {
  const failureOf = fn<[number | null, string], Failure>("failureOf");
  const gone = failureOf(null, "fetch failed");
  assert.equal(gone.message, "Mason does not answer at this address");
  assert.match(gone.fix!, /^mason start in the project's folder, then mason ui opens this page again/);
  assert.deepEqual(gone.next!.map((s) => s.command), ["mason status", "mason start", "mason ui"]);
  const stale = failureOf(403, "this is mason start's command server for the mason command: a request carries the run's token (Authorization: Bearer, from .mason/config.json)\n");
  assert.equal(stale.message, "this page's cookie is not the running Mason's");
  assert.match(stale.why!, /^this is mason start's command server/);
  assert.deepEqual(stale.next!.map((s) => s.command), ["mason ui"]);
  // the server's own Failure, as it sent it
  const own = { code: "usage", message: "limit is a whole number of requests, 1 to 10000", next: [] };
  assert.deepEqual(failureOf(400, JSON.stringify({ error: own.message, failure: own })), own);
});

test("a server's page, through a tunnel: what it words itself names mason ui --ssh, what the run says stands", async () => {
  const overTunnel = fn<[Failure], Failure>("overTunnel");
  const failureOf = fn<[number | null, string], Failure>("failureOf");
  const closed = overTunnel(failureOf(null, "fetch failed"));
  assert.equal(closed.message, "the tunnel to this server has closed");
  assert.match(closed.fix!, /^mason ui --ssh <user@server>, on your own machine, opens this page again/);
  assert.deepEqual(closed.next!.map((s) => s.command), ["mason ui --ssh <user@server>"], "never mason start, on a server's page");
  assert.deepEqual(overTunnel(failureOf(403, "no")).next!.map((s) => s.command), ["mason ui --ssh <user@server>"]);
  const own = { code: "refused", message: "the run's own refusal", next: [] };
  assert.deepEqual(overTunnel(own), own);
  // the app does it for every read once the state says served, and a run on this machine keeps its words
  for (const [served, command] of [[true, "mason ui --ssh <user@server>"], [false, "mason status"]] as const) {
    let up = true;
    const fetchFn = async (): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      if (!up) throw new Error("fetch failed");
      return { ok: true, status: 200, text: async () => JSON.stringify({ served }) };
    };
    const app = fn<[unknown], { poll(): Promise<void>; model: { pollFailure: Failure | null } }>("createApp")(fetchFn);
    await app.poll();
    up = false;
    await app.poll();
    assert.equal(app.model.pollFailure?.next?.[0]?.command, command);
  }
});

test("a sources file the server cannot write: no Add, Columns…, Name its key… or Remove, and the page says why; Sync stays", () => {
  const renderTables = fn<[unknown], string>("renderTables");
  assert.match(textOf(renderTables(CATALOG_STATE)), /Remove/);
  const why = "the sources file cannot be written on this server (EROFS): commit a change to it, and deploy";
  const html = renderTables({ ...CATALOG_STATE, sourcesReadOnly: why, served: true });
  for (const control of ["data-remove-table", "data-add-table", "data-choose"]) assert.ok(!html.includes(control), control);
  assert.match(html, /data-sync-table/);
  assert.ok(textOf(html).includes(`Tables are not added or removed from this page: ${why}.`));
  // no table added yet: nothing says Add
  const none = renderTables({ ...CATALOG_STATE, sourcesReadOnly: why, tables: CATALOG_STATE.tables.map((t) => ({ ...t, added: false, copy: null })) });
  assert.ok(!textOf(none).includes("Add one from the list"));
});

test("a project deployed read-only (MASON_PROJECT_READONLY=1): the state the run answers says why, and the Tables list has no Add, Columns…, Name its key… or Remove; unset, it has", () => {
  const renderTables = fn<[unknown], string>("renderTables");
  // the run's own environment, as mason serve's run reads it: the state is the server's, rendered as it travels
  const was = process.env.MASON_PROJECT_READONLY;
  process.env.MASON_PROJECT_READONLY = "1";
  let deployed: RunState;
  try { deployed = stateOf(THREE_COPIED(), { tables: CATALOG }); }
  finally { if (was === undefined) delete process.env.MASON_PROJECT_READONLY; else process.env.MASON_PROJECT_READONLY = was; }
  const why = "the project's files are read-only here (MASON_PROJECT_READONLY=1); edit the files and deploy them: mason add or mason remove where the project is committed, then commit and deploy";
  assert.equal(deployed.sourcesReadOnly, why);
  const html = renderTables(deployed);
  for (const control of ["data-remove-table", "data-add-table", "data-choose"]) assert.ok(!html.includes(control), control);
  assert.match(html, /data-sync-table/, "Sync stays: the sync is unchanged");
  assert.ok(textOf(html).includes(`Tables are not added or removed from this page: ${why}.`));
  // every table of the list is still written, added or not
  for (const t of CATALOG) assert.ok(html.includes(`title="${t.source}"`), t.source);
  // unset: nothing changes
  assert.equal(CATALOG_STATE.sourcesReadOnly, null);
  const open = renderTables(CATALOG_STATE);
  for (const control of ["data-remove-table", "data-add-table", "data-choose"]) assert.ok(open.includes(control), control);
});

// ------------------------------------------------------------------ a read-only page (MASON_UI_READ_ONLY=1, issue 747)

/** Every control a page wrote that sends a change (src/web/pages/*.js): a button or a form by its marker. */
const WRITE_CONTROLS = ["data-sync-table", "data-remove-table", "data-confirm-remove-table", "data-add-table", "data-choose", "data-choose-sync", 'id="add-user"', "data-remove=", "data-confirm-remove=",
  "data-disable=", "data-confirm-disable=", "data-enable=", "data-ask-cancel", "data-confirm-cancel", "data-share-ask", "data-share-open", "data-share-stop"];
/** The buttons a read-only page may write: each only shows, copies or moves what is shown, and sends no change. */
const VIEW_BUTTONS = /^data-(copy|dismiss-[a-z-]+|pop-close|sort-table|sort-key|show-more|show-all|refresh-range|older|newest|open)$/;

/** Every page of the app over a fake run whose state is `state`, a statement running and a user: what each page wrote. */
async function everyPage(state: unknown): Promise<string> { return (await pageByPage(state)).all; }
/** The same, each page's parts apart: `byPage.get(id)` is what the page `id` wrote. */
async function pageByPage(state: unknown): Promise<{ all: string; byPage: Map<string, string> }> {
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(state), { status: 200 }));
  run.answers.set("GET api/running", () => new Response(JSON.stringify({ running: [{ session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY",
    startedAt: "2026-10-27T09:10:00.000Z", runningMs: 1500, rows: 0, query: "SELECT count(*) FROM orders", queryTruncated: false }] }), { status: 200 }));
  run.answers.set("GET api/users?lastUsed=1", () => new Response(JSON.stringify({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true },
    { name: "old", id: "fedcba9876543210", addedAt: "2026-10-27T09:10:11.000Z", disabledAt: "2026-10-27T10:00:00.000Z", live: true }] }), { status: 200 }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  const byPage = new Map<string, string>();
  for (const id of ["status", "tables", "queries", "users", "usage", "syncs"]) {
    app.show(id);
    await app.poll();
    byPage.set(id, Object.values(app.view()).join("\n"));
  }
  return { all: [...byPage.values()].join("\n"), byPage };
}

test("a read-only page (pageReadOnly): no page writes a control that sends a change — no Add, Remove, Sync, Columns…, Disable, Enable, Cancel, Add a user or Connect from anywhere; unset, each is there", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const open = await everyPage(CATALOG_STATE);
  for (const control of WRITE_CONTROLS.filter((c) => !/confirm|share-open|share-stop/.test(c))) assert.ok(open.includes(control), `without the setting: ${control}`);
  const shown = await everyPage({ ...CATALOG_STATE, pageReadOnly: why });
  for (const control of WRITE_CONTROLS) assert.ok(!shown.includes(control), `read-only: ${control}`);
  // BY RULE, NOT BY THE LIST ABOVE: every button a read-only page writes only shows, copies or moves what is shown
  const buttons = [...shown.matchAll(/<button\b([^>]*)>/g)].map((m) => [...m[1]!.matchAll(/\b(data-[a-z-]+)/g)].map((d) => d[1]!).filter((d) => d !== "data-room"));
  for (const data of buttons) assert.ok(data.length > 0 && data.every((d) => VIEW_BUTTONS.test(d)), `a button that may send a change: ${data.join(" ")}`);
  assert.ok(!/<form\b(?![^>]*id="request-filters")/.test(shown), "no form but the request log's filters");
  // viewing is unchanged: the tables, the users, the statement running and where to connect are all there
  for (const said of ["public.customers", "public.accounts", "metabase", "SELECT count(*) FROM orders", "connect-url"]) assert.ok(shown.includes(said), said);
  assert.ok(textOf(shown).includes(`Tables are not added, removed or synced from this page: ${why}.`));
  assert.ok(textOf(shown).includes(`Users are not added, changed, disabled or removed from this page: ${why}.`));
});

test("a read-only page: no add, create or write link anywhere — the Connect panel's Create a user on the Overview and on Queries' empty log included; the Overview and Usage say why; unset, all as before", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  // what leads to adding or creating something: a button-styled link to the page that does it, or its words
  const LEADS = [/Create a user/, /Add a table/, /Add a user/, /Connect from anywhere/, /<a class="btn[^"]*" href="#users"/, /<a class="btn[^"]*" href="#tables[^"]*"/, /Cancel stops one/];
  const open = await pageByPage(CATALOG_STATE);
  const shown = await pageByPage({ ...CATALOG_STATE, pageReadOnly: why });
  for (const lead of LEADS) assert.ok(!lead.test(shown.all), `read-only: ${lead}`);
  // the Connect panel is on the Overview and on Queries' empty log, and keeps its URL and Copy on both
  for (const id of ["status", "queries"]) {
    assert.match(open.byPage.get(id)!, /<a class="btn[^"]*" href="#users">Create a user<\/a>/, `unset: Connect's Create a user on ${id}`);
    assert.match(shown.byPage.get(id)!, /data-copy="connect-url"/, `read-only: Connect's URL on ${id}`);
    assert.ok(textOf(shown.byPage.get(id)!).replace(/ :/g, ":").includes("A user's name and password go in place of <user>:<password>: mason user add <name> prints the whole URL once."), id);
  }
  // the Overview and Usage say why their controls are missing, as Tables and Users do; unset, none says it
  const lines = new Map([["status", `Nothing is shared, added or created from this page: ${why}.`], ["usage", `Statements are not cancelled from this page: ${why}.`],
    ["tables", `Tables are not added, removed or synced from this page: ${why}.`], ["users", `Users are not added, changed, disabled or removed from this page: ${why}.`]]);
  for (const [id, line] of lines) {
    assert.ok(textOf(shown.byPage.get(id)!).includes(line), `${id}: ${line}`);
    assert.match(shown.byPage.get(id)!, new RegExp(`<p class="count">${line.split(":")[0]!}`), `${id}: in the Tables and Users lines' style`);
    assert.ok(!open.byPage.get(id)!.includes("read-only here"), `unset: ${id} says nothing of it`);
  }
  assert.match(open.byPage.get("usage")!, /Cancel stops one, as <code>mason cancel<\/code> does\./, "unset: Usage's lead names Cancel");
  assert.match(shown.byPage.get("usage")!, /As <code>mason logs --running<\/code> lists them\./, "read-only: the lead without Cancel");
  // the renderer alone: Connect with the setting, and without it as before
  const renderConnect = fn<[unknown, unknown], string>("renderConnect");
  const pg = CATALOG_STATE.postgres;
  assert.ok(!renderConnect(pg, { first: true, readOnly: why }).includes("Create a user"));
  assert.equal(renderConnect(pg, { first: true, readOnly: null }), renderConnect(pg, { first: true }), "unset: Connect as before");
  assert.equal(fn<[string, unknown], string>("readOnlyLine")("Statements are not cancelled", null), "");
});

test("a read-only page: each renderer alone writes no control that changes anything — Tables, Users, the statements running, the share and the checklist", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const ro = { ...CATALOG_STATE, pageReadOnly: why };
  const tables = fn<[unknown], string>("renderTables")(ro);
  for (const c of ["data-sync-table", "data-remove-table", "data-add-table", "data-choose"]) assert.ok(!tables.includes(c), c);
  assert.match(tables, /View events/, "a link to what happened stays");
  const list = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }, { name: "old", id: "fedcba9876543210", addedAt: "2026-10-27T09:10:11.000Z", disabledAt: "2026-10-27T10:00:00.000Z", live: true }] };
  const users = fn<[unknown, unknown, number, unknown, unknown, unknown], string>("renderUsers")(list, null, Date.now(), null, null, why);
  for (const c of ["data-remove=", "data-disable=", "data-enable="]) assert.ok(!users.includes(c), c);
  assert.match(users, />Queries</, "a user's statements stay");
  assert.ok(fn<[unknown, unknown, number, unknown, unknown], string>("renderUsers")(list, null, Date.now(), null, null).includes("data-enable="), "unset: Enable is there");
  assert.equal(fn<[unknown], string>("renderAddUser")(ro), "");
  assert.equal(fn<[unknown], string>("renderAddUser")(undefined), "", "no form before the state says whether it may be used");
  const running = [{ session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY", startedAt: "2026-10-27T09:10:00.000Z", runningMs: 1500, rows: 0, query: "SELECT 1", queryTruncated: false }];
  const renderRunning = fn<[unknown, unknown, unknown, number, unknown], string>("renderRunning");
  assert.ok(!renderRunning(running, null, null, Date.now(), why).includes("data-ask-cancel"));
  assert.ok(renderRunning(running, null, null, Date.now(), null).includes("data-ask-cancel"));
  assert.equal(fn<[unknown], string>("renderShare")(ro), "");
  assert.match(fn<[unknown], string>("renderShare")(CATALOG_STATE), /data-share-ask/);
  const { renderChecklist: checklist } = await import(path.join(WEB, "pages", "status.js") as string) as { renderChecklist: (s: unknown, q: unknown, u: unknown) => string };
  const noneYet = { queries: { week: { completed: 0 } } }, nobody = { users: [] };
  const fresh = { ...NONE, pageReadOnly: why };
  assert.ok(!/href="#users"|Add a table/.test(checklist(fresh, noneYet, nobody)), "the checklist sends no one to add what the page refuses");
  assert.match(checklist(NONE, noneYet, nobody), /Add a table/);
});

test("a read-only page that still edits its tables (pageReadOnlyAllow: [tables]): Tables has Add, Columns…, Name its key…, Remove and Sync now; every other page writes no control that sends a change, and says why (issue 789)", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const state = { ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["tables"] };
  const shown = await pageByPage(state);
  const tables = fn<[unknown], string>("renderTables")(state);
  for (const control of ["data-add-table", "data-choose", "data-sync-table", "data-remove-table"]) assert.ok(tables.includes(control), `Tables: ${control}`);
  assert.match(textOf(tables), /Name its key…/, "a table with no primary key offers its key");
  assert.ok(!textOf(shown.all).includes("Tables are not added"), "Tables says nothing is refused");
  for (const control of ["data-add-table", "data-choose", "data-sync-table", "data-remove-table"]) assert.ok(shown.all.includes(control), `the app: ${control}`);
  // BY RULE over every page the app wrote: every button but the Tables page's own only shows, copies or moves what is shown
  const TABLE_BUTTONS = /^data-(add-table|choose|choose-sync|sync-table|remove-table)$/;
  for (const control of WRITE_CONTROLS.filter((c) => !TABLE_BUTTONS.test(c.replace(/=$/, "")))) assert.ok(!shown.all.includes(control), control);
  const buttons = [...shown.all.matchAll(/<button\b([^>]*)>/g)].map((m) => [...m[1]!.matchAll(/\b(data-[a-z-]+)/g)].map((d) => d[1]!).filter((d) => d !== "data-room"));
  for (const data of buttons) assert.ok(data.length > 0 && data.every((d) => VIEW_BUTTONS.test(d) || TABLE_BUTTONS.test(d)), `a button that may send a change: ${data.join(" ")}`);
  assert.ok(!/Create a user|Add a user|Connect from anywhere|<a class="btn[^"]*" href="#users"/.test(shown.all), "a lead to a user or a share");
  // each page says why it offers no change, the Overview now without the tables
  for (const [id, line] of [["status", `No user is created and nothing is shared from this page: ${why}.`], ["users", `Users are not added, changed, disabled or removed from this page: ${why}.`],
    ["usage", `Statements are not cancelled from this page: ${why}.`]] as const) assert.ok(textOf(shown.byPage.get(id)!).includes(line), `${id}: ${line}`);
  assert.ok(!textOf(shown.byPage.get("status")!).includes("Nothing is shared, added or created"));
  // the checklist sends a person to add a table, never to create a user
  const { renderChecklist: checklist } = await import(path.join(WEB, "pages", "status.js") as string) as { renderChecklist: (s: unknown, q: unknown, u: unknown) => string };
  const noneYet = { queries: { week: { completed: 0 } } }, nobody = { users: [] };
  const fresh = checklist({ ...NONE, pageReadOnly: why, pageReadOnlyAllow: ["tables"] }, noneYet, nobody);
  assert.match(fresh, /Add a table/);
  assert.ok(!/href="#users"/.test(fresh), "no Create a user");
  // an allowance the page does not know is no allowance; without the page read-only it changes nothing
  const renderTables = fn<[unknown], string>("renderTables");
  assert.ok(!renderTables({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["users"] }).includes("data-add-table"));
  assert.equal(renderTables({ ...CATALOG_STATE, pageReadOnlyAllow: ["tables"] }), renderTables(CATALOG_STATE));
});

test("MASON_PROJECT_READONLY=1 wins over the allowance: a read-only page that edits its tables offers no Add, Columns…, Name its key… or Remove on a project deployed as committed, and says why; Sync now stays (issue 789)", () => {
  const renderTables = fn<[unknown], string>("renderTables");
  const projectWhy = "the project's files are read-only here (MASON_PROJECT_READONLY=1); edit them where they are committed, and deploy";
  const html = renderTables({ ...CATALOG_STATE, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)", pageReadOnlyAllow: ["tables"], sourcesReadOnly: projectWhy, served: true });
  for (const control of ["data-remove-table", "data-add-table", "data-choose"]) assert.ok(!html.includes(control), control);
  assert.match(html, /data-sync-table/);
  assert.ok(textOf(html).includes(`Tables are not added or removed from this page: ${projectWhy}.`));
  assert.equal(html, renderTables({ ...CATALOG_STATE, sourcesReadOnly: projectWhy, served: true }), "as on a page that is not read-only");
});

test("the state says pageReadOnly: why under MASON_UI_READ_ONLY=1 as the run reads it, null without; and nothing else of the state changes", () => {
  const ctxOf = (pageReadOnly?: boolean) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, ...(pageReadOnly === undefined ? {} : { pageReadOnly }), users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: sourceFile, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const on = runState(ctxOf(true), [], null, now) as RunState & { sourcesReadOnly: unknown };
  const off = runState(ctxOf(), [], null, now) as RunState;
  assert.equal(on.pageReadOnly, "the web page is read-only here (MASON_UI_READ_ONLY=1)");
  assert.equal(off.pageReadOnly, null);
  assert.equal((runState(ctxOf(false), [], null, now) as RunState).pageReadOnly, null);
  const { pageReadOnly: _a, sourcesReadOnly: _b, ...rest } = on;
  const { pageReadOnly: _c, sourcesReadOnly: _d, ...restOff } = off as typeof on;
  assert.deepEqual(JSON.parse(JSON.stringify(rest)), JSON.parse(JSON.stringify(restOff)));
  assert.ok(commands.STATUS.json!.includes("pageReadOnly"), "mason status --json declares it");
  assert.ok(commands.STATUS.json!.includes("pageReadOnlyAllow"), "mason status --json declares what that page still allows");
});

// ------------------------------------------------------------------ the link back to the site that links to the page (MASON_UI_BACK_URL, issue 786)

/** An element as `setBack` uses it: its attributes, its text, whether it is hidden, and every innerHTML written (none may be). */
function backEl() {
  const attrs = new Map<string, string>();
  const el = { attrs, hidden: true, textContent: "", htmlWrites: 0,
    setAttribute(k: string, v: string) { attrs.set(k, String(v)); }, removeAttribute(k: string) { attrs.delete(k); },
    set innerHTML(_v: string) { el.htmlWrites++; }, get innerHTML() { return ""; } };
  return el;
}

test("the state says pageBack: the link the run was started with, null without; mason status --json declares it", () => {
  const ctxOf = (pageBack?: { url: string; label: string } | null) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, ...(pageBack === undefined ? {} : { pageBack }), users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: sourceFile, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const back = { url: "https://portal.example.com/apps", label: "Portal" };
  const on = runState(ctxOf(back), [], null, now) as RunState & { pageBack?: unknown };
  assert.deepEqual(on.pageBack, back);
  assert.equal((runState(ctxOf(), [], null, now) as RunState & { pageBack?: unknown }).pageBack, null);
  assert.equal((runState(ctxOf(null), [], null, now) as RunState & { pageBack?: unknown }).pageBack, null);
  assert.ok(commands.STATUS.json!.includes("pageBack"), "mason status --json declares it");
  assert.match(commands.STATUS.usage, /pageBack \(\{ url, label \}/);
});

test("setBack: the URL an href attribute, the label the element's TEXT (never HTML), no referrer; none: hidden with no href", () => {
  const setBack = fn<[unknown, unknown, unknown], void>("setBack");
  const link = backEl(), label = backEl();
  setBack(link, label, { url: "/apps/portal", label: "Portal" });
  assert.deepEqual([link.hidden, link.attrs.get("href"), link.attrs.get("rel"), link.attrs.get("title"), label.textContent], [false, "/apps/portal", "noreferrer", "Portal", "Portal"]);
  // an operator's label that looks like markup is text: set as it is, never parsed, no element's HTML written
  const markup = `<img src=x onerror="alert(1)"> & "Portal"`;
  setBack(link, label, { url: "https://portal.example.com/", label: markup });
  assert.equal(label.textContent, markup);
  assert.equal(link.attrs.get("title"), markup);
  assert.equal(link.attrs.get("href"), "https://portal.example.com/");
  assert.equal(link.htmlWrites + label.htmlWrites, 0, "no innerHTML written");
  // none (unset, a state that cannot say, a run from before it): hidden, with no href to follow
  for (const none of [null, undefined, {}, { url: 1, label: "x" }, { url: "/x" }]) {
    setBack(link, label, { url: "/x", label: "X" });
    setBack(link, label, none);
    assert.deepEqual([link.hidden, link.attrs.has("href"), link.attrs.has("title"), label.textContent], [true, false, false, ""], JSON.stringify(none));
  }
  setBack(null, null, { url: "/x", label: "X" });
});

test("the sidebar's link back: in index.html at the top of the sidebar, above the mark and the project, hidden and with no href until the state names one; styled for the rail and the phone", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const head = html.split('<div class="side-head">')[1]!.split('<div id="side-body"')[0]!;
  const tags = [...head.matchAll(/<(a|button|h1|div)\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags[0], '<a id="back" class="back" rel="noreferrer" hidden>', "the first of the sidebar's head, no href before the script sets it");
  assert.ok(head.indexOf('id="back"') < head.indexOf('class="brand"') && head.indexOf('class="brand"') < head.indexOf('class="project"'));
  assert.match(head, /<span class="back-arrow" aria-hidden="true">←<\/span><span id="back-label" class="back-label"><\/span><\/a>/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.back\[hidden\] \{ display: none; \}/, "hidden stays hidden, whatever display .back sets");
  assert.match(css, /\.brand-name, \.where, \.back-label \{ position: absolute;/, "the icon rail: the arrow alone, the label its name");
});

test("in the browser: the state's pageBack is the sidebar's link on every page, read-only too; without it, nothing is shown", async () => {
  const back = { url: "/apps/portal", label: "<b>Portal</b>" };
  for (const state of [{ ...CATALOG_STATE, pageBack: back }, { ...CATALOG_STATE, pageBack: back, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" }]) {
    const run = fakeRun();
    run.answers.set("GET api/state", () => new Response(JSON.stringify(state), { status: 200 }));
    const { el, go, settle } = fakeBrowser(run);
    await settle();
    for (const hash of ["#overview", "#tables", "#users", "#observability/queries", "#observability/usage", "#observability/syncs"]) {
      go(hash); await settle();
      const link = el("back") as unknown as { hidden: boolean; attrs: Map<string, string>; html: string };
      const label = el("back-label") as unknown as { textContent: string; html: string };
      assert.deepEqual([link.hidden, link.attrs.get("href"), link.attrs.get("rel"), label.textContent], [false, "/apps/portal", "noreferrer", "<b>Portal</b>"], hash);
      assert.equal(link.html + label.html, "", `${hash}: written as an attribute and a text, never as HTML`);
    }
  }
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...CATALOG_STATE, pageBack: null }), { status: 200 }));
  const { el, settle } = fakeBrowser(run);
  await settle();
  const link = el("back") as unknown as { hidden?: boolean; attrs: Map<string, string> };
  assert.notEqual(link.hidden, false, "unset: the link stays hidden");
  assert.equal(link.attrs.has("href"), false);
  // a state from before it (no pageBack) shows none either
  const old = fakeRun();
  const { el: oldEl, settle: oldSettle } = fakeBrowser(old);
  await oldSettle();
  assert.notEqual((oldEl("back") as unknown as { hidden?: boolean }).hidden, false);
});

// ------------------------------------------------------------- the host's sidebar (MASON_UI_NAV_*, issue 789)

/** Every page's item replaced by the host, a URL each (`/api/state` `pageNav.items`, by its key there). */
const ALL_REPLACED = { overview: "/host/overview", tables: "/host/tables", users: "/host/users", queries: "https://console.example.com/queries", usage: "/host/usage?x=1&y=2", syncEvents: "/host/sync-events" };
const PAGE_OF_ITEM: Record<string, string> = { overview: "status", tables: "tables", users: "users", queries: "queries", usage: "usage", syncEvents: "syncs" };
const hashHrefs = (html: string): string[] => [...html.matchAll(/href="(#[^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

test("the state says pageNav: the sidebar the run was started with, null without; mason status --json declares it", () => {
  const ctxOf = (pageNav?: unknown) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, ...(pageNav === undefined ? {} : { pageNav }), users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: sourceFile, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const nav = { items: { users: "/host/users" }, links: [{ label: "Billing", url: "/billing" }] };
  assert.deepEqual((runState(ctxOf(nav), [], null, now) as RunState).pageNav, nav);
  assert.equal((runState(ctxOf(), [], null, now) as RunState).pageNav, null);
  assert.equal((runState(ctxOf(null), [], null, now) as RunState).pageNav, null);
  assert.ok(commands.STATUS.json!.includes("pageNav"), "mason status --json declares it");
  assert.match(commands.STATUS.usage, /pageNav \(\{ items, links \}/);
});

test("renderNav with the host's sidebar: a replaced item keeps its label and icon and links to the URL in the same tab, never current; the host's links a group of their own, each label TEXT", () => {
  const renderNav = fn<[string, string?, unknown?], string>("renderNav");
  // unset (null, none, a state from before it): as before
  assert.equal(renderNav("users", "now", null), renderNav("users", "now"));
  assert.equal(renderNav("users", "now", { items: {}, links: [] }), renderNav("users", "now"));
  const nav = { items: { users: "/host/users?tab=db", syncEvents: "https://console.example.com/events" }, links: [{ label: "<script>alert(1)</script> & co", url: "/billing" }, { label: "Network", url: "https://console.example.com/net?a=1&b=2" }] };
  const html = renderNav("users", "24h", nav);
  assert.match(html, /<a href="\/host\/users\?tab=db" rel="noreferrer"><span class="icon" aria-hidden="true"><svg\s+class="lucide lucide-users"[\s\S]*?<\/svg><\/span><span class="label">Users<\/span><\/a>/, "its icon, its label, the host's URL");
  assert.match(html, /<a href="https:\/\/console\.example\.com\/events" rel="noreferrer"><span class="icon" aria-hidden="true"><svg\s+class="lucide lucide-logs"[\s\S]*?<\/svg><\/span><span class="label">Sync events<\/span><\/a>/);
  assert.ok(!html.includes('href="#users"') && !html.includes("#observability/syncs"), "no link to the replaced views' own hashes");
  assert.ok(!html.includes('aria-current="page"'), "a replaced item is never the current page (the page left for it)");
  assert.ok(!/target=/.test(html), "the same tab");
  // the others as before, the range kept
  assert.ok(html.includes('href="#tables"') && html.includes('href="#observability/queries?range=24h"'));
  // the host's links: last, a group without a heading of Mason's, the link icon, the label escaped
  const group = html.split('<li class="group host-nav">')[1]!;
  assert.ok(group !== undefined && html.endsWith("</ul></li></ul>"));
  assert.match(group, /^<ul aria-label="Links"><li><a href="\/billing" rel="noreferrer"><span class="icon" aria-hidden="true"><svg\s+class="lucide lucide-link"/);
  assert.ok(group.includes('<span class="label">&lt;script&gt;alert(1)&lt;/script&gt; &amp; co</span>'), "a label is text, never markup");
  assert.ok(!html.includes("<script>"));
  assert.ok(group.includes('href="https://console.example.com/net?a=1&amp;b=2" rel="noreferrer"'));
  // links alone, no item replaced: every item as before, the group after them
  const linksOnly = renderNav("status", "now", { items: {}, links: [{ label: "Billing", url: "/billing" }] });
  assert.ok(linksOnly.startsWith(renderNav("status", "now").slice(0, -"</ul>".length)));
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.nav \.host-nav \{ padding-top: var\(--space-3\); border-top: 1px solid var\(--line\); \}/);
  // laid out as every other group of the nav, by no rule of anything else on the page (issue 885: it shared the host
  // view's `.host-links`, a wrapping flex row, which cut its rows short and moved its icons in the rail): each class
  // the sidebar's group of links carries is selected only under `.nav`, or is the nav's own `group`
  const classes = [...html.matchAll(/<li class="([^"]+)"><ul aria-label="Links">/g)].flatMap((m) => m[1]!.split(" "));
  assert.ok(classes.includes("group") && classes.length > 1, `a group of the nav, with a class of its own: ${classes.join(" ")}`);
  // each rule's selector: the text before its "{" (inside an @media too, whose own "{" comes first)
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")).filter((p) => p.length > 1).map((p) => p[p.length - 2]!.trim());
  for (const c of classes.filter((c) => c !== "group")) {
    const selectors = rules.flatMap((r) => r.split(",").map((s) => s.trim())).filter((s) => new RegExp(`\\.${c}(?![\\w-])`).test(s));
    assert.ok(selectors.length > 0, `.${c} is styled`);
    for (const s of selectors) assert.match(s, /^\.nav /, `the sidebar's .${c} is selected only under .nav, not by "${s}"`);
  }
});

test("every link of Mason's own into a replaced view goes to the host's page: the Overview's Create a user and Getting started, its cards and parts, Users' and Usage's Queries, Tables' sync events, Queries' and Usage's leads", async () => {
  const retarget = fn<[string, unknown], string>("retarget");
  const queriesHref = fn<[Record<string, string>, string], string>("queriesHref");
  const shared = await import(path.join(WEB, "shared.js") as string) as { USERS_HASH: string };
  const { userQueriesHref } = await import(path.join(WEB, "pages", "users.js") as string) as { userQueriesHref: (n: string) => string };
  const { syncsHref } = await import(path.join(WEB, "pages", "tables.js") as string) as { syncsHref: (t: string) => string };
  const nav = { items: ALL_REPLACED, links: [] };
  // each builder of a link into a view, and an alias of before, sent to that view's URL; a hash naming no page is left alone
  const cases: Array<[string, string]> = [[shared.USERS_HASH, "/host/users"], ["#overview", "/host/overview"], ["#status", "/host/overview"], ["#tables?show=failed", "/host/tables"],
    [queriesHref({ user: "metabase", client: "Metabase" }, "24h"), "https://console.example.com/queries"], [userQueriesHref("metabase"), "https://console.example.com/queries"],
    [syncsHref("public.orders"), "/host/sync-events"], ["#observability/usage?range=24h", "/host/usage?x=1&y=2"], ["#queries", "https://console.example.com/queries"], ["#logs", "/host/sync-events"]];
  for (const [hash, url] of cases) {
    const a = `<a class="btn small" href="${hash.replace(/&/g, "&amp;")}">x</a>`;
    assert.equal(retarget(a, nav), `<a class="btn small" href="${url.replace(/&/g, "&amp;")}" rel="noreferrer">x</a>`, hash);
    assert.equal(retarget(a, { items: {}, links: [] }), a, `${hash}: unset, as before`);
    assert.equal(retarget(a, null), a);
  }
  assert.equal(retarget('<a href="#nowhere">x</a>', nav), '<a href="#nowhere">x</a>', "a hash that names no page is not a replaced view's");
  // EVERY page, over states that write every lead (none added yet: Getting started; synced, failed: the cards and parts)
  const states = [NONE, COPYING, CATALOG_STATE];
  for (const state of states) {
    const open = await pageByPage(state);
    const all = await pageByPage({ ...state, pageNav: nav });
    assert.ok(hashHrefs(open.all).length > 0, "unset: the pages link into each other");
    assert.deepEqual(hashHrefs(all.all), [], "every item replaced: no link into a view of Mason's own is left");
    // one at a time: each item's view's links, and only its, go to its URL
    for (const [item, url] of Object.entries(ALL_REPLACED)) {
      const one = await pageByPage({ ...state, pageNav: { items: { [item]: url }, links: [] } });
      const left = hashHrefs(one.all);
      assert.ok(left.every((h) => fn<[string], { id: string }>("parseHash")(h).id !== PAGE_OF_ITEM[item]), `${item}: no link to its view is left`);
      const into = hashHrefs(open.all).filter((h) => fn<[string], { id: string }>("parseHash")(h).id === PAGE_OF_ITEM[item]).length;
      const sent = one.all.split(`href="${url.replace(/&/g, "&amp;")}" rel="noreferrer"`).length - 1;
      assert.ok(sent >= into && sent > 0, `${item}: each link into it (${into}) and its item go to its URL (${sent})`);
      assert.equal(left.length, hashHrefs(open.all).length - into, `${item}: every other link as it was`);
    }
  }
  // the ones named in the issue, by name: the Overview's Create a user (Connect) and its Getting started step
  for (const pageNav of [null, { items: { users: "/host/users" }, links: [] }]) {
    const run = fakeRun();
    run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...COPYING, pageNav }), { status: 200 }));
    run.answers.set("GET api/users", () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
    const app = fn<[unknown], App>("createApp")(run.fetch);
    await app.poll();
    const overview = app.view().status!;
    const leads = overview.match(/<a class="btn[^"]*" href="[^"]*"(?: rel="noreferrer")?>Create a user<\/a>/g) ?? [];
    assert.equal(leads.length, 2, "Connect's Create a user and Getting started's step");
    for (const a of leads) assert.ok(a.includes(pageNav === null ? 'href="#users">' : 'href="/host/users" rel="noreferrer">'), a);
  }
  // index.html's own links into a view (the Queries' and Usage's leads), which no part writes: the same rule over the document
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const main = html.split("<main>")[1]!;
  const statics = hashHrefs(main);
  assert.ok(statics.includes("#observability/usage") && statics.includes("#observability/queries"));
  for (const h of statics) assert.notEqual(fn<[string, unknown], string | null>("elsewhere")(h, nav), null, `${h}: index.html's link follows a replaced view`);
});

test("leave: a hash naming a replaced view leaves for its URL (its parameters and an old alias too); none, with the Overview replaced, is Mason's first page of its own; before the state, nothing", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App & { leave(h: string): unknown }>("createApp")(run.fetch);
  assert.equal(app.leave("#users"), null, "the state not read yet: nothing known");
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...CATALOG_STATE, pageNav: { items: { overview: "/host", users: "/host/users", queries: "/q" }, links: [] } }), { status: 200 }));
  await app.poll();
  const cases: Array<[string, unknown]> = [["#users", { url: "/host/users" }], ["#users?x=1", { url: "/host/users" }], ["users", { url: "/host/users" }], ["#overview", { url: "/host" }],
    ["#status", { url: "/host" }], ["#queries", { url: "/q" }], ["#observability/queries?range=7d&slow=1", { url: "/q" }], ["", { hash: "#tables" }], ["#", { hash: "#tables" }],
    ["#nowhere", { hash: "#tables" }], ["#tables", null], ["#observability/usage", null]];
  for (const [hash, want] of cases) assert.deepEqual(app.leave(hash), want, JSON.stringify(hash));
  // the Overview kept: a hash naming nothing lands on it, as before
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...CATALOG_STATE, pageNav: { items: { users: "/host/users" }, links: [] } }), { status: 200 }));
  await app.poll();
  assert.equal(app.leave(""), null);
  // every item replaced: a hash naming nothing stays (the page has no view of its own to go to)
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...CATALOG_STATE, pageNav: { items: ALL_REPLACED, links: [] } }), { status: 200 }));
  await app.poll();
  assert.equal(app.leave(""), null);
  assert.deepEqual(app.leave("#tables"), { url: "/host/tables" });
  // unset: never
  run.answers.set("GET api/state", () => new Response(JSON.stringify(CATALOG_STATE), { status: 200 }));
  await app.poll();
  for (const h of ["#users", "", "#overview"]) assert.equal(app.leave(h), null);
});

test("in the browser: opening a replaced view's hash, or following one, replaces the address with the host's page — never shown, never read again; the host's links on every page", async () => {
  const nav = { items: { users: "/host/users", overview: "https://console.example.com/" }, links: [{ label: "<b>Billing</b>", url: "/billing" }] };
  const withNav = () => { const run = fakeRun(); run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...CATALOG_STATE, pageNav: nav }), { status: 200 })); return run; };
  // opened at #users: once the state says so, the address is replaced (Back does not land on it again), once
  const run = withNav();
  const b = fakeBrowser(run, "#users");
  await until(() => b.replaced.length > 0);
  assert.deepEqual(b.replaced, ["/host/users"]);
  // (a wait for what must NOT happen: a delay too short only weakens it, never fails it)
  b.tick(); await b.settle();
  assert.deepEqual(b.replaced, ["/host/users"], "asked once, however many paints follow");
  // opened with no hash, the Overview replaced: Mason's first page of its own, its hash replaced
  const bare = fakeBrowser(withNav());
  await until(() => /<a href="#tables" aria-current="page">/.test(bare.el("nav").html), "the Tables page shown");
  assert.deepEqual(bare.replaced, ["#tables"]);
  assert.match(bare.el("nav").html, /<a href="https:\/\/console\.example\.com\/" rel="noreferrer"><span class="icon" aria-hidden="true">[\s\S]*?<\/span><span class="label">Overview<\/span><\/a>/);
  assert.ok(bare.el("nav").html.includes('<span class="label">&lt;b&gt;Billing&lt;/b&gt;</span>'), "the host's link, its label text");
  // a link of the page's followed to a replaced view: left at once, its reads never asked
  const r2 = withNav();
  const nb = fakeBrowser(r2, "#tables");
  await until(() => nb.el("nav").html.includes("Billing") && /<a href="#tables" aria-current="page">/.test(nb.el("nav").html), "the Tables page shown, the state's sidebar on it");
  const before = r2.asked.length;
  nb.go("#users");
  await until(() => nb.replaced.length > 0);
  await nb.settle();
  assert.deepEqual(nb.replaced, ["/host/users"]);
  assert.ok(!r2.asked.slice(before).some((a) => a.startsWith("GET api/users")), "the replaced view is not read");
  // the browser did not leave (the navigation stopped, the host answered 204): the hash typed again leaves again
  nb.go("#tables"); nb.go("#users");
  await until(() => nb.replaced.length === 2, "left again");
  assert.deepEqual(nb.replaced, ["/host/users", "/host/users"]);
  assert.ok(!r2.asked.slice(before).some((a) => a.startsWith("GET api/users")), "the replaced view is still not read");
  // unset: nothing leaves (the Users page shown once the state is read)
  const plainRun = fakeRun();
  const plain = fakeBrowser(plainRun, "#users");
  await until(() => plainRun.asked.some((a) => a.startsWith("GET api/users")) && plain.el("page-users").hidden === false, "the Users page shown and read");
  assert.deepEqual(plain.replaced, []);
});

test("in the browser: an item pointing into the page at a view not replaced (/#tables, the page at the host's root) is one hop to that view; a replaced view's hash typed later leaves again", async () => {
  // (a loop of such items cannot be configured: mason serve refuses a URL whose fragment names a replaced view,
  // tests/cli-ui-nav.test.ts)
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...CATALOG_STATE, pageNav: { items: { users: "/#tables" }, links: [] } }), { status: 200 }));
  const b = fakeBrowser(run, "#users");
  await until(() => b.el("page-tables").hidden === false, "the Tables page shown");
  assert.deepEqual(b.replaced, ["/#tables"]);
  b.go("#users");
  await until(() => b.replaced.length === 2, "left again");
  await until(() => b.el("page-tables").hidden === false && b.el("page-users").hidden === true, "back on Tables");
  assert.deepEqual(b.replaced, ["/#tables", "/#tables"]);
});

test("a server's Connect says the URL's host is the server's own view of itself; a laptop's page says nothing of it", async () => {
  const renderConnect = fn<[unknown, unknown?], string>("renderConnect");
  const { renderUsersConnect } = await import(path.join(WEB, "pages", "users.js") as string) as { renderUsersConnect: (pg: unknown, served?: boolean) => string };
  const pg = { host: "localhost", port: 5433, database: "shop", shown: "postgresql://<user>:<password>@localhost:5433/shop", psql: "psql x" };
  const note = /from elsewhere a tool connects to the server's own address, in place of localhost/;
  assert.match(textOf(renderConnect(pg, { served: true })), note);
  assert.match(textOf(renderUsersConnect(pg, true)), note);
  assert.doesNotMatch(textOf(renderConnect(pg)), note);
  assert.doesNotMatch(textOf(renderUsersConnect(pg)), note);
});

test("MASON_PG_PUBLIC_URL: /api/state's postgres is the address a client reaches, every Connect panel prints it, and no note to replace the host", async () => {
  const renderConnect = fn<[unknown, unknown?], string>("renderConnect");
  const { renderUsersConnect } = await import(path.join(WEB, "pages", "users.js") as string) as { renderUsersConnect: (pg: unknown, served?: boolean) => string };
  const ctxOf = (postgresPublicUrl?: string) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop?sslmode=require",
      ...(postgresPublicUrl === undefined ? {} : { postgresPublicUrl }) },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: sourceFile, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const pub = (runState(ctxOf("postgresql://db.example.com:6432/?sslmode=verify-full"), [], null, now) as RunState).postgres!;
  const own = (runState(ctxOf(), [], null, now) as RunState).postgres!;
  assert.deepEqual(pub, { url: "postgresql://db.example.com:6432/shop?sslmode=verify-full", host: "db.example.com", port: 6432, database: "shop", sslmode: "verify-full", public: true,
    shown: "postgres://<user>:<password>@db.example.com:6432/shop?sslmode=verify-full", psql: "psql 'postgres://<user>:<password>@db.example.com:6432/shop?sslmode=verify-full'" });
  assert.deepEqual(own, { url: "postgresql://127.0.0.1:5433/shop?sslmode=require", host: "127.0.0.1", port: 5433, database: "shop", sslmode: "require",
    shown: "postgres://<user>:<password>@127.0.0.1:5433/shop?sslmode=require", psql: "psql 'postgres://<user>:<password>@127.0.0.1:5433/shop?sslmode=require'" }, "unset: the listener's own, as before");
  const note = /from elsewhere a tool connects to the server's own address/;
  const overview = textOf(renderConnect(pub, { served: true }));
  assert.match(overview, /URL postgres:\/\/<user>:<password>@db\.example\.com:6432\/shop\?sslmode=verify-full Copy/);
  assert.doesNotMatch(overview, note);
  const users = textOf(renderUsersConnect(pub, true));
  assert.match(users, /Host db\.example\.com Copy Port 6432 Copy Database shop Copy SSL mode verify-full Copy URL postgres:\/\/<user>:<password>@db\.example\.com:6432\/shop\?sslmode=verify-full Copy/);
  assert.doesNotMatch(users, note);
  assert.match(textOf(renderConnect(own, { served: true })), note, "the listener's own address on a server: the note, as before");
  assert.match(textOf(renderUsersConnect(own, true)), note);
});

// ------------------------------------------------------------------ the app, over a fake fetch

/** A fake run: its answers by method and path, and every request the page made. */
function fakeRun(): { fetch: (p: string, init?: { method?: string; body?: string }) => Promise<Response>; asked: string[]; answers: Map<string, () => Response> } {
  const answers = new Map<string, () => Response>();
  const asked: string[] = [];
  const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  answers.set("GET api/state", json(COPYING));
  answers.set("GET api/users", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
  answers.set("GET api/queries", json(QUERIES));
  answers.set("GET api/events?failed=1&limit=5", json(EVENTS));
  answers.set("GET api/requests?failed=1&limit=5", json(FAILED_REQUESTS));
  answers.set("GET api/usage?since=1m", json(USAGE));
  answers.set("GET api/running", json({ running: [] }));
  answers.set("GET api/usage?since=15m&step=60", json(USAGE));
  for (const since of ["15m", "1h", "24h", "7d"]) {
    answers.set(`GET api/requests?since=${since}`, json({ requests: [], keptDays: 7, before: null }));
    answers.set(`GET api/activity?since=${since}`, json(activityOf()));
  }
  for (const p of ["limit=100", "since=15m", "since=1h", "since=24h", "since=7d"]) answers.set(`GET api/unsupported?${p}`, json({ since: "2026-10-26T09:05:00.000Z", unsupported: [], keptDays: 7 }));
  answers.set("GET api/users?lastUsed=1", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
  for (const t of ["public.audit", "public.accounts", "public.event_log"]) answers.set(`GET api/tables/${encodeURIComponent(t)}/columns`, json(columnsOf(t)));
  return {
    asked, answers,
    fetch: async (p, init) => {
      // relative to the page's own URL, as a reverse proxy's prefix needs (issue 746): never /api/…, never another origin
      assert.match(p, /^api\//, `the page asks ${p} relative to its own URL`);
      const key = `${init?.method ?? "GET"} ${p}`;
      asked.push(init?.body ? `${key} ${init.body}` : key);
      const a = answers.get(key);
      if (a === undefined) throw new TypeError("fetch failed");
      return a();
    },
  };
}

test("the app: a poll writes the shown page and when, reading only its endpoints; a poll that fails keeps what it knew and says what to do", async () => {
  const run = fakeRun();
  let clock = new Date(2026, 9, 27, 14, 3, 5).getTime();
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(clock));
  assert.match(app.view().status!, /Asking Mason/);
  assert.match(app.view().status!, /<span class="skeleton/, "being asked: the words over grey bars");
  await app.poll();
  let v = app.view();
  assert.equal(v.where, "shop", "the database; its source's name only when it is another");
  assert.equal(v.badge, "", "a database of the person's own: no badge");
  assert.equal(v.updated, "Updated 1 s ago");
  clock += 4000;
  assert.equal(app.view().updated, "Updated 4 s ago", "how long ago it last heard, ageing as the page is written");
  assert.equal(v.poll, "");
  assert.match(textOf(v.status!), /public\.orders 15% syncing/);
  assert.deepEqual(run.asked, STATUS_FIRST, "the Overview's reads, no other page's");
  assert.equal(v.users, "", "the users are not read while the Overview is shown");
  // the Users page shown: its read alone
  app.show("users");
  run.asked.length = 0;
  await app.poll();
  // a page shown is read again whatever its rates (show marks every read stale): the shell's state with it
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state"]);
  assert.match(textOf(app.view().users!), /^User Role Status Added Last used metabase id 0123456789abcdef every table from anywhere Active 2026-10-27 09:10 UTC not used in the last \? days Queries Disable Remove$/);
  app.show("status");
  // the run stops
  run.answers.clear();
  await app.poll();
  v = app.view();
  assert.match(textOf(v.poll!), /^✗ Mason does not answer at this address why the run stopped, or runs on another port now \(fetch failed\) fix mason start/);
  assert.match(textOf(v.status!), /public\.orders 15% syncing/, "the last status stays, under the failure");
  clock += 30_000;
  assert.equal(app.view().updated, "Updated 30 s ago", "when it last heard, not now: a run that stopped answering is seen ageing");
  for (const part of Object.values(v)) assert.ok(!/duckdb/i.test(part), "never the engine's name");
});

// ------------------------------------------------------------------ out of date while the poll fails (issue 886)

interface StaleApp extends App { stale(): { at: Date; failure: { code: string } } | null }

test("the Overview while the poll fails after a good read: the word it read greyed, as of when and why, the banner below it; current again at the first answer", async () => {
  const run = fakeRun();
  const kept = new Map(run.answers);
  let clock = Date.UTC(2026, 9, 27, 14, 2, 30);
  const app = fn<[unknown, () => Date], StaleApp>("createApp")(run.fetch, () => new Date(clock));
  await app.poll();
  let v = app.view();
  assert.equal(app.stale(), null, "read: current");
  assert.match(v.status!, /<div class="health warn" role="status">/, "the word in its colour");
  assert.match(textOf(v.status!), /^Under way (?!As of)/, "no as-of while it answers");
  assert.ok(!/stale-note/.test(v.poll!));
  // the run stops; a minute later the poll asks again
  run.answers.clear();
  clock += 60_000;
  await app.poll();
  v = app.view();
  assert.deepEqual(app.stale(), { at: new Date(Date.UTC(2026, 9, 27, 14, 2, 30)), failure: app.model.pollFailure }, "out of date: as of the last read that answered");
  assert.match(v.status!, /<div class="health warn stale" role="status"><span class="dot" aria-hidden="true"><\/span><span class="word">Under way<\/span><p class="as-of">As of 14:02 UTC\. Mason can&#39;t be reached\.<\/p><\/div>/,
    "the word it last read, greyed, said as of when and why");
  assert.equal(textOf(v.status!).startsWith("Under way As of 14:02 UTC. Mason can't be reached."), true);
  assert.match(textOf(v.status!), /public\.orders 15% syncing/, "the rest it read stays (greyed by its section: in the browser test)");
  assert.ok(!/stale-note/.test(v.poll!), "the Overview says it in its word: the banner does not say it twice");
  assert.match(textOf(v.poll!), /^✗ Mason does not answer at this address/, "the banner says what to do");
  // another page shown while it fails: the banner says how old what it shows is
  clock += 30_000;
  app.show("tables");
  await app.poll();
  assert.equal(textOf(app.view().poll!).startsWith("As of 14:02 UTC. Mason can't be reached. What this page shows is from then. ✗ Mason does not answer"), true, app.view().poll);
  app.show("status");
  // a refusal (not a run gone): the same, said as the read that failed
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ failure: { code: "failed", message: "the state could not be read" } }), { status: 500 }));
  await app.poll();
  assert.equal(textOf(app.view().status!).startsWith("Under way As of 14:02 UTC. The latest read failed."), true, app.view().status);
  // it answers again: current at once, the word in its colour, no as-of
  for (const [k, a] of kept) run.answers.set(k, a);
  await app.poll();
  v = app.view();
  assert.equal(app.stale(), null);
  assert.match(v.status!, /<div class="health warn" role="status">/);
  assert.ok(!/As of|can&#39;t be reached/.test(v.status!), "recovered: nothing says it is out of date");
  assert.equal(v.poll, "");
});

test("the Overview while the poll fails with nothing read yet: Unknown, and why, greyed; the banner what to do; the state once it answers", async () => {
  const run = fakeRun();
  const kept = new Map(run.answers);
  run.answers.clear();
  const app = fn<[unknown], StaleApp>("createApp")(run.fetch);
  await app.poll();
  let v = app.view();
  assert.equal(app.stale(), null, "nothing read: nothing to grey");
  assert.equal(v.status, `<div class="health stale" role="status"><span class="dot" aria-hidden="true"></span><span class="word">Unknown</span><p class="as-of">Mason can&#39;t be reached.</p></div>`);
  assert.equal(textOf(v.status!), "Unknown Mason can't be reached.");
  assert.match(textOf(v.poll!), /^✗ Mason does not answer at this address/, "no as-of in the banner: there is no earlier read");
  for (const [k, a] of kept) run.answers.set(k, a);
  await app.poll();
  v = app.view();
  assert.match(textOf(v.status!), /^Under way (?!As of)/, "the state, once it answers");
  assert.equal(v.poll, "");
});

/** An element of some HTML: its tag, its classes and its children (`tree`), for the stale rule's own matching. */
interface El { tag: string; classes: string[]; children: El[]; html: string }
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** The top-level elements of a part's HTML, each with its subtree (a small parser: what the page writes is well formed). */
function tree(html: string): El[] {
  const root: El = { tag: "", classes: [], children: [], html: "" };
  const stack: Array<{ el: El; start: number }> = [{ el: root, start: 0 }];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, close, tag, attrs] = m;
    if (close) {
      const top = stack.pop()!;
      assert.equal(top.el.tag, tag!.toLowerCase(), `</${tag}> closes <${top.el.tag}>`);
      top.el.html = html.slice(top.start, m.index! + m[0].length);
      continue;
    }
    const el: El = { tag: tag!.toLowerCase(), classes: (/\bclass="([^"]*)"/.exec(attrs!)?.[1] ?? "").split(/\s+/).filter(Boolean), children: [], html: m[0] };
    stack.at(-1)!.el.children.push(el);
    if (!VOID.has(el.tag) && !attrs!.trimEnd().endsWith("/")) stack.push({ el, start: m.index! });
  }
  assert.equal(stack.length, 1, "every element closed");
  return root.children;
}

/** THE STALE RULE AS A BROWSER APPLIES IT (app.css `section[data-stale] > div[id] > :not(…)`), to a part's top-level
 *  elements: each greyed unless it matches a simple selector of the rule's `:not` list, or holds one of its `:has`. */
function staleGrey(): (partHtml: string) => Array<{ greyed: boolean; el: El }> {
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  const rules = [...css.matchAll(/section\[data-stale\] > div\[id\] > :not\((.*)\) \{ opacity: [0-9.]+; \}/g)];
  assert.equal(rules.length, 1, "one rule greys a stale section's parts");
  const inner = rules[0]![1]!;
  const has = /:has\(([^)]*)\)/.exec(inner)?.[1] ?? "";
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter((x) => x !== "" && !x.startsWith(":has("));
  const simple = (sel: string) => {
    const m = /^([a-z0-9]*)((?:\.[a-z0-9-]+)+)$/.exec(sel);
    assert.ok(m, `a simple selector the test reads: ${sel}`);
    const classes = m[2]!.split(".").filter(Boolean);
    return (e: El) => (m[1] === "" || e.tag === m[1]) && classes.every((c) => e.classes.includes(c));
  };
  const own = list(inner.replace(/:has\([^)]*\)/, "")).map(simple);
  const held = list(has).map(simple);
  const holds = (e: El): boolean => e.children.some((c) => held.some((f) => f(c)) || holds(c));
  return (partHtml) => tree(partHtml).map((el) => ({ el, greyed: !own.some((f) => f(el)) && !holds(el) }));
}

test("a stale page greys every part of what it read before — the users' table and Tables' list included — and never the answer to what the person just did (a Sync's popover, Add a user's Failure, an added user's password)", async () => {
  const grey = staleGrey();
  const allGreyed = (html: string, what: string) => {
    const els = grey(html);
    assert.ok(els.length > 0, `${what}: written`);
    for (const { el, greyed } of els) assert.ok(greyed, `${what}: read before, so greyed: ${el.html.slice(0, 120)}`);
  };
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(SYNCED), { status: 200 }));
  const app = fn<[unknown], StaleApp>("createApp")(run.fetch) as StaleApp & { syncTable(t: string): Promise<boolean>; dismissAdded(): void };
  // the Overview: its word says it itself; everything else it shows is greyed
  await app.poll();
  run.answers.clear();
  await app.poll();
  assert.notEqual(app.stale(), null, "the Overview is out of date");
  for (const { el, greyed } of grey(app.view().status!)) assert.equal(greyed, !el.classes.includes("health"), `the Overview: ${el.html.slice(0, 120)}`);
  // Tables: the cards and the list greyed; a Sync's answer, a popover, not — and the list beside it still greyed
  for (const [k, a] of new Map(fakeRun().answers)) run.answers.set(k, a);
  run.answers.set("GET api/state", () => new Response(JSON.stringify(SYNCED), { status: 200 }));
  app.show("tables");
  await app.poll();
  run.answers.clear();
  app.show("tables");
  await app.poll();
  assert.notEqual(app.stale(), null, "Tables is out of date");
  allGreyed(app.view()["tables-cards"]!, "Tables' cards");
  allGreyed(app.view().tables!, "Tables' list");
  assert.equal(await app.syncTable("public.events"), false);
  const tables = grey(app.view().tables!);
  const pop = tables.find(({ el }) => el.classes.includes("pop"));
  assert.ok(pop, "the click's answer, a popover");
  assert.match(textOf(pop.el.html), /Mason does not answer at this address/);
  assert.equal(pop.greyed, false, "the answer to the click is from now");
  for (const { el, greyed } of tables) if (el !== pop.el) assert.ok(greyed, `Tables' list beside the answer: greyed: ${el.html.slice(0, 120)}`);
  // Users: the users' table greyed (its header has a column named Added); Add a user's Failure not; an added user's
  // password not
  for (const [k, a] of new Map(fakeRun().answers)) run.answers.set(k, a);
  app.show("users");
  await app.poll();
  run.answers.clear();
  app.show("users");
  await app.poll();
  assert.notEqual(app.stale(), null, "Users is out of date");
  assert.match(app.view().users!, /<th scope="col" class="added">Added<\/th>/, "the users' table, as it is written");
  allGreyed(app.view().users!, "the users' table");
  assert.equal(await app.addUser("grafana"), false);
  const action = grey(app.view().action!);
  assert.match(textOf(app.view().action!), /Mason does not answer at this address/);
  assert.deepEqual(action.map((x) => x.greyed), [false], "Add a user's Failure is from now");
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable", next: [] }), { status: 200 }));
  assert.equal(await app.addUser("grafana"), true);
  assert.notEqual(app.stale(), null, "still out of date: the users were not read again");
  assert.ok(app.view().added!.includes(password));
  assert.ok(grey(app.view().added!).every((x) => !x.greyed), "an added user's password, shown once, is from now");
  allGreyed(app.view().users!, "the users' table beside it");
});

test("in the browser: the shown section is greyed while the poll fails after a good read (its parts, not its controls), never another's, and current again at the first answer", async () => {
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /section\[data-stale\] > div\[id\] > :not\(div\.health, [^{]*\) \{ opacity: 0\.55; \}/, "a stale section's parts greyed; the word says it itself");
  assert.match(css, /\.health\.stale \.word \{ color: var\(--muted\); \}/);
  const run = fakeRun();
  const kept = new Map(run.answers);
  const { el, tick, settle } = fakeBrowser(run, "#overview");
  await settle();
  const stale = (id: string) => el(`page-${id}`).attrs.has("data-stale");
  assert.equal(stale("status"), false, "read: current");
  run.answers.clear();
  tick();
  await settle();
  assert.equal(stale("status"), true, "the poll failed: the Overview it shows is out of date");
  assert.equal(stale("tables"), false, "never a section not shown");
  for (const [k, a] of kept) run.answers.set(k, a);
  tick();
  await settle();
  assert.equal(stale("status"), false, "it answered: current again");
});

test("the app: an added user's password is written once, gone once dismissed and never again; a refusal renders the Failure", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable", next: [] }), { status: 200 }));
  assert.equal(await app.addUser("grafana"), true);
  assert.ok(run.asked.includes(`POST api/users ${JSON.stringify({ name: "grafana" })}`));
  assert.ok(app.view().added!.includes(password));
  await app.poll();
  assert.ok(app.view().added!.includes(password), "a poll does not take it away before it is copied");
  app.dismissAdded();
  await app.poll();
  assert.ok(Object.values(app.view()).every((part) => !part.includes(password)), "once dismissed, nowhere on the page");
  assert.equal(app.model.added, null, "and not kept");

  run.answers.set("POST api/users", () => new Response(JSON.stringify({ error: "there is already a user \"grafana\"",
    failure: { code: "refused", message: "there is already a user \"grafana\"", why: "a name names one user", fix: "mason user remove grafana, then mason user add grafana", next: [{ command: "mason user list", what: "the users" }] } }), { status: 409 }));
  assert.equal(await app.addUser("grafana"), false);
  assert.equal(textOf(app.view().action!), "✗ there is already a user \"grafana\" why a name names one user fix mason user remove grafana, then mason user add grafana Next: mason user list the users");
  assert.equal(app.view().added, "");
});

/** A roles file as the listener holds it (src/duck/grants.ts RolesLive): its roles by name (the tables each reads do not
 *  matter to the add form), its default and what is wrong with it */
const rolesLive = (names: string[], dflt: string | null, problem: string | null = null, file: string | null = "mason/roles.yml"): RolesLive =>
  ({ file, problem, default: dflt, grants: new Map(names.map((name) => [name, { name, all: true }])) }) as unknown as RolesLive;

test("the users' add form: a Role choice where the roles file names roles, its default first and marked; none without one, while it cannot be read, or read-only", () => {
  const renderAddUser = fn<[unknown], string>("renderAddUser");
  // /api/state's roles as the run says them (runState over a roles file): a hostile name escaped, as everything is
  const state = stateOf([], { roles: rolesLive(["everything", "agent", "<b>x\"y</b>"], "everything") });
  const form = renderAddUser(state);
  assert.match(form, /<span class="role-field"><label for="user-role">Role<\/label> <select id="user-role" name="role"><option value="" selected>everything \(default\)<\/option><option value="agent">agent<\/option><option value="&lt;b&gt;x&quot;y&lt;\/b&gt;">&lt;b&gt;x&quot;y&lt;\/b&gt;<\/option><\/select><\/span>/);
  assert.ok(!form.includes("<b>"), "a role's name is text, never markup");
  assert.equal((form.match(/ selected/g) ?? []).length, 1, "one choice preselected: the default");
  assert.ok(form.indexOf('id="user-name"') < form.indexOf('id="user-role"') && form.indexOf('id="user-role"') < form.indexOf('type="submit"'), "Name, Role, Add a user");
  // a file with no default: what mason user add gives with no --role first, no role
  assert.match(renderAddUser(stateOf([], { roles: rolesLive(["agent"], null) })), /<select id="user-role" name="role"><option value="" selected>no role: its statements are refused<\/option><option value="agent">agent<\/option><\/select>/);
  // none: no roles file (the run's state has no roles, or a file of none), a file that names none, one that cannot be read, a read-only page
  const plain = renderAddUser(CATALOG_STATE);
  assert.ok(!plain.includes("<select"), "no roles in the state: the form as before");
  assert.equal(renderAddUser(stateOf([], { roles: rolesLive([], null, null, null) })), plain, "no roles file: as before");
  assert.equal(renderAddUser(stateOf([], { roles: rolesLive([], null) })), plain, "a file naming no role: as before");
  assert.equal(renderAddUser(stateOf([], { roles: rolesLive(["agent"], "agent", "mason/roles.yml: it is not YAML") })), plain, "while it cannot be read: no choice");
  assert.equal(renderAddUser({ ...state, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" }), "", "read-only: no form, no choice");
  // no --set: attributes stay the command's
  assert.ok(!/name="set"|attribute/i.test(form));
  // a long role (63 characters, the longest a name may be) or no default's words never widen the page on a phone: the
  // select shrinks to the card (min-width: 0 in its flex row, max-width: 100%), the rule this form's own
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.#]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule("#add-user .role-field"), /display: inline-flex;[\s\S]*max-width: 100%;/);
  assert.match(rule("#add-user .role-field select"), /min-width: 0;[\s\S]*max-width: 100%;/);
  assert.ok(!/white-space: nowrap/.test(rule("#add-user .role-field")), "nothing holds the pair wider than the card");
});

test("the app: the add form's role is sent as role (none for the default, as mason user add with no --role); the run's refusal of it is shown", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(stateOf([], { roles: rolesLive(["everything", "agent"], "everything") })), { status: 200 }));
  const app = fn<[unknown], App & { pages: Map<string, { submit(f: unknown): Promise<void> | null }> }>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  assert.match(app.view()["add-user-box"]!, /<select id="user-role" name="role">/, "the page's form offers the roles of the run's state");
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, role: "agent", roleFrom: "file", next: [] }), { status: 200 }));
  // submitted as the browser's form: the name and the role chosen
  const submitted = { id: "add-user", elements: { name: { value: " grafana " }, role: { value: "agent" } } };
  await app.pages.get("users")!.submit(submitted);
  assert.ok(run.asked.includes(`POST api/users ${JSON.stringify({ name: "grafana", role: "agent" })}`), run.asked.join("\n"));
  assert.equal(submitted.elements.name.value, "", "added: the name cleared");
  app.dismissAdded();
  // the default chosen: no role sent, so the user follows the file's default as one added with no --role does
  run.asked.length = 0;
  await app.pages.get("users")!.submit({ id: "add-user", elements: { name: { value: "metabase2" }, role: { value: "" } } });
  assert.ok(run.asked.includes(`POST api/users ${JSON.stringify({ name: "metabase2" })}`), run.asked.join("\n"));
  app.dismissAdded();
  // the run judges the role (src/cli/user.ts roleToAdd, as mason user add --role): its refusal, worded by the run, shown
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ error: "there is no role gone in mason/roles.yml",
    failure: { code: "not_found", message: "there is no role gone in mason/roles.yml", why: "a role is a key of mason/roles.yml", fix: "mason user add grafana --role everything", next: [] } }), { status: 404 }));
  assert.equal(await app.addUser("grafana", "gone"), false);
  assert.ok(run.asked.includes(`POST api/users ${JSON.stringify({ name: "grafana", role: "gone" })}`));
  assert.equal(textOf(app.view().action!), "✗ there is no role gone in mason/roles.yml why a role is a key of mason/roles.yml fix mason user add grafana --role everything");
  assert.equal(app.view().added, "");
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends DELETE api/users/<name> and reads the users again", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  app.askRemove("metabase");
  assert.match(textOf(app.view().users!), /Remove metabase\? It connects no more/);
  app.cancelRemove();
  assert.ok(!/It connects no more/.test(app.view().users!));
  // a refusal is said beside the user's actions until it is dismissed: across polls, then Escape (the page's dismiss) takes it
  app.askRemove("metabase");
  const refusal = { code: "refused", message: "metabase cannot be removed now", next: [] };
  run.answers.set("DELETE api/users/metabase", () => new Response(JSON.stringify({ error: refusal.message, failure: refusal }), { status: 409 }));
  assert.equal(await app.confirmRemove("metabase"), false);
  await app.poll();
  assert.match(textOf(popOf(app.view().users!, "act-users-metabase")), /^✗ metabase cannot be removed now Dismiss$/, "a poll on: still said");
  const users = (app as unknown as { pages: Map<string, { dismiss(): unknown }> }).pages.get("users")!;
  assert.equal(users.dismiss(), true);
  assert.equal(popsOf(app.view().users!).length, 0, "gone on Escape");
  app.askRemove("metabase");
  run.answers.set("DELETE api/users/metabase", () => new Response(JSON.stringify({ removed: { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z" }, next: [] }), { status: 200 }));
  run.answers.set("GET api/users?lastUsed=1", () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
  run.asked.length = 0;
  assert.equal(await app.confirmRemove("metabase"), true);
  assert.deepEqual(run.asked, ["DELETE api/users/metabase", "GET api/users?lastUsed=1"]);
  assert.equal(textOf(app.view().users!), "No users yet A user is the name and password psql, a BI tool or your app connects with. Add one above, as mason user add <name> does: its URL, password included, is shown once.");
  assert.equal(app.model.confirming, null);
});

test("the users: a disabled user says Disabled and when, as mason user list does, with Enable in Disable's room; Disable asks first in a popover, in mason user disable's words", () => {
  const renderUsers = fn<[unknown, unknown, number?, unknown?], string>("renderUsers");
  const list = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, disabledAt: null, live: true, lastUsedAt: null, url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "grafana", id: "fedcba9876543210", addedAt: "2026-10-20T08:00:00.000Z", removedAt: null, disabledAt: "2026-10-28T09:00:59.000Z", live: false, lastUsedAt: null, url: "postgres://grafana@127.0.0.1:5433/shop" }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const NOW_U = Date.parse("2026-10-28T09:15:59.000Z");
  const html = renderUsers(list, null, NOW_U);
  assert.deepEqual([...html.matchAll(/<span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`),
    ["ok Active", "warn Disabled 2026-10-28 09:00 UTC"]);
  assert.ok(!/rotated/.test(html), "a disabled user is said disabled, not as one the key's rotation stopped");
  assert.match(html, /<td class="act" id="act-users-metabase"><a class="btn small" href="#observability\/queries\?user=metabase&amp;range=24h" title="the statements metabase sent in the last 24 hours">Queries<\/a> <button type="button" class="small" data-disable="metabase" data-room="Disable">Disable<\/button> <button type="button" class="danger small" data-remove="metabase">Remove<\/button><\/td>/);
  assert.match(html, /<td class="act" id="act-users-grafana"><a class="btn small" href="#observability\/queries\?user=grafana&amp;range=24h" title="the statements grafana sent in the last 24 hours">Queries<\/a> <button type="button" class="small" data-enable="grafana" data-room="Disable">Enable<\/button> <button type="button" class="danger small" data-remove="grafana">Remove<\/button><\/td>/);
  assert.equal(popsOf(html).length, 0, "Enable asks nothing");
  const asking = renderUsers(list, { name: "metabase", verb: "disable" }, NOW_U);
  assert.equal(textOf(popOf(asking, "act-users-metabase")), "Disable metabase? It connects no more until mason user enable metabase, with the same password, and the sessions it holds end at their next statement. Disable metabase Cancel");
  assert.match(asking, /data-confirm-disable="metabase"/);
  assert.match(asking, /<button type="button" class="small" data-room="Disable" aria-expanded="true" disabled>Disable<\/button>/, "held where it was while it asks");
  assert.ok(!/data-confirm-remove/.test(asking), "a Disable's question, not a Remove's");
});

test("Users: a disable's words and a disabled user's state are mason user's (disableEffect, disabledText in src/cli/user.ts)", async () => {
  const cli = await import("../src/cli/user.ts") as unknown as { disableEffect?: (n: string) => string; disabledText?: (at: string) => string };
  assert.equal(typeof cli.disableEffect, "function", "src/cli/user.ts exports disableEffect");
  assert.equal(typeof cli.disabledText, "function", "src/cli/user.ts exports disabledText");
  const usersPage = await import(path.join(WEB, "pages", "users.js") as string) as { disableEffect: (n: string) => string; disabledText: (at: string) => string };
  for (const n of ["metabase", "bi.team_1"]) assert.equal(usersPage.disableEffect(n), cli.disableEffect!(n));
  for (const at of ["2026-10-28T09:00:59.000Z", "2026-01-02T03:04:05.678Z"]) assert.equal(usersPage.disabledText(at), cli.disabledText!(at));
});

test("the app: Disable asks first and its confirm sends POST api/users/<name>/disable; Enable sends /enable at once; each reads the users again; a refusal is said beside the user's actions", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  const a = app as unknown as { askDisable: (n: string) => void; confirmDisable: (n: string) => Promise<boolean>; enableUser: (n: string) => Promise<boolean> };
  a.askDisable("metabase");
  assert.match(textOf(app.view().users!), /Disable metabase\? It connects no more until mason user enable metabase/);
  app.cancelRemove();
  assert.ok(!/Disable metabase\?/.test(app.view().users!));
  const disabledList = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", disabledAt: "2026-10-28T09:00:00.000Z", live: false }] };
  run.answers.set("POST api/users/metabase/disable", () => new Response(JSON.stringify({ disabled: { name: "metabase" }, already: false, next: [] }), { status: 200 }));
  run.answers.set("GET api/users?lastUsed=1", () => new Response(JSON.stringify(disabledList), { status: 200 }));
  run.asked.length = 0;
  a.askDisable("metabase");
  assert.equal(await a.confirmDisable("metabase"), true);
  assert.deepEqual(run.asked, ["POST api/users/metabase/disable", "GET api/users?lastUsed=1"]);
  assert.equal(app.model.confirming, null);
  assert.match(textOf(app.view().users!), /Disabled 2026-10-28 09:00 UTC .* Enable Remove/);
  // Enable: no question; refused, said in a popover beside the user's actions until dismissed
  run.answers.set("POST api/users/metabase/enable", () => new Response(JSON.stringify({ error: "no", failure: { code: "failed", message: "the list of users could not be changed: busy", next: [] } }), { status: 500 }));
  run.asked.length = 0;
  assert.equal(await a.enableUser("metabase"), false);
  assert.deepEqual(run.asked, ["POST api/users/metabase/enable"]);
  assert.equal(textOf(popOf(app.view().users!, "act-users-metabase")), "✗ the list of users could not be changed: busy Dismiss");
  run.answers.set("POST api/users/metabase/enable", () => new Response(JSON.stringify({ enabled: { name: "metabase" }, already: false, next: [] }), { status: 200 }));
  run.answers.set("GET api/users?lastUsed=1", () => new Response(JSON.stringify({ users: [{ ...disabledList.users[0], disabledAt: null, live: true }] }), { status: 200 }));
  run.asked.length = 0;
  assert.equal(await a.enableUser("metabase"), true);
  assert.deepEqual(run.asked, ["POST api/users/metabase/enable", "GET api/users?lastUsed=1"]);
  assert.match(textOf(app.view().users!), /Active .* Disable Remove$/);
  assert.equal(popsOf(app.view().users!).length, 0, "the refusal went with the answer");
});

// ------------------------------------------------------------------ where a user connects from (mason user add --from, mason user from; issue 813)

test("the users: each user's addresses on a line under its role, as mason user says them — from its ranges, or from anywhere; the line is its From…; a removed user's none; read-only, the words alone", async () => {
  const renderUsers = fn<[unknown, unknown, number?, unknown?, unknown?, unknown?], string>("renderUsers");
  const { rangesText } = await import("../src/cli/user.ts");
  const page = await import(path.join(WEB, "pages", "users.js") as string) as { rangesText: (f: unknown) => string; fromText: (f: unknown) => string };
  for (const f of [null, undefined, ["192.0.2.0/24"], ["192.0.2.0/24", "2001:db8::/32", "198.51.100.7/32"]]) assert.equal(page.rangesText(f), rangesText(f as string[] | null), JSON.stringify(f));
  const at = { addedAt: "2026-10-27T09:10:11.000Z", live: true, lastUsedAt: null, url: null };
  const list = { users: [{ name: "looker", id: "0000000000000001", ...at, removedAt: null, from: ["192.0.2.0/24", "2001:db8::/32"] }, { name: "metabase", id: "0000000000000002", ...at, removedAt: null, from: null },
    { name: "old", id: "0000000000000003", ...at, removedAt: "2026-10-28T09:00:00.000Z", from: ["192.0.2.0/24"] }], lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const html = renderUsers(list, null, Date.parse("2026-10-29T09:00:00.000Z"));
  assert.match(textOf(html), /^User Role Status Added Last used looker id 0000000000000001 every table from 192\.0\.2\.0\/24, 2001:db8::\/32 Active 2026-10-27 09:10 UTC .* Queries Disable Remove metabase id 0000000000000002 every table from anywhere Active 2026-10-27 /);
  // the line is its From…, its whole the title (the column cuts it); no column of its own, no button in the actions
  assert.match(html, /<span class="dim">every table<\/span><button type="button" class="from-line" data-from="looker" title="from 192\.0\.2\.0\/24, 2001:db8::\/32: change where looker connects from">from 192\.0\.2\.0\/24, 2001:db8::\/32<\/button><\/td>/);
  assert.equal([...html.matchAll(/<th scope="col"/g)].length, 6, "the columns as before");
  assert.ok(![...html.matchAll(/<td class="act"[^>]*>(.*?)<\/td>/gs)].some((m) => m[1]!.includes("data-from")), "the actions as before");
  assert.ok(!/data-from="old"/.test(html) && !/<tr class="removed">.*?from-line/s.test(html), "a removed user connects from nowhere: nothing said");
  // asking: its line held, disabled, as Disable is
  assert.match(renderUsers(list, { name: "looker", verb: "from" }), /<button type="button" class="from-line" title="[^"]*" aria-expanded="true" disabled>from 192\.0\.2\.0\/24, 2001:db8::\/32<\/button>/);
  // read-only: the words alone, never a control
  const ro = renderUsers(list, null, Date.parse("2026-10-29T09:00:00.000Z"), null, null, "the web page is read-only here (MASON_UI_READ_ONLY=1)");
  assert.match(ro, /<span class="from-line" title="from anywhere">from anywhere<\/span>/);
  assert.ok(!/data-from=/.test(ro));
});

test("the users: From… asks where the user connects from in a popover beside its actions, as Disable asks, opened at its ranges now; no row inserted", () => {
  const renderUsers = fn<[unknown, unknown, number?, unknown?], string>("renderUsers");
  const at = { addedAt: "2026-10-27T09:10:11.000Z", live: true, lastUsedAt: null, url: null, removedAt: null };
  const list = { users: [{ name: "looker", id: "0000000000000001", ...at, from: ["192.0.2.0/24", "2001:db8::/32"] }, { name: "metabase", id: "0000000000000002", ...at, from: null }], lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const asking = renderUsers(list, { name: "looker", verb: "from" });
  const pops = popsOf(asking);
  assert.equal(pops.length, 1);
  assert.equal(pops[0]!.anchor, "act-users-looker");
  assert.match(pops[0]!.html, /^<div class="pop ask" data-anchor="act-users-looker" role="dialog" aria-label="Where looker connects from">/);
  assert.equal(textOf(pops[0]!.html), "Where looker connects from, as mason user from looker sets it: the sessions it holds from another address end at their next statement. Connects from From anywhere Only from these addresses any address Address ranges, comma-separated Change looker Cancel");
  assert.match(pops[0]!.html, /<input type="radio" name="connects" value="only" checked>/, "opened at its ranges");
  assert.match(pops[0]!.html, /<input id="user-from-from" name="from"[^>]* value="192\.0\.2\.0\/24, 2001:db8::\/32">/);
  assert.match(pops[0]!.html, /<input type="hidden" name="user" value="looker"><\/form>/);
  assert.match(pops[0]!.html, /data-pop-close/, "Escape presses its Cancel");
  assert.ok(!/pattern=|required/.test(pops[0]!.html), "the run judges each range, never the page");
  // its From… held where it was while it asks; no row and no cell added
  assert.match(asking, /<button type="button" class="from-line" title="[^"]*" aria-expanded="true" disabled>from 192\.0\.2\.0\/24, 2001:db8::\/32<\/button>/, "its line held while it asks");
  assert.equal(textOf(withoutPops(asking)), textOf(renderUsers(list, null)), "the rows say what they said");
  // a user from anywhere opens at From anywhere, its box empty
  const any = popOf(renderUsers(list, { name: "metabase", verb: "from" }), "act-users-metabase");
  assert.match(any, /<input type="radio" name="connects" value="any" checked>/);
  assert.match(any, /name="from"[^>]* value="">/);
});

test("the add form: Connects from, in mason user add's words — From anywhere (the default, no from sent) or Only from these addresses, a comma list as --from takes it, the run judging each", async () => {
  const renderAddUser = fn<[unknown], string>("renderAddUser");
  const form = renderAddUser(CATALOG_STATE);
  assert.match(textOf(form), /Name Connects from From anywhere Only from these addresses any address Address ranges, comma-separated Add a user$/);
  // the field's place is kept under from anywhere, saying rangesText(null) to the eye alone (issue 875; geometry: tests/web-radio-groups.test.ts)
  assert.match(form, /<span class="ranges"><span class="ranges-any" aria-hidden="true">any address<\/span><span class="ranges-field">/);
  assert.match(form, /<input type="radio" name="connects" value="any" checked> From anywhere/, "from anywhere is the default, as mason user add with no --from");
  assert.match(form, /<input type="radio" name="connects" value="only"> Only from these addresses/);
  assert.match(form, /<input id="add-user-from" name="from" spellcheck="false" autocapitalize="off" placeholder="e\.g\. 192\.0\.2\.0\/24, 2001:db8::\/32" value="">/);
  assert.ok(!/pattern=/.test(form), "never validated in the page");
  const { rangesOf } = await import(path.join(WEB, "pages", "users.js") as string) as { rangesOf: (e: unknown) => string[] | null };
  assert.equal(rangesOf({ connects: { value: "any" }, from: { value: "192.0.2.0/24" } }), null, "from anywhere: what is typed is not sent");
  assert.equal(rangesOf({}), null, "no choice: from anywhere");
  assert.deepEqual(rangesOf({ connects: { value: "only" }, from: { value: " 192.0.2.0/24 ,2001:db8::/32, " } }), ["192.0.2.0/24", "2001:db8::/32"]);
  assert.deepEqual(rangesOf({ connects: { value: "only" }, from: { value: "not a range" } }), ["not a range"], "sent as typed: the run refuses it");
  assert.deepEqual(rangesOf({ connects: { value: "only" }, from: { value: "" } }), [], "none: sent as none, for the run to refuse");
});

test("the app: the add form sends from only when Only from these addresses is chosen; the run's refusal of a range is shown as the run words it", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App & { pages: Map<string, { submit(f: unknown): Promise<void> | null }> }>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  assert.match(app.view()["add-user-box"]!, /name="connects" value="only"/);
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, next: [] }), { status: 200 }));
  const users = app.pages.get("users")!;
  await users.submit({ id: "add-user", elements: { name: { value: "grafana" }, role: { value: "" }, connects: { value: "any" }, from: { value: "192.0.2.0/24" } } });
  assert.ok(run.asked.includes(`POST api/users ${JSON.stringify({ name: "grafana" })}`), run.asked.join("\n"));
  app.dismissAdded();
  run.asked.length = 0;
  await users.submit({ id: "add-user", elements: { name: { value: "looker" }, role: { value: "" }, connects: { value: "only" }, from: { value: "192.0.2.0/24, 2001:db8::/32" } } });
  assert.ok(run.asked.includes(`POST api/users ${JSON.stringify({ name: "looker", from: ["192.0.2.0/24", "2001:db8::/32"] })}`), run.asked.join("\n"));
  app.dismissAdded();
  // a range the run cannot read: its refusal (src/cli/user.ts rangesToSet), as the run words it, and no password card
  const failure = { code: "usage", message: "mason user add looker: 192.0.2.0/33: a prefix length of 0 to 32", fix: "an IPv4 or IPv6 range with its prefix length (10.0.0.0/16, 2001:db8::/32) or one address (192.0.2.10), one --from each", next: [] };
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ error: failure.message, failure }), { status: 400 }));
  const input = { value: "looker" };
  await users.submit({ id: "add-user", elements: { name: input, role: { value: "" }, connects: { value: "only" }, from: { value: "192.0.2.0/33" } } });
  assert.equal(textOf(app.view().action!), `✗ ${failure.message} fix ${failure.fix}`);
  assert.equal(app.view().added, "");
  assert.equal(input.value, "looker", "refused: the name stays to fix");
});

test("the app: From… sends POST api/users/<name>/from — the ranges, or null for from anywhere — and reads the users again; held while it asks; a refusal is said beside the user's actions", async () => {
  const run = fakeRun();
  const looker = { name: "looker", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true, from: ["192.0.2.0/24"] };
  run.answers.set("GET api/users?lastUsed=1", answer({ users: [looker] }));
  const app = fn<[unknown], App & { pages: Map<string, { submit(f: unknown): Promise<void> | null; click(d: unknown, b: unknown, env: unknown): unknown }> }>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  const users = app.pages.get("users")!;
  users.click({ from: "looker" }, null, {});
  const asking = app.view().users!;
  assert.match(popOf(asking, "act-users-looker"), /<form id="user-from"/);
  // HELD while it asks: a poll whose list moved does not rewrite the form under what is being typed
  run.answers.set("GET api/users?lastUsed=1", answer({ users: [{ ...looker, lastUsedAt: "2026-10-27T09:12:00.000Z", from: ["198.51.100.0/24"] }] }));
  await app.poll();
  assert.equal(app.view().users, asking, "the list as it opened");
  // Change: the ranges typed, as mason user from looker 198.51.100.0/24 2001:db8::/32
  run.answers.set("POST api/users/looker/from", answer({ changed: { name: "looker", id: looker.id, addedAt: looker.addedAt, from: ["198.51.100.0/24", "2001:db8::/32"] }, already: false, next: [] }));
  run.answers.set("GET api/users?lastUsed=1", answer({ users: [{ ...looker, from: ["198.51.100.0/24", "2001:db8::/32"] }] }));
  run.asked.length = 0;
  await users.submit({ id: "user-from", elements: { user: { value: "looker" }, connects: { value: "only" }, from: { value: "198.51.100.0/24, 2001:db8::/32" } } });
  assert.deepEqual(run.asked, [`POST api/users/looker/from ${JSON.stringify({ from: ["198.51.100.0/24", "2001:db8::/32"] })}`, "GET api/users?lastUsed=1"]);
  assert.equal(app.model.confirming, null);
  assert.equal(popsOf(app.view().users!).length, 0);
  assert.match(textOf(app.view().users!), /from 198\.51\.100\.0\/24, 2001:db8::\/32 Active /);
  // From anywhere: null, as mason user from looker --any
  run.answers.set("GET api/users?lastUsed=1", answer({ users: [{ ...looker, from: null }] }));
  run.asked.length = 0;
  users.click({ from: "looker" }, null, {});
  await users.submit({ id: "user-from", elements: { user: { value: "looker" }, connects: { value: "any" }, from: { value: "198.51.100.0/24" } } });
  assert.equal(run.asked[0], `POST api/users/looker/from ${JSON.stringify({ from: null })}`);
  assert.match(textOf(app.view().users!), /from anywhere Active /);
  // refused (a range the run cannot read): the run's words in a popover beside the user's actions, until dismissed
  const failure = { code: "usage", message: "mason user from looker: 192.0.2.0/33: a prefix length of 0 to 32", next: [] };
  run.answers.set("POST api/users/looker/from", () => new Response(JSON.stringify({ error: failure.message, failure }), { status: 400 }));
  users.click({ from: "looker" }, null, {});
  await users.submit({ id: "user-from", elements: { user: { value: "looker" }, connects: { value: "only" }, from: { value: "192.0.2.0/33" } } });
  assert.equal(textOf(popOf(app.view().users!, "act-users-looker")), `✗ ${failure.message} Dismiss`);
  // Cancel: the question goes, and the list is the latest again
  users.click({ from: "looker" }, null, {});
  app.cancelRemove();
  assert.equal(popsOf(app.view().users!).length, 0);
});

test("a read-only page that still manages its users (pageReadOnlyAllow: [users]): Users has Add a user, Connects from, From…, Disable, Enable and Remove; every other page writes no control that sends a change — Tables none — and says why (issue 813)", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const state = { ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["users"] };
  const shown = await pageByPage(state);
  const users = shown.byPage.get("users")!;
  for (const control of ['id="add-user"', 'name="connects"', "data-from=", "data-disable=", "data-enable=", "data-remove="]) assert.ok(users.includes(control), `Users: ${control}`);
  assert.ok(!textOf(users).includes("Users are not added"), "Users says nothing is refused");
  // BY RULE over every page the app wrote: every button but the Users page's own only shows, copies or moves what is shown
  const USER_BUTTONS = /^data-(from|disable|enable|remove)$/;
  for (const control of WRITE_CONTROLS.filter((c) => c !== 'id="add-user"' && !USER_BUTTONS.test(c.replace(/=$/, "")))) assert.ok(!shown.all.includes(control), control);
  const buttons = [...shown.all.replace(/<form id="add-user"[\s\S]*?<\/form>/g, "").matchAll(/<button\b([^>]*)>/g)].map((m) => [...m[1]!.matchAll(/\b(data-[a-z-]+)/g)].map((d) => d[1]!).filter((d) => d !== "data-room"));
  for (const data of buttons) assert.ok(data.length > 0 && data.every((d) => VIEW_BUTTONS.test(d) || USER_BUTTONS.test(d)), `a button that may send a change: ${data.join(" ")}`);
  assert.ok(!/<form\b(?![^>]*id="(request-filters|add-user)")/.test(shown.all), "no form but the request log's filters and Add a user");
  assert.ok(!/Add a table|Connect from anywhere|<a class="btn[^"]*" href="#tables[^"]*"/.test(shown.all), "no lead to a table or a share");
  // each page says why it offers no change: the Overview without the users, Tables and Usage as before
  for (const [id, line] of [["status", `Nothing is shared or added from this page: ${why}.`], ["tables", `Tables are not added, removed or synced from this page: ${why}.`],
    ["usage", `Statements are not cancelled from this page: ${why}.`]] as const) assert.ok(textOf(shown.byPage.get(id)!).includes(line), `${id}: ${line}`);
  // Connect's Create a user and the checklist's, never Add a table
  assert.match(shown.byPage.get("status")!, /<a class="btn[^"]*" href="#users">Create a user<\/a>/);
  const { renderChecklist: checklist } = await import(path.join(WEB, "pages", "status.js") as string) as { renderChecklist: (s: unknown, q: unknown, u: unknown) => string };
  const noneYet = { queries: { week: { completed: 0 } } }, nobody = { users: [] };
  const fresh = checklist({ ...NONE, pageReadOnly: why, pageReadOnlyAllow: ["users"] }, noneYet, nobody);
  assert.match(fresh, /href="#users">Create a user/);
  assert.ok(!/Add a table/.test(fresh));
  // the renderers alone: an allowance the page does not know is no allowance; without the page read-only nothing changes
  const renderAddUser = fn<[unknown], string>("renderAddUser");
  assert.equal(renderAddUser(state), renderAddUser(CATALOG_STATE), "the add form as on a page that is not read-only");
  assert.equal(renderAddUser({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["tables"] }), "", "only tables allowed: no form");
  assert.equal(renderAddUser({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["user"] }), "", "an area the page does not know");
  assert.equal(renderAddUser({ ...CATALOG_STATE, pageReadOnlyAllow: ["users"] }), renderAddUser(CATALOG_STATE));
});

test("a read-only page that still changes its tables and its users (pageReadOnlyAllow: [tables, users]): both pages' controls; the Overview says only that nothing is shared; Cancel and the share still absent (issue 813)", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const shown = await pageByPage({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["tables", "users"] });
  for (const control of ["data-add-table", "data-sync-table", "data-remove-table", 'id="add-user"', "data-from=", "data-disable="]) assert.ok(shown.all.includes(control), control);
  for (const control of ["data-ask-cancel", "data-share-ask"]) assert.ok(!shown.all.includes(control), control);
  assert.ok(textOf(shown.byPage.get("status")!).includes(`Nothing is shared from this page: ${why}.`));
  assert.ok(textOf(shown.byPage.get("usage")!).includes(`Statements are not cancelled from this page: ${why}.`));
  assert.ok(!/are not added/.test(textOf(shown.all)), "Tables and Users say nothing is refused");
});

test("a read-only page that changes its tables alone (pageReadOnlyAllow: [tables]): Users writes no From…, and no form (issue 813)", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const shown = await pageByPage({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["tables"] });
  const users = shown.byPage.get("users")!;
  for (const control of ['id="add-user"', 'name="connects"', "data-from=", "data-disable=", "data-enable=", "data-remove="]) assert.ok(!users.includes(control), control);
  assert.ok(textOf(users).includes(`Users are not added, changed, disabled or removed from this page: ${why}.`));
});

test("the app: Add sends POST api/pick, says what was added beside its table's actions, and reads the state again: the copy shows starting", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  run.answers.set("POST api/pick", () => {
    // the run writes the sources file: from now on its state has the table added
    run.answers.set("GET api/state", answer(ACCOUNTS_ADDED));
    return answer({ ...PICKED.secret, state: ACCOUNTS_ADDED })();
  });
  run.asked.length = 0;
  assert.equal(await app.addTable("public.accounts"), true);
  assert.deepEqual(run.asked, [`POST api/pick ${JSON.stringify({ table: "public.accounts", picked: true })}`, "GET api/state"],
    "every column, as mason add accounts asks; then the state again (the page's own read: nothing else)");
  const v = app.view();
  assert.match(textOf(v.tables!), /public\.accounts Waiting ~300 rows key id — View events Sync now Remove Sync… waiting for its first sync to start public\.event_log/);
  assert.match(textOf(popOf(v.tables!, "act-tables-public.accounts")), /^Added public\.accounts to mason\/sources\/shop\.yml: every column but password_hash sync: off \(the default\): .* left out password_hash: it looks like a secret/);
  assert.match(textOf(v.status!), /public\.accounts waiting for its first sync to start/, "the Overview shows the copy starting");
  app.dismissOutcome();
  assert.ok(!/Added public\.accounts/.test(app.view().tables!));
});

test("the app: the form sends the columns ticked as columns and the key's as key, nothing when none is ticked", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  run.answers.set("POST api/pick", answer({ ...PICKED.keyed, state: COPYING }));
  assert.deepEqual(fn<[string, string[]?, string[]?], unknown>("pickBody")("public.audit", [], []), { table: "public.audit", picked: true });
  assert.equal(await app.choose("public.event_log"), true);
  assert.equal(app.model.choosing, "public.event_log");
  assert.deepEqual(run.asked, ["GET api/tables/public.event_log/columns"], "its columns read once, as the form opens: the state the page polls has none");
  run.asked.length = 0;
  assert.equal(await app.addTable("public.event_log", ["payload"], ["tenant_id", "id"]), true);
  assert.equal(run.asked[0], `POST api/pick ${JSON.stringify({ table: "public.event_log", picked: true, columns: ["payload"], key: ["tenant_id", "id"] })}`);
  assert.equal(app.model.choosing, null, "added: the form closes");
  run.asked.length = 0;
  await app.addTable("public.event_log", [], ["tenant_id", "id"]);
  assert.equal(run.asked[0], `POST api/pick ${JSON.stringify({ table: "public.event_log", picked: true, key: ["tenant_id", "id"] })}`, "no column ticked: every column");
});

test("the app: a refusal to add renders the server's Failure in its table's form, in its words, and the form stays open", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  const message = "public.event_log cannot be added: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id (its unique index event_log_tenant_id_id_key)";
  run.answers.set("POST api/pick", answer({ error: message, failure: { code: "refused", message, next: [] } }, 409));
  await app.choose("public.event_log");
  run.asked.length = 0;
  assert.equal(await app.addTable("public.event_log"), false);
  assert.deepEqual(run.asked, [`POST api/pick ${JSON.stringify({ table: "public.event_log", picked: true })}`], "nothing read again: nothing changed");
  const tables = app.view().tables!;
  assert.ok(tables.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
  assert.match(popOf(tables, "act-tables-public.event_log"), /^<div class="pop ask"[^>]*><div class="failure" role="alert">.*data-pick-form="public\.event_log"/s, "the form stays, to name its key, under the refusal");
  // refused with boxes ticked: the form written again under its refusal keeps them ticked
  await app.addTable("public.event_log", ["payload"], ["id"]);
  assert.deepEqual([...app.view().tables!.matchAll(/name="(key|columns)" value="([^"]*)" checked/g)].map((m) => `${m[1]}=${m[2]}`), ["key=id", "columns=payload"]);
  app.cancelChoose();
  // a sources file the run cannot edit: the server's Failure as it sent it
  const file = "mason/sources/ has 2 source files: one source per project for now";
  run.answers.set("POST api/pick", answer({ error: file, failure: { code: "refused", message: file, next: [] } }, 409));
  await app.addTable("public.audit");
  assert.match(textOf(popOf(app.view().tables!, "act-tables-public.audit")), /^✗ mason\/sources\/ has 2 source files: one source per project for now Dismiss$/);
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends POST api/remove and reads the state again", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(ACCOUNTS_ADDED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  app.askRemoveTable("public.accounts");
  assert.equal(textOf(popOf(app.view().tables!, "act-tables-public.accounts")), "Remove accounts? Mason stops syncing it and drops its synced data. Remove accounts Cancel");
  app.cancelRemoveTable();
  assert.ok(!/Mason stops syncing it/.test(app.view().tables!));
  assert.equal(app.model.removing, null);
  app.askRemoveTable("public.accounts");
  run.answers.set("POST api/remove", () => {
    run.answers.set("GET api/state", answer(CATALOG_STATE));
    return answer({ removed: ["public.accounts"], file: FILE, state: CATALOG_STATE })();
  });
  run.asked.length = 0;
  assert.equal(await app.confirmRemoveTable("public.accounts"), true);
  assert.deepEqual(run.asked, [`POST api/remove ${JSON.stringify({ tables: ["public.accounts"] })}`, "GET api/state"]);
  assert.match(textOf(app.view().tables!), /public\.accounts Not added ~300 rows key id Add Columns… public\.event_log/);
  assert.match(textOf(popOf(app.view().tables!, "act-tables-public.accounts")), /^Removed public\.accounts from mason\/sources\/shop\.yml Tip: Mason stops syncing it and drops its synced data/);
  assert.equal(app.model.removing, null);
  // refused: the server's words
  const message = "shop.yml names no table orders — did you mean `orders`? (it names customers)";
  run.answers.set("POST api/remove", answer({ error: message, failure: { code: "not_found", message, next: [] } }, 404));
  assert.equal(await app.confirmRemoveTable("public.orders"), false);
  assert.match(textOf(popOf(app.view().tables!, "act-tables-public.orders")), /^✗ shop\.yml names no table orders — did you mean `orders`\? \(it names customers\) Dismiss$/);
});

// ------------------------------------------------------------------ the files: under the CSP, never the token

/** Every file under src/web/ (relative to it): the shell, the shared module, each page's module, the stylesheet. */
const webFiles = (dir = WEB): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? webFiles(path.join(dir, e.name)) : [path.relative(WEB, path.join(dir, e.name))]);

test("the page's files fetch nothing from elsewhere and never touch the token: the address but its hash, the cookie, storage", async () => {
  const files = webFiles().sort();
  assert.ok(files.includes(path.join("pages", "status.js")) && files.includes("shared.js"), "the pages' modules are checked with the rest");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  // the nav's links are the page's own hash (#tables): nothing is loaded by them
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("#")), ["data:,", "app.css", "vendor/uplot-1.6.32/uPlot.min.css", "app.js"],
    "every file the page loads is the server's allowlist (or inline); the modules are imported by app.js");
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts") as { PAGE_ROUTES: Record<string, readonly [string, string]> };
  for (const f of files) {
    // what is vendored is a third party's, copied whole (src/web/vendor/README.md): its comments name its sites, and it is never edited
    if (f.startsWith(`vendor${path.sep}`)) continue;
    const text = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.ok(!/https?:\/\//.test(text), `${f} names no other site: a CDN or a font would break the CSP`);
    assert.ok(!/@import/.test(text), `${f} loads no stylesheet but the page's own`);
    // url( only for a font of the page's own, in an @font-face: a relative path to a woff2 under vendor/ that is a route
    for (const u of text.replace(/@font-face\s*\{[^}]*\}/g, "").matchAll(/url\(/g)) assert.fail(`${f}: url( outside an @font-face (at ${u.index})`);
    for (const face of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const urls = [...face[1]!.matchAll(/url\(\s*("?)([^")\s]*)\1\s*\)/g)].map((m) => m[2]!);
      assert.ok(urls.length > 0 && [...face[1]!.matchAll(/url\(/g)].length === urls.length, `${f}: every url( of an @font-face is a plain path`);
      for (const u of urls) {
        assert.match(u, /^vendor\/[\w.-]+\/[\w.-]+\.woff2$/, `${f}: a font is the page's own woff2 under vendor/, relative (${u})`);
        assert.deepEqual(PAGE_ROUTES[`/${u}`], [u, "font/woff2"], `${u} is a route, served as a font`);
      }
    }
    assert.ok(!/duckdb/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f}: never the engine's name`);
    if (!f.endsWith(".js")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // the hash chooses the page shown (#status): it never holds the token, which the first request traded for the cookie
    // and dropped from the address; every other part of `location` (search, href) is refused, as the cookie and storage are.
    // `location.replace(…)` reads nothing: it leaves for a page the host replaced a view with (MASON_UI_NAV_*, issue 789),
    // at app.js's two call sites alone (`leave`'s answer, a hash or the host's URL), each pinned so a new one is seen
    assert.ok(!/\blocation\b(?!\.hash\b|\.replace\(to\.(?:hash|url)\))|document\.cookie|localStorage|sessionStorage|indexedDB|[?&]token=|\.token\b/.test(code),
      `${f}: the cookie carries the token; the page's script never reads it, the address (but its hash) or storage`);
    assert.deepEqual([...code.matchAll(/\blocation\.replace\([^)]*\)/g)].map((m) => m[0]),
      f === "app.js" ? ["location.replace(to.hash)", "location.replace(to.url)"] : [], `${f}: the page leaves only where app.js's leave says`);
    // every module it imports is the page's own, a route of PAGE_ROUTES (tests/cli-run-server.test.ts serves each)
    // (a vendored module keeps its own name: Lucide's icons are .mjs, src/web/vendor/README.md)
    for (const m of code.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)) assert.match(m[1] ?? m[2]!, /^\.\.?\/(?:[\w/.-]+\.js|vendor\/[\w.-]+\/[\w.-]+\.mjs)$/, `${f} imports ${m[1] ?? m[2]} by a relative path`);
  }
});

test("the page names nothing root-absolute: every asset, API path and import is relative to its own URL, so it works under a proxy's prefix", () => {
  // a reverse proxy may serve the page at https://example.com/tools/mason/: "/api/state" would go to the proxy's root
  const rootAbsolute = /["'`]\/(?![/*>])|url\(\s*["']?\/(?!\/)|\b(?:href|src|action|formaction)\s*=\s*\/(?!\/)/g;
  const found: string[] = [];
  for (const f of webFiles()) {
    if (f.startsWith(`vendor${path.sep}`) || !/\.(?:html|css|js)$/.test(f)) continue;
    const code = fs.readFileSync(path.join(WEB, f), "utf8").replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const m of code.matchAll(rootAbsolute)) found.push(`${f}: ${code.slice(m.index, m.index + 40).split("\n")[0]}`);
  }
  assert.deepEqual(found, [], "a path the page asks for is relative (api/state, app.js), never /api/state or /app.js");
  // the detector bites: each shape a root-absolute path is written in
  for (const bad of [`fetch("/api/state")`, "ask(`/api/users/${n}`)", `<link href="/app.css">`, `<script src='/app.js'>`, `url(/vendor/x.woff2)`, `<a href=/x>`]) {
    assert.ok(new RegExp(rootAbsolute.source).test(bad), bad);
  }
  for (const ok of [`fetch("api/state")`, `<link href="app.css">`, `"<svg/>"`, `<path d="M3 3z"/>`, `x.split("//")`]) assert.ok(!new RegExp(rootAbsolute.source).test(ok), ok);
});

test("every placeholder on the page starts with 'e.g. ': an example is never read as a value already filled in (issue 863)", () => {
  // an attribute written in the HTML or by a module, or a property a script sets
  const placeholder = /\bplaceholder\s*[=:]\s*(["'`])([\s\S]*?)\1/g;
  const found: string[] = [];
  for (const f of webFiles()) {
    if (f.startsWith(`vendor${path.sep}`) || !/\.(?:html|js)$/.test(f)) continue;
    const code = fs.readFileSync(path.join(WEB, f), "utf8").replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const m of code.matchAll(placeholder)) found.push(`${f}: ${m[2]!}`);
  }
  assert.ok(found.length >= 5, `the page's placeholders are found (${found.length})`);
  assert.deepEqual(found.filter((p) => !/^[^:]+: e\.g\. \S/.test(p)), [], "each placeholder says it is an example");
});

/** Wait until `cond` holds, checked every 5 ms, failing by name after `ms`: a wait on the condition, never on a delay a
 *  busy machine outruns. */
async function until(cond: () => boolean, what = "the condition", ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`${what}: not met in ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The page in a fake browser: elements whose innerHTML reads back as a browser serialises it (a bare data-x attribute
 *  as data-x="", an apostrophe in text as itself), the listeners `start` adds, the interval it sets, and a FormData
 *  that reads a form's ticked boxes from the fake form. */
function fakeBrowser(run: ReturnType<typeof fakeRun>, hash = "", winExtra: Record<string, unknown> = {}) {
  // an element's attributes, and what holds the focus: a target `{ in: "sidebar" }` is inside the element of that id
  interface FakeEl { id: string; writes: number; html: string; hidden?: boolean; innerHTML: string; attrs: Map<string, string>; addEventListener: () => void;
    setAttribute(k: string, v: string): void; removeAttribute(k: string): void; contains(t: { in?: string } | null): boolean; focus(): void; querySelector(sel: string): FakeEl }
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => els.get(id) ?? (els.set(id, { id, writes: 0, html: "", attrs: new Map(), addEventListener: () => undefined,
    get innerHTML() { return this.html.replace(/ (data-[a-z-]+)(?=[ >])/g, ' $1=""').replace(/&#39;/g, "'"); },
    set innerHTML(v: string) { this.html = v; this.writes++; },
    setAttribute(k: string, v: string) { this.attrs.set(k, v); }, removeAttribute(k: string) { this.attrs.delete(k); },
    contains(t: { in?: string } | null) { return t?.in === this.id; }, focus() { doc.focused = this.id; },
    querySelector(sel: string) { return el(`${this.id} ${sel}`); } }), els.get(id)!);
  const on = new Map<string, (e: unknown) => Promise<void> | void>();
  const doc = { visibilityState: "visible", focused: "", getElementById: el, addEventListener: (type: string, f: (e: unknown) => void) => { on.set(type, f); } };
  const onWin = new Map<string, () => void>();
  // what the page replaced the address with (a replaced view's URL, or a hash of its own, which the browser then says)
  const replaced: string[] = [];
  // A URL that is this page under another hash (`#tables`, or `/#tables` with the page served at the host's root) stays
  // in the document and says a hashchange, as a browser does; past 20 the fake stops answering, so a page that would
  // leave for ever fails its test instead of hanging it
  const location = { hash, replace(u: string) {
    replaced.push(u);
    const at = /^\/?#/.exec(u);
    if (at !== null && replaced.length <= 20) { location.hash = u.slice(at[0].length - 1); setTimeout(() => onWin.get("hashchange")!(), 0); }
  } };
  let tick: (() => void) | null = null;
  class FormData { readonly ticked: Record<string, string[]>; constructor(form: { ticked: Record<string, string[]> }) { this.ticked = form.ticked; } getAll(name: string) { return this.ticked[name] ?? []; } }
  fn<[unknown, unknown], void>("start")(doc, { fetch: (p: string, i?: { method?: string; body?: string }) => run.fetch(p, i), FormData, location, addEventListener: (type: string, f: () => void) => { onWin.set(type, f); },
    setInterval: (f: () => void) => { tick = f; return 1; }, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), ...winExtra });
  /** the reader follows a link of the nav: the hash changes, and the browser says so */
  const go = (to: string) => { location.hash = to; onWin.get("hashchange")!(); };
  return { el, on, doc, go, replaced, tick: () => tick!(), settle: () => new Promise((r) => setTimeout(r, 20)) };
}

test("the Users page reads Connect, then the add form and what it answered, then the users (issue 887)", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const section = /<section id="page-users"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? assert.fail("the Users section");
  const order = [...section.matchAll(/<div id="([a-z-]+)"><\/div>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["users-connect", "add-user-box", "action", "added", "users"],
    "Connect first; the card an add answered (added) and its refusal (action) beside the form; the list last");
  assert.ok(section.indexOf('id="users-h"') < section.indexOf('id="users-connect"'), "under the title");
});

test("arriving on the Users page puts the cursor in the add form's Name — at the start and by a link followed; never at a poll's write, nor from what the person focused since, nor on a touch screen or read-only (issue 887)", async () => {
  const focusedAfter = async (o: { hash?: string; to?: string; coarse?: boolean; state?: unknown; focusMeanwhile?: boolean } = {}) => {
    const run = fakeRun();
    if (o.state !== undefined) run.answers.set("GET api/state", () => new Response(JSON.stringify(o.state), { status: 200 }));
    // the state held until released: the form, and so the Name, is written only once it is read
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const answer = run.answers.get("GET api/state")!;
    run.answers.set("GET api/state", (async () => { await held; return answer(); }) as unknown as () => Response);
    const { doc, go, tick, settle } = fakeBrowser(run, o.hash ?? "#users",
      o.coarse ? { matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)", addEventListener: () => undefined }) } : {});
    const d = doc as unknown as { focused: string; activeElement?: unknown };
    if (o.to !== undefined) { release(); await settle(); assert.equal(d.focused, "", "not on the page it started on"); go(o.to); }
    if (o.focusMeanwhile) d.activeElement = { tagName: "INPUT", in: "elsewhere", dataset: {} };
    release();
    await settle();
    const first = d.focused;
    // a poll's write after that: the focus left where it is
    d.focused = "";
    tick(); await settle();
    return { first, later: d.focused };
  };
  assert.deepEqual(await focusedAfter(), { first: "user-name", later: "" }, "opened at #users: the Name, once the form is written; a poll's write takes nothing");
  assert.deepEqual(await focusedAfter({ hash: "#overview", to: "#users" }), { first: "user-name", later: "" }, "a link followed to it: the same");
  assert.deepEqual(await focusedAfter({ focusMeanwhile: true }), { first: "", later: "" }, "the person focused something before the form was written: theirs");
  assert.deepEqual(await focusedAfter({ coarse: true }), { first: "", later: "" }, "a touch screen: no keyboard opened over the page");
  assert.deepEqual(await focusedAfter({ state: { ...COPYING, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" } }), { first: "", later: "" },
    "read-only: no form, nothing focused");
  // another page arrived on: nothing of the Users page's
  assert.deepEqual(await focusedAfter({ hash: "#tables" }), { first: "", later: "" });
});

test("in the browser: the phone's menu — its button opens the nav as a sheet, focus on its first link; Escape, a click outside, the focus leaving or a link followed close it", async () => {
  const run = fakeRun();
  const { el, on, doc, go, settle } = fakeBrowser(run, "#users");
  await settle();
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.match(html, /<button type="button" id="menu-button" class="menu-button" data-menu aria-controls="side-body" aria-expanded="false"><span id="menu-icon"><\/span><span class="sr">Menu<\/span><\/button>/,
    "a button, its name Menu, saying what it opens and whether it is open");
  assert.match(el("menu-icon").html, /^<span class="icon when-closed" aria-hidden="true"><svg\s+class="lucide lucide-menu".*<\/svg><\/span><span class="icon when-open" aria-hidden="true"><svg\s+class="lucide lucide-x".*<\/svg><\/span>$/s,
    "its icons, the stylesheet showing the one aria-expanded says");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.menu-button\[aria-expanded="true"\] \.when-closed, \.menu-button\[aria-expanded="false"\] \.when-open \{ display: none; \}/);
  const open = () => el("sidebar").attrs.has("data-open");
  const expanded = () => el("menu-button").attrs.get("aria-expanded");
  const press = (key: string) => on.get("keydown")!({ key, preventDefault: () => undefined });
  const click = (target: unknown) => on.get("click")!({ target });
  const menuButton = { in: "sidebar", closest: () => ({ dataset: { menu: "" } }) };
  // closed, Escape does nothing
  press("Escape");
  // arriving on the Users page: the cursor in its Name (issue 887); the menu's own focus below
  assert.equal(open(), false); assert.equal(doc.focused, "user-name");
  await click(menuButton);
  assert.deepEqual([open(), expanded(), doc.focused], [true, "true", "nav a"], "open: the sheet, the button says so, the focus on the nav's first link");
  await click({ in: "sidebar", closest: () => null });
  assert.equal(open(), true, "a click inside the sheet leaves it open");
  press("Escape");
  assert.deepEqual([open(), expanded(), doc.focused], [false, "false", "menu-button"], "Escape closes it, the focus back on its button");
  await click(menuButton);
  await click(menuButton);
  assert.deepEqual([open(), expanded()], [false, "false"], "the button again closes it");
  // a click outside closes it, and is no click of the page under the scrim
  await click(menuButton);
  run.asked.length = 0;
  await click({ closest: () => ({ dataset: { remove: "metabase" } }) });
  assert.deepEqual([open(), expanded(), doc.focused], [false, "false", "menu-button"], "a click outside closes it");
  assert.doesNotMatch(textOf(el("users").html), /Remove metabase\?/, "the click outside reached no button of the page");
  // the focus leaving the sheet (Tab past its last link) closes it, the focus left where it went
  await click(menuButton);
  doc.focused = "elsewhere";
  on.get("focusin")!({ target: { in: "sidebar" } });
  assert.equal(open(), true, "the focus moving inside it keeps it open");
  on.get("focusin")!({ target: { in: "main" } });
  assert.deepEqual([open(), doc.focused], [false, "elsewhere"]);
  // a link followed closes it
  await click(menuButton);
  go("#tables"); await settle();
  assert.deepEqual([open(), expanded()], [false, "false"], "a link followed: the sheet closes on the page it shows");
});

test("in the browser: each part is written when what it shows changes, never at every poll (a click must find its button)", async () => {
  const run = fakeRun();
  const { el, on, doc, go, tick, settle } = fakeBrowser(run);
  await settle();
  assert.match(textOf(el("status").html), /public\.orders 15% syncing/);
  go("#users"); await settle();
  // Remove clicked: the user's row holds the confirm, whose Cancel is a bare data- attribute
  await on.get("click")!({ target: { closest: () => ({ dataset: { remove: "metabase" } }) } });
  const users = el("users");
  assert.match(textOf(users.html), /Remove metabase\? It connects no more/);
  const [usersWrites, statusWrites] = [users.writes, el("status").writes];
  tick(); await settle();
  tick(); await settle();
  assert.equal(users.writes, usersWrites, "the users, unchanged, are not written again: the confirm's button stays the one clicked");
  assert.equal(el("status").writes, statusWrites, "the status, unchanged, is not written again");
  // a hidden tab asks nothing
  doc.visibilityState = "hidden";
  run.asked.length = 0;
  tick(); await settle();
  assert.deepEqual(run.asked, [], "no poll while the tab is hidden");
});

test("in the browser: the tables are written when they change, never at every poll — a Remove's confirm and a form's ticks stay", async () => {
  const run = fakeRun();
  const { el, on, tick, settle } = fakeBrowser(run, "#tables");
  await settle();
  const tables = el("tables");
  assert.match(textOf(tables.html), /public\.orders Syncing 15% 280,000 key id — View events Sync now Remove Sync… syncing /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { removeTable: "public.orders" } }) } });
  assert.match(textOf(tables.html), /Remove orders\? Mason stops syncing it and drops its synced data\. Remove orders Cancel/);
  let writes = tables.writes;
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "the tables, unchanged while a copy moves, are not written again: the confirm stays the one clicked");
  // the run reads the catalog again every few seconds, and a live database's row estimates move (pg_class.reltuples)
  const rowsOf = (audit: number) => answer({ ...COPYING, tables: COPYING.tables.map((t) => t.table === "public.audit" ? { ...t, rows: audit } : t) });
  run.answers.set("GET api/state", rowsOf(350));
  tick(); await settle();
  assert.equal(tables.writes, writes, "rows that moved while a Remove asks do not write the tables again: the confirm stays the one clicked");
  assert.match(textOf(tables.html), /public\.orders Syncing 15% 280,000 key id — View events Sync now Remove Sync… syncing .* public\.audit Not added ~50 rows key id Add Columns… /);
  assert.match(textOf(popOf(tables.html, "act-tables-public.orders")), /^Remove orders\? /, "the confirm, beside the row it asks about");
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelRemoveTable: "" } }) } });
  assert.match(textOf(tables.html), /public\.audit Not added ~350 rows key id/, "Cancel writes the rows as they are now");
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  assert.match(tables.html, /data-pick-form="public\.audit"/);
  writes = tables.writes;
  tick(); await settle();
  assert.equal(tables.writes, writes, "the form is not written again under the reader's ticks");
  run.answers.set("GET api/state", rowsOf(700));
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "nor when the rows moved: the ticks stay");
  assert.match(textOf(tables.html), /public\.audit Not added ~350 rows /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelChoose: "" } }) } });
  run.answers.set("GET api/state", rowsOf(1000));
  writes = tables.writes;
  tick(); await settle();
  assert.ok(tables.writes > writes, "the form cancelled, the next poll writes the tables again");
  assert.match(textOf(tables.html), /public\.audit Not added ~1,000 rows /);
  run.answers.set("GET api/state", answer(COPYING));
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  // the form submitted: the ticked boxes, as FormData reads them, sent as the columns
  run.answers.set("POST api/pick", answer({ ...PICKED.columns, state: COPYING }));
  let prevented = false;
  await on.get("submit")!({ target: { dataset: { pickForm: "public.audit" }, ticked: { columns: ["name"] } }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the page posts it, not the browser");
  assert.ok(run.asked.includes(`POST api/pick ${JSON.stringify({ table: "public.audit", picked: true, columns: ["name"] })}`), run.asked.join("\n"));
  assert.match(textOf(tables.html), /Added public\.audit to mason\/sources\/shop\.yml: id, name sync: poll 30s \(its entry's\): .* key added: id/, "the sources file from the project's root, as mason add names it");
  assert.doesNotMatch(tables.html, /\/app\//, "never an absolute path");
});

// ------------------------------------------------------------------ the shell: a page per hash, each polling its own

test("the shell: a sidebar nav — Overview · Tables · Users, the Observability group's Queries · Usage · Sync events — each page a module with a section and a route; every old hash lands on its view", async () => {
  const parseHash = fn<[string | undefined], { id: string; params: Record<string, string> }>("parseHash");
  const hashes = ["#overview", "#tables", "#users", "#observability/queries", "#observability/usage", "#observability/syncs", "#observability",
    // the hashes of before the Observability tab, and of before Logs was Sync events: bookmarks keep working
    "#status", "#queries", "#usage", "#logs", "#syncs", "#observability/logs",
    // none, one unknown, one with parameters
    "", undefined, "#", "#nope", "#Tables", "#tables?show=failed", "#observability/usage?range=7d", "#observability/nope"];
  assert.deepEqual(hashes.map((h) => parseHash(h).id), ["status", "tables", "users", "queries", "usage", "syncs", "queries", "status", "queries", "usage", "syncs", "syncs", "syncs",
    "status", "status", "status", "status", "status", "tables", "usage", "status"]);
  assert.deepEqual(parseHash("#observability/logs?range=1h&failures=1"), { id: "syncs", params: { range: "1h", failures: "1" } });
  assert.deepEqual(parseHash("#observability/syncs?table=public.orders"), { id: "syncs", params: { table: "public.orders" } });
  const hashOf = fn<[string, Record<string, string>?], string>("hashOf");
  assert.deepEqual([hashOf("status"), hashOf("queries"), hashOf("queries", { range: "now" }), hashOf("queries", { range: "24h" }), hashOf("usage", { range: "7d" }), hashOf("tables", { show: "failed" })],
    ["#overview", "#observability/queries", "#observability/queries", "#observability/queries?range=24h", "#observability/usage?range=7d", "#tables?show=failed"], "the default range, Now, is left out of the address");
  const pages = (page as unknown as { PAGES?: Array<{ id: string; title: string; hash?: string; parent?: string; create: unknown }> }).PAGES;
  assert.ok(Array.isArray(pages), "src/web/app.js exports PAGES");
  assert.deepEqual(pages!.map((p) => [p.id, p.title, p.hash ?? p.id, p.parent ?? ""]), [["status", "Overview", "overview", ""], ["tables", "Tables", "tables", ""], ["users", "Users", "users", ""],
    ["queries", "Queries", "observability/queries", "observability"], ["usage", "Usage", "observability/usage", "observability"], ["syncs", "Sync events", "observability/syncs", "observability"],
    // a host's view (MASON_UI_NAV_LINKS' views): its section and its route, but no link of Mason's own nav (`nav: false`)
    ["host", "Host view", "host", ""]]);
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts") as { PAGE_ROUTES: Record<string, readonly [string, string]> };
  for (const p of pages!) {
    assert.match(html, new RegExp(`<section id="page-${p.id}" aria-labelledby="${p.id}-h"`), `index.html has ${p.id}'s section`);
    assert.deepEqual(PAGE_ROUTES[`/pages/${p.id}.js`], [`pages/${p.id}.js`, "text/javascript; charset=utf-8"], `${p.id}'s module is a route`);
    const mod = await import(path.join(WEB, "pages", `${p.id}.js`)) as { page: { id: string } };
    assert.equal(mod.page.id, p.id);
  }
  // the sidebar's nav: every page a link with its icon and its label, the one shown the current page; the
  // Observability views under the group's heading, each keeping the range they share
  const renderNav = fn<[string, string?], string>("renderNav");
  const links = (nav: string) => [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>(.*?)<\/a>/gs)].map((m) => [textOf(m[3]!), m[1], Boolean(m[2])]);
  assert.deepEqual(links(renderNav("tables")), [["Overview", "#overview", false], ["Tables", "#tables", true], ["Users", "#users", false],
    ["Queries", "#observability/queries", false], ["Usage", "#observability/usage", false], ["Sync events", "#observability/syncs", false]]);
  assert.deepEqual(links(renderNav("syncs", "7d")).slice(3), [["Queries", "#observability/queries?range=7d", false], ["Usage", "#observability/usage?range=7d", false],
    ["Sync events", "#observability/syncs?range=7d", true]], "a view shown is the current page, and its siblings' links keep the range");
  assert.equal([...renderNav("usage").matchAll(/aria-current/g)].length, 1, "one current page, never its group too");
  assert.equal(textOf(renderNav("status")), "Overview Tables Users Observability Queries Usage Sync events");
  assert.match(renderNav("status"), /<li class="group"><p class="group-title" id="nav-observability">Observability<\/p><ul aria-labelledby="nav-observability"><li><a href="#observability\/queries">/,
    "the group is a heading over its links' list, which it names");
  // every link carries its icon inline: an SVG in currentColor, hidden from a reader (the label is the link's name)
  const icons = { "#overview": "layout-dashboard", "#tables": "table", "#users": "users", "#observability/queries": "square-terminal", "#observability/usage": "chart-column", "#observability/syncs": "logs" };
  for (const m of renderNav("status").matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/gs)) {
    assert.match(m[2]!, new RegExp(`^<span class="icon" aria-hidden="true"><svg\\s+class="lucide lucide-${icons[m[1] as keyof typeof icons]}"[^>]*stroke="currentColor"[^>]*>.*</svg></span><span class="label">[\\w ]+</span>$`, "s"), `${m[1]}: its icon inline, then its label`);
  }
  // the links work before the script runs (which adds their icons): the same links, in the same order, under the same heading
  const staticNav = html.match(/<nav id="nav" class="nav" aria-label="Pages">(.*?)<\/nav>/s)?.[1] ?? assert.fail("index.html has the nav");
  assert.deepEqual(links(staticNav), links(renderNav("none")), "index.html's nav is the nav the script writes, but its icons");
  assert.equal(staticNav, renderNav("none").replace(/<span class="icon" aria-hidden="true">.*?<\/svg><\/span>/gs, ""), "the same markup, so nothing moves when it is written");
  // the head of an Observability view is ONE row: its title left, the range right as a segmented control (the group's
  // name is the sidebar's heading, never a line of its own above the title)
  const renderSubnav = fn<[string, string?, number?, Date?], string>("renderSubnav");
  assert.equal(renderSubnav("tables"), "", "a page of its own has none");
  // Now first, the default (its link has no range), said Live beside the control
  const live = renderSubnav("usage");
  assert.equal(textOf(live), "Now Last hour 24 hours 7 days Live");
  assert.equal(live, `<div class="range" role="group" aria-label="Time range"><a href="#observability/usage" aria-current="true" title="follows what happens: read every few seconds">Now</a><a href="#observability/usage?range=1h">Last hour</a>` +
    `<a href="#observability/usage?range=24h">24 hours</a><a href="#observability/usage?range=7d">7 days</a></div><span class="live" title="read every few seconds"><span class="live-dot" aria-hidden="true"></span>Live</span>`);
  assert.ok(!/data-refresh-range|as of/.test(live), "Now follows what happens: nothing to refresh");
  // any other range is read once: when it was read beside it (once it was), and Refresh, which reads it again
  const sub = renderSubnav("usage", "1h");
  assert.equal(textOf(sub), "Now Last hour 24 hours 7 days Refresh", "not read yet: no time");
  assert.equal(sub, `<div class="range" role="group" aria-label="Time range"><a href="#observability/usage" title="follows what happens: read every few seconds">Now</a><a href="#observability/usage?range=1h" aria-current="true">Last hour</a>` +
    `<a href="#observability/usage?range=24h">24 hours</a><a href="#observability/usage?range=7d">7 days</a></div><span class="as-of"><button type="button" class="small" data-refresh-range>Refresh</button></span>`);
  const read = renderSubnav("usage", "24h", 7, new Date("2026-10-27T09:05:30.400Z"));
  assert.match(textOf(read), /^Now Last hour 24 hours 7 days 30 days .* as of 09:05:30 UTC Refresh$/);
  assert.match(read, /<span class="as-of"><span class="dim" title="read once when chosen; Now follows what happens">as of 09:05:30 UTC<\/span> <button type="button" class="small" data-refresh-range>Refresh<\/button><\/span>$/);
  assert.ok(!/class="live"/.test(read), "a past range is never said Live");
  for (const id of ["queries", "usage", "syncs"]) {
    assert.match(html, new RegExp(`<div class="page-head"><div class="head-row"><h2 id="${id}-h">[\\w ]+</h2><div id="range-${id}" class="head-range"></div></div>`), `${id}: its title and its range in one row`);
  }
  assert.ok(!html.includes('id="subnav"'), "no head above the view's title");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.nav a\[aria-current="page"\] \{[^}]*background: var\(--current\);[^}]*box-shadow: inset 3px 0 0 var\(--accent\)/, "the page shown is the nav's pale stone row, the accent at its edge");
  assert.match(css, /\.range a\[aria-current="true"\]/, "the range chosen is the raised segment");
  const app = fn<[unknown], App>("createApp")(fakeRun().fetch);
  assert.match(textOf(app.view()["usage-hourly"]!), /Asking Mason/);
  assert.match(textOf(app.view()["syncs-events"]!), /Asking Mason/);
});

test("the shell: only the page shown is asked, each endpoint at its own rate — the state every poll, the slower ones when due", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), STATUS_FIRST, "the Overview, first: everything it reads");
  t += 2000;
  assert.deepEqual(await asked(), ["GET api/state"], "2 s on: the state alone; the request log's are read every 30 s");
  t += 28_000;
  assert.deepEqual(await asked(), STATUS_READS, "30 s on: the request log's again");
  app.show("tables");
  assert.deepEqual(await asked(), ["GET api/state", "GET api/usage?since=1m"], "Tables: its own reads");
  t += 2000;
  assert.deepEqual(await asked(), ["GET api/state"], "the synced tables' sizes once a minute: they are measured every 10 min");
  app.show("users");
  assert.deepEqual(await asked(), ["GET api/users?lastUsed=1", "GET api/state"], "a page shown is read at once, the shell's state with it");
  // Queries at Now, the default: the newest requests of the last 15 minutes, every 5 s (the state, how to connect, every 30 s)
  app.show("queries");
  assert.deepEqual(await asked(), ["GET api/requests?since=15m", "GET api/state"], "Queries: the request log alone, of the range");
  t += 2000;
  assert.deepEqual(await asked(), [], "2 s on: nothing is due");
  t += 4000;
  assert.deepEqual(await asked(), ["GET api/requests?since=15m"], "Now is live: the request log again every 5 s");
  // a past range is read ONCE, when chosen: never again by time, however long it is shown
  app.show("observability/queries?range=1h");
  assert.deepEqual(await asked(), ["GET api/requests?since=1h", "GET api/state"], "the last hour, read when it is chosen");
  for (let i = 0; i < 3; i++) { t += 60_000; assert.deepEqual(await asked(), ["GET api/state"], "a minute on: the range is not read again; the state at its own rate"); }
  // read again only when the view is shown again (a range chosen, a link followed) or Refresh marks it stale
  (app as unknown as { markStale(): void }).markStale();
  assert.deepEqual(await asked(), ["GET api/requests?since=1h", "GET api/state"], "Refresh: everything shown read again");
  t += 10_000;
  assert.deepEqual(await asked(), [], "and once again only");
  app.show("observability/queries?range=1h");
  assert.deepEqual(await asked(), ["GET api/requests?since=1h", "GET api/state"], "shown again: read again");
  // the page's own read failing is the banner; a slower one failing is said where it is shown, never as the banner
  app.show("status");
  run.answers.set("GET api/queries", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  t += 30_000;
  await app.poll();
  assert.equal(app.view().poll, "");
  assert.match(textOf(app.view().status!), /Queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
});

test("in the browser: the hash chooses the section shown and the page asked; a link followed asks the new page at once; a range or an old hash too", async () => {
  const run = fakeRun();
  run.answers.set("GET api/usage?since=24h&step=3600", answer(USAGE));
  const { el, on, go, settle, tick } = fakeBrowser(run, "#nope");
  await settle();
  const shown = () => ["status", "tables", "queries", "users", "usage", "syncs"].filter((id) => (el(`page-${id}`) as unknown as { hidden: boolean }).hidden === false);
  assert.deepEqual(shown(), ["status"], "an unknown hash shows the Overview");
  const current = () => [...el("nav").html.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
  assert.deepEqual(current(), ["#overview"]);
  assert.equal(el("range-usage").html, "");
  run.asked.length = 0;
  go("#users"); await settle();
  assert.deepEqual(shown(), ["users"]);
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state"], "the users at once, not at the next tick (and the state the sidebar names the project from)");
  assert.deepEqual(current(), ["#users"]);
  run.asked.length = 0;
  tick(); await settle();
  assert.deepEqual(run.asked, [], "the users are read every 30 s, not at every tick");
  // an old bookmark: #usage is Observability › Usage, at the default range, Now
  run.answers.set("GET api/usage?since=15m&step=60", answer(USAGE));
  run.asked.length = 0;
  go("#usage"); await settle();
  assert.deepEqual(shown(), ["usage"]);
  assert.deepEqual(current(), ["#observability/usage"], "an old hash: the view it was is the current page of the nav");
  assert.match(el("range-usage").html, /<a href="#observability\/usage" aria-current="true"[^>]*>Now<\/a>/);
  assert.match(el("range-usage").html, /Live<\/span>$/);
  assert.deepEqual((run.asked as string[]).filter((a) => a.includes("api/usage")), ["GET api/usage?since=15m&step=60"], "Now: the last 15 minutes, a minute a point");
  // the range followed: the same view, its samples of the week, six hours a point
  run.answers.set("GET api/usage?since=7d&step=21600", run.answers.get("GET api/usage?since=24h&step=3600")!);
  run.asked.length = 0;
  go("#observability/usage?range=7d"); await settle();
  assert.deepEqual((run.asked as string[]).filter((a) => a.includes("api/usage")), ["GET api/usage?since=7d&step=21600"]);
  assert.match(el("range-usage").html, /<a href="#observability\/usage\?range=7d" aria-current="true">7 days<\/a>/);
  assert.deepEqual(current(), ["#observability/usage?range=7d"], "the nav's links keep the range");
  assert.match(el("range-usage").html, /as of \d\d:\d\d:\d\d UTC<\/span> <button type="button" class="small" data-refresh-range>Refresh<\/button><\/span>$/, "a past range: when it was read, and Refresh");
  run.asked.length = 0;
  tick(); await settle();
  assert.ok(!(run.asked as string[]).some((x) => x.includes("api/usage") || x.includes("api/activity")), "a past range is not read again by the clock");
  await on.get("click")!({ target: { closest: () => ({ dataset: { refreshRange: "" } }) } });
  assert.deepEqual((run.asked as string[]).filter((x) => x.includes("api/usage") || x.includes("api/activity")), ["GET api/activity?since=7d", "GET api/usage?since=7d&step=21600"], "Refresh: read again at once");
  // the sub-tab beside it keeps the range: Sync events reads the week's events (an old #observability/logs lands there)
  run.answers.set("GET api/events?limit=500&since=7d", answer(EVENTS));
  run.asked.length = 0;
  go("#observability/logs?range=7d"); await settle();
  assert.deepEqual(shown(), ["syncs"]);
  assert.deepEqual(run.asked, ["GET api/events?limit=500&since=7d", "GET api/state"]);
});

test("in the browser: no part is written while a pointer is pressed — a row that moves every poll keeps the button under the press", async () => {
  const run = fakeRun();
  const { el, on, settle, tick } = fakeBrowser(run);
  await settle();
  const status = el("status");
  const writes = status.writes;
  await on.get("pointerdown")!({});
  run.answers.set("GET api/state", answer(RUNNING));
  tick(); await settle();
  assert.equal(status.writes, writes, "pressed: the new state waits");
  assert.match(textOf(status.html), /public\.orders 15% syncing/);
  // released: written (the shell writes once the release has been handled)
  await on.get("pointerup")!({});
  await settle();
  assert.ok(status.writes > writes);
  assert.match(status.html, HEALTH("ok", "Ready"));
});

test("in the browser: a press whose release never comes holds the writes for PRESS_HOLD_MS at most, never for good", async () => {
  const hold = (await import(path.join(WEB, "app.js") as string) as { PRESS_HOLD_MS?: number }).PRESS_HOLD_MS;
  assert.equal(typeof hold, "number", "src/web/app.js exports PRESS_HOLD_MS");
  const run = fakeRun();
  const { el, on, settle, tick } = fakeBrowser(run);
  await settle();
  const status = el("status");
  const realNow = Date.now;
  try {
    let clock = realNow();
    Date.now = () => clock;
    await on.get("pointerdown")!({});
    run.answers.set("GET api/state", answer(RUNNING));
    tick(); await settle();
    assert.match(textOf(status.html), /public\.orders 15% syncing/, "pressed: the new state waits");
    // the release is never seen (released outside the window): past the hold, the page is written again
    clock += hold! + 1;
    tick(); await settle();
    assert.match(status.html, HEALTH("ok", "Ready"));
  } finally { Date.now = realNow; }
});

// ------------------------------------------------------------------ the Overview: the word, the facts, the recent errors

// the pages' own modules, imported when the tests run (at a commit without them each test fails by name)
const statusPage = await import(path.join(WEB, "pages", "status.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const tablesPage = await import(path.join(WEB, "pages", "tables.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const of = <A extends unknown[], R>(mod: Record<string, unknown>, file: string, name: string): Fn<A, R> => {
  assert.equal(typeof mod[name], "function", `src/web/pages/${file} exports ${name}`);
  return mod[name] as Fn<A, R>;
};
const plain = (line: string) => line.replace(/\s+/g, " ").trim();

test("the Overview's words are mason status's: the readiness word, the copies' line, a size, a span, an event's and a statement's line", () => {
  const readinessWord = (commands as unknown as { readinessWord?: (r: unknown) => string }).readinessWord;
  assert.equal(typeof readinessWord, "function", "src/cli/commands.ts exports readinessWord");
  const word = of<[unknown], string>(statusPage, "status.js", "readinessWord");
  for (const s of [RUNNING, COPYING, FAILED]) assert.equal(word(s.readiness), readinessWord!(s.readiness), "the word mason status heads its last line with");
  assert.deepEqual([RUNNING, COPYING, FAILED].map((s) => word(s.readiness)), ["Ready", "Under way", "Failed"]);
  const totalsText = of<[unknown, number], string>(statusPage, "status.js", "totalsText");
  for (const s of [RUNNING, SYNCED, NONE]) assert.equal(totalsText(s.totals, NOW), commands.totalsText(s.totals!, NOW));
  const cli = commands as unknown as { bytesText?: (b: number) => string };
  assert.equal(typeof cli.bytesText, "function", "src/cli/commands.ts exports bytesText");
  for (const b of [0, 900, 1024, 5_400_000, 3_221_225_472]) {
    assert.equal(fn<[number], string>("fileSize")(b), commands.fileSize(b), `fileSize(${b})`);
    assert.equal(fn<[number], string>("bytesText")(b), cli.bytesText!(b), `bytesText(${b})`);
  }
  for (const x of [0, 0.42, 9.96, 10, 63, 754, 7500]) assert.equal(fn<[number], string>("spanText")(x), commands.spanText(x), `spanText(${x})`);
  // a line's cells, read in order, are its line (the line pads its columns: spaces aside)
  const eventCells = fn<[unknown], Record<string, string>>("eventCells"), requestCells = of<[unknown], string[]>(statusPage, "status.js", "requestCells");
  for (const e of EVENTS.events as SyncEvent[]) assert.equal(Object.values(eventCells(e)).join(" "), plain(commands.eventLine(e, PLAIN)));
  assert.equal(statusPage.RECENT_ERRORS as unknown, commands.RECENT_ERRORS, "as many recent errors of each kind as mason status shows");
  for (const r of FAILED_REQUESTS.requests as LedgerRequest[]) {
    const cells = requestCells(r);
    assert.equal(plain(cells.slice(0, -1).join(" ") + (cells.at(-1) ? ` — ${cells.at(-1)}` : "")), plain(commands.requestLine(r, PLAIN)));
  }
});

test("the Overview: the word, the facts (tables synced N of M, rows, the last sync and its age, the copy's file), the statements, the recent errors", () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(SYNCED));
  const a = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(NOW));
  return a.poll().then(() => {
    const html = a.view().status!;
    const text = textOf(html);
    assert.match(html, HEALTH("bad", "Failed"), "the word first: mason status's");
    // the cards first: the copies in all, their rows, the last sync, the copy's file, the last day's statements and p95
    assert.match(text, /^Failed Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 30 s ago 2026-10-27 09:05:00 UTC The synced data's file unknown its size could not be read Statements, last day 1,234 1,200 completed, 34 refused, failed or cancelled p95, last day 380 ms average 42 ms · p50 12 ms /);
    assert.match(html, /<a class="card bad link" href="#tables\?show=failed"><p class="card-label">Tables synced<\/p><p class="card-value">2 of 3<\/p><p class="card-sub">added, 1 failed<\/p><\/a>/, "a card: its label, its value, its sub-line — and a link to the failed tables");
    assert.match(text, / Mason Source .* Database postgres:.* Changes each table as its sync: says /);
    assert.match(text, / Source mason\/sources\/shop\.yml \(the tables it names are added\) Database /, "the sources file from the project's root, as mason status names it");
    assert.doesNotMatch(html, /\/app\//, "never an absolute path");
    assert.match(html, /<caption>Mason<\/caption><tbody><tr><th scope="row">Source<\/th>/, "ONE table of the other facts, each a row headed by its name");
    assert.doesNotMatch(html.slice(html.indexOf("<caption>Mason</caption>")), /<th scope="row">(Tables synced|Rows|Last sync|The synced data's file)<\/th>/, "a fact in ONE place: the cards' are not rows too");
    // the statements: a row per window, each count as mason status says it
    assert.match(text, /Statements \(the completed ones' time; mason logs --requests lists each\) Statements Completed Refused Failed Cancelled Average p50 p95 Rows sent Sent /);
    assert.match(text, /Last day 1,234 1,200 30 3 1 42 ms 12 ms 380 ms 98,765 5\.1 MiB Last week 5,000 4,900 90 9 1 40 ms 11 ms 1,250 ms 400,000 900 B /);
    assert.match(text, /The request log keeps 3 days: MASON_HISTORY_DAYS\./);
    const cliQueries = plain(commands.queryLines(QUERIES.queries as never, PLAIN).join(" "));
    for (const v of ["1,234 statements: 1,200 completed, 30 refused, 3 failed, 1 cancelled", "42 ms / 12 ms / 380 ms", "98,765 rows, 5.1 MiB sent", "400,000 rows, 900 B sent"]) assert.ok(cliQueries.includes(v), `mason status says ${v}`);
    // the database is a row of the facts, the bars only for the copies not finished, no count the errors and statements repeat
    assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
    assert.match(text, /Tables not synced yet \(1 of 3 added\) Table Sync public\.orders 100% its first sync failed: poll: connection reset/);
    assert.ok(!/customers 100%|Slow queries|Refused queries|Ready:|Under way:|Failed:/.test(text));
    // the recent errors: each a table, its cells mason status's line
    assert.match(text, /Sync errors \(the latest, newest last; mason logs --events lists each\) See all At \(UTC\) What Table Why 2026-10-27 09:03:10 poll_failed public\.orders poll: connection reset 2026-10-27 09:04:00 restart \(the sync\) the run was started again after it stopped/);
    assert.match(text, /Query errors \(the latest, newest last; mason logs --requests --failed lists each\) See all Started \(UTC\) Outcome Took Rows Who Statement Error 2026-10-27 09:02:00 refused 3 ms Metabase \(user metabase\) SELECT \* FROM nope relation "nope" does not exist /);
    assert.ok(html.includes('title="SQLSTATE 42P01">refused</td>') && !/\b(42P01|57014)\b/.test(text), "the SQLSTATE is a title, never the page's words");
    assert.match(text, /cancelled 12,345 ms 10 rows \(no application_name\) SELECT (x, )+x… canceling statement due to user request/);
    assert.ok(!/duckdb/i.test(html), "never the engine's name");
  });
});

test("the Overview: Ready and Under way in mason status's words; nothing added says so once; an error list that could not be read, or is empty, says so", async () => {
  const renderHealth = of<[unknown], string>(statusPage, "status.js", "renderHealth");
  assert.equal(textOf(renderHealth(RUNNING)), "Ready");
  assert.equal(textOf(renderHealth(COPYING)), "Under way");
  assert.equal(renderHealth(NONE), "", "no table added: renderStatus says it, with what adds one");
  const renderRecentErrors = of<[unknown, unknown], string>(statusPage, "status.js", "renderRecentErrors");
  assert.equal(textOf(renderRecentErrors({ events: [] }, { failure: { code: "failed", message: "the request log cannot be read\nmore" } })),
    "Sync errors None. Query errors Could not read them (the request log cannot be read; mason logs has the detail)");
  assert.equal(renderRecentErrors(undefined, undefined), "", "not read yet: nothing");
  const renderKpis = of<[unknown, unknown], string>(statusPage, "status.js", "renderKpis");
  assert.equal(textOf(renderKpis({ ...NONE, totals: { added: 0, copied: 0, failed: 0, rows: 0, syncedAt: null }, engine: { ...NONE.engine, bytes: 2_097_152 } }, { now: NOW })),
    "The synced data's file 2.0 MiB", "nothing added: no sync to count, the copy's file alone");
  assert.equal(textOf(renderKpis({ ...SYNCED, engine: { ...SYNCED.engine, bytes: 2_097_152 } }, { now: NOW })), "Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 30 s ago 2026-10-27 09:05:00 UTC The synced data's file 2.0 MiB");
  assert.equal(textOf(renderKpis({ ...SYNCED, totals: { ...SYNCED.totals!, syncedAt: null } }, { now: NOW, queries: { failure: { code: "failed", message: "no ledger\nmore" } } })),
    "Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync none yet The synced data's file unknown its size could not be read Statements, last day unknown could not read them: no ledger",
    "a fact not read is unknown, with its reason — never 0");
  assert.match(textOf(of<[unknown], string>(statusPage, "status.js", "renderQueries")({ failure: { code: "failed", message: "no ledger" } })), /^Queries: could not read them \(no ledger; mason logs has the detail\)$/);
  // the app with nothing added: the commands' sentence first — no word, no card — then the facts
  const run = fakeRun();
  run.answers.set("GET api/state", answer(NONE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.match(textOf(app.view().status!), /^Getting started 3 of 4 done .* Add a table .* No table added yet \(4 in the database\)\. .* Mason Source /, "the checklist first: its one action is adding a table");
});

// ------------------------------------------------------------------ the Tables page: each copy's sync, Sync, the search box

test("Tables: each added table's state, rows, last sync and its age, how long it took, its copy's size and error, and Sync", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const html = renderTables(SYNCED, { sizes: USAGE });
  const text = textOf(html);
  assert.match(text, /^Table State Rows Key Last sync Size /);
  assert.match(text, /public\.customers Synced 100% 1,200 key id 30 s ago took 0\.4 s 512\.0 KiB View events Sync now Remove /);
  assert.match(text, /public\.orders Failed 100% ~2,000,000 rows key id 65 min ago took 63 s — View events Sync now Remove Sync… poll: connection reset the whole error poll: connection reset the sync tries it again in 5 s /);
  // a copy served but not kept current: its amber bar, and the words mason status prints after it, under the row
  assert.match(text, /public\.events Synced 100% 30,000,000 key id 2 min ago took 13 min 3\.0 GiB View events Sync now Remove Sync: Off public\.audit /, "a table whose sync is off is synced, its age its Last sync");
  assert.match(text, /public\.audit Not added ~50 rows key id Add Columns… /, "a table not added has no sync, and is in the same table");
  assert.equal([...html.matchAll(/<table /g)].length, 1);
  // the last sync is an age, its UTC time in a title; rows, age, span and size are mono and right-aligned
  assert.match(html, /<td class="num"><span title="2026-10-27 09:05:00 UTC">30 s ago<\/span><span class="took" title="changes checked">took 0\.4 s<\/span><\/td><td class="num">512\.0 KiB<\/td>/);
  assert.match(html, /<td class="num">1,200<\/td>/);
  // a failed copy's error is a red line, its whole error in a details
  assert.match(html, /<span class="err">poll: connection reset<\/span><details data-open="error:public\.orders"><summary>the whole error<\/summary><pre>poll: connection reset\nthe sync tries it again in 5 s<\/pre><\/details>/);
  assert.match(html, /<td class="state"><span class="indicator bad"><span class="dot" aria-hidden="true"><\/span>Failed<\/span><span class="copyline t-failed"><span class="copybar" /, "a failed copy's bar is red (its line's class)");
  assert.match(html, /<button type="button" class="small" data-sync-table="public\.customers" data-room="Syncing…">Sync now<\/button>/);
  assert.match(html, /<th scope="row" class="name"><code class="name" title="public\.customers">public\.customers<\/code><\/th>/, "a name in mono, cut by the stylesheet, its whole the title");
  // the cells are the commands': the age's and the span's functions, the size's
  const ages = SYNCED.tables.filter((t) => t.added).map((t) => `${commands.duration(t.sync!.ageSeconds!)} ago`);
  for (const a of ages) assert.ok(text.includes(a), a);
  assert.ok(text.includes(commands.fileSize(3_221_225_472)) && text.includes(commands.spanText(0.42)));
  // a sync under a tenth of a second is not worth a digit; one over keeps the commands' span
  const tookText = of<[unknown], string>(tablesPage, "tables.js", "tookText");
  const syncs = [{ syncSeconds: 0.04, syncedBy: "poll" }, { syncSeconds: 0.1, syncedBy: "poll" }, { syncSeconds: 63, syncedBy: "copy" }, { syncSeconds: 2, syncedBy: "catch-up" }, { syncSeconds: 1, syncedBy: "stream" }];
  assert.deepEqual(syncs.map(tookText), ["<0.1 s", "0.1 s", "63 s", "2.0 s", "1.0 s"]);
  const tookTitle = of<[unknown], string>(tablesPage, "tables.js", "tookTitle");
  assert.deepEqual(syncs.map(tookTitle), ["changes checked", "changes checked", "read whole", "changes checked", "streamed"], "what synced a copy, in plain words, the cell's title");
  // the states, as the run decides them: copying is Syncing, a table not reached Waiting
  assert.match(textOf(renderTables(COPYING, { sizes: USAGE })), /public\.orders Syncing 15% 280,000 .* public\.events Waiting /);
  // the sizes could not be read: said once, the rest shown
  assert.match(textOf(renderTables(SYNCED, { sizes: { failure: { code: "failed", message: "the samples cannot be read" } } })), /The synced tables' own sizes: could not read them \(the samples cannot be read; mason usage has them\)/);
  assert.ok(!/own size is measured/.test(textOf(renderTables(NONE, { sizes: USAGE }))), "nothing added: no copies to measure");
  // a sync asked: its button says so, no second one
  assert.match(renderTables(SYNCED, { sizes: USAGE, syncing: ["public.customers"] }), /<button type="button" class="small" data-room="Syncing…" disabled>Syncing…<\/button>/);
});

test("Tables: Sync now is written disabled, its title why, while the state says mason sync of the table is refused — syncing, waiting, failed, read again — and enabled for a synced one, in the same room (issue 812)", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  // the reasons as the sync's state carries them (src/duck/sync.ts syncRefusal; tests/duck-sync-added.test.ts holds each
  // to pollNow's refusal), through the server's runState
  const why = {
    orders: "public.orders is not synced yet (its first sync has not finished): mason wait waits for it",
    events: "public.events is not synced yet (its first sync has not finished): mason wait waits for it",
    failed: "public.orders is not synced yet (its first sync failed: could not read the next chunk): mason wait waits for it",
    again: "public.events is being read again whole (its columns changed): mason wait waits for it",
  };
  const syncing = stateOf([{ ...copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), syncRefusal: null },
    { source: "public.orders", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 280_000, rowsEstimate: 2_000_000, progress, syncRefusal: why.orders },
    { source: "public.events", phase: "waiting", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, syncRefusal: why.events }]);
  const failed = stateOf([{ ...copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), syncRefusal: null },
    { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null, error: "could not read the next chunk", syncRefusal: why.failed },
    { ...copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"), syncRefusal: why.again }]);
  assert.equal(syncing.tables.find((t) => t.table === "public.orders")!.syncRefusal, why.orders, "/api/state carries the sync's reason");
  const actions = (html: string, table: string) => [...html.matchAll(/<td class="act" id="act-tables-([^"]*)">(.*?)<\/td>/gs)].find((m) => m[1] === table)![2]!;
  const disabled = (reason: string) => `<button type="button" class="small" data-room="Syncing…" title="${reason}" disabled>Sync now</button>`;
  const enabled = (table: string) => `<button type="button" class="small" data-sync-table="${table}" data-room="Syncing…">Sync now</button>`;
  for (const [state, table, reason, what] of [[syncing, "public.orders", why.orders, "syncing"], [syncing, "public.events", why.events, "waiting"],
    [failed, "public.orders", why.failed, "failed"], [failed, "public.events", why.again, "read again"]] as const) {
    assert.ok(actions(renderTables(state), table).includes(disabled(reason)), `${what}: Sync now disabled, its title why — ${actions(renderTables(state), table)}`);
  }
  for (const state of [syncing, failed]) assert.ok(actions(renderTables(state), "public.customers").includes(enabled("public.customers")), "a synced table: Sync now offered");
  // a run from before the field: offered, as before
  assert.ok(actions(renderTables(RUNNING), "public.orders").includes(enabled("public.orders")));
  // the same room whichever it says: the row's actions are the same buttons, in the same order
  const shape = (h: string) => h.replace(/ data-sync-table="[^"]*"| title="[^"]*"| disabled/g, "");
  assert.equal(shape(actions(renderTables(syncing), "public.orders")), shape(actions(renderTables(RUNNING), "public.orders")), "nothing moves: one room");
  const cells = (h: string) => [...h.matchAll(/<t[hd][^>]*>/g)].length;
  assert.equal(cells(renderTables(syncing)), cells(renderTables(COPYING)), "no cell added");
});

test("Tables: what a sync did is said as mason sync says it, beside its Sync; a refusal is the server's Failure", async () => {
  const cli = syncCommand as unknown as { syncedReport?: (b: unknown, picked: string[], unsynced: unknown[]) => unknown };
  assert.equal(typeof cli.syncedReport, "function", "src/cli/sync.ts exports syncedReport");
  const syncedReport = of<[unknown, string[], unknown[]], unknown>(tablesPage, "tables.js", "syncedReport");
  const answered = { at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.events", changed: 1234, deleted: 5, rows: 30_001_229, ms: 8_500 }] };
  for (const picked of [["public.events"], ["public.customers"]]) {
    const named = SYNCED.tables.filter((t) => picked.includes(t.table));
    assert.deepEqual(syncedReport(answered, picked, named), cli.syncedReport!(answered, picked, named));
  }
  const run = fakeRun();
  run.answers.set("GET api/state", answer(SYNCED));
  const app = fn<[unknown], App>("createApp")(run.fetch) as App & { syncTable(t: string): Promise<boolean>; dismissSynced(): void };
  app.show("tables");
  await app.poll();
  run.answers.set("POST api/sync", answer(answered));
  run.asked.length = 0;
  assert.equal(await app.syncTable("public.events"), true);
  assert.deepEqual(run.asked, [`POST api/sync ${JSON.stringify({ tables: ["public.events"] })}`, "GET api/state"], "mason sync events; then the state again");
  // the button says it in its own room, and what the sync did is said beside it, as mason sync prints it
  assert.match(textOf(app.view().tables!), /public\.events Synced .* Synced ✓ Remove Sync: Off public\.audit /);
  assert.match(app.view().tables!, /<button type="button" class="small" data-sync-table="public\.events" data-room="Syncing…">Synced ✓<\/button>/);
  assert.equal(textOf(popOf(app.view().tables!, "act-tables-public.events")), "Synced public.events: 1,234 row(s) written, 5 deleted. public.events 1,234 changed, 5 deleted, 30,001,229 rows now · 8.5 s Tip: public.events's sync is off: it stays as of this sync until the next mason sync events Dismiss");
  app.dismissSynced();
  assert.ok(!/Synced public\.events:/.test(app.view().tables!));
  const message = "public.orders has no copy yet: it is synced once it is copied";
  run.answers.set("POST api/sync", answer({ error: message, code: "nothing_yet", failure: { code: "nothing_yet", message, next: [] } }, 409));
  assert.equal(await app.syncTable("public.orders"), false);
  assert.ok(app.view().tables!.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
});

test("Tables: the search box and the state filter narrow the one list, their text kept across polls; a form open keeps its table and its list still", async () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "ORD" })), /^1 with “ORD” in the name Table State Rows Key Last sync Size public\.orders Synced 100% 2,000,000 key id — View events Sync now Remove /);
  assert.equal(renderTables(CATALOG_STATE, { filter: "" }), renderTables(CATALOG_STATE), "nothing typed: every table, as before");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "zzz", choosing: "public.audit", columns: columnsOf("public.audit") })), /^1 with “zzz” in the name .* public\.audit Not added ~50 rows key id Add Columns… Its columns/, "the table whose form is open stays");
  assert.match(textOf(renderTables(SYNCED, { filter: "nope" })), /No table's name has “nope”\./);
  // All / Added / Not added
  const names = (html: string) => [...html.matchAll(/<th scope="row" class="name"><code class="name" title="[^"]*">([^<]*)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "added" })), ["public.customers", "public.orders", "public.events"]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "not-added" })), ["public.audit", "public.accounts", "public.event_log", "public.staging"]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "not-added", filter: "ORD" })), [], "the name and the state both narrow it");
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "not-added", filter: "acc" })), ["public.accounts"]);
  assert.equal(names(renderTables(CATALOG_STATE, { show: "all" })).length, 7);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "added", choosing: "public.audit" })).includes("public.audit"), true, "a form open stays, whatever the filter says");
  const run = fakeRun();
  run.answers.set("GET api/state", answer(SYNCED));
  const { el, on, tick, settle } = fakeBrowser(run, "#tables");
  await settle();
  await on.get("input")!({ target: { id: "tables-filter", value: "cust" } });
  assert.match(textOf(el("tables").html), /public\.customers Synced/);
  assert.ok(!/public\.orders/.test(el("tables").html), "the list is filtered");
  tick(); await settle();
  tick(); await settle();
  assert.ok(!/public\.orders/.test(el("tables").html) && /public\.customers/.test(el("tables").html), "the text is kept across polls");
  await on.get("input")!({ target: { id: "tables-filter", value: "" } });
  await on.get("input")!({ target: { id: "tables-show", value: "not-added" } });
  assert.deepEqual(names(el("tables").html), ["public.audit"], "SYNCED has one table not added");
  await on.get("input")!({ target: { id: "tables-show", value: "bogus" } });
  assert.equal(names(el("tables").html).length, 4, "anything but a filter of the list is All");
  // Sync clicked: its button says Syncing… at once (written before the answer comes), the answer under it once it does
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  run.answers.set("POST api/sync", () => new Response(JSON.stringify({ at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] })));
  const fetchNow = run.fetch;
  run.fetch = async (p, init) => { if (p === "api/sync") await answered; return fetchNow(p, init); };
  const click = on.get("click")!({ target: { closest: () => ({ dataset: { syncTable: "public.customers" } }) } });
  await settle();
  assert.match(el("tables").html, /<button type="button" class="small" data-room="Syncing…" disabled>Syncing…<\/button>/, "said while it runs");
  release();
  await click;
  assert.match(textOf(el("tables").html), /Synced public\.customers: 1 row\(s\) written, 0 deleted\./);
  // frozen: a form open holds the filter it opened over
  await on.get("input")!({ target: { id: "tables-show", value: "all" } });
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  await on.get("input")!({ target: { id: "tables-show", value: "added" } });
  assert.ok(names(el("tables").html).includes("public.audit"), "the list stays as it was opened until the form is done");
});

// ------------------------------------------------------------------ the Queries and Users pages

type QueriesApp = App & {
  askCancelStatement(session: number, statement: number): void; dismissCancelStatement(): void; dismissCancelled(): void; confirmCancelStatement(session: number, statement: number): Promise<boolean>;
  filterRequests(f: Record<string, string>): Promise<void>; olderRequests(): Promise<void>; newestRequests(): Promise<void>;
};
const RUNNING_NOW = [
  { session: 12, statement: 45, user: "metabase", applicationName: "Metabase v0.50", method: "QUERY", startedAt: "2026-10-28T09:04:00.000Z", runningMs: 134_000, rows: 1200,
    query: "SELECT customer_id,\n  sum(total)\nFROM orders\nGROUP BY 1", queryTruncated: false },
  { session: 13, statement: 7, user: "", applicationName: "", method: "EXECUTE", startedAt: "2026-10-28T09:05:50.000Z", runningMs: 1500, rows: 1, query: "SELECT 1 <b>", queryTruncated: false },
];
const REQUESTS = [
  { requestId: "r-old", startedAt: "2026-10-28T09:00:00.000Z", session: 3, applicationName: "psql", tokenName: "", user: "ana", method: "QUERY", outcome: "ok", status: "completed", sqlstate: null, message: null,
    detail: null, hint: null, rows: 1, durationMs: 1234, endedAt: "2026-10-28T09:00:01.234Z", bytesSent: 2048, query: "SELECT count(*) FROM orders", queryTruncated: false },
  { requestId: "r-new", startedAt: "2026-10-28T09:01:00.000Z", session: 4, applicationName: "", tokenName: "", user: "metabase", method: "QUERY", outcome: "cancelled", status: "cancelled", sqlstate: "57014",
    message: "canceling statement due to user request\nmore", detail: null, hint: null, rows: null, durationMs: 90_000, endedAt: "2026-10-28T09:02:30.000Z", bytesSent: null, query: "SELECT pg_sleep(100)", queryTruncated: false },
];
const failedRequest = { ...REQUESTS[1]!, requestId: "r-bad", outcome: "refused", status: "failed", sqlstate: "42P01", message: "relation \"nope\" does not exist", rows: null };

test("running now: a row each in the commands' words — held equal to mason logs --running's line — and Cancel; none is said", () => {
  const renderRunning = fn<[unknown[], string | null, unknown?], string>("renderRunning");
  const html = renderRunning(RUNNING_NOW, null);
  const text = textOf(html);
  // under the section's own heading (Running now): no second title; the statement's number is No., its text Statement
  assert.match(text, /^Session No\. User Client Running for Rows Statement /);
  assert.ok(!text.includes("Started (UTC)"), "how long it has run is the one time a running statement says: when it started is its title");
  assert.match(html, /<td class="num"><time data-tick datetime="2026-10-28T09:04:00\.000Z" title="started 2026-10-28 09:04:00 UTC">2 min<\/time><\/td>/);
  assert.match(text, /12 45 metabase Metabase v0\.50 2 min 1,200 rows sent SELECT customer_id, sum\(total\) FROM orders GROUP BY 1 Cancel/);
  assert.match(text, /13 7 \(no application_name\) 1\.5 s 1 row sent SELECT 1 <b> Cancel/);
  assert.ok(!html.includes("<b>"), "the statement is escaped");
  assert.match(html, /<code class="stmt" title="SELECT customer_id,\n {2}sum\(total\)\nFROM orders\nGROUP BY 1">/, "the whole statement is its title");
  // the words the page re-says are the CLI's: its line for each statement carries them
  for (const r of RUNNING_NOW) {
    const line = commands.runningLine(r as never);
    const rows = `${r.rows.toLocaleString("en-US")} row${r.rows === 1 ? "" : "s"} sent`;
    for (const words of [rows, commands.spanText(r.runningMs / 1000), r.applicationName || "(no application_name)", commands.oneLine(r.query, 120)]) {
      assert.ok(line.includes(words), `the CLI's line says ${words}`);
      assert.ok(text.includes(words), `and so does the page`);
    }
  }
  assert.match(html, /<button type="button" class="danger small" data-ask-cancel="12:45">Cancel<\/button>/, "Cancel is a small danger button");
  const asking = renderRunning(RUNNING_NOW, "12:45");
  assert.equal(textOf(popOf(asking, "act-running-12:45")), "Cancel session 12's statement 45? Its client gets a \"canceling statement\" error. Cancel statement 45 Keep it running");
  assert.match(asking, /data-confirm-cancel="12:45"/);
  // the question a popover beside its Cancel, which stays where it was, held down: no row inserted, the columns as they were
  assert.equal(textOf(withoutPops(asking)), text, "the table says what it said");
  assert.match(asking, /<td class="act" id="act-running-12:45"><button type="button" class="danger small" aria-expanded="true" disabled>Cancel<\/button><\/td>/);
  assert.ok(!/data-confirm-cancel="13:7"/.test(asking), "only the one asked");
  assert.equal(textOf(renderRunning([], null)), "No statement is running now.");
});

test("running now: the answer to a cancel is said beside its row's Cancel, a refusal as the CLI's Failure, beside the part once the statement ended, and stays until dismissed", () => {
  const renderRunning = fn<[unknown[], string | null, unknown, number?], string>("renderRunning");
  const done = renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] });
  assert.equal(textOf(popOf(done, "act-running-12:45")), "Cancelled session 12's statement: it ends now, and its client gets a \"canceling statement\" error. Dismiss", "beside the row it was for, with its Dismiss");
  assert.match(popOf(done, "act-running-12:45"), /<button type="button" class="small" data-dismiss-cancelled data-pop-close>Dismiss<\/button>/);
  assert.equal(textOf(withoutPops(done)), textOf(renderRunning(RUNNING_NOW, null, null)), "no row inserted");
  // a cancel's answer stays up until it is dismissed, however long, as a refusal does (issue 811)
  const at = Date.parse("2026-10-28T09:00:00.000Z");
  assert.ok(popOf(renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] }, at + 3_600_000), "act-running-12:45"), "an hour on: still said");
  const refused = { key: "12:45", failure: { code: "refused", message: "session 12 runs another statement now (statement 46), not statement 45: nothing cancelled", why: "statement 45 ended, and the session began another",
    fix: "mason cancel 12 --statement 46 stops the one it runs now", next: [{ command: "mason logs --running", what: "the statements running now, with their sessions" }] } };
  assert.equal(textOf(popOf(renderRunning(RUNNING_NOW.slice(0, 1), null, { ...refused, at: 0 }, Date.now()), "act-running-12:45")), "✗ session 12 runs another statement now (statement 46), not statement 45: nothing cancelled why statement 45 ended, and the session began another fix mason cancel 12 --statement 46 stops the one it runs now Next: mason logs --running the statements running now, with their sessions Dismiss");
  assert.equal(textOf(popOf(renderRunning([], null, { key: "12:45", cancelled: RUNNING_NOW[0] }), "usage-running")), "Cancelled session 12's statement: it ends now, and its client gets a \"canceling statement\" error. Dismiss", "the statement ended: beside the part (Usage's)");
});

test("the request log: a row each, newest first, in the commands' words — held equal to mason logs --requests' line — Older and Newest", () => {
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const html = renderRequests({ requests: REQUESTS, keptDays: 7, before: "2026-10-28T09:00:00.000Z~5" }, { now: Date.parse("2026-10-28T09:05:00.000Z") });
  const text = textOf(html);
  assert.match(text, /^Status Query id Started ↓ Duration ↕ User Client Rows ↕ Statement /, "no Ended or Bytes column: they are in the row's details; Started, Duration and Rows sort, the start newest first");
  assert.match(text, /Cancelled r-new 4 min ago 90,000 ms metabase \(no application_name\) SELECT pg_sleep\(100\) \+ canceling statement due to user request Completed r-old 5 min ago 1,234 ms ana psql 1 SELECT count\(\*\) FROM orders \+ Older$/);
  assert.equal([...html.matchAll(/<details data-open="request:r-(new|old)"><summary>r-(new|old)<\/summary><\/details>/g)].length, 2, "a details per row, closed, keyed by its request, its id the toggle");
  assert.ok(!/<details[^>]* open/.test(html) && !html.includes("Bytes sent"), "closed: the row's details are not written");
  // the status is a dot AND the word, from the ledger's outcome as mason logs --requests says it: completed ok, refused
  // warn, failed bad, cancelled warn — a refusal (Postico's SHOW ALL, 0A000) is Refused, never Failed
  assert.match(html, /<tr class="s-cancelled"><td><span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>Cancelled<\/span>/);
  assert.match(html, /<tr class="s-completed"><td><span class="indicator ok">/);
  const refusedHtml = renderRequests({ requests: [failedRequest], keptDays: 7, before: null });
  assert.match(refusedHtml, /<tr class="s-refused"><td><span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>Refused<\/span>/);
  assert.ok(!refusedHtml.includes("Failed"), "a refusal is not said to have failed");
  assert.match(renderRequests({ requests: [{ ...failedRequest, outcome: "failed", sqlstate: "XX000", message: "boom" }], keptDays: 7, before: null }),
    /<tr class="s-failed"><td><span class="indicator bad"><span class="dot" aria-hidden="true"><\/span>Failed<\/span>/);
  for (const outcome of ["refused", "failed"]) {
    const line = commands.requestLine({ ...failedRequest, outcome } as never, PLAIN);
    assert.ok(line.includes(outcome) && textOf(renderRequests({ requests: [{ ...failedRequest, outcome }], keptDays: 7, before: null })).toLowerCase().startsWith(`status query id started ↓ duration ↕ user client rows ↕ statement ${outcome} `),
      `the page's word for ${outcome} is the CLI's`);
  }
  // started: how long ago, the UTC time its title
  assert.match(html, /<time data-tick datetime="2026-10-28T09:01:00.000Z" title="2026-10-28 09:01:00 UTC">/);
  assert.match(renderRequests({ requests: [REQUESTS[0]], keptDays: 7, before: null }, { now: Date.parse("2026-10-28T09:05:00.000Z") }), /<time [^>]*>5 min ago<\/time>/);
  // opened: the expanded row holds the whole id, when it started and ended, the bytes, the whole statement and error
  const opened = textOf(renderRequests({ requests: REQUESTS, keptDays: 7, before: null }, { isOpen: (k: string) => k === "request:r-old" }));
  assert.match(opened, /Completed r-old .* SELECT count\(\*\) FROM orders − Query id r-old Started \(UTC\) 2026-10-28 09:00:00\.000 Ended \(UTC\) 2026-10-28 09:00:01\.234 Bytes sent 2\.0 KiB SELECT count\(\*\) FROM orders$/);
  assert.ok(!/Query id r-new/.test(opened), "only the one opened");
  // the id is its first 8 characters, the whole one its title and in the details
  const long = renderRequests({ requests: [{ ...REQUESTS[0], requestId: "0b9e5c1e-0000-4000-8000-000000000001", query: "SELECT\n 1", message: "boom\nline 2", sqlstate: "XX000" }], keptDays: 7, before: null });
  assert.match(long, /<summary>0b9e5c1e<\/summary>/, "the id is its first 8 characters");
  const longOpen = renderRequests({ requests: [{ ...REQUESTS[0], requestId: "0b9e5c1e-0000-4000-8000-000000000001", query: "SELECT\n 1", message: "boom\nline 2", sqlstate: "XX000" }], keptDays: 7, before: null }, { isOpen: () => true });
  assert.match(textOf(longOpen), /Query id 0b9e5c1e-0000-4000-8000-000000000001 Started \(UTC\) 2026-10-28 09:00:00\.000 Ended \(UTC\) 2026-10-28 09:00:01\.234 Bytes sent 2\.0 KiB SELECT 1 XX000 boom line 2/);
  assert.match(longOpen, /<pre class="stmt">SELECT\n 1<\/pre><pre class="error">XX000 boom\nline 2<\/pre>/, "the whole statement and the whole error");
  assert.ok(!longOpen.includes("Plan"), "a row with no plan says none");
  // A SLOW STATEMENT'S PLAN (issue 825; `plan` of mason logs --requests --json): in its expanded row as text, its lines
  // and their indentation kept, escaped, and said when the log kept it cut; never in a closed row
  const plan = "Mason: answered from the synced table public.orders (about 3 rows)\n  Sent to the engine: SELECT a < b FROM orders\nTop N  (rows=3)\n  ->  Table Scan on public.orders  (rows=3)";
  const slowRequest = { ...REQUESTS[0], requestId: "0b9e5c1e-0000-4000-8000-0000000000aa", durationMs: 2345, plan, planTruncated: false };
  const planOpen = renderRequests({ requests: [slowRequest], keptDays: 7, before: null }, { isOpen: () => true });
  assert.ok(planOpen.includes(`<p class="plan-label">Plan, recorded once it ended (it took 2,345 ms)</p><pre class="plan">Mason: answered from the synced table public.orders (about 3 rows)\n  Sent to the engine: SELECT a &lt; b FROM orders\nTop N  (rows=3)\n  -&gt;  Table Scan on public.orders  (rows=3)</pre>`), planOpen);
  assert.ok(!renderRequests({ requests: [slowRequest], keptDays: 7, before: null }).includes("Top N"), "a closed row writes no plan");
  assert.match(renderRequests({ requests: [{ ...slowRequest, planTruncated: true }], keptDays: 7, before: null }, { isOpen: () => true }),
    /<\/pre><p class="dim cut">the request log kept the plan cut at 8 KiB<\/p>/);
  const hugePlan = renderRequests({ requests: [{ ...slowRequest, plan: "x".repeat(20_000) }], keptDays: 7, before: null }, { isOpen: () => true });
  assert.match(hugePlan, /<p class="dim cut">the first 16\.0 KiB of 19\.5 KiB: mason logs --requests --id 0b9e5c1e-0000-4000-8000-0000000000aa has it whole<\/p>/, "cut as the statement is, naming where it is whole");
  // the CLI prints the same plan, whole, for that request (mason logs --requests --id)
  const detail = commands.requestDetail(slowRequest as never, PLAIN);
  for (const l of plan.split("\n")) assert.ok(detail.includes(`\n  ${l}`), `the CLI's --id says ${l}`);
  assert.ok(!html.includes("data-newest"), "the newest page has no Newest");
  for (const r of REQUESTS) {
    const line = commands.requestLine(r as never, PLAIN);
    const words = [commands.statementMsText(r.durationMs), r.query, ...(r.message ? [r.message.split("\n")[0]!] : [])];
    for (const w of words) { assert.ok(line.includes(w), `the CLI's line says ${w}`); assert.ok(text.includes(w), "and so does the page"); }
  }
  assert.match(textOf(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true })), /Refused .* relation "nope" does not exist Newest$/);
  assert.match(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true }), /<div class="paging"><button type="button" data-newest>Newest<\/button><\/div>/);
  assert.match(renderRequests({ requests: [], keptDays: 7, before: null }), /^<div class="empty"><p class="empty-title">No request in the last 7 days \(MASON_HISTORY_DAYS\)\.<\/p><\/div><p class="dim unlisted">A statement that reads no synced table /,
    "nothing listed and nothing filtered: what the log does not list (a select 1 typed to test the connection), as mason logs --requests says it");
  assert.equal(textOf(renderRequests({ requests: [], keptDays: 1, before: null }, { filtered: true })), "No request that passes the filters in the last 1 day (MASON_HISTORY_DAYS).");
});

test("the request log's filters: each view has its own path — status as the server's outcomes, since, user, client", async () => {
  const run = fakeRun();
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  const asked = async (f: Record<string, string>) => { run.asked.length = 0; await app.filterRequests(f); return [...run.asked]; };
  run.answers.set("GET api/requests?outcome=ok&since=15m", answer({ requests: [], keptDays: 7, before: null }));
  run.answers.set("GET api/requests?outcome=ok&since=24h", answer({ requests: [], keptDays: 7, before: null }));
  run.answers.set("GET api/requests?outcome=refused%2Cfailed&since=2h&user=ana&client=psql", answer({ requests: [failedRequest], keptDays: 7, before: null }));
  assert.deepEqual(await asked({ status: "completed" }), ["GET api/requests?outcome=ok&since=15m"], "since is the range's, Now's 15 minutes unless the hash says");
  assert.match(textOf(app.view()["request-log"]!), /^No request that passes the filters in the last 15 minutes \(the request log keeps 7 days: MASON_HISTORY_DAYS\)\./);
  assert.deepEqual(await asked({ status: "refused-or-failed", since: "2h", user: "ana", client: "psql" }), ["GET api/requests?outcome=refused%2Cfailed&since=2h&user=ana&client=psql"]);
  assert.match(textOf(app.view()["request-log"]!), / relation "nope"/);
  // Refused and Failed are offered apart, each the ledger's outcome of that name
  assert.deepEqual(await asked({ status: "refused" }), ["GET api/requests?outcome=refused&since=15m"]);
  assert.deepEqual(await asked({ status: "failed" }), ["GET api/requests?outcome=failed&since=15m"]);
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<select id="rq-status" name="status"><option value="">All<\/option><option value="completed">Completed<\/option><option value="refused">Refused<\/option><option value="failed">Failed<\/option><option value="refused-or-failed">Refused or failed<\/option>/);
  assert.deepEqual(await asked({}), ["GET api/requests?since=15m"], "cleared: every request of the range again");
  // a range in the hash: its since, the filters kept
  app.show("observability/queries?range=24h");
  assert.deepEqual(await asked({ status: "completed" }), ["GET api/requests?outcome=ok&since=24h"]);
  assert.match(textOf(app.view()["request-log"]!), /^No request that passes the filters in the last 24 hours /);
});

test("the app: Usage's Cancel asks first; the confirm posts { session, statement } and reads the statements again; a 409 renders as its Failure", async () => {
  const run = fakeRun();
  run.answers.set("GET api/running", answer({ running: RUNNING_NOW }));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("usage");
  await app.poll();
  assert.match(textOf(app.view()["usage-running"]!), /^Session No\. .* 12 45 .* 13 7 /);
  app.askCancelStatement(12, 45);
  assert.match(textOf(app.view()["usage-running"]!), /Cancel session 12's statement 45\? Its client gets a "canceling statement" error/);
  run.asked.length = 0;
  await app.poll();
  assert.match(textOf(app.view()["usage-running"]!), /Cancel session 12's statement 45\?/, "a poll keeps the question");
  app.dismissCancelStatement();
  assert.ok(!/Its client gets a/.test(textOf(app.view()["usage-running"]!)));
  assert.ok(!run.asked.some((a) => a.startsWith("POST")), "asking posts nothing");
  app.askCancelStatement(12, 45);
  run.answers.set("POST api/cancel", answer({ cancelled: RUNNING_NOW[0], next: [] }));
  run.answers.set("GET api/running", answer({ running: RUNNING_NOW.slice(1) }));
  run.asked.length = 0;
  assert.equal(await app.confirmCancelStatement(12, 45), true);
  assert.deepEqual(run.asked, [`POST api/cancel ${JSON.stringify({ session: 12, statement: 45 })}`, "GET api/running", "GET api/state"], "the statements running and who is connected, read again");
  assert.match(textOf(app.view()["usage-running"]!), /^Session No\. .* 13 7 .*Cancelled session 12's statement: it ends now/, "the statement ended: said beside the part");
  assert.match(popOf(app.view()["usage-running"]!, "usage-running"), /Cancelled session 12's statement/);
  // the answer stays up across polls until it is dismissed: Escape (the page's dismiss) takes it (issue 811)
  await app.poll();
  assert.match(popOf(app.view()["usage-running"]!, "usage-running"), /Cancelled session 12's statement/, "a poll on: still said");
  const usage = (app as unknown as { pages: Map<string, { dismiss(): unknown }> }).pages.get("usage")!;
  assert.equal(usage.dismiss(), true);
  assert.equal(popsOf(app.view()["usage-running"]!).length, 0, "gone on Escape");
  assert.equal(usage.dismiss(), null, "nothing left to dismiss");
  // the session began another statement: the server refuses, and the page renders its Failure beside the row's Cancel
  const failure = { code: "refused", message: "session 13 runs another statement now (statement 8), not statement 7: nothing cancelled", why: "statement 7 ended, and the session began another",
    fix: "mason cancel 13 --statement 8 stops the one it runs now", next: [{ command: "mason logs --running", what: "the statements running now, with their sessions" }] };
  run.answers.set("POST api/cancel", answer({ error: failure.message, failure }, 409));
  app.askCancelStatement(13, 7);
  assert.equal(await app.confirmCancelStatement(13, 7), false);
  assert.match(textOf(popOf(app.view()["usage-running"]!, "act-running-13:7")), /^✗ session 13 runs another statement now \(statement 8\), not statement 7: nothing cancelled why statement 7 ended, and the session began another fix mason cancel 13 --statement 8 stops the one it runs now Next: mason logs --running/);
  app.dismissCancelled();
  assert.equal(popsOf(app.view()["usage-running"]!).length, 0, "a refusal stays until dismissed");
});

test("the app: the newest page is read every 5 s; Older reads the page before with its cursor and stops polling it; Newest returns", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  run.answers.set("GET api/requests?since=15m", answer({ requests: [REQUESTS[1]], keptDays: 7, before: "CURSOR.1" }));
  run.answers.set("GET api/requests?since=15m&before=CURSOR.1", answer({ requests: [REQUESTS[0]], keptDays: 7, before: null }));
  const app = fn<[unknown, () => Date], QueriesApp>("createApp")(run.fetch, () => new Date(t));
  app.show("queries");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET api/requests?since=15m", "GET api/state"],
    "the request log alone (who is connected, what runs and the range's numbers are Usage's); the state, how to connect, beside it");
  t += 2000;
  assert.deepEqual(await asked(), [], "nothing every 2 s");
  t += 3000;
  assert.deepEqual(await asked(), ["GET api/requests?since=15m"], "the newest page every 5 s while the range is Now (the state every 30 s)");
  assert.ok(textOf(app.view()["request-log"]!).endsWith("Older"));
  run.asked.length = 0;
  await app.olderRequests();
  assert.deepEqual(run.asked, ["GET api/requests?since=15m&before=CURSOR.1"], "Older asks with the cursor the page answered with");
  assert.match(textOf(app.view()["request-log"]!), /r-old .* Newest$/);
  t += 60_000;
  assert.deepEqual(await asked(), ["GET api/state"], "an older page is never read again while paging");
  await app.newestRequests();
  assert.match(textOf(app.view()["request-log"]!), /r-new .* Older$/);
  t += 5000;
  assert.deepEqual(await asked(), ["GET api/requests?since=15m"], "the newest page is polled again");
});

test("the app: a search is read every 30 s, not 5 (it reads every statement's text of the range), and the log says so; cleared, every 5 s again", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const page = { requests: [REQUESTS[1]], keptDays: 7, before: null };
  run.answers.set("GET api/requests?since=15m&search=orders", answer(page));
  run.answers.set("GET api/requests?since=15m", answer(page));
  const app = fn<[unknown, () => Date], QueriesApp>("createApp")(run.fetch, () => new Date(t));
  app.show("queries");
  await app.poll();
  await app.filterRequests({ search: "orders" });
  const searches = async () => { run.asked.length = 0; await app.poll(); return run.asked.filter((a) => a.startsWith("GET api/requests")); };
  assert.match(textOf(app.view()["request-log"]!), /Refreshed every 30 s while searching: a search reads the text of every statement in the range\.$/);
  for (const step of [5000, 5000, 5000, 5000, 5000]) { t += step; assert.deepEqual(await searches(), [], "not read again within 30 s"); }
  t += 5000;
  assert.deepEqual(await searches(), ["GET api/requests?since=15m&search=orders"], "read again after 30 s");
  await app.filterRequests({});
  assert.doesNotMatch(app.view()["request-log"]!, /Refreshed every/);
  t += 5000;
  assert.deepEqual(await searches(), ["GET api/requests?since=15m"], "no search: the newest page every 5 s");
});

test("the app: a filter the server refuses renders its Failure, not a table: the page validates nothing", async () => {
  const run = fakeRun();
  const failure = { code: "usage", message: "since \"yesterday\" is not a time", fix: "an age (30m, 2h, 7d) or an ISO 8601 date or time with its zone (2026-10-28, 2026-10-28T09:00:00Z)" };
  run.answers.set("GET api/requests?since=yesterday", answer({ error: failure.message, failure }, 400));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  await app.filterRequests({ since: "yesterday" });
  assert.equal(textOf(app.view()["request-log"]!), `✗ since "yesterday" is not a time fix an age (30m, 2h, 7d) or an ISO 8601 date or time with its zone (2026-10-28, 2026-10-28T09:00:00Z)`);
  assert.ok(!fs.readFileSync(path.join(WEB, "index.html"), "utf8").includes("pattern="), "no input mirrors a server rule");
});

test("in the browser: the filter form filters (blanks are no filter), and Usage's Cancel is a click", async () => {
  const run = fakeRun();
  run.answers.set("GET api/running", answer({ running: RUNNING_NOW }));
  run.answers.set("GET api/requests?since=15m", answer({ requests: [REQUESTS[1]], keptDays: 7, before: "CURSOR.1" }));
  run.answers.set("GET api/requests?outcome=cancelled&since=15m&user=metabase", answer({ requests: [REQUESTS[1]], keptDays: 7, before: null }));
  const { el, on, go, settle } = fakeBrowser(run, "#queries");
  await settle();
  assert.match(textOf(el("request-log").html), /Older$/);
  const form = { id: "request-filters", elements: { status: { value: "cancelled" }, since: { value: " " }, user: { value: "metabase" }, client: { value: "" } } };
  let prevented = false;
  run.asked.length = 0;
  await on.get("submit")!({ target: form, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(run.asked, ["GET api/requests?outcome=cancelled&since=15m&user=metabase"]);
  assert.ok(!/Older/.test(textOf(el("request-log").html)));
  go("#observability/usage"); await settle();
  assert.match(textOf(el("usage-running").html), /^Session No\. .* 12 45 .* 13 7 /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { askCancel: "13:7" } }) } });
  assert.match(textOf(el("usage-running").html), /Cancel session 13's statement 7\?/);
});

test("the users: read with their last use, every 30 s, the state beside them; Copy puts a connect detail on the clipboard; Remove sends DELETE", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const U = "GET api/users?lastUsed=1";
  run.answers.set(U, answer({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: null, url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 }));
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { click(d: unknown, b: unknown, w: unknown): Promise<void> | null }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("users");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), [U, "GET api/state"], "on opening: its own, and the state for the sidebar (once a minute)");
  t += 2000;
  assert.deepEqual(await asked(), [], "not at the 2 s poll");
  t += 28_000;
  assert.deepEqual(await asked(), [U, "GET api/state"], "then every 30 s, the state with them (the Connect panel's)");
  assert.match(textOf(app.view().users!), /metabase id 0123456789abcdef every table from anywhere Active 2026-10-27 09:10 UTC never Queries Disable Remove old id aaaaaaaaaaaaaaaa every table Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC Queries$/);
  // Copy (the Connect panel's): the page's own handler writes the text as shown, and keeps it nowhere
  const written: string[] = [];
  const doc = { getElementById: (id: string) => id === "users-connect-host" ? { textContent: "127.0.0.1" } : null };
  const win = { navigator: { clipboard: { writeText: async (s: string) => { written.push(s); } } } };
  const button = { textContent: "Copy" };
  await app.pages.get("users")!.click({ copy: "users-connect-host" }, button, { doc, win });
  assert.deepEqual(written, ["127.0.0.1"]);
  assert.equal(button.textContent, "Copied");
  // Remove: asks, then DELETE and the list again with the last use
  app.askRemove("metabase");
  run.answers.set("DELETE api/users/metabase", answer({ removed: { name: "metabase" }, next: [] }));
  run.asked.length = 0;
  assert.equal(await app.confirmRemove("metabase"), true);
  assert.deepEqual(run.asked, ["DELETE api/users/metabase", U]);
});

// ------------------------------------------------------------------ the Usage and Logs pages

// read when the tests run: at a commit without the pages the file still loads, and each test fails by name
const usagePage = await import(path.join(WEB, "pages", "usage.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const syncsPage = await import(path.join(WEB, "pages", "syncs.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const fnOf = <A extends unknown[], R>(mod: Record<string, unknown>, name: string): Fn<A, R> => { assert.equal(typeof mod[name], "function", `the page exports ${name}`); return mod[name] as Fn<A, R>; };
const PLAIN_STYLE = (await import("../src/cli/style.ts")).PLAIN;

const usageCliModule = await import("../src/cli/usage.ts");
const usageCliLine = (s: unknown, lag: boolean): string => usageCliModule.sampleLine(s as never, lag);
const WINDOW = (days: number, covered: number) => ({ days, covered, statements: 1204, completed: 1190, refused: 10, failed: 2, cancelled: 2, rows: 52_000, bytesSent: 3 * 1024 * 1024, durationMs: { avg: 120, p50: 40, p95: 900 } });
const UL_QUERIES = { queries: { keptDays: 3, day: WINDOW(1, 1), week: { ...WINDOW(7, 3), statements: 9, durationMs: null, bytesSent: 512 } } };
const SAMPLE = { at: "2026-10-28T09:05:00.000Z", seconds: 3600, copyBytes: 5 * 2 ** 30, copyRows: 12_345_678, tablesAdded: 4, tablesCopied: 4, tablesFailed: 1, oldestSyncSeconds: 75,
  statements: 1204, statementsRefused: 2, statementsFailed: 1, statementsCancelled: 0, rowsSent: 98_765, bytesSent: 4_567_890, durationP50Ms: 12, durationP95Ms: 1830, streamLagBytes: null, streamLagSeconds: null,
  rssBytes: 900 * 2 ** 20, heapUsedBytes: 80 * 2 ** 20, copyMemoryBytes: 300 * 2 ** 20, copyMemoryLimitBytes: 8 * 2 ** 30 };
const IDLE = { ...SAMPLE, at: "2026-10-28T10:05:00.000Z", statements: 0, statementsRefused: 0, statementsFailed: 0, durationP95Ms: null, tablesFailed: 0, oldestSyncSeconds: null, copyBytes: null, copyMemoryBytes: null };
const UL_USAGE = { since: "2026-10-27T09:05:00.000Z", until: "2026-10-28T09:05:00.000Z", stepSeconds: 3600, sampleSeconds: 60, keptDays: 7, samples: [SAMPLE, IDLE],
  copySizes: [{ table: "public.orders", bytes: 3 * 2 ** 30, at: "2026-10-28T09:00:12.000Z" }, { table: "public.customers", bytes: 40_000, at: "2026-10-28T09:00:12.000Z" }] };
const UL_EVENTS = { keptDays: 7, events: [
  { at: "2026-10-28T09:00:00.000Z", kind: "copied", failed: false, table: "public.orders", message: "copied 2,000,000 rows" },
  { at: "2026-10-28T09:01:00.000Z", kind: "copy_failed", failed: true, table: "public.events", message: "the source closed the connection\nthe sync tries it again in 5 min" },
  { at: "2026-10-28T09:05:00.000Z", kind: "restart", failed: true, table: null, message: "the run stopped <b>after</b> 42 s" }] };
const LOG = { kept: 2000, lines: [{ at: "2026-10-28T09:00:00.000Z", text: "mason started" }, { at: null, text: "copy: public.orders\n  chunk 3 of 20 <read>" }] };
const withUsageAnswers = (run: ReturnType<typeof fakeRun>) => {
  run.answers.set("GET api/queries", answer(UL_QUERIES));
  for (const [since, step] of [["15m", 60], ["1h", 60], ["24h", 3600], ["7d", 21_600]] as const) {
    run.answers.set(`GET api/usage?since=${since}&step=${step}`, answer(UL_USAGE));
    run.answers.set(`GET api/activity?since=${since}`, answer(activityOf()));
    run.answers.set(`GET api/events?limit=500&since=${since}`, answer(UL_EVENTS));
  }
  run.answers.set("GET api/logs?lines=200", answer(LOG));
};

test("Usage: a window the request log keeps fewer days of than it asks says so, in mason status's words (coveredText)", () => {
  const cli = commands.queryLines(UL_QUERIES.queries as never, PLAIN_STYLE).join("\n");
  assert.ok(cli.includes("(the request log keeps 3 days: MASON_HISTORY_DAYS)"));
  assert.equal(fnOf<[unknown], string>(usagePage, "coveredText")(UL_QUERIES.queries.week), "the request log keeps 3 days: MASON_HISTORY_DAYS");
  assert.equal(fnOf<[unknown], string>(usagePage, "coveredText")(UL_QUERIES.queries.day), "", "a window the log covers has no caveat");
  // the cards of a range longer than the log keeps say it under them, never a short window passed off as whole
  const kpis = fnOf<[Record<string, unknown>], string>(usagePage, "renderUsageKpis");
  assert.match(textOf(kpis({ activity: activityOf({ window: { days: 30, covered: 7 } }), range: "30d" })), /Sent, last 30 days 3\.0 MiB 52,000 rows 30 days: the request log keeps 7 days: MASON_HISTORY_DAYS$/);
  assert.doesNotMatch(textOf(kpis({ activity: activityOf(), range: "24h" })), /the request log keeps/);
  for (const gone of ["renderQueries", "durationsText", "summaryWindow"]) assert.equal(typeof usagePage[gone], "undefined", `${gone} is gone: the cards say the range's statements`);
});

test("Usage: each hour's cells are mason usage's (sampleLine), no sample yet is said, and each copy's own size is listed", async () => {
  const renderUsage = fnOf<[unknown], string>(usagePage, "renderUsage"), cells = fnOf<[unknown], Record<string, string>>(usagePage, "sampleCells");
  for (const s of [SAMPLE, IDLE, { ...SAMPLE, streamLagSeconds: 3, streamLagBytes: 10 }]) {
    const c = cells(s), line = usageCliLine(s, true);
    for (const k of ["time", "statements", "p95", "copy", "oldest", "memory"] as const) assert.ok(line.includes(c[k]!), `${k}: ${c[k]} in ${line}`);
    assert.ok(line.includes(c.rows!) && line.includes(c.rowsSent!));
    assert.equal(c.errors, s.statementsRefused + s.statementsFailed + s.statementsCancelled === 0 ? "" : String(s.statementsRefused + s.statementsFailed + s.statementsCancelled));
  }
  assert.equal(cells(SAMPLE).bytesSent, "4.4 MiB");
  const text = textOf(renderUsage(UL_USAGE));
  const html0 = () => renderUsage(UL_USAGE);
  assert.match(text, /^From 2026-10-27 09:05 to 2026-10-28 09:05 UTC, 60 min a line \(a sample every 60 s, kept 7 days\)\./);
  // newest first; the time's header turns it round (the charts read left to right, oldest first)
  assert.match(text, /Time \(UTC\) ↓ Statements Errors Rows sent Bytes sent p95 Size Rows Failing Oldest 2026-10-28 10:05 0 98,765 4\.4 MiB – – 12,345,678 – 2026-10-28 09:05 1,204 3 98,765 4\.4 MiB 1,830 ms 5\.0 GiB 12,345,678 1 75 s /);
  assert.match(textOf((renderUsage as unknown as (b: unknown, o?: unknown, s?: unknown) => string)(UL_USAGE, undefined, { key: "time", dir: "asc" })), /Time \(UTC\) ↑ .* Oldest 2026-10-28 09:05 1,204 .* 2026-10-28 10:05 0 /, "oldest first, asked");
  assert.match(html0(), /<th scope="col" aria-sort="descending"><button type="button" class="sort on" data-sort-table="hours" data-sort-key="time">Time \(UTC\)/);
  // the process's memory is not a default column: it is in a closed details of its own
  const html = renderUsage(UL_USAGE);
  assert.doesNotMatch(html.slice(0, html.indexOf("<details")), /Memory|MiB \(copy/, "no memory column in the hours");
  assert.match(html, /<details class="memory" data-open="usage-memory"><summary>Memory<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(text, /Memory Time \(UTC\) Memory 2026-10-28 10:05 900\.0 MiB 2026-10-28 09:05 900\.0 MiB \(engine 300\.0 MiB of 8\.0 GiB\)/);
  assert.doesNotMatch(text, /Lag/, "no lag column without a stream");
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [{ ...SAMPLE, streamLagSeconds: 3, streamLagBytes: 10 }] })), /Oldest Lag 2026-10-28 09:05 .* 75 s 3 s Memory Time \(UTC\) Memory 2026-10-28 09:05 900/);
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [] })), /No sample in this time: Mason takes the first a minute after it starts\./);
  const sizes = textOf(fnOf<[unknown], string>(usagePage, "renderCopySizes")(UL_USAGE.copySizes));
  assert.match(sizes, /^Measured every 10 min\. Table Size Measured at \(UTC\) public\.orders 3\.0 GiB 09:00 public\.customers 39\.1 KiB 09:00$/);
  assert.equal(usagePage.SIZE_EVERY_SECONDS as unknown, (await import("../src/duck/usage.ts")).SIZE_EVERY_MS / 1000, "as often as src/duck/usage.ts measures");
  assert.match(textOf(fnOf<[unknown], string>(usagePage, "renderCopySizes")([])), /No table measured yet/);
});

test("Usage: under Now what runs every poll, the range's statements and who is connected every 5 s, the samples and unsupported SQL every 60 s; a past range read once; only while shown; a refusal is the CLI's Failure", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("usage");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  const NOW_READS = ["GET api/activity?since=15m", "GET api/usage?since=15m&step=60", "GET api/unsupported?since=15m", "GET api/running", "GET api/state"];
  assert.deepEqual(await asked(), NOW_READS, "Now: the range's statements, its samples, its unsupported SQL, what runs and who is connected");
  const v = app.view();
  assert.match(textOf(v["usage-kpis"]!), /^Connected now .* Statements, last 15 min 1,204 /);
  assert.match(textOf(v["usage-hourly"]!), /2026-10-28 09:05 1,204 3/);
  assert.match(textOf(v["usage-sizes"]!), /public\.orders 3\.0 GiB/);
  assert.equal(v["usage-connected-h"], "Connected now");
  assert.equal(v["usage-running-h"], "Running now");
  assert.match(v["usage-running-lead"]!, /mason logs --running/);
  t += 2000; assert.deepEqual(await asked(), ["GET api/running"], "2 s on: what runs, alone");
  t += 3000; assert.deepEqual(await asked(), ["GET api/activity?since=15m", "GET api/running", "GET api/state"], "5 s on: the range's statements and who is connected too");
  t += 55_000; assert.deepEqual(await asked(), NOW_READS, "60 s on: the samples and the unsupported SQL too");
  app.show("status"); assert.deepEqual((await asked()).some((a) => a.includes("api/activity") || a.includes("api/running")), false, "not while another page is shown");
  // a past range: each read once, when chosen; what runs now is Now's alone
  app.show("observability/usage?range=24h");
  assert.deepEqual(await asked(), ["GET api/activity?since=24h", "GET api/usage?since=24h&step=3600", "GET api/unsupported?since=24h", "GET api/state"],
    "the range's statements, samples and unsupported SQL, read once (the state the sidebar's)");
  const p = app.view();
  assert.equal(p["usage-connected-h"], "Connected in the last 24 hours");
  assert.equal(p["usage-running-h"], "Slowest in the last 24 hours");
  assert.match(textOf(p["usage-connected"]!), /^User Client Statements Failed Sessions Last metabase Metabase v0\.50 1,100 9 3 /, "who sent statements in it");
  assert.equal(textOf(p["usage-running"]!), "No statement completed in the last 24 hours.", "the slowest of it");
  assert.match(textOf(p["usage-kpis"]!), /^Clients, last 24 hours 2 4 sessions Statements, last 24 hours 1,204 /);
  for (let i = 0; i < 3; i++) { t += 60_000; assert.deepEqual(await asked(), ["GET api/state"], "a minute on: the range is not read again"); }
  // the hours refused (a step the run does not take): the server's Failure, said once under the hours; the first read's is the banner
  const refusal = { error: "step is a whole number of seconds", failure: { code: "usage", message: "step is a whole number of seconds", why: "too short", fix: "mason usage --step 1h", next: [{ command: "mason usage --help", what: "the spans it takes" }] } };
  run.answers.set("GET api/usage?since=24h&step=3600", answer(refusal, 400));
  (app as unknown as { markStale(): void }).markStale(); await app.poll();
  const w = app.view();
  assert.match(textOf(w["usage-hourly"]!), /^✗ step is a whole number of seconds why too short fix mason usage --step 1h Next: mason usage --help the spans it takes /, "the Failure, then the last hours it knew");
  assert.doesNotMatch(textOf(w["usage-sizes"]!), /✗/, "said once");
  assert.equal(w.poll, "", "the range's statements answered");
  run.answers.set("GET api/activity?since=24h", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  (app as unknown as { markStale(): void }).markStale(); await app.poll();
  assert.match(textOf(app.view().poll!), /✗ the request log cannot be read/);
  assert.match(textOf(app.view()["usage-kpis"]!), /Statements, last 24 hours 1,204/, "the last counts stay under the banner");
});

test("Sync events: the sync's events are mason logs --events' lines in a table, a failure marked, NEWEST FIRST (When turns it round); none is said as the CLI says it", () => {
  const renderEvents = fnOf<[unknown, Record<string, unknown>?], string>(syncsPage, "renderEvents"), cells = fn<[unknown], Record<string, string>>("eventCells");
  for (const e of UL_EVENTS.events) {
    const c = cells(e);
    assert.equal(commands.eventLine(e as never, PLAIN_STYLE), `${c.time}  ${c.kind!.padEnd(18)}  ${c.table}  ${c.message}`, "the CLI's line, cell for cell");
  }
  const html = renderEvents(UL_EVENTS);
  const at = Date.parse("2026-10-28T09:10:00.000Z");
  const timeline = renderEvents(UL_EVENTS, { now: at });
  assert.equal(textOf(timeline), "When ↓ Kind Table Message 5 min ago ✗ restart (the sync) the run stopped <b>after</b> 42 s 9 min ago ✗ copy_failed public.events the source closed the connection the sync tries it again in 5 min 10 min ago copied public.orders copied 2,000,000 rows");
  assert.equal(textOf(renderEvents(UL_EVENTS, { now: at, sort: { key: "time", dir: "asc" } })), "When ↑ Kind Table Message 10 min ago copied public.orders copied 2,000,000 rows 9 min ago ✗ copy_failed public.events the source closed the connection the sync tries it again in 5 min 5 min ago ✗ restart (the sync) the run stopped <b>after</b> 42 s",
    "oldest first, as the command lists them, when asked");
  assert.match(timeline, /<th scope="col" aria-sort="descending"><button type="button" class="sort on" data-sort-table="events" data-sort-key="time">When/);
  assert.match(timeline, /<time data-tick datetime="2026-10-28T09:00:00.000Z" title="2026-10-28 09:00:00 UTC">10 min ago<\/time>/, "how long ago, the UTC time as the command prints it its title");
  assert.match(timeline, /<span class="badge ok">copied<\/span>/); assert.equal([...timeline.matchAll(/<span class="badge bad">✗ /g)].length, 2, "a failure is a red badge with its ✗");
  assert.equal([...html.matchAll(/class="t-failed"/g)].length, 2, "the failures are marked");
  // Failures only: what was read, narrowed in the page alone
  assert.equal(textOf(renderEvents(UL_EVENTS, { failuresOnly: true, now: at })), "2 of the 3 events read. When ↓ Kind Table Message 5 min ago ✗ restart (the sync) the run stopped <b>after</b> 42 s 9 min ago ✗ copy_failed public.events the source closed the connection the sync tries it again in 5 min");
  // a kind and a table narrow it too, and compose
  assert.match(textOf(renderEvents(UL_EVENTS, { kind: "copied", now: at })), /^1 of the 3 events read\. When ↓ Kind Table Message 10 min ago copied public\.orders/);
  assert.match(textOf(renderEvents(UL_EVENTS, { table: "(the sync)", now: at })), /^1 of the 3 events read\. .* restart \(the sync\)/);
  assert.equal(textOf(renderEvents(UL_EVENTS, { kind: "copied", failuresOnly: true })), "None of the 3 sync events read passes the filters.");
  assert.equal(textOf(renderEvents({ keptDays: 7, events: [UL_EVENTS.events[0]] }, { failuresOnly: true })), "None of the 1 sync event shown failed.");
  assert.doesNotMatch(html, /<b>/, "a message is escaped");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 })), "No sync event in the last 7 days (MASON_HISTORY_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { span: "the last hour" })), "No sync event in the last hour (the events are kept 7 days: MASON_HISTORY_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 1 })), "No sync event in the last 1 day (MASON_HISTORY_DAYS).");
});

test("Sync events: the run's entries are rows, NEWEST FIRST, a multi-line entry kept as one preformatted row", () => {
  const renderLogs = fnOf<[unknown], string>(syncsPage, "renderLogs");
  const html = renderLogs(LOG);
  assert.equal([...html.matchAll(/<div class="log-line">/g)].length, 2, "two entries, two lines");
  assert.ok(html.indexOf("mason started") > html.indexOf("copy: public.orders"), "the newest at the top");
  assert.match(html, /<pre>copy: public\.orders\n {2}chunk 3 of 20 &lt;read&gt;<\/pre>/);
  assert.match(html, /^<div class="terminal" role="log">/, "a terminal's lines");
  assert.match(textOf(html), /^copy: public\.orders chunk 3 of 20 <read> 2026-10-28 09:00:00 mason started The last 2 of at most 2000 entries the run keeps, newest first/);
  assert.match(textOf(renderLogs({ lines: [], kept: 2000 })), /The run has logged nothing yet\./);
});

test("Sync events: the events every 10 s while the range is Now, once for another; the run's raw log sits behind a closed details and is read, every 5 s, only while it is open; a refusal is its Failure under it", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App & { showRawLog(open: boolean): Promise<void> }>("createApp")(run.fetch, () => new Date(t));
  app.show("syncs");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET api/events?limit=500&since=15m", "GET api/state"], "closed: the log is not read (the state is the sidebar's)");
  assert.match(textOf(app.view()["syncs-events"]!), /✗ copy_failed/);
  const closed = app.view()["syncs-run"]!;
  assert.equal(closed, `<details id="syncs-raw"><summary>The run's raw log (for debugging)</summary></details>`);
  assert.doesNotMatch(closed, /mason started/, "the entries are not written while it is closed");
  t += 10_000; assert.deepEqual(await asked(), ["GET api/events?limit=500&since=15m"], "10 s on: still the events alone");
  // opened: the log is read at once, then every 5 s
  run.asked.length = 0;
  await app.showRawLog(true);
  assert.deepEqual(run.asked, ["GET api/logs?lines=200"]);
  assert.match(app.view()["syncs-run"]!, /^<details id="syncs-raw" open><summary>The run's raw log \(for debugging\)<\/summary>/);
  assert.match(textOf(app.view()["syncs-run"]!), /mason started/);
  t += 2000; assert.deepEqual(await asked(), [], "2 s on: neither is due");
  t += 3000; assert.deepEqual(await asked(), ["GET api/logs?lines=200"], "5 s on: the log alone");
  t += 5000; assert.deepEqual(await asked(), ["GET api/events?limit=500&since=15m", "GET api/logs?lines=200"], "10 s on: both");
  app.show("usage"); assert.deepEqual((await asked()).some((p) => p.includes("api/logs")), false, "not while another page is shown");
  app.show("syncs");
  run.answers.set("GET api/logs?lines=200", answer({ error: "lines is a whole number of log entries, 1 to 2000", failure: { code: "failed", message: "lines is a whole number of log entries, 1 to 2000", next: [] } }, 400));
  t += 10_000; await app.poll();
  assert.match(textOf(app.view()["syncs-run"]!), /^The run's raw log \(for debugging\) ✗ lines is a whole number of log entries, 1 to 2000 copy: public\.orders .* 2026-10-28 09:00:00 mason started/);
  assert.equal(app.view().poll, "");
  // closed again: no read
  await app.showRawLog(false);
  t += 10_000; assert.deepEqual(await asked(), ["GET api/events?limit=500&since=15m"]);
  // a past range: its events read once, when chosen
  app.show("observability/syncs?range=1h");
  assert.deepEqual(await asked(), ["GET api/events?limit=500&since=1h", "GET api/state"]);
  t += 60_000; assert.deepEqual(await asked(), ["GET api/state"], "its events never again by time (the state, the Table filter's choices, every 30 s)");
  app.show("syncs");
  run.answers.set("GET api/events?limit=500&since=15m", answer({ error: "no", failure: { code: "failed", message: "the events cannot be read", next: [] } }, 500));
  t += 10_000; await app.poll();
  assert.match(textOf(app.view().poll!), /✗ the events cannot be read/);
});

test("in the browser: opening the raw log's details reads it at once, closing it stops the reads", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  const { el, on, go, settle, tick } = fakeBrowser(run);
  await settle();
  go("#logs"); await settle();
  assert.ok(!run.asked.some((a) => a.includes("api/logs")), "closed: not read");
  // the browser opens the details and says so (the event does not bubble: the shell hears it on the way down)
  const toggle = on.get("toggle")!;
  run.asked.length = 0;
  await toggle({ target: { id: "syncs-raw", open: true } });
  assert.deepEqual(run.asked, ["GET api/logs?lines=200"]);
  assert.match(el("syncs-run").html, /<details id="syncs-raw" open>/);
  assert.match(textOf(el("syncs-run").html), /mason started/);
  // the toggle the page's own rewrite causes (the same state) and another details's change nothing
  run.asked.length = 0;
  await toggle({ target: { id: "syncs-raw", open: true } });
  await toggle({ target: { id: "other", open: true } });
  assert.deepEqual(run.asked, []);
  await toggle({ target: { id: "syncs-raw", open: false } });
  assert.equal(el("syncs-run").html, `<details id="syncs-raw"><summary>The run's raw log (for debugging)</summary></details>`);
  run.asked.length = 0;
  tick(); await settle();
  assert.ok(!(run.asked as string[]).some((a) => a.includes("api/logs")), "closed again: not read");
});

test("Sync events: a closed raw log has nothing inside to read", () => {
  const renderRawLog = fnOf<[boolean, string], string>(syncsPage, "renderRawLog");
  assert.match(renderRawLog(false, "<p>x</p>"), /^<details id="syncs-raw"><summary>The run's raw log \(for debugging\)<\/summary><\/details>$/);
  assert.match(renderRawLog(true, "<p>x</p>"), /^<details id="syncs-raw" open><summary>.*<\/summary><p>x<\/p><\/details>$/);
});

test("Usage and Sync events: the index.html has the parts the pages write, the placeholders' parts are gone", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const id of ["usage-kpis", "usage-charts", "usage-connected", "usage-running", "unsupported", "usage-hourly", "usage-sizes", "syncs-filters", "syncs-events", "syncs-run", "request-log", "tables"]) assert.match(html, new RegExp(`<div id="${id}"[^>]*></div>`), id);
  assert.match(html, /<h3 id="usage-connected-h">[^<]*<\/h3>/);
  assert.match(html, /<h3 id="usage-running-h">[^<]*<\/h3>/);
  assert.match(html, /<p class="lead" id="usage-running-lead"><\/p>/);
  // every part a page's view writes is in its section
  const app = fn<[unknown], App>("createApp")(fakeRun().fetch);
  for (const [id, keys] of [["usage", ["usage-kpis", "usage-charts", "usage-connected-h", "usage-connected", "usage-running-h", "usage-running-lead", "usage-running", "unsupported", "usage-hourly", "usage-sizes"]],
    ["queries", ["request-log"]], ["syncs", ["syncs-filters", "syncs-events", "syncs-run"]]] as const) {
    const section = html.match(new RegExp(`<section id="page-${id}"[\\s\\S]*?</section>`))?.[0] ?? assert.fail(`page-${id}`);
    for (const k of keys) { assert.ok(k in app.view(), `${id} writes ${k}`); assert.match(section, new RegExp(`id="${k}"`), `${k} is in page-${id}`); }
  }
  for (const gone of ["usage-queries", "connected-now", "running-now", "queries-kpis", "page-logs", "logs-events"]) assert.ok(!html.includes(`id="${gone}"`), `${gone} is gone`);
  assert.doesNotMatch(html, /id="copies"|The run's log<\/h3>/, "the tables are one list, and the raw log is the details' summary");
  assert.match(html, /<select id="tables-show">.*<option value="all">All<\/option><option value="added">Added<\/option><option value="failed">Failed<\/option><option value="not-added">Not added<\/option>/);
  assert.doesNotMatch(html, /<div id="usage"><\/div>|<div id="logs"><\/div>/);
});

test("Users: a user's last use is mason user list's words (lastUsedText, src/cli/user.ts), a time, unknown, never (added within the log's days), or not used within them", async () => {
  const cli = await import("../src/cli/user.ts") as unknown as { lastUsedText?: (at: string | null, note: string | null, days: number | null) => string };
  assert.equal(typeof cli.lastUsedText, "function", "src/cli/user.ts exports lastUsedText");
  const usersPage = await import(path.join(WEB, "pages", "users.js") as string) as { lastUsedText: (u: { lastUsedAt: string | null }, note: string | null, days: number | null) => string };
  const now = Date.parse("2026-10-28T09:00:00.000Z");
  const cliText = cli.lastUsedText as unknown as (at: string | null, note: string | null, days: number | null, addedAt: string | null, now: number) => string;
  const pageText = usersPage.lastUsedText as unknown as (u: { lastUsedAt: string | null; addedAt: string }, note: string | null, days: number | null, now: number) => string;
  const recently = "2026-10-27T09:10:00.000Z", long = "2026-09-01T09:10:00.000Z";
  const cases = [["2026-10-27T09:10:11.000Z", null, 7, recently, "2026-10-27 09:10 UTC"], [null, "unknown: Mason is not running", null, recently, "unknown"],
    [null, null, 7, recently, "never"], [null, null, 7, long, "not used in the last 7 days"], [null, null, null, recently, "not used in the last ? days"]] as const;
  for (const [at, note, days, addedAt, text] of cases) {
    assert.equal(cliText(at, note, days, addedAt, now), text, `${at} ${note} ${days} ${addedAt}`);
    assert.equal(pageText({ lastUsedAt: at, addedAt }, note, days, now), cliText(at, note, days, addedAt, now), "the page says what mason user list says");
  }
});

// ------------------------------------------------------------------ the stream, the slot, the engine, the disk and the sessions

const zero = { inserts: 0, updates: 0, deletes: 0, truncates: 0 };
const STREAM = {
  slot: "mason_dev_shop", slotWal: { walHeldBytes: 52_428_800, walStatus: "reserved", safeWalSizeBytes: 5 * 2 ** 30, at: "2026-10-27T09:05:29.000Z" },
  publication: "app_pub", running: true, failure: null, position: "0/16B3748", applied: "0/16B3700",
  database: { lsn: "0/16B4000", at: "2026-10-27T09:05:28.000Z" }, lag: { bytes: 2232, seconds: 1.4 },
  lastBatch: { appliedAt: "2026-10-27T09:05:29.400Z", committedAt: "2026-10-27T09:05:29.000Z" },
  tables: [
    { table: "public.customers", state: "streamed", why: null, applied: { inserts: 1000, updates: 200, deletes: 4, truncates: 0 } },
    { table: "public.orders", state: "catching-up", why: "caught up by one poll from 2026-10-27 09:00 UTC", applied: zero,
      catchUp: { phase: "polling", from: "2026-10-27T09:00:00.000Z", startedAt: "2026-10-27T09:05:00.000Z", held: 12, retryAt: null } },
    { table: "public.events", state: "waiting", why: "it is not copied yet", applied: zero },
    { table: "public.audit", state: "left-out", why: "the publication app_pub does not carry it", applied: zero },
  ],
};
const STREAMS: Array<[string, typeof STREAM | Record<string, unknown>]> = [
  ["running", STREAM],
  ["not running, retrying", { ...STREAM, running: false, failure: { error: "could not connect\nthe database refused", retryAt: "2026-10-27T09:05:40.000Z" } }],
  ["not running yet", { ...STREAM, running: false, failure: null, lastBatch: null }],
  ["the position unreadable", { ...STREAM, database: { error: "connection refused\nmore" }, lag: { bytes: null, seconds: null } }],
  ["the slot lost", { ...STREAM, slotWal: { walHeldBytes: 0, walStatus: "lost", safeWalSizeBytes: null, at: "2026-10-27T09:05:29.000Z" } }],
  ["the slot uncapped, unreadable, past its cap", { ...STREAM, slotWal: { walHeldBytes: 9, walStatus: null, safeWalSizeBytes: null, at: "2026-10-27T09:05:29.000Z" } }],
  ["the slot's WAL unreadable", { ...STREAM, slotWal: { error: "no restart position yet\nmore" } }],
  ["the slot past its cap", { ...STREAM, slotWal: { walHeldBytes: 9, walStatus: "unreserved", safeWalSizeBytes: 0, at: "2026-10-27T09:05:29.000Z" } }],
  ["catch-up failed", { ...STREAM, tables: [{ ...STREAM.tables[1]!, catchUp: { phase: "queued", from: null, startedAt: null, held: 1, retryAt: "2026-10-27T09:07:00.000Z" }, applied: { inserts: 1, updates: 0, deletes: 0, truncates: 0 } }] }],
];
const REPL = (stream: unknown, extra: Record<string, unknown> = {}) => ({ ...stateOf(THREE_COPIED(), { replication: true, now: NOW }), stream, ...extra }) as RunState;

test("the stream: the page's rows are mason status's streamLines, row for row, in every state of the stream", () => {
  const streamRows = fn<[unknown, number], { head: Array<[string, string]>; tables: Array<[string, string]> }>("streamRows");
  const cli = (commands as unknown as { streamLines?: (st: unknown, now: number) => string[] }).streamLines;
  assert.equal(typeof cli, "function", "src/cli/commands.ts exports streamLines");
  for (const [what, st] of STREAMS) {
    const { head, tables } = streamRows(st, NOW);
    const rows = [...head, ...tables];
    const w = Math.max(...rows.map(([k]) => k.length));
    assert.deepEqual(rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`), cli!(st, NOW), what);
  }
  const countsText = fn<[unknown], string>("countsText");
  for (const c of [zero, { inserts: 1, updates: 0, deletes: 0, truncates: 0 }, { inserts: 1000, updates: 200, deletes: 4, truncates: 1 }]) assert.equal(countsText(c), commandsStream.countsText(c as never));
});
const commandsStream = await import("../src/duck/stream.ts");

test("the Overview: replication mode says the changes — running or not and why, the position, the lag, the last batch — and none without a stream", () => {
  const renderStatus = fn<[unknown, unknown?], string>("renderStatus");
  const html = renderStatus(REPL(STREAM), { now: NOW });
  const text = textOf(html);
  assert.match(text, /Changes \(the stream, slot mason_dev_shop\) Stream running Position 0\/16B3748 · the database is at 0\/16B4000: 2,232 bytes behind \(read 2\.0 s ago\) Lag 2\.2 KiB behind the database, the newest change applied was committed 1\.4 s ago Slot holds 50\.0 MiB of the database's WAL \(reserved\) · 5\.0 GiB more before Postgres invalidates it \(max_slot_wal_keep_size\) \(read 1\.0 s ago\) Last change committed 1\.0 s ago, applied 0\.4 s after its commit/);
  assert.ok(!/<tr class="warn"><th scope="row">Stream/.test(html), "running: not a warning");
  assert.match(textOf(renderStatus(REPL(STREAMS[1]![1]), { now: NOW })), /Stream not running: could not connect · it starts again in 10 s/);
  assert.match(renderStatus(REPL(STREAMS[1]![1]), { now: NOW }), /<tr class="warn"><th scope="row">Stream<\/th>/, "a stream that is not running is a warning");
  assert.match(textOf(renderStatus(REPL(STREAMS[3]![1]), { now: NOW })), /the database's position could not be read: connection refused Lag bytes behind unknown/);
  assert.ok(!/Changes \(the stream/.test(textOf(renderStatus(RUNNING, { now: NOW }))), "polling: no stream block");
  // the facts' own Changes row (how changes arrive) is still the one table's
  assert.match(text, /Changes each table as its sync: says .* sync: replication tables streamed as they happen \(logical replication: slot mason_dev_shop, publication app_pub/);
});

test("the Overview: the slot's WAL is the CLI's slotText; lost, past its cap, uncapped and unreadable are warnings, a healthy slot is not", () => {
  const renderStatus = fn<[unknown, unknown?], string>("renderStatus");
  const cliSlot = (commands as unknown as { slotText: (w: unknown, since: (iso: string) => number) => string }).slotText;
  assert.equal(typeof cliSlot, "function", "src/cli/commands.ts exports slotText");
  const since = (iso: string) => (NOW - Date.parse(iso)) / 1000;
  const slotText = fn<[unknown, (iso: string) => number], string>("slotText");
  for (const [what, st] of STREAMS) assert.equal(slotText((st as typeof STREAM).slotWal, since), cliSlot((st as typeof STREAM).slotWal, since), what);
  const html = (slotWal: unknown) => renderStatus(REPL({ ...STREAM, slotWal }), { now: NOW });
  const at = "2026-10-27T09:05:29.000Z";
  const ok = html({ walHeldBytes: 52_428_800, walStatus: "reserved", safeWalSizeBytes: 5 * 2 ** 30, at });
  assert.match(textOf(ok), /Slot holds 50\.0 MiB of the database's WAL \(reserved\) · 5\.0 GiB more before Postgres invalidates it \(max_slot_wal_keep_size\) \(read 1\.0 s ago\)/);
  assert.doesNotMatch(ok, /<tr class="warn"><th scope="row">Slot/);
  for (const w of [{ walHeldBytes: 0, walStatus: "lost", safeWalSizeBytes: null, at }, { walHeldBytes: 1, walStatus: "unreserved", safeWalSizeBytes: 10, at },
    { walHeldBytes: 1, walStatus: "reserved", safeWalSizeBytes: null, at }, { walHeldBytes: 1, walStatus: "reserved", safeWalSizeBytes: 0, at }, { error: "no restart position yet" }]) {
    assert.match(html(w), /<tr class="warn"><th scope="row">Slot<\/th>/, JSON.stringify(w));
  }
  assert.match(textOf(html({ error: "no restart position yet\nmore" })), /Slot the WAL it holds could not be read: no restart position yet/, "unknown, never 0");
});

test("the Overview: Mason's version and uptime, the restarts, the disk and the sessions are the CLI's rows (masonRow, restartsRows, diskRows, sessionsRows) — held equal, but for the pid and the path", () => {
  const cli = commands as unknown as { masonRow: (e: unknown, pid: number) => [string, string]; restartsRows: (r: unknown) => Array<[string, string]>;
    diskRows: (d: unknown) => Array<[string, string]>; sessionsRows: (s: unknown) => Array<[string, string]> };
  for (const f of ["masonRow", "restartsRows", "diskRows", "sessionsRows"] as const) assert.equal(typeof cli[f], "function", `src/cli/commands.ts exports ${f}`);
  const engine = { version: "0.4.2", startedAt: "2026-10-27T08:00:00.000Z", uptimeSeconds: 3930 };
  // the state carries no pid: the page's row is the CLI's with ", pid N" gone
  assert.deepEqual(fn<[unknown], string[]>("masonRow")(engine), [cli.masonRow(engine, 4242)[0], cli.masonRow(engine, 4242)[1].replace(", pid 4242", "")]);
  assert.deepEqual(fn<[unknown], string[]>("masonRow")({ version: "0.4.2" }), ["Mason", cli.masonRow({ version: "0.4.2" }, 1)[1].replace(", pid 1", "")]);
  const hoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
  const restarts = fn<[unknown, number?], Array<[string, string]>>("restartsRows");
  for (const r of [undefined, { count: 0, last: null }, { count: 2, last: { at: hoursAgo, why: "the run crashed", upSeconds: 42 } }, { error: "restarts.json is unreadable" }]) assert.deepEqual(restarts(r), cli.restartsRows(r), JSON.stringify(r));
  const sessions = fn<[unknown], Array<[string, string]>>("sessionsRows");
  const byClient = [{ user: "metabase", client: "Metabase", open: 2, running: 1 }, { user: "", client: "", open: 1, running: 0 }, { user: "ana", client: "psql", open: 1, running: 0 }, { user: "bob", client: "dbt", open: 1, running: 0 }];
  for (const x of [undefined, { open: 0, byClient: [] }, { open: 5, byClient }, { open: 1, byClient: byClient.slice(0, 1) }]) assert.deepEqual(sessions(x), cli.sessionsRows(x), JSON.stringify(x));
  // the disk: the CLI says "free in <path>"; the page never shows an absolute path and says "where the copy is"
  const disk = fn<[unknown], Array<[string, string]>>("diskRows");
  const D = "/var/lib/mason/.mason";
  for (const d of [undefined, { path: D, freeBytes: 20 * 2 ** 30, copyBytes: 5, projectedBytes: null }, { path: D, freeBytes: 20 * 2 ** 30, copyBytes: 5, projectedBytes: 4 * 2 ** 30 },
    { path: D, freeBytes: 2 ** 30, copyBytes: 5, projectedBytes: 4 * 2 ** 30 }, { path: D, freeBytes: null, copyBytes: null, projectedBytes: null, error: "statfs failed" }]) {
    const want = cli.diskRows(d).map(([k, v]) => [k, v.replace(` free in ${D}`, " free where the synced data is")]);
    assert.deepEqual(disk(d), want, JSON.stringify(d));
    assert.ok(!disk(d).some(([, v]) => v.includes(D)), "no path");
  }
  // the page: those rows in the one table of facts; warnings only where it matters; absent says nothing
  const renderFacts = of<[unknown, number], string>(statusPage, "status.js", "renderFacts");
  const at3h = new Date(NOW - 3 * 3600_000).toISOString();
  const state = { ...RUNNING, engine: { ...RUNNING.engine, ...engine, restarts: { count: 2, last: { at: at3h, why: "the run crashed", upSeconds: 42 } } },
    disk: { path: D, freeBytes: 2 ** 30, copyBytes: 5, projectedBytes: 4 * 2 ** 30 }, sessions: { open: 5, byClient } };
  const html = renderFacts(state, NOW), text = textOf(html);
  assert.match(text, /Mason 0\.4\.2 · one process · up 1\.1 h|Mason 0\.4\.2 · one process · up 66 min/);
  assert.match(text, /Restarts 2, the last 3 h ago: the run crashed, after 42 s up/);
  assert.match(text, /Disk 1\.0 GiB free where the synced data is · the first syncs running are projected to add about 4\.0 GiB more — more than is free/);
  assert.match(text, /Sessions 5 open, 1 running a statement · 2 as metabase \(Metabase\), 1 by a token, 1 as ana \(psql\), and 1 other client/);
  assert.match(html, /<tr class="warn"><th scope="row">Disk<\/th>/);
  assert.ok(!text.includes(D) && !/duckdb/i.test(text));
  const { disk: _d, sessions: _s, ...older } = RUNNING as unknown as Record<string, unknown> & { engine: Record<string, unknown> };
  const bare = { ...older, engine: { name: older.engine.name, file: older.engine.file, bytes: older.engine.bytes, pollSeconds: older.engine.pollSeconds } };
  assert.doesNotMatch(textOf(renderFacts(bare, NOW)), /Mason \d|Restarts|Disk|Sessions/, "a run that says none of it: nothing");
  assert.match(textOf(renderFacts(RUNNING, NOW)), /Mason \S+ · one process/, "the run's own state says them (runState)");
  assert.match(textOf(renderFacts({ ...RUNNING, sessions: { error: "no listener\nmore" } } as never, NOW)), /Sessions could not be read: no listener/);
  // mason serve with MASON_UI_SOCKET (status --json pageSocket): said, never its path; none, nothing
  const onSocket = textOf(renderFacts({ ...RUNNING, pageSocket: "/run/mason/ui.sock" } as never, NOW));
  assert.match(onSocket, /Web page served on a Unix socket on the server too \(MASON_UI_SOCKET\)/);
  assert.ok(!onSocket.includes("/run/mason"), "no path");
  assert.doesNotMatch(textOf(renderFacts({ ...RUNNING, pageSocket: null } as never, NOW)), /Unix socket/);
});

test("Usage: who is connected now — a row per user and client with its open sessions and what it runs, and its statements on Queries; none is said, an error is unknown", async () => {
  const renderSessions = fn<[unknown, number?, string?], string>("renderSessions");
  const sessions = { open: 3, byClient: [{ user: "metabase", client: "Metabase v0.50", open: 2, running: 1 }, { user: "", client: "", open: 1, running: 0 }] };
  assert.equal(textOf(renderSessions(sessions)), "User Client Open Running metabase Metabase v0.50 2 1 Queries (no user) (no application_name) 1 0 Queries 3 sessions open.");
  // Queries: the client's statements on Observability › Queries, at the range shown (Now's links have none)
  assert.match(renderSessions(sessions), /<td class="act"><a class="btn small" href="#observability\/queries\?user=metabase&amp;client=Metabase\+v0\.50" title="the statements of metabase from Metabase v0\.50 in the last 15 minutes">Queries<\/a><\/td>/);
  assert.match(renderSessions(sessions, 10, "1h"), /href="#observability\/queries\?user=metabase&amp;client=Metabase\+v0\.50&amp;range=1h"/);
  assert.equal(textOf(renderSessions({ open: 0, byClient: [] })), "No client is connected now.");
  assert.equal(textOf(renderSessions({ error: "the listener is closed\nmore" })), "Who is connected could not be read (the listener is closed)");
  assert.equal(renderSessions(undefined), "", "a run that does not say it: nothing");
  const run = fakeRun();
  run.answers.set("GET api/state", answer({ ...COPYING, sessions }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("usage");
  await app.poll();
  assert.match(textOf(app.view()["usage-connected"]!), /^User Client Open Running metabase /);
});

test("Tables: in replication mode each added table's stream state is a column, in the commands' words; polling has none", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const st = REPL(STREAM, {}) as unknown as { stream: typeof STREAM };
  const html = renderTables(st, { now: NOW });
  const text = textOf(html);
  // the stream state is a line under each added table's row, never a column: what it says is long
  assert.match(text, /^Table State Rows Key Last sync Size public\.customers /);
  const { tables } = fn<[unknown, number], { tables: Array<[string, string]> }>("streamRows")(STREAM, NOW);
  for (const [t, words] of tables.filter(([t]) => ["public.customers", "public.orders", "public.events"].includes(t))) assert.ok(text.includes(words), `${t}: ${words}`);
  assert.match(text, /public\.customers Synced .* streamed · 1,204 changes \(1,000 inserts, 200 updates, 4 deletes\) this run /);
  assert.match(text, /catching up by one poll from 2026-10-27 09:00 UTC: polling, for 30 s · the stream holds 12 changes of it meanwhile/);
  assert.match(text, /not streamed yet: it is not copied yet/);
  assert.ok(!text.includes("left out: the publication"), "a table not added is not streamed: left-out is for the added ones the publication lacks");
  assert.doesNotMatch(textOf(renderTables(RUNNING)), /Stream/);
});

// ------------------------------------------------------------------ the Tables and Users pages, restyled

test("Tables and Users: the sections are a page head, the cards' part and a toolbar over the list; the users' add form is a card", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const section = (id: string) => html.slice(html.indexOf(`<section id="page-${id}"`), html.indexOf("</section>", html.indexOf(`<section id="page-${id}"`)));
  const tables = section("tables"), users = section("users");
  assert.match(tables, /<div class="page-head"><h2 id="tables-h">Tables<\/h2><p class="desc">/);
  assert.ok(tables.indexOf('id="tables-cards"') < tables.indexOf('class="toolbar"') && tables.indexOf('class="toolbar"') < tables.indexOf('id="tables"'), "cards, then the toolbar, then the list");
  // each label in a field with its control (on a phone a field is a row of its own: "Show" never wraps away from its select)
  assert.match(tables, /<div class="field grow"><label for="tables-filter">Search the tables<\/label>\s*<input type="search" id="tables-filter"[^>]*><\/div>/);
  assert.match(tables, /<div class="field"><label for="tables-show">Show<\/label>\s*<select id="tables-show">[\s\S]*?<\/select><\/div>/);
  assert.match(users, /<div class="page-head"><h2 id="users-h">Users<\/h2>/);
  // the form is the page's own once the state is read (renderAddUser: none on a read-only page), in its place
  assert.match(fn<[unknown], string>("renderAddUser")(CATALOG_STATE), /^<form id="add-user" class="formcard"[^>]*>[\s\S]*<button type="submit" class="primary">Add a user<\/button><\/form>$/);
  assert.ok(users.indexOf('id="add-user-box"') < users.indexOf('id="added"') && users.indexOf('id="added"') < users.indexOf('id="users"'), "the form, the password just shown, the users");
});

test("Tables: the cards are the tables added of all, those synced, those failed and the copies' rows; none before there is a table", () => {
  const cardsOf = of<[unknown], string>(tablesPage, "tables.js", "renderTablesCards");
  const tot = SYNCED.totals!;
  assert.equal(textOf(cardsOf(SYNCED)), `Tables added 3 of 4 in the database Synced ${tot.copied} of 3 added Failed ${tot.failed} of 3 added Rows ${tot.rows.toLocaleString("en-US")} in the synced tables`);
  assert.match(cardsOf(SYNCED), /<div class="card bad"><p class="card-label">Failed<\/p>/, "a failed copy colours its card");
  assert.doesNotMatch(cardsOf(RUNNING), /card bad/);
  assert.equal(cardsOf({ ...NONE, tables: [] }), "");
  const run = fakeRun();
  run.answers.set("GET api/state", answer(SYNCED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  return app.poll().then(() => assert.match(app.view()["tables-cards"]!, /^<div class="cards n4">/));
});

test("Tables: nothing added is the empty state above the list that still offers Add; a stream's column is in the same table", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const html = renderTables(NONE);
  assert.match(html, /^<div class="empty"><p class="empty-title">No table added yet<\/p><p>Add one from the list, as <code>mason add &lt;table&gt;<\/code> does\.<\/p><\/div>/);
  assert.match(html, /data-add-table="public\.customers"/, "the list is still there to add from");
  assert.doesNotMatch(renderTables(SYNCED, { sizes: USAGE }), /class="empty"/);
});

test("Tables: a copy's whole error stays open across the polls that rewrite the list; the filter's count and the buttons are the page's own", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(SYNCED));
  let t = Date.UTC(2026, 9, 28, 9, 5, 0);
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { toggle?: (target: unknown) => unknown }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("tables");
  await app.poll();
  const opens = () => [...app.view().tables!.matchAll(/<details[^>]*data-open="([^"]+)"[^>]* open>/g)].map((m) => m[1]);
  assert.deepEqual(opens(), []);
  assert.equal(app.pages.get("tables")!.toggle!({ dataset: { open: "error:public.orders" }, open: true }), true, "opened: the page is written again");
  for (let i = 0; i < 3; i++) { t += 2000; await app.poll(); }
  assert.deepEqual(opens(), ["error:public.orders"], "a poll later, still open");
  assert.equal(app.pages.get("tables")!.toggle!({ dataset: { open: "error:public.orders" }, open: true }), null, "the toggle a rewrite causes itself changes nothing");
  assert.equal(app.pages.get("tables")!.toggle!({ id: "syncs-raw", open: true }), null, "a details with no key is not this page's");
});

test("Users: the add form's password is a prominent card marked shown once; the active users come first, a removed one muted last, and the age ticks with the page's clock", async () => {
  const added = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password: "mason_0123456789abcdef_" + "a".repeat(32),
    database: "shop", url: "postgres://metabase@127.0.0.1:5433/shop" });
  assert.match(added, /^<div class="added" role="status"><p class="headline">The user metabase added: its password is shown this once <span class="badge warn">Shown once<\/span><\/p>/);
  assert.equal([...added.matchAll(/data-copy="/g)].length, 3, "the URL, the user and the password each have a Copy (the database is Connect's)");
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  run.answers.set("GET api/users?lastUsed=1", answer({ users: [{ name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null },
    { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: "2026-10-28T08:59:30.000Z", url: "postgres://metabase@127.0.0.1:5433/shop" }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 }));
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("users");
  await app.poll();
  assert.match(app.view().users!, /<span title="2026-10-28 08:59 UTC">30 s ago<\/span>/);
  t += 60_000;
  assert.match(app.view().users!, /<span title="2026-10-28 08:59 UTC">2 min ago<\/span>/, "an age moves with the clock between reads");
  assert.ok(app.view().users!.indexOf("metabase") < app.view().users!.indexOf(">old<"), "removed users are listed last");
});

// ------------------------------------------------------------------ the presentation: components, vendored files, details kept open, charts as an addition

const charts = await import(path.join(WEB, "charts.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;

test("the components: a state is a dot AND its word, a card its label, value and sub-line, every value escaped", () => {
  const status = fn<[string | undefined, string], string>("status"), statusKind = fn<[string], string>("statusKind");
  assert.equal(status("ok", "Synced"), `<span class="indicator ok"><span class="dot" aria-hidden="true"></span>Synced</span>`);
  assert.equal(textOf(status("bad", "Failed")), "Failed", "never the colour alone: the word is the text");
  assert.match(status("nonsense", "x"), /class="indicator unknown"/, "a kind it does not know is unknown");
  assert.deepEqual(["Ready", "Synced", "streamed", "Syncing", "Waiting", "Under way", "Failed", "error", "lost", "who knows"].map(statusKind),
    ["ok", "ok", "ok", "warn", "warn", "warn", "bad", "bad", "bad", "unknown"], "green ready/synced, amber syncing/waiting, red failed/error, gray unknown");
  assert.match(status(undefined, "Failed"), /indicator bad/, "the kind from the word when it is not said");
  const card = fn<[string, string, string?, string?, string?], string>("card");
  assert.equal(card("Rows", "30,001,200"), `<div class="card"><p class="card-label">Rows</p><p class="card-value">30,001,200</p></div>`);
  assert.equal(textOf(card("Tables synced", "2 of 3", "added, 1 failed", "", "bad")), "Tables synced 2 of 3 added, 1 failed");
  assert.match(card("a", "<b>", "c"), /&lt;b&gt;/);
  assert.match(card("x", "1", "", "", "bad"), /^<div class="card bad">/);
  assert.equal(fn<[string[]], string>("cards")([]), "", "no card: no grid");
  assert.equal(fn<[string, string?], string>("badge")("demo", "accent"), `<span class="badge accent">demo</span>`);
  assert.equal(fn<[string, Record<string, string>, string?], string>("button")("Sync", { syncTable: "public.o\"rders" }, "primary"),
    `<button type="button" class="primary" data-sync-table="public.o&quot;rders">Sync</button>`);
  assert.equal(textOf(fn<[string, string?], string>("empty")("No user yet", "<code>mason user add</code> adds one")), "No user yet mason user add adds one");
  assert.match(fn<[number?], string>("skeleton")(2), /^<div class="loading" aria-busy="true"><p class="dim">Asking Mason…<\/p><span class="skeleton"><\/span><span class="skeleton half"><\/span><\/div>$/);
  assert.equal(fn<[string], string>("panel")("<table></table>"), `<div class="panel"><table></table></div>`);
  const details = fn<[string, string, string, boolean?, string?], string>("details");
  assert.equal(details("request:a\"b", "More", "<p>x</p>"), `<details data-open="request:a&quot;b"><summary>More</summary><p>x</p></details>`);
  assert.equal(details("k", "More", "", true, "memory"), `<details class="memory" data-open="k" open><summary>More</summary></details>`);
});

test("the shell: the sidebar's project and a demo badge, its nav, its foot (updated, the version), the Overview's header", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(stateOf([], { demo: true })));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.equal(app.view().badge, `<span class="badge accent">demo</span>`, "the demo database is said, beside its name");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.equal(app.view().version, "Mason 0.9.0", "the version, as mason status's Mason line says it");
  assert.match(app.view().updated!, /^Updated .* ago$/);
  assert.match(html, /<aside id="sidebar" class="sidebar">\s*<div class="side-head">.*<h1 class="brand">.*<p id="where" class="where"><\/p><span id="badge"><\/span>.*<\/div>\s*<div id="side-body" class="side-body">.*<nav id="nav" class="nav" aria-label="Pages">.*<\/nav>\s*<div class="side-foot"><p id="updated" class="updated" aria-live="polite"><\/p><p id="version" class="version"><\/p><\/div>\s*<\/div>\s*<\/aside>/s,
    "the sidebar: the project at its head, the nav, when it was updated and the version at its foot");
  assert.ok(!/class="topbar"|class="tabs"/.test(html), "no top nav beside it");
  assert.match(html, /<nav id="nav" class="nav" aria-label="Pages"><ul><li><a href=/, "the nav is a list of links: Tab reaches each, Enter follows it");
  assert.match(html, /<\/aside>\s*<div class="scrim" aria-hidden="true"><\/div>\s*<div class="content">\s*<div id="poll"><\/div>\s*<main>/, "the page beside the sidebar");
  assert.match(html, /<section id="page-status" aria-labelledby="status-h">\s*<div class="page-head"><h2 id="status-h">Overview<\/h2><p class="desc">Mason syncs the tables you add from your Postgres, keeps them current, and answers analytics SQL at a Postgres URL of its own\. Here: whether the synced data is ready, how to connect, and what it answered — what <code>mason status<\/code> says\.<\/p>/, "the Overview says what Mason is first, then that it is mason status's");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /--sidebar-w: 232px/, "the sidebar's width, a token");
  assert.match(css, /@media \(min-width: 641px\) and \(max-width: 999px\) \{\s*\.sidebar \{ width: var\(--rail-w\); \}/, "below 1000 px an icon rail");
  assert.match(css, /\.nav a:hover \.label, \.nav a:focus-visible \.label \{ opacity: 1; \}/, "on the rail a label is its icon's tooltip, on hover and on focus");
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.sidebar \{ position: sticky;/, "a phone: a top bar");
  assert.match(css, /\.sidebar\[data-open\] \.side-body \{ display: flex; \}/, "whose menu opens the nav as a sheet");
  assert.match(css, /@media \(prefers-color-scheme: dark\)/, "a dark theme from the system's");
  assert.equal([...css.matchAll(/@font-face/g)].length, 3, "Geist Sans, Geist Mono and the Zilla Slab display face, each its own face");
  assert.doesNotMatch(css, /gradient\(/, "no gradient");
});

test("the vendored files: each a route, whole, pinned in its folder's name, with its licence beside it, listed in the README", async () => {
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts") as { PAGE_ROUTES: Record<string, readonly [string, string]> };
  const vendor = webFiles().filter((f) => f.startsWith(`vendor${path.sep}`)).map((f) => f.split(path.sep).join("/")).sort();
  assert.deepEqual(vendor, ["vendor/README.md", "vendor/geist-1.7.2/Geist-Variable.woff2", "vendor/geist-1.7.2/GeistMono-Variable.woff2", "vendor/geist-1.7.2/LICENSE.txt",
    "vendor/lucide-1.56.0/LICENSE.txt", "vendor/lucide-1.56.0/chart-column.mjs", "vendor/lucide-1.56.0/layout-dashboard.mjs", "vendor/lucide-1.56.0/link.mjs", "vendor/lucide-1.56.0/logs.mjs",
    "vendor/lucide-1.56.0/menu.mjs", "vendor/lucide-1.56.0/panel-top.mjs", "vendor/lucide-1.56.0/square-terminal.mjs", "vendor/lucide-1.56.0/table.mjs", "vendor/lucide-1.56.0/users.mjs", "vendor/lucide-1.56.0/x.mjs",
    "vendor/uplot-1.6.32/LICENSE.txt", "vendor/uplot-1.6.32/uPlot.esm.js", "vendor/uplot-1.6.32/uPlot.min.css",
    "vendor/zilla-slab-5.3.0/LICENSE.txt", "vendor/zilla-slab-5.3.0/zilla-slab-latin-700-normal.woff2"]);
  const types: Record<string, string> = { woff2: "font/woff2", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };
  for (const f of vendor) assert.deepEqual(PAGE_ROUTES[`/${f}`], [f, types[f.split(".").pop()!]], `${f} is a route of its type`);
  const readme = fs.readFileSync(path.join(WEB, "vendor", "README.md"), "utf8");
  const folders = [...new Set(vendor.filter((f) => f.split("/").length === 3).map((f) => f.split("/")[1]!))];
  for (const d of folders) {
    assert.match(d, /^[a-z]+(?:-[a-z]+)*-\d+\.\d+\.\d+$/, `${d}: the package and its exact version`);
    assert.ok(fs.existsSync(path.join(WEB, "vendor", d, "LICENSE.txt")), `${d} carries its licence`);
    assert.ok(readme.includes(`\`${d}/\``), `the README lists ${d}`);
  }
  assert.match(fs.readFileSync(path.join(WEB, "vendor", "geist-1.7.2", "LICENSE.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
  assert.match(fs.readFileSync(path.join(WEB, "vendor", "zilla-slab-5.3.0", "LICENSE.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
  assert.match(fs.readFileSync(path.join(WEB, "vendor", "uplot-1.6.32", "LICENSE.txt"), "utf8"), /The MIT License/);
  assert.match(fs.readFileSync(path.join(WEB, "vendor", "lucide-1.56.0", "LICENSE.txt"), "utf8"), /^ISC License/);
  // each icon, whole as the package built it: its version's licence header, and one SVG in currentColor as its default export
  for (const f of vendor.filter((x) => x.endsWith(".mjs"))) {
    const name = f.split("/").pop()!.replace(/\.mjs$/, "");
    assert.match(fs.readFileSync(path.join(WEB, f), "utf8"), /^\/\*\*\n \* @license lucide-static v1\.56\.0 - ISC\n/, `${f}: the package's own file`);
    const svg = (await import(path.join(WEB, f))).default as string;
    assert.match(svg.trim(), new RegExp(`^<svg\\s+class="lucide lucide-${name}"[^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*>[\\s\\S]*</svg>$`), `${f}: one SVG in currentColor`);
    assert.doesNotMatch(svg, /<script|\son\w+=|href=/i, `${f}: nothing in it runs or links`);
  }
  assert.deepEqual(Object.keys((page as unknown as { ICONS: Record<string, string> }).ICONS).sort(),
    vendor.filter((x) => x.endsWith(".mjs")).map((x) => x.split("/").pop()!.replace(/\.mjs$/, "")).sort(), "every icon vendored is drawn, and only those");
  // a woff2 is a woff2 (its signature), and the module loads under node without a document
  assert.equal(fs.readFileSync(path.join(WEB, "vendor", "zilla-slab-5.3.0", "zilla-slab-latin-700-normal.woff2")).subarray(0, 4).toString("latin1"), "wOF2");
  for (const f of ["Geist-Variable.woff2", "GeistMono-Variable.woff2"]) assert.equal(fs.readFileSync(path.join(WEB, "vendor", "geist-1.7.2", f)).subarray(0, 4).toString("latin1"), "wOF2");
  const uPlot = (await import(path.join(WEB, "vendor", "uplot-1.6.32", "uPlot.esm.js"))).default as { paths?: { bars?: unknown } };
  assert.equal(typeof uPlot, "function");
  assert.equal(typeof uPlot.paths?.bars, "function", "bars, as chartOptions draws them");
  // the policy every file is served under lets them load: fonts and styles from 'self'; uPlot's inline style attributes
  const { SECURITY_HEADERS } = await import("../src/cli/security.ts") as { SECURITY_HEADERS: Record<string, string> };
  const csp = SECURITY_HEADERS["Content-Security-Policy"]!;
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /font-src/, "fonts fall back to default-src 'self'");
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
});

test("a details stays open across a refresh: the request log's rows, Usage's Memory and a copy's whole error, keyed by a stable id", async () => {
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  run.answers.set("GET api/usage?since=15m&step=60", answer(UL_USAGE));
  run.answers.set("GET api/state", answer(FAILED));
  let t = Date.UTC(2026, 9, 28, 9, 5, 0);
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { toggle?: (target: unknown) => unknown }> }>("createApp")(run.fetch, () => new Date(t));
  const opens = (part: string) => [...app.view()[part]!.matchAll(/<details[^>]*data-open="([^"]+)"[^>]* open>/g)].map((m) => m[1]);
  const toggle = (page: string, key: string, open: boolean) => app.pages.get(page)!.toggle!({ dataset: { open: key }, open });
  // the request log: one row opened stays open through the polls that rewrite the log, the other stays closed
  app.show("queries");
  await app.poll();
  assert.deepEqual(opens("request-log"), []);
  assert.equal(toggle("queries", "request:r-old", true), true, "opened: the page is written again");
  assert.deepEqual(opens("request-log"), ["request:r-old"]);
  for (let i = 0; i < 3; i++) { t += 5000; await app.poll(); }
  assert.deepEqual(opens("request-log"), ["request:r-old"], "a poll later, still open");
  assert.equal(toggle("queries", "request:r-old", true), null, "the toggle a rewrite causes itself changes nothing");
  assert.equal(toggle("queries", "request:r-old", false), true);
  assert.deepEqual(opens("request-log"), [], "closed by the person: closed");
  assert.equal(app.pages.get("queries")!.toggle!({ id: "syncs-raw", open: true }), null, "a details with no key is not this page's");
  // Usage's Memory
  app.show("usage");
  await app.poll();
  toggle("usage", "usage-memory", true);
  t += 60_000; await app.poll();
  assert.deepEqual(opens("usage-hourly"), ["usage-memory"]);
  // a copy's whole error on Status
  app.show("status");
  await app.poll();
  toggle("status", "error:public.orders", true);
  t += 2000; await app.poll();
  assert.deepEqual(opens("status"), ["error:public.orders"]);
});

test("in the browser: a details opened stays open when the poll writes its part again", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(FAILED));
  const { el, on, tick, settle } = fakeBrowser(run);
  await settle();
  await on.get("toggle")!({ target: { dataset: { open: "error:public.orders" }, open: true } });
  await settle();
  assert.match(el("status").html, /data-open="error:public\.orders" open>/);
  const writes = el("status").writes;
  run.answers.set("GET api/state", answer({ ...FAILED, warnings: ["mason/sources/shop.yml: tables.other: no such table"] }));
  tick(); await settle();
  assert.ok(el("status").writes > writes && /tables\.other/.test(el("status").html), "the part was written again");
  assert.match(el("status").html, /data-open="error:public\.orders" open>/, "and the details opened is open");
});

test("the charts are an addition: the cards say every number as text, a holder only where two hours can be drawn, and nothing breaks without uPlot", async () => {
  const renderKpis = of<[unknown, unknown], string>(statusPage, "status.js", "renderKpis");
  const sparkSpecs = of<[unknown], Record<string, { kind: string; x: number[]; y: Array<number | null> }>>(statusPage, "status.js", "sparkSpecs");
  const state = { ...SYNCED, engine: { ...SYNCED.engine, bytes: 2_097_152 } };
  const plain = renderKpis(state, { now: NOW, queries: QUERIES });
  const drawn = renderKpis(state, { now: NOW, queries: QUERIES, usage: UL_USAGE });
  assert.equal(textOf(drawn), textOf(plain), "the same words with the charts as without");
  assert.deepEqual([...drawn.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1]), ["rows", "statements"], "a holder only for a series of two values or more (one hour of p95 is no trend)");
  assert.match(drawn, /<div class="chart spark" data-chart="rows" role="img" aria-label="Rows synced, the last 24 hours an hour a point"><\/div>/);
  assert.deepEqual(Object.keys(sparkSpecs(UL_USAGE)), ["rows", "statements"]);
  assert.deepEqual(sparkSpecs(UL_USAGE).statements!.y, [1204, 0]);
  assert.deepEqual(sparkSpecs({ failure: {} }), {}, "a usage that could not be read draws nothing");
  // the options: a sparkline is the trend alone, its latest value the one dot; a series chart has axes and a live read-out
  const chartOptions = charts.chartOptions as unknown as (spec: unknown, theme: unknown, w: number, h: number, u?: unknown) => Record<string, any>;
  assert.equal(typeof chartOptions, "function", "src/web/charts.js exports chartOptions");
  const theme = { trend: "#aaa", mark: "#07f", grid: "#eee", text: "#888", font: "mono" };
  const sp = chartOptions({ kind: "spark", label: "Rows", x: [1, 2, 3], y: [1, null, 3] }, theme, 200, 48);
  assert.equal(sp.legend.show, false); assert.equal(sp.cursor.show, false); assert.deepEqual(sp.axes.map((a: { show: boolean }) => a.show), [false, false]);
  assert.equal(sp.series[1].stroke, "#aaa"); assert.equal(sp.series[1].width, 2); assert.equal(sp.series[1].points.fill, "#07f");
  assert.deepEqual(sp.series[1].points.filter({ data: [[1, 2, 3], [1, 3, null]] }, 1), [1], "the dot on the last value");
  const bars = chartOptions({ kind: "bars", label: "Statements", x: [3600, 7200], y: [1, 2], format: (v: number) => `${v} st` }, theme, 400, 180, { paths: { bars: () => "bars-path" } });
  assert.equal(bars.series[1].paths, "bars-path"); assert.equal(bars.series[1].fill, "#07f"); assert.equal(bars.legend.live, true);
  assert.equal(bars.series[1].value(null, 5), "5 st"); assert.equal(bars.series[0].value(null, 3600), "01:00 UTC", "the hovered hour in UTC, as the tables say it");
  assert.equal(chartOptions({ kind: "bars", label: "x", x: [1, 2], y: [1, 2] }, theme, 1, 1, {}).series[1].paths, undefined, "no bars path: a line");
  // the lifecycle, over a fake document and a fake uPlot: made once per key, data set only when it changed, moved
  // into the holder a rewrite made, destroyed when its holder or key is gone
  const made: Array<{ el: unknown; data: unknown[]; destroyed: boolean; sets: number; root: { moved: number } }> = [];
  class FakePlot {
    root = { moved: 0 }; rec: (typeof made)[number];
    constructor(_o: unknown, data: unknown[], el: unknown) { this.rec = { el, data, destroyed: false, sets: 0, root: this.root }; made.push(this.rec); }
    setData(d: unknown[]) { this.rec.data = d; this.rec.sets++; } setSize() { /* sized by its holder */ } destroy() { this.rec.destroyed = true; }
  }
  const holder = (key: string) => ({ dataset: { chart: key }, clientWidth: 200, clientHeight: 48, appendChild(r: { moved: number }) { r.moved++; } });
  let holders = [holder("rows"), holder("statements")];
  const doc = { documentElement: {}, querySelectorAll: () => holders };
  const win = { getComputedStyle: () => ({ getPropertyValue: () => "" }), console: { warn: () => undefined } };
  const createCharts = charts.createCharts as unknown as (o: unknown) => { mount(s: unknown): Promise<boolean>; count(): number; retheme(): void };
  const c = createCharts({ doc, win, load: async () => FakePlot });
  const specs = sparkSpecs(UL_USAGE);
  assert.equal(await c.mount(specs), true);
  assert.equal(made.length, 2); assert.equal(c.count(), 2);
  await c.mount(specs);
  assert.equal(made.length, 2, "the same data: no new chart"); assert.equal(made[0]!.sets, 0, "and no new data");
  holders = [holder("rows"), holder("statements")];
  await c.mount({ ...specs, rows: { ...specs.rows!, y: [5, 6] } });
  assert.equal(made.length, 2, "a rewrite: the charts are moved, not made again");
  assert.equal(made[0]!.root.moved, 1); assert.equal(made[0]!.sets, 1, "new data: set");
  holders = [holder("rows")];
  await c.mount(specs);
  assert.equal(made[1]!.destroyed, true, "its holder gone: destroyed"); assert.equal(c.count(), 1);
  await c.mount({});
  assert.equal(c.count(), 0, "no spec: none alive — nothing leaks");
  // uPlot does not load: said once, the page untouched, never tried again
  const warned: string[] = [];
  let loads = 0;
  const broken = createCharts({ doc, win: { ...win, console: { warn: (m: string) => warned.push(m) } }, load: async () => { loads++; throw new Error("no such file"); } });
  assert.equal(await broken.mount(specs), false);
  assert.equal(await broken.mount(specs), false);
  assert.equal(loads, 1); assert.equal(warned.length, 1);
  assert.match(warned[0]!, /charts are not drawn \(its numbers are in its tables\): no such file/);
  assert.equal(broken.count(), 0);
});

test("a chart stays in its card: sized to its holder's width when drawn and whenever that width changes (not only the window's resize); its title inside the card, never on its edge", async () => {
  const sized: Array<{ width: number; height: number }> = [];
  let made = 0;
  class FakePlot {
    root = {};
    constructor(o: { width: number; height: number }) { made++; sized.push({ width: o.width, height: o.height }); }
    setData() { /* the same data */ } setSize(s: { width: number; height: number }) { sized.push(s); } destroy() { /* gone */ }
  }
  const el = { dataset: { chart: "usage-statements" }, clientWidth: 488, clientHeight: 0, classList: { add() { /* drawn */ } }, appendChild() { /* moved */ } };
  // a ResizeObserver the test drives: the holder's width changes without any window resize
  let observed: unknown[] = [];
  let notify!: (entries: Array<{ target: unknown }>) => void;
  class FakeObserver { constructor(cb: typeof notify) { notify = cb; } observe(x: unknown) { observed.push(x); } unobserve(x: unknown) { observed = observed.filter((y) => y !== x); } disconnect() { observed = []; } }
  const doc = { documentElement: {}, querySelectorAll: () => [el] };
  const win = { getComputedStyle: () => ({ getPropertyValue: () => "" }), console: { warn: () => undefined }, ResizeObserver: FakeObserver };
  const createCharts = charts.createCharts as unknown as (o: unknown) => { mount(s: unknown): Promise<boolean>; count(): number };
  const c = createCharts({ doc, win, load: async () => FakePlot });
  const spec = { kind: "bars", label: "Statements an hour", x: [3600, 7200, 10_800], y: [1, 2, 3] };
  await c.mount({ "usage-statements": spec });
  assert.equal(made, 1);
  assert.equal(sized[0]!.width, 488, "drawn at its holder's width: the card's content, never wider");
  assert.deepEqual(observed, [el], "its holder watched");
  // the card narrowed (a grid that reflowed, the sidebar become a rail): the chart follows, with no window resize
  el.clientWidth = 312;
  notify([{ target: el }]);
  assert.equal(sized.at(-1)!.width, 312, "re-measured: the chart's width ≤ its card's");
  const n = sized.length;
  notify([{ target: el }]);
  assert.equal(sized.length, n, "the same width: not sized again (no loop with its own height)");
  await c.mount({});
  assert.deepEqual(observed, [], "a chart destroyed: its holder no longer watched");
  // the stylesheet: a chart card's title sits inside it (no negative margin pulling it onto the frame), the grid never
  // asks more than its width, and the chart's holder no wider than the card
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const label = /\.chart-card > \.card-label:first-child \{([^}]*)\}/.exec(css)?.[1] ?? assert.fail("the chart card's title rule");
  assert.ok(!/margin:[^;]*(calc\(\s*-|-1 \*|(^|[\s(])-\d)/.test(label), `the title inside its card, no negative margin: ${label}`);
  assert.match(css, /\.chart-grid \{[^}]*minmax\(min\(420px, 100%\), 1fr\)/, "a column never wider than the page");
  assert.match(css, /\.chart-card \.chart \{ min-width: 0; max-width: 100%; \}/);
});

test("a popover is placed beside its anchor: under it, its right edge on the anchor's, above when no room below, inside the window; hidden when its anchor is gone", () => {
  const placePops = fn<[unknown, unknown], unknown[]>("placePops");
  const pop = (anchor: string) => ({ dataset: { anchor }, offsetWidth: 300, offsetHeight: 120, hidden: false, style: {} as Record<string, string> });
  const rect = (left: number, top: number, w: number, h: number) => ({ getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h }) });
  const anchors: Record<string, unknown> = { a: rect(900, 100, 160, 36), low: rect(900, 760, 160, 36), left: rect(10, 100, 100, 36) };
  const pops = [pop("a"), pop("low"), pop("left"), pop("gone")];
  const doc = { querySelectorAll: () => pops, getElementById: (id: string) => anchors[id] ?? null };
  placePops(doc, { innerWidth: 1280, innerHeight: 900 });
  assert.deepEqual(pops[0]!.style, { left: "760px", top: "140px" }, "under it, right edges aligned");
  assert.deepEqual(pops[1]!.style, { left: "760px", top: "636px" }, "no room below: above it");
  assert.deepEqual(pops[2]!.style, { left: "16px", top: "140px" }, "never past the window's left gutter");
  assert.equal(pops[3]!.hidden, true, "its anchor gone: hidden");
  assert.deepEqual(placePops({}, {}), [], "a document that cannot place one: none");
});

// ------------------------------------------------------------------ the restyled Queries, Usage and Sync events pages (docs/WEB-UI.md "Presentation")

const queriesModule = await import(path.join(WEB, "pages", "queries.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;

test("Usage: the cards under Now say who is connected and what runs, then the range's statements, failed, p95 and sent; a past range its clients; each statement card leads to Queries; an unreadable fact is unknown with its reason", () => {
  const kpis = fnOf<[Record<string, unknown>], string>(usagePage, "renderUsageKpis");
  const sessions = { open: 3, byClient: [{ user: "metabase", client: "Metabase v0.50", open: 2, running: 1 }, { user: "", client: "", open: 1, running: 0 }] };
  const labels = (html: string) => [...html.matchAll(/<p class="card-label">([^<]*)<\/p>/g)].map((m) => m[1]);
  const hrefs = (html: string) => [...html.matchAll(/<a class="card[^"]*" href="([^"]*)">/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  // NOW: six cards — connected and running now, then the last 15 minutes
  const live = kpis({ activity: activityOf(), sessions, running: RUNNING_NOW, range: "now" });
  assert.equal(textOf(live), "Connected now 3 sessions 2 clients Running now 2 the longest for 2 min Statements, last 15 min 1,204 1,190 completed " +
    "Failed, last 15 min 12 10 refused, 2 failed, 2 cancelled p95, last 15 min 900 ms average 120 ms · p50 40 ms Sent, last 15 min 3.0 MiB 52,000 rows");
  assert.deepEqual(labels(live), ["Connected now", "Running now", "Statements, last 15 min", "Failed, last 15 min", "p95, last 15 min", "Sent, last 15 min"]);
  assert.match(live, /^<div class="cards n6">/);
  assert.deepEqual(hrefs(live), ["#observability/queries", "#observability/queries?status=refused-or-failed", "#observability/queries?slow=1"], "each statement card leads to the statements it counts");
  assert.match(kpis({ activity: activityOf(), sessions, running: [], range: "now" }), /Running now<\/p><p class="card-value">0<\/p><p class="card-sub">no statement is running<\/p>/);
  assert.match(live, /<a class="card warn link" href="[^"]*"><p class="card-label">Failed, last 15 min/, "a failure colours the one to act on");
  // the Clients card says the totals over EVERY client, never the 50 the endpoint lists (a card once said 50 of 200)
  assert.match(kpis({ activity: activityOf({ clientsTotal: { clients: 200, sessions: 410 } }), range: "24h" }), /Clients, last 24 hours<\/p><p class="card-value">200<\/p><p class="card-sub">410 sessions<\/p>/);
  const renderClients = fnOf<[unknown[], Record<string, unknown>], string>(usagePage, "renderClients");
  assert.match(textOf(renderClients(CLIENTS, { range: "24h", total: 200 })), new RegExp(`200 clients \\(the ${CLIENTS.length} with the most statements are listed\\) sent statements in the last 24 hours`));
  // A PAST RANGE: five cards — its clients, then its statements; its links keep the range
  const past = kpis({ activity: activityOf(), sessions, running: RUNNING_NOW, range: "24h" });
  assert.deepEqual(labels(past), ["Clients, last 24 hours", "Statements, last 24 hours", "Failed, last 24 hours", "p95, last 24 hours", "Sent, last 24 hours"], "what is connected now is Now's alone");
  assert.match(textOf(past), /^Clients, last 24 hours 2 4 sessions Statements, last 24 hours 1,204 /);
  assert.match(past, /^<div class="cards n5">/);
  assert.deepEqual(hrefs(past), ["#observability/queries?range=24h", "#observability/queries?status=refused-or-failed&range=24h", "#observability/queries?slow=1&range=24h"]);
  assert.match(textOf(kpis({ activity: activityOf(), range: "1h" })), /^Clients, last hour 2 /);
  // not read yet: the cards it has, then a skeleton; unreadable: unknown with its reason
  assert.match(kpis({ activity: undefined, sessions, running: RUNNING_NOW, range: "now" }), /Running now.*<span class="skeleton/s);
  assert.equal(textOf(kpis({ activity: { failure: { code: "failed", message: "no ledger\nmore" } }, sessions: { error: "the listener is closed\nmore" }, range: "now" })),
    "Connected now unknown the listener is closed Statements, last 15 min unknown could not read them: no ledger");
  assert.match(textOf(kpis({ activity: activityOf({ window: { durationMs: null } }), range: "24h" })), /p95, last 24 hours – no statement completed/);
  for (const gone of ["renderQueryKpis", "renderSessions", "renderRunning", "renderUnsupported"]) assert.equal(typeof queriesModule[gone], "undefined", `Queries is the request log alone: no ${gone}`);
});

test("Usage: the cards, who is connected and what runs are written from the range's statements, the state's sessions and the running statements", async () => {
  const run = fakeRun();
  run.answers.set("GET api/running", answer({ running: RUNNING_NOW }));
  run.answers.set("GET api/state", answer({ ...COPYING, sessions: { open: 1, byClient: [{ user: "ana", client: "psql", open: 1, running: 0 }] } }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("usage");
  assert.match(textOf(app.view()["usage-kpis"]!), /Asking Mason/, "before any read");
  await app.poll();
  assert.match(textOf(app.view()["usage-kpis"]!), /^Connected now 1 session 1 client Running now 2 .* Statements, last 15 min 1,204 /);
  assert.match(textOf(app.view()["usage-connected"]!), /^User Client Open Running ana psql 1 0 Queries /);
  assert.match(textOf(app.view()["usage-running"]!), /^Session No\. .* 12 45 .* 13 7 /);
});

test("Usage, a past range: who sent statements in it and the slowest that completed, each leading to its statements on Queries; none is said", () => {
  const renderClients = fn<[unknown[], Record<string, unknown>?], string>("renderClients");
  const renderSlowest = fn<[unknown[], Record<string, unknown>?], string>("renderSlowest");
  const queriesHref = fn<[Record<string, unknown>?, string?], string>("queriesHref");
  const now = Date.parse("2026-10-27T09:05:30.000Z");
  // WHERE A ROW LEADS: Queries filtered so, at the range shown (Now's left out, as the shell's links do)
  assert.equal(queriesHref({}, "now"), "#observability/queries");
  assert.equal(queriesHref({ user: "a b", client: "x&y" }, "24h"), "#observability/queries?user=a+b&client=x%26y&range=24h");
  assert.equal(queriesHref({ slow: "1", status: "", user: undefined }, "1h"), "#observability/queries?slow=1&range=1h", "a blank filter is no filter");
  assert.equal(fnOf<[string?], string>(usagePage, "activityPath")("7d"), "api/activity?since=7d");
  assert.equal(fnOf<[string?], string>(usagePage, "activityPath")(), "api/activity?since=15m", "Now's");
  // the clients: a row each, the most statements first, and Queries
  const clients = renderClients(CLIENTS, { range: "24h", now });
  assert.equal(textOf(clients), "User Client Statements Failed Sessions Last metabase Metabase v0.50 1,100 9 3 30s ago Queries token ci (no application_name) 104 1 60 min ago Queries " +
    "2 clients sent statements in the last 24 hours. A session that sent only what the log does not list (select 1, SET, a catalog query) is not here.");
  assert.match(clients, /<td class="act"><a class="btn small" href="#observability\/queries\?user=metabase&amp;client=Metabase\+v0\.50&amp;range=24h" title="the statements of metabase from Metabase v0\.50 in the last 24 hours">Queries<\/a><\/td>/);
  assert.match(clients, /<time data-tick datetime="2026-10-27T09:05:00.000Z" title="2026-10-27 09:05:00 UTC">30s ago<\/time>/, "when the latest started: how long ago, the UTC time its title");
  assert.equal(textOf(renderClients([], { range: "1h" })), "No client sent a statement the request log lists in the last hour.");
  // past `top`, the others in one row with their sums
  const many = Array.from({ length: 12 }, (_, i) => ({ ...CLIENTS[0]!, user: `u${i}`, statements: 100 - i, failed: 1, sessions: 2 }));
  assert.match(textOf(renderClients(many, { range: "24h", now })), / 2 other clients 179 2 4 12 clients sent statements/);
  // the slowest: when, how long, who from where, the statement, and Queries (the slow ones of its client when it was slow)
  const slow = [{ ...REQUESTS[0]!, durationMs: 4200 }, { ...REQUESTS[0]!, requestId: "r-fast", startedAt: "2026-10-28T09:01:00.000Z", durationMs: 300, rows: null, query: "" }];
  const slowest = renderSlowest(slow, { range: "7d", now: Date.parse("2026-10-28T09:06:00.000Z") });
  assert.equal(textOf(slowest), "Started Took User Client Rows Statement 6 min ago 4,200 ms ana psql 1 SELECT count(*) FROM orders Queries 5 min ago 300 ms ana psql (no statement) Queries");
  assert.match(slowest, /href="#observability\/queries\?user=ana&amp;client=psql&amp;slow=1&amp;range=7d"/, "a slow one: its client's slow statements");
  assert.match(slowest, /href="#observability\/queries\?user=ana&amp;client=psql&amp;range=7d"/, "one under a second: its client's statements");
  assert.match(slowest, /<code class="stmt" title="SELECT count\(\*\) FROM orders">SELECT count\(\*\) FROM orders<\/code>/, "the statement's cell is the request log's (statementCell)");
  assert.equal(textOf(renderSlowest([], { range: "24h" })), "No statement completed in the last 24 hours.");
});

test("Usage: the cards are the range's, with a sparkline each where two samples can be drawn; their numbers are text either way", () => {
  const kpis = fnOf<[Record<string, unknown>], string>(usagePage, "renderUsageKpis"), specs = fnOf<[unknown], Record<string, { kind: string; x: number[]; y: Array<number | null> }>>(usagePage, "usageSpecs");
  const plain = kpis({ activity: activityOf(), range: "24h" }), drawn = kpis({ activity: activityOf(), usage: UL_USAGE, range: "24h" });
  assert.equal(textOf(plain), "Clients, last 24 hours 2 4 sessions Statements, last 24 hours 1,204 1,190 completed Failed, last 24 hours 12 10 refused, 2 failed, 2 cancelled p95, last 24 hours 900 ms average 120 ms · p50 40 ms Sent, last 24 hours 3.0 MiB 52,000 rows");
  assert.equal(textOf(drawn), textOf(plain), "the same words with the charts as without");
  assert.deepEqual([...drawn.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1]), ["usage-spark-statements", "usage-spark-failed", "usage-spark-bytes"], "no sparkline for one hour of p95");
  assert.match(drawn, /data-chart="usage-spark-statements" [^>]*aria-label="Statements, the last 24 hours an hour a point"/, "the sparkline names its span and step");
  assert.deepEqual(specs(UL_USAGE)["usage-spark-failed"]!.y, [3, 0], "the failed ones are the samples' refused and failed");
  assert.deepEqual(specs(undefined), {}); assert.deepEqual(specs({ failure: {} }), {});
});

test("Usage: four charts of the hours — statements as bars, p95, the copy's size and its rows as lines — each its own series, its numbers the hours' table", () => {
  const specs = fnOf<[unknown], Record<string, { kind: string; label: string; x: number[]; y: Array<number | null>; format(v: number): string }>>(usagePage, "usageSpecs");
  const renderCharts = fnOf<[unknown], string>(usagePage, "renderCharts"), renderUsage = fnOf<[unknown, ((k: string) => boolean)?], string>(usagePage, "renderUsage");
  assert.deepEqual(Object.keys(specs(UL_USAGE)).filter((k) => !k.includes("spark")), ["usage-statements", "usage-copy-rows"], "p95 and the copy's size have one value in two hours: no trend, no chart");
  const s = specs({ ...UL_USAGE, samples: [SAMPLE, { ...IDLE, copyBytes: 6 * 2 ** 30, durationP95Ms: 40 }] });
  assert.deepEqual(Object.keys(s).filter((k) => !k.includes("spark")), ["usage-statements", "usage-p95", "usage-copy-bytes", "usage-copy-rows"], "in the page's order");
  assert.equal(s["usage-p95"]!.format(1830.4), "1,830 ms");
  assert.equal(s["usage-statements"]!.kind, "bars"); assert.deepEqual(s["usage-statements"]!.y, [1204, 0]);
  assert.equal(s["usage-copy-bytes"]!.kind, "line"); assert.equal(s["usage-copy-bytes"]!.format(3 * 2 ** 30), "3.0 GiB", "a value as the tables say it");
  assert.deepEqual(s["usage-copy-rows"]!.y, [12_345_678, 12_345_678]);
  assert.deepEqual(s["usage-statements"]!.x, [Date.parse(SAMPLE.at) / 1000, Date.parse(IDLE.at) / 1000]);
  const html = (renderCharts as unknown as (u: unknown, r?: string) => string)(UL_USAGE, "24h");
  assert.deepEqual([...html.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1]), ["usage-statements", "usage-copy-rows"]);
  assert.match(renderCharts(UL_USAGE), /aria-label="Statements an hour, the last 15 minutes"/, "the range's span in the label: Now's by default");
  assert.match(html, /<div class="chart-card"><p class="card-label" title="Statements an hour">Statements an hour<\/p><div class="chart series" data-chart="usage-statements" role="img" aria-label="Statements an hour, the last 24 hours"><\/div><\/div>/);
  // a series with one value is no trend: its card says the value, so the grid keeps its four cards
  assert.match(textOf(html), /p95 duration One sample so far: 1,830 ms\. A chart needs two\./);
  assert.match(textOf(html), /Size of the synced data One sample so far: 5\.0 GiB\. A chart needs two\./);
  assert.equal([...html.matchAll(/<div class="chart-card/g)].length, 4);
  assert.doesNotMatch(renderCharts({ ...UL_USAGE, samples: [SAMPLE] }), /data-chart=/, "one hour is no trend: no chart");
  assert.equal(renderCharts({ ...UL_USAGE, samples: [] }), "", "no sample: no chart cards (the table says none)");
  assert.equal(renderCharts(undefined), "");
  // the hours' numbers sit behind a closed details once there are charts, keyed so a poll keeps it open; plain with none
  const closed = renderUsage(UL_USAGE);
  assert.match(closed, /<details class="hours" data-open="usage-hours"><summary>The numbers, an hour a line<\/summary>/);
  assert.match(renderUsage(UL_USAGE, (k) => k === "usage-hours"), /<details class="hours" data-open="usage-hours" open>/);
  assert.doesNotMatch(renderUsage({ ...UL_USAGE, samples: [SAMPLE] }), /usage-hours/, "with no chart the hours are the page's content");
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [SAMPLE] })), /Time \(UTC\) ↓ Statements Errors .* 2026-10-28 09:05 1,204 3 /);
});

test("Usage: the page hands its charts to the shell from the hours it read, and keeps the hours' details open across polls", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  const app = fn<[unknown], App & { pages: Map<string, { charts(): Record<string, unknown>; toggle(t: unknown): unknown }> }>("createApp")(run.fetch);
  app.show("usage");
  assert.deepEqual(app.pages.get("usage")!.charts(), {}, "nothing read: nothing to draw");
  await app.poll();
  assert.ok("usage-statements" in app.pages.get("usage")!.charts() && "usage-spark-statements" in app.pages.get("usage")!.charts());
  assert.match(textOf(app.view()["usage-kpis"]!), /^Connected now .* Statements, last 15 min 1,204 /);
  assert.match(app.view()["usage-charts"]!, /data-chart="usage-copy-rows"/);
  assert.equal(app.pages.get("usage")!.toggle({ dataset: { open: "usage-hours" }, open: true }), true);
  await app.poll();
  assert.match(app.view()["usage-hourly"]!, /data-open="usage-hours" open>/);
  const keys = [...Object.keys(app.pages.get("usage")!.charts()), ...Object.keys(app.pages.get("status")!.charts?.() ?? {})];
  assert.equal(new Set(keys).size, keys.length, "a chart key is one holder's in the whole document");
});

test("Sync events: the page and mason logs --events say what the list leaves out, in one sentence; a manual sync's kind is good news", () => {
  // a scheduled poll that succeeds is no event: the page that lists them says so, as mason logs --help does (one sentence)
  const leaveOut = (commands as Record<string, unknown>).EVENTS_LEAVE_OUT as string | undefined;
  assert.equal(typeof leaveOut, "string", "src/cli/commands.ts exports EVENTS_LEAVE_OUT");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const desc = /<h2 id="syncs-h">Sync events<\/h2>.*?<p class="desc">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
  assert.ok(desc.endsWith(` ${leaveOut!}`), `the page's description ends with it: ${desc}`);
  assert.match(desc, /each sync asked by hand/);
  const help = commands.LOGS.usage.replace(/\s+/g, " ");
  assert.ok(help.includes(leaveOut!), "mason logs --help says the same sentence");
  assert.match(help, /each sync asked by hand \(mason sync, the page's Sync now\) and what it did/);
  assert.match(html, /<a href="#observability\/syncs"><span class="label">Sync events<\/span><\/a>/, "the nav names the page Sync events; its route is unchanged");
  // a synced event is good news, as copied and recovered are
  const renderEvents = of<[unknown], string>(syncsPage, "syncs.js", "renderEvents");
  const row = renderEvents({ events: [{ at: "2026-10-27T09:04:00.000Z", kind: "synced", failed: false, table: "public.orders", message: "synced by hand: 3 changed, 0 deleted, 1,200 rows now · 41 ms" }], keptDays: 7 });
  assert.match(row, /<span class="badge ok">synced<\/span>/);
  assert.match(textOf(row), /synced public\.orders synced by hand: 3 changed, 0 deleted, 1,200 rows now · 41 ms/);
});

test("Sync events: 'Failures only' narrows the events read, in the page alone; the events' kinds are badges and their times how long ago", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.parse("2026-10-28T09:10:00.000Z");
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { input(t: unknown): unknown }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("syncs");
  await app.poll();
  assert.match(textOf(app.view()["syncs-events"]!), /^When ↓ Kind Table Message 5 min ago ✗ restart .* ✗ copy_failed .* 10 min ago copied public\.orders/);
  // the kind and table filters: EVERY kind, and the sync and EVERY added table, whatever the range read (the state
  // read here names customers, orders and events; public.events has events, public.customers none)
  assert.equal(textOf(app.view()["syncs-filters"]!), "Kind Every kind copy_failed poll_failed catch_up_failed stream_failed source_unreachable generated_failed compact_failed restart copied recovered synced sync_changed Table Every table (the sync) public.customers public.events public.orders");
  assert.equal(app.pages.get("syncs")!.input({ id: "syncs-kind", value: "copy_failed" }), true);
  assert.match(app.view()["syncs-filters"]!, /<option value="copy_failed" selected>/);
  assert.match(textOf(app.view()["syncs-events"]!), /^1 of the 3 events read\. When ↓ Kind Table Message 9 min ago ✗ copy_failed/);
  app.pages.get("syncs")!.input({ id: "syncs-kind", value: "" });
  run.asked.length = 0;
  assert.equal(app.pages.get("syncs")!.input({ id: "syncs-failures-only", checked: true }), true);
  assert.doesNotMatch(textOf(app.view()["syncs-events"]!), /copied public\.orders/);
  assert.match(textOf(app.view()["syncs-events"]!), /✗ copy_failed/);
  assert.deepEqual(run.asked, [], "the page alone: nothing is asked");
  assert.equal(app.pages.get("syncs")!.input({ id: "somewhere-else", checked: true }), null, "another input is not this page's");
  app.pages.get("syncs")!.input({ id: "syncs-failures-only", checked: false });
  assert.match(textOf(app.view()["syncs-events"]!), /copied public\.orders/);
  t += 60_000; await app.poll();
  assert.match(textOf(app.view()["syncs-events"]!), /11 min ago/, "the ages move with the clock");
});

test("Queries, Usage and Sync events: the index.html carries the parts the restyled pages write — a header each, the filter toolbar, the failures toggle", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const id of ["usage-kpis", "usage-charts"]) assert.match(html, new RegExp(`<div id="${id}"></div>`), id);
  assert.ok(!html.includes('id="queries-kpis"'), "Queries has no cards: they are Usage's");
  for (const [id, title, range] of [["queries-h", "Queries", "queries"], ["usage-h", "Usage", "usage"], ["syncs-h", "Sync events", "syncs"]]) assert.match(html, new RegExp(`<div class="page-head"><div class="head-row"><h2 id="${id}">${title}</h2><div id="range-${range}" class="head-range"></div></div><p class="desc">`), `${title}'s header`);
  assert.match(html, /<form id="request-filters" class="toolbar"[^>]*>[\s\S]*<button type="submit" class="primary">Filter<\/button>\s*<button type="button" data-clear-filters>Clear<\/button>/);
  assert.match(html, /<input type="checkbox" id="syncs-failures-only"> Failures only/);
  const view = (ids: string[]) => ids.every((id) => html.includes(`id="${id}"`));
  assert.ok(view(["request-log", "usage-kpis", "usage-charts", "usage-connected", "usage-running", "unsupported", "usage-hourly", "usage-sizes", "syncs-events", "syncs-run"]));
});

// ------------------------------------------------------------------ Observability: the shared range, sorts, filters, and large data

type ObsApp = QueriesApp & { pages: Map<string, { input?(t: unknown): unknown; click?(d: Record<string, string>, b: unknown, env: unknown): unknown; route?(p: Record<string, string>, env: unknown): unknown }>; sortRequests(key: string): void };

test("the shared range: each Observability view reads its span — the request log's since, the samples' window and step, the events' since — and only the view shown reads", async () => {
  const run = fakeRun();
  const empty = { requests: [], keptDays: 7, before: null };
  for (const r of ["1h", "24h", "7d"]) {
    run.answers.set(`GET api/requests?since=${r}`, answer(empty));
    run.answers.set(`GET api/events?limit=500&since=${r}`, answer(EVENTS));
  }
  for (const [since, step] of [["15m", 60], ["1h", 60], ["24h", 3600], ["7d", 21_600]]) run.answers.set(`GET api/usage?since=${since}&step=${step}`, answer({ ...USAGE, stepSeconds: step }));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], ObsApp>("createApp")(run.fetch, () => new Date(t));
  const asked = async (hash: string) => { app.show(hash); t += 120_000; run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.ok((await asked("#observability/queries?range=1h")).includes("GET api/requests?since=1h"), "Queries: the last hour's requests");
  assert.ok((await asked("#observability/usage?range=1h")).includes("GET api/usage?since=1h&step=60"), "Usage: the hour, a minute a point");
  assert.ok((await asked("#observability/usage?range=1h")).includes("GET api/activity?since=1h"), "Usage: the hour's statements");
  assert.deepEqual(await asked("#observability/syncs?range=1h"), ["GET api/events?limit=500&since=1h", "GET api/state"], "Sync events: the hour's events, and nothing of the other views (the state is the sidebar's, once a minute)");
  assert.ok((await asked("#observability/usage?range=7d")).includes("GET api/usage?since=7d&step=21600"), "the week, six hours a point");
  const now = await asked("#observability/usage");
  assert.ok(now.includes("GET api/usage?since=15m&step=60") && now.includes("GET api/activity?since=15m"), "no range: Now, the last 15 minutes a minute a point");
  // a page of its own keeps the range it does not use; going back to a sub-tab with no range is the default again
  app.show("#tables"); assert.equal(app.model.range, "now");
  app.show("#observability/syncs?range=7d"); app.show("#users"); assert.equal(app.model.range, "7d", "the range is Observability's: Users leaves it");
  app.show("#observability/syncs?range=nonsense"); assert.equal(app.model.range, "now", "an unknown range is the default");
  // each view says its span: the cards, the empty log, the empty events
  app.show("#observability/usage?range=7d"); t += 120_000; await app.poll();
  assert.match(textOf(app.view()["usage-kpis"]!), /Statements, last 7 days 1,204 /, "the week's cards are the week's window");
  app.show("#observability/queries?range=7d"); t += 120_000; await app.poll();
  assert.match(textOf(app.view()["request-log"]!), /No request in the last 7 days \(the request log keeps 7 days/);
  app.show("#observability/usage?range=1h"); await app.poll();
  assert.match(textOf(app.view()["usage-kpis"]!), /Statements, last hour 1,204 /, "the hour's cards say the hour, by name");
});

test("Queries: Slow (1 s or more) and Statement has are the request log's slow and search, composing with the rest; the Overview's links land on them", async () => {
  const { SLOW_MS } = await import("../src/cli/request-filter.ts");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.match(html, new RegExp(`<input type="checkbox" id="rq-slow" name="slow"> Slow \\(${SLOW_MS / 1000} s or more\\)</label>`), "the label is SLOW_MS's");
  assert.match(html, /<input id="rq-search" name="search" type="search" maxlength="200"/);
  const requestsPath = fnOf<[Record<string, unknown>, string | null, string?], string>(queriesModule, "requestsPath");
  assert.equal(requestsPath({ status: "refused-or-failed", slow: true, search: "from orders", user: "ana" }, null, "1h"), "api/requests?outcome=refused%2Cfailed&since=1h&user=ana&slow=1&search=from+orders");
  assert.equal(requestsPath({ since: "2026-10-28" }, "C~1", "1h"), "api/requests?since=2026-10-28&before=C%7E1", "a since of its own is used instead of the range");
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m&slow=1", answer({ requests: [REQUESTS[0]], keptDays: 7, before: null }));
  run.answers.set("GET api/requests?outcome=refused%2Cfailed&since=15m", answer({ requests: [failedRequest], keptDays: 7, before: null }));
  const app = fn<[unknown], ObsApp>("createApp")(run.fetch);
  // the Overview's p95 card leads to the slow ones; its query errors to the failed ones; the form shows each
  const form = { elements: { status: { value: "" }, since: { value: "" }, user: { value: "" }, client: { value: "" }, search: { value: "" }, slow: { checked: false } } };
  const doc = { getElementById: (id: string) => id === "request-filters" ? form : null };
  app.show("#observability/queries?slow=1", { doc });
  assert.equal(form.elements.slow.checked, true, "the box is ticked");
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET api/requests?since=15m&slow=1"), run.asked.join("\n"));
  app.show("#observability/queries?status=refused-or-failed", { doc });
  assert.deepEqual([form.elements.status.value, form.elements.slow.checked], ["refused-or-failed", false]);
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET api/requests?outcome=refused%2Cfailed&since=15m"));
  // Usage's rows lead here by user and client (and the range they were of): the form shows them, the log is read by them
  run.answers.set("GET api/requests?since=24h&user=metabase&client=Metabase+v0.50&slow=1", answer({ requests: [REQUESTS[1]], keptDays: 7, before: null }));
  app.show("#observability/queries?user=metabase&client=Metabase+v0.50&slow=1&range=24h", { doc });
  assert.deepEqual([form.elements.user.value, form.elements.client.value, form.elements.status.value, form.elements.slow.checked], ["metabase", "Metabase v0.50", "", true]);
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET api/requests?since=24h&user=metabase&client=Metabase+v0.50&slow=1"), run.asked.join("\n"));
  assert.match(textOf(app.view()["request-log"]!), /r-new/);
  app.show("#observability/queries?status=refused-or-failed", { doc });
  assert.deepEqual([form.elements.user.value, form.elements.client.value], ["", ""], "a link without them clears them");
  app.show("#observability/queries?range=7d");
  assert.equal((app.pages.get("queries") as unknown as { model: { filters: { status: string } } }).model.filters.status, "refused-or-failed", "a change of range keeps the filters");
  // the form's slow box and search field are sent
  run.answers.set("GET api/requests?since=7d&slow=1&search=sum%28", answer({ requests: [], keptDays: 7, before: null }));
  const submitted = { id: "request-filters", elements: { status: { value: "" }, since: { value: "" }, user: { value: "" }, client: { value: "" }, slow: { checked: true }, search: { value: " sum( " } } };
  run.asked.length = 0;
  await (app.pages.get("queries") as unknown as { submit(f: unknown): Promise<void> }).submit(submitted);
  assert.deepEqual(run.asked, ["GET api/requests?since=7d&slow=1&search=sum%28"]);
  assert.match(textOf(app.view()["request-log"]!), /No request that passes the filters/);
  // the Overview's cards are links into the views that list what they count
  const html2 = renderStatusOf(FAILED);
  for (const [label, href] of [["Tables synced", "#tables?show=failed"], ["Rows", "#tables"], ["The synced data&#39;s file", "#observability/usage?range=24h"], ["Statements, last day", "#observability/queries?range=24h"], ["p95, last day", "#observability/queries?slow=1&amp;range=24h"]]) {
    // each at the range of what it counts (the last day), never the views' default, Now
    assert.match(html2, new RegExp(`<a class="card[^"]*" href="${href!.replace(/[?]/g, "\\?")}"><p class="card-label">${label!.replace(/[()]/g, "\\$&")}</p>`), `${label} → ${href}`);
  }
  assert.match(html2, /Sync errors .*<a class="see" href="#observability\/syncs\?failures=1&amp;range=7d">See all<\/a>/);
  assert.match(html2, /Query errors .*<a class="see" href="#observability\/queries\?status=refused-or-failed&amp;range=24h">See all<\/a>/);
});
const renderStatusOf = (s: RunState) => fn<[unknown, Record<string, unknown>], string>("renderStatus")(s, { queries: QUERIES, events: EVENTS, requests: FAILED_REQUESTS, now: NOW });

test("Tables: #tables?show=failed is the Failed filter — the failed copies alone — and the select says so", async () => {
  const app = fn<[unknown], ObsApp>("createApp")(fakeRun().fetch);
  const select = { value: "all" };
  app.show("#tables?show=failed", { doc: { getElementById: (id: string) => id === "tables-show" ? select : null } });
  assert.equal(select.value, "failed");
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const names = (html: string) => [...html.matchAll(/<th scope="row" class="name"><code class="name" title="[^"]*">([^<]*)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(names(renderTables(SYNCED, { show: "failed" })), ["public.orders"], "its poll failed");
  assert.match(textOf(renderTables(RUNNING, { show: "failed" })), /No failed table\./);
});

test("sorting: the request log by started, duration or rows (the page shown, said so), the events and the samples by time; each header a button with aria-sort", async () => {
  const sortTh = fn<[string, string, string, { key: string; dir: string }, string?], string>("sortTh");
  assert.equal(sortTh("requests", "duration", "Duration", { key: "duration", dir: "asc" }, "num"),
    `<th scope="col" aria-sort="ascending" class="num"><button type="button" class="sort on" data-sort-table="requests" data-sort-key="duration">Duration<span class="arrow" aria-hidden="true">↑</span></button></th>`);
  assert.match(sortTh("requests", "rows", "Rows", { key: "duration", dir: "asc" }), /aria-sort="none".*↕/);
  const nextSort = fn<[{ key: string; dir: string }, string, string?], { key: string; dir: string }>("nextSort");
  assert.deepEqual([nextSort({ key: "started", dir: "desc" }, "started"), nextSort({ key: "started", dir: "desc" }, "duration"), nextSort({ key: "duration", dir: "desc" }, "duration")],
    [{ key: "started", dir: "asc" }, { key: "duration", dir: "desc" }, { key: "duration", dir: "asc" }]);
  const sortedBy = fn<[unknown[], (x: { v: number | null }) => number | null, string], Array<{ v: number | null }>>("sortedBy");
  assert.deepEqual(sortedBy([{ v: 2 }, { v: null }, { v: 1 }, { v: 3 }], (x) => x.v, "asc").map((x) => x.v), [1, 2, 3, null], "a value the row has not is last, either way");
  assert.deepEqual(sortedBy([{ v: 2 }, { v: null }, { v: 1 }, { v: 3 }], (x) => x.v, "desc").map((x) => x.v), [3, 2, 1, null]);
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const page3 = { requests: [REQUESTS[0], REQUESTS[1], { ...REQUESTS[0], requestId: "r-mid", startedAt: "2026-10-28T09:00:30.000Z", durationMs: 5, rows: 900 }], keptDays: 7, before: "C~1" };
  const ids = (html: string) => [...html.matchAll(/<summary>(r-[a-z]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(ids(renderRequests({ ...page3, requests: [REQUESTS[0], page3.requests[2], REQUESTS[1]] })), ["r-new", "r-mid", "r-old"], "newest first: the page as the server gave it, the other way round");
  assert.deepEqual(ids(renderRequests(page3, { sort: { key: "duration", dir: "desc" } })), ["r-new", "r-old", "r-mid"]);
  assert.deepEqual(ids(renderRequests(page3, { sort: { key: "rows", dir: "desc" } })), ["r-mid", "r-old", "r-new"], "the cancelled one has no rows: last");
  assert.match(textOf(renderRequests(page3, { sort: { key: "duration", dir: "asc" } })), /Sorted by duration, lowest first, within the 3 rows of this page: Older and Newest page by start time\. Older$/);
  assert.doesNotMatch(renderRequests(page3), /sort-note/, "newest first is the log's own order: nothing to say");
  // the header clicked in the app: the page's state, written again
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m", answer(page3));
  const app = fn<[unknown], ObsApp>("createApp")(run.fetch);
  app.show("queries"); await app.poll();
  assert.equal(app.pages.get("queries")!.click!({ sortTable: "requests", sortKey: "duration" }, null, { doc: {} }), true);
  assert.deepEqual(ids(app.view()["request-log"]!), ["r-new", "r-old", "r-mid"]);
  assert.match(app.view()["request-log"]!, /aria-sort="descending"[^>]*><button[^>]*data-sort-key="duration"/);
  run.asked.length = 0; await app.poll();
  assert.deepEqual(ids(app.view()["request-log"]!), ["r-new", "r-old", "r-mid"], "a poll keeps the order");
  assert.ok(!run.asked.some((a) => a.includes("sort")), "the sort is the page's: nothing asked of it");
});

/** 800 tables in 40 schemas, each name 60 characters with its schema, a few added: a large catalog, long names. */
function bigCatalog(count = 800): RunState {
  const tables: SourceTable[] = Array.from({ length: count }, (_, i) => {
    const schema = `analytics_warehouse_${String(i % 40).padStart(2, "0")}`;
    const name = `fact_customer_order_line_items_${String(i).padStart(4, "0")}`.padEnd(60 - schema.length - 1, "x");
    return { ...table(name, i * 1000), source: `${schema}.${name}`, schema, table: name };
  });
  return stateOf([], { tables });
}

test("large data: 800 tables of 60-character names — 100 rows written, Show more and Show all, the search over every one at once, a long name cut with its whole the title", async () => {
  const big = bigCatalog();
  assert.equal(big.tables.length, 800);
  assert.ok(big.tables.every((t) => t.table.length === 60), "each name 60 characters with its schema");
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const rows = (html: string) => [...html.matchAll(/<tr class="c-/g)].length;
  const t0 = performance.now();
  const first = renderTables(big);
  const ms = performance.now() - t0;
  assert.equal(rows(first), 100, "the first 100");
  assert.match(textOf(first), /Showing 100 of 800\. Show 100 more Show all 800/);
  assert.match(first, /<button type="button" class="small" data-show-more="tables">Show 100 more<\/button> <button type="button" class="small" data-show-all="tables">Show all 800<\/button>/);
  assert.ok(ms < 250, `written in ${ms.toFixed(0)} ms`);
  assert.equal(rows(renderTables(big, { limit: 200 })), 200);
  assert.equal(rows(renderTables(big, { limit: Infinity })), 800);
  assert.doesNotMatch(renderTables(big, { limit: Infinity }), /data-show-more/);
  const t1 = performance.now();
  const found = renderTables(big, { filter: "_0799" });
  assert.ok(performance.now() - t1 < 100, "the search is instant");
  assert.equal(rows(found), 1, "the search is over all 800, not the 100 written");
  assert.match(found, /<code class="name" title="analytics_warehouse_39\.fact_customer_order_line_items_0799x*">/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /code\.name \{[^}]*max-width: 36ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap/, "a long name is cut, never widening the page");
  // in the app: Show more, Show all, and a new search starts from the first 100 again
  const run = fakeRun();
  run.answers.set("GET api/state", answer(big));
  const app = fn<[unknown], ObsApp>("createApp")(run.fetch);
  app.show("tables"); await app.poll();
  const tp = app.pages.get("tables")!;
  assert.equal(rows(app.view().tables!), 100);
  tp.click!({ showMore: "tables" }, null, {}); assert.equal(rows(app.view().tables!), 200);
  tp.click!({ showAll: "tables" }, null, {}); assert.equal(rows(app.view().tables!), 800);
  tp.input!({ id: "tables-filter", value: "fact" }); assert.equal(rows(app.view().tables!), 100, "a new search: the first 100 of what passes");
});

test("large data: 200 clients connected — the 10 with the most sessions, then one row for the others, their sums; a long name cut with its whole the title", () => {
  const renderSessions = fn<[unknown], string>("renderSessions");
  const byClient = Array.from({ length: 200 }, (_, i) => ({ user: `user_${i}`, client: `${"a-very-long-application-name-".repeat(3)}${i}`, open: i === 150 ? 500 : (i % 7) + 1, running: i % 2 }));
  const html = renderSessions({ open: byClient.reduce((a, c) => a + c.open, 0), byClient });
  assert.equal([...html.matchAll(/<tr>/g)].length, 10 + 1, "a header and the top 10");
  assert.match(textOf(html), /^User Client Open Running user_150 /, "the most sessions first");
  const rest = [...byClient].sort((a, b) => b.open * 1e6 + b.running - (a.open * 1e6 + a.running)).slice(10);
  assert.match(textOf(html), new RegExp(`190 other clients ${rest.reduce((a, c) => a + c.open, 0).toLocaleString("en-US")} ${rest.reduce((a, c) => a + c.running, 0)} `));
  assert.match(textOf(html), /sessions open, from 200 clients\.$/);
  assert.match(html, /<span class="clip" title="a-very-long-application-name-a-very-long/);
});

test("large data: a 64 KiB statement — one line in its cell, a title of at most 1,000 characters, its expanded row the first 16 KiB and said so; 10,000 requests paged 40 at a time", async () => {
  const huge = `SELECT ${"some_column_name, ".repeat(3800)}1 FROM orders`;
  assert.ok(huge.length >= 64 * 1024);
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const r = { ...REQUESTS[0], query: huge, message: "x".repeat(70_000) };
  const closed = renderRequests({ requests: [r], keptDays: 7, before: null });
  assert.ok(closed.length < 6000, `closed, the row is small: ${closed.length} characters`);
  const title = /<code class="stmt" title="([^"]*)">([^<]*)<\/code>/.exec(closed)!;
  assert.ok(title[1]!.length <= 1000 && title[1]!.endsWith("…"), "the title is cut");
  assert.ok(title[2]!.length <= 120, "the cell is one line, as mason logs cuts it");
  const open = renderRequests({ requests: [r], keptDays: 7, before: null }, { isOpen: () => true });
  const pre = /<pre class="stmt">([^<]*)<\/pre>/.exec(open)!;
  assert.equal(pre[1]!.length, 16 * 1024, "the first 16 KiB");
  assert.match(textOf(open), /the first 16\.0 KiB of 66\.\d KiB: mason logs --requests --json has it whole/);
  assert.ok(open.length < 60_000, "never the whole statement, nor the whole error");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /code\.stmt[^{]*\{[^}]*-webkit-line-clamp: 2/, "a cell clamps to two lines");
  // 10,000 requests: the page asks for one page (the server's 40), and Older walks back by the cursor
  const all = Array.from({ length: 10_000 }, (_, i) => ({ ...REQUESTS[0], requestId: `q-${String(i).padStart(5, "0")}`, startedAt: new Date(Date.UTC(2026, 9, 28) - (10_000 - i) * 1000).toISOString() }));
  const asked: string[] = [];
  const fetch = async (p: string) => {
    asked.push(p);
    if (p.startsWith("api/requests")) {
      const before = new URLSearchParams(p.split("?")[1]).get("before");
      const end = before === null ? all.length : Number(before);
      return new Response(JSON.stringify({ requests: all.slice(Math.max(0, end - 40), end), keptDays: 7, before: end - 40 > 0 ? String(end - 40) : null }));
    }
    return fakeRun().fetch(p);
  };
  const app = fn<[unknown], ObsApp>("createApp")(fetch);
  app.show("queries"); await app.poll();
  const ids = () => [...app.view()["request-log"]!.matchAll(/<summary>(q-\d+)<\/summary>/g)].map((m) => m[1]);
  assert.equal(ids().length, 40);
  assert.deepEqual([ids()[0], ids()[39]], ["q-09999", "q-09960"], "the newest page, newest first");
  assert.ok(!asked.some((p) => /limit=/.test(p)), "the page never asks for more than the server's page");
  await app.olderRequests();
  assert.deepEqual([ids()[0], ids()[39]], ["q-09959", "q-09920"]);
});

test("large data: 500 sync events — the 100 newest written, Show more; a 7-day window of samples with a spike — every point kept, the axis from zero, its labels days", () => {
  const renderEvents = fnOf<[unknown, Record<string, unknown>?], string>(syncsPage, "renderEvents");
  const events = Array.from({ length: 500 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 21) + i * 1200_000).toISOString(), kind: i % 10 ? "copied" : "poll_failed", failed: i % 10 === 0,
    table: `analytics_warehouse_${i % 40}.fact_customer_order_line_items_${i}`, message: `m${i}` }));
  const html = renderEvents({ events, keptDays: 7 });
  assert.equal([...html.matchAll(/<tr/g)].length, 1 + 100);
  assert.match(textOf(html), /Showing 100 of 500\. Show 100 more Show all 500$/);
  assert.match(textOf(html), /^When ↓ Kind Table Message \S+ \S+ ago poll_failed|^When ↓ Kind Table Message .* m499 /, "the newest first");
  assert.equal([...renderEvents({ events, keptDays: 7 }, { limit: Infinity }).matchAll(/<tr/g)].length, 501);
  // a week, six hours a point, with one spike a thousand times the rest
  const usageSpecs = fnOf<[unknown], Record<string, { x: number[]; y: number[]; unit: string; label: string }>>(usagePage, "usageSpecs");
  const week = Array.from({ length: 28 }, (_, i) => ({ ...SAMPLE, at: new Date(Date.UTC(2026, 9, 21) + i * 21_600_000).toISOString(), statements: i === 13 ? 1_000_000 : 1000 + i,
    copyBytes: 2 ** 40 * 3 + i * 2 ** 30, durationP95Ms: i === 5 ? 120_000 : 40 }));
  const s = usageSpecs({ ...UL_USAGE, stepSeconds: 21_600, samples: week });
  assert.equal(s["usage-statements"]!.y.length, 28, "every point, the spike among them: nothing dropped or clipped");
  assert.equal(s["usage-statements"]!.label, "Statements every 6 hours");
  assert.deepEqual([s["usage-copy-bytes"]!.unit, s["usage-p95"]!.unit, s["usage-statements"]!.unit], ["bytes", "ms", "count"]);
  const chartOptions = charts.chartOptions as unknown as (spec: unknown, theme: unknown, w: number, h: number, u?: unknown) => Record<string, any>;
  const theme = { trend: "#aaa", mark: "#07f", grid: "#eee", text: "#888", font: "mono" };
  const o = chartOptions({ kind: "line", ...s["usage-copy-bytes"], format: (v: number) => String(v) }, theme, 480, 160);
  assert.deepEqual(o.scales.y.range(null, 0, 2 ** 40 * 4), [0, 2 ** 40 * 4 * 1.08], "from zero, a little over the highest");
  assert.deepEqual(o.axes[1].values(null, [0, 2 ** 40, 2 * 2 ** 40]), ["0 B", "1 TiB", "2 TiB"]);
  assert.deepEqual(o.axes[0].values(null, [Date.UTC(2026, 9, 21) / 1000, Date.UTC(2026, 9, 21, 12) / 1000, Date.UTC(2026, 9, 22) / 1000]), ["Oct 21", "12:00", "Oct 22"], "a week's ticks are its days");
  assert.equal(o.axes[0].space, 72, "ticks at least 72 px apart: no two labels touch");
  assert.equal(Math.min(...o.axes[0].incrs), 60, "a tick on a whole minute at the least: never 19:02 twice");
  assert.equal(o.series[0].value(null, Date.UTC(2026, 9, 21, 6) / 1000), "2026-10-21 06:00 UTC", "the hovered time with its date");
  assert.equal(o.series[1].value(null, 7), "7", "the hovered value exact, as the table says it");
});

test("the axes' words: time ticks by the span (minutes, hours, days), compact counts, bytes to TiB and durations, whole-number and power-of-1024 steps", () => {
  const timeTick = charts.timeTick as unknown as (sec: number, span: number) => string;
  const at = (h: number, m = 0, d = 27) => Date.UTC(2026, 9, d, h, m) / 1000;
  assert.deepEqual([timeTick(at(9, 5), 3600), timeTick(at(14), 86_400), timeTick(at(0), 7 * 86_400), timeTick(at(12), 7 * 86_400), timeTick(at(0, 0, 1), 7 * 86_400)],
    ["09:05", "14:00", "Oct 27", "12:00", "Oct 1"]);
  const readoutTime = charts.readoutTime as unknown as (sec: number, span: number) => string;
  assert.deepEqual([readoutTime(at(9, 5), 3600), readoutTime(at(9), 86_400)], ["09:05 UTC", "2026-10-27 09:00 UTC"]);
  const compactBytes = charts.compactBytes as unknown as (v: number) => string;
  assert.deepEqual([0, 512, 1536, 3.4 * 2 ** 20, 2 ** 30, 512 * 2 ** 30, 1.5 * 2 ** 40, 5e12, 3 * 2 ** 50].map(compactBytes),
    ["0 B", "512 B", "1.5 KiB", "3.4 MiB", "1 GiB", "512 GiB", "1.5 TiB", "4.5 TiB", "3 PiB"]);
  const compactMs = charts.compactMs as unknown as (v: number) => string;
  assert.deepEqual([0, 512, 1200, 59_000, 150_000, 4_000_000].map(compactMs), ["0 ms", "512 ms", "1.2 s", "59 s", "2.5 min", "1.1 h"]);
  const compactCount = charts.compactCount as unknown as (v: number) => string;
  assert.deepEqual([0, 950, 1234, 3_400_000].map(compactCount), ["0", "950", "1.2K", "3.4M"]);
  const axisIncrs = charts.axisIncrs as unknown as (u: string) => number[];
  assert.ok(axisIncrs("count").every((v) => Number.isInteger(v)), "never half a statement");
  assert.ok(axisIncrs("bytes").includes(512 * 2 ** 20) && axisIncrs("bytes").includes(2 ** 30) && !axisIncrs("bytes").includes(500 * 2 ** 20), "512 MiB and 1 GiB, never 500 MiB");
  const zeroRange = charts.zeroRange as unknown as (max: number) => number[];
  assert.deepEqual([zeroRange(0), zeroRange(100)], [[0, 1], [0, 108]], "all zero still has an axis");
});

test("the buttons: every one has a visible label; a primary, a destructive one and its confirm are told apart; a small one is 28 px tall; a row's actions are at its right", () => {
  const htmls = [fn<[unknown, Record<string, unknown>?], string>("renderTables")(CATALOG_STATE), fn<[unknown, Record<string, unknown>?], string>("renderTables")(CATALOG_STATE, { removing: "public.orders" }),
    fn<[unknown[], string | null], string>("renderRunning")(RUNNING_NOW, "12:45"), fn<[unknown, unknown?], string>("renderRequests")({ requests: REQUESTS, keptDays: 7, before: "C~1" }, { paged: true }),
    fs.readFileSync(path.join(WEB, "index.html"), "utf8")];
  for (const html of htmls) {
    for (const b of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)) assert.ok(textOf(b[1]!).replace(/[↑↓↕]/g, "").trim().length > 0, `a button with no label: ${b[0]}`);
  }
  assert.match(htmls[1]!, /<p class="confirm">Remove orders\?.*<\/p><p class="pop-actions"><button type="button" class="danger small" data-confirm-remove-table="public\.orders">Remove orders<\/button>/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /button\.small \{ height: 28px;/);
  assert.match(css, /\.pop-actions button\.danger \{ background: var\(--bad\); color: var\(--surface\)/, "the confirm of a destructive action is filled red");
  assert.match(css, /button\.primary \{ background: var\(--cta\)/, "the primary action is the one warm fill");
  assert.match(css, /button:focus-visible \{ outline: 2px solid var\(--accent\)/);
  assert.match(css, /button:disabled \{ opacity: 0\.5; cursor: not-allowed; \}/);
  assert.match(css, /td\.act \{ text-align: right; white-space: nowrap; \}/);
  assert.match(css, /\.cards > :last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1; \}/, "no orphan card on a phone");
});

// ------------------------------------------------------------------ the unsupported SQL: Queries' panel, the Overview's line

const UNSUPPORTED = { since: "2026-10-27T09:05:00.000Z", keptDays: 7, unsupported: [
  { gap: "frame-groups", title: "a window frame in GROUPS mode", runs: 12, users: ["ana", "metabase"], clients: ["Metabase"], last: "2026-10-28T08:59:30.000Z",
    example: `SELECT sum(amount) OVER (ORDER BY day GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM orders WHERE ${"x = 1 AND ".repeat(40)}true` },
  { gap: "gone-entry", title: null, runs: 1, users: [], clients: [], last: "2026-10-28T07:00:00.000Z", example: "SELECT 1" },
] };

test("Usage: the unsupported SQL of the range is mason status's lines (unsupportedLines), each entry named by docs/SQL-SUPPORT.md, read once a minute under Now, once for another range", async () => {
  const entry = fn<[unknown], { headline: string; last: string; how: string; example: string }>("unsupportedEntry");
  for (const g of UNSUPPORTED.unsupported) {
    const [, head, last, how] = commands.unsupportedLines([g], PLAIN);
    const e = entry(g);
    assert.equal(e.headline, head!.trim(), "the first line is mason status's: what they used, how many, who");
    assert.equal(`${e.last} — ${e.example}`, last!.trim(), "the second too: when, the latest on a line");
    assert.equal(e.how, how!.trim(), "the third too: where the way out is");
  }
  const render = fnOf<[unknown, string?], string>(usagePage, "renderUnsupported");
  const html = render(UNSUPPORTED, "the last 7 days");
  assert.match(textOf(html), /^The statements refused in the last 7 days by the SQL they used that Mason does not support, the most first\. a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase last 2026-10-28 08:59 — SELECT sum/);
  assert.match(textOf(html), /SQL this Mason no longer lists: 1 statement last 2026-10-28 07:00 — SELECT 1 How to rewrite it: see docs\/SQL-SUPPORT\.md › SQL this Mason no longer lists$/);
  assert.match(textOf(html), /How to rewrite it: see docs\/SQL-SUPPORT\.md › a window frame in GROUPS mode/);
  assert.ok(html.includes('title="docs/SQL-SUPPORT.md entry frame-groups"') && !textOf(html).includes("frame-groups"), "the registry id is a title, never the words");
  assert.ok(html.includes(`title="${UNSUPPORTED.unsupported[0]!.example}"`), "the whole statement is its title");
  assert.ok(!textOf(html).includes(UNSUPPORTED.unsupported[0]!.example), "the line has it cut, as mason status cuts it");
  assert.equal(textOf(render({ ...UNSUPPORTED, unsupported: [] }, "the last hour")), "No statement refused for unsupported SQL in the last hour (the request log keeps 7 days: MASON_HISTORY_DAYS).");
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<h3>Unsupported SQL<\/h3>\s*<div id="unsupported"><\/div>/);
  // the app: the shared range's since — under Now once a minute, another range once — and its failure said where it shows
  const run = fakeRun();
  run.answers.set("GET api/unsupported?since=7d", answer(UNSUPPORTED));
  run.answers.set("GET api/unsupported?since=15m", answer(UNSUPPORTED));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("#observability/usage?range=7d");
  await app.poll();
  assert.ok(run.asked.includes("GET api/unsupported?since=7d"), "the range's since");
  assert.match(textOf(app.view().unsupported!), /^The statements refused in the last 7 days .* a window frame in GROUPS mode: 12 statements/);
  run.asked.length = 0; t += 60_000; await app.poll();
  assert.ok(!run.asked.some((a) => a.startsWith("GET api/unsupported")), "a past range: read once");
  app.show("#observability/usage"); await app.poll();
  assert.match(textOf(app.view().unsupported!), /^The statements refused in the last 15 minutes /);
  run.asked.length = 0; t += 2000; await app.poll();
  assert.ok(!run.asked.some((a) => a.startsWith("GET api/unsupported")), "Now: not every poll, once a minute");
  t += 60_000; await app.poll();
  assert.ok(run.asked.includes("GET api/unsupported?since=15m"), "a minute on, again");
  run.answers.set("GET api/unsupported?since=1h", answer({ error: "the request log cannot be read" }, 500));
  app.show("#observability/usage?range=1h"); await app.poll();
  assert.match(textOf(app.view().unsupported!), /^✗ the request log cannot be read/, "a failure is said in its part, as the Failure");
});

test("the Overview: the last day's unsupported SQL is one line of the recent errors, with See all, and nothing when there is none", async () => {
  const runServer = await import("../src/cli/run-server.ts") as { MAX_UNSUPPORTED_LIMIT?: number };
  assert.equal(statusPage.UNSUPPORTED_LIMIT as unknown, runServer.MAX_UNSUPPORTED_LIMIT, "it reads every entry the endpoint answers, to count them");
  const line = of<[unknown], string>(statusPage, "status.js", "renderUnsupportedLine");
  const html = line(UNSUPPORTED);
  assert.equal(textOf(html), "Unsupported SQL, the last day: a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase (and 1 other) See all");
  assert.match(html, /<a class="see" href="#observability\/queries\?range=24h">See all<\/a>/);
  assert.equal(line({ ...UNSUPPORTED, unsupported: [] }), "", "none: no line");
  assert.equal(line(undefined), "", "not read yet: nothing");
  assert.equal(textOf(line({ failure: { code: "failed", message: "no ledger\nmore" } })), "Unsupported SQL: could not read it (no ledger; mason logs has the detail)", "as mason status says it");
  const run = fakeRun();
  run.answers.set("GET api/state", answer(RUNNING));
  run.answers.set("GET api/unsupported?limit=100", answer(UNSUPPORTED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.ok(run.asked.includes("GET api/unsupported?limit=100"), "the Overview reads the last day's, the endpoint's default");
  assert.match(textOf(app.view().status!), /Query errors .* Unsupported SQL, the last day: a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase \(and 1 other\) See all$/);
});

// ------------------------------------------------------------------ a table just added shows its copy at once

/** The state with public.accounts added and its copy as given (null: not started). */
const accountsCopy = (c: Partial<CopyState> | null, more: CopyState[] = []): RunState => stateOf([...THREE_COPIED(), ...(c ? [{ source: "public.accounts", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, ...c } as CopyState] : []), ...more],
  { tables: CATALOG, sources: withAccounts });
const withShare = (share: number, o: Partial<CopyProgressView> = {}): Partial<CopyState> => ({ rowsSoFar: Math.round(300 * share), rowsEstimate: 300, progress: { ...progress, share, ...o } });
/** A table's row and the lines under it (its copy's words, its error, a confirm): the page's whole say on that table. */
const accountsRow = (html: string): string => {
  const parts = html.split("<tr");
  const at = parts.findIndex((r) => r.includes("<code class=\"name\" title=\"public.accounts\">"));
  if (at < 0) return "";
  let end = at + 1;
  while (end < parts.length && parts[end]!.startsWith(' class="under')) end++;
  return parts.slice(at, end).join("<tr");
};

test("Add: the row says Adding… from the click, then waiting for its copy, then the bar with the % and mason wait's words, never backwards, until served", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = fn<[unknown], App>("createApp")(async (p: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && p === "api/pick") await gate;
    return run.fetch(p, init);
  });
  app.show("tables");
  await app.poll();
  run.answers.set("POST api/pick", () => { run.answers.set("GET api/state", answer(accountsCopy(null))); return answer(PICKED.secret)(); });
  const adding = app.addTable("public.accounts");
  // asked, not yet answered: the row says so and its button is disabled
  let row = accountsRow(app.view().tables!);
  assert.match(textOf(row), /^.*public\.accounts Adding… .* Adding…/);
  assert.match(row, /<button type="button" class="primary small" disabled>Adding…<\/button>/);
  assert.ok(!/data-add-table/.test(row), "no second Add while the first is asked");
  assert.equal(await app.addTable("public.accounts"), false, "a second click while asking does nothing");
  release();
  assert.equal(await adding, true);
  // answered: the state is read again and the row shows the copy waiting to start, an indeterminate bar
  row = accountsRow(app.view().tables!);
  assert.match(textOf(row), /public\.accounts Waiting ~300 rows key id — View events Sync now Remove Sync… waiting for its first sync to start/);
  assert.match(row, /<span class="copybar indeterminate" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="public\.accounts: its first sync" aria-valuetext="waiting for its first sync to start"><span class="track" aria-hidden="true"><span class="fill"[^>]*><\/span><\/span><\/span>/);
  assert.ok(!/aria-valuenow/.test(row), "waiting: no value, an indeterminate bar");
  // syncing 37%: the bar's value, the aria, and the words mason wait prints (copyingText, held equal)
  const at37 = accountsCopy(withShare(0.37));
  run.answers.set("GET api/state", answer(at37));
  await app.poll();
  row = accountsRow(app.view().tables!);
  const c37 = at37.tables.find((t) => t.table === "public.accounts")!;
  const words = `syncing ${commands.copyingText(c37.copy!.rowsCopied, c37.rows, c37.copy!.progress as CopyProgressView).text}`;
  assert.match(row, /<span class="copybar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="37" aria-label="public\.accounts: its first sync" aria-valuetext="37%, /);
  assert.match(textOf(row), /37% .* syncing 41,111 rows · past the ~300 estimated · 2 chunks reading \(14 s\), 3 of ~20 in · 52,300 rows\/s · ~6 min left/);
  assert.ok(textOf(row).includes(words), "the words are copyingText's, held equal to the CLI's");
  // the Overview draws the same bar from the same renderer
  const bar = row.match(/<span class="copybar"[^>]*><span class="track" aria-hidden="true"><span class="fill"[^>]*><\/span><\/span><\/span> <span class="pct">37%<\/span>/)![0];
  assert.ok(app.view().status!.includes(bar), "one renderer: the Overview's bar is the Tables row's");
  // a state that says less (a share that went back) is not drawn backwards
  run.answers.set("GET api/state", answer(accountsCopy(withShare(0.2))));
  await app.poll();
  assert.match(accountsRow(app.view().tables!), /aria-valuenow="37" .*37%/, "never backwards");
  // further on, it moves again, only with the server's data
  run.answers.set("GET api/state", answer(accountsCopy(withShare(0.8))));
  await app.poll();
  assert.match(accountsRow(app.view().tables!), /aria-valuenow="80" .*80%/);
  assert.match(textOf(app.view()["tables-cards"]!), /Synced 3 of 4 added, 1 syncing/);
  // served: its normal sync state, its bar full at 100%
  run.answers.set("GET api/state", answer(accountsCopy({ phase: "copied", rows: 300, bytes: 1, seconds: 2, copiedAt: "2026-10-27T09:06:00.000Z", synced: { at: "2026-10-27T09:06:00.000Z", seconds: 2, by: "copy" } } as Partial<CopyState>)));
  await app.poll();
  row = accountsRow(app.view().tables!);
  assert.match(row, /<span class="copyline t-done"><span class="copybar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" /, "served: the bar full, as mason status draws it");
  assert.match(textOf(row), /public\.accounts Synced 100% 300 key id/);
  // a copy that fails shows its error as the other failures do, no bar
  run.answers.set("GET api/state", answer(accountsCopy({ phase: "failed", error: "could not read the next chunk: connection reset" })));
  await app.poll();
  row = accountsRow(app.view().tables!);
  assert.match(row, /<span class="err">could not read the next chunk: connection reset<\/span>/);
  assert.match(row, /<span class="copyline t-failed"><span class="copybar" /, "failed: its bar red, as the other failures'");
  // after a failure its next copy begins at its own share, not the last one's
  run.answers.set("GET api/state", answer(accountsCopy(withShare(0.05))));
  await app.poll();
  assert.match(accountsRow(app.view().tables!), /aria-valuenow="5" .*5%/);
});

test("a copy's bar is a thin solid line: a track and a fill to its share, its % at its end, its colour the line's state; aria and words the line's; no bricks", () => {
  const copyBar = of<[string, { state: string; fraction: number; what: string }, number?, number?], string>(statusPage, "status.js", "copyBar");
  const t = commands.copyingText(41_111, 300, progress);
  const line = { state: "copying", fraction: 0.37, what: `syncing ${t.text}` };
  const html = copyBar("public.accounts", line);
  // the progressbar: its value, its label, its words (the line's, held to the CLI's copyingText); the track is drawing
  assert.match(html, /^<span class="copybar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="37" aria-label="public\.accounts: its first sync" aria-valuetext="37%, syncing /);
  assert.ok(html.includes(`aria-valuetext="37%, ${line.what.replace(/'/g, "&#39;")}"`), "its words are the line's");
  assert.match(html, /<span class="track" aria-hidden="true"><span class="fill" style="width: 37%"><\/span><\/span><\/span> <span class="pct">37%<\/span>$/, "one solid fill to the share, then the % at the bar's end, as mason wait prints it");
  // the fill is the share, floored as the % is, never past 100 nor under 0
  for (const pct of [0, 3, 37, 99, 100]) assert.match(copyBar("t", { ...line, fraction: pct / 100 }), new RegExp(`style="width: ${pct}%".* <span class="pct">${pct}%</span>$`));
  assert.match(copyBar("t", { ...line, fraction: 1.4 }), /style="width: 100%"/);
  assert.match(copyBar("t", { ...line, fraction: -1 }), /style="width: 0%"/);
  // waiting: no fill, no value, no %; the track's shimmer
  const waiting = copyBar("t", { state: "waiting", fraction: 0, what: "waiting for its first sync to start" });
  assert.equal(waiting, `<span class="copybar indeterminate" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="t: its first sync" aria-valuetext="waiting for its first sync to start"><span class="track" aria-hidden="true"><span class="fill"></span></span></span>`);
  // no brick is left of the old bar: no <i>, no BRICKS, no wall in the stylesheet
  assert.ok(!/<i[ >]/.test(html + waiting), "no brick");
  assert.equal((statusPage as Record<string, unknown>).BRICKS, undefined);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.copybar i\b|\.wall\b|brick-drop|brick-next|wall-settle/.test(css), "the brick wall's rules are gone");
  // the fill's colour is the line's state: the accent while it copies, green served, rose failed, amber not kept current
  assert.match(css, /\.copybar \.fill \{[^}]*background: var\(--brick\);/);
  assert.match(css, /\.t-done \.copybar \.fill \{ background: var\(--bar-ok\); \}/);
  assert.match(css, /\.t-failed \.copybar \.fill \{ background: var\(--bar-bad\); \}/);
  assert.match(css, /\.t-unsynced \.copybar \.fill \{ background: var\(--bar-warn\); \}/);
  assert.match(css, /\.copybar \.track \{[^}]*border-radius: 3px;[^}]*background: var\(--bar-track\);/, "a thin rounded track");
  // the shimmer while waiting only without prefers-reduced-motion; no gradient or image
  assert.match(css, /\.copybar\.indeterminate \.track \{ animation: bar-wait/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.copybar\.indeterminate \.track \{ animation: none; \} \}/);
  assert.ok(!/gradient\(/.test(css));
});

test("the monotone remembers the read before: a copy's share is never drawn backwards, and a copy that finished leaves its last", () => {
  const createMonotone = of<[], { of(s: unknown): Map<string, number>; before: Map<string, number> }>(statusPage, "status.js", "createMonotone");
  const m = createMonotone();
  const at = (share: number) => accountsCopy(withShare(share));
  m.of(at(0.2));
  assert.equal(m.before.get("public.accounts"), undefined, "a first read: nothing before");
  m.of(at(0.4));
  assert.equal(m.before.get("public.accounts"), 0.2);
  m.of(accountsCopy({ phase: "copied", rows: 300, bytes: 1, seconds: 2, copiedAt: "2026-10-27T09:06:00.000Z" } as Partial<CopyState>));
  assert.equal(m.before.get("public.accounts"), 0.4, "the copy finished: its last share is the read before");
});

test("Add: several tables in a row each show their own state; a refused add leaves no Adding…; the cards count the copying", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  const both = stateOf([...THREE_COPIED(), { source: "public.accounts", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, ...withShare(0.5) } as CopyState],
    { tables: CATALOG, sources: parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n  accounts: {}\n  audit: {}\n", "shop", "/app/mason/sources/shop.yml") as typeof sourceFile });
  run.answers.set("POST api/pick", () => { run.answers.set("GET api/state", answer(both)); return answer(PICKED.secret)(); });
  await app.addTable("public.accounts");
  await app.addTable("public.audit");
  const v = app.view();
  assert.match(textOf(accountsRow(v.tables!)), /50% .* syncing/);
  assert.match(textOf(v["tables-cards"]!), /Synced 3 of 5 added, 1 syncing/);
  assert.match(textOf(v.status!), /1 syncing/, "the Overview's cards say it too");
  // refused: no Adding… stays
  run.answers.set("POST api/pick", answer({ error: "no", failure: { code: "refused", message: "no", next: [] } }, 409));
  assert.equal(await app.addTable("public.staging"), false);
  assert.ok(!/Adding…/.test(app.view().tables!));
});

// ------------------------------------------------------------------ Connect: how a first-time user gets to a first statement

/** The request log's summary of a run nothing has asked anything yet. */
const NO_QUERIES = { queries: { keptDays: 7, day: { ...QUERIES.queries.day, statements: 0, completed: 0, refused: 0, failed: 0, cancelled: 0, rows: 0, bytesSent: 0, durationMs: null },
  week: { ...QUERIES.queries.week, covered: 7, statements: 0, completed: 0, refused: 0, failed: 0, cancelled: 0, rows: 0, bytesSent: 0, durationMs: null } } };
/** Where this run's Postgres API listens, as mason status prints it (src/cli/pg-url.ts): the panel is held equal to it. */
// read by name, so this file loads at a commit without it (scripts/fails-without.ts) and each test fails by name
// (it takes the run's record since MASON_PG_PUBLIC_URL; an older tree's takes the URL, and a record is no URL to it: the literal)
const SHOP_PG = ((): { shown: string; psql: string } | undefined => {
  try { return (pgUrl as { postgresFacts?: (r: { postgresUrl: string }) => { shown: string; psql: string } }).postgresFacts?.({ postgresUrl: "postgresql://127.0.0.1:5433/shop" }); }
  catch (e) { if (e instanceof Error && /not a URL/.test(e.message)) return undefined; throw e; }
})() ?? { shown: "postgres://<user>:<password>@127.0.0.1:5433/shop", psql: "psql 'postgres://<user>:<password>@127.0.0.1:5433/shop'" };

test("the Overview, nothing asked yet: Connect your first tool under the cards — the URL mason status prints, with Copy, no psql line, and Create a user", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { queries: NO_QUERIES, now: NOW });
  const text = textOf(html);
  assert.equal(SHOP_PG.shown, "postgres://<user>:<password>@127.0.0.1:5433/shop", "the line mason start and mason status print");
  assert.match(text, new RegExp(`Connect your first tool Mason answers SQL over the Postgres protocol, as a read replica of your database would: point psql, a BI tool or your app's analytics code at this URL\\. ` +
    `URL ${SHOP_PG.shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Copy ` +
    "Then try select count\\(\\*\\) from customers; Copy it shows on Queries " +
    "Create a user Its name and password go in place of <user>:<password> : the Users page shows the whole URL once, as mason user add <name> prints it\\. " +
    // and beside the local connection, Connect from anywhere (mason share, from the page)
    "Connect from anywhere Connect from anywhere For a tool in the cloud, which cannot reach this machine: a temporary public address and a password, as mason share opens\\. TLS is required of every connection\\. Mason Source "));
  assert.match(html, /<code id="connect-try">select count\(\*\) from customers;<\/code> <button type="button" class="small" data-copy="connect-try" data-room="Press ⌘C">Copy<\/button>/,
    "a first statement that the request log lists: one that reads a copied table (the first copied), never a select 1 it does not");
  // first under the cards, before the facts: the most important thing on a fresh install is how to reach it
  assert.ok(text.indexOf("Connect your first tool") > text.indexOf("p95, last day") && text.indexOf("Connect your first tool") < text.indexOf("Mason Source"));
  assert.match(html, /<code id="connect-url">postgres:\/\/&lt;user&gt;:&lt;password&gt;@127\.0\.0\.1:5433\/shop<\/code> <button type="button" class="small" data-copy="connect-url" data-room="Press ⌘C">Copy<\/button>/);
  // no psql line (issue 874): the URL is the same thing, pasted after psql (mason status and --json keep theirs)
  assert.doesNotMatch(html, /connect-psql|<dt>psql<\/dt>/);
  assert.deepEqual([...html.matchAll(/data-copy="(connect-[^"]+)"/g)].map((m) => m[1]), ["connect-url", "connect-try"], "the URL's Copy and the first statement's, none else");
  assert.match(html, /<a class="btn primary" href="#users">Create a user<\/a>/, "a link to the page that makes one");
});

test("the Overview once statements ran: Connect after the facts, quieter; with no table added, none (adding one is the step)", () => {
  const busy = textOf(fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { queries: QUERIES, now: NOW }));
  assert.ok(!busy.includes("Connect your first tool"));
  assert.match(busy, /Sessions none open Connect URL postgres:\/\/<user>:<password>@127\.0\.0\.1:5433\/shop Copy Create a user /, "after the facts table, no psql line");
  // the request log not read yet, or unreadable: not "first" (it may have answered thousands)
  assert.ok(!textOf(fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { now: NOW })).includes("Connect your first tool"));
  assert.ok(!textOf(fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { queries: { failure: { code: "failed", message: "busy" } }, now: NOW })).includes("Connect your first tool"));
  assert.ok(!/Connect/.test(textOf(fn<[unknown, unknown?], string>("renderStatus")(NONE, { queries: NO_QUERIES }))));
  // a run from before it said where it listens: nothing, never a made-up URL
  assert.equal(fn<[unknown], string>("renderConnect")(undefined), "");
});

test("Queries, an empty request log: how to connect under its sentence — never once a filter or an older page is shown", async () => {
  const renderRequests = fn<[unknown, Record<string, unknown>], string>("renderRequests");
  const connect = fn<[unknown, unknown], string>("renderConnect")(SHOP_PG, { first: true });
  const empty = { requests: [], keptDays: 7, before: null };
  assert.match(textOf(renderRequests(empty, { span: "the last 24 hours", connect })), /^No request in the last 24 hours \(the request log keeps 7 days: MASON_HISTORY_DAYS\)\. A statement that reads no synced table \(select 1, SET, SHOW, a BI tool's catalog queries\) is answered but not listed\. Connect your first tool .* Create a user /);
  assert.equal((page as Record<string, unknown>).UNLISTED_STATEMENTS, commands.UNLISTED_STATEMENTS, "the page says what mason logs --requests says");
  assert.ok(fs.readFileSync(path.join(WEB, "index.html"), "utf8").includes(`${commands.UNLISTED_STATEMENTS}.`), "and the request log's lead says it over a log that has rows");
  assert.ok(!textOf(renderRequests(empty, { span: "the last 24 hours", connect, filtered: true })).includes("Connect"), "a filter that passes none is not a fresh install");
  // the app: the Queries page renders it from /api/state's postgres
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(RUNNING), { status: 200 }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.match(textOf(app.view()["request-log"]!), /^No request in the last 15 minutes .* Connect your first tool .* URL postgres:\/\/<user>:<password>@127\.0\.0\.1:5433\/shop Copy Then try select count\(\*\) from customers; Copy /);
});

test("a Copy button, on any page: its code's text to the clipboard, Copied for 2 s then Copy; with no clipboard, the text selected and copied as a selection, else what to press", async () => {
  const copyClick = fn<[Record<string, string>, { textContent: string; dataset?: Record<string, string> }, unknown], Promise<void> | null>("copyClick");
  assert.equal((page as Record<string, unknown>).COPIED_MS, 2000);
  const code = { textContent: SHOP_PG.shown };
  const timers: Array<[() => void, number]> = [];
  const setTimeout = (f: () => void, ms: number) => { timers.push([f, ms]); };
  const wrote: string[] = [];
  const b = { textContent: "Copy", dataset: {} as Record<string, string> };
  const doc = { getElementById: (id: string) => id === "connect-url" ? code : null };
  await copyClick({ copy: "connect-url" }, b, { doc, win: { setTimeout, navigator: { clipboard: { writeText: async (t: string) => { wrote.push(t); } } } } });
  assert.deepEqual([wrote, b.textContent, "copied" in b.dataset], [[SHOP_PG.shown], "Copied", true]);
  assert.deepEqual(timers.map(([, ms]) => ms), [2000], "it says Copied for 2 s");
  timers[0]![0]();
  assert.deepEqual([b.textContent, "copied" in b.dataset], ["Copy", false], "then Copy again");
  // the clipboard refused (no permission): the text selected and copied as a person's own Copy would
  const selected: unknown[] = [];
  const execs: string[] = [];
  const r = { textContent: "Copy", dataset: {} as Record<string, string> };
  const refused = { setTimeout, getSelection: () => ({ selectAllChildren: (x: unknown) => selected.push(x) }), navigator: { platform: "MacIntel", clipboard: { writeText: async () => { throw new Error("denied"); } } } };
  await copyClick({ copy: "connect-url" }, r, { doc: { ...doc, execCommand: (c: string) => { execs.push(c); return true; } }, win: refused });
  assert.deepEqual([selected, execs, r.textContent], [[code], ["copy"], "Copied"]);
  // and no clipboard at all (navigator.clipboard undefined on an insecure origin), the selection's copy refused too: what to press
  // in the button's own room (ROOMS.copy), so it never grows; the whole sentence is its title
  const q = { textContent: "Copy", title: "", dataset: {} as Record<string, string> };
  await copyClick({ copy: "connect-url" }, q, { doc: { ...doc, execCommand: () => false }, win: { ...refused, navigator: { platform: "Linux x86_64" } } });
  assert.deepEqual([q.textContent, q.title], ["Ctrl+C", "Selected: press Ctrl+C to copy it"]);
  await copyClick({ copy: "connect-url" }, q, { doc: { ...doc, execCommand: () => { throw new Error("no"); } }, win: refused });
  assert.deepEqual([q.textContent, q.title], ["Press ⌘C", "Selected: press ⌘C to copy it"]);
  const ROOMS = (page as Record<string, unknown>).ROOMS as Record<string, string>;
  for (const label of ["Copy", "Copied", "Press ⌘C", "Ctrl+C"]) assert.ok([...label].length <= [...ROOMS.copy!].length, `${label} fits the Copy button's room`);
  assert.equal(copyClick({ sync: "x" }, b, { doc, win: {} }), null, "not a Copy: the page's own click goes on");
});

test("Users: ONE Connect panel for the run — host, port, database, sslmode and the URL with placeholders, each with Copy, no psql line — and no URL per user", async () => {
  // (review, Tom) a row's URL without its password read as a credential to copy, and every row's host, port and
  // database were the run's: the row keeps what is the user's, the panel says the run's once, and the card shown
  // once when a user is added is the only place a password is ever copied
  const usersPage = await import(path.join(WEB, "pages", "users.js") as string) as Record<string, unknown>;
  const renderUsersConnect = usersPage.renderUsersConnect as ((pg: unknown) => string) | undefined;
  assert.equal(typeof renderUsersConnect, "function", "src/web/pages/users.js exports renderUsersConnect");
  const pg = { url: "postgresql://127.0.0.1:5433/shop", host: "127.0.0.1", port: 5433, database: "shop", shown: "postgresql://<user>:<password>@127.0.0.1:5433/shop", psql: "psql 'postgresql://<user>:<password>@127.0.0.1:5433/shop'" };
  const html = renderUsersConnect!(pg);
  assert.equal(textOf(html), "Connect Host 127.0.0.1 Copy Port 5433 Copy Database shop Copy SSL mode disable Copy URL postgresql://<user>:<password>@127.0.0.1:5433/shop Copy " +
    "A user's name and password go in place of <user> and <password> . The password is shown once, when the user is added: lost, remove the user and add it again.");
  for (const id of ["host", "port", "database", "sslmode", "url"]) {
    assert.match(html, new RegExp(`<code id="users-connect-${id}">`), id);
    assert.match(html, new RegExp(`data-copy="users-connect-${id}"`), `${id}'s Copy`);
  }
  // no psql line (issue 874): the URL is the same thing, pasted after psql (the Overview's Connect and --json keep theirs)
  assert.doesNotMatch(textOf(html), /psql/, "no psql line, and no word of it");
  assert.doesNotMatch(html, /users-connect-psql/);
  assert.match(renderUsersConnect!({ ...pg, sslmode: "require" }), /<code id="users-connect-sslmode">require<\/code>/, "off this machine: require");
  assert.equal(renderUsersConnect!(undefined), "", "a run that did not say: nothing");
  const rows = fn<[unknown, string | null, number], string>("renderUsers")({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: null,
    url: "postgresql://metabase@127.0.0.1:5433/shop" }], lastUsedNote: null, urlNote: null, requestLogDays: 7 }, null, NOW);
  assert.ok(!/postgresql:\/\/|data-copy|>URL</.test(rows), "no URL, and no Copy, in a user's row");
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<div id="users-connect"><\/div>\s*<div id="add-user-box"><\/div>/, "the panel over the form and the list (issue 887)");
});

test("the Overview's first-run checklist: running, a table copied, a user created, a first statement answered — each ○ with its one action; gone once all are done", async () => {
  const renderChecklist = of<[unknown, unknown, unknown], string>(statusPage, "status.js", "renderChecklist");
  const user = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true }] };
  const noUser = { users: [{ ...user.users[0], removedAt: "2026-10-27T10:00:00.000Z" }] };
  // a fresh install: a table added and copied, no user, nothing asked
  const fresh = renderChecklist(RUNNING, NO_QUERIES, noUser);
  assert.equal(textOf(fresh), "Getting started 2 of 4 done ✓ Mason is running (done) ✓ A table synced (done) ○ A user created (to do) Create a user ○ A first statement answered (to do) connect with the URL below, then run a select on a synced table");
  // the steps drawn as courses of a wall beside its title: a brick a step, laid as it is done (drawing, hidden from a screen reader)
  assert.match(fresh, /<p class="checklist-title"><span class="courses" aria-hidden="true"><i class="on"><\/i><i class="on"><\/i><i><\/i><i><\/i><\/span>Getting started /);
  assert.match(fresh, /<li class="step-todo"><span class="mark" aria-hidden="true">○<\/span><span class="what">A user created<span class="sr"> \(to do\)<\/span><\/span><a class="btn small primary" href="#users">Create a user<\/a><\/li>/, "the next step is the primary action");
  // no psql line to copy (issue 874): the URL is Connect's, under the checklist, with its own Copy
  assert.doesNotMatch(fresh, /psql|data-copy/);
  // nothing added: Add a table leads to Tables; nothing to connect to yet
  const none = renderChecklist(NONE, NO_QUERIES, noUser);
  assert.match(none, /○<\/span><span class="what">A table synced<span class="sr"> \(to do\)<\/span><\/span><a class="btn small primary" href="#tables">Add a table<\/a>/);
  assert.ok(!none.includes("connect with the URL below"));
  // copying: no action, it is under way
  assert.match(textOf(renderChecklist({ ...COPYING, totals: { ...COPYING.totals!, copied: 0 } }, NO_QUERIES, noUser)), /○ A table synced \(to do\) syncing now ○ A user created/);
  // a user, no statement yet: where to send it, and no psql line
  assert.match(textOf(renderChecklist(RUNNING, NO_QUERIES, user)), /○ A first statement answered \(to do\) connect with the URL below, then run a select on a synced table$/);
  assert.doesNotMatch(renderChecklist(RUNNING, NO_QUERIES, user), /psql/);
  // all four done: none; a read not answered, or that failed: none (never a ○ for what could not be told)
  assert.equal(renderChecklist(RUNNING, QUERIES, user), "");
  assert.equal(renderChecklist(RUNNING, undefined, user), "");
  assert.equal(renderChecklist(RUNNING, NO_QUERIES, { failure: { code: "failed", message: "x" } }), "");
  assert.equal(renderChecklist(RUNNING, { failure: { code: "failed", message: "x" } }, noUser), "");
  // the app: the Overview reads the users (every 30 s) and draws it above the cards; its Copy is a Copy
  const run = fakeRun();
  run.answers.set("GET api/state", answer(RUNNING));
  run.answers.set("GET api/queries", answer(NO_QUERIES));
  run.answers.set("GET api/users", answer({ users: [] }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.ok(run.asked.includes("GET api/users"));
  const text = textOf(app.view().status!);
  assert.match(text, /^Ready Getting started 2 of 4 done /);
  assert.ok(text.indexOf("Getting started") < text.indexOf("Tables synced"), "above the cards");
  assert.ok(text.indexOf("connect with the URL below") < text.indexOf("URL postgres://<user>:<password>@127.0.0.1:5433/shop Copy"), "the URL it names is below it, Connect's, with its Copy");
  assert.doesNotMatch(text, /psql '/, "no psql line on the Overview");
});

test("a page opened at its own address that reads no state (Users) still has the sidebar's project, badge and version: the shell reads the state once a minute beside it", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(RUNNING));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(t), "#users");
  await app.poll();
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state"], "the page's own read first: its failure is the banner");
  assert.notEqual(app.view().where, "", "the sidebar names the database");
  assert.match(app.view().version!, /^Mason /);
  run.asked.length = 0; t += 30_000; await app.poll();
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state"], "Users reads the state itself now (its Connect panel), at its own rate");
});

test("Tables: an added copy not measured yet says so (—, with why in its title), never 0 B", () => {
  const html = fn<[unknown, unknown?], string>("renderTables")(SYNCED, {});
  assert.match(html, /<td class="num" title="not measured yet: a synced table(?:'|&#39;)s size is measured every 10 min once its rows are written into the file; a small table(?:'|&#39;)s can wait in the write-ahead log until the log passes 16 MiB or Mason stops">—<\/td>/);
  assert.ok(!/\b0 B\b/.test(textOf(html)), "no 0 B");
  // a measure that is 0 (a file from an earlier run stored one) is not shown as a size either: the server skips it, the page never says 0 B for a copy
  assert.ok(!/\b0 B\b/.test(textOf(fn<[unknown, unknown?], string>("renderTables")(SYNCED, { sizes: { copySizes: [] } }))));
});

test("Tables: the state the page polls carries no table's columns; a form reads its table's once as it opens, a refusal said in the form, a late answer for a form closed dropped", async () => {
  assert.ok(CATALOG_STATE.tables.every((t) => !("columns" in t)), "the state, as the run answers it to the page, is lean");
  const columnsPath = fn<[string], string>("columnsPath");
  assert.equal(columnsPath("public.Odd/name"), "api/tables/public.Odd%2Fname/columns", "a name is one segment of the path");
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  run.asked.length = 0;
  await app.poll();
  assert.ok(!run.asked.some((a) => a.includes("/columns")), "a poll reads no columns");
  const message = 'the database has no table "public.audit" this user can read';
  run.answers.set("GET api/tables/public.audit/columns", answer({ error: message, failure: { code: "not_found", message, next: [] } }, 404));
  assert.equal(await app.choose("public.audit"), true);
  assert.equal(textOf(popOf(app.view().tables!, "act-tables-public.audit")), "✗ the database has no table \"public.audit\" this user can read Cancel");
  // closed before its columns came: the answer is not written into another table's form
  const opening = app.choose("public.accounts");
  app.cancelChoose();
  assert.equal(await opening, false);
  assert.ok(!/data-pick-form|Reading/.test(app.view().tables!), "no form, nothing being read");
  await app.choose("public.accounts");
  assert.deepEqual([...app.view().tables!.matchAll(/name="columns" value="([^"]*)"/g)].map((m) => m[1]), ["id", "email", "password_hash"]);
});

// ------------------------------------------------------------------ the layout: rows that fit their card (the owner's Remove pushed off the edge)

const queriesPage = await import(path.join(WEB, "pages", "queries.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;

test("layout guard: a click moves no row and no column — a question, a form and an answer are popovers beside the button, never a row; a changing label keeps its room; fixed columns; the actions never wrap; a table's card scrolls, never the page", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const renderUsers = fn<[unknown, unknown, number?, unknown?], string>("renderUsers");
  const renderRunning = fn<[unknown[], string | null, unknown?], string>("renderRunning");
  const users = { users: [{ name: "a".repeat(40), id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: null, url: "postgres://x@127.0.0.1:5433/shop" },
    { name: "b", id: "fedcba9876543210", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: null, url: "postgres://b@127.0.0.1:5433/shop" }], lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const synced = { at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] };
  const failure = { code: "refused", message: "no" };
  // b disabled: its Disable says Enable, in the same room
  const disabledUsers = { ...users, users: users.users.map((u) => u.name === "b" ? { ...u, disabledAt: "2026-10-28T09:00:00.000Z", live: false } : u) };
  // [what, the page before the click, after it, the popover's anchor]
  const cases: Array<[string, string, string, string]> = [
    ["the Tables page's Remove", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { removing: "public.customers" }), "act-tables-public.customers"],
    ["the Tables page's Columns…", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { choosing: "public.audit", columns: columnsOf("public.audit") }), "act-tables-public.audit"],
    ["the Tables page's Name its key…", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { choosing: "public.event_log" }), "act-tables-public.event_log"],
    ["the Tables page's Add, answered", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", added: PICKED.secret } }), "act-tables-public.accounts"],
    ["the Tables page's Add, refused", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { outcome: { table: "public.audit", failure } }), "act-tables-public.audit"],
    ["the Tables page's Remove, answered", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", removed: { removed: ["public.accounts"], file: FILE } } }), "act-tables-public.accounts"],
    ["the Tables page's Sync, answered", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { synced: { table: "public.customers", synced } }), "act-tables-public.customers"],
    ["the Tables page's Sync, refused", renderTables(CATALOG_STATE), renderTables(CATALOG_STATE, { synced: { table: "public.customers", failure } }), "act-tables-public.customers"],
    ["the Users page's Remove", renderUsers(users, null), renderUsers(users, "a".repeat(40)), `act-users-${"a".repeat(40)}`],
    ["the Users page's Remove, refused", renderUsers(users, null), renderUsers(users, null, Date.now(), { name: "b", failure }), "act-users-b"],
    ["the Users page's Disable", renderUsers(users, null), renderUsers(users, { name: "b", verb: "disable" }), "act-users-b"],
    ["the Users page's Disable, refused", renderUsers(users, null), renderUsers(users, null, Date.now(), { name: "b", failure }), "act-users-b"],
    ["the Users page's Enable, refused", renderUsers(disabledUsers, null), renderUsers(disabledUsers, null, Date.now(), { name: "b", failure }), "act-users-b"],
    ["the Users page's From…", renderUsers(users, null), renderUsers(users, { name: "b", verb: "from" }), "act-users-b"],
    ["the Users page's From…, refused", renderUsers(users, null), renderUsers(users, null, Date.now(), { name: "b", failure }), "act-users-b"],
    ["Running now's Cancel", renderRunning(RUNNING_NOW, null), renderRunning(RUNNING_NOW, "12:45"), "act-running-12:45"],
    ["Running now's Cancel, answered", renderRunning(RUNNING_NOW, null), renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] }), "act-running-12:45"],
  ];
  const rowsOf = (html: string) => [...html.matchAll(/<tr\b[^>]*>/g)].map((m) => m[0]);
  const cellsOf = (html: string) => [...html.matchAll(/<t[hd]\b[^>]*>/g)].length;
  for (const [what, before, after, anchor] of cases) {
    // ONE popover, beside the button, written after the table — never inside it
    const pops = popsOf(after);
    assert.equal(pops.length, 1, `${what}: one popover`);
    assert.equal(pops[0]!.anchor, anchor, `${what}: anchored to its row's actions`);
    assert.ok(after.includes(`<td class="act" id="${anchor.replace(/"/g, "&quot;")}">`), `${what}: its anchor is the row's actions cell, in the page`);
    assert.ok(after.indexOf(pops[0]!.html) > after.lastIndexOf("</table>"), `${what}: after the table`);
    // NO ROW INSERTED, NONE TAKEN AWAY, NO CELL ADDED: the table is the same rows, the same cells, as before the click
    const table = withoutPops(after);
    assert.deepEqual(rowsOf(table).length, rowsOf(before).length, `${what}: no row inserted under the table's row`);
    assert.equal(cellsOf(table), cellsOf(before), `${what}: no cell added`);
    assert.ok(!/class="under asking"|class="confirm"|data-confirm|data-pick-form/.test(table), `${what}: no question or form in the table`);
    for (const m of table.matchAll(/<td class="act"[^>]*>(.*?)<\/td>/gs)) assert.ok(!/confirm|data-confirm/.test(m[1]!), `${what}: no question in a row's actions (${m[1]})`);
    // a question or a form is a dialog with its Cancel (Escape presses it); an answer is a status
    assert.match(pops[0]!.html, /^<div class="pop (ask" data-anchor="[^"]*" role="dialog" aria-label="[^"]+"|said" data-anchor="[^"]*" role="status")/, `${what}: a dialog or a status`);
    if (pops[0]!.html.startsWith('<div class="pop ask"')) assert.match(pops[0]!.html, /data-pop-close/, `${what}: its Cancel answers Escape`);
  }
  // THE TABLES LIST: every row its note line under it, empty or not, so a note that comes or goes moves no row
  const html = renderTables(CATALOG_STATE);
  const trs = rowsOf(html).slice(1);
  trs.forEach((tr, i) => assert.equal(tr.startsWith('<tr class="under note"'), i % 2 === 1, `row ${i}: a table's row, then its note line: ${tr}`));
  for (const row of html.split("<tr").filter((r) => r.includes('<th scope="row" class="name">'))) assert.equal([...row.matchAll(/<td/g)].length, 6, `six cells beside the name: ${row.slice(0, 120)}`);
  assert.ok(!/class="what"/.test(html), "no Note column");
  // a table not added keeps its bar's line, empty, so Add → its bar moves no row
  assert.match(html, /Not added<\/span><span class="copyline none" aria-hidden="true"><\/span><\/td>/);
  // BUTTONS WHOSE LABEL CHANGES keep the room of the longest: Sync now → Syncing… → Synced ✓ one width
  const ROOMS = (page as Record<string, unknown>).ROOMS as Record<string, string>;
  for (const label of ["Sync now", "Syncing…", "Synced ✓"]) assert.ok([...label].length <= [...ROOMS.sync!].length, `${label} fits Sync's room`);
  const syncing = renderTables(CATALOG_STATE, { syncing: ["public.customers"] });
  const sync = renderTables(CATALOG_STATE, { synced: { table: "public.customers", synced, at: 0 }, now: 1 });
  for (const h of [html, syncing, sync]) assert.match(h, /<a class="btn small" href="#observability\/syncs\?table=public\.customers&amp;range=7d">View events<\/a> <button type="button" class="small"[^>]* data-room="Syncing…"[^>]*>(Sync now|Syncing…|Synced ✓)<\/button> <button type="button" class="danger small"/,
    "View events, a link that never changes, before the sync's room");
  // a user's Disable → Enable once disabled: one room, the longer, and no cell or row added
  for (const label of ["Disable", "Enable"]) assert.ok([...label].length <= [...ROOMS.disable!].length, `${label} fits Disable's room`);
  const rowB = (h: string) => /<td class="act" id="act-users-b">(.*?)<\/td>/s.exec(h)![1]!;
  assert.match(rowB(renderUsers(users, null)), /^<a class="btn small"[^>]*>Queries<\/a> <button type="button" class="small" data-disable="b" data-room="Disable">Disable<\/button> /);
  assert.match(rowB(renderUsers(disabledUsers, null)), /^<a class="btn small"[^>]*>Queries<\/a> <button type="button" class="small" data-enable="b" data-room="Disable">Enable<\/button> /);
  assert.equal(cellsOf(renderUsers(disabledUsers, null)), cellsOf(renderUsers(users, null)), "disabling a user adds no cell");
  assert.equal(rowsOf(renderUsers(disabledUsers, null)).length, rowsOf(renderUsers(users, null)).length, "nor a row");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  // a selector's declarations, wherever it is listed (comments aside; a media query's rules count too)
  const rule = (sel: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(sel)).map((m) => m[2]!).join(";");
  assert.match(rule("button[data-room]::after"), /content: attr\(data-room\); display: block; height: 0;/, "the room is an unseen line of no height: it widens, never heightens");
  assert.match(rule(".pop"), /position: fixed/, "a popover is over the rows, never between them");
  // FIXED COLUMNS: as wide as the header says, whatever a row holds now (Not added → Adding… → Waiting and its bar)
  assert.match(rule("table.catalog"), /table-layout: fixed; width: 100%; min-width: \d+px/);
  // the users' too: Disable says "Disabled <when>", wider than Active, and must widen no column (found in the browser)
  assert.match(rule("table.users"), /table-layout: fixed; width: 100%; min-width: \d+px/);
  for (const c of ["status", "added", "last", "act"]) assert.match(rule(`table.users th.${c}`), /width: \d+px/, `the users' ${c} column has its width`);
  // THE USERS FIT THEIR CARD AT A LAPTOP'S WIDTH (PR 820's review: a column and a button more scrolled the table 182 px at
  // 1280, its actions off the card): its least width at most 960 px, and its fixed columns leave User and Role 100 px each
  // in the ~998 px card of a 1280 px window (measured in Chromium: 110 px each)
  const px = (sel: string) => Number(/width: (\d+)px/.exec(rule(sel))![1]);
  assert.ok(Number(/min-width: (\d+)px/.exec(rule("table.users"))![1]) <= 960, "the users' least width");
  assert.ok(["status", "added", "last", "act"].reduce((s, c) => s + px(`table.users th.${c}`), 0) + 2 * 100 <= 998, "User and Role keep their room at 1280");
  // where it scrolls (a narrower window, a phone), a row's actions stay pinned at the card's right, and a name never runs into its Role
  assert.match(rule("table.users td.act"), /position: sticky; right: 0/);
  const phone = css.slice(css.lastIndexOf("@media (max-width: 640px)", css.indexOf("  table.users { display: table; }")));
  assert.ok(css.includes("  table.users { display: table; }") && phone.indexOf("table.users { display: table; }") < phone.indexOf("\n}"), "on a phone the card scrolls, so the actions pin");
  assert.match(rule('table.users th[scope="row"]'), /overflow: hidden/);
  const heads = [...html.matchAll(/<th scope="col" class="([^"]+)">/g)].map((m) => m[1]!.split(" ").pop()!);
  assert.deepEqual(heads, ["name", "state", "rows", "key", "last", "size", "act"]);
  for (const c of heads.filter((x) => x !== "name")) assert.match(rule(`table.catalog th.${c}`), /width: \d+px/, `the ${c} column has its width`);
  assert.match(rule("td.act"), /white-space: nowrap/, "a row's actions never wrap");
  assert.match(rule(".panel"), /overflow-x: auto/, "a table in a card scrolls inside it");
  assert.match(rule(".scroll"), /overflow-x: auto/);
  assert.match(rule(".table-wrap"), /overflow-x: auto/, "a bare table too wide scrolls inside its box");
  assert.match(rule(".pop button"), /max-width: 100%/, "a confirm's button names a long table, cut, never past the popover");
  assert.match(rule("table.errors td"), /overflow-wrap: anywhere/, "a user or client name without spaces wraps in its cell");
  // the Overview's eleven numbers scroll in their box
  assert.match(fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { now: NOW, queries: QUERIES }), /<div class="table-wrap"><table class="queries">/);
  // AN EXPANDER the reader asked for (a request's details) pushes the rows under it down, but never widens a column: its
  // body adds no width of its own (a 64 KiB statement without a space measured 117 → 576 px for the Statement column)
  const long = { ...REQUESTS[0], query: `select ${"a".repeat(2000)} from orders` };
  const opened = fn<[unknown, unknown?], string>("renderRequests")({ requests: [long], keptDays: 7, before: null }, { isOpen: () => true });
  assert.match(opened, /<tr class="detail"><td colspan="\d+"><div class="detail-body">.*<\/div><\/td><\/tr>/s);
  assert.match(rule("#page-queries tr.detail .detail-body"), /width: 0; min-width: 100%/);
  // the statement's toggle (issue 816): opening from it changes no cell but the two toggles' state and inserts the
  // expanded row alone; its glyph has a fixed width open or closed, and the statement keeps its two-line cut beside it
  const page2 = { requests: REQUESTS, keptDays: 7, before: null };
  const renderReq = fn<[unknown, unknown?], string>("renderRequests");
  const shut = renderReq(page2), open1 = renderReq(page2, { isOpen: (k: string) => k === "request:r-new" });
  const asClosed = (h: string) => h.replace(/<tr class="detail">.*?<\/tr>/s, "").replace(" open>", ">").replace('aria-expanded="true"', 'aria-expanded="false"').replace('aria-hidden="true">−<', 'aria-hidden="true">+<');
  assert.equal(asClosed(open1), shut, "no cell written differently, no row inserted but the expanded one");
  assert.match(rule("button.expand"), /flex: none;[^}]*width: 14px; height: 14px;/, "the toggle's room is fixed, + or −");
  assert.match(rule("#page-queries table.requests .stmt-line > code.stmt"), /min-width: 0/, "the statement gives the room, cut as before");
  assert.match(rule("code.stmt"), /-webkit-line-clamp: 2;/, "two lines at most");
});

test("an answer beside its button stays up until it is dismissed — Dismiss, Escape, or the next action's answer or question — as a refusal does (issue 811)", async () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  assert.equal((page as Record<string, unknown>).OUTCOME_MS, undefined, "no answer goes by itself: no time it is shown for");
  const synced = { at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] };
  const hour = 3_600_000;
  const shown = (o: Record<string, unknown>) => popsOf(renderTables(CATALOG_STATE, { ...o, now: Date.now() + hour })).length;
  assert.equal(shown({ synced: { table: "public.customers", synced } }), 1, "a sync's answer, an hour on");
  assert.match(renderTables(CATALOG_STATE, { synced: { table: "public.customers", synced }, now: Date.now() + hour }), />Synced ✓<\/button>/, "the button says it meanwhile");
  assert.equal(shown({ outcome: { table: "public.accounts", added: PICKED.secret } }), 1, "an add's answer, an hour on");
  assert.equal(shown({ synced: { table: "public.customers", failure: { code: "refused", message: "no" } } }), 1, "a refusal, as before");
  // the app: each answer stays across polls long after it was given, and goes on Dismiss, on Escape and on the next action
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  let t = Date.parse("2026-10-27T09:05:30.000Z");
  type TablesApp = App & { syncTable(t: string): Promise<boolean>; dismissSynced(): void };
  const app = fn<[unknown, () => Date], TablesApp>("createApp")(run.fetch, () => new Date(t));
  app.show("tables");
  await app.poll();
  const tablesPage = (app as unknown as { pages: Map<string, { dismiss?: () => unknown }> }).pages.get("tables")!;
  const pops = () => popsOf(app.view().tables!);
  const later = async () => { t += hour; await app.poll(); };
  // a sync's answer: an hour of polls on, still said; Dismiss takes it
  run.answers.set("POST api/sync", answer(synced));
  await app.syncTable("public.customers");
  await later();
  assert.deepEqual(pops().map((p) => p.anchor), ["act-tables-public.customers"], "a sync's answer, an hour of polls on");
  app.dismissSynced();
  assert.equal(pops().length, 0, "gone on Dismiss");
  // an add's answer: still said an hour on; Escape (the page's dismiss) takes it
  run.answers.set("POST api/pick", answer({ ...PICKED.secret, state: CATALOG_STATE }));
  assert.equal(await app.addTable("public.accounts"), true);
  await later();
  assert.deepEqual(pops().map((p) => p.anchor), ["act-tables-public.accounts"], "an add's answer, an hour on");
  assert.equal(tablesPage.dismiss!(), true, "Escape dismisses it");
  assert.equal(pops().length, 0, "gone on Escape");
  assert.equal(tablesPage.dismiss!(), null, "nothing shown: Escape has nothing to dismiss");
  // the next action's answer takes the last one's place, and so does its question
  await app.syncTable("public.customers");
  await later();
  run.answers.set("POST api/sync", answer({ ...synced, tables: [{ ...synced.tables[0]!, table: "public.orders" }] }));
  await app.syncTable("public.orders");
  assert.deepEqual(pops().map((p) => p.anchor), ["act-tables-public.orders"], "the next sync's answer in the last one's place");
  app.askRemoveTable("public.customers");
  assert.deepEqual(pops().map((p) => p.anchor), ["act-tables-public.customers"], "a question takes the answer away");
  assert.match(pops()[0]!.html, /^<div class="pop ask"/);
});

test("Escape with no question open dismisses the answer beside a button, in the browser: the shell asks the page shown to dismiss it (issue 811)", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const { el, on, settle } = fakeBrowser(run, "#tables");
  await settle();
  const press = (key: string) => on.get("keydown")!({ key, preventDefault: () => undefined });
  const click = (dataset: Record<string, string>) => on.get("click")!({ target: { closest: (sel: string) => sel === "button" ? { dataset } : null } });
  run.answers.set("POST api/sync", answer({ at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] }));
  await click({ syncTable: "public.customers" });
  await settle();
  assert.match(el("tables").html, /Synced public\.customers:/, "the answer, said");
  press("Escape");
  await settle();
  assert.ok(!/Synced public\.customers:/.test(el("tables").html), "Escape took it");
});

test("every added table has its bar on the Tables page, as mason status draws one for each: full when copied, red when failed, amber when not kept current, the shimmer while waiting", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const tableLine = fn<[unknown], { state: string; fraction: number; what: string }>("tableLine");
  const percent = fn<[number], string>("percent");
  for (const s of [RUNNING, COPYING, FAILED, SYNCED]) {
    const html = renderTables(s);
    for (const t of s.tables.filter((x) => x.added)) {
      const l = tableLine(t);
      const row = html.split("<tr").find((r) => r.includes(`<code class="name" title="${t.table}">`)) ?? assert.fail(t.table);
      assert.match(row, new RegExp(`<span class="copyline t-${l.state}"><span class="copybar`), `${t.table}: its bar, the line's state ${l.state}`);
      if (l.state !== "waiting") assert.ok(row.includes(`<span class="pct">${percent(l.fraction)}</span>`), `${t.table}: the % mason status prints beside it`);
    }
    // the words beside a bar that is not full and current are mason status's line, under the row
    const cli = commands.tableLines(s).map((x) => /^(\S+)\s+[█░]+\s+(\d+%) {2}(.*)$/.exec(x)!.slice(1));
    for (const [table, pct, what] of cli) {
      const t = s.tables.find((x) => x.table === table)!;
      if (tableLine(t).state === "done" || t.error) continue;
      assert.ok(textOf(html).includes(what!), `${table} ${pct}: ${what}`);
    }
  }
  assert.ok(!/class="copybar/.test(renderTables(NONE)), "a table not added has no bar");
});

test("the time range past a week: 30 and 90 days, a day a point, offered when the run keeps them, shown disabled with why and the setting when it does not", () => {
  const renderSubnav = fn<[string, string?, number?], string>("renderSubnav");
  const RANGES = (page as Record<string, unknown>).RANGES as Record<string, { since: string; stepSeconds: number; days: number }>;
  assert.deepEqual(Object.keys(RANGES), ["now", "1h", "24h", "7d", "30d", "90d"]);
  assert.deepEqual([RANGES["30d"]!.stepSeconds, RANGES["90d"]!.stepSeconds], [86_400, 86_400], "a day a point: 30 and 90 of them");
  assert.equal(fn<[string], string>("usagePath")("90d"), "api/usage?since=90d&step=86400");
  assert.equal(textOf(renderSubnav("usage", "24h")), "Now Last hour 24 hours 7 days Refresh", "a run that has not said what it keeps: no range it could not tell");
  const kept7 = renderSubnav("usage", "24h", 7);
  assert.match(kept7, /<span class="off" aria-disabled="true" title="Mason keeps 7 days of history: MASON_HISTORY_DAYS=30 keeps 30">30 days<span class="sr"> \(Mason keeps 7 days of history: MASON_HISTORY_DAYS=30 keeps 30\)<\/span><\/span>/);
  assert.ok(!/href="[^"]*range=30d"/.test(kept7) && !/href="[^"]*range=90d"/.test(kept7), "never a link to more than is kept");
  const kept30 = renderSubnav("usage", "24h", 30);
  assert.match(kept30, /<a href="#observability\/usage\?range=30d">30 days<\/a>/);
  assert.match(kept30, /title="Mason keeps 30 days of history: MASON_HISTORY_DAYS=90 keeps 90">90 days/);
  assert.match(renderSubnav("syncs", "90d", 90), /<a href="#observability\/syncs\?range=90d" aria-current="true">90 days<\/a>/);
  // a bookmark of 90 days on a run that keeps 7 still lands on it (the log says what it keeps)
  assert.match(renderSubnav("queries", "90d", 7), /aria-current="true">90 days<\/a>/);
  // every view reads the range's since: the cards of 30 and 90 days are their own window (GET /api/activity), never the week's
  assert.equal(of<[string], string>(usagePage, "usage.js", "activityPath")("90d"), "api/activity?since=90d");
  assert.match(of<[unknown, unknown, string], string>(queriesPage, "queries.js", "requestsPath")({ status: "", since: "", user: "", client: "", slow: false, search: "" }, null, "30d"), /since=30d/);
  // the run says what it keeps, in the state the shell reads
  assert.equal(stateOf([], { keptDays: 90 }).engine.keptDays, 90);
  // the CLI's --since takes the same ages
  for (const age of ["30d", "90d"]) assert.equal(typeof timeOf("--since", age, Date.parse("2026-10-29T00:00:00Z")), "string", age);
});

test("Sync events' filters list every kind and every added table, whatever the range read; a table with none says so by its name", () => {
  const renderEventFilters = of<[unknown, Record<string, string>, unknown], string>(syncsPage, "syncs.js", "renderEventFilters");
  const renderEvents = of<[unknown, Record<string, unknown>], string>(syncsPage, "syncs.js", "renderEvents");
  assert.deepEqual((syncsPage as Record<string, unknown>).EVENT_KINDS, [...EVENT_KINDS], "the page's kinds are src/duck/events.ts's");
  const only = { events: [{ at: "2026-10-28T09:00:00.000Z", kind: "copied", failed: false, table: "public.orders", message: "copied" }], keptDays: 7 };
  const text = textOf(renderEventFilters(only, { kind: "", table: "" }, RUNNING));
  assert.equal(text, `Kind Every kind ${EVENT_KINDS.join(" ")} Table Every table (the sync) public.customers public.events public.orders`);
  // a removed table's events keep it a choice; nothing read yet still lists the added tables
  assert.match(textOf(renderEventFilters({ events: [{ ...only.events[0], table: "public.gone" }], keptDays: 7 }, {}, RUNNING)), /public\.orders public\.gone$/);
  assert.match(textOf(renderEventFilters(undefined, {}, RUNNING)), /Every table \(the sync\) public\.customers public\.events public\.orders$/);
  assert.equal(textOf(renderEvents(only, { table: "public.customers", span: "the last 24 hours" })), "No events for public.customers in the last 24 hours (the events are kept 7 days: MASON_HISTORY_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { table: "public.customers", span: "the last 24 hours" })), "No events for public.customers in the last 24 hours (the events are kept 7 days: MASON_HISTORY_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { span: "the last 24 hours" })), "No sync event in the last 24 hours (the events are kept 7 days: MASON_HISTORY_DAYS).");
});

test("Sync events: #observability/syncs?table= (a table's View events) narrows the events to it, the Table filter showing it; ?failures=1 the failures; a link without either keeps what was chosen", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  run.answers.set("GET api/state", answer(RUNNING));
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { model: { table: string; failuresOnly: boolean; kind: string } }> }>("createApp")(run.fetch, () => new Date("2026-10-28T09:10:00.000Z"));
  const box = { checked: false };
  const doc = { getElementById: (id: string) => id === "syncs-failures-only" ? box : null };
  // the Tables page's View events is this address (tables.js syncsHref)
  const syncsHref = (await import(path.join(WEB, "pages", "tables.js") as string) as { syncsHref: (t: string) => string }).syncsHref;
  app.show(syncsHref("public.events"), { doc });
  await app.poll();
  const m = app.pages.get("syncs")!.model;
  assert.deepEqual([m.table, m.failuresOnly], ["public.events", false]);
  assert.match(app.view()["syncs-filters"]!, /<option value="public\.events" selected>public\.events<\/option>/, "the Table filter shows it");
  assert.match(textOf(app.view()["syncs-events"]!), /^1 of the 3 events read\. When ↓ Kind Table Message 9 min ago ✗ copy_failed public\.events /, "its events alone");
  // the Overview's sync errors: the failures of every table over the week, the box ticked
  app.show("#observability/syncs?failures=1&range=7d", { doc });
  assert.deepEqual([m.table, m.failuresOnly, box.checked], ["", true, true]);
  assert.match(textOf(app.view()["syncs-events"]!), /^2 of the 3 events read\./);
  // a change of range (the nav's links carry no filter) keeps the filters chosen
  app.show("#observability/syncs?range=1h", { doc });
  assert.deepEqual([m.table, m.failuresOnly], ["", true]);
  // the old addresses land here too, with their parameters
  app.show("#logs?table=public.orders", { doc });
  assert.equal(m.table, "public.orders");
});

test("a past range's 'as of' is its own read's, never another page's; a Refresh asked while a poll is in flight runs when it ends", async () => {
  // the as-of: cleared by a page or range shown, set once that page's own once-only reads are answered
  const run = fakeRun(); withUsageAnswers(run);
  const at = new Date("2026-10-28T09:10:00.000Z");
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => at);
  app.show("observability/usage?range=1h");
  await app.poll();
  assert.match(app.view()["range-usage"]!, /as of 09:10:00 UTC/);
  app.show("observability/queries?range=1h");
  assert.ok(!/as of/.test(app.view()["range-queries"]!), "Queries not read yet: no as-of (Usage's was 09:10:00)");
  await app.poll();
  assert.match(app.view()["range-queries"]!, /as of 09:10:00 UTC/);
  // Refresh while a poll is in flight: held, then run — never dropped (the poll in flight read the state alone)
  const run2 = fakeRun(); withUsageAnswers(run2);
  let release: () => void = () => undefined;
  let hold: Promise<void> | null = null;
  const plain = run2.fetch;
  run2.fetch = async (p, init) => { if (hold !== null && p === "api/state") await hold; return plain(p, init); };
  const { on, settle, tick } = fakeBrowser(run2, "#observability/usage?range=1h");
  await settle();
  hold = new Promise<void>((r) => { release = r; });
  tick();                                   // a poll in flight: the shell's state, held
  run2.asked.length = 0;
  const clicked = on.get("click")!({ target: { closest: () => ({ dataset: { refreshRange: "" } }) } });
  release(); hold = null;
  await clicked; await settle();
  assert.ok((run2.asked as string[]).includes("GET api/activity?since=1h"), `the Refresh ran once the poll ended: ${run2.asked.join(", ")}`);
});

test("a request's + opens on its click: the toggle event a repaint strands (the live log's ages move every second) is never needed", async () => {
  // found in the browser: of six clicks on a request's id, three opened nothing — the pointerup's repaint replaced the
  // details (its ages had moved), and the toggle event, fired on the replaced element, never reached the document
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  const { el, on, settle } = fakeBrowser(run, "#observability/queries");
  await settle();
  assert.match(el("request-log").html, /data-open="request:r-new"/);
  assert.ok(!/<tr class="detail">/.test(el("request-log").html), "closed at first");
  // the click on the summary: the toggle handler is NOT called (as when the event is stranded)
  let prevented = false;
  const det = { tagName: "DETAILS", id: "", open: false, dataset: { open: "request:r-new" } };
  const summary = { parentElement: det };
  await on.get("click")!({ target: { closest: (sel: string) => sel === "summary" ? summary : null }, preventDefault: () => { prevented = true; } });
  assert.match(el("request-log").html, /<details data-open="request:r-new" open>/, "open, from the click alone");
  assert.match(el("request-log").html, /<tr class="detail">/);
  assert.ok(prevented, "the browser's own toggle is not run as well");
  // clicked again: closed
  await on.get("click")!({ target: { closest: (sel: string) => sel === "summary" ? { parentElement: { ...det, open: true } } : null }, preventDefault: () => undefined });
  assert.ok(!/<tr class="detail">/.test(el("request-log").html), "closed again");
});

test("the statement cell's toggle opens the same expanded row as the id's: one key, one open state, both toggles say it (issue 816)", async () => {
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const page = { requests: REQUESTS, keptDays: 7, before: null };
  const closed = renderRequests(page);
  // the statement cell: the two-line statement and, beside it, a real control named for what it opens, closed
  for (const id of ["r-new", "r-old"]) {
    assert.match(closed, new RegExp(`<td class="stmt-cell"><div class="stmt-line"><code class="stmt"[^>]*>[^<]*</code><button type="button" class="expand" data-expand="request:${id}" aria-expanded="false" aria-label="Show the whole statement" title="Show the whole statement"><span aria-hidden="true">\\+</span></button></div>`),
      `${id}: the statement's toggle, keyed as the id's details`);
  }
  assert.equal(textOf(closed).includes("Show the whole statement"), false, "the control's name is its aria-label, its label the + the id's summary draws");
  assert.match(closed, /<\/code><button [^>]*><span aria-hidden="true">\+<\/span><\/button>/);
  // opened (from either: one open state): both toggles say so, and the expanded row is written once
  const opened = renderRequests(page, { isOpen: (k: string) => k === "request:r-old" });
  assert.match(opened, /<details data-open="request:r-old" open><summary>r-old<\/summary><\/details>/, "the id's toggle open");
  assert.match(opened, /data-expand="request:r-old" aria-expanded="true"[^>]*><span aria-hidden="true">−<\/span>/, "the statement's toggle open, its label −");
  assert.match(opened, /data-expand="request:r-new" aria-expanded="false"/, "the other row's still closed");
  assert.equal([...opened.matchAll(/<tr class="detail">/g)].length, 1, "one expanded row");

  // the page: a press on the statement's toggle opens the row and the id's summary with it; the id's summary then closes both
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  const { el, on, settle } = fakeBrowser(run, "#observability/queries");
  await settle();
  const press = (key: string) => on.get("click")!({ target: { closest: (sel: string) => sel === "button" ? { dataset: { expand: key } } : null }, preventDefault: () => undefined });
  await press("request:r-new");
  const log = () => el("request-log").html;
  assert.match(log(), /<details data-open="request:r-new" open>/, "the id's toggle says open");
  assert.match(log(), /data-expand="request:r-new" aria-expanded="true"/, "and so does the statement's");
  assert.match(log(), /<tr class="detail">.*<dt>Query id<\/dt><dd>r-new<\/dd>/s, "the expanded row written");
  const det = { tagName: "DETAILS", id: "", open: true, dataset: { open: "request:r-new" } };
  await on.get("click")!({ target: { closest: (sel: string) => sel === "summary" ? { parentElement: det } : null }, preventDefault: () => undefined });
  assert.ok(!/<tr class="detail">/.test(log()), "the id's summary closes the row the statement's toggle opened");
  assert.match(log(), /data-expand="request:r-new" aria-expanded="false"/, "and the statement's toggle says closed");
  await press("request:r-new"); await press("request:r-new");
  assert.ok(!/<tr class="detail">/.test(log()), "the statement's toggle closes it too");
});

test("a toggle keeps the focus when a poll writes its row again: the statement's button, the id's summary (issue 816; issue 70's probe)", async (t) => {
  let at = Date.parse("2026-10-28T09:05:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  const { el, doc, tick, settle } = fakeBrowser(run, "#observability/queries");
  await settle();
  const log = el("request-log") as unknown as { writes: number; querySelectorAll?: (s: string) => unknown[] };
  const focused: string[] = [];
  const button = (key: string) => ({ tagName: "BUTTON", dataset: { expand: key }, focus: () => { focused.push(`expand ${key}`); } });
  const summary = (key: string) => ({ tagName: "SUMMARY", dataset: {}, parentElement: { dataset: { open: key } }, focus: () => { focused.push(`summary ${key}`); } });
  // the part as the browser would have it after a rewrite: each row's two toggles
  log.querySelectorAll = (sel: string) => sel === "details[data-open] > summary, button[data-expand]" ? ["request:r-new", "request:r-old"].flatMap((k) => [summary(k), button(k)]) : [];
  const d = doc as unknown as { activeElement: unknown };
  for (const [active, expected] of [[{ ...button("request:r-old"), in: "request-log" }, "expand request:r-old"], [{ ...summary("request:r-new"), in: "request-log" }, "summary request:r-new"]] as const) {
    d.activeElement = active;
    focused.length = 0;
    const writes = log.writes;
    // the log changed: the poll writes the part again
    run.answers.set("GET api/requests?since=15m", answer({ requests: [...REQUESTS, { ...REQUESTS[1], requestId: `r-${writes}` }], keptDays: 7, before: null }));
    t.mock.timers.setTime(at += 6000);
    tick(); await settle();
    assert.ok(log.writes > writes, "written again");
    assert.deepEqual(focused, [expected], "the focus back on the control that held it");
  }
  // the focus elsewhere (outside the part): nothing focused
  d.activeElement = { in: "sidebar", tagName: "A", dataset: {} };
  focused.length = 0;
  run.answers.set("GET api/requests?since=15m", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  t.mock.timers.setTime(at += 6000);
  tick(); await settle();
  assert.deepEqual(focused, []);
});

test("a summary's click: a link inside it keeps its own click, a details no page keeps is the browser's, an element disagreeing with the state is written again, the raw log opens", async () => {
  const run = fakeRun();
  run.answers.set("GET api/requests?since=15m", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  const { el, on, settle, go } = fakeBrowser(run, "#observability/queries");
  await settle();
  const click = async (det: object, extra: (sel: string) => unknown = () => null) => {
    let prevented = false;
    await on.get("click")!({ target: { closest: (sel: string) => sel === "summary" ? { parentElement: det } : extra(sel) }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const keyed = { tagName: "DETAILS", id: "", open: false, dataset: { open: "request:r-new" } };
  // a link (or a box) inside the summary: not the details' click
  assert.equal(await click(keyed, (sel) => sel.startsWith("a,") ? { href: "#" } : null), false, "the link's default is not prevented");
  assert.ok(!/<tr class="detail">/.test(el("request-log").html), "and the details did not open");
  // a details no page keeps state of: the browser opens it, as ever
  assert.equal(await click({ tagName: "DETAILS", id: "", open: false, dataset: {} }), false);
  // the element shows open, the state says closed: the click asks for closed, which the state already is — still
  // answered, and the part written again from the state (closed), never left to the browser's toggle
  const writes = el("request-log").writes;
  assert.equal(await click({ ...keyed, open: true, in: "request-log" }), true, "prevented: not the browser's own toggle");
  assert.ok(el("request-log").writes > writes, "written again though its HTML did not change");
  assert.ok(!/<tr class="detail">/.test(el("request-log").html));
  // the raw log of Sync events (kept by its id, not a key): opened by the click, and read
  run.answers.set("GET api/events?limit=500&since=15m", answer(EVENTS));
  go("#observability/syncs"); await settle();
  run.asked.length = 0;
  assert.equal(await click({ tagName: "DETAILS", id: "syncs-raw", open: false, dataset: {} }), true);
  await settle();
  assert.ok((run.asked as string[]).includes("GET api/logs?lines=200"), `the raw log read: ${run.asked.join(", ")}`);
  assert.match(el("syncs-run").html, /<details id="syncs-raw" open>/, "open, from the click alone");
});

test("only the clock moved: the ages are set where they are, the part not written again (a rewrite each second dropped a selection, the focus, a click)", async (t) => {
  // the page's clock is the global Date (`new Date()` in `start`), so the test holds it: a stalled machine moves no age
  const at = Date.parse("2026-10-31T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const run = fakeRun();
  const fresh = { ...REQUESTS[0]!, startedAt: new Date(at - 5000).toISOString() };
  run.answers.set("GET api/requests?since=15m", answer({ requests: [fresh], keptDays: 7, before: null }));
  const { el, tick, settle } = fakeBrowser(run, "#observability/queries");
  await settle();
  const log = el("request-log") as unknown as { writes: number; html: string; querySelectorAll?: (s: string) => { innerHTML: string }[] };
  assert.match(log.html, /<time data-tick [^>]*>5s ago<\/time>/);
  const shown = [{ innerHTML: /<time data-tick [^>]*>(\ds ago)</.exec(log.html)![1]! }];
  log.querySelectorAll = (sel: string) => sel === "time[data-tick]" ? shown : [];
  const writes = log.writes;
  t.mock.timers.setTime(at + 2000);
  tick(); await settle();
  assert.equal(log.writes, writes, "not written again");
  assert.equal(shown[0]!.innerHTML, "7s ago", "the age moved where it is");
});

// ------------------------------------------------------------------ Connect from anywhere (the page's mason share)

const SHARE_AT = "2026-11-01T10:00:00.000Z";
const SHARE_NOW = Date.parse("2026-11-01T10:05:00.000Z");
const PASSWORD = `mason_share_${"ab".repeat(24)}`;
const listed = { user: "share_a1b2c3", from: "page", role: null, reads: "every synced table", openedAt: SHARE_AT, via: "pinggy", host: "relay.example", port: 41234, endsAt: "2026-11-01T11:00:00.000Z", state: "up" };
const sharing = (shares: unknown[], o: Record<string, unknown> = {}) => ({ ...RUNNING, share: shares.length ? { port: 40001, fingerprint: "AA", sessions: 0, refusedLogins: 0, droppedConnections: 0, shares } : null, shareEnded: null, ...o });
const shareModel = (o: Record<string, unknown> = {}) => ({ phase: "none", choices: null, reads: null, role: null, opened: null, ended: null, failure: null, ...o });
const renderShare = (s: unknown, m: unknown) => fn<[unknown, unknown, number], string>("renderShare")(s, m, SHARE_NOW);

test("Connect from anywhere: the card in each state, as it WROTE it — none, asking (one role, two), opening, open, open after a reload, ended, refused, served", () => {
  const none = textOf(renderShare(sharing([]), shareModel()));
  assert.match(none, /Connect from anywhere/);
  assert.match(none, /a temporary public address and a password, as mason share opens\. TLS is required of every connection/);
  assert.match(fn<[unknown, unknown?], string>("renderStatus")(sharing([]), { now: NOW, queries: QUERIES }), /data-share-ask/, "the Overview's Connect card offers it beside the local connection");

  const asking = textOf(renderShare(sharing([]), shareModel({ phase: "asking", choices: [], reads: "every synced table" })));
  assert.match(asking, /This opens a temporary public address : anyone with it and its password reads every synced table\. A free share ends within about an hour, and when this page closes\./);
  assert.match(asking, /Open the address/);
  assert.doesNotMatch(renderShare(sharing([]), shareModel({ phase: "asking", choices: [] })), /<select/, "one answer: no picker");
  const two = renderShare(sharing([]), shareModel({ phase: "asking", choices: [{ role: "sales", reads: "1 synced table: orders", default: true }, { role: "ops", reads: "every synced table", default: false }], role: "sales" }));
  assert.match(two, /<select id="share-role"><option value="sales" selected>sales: 1 synced table: orders \(the file&#39;s default\)<\/option><option value="ops">ops: every synced table<\/option><\/select>/);
  assert.match(textOf(renderShare(sharing([]), shareModel({ phase: "asking" }))), /Reading the roles…/);

  assert.match(textOf(renderShare(sharing([]), shareModel({ phase: "opening" }))), /Opening a temporary public address… \(up to 30 s\)/);

  const opened = { user: "share_a1b2c3", password: PASSWORD, database: "shop", host: "relay.example", port: 41234 };
  const open = renderShare(sharing([listed]), shareModel({ phase: "open", opened }));
  for (const [id, v] of [["share-host", "relay.example"], ["share-port", "41234"], ["share-user", "share_a1b2c3"], ["share-password", PASSWORD]]) {
    assert.match(open, new RegExp(`<code id="${id}">${v}</code> <button type="button" class="small" data-copy="${id}"`), `${id} with its Copy`);
  }
  const openText = textOf(open);
  assert.match(openText, /Shared Public for 5 min : every synced table/);
  assert.match(openText, /SSL mode require/);
  assert.match(openText, /the password is shown this once, is kept nowhere, and ends with the share/);
  assert.match(openText, /A free share ends within about an hour: at .+, in about 55 minutes\./);
  assert.match(openText, /It also ends within two minutes of this page closing\./);
  assert.match(open, /data-share-stop="share_a1b2c3"[^>]*>Stop sharing</);

  const reloaded = renderShare(sharing([listed]), shareModel());
  assert.ok(!reloaded.includes(PASSWORD) && !reloaded.includes("share-password"), "after a reload the password is nowhere on the page");
  assert.match(textOf(reloaded), /The password was shown once, when it opened, and is kept nowhere/);
  assert.match(reloaded, /Stop sharing/);

  const ended = textOf(renderShare(sharing([]), shareModel({ phase: "ended", ended: { user: "share_a1b2c3", why: "its tunnel closed (ssh exited 255)" } })));
  assert.match(ended, /The share ended: its tunnel closed \(ssh exited 255\)\. Its address no longer answers, and its password no longer works\./);
  assert.match(ended, /Connect from anywhere/);

  const failure = { code: "not_found", message: "ssh is not on this machine, and Connect from anywhere needs it", fix: "install the OpenSSH client, then Connect from anywhere again", next: [{ command: "mason doctor", what: "checks this machine" }] };
  const refused = renderShare(sharing([]), shareModel({ phase: "refused", failure }));
  assert.ok(refused.includes(fn<[unknown], string>("renderFailure")(failure)), "a refusal is the CLI's Failure, rendered by renderFailure");

  for (const m of [shareModel(), shareModel({ phase: "open", opened })]) assert.equal(renderShare(sharing([listed], { served: true }), m), "", "under mason serve: absent");
  assert.doesNotMatch(fn<[unknown, unknown?], string>("renderStatus")({ ...sharing([]), served: true }, { now: NOW, queries: QUERIES }), /share-ask|Connect from anywhere/, "nor on a served Overview");

  // every word the card writes: no tunnel's provider, no engine
  for (const html of [none, asking, two, openText, reloaded, ended, refused]) assert.doesNotMatch(textOf(html), /pinggy|bore\b|duck/i);
});

test("Connect from anywhere over a fake run: asked once, opened confirmed with the role chosen, beaten on a timer of its own, its end said and its password dropped", async () => {
  const asked: Array<[string, string | undefined, unknown]> = [];
  let state: unknown = sharing([]);
  const answers: Record<string, unknown> = {
    "GET api/share/choices": { body: { choices: [{ role: "sales", reads: "1 synced table: orders", default: false }, { role: "ops", reads: "every synced table", default: true }] } },
    "POST api/share": { body: { user: "share_a1b2c3", host: "relay.example", port: 41234, database: "shop", password: PASSWORD, beatMs: 15_000 } },
    "POST api/share/share_a1b2c3/beat": { body: { ok: true } },
  };
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const ctx = {
    ask: async (p: string, init?: { method?: string; body?: string }) => { asked.push([p, init?.method, init?.body === undefined ? undefined : JSON.parse(init.body)]); return answers[`${init?.method ?? "GET"} ${p}`]; },
    read: () => ({ body: state, failure: null }), refresh: async () => undefined, now: () => new Date(SHARE_NOW),
    timers: { setInterval: (f: () => void, ms: number) => { intervals.push({ fn: f, ms, cleared: false }); return intervals.length - 1; }, clearInterval: (i: number) => { intervals[i]!.cleared = true; } },
  };
  const share = fn<[unknown], { m: Record<string, unknown>; actions: Record<string, (...a: unknown[]) => Promise<void> | void>; afterRead: (s: unknown) => void; click: (d: Record<string, string>) => unknown; input: (t: unknown) => unknown }>("createShare")(ctx);
  await share.click({ shareAsk: "" });
  assert.equal(share.m.phase, "asking");
  assert.equal(share.m.role, "ops", "the file's default chosen first");
  share.input({ id: "share-role", value: "sales" });
  await share.click({ shareOpen: "" });
  assert.deepEqual(asked.find(([p, m]) => p === "api/share" && m === "POST")?.[2], { from: "page", confirmed: true, role: "sales" }, "confirmed, the role chosen");
  assert.equal(share.m.phase, "open");
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]!.ms, 15_000);
  // a state read before the open lists nothing: never taken for its end
  share.afterRead(sharing([]));
  assert.equal(share.m.phase, "open");
  state = sharing([listed]);
  share.afterRead(state);
  intervals[0]!.fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(asked.some(([p, m]) => p === "api/share/share_a1b2c3/beat" && m === "POST"), "the beat");
  // the run ended it (the tunnel closed): the next state says so, and the password leaves the page's memory
  state = sharing([], { shareEnded: { user: "share_a1b2c3", from: "page", why: "its tunnel closed (ssh exited 255)", at: SHARE_AT } });
  share.afterRead(state);
  assert.equal(share.m.phase, "ended");
  assert.deepEqual(share.m.ended, { user: "share_a1b2c3", why: "its tunnel closed (ssh exited 255)" });
  assert.equal(share.m.opened, null);
  assert.ok(!JSON.stringify(share.m).includes(PASSWORD));
  assert.equal(intervals[0]!.cleared, true, "no more beats");
  // a reload over an open share: it is beaten again, its password not shown
  const again = fn<[unknown], { m: Record<string, unknown>; afterRead: (s: unknown) => void }>("createShare")(ctx);
  again.afterRead(sharing([listed]));
  assert.equal(again.m.phase, "open");
  assert.equal(intervals.length, 2);
  // Stop sharing: DELETE, the beats end
  answers["DELETE api/share/share_a1b2c3"] = { body: { ok: true } };
  await (again as unknown as { actions: Record<string, (u: string) => Promise<void>> }).actions.shareStop!("share_a1b2c3");
  assert.equal(again.m.phase, "ended");
  assert.equal(intervals[1]!.cleared, true);
});

// ------------------------------------------------------------------ the host's views and card (issue 814)

/** A host's view as a site supplies it: every string a trap a renderer that writes HTML would fall into. */
const HOST_VIEW = {
  title: "Server <b>one</b>",
  refresh: 30,
  sections: [
    { heading: "Status", facts: [{ label: "State", value: "running", status: "ok" }, { label: "Version <script>alert(1)</script>", value: "<script>alert(2)</script>" },
      { label: "Host", value: "db.example.com", copy: true }, { label: "Disk", value: "nearly full", status: "warn" }],
      text: "Line one\n<img src=x onerror=alert(3)>", links: [{ label: "Upgrade", url: "/console/upgrade", primary: true }, { label: "Bad", url: "javascript:alert(4)" },
        { label: "Docs <i>", url: "https://docs.example.com/a?b=1&c=2" }, { label: "Not one", url: "not a url" }] },
    { heading: "<img src=x onerror=alert(5)>" },
  ],
};
/** A host's card for the Overview. */
const HOST_CARD = { title: "Plan <u>", sections: [{ heading: "Plan", facts: [{ label: "Tier", value: "<img src=x onerror=alert(6)>" }, { label: "Status", value: "Upgrade available", status: "warn" }],
  links: [{ label: "Upgrade", url: "/console/plan" }] }] };
/** The host's sidebar with a link and two views (#host/2 and #host/3). */
const HOST_NAV = { items: {}, links: [{ label: "Billing", url: "/billing" }, { label: "Server", view: "host/status.json" }, { label: "<img src=x onerror=alert(7)>", view: "host/plans.json" }] };

/** A fake run whose host answers `host/…` too: the page asks it relative to its own address, as it asks api/… . */
function hostRun(state: unknown, host: Record<string, () => Response>) {
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(state), { status: 200 }));
  const fetch = async (p: string, init?: { method?: string; body?: string }): Promise<Response> => {
    if (!p.startsWith("host/")) return run.fetch(p, init);
    assert.equal(init?.method ?? "GET", "GET", "a host's view is only ever read");
    run.asked.push(`GET ${p}`);
    const a = host[p];
    if (a === undefined) throw new TypeError("fetch failed");
    return a();
  };
  return { ...run, fetch };
}
const jsonAnswer = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });

test("a host's link is read in the page as the link back is on the server: hostLinkUrl accepts nothing src/cli/ui-back-link.ts linkUrl refuses, serialises what both take the same, and refuses a host with a % or a space whatever the URL parser does", async () => {
  const { linkUrl } = await import("../src/cli/ui-back-link.ts");
  const hostLinkUrl = fn<[unknown], string | null>("hostLinkUrl");
  const server = (v: string) => { const r = linkUrl(v, "x", "y"); return typeof r === "string" ? r : null; };
  // what both take, the same
  const taken = ["/billing", "/a/../b", "/console/db/users?tab=1#x", "/a?q='1'&r=<2>", "/%2e%2e/x", "https://Console.Example.com", "HTTPS://console.example.com/a/../b?x=1#y",
    "http://console.example.com:8080/p", "https://xn--bcher-kva.example/", "https://[::1]:8443/x", "https://console.example.com/%zz", "https://1.2.3.4/", "https://console.example.com./"];
  for (const v of taken) { assert.notEqual(server(v), null, v); assert.equal(hostLinkUrl(v), server(v), v); }
  // what the page refuses: every one linkUrl refuses, and a host it does not write by the strict pattern
  const refused = ["/.//evil.example.com", "//evil.example.com/x", "/\\evil.example.com", "/a\tb", "/a b", "/a\u0000b", "/é", `/${"a".repeat(2048)}`, "javascript:alert(1)",
    "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "billing", "", "not a url", "https://admin:hunter2@console.example.com/", "https://admin@console.example.com/",
    "https:console.example.com", "https://", "https:///x", "ftp://console.example.com/", "mailto:a@example.com", "https://a_b.example/", "https://-a.example/"];
  // a % in each place of a host, every byte: Chromium's parser took some of these that Node's refuses (https://a%20b)
  const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0"));
  const pct = hex.flatMap((x) => [`https://%${x}a.example/`, `https://a%${x}.example/`, `https://a.example%${x}/`, `https://a%${x}b/`, `https://[::1%${x}]/`, `http://%${x}/`,
    `https://a.example:%${x}/`, `https://a.example:80%${x}/`]);
  for (const v of [...refused, ...pct]) assert.equal(hostLinkUrl(v), null, v);
  // never more than linkUrl takes, never serialised otherwise
  for (const v of [...taken, ...refused, ...pct]) { const page = hostLinkUrl(v); assert.ok(page === null || page === server(v), v); }
  // THE SAME, UNDER A PARSER THAT TAKES ANY HOST (as a browser's may): the page's own check refuses each, not the parser
  const RealURL = globalThis.URL;
  class LenientURL {
    href: string; host: string; hostname: string; username = ""; password = ""; origin: string; pathname: string; search = ""; hash = "";
    constructor(v: string, base?: string) {
      if (base !== undefined) { const u = new RealURL(v, base); this.href = u.href; this.host = u.host; this.hostname = u.hostname; this.origin = u.origin; this.pathname = u.pathname; this.search = u.search; this.hash = u.hash; return; }
      const host = /^[a-z]+:\/\/([^/?#]*)/i.exec(v)?.[1] ?? "";
      this.host = host; this.hostname = host.replace(/:[^\]]*$/, ""); this.href = v.endsWith("/") ? v : `${v}/`; this.origin = ""; this.pathname = "/";
    }
  }
  try {
    (globalThis as { URL: unknown }).URL = LenientURL;
    for (const v of [...pct, "https://a%20b", "https://%20evil.example", "https://[::1%30]/", "https://a b.example/", "https://admin@console.example.com/"]) assert.equal(hostLinkUrl(v), null, `lenient: ${v}`);
  } finally { (globalThis as { URL: unknown }).URL = RealURL; }
  for (const v of [null, 7, { url: "/x" }, ["/x"]]) assert.equal(hostLinkUrl(v), null, "a URL is text");
});

test("a host's view is held to its shape: taken and read whole, refresh held within its bounds, a link that fails the link rules dropped and counted; anything outside the shape refused in words, never quoting a value", () => {
  const hostView = fn<[unknown], { view?: { title: string; refresh: number | null; sections: Array<{ heading: string; facts: unknown[]; text: string | null; links: unknown[]; dropped: number }> }; problem?: string }>("hostView");
  const { view } = hostView(HOST_VIEW);
  assert.ok(view);
  assert.equal(view.title, "Server <b>one</b>");
  assert.equal(view.refresh, 30);
  assert.deepEqual(view.sections[0]!.links, [{ label: "Upgrade", url: "/console/upgrade", primary: true }, { label: "Docs <i>", url: "https://docs.example.com/a?b=1&c=2", primary: false }]);
  assert.equal(view.sections[0]!.dropped, 2, "javascript: and a text that is no URL");
  assert.deepEqual(view.sections[1], { heading: "<img src=x onerror=alert(5)>", facts: [], text: null, links: [], dropped: 0 }, "facts, text and links may be left out");
  const refresh = (r: unknown) => hostView({ title: "t", sections: [], refresh: r }).view?.refresh;
  assert.deepEqual([refresh(1), refresh(5), refresh(29.6), refresh(3600), refresh(999_999), hostView({ title: "t", sections: [] }).view?.refresh], [5, 5, 30, 3600, 3600, null]);
  const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
  const section = (s: Record<string, unknown>) => ({ title: "t", sections: [{ heading: "h", ...s }] });
  const refused: Array<[unknown, string]> = [
    [null, "it is not an object { title, sections }"],
    [[HOST_VIEW], "it is not an object { title, sections }"],
    ["running", "it is not an object { title, sections }"],
    [{ title: "t" }, "its sections is not a list of at most 20"],
    [{ title: "t", sections: {} }, "its sections is not a list of at most 20"],
    [{ title: "t", sections: many(21, () => ({ heading: "h" })) }, "its sections is not a list of at most 20"],
    [{ title: "t", sections: [], html: "<b>x</b>" }, `it has a key a view does not take ("html"): a view is { title, sections, refresh? }`],
    [{ sections: [] }, "its title is not one line of text of at most 200 characters"],
    [{ title: "a\nb", sections: [] }, "its title is not one line of text of at most 200 characters"],
    [{ title: "‮evil", sections: [] }, "its title is not one line of text of at most 200 characters"],
    [{ title: "t".repeat(201), sections: [] }, "its title is not one line of text of at most 200 characters"],
    [{ title: "t", sections: [], refresh: "30" }, "its refresh is not a number of seconds"],
    [{ title: "t", sections: [], refresh: -1 }, "its refresh is not a number of seconds"],
    [{ title: "t", sections: ["x"] }, "sections[0] is not an object { heading, facts, text, links }"],
    [{ title: "t", sections: [{ heading: "h", form: {} }] }, `sections[0] has a key a section does not take ("form"): a section is { heading, facts?, text?, links? }`],
    [{ title: "t", sections: [{}] }, "sections[0].heading is not one line of text of at most 200 characters"],
    [section({ text: 7 }), "sections[0].text is not text of at most 8000 characters"],
    [section({ text: "a\u0007b" }), "sections[0].text is not text of at most 8000 characters"],
    [section({ facts: many(51, () => ({ label: "l", value: "v" })) }), "sections[0].facts is not a list of at most 50"],
    [section({ facts: [{ label: "l", value: 7 }] }), "sections[0].facts[0].value is not one line of text of at most 2000 characters"],
    [section({ facts: [{ label: "l", value: "v", onclick: "x" }] }), "sections[0].facts[0] is not { label, value, copy?, status? }"],
    [section({ facts: [{ label: "l", value: "v", status: "great" }] }), "sections[0].facts[0].status is not ok, warn or bad"],
    [section({ facts: [{ label: "l", value: "v", copy: "yes" }] }), "sections[0].facts[0].copy is not true or false"],
    [section({ links: [{ url: "/x" }] }), "sections[0].links[0].label is not one line of text of at most 200 characters"],
    [section({ links: [{ label: "x", url: "/x", target: "_blank" }] }), "sections[0].links[0] is not { label, url, primary? }"],
    [section({ links: many(21, () => ({ label: "x", url: "/x" })) }), "sections[0].links is not a list of at most 20"],
  ];
  for (const [v, problem] of refused) assert.deepEqual(hostView(v), { problem }, JSON.stringify(v)?.slice(0, 80));
  assert.ok(!hostView({ title: "t", sections: [], ["hunter2‮".repeat(20)]: 1 }).problem!.includes("hunter2"), "a key past a line is not quoted");
});

test("a host's view and card as the page writes them: every string TEXT (a <script>, an <img onerror> stays text), a status its marker and its word, a fact to copy its Copy, a refused link said and never written", () => {
  const hostView = fn<[unknown], { view: unknown }>("hostView");
  const renderHostView = fn<[unknown, string?], string>("renderHostView");
  const renderHostCard = fn<[unknown], string>("renderHostCard");
  const html = renderHostView(hostView(HOST_VIEW).view, "view-2");
  for (const bad of ["<script", "<img", "<b>", "<i>", "javascript:", "not a url"]) assert.ok(!html.includes(bad), `${bad} is never markup, nor a link refused`);
  assert.ok(!/<[^>]*\sonerror=/i.test(html) && !html.includes("javascript:"));
  const text = textOf(html);
  for (const said of ["Status", "State", "running", "Version <script>alert(1)</script>", "<script>alert(2)</script>", "db.example.com", "Line one <img src=x onerror=alert(3)>",
    "Upgrade", "Docs <i>", "<img src=x onerror=alert(5)>", "2 links left out: their URLs are neither a path on this host (/something) nor an https or http URL with its host."]) assert.ok(text.includes(said), said);
  assert.match(html, /<span class="indicator ok"><span class="dot" aria-hidden="true"><\/span>running<\/span>/, "a status is the page's marker beside its word");
  assert.match(html, /<span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>nearly full<\/span>/);
  assert.match(html, /<code id="host-view-2-0-2">db\.example\.com<\/code> <button type="button" class="small" data-copy="host-view-2-0-2"/, "a fact to copy, with its Copy");
  assert.match(html, /<a class="btn small primary" href="\/console\/upgrade" rel="noreferrer">Upgrade<\/a> <a class="btn small" href="https:\/\/docs\.example\.com\/a\?b=1&amp;c=2" rel="noreferrer">Docs &lt;i&gt;<\/a>/,
    "links in the same tab, the primary one the page's primary action, sending no referrer");
  assert.ok(!/<form|<input|data-(?!copy|room)[a-z-]+=/.test(html), "no form and no button but Copy");
  // the card: its title the card's label, its facts as rows, its links; every string text
  const card = renderHostCard({ body: hostView(HOST_CARD).view, failure: null });
  assert.match(card, /^<div class="card host-card"><p class="card-label">Plan &lt;u&gt;<\/p>/);
  assert.ok(!card.includes("<img") && !card.includes("<u>"));
  assert.ok(textOf(card).includes("Tier <img src=x onerror=alert(6)> Status Upgrade available Upgrade"), textOf(card));
  assert.match(card, /<span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>Upgrade available<\/span>/);
  // its failure in the card, the last card read under it; before any read, that it is read
  const failure = { code: "failed", message: "the host's view at host/card.json could not be read", why: "it answered HTTP 404" };
  assert.match(textOf(renderHostCard({ body: hostView(HOST_CARD).view, failure })), /^Plan <u> ✗ the host's view at host\/card\.json could not be read: it answered HTTP 404 Tier/);
  assert.equal(textOf(renderHostCard({ body: undefined, failure })), "The host's card unknown ✗ the host's view at host/card.json could not be read: it answered HTTP 404");
  assert.equal(textOf(renderHostCard(undefined)), "The host's card Reading it…");
});

test("a host's view in the app: its link in the sidebar's host group, current while shown; read when shown and in the same poll the state names it; again every refresh while shown, never once another page is", async () => {
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const run = hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, { "host/status.json": jsonAnswer(HOST_VIEW), "host/plans.json": jsonAnswer({ title: "Plans", sections: [] }) });
  const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(t), "#host/2");
  const asked = async () => { run.asked.length = 0; await app.poll(); await app.settled(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET api/state", "GET host/status.json"], "opened at its address: the state, then the view it names, in one poll");
  const v = app.view();
  assert.equal(v["host-h"], "Server &lt;b&gt;one&lt;/b&gt;", "the view's own title, as text");
  assert.ok(textOf(v["host-view"]!).includes("db.example.com"));
  const navLinks = [...v.nav!.matchAll(/<li><a href="([^"]+)"([^>]*)>.*?<span class="label">(.*?)<\/span><\/a><\/li>/gs)].map((m) => [m[1], m[2], m[3]]).slice(-3);
  assert.deepEqual(navLinks, [["/billing", ` rel="noreferrer"`, "Billing"], ["#host/2", ` aria-current="page"`, "Server"], ["#host/3", "", "&lt;img src=x onerror=alert(7)&gt;"]],
    "a view links to its hash in the page, the current page while shown; a link elsewhere as before");
  assert.match(v.nav!, /<a href="#host\/2" aria-current="page"><span class="icon" aria-hidden="true"><svg\s+class="lucide lucide-panel-top"/, "a view's icon is the page's panel, a link's the link");
  assert.equal([...v.nav!.matchAll(/aria-current/g)].length, 1);
  t += 2000;
  assert.deepEqual(await asked(), [], "2 s on: nothing due (the state once a minute beside a view, the view every 30 s)");
  t += 28_000;
  assert.deepEqual(await asked(), ["GET host/status.json"], "its refresh: read again");
  // another page shown: the view is never read
  app.show("tables");
  t += 60_000;
  assert.ok(!(await asked()).some((a) => a.startsWith("GET host/")), "Tables shown: the view not read");
  assert.equal(app.view()["host-view"], "", "nor written");
  // the other view: its own path; the first, shown again, read again at once
  app.show("#host/3");
  assert.deepEqual(await asked(), ["GET api/state", "GET host/plans.json"], "shown: everything it reads, read again");
  assert.equal(app.view()["host-h"], "Plans");
  app.show("#host/2");
  assert.deepEqual(await asked(), ["GET api/state", "GET host/status.json"], "shown again: read again");
  // without refresh: read when shown, never again by time
  const once = hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, { "host/status.json": jsonAnswer({ ...HOST_VIEW, refresh: undefined }) });
  const app2 = fn<[unknown, () => Date, string], App>("createApp")(once.fetch, () => new Date(t), "#host/2");
  await app2.poll(); await app2.settled();
  once.asked.length = 0;
  for (let i = 0; i < 5; i++) { t += 3_600_000; await app2.poll(); await app2.settled(); }
  assert.ok(!once.asked.includes("GET host/status.json"), "no refresh: not read again while shown");
});

test("a host's view that cannot be read is the view's own failure, in the Failure shape, never a blank page: nothing answers, a 404, not JSON, too large, outside the shape; the last view read stays under it", async () => {
  const HOST_BYTES_MAX = page.HOST_BYTES_MAX as unknown as number;
  assert.equal(HOST_BYTES_MAX, 256 * 1024);
  const big = JSON.stringify({ title: "t", sections: [{ heading: "h", text: "x".repeat(HOST_BYTES_MAX) }] });
  const failing: Array<[(() => Response) | undefined, string]> = [
    [undefined, "nothing answered it (fetch failed)"],
    [() => new Response("<html>Not found</html>", { status: 404 }), "it answered HTTP 404"],
    [() => new Response("<html><body>a login page</body></html>", { status: 200 }), "its answer is not JSON"],
    [() => new Response(big, { status: 200 }), "its answer is more than 256 KiB, the most a view is read"],
    [() => new Response(JSON.stringify({ title: "t", sections: [], script: "alert(1)" }), { status: 200 }), `its answer is outside a view's shape: it has a key a view does not take ("script"): a view is { title, sections, refresh? }`],
  ];
  for (const [answer, why] of failing) {
    const run = hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, answer === undefined ? {} : { "host/status.json": answer });
    const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(), "#host/2");
    await app.poll(); await app.settled();
    const v = app.view();
    assert.equal(textOf(v["host-view"]!), `✗ the host's view at host/status.json could not be read why ${why} fix the site that serves this page answers this path with a view's JSON, ` +
      `{ title, sections: [{ heading, facts, links }] } (docs/WEB-UI.md "Host views"); on a page that no site serves, nothing does`, why);
    assert.match(v["host-view"]!, /^<div class="failure" role="alert">/);
    assert.equal(v.poll, "", "the run answered: no banner");
    assert.equal(v["host-h"], "Server", "the sidebar's label until a view is read");
  }
  // a view read, then a failure: said over the last view, which stays
  let ok = true;
  const run = hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, { "host/status.json": () => ok ? jsonAnswer(HOST_VIEW)() : new Response("x", { status: 502 }) });
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(t), "#host/2");
  await app.poll(); await app.settled();
  ok = false; t += 30_000;
  await app.poll(); await app.settled();
  const text = textOf(app.view()["host-view"]!);
  assert.ok(text.startsWith("✗ the host's view at host/status.json could not be read why it answered HTTP 502") && text.includes("db.example.com"), text);
  // a place the state names no view at (a link elsewhere, past the list) says so, as a Failure
  const none = hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, {});
  for (const h of ["#host/1", "#host/9"]) {
    const a = fn<[unknown, () => Date, string], App>("createApp")(none.fetch, () => new Date(), h);
    await a.poll(); await a.settled();
    assert.match(textOf(a.view()["host-view"]!), /^✗ this page has no host's view \d why the address names a view of the host's sidebar/);
  }
});

test("in the browser: a host's view has its own address — opened at it, followed to and from it, Back and Forward; a place the state names no view at, or no host at all, lands on Mason's first page", async () => {
  const run = hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, { "host/status.json": jsonAnswer(HOST_VIEW), "host/plans.json": jsonAnswer({ title: "Plans", sections: [] }) });
  const b = fakeBrowser(run as unknown as ReturnType<typeof fakeRun>, "#host/2");
  await until(() => b.el("page-host").hidden === false && textOf(b.el("host-view").html).includes("db.example.com"), "the view shown, read");
  assert.equal(b.el("host-h").html, "Server &lt;b&gt;one&lt;/b&gt;");
  assert.match(b.el("nav").html, /<a href="#host\/2" aria-current="page">/);
  assert.deepEqual(b.replaced, []);
  // to Tables (a link followed), Back to the view, Forward to Tables: each a hashchange, as the browser says it
  b.go("#tables");
  await until(() => b.el("page-tables").hidden === false && b.el("page-host").hidden === true, "Tables shown");
  run.asked.length = 0;
  b.go("#host/2");
  await until(() => b.el("page-host").hidden === false && run.asked.includes("GET host/status.json"), "Back: the view shown, read again");
  b.go("#host/3");
  await until(() => b.el("host-h").html === "Plans", "the other view");
  assert.match(b.el("nav").html, /<a href="#host\/3" aria-current="page">/);
  b.go("#tables");
  await until(() => b.el("page-tables").hidden === false, "Forward: Tables again");
  // a place with no view (an older bookmark): replaced by Mason's first page of its own
  const old = fakeBrowser(hostRun({ ...CATALOG_STATE, pageNav: HOST_NAV }, {}) as unknown as ReturnType<typeof fakeRun>, "#host/5");
  await until(() => old.replaced.length > 0);
  assert.deepEqual(old.replaced, ["#overview"]);
  // unset (no host's sidebar): #host/1 is the Overview, as an unknown hash always was
  const plainRun = fakeRun();
  const plain = fakeBrowser(plainRun, "#host/1");
  await until(() => plain.replaced.length > 0 && plain.el("page-status").hidden === false, "the Overview");
  assert.deepEqual(plain.replaced, ["#overview"]);
  assert.ok(!plainRun.asked.some((a) => a.startsWith("GET host/")));
});

test("the host's card on the Overview (pageCard): one card beside Mason's own, read with the Overview, again at its refresh; its failure in the card; the state says it and mason status --json declares it; unset, the Overview as before", async () => {
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  let answer = jsonAnswer({ ...HOST_CARD, refresh: 60 });
  const run = hostRun({ ...CATALOG_STATE, pageCard: "host/card.json" }, { "host/card.json": () => answer() });
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  run.asked.length = 0;
  await app.poll(); await app.settled();
  assert.deepEqual(run.asked, [...STATUS_FIRST, "GET host/card.json"], "read with the Overview's first reads");
  const overview = app.view().status!;
  const grid = /<div class="cards n(\d)">/.exec(overview);
  const plain = fn<[unknown], App>("createApp")(fakeRun().fetch);
  await plain.poll();
  const before = Number(/<div class="cards n(\d)">/.exec(plain.view().status!)![1]);
  assert.equal(Number(grid![1]), before + 1, "one more card than Mason's own");
  assert.match(overview, /<div class="card host-card"><p class="card-label">Plan &lt;u&gt;<\/p>.*?<\/div><\/div>/s, "the host's card, last");
  assert.ok(!overview.includes("<img src=x"));
  run.asked.length = 0; t += 30_000; await app.poll(); await app.settled();
  assert.ok(!run.asked.includes("GET host/card.json"), "30 s on: not yet");
  run.asked.length = 0; t += 30_000; await app.poll(); await app.settled();
  assert.ok(run.asked.includes("GET host/card.json"), "its refresh, 60 s: read again");
  answer = () => new Response("nope", { status: 500 });
  t += 60_000; await app.poll(); await app.settled();
  assert.ok(textOf(app.view().status!).includes("Plan <u> ✗ the host's view at host/card.json could not be read: it answered HTTP 500 Tier"), "its failure said in the card, the last card under it");
  // the state says it, and mason status --json declares it
  const ctxOf = (pageCard?: unknown) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, ...(pageCard === undefined ? {} : { pageCard }), users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: sourceFile, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  assert.equal((runState(ctxOf("host/card.json"), [], null, now) as RunState).pageCard, "host/card.json");
  assert.equal((runState(ctxOf(), [], null, now) as RunState).pageCard, null);
  assert.ok(commands.STATUS.json!.includes("pageCard"), "mason status --json declares it");
  assert.match(commands.STATUS.usage, /pageCard \(the path, relative to\s+the page's address, its Overview reads the host's card from/);
  assert.match(commands.STATUS.usage, /a view\s+of the host's the page shows, \[\{ view, label \}\]/);
  // unset: every part of every page as before, nothing read of a host
  for (const state of [NONE, COPYING, CATALOG_STATE]) {
    const open = await pageByPage(state);
    const nulls = await pageByPage({ ...state, pageCard: null, pageNav: null });
    assert.equal(nulls.all, open.all, "pageCard and pageNav null: the same page");
    assert.ok(!open.all.includes("host-card") && !open.all.includes("#host/"));
  }
});


/** A host that never sends its headers: the fetch never settles (and does not heed an abort). */
const NEVER = (() => new Promise<Response>(() => undefined)) as unknown as () => Response;
/** A host that answers 200, then 10 bytes every `ms` for ever, until its body is cancelled (`cancelled` says so). */
function dripping(ms = 100): { answer: () => Response; cancelled: () => boolean } {
  let cancelled = false;
  const answer = () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("{\"title\":\"")); timer = setInterval(() => c.enqueue(new TextEncoder().encode("aaaaaaaaaa")), ms); },
      cancel() { cancelled = true; clearInterval(timer); },
    });
    return new Response(body, { status: 200 });
  };
  return { answer, cancelled: () => cancelled };
}
/** `p`, or a failure naming what was held up once `ms` pass. */
const within = <T>(p: Promise<T>, what: string, ms = 1500): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: held up past ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

test("a host that never answers, or drips for ever, holds up nothing: the view says it is being read while the run's own reads and every other page go on; its read ends at the deadline, aborted", async () => {
  const nav = { items: {}, links: [{ label: "Server", view: "host/cur" }] };
  for (const [name, host] of [["no headers", { answer: NEVER, cancelled: () => true }], ["a body that drips", dripping(20)]] as const) {
    let t = Date.UTC(2026, 9, 27, 9, 0, 0);
    const run = hostRun({ ...CATALOG_STATE, pageNav: nav }, { "host/cur": host.answer });
    const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(t), "#host/1");
    await within(app.poll(), `${name}: the view's first poll`);
    assert.ok(run.asked.includes("GET host/cur"), `${name}: the view is asked`);
    assert.equal(textOf(app.view()["host-view"]!), "Reading the host's view…", `${name}: said as being read, never blank`);
    run.asked.length = 0; t += 2000;
    await within(app.poll(), `${name}: the next poll`);
    assert.ok(!run.asked.includes("GET host/cur"), `${name}: one read of a path at a time, never a second beside it`);
    // another page: read, whatever the host does
    app.show("tables"); run.asked.length = 0;
    await within(app.poll(), `${name}: Tables`);
    assert.deepEqual(run.asked, ["GET api/state", "GET api/usage?since=1m"], `${name}: Tables' own reads`);
    app.show("observability/queries"); run.asked.length = 0;
    await within(app.poll(), `${name}: Queries`);
    assert.ok(run.asked.includes("GET api/requests?since=15m"), `${name}: Queries' own reads`);
  }
  // the read itself ends at its deadline, as the view's failure, and stops reading a body that drips
  const readHost = fn<[unknown, string, { deadlineMs: number }], Promise<{ failure?: { message: string; why: string } }>>("readHost");
  const why = "it was not answered whole within 0.05 s";
  const never = await within(readHost(NEVER as never, "host/cur", { deadlineMs: 50 }), "no headers: the deadline");
  assert.equal(never.failure?.why, why);
  let aborted = false;
  const heeds = (_p: string, init: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => { init.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); });
  assert.equal((await within(readHost(heeds as never, "host/cur", { deadlineMs: 50 }), "an abort heeded")).failure?.why, why);
  assert.ok(aborted, "the request is aborted at the deadline");
  const drip = dripping(10);
  const dripped = await within(readHost(() => drip.answer(), "host/cur", { deadlineMs: 80 }), "a body that drips: the deadline");
  assert.equal(dripped.failure?.why, "it was not answered whole within 0.08 s");
  await until(drip.cancelled, "the dripping body cancelled", 2000);
  assert.equal(page.HOST_READ_MS as unknown as number, 10_000, "the page's own deadline");
});

test("a host's card that never answers holds up nothing: the Overview is written with the card being read, and read again at its own rate; in the browser, every other page goes on reading", async () => {
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const run = hostRun({ ...CATALOG_STATE, pageCard: "host/card" }, { "host/card": NEVER });
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  await within(app.poll(), "the Overview's first poll");
  const overview = app.view().status!;
  assert.ok(!textOf(overview).startsWith("Asking Mason"), "the Overview is written");
  assert.match(overview, /<div class="card host-card"><p class="card-label">The host's card<\/p><p class="dim">Reading it…<\/p><\/div>/);
  run.asked.length = 0; t += 2000;
  await within(app.poll(), "the next poll");
  assert.deepEqual(run.asked, ["GET api/state"], "the state at its rate; the card, in flight, not asked again");
  // the reviewer's walk: a view that drips, then Tables, then Queries — each read, the sidebar's state with them
  const drip = dripping(100);
  const walk = hostRun({ ...CATALOG_STATE, pageNav: { items: {}, links: [{ label: "Server", view: "host/cur" }] }, pageCard: "host/card" }, { "host/cur": drip.answer, "host/card": NEVER });
  const b = fakeBrowser(walk as unknown as ReturnType<typeof fakeRun>, "#host/1");
  await until(() => walk.asked.includes("GET host/cur"), "the view asked");
  b.go("#tables");
  await until(() => walk.asked.includes("GET api/usage?since=1m") && b.el("page-tables").hidden === false, "Tables read and shown");
  walk.asked.length = 0;
  b.go("#observability/queries");
  await until(() => walk.asked.includes("GET api/requests?since=15m"), "Queries read");
  walk.asked.length = 0;
  b.go("#overview");
  await until(() => walk.asked.includes("GET api/queries") && /Reading it…/.test(b.el("status").html), "the Overview read and written, its card being read");
});
