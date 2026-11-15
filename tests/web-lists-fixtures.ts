/**
 * EVERY PAGE OF THE WEB PAGE, SERVED WITH LONG NAMES AND LONG MESSAGES (issue 1049), for the tests that measure the
 * page in a browser (tests/web-lists-layout.test.ts). The page's own files (PAGE_ROUTES, from `web`) over the server's
 * own state (`runState` over synthetic copies) and an answer for every read a page makes: the request log, who is
 * connected and who sent queries, the queries running now, the usage samples and each synced table's size, the sync's
 * events, the run's log and the unsupported SQL. Every list on every page has rows, and a row of each holds the
 * longest name or message the run writes there.
 *
 * Synthetic data only (CLAUDE.md "A real database's data and structures are confidential").
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runState, PAGE_ROUTES, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import * as tableSync from "../src/lib/table-sync.ts";
import type { CopyState } from "../src/duck/sync.ts";
import type { SyncEvent } from "../src/duck/events.ts";

/** The page's files in this checkout. */
export const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

/** Every page, by the hash that shows it, and the part of the page its lists are written into once it is read. */
export const PAGES = [
  { id: "overview", hash: "#overview", ready: "#page-status table.tables" },
  { id: "tables", hash: "#tables", ready: "#page-tables table.catalog" },
  { id: "users", hash: "#users", ready: "#page-users table.users" },
  { id: "queries", hash: "#observability/queries", ready: "#page-queries table.requests" },
  { id: "usage", hash: "#observability/usage?range=24h", ready: "#page-usage table.sizes" },
  { id: "syncs", hash: "#observability/syncs", ready: "#page-syncs table.events tbody tr" },
] as const;

// ------------------------------------------------------------------ the state: tables of every phase, long names

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
/** A name of 60 characters, as long as the rules' fixtures write one (.claude/rules/web-ui.md "bounded"). */
export const LONG = "customer_subscription_billing_events_archive_2026_full_hist";
const table = (name: string, rows: number, key = ["id"]): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key, rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("status")], foreignKeys: [] });
const TABLES = [table("customers", 1200), table("orders", 40_000_000), table("order_items", 3000), table(LONG, 90_000), table("events", 70_000),
  table("audit", 50), table("raw_log", 7, []), table(`${LONG}_x`, 12), table("locked_for_running_sync", 40)];
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const ADDED = ["customers", "orders", "order_items", LONG, "events"];
const FILE = parseSourceText(`kind: postgres\nurl: x\ntables:\n${ADDED.map((n) => `  ${n}: {}\n`).join("")}`, "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const at = "2026-11-11T09:00:00.000Z";
const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
const COPIES: CopyState[] = [
  { source: "public.customers", phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null, kept },
  { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null,
    error: "could not read the next chunk of the table from the source: the connection was reset by the server while reading chunk 14 of 220\nthe sync tries it again in 5 min" },
  { source: "public.order_items", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 1000, rowsEstimate: 3000,
    progress: { chunksDone: 1, chunksTotal: 3, reading: 1, readingSeconds: 2, rowsReading: 500, rowsPerSecond: 500, bytesPerSecond: 1e5, secondsLeft: 4, share: 0.33 } },
  { source: `public.${LONG}`, phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 30_000, rowsEstimate: 90_000,
    progress: { chunksDone: 3, chunksTotal: 9, reading: 2, readingSeconds: 20, rowsReading: 5000, rowsPerSecond: 1500, bytesPerSecond: 1e6, secondsLeft: 40, share: 0.33 } },
];
/** Who is connected now: long user names and clients, and more clients than the list shows. */
const BY_CLIENT = [
  { user: "metabase", client: "Metabase v0.50.21 (production analytics, read replica)", open: 12, running: 3 },
  { user: "analytics_service_account_for_dashboards", client: "psql", open: 2, running: 0 },
  ...Array.from({ length: 12 }, (_, i) => ({ user: `u${i}`, client: `client ${i}`, open: 1, running: 0 })),
];
/** A user, so the Overview lists the tables not synced yet rather than its Getting started (a run's users file). */
const USERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mason-web-lists-"));
process.on("exit", () => fs.rmSync(USERS_DIR, { recursive: true, force: true }));
const USERS_FILE = path.join(USERS_DIR, "users.json");
fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: at, key: "k" }] }));
const STATE = (() => {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    users: { file: USERS_FILE, apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }), listener: { openSessions: () => ({ open: 14, byClient: BY_CLIENT }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, COPIES, null, Date.parse(at)))) as Record<string, unknown>;
})();

