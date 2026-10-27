/**
 * The commands beside `mason start` (src/cli/commands.ts, runs.ts): which table a command means, what `mason add`
 * reads, when `mason wait` says ready, and how every table, the stream and the request log are rendered.
 */
import { test } from "node:test";
import { PLAIN } from "../src/cli/style.ts";
import type { Failure } from "../src/cli/command.ts";
import * as assert from "node:assert/strict";
import { addSpecs, addSteps, copyProgress, duration, findTable, paintBar, readiness, STATUS, tableLines, WAIT, type RunState, type TableState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";
import { jsonText } from "../src/cli/command.ts";
import type { CopyProgressView, StreamStatus } from "../src/duck/sync.ts";

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
  const base = { requestId: "r", session: 1, method: "QUERY", detail: null, hint: null, queryTruncated: false, user: "" };
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
