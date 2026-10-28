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
import { addSpecs, addSteps, copyProgress, duration, findTable, paintBar, readiness, STATUS, tableLines, WAIT, type RunState, type TableState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";
import { jsonText } from "../src/cli/command.ts";
import type { CopyProgressView, StreamStatus } from "../src/duck/sync.ts";
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
  project: "v1", tables: o.tables ?? [], engine: { name: "duckdb", file: "/app/.mason/duck.db", bytes: 10, pollSeconds: 5 },
  ...(o.stream ? { stream: o.stream } : {}),
});

test("mason wait: ready once every added table is copied; a copy still running or not started waits; a failed copy is a failure, said", () => {
  assert.deepEqual(readiness(state({})), { ready: true, failed: [], waiting: [] }, "nothing added: nothing to wait for");
  const copying = t({ table: "public.orders", added: true, rows: 1000, copy: { phase: "copying", rowsCopied: 250, updatedAt: "" } });
  const waiting = t({ table: "public.lines", added: true });
  const done = t({ table: "public.customers", added: true, copy: { phase: "done", rowsCopied: 7, updatedAt: at(5) } });
  const notAdded = t({ table: "public.logs", copy: null });
  assert.deepEqual(readiness(state({ tables: [copying, waiting, done, notAdded] })),
    { ready: false, failed: [], waiting: ["public.orders: copying 25% · 250 of ~1,000 rows", "public.lines: waiting for its copy to start"] });
  assert.deepEqual(readiness(state({ tables: [done, notAdded] })), { ready: true, failed: [], waiting: [] });
  // a copy that failed: the sync tries again by itself, but an agent waiting is told now, with the reason's first line
  const failed = t({ table: "public.big", added: true, copy: { phase: "failed", rowsCopied: 0, updatedAt: "" }, error: "permission denied for table big\nmore" });
  assert.deepEqual(readiness(state({ tables: [failed, done] })), { ready: false, failed: ["public.big: permission denied for table big"], waiting: [] });
});

