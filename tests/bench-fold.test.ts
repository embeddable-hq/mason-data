/**
 * scripts/bench-fold.ts (issue 124 stage 5): its pure parts, and its fold driven in process over the REAL store, sync,
 * listener and generated tables at a small size (20,000 rows of its own generator), held after every batch to the
 * definitions run whole, so the 2 h measurement cannot time a fold that answers wrong or a statement that is refused.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { SESSION_VARIABLE } from "../src/duck/functions.ts";
import {
  Batches, CLEANUP_MS, Fold, iso, buildGenerated, containerArgs, foldByKey, openWorld, planPhases, renderReport, statementSet, targetBytes, verdictOf, volumeTooBig, withCleanup,
  type Change, type ContainerSpec, type DockerResult, type EventRow, type FoldOptions, type Names, type Result, type World,
} from "../scripts/bench-fold.ts";

const GIB = 1024 ** 3;
// a mutation of the fold, for proving these tests fail without each step (the PR body records each run)
const mutate = process.env.BENCH_FOLD_MUTATE as FoldOptions["mutate"] | undefined;

describe("the fold over the real engine", () => {
  let w: World, fold: Fold, dir: string;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-bench-fold-"));
    w = await openWorld({ dir, memoryLimit: "256MB", rows: 20_000, host: "127.0.0.1", port: 0, log: () => undefined });
    await buildGenerated(w, 60_000);
    fold = await Fold.open(w);
  });
  after(async () => { await w?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const q = async (sql: string): Promise<unknown[][]> => (await fold.conn.runAndReadAll(sql)).getRowsJS();
  const isoOf = (v: unknown): string => iso(Number(v));
  const row = async (id: number): Promise<EventRow> => {
    const [r] = await q(`SELECT id, tenant_id, request_key, kind, status, code, epoch_ms(started_at), epoch_ms(finished_at), payload::VARCHAR FROM public.events WHERE id = ${id}`);
    assert.ok(r !== undefined, `no event ${id}`);
    return { id, tenant_id: Number(r[1]), request_key: r[2] === null ? null : Number(r[2]), kind: String(r[3]), status: r[4] as string | null, code: r[5] === null ? null : Number(r[5]),
      started_at: isoOf(r[6]), finished_at: r[7] === null ? null : isoOf(r[7]), payload: r[8] as string | null };
  };
  const ins = (id: number, tenant: number, key: number | null, status: string | null, code: number | null, started: string, finished: string | null, payload = "{}"): Change =>
    ({ op: "upsert", row: { id, tenant_id: tenant, request_key: key, kind: "query", status, code, started_at: started, finished_at: finished, payload } });
  const stored = async (tenant: number, key: number): Promise<unknown[] | undefined> =>
    (await q(`SELECT epoch_ms(first_at), epoch_ms(last_at), duration_ms, status, code FROM public.requests WHERE tenant_id = ${tenant} AND key = ${key}`))[0]?.map((v) => typeof v === "bigint" ? Number(v) : v);
  /** one batch, then everything the fold owes: the stored tables equal their definitions run whole, the bounded
   *  recompute equal to the unbounded, and the base written by key */
  const apply = async (changes: Change[]): Promise<void> => {
    const t = await fold.batch(changes, { fold: true, compareUnbounded: true, ...(mutate === undefined ? {} : { mutate }) });
    const gate = await fold.gate();
    assert.deepEqual(gate.failures, []);
    if (changes.length > 0) assert.equal(t.equal, true, "the bounded recompute's rows differ from the unbounded one's");
    const [[n, distinct]] = await q("SELECT count(*), count(DISTINCT id) FROM public.events") as [[bigint, bigint]];
    assert.equal(n, distinct);
    for (const [id, final] of foldByKey(changes)) {
      const [[c]] = await q(`SELECT count(*) FROM public.events WHERE id = ${id}`) as [[bigint]];
      if (final === null) { assert.equal(Number(c), 0, `event ${id} was deleted`); continue; }
      assert.equal(Number(c), 1, `event ${id} once`);
      const got = await row(id);
      assert.deepEqual({ ...got, payload: null }, { ...final, payload: null });
    }
  };

  test("fold: a new group", async () => {
    await apply([ins(900001, 1, 777001, "ok", 200, "2026-03-30 10:00:00+00", "2026-03-30 10:00:02+00", '{"source":"web"}')]);
    assert.deepEqual((await stored(1, 777001))?.slice(2), [2000, "ok", 200]);
  });
  test("fold: a retry into an existing group", async () => {
    await apply([ins(900002, 1, 777001, "failed", 500, "2026-03-30 10:00:05+00", "2026-03-30 10:00:06+00")]);
    assert.deepEqual((await stored(1, 777001))?.slice(2), [6000, "failed", 500]);
  });
  test("fold: a finish-update, the wide column unchanged", async () => {
    const [[id]] = await q("SELECT e.id FROM public.events e WHERE e.finished_at IS NULL AND e.kind = 'query' AND (SELECT count(*) FROM public.events x WHERE x.tenant_id = e.tenant_id AND coalesce(x.request_key, x.id) = coalesce(e.request_key, e.id)) = 1 ORDER BY e.started_at DESC LIMIT 1") as [[bigint]];
    const r = await row(Number(id));
    assert.equal((await stored(r.tenant_id, r.request_key ?? r.id))?.[2], null);
    await apply([{ op: "upsert", row: { ...r, finished_at: iso(Date.parse(r.started_at.replace(" ", "T").replace("+00", "Z")) + 3000), status: "ok", code: 200 } }]);
    assert.equal((await stored(r.tenant_id, r.request_key ?? r.id))?.[2], 3000);
  });
  test("fold: a group change recomputes both groups", async () => {
    await apply([{ op: "upsert", row: { ...await row(900002), request_key: 777002 } }]);
    assert.deepEqual((await stored(1, 777001))?.slice(2), [2000, "ok", 200]);
    assert.deepEqual((await stored(1, 777002))?.slice(2), [1000, "failed", 500]);
  });
  test("fold: a tenant change moves the group and both tenants' days", async () => {
    await apply([{ op: "upsert", row: { ...await row(900001), tenant_id: 2 } }]);
    assert.equal(await stored(1, 777001), undefined);
    assert.ok(await stored(2, 777001) !== undefined);
  });
  test("fold: leaving the WHERE, the group's only row", async () => {
    const [[id]] = await q("SELECT e.id FROM public.events e WHERE e.kind = 'query' AND (SELECT count(*) FROM public.events x WHERE x.tenant_id = e.tenant_id AND coalesce(x.request_key, x.id) = coalesce(e.request_key, e.id)) = 1 " +
      "AND (SELECT count(*) FROM public.events x WHERE x.kind = 'query' AND x.tenant_id = e.tenant_id AND date_trunc('day', timezone('UTC', x.started_at)) = date_trunc('day', timezone('UTC', e.started_at))) = 1 ORDER BY e.id LIMIT 1") as [[bigint]];
    const r = await row(Number(id));
    assert.ok(await stored(r.tenant_id, r.request_key ?? r.id) !== undefined);
    await apply([{ op: "upsert", row: { ...r, kind: "load" } }]);
    assert.equal(await stored(r.tenant_id, r.request_key ?? r.id), undefined);
  });
  test("fold: entering the WHERE", async () => {
    const [[id]] = await q("SELECT e.id FROM public.events e WHERE e.kind = 'load' AND NOT EXISTS (SELECT 1 FROM public.events x WHERE x.kind = 'query' AND x.tenant_id = e.tenant_id AND coalesce(x.request_key, x.id) = coalesce(e.request_key, e.id)) ORDER BY e.id LIMIT 1") as [[bigint]];
    const r = await row(Number(id));
    await apply([{ op: "upsert", row: { ...r, kind: "query" } }]);
    assert.ok(await stored(r.tenant_id, r.request_key ?? r.id) !== undefined);
  });
  test("fold: deleting the extremes", async () => {
    await apply([ins(900010, 6, 777010, "ok", 200, "2026-03-30 10:00:00+00", "2026-03-30 10:00:01+00"), ins(900011, 6, 777010, "failed", 500, "2026-03-30 10:00:10+00", "2026-03-30 10:00:40+00"),
      ins(900012, 6, 777010, "timeout", 504, "2026-03-30 10:00:05+00", "2026-03-30 10:00:06+00")]);
    await apply([{ op: "delete", id: 900010 }, { op: "delete", id: 900011 }]);
    const s = await stored(6, 777010);
    assert.deepEqual(s, [Date.parse("2026-03-30T10:00:05Z"), Date.parse("2026-03-30T10:00:06Z"), 1000, "timeout", 504]);
  });
  test("fold: a NULL request_key appears, then vanishes", async () => {
    await apply([ins(900003, 3, null, "ok", 200, "2026-03-30 11:00:00+00", "2026-03-30 11:00:01+00")]);
    assert.ok(await stored(3, 900003) !== undefined);
    await apply([{ op: "delete", id: 900003 }]);
    assert.equal(await stored(3, 900003), undefined);
  });
  test("fold: ties on started_at are decided by id", async () => {
    await apply([ins(900004, 4, 777004, "ok", 200, "2026-03-30 12:00:00+00", "2026-03-30 12:00:01+00"), ins(900005, 4, 777004, "timeout", 504, "2026-03-30 12:00:00+00", "2026-03-30 12:00:09+00")]);
    assert.deepEqual((await stored(4, 777004))?.slice(3), ["timeout", 504]);
  });
  test("fold: NULL values", async () => {
    await apply([ins(900006, 5, 777006, null, null, "2026-03-30 13:00:00+00", null)]);
    assert.deepEqual((await stored(5, 777006))?.slice(1), [null, null, null, null]);
  });
  test("fold: a late row to an older day", async () => {
    const [[key]] = await q("SELECT request_key FROM public.events WHERE kind = 'query' AND request_key IS NOT NULL AND tenant_id = 1 GROUP BY request_key " +
      "HAVING min(started_at) >= TIMESTAMPTZ '2026-03-20 00:00:00+00' AND min(started_at) < TIMESTAMPTZ '2026-03-21 00:00:00+00' ORDER BY 1 LIMIT 1") as [[bigint]];
    await apply([ins(900007, 1, Number(key), "ok", 200, "2026-03-19 23:59:00+00", "2026-03-20 00:00:01+00")]);
    assert.equal((await stored(1, Number(key)))?.[0], Date.parse("2026-03-19T23:59:00Z"));
  });
  test("fold: the same key twice in one batch", async () => {
    await apply([ins(900009, 7, 777009, "ok", 200, "2026-03-30 14:00:00+00", "2026-03-30 14:00:01+00")]);
    await apply([ins(900008, 7, 777008, null, null, "2026-03-30 14:10:00+00", null), ins(900008, 7, 777008, "ok", 200, "2026-03-30 14:10:00+00", "2026-03-30 14:10:02+00"),
      { op: "delete", id: 900009 }, ins(900009, 7, 777009, "failed", 500, "2026-03-30 14:00:00+00", "2026-03-30 14:00:03+00")]);
    assert.deepEqual((await stored(7, 777008))?.slice(2), [2000, "ok", 200]);
    assert.deepEqual((await stored(7, 777009))?.slice(2), [3000, "failed", 500]);
  });
  test("fold: an empty batch writes nothing and costs nothing", async () => {
    const t = await fold.batch([], { fold: true });
    assert.deepEqual(t, { total: 0, base: 0, rows: 0 });
  });
  test("fold: 1,000 rows of the script's own mix", async () => {
    const gen = new Batches(fold.conn, 7);
    await gen.refill();
    const changes = gen.next(1000);
    for (const op of ["delete"]) assert.ok(changes.some((c) => c.op === op), `the mix has a ${op}`);
    await apply(changes);
  });
  test("fold: the base write alone, today's writer", async () => {
    const gen = new Batches(fold.conn, 9);
    await gen.refill();
    const changes = gen.next(60);
    const t = await fold.batch(changes, { fold: false });
    assert.ok(t.base > 0 && t.s1 === undefined);
    const [[n, distinct]] = await q("SELECT count(*), count(DISTINCT id) FROM public.events") as [[bigint, bigint]];
    assert.equal(n, distinct);
  });

  test("statements: S1-S7 in each variant answer through the listener", async () => {
    const [[top], [median]] = [(await q("SELECT tenant_id FROM public.events GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1"))[0]!, (await q("SELECT tenant_id FROM public.events GROUP BY 1 ORDER BY count(*), 1"))[0]!];
    const c = new pg.Client({ host: "127.0.0.1", port: w.api.port, database: "app", user: "mason", password: w.token(600) });
    await c.connect();
    try {
      const all = [...statementSet({ top: Number(top), median: Number(median) }, "7d"), ...statementSet({ top: Number(top), median: Number(median) }, "30d")];
      assert.equal(all.length, 28);
      for (const s of all) {
        const r = await c.query(s.sql).catch((e: Error) => { throw new Error(`${s.name} was refused: ${e.message}\n${s.sql}`); });
        if (s.name.includes("top")) assert.ok(r.rows.length > 0, `${s.name} answered no rows`);
      }
    } finally { await c.end(); }
  });

  test("session: the fold's connection is set up by SessionSetup, and a hand-made one stores wrong rows", async () => {
    const [[v]] = await q(`SELECT getvariable('${SESSION_VARIABLE}')`) as [[string | null]];
    assert.equal(v, "bench_fold");
    // the same recompute on a connection nobody set up: Mason's functions answer NULL there, which the gate catches
    // set up by hand: the zone, the path and the null order, but not the session variable only SessionSetup sets
    const hand = await w.store.instance.connect();
    for (const sql of ["SET TimeZone = 'UTC'", "SET search_path = 'public'", "SET default_null_order = 'nulls_last_on_asc_first_on_desc'"]) await hand.run(sql);
    const [[none]] = (await hand.runAndReadAll(`SELECT getvariable('${SESSION_VARIABLE}')`)).getRowsJS() as [[string | null]];
    assert.equal(none, null);
    assert.match(fold.plans.requestsWhole.plan.sql.text, /mason_/, "the planned recompute calls a Mason function");
    await hand.run("DELETE FROM public.requests");
    let failed: unknown = null;
    try { await hand.run(`INSERT INTO public.requests SELECT * FROM (${fold.plans.requestsWhole.plan.sql.text})`); }
    catch (e) { failed = e; }   // an error here is as good as wrong rows: either way not the definition's, which the gate says
    const gate = await fold.gate();
    assert.equal(gate.ok, false, `a hand-made connection's recompute passed the gate (its insert ${failed === null ? "ran" : "failed"})`);
    // put the table back as the definition has it, on the set-up connection
    await fold.conn.run("DELETE FROM public.requests");
    await fold.conn.run(`INSERT INTO public.requests SELECT * FROM (${fold.plans.requestsWhole.plan.sql.text})`);
    hand.closeSync();
  });
});

