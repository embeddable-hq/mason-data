/**
 * WHAT THE SYNC SAYS OF EACH COPY BETWEEN TWO COPIES (src/duck/sync.ts `CopyState.rows`, `synced`; mason status, the
 * plan's "Status" and "Tables"): a copy's rows are its rows after EVERY stream batch — they were counted at most every
 * 5 s, so the batches after a count were missing from it until another batch came — and kept in the ledger in the
 * batch's own transaction; when it was last brought current and how is read back at a start and moved by every batch;
 * a copy current again after a failure is an event (src/duck/events.ts). Offline: a real Sync over a DuckDB file whose
 * ledger is seeded, stopped before its tables are set (its pass would attach a source there is none of), and the
 * stream's batches handed to it as the stream hands them (`applyStreamed`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore, MASON_SCHEMA } from "../src/duck/store.ts";
import { Sync, type AddedTable } from "../src/duck/sync.ts";
import { noCounts, type TableChanges } from "../src/duck/stream.ts";
import type { Source } from "../src/cli/preflight.ts";

const columns = [{ name: "id", type: "bigint", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null }];
const T: AddedTable = { source: "public.t", schema: "public", table: "t", key: ["id"], columns, foreignKeys: [], bytes: 0, rows: 10 };
// a source nothing listens on: never reached, the sync is stopped before anything would connect
const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;
const replication = { slot: "mason_x", publication: "mason_x", owned: true };

/** a batch of the stream for public.t: rows by id (a value: written whole; null: deleted), and a TRUNCATE first */
function batch(rows: Record<string, string | null>, truncated = false): Map<string, TableChanges> {
  const keys: TableChanges["keys"] = new Map();
  for (const [id, v] of Object.entries(rows)) keys.set(JSON.stringify([id]), { key: [id], change: v === null ? { kind: "delete" } : { kind: "row", values: [id, v] } });
  return new Map([["public.t", { columns: ["id", "v"], truncated, keys, counts: { ...noCounts(), inserts: Object.keys(rows).length } }]]);
}

interface Run {
  store: DuckStore; sync: Sync; events: Array<{ kind: string; table: string | null; message: string }>;
  st: () => Record<string, unknown>; apply: (b: Map<string, TableChanges>, lsn: bigint) => Promise<void>;
  /** the copy's rows: as the sync has them, as its ledger has them, as DuckDB counts them */
  rows: () => Promise<number[]>;
}

/** A sync over a file a run before this one left: public.t copied two hours ago (10 rows), polled one hour ago, the
 *  stream's last batch half an hour ago — and the stream failed since (the table's error). */
async function aRun(body: (r: Run) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-sync-facts-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "256MB" });
  try {
    const events: Run["events"] = [];
    const open = async (): Promise<Sync> => {
      const s = new Sync(store, source, "x", () => undefined, 5_000, "replication", replication, { onEvent: (e) => { events.push(e); } });
      await s.open();
      return s;
    };
    await (await open()).stop();
    const w = (sql: string) => store.writer.run(sql);
    await w("CREATE TABLE public.t (id BIGINT, v VARCHAR)");
    await w("INSERT INTO public.t SELECT i, 'v' || i FROM range(1, 11) r(i)");
    await w(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.t', 'copied', 10, 0, 3.5, now() - INTERVAL 2 HOUR, 'replication: the slot is in use', '${JSON.stringify(columns)}')`);
    await w(`INSERT INTO ${MASON_SCHEMA}.poll_state VALUES ('public.t', '100:100:', now() - INTERVAL 1 HOUR)`);
    await w(`INSERT INTO ${MASON_SCHEMA}.stream_state VALUES ('mason_x', '0/10', now() - INTERVAL 30 MINUTE)`);
    const sync = await open();
    await sync.stop();
    await sync.setTables([T]);
    const st = (): Record<string, unknown> => sync.state()[0] as unknown as Record<string, unknown>;
    const apply = (b: Map<string, TableChanges>, lsn: bigint): Promise<void> =>
      (sync as unknown as { applyStreamed: (b: Map<string, TableChanges>, lsn: bigint, at: Date) => Promise<void> }).applyStreamed(b, lsn, new Date());
    const one = async (sql: string): Promise<number> => Number((await store.writer.runAndReadAll(sql)).getRowsJS()[0]![0]);
    const rows = async (): Promise<number[]> => [Number(st().rows), await one(`SELECT "rows" FROM ${MASON_SCHEMA}.copy_state WHERE source = 'public.t'`), await one("SELECT count(*) FROM public.t")];
    await body({ store, sync, events, st, apply, rows });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a copy's rows are its rows after every stream batch, the one right after another too, kept in the ledger with the batch", async () => {
  await aRun(async ({ st, apply, rows }) => {
    // two inserts, an update of an existing row and a delete: 10 + 2 - 1
    await apply(batch({ 11: "new", 12: "new", 5: "changed", 1: null }), 0x20n);
    assert.deepEqual(await rows(), [11, 11, 11]);
    assert.equal(st().error, null, "a batch applied clears the stream's failure");
    // the next batch at once: counted too (it was counted at most every 5 s)
    await apply(batch({ 13: "new" }), 0x30n);
    assert.deepEqual(await rows(), [12, 12, 12], "a batch right after another is in the count");
    await apply(batch({ 13: null, 14: null }), 0x40n);
    assert.deepEqual(await rows(), [11, 11, 11], "a delete of a key the copy lacks removes nothing");
    await apply(batch({ 100: "after" }, true), 0x50n);
    assert.deepEqual(await rows(), [1, 1, 1], "a TRUNCATE, then a row");
  });
});

