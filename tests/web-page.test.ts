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
import type { SyncEvent } from "../src/duck/events.ts";
import type { LedgerRequest } from "../src/duck/requests.ts";

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
  show(page: string, env?: unknown): void; poll(): Promise<void>; addUser(name: string): Promise<boolean>; askRemove(name: string): void; cancelRemove(): void;
  confirmRemove(name: string): Promise<boolean>; dismissAdded(): void; view(): Record<string, string>;
  addTable(table: string, columns?: string[], key?: string[]): Promise<boolean>; choose(table: string): Promise<boolean>; cancelChoose(): void;
  askRemoveTable(table: string): void; cancelRemoveTable(): void; confirmRemoveTable(table: string): Promise<boolean>; dismissOutcome(): void;
}

/** What a reader sees of some HTML: its text, tags gone and entities read, spaces collapsed. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

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
function stateOf(copies: CopyState[], o: { warnings?: string[]; replication?: boolean; tables?: SourceTable[]; sources?: typeof sourceFile; demo?: boolean; now?: number } = {}): RunState {
  const ctx = {
    source: o.demo ? demoSource : source, ...(o.demo ? { demo: true } : {}),
    facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: o.tables ?? TABLES, systemIdentifier: null }),
    warnings: o.warnings ?? [], slot: o.replication ? "mason_dev_shop" : "", changes: o.replication ? "replication" : "poll",
    ...(o.replication ? { publication: { name: "app_pub", owned: false } } : {}),
    page: true, users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: o.sources ?? sourceFile, problem: null }),
    listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", pollSeconds: 5, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
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
  { ...copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"), unsynced: { reason: "over the poll's row limit", asOf: "2026-10-27T09:04:00.000Z" } }],
  { warnings: ["mason/sources/shop.yml: tables.ordrs: no such table (Mason copies the tables it read before; mason start reads the file again)"], replication: true });
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
const PICKED = {
  secret: { table: "public.accounts", file: FILE, entry: "accounts", columns: null, exclude: ["password_hash"], key: null, addedKey: [], skippedSecrets: ["password_hash"], already: false },
  columns: { table: "public.audit", file: FILE, entry: "audit", columns: ["id", "name"], exclude: [], key: null, addedKey: ["id"], skippedSecrets: [], already: false },
  keyed: { table: "public.event_log", file: FILE, entry: "event_log", columns: null, exclude: [], key: ["tenant_id", "id"], addedKey: [], skippedSecrets: [], already: false },
  already: { table: "public.customers", file: FILE, entry: "customers", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [], already: true },
};
const answer = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

// the copies with their syncs (src/duck/sync.ts Synced), as of 09:05:30: one kept current by the poll 30 s ago, one whose
// poll failed (its copy served as it was), one over the poll's row limit copied 90 s ago
const NOW = Date.parse("2026-10-27T09:05:30.000Z");
const SYNCED = stateOf([{ ...copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), synced: { at: "2026-10-27T09:05:00.000Z", seconds: 0.42, by: "poll" } },
  { ...copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"), phase: "failed", error: "poll: connection reset\nthe sync tries it again in 5 s", synced: { at: "2026-10-27T08:00:09.000Z", seconds: 63, by: "copy" } },
  { ...copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"), unsynced: { reason: "over the poll's row limit", asOf: "2026-10-27T09:04:00.000Z" }, synced: { at: "2026-10-27T09:04:00.000Z", seconds: 754, by: "copy" } }],
  { now: NOW });
const QUERIES = { queries: { keptDays: 3,
  day: { days: 1, covered: 1, statements: 1234, completed: 1200, refused: 30, failed: 3, cancelled: 1, rows: 98_765, bytesSent: 5_400_000, durationMs: { avg: 42, p50: 12, p95: 380 } },
  week: { days: 7, covered: 3, statements: 5000, completed: 4900, refused: 90, failed: 9, cancelled: 1, rows: 400_000, bytesSent: 900, durationMs: { avg: 40, p50: 11, p95: 1_250 } } } };
const EVENT: SyncEvent = { at: "2026-10-27T09:03:10.123Z", kind: "poll_failed", failed: true, table: "public.orders", message: "poll: connection reset\nthe sync tries it again in 5 s" };
const EVENTS = { events: [EVENT, { at: "2026-10-27T09:04:00.000Z", kind: "restart", failed: true, table: null, message: "the run was started again after it stopped" }], keptDays: 7 };
const REQUEST: LedgerRequest = { requestId: "0b9e5c1e-0000-4000-8000-000000000001", startedAt: "2026-10-27T09:02:00.500Z", session: 7, applicationName: "Metabase", tokenName: "", user: "metabase",
  method: "QUERY", outcome: "refused", status: "failed", sqlstate: "42P01", message: "relation \"nope\" does not exist\nLINE 1", detail: null, hint: null, rows: null, durationMs: 3,
  endedAt: "2026-10-27T09:02:00.503Z", bytesSent: 120, query: "SELECT *\n  FROM nope", queryTruncated: false };
const FAILED_REQUESTS = { requests: [REQUEST, { ...REQUEST, requestId: "0b9e5c1e-0000-4000-8000-000000000002", applicationName: "", user: "", outcome: "cancelled", sqlstate: "57014",
  message: "canceling statement due to user request", rows: 10, durationMs: 12_345, query: `SELECT ${"x, ".repeat(60)}1` }], keptDays: 7 };
const USAGE = { since: "2026-10-27T09:04:30.000Z", until: "2026-10-27T09:05:30.000Z", stepSeconds: null, sampleSeconds: 60, keptDays: 7, samples: [],
  copySizes: [{ table: "public.customers", bytes: 524_288, at: "2026-10-27T09:00:00.000Z" }, { table: "public.events", bytes: 3_221_225_472, at: "2026-10-27T09:00:00.000Z" }] };

/** What the Overview reads, in order: the state every poll, the request log's every 30 s. */
const STATUS_READS = ["GET /api/state", "GET /api/queries", "GET /api/events?failed=1&limit=5", "GET /api/requests?failed=1&limit=5", "GET /api/unsupported?limit=100", "GET /api/users"];
/** The Overview's first poll: those, and the last 24 hours of usage its cards' sparklines draw (read once a minute). */
const STATUS_FIRST = [...STATUS_READS, "GET /api/usage?since=24h&step=3600"];
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
    const at = cli.map(([t]) => html.indexOf(`<code>${t}</code>`)).filter((i) => i >= 0);
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

test("a table added and tables removed are said as mason add and mason remove print them: the key added, a secret left out", () => {
  const cli = commands as unknown as { addedLines?: (b: unknown, file: string) => unknown; removedReport?: (r: string[], file: string) => unknown };
  assert.equal(typeof cli.addedLines, "function", "src/cli/commands.ts exports addedLines");
  assert.equal(typeof cli.removedReport, "function", "src/cli/commands.ts exports removedReport");
  const addedLines = fn<[unknown, string], unknown>("addedLines"), removedReport = fn<[string[], string], unknown>("removedReport");
  for (const b of Object.values(PICKED)) assert.deepEqual(addedLines(b, FILE), cli.addedLines!(b, FILE), b.table);
  for (const r of [["public.orders"], ["public.orders", "billing.invoices"]]) assert.deepEqual(removedReport(r, FILE), cli.removedReport!(r, FILE));
  const added = (b: unknown) => textOf(fn<[unknown], string>("renderTableAdded")(b));
  assert.equal(added(PICKED.secret), "Added public.accounts to /app/mason/sources/shop.yml: every column but password_hash " +
    "left out password_hash: it looks like a secret, which anyone with a user's password could read (--include password_hash adds it) Dismiss");
  assert.equal(added(PICKED.columns), "Added public.audit to /app/mason/sources/shop.yml: id, name key added: id (a copy always has its key) Dismiss");
  assert.equal(added(PICKED.keyed), "Added public.event_log to /app/mason/sources/shop.yml: every column, copied by tenant_id, id Dismiss");
  assert.equal(added(PICKED.already), "Added public.customers to /app/mason/sources/shop.yml: every column (already so) Dismiss");
  assert.equal(textOf(fn<[unknown], string>("renderTablesRemoved")({ removed: ["public.orders"], file: FILE })),
    "Removed public.orders from /app/mason/sources/shop.yml Tip: Mason stops copying it and drops its copy Dismiss");
});

test("a demo project's database row says it is the demo database Mason hosts, polled only: the page and mason status alike", () => {
  const sourceRows = (commands as unknown as { sourceRows?: (s: RunState) => Array<[string, string]> }).sourceRows!;
  const DEMO = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z")], { demo: true });
  assert.equal((DEMO.source as { demo?: boolean }).demo, true, "the run's state says it");
  assert.equal((RUNNING.source as { demo?: boolean }).demo, false);
  const rows = sourceRows(DEMO);
  assert.deepEqual(rows.find(([k]) => k === "Database"), ["Database", "the demo database Mason hosts (postgres://demo@127.0.0.1:5434/demo · Postgres 16.4)"]);
  assert.deepEqual(rows.find(([k]) => k === "Changes"), ["Changes", "checked every 5 s (a SELECT of each table's changed rows) · the demo database is checked this way only"]);
  assert.deepEqual(fn<[unknown], unknown>("sourceRows")(DEMO), rows);
});

// ------------------------------------------------------------------ what the page writes

test("running: the database masked, each table copied with its rows, the counts, Ready — and never the engine's name", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { now: NOW, queries: QUERIES, events: EVENTS, requests: FAILED_REQUESTS });
  const text = textOf(html);
  assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
  assert.ok(!text.includes("secret"), "the password is the run's to mask, and it did");
  assert.match(text, /Changes checked every 5 s \(a SELECT of each table's changed rows\) · mason start --replication streams them as they happen instead/);
  assert.match(text, /Tables synced 3 of 3 added/);
  assert.ok(!/Copies not finished|100%/.test(text), "every copy is done: no bar (the Tables page lists them)");
  assert.ok(!text.includes("public.audit"), "a table not added is not a line");
  assert.ok(!/Slow queries|Refused queries|Ready: every added table/.test(text), "the counts and the readiness line repeated the statements, the errors and the word");
  assert.match(html, /<a href="#observability\/queries">Observability › Queries<\/a>/, "the statements are listed on Observability's Queries");
  assert.equal([...html.matchAll(/<table class="facts-table"/g)].length, 1, "ONE table of facts");
  assert.match(html, HEALTH("ok", "Ready"));
  assert.ok(!/duckdb/i.test(html), "the engine is named in the code and the docs, never on the page");
  assert.ok(!/model/i.test(text), "a table is a table");
});

test("copying: the bar's share, the rows, the chunks, the rate and the time left; one waiting; Under way", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(COPYING, {});
  const text = textOf(html);
  assert.match(html, /<tr class="t-copying"><th scope="row"><code>public\.orders<\/code><\/th><td class="bar"><progress class="copybar" max="100" value="15" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="15"/);
  assert.match(text, /public\.orders 15% copying 321,000 of ~2,000,000 rows · 2 chunks reading \(14 s\), 3 of ~20 in · 52,300 rows\/s · ~6 min left/);
  // a copy not begun: its shimmer and its words, never a "0%" beside them (it reads as stuck before it starts)
  assert.match(text, /public\.orders 15% copying .* public\.events waiting for its copy to start/);
  assert.match(html, /<tr class="t-waiting"><th scope="row"><code>public\.events<\/code><\/th><td class="bar"><progress class="copybar indeterminate" max="100" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="public\.events: its copy" aria-valuetext="waiting for its copy to start"><\/progress><\/td>/);
  assert.match(text, /^Under way .* Copies not finished \(2 of 3 added\) Table Copy public\.orders 15% /);
  assert.ok(!/public\.customers/.test(text), "a copy that is done is not a bar");
});

