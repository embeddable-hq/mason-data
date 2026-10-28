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
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
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
  show(page: string): void; poll(): Promise<void>; addUser(name: string): Promise<boolean>; askRemove(name: string): void; cancelRemove(): void;
  confirmRemove(name: string): Promise<boolean>; dismissAdded(): void; view(): Record<string, string>;
  addTable(table: string, columns?: string[], key?: string[]): Promise<boolean>; choose(table: string): void; cancelChoose(): void;
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
    page: true, folder: () => "/app/mason", root: "/app", sources: () => ({ file: o.sources ?? sourceFile, problem: null }),
    duck: { file: "/app/.mason/duck.db", pollSeconds: 5 },
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

/** What the Status page reads, in order: the state every poll, the request log's every 30 s. */
const STATUS_READS = ["GET /api/state", "GET /api/slow", "GET /api/refused", "GET /api/queries", "GET /api/events?failed=1&limit=5", "GET /api/requests?failed=1&limit=5"];
const SLOW = { slow: [{ route: "postgres", payload: "SELECT count(*) FROM orders", runs: 2, medianMs: 1500, maxMs: 2000, latestMs: 2000, last: "2026-10-27T09:03:00.000Z" }], slowMs: 1000 };
const REFUSED = { total: 7, refused: [{ route: "postgres", code: "42P01", message: "relation \"nope\" does not exist", runs: 7, last: "2026-10-27T09:04:00.000Z", payload: "SELECT * FROM nope" }] };

// ------------------------------------------------------------------ the DOM-free helpers, held to the commands'

test("the helpers: a share as the commands' percent, seconds left and a span as theirs, every value escaped", () => {
  const percent = fn<[number], string>("percent"), leftText = fn<[number | null], string>("leftText"), duration = fn<[number], string>("duration"), esc = fn<[unknown], string>("esc");
  assert.deepEqual([0, 0.157, 0.999, 1, 1.4, -1].map(percent), ["0%", "15%", "99%", "100%", "100%", "0%"]);
  assert.deepEqual([45, 340, 7500].map(leftText), ["~45 s left", "~6 min left", "~2 h 5 min left"]);
  assert.equal(leftText(null), "");
  for (const s of [0, 0.4, 1, 44.6, 89, 90, 600, 5399, 5400, 7500, 86_400]) assert.equal(duration(s), commands.duration(s), `duration(${s}) is the commands'`);
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
    const html = fn<[unknown, unknown?], string>("renderStatus")(s);
    const at = cli.map(([t]) => html.indexOf(`<code>${t}</code>`));
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
  assert.deepEqual(rows.find(([k]) => k === "Changes"), ["Changes", "polling with SELECTs (xmin), every 5 s · the demo database is read by polling only"]);
  assert.deepEqual(fn<[unknown], unknown>("sourceRows")(DEMO), rows);
});

// ------------------------------------------------------------------ what the page writes

test("running: the database masked, each table copied with its rows, the counts, Ready — and never the engine's name", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { slow: SLOW, refused: REFUSED });
  const text = textOf(html);
  assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
  assert.ok(!text.includes("secret"), "the password is the run's to mask, and it did");
  assert.match(text, /Changes polling with SELECTs \(xmin\), every 5 s/);
  assert.match(text, /Tables \(3 of 4 added\)/);
  assert.match(text, /public\.customers 100% 1,200 rows · copied/);
  assert.match(text, /public\.events 100% 30,000,000 rows · copied/);
  assert.ok(!text.includes("public.audit"), "a table not added is not a line");
  assert.match(text, /Slow queries: 1 in the last day \(1 s or more\)/);
  assert.match(text, /Refused queries: 7 in the last day/);
  assert.match(text, /Ready: every added table is copied and served\./);
  assert.ok(!/duckdb/i.test(html), "the engine is named in the code and the docs, never on the page");
  assert.ok(!/model/i.test(text), "a table is a table");
});

test("copying: the bar's share, the rows, the chunks, the rate and the time left; one waiting; Under way", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(COPYING, { slow: { slow: [], slowMs: 1000 }, refused: { total: 0, refused: [] } });
  const text = textOf(html);
  assert.match(html, /<tr class="t-copying"><th scope="row"><code>public\.orders<\/code><\/th><td class="bar"><progress max="100" value="15"><\/progress>/);
  assert.match(text, /public\.orders 15% copying 321,000 of ~2,000,000 rows · 2 chunks reading \(14 s\), 3 of ~20 in · 52,300 rows\/s · ~6 min left/);
  assert.match(text, /public\.events 0% waiting for its copy to start/);
  assert.match(text, /Under way: public\.orders: copying 15% · 321,000 of ~2,000,000 rows .* public\.events: waiting for its copy to start/);
});

