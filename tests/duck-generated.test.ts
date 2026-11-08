/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: the runs, the swap, the
 * refusals, the file, the folder and the guide. Each test runs its own world (tests/duck-generated-world.ts). What
 * Postgres answers from the same SQL is tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type pg from "pg";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import { GENERATED_DIR, GENERATED_KEYS, parseGeneratedText, readGenerated } from "../src/cli/generated-files.ts";
import type { AddedTable, CopyState } from "../src/duck/sync.ts";
import { REVIEW_MS, withoutValues, type GeneratedStatus, type GeneratedStep } from "../src/duck/generated.ts";
import { definitionStatement, refusalText, type GeneratedRefusal, type Planner } from "../src/duck/generated-plan.ts";
import { generatedReadiness } from "../src/cli/readiness.ts";
import { parseLag, parseSync } from "../src/lib/table-sync.ts";
import { generatedLines } from "../src/cli/commands.ts";
import { guideText } from "../src/cli/guides.ts";
import { BUILD_BOUND_MS, built, COUNTS, plain, refusedAt, served, withWorld, type World } from "./duck-generated-world.ts";

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
      for (const end = Date.now() + BUILD_BOUND_MS; !w.reached.includes("committed") && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
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
    ties: `${lag}sql: SELECT id FROM events ORDER BY tenant_id FETCH FIRST 1 ROWS WITH TIES\n`,
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
    refusedAt(r("ties").refusals, "sql", /ends in FETCH … WITH TIES/);
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
    for (const end = Date.now() + BUILD_BOUND_MS; w.sync.generated.status().length > 0 && Date.now() < end;) {
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
    for (const end = Date.now() + BUILD_BOUND_MS; !w.reached.includes("snapshot") && Date.now() < end;) { await new Promise((r) => setTimeout(r, 10)); await w.sync.generated.review(); }
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
  refusedAt(refused("kind: scheduled\ntarget_lag: 2d\nsql: SELECT 1 AS a\n"), "target_lag", /over the longest interval, 24h: write 24h/);
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
  assert.match((parseLag("2d") as { problem: string }).problem, /over the longest interval, 24h: write 24h/);
  assert.doesNotMatch((parseLag("2d") as { problem: string }).problem, /poll/);
  assert.match((parseLag("5") as { problem: string }).problem, /5 has no unit: write 5s/);
  assert.match((parseSync("poll 2d") as { problem: string }).problem, /write poll 24h/, "a sync's words are as they were");
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
    notes: fs.readFileSync("release-notes/v0.9.0.md", "utf8").replace(/\s+/g, " ") };
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
    for (const end = Date.now() + BUILD_BOUND_MS; !dropped() && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
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

test("target_lag's floor is said at the key: Mason looks every REVIEW_MS", () => {
  assert.equal(REVIEW_MS, 5_000);
  assert.match(GENERATED_KEYS.target_lag, /every 5s/);
});

// ISSUE 387: A BASE IS THERE WHEN THE CATALOG HOLDS IT. The copy records a table `copied` before the catalog is rebuilt
// over it (the rebuild reads that record, and waits behind any other), and a check's plan can be made over a catalog
// older than the host's answer read after it (the demo's start: the check began before orders was synced, its plan
// waited for the catalog Postgres to start without it, and came back with 42P01 once orders was synced and in the
// catalog). Either way the definition was refused, `mason wait` exited 1, and the refusal was said at `mason start`.
const LATE_COLUMNS = [["id", "integer"], ["total", "numeric(10,2)"], ["created_at", "timestamp with time zone"], ["status", "text"]].map(([name, type]) => ({ name: name!, type: type!, notNull: false, comment: null }));
const late: AddedTable = { source: "public.late", schema: "public", table: "late", key: ["id"], columns: LATE_COLUMNS, foreignKeys: [], bytes: 0, rows: 5 };
const LATE_ROWS = "(1, 10.50, '2026-01-01 10:00:00+00', 'paid'), (2, 5.25, '2026-01-01 23:30:00+00', 'paid'), (3, 7.00, '2026-01-01 12:00:00+00', NULL), (4, 1.00, '2026-01-02 00:30:00+00', 'paid'), (5, NULL, NULL, 'refunded')";
const LATE_DDL = "CREATE TABLE public.late (id INTEGER, total DECIMAL(10,2), created_at TIMESTAMPTZ, status VARCHAR)";
const LATE_DAILY = "kind: scheduled\ntarget_lag: 30s\nsql: SELECT (created_at AT TIME ZONE 'UTC')::date AS day, status, count(*) AS orders, sum(total) AS revenue FROM late GROUP BY 1, 2\norder_by: day, status\n";
/** the groups Postgres gives LATE_DAILY over LATE_ROWS: (01-01, paid), (01-01, NULL), (01-02, paid), (NULL, refunded) */
const LATE_GROUPS = 4;

type SyncInside = { tables: Map<string, AddedTable>; schemaBuild: Promise<void>; record(s: CopyState, columns: unknown[]): Promise<void>; rebuildSchema(): Promise<void> };
/**
 * A table's copy landing as the copy's success path lands it (src/duck/sync.ts, after the swap): its rows in the engine,
 * the table added, its record `copied`, then the catalog rebuilt — behind a rebuild held until the function returned is
 * called when `hold`, as one chained behind another is. Resolves to: let the rebuild go, and wait for it.
 */
async function lands(w: World, t: AddedTable, ddl: string, rows: string, hold: boolean): Promise<() => Promise<void>> {
  const sync = w.sync as unknown as SyncInside;
  let release = (): void => undefined;
  if (hold) { const held = new Promise<void>((r) => { release = r; }); sync.schemaBuild = sync.schemaBuild.then(() => held); }
  await w.store.writer.run(`CREATE SCHEMA IF NOT EXISTS ${t.schema}`);
  await w.store.writer.run(ddl);
  await w.store.writer.run(`INSERT INTO ${t.source} VALUES ${rows}`);
  sync.tables.set(t.source, t);
  await sync.record({ source: t.source, phase: "copied", rows: t.rows, bytes: 0, seconds: 0.1, copiedAt: new Date().toISOString(), error: null }, t.columns);
  const rebuilt = sync.rebuildSchema();
  return async () => { release(); await rebuilt; };
}

/**
 * ISSUE 482: WHERE A BUILD'S TIME GOES, said in CI's spec log by the test's t.diagnostic, from which BUILD_BOUND_MS is
 * read again. Each table's LAST run, by the run's own steps (`onStep`), its start being `committed` less
 * `lastRun.seconds` (what build() times, from its first line to its COMMIT): start to snapshot is the planning,
 * host.settle() and the writer's turn; snapshot to written the CREATE TABLE AS; written to committed the COMMIT;
 * committed to swapped the swap's turn on the writer. With `watch()`, every plan through the listener's planner (a
 * review's checks and a run's own) is timed, and every rebuild of the catalog counted: a run's "plan" is its last plan
 * call inside start..snapshot, "wait" what came before that call, and the rest of the span host.settle() and the
 * writer's turn. Times are ms after `start()` (the release of what the tables wait for), a table's first serving as the
 * loop saw it. It measures; it decides nothing a test asserts.
 */
class BuildClock {
  private readonly steps = new Map<string, Partial<Record<GeneratedStep, number>>>();
  private readonly runs = new Map<string, number>();
  private readonly serving = new Map<string, number>();
  private readonly plans: Array<[number, number]> = [];
  private readonly rebuilds: number[] = [];
  private from = Date.now();
  private reviews = 0;
  private reviewMs = 0;
  private reviewMax = 0;
  /** withWorld's onStep, composed with a test's own by calling both */
  readonly onStep = (s: GeneratedStep, n: string): void => {
    if (s === "snapshot") { this.steps.set(n, {}); this.runs.set(n, (this.runs.get(n) ?? 0) + 1); }
    const m = this.steps.get(n);
    if (m !== undefined) m[s] = Date.now();
  };
  /** every plan the generated tables make through the listener's planner, timed (wrapping the planner they hold), and
   *  every rebuild of the catalog asked, counted (wrapping the sync's, which the run's and the copy's call) */
  watch(w: World): void {
    const g = w.sync.generated as unknown as { planner: Planner };
    const planner = g.planner;
    g.planner = { ...planner, plan: async (text, stmt, relations) => {
      const at = Date.now();
      try { return await planner.plan(text, stmt, relations); } finally { this.plans.push([at, Date.now()]); }
    } };
    const sync = w.sync as unknown as SyncInside;
    const rebuild = sync.rebuildSchema.bind(sync);
    sync.rebuildSchema = () => { this.rebuilds.push(Date.now()); return rebuild(); };
  }
  start(): void { this.from = Date.now(); this.serving.clear(); this.reviews = 0; this.reviewMs = 0; this.reviewMax = 0; }
  /** one review, timed, and what serves after it */
  async review(w: World, names: readonly string[]): Promise<void> {
    const at = Date.now();
    await w.sync.generated.review();
    const ms = Date.now() - at;
    this.reviews++; this.reviewMs += ms; this.reviewMax = Math.max(this.reviewMax, ms);
    this.saw(w, names);
  }
  saw(w: World, names: readonly string[]): void {
    const now = Date.now();
    for (const n of names) if (!this.serving.has(n) && w.status(n).serving) this.serving.set(n, now);
  }
  line(w: World, label: string, names: readonly string[]): string {
    this.saw(w, names);
    const after = (x: number | undefined): string => { if (x === undefined) return "?"; const d = Math.round(x - this.from); return d < 0 ? String(d) : `+${d}`; };
    const span = (a: number | undefined, b: number | undefined): string => a === undefined || b === undefined ? "?" : String(Math.round(b - a));
    const each = names.map((n) => {
      const secs = w.status(n).lastRun?.seconds, m = this.steps.get(n) ?? {};
      const start = m.committed !== undefined && secs !== undefined ? m.committed - secs * 1000 : undefined;
      const own = start === undefined || m.snapshot === undefined ? undefined : this.plans.filter(([a, b]) => a >= start - 1 && b <= m.snapshot!).at(-1);
      const before = own === undefined ? `plan+settle+writer ${span(start, m.snapshot)}` : `wait ${span(start, own[0])}, plan ${span(own[0], own[1])}, settle+writer ${span(own[1], m.snapshot)}`;
      return `${n.replace(/^public\./, "")}: run ${secs === undefined ? "?" : secs.toFixed(2)} s x${this.runs.get(n) ?? 0} ` +
        `[start ${after(start)}, ${before}, write ${span(m.snapshot, m.written)}, commit ${span(m.written, m.committed)}, swap ${span(m.committed, m.swapped)}] served ${after(this.serving.get(n))}`;
    });
    const reviews = this.reviews === 0 ? "" : `, ${this.reviews} review(s) ${this.reviewMs} ms (max ${this.reviewMax})`;
    const mine = this.plans.filter(([a]) => a >= this.from).map(([a, b]) => b - a);
    const plans = mine.length === 0 ? "" : `, ${mine.length} plan(s) ${mine.reduce((x, y) => x + y, 0)} ms (max ${Math.max(...mine)}, ${mine.filter((x) => x > 100).length} over 100 ms)`;
    const rebuilds = this.rebuilds.length === 0 ? "" : `, ${this.rebuilds.filter((x) => x >= this.from).length} catalog rebuild(s)`;
    return `issue 482 ${label}: ${Date.now() - this.from} ms of ${BUILD_BOUND_MS}${reviews}${plans}${rebuilds}; ${each.join("; ")}`;
  }
}

test("a definition over a synced table the catalog does not hold yet waits for it, never refused, then builds (the catalog holds it)", async (t) => {
  const since = Date.now();
  const clock = new BuildClock();
  await withWorld({}, async (w) => {
    clock.watch(w);
    // THE COPY'S WINDOW: public.late recorded copied, the catalog's rebuild over it held
    const release = await lands(w, late, LATE_DDL, LATE_ROWS, true);
    const said = (l: string): boolean => /late_(daily|q|join|parent|child)\.yml: (sql: relation "late" does not exist|no longer refused)/.test(l);
    const waiting = ["public.late_daily", "public.late_q", "public.late_join", "public.late_parent"];
    try {
      assert.ok(!w.sync.schema().tables.some((t) => t.name === "late"), "the catalog does not hold public.late yet");
      w.write("late_daily", LATE_DAILY);
      w.write("late_q", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT status, count(*) AS n FROM public.late GROUP BY 1\n");
      w.write("late_join", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT e.tenant_id, count(*) AS n FROM events e JOIN late l ON l.id = e.id GROUP BY 1\n");
      w.write("late_parent", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT status, count(*) AS n FROM late GROUP BY 1\n");
      w.write("late_child", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT sum(n) AS total FROM late_parent\n");
      // kept as a refusal: a relation the sources file does not add is Postgres's refusal, whatever the catalog is doing
      w.write("unknown_base", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT count(*) FROM nosuch\n");
      for (let i = 0; i < 3; i++) {
        await w.sync.generated.review();
        for (const name of waiting) {
          const s = w.status(name);
          assert.deepEqual([s.state, s.waitingFor, s.refusals, s.serving], ["waiting", "public.late", [], false], `${name}: ${JSON.stringify(s)}\n${w.logged.join("\n")}`);
          const r = generatedReadiness(s, since);
          assert.deepEqual([r.ready, r.failed, r.waiting], [false, [], [`${name}: waiting for public.late`]]);
        }
        const child = w.status("public.late_child");
        assert.deepEqual([child.state, child.waitingFor, child.refusals], ["waiting", "public.late_parent", []], JSON.stringify(child));
        refusedAt(w.status("public.unknown_base").refusals, "sql", /relation "nosuch" does not exist/);
      }
      // a run is never planned over a base the catalog lacks: none began, none failed
      assert.deepEqual(w.reached, [], "no run began");
      assert.deepEqual(w.events.filter((e) => e.kind === "generated_failed"), []);
      assert.ok(!w.logged.some(said), w.logged.join("\n"));
    } finally {
      // the catalog holds it (and the sync's stop waits for the catalog's last rebuild, so a failure above lets it go too)
      clock.start();
      await release();
    }
    // each built, with no refusal at any review on the way
    const all = [...waiting, "public.late_child"];
    try {
      for (const end = Date.now() + BUILD_BOUND_MS; !all.every((n) => built(w.status(n)));) {
        assert.ok(Date.now() < end, `never built: ${JSON.stringify(all.map((n) => w.status(n)))}\n${w.logged.join("\n")}`);
        await clock.review(w, all);
        for (const n of all) assert.notEqual(w.status(n).state, "refused", JSON.stringify(w.status(n)));
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally { t.diagnostic(clock.line(w, "build after release", all)); }
    assert.equal(w.status("public.late_daily").lastRun?.rows, LATE_GROUPS);
    assert.deepEqual(await w.rows("SELECT strftime(day, '%Y-%m-%d'), status, orders, revenue::VARCHAR FROM public.late_daily ORDER BY day NULLS LAST, status NULLS LAST"),
      [["2026-01-01", "paid", 2n, "15.75"], ["2026-01-01", null, 1n, "7.00"], ["2026-01-02", "paid", 1n, "1.00"], [null, "refunded", 1n, null]]);
    assert.equal(w.status("public.late_child").lastRun?.rows, 1);
    assert.ok(!w.logged.some(said), w.logged.join("\n"));
    assert.equal(w.status("public.unknown_base").state, "refused");
  }, { onStep: clock.onStep });
});

test("a definition whose check was planned before its base reached the catalog waits for it, never refused (the catalog the check planned on holds it)", async (t) => {
  const clock = new BuildClock();
  await withWorld({}, async (w) => {
    // THE CHECK'S WINDOW, the demo's: the plan is made over a catalog without public.late, and the copy lands, the
    // catalog rebuilt over it, before the check reads what the 42P01 means
    const g = w.sync.generated as unknown as { planner: Planner };
    const planner = g.planner;
    let landed = false;
    g.planner = { ...planner, plan: async (text, stmt, relations) => {
      try { return await planner.plan(text, stmt, relations); }
      finally { if (!landed && /\blate\b/.test(text)) { landed = true; await (await lands(w, late, LATE_DDL, LATE_ROWS, false))(); } }
    } };
    w.write("late_daily", LATE_DAILY);
    await w.sync.generated.review();
    assert.ok(landed, "the copy landed while the check planned");
    const s = w.status("public.late_daily");
    assert.deepEqual([s.state, s.waitingFor, s.refusals], ["waiting", "public.late", []], `${JSON.stringify(s)}\n${w.logged.join("\n")}`);
    clock.start();
    try { assert.equal((await w.until(built, "public.late_daily")).lastRun?.rows, LATE_GROUPS); }
    finally { clock.saw(w, ["public.late_daily"]); t.diagnostic(clock.line(w, "until built after the check", ["public.late_daily"])); }
    assert.ok(!w.logged.some((l) => /late_daily\.yml: (sql: relation "late" does not exist|no longer refused)/.test(l)), w.logged.join("\n"));
    // kept as a refusal: an unqualified name whose only synced table is in another schema (Postgres's search_path is
    // public), the catalog moving or not
    const invoices: AddedTable = { source: "billing.invoices", schema: "billing", table: "invoices", key: ["id"], columns: [{ name: "id", type: "integer", notNull: false, comment: null }], foreignKeys: [], bytes: 0, rows: 1 };
    await (await lands(w, invoices, "CREATE TABLE billing.invoices (id INTEGER)", "(1)", false))();
    w.write("bills", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT count(*) AS n FROM invoices\n");
    refusedAt((await w.until((x) => x.state === "refused", "public.bills")).refusals, "sql", /relation "invoices" does not exist/);
    w.write("bills_q", "kind: scheduled\ntarget_lag: 30s\nsql: SELECT count(*) AS n FROM billing.invoices\n");
    await w.until(built, "public.bills_q");
  }, { onStep: clock.onStep });
});

// ISSUE 474: a GENERATED parent is set deployed, so serving, by its run BEFORE that run's rebuild of the catalog (which
// reads `served()`, so it must), and that rebuild waits behind any other. A child checked in the window met 42P01 for a
// parent its copies() called built, and was refused until the catalog moved again: said refused in the log at a chain's
// first build, and `mason wait` exited 1. Held here deterministically: the catalog's rebuild after the parent's swap.
test("a child of a generated table built but not yet in the catalog waits for it, never refused, then builds (issue 474)", async (t) => {
  const since = Date.now();
  const clock = new BuildClock();
  let window = "";
  // the catalog's rebuild after late_parent's first swap, held as one chained behind another is: armed by the test
  let onSwap: (() => void) | null = null, release = (): void => undefined;
  await withWorld({}, async (w) => {
    const sync = w.sync as unknown as SyncInside;
    clock.watch(w);
    await (await lands(w, late, LATE_DDL, LATE_ROWS, false))();
    const invoices: AddedTable = { source: "billing.invoices", schema: "billing", table: "invoices", key: ["id"], columns: [{ name: "id", type: "integer", notNull: false, comment: null }], foreignKeys: [], bytes: 0, rows: 1 };
    await (await lands(w, invoices, "CREATE TABLE billing.invoices (id INTEGER)", "(1)", false))();
    const said = (l: string): boolean => /late_(child|qual|waiting|mixed|grand)\.yml: (sql: relation "\w+" does not exist|no longer refused)/.test(l);
    const s30 = (sql: string): string => `kind: scheduled\ntarget_lag: 30s\nsql: ${sql}\n`;
    w.write("late_other", s30("SELECT count(*) AS n FROM late"));
    w.write("late_parent", s30("SELECT status, count(*) AS n FROM late GROUP BY 1"));
    // a child already waiting for the parent before its swap
    w.write("late_waiting", s30("SELECT sum(n) AS total FROM late_parent"));
    // a refused parent: its child waits, said by the parent's state, and is counted failed (unchanged)
    w.write("bad_parent", s30("SELECT nosuchcol FROM late"));
    w.write("bad_child", s30("SELECT count(*) FROM bad_parent"));
    onSwap = () => { onSwap = null; const held = new Promise<void>((r) => { release = r; }); sync.schemaBuild = sync.schemaBuild.then(() => held); };
    try {
      // THE RUN'S WINDOW: late_parent swapped in and serving, the catalog's rebuild after it held
      clock.start();
      try {
        for (const end = Date.now() + BUILD_BOUND_MS; ;) {
          await clock.review(w, ["public.late_parent"]);
          const s = w.status("public.late_waiting");
          assert.deepEqual([s.state, s.waitingFor, s.refusals], ["waiting", "public.late_parent", []], JSON.stringify(s));
          if (w.status("public.late_parent").serving) break;
          assert.ok(Date.now() < end, `late_parent never served: ${JSON.stringify(w.status("public.late_parent"))}\n${w.logged.join("\n")}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      } catch (x) { t.diagnostic(clock.line(w, "serve before release", ["public.late_parent"])); throw x; }
      window = clock.line(w, "serve before release", ["public.late_parent"]);
      assert.equal(onSwap, null, "the rebuild after late_parent's swap is held");
      assert.ok(!w.sync.schema().tables.some((t) => t.name === "late_parent"), "the catalog does not hold public.late_parent yet");
      w.write("late_child", s30("SELECT sum(n) AS total FROM late_parent"));
      w.write("late_qual", s30("SELECT sum(n) AS total FROM public.late_parent"));
      w.write("late_mixed", s30("SELECT p.status, p.n, count(*) AS events FROM late_parent p JOIN late l ON l.status = p.status GROUP BY 1, 2"));
      w.write("late_grand", s30("SELECT total FROM late_child"));
      w.write("unknown_base", s30("SELECT count(*) FROM nosuch"));
      w.write("unknown_near", s30("SELECT count(*) FROM late_parentx"));
      w.write("bills", s30("SELECT count(*) AS n FROM invoices"));
      w.write("bills_q", s30("SELECT count(*) AS n FROM billing.invoices"));
      for (let i = 0; i < 3; i++) {
        // the second pass moves every entry's seen.json (the target_lag of a table nothing reads), so each is checked again
        if (i === 1) w.write("late_other", "kind: scheduled\ntarget_lag: 1m\nsql: SELECT count(*) AS n FROM late\n");
        await w.sync.generated.review();
        assert.ok(!w.sync.schema().tables.some((t) => t.name === "late_parent"), "the catalog's rebuild is still held");
        assert.ok(w.status("public.late_parent").serving);
        for (const name of ["public.late_child", "public.late_qual", "public.late_waiting", "public.late_mixed", "public.late_grand"]) {
          const s = w.status(name), parent = name === "public.late_grand" ? "public.late_child" : "public.late_parent";
          assert.deepEqual([s.state, s.waitingFor, s.refusals, s.serving], ["waiting", parent, [], false], `${name} (pass ${i}): ${JSON.stringify(s)}\n${w.logged.join("\n")}`);
          const r = generatedReadiness(s, since);
          assert.deepEqual([r.ready, r.failed, r.waiting], [false, [], [`${name}: waiting for ${parent}`]]);
        }
        refusedAt(w.status("public.unknown_base").refusals, "sql", /relation "nosuch" does not exist/);
        refusedAt(w.status("public.unknown_near").refusals, "sql", /relation "late_parentx" does not exist/);
        refusedAt(w.status("public.bills").refusals, "sql", /relation "invoices" does not exist/);
        refusedAt(w.status("public.bad_parent").refusals, "sql", /column "nosuchcol" does not exist/);
        const bad = w.status("public.bad_child");
        assert.deepEqual([bad.state, bad.waitingFor, bad.refusals], ["waiting", "public.bad_parent, which is refused", []], JSON.stringify(bad));
        assert.deepEqual(generatedReadiness(bad, since).failed, ["public.bad_child: not run, because public.bad_parent, which is refused"]);
      }
      assert.ok(!w.logged.some(said), w.logged.join("\n"));
    } finally {
      // the catalog holds it (and the sync's stop waits for the catalog's last rebuild, so a failure above lets it go too)
      onSwap = null;
      clock.start();
      release();
      await sync.schemaBuild;
    }
    // each built, with no refusal at any review on the way
    const all = ["public.late_parent", "public.late_child", "public.late_qual", "public.late_waiting", "public.late_mixed", "public.late_grand", "public.bills_q"];
    try {
      for (const end = Date.now() + BUILD_BOUND_MS; !all.every((n) => built(w.status(n)));) {
        assert.ok(Date.now() < end, `never built: ${JSON.stringify(all.map((n) => w.status(n)))}\n${w.logged.join("\n")}`);
        await clock.review(w, all);
        for (const n of all) assert.notEqual(w.status(n).state, "refused", JSON.stringify(w.status(n)));
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally { t.diagnostic(`${window} | ${clock.line(w, "build after release", all)}`); }
    assert.ok(!w.logged.some(said), w.logged.join("\n"));
    assert.equal(w.status("public.late_parent").lastRun?.rows, 3);
    for (const n of ["late_child", "late_qual", "late_waiting"]) {
      assert.equal(w.status(`public.${n}`).lastRun?.rows, 1);
      assert.deepEqual(await w.rows(`SELECT total::VARCHAR FROM public.${n}`), [["5"]]);
    }
    assert.deepEqual(await w.rows("SELECT status, n, events FROM public.late_mixed ORDER BY status"), [["paid", 3n, 3n], ["refunded", 1n, 1n]]);
    assert.deepEqual(await w.rows("SELECT total::VARCHAR FROM public.late_grand"), [["5"]]);
    for (const [n, re] of [["unknown_base", /relation "nosuch" does not exist/], ["unknown_near", /relation "late_parentx" does not exist/], ["bills", /relation "invoices" does not exist/]] as const) {
      refusedAt(w.status(`public.${n}`).refusals, "sql", re);
    }
    const bad = w.status("public.bad_child");
    assert.deepEqual([bad.state, bad.waitingFor], ["waiting", "public.bad_parent, which is refused"]);
    // a parent whose file is gone, never built: no file defines it, so its child is Postgres's refusal, never a wait
    w.write("gone_parent", s30("SELECT nosuchcol FROM late"));
    w.write("gone_child", s30("SELECT count(*) FROM gone_parent"));
    await w.until((s) => s.waitingFor === "public.gone_parent, which is refused", "public.gone_child");
    w.remove("gone_parent");
    refusedAt((await w.until((s) => s.state === "refused", "public.gone_child")).refusals, "sql", /relation "gone_parent" does not exist/);
  }, { onStep: (s, n) => { clock.onStep(s, n); if (s === "swapped" && n === "public.late_parent") onSwap?.(); } });
});
