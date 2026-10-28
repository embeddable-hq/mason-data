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
