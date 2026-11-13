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
import { parseSource, REMOTE_NOTE, sourceWarnings, type SourceFacts, type SourceTable } from "../src/cli/preflight.ts";
import { catalogTable, parseSourceText } from "../src/cli/sources.ts";
import type { CopyProgressView, CopyState } from "../src/duck/sync.ts";
import type { RunState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";
import * as syncCommand from "../src/cli/sync.ts";
import { PLAIN } from "../src/cli/style.ts";
import { EVENT_KINDS, type SyncEvent } from "../src/duck/events.ts";
import { timeOf } from "../src/cli/request-filter.ts";
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

/** A table's line as the page says it, from mason status's (issue 877): the same words, but where the CLI names a
 *  command the page names what to press on the page — a table whose sync is off, a compaction that failed. */
const asPage = (cli: string): string => cli
  .replace(/sync: off, (never synced|last synced [^—]*?) — mason sync \S+ syncs it now; sync: poll 5m on its entry polls it/, "sync off, $1: press Sync now to sync it")
  .replace("(mason logs --events says why)", "(Sync events says why)").replace("(mason logs says why)", "(Sync events says why)");

/** What a reader sees of some HTML: its text, tags gone and entities read, spaces collapsed. */
const textOf = (html: string): string => html.replace(/<wbr>/g, "").replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** What the one-time dialog (index.html `#once`) shows from a page's parts (or a view's): its head, status line and foot,
 *  in order; its button is the dialog's own. */
const onceHtml = (parts: Record<string, string | undefined>): string => `${parts["once-head"] ?? ""}${parts["once-status"] ?? ""}${parts["once-foot"] ?? ""}`;

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
const USAGE = { since: "2026-10-27T09:04:30.000Z", until: "2026-10-27T09:05:30.000Z", stepSeconds: null, sampleSeconds: 60, keptDays: 7, samples: [],
  copySizes: [{ table: "public.customers", bytes: 524_288, at: "2026-10-27T09:00:00.000Z" }, { table: "public.events", bytes: 3_221_225_472, at: "2026-10-27T09:00:00.000Z" }] };

/** What the Overview reads, in order: the state every poll, the request log's summary, the last day's sync failures and
 *  the unsupported SQL every 30 s. */
const STATUS_READS = ["GET api/state", "GET api/queries", "GET api/events?failed=1&since=24h&limit=1000", "GET api/unsupported?limit=100"];
/** The Overview's first poll: those, and the last 24 hours of usage its cards' sparklines draw (read once a minute). */
const STATUS_FIRST = [...STATUS_READS, "GET api/usage?since=24h&step=3600"];
/** The run's word at the top of the Overview, as it is written: a big dot, then the word. */
const HEALTH = (kind: string, word: string) => new RegExp(`^<div class="health ${kind}" role="status"><p class="health-title">mason status</p><p class="health-word"><span class="dot" aria-hidden="true"></span><span class="word">${word}</span></p><p class="health-line">`);

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
    const cli = commands.tableLines(s).map((l) => /^(\S+)\s+[█░]+\s+(\d+%) {2}(.*)$/.exec(asPage(l))!.slice(1));
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

