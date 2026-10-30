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
import type { CopyProgressView, KeptCurrent, StreamStatus } from "../src/duck/sync.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { connectSource, parseSource, readSourceFacts } from "../src/cli/preflight.ts";
import { readSource } from "../src/cli/sources.ts";
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
  project: "v1", tables: o.tables ?? [], engine: { name: "duckdb", file: "/app/.mason/duck.db", bytes: 10 },
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
    "public.orders  ████████████████████ 100%  22,086,165 rows · copied · sync: off, last synced 3 days ago — mason sync orders syncs it now; sync: poll 5m on its entry polls it",
    "shop.events    ████████████████████ 100%  3 rows · copied · polled every 30s, last 4 s ago",
    "public.fresh   ████████████████████ 100%  5 rows · copied · polled every 30s, not polled yet",
    "public.small   ████████████████████ 100%  7 rows · copied",
  ]);
  // an `off` table is copied as its sync asks: its bar is green, never a warning's colour; one not kept current is yellow
  const st = { ...PLAIN, yellow: (x: string) => `<y>${x}</y>`, green: (x: string) => `<g>${x}</g>` };
  assert.match(paintBar(lines[0]!, st), /<g>█{20}<\/g>/);
  const behind = tableLines(state({ tables: [t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 1, updatedAt: at(1) },
    kept: { by: "poll", sync: every30, syncedAt: "2026-10-29T11:00:00.000Z", nextAt: null, pending: "its columns changed: it is copied again, then caught up by one poll" } })] }), now);
  assert.deepEqual(behind, ["public.orders  ████████████████████ 100%  1 rows · copied · NOT kept current (last synced 60 min ago): its columns changed: it is copied again, then caught up by one poll"]);
  assert.match(paintBar(behind[0]!, st), /<y>█{20}<\/y>/);
  // ready all the same: it is copied and served
  assert.equal(readiness(state({ tables: [t({ table: "public.orders", added: true, copy: { phase: "done", rowsCopied: 1, updatedAt: at(1) }, kept: { by: "poll", sync: off, syncedAt: null, nextAt: null } })] })).ready, true);
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
    slot: "mason_shop", publication: "mason_shop", running: true, failure: null,
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
    "last change    committed 5.0 s ago, applied 0.3 s after its commit",
    "public.orders  streamed · 1,204 changes (1,000 inserts, 200 updates, 4 deletes) this run",
    "shop.lines     catching up by one poll from 2026-10-26 11:58 UTC: polling, for 3.0 s · the stream holds 12 changes of it meanwhile",
    "public.events  left out: publication app_pub does not carry public.events: ALTER PUBLICATION app_pub ADD TABLE public.events",
    "public.big     not streamed yet: it is being copied: it joins once copied and caught up by one poll",
  ]);
  // a stream that failed says why and when it starts again; a database that could not be asked says so, never a lag of 0
  assert.deepEqual(streamLines({ ...stream, running: false, failure: { error: "replication: the slot is in use\nmore", retryAt: "2026-10-26T12:00:40.000Z" },
    database: { error: "connect ECONNREFUSED" }, lag: { bytes: null, seconds: null }, lastBatch: null, tables: [] }, now), [
    "stream       not running: replication: the slot is in use · it starts again in 30 s",
    "position     0/1A2B3C8 · the database's position could not be read: connect ECONNREFUSED",
    "last change  none applied this run",
  ]);
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
    { by: "poll", sync: { mode: "poll", every: "30s", seconds: 30 }, syncedAt: at(1), nextAt: at(31), pending: "its columns changed: it is copied again, then caught up by one poll" },
    { by: "poll", sync: { mode: "off" }, syncedAt: at(1), nextAt: null },
    { by: "recopy", copiedAt: at(2) },
    { by: "replication", slot: "mason_shop", state: "streamed", why: null, position: "0/1A2B3C8", lastCommit: at(3), notRunning: "Mason is stopping" },
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
  assert.match(decl, /syncedAt \(its last copy or poll\), nextAt \(when its next poll is due; null: off/);
  assert.match(decl, /pending \(only when it applies: why the copy is not kept current now, its phase included/);
  assert.match(decl, /by: recopy, copiedAt, pending \(only when it applies/);
  assert.match(WAIT.usage.replace(/\s+/g, " "), /pending, when it applies, says why the copy is not kept current now, its phase included/);
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

test("mason logs --requests: a request a line, newest last — when, the outcome and SQLSTATE, the time, the rows, who, the statement and the error", () => {
  const { requestLine } = commands;
  const base = { requestId: "r", session: 1, method: "QUERY", detail: null, hint: null, queryTruncated: false, user: "", role: "" };
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:11.123Z", applicationName: "Metabase", tokenName: "", outcome: "ok", sqlstate: null, message: null,
    rows: 20, durationMs: 1234, query: "SELECT id\n FROM public.orders LIMIT 20" }, PLAIN),
    "2026-10-26 14:02:11  ok              1,234 ms      20 rows  Metabase  SELECT id FROM public.orders LIMIT 20");
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:12.000Z", applicationName: "", tokenName: "bi", outcome: "refused", sqlstate: "42P01",
    message: 'relation "nope" does not exist\nsecond', rows: null, durationMs: 3, query: "SELECT * FROM nope" }, PLAIN),
    '2026-10-26 14:02:12  refused 42P01       3 ms               (no application_name) (token bi)  SELECT * FROM nope — relation "nope" does not exist');
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:13.000Z", applicationName: "psql", tokenName: "", outcome: "failed", sqlstate: "XX000",
    message: "it broke", rows: null, durationMs: 0, query: "" }, PLAIN),
    "2026-10-26 14:02:13  failed XX000        0 ms               psql  (no statement) — it broke");
  // a mason user's statement names the user (src/duck/users.ts)
  assert.equal(requestLine({ ...base, startedAt: "2026-10-26T14:02:14.000Z", applicationName: "Metabase", tokenName: "", user: "metabase", outcome: "ok", sqlstate: null, message: null,
    rows: 1, durationMs: 5, query: "SELECT 1 FROM orders" }, PLAIN),
    "2026-10-26 14:02:14  ok                  5 ms        1 row  Metabase (user metabase)  SELECT 1 FROM orders");
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
    sync: { value: "off", from: "default" }, bigOff: false, pollCost: null }],
    file: s.file, next: [{ command: "mason start", what: "Mason in the background, for this project: the copy of every added table begins" },
      { command: "mason wait", what: "then, until every added table is copied and served" }] });
  assert.equal(fs.readFileSync(s.file, "utf8"), `kind: postgres\nurl: ${s.url}\ntables:\n  orders: {}\n`, "the entry, every other byte as it was");
  // as a person: the checklist's line, then Next: mason start
  const person = await run(["add", "customers", "--columns", "name"]);
  assert.equal(person.code, 0, person.stdout + person.stderr);
  assert.match(person.stdout, /✓ Added public\.customers to mason\/sources\/shop\.yml: id, name\n {4}sync: off \(the default\): after its first copy it is read again only by mason sync customers — mason add customers --sync "poll 5m" polls it every 5 minutes\n {4}key added: id \(a copy always has its key\)\n/);
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
  const ctx: RunContext = {
    page: false, users: { file: path.join(app, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => facts, warnings: [], slot: "", changes: "poll", port: 0, token: "t0ken-of-the-run",
    folder: () => s.folder, root: app, sources: () => { const r = read(); return { file: "message" in r ? null : r, problem: null }; }, sourcesChanged: () => {}, log: () => {},
    readSource: () => { runEdits++; return read(); }, runUrl: s.url,
    duck: { copies: () => [], file: path.join(s.root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null,
      requests: { days: 7, recent: async () => [], slow: async () => [], refused: async () => ({ total: 0, refused: [] }) } },
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

    // WHAT TO RUN NEXT, Mason up (a review finding): --sync alone on a table already added starts no copy (it is caught up
    // by one poll), so the next step is mason status, never mason wait's "the copy has started"; a new table's is mason wait
    fs.writeFileSync(s.file, `kind: postgres\nurl: ${s.url}\ntables:\n  customers: {}\n`);
    writeRunning(s.root, { port: ctx.port, token: ctx.token });
    try {
      const resync = await runMason(app, ["add", "customers", "--sync", "poll 30s", "--json"], matrixEnv());
      assert.equal(resync.code, 0, resync.stdout + resync.stderr);
      assert.deepEqual((JSON.parse(resync.stdout) as { next: unknown }).next, [
        { command: "mason status", what: "its sync and its copy's age: it is caught up by one poll, never copied again" },
        { command: "mason user add <name>", what: "a user for your BI tool or psql: it prints the password and the URL to paste" }]);
      assert.match(fs.readFileSync(s.file, "utf8"), /\n {2}customers:\n {4}sync: poll 30s\n$/);
      const person = await runMason(app, ["add", "customers", "--sync", "off"], matrixEnv());
      assert.match(person.stdout, /Next:\n {2}mason status +its sync and its copy's age: it is caught up by one poll, never copied again\n/);
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

  // NO FILE: every user reads every copied table, as before stage 1b: no role, nothing said
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
  const ctx: RunContext = {
    page: false, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => ({ tables: [], versionText: "PostgreSQL 18.0", standby: false }) as unknown as ReturnType<RunContext["facts"]>, warnings: [], slot: "", changes: "poll", port: 0, token: "t0ken-of-the-run",
    folder: () => folder, root, sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => readSource(folder, root, {}), runUrl: "postgres://mason:x@127.0.0.1:1/shop", roles: () => live.now(),
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null,
      requests: { days: 7, recent: async () => [], slow: async () => [], refused: async () => ({ total: 0, refused: [] }) } },
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
    assert.match((await run(["user", "add", "mode"])).stdout, /Tip: Its statements are refused until it has a role: write default: everything at the top of mason\/roles\.yml, or mason user remove mode and mason user add mode --role everything\./);
  } finally { config(null); server.close(); }
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
  assert.equal(failure(none).fix, "write mason/roles.yml:\n  roles:\n    agent:\n      tables:\n        <a copied table>: {}\nthen mason user add <name> --role agent");
  // the file's mistakes, each at its key: a misspelt top key, a role with no table, a table the sources file does not copy, a column both listed and excluded
  for (const [text, want] of [
    ["role:\n  agent:\n    tables:\n      orders: {}\n", /unexpected key role — did you mean `roles`\? — a roles file takes default and roles/],
    ["roles:\n  agent: {}\n", /roles\.agent\.tables: missing — write tables: all \(every copied table\) or tables: \{ orders: \{\} \}, the tables the role may read \(a role with no table reads nothing: remove it instead\)/],
    ["roles:\n  agent:\n    tables:\n      products: {}\n", /roles\.agent\.tables\.products: public\.products is not a table the sources file copies — a role reads copied tables only \(copied: orders, customers, billing\.invoices; mason add products copies it\)/],
    // a bare name of a table copied under its schema: the qualified entry is suggested
    ["roles:\n  agent:\n    tables:\n      invoices: {}\n", /roles\.agent\.tables\.invoices: public\.invoices is not a table the sources file copies — did you mean `billing\.invoices`\? — a role reads copied tables only/],
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