test("mason wait shows a copy's progress: of the table's estimate, never 100% until it is done, never back once past a stale estimate", () => {
  assert.equal(copyProgress("public.t", 500, 1000), "public.t: copying 50% · 500 of ~1,000 rows", "a run's state without the chunks' progress");
  assert.equal(copyProgress("public.t", 1500, 1000), "public.t: copying 99% · 1,500 rows · past the ~1,000 estimated", "an estimate the copy passed: held at 99 %, said");
  assert.equal(copyProgress("public.t", 999, 1000), "public.t: copying 99% · 999 of ~1,000 rows", "never 100% until the copy says it is done");
  assert.equal(copyProgress("public.t", 10, null), "public.t: copying 10 rows");
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
  assert.equal(copyProgress("public.events", 0, EST, first), "public.events: copying 0% · reading the first 3 chunks (12 s) · ~20,126,276 rows to copy");
  assert.equal(line(0, view({ reading: 1, readingSeconds: 12 })), "public.events  ░░░░░░░░░░░░░░░░░░░░   0%  reading the first chunk (12 s) · ~20,126,276 rows to copy");
  assert.doesNotMatch(line(0, first), /\b0 of\b/);
  // CHUNKS IN FLIGHT: the committed rows plus what the three reading have read by now at the measured rate
  const flying = view({ chunksDone: 4, chunksTotal: 46, reading: 3, readingSeconds: 48, rowsReading: 431_000, rowsPerSecond: 41_000, bytesPerSecond: 4e7, secondsLeft: 540, share: 0.12 });
  assert.equal(copyProgress("public.events", 2_000_000, EST, flying),
    "public.events: copying 12% · 2,431,000 of ~20,126,276 rows · 3 chunks reading (48 s), 4 of ~46 in · 41,000 rows/s · ~9 min left");
  assert.equal(line(2_000_000, flying), "public.events  ██░░░░░░░░░░░░░░░░░░  12%  copying 2,431,000 of ~20,126,276 rows · 3 chunks reading (48 s), 4 of ~46 in · 41,000 rows/s · ~9 min left");
  // a poll later, the same commit: the bar moved though no chunk committed
  assert.equal(line(2_000_000, { ...flying, readingSeconds: 58, rowsReading: 1_250_000, share: 0.16 }),
    "public.events  ███░░░░░░░░░░░░░░░░░  16%  copying 3,250,000 of ~20,126,276 rows · 3 chunks reading (58 s), 4 of ~46 in · 41,000 rows/s · ~9 min left", "it moves at every poll");
  // THE LAST CHUNK: one reading, every other in; then every chunk read, the copy checked and swapped in
  assert.equal(copyProgress("public.events", 19_500_000, EST, view({ chunksDone: 45, chunksTotal: 46, reading: 1, readingSeconds: 7, rowsReading: 300_000, rowsPerSecond: 41_000, secondsLeft: 4, share: 0.98 })),
    "public.events: copying 98% · 19,800,000 of ~20,126,276 rows · 1 chunk reading (7 s), 45 of ~46 in · 41,000 rows/s · ~4 s left");
  assert.equal(copyProgress("public.events", 20_126_276, EST, view({ chunksDone: 46, chunksTotal: 46, rowsPerSecond: 41_000, secondsLeft: 0, share: 0.99 })),
    "public.events: copying 99% · 20,126,276 of ~20,126,276 rows · every chunk read (46): checking it and swapping it in · 41,000 rows/s");
  // a copy resumed: its rows from before, its first chunk of this attempt not measured yet
  assert.equal(copyProgress("public.events", 6_000_000, EST, view({ chunksDone: 3, reading: 3, readingSeconds: 2, share: 0.3 })),
    "public.events: copying 30% · 6,000,000 of ~20,126,276 rows · resumed, reading the first 3 chunks (2 s)");
  // A COPY THAT OUTRUNS THE ESTIMATE (23,719,703 rows under an estimate of 20,126,276, and the bar went back to
  // `0% copying 21,385,158 rows`): the share is the heap's pages read, exact, so it holds; the text says it is past it
  const past = view({ chunksDone: 140, chunksTotal: 151, reading: 2, readingSeconds: 9, rowsReading: 85_158, rowsPerSecond: 41_000, secondsLeft: 70, share: 0.9 });
  assert.equal(copyProgress("public.events", 21_300_000, EST, past),
    "public.events: copying 90% · 21,385,158 rows · past the ~20,126,276 estimated · 2 chunks reading (9 s), 140 of ~151 in · 41,000 rows/s · ~70 s left");
  assert.equal(line(21_300_000, past), "public.events  ██████████████████░░  90%  copying 21,385,158 rows · past the ~20,126,276 estimated · 2 chunks reading (9 s), 140 of ~151 in · 41,000 rows/s · ~70 s left");
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
    "public.zfirst   ████████████████████ 100%  1,234 rows · copied",
    "public.later    ████████████████████ 100%  7 rows · copied",
    "public.broken   ████████████████████ 100%  its copy failed: permission denied",
    "public.copying  █████░░░░░░░░░░░░░░░  25%  copying 250 of ~1,000 rows",
    "public.waiting  ░░░░░░░░░░░░░░░░░░░░   0%  waiting for its copy to start",
  ]);
  // on a terminal: green copied, red failed, cyan at work
  const st = { ...PLAIN, red: (x: string) => `<r>${x}</r>`, green: (x: string) => `<g>${x}</g>`, cyan: (x: string) => `<c>${x}</c>` };
  assert.match(paintBar(lines[0]!, st), /<g>█{20}<\/g>/);
  assert.match(paintBar(lines[2]!, st), /<r>█{20}<\/r>/);
  assert.match(paintBar(lines[3]!, st), /<c>█{5}<\/c>/);
});