test("failed: its error on its line and in full, the warning, a table not kept current, Failed — and a request count that could not be read", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(FAILED, { slow: { failure: { code: "failed", message: "the request log cannot be read\nmore" } }, refused: REFUSED });
  const text = textOf(html);
  assert.match(text, /public\.orders 100% its copy failed: could not read the next chunk: connection reset/);
  assert.match(html, /<details><summary>the whole error<\/summary><pre>could not read the next chunk: connection reset\nthe sync tries it again in 5 min<\/pre><\/details>/);
  assert.match(text, /public\.events 100% 30,000,000 rows · copied, NOT kept current \(over the poll's row limit; as of 2026-10-27 09:04 UTC\) — mason sync events, or mason start --replication/);
  assert.match(text, /Warning mason\/sources\/shop\.yml: tables\.ordrs: no such table/);
  assert.match(text, /Changes logical replication: slot mason_dev_shop, publication app_pub \(named: read as it is, never altered\)/);
  assert.match(text, /Slow queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
  assert.match(text, /Failed: public\.orders: could not read the next chunk: connection reset/);
});

test("no table added: the commands' sentence, and what adds one", () => {
  assert.match(textOf(fn<[unknown, unknown?], string>("renderStatus")(NONE)), /^Source .* No table added yet \(4 in the database\)\. mason tables lists them; mason add <table> copies one\.$/);
});

test("the tables: each of the database's, added, not added or cannot be added with its reason and no Add; Remove asks first", () => {
  type Ui = { removing?: string | null; choosing?: string | null; outcome?: unknown };
  const renderTables = fn<[unknown, Ui?], string>("renderTables");
  const html = renderTables(CATALOG_STATE);
  const text = textOf(html);
  assert.match(text, /^3 of 7 added Table Rows Key /);
  assert.match(text, /public\.customers ~1,200 rows key id added Remove public\.orders /);
  assert.match(text, /public\.audit ~50 rows key id Add Columns… public\.accounts /);
  assert.match(text, /public\.event_log ~900 rows no key cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id \(its unique index event_log_tenant_id_id_key\) Name its key… public\.staging /);
  assert.match(text, /public\.staging rows unknown key id Add Columns…$/);
  assert.match(html, /<button type="button" data-add-table="public\.audit">Add<\/button>/);
  assert.ok(!/data-add-table="public\.(event_log|customers)"/.test(html), "no Add for a table that cannot be added as it is, nor for one added");
  assert.match(html, /<button type="button" data-remove-table="public\.customers">Remove<\/button>/);
  assert.ok(!/duckdb/i.test(html), "never the engine's name");
  // Remove asks first, on its own line only
  const asking = renderTables(CATALOG_STATE, { removing: "public.customers" });
  assert.match(textOf(asking), /public\.customers ~1,200 rows key id added Remove customers\? Mason stops copying it and drops its copy\. Remove customers Cancel public\.orders /);
  assert.match(asking, /data-confirm-remove-table="public\.customers"/);
  assert.ok(!/data-confirm-remove-table="public\.orders"/.test(asking), "only the one asked");
  // the form: a table with no primary key ticks its key and its columns, one with a key its columns only
  const keyForm = renderTables(CATALOG_STATE, { choosing: "public.event_log" });
  assert.match(keyForm, /<form class="pick" data-pick-form="public\.event_log"/);
  assert.match(textOf(keyForm), /Its key: the columns that tell its rows apart, as mason add event_log --key tenant_id bigint id bigint payload jsonb Its columns, as mason add event_log --columns \(none ticked: as mason add event_log ?, every column\) tenant_id bigint id bigint payload jsonb Add event_log Cancel/);
  assert.deepEqual([...keyForm.matchAll(/name="(key|columns)" value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`),
    ["key=tenant_id", "key=id", "key=payload", "columns=tenant_id", "columns=id", "columns=payload"]);
  const columnsForm = renderTables(CATALOG_STATE, { choosing: "public.accounts" });
  assert.ok(!/name="key"/.test(columnsForm) && !/Its key/.test(columnsForm), "a table with a primary key is copied by it: no key to name");
  assert.deepEqual([...columnsForm.matchAll(/name="columns" value="([^"]*)"/g)].map((m) => m[1]), ["id", "email", "password_hash"]);
  assert.ok(!/pattern=|required/.test(keyForm + columnsForm), "the server judges what is sent, never the page");
  // what an add or a remove answered is said under its table; a refusal for a table the list lacks, above the list
  const said = renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", added: PICKED.secret } });
  assert.match(textOf(said), /public\.accounts ~300 rows key id Add Columns… Added public\.accounts to \/app\/mason\/sources\/shop\.yml: every column but password_hash .* public\.event_log /);
  const gone = renderTables(CATALOG_STATE, { outcome: { table: "public.gone", failure: { code: "not_found", message: "public.gone is not a table of shop that this user can read" } } });
  assert.match(textOf(gone), /^✗ public\.gone is not a table of shop that this user can read 3 of 7 added/);
  assert.equal(textOf(renderTables({ ...NONE, tables: [] })), "shop has no table this user can read.");
});

test("a Failure renders as the CLI's four parts: ✗ what is wrong, why, fix, then Next with each command and what it does", () => {
  const html = fn<[Failure], string>("renderFailure")({ code: "refused", message: "there is already a user \"metabase\"", why: "a name names one user", fix: "mason user remove metabase, then mason user add metabase",
    next: [{ command: "mason user list", what: "the users" }, { command: "mason user remove metabase" }] });
  assert.equal(textOf(html), "✗ there is already a user \"metabase\" why a name names one user fix mason user remove metabase, then mason user add metabase Next: mason user list the users mason user remove metabase");
  assert.match(html, /^<div class="failure" role="alert">/);
  assert.equal(textOf(fn<[Failure], string>("renderFailure")({ code: "failed", message: "only this" })), "✗ only this", "no empty why, fix or Next");
});

test("the users: a row each, active first then removed without Remove; Remove asks first; none is said", () => {
  const renderUsers = fn<[unknown, string | null], string>("renderUsers");
  const list = { users: [{ name: "old", id: "aaaaaaaaaaaaaaaa", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false, lastUsedAt: null, url: null },
    { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", removedAt: null, live: true, lastUsedAt: "2026-10-28T08:15:59.000Z", url: "postgres://metabase@127.0.0.1:5433/shop" },
    { name: "grafana", id: "fedcba9876543210", addedAt: "2026-10-20T08:00:00.000Z", removedAt: null, live: false, lastUsedAt: null, url: "postgres://grafana@127.0.0.1:5433/shop" }],
  lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const html = renderUsers(list, null);
  assert.match(textOf(html), /User Status Added Last used URL metabase id 0123456789abcdef Active 2026-10-27 09:10 UTC 2026-10-28 08:15 UTC postgres:\/\/metabase@127\.0\.0\.1:5433\/shop Copy Remove grafana id fedcba9876543210 Active does not connect: the API key was rotated since it was added 2026-10-20 08:00 UTC not used in the last 7 days postgres:\/\/grafana@127\.0\.0\.1:5433\/shop Copy Remove old id aaaaaaaaaaaaaaaa Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC/);
  assert.match(html, /<code id="user-url-metabase">postgres:\/\/metabase@127\.0\.0\.1:5433\/shop<\/code> <button type="button" data-copy="user-url-metabase">Copy<\/button>/);
  assert.ok(!/data-remove="old"/.test(html), "a removed user has no Remove");
  assert.ok(!/password/i.test(html.replace(/the API key/g, "")), "no password is shown: the URL is the one without it");
  const asking = renderUsers(list, "metabase");
  assert.match(textOf(asking), /Remove metabase\? It connects no more, and the sessions it holds end at their next statement\. Remove metabase Cancel/);
  assert.match(asking, /data-confirm-remove="metabase"/);
  assert.ok(!/data-confirm-remove="grafana"/.test(asking), "only the one asked");
  assert.equal(textOf(renderUsers({ users: [] }, null)), "No users yet.");
  // last use unknown, or the URL unknown: the note why, as mason user list says it
  const unknown = textOf(renderUsers({ ...list, lastUsedNote: "unknown: the request log could not be read (busy)", urlNote: "Mason is not running" }, null));
  assert.match(unknown, /Active 2026-10-27 09:10 UTC 2026-10-28 08:15 UTC/);
  assert.match(unknown, /Active does not connect: the API key was rotated since it was added 2026-10-20 08:00 UTC unknown /);
  assert.match(unknown, /Last used: unknown: the request log could not be read \(busy\)\. URL: Mason is not running\.$/);
});

test("a user just added: the password and the URL to paste, each with a copy button, and that it will not be shown again", () => {
  const html = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password: "mason_0123456789abcdef_" + "a".repeat(32),
    database: "shop", url: `postgres://metabase:mason_0123456789abcdef_${"a".repeat(32)}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable" });
  const text = textOf(html);
  assert.match(text, /^The user metabase added: its password is shown this once url postgres:\/\/metabase:mason_0123456789abcdef_a{32}@127\.0\.0\.1:5433\/shop Copy user metabase password mason_0123456789abcdef_a{32} Copy database shop host 127\.0\.0\.1 port 5433 /);
  assert.match(text, /Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again\./);
  assert.match(html, /<code id="added-password">mason_0123456789abcdef_a{32}<\/code> <button type="button" data-copy="added-password">Copy<\/button>/);
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
  answers.set("GET /api/slow", json(SLOW));
  answers.set("GET /api/refused", json(REFUSED));
  answers.set("GET /api/users", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
  answers.set("GET /api/queries", json(QUERIES));
  answers.set("GET /api/events?failed=1&limit=5", json(EVENTS));
  answers.set("GET /api/requests?failed=1&limit=5", json(FAILED_REQUESTS));
  answers.set("GET /api/usage?since=1m", json(USAGE));
  answers.set("GET /api/running", json({ running: [] }));
  answers.set("GET /api/requests", json({ requests: [], keptDays: 7, before: null }));
  answers.set("GET /api/users?lastUsed=1", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
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
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(2026, 9, 27, 14, 3, 5));
  assert.match(app.view().status!, /Asking Mason/);
  await app.poll();
  let v = app.view();
  assert.equal(v.where, "shop", "the database; its source's name only when it is another");
  assert.equal(v.updated, "Updated 14:03:05");
  assert.equal(v.poll, "");
  assert.match(textOf(v.status!), /public\.orders 15% copying/);
  assert.deepEqual(run.asked, STATUS_READS, "the Status page's reads, no other page's");
  assert.equal(v.users, "", "the users are not read while Status is shown");
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
  assert.equal(v.updated, "Updated 14:03:05", "when it last heard, not now");
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
  assert.equal(textOf(app.view().users!), "No users yet.");
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
  assert.match(textOf(v.tables!), /public\.accounts ~300 rows key id added Remove Added public\.accounts to \/app\/mason\/sources\/shop\.yml: every column but password_hash left out password_hash: it looks like a secret/);
  assert.match(textOf(v.status!), /public\.accounts 0% waiting for its copy to start/, "the Status shows the copy starting");
  app.dismissOutcome();
  assert.ok(!/Added public\.accounts/.test(app.view().tables!));
});

test("the app: the form sends the columns ticked as columns and the key's as key, nothing when none is ticked", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  run.answers.set("POST /api/pick", answer({ ...PICKED.keyed, state: COPYING }));
  assert.deepEqual(fn<[string, string[]?, string[]?], unknown>("pickBody")("public.audit", [], []), { table: "public.audit", picked: true });
  app.choose("public.event_log");
  assert.equal(app.model.choosing, "public.event_log");
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
  app.choose("public.event_log");
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
  assert.match(textOf(app.view().tables!), /public\.audit ~50 rows key id Add Columns… ✗ mason\/sources\/ has 2 source files: one source per project for now public\.accounts/);
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
  assert.match(textOf(app.view().tables!), /public\.accounts ~300 rows key id Add Columns… Removed public\.accounts from \/app\/mason\/sources\/shop\.yml Tip: Mason stops copying it and drops its copy/);
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

test("the page's files fetch nothing from elsewhere and never touch the token: the address but its hash, the cookie, storage", () => {
  const files = webFiles().sort();
  assert.ok(files.includes(path.join("pages", "status.js")) && files.includes("shared.js"), "the pages' modules are checked with the rest");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  // the nav's links are the page's own hash (#tables): nothing is loaded by them
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("#")), ["data:,", "/app.css", "/app.js"],
    "every file the page loads is the server's allowlist (or inline); the modules are imported by app.js");
  for (const f of files) {
    const text = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.ok(!/https?:\/\//.test(text), `${f} names no other site: a CDN or a font would break the CSP`);
    assert.ok(!/@import|url\(/.test(text), `${f} loads no stylesheet or font`);
    assert.ok(!/duckdb/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f}: never the engine's name`);
    if (!f.endsWith(".js")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // the hash chooses the page shown (#status): it never holds the token, which the first request traded for the cookie
    // and dropped from the address; every other part of `location` (search, href) is refused, as the cookie and storage are
    assert.ok(!/\blocation\b(?!\.hash\b)|document\.cookie|localStorage|sessionStorage|indexedDB|[?&]token=|\.token\b/.test(code),
      `${f}: the cookie carries the token; the page's script never reads it, the address (but its hash) or storage`);
    // every module it imports is the page's own, a route of PAGE_ROUTES (tests/cli-run-server.test.ts serves each)
    for (const m of code.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)) assert.match(m[1] ?? m[2]!, /^\.\.?\/[\w/.-]+\.js$/, `${f} imports ${m[1] ?? m[2]} by a relative path`);
  }
});

/** The page in a fake browser: elements whose innerHTML reads back as a browser serialises it (a bare data-x attribute
 *  as data-x="", an apostrophe in text as itself), the listeners `start` adds, the interval it sets, and a FormData
 *  that reads a form's ticked boxes from the fake form. */
function fakeBrowser(run: ReturnType<typeof fakeRun>, hash = "") {
  const els = new Map<string, { writes: number; html: string; innerHTML: string; addEventListener: () => void }>();
  const el = (id: string) => els.get(id) ?? (els.set(id, { writes: 0, html: "", addEventListener: () => undefined,
    get innerHTML() { return this.html.replace(/ (data-[a-z-]+)(?=[ >])/g, ' $1=""').replace(/&#39;/g, "'"); },
    set innerHTML(v: string) { this.html = v; this.writes++; } }), els.get(id)!);
  const on = new Map<string, (e: unknown) => Promise<void> | void>();
  const doc = { visibilityState: "visible", getElementById: el, addEventListener: (type: string, f: (e: unknown) => void) => { on.set(type, f); } };
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
  assert.match(textOf(tables.html), /public\.orders ~2,000,000 rows key id added Remove/);
  await on.get("click")!({ target: { closest: () => ({ dataset: { removeTable: "public.orders" } }) } });
  assert.match(textOf(tables.html), /Remove orders\? Mason stops copying it and drops its copy\. Remove orders Cancel/);
  let writes = tables.writes;
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "the tables, unchanged while a copy moves, are not written again: the confirm stays the one clicked");
  // the run reads the catalog again every few seconds, and a live database's row estimates move (pg_class.reltuples)
  const rowsOf = (orders: number) => answer({ ...COPYING, tables: COPYING.tables.map((t) => t.table === "public.orders" ? { ...t, rows: orders } : t) });
  run.answers.set("GET /api/state", rowsOf(2_000_350));
  tick(); await settle();
  assert.equal(tables.writes, writes, "rows that moved while a Remove asks do not write the tables again: the confirm stays the one clicked");
  assert.match(textOf(tables.html), /public\.orders ~2,000,000 rows key id added Remove orders\? /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelRemoveTable: "" } }) } });
  assert.match(textOf(tables.html), /public\.orders ~2,000,350 rows key id added Remove public\.events/, "Cancel writes the rows as they are now");
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  assert.match(tables.html, /data-pick-form="public\.audit"/);
  writes = tables.writes;
  tick(); await settle();
  assert.equal(tables.writes, writes, "the form is not written again under the reader's ticks");
  run.answers.set("GET /api/state", rowsOf(2_000_700));
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "nor when the rows moved: the ticks stay");
  assert.match(textOf(tables.html), /public\.orders ~2,000,350 rows /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelChoose: "" } }) } });
  run.answers.set("GET /api/state", rowsOf(2_001_000));
  writes = tables.writes;
  tick(); await settle();
  assert.ok(tables.writes > writes, "the form cancelled, the next poll writes the tables again");
  assert.match(textOf(tables.html), /public\.orders ~2,001,000 rows /);
  run.answers.set("GET /api/state", answer(COPYING));
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  // the form submitted: the ticked boxes, as FormData reads them, sent as the columns
  run.answers.set("POST /api/pick", answer({ ...PICKED.columns, state: COPYING }));
  let prevented = false;
  await on.get("submit")!({ target: { dataset: { pickForm: "public.audit" }, ticked: { columns: ["name"] } }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the page posts it, not the browser");
  assert.ok(run.asked.includes(`POST /api/pick ${JSON.stringify({ table: "public.audit", picked: true, columns: ["name"] })}`), run.asked.join("\n"));
  assert.match(textOf(tables.html), /Added public\.audit to \/app\/mason\/sources\/shop\.yml: id, name key added: id/);
});