test("failed: its error on its line and in full, the warning, a table not kept current, Failed — and the statements that could not be read", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(FAILED, { queries: { failure: { code: "failed", message: "the request log cannot be read\nmore" } } });
  const text = textOf(html);
  assert.match(text, /public\.orders 100% its copy failed: could not read the next chunk: connection reset/);
  assert.match(html, /<details data-open="error:public\.orders"><summary>the whole error<\/summary><pre>could not read the next chunk: connection reset\nthe sync tries it again in 5 min<\/pre><\/details>/);
  assert.match(text, /public\.events 100% 30,000,000 rows · copied, NOT kept current \(over the poll's row limit; as of 2026-10-27 09:04 UTC\) — mason sync events, or mason start --replication/);
  assert.match(text, /Warning mason\/sources\/shop\.yml: tables\.ordrs: no such table/);
  assert.match(text, /Changes streamed as they happen \(logical replication: slot mason_dev_shop, publication app_pub, named: read as it is, never altered\) · mason start --poll checks every 5 s instead/);
  assert.ok(!/xmin|polling with SELECTs|goes back to polling/.test(text), "how the changes arrive is said in a web developer's words");
  assert.match(text, /Queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
  assert.match(text, /^Failed /);
  assert.match(html, /<tr class="warn"><th scope="row">Warning<\/th>/, "a warning is marked");
});

test("no table added: the commands' sentence, and what adds one", () => {
  assert.match(textOf(fn<[unknown, unknown?], string>("renderStatus")(NONE)), /^No table added yet \(4 in the database\)\. mason tables lists them; mason add <table> copies one\. Mason Source .* Sessions none open$/);
});

test("the tables: each of the database's, added, not added or cannot be added with its reason and no Add; Remove asks first", () => {
  type Ui = { removing?: string | null; choosing?: string | null; columns?: unknown; outcome?: unknown };
  const renderTables = fn<[unknown, Ui?], string>("renderTables");
  const html = renderTables(CATALOG_STATE);
  const text = textOf(html);
  // ONE table: an added table shows its sync columns, one not added its rows and key
  assert.match(text, /^Table State Rows Key Last sync Took Size Note /);
  assert.equal([...html.matchAll(/<table /g)].length, 1, "the added tables are not listed twice");
  assert.match(text, /public\.customers Synced 1,200 key id — Sync Remove public\.orders /);
  assert.equal([...html.matchAll(/<span class="indicator (\w+)"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`).join(", "),
    "ok Synced, ok Synced, ok Synced, unknown Not added, unknown Not added, unknown Not added, unknown Not added", "a state is a dot AND the CLI's word");
  assert.match(html, /^<div class="panel"><table class="catalog">/, "one table, in a card");
  assert.match(text, /public\.audit Not added ~50 rows key id Add Columns… public\.accounts /);
  assert.match(text, /public\.event_log Not added ~900 rows no key cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id \(its unique index event_log_tenant_id_id_key\) Name its key… public\.staging /);
  assert.match(text, /public\.staging Not added rows unknown key id Add Columns… A copy's own size/);
  assert.match(html, /<button type="button" class="small" data-sync-table="public\.customers">Sync<\/button>/);
  assert.ok(!/data-sync-table="public\.(audit|event_log)"/.test(html), "no Sync for a table not added");
  assert.match(html, /<button type="button" class="primary small" data-add-table="public\.audit">Add<\/button>/);
  assert.ok(!/data-add-table="public\.(event_log|customers)"/.test(html), "no Add for a table that cannot be added as it is, nor for one added");
  assert.match(html, /<button type="button" class="danger small" data-remove-table="public\.customers">Remove<\/button>/);
  assert.ok(!/duckdb/i.test(html), "never the engine's name");
  // Remove asks first, on its own line only
  const asking = renderTables(CATALOG_STATE, { removing: "public.customers" });
  assert.match(textOf(asking), /public\.customers Synced 1,200 key id — Sync Remove customers\? Mason stops copying it and drops its copy\. Remove customers Cancel public\.orders /);
  assert.match(asking, /<button type="button" class="danger small" data-confirm-remove-table="public\.customers">Remove customers<\/button>/);
  assert.match(asking, /data-confirm-remove-table="public\.customers"/);
  assert.ok(!/data-confirm-remove-table="public\.orders"/.test(asking), "only the one asked");
  // the form: a table with no primary key ticks its key and its columns, one with a key its columns only
  assert.match(textOf(renderTables(CATALOG_STATE, { choosing: "public.event_log" })), /public\.event_log .* Reading event_log's columns… Cancel public\.staging/, "the form waits for its columns, read when it opens");
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
  // what an add or a remove answered is said under its table; a refusal for a table the list lacks, above the list
  const said = renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", added: PICKED.secret } });
  assert.match(textOf(said), /public\.accounts Not added ~300 rows key id Add Columns… Added public\.accounts to mason\/sources\/shop\.yml: every column but password_hash .* public\.event_log /);
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

test("the users: a row each, active first then removed without Remove; Remove asks first; none is said", () => {
  const renderUsers = fn<[unknown, string | null, number?], string>("renderUsers");
  const list = { users: [{ name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null },
    { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: "2026-10-28T08:15:59.000Z", url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "grafana", id: "fedcba9876543210", addedAt: "2026-10-20T08:00:00.000Z", removedAt: null, live: false, lastUsedAt: null, url: "postgres://grafana@127.0.0.1:5433/shop" }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const NOW_U = Date.parse("2026-10-28T09:15:59.000Z");
  const html = renderUsers(list, null, NOW_U);
  assert.match(textOf(html), /User Status Added Last used URL metabase id 0123456789abcdef Active 2026-10-27 09:10 UTC 60 min ago postgres:\/\/metabase@127\.0\.0\.1:5433\/shop Copy Remove grafana id fedcba9876543210 Active does not connect: the API key was rotated since it was added 2026-10-20 08:00 UTC not used in the last 7 days postgres:\/\/grafana@127\.0\.0\.1:5433\/shop Copy Remove old id aaaaaaaaaaaaaaaa Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC/);
  assert.match(html, /<code id="user-url-metabase" title="postgres:\/\/metabase@127\.0\.0\.1:5433\/shop">postgres:\/\/metabase@127\.0\.0\.1:5433\/shop<\/code> <button type="button" class="small" data-copy="user-url-metabase">Copy<\/button>/);
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
  assert.match(unknown, /Last used: unknown: the request log could not be read \(busy\)\. URL: Mason is not running\.$/);
});

test("a user just added: the password and the URL to paste, each with a copy button, and that it will not be shown again", () => {
  const html = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password: "mason_0123456789abcdef_" + "a".repeat(32),
    database: "shop", url: `postgres://metabase:mason_0123456789abcdef_${"a".repeat(32)}@127.0.0.1:5433/shop`,
    psql: psqlLine(`postgres://metabase:mason_0123456789abcdef_${"a".repeat(32)}@127.0.0.1:5433/shop`), host: "127.0.0.1", port: 5433, sslmode: "disable" });
  const text = textOf(html);
  // the rows mason user add prints, its psql line included, their labels capitalised; each to paste with a Copy
  assert.match(text, /^The user metabase added: its password is shown this once Shown once URL postgres:\/\/metabase:mason_0123456789abcdef_a{32}@127\.0\.0\.1:5433\/shop Copy psql psql postgres:\/\/metabase:mason_0123456789abcdef_a{32}@127\.0\.0\.1:5433\/shop Copy User metabase Password mason_0123456789abcdef_a{32} Copy Database shop Host 127\.0\.0\.1 Port 5433 /);
  assert.match(html, /<code id="added-psql">psql postgres:\/\/metabase:mason_0123456789abcdef_a{32}@127\.0\.0\.1:5433\/shop<\/code> <button type="button" class="small" data-copy="added-psql">Copy<\/button>/);
  // and where its statements will show
  assert.match(text, /Run the psql line, or connect your tool: each statement it sends shows on Observability › Queries \. I have copied it$/);
  assert.match(html, /<a href="#observability\/queries">Observability › Queries<\/a>/);
  assert.match(text, /Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again\./);
  assert.match(html, /<code id="added-password">mason_0123456789abcdef_a{32}<\/code> <button type="button" class="small" data-copy="added-password">Copy<\/button>/);
  assert.match(html, /<span class="badge warn">Shown once<\/span>/, "a clear note that it is shown once");
  assert.match(html, /<button type="button" class="primary" data-dismiss-added="">I have copied it<\/button>/);
  assert.ok(!/ssl mode/.test(text), "disable is said by leaving it out, as mason user add does");
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

// ------------------------------------------------------------------ the app, over a fake fetch

/** A fake run: its answers by method and path, and every request the page made. */
function fakeRun(): { fetch: (p: string, init?: { method?: string; body?: string }) => Promise<Response>; asked: string[]; answers: Map<string, () => Response> } {
  const answers = new Map<string, () => Response>();
  const asked: string[] = [];
  const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  answers.set("GET /api/state", json(COPYING));
  answers.set("GET /api/users", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
  answers.set("GET /api/queries", json(QUERIES));
  answers.set("GET /api/events?failed=1&limit=5", json(EVENTS));
  answers.set("GET /api/requests?failed=1&limit=5", json(FAILED_REQUESTS));
  answers.set("GET /api/usage?since=1m", json(USAGE));
  answers.set("GET /api/running", json({ running: [] }));
  answers.set("GET /api/requests?since=24h", json({ requests: [], keptDays: 7, before: null }));
  for (const p of ["limit=100", "since=1h", "since=24h", "since=7d"]) answers.set(`GET /api/unsupported?${p}`, json({ since: "2026-10-26T09:05:00.000Z", unsupported: [], keptDays: 7 }));
  answers.set("GET /api/users?lastUsed=1", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
  for (const t of ["public.audit", "public.accounts", "public.event_log"]) answers.set(`GET /api/tables/${encodeURIComponent(t)}/columns`, json(columnsOf(t)));
  return {
    asked, answers,
    fetch: async (p, init) => {
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
  assert.match(textOf(v.status!), /public\.orders 15% copying/);
  assert.deepEqual(run.asked, STATUS_FIRST, "the Overview's reads, no other page's");
  assert.equal(v.users, "", "the users are not read while the Overview is shown");
  // the Users page shown: its read alone
  app.show("users");
  run.asked.length = 0;
  await app.poll();
  assert.deepEqual(run.asked, ["GET /api/users?lastUsed=1"]);
  assert.match(textOf(app.view().users!), /^User Status Added Last used URL metabase id 0123456789abcdef Active 2026-10-27 09:10 UTC not used in the last \? days Remove$/);
  app.show("status");
  // the run stops
  run.answers.clear();
  await app.poll();
  v = app.view();
  assert.match(textOf(v.poll!), /^✗ Mason does not answer at this address why the run stopped, or runs on another port now \(fetch failed\) fix mason start/);
  assert.match(textOf(v.status!), /public\.orders 15% copying/, "the last status stays, under the failure");
  clock += 30_000;
  assert.equal(app.view().updated, "Updated 30 s ago", "when it last heard, not now: a run that stopped answering is seen ageing");
  for (const part of Object.values(v)) assert.ok(!/duckdb/i.test(part), "never the engine's name");
});

test("the app: an added user's password is written once, gone once dismissed and never again; a refusal renders the Failure", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST /api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable", next: [] }), { status: 200 }));
  assert.equal(await app.addUser("grafana"), true);
  assert.ok(run.asked.includes(`POST /api/users ${JSON.stringify({ name: "grafana" })}`));
  assert.ok(app.view().added!.includes(password));
  await app.poll();
  assert.ok(app.view().added!.includes(password), "a poll does not take it away before it is copied");
  app.dismissAdded();
  await app.poll();
  assert.ok(Object.values(app.view()).every((part) => !part.includes(password)), "once dismissed, nowhere on the page");
  assert.equal(app.model.added, null, "and not kept");

  run.answers.set("POST /api/users", () => new Response(JSON.stringify({ error: "there is already a user \"grafana\"",
    failure: { code: "refused", message: "there is already a user \"grafana\"", why: "a name names one user", fix: "mason user remove grafana, then mason user add grafana", next: [{ command: "mason user list", what: "the users" }] } }), { status: 409 }));
  assert.equal(await app.addUser("grafana"), false);
  assert.equal(textOf(app.view().action!), "✗ there is already a user \"grafana\" why a name names one user fix mason user remove grafana, then mason user add grafana Next: mason user list the users");
  assert.equal(app.view().added, "");
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends DELETE /api/users/<name> and reads the users again", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  app.askRemove("metabase");
  assert.match(textOf(app.view().users!), /Remove metabase\? It connects no more/);
  app.cancelRemove();
  assert.ok(!/It connects no more/.test(app.view().users!));
  app.askRemove("metabase");
  run.answers.set("DELETE /api/users/metabase", () => new Response(JSON.stringify({ removed: { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z" }, next: [] }), { status: 200 }));
  run.answers.set("GET /api/users?lastUsed=1", () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
  run.asked.length = 0;
  assert.equal(await app.confirmRemove("metabase"), true);
  assert.deepEqual(run.asked, ["DELETE /api/users/metabase", "GET /api/users?lastUsed=1"]);
  assert.equal(textOf(app.view().users!), "No users yet A user is the name and password psql, a BI tool or your app connects with. Add one above, as mason user add <name> does: its URL, password included, is shown once.");
  assert.equal(app.model.confirming, null);
});

test("the app: Add sends POST /api/pick, says what was added under its table, and reads the state again: the copy shows starting", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  run.answers.set("POST /api/pick", () => {
    // the run writes the sources file: from now on its state has the table added
    run.answers.set("GET /api/state", answer(ACCOUNTS_ADDED));
    return answer({ ...PICKED.secret, state: ACCOUNTS_ADDED })();
  });
  run.asked.length = 0;
  assert.equal(await app.addTable("public.accounts"), true);
  assert.deepEqual(run.asked, [`POST /api/pick ${JSON.stringify({ table: "public.accounts", picked: true })}`, "GET /api/state"],
    "every column, as mason add accounts asks; then the state again (the page's own read: nothing else)");
  const v = app.view();
  assert.match(textOf(v.tables!), /public\.accounts Waiting ~300 rows key id — waiting for its copy to start Sync Remove Added public\.accounts to mason\/sources\/shop\.yml: every column but password_hash left out password_hash: it looks like a secret/);
  assert.match(textOf(v.status!), /public\.accounts waiting for its copy to start/, "the Overview shows the copy starting");
  app.dismissOutcome();
  assert.ok(!/Added public\.accounts/.test(app.view().tables!));
});

test("the app: the form sends the columns ticked as columns and the key's as key, nothing when none is ticked", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  run.answers.set("POST /api/pick", answer({ ...PICKED.keyed, state: COPYING }));
  assert.deepEqual(fn<[string, string[]?, string[]?], unknown>("pickBody")("public.audit", [], []), { table: "public.audit", picked: true });
  assert.equal(await app.choose("public.event_log"), true);
  assert.equal(app.model.choosing, "public.event_log");
  assert.deepEqual(run.asked, ["GET /api/tables/public.event_log/columns"], "its columns read once, as the form opens: the state the page polls has none");
  run.asked.length = 0;
  assert.equal(await app.addTable("public.event_log", ["payload"], ["tenant_id", "id"]), true);
  assert.equal(run.asked[0], `POST /api/pick ${JSON.stringify({ table: "public.event_log", picked: true, columns: ["payload"], key: ["tenant_id", "id"] })}`);
  assert.equal(app.model.choosing, null, "added: the form closes");
  run.asked.length = 0;
  await app.addTable("public.event_log", [], ["tenant_id", "id"]);
  assert.equal(run.asked[0], `POST /api/pick ${JSON.stringify({ table: "public.event_log", picked: true, key: ["tenant_id", "id"] })}`, "no column ticked: every column");
});

test("the app: a refusal to add renders the server's Failure under its table, in its words, and the form stays open", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  const message = "public.event_log cannot be added: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id (its unique index event_log_tenant_id_id_key)";
  run.answers.set("POST /api/pick", answer({ error: message, failure: { code: "refused", message, next: [] } }, 409));
  await app.choose("public.event_log");
  run.asked.length = 0;
  assert.equal(await app.addTable("public.event_log"), false);
  assert.deepEqual(run.asked, [`POST /api/pick ${JSON.stringify({ table: "public.event_log", picked: true })}`], "nothing read again: nothing changed");
  const tables = app.view().tables!;
  assert.ok(tables.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
  assert.match(tables, /data-pick-form="public\.event_log"/, "the form stays, to name its key");
  // refused with boxes ticked: the form written again under its refusal keeps them ticked
  await app.addTable("public.event_log", ["payload"], ["id"]);
  assert.deepEqual([...app.view().tables!.matchAll(/name="(key|columns)" value="([^"]*)" checked/g)].map((m) => `${m[1]}=${m[2]}`), ["key=id", "columns=payload"]);
  app.cancelChoose();
  // a sources file the run cannot edit: the server's Failure as it sent it
  const file = "mason/sources/ has 2 source files: one source per project for now";
  run.answers.set("POST /api/pick", answer({ error: file, failure: { code: "refused", message: file, next: [] } }, 409));
  await app.addTable("public.audit");
  assert.match(textOf(app.view().tables!), /public\.audit Not added ~50 rows key id Add Columns… ✗ mason\/sources\/ has 2 source files: one source per project for now public\.accounts/);
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends POST /api/remove and reads the state again", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(ACCOUNTS_ADDED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  app.askRemoveTable("public.accounts");
  assert.match(textOf(app.view().tables!), /Remove accounts\? Mason stops copying it and drops its copy\. Remove accounts Cancel/);
  app.cancelRemoveTable();
  assert.ok(!/Mason stops copying it/.test(app.view().tables!));
  assert.equal(app.model.removing, null);
  app.askRemoveTable("public.accounts");
  run.answers.set("POST /api/remove", () => {
    run.answers.set("GET /api/state", answer(CATALOG_STATE));
    return answer({ removed: ["public.accounts"], file: FILE, state: CATALOG_STATE })();
  });
  run.asked.length = 0;
  assert.equal(await app.confirmRemoveTable("public.accounts"), true);
  assert.deepEqual(run.asked, [`POST /api/remove ${JSON.stringify({ tables: ["public.accounts"] })}`, "GET /api/state"]);
  assert.match(textOf(app.view().tables!), /public\.accounts Not added ~300 rows key id Add Columns… Removed public\.accounts from mason\/sources\/shop\.yml Tip: Mason stops copying it and drops its copy/);
  assert.equal(app.model.removing, null);
  // refused: the server's words
  const message = "shop.yml names no table orders — did you mean `orders`? (it names customers)";
  run.answers.set("POST /api/remove", answer({ error: message, failure: { code: "not_found", message, next: [] } }, 404));
  assert.equal(await app.confirmRemoveTable("public.orders"), false);
  assert.match(textOf(app.view().tables!), /public\.orders .* ✗ shop\.yml names no table orders — did you mean `orders`\? \(it names customers\)/);
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
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("#")), ["data:,", "/app.css", "/vendor/uplot-1.6.32/uPlot.min.css", "/app.js"],
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
    // and dropped from the address; every other part of `location` (search, href) is refused, as the cookie and storage are
    assert.ok(!/\blocation\b(?!\.hash\b)|document\.cookie|localStorage|sessionStorage|indexedDB|[?&]token=|\.token\b/.test(code),
      `${f}: the cookie carries the token; the page's script never reads it, the address (but its hash) or storage`);
    // every module it imports is the page's own, a route of PAGE_ROUTES (tests/cli-run-server.test.ts serves each)
    // (a vendored module keeps its own name: Lucide's icons are .mjs, src/web/vendor/README.md)
    for (const m of code.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)) assert.match(m[1] ?? m[2]!, /^\.\.?\/(?:[\w/.-]+\.js|vendor\/[\w.-]+\/[\w.-]+\.mjs)$/, `${f} imports ${m[1] ?? m[2]} by a relative path`);
  }
});

/** The page in a fake browser: elements whose innerHTML reads back as a browser serialises it (a bare data-x attribute
 *  as data-x="", an apostrophe in text as itself), the listeners `start` adds, the interval it sets, and a FormData
 *  that reads a form's ticked boxes from the fake form. */
function fakeBrowser(run: ReturnType<typeof fakeRun>, hash = "") {
  // an element's attributes, and what holds the focus: a target `{ in: "sidebar" }` is inside the element of that id
  interface FakeEl { id: string; writes: number; html: string; innerHTML: string; attrs: Map<string, string>; addEventListener: () => void;
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
  const location = { hash };
  const onWin = new Map<string, () => void>();
  let tick: (() => void) | null = null;
  class FormData { readonly ticked: Record<string, string[]>; constructor(form: { ticked: Record<string, string[]> }) { this.ticked = form.ticked; } getAll(name: string) { return this.ticked[name] ?? []; } }
  fn<[unknown, unknown], void>("start")(doc, { fetch: (p: string, i?: { method?: string; body?: string }) => run.fetch(p, i), FormData, location, addEventListener: (type: string, f: () => void) => { onWin.set(type, f); },
    setInterval: (f: () => void) => { tick = f; return 1; }, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
  /** the reader follows a link of the nav: the hash changes, and the browser says so */
  const go = (to: string) => { location.hash = to; onWin.get("hashchange")!(); };
  return { el, on, doc, go, tick: () => tick!(), settle: () => new Promise((r) => setTimeout(r, 20)) };
}

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
  assert.equal(open(), false); assert.equal(doc.focused, "");
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
  assert.match(textOf(el("status").html), /public\.orders 15% copying/);
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
  assert.match(textOf(tables.html), /public\.orders Syncing 280,000 key id — 15% copying .* Sync Remove/);
  await on.get("click")!({ target: { closest: () => ({ dataset: { removeTable: "public.orders" } }) } });
  assert.match(textOf(tables.html), /Remove orders\? Mason stops copying it and drops its copy\. Remove orders Cancel/);
  let writes = tables.writes;
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "the tables, unchanged while a copy moves, are not written again: the confirm stays the one clicked");
  // the run reads the catalog again every few seconds, and a live database's row estimates move (pg_class.reltuples)
  const rowsOf = (audit: number) => answer({ ...COPYING, tables: COPYING.tables.map((t) => t.table === "public.audit" ? { ...t, rows: audit } : t) });
  run.answers.set("GET /api/state", rowsOf(350));
  tick(); await settle();
  assert.equal(tables.writes, writes, "rows that moved while a Remove asks do not write the tables again: the confirm stays the one clicked");
  assert.match(textOf(tables.html), /public\.orders Syncing 280,000 key id — 15% copying .* Sync Remove orders\? .* public\.audit Not added ~50 rows key id Add Columns… /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelRemoveTable: "" } }) } });
  assert.match(textOf(tables.html), /public\.audit Not added ~350 rows key id/, "Cancel writes the rows as they are now");
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  assert.match(tables.html, /data-pick-form="public\.audit"/);
  writes = tables.writes;
  tick(); await settle();
  assert.equal(tables.writes, writes, "the form is not written again under the reader's ticks");
  run.answers.set("GET /api/state", rowsOf(700));
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "nor when the rows moved: the ticks stay");
  assert.match(textOf(tables.html), /public\.audit Not added ~350 rows /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelChoose: "" } }) } });
  run.answers.set("GET /api/state", rowsOf(1000));
  writes = tables.writes;
  tick(); await settle();
  assert.ok(tables.writes > writes, "the form cancelled, the next poll writes the tables again");
  assert.match(textOf(tables.html), /public\.audit Not added ~1,000 rows /);
  run.answers.set("GET /api/state", answer(COPYING));
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  // the form submitted: the ticked boxes, as FormData reads them, sent as the columns
  run.answers.set("POST /api/pick", answer({ ...PICKED.columns, state: COPYING }));
  let prevented = false;
  await on.get("submit")!({ target: { dataset: { pickForm: "public.audit" }, ticked: { columns: ["name"] } }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the page posts it, not the browser");
  assert.ok(run.asked.includes(`POST /api/pick ${JSON.stringify({ table: "public.audit", picked: true, columns: ["name"] })}`), run.asked.join("\n"));
  assert.match(textOf(tables.html), /Added public\.audit to mason\/sources\/shop\.yml: id, name key added: id/, "the sources file from the project's root, as mason add names it");
  assert.doesNotMatch(tables.html, /\/app\//, "never an absolute path");
});

// ------------------------------------------------------------------ the shell: a page per hash, each polling its own

test("the shell: a sidebar nav — Overview · Tables · Users, the Observability group's Queries · Usage · Logs — each page a module with a section and a route; every old hash lands on its view", async () => {
  const parseHash = fn<[string | undefined], { id: string; params: Record<string, string> }>("parseHash");
  const hashes = ["#overview", "#tables", "#users", "#observability/queries", "#observability/usage", "#observability/logs", "#observability",
    // the hashes of before the Observability tab: bookmarks keep working
    "#status", "#queries", "#usage", "#logs",
    // none, one unknown, one with parameters
    "", undefined, "#", "#nope", "#Tables", "#tables?show=failed", "#observability/usage?range=7d", "#observability/nope"];
  assert.deepEqual(hashes.map((h) => parseHash(h).id), ["status", "tables", "users", "queries", "usage", "logs", "queries", "status", "queries", "usage", "logs",
    "status", "status", "status", "status", "status", "tables", "usage", "status"]);
  assert.deepEqual(parseHash("#observability/logs?range=1h&failures=1"), { id: "logs", params: { range: "1h", failures: "1" } });
  const hashOf = fn<[string, Record<string, string>?], string>("hashOf");
  assert.deepEqual([hashOf("status"), hashOf("queries"), hashOf("queries", { range: "24h" }), hashOf("usage", { range: "7d" }), hashOf("tables", { show: "failed" })],
    ["#overview", "#observability/queries", "#observability/queries", "#observability/usage?range=7d", "#tables?show=failed"], "the default range is left out of the address");
  const pages = (page as unknown as { PAGES?: Array<{ id: string; title: string; hash?: string; parent?: string; create: unknown }> }).PAGES;
  assert.ok(Array.isArray(pages), "src/web/app.js exports PAGES");
  assert.deepEqual(pages!.map((p) => [p.id, p.title, p.hash ?? p.id, p.parent ?? ""]), [["status", "Overview", "overview", ""], ["tables", "Tables", "tables", ""], ["users", "Users", "users", ""],
    ["queries", "Queries", "observability/queries", "observability"], ["usage", "Usage", "observability/usage", "observability"], ["logs", "Logs", "observability/logs", "observability"]]);
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
    ["Queries", "#observability/queries", false], ["Usage", "#observability/usage", false], ["Logs", "#observability/logs", false]]);
  assert.deepEqual(links(renderNav("logs", "7d")).slice(3), [["Queries", "#observability/queries?range=7d", false], ["Usage", "#observability/usage?range=7d", false],
    ["Logs", "#observability/logs?range=7d", true]], "a view shown is the current page, and its siblings' links keep the range");
  assert.equal([...renderNav("usage").matchAll(/aria-current/g)].length, 1, "one current page, never its group too");
  assert.equal(textOf(renderNav("status")), "Overview Tables Users Observability Queries Usage Logs");
  assert.match(renderNav("status"), /<li class="group"><p class="group-title" id="nav-observability">Observability<\/p><ul aria-labelledby="nav-observability"><li><a href="#observability\/queries">/,
    "the group is a heading over its links' list, which it names");
  // every link carries its icon inline: an SVG in currentColor, hidden from a reader (the label is the link's name)
  const icons = { "#overview": "layout-dashboard", "#tables": "table", "#users": "users", "#observability/queries": "square-terminal", "#observability/usage": "chart-column", "#observability/logs": "logs" };
  for (const m of renderNav("status").matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/gs)) {
    assert.match(m[2]!, new RegExp(`^<span class="icon" aria-hidden="true"><svg\\s+class="lucide lucide-${icons[m[1] as keyof typeof icons]}"[^>]*stroke="currentColor"[^>]*>.*</svg></span><span class="label">\\w+</span>$`, "s"), `${m[1]}: its icon inline, then its label`);
  }
  // the links work before the script runs (which adds their icons): the same links, in the same order, under the same heading
  const staticNav = html.match(/<nav id="nav" class="nav" aria-label="Pages">(.*?)<\/nav>/s)?.[1] ?? assert.fail("index.html has the nav");
  assert.deepEqual(links(staticNav), links(renderNav("none")), "index.html's nav is the nav the script writes, but its icons");
  assert.equal(staticNav, renderNav("none").replace(/<span class="icon" aria-hidden="true">.*?<\/svg><\/span>/gs, ""), "the same markup, so nothing moves when it is written");
  // the head of an Observability view is ONE row: its title left, the range right as a segmented control (the group's
  // name is the sidebar's heading, never a line of its own above the title)
  const renderSubnav = fn<[string, string?], string>("renderSubnav");
  assert.equal(renderSubnav("tables"), "", "a page of its own has none");
  const sub = renderSubnav("usage", "1h");
  assert.equal(textOf(sub), "Last hour 24 hours 7 days");
  assert.equal(sub, `<div class="range" role="group" aria-label="Time range"><a href="#observability/usage?range=1h" aria-current="true">Last hour</a><a href="#observability/usage">24 hours</a><a href="#observability/usage?range=7d">7 days</a></div>`);
  for (const id of ["queries", "usage", "logs"]) {
    assert.match(html, new RegExp(`<div class="page-head"><div class="head-row"><h2 id="${id}-h">\\w+</h2><div id="range-${id}" class="head-range"></div></div>`), `${id}: its title and its range in one row`);
  }
  assert.ok(!html.includes('id="subnav"'), "no head above the view's title");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.nav a\[aria-current="page"\] \{[^}]*background: var\(--line\)/, "the page shown is a filled row of the nav");
  assert.match(css, /\.range a\[aria-current="true"\]/, "the range chosen is the raised segment");
  const app = fn<[unknown], App>("createApp")(fakeRun().fetch);
  assert.match(textOf(app.view()["usage-queries"]!), /Asking Mason/);
  assert.match(textOf(app.view()["logs-events"]!), /Asking Mason/);
});

