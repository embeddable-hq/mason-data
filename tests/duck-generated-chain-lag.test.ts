/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: a chain's lag and targets
 * (issue 124 stage 2b) and PR 171's review round. Each test runs its own world (tests/duck-generated-world.ts). What
 * Postgres answers from the same SQL is tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import { built, COUNTS, refusedAt, withWorld } from "./duck-generated-world.ts";
import { scheduled } from "./duck-generated-ledger.ts";

after(() => stopParser());

// ------------------------------------------------------------------------------- chains: lag and targets (stage 2b)

/** a table no review runs by itself: its runs are the test's */
const hourly = (text: string): string => text.replace("target_lag: 1s", "target_lag: 1h");

test("a chain's child lag grows after a base change below its parent, and returns to 0 after the chain's run", async () => {
  await withWorld({ counts: hourly(COUNTS), doubled: hourly(scheduled("SELECT tenant_id, requests * 2 AS doubled FROM counts", "tenant_id")) }, async (w) => {
    await w.until(built, "public.doubled");
    assert.deepEqual([w.status("public.doubled").behindSince, w.status("public.doubled").state], [null, "current"]);
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 3, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    const before = Date.now();
    w.sync.generated.changed("public.events");
    await new Promise((r) => setTimeout(r, 50));
    const parent = w.status("public.counts"), child = w.status("public.doubled");
    assert.equal(child.state, "behind", "a change below its parent is not in the child either");
    assert.ok(child.behindSince !== null && Date.parse(child.behindSince) >= before, JSON.stringify(child));
    assert.equal(child.behindSince, parent.behindSince, "measured against the base, not its parent's run");
    assert.ok(child.behindSeconds >= 0.04, JSON.stringify(child));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(w.status("public.doubled").behindSeconds > child.behindSeconds, "and grows");
    await w.sync.generated.run("public.counts");
    for (const n of ["public.counts", "public.doubled"]) assert.deepEqual([w.status(n).behindSeconds, w.status(n).behindSince, w.status(n).state], [0, null, "current"], n);
  });
});

test("a child left out of its parent's run is marked at the base change the parent brought, never at the swap", async () => {
  await withWorld({ parent: hourly(scheduled("SELECT id, n FROM events", "id")), child: hourly(scheduled("SELECT sum(n::integer) AS total FROM parent")) }, async (w) => {
    await w.until(built, "public.child");
    await w.store.writer.run("INSERT INTO public.events VALUES (9, 1, 'query', 'ok', 'not-a-number', NULL, NULL, NULL, NULL)");
    w.sync.generated.changed("public.events");
    const since = w.status("public.parent").behindSince;
    await new Promise((r) => setTimeout(r, 30));
    await w.sync.generated.run("public.parent");
    assert.equal(w.status("public.parent").behindSince, null);
    assert.equal(w.status("public.child").behindSince, since, "the child's own build failed: it is behind the base change, not the swap");
  });
});

