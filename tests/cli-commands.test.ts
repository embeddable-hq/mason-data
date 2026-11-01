/**
 * The commands beside `mason start` (src/cli/commands.ts, runs.ts): which table a command means, what `mason add`
 * reads, when `mason wait` says ready, and how every table, the stream and the request log are rendered.
 */
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { PLAIN } from "../src/cli/style.ts";
import type { Failure } from "../src/cli/command.ts";
import * as assert from "node:assert/strict";
import { generatedReadiness } from "../src/cli/readiness.ts";
import type { GeneratedStatus } from "../src/duck/generated.ts";
import { addSpecs, addSteps, copyProgress, duration, findTable, paintBar, readiness, SAY_AGAIN_MS, sayAgain, STATUS, tableLines, WAIT, type RunState, type TableState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";
import { jsonText } from "../src/cli/command.ts";
import type { CopyProgressView, KeptCurrent, StreamStatus } from "../src/duck/sync.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { connectSource, parseSource, readSourceFacts } from "../src/cli/preflight.ts";
import { readSource } from "../src/cli/sources.ts";
// read from the module's namespace: at a commit without timeOf the file loads, and the test fails by name
const { timeOf } = await import("../src/cli/request-filter.ts") as unknown as { timeOf: (name: string, text: string, now: number) => string | { message: string } };
import { DemoSource } from "../src/demo/source.ts";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";

test("mason add: tables by name, every column unless --columns names them, --include on top; one table per --columns", () => {
  // the columns are an option, --columns, never a DSL of their own
  assert.deepEqual(addSpecs(["orders"], undefined, undefined), [{ table: "orders", columns: ["*"], key: null }]);
  assert.deepEqual(addSpecs(["orders", "billing.invoices"], undefined, undefined), [{ table: "orders", columns: ["*"], key: null }, { table: "billing.invoices", columns: ["*"], key: null }]);
  assert.deepEqual(addSpecs(["orders"], "id, status ,created_at,status", undefined), [{ table: "orders", columns: ["id", "status", "created_at"], key: null }]);
  assert.deepEqual(addSpecs(["users"], undefined, "password_hash"), [{ table: "users", columns: ["*", "password_hash"], key: null }], "a secret-looking column, named on purpose");
  assert.deepEqual(addSpecs(["users"], "id,email", "password_hash,email"), [{ table: "users", columns: ["id", "email", "password_hash"], key: null }]);
  // a table with no primary key: --key names the columns it is copied by, one table at a time
  assert.deepEqual(addSpecs(["event_log"], undefined, undefined, "tenant_id, id"), [{ table: "event_log", columns: ["*"], key: ["tenant_id", "id"] }]);
  assert.match(addSpecs(["a", "b"], undefined, undefined, "id") as string, /--key is one table's key, and 2 tables are named/);
  assert.match(addSpecs(["orders", "customers"], "id", undefined) as string, /--columns is one table's list, and 2 tables are named: add them one at a time \(mason add orders --columns …\)/);
  assert.match(addSpecs([], undefined, undefined) as string, /name a table: mason add orders/);
  assert.match(addSpecs(["orders"], " , ", undefined) as string, /--columns names no column/);
});

const t = (o: Partial<TableState> & { table: string }): TableState => ({
  rows: 1, bytes: 1, key: ["id"], comment: null, columns: [], reason: null,
  added: false, addedColumns: null, copyKey: null, copy: null, error: null, ...o,
});

test("a table is named as the database names it: by its name alone in public, or when one schema has it; else schema.table", () => {
  const tables = [t({ table: "public.orders" }), t({ table: "billing.invoices" }), t({ table: "public.invoices" })];
  assert.equal((findTable(tables, "orders") as TableState).table, "public.orders");
  assert.equal((findTable(tables, "billing.invoices") as TableState).table, "billing.invoices");
  assert.equal((findTable(tables, "invoices") as TableState).table, "public.invoices", "a bare name is public's, as in the sources file");
  assert.equal((findTable(tables, "billing_invoices") as Failure).code, "not_found", "an older Mason's schema_table name for it means nothing");
  // a miss is a failure with its way out: the schema to name, or the command that lists the tables (src/cli/command.ts Failure)
  const several = findTable([t({ table: "a.x" }), t({ table: "b.x" })], "x") as Failure;
  assert.match(several.message, /in several schemas \(a\.x, b\.x\)/);
  assert.match(several.fix!, /schema\.table/);
  // a third part is refused by name (a wrong command line: exit 2), with the table its last two parts come closest to
  assert.deepEqual(findTable(tables, "shop.billing.invoices"), { code: "usage",
    message: "shop.billing.invoices has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two — did you mean `billing.invoices`?" });
  assert.deepEqual(findTable(tables, "shop.public.order"), { code: "usage", message: "shop.public.order has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two — did you mean `orders`?" });
  assert.deepEqual(findTable(tables, "a.b.c"), { code: "usage", message: "a.b.c has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two" });
  const none = findTable(tables, "nope") as Failure;
  assert.match(none.message, /no table "nope"/);
  assert.deepEqual([none.code, none.next![0]![0]], ["not_found", "mason tables"]);
});

const at = (s: number): string => new Date(Date.UTC(2026, 9, 7, 10, 0, s)).toISOString();
const state = (o: { tables?: TableState[]; stream?: StreamStatus }): RunState => ({
  source: { url: "postgres://x", database: "shop", remote: false, version: "16", standby: false, changes: "poll", name: "shop", file: "/app/mason/sources/shop.yml" }, warnings: [], folder: "/app/mason",
  project: "v1", tables: o.tables ?? [], engine: { file: "/app/.mason/duck.db", bytes: 10 },
  ...(o.stream ? { stream: o.stream } : {}),
});

test("mason wait: ready once every added table is copied; a copy still running or not started waits; a failed copy is a failure, said", () => {
  assert.deepEqual(readiness(state({})), { ready: true, failed: [], waiting: [] }, "nothing added: nothing to wait for");
  const copying = t({ table: "public.orders", added: true, rows: 1000, copy: { phase: "copying", rowsCopied: 250, updatedAt: "" } });
  const waiting = t({ table: "public.lines", added: true });
  const done = t({ table: "public.customers", added: true, copy: { phase: "done", rowsCopied: 7, updatedAt: at(5) } });
  const notAdded = t({ table: "public.logs", copy: null });
  assert.deepEqual(readiness(state({ tables: [copying, waiting, done, notAdded] })),
    { ready: false, failed: [], waiting: ["public.orders: syncing 25% · 250 of ~1,000 rows", "public.lines: waiting for its first sync to start"] });
  assert.deepEqual(readiness(state({ tables: [done, notAdded] })), { ready: true, failed: [], waiting: [] });
  // a copy that failed: the sync tries again by itself, but an agent waiting is told now, with the reason's first line
  const failed = t({ table: "public.big", added: true, copy: { phase: "failed", rowsCopied: 0, updatedAt: "" }, error: "permission denied for table big\nmore" });
  assert.deepEqual(readiness(state({ tables: [failed, done] })), { ready: false, failed: ["public.big: permission denied for table big"], waiting: [] });
});

test("mason wait <generated table>: ready once a base change committed before the wait is in the chain; one after it does not hold it; a failed run or a blocking parent is a failure", () => {
  const since = Date.parse("2026-10-29T09:00:00.000Z");
  const g = (extra: Partial<GeneratedStatus>): GeneratedStatus => ({ table: "public.daily", file: "mason/generated_tables/daily.yml", kind: "scheduled", method: "whole", state: "current",
    targetLag: "1m", behindSeconds: 0, behindSince: null, missingTarget: false, serving: true, lastRun: null, error: null, retryAt: null, refusals: [], waitingFor: null, warnings: [], ...extra });
  const behind = g({ state: "behind", behindSeconds: 12, behindSince: "2026-10-29T08:59:50.000Z" });
  assert.deepEqual(generatedReadiness(behind, since), { ready: false, failed: [], waiting: ["public.daily: 12 s behind its bases; its next run brings in what was synced before the wait"] });
  assert.deepEqual(generatedReadiness(g({}), since), { ready: true, failed: [], waiting: [] }, "the chain's run brought it in");
  assert.equal(generatedReadiness(g({ state: "behind", behindSeconds: 1, behindSince: "2026-10-29T09:00:01.000Z" }), since).ready, true, "only a change after the wait began");
  assert.equal(generatedReadiness(g({ state: "behind", behindSince: "2026-10-29T09:00:00.000Z" }), since).ready, false, "a change at the wait's start counts as before it");
  assert.deepEqual(generatedReadiness(g({ serving: false, state: "building" }), since).waiting, ["public.daily: being built"]);
  assert.deepEqual(generatedReadiness({ ...behind, state: "failed", error: "division by zero\nmore" }, since).failed, ["public.daily: its last run failed: division by zero"]);
  assert.deepEqual(generatedReadiness(g({ serving: false, state: "waiting", waitingFor: "public.counts failed its last run" }), since).failed, ["public.daily: not run, because public.counts failed its last run"]);
  assert.deepEqual(generatedReadiness(g({ serving: false, state: "refused", refusals: [{ key: "target_lag", message: "target_lag 1s is shorter", why: "", options: [], text: "" }] }), since).failed,
    ["public.daily: refused: target_lag 1s is shorter"]);
  assert.deepEqual(generatedReadiness(g({ serving: false, state: "waiting", waitingFor: "public.events" }), since).waiting, ["public.daily: waiting for public.events"]);
  assert.deepEqual(generatedReadiness(g({ serving: false, state: "waiting", waitingFor: "public.counts, which is refused" }), since).failed, ["public.daily: not run, because public.counts, which is refused"]);
  // a parent fixed since: said by name alone, so the wait goes on
  assert.deepEqual(generatedReadiness(g({ serving: false, state: "waiting", waitingFor: "public.counts" }), since).failed, []);
  // a wait not drawn in place, the copies' or a generated table's, says its block again every 30 s though nothing changed
  assert.equal(SAY_AGAIN_MS, 30_000);
  assert.deepEqual([sayAgain("a", "a", 0, SAY_AGAIN_MS - 1), sayAgain("a", "a", 0, SAY_AGAIN_MS), sayAgain("b", "a", 0, 1)], [false, true, true]);
});

test("mason wait shows a copy's progress: of the table's estimate, never 100% until it is done, never back once past a stale estimate", () => {
  assert.equal(copyProgress("public.t", 500, 1000), "public.t: syncing 50% · 500 of ~1,000 rows", "a run's state without the chunks' progress");
  assert.equal(copyProgress("public.t", 1500, 1000), "public.t: syncing 99% · 1,500 rows · past the ~1,000 estimated", "an estimate the copy passed: held at 99 %, said");
  assert.equal(copyProgress("public.t", 999, 1000), "public.t: syncing 99% · 999 of ~1,000 rows", "never 100% until the copy says it is done");
  assert.equal(copyProgress("public.t", 10, null), "public.t: syncing 10 rows");
  assert.deepEqual([duration(40), duration(180), duration(6000)], ["40 s", "3 min", "1 h 40 min"]);
});

// A 20 M-row copy from a database over the internet showed no progress: its first line waited on 0 for minutes, then
// jumped to 100%. The rows land a chunk at a time, so the line counts the chunks in flight at the rate the copy
// measured (src/duck/sync.ts copyProgressNow) and says what is happening.
test("mason wait and status move between a copy's commits: the chunks reading, for how long, the measured rate and the time left", () => {
  const view = (o: Partial<CopyProgressView>): CopyProgressView => ({ chunksDone: 0, chunksTotal: 11, reading: 0, readingSeconds: null, rowsReading: 0,
    rowsPerSecond: null, bytesPerSecond: null, secondsLeft: null, share: 0, ...o });
  const EST = 20_126_276;
  const line = (rowsCopied: number, progress: CopyProgressView): string => tableLines(state({ tables: [
    t({ table: "public.events", added: true, rows: EST, copy: { phase: "copying", rowsCopied, updatedAt: "", progress } })] }))[0]!;
  // NOTHING MEASURED YET: the first chunks are being read, and for how long — never `0 of`
  const first = view({ reading: 3, readingSeconds: 12.4 });
  assert.equal(copyProgress("public.events", 0, EST, first), "public.events: syncing 0% · reading the first 3 chunks (12 s) · ~20,126,276 rows to sync");
  assert.equal(line(0, view({ reading: 1, readingSeconds: 12 })), "public.events  ░░░░░░░░░░░░░░░░░░░░   0%  reading the first chunk (12 s) · ~20,126,276 rows to sync");
  assert.doesNotMatch(line(0, first), /\b0 of\b/);
  // CHUNKS IN FLIGHT: the committed rows plus what the three reading have read by now at the measured rate
  const flying = view({ chunksDone: 4, chunksTotal: 46, reading: 3, readingSeconds: 48, rowsReading: 431_000, rowsPerSecond: 41_000, bytesPerSecond: 4e7, secondsLeft: 540, share: 0.12 });
  assert.equal(copyProgress("public.events", 2_000_000, EST, flying),
    "public.events: syncing 12% · 2,431,000 of ~20,126,276 rows · 3 chunks reading (48 s), 4 of ~46 in · 41,000 rows/s · ~9 min left");
  assert.equal(line(2_000_000, flying), "public.events  ██░░░░░░░░░░░░░░░░░░  12%  syncing 2,431,000 of ~20,126,276 rows · 3 chunks reading (48 s), 4 of ~46 in · 41,000 rows/s · ~9 min left");
  // a poll later, the same commit: the bar moved though no chunk committed
  assert.equal(line(2_000_000, { ...flying, readingSeconds: 58, rowsReading: 1_250_000, share: 0.16 }),
    "public.events  ███░░░░░░░░░░░░░░░░░  16%  syncing 3,250,000 of ~20,126,276 rows · 3 chunks reading (58 s), 4 of ~46 in · 41,000 rows/s · ~9 min left", "it moves at every poll");
  // THE LAST CHUNK: one reading, every other in; then every chunk read, the copy checked and swapped in
  assert.equal(copyProgress("public.events", 19_500_000, EST, view({ chunksDone: 45, chunksTotal: 46, reading: 1, readingSeconds: 7, rowsReading: 300_000, rowsPerSecond: 41_000, secondsLeft: 4, share: 0.98 })),
    "public.events: syncing 98% · 19,800,000 of ~20,126,276 rows · 1 chunk reading (7 s), 45 of ~46 in · 41,000 rows/s · ~4 s left");
  assert.equal(copyProgress("public.events", 20_126_276, EST, view({ chunksDone: 46, chunksTotal: 46, rowsPerSecond: 41_000, secondsLeft: 0, share: 0.99 })),
    "public.events: syncing 99% · 20,126,276 of ~20,126,276 rows · every chunk read (46): checking it and swapping it in · 41,000 rows/s");
  // a copy resumed: its rows from before, its first chunk of this attempt not measured yet
  assert.equal(copyProgress("public.events", 6_000_000, EST, view({ chunksDone: 3, reading: 3, readingSeconds: 2, share: 0.3 })),
    "public.events: syncing 30% · 6,000,000 of ~20,126,276 rows · resumed, reading the first 3 chunks (2 s)");
  // A COPY THAT OUTRUNS THE ESTIMATE (23,719,703 rows under an estimate of 20,126,276, and the bar went back to
  // `0% syncing 21,385,158 rows`): the share is the heap's pages read, exact, so it holds; the text says it is past it
  const past = view({ chunksDone: 140, chunksTotal: 151, reading: 2, readingSeconds: 9, rowsReading: 85_158, rowsPerSecond: 41_000, secondsLeft: 70, share: 0.9 });
  assert.equal(copyProgress("public.events", 21_300_000, EST, past),
    "public.events: syncing 90% · 21,385,158 rows · past the ~20,126,276 estimated · 2 chunks reading (9 s), 140 of ~151 in · 41,000 rows/s · ~70 s left");
  assert.equal(line(21_300_000, past), "public.events  ██████████████████░░  90%  syncing 21,385,158 rows · past the ~20,126,276 estimated · 2 chunks reading (9 s), 140 of ~151 in · 41,000 rows/s · ~70 s left");
  // NEVER BACKWARDS: the share across the estimate, at every poll, with the chunks' progress and without it
  let last = -1;
  for (const [rows, share] of [[19_000_000, 0.8], [20_100_000, 0.85], [20_126_277, 0.851], [21_385_158, 0.9], [23_000_000, 0.97]] as const) {
    for (const s of [line(rows, view({ ...past, share })), tableLines(state({ tables: [t({ table: "public.events", added: true, rows: EST, copy: { phase: "copying", rowsCopied: rows, updatedAt: "" } })] }))[0]!]) {
      const pct = Number(/ (\d+)%  /.exec(s)![1]);
      assert.ok(pct >= (s.includes("chunks reading") ? last : 0) && pct >= 80, `${rows} rows: ${s}`);
      if (s.includes("chunks reading")) last = pct;
      assert.doesNotMatch(s, / 0%  /, "never back to 0 % once past the estimate");
    }
  }
});

test("mason wait: every added table on its line — the finished first in the order they finished, then the failed, the copying, the waiting", () => {
  // after mason add a b c, where a and c copy quickly, mason wait showed only b: so a line for each table, 100% for those
  // that are up to date, and a progress bar
  const lines = tableLines(state({ tables: [
    t({ table: "public.waiting", added: true }),
    t({ table: "public.copying", added: true, rows: 1000, copy: { phase: "copying", rowsCopied: 250, updatedAt: at(9) } }),
    t({ table: "public.later", added: true, copy: { phase: "done", rowsCopied: 7, updatedAt: at(5) } }),
    t({ table: "public.zfirst", added: true, copy: { phase: "done", rowsCopied: 1234, updatedAt: at(2) } }),
    t({ table: "public.broken", added: true, copy: { phase: "failed", rowsCopied: 0, updatedAt: at(8) }, error: "permission denied\nmore" }),
    t({ table: "public.not_added", copy: null }),
  ] }));
  assert.deepEqual(lines, [
    "public.zfirst   ████████████████████ 100%  1,234 rows · synced",
    "public.later    ████████████████████ 100%  7 rows · synced",
    "public.broken   ████████████████████ 100%  its first sync failed: permission denied",
    "public.copying  █████░░░░░░░░░░░░░░░  25%  syncing 250 of ~1,000 rows",
    "public.waiting  ░░░░░░░░░░░░░░░░░░░░   0%  waiting for its first sync to start",
  ]);
  // on a terminal: green copied, red failed, cyan at work
  const st = { ...PLAIN, red: (x: string) => `<r>${x}</r>`, green: (x: string) => `<g>${x}</g>`, cyan: (x: string) => `<c>${x}</c>` };
  assert.match(paintBar(lines[0]!, st), /<g>█{20}<\/g>/);
  assert.match(paintBar(lines[2]!, st), /<r>█{20}<\/r>/);
  assert.match(paintBar(lines[3]!, st), /<c>█{5}<\/c>/);
});

test("mason status and wait: each copied table says how it is kept current and how old its copy is — its sync: off with the command that syncs it, or its poll's interval and last poll", () => {
  // issue 33: a copy days old answers today's count(*) wrongly, and nothing but these lines tells a person so
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const off = { mode: "off" } as const, every30 = { mode: "poll", every: "30s", seconds: 30 } as const;
  const lines = tableLines(state({ tables: [
    t({ table: "public.orders", added: true, rows: 22_086_165, copy: { phase: "done", rowsCopied: 22_086_165, updatedAt: at(2) },
      kept: { by: "poll", sync: off, syncedAt: "2026-10-26T11:00:00.000Z", nextAt: null } }),
    t({ table: "shop.events", added: true, copy: { phase: "done", rowsCopied: 3, updatedAt: at(3) }, kept: { by: "poll", sync: every30, syncedAt: "2026-10-29T11:59:56.000Z", nextAt: "2026-10-29T12:00:26.000Z" } }),
    t({ table: "public.fresh", added: true, copy: { phase: "done", rowsCopied: 5, updatedAt: at(4) }, kept: { by: "poll", sync: every30, syncedAt: null, nextAt: "2026-10-29T12:00:00.000Z" } }),
    t({ table: "public.small", added: true, copy: { phase: "done", rowsCopied: 7, updatedAt: at(5) } }),
  ] }), now);
  assert.deepEqual(lines, [
    "public.orders  ████████████████████ 100%  22,086,165 rows · synced · sync: off, last synced 3 days ago — mason sync orders syncs it now; sync: poll 5m on its entry polls it",
    "shop.events    ████████████████████ 100%  3 rows · synced · polled every 30s, last 4 s ago",
    "public.fresh   ████████████████████ 100%  5 rows · synced · polled every 30s, not polled yet",
    "public.small   ████████████████████ 100%  7 rows · synced",
  ]);
  // an `off` table is copied as its sync asks: its bar is green, never a warning's colour; one not kept current is yellow
  const st = { ...PLAIN, yellow: (x: string) => `<y>${x}</y>`, green: (x: string) => `<g>${x}</g>` };
  assert.match(paintBar(lines[0]!, st), /<g>█{20}<\/g>/);
  const behind = tableLines(state({ tables: [t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 1, updatedAt: at(1) },
    kept: { by: "poll", sync: every30, syncedAt: "2026-10-29T11:00:00.000Z", nextAt: null, pending: "its columns changed: it is read again whole, then caught up by one poll" } })] }), now);
  assert.deepEqual(behind, ["public.orders  ████████████████████ 100%  1 rows · synced · NOT kept current (last synced 60 min ago): its columns changed: it is read again whole, then caught up by one poll"]);
  assert.match(paintBar(behind[0]!, st), /<y>█{20}<\/y>/);
  // ready all the same: it is synced and served
  assert.equal(readiness(state({ tables: [t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 1, updatedAt: at(1) }, kept: { by: "poll", sync: off, syncedAt: null, nextAt: null } })] })).ready, true);
});

