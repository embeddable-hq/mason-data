/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: chains (issue 124 stage
 * 2a) and PR 163's review round. Each test runs its own world (tests/duck-generated-world.ts). What Postgres answers
 * from the same SQL is tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type pg from "pg";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import { BUILD_BOUND_MS, built, COUNTS, refusedAt, served, withWorld } from "./duck-generated-world.ts";
import { scheduled } from "./duck-generated-ledger.ts";

after(() => stopParser());

// ------------------------------------------------------------------------------------------- chains (issue 124 stage 2a)

const ask = async (w: { client(): Promise<pg.Client> }, sql: string): Promise<unknown[]> => { const c = await w.client(); try { return (await c.query({ text: sql, rowMode: "array" })).rows; } finally { await c.end(); } };

test("a chain of three is built parents first, each over what its parent holds", async () => {
  await withWorld({ counts: COUNTS, totals: scheduled("SELECT count(*) AS tenants, max(requests) AS most FROM counts"), top: scheduled("SELECT tenants * 10 AS t, most FROM totals") }, async (w) => {
    await w.until(served(w.logged), "public.top");
    const order = w.logged.filter((l) => l.startsWith("generated ")).map((l) => /^generated (\S+):/.exec(l)![1]);
    assert.deepEqual(order, ["public.counts", "public.totals", "public.top"]);
    assert.deepEqual(await ask(w, "SELECT t, most FROM top"), [["20", "2"]]);
  });
});

test("a child never reads the old parent: a base's change builds the chain at one snapshot, even when the child's run comes first", async () => {
  await withWorld({ counts: COUNTS, doubled: scheduled("SELECT tenant_id, requests * 2 AS doubled FROM counts", "tenant_id") }, async (w) => {
    await w.until(built, "public.doubled");
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 3, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL), (8, 3, 'load', 'ok', '8', NULL, NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    // the child's run, asked first, is its dirty parent's: the parent is built, then the child over it
    await w.sync.generated.run("public.doubled");
    const parent = await ask(w, "SELECT tenant_id, requests * 2 FROM counts ORDER BY 1"), child = await ask(w, "SELECT tenant_id, doubled FROM doubled ORDER BY 1");
    assert.deepEqual(child, parent);
    assert.deepEqual(child, [[1, "4"], [2, "4"], [3, "4"]]);
    assert.equal(w.status("public.counts").behindSeconds, 0);
    const ledger = await w.rows(`SELECT count(DISTINCT snapshot_at) FROM ${MASON_SCHEMA}.generated_tables WHERE name IN ('public.counts', 'public.doubled')`);
    assert.deepEqual(ledger, [[1n]], "one snapshot for the chain");
  });
});

test("a cycle and a table that reads itself are refused by name, with the tables of the cycle and the way out", async () => {
  await withWorld({ a: scheduled("SELECT * FROM b"), b: scheduled("SELECT * FROM public.a"), self: scheduled("SELECT x.* FROM self x"), c: scheduled("WITH b AS (SELECT 1 AS one) SELECT one FROM b") }, async (w) => {
    const a = await w.until((s) => s.state === "refused", "public.a");
    refusedAt(a.refusals, "sql", /^it reads itself through other generated tables: public\.a -> public\.b -> public\.a$/);
    assert.match(a.refusals[0]!.text, /read the tables the cycle is generated from instead/);
    refusedAt((await w.until((s) => s.state === "refused", "public.b")).refusals, "sql", /public\.b -> public\.a -> public\.b/);
    refusedAt((await w.until((s) => s.state === "refused", "public.self")).refusals, "sql", /^it reads public\.self, itself$/);
    assert.ok(w.logged.some((l) => l.includes("public.a -> public.b -> public.a")), "said in the log");
    await w.until(built, "public.c");
  });
});

