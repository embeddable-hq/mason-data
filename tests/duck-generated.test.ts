/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124): a real file, a real listener and
 * its catalog, and a Sync whose base is made by hand, as the wire tests make theirs. What Postgres answers from the same
 * SQL is tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type pg from "pg";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import { GENERATED_DIR, GENERATED_KEYS, parseGeneratedText, readGenerated } from "../src/cli/generated-files.ts";
import type { AddedTable } from "../src/duck/sync.ts";
import { REVIEW_MS, withoutValues, type GeneratedStatus, type GeneratedStep } from "../src/duck/generated.ts";
import { definitionStatement, refusalText, type GeneratedRefusal } from "../src/duck/generated-plan.ts";
import { parseLag, parseSync } from "../src/lib/table-sync.ts";
import { generatedLines } from "../src/cli/commands.ts";
import { guideText } from "../src/cli/guides.ts";
import { built, COUNTS, plain, refusedAt, withWorld } from "./duck-generated-world.ts";

after(() => stopParser());

test("a declared table is built, in the catalog with Postgres's names and types and its comment, and served by name", async () => {
  await withWorld({ counts: `${COUNTS}comment: Requests per tenant.\n` }, async (w) => {
    await w.until(built);
    const c = await w.client();
    try {
      const r = await c.query({ text: "SELECT * FROM counts ORDER BY tenant_id", rowMode: "array" });
      assert.deepEqual(r.fields.map((f) => [f.name, f.dataTypeID]), [["tenant_id", 23], ["requests", 20], ["last_at", 1184]]);
      assert.deepEqual(r.rows.map((x) => [x[0], x[1]]), [[1, "2"], [2, "2"]]);
      const comment = await c.query("SELECT obj_description('public.counts'::regclass) AS comment, (SELECT relkind FROM pg_class WHERE oid = 'public.counts'::regclass) AS kind");
      assert.deepEqual(comment.rows, [{ comment: "Requests per tenant.", kind: "r" }]);
      const plan = (await c.query("EXPLAIN SELECT tenant_id FROM counts")).rows.map((x: Record<string, string>) => x["QUERY PLAN"]).join("\n");
      assert.match(plan, /generated from mason\/generated_tables\/counts\.yml: scheduled, re-run whole, target 1s/);
    } finally { await c.end(); }
    assert.equal(w.status().method, "whole");
    assert.equal(w.status().kind, "scheduled");
    assert.deepEqual(w.status().lastRun?.rows, 2);
  });
});

test("the rows are written in order_by's order, and a sort of them is the rewrite's: NULLs last, as Postgres sorts them", async () => {
  await withWorld({ ordered: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, started_at FROM events\norder_by: started_at DESC, id\n" }, async (w) => {
    await w.until(built, "public.ordered");
    // heap order, read with no ORDER BY: DESC puts a NULL first in Postgres, and DuckDB's default would put it last
    assert.deepEqual((await w.rows("SELECT id FROM public.ordered")).map((r) => r[0]), [4n, 3n, 2n, 1n]);
  });
});

test("an idle base is never run again, and lag is the oldest change not reflected, not the snapshot's age", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    assert.equal(first.behindSeconds, 0);
    await new Promise((r) => setTimeout(r, 1200));
    await w.sync.generated.review();
    assert.equal(w.status().state, "current", "a second past its target over an idle base, nothing is behind");
    assert.equal(w.status().lastRun?.at, first.lastRun?.at, "and it did not run");
    await w.store.writer.run("INSERT INTO public.events VALUES (5, 3, 'query', 'ok', '5', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    assert.equal(w.status().state, "behind");
    // no review runs between these reads, so nothing is queued: the lag is the change's age, and grows with it
    const b1 = w.status().behindSeconds;
    await new Promise((r) => setTimeout(r, 150));
    const b2 = w.status().behindSeconds;
    assert.ok(b2 > b1 && b2 >= 0.1, `lag grows after a base change: ${b1} then ${b2}`);
    const after = await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    assert.equal(after.lastRun?.rows, 3);
    assert.equal(after.behindSeconds, 0);
  });
});

test("a commit after a run's snapshot marks the next run: the marks and the snapshot are one moment", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(built);
    const c = w.sync.generated;
    // a run holds its turn on the writer as a batch would: a change committed behind that turn lands after the snapshot
    const running = c.run("public.counts");
    await w.store.writer.run("INSERT INTO public.events VALUES (6, 4, 'query', 'ok', '6', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    c.changed("public.events");
    await running;
    await w.until(() => (w.status().lastRun?.rows ?? 0) === 3);
    assert.equal(w.status().behindSeconds, 0);
  });
});