test("mason status and wait: a table over the poll's row limit says on its line that it is NOT kept current, and how to make it so", () => {
  // the poll scans a table whole, so a table over 1,000,000 rows is copied and served, not polled
  const lines = tableLines(state({ tables: [
    t({ table: "public.orders", added: true, rows: 22_086_165, copy: { phase: "done", rowsCopied: 22_086_165, updatedAt: at(2) },
      unsynced: { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-26T12:03:44.120Z" } }),
    t({ table: "shop.events", added: true, copy: { phase: "done", rowsCopied: 3, updatedAt: at(3) }, unsynced: { reason: "over the 1,000,000-row sync limit", asOf: null } }),
    t({ table: "public.small", added: true, copy: { phase: "done", rowsCopied: 7, updatedAt: at(4) } }),
  ] }));
  assert.deepEqual(lines, [
    "public.orders  ████████████████████ 100%  22,086,165 rows · copied, NOT kept current (over the 1,000,000-row sync limit; as of 2026-10-26 12:03 UTC) — mason sync orders, or mason start --replication",
    "shop.events    ████████████████████ 100%  3 rows · copied, NOT kept current (over the 1,000,000-row sync limit) — mason sync shop.events, or mason start --replication",
    "public.small   ████████████████████ 100%  7 rows · copied",
  ]);
  // on a terminal its bar is a warning's colour, never the green of a table kept current
  const st = { ...PLAIN, yellow: (x: string) => `<y>${x}</y>`, green: (x: string) => `<g>${x}</g>` };
  assert.match(paintBar(lines[0]!, st), /<y>█{20}<\/y>/);
  assert.match(paintBar(lines[2]!, st), /<g>█{20}<\/g>/);
  // ready all the same: it is copied and served
  assert.equal(readiness(state({ tables: [t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 1, updatedAt: at(1) }, unsynced: { reason: "x", asOf: null } })] })).ready, true);
});

test("a copy in a layout an older Mason kept says it is copied again, and is still copied, served and ready (src/duck/sync.ts RETIRED_LAYOUT)", () => {
  const retired = t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 2_000_000, updatedAt: at(2), retired: "stored in key order with an index, by an older Mason: copied again in heap order" } });
  assert.deepEqual(tableLines(state({ tables: [retired] })), ["public.orders  ████████████████████ 100%  2,000,000 rows · copied · stored in key order with an index, by an older Mason: copied again in heap order"]);
  const r = readiness(state({ tables: [retired] }));
  assert.deepEqual([r.ready, r.waiting], [true, []], "its old copy serves: mason wait is ready");
});

