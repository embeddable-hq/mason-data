/**
 * USAGE OVER TIME (src/duck/usage.ts, `_mason.usage`, `_mason.copy_sizes`): a sample is the run's facts as `take` gives
 * them, the statements counted as the listener records them (each in the interval it ended, exactly once), the memory of
 * the process and the copy; read back as written, or re-bucketed in one query (counts summed, levels at their highest);
 * each copy's own bytes from its blocks; a failure said once and never thrown, a sample that could not be taken costing
 * no request its count. Offline: a DuckDB file of the test's own.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import type { ApiLogRow } from "../src/api/request-log.ts";

// imported when the tests run: at a commit without the module this file still loads, and each test fails by name
type Usage = typeof import("../src/duck/usage.ts");
const usage = (): Promise<Usage> => import("../src/duck/usage.ts" as string) as Promise<Usage>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-usage-"));
const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "512MiB" });
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const facts = { copyBytes: 12_345, totals: { added: 3, copied: 2, failed: 1, rows: 1_000 }, oldestSyncSeconds: 42.5, streamLag: { bytes: 2_048, seconds: 1.5 }, copied: [] as string[],
  slotWalHeldBytes: 4_096, diskFreeBytes: 80 * 2 ** 30, sessionsOpen: 3 };
const row = (durationMs: number, o: Partial<ApiLogRow> = {}): ApiLogRow => ({ requestId: "r", at: new Date(), method: "QUERY", status: 200, durationMs, ...o });
const NEVER = 3_600_000;

test("a sample is the run's facts, the interval's statements by the request log summary's rules (refused, failed, cancelled, rows and bytes sent, the completed ones' p50 / p95) and the memory, read back as written", async () => {
  const { UsageSampler, USAGE_TABLE, quantileCont } = await usage();
  let clock = Date.parse("2026-10-28T09:00:00.000Z");
  const u = await UsageSampler.open(store, () => undefined, { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: NEVER, memory: () => ({ rss: 900, heapUsed: 300 }) });
  u.start(async () => facts);
  for (let ms = 1; ms <= 20; ms++) u.count(row(ms * 10, { rows: 5, bytesSent: 100 }));
  u.count(row(7, { sqlstate: "42P01", error: "no such table", bytesSent: 50 }));
  u.count(row(9_000, { sqlstate: "57014", error: "canceled", bytesSent: 50 }));
  u.count(row(8_000, { sqlstate: "XX000", error: "it broke", bytesSent: 50 }));
  // a refused login is no statement (the summary's rule)
  u.count(row(1, { method: "CONNECT", sqlstate: "28P01", error: "password authentication failed" }));
  clock += 60_000;
  await u.sample();
  clock += 60_000;
  u.count(row(3, { rows: 1 }));
  await u.sample();
  const got = await u.samples({ since: "2026-10-28T00:00:00Z", until: "2026-10-29T00:00:00Z" });
  assert.equal(got.length, 2);
  const [a, b] = got;
  const { copyMemoryBytes, ...rest } = a!;
  assert.deepEqual(rest, {
    at: "2026-10-28T09:01:00.000Z", seconds: 60, copyBytes: 12_345, copyRows: 1_000, tablesAdded: 3, tablesCopied: 2, tablesFailed: 1, oldestSyncSeconds: 42.5,
    statements: 23, statementsRefused: 1, statementsFailed: 1, statementsCancelled: 1, rowsSent: 100, bytesSent: 2_150,
    // the 20 completed: 10 … 200 ms, interpolated as quantile_cont — 105 and 190.5, rounded as the summary rounds
    durationP50Ms: 105, durationP95Ms: 191, streamLagBytes: 2_048, streamLagSeconds: 1.5, rssBytes: 900, heapUsedBytes: 300, copyMemoryLimitBytes: 512 * 2 ** 20,
    slotWalHeldBytes: 4_096, diskFreeBytes: 80 * 2 ** 30, sessionsOpen: 3,
  });
  assert.ok(typeof copyMemoryBytes === "number" && copyMemoryBytes >= 0, `the copy's memory in use is read: ${copyMemoryBytes}`);
  assert.deepEqual([b!.at, b!.statements, b!.statementsFailed, b!.rowsSent, b!.bytesSent, b!.durationP50Ms, b!.durationP95Ms], ["2026-10-28T09:02:00.000Z", 1, 0, 1, 0, 3, 3], "the next interval counts afresh");
  // the p50 and p95 are the request log summary's own (DuckDB's quantile_cont, rounded), over any durations
  for (const xs of [[5], [1, 2], [3, 1, 4, 1, 5, 9, 2, 6], Array.from({ length: 101 }, (_, k) => (k * 37) % 1000)]) {
    const [p50, p95] = (await store.writer.runAndReadAll(`SELECT quantile_cont(x, 0.5), quantile_cont(x, 0.95) FROM (SELECT unnest($1::INTEGER[]) AS x)`, [`[${xs.join(",")}]`])).getRowsJS()[0]!.map((v) => Math.round(Number(v)));
    const sorted = [...xs].sort((x, y) => x - y);
    assert.deepEqual([quantileCont(sorted, 0.5), quantileCont(sorted, 0.95)], [p50, p95], `quantile_cont over ${xs.join(",")}`);
  }
  await u.close();
  await store.writer.run(`DELETE FROM ${USAGE_TABLE}`);
});

test("re-bucketed in one query: buckets of the step from since, each count summed, each level at its highest; an empty interval has no duration", async () => {
  const { UsageSampler, USAGE_TABLE } = await usage();
  let clock = Date.parse("2026-10-28T10:00:00.000Z");
  let level = 0;
  const u = await UsageSampler.open(store, () => undefined, { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: NEVER });
  u.start(async () => ({ ...facts, copyBytes: 1_000 + level, totals: { ...facts.totals, rows: 10 * level }, diskFreeBytes: 10_000 - level }));
  for (let m = 1; m <= 6; m++) {
    level = m === 2 ? 50 : m;
    if (m !== 4) u.count(row(m * 100, { rows: m }));
    clock += 60_000;
    await u.sample();
  }
  const raw = await u.samples({ since: "2026-10-28T10:00:00Z", until: "2026-10-28T11:00:00Z" });
  assert.deepEqual(raw.map((s) => [s.statements, s.durationP95Ms]), [[1, 100], [1, 200], [1, 300], [0, null], [1, 500], [1, 600]]);
  const buckets = await u.samples({ since: "2026-10-28T10:00:00Z", until: "2026-10-28T11:00:00Z", stepSeconds: 180 });
  // samples at 10:01 … 10:06: 10:00–10:03 holds 10:01 and 10:02, 10:03–10:06 holds 10:03 … 10:05, 10:06– the last
  assert.deepEqual(buckets.map((s) => [s.at, s.seconds, s.statements, s.rowsSent, s.copyBytes, s.copyRows, s.durationP95Ms]), [
    ["2026-10-28T10:00:00.000Z", 120, 2, 3, 1_050, 500, 200],
    ["2026-10-28T10:03:00.000Z", 180, 2, 8, 1_005, 50, 500],
    ["2026-10-28T10:06:00.000Z", 60, 1, 6, 1_006, 60, 600],
  ]);
  // the disk free is the one level a bucket says at its LOWEST: its worst moment
  assert.deepEqual(buckets.map((s) => s.diskFreeBytes), [9_950, 9_995, 9_994]);
  assert.deepEqual(await u.samples({ since: "2026-10-28T10:02:00Z", until: "2026-10-28T10:04:00Z" }).then((r) => r.map((s) => s.at)),
    ["2026-10-28T10:02:00.000Z", "2026-10-28T10:03:00.000Z"], "since included, until not");
  await u.close();
  await store.writer.run(`DELETE FROM ${USAGE_TABLE}`);
});

test("a copy with no block of its own yet (its rows still in the write-ahead log) is not measured, never said as 0 bytes", async () => {
  const { UsageSampler } = await usage();
  const clock = Date.parse("2026-10-28T12:00:00.000Z");
  await store.writer.run("CHECKPOINT");
  await store.writer.run(`CREATE SCHEMA IF NOT EXISTS app`);
  await store.writer.run(`CREATE TABLE app.fresh AS SELECT i AS id FROM range(1000) t(i)`);
  const u = await UsageSampler.open(store, () => undefined, { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: 1 });
  try {
    u.start(async () => ({ ...facts, copied: ["app.fresh"] }));
    await u.sample();
    assert.deepEqual((await u.copySizes()).filter((c) => c.table === "app.fresh"), [], "not measured until its rows are in the file");
  } finally {
    await u.close();
    await store.writer.run(`DROP TABLE app.fresh`);
    await store.writer.run(`DELETE FROM _mason.copy_sizes`);
  }
});

test("each copy's own bytes are its blocks: a copy served is measured, by its schema.table, a table not served is not, and the latest is read back", async () => {
  const { UsageSampler, SIZES_TABLE, USAGE_TABLE } = await usage();
  let clock = Date.parse("2026-10-28T11:00:00.000Z");
  const said: string[] = [];
  await store.writer.run(`CREATE SCHEMA IF NOT EXISTS app`);
  await store.writer.run(`CREATE TABLE app."Odd ""Name""" AS SELECT i AS id, repeat('x', 200) || i::VARCHAR AS note FROM range(300000) t(i)`);
  await store.writer.run(`CREATE TABLE app.other AS SELECT i AS id FROM range(1000) t(i)`);
  await store.writer.run("CHECKPOINT");
  const u = await UsageSampler.open(store, (l) => said.push(l), { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: 10 * 60_000 });
  u.start(async () => ({ ...facts, copied: ['app.Odd "Name"', "app.gone"] }));
  await u.sample();
  const [sampled] = await u.samples({ since: "2026-10-28T00:00:00Z", until: "2026-10-29T00:00:00Z" });
  assert.ok(sampled!.copyMemoryBytes! > 0, `the copy's memory holds the tables just written: ${sampled!.copyMemoryBytes}`);
  const [first, ...none] = await u.copySizes();
  assert.deepEqual(none, [], "app.other is not a copy served, and app.gone is not there");
  assert.equal(first!.table, 'app.Odd "Name"');
  assert.equal(first!.at, "2026-10-28T11:00:00.000Z");
  const used = Number((await store.writer.runAndReadAll("SELECT used_blocks * block_size FROM pragma_database_size()")).getRowsJS()[0]![0]);
  assert.ok(first!.bytes > 1_000_000 && first!.bytes <= used, `its blocks, within the file's: ${first!.bytes} of ${used}`);
  assert.match(said.join("\n"), /^usage: measured 1 copies' own size in \d+ ms \(every 10 min\)$/m);
  // not again before its interval; again after it, and the latest is the one read
  clock += 60_000;
  await u.sample();
  assert.equal(Number((await store.writer.runAndReadAll(`SELECT count(*) FROM ${SIZES_TABLE}`)).getRowsJS()[0]![0]), 1);
  await store.writer.run(`INSERT INTO app."Odd ""Name""" SELECT i, repeat('y', 300) FROM range(300000) t(i)`);
  await store.writer.run("CHECKPOINT");
  clock += 10 * 60_000;
  await u.sample();
  const [later] = await u.copySizes();
  assert.equal(later!.at, "2026-10-28T11:11:00.000Z");
  assert.ok(later!.bytes > first!.bytes, `grown: ${later!.bytes} > ${first!.bytes}`);
  await u.close();
  await store.writer.run(`DROP TABLE app."Odd ""Name"""`);
  await store.writer.run(`DROP TABLE app.other`);
  await store.writer.run(`DELETE FROM ${SIZES_TABLE}`);
  await store.writer.run(`DELETE FROM ${USAGE_TABLE}`);
});

test("a sample that cannot be taken keeps its statements for the next; a write that fails is said once and never thrown; the samples past the retention are deleted", async () => {
  const { UsageSampler, USAGE_TABLE } = await usage();
  let clock = Date.parse("2026-10-28T12:00:00.000Z");
  const said: string[] = [];
  let away = true;
  let failWrites = false;
  const u = await UsageSampler.open(store, (l) => said.push(l), { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: NEVER,
    insert: async (sql, values) => { if (failWrites) throw new Error("disk full"); await store.writer.run(sql, values); } });
  u.start(async () => { if (away) throw new Error("the state cannot be read"); return facts; });
  u.count(row(5));
  clock += 60_000;
  await u.sample();
  clock += 60_000;
  await u.sample();
  u.count(row(6));
  away = false;
  clock += 60_000;
  await u.sample();
  const [s] = await u.samples({ since: "2026-10-28T00:00:00Z", until: "2026-10-29T00:00:00Z" });
  assert.deepEqual([s!.at, s!.seconds, s!.statements], ["2026-10-28T12:03:00.000Z", 180, 2], "one sample covering the three minutes, both statements in it");
  failWrites = true;
  for (let k = 0; k < 3; k++) { clock += 60_000; await u.sample(); }
  failWrites = false;
  clock += 60_000;
  await u.sample();
  assert.deepEqual(said.filter((l) => !l.startsWith("usage: measured")), [
    "usage: taking a sample failed: the state cannot be read; said once until one succeeds",
    "usage: taking a sample again; 2 time(s) it was not",
    `usage: writing a sample to ${USAGE_TABLE} failed: disk full; said once until one succeeds`,
    `usage: writing a sample to ${USAGE_TABLE} again; 3 time(s) it was not`,
  ]);
  await store.writer.run(`INSERT INTO ${USAGE_TABLE} (sampled_at, seconds) VALUES (now() - INTERVAL 8 DAY, 60)`);
  await u.trim();
  assert.equal(Number((await store.writer.runAndReadAll(`SELECT count(*) FROM ${USAGE_TABLE} WHERE sampled_at < now() - INTERVAL 7 DAY`)).getRowsJS()[0]![0]), 0);
  await u.close();
  await store.writer.run(`DELETE FROM ${USAGE_TABLE}`);
});

test("the durations an interval keeps are bounded while samples keep failing: exact up to the bound, a uniform sample past it", async () => {
  const { UsageSampler, USAGE_TABLE, quantileCont } = await usage();
  let clock = Date.parse("2026-10-28T13:00:00.000Z");
  let away = true;
  // a seeded draw (an LCG): the reservoir's choices, the same at every run
  let seed = 7;
  const random = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
  const u = await UsageSampler.open(store, () => undefined, { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: NEVER, durationsKept: 10, random });
  try {
    u.start(async () => { if (away) throw new Error("the state cannot be read"); return facts; });
    const kept = (): number => (u as unknown as { interval: { durations: number[] } }).interval.durations.length;
    // up to the bound: every duration, the quantiles exact
    for (let ms = 1; ms <= 10; ms++) u.count(row(ms));
    away = false;
    clock += 60_000;
    await u.sample();
    const [exact] = await u.samples({ since: "2026-10-28T13:00:00Z", until: "2026-10-28T14:00:00Z" });
    assert.deepEqual([exact!.durationP50Ms, exact!.durationP95Ms], [quantileCont([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), quantileCont([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)]);
    // samples failing for a long while: 50,000 statements, never more than the bound kept
    away = true;
    for (let k = 0; k < 10; k++) u.count(row(1));
    for (let k = 0; k < 50_000; k++) u.count(row(1_000));
    clock += 60_000;
    await u.sample();
    assert.equal(kept(), 10, "the interval keeps at most the bound");
    away = false;
    clock += 60_000;
    await u.sample();
    const [, carried] = await u.samples({ since: "2026-10-28T13:00:00Z", until: "2026-10-28T14:00:00Z" });
    assert.deepEqual([carried!.statements, carried!.durationP50Ms], [50_010, 1_000], "every statement counted; the quantile of a uniform sample of them");
  } finally {
    await u.close();
    await store.writer.run(`DELETE FROM ${USAGE_TABLE}`);
  }
});

test("samples are taken every interval once started, one after the other, and never after close", async () => {
  const { UsageSampler, USAGE_TABLE } = await usage();
  let taken = 0;
  const u = await UsageSampler.open(store, () => undefined, { days: 7, sampleMs: 20, sizeEveryMs: NEVER });
  u.start(async () => { taken++; return facts; });
  const deadline = Date.now() + 5_000;
  while (taken < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await u.close();
  const at = taken;
  assert.ok(at >= 3, `sampled every 20 ms: ${at}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(taken, at, "nothing after close");
  await store.writer.run(`DELETE FROM ${USAGE_TABLE}`);
});

test("a samples table a run before a column made gains it, and a sample is written and read back with it (the slot's WAL, the disk free, the sessions open)", async () => {
  const { UsageSampler, USAGE_TABLE } = await usage();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mason-usage-old-"));
  const old = await DuckStore.open(path.join(d, "duck.db"), () => undefined, { memoryLimit: "256MiB" });
  try {
    // the samples' table as the first samples made it, without the columns added since
    await old.writer.run("CREATE SCHEMA IF NOT EXISTS _mason");
    await old.writer.run(`CREATE TABLE ${USAGE_TABLE} (sampled_at TIMESTAMPTZ, seconds DOUBLE, copy_bytes BIGINT, copy_rows BIGINT, tables_added INTEGER, tables_copied INTEGER, ` +
      `tables_failed INTEGER, oldest_sync_seconds DOUBLE, statements BIGINT, statements_refused BIGINT, statements_failed BIGINT, statements_cancelled BIGINT, rows_sent BIGINT, ` +
      `bytes_sent BIGINT, duration_p50_ms INTEGER, duration_p95_ms INTEGER, stream_lag_bytes BIGINT, stream_lag_seconds DOUBLE, rss_bytes BIGINT, heap_used_bytes BIGINT, ` +
      `copy_memory_bytes BIGINT, copy_memory_limit_bytes BIGINT)`);
    const said: string[] = [];
    let clock = Date.parse("2026-10-28T13:00:00.000Z");
    const u = await UsageSampler.open(old, (l) => said.push(l), { days: 7, now: () => clock, sampleMs: NEVER, sizeEveryMs: NEVER });
    u.start(async () => facts);
    clock += 60_000;
    await u.sample();
    u.start(async () => ({ ...facts, slotWalHeldBytes: null, diskFreeBytes: null, sessionsOpen: 0 }));
    clock += 60_000;
    await u.sample();
    assert.deepEqual(said.filter((l) => /failed/.test(l)), [], "every sample written");
    const got = await u.samples({ since: "2026-10-28T00:00:00Z", until: "2026-10-29T00:00:00Z" });
    assert.deepEqual(got.map((x) => x.slotWalHeldBytes), [4_096, null], "the WAL the slot holds; null when polling, never a 0");
    assert.deepEqual(got.map((x) => x.diskFreeBytes), [80 * 2 ** 30, null], "the disk free; null when it could not be read, never a 0");
    assert.deepEqual(got.map((x) => x.sessionsOpen), [3, 0], "the sessions open");
    await u.close();
  } finally {
    old.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