test("a parent whose run fails leaves its child unbuilt over it, with the reason; the parent's recovery builds both", async () => {
  await withWorld({ parent: scheduled("SELECT id, n::integer AS n FROM events", "id"), child: scheduled("SELECT count(*) AS rows, sum(n) AS total FROM parent") }, async (w) => {
    const first = await w.until(built, "public.child");
    await w.store.writer.run("INSERT INTO public.events VALUES (9, 1, 'query', 'ok', 'not-a-number', NULL, NULL, NULL, NULL)");
    w.sync.generated.changed("public.events");
    await w.sync.generated.run("public.parent");
    assert.equal(w.status("public.parent").state, "failed");
    const child = w.status("public.child");
    assert.equal(child.lastRun?.at, first.lastRun?.at, "the child was not run");
    assert.match(child.waitingFor ?? "", /^public\.parent failed its last run$/);
    assert.ok(w.logged.includes("public.child: not run, because public.parent failed its last run"));
    // asked on its own, it is still not run
    await w.sync.generated.run("public.child");
    assert.equal(w.status("public.child").lastRun?.at, first.lastRun?.at);
    await w.store.writer.run("UPDATE public.events SET n = '9' WHERE id = 9");
    await w.sync.generated.run("public.parent");
    assert.deepEqual(await ask(w, "SELECT rows, total FROM child"), [["5", "19"]]);
    assert.equal(w.status("public.child").waitingFor, null);
  });
});

test("a parent not built yet is waited for by name, and said refused where its file is", async () => {
  await withWorld({ parent: "kind: scheduled\nsql: SELECT 1 AS one\n", child: scheduled("SELECT one FROM parent") }, async (w) => {
    await w.until((s) => s.state === "refused", "public.parent");
    const child = await w.until((s) => s.waitingFor !== null, "public.child");
    assert.equal(child.waitingFor, "public.parent, which is refused");
    assert.equal(child.state, "waiting");
  });
});

test("the swap of a chain is one writer's turn: when the parent is swapped in, so is its child", async () => {
  let rows: ((sql: string) => Promise<unknown[][]>) | null = null, armed = false;
  const seen: unknown[][][] = [];
  await withWorld({ counts: COUNTS, doubled: scheduled("SELECT tenant_id, requests * 2 AS doubled FROM counts", "tenant_id") }, async (w) => {
    rows = w.rows;
    await w.until(built, "public.doubled");
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 3, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    w.reached.length = 0;
    armed = true;
    await w.sync.generated.run("public.counts");
    assert.deepEqual(w.reached, ["snapshot", "snapshot", "written", "written", "committed", "committed", "swapped", "swapped"]);
    assert.deepEqual(seen, [[[3n]]], "the child held the new tenant once the parent was swapped in");
  }, { onStep: async (s, n) => { if (armed && s === "swapped" && n === "public.counts") seen.push(await rows!("SELECT count(*) FROM public.doubled")); } });
});