// ------------------------------------------------------------------ the shell: a page per hash, each polling its own

test("the shell: a page per hash (#status the default, an unknown hash Status), each a module with a section and a route", async () => {
  const routeOf = fn<[string | undefined], string>("routeOf");
  assert.deepEqual(["#status", "#tables", "#queries", "#users", "#usage", "#logs", "", undefined, "#", "#nope", "#Tables", "#tables?x=1"].map(routeOf),
    ["status", "tables", "queries", "users", "usage", "logs", "status", "status", "status", "status", "status", "status"]);
  const pages = (page as unknown as { PAGES?: Array<{ id: string; title: string; create: unknown }> }).PAGES;
  assert.ok(Array.isArray(pages), "src/web/app.js exports PAGES");
  assert.deepEqual(pages!.map((p) => [p.id, p.title]), [["status", "Status"], ["tables", "Tables"], ["queries", "Queries"], ["users", "Users"], ["usage", "Usage"], ["logs", "Logs"]]);
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts") as { PAGE_ROUTES: Record<string, readonly [string, string]> };
  for (const p of pages!) {
    assert.match(html, new RegExp(`<section id="page-${p.id}" aria-labelledby="${p.id}-h"`), `index.html has ${p.id}'s section`);
    assert.deepEqual(PAGE_ROUTES[`/pages/${p.id}.js`], [`pages/${p.id}.js`, "text/javascript; charset=utf-8"], `${p.id}'s module is a route`);
    // what the page module itself exports: its id and title, as the shell registers it
    const mod = await import(path.join(WEB, "pages", `${p.id}.js`)) as { page: { id: string } };
    assert.equal(mod.page.id, p.id);
  }
  const nav = fn<[string], string>("renderNav")("tables");
  assert.equal(textOf(nav), "Status Tables Queries Users Usage Logs");
  assert.deepEqual([...nav.matchAll(/<a href="(#\w+)"( aria-current="page")?>/g)].filter((m) => m[2]).map((m) => m[1]), ["#tables"], "the page shown is the current one");
  // a page not built yet says so in one line, with the command that shows it today
  const app = fn<[unknown], App>("createApp")(fakeRun().fetch);
  // (Usage and Logs are built: before their first read they say they are asking)
  assert.match(textOf(app.view()["usage-queries"]!), /Asking Mason/);
  assert.match(textOf(app.view()["logs-events"]!), /Asking Mason/);
});