test("the shell: only the page shown is asked, each endpoint at its own rate — the state every poll, the slower ones when due", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), STATUS_FIRST, "the Overview, first: everything it reads");
  t += 2000;
  assert.deepEqual(await asked(), ["GET /api/state"], "2 s on: the state alone; the request log's are read every 30 s");
  t += 28_000;
  assert.deepEqual(await asked(), STATUS_READS, "30 s on: the request log's again");
  app.show("tables");
  assert.deepEqual(await asked(), ["GET /api/state", "GET /api/usage?since=1m"], "Tables: its own reads");
  t += 2000;
  assert.deepEqual(await asked(), ["GET /api/state"], "the copies' sizes once a minute: they are measured every 10 min");
  app.show("users");
  assert.deepEqual(await asked(), ["GET /api/users?lastUsed=1"]);
  app.show("queries");
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests?since=24h", "GET /api/unsupported?since=24h"],
    "Queries: the statements running, the newest requests and the unsupported SQL of the range (the state, who is connected, was just read by Tables)");
  // the page's own read failing is the banner; a slower one failing is said where it is shown, never as the banner
  app.show("status");
  run.answers.set("GET /api/queries", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  t += 30_000;
  await app.poll();
  assert.equal(app.view().poll, "");
  assert.match(textOf(app.view().status!), /Queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
});

test("in the browser: the hash chooses the section shown and the page asked; a link followed asks the new page at once; a range or an old hash too", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/usage?since=24h&step=3600", answer(USAGE));
  const { el, go, settle, tick } = fakeBrowser(run, "#nope");
  await settle();
  const shown = () => ["status", "tables", "queries", "users", "usage", "logs"].filter((id) => (el(`page-${id}`) as unknown as { hidden: boolean }).hidden === false);
  assert.deepEqual(shown(), ["status"], "an unknown hash shows the Overview");
  const current = () => [...el("nav").html.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
  assert.deepEqual(current(), ["#overview"]);
  assert.equal(el("range-usage").html, "");
  run.asked.length = 0;
  go("#users"); await settle();
  assert.deepEqual(shown(), ["users"]);
  assert.deepEqual(run.asked, ["GET /api/users?lastUsed=1"], "the users at once, not at the next tick");
  assert.deepEqual(current(), ["#users"]);
  run.asked.length = 0;
  tick(); await settle();
  assert.deepEqual(run.asked, [], "the users are read every 30 s, not at every tick");
  // an old bookmark: #usage is Observability › Usage, at the default range
  run.asked.length = 0;
  go("#usage"); await settle();
  assert.deepEqual(shown(), ["usage"]);
  assert.deepEqual(current(), ["#observability/usage"], "an old hash: the view it was is the current page of the nav");
  assert.match(el("range-usage").html, /<a href="#observability\/usage" aria-current="true">24 hours<\/a>/);
  // (its 24 hours are the Overview's read too, shared: read a minute ago, not due again)
  // the range followed: the same view, its samples of the week, six hours a point
  run.answers.set("GET /api/usage?since=7d&step=21600", run.answers.get("GET /api/usage?since=24h&step=3600")!);
  run.asked.length = 0;
  go("#observability/usage?range=7d"); await settle();
  assert.deepEqual((run.asked as string[]).filter((a) => a.includes("/api/usage")), ["GET /api/usage?since=7d&step=21600"]);
  assert.match(el("range-usage").html, /<a href="#observability\/usage\?range=7d" aria-current="true">7 days<\/a>/);
  assert.deepEqual(current(), ["#observability/usage?range=7d"], "the nav's links keep the range");
  // the sub-tab beside it keeps the range: Logs reads the week's events
  run.answers.set("GET /api/events?limit=500&since=7d", answer(EVENTS));
  run.asked.length = 0;
  go("#observability/logs?range=7d"); await settle();
  assert.deepEqual(shown(), ["logs"]);
  assert.deepEqual(run.asked, ["GET /api/events?limit=500&since=7d"]);
});

test("in the browser: no part is written while a pointer is pressed — a row that moves every poll keeps the button under the press", async () => {
  const run = fakeRun();
  const { el, on, settle, tick } = fakeBrowser(run);
  await settle();
  const status = el("status");
  const writes = status.writes;
  await on.get("pointerdown")!({});
  run.answers.set("GET /api/state", answer(RUNNING));
  tick(); await settle();
  assert.equal(status.writes, writes, "pressed: the new state waits");
  assert.match(textOf(status.html), /public\.orders 15% copying/);
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
    run.answers.set("GET /api/state", answer(RUNNING));
    tick(); await settle();
    assert.match(textOf(status.html), /public\.orders 15% copying/, "pressed: the new state waits");
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
  run.answers.set("GET /api/state", answer(SYNCED));
  const a = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(NOW));
  return a.poll().then(() => {
    const html = a.view().status!;
    const text = textOf(html);
    assert.match(html, HEALTH("bad", "Failed"), "the word first: mason status's");
    // the cards first: the copies in all, their rows, the last sync, the copy's file, the last day's statements and p95
    assert.match(text, /^Failed Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 30 s ago 2026-10-27 09:05:00 UTC The copy's file unknown its size could not be read Statements, last day 1,234 1,200 completed, 34 refused, failed or cancelled p95, last day 380 ms average 42 ms · p50 12 ms /);
    assert.match(html, /<a class="card bad link" href="#tables\?show=failed"><p class="card-label">Tables synced<\/p><p class="card-value">2 of 3<\/p><p class="card-sub">added, 1 failed<\/p><\/a>/, "a card: its label, its value, its sub-line — and a link to the failed tables");
    assert.match(text, / Mason Source .* Database postgres:.* Changes checked every /);
    assert.match(text, / Source mason\/sources\/shop\.yml \(the tables it names are added\) Database /, "the sources file from the project's root, as mason status names it");
    assert.doesNotMatch(html, /\/app\//, "never an absolute path");
    assert.match(html, /<caption>Mason<\/caption><tbody><tr><th scope="row">Source<\/th>/, "ONE table of the other facts, each a row headed by its name");
    assert.doesNotMatch(html.slice(html.indexOf("<caption>Mason</caption>")), /<th scope="row">(Tables synced|Rows|Last sync|The copy's file)<\/th>/, "a fact in ONE place: the cards' are not rows too");
    // the statements: a row per window, each count as mason status says it
    assert.match(text, /Statements \(the completed ones' time; mason logs --requests lists each\) Statements Completed Refused Failed Cancelled Average p50 p95 Rows sent Sent /);
    assert.match(text, /Last day 1,234 1,200 30 3 1 42 ms 12 ms 380 ms 98,765 5\.1 MiB Last week 5,000 4,900 90 9 1 40 ms 11 ms 1\.3 s 400,000 900 B /);
    assert.match(text, /The request log keeps 3 days: MASON_REQUEST_LOG_DAYS\./);
    const cliQueries = plain(commands.queryLines(QUERIES.queries as never, PLAIN).join(" "));
    for (const v of ["1,234 statements: 1,200 completed, 30 refused, 3 failed, 1 cancelled", "42 ms / 12 ms / 380 ms", "98,765 rows, 5.1 MiB sent", "400,000 rows, 900 B sent"]) assert.ok(cliQueries.includes(v), `mason status says ${v}`);
    // the database is a row of the facts, the bars only for the copies not finished, no count the errors and statements repeat
    assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
    assert.match(text, /Copies not finished \(2 of 3 added\) Table Copy public\.events 100% .* public\.orders 100% its copy failed: poll: connection reset/);
    assert.ok(!/customers 100%|Slow queries|Refused queries|Ready:|Under way:|Failed:/.test(text));
    // the recent errors: each a table, its cells mason status's line
    assert.match(text, /Sync errors \(the latest, newest last; mason logs --events lists each\) See all At \(UTC\) What Table Why 2026-10-27 09:03:10 poll_failed public\.orders poll: connection reset 2026-10-27 09:04:00 restart \(the sync\) the run was started again after it stopped/);
    assert.match(text, /Query errors \(the latest, newest last; mason logs --requests --failed lists each\) See all Started \(UTC\) Outcome Took Rows Who Statement Error 2026-10-27 09:02:00 refused 3 ms Metabase \(user metabase\) SELECT \* FROM nope relation "nope" does not exist /);
    assert.ok(html.includes('title="SQLSTATE 42P01">refused</td>') && !/\b(42P01|57014)\b/.test(text), "the SQLSTATE is a title, never the page's words");
    assert.match(text, /cancelled 12\.3 s 10 rows \(no application_name\) SELECT (x, )+x… canceling statement due to user request/);
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
    "The copy's file 2.0 MiB", "nothing added: no sync to count, the copy's file alone");
  assert.equal(textOf(renderKpis({ ...SYNCED, engine: { ...SYNCED.engine, bytes: 2_097_152 } }, { now: NOW })), "Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 30 s ago 2026-10-27 09:05:00 UTC The copy's file 2.0 MiB");
  assert.equal(textOf(renderKpis({ ...SYNCED, totals: { ...SYNCED.totals!, syncedAt: null } }, { now: NOW, queries: { failure: { code: "failed", message: "no ledger\nmore" } } })),
    "Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync none yet The copy's file unknown its size could not be read Statements, last day unknown could not read them: no ledger",
    "a fact not read is unknown, with its reason — never 0");
  assert.match(textOf(of<[unknown], string>(statusPage, "status.js", "renderQueries")({ failure: { code: "failed", message: "no ledger" } })), /^Queries: could not read them \(no ledger; mason logs has the detail\)$/);
  // the app with nothing added: the commands' sentence first — no word, no card — then the facts
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(NONE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.match(textOf(app.view().status!), /^Getting started 3 of 4 done .* Add a table .* No table added yet \(4 in the database\)\. .* Mason Source /, "the checklist first: its one action is adding a table");
});

// ------------------------------------------------------------------ the Tables page: each copy's sync, Sync, the search box

test("Tables: each added table's state, rows, last sync and its age, how long it took, its copy's size and error, and Sync", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const html = renderTables(SYNCED, { sizes: USAGE });
  const text = textOf(html);
  assert.match(text, /^Table State Rows Key Last sync Took Size Note /);
  assert.match(text, /public\.customers Synced 1,200 key id 30 s ago 0\.4 s 512\.0 KiB Sync Remove /);
  assert.match(text, /public\.orders Failed ~2,000,000 rows key id 65 min ago 63 s — poll: connection reset the whole error poll: connection reset the sync tries it again in 5 s Sync Remove /);
  assert.match(text, /public\.events Synced 30,000,000 key id 2 min ago 13 min 3\.0 GiB Sync Remove /);
  assert.match(text, /public\.audit Not added ~50 rows key id Add Columns… /, "a table not added has no sync, and is in the same table");
  assert.equal([...html.matchAll(/<table /g)].length, 1);
  // the last sync is an age, its UTC time in a title; rows, age, span and size are mono and right-aligned
  assert.match(html, /<td class="num" title="2026-10-27 09:05:00 UTC">30 s ago<\/td><td class="num" title="changes checked">0\.4 s<\/td><td class="num">512\.0 KiB<\/td>/);
  assert.match(html, /<td class="num">1,200<\/td>/);
  // a failed copy's error is a red line, its whole error in a details
  assert.match(html, /<span class="err">poll: connection reset<\/span><details data-open="error:public\.orders"><summary>the whole error<\/summary><pre>poll: connection reset\nthe sync tries it again in 5 s<\/pre><\/details>/);
  assert.match(html, /<td><span class="indicator bad"><span class="dot" aria-hidden="true"><\/span>Failed<\/span><\/td>/);
  assert.match(html, /<button type="button" class="small" data-sync-table="public\.customers">Sync<\/button>/);
  assert.match(html, /<th scope="row"><code class="name" title="public\.customers">public\.customers<\/code><\/th>/, "a name in mono, cut by the stylesheet, its whole the title");
  // the cells are the commands': the age's and the span's functions, the size's
  const ages = SYNCED.tables.filter((t) => t.added).map((t) => `${commands.duration(t.sync!.ageSeconds!)} ago`);
  for (const a of ages) assert.ok(text.includes(a), a);
  assert.ok(text.includes(commands.fileSize(3_221_225_472)) && text.includes(commands.spanText(0.42)));
  // a sync under a tenth of a second is not worth a digit; one over keeps the commands' span
  const tookText = of<[unknown], string>(tablesPage, "tables.js", "tookText");
  const syncs = [{ syncSeconds: 0.04, syncedBy: "poll" }, { syncSeconds: 0.1, syncedBy: "poll" }, { syncSeconds: 63, syncedBy: "copy" }, { syncSeconds: 2, syncedBy: "catch-up" }, { syncSeconds: 1, syncedBy: "stream" }];
  assert.deepEqual(syncs.map(tookText), ["<0.1 s", "0.1 s", "63 s", "2.0 s", "1.0 s"]);
  const tookTitle = of<[unknown], string>(tablesPage, "tables.js", "tookTitle");
  assert.deepEqual(syncs.map(tookTitle), ["changes checked", "changes checked", "copied whole", "changes checked", "streamed"], "what synced a copy, in plain words, the cell's title");
  // the states, as the run decides them: copying is Syncing, a table not reached Waiting
  assert.match(textOf(renderTables(COPYING, { sizes: USAGE })), /public\.orders Syncing 280,000 .* public\.events Waiting /);
  // the sizes could not be read: said once, the rest shown
  assert.match(textOf(renderTables(SYNCED, { sizes: { failure: { code: "failed", message: "the samples cannot be read" } } })), /The copies' own sizes: could not read them \(the samples cannot be read; mason usage has them\)/);
  assert.ok(!/own size is measured/.test(textOf(renderTables(NONE, { sizes: USAGE }))), "nothing added: no copies to measure");
  // a sync asked: its button says so, no second one
  assert.match(renderTables(SYNCED, { sizes: USAGE, syncing: ["public.customers"] }), /<button type="button" class="small" disabled>Syncing…<\/button>/);
});

test("Tables: what a sync did is said as mason sync says it, under its table; a refusal is the server's Failure", async () => {
  const cli = syncCommand as unknown as { syncedReport?: (b: unknown, picked: string[], unsynced: unknown[]) => unknown };
  assert.equal(typeof cli.syncedReport, "function", "src/cli/sync.ts exports syncedReport");
  const syncedReport = of<[unknown, string[], unknown[]], unknown>(tablesPage, "tables.js", "syncedReport");
  const answered = { at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.events", changed: 1234, deleted: 5, rows: 30_001_229, ms: 8_500 }] };
  for (const picked of [["public.events"], ["public.customers"]]) {
    const named = SYNCED.tables.filter((t) => picked.includes(t.table));
    assert.deepEqual(syncedReport(answered, picked, named), cli.syncedReport!(answered, picked, named));
  }
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(SYNCED));
  const app = fn<[unknown], App>("createApp")(run.fetch) as App & { syncTable(t: string): Promise<boolean>; dismissSynced(): void };
  app.show("tables");
  await app.poll();
  run.answers.set("POST /api/sync", answer(answered));
  run.asked.length = 0;
  assert.equal(await app.syncTable("public.events"), true);
  assert.deepEqual(run.asked, [`POST /api/sync ${JSON.stringify({ tables: ["public.events"] })}`, "GET /api/state"], "mason sync events; then the state again");
  assert.match(textOf(app.view().tables!), /public\.events Synced .* Sync Remove Synced public\.events: 1,234 row\(s\) written, 5 deleted\. public\.events 1,234 changed, 5 deleted, 30,001,229 rows now · 8\.5 s Tip: public\.events is over the poll's row limit: it stays as of this sync until the next mason sync \(mason start --replication keeps every table current\) Dismiss public\.audit /);
  app.dismissSynced();
  assert.ok(!/Synced public\.events:/.test(app.view().tables!));
  const message = "public.orders has no copy yet: it is synced once it is copied";
  run.answers.set("POST /api/sync", answer({ error: message, code: "nothing_yet", failure: { code: "nothing_yet", message, next: [] } }, 409));
  assert.equal(await app.syncTable("public.orders"), false);
  assert.ok(app.view().tables!.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
});

test("Tables: the search box and the state filter narrow the one list, their text kept across polls; a form open keeps its table and its list still", async () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "ORD" })), /^1 with “ORD” in the name Table State Rows Key Last sync Took Size Note public\.orders Synced 2,000,000 key id — Sync Remove /);
  assert.equal(renderTables(CATALOG_STATE, { filter: "" }), renderTables(CATALOG_STATE), "nothing typed: every table, as before");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "zzz", choosing: "public.audit", columns: columnsOf("public.audit") })), /^1 with “zzz” in the name .* public\.audit Not added ~50 rows key id Add Columns… Its columns/, "the table whose form is open stays");
  assert.match(textOf(renderTables(SYNCED, { filter: "nope" })), /No table's name has “nope”\./);
  // All / Added / Not added
  const names = (html: string) => [...html.matchAll(/<th scope="row"><code class="name" title="[^"]*">([^<]*)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "added" })), ["public.customers", "public.orders", "public.events"]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "not-added" })), ["public.audit", "public.accounts", "public.event_log", "public.staging"]);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "not-added", filter: "ORD" })), [], "the name and the state both narrow it");
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "not-added", filter: "acc" })), ["public.accounts"]);
  assert.equal(names(renderTables(CATALOG_STATE, { show: "all" })).length, 7);
  assert.deepEqual(names(renderTables(CATALOG_STATE, { show: "added", choosing: "public.audit" })).includes("public.audit"), true, "a form open stays, whatever the filter says");
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(SYNCED));
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
  run.answers.set("POST /api/sync", () => new Response(JSON.stringify({ at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] })));
  const fetchNow = run.fetch;
  run.fetch = async (p, init) => { if (p === "/api/sync") await answered; return fetchNow(p, init); };
  const click = on.get("click")!({ target: { closest: () => ({ dataset: { syncTable: "public.customers" } }) } });
  await settle();
  assert.match(el("tables").html, /<button type="button" class="small" disabled>Syncing…<\/button>/, "said while it runs");
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
  askCancelStatement(session: number, statement: number): void; dismissCancelStatement(): void; confirmCancelStatement(session: number, statement: number): Promise<boolean>;
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
  assert.match(html, /<td class="num"><time datetime="2026-10-28T09:04:00\.000Z" title="started 2026-10-28 09:04:00 UTC">2 min<\/time><\/td>/);
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
  assert.match(textOf(asking), /Cancel session 12's statement 45\? Its client gets a "canceling statement" error\. Cancel statement 45 Keep it running/);
  assert.match(asking, /data-confirm-cancel="12:45"/);
  assert.match(asking, /<\/tr><tr class="under"><td colspan="8"><span class="confirm" title="SQLSTATE 57014">Cancel session 12's statement 45\?/, "the question on a row of its own under the statement, which keeps its width");
  assert.ok(!/data-confirm-cancel="13:7"/.test(asking), "only the one asked");
  assert.equal(textOf(renderRunning([], null)), "No statement is running now.");
});