test("a copy in a layout an older Mason kept says it is copied again, and is still copied, served and ready (src/duck/sync.ts RETIRED_LAYOUT)", () => {
  const retired = t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 2_000_000, updatedAt: at(2), retired: "stored in key order with an index, by an older Mason: read again whole, in heap order" } });
  assert.deepEqual(tableLines(state({ tables: [retired] })), ["public.orders  ████████████████████ 100%  2,000,000 rows · synced · stored in key order with an index, by an older Mason: read again whole, in heap order"]);
  const r = readiness(state({ tables: [retired] }));
  assert.deepEqual([r.ready, r.waiting], [true, []], "its old copy serves: mason wait is ready");
});

test("mason status and wait in replication mode say where the stream is: its position and lag, the last change, and each table streamed, being caught up or left out", () => {
  // the first replication run on a server: one stream line in 35 minutes, and status showed no position, lag or count
  const now = Date.parse("2026-10-26T12:00:10.000Z");
  const stream: StreamStatus = {
    slot: "mason_shop", slotWal: { walHeldBytes: 3 * 2 ** 30, walStatus: "extended", safeWalSizeBytes: 2 ** 30, at: "2026-10-26T12:00:08.000Z" },
    publication: "mason_shop", running: true, failure: null,
    position: "0/1A2B3C8", applied: "0/1A2B300",
    database: { lsn: "0/1A2B4F0", at: "2026-10-26T12:00:08.000Z" },
    lag: { bytes: 296, seconds: 5 },
    lastBatch: { appliedAt: "2026-10-26T12:00:05.300Z", committedAt: "2026-10-26T12:00:05.000Z" },
    tables: [
      { table: "public.orders", state: "streamed", why: null, applied: { inserts: 1_000, updates: 200, deletes: 4, truncates: 0 } },
      { table: "shop.lines", state: "catching-up", why: "caught up by one poll after its whole read",
        catchUp: { phase: "polling", from: "2026-10-26T11:58:02.000Z", startedAt: "2026-10-26T12:00:07.000Z", held: 12, retryAt: null }, applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } },
      { table: "public.events", state: "left-out", why: "publication app_pub does not carry public.events: ALTER PUBLICATION app_pub ADD TABLE public.events", applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } },
      { table: "public.big", state: "waiting", why: "it is being read whole: it joins once synced and caught up by one poll", applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } },
    ],
  };
  // read from the module's namespace: this file loads where it is missing, and the test fails by name (scripts/fails-without.ts)
  const { streamLines } = commands;
  assert.deepEqual(streamLines(stream, now), [
    "position       0/1A2B3C8 · the database is at 0/1A2B4F0: 296 bytes behind (read 2.0 s ago)",
    "slot           holds 3.0 GiB of the database's WAL (extended) · 1.0 GiB more before Postgres invalidates it (max_slot_wal_keep_size) (read 2.0 s ago)",
    "last change    committed 5.0 s ago, applied 0.3 s after its commit",
    "public.orders  streamed · 1,204 changes (1,000 inserts, 200 updates, 4 deletes) this run",
    "shop.lines     catching up by one poll from 2026-10-26 11:58 UTC: polling, for 3.0 s · the stream holds 12 changes of it meanwhile",
    "public.events  left out: publication app_pub does not carry public.events: ALTER PUBLICATION app_pub ADD TABLE public.events",
    "public.big     not streamed yet: it is being read whole: it joins once synced and caught up by one poll",
  ]);
  // a stream that failed says why and when it starts again; a database that could not be asked says so, never a lag of 0
  assert.deepEqual(streamLines({ ...stream, running: false, failure: { error: "replication: the slot is in use\nmore", retryAt: "2026-10-26T12:00:40.000Z" },
    database: { error: "connect ECONNREFUSED" }, slotWal: { error: "the database could not be reached: connect ECONNREFUSED" }, lag: { bytes: null, seconds: null }, lastBatch: null, tables: [] }, now), [
    "stream       not running: replication: the slot is in use · it starts again in 30 s",
    "position     0/1A2B3C8 · the database's position could not be read: connect ECONNREFUSED",
    "slot         the WAL it holds could not be read: the database could not be reached: connect ECONNREFUSED",
    "last change  none applied this run",
  ]);
  // THE SLOT'S WAL, with no cap: said plainly, since a slot nothing reads then holds WAL until the database's disk fills
  const slotLine = (slotWal: StreamStatus["slotWal"]): string => streamLines({ ...stream, slotWal, tables: [] }, now)[1]!;
  assert.equal(slotLine({ walHeldBytes: 512 * 2 ** 20, walStatus: "reserved", safeWalSizeBytes: null, at: "2026-10-26T12:00:00.000Z" }),
    "slot         holds 512.0 MiB of the database's WAL (reserved) · max_slot_wal_keep_size is unset, so nothing caps it: while nothing reads the slot it holds WAL for ever, " +
    "until the database's disk fills (set max_slot_wal_keep_size on the database) (read 10 s ago)");
  assert.match(slotLine({ walHeldBytes: 0, walStatus: "lost", safeWalSizeBytes: null, at: "2026-10-26T12:00:00.000Z" }), /^slot +lost: Postgres invalidated it .*Mason makes it again/);
  assert.match(slotLine({ walHeldBytes: 2 ** 30, walStatus: "unreserved", safeWalSizeBytes: -4096, at: "2026-10-26T12:00:00.000Z" }), /\(unreserved\) · past max_slot_wal_keep_size: Postgres invalidates it at its next checkpoint/);
  // --json: the stream under its declared key, as the run's state has it (jsonText refuses a key its spec does not declare)
  const s: RunState = state({ stream });
  for (const spec of [STATUS, WAIT]) {
    const written = JSON.parse(jsonText(spec, { stream: s.stream }, [["mason status", "what Mason is doing"]])) as { stream: StreamStatus };
    assert.deepEqual(written.stream, stream, `mason ${spec.name} --json writes the stream`);
    assert.match(spec.usage, /\bstream\b/, `mason ${spec.name}'s usage names the stream key`);
  }
});