test("the shell: only the page shown is asked, each endpoint at its own rate — the state every poll, the slower ones when due", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), STATUS_READS, "Status, first: everything it reads");
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
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests"], "Queries: the statements running, the newest requests");
  // the page's own read failing is the banner; a slower one failing is said where it is shown, never as the banner
  app.show("status");
  run.answers.set("GET /api/slow", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  t += 30_000;
  await app.poll();
  assert.equal(app.view().poll, "");
  assert.match(textOf(app.view().status!), /Slow queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
});

test("in the browser: the hash chooses the section shown and the page asked; a link followed asks the new page at once", async () => {
  const run = fakeRun();
  const { el, go, settle, tick } = fakeBrowser(run, "#nope");
  await settle();
  const shown = () => ["status", "tables", "queries", "users", "usage", "logs"].filter((id) => (el(`page-${id}`) as unknown as { hidden: boolean }).hidden === false);
  assert.deepEqual(shown(), ["status"], "an unknown hash shows Status");
  assert.match(el("nav").html, /<a href="#status" aria-current="page">Status<\/a>/);
  run.asked.length = 0;
  go("#users"); await settle();
  assert.deepEqual(shown(), ["users"]);
  assert.deepEqual(run.asked, ["GET /api/users?lastUsed=1"], "the users at once, not at the next tick");
  assert.match(el("nav").html, /<a href="#users" aria-current="page">Users<\/a>/);
  run.asked.length = 0;
  tick(); await settle();
  assert.deepEqual(run.asked, [], "the users are read every 30 s, not at every tick");
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
  assert.match(textOf(status.html), /Ready: every added table is copied and served/);
});

// ------------------------------------------------------------------ the Status page: the word, the facts, the recent errors