test("a copy's last sync is read back at a start and moved by every batch; current again after a failure is one event", async () => {
  await aRun(async ({ st, apply, events }) => {
    const synced = (): { at: string; seconds: number | null; by: string } | undefined => st().synced as never;
    // read back at the start: the stream's last batch, newer than the table's poll (how long it took is not kept)
    assert.equal(synced()?.by, "stream", JSON.stringify(st()));
    assert.ok(Math.abs(Date.parse(synced()!.at) - (Date.now() - 30 * 60_000)) < 60_000, synced()!.at);
    assert.equal(synced()!.seconds, null);
    const before = Date.now();
    await apply(batch({ 11: "new" }), 0x20n);
    assert.equal(synced()?.by, "stream");
    assert.ok(Date.parse(synced()!.at) >= before && synced()!.seconds !== null && synced()!.seconds! >= 0, JSON.stringify(synced()));
    assert.deepEqual(events.map((e) => [e.kind, e.table]), [["recovered", "public.t"]]);
    assert.match(events[0]!.message, /^current again \(it had failed: replication: the slot is in use\)$/);
    await apply(batch({ 12: "new" }), 0x30n);
    assert.equal(events.length, 1, "current again once, never at every batch");
  });
});

test("the changes a catch-up held, replayed after its poll, are written but are no position of the stream: no table's last sync, no stream_state", async () => {
  await aRun(async ({ store, sync, st, rows }) => {
    const s = sync as unknown as {
      behind: Map<string, { why: string }>; held: Map<string, TableChanges>; rebuilderLane: unknown; streamFailures: number;
      poll: (lane: unknown, tables: readonly AddedTable[]) => Promise<unknown[]>; catchUp: (t: AddedTable) => Promise<unknown>;
    };
    const applied = async (): Promise<number> => Number((await store.writer.runAndReadAll(`SELECT epoch_ms(applied_at) FROM ${MASON_SCHEMA}.stream_state`)).getRowsJS()[0]![0]);
    const before = { synced: JSON.stringify(st().synced), applied: await applied() };
    // public.t is behind (a copy just swapped in), its catch-up poll found nothing new (the source is never reached),
    // and the stream held two changes of it meanwhile
    s.behind.set("public.t", { why: "after its copy" });
    s.held.set("public.t", batch({ 11: "held", 1: null }).get("public.t")!);
    s.rebuilderLane = { conn: store.writer, inFlight: false };
    s.poll = async () => [{ source: "public.t" }];
    s.streamFailures = 3;
    await s.catchUp(T);
    assert.deepEqual(await rows(), [10, 10, 10], "the held changes are written, and counted");
    assert.equal(await one(store, "SELECT v FROM public.t WHERE id = 11"), "held");
    assert.equal(await applied(), before.applied, "stream_state.applied_at is the batches' that held them, never the replay's");
    assert.equal(JSON.stringify(st().synced), before.synced, "the replay is not the stream's last sync of the table");
    assert.equal(s.streamFailures, 3, "a replay is not the stream working again");
  });
});