test("running now: the answer to a cancel is said under its row, a refusal as the CLI's Failure, and under the table once the statement ended", () => {
  const renderRunning = fn<[unknown[], string | null, unknown], string>("renderRunning");
  const done = renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] });
  assert.match(textOf(done), /Cancel Cancelled session 12's statement: it ends now, and its client gets a "canceling statement" error\. 13 7 /, "under the row it was for");
  const refused = { key: "12:45", failure: { code: "refused", message: "session 12 runs another statement now (statement 46), not statement 45: nothing cancelled", why: "statement 45 ended, and the session began another",
    fix: "mason cancel 12 --statement 46 stops the one it runs now", next: [{ command: "mason logs --running", what: "the statements running now, with their sessions" }] } };
  assert.match(textOf(renderRunning(RUNNING_NOW.slice(0, 1), null, refused)), /^Session No\. .* ✗ session 12 runs another statement now \(statement 46\), not statement 45: nothing cancelled why statement 45 ended, and the session began another fix mason cancel 12 --statement 46 stops the one it runs now Next: mason logs --running the statements running now, with their sessions$/);
  assert.equal(textOf(renderRunning([], null, { key: "12:45", cancelled: RUNNING_NOW[0] })), "No statement is running now. Cancelled session 12's statement: it ends now, and its client gets a \"canceling statement\" error.");
});

test("the request log: a row each, newest first, in the commands' words — held equal to mason logs --requests' line — Older and Newest", () => {
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const html = renderRequests({ requests: REQUESTS, keptDays: 7, before: "2026-10-28T09:00:00.000Z~5" }, { now: Date.parse("2026-10-28T09:05:00.000Z") });
  const text = textOf(html);
  assert.match(text, /^Status Query id Started ↓ Duration ↕ User Client Rows ↕ Statement /, "no Ended or Bytes column: they are in the row's details; Started, Duration and Rows sort, the start newest first");
  assert.match(text, /Cancelled r-new 4 min ago 1 min 30 s metabase \(no application_name\) SELECT pg_sleep\(100\) canceling statement due to user request Completed r-old 5 min ago 1\.2 s ana psql 1 SELECT count\(\*\) FROM orders Older$/);
  assert.equal([...html.matchAll(/<details data-open="request:r-(new|old)"><summary>r-(new|old)<\/summary><\/details>/g)].length, 2, "a details per row, closed, keyed by its request, its id the toggle");
  assert.ok(!/<details[^>]* open/.test(html) && !html.includes("Bytes sent"), "closed: the row's details are not written");
  // the status is a dot AND the word: completed ok, failed bad, cancelled warn
  assert.match(html, /<tr class="s-cancelled"><td><span class="indicator warn"><span class="dot" aria-hidden="true"><\/span>Cancelled<\/span>/);
  assert.match(html, /<tr class="s-completed"><td><span class="indicator ok">/);
  assert.match(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }), /<span class="indicator bad"><span class="dot" aria-hidden="true"><\/span>Failed<\/span>/);
  // started: how long ago, the UTC time its title
  assert.match(html, /<time datetime="2026-10-28T09:01:00.000Z" title="2026-10-28 09:01:00 UTC">/);
  assert.match(renderRequests({ requests: [REQUESTS[0]], keptDays: 7, before: null }, { now: Date.parse("2026-10-28T09:05:00.000Z") }), /<time [^>]*>5 min ago<\/time>/);
  // opened: the expanded row holds the whole id, when it started and ended, the bytes, the whole statement and error
  const opened = textOf(renderRequests({ requests: REQUESTS, keptDays: 7, before: null }, { isOpen: (k: string) => k === "request:r-old" }));
  assert.match(opened, /Completed r-old .* SELECT count\(\*\) FROM orders Query id r-old Started \(UTC\) 2026-10-28 09:00:00 Ended \(UTC\) 2026-10-28 09:00:01 Bytes sent 2\.0 KiB SELECT count\(\*\) FROM orders$/);
  assert.ok(!/Query id r-new/.test(opened), "only the one opened");
  // the id is its first 8 characters, the whole one its title and in the details
  const long = renderRequests({ requests: [{ ...REQUESTS[0], requestId: "0b9e5c1e-0000-4000-8000-000000000001", query: "SELECT\n 1", message: "boom\nline 2", sqlstate: "XX000" }], keptDays: 7, before: null });
  assert.match(long, /<summary>0b9e5c1e<\/summary>/, "the id is its first 8 characters");
  const longOpen = renderRequests({ requests: [{ ...REQUESTS[0], requestId: "0b9e5c1e-0000-4000-8000-000000000001", query: "SELECT\n 1", message: "boom\nline 2", sqlstate: "XX000" }], keptDays: 7, before: null }, { isOpen: () => true });
  assert.match(textOf(longOpen), /Query id 0b9e5c1e-0000-4000-8000-000000000001 Started \(UTC\) 2026-10-28 09:00:00 Ended \(UTC\) 2026-10-28 09:00:01 Bytes sent 2\.0 KiB SELECT 1 XX000 boom line 2/);
  assert.match(longOpen, /<pre class="stmt">SELECT\n 1<\/pre><pre class="error">XX000 boom\nline 2<\/pre>/, "the whole statement and the whole error");
  assert.ok(!html.includes("data-newest"), "the newest page has no Newest");
  for (const r of REQUESTS) {
    const line = commands.requestLine(r as never, PLAIN);
    const words = [commands.msText(r.durationMs), r.query, ...(r.message ? [r.message.split("\n")[0]!] : [])];
    for (const w of words) { assert.ok(line.includes(w), `the CLI's line says ${w}`); assert.ok(text.includes(w), "and so does the page"); }
  }
  assert.match(textOf(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true })), /Failed .* relation "nope" does not exist Newest$/);
  assert.match(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true }), /<div class="paging"><button type="button" data-newest>Newest<\/button><\/div>/);
  assert.match(renderRequests({ requests: [], keptDays: 7, before: null }), /^<div class="empty"><p class="empty-title">No request in the last 7 days \(MASON_REQUEST_LOG_DAYS\)\.<\/p><\/div><p class="dim unlisted">A statement that reads no copied table /,
    "nothing listed and nothing filtered: what the log does not list (a select 1 typed to test the connection), as mason logs --requests says it");
  assert.equal(textOf(renderRequests({ requests: [], keptDays: 1, before: null }, { filtered: true })), "No request that passes the filters in the last 1 day (MASON_REQUEST_LOG_DAYS).");
});

test("the request log's filters: each view has its own path — status as the server's outcomes, since, user, client", async () => {
  const run = fakeRun();
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  const asked = async (f: Record<string, string>) => { run.asked.length = 0; await app.filterRequests(f); return [...run.asked]; };
  run.answers.set("GET /api/requests?outcome=ok&since=24h", answer({ requests: [], keptDays: 7, before: null }));
  run.answers.set("GET /api/requests?outcome=refused%2Cfailed&since=2h&user=ana&client=psql", answer({ requests: [failedRequest], keptDays: 7, before: null }));
  assert.deepEqual(await asked({ status: "completed" }), ["GET /api/requests?outcome=ok&since=24h"], "since is the range's, 24 hours unless the hash says");
  assert.match(textOf(app.view()["request-log"]!), /^No request that passes the filters in the last 24 hours \(the request log keeps 7 days: MASON_REQUEST_LOG_DAYS\)\./);
  assert.deepEqual(await asked({ status: "failed", since: "2h", user: "ana", client: "psql" }), ["GET /api/requests?outcome=refused%2Cfailed&since=2h&user=ana&client=psql"]);
  assert.match(textOf(app.view()["request-log"]!), / relation "nope"/);
  assert.deepEqual(await asked({}), ["GET /api/requests?since=24h"], "cleared: every request of the range again");
});