test("now() is the run's, and reads as of the run; the session's zone is refused, with the line to write", async () => {
  await withWorld({
    stamped: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, now() AS at_run, date_trunc('day', started_at, 'UTC') AS day FROM events\n",
    today: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, current_date AS today FROM events\n",
    clock: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, current_time AS t FROM events\n",
    local: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, localtime AS t FROM events\n",
    localstamp: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, localtimestamp AS t FROM events\n",
    zone: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT date_trunc('day', started_at) AS day FROM events\n",
    later: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT started_at + interval '1 day' AS later FROM events\n",
    named: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT current_setting('TimeZone') AS who FROM events\n",
    day: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT started_at::date AS day FROM events\n",
    older: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT age(finished_at, started_at) AS took FROM events\n",
    text: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT (started_at AT TIME ZONE 'UTC')::date::text AS day FROM events\n",
    utc: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM events\n",
  }, async (w) => {
    const s = await w.until(built, "public.stamped");
    assert.equal(s.lastRun?.rows, 4);
    const at = (await w.rows("SELECT DISTINCT epoch_ms(at_run) FROM public.stamped"))[0]![0];
    assert.ok(Math.abs(Number(at) - Date.parse(s.lastRun!.at)) < 10_000, `${String(at)} as of the run ${s.lastRun!.at}`);
    for (const name of ["today", "clock", "local", "localstamp", "zone", "later", "named", "day", "older", "text"]) {
      const r = w.status(`public.${name}`);
      assert.equal(r.state, "refused", `${name}: ${JSON.stringify(r)}`);
      refusedAt(r.refusals, "sql", /reads a session/);
      assert.ok(r.refusals[0]!.options.some((o) => o.includes("AT TIME ZONE 'UTC'")), `${name}: ${JSON.stringify(r.refusals)}`);
      assert.match(r.refusals[0]!.text, new RegExp(`^mason/generated_tables/${name}\\.yml: sql: it reads a session`));
    }
    await w.until(built, "public.utc");
  });
});

test("a run reads times as a Postgres session in UTC would, whatever zone the engine's other connections are in", async () => {
  await withWorld({}, async (w) => {
    // a zone every connection opened from here on would take, and the run's connection is told otherwise
    await w.store.writer.run("SET GLOBAL TimeZone = 'Asia/Kolkata'");
    try {
      // a timestamptz literal with no zone is read in the plan's zone, UTC: 03:00 UTC holds the first day's two rows, and
      // 03:00 at +05:30 none of them
      w.write("early", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, started_at FROM events WHERE started_at < '2026-01-01 03:00'\norder_by: id\n");
      const s = await w.until(built, "public.early");
      assert.equal(s.lastRun?.rows, 2);
      assert.deepEqual(await w.rows("SELECT id, strftime(started_at AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S') FROM public.early ORDER BY id"), [[1n, "2026-01-01 00:00:00"], [2n, "2026-01-01 00:00:05"]]);
    } finally { await w.store.writer.run("SET GLOBAL TimeZone = 'UTC'"); }
  });
});

test("the swap waits for the writer's turn: a write holding the turn keeps the old table served until it ends", async () => {
  let hold: (() => Promise<void>) | null = null;
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    const sync = w.sync as unknown as { onWriter<T>(f: () => Promise<T>): Promise<T> };
    let release = (): void => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let turn: Promise<void> | null = null;
    // once the run's table is written and committed, a write takes the writer's turn and keeps it
    hold = async () => { turn = sync.onWriter(() => held); };
    await w.store.writer.run("INSERT INTO public.events VALUES (13, 9, 'query', 'ok', '13', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    w.reached.length = 0;
    try {
      for (const end = Date.now() + 10_000; !w.reached.includes("committed") && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
      assert.ok(w.reached.includes("committed"), "the run wrote and committed its table");
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!w.reached.includes("swapped"), "and has not swapped it in while the writer's turn is held");
      assert.deepEqual(await w.rows("SELECT count(*) FROM public.counts"), [[2n]], "the old table serves");
      assert.equal(w.status().lastRun?.at, first.lastRun?.at);
    } finally {
      // a stop waits for the writer's turn: released whatever was found, so a failure here fails and never hangs
      hold = null;
      release();
    }
    await turn;
    const after = await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    assert.equal(after.lastRun?.rows, 3);
    assert.deepEqual(w.reached.slice(-2), ["committed", "swapped"]);
  }, { onStep: (s) => s === "committed" ? hold?.() : undefined });
});