async function one(store: DuckStore, sql: string): Promise<unknown> { return (await store.writer.runAndReadAll(sql)).getRowsJS()[0]![0]; }

test("a whole-sync failure over is said, once, as a recovered of no table: the publication and slot ready, the database attached, the stream applying", async () => {
  await aRun(async ({ sync, events, apply }) => {
    const s = sync as unknown as Record<string, unknown> & { pass: () => Promise<void> };
    let prepare: Error | null = new Error("the slot could not be read: connection refused");
    let attach: Error | null = null;
    s.prepareReplication = async () => { if (prepare !== null) throw prepare; };
    s.attach = async () => { if (attach !== null) throw attach; };
    s.work = async () => undefined;
    s.detach = async () => undefined;
    s.startStream = () => undefined;
    const kinds = (): string[] => events.filter((e) => e.table === null).map((e) => `${e.kind}: ${e.message}`);
    await assert.rejects(s.pass());
    prepare = null;
    await s.pass();
    await s.pass();
    attach = new Error("connection refused");
    await assert.rejects(s.pass());
    attach = null;
    await s.pass();
    await s.pass();
    assert.deepEqual(kinds(), [
      "stream_failed: replication: the slot could not be read: connection refused",
      "recovered: the publication and the slot are ready again (it had failed: replication: the slot could not be read: connection refused)",
      "source_unreachable: could not attach the database: connection refused",
      "recovered: the database is attached again (it had failed: connection refused)",
    ], "each over once, at the pass that did what had failed");
    // the stream stopped (its own failure: startStream's, which needs a source): over at the next batch it applies
    (s.wholeFailure as { stream: string | null }).stream = "replication: the source closed the connection";
    await apply(batch({ 11: "new" }), 0x20n);
    await apply(batch({ 12: "new" }), 0x30n);
    assert.deepEqual(kinds().slice(4), ["recovered: the stream applies changes again (it had failed: replication: the source closed the connection)"]);
  });
});

test("a table the named publication does not carry is never credited with the stream's last time: its last sync is its poll's", async () => {
  await aRun(async ({ sync, st }) => {
    const s = sync as unknown as { unpublished: Map<string, string>; readSynced: (only?: ReadonlySet<string>) => Promise<void> };
    assert.equal((st().synced as { by: string }).by, "stream", "streamed: the stream's last batch, newer than its poll");
    // the pass found the publication does not carry it: read again, that table alone
    s.unpublished.set("public.t", "publication mason_x does not carry public.t");
    await s.readSynced(new Set(["public.t"]));
    const synced = st().synced as { at: string; by: string };
    assert.equal(synced.by, "poll", JSON.stringify(synced));
    assert.ok(Math.abs(Date.parse(synced.at) - (Date.now() - 60 * 60_000)) < 60_000, synced.at);
  });
});