test("the app: Cancel asks first; the confirm posts { session, statement } and reads the statements again; a 409 renders as its Failure", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/running", answer({ running: RUNNING_NOW }));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.match(textOf(app.view()["running-now"]!), /^Session No\. .* 12 45 .* 13 7 /);
  app.askCancelStatement(12, 45);
  assert.match(textOf(app.view()["running-now"]!), /Cancel session 12's statement 45\? Its client gets a "canceling statement" error/);
  run.asked.length = 0;
  await app.poll();
  assert.match(textOf(app.view()["running-now"]!), /Cancel session 12's statement 45\?/, "a poll keeps the question");
  app.dismissCancelStatement();
  assert.ok(!/Its client gets a/.test(textOf(app.view()["running-now"]!)));
  assert.ok(!run.asked.some((a) => a.startsWith("POST")), "asking posts nothing");
  app.askCancelStatement(12, 45);
  run.answers.set("POST /api/cancel", answer({ cancelled: RUNNING_NOW[0], next: [] }));
  run.answers.set("GET /api/running", answer({ running: RUNNING_NOW.slice(1) }));
  run.asked.length = 0;
  assert.equal(await app.confirmCancelStatement(12, 45), true);
  assert.deepEqual(run.asked, [`POST /api/cancel ${JSON.stringify({ session: 12, statement: 45 })}`, "GET /api/running", "GET /api/state"], "the statements running and who is connected, read again");
  assert.match(textOf(app.view()["running-now"]!), /^Session No\. .* 13 7 .*Cancelled session 12's statement: it ends now/, "the statement ended: said under the table");
  // the session began another statement: the server refuses, and the page renders its Failure under the row
  const failure = { code: "refused", message: "session 13 runs another statement now (statement 8), not statement 7: nothing cancelled", why: "statement 7 ended, and the session began another",
    fix: "mason cancel 13 --statement 8 stops the one it runs now", next: [{ command: "mason logs --running", what: "the statements running now, with their sessions" }] };
  run.answers.set("POST /api/cancel", answer({ error: failure.message, failure }, 409));
  app.askCancelStatement(13, 7);
  assert.equal(await app.confirmCancelStatement(13, 7), false);
  assert.match(textOf(app.view()["running-now"]!), /13 7 .* Cancel ✗ session 13 runs another statement now \(statement 8\), not statement 7: nothing cancelled why statement 7 ended, and the session began another fix mason cancel 13 --statement 8 stops the one it runs now Next: mason logs --running/);
});

test("the app: the newest page is read every 5 s; Older reads the page before with its cursor and stops polling it; Newest returns", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  run.answers.set("GET /api/requests?since=24h", answer({ requests: [REQUESTS[1]], keptDays: 7, before: "CURSOR.1" }));
  run.answers.set("GET /api/requests?since=24h&before=CURSOR.1", answer({ requests: [REQUESTS[0]], keptDays: 7, before: null }));
  const app = fn<[unknown, () => Date], QueriesApp>("createApp")(run.fetch, () => new Date(t));
  app.show("queries");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests?since=24h", "GET /api/state", "GET /api/queries", "GET /api/unsupported?since=24h"],
    "who is connected is the state's `sessions`; the cards' last day is /api/queries; the range's unsupported SQL");
  t += 2000;
  assert.deepEqual(await asked(), ["GET /api/running"], "the statements every 2 s");
  t += 3000;
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests?since=24h", "GET /api/state"], "the newest page and who is connected every 5 s (the last day's summary, every 30 s)");
  assert.ok(textOf(app.view()["request-log"]!).endsWith("Older"));
  run.asked.length = 0;
  await app.olderRequests();
  assert.deepEqual(run.asked, ["GET /api/requests?since=24h&before=CURSOR.1"], "Older asks with the cursor the page answered with");
  assert.match(textOf(app.view()["request-log"]!), /r-old .* Newest$/);
  t += 60_000;
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/state", "GET /api/queries", "GET /api/unsupported?since=24h"], "an older page is never read again while paging");
  await app.newestRequests();
  assert.match(textOf(app.view()["request-log"]!), /r-new .* Older$/);
  t += 5000;
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests?since=24h", "GET /api/state"], "the newest page is polled again");
});

test("the app: a filter the server refuses renders its Failure, not a table: the page validates nothing", async () => {
  const run = fakeRun();
  const failure = { code: "usage", message: "since \"yesterday\" is not a time", fix: "an age (30m, 2h, 7d) or an ISO 8601 date or time with its zone (2026-10-28, 2026-10-28T09:00:00Z)" };
  run.answers.set("GET /api/requests?since=yesterday", answer({ error: failure.message, failure }, 400));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  await app.filterRequests({ since: "yesterday" });
  assert.equal(textOf(app.view()["request-log"]!), `✗ since "yesterday" is not a time fix an age (30m, 2h, 7d) or an ISO 8601 date or time with its zone (2026-10-28, 2026-10-28T09:00:00Z)`);
  assert.ok(!fs.readFileSync(path.join(WEB, "index.html"), "utf8").includes("pattern="), "no input mirrors a server rule");
});

test("in the browser: the filter form filters (blanks are no filter) and Cancel is a click", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/running", answer({ running: RUNNING_NOW }));
  run.answers.set("GET /api/requests?since=24h", answer({ requests: [REQUESTS[1]], keptDays: 7, before: "CURSOR.1" }));
  run.answers.set("GET /api/requests?outcome=cancelled&since=24h&user=metabase", answer({ requests: [REQUESTS[1]], keptDays: 7, before: null }));
  const { el, on, settle } = fakeBrowser(run, "#queries");
  await settle();
  assert.match(textOf(el("running-now").html), /^Session No\. .* 12 45 .* 13 7 /);
  assert.match(textOf(el("request-log").html), /Older$/);
  const form = { id: "request-filters", elements: { status: { value: "cancelled" }, since: { value: " " }, user: { value: "metabase" }, client: { value: "" } } };
  let prevented = false;
  run.asked.length = 0;
  await on.get("submit")!({ target: form, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(run.asked, ["GET /api/requests?outcome=cancelled&since=24h&user=metabase"]);
  assert.ok(!/Older/.test(textOf(el("request-log").html)));
  await on.get("click")!({ target: { closest: () => ({ dataset: { askCancel: "13:7" } }) } });
  assert.match(textOf(el("running-now").html), /Cancel session 13's statement 7\?/);
});

test("the users: read with their last use, every 30 s; Copy puts the URL without the password on the clipboard; Remove sends DELETE", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const U = "GET /api/users?lastUsed=1";
  run.answers.set(U, answer({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: null, url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 }));
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { click(d: unknown, b: unknown, w: unknown): Promise<void> | null }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("users");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), [U, "GET /api/state"], "on opening: its own, and the state for the sidebar (once a minute)");
  t += 2000;
  assert.deepEqual(await asked(), [], "not at the 2 s poll");
  t += 28_000;
  assert.deepEqual(await asked(), [U], "then every 30 s");
  assert.match(textOf(app.view().users!), /metabase id 0123456789abcdef Active 2026-10-27 09:10 UTC never postgres:\/\/metabase@127\.0\.0\.1:5433\/shop Copy Remove old id aaaaaaaaaaaaaaaa Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC$/);
  // Copy: the page's own handler writes the URL as shown, and keeps it nowhere
  const written: string[] = [];
  const doc = { getElementById: (id: string) => id === "user-url-metabase" ? { textContent: "postgres://metabase@127.0.0.1:5433/shop" } : null };
  const win = { navigator: { clipboard: { writeText: async (s: string) => { written.push(s); } } } };
  const button = { textContent: "Copy" };
  await app.pages.get("users")!.click({ copy: "user-url-metabase" }, button, { doc, win });
  assert.deepEqual(written, ["postgres://metabase@127.0.0.1:5433/shop"]);
  assert.equal(button.textContent, "Copied");
  // Remove: asks, then DELETE and the list again with the last use
  app.askRemove("metabase");
  run.answers.set("DELETE /api/users/metabase", answer({ removed: { name: "metabase" }, next: [] }));
  run.asked.length = 0;
  assert.equal(await app.confirmRemove("metabase"), true);
  assert.deepEqual(run.asked, ["DELETE /api/users/metabase", U]);
});

// ------------------------------------------------------------------ the Usage and Logs pages

// read when the tests run: at a commit without the pages the file still loads, and each test fails by name
const usagePage = await import(path.join(WEB, "pages", "usage.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const logsPage = await import(path.join(WEB, "pages", "logs.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
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
  run.answers.set("GET /api/queries", answer(UL_QUERIES));
  run.answers.set("GET /api/usage?since=24h&step=3600", answer(UL_USAGE));
  run.answers.set("GET /api/events?limit=500&since=24h", answer(UL_EVENTS));
  run.answers.set("GET /api/logs?lines=200", answer(LOG));
};

test("Usage: the statements of the last day and week are mason status's words in a table with the windows as columns, and a short log says so", () => {
  const renderQueries = fnOf<[unknown], string>(usagePage, "renderQueries");
  const cli = commands.queryLines(UL_QUERIES.queries as never, PLAIN_STYLE).join("\n");
  const text = textOf(renderQueries(UL_QUERIES.queries));
  assert.match(text, /^Last day Last week Statements 1,204 9 Completed 1,190 1,190 Refused 10 10 Failed 2 2 Cancelled 2 2 Rows 52,000 52,000 Bytes sent 3\.0 MiB 512 B Duration, average \/ p50 \/ p95 \(the completed ones'\) 120 ms \/ 40 ms \/ 900 ms – /);
  // each cell the page re-says is the CLI's, held equal
  for (const piece of ["1,204 statements: 1,190 completed, 10 refused, 2 failed, 2 cancelled", "120 ms / 40 ms / 900 ms", "52,000 rows, 3.0 MiB sent", "512 B sent", "(the request log keeps 3 days: MASON_REQUEST_LOG_DAYS)"]) assert.ok(cli.includes(piece), piece);
  assert.equal(fnOf<[unknown], string>(usagePage, "durationsText")(UL_QUERIES.queries.day.durationMs), "120 ms / 40 ms / 900 ms");
  assert.equal(fnOf<[unknown], string>(usagePage, "coveredText")(UL_QUERIES.queries.week), "the request log keeps 3 days: MASON_REQUEST_LOG_DAYS");
  assert.equal(fnOf<[unknown], string>(usagePage, "coveredText")(UL_QUERIES.queries.day), "", "a window the log covers has no caveat");
  assert.match(text, /Last week: the request log keeps 3 days: MASON_REQUEST_LOG_DAYS/);
  assert.doesNotMatch(text, /Last day: the request log keeps/);
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
  assert.match(text, /Time \(UTC\) ↓ Statements Errors Rows sent Bytes sent p95 Copy Rows Failing Oldest 2026-10-28 10:05 0 98,765 4\.4 MiB – – 12,345,678 – 2026-10-28 09:05 1,204 3 98,765 4\.4 MiB 1\.8 s 5\.0 GiB 12,345,678 1 75 s /);
  assert.match(textOf((renderUsage as unknown as (b: unknown, o?: unknown, s?: unknown) => string)(UL_USAGE, undefined, { key: "time", dir: "asc" })), /Time \(UTC\) ↑ .* Oldest 2026-10-28 09:05 1,204 .* 2026-10-28 10:05 0 /, "oldest first, asked");
  assert.match(html0(), /<th scope="col" aria-sort="descending"><button type="button" class="sort on" data-sort-table="hours" data-sort-key="time">Time \(UTC\)/);
  // the process's memory is not a default column: it is in a closed details of its own
  const html = renderUsage(UL_USAGE);
  assert.doesNotMatch(html.slice(0, html.indexOf("<details")), /Memory|MiB \(copy/, "no memory column in the hours");
  assert.match(html, /<details class="memory" data-open="usage-memory"><summary>Memory<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(text, /Memory Time \(UTC\) Memory 2026-10-28 10:05 900\.0 MiB 2026-10-28 09:05 900\.0 MiB \(copy 300\.0 MiB of 8\.0 GiB\)/);
  assert.doesNotMatch(text, /Lag/, "no lag column without a stream");
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [{ ...SAMPLE, streamLagSeconds: 3, streamLagBytes: 10 }] })), /Oldest Lag 2026-10-28 09:05 .* 75 s 3 s Memory Time \(UTC\) Memory 2026-10-28 09:05 900/);
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [] })), /No sample in this time: Mason takes the first a minute after it starts\./);
  const sizes = textOf(fnOf<[unknown], string>(usagePage, "renderCopySizes")(UL_USAGE.copySizes));
  assert.match(sizes, /^Measured every 10 min\. Table Size Measured at \(UTC\) public\.orders 3\.0 GiB 09:00 public\.customers 39\.1 KiB 09:00$/);
  assert.equal(usagePage.SIZE_EVERY_SECONDS as unknown, (await import("../src/duck/usage.ts")).SIZE_EVERY_MS / 1000, "as often as src/duck/usage.ts measures");
  assert.match(textOf(fnOf<[unknown], string>(usagePage, "renderCopySizes")([])), /No copy measured yet/);
});

test("Usage: reads the day and week, and the 24 hours an hour a line, every 60 s and only while shown; a refusal is the CLI's Failure", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("usage");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET /api/queries", "GET /api/usage?since=24h&step=3600", "GET /api/state"], "its own, and the sidebar's state");
  const v = app.view();
  assert.match(textOf(v["usage-queries"]!), /Statements 1,204/);
  assert.match(textOf(v["usage-hourly"]!), /2026-10-28 09:05 1,204 3/);
  assert.match(textOf(v["usage-sizes"]!), /public\.orders 3\.0 GiB/);
  t += 2000; assert.deepEqual(await asked(), [], "2 s on: nothing is due");
  t += 58_000; assert.deepEqual(await asked(), ["GET /api/queries", "GET /api/usage?since=24h&step=3600", "GET /api/state"], "60 s on: both again (and the sidebar's state, a minute old)");
  app.show("status"); assert.deepEqual((await asked()).includes("GET /api/queries"), false, "not while another page is shown");
  // the hours refused (a step the run does not take): the server's Failure, said once under the hours; the first read's is the banner
  app.show("usage");
  const refusal = { error: "step is a whole number of seconds", failure: { code: "usage", message: "step is a whole number of seconds", why: "too short", fix: "mason usage --step 1h", next: [{ command: "mason usage --help", what: "the spans it takes" }] } };
  run.answers.set("GET /api/usage?since=24h&step=3600", answer(refusal, 400));
  t += 60_000; await app.poll();
  const w = app.view();
  assert.match(textOf(w["usage-hourly"]!), /^✗ step is a whole number of seconds why too short fix mason usage --step 1h Next: mason usage --help the spans it takes /, "the Failure, then the last hours it knew");
  assert.doesNotMatch(textOf(w["usage-sizes"]!), /✗/, "said once");
  assert.equal(w.poll, "", "the queries read answered");
  run.answers.set("GET /api/queries", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  t += 60_000; await app.poll();
  assert.match(textOf(app.view().poll!), /✗ the request log cannot be read/);
  assert.match(textOf(app.view()["usage-queries"]!), /Statements 1,204/, "the last counts stay under the banner");
});

test("Logs: the sync's events are mason logs --events' lines in a table, a failure marked, NEWEST FIRST (When turns it round); none is said as the CLI says it", () => {
  const renderEvents = fnOf<[unknown, Record<string, unknown>?], string>(logsPage, "renderEvents"), cells = fn<[unknown], Record<string, string>>("eventCells");
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
  assert.match(timeline, /<time datetime="2026-10-28T09:00:00.000Z" title="2026-10-28 09:00:00 UTC">10 min ago<\/time>/, "how long ago, the UTC time as the command prints it its title");
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
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 })), "No sync event in the last 7 days (MASON_REQUEST_LOG_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 }, { span: "the last hour" })), "No sync event in the last hour (the events are kept 7 days: MASON_REQUEST_LOG_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 1 })), "No sync event in the last 1 day (MASON_REQUEST_LOG_DAYS).");
});

test("Logs: the run's entries are rows, NEWEST FIRST, a multi-line entry kept as one preformatted row", () => {
  const renderLogs = fnOf<[unknown], string>(logsPage, "renderLogs");
  const html = renderLogs(LOG);
  assert.equal([...html.matchAll(/<div class="log-line">/g)].length, 2, "two entries, two lines");
  assert.ok(html.indexOf("mason started") > html.indexOf("copy: public.orders"), "the newest at the top");
  assert.match(html, /<pre>copy: public\.orders\n {2}chunk 3 of 20 &lt;read&gt;<\/pre>/);
  assert.match(html, /^<div class="terminal" role="log">/, "a terminal's lines");
  assert.match(textOf(html), /^copy: public\.orders chunk 3 of 20 <read> 2026-10-28 09:00:00 mason started The last 2 of at most 2000 entries the run keeps, newest first/);
  assert.match(textOf(renderLogs({ lines: [], kept: 2000 })), /The run has logged nothing yet\./);
});