test("the Overview's Server table: a database on another machine is information, never a warning; the kind of server is a fact of the Database row, as mason status says it (issue 888)", async () => {
  const status = await import(path.join(WEB, "pages", "status.js") as string) as Record<string, unknown>;
  const statusFn = <A extends unknown[], R>(name: string) => { assert.equal(typeof status[name], "function", `status.js exports ${name}`); return status[name] as (...a: A) => R; };
  // the run's warnings as mason start makes them (src/cli/preflight.ts sourceWarnings), never copied literals: a main
  // database on another machine, a serverless one among them — the page shows each as it is, filtering none by its words
  const facts: SourceFacts = { version: 160000, versionText: "16.4", standby: false, tables: [], systemIdentifier: null };
  const sourceOf = (url: string) => { const p = parseSource(url); assert.ok("source" in p); return p.source; };
  const renderFacts = statusFn<[unknown, number], string>("renderFacts");
  for (const url of ["postgres://me@db.example.com/shop", "postgres://me@ep-x.us-east-2.aws.neon.tech/shop"]) {
    const warnings = sourceWarnings(sourceOf(url), facts);
    for (const w of warnings) assert.doesNotMatch(w, /another machine|not this machine|main database|read replica|PRIMARY|pg_is_in_recovery/i, `${url}: where the database is and what kind it is are no warning (issue 888)`);
    const html = renderFacts({ ...RUNNING, source: { ...RUNNING.source, remote: true, standby: false }, warnings }, NOW);
    assert.equal([...html.matchAll(/<tr class="warn"><th scope="row">Warning<\/th>/g)].length, warnings.length, `${url}: every warning of the run is shown, none filtered by its words`);
    assert.match(html, /<\/table><p class="info fact-note">Your database is on another machine\. Mason will sync the tables you choose to this machine\.<\/p>$/, "information under the table");
  }
  assert.match(textOf(renderFacts({ ...RUNNING, source: { ...RUNNING.source, remote: true }, warnings: sourceWarnings(sourceOf("postgres://me@ep-x.us-east-2.aws.neon.tech/shop"), facts) }, NOW)), /Warning Neon suspends/);
  // this machine's database, and the demo's: no such line
  for (const source of [{ ...RUNNING.source, remote: false }, { ...RUNNING.source, remote: true, demo: true }]) assert.doesNotMatch(renderFacts({ ...RUNNING, source }, NOW), /another machine/);
  // the page's words are mason start's (src/cli/preflight.ts REMOTE_NOTE)
  assert.equal(status.REMOTE_NOTE, REMOTE_NOTE, "src/cli/preflight.ts REMOTE_NOTE");
  // the Database row: what kind of server, in mason status's words — the page's sourceRows and the CLI's say the same row
  const pageRows = statusFn<[unknown], Array<[string, string]>>("sourceRows");
  for (const standby of [true, false]) {
    const s = { ...RUNNING, source: { ...RUNNING.source, standby } };
    const page = pageRows(s).find(([k]) => k === "Database")![1];
    assert.ok(page.endsWith(standby ? " · a read replica" : " · your main database"), page);
    assert.equal(page, commands.sourceRows(s as unknown as RunState).find(([k]) => k === "Database")![1], "the same words as mason status");
  }
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

test("a table added and tables removed are said in the page's words: the key added, a secret left out — no sources file, and its Sync button where mason add names --sync (issue 877)", () => {
  const added = (b: unknown) => textOf(fn<[unknown], string>("renderTableAdded")(b));
  assert.equal(added(PICKED.secret), "Added public.accounts: every column but password_hash. " +
    "Its sync is Off: after its first sync, it syncs only when you press Sync now. Its Sync button changes this. " +
    "Left out password_hash: it looks like a secret, which anyone with a user's password could read. To sync it, run mason add accounts --include password_hash. Dismiss");
  assert.equal(added(PICKED.columns), "Added public.audit: the columns id, name. Its sync is every 30 seconds: after its first sync, Mason checks it for changes on that schedule. " +
    "Its Sync button changes this. Its key id was added to its columns: a synced table always keeps its key. Dismiss");
  assert.match(added(PICKED.keyed), /^Added public\.event_log: every column, keyed by tenant_id, id\. Its sync is set to Off: it has more than 1,000,000 rows/);
  assert.equal(added(PICKED.notReplicated), "Added public.event_log: every column, keyed by tenant_id, id. " +
    "Its sync is set to every 5 minutes, not Live: it has no primary key, so logical replication cannot apply its changes by its key:. Its Sync button changes this. Dismiss");
  assert.match(added(PICKED.replicated), /^Added public\.orders: every column\. Its sync is Live: after its first sync, changes stream from your database's change log\./);
  assert.match(added(PICKED.already), /^Added public\.customers: every column \(it was already added\)\. Its sync is every 5 seconds: .* customers has about 40,000,000 rows/);
  for (const b of Object.values(PICKED)) assert.doesNotMatch(added(b), /sources\/shop\.yml|--sync|mason sync|sync: /, b.table);
  assert.equal(textOf(fn<[unknown], string>("renderTablesRemoved")({ removed: ["public.orders"], file: FILE })),
    "Removed public.orders. Mason stopped syncing it and deleted its synced data. Dismiss");
});

test("a demo project's database row says it is the demo database Mason hosts, as mason status says it", () => {
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
});

// ------------------------------------------------------------------ what the page writes

test("running: the database masked, each table copied with its rows, the counts, Ready — and never the engine's name", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { now: NOW, queries: QUERIES, syncErrors: EVENTS });
  const text = textOf(html);
  assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
  assert.ok(!text.includes("secret"), "the password is the run's to mask, and it did");
  assert.match(text, /Tables synced 3 of 3 added/);
  assert.ok(!/Tables not synced yet|100%/.test(text), "every copy is done: no bar (the Tables page lists them)");
  assert.ok(!text.includes("public.audit"), "a table not added is not a line");
  assert.ok(!/Slow queries|Refused queries|Ready: every added table/.test(text), "the counts and the readiness line repeated the statements, the errors and the word");
  assert.match(html, /<a class="card[^"]*" href="#observability\/queries\?range=24h"><p class="card-label">Queries, last day<\/p>/, "the statements are listed on Observability's Queries");
  assert.ok(!/<table class="(queries|errors)"/.test(html), "no table of the statements, nor lists of the errors: the cards count them, and link to them");
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
  assert.match(text, /^mason status Under way 1 of 3 tables synced, the rest syncing .* Tables not synced yet \(2 of 3 added\) Table Sync public\.orders 15% /);
  assert.ok(!/public\.customers/.test(text), "a copy that is done is not a bar");
});

test("behind, left out, a failed catch-up, a stream down, off: each table's line is mason status's word for word; the Tables page says Behind and Failed (issue 254)", () => {
  const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();
  const pass = "every polled table's polls took 13 min in the last pass, and Mason waits four times that between passes to keep the database's load to a fifth";
  const gap = "publication app_pub does not carry public.orders: ALTER PUBLICATION app_pub ADD TABLE public.orders — or give its entry sync: poll <interval> in the sources file, which needs no publication";
  const pending = "it is caught up by one poll after its whole read first — after a failure, tried again after 09:10 UTC";
  const every15 = { mode: "poll", every: "15m", seconds: 900 };
  const COMPACTING = "it is being compacted, and the changes made since are applied when the compaction ends";
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
    // in its first sync's one catch-up poll (issue 834): at work, its words the CLI's, never "not kept current"
    ["catching up, off", [{ ...copied("public.events", 23_000_000, ago(5)), behind: "after its whole read", rebuilding: "catch-up",
      kept: { by: "poll", sync: { mode: "off" }, syncedAt: ago(5), nextAt: null, pending: "it is caught up by one poll after its whole read first", promisedSeconds: null, lateWhy: null } } as CopyState]],
    ["catching up, polled", [{ ...copied("public.customers", 1200, ago(5)), behind: "after its whole read",
      kept: { by: "poll", sync: every15, syncedAt: ago(5), nextAt: null, pending: "it is caught up by one poll after its whole read first", promisedSeconds: 960, lateWhy: "it is caught up by one poll after its whole read first" } } as CopyState]],
    ["catching up, replicated", [{ ...copied("public.orders", 2_000_000, ago(5)), behind: "after its whole read", rebuilding: "catch-up",
      kept: { by: "replication", slot: "s", state: "catching-up", why: "caught up by one poll after its whole read", position: "0/1", lastCommit: null, notRunning: null,
        syncedAt: ago(5), promisedSeconds: 120, lateWhy: "caught up by one poll after its whole read" } } as CopyState]],
    // being compacted, its changes kept aside (issue 904): as of the moment they began to be, said so, and behind past its promise
    ["compacting", [{ ...copied("public.orders", 2_000_000, ago(7200)), rebuilding: "compact",
      kept: { by: "replication", slot: "s", state: "compacting", why: COMPACTING, position: "0/1", lastCommit: null, notRunning: null,
        syncedAt: ago(30), promisedSeconds: 120, lateWhy: COMPACTING } } as CopyState]],
    ["compacting, behind", [{ ...copied("public.orders", 2_000_000, ago(7200)), rebuilding: "compact",
      kept: { by: "replication", slot: "s", state: "compacting", why: COMPACTING, position: "0/1", lastCommit: null, notRunning: null,
        syncedAt: ago(300), promisedSeconds: 120, lateWhy: COMPACTING } } as CopyState]],
  ];
  const tableLine = fn<[unknown, number], { state: string; fraction: number; what: string }>("tableLine");
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const words: Record<string, string> = {};
  for (const [name, copies] of states) {
    const s = stateOf(copies, { now: NOW });
    const t = s.tables.find((x) => x.table === copies[0]!.source)!;
    const cli = commands.tableLines(s, NOW).find((l) => l.startsWith(t.table))!;
    const ours = tableLine(t, NOW);
    assert.ok(asPage(cli).endsWith(`  ${ours.what}`), `${name}:\n${cli}\n${ours.what}`);
    assert.doesNotMatch(ours.what, /first sync failed/, `${name}: a synced table's sync is never its first`);
    const row = renderTables(s).split("<tr").find((r) => r.includes(`<code class="name" title="${t.table}">`))!;
    words[name] = `${/class="indicator (\w+)"/.exec(row)![1]} ${/<\/span>(Behind|Failed|Synced|Syncing|Finishing sync|Waiting)</.exec(row)![1]} ${ours.state}`;
    if (name.startsWith("catching up")) {
      assert.ok(ours.what.endsWith(` · ${commands.CATCHING_UP} (last synced 5 s ago)`), `${name}: ${ours.what}`);
      assert.doesNotMatch(ours.what, /not kept current/, `${name}: at work, not a fault (issue 834)`);
      assert.match(row, /<span class="copyline t-catching-up">/, `${name}: the bar in the accent (app.css: no amber of .t-unsynced)`);
      assert.match(cli, /^\S+\s+█{20} 100% {2}/);
      assert.match(commands.paintBar(cli, { red: (x: string) => `R${x}`, yellow: (x: string) => `Y${x}`, green: (x: string) => `G${x}`, cyan: (x: string) => `C${x}`, dim: (x: string) => x } as never, commands.tableRows(s, NOW).find((x) => x.line === cli)!.tone), /C█/, `${name}: cyan in mason status`);
    }
  }
  assert.deepEqual(words, { "behind, the pass": "warn Behind unsynced", "behind, its own poll": "warn Behind unsynced", "left out": "bad Failed failed", "a failed catch-up": "bad Failed failed",
    "a stream down past its bound": "warn Behind unsynced", "behind, recopied": "warn Behind unsynced", off: "ok Synced done", synced: "ok Synced done",
    "catching up, off": "warn Finishing sync catching-up", "catching up, polled": "warn Finishing sync catching-up", "catching up, replicated": "warn Finishing sync catching-up",
    compacting: "ok Synced done", "compacting, behind": "warn Behind unsynced" });
  // being compacted, its words on mason status's line and the page's alike (issue 904)
  const compacting = (name: string): string => tableLine(stateOf(states.find(([n]) => n === name)![1], { now: NOW }).tables.find((x) => x.table === "public.orders")!, NOW).what;
  assert.equal(compacting("compacting"), `2,000,000 rows · synced · replicated, last synced 30 s ago — ${COMPACTING}`);
  assert.equal(compacting("compacting, behind"), `2,000,000 rows · synced · replicated, last synced 5 min ago — ${COMPACTING} — behind by 3 min`);
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
    ["failed", { ...none, deadShare: 0.6, error: "its compaction failed, …", retryAt: "2026-10-27T10:35:00.000Z" }, "its compaction failed, tried again after 10:35 UTC (Sync events says why)"],
    ["waits for disk", { ...none, deadShare: 0.52, waiting: "it needs 184.0 MiB free on disk to be compacted, and 70.0 MiB is free where the synced data is" },
      "52% of its stored rows deleted, not compacted: it needs 184.0 MiB free on disk to be compacted, and 70.0 MiB is free where the synced data is"],
    ["nothing read", none, null],
  ];
  for (const [name, compaction, said] of cases) {
    const s = stateOf([{ ...copied("public.events", 30_000_000, "2026-10-27T09:00:09.000Z"), kept, compaction } as unknown as CopyState], { now: NOW });
    const t = s.tables.find((x) => x.table === "public.events")!;
    const cli = commands.tableLines(s, NOW).find((l) => l.startsWith("public.events"))!;
    const ours = fn<[unknown, number], { what: string }>("tableLine")(t, NOW).what;
    assert.ok(asPage(cli).endsWith(`  ${ours}`), `${name}:\n${cli}\n${ours}`);
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
  assert.match(line.what, /^2,000,000 rows · synced · not kept current \(last synced .* ago\): caught up by one poll first \(after its whole read\)$/);
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
  assert.match(fn<[unknown], { what: string }>("tableLine")(events).what, /^30,000,000 rows · synced · sync off, last synced \d+ days? ago: press Sync now to sync it$/);
  assert.match(text, /Warning mason\/sources\/shop\.yml: tables\.ordrs: no such table/);
  assert.match(text, /Changes each table as its sync: says · sync: off \(the default: the file writes none\) · sync: replication tables streamed as they happen \(logical replication: slot mason_dev_shop, publication app_pub, named: read as it is, never altered\); the others by a SELECT of their changed rows/);
  assert.ok(!/xmin|polling with SELECTs|goes back to polling/.test(text), "how the changes arrive is said in a web developer's words");
  assert.match(text, /Queries, last day unknown could not be read: the request log cannot be read Query errors, last day unknown could not read them: the request log cannot be read/);
  assert.match(text, /^mason status Failed 1 table's sync failed: see Tables /);
  assert.match(html, /<p class="health-line">1 table&#39;s sync failed: see <a href="#tables\?show=failed">Tables<\/a><\/p>/);
  assert.match(html, /<tr class="warn"><th scope="row">Warning<\/th>/, "a warning is marked");
});

test("no table added: the commands' sentence, and what adds one", () => {
  assert.match(textOf(fn<[unknown, unknown?], string>("renderStatus")(NONE)), /^No table added yet\. Your database has 4\. Add one on the Tables page\. Server Sources file .* Database postgres:.* Changes each table as its sync: says .* Connections open none open Your database is on another machine\. Mason will sync the tables you choose to this machine\.$/, "no box: the Server table says the database and its changes, then where it is, as information");
});

test("the tables: each of the database's, added, not added or cannot be added with its reason and no Add; Remove asks first", async () => {
  type Ui = { removing?: string | null; choosing?: string | null; columns?: unknown; outcome?: unknown };
  const renderTables = fn<[unknown, Ui?], string>("renderTables");
  const html = renderTables(CATALOG_STATE);
  const text = textOf(html);
  // TWO tables, Added over Not added: an added table shows its sync columns, one not added its rows and key; seven short
  // columns, whatever is long (a reason, an error, a copy's words, a Remove's question) a line of its own under the row
  assert.match(text, /^Added \(3\) Table State Rows Key Last sync Size public\.customers /);
  assert.equal([...html.matchAll(/<table /g)].length, 2, "two tables: Added, then Not added");
  const listed = [...html.matchAll(/<th scope="row" class="name"><code class="name" title="([^"]*)">/g)].map((m) => m[1]);
  assert.equal(new Set(listed).size, 7, "each table listed once");
  assert.match(text, /public\.customers Synced 100% 1,200 key id View events Sync now Remove Sync… All columns public\.orders /, "every added table has its bar: 100% once copied");
  assert.equal([...html.matchAll(/<span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`).join(", "),
    "ok Synced, ok Synced, ok Synced, unknown Not added, unknown Not added, unknown Not added, unknown Not added", "a state is a dot AND the CLI's word");
  assert.match(html, /^<h3 class="list-h">Added <span class="dim">\(3\)<\/span><\/h3><div class="panel"><table class="catalog">/, "Added: its heading and count over its card");
  assert.match(html, /<\/table><\/div><h3 class="list-h">Not added <span class="dim">\(4\)<\/span><\/h3><div class="panel"><table class="catalog">/, "Not added under it, a card of its own");
  assert.match(text, /public\.audit Not added ~50 rows key id Add Columns… public\.accounts /);
  assert.match(text, /public\.event_log Not added ~900 rows no key Name its key… cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id \(its unique index event_log_tenant_id_id_key\) public\.staging /);
  assert.match(html, /<\/tr><tr class="under note"><td colspan="7"><div class="under-body">(?:<span class="fold[^"]*" data-fold="[^"]*"><\/span>)*<span class="dim">cannot be added as it is: no primary key/, "the reason on a line of its own under its row, across every column");
  assert.match(text, /public\.staging Not added rows unknown key id Add Columns… A synced table's size/);
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
  assert.equal(textOf(popOf(asking, "act-tables-public.customers")), "Remove customers? Mason will stop syncing it and delete its synced data. Remove customers Cancel");
  // its Remove where it was, held down; the question a dialog anchored to the row's actions, written after the table
  assert.match(asking, /<td class="act" id="act-tables-public\.customers"><a class="btn small" href="#observability\/syncs\?table=public\.customers&amp;range=7d">View events<\/a> <button type="button" class="small" data-sync-table="public\.customers" data-room="Syncing…">Sync now<\/button> <button type="button" class="danger small" aria-expanded="true" disabled>Remove<\/button><\/td><\/tr>/);
  assert.match(asking, /<\/table><\/div><div class="pop ask" data-anchor="act-tables-public\.customers" role="dialog" aria-label="Remove customers\?"><button type="button" class="pop-x"[\s\S]*?<\/button><p class="confirm">Remove customers\?/);
  assert.match(asking, /<button type="button" class="danger small" data-confirm-remove-table="public\.customers">Remove customers<\/button>/);
  assert.match(asking, /data-confirm-remove-table="public\.customers"/);
  assert.ok(!/data-confirm-remove-table="public\.orders"/.test(asking), "only the one asked");
  // the form: a table with no primary key ticks its key and its columns, one with a key its columns only
  assert.equal(textOf(popOf(renderTables(CATALOG_STATE, { choosing: "public.event_log" }), "act-tables-public.event_log")), "Reading event_log's columns… Cancel", "the form waits for its columns, read when it opens");
  const keyForm = renderTables(CATALOG_STATE, { choosing: "public.event_log", columns: columnsOf("public.event_log") });
  assert.match(keyForm, /<form class="pick" data-pick-form="public\.event_log"/);
  assert.match(keyForm, /<button type="submit" class="primary small">Add event_log<\/button>/);
  assert.match(textOf(keyForm), /Its key: the columns that tell its rows apart tenant_id bigint id bigint payload jsonb The columns to sync All columns, and any added to the table later Only these columns tenant_id bigint id bigint payload jsonb Add event_log Cancel/);
  assert.deepEqual([...keyForm.matchAll(/name="(key|columns)" value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`),
    ["key=tenant_id", "key=id", "key=payload", "columns=tenant_id", "columns=id", "columns=payload"]);
  // All at first; under Only these every box ticked, so choosing it starts from every column; the key's boxes none
  assert.deepEqual([...keyForm.matchAll(/name="(which|key|columns)" value="([^"]*)" checked/g)].map((m) => `${m[1]}=${m[2]}`),
    ["which=all", "columns=tenant_id", "columns=id", "columns=payload"]);
  const columnsForm = renderTables(CATALOG_STATE, { choosing: "public.accounts", columns: columnsOf("public.accounts") });
  assert.ok(!/name="key"/.test(columnsForm) && !/Its key/.test(columnsForm), "a table with a primary key is copied by it: no key to name");
  assert.deepEqual([...columnsForm.matchAll(/name="columns" value="([^"]*)"/g)].map((m) => m[1]), ["id", "email", "password_hash"]);
  assert.ok(!/pattern=|required/.test(keyForm + columnsForm), "the server judges what is sent, never the page");
  // what an add or a remove answered is said beside its table's actions; a refusal for a table the list lacks, above the list
  const said = renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", added: PICKED.secret } });
  assert.match(textOf(popOf(said, "act-tables-public.accounts")), /^Added public\.accounts: every column but password_hash\. .* Dismiss$/);
  assert.equal(textOf(withoutPops(said)), textOf(html), "and nothing inserted into the table");
  const gone = renderTables(CATALOG_STATE, { outcome: { table: "public.gone", failure: { code: "not_found", message: "public.gone is not a table of shop that this user can read" } } });
  assert.match(textOf(gone), /^✗ public\.gone is not a table of shop that this user can read Added \(\d+\) Table State /);
  assert.equal(textOf(renderTables({ ...NONE, tables: [] })), "shop has no table this user can read.");
  assert.match(renderTables({ ...NONE, tables: [] }), /^<p class="empty">[^<]* has no table this user can read\.<\/p>$/, "nothing to list is the empty state: one quiet line");
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
  assert.match(textOf(html), /^Active 4 Removed 0 User Role Status Added Last used agent id 0000000000000001 agent from anywhere Active .* old id 0000000000000002 gone not in the roles file: its queries are refused from anywhere Active /);
  assert.match(textOf(html), /dflt id 0000000000000003 everything \(default\) from anywhere Active .* bare id 0000000000000004 no role, and the roles file has no default: its queries are refused from anywhere Active /);
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
  assert.match(textOf(html), /acme id 0000000000000001 tenant tenant=42, regions=\[eu, uk\] from anywhere Active .* stale id 0000000000000002 tenant tenant=7 no value for regions: its queries are refused from anywhere Active /);
});

test("the users: a row each under two tabs, Active (with its Remove) and Removed (muted, no actions); Remove asks first; none is said", () => {
  const renderUsers = fn<[unknown, unknown, number?, unknown?, unknown?, unknown?, string?], string>("renderUsers");
  const list = { users: [{ name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null },
    { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: "2026-10-28T08:15:59.000Z", url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "grafana", id: "fedcba9876543210", addedAt: "2026-10-20T08:00:00.000Z", removedAt: null, live: false, lastUsedAt: null, url: "postgres://grafana@127.0.0.1:5433/shop" }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const NOW_U = Date.parse("2026-10-28T09:15:59.000Z");
  const html = renderUsers(list, null, NOW_U);
  assert.match(textOf(html), /^Active 2 Removed 1 User Role Status Added Last used metabase id 0123456789abcdef every table from anywhere Active 2026-10-27 09:10 UTC 60 min ago Queries Disable Remove grafana id fedcba9876543210 every table from anywhere Active can't connect: the API key changed after it was added 2026-10-20 08:00 UTC not used in the last 7 days Queries Disable Remove$/);
  // the tabs: a segmented control, each a link to its address (the hash is the choice), the one shown current
  assert.match(html, /^<div class="range users-show" role="group" aria-label="Show users"><a href="#users" aria-current="true">Active <span class="n">2<\/span><\/a><a href="#users\?show=removed">Removed <span class="n">1<\/span><\/a><\/div>/);
  const removedTab = renderUsers(list, null, NOW_U, null, null, null, "removed");
  assert.match(textOf(removedTab), /^Active 2 Removed 1 User Role Status Added Last used old id aaaaaaaaaaaaaaaa every table Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC Queries$/, "Removed: the removed alone, its Queries its only action");
  assert.match(removedTab, /<a href="#users\?show=removed" aria-current="true">Removed/);
  assert.ok(!/data-remove=|data-disable=/.test(removedTab), "a removed user has no Remove nor Disable");
  // a disabled user is Active's, with its Disabled status
  const disabled = renderUsers({ ...list, users: list.users.map((u) => u.name === "grafana" ? { ...u, disabledAt: "2026-10-28T08:00:00.000Z" } : u) }, null, NOW_U);
  assert.match(textOf(disabled), /^Active 2 Removed 1 .* grafana id fedcba9876543210 every table from anywhere Disabled 2026-10-28 08:00 UTC .* Enable Remove$/);
  // empty tabs: one quiet line each, under the tabs
  const onlyRemoved = { ...list, users: list.users.filter((u) => u.removedAt !== null) };
  assert.equal(textOf(renderUsers(onlyRemoved, null, NOW_U)), "Active 0 Removed 1 No active users. Add one below.");
  assert.match(renderUsers(onlyRemoved, null, NOW_U), /<\/div><p class="empty">No active users\. Add one below\.<\/p>$/);
  assert.equal(textOf(renderUsers(onlyRemoved, null, NOW_U, null, null, "read-only here")), "Users are not added, changed, disabled or removed from this page: read-only here. Active 0 Removed 1 No active users.", "read-only: nothing to add below");
  const onlyActive = { ...list, users: list.users.filter((u) => u.removedAt === null) };
  assert.equal(textOf(renderUsers(onlyActive, null, NOW_U, null, null, null, "removed")), "Active 2 Removed 0 No removed users.");
  assert.equal(renderUsers(list, null, NOW_U, null, null, null, "nonsense"), html, "a tab the page does not know is Active");
  // the last use is an age with its UTC time in a title (mason user list's words); status is a dot and a word
  assert.match(html, /<td class="num"><span title="2026-10-28 08:15 UTC">60 min ago<\/span><\/td>/);
  assert.deepEqual([...html.matchAll(/<span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`),
    ["ok Active", "ok Active"]);
  assert.match(removedTab, /<span class="indicator unknown"><span class="dot" aria-hidden="true"><\/span>Removed 2026-10-02 10:00 UTC<\/span>/);
  assert.match(html, /<button type="button" class="danger small" data-remove="metabase">Remove<\/button>/);
  assert.equal([...html.matchAll(/<tr( class="removed")?><th scope="row">/g)].map((m) => m[1] ? "removed" : "active").join(" "), "active active", "Active: the users not removed");
  assert.equal([...removedTab.matchAll(/<tr( class="removed")?><th scope="row">/g)].map((m) => m[1] ? "removed" : "active").join(" "), "removed", "Removed: muted");
  assert.ok(!/password/i.test(html.replace(/the API key/g, "")), "no password is shown: the URL is the one without it");
  const asking = renderUsers(list, "metabase", NOW_U);
  assert.match(textOf(asking), /Remove metabase\? It can no longer connect, and its open sessions end at their next query\. Remove metabase Cancel/);
  assert.match(asking, /data-confirm-remove="metabase"/);
  assert.ok(!/data-confirm-remove="grafana"/.test(asking), "only the one asked");
  // none yet: what a user is for, in a web developer's words, and how one is made
  assert.equal(textOf(renderUsers({ users: [] }, null)), "No users yet. Create a user for a service like a BI tool or your app: add one below.");
  assert.equal(renderUsers({ users: [] }, null), `<p class="empty">No users yet. Create a user for a service like a BI tool or your app: add one below.</p>`, "one quiet line, no box");
  assert.equal(fn<[unknown, unknown, number, unknown, unknown, unknown], string>("renderUsers")({ users: [] }, null, Date.now(), null, null, "read-only here"), `<p class="count">Users are not added, changed, disabled or removed from this page: read-only here.</p><p class="empty">No users yet: <code>mason user add &lt;name&gt;</code> adds one.</p>`, "read-only: the command, nothing to add below");
  // last use unknown, or the URL unknown: the note why, as mason user list says it
  const unknown = textOf(renderUsers({ ...list, lastUsedNote: "unknown: the request log could not be read (busy)", urlNote: "Mason is not running" }, null, NOW_U));
  assert.match(unknown, /Active 2026-10-27 09:10 UTC 60 min ago/);
  assert.match(unknown, /Active can't connect: the API key changed after it was added 2026-10-20 08:00 UTC unknown /);
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
  assert.ok(textOf(html).startsWith(`${rolesProblemText("mason/roles.yml", problem)} Active 2 Removed 0 User Role Status Added Last used `), textOf(html));
  assert.match(textOf(html), /metabase id 0123456789abcdef refused: the roles file can't be read from anywhere Active 2026-10-27 .* agent id 0000000000000001 refused: the roles file can't be read from anywhere Active 2026-10-29/);
  // a readable file: nothing said; the page's own roles are the state's (/api/state roles), read beside the users
  assert.doesNotMatch(textOf(renderUsers(list, null, NOW_R, null, { file: "mason/roles.yml", roles: ["agent"], problem: null, default: null, all: [] })), /cannot be read/);
  assert.doesNotMatch(textOf(renderUsers(list, null, NOW_R, null, null)), /cannot be read/);
});

test("a user just added: the one-time dialog's parts, titled New user added; URL, User and Password alone, in that order, held equal to mason user add's rows — the URL and the Password each with a Copy that copies it, the User as plain text; Shown once right of the password's Copy; one line that it is only shown once — no Database, Host, Port or SSL mode (Connect's), no psql line", async () => {
  const password = "mason_0123456789abcdef_" + "a".repeat(32);
  const url = `postgres://metabase:${password}@127.0.0.1:5433/shop`;
  const added = { user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password,
    database: "shop", url, psql: psqlLine(url), host: "127.0.0.1", port: 5433, sslmode: "require", roleFrom: "none" as const };
  const parts = fn<[unknown], Record<string, string>>("renderAdded")(added);
  assert.deepEqual(Object.keys(parts), ["once-head", "once-status", "once-foot"], "the dialog's three parts");
  const html = onceHtml(parts);
  const text = textOf(html);
  // the title, then the user's own three fields, in one layout: each a label and its value, a Copy on all but the name
  // (issues 839, 876); Shown once beside the password's Copy; the status line, then one line (the button is the dialog's)
  assert.equal(text, "New user added URL postgres://metabase:mason_0123456789abcdef_a{32}@127.0.0.1:5433/shop Copy User metabase Password mason_0123456789abcdef_a{32} Copy Shown once Waiting for its first query… The password is only shown once".replace("a{32}", "a".repeat(32)).replace("a{32}", "a".repeat(32)));
  assert.match(html, /^<p class="once-title" id="once-title">New user added<\/p><dl class="facts"><dt>URL<\/dt><dd><span class="copyrow">[^]*?<\/dd><dt>User<\/dt><dd>metabase<\/dd><dt>Password<\/dt>/, "the title, then URL, then User as plain text with no Copy, then Password");
  assert.match(html, /<code id="added-password">[^<]*<\/code> <button[^>]*>Copy<\/button> <span class="badge warn">Shown once<\/span><\/span><\/dd>/, "Shown once in the password's row, right of its Copy");
  assert.doesNotMatch(html, /shown-once/, "no line of its own under the password");
  assert.equal([...html.matchAll(/Shown once/g)].length, 1, "said once, beside the password's Copy");
  // the badge is the Copy button's height, from one token: the row stays one line
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /button\.small \{ height: var\(--control-sm\);/);
  assert.match(css, /\.copyrow \.badge \{ flex: none; height: var\(--control-sm\); \}/);
  // the dialog as wide as its rows up to the window less its gutters, so each Copy sits on its value's line; its sentences
  // never widen it; a copy row never wraps its Copy under the value: the value breaks inside its box; a phone's sheet
  // the screen's whole width
  assert.match(css, /dialog\.once \{ width: max-content; min-width: min\(640px, calc\(100vw - 2 \* var\(--space-4\)\)\); max-width: calc\(100vw - 2 \* var\(--space-4\)\);/);
  assert.match(css, /\.once \.copyrow \{ display: flex; flex-wrap: nowrap; align-items: center; \}/);
  assert.match(css, /\.once \.copyrow code \{ flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; \}/);
  assert.match(css, /\.once \.once-title, \.once \.added-seen, \.once \.tip \{ contain: inline-size; \}/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*dialog\.once \{ width: 100%; min-width: 0; max-width: none;/);
  assert.doesNotMatch(html, /headline/, "no headline");
  assert.doesNotMatch(text, /Connect on this page|Paste it|Connect your tool/, "the one line replaces the tips");
  const fields: Array<[string, string, string]> = [["URL", "added-url", url], ["Password", "added-password", password]];
  // the URL already carries the database (…/shop): the run's Database, Host, Port and SSL mode are on Connect (issue 876)
  for (const label of ["Database", "Host", "Port", "SSL mode"]) assert.doesNotMatch(html, new RegExp(`<dt>${label}</dt>`), `no ${label} row: Connect says it`);
  assert.doesNotMatch(html, /added-database|added-host|added-port|added-sslmode/);
  assert.doesNotMatch(text, /\b(above|below)\b/, "Connect is named, never placed");
  // each row the page shows is mason user add's row of the same name, value for value; the terminal, with no Connect
  // beside it, still prints the database, the host, the port and the SSL mode
  const { addedReport } = await import("../src/cli/user.ts");
  const cliRows = new Map(addedReport(added, { roles: { file: null, roles: {}, default: null } as never, listener: null, next: [] }, PLAIN).split("\n")
    .map((l) => /^ {2}(\S+(?: mode)?) +(.*)$/.exec(l)).filter((m) => m !== null).map((m) => [m[1]!, m[2]!]));
  for (const [label, , value] of [...fields, ["User", "", "metabase"] as [string, string, string]]) assert.equal(cliRows.get(label.toLowerCase()), value, `${label}: the page's row is mason user add's`);
  assert.deepEqual([cliRows.get("database"), cliRows.get("host"), cliRows.get("port"), cliRows.get("ssl mode")], ["shop", "127.0.0.1", "5433", "require"], "mason user add keeps every row");
  for (const [label, id, value] of fields) {
    const re = value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    assert.match(html, new RegExp(`<dt>${label}</dt><dd><span class="copyrow"><code id="${id}">${re}</code> <button type="button" class="small" data-copy="${id}" data-room="Press ⌘C">Copy</button>( <span class="badge warn">Shown once</span>)?</span></dd>`), `${label}: its value and a Copy, laid out as every other field`);
  }
  assert.deepEqual([...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]), fields.map(([, id]) => id), "a Copy on every field, none else");
  assert.deepEqual([...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]), ["URL", "User", "Password"], "exactly three rows, in mason user add's order");
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
  // its one way out is the dialog's own, in index.html: I have copied it
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<button type="button" class="primary" data-dismiss-once>I have copied it<\/button><\/p>\s*<\/dialog>/);
  // while Mason does not run, the JSON carries no URL: it is not shown, never "undefined"
  const bare = onceHtml(fn<[unknown], Record<string, string>>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password, database: "shop" }));
  assert.deepEqual([...bare.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]), ["added-password"]);
  assert.deepEqual([...bare.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]), ["User", "Password"]);
  assert.doesNotMatch(textOf(bare), /undefined|null|Database|Host|Port|SSL mode|URL/);
});

test("a run that stopped, or a cookie of an earlier run: a plain Failure that says what to do", () => {
  const failureOf = fn<[number | null, string], Failure>("failureOf");
  const gone = failureOf(null, "fetch failed");
  assert.equal(gone.message, "Mason is not answering at this address");
  assert.match(gone.fix!, /^Run mason start in the project's folder, then mason ui to open this page again\./);
  assert.deepEqual(gone.next!.map((s) => s.command), ["mason status", "mason start", "mason ui"]);
  const stale = failureOf(403, "this is mason start's command server for the mason command: a request carries the run's token (Authorization: Bearer, from .mason/config.json)\n");
  assert.equal(stale.message, "This page is from an earlier run of Mason");
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
  assert.equal(closed.message, "The tunnel to this server has closed");
  assert.match(closed.fix!, /^Run mason ui --ssh <user@server> on your own machine to open this page again\./);
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
  "data-disable=", "data-confirm-disable=", "data-enable=", "data-ask-cancel", "data-confirm-cancel", "data-share-open", "data-share-stop"];
/** The buttons a read-only page may write: each only shows, copies or moves what is shown, and sends no change. */
const VIEW_BUTTONS = /^data-(copy|dismiss-[a-z-]+|pop-close|sort-table|sort-key|show-more|show-all|refresh-range|older|newest|open)$/;

/** Every page of the app over a fake run whose state is `state`, a statement running and a user: what each page wrote. */
async function everyPage(state: unknown): Promise<string> { return (await pageByPage(state)).all; }
/** The same, each page's parts apart: `byPage.get(id)` is what the page `id` wrote. */
async function pageByPage(state: unknown): Promise<{ all: string; byPage: Map<string, string>; overview: string }> {
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(state), { status: 200 }));
  run.answers.set("GET api/running", () => new Response(JSON.stringify({ running: [{ session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY",
    startedAt: "2026-10-27T09:10:00.000Z", runningMs: 1500, rows: 0, query: "SELECT count(*) FROM orders", queryTruncated: false }] }), { status: 200 }));
  run.answers.set("GET api/users?lastUsed=1", () => new Response(JSON.stringify({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true },
    { name: "old", id: "fedcba9876543210", addedAt: "2026-10-27T09:10:11.000Z", disabledAt: "2026-10-27T10:00:00.000Z", live: true }] }), { status: 200 }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  const byPage = new Map<string, string>();
  let overview = "";
  for (const id of ["status", "tables", "queries", "users", "usage", "syncs"]) {
    app.show(id);
    await app.poll();
    byPage.set(id, Object.values(app.view()).join("\n"));
    if (id === "status") overview = app.view().status!;
  }
  return { all: [...byPage.values()].join("\n"), byPage, overview };
}

test("a read-only page (pageReadOnly): no page writes a control that sends a change — no Add, Remove, Sync, Columns…, Disable, Enable, Cancel or Add a user; unset, each is there", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const open = await everyPage(CATALOG_STATE);
  for (const control of WRITE_CONTROLS.filter((c) => !/confirm|share-stop/.test(c))) assert.ok(open.includes(control), `without the setting: ${control}`);
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

test("a read-only page: no add, create or write link anywhere — Queries' empty log's Create a user included; the Overview and Usage say why; unset, all as before", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  // what leads to adding or creating something: a button-styled link to the page that does it, or its words
  const LEADS = [/Create a user/, /Add a table/, /Add a user/, /Temporary cloud login/, /<a class="btn[^"]*" href="#users"/, /<a class="btn[^"]*" href="#tables[^"]*"/, /Cancel stops one/];
  const open = await pageByPage(CATALOG_STATE);
  const shown = await pageByPage({ ...CATALOG_STATE, pageReadOnly: why });
  for (const lead of LEADS) assert.ok(!lead.test(shown.all), `read-only: ${lead}`);
  // Queries' empty log leads to the Users page in a line, unless the page makes no user; the Overview has no Connect (the owner's, 2026-11-12)
  for (const page of [open, shown]) assert.ok(!/class="connect[ "]|data-copy="connect-/.test(page.overview), "no Connect on the Overview");
  assert.match(open.byPage.get("queries")!, /<p class="empty first-tool"><a class="btn small primary" href="#users">Create a user<\/a> to connect your first tool\.<\/p>/, "unset: Queries' Create a user");
  assert.ok(!/first-tool/.test(shown.byPage.get("queries")!), "read-only: no line");
  // the Overview and Usage say why their controls are missing, as Tables and Users do; unset, none says it
  const lines = new Map([["status", `Nothing is added or created from this page: ${why}.`], ["usage", `Queries are not cancelled from this page: ${why}.`],
    ["tables", `Tables are not added, removed or synced from this page: ${why}.`], ["users", `Users are not added, changed, disabled or removed from this page: ${why}.`]]);
  for (const [id, line] of lines) {
    assert.ok(textOf(shown.byPage.get(id)!).includes(line), `${id}: ${line}`);
    assert.match(shown.byPage.get(id)!, new RegExp(`<p class="count">${line.split(":")[0]!}`), `${id}: in the Tables and Users lines' style`);
    assert.ok(!open.byPage.get(id)!.includes("read-only here"), `unset: ${id} says nothing of it`);
  }
  assert.match(open.byPage.get("usage")!, /Cancel stops one\./, "unset: Usage's lead names Cancel");
  assert.match(shown.byPage.get("usage")!, /The queries running right now\.(?! Cancel)/, "read-only: the lead without Cancel");
  assert.equal(fn<[string, unknown], string>("readOnlyLine")("Queries are not cancelled", null), "");
});

test("a read-only page: each renderer alone writes no control that changes anything — Tables, Users, the statements running and the checklist", async () => {
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
  assert.equal(fn<[unknown], string>("renderSharePane")(ro), "", "Temporary cloud login: absent on a read-only page");
  assert.match(fn<[unknown], string>("renderSharePane")(CATALOG_STATE), /data-share-open/, "unset: Open a cloud login is there");
  const { renderChecklist: checklist } = await import(path.join(WEB, "pages", "status.js") as string) as { renderChecklist: (s: unknown, u: unknown) => string };
  const nobody = { queries: { week: { completed: 0 } } };
  const fresh = { ...NONE, pageReadOnly: why };
  assert.ok(!/href="#users"|Add a table/.test(checklist(fresh, nobody)), "the checklist sends no one to add what the page refuses");
  assert.match(checklist(NONE, nobody), /Add a table/);
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
  assert.ok(!/Create a user|Add a user|<a class="btn[^"]*" href="#users"/.test(shown.all), "a lead to a user");
  // each page says why it offers no change, the Overview now without the tables
  for (const [id, line] of [["status", `No user is created from this page: ${why}.`], ["users", `Users are not added, changed, disabled or removed from this page: ${why}.`],
    ["usage", `Queries are not cancelled from this page: ${why}.`]] as const) assert.ok(textOf(shown.byPage.get(id)!).includes(line), `${id}: ${line}`);
  assert.ok(!textOf(shown.byPage.get("status")!).includes("Nothing is added or created"));
  // the checklist sends a person to add a table, never to create a user
  const { renderChecklist: checklist } = await import(path.join(WEB, "pages", "status.js") as string) as { renderChecklist: (s: unknown, u: unknown) => string };
  const nobody = { queries: { week: { completed: 0 } } };
  const fresh = checklist({ ...NONE, pageReadOnly: why, pageReadOnlyAllow: ["tables"] }, nobody);
  assert.match(fresh, /Add a table/);
  assert.ok(!/href="#users"/.test(fresh), "no Create a user first");
  assert.match(textOf(fresh), /○ Connect a tool \(to do\)$/, "the step still shows, without its button");
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

test("every link of Mason's own into a replaced view goes to the host's page: the Overview's Getting started, its cards and parts, Users' and Usage's Queries, Tables' sync events, Queries' and Usage's leads", async () => {
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
  // the one named in the issue, by name: the Overview's Getting started step (Connect is no longer on the Overview)
  for (const pageNav of [null, { items: { users: "/host/users" }, links: [] }]) {
    const run = fakeRun();
    run.answers.set("GET api/state", () => new Response(JSON.stringify({ ...COPYING, pageNav }), { status: 200 }));
    run.answers.set("GET api/queries", () => new Response(JSON.stringify({ queries: { ...QUERIES.queries, week: { ...QUERIES.queries.week, completed: 0 } } }), { status: 200 }));
    const app = fn<[unknown], App>("createApp")(run.fetch);
    await app.poll();
    const overview = app.view().status!;
    const leads = overview.match(/<a class="btn[^"]*" href="[^"]*"(?: rel="noreferrer")?>Create a user first<\/a>/g) ?? [];
    assert.equal(leads.length, 1, "Getting started's step");
    for (const a of leads) assert.ok(a.includes(pageNav === null ? 'href="#users">' : 'href="/host/users" rel="noreferrer">'), a);
  }
  // index.html's own links into a view (the Queries' and Usage's leads), which no part writes: the same rule over the document
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const main = html.split("<main>")[1]!;
  const statics = hashHrefs(main);
  assert.ok(statics.includes("#observability/queries"), "Usage's lead links to Queries (Queries' own lead is one sentence, no link)");
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
  const { renderUsersConnect } = await import(path.join(WEB, "pages", "users.js") as string) as { renderUsersConnect: (pg: unknown, served?: boolean) => string };
  const pg = { host: "localhost", port: 5433, database: "shop", shown: "postgresql://<user>:<password>@localhost:5433/shop", psql: "psql x" };
  const note = /A tool on another machine uses the server's own address in place of localhost/;
  assert.match(textOf(renderUsersConnect(pg, true)), note);
  assert.doesNotMatch(textOf(renderUsersConnect(pg)), note);
});

test("MASON_PG_PUBLIC_URL: /api/state's postgres is the address a client reaches, every Connect panel prints it, and no note to replace the host", async () => {
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
  const note = /A tool on another machine uses the server's own address/;
  const users = textOf(renderUsersConnect(pub, true));
  assert.match(users, /Host db\.example\.com Copy Port 6432 Copy Database shop Copy SSL mode verify-full Copy URL postgres:\/\/<user>:<password>@db\.example\.com:6432\/shop\?sslmode=verify-full Copy/);
  assert.doesNotMatch(users, note);
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
  answers.set("GET api/events?failed=1&since=24h&limit=1000", json(EVENTS));
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
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state", "GET api/share/choices"]);
  assert.match(textOf(app.view().users!), /^Active 1 Removed 0 User Role Status Added Last used metabase id 0123456789abcdef every table from anywhere Active 2026-10-27 09:10 UTC not used in the last \? days Queries Disable Remove$/);
  app.show("status");
  // the run stops
  run.answers.clear();
  await app.poll();
  v = app.view();
  assert.match(textOf(v.poll!), /^✗ Mason is not answering at this address why Mason stopped, or it now runs on another port \(fetch failed\) fix Run mason start/);
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
  assert.match(textOf(v.status!), /^mason status Under way (?!As of)/, "no as-of while it answers");
  assert.ok(!/stale-note/.test(v.poll!));
  // the run stops; a minute later the poll asks again
  run.answers.clear();
  clock += 60_000;
  await app.poll();
  v = app.view();
  assert.deepEqual(app.stale(), { at: new Date(Date.UTC(2026, 9, 27, 14, 2, 30)), failure: app.model.pollFailure }, "out of date: as of the last read that answered");
  assert.match(v.status!, /<div class="health warn stale" role="status"><p class="health-title">mason status<\/p><p class="health-word"><span class="dot" aria-hidden="true"><\/span><span class="word">Under way<\/span><\/p><p class="as-of">As of 14:02 UTC\. Mason can&#39;t be reached\.<\/p><p class="health-line">/,
    "the word it last read, greyed, said as of when and why");
  assert.equal(textOf(v.status!).startsWith("mason status Under way As of 14:02 UTC. Mason can't be reached."), true);
  assert.match(textOf(v.status!), /public\.orders 15% syncing/, "the rest it read stays (greyed by its section: in the browser test)");
  assert.ok(!/stale-note/.test(v.poll!), "the Overview says it in its word: the banner does not say it twice");
  assert.match(textOf(v.poll!), /^✗ Mason is not answering at this address/, "the banner says what to do");
  // another page shown while it fails: the banner says how old what it shows is
  clock += 30_000;
  app.show("tables");
  await app.poll();
  assert.equal(textOf(app.view().poll!).startsWith("As of 14:02 UTC. Mason can't be reached. What this page shows is from then. ✗ Mason is not answering"), true, app.view().poll);
  app.show("status");
  // a refusal (not a run gone): the same, said as the read that failed
  run.answers.set("GET api/state", () => new Response(JSON.stringify({ failure: { code: "failed", message: "the state could not be read" } }), { status: 500 }));
  await app.poll();
  assert.equal(textOf(app.view().status!).startsWith("mason status Under way As of 14:02 UTC. The latest read failed."), true, app.view().status);
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
  assert.equal(v.status, `<div class="health stale" role="status"><p class="health-title">mason status</p><p class="health-word"><span class="dot" aria-hidden="true"></span><span class="word">Unknown</span></p><p class="as-of">Mason can&#39;t be reached.</p></div>`);
  assert.equal(textOf(v.status!), "mason status Unknown Mason can't be reached.");
  assert.match(textOf(v.poll!), /^✗ Mason is not answering at this address/, "no as-of in the banner: there is no earlier read");
  for (const [k, a] of kept) run.answers.set(k, a);
  await app.poll();
  v = app.view();
  assert.match(textOf(v.status!), /^mason status Under way (?!As of)/, "the state, once it answers");
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
  assert.match(textOf(pop.el.html), /Mason is not answering at this address/);
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
  assert.match(textOf(app.view().action!), /Mason is not answering at this address/);
  assert.deepEqual(action.map((x) => x.greyed), [false], "Add a user's Failure is from now");
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable", next: [] }), { status: 200 }));
  assert.equal(await app.addUser("grafana"), true);
  assert.notEqual(app.stale(), null, "still out of date: the users were not read again");
  assert.ok(onceHtml(app.view()).includes(password));
  // the one-time dialog is no part of a section (index.html: after </main>), so a stale section's rule never greys it
  const index = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.ok(index.indexOf('<dialog id="once"') > index.lastIndexOf("</main>"), "an added user's password, shown once, is from now: never greyed");
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
  assert.ok(onceHtml(app.view()).includes(password));
  await app.poll();
  assert.ok(onceHtml(app.view()).includes(password), "a poll does not take it away before it is copied");
  app.dismissAdded();
  await app.poll();
  assert.ok(Object.values(app.view()).every((part) => !part.includes(password)), "once dismissed, nowhere on the page");
  assert.equal(app.model.added, null, "and not kept");

  run.answers.set("POST api/users", () => new Response(JSON.stringify({ error: "there is already a user \"grafana\"",
    failure: { code: "refused", message: "there is already a user \"grafana\"", why: "a name names one user", fix: "mason user remove grafana, then mason user add grafana", next: [{ command: "mason user list", what: "the users" }] } }), { status: 409 }));
  assert.equal(await app.addUser("grafana"), false);
  assert.equal(textOf(app.view().action!), "✗ there is already a user \"grafana\" why a name names one user fix mason user remove grafana, then mason user add grafana Next: mason user list the users");
  assert.equal(onceHtml(app.view()), "");
});

// ------------------------------------------------------------------ a user just added: waiting for its first query, then connected

const ADDED = (user: string) => {
  const password = `mason_0123456789abcdef_${"d".repeat(32)}`;
  const url = `postgres://${user}:${password}@127.0.0.1:5433/shop`;
  return { user, id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop", url, psql: psqlLine(url), host: "127.0.0.1", port: 5433, sslmode: "disable", roleFrom: "none" as const };
};
test("the New user added dialog: under its rows a status line, Waiting for its first query… until the user is seen, then Connected; no tool's guide, psql line or cloud line", () => {
  const renderAdded = (a: unknown, o?: unknown) => onceHtml(fn<[unknown, unknown?], Record<string, string>>("renderAdded")(a, o));
  const between = (html: string) => textOf(html).replace(/^.*? Copy Shown once /, "").replace(/ ?The password is only shown once$/, "");
  const waiting = renderAdded(ADDED("metabase"));
  assert.equal(between(waiting), "Waiting for its first query…");
  assert.equal(between(renderAdded(ADDED("metabase"), { connected: true })), "Connected");
  // waiting, then connected: a status's dot and its word (amber while waiting, the ok green once seen)
  assert.match(waiting, /<p class="added-seen"><span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>Waiting for its first query…<\/span><\/p>/);
  assert.match(renderAdded(ADDED("metabase"), { connected: true }), /<p class="added-seen"><span class="indicator ok"><span class="dot" aria-hidden="true"><\/span>Connected<\/span><\/p>/);
  assert.doesNotMatch(waiting, /<a |added-psql|added-guide|cloud/, "no link, no psql line, no line on a tool in the cloud");
});

test("connected: a session of the user added open now, or a statement of it since it was added — held once seen; the state read every 5 s only while the card waits", async () => {
  const addedSeen = fn<[unknown, unknown, unknown], boolean>("addedSeen");
  const a = ADDED("metabase2");
  const sessions = (byClient: unknown[]) => ({ ...CATALOG_STATE, sessions: { open: byClient.length, byClient } });
  const row = (lastUsedAt: string | null, removedAt: string | null = null) => ({ users: [{ name: "metabase2", id: a.id, addedAt: a.addedAt, removedAt, live: true, lastUsedAt }] });
  assert.equal(addedSeen(a, CATALOG_STATE, row(null)), false, "nothing yet");
  assert.equal(addedSeen(a, sessions([{ user: "metabase2", client: "Metabase v0.50", open: 1, running: 0 }]), row(null)), true, "a session open: a tool logged in, catalog queries or not");
  assert.equal(addedSeen(a, sessions([{ user: "metabase", client: "Metabase", open: 2, running: 0 }, { user: "", client: "psql", open: 1, running: 0 }]), row(null)), false, "another user's sessions are not its");
  assert.equal(addedSeen(a, { ...CATALOG_STATE, sessions: { error: "could not be read" } }, row("2026-10-27T09:12:00.000Z")), true, "a statement since it was added");
  assert.equal(addedSeen(a, CATALOG_STATE, row("2026-10-27T09:00:00.000Z")), false, "a statement of an earlier user of that name (removed, the name taken again) is not its");
  assert.equal(addedSeen(a, undefined, undefined), false, "nothing read: waiting");
  // the app: the card waits, the state read every 5 s while it does; a session open ticks it, and it stays connected
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { submit(f: unknown): Promise<void> | null }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("users");
  await app.poll();
  run.answers.set("POST api/users", answer(a));
  await app.pages.get("users")!.submit({ id: "add-user", elements: { name: { value: "metabase2" }, role: { value: "" }, connects: { value: "any" }, from: { value: "" } } });
  assert.match(textOf(onceHtml(app.view())), /Waiting for its first query…/);
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  t += 2000;
  assert.deepEqual(await asked(), [], "not at every 2 s poll");
  t += 3000;
  assert.deepEqual(await asked(), ["GET api/state"], "the state every 5 s while it waits");
  run.answers.set("GET api/state", answer(sessions([{ user: "metabase2", client: "Metabase v0.50", open: 1, running: 0 }])));
  t += 5000;
  await asked();
  assert.match(onceHtml(app.view()), /<span class="indicator ok"><span class="dot" aria-hidden="true"><\/span>Connected<\/span>/);
  // its session closed: still connected (held), and the state at the users' rate again
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  t += 5000;
  assert.deepEqual(await asked(), [], "seen: no faster read");
  t += 30_000;
  await asked();
  assert.match(textOf(onceHtml(app.view())), /Connected/);
  // dismissed: the card and its reads go
  app.dismissAdded();
  assert.equal(onceHtml(app.view()), "");
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
  const roleSelect = /<select id="user-role"[\s\S]*?<\/select>/.exec(form)?.[0] ?? "";
  assert.equal((roleSelect.match(/ selected/g) ?? []).length, 1, "one role preselected: the default");
  assert.ok(form.indexOf('id="user-name"') < form.indexOf('id="user-role"') && form.indexOf('id="user-role"') < form.indexOf('type="submit"'), "Name, Role, Add a user");
  // a file with no default: what mason user add gives with no --role first, no role
  assert.match(renderAddUser(stateOf([], { roles: rolesLive(["agent"], null) })), /<select id="user-role" name="role"><option value="" selected>no role \(its queries are refused\)<\/option><option value="agent">agent<\/option><\/select>/);
  // none: no roles file (the run's state has no roles, or a file of none), a file that names none, one that cannot be read, a read-only page
  const plain = renderAddUser(CATALOG_STATE);
  assert.ok(!plain.includes("user-role"), "no roles in the state: no Role choice (Connects from is its own dropdown)");
  assert.equal(renderAddUser(stateOf([], { roles: rolesLive([], null, null, null) })), plain, "no roles file: as before");
  assert.equal(renderAddUser(stateOf([], { roles: rolesLive([], null) })), plain, "a file naming no role: as before");
  assert.equal(renderAddUser(stateOf([], { roles: rolesLive(["agent"], "agent", "mason/roles.yml: it is not YAML") })), plain, "while it cannot be read: no choice");
  assert.equal(renderAddUser({ ...state, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" }), "", "read-only: no form, no choice");
  // one line on roles under the form, with roles or without: the file and the command that explains it
  // the link opens in the same tab: a host's CSP sandbox with no allow-popups silently drops a target="_blank" one
  for (const html of [form, plain]) assert.match(html, /<\/button><p class="dim roles-line">Roles limit a user to some tables and columns\. You write them in <code>mason\/roles\.yml<\/code>, and <a href="https:\/\/github\.com\/embeddable-hq\/mason-data#access-control" rel="noreferrer">the README<\/a> shows how\.<\/p><\/form>$/);
  // the README's section the link names is there: its heading's anchor
  assert.ok(/^### Access control$/m.test(fs.readFileSync(path.join(WEB, "..", "..", "README.md"), "utf8")), "README.md has the Access control section the link names");
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
  assert.equal(onceHtml(app.view()), "");
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends DELETE api/users/<name> and reads the users again", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  app.askRemove("metabase");
  assert.match(textOf(app.view().users!), /Remove metabase\? It can no longer connect/);
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
  assert.equal(textOf(app.view().users!), "No users yet. Create a user for a service like a BI tool or your app: add one below.");
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
  assert.match(html, /<td class="act" id="act-users-metabase"><a class="btn small" href="#observability\/queries\?user=metabase&amp;range=24h" title="the queries metabase sent in the last 24 hours">Queries<\/a> <button type="button" class="small" data-disable="metabase" data-room="Disable">Disable<\/button> <button type="button" class="danger small" data-remove="metabase">Remove<\/button><\/td>/);
  assert.match(html, /<td class="act" id="act-users-grafana"><a class="btn small" href="#observability\/queries\?user=grafana&amp;range=24h" title="the queries grafana sent in the last 24 hours">Queries<\/a> <button type="button" class="small" data-enable="grafana" data-room="Disable">Enable<\/button> <button type="button" class="danger small" data-remove="grafana">Remove<\/button><\/td>/);
  assert.equal(popsOf(html).length, 0, "Enable asks nothing");
  const asking = renderUsers(list, { name: "metabase", verb: "disable" }, NOW_U);
  assert.equal(textOf(popOf(asking, "act-users-metabase")), "Disable metabase? It can't connect until you enable it again, with the same password. Its open sessions end at their next query. Disable metabase Cancel");
  assert.match(asking, /data-confirm-disable="metabase"/);
  assert.match(asking, /<button type="button" class="small" data-room="Disable" aria-expanded="true" disabled>Disable<\/button>/, "held where it was while it asks");
  assert.ok(!/data-confirm-remove/.test(asking), "a Disable's question, not a Remove's");
});

test("Users: a disable's words and a disabled user's state are mason user's (disableEffect, disabledText in src/cli/user.ts)", async () => {
  const cli = await import("../src/cli/user.ts") as unknown as { disableEffect?: (n: string) => string; disabledText?: (at: string) => string };
  assert.equal(typeof cli.disableEffect, "function", "src/cli/user.ts exports disableEffect");
  assert.equal(typeof cli.disabledText, "function", "src/cli/user.ts exports disabledText");
  const usersPage = await import(path.join(WEB, "pages", "users.js") as string) as { disableEffect: (n: string) => string; disabledText: (at: string) => string };
  // the facts are mason user disable's; the page's way back is its own Enable, where the CLI names mason user enable (issue 877)
  assert.match(cli.disableEffect!("metabase"), /until mason user enable metabase, with the same password/);
  assert.equal(usersPage.disableEffect("metabase"), "It can't connect until you enable it again, with the same password. Its open sessions end at their next query.");
  for (const at of ["2026-10-28T09:00:59.000Z", "2026-01-02T03:04:05.678Z"]) assert.equal(usersPage.disabledText(at), cli.disabledText!(at));
});

test("the app: Disable asks first and its confirm sends POST api/users/<name>/disable; Enable sends /enable at once; each reads the users again; a refusal is said beside the user's actions", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  const a = app as unknown as { askDisable: (n: string) => void; confirmDisable: (n: string) => Promise<boolean>; enableUser: (n: string) => Promise<boolean> };
  a.askDisable("metabase");
  assert.match(textOf(app.view().users!), /Disable metabase\? It can't connect until you enable it again/);
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

test("a header cell is styled as a cell alone: in every table that pins its actions (Users, Tables) the actions column, last, is the only pinned header, and no rule of a box (a card, the New user added) reaches a header cell by its class", () => {
  const renderUsers = fn<[unknown, unknown, number?], string>("renderUsers");
  const renderTables = fn<[unknown], string>("renderTables");
  const at = { addedAt: "2026-10-27T09:10:11.000Z", live: true, lastUsedAt: null, url: null };
  const users = renderUsers({ users: [{ name: "metabase", id: "0000000000000001", ...at, removedAt: null, from: null }, { name: "old", id: "0000000000000002", ...at, removedAt: "2026-10-28T09:00:00.000Z", from: null }],
    lastUsedNote: null, urlNote: null, requestLogDays: 7 }, null, Date.parse("2026-10-29T09:00:00.000Z"));
  const heads = (html: string) => [...(/<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "").matchAll(/<th\b([^>]*)>/g)].map((m) => (/class="([^"]*)"/.exec(m[1]!)?.[1] ?? "").split(" ").filter(Boolean));
  const classes = new Set<string>();
  for (const [name, html] of [["Users", users], ["Tables", renderTables(CATALOG_STATE)]] as const) {
    const cells = heads(html);
    assert.ok(cells.length > 3, `${name}: its header cells`);
    assert.deepEqual(cells.map((c, i) => c.includes("act") ? i : -1).filter((i) => i >= 0), [cells.length - 1], `${name}: the actions column alone is act, and last`);
    for (const c of cells.flat()) classes.add(c);
  }
  assert.deepEqual(heads(users), [[], ["role"], ["status"], ["added"], ["num", "last"], ["act"]], "the users' header cells, as the page writes them");
  // every selector naming a header cell's class names it on a cell (th.x, td.x), so a rule meant for something else
  // (`.added`, the New user added card: a white box with a brown left border) never paints a header (num: the mono numbers, any element)
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // a selector list split at its top-level commas: `:is(th, td).last` is one selector, naming the cells
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1]!.split(/,(?![^()]*\))/).map((x) => x.trim())).filter((x) => x && !x.startsWith("@"));
  for (const c of [...classes].filter((x) => x !== "num")) {
    const loose = selectors.filter((sel) => new RegExp(`(^|[^\\w-])\\.${c}(?![\\w-])`).test(sel) && !new RegExp(`(^|[\\s>+~(])(th|td)(\\.[\\w-]+)*\\.${c}(?![\\w-])|:is\\((th|td)(, (th|td))*\\)\\.${c}(?![\\w-])`).test(sel));
    assert.deepEqual(loose, [], `.${c} is a header cell's class: styled only as a cell`);
  }
  // the pinned rule (position: sticky; right: 0) names the actions' cells alone
  const pinned = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /position: sticky; right: 0/.test(m[2]!)).flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
  assert.ok(pinned.length > 0);
  for (const sel of pinned) assert.match(sel, /\b(td|th)\.act$/, `pinned: ${sel}`);
});

test("the users: each user's addresses on a line under its role, as mason user says them — from its ranges, or from anywhere; the line is its From…; a removed user's none; read-only, the words alone", async () => {
  const renderUsers = fn<[unknown, unknown, number?, unknown?, unknown?, unknown?, string?], string>("renderUsers");
  const { rangesText } = await import("../src/cli/user.ts");
  const page = await import(path.join(WEB, "pages", "users.js") as string) as { rangesText: (f: unknown) => string; fromText: (f: unknown) => string };
  for (const f of [null, undefined, ["192.0.2.0/24"], ["192.0.2.0/24", "2001:db8::/32", "198.51.100.7/32"]]) assert.equal(page.rangesText(f), rangesText(f as string[] | null), JSON.stringify(f));
  const at = { addedAt: "2026-10-27T09:10:11.000Z", live: true, lastUsedAt: null, url: null };
  const list = { users: [{ name: "looker", id: "0000000000000001", ...at, removedAt: null, from: ["192.0.2.0/24", "2001:db8::/32"] }, { name: "metabase", id: "0000000000000002", ...at, removedAt: null, from: null },
    { name: "old", id: "0000000000000003", ...at, removedAt: "2026-10-28T09:00:00.000Z", from: ["192.0.2.0/24"] }], lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const html = renderUsers(list, null, Date.parse("2026-10-29T09:00:00.000Z"));
  assert.match(textOf(html), /^Active 2 Removed 1 User Role Status Added Last used looker id 0000000000000001 every table from 192\.0\.2\.0\/24, 2001:db8::\/32 Active 2026-10-27 09:10 UTC .* Queries Disable Remove metabase id 0000000000000002 every table from anywhere Active 2026-10-27 /);
  // the line is its From…, its whole the title (the column cuts it); no column of its own, no button in the actions
  assert.match(html, /<span class="dim">every table<\/span><button type="button" class="from-line" data-from="looker" title="from 192\.0\.2\.0\/24, 2001:db8::\/32: change where looker connects from">from 192\.0\.2\.0\/24, 2001:db8::\/32<\/button><\/td>/);
  assert.equal([...html.matchAll(/<th scope="col"/g)].length, 6, "the columns as before");
  assert.ok(![...html.matchAll(/<td class="act"[^>]*>(.*?)<\/td>/gs)].some((m) => m[1]!.includes("data-from")), "the actions as before");
  const gone = renderUsers(list, null, Date.parse("2026-10-29T09:00:00.000Z"), null, null, null, "removed");
  assert.ok(!/data-from="old"/.test(gone) && !/<tr class="removed">.*?from-line/s.test(gone), "a removed user connects from nowhere: nothing said");
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
  assert.equal(textOf(pops[0]!.html), "Choose where looker can connect from. If you limit it, open sessions from other addresses end at their next query. Connects from anywhere only these addresses Address ranges, comma-separated Change looker Cancel");
  assert.match(pops[0]!.html, /<select id="user-from-connects" name="connects"><option value="any">anywhere<\/option><option value="only" selected>only these addresses<\/option><\/select>/, "opened at its ranges");
  assert.match(pops[0]!.html, /<input id="user-from-from" name="from"[^>]* value="192\.0\.2\.0\/24, 2001:db8::\/32">/);
  assert.match(pops[0]!.html, /<input type="hidden" name="user" value="looker"><\/form>/);
  assert.match(pops[0]!.html, /data-pop-close/, "Escape presses its Cancel");
  assert.ok(!/pattern=|required/.test(pops[0]!.html), "the run judges each range, never the page");
  // its From… held where it was while it asks; no row and no cell added
  assert.match(asking, /<button type="button" class="from-line" title="[^"]*" aria-expanded="true" disabled>from 192\.0\.2\.0\/24, 2001:db8::\/32<\/button>/, "its line held while it asks");
  assert.equal(textOf(withoutPops(asking)), textOf(renderUsers(list, null)), "the rows say what they said");
  // a user from anywhere opens at anywhere, its box empty
  const any = popOf(renderUsers(list, { name: "metabase", verb: "from" }), "act-users-metabase");
  assert.match(any, /<option value="any" selected>anywhere<\/option><option value="only">only these addresses<\/option>/);
  assert.match(any, /name="from"[^>]* value="">/);
});

test("the add form: Connects from, a dropdown in mason user add's words — anywhere (the default, no from sent) or only these addresses, the box beside it, a comma list as --from takes it, the run judging each", async () => {
  const renderAddUser = fn<[unknown], string>("renderAddUser");
  const form = renderAddUser(CATALOG_STATE);
  assert.match(textOf(form), /Name Connects from anywhere only these addresses Address ranges, comma-separated Add a user Roles limit/);
  assert.match(form, /<span class="connects"><label for="add-user-connects">Connects from<\/label> <select id="add-user-connects" name="connects"><option value="any" selected>anywhere<\/option><option value="only">only these addresses<\/option><\/select> <span class="ranges">/,
    "a dropdown, its label; anywhere the default, as mason user add with no --from; the box beside it");
  assert.doesNotMatch(form, /type="radio"|<fieldset/, "no radios");
  // the box keeps its place while anywhere is chosen (visibility, never display): nothing in the form moves when the choice changes
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.connects:has\(option\[value="any"\]:checked\) \.ranges \{ visibility: hidden; \}/);
  assert.doesNotMatch(css, /fieldset\.connects|\.connects[^{]*input\[type="radio"\]/, "the radios' rules are gone");
  assert.match(form, /<input id="add-user-from" name="from" spellcheck="false" autocapitalize="off" placeholder="e\.g\. 192\.0\.2\.0\/24, 2001:db8::\/32" value="">/);
  assert.ok(!/pattern=/.test(form), "never validated in the page");
  const { rangesOf } = await import(path.join(WEB, "pages", "users.js") as string) as { rangesOf: (e: unknown) => string[] | null };
  assert.equal(rangesOf({ connects: { value: "any" }, from: { value: "192.0.2.0/24" } }), null, "from anywhere: what is typed is not sent");
  assert.equal(rangesOf({}), null, "no choice: from anywhere");
  assert.deepEqual(rangesOf({ connects: { value: "only" }, from: { value: " 192.0.2.0/24 ,2001:db8::/32, " } }), ["192.0.2.0/24", "2001:db8::/32"]);
  assert.deepEqual(rangesOf({ connects: { value: "only" }, from: { value: "not a range" } }), ["not a range"], "sent as typed: the run refuses it");
  assert.deepEqual(rangesOf({ connects: { value: "only" }, from: { value: "" } }), [], "none: sent as none, for the run to refuse");
});

test("the add form on one line where its card is wide enough: each field a label and its control in one span, the form a wrapping row, Connects from taking the rest, nothing moving on its choice", () => {
  const renderAddUser = fn<[unknown], string>("renderAddUser");
  const form = renderAddUser(stateOf([], { roles: rolesLive(["everything", "agent"], "everything") }));
  // the form's children, in order: Name's span, Role's, Connects from's, Add a user — never a label apart from its control
  const children = [...form.replace(/^<form[^>]*>|<\/form>$/g, "").matchAll(/<(span|button)\b[^>]*? class="([^"]*)"/g)];
  assert.match(form, /^<form id="add-user" class="formcard" autocomplete="off"><span class="name-field"><label for="user-name">Name<\/label> <input id="user-name"[^>]*><\/span> <span class="role-field">/);
  assert.ok(["name-field", "role-field", "connects", "primary"].every((c) => children.some((m) => m[2] === c)), "the four fields");
  assert.match(textOf(renderAddUser(CATALOG_STATE)), /^Name Connects from anywhere only these addresses Address ranges, comma-separated Add a user Roles limit a user to some tables and columns\. You write them in mason\/roles\.yml , and the README shows how\.$/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /#add-user \.roles-line \{ flex: 0 0 100%;/, "the line on roles is the form's own last row, under the fields");
  const rule = (sel: string) => css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.#[\]="]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule("#add-user-box"), /container-type: inline-size;/, "the form's card is its own container");
  assert.match(rule("#add-user"), /display: flex; flex-wrap: wrap;/, "one row, wrapping by field below its width");
  assert.match(rule("#add-user .name-field"), /display: inline-flex;/);
  assert.match(rule("#add-user .connects"), /margin: 0; flex: 1 1 \d+px;/, "Connects from takes the rest of the line");
  assert.match(rule("#add-user .connects .ranges"), /min-width: 0;/, "the address box shrinks inside its field, never over Add a user");
  assert.match(rule("#add-user .connects .ranges input"), /width: 100%; min-width: 0;/);
  // the box's place is kept while anywhere is chosen: the choice changes no width, so nothing moves
  assert.match(css, /\.connects:has\(option\[value="any"\]:checked\) \.ranges \{ visibility: hidden; \}/);
  assert.doesNotMatch(css, /\.ranges\s*\{[^}]*display: none/);
});

test("the app: the add form sends from only when only these addresses is chosen; the run's refusal of a range is shown as the run words it", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App & { pages: Map<string, { submit(f: unknown): Promise<void> | null }> }>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  assert.match(app.view()["add-user-box"]!, /name="connects"><option value="any" selected>anywhere<\/option><option value="only">/);
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
  assert.equal(onceHtml(app.view()), "");
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
  assert.ok(!/Add a table|<a class="btn[^"]*" href="#tables[^"]*"/.test(shown.all), "no lead to a table");
  // each page says why it offers no change: the Overview without the users, Tables and Usage as before
  for (const [id, line] of [["status", `No table is added from this page: ${why}.`], ["tables", `Tables are not added, removed or synced from this page: ${why}.`],
    ["usage", `Queries are not cancelled from this page: ${why}.`]] as const) assert.ok(textOf(shown.byPage.get(id)!).includes(line), `${id}: ${line}`);
  // the checklist's Create a user, never Add a table
  const { renderChecklist: checklist } = await import(path.join(WEB, "pages", "status.js") as string) as { renderChecklist: (s: unknown, u: unknown) => string };
  const nobody = { queries: { week: { completed: 0 } } };
  const fresh = checklist({ ...NONE, pageReadOnly: why, pageReadOnlyAllow: ["users"] }, nobody);
  assert.match(fresh, /href="#users">Create a user first/);
  assert.ok(!/Add a table/.test(fresh));
  // the renderers alone: an allowance the page does not know is no allowance; without the page read-only nothing changes
  const renderAddUser = fn<[unknown], string>("renderAddUser");
  assert.equal(renderAddUser(state), renderAddUser(CATALOG_STATE), "the add form as on a page that is not read-only");
  assert.equal(renderAddUser({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["tables"] }), "", "only tables allowed: no form");
  assert.equal(renderAddUser({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["user"] }), "", "an area the page does not know");
  assert.equal(renderAddUser({ ...CATALOG_STATE, pageReadOnlyAllow: ["users"] }), renderAddUser(CATALOG_STATE));
});

test("a read-only page that still changes its tables and its users (pageReadOnlyAllow: [tables, users]): both pages' controls; the Overview says nothing is refused; Cancel and Temporary cloud login still absent (issue 813)", async () => {
  const why = "the web page is read-only here (MASON_UI_READ_ONLY=1)";
  const shown = await pageByPage({ ...CATALOG_STATE, pageReadOnly: why, pageReadOnlyAllow: ["tables", "users"] });
  for (const control of ["data-add-table", "data-sync-table", "data-remove-table", 'id="add-user"', "data-from=", "data-disable="]) assert.ok(shown.all.includes(control), control);
  // the run refuses /api/share on any read-only page, whatever it still allows: no Share box
  for (const control of ["data-ask-cancel", "data-share-open"]) assert.ok(!shown.all.includes(control), control);
  assert.ok(!/Temporary cloud login|data-add-kind/.test(shown.all), "no temporary cloud login, no segments");
  assert.ok(!textOf(shown.overview).includes("from this page"), "the Overview refuses nothing it offers");
  assert.ok(textOf(shown.byPage.get("usage")!).includes(`Queries are not cancelled from this page: ${why}.`));
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
  assert.match(textOf(v.tables!), /public\.accounts Waiting ~300 rows key id View events Sync now Remove Sync… All but 1 column waiting for its first sync to start public\.event_log/);
  assert.match(textOf(popOf(v.tables!, "act-tables-public.accounts")), /^Added public\.accounts: every column but password_hash\. Its sync is Off: .* Left out password_hash: it looks like a secret/);
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
  assert.match(popOf(tables, "act-tables-public.event_log"), /^<div class="pop ask"[^>]*><button type="button" class="pop-x".*?<\/button><div class="failure" role="alert">.*data-pick-form="public\.event_log"/s, "the form stays, to name its key, under the refusal");
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
  assert.equal(textOf(popOf(app.view().tables!, "act-tables-public.accounts")), "Remove accounts? Mason will stop syncing it and delete its synced data. Remove accounts Cancel");
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
  // removed: it keeps its row (laid out in Added), its state Not added in place, until the list is laid out again (issue 872)
  assert.match(textOf(app.view().tables!), /public\.events Synced .* public\.accounts Not added ~300 rows key id Add Columns… Not added \(3\) .*public\.audit Not added/);
  assert.match(textOf(popOf(app.view().tables!, "act-tables-public.accounts")), /^Removed public\.accounts\. Mason stopped syncing it and deleted its synced data\./);
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
    // the one site the page names is a link to its README's roles section (users.js ROLES_DOCS_URL): a link the reader
    // follows loads nothing into the page, so the CSP holds; nothing else is ever named
    const text = fs.readFileSync(path.join(WEB, f), "utf8").replace(/ROLES_DOCS_URL = "https:\/\/github\.com\/embeddable-hq\/mason-data#access-control";/, "");
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
  assert.ok(found.length >= 4, `the page's placeholders are found (${found.length})`);
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
  // a dialog's too (the one-time dialog, index.html #once): `open`, `showModal` (counted in `shown`; a second while open
  // throws, as a browser's does), `close` (its close event after, as a browser fires it), and the events it was given
  interface FakeEl { id: string; writes: number; html: string; hidden?: boolean; innerHTML: string; attrs: Map<string, string>;
    open: boolean; shown: number; listeners: Map<string, Array<(e: unknown) => void>>; addEventListener(type: string, f: (e: unknown) => void): void; fire(type: string, e?: unknown): void;
    showModal(): void; close(): void;
    setAttribute(k: string, v: string): void; removeAttribute(k: string): void; contains(t: { in?: string } | null): boolean; focus(): void; querySelector(sel: string): FakeEl }
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => els.get(id) ?? (els.set(id, { id, writes: 0, html: "", attrs: new Map(), open: false, shown: 0, listeners: new Map(),
    addEventListener(type: string, f: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]); },
    fire(type: string, e: unknown = {}) { for (const f of this.listeners.get(type) ?? []) f(e); },
    showModal() { if (this.open) throw new Error("InvalidStateError: the dialog is already open"); this.open = true; this.shown++; },
    close() { if (!this.open) return; this.open = false; setTimeout(() => this.fire("close"), 0); },
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
  class FormData {
    readonly ticked: Record<string, string[]>;
    constructor(form: { ticked: Record<string, string[]> }) { this.ticked = form.ticked; }
    getAll(name: string) { return this.ticked[name] ?? []; }
    get(name: string) { return this.ticked[name]?.[0] ?? null; }
  }
  fn<[unknown, unknown], void>("start")(doc, { fetch: (p: string, i?: { method?: string; body?: string }) => run.fetch(p, i), FormData, location, addEventListener: (type: string, f: () => void) => { onWin.set(type, f); },
    setInterval: (f: () => void) => { tick = f; return 1; }, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), ...winExtra });
  /** the reader follows a link of the nav: the hash changes, and the browser says so */
  const go = (to: string) => { location.hash = to; onWin.get("hashchange")!(); };
  return { el, on, doc, go, replaced, tick: () => tick!(), settle: () => new Promise((r) => setTimeout(r, 20)) };
}

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
  // a tab of the page shown (Active, Removed: #users?show=removed) is no arriving: the focus stays where it was
  const run = fakeRun();
  const { doc, go, settle } = fakeBrowser(run, "#users");
  await settle();
  const d = doc as unknown as { focused: string };
  assert.equal(d.focused, "user-name");
  d.focused = "";
  go("#users?show=removed"); await settle();
  go("#users"); await settle();
  assert.equal(d.focused, "", "a tab followed moves no focus");
});

test("after Add a user, New user added is a modal dialog: its Copy focused; a poll never closes nor rewrites it, its status line alone moves; Escape, a backdrop click and a hash followed leave it open; I have copied it closes it, the password gone and the focus on Name; never on a read-only page", async () => {
  const password = `mason_0123456789abcdef_${"a".repeat(32)}`;
  const run = fakeRun();
  run.answers.set("GET api/state", answer(CATALOG_STATE));
  run.answers.set("POST api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop` }), { status: 200 }));
  const { el, on, doc, go, tick, settle } = fakeBrowser(run, "#users");
  await settle();
  const d = doc as unknown as { focused: string };
  const once = el("once");
  tick(); await settle();
  assert.deepEqual([once.open, once.shown], [false, 0], "nothing added: no dialog");
  assert.equal(onceHtml({ "once-head": el("once-head").html, "once-status": el("once-status").html, "once-foot": el("once-foot").html }), "");
  // Add a user: the dialog opens over the page, filled, its first Copy (the URL's) focused; nothing under the form
  await on.get("submit")!({ target: { id: "add-user", elements: { name: { value: "grafana" }, connects: { value: "any" } } }, preventDefault: () => undefined });
  await settle();
  assert.deepEqual([once.open, once.shown], [true, 1], "opened as a modal, once");
  assert.match(el("once-head").html, /^<p class="once-title" id="once-title">New user added<\/p><dl class="facts"><dt>URL<\/dt>[^]*<dt>User<\/dt><dd>grafana<\/dd>[^]*Shown once/);
  assert.ok(el("once-head").html.includes(password));
  assert.match(textOf(el("once-status").html), /^Waiting for its first query…$/);
  assert.equal(textOf(el("once-foot").html), "The password is only shown once");
  assert.equal(d.focused, "once [data-copy]", "the focus on its first Copy");
  assert.ok(!el("added").html.includes(password) && !el("action").html.includes(password), "no card under the form");
  // polls: nothing closes it, and what it shows is not written again
  const writes = () => [el("once-head").writes, el("once-status").writes, el("once-foot").writes];
  const was = writes();
  for (let i = 0; i < 4; i++) { tick(); await settle(); }
  go("#users"); await settle();
  assert.deepEqual([once.open, once.shown, writes()], [true, 1, was], "a poll neither closes nor rewrites it");
  // Escape: the dialog's cancel refused, the key's default too; a browser that closes it anyway sees it opened again
  let cancelled = false;
  once.fire("cancel", { preventDefault: () => { cancelled = true; } });
  assert.ok(cancelled, "its cancel event (Escape) is refused");
  let escaped = false;
  await on.get("keydown")!({ key: "Escape", preventDefault: () => { escaped = true; } });
  assert.ok(escaped && once.open, "Escape is no close request while it is open");
  once.close(); await settle();
  assert.deepEqual([once.open, once.shown], [true, 2], "closed by anything but its button: opened again");
  assert.ok(el("once-head").html.includes(password), "with what it showed");
  // a click on the backdrop (the dialog itself, no button) does nothing
  await on.get("click")!({ target: { in: "once", closest: () => null } });
  await settle();
  assert.equal(once.open, true, "a backdrop click leaves it open");
  // another page followed under it (Back): still open, whichever page is shown
  go("#tables"); await settle();
  assert.equal(once.open, true, "a hash followed leaves it open");
  go("#users"); await settle();
  // the user connects: its status line alone is written again
  run.answers.set("GET api/state", answer({ ...CATALOG_STATE, sessions: { open: 1, byClient: [{ user: "grafana", client: "Grafana", open: 1, running: 0 }] } }));
  const head = el("once-head").writes;
  go("#users"); await settle();
  assert.match(textOf(el("once-status").html), /^Connected$/);
  assert.equal(el("once-head").writes, head, "the facts the person copies from not rewritten");
  // I have copied it: closed, nothing of it left on the page, the focus back on the add form's Name
  await on.get("click")!({ target: { closest: (sel: string) => sel === "button" ? { dataset: { dismissOnce: "" } } : null } });
  await settle();
  assert.equal(once.open, false, "closed by its button");
  assert.equal(d.focused, "user-name", "the focus back on Name");
  assert.deepEqual([el("once-head").html, el("once-status").html, el("once-foot").html], ["", "", ""]);
  assert.ok([...["users", "added", "action", "once-head", "once-status", "once-foot"]].every((id) => !el(id).html.includes(password)), "the password nowhere on the page");
  tick(); await settle();
  assert.equal(once.shown, 2, "and never again");
  // a read-only page adds no user: never a dialog
  const ro = fakeRun();
  ro.answers.set("GET api/state", answer({ ...CATALOG_STATE, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" }));
  const b = fakeBrowser(ro, "#users");
  await b.settle(); b.tick(); await b.settle();
  assert.deepEqual([b.el("once").open, b.el("once").shown, b.el("add-user-box").html], [false, 0, ""]);
});

test("the stylesheet: the Users table's Added header is no card, the add box keeps the height of its taller pane, and Users › Connect's tip is one line of text (issue 877)", async () => {
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // the added user's card is a div: its frame and its accent bar never style the table's <th class="added">
  const rules = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].map((m) => m[1]!.trim());
  const bare = rules.flatMap((r) => r.split(",").map((x) => x.trim())).filter((sel) => /(^|[\s>+~])\.added(?![\w-])/.test(sel));
  assert.deepEqual(bare, [], `a selector of .added alone also matches th.added: ${bare.join(" | ")}`);
  assert.match(css, /\.user-added, \.done \{ border: 1px solid var\(--frame\); border-left: 4px solid/);
  assert.match(fn<[unknown, unknown], string>("renderUsers")({ users: [{ name: "a", id: "1", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, disabledAt: null, live: true, lastUsedAt: null }] }, null), /<th scope="col" class="added">Added<\/th>/);
  // the add box's two panes in one grid cell, the one not chosen unseen in its place (visibility, never display)
  assert.match(css, /\.add-panes \{ display: grid; \}/);
  assert.match(css, /\.add-panes > \* \{ grid-area: 1 \/ 1; min-width: 0; \}/);
  // the share pane is unseen unless it is chosen — never only when New user is: where no choice is drawn (mason serve,
  // a read-only page) it is an empty pane over the form in the same cell, and a visible one took the clicks meant for
  // the form's Name and Add a user (the owner, 2026-11-13: "it seems the add-share-box is the div getting in the way")
  assert.match(css, /\.add-box:has\(\[data-add-kind="share"\]\[aria-pressed="true"\]\) #add-user-box,\s*\.add-box:not\(:has\(\[data-add-kind="share"\]\[aria-pressed="true"\]\)\) #add-share-box \{ visibility: hidden; \}/);
  const rulesOf = (sel: RegExp) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => sel.test(m[1]!));
  assert.ok(!rulesOf(/:has\(\[data-add-kind="user"\]\[aria-pressed="true"\]\)[^,{]*#add-share-box/).length, "never hidden only when New user is pressed: with no choice drawn it would stay over the form");
  // the tip is a flex row: its sentence one item, so the full stop after <password> never wraps onto a line of its own
  const usersConnect = (await import(path.join(WEB, "pages", "users.js") as string) as { renderUsersConnect: (pg: unknown) => string }).renderUsersConnect;
  const tip = /<p class="tip">(.*?)<\/p><\/div>$/.exec(usersConnect({ shown: "postgres://<user>:<password>@127.0.0.1:5433/shop", host: "127.0.0.1", port: 5433, database: "shop" }))?.[1] ?? "";
  assert.match(tip, /^<span>Put a user's name and password in place of <code>&lt;user&gt;<\/code> and <code>&lt;password&gt;<\/code>\. The password .*<\/span>$/);
});

test("Finishing sync: the label of a table getting the changes made during its first sync, the line under it and the stream's detail in plain words; --json keeps catching-up (issue 877)", () => {
  assert.equal(page.CATCHING_UP, "Getting the changes made since it was last synced. You can query it meanwhile.");
  assert.equal(page.CATCHING_UP, commands.CATCHING_UP, "mason status says the same sentence");
  const s = stateOf([{ ...copied("public.events", 1000, new Date(NOW - 5000).toISOString()), behind: "after its whole read", rebuilding: "catch-up",
    kept: { by: "poll", sync: { mode: "off" }, syncedAt: new Date(NOW - 5000).toISOString(), nextAt: null, pending: "it is caught up by one poll after its whole read first", promisedSeconds: null, lateWhy: null } } as CopyState], { now: NOW });
  const t = s.tables.find((x) => x.table === "public.events")!;
  assert.equal((t as { sync?: { state?: string } }).sync?.state, "catching-up", "the state's word is unchanged");
  const html = fn<[unknown, Record<string, unknown>?], string>("renderTables")(s, { now: NOW });
  assert.match(html, /<span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>Finishing sync<\/span>/);
  assert.doesNotMatch(textOf(html), /Catching up|caught up by one poll/);
  assert.match(textOf(html), /Getting the changes made since it was last synced\. You can query it meanwhile\./);
  const stream = fn<[unknown, number], { tables: Array<[string, string]> }>("streamRows");
  for (const [phase, words] of [["queued", "waiting its turn"], ["polling", "reading the changes"], ["applying", "applying the changes"]]) {
    const st = { ...STREAM, tables: [{ table: "public.orders", state: "catching-up", why: null, applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 },
      catchUp: { phase, from: "2026-10-27T14:02:00.000Z", startedAt: null, held: 0, retryAt: null } }] };
    assert.match(stream(st, NOW).tables[0]![1], new RegExp(`^getting the changes made since 2026-10-27 14:02 UTC: ${words}`), phase);
  }
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
  assert.match(textOf(users.html), /Remove metabase\? It can no longer connect/);
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
  assert.match(textOf(tables.html), /public\.orders Syncing 15% 280,000 key id View events Sync now Remove Sync… All columns syncing /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { removeTable: "public.orders" } }) } });
  assert.match(textOf(tables.html), /Remove orders\? Mason will stop syncing it and delete its synced data\. Remove orders Cancel/);
  let writes = tables.writes;
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "the tables, unchanged while a copy moves, are not written again: the confirm stays the one clicked");
  // the run reads the catalog again every few seconds, and a live database's row estimates move (pg_class.reltuples)
  const rowsOf = (audit: number) => answer({ ...COPYING, tables: COPYING.tables.map((t) => t.table === "public.audit" ? { ...t, rows: audit } : t) });
  run.answers.set("GET api/state", rowsOf(350));
  tick(); await settle();
  assert.equal(tables.writes, writes, "rows that moved while a Remove asks do not write the tables again: the confirm stays the one clicked");
  assert.match(textOf(tables.html), /public\.orders Syncing 15% 280,000 key id View events Sync now Remove Sync… All columns syncing .* public\.audit Not added ~50 rows key id Add Columns… /);
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
  await on.get("submit")!({ target: { dataset: { pickForm: "public.audit" }, ticked: { which: ["only"], columns: ["name"] } }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the page posts it, not the browser");
  assert.ok(run.asked.includes(`POST api/pick ${JSON.stringify({ table: "public.audit", picked: true, columns: ["name"] })}`), run.asked.join("\n"));
  assert.match(textOf(tables.html), /Added public\.audit: the columns id, name\. Its sync is every 30 seconds: .* Its key id was added to its columns/, "what was added, in the page's words");
  assert.doesNotMatch(textOf(tables.html), /sources\/shop\.yml/, "the page names no file");
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
  // the last 15 minutes first, the default (its link has no range); every range is live, said Live before the control,
  // its title how often that range is read again (a longer range less often: each read scans more of the log)
  const live = renderSubnav("usage");
  assert.equal(textOf(live), "Live Last 15 mins Last hour 24 hours 7 days");
  assert.equal(live, `<span class="range-status"><span class="live" title="Updates every few seconds"><span class="live-dot" aria-hidden="true"></span>Live</span></span>` +
    `<div class="range" role="group" aria-label="Time range"><a href="#observability/usage" aria-current="true" title="Updates every few seconds">Last 15 mins</a>` +
    `<a href="#observability/usage?range=1h" title="Updates every few seconds">Last hour</a>` +
    `<a href="#observability/usage?range=24h" title="Updates every 30 seconds">24 hours</a><a href="#observability/usage?range=7d" title="Updates every minute">7 days</a></div>`);
  for (const [range, title] of [["1h", "Updates every few seconds"], ["24h", "Updates every 30 seconds"], ["7d", "Updates every minute"], ["90d", "Updates every minute"]] as const) {
    const h = renderSubnav("queries", range, 90);
    assert.match(h, new RegExp(`^<span class="range-status"><span class="live" title="${title}">`), `${range}: live too`);
    assert.ok(!/data-refresh-range|as of/.test(h), `${range}: nothing to refresh`);
  }
  // the control never moves when the range changes (issue 873): the status, the same Live at every range, is written
  // BEFORE the control, in one slot, and the control is the last thing written, so it stays flush right
  for (const range of ["now", "1h", "24h", "90d"]) {
    const h = renderSubnav("queries", range, 90);
    assert.match(h, /^<span class="range-status">.*<\/span><div class="range" role="group" aria-label="Time range">.*<\/div>$/s, `${range}: the status first, the control last`);
    assert.equal((h.match(/class="range-status"/g) ?? []).length, 1, `${range}: one status slot`);
    assert.equal(textOf(h.slice(0, h.indexOf('<div class="range"'))), "Live", `${range}: the same words`);
  }
  const styles = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  const slot = styles.match(/\.head-range \.range-status \{([^}]*)\}/)?.[1] ?? assert.fail("app.css lays out the status slot");
  assert.match(slot, /min-height: 28px/, "as tall as the row's controls");
  assert.match(styles, /\.head-range \{[^}]*justify-content: flex-end;/, "the control flush right");
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
  assert.deepEqual(await asked(), ["GET api/users?lastUsed=1", "GET api/state", "GET api/share/choices"], "a page shown is read at once, the shell's state with it");
  // Queries at Now, the default: the newest requests of the last 15 minutes, every 5 s (the state, how to connect, and
  // the users, the User filter's choices — never ?lastUsed=1, a scan of the log it does not show — every 30 s)
  app.show("queries");
  assert.deepEqual(await asked(), ["GET api/requests?since=15m", "GET api/state", "GET api/users"], "Queries: the request log of the range, and the users for its filter");
  t += 2000;
  assert.deepEqual(await asked(), [], "2 s on: nothing is due");
  t += 4000;
  assert.deepEqual(await asked(), ["GET api/requests?since=15m"], "the last 15 minutes are live: the request log again every 5 s");
  // every range is live: the last hour read when it is chosen, then again by time
  app.show("observability/queries?range=1h");
  assert.deepEqual(await asked(), ["GET api/requests?since=1h", "GET api/state", "GET api/users"], "the last hour, read when it is chosen");
  t += 6000; assert.deepEqual(await asked(), ["GET api/requests?since=1h"], "the last hour is live too: again every 5 s");
  // a range shown again is read again at once, everything shown
  (app as unknown as { markStale(): void }).markStale();
  assert.deepEqual(await asked(), ["GET api/requests?since=1h", "GET api/state", "GET api/users"], "shown again: everything shown read again");
  t += 10_000;
  assert.deepEqual(await asked(), ["GET api/requests?since=1h"], "then at its rate");
  app.show("observability/queries?range=1h");
  assert.deepEqual(await asked(), ["GET api/requests?since=1h", "GET api/state", "GET api/users"], "shown again: read again");
  // the page's own read failing is the banner; a slower one failing is said where it is shown, never as the banner
  app.show("status");
  run.answers.set("GET api/queries", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  t += 30_000;
  await app.poll();
  assert.equal(app.view().poll, "");
  assert.match(textOf(app.view().status!), /Queries, last day unknown could not be read: the request log cannot be read .* Query errors, last day unknown could not read them: the request log cannot be read/);
});

test("in the browser: the hash chooses the section shown and the page asked; a link followed asks the new page at once; a range or an old hash too", async () => {
  const run = fakeRun();
  run.answers.set("GET api/usage?since=24h&step=3600", answer(USAGE));
  const { el, go, settle, tick } = fakeBrowser(run, "#nope");
  await settle();
  const shown = () => ["status", "tables", "queries", "users", "usage", "syncs"].filter((id) => (el(`page-${id}`) as unknown as { hidden: boolean }).hidden === false);
  assert.deepEqual(shown(), ["status"], "an unknown hash shows the Overview");
  const current = () => [...el("nav").html.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
  assert.deepEqual(current(), ["#overview"]);
  assert.equal(el("range-usage").html, "");
  run.asked.length = 0;
  go("#users"); await settle();
  assert.deepEqual(shown(), ["users"]);
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state", "GET api/share/choices"], "the users at once, not at the next tick (and the state the sidebar names the project from)");
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
  assert.match(el("range-usage").html, /<a href="#observability\/usage" aria-current="true"[^>]*>Last 15 mins<\/a>/);
  assert.match(el("range-usage").html, /^<span class="range-status"><span class="live"[^>]*>.*Live<\/span><\/span><div class="range"/);
  assert.deepEqual((run.asked as string[]).filter((a) => a.includes("api/usage")), ["GET api/usage?since=15m&step=60"], "Now: the last 15 minutes, a minute a point");
  // the range followed: the same view, its samples of the week, six hours a point
  run.answers.set("GET api/usage?since=7d&step=21600", run.answers.get("GET api/usage?since=24h&step=3600")!);
  run.asked.length = 0;
  go("#observability/usage?range=7d"); await settle();
  assert.deepEqual((run.asked as string[]).filter((a) => a.includes("api/usage")), ["GET api/usage?since=7d&step=21600"]);
  assert.match(el("range-usage").html, /<a href="#observability\/usage\?range=7d" aria-current="true" title="Updates every minute">7 days<\/a>/);
  assert.deepEqual(current(), ["#observability/usage?range=7d"], "the nav's links keep the range");
  assert.match(el("range-usage").html, /^<span class="range-status"><span class="live" title="Updates every minute">/, "the week is live too, read once a minute");
  run.asked.length = 0;
  tick(); await settle();
  assert.ok(!(run.asked as string[]).some((x) => x.includes("api/usage") || x.includes("api/activity")), "the week is live, but read again only once a minute");
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

test("the Overview's words are mason status's: the readiness word and what Ready means, the copies' line, a size, a span, an event's line", () => {
  const readinessWord = (commands as unknown as { readinessWord?: (r: unknown) => string }).readinessWord;
  assert.equal(typeof readinessWord, "function", "src/cli/commands.ts exports readinessWord");
  const word = of<[unknown], string>(statusPage, "status.js", "readinessWord");
  for (const s of [RUNNING, COPYING, FAILED]) assert.equal(word(s.readiness), readinessWord!(s.readiness), "the word mason status heads its last line with");
  assert.deepEqual([RUNNING, COPYING, FAILED].map((s) => word(s.readiness)), ["Ready", "Under way", "Failed"]);
  // what Ready means for the synced data: the sentence mason status and mason wait end on after the word, one string
  assert.equal(statusPage.READY_TEXT as unknown, commands.READY_TEXT, "src/cli/readiness.ts READY_TEXT");
  const readinessLine = of<[unknown], { text: string; link: string | null }>(statusPage, "status.js", "readinessLine");
  assert.equal(`Ready: ${readinessLine(RUNNING).text[0]!.toLowerCase()}${readinessLine(RUNNING).text.slice(1)}.`, `Ready: ${commands.READY_TEXT}.`);
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
  const eventCells = fn<[unknown], Record<string, string>>("eventCells");
  for (const e of EVENTS.events as SyncEvent[]) assert.equal(Object.values(eventCells(e)).join(" "), plain(commands.eventLine(e, PLAIN)));
  for (const gone of ["requestCells", "renderRecentErrors", "renderQueries", "RECENT_ERRORS"]) assert.equal(statusPage[gone], undefined, `${gone} is gone: the cards count the errors and the statements`);
});

test("the Overview: the word and its line, the cards (tables synced N of M, rows, the last sync and its age, the copy's file, the statements, p95, the sync and query errors), the facts", () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(SYNCED));
  const a = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(NOW));
  return a.poll().then(() => {
    const html = a.view().status!;
    const text = textOf(html);
    assert.match(html, HEALTH("bad", "Failed"), "the word first: mason status's");
    // the cards first: the copies in all, their rows, the last sync, the copy's file, the last day's statements and p95, its sync and query errors
    assert.match(text, /^mason status Failed 1 table's sync failed: see Tables Database postgres:\S+ · Postgres 16\.4 · your main database Changes each table as its sync: says .*? Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 30 s ago 2026-10-27 09:05:00 UTC Synced data unknown its size could not be read Queries, last day 1,234 1,200 completed, 34 refused, failed or cancelled p95, last day 380 ms average 42 ms · p50 12 ms Sync errors, last day 2 failed sync events Query errors, last day 33 30 refused, 3 failed /);
    assert.match(html, /<div class="cards n8">/, "eight cards on a bare run");
    assert.match(html, /<a class="card bad link" href="#tables\?show=failed"><p class="card-label">Tables synced<\/p><p class="card-value">2 of 3<\/p><p class="card-sub">added, 1 failed<\/p><\/a>/, "a card: its label, its value, its sub-line — and a link to the failed tables");
    // each error card leads to the view that lists what it counts, over the day it counts
    assert.match(html, /<a class="card bad link" href="#observability\/syncs\?failures=1&amp;range=24h"><p class="card-label">Sync errors, last day<\/p><p class="card-value">2<\/p>/);
    assert.match(html, /<a class="card warn link" href="#observability\/queries\?status=refused-or-failed&amp;range=24h"><p class="card-label">Query errors, last day<\/p><p class="card-value">33<\/p>/);
    // the database and how its changes arrive in the box, under its line; the rest in the Server table, under mason status's labels
    assert.match(html, /<dl class="health-facts"><div><dt>Database<\/dt><dd>postgres:.*?<\/dd><\/div><div><dt>Changes<\/dt><dd>each table as its sync: says .*?<\/dd><\/div><\/dl><\/div>/);
    assert.match(text, / Server Sources file mason\/sources\/shop\.yml \(the tables it names are added\) Version 0\.9\.0 Up 6 min, since 2026-10-27 09:00:00 UTC Free disk .* Connections open none open Your database is on another machine\. Mason will sync the tables you choose to this machine\.$/, "the sources file from the project's root, as mason status names it; then where the database is, as information");
    assert.doesNotMatch(html, /\/app\//, "never an absolute path");
    assert.match(html, /<caption>Server<\/caption><tbody><tr><th scope="row">Sources file<\/th>/, "ONE table of the other facts, each a row headed by its name");
    const server = html.slice(html.indexOf("<caption>Server</caption>"));
    assert.doesNotMatch(server, /<th scope="row">(Tables synced|Rows|Last sync|Synced data|Database|Changes|Mason|Source|Disk|Sessions)<\/th>/, "a fact in ONE place: the cards' and the box's are not rows too");
    // no table of the statements and no list of the errors: the cards count them (the owner's, 2026-11-12)
    assert.ok(!/<table class="(queries|errors)"|Last week|None\./.test(html), "no statements table, no error lists");
    assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
    assert.match(text, /Tables not synced yet \(1 of 3 added\) Table Sync public\.orders 100% its first sync failed: poll: connection reset/);
    assert.ok(!/customers 100%|Slow queries|Refused queries|Ready:|Under way:|Failed:/.test(text));
    assert.ok(!/duckdb/i.test(html), "never the engine's name");
  });
});

test("the Overview's eight cards and nine (the host's beside them) leave no card alone on a row: four by two and three by three from a tablet up, two a row on a phone", () => {
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /@media \(min-width: 641px\) \{ \.cards\.n8 \{ grid-template-columns: repeat\(4, 1fr\); \} \.cards\.n9 \{ grid-template-columns: repeat\(3, 1fr\); \} \}/,
    "from 641 px up (the 640–1099, 1100–1439 and 1440 widths alike): 8 = 4 + 4, 9 = 3 + 3 + 3");
  assert.match(css, /\n {2}\.cards \{ grid-template-columns: 1fr 1fr; gap: var\(--space-2\); \}/, "a phone (its 640 px block): two a row, 8 = 2 × 4");
  assert.match(css, /\.cards > :last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1; \}/, "a phone: nine's last card spans its row");
  // the box's title on its top edge, as Getting started's
  assert.match(css, /\.connect \.connect-title, \.checklist \.checklist-title, \.health \.health-title, #page-users \.user-added \.added-title \{ width: fit-content;/, "the Users page's New user added on its box's edge as mason status is");
  assert.match(css, /\.health-title, #page-users \.user-added \.added-title,/, "in the same type as mason status");
});

test("the Overview: Ready, Under way and Failed under the title mason status, each with what it means in a line; nothing added says so once; a count that could not be read says so", async () => {
  const renderHealth = of<[unknown], string>(statusPage, "status.js", "renderHealth");
  // under the line, mason status's Database and Changes rows, the CLI's words (sourceRows)
  const boxRows = (s: RunState) => (commands as unknown as { sourceRows: (s: RunState) => Array<[string, string]> }).sourceRows(s)
    .filter(([k]) => k === "Database" || k === "Changes").map(([k, v]) => `${k} ${v}`).join(" ");
  assert.equal(textOf(renderHealth(RUNNING)), `mason status Ready Every added table is synced and served ${boxRows(RUNNING)}`);
  assert.equal(textOf(renderHealth(COPYING)), `mason status Under way 1 of 3 tables synced, the rest syncing ${boxRows(COPYING)}`);
  assert.equal(textOf(renderHealth(FAILED)), `mason status Failed 1 table's sync failed: see Tables ${boxRows(FAILED)}`);
  assert.equal(textOf(renderHealth(SYNCED)), `mason status Failed 1 table's sync failed: see Tables ${boxRows(SYNCED)}`);
  assert.match(boxRows(RUNNING), /^Database \S+ · Postgres 16\.4 · your main database Changes each table as its sync: says/);
  assert.match(renderHealth(FAILED), /see <a href="#tables\?show=failed">Tables<\/a><\/p><dl class="health-facts"><div><dt>Database<\/dt><dd>/, "Tables: the failed ones");
  assert.match(renderHealth(FAILED), /<\/dd><\/div><\/dl><\/div>$/, "the rows close the box");
  assert.match(renderHealth(RUNNING), /^<div class="health ok" role="status"><p class="health-title">mason status<\/p>/, "the title on the box's edge, as Getting started's");
  // from the state alone (readiness, totals, the tables' sync.state): two failed, every one synced but one catching up
  const readinessLine = of<[unknown], { text: string; link: string | null }>(statusPage, "status.js", "readinessLine");
  assert.deepEqual(readinessLine({ ...FAILED, readiness: { ready: false, failed: ["a: x", "b: y"], waiting: [] } }), { text: "2 tables' syncs failed: see ", link: "Tables" });
  const catching = { ...RUNNING, readiness: { ready: false, failed: [], waiting: ["public.orders: …"] },
    tables: RUNNING.tables.map((t) => t.table === "public.orders" ? { ...t, sync: { ...t.sync, state: "catching-up" } } : t) };
  assert.deepEqual(readinessLine(catching), { text: "Every added table is synced, 1 being caught up by one poll", link: null });
  assert.equal(renderHealth(NONE), "", "no table added: renderStatus says it, with what adds one");
  // the two error cards: a count not read is unknown with its reason, never 0; a count at the read's cap says at least
  const kpis = of<[unknown, unknown], string>(statusPage, "status.js", "renderKpis");
  const failure = { failure: { code: "failed", message: "the history cannot be read\nmore" } };
  assert.match(textOf(kpis(RUNNING, { now: NOW, queries: failure, syncErrors: failure })),
    /Sync errors, last day unknown could not read them: the history cannot be read Query errors, last day unknown could not read them: the history cannot be read$/);
  assert.match(textOf(kpis(RUNNING, { now: NOW, queries: QUERIES, syncErrors: { events: [], keptDays: 7 } })), /Sync errors, last day 0 failed sync events Query errors, last day 33 30 refused, 3 failed$/);
  assert.match(kpis(RUNNING, { now: NOW, queries: QUERIES, syncErrors: { events: [], keptDays: 7 } }), /<a class="card link" href="#observability\/syncs\?failures=1&amp;range=24h"><p class="card-label">Sync errors, last day<\/p><p class="card-value">0<\/p>/, "none: not marked");
  const many = { events: Array.from({ length: statusPage.SYNC_ERRORS_LIMIT as unknown as number }, () => EVENT), keptDays: 7 };
  assert.match(textOf(kpis(RUNNING, { now: NOW, queries: QUERIES, syncErrors: many })), /Sync errors, last day 1,000\+ at least 1,000 failed sync events/);
  // a restart is listed with the failures but is not one (its failed is the event's own)
  assert.match(textOf(kpis(RUNNING, { now: NOW, queries: QUERIES, syncErrors: { events: [EVENT, { ...EVENT, kind: "restart", failed: false }], keptDays: 7 } })), /Sync errors, last day 1 failed sync event /);
  assert.ok(!kpis(RUNNING, { now: NOW }).includes("errors, last day"), "not read yet: not shown");
  assert.ok(!kpis(NONE, { now: NOW, queries: QUERIES, syncErrors: EVENTS }).includes("errors, last day"), "nothing added: no error to count");
  const renderKpis = of<[unknown, unknown], string>(statusPage, "status.js", "renderKpis");
  assert.equal(textOf(renderKpis({ ...NONE, totals: { added: 0, copied: 0, failed: 0, rows: 0, syncedAt: null }, engine: { ...NONE.engine, bytes: 2_097_152 } }, { now: NOW })),
    "Synced data 2.0 MiB", "nothing added: no sync to count, the copy's file alone");
  assert.equal(textOf(renderKpis({ ...SYNCED, engine: { ...SYNCED.engine, bytes: 2_097_152 } }, { now: NOW })), "Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 30 s ago 2026-10-27 09:05:00 UTC Synced data 2.0 MiB");
  assert.equal(textOf(renderKpis({ ...SYNCED, totals: { ...SYNCED.totals!, syncedAt: null } }, { now: NOW, queries: { failure: { code: "failed", message: "no ledger\nmore" } } })),
    "Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync none yet Synced data unknown its size could not be read Queries, last day unknown could not be read: no ledger Query errors, last day unknown could not read them: no ledger",
    "a fact not read is unknown, with its reason — never 0");
  // the app with nothing added: the commands' sentence first — no word, no card — then the facts
  const run = fakeRun();
  run.answers.set("GET api/state", answer(NONE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  const first = textOf(app.view().status!);
  assert.match(first, /^Getting started 2 of 3 done .* Add a table /, "the checklist: its one action is adding a table");
  assert.ok(!/mason status|Server|No table added yet/.test(first), `while getting started, the checklist alone: ${first}`);
});

// ------------------------------------------------------------------ the Tables page: each copy's sync, Sync, the search box

test("Tables: each added table's state, rows, last sync and its age, how long it took, its copy's size and error, and Sync", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const html = renderTables(SYNCED, { sizes: USAGE });
  const text = textOf(html);
  assert.match(text, /^Added \(3\) Table State Rows Key Last sync Size /);
  assert.match(text, /public\.customers Synced 100% 1,200 key id 30 s ago took 0\.4 s 512\.0 KiB View events Sync now Remove /);
  assert.match(text, /public\.orders Failed 100% ~2,000,000 rows key id 65 min ago took 63 s View events Sync now Remove Sync… All columns poll: connection reset the whole error poll: connection reset the sync tries it again in 5 s /);
  // a copy served but not kept current: its amber bar, and the words mason status prints after it, under the row
  assert.match(text, /public\.events Synced 100% 30,000,000 key id 2 min ago took 13 min 3\.0 GiB View events Sync now Remove Sync: Off All columns Not added \(1\) Table State Rows Key Last sync Size public\.audit /, "a table whose sync is off is synced, its age its Last sync");
  assert.match(text, /public\.audit Not added ~50 rows key id Add Columns… /, "a table not added has no sync, and is in the Not added list");
  assert.equal([...html.matchAll(/<table /g)].length, 2);
  // the last sync is an age, its UTC time in a title; rows, age, span and size are mono and right-aligned
  assert.match(html, /<td class="num last"><span title="2026-10-27 09:05:00 UTC">30 s ago<\/span><span class="took" title="changes checked">took 0\.4 s<\/span><\/td><td class="num size">512\.0 KiB<\/td>/);
  assert.match(html, /<td class="num rows">1,200<\/td>/);
  // a failed copy's error is a red line, its whole error in a details
  assert.match(html, /<span class="err">poll: connection reset<\/span><details data-open="error:public\.orders"><summary>the whole error<\/summary><pre>poll: connection reset\nthe sync tries it again in 5 s<\/pre><\/details>/);
  assert.match(html, /<td class="state"><span class="indicator bad"><span class="dot" aria-hidden="true"><\/span>Failed<\/span><span class="copyline t-failed"><span class="copybar" /, "a failed copy's bar is red (its line's class)");
  assert.match(html, /<button type="button" class="small" data-sync-table="public\.customers" data-room="Syncing…">Sync now<\/button>/);
  assert.match(html, /<th scope="row" class="name"><code class="name" title="public\.customers">public\.<wbr>customers<\/code><\/th>/, "a name in mono, whole, wrapping after its . and _ (issue 884), its whole the title too");
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
  assert.match(textOf(renderTables(SYNCED, { sizes: { failure: { code: "failed", message: "the samples cannot be read" } } })), /The synced tables' sizes could not be read: the samples cannot be read\./);
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
    // the headline and the rows are mason sync's; its tips name the page's Sync now, where the CLI names mason sync (issue 877)
    const ours = syncedReport(answered, picked, named) as { headline: string; details: unknown; tips: string[] };
    const theirs = cli.syncedReport!(answered, picked, named) as { headline: string; details: unknown; tips: string[] };
    assert.deepEqual([ours.headline, ours.details], [theirs.headline, theirs.details]);
    assert.equal(ours.tips.length, theirs.tips.length);
    for (const tip of ours.tips) assert.doesNotMatch(tip, /mason /, tip);
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
  assert.match(textOf(app.view().tables!), /public\.events Synced .* Synced ✓ Remove Sync: Off All columns Not added \(1\) Table State Rows Key Last sync Size public\.audit /);
  assert.match(app.view().tables!, /<button type="button" class="small" data-sync-table="public\.events" data-room="Syncing…">Synced ✓<\/button>/);
  assert.equal(textOf(popOf(app.view().tables!, "act-tables-public.events")), "Synced public.events: 1,234 row(s) written, 5 deleted. public.events 1,234 changed, 5 deleted, 30,001,229 rows now · 8.5 s public.events's sync is off, so it stays as it is now until you press Sync now again. Dismiss");
  app.dismissSynced();
  assert.ok(!/Synced public\.events:/.test(app.view().tables!));
  const message = "public.orders has no copy yet: it is synced once it is copied";
  run.answers.set("POST api/sync", answer({ error: message, code: "nothing_yet", failure: { code: "nothing_yet", message, next: [] } }, 409));
  assert.equal(await app.syncTable("public.orders"), false);
  assert.ok(app.view().tables!.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
});

test("Tables: while the page's Sync now of a table runs, its State says Syncing (amber), as Adding… does for an add; the others keep their own word", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const states = (html: string) => [...html.matchAll(/<td class="state"><span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
  // the run says synced for a table whose poll by hand runs: only the page's own request knows
  assert.deepEqual(states(renderTables(CATALOG_STATE)).slice(0, 3), ["ok Synced", "ok Synced", "ok Synced"]);
  assert.deepEqual(states(renderTables(CATALOG_STATE, { syncing: ["public.orders"] })).slice(0, 3), ["ok Synced", "warn Syncing", "ok Synced"]);
  // a table not added is never said to sync, whatever the list holds
  assert.ok(!states(renderTables(CATALOG_STATE, { syncing: ["public.audit"] })).includes("warn Syncing"));
});

test("Tables: the search box narrows both lists and Failed only lists the failed tables alone, kept across polls; a form open keeps its table and its list still", async () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "ORD" })), /^1 with “ORD” in the name Added \(1\) Table State Rows Key Last sync Size public\.orders Synced 100% 2,000,000 key id View events Sync now Remove .* Not added \(0\) No table that is not added has “ORD” in its name\./);
  assert.equal(renderTables(CATALOG_STATE, { filter: "" }), renderTables(CATALOG_STATE), "nothing typed: every table, as before");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "zzz", choosing: "public.audit", columns: columnsOf("public.audit") })), /^1 with “zzz” in the name .* public\.audit Not added ~50 rows key id Add Columns… The columns to sync/, "the table whose form is open stays");
  assert.match(textOf(renderTables(SYNCED, { filter: "nope" })), /Added \(0\) No added table's name has “nope”\. Not added \(0\) No table that is not added has “nope” in its name\./);
  // the search is over both lists; Failed only lists the failed tables alone, and no list of the tables not added
  const names = (html: string) => [...html.matchAll(/<th scope="row" class="name"><code class="name" title="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { filter: "acc" })), ["public.accounts"]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { filter: "ev" })), ["public.events", "public.event_log"], "a match in each list");
  assert.equal(names(renderTables(CATALOG_STATE)).length, 7);
  assert.deepEqual(names(renderTables(SYNCED, { failed: true })), ["public.orders"]);
  assert.doesNotMatch(textOf(renderTables(SYNCED, { failed: true })), /Not added \(/, "Failed only: no Not added list");
  assert.deepEqual(names(renderTables(SYNCED, { failed: true, filter: "cust" })), [], "the name and Failed only both narrow it");
  assert.match(textOf(renderTables(SYNCED, { failed: true, filter: "cust" })), /Added \(0\) No failed table's name has “cust”\./);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { failed: true, choosing: "public.audit" })).includes("public.audit"), true, "a form open stays, whatever the filter says");
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
  await on.get("input")!({ target: { id: "tables-failed", checked: true } });
  assert.deepEqual(names(el("tables").html), ["public.orders"], "SYNCED has one table failed");
  await on.get("input")!({ target: { id: "tables-failed", checked: false } });
  assert.equal(names(el("tables").html).length, 4, "Failed only cleared: every table");
  // Sync clicked: its button says Syncing… at once (written before the answer comes), the answer under it once it does
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  run.answers.set("POST api/sync", () => new Response(JSON.stringify({ at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] })));
  const fetchNow = run.fetch;
  run.fetch = async (p, init) => { if (p === "api/sync") await answered; return fetchNow(p, init); };
  const click = on.get("click")!({ target: { closest: () => ({ dataset: { syncTable: "public.customers" } }) } });
  await settle();
  assert.match(el("tables").html, /<button type="button" class="small" data-room="Syncing…" disabled>Syncing…<\/button>/, "said while it runs");
  assert.match(textOf(el("tables").html), /public\.customers Syncing 100% /, "and its State says Syncing meanwhile");
  release();
  await click;
  assert.match(textOf(el("tables").html), /Synced public\.customers: 1 row\(s\) written, 0 deleted\./);
  // frozen: a form open holds the filter it opened over
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  await on.get("input")!({ target: { id: "tables-failed", checked: true } });
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
  assert.match(text, /^Session No\. User Client Running for Rows Query /);
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
  assert.equal(textOf(popOf(asking, "act-running-12:45")), "Cancel query 45 of session 12? Its client gets a \"canceling statement\" error. Cancel query 45 Keep it running");
  assert.match(asking, /data-confirm-cancel="12:45"/);
  // the question a popover beside its Cancel, which stays where it was, held down: no row inserted, the columns as they were
  assert.equal(textOf(withoutPops(asking)), text, "the table says what it said");
  assert.match(asking, /<td class="act" id="act-running-12:45"><button type="button" class="danger small" aria-expanded="true" disabled>Cancel<\/button><\/td>/);
  assert.ok(!/data-confirm-cancel="13:7"/.test(asking), "only the one asked");
  assert.equal(textOf(renderRunning([], null)), "No query is running now.");
});

test("running now: the answer to a cancel is said beside its row's Cancel, a refusal as the CLI's Failure, beside the part once the statement ended, and stays until dismissed", () => {
  const renderRunning = fn<[unknown[], string | null, unknown, number?], string>("renderRunning");
  const done = renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] });
  assert.equal(textOf(popOf(done, "act-running-12:45")), "Cancelled session 12's query. It stops now, and its client gets a \"canceling statement\" error. Dismiss", "beside the row it was for, with its Dismiss");
  assert.match(popOf(done, "act-running-12:45"), /<button type="button" class="small" data-dismiss-cancelled data-pop-close>Dismiss<\/button>/);
  assert.equal(textOf(withoutPops(done)), textOf(renderRunning(RUNNING_NOW, null, null)), "no row inserted");
  // a cancel's answer stays up until it is dismissed, however long, as a refusal does (issue 811)
  const at = Date.parse("2026-10-28T09:00:00.000Z");
  assert.ok(popOf(renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] }, at + 3_600_000), "act-running-12:45"), "an hour on: still said");
  const refused = { key: "12:45", failure: { code: "refused", message: "session 12 runs another statement now (statement 46), not statement 45: nothing cancelled", why: "statement 45 ended, and the session began another",
    fix: "mason cancel 12 --statement 46 stops the one it runs now", next: [{ command: "mason logs --running", what: "the statements running now, with their sessions" }] } };
  assert.equal(textOf(popOf(renderRunning(RUNNING_NOW.slice(0, 1), null, { ...refused, at: 0 }, Date.now()), "act-running-12:45")), "✗ session 12 runs another statement now (statement 46), not statement 45: nothing cancelled why statement 45 ended, and the session began another fix mason cancel 12 --statement 46 stops the one it runs now Next: mason logs --running the statements running now, with their sessions Dismiss");
  assert.equal(textOf(popOf(renderRunning([], null, { key: "12:45", cancelled: RUNNING_NOW[0] }), "usage-running")), "Cancelled session 12's query. It stops now, and its client gets a \"canceling statement\" error. Dismiss", "the statement ended: beside the part (Usage's)");
});

test("the request log: a row each, newest first, in the commands' words — held equal to mason logs --requests' line — Older and Newest", () => {
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const html = renderRequests({ requests: REQUESTS, keptDays: 7, before: "2026-10-28T09:00:00.000Z~5" }, { now: Date.parse("2026-10-28T09:05:00.000Z") });
  const text = textOf(html);
  assert.match(text, /^Status Query id Started ↓ Duration ↕ User Client Rows ↕ Query /, "no Ended or Bytes column: they are in the row's details; Started, Duration and Rows sort, the start newest first");
  assert.match(text, /Cancelled r-new 4 min ago 90,000 ms metabase \(no application_name\) SELECT pg_sleep\(100\) \+ canceling statement due to user request Completed r-old 5 min ago 1,234 ms ana psql 1 SELECT count\(\*\) FROM orders \+ A statement that reads no synced table \(select 1, SET, SHOW, a BI tool's catalog queries\) is answered but not listed\. Older$/);
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
    assert.ok(line.includes(outcome) && textOf(renderRequests({ requests: [{ ...failedRequest, outcome }], keptDays: 7, before: null })).toLowerCase().startsWith(`status query id started ↓ duration ↕ user client rows ↕ query ${outcome} `),
      `the page's word for ${outcome} is the CLI's`);
  }
  // started: how long ago, the UTC time its title
  assert.match(html, /<time data-tick datetime="2026-10-28T09:01:00.000Z" title="2026-10-28 09:01:00 UTC">/);
  assert.match(renderRequests({ requests: [REQUESTS[0]], keptDays: 7, before: null }, { now: Date.parse("2026-10-28T09:05:00.000Z") }), /<time [^>]*>5 min ago<\/time>/);
  // opened: the expanded row holds the whole id, when it started and ended, the bytes, the whole statement and error
  const opened = textOf(renderRequests({ requests: REQUESTS, keptDays: 7, before: null }, { isOpen: (k: string) => k === "request:r-old" }));
  assert.match(opened, /Completed r-old .* SELECT count\(\*\) FROM orders − Query id r-old Started \(UTC\) 2026-10-28 09:00:00\.000 Ended \(UTC\) 2026-10-28 09:00:01\.234 Bytes sent 2\.0 KiB SELECT count\(\*\) FROM orders A statement that reads no synced table .* listed\.$/);
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
  assert.ok(planOpen.includes(`<p class="plan-label">Its plan, recorded when it ended (it took 2,345 ms)</p><pre class="plan">Mason: answered from the synced table public.orders (about 3 rows)\n  Sent to the engine: SELECT a &lt; b FROM orders\nTop N  (rows=3)\n  -&gt;  Table Scan on public.orders  (rows=3)</pre>`), planOpen);
  assert.ok(!renderRequests({ requests: [slowRequest], keptDays: 7, before: null }).includes("Top N"), "a closed row writes no plan");
  assert.match(renderRequests({ requests: [{ ...slowRequest, planTruncated: true }], keptDays: 7, before: null }, { isOpen: () => true }),
    /<\/pre><p class="dim cut">Mason kept only the first 8 KiB of the plan\.<\/p>/);
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
  assert.match(textOf(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true })), /Refused .* relation "nope" does not exist A statement that reads no synced table .* listed\. Newest$/);
  assert.match(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true }), /<div class="paging"><button type="button" data-newest>Newest<\/button><\/div>/);
  assert.match(renderRequests({ requests: [], keptDays: 7, before: null }), /^<p class="empty">No queries in the last 7 days\.<\/p><p class="dim unlisted">A statement that reads no synced table /,
    "nothing listed and nothing filtered: what the log does not list (a select 1 typed to test the connection), as mason logs --requests says it");
  assert.equal(textOf(renderRequests({ requests: [], keptDays: 1, before: null }, { filtered: true, span: "the last 15 minutes" })), `No query matches the filters in the last 15 minutes. ${commands.UNLISTED_STATEMENTS}.`);
  // what the log does not list, ONCE, a small quiet line under the list, empty or not (index.html says it no more)
  for (const html of [renderRequests({ requests: REQUESTS, keptDays: 7, before: "C~1" }), renderRequests({ requests: [], keptDays: 7, before: null }, { firstTool: true }), renderRequests({ requests: [], keptDays: 7, before: null }, { filtered: true })])
    assert.equal(html.split('<p class="dim unlisted">').length, 2, "once, under the list"), assert.equal(textOf(html).split(`${commands.UNLISTED_STATEMENTS}.`).length, 2);
  assert.ok(!fs.readFileSync(path.join(WEB, "index.html"), "utf8").includes(commands.UNLISTED_STATEMENTS), "never twice: not in the lead too");
});

test("the request log's filters: each view has its own path — status as the server's outcomes, user, client; the range the only window", async () => {
  const run = fakeRun();
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  const asked = async (f: Record<string, string>) => { run.asked.length = 0; await app.filterRequests(f); return [...run.asked]; };
  run.answers.set("GET api/requests?outcome=ok&since=15m", answer({ requests: [], keptDays: 7, before: null }));
  run.answers.set("GET api/requests?outcome=ok&since=24h", answer({ requests: [], keptDays: 7, before: null }));
  run.answers.set("GET api/requests?outcome=refused%2Cfailed&since=15m&user=ana&client=psql", answer({ requests: [failedRequest], keptDays: 7, before: null }));
  assert.deepEqual(await asked({ status: "completed" }), ["GET api/requests?outcome=ok&since=15m"], "since is the range's, Now's 15 minutes unless the hash says");
  assert.match(textOf(app.view()["request-log"]!), /^No query matches the filters in the last 15 minutes\./);
  // no Since box: a since given anyway (an older caller) is no window of its own, the range is
  assert.deepEqual(await asked({ status: "refused-or-failed", since: "2h", user: "ana", client: "psql" }), ["GET api/requests?outcome=refused%2Cfailed&since=15m&user=ana&client=psql"]);
  assert.doesNotMatch(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /rq-since|name="since"|Since, when given/, "no Since box, no help for it");
  assert.match(textOf(app.view()["request-log"]!), / relation "nope"/);
  // Refused and Failed are offered apart, each the ledger's outcome of that name
  assert.deepEqual(await asked({ status: "refused" }), ["GET api/requests?outcome=refused&since=15m"]);
  assert.deepEqual(await asked({ status: "failed" }), ["GET api/requests?outcome=failed&since=15m"]);
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<select id="rq-status" name="status"><option value="">All<\/option><option value="completed">Completed<\/option><option value="refused">Refused<\/option><option value="failed">Failed<\/option><option value="refused-or-failed">Refused or failed<\/option>/);
  assert.deepEqual(await asked({}), ["GET api/requests?since=15m"], "cleared: every request of the range again");
  // a range in the hash: its since, the filters kept
  app.show("observability/queries?range=24h");
  assert.deepEqual(await asked({ status: "completed" }), ["GET api/requests?outcome=ok&since=24h"]);
  assert.match(textOf(app.view()["request-log"]!), /^No query matches the filters in the last 24 hours\./);
  // an old bookmark carrying a since: the page opens, the range its window
  run.answers.set("GET api/requests?since=15m", answer({ requests: [], keptDays: 7, before: null }));
  await app.filterRequests({});
  app.show("observability/queries?since=2h");
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET api/requests?since=15m"), run.asked.join("\n"));
  assert.match(textOf(app.view()["request-log"]!), /^No queries in the last 15 minutes\./);
  // the filters on one row where they fit: User and Client narrower, Statement has taking the rest; a phone's rules as before
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /@media \(min-width: 641px\) \{\s*form#request-filters \.field input:not\(\[type="search"\]\) \{ width: 9em; \}\s*form#request-filters #rq-user-field select \{ width: 9em; min-width: 0; text-overflow: ellipsis; \}\s*form#request-filters \.field\.grow \{ flex: 1 1 10em; \}/,
    "the User dropdown as narrow as the text box it replaced");
});

test("the app: Usage's Cancel asks first; the confirm posts { session, statement } and reads the statements again; a 409 renders as its Failure", async () => {
  const run = fakeRun();
  run.answers.set("GET api/running", answer({ running: RUNNING_NOW }));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("usage");
  await app.poll();
  assert.match(textOf(app.view()["usage-running"]!), /^Session No\. .* 12 45 .* 13 7 /);
  app.askCancelStatement(12, 45);
  assert.match(textOf(app.view()["usage-running"]!), /Cancel query 45 of session 12\? Its client gets a "canceling statement" error/);
  run.asked.length = 0;
  await app.poll();
  assert.match(textOf(app.view()["usage-running"]!), /Cancel query 45 of session 12\?/, "a poll keeps the question");
  app.dismissCancelStatement();
  assert.ok(!/Its client gets a/.test(textOf(app.view()["usage-running"]!)));
  assert.ok(!run.asked.some((a) => a.startsWith("POST")), "asking posts nothing");
  app.askCancelStatement(12, 45);
  run.answers.set("POST api/cancel", answer({ cancelled: RUNNING_NOW[0], next: [] }));
  run.answers.set("GET api/running", answer({ running: RUNNING_NOW.slice(1) }));
  run.asked.length = 0;
  assert.equal(await app.confirmCancelStatement(12, 45), true);
  assert.deepEqual(run.asked, [`POST api/cancel ${JSON.stringify({ session: 12, statement: 45 })}`, "GET api/running", "GET api/state"], "the statements running and who is connected, read again");
  assert.match(textOf(app.view()["usage-running"]!), /^Session No\. .* 13 7 .*Cancelled session 12's query\. It stops now/, "the statement ended: said beside the part");
  assert.match(popOf(app.view()["usage-running"]!, "usage-running"), /Cancelled session 12's query/);
  // the answer stays up across polls until it is dismissed: Escape (the page's dismiss) takes it (issue 811)
  await app.poll();
  assert.match(popOf(app.view()["usage-running"]!, "usage-running"), /Cancelled session 12's query/, "a poll on: still said");
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
  assert.deepEqual(await asked(), ["GET api/requests?since=15m", "GET api/state", "GET api/users"],
    "the request log alone (who is connected, what runs and the range's numbers are Usage's); the state, how to connect, and the users, the User filter's choices, beside it");
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
  assert.deepEqual(await asked(), ["GET api/state", "GET api/users"], "an older page is never read again while paging (the state and the users at their own rate)");
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
  assert.match(textOf(app.view()["request-log"]!), /While you search, this list refreshes every 30 s, because a search reads the text of every query in the range\.$/);
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
  const failure = { code: "usage", message: "search is at most 200 characters", fix: "a shorter piece of the statement" };
  run.answers.set(`GET api/requests?since=15m&search=${"x".repeat(201)}`, answer({ error: failure.message, failure }, 400));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  await app.filterRequests({ search: "x".repeat(201) });
  assert.equal(textOf(app.view()["request-log"]!), "✗ search is at most 200 characters fix a shorter piece of the statement");
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
  assert.match(textOf(el("usage-running").html), /Cancel query 7 of session 13\?/);
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
  assert.deepEqual(await asked(), [U, "GET api/state", "GET api/share/choices"], "on opening: its own, the state for the sidebar (once a minute), and the roles a share may read as");
  t += 2000;
  assert.deepEqual(await asked(), [], "not at the 2 s poll");
  t += 28_000;
  assert.deepEqual(await asked(), [U, "GET api/state", "GET api/share/choices"], "then every 30 s, the state with them (the Connect panel's) and the share's roles");
  assert.match(textOf(app.view().users!), /^Active 1 Removed 1 .*metabase id 0123456789abcdef every table from anywhere Active 2026-10-27 09:10 UTC never Queries Disable Remove$/);
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
  assert.equal(fnOf<[unknown], string>(usagePage, "coveredText")(UL_QUERIES.queries.week), "Mason keeps only 3 days of history (MASON_HISTORY_DAYS sets it)");
  assert.equal(fnOf<[unknown], string>(usagePage, "coveredText")(UL_QUERIES.queries.day), "", "a window the log covers has no caveat");
  // the cards of a range longer than the log keeps say it under them, never a short window passed off as whole
  const kpis = fnOf<[Record<string, unknown>], string>(usagePage, "renderUsageKpis");
  assert.match(textOf(kpis({ activity: activityOf({ window: { days: 30, covered: 7 } }), range: "30d" })), /Sent, last 30 days 3\.0 MiB 52,000 rows 30 days: Mason keeps only 7 days of history \(MASON_HISTORY_DAYS sets it\)$/);
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
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [] })), /No sample in this time\. Mason takes the first one a minute after it starts\./);
  const sizes = textOf(fnOf<[unknown], string>(usagePage, "renderCopySizes")(UL_USAGE.copySizes));
  assert.match(sizes, /^Measured every 10 min\. Table Size Measured at \(UTC\) public\.orders 3\.0 GiB 09:00 public\.customers 39\.1 KiB 09:00$/);
  assert.equal(usagePage.SIZE_EVERY_SECONDS as unknown, (await import("../src/duck/usage.ts")).SIZE_EVERY_MS / 1000, "as often as src/duck/usage.ts measures");
  assert.match(textOf(fnOf<[unknown], string>(usagePage, "renderCopySizes")([])), /No table measured yet/);
});

test("Usage: over the last 15 minutes what runs every poll, the range's statements and who is connected every 5 s, the samples and unsupported SQL every 60 s; a longer range less often; only while shown; a refusal is the CLI's Failure", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("usage");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  const NOW_READS = ["GET api/activity?since=15m", "GET api/usage?since=15m&step=60", "GET api/unsupported?since=15m", "GET api/running", "GET api/state"];
  assert.deepEqual(await asked(), NOW_READS, "Now: the range's statements, its samples, its unsupported SQL, what runs and who is connected");
  const v = app.view();
  assert.match(textOf(v["usage-kpis"]!), /^Connected now .* Queries, last 15 min 1,204 /);
  assert.match(textOf(v["usage-hourly"]!), /2026-10-28 09:05 1,204 3/);
  assert.match(textOf(v["usage-sizes"]!), /public\.orders 3\.0 GiB/);
  assert.equal(v["usage-connected-h"], "Connected now");
  assert.equal(v["usage-running-h"], "Running now");
  assert.equal(v["usage-running-lead"]!, "The queries running right now. Cancel stops one.");
  t += 2000; assert.deepEqual(await asked(), ["GET api/running"], "2 s on: what runs, alone");
  t += 3000; assert.deepEqual(await asked(), ["GET api/activity?since=15m", "GET api/running", "GET api/state"], "5 s on: the range's statements and who is connected too");
  t += 55_000; assert.deepEqual(await asked(), NOW_READS, "60 s on: the samples and the unsupported SQL too");
  app.show("status"); assert.deepEqual((await asked()).some((a) => a.includes("api/activity") || a.includes("api/running")), false, "not while another page is shown");
  // a past range: each read once, when chosen; what runs now is Now's alone
  app.show("observability/usage?range=24h");
  assert.deepEqual(await asked(), ["GET api/activity?since=24h", "GET api/usage?since=24h&step=3600", "GET api/unsupported?since=24h", "GET api/state"],
    "the range's statements, samples and unsupported SQL (the state the sidebar's)");
  const p = app.view();
  assert.equal(p["usage-connected-h"], "Connected in the last 24 hours");
  assert.equal(p["usage-running-h"], "Slowest in the last 24 hours");
  assert.match(textOf(p["usage-connected"]!), /^User Client Queries Failed Sessions Last metabase Metabase v0\.50 1,100 9 3 /, "who sent statements in it");
  assert.equal(textOf(p["usage-running"]!), "No query completed in the last 24 hours.", "the slowest of it");
  assert.match(textOf(p["usage-kpis"]!), /^Clients, last 24 hours 2 4 sessions Queries, last 24 hours 1,204 /);
  t += 6000; assert.deepEqual(await asked(), [], "24 hours: not read again within 30 s");
  for (let i = 0; i < 3; i++) {
    t += 60_000;
    assert.deepEqual(await asked(), ["GET api/activity?since=24h", "GET api/usage?since=24h&step=3600", "GET api/unsupported?since=24h", "GET api/state"], "a minute on: the range is live, read again");
  }
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
  assert.match(textOf(app.view()["usage-kpis"]!), /Queries, last 24 hours 1,204/, "the last counts stay under the banner");
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
  assert.equal(textOf(timeline), "When ↓ Kind Table Message 5 min ago ✗ Mason restarted Mason the run stopped <b>after</b> 42 s 9 min ago ✗ Full sync failed public.events the source closed the connection the sync tries it again in 5 min 10 min ago Full sync public.orders copied 2,000,000 rows");
  assert.equal(textOf(renderEvents(UL_EVENTS, { now: at, sort: { key: "time", dir: "asc" } })), "When ↑ Kind Table Message 10 min ago Full sync public.orders copied 2,000,000 rows 9 min ago ✗ Full sync failed public.events the source closed the connection the sync tries it again in 5 min 5 min ago ✗ Mason restarted Mason the run stopped <b>after</b> 42 s",
    "oldest first, as the command lists them, when asked");
  assert.match(timeline, /<th scope="col" aria-sort="descending"><button type="button" class="sort on" data-sort-table="events" data-sort-key="time">When/);
  assert.match(timeline, /<time data-tick datetime="2026-10-28T09:00:00.000Z" title="2026-10-28 09:00:00 UTC">10 min ago<\/time>/, "how long ago, the UTC time as the command prints it its title");
  assert.match(timeline, /<span title="copied"><span class="badge ok">Full sync<\/span><\/span>/); assert.equal([...timeline.matchAll(/<span class="badge bad">✗ /g)].length, 2, "a failure is a red badge with its ✗");
  assert.equal([...html.matchAll(/class="t-failed"/g)].length, 2, "the failures are marked");
  // Failures only: what was read, narrowed in the page alone
  assert.equal(textOf(renderEvents(UL_EVENTS, { failuresOnly: true, now: at })), "2 of the 3 events read. When ↓ Kind Table Message 5 min ago ✗ Mason restarted Mason the run stopped <b>after</b> 42 s 9 min ago ✗ Full sync failed public.events the source closed the connection the sync tries it again in 5 min");
  // a kind and a table narrow it too, and compose
  assert.match(textOf(renderEvents(UL_EVENTS, { kind: "copied", now: at })), /^1 of the 3 events read\. When ↓ Kind Table Message 10 min ago Full sync public\.orders/);
  assert.match(textOf(renderEvents(UL_EVENTS, { table: "Mason", now: at })), /^1 of the 3 events read\. .* Mason restarted Mason the run stopped/);
  assert.equal(textOf(renderEvents(UL_EVENTS, { kind: "copied", failuresOnly: true })), "None of the 3 sync events read passes the filters.");
  assert.equal(textOf(renderEvents({ keptDays: 7, events: [UL_EVENTS.events[0]] }, { failuresOnly: true })), "None of the 1 sync event shown failed.");
  assert.doesNotMatch(html, /<b>/, "a message is escaped");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 })), "No sync event in the last 7 days.");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { span: "the last hour" })), "No sync event in the last hour. Mason keeps 7 days of history.");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 1 })), "No sync event in the last 1 day.");
});