test("the slot's WAL is read with the database's position, at most every 30 s, and a read that failed is its error, never a 0", async () => {
  // imported when the test runs: at a commit without them this file still loads, and the test fails by name
  const m = await import("../src/duck/sync.ts") as unknown as { slotWalOf?: (s: unknown, name: string, at: number) => unknown; SLOT_READ_MS?: number };
  assert.equal(typeof m.slotWalOf, "function", "src/duck/sync.ts slotWalOf");
  const at = Date.parse("2026-10-28T09:00:00.000Z");
  const row = { exists: true, active: true, activePid: "7", plugin: "pgoutput", database: "x", confirmedFlush: "0/10", walStatus: "reserved", retainedBytes: 123_456n, safeBytes: 4_096n };
  assert.deepEqual(m.slotWalOf!(row, "mason_x", at), { walHeldBytes: 123_456, walStatus: "reserved", safeWalSizeBytes: 4_096, at: "2026-10-28T09:00:00.000Z" });
  assert.deepEqual(m.slotWalOf!({ ...row, safeBytes: null }, "mason_x", at), { walHeldBytes: 123_456, walStatus: "reserved", safeWalSizeBytes: null, at: "2026-10-28T09:00:00.000Z" },
    "no cap: max_slot_wal_keep_size unset");
  assert.deepEqual(m.slotWalOf!({ ...row, walStatus: "lost", retainedBytes: null, safeBytes: null }, "mason_x", at), { walHeldBytes: 0, walStatus: "lost", safeWalSizeBytes: null, at: "2026-10-28T09:00:00.000Z" },
    "a lost slot's WAL was freed: it holds none");
  assert.match(String((m.slotWalOf!({ ...row, retainedBytes: null }, "mason_x", at) as { error?: string }).error), /no restart position yet/, "unknown is said, never a 0");
  assert.match(String((m.slotWalOf!({ ...row, exists: false }, "mason_x", at) as { error?: string }).error), /^replication slot mason_x does not exist on the database/);
  await aRun(async ({ sync }) => {
    const s = sync as unknown as { slotWal: { wal: unknown; at: number } | null };
    const status = async (): Promise<unknown> => (await sync.streamStatus())!.slotWal;
    // the source is not there: the position and the slot are each said as their error
    assert.match(String((await status() as { error: string }).error), /^the database could not be reached: /);
    // read 10 s ago: not again (the position is read again, at most every 5 s; the slot is not due)
    const recent = { wal: { walHeldBytes: 1, walStatus: "reserved", safeWalSizeBytes: null, at: new Date(Date.now() - 10_000).toISOString() }, at: Date.now() - 10_000 };
    s.slotWal = recent;
    (sync as unknown as { dbPosition: unknown }).dbPosition = null;
    assert.deepEqual(await status(), recent.wal, "within SLOT_READ_MS the slot is not read again");
    s.slotWal = { ...recent, at: Date.now() - m.SLOT_READ_MS! - 1 };
    (sync as unknown as { dbPosition: unknown }).dbPosition = null;
    assert.match(String((await status() as { error: string }).error), /^the database could not be reached: /, "past it, read again");
  });
});

test("the disk under the copy: free where its file is, by the sync's own measure, and what the copies running are projected to add, as their chunks' check computed it", async () => {
  await aRun(async ({ store, sync }) => {
    const s = sync as unknown as { diskStatus?: () => unknown; diskFree: (dir: string) => number; copyLive: Map<string, Record<string, unknown>>;
      diskShort: (t: AddedTable, p: unknown, disk: unknown, live: Record<string, unknown>) => string | null };
    assert.equal(typeof s.diskStatus, "function", "src/duck/sync.ts Sync.diskStatus");
    const dir = path.dirname(store.file);
    s.diskFree = () => 80 * 2 ** 30;
    assert.deepEqual(s.diskStatus!(), { path: dir, freeBytes: 80 * 2 ** 30, projectedBytes: null }, "no copy running: nothing projected");
    // a copy whose chunks' check projected what its pages left add (copyDiskProjection): kept on its live state, said
    const live: Record<string, unknown> = { diskNeeded: null };
    s.copyLive.set("public.t", live);
    const short = s.diskShort(T, { pages: 100, done: [{ first: 0, end: 50 }] }, { bytesAtStart: 0, doneAtStart: [] }, live);
    assert.equal(short, null, "80 GiB free: the copy goes on");
    assert.ok(typeof live.diskNeeded === "number" && live.diskNeeded > 0, `what its 50 pages left would add: ${live.diskNeeded}`);
    s.copyLive.set("public.u", { diskNeeded: 1_000 });
    s.copyLive.set("public.v", { diskNeeded: null });
    assert.equal((s.diskStatus!() as { projectedBytes: number }).projectedBytes, Math.round((live.diskNeeded as number) + 1_000), "summed over the copies that can say");
    // a free space that cannot be read is its error, never a 0
    s.diskFree = () => { throw new Error("ENOENT: no such file or directory"); };
    const failed = s.diskStatus!() as { freeBytes: unknown; error?: string };
    assert.equal(failed.freeBytes, null);
    assert.match(String(failed.error), /^the free space where the copy is could not be read: ENOENT/);
    s.copyLive.clear();
  });
});