test("mason status and wait --json say how each table is kept current (kept, src/duck/sync.ts KeptCurrent), and their usage declares its shape", () => {
  // an agent reading --json could not tell how a table was kept current, or why it was not: the text said it, the JSON
  // mapped a copy's fields one by one and left kept out
  const kepts: KeptCurrent[] = [
    { by: "poll", sync: { mode: "poll", every: "30s", seconds: 30 }, syncedAt: at(1), nextAt: at(31), pending: "its columns changed: it is read again whole, then caught up by one poll" },
    { by: "poll", sync: { mode: "off" }, syncedAt: at(1), nextAt: null },
    { by: "recopy", copiedAt: at(2) },
    { by: "replication", slot: "mason_shop", state: "streamed", why: null, position: "0/1A2B3C8", lastCommit: at(3), notRunning: "Mason is stopping", syncedAt: at(3) },
  ];
  // read from the module's namespace: this file loads where it is missing, and the test fails by name (scripts/fails-without.ts)
  const { waitTable } = commands as unknown as { waitTable?: (t: TableState) => Record<string, unknown> };
  assert.ok(waitTable !== undefined, "mason wait --json's table (waitTable)");
  for (const kept of kepts) {
    const added = t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 3, updatedAt: at(1) }, kept });
    const status = JSON.parse(jsonText(STATUS, { tables: [added] })) as { tables: TableState[] };
    assert.deepEqual(status.tables[0]!.kept, kept, `mason status --json, kept by ${kept.by}`);
    const waited = JSON.parse(jsonText(WAIT, { tables: [waitTable(added)] })) as { tables: Array<Record<string, unknown>> };
    assert.deepEqual(waited.tables[0], { table: "public.orders", copy: added.copy, error: null, kept }, `mason wait --json, kept by ${kept.by}`);
  }
  // a table the run's state says nothing of keeping current carries no kept: none is made up
  assert.equal("kept" in waitTable(t({ table: "public.orders", added: true })), false);
  // THE SHAPE, declared where every other is (the usage's --json line, src/cli/command.ts CommandSpec): kept, by, and
  // every field of each way a copy is kept current
  for (const spec of [STATUS, WAIT]) {
    const line = spec.usage.slice(spec.usage.indexOf("--json"));
    assert.match(line, /\bkept\b/, `mason ${spec.name}'s usage names kept`);
    // each table's sync is an object: the declaration names its two shapes
    assert.match(line.replace(/\s+/g, " "), /sync: \{ mode: off \} or \{ mode: poll, every/, `mason ${spec.name}'s usage declares a table's sync`);
  }
  // kept's own declaration, from where it starts to the stopped shape: none of its fields borrowed from the stream's or
  // the tables' declarations
  const from = STATUS.usage.indexOf("Each table's kept");
  const to = STATUS.usage.indexOf("with Mason stopped", from);
  assert.ok(from >= 0 && to > from, "mason status's usage declares kept, before the stopped shape");
  const decl = STATUS.usage.slice(from, to).replace(/\s+/g, " ");
  assert.match(decl, /absent for a table the sync does not hold/);
  for (const k of [...new Set(kepts.flatMap((k) => Object.keys(k)))]) assert.match(decl, new RegExp(`\\b${k}\\b`), `kept's declaration names ${k}`);
  for (const by of ["poll", "recopy", "replication"]) assert.match(decl, new RegExp(`\\{ by: ${by}\\b`), `kept's declaration names by: ${by}`);
  for (const state of ["streamed", "catching-up", "waiting", "left-out"]) assert.match(decl, new RegExp(`\\b${state}\\b`));
  // the sync, the age and the next poll: how old a copy is, declared; pending is present only when it applies, and says
  // why the copy is not kept current, phase included
  assert.match(decl, /syncedAt \(its last whole read or poll\), nextAt \(when its next poll is due; null: off/);
  assert.match(decl, /pending \(only when it applies: why it is not kept current now, its phase included/);
  assert.match(decl, /by: recopy, copiedAt, pending \(only when it applies/);
  assert.match(WAIT.usage.replace(/\s+/g, " "), /pending, when it applies, says why it is not kept current now, its phase included/);
});

test("what to run next over the tables: mason status points at mason tables first; mason tables itself never does", () => {
  const tables = [t({ table: "public.orders" }), t({ table: "public.customers", added: true })];
  assert.deepEqual(addSteps(tables).map((n) => n[0]), ["mason tables", "mason tables orders", "mason add orders"]);
  assert.deepEqual(addSteps(tables, "tables").map((n) => n[0]), ["mason tables orders", "mason add orders"]);
  // everything added: a user for the tool that will query it (mason user is enough; there is no mason connect)
  assert.deepEqual(addSteps([t({ table: "public.a", added: true })]).map((n) => n[0]), ["mason user add <name>", "mason status"]);
});

test("mason status's slow and refused statements: each on one line with its times, its SQLSTATE and the message's first line (src/duck/requests.ts)", () => {
  const { slowLines, refusedLines } = commands;
  assert.deepEqual(slowLines([{ route: "postgres", payload: "SELECT count(*)\n  FROM public.orders\n  GROUP BY status", runs: 1, medianMs: 2500, maxMs: 2500, latestMs: 2500,
    last: "2026-10-26T10:00:05.000Z" }], PLAIN), [
    "\nSlow queries (the last day, still 1 s or more; slowest first):",
    "  2.5 s last time (1 run, median 2.5 s), last 2026-10-26 10:00 UTC",
    "    SELECT count(*) FROM public.orders GROUP BY status",
  ]);
  assert.deepEqual(slowLines([], PLAIN), [], "nothing slow: no section");
  assert.deepEqual(slowLines({ error: "boom\nstack" }, PLAIN), ["\nSlow queries: could not read them (boom; mason logs has the detail)"]);
  const long = `SELECT ${Array.from({ length: 40 }, (_, i) => `c${i}`).join(", ")} FROM public.orders`;
  assert.deepEqual(refusedLines({ total: 14, refused: [
    { route: "postgres", payload: "SELECT * FROM nope", code: "42P01", runs: 12, last: "2026-10-26T10:01:00.000Z", message: 'relation "nope" does not exist' },
    { route: "postgres", payload: long, code: "XX000", runs: 2, last: "2026-10-26T09:00:00.000Z", message: "it broke\nat a stack frame" },
  ] }, PLAIN), [
    "\nRefused queries (the last day: 14 in all, newest first; each message says what to change; mason logs --requests --failed lists each):",
    '  42P01, 12 times, last 2026-10-26 10:01 — SELECT * FROM nope',
    '    relation "nope" does not exist',
    `  XX000, 2 times, last 2026-10-26 09:00 — ${long.slice(0, 99)}…`,
    "    it broke",
  ], "the SQLSTATE, how often, the statement cut to a line and the message's first line");
  assert.deepEqual(refusedLines({ total: null, refused: [] }, PLAIN), [], "nothing refused: no section");
  assert.deepEqual(refusedLines({ error: "the run answered 500" }, PLAIN), ["\nRefused queries: could not read them (the run answered 500; mason logs has the detail)"]);
});

test("mason status's unsupported SQL: an entry a line — how many, what they used, its entry of docs/SQL-SUPPORT.md — then when last, who, the latest; none, no section; declared", () => {
  const { unsupportedLines } = commands as unknown as { unsupportedLines: (u: unknown, st: typeof PLAIN) => string[] };
  assert.equal(typeof unsupportedLines, "function", "src/cli/commands.ts unsupportedLines");
  const long = `SELECT ${Array.from({ length: 40 }, (_, i) => `c${i}`).join(", ")} FROM public.orders`;
  assert.deepEqual(unsupportedLines([
    { gap: "json-agg-distinct", title: "json_agg / jsonb_agg (DISTINCT …)", runs: 1200, users: ["alice", "bob"], clients: ["Metabase"], last: "2026-10-26T10:01:00.000Z", example: long },
    { gap: "quote-ident", title: "quote_ident()", runs: 1, users: [], clients: [], last: "2026-10-26T09:00:00.000Z", example: "SELECT quote_ident(\n name) FROM t" },
    { gap: "a-renamed-entry", title: null, runs: 2, users: [], clients: ["psql"], last: "2026-10-26T08:00:00.000Z", example: "SELECT 1" },
  ], PLAIN), [
    "\nUnsupported SQL (the last day's refused statements by what they used, the most first):",
    "  json_agg / jsonb_agg (DISTINCT …): 1,200 statements as alice, bob from Metabase",
    `    last 2026-10-26 10:01 — ${long.slice(0, 99)}…`,
    "    How to rewrite it: see docs/SQL-SUPPORT.md › json_agg / jsonb_agg (DISTINCT …)",
    "  quote_ident(): 1 statement",
    "    last 2026-10-26 09:00 — SELECT quote_ident( name) FROM t",
    "    How to rewrite it: see docs/SQL-SUPPORT.md › quote_ident()",
    "  SQL this Mason no longer lists: 2 statements from psql",
    "    last 2026-10-26 08:00 — SELECT 1",
    "    How to rewrite it: see docs/SQL-SUPPORT.md › SQL this Mason no longer lists",
  ]);
  assert.ok(!unsupportedLines([{ gap: "quote-ident", title: "quote_ident()", runs: 1, users: [], clients: [], last: "2026-10-26T09:00:00.000Z", example: "SELECT 1" }], PLAIN).join("\n").includes("quote-ident"), "the registry id is for --json, never a line");
  assert.deepEqual(unsupportedLines([], PLAIN), [], "nothing refused by an entry: no section");
  assert.deepEqual(unsupportedLines({ error: "the run answered 500\nstack" }, PLAIN), ["\nUnsupported SQL: could not read it (the run answered 500; mason logs has the detail)"]);
  assert.ok(STATUS.json?.includes("unsupported"), "mason status --json declares unsupported");
  assert.match(STATUS.usage, /refusedTotal \(how many in all\), unsupported: \[\{ gap[^]*title[^]*runs[^]*users, clients[^]*last, example/, "and its usage names its fields");
});

test("mason status's query errors: the latest refused, failed or cancelled statements, a line each (requestLine); none, no section; declared and named in the usage", () => {
  const { queryErrorLines, requestLine } = commands as unknown as { queryErrorLines: (r: unknown, st: typeof PLAIN) => string[]; requestLine: (r: unknown, st: typeof PLAIN) => string };
  const refused = { requestId: "r", session: 1, method: "QUERY", detail: null, hint: null, queryTruncated: false, user: "", endedAt: "2026-10-26T14:02:12.357Z", bytesSent: 0,
    startedAt: "2026-10-26T14:02:12.000Z", applicationName: "psql", tokenName: "", outcome: "refused", status: "failed", sqlstate: "42P01", message: 'relation "nope" does not exist',
    rows: null, durationMs: 3, query: "SELECT * FROM nope" };
  assert.deepEqual(queryErrorLines({ queries: [refused], queriesError: null }, PLAIN), [
    "\nQuery errors (the latest refused, failed or cancelled, newest last; mason logs --requests --failed lists each):", `  ${requestLine(refused, PLAIN)}`]);
  assert.deepEqual(queryErrorLines({ queries: [], queriesError: null }, PLAIN), [], "none: no section");
  assert.deepEqual(queryErrorLines({ queries: [], queriesError: "the run answered 500\nstack" }, PLAIN), ["\nQuery errors: could not read them (the run answered 500; mason logs has the detail)"]);
  assert.match(STATUS.usage, /recentErrors: \{ sync: [^]*queries: \[[^]*queriesError/, "mason status's usage names recentErrors.queries and queriesError");
});

test("msText: a duration in ms as a person reads it — ms under a second, then tenths of a second, then minutes and seconds, then hours and minutes", () => {
  const { msText } = commands;
  const cases: Array<[number, string]> = [[0, "0 ms"], [3, "3 ms"], [512.4, "512 ms"], [999.4, "999 ms"], [999.6, "1.0 s"], [1234, "1.2 s"], [13_703, "13.7 s"],
    [59_949, "59.9 s"], [59_960, "1 min"], [125_000, "2 min 5 s"], [3_599_400, "59 min 59 s"], [3_599_600, "1 h"], [3_840_000, "1 h 4 min"], [-5, "0 ms"]];
  for (const [ms, text] of cases) assert.equal(msText(ms), text, `msText(${ms})`);
});

test("mason logs --requests: a request a line, newest last — when, the outcome and SQLSTATE, the time, the rows, who, the statement and the error", () => {
  const { requestLine } = commands;
  const base = { requestId: "r", session: 1, method: "QUERY", detail: null, hint: null, queryTruncated: false, user: "", role: "", attributes: null, endedAt: "2026-10-26T14:02:12.357Z", bytesSent: 100 };
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:11.123Z", applicationName: "Metabase", tokenName: "", outcome: "ok", status: "completed", sqlstate: null, message: null,
    rows: 20, durationMs: 1234, query: "SELECT id\n FROM public.orders LIMIT 20" }, PLAIN),
    "2026-10-26 14:02:11  ok                   1.2 s      20 rows  Metabase  SELECT id FROM public.orders LIMIT 20");
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:12.000Z", applicationName: "", tokenName: "bi", outcome: "refused", status: "failed", sqlstate: "42P01",
    message: 'relation "nope" does not exist\nsecond', rows: null, durationMs: 3, query: "SELECT * FROM nope" }, PLAIN),
    '2026-10-26 14:02:12  refused 42P01         3 ms               (no application_name) (token bi)  SELECT * FROM nope — relation "nope" does not exist');
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:13.000Z", applicationName: "psql", tokenName: "", outcome: "failed", status: "failed", sqlstate: "XX000",
    message: "it broke", rows: null, durationMs: 0, query: "" }, PLAIN),
    "2026-10-26 14:02:13  failed XX000          0 ms               psql  (no statement) — it broke");
  // a mason user's statement names the user (src/duck/users.ts)
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:14.000Z", applicationName: "Metabase", tokenName: "", user: "metabase", outcome: "ok", status: "completed", sqlstate: null, message: null,
    rows: 1, durationMs: 5, query: "SELECT 1 FROM orders" }, PLAIN),
    "2026-10-26 14:02:14  ok                    5 ms        1 row  Metabase (user metabase)  SELECT 1 FROM orders");
});