test("what a table cannot store is refused by name at its key, before anything is built", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await withWorld({
    money: `${lag}sql: SELECT sum(amount) AS total FROM events\n`,
    avg: `${lag}sql: SELECT avg(tenant_id) AS mean FROM events\n`,
    unnamed: `${lag}sql: SELECT id + 1 FROM events\n`,
    twice: `${lag}sql: SELECT id, tenant_id AS id FROM events\n`,
    arrays: `${lag}sql: SELECT array_agg(id ORDER BY id) AS ids FROM events\n`,
    write: `${lag}sql: DELETE FROM events\n`,
    two: `${lag}sql: SELECT 1 AS a; SELECT 2 AS b\n`,
    syntax: `${lag}sql: SELEC 1\n`,
    nothing: `${lag}sql: SELECT id FROM no_such_table\n`,
    badorder: `${lag}sql: SELECT id FROM events\norder_by: id LIMIT 1\n`,
    badorder2: `${lag}sql: SELECT id FROM events\norder_by: id; DROP TABLE events\n`,
    badcolumn: `${lag}sql: SELECT id FROM events\norder_by: tenant_id\n`,
    events: `${lag}sql: SELECT id FROM events\n`,
    self: `${lag}sql: SELECT * FROM self\n`,
    today: `${lag}sql: SELECT id FROM events WHERE started_at < 'today'::timestamptz\n`,
  }, async (w) => {
    await w.sync.generated.review();
    const r = (name: string): GeneratedStatus => w.status(`public.${name}`);
    for (const name of ["money", "avg"]) { assert.equal(r(name).state, "refused"); refusedAt(r(name).refusals, "sql", /is numeric, which a generated table can't store yet/); }
    assert.ok(r("money").refusals[0]!.options.some((o) => o.includes("::double precision")), JSON.stringify(r("money").refusals));
    refusedAt(r("unnamed").refusals, "sql", /has no name/);
    refusedAt(r("twice").refusals, "sql", /names column id twice/);
    refusedAt(r("arrays").refusals, "sql", /of type bigint\[\], which a generated table can't store yet/);
    refusedAt(r("write").refusals, "sql", /is not a SELECT/);
    refusedAt(r("two").refusals, "sql", /holds 2 statements/);
    refusedAt(r("syntax").refusals, "sql", /not SQL Postgres reads/);
    refusedAt(r("nothing").refusals, "sql", /relation "no_such_table" does not exist/);
    refusedAt(r("badorder").refusals, "order_by", /says more than an order/);
    refusedAt(r("badorder2").refusals, "order_by", /ends the statement/);
    refusedAt(r("badcolumn").refusals, "sql", /column "tenant_id" does not exist/);
    refusedAt(r("events").refusals, null, /is a table the sources file syncs/);
    refusedAt(r("self").refusals, "sql", /^it reads public\.self, itself$/);
    refusedAt(r("today").refusals, "sql", /relative literal/);
    assert.deepEqual(w.sync.generated.status().filter((s) => s.serving), [], "nothing was built");
    assert.deepEqual(await w.rows("SELECT table_name FROM duckdb_tables() WHERE schema_name = 'public' AND table_name <> 'events'"), []);
    for (const name of ["money", "write", "badorder"]) assert.ok(w.logged.some((l) => l.includes(`mason/generated_tables/${name}.yml:`)), `${name} is said in the log`);
  });
});

test("a live table is refused by name: stage by stage, never run as something else", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(built);
    w.write("wanted", "kind: live\nsql: SELECT tenant_id, count(*) AS n FROM events GROUP BY 1\n");
    const live = await w.until((s) => s.state === "refused", "public.wanted");
    refusedAt(live.refusals, "kind", /live isn't available yet/);
    assert.equal(live.kind, "live");
    assert.equal(live.serving, false, "no input builds it as a scheduled table");
    assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'wanted'"), [[0n]]);
  });
});

test("an edit that is refused leaves the deployed table serving and still being re-run from what it was built with", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    w.write("counts", "kind: scheduled\ntarget_lag: 1s\nsql: SELECT date_trunc('day', started_at) AS day FROM events\n");
    const refused = await w.until((s) => s.state === "refused");
    assert.equal(refused.serving, true);
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 5, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    const after = await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    assert.equal(after.lastRun?.rows, 3, "a new tenant, from the deployed SQL");
    assert.equal(after.state, "refused", "and it still says the file is refused");
    // to live from a deployed scheduled table: refused, and the table stays what it was
    w.write("counts", "kind: live\nsql: SELECT 1 AS one\n");
    const live = await w.until((s) => s.kind === "live");
    assert.equal(live.state, "refused");
    assert.equal(live.serving, true);
    const c = await w.client();
    try { assert.equal((await c.query("SELECT count(*) AS n FROM counts")).rows[0].n, "3"); } finally { await c.end(); }
    w.write("counts", COUNTS.replace("count(*) AS requests", "count(*) AS requests, min(id) AS first_id"));
    await w.until((s) => s.state !== "refused" && s.serving && s.refusals.length === 0);
    await w.until((s) => s.lastRun?.at !== after.lastRun?.at);
    const c2 = await w.client();
    try {
      // the catalog follows the swap by a moment, as it does a copy's
      const read = "SELECT tenant_id, first_id FROM counts ORDER BY 1 LIMIT 1";
      const end = Date.now() + 10_000;
      let rows = await c2.query(read).then((r) => r.rows, (e: { code?: string }) => { if (e.code !== "42703") throw e; return null; });
      while (rows === null && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 20));
        rows = await c2.query(read).then((r) => r.rows, (e: { code?: string }) => { if (e.code !== "42703") throw e; return null; });
      }
      assert.deepEqual(rows, [{ tenant_id: 1, first_id: "1" }]);
    } finally { await c2.end(); }
  });
});