// ------------------------------------------------------------------ the other reads, relative to now

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const STATEMENT = `SELECT customer_id, date_trunc('day', created_at) AS day, sum(total) AS revenue, count(DISTINCT order_id) AS orders FROM public.${LONG} WHERE status IN ('paid', 'shipped') GROUP BY 1, 2 ORDER BY 2 DESC`;
const request = (i: number, o: Record<string, unknown> = {}) => ({ requestId: `r-${i}`, startedAt: ago(60_000 * i), session: 3 + i, applicationName: "Metabase v0.50.21 (production analytics, read replica)",
  tokenName: "", user: "analytics_service_account_for_dashboards", method: "QUERY", outcome: "ok", status: "completed", sqlstate: null, message: null, detail: null, hint: null,
  rows: 1_234_567, durationMs: 7_384_000, endedAt: ago(60_000 * i - 1000), bytesSent: 98_765_432, query: STATEMENT, queryTruncated: false, ...o });
const REQUESTS = [request(1), request(2, { outcome: "refused", status: "failed", sqlstate: "0A000", rows: null, durationMs: 3,
  message: `Mason does not support a window frame in GROUPS mode: ${"the frame ".repeat(20)}` }), request(3, { user: "u", applicationName: "", query: "SELECT 1", rows: 1, durationMs: 0.4 }),
  request(4, { method: "EXECUTE", status: "cancelled", outcome: "cancelled", sqlstate: "57014", message: "canceling statement due to user request", rows: null })];
const WINDOW = { days: 1, covered: 1, statements: 1_234_567, completed: 1_200_000, refused: 30_000, failed: 3_000, cancelled: 1_000, rows: 98_765_432, bytesSent: 5_400_000_000,
  durationMs: { avg: 42, p50: 12, p95: 380_000 } };
const CLIENTS = [{ user: "analytics_service_account_for_dashboards", tokenName: "", client: "Metabase v0.50.21 (production analytics, read replica)", statements: 1_100_000, failed: 9_000, sessions: 300, last: ago(30_000) },
  { user: "", tokenName: "ci", client: "", statements: 104, failed: 0, sessions: 1, last: ago(3_600_000) }];
const ACTIVITY = { since: ago(86_400_000), keptDays: 7, window: WINDOW, clients: CLIENTS, slowest: [request(5), request(6, { query: "" })], clientsTotal: { clients: 2, sessions: 301 } };
const RUNNING = { running: [
  { session: 12_345, statement: 45_678, user: "analytics_service_account_for_dashboards", applicationName: "Metabase v0.50.21 (production analytics, read replica)", method: "QUERY",
    startedAt: ago(7_384_000), runningMs: 7_384_000, rows: 12_345_678, query: STATEMENT, queryTruncated: false },
  { session: 13, statement: 7, user: "", applicationName: "", method: "EXECUTE", startedAt: ago(1500), runningMs: 1500, rows: 1, query: "SELECT 1", queryTruncated: false }] };
const SAMPLE = { seconds: 3600, copyBytes: 5 * 2 ** 40, copyRows: 12_345_678_901, tablesAdded: 800, tablesCopied: 799, tablesFailed: 1, oldestSyncSeconds: 86_400 * 3,
  statements: 1_234_567, statementsRefused: 20_000, statementsFailed: 1_000, statementsCancelled: 30, rowsSent: 98_765_432_100, bytesSent: 4_567_890_123_456, durationP50Ms: 12, durationP95Ms: 7_384_000,
  streamLagBytes: 3 * 2 ** 30, streamLagSeconds: 3_600, rssBytes: 900 * 2 ** 30, heapUsedBytes: 80 * 2 ** 20, copyMemoryBytes: 300 * 2 ** 30, copyMemoryLimitBytes: 800 * 2 ** 30 };
const usage = () => ({ since: ago(86_400_000), until: ago(0), stepSeconds: 3600, sampleSeconds: 60, keptDays: 7,
  samples: Array.from({ length: 24 }, (_, i) => ({ ...SAMPLE, at: ago(3_600_000 * (24 - i)) })),
  copySizes: [{ table: `public.${LONG}`, bytes: 3 * 2 ** 40, at: ago(60_000) }, { table: "public.customers", bytes: 40_000, at: ago(60_000) }] });