test("the sync's events: a line each in mason logs --events and mason status's Sync errors; the copies in all on one row; every key declared", () => {
  // read from the module's namespace: at a commit without them the file loads, and the test fails by name
  const { eventLine, syncErrorLines, totalsText, LOGS } = commands as unknown as {
    eventLine: (e: unknown, st: typeof PLAIN) => string; syncErrorLines: (r: unknown, st: typeof PLAIN) => string[];
    totalsText: (t: unknown, now?: number) => string; LOGS: typeof STATUS };
  const failedCopy = { at: "2026-10-28T09:00:00.000Z", kind: "copy_failed", failed: true, table: "public.orders", message: "the source closed the connection\nmore detail" };
  const restart = { at: "2026-10-28T09:05:00.000Z", kind: "restart", failed: true, table: null, message: "the run stopped (it crashed (SIGSEGV)) after 42 s up, and its supervisor started it again" };
  assert.equal(eventLine(failedCopy, PLAIN), "2026-10-28 09:00:00  copy_failed         public.orders  the source closed the connection");
  assert.equal(eventLine(restart, PLAIN), "2026-10-28 09:05:00  restart             (the sync)  the run stopped (it crashed (SIGSEGV)) after 42 s up, and its supervisor started it again");
  assert.deepEqual(syncErrorLines({ sync: [failedCopy, restart], error: null }, PLAIN), [
    "\nSync errors (the latest, newest last; mason logs --events lists every event):",
    `  ${eventLine(failedCopy, PLAIN)}`, `  ${eventLine(restart, PLAIN)}`]);
  assert.deepEqual(syncErrorLines({ sync: [], error: null }, PLAIN), [], "none: no section");
  assert.deepEqual(syncErrorLines({ sync: [], error: "the run answered 500\nstack" }, PLAIN), ["\nSync errors: could not read them (the run answered 500; mason logs has the detail)"]);
  const now = Date.parse("2026-10-28T09:10:00.000Z");
  assert.equal(totalsText({ added: 4, copied: 3, failed: 1, rows: 1_234, syncedAt: "2026-10-28T09:09:55.000Z" }, now), "3 of 4 added synced, 1,234 rows, 1 failed, the last synced 5 s ago");
  assert.equal(totalsText({ added: 1, copied: 0, failed: 0, rows: 0, syncedAt: null }, now), "0 of 1 added synced, 0 rows");
  // --json: each key declared, and named in the usage
  for (const [spec, keys] of [[STATUS, ["totals", "recentErrors"]], [LOGS, ["events"]]] as const) {
    for (const k of keys) {
      assert.ok(spec.json?.includes(k), `mason ${spec.name} --json declares ${k}`);
      assert.match(spec.usage, new RegExp(`\\b${k}\\b`), `mason ${spec.name}'s usage names ${k}`);
    }
  }
  assert.match(LOGS.usage, /--events/);
  assert.deepEqual(JSON.parse(jsonText(LOGS, { events: [failedCopy], keptDays: 7 }, [["mason status", "x"]])).events, [failedCopy]);
});

// usage over time (src/cli/usage.ts): read from the module when the tests run, so the file loads at a commit without it
type UsageCli = typeof import("../src/cli/usage.ts");
const usageCli = await import("../src/cli/usage.ts" as string).catch(() => ({})) as Partial<UsageCli>;
const sampleLine = (s: unknown, lag: boolean): string => usageCli.sampleLine?.(s as never, lag) ?? "(no src/cli/usage.ts)";
const sample = { at: "2026-10-28T09:05:00.000Z", seconds: 300, copyBytes: 5 * 2 ** 30, copyRows: 12_345_678, tablesAdded: 4, tablesCopied: 4, tablesFailed: 1, oldestSyncSeconds: 75,
  statements: 1_204, statementsRefused: 2, statementsFailed: 1, statementsCancelled: 0, rowsSent: 98_765, bytesSent: 4_567_890, durationP50Ms: 12, durationP95Ms: 1_830, streamLagBytes: null, streamLagSeconds: null,
  rssBytes: 900 * 2 ** 20, heapUsedBytes: 80 * 2 ** 20, copyMemoryBytes: 300 * 2 ** 20, copyMemoryLimitBytes: 8 * 2 ** 30, slotWalHeldBytes: null, diskFreeBytes: null, sessionsOpen: 2 };

test("mason usage: a span a line under its heading — the statements, their errors, p95, rows sent, the copy, its rows, the failed tables, the stalest copy, the memory; spans and times as the options write them", () => {
  const { sampleHeading, spanSeconds, USAGE } = usageCli as UsageCli;
  assert.equal(sampleHeading(false), "time (UTC)        statements   errors         p95    rows sent        size           rows  failing      oldest  memory");
  assert.equal(sampleLine(sample, false), "2026-10-28 09:05       1,204        3       1.8 s       98,765     5.0 GiB     12,345,678        1        75 s  900.0 MiB (engine 300.0 MiB of 8.0 GiB)");
  assert.equal(sampleLine({ ...sample, statements: 0, statementsRefused: 0, statementsFailed: 0, durationP95Ms: null, tablesFailed: 0, oldestSyncSeconds: null, copyMemoryBytes: null, streamLagSeconds: 3, streamLagBytes: 10 }, true),
    "2026-10-28 09:05           0                    –       98,765     5.0 GiB     12,345,678                    –        3 s  900.0 MiB", "nothing to say is blank or a dash; the lag with replication");
  assert.equal(sampleHeading(true).endsWith("oldest        lag  memory"), true);
  assert.deepEqual(["90s", "30m", "6h", "7d", "0", "5", "1w", "-1h"].map(spanSeconds), [90, 1800, 21_600, 604_800, 0, null, null, null]);
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  // --since and --until are read by the ONE time grammar of every entrance (timeOf): a time with no zone is refused
  const times = ["1h", "2026-10-28T09:00:00Z", "2026-10-28", "2026-10-28T09:00:00", "yesterday", "12", "0"].map((t) => timeOf("--since", t, now));
  assert.deepEqual(times.map((t) => typeof t === "string" ? t : t.message),
    ["2026-10-28T09:00:00.000Z", "2026-10-28T09:00:00.000Z", "2026-10-28T00:00:00.000Z", '--since "2026-10-28T09:00:00" is not a time', '--since "yesterday" is not a time', '--since "12" is not a time', '--since "0" is not a time']);
  assert.equal("whenOf" in usageCli, false, "no second parser beside timeOf");
  for (const k of USAGE.json ?? []) if (k !== "next") assert.match(USAGE.usage, new RegExp(`\\b${k}\\b`), `mason usage's usage names ${k}`);
  for (const k of Object.keys(sample)) assert.match(USAGE.usage, new RegExp(`\\b${k}\\b`), `mason usage's usage names a sample's ${k}`);
});

// ------------------------------------------------------------------ mason add and mason remove before mason start

/**
 * A PROJECT ON A REAL POSTGRES, OFFLINE: the demo database (PGlite on a loopback port, src/demo/source.ts), opened here
 * and read by the commands as any Postgres — with a table of no primary key added, whose unique index is over a column
 * that may be NULL (a `--key` over it is refused). The project is an ordinary one (no `demo: true`): its sources file
 * names the URL. Opened once, lazily, by the tests that need it; closed when the file ends.
 */