test("a failed run keeps the table serving, says why with no value of a row, retries after its back-off, and recovers", async () => {
  await withWorld({ counts: "kind: scheduled\ntarget_lag: 1s\nsql: SELECT id, 10 / (id - 8) AS q, n::integer AS n FROM events\n" }, async (w) => {
    const first = await w.until(built);
    await w.store.writer.run("INSERT INTO public.events VALUES (9, 1, 'query', 'ok', 'secret-value', NULL, NULL, NULL, NULL)");
    w.sync.generated.changed("public.events");
    const failed = await w.until((s) => s.state === "failed");
    assert.equal(failed.serving, true);
    assert.equal(failed.lastRun?.at, first.lastRun?.at);
    assert.doesNotMatch(failed.error ?? "", /secret-value/);
    assert.ok(failed.retryAt !== null && Date.parse(failed.retryAt) > Date.now());
    assert.ok(w.events.some((e) => e.kind === "generated_failed" && e.table === "public.counts" && !e.message.includes("secret-value")));
    assert.ok(failed.behindSeconds > 0, "what it took is still not in the table");
    assert.equal((await w.client().then(async (c) => { try { return (await c.query("SELECT count(*) AS n FROM counts")).rows[0].n; } finally { await c.end(); } })), "4", "the old table serves");
    assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%__mason_generated'"), [[0n]], "the run left nothing beside it");
    // fixed by the row changing: tried again once its back-off is over (the test moves that moment, not the clock)
    await w.store.writer.run("UPDATE public.events SET n = '9' WHERE id = 9");
    await w.sync.generated.run("public.counts");
    const after = w.status();
    assert.equal(after.state, "current");
    assert.equal(after.lastRun?.rows, 5);
    assert.ok(w.events.some((e) => e.kind === "recovered" && e.table === "public.counts"));
  });
});

test("the values of a row never reach what is recorded", () => {
  assert.equal(withoutValues(`invalid input syntax for type integer: "abc"`), "invalid input syntax for type integer: …");
  assert.equal(withoutValues("Conversion Error: Could not convert string 'tenant-42' to INT32\nLINE 1: SELECT"), "Conversion Error: Could not convert string … to INT32");
  assert.equal(withoutValues("value 123456 out of range for type smallint"), "value … out of range for type smallint");
});

test("a statement before the first build is told what the table is doing, by name", async () => {
  await withWorld({ counts: COUNTS, broken: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT no_such FROM events\n" }, async (w) => {
    await w.until(built);
    const c = await w.client();
    try {
      await assert.rejects(c.query("SELECT * FROM broken"), (e: pg.DatabaseError) => e.code === "0A000" && /the generated table public\.broken is not built yet: refused/.test(e.message) && /Mason gap generated-not-built/.test(e.detail ?? ""));
    } finally { await c.end(); }
  });
});

test("a table whose file goes is dropped, from the file and the catalog; one with a run still queued waits for it", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(built);
    w.remove("counts");
    // the run that built it may still be ending: the table waits for it, and goes at the review after
    for (const end = Date.now() + 10_000; w.sync.generated.status().length > 0 && Date.now() < end;) {
      await w.sync.generated.review();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(w.sync.generated.status(), []);
    assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'counts'"), [[0n]]);
    assert.deepEqual(await w.rows(`SELECT count(*) FROM ${MASON_SCHEMA}.generated_tables`), [[0n]]);
    assert.ok(w.logged.some((l) => /its file is gone/.test(l)));
    const c = await w.client();
    try { await assert.rejects(c.query("SELECT * FROM counts"), /relation "counts" does not exist/); } finally { await c.end(); }
  });
});

