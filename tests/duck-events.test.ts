/**
 * THE SYNC'S EVENTS (src/duck/events.ts, `_mason.sync_events`; a sync failure was kept only as a table's current error,
 * wiped by the next success, and earlier ones only in the log file): what the sync records is read back as it was,
 * newest last, filtered as the commands ask; a failure repeated word for word is one event until its table recovers or
 * an hour passes; the events past MASON_HISTORY_DAYS are deleted, said; a write that fails is said once and never
 * thrown. Offline: a DuckDB file of the test's own.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";

// imported when the tests run: at a commit without the module this file still loads, and each test fails by name
type Events = typeof import("../src/duck/events.ts");
const events = (): Promise<Events> => import("../src/duck/events.ts" as string) as Promise<Events>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-events-"));
const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("the web page's own error (ui_error, src/cli/ui-errors.ts) is a failure of no table: read with --failed, and the same one again within the hour is one event", async () => {
  const { SyncEvents, isFailure } = await events();
  assert.ok(isFailure("ui_error"));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "mason-events-ui-"));
  const own = await DuckStore.open(path.join(dir2, "duck.db"), () => undefined);
  try {
    let clock = Date.parse("2026-11-13T09:00:00.000Z");
    const log = await SyncEvents.open(own, () => undefined, { days: 7, now: () => clock });
    const message = "the web page hit a TypeError on its overview view in app.js at line 1, column 2";
    log.record({ kind: "ui_error", table: null, message });
    clock += 1000;
    log.record({ kind: "ui_error", table: null, message });
    clock += 1000;
    log.record({ kind: "full_sync", table: "public.orders", message: "copied" });
    await log.flush();
    assert.deepEqual(await log.recent({ limit: 10, failed: true }), [{ at: "2026-11-13T09:00:00.000Z", kind: "ui_error", failed: true, table: null, message }]);
    await log.close();
  } finally { await own.close(); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test("every event is read back as the sync recorded it, newest last; --failed is the failures alone; the newest n; from a time on", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  let clock = Date.parse("2026-10-28T09:00:00.000Z");
  const said: string[] = [];
  const log = await SyncEvents.open(store, (l) => said.push(l), { days: 7, now: () => clock });
  log.record({ kind: "full_sync_failed", table: "public.orders", message: "the source closed the connection; tried again after 09:05 UTC" });
  clock += 1000;
  log.record({ kind: "full_sync", table: "public.orders", message: "synced: 1,000 row(s) in 2.00 s" });
  clock += 1000;
  log.record({ kind: "stream_failed", table: null, message: "replication: the slot is in use" });
  assert.deepEqual(await log.recent({ limit: 10 }), [], "nothing is read before its batch commits");
  await log.flush();
  assert.deepEqual(await log.recent({ limit: 10 }), [
    { at: "2026-10-28T09:00:00.000Z", kind: "full_sync_failed", failed: true, table: "public.orders", message: "the source closed the connection; tried again after 09:05 UTC" },
    { at: "2026-10-28T09:00:01.000Z", kind: "full_sync", failed: false, table: "public.orders", message: "synced: 1,000 row(s) in 2.00 s" },
    { at: "2026-10-28T09:00:02.000Z", kind: "stream_failed", failed: true, table: null, message: "replication: the slot is in use" },
  ]);
  assert.deepEqual((await log.recent({ limit: 10, failed: true })).map((e) => e.kind), ["full_sync_failed", "stream_failed"], "the failures alone");
  assert.deepEqual((await log.recent({ limit: 1 })).map((e) => e.kind), ["stream_failed"], "the newest n, newest last");
  assert.deepEqual((await log.recent({ limit: 10, since: "2026-10-28T09:00:01.000Z" })).map((e) => e.kind), ["full_sync", "stream_failed"], "from a time on");
  assert.deepEqual(said, []);
  await log.close();
  // numbered across a restart: the next opening continues
  const again = await SyncEvents.open(store, () => undefined, { days: 7, now: () => clock });
  again.record({ kind: "recovered", table: "public.orders", message: "current again" });
  await again.close();
  assert.deepEqual((await store.writer.runAndReadAll(`SELECT seq FROM ${EVENTS_TABLE} ORDER BY seq`)).getRowsJS().map((r) => Number(r[0])), [0, 1, 2, 3]);
  await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
});

test("the scheduled syncs (polled, streamed) are kept, but read only when asked for: never taking a place of the newest n, nor among the failures", async () => {
  const { SyncEvents, EVENTS_TABLE, SCHEDULED } = await events();
  assert.deepEqual([...SCHEDULED], ["polled", "streamed"]);
  let clock = Date.parse("2026-10-28T09:00:00.000Z");
  const log = await SyncEvents.open(store, () => undefined, { days: 7, now: () => clock });
  log.record({ kind: "poll_failed", table: "public.orders", message: "the poll failed" });
  clock += 1000;
  log.record({ kind: "recovered", table: "public.orders", message: "current again" });
  // a busy minute of scheduled syncs after them: newer than the failure, more than the limit asked
  for (let i = 0; i < 5; i++) { clock += 1000; log.record({ kind: "polled", table: "public.orders", message: `synced on schedule: ${i} changed` }); }
  clock += 1000;
  log.record({ kind: "streamed", table: "public.events", message: "streamed 3 changes (3 inserts) in the last 60 s" });
  await log.flush();
  assert.deepEqual((await log.recent({ limit: 2 })).map((e) => e.kind), ["poll_failed", "recovered"], "left out: the newest 2 are the others'");
  assert.deepEqual((await log.recent({ limit: 2, scheduled: true })).map((e) => e.kind), ["polled", "streamed"], "asked for: the newest 2 of all");
  assert.equal((await log.recent({ limit: 20, scheduled: true })).length, 8, "every one kept");
  assert.deepEqual((await log.recent({ limit: 20, failed: true, scheduled: true })).map((e) => e.kind), ["poll_failed"], "never a failure");
  const polled = (await log.recent({ limit: 20, scheduled: true })).find((e) => e.kind === "polled")!;
  assert.equal(polled.failed, false);
  await log.close();
  await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
});

test("a failure said again word for word is one event, until its table is current again or an hour has passed", async () => {
  const { SyncEvents, EVENTS_TABLE, REPEAT_MS } = await events();
  let clock = Date.parse("2026-10-28T10:00:00.000Z");
  const log = await SyncEvents.open(store, () => undefined, { days: 7, now: () => clock });
  const away = { kind: "poll_failed" as const, table: "public.orders", message: "the poll failed: connection refused" };
  log.record(away);
  for (let i = 0; i < 5; i++) { clock += 5_000; log.record(away); }
  log.record({ ...away, table: "public.lines" });
  log.record({ ...away, message: "the poll failed: out of memory" });
  clock += 5_000;
  log.record({ kind: "recovered", table: "public.orders", message: "current again" });
  log.record(away);
  clock += REPEAT_MS;
  log.record({ ...away, table: "public.lines" });
  await log.flush();
  assert.deepEqual((await log.recent({ limit: 20 })).map((e) => `${e.kind} ${e.table} ${e.message}`), [
    "poll_failed public.orders the poll failed: connection refused",
    "poll_failed public.lines the poll failed: connection refused",
    "poll_failed public.orders the poll failed: out of memory",
    "recovered public.orders current again",
    "poll_failed public.orders the poll failed: connection refused",
    "poll_failed public.lines the poll failed: connection refused",
  ], "five repeats in 25 s are the first; another table, another reason, a recovery and an hour each say it again");
  await log.close();
  await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
});

test("a failure over is said again when it recurs: a table's once it is copied anew, the whole sync's once a recovered of no table says it is over", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  let clock = Date.parse("2026-10-28T11:00:00.000Z");
  const log = await SyncEvents.open(store, () => undefined, { days: 7, now: () => clock });
  try {
    const failed = { kind: "full_sync_failed" as const, table: "public.orders", message: "the source closed the connection" };
    const away = { kind: "source_unreachable" as const, table: null, message: "could not attach the database: connection refused" };
    const stream = { kind: "stream_failed" as const, table: null, message: "replication: the slot is in use" };
    for (const e of [failed, away, stream]) log.record(e);
    clock += 1000;
    log.record({ kind: "full_sync", table: "public.orders", message: "synced: 10 row(s) in 0.10 s" });
    log.record({ kind: "recovered", table: null, message: "the database is attached again" });
    clock += 1000;
    for (const e of [failed, away, stream]) log.record(e);
    await log.flush();
    assert.deepEqual((await log.recent({ limit: 20 })).map((e) => `${e.kind} ${e.table}`), [
      "full_sync_failed public.orders", "source_unreachable null", "stream_failed null",
      "full_sync public.orders", "recovered null",
      "full_sync_failed public.orders", "source_unreachable null", "stream_failed null",
    ], "within the hour, each is said again: the full sync succeeded between, and the whole sync recovered between");
  } finally {
    // the next test reads the table: nothing of this one's is left in it, passed or failed
    await log.close();
    await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
  }
});

test("the retention is counted back from the clock the events were given, never the engine's: a year behind it or a year ahead", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  const YEAR = 365 * 86_400_000, DAY = 86_400_000;
  for (const offset of [-YEAR, YEAR]) {
    let clock = Date.now() + offset;
    const said: string[] = [];
    const log = await SyncEvents.open(store, (l) => said.push(l), { days: 7, now: () => clock });
    log.record({ kind: "full_sync", table: "public.a", message: "eight days old" });
    clock += DAY;
    log.record({ kind: "full_sync", table: "public.b", message: "seven days old" });
    clock += 7 * DAY;
    log.record({ kind: "full_sync", table: "public.c", message: "today" });
    await log.flush();
    assert.equal(await log.trim(), 1, `offset ${offset}: only what is past the retention by the given clock`);
    assert.deepEqual((await log.recent({ limit: 10 })).map((e) => e.message), ["seven days old", "today"], `offset ${offset}`);
    assert.deepEqual(said, ["sync events: deleted 1 event(s) older than 7 days (MASON_HISTORY_DAYS)"]);
    await log.close();
    await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
  }
});

test("events older than the retention are deleted, said with their count; a write that fails is said once, never thrown", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  await store.writer.run(`CREATE SCHEMA IF NOT EXISTS _mason`);
  await store.writer.run(`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (happened_at TIMESTAMPTZ, seq BIGINT, kind VARCHAR, table_name VARCHAR, message VARCHAR)`);
  // dated by the process's clock, the one the events read when given none (never the engine's now())
  const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
  await store.writer.run(`INSERT INTO ${EVENTS_TABLE} VALUES ($1::TIMESTAMPTZ, 0, 'full_sync', 'public.a', 'old'), ($2::TIMESTAMPTZ, 1, 'full_sync', 'public.a', 'recent')`, [ago(10), ago(1)]);
  const said: string[] = [];
  const kept = await SyncEvents.open(store, (l) => said.push(l), { days: 7 });
  assert.deepEqual(said, ["sync events: deleted 1 event(s) older than 7 days (MASON_HISTORY_DAYS)"]);
  assert.deepEqual((await kept.recent({ limit: 10 })).map((e) => e.message), ["recent"]);
  await kept.close();
  said.length = 0;
  let failing = true;
  const flaky = await SyncEvents.open(store, (l) => said.push(l), { days: 7, insert: async (sql, values) => { if (failing) throw new Error("disk full"); await store.writer.run(sql, values); } });
  flaky.record({ kind: "full_sync_failed", table: "public.a", message: "one" });
  await flaky.flush();
  flaky.record({ kind: "full_sync_failed", table: "public.a", message: "two" });
  await flaky.flush();
  failing = false;
  flaky.record({ kind: "full_sync_failed", table: "public.a", message: "three" });
  await flaky.flush();
  assert.deepEqual(said, [
    `sync events: could not record 1 event(s) in ${EVENTS_TABLE} (full_sync_failed public.a): disk full; said once until a write succeeds (the log has each one)`,
    "sync events: recording again; 2 event(s) were not recorded (the log has them)",
  ]);
  assert.deepEqual((await flaky.recent({ limit: 10 })).map((e) => e.message), ["recent", "three"]);
  await flaky.close();
  await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
});

test("the run's restarts are merged with the events, newest last, asked as the events are: since, the newest n, within the retention", async () => {
  const { withRestarts } = await events();
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const e = (at: string, kind: "full_sync" | "poll_failed") => ({ at, kind, failed: kind !== "full_sync", table: "public.a", message: kind });
  const list = [e("2026-10-28T10:00:00.000Z", "full_sync"), e("2026-10-28T11:00:00.000Z", "poll_failed")];
  const restarts = [{ at: "2026-10-01T00:00:00.000Z", reason: "too old", upSeconds: 1 }, { at: "2026-10-28T10:30:00.000Z", reason: "it crashed (SIGSEGV)", upSeconds: 42 }];
  const merged = withRestarts(list, restarts, { limit: 10, days: 7, now });
  assert.deepEqual(merged.map((x) => `${x.at.slice(11, 16)} ${x.kind}`), ["10:00 full_sync", "10:30 restart", "11:00 poll_failed"]);
  assert.deepEqual(merged[1], { at: "2026-10-28T10:30:00.000Z", kind: "restart", failed: true, table: null,
    message: "the run stopped (it crashed (SIGSEGV)) after 42 s up, and its supervisor started it again" });
  assert.deepEqual(withRestarts(list, restarts, { limit: 2, days: 7, now }).map((x) => x.kind), ["restart", "poll_failed"], "the newest 2 of both");
  assert.deepEqual(withRestarts([], restarts, { limit: 10, days: 7, now, since: "2026-10-28T11:00:00.000Z" }), [], "since applies to a restart too");
});

test("a table's full sync is the event kind full_sync, and its failure full_sync_failed: no kind a person reads says copy (issue 953)", async () => {
  const { EVENT_KINDS, isFailure } = await events();
  const kinds: readonly string[] = EVENT_KINDS;
  assert.ok(kinds.includes("full_sync") && kinds.includes("full_sync_failed"), kinds.join(", "));
  assert.deepEqual(kinds.filter((k) => /cop(y|ied|ies)/.test(k)), [], "CLAUDE.md: say sync, never copy");
  assert.equal(isFailure("full_sync_failed"), true);
  assert.equal(isFailure("full_sync"), false);
});

test("an events table written before the kinds were renamed (copied, copy_failed) still reads: each old row shown with its kind as written, never thrown", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  await store.writer.run(`CREATE SCHEMA IF NOT EXISTS _mason`);
  await store.writer.run(`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (happened_at TIMESTAMPTZ, seq BIGINT, kind VARCHAR, table_name VARCHAR, message VARCHAR)`);
  const at = (s: number): string => new Date(Date.now() - 3_600_000 + s * 1000).toISOString();
  await store.writer.run(`INSERT INTO ${EVENTS_TABLE} VALUES ($1::TIMESTAMPTZ, 0, 'copy_failed', 'public.a', 'the source closed the connection'), ` +
    `($2::TIMESTAMPTZ, 1, 'copied', 'public.a', 'synced: 10 row(s) in 0.10 s')`, [at(0), at(1)]);
  const log = await SyncEvents.open(store, () => undefined, { days: 7 });
  try {
    log.record({ kind: "full_sync", table: "public.a", message: "synced: 10 row(s) in 0.10 s" });
    await log.flush();
    assert.deepEqual((await log.recent({ limit: 10 })).map((e) => [e.kind, e.failed]), [["copy_failed", false], ["copied", false], ["full_sync", false]],
      "the old kinds read as written; no longer kinds the readers know, so not failures");
    assert.deepEqual(await log.recent({ limit: 10, failed: true }), [], "the failures alone: the kinds it knows");
  } finally { await log.close(); await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`); }
});