test("Logs: the events every 10 s; the run's raw log sits behind a closed details and is read, every 5 s, only while it is open; a refusal is its Failure under it", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App & { showRawLog(open: boolean): Promise<void> }>("createApp")(run.fetch, () => new Date(t));
  app.show("logs");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET /api/events?limit=500&since=24h", "GET /api/state"], "closed: the log is not read (the state is the sidebar's)");
  assert.match(textOf(app.view()["logs-events"]!), /✗ copy_failed/);
  const closed = app.view()["logs-run"]!;
  assert.equal(closed, `<details id="logs-raw"><summary>The run's raw log (for debugging)</summary></details>`);
  assert.doesNotMatch(closed, /mason started/, "the entries are not written while it is closed");
  t += 10_000; assert.deepEqual(await asked(), ["GET /api/events?limit=500&since=24h"], "10 s on: still the events alone");
  // opened: the log is read at once, then every 5 s
  run.asked.length = 0;
  await app.showRawLog(true);
  assert.deepEqual(run.asked, ["GET /api/logs?lines=200"]);
  assert.match(app.view()["logs-run"]!, /^<details id="logs-raw" open><summary>The run's raw log \(for debugging\)<\/summary>/);
  assert.match(textOf(app.view()["logs-run"]!), /mason started/);
  t += 2000; assert.deepEqual(await asked(), [], "2 s on: neither is due");
  t += 3000; assert.deepEqual(await asked(), ["GET /api/logs?lines=200"], "5 s on: the log alone");
  t += 5000; assert.deepEqual(await asked(), ["GET /api/events?limit=500&since=24h", "GET /api/logs?lines=200"], "10 s on: both");
  app.show("usage"); assert.deepEqual((await asked()).some((p) => p.includes("/api/logs")), false, "not while another page is shown");
  app.show("logs");
  run.answers.set("GET /api/logs?lines=200", answer({ error: "lines is a whole number of log entries, 1 to 2000", failure: { code: "failed", message: "lines is a whole number of log entries, 1 to 2000", next: [] } }, 400));
  t += 10_000; await app.poll();
  assert.match(textOf(app.view()["logs-run"]!), /^The run's raw log \(for debugging\) ✗ lines is a whole number of log entries, 1 to 2000 copy: public\.orders .* 2026-10-28 09:00:00 mason started/);
  assert.equal(app.view().poll, "");
  // closed again: no read
  await app.showRawLog(false);
  t += 10_000; assert.deepEqual(await asked(), ["GET /api/events?limit=500&since=24h"]);
  run.answers.set("GET /api/events?limit=500&since=24h", answer({ error: "no", failure: { code: "failed", message: "the events cannot be read", next: [] } }, 500));
  t += 10_000; await app.poll();
  assert.match(textOf(app.view().poll!), /✗ the events cannot be read/);
});

test("in the browser: opening the raw log's details reads it at once, closing it stops the reads", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  const { el, on, go, settle, tick } = fakeBrowser(run);
  await settle();
  go("#logs"); await settle();
  assert.ok(!run.asked.some((a) => a.includes("/api/logs")), "closed: not read");
  // the browser opens the details and says so (the event does not bubble: the shell hears it on the way down)
  const toggle = on.get("toggle")!;
  run.asked.length = 0;
  await toggle({ target: { id: "logs-raw", open: true } });
  assert.deepEqual(run.asked, ["GET /api/logs?lines=200"]);
  assert.match(el("logs-run").html, /<details id="logs-raw" open>/);
  assert.match(textOf(el("logs-run").html), /mason started/);
  // the toggle the page's own rewrite causes (the same state) and another details's change nothing
  run.asked.length = 0;
  await toggle({ target: { id: "logs-raw", open: true } });
  await toggle({ target: { id: "other", open: true } });
  assert.deepEqual(run.asked, []);
  await toggle({ target: { id: "logs-raw", open: false } });
  assert.equal(el("logs-run").html, `<details id="logs-raw"><summary>The run's raw log (for debugging)</summary></details>`);
  run.asked.length = 0;
  tick(); await settle();
  assert.ok(!(run.asked as string[]).some((a) => a.includes("/api/logs")), "closed again: not read");
});

test("Logs: a closed raw log has nothing inside to read", () => {
  const renderRawLog = fnOf<[boolean, string], string>(logsPage, "renderRawLog");
  assert.match(renderRawLog(false, "<p>x</p>"), /^<details id="logs-raw"><summary>The run's raw log \(for debugging\)<\/summary><\/details>$/);
  assert.match(renderRawLog(true, "<p>x</p>"), /^<details id="logs-raw" open><summary>.*<\/summary><p>x<\/p><\/details>$/);
});

test("Usage and Logs: the index.html has the parts the pages write, the placeholders' parts are gone", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const id of ["usage-queries", "usage-hourly", "usage-sizes", "logs-events", "logs-run", "connected-now", "running-now", "tables"]) assert.match(html, new RegExp(`<div id="${id}"></div>`), id);
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
  assert.match(text, /Changes streamed as they happen \(logical replication: slot mason_dev_shop, publication app_pub/);
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
    const want = cli.diskRows(d).map(([k, v]) => [k, v.replace(` free in ${D}`, " free where the copy is")]);
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
  assert.match(text, /Disk 1\.0 GiB free where the copy is · the copies running are projected to add about 4\.0 GiB more — more than is free/);
  assert.match(text, /Sessions 5 open, 1 running a statement · 2 as metabase \(Metabase\), 1 by a token, 1 as ana \(psql\), and 1 other client/);
  assert.match(html, /<tr class="warn"><th scope="row">Disk<\/th>/);
  assert.ok(!text.includes(D) && !/duckdb/i.test(text));
  const { disk: _d, sessions: _s, ...older } = RUNNING as unknown as Record<string, unknown> & { engine: Record<string, unknown> };
  const bare = { ...older, engine: { name: older.engine.name, file: older.engine.file, bytes: older.engine.bytes, pollSeconds: older.engine.pollSeconds } };
  assert.doesNotMatch(textOf(renderFacts(bare, NOW)), /Mason \d|Restarts|Disk|Sessions/, "a run that says none of it: nothing");
  assert.match(textOf(renderFacts(RUNNING, NOW)), /Mason \S+ · one process/, "the run's own state says them (runState)");
  assert.match(textOf(renderFacts({ ...RUNNING, sessions: { error: "no listener\nmore" } } as never, NOW)), /Sessions could not be read: no listener/);
});

test("Queries: who is connected now — a row per user and client with its open sessions and what it runs; none is said, an error is unknown", async () => {
  const renderSessions = fn<[unknown], string>("renderSessions");
  const sessions = { open: 3, byClient: [{ user: "metabase", client: "Metabase v0.50", open: 2, running: 1 }, { user: "", client: "", open: 1, running: 0 }] };
  assert.equal(textOf(renderSessions(sessions)), "User Client Open Running metabase Metabase v0.50 2 1 (no user) (no application_name) 1 0 3 sessions open.");
  assert.equal(textOf(renderSessions({ open: 0, byClient: [] })), "No client is connected now.");
  assert.equal(textOf(renderSessions({ error: "the listener is closed\nmore" })), "Who is connected could not be read (the listener is closed)");
  assert.equal(renderSessions(undefined), "", "a run that does not say it: nothing");
  const run = fakeRun();
  run.answers.set("GET /api/state", answer({ ...COPYING, sessions }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.match(textOf(app.view()["connected-now"]!), /^User Client Open Running metabase /);
});

test("Tables: in replication mode each added table's stream state is a column, in the commands' words; polling has none", () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const st = REPL(STREAM, {}) as unknown as { stream: typeof STREAM };
  const html = renderTables(st, { now: NOW });
  const text = textOf(html);
  assert.match(text, /Took Size Stream Note /);
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
  assert.match(users, /<form id="add-user" class="formcard"[^>]*>[\s\S]*<button type="submit" class="primary">Add a user<\/button>/);
  assert.ok(users.indexOf('id="add-user"') < users.indexOf('id="added"') && users.indexOf('id="added"') < users.indexOf('id="users"'), "the form, the password just shown, the users");
});

test("Tables: the cards are the tables added of all, those synced, those failed and the copies' rows; none before there is a table", () => {
  const cardsOf = of<[unknown], string>(tablesPage, "tables.js", "renderTablesCards");
  const tot = SYNCED.totals!;
  assert.equal(textOf(cardsOf(SYNCED)), `Tables added 3 of 4 in the database Synced ${tot.copied} of 3 added Failed ${tot.failed} of 3 added Rows ${tot.rows.toLocaleString("en-US")} in the copies`);
  assert.match(cardsOf(SYNCED), /<div class="card bad"><p class="card-label">Failed<\/p>/, "a failed copy colours its card");
  assert.doesNotMatch(cardsOf(RUNNING), /card bad/);
  assert.equal(cardsOf({ ...NONE, tables: [] }), "");
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(SYNCED));
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
  run.answers.set("GET /api/state", answer(SYNCED));
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
  assert.equal(app.pages.get("tables")!.toggle!({ id: "logs-raw", open: true }), null, "a details with no key is not this page's");
});

test("Users: the add form's password is a prominent card marked shown once; the active users come first, a removed one muted last, and the age ticks with the page's clock", async () => {
  const added = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password: "mason_0123456789abcdef_" + "a".repeat(32),
    database: "shop", url: "postgres://metabase@127.0.0.1:5433/shop" });
  assert.match(added, /^<div class="added" role="status"><p class="headline">The user metabase added: its password is shown this once <span class="badge warn">Shown once<\/span><\/p>/);
  assert.equal([...added.matchAll(/data-copy="/g)].length, 2, "the URL and the password each have a Copy");
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  run.answers.set("GET /api/users?lastUsed=1", answer({ users: [{ name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null },
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
  run.answers.set("GET /api/state", answer(stateOf([], { demo: true })));
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
  assert.match(html, /<section id="page-status" aria-labelledby="status-h">\s*<div class="page-head"><h2 id="status-h">Overview<\/h2><p class="desc">Mason copies the tables you add from your Postgres, keeps them current, and answers analytics SQL at a Postgres URL of its own\. Here: whether the copy is ready, how to connect, and what it answered — what <code>mason status<\/code> says\.<\/p>/, "the Overview says what Mason is first, then that it is mason status's");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /--sidebar-w: 232px/, "the sidebar's width, a token");
  assert.match(css, /@media \(min-width: 641px\) and \(max-width: 999px\) \{\s*\.sidebar \{ width: var\(--rail-w\); \}/, "below 1000 px an icon rail");
  assert.match(css, /\.nav a:hover \.label, \.nav a:focus-visible \.label \{ opacity: 1; \}/, "on the rail a label is its icon's tooltip, on hover and on focus");
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.sidebar \{ position: sticky;/, "a phone: a top bar");
  assert.match(css, /\.sidebar\[data-open\] \.side-body \{ display: flex; \}/, "whose menu opens the nav as a sheet");
  assert.match(css, /@media \(prefers-color-scheme: dark\)/, "a dark theme from the system's");
  assert.equal([...css.matchAll(/@font-face/g)].length, 2, "Geist Sans and Geist Mono, each its own face");
  assert.doesNotMatch(css, /gradient\(/, "no gradient");
});

test("the vendored files: each a route, whole, pinned in its folder's name, with its licence beside it, listed in the README", async () => {
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts") as { PAGE_ROUTES: Record<string, readonly [string, string]> };
  const vendor = webFiles().filter((f) => f.startsWith(`vendor${path.sep}`)).map((f) => f.split(path.sep).join("/")).sort();
  assert.deepEqual(vendor, ["vendor/README.md", "vendor/geist-1.7.2/Geist-Variable.woff2", "vendor/geist-1.7.2/GeistMono-Variable.woff2", "vendor/geist-1.7.2/LICENSE.txt",
    "vendor/lucide-1.56.0/LICENSE.txt", "vendor/lucide-1.56.0/chart-column.mjs", "vendor/lucide-1.56.0/layout-dashboard.mjs", "vendor/lucide-1.56.0/logs.mjs",
    "vendor/lucide-1.56.0/menu.mjs", "vendor/lucide-1.56.0/square-terminal.mjs", "vendor/lucide-1.56.0/table.mjs", "vendor/lucide-1.56.0/users.mjs", "vendor/lucide-1.56.0/x.mjs",
    "vendor/uplot-1.6.32/LICENSE.txt", "vendor/uplot-1.6.32/uPlot.esm.js", "vendor/uplot-1.6.32/uPlot.min.css"]);
  const types: Record<string, string> = { woff2: "font/woff2", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };
  for (const f of vendor) assert.deepEqual(PAGE_ROUTES[`/${f}`], [f, types[f.split(".").pop()!]], `${f} is a route of its type`);
  const readme = fs.readFileSync(path.join(WEB, "vendor", "README.md"), "utf8");
  const folders = [...new Set(vendor.filter((f) => f.split("/").length === 3).map((f) => f.split("/")[1]!))];
  for (const d of folders) {
    assert.match(d, /^[a-z]+-\d+\.\d+\.\d+$/, `${d}: the package and its exact version`);
    assert.ok(fs.existsSync(path.join(WEB, "vendor", d, "LICENSE.txt")), `${d} carries its licence`);
    assert.ok(readme.includes(`\`${d}/\``), `the README lists ${d}`);
  }
  assert.match(fs.readFileSync(path.join(WEB, "vendor", "geist-1.7.2", "LICENSE.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
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
  run.answers.set("GET /api/requests?since=24h", answer({ requests: REQUESTS, keptDays: 7, before: null }));
  run.answers.set("GET /api/usage?since=24h&step=3600", answer(UL_USAGE));
  run.answers.set("GET /api/state", answer(FAILED));
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
  assert.equal(app.pages.get("queries")!.toggle!({ id: "logs-raw", open: true }), null, "a details with no key is not this page's");
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
  run.answers.set("GET /api/state", answer(FAILED));
  const { el, on, tick, settle } = fakeBrowser(run);
  await settle();
  await on.get("toggle")!({ target: { dataset: { open: "error:public.orders" }, open: true } });
  await settle();
  assert.match(el("status").html, /data-open="error:public\.orders" open>/);
  const writes = el("status").writes;
  run.answers.set("GET /api/state", answer({ ...FAILED, warnings: ["mason/sources/shop.yml: tables.other: no such table"] }));
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
  assert.match(drawn, /<div class="chart spark" data-chart="rows" role="img" aria-label="Rows copied, the last 24 hours an hour a point"><\/div>/);
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

// ------------------------------------------------------------------ the restyled Queries, Usage and Logs pages (docs/WEB-UI.md "Presentation")

const queriesModule = await import(path.join(WEB, "pages", "queries.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;

test("Queries: the cards say the sessions, what runs now and the last day's statements, the failed ones and p95; an unreadable fact is unknown with its reason", () => {
  const kpis = fnOf<[unknown, unknown, unknown], string>(queriesModule, "renderQueryKpis");
  const sessions = { open: 3, byClient: [{ user: "metabase", client: "Metabase v0.50", open: 2, running: 1 }, { user: "", client: "", open: 1, running: 0 }] };
  assert.equal(textOf(kpis(sessions, RUNNING_NOW, QUERIES)),
    "Connected sessions 3 2 clients Running now 2 the longest for 2 min Statements, last 24 hours 1,234 1,200 completed Failed, last 24 hours 33 30 refused, 3 failed, 1 cancelled p95, last 24 hours 380 ms average 42 ms · p50 12 ms");
  assert.match(kpis(sessions, [], QUERIES), /Running now<\/p><p class="card-value">0<\/p><p class="card-sub">no statement is running<\/p>/);
  assert.match(kpis(sessions, [], QUERIES), /<div class="card warn"><p class="card-label">Failed, last 24 hours/, "a failure colours the one to act on");
  assert.equal(textOf(kpis({ error: "the listener is closed\nmore" }, undefined, { failure: { code: "failed", message: "no ledger\nmore" } })),
    "Connected sessions unknown the listener is closed Statements, last 24 hours unknown could not read them: no ledger");
  assert.equal(kpis(undefined, undefined, undefined), "", "what the run did not say draws no card");
  assert.equal(textOf(kpis(undefined, undefined, { queries: { keptDays: 3, day: { ...QUERIES.queries.day, durationMs: null } } })).includes("p95, last 24 hours – no statement completed"), true);
});

test("Queries: the page reads the last day's summary every 30 s for its cards, and writes them with the sessions and the running", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  run.answers.set("GET /api/running", answer({ running: RUNNING_NOW }));
  run.answers.set("GET /api/queries", answer(QUERIES));
  run.answers.set("GET /api/state", answer({ ...COPYING, sessions: { open: 1, byClient: [{ user: "ana", client: "psql", open: 1, running: 0 }] } }));
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("queries");
  assert.match(textOf(app.view()["queries-kpis"]!), /Asking Mason/, "before any read");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.ok((await asked()).includes("GET /api/queries"));
  assert.match(textOf(app.view()["queries-kpis"]!), /^Connected sessions 1 1 client Running now 2 .* Statements, last 24 hours 1,234 /);
  t += 5000; assert.ok(!(await asked()).includes("GET /api/queries"), "not at 5 s");
  t += 25_000; assert.ok((await asked()).includes("GET /api/queries"), "30 s on");
});

test("Usage: the cards are the last 24 hours with a sparkline each where two hours can be drawn; their numbers are text either way", () => {
  const kpis = fnOf<[unknown, unknown], string>(usagePage, "renderUsageKpis"), specs = fnOf<[unknown], Record<string, { kind: string; x: number[]; y: Array<number | null> }>>(usagePage, "usageSpecs");
  const plain = kpis(UL_QUERIES, undefined), drawn = kpis(UL_QUERIES, UL_USAGE);
  assert.equal(textOf(plain), "Statements, last 24 hours 1,204 1,190 completed Failed, last 24 hours 12 10 refused, 2 failed, 2 cancelled p95, last 24 hours 900 ms average 120 ms · p50 40 ms Rows sent, last 24 hours 52,000 Bytes sent, last 24 hours 3.0 MiB");
  assert.equal(textOf(drawn), textOf(plain), "the same words with the charts as without");
  assert.deepEqual([...drawn.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1]), ["usage-spark-statements", "usage-spark-failed", "usage-spark-rows", "usage-spark-bytes"], "no sparkline for one hour of p95");
  assert.deepEqual(specs(UL_USAGE)["usage-spark-failed"]!.y, [3, 0], "the failed ones are the samples' refused and failed");
  assert.deepEqual(specs(undefined), {}); assert.deepEqual(specs({ failure: {} }), {});
});

test("Usage: four charts of the hours — statements as bars, p95, the copy's size and its rows as lines — each its own series, its numbers the hours' table", () => {
  const specs = fnOf<[unknown], Record<string, { kind: string; label: string; x: number[]; y: Array<number | null>; format(v: number): string }>>(usagePage, "usageSpecs");
  const renderCharts = fnOf<[unknown], string>(usagePage, "renderCharts"), renderUsage = fnOf<[unknown, ((k: string) => boolean)?], string>(usagePage, "renderUsage");
  assert.deepEqual(Object.keys(specs(UL_USAGE)).filter((k) => !k.includes("spark")), ["usage-statements", "usage-copy-rows"], "p95 and the copy's size have one value in two hours: no trend, no chart");
  const s = specs({ ...UL_USAGE, samples: [SAMPLE, { ...IDLE, copyBytes: 6 * 2 ** 30, durationP95Ms: 40 }] });
  assert.deepEqual(Object.keys(s).filter((k) => !k.includes("spark")), ["usage-statements", "usage-p95", "usage-copy-bytes", "usage-copy-rows"], "in the page's order");
  assert.equal(s["usage-p95"]!.format(1830.4), "1.8 s");
  assert.equal(s["usage-statements"]!.kind, "bars"); assert.deepEqual(s["usage-statements"]!.y, [1204, 0]);
  assert.equal(s["usage-copy-bytes"]!.kind, "line"); assert.equal(s["usage-copy-bytes"]!.format(3 * 2 ** 30), "3.0 GiB", "a value as the tables say it");
  assert.deepEqual(s["usage-copy-rows"]!.y, [12_345_678, 12_345_678]);
  assert.deepEqual(s["usage-statements"]!.x, [Date.parse(SAMPLE.at) / 1000, Date.parse(IDLE.at) / 1000]);
  const html = renderCharts(UL_USAGE);
  assert.deepEqual([...html.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1]), ["usage-statements", "usage-copy-rows"]);
  assert.match(html, /<div class="chart-card"><p class="card-label" title="Statements an hour">Statements an hour<\/p><div class="chart series" data-chart="usage-statements" role="img" aria-label="Statements an hour, the last 24 hours"><\/div><\/div>/);
  // a series with one value is no trend: its card says the value, so the grid keeps its four cards
  assert.match(textOf(html), /p95 duration One sample so far: 1\.8 s\. A chart needs two\./);
  assert.match(textOf(html), /Size of the copy One sample so far: 5\.0 GiB\. A chart needs two\./);
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
  assert.match(textOf(app.view()["usage-kpis"]!), /^Statements, last 24 hours 1,204 /);
  assert.match(app.view()["usage-charts"]!, /data-chart="usage-copy-rows"/);
  assert.equal(app.pages.get("usage")!.toggle({ dataset: { open: "usage-hours" }, open: true }), true);
  await app.poll();
  assert.match(app.view()["usage-hourly"]!, /data-open="usage-hours" open>/);
  const keys = [...Object.keys(app.pages.get("usage")!.charts()), ...Object.keys(app.pages.get("status")!.charts?.() ?? {})];
  assert.equal(new Set(keys).size, keys.length, "a chart key is one holder's in the whole document");
});

test("Logs: 'Failures only' narrows the events read, in the page alone; the events' kinds are badges and their times how long ago", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.parse("2026-10-28T09:10:00.000Z");
  const app = fn<[unknown, () => Date], App & { pages: Map<string, { input(t: unknown): unknown }> }>("createApp")(run.fetch, () => new Date(t));
  app.show("logs");
  await app.poll();
  assert.match(textOf(app.view()["logs-events"]!), /^When ↓ Kind Table Message 5 min ago ✗ restart .* ✗ copy_failed .* 10 min ago copied public\.orders/);
  // the kind and table filters: their choices are the kinds and tables read
  assert.equal(textOf(app.view()["logs-filters"]!), "Kind Every kind copied copy_failed restart Table Every table (the sync) public.events public.orders");
  assert.equal(app.pages.get("logs")!.input({ id: "logs-kind", value: "copy_failed" }), true);
  assert.match(app.view()["logs-filters"]!, /<option value="copy_failed" selected>/);
  assert.match(textOf(app.view()["logs-events"]!), /^1 of the 3 events read\. When ↓ Kind Table Message 9 min ago ✗ copy_failed/);
  app.pages.get("logs")!.input({ id: "logs-kind", value: "" });
  run.asked.length = 0;
  assert.equal(app.pages.get("logs")!.input({ id: "logs-failures-only", checked: true }), true);
  assert.doesNotMatch(textOf(app.view()["logs-events"]!), /copied public\.orders/);
  assert.match(textOf(app.view()["logs-events"]!), /✗ copy_failed/);
  assert.deepEqual(run.asked, [], "the page alone: nothing is asked");
  assert.equal(app.pages.get("logs")!.input({ id: "somewhere-else", checked: true }), null, "another input is not this page's");
  app.pages.get("logs")!.input({ id: "logs-failures-only", checked: false });
  assert.match(textOf(app.view()["logs-events"]!), /copied public\.orders/);
  t += 60_000; await app.poll();
  assert.match(textOf(app.view()["logs-events"]!), /11 min ago/, "the ages move with the clock");
});

test("Queries, Usage and Logs: the index.html carries the parts the restyled pages write — a header each, the filter toolbar, the failures toggle", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const id of ["queries-kpis", "usage-kpis", "usage-charts"]) assert.match(html, new RegExp(`<div id="${id}"></div>`), id);
  for (const [id, title] of [["queries-h", "Queries"], ["usage-h", "Usage"], ["logs-h", "Logs"]]) assert.match(html, new RegExp(`<div class="page-head"><div class="head-row"><h2 id="${id}">${title}</h2><div id="range-${title!.toLowerCase()}" class="head-range"></div></div><p class="desc">`), `${title}'s header`);
  assert.match(html, /<form id="request-filters" class="toolbar"[^>]*>[\s\S]*<button type="submit" class="primary">Filter<\/button>\s*<button type="button" data-clear-filters>Clear<\/button>/);
  assert.match(html, /<input type="checkbox" id="logs-failures-only"> Failures only/);
  const view = (ids: string[]) => ids.every((id) => html.includes(`id="${id}"`));
  assert.ok(view(["queries-kpis", "connected-now", "running-now", "request-log", "usage-kpis", "usage-charts", "usage-queries", "usage-hourly", "usage-sizes", "logs-events", "logs-run"]));
});

// ------------------------------------------------------------------ Observability: the shared range, sorts, filters, and large data

type ObsApp = QueriesApp & { pages: Map<string, { input?(t: unknown): unknown; click?(d: Record<string, string>, b: unknown, env: unknown): unknown; route?(p: Record<string, string>, env: unknown): unknown }>; sortRequests(key: string): void };

test("the shared range: each Observability view reads its span — the request log's since, the samples' window and step, the events' since — and only the view shown reads", async () => {
  const run = fakeRun();
  const empty = { requests: [], keptDays: 7, before: null };
  for (const r of ["1h", "24h", "7d"]) {
    run.answers.set(`GET /api/requests?since=${r}`, answer(empty));
    run.answers.set(`GET /api/events?limit=500&since=${r}`, answer(EVENTS));
  }
  for (const [since, step] of [["1h", 60], ["24h", 3600], ["7d", 21_600]]) run.answers.set(`GET /api/usage?since=${since}&step=${step}`, answer({ ...USAGE, stepSeconds: step }));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], ObsApp>("createApp")(run.fetch, () => new Date(t));
  const asked = async (hash: string) => { app.show(hash); t += 120_000; run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.ok((await asked("#observability/queries?range=1h")).includes("GET /api/requests?since=1h"), "Queries: the last hour's requests");
  assert.ok((await asked("#observability/usage?range=1h")).includes("GET /api/usage?since=1h&step=60"), "Usage: the hour, a minute a point");
  assert.deepEqual(await asked("#observability/logs?range=1h"), ["GET /api/events?limit=500&since=1h", "GET /api/state"], "Logs: the hour's events, and nothing of the other views (the state is the sidebar's, once a minute)");
  assert.ok((await asked("#observability/usage?range=7d")).includes("GET /api/usage?since=7d&step=21600"), "the week, six hours a point");
  assert.ok((await asked("#observability/usage")).includes("GET /api/usage?since=24h&step=3600"), "no range: the 24 hours");
  // a page of its own keeps the range it does not use; going back to a sub-tab with no range is the default again
  app.show("#tables"); assert.equal(app.model.range, "24h");
  app.show("#observability/logs?range=7d"); app.show("#users"); assert.equal(app.model.range, "7d", "the range is Observability's: Users leaves it");
  app.show("#observability/logs?range=nonsense"); assert.equal(app.model.range, "24h", "an unknown range is the default");
  // each view says its span: the cards, the empty log, the empty events
  app.show("#observability/queries?range=7d"); t += 120_000; await app.poll();
  assert.match(textOf(app.view()["queries-kpis"]!), /Statements, last 7 days 5,000 /, "the week's cards are the summary's week");
  assert.match(textOf(app.view()["request-log"]!), /No request in the last 7 days \(the request log keeps 7 days/);
  app.show("#observability/queries?range=1h");
  assert.match(textOf(app.view()["queries-kpis"]!), /Statements, last 24 hours 1,234 /, "the summary has no hour: the hour's cards say the day, by name");
});

test("Queries: Slow (1 s or more) and Statement has are the request log's slow and search, composing with the rest; the Overview's links land on them", async () => {
  const { SLOW_MS } = await import("../src/cli/request-filter.ts");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.match(html, new RegExp(`<input type="checkbox" id="rq-slow" name="slow"> Slow \\(${SLOW_MS / 1000} s or more\\)</label>`), "the label is SLOW_MS's");
  assert.match(html, /<input id="rq-search" name="search" type="search" maxlength="200"/);
  const requestsPath = fnOf<[Record<string, unknown>, string | null, string?], string>(queriesModule, "requestsPath");
  assert.equal(requestsPath({ status: "failed", slow: true, search: "from orders", user: "ana" }, null, "1h"), "/api/requests?outcome=refused%2Cfailed&since=1h&user=ana&slow=1&search=from+orders");
  assert.equal(requestsPath({ since: "2026-10-28" }, "C~1", "1h"), "/api/requests?since=2026-10-28&before=C%7E1", "a since of its own is used instead of the range");
  const run = fakeRun();
  run.answers.set("GET /api/requests?since=24h&slow=1", answer({ requests: [REQUESTS[0]], keptDays: 7, before: null }));
  run.answers.set("GET /api/requests?outcome=refused%2Cfailed&since=24h", answer({ requests: [failedRequest], keptDays: 7, before: null }));
  const app = fn<[unknown], ObsApp>("createApp")(run.fetch);
  // the Overview's p95 card leads to the slow ones; its query errors to the failed ones; the form shows each
  const form = { elements: { status: { value: "" }, slow: { checked: false } } };
  const doc = { getElementById: (id: string) => id === "request-filters" ? form : null };
  app.show("#observability/queries?slow=1", { doc });
  assert.equal(form.elements.slow.checked, true, "the box is ticked");
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET /api/requests?since=24h&slow=1"), run.asked.join("\n"));
  app.show("#observability/queries?status=failed", { doc });
  assert.deepEqual([form.elements.status.value, form.elements.slow.checked], ["failed", false]);
  run.asked.length = 0; await app.poll();
  assert.ok(run.asked.includes("GET /api/requests?outcome=refused%2Cfailed&since=24h"));
  app.show("#observability/queries?range=7d");
  assert.equal((app.pages.get("queries") as unknown as { model: { filters: { status: string } } }).model.filters.status, "failed", "a change of range keeps the filters");
  // the form's slow box and search field are sent
  run.answers.set("GET /api/requests?since=7d&slow=1&search=sum%28", answer({ requests: [], keptDays: 7, before: null }));
  const submitted = { id: "request-filters", elements: { status: { value: "" }, since: { value: "" }, user: { value: "" }, client: { value: "" }, slow: { checked: true }, search: { value: " sum( " } } };
  run.asked.length = 0;
  await (app.pages.get("queries") as unknown as { submit(f: unknown): Promise<void> }).submit(submitted);
  assert.deepEqual(run.asked, ["GET /api/requests?since=7d&slow=1&search=sum%28"]);
  assert.match(textOf(app.view()["request-log"]!), /No request that passes the filters/);
  // the Overview's cards are links into the views that list what they count
  const html2 = renderStatusOf(FAILED);
  for (const [label, href] of [["Tables synced", "#tables?show=failed"], ["Rows", "#tables"], ["The copy&#39;s file", "#observability/usage"], ["Statements, last day", "#observability/queries"], ["p95, last day", "#observability/queries?slow=1"]]) {
    assert.match(html2, new RegExp(`<a class="card[^"]*" href="${href!.replace(/[?]/g, "\\?")}"><p class="card-label">${label!.replace(/[()]/g, "\\$&")}</p>`), `${label} → ${href}`);
  }
  assert.match(html2, /Sync errors .*<a class="see" href="#observability\/logs\?failures=1">See all<\/a>/);
  assert.match(html2, /Query errors .*<a class="see" href="#observability\/queries\?status=failed">See all<\/a>/);
});
const renderStatusOf = (s: RunState) => fn<[unknown, Record<string, unknown>], string>("renderStatus")(s, { queries: QUERIES, events: EVENTS, requests: FAILED_REQUESTS, now: NOW });

test("Tables: #tables?show=failed is the Failed filter — the failed copies alone — and the select says so", async () => {
  const app = fn<[unknown], ObsApp>("createApp")(fakeRun().fetch);
  const select = { value: "all" };
  app.show("#tables?show=failed", { doc: { getElementById: (id: string) => id === "tables-show" ? select : null } });
  assert.equal(select.value, "failed");
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  const names = (html: string) => [...html.matchAll(/<th scope="row"><code class="name" title="[^"]*">([^<]*)<\/code>/g)].map((m) => m[1]);
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
  run.answers.set("GET /api/requests?since=24h", answer(page3));
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
  run.answers.set("GET /api/state", answer(big));
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
    if (p.startsWith("/api/requests")) {
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
  const renderEvents = fnOf<[unknown, Record<string, unknown>?], string>(logsPage, "renderEvents");
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
  assert.match(htmls[1]!, /<span class="confirm">Remove orders\?.*<\/span> <button type="button" class="danger small" data-confirm-remove-table="public\.orders">Remove orders<\/button>/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /button\.small \{ height: 28px;/);
  assert.match(css, /\.confirm ~ button\.danger \{ background: var\(--bad\); color: var\(--surface\)/, "the confirm of a destructive action is filled red");
  assert.match(css, /button\.primary \{ background: var\(--fg\)/);
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

test("Queries: the unsupported SQL of the range is mason status's lines (unsupportedLines), each entry named by docs/SQL-SUPPORT.md, read once a minute", async () => {
  const entry = fn<[unknown], { headline: string; last: string; how: string; example: string }>("unsupportedEntry");
  for (const g of UNSUPPORTED.unsupported) {
    const [, head, last, how] = commands.unsupportedLines([g], PLAIN);
    const e = entry(g);
    assert.equal(e.headline, head!.trim(), "the first line is mason status's: what they used, how many, who");
    assert.equal(`${e.last} — ${e.example}`, last!.trim(), "the second too: when, the latest on a line");
    assert.equal(e.how, how!.trim(), "the third too: where the way out is");
  }
  const render = fnOf<[unknown, string?], string>(queriesModule, "renderUnsupported");
  const html = render(UNSUPPORTED, "the last 7 days");
  assert.match(textOf(html), /^The statements refused in the last 7 days by the SQL they used that Mason does not support, the most first\. a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase last 2026-10-28 08:59 — SELECT sum/);
  assert.match(textOf(html), /SQL this Mason no longer lists: 1 statement last 2026-10-28 07:00 — SELECT 1 How to rewrite it: see docs\/SQL-SUPPORT\.md › SQL this Mason no longer lists$/);
  assert.match(textOf(html), /How to rewrite it: see docs\/SQL-SUPPORT\.md › a window frame in GROUPS mode/);
  assert.ok(html.includes('title="docs/SQL-SUPPORT.md entry frame-groups"') && !textOf(html).includes("frame-groups"), "the registry id is a title, never the words");
  assert.ok(html.includes(`title="${UNSUPPORTED.unsupported[0]!.example}"`), "the whole statement is its title");
  assert.ok(!textOf(html).includes(UNSUPPORTED.unsupported[0]!.example), "the line has it cut, as mason status cuts it");
  assert.equal(textOf(render({ ...UNSUPPORTED, unsupported: [] }, "the last hour")), "No statement refused for unsupported SQL in the last hour (the request log keeps 7 days: MASON_REQUEST_LOG_DAYS).");
  assert.match(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), /<h3>Unsupported SQL<\/h3>\s*<div id="unsupported"><\/div>/);
  // the app: the shared range's since, once a minute, and its failure said where it shows
  const run = fakeRun();
  run.answers.set("GET /api/unsupported?since=7d", answer(UNSUPPORTED));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("#observability/queries?range=7d");
  await app.poll();
  assert.ok(run.asked.includes("GET /api/unsupported?since=7d"), "the range's since");
  assert.match(textOf(app.view().unsupported!), /^The statements refused in the last 7 days .* a window frame in GROUPS mode: 12 statements/);
  run.asked.length = 0; t += 2000; await app.poll();
  assert.ok(!run.asked.some((a) => a.startsWith("GET /api/unsupported")), "not every poll: once a minute");
  t += 60_000; await app.poll();
  assert.ok(run.asked.includes("GET /api/unsupported?since=7d"), "a minute on, again");
  run.answers.set("GET /api/unsupported?since=1h", answer({ error: "the request log cannot be read" }, 500));
  app.show("#observability/queries?range=1h"); await app.poll();
  assert.match(textOf(app.view().unsupported!), /^✗ the request log cannot be read/, "a failure is said in its part, as the Failure");
});

test("the Overview: the last day's unsupported SQL is one line of the recent errors, with See all, and nothing when there is none", async () => {
  const runServer = await import("../src/cli/run-server.ts") as { MAX_UNSUPPORTED_LIMIT?: number };
  assert.equal(statusPage.UNSUPPORTED_LIMIT as unknown, runServer.MAX_UNSUPPORTED_LIMIT, "it reads every entry the endpoint answers, to count them");
  const line = of<[unknown], string>(statusPage, "status.js", "renderUnsupportedLine");
  const html = line(UNSUPPORTED);
  assert.equal(textOf(html), "Unsupported SQL, the last day: a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase (and 1 other) See all");
  assert.match(html, /<a class="see" href="#observability\/queries">See all<\/a>/);
  assert.equal(line({ ...UNSUPPORTED, unsupported: [] }), "", "none: no line");
  assert.equal(line(undefined), "", "not read yet: nothing");
  assert.equal(textOf(line({ failure: { code: "failed", message: "no ledger\nmore" } })), "Unsupported SQL: could not read it (no ledger; mason logs has the detail)", "as mason status says it");
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(RUNNING));
  run.answers.set("GET /api/unsupported?limit=100", answer(UNSUPPORTED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.ok(run.asked.includes("GET /api/unsupported?limit=100"), "the Overview reads the last day's, the endpoint's default");
  assert.match(textOf(app.view().status!), /Query errors .* Unsupported SQL, the last day: a window frame in GROUPS mode: 12 statements as ana, metabase from Metabase \(and 1 other\) See all$/);
});

// ------------------------------------------------------------------ a table just added shows its copy at once

/** The state with public.accounts added and its copy as given (null: not started). */
const accountsCopy = (c: Partial<CopyState> | null, more: CopyState[] = []): RunState => stateOf([...THREE_COPIED(), ...(c ? [{ source: "public.accounts", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, ...c } as CopyState] : []), ...more],
  { tables: CATALOG, sources: withAccounts });
const withShare = (share: number, o: Partial<CopyProgressView> = {}): Partial<CopyState> => ({ rowsSoFar: Math.round(300 * share), rowsEstimate: 300, progress: { ...progress, share, ...o } });
const accountsRow = (html: string): string => html.split("<tr").find((r) => r.includes("<code class=\"name\" title=\"public.accounts\">")) ?? "";

test("Add: the row says Adding… from the click, then waiting for its copy, then the bar with the % and mason wait's words, never backwards, until served", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = fn<[unknown], App>("createApp")(async (p: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && p === "/api/pick") await gate;
    return run.fetch(p, init);
  });
  app.show("tables");
  await app.poll();
  run.answers.set("POST /api/pick", () => { run.answers.set("GET /api/state", answer(accountsCopy(null))); return answer(PICKED.secret)(); });
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
  assert.match(textOf(row), /public\.accounts Waiting ~300 rows key id — waiting for its copy to start/);
  assert.match(row, /<progress class="copybar indeterminate" max="100" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="public\.accounts: its copy" aria-valuetext="waiting for its copy to start"><\/progress>/);
  assert.ok(!/aria-valuenow/.test(row), "waiting: no value, an indeterminate bar");
  // copying 37%: the bar's value, the aria, and the words mason wait prints (copyingText, held equal)
  const at37 = accountsCopy(withShare(0.37));
  run.answers.set("GET /api/state", answer(at37));
  await app.poll();
  row = accountsRow(app.view().tables!);
  const c37 = at37.tables.find((t) => t.table === "public.accounts")!;
  const words = `copying ${commands.copyingText(c37.copy!.rowsCopied, c37.rows, c37.copy!.progress as CopyProgressView).text}`;
  assert.match(row, /<progress class="copybar" max="100" value="37" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="37" aria-label="public\.accounts: its copy" aria-valuetext="37%, /);
  assert.match(textOf(row), /37% copying 41,111 rows · past the ~300 estimated · 2 chunks reading \(14 s\), 3 of ~20 in · 52,300 rows\/s · ~6 min left/);
  assert.ok(textOf(row).includes(words), "the words are copyingText's, held equal to the CLI's");
  // the Overview draws the same bar from the same renderer
  const bar = row.match(/<progress[^>]*><\/progress> <span class="pct">37%<\/span>/)![0];
  assert.ok(app.view().status!.includes(bar), "one renderer: the Overview's bar is the Tables row's");
  // a state that says less (a share that went back) is not drawn backwards
  run.answers.set("GET /api/state", answer(accountsCopy(withShare(0.2))));
  await app.poll();
  assert.match(accountsRow(app.view().tables!), /value="37" .*37%/, "never backwards");
  // further on, it moves again, only with the server's data
  run.answers.set("GET /api/state", answer(accountsCopy(withShare(0.8))));
  await app.poll();
  assert.match(accountsRow(app.view().tables!), /value="80" .*80%/);
  assert.match(textOf(app.view()["tables-cards"]!), /Synced 3 of 4 added, 1 copying/);
  // served: its normal sync state, no bar
  run.answers.set("GET /api/state", answer(accountsCopy({ phase: "copied", rows: 300, bytes: 1, seconds: 2, copiedAt: "2026-10-27T09:06:00.000Z", synced: { at: "2026-10-27T09:06:00.000Z", seconds: 2, by: "copy" } } as Partial<CopyState>)));
  await app.poll();
  row = accountsRow(app.view().tables!);
  assert.ok(!/<progress/.test(row), "served: the bar is gone");
  assert.match(textOf(row), /public\.accounts Synced 300 key id/);
  // a copy that fails shows its error as the other failures do, no bar
  run.answers.set("GET /api/state", answer(accountsCopy({ phase: "failed", error: "could not read the next chunk: connection reset" })));
  await app.poll();
  row = accountsRow(app.view().tables!);
  assert.match(row, /<span class="err">could not read the next chunk: connection reset<\/span>/);
  assert.ok(!/<progress/.test(row));
  // after a failure its next copy begins at its own share, not the last one's
  run.answers.set("GET /api/state", answer(accountsCopy(withShare(0.05))));
  await app.poll();
  assert.match(accountsRow(app.view().tables!), /value="5" .*5%/);
});

test("Add: several tables in a row each show their own state; a refused add leaves no Adding…; the cards count the copying", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  const both = stateOf([...THREE_COPIED(), { source: "public.accounts", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, ...withShare(0.5) } as CopyState],
    { tables: CATALOG, sources: parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n  accounts: {}\n  audit: {}\n", "shop", "/app/mason/sources/shop.yml") as typeof sourceFile });
  run.answers.set("POST /api/pick", () => { run.answers.set("GET /api/state", answer(both)); return answer(PICKED.secret)(); });
  await app.addTable("public.accounts");
  await app.addTable("public.audit");
  const v = app.view();
  assert.match(textOf(accountsRow(v.tables!)), /50% copying/);
  assert.match(textOf(v["tables-cards"]!), /Synced 3 of 5 added, 1 copying/);
  assert.match(textOf(v.status!), /1 copying/, "the Overview's cards say it too");
  // refused: no Adding… stays
  run.answers.set("POST /api/pick", answer({ error: "no", failure: { code: "refused", message: "no", next: [] } }, 409));
  assert.equal(await app.addTable("public.staging"), false);
  assert.ok(!/Adding…/.test(app.view().tables!));
});

// ------------------------------------------------------------------ Connect: how a first-time user gets to a first statement

/** The request log's summary of a run nothing has asked anything yet. */
const NO_QUERIES = { queries: { keptDays: 7, day: { ...QUERIES.queries.day, statements: 0, completed: 0, refused: 0, failed: 0, cancelled: 0, rows: 0, bytesSent: 0, durationMs: null },
  week: { ...QUERIES.queries.week, covered: 7, statements: 0, completed: 0, refused: 0, failed: 0, cancelled: 0, rows: 0, bytesSent: 0, durationMs: null } } };
/** Where this run's Postgres API listens, as mason status prints it (src/cli/pg-url.ts): the panel is held equal to it. */
// read by name, so this file loads at a commit without it (scripts/fails-without.ts) and each test fails by name
const SHOP_PG = (pgUrl as { postgresFacts?: (u: string) => { shown: string; psql: string } }).postgresFacts?.("postgresql://127.0.0.1:5433/shop")
  ?? { shown: "postgres://<user>:<password>@127.0.0.1:5433/shop", psql: "psql 'postgres://<user>:<password>@127.0.0.1:5433/shop'" };

test("the Overview, nothing asked yet: Connect your first tool under the cards — the URL and psql line mason status prints, each with Copy, and Create a user", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { queries: NO_QUERIES, now: NOW });
  const text = textOf(html);
  assert.equal(SHOP_PG.shown, "postgres://<user>:<password>@127.0.0.1:5433/shop", "the line mason start and mason status print");
  assert.match(text, new RegExp(`Connect your first tool Mason answers SQL over the Postgres protocol, as a read replica of your database would: point psql, a BI tool or your app's analytics code at this URL\\. ` +
    `URL ${SHOP_PG.shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Copy psql ${SHOP_PG.psql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Copy ` +
    "Then try select count\\(\\*\\) from customers; Copy it shows on Queries " +
    "Create a user Its name and password go in place of <user>:<password> : the Users page shows the whole URL once, as mason user add <name> prints it\\. Mason Source "));
  assert.match(html, /<code id="connect-try">select count\(\*\) from customers;<\/code> <button type="button" class="small" data-copy="connect-try">Copy<\/button>/,
    "a first statement that the request log lists: one that reads a copied table (the first copied), never a select 1 it does not");
  // first under the cards, before the facts: the most important thing on a fresh install is how to reach it
  assert.ok(text.indexOf("Connect your first tool") > text.indexOf("p95, last day") && text.indexOf("Connect your first tool") < text.indexOf("Mason Source"));
  assert.match(html, /<code id="connect-url">postgres:\/\/&lt;user&gt;:&lt;password&gt;@127\.0\.0\.1:5433\/shop<\/code> <button type="button" class="small" data-copy="connect-url">Copy<\/button>/);
  assert.match(html, /<code id="connect-psql">psql &#39;postgres:\/\/&lt;user&gt;:&lt;password&gt;@127\.0\.0\.1:5433\/shop&#39;<\/code> <button type="button" class="small" data-copy="connect-psql">Copy<\/button>/);
  assert.match(html, /<a class="btn primary" href="#users">Create a user<\/a>/, "a link to the page that makes one");
});

test("the Overview once statements ran: Connect after the facts, quieter; with no table added, none (adding one is the step)", () => {
  const busy = textOf(fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { queries: QUERIES, now: NOW }));
  assert.ok(!busy.includes("Connect your first tool"));
  assert.match(busy, /Sessions none open Connect URL postgres:\/\/<user>:<password>@127\.0\.0\.1:5433\/shop Copy psql /, "after the facts table");
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
  assert.match(textOf(renderRequests(empty, { span: "the last 24 hours", connect })), /^No request in the last 24 hours \(the request log keeps 7 days: MASON_REQUEST_LOG_DAYS\)\. A statement that reads no copied table \(select 1, SET, SHOW, a BI tool's catalog queries\) is answered but not listed\. Connect your first tool .* Create a user /);
  assert.equal((page as Record<string, unknown>).UNLISTED_STATEMENTS, commands.UNLISTED_STATEMENTS, "the page says what mason logs --requests says");
  assert.ok(fs.readFileSync(path.join(WEB, "index.html"), "utf8").includes(`${commands.UNLISTED_STATEMENTS}.`), "and the request log's lead says it over a log that has rows");
  assert.ok(!textOf(renderRequests(empty, { span: "the last 24 hours", connect, filtered: true })).includes("Connect"), "a filter that passes none is not a fresh install");
  // the app: the Queries page renders it from /api/state's postgres
  const run = fakeRun();
  run.answers.set("GET /api/state", () => new Response(JSON.stringify(RUNNING), { status: 200 }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.match(textOf(app.view()["request-log"]!), /^No request in the last 24 hours .* Connect your first tool .* URL postgres:\/\/<user>:<password>@127\.0\.0\.1:5433\/shop Copy .* Then try select count\(\*\) from customers; Copy /);
});

test("a Copy button, on any page: its code's text to the clipboard, Copied for 2 s then Copy; with no clipboard, the text selected and copied as a selection, else what to press", async () => {
  const copyClick = fn<[Record<string, string>, { textContent: string; dataset?: Record<string, string> }, unknown], Promise<void> | null>("copyClick");
  assert.equal((page as Record<string, unknown>).COPIED_MS, 2000);
  const code = { textContent: SHOP_PG.psql };
  const timers: Array<[() => void, number]> = [];
  const setTimeout = (f: () => void, ms: number) => { timers.push([f, ms]); };
  const wrote: string[] = [];
  const b = { textContent: "Copy", dataset: {} as Record<string, string> };
  const doc = { getElementById: (id: string) => id === "connect-psql" ? code : null };
  await copyClick({ copy: "connect-psql" }, b, { doc, win: { setTimeout, navigator: { clipboard: { writeText: async (t: string) => { wrote.push(t); } } } } });
  assert.deepEqual([wrote, b.textContent, "copied" in b.dataset], [[SHOP_PG.psql], "Copied", true]);
  assert.deepEqual(timers.map(([, ms]) => ms), [2000], "it says Copied for 2 s");
  timers[0]![0]();
  assert.deepEqual([b.textContent, "copied" in b.dataset], ["Copy", false], "then Copy again");
  // the clipboard refused (no permission): the text selected and copied as a person's own Copy would
  const selected: unknown[] = [];
  const execs: string[] = [];
  const r = { textContent: "Copy", dataset: {} as Record<string, string> };
  const refused = { setTimeout, getSelection: () => ({ selectAllChildren: (x: unknown) => selected.push(x) }), navigator: { platform: "MacIntel", clipboard: { writeText: async () => { throw new Error("denied"); } } } };
  await copyClick({ copy: "connect-psql" }, r, { doc: { ...doc, execCommand: (c: string) => { execs.push(c); return true; } }, win: refused });
  assert.deepEqual([selected, execs, r.textContent], [[code], ["copy"], "Copied"]);
  // and no clipboard at all (navigator.clipboard undefined on an insecure origin), the selection's copy refused too: what to press
  const q = { textContent: "Copy", dataset: {} as Record<string, string> };
  await copyClick({ copy: "connect-psql" }, q, { doc: { ...doc, execCommand: () => false }, win: { ...refused, navigator: { platform: "Linux x86_64" } } });
  assert.equal(q.textContent, "Selected: press Ctrl+C");
  await copyClick({ copy: "connect-psql" }, q, { doc: { ...doc, execCommand: () => { throw new Error("no"); } }, win: refused });
  assert.equal(q.textContent, "Selected: press ⌘C");
  assert.equal(copyClick({ sync: "x" }, b, { doc, win: {} }), null, "not a Copy: the page's own click goes on");
});

test("the Users table's URL: one line, cut with an ellipsis in its cell, its whole the title; Copy copies the whole", () => {
  const copyable = fn<[string, string, { clip?: boolean }?], string>("copyable");
  const url = "postgres://metabase@127.0.0.1:5433/a-long-project-name";
  assert.equal(copyable("u", url, { clip: true }), `<span class="copyrow clipped"><code id="u" title="${url}">${url}</code> <button type="button" class="small" data-copy="u">Copy</button></span>`);
  assert.equal(copyable("u", url), `<span class="copyrow"><code id="u">${url}</code> <button type="button" class="small" data-copy="u">Copy</button></span>`, "elsewhere, the whole on its line");
  const html = fn<[unknown, string | null, number], string>("renderUsers")({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: null, url }],
    lastUsedNote: null, urlNote: null, requestLogDays: 7 }, null, NOW);
  assert.match(html, /<span class="copyrow clipped"><code id="user-url-metabase" title="[^"]+">/);
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.match(css, /\.copyrow\.clipped code \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
});

test("the Overview's first-run checklist: running, a table copied, a user created, a first statement answered — each ○ with its one action; gone once all are done", async () => {
  const renderChecklist = of<[unknown, unknown, unknown], string>(statusPage, "status.js", "renderChecklist");
  const user = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true }] };
  const noUser = { users: [{ ...user.users[0], removedAt: "2026-10-27T10:00:00.000Z" }] };
  // a fresh install: a table added and copied, no user, nothing asked
  const fresh = renderChecklist(RUNNING, NO_QUERIES, noUser);
  assert.equal(textOf(fresh), "Getting started 2 of 4 done ✓ Mason is running (done) ✓ A table copied (done) ○ A user created (to do) Create a user ○ A first statement answered (to do) Copy the psql line then run a select on a copied table");
  assert.match(fresh, /<li class="step-todo"><span class="mark" aria-hidden="true">○<\/span><span class="what">A user created<span class="sr"> \(to do\)<\/span><\/span><a class="btn small primary" href="#users">Create a user<\/a><\/li>/, "the next step is the primary action");
  assert.match(fresh, /<button type="button" class="small" data-copy="connect-psql">Copy the psql line<\/button>/, "Connect's psql line, copied by its own Copy's handler");
  // nothing added: Add a table leads to Tables; nothing to copy the psql line for yet
  const none = renderChecklist(NONE, NO_QUERIES, noUser);
  assert.match(none, /○<\/span><span class="what">A table copied<span class="sr"> \(to do\)<\/span><\/span><a class="btn small primary" href="#tables">Add a table<\/a>/);
  assert.ok(!none.includes("Copy the psql line"));
  // copying: no action, it is under way
  assert.match(textOf(renderChecklist({ ...COPYING, totals: { ...COPYING.totals!, copied: 0 } }, NO_QUERIES, noUser)), /○ A table copied \(to do\) copying now ○ A user created/);
  // a user, no statement yet: the psql line is the primary action
  assert.match(renderChecklist(RUNNING, NO_QUERIES, user), /<button type="button" class="small primary" data-copy="connect-psql">Copy the psql line<\/button>/);
  // all four done: none; a read not answered, or that failed: none (never a ○ for what could not be told)
  assert.equal(renderChecklist(RUNNING, QUERIES, user), "");
  assert.equal(renderChecklist(RUNNING, undefined, user), "");
  assert.equal(renderChecklist(RUNNING, NO_QUERIES, { failure: { code: "failed", message: "x" } }), "");
  assert.equal(renderChecklist(RUNNING, { failure: { code: "failed", message: "x" } }, noUser), "");
  // the app: the Overview reads the users (every 30 s) and draws it above the cards; its Copy is a Copy
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(RUNNING));
  run.answers.set("GET /api/queries", answer(NO_QUERIES));
  run.answers.set("GET /api/users", answer({ users: [] }));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.ok(run.asked.includes("GET /api/users"));
  const text = textOf(app.view().status!);
  assert.match(text, /^Ready Getting started 2 of 4 done /);
  assert.ok(text.indexOf("Getting started") < text.indexOf("Tables synced"), "above the cards");
  assert.match(text, /psql psql 'postgres:\/\/<user>:<password>@127\.0\.0\.1:5433\/shop' Copy/, "the psql line it copies is on the page, Connect's");
});

test("a page opened at its own address that reads no state (Users) still has the sidebar's project, badge and version: the shell reads the state once a minute beside it", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(RUNNING));
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date, string], App>("createApp")(run.fetch, () => new Date(t), "#users");
  await app.poll();
  assert.deepEqual(run.asked, ["GET /api/users?lastUsed=1", "GET /api/state"], "the page's own read first: its failure is the banner");
  assert.notEqual(app.view().where, "", "the sidebar names the database");
  assert.match(app.view().version!, /^Mason /);
  run.asked.length = 0; t += 30_000; await app.poll();
  assert.deepEqual(run.asked, ["GET /api/users?lastUsed=1"], "the state is the sidebar's: once a minute, not at the page's rate");
});

test("Tables: an added copy not measured yet says so (—, with why in its title), never 0 B", () => {
  const html = fn<[unknown, unknown?], string>("renderTables")(SYNCED, {});
  assert.match(html, /<td class="num" title="not measured yet: a copy(?:'|&#39;)s size is measured every 10 min">—<\/td>/);
  assert.ok(!/\b0 B\b/.test(textOf(html)), "no 0 B");
  // a measure that is 0 (a file from an earlier run stored one) is not shown as a size either: the server skips it, the page never says 0 B for a copy
  assert.ok(!/\b0 B\b/.test(textOf(fn<[unknown, unknown?], string>("renderTables")(SYNCED, { sizes: { copySizes: [] } }))));
});

test("Tables: the state the page polls carries no table's columns; a form reads its table's once as it opens, a refusal said in the form, a late answer for a form closed dropped", async () => {
  assert.ok(CATALOG_STATE.tables.every((t) => !("columns" in t)), "the state, as the run answers it to the page, is lean");
  const columnsPath = fn<[string], string>("columnsPath");
  assert.equal(columnsPath("public.Odd/name"), "/api/tables/public.Odd%2Fname/columns", "a name is one segment of the path");
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  run.asked.length = 0;
  await app.poll();
  assert.ok(!run.asked.some((a) => a.includes("/columns")), "a poll reads no columns");
  const message = 'the database has no table "public.audit" this user can read';
  run.answers.set("GET /api/tables/public.audit/columns", answer({ error: message, failure: { code: "not_found", message, next: [] } }, 404));
  assert.equal(await app.choose("public.audit"), true);
  assert.match(textOf(app.view().tables!), /public\.audit Not added ~50 rows key id Add Columns… ✗ the database has no table "public\.audit" this user can read Cancel/);
  // closed before its columns came: the answer is not written into another table's form
  const opening = app.choose("public.accounts");
  app.cancelChoose();
  assert.equal(await opening, false);
  assert.ok(!/data-pick-form|Reading/.test(app.view().tables!), "no form, nothing being read");
  await app.choose("public.accounts");
  assert.deepEqual([...app.view().tables!.matchAll(/name="columns" value="([^"]*)"/g)].map((m) => m[1]), ["id", "email", "password_hash"]);
});