const spec = (o: Partial<ContainerSpec> = {}): ContainerSpec => ({ container: "mason-bench-fold-ab12", image: "mason-bench-fold-ab12:run", volume: "mason-bench-fold-ab12", memoryBytes: 4 * GIB, cpus: 4, device: "/dev/vdb",
  script: "/repo/scripts/bench-fold.ts", env: { MASON_SPILL_LIMIT: "6GB" }, args: [], ...o });
const after_ = (args: string[], flag: string): string[] => args.flatMap((a, i) => a === flag ? [args[i + 1]!] : []);

test("sizing: 5x memory capped at 30 GB, refused under 3x, stopped past 38 GB", () => {
  assert.equal(targetBytes(4 * GIB, 30e9), 20 * GIB);
  assert.equal(targetBytes(8 * GIB, 30e9), 30e9);
  assert.throws(() => targetBytes(16 * GIB, 30e9), /under the 3x/);
  assert.equal(volumeTooBig(38e9), false);
  assert.equal(volumeTooBig(38e9 + 1), true);
});

test("docker: memory without swap, 4 CPUs, a named volume, the throttle, the script read-only, loopback ports", () => {
  const a = containerArgs(spec());
  assert.deepEqual(after_(a, "--memory"), ["4096m"]);
  assert.deepEqual(after_(a, "--memory-swap"), after_(a, "--memory"));
  assert.deepEqual(after_(a, "--cpus"), ["4"]);
  const mounts = after_(a, "-v");
  const data = mounts.filter((m) => m.split(":")[1] === "/data");
  assert.equal(data.length, 1);
  assert.match(data[0]!, /^mason-bench-fold-[0-9a-f]+:\/data$/, "the data is a NAMED volume, never a host path");
  assert.ok(mounts.includes("/repo/scripts/bench-fold.ts:/app/scripts/bench-fold.ts:ro"));
  assert.deepEqual(after_(a, "--device-read-bps"), ["/dev/vdb:125mb"]);
  assert.deepEqual(after_(a, "--device-write-bps"), ["/dev/vdb:125mb"]);
  assert.deepEqual(after_(a, "--device-read-iops"), ["/dev/vdb:3000"]);
  assert.deepEqual(after_(a, "--device-write-iops"), ["/dev/vdb:3000"]);
  assert.ok(after_(a, "-p").every((p) => p.startsWith("127.0.0.1::")) && after_(a, "-p").length === 2);
  assert.throws(() => containerArgs(spec({ volume: "/Users/someone/data" })), /named docker volume/);
  assert.equal(after_(containerArgs(spec({ device: null })), "--device-read-bps").length, 0);
});