test("a run asked while another is in flight waits for it, so a child is never left over its parent's old rows (issue 195)", async () => {
  // the child's own run is held after its swap, still running, as the queue's run is when a status already reads it built
  let release: (() => void) | null = null, held = false;
  const gate = new Promise<void>((r) => { release = r; });
  await withWorld({ counts: COUNTS, doubled: scheduled("SELECT tenant_id, requests * 2 AS doubled FROM counts", "tenant_id") }, async (w) => {
    for (const end = Date.now() + BUILD_BOUND_MS; !held && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
    assert.ok(held, "the child's first run reached its swap");
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 3, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL), (8, 3, 'load', 'ok', '8', NULL, NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    const asked = w.sync.generated.run("public.doubled");
    release!();
    await asked;
    const parent = await ask(w, "SELECT tenant_id, requests * 2 FROM counts ORDER BY 1"), child = await ask(w, "SELECT tenant_id, doubled FROM doubled ORDER BY 1");
    assert.deepEqual(parent, [[1, "4"], [2, "4"], [3, "4"]]);
    assert.deepEqual(child, parent, "the child was built with its parent");
  }, { onStep: async (s, n) => { if (s === "swapped" && n === "public.doubled" && !held) { held = true; await gate; } } });
});

// ------------------------------------------------------------------------------- chains: PR 163's review round

test("a child whose own build fails in its parent's run stays behind its parent, so it is tried again after its back-off", async () => {
  await withWorld({ parent: scheduled("SELECT id, n FROM events", "id"), child: scheduled("SELECT sum(n::integer) AS total FROM parent") }, async (w) => {
    await w.until(built, "public.child");
    await w.store.writer.run("INSERT INTO public.events VALUES (9, 1, 'query', 'ok', 'not-a-number', NULL, NULL, NULL, NULL)");
    w.sync.generated.changed("public.events");
    await w.sync.generated.run("public.parent");
    assert.deepEqual(await ask(w, "SELECT count(*) FROM parent"), [["5"]], "the parent swapped in alone");
    const child = w.status("public.child");
    assert.equal(child.state, "failed");
    assert.ok(child.behindSeconds > 0, "the child does not hold the parent it reads: it is due again once its back-off is over");
    assert.equal(w.status("public.parent").behindSeconds, 0);
  });
});

test("after a restart a chain built together is current, and a parent swapped in alone since leaves its child behind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-chain-keep-"));
  const files = { counts: COUNTS, doubled: scheduled("SELECT tenant_id, requests * 2 AS doubled FROM counts", "tenant_id") };
  try {
    let child: string | undefined;
    await withWorld(files, async (w) => { child = (await w.until(built, "public.doubled")).lastRun?.at; }, { dir });
    await withWorld({}, async (w) => {
      await w.sync.generated.review();
      const s = w.status("public.doubled");
      assert.equal(s.lastRun?.at, child);
      assert.equal(s.behindSeconds, 0, "its parent is the one it was built over");
      assert.equal(s.missingTarget, false);
      // the parent swapped in alone just before a crash (a new definition, say): its mark lived only in memory
      await w.store.writer.run(`UPDATE ${MASON_SCHEMA}.generated_tables SET snapshot_at = snapshot_at + INTERVAL 1 SECOND WHERE name = 'public.counts'`);
    }, { dir, again: true });
    await withWorld({}, async (w) => {
      assert.ok(w.status("public.doubled").behindSeconds > 0 || w.status("public.doubled").lastRun?.at !== child, "a parent swapped in since its build leaves it behind");
      assert.equal(w.status("public.counts").behindSeconds, 0);
      // and it is built again over the parent it reads
      await w.until((s) => s.lastRun?.at !== child, "public.doubled");
    }, { dir, again: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a child that reads its parent by a schema-qualified column is built in its parent's run", async () => {
  await withWorld({ counts: COUNTS, tenants: scheduled("SELECT public.counts.tenant_id FROM public.counts", "tenant_id") }, async (w) => {
    await w.until(built, "public.tenants");
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 3, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    await w.sync.generated.run("public.counts");
    assert.equal(w.status("public.tenants").error, null);
    assert.deepEqual(await ask(w, "SELECT tenant_id FROM tenants ORDER BY 1"), [[1], [2], [3]]);
  });
});

test("a parent refused in its file is re-run from what it was built from, and carries its children", async () => {
  await withWorld({ counts: COUNTS, total: scheduled("SELECT sum(requests)::bigint AS total FROM counts") }, async (w) => {
    await w.until(built, "public.total");
    w.write("counts", "kind: scheduled\ntarget_lag: 1s\nsql: SELECT date_trunc('day', started_at) AS day FROM events\n");
    await w.until((s) => s.state === "refused");
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 5, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    await w.sync.generated.run("public.counts");
    assert.deepEqual(await ask(w, "SELECT sum(requests) FROM counts"), [["5"]]);
    assert.deepEqual(await ask(w, "SELECT total FROM total"), [["5"]], "the child is built over the parent it reads");
    const child = w.status("public.total");
    assert.equal(child.state, "current");
    assert.equal(child.waitingFor, null);
  });
});

test("two files rewritten in one round into a chain the other way round are no cycle", async () => {
  await withWorld({ a: scheduled("SELECT one FROM b"), b: scheduled("SELECT count(*) AS one FROM events") }, async (w) => {
    await w.until(built, "public.a");
    w.write("a", scheduled("SELECT count(*) AS one FROM events"));
    w.write("b", scheduled("SELECT one FROM a"));
    await w.sync.generated.review();
    assert.deepEqual([w.status("public.a").refusals, w.status("public.b").refusals], [[], []]);
    assert.ok(!w.logged.some((l) => /reads itself/.test(l)), w.logged.join("\n"));
  });
});
