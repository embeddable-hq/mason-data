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
import { built, COUNTS, plain, refusedAt, served, withWorld } from "./duck-generated-world.ts";

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
async function overLedger(files: Record<string, string>, use: (w: Parameters<Parameters<typeof withWorld>[1]>[0], restarted: boolean) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-numeric-"));
  try {
    await withWorld({}, async (w) => { for (const sql of LEDGER_SEED) await w.store.writer.run(sql); }, { dir });
    await withWorld(files, async (w) => { for (const name of Object.keys(files)) await w.until(built, `public.${name}`); await use(w, false); }, { dir, again: true, tables: [ledger] });
    await withWorld({}, async (w) => { for (const name of Object.keys(files)) assert.ok(built(w.status(`public.${name}`))); await use(w, true); }, { dir, again: true, tables: [ledger] });
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

test("a numeric the types don't fix is refused with its own reason: a division, a scale past 18; a sum of differing columns' scales is stored", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    w.write("mean", `${lag}sql: SELECT avg(n) AS mean FROM ledger\n`);
    w.write("wide", `${lag}sql: SELECT sum(wide) AS total FROM ledger\n`);
    w.write("mixed", `${lag}sql: SELECT sum(amount) + sum(big) AS combined FROM ledger\n`);
    w.write("texts", `${lag}sql: SELECT sum((payload ->> 'a')::numeric) AS total FROM events\n`);
    w.write("larger", `${lag}sql: SELECT greatest(amount, 1) AS top FROM ledger\n`);
    // each file read and planned, under load too: a review already in flight when they were written may not have read them
    for (const name of ["mean", "wide", "texts", "larger"]) await w.until((s) => s.state === "refused", `public.${name}`);
    const r = (name: string): GeneratedStatus => w.status(`public.${name}`);
    refusedAt(r("mean").refusals, "sql", /^column mean divides a numeric, which the engine computes as a double$/);
    assert.ok(r("mean").refusals[0]!.options.some((o) => o.includes("count(")), JSON.stringify(r("mean").refusals));
    refusedAt(r("wide").refusals, "sql", /^column total has 30 decimals, more than the 18 a stored numeric keeps$/);
    assert.ok(r("wide").refusals[0]!.options.some((o) => o.includes("round(")), JSON.stringify(r("wide").refusals));
    refusedAt(r("texts").refusals, "sql", /^column total sums values Postgres keeps at differing scales, so the rows decide its decimals$/);
    refusedAt(r("larger").refusals, "sql", /^column top computes a numeric in a way Mason can't store exactly yet/);
    for (const name of ["mean", "wide", "texts", "larger"]) assert.doesNotMatch(JSON.stringify(r(name).refusals), /no fixed scale/);
    // case 2f: the sum of an unconstrained numeric's synced column is one cell at the scale its DECIMAL holds, so it is stored
    await w.until(built, "public.mixed");
    assert.deepEqual((await typed(w, "SELECT combined FROM mixed")).rows, [["12345678901234567893.823456788"]]);
  });
});