test("lag after a restart: a parent whose base moved since its build leaves its child behind from the same moment, until the chain's run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-chain-lag-"));
  const files = { counts: hourly(COUNTS), doubled: hourly(scheduled("SELECT tenant_id, requests * 2 AS doubled FROM counts", "tenant_id")) };
  try {
    await withWorld(files, async (w) => { await w.until(built, "public.doubled"); }, { dir });
    // the base synced again since the parent's snapshot, its mark lost with the process
    await withWorld({}, async (w) => {
      await w.store.writer.run(`UPDATE ${MASON_SCHEMA}.generated_tables SET bases_synced = '{"public.events": 1}' WHERE name = 'public.counts'`);
    }, { dir, again: true });
    await withWorld({}, async (w) => {
      const parent = w.status("public.counts"), child = w.status("public.doubled");
      assert.equal(parent.state, "behind");
      assert.ok(child.behindSince !== null, JSON.stringify(child));
      assert.equal(child.behindSince, parent.behindSince, "the child is behind from the parent's snapshot, though its own bases did not move");
      await w.sync.generated.review();
      await w.sync.generated.run("public.counts");
      for (const n of ["public.counts", "public.doubled"]) assert.deepEqual([w.status(n).behindSince, w.status(n).state], [null, "current"], n);
    }, { dir, again: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a child's target_lag below its parent's is refused by name, with the way out; raised, it is built", async () => {
  const fiveMinutes = COUNTS.replace("target_lag: 1s", "target_lag: 5m");
  await withWorld({ counts: fiveMinutes, fast: scheduled("SELECT count(*) AS n FROM counts"), slow: scheduled("SELECT count(*) AS n FROM counts").replace("1s", "10m") }, async (w) => {
    const fast = await w.until((s) => s.state === "refused", "public.fast");
    refusedAt(fast.refusals, "target_lag", /^target_lag 1s is shorter than that of public\.counts, which it reads \(5m\)$/);
    assert.match(fast.refusals[0]!.text, /set target_lag: 5m or longer/);
    assert.match(fast.refusals[0]!.text, /no fresher than a generated table it reads/);
    await w.until(built, "public.slow");
    w.write("fast", scheduled("SELECT count(*) AS n FROM counts").replace("1s", "5m"));
    await w.until(built, "public.fast");
    // the parent's target raised past it: refused again, though its own file did not change
    w.write("counts", COUNTS.replace("target_lag: 1s", "target_lag: 1h"));
    refusedAt((await w.until((s) => s.state === "refused", "public.slow")).refusals, "target_lag", /^target_lag 10m is shorter than that of public\.counts, which it reads \(1h\)$/);
  });
});

// ------------------------------------------------------------------------------- chains: PR 171's review round

test("a grandchild left out of its chain's run is marked at the base change below it, though its parent took none itself", async () => {
  await withWorld({ bottom: hourly(scheduled("SELECT id, n FROM events", "id")), middle: hourly(scheduled("SELECT id, n FROM bottom", "id")),
    top: hourly(scheduled("SELECT sum(n::integer) AS total FROM middle")) }, async (w) => {
    await w.until(built, "public.top");
    await w.store.writer.run("INSERT INTO public.events VALUES (9, 1, 'query', 'ok', 'not-a-number', NULL, NULL, NULL, NULL)");
    w.sync.generated.changed("public.events");
    const since = w.status("public.bottom").behindSince;
    assert.ok(since !== null);
    await new Promise((r) => setTimeout(r, 30));
    // the run builds all three; top's build fails and is taken out; bottom and middle swap in, middle having taken nothing
    await w.sync.generated.run("public.bottom");
    assert.deepEqual([w.status("public.bottom").behindSince, w.status("public.middle").behindSince], [null, null]);
    assert.equal(w.status("public.top").behindSince, since, "behind the base change below it, not its parent's swap");
  });
});

test("a child waiting for a parent says it is refused as the parent is when read: in either file order, and not once the parent is fixed", async () => {
  // a refusal from the parent's check (a column it lacks), not its file: the child, checked first or last, sees it
  const broken = "kind: scheduled\ntarget_lag: 1s\nsql: SELECT nope FROM events\n";
  let look: ((n: string) => string | null) | null = null;
  const during: Array<string | null> = [];
  await withWorld({ a: scheduled("SELECT one FROM zz"), zz: broken, aa: broken, z: scheduled("SELECT one FROM aa") }, async (w) => {
    look = (n) => w.status(n).waitingFor;
    for (const [child, parent] of [["public.a", "public.zz"], ["public.z", "public.aa"]] as const) {
      await w.until((s) => s.state === "refused", parent);
      const s = await w.until((s) => s.waitingFor !== null, child);
      assert.equal(s.waitingFor, `${parent}, which is refused`, child);
    }
    // the parent fixed: while it builds, the child waits for it by name, and no longer says it is refused
    w.write("zz", scheduled("SELECT 1 AS one"));
    await w.until(built, "public.a");
    assert.ok(during.length > 0, "the parent's run was seen");
    assert.deepEqual([...new Set(during)], ["public.zz"]);
  }, { onStep: (s, n) => { if (s === "snapshot" && n === "public.zz" && look !== null) during.push(look("public.a")); } });
});

test("a child is held to the target_lag its parent runs at: a parent refused in its file but deployed keeps its built one", async () => {
  await withWorld({ counts: COUNTS.replace("target_lag: 1s", "target_lag: 5m"), slow: scheduled("SELECT count(*) AS n FROM counts").replace("1s", "10m") }, async (w) => {
    await w.until(built, "public.slow");
    w.write("counts", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT nope FROM events\n");
    await w.until((s) => s.state === "refused", "public.counts");
    await w.sync.generated.review();
    await w.sync.generated.review();
    const slow = w.status("public.slow");
    assert.deepEqual(slow.refusals, [], "held to the 5m public.counts runs at, not its refused file's 1h");
    assert.notEqual(slow.state, "refused");
  });
});