test("mason status and wait in replication mode say where the stream is: its position and lag, the last change, and each table streamed, being caught up or left out", () => {
  // the first replication run on a server: one stream line in 35 minutes, and status showed no position, lag or count
  const now = Date.parse("2026-10-26T12:00:10.000Z");
  const stream: StreamStatus = {
    slotName: "mason_shop", slot: { walHeldBytes: 3 * 2 ** 30, walStatus: "extended", safeWalSizeBytes: 2 ** 30, at: "2026-10-26T12:00:08.000Z" },
    publication: "mason_shop", running: true, failure: null,
    position: "0/1A2B3C8", applied: "0/1A2B300",
    database: { lsn: "0/1A2B4F0", at: "2026-10-26T12:00:08.000Z" },
    lag: { bytes: 296, seconds: 5 },
    lastBatch: { appliedAt: "2026-10-26T12:00:05.300Z", committedAt: "2026-10-26T12:00:05.000Z" },
    tables: [
      { table: "public.orders", state: "streamed", why: null, applied: { inserts: 1_000, updates: 200, deletes: 4, truncates: 0 } },
      { table: "shop.lines", state: "catching-up", why: "caught up by one poll after its copy",
        catchUp: { phase: "polling", from: "2026-10-26T11:58:02.000Z", startedAt: "2026-10-26T12:00:07.000Z", held: 12, retryAt: null }, applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } },
      { table: "public.events", state: "left-out", why: "publication app_pub does not carry public.events: ALTER PUBLICATION app_pub ADD TABLE public.events", applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } },
      { table: "public.big", state: "waiting", why: "it is being copied: it joins once copied and caught up by one poll", applied: { inserts: 0, updates: 0, deletes: 0, truncates: 0 } },
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
    "public.big     not streamed yet: it is being copied: it joins once copied and caught up by one poll",
  ]);
  // a stream that failed says why and when it starts again; a database that could not be asked says so, never a lag of 0
  assert.deepEqual(streamLines({ ...stream, running: false, failure: { error: "replication: the slot is in use\nmore", retryAt: "2026-10-26T12:00:40.000Z" },
    database: { error: "connect ECONNREFUSED" }, slot: { error: "the database could not be reached: connect ECONNREFUSED" }, lag: { bytes: null, seconds: null }, lastBatch: null, tables: [] }, now), [
    "stream       not running: replication: the slot is in use · it starts again in 30 s",
    "position     0/1A2B3C8 · the database's position could not be read: connect ECONNREFUSED",
    "slot         the WAL it holds could not be read: the database could not be reached: connect ECONNREFUSED",
    "last change  none applied this run",
  ]);
  // THE SLOT'S WAL, with no cap: said plainly, since a slot nothing reads then holds WAL until the database's disk fills
  const slotLine = (slot: StreamStatus["slot"]): string => streamLines({ ...stream, slot, tables: [] }, now)[1]!;
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
    "  2,500 ms last time (1 run, median 2,500 ms), last 2026-10-26 10:00 UTC",
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

test("mason logs --requests: a request a line, newest last — when, the outcome and SQLSTATE, the time, the rows, who, the statement and the error", () => {
  const { requestLine } = commands;
  const base = { requestId: "r", session: 1, method: "QUERY", detail: null, hint: null, queryTruncated: false, user: "", endedAt: "2026-10-26T14:02:12.357Z", bytesSent: 100 };
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:11.123Z", applicationName: "Metabase", tokenName: "", outcome: "ok", status: "completed", sqlstate: null, message: null,
    rows: 20, durationMs: 1234, query: "SELECT id\n FROM public.orders LIMIT 20" }, PLAIN),
    "2026-10-26 14:02:11  ok                1,234 ms      20 rows  Metabase  SELECT id FROM public.orders LIMIT 20");
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
  assert.equal(totalsText({ added: 4, copied: 3, failed: 1, rows: 1_234, syncedAt: "2026-10-28T09:09:55.000Z" }, now), "3 of 4 added copied, 1,234 rows, 1 failed, the last synced 5 s ago");
  assert.equal(totalsText({ added: 1, copied: 0, failed: 0, rows: 0, syncedAt: null }, now), "0 of 1 added copied, 0 rows");
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
  rssBytes: 900 * 2 ** 20, heapUsedBytes: 80 * 2 ** 20, copyMemoryBytes: 300 * 2 ** 20, copyMemoryLimitBytes: 8 * 2 ** 30, slotWalHeldBytes: null, diskFreeBytes: null };