let db: Promise<{ root: string; folder: string; file: string; url: string }> | null = null;
const opened: Array<() => Promise<void>> = [];
after(async () => { for (const close of opened) await close(); });
function shop(): NonNullable<typeof db> {
  db ??= (async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-add-before-start-")));
    const source = await DemoSource.open({ dir: path.join(root, "db"), port: 0, log: () => {} });
    opened.push(async () => { await source.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const c = new pg.Client({ connectionString: source.url });
    await c.connect();
    try { await c.query("CREATE TABLE events (tenant_id bigint, id bigint NOT NULL, body text); CREATE UNIQUE INDEX events_tenant_id_id ON events (tenant_id, id)"); }
    finally { await c.end(); }
    const folder = path.join(root, "app", "mason");
    const file = path.join(folder, "sources", "shop.yml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, "app", ".mason"), { mode: 0o700 });
    writeRunning(root, null);
    fs.writeFileSync(file, `kind: postgres\nurl: ${source.url}\ntables: {}\n`);
    return { root, folder, file, url: source.url };
  })();
  return db;
}
/** The project's config, with the run it records (null: none): this test process's pid, answering on `port`. */
function writeRunning(root: string, running: { port: number; token: string } | null): void {
  fs.writeFileSync(path.join(root, "app", ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
    running: running && { pid: process.pid, controlUrl: `http://127.0.0.1:${running.port}`, token: running.token, postgresUrl: "postgresql://127.0.0.1:1/shop",
      postgresListener: { host: "127.0.0.1", tls: null } }, lastRun: null }), { mode: 0o600 });
}
const nextOf = (stdout: string): string[] => (JSON.parse(stdout) as { next: Array<{ command: string }> }).next.map((n) => n.command);

test("mason add and mason remove with Mason stopped: the entry written and cut as the run would, checked against the database; next, mason start", async () => {
  const s = await shop();
  const app = path.join(s.root, "app");
  const run = (argv: string[]) => runMason(app, argv, matrixEnv());
  const add = await run(["add", "orders", "--json"]);
  assert.equal(add.code, 0, add.stdout + add.stderr);
  assert.deepEqual(JSON.parse(add.stdout), { added: [{ table: "public.orders", entry: "orders", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [], already: false,
    sync: { value: "off", from: "default" }, bigOff: false, pollCost: null, notReplicated: null }],
    file: s.file, next: [{ command: "mason start", what: "Mason in the background, for this project: the first sync of every added table begins" },
      { command: "mason wait", what: "then, until every added table is synced and served" }] });
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables:\n  orders: {}\n`, "the entry, every other byte as it was");
  // as a person: the checklist's line, then Next: mason start
  const person = await run(["add", "customers", "--columns", "name"]);
  assert.equal(person.code, 0, person.stdout + person.stderr);
  assert.match(person.stdout, /✓ Added public\.customers to mason\/sources\/shop\.yml: id, name\n {4}sync: off \(the default\): after its first sync it is read again only by mason sync customers — mason add customers --sync "poll 5m" polls it every 5 minutes\n {4}key added: id \(a synced table always has its key\)\n/);
  assert.match(person.stdout, /Next:\n {2}mason start +Mason in the background, for this project: the first sync of every added table begins\n/);
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables:\n  orders: {}\n  customers:\n    columns: [id, name]\n`);
  // remove: the entry cut; the copy an earlier run made goes at the next start
  const rm = await run(["remove", "customers", "--json"]);
  assert.equal(rm.code, 0, rm.stdout + rm.stderr);
  assert.deepEqual(JSON.parse(rm.stdout).removed, ["public.customers"]);
  assert.deepEqual(nextOf(rm.stdout), ["mason start", "mason status"]);
  const rmPerson = await run(["remove", "orders"]);
  assert.equal(rmPerson.code, 0, rmPerson.stdout + rmPerson.stderr);
  assert.match(rmPerson.stdout, /Removed public\.orders/);
  assert.match(rmPerson.stdout, /what an earlier run synced of it is dropped at the next mason start/);
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables: {}\n`, "the last one gone: tables: {}");
});

test("mason add of a table a replicating file cannot replicate says it was written sync: poll 5m, why, and the alternatives", async () => {
  const { addedLines } = await import("../src/cli/commands.ts");
  const b = { table: "public.events", file: "/app/mason/sources/app.yml", entry: "events", columns: null, exclude: [], key: ["tenant_id", "id"], addedKey: [], skippedSecrets: [], already: false,
    sync: { value: "poll 5m", from: "entry" as const }, bigOff: false, pollCost: null, notReplicated: "it has no primary key, so logical replication cannot apply its changes by its key:" };
  assert.deepEqual(addedLines(b, "mason/sources/app.yml"), { line: "Added public.events to mason/sources/app.yml: every column, keyed by tenant_id, id", notes: [
    "sync: poll 5m written on its entry, not the file's replication: it has no primary key, so logical replication cannot apply its changes by its key: — " +
    "mason add events --sync \"poll 1h\" polls it hourly; mason add events --sync off reads it only by mason sync events"] });
  // one the file's replication keeps current: said so, and the way to poll it instead
  assert.equal(addedLines({ ...b, table: "public.orders", entry: "orders", key: null, sync: { value: "replication", from: "file" as const }, notReplicated: null }, "f").notes[0],
    "sync: replication (the file's): kept current from the database's change log after its first sync — mason add orders --sync \"poll 5m\" polls it instead");
});

test("the run and the commands refuse an edit in the SAME words, Mason up or down: one check-and-write at every entrance (src/cli/source-edit.ts)", async () => {
  const s = await shop();
  const app = path.join(s.root, "app");
  // THE RUN, over the same project and database: its command server as mason start serves it, its catalog read from the
  // database as the run reads it
  const parsed = parseSource(s.url);
  assert.ok("source" in parsed);
  const conn = await connectSource(parsed.source);
  assert.ok("pg" in conn, "the demo database answers");
  const facts = await readSourceFacts(conn.pg);
  conn.pg.close();
  const read = () => readSource(s.folder, app, {});
  // the run's edits read the file through readSource (src/cli/run-server.ts sourceOnDisk): counted, so an answer "up" is
  // known to be the run's
  let runEdits = 0;
  // usage over time, as the run's samples answer it (src/duck/usage.ts): mason usage asks it
  const usageAsks: Array<{ since: string; until: string; stepSeconds?: number }> = [];
  const ctx: RunContext = {
    page: false, users: { file: path.join(app, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => facts, warnings: [], replication: () => null, port: 0, token: "t0ken-of-the-run",
    folder: () => s.folder, root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(), sources: () => { const r = read(); return { file: "message" in r ? null : r, problem: null }; }, sourcesChanged: () => {}, log: () => {},
    readSource: () => { runEdits++; return read(); }, runUrl: s.url, listener: { running: () => [], cancel: (session) => ({ unknown: session }), openSessions: () => ({ open: 0, byClient: [] }) },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(s.root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, unsupported: async () => [], page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }), summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }), slowest: async () => [], durationsBy: async () => new Map([[Date.parse(sample.at), { p50: sample.durationP50Ms, p95: sample.durationP95Ms }]]), 
        lastUsed: async (u) => u.map(() => null) }, events: { days: 7, recent: async () => [] },
      usage: { days: 7, sampleSeconds: 60, samples: async (o) => { usageAsks.push(o); return [sample]; }, copySizes: async () => [{ table: "public.orders", bytes: 3 * 2 ** 20, at: "2026-10-28T09:10:00.000Z" }], statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null },
      restarts: () => [] },
  };
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  try {
    /** One command line with Mason up (the run above) and down, as a person and with --json; the file unchanged by each. */
    const both = async (argv: string[]): Promise<{ up: Answer[]; down: Answer[] }> => {
      const was = fs.readFileSync(s.file, "utf8");
      const once = async (up: boolean): Promise<Answer[]> => {
        writeRunning(s.root, up ? { port: ctx.port, token: ctx.token } : null);
        const before = runEdits;
        const a = [await runMason(app, argv, matrixEnv()), await runMason(app, [...argv, "--json"], matrixEnv())];
        assert.equal(runEdits - before, up ? 2 : 0, `mason ${argv.join(" ")} (Mason ${up ? "up" : "down"}): ${up ? "asked the run, each time" : "never asked the run"}`);
        assert.equal(fs.readFileSync(s.file, "utf8"), was, `mason ${argv.join(" ")} (Mason ${up ? "up" : "down"}): refused, and nothing written`);
        return a;
      };
      try { return { up: await once(true), down: await once(false) }; } finally { writeRunning(s.root, null); }
    };
    const same = async (argv: string[], words: RegExp): Promise<void> => {
      const { up, down } = await both(argv);
      for (const [i, a] of [...up, ...down].entries()) assert.equal(a.code, 1, `${i}: ${a.stdout}${a.stderr}`);
      assert.match(up[1]!.stdout, words, "the refusal's words");
      assert.deepEqual(JSON.parse(down[1]!.stdout), JSON.parse(up[1]!.stdout), `mason ${argv.join(" ")} --json: the same answer, Mason up or down`);
      assert.equal(down[0]!.stderr, up[0]!.stderr, `mason ${argv.join(" ")}: the same failure for a person`);
    };
    // a --key over a column that may be NULL
    await same(["add", "events", "--key", "tenant_id,id"], /tables\.events\.key: tenant_id may be NULL in public\.events, and rows with NULL there cannot be told apart — a key's columns are NOT NULL/);
    // a --key on a table with a primary key
    await same(["add", "customers", "--key", "id"], /public\.customers has a primary key \(id\), which Mason keys it by: leave --key out/);
    // a column the table lacks, said with the closest
    await same(["add", "customers", "--columns", "nme"], /public\.customers has no column \\"nme\\" — did you mean `name`\?/);
    // A SECOND ENTRY OF THE FILE THAT FAILS against the database: the add and the remove are refused, the file as it was
    fs.writeFileSync(s.file, `kind: postgres\nurl: ${s.url}\ntables:\n  customers: {}\n  orders:\n    columns: [id, gone]\n`);
    await same(["add", "products"], /mason\/sources\/shop\.yml: tables\.orders\.columns: public\.orders has no column gone \(its columns: [^)]*\) — fix it first, then add products/);
    await same(["remove", "customers"], /mason\/sources\/shop\.yml: tables\.orders\.columns: public\.orders has no column gone \(its columns: [^)]*\) — fix it first, then remove customers/);
    // a name the file does not have, with the closest it has
    await same(["remove", "customer"], /shop\.yml names no table customer — did you mean `customers`\?/);
    // MASON USAGE asks the run's /api/usage and prints its answer: as it is under --json, a line a span for a person
    writeRunning(s.root, { port: ctx.port, token: ctx.token });
    try {
      const t0 = Date.now();
      const person = await runMason(app, ["usage", "--since", "2h", "--step", "10m"], matrixEnv());
      assert.equal(person.code, 0, person.stderr);
      assert.deepEqual([usageAsks[0]!.stepSeconds, Math.round((Date.parse(usageAsks[0]!.until) - Date.parse(usageAsks[0]!.since)) / 1000)], [600, 7200]);
      assert.ok(Date.parse(usageAsks[0]!.until) >= t0 - 1000, "until now");
      assert.match(person.stdout, /^Usage from \d{4}-\d\d-\d\d \d\d:\d\d to .* UTC, 10 min a line \(a sample every 60 s, kept 7 days\):\n/);
      assert.ok(person.stdout.includes(`\n${sampleLine(sample, false)}\n`), person.stdout);
      assert.match(person.stdout, /Each synced table's own size \(measured every 10 min\):\n {2}public\.orders {2}\s+3\.0 MiB {2}at 09:10 UTC\n/);
      assert.match(person.stdout, /\nNext:/);
      const json = await runMason(app, ["usage", "--step", "0", "--json"], matrixEnv());
      assert.equal(json.code, 0, json.stderr);
      const answer = JSON.parse(json.stdout) as Record<string, unknown>;
      assert.equal(usageAsks[1]!.stepSeconds, undefined, "--step 0: every sample");
      assert.deepEqual({ ...answer, since: null, until: null, next: null }, { since: null, until: null, stepSeconds: null, sampleSeconds: 60, keptDays: 7, samples: [sample],
        copySizes: [{ table: "public.orders", bytes: 3 * 2 ** 20, at: "2026-10-28T09:10:00.000Z" }], next: null });
      // the run's refusal, in its words and the usage code; and one the command refuses itself, before asking
      const short = await runMason(app, ["usage", "--step", "30s", "--json"], matrixEnv());
      assert.deepEqual([short.code, (JSON.parse(short.stdout) as { error: { code: string; message: string } }).error.message],
        [2, "step is a whole number of seconds, 60 (a sample's interval) to 604800 (the 7 days kept), not \"30\""]);
      const asked = usageAsks.length;
      const bad = await runMason(app, ["usage", "--since", "yesterday"], matrixEnv());
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /mason usage: --since "yesterday" is not a time/);
      assert.equal(usageAsks.length, asked, "refused before the run is asked");
    } finally { writeRunning(s.root, null); }
    // WHAT TO RUN NEXT, Mason up (a review finding): --sync alone on a table already added starts no copy (it is caught up
    // by one poll), so the next step is mason status, never mason wait's "the copy has started"; a new table's is mason wait
    fs.writeFileSync(s.file, `kind: postgres\nurl: ${s.url}\ntables:\n  customers: {}\n`);
    writeRunning(s.root, { port: ctx.port, token: ctx.token });
    try {
      const resync = await runMason(app, ["add", "customers", "--sync", "poll 30s", "--json"], matrixEnv());
      assert.equal(resync.code, 0, resync.stdout + resync.stderr);
      assert.deepEqual((JSON.parse(resync.stdout) as { next: unknown }).next, [
        { command: "mason status", what: "its sync and when it was last synced: it is caught up by one poll, never synced again whole" },
        { command: "mason user add <name>", what: "a user for your BI tool or psql: it prints the password and the URL to paste" }]);
      assert.match(fs.readFileSync(s.file, "utf8"), /\n {2}customers:\n {4}sync: poll 30s\n$/);
      const person = await runMason(app, ["add", "customers", "--sync", "off"], matrixEnv());
      assert.match(person.stdout, /Next:\n {2}mason status +its sync and when it was last synced: it is caught up by one poll, never synced again whole\n/);
      const fresh = await runMason(app, ["add", "products", "--json"], matrixEnv());
      assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
      assert.equal((JSON.parse(fresh.stdout) as { next: Array<{ command: string; what: string }> }).next[0]!.command, "mason wait", "a new table's copy begins");
      const both2 = await runMason(app, ["add", "customers", "orders", "--sync", "poll 1m", "--json"], matrixEnv());
      assert.equal((JSON.parse(both2.stdout) as { next: Array<{ command: string }> }).next[0]!.command, "mason wait", "one of them is new: its copy begins");
    } finally { writeRunning(s.root, null); }
  } finally {
    server.close();
    fs.writeFileSync(s.file, `kind: postgres\nurl: ${s.url}\ntables: {}\n`);
  }
});

test("stage 1b, the roles file decides a user added without --role: its default (role row, roleFrom default), none (reads nothing, the way out), no file (as before); mason status says the default", async () => {
  // src/cli/roles.ts userRole, src/cli/user.ts: with Mason stopped the file is read here; with Mason up the listener's
  // roles (/api/state's roles, default included) — a run's command server over the same project, its roles a LiveRoles
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-user-default-")));
  opened.push(async () => { fs.rmSync(root, { recursive: true, force: true }); });
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  const config = (running: { port: number; token: string } | null): void => fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false,
    apiKey: "k".repeat(48), sourceServer: null, running: running && { pid: process.pid, controlUrl: `http://127.0.0.1:${running.port}`, token: running.token,
      postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } }, lastRun: null }), { mode: 0o600 });
  config(null);
  fs.writeFileSync(path.join(folder, "sources", "shop.yml"), "kind: postgres\nurl: postgres://mason:x@127.0.0.1:1/shop\ntables:\n  orders: {}\n  customers: {}\n");
  const rolesFile = path.join(folder, "roles.yml");
  const WITH_DEFAULT = "default: everything\nroles:\n  everything:\n    tables: all\n  agent:\n    tables:\n      orders: {}\n";
  // agent first: the way out names the role of tables: all (everything), never merely the file's first (src/duck/grants.ts exampleRole)
  const NO_DEFAULT = "roles:\n  agent:\n    tables:\n      orders: {}\n  everything:\n    tables: all\n";
  const run = (argv: string[]) => runMason(root, argv, matrixEnv());
  type User = { name?: string; user?: string; role?: string; roleFrom?: string; readsNothing?: boolean; roleKnown?: boolean };
  const roleOf = (u: User | undefined) => u && { role: u.role, roleFrom: u.roleFrom, readsNothing: u.readsNothing };
  const listed = async (name: string): Promise<User | undefined> => (JSON.parse((await run(["user", "list", "--json"])).stdout) as { users: User[] }).users.find((u) => u.name === name);

  // A DEFAULT: the user reads as it, said on add and on list
  fs.writeFileSync(rolesFile, WITH_DEFAULT);
  const a = await run(["user", "add", "metabase", "--json"]);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.deepEqual(roleOf(JSON.parse(a.stdout) as User), { role: "everything", roleFrom: "default", readsNothing: undefined });
  const person = await run(["user", "add", "grafana"]);
  assert.match(person.stdout, /^ {2}role +everything \(the file's default: mason\/roles\.yml\)$/m);
  const own = await run(["user", "add", "bot", "--role", "agent", "--json"]);
  assert.deepEqual(roleOf(JSON.parse(own.stdout) as User), { role: "agent", roleFrom: "file", readsNothing: undefined });
  assert.deepEqual(roleOf(await listed("metabase")), { role: "everything", roleFrom: "default", readsNothing: undefined });
  assert.equal((await listed("metabase"))?.roleKnown, undefined, "roleKnown is a user's own role's");
  assert.deepEqual(roleOf(await listed("bot")), { role: "agent", roleFrom: "file", readsNothing: undefined });
  const list = await run(["user", "list"]);
  assert.match(list.stdout, /^ {2}metabase +role everything \(default\) +id [0-9a-f]{16}/m);
  assert.match(list.stdout, /^ {2}bot +role agent +id [0-9a-f]{16}/m);
  assert.doesNotMatch(list.stdout, /has no role/);

  // NO DEFAULT: the add is still written, and says it reads nothing with the way out; list says it by name
  fs.writeFileSync(rolesFile, NO_DEFAULT);
  const bare = await run(["user", "add", "superset", "--json"]);
  assert.equal(bare.code, 0, bare.stdout + bare.stderr);
  assert.deepEqual(roleOf(JSON.parse(bare.stdout) as User), { role: undefined, roleFrom: "none", readsNothing: true });
  const barePerson = await run(["user", "add", "dbeaver"]);
  assert.match(barePerson.stdout, /^ {2}role +none, and mason\/roles\.yml names no default: it reads nothing until one is written$/m);
  assert.match(barePerson.stdout, /Tip: Its statements are refused until it has a role: write default: everything at the top of mason\/roles\.yml, or mason user remove dbeaver and mason user add dbeaver --role everything\./);
  assert.deepEqual(roleOf(await listed("metabase")), { role: undefined, roleFrom: "none", readsNothing: true }, "the file decides, at every read");
  const noDefault = await run(["user", "list"]);
  assert.match(noDefault.stdout, /^ {2}metabase +id [0-9a-f]{16}.*has no role, and mason\/roles\.yml names no default: its statements are refused$/m);
  assert.match(noDefault.stdout, /^ {2}bot +role agent +id [0-9a-f]{16}[^\n]*$/m);
  assert.doesNotMatch(noDefault.stdout, /^ {2}bot .*has no role/m);
  const tips = noDefault.stdout.split("\n").filter((l) => l.startsWith("Tip: A user with no role"));
  assert.deepEqual(tips, ["Tip: A user with no role reads nothing while mason/roles.yml names no default: write default: everything at the top of mason/roles.yml, or mason user remove metabase and mason user add metabase --role everything."], "ONE tip");

  // A FILE THAT CANNOT BE READ (the review of #44): the listener refuses every user held to it for the FILE (57P03), so
  // nothing says "no default" or "not in the roles file" — the file's problem is said once, the way out its repair
  fs.writeFileSync(rolesFile, "roles: [not a map");
  const broken = await run(["user", "list"]);
  assert.equal(broken.code, 0, broken.stdout + broken.stderr);
  assert.doesNotMatch(broken.stdout, /names no default|not in the roles file/);
  assert.deepEqual(broken.stdout.split("\n").filter((l) => l.includes("cannot be read as it is now")),
    [`Tip: mason/roles.yml cannot be read as it is now, so every statement of a user held to it is refused: ${broken.stdout.split("refused: ")[1]?.split("\n")[0] ?? ""}`], "ONE tip");
  assert.match(broken.stdout, /refused: mason\/roles\.yml: it is not YAML: /, "the file's own mistake");
  assert.deepEqual(roleOf(await listed("metabase")), { role: undefined, roleFrom: "none", readsNothing: undefined });
  assert.equal((await listed("bot"))?.roleKnown, undefined, "under a problem roleKnown is left out, never false");
  const brokenAdd = await run(["user", "add", "redash"]);
  assert.equal(brokenAdd.code, 0, brokenAdd.stdout + brokenAdd.stderr);
  assert.doesNotMatch(brokenAdd.stdout, /^ {2}role |reads nothing/m);

  // NO FILE: every user reads every synced table, as before stage 1b: no role, nothing said
  fs.rmSync(rolesFile);
  assert.deepEqual(roleOf(await listed("metabase")), { role: undefined, roleFrom: "none", readsNothing: undefined });
  const noFile = await run(["user", "add", "psql"]);
  assert.doesNotMatch(noFile.stdout, /^ {2}role /m);

  // MASON UP: the listener's roles (default included) decide the add, and mason status says the default
  fs.writeFileSync(rolesFile, WITH_DEFAULT);
  const r = await import("../src/cli/roles.ts");
  const live = new r.LiveRoles(folder, root, () => [{ source: "public.orders", columns: [{ name: "id" }] }, { source: "public.customers", columns: [{ name: "id" }] }]);
  const parsed = parseSource("postgres://mason:x@127.0.0.1:1/shop");
  assert.ok("source" in parsed);
  // the run's command server over this project (main's RunContext: its ledgers faked, nothing here reads them), its roles a LiveRoles
  const ctx: RunContext = {
    page: false, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null, port: 0, token: "t0ken-of-the-run",
    folder: () => folder, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => readSource(folder, root, {}), runUrl: "postgres://mason:x@127.0.0.1:1/shop", roles: () => live.now(),
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session) => ({ unknown: session }) },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, unsupported: async () => [], page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }),
        summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }),
        slowest: async () => [], durationsBy: async () => new Map(), lastUsed: async (u) => u.map(() => null) },
      events: { days: 7, recent: async () => [] }, usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [], statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null }, restarts: () => [] },
  };
  const server = createRunServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  ctx.port = (server.address() as { port: number }).port;
  config({ port: ctx.port, token: ctx.token });
  try {
    const status = await run(["status", "--json"]);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.deepEqual((JSON.parse(status.stdout) as { roles: unknown }).roles, { file: "mason/roles.yml", roles: ["everything", "agent"], problem: null, default: "everything", all: ["everything"] });
    assert.match((await run(["status"])).stdout, /^ {2}Roles +everything, agent {2}\(mason\/roles\.yml; default everything for a user added without --role\)$/m);
    const up = await run(["user", "add", "looker", "--json"]);
    assert.deepEqual(roleOf(JSON.parse(up.stdout) as User), { role: "everything", roleFrom: "default", readsNothing: undefined });
    fs.writeFileSync(rolesFile, NO_DEFAULT);
    assert.equal((JSON.parse((await run(["status", "--json"])).stdout) as { roles: { default: unknown } }).roles.default, null);
    assert.match((await run(["status"])).stdout, /^ {2}Roles +agent, everything {2}\(mason\/roles\.yml; no default: a user with no role reads nothing\)$/m);
    assert.deepEqual(roleOf(JSON.parse((await run(["user", "add", "tableau", "--json"])).stdout) as User), { role: undefined, roleFrom: "none", readsNothing: true });
    // the listener's roles say which is of tables: all (/api/state's roles.all): the way out names it, as with Mason stopped
    // THE DATABASE NAME IS READ AT THE START: an edit of database: is said until the run takes it, and the run's name is what a user is told
    const sourcesFile = path.join(folder, "sources", "shop.yml");
    const asWritten = fs.readFileSync(sourcesFile, "utf8");
    const moved = "Warning +the sources file now says tools connect with reporting, and this run answers as shop: mason stop && mason start takes it";
    fs.writeFileSync(sourcesFile, asWritten.replace("tables:", "database: shop\ntables:"));
    assert.doesNotMatch((await run(["status"])).stdout, /tools connect with/, "the file and the run agree");
    fs.writeFileSync(sourcesFile, asWritten.replace("tables:", "database: reporting\ntables:"));
    assert.match((await run(["status"])).stdout, new RegExp(`^ {2}${moved}$`, "m"));
    assert.ok((JSON.parse((await run(["status", "--json"])).stdout) as { warnings: string[] }).warnings.some((w) => /this run answers as shop/.test(w)));
    assert.equal((JSON.parse((await run(["user", "add", "metrics", "--json"])).stdout) as { database: string }).database, "shop", "what the run answers as, not what the file will say");
    fs.writeFileSync(sourcesFile, asWritten);
    assert.match((await run(["user", "add", "mode"])).stdout, /Tip: Its statements are refused until it has a role: write default: everything at the top of mason\/roles\.yml, or mason user remove mode and mason user add mode --role everything\./);
  } finally { config(null); server.close(); }
});

