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
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("every event is read back as the sync recorded it, newest last; --failed is the failures alone; the newest n; from a time on", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  let clock = Date.parse("2026-10-28T09:00:00.000Z");
  const said: string[] = [];
  const log = await SyncEvents.open(store, (l) => said.push(l), { days: 7, now: () => clock });
  log.record({ kind: "copy_failed", table: "public.orders", message: "the source closed the connection; tried again after 09:05 UTC" });
  clock += 1000;
  log.record({ kind: "copied", table: "public.orders", message: "copied: 1,000 row(s) in 2.00 s" });
  clock += 1000;
  log.record({ kind: "stream_failed", table: null, message: "replication: the slot is in use" });
  assert.deepEqual(await log.recent({ limit: 10 }), [], "nothing is read before its batch commits");
  await log.flush();
  assert.deepEqual(await log.recent({ limit: 10 }), [
    { at: "2026-10-28T09:00:00.000Z", kind: "copy_failed", failed: true, table: "public.orders", message: "the source closed the connection; tried again after 09:05 UTC" },
    { at: "2026-10-28T09:00:01.000Z", kind: "copied", failed: false, table: "public.orders", message: "copied: 1,000 row(s) in 2.00 s" },
    { at: "2026-10-28T09:00:02.000Z", kind: "stream_failed", failed: true, table: null, message: "replication: the slot is in use" },
  ]);
  assert.deepEqual((await log.recent({ limit: 10, failed: true })).map((e) => e.kind), ["copy_failed", "stream_failed"], "the failures alone");
  assert.deepEqual((await log.recent({ limit: 1 })).map((e) => e.kind), ["stream_failed"], "the newest n, newest last");
  assert.deepEqual((await log.recent({ limit: 10, since: "2026-10-28T09:00:01.000Z" })).map((e) => e.kind), ["copied", "stream_failed"], "from a time on");
  assert.deepEqual(said, []);
  await log.close();
  // numbered across a restart: the next opening continues
  const again = await SyncEvents.open(store, () => undefined, { days: 7, now: () => clock });
  again.record({ kind: "recovered", table: "public.orders", message: "current again" });
  await again.close();
  assert.deepEqual((await store.writer.runAndReadAll(`SELECT seq FROM ${EVENTS_TABLE} ORDER BY seq`)).getRowsJS().map((r) => Number(r[0])), [0, 1, 2, 3]);
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
    const failed = { kind: "copy_failed" as const, table: "public.orders", message: "the source closed the connection" };
    const away = { kind: "source_unreachable" as const, table: null, message: "could not attach the database: connection refused" };
    const stream = { kind: "stream_failed" as const, table: null, message: "replication: the slot is in use" };
    for (const e of [failed, away, stream]) log.record(e);
    clock += 1000;
    log.record({ kind: "copied", table: "public.orders", message: "copied: 10 row(s) in 0.10 s" });
    log.record({ kind: "recovered", table: null, message: "the database is attached again" });
    clock += 1000;
    for (const e of [failed, away, stream]) log.record(e);
    await log.flush();
    assert.deepEqual((await log.recent({ limit: 20 })).map((e) => `${e.kind} ${e.table}`), [
      "copy_failed public.orders", "source_unreachable null", "stream_failed null",
      "copied public.orders", "recovered null",
      "copy_failed public.orders", "source_unreachable null", "stream_failed null",
    ], "within the hour, each is said again: the copy succeeded between, and the whole sync recovered between");
  } finally {
    // the next test reads the table: nothing of this one's is left in it, passed or failed
    await log.close();
    await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
  }
});

test("events older than the retention are deleted, said with their count; a write that fails is said once, never thrown", async () => {
  const { SyncEvents, EVENTS_TABLE } = await events();
  await store.writer.run(`CREATE SCHEMA IF NOT EXISTS _mason`);
  await store.writer.run(`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (happened_at TIMESTAMPTZ, seq BIGINT, kind VARCHAR, table_name VARCHAR, message VARCHAR)`);
  await store.writer.run(`INSERT INTO ${EVENTS_TABLE} VALUES (now() - INTERVAL 10 DAY, 0, 'copied', 'public.a', 'old'), (now() - INTERVAL 1 DAY, 1, 'copied', 'public.a', 'recent')`);
  const said: string[] = [];
  const kept = await SyncEvents.open(store, (l) => said.push(l), { days: 7 });
  assert.deepEqual(said, ["sync events: deleted 1 event(s) older than 7 days (MASON_HISTORY_DAYS)"]);
  assert.deepEqual((await kept.recent({ limit: 10 })).map((e) => e.message), ["recent"]);
  await kept.close();
  said.length = 0;
  let failing = true;
  const flaky = await SyncEvents.open(store, (l) => said.push(l), { days: 7, insert: async (sql, values) => { if (failing) throw new Error("disk full"); await store.writer.run(sql, values); } });
  flaky.record({ kind: "copy_failed", table: "public.a", message: "one" });
  await flaky.flush();
  flaky.record({ kind: "copy_failed", table: "public.a", message: "two" });
  await flaky.flush();
  failing = false;
  flaky.record({ kind: "copy_failed", table: "public.a", message: "three" });
  await flaky.flush();
  assert.deepEqual(said, [
    `sync events: could not record 1 event(s) in ${EVENTS_TABLE} (copy_failed public.a): disk full; said once until a write succeeds (the log has each one)`,
    "sync events: recording again; 2 event(s) were not recorded (the log has them)",
  ]);
  assert.deepEqual((await flaky.recent({ limit: 10 })).map((e) => e.message), ["recent", "three"]);
  await flaky.close();
  await store.writer.run(`DELETE FROM ${EVENTS_TABLE}`);
});

test("the run's restarts are merged with the events, newest last, asked as the events are: since, the newest n, within the retention", async () => {
  const { withRestarts } = await events();
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const e = (at: string, kind: "copied" | "poll_failed") => ({ at, kind, failed: kind !== "copied", table: "public.a", message: kind });
  const list = [e("2026-10-28T10:00:00.000Z", "copied"), e("2026-10-28T11:00:00.000Z", "poll_failed")];
  const restarts = [{ at: "2026-10-01T00:00:00.000Z", reason: "too old", upSeconds: 1 }, { at: "2026-10-28T10:30:00.000Z", reason: "it crashed (SIGSEGV)", upSeconds: 42 }];
  const merged = withRestarts(list, restarts, { limit: 10, days: 7, now });
  assert.deepEqual(merged.map((x) => `${x.at.slice(11, 16)} ${x.kind}`), ["10:00 copied", "10:30 restart", "11:00 poll_failed"]);
  assert.deepEqual(merged[1], { at: "2026-10-28T10:30:00.000Z", kind: "restart", failed: true, table: null,
    message: "the run stopped (it crashed (SIGSEGV)) after 42 s up, and its supervisor started it again" });
  assert.deepEqual(withRestarts(list, restarts, { limit: 2, days: 7, now }).map((x) => x.kind), ["restart", "poll_failed"], "the newest 2 of both");
  assert.deepEqual(withRestarts([], restarts, { limit: 10, days: 7, now, since: "2026-10-28T11:00:00.000Z" }), [], "since applies to a restart too");
});