test("mason usage: a span a line under its heading — the statements, their errors, p95, rows sent, the copy, its rows, the failed tables, the stalest copy, the memory; spans and times as the options write them", () => {
  const { sampleHeading, spanSeconds, USAGE } = usageCli as UsageCli;
  assert.equal(sampleHeading(false), "time (UTC)        statements   errors         p95    rows sent        copy           rows  failing      oldest  memory");
  assert.equal(sampleLine(sample, false), "2026-10-28 09:05       1,204        3    1,830 ms       98,765     5.0 GiB     12,345,678        1        75 s  900.0 MiB (copy 300.0 MiB of 8.0 GiB)");
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
  assert.deepEqual(JSON.parse(add.stdout), { added: [{ table: "public.orders", entry: "orders", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [], already: false }],
    file: s.file, next: [{ command: "mason start", what: "Mason in the background, for this project: the copy of every added table begins" },
      { command: "mason wait", what: "then, until every added table is copied and served" }] });
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables:\n  orders: {}\n`, "the entry, every other byte as it was");
  // as a person: the checklist's line, then Next: mason start
  const person = await run(["add", "customers", "--columns", "name"]);
  assert.equal(person.code, 0, person.stdout + person.stderr);
  assert.match(person.stdout, /✓ Added public\.customers to mason\/sources\/shop\.yml: id, name\n {4}key added: id \(a copy always has its key\)\n/);
  assert.match(person.stdout, /Next:\n {2}mason start +Mason in the background, for this project: the copy of every added table begins\n/);
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables:\n  orders: {}\n  customers:\n    columns: [id, name]\n`);
  // remove: the entry cut; the copy an earlier run made goes at the next start
  const rm = await run(["remove", "customers", "--json"]);
  assert.equal(rm.code, 0, rm.stdout + rm.stderr);
  assert.deepEqual(JSON.parse(rm.stdout).removed, ["public.customers"]);
  assert.deepEqual(nextOf(rm.stdout), ["mason start", "mason status"]);
  const rmPerson = await run(["remove", "orders"]);
  assert.equal(rmPerson.code, 0, rmPerson.stdout + rmPerson.stderr);
  assert.match(rmPerson.stdout, /Removed public\.orders/);
  assert.match(rmPerson.stdout, /a copy an earlier run made of it is dropped at the next mason start/);
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables: {}\n`, "the last one gone: tables: {}");
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
    source: parsed.source, facts: () => facts, warnings: [], slot: "", changes: "poll", port: 0, token: "t0ken-of-the-run",
    folder: () => s.folder, root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(), sources: () => { const r = read(); return { file: "message" in r ? null : r, problem: null }; }, sourcesChanged: () => {}, log: () => {},
    readSource: () => { runEdits++; return read(); }, runUrl: s.url, listener: { running: () => [], cancel: (session) => ({ unknown: session }) },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(s.root, "duck.db"), pollSeconds: 5, poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }), summary: async () => { throw new Error("not asked here"); },
        lastUsed: async (u) => u.map(() => null) }, events: { days: 7, recent: async () => [] },
      usage: { days: 7, sampleSeconds: 60, samples: async (o) => { usageAsks.push(o); return [sample]; }, copySizes: async () => [{ table: "public.orders", bytes: 3 * 2 ** 20, at: "2026-10-28T09:10:00.000Z" }] },
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
    await same(["add", "customers", "--key", "id"], /public\.customers has a primary key \(id\), which Mason copies it by: leave --key out/);
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
      assert.match(person.stdout, /Each copy's own size \(measured every 10 min\):\n {2}public\.orders {2}\s+3\.0 MiB {2}at 09:10 UTC\n/);
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
  } finally {
    server.close();
    fs.writeFileSync(s.file, `kind: postgres\nurl: ${s.url}\ntables: {}\n`);
  }
});

test("mason status's queries: the last day and the last week a line each — every outcome, the completed ones' times, rows and bytes; a short log says so", () => {
  const queryLines = (commands as Record<string, unknown>).queryLines as ((q: unknown, st: typeof PLAIN) => string[]) | undefined;
  assert.equal(typeof queryLines, "function");
  const w = (days: number, covered: number) => ({ days, covered, statements: 1204, completed: 1190, refused: 10, failed: 2, cancelled: 2, rows: 52_000, bytesSent: 3 * 1024 * 1024,
    durationMs: { avg: 120, p50: 40, p95: 900 } });
  assert.deepEqual(queryLines!({ keptDays: 3, day: w(1, 1), week: { ...w(7, 3), durationMs: null } }, PLAIN), [
    "\nQueries (the completed ones' time: average / p50 / p95; mason logs --requests lists each):",
    "  last day    1,204 statements: 1,190 completed, 10 refused, 2 failed, 2 cancelled · 120 / 40 / 900 ms · 52,000 rows, 3.0 MiB sent",
    "  last week   1,204 statements: 1,190 completed, 10 refused, 2 failed, 2 cancelled · 52,000 rows, 3.0 MiB sent (the request log keeps 3 days: MASON_REQUEST_LOG_DAYS)",
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
  const ctx: RunContext = {
    page: false, users: { file: path.join(app, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [], slot: "", changes: "poll", port: 0,
    token: "t0ken-of-the-run", folder: () => path.join(app, "mason"), root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => ({ message: "not read here", code: "bad_source" }), runUrl: "postgres://me@localhost:5432/shop",
    listener: { running: () => [running], cancel: (session, statement) => { cancelled.push(statement === undefined ? session : [session, statement]);
      return session === 4 && statement !== undefined && statement !== 9 ? { other: running, asked: statement } : session === 4 ? { cancelled: running } : session === 6 ? { cancelled: { ...running, session: 6, runningMs: 125_000 } } : session === 5 ? { idle: 5 } : { unknown: session }; } },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(root, "duck.db"), pollSeconds: 5, poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, page: async (q) => { asked.push(q); return { requests: q.failed === true ? failedQueries as never : [], before: "2026-10-24T10:00:00.000Z~7" }; }, slow: async () => [],
        refused: async () => ({ total: 0, refused: [] }), summary: async () => { throw new Error("not asked here"); }, lastUsed: async (u) => u.map(() => null) },
      events: { days: 7, recent: async () => [] }, usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [] }, restarts: () => [] },
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
    // a mistake: exit 2, in the flag's name, before the run is asked
    const before = asked.length;
    for (const [argv, words] of [
      [["logs", "--requests", "--since", "soon"], /mason logs: --since "soon" is not a time/],
      [["logs", "--requests", "--outcome", "canceled"], /mason logs: --outcome "canceled" is none of ok, refused, failed, cancelled — did you mean `cancelled`\?/],
      [["logs", "--requests", "-n", "0"], /mason logs: -n is a whole number of requests, 1 to 10000/],
      [["logs", "--requests", "--failed", "--outcome", "ok"], /mason logs: --failed is every outcome but ok: name it or --outcome, never both/],
      [["logs", "--since", "2h"], /mason logs: --since is a filter of --requests/],
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
    assert.match((await run(["cancel", "4"])).stdout, /^Cancelled session 4's statement: it ends now, and its client is told so \(57014\)\.\n/);
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

test("mason status's Disk line: free where the copy is, and what the copies running add — said as more than is free when it is; an unread free space is its error", async () => {
  const { diskRows } = await import("../src/cli/commands.ts") as unknown as { diskRows?: (d: unknown) => Array<[string, string]> };
  assert.equal(typeof diskRows, "function", "src/cli/commands.ts diskRows");
  assert.deepEqual(diskRows!({ path: "/data", freeBytes: 75 * 2 ** 30, copyBytes: 49 * 2 ** 30, projectedBytes: null }), [["Disk", "75.0 GiB free in /data"]]);
  assert.deepEqual(diskRows!({ path: "/data", freeBytes: 75 * 2 ** 30, copyBytes: 49 * 2 ** 30, projectedBytes: 80 * 2 ** 30 }),
    [["Disk", "75.0 GiB free in /data · the copies running are projected to add about 80.0 GiB more — more than is free: the copy stops before the disk fills"]]);
  assert.deepEqual(diskRows!({ path: "/data", freeBytes: null, copyBytes: null, projectedBytes: null, error: "the free space where the copy is could not be read: EACCES" }),
    [["Disk", "the free space where the copy is could not be read: EACCES"]]);
  assert.deepEqual(diskRows!(undefined), [], "a run from before it: no line");
});