test("mason status's queries: the last day and the last week a line each — every outcome, the completed ones' times, rows and bytes; a short log says so", () => {
  const queryLines = (commands as Record<string, unknown>).queryLines as ((q: unknown, st: typeof PLAIN) => string[]) | undefined;
  assert.equal(typeof queryLines, "function");
  const w = (days: number, covered: number) => ({ days, covered, statements: 1204, completed: 1190, refused: 10, failed: 2, cancelled: 2, rows: 52_000, bytesSent: 3 * 1024 * 1024,
    durationMs: { avg: 120, p50: 40, p95: 13_703 } });
  assert.deepEqual(queryLines!({ keptDays: 3, day: w(1, 1), week: { ...w(7, 3), durationMs: null } }, PLAIN), [
    "\nQueries (the completed ones' time: average / p50 / p95; mason logs --requests lists each):",
    "  last day    1,204 statements: 1,190 completed, 10 refused, 2 failed, 2 cancelled · 120 ms / 40 ms / 13.7 s · 52,000 rows, 3.0 MiB sent",
    "  last week   1,204 statements: 1,190 completed, 10 refused, 2 failed, 2 cancelled · 52,000 rows, 3.0 MiB sent (the request log keeps 3 days: MASON_HISTORY_DAYS)",
  ]);
  assert.deepEqual(queryLines!({ error: "the run answered 500" }, PLAIN), ["\nQueries: could not read them (the run answered 500; mason logs has the detail)"]);
  assert.ok(STATUS.json?.includes("queries") === true, "mason status --json declares it");
});

/**
 * mason logs --requests' filters, mason logs --running and mason cancel, against a run's command server whose ledger and
 * listener are faked: a filter is read by the one parser before the run is asked (a mistake exit 2, in the flag's own
 * name), and what the run is asked is what was meant; a cancel the run refuses is said in its own words and code.
 */