test("deadline: a phase that cannot finish with 5 min kept for cleanup is dropped, said", () => {
  const p = planPhases(110 * 60_000, [{ name: "a", estimateMs: 40 * 60_000 }, { name: "b", estimateMs: 40 * 60_000 }, { name: "c", estimateMs: 40 * 60_000 }, { name: "d", estimateMs: 20 * 60_000 }]);
  assert.deepEqual(p.planned, ["a", "b", "d"]);
  assert.equal(p.dropped[0]!.phase, "c");
  assert.match(p.dropped[0]!.why, /110 min deadline with 5 min kept for cleanup/);
  assert.ok(p.totalMs + CLEANUP_MS <= 110 * 60_000);
  assert.deepEqual(planPhases(110 * 60_000, [{ name: "late", estimateMs: 10 * 60_000 }], CLEANUP_MS, 100 * 60_000).dropped.map((d) => d.phase), ["late"]);
});

describe("cleanup", () => {
  const names: Names = { container: "mason-bench-fold-cafe", volume: "mason-bench-fold-cafe", image: "mason-bench-fold-cafe:run" };
  const fake = (alive: ReadonlySet<string> = new Set()): { calls: string[][]; docker: (a: string[]) => Promise<DockerResult> } => {
    const calls: string[][] = [];
    return { calls, docker: async (a) => { calls.push(a); return { code: a.includes("inspect") ? (alive.has(a[a.length - 1]!) ? 0 : 1) : 0, stdout: "", stderr: "" }; } };
  };
  const removedExactly = (calls: string[][]): void => {
    assert.deepEqual(calls, [
      ["rm", "-f", names.container], ["inspect", "--type", "container", names.container],
      ["volume", "rm", "-f", names.volume], ["volume", "inspect", names.volume],
      ["rmi", "-f", names.image], ["image", "inspect", names.image],
    ]);
  };
  test("cleanup: on a normal exit", async () => {
    const f = fake();
    const r = await withCleanup(f.docker, names, async () => 7, { deadlineMs: 60_000, signals: new EventEmitter() });
    assert.equal(r.value, 7); assert.equal(r.cleanup.ok, true); removedExactly(f.calls);
  });
  test("cleanup: when a phase throws", async () => {
    const f = fake();
    const r = await withCleanup(f.docker, names, async () => { throw new Error("phase 3 failed"); }, { deadlineMs: 60_000, signals: new EventEmitter() });
    assert.equal(r.error, "phase 3 failed"); removedExactly(f.calls);
  });
  test("cleanup: at the deadline", async () => {
    const f = fake();
    const r = await withCleanup(f.docker, names, () => new Promise<never>(() => undefined), { deadlineMs: 30, signals: new EventEmitter() });
    assert.match(r.error ?? "", /deadline/); removedExactly(f.calls);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) test(`cleanup: on ${signal}`, async () => {
    const f = fake(), signals = new EventEmitter();
    const running = withCleanup(f.docker, names, () => new Promise<never>(() => undefined), { deadlineMs: 60_000, signals });
    setTimeout(() => signals.emit(signal), 10);
    const r = await running;
    assert.match(r.error ?? "", new RegExp(signal)); removedExactly(f.calls);
  });
  test("cleanup: an inspect that still finds it is 'not removed', never done", async () => {
    const f = fake(new Set([names.volume]));
    const r = await withCleanup(f.docker, names, async () => 1, { deadlineMs: 60_000, signals: new EventEmitter() });
    assert.equal(r.cleanup.volume, "not removed"); assert.equal(r.cleanup.ok, false);
    const text = renderReport({ ...result(), cleanup: r.cleanup });
    assert.match(text, /volume not removed/); assert.match(text, /CLEANUP NOT VERIFIED/);
  });
});

function result(): Result {
  const phase = { seconds: 12.5, io: { readBytes: 3 * GIB, writeBytes: 1 * GIB }, memory: { fileBytes: 2 * GIB, anonBytes: GIB, peakBytes: 4 * GIB }, cpu: { throttledUsec: 2000, nrThrottled: 3 }, volumeBytes: 21 * GIB, spillBytes: 0 };
  return { smoke: false, startedAt: "2026-11-02T00:00:00Z", environment: { memoryBytes: 4 * GIB, cpus: 4, storeMemoryLimitBytes: 2 * GIB, throttle: "/dev/vdb throttled", coldReadBytesPerSecond: 125e6 },
    sizes: { rows: 27_300_000, fileBytes: 20 * GIB, keyColumnBytes: 1.2 * GIB, payloadBytes: 18 * GIB, requestsRows: 15e6, dailyRows: 40_000, requestsBytes: 0.5 * GIB, dailyBytes: 0.01 * GIB },
    phases: { "0 generate": phase, "1 rerun": phase }, dropped: [], errors: [],
    measures: { t1: { p95At6Ms: 120, p95At60Ms: 900 }, t2: { addedP95Ms: 400 }, t3: { aloneP95Ms: 1000, togetherP95Ms: 1100 }, t4: { rerunSeconds: 40 }, gate: { ok: true, failures: [] } } };
}
test("report: T1-T3 passed and T4 at 40 s says live buys little; a failed gate is INVALID with no verdict", () => {
  const ok = renderReport(result());
  assert.match(ok, /live buys little at this size/);
  assert.match(ok, /do not argue against stages 6-11/);
  assert.match(ok, /27\.30 M rows/); assert.match(ok, /20\.00 GiB/);
  assert.match(ok, /\| 0 generate \| 12\.50 s \| 3\.00 GiB \|/, "each phase's disk bytes read");
  const v = verdictOf({ ...result().measures, t3: { aloneP95Ms: 1000, togetherP95Ms: 1300 } });
  assert.equal(v.against, true); assert.match(v.text, /ARGUE AGAINST.*T3/);
  const bad = renderReport({ ...result(), measures: { ...result().measures, gate: { ok: false, failures: ["public.requests: 3 stored rows not in its definition"] } } });
  assert.match(bad, /INVALID/);
  assert.doesNotMatch(bad, /argue|live buys little|\| T1 \|/);
});