// the pages' own modules, imported when the tests run (at a commit without them each test fails by name)
const statusPage = await import(path.join(WEB, "pages", "status.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const tablesPage = await import(path.join(WEB, "pages", "tables.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
const of = <A extends unknown[], R>(mod: Record<string, unknown>, file: string, name: string): Fn<A, R> => {
  assert.equal(typeof mod[name], "function", `src/web/pages/${file} exports ${name}`);
  return mod[name] as Fn<A, R>;
};
const plain = (line: string) => line.replace(/\s+/g, " ").trim();

test("the Status page's words are mason status's: the readiness word, the copies' line, a size, a span, an event's and a statement's line", () => {
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
  const eventCells = of<[unknown], string[]>(statusPage, "status.js", "eventCells"), requestCells = of<[unknown], string[]>(statusPage, "status.js", "requestCells");
  for (const e of EVENTS.events as SyncEvent[]) assert.equal(eventCells(e).join(" "), plain(commands.eventLine(e, PLAIN)));
  for (const r of FAILED_REQUESTS.requests as LedgerRequest[]) {
    const cells = requestCells(r);
    assert.equal(plain(cells.slice(0, -1).join(" ") + (cells.at(-1) ? ` — ${cells.at(-1)}` : "")), plain(commands.requestLine(r, PLAIN)));
  }
});

test("Status: the word, the facts (tables synced N of M, rows, the last sync and its age, the copy's file), the statements, the recent errors", () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(SYNCED));
  const a = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(NOW));
  return a.poll().then(() => {
    const html = a.view().status!;
    const text = textOf(html);
    assert.match(html, /^<p class="health bad">Failed<\/p>/, "the word first: mason status's");
    assert.match(text, /^Failed The copies Tables synced 2 of 3 added, 1 failed Rows 30,001,200 Last sync 2026-10-27 09:05:00 UTC · 30 s ago The copy's file /);
    assert.match(html, /<caption>The copies<\/caption><tbody><tr><th scope="row">Tables synced<\/th><td>2 of 3 added, 1 failed<\/td><\/tr>/, "a table, each fact a row headed by its name");
    // the statements: a row per window, each count as mason status says it
    assert.match(text, /Statements \(the completed ones' time; mason logs --requests lists each\) Statements Completed Refused Failed Cancelled Average p50 p95 Rows sent Sent /);
    assert.match(text, /Last day 1,234 1,200 30 3 1 42 ms 12 ms 380 ms 98,765 5\.1 MiB Last week 5,000 4,900 90 9 1 40 ms 11 ms 1,250 ms 400,000 900 B /);
    assert.match(text, /The request log keeps 3 days: MASON_REQUEST_LOG_DAYS\./);
    const cliQueries = plain(commands.queryLines(QUERIES.queries as never, PLAIN).join(" "));
    for (const v of ["1,234 statements: 1,200 completed, 30 refused, 3 failed, 1 cancelled", "42 / 12 / 380 ms", "98,765 rows, 5.1 MiB sent", "400,000 rows, 900 B sent"]) assert.ok(cliQueries.includes(v), `mason status says ${v}`);
    // today's Status kept: the database, the bars, the counts, readiness
    assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
    assert.match(text, /public\.orders 100% its copy failed: poll: connection reset/);
    assert.match(text, /Slow queries: 1 in the last day .* Refused queries: 7 in the last day/);
    // the recent errors: each a table, its cells mason status's line
    assert.match(text, /Sync errors \(the latest, newest last; mason logs --events lists each\) At \(UTC\) What Table Why 2026-10-27 09:03:10 poll_failed public\.orders poll: connection reset 2026-10-27 09:04:00 restart \(the sync\) the run was started again after it stopped/);
    assert.match(text, /Query errors \(the latest, newest last; mason logs --requests --failed lists each\) Started \(UTC\) Outcome Took Rows Who Statement Error 2026-10-27 09:02:00 refused 42P01 3 ms Metabase \(user metabase\) SELECT \* FROM nope relation "nope" does not exist /);
    assert.match(text, /cancelled 57014 12,345 ms 10 rows \(no application_name\) SELECT (x, )+x… canceling statement due to user request/);
    assert.ok(!/duckdb/i.test(html), "never the engine's name");
  });
});

test("Status: Ready and Under way in mason status's words; nothing added says so once; an error list that could not be read, or is empty, says so", async () => {
  const renderHealth = of<[unknown], string>(statusPage, "status.js", "renderHealth");
  assert.equal(textOf(renderHealth(RUNNING)), "Ready");
  assert.equal(textOf(renderHealth(COPYING)), "Under way");
  assert.equal(renderHealth(NONE), "", "no table added: renderStatus says it, with what adds one");
  const renderRecentErrors = of<[unknown, unknown], string>(statusPage, "status.js", "renderRecentErrors");
  assert.equal(textOf(renderRecentErrors({ events: [] }, { failure: { code: "failed", message: "the request log cannot be read\nmore" } })),
    "Sync errors None. Query errors Could not read them (the request log cannot be read; mason logs has the detail)");
  assert.equal(renderRecentErrors(undefined, undefined), "", "not read yet: nothing");
  const renderFacts = of<[unknown, number], string>(statusPage, "status.js", "renderFacts");
  assert.match(textOf(renderFacts({ ...NONE, totals: { added: 0, copied: 0, failed: 0, rows: 0, syncedAt: null }, engine: { ...NONE.engine, bytes: 2_097_152 } }, NOW)),
    /Tables synced 0 of 0 added Rows 0 Last sync none yet The copy's file 2\.0 MiB/);
  assert.match(textOf(of<[unknown], string>(statusPage, "status.js", "renderQueries")({ failure: { code: "failed", message: "no ledger" } })), /^Queries: could not read them \(no ledger; mason logs has the detail\)$/);
  // the app with nothing added: the commands' sentence, no word or facts above it
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(NONE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  assert.match(textOf(app.view().status!), /^Source .* No table added yet \(4 in the database\)\./);
});

// ------------------------------------------------------------------ the Tables page: each copy's sync, Sync, the search box

test("Tables: each added table's state, rows, last sync and its age, how long it took, its copy's size and error, and Sync", () => {
  const renderCopies = of<[unknown, unknown, unknown?], string>(tablesPage, "tables.js", "renderCopies");
  const html = renderCopies(SYNCED, USAGE);
  const text = textOf(html);
  assert.match(text, /^The copies \(3 added; mason status says the same\) Table State Rows Last sync \(UTC\) Age Took Size of the copy Error /);
  assert.match(text, /public\.customers Synced 1,200 2026-10-27 09:05:00 30 s ago 0\.4 s \(poll\) 512\.0 KiB Sync /);
  assert.match(text, /public\.orders Failed 2026-10-27 08:00:09 65 min ago 63 s \(copy\) poll: connection reset the whole error poll: connection reset the sync tries it again in 5 s Sync /);
  assert.match(text, /public\.events Synced 30,000,000 2026-10-27 09:04:00 2 min ago 13 min \(copy\) 3\.0 GiB Sync /);
  assert.ok(!text.includes("public.audit"), "a table not added has no copy");
  assert.match(html, /<button type="button" data-sync-table="public\.customers">Sync<\/button>/);
  assert.match(html, /<th scope="row"><code>public\.customers<\/code><\/th>/);
  // the cells are the commands': the age's and the span's functions, the size's
  const ages = SYNCED.tables.filter((t) => t.added).map((t) => `${commands.duration(t.sync!.ageSeconds!)} ago`);
  for (const a of ages) assert.ok(text.includes(a), a);
  assert.ok(text.includes(commands.fileSize(3_221_225_472)) && text.includes(commands.spanText(0.42)));
  // the states, as the run decides them: copying is Syncing, a table not reached Waiting
  assert.match(textOf(renderCopies(COPYING, USAGE)), /public\.orders Syncing 280,000 .* public\.events Waiting /);
  // the sizes could not be read: said once, the rest shown
  assert.match(textOf(renderCopies(SYNCED, { failure: { code: "failed", message: "the samples cannot be read" } })), /The copies' own sizes: could not read them \(the samples cannot be read; mason usage has them\)/);
  assert.equal(renderCopies(NONE, USAGE), "", "nothing added: no copies");
  // a sync asked: its button says so, no second one
  assert.match(renderCopies(SYNCED, USAGE, { syncing: ["public.customers"] }), /<button type="button" disabled>Syncing…<\/button>/);
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
  assert.match(textOf(app.view().copies!), /public\.events Synced .* Sync Synced public\.events: 1,234 row\(s\) written, 5 deleted\. public\.events 1,234 changed, 5 deleted, 30,001,229 rows now · 8,500 ms Tip: public\.events is over the poll's row limit: it stays as of this sync until the next mason sync \(mason start --replication keeps every table current\) Dismiss A copy's/);
  app.dismissSynced();
  assert.ok(!/Synced public\.events:/.test(app.view().copies!));
  const message = "public.orders has no copy yet: it is synced once it is copied";
  run.answers.set("POST /api/sync", answer({ error: message, code: "nothing_yet", failure: { code: "nothing_yet", message, next: [] } }, 409));
  assert.equal(await app.syncTable("public.orders"), false);
  assert.ok(app.view().copies!.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
});

test("Tables: the search box filters both lists by name, its text kept across polls; a form open keeps its table and its list still", async () => {
  const renderTables = fn<[unknown, Record<string, unknown>?], string>("renderTables");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "ORD" })), /^3 of 7 added · 1 with “ORD” in the name Table Rows Key public\.orders ~2,000,000 rows key id added Remove$/);
  assert.equal(renderTables(CATALOG_STATE, { filter: "" }), renderTables(CATALOG_STATE), "nothing typed: every table, as before");
  assert.match(textOf(renderTables(CATALOG_STATE, { filter: "zzz", choosing: "public.audit" })), /^3 of 7 added · 1 with “zzz” in the name .* public\.audit ~50 rows key id Add Columns… Its columns/, "the table whose form is open stays");
  assert.match(textOf(of<[unknown, unknown, unknown?], string>(tablesPage, "tables.js", "renderCopies")(SYNCED, USAGE, { filter: "nope" })), /No added table's name has “nope”\./);
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(SYNCED));
  const { el, on, tick, settle } = fakeBrowser(run, "#tables");
  await settle();
  await on.get("input")!({ target: { id: "tables-filter", value: "cust" } });
  assert.match(textOf(el("copies").html), /public\.customers Synced/);
  assert.ok(!/public\.orders/.test(el("copies").html) && !/public\.orders/.test(el("tables").html), "both lists filtered");
  tick(); await settle();
  tick(); await settle();
  assert.ok(!/public\.orders/.test(el("tables").html) && /public\.customers/.test(el("tables").html), "the text is kept across polls");
  // Sync clicked: its button says Syncing… at once (written before the answer comes), the answer under it once it does
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  run.answers.set("POST /api/sync", () => new Response(JSON.stringify({ at: "2026-10-27T09:05:31.000Z", tables: [{ table: "public.customers", changed: 1, deleted: 0, rows: 1201, ms: 40 }] })));
  const fetchNow = run.fetch;
  run.fetch = async (p, init) => { if (p === "/api/sync") await answered; return fetchNow(p, init); };
  const click = on.get("click")!({ target: { closest: () => ({ dataset: { syncTable: "public.customers" } }) } });
  await settle();
  assert.match(el("copies").html, /<button type="button" disabled>Syncing…<\/button>/, "said while it runs");
  release();
  await click;
  assert.match(textOf(el("copies").html), /Synced public\.customers: 1 row\(s\) written, 0 deleted\./);
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
  assert.match(text, /^Running now \(2\): Session Statement User Client Started \(UTC\) Running for Rows Statement text /);
  assert.match(text, /12 45 metabase Metabase v0\.50 2026-10-28 09:04:00 2 min 1,200 rows sent SELECT customer_id, sum\(total\) FROM orders GROUP BY 1 Cancel/);
  assert.match(text, /13 7 \(no application_name\) 2026-10-28 09:05:50 1\.5 s 1 row sent SELECT 1 <b> Cancel/);
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
  assert.match(html, /<button type="button" data-ask-cancel="12:45">Cancel<\/button>/);
  const asking = renderRunning(RUNNING_NOW, "12:45");
  assert.match(textOf(asking), /Cancel session 12's statement 45\? Its client is told so \(57014\)\. Cancel statement 45 Keep it running/);
  assert.match(asking, /data-confirm-cancel="12:45"/);
  assert.ok(!/data-confirm-cancel="13:7"/.test(asking), "only the one asked");
  assert.equal(textOf(renderRunning([], null)), "No statement is running now.");
});

test("running now: the answer to a cancel is said under its row, a refusal as the CLI's Failure, and under the table once the statement ended", () => {
  const renderRunning = fn<[unknown[], string | null, unknown], string>("renderRunning");
  const done = renderRunning(RUNNING_NOW, null, { key: "12:45", cancelled: RUNNING_NOW[0] });
  assert.match(textOf(done), /Cancel Cancelled session 12's statement: it ends now, and its client is told so \(57014\)\. 13 7 /, "under the row it was for");
  const refused = { key: "12:45", failure: { code: "refused", message: "session 12 runs another statement now (statement 46), not statement 45: nothing cancelled", why: "statement 45 ended, and the session began another",
    fix: "mason cancel 12 --statement 46 stops the one it runs now", next: [{ command: "mason logs --running", what: "the statements running now, with their sessions" }] } };
  assert.match(textOf(renderRunning(RUNNING_NOW.slice(0, 1), null, refused)), /^Running now \(1\):.* ✗ session 12 runs another statement now \(statement 46\), not statement 45: nothing cancelled why statement 45 ended, and the session began another fix mason cancel 12 --statement 46 stops the one it runs now Next: mason logs --running the statements running now, with their sessions$/);
  assert.equal(textOf(renderRunning([], null, { key: "12:45", cancelled: RUNNING_NOW[0] })), "No statement is running now. Cancelled session 12's statement: it ends now, and its client is told so (57014).");
});

test("the request log: a row each, newest first, in the commands' words — held equal to mason logs --requests' line — Older and Newest", () => {
  const renderRequests = fn<[unknown, unknown?], string>("renderRequests");
  const html = renderRequests({ requests: REQUESTS, keptDays: 7, before: "2026-10-28T09:00:00.000Z~5" });
  const text = textOf(html);
  assert.match(text, /^Query id Started \(UTC\) Ended \(UTC\) Duration Status User Client Rows Bytes Statement Error /);
  assert.match(text, /r-new 2026-10-28 09:01:00 2026-10-28 09:02:30 90,000 ms Cancelled metabase \(no application_name\) SELECT pg_sleep\(100\) 57014 canceling statement due to user request r-old 2026-10-28 09:00:00 2026-10-28 09:00:01 1,234 ms Completed ana psql 1 row 2\.0 KiB SELECT count\(\*\) FROM orders Older$/);
  assert.ok(!html.includes("data-newest"), "the newest page has no Newest");
  for (const r of REQUESTS) {
    const line = commands.requestLine(r as never, PLAIN);
    const words = [`${r.durationMs.toLocaleString("en-US")} ms`, r.query, ...(r.message ? [r.message.split("\n")[0]!] : [])];
    for (const w of words) { assert.ok(line.includes(w), `the CLI's line says ${w}`); assert.ok(text.includes(w), "and so does the page"); }
  }
  assert.match(textOf(renderRequests({ requests: [failedRequest], keptDays: 7, before: null }, { paged: true })), /Failed .* 42P01 relation "nope" does not exist Newest$/);
  assert.match(renderRequests({ requests: [], keptDays: 7, before: null }), /^<p class="dim">No request in the last 7 days \(MASON_REQUEST_LOG_DAYS\)\.<\/p>$/);
  assert.equal(textOf(renderRequests({ requests: [], keptDays: 1, before: null }, { filtered: true })), "No request that passes the filters in the last 1 day (MASON_REQUEST_LOG_DAYS).");
});

test("the request log's filters: each view has its own path — status as the server's outcomes, since, user, client", async () => {
  const run = fakeRun();
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  const asked = async (f: Record<string, string>) => { run.asked.length = 0; await app.filterRequests(f); return [...run.asked]; };
  run.answers.set("GET /api/requests?outcome=ok", answer({ requests: [], keptDays: 7, before: null }));
  run.answers.set("GET /api/requests?outcome=refused%2Cfailed&since=2h&user=ana&client=psql", answer({ requests: [failedRequest], keptDays: 7, before: null }));
  assert.deepEqual(await asked({ status: "completed" }), ["GET /api/requests?outcome=ok"]);
  assert.match(textOf(app.view()["request-log"]!), /^No request that passes the filters in the last 7 days/);
  assert.deepEqual(await asked({ status: "failed", since: "2h", user: "ana", client: "psql" }), ["GET /api/requests?outcome=refused%2Cfailed&since=2h&user=ana&client=psql"]);
  assert.match(textOf(app.view()["request-log"]!), /42P01 relation "nope"/);
  assert.deepEqual(await asked({}), ["GET /api/requests"], "cleared: every request again");
});

test("the app: Cancel asks first; the confirm posts { session, statement } and reads the statements again; a 409 renders as its Failure", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/running", answer({ running: RUNNING_NOW }));
  const app = fn<[unknown], QueriesApp>("createApp")(run.fetch);
  app.show("queries");
  await app.poll();
  assert.match(textOf(app.view()["running-now"]!), /Running now \(2\)/);
  app.askCancelStatement(12, 45);
  assert.match(textOf(app.view()["running-now"]!), /Cancel session 12's statement 45\? Its client is told so/);
  run.asked.length = 0;
  await app.poll();
  assert.match(textOf(app.view()["running-now"]!), /Cancel session 12's statement 45\?/, "a poll keeps the question");
  app.dismissCancelStatement();
  assert.ok(!/Its client is told so/.test(textOf(app.view()["running-now"]!)));
  assert.ok(!run.asked.some((a) => a.startsWith("POST")), "asking posts nothing");
  app.askCancelStatement(12, 45);
  run.answers.set("POST /api/cancel", answer({ cancelled: RUNNING_NOW[0], next: [] }));
  run.answers.set("GET /api/running", answer({ running: RUNNING_NOW.slice(1) }));
  run.asked.length = 0;
  assert.equal(await app.confirmCancelStatement(12, 45), true);
  assert.deepEqual(run.asked, [`POST /api/cancel ${JSON.stringify({ session: 12, statement: 45 })}`, "GET /api/running"]);
  assert.match(textOf(app.view()["running-now"]!), /^Running now \(1\):.* 13 7 .*Cancelled session 12's statement: it ends now/, "the statement ended: said under the table");
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
  run.answers.set("GET /api/requests", answer({ requests: [REQUESTS[1]], keptDays: 7, before: "CURSOR.1" }));
  run.answers.set("GET /api/requests?before=CURSOR.1", answer({ requests: [REQUESTS[0]], keptDays: 7, before: null }));
  const app = fn<[unknown, () => Date], QueriesApp>("createApp")(run.fetch, () => new Date(t));
  app.show("queries");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests"]);
  t += 2000;
  assert.deepEqual(await asked(), ["GET /api/running"], "the statements every 2 s");
  t += 3000;
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests"], "the newest page every 5 s");
  assert.ok(textOf(app.view()["request-log"]!).endsWith("Older"));
  run.asked.length = 0;
  await app.olderRequests();
  assert.deepEqual(run.asked, ["GET /api/requests?before=CURSOR.1"], "Older asks with the cursor the page answered with");
  assert.match(textOf(app.view()["request-log"]!), /r-old .* Newest$/);
  t += 60_000;
  assert.deepEqual(await asked(), ["GET /api/running"], "never read again while paging");
  await app.newestRequests();
  assert.match(textOf(app.view()["request-log"]!), /r-new .* Older$/);
  t += 5000;
  assert.deepEqual(await asked(), ["GET /api/running", "GET /api/requests"], "the newest page is polled again");
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
  run.answers.set("GET /api/requests", answer({ requests: [REQUESTS[1]], keptDays: 7, before: "CURSOR.1" }));
  run.answers.set("GET /api/requests?outcome=cancelled&user=metabase", answer({ requests: [REQUESTS[1]], keptDays: 7, before: null }));
  const { el, on, settle } = fakeBrowser(run, "#queries");
  await settle();
  assert.match(textOf(el("running-now").html), /Running now \(2\)/);
  assert.match(textOf(el("request-log").html), /Older$/);
  const form = { id: "request-filters", elements: { status: { value: "cancelled" }, since: { value: " " }, user: { value: "metabase" }, client: { value: "" } } };
  let prevented = false;
  run.asked.length = 0;
  await on.get("submit")!({ target: form, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(run.asked, ["GET /api/requests?outcome=cancelled&user=metabase"]);
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
  assert.deepEqual(await asked(), [U], "on opening");
  t += 2000;
  assert.deepEqual(await asked(), [], "not at the 2 s poll");
  t += 28_000;
  assert.deepEqual(await asked(), [U], "then every 30 s");
  assert.match(textOf(app.view().users!), /metabase id 0123456789abcdef Active 2026-10-27 09:10 UTC not used in the last 7 days postgres:\/\/metabase@127\.0\.0\.1:5433\/shop Copy Remove old id aaaaaaaaaaaaaaaa Removed 2026-10-02 10:00 UTC 2026-10-01 10:00 UTC$/);
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
  run.answers.set("GET /api/events?limit=100", answer(UL_EVENTS));
  run.answers.set("GET /api/logs?lines=200", answer(LOG));
};

test("Usage: the statements of the last day and week are mason status's words in a table with the windows as columns, and a short log says so", () => {
  const renderQueries = fnOf<[unknown], string>(usagePage, "renderQueries");
  const cli = commands.queryLines(UL_QUERIES.queries as never, PLAIN_STYLE).join("\n");
  const text = textOf(renderQueries(UL_QUERIES.queries));
  assert.match(text, /^Last day Last week Statements 1,204 9 Completed 1,190 1,190 Refused 10 10 Failed 2 2 Cancelled 2 2 Rows 52,000 52,000 Bytes sent 3\.0 MiB 512 B Duration, average \/ p50 \/ p95 \(the completed ones'\) 120 \/ 40 \/ 900 ms – /);
  // each cell the page re-says is the CLI's, held equal
  for (const piece of ["1,204 statements: 1,190 completed, 10 refused, 2 failed, 2 cancelled", "120 / 40 / 900 ms", "52,000 rows, 3.0 MiB sent", "512 B sent", "(the request log keeps 3 days: MASON_REQUEST_LOG_DAYS)"]) assert.ok(cli.includes(piece), piece);
  assert.equal(fnOf<[unknown], string>(usagePage, "durationsText")(UL_QUERIES.queries.day.durationMs), "120 / 40 / 900 ms");
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
  assert.match(text, /^From 2026-10-27 09:05 to 2026-10-28 09:05 UTC, 60 min a line \(a sample every 60 s, kept 7 days\)\./);
  assert.match(text, /Time \(UTC\) Statements Errors Rows sent Bytes sent p95 Copy Rows Failing Oldest Memory 2026-10-28 09:05 1,204 3 98,765 4\.4 MiB 1,830 ms 5\.0 GiB 12,345,678 1 75 s 900\.0 MiB \(copy 300\.0 MiB of 8\.0 GiB\) 2026-10-28 10:05 0 98,765 4\.4 MiB – – 12,345,678 – 900\.0 MiB/);
  assert.doesNotMatch(text, /Lag/, "no lag column without a stream");
  assert.match(textOf(renderUsage({ ...UL_USAGE, samples: [{ ...SAMPLE, streamLagSeconds: 3, streamLagBytes: 10 }] })), /Oldest Lag Memory .* 3 s 900/);
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
  assert.deepEqual(await asked(), ["GET /api/queries", "GET /api/usage?since=24h&step=3600"]);
  const v = app.view();
  assert.match(textOf(v["usage-queries"]!), /Statements 1,204/);
  assert.match(textOf(v["usage-hourly"]!), /2026-10-28 09:05 1,204 3/);
  assert.match(textOf(v["usage-sizes"]!), /public\.orders 3\.0 GiB/);
  t += 2000; assert.deepEqual(await asked(), [], "2 s on: nothing is due");
  t += 58_000; assert.deepEqual(await asked(), ["GET /api/queries", "GET /api/usage?since=24h&step=3600"], "60 s on: both again");
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

test("Logs: the sync's events are mason logs --events' lines in a table, a failure marked, newest last; none is said as the CLI says it", () => {
  const renderEvents = fnOf<[unknown], string>(logsPage, "renderEvents"), cells = fnOf<[unknown], Record<string, string>>(logsPage, "eventCells");
  for (const e of UL_EVENTS.events) {
    const c = cells(e);
    assert.equal(commands.eventLine(e as never, PLAIN_STYLE), `${c.time}  ${c.kind!.padEnd(18)}  ${c.table}  ${c.message}`, "the CLI's line, cell for cell");
  }
  const html = renderEvents(UL_EVENTS);
  assert.equal(textOf(html), "Time (UTC) Kind Table Message 2026-10-28 09:00:00 copied public.orders copied 2,000,000 rows 2026-10-28 09:01:00 ✗ copy_failed (failed) public.events the source closed the connection the sync tries it again in 5 min 2026-10-28 09:05:00 ✗ restart (failed) (the sync) the run stopped <b>after</b> 42 s");
  assert.equal([...html.matchAll(/class="t-failed"/g)].length, 2, "the failures are marked");
  assert.doesNotMatch(html, /<b>/, "a message is escaped");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 7 })), "No sync event in the last 7 days (MASON_REQUEST_LOG_DAYS).");
  assert.equal(textOf(renderEvents({ events: [], keptDays: 1 })), "No sync event in the last 1 day (MASON_REQUEST_LOG_DAYS).");
});

test("Logs: the run's entries are rows, oldest first so the newest is at the bottom, a multi-line entry kept as one preformatted row", () => {
  const renderLogs = fnOf<[unknown], string>(logsPage, "renderLogs");
  const html = renderLogs(LOG);
  assert.equal([...html.matchAll(/<th scope="row">/g)].length, 2, "two entries, two rows");
  assert.ok(html.indexOf("mason started") < html.indexOf("copy: public.orders"));
  assert.match(html, /<pre>copy: public\.orders\n {2}chunk 3 of 20 &lt;read&gt;<\/pre>/);
  assert.match(textOf(html), /^Time \(UTC\) Entry 2026-10-28 09:00:00 mason started copy: public\.orders chunk 3 of 20 <read> The last 2 of at most 2000 entries/);
  assert.match(textOf(renderLogs({ lines: [], kept: 2000 })), /The run has logged nothing yet\./);
});

test("Logs: reads the events every 10 s and the log every 5 s, only while shown; a refusal of the log is its Failure under it, the events' the banner", async () => {
  const run = fakeRun(); withUsageAnswers(run);
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  app.show("logs");
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET /api/events?limit=100", "GET /api/logs?lines=200"]);
  assert.match(textOf(app.view()["logs-events"]!), /✗ copy_failed/);
  assert.match(textOf(app.view()["logs-run"]!), /mason started/);
  t += 2000; assert.deepEqual(await asked(), [], "2 s on: neither is due");
  t += 3000; assert.deepEqual(await asked(), ["GET /api/logs?lines=200"], "5 s on: the log alone");
  t += 5000; assert.deepEqual(await asked(), ["GET /api/events?limit=100", "GET /api/logs?lines=200"], "10 s on: both");
  app.show("usage"); assert.deepEqual((await asked()).some((p) => p.includes("/api/logs")), false, "not while another page is shown");
  app.show("logs");
  run.answers.set("GET /api/logs?lines=200", answer({ error: "lines is a whole number of log entries, 1 to 2000", failure: { code: "failed", message: "lines is a whole number of log entries, 1 to 2000", next: [] } }, 400));
  t += 10_000; await app.poll();
  assert.match(textOf(app.view()["logs-run"]!), /^✗ lines is a whole number of log entries, 1 to 2000 Time \(UTC\) Entry/);
  assert.equal(app.view().poll, "");
  run.answers.set("GET /api/events?limit=100", answer({ error: "no", failure: { code: "failed", message: "the events cannot be read", next: [] } }, 500));
  t += 10_000; await app.poll();
  assert.match(textOf(app.view().poll!), /✗ the events cannot be read/);
});

test("Usage and Logs: the index.html has the parts the pages write, the placeholders' parts are gone", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const id of ["usage-queries", "usage-hourly", "usage-sizes", "logs-events", "logs-run"]) assert.match(html, new RegExp(`<div id="${id}"></div>`), id);
  assert.doesNotMatch(html, /<div id="usage"><\/div>|<div id="logs"><\/div>/);
});

test("Users: a user's last use is mason user list's words (lastUsedText, src/cli/user.ts), a time, unknown, or not used within the log's days", async () => {
  const cli = await import("../src/cli/user.ts") as unknown as { lastUsedText?: (at: string | null, note: string | null, days: number | null) => string };
  assert.equal(typeof cli.lastUsedText, "function", "src/cli/user.ts exports lastUsedText");
  const usersPage = await import(path.join(WEB, "pages", "users.js") as string) as { lastUsedText: (u: { lastUsedAt: string | null }, note: string | null, days: number | null) => string };
  for (const [at, note, days] of [["2026-10-27T09:10:11.000Z", null, 7], [null, "unknown: Mason is not running", null], [null, null, 7], [null, null, null]] as const) {
    assert.equal(usersPage.lastUsedText({ lastUsedAt: at }, note, days), cli.lastUsedText!(at, note, days), `${at} ${note} ${days}`);
  }
});