const counts = { added: 1_234_567, updated: 89_012, deleted: 3_456, rows: 12_345_678 };
const EVENTS = (): SyncEvent[] => [
  { at: ago(9 * 86_400_000), kind: "restart", failed: false, table: null, message: "Mason restarted", code: null, origin: null, tookMs: null },
  { at: ago(3 * 86_400_000), kind: "full_sync", failed: false, table: `public.${LONG}`, message: `synced whole: ${tableSync.syncedText({ ...counts, ms: 7_384_000 }, "exact")}`, code: null, origin: null, tookMs: 7_384_000 },
  { at: ago(86_400_000), kind: "full_sync_failed", failed: true, table: "public.order_items", message: "full sync: connection to the source was lost while reading chunk 14 of 220\nthe sync tries it again in 30 s", code: "ECONNRESET", origin: "src/duck/sync.ts:3640", tookMs: null },
  { at: ago(7_200_000), kind: "generated_failed", failed: true, table: `public.${LONG}`, message: "generated table: the query failed", code: "42P01", origin: "src/duck/generated.ts:210", tookMs: null },
  { at: ago(3_600_000), kind: "synced", failed: false, table: "public.customers", message: `synced by hand: ${tableSync.syncedText({ ...counts, ms: 13_703 }, "exact")}`, code: null, origin: null, tookMs: 13_703 },
  // a usual name of 30 characters, the longest Sync events holds whole (issue 1049)
  { at: ago(30_000), kind: "synced", failed: false, table: "public.locked_for_running_sync", message: `synced by hand: ${tableSync.syncedText({ ...counts, ms: 2_500 }, "exact")}`, code: null, origin: null, tookMs: 2_500 },
  { at: ago(60_000), kind: "polled", failed: false, table: "public.orders", message: `synced on schedule: ${tableSync.syncedText({ ...counts, ms: 570 }, "poll")}`, code: null, origin: null, tookMs: 570 },
];
const UNSUPPORTED = () => ({ since: ago(86_400_000), keptDays: 7, unsupported: [
  { gap: "frame-groups", title: "a window frame in GROUPS mode", runs: 12_345, users: ["analytics_service_account_for_dashboards", "metabase"], clients: ["Metabase v0.50.21 (production analytics, read replica)"],
    last: ago(30_000), example: `SELECT sum(amount) OVER (ORDER BY day GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM orders WHERE ${"x = 1 AND ".repeat(40)}true` }] });
const USERS = { users: [
  { name: "metabase", id: "0123456789abcdef", addedAt: at, live: true, from: null, lastUsed: ago(30_000) },
  { name: "analytics_service_account_for_dashboards", id: "fedcba9876543210", addedAt: at, live: true, from: ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8:1234:5678::/64"], lastUsed: ago(3_600_000) },
  { name: "looker", id: "aaaabbbbccccdddd", addedAt: at, disabledAt: at, live: true, from: null, lastUsed: null }], lastUsedNote: null, requestLogDays: 7 };
const QUERIES = { queries: { keptDays: 7, day: WINDOW, week: { ...WINDOW, days: 7, covered: 7 } } };
const LOGS = { kept: 2000, lines: [{ at: ago(60_000), text: `copy: public.${LONG}: chunk 3 of 20 read, ${"x".repeat(300)}` }] };

/** Serves the page from `web` (this checkout's by default) on a port of loopback; `close` stops it. */
export async function serveThePage(web = WEB): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const p = url.pathname;
    if (p === "/api/state") return json(STATE);
    if (p === "/api/requests") return json({ requests: REQUESTS, keptDays: 7, before: null });
    if (p === "/api/users") return json(USERS);
    if (p === "/api/share/choices") return json({ choices: [], role: null, reads: "every synced table" });
    if (p === "/api/activity") return json(ACTIVITY);
    if (p === "/api/running") return json(RUNNING);
    if (p === "/api/usage") return json(usage());
    if (p === "/api/events") return json({ events: EVENTS(), keptDays: 7 });
    if (p === "/api/logs") return json(LOGS);
    if (p === "/api/queries") return json(QUERIES);
    if (p === "/api/unsupported") return json(UNSUPPORTED());
    if (p.startsWith("/api/")) return json({});
    const route = PAGE_ROUTES[p];
    if (route === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": route[1] });
    res.end(fs.readFileSync(path.join(web, route[0])));
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