test("mason logs --requests filters and pages, mason logs --running and mason cancel: one parser, the run's answers in the Failure shape", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-queries-")));
  const app = path.join(root, "app");
  fs.mkdirSync(path.join(app, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(app, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://me@localhost:5432/shop\ntables: {}\n");
  fs.mkdirSync(path.join(app, ".mason"), { mode: 0o700 });
  const parsed = parseSource("postgres://me@localhost:5432/shop");
  assert.ok("source" in parsed);
  const asked: unknown[] = [];
  const cancelled: Array<number | [number, number]> = [];
  const running = { session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY", startedAt: "2026-10-24T10:04:30.000Z", runningMs: 1500, rows: 12,
    query: "SELECT count(*) FROM orders", queryTruncated: false };
  const failedQueries = [{ requestId: "r1", startedAt: "2026-10-24T10:04:00.000Z", endedAt: "2026-10-24T10:04:00.003Z", session: 4, applicationName: "psql", tokenName: "", user: "",
    method: "QUERY", outcome: "refused", status: "failed", sqlstate: "42P01", message: 'relation "nope" does not exist', detail: null, hint: null, rows: null, bytesSent: 0, durationMs: 3,
    query: "SELECT * FROM nope", queryTruncated: false }];
  const unsupportedAsks: Array<{ since: string; limit: number }> = [];
  const unsupportedSql = { gap: "json-agg-distinct", title: "json_agg / jsonb_agg (DISTINCT …)", runs: 12, users: ["metabase"], clients: ["Metabase"],
    last: "2026-10-24T10:04:00.000Z", example: "SELECT json_agg(DISTINCT status) FROM orders" };
  const ctx: RunContext = {
    page: false, users: { file: path.join(app, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null, port: 0,
    token: "t0ken-of-the-run", folder: () => path.join(app, "mason"), root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => ({ message: "not read here", code: "bad_source" }), runUrl: "postgres://me@localhost:5432/shop",
    listener: { openSessions: () => ({ open: 1, byClient: [{ user: "metabase", client: "Metabase", open: 1, running: 1 }] }), running: () => [running], cancel: (session, statement) => { cancelled.push(statement === undefined ? session : [session, statement]);
      return session === 4 && statement !== undefined && statement !== 9 ? { other: running, asked: statement } : session === 4 ? { cancelled: running } : session === 6 ? { cancelled: { ...running, session: 6, runningMs: 125_000 } } : session === 5 ? { idle: 5 } : { unknown: session }; } },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, unsupported: async (q) => { unsupportedAsks.push(q); return [unsupportedSql]; }, page: async (q) => { asked.push(q); return { requests: q.failed === true ? failedQueries as never : [], before: "2026-10-24T10:00:00.000Z~7" }; }, slow: async () => [],
        refused: async () => ({ total: 0, refused: [] }), summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }), slowest: async () => [], durationsBy: async () => new Map(),  lastUsed: async (u) => u.map(() => null) },
      events: { days: 7, recent: async () => [] }, usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [], statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null }, restarts: () => [] },
  };
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(app, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${ctx.port}`, token: ctx.token, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } },
    lastRun: null }), { mode: 0o600 });
  const run = (argv: string[]) => runMason(app, argv, matrixEnv());
  try {
    // the filters: read here, the times resolved, and the page before named with every filter kept
    const t0 = Date.now();
    const page = await run(["logs", "--requests", "-n", "5", "--since", "2h", "--outcome", "cancelled", "--user", "metabase", "--json"]);
    assert.equal(page.code, 0, page.stdout + page.stderr);
    const q = asked[0] as { limit: number; outcomes: string[]; since: string; user: string };
    assert.deepEqual({ ...q, since: "" }, { limit: 5, outcomes: ["cancelled"], since: "", user: "metabase" });
    assert.ok(Math.abs(Date.parse(q.since) - (t0 - 2 * 3_600_000)) < 60_000, `--since 2h is two hours ago: ${q.since}`);
    const body = JSON.parse(page.stdout) as { requests: unknown[]; keptDays: number; before: string; next: Array<{ command: string }> };
    assert.deepEqual([body.requests, body.keptDays, body.before], [[], 7, "2026-10-24T10:00:00.000Z~7"]);
    assert.equal(body.next[0]!.command, `mason logs --requests -n 5 --outcome cancelled --since ${q.since} --user metabase --before 2026-10-24T10:00:00.000Z~7`);
    // --slow and --search: the run is asked for SLOW_MS or more and the text, and the page before keeps them
    const slow = await run(["logs", "--requests", "--slow", "--search", "from orders", "--json"]);
    assert.equal(slow.code, 0, slow.stdout + slow.stderr);
    assert.deepEqual(asked.at(-1), { limit: 40, minMs: 1000, search: "from orders" });
    assert.equal((JSON.parse(slow.stdout) as { next: Array<{ command: string }> }).next[0]!.command, "mason logs --requests --slow --search 'from orders' --before 2026-10-24T10:00:00.000Z~7");
    // none listed, nothing filtered: what the log does not list, so a select 1 typed to test the connection is not looked for in vain
    const none = await run(["logs", "--requests"]);
    assert.equal(none.code, 0, none.stdout + none.stderr);
    assert.match(none.stdout, /^No request in the last 7 days \(MASON_HISTORY_DAYS\)\.\n\nTip: A statement that reads no synced table \(select 1, SET, SHOW, a BI tool's catalog queries\) is answered but not\s+listed\./);
    assert.ok(!(await run(["logs", "--requests", "--slow"])).stdout.includes("reads no synced table"), "a filter that passes none says nothing of it");
    // a mistake: exit 2, in the flag's name, before the run is asked
    const before = asked.length;
    for (const [argv, words] of [
      [["logs", "--requests", "--since", "soon"], /mason logs: --since "soon" is not a time/],
      [["logs", "--requests", "--outcome", "canceled"], /mason logs: --outcome "canceled" is none of ok, refused, failed, cancelled — did you mean `cancelled`\?/],
      [["logs", "--requests", "-n", "0"], /mason logs: -n is a whole number of requests, 1 to 10000/],
      [["logs", "--requests", "--failed", "--outcome", "ok"], /mason logs: --failed is every outcome but ok: name it or --outcome, never both/],
      [["logs", "--since", "2h"], /mason logs: --since is a filter of --requests/],
      [["logs", "--slow"], /mason logs: --slow is a filter of --requests/],
      [["logs", "--requests", "--search", ""], /mason logs: --search is a piece of a statement's text: it is empty/],
      [["logs", "--running", "--requests"], /mason logs: --running lists the statements running now; --requests is the request log's/],
      [["usage", "--since", "2026-10-28T09:00:00"], /mason usage: --since "2026-10-28T09:00:00" is not a time/],
      [["logs", "--events", "-n", "20000"], /mason logs: -n is a whole number of events, 1 to 10000/],
      [["logs", "--events", "-n", "0"], /mason logs: -n is a whole number of events, 1 to 10000/],
      [["logs", "--running", "-n", "5"], /mason logs: --running lists every statement running now: -n \(--lines\) does not apply to it/],
    ] as Array<[string[], RegExp]>) {
      const a = await run(argv);
      assert.equal(a.code, 2, `${argv.join(" ")}: ${a.stdout}${a.stderr}`);
      assert.match(a.stderr, words);
      const j = await run([...argv, "--json"]);
      assert.deepEqual([j.code, (JSON.parse(j.stdout) as { error: { code: string } }).error.code], [2, "usage"], argv.join(" "));
    }
    assert.equal(asked.length, before, "a refused filter never reaches the run");
    // mason status reads the latest failed statements from the request log's page, beside the sync's failures (recentErrors.queries)
    const asks = asked.length;
    const st = await run(["status", "--json"]);
    assert.equal(st.code, 0, st.stdout + st.stderr);
    const recent = (JSON.parse(st.stdout) as { recentErrors: Record<string, unknown> }).recentErrors;
    assert.deepEqual(recent, { sync: [], error: null, queries: failedQueries, queriesError: null });
    // and the refused statements grouped by the unsupported SQL they used, beside refusedQueries: the run's /api/unsupported, a day of it
    assert.deepEqual((JSON.parse(st.stdout) as { unsupported: unknown }).unsupported, [unsupportedSql]);
    assert.ok(Math.abs(Date.parse(unsupportedAsks[0]!.since) - (Date.now() - 86_400_000)) < 60_000, `the last day: ${unsupportedAsks[0]!.since}`);
    assert.equal(unsupportedAsks[0]!.limit, 5, "the top few");
    assert.deepEqual(asked.slice(asks).map((q) => { const { limit, failed } = q as { limit: number; failed?: boolean }; return { limit, failed }; }), [{ limit: 5, failed: true }]);
    // the statements running now
    const now = await run(["logs", "--running", "--json"]);
    assert.equal(now.code, 0, now.stderr);
    assert.deepEqual(JSON.parse(now.stdout), { running: [running], next: [{ command: "mason cancel 4 --statement 9", what: "stop a session's statement, as a client's cancel does" },
      { command: "mason logs --requests", what: "the statements answered, refused and cancelled" }] });
    assert.match((await run(["logs", "--running"])).stdout, /^Running now \(1\):\n {2}session 4 +statement 9 +1\.5 s +12 rows sent {2}Metabase \(user metabase\) {2}SELECT count\(\*\) FROM orders\n/);
    // a cancel: what it stopped; nothing running, or no such session, said with its code
    const done = await run(["cancel", "4", "--json"]);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout).cancelled, running);
    assert.match((await run(["cancel", "4"])).stdout, /^Cancelled session 4's statement: it ends now, and its client gets a "canceling statement" error\.\n/);
    // its running time is the line of mason logs --running's renderer (spanText), not a second one
    assert.match((await run(["cancel", "6"])).stdout, /Running +2 min, 12 rows sent\n/);
    const idle = await run(["cancel", "5"]);
    assert.equal(idle.code, 1);
    assert.match(idle.stderr, /^✗ mason cancel: session 5 is running no statement: nothing to cancel\n/);
    const gone = await run(["cancel", "77", "--json"]);
    assert.deepEqual([gone.code, JSON.parse(gone.stdout).error], [1, { code: "not_found", message: "no session 77 is open", why: "it ended, or never was" }]);
    const bad = await run(["cancel", "four"]);
    assert.deepEqual([bad.code, bad.stderr.split("\n")[0]], [2, "✗ mason cancel: four is not a session's number"]);
    // --statement: sent, and the statement it names cancelled only while the session runs it
    cancelled.length = 0;
    const named = await run(["cancel", "4", "--statement", "9", "--json"]);
    assert.deepEqual([named.code, JSON.parse(named.stdout).cancelled], [0, running]);
    const moved = await run(["cancel", "4", "--statement", "8"]);
    assert.equal(moved.code, 1);
    assert.match(moved.stderr, /^✗ mason cancel: session 4 runs another statement now \(statement 9\), not statement 8: nothing cancelled\n/);
    assert.match(moved.stderr, /mason cancel 4 --statement 9 stops the one it runs now/);
    assert.deepEqual(cancelled, [[4, 9], [4, 8]], "the statement is sent with the session");
    const badStatement = await run(["cancel", "4", "--statement", "nine"]);
    assert.deepEqual([badStatement.code, badStatement.stderr.split("\n")[0]], [2, "✗ mason cancel: --statement nine is not a statement's number"]);
    assert.deepEqual(cancelled, [[4, 9], [4, 8]], "a refused --statement never reaches the run");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mason status's Disk line: free where the synced data is, and what the copies running add — said as more than is free when it is; an unread free space is its error", async () => {
  const { diskRows } = await import("../src/cli/commands.ts") as unknown as { diskRows?: (d: unknown) => Array<[string, string]> };
  assert.equal(typeof diskRows, "function", "src/cli/commands.ts diskRows");
  assert.deepEqual(diskRows!({ path: "/data", freeBytes: 75 * 2 ** 30, copyBytes: 49 * 2 ** 30, projectedBytes: null }), [["Disk", "75.0 GiB free in /data"]]);
  assert.deepEqual(diskRows!({ path: "/data", freeBytes: 75 * 2 ** 30, copyBytes: 49 * 2 ** 30, projectedBytes: 80 * 2 ** 30 }),
    [["Disk", "75.0 GiB free in /data · the first syncs running are projected to add about 80.0 GiB more — more than is free: the sync stops before the disk fills"]]);
  assert.deepEqual(diskRows!({ path: "/data", freeBytes: null, copyBytes: null, projectedBytes: null, error: "the free space where the synced data is could not be read: EACCES" }),
    [["Disk", "the free space where the synced data is could not be read: EACCES"]]);
  assert.deepEqual(diskRows!(undefined), [], "a run from before it: no line");
});

test("mason status's Sessions line: how many are open and running a statement, and by whom — the three with the most, then how many others", async () => {
  const { sessionsRows } = await import("../src/cli/commands.ts") as unknown as { sessionsRows?: (s: unknown) => Array<[string, string]> };
  assert.equal(typeof sessionsRows, "function", "src/cli/commands.ts sessionsRows");
  assert.deepEqual(sessionsRows!({ open: 0, byClient: [] }), [["Sessions", "none open"]]);
  assert.deepEqual(sessionsRows!({ open: 7, byClient: [
    { user: "metabase", client: "Metabase", open: 3, running: 1 }, { user: "", client: "", open: 2, running: 0 },
    { user: "agent", client: "psql", open: 1, running: 1 }, { user: "grafana", client: "Grafana", open: 1, running: 0 }] }),
    [["Sessions", "7 open, 2 running a statement · 3 as metabase (Metabase), 2 by a token, 1 as agent (psql), and 1 other client (mason logs --running lists the statements)"]]);
  assert.deepEqual(sessionsRows!(undefined), [], "a run from before it: no line");
});

test("mason user add --role with Mason stopped: the role must be one the roles file names, checked against the sources file; list says each user's role, and one the file no longer names", async () => {
  // src/cli/roles.ts and src/cli/user.ts roleToAdd: a stopped project with a sources file and no run (the role is read
  // from the file here; with Mason up it is the listener's, tests/duck-roles-wire.test.ts and the state matrix)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-user-role-")));
  opened.push(async () => { fs.rmSync(root, { recursive: true, force: true }); });
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(folder, "sources", "shop.yml"), "kind: postgres\nurl: postgres://mason:x@127.0.0.1:1/shop\ntables:\n  orders: {}\n  customers:\n    columns: [id, name]\n  billing.invoices: {}\n");
  const rolesFile = path.join(folder, "roles.yml");
  const run = (argv: string[]) => runMason(root, argv, matrixEnv());
  const failure = (a: Answer): Failure & { code: string } => (JSON.parse(a.stdout) as { error: Failure & { code: string } }).error;
  // no roles file: refused before anything is written, with the lines to write
  const none = await run(["user", "add", "bot", "--role", "agent", "--json"]);
  assert.equal(none.code, 1, none.stdout + none.stderr);
  assert.deepEqual([failure(none).code, failure(none).message], ["not_found", "there is no role agent: this project has no roles file"]);
  assert.equal(failure(none).fix, "write mason/roles.yml:\n  roles:\n    agent:\n      tables:\n        <a synced table>: {}\nthen mason user add <name> --role agent");
  // the file's mistakes, each at its key: a misspelt top key, a role with no table, a table the sources file does not copy, a column both listed and excluded
  for (const [text, want] of [
    ["role:\n  agent:\n    tables:\n      orders: {}\n", /unexpected key role — did you mean `roles`\? — a roles file takes default and roles/],
    ["roles:\n  agent: {}\n", /roles\.agent\.tables: missing — write tables: all \(every synced table\) or tables: \{ orders: \{\} \}, the tables the role may read \(a role with no table reads nothing: remove it instead\)/],
    ["roles:\n  agent:\n    tables:\n      products: {}\n", /roles\.agent\.tables\.products: public\.products is not a table the sources file syncs — a role reads synced tables only \(synced: orders, customers, billing\.invoices; mason add products syncs it\)/],
    // a bare name of a table copied under its schema: the qualified entry is suggested
    ["roles:\n  agent:\n    tables:\n      invoices: {}\n", /roles\.agent\.tables\.invoices: public\.invoices is not a table the sources file syncs — did you mean `billing\.invoices`\? — a role reads synced tables only/],
    ["roles:\n  agent:\n    tables:\n      orders:\n        columns: [id]\n        exclude: [notes]\n", /roles\.agent\.tables\.orders: columns and exclude together — columns names what the role reads, exclude what it may not read of every column; keep one/],
  ] as const) {
    fs.writeFileSync(rolesFile, text);
    const a = await run(["user", "add", "bot", "--role", "agent", "--json"]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    const f = failure(a);
    assert.equal(f.code, "bad_roles", JSON.stringify(f));
    assert.match(`${f.message}: ${f.why ?? ""}`, want, JSON.stringify(f));
    assert.ok(!fs.existsSync(path.join(root, ".mason", "users.json")), "nothing written");
  }
  // a good file: a role the file does not name is refused with the closest it does; the right one is written
  fs.writeFileSync(rolesFile, "roles:\n  agent:\n    tables:\n      orders: {}\n      customers:\n        columns: [name]\n  ops:\n    tables:\n      customers: {}\n");
  const typo = await run(["user", "add", "bot", "--role", "agnet", "--json"]);
  assert.equal(typo.code, 1, typo.stdout + typo.stderr);
  assert.deepEqual([failure(typo).code, failure(typo).message, failure(typo).why], ["not_found", "there is no role agnet in mason/roles.yml — did you mean `agent`?", "the roles: agent, ops"]);
  const added = await run(["user", "add", "bot", "--role", "agent", "--json"]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const a = JSON.parse(added.stdout) as { user: string; role: string; password: string; url?: string };
  assert.deepEqual([a.user, a.role, a.url], ["bot", "agent", undefined]);
  assert.match(a.password, /^mason_[0-9a-f]{16}_[0-9a-f]{32}$/);
  const person = await run(["user", "add", "ops-bot", "--role", "ops"]);
  assert.equal(person.code, 0, person.stdout + person.stderr);
  assert.match(person.stdout, /^ {2}role +ops \(mason\/roles\.yml names what it reads\)$/m);
  // a name of another shape, and --role on list: usage, exit 2
  assert.equal((await run(["user", "add", "x", "--role", "Agent"])).code, 2);
  assert.equal((await run(["user", "list", "--role", "agent"])).code, 2);
  // list: each user's role; the file edited under one, said
  const list = await run(["user", "list", "--json"]);
  assert.equal(list.code, 0, list.stdout + list.stderr);
  assert.deepEqual((JSON.parse(list.stdout) as { users: Array<{ name: string; role?: string; roleKnown?: boolean }> }).users.map((u) => [u.name, u.role, u.roleKnown]), [["bot", "agent", true], ["ops-bot", "ops", true]]);
  fs.writeFileSync(rolesFile, "roles:\n  agent:\n    tables:\n      orders: {}\n");
  const orphan = await run(["user", "list"]);
  assert.equal(orphan.code, 0, orphan.stdout + orphan.stderr);
  assert.match(orphan.stdout, /^ {2}bot +role agent +id [0-9a-f]{16}/m);
  assert.match(orphan.stdout, /^ {2}ops-bot +role ops +id [0-9a-f]{16}.*its role ops is not in the roles file: its statements are refused$/m);
  assert.match(orphan.stdout, /A role the roles file \(mason\/roles\.yml\) does not name reads nothing: add ops to it, or mason user remove ops-bot, then mason user add ops-bot --role <role>\./);
  // a user with no role under a file with no default: no role, and it reads nothing (stage 1b)
  assert.equal((await run(["user", "add", "plain", "--json"])).code, 0);
  const plain = (JSON.parse((await run(["user", "list", "--json"])).stdout) as { users: Array<{ name: string; role?: string }> }).users.find((u) => u.name === "plain");
  assert.deepEqual(plain && { role: plain.role, roleKnown: "roleKnown" in plain, roleFrom: (plain as { roleFrom?: string }).roleFrom, readsNothing: (plain as { readsNothing?: boolean }).readsNothing },
    { role: undefined, roleKnown: false, roleFrom: "none", readsNothing: true }, JSON.stringify(plain));
});

test("mason user add --set with Mason stopped: every attribute the role declares, none other, a scalar once, a list once per value and never empty; list says each user's values and the ones it lacks", async () => {
  // src/cli/user.ts attributesToAdd, src/cli/roles.ts (attributes:, where:, through:): refused before anything is
  // written, each at its key with the way out; with Mason up the same check reads the listener's roles (/api/state)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-user-set-")));
  opened.push(async () => { fs.rmSync(root, { recursive: true, force: true }); });
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(folder, "sources", "shop.yml"), "kind: postgres\nurl: postgres://mason:x@127.0.0.1:1/shop\ntables:\n  orders: {}\n  order_items: {}\n  customers: {}\n");
  const rolesFile = path.join(folder, "roles.yml");
  fs.writeFileSync(rolesFile, `default: everything
roles:
  everything:
    tables: all
  tenant:
    attributes: [tenant]
    tables:
      orders: { where: "tenant_id = :tenant" }
      order_items: { through: orders }
  region:
    attributes: { regions: list, plan: scalar }
    tables:
      customers: { where: "region = ANY(:regions) AND plan = :plan" }
`);
  const run = (argv: string[]) => runMason(root, argv, matrixEnv());
  const failure = (a: Answer): Failure & { code: string } => (JSON.parse(a.stdout) as { error: Failure & { code: string } }).error;
  const usersFile = path.join(root, ".mason", "users.json");
  // a missing attribute: the attribute, the role, the where: that reads it and the exact --set — a wrong command line
  const missing = await run(["user", "add", "acme", "--role", "tenant", "--json"]);
  assert.equal(missing.code, 2, missing.stdout + missing.stderr);
  assert.deepEqual([failure(missing).code, failure(missing).message, failure(missing).fix],
    ["usage", "the role tenant needs --set tenant=…: its users carry the attribute tenant (roles.tenant.tables.orders.where: tenant_id = :tenant)", "mason user add acme --role tenant --set tenant=<value>"]);
  const person = await run(["user", "add", "acme", "--role", "tenant"]);
  assert.equal(person.code, 2);
  assert.match(person.stderr, /^✗ mason user: the role tenant needs --set tenant=…/m);
  for (const [argv, want] of [
    [["--set", "tenat=1"], "--set tenat: the role tenant has no attribute tenat — did you mean `tenant`?"],
    [["--set", "tenant=1", "--set", "tenant=2"], "--set tenant twice: tenant is a scalar of the role tenant, one value"],
    [["--set", "tenant"], "--set tenant: is <attribute>=<value>, like --set tenant=42"],
    [["--set", "Tenant=1"], "--set Tenant=1: \"Tenant\" is not an attribute's name: 1 to 63 lower case letters, digits or \"_\", starting with a letter or \"_\" (e.g. tenant)"],
  ] as const) {
    const a = await run(["user", "add", "acme", "--role", "tenant", ...argv, "--json"]);
    assert.equal(a.code, 2, a.stdout + a.stderr);
    assert.equal(failure(a).message, want);
  }
  // a list: once per value, never empty; a scalar beside it given twice is refused with the list as the near name only where it is one
  const empty = await run(["user", "add", "emea", "--role", "region", "--set", "regions=", "--set", "plan=pro", "--json"]);
  assert.equal(empty.code, 2);
  assert.match(failure(empty).message, /^--set regions=: regions is a list, and a list's value is never empty/);
  const listMissing = await run(["user", "add", "emea", "--role", "region", "--set", "plan=pro", "--json"]);
  assert.equal(failure(listMissing).fix, "mason user add emea --role region --set plan=pro --set regions=<value> --set regions=<another>");
  // the user's default role declares none: an attribute is refused by name
  const noAttr = await run(["user", "add", "bot", "--set", "tenant=1", "--json"]);
  assert.equal(noAttr.code, 2);
  assert.match(failure(noAttr).message, /^--set tenant: the role everything has no attribute tenant/);
  assert.ok(!fs.existsSync(usersFile), "nothing written by any refusal");
  // written: a scalar (a comma is a character of it), and a list in the order given
  const acme = await run(["user", "add", "acme", "--role", "tenant", "--set", "tenant=4,2", "--json"]);
  assert.equal(acme.code, 0, acme.stdout + acme.stderr);
  assert.deepEqual((JSON.parse(acme.stdout) as { attributes: unknown }).attributes, { tenant: "4,2" });
  const emea = await run(["user", "add", "emea", "--role", "region", "--set", "regions=eu", "--set", "plan=pro", "--set", "regions=uk"]);
  assert.equal(emea.code, 0, emea.stdout + emea.stderr);
  assert.match(emea.stdout, /^ {2}attributes +regions=\[eu, uk\], plan=pro$/m);
  // a user added before its role gained an attribute: list names what it lacks, with the way out
  const users = JSON.parse(fs.readFileSync(usersFile, "utf8")) as { users: Array<Record<string, unknown>> };
  users.users.push({ name: "old", id: "0123456789abcdef", addedAt: new Date().toISOString(), key: users.users[0]!.key, role: "tenant" });
  fs.writeFileSync(usersFile, JSON.stringify(users));
  const list = await run(["user", "list", "--json"]);
  assert.equal(list.code, 0, list.stdout + list.stderr);
  assert.deepEqual((JSON.parse(list.stdout) as { users: Array<{ name: string; attributes?: unknown; missingAttributes?: string[] }> }).users.map((u) => [u.name, u.attributes, u.missingAttributes]),
    [["acme", { tenant: "4,2" }, undefined], ["emea", { regions: ["eu", "uk"], plan: "pro" }, undefined], ["old", undefined, ["tenant"]]]);
  const listed = await run(["user", "list"]);
  assert.match(listed.stdout, /^ {2}acme +role tenant \(tenant=4,2\) +id /m);
  assert.match(listed.stdout, /^ {2}old +role tenant +id .*has no value for tenant: its statements are refused$/m);
  assert.match(listed.stdout, /Tip: A user without a value its role's rows are filtered by is refused at every statement: the user old has no value for tenant, which the role tenant filters rows by: its statements are refused — mason user remove old && mason user add old --role tenant --set tenant=<value>\./);
  // --set with another verb: usage
  assert.equal((await run(["user", "list", "--set", "tenant=1"])).code, 2);
});

test("mason start --replication, --poll and --publication are gone: each answers with the line to write in the sources file and exit 2, as a person and with --json, and starts nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-start-gone-"));
  try {
    fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://mason:secret@127.0.0.1:1/shop\ntables:\n  orders: {}\n");
    fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "gone", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null }), { mode: 0o600 });
    const syncWhy = "how each table is kept current is its sync: in the sources file (at the top for every table, on an entry for that one), so what runs is what is committed";
    const next = [{ command: "mason start", what: "each table kept current as its sync: says" }, { command: "mason help production", what: "sync: and publication:, and what each needs" }];
    const cases: Array<[string[], { message: string; why: string; fix: string }]> = [
      [["--replication"], { message: "--replication is gone: the sources file says it now", why: syncWhy,
        fix: "write sync: replication at the top of mason/sources/shop.yml, then mason start" }],
      [["--poll"], { message: "--poll is gone: the sources file says it now", why: syncWhy,
        fix: "write sync: poll 5m at the top of mason/sources/shop.yml (any interval: poll 5s, poll 1h; or sync: off, the default, and mason sync <table> when you need it), then mason start" }],
      [["--publication", "app_pub"], { message: "--publication is gone: the sources file says it now",
        why: "the publication replication reads is the sources file's publication:, so what runs is what is committed",
        fix: "write publication: app_pub at the top of mason/sources/shop.yml, with sync: replication on the entries of the tables it carries, then mason start" }],
      // a publication goes with replication: one coherent way out, never "poll every table" and "replicate some" at once
      [["--poll", "--publication", "app_pub"], { message: "--poll and --publication are gone: the sources file says it now",
        why: `${syncWhy.replace(/, so what runs is what is committed$/, "")}, and the publication replication reads is its publication:, so what runs is what is committed`,
        fix: "a publication goes with replication: write publication: app_pub at the top of mason/sources/shop.yml, with sync: replication on the entries of the tables it carries " +
          "and sync: poll 5m (any interval) on the others, then mason start" }],
      // several on ONE report, --attach or not: never run
      [["--replication", "--publication=app_pub", "--attach"], { message: "--replication and --publication are gone: the sources file says it now",
        why: `${syncWhy.replace(/, so what runs is what is committed$/, "")}, and the publication replication reads is its publication:, so what runs is what is committed`,
        fix: "write sync: replication and publication: app_pub at the top of mason/sources/shop.yml, then mason start" }],
    ];
    for (const [flags, want] of cases) {
      const person = await runMason(root, ["start", ...flags], matrixEnv());
      assert.equal(person.code, 2, person.stdout + person.stderr);
      assert.equal(person.stdout, "");
      assert.equal(person.stderr, `✗ mason start: ${want.message}\n  why   ${want.why}\n  fix   ${want.fix}\n\nNext:\n` +
        `  mason start                                   each table kept current as its sync: says\n  mason help production                         sync: and publication:, and what each needs\n`);
      const json = await runMason(root, ["start", ...flags, "--json"], matrixEnv());
      assert.equal(json.code, 2, json.stdout + json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), { error: { code: "usage", ...want }, next });
    }
    assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "nothing was spawned");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8")).running, null, "nothing runs");
    // outside a project: the file every project has, by its place
    const away = await runMason(os.tmpdir(), ["start", "--poll", "--json"], matrixEnv());
    assert.equal(away.code, 2, away.stdout + away.stderr);
    assert.match((JSON.parse(away.stdout) as { error: { fix: string } }).error.fix, /^write sync: poll 5m at the top of mason\/sources\/<name>\.yml /);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
