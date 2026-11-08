/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: a restart: the ledger, a
 * side table, and a crash at each step of a run (tests/duck-generated-crash-child.ts). Each test runs its own world
 * (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import type { GeneratedStep } from "../src/duck/generated.ts";
import { BUILD_BOUND_MS, built, COUNTS, withWorld } from "./duck-generated-world.ts";

after(() => stopParser());

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
        for (const end = Date.now() + BUILD_BOUND_MS; !w.reached.includes("snapshot") && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 10)); }
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