test("after a restart the table serves from its ledger, its definition kept, and is run again only if a base moved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-keep-"));
  try {
    let built1: string | undefined;
    await withWorld({ counts: COUNTS }, async (w) => { built1 = (await w.until(built)).lastRun?.at; }, { dir });
    // idle since its build: the same table, served at once, and nothing behind
    await withWorld({}, async (w) => {
      await w.sync.generated.review();
      const s = w.status();
      assert.equal(s.lastRun?.at, built1);
      assert.equal(s.behindSeconds, 0);
      const c = await w.client();
      try { assert.equal((await c.query("SELECT count(*) AS n FROM counts")).rows[0].n, "2"); } finally { await c.end(); }
      // moved while the run was down: the ledger's own last sync of the base is newer than the build
      await w.store.writer.run("INSERT INTO public.events VALUES (8, 7, 'query', 'ok', '8', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
      await w.store.writer.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.events', '100:100:', now() + INTERVAL 1 MINUTE, 'off')`);
    }, { dir, again: true });
    await withWorld({}, async (w) => {
      assert.ok(w.status().behindSeconds > 0 || w.status().lastRun?.at !== built1, "a base synced since its build counts as changed since then");
      const after = await w.until((s) => s.lastRun?.at !== built1);
      assert.equal(after.lastRun?.rows, 3);
    }, { dir, again: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a side table no ledger row names is dropped, and blocks nothing", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    await w.store.writer.run("CREATE TABLE public.counts__mason_generated AS SELECT 1 AS x");
    await w.store.writer.run("INSERT INTO public.events VALUES (10, 6, 'query', 'ok', '10', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    const after = await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    assert.equal(after.lastRun?.rows, 3);
    assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%__mason_generated'"), [[0n]]);
  });
});

test("a start drops a side table left behind, and only one: a table whose name the suffix's LIKE would match survives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-suffix-"));
  try {
    await withWorld({}, async (w) => {
      // `_` in LIKE is any one character: each of these matches '%__mason_generated', and none is a side table
      await w.store.writer.run("CREATE TABLE public.report_mason_generated AS SELECT 1 AS x");
      await w.store.writer.run("CREATE TABLE public.xy_masonXgenerated AS SELECT 1 AS x");
      await w.store.writer.run("CREATE TABLE public.counts__mason_generated AS SELECT 1 AS x");
    }, { dir });
    await withWorld({}, async (w) => {
      const names = (await w.rows("SELECT table_name FROM duckdb_tables() WHERE schema_name = 'public' AND table_name LIKE '%generated' ORDER BY 1")).map((r) => r[0]);
      assert.deepEqual(names, ["report_mason_generated", "xy_masonXgenerated"]);
    }, { dir, again: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * A CRASH AT EACH STEP OF A RUN, by a real SIGKILL in a process of its own (tests/duck-generated-crash-child.ts), the file
 * then opened again: the table serves what it held and agrees with its ledger row, nothing is left beside it, and the
 * change the run was carrying is in the table after the restart's run.
 */
for (const [step, served] of [["snapshot", "2"], ["written", "2"], ["committed", "2"], ["swapped", "3"]] as Array<[GeneratedStep, string]>) {
  test(`a crash at the run's step "${step}" leaves the table whole, serving ${served === "2" ? "what it held" : "what it swapped in"}, and the next run current`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-crash-"));
    try {
      const child = spawnSync(process.execPath, [path.join(import.meta.dirname, "duck-generated-crash-child.ts"), dir, step], { encoding: "utf8", timeout: 60_000 });
      assert.equal(child.signal, "SIGKILL", `it died at ${step}: ${child.status} ${child.stdout} ${child.stderr}`);
      // the restart's first run waits here until what the crash left has been read
      let release = (): void => undefined;
      const gate = new Promise<void>((r) => { release = r; });
      await withWorld({}, async (w) => {
        try {
          const c = await w.client();
          try { assert.equal((await c.query("SELECT count(*) AS n FROM counts")).rows[0].n, served); } finally { await c.end(); }
          assert.deepEqual(await w.rows(`SELECT "rows"::VARCHAR FROM ${MASON_SCHEMA}.generated_tables`), [[served]], "its ledger row is the table's");
          assert.ok(w.status().behindSeconds > 0, "a base synced since the build counts as changed");
          assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%__mason_generated'"), [[0n]], "nothing left beside it, before the next run replaces it");
        } finally { release(); }
        const done = await w.until((s) => s.state === "current" && s.lastRun?.rows === 3);
        assert.equal(done.error, null);
        assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE '%__mason_generated'"), [[0n]]);
        assert.deepEqual(await w.rows("SELECT count(*) FROM public.counts"), [[3n]]);
      }, { dir, again: true, onStep: (s) => s === "snapshot" ? gate : undefined });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("a commit that lands while a run is going is in the next one: the run took its snapshot, and the mark stays", async () => {
  let hold: Promise<void> | null = null;
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    let release = (): void => undefined;
    hold = new Promise<void>((r) => { release = r; });
    w.reached.length = 0;
    await w.store.writer.run("INSERT INTO public.events VALUES (11, 7, 'query', 'ok', '11', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    await w.sync.generated.review();
    for (const end = Date.now() + 10_000; !w.reached.includes("snapshot") && Date.now() < end;) { await new Promise((r) => setTimeout(r, 10)); await w.sync.generated.review(); }
    assert.ok(w.reached.includes("snapshot"), "the run took its snapshot");
    assert.equal(w.status().state, "behind", "what a run carries is not in the table yet");
    assert.ok(w.status().behindSeconds > 0);
    // beside the run, after its snapshot
    await w.store.writer.run("INSERT INTO public.events VALUES (12, 8, 'query', 'ok', '12', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    hold = null;
    release();
    const one = await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    assert.equal(one.lastRun?.rows, 3, "tenant 7, whose commit came before the snapshot, and not tenant 8's");
    assert.equal(one.state, "behind", "and the commit after it still counts");
    const two = await w.until((s) => s.state === "current");
    assert.equal(two.lastRun?.rows, 4);
  }, { onStep: (s) => s === "snapshot" ? hold ?? undefined : undefined });
});

test("the file: every mistake at its key, with the way out, all of them at once", () => {
  const at = { schema: "public", table: "x" }, file = "mason/generated_tables/x.yml";
  const refused = (text: string): GeneratedRefusal[] => { const r = parseGeneratedText(text, at, file); assert.ok("refusals" in r, JSON.stringify(r)); return r.refusals; };
  refusedAt(refused(": :"), null, /not YAML/);
  refusedAt(refused(""), null, /is empty/);
  refusedAt(refused("sql: SELECT 1\n"), "kind", /is missing/);
  refusedAt(refused("kind: scheduled\nsql: SELECT 1 AS a\n"), "target_lag", /is missing/);
  refusedAt(refused("kind: scheduld\ntarget_lag: 5m\nsql: SELECT 1 AS a\n"), "kind", /did you mean `scheduled`/);
  refusedAt(refused("kind: live\ntarget_lag: 5m\nsql: SELECT 1 AS a\n"), "target_lag", /contradicts kind: live/);
  refusedAt(refused("kind: live\nsql: SELECT 1 AS a\n"), "kind", /isn't available yet/);
  refusedAt(refused("kind: scheduled\ntarget_lag: 2d\nsql: SELECT 1 AS a\n"), "target_lag", /write 48h/);
  refusedAt(refused("kind: scheduled\ntarget_lag: 500ms\nsql: SELECT 1 AS a\n"), "target_lag", /shortest interval/);
  refusedAt(refused("kind: scheduled\ntarget_lag: 5\nsql: SELECT 1 AS a\n"), "target_lag", /the number 5/);
  refusedAt(refused("kind: scheduled\ntarget_lag: 5m\n"), "sql", /is missing/);
  refusedAt(refused("kind: scheduled\ntarget_lag: 5m\nsql: SELECT 1 AS a\norder_by: [a, b]\n"), "order_by", /one SQL string/);
  refusedAt(refused("kind: scheduled\ntarget_lag: 5m\nsql: SELECT 1 AS a\ndescription: old\n"), "description", /is not a key/);
  assert.equal(refused("kind: nope\ntarget_lag: x\norder_by: []\nfoo: 1\n").length, 5, "all of a file's mistakes on one report");
  const r = refused("kind: live\nsql: SELECT 1 AS a\n")[0]!;
  assert.equal(refusalText(file, r), "mason/generated_tables/x.yml: kind: live isn't available yet.\n" +
    "  A table kept current in its base's own write isn't built yet, and Mason never runs a table as another kind than its file says.\n" +
    "  Your options:\n    - set kind: scheduled with a target_lag, e.g. target_lag: 5m");
  const good = parseGeneratedText("kind: scheduled\ntarget_lag: 30s\nsql: SELECT 1 AS a\norder_by: a\ncomment: One row.\n", { schema: "reports", table: "x" }, file);
  assert.deepEqual(good, { name: "reports.x", schema: "reports", table: "x", file, sql: "SELECT 1 AS a", orderBy: "a", targetLag: { every: "30s", seconds: 30 }, comment: "One row." });
});

test("the folder: a file's name is its table, a name kept for Mason or Postgres is refused, and no folder holds none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-files-"));
  try {
    assert.deepEqual(readGenerated(path.join(dir, "mason"), dir), { definitions: [], refused: [] });
    const at = path.join(dir, "mason", GENERATED_DIR);
    fs.mkdirSync(at, { recursive: true });
    const good = "kind: scheduled\ntarget_lag: 5m\nsql: SELECT 1 AS a\n";
    for (const name of ["reports.daily.yml", "plain.yml", "plain.yaml", "pg_stats.yml", "a.b.c.yml"]) fs.writeFileSync(path.join(at, name), good);
    fs.writeFileSync(path.join(at, "README.md"), "not a table");
    const read = readGenerated(path.join(dir, "mason"), dir);
    assert.deepEqual(read.definitions.map((d) => d.name), ["public.plain", "reports.daily"]);
    assert.deepEqual(read.refused.map((r) => r.name).sort(), ["a.b.c", "public.pg_stats", "public.plain"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("order_by is one clause over the table's columns, and the sql goes in as a tree", async () => {
  const s = await definitionStatement("SELECT 1 AS a -- a comment", "a DESC");
  assert.ok("text" in s);
  assert.equal(s.text.replace(/\s+/g, " "), "SELECT * FROM ( SELECT 1 AS a ) AS __mason_generated ORDER BY a DESC");
  for (const bad of ["a) x, (SELECT 2", "a FOR UPDATE", "a OFFSET 1", "a; SELECT 1", ""]) {
    const r = await definitionStatement("SELECT 1 AS a", bad);
    assert.ok("refused" in r, bad);
    assert.equal(r.refused.key, "order_by", bad);
  }
});

test("target_lag is a poll's interval read alone: one grammar, worded as written", () => {
  assert.deepEqual(parseLag("5m"), { every: "5m", seconds: 300 });
  assert.deepEqual(parseLag(" 30s "), { every: "30s", seconds: 30 });
  assert.match((parseLag("2d") as { problem: string }).problem, /write 48h/);
  assert.doesNotMatch((parseLag("2d") as { problem: string }).problem, /poll/);
  assert.match((parseLag("5") as { problem: string }).problem, /not an interval/);
  assert.match((parseSync("poll 2d") as { problem: string }).problem, /write poll 48h/, "a sync's words are as they were");
});

test("mason status says each table's kind, method, lag and last run, and a refusal whole", () => {
  const base: GeneratedStatus = { table: "public.requests", file: "mason/generated_tables/requests.yml", kind: "scheduled", method: "whole", state: "current", targetLag: "1h", behindSeconds: 0, missingTarget: false, serving: true,
    lastRun: { at: "2026-10-31T00:00:00.000Z", seconds: 41, rows: 1200 }, error: null, retryAt: null, refusals: [], waitingFor: null, warnings: [] };
  const lines = generatedLines([base, { ...base, table: "reports.daily", state: "behind", behindSeconds: 720, missingTarget: false },
    { ...base, table: "public.bad", state: "refused", serving: false, lastRun: null, refusals: [{ key: "kind", message: "x", why: null, options: [], text: "f.yml: kind: x.\n  Your options:\n    - y" }] }], plain);
  assert.match(lines[0]!, /Generated tables/);
  assert.match(lines[1]!, /^ {2}requests\s+scheduled whole, target 1h, nothing behind; last re-run 41 s, 1,200 rows$/);
  assert.match(lines[2]!, /^ {2}reports\.daily\s+scheduled whole, target 1h, 12 min behind; last re-run 41 s/);
  assert.match(lines[3]!, /^ {2}bad\s+refused$/);
  assert.equal(lines[4], "    f.yml: kind: x.");
  assert.equal(lines[6], "        - y");
  assert.deepEqual(generatedLines([], plain), []);
});

test("the guide lists every key the reader takes", async () => {
  const text = await guideText("generated");
  for (const k of ["kind", "sql", "target_lag", "order_by", "comment"]) assert.match(text, new RegExp(`\\n {4}${k} +`));
  assert.match(text, /mason\/generated_tables\//);
  assert.doesNotMatch(text, /DuckDB/);
});

test("a top-level ORDER BY with no LIMIT is said, once, pointing at order_by, and refuses nothing; a column the copy leaves out says how to sync it", async () => {
  await withWorld({
    sorted: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id FROM events ORDER BY id\n",
    limited: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id FROM events ORDER BY id LIMIT 2\n",
    missing: "kind: scheduled\ntarget_lag: 1h\nsql: SELECT not_synced FROM events\n",
  }, async (w) => {
    const s = await w.until(built, "public.sorted");
    assert.deepEqual(s.refusals, []);
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0]!, /^mason\/generated_tables\/sorted\.yml: sql: .*order_by:/);
    assert.deepEqual((await w.until(built, "public.limited")).warnings, [], "a LIMIT makes the ORDER BY decide the rows");
    await w.sync.generated.review();
    assert.equal(w.logged.filter((l) => /sorted\.yml: sql: its ORDER BY/.test(l)).length, 1, "said once");
    assert.ok(generatedLines(w.sync.generated.status(), plain).some((l) => /sorted\.yml: sql: its ORDER BY/.test(l)));
    const missing = w.status("public.missing").refusals;
    refusedAt(missing, "sql", /column "not_synced" does not exist/);
    assert.ok(missing[0]!.options.some((o) => /exclude:.*sources file/.test(o)), JSON.stringify(missing));
  });
});

test("a synced table that takes a generated table's name is never written over: the generated one is let go, ledger and all", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-held-"));
  try {
    await withWorld({ counts: COUNTS }, async (w) => {
      await w.until(built);
      // `mason add counts`: the copy's swap puts the synced table at public.counts, with its ledger rows
      await w.store.writer.run("DROP TABLE public.counts");
      await w.store.writer.run("CREATE TABLE public.counts (x INTEGER)");
      await w.store.writer.run("INSERT INTO public.counts VALUES (101), (102), (103)");
      await w.store.writer.run(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.counts', 'copied', 3, 0, 1.0, now(), NULL, '[{"name":"x","type":"integer","notNull":false,"comment":null}]')`);
      await w.store.writer.run(`INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.counts', '100:100:', now(), 'off')`);
    }, { dir });
    const copy: AddedTable = { source: "public.counts", schema: "public", table: "counts", key: ["x"], columns: [{ name: "x", type: "integer", notNull: false, comment: null }], foreignKeys: [], bytes: 0, rows: 3 };
    await withWorld({}, async (w) => {
      const s = await w.until((x) => x.state === "refused");
      refusedAt(s.refusals, null, /is a table the sources file syncs/);
      assert.equal(s.serving, false, "the generated table is no longer kept");
      // a change to its old base, past its target: nothing runs over the name
      await w.store.writer.run("INSERT INTO public.events VALUES (14, 9, 'query', 'ok', '14', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
      w.sync.generated.changed("public.events");
      for (const end = Date.now() + 1_500; Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 50)); }
      assert.ok(!w.reached.includes("swapped"), "no run swapped anything in");
      assert.deepEqual(await w.rows("SELECT x FROM public.counts ORDER BY x"), [[101], [102], [103]], "the synced table's rows stay");
      assert.deepEqual(await w.rows(`SELECT count(*) FROM ${MASON_SCHEMA}.generated_tables`), [[0n]], "its ledger row is gone");
    }, { dir, again: true, tables: [copy] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a synced table that takes the name while a run is going is never written over: the run's swap looks on the writer's turn, and drops what it built", async () => {
  let take: (() => Promise<void>) | null = null;
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(built);
    const host = (w.sync.generated as unknown as { host: { added(name: string): "copied" | "adding" | "view" | null } }).host;
    const was = host.added.bind(host);
    // between the run's commit and its swap, `mason add counts` lands: the copy's swap puts the synced table at the name
    take = async () => {
      take = null;
      await w.store.writer.run("DROP TABLE public.counts");
      await w.store.writer.run("CREATE TABLE public.counts (x INTEGER)");
      await w.store.writer.run("INSERT INTO public.counts VALUES (101), (102), (103)");
      host.added = (name) => name === "public.counts" ? "copied" : was(name);
    };
    await w.store.writer.run("INSERT INTO public.events VALUES (13, 9, 'query', 'ok', '13', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    w.sync.generated.changed("public.events");
    w.reached.length = 0;
    const dropped = (): boolean => w.logged.some((l) => /public\.counts: a synced table now holds its name, so what this run built was dropped/.test(l));
    for (const end = Date.now() + 10_000; !dropped() && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
    assert.ok(w.reached.includes("committed"), "the run wrote and committed its table");
    assert.ok(dropped(), w.logged.join("\n"));
    assert.ok(!w.reached.includes("swapped"), "and never swapped it in");
    assert.deepEqual(await w.rows("SELECT x FROM public.counts ORDER BY x"), [[101], [102], [103]], "the synced table's rows stay");
    assert.deepEqual(await w.rows("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE 'counts%' AND table_name <> 'counts'"), [[0n]], "what the run built is dropped");
    // the change the run was built for is still not in the generated table: should the sources file be reverted before
    // the next review, the entry is still dirty, so a run picks it up rather than serving the rows from before it
    const entry = (w.sync.generated as unknown as { entries: Map<string, { dirtySince: number | null; taken: number | null }> }).entries.get("public.counts");
    assert.ok(entry !== undefined, "the entry is still there until the next review lets the name go");
    assert.equal(entry.taken, null, "the run's mark is released");
    assert.notEqual(entry.dirtySince, null, "and the change it took is dirty again");
  }, { onStep: (s) => s === "committed" ? take?.() : undefined });
});

test("a function stable only for its arguments' text is built over types whose text reads no setting, and refused with a way out that works otherwise", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await withWorld({
    plainjson: `${lag}sql: SELECT id, jsonb_build_object('a', tenant_id, 'k', kind) AS doc, concat(id, '-', kind) AS label FROM events\n`,
    stampjson: `${lag}sql: SELECT id, jsonb_build_object('at', started_at) AS doc FROM events\n`,
    fixedjson: `${lag}sql: SELECT id, jsonb_build_object('at', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) AS doc FROM events\n`,
  }, async (w) => {
    const plainjson = await w.until(built, "public.plainjson");
    assert.equal(plainjson.lastRun?.rows, 4);
    assert.deepEqual(await w.rows("SELECT label FROM public.plainjson ORDER BY id LIMIT 1"), [["1-query"]]);
    const stamp = await w.until((s) => s.state === "refused", "public.stampjson");
    refusedAt(stamp.refusals, "sql", /calls jsonb_build_object over timestamp with time zone, a type whose text Postgres writes by the session's settings/);
    assert.ok(stamp.refusals[0]!.options.some((o) => o.includes("to_char(t AT TIME ZONE 'UTC'")), JSON.stringify(stamp.refusals));
    // the way out it gives, written: built
    assert.equal((await w.until(built, "public.fixedjson")).lastRun?.rows, 4);
  });
});

test("after a restart, a base whose last sync is not the one the snapshot saw counts as changed, though that sync began before the snapshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-began-"));
  try {
    let hold: Promise<void> | null = null;
    let first: string | undefined;
    await withWorld({ counts: COUNTS }, async (w) => {
      first = (await w.until(built)).lastRun?.at;
      let release = (): void => undefined;
      hold = new Promise<void>((r) => { release = r; });
      w.sync.generated.changed("public.events");
      w.reached.length = 0;
      try {
        for (const end = Date.now() + 10_000; !w.reached.includes("snapshot") && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
        assert.ok(w.reached.includes("snapshot"));
        // a poll that began before the snapshot commits after it: its time is its start, before the snapshot, and its
        // mark dies with the process
        await w.store.writer.run("INSERT INTO public.events VALUES (15, 10, 'query', 'ok', '15', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
        await w.store.writer.run(`UPDATE ${MASON_SCHEMA}.poll_state SET polled_at = now() - INTERVAL 1 SECOND WHERE source = 'public.events'`);
      } finally { hold = null; release(); }
      const done = await w.until((s) => s.lastRun?.at !== first);
      first = done.lastRun?.at;
      assert.equal(done.lastRun?.rows, 2, "the run's snapshot did not hold the poll's row");
    }, { dir, onStep: (s) => s === "snapshot" ? hold ?? undefined : undefined });
    await withWorld({}, async (w) => {
      assert.ok(w.status().behindSeconds > 0, "the base's last sync is another than the snapshot saw");
      const after = await w.until((s) => s.lastRun?.at !== first);
      assert.equal(after.lastRun?.rows, 3);
    }, { dir, again: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("target_lag's floor is said at the key: Mason looks every REVIEW_MS", () => {
  assert.equal(REVIEW_MS, 5_000);
  assert.match(GENERATED_KEYS.target_lag, /every 5s/);
});

// ------------------------------------------------------------------------------------------- chains (issue 124 stage 2a)

const scheduled = (sql: string, orderBy?: string): string => `kind: scheduled\ntarget_lag: 1s\nsql: ${sql}\n${orderBy === undefined ? "" : `order_by: ${orderBy}\n`}`;
const ask = async (w: { client(): Promise<pg.Client> }, sql: string): Promise<unknown[]> => { const c = await w.client(); try { return (await c.query({ text: sql, rowMode: "array" })).rows; } finally { await c.end(); } };

test("a chain of three is built parents first, each over what its parent holds", async () => {
  await withWorld({ counts: COUNTS, totals: scheduled("SELECT count(*) AS tenants, max(requests) AS most FROM counts"), top: scheduled("SELECT tenants * 10 AS t, most FROM totals") }, async (w) => {
    await w.until(built, "public.top");
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
      // and it is built again over the parent it reads (waited for, so the world never ends with a run going)
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
