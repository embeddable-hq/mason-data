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
import * as generatedModule from "../src/duck/generated.ts";
import { REVIEW_MS, withoutValues, type GeneratedHost, type GeneratedStatus, type GeneratedStep } from "../src/duck/generated.ts";
import { definitionStatement, planDefinition, refusalText, type EngineTypes, type GeneratedRefusal } from "../src/duck/generated-plan.ts";
import { deparseSync } from "pgsql-deparser";
import { parseSql } from "../src/api/postgres/parser.ts";
import { parseLag, parseSync } from "../src/lib/table-sync.ts";
import { generatedLines } from "../src/cli/commands.ts";
import { guideText } from "../src/cli/guides.ts";
import { built, COUNTS, plain, refusedAt, served, withWorld } from "./duck-generated-world.ts";
import { DEEP_DEPTHS, deepChains } from "./deep-chains.ts";

after(() => stopParser());

test("a declared table is built, in the catalog with Postgres's names and types and its comment, and served by name", async () => {
  await withWorld({ counts: `${COUNTS}comment: Requests per tenant.\n` }, async (w) => {
    await w.until(served(w.logged));
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
    money: `${lag}sql: SELECT sum(amount) / 3 AS total FROM events\n`,
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
    for (const name of ["money", "avg"]) { assert.equal(r(name).state, "refused"); refusedAt(r(name).refusals, "sql", /column (total|mean) divides a numeric, which the engine computes as a double/); }
    assert.ok(r("money").refusals[0]!.options.some((o) => o.includes("AS double precision)")), JSON.stringify(r("money").refusals));
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
    // each run waited for to its log line (`served`), so the next run's line is the one logged after `logged.length`
    const first = await w.until(served(w.logged));
    w.write("counts", "kind: scheduled\ntarget_lag: 1s\nsql: SELECT date_trunc('day', started_at) AS day FROM events\n");
    const refused = await w.until((s) => s.state === "refused");
    assert.equal(refused.serving, true);
    await w.store.writer.run("INSERT INTO public.events VALUES (7, 5, 'query', 'ok', '7', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
    const rerun = w.logged.length;
    w.sync.generated.changed("public.events");
    const after = await w.until((s) => s.lastRun?.at !== first.lastRun?.at && served(w.logged, rerun)(s));
    assert.equal(after.lastRun?.rows, 3, "a new tenant, from the deployed SQL");
    assert.equal(after.state, "refused", "and it still says the file is refused");
    // to live from a deployed scheduled table: refused, and the table stays what it was
    w.write("counts", "kind: live\nsql: SELECT 1 AS one\n");
    const live = await w.until((s) => s.kind === "live");
    assert.equal(live.state, "refused");
    assert.equal(live.serving, true);
    const c = await w.client();
    try { assert.equal((await c.query("SELECT count(*) AS n FROM counts")).rows[0].n, "3"); } finally { await c.end(); }
    const from = w.logged.length;
    w.write("counts", COUNTS.replace("count(*) AS requests", "count(*) AS requests, min(id) AS first_id"));
    await w.until((s) => s.state !== "refused" && s.serving && s.refusals.length === 0);
    await w.until((s) => s.lastRun?.at !== after.lastRun?.at && served(w.logged, from)(s));
    const c2 = await w.client();
    try {
      assert.deepEqual((await c2.query("SELECT tenant_id, first_id FROM counts ORDER BY 1 LIMIT 1")).rows, [{ tenant_id: 1, first_id: "1" }]);
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
  const base: GeneratedStatus = { table: "public.requests", file: "mason/generated_tables/requests.yml", kind: "scheduled", method: "whole", state: "current", targetLag: "1h", behindSeconds: 0, behindSince: null, missingTarget: false, serving: true,
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

test("the guide, the rules file and the release note name the numeric forms the plan stores and refuses, and no false reason", async () => {
  const docs = { guide: (await guideText("generated")).replace(/\s+/g, " "), rules: fs.readFileSync(".claude/rules/duck-generated.md", "utf8").replace(/\s+/g, " "),
    notes: fs.readFileSync("release-notes/next.md", "utf8").replace(/\s+/g, " ") };
  for (const [doc, text] of Object.entries(docs)) {
    for (const said of [/trunc/, /mod/, /GREATEST/, /COALESCE/, /variance/i, /sqrt/, /18 decimals|past 18/, /double/, /read back from its text|survives every conversion/]) assert.match(text, said, `${doc}: ${said}`);
    assert.doesNotMatch(text, /CASE, GREATEST, COALESCE, mod or trunc over a numeric/, doc);
  }
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

test("a synced table that takes the name while a run is going is never written over: the run's swap looks on the writer's turn, and drops what it built", { skip: "quarantined: #209" }, async () => {
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
    for (const end = Date.now() + 20_000; !held && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
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

// stage 3 (issue 175): a numeric, an enum and a citext stored as the engine answers them, as a copy of the column holds them
const LEDGER_COLUMNS = [{ name: "id", type: "bigint" }, { name: "n", type: "integer" }, { name: "small", type: "smallint" }, { name: "amount", type: "numeric(12,2)" },
  { name: "big", type: "numeric" }, { name: "wide", type: "numeric(65,30)" }, { name: "mood", type: "mood", typeKind: "e" }, { name: "name", type: "citext" }].map((c) => ({ ...c, notNull: false, comment: null }));
const ledger: AddedTable = { source: "public.ledger", schema: "public", table: "ledger", key: ["id"], columns: LEDGER_COLUMNS, foreignKeys: [], bytes: 0, rows: 4 };
const LEDGER_SEED = [
  "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
  "CREATE TABLE public.ledger (id BIGINT, n INTEGER, small SMALLINT, amount DECIMAL(12,2), big DECIMAL(38,9), wide DECIMAL(38,2), mood mood, name VARCHAR)",
  "INSERT INTO public.ledger VALUES (1, 10, 1, 1.10, 12345678901234567890.123456789, 1.25, 'happy', 'Alice'), (9223372036854775806, 2147483647, 2, -2.50, -0.000000001, -0.50, 'sad', 'alice'), " +
    "(3, NULL, 3, NULL, NULL, NULL, 'ok', 'Bob'), (9223372036854775807, 2147483647, 32767, 4.00, 1.100000000, 2.00, 'sad', 'BOB')",
  `INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.ledger', 'copied', 4, 0, 1.0, now(), NULL, '${JSON.stringify(LEDGER_COLUMNS)}')`,
  `INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.ledger', '100:100:', now(), 'off')`,
];
const NUMS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, amount, big FROM ledger\norder_by: id\n";
const SUMS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT mood, sum(small) AS s2, sum(n) AS s4, sum(id) AS s8, sum(amount) AS sa, max(big) AS mb FROM ledger GROUP BY mood\n";
const KINDS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, mood, name FROM ledger\n";
/** a world over `ledger`: the base made in a first world, the tables declared in the second, `use`d there and after a restart */
async function overLedger(files: Record<string, string>, use: (w: Parameters<Parameters<typeof withWorld>[1]>[0], restarted: boolean) => Promise<void>, columns: readonly object[] = LEDGER_COLUMNS): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-numeric-"));
  try {
    await withWorld({}, async (w) => { for (const sql of LEDGER_SEED) await w.store.writer.run(sql.replace(JSON.stringify(LEDGER_COLUMNS), JSON.stringify(columns))); }, { dir });
    // served, not built (#205): `use` queries each table over the wire at once
    await withWorld(files, async (w) => { for (const name of Object.keys(files)) await w.until(served(w.logged), `public.${name}`); await use(w, false); }, { dir, again: true, tables: [{ ...ledger, columns } as AddedTable] });
    await withWorld({}, async (w) => { for (const name of Object.keys(files)) assert.ok(built(w.status(`public.${name}`))); await use(w, true); }, { dir, again: true, tables: [{ ...ledger, columns } as AddedTable] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const typed = async (w: { client(): Promise<pg.Client> }, sql: string): Promise<{ fields: Array<[string, number, number]>; rows: unknown[][] }> => {
  const c = await w.client();
  try { const r = await c.query({ text: sql, rowMode: "array" }); return { fields: r.fields.map((f) => [f.name, f.dataTypeID, f.dataTypeModifier]), rows: r.rows }; } finally { await c.end(); }
};

test("a numeric output is stored and read back exactly, across a restart: its scale's trailing zeros, its sign, a NULL, digits past a double's", async () => {
  await overLedger({ nums: NUMS }, async (w) => {
    const r = await typed(w, "SELECT id, amount, big FROM nums ORDER BY id");
    assert.deepEqual(r.fields, [["id", 20, -1], ["amount", 1700, (12 << 16) + 2 + 4], ["big", 1700, -1]]);
    assert.deepEqual(r.rows, [["1", "1.10", "12345678901234567890.123456789"], ["3", null, null], ["9223372036854775806", "-2.50", "-0.000000001"], ["9223372036854775807", "4.00", "1.100000000"]]);
    assert.deepEqual((await typed(w, "SELECT round(amount, 1) AS r FROM nums WHERE amount < 2 AND big = 12345678901234567890.123456789 ORDER BY amount DESC NULLS LAST")).rows, [["1.1"]]);
  });
});

test("the sum forms' stored types: sum(int2) and sum(int4) as bigint, sum(int8) and sum(numeric) as numeric, past bigint's range", async () => {
  await overLedger({ sums: SUMS }, async (w, restarted) => {
    const r = await typed(w, "SELECT * FROM sums ORDER BY mood");
    assert.deepEqual(r.fields.map(([n, oid]) => [n, oid]).slice(1), [["s2", 20], ["s4", 20], ["s8", 1700], ["sa", 1700], ["mb", 1700]]);
    assert.deepEqual(r.rows, [["sad", "32769", "4294967294", "18446744073709551613", "1.50", "1.100000000"], ["ok", "3", null, "3", null, null], ["happy", "1", "10", "1", "1.10", "12345678901234567890.123456789"]]);
    if (restarted) return;
    const stored = await w.rows("SELECT column_name, data_type FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = 'sums' AND column_name <> 'mood' ORDER BY column_index");
    assert.deepEqual(stored, [["s2", "BIGINT"], ["s4", "BIGINT"], ["s8", "HUGEINT"], ["sa", "DECIMAL(38,2)"], ["mb", "DECIMAL(38,9)"]]);
  });
});

test("an enum and a citext are stored and read back: the enum's declared order and type, the citext's case-blind equality", async () => {
  await overLedger({ kinds: KINDS }, async (w) => {
    const r = await typed(w, "SELECT id, mood, name FROM kinds ORDER BY mood, id");
    const oids = (await typed(w, "SELECT 'mood'::regtype::oid::int, 'citext'::regtype::oid::int")).rows[0];
    assert.deepEqual([r.fields[1]![1], r.fields[2]![1]], oids, "the catalog's own types");
    assert.deepEqual(r.rows.map((x) => x[1]), ["sad", "sad", "ok", "happy"], "the declared order, not the alphabet's");
    assert.deepEqual((await typed(w, "SELECT count(*) FROM kinds WHERE mood = 'sad'")).rows, [["2"]]);
    assert.deepEqual((await typed(w, "SELECT id FROM kinds WHERE name = 'ALICE' ORDER BY id")).rows, [["1"], ["9223372036854775806"]]);
  });
});

// review round 1 of PR 202 (docs/the PR's "Review round"): ONE source of an enum's labels, the synced table's
test("a value added to a base's enum is the synced table's at once, whatever a generated table built before it stored, which answers as a stale table", async () => {
  await overLedger({ kinds: KINDS }, async (w, restarted) => {
    if (restarted) return;
    // as a re-copy after ALTER TYPE mood ADD VALUE 'meh' BEFORE 'ok' leaves it: the synced ENUM with the new label, and a row of it
    await w.store.writer.run("CREATE OR REPLACE TABLE public.ledger AS SELECT id, n, small, amount, big, wide, CAST(CAST(mood AS VARCHAR) AS ENUM('sad', 'meh', 'ok', 'happy')) AS mood, name FROM public.ledger");
    await w.store.writer.run("INSERT INTO public.ledger VALUES (7, 1, 1, 1.00, 1.000000000, 1.00, 'meh', 'Mia')");
    await (w.sync as unknown as { rebuildSchema(): Promise<void> }).rebuildSchema();
    const stored = await w.rows("SELECT data_type FROM duckdb_columns() WHERE schema_name = 'public' AND table_name = 'kinds' AND column_name = 'mood'");
    assert.doesNotMatch(String(stored[0]![0]), /meh/, "the generated table holds the ENUM it was built with: declared after the synced table, it does not decide the labels");
    assert.deepEqual((await typed(w, "SELECT count(*) FROM ledger WHERE mood = 'meh'")).rows, [["1"]]);
    assert.deepEqual((await typed(w, "SELECT 'meh'::mood AS m")).rows, [["meh"]]);
    assert.deepEqual((await typed(w, "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'mood'::regtype ORDER BY enumsortorder")).rows, [["sad"], ["meh"], ["ok"], ["happy"]]);
    assert.deepEqual((await typed(w, "SELECT id FROM kinds WHERE mood = 'meh'")).rows, [], "stale, as Postgres over a table built before the change");
    assert.deepEqual((await typed(w, "SELECT mood FROM kinds ORDER BY mood, id")).rows.map((x) => x[0]), ["sad", "sad", "ok", "happy"]);
  });
});

const COMPUTED = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, -amount AS neg, amount + 1 AS plus, abs(amount) AS size, amount::numeric(10,3) AS widened FROM ledger\norder_by: id\n";
const TOTALS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT sum(amount) * 2 AS twice, round(sum(amount), 1) AS r, floor(sum(amount)) AS f, round(sum(wide), 2) AS w FROM ledger\n";

test("a numeric whose scale the types fix is stored with Postgres's digits: negated, added to, multiplied, rounded, cast to a typmod", async () => {
  await overLedger({ computed: COMPUTED, totals: TOTALS }, async (w) => {
    const r = await typed(w, "SELECT * FROM computed ORDER BY id");
    assert.deepEqual(r.fields.map(([n, oid, mod]) => [n, oid, n === "widened" ? mod : null]), [["id", 20, null], ["neg", 1700, null], ["plus", 1700, null], ["size", 1700, null], ["widened", 1700, (10 << 16) + 3 + 4]]);
    assert.deepEqual(r.rows, [["1", "-1.10", "2.10", "1.10", "1.100"], ["3", null, null, null, null], ["9223372036854775806", "2.50", "-1.50", "2.50", "-2.500"], ["9223372036854775807", "-4.00", "5.00", "4.00", "4.000"]]);
    assert.deepEqual((await typed(w, "SELECT * FROM totals")).rows, [["5.20", "2.6", "2", "2.75"]]);
  });
});

test("a numeric the types don't fix is refused with its own reason: a division, a variance, a scale past 18, a scale the rows or a picked value decide, a double's", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  const refusedFiles: Record<string, string> = {
    mean: "SELECT avg(n) AS mean FROM ledger",
    wide: "SELECT sum(wide) AS total FROM ledger",
    texts: "SELECT sum((payload ->> 'a')::numeric) AS total FROM events",
    larger: "SELECT greatest(amount, 1) AS top FROM ledger",
    spread: "SELECT stddev(amount) AS sd FROM ledger",
    varied: "SELECT variance(amount) AS v FROM ledger",
    // review round 2, finding 2: an integer's scale is 0, never "unknown", so the 30 decimals are seen
    idwide: "SELECT sum(id) + sum(wide) AS a FROM ledger",
    bigwide: "SELECT sum(big) + sum(wide) AS b FROM ledger",
    timeswide: "SELECT sum(wide) * sum(id) AS m FROM ledger",
    negwide: "SELECT -sum(wide) AS n FROM ledger",
    floated: "SELECT sum(n::float8)::numeric AS d FROM ledger",
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, sql] of Object.entries(refusedFiles)) w.write(name, `${lag}sql: ${sql}\n`);
    w.write("mixed", `${lag}sql: SELECT sum(amount) + sum(big) AS combined FROM ledger\n`);
    w.write("spreadout", `${lag}sql: SELECT stddev(amount)::double precision AS sd FROM ledger\n`);
    w.write("picked", `${lag}sql: SELECT round(sum(id) + sum(wide), 2) AS a, greatest(sum(amount), 1)::numeric(12,2) AS g FROM ledger\n`);
    // each file read and planned, under load too: a review already in flight when they were written may not have read them
    for (const name of Object.keys(refusedFiles)) await w.until((s) => s.state === "refused", `public.${name}`);
    const r = (name: string): GeneratedStatus => w.status(`public.${name}`);
    const says = (name: string, message: RegExp, option: string): void => {
      refusedAt(r(name).refusals, "sql", message);
      assert.ok(r(name).refusals[0]!.options.some((o) => o.includes(option)), `${name}: ${JSON.stringify(r(name).refusals)}`);
    };
    says("mean", /^column mean divides a numeric, which the engine computes as a double$/, "CAST(avg(n) AS double precision) AS mean");
    says("wide", /^column total has 30 decimals, more than the 18 a stored numeric keeps$/, "round(");
    says("texts", /^column total sums values Postgres keeps at differing scales, so the rows decide its decimals$/, "sum(CAST(payload ->> 'a' AS numeric(20, 4))) AS total");
    says("larger", /^column top is whichever value a GREATEST, LEAST, COALESCE or CASE takes, at that value's own decimals, and its values have differing ones$/, "CAST(GREATEST(amount, 1) AS numeric(38, 2)) AS top");
    says("spread", /^column sd is a stddev, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double$/, "CAST(stddev(amount) AS double precision) AS sd");
    says("varied", /^column v is a variance, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double/, "CAST(variance(amount) AS double precision) AS v");
    for (const [name, col] of [["idwide", "a"], ["bigwide", "b"], ["timeswide", "m"], ["negwide", "n"]]) says(name!, new RegExp(`^column ${col} has 30 decimals, more than the 18`), "round(");
    says("floated", /^column d is a numeric cast from a double precision value/, "store the double it is: sum(n::float8) AS d");
    for (const name of Object.keys(refusedFiles)) assert.doesNotMatch(JSON.stringify(r(name).refusals), name === "mean" ? /no fixed scale|can't store exactly yet/ : /no fixed scale|can't store exactly yet|divides a numeric/, name);
    // each refusal's way out is stored: a sum of an unconstrained numeric's synced column is one cell at the scale its
    // DECIMAL holds; a stddev as a double; the 30 decimals rounded; a picked value given one scale (#205: `served`, not `built`)
    for (const name of ["mixed", "spreadout", "picked"]) await w.until(served(w.logged), `public.${name}`);
    assert.deepEqual((await typed(w, "SELECT combined FROM mixed")).rows, [["12345678901234567893.823456788"]]);
    assert.equal((await typed(w, "SELECT sd FROM spreadout")).fields[0]![1], 701);
    assert.deepEqual((await typed(w, "SELECT a, g FROM picked")).rows, [["18446744073709551619.75", "2.60"]]);
  });
});

// review round 2 of PR 202, finding 1: a numeric Postgres types from integers, under any function, is stored from the
// engine type DuckDB says it computes (a sum of int8 is a HUGEINT, whose floor is a double's), never an assumed one
const INTEGRAL = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT floor(sum(id)) AS f, ceil(sum(id)) AS c, floor(sum(id) + sum(n)) AS fn, abs(-sum(id)) AS a, " +
  "round(sum(id), -1) AS r, sum(id) * 2 AS m, mod(sum(id), 10) AS md, trunc(sum(id), -2) AS t, greatest(sum(id), 1) AS g FROM ledger\n";

test("an integer Postgres types as numeric is stored with its digits under any function: floor, ceil, abs, round, mod, trunc, greatest of sum(int8)", async () => {
  await overLedger({ integral: INTEGRAL }, async (w) => {
    const r = await typed(w, "SELECT * FROM integral");
    assert.deepEqual(r.fields.map(([, oid]) => oid), Array(9).fill(1700));
    assert.deepEqual(r.rows, [["18446744073709551617", "18446744073709551617", "18446744078004518921", "18446744073709551617", "18446744073709551620",
      "36893488147419103234", "7", "18446744073709551600", "18446744073709551617"]]);
  });
});

// review round 2 of PR 202, finding 3: each form stored, or refused for its own reason (the PR's "Review round 2" table)
const FORMS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, round(amount * 10, -1) AS r1, round(amount, -1) AS r0, trunc(amount, 1) AS t, trunc(amount * 10, -1) AS t1, " +
  "amount::numeric(40,2) AS w, mod(amount, 3) AS md, coalesce(amount, 0.00) AS co, greatest(amount, 1.00) AS g, CASE WHEN amount > 0 THEN amount ELSE 0.00 END AS k, " +
  "greatest(amount, 1)::numeric(12,2) AS gc, -amount * n AS mi FROM ledger\norder_by: id\n";
const AGGREGATES = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT min(amount) AS lo, max(amount) AS hi, sum(amount) AS s, round(sum(amount), 5) AS r5, round(max(big), 4) AS rb FROM ledger\n";

test("each numeric form whose scale the types fix is stored with Postgres's digits: round to tens, trunc, mod, a typmod past 38, COALESCE, GREATEST, CASE of one scale", async () => {
  await overLedger({ forms: FORMS, aggregates: AGGREGATES }, async (w) => {
    const r = await typed(w, "SELECT * FROM forms ORDER BY id");
    assert.equal(r.fields.find(([n]) => n === "w")![2], (40 << 16) + 2 + 4, "numeric(40,2) on the wire");
    assert.deepEqual(r.rows.map((x) => x.slice(1)), [
      ["10", "0", "1.1", "10", "1.10", "1.10", "1.10", "1.10", "1.10", "1.10", "-11.00"],
      [null, null, null, null, null, null, "0.00", "1.00", "0.00", "1.00", null],
      ["-30", "0", "-2.5", "-20", "-2.50", "-2.50", "-2.50", "1.00", "0.00", "1.00", "5368709117.50"],
      ["40", "0", "4.0", "40", "4.00", "1.00", "4.00", "4.00", "4.00", "4.00", "-8589934588.00"],
    ]);
    assert.deepEqual((await typed(w, "SELECT * FROM aggregates")).rows, [["-2.50", "4.00", "2.60", "2.60000", "12345678901234567890.1235"]]);
  });
});

// review round 3 of PR 202, F3: a made type's OID, as a REAL run spells it. The source's catalog read gives an oid as a
// STRING (Postgres's JSON writes only the int, float and numeric types as numbers), and a field carries the SOURCE's OID
// for a made type, which the catalog's pg_type does not have: the enum and the citext were refused by type in a real run
const SOURCE_OIDS = LEDGER_COLUMNS.map((c) => c.name === "mood" ? { ...c, typeOid: "5974240", typeArrayOid: "5974239" } : c.name === "name" ? { ...c, typeOid: "5974250", typeArrayOid: "5974249" } : c);

test("an enum and a citext over a source's own type OIDs, spelled as the source's JSON spells them, are stored, not refused by type", async () => {
  await overLedger({ kinds: KINDS }, async (w) => {
    assert.deepEqual(w.status("public.kinds").refusals, []);
    const r = await typed(w, "SELECT id, mood, name FROM kinds ORDER BY mood, id");
    assert.deepEqual([r.fields[1]![1], r.fields[2]![1]], [5974240, 5974250], "the source's OIDs on the wire, as a synced column sends");
    assert.deepEqual(r.rows.map((x) => x[1]), ["sad", "sad", "ok", "happy"], "the declared order");
    assert.deepEqual((await typed(w, "SELECT id FROM kinds WHERE name = 'ALICE' ORDER BY id")).rows, [["1"], ["9223372036854775806"]]);
  }, SOURCE_OIDS);
});

// review round 3 of PR 202, F1: a numeric the engine answers itself (no exact program, "as the engine answers it") is
// held to the engine type DuckDB says it computes: a DECIMAL stored, an integer stored as HUGEINT, a double refused
test("a numeric the engine answers itself is held to its engine type: a variance it computes as a double is refused, a sign is stored as HUGEINT", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ signs: `${lag}sql: SELECT id, sign(amount) AS s FROM ledger\norder_by: id\n` }, async (w, restarted) => {
    const r = await typed(w, "SELECT id, s FROM signs ORDER BY id");
    assert.deepEqual(r.fields.map(([, oid]) => oid), [20, 1700]);
    assert.deepEqual(r.rows.map((x) => x[1]), ["1", null, "-1", "1"]);
    if (restarted) return;
    assert.deepEqual(await w.rows("SELECT data_type FROM duckdb_columns() WHERE table_name = 'signs' AND column_name = 's'"), [["HUGEINT"]]);
    w.write("sb", `${lag}sql: SELECT stddev(big) AS sb FROM ledger\n`);
    w.write("vw", `${lag}sql: SELECT variance(wide) AS vw FROM ledger\n`);
    for (const name of ["sb", "vw"]) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const [name, col] of [["sb", "sb"], ["vw", "vw"]] as const) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", new RegExp(`^column ${col} is a (stddev|variance), which Postgres computes as an exact numeric at decimals it picks`));
      assert.ok(refusals[0]!.options.some((o) => o.includes("AS double precision) AS")), JSON.stringify(refusals));
    }
  });
});

// review round 3 of PR 202, F2: each refusal says its true reason. A sqrt, exp, ln or power is computed by the catalog's
// Postgres at decimals it picks per value, never "a double"; one an outer round fixes says what still stands in the way;
// a JSON number's sum an outer round fixes is held at 36 decimals on the way, never "the rows decide its decimals"
test("a numeric's refusal says its true reason: sqrt, exp, ln and power pick their decimals per value; a round over them, or over a JSON number's sum, says what still stands", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  const files: Record<string, [string, RegExp]> = {
    root: ["SELECT sqrt(abs(amount)) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    squared: ["SELECT power(amount, 2) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    squaredsum: ["SELECT power(sum(id), 2) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    grown: ["SELECT exp(amount) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    logged: ["SELECT ln(abs(amount)) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    rootround: ["SELECT round(sqrt(abs(amount)), 4) AS x FROM ledger", /^column x rounds or casts a numeric Postgres computes for each row at decimals it picks/],
    sdround: ["SELECT round(stddev(amount), 2) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/],
    textround: ["SELECT round(sum((payload ->> 'a')::numeric), 2) AS x FROM events", /^column x is computed at 36 decimals on the way to its own, more than the 18/],
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(files)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const [name, [, message]] of Object.entries(files)) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", message);
      assert.doesNotMatch(JSON.stringify(refusals), /holds as a double|sync the value as a numeric|rows decide/, name);
    }
  });
});

// review round 3 of PR 202, F4: a numeric past the 38 digits a stored numeric holds, at the write, is a failure that names
// its cause and its way out, run again on the back-off (a change to the rows can bring it back within them), never a
// DuckDB message alone
test("a numeric that overflows the stored numeric at the write fails naming its cause and its way out, on the back-off", async () => {
  await overLedger({ nums: NUMS }, async (w, restarted) => {
    if (restarted) return;
    w.write("squares", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT sum(big) * sum(big) AS sq FROM ledger\n");
    await w.until((s) => s.state === "failed", "public.squares");
    const s = w.status("public.squares");
    assert.deepEqual(s.refusals, [], "data-dependent: a failure, not a refusal of the definition");
    assert.match(s.error ?? "", /^numeric field overflow \(SQLSTATE 22003\)\. The value has more than the 38 digits .* cast it to double precision if it need not be exact/);
    assert.ok(s.retryAt !== null, "run again on the back-off");
  });
});

// review round 4 of PR 202, finding 1: the run's connection is a session's, set up by the ONE set-up (src/duck/store.ts
// `SessionSetup`). Every Mason function reads `__mason_session` (its first argument), and answered NULL on a connection
// without it: a JSON number's cast stored NULL in every row, with no error. `current_setting` reads `__mason_settings`,
// which a generated table has no session to give: refused by its plan ("it reads a session")
test("a generated table's run reads the session variables as a session does: a JSON number's cast, sum and round are stored, a session setting is refused", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({
    bytenant: `${lag}sql: SELECT tenant_id, sum((payload ->> 'a')::numeric(20,4)) AS x FROM events GROUP BY tenant_id\norder_by: tenant_id\n`,
    jsontotal: `${lag}sql: SELECT sum((payload ->> 'a')::numeric(20,4)) AS x, round(sum((payload ->> 'a')::numeric(20,4)), 2) AS r FROM events\n`,
    jsoncast: `${lag}sql: SELECT id, (payload ->> 'a')::numeric(20,4) AS x, ((payload ->> 'a')::numeric)::numeric(20,4) AS y, (payload ->> 'a')::int AS i FROM events\norder_by: id\n`,
  }, async (w, restarted) => {
    assert.deepEqual((await typed(w, "SELECT tenant_id, x FROM bytenant ORDER BY tenant_id")).rows, [[1, "1.0000"], [2, "2.0000"]]);
    assert.deepEqual((await typed(w, "SELECT x, r FROM jsontotal")).rows, [["3.0000", "3.00"]]);
    assert.deepEqual((await typed(w, "SELECT id, x, y, i FROM jsoncast ORDER BY id")).rows,
      [["1", "1.0000", "1.0000", 1], ["2", null, null, null], ["3", "2.0000", "2.0000", 2], ["4", null, null, null]]);
    if (restarted) return;
    w.write("setting", `${lag}sql: SELECT id, current_setting('TimeZone') AS z FROM events\n`);
    await w.until((s) => s.state === "refused", "public.setting");
    refusedAt(w.status("public.setting").refusals, "sql", /^it reads a session/);
  });
});

// review round 4 of PR 202, finding 2: a refusal's reason and way out come from the FORM that was seen, carried with it,
// never from a type several forms share: every reason against every form that reaches it, and each way out stored
test("a numeric's refusal is said from its form: a JSON number's text, the variance family in one wording, sqrt and its round; each way out is stored", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  const files: Record<string, [string, RegExp, string]> = {
    jsonbare: ["SELECT id, (payload ->> 'a')::numeric AS x FROM events", /^column x is a numeric read from text \(a JSON number's ->> cast to numeric\), which keeps the decimals each value's text has/, "CAST(payload ->> 'a' AS numeric(20, 4)) AS x"],
    jsonround: ["SELECT round((payload ->> 'a')::numeric, 2) AS x FROM events", /^column x is a numeric read from text/, "round(CAST(payload ->> 'a' AS numeric(20, 4)), 2) AS x"],
    var1: ["SELECT variance(amount) AS x FROM ledger", /^column x is a variance, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double/, "CAST(variance(amount) AS double precision) AS x"],
    var2: ["SELECT stddev(n) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/, "CAST(stddev(n) AS double precision) AS x"],
    var3: ["SELECT stddev(big) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/, "CAST(stddev(big) AS double precision) AS x"],
    var4: ["SELECT round(stddev(amount), 2) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/, "CAST(round(stddev(amount), 2) AS double precision) AS x"],
    root: ["SELECT sqrt(abs(amount)) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value \(sqrt\)/, "CAST(sqrt(abs(amount)) AS double precision) AS x"],
    rootround: ["SELECT round(sqrt(abs(amount)), 4) AS x FROM ledger", /^column x rounds or casts a numeric Postgres computes for each row at decimals it picks \(sqrt\)/, "CAST(round(sqrt(abs(amount)), 4) AS double precision) AS x"],
  };
  // each way out, written over the same columns: stored
  const ways: Record<string, string> = {
    wayjson: "SELECT id, (payload ->> 'a')::numeric(20,4) AS x FROM events",
    wayvar: "SELECT variance(amount)::double precision AS x, stddev(n)::double precision AS y, stddev(big)::double precision AS z FROM ledger",
    wayroot: "SELECT sqrt(abs(amount))::double precision AS x FROM ledger",
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(files)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const [name, sql] of Object.entries(ways)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const [name, [, message, way]] of Object.entries(files)) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", message);
      assert.equal(refusals.length, 1, name);
      assert.ok(refusals[0]!.options.some((o) => o.includes(way)), `${name}: ${JSON.stringify(refusals[0]!.options)}`);
      if (!name.startsWith("root")) assert.doesNotMatch(refusals[0]!.message + refusals[0]!.options.join(), /sqrt/, name);
      if (name.startsWith("var")) assert.doesNotMatch(refusals[0]!.message, /picks by the size of each value \(/, name);
    }
    for (const name of Object.keys(ways)) await w.until(served(w.logged), `public.${name}`);
    assert.deepEqual((await typed(w, "SELECT id, x FROM wayjson ORDER BY id")).rows, [["1", "1.0000"], ["2", null], ["3", "2.0000"], ["4", null]]);
    assert.deepEqual((await typed(w, "SELECT x FROM wayroot")).fields.map(([, oid]) => oid), [701]);
    assert.deepEqual((await typed(w, "SELECT x, y, z FROM wayvar")).fields.map(([, oid]) => oid), [701, 701, 701]);
  });
});

// review round 4 of PR 202, finding 3: what a run's failure records names nothing of the engine: every DECIMAL overflow
// spelling DuckDB gives is said in the user's words, and no hidden column's name (`__mason_cell_0`) reaches the record
test("a run's failure says a cast's overflow in the user's words, and no recorded failure carries an engine name", async () => {
  const spellings = [
    'Conversion Error: Casting value "12345678901234567890.123456789" to type DECIMAL(5,2) failed: value is out of range! when casting from source column __mason_cell_0',
    "Out of Range Error: Overflow in multiplication of DECIMAL(38) (99999999999999999999999999999999999999 * 10). You might want to add an explicit cast to a decimal with a smaller scale.",
    "Out of Range Error: Overflow in ROUND of DECIMAL(38)",
    "Out of Range Error: Overflow in HUGEINT multiplication: 99999999999999999999999999999999999999 * 3",
    'Conversion Error: Could not convert string "NaN" to DECIMAL(20,4)',
    "Conversion Error: Could not cast value 1e40 to DECIMAL(38,0)",
    "Binder Error: Referenced column __mason_cell_3 not found",
    // review round 5: what is not a DECIMAL is said through the same one mapping
    "Out of Range Error: Overflow in multiplication of INT64 (9223372036854775807 * 2)!",
    "Invalid Input Error: Division by zero in expression (10 // 0). Use TRY(...) or SET error_on_division_by_zero",
    'Invalid Input Error: mason[22P02]: invalid input syntax for type integer: "abc"',
  ];
  // read through the module, so the file loads where the function is missing and this test fails by name (fails-without)
  const failureWords = (generatedModule as { failureWords?: (error: unknown) => string }).failureWords;
  assert.ok(failureWords !== undefined, "the one function a run's failure is said through");
  for (const m of spellings) {
    const said = failureWords(m);
    assert.doesNotMatch(said, /__mason_|DECIMAL|HUGEINT|INT64|Overflow in|TRY\(|mason\[|Error:|abc/, `${m} -> ${said}`);
    assert.match(said, /\(SQLSTATE [0-9A-Z]{5}\)/, `${m} -> ${said}`);
  }
  assert.match(failureWords(spellings[0]!), /^numeric field overflow \(SQLSTATE 22003\)\. A field with precision 5, scale 2 must round to an absolute value less than 10\^3\./);
  await overLedger({ nums: NUMS }, async (w, restarted) => {
    if (restarted) return;
    w.write("narrow", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT big::numeric(5,2) AS c FROM ledger\n");
    await w.until((s) => s.state === "failed", "public.narrow");
    const s = w.status("public.narrow");
    assert.match(s.error ?? "", /^numeric field overflow \(SQLSTATE 22003\)\. A field with precision 5, scale 2 must round/);
    assert.doesNotMatch(s.error ?? "", /__mason_|DECIMAL/);
    assert.ok(!w.logged.some((l) => l.includes("public.narrow") && /__mason_/.test(l)), "the log names no hidden column");
  });
});

// review round 5 of PR 202, class A: a refusal's reason and way out come from the form the walk carried up, through any
// wrapper (an operator, a coalesce, a round or trunc, a cast with a typmod, an aggregate), never from the engine type,
// the outermost node or a constant: every reason against every wrapper that reaches it, the way out naming the user's
// own function, and each way out built and stored
const VAR = (fn: string): RegExp => new RegExp(`^column x is a ${fn}, which Postgres computes as an exact numeric at decimals it picks`);
const PER = (fn: string): RegExp => new RegExp(`^column x is a numeric whose decimals Postgres picks by the size of each value \\(${fn}\\)`);
const PERFIX = (fn: string): RegExp => new RegExp(`^column x rounds or casts a numeric Postgres computes for each row at decimals it picks \\(${fn}\\)`);
const TEXT = /^column x is a numeric read from text \(a JSON number's ->> cast to numeric\)/;
const DIV = /^column x divides a numeric, which the engine computes as a double$/;
const SCALE = (n: number): RegExp => new RegExp(`^column x has ${n} decimals, more than the 18`);
const HELD = (n: number): RegExp => new RegExp(`^column x is computed at ${n} decimals on the way to its own`);
const ROWS = /^column x sums values Postgres keeps at differing scales, so the rows decide its decimals$/;
const PICKS = /^column x is whichever value a GREATEST, LEAST, COALESCE or CASE takes/;
const DOUBLE = /^column x is a numeric cast from a double precision value/;
const REASONS: Record<string, [string, RegExp, string]> = {
  // (the variance family, sqrt and its kin, and a cast from a double: round 6's table, which holds each way out whole)
  tbare: ["SELECT (payload ->> 'a')::numeric AS x FROM events", TEXT, "CAST(payload ->> 'a' AS numeric(20, 4)) AS x"],
  top: ["SELECT (payload ->> 'a')::numeric + 1 AS x FROM events", TEXT, "CAST(payload ->> 'a' AS numeric(20, 4)) + 1 AS x"],
  tco: ["SELECT coalesce((payload ->> 'a')::numeric, 0) AS x FROM events", TEXT, "COALESCE(CAST(payload ->> 'a' AS numeric(20, 4)), 0) AS x"],
  tround: ["SELECT trunc((payload ->> 'a')::numeric, 2) AS x FROM events", TEXT, "trunc(CAST(payload ->> 'a' AS numeric(20, 4)), 2) AS x"],
  tmax: ["SELECT max((payload ->> 'a')::numeric) AS x FROM events", TEXT, "max(CAST(payload ->> 'a' AS numeric(20, 4))) AS x"],
  tmin: ["SELECT min((payload ->> 'a')::numeric) AS x FROM events", TEXT, "min(CAST(payload ->> 'a' AS numeric(20, 4))) AS x"],
  tsum: ["SELECT sum((payload ->> 'a')::numeric) AS x FROM events", ROWS, "sum(CAST(payload ->> 'a' AS numeric(20, 4))) AS x"],
  dbare: ["SELECT amount / 3 AS x FROM ledger", DIV, "AS double precision)"],
  dop: ["SELECT amount / 3 + 1 AS x FROM ledger", DIV, "AS double precision)"],
  dco: ["SELECT coalesce(amount / 3, 0) AS x FROM ledger", DIV, "AS double precision)"],
  dround: ["SELECT round(amount / 3, 2) AS x FROM ledger", DIV, "AS double precision)"],
  dtyp: ["SELECT (amount / 3)::numeric(10,2) AS x FROM ledger", DIV, "AS double precision)"],
  dsum: ["SELECT sum(amount / 3) AS x FROM ledger", DIV, "AS double precision)"],
  dmax: ["SELECT max(amount / 3) AS x FROM ledger", DIV, "AS double precision)"],
  davg: ["SELECT avg(amount) AS x FROM ledger", DIV, "AS double precision)"],
  sop: ["SELECT wide + 1 AS x FROM ledger", SCALE(30), "round("],
  sco: ["SELECT coalesce(wide * 1, wide) AS x FROM ledger", SCALE(30), "round("],
  styp: ["SELECT (wide + 1)::numeric(40,20) AS x FROM ledger", SCALE(20), "round("],
  ssum: ["SELECT sum(wide) AS x FROM ledger", SCALE(30), "round("],
  rop: ["SELECT sum((payload ->> 'a')::numeric) + 1 AS x FROM events", ROWS, "AS numeric(20, 4))"],
  rco: ["SELECT coalesce(sum((payload ->> 'a')::numeric), 0) AS x FROM events", ROWS, "AS numeric(20, 4))"],
  rround: ["SELECT round(sum((payload ->> 'a')::numeric), 2) AS x FROM events", HELD(36), "AS numeric(20, 4))"],
  kbare: ["SELECT greatest(amount, 1) AS x FROM ledger", PICKS, "AS numeric(38, 2)) AS x"],
  kop: ["SELECT greatest(amount, 1) + 1 AS x FROM ledger", PICKS, "AS numeric(38, 2)) AS x"],
  kco: ["SELECT coalesce(amount, 0) AS x FROM ledger", PICKS, "AS numeric(38, 2)) AS x"],
};
// each way out, written over the same columns as the user would: stored
const WAYS_OUT: Record<string, string> = {
  wtext: "SELECT max((payload ->> 'a')::numeric(20,4)) AS x, min((payload ->> 'a')::numeric(20,4)) AS y FROM events",
  wtextop: "SELECT id, (payload ->> 'a')::numeric(20,4) + 1 AS x, coalesce((payload ->> 'a')::numeric(20,4), 0.0000) AS y FROM events",
  wdiv: "SELECT sum(amount) AS total, count(amount) AS n FROM ledger",
  wscale: "SELECT round(sum(wide), 2) AS x FROM ledger",
  wrows: "SELECT sum((payload ->> 'a')::numeric(20,4)) + 1 AS x FROM events",
  wpicks: "SELECT greatest(amount, 1)::numeric(12,2) AS x FROM ledger",
};
// every function a way out may name: one the user did not write is never named
const FUNCTIONS = ["stddev", "var_pop", "var_samp", "variance", "sqrt", "exp", "ln", "log", "power", "max", "min"];
test("round 5: every reason against every wrapper says the form's reason and a way out naming the user's own function, and each way out is stored", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(REASONS)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const [name, sql] of Object.entries(WAYS_OUT)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(REASONS)) await w.until((s) => s.state === "refused" || s.serving, `public.${name}`);
    const wrong: string[] = [];
    for (const [name, [sql, reason, way]] of Object.entries(REASONS)) {
      const refusals = w.status(`public.${name}`).refusals;
      const said = refusals.map((r) => `${r.message} | ${r.options.join(" | ")}`).join(" || ");
      const strays = FUNCTIONS.filter((f) => !sql.includes(`${f}(`) && new RegExp(`\\b${f}\\(`).test(said));
      if (refusals.length !== 1 || !reason.test(refusals[0]!.message) || !refusals[0]!.options.some((o) => o.includes(way)) || strays.length > 0
        || /engine computes as a double \(|\(…\)|holds as a double/.test(said)) wrong.push(`${name}: ${sql}\n    ${said || "(not refused)"}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    for (const name of Object.keys(WAYS_OUT)) await w.until(served(w.logged), `public.${name}`);
    assert.deepEqual((await typed(w, "SELECT x, y FROM wtext")).rows, [["2.0000", "1.0000"]]);
  });
});

// review round 5 of PR 202, class B: a run's failure is said through the ONE mapping a statement on the wire gets
// (src/duck/store.ts `pgErrorOf`): Postgres's message and SQLSTATE, never the engine's words or Mason's own marker
test("round 5: a run's failure is Postgres's error, by the wire's one mapping: an integer's overflow, a division by zero, a text that is not a number", async () => {
  const files: Record<string, [string, RegExp]> = {
    i8: ["SELECT id * 2 AS x FROM ledger", /^bigint out of range \(SQLSTATE 22003\)/],
    i4: ["SELECT n * 2 AS x FROM ledger", /^integer out of range \(SQLSTATE 22003\)/],
    zero: ["SELECT 10 / (id - 1) AS x FROM ledger", /^division by zero \(SQLSTATE 22012\)/],
    tnum: ["SELECT kind::numeric(10,3) AS x FROM events", /^invalid input syntax for type numeric: … \(SQLSTATE 22P02\)/],
    tint: ["SELECT kind::int AS x FROM events", /^invalid input syntax for type integer: … \(SQLSTATE 22P02\)/],
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(files)) w.write(name, `kind: scheduled\ntarget_lag: 1h\nsql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "failed", `public.${name}`);
    for (const [name, [, words]] of Object.entries(files)) {
      const error = w.status(`public.${name}`).error ?? "";
      assert.match(error, words, name);
      assert.doesNotMatch(error, /Overflow in|INT64|INT32|TRY\(|error_on_division|mason\[|Invalid Input|Conversion Error|DECIMAL|__mason_|query/, `${name}: ${error}`);
    }
  });
});

// review round 6 of PR 202, class A: the reason is what each node computes AS POSTGRES TYPES IT (a node over a double is a
// double, whatever its kind; a name the statement resolves only to a double-returning function is one), and the way out
// is the user's own expression with only the cast moved, every aggregate and wrapper kept: each case's reason, its way
// out exactly (compared as Postgres reads it back), and each way out written as a table and held stored (round 5's
// variance, sqrt-and-kin and double rows moved here, where the way out is held whole)
const R6: Record<string, [string, RegExp, string | null]> = {
  // a double carried up from below: whatever the node's own kind, Postgres computes a double, and the numeric is its cast
  davg: ["avg(amount::float8)::numeric", DOUBLE, "avg(amount::float8)"],
  ddiv: ["(amount::float8 / 2)::numeric", DOUBLE, "amount::float8 / 2"],
  dsqrt: ["sqrt(amount::float8)::numeric", DOUBLE, "sqrt(amount::float8)"],
  dresolved: ["sqrt(n)::numeric", DOUBLE, "sqrt(n)"],
  dstddev: ["stddev(big)::float8::numeric", DOUBLE, "stddev(big)::float8"],
  dvariance: ["variance(amount::float8)::numeric(20,4)", DOUBLE, "variance(amount::float8)"],
  dround: ["round(exp(amount::float8)::numeric, 2)", DOUBLE, "round(exp(amount::float8)::numeric, 2)::double precision"],
  dsum: ["sum(ln(abs(amount))::float8)::numeric", DOUBLE, "sum(ln(abs(amount))::float8)"],
  dgreatest: ["greatest(amount / 3, amount::float8)::numeric", DOUBLE, "greatest(amount / 3, amount::float8)"],
  dcoalesce: ["coalesce(stddev(big), max(amount)::float8)::numeric", DOUBLE, "coalesce(stddev(big), max(amount)::float8)"],
  // a count over a double is a bigint, and what divides it is an exact division (round 7: its way out, the user's own)
  dcount: ["count(amount::float8)::numeric / 3", DIV, "(count(amount::float8)::numeric / 3)::double precision"],
  // sqrt and its kin over an exact numeric: the cast on the function, the aggregate and the wrapper kept
  psum: ["sum(sqrt(abs(amount)))", PER("sqrt"), "sum(sqrt(abs(amount))::double precision)"],
  pmax: ["max(ln(abs(amount)))", PER("ln"), "max(ln(abs(amount))::double precision)"],
  psumround: ["round(sum(sqrt(abs(amount))), 2)", PERFIX("sqrt"), "round(sum(sqrt(abs(amount))), 2)::double precision"],
  pbare: ["sqrt(abs(amount))", PER("sqrt"), "sqrt(abs(amount))::double precision"],
  pexp: ["exp(amount)", PER("exp"), "exp(amount)::double precision"],
  pop: ["ln(abs(amount)) + 1", PER("ln"), "ln(abs(amount))::double precision + 1"],
  pco: ["coalesce(sqrt(abs(amount)), 0)", PER("sqrt"), "coalesce(sqrt(abs(amount))::double precision, 0)"],
  ppow: ["power(amount, 2)", PER("power"), "power(amount, 2)::double precision"],
  plog: ["log(10, abs(amount))", PER("log"), "log(10, abs(amount))::double precision"],
  pround: ["round(log(abs(amount)), 2)", PERFIX("log"), "round(log(abs(amount)), 2)::double precision"],
  ptyp: ["exp(amount)::numeric(10,2)", PERFIX("exp"), "exp(amount)::double precision"],
  // the variance family over an exact numeric
  vbare: ["stddev(big)", VAR("stddev"), "stddev(big)::double precision"],
  vop: ["stddev(big) * 2", VAR("stddev"), "stddev(big)::double precision * 2"],
  vco: ["coalesce(stddev(big), 0)", VAR("stddev"), "coalesce(stddev(big)::double precision, 0)"],
  vround: ["round(stddev(big), 2)", VAR("stddev"), "round(stddev(big), 2)::double precision"],
  vtyp: ["stddev(big)::numeric(20,4)", VAR("stddev"), "stddev(big)::double precision"],
  vop2: ["var_pop(amount) + 1", VAR("var_pop"), "var_pop(amount)::double precision + 1"],
  vco2: ["coalesce(var_samp(amount), 0)", VAR("var_samp"), "coalesce(var_samp(amount)::double precision, 0)"],
  // a numeric cast from a double: the cast taken away, a round over it kept with the cast to double above it
  fbare: ["amount::float8::numeric", DOUBLE, "amount::float8"],
  fop: ["amount::float8::numeric + 1", DOUBLE, "amount::float8 + 1"],
  fco: ["coalesce(amount::float8::numeric, 0)", DOUBLE, "coalesce(amount::float8, 0)"],
  fround: ["round(amount::float8::numeric, 2)", DOUBLE, "round(amount::float8::numeric, 2)::double precision"],
  ftyp: ["amount::float8::numeric(10,2)", DOUBLE, "amount::float8"],
  fsum: ["sum(n::float8)::numeric", DOUBLE, "sum(n::float8)"],
  fmax: ["max(amount::float8::numeric)", DOUBLE, "max(amount::float8)"],
};
/** an expression as Postgres reads it back: one spelling for `::float8`, `CAST(… AS double precision)` and the rest; a
 *  text that is not SQL is itself, and so never equal to the way out */
const asRead = async (expr: string): Promise<string> => {
  try { return deparseSync((await parseSql(`SELECT ${expr} AS x`)).stmts![0]!.stmt!, { pretty: false }); }
  catch { return `not SQL: ${expr}`; }
};
test("round 6: a numeric's reason is the type each node computes as Postgres types it, and its way out is the user's own expression, aggregate kept, and stores", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(R6)) w.write(name, `${lag}sql: SELECT ${sql} AS x FROM ledger\n`);
    for (const name of Object.keys(R6)) await w.until((s) => s.state === "refused" || s.serving, `public.${name}`);
    const wrong: string[] = [];
    for (const [name, [sql, reason, way]] of Object.entries(R6)) {
      const refusals = w.status(`public.${name}`).refusals;
      const said = refusals.map((r) => `${r.message} | ${r.options.join(" | ")}`).join(" || ");
      const given = refusals[0]?.options.map((o) => /: (.+) AS x$/.exec(o)?.[1]).find((o) => o !== undefined);
      const ok = refusals.length === 1 && reason.test(refusals[0]!.message)
        && (way === null || (given !== undefined && await asRead(given) === await asRead(way)));
      if (!ok) wrong.push(`${name}: ${sql}\n    ${said || "(not refused)"}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    // each way out, as the refusal gives it: stored, as a double
    const ways = Object.entries(R6).filter(([, [, , way]]) => way !== null);
    for (const [name, [, , way]] of ways) w.write(`w${name}`, `${lag}sql: SELECT ${way} AS x FROM ledger\n`);
    for (const [name] of ways) await w.until(served(w.logged), `public.w${name}`);
    for (const [name] of ways) assert.deepEqual((await typed(w, `SELECT x FROM w${name}`)).fields.map(([, oid]) => oid), [701], name);
  });
});

// review round 6 of PR 202, class B: a numeric field overflow is ONE wording, Postgres's message and DETAIL, whichever path
// raises it: the engine's DECIMAL cast, and a Mason function's error carried as mason[22003]
test("round 6: a numeric field overflow says Postgres's DETAIL on every path: the engine's cast, and a cast a Mason function computes", async () => {
  const words = /^numeric field overflow \(SQLSTATE 22003\)\. A field with precision 10, scale 3 must round to an absolute value less than 10\^7\. Give the value/;
  const files: Record<string, string> = {
    oengine: "SELECT (id::text || '00000000000')::numeric(10,3) AS x FROM ledger",
    ofunction: "SELECT (id::text || '00000000000')::numeric(10,3)::double precision AS x FROM ledger",
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, sql] of Object.entries(files)) w.write(name, `kind: scheduled\ntarget_lag: 1h\nsql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "failed", `public.${name}`);
    for (const name of Object.keys(files)) assert.match(w.status(`public.${name}`).error ?? "", words, name);
  });
});

// review round 7 of PR 202, class A: the walk follows a column's value wherever the analysis says it comes from (a scalar
// sublink's subselect, a CTE's query, each arm of a set operation, a subquery in FROM under any node), and a way out never
// names the output column as if its source had it: the column's own expression with the cast moved, or the query of the
// statement the cast belongs in, named in the user's words and given whole. Class B: the text, divides and picks forms,
// and the rows over a text form, give the user's own expression too, never a placeholder; a numeric read from text says
// what the analysis typed the text as. Each case: the reason, every option exactly, and each way out built and stored
const DBL = "store it as a double if it need not be exact: ", ORDBL = `or ${DBL}`;
const AT_READ = "or compute it in the statement that reads the synced table";
const DIV_READ = "or store what it divides, and divide in the statement that reads the table";
const ONE = "give it one scale: ";
const TEXT_DOUBLE = /^column x is a numeric read from text \(the text of a double precision value, cast to numeric\), which keeps the decimals each value's text has$/;
const TEXT_TEXT = /^column x is a numeric read from text \(a text value cast to numeric\), which keeps the decimals each value's text has$/;
const TEXT_JSON = /^column x is a numeric read from text \(a JSON number's ->> cast to numeric\), which keeps the decimals each value's text has$/;
// [the definition, its reason, its options exactly, the statements its ways out describe where they are not the column's
// own expression (`SELECT <way> AS x FROM <its table>` otherwise)]
const R7: Record<string, [string, RegExp, [string, string], string[]?]> = {
  asub: ["SELECT (SELECT stddev(big) FROM ledger) AS x FROM ledger", VAR("stddev"),
    [`${DBL}(SELECT CAST(stddev(big) AS double precision) FROM ledger) AS x`, AT_READ]],
  anested: ["SELECT (SELECT (SELECT stddev(big) FROM ledger) FROM ledger LIMIT 1) AS x FROM ledger", VAR("stddev"),
    [`${DBL}(SELECT (SELECT CAST(stddev(big) AS double precision) FROM ledger) FROM ledger LIMIT 1) AS x`, AT_READ]],
  acte: ["WITH t AS (SELECT sqrt(abs(amount)) AS v FROM ledger) SELECT sum(v) AS x FROM t", PER("sqrt"),
    [`${DBL}write the WITH query t as SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger`, AT_READ],
    ["WITH t AS (SELECT sqrt(abs(amount))::double precision AS v FROM ledger) SELECT sum(v) AS x FROM t"]],
  avar: ["WITH t AS (SELECT stddev(big) AS v FROM ledger) SELECT v AS x FROM t", VAR("stddev"),
    [`${DBL}write the WITH query t as SELECT CAST(stddev(big) AS double precision) AS v FROM ledger`, AT_READ],
    ["WITH t AS (SELECT stddev(big)::double precision AS v FROM ledger) SELECT v AS x FROM t"]],
  avarround: ["WITH t AS (SELECT var_samp(amount) AS v FROM ledger) SELECT round(v, 2) AS x FROM t", VAR("var_samp"),
    [`${DBL}CAST(round(v, 2) AS double precision) AS x`, AT_READ],
    ["WITH t AS (SELECT var_samp(amount) AS v FROM ledger) SELECT round(v, 2)::double precision AS x FROM t"]],
  afrom: ["SELECT sum(v) AS x FROM (SELECT sqrt(abs(amount)) AS v FROM ledger) AS s", PER("sqrt"),
    [`${DBL}write the subquery s as SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger`, AT_READ],
    ["SELECT sum(v) AS x FROM (SELECT sqrt(abs(amount))::double precision AS v FROM ledger) AS s"]],
  aunion: ["SELECT sqrt(abs(amount)) AS x FROM ledger UNION ALL SELECT amount FROM ledger", PER("sqrt"),
    [`${DBL}write the UNION ALL as SELECT CAST(sqrt(abs(amount)) AS double precision) AS x FROM ledger UNION ALL SELECT amount FROM ledger`, AT_READ],
    ["SELECT sqrt(abs(amount))::double precision AS x FROM ledger UNION ALL SELECT amount FROM ledger"]],
  ajson: ["SELECT (payload ->> 'a')::numeric AS x FROM events UNION ALL SELECT (payload ->> 'b')::numeric FROM events", TEXT_JSON,
    [`${ONE}write the UNION ALL as SELECT CAST(payload ->> 'a' AS numeric(20, 4)) AS x FROM events UNION ALL SELECT CAST(payload ->> 'b' AS numeric(20, 4)) FROM events`,
      `${ORDBL}write the UNION ALL as SELECT CAST(payload ->> 'a' AS double precision) AS x FROM events UNION ALL SELECT CAST(payload ->> 'b' AS double precision) FROM events`],
    ["SELECT (payload ->> 'a')::numeric(20,4) AS x FROM events UNION ALL SELECT (payload ->> 'b')::numeric(20,4) FROM events",
      "SELECT (payload ->> 'a')::double precision AS x FROM events UNION ALL SELECT (payload ->> 'b')::double precision FROM events"]],
  tjson: ["SELECT (payload ->> 'a')::numeric + 1 AS x FROM events", TEXT_JSON,
    [`${ONE}CAST(payload ->> 'a' AS numeric(20, 4)) + 1 AS x`, `${ORDBL}CAST(payload ->> 'a' AS double precision) + 1 AS x`]],
  tjsonmax: ["SELECT max((payload ->> 'a')::numeric) AS x FROM events", TEXT_JSON,
    [`${ONE}max(CAST(payload ->> 'a' AS numeric(20, 4))) AS x`, `${ORDBL}max(CAST(payload ->> 'a' AS double precision)) AS x`]],
  // a double the statement computes keeps its form through the text (round 12); a stored double's text is a text's
  tdouble: ["SELECT (amount::float8::numeric)::text::numeric AS x FROM ledger", DOUBLE,
    ["store the double it is: CAST(CAST(CAST(amount::float8 AS numeric) AS text) AS double precision) AS x", AT_READ]],
  tdoublestored: ["SELECT ('1.5'::float8)::text::numeric AS x FROM ledger", TEXT_DOUBLE,
    [`${ONE}CAST(CAST('1.5'::float8 AS text) AS numeric(20, 4)) AS x`, `${ORDBL}CAST(CAST('1.5'::float8 AS text) AS double precision) AS x`]],
  ttext: ["SELECT n::numeric AS x FROM events", TEXT_TEXT,
    [`${ONE}CAST(n AS numeric(20, 4)) AS x`, `${ORDBL}CAST(n AS double precision) AS x`]],
  rjson: ["SELECT sum((payload ->> 'a')::numeric) AS x FROM events", ROWS,
    ["give the values one scale first: sum(CAST(payload ->> 'a' AS numeric(20, 4))) AS x", `${ORDBL}sum(CAST(payload ->> 'a' AS double precision)) AS x`]],
  djson: ["SELECT avg((payload ->> 'a')::numeric) AS x FROM events", DIV,
    [`${DBL}CAST(avg(CAST(payload ->> 'a' AS numeric)) AS double precision) AS x`, DIV_READ]],
  dbare: ["SELECT amount / 3 AS x FROM ledger", DIV, [`${DBL}CAST(amount / 3 AS double precision) AS x`, DIV_READ]],
  dround: ["SELECT round(avg(amount), 2) AS x FROM ledger", DIV, [`${DBL}CAST(round(avg(amount), 2) AS double precision) AS x`, DIV_READ]],
  kbare: ["SELECT greatest(amount, 1) + 1 AS x FROM ledger", PICKS,
    [`${ONE}CAST(GREATEST(amount, 1) + 1 AS numeric(38, 2)) AS x`, `${ORDBL}CAST(GREATEST(amount, 1) + 1 AS double precision) AS x`]],
  kjson: ["SELECT coalesce((payload ->> 'a')::numeric(20,4), 0) AS x FROM events", PICKS,
    [`${ONE}CAST(COALESCE(CAST(payload ->> 'a' AS numeric(20, 4)), 0) AS numeric(38, 4)) AS x`, `${ORDBL}CAST(COALESCE(CAST(payload ->> 'a' AS numeric(20, 4)), 0) AS double precision) AS x`]],
};
test("round 7: the walk follows a sublink, a CTE, a set operation's arms and a subquery, and every form's way out is the user's own expression, and stores", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  // each way out as a statement: the ones given, else the column's own expression over the definition's table
  const builds = Object.entries(R7).flatMap(([name, [sql, , options, given]]) => (given ?? options.flatMap((o) => {
    const way = /: (.+ AS x)$/.exec(o)?.[1];
    return way === undefined ? [] : [`SELECT ${way} FROM ${/FROM (\w+)$/.exec(sql)![1]}`];
  })).map((b, i) => [`w${name}${i}`, b] as const));
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(R7)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(R7)) await w.until((s) => s.state === "refused" || s.serving, `public.${name}`);
    const wrong: string[] = [];
    for (const [name, [sql, reason, options]] of Object.entries(R7)) {
      const refusals = w.status(`public.${name}`).refusals;
      const said = refusals.map((r) => `${r.message}\n      ${r.options.join("\n      ")}`).join(" || ");
      if (refusals.length !== 1 || !reason.test(refusals[0]!.message) || JSON.stringify(refusals[0]!.options) !== JSON.stringify(options)) wrong.push(`${name}: ${sql}\n    ${said || "(not refused)"}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    // one at a time: 26 files written at once once left a run "stuck inside the engine" (#224), and one at a time is faster
    for (const [name, sql] of builds) { w.write(name, `${lag}sql: ${sql}\n`); await w.until(served(w.logged), `public.${name}`); }
    for (const [name, sql] of builds) assert.deepEqual((await typed(w, `SELECT x FROM ${name}`)).fields.map(([, oid]) => oid), [/double precision/.test(sql) ? 701 : 1700], `${name}: ${sql}`);
  });
});

// review round 8 of PR 202: a definition that crashed the review instead of reaching a verdict. A UNION ALL whose arm
// reads a CTE built a program whose arms had different column counts, the engine threw, the review threw and ran again
// for ever, and the table stayed `building` with no reason. The class: no definition leaves the review without a verdict
const R8_CTE_UNION = "WITH t AS (SELECT sqrt(abs(amount)) AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT sqrt(abs(amount)) FROM ledger";
test("round 8: a numeric over a UNION ALL arm that reads a CTE reaches a verdict, refused by its own reason, never left building", async () => {
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    w.write("cteunion", `kind: scheduled\ntarget_lag: 1h\nsql: ${R8_CTE_UNION}\n`);
    w.write("cteplain", "kind: scheduled\ntarget_lag: 1h\nsql: WITH t AS (SELECT amount AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT amount FROM ledger\n");
    const s = await w.until((x) => x.state === "refused" || x.serving, "public.cteunion");
    assert.equal(s.refusals.length, 1, JSON.stringify(s.refusals));
    assert.match(s.refusals[0]!.message, PER("sqrt"));
    assert.deepEqual(s.refusals[0]!.options, [`${DBL}write the WITH query t as SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger; and write the UNION ALL as ` +
      "WITH t AS (SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT CAST(sqrt(abs(amount)) AS double precision) FROM ledger", AT_READ]);
    assert.ok(!w.logged.some((l) => /review failed/.test(l)), w.logged.join("\n"));
    // the statement on the wire, whose plan the definition's is: every arm as wide as the others
    assert.equal((await typed(w, R8_CTE_UNION)).rows.length, 8);
    await w.until(served(w.logged), "public.cteplain");
    assert.deepEqual((await typed(w, "SELECT x FROM cteplain ORDER BY x")).rows, [["-2.50"], ["-2.50"], ["1.10"], ["1.10"], ["4.00"], ["4.00"], [null], [null]]);
    // its way out is built and stored as a double
    w.write("cteway", "kind: scheduled\ntarget_lag: 1h\nsql: WITH t AS (SELECT CAST(sqrt(abs(amount)) AS double precision) AS v FROM ledger) SELECT v AS x FROM t UNION ALL SELECT CAST(sqrt(abs(amount)) AS double precision) FROM ledger\n");
    await w.until(served(w.logged), "public.cteway");
    const way = await typed(w, "SELECT x FROM cteway WHERE x = 2 ORDER BY x");
    assert.deepEqual([way.fields.map(([, oid]) => oid), way.rows], [[701], [[2], [2]]]);
  });
});

test("round 8: a definition whose check throws unexpectedly is refused in readable words, and the other tables of the review are still built", async () => {
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    const real = w.api.planner();
    const planner: typeof real = { ...real, plan: (text, stmt, relations) => /boom/.test(text) ? Promise.reject(new Error("Binder Error: something the engine said")) : real.plan(text, stmt, relations) };
    // the throwing table first in the review, so a review that stops at it never reaches the other
    w.write("aboom", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id AS boom FROM ledger\n");
    w.write("zfine", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id FROM ledger\n");
    await w.sync.generated.start(() => readGenerated(w.folder, w.dir), planner);
    const s = await w.until((x) => x.state === "refused" || x.serving, "public.aboom");
    assert.equal(s.state, "refused");
    assert.equal(s.refusals.length, 1, JSON.stringify(s.refusals));
    const r = s.refusals[0]!;
    assert.doesNotMatch(`${r.message} ${r.why ?? ""} ${r.options.join(" ")}`, /Binder|engine|duck/i);
    assert.match(r.message, /Mason could not check/);
    assert.ok(r.options.length > 0);
    await w.until(served(w.logged), "public.zfine");
    assert.equal(w.status("public.zfine").refusals.length, 0);
  });
});

// review round 11 of PR 202: a stddev under a typmod cast was stored from the engine's double, because storing read
// whether the rewrite made a program (PR 207's `programNeeded`, which makes none for `stddev(x)::numeric(p,s)`) where the
// analysis said "a variance". The class: one fact with two authorities. The decision: storing reads the analysis alone,
// so every node it says the engine computes as a double, bare, under a bare `::numeric` and under a typmod, over an input
// with a typmod and without, is refused by round 6's reason, whatever the rewrite made of it (no exact program carries any)
type R11Node = { fn: string; agg: boolean; sql: (x: string) => string; reason: (column: string, fixed: boolean) => RegExp };
const R11_VARIANCE = (fn: string): R11Node => ({ fn, agg: true, sql: (x) => `${fn}(${x})`,
  reason: (c) => new RegExp(`^column ${c} is a ${fn}, which Postgres computes as an exact numeric at decimals it picks`) });
const R11_DIVIDES = (fn: string, agg: boolean, sql: (x: string) => string): R11Node => ({ fn, agg, sql,
  reason: (c) => new RegExp(`^column ${c} divides a numeric, which the engine computes as a double$`) });
const R11_PER_VALUE = (fn: string, sql: (x: string) => string): R11Node => ({ fn, agg: false, sql,
  reason: (c, fixed) => fixed ? new RegExp(`^column ${c} rounds or casts a numeric Postgres computes for each row at decimals it picks \\(${fn}\\)`)
    : new RegExp(`^column ${c} is a numeric whose decimals Postgres picks by the size of each value \\(${fn}\\)`) });
const R11_NODES: R11Node[] = [
  ...["stddev", "stddev_samp", "stddev_pop", "variance", "var_samp", "var_pop"].map(R11_VARIANCE),
  R11_DIVIDES("avg", true, (x) => `avg(${x})`), R11_DIVIDES("quotient", false, (x) => `${x} / 3`),
  R11_PER_VALUE("sqrt", (x) => `sqrt(abs(${x}))`), R11_PER_VALUE("exp", (x) => `exp(${x})`), R11_PER_VALUE("ln", (x) => `ln(abs(${x}))`),
  R11_PER_VALUE("log", (x) => `log(abs(${x}))`), R11_PER_VALUE("power", (x) => `power(${x}, 2)`),
];
/** each input: `amount numeric(12,2)`, `big numeric` and `wide numeric(65,30)`, and the typmod a cast gives it */
const R11_INPUTS: Record<string, string> = { amount: "numeric(20,4)", big: "numeric(20,4)", wide: "numeric(38,20)" };
const R11_WRAPPERS: Record<string, (e: string, typmod: string) => string> = { bare: (e) => e, cast: (e) => `(${e})::numeric`, typmod: (e, t) => `(${e})::${t}` };
test("round 11: every node the analysis says the engine computes as a double is refused by its form's reason, under any cast, over any input's typmod", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  // a table per wrapper, input and kind (an aggregate and a value per row can't share a SELECT), a column per node
  const tables: Array<{ name: string; wrapper: string; input: string; nodes: R11Node[] }> = [];
  for (const wrapper of Object.keys(R11_WRAPPERS)) for (const input of Object.keys(R11_INPUTS)) for (const agg of [true, false]) {
    tables.push({ name: `r11_${wrapper}_${input}_${agg ? "agg" : "row"}`, wrapper, input, nodes: R11_NODES.filter((n) => n.agg === agg) });
  }
  const written = (t: (typeof tables)[number], n: R11Node): string => R11_WRAPPERS[t.wrapper]!(n.sql(t.input), R11_INPUTS[t.input]!);
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const t of tables) w.write(t.name, `${lag}sql: SELECT ${t.nodes.map((n) => `${written(t, n)} AS x_${n.fn}`).join(", ")} FROM ledger\n`);
    for (const t of tables) await w.until((s) => s.state === "refused" || s.state === "failed" || s.serving, `public.${t.name}`);
    const wrong: string[] = [];
    let cases = 0;
    for (const t of tables) {
      const s = w.status(`public.${t.name}`);
      for (const n of t.nodes) {
        cases++;
        const column = `x_${n.fn}`, said = s.refusals.filter((r) => r.message.startsWith(`column ${column} `));
        if (said.length !== 1 || !n.reason(column, t.wrapper === "typmod").test(said[0]!.message)) {
          wrong.push(`${written(t, n)}: ${said.map((r) => r.message).join(" || ") || `not refused (${s.state}${typeof s.error === "string" ? `: ${s.error}` : ""})`}`);
        }
      }
    }
    assert.equal(cases, 117, "13 nodes x 3 wrappers x 3 inputs");
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
  });
});

// review round 12 of PR 202: a cast through text stored the engine's double under a numeric's name.
// `((stddev(wide))::text)::numeric(38,18)` was stored as 1.282900359861721000 where Postgres has …721035, because the walk
// made every text read as a numeric "a text" and threw the form beneath it away, and a typmod over that text was "no
// form", so storing fell back to the engine type. The class is round 11's: the analysis is the authority, and its form
// forgot the node at a text boundary. The decision: a value's form survives every conversion, so a text read as a numeric
// keeps the form of what the text was made from, through every spelling of the text step. Each node the engine computes
// as a double, over an input with a typmod and without, inside the text bare, under `::numeric` and under a typmod, read
// back by a typmod (and, bare, by a bare `::numeric`), is refused by its node's reason, and its way out stores a double
type R12Node = { fn: string; agg: boolean; sql: (x: string) => string; reason: (column: string, fixed: boolean) => RegExp };
const R12_DOUBLE: R12Node = { fn: "float8", agg: false, sql: (x) => `${x}::float8`, reason: (c) => new RegExp(`^column ${c} is a numeric cast from a double precision value`) };
const R12_NODES: R12Node[] = [
  ...R11_NODES.filter((n) => n.agg),
  R11_DIVIDES("sum3", true, (x) => `sum(${x}) / 3`), { ...R11_PER_VALUE("sqrt", (x) => `sqrt(abs(sum(${x})))`), agg: true, fn: "sqrtsum" },
  R11_DIVIDES("quotient", false, (x) => `${x} / 3`), R11_PER_VALUE("sqrt", (x) => `sqrt(abs(${x}))`), R11_PER_VALUE("exp", (x) => `exp(${x})`),
  R11_PER_VALUE("ln", (x) => `ln(abs(${x}) + 1)`), R11_PER_VALUE("log", (x) => `log(abs(${x}) + 1)`), R11_PER_VALUE("power", (x) => `power(${x}, 2)`), R12_DOUBLE,
];
/** each spelling of the text step, over a value `e`; a WITH column's is its CTE's (`with`) */
const R12_SPELLINGS: Record<string, (e: string) => string> = {
  text: (e) => `(${e})::text`, varchar: (e) => `(${e})::varchar`, varchar40: (e) => `(${e})::varchar(40)`,
  concat: (e) => `((${e})::text || '')`, json: (e) => `(jsonb_build_object('s', ${e}) ->> 's')`, with: (e) => `(${e})::text`,
};
const R12_INPUTS: Record<string, string> = { amount: "numeric(20,4)", wide: "numeric(38,20)" };
/** inside the text: the node bare, under `::numeric`, under a typmod; then read back by `::numeric(38,18)`, or (`r`) the
 *  node bare read back by a bare `::numeric` */
const R12_WRAPPERS: Record<string, { inner: (e: string, typmod: string) => string; read: string; fixed: boolean }> = {
  b: { inner: (e) => e, read: "numeric(38,18)", fixed: true }, n: { inner: (e) => `(${e})::numeric`, read: "numeric(38,18)", fixed: true },
  t: { inner: (e, t) => `(${e})::${t}`, read: "numeric(38,18)", fixed: true }, r: { inner: (e) => e, read: "numeric", fixed: false },
};
test("round 12: a text read as a numeric keeps the form of what it was made from: every node the engine computes as a double, by every spelling of the text step, is refused by its node's reason, and its way out stores", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  type Column = { name: string; node: R12Node; fixed: boolean; text: string; read: string };
  const tables: Array<{ name: string; spelling: string; columns: Column[] }> = [];
  for (const spelling of Object.keys(R12_SPELLINGS)) for (const agg of [true, false]) {
    const columns: Column[] = [];
    for (const input of Object.keys(R12_INPUTS)) for (const [w, wrap] of Object.entries(R12_WRAPPERS)) {
      R12_NODES.filter((n) => n.agg === agg).forEach((node, i) => {
        const text = R12_SPELLINGS[spelling]!(wrap.inner(node.sql(input), R12_INPUTS[input]!));
        columns.push({ name: `c_${input}_${w}_${node.fn}_${i}`, node, fixed: wrap.fixed, text, read: wrap.read });
      });
    }
    tables.push({ name: `r12_${spelling}_${agg ? "agg" : "row"}`, spelling, columns });
  }
  // a WITH column: the text in the WITH query, read back in the outer one
  const statement = (t: (typeof tables)[number], select: (c: Column, i: number) => string): string => t.spelling === "with"
    ? `WITH t AS (SELECT ${t.columns.map((c, i) => `${c.text} AS v${i}`).join(", ")} FROM ledger) SELECT ${t.columns.map(select).join(", ")} FROM t`
    : `SELECT ${t.columns.map(select).join(", ")} FROM ledger`;
  const read = (t: (typeof tables)[number]) => (c: Column, i: number): string => `(${t.spelling === "with" ? `v${i}` : c.text})::${c.read} AS ${c.name}`;
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const t of tables) w.write(t.name, `${lag}sql: ${statement(t, read(t))}\n`);
    // the controls: a stored numeric column's text and a JSON number's text, each under a typmod, are stored (round 7)
    w.write("r12_column", `${lag}sql: SELECT id, amount::text::numeric(20,4) AS a, amount::varchar::numeric(20,4) AS b FROM ledger\n`);
    w.write("r12_json", `${lag}sql: SELECT id, (payload ->> 'a')::numeric(20,4) AS j FROM events\n`);
    w.write("r12_jsonbare", `${lag}sql: SELECT (payload ->> 'a')::numeric AS x FROM events\n`);
    for (const t of tables) await w.until((s) => s.state === "refused" || s.state === "failed" || s.serving, `public.${t.name}`);
    const wrong: string[] = [], ways = new Map<string, string[]>();
    let cases = 0;
    for (const t of tables) {
      const s = w.status(`public.${t.name}`), built: string[] = [];
      t.columns.forEach((c, i) => {
        cases++;
        const said = s.refusals.filter((r) => r.message.startsWith(`column ${c.name} `));
        const way = said[0]?.options.map((o) => new RegExp(`(?:double if it need not be exact|store the double it is): (.+ AS ${c.name})$`).exec(o)?.[1]).find((o) => o !== undefined);
        if (said.length !== 1 || !c.node.reason(c.name, c.fixed).test(said[0]!.message) || way === undefined) {
          wrong.push(`${read(t)(c, i)}: ${said.map((r) => `${r.message} | ${r.options.join(" | ")}`).join(" || ") || `not refused (${s.state}${typeof s.error === "string" ? `: ${s.error}` : ""})`}`);
        } else built.push(way);
      });
      ways.set(t.name, built);
    }
    assert.equal(cases, 6 * 2 * 4 * R12_NODES.length, "6 spellings x 2 inputs x 4 wrappers x every node");
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
    const bare = await w.until((s) => s.state === "refused" || s.serving, "public.r12_jsonbare");
    assert.match(bare.refusals[0]?.message ?? "", TEXT_JSON);
    await w.until(served(w.logged), "public.r12_column");
    await w.until(served(w.logged), "public.r12_json");
    assert.deepEqual((await typed(w, "SELECT a, b FROM r12_column ORDER BY id")).rows, [["1.1000", "1.1000"], [null, null], ["-2.5000", "-2.5000"], ["4.0000", "4.0000"]]);
    assert.deepEqual((await typed(w, "SELECT j FROM r12_json WHERE j IS NOT NULL ORDER BY j LIMIT 1")).fields.map(([, oid]) => oid), [1700]);
    // each way out, as the refusals give it: a table per definition, every column stored as a double
    for (const t of tables) {
      const given = ways.get(t.name)!;
      w.write(`w${t.name}`, `${lag}sql: ${statement(t, (_c, i) => given[i]!)}\n`);
      await w.until(served(w.logged), `public.w${t.name}`);
      const fields = (await typed(w, `SELECT * FROM w${t.name}`)).fields.map(([, oid]) => oid);
      assert.deepEqual(fields, t.columns.map(() => 701), `w${t.name}: ${given.join(", ")}`);
    }
  });
});

// review round 13 of PR 202: the review's check ran its settle and its prepare on the RUN'S connection, unserialised with
// a build that holds that connection in a transaction across awaits (its snapshot, its writer's turn, its steps), so a
// check landed inside the build's transaction and between its statements; CI's stream test stalled, and a reviewer's
// unit world stuck in the engine from `SessionSetup.settle` under `GeneratedTables.check` (#224's class). The decision:
// the check has a connection of its own, so nothing a review asks reaches the connection a run holds
test("round 13: a check while a run holds its transaction open never touches the run's connection, and gives its verdict", async () => {
  let hold: Promise<void> | null = null;
  await withWorld({ counts: COUNTS }, async (w) => {
    const first = await w.until(built);
    let release = (): void => undefined;
    hold = new Promise<void>((r) => { release = r; });
    try {
      w.reached.length = 0;
      await w.store.writer.run("INSERT INTO public.events VALUES (11, 7, 'query', 'ok', '11', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
      w.sync.generated.changed("public.events");
      await w.sync.generated.review();
      for (const end = Date.now() + 10_000; !w.reached.includes("snapshot") && Date.now() < end;) { await new Promise((r) => setTimeout(r, 10)); await w.sync.generated.review(); }
      assert.ok(w.reached.includes("snapshot"), "the run holds its transaction open at its snapshot");
      // every call on the run's connection from here until the release is the check's, since the run is held
      const run = (w.sync as unknown as { generatedLane: { conn: Record<string, unknown> } }).generatedLane.conn;
      const touched: string[] = [];
      for (const m of ["run", "runAndReadAll", "prepare"]) {
        const f = run[m] as (...a: unknown[]) => unknown;
        run[m] = (...a: unknown[]) => { touched.push(`${m}: ${String(a[0]).slice(0, 60)}`); return f.apply(run, a); };
      }
      try {
        w.write("checked", scheduled("SELECT kind, count(*) AS n FROM events GROUP BY kind"));
        w.write("wrong", scheduled("SELECT nope FROM events"));
        // bounded: a check stuck behind the run is a failure here, never a hang
        let bound: NodeJS.Timeout | undefined;
        const said = await Promise.race([w.sync.generated.review().then(() => "reviewed"), new Promise((r) => { bound = setTimeout(() => r("stuck"), 20_000); })]);
        clearTimeout(bound);
        assert.equal(said, "reviewed");
        assert.equal(w.status("public.wrong").state, "refused", JSON.stringify(w.status("public.wrong")));
        assert.deepEqual(w.status("public.checked").refusals, []);
        assert.deepEqual(touched, [], "the check reached the run's connection");
      } finally { for (const m of ["run", "runAndReadAll", "prepare"]) delete run[m]; }
    } finally { hold = null; release(); }
    await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
    await w.until(built, "public.checked");
  }, { onStep: (s, n) => s === "snapshot" && n === "public.counts" ? hold ?? undefined : undefined });
});

// review round 14 of PR 202: the walk of a column's analysed expression copied, into each column reference, the whole
// followed expression of the column it reads, so a statement whose levels each read the level below more than once grew
// 3^depth (depth 12 took 880 ms, 16 about 70 s), on the wire's plan of every statement and in a definition's check. The
// decision: the walk is linear in the analysed tree (a reference shares what it reads, each node's form and each text's
// making are found once), and only the generated planner asks for it. Each shape at depth 16 reaches its verdict within
// the bound: an int8 stored; a text read as a numeric at the top refused by the form the text was made from, sqrt's, met
// at the bottom of every path; and with no form below, every path walked to the bottom, refused as a text. (A numeric
// carried through every level grows in the rewrite's exact program, as on main: a finding of its own, not this walk's)
type R14Case = { bottom: string; op: string; top: (chain: string) => string; verdict: RegExp | null };
const R14_CASES: R14Case[] = [
  { bottom: "1::int8", op: "+", top: (c) => c, verdict: null },
  { bottom: "sqrt(2::numeric)::text", op: "||", top: (c) => `SELECT a::numeric AS a FROM (${c}) top`, verdict: /^column a is a numeric whose decimals Postgres picks by the size of each value \(sqrt\)/ },
  { bottom: "'1'::text", op: "||", top: (c) => `SELECT a::numeric AS a FROM (${c}) top`, verdict: /^column a is a numeric read from text \(a text value cast to numeric\), which keeps the decimals each value's text has/ },
];
test("round 14: a definition whose every level reads the level below three times is checked within the bound, nested, as a WITH chain and as a UNION ALL chain", async () => {
  await withWorld({}, async (w) => {
    const planner = w.api.planner();
    // the review's own check: its connection, set up, and the engine's types as DuckDB prepares the plan's SQL there
    // (src/duck/generated.ts `review`, `engineTypes`)
    const host = (w.sync.generated as unknown as { host: GeneratedHost }).host;
    const describe = async (sql: string): Promise<EngineTypes> => {
      const p = await host.checkConnection().prepare(sql);
      try { return new Map(Array.from({ length: p.columnCount }, (_, i) => { const type = p.columnType(i).toString(); return [[p.columnName(i), type], [`#${i}`, type]] as const; }).flat()); }
      finally { p.destroySync(); }
    };
    const check = async (sql: string) => { await host.settleCheck(); return planDefinition(planner, sql, null, undefined, describe); };
    // a first check pays the planner's start (the catalog, the parser): untimed
    assert.ok("definition" in await check("SELECT 1::numeric AS a"));
    for (const c of R14_CASES) for (const depth of DEEP_DEPTHS) for (const [shape, chain] of Object.entries(deepChains(c.bottom, depth, c.op))) {
      const sql = c.top(chain), started = performance.now();
      const r = await check(sql);
      const ms = performance.now() - started, at = `${shape} over ${c.bottom} at depth ${depth}`;
      assert.ok(ms < 500, `${at}: checked in ${ms.toFixed(0)} ms`);
      if (c.verdict === null) assert.ok("definition" in r, `${at}: ${JSON.stringify("refused" in r ? r.refused : null)}`);
      else {
        assert.ok("refused" in r, `${at}: stored`);
        assert.deepEqual(r.refused.map((x) => c.verdict!.test(x.message)), [true], `${at}: ${JSON.stringify(r.refused)}`);
        assert.ok(r.refused[0]!.options.length > 0, `${at}: no way out`);
      }
    }
  });
});