test("Sync events: the run's entries are rows, NEWEST FIRST, a multi-line entry kept as one preformatted row", () => {
  const renderLogs = fnOf<[unknown], string>(syncsPage, "renderLogs");
  const html = renderLogs(LOG);
  assert.equal([...html.matchAll(/<div class="log-line">/g)].length, 2, "two entries, two lines");
  assert.ok(html.indexOf("mason started") > html.indexOf("copy: public.orders"), "the newest at the top");
  assert.match(html, /<pre>copy: public\.orders\n {2}chunk 3 of 20 &lt;read&gt;<\/pre>/);
  assert.match(html, /^<div class="terminal" role="log">/, "a terminal's lines");
  assert.match(textOf(html), /^copy: public\.orders chunk 3 of 20 <read> 2026-10-28 09:00:00 mason started The last 2 of the up to 2000 entries Mason keeps here, newest first/);
  assert.match(textOf(renderLogs({ lines: [], kept: 2000 })), /The run has logged nothing yet\./);
});

test("Sync events: the events every 10 s, a week or more once a minute; the run's raw log sits behind a closed details and is read, every 5 s, only while it is open; a refusal is its Failure under it", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App & { showRawLog(open: boolean): Promise<void> }>("createApp")(run.fetch, () => new Date(t));
  app.show("syncs");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET api/events?limit=500&since=15m", "GET api/state"], "closed: the log is not read (the state is the sidebar's)");
  assert.match(textOf(app.view()["syncs-events"]!), /✗ Full sync failed/);
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
  // the last hour: its events at the same rate, live too
  app.show("observability/syncs?range=1h");
  assert.deepEqual(await asked(), ["GET api/events?limit=500&since=1h", "GET api/state"]);
  t += 10_000; assert.deepEqual(await asked(), ["GET api/events?limit=500&since=1h"], "its events again 10 s on");
  // 7 days: a minute apart (each read scans the week)
  app.show("observability/syncs?range=7d");
  assert.deepEqual(await asked(), ["GET api/events?limit=500&since=7d", "GET api/state"]);
  t += 30_000; assert.deepEqual(await asked(), ["GET api/state"], "the week's events not again within the minute (the state at its own 30 s)");
  t += 30_000; assert.deepEqual(await asked(), ["GET api/events?limit=500&since=7d", "GET api/state"], "a minute on, again");
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
  assert.match(html, /<label class="check" for="tables-failed"><input type="checkbox" id="tables-failed"> Failed only<\/label>/);
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
  // being compacted: its changes kept aside until the compaction ends (issue 904)
  ["a table being compacted", { ...STREAM, tables: [STREAM.tables[0]!, { table: "public.orders", state: "compacting", why: "it is being compacted, and the changes made since are applied when the compaction ends",
    compacting: { held: 151 }, applied: { inserts: 3, updates: 0, deletes: 0, truncates: 0 } }, { table: "public.events", state: "compacting", why: "x", compacting: { held: 1 }, applied: zero }] }],
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
    assert.deepEqual(rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`), cli!(st, NOW).map(asPage), what);
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

test("the Overview: Mason's version and uptime, the restarts, the disk and the sessions are the CLI's rows (masonRows, restartsRows, diskRows, sessionsRows) — held equal, but for the pid and the path", () => {
  const cli = commands as unknown as { masonRows: (e: unknown, pid: number) => Array<[string, string]>; restartsRows: (r: unknown) => Array<[string, string]>;
    diskRows: (d: unknown) => Array<[string, string]>; sessionsRows: (s: unknown) => Array<[string, string]> };
  for (const f of ["masonRows", "restartsRows", "diskRows", "sessionsRows"] as const) assert.equal(typeof cli[f], "function", `src/cli/commands.ts exports ${f}`);
  const engine = { version: "0.4.2", startedAt: "2026-10-27T08:00:00.000Z", uptimeSeconds: 3930 };
  // the state carries no pid: the page's rows are the CLI's with " · pid N" gone, and no Up where the pid was all it said
  const pageRows = fn<[unknown], Array<[string, string]>>("masonRows");
  const noPid = (rows: Array<[string, string]>, pid: number) => rows.map(([k, v]): [string, string] => [k, v.replace(new RegExp(`(^| · )pid ${pid}$`), "")]).filter(([, v]) => v !== "");
  assert.deepEqual(pageRows(engine), noPid(cli.masonRows(engine, 4242), 4242));
  assert.deepEqual(pageRows(engine), [["Version", "0.4.2"], ["Up", "66 min, since 2026-10-27 08:00:00 UTC"]]);
  assert.deepEqual(pageRows({ version: "0.4.2" }), noPid(cli.masonRows({ version: "0.4.2" }, 1), 1));
  assert.deepEqual(pageRows({ version: "dev" }), [["Version", "dev"]]);
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
    disk: { path: D, freeBytes: 2 ** 30, copyBytes: 5 * 2 ** 20, projectedBytes: 4 * 2 ** 30 }, sessions: { open: 5, byClient } };
  const html = renderFacts(state, NOW), text = textOf(html);
  assert.match(text, /^Server Sources file .* Version 0\.4\.2 Up 66 min, since 2026-10-27 08:00:00 UTC Restarts 2, /, "Version, then Up, then the restarts; no one process");
  assert.match(text, /Restarts 2, the last 3 h ago: the run crashed, after 42 s up/);
  assert.match(text, /Free disk 1\.0 GiB free where the synced data is · the first syncs running are projected to add about 4\.0 GiB more — more than is free/);
  assert.match(text, /Connections open 5 open, 1 running a statement · 2 as metabase \(Metabase\), 1 by a token, 1 as ana \(psql\), and 1 other client/);
  assert.match(html, /<tr class="warn"><th scope="row">Free disk<\/th>/);
  assert.ok(!text.includes(D) && !/duckdb/i.test(text));
  assert.doesNotMatch(text, /one process/);
  const { disk: _d, sessions: _s, ...older } = RUNNING as unknown as Record<string, unknown> & { engine: Record<string, unknown> };
  const bare = { ...older, engine: { name: older.engine.name, file: older.engine.file, bytes: older.engine.bytes, pollSeconds: older.engine.pollSeconds } };
  assert.doesNotMatch(textOf(renderFacts(bare, NOW)), /Version|Up \d|Restarts|Free disk|Connections open/, "a run that says none of it: nothing");
  assert.match(textOf(renderFacts(RUNNING, NOW)), /Version \S+ Up \S+/, "the run's own state says them (runState)");
  assert.match(textOf(renderFacts({ ...RUNNING, sessions: { error: "no listener\nmore" } } as never, NOW)), /Connections open could not be read: no listener/);
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
  assert.match(renderSessions(sessions), /<td class="act"><a class="btn small" href="#observability\/queries\?user=metabase&amp;client=Metabase\+v0\.50" title="the queries of metabase from Metabase v0\.50 in the last 15 minutes">Queries<\/a><\/td>/);
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
  assert.match(text, /^Added \(\d+\) Table State Rows Key Last sync Size public\.customers /);
  const { tables } = fn<[unknown, number], { tables: Array<[string, string]> }>("streamRows")(STREAM, NOW);
  for (const [t, words] of tables.filter(([t]) => ["public.customers", "public.orders", "public.events"].includes(t))) assert.ok(text.includes(words), `${t}: ${words}`);
  assert.match(text, /public\.customers Synced .* streamed · 1,204 changes \(1,000 inserts, 200 updates, 4 deletes\) this run /);
  assert.match(text, /getting the changes made since 2026-10-27 09:00 UTC: reading the changes, for 30 s · the stream holds 12 changes of it meanwhile/);
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
  // each label in a field with its control (on a phone a field is a row of its own); Failed only a box in its own label
  assert.match(tables, /<div class="field grow"><label for="tables-filter">Search the tables<\/label>\s*<input type="search" id="tables-filter"[^>]*><\/div>/);
  assert.match(tables, /<label class="check" for="tables-failed"><input type="checkbox" id="tables-failed"> Failed only<\/label>/);
  assert.doesNotMatch(tables, /tables-show/, "no Show select");
  assert.match(users, /<div class="page-head"><h2 id="users-h">Users<\/h2><p class="desc">Create and manage Users that you can connect to tools and services<\/p><\/div>/, "the Users page's intro, in the owner's words");
  // the form is the page's own once the state is read (renderAddUser: none on a read-only page), in its place
  assert.match(fn<[unknown], string>("renderAddUser")(CATALOG_STATE), /^<form id="add-user" class="formcard"[^>]*>[\s\S]*<button type="submit" class="primary">Add a user<\/button><p class="dim roles-line">[\s\S]*<\/p><\/form>$/);
  // the users first, right under the title (their read-only line is renderUsers' own); then the form, the password just
  // shown beside it, Connect: a card that appears moves nothing above it
  const order = ["users-h", "users", "add-box", "add-kinds", "add-user-box", "add-share-box", "action", "added", "users-connect"].map((id) => users.indexOf(`id="${id}"`));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)), "the title, the users, the box (its segments, the form, the temporary cloud login), its failure, the card, Connect");
  assert.match(users, /<\/div>\s*<div id="users"><\/div>\s*<!--[^>]*-->\s*<div id="add-box" class="add-box"><div id="add-kinds"><\/div><div class="add-panes"><div id="add-user-box"><\/div><div id="add-share-box"><\/div><\/div><\/div>/, "the users list right under the page's head, then the box");
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

test("Tables: nothing added is the empty state under Added, over the Not added list that still offers Add; a stream's column is in the same table", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const html = renderTables(NONE);
  assert.match(html, /^<h3 class="list-h">Added <span class="dim">\(0\)<\/span><\/h3><p class="empty">No table added yet\. Add one from the list below\.<\/p><h3 class="list-h">Not added <span class="dim">\(\d+\)<\/span><\/h3><div class="panel">/, "one quiet line under Added, over the list");
  assert.match(renderTables({ ...NONE, pageReadOnly: "read-only here" }), /<p class="empty">No table added yet\. The tables to sync are set in the sources file\.<\/p>/);
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

test("Users: the add form's password is the one-time dialog, marked shown once; Active lists the users not removed, #users?show=removed the removed, and the age ticks with the page's clock", async () => {
  const added = onceHtml(fn<[unknown], Record<string, string>>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password: "mason_0123456789abcdef_" + "a".repeat(32),
    database: "shop", url: "postgres://metabase@127.0.0.1:5433/shop" }));
  assert.match(added, /^<p class="once-title" id="once-title">New user added<\/p>/);
  assert.match(added, /<span class="badge warn">Shown once<\/span>/);
  assert.equal([...added.matchAll(/data-copy="/g)].length, 2, "the URL and the password each have a Copy; the name is plain, the database is Connect's");
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
  assert.ok(app.view().users!.includes("metabase") && !app.view().users!.includes(">old<"), "Active: the removed user is not listed");
  // the tab is the hash's: hashOf and the page's own link agree, parseHash reads it, and the page shows it
  const hashOf = fn<[string, Record<string, string>?], string>("hashOf");
  const usersShowHref = fn<[string], string>("usersShowHref");
  assert.deepEqual([usersShowHref("active"), usersShowHref("removed")], [hashOf("users"), hashOf("users", { show: "removed" })]);
  assert.deepEqual(fn<[string], unknown>("parseHash")("#users?show=removed"), { id: "users", params: { show: "removed" } });
  app.show("#users?show=removed");
  assert.ok(app.view().users!.includes(">old<") && !app.view().users!.includes("data-remove=\"metabase\""), "Removed: the removed user alone");
  app.show("#users");
  assert.ok(!app.view().users!.includes(">old<"), "Back to #users: Active again");
});

test("Users: Remove in the Active tab takes the user's row to Removed at the next write, no other row moving; a question or a refusal goes with a tab left, or a row that left", async () => {
  const run = fakeRun();
  const u = (name: string, id: string, removedAt: string | null = null) => ({ name, id, addedAt: "2026-10-27T09:10:11.000Z", removedAt, live: true, lastUsedAt: null, url: null });
  let users = [u("a_first", "0000000000000001"), u("metabase", "0000000000000002"), u("z_last", "0000000000000003")];
  run.answers.set("GET api/users?lastUsed=1", () => new Response(JSON.stringify({ users, lastUsedNote: null, urlNote: null, requestLogDays: 7 }), { status: 200 }));
  run.answers.set("DELETE api/users/metabase", () => { users = users.map((x) => x.name === "metabase" ? { ...x, removedAt: "2026-10-28T09:00:00.000Z" } : x); return new Response(JSON.stringify({ removed: { name: "metabase" }, next: [] }), { status: 200 }); });
  const app = fn<[unknown], App & { markStale(): void; pages: Map<string, { click(d: unknown, b: unknown, w: unknown): unknown; model: Record<string, unknown> }> }>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  const rows = (html: string) => [...html.matchAll(/<code class="name" title="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(rows(app.view().users!), ["a_first", "metabase", "z_last"]);
  const page = app.pages.get("users")!;
  await page.click({ remove: "metabase" }, {}, {});
  await page.click({ confirmRemove: "metabase" }, {}, {});
  assert.deepEqual(rows(app.view().users!), ["a_first", "z_last"], "its own row went; the others in their order");
  assert.match(textOf(app.view().users!), /^Active 2 Removed 1 /);
  assert.equal(popOf(app.view().users!, "act-users-metabase"), "", "no popover left without its row");
  // a refusal beside a user, then the tab left: it goes (its row is not shown), and is not there on coming back
  page.model.refused = { name: "a_first", failure: { code: "refused", message: "nope", next: [] } };
  assert.notEqual(popOf(app.view().users!, "act-users-a_first"), "");
  app.show("#users?show=removed");
  assert.equal(page.model.refused, null);
  app.show("#users");
  assert.equal(popOf(app.view().users!, "act-users-a_first"), "");
  // a refusal beside a user removed beside the page (mason user remove): it goes with its row at the next read
  page.model.refused = { name: "z_last", failure: { code: "refused", message: "nope", next: [] } };
  users = users.map((x) => x.name === "z_last" ? { ...x, removedAt: "2026-10-28T09:01:00.000Z" } : x);
  app.markStale(); await app.poll();
  assert.equal(page.model.refused, null);
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
  assert.match(html, /<section id="page-status" aria-labelledby="status-h">\s*<div class="page-head"><h2 id="status-h">Overview<\/h2><p class="desc">Mason syncs the tables you add from your Postgres and keeps them up to date\. Tools query them at Mason's own Postgres URL\.<\/p>/, "the Overview says what Mason is first, then that it is mason status's");
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
  assert.match(drawn, /<div class="chart spark" data-chart="rows" role="img" aria-label="Rows synced, the last 24 hours, one point an hour"><\/div>/);
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

test("a popover that can be closed has an X at its top right, named Close, which presses its own Dismiss or Cancel; one that cannot has none", async () => {
  const pop = fn<[string, string, Record<string, unknown>?], string>("pop");
  const X = page.POP_X as unknown as string;
  assert.match(X, /^<button type="button" class="pop-x" data-pop-x aria-label="Close" title="Close"><span class="icon" aria-hidden="true"><svg/, "a button named Close, its icon silent");
  assert.equal(textOf(X).trim(), "", "the X adds no words to what the popover says");
  // first in the popover (floated to its top right), only where a close is
  assert.ok(pop("a", `<p>Done.</p><button type="button" data-dismiss-x data-pop-close>Dismiss</button>`).startsWith(`<div class="pop said" data-anchor="a" role="status">${X}<p>Done.</p>`));
  assert.ok(!pop("a", "<p>Reading…</p>").includes("data-pop-x"), "nothing to close: no X");
  // on the pages: an answer, a refusal and a question each have one
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const synced = { at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] };
  for (const [what, ui] of [["a sync's answer", { synced: { table: "public.customers", synced } }], ["a refusal", { synced: { table: "public.customers", failure: { code: "refused", message: "no" } } }],
    ["Remove's question", { removing: "public.customers" }]] as const) {
    assert.ok(popOf(renderTables(CATALOG_STATE, ui), "act-tables-public.customers").includes(X), `${what}: its X`);
  }
  // the shell: a click on the X clicks its popover's own close, and nothing else
  const run = fakeRun();
  const { on } = fakeBrowser(run, "#tables");
  let closed = 0;
  const close = { click: () => { closed++; } };
  const popEl = { querySelector: (sel: string) => sel === "[data-pop-close]" ? close : null };
  const x = { dataset: { popX: "" }, closest: (sel: string) => sel === ".pop" ? popEl : null };
  await on.get("click")!({ target: { closest: (sel: string) => sel === "button" ? x : null } });
  assert.equal(closed, 1, "its Dismiss or Cancel pressed");
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

test("an answer's popover covers no other control (issue 884): under its anchor, over it, or on its left; where every place covers one, a bar at the window's bottom, never a way through", () => {
  const placePops = fn<[unknown, unknown], unknown[]>("placePops");
  const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const control = (left: number, top: number, w = 80, h = 28) => ({ getBoundingClientRect: () => box(left, top, w, h), closest: () => null });
  const classes = (...c: string[]) => { const s = new Set(c); return { contains: (x: string) => s.has(x), toggle: (x: string, on: boolean) => { if (on) s.add(x); else s.delete(x); }, s }; };
  // an answer 300 × 120 at the document's origin until placed, its Dismiss 16 px in and 80 px down
  const said = () => ({ dataset: { anchor: "act" }, offsetWidth: 300, offsetHeight: 120, hidden: false, style: {} as Record<string, string>, classList: classes("pop", "said"),
    getBoundingClientRect: () => box(0, 0, 300, 120), querySelectorAll: () => [control(16, 80, 70, 28)] });
  const anchor = { getBoundingClientRect: () => box(900, 100, 280, 36) };
  const docOf = (pops: unknown[], controls: unknown[]) => ({ querySelectorAll: (sel: string) => sel === ".pop[data-anchor]" ? pops : controls, getElementById: (id: string) => id === "act" ? anchor : null });
  // its own row's actions, and the next row's under them: under it covers the next row's, over it (pushed inside the
  // window) its own row's; on its left, level with its top, covers none
  const rowControls = [control(950, 104), control(1040, 104), control(950, 160), control(1040, 160)];
  const pop = said();
  placePops(docOf([pop], rowControls), { innerWidth: 1280, innerHeight: 900 });
  assert.deepEqual(pop.style, { left: "596px", top: "100px" }, "on its left, level with its anchor's top");
  assert.equal(pop.classList.contains("through"), false);
  // nothing near: where it always was, under its anchor
  const alone = said();
  placePops(docOf([alone], [control(10, 600)]), { innerWidth: 1280, innerHeight: 900 });
  assert.deepEqual(alone.style, { left: "880px", top: "140px" });
  // controls in every place (a phone's rows): a bar at the window's bottom (`docked`), its height given to the page's
  // end; never a way through to what is under it (a tap on its words once added the table under it)
  const grid = Array.from({ length: 25 }, (_, row) => Array.from({ length: 13 }, (_, c) => control(c * 100, row * 36 + 2, 90, 4))).flat();
  const crowded = said();
  const root = { style: { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } } };
  placePops({ ...docOf([crowded], grid), documentElement: root }, { innerWidth: 1280, innerHeight: 900 });
  assert.equal(crowded.classList.contains("docked"), true, "docked at the window's bottom");
  assert.equal(crowded.classList.contains("through"), false, "never a way through");
  assert.deepEqual(crowded.style, { left: "", top: "" }, "placed by the stylesheet, not over a row");
  assert.deepEqual(root.style.props, { "--docked-h": "120px" }, "its height given to the page's end");
  // a place clear again: no longer docked, and the page's end its own again
  placePops({ ...docOf([crowded], rowControls), documentElement: root }, { innerWidth: 1280, innerHeight: 900 });
  assert.equal(crowded.classList.contains("docked"), false);
  assert.deepEqual(crowded.style, { left: "596px", top: "100px" });
  assert.deepEqual(root.style.props, { "--docked-h": "0px" });
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
  assert.equal(textOf(live), "Connected now 3 sessions 2 clients Running now 2 the longest for 2 min Queries, last 15 min 1,204 1,190 completed " +
    "Failed, last 15 min 12 10 refused, 2 failed, 2 cancelled p95, last 15 min 900 ms average 120 ms · p50 40 ms Sent, last 15 min 3.0 MiB 52,000 rows");
  assert.deepEqual(labels(live), ["Connected now", "Running now", "Queries, last 15 min", "Failed, last 15 min", "p95, last 15 min", "Sent, last 15 min"]);
  assert.match(live, /^<div class="cards n6">/);
  assert.deepEqual(hrefs(live), ["#observability/queries", "#observability/queries?status=refused-or-failed", "#observability/queries?slow=1"], "each statement card leads to the statements it counts");
  assert.match(kpis({ activity: activityOf(), sessions, running: [], range: "now" }), /Running now<\/p><p class="card-value">0<\/p><p class="card-sub">no query is running<\/p>/);
  assert.match(live, /<a class="card warn link" href="[^"]*"><p class="card-label">Failed, last 15 min/, "a failure colours the one to act on");
  // the Clients card says the totals over EVERY client, never the 50 the endpoint lists (a card once said 50 of 200)
  assert.match(kpis({ activity: activityOf({ clientsTotal: { clients: 200, sessions: 410 } }), range: "24h" }), /Clients, last 24 hours<\/p><p class="card-value">200<\/p><p class="card-sub">410 sessions<\/p>/);
  const renderClients = fnOf<[unknown[], Record<string, unknown>], string>(usagePage, "renderClients");
  assert.match(textOf(renderClients(CLIENTS, { range: "24h", total: 200 })), new RegExp(`200 clients \\(the ${CLIENTS.length} with the most queries are listed\\) sent queries in the last 24 hours`));
  // A PAST RANGE: five cards — its clients, then its statements; its links keep the range
  const past = kpis({ activity: activityOf(), sessions, running: RUNNING_NOW, range: "24h" });
  assert.deepEqual(labels(past), ["Clients, last 24 hours", "Queries, last 24 hours", "Failed, last 24 hours", "p95, last 24 hours", "Sent, last 24 hours"], "what is connected now is Now's alone");
  assert.match(textOf(past), /^Clients, last 24 hours 2 4 sessions Queries, last 24 hours 1,204 /);
  assert.match(past, /^<div class="cards n5">/);
  assert.deepEqual(hrefs(past), ["#observability/queries?range=24h", "#observability/queries?status=refused-or-failed&range=24h", "#observability/queries?slow=1&range=24h"]);
  assert.match(textOf(kpis({ activity: activityOf(), range: "1h" })), /^Clients, last hour 2 /);
  // not read yet: the cards it has, then a skeleton; unreadable: unknown with its reason
  assert.match(kpis({ activity: undefined, sessions, running: RUNNING_NOW, range: "now" }), /Running now.*<span class="skeleton/s);
  assert.equal(textOf(kpis({ activity: { failure: { code: "failed", message: "no ledger\nmore" } }, sessions: { error: "the listener is closed\nmore" }, range: "now" })),
    "Connected now unknown the listener is closed Queries, last 15 min unknown could not be read: no ledger");
  assert.match(textOf(kpis({ activity: activityOf({ window: { durationMs: null } }), range: "24h" })), /p95, last 24 hours – no query completed/);
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
  assert.match(textOf(app.view()["usage-kpis"]!), /^Connected now 1 session 1 client Running now 2 .* Queries, last 15 min 1,204 /);
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
  assert.equal(textOf(clients), "User Client Queries Failed Sessions Last metabase Metabase v0.50 1,100 9 3 30s ago Queries token ci (no application_name) 104 1 60 min ago Queries " +
    "2 clients sent queries in the last 24 hours. A session that sent only queries Mason does not list (select 1, SET, a catalog query) is not here.");
  assert.match(clients, /<td class="act"><a class="btn small" href="#observability\/queries\?user=metabase&amp;client=Metabase\+v0\.50&amp;range=24h" title="the queries of metabase from Metabase v0\.50 in the last 24 hours">Queries<\/a><\/td>/);
  assert.match(clients, /<time data-tick datetime="2026-10-27T09:05:00.000Z" title="2026-10-27 09:05:00 UTC">30s ago<\/time>/, "when the latest started: how long ago, the UTC time its title");
  assert.equal(textOf(renderClients([], { range: "1h" })), "No client sent a query in the last hour.");
  // past `top`, the others in one row with their sums
  const many = Array.from({ length: 12 }, (_, i) => ({ ...CLIENTS[0]!, user: `u${i}`, statements: 100 - i, failed: 1, sessions: 2 }));
  assert.match(textOf(renderClients(many, { range: "24h", now })), / 2 other clients 179 2 4 12 clients sent queries/);
  // the slowest: when, how long, who from where, the statement, and Queries (the slow ones of its client when it was slow)
  const slow = [{ ...REQUESTS[0]!, durationMs: 4200 }, { ...REQUESTS[0]!, requestId: "r-fast", startedAt: "2026-10-28T09:01:00.000Z", durationMs: 300, rows: null, query: "" }];
  const slowest = renderSlowest(slow, { range: "7d", now: Date.parse("2026-10-28T09:06:00.000Z") });
  assert.equal(textOf(slowest), "Started Took User Client Rows Query 6 min ago 4,200 ms ana psql 1 SELECT count(*) FROM orders Queries 5 min ago 300 ms ana psql (no statement) Queries");
  assert.match(slowest, /href="#observability\/queries\?user=ana&amp;client=psql&amp;slow=1&amp;range=7d"/, "a slow one: its client's slow statements");
  assert.match(slowest, /href="#observability\/queries\?user=ana&amp;client=psql&amp;range=7d"/, "one under a second: its client's statements");
  assert.match(slowest, /<code class="stmt" title="SELECT count\(\*\) FROM orders">SELECT count\(\*\) FROM orders<\/code>/, "the statement's cell is the request log's (statementCell)");
  assert.equal(textOf(renderSlowest([], { range: "24h" })), "No query completed in the last 24 hours.");
});

test("Usage: the cards are the range's, with a sparkline each where two samples can be drawn; their numbers are text either way", () => {
  const kpis = fnOf<[Record<string, unknown>], string>(usagePage, "renderUsageKpis"), specs = fnOf<[unknown], Record<string, { kind: string; x: number[]; y: Array<number | null> }>>(usagePage, "usageSpecs");
  const plain = kpis({ activity: activityOf(), range: "24h" }), drawn = kpis({ activity: activityOf(), usage: UL_USAGE, range: "24h" });
  assert.equal(textOf(plain), "Clients, last 24 hours 2 4 sessions Queries, last 24 hours 1,204 1,190 completed Failed, last 24 hours 12 10 refused, 2 failed, 2 cancelled p95, last 24 hours 900 ms average 120 ms · p50 40 ms Sent, last 24 hours 3.0 MiB 52,000 rows");
  assert.equal(textOf(drawn), textOf(plain), "the same words with the charts as without");
  assert.deepEqual([...drawn.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1]), ["usage-spark-statements", "usage-spark-failed", "usage-spark-bytes"], "no sparkline for one hour of p95");
  assert.match(drawn, /data-chart="usage-spark-statements" [^>]*aria-label="Queries, the last 24 hours an hour a point"/, "the sparkline names its span and step");
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
  assert.match(textOf(app.view()["usage-kpis"]!), /^Connected now .* Queries, last 15 min 1,204 /);
  assert.match(app.view()["usage-charts"]!, /data-chart="usage-copy-rows"/);
  assert.equal(app.pages.get("usage")!.toggle({ dataset: { open: "usage-hours" }, open: true }), true);
  await app.poll();
  assert.match(app.view()["usage-hourly"]!, /data-open="usage-hours" open>/);
  const keys = [...Object.keys(app.pages.get("usage")!.charts()), ...Object.keys(app.pages.get("status")!.charts?.() ?? {})];
  assert.equal(new Set(keys).size, keys.length, "a chart key is one holder's in the whole document");
});

test("Sync events: the page and mason logs --events say what the list leaves out unless asked, in one sentence; a manual sync's kind is good news, in words", () => {
  // the scheduled syncs that succeed are listed only when asked for: the page says so, as mason logs --help does (one sentence)
  const leaveOut = (commands as Record<string, unknown>).EVENTS_LEAVE_OUT as string | undefined;
  assert.equal(typeof leaveOut, "string", "src/cli/commands.ts exports EVENTS_LEAVE_OUT");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const desc = /<h2 id="syncs-h">Sync events<\/h2>.*?<p class="desc">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
  // the page says the same fact in its own words (issue 877): the CLI's sentence names its flag, the page its box
  assert.match(leaveOut!, /^The scheduled syncs that succeed .* are listed only with --scheduled\.$/);
  assert.ok(desc.includes("The scheduled syncs that succeed are listed only when you tick Scheduled syncs."), `the page's description says it: ${desc}`);
  assert.match(html, /<label class="check" for="syncs-scheduled"><input type="checkbox" id="syncs-scheduled"> Scheduled syncs<\/label>/);
  assert.match(desc, /each sync you started/);
  const help = commands.LOGS.usage.replace(/\s+/g, " ");
  assert.ok(help.includes(leaveOut!.replace(/\s+/g, " ")), "mason logs --help says the same sentence");
  assert.match(help, /each sync asked by hand \(mason sync, the page's Sync now\) and what it did/);
  assert.match(html, /<a href="#observability\/syncs"><span class="label">Sync events<\/span><\/a>/, "the nav names the page Sync events; its route is unchanged");
  // a synced event is good news, as copied and recovered are
  const renderEvents = of<[unknown], string>(syncsPage, "syncs.js", "renderEvents");
  const row = renderEvents({ events: [{ at: "2026-10-27T09:04:00.000Z", kind: "synced", failed: false, table: "public.orders", message: "synced by hand: 3 changed, 0 deleted, 1,200 rows now · 41 ms" }], keptDays: 7 });
  assert.match(row, /<span title="synced"><span class="badge ok">Manual sync<\/span><\/span>/, "in words, its code the title");
  assert.match(textOf(row), /Manual sync public\.orders synced by hand: 3 changed, 0 deleted, 1,200 rows now · 41 ms/);
});

test("Sync events: Scheduled syncs (or a scheduled kind chosen) asks the run for them, read at once and written when answered; cleared, the run is asked without", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  const scheduled = { keptDays: 7, events: [...UL_EVENTS.events,
    { at: "2026-10-28T09:09:00.000Z", kind: "polled", failed: false, table: "public.orders", message: "synced on schedule: 2 changed, 0 deleted, 1,202 rows now · 40 ms" },
    { at: "2026-10-28T09:09:30.000Z", kind: "streamed", failed: false, table: "public.events", message: "streamed 4 changes (4 inserts) in the last 60 s" }] };
  run.answers.set("GET api/events?limit=500&since=15m&scheduled=1", answer(scheduled));
  const t = Date.parse("2026-10-28T09:10:00.000Z");
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { input(t: unknown): unknown }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("syncs");
  await app.poll();
  assert.doesNotMatch(textOf(app.view()["syncs-events"]!), /Scheduled sync|Live sync/, "not asked for: none");
  run.asked.length = 0;
  await app.pages.get("syncs")!.input({ id: "syncs-scheduled", checked: true });
  assert.deepEqual(run.asked, ["GET api/events?limit=500&since=15m&scheduled=1"], "the run is asked for them, at once");
  const text = textOf(app.view()["syncs-events"]!);
  assert.match(text, /^When ↓ Kind Table Message 30s ago Live sync public\.events streamed 4 changes \(4 inserts\) in the last 60 s 60s ago Scheduled sync public\.orders synced on schedule: 2 changed/);
  assert.match(app.view()["syncs-events"]!, /<span title="polled"><span class="badge ok">Scheduled sync<\/span><\/span>/, "good news, in words");
  run.asked.length = 0;
  await app.pages.get("syncs")!.input({ id: "syncs-scheduled", checked: false });
  assert.deepEqual(run.asked, ["GET api/events?limit=500&since=15m"]);
  assert.doesNotMatch(textOf(app.view()["syncs-events"]!), /Scheduled sync public/);
  // a scheduled kind chosen with the box clear: they are read for it, else it would list none
  run.asked.length = 0;
  await app.pages.get("syncs")!.input({ id: "syncs-kind", value: "polled" });
  assert.deepEqual(run.asked, ["GET api/events?limit=500&since=15m&scheduled=1"]);
  assert.match(textOf(app.view()["syncs-events"]!), /^1 of the 5 events read\. When ↓ Kind Table Message 60s ago Scheduled sync public\.orders/);
  // another kind: no read, the page's filter alone
  run.asked.length = 0;
  assert.equal(await app.pages.get("syncs")!.input({ id: "syncs-kind", value: "copied" }), undefined);
  assert.deepEqual(run.asked, ["GET api/events?limit=500&since=15m"], "back to the events without them");
});

test("Sync events: 'Failures only' narrows the events read, in the page alone; the events' kinds are badges and their times how long ago", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.parse("2026-10-28T09:10:00.000Z");
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { input(t: unknown): unknown }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("syncs");
  await app.poll();
  assert.match(textOf(app.view()["syncs-events"]!), /^When ↓ Kind Table Message 5 min ago ✗ Mason restarted .* ✗ Full sync failed .* 10 min ago Full sync public\.orders/);
  // the kind and table filters: EVERY kind, and the sync and EVERY added table, whatever the range read (the state
  // read here names customers, orders and events; public.events has events, public.customers none)
  const words = (syncsPage as Record<string, unknown>).KIND_WORDS as Record<string, string>;
  assert.equal(textOf(app.view()["syncs-filters"]!), `Kind Every kind ${EVENT_KINDS.map((k) => words[k]).join(" ")} Table Every table Mason events public.customers public.events public.orders`);
  assert.equal(app.pages.get("syncs")!.input({ id: "syncs-kind", value: "copy_failed" }), true);
  assert.match(app.view()["syncs-filters"]!, /<option value="copy_failed" selected>/);
  assert.match(textOf(app.view()["syncs-events"]!), /^1 of the 3 events read\. When ↓ Kind Table Message 9 min ago ✗ Full sync failed/);
  app.pages.get("syncs")!.input({ id: "syncs-kind", value: "" });
  run.asked.length = 0;
  assert.equal(app.pages.get("syncs")!.input({ id: "syncs-failures-only", checked: true }), true);
  assert.doesNotMatch(textOf(app.view()["syncs-events"]!), /Full sync public\.orders/);
  assert.match(textOf(app.view()["syncs-events"]!), /✗ Full sync failed/);
  assert.deepEqual(run.asked, [], "the page alone: nothing is asked");
  assert.equal(app.pages.get("syncs")!.input({ id: "somewhere-else", checked: true }), null, "another input is not this page's");
  app.pages.get("syncs")!.input({ id: "syncs-failures-only", checked: false });
  assert.match(textOf(app.view()["syncs-events"]!), /Full sync public\.orders/);
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
  assert.match(textOf(app.view()["usage-kpis"]!), /Queries, last 7 days 1,204 /, "the week's cards are the week's window");
  app.show("#observability/queries?range=7d"); t += 120_000; await app.poll();
  assert.match(textOf(app.view()["request-log"]!), /^No queries in the last 7 days\./);
  app.show("#observability/usage?range=1h"); await app.poll();
  assert.match(textOf(app.view()["usage-kpis"]!), /Queries, last hour 1,204 /, "the hour's cards say the hour, by name");
});

test("Queries: Slow (1 s or more) and Statement has are the request log's slow and search, composing with the rest; the Overview's links land on them", async () => {
  const { SLOW_MS } = await import("../src/cli/request-filter.ts");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.match(html, new RegExp(`<input type="checkbox" id="rq-slow" name="slow"> Slow \\(${SLOW_MS / 1000} s or more\\)</label>`), "the label is SLOW_MS's");
  assert.match(html, /<input id="rq-search" name="search" type="search" maxlength="200"/);
  const requestsPath = fnOf<[Record<string, unknown>, string | null, string?], string>(queriesModule, "requestsPath");
  assert.equal(requestsPath({ status: "refused-or-failed", slow: true, search: "from orders", user: "ana" }, null, "1h"), "api/requests?outcome=refused%2Cfailed&since=1h&user=ana&slow=1&search=from+orders");
  assert.equal(requestsPath({ since: "2026-10-28" }, "C~1", "1h"), "api/requests?since=1h&before=C%7E1", "the range is the only window: a since of its own is not");
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
  assert.match(textOf(app.view()["request-log"]!), /No query matches the filters/);
  // the Overview's cards are links into the views that list what they count
  const html2 = renderStatusOf(FAILED);
  for (const [label, href] of [["Tables synced", "#tables?show=failed"], ["Rows", "#tables"], ["Synced data", "#observability/usage?range=24h"], ["Queries, last day", "#observability/queries?range=24h"], ["p95, last day", "#observability/queries?slow=1&amp;range=24h"],
    ["Sync errors, last day", "#observability/syncs?failures=1&amp;range=24h"], ["Query errors, last day", "#observability/queries?status=refused-or-failed&amp;range=24h"]]) {
    // each at the range of what it counts (the last day), never the views' default, Now
    assert.match(html2, new RegExp(`<a class="card[^"]*" href="${href!.replace(/[?]/g, "\\?")}"><p class="card-label">${label!.replace(/[()]/g, "\\$&")}</p>`), `${label} → ${href}`);
  }
});

test("Queries' User filter is a dropdown of the users: All users, the active, then the removed (marked); a choice sends user= as a typed name did; a hash's unknown user an extra option; the users unread, the text box", async () => {
  const renderUserFilter = fnOf<[unknown, string?], string>(queriesModule, "renderUserFilter");
  const index = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.match(index, /<div class="field" id="rq-user-field"><\/div>/, "the field is the page's part, in the filters' one row");
  assert.ok(!/<input id="rq-user"/.test(index), "no text box of its own in the document");
  // two users and one removed (the removed one's statements are still in the log); a name removed and added again, once, active
  const users = { users: [
    { name: "old_etl", id: "a1", addedAt: "2026-10-20T09:00:00.000Z", removedAt: "2026-10-25T09:00:00.000Z", live: false },
    { name: "metabase", id: "b2", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true },
    { name: "app", id: "c3", addedAt: "2026-10-26T09:00:00.000Z", removedAt: "2026-10-26T10:00:00.000Z", live: false },
    { name: "app", id: "d4", addedAt: "2026-10-27T10:00:00.000Z", removedAt: null, live: true },
  ] };
  const options = (html: string) => [...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], m[2] === " selected"]);
  const all = renderUserFilter(users, "");
  assert.match(all, /^<label for="rq-user">User<\/label><select id="rq-user" name="user">/);
  assert.deepEqual(options(all), [["", "All users", true], ["metabase", "metabase", false], ["app", "app", false], ["old_etl", "old_etl (removed)", false]]);
  assert.deepEqual(options(renderUserFilter(users, "old_etl")).filter(([, , s]) => s), [["old_etl", "old_etl (removed)", true]], "the filter set is the option selected");
  // a user= the list does not have (a share's own login, a user whose record is gone): one more option, selected
  assert.deepEqual(options(renderUserFilter(users, "share_ana")).slice(-1), [["share_ana", "share_ana", true]]);
  assert.equal(options(renderUserFilter(users, "share_ana")).length, 5);
  assert.match(renderUserFilter({ users: [] }, ""), /<select id="rq-user" name="user"><option value="" selected>All users<\/option><\/select>/, "no users yet: All users alone");
  assert.match(renderUserFilter(undefined, "metabase"), /<select id="rq-user" name="user"><option value="">All users<\/option><option value="metabase" selected>metabase<\/option><\/select>/, "before the users answered: a link's user still shown");
  assert.match(renderUserFilter({ users: [{ name: "<x>", removedAt: null }] }, ""), /<option value="&lt;x&gt;">&lt;x&gt;<\/option>/, "a name is escaped");
  // the users could not be read: the text box, as before, showing the filter set
  assert.equal(renderUserFilter({ failure: { code: "failed", message: "x" } }, "metabase"), `<label for="rq-user">User</label><input id="rq-user" name="user" spellcheck="false" value="metabase">`);

  // the app: Queries reads GET api/users (never ?lastUsed=1) and writes the field; a choice is sent as user=
  const run = fakeRun();
  run.answers.set("GET api/users", answer(users));
  run.answers.set("GET api/requests?since=15m&user=old_etl", answer({ requests: [REQUESTS[1]], keptDays: 7, before: null }));
  run.answers.set("GET api/requests?since=15m&user=share_ana", answer({ requests: [], keptDays: 7, before: null }));
  const app = fn<[unknown], ObsApp>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.ok(run.asked.includes("GET api/users") && !run.asked.includes("GET api/users?lastUsed=1"), run.asked.join("\n"));
  assert.deepEqual(options(app.view()["rq-user-field"]!).map(([v]) => v), ["", "metabase", "app", "old_etl"]);
  const queries = app.pages.get("queries") as unknown as { submit(f: unknown): Promise<void> };
  const form = (user: string) => ({ id: "request-filters", elements: { status: { value: "" }, user: { value: user }, client: { value: "" }, slow: { checked: false }, search: { value: "" } } });
  run.asked.length = 0;
  await queries.submit(form("old_etl"));
  assert.deepEqual(run.asked, ["GET api/requests?since=15m&user=old_etl"], "the option's value is the name, sent as typing it was");
  assert.deepEqual(options(app.view()["rq-user-field"]!).filter(([, , s]) => s), [["old_etl", "old_etl (removed)", true]]);
  run.asked.length = 0;
  await queries.submit(form(""));
  assert.deepEqual(run.asked, ["GET api/requests?since=15m"], "All users: no user=");
  // a link to a user the list does not have still filters, and the dropdown says so
  app.show("#observability/queries?user=share_ana");
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET api/requests?since=15m&user=share_ana"), run.asked.join("\n"));
  assert.deepEqual(options(app.view()["rq-user-field"]!).slice(-1), [["share_ana", "share_ana", true]]);
  // the users' read failing: the text box, the filter kept and still sent
  run.answers.set("GET api/users", answer({ error: "no", failure: { code: "failed", message: "the users cannot be read", next: [] } }, 500));
  (app as unknown as { markStale(): void }).markStale();
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET api/users"));
  assert.match(app.view()["rq-user-field"]!, /<input id="rq-user" name="user" spellcheck="false" value="share_ana">/);
  assert.ok(!/<select id="rq-user"/.test(app.view()["rq-user-field"]!));
  // a read-only page reads them too (a GET) and shows the dropdown
  const ro = fakeRun();
  ro.answers.set("GET api/state", answer({ ...CATALOG_STATE, pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" }));
  ro.answers.set("GET api/users", answer(users));
  const roApp = fn<[unknown], ObsApp>("createApp")(ro.fetch);
  roApp.show("queries"); await roApp.poll();
  assert.deepEqual(options(roApp.view()["rq-user-field"]!).map(([v]) => v), ["", "metabase", "app", "old_etl"]);
  // only while Queries is shown: another Observability view does not read them
  app.show("#observability/syncs");
  run.asked.length = 0; await app.poll();
  assert.ok(!run.asked.some((a) => a.startsWith("GET api/users")), run.asked.join("\n"));
});
const renderStatusOf = (s: RunState) => fn<[unknown, Record<string, unknown>], string>("renderStatus")(s, { queries: QUERIES, syncErrors: EVENTS, now: NOW });

test("Tables: #tables?show=failed is Failed only — the failed copies alone — and its box is ticked; an older bookmark's show clears it", async () => {
  const app = fn<[unknown], ObsApp>("createApp")(fakeRun().fetch);
  const box = { checked: false };
  const doc = { getElementById: (id: string) => id === "tables-failed" ? box : null };
  app.show("#tables?show=failed", { doc });
  assert.equal(box.checked, true);
  app.show("#tables?show=added", { doc });
  assert.equal(box.checked, false, "the Show select's other values are every table now");
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const names = (html: string) => [...html.matchAll(/<th scope="row" class="name"><code class="name" title="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(names(renderTables(SYNCED, { failed: true })), ["public.orders"], "its poll failed");
  assert.match(textOf(renderTables(RUNNING, { failed: true })), /No failed table\./);
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
  assert.match(textOf(renderRequests(page3, { sort: { key: "duration", dir: "asc" } })), /Sorted by duration, lowest first, within the 3 rows of this page\. Older and Newest go by start time\. A statement that reads no synced table .* Older$/);
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
  // its words, or an icon button's aria-label (a popover's X, Close): a screen reader names every button
  for (const html of htmls) {
    for (const b of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
      assert.ok(textOf(b[2]!).replace(/[↑↓↕]/g, "").trim().length > 0 || /\baria-label="[^"]+"/.test(b[1]!), `a button with no label: ${b[0]}`);
    }
  }
  assert.ok(htmls[1]!.includes('aria-label="Close"'), "the confirm's X is named Close");
  assert.match(htmls[1]!, /<p class="confirm">Remove orders\?.*<\/p><p class="pop-actions"><button type="button" class="danger small" data-confirm-remove-table="public\.orders">Remove orders<\/button>/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /button\.small \{ height: var\(--control-sm\);/);
  assert.match(css, /--control-sm: 28px;/);
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

test("Usage: the unsupported SQL of the range is mason status's lines (unsupportedLines), each entry named by docs/SQL-SUPPORT.md, read once a minute at every range", async () => {
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
  assert.match(textOf(html), /^The queries refused in the last 7 days because they used SQL that Mason does not support, most first\. a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase last 2026-10-28 08:59 — SELECT sum/);
  assert.match(textOf(html), /SQL this Mason no longer lists: 1 statement last 2026-10-28 07:00 — SELECT 1 How to rewrite it: see docs\/SQL-SUPPORT\.md › SQL this Mason no longer lists$/);
  assert.match(textOf(html), /How to rewrite it: see docs\/SQL-SUPPORT\.md › a window frame in GROUPS mode/);
  assert.ok(html.includes('title="docs/SQL-SUPPORT.md entry frame-groups"') && !textOf(html).includes("frame-groups"), "the registry id is a title, never the words");
  assert.ok(html.includes(`title="${UNSUPPORTED.unsupported[0]!.example}"`), "the whole statement is its title");
  assert.ok(!textOf(html).includes(UNSUPPORTED.unsupported[0]!.example), "the line has it cut, as mason status cuts it");
  assert.equal(textOf(render({ ...UNSUPPORTED, unsupported: [] }, "the last hour")), "No query was refused for unsupported SQL in the last hour. Mason keeps 7 days of history.");
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
  assert.match(textOf(app.view().unsupported!), /^The queries refused in the last 7 days .* a window frame in GROUPS mode: 12 statements/);
  run.asked.length = 0; t += 2000; await app.poll();
  assert.ok(!run.asked.some((a) => a.startsWith("GET api/unsupported")), "the week: not every poll");
  t += 60_000; await app.poll();
  assert.ok(run.asked.includes("GET api/unsupported?since=7d"), "the week is live: a minute on, again");
  app.show("#observability/usage"); await app.poll();
  assert.match(textOf(app.view().unsupported!), /^The queries refused in the last 15 minutes /);
  run.asked.length = 0; t += 2000; await app.poll();
  assert.ok(!run.asked.some((a) => a.startsWith("GET api/unsupported")), "Now: not every poll, once a minute");
  t += 60_000; await app.poll();
  assert.ok(run.asked.includes("GET api/unsupported?since=15m"), "a minute on, again");
  run.answers.set("GET api/unsupported?since=1h", answer({ error: "the request log cannot be read" }, 500));
  app.show("#observability/usage?range=1h"); await app.poll();
  assert.match(textOf(app.view().unsupported!), /^✗ the request log cannot be read/, "a failure is said in its part, as the Failure");
});

test("the Overview: the last day's unsupported SQL is one line at its foot, with See all, and nothing when there is none", async () => {
  const runServer = await import("../src/cli/run-server.ts") as { MAX_UNSUPPORTED_LIMIT?: number };
  assert.equal(statusPage.UNSUPPORTED_LIMIT as unknown, runServer.MAX_UNSUPPORTED_LIMIT, "it reads every entry the endpoint answers, to count them");
  const line = of<[unknown], string>(statusPage, "status.js", "renderUnsupportedLine");
  const html = line(UNSUPPORTED);
  assert.equal(textOf(html), "Unsupported SQL, last day: a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase (and 1 other) See all");
  assert.match(html, /<a class="see" href="#observability\/queries\?range=24h">See all<\/a>/);
  assert.equal(line({ ...UNSUPPORTED, unsupported: [] }), "", "none: no line");
  assert.equal(line(undefined), "", "not read yet: nothing");
  assert.equal(textOf(line({ failure: { code: "failed", message: "no ledger\nmore" } })), "The unsupported SQL could not be read: no ledger.", "as mason status says it");
  const run = fakeRun();
  run.answers.set("GET api/state", answer(RUNNING));
  run.answers.set("GET api/unsupported?limit=100", answer(UNSUPPORTED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.ok(run.asked.includes("GET api/unsupported?limit=100"), "the Overview reads the last day's, the endpoint's default");
  assert.match(textOf(app.view().status!), /Connections open .* Unsupported SQL, last day: a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase \(and 1 other\) See all$/);
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
  assert.match(textOf(row), /public\.accounts Waiting ~300 rows key id View events Sync now Remove Sync… All but 1 column waiting for its first sync to start/);
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

test("Queries, an empty request log: its sentence, what the log does not list, and one quiet line, Create a user to connect your first tool — never once a filter or an older page is shown, nor where the page makes no user; no Connect on the Overview in any state", async () => {
  const renderRequests = fn<[unknown, Record<string, unknown>], string>("renderRequests");
  const empty = { requests: [], keptDays: 7, before: null };
  const html = renderRequests(empty, { span: "the last 24 hours", firstTool: true });
  assert.match(textOf(html), /^No queries in the last 24 hours\. Create a user to connect your first tool\. A statement that reads no synced table \(select 1, SET, SHOW, a BI tool's catalog queries\) is answered but not listed\.$/);
  assert.match(html, /<p class="empty first-tool"><a class="btn small primary" href="#users">Create a user<\/a> to connect your first tool\.<\/p><p class="dim unlisted">/, "one quiet line, its button to the Users page");
  assert.ok(!/class="connect|data-copy=|postgres:\/\//.test(html), "no Connect box, no URL");
  assert.equal((page as Record<string, unknown>).UNLISTED_STATEMENTS, commands.UNLISTED_STATEMENTS, "the page says what mason logs --requests says");
  for (const o of [{ filtered: true }, { paged: true }, { firstTool: false }]) assert.ok(!renderRequests(empty, { span: "the last 24 hours", firstTool: true, ...o }).includes("first-tool"), JSON.stringify(o));
  assert.equal((page as Record<string, unknown>).renderConnect, undefined, "Connect your first tool is gone");
  // the app: the line from /api/state, under the empty log's sentence
  const run = fakeRun();
  run.answers.set("GET api/state", () => new Response(JSON.stringify(RUNNING), { status: 200 }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.match(textOf(app.view()["request-log"]!), /^No queries in the last 15 minutes\. Create a user to connect your first tool\. /);
  // the Overview: no Connect, nothing asked yet or after (the owner's, 2026-11-12: connecting is on Users)
  for (const queries of [NO_QUERIES, QUERIES, undefined]) for (const st of [RUNNING, COPYING, NONE]) {
    const overview = fn<[unknown, unknown?], string>("renderStatus")(st, { queries, now: NOW });
    assert.ok(!/class="connect|Connect your first tool|Connect from anywhere|data-copy="connect-/.test(overview), "no Connect on the Overview");
  }
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
    "Put a user's name and password in place of <user> and <password> . The password is shown only once, when you add the user. If it's lost, remove the user and add it again.");
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
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<div id="users"><\/div>[\s\S]*<div id="users-connect"><\/div>\s*<\/section>/, "the list first, the panel last");
});

test("the Overview's first-run checklist: Mason is running, Sync a table, Connect a tool — the same words done or not, each ○ with its one action; Connect a tool done once a tool has used Mason, never for a user existing; gone once all three are done", async () => {
  const renderChecklist = of<[unknown, unknown, boolean?], string>(statusPage, "status.js", "renderChecklist");
  const none = NO_QUERIES;
  const answered = { queries: { ...NO_QUERIES.queries, week: { ...NO_QUERIES.queries.week, completed: 1 } } };
  const withSessions = (s: RunState, byClient: unknown[]) => ({ ...s, sessions: { open: byClient.length, byClient } });
  // a fresh install: a table added and synced, no tool has used Mason
  const fresh = renderChecklist(RUNNING, none);
  assert.equal(textOf(fresh), "Getting started 2 of 3 done ✓ Mason is running (done) ✓ Sync a table (done) ○ Connect a tool (to do) Create a user first");
  // the steps drawn as courses of a wall beside its title: a brick a step, laid as it is done (drawing, hidden from a screen reader)
  assert.match(fresh, /<p class="checklist-title"><span class="courses" aria-hidden="true"><i class="on"><\/i><i class="on"><\/i><i><\/i><\/span>Getting started /);
  assert.match(fresh, /<li class="step-todo"><span class="mark" aria-hidden="true">○<\/span><span class="what">Connect a tool<span class="sr"> \(to do\)<\/span><\/span><a class="btn small primary" href="#users">Create a user first<\/a><\/li>/, "the next step is the primary action, to the Users page: its text the step's, its button what to do first");
  assert.ok(!/A first statement answered|Copy the psql line|data-copy/.test(fresh));
  // nothing added: Add a table leads to Tables
  assert.match(renderChecklist(NONE, none), /○<\/span><span class="what">Sync a table<span class="sr"> \(to do\)<\/span><\/span><a class="btn small primary" href="#tables">Add a table<\/a>/);
  // copying: no action, it is under way
  assert.match(textOf(renderChecklist({ ...COPYING, totals: { ...COPYING.totals!, copied: 0 } }, none)), /○ Sync a table \(to do\) syncing now ○ Connect a tool/);
  // done: a statement completed in the request log's week; a user's session open now (a tool's catalog queries alone);
  // one seen open while the page was shown — each with a table synced, no checklist
  assert.equal(renderChecklist(RUNNING, answered), "");
  assert.equal(renderChecklist(withSessions(RUNNING, [{ user: "metabase", client: "Metabase", open: 1, running: 0 }]), none), "");
  assert.equal(renderChecklist(RUNNING, none, true), "");
  // a token's session ('') is not a tool's; a session open does not tell the step over a failed read either
  assert.match(textOf(renderChecklist(withSessions(RUNNING, [{ user: "", client: "psql", open: 1, running: 0 }]), none)), /○ Connect a tool/);
  assert.equal(textOf(renderChecklist(withSessions(NONE, [{ user: "metabase", client: "", open: 1, running: 0 }]), undefined)).includes("✓ Connect a tool (done)"), true, "a session tells it without the summary");
  // the summary not read, or its read failed, and no session: none (never a ○ for what could not be told)
  assert.equal(renderChecklist(RUNNING, undefined), "");
  assert.equal(renderChecklist(RUNNING, { failure: { code: "failed", message: "x" } }), "");
  // the app: the Overview no longer reads the users; a user existing does not tick the step
  const run = fakeRun();
  run.answers.set("GET api/state", answer(RUNNING));
  run.answers.set("GET api/queries", answer(NO_QUERIES));
  run.answers.set("GET api/users", answer({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true }] }));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  await app.poll();
  assert.ok(!run.asked.includes("GET api/users"), "the users are not read for it");
  const text = textOf(app.view().status!);
  // while getting started is not done, it is the Overview: the checklist alone (the owner, 2026-11-13)
  assert.match(text, /^Getting started 2 of 3 done ✓ Mason is running \(done\) ✓ Sync a table \(done\) ○ Connect a tool \(to do\) Create a user first$/);
  // a tool logs in: done, and the checklist goes, the rest of the Overview in its place; its session closed before a
  // statement reached the summary: still done
  run.answers.set("GET api/state", answer(withSessions(RUNNING, [{ user: "metabase", client: "Metabase", open: 1, running: 0 }])));
  t += 2000; await app.poll();
  const done = textOf(app.view().status!);
  assert.ok(!done.includes("Getting started"), "the three done: no checklist");
  assert.match(done, /^mason status Ready Every added table is synced and served .* Tables synced /, "the word, the cards and the rest once it is done");
  // a failure is never hidden behind the checklist: the word's box stays over it while it says Failed, or while the
  // state could not be read now
  const renderStatus = fn<[unknown, Record<string, unknown>?], string>("renderStatus");
  const failedSetup = textOf(renderStatus(SYNCED, { queries: NO_QUERIES, now: Date.UTC(2026, 9, 27, 9, 5, 30) }));
  assert.match(failedSetup, /^mason status Failed .* Getting started /, "Failed: its box, then the checklist");
  assert.ok(!failedSetup.includes("Tables synced"), "and nothing else");
  const unknown = textOf(renderStatus(RUNNING, { queries: NO_QUERIES, stale: { at: new Date(Date.UTC(2026, 9, 28, 9, 0, 0)), failure: { code: "unreachable", message: "Mason did not answer" } } }));
  assert.match(unknown, /^mason status Ready As of 09:00 UTC\. Mason can't be reached\. .* Getting started /, "a state that could not be read now: said, then the checklist");
  run.answers.set("GET api/state", answer(RUNNING));
  t += 2000; await app.poll();
  assert.ok(!textOf(app.view().status!).includes("Getting started"), "seen once: it stays done");
  // a statement in the request log's week: done from the first read
  run.answers.set("GET api/queries", answer(answered));
  const again = fn<[unknown], App>("createApp")(run.fetch);
  await again.poll();
  assert.ok(!textOf(again.view().status!).includes("Getting started"));
});

test("a page opened at its own address that reads no state (Users) still has the sidebar's project, badge and version: the shell reads the state once a minute beside it", async () => {
  const run = fakeRun();
  run.answers.set("GET api/state", answer(RUNNING));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(t), "#users");
  await app.poll();
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state", "GET api/share/choices"], "the page's own read first: its failure is the banner");
  assert.notEqual(app.view().where, "", "the sidebar names the database");
  assert.match(app.view().version!, /^Mason /);
  run.asked.length = 0; t += 30_000; await app.poll();
  assert.deepEqual(run.asked, ["GET api/users?lastUsed=1", "GET api/state", "GET api/share/choices"], "Users reads the state itself now (its Connect panel), and the roles a share may read as, at its own rate");
});

test("Tables: a synced table with no size says why — under the log's size, Measuring…, or nothing before its first sync — each with a tooltip, never — nor 0 B (issue 883)", () => {
  const renderTables = fn<[unknown, unknown?], string>("renderTables");
  // customers measured; orders measured since its first sync with no block (its rows all in a log of 2.3 MiB); events
  // synced after the last measure (the run says so); audit's first sync not done
  const state = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), copied("public.orders", 5_000, "2026-10-27T09:00:09.000Z"),
    copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"),
    { source: "public.audit", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 10, rowsEstimate: 50 }],
  { now: NOW, sources: parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n  audit: {}\n", "shop", "/app/mason/sources/shop.yml") as typeof sourceFile });
  const sizes = { ...USAGE, copySizes: [USAGE.copySizes[0]], sizedAt: "2026-10-27T09:00:00.000Z", walBytes: Math.round(2.3 * 2 ** 20),
    unsized: [{ table: "public.events", why: "synced-since", underBytes: null }, { table: "public.orders", why: "in-log", underBytes: 3 * 2 ** 20 }] };
  const html = renderTables(state, { sizes, now: NOW });
  const sizeCell = (t: string): string => {
    const row = new RegExp(`<tr class="c-added[^"]*"><th scope="row" class="name"><code class="name" title="${t.replace(".", "\\.")}">.*?</tr>`).exec(html)?.[0] ?? assert.fail(`no row for ${t}`);
    return [...row.matchAll(/<td[^>]*>.*?<\/td>/g)].map((m) => m[0])[4]!;
  };
  assert.equal(sizeCell("public.customers"), `<td class="num size">512.0 KiB</td>`, "measured: its size, no tooltip");
  assert.equal(sizeCell("public.orders"), `<td class="num size" title="Under 3 MiB. Its rows aren&#39;t in the main file yet, so it can&#39;t be measured exactly.">&lt; 3 MiB</td>`,
    "its rows all in the log: under the log's size, rounded up");
  assert.equal(sizeCell("public.events"), `<td class="num size" title="Synced since sizes were last measured. Sizes are measured every 10 minutes.">Measuring…</td>`);
  assert.equal(sizeCell("public.audit"), `<td class="num size" title="No size until its first sync is done."></td>`, "its first sync not done: blank");
  assert.doesNotMatch(textOf(html), /—|\b0 B\b/, "no dash, no 0 B");
  // the cell is what mason usage writes on its line (src/cli/usage.ts unsizedCell): one grammar
  for (const u of sizes.unsized) assert.ok(html.includes(`>${usageCliModule.unsizedCell(u as never).replace("<", "&lt;")}</td>`), u.table);
  // a first sync done since the sizes were read (a minute ago; the state is read every poll): Measuring…, never blank
  const unread = renderTables(state, { sizes: { ...sizes, unsized: [{ table: "public.orders", why: "in-log", underBytes: 3 * 2 ** 20 }] }, now: NOW });
  assert.match(unread, /<td class="num size" title="Synced since sizes were last measured\. Sizes are measured every 10 minutes\.">Measuring…<\/td>/);
  // EACH REASON THE RUN GIVES, its own words, never another's (review of PR 902): rows written to disk since the measure
  // (a checkpoint), and no measure since Mason started (a restart) — never "Synced since", which neither was
  const because = (why: string): string => {
    const h = renderTables(state, { sizes: { ...sizes, unsized: [{ table: "public.orders", why, underBytes: null }, { table: "public.events", why, underBytes: null }] }, now: NOW });
    return /<td class="num size" title="([^"]*)">Measuring…<\/td>/.exec(h)?.[1] ?? assert.fail(`no Measuring… for ${why}`);
  };
  assert.equal(because("written-since"), "Data was written to disk since sizes were last measured, and this table&#39;s rows may be in it. Sizes are measured every 10 minutes.");
  assert.equal(because("not-measured-yet"), "Not measured since Mason started. Sizes are first measured a minute after it starts.");
  assert.equal(because("synced-since"), "Synced since sizes were last measured. Sizes are measured every 10 minutes.");
  for (const why of ["written-since", "not-measured-yet", "synced-since"]) assert.equal(usageCliModule.unsizedCell({ why, underBytes: null } as never), "Measuring…", why);
  // the page never says the engine's file names
  assert.doesNotMatch(html, /write-ahead|WAL|duck\.db/i);
  // sizes not read yet: nothing said in the cell (the list says nothing of a size it has not read)
  assert.doesNotMatch(renderTables(state, { now: NOW }), /Measuring…|&lt; \d/);
});

test("Tables: an added copy not measured never says 0 B", () => {
  const html = fn<[unknown, unknown?], string>("renderTables")(SYNCED, {});
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

// ------------------------------------------------------------------ the list's order: the added tables first, laid out at set moments (issue 872)

/** The tables' names in the order the Tables list wrote them. */
const rowNames = (html: string) => [...html.matchAll(/<th scope="row" class="name"><code class="name" title="([^"]*)">/g)].map((m) => m[1]);
/** The catalog with two tables not added before the added ones, as a database lists them. */
const MIXED = [CATALOG[3]!, CATALOG[4]!, CATALOG[0]!, CATALOG[1]!, CATALOG[2]!, CATALOG[5]!, CATALOG[6]!];
const sourcesWith = (...more: string[]) => parseSourceText(`kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n${more.map((t) => `  ${t}: {}\n`).join("")}`, "shop", FILE) as typeof sourceFile;

test("Tables: Added lists the added tables, whatever their sync's word, over Not added, each in the state's order; the search over both (issue 872)", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const s = stateOf(THREE_COPIED(), { tables: MIXED });
  assert.deepEqual(s.tables.map((t) => t.table).slice(0, 2), ["public.audit", "public.accounts"], "the state lists two not added first");
  assert.deepEqual(rowNames(renderTables(s)), ["public.customers", "public.orders", "public.events", "public.audit", "public.accounts", "public.event_log", "public.staging"]);
  const [addedPart, otherPart] = renderTables(s).split('<h3 class="list-h">Not added');
  assert.deepEqual(rowNames(addedPart!), ["public.customers", "public.orders", "public.events"], "Added");
  assert.deepEqual(rowNames(otherPart!), ["public.audit", "public.accounts", "public.event_log", "public.staging"], "Not added, under it");
  assert.deepEqual(rowNames(renderTables(s, { filter: "s" })), ["public.customers", "public.orders", "public.events", "public.accounts", "public.staging"], "the search narrows the laid-out list");
  // a failed and a waiting one are added: first too
  const failing = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null, error: "connection reset" }],
    { tables: MIXED });
  assert.deepEqual(rowNames(renderTables(failing)).slice(0, 3), ["public.customers", "public.orders", "public.events"]);
  // 150 tables not added before them: the first 100 written begin with every added table
  const many = stateOf(THREE_COPIED(), { tables: [...Array.from({ length: 150 }, (_, i) => table(`t${String(i).padStart(3, "0")}`, i)), ...TABLES] });
  const written = rowNames(renderTables(many));
  assert.equal(written.length, 100);
  assert.deepEqual(written.slice(0, 4), ["public.customers", "public.orders", "public.events", "public.t000"]);
  // a layout made earlier is kept: each table in the list and the place it was put, one new in the catalog after them in
  // the list its added mark says, one gone gone
  const kept = renderTables(s, { order: { added: ["public.audit", "public.customers", "public.gone"], other: ["public.accounts"] } });
  assert.deepEqual(rowNames(kept), ["public.audit", "public.customers", "public.orders", "public.events", "public.accounts", "public.event_log", "public.staging"]);
  assert.deepEqual(rowNames(kept.split('<h3 class="list-h">Not added')[0]!), ["public.audit", "public.customers", "public.orders", "public.events"], "audit stays in Added, where it was laid out");
});

test("Tables: a table added or removed keeps its row in its list, its state changing in place, until the lists are laid out again — Failed only, the search or the page shown again (issue 872)", async () => {
  const run = fakeRun();
  const before = stateOf(THREE_COPIED(), { tables: MIXED });
  run.answers.set("GET api/state", answer(before));
  const app = fn<[unknown], ObsApp>("createApp")(run.fetch);
  app.show("tables"); await app.poll();
  const tp = app.pages.get("tables")!;
  const laidOut = ["public.customers", "public.orders", "public.events", "public.audit", "public.accounts", "public.event_log", "public.staging"];
  assert.deepEqual(rowNames(app.view().tables!), laidOut);
  // Add audit from the page: its row stays where it was, Adding… then its sync's word
  const withAudit = stateOf(THREE_COPIED(), { tables: MIXED, sources: sourcesWith("audit") });
  run.answers.set("POST api/pick", () => { run.answers.set("GET api/state", answer(withAudit)); return answer({ ...PICKED.keyed, table: "public.audit", state: withAudit })(); });
  assert.equal(await (app as unknown as App).addTable("public.audit"), true);
  assert.deepEqual(rowNames(app.view().tables!), laidOut, "added: no row moved");
  assert.match(textOf(app.view().tables!), /public\.audit Waiting /, "its state changed in place");
  assert.match(app.view().tables!.split('<h3 class="list-h">Not added')[1]!, /title="public\.audit"/, "still in Not added");
  await app.poll(); await app.poll();
  assert.deepEqual(rowNames(app.view().tables!), laidOut, "the polls after it move nothing either");
  // Failed only ticked and cleared: laid out anew, audit first of the added (the state lists it first)
  tp.input!({ id: "tables-failed", checked: true });
  assert.deepEqual(rowNames(app.view().tables!), [], "none failed");
  tp.input!({ id: "tables-failed", checked: false });
  const second = ["public.audit", "public.customers", "public.orders", "public.events", "public.accounts", "public.event_log", "public.staging"];
  assert.deepEqual(rowNames(app.view().tables!), second);
  // accounts added beside the page (mason add): it keeps its row at the polls; the search box's text lays it out
  run.answers.set("GET api/state", answer(stateOf(THREE_COPIED(), { tables: MIXED, sources: sourcesWith("audit", "accounts") })));
  await app.poll();
  assert.deepEqual(rowNames(app.view().tables!), second, "added elsewhere: still in its row");
  tp.input!({ id: "tables-filter", value: "" });
  const third = ["public.audit", "public.accounts", "public.customers", "public.orders", "public.events", "public.event_log", "public.staging"];
  assert.deepEqual(rowNames(app.view().tables!), third, "the search box's text changed: laid out");
  // removed beside the page (mason remove): in its row until the page is shown again
  run.answers.set("GET api/state", answer(before));
  await app.poll();
  assert.deepEqual(rowNames(app.view().tables!), third);
  assert.match(textOf(app.view().tables!), /public\.accounts Not added /);
  app.show("status"); app.show("tables");
  assert.deepEqual(rowNames(app.view().tables!), laidOut, "shown again: laid out");
  // added while another page was shown: the read the showing makes lays it out
  app.show("status");
  run.answers.set("GET api/state", answer(withAudit));
  app.show("tables"); await app.poll();
  assert.deepEqual(rowNames(app.view().tables!).slice(0, 2), ["public.audit", "public.customers"], "shown again: laid out from the state read for it");
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
  // each list's header row left out: a table's rows alone
  const trs = rowsOf(html).filter((tr) => tr !== "<tr>");
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
  const COLUMNS = ["name", "state", "rows", "key", "last", "size", "act"];
  assert.deepEqual(heads, [...COLUMNS, ...COLUMNS], "Added and Not added: the same columns, so they line up one over the other");
  for (const c of heads.filter((x) => x !== "name")) assert.match(rule(`table.catalog th.${c}`), /width: \d+px/, `the ${c} column has its width`);
  assert.match(rule("td.act"), /white-space: nowrap/, "a row's actions never wrap");
  assert.match(rule(".panel"), /overflow-x: auto/, "a table in a card scrolls inside it");
  assert.match(rule(".scroll"), /overflow-x: auto/);
  assert.match(rule(".table-wrap"), /overflow-x: auto/, "a bare table too wide scrolls inside its box");
  assert.match(rule(".pop button"), /max-width: 100%/, "a confirm's button names a long table, cut, never past the popover");
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
  assert.match(textOf(el("tables").html), /Synced public\.customers:/, "the answer, said");
  press("Escape");
  await settle();
  assert.ok(!/Synced public\.customers:/.test(textOf(el("tables").html)), "Escape took it");
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
  assert.equal(textOf(renderSubnav("usage", "24h")), "Live Last 15 mins Last hour 24 hours 7 days", "a run that has not said what it keeps: no range it could not tell");
  const kept7 = renderSubnav("usage", "24h", 7);
  assert.match(kept7, /<span class="off" aria-disabled="true" title="Mason keeps 7 days of history\. Set MASON_HISTORY_DAYS=30 to keep 30\.">30 days<span class="sr"> \(Mason keeps 7 days of history\. Set MASON_HISTORY_DAYS=30 to keep 30\.\)<\/span><\/span>/);
  assert.ok(!/href="[^"]*range=30d"/.test(kept7) && !/href="[^"]*range=90d"/.test(kept7), "never a link to more than is kept");
  const kept30 = renderSubnav("usage", "24h", 30);
  assert.match(kept30, /<a href="#observability\/usage\?range=30d" title="Updates every minute">30 days<\/a>/);
  assert.match(kept30, /title="Mason keeps 30 days of history\. Set MASON_HISTORY_DAYS=90 to keep 90\.">90 days/);
  assert.match(renderSubnav("syncs", "90d", 90), /<a href="#observability\/syncs\?range=90d" aria-current="true" title="Updates every minute">90 days<\/a>/);
  // a bookmark of 90 days on a run that keeps 7 still lands on it (the log says what it keeps)
  assert.match(renderSubnav("queries", "90d", 7), /aria-current="true" title="Updates every minute">90 days<\/a>/);
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
  // each kind in the page's words, its code the option's value: a word for every kind the sync records
  const words = (syncsPage as Record<string, unknown>).KIND_WORDS as Record<string, string>;
  for (const k of EVENT_KINDS) assert.ok(typeof words[k] === "string" && words[k] !== k, `${k} has its words on the page`);
  assert.equal(text, `Kind Every kind ${EVENT_KINDS.map((k) => words[k]).join(" ")} Table Every table Mason events public.customers public.events public.orders`);
  assert.match(renderEventFilters(only, { kind: "synced", table: "" }, RUNNING), /<option value="synced" selected>Manual sync<\/option>/);
  assert.match(renderEventFilters(only, {}, RUNNING), /<option value="copied">Full sync<\/option>.*<option value="polled">Scheduled sync<\/option><option value="streamed">Live sync<\/option>/s);
  // a removed table's events keep it a choice; nothing read yet still lists the added tables
  assert.match(textOf(renderEventFilters({ events: [{ ...only.events[0], table: "public.gone" }], keptDays: 7 }, {}, RUNNING)), /public\.orders public\.gone$/);
  assert.match(textOf(renderEventFilters(undefined, {}, RUNNING)), /Every table Mason events public\.customers public\.events public\.orders$/);
  assert.equal(textOf(renderEvents(only, { table: "public.customers", span: "the last 24 hours" })), "No events for public.customers in the last 24 hours. Mason keeps 7 days of history.");
  // an event of no one table is Mason's: "Mason" where a table's name goes, as mason logs --events says it, and the
  // filter's choice "Mason events"
  assert.equal(page.MASON_TABLE as unknown as string, (commands as Record<string, unknown>).MASON_TABLE, "the page and the CLI say the same");
  assert.match(renderEventFilters(only, { table: "Mason" }, RUNNING), /<option value="Mason" selected>Mason events<\/option>/);
  assert.equal(textOf(renderEvents(only, { table: "Mason", span: "the last 24 hours" })), "No Mason events in the last 24 hours. Mason keeps 7 days of history.");
  assert.equal(textOf(renderEvents(only, { table: "Mason", failuresOnly: true, span: "the last 24 hours" })), "No Mason failures in the last 24 hours. Mason keeps 7 days of history.");
  const mason = renderEvents({ events: [{ at: "2026-10-28T09:00:00.000Z", kind: "source_unreachable", failed: true, table: null, message: "could not attach the database" }], keptDays: 7 }, {});
  assert.match(mason, /<td><span class="dim">Mason<\/span><\/td>/, "dimmed: not a table's name");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { table: "public.customers", span: "the last 24 hours" })), "No events for public.customers in the last 24 hours. Mason keeps 7 days of history.");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { span: "the last 24 hours" })), "No sync event in the last 24 hours. Mason keeps 7 days of history.");
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
  assert.match(textOf(app.view()["syncs-events"]!), /^1 of the 3 events read\. When ↓ Kind Table Message 9 min ago ✗ Full sync failed public\.events /, "its events alone");
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
    assert.match(closed, new RegExp(`<td class="stmt-cell"><div class="stmt-line"><code class="stmt"[^>]*>[^<]*</code><button type="button" class="expand" data-expand="request:${id}" aria-expanded="false" aria-label="Show the whole query" title="Show the whole query"><span aria-hidden="true">\\+</span></button></div>`),
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

// ------------------------------------------------------------------ Temporary cloud login (the page's mason share, the add box's second kind)

const SHARE_AT = "2026-11-01T10:00:00.000Z";
const SHARE_NOW = Date.parse("2026-11-01T10:05:00.000Z");
const PASSWORD = `mason_share_${"ab".repeat(24)}`;
const SHARE_URL = `postgres://share_a1b2c3:${PASSWORD}@relay.example:41234/shop?sslmode=require`;
const listed = { user: "share_a1b2c3", from: "page", role: null, reads: "every synced table", openedAt: SHARE_AT, via: "pinggy", host: "relay.example", port: 41234, endsAt: "2026-11-01T11:00:00.000Z", state: "up" };
const sharing = (shares: unknown[], o: Record<string, unknown> = {}) => ({ ...RUNNING, share: shares.length ? { port: 40001, fingerprint: "AA", sessions: 0, refusedLogins: 0, droppedConnections: 0, shares } : null, shareEnded: null, ...o });
const shareModel = (o: Record<string, unknown> = {}) => ({ phase: "none", role: null, opened: null, ended: null, failure: null, ...o });
const ONE_ANSWER = { body: { choices: [], role: null, reads: "every synced table" }, failure: null };
const ONE_ROLE = { body: { choices: [{ role: "sales", reads: "1 synced table: orders", default: true }] }, failure: null };
const TWO_ROLES = { body: { choices: [{ role: "sales", reads: "1 synced table: orders", default: true }, { role: "ops", reads: "every synced table", default: false }] }, failure: null };
const sharePane = (s: unknown, m: unknown, choices: unknown = ONE_ANSWER) => fn<[unknown, unknown, unknown], string>("renderSharePane")(s, m, choices);
const shareCard = (s: unknown, m: unknown) => fn<[unknown, unknown, number], string>("renderShareCard")(s, m, SHARE_NOW);
const shareOnce = (s: unknown, m: unknown) => fn<[unknown, unknown, number], Record<string, string>>("renderShareOnce")(s, m, SHARE_NOW);
const PANE_WORDS = "For a tool in the cloud that can't reach this machine. Opens a public address with a login of its own, until you stop it.";

test("Temporary cloud login: the add box's segments, its pane in each state, its one-time dialog once opened and its card in each — none, opening, open, open after a reload, ended, refused, served, read-only — as they WROTE them", () => {
  // the segments: New user and Temporary cloud login, the one chosen pressed
  const kinds = fn<[string], string>("renderAddKinds");
  assert.equal(kinds("user"), `<div class="range add-kinds" role="group" aria-label="What to create"><button type="button" data-add-kind="user" aria-pressed="true">New user</button><button type="button" data-add-kind="share" aria-pressed="false">Temporary cloud login</button></div>`);
  assert.match(kinds("share"), /data-add-kind="user" aria-pressed="false">New user<\/button><button type="button" data-add-kind="share" aria-pressed="true">/);
  // the pane: two sentences, then Open a cloud login; a Role only where more than one is offered
  const none = sharePane(sharing([]), shareModel());
  assert.equal(textOf(none), `${PANE_WORDS} Open a cloud login`);
  assert.match(none, /<button type="button" class="primary" data-share-open="">Open a cloud login<\/button>/, "enabled");
  assert.doesNotMatch(none + sharePane(sharing([]), shareModel(), ONE_ROLE), /<select/, "none or one role: no role to choose");
  const two = sharePane(sharing([]), shareModel(), TWO_ROLES);
  assert.match(two, /<label for="share-role">Role<\/label> <select id="share-role"><option value="sales" selected>sales: 1 synced table: orders \(default\)<\/option><option value="ops">ops: every synced table<\/option><\/select><\/span> <button[^>]*data-share-open/, "the roles beside the button, the file's default first chosen");
  assert.match(sharePane(sharing([]), shareModel({ role: "ops" }), TWO_ROLES), /<option value="ops" selected>/, "the role chosen stays chosen across a rewrite");
  const unread = sharePane(sharing([]), shareModel(), null);
  assert.equal(textOf(unread), `${PANE_WORDS} Open a cloud login Reading the roles…`);
  assert.match(unread, /data-share-open="" disabled>Open a cloud login/, "no button before the roles are read");
  const rolesFailure = { code: "refused", message: "no role of mason/roles.yml can be shared: the rows of each depend on an attribute, and a share's login has no attributes" };
  const noRole = sharePane(sharing([]), shareModel(), { body: undefined, failure: rolesFailure });
  assert.ok(noRole.includes(fn<[unknown], string>("renderFailure")(rolesFailure)), "the roles refused: the run's Failure");
  assert.match(noRole, /data-share-open="" disabled>/);
  // one at a time: while one opens or is open the button is held, the pane's words the same
  for (const [s, m] of [[sharing([]), shareModel({ phase: "opening" })], [sharing([listed]), shareModel({ phase: "open" })]] as const) {
    const busy = sharePane(s, m);
    assert.equal(textOf(busy), `${PANE_WORDS} Open a cloud login`);
    assert.match(busy, /title="One is open: stop it to open another" disabled>Open a cloud login/);
  }
  // nothing before anything was asked
  assert.equal(shareCard(sharing([]), shareModel()), "");
  assert.equal(textOf(shareCard(sharing([]), shareModel({ phase: "opening" }))), "Temporary cloud login Opening a temporary public address… This can take up to 30 s.");

  // just opened: the one-time dialog's parts, titled Temporary cloud login — URL, Login and Password, what it reads, one line
  const opened = { url: SHARE_URL, user: "share_a1b2c3", password: PASSWORD, database: "shop", host: "relay.example", port: 41234, role: null, reads: "every synced table", openedAt: SHARE_AT };
  const parts = shareOnce(sharing([listed]), shareModel({ phase: "open", opened }));
  assert.deepEqual(Object.keys(parts), ["once-head", "once-status", "once-foot"]);
  const once = onceHtml(parts);
  assert.match(once, /^<p class="once-title" id="once-title">Temporary cloud login<\/p><dl class="facts">/);
  for (const [id, v] of [["share-url", SHARE_URL], ["share-password", PASSWORD]]) {
    assert.ok(once.includes(`<code id="${id}">${v}</code> <button type="button" class="small" data-copy="${id}"`), `${id} with its Copy`);
  }
  assert.match(once, /<dt>Login<\/dt><dd>share_a1b2c3<\/dd>/, "the login its name, as a new user's User is");
  assert.match(once, /data-copy="share-password"[^>]*>Copy<\/button> <span class="badge warn">Shown once<\/span><\/span><\/dd>/, "Shown once beside the password's Copy");
  assert.equal(textOf(once), `Temporary cloud login URL ${SHARE_URL} Copy Login share_a1b2c3 Password ${PASSWORD} Copy Shown once Public for 5 min : every synced table ` +
    "The password is only shown once and is not saved. This login is its own, and stops working when it ends.");
  assert.match(textOf(onceHtml(shareOnce(sharing([{ ...listed, role: "sales", reads: "1 synced table: orders" }]), shareModel({ phase: "open", opened })))), /Public for 5 min , as the role sales: 1 synced table: orders/);
  assert.match(textOf(onceHtml(shareOnce(sharing([]), shareModel({ phase: "open", opened })))), /Public for 5 min : every synced table/, "before the state lists it: from the answer that opened it");
  // none: before anything was asked, while it opens, after a reload (no answer), once ended or refused
  for (const m of [shareModel(), shareModel({ phase: "opening" }), shareModel({ phase: "open" }), shareModel({ phase: "ended", ended: { user: "share_a1b2c3", why: "x" } }), shareModel({ phase: "refused", failure: { code: "x", message: "y" } })]) {
    assert.equal(onceHtml(shareOnce(sharing([listed]), m)), "", `no dialog in phase ${m.phase}`);
  }

  // open: the card, its password never in it (the dialog's alone) — its host, port and login, what it reads, Stop
  for (const m of [shareModel({ phase: "open", opened }), shareModel()]) {
    const card = shareCard(sharing([listed]), m);
    assert.match(card, /^<div class="user-added share-added" role="status"><p class="added-title">Temporary cloud login<\/p><dl class="facts">/);
    assert.ok(!card.includes(PASSWORD) && !card.includes("share-password") && !card.includes("share-url"), "the password is nowhere in the card, the dialog open or not, after a reload too");
    assert.equal(textOf(card).replace(/ at .+? \(in /, " at HH:MM (in "), "Temporary cloud login Host relay.example Copy Port 41234 Copy Login share_a1b2c3 Public for 5 min : every synced table " +
      "The password was shown once, when it opened, and is not saved. For a new one, press Stop, then Open a cloud login. " +
      "Live until you stop it. A free one ends sooner, within about an hour, at HH:MM (in about 55 minutes). Then open a new one for a new address and password. It also ends within two minutes of closing this page. Stop");
    assert.match(card, /<button type="button" id="share-stop" class="danger" data-share-stop="share_a1b2c3">Stop<\/button><\/div>$/, "Stop, where the focus goes once the dialog closes");
  }
  assert.match(textOf(shareCard(sharing([{ ...listed, endsAt: null }]), shareModel({ phase: "open", opened }))), /Live until you stop it\. It also ends within two minutes of closing this page\./, "one with no end: until stopped");
  assert.match(textOf(shareCard(sharing([{ ...listed, role: "sales", reads: "1 synced table: orders" }]), shareModel({ phase: "open" }))), /Public for 5 min , as the role sales: 1 synced table: orders/);

  // ended and refused: said in the card's place
  assert.equal(textOf(shareCard(sharing([]), shareModel({ phase: "ended", ended: { user: "share_a1b2c3", why: "its tunnel closed (ssh exited 255)" } }))),
    "The temporary cloud login ended: its tunnel closed (ssh exited 255). Its address and password no longer work.");
  assert.equal(textOf(shareCard(sharing([]), shareModel({ phase: "ended", ended: { user: "share_a1b2c3", why: "you stopped it on this page" } }))),
    "The temporary cloud login ended: you stopped it on this page. Its address and password no longer work.");
  const failure = { code: "not_found", message: "ssh is not on this machine", fix: "install the OpenSSH client", next: [{ command: "mason doctor", what: "checks this machine" }] };
  const refused = shareCard(sharing([]), shareModel({ phase: "refused", failure }));
  assert.equal(refused, fn<[unknown], string>("renderFailure")(failure), "a refusal is the CLI's Failure, rendered by renderFailure");

  for (const m of [shareModel(), shareModel({ phase: "open", opened })]) {
    for (const s of [sharing([listed], { served: true }), sharing([listed], { pageReadOnly: "the web page is read-only here (MASON_UI_READ_ONLY=1)" }), sharing([listed], { pageReadOnly: "x", pageReadOnlyAllow: ["users"] })]) {
      assert.equal(sharePane(s, m) + shareCard(s, m) + onceHtml(shareOnce(s, m)), "", "under mason serve, or read-only (its users the page's or not): absent");
    }
  }
  // never called a user, never a tunnel's provider, never the engine
  for (const html of [none, two, once, shareCard(sharing([listed]), shareModel()), refused]) assert.doesNotMatch(textOf(html), /pinggy|bore\b|duck|\buser\b|Share over the internet/i);
});

test("Temporary cloud login over a fake run: Open a cloud login opens it confirmed with the role chosen, beaten on a timer of its own, its end said and its password dropped; Stop", async () => {
  const asked: Array<[string, string | undefined, unknown]> = [];
  let state: unknown = sharing([]);
  const answers: Record<string, unknown> = {
    "POST api/share": { body: { url: SHARE_URL, user: "share_a1b2c3", host: "relay.example", port: 41234, database: "shop", password: PASSWORD, beatMs: 15_000 } },
    "POST api/share/share_a1b2c3/beat": { body: { ok: true } },
  };
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const refreshed: string[][] = [];
  const ctx = {
    ask: async (p: string, init?: { method?: string; body?: string }) => { asked.push([p, init?.method, init?.body === undefined ? undefined : JSON.parse(init.body)]); return answers[`${init?.method ?? "GET"} ${p}`]; },
    read: (p: string) => p === "api/share/choices" ? TWO_ROLES : { body: state, failure: null }, refresh: async (ps: string[]) => { refreshed.push(ps); }, now: () => new Date(SHARE_NOW),
    timers: { setInterval: (f: () => void, ms: number) => { intervals.push({ fn: f, ms, cleared: false }); return intervals.length - 1; }, clearInterval: (i: number) => { intervals[i]!.cleared = true; } },
  };
  type Share = { m: Record<string, unknown>; actions: Record<string, (...a: unknown[]) => Promise<void> | void>; afterRead: (s: unknown) => void; click: (d: Record<string, string>) => unknown; input: (t: unknown) => unknown;
    once: () => { key: string; back: string } | null; dismissOnce: () => void };
  const share = fn<[unknown], Share>("createShare")(ctx);
  assert.equal(share.input({ id: "user-role", value: "x" }), null, "another input is not its");
  share.input({ id: "share-role", value: "ops" });
  share.input({ id: "share-role", value: "nobody" });
  assert.equal(share.m.role, "ops", "only a role offered is chosen");
  await share.click({ shareOpen: "" });
  assert.deepEqual(asked.find(([p, m]) => p === "api/share" && m === "POST")?.[2], { from: "page", confirmed: true, role: "ops" }, "confirmed by the click, the role chosen");
  assert.equal(share.m.phase, "open");
  assert.equal((share.m.opened as { password: string }).password, PASSWORD);
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
  // a reload over an open one: it is beaten again, its password not shown
  const again = fn<[unknown], Share>("createShare")(ctx);
  again.afterRead(sharing([listed]));
  assert.equal(again.m.phase, "open");
  assert.equal(intervals.length, 2);
  // Stop: DELETE, the beats end
  answers["DELETE api/share/share_a1b2c3"] = { body: { ok: true } };
  await again.click({ shareStop: "share_a1b2c3" });
  assert.ok(asked.some(([p, m]) => p === "api/share/share_a1b2c3" && m === "DELETE"));
  assert.equal(again.m.phase, "ended");
  assert.deepEqual(again.m.ended, { user: "share_a1b2c3", why: "you stopped it on this page" });
  assert.equal(intervals[1]!.cleared, true);
  // a refusal to open: the run's Failure, and the roles read again
  const third = fn<[unknown], Share>("createShare")(ctx);
  answers["POST api/share"] = { failure: { code: "failed", message: "the tunnel did not give an address within 30 s" } };
  await third.click({ shareOpen: "" });
  assert.equal(third.m.phase, "refused");
  assert.deepEqual(refreshed.at(-1), ["api/share/choices"]);
  assert.equal(third.once(), null, "refused: no dialog");
  // the one-time dialog: named while the answer that opened it is held; I have copied it drops it, the share still open
  answers["POST api/share"] = { body: { url: SHARE_URL, user: "share_a1b2c3", host: "relay.example", port: 41234, database: "shop", password: PASSWORD, beatMs: 15_000, reads: "every synced table", openedAt: SHARE_AT } };
  const fourth = fn<[unknown], Share>("createShare")(ctx);
  assert.equal(fourth.once(), null, "nothing asked: no dialog");
  await fourth.click({ shareOpen: "" });
  assert.deepEqual(fourth.once(), { key: "share share_a1b2c3", back: "share-stop" }, "opened: the dialog, the focus to Stop once it closes");
  fourth.afterRead(sharing([listed]));
  fourth.dismissOnce();
  assert.equal(fourth.once(), null, "closed");
  assert.ok(!JSON.stringify(fourth.m).includes(PASSWORD), "the password gone from the page's memory");
  fourth.afterRead(sharing([listed]));
  assert.equal(fourth.m.phase, "open", "the share still open, its card live");
  assert.equal(intervals.at(-1)!.cleared, false, "and still beaten");
  // ended while the dialog is open: the password is dead, so the dialog goes with it, the end said in the card's place
  const fifth = fn<[unknown], Share>("createShare")(ctx);
  await fifth.click({ shareOpen: "" });
  fifth.afterRead(sharing([listed]));
  fifth.afterRead(sharing([], { shareEnded: { user: "share_a1b2c3", from: "page", why: "its tunnel closed (ssh exited 255)", at: SHARE_AT } }));
  assert.deepEqual([fifth.once(), fifth.m.phase], [null, "ended"]);
});

test("in the browser: Open a cloud login opens the one-time dialog (its Copy focused, Escape refused, polls leaving it as it is); I have copied it closes it, the live card left with Stop focused and no password on the page", async () => {
  const run = fakeRun();
  let state: unknown = sharing([]);
  run.answers.set("GET api/state", () => new Response(JSON.stringify(state), { status: 200 }));
  run.answers.set("GET api/share/choices", answer(ONE_ANSWER.body));
  run.answers.set("POST api/share", () => { state = sharing([listed]); return new Response(JSON.stringify({ url: SHARE_URL, user: "share_a1b2c3", host: "relay.example", port: 41234, database: "shop",
    password: PASSWORD, role: null, reads: "every synced table", openedAt: SHARE_AT, endsAt: null, beatMs: 15_000 }), { status: 200 }); });
  run.answers.set("POST api/share/share_a1b2c3/beat", answer({ ok: true }));
  const { el, on, doc, tick, settle } = fakeBrowser(run, "#users");
  await settle();
  const d = doc as unknown as { focused: string };
  const click = async (dataset: Record<string, string>) => { await on.get("click")!({ target: { closest: (sel: string) => sel === "button" ? { dataset } : null } }); await settle(); };
  await click({ addKind: "share" });
  await click({ shareOpen: "" });
  const once = el("once");
  assert.deepEqual([once.open, once.shown], [true, 1], "opened as a modal");
  assert.match(el("once-head").html, /^<p class="once-title" id="once-title">Temporary cloud login<\/p>/);
  assert.ok(el("once-head").html.includes(PASSWORD));
  assert.match(textOf(el("once-status").html), /^Public for .* : every synced table$/);
  assert.match(textOf(el("once-foot").html), /^The password is only shown once and is not saved\./);
  assert.equal(d.focused, "once [data-copy]");
  assert.ok(!el("added").html.includes(PASSWORD), "the card under the box never holds it");
  let cancelled = false;
  once.fire("cancel", { preventDefault: () => { cancelled = true; } });
  const head = el("once-head").writes;
  for (let i = 0; i < 3; i++) { tick(); await settle(); }
  assert.deepEqual([cancelled, once.open, el("once-head").writes], [true, true, head], "Escape refused; polls close and rewrite nothing");
  await click({ dismissOnce: "" });
  assert.equal(once.open, false, "closed by its button");
  assert.equal(d.focused, "share-stop", "the focus on the live card's Stop");
  assert.match(textOf(el("added").html), /^Temporary cloud login Host relay\.example Copy Port 41234 Copy Login share_a1b2c3 .* The password was shown once, when it opened, and is not saved\..* Stop$/);
  assert.ok(["added", "once-head", "once-status", "once-foot", "add-share-box"].every((id) => !el(id).html.includes(PASSWORD)), "the password nowhere on the page");
});

test("the Users page over a fake run: the add box offers New user and Temporary cloud login, a choice rewriting neither pane; its card where New user added is; never in the users list; Connect points to it; a served run has the plain form", async () => {
  const run = fakeRun();
  let state: unknown = RUNNING;
  run.answers.set("GET api/state", () => new Response(JSON.stringify(state), { status: 200 }));
  run.answers.set("GET api/share/choices", answer(TWO_ROLES.body));
  run.answers.set("POST api/share", answer({ url: SHARE_URL, user: "share_a1b2c3", host: "relay.example", port: 41234, database: "shop", password: PASSWORD, beatMs: 15_000 }));
  const app = fn<[unknown], App & { markStale(): void; pages: Map<string, { input(t: unknown): unknown; click(d: unknown, b: unknown, w: unknown): unknown; arrive(): unknown }> }>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  const before = app.view();
  assert.match(before["add-kinds"]!, /data-add-kind="user" aria-pressed="true">New user/);
  assert.match(before["add-user-box"]!, /^<form id="add-user" autocomplete="off">/, "in the box, the form is no card of its own");
  assert.match(textOf(before["add-share-box"]!), /^For a tool in the cloud .* Role sales: 1 synced table: orders \(default\) ops: every synced table Open a cloud login$/);
  assert.match(textOf(before["users-connect"]!), /A tool in the cloud that can't reach this machine: choose Temporary cloud login in the box above\.$/);
  assert.doesNotMatch(before["users-connect"]!, /data-share/, "no box in Connect");
  const page = app.pages.get("users")!;
  assert.equal(page.arrive(), "user-name");
  // the segment: only the segments are rewritten, so a name being typed in the form stays
  await page.click({ addKind: "share" }, {}, {});
  const after = app.view();
  assert.match(after["add-kinds"]!, /data-add-kind="share" aria-pressed="true">/);
  assert.equal(after["add-user-box"], before["add-user-box"], "the form not rewritten");
  assert.equal(after["add-share-box"], before["add-share-box"], "the pane not rewritten");
  assert.equal(page.arrive(), null, "the form unseen: no focus into it");
  page.input({ id: "share-role", value: "ops" });
  run.asked.length = 0;
  await page.click({ shareOpen: "" }, {}, {});
  assert.equal(run.asked[0], `POST api/share ${JSON.stringify({ from: "page", confirmed: true, role: "ops" })}`);
  // the run lists it now: its password in the one-time dialog alone, its card in the added place, never a row of the
  // users nor in their counts
  state = sharing([{ ...listed, role: "ops" }]);
  app.markStale(); await app.poll();
  const open = app.view();
  assert.match(open["once-head"]!, /<p class="once-title" id="once-title">Temporary cloud login<\/p>/);
  assert.ok(open["once-head"]!.includes(PASSWORD));
  assert.match(open.added!, /<p class="added-title">Temporary cloud login<\/p>/);
  assert.ok(!open.added!.includes(PASSWORD), "never in the card");
  assert.ok(!open.users!.includes("share_a1b2c3"), "not a user");
  assert.match(open["add-share-box"]!, /disabled>Open a cloud login/, "one at a time");
  const served = fakeRun();
  served.answers.set("GET api/state", answer({ ...RUNNING, served: true }));
  const sapp = fn<[unknown], App>("createApp")(served.fetch);
  sapp.show("users");
  await sapp.poll();
  assert.ok(!served.asked.includes("GET api/share/choices"), "a served run's roles are not asked: it refuses a share");
  const sv = sapp.view();
  assert.equal(sv["add-kinds"], "", "no segments");
  assert.equal(sv["add-share-box"], "");
  assert.match(sv["add-user-box"]!, /^<form id="add-user" class="formcard"/, "the plain add form, its own card");
  assert.doesNotMatch(Object.values(sv).join(""), /Temporary cloud login|data-share/);
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
  assert.deepEqual([before, Number(grid![1])], [8, 9], "eight of Mason's own on a run with tables added, nine with the host's (app.css lays both out)");
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