test("a stream's failure is over when the stream next applies a batch WITH A POSITION — never at a pass's publication check, nor at a piece of a large transaction", async () => {
  await aRun(async ({ sync, events, st }) => {
    const s = sync as unknown as { settlePrepared?: (t: readonly AddedTable[]) => Promise<void>; wholeFailure: { stream: string | null };
      applyStreamed: (b: Map<string, TableChanges>, lsn: bigint | null, at: Date) => Promise<void> };
    assert.equal(typeof s.settlePrepared, "function", "src/duck/sync.ts Sync.settlePrepared: what a pass's publication check settles");
    // the stream failed (its error on the table it kept current, as startStream's failure records it)
    s.wholeFailure.stream = "replication: the slot is in use";
    const said = (): string[] => events.map((e) => `${e.kind} ${e.table ?? "-"}: ${e.message}`);
    // a pass: the publication and slot are as they should be — that says nothing of the copy
    await s.settlePrepared!([T]);
    assert.equal(st().error, "replication: the slot is in use", "the publication check does not clear the stream's failure");
    assert.deepEqual(said(), [], "and says no recovery");
    // a piece of a large transaction: written, but no position yet
    await s.applyStreamed(batch({ 11: "piece" }), null, new Date());
    assert.equal(st().error, "replication: the slot is in use", "a piece without a position does not");
    assert.deepEqual(said(), []);
    // a batch with a position, of another table only (the database committed): every streamed table is current as of it
    const other: Map<string, TableChanges> = new Map([["public.other", batch({ 1: "x" }).get("public.t")!]]);
    await s.applyStreamed(other, 0x40n, new Date());
    assert.equal(st().error, null, "current as of the batch's position");
    assert.deepEqual(said(), [
      "recovered -: the stream applies changes again (it had failed: replication: the slot is in use)",
      "recovered public.t: current again (it had failed: replication: the slot is in use)",
    ]);
  });
});

test("a named publication's gap is its own error and its own recovery: set by the pass that finds it, cleared by the pass that finds the table carried again", async () => {
  await aRun(async ({ sync, events, st }) => {
    const s = sync as unknown as { settlePrepared: (t: readonly AddedTable[]) => Promise<void>; unpublished: Map<string, string>; wholeFailure: { prepare: string | null };
      states: Map<string, Record<string, unknown>> };
    // the table's last error was the stream's (from the run before): not the pass's to clear
    await s.settlePrepared([T]);
    assert.equal(st().error, "replication: the slot is in use");
    s.unpublished.set("public.t", "publication app_pub does not carry public.t: ALTER PUBLICATION app_pub ADD TABLE public.t");
    await s.settlePrepared([T]);
    assert.equal(st().error, "replication: publication app_pub does not carry public.t: ALTER PUBLICATION app_pub ADD TABLE public.t");
    assert.deepEqual(events.map((e) => e.kind), ["stream_failed"]);
    s.unpublished.clear();
    await s.settlePrepared([T]);
    assert.equal(st().error, null, "carried again: its gap's error cleared by the pass that found it");
    assert.deepEqual(events.map((e) => `${e.kind} ${e.table}`), ["stream_failed public.t", "recovered public.t"]);
    // a failure to prepare: a table never copied has it cleared by the pass that prepares (its copy is next); a copied
    // one keeps it until the stream applies a batch with a position
    s.wholeFailure.prepare = "replication: the slot could not be read: connection refused";
    s.states.set("public.t", { ...s.states.get("public.t")!, phase: "failed", error: s.wholeFailure.prepare });
    await s.settlePrepared([T]);
    assert.equal(st().error, null, "never copied: cleared");
    s.states.set("public.t", { ...s.states.get("public.t")!, phase: "copied", error: s.wholeFailure.prepare });
    await s.settlePrepared([T]);
    assert.equal(st().error, s.wholeFailure.prepare, "copied: current only once the stream says so");
  });
});
