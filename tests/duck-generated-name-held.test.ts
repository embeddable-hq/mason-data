/**
 * GENERATED TABLES, OFFLINE: A NAME A SYNCED TABLE ALSO HOLDS (issue 996), one piece of tests/duck-generated*.test.ts.
 * The synced table wins the name while it is added, and the generated file is refused; removed, the generated table is
 * built again and served; added again, it is let go again. Never a table the catalog names with nothing under it, which
 * failed every rebuild of the catalog and every pass until a base changed. Each test runs its own world
 * (tests/duck-generated-world.ts).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type pg from "pg";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import { readGenerated } from "../src/cli/generated-files.ts";
import type { AddedTable } from "../src/duck/sync.ts";
import { BUILD_BOUND_MS, COUNTS, refusedAt, served, withWorld, type World } from "./duck-generated-world.ts";

after(() => stopParser());

/** `public.counts` as a synced table: one integer column */
const synced = (table = "counts"): AddedTable => ({ source: `public.${table}`, schema: "public", table, key: ["x"], columns: [{ name: "x", type: "integer", notNull: false, comment: null }], foreignKeys: [], bytes: 0, rows: 3 });

const ask = async (w: { client(): Promise<pg.Client> }, sql: string): Promise<unknown[]> => { const c = await w.client(); try { return (await c.query({ text: sql, rowMode: "array" })).rows; } finally { await c.end(); } };

/** the sync's own: its tables, its catalog's rebuild, and its pass */
const inner = (w: World) => w.sync as unknown as { tables: Map<string, AddedTable>; rebuildSchema(): Promise<void> };

/** `mason add counts` while running, its first sync swapped in, and no review of the generated tables since: the
 *  sources file adds it (the name is held from here), and the copy's swap puts the synced table at the name */
async function addCounts(w: World, events: AddedTable): Promise<void> {
  await w.sync.setTables([events, synced()]);
  await w.store.writer.run("DROP TABLE IF EXISTS public.counts");
  await w.store.writer.run("CREATE TABLE public.counts (x INTEGER)");
  await w.store.writer.run("INSERT INTO public.counts VALUES (101), (102), (103)");
}

/** `mason remove counts` while running: the sources file without it, and the pass that drops its synced data */
async function removeCounts(w: World, events: AddedTable): Promise<void> {
  const from = w.logged.length;
  await w.sync.setTables([events]);
  w.sync.kick();
  const dropped = (): boolean => w.logged.slice(from).some((l) => l.startsWith("dropped public.counts's synced data"));
  for (const end = Date.now() + BUILD_BOUND_MS; !dropped() && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
  assert.ok(dropped(), w.logged.join("\n"));
}

test("a synced table added over a built generated table and removed before the next review: the catalog is rebuilt, the generated table is built again and served, and added again it is let go (issue 996)", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(served(w.logged));
    const events = inner(w).tables.get("public.events")!;
    await addCounts(w, events);
    await removeCounts(w, events);
    // the catalog is rebuilt over what is there: no generated table said served with no table under it
    await inner(w).rebuildSchema();
    const from = w.logged.length;
    await w.until(served(w.logged, from));
    assert.ok(w.logged.some((l) => l === "public.counts: the synced table that held its name is dropped, so the generated table is built again"), w.logged.join("\n"));
    assert.deepEqual(await ask(w, "SELECT tenant_id, requests FROM counts ORDER BY tenant_id"), [[1, "2"], [2, "2"]]);
    await inner(w).rebuildSchema();
    // added again: the synced table wins the name, and the generated one is let go, ledger and all
    await addCounts(w, events);
    const held = await w.until((s) => s.state === "refused");
    refusedAt(held.refusals, null, /is a table the sources file syncs/);
    assert.equal(held.serving, false);
    assert.deepEqual(await w.rows(`SELECT count(*) FROM ${MASON_SCHEMA}.generated_tables`), [[0n]]);
    assert.deepEqual(await w.rows("SELECT x FROM public.counts ORDER BY x"), [[101], [102], [103]], "the synced table's rows stay");
    // and removed again: built again once more
    await removeCounts(w, events);
    await w.until(served(w.logged, w.logged.length));
    assert.deepEqual(await ask(w, "SELECT tenant_id, requests FROM counts ORDER BY tenant_id"), [[1, "2"], [2, "2"]]);
    assert.ok(!w.logged.some((l) => /could not be rebuilt|sync pass failed: Catalog Error/.test(l)), w.logged.join("\n"));
  });
});

test("a base change while a run is in flight and the sync drops the name under it: marked for the next run, never current while stale (issue 996)", async () => {
  let gate: Promise<void> | null = null, open: () => void = () => undefined, blocked = false;
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(served(w.logged));
    const events = inner(w).tables.get("public.events")!;
    gate = new Promise<void>((r) => { open = r; });
    await w.store.writer.run("INSERT INTO public.events VALUES (10, 3, 'query', 'ok', '10', '2026-01-03 00:00:00+00', NULL, 1.00, NULL)");
    w.sync.generated.changed("public.events");
    for (const end = Date.now() + BUILD_BOUND_MS; !blocked && Date.now() < end;) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(blocked, "the run reached its snapshot");
    // while it is held there: `mason add counts`, then `mason remove counts`, and a base commit after its snapshot
    await addCounts(w, events);
    await removeCounts(w, events);
    await w.store.writer.run("INSERT INTO public.events VALUES (11, 4, 'query', 'ok', '11', '2026-01-04 00:00:00+00', NULL, 1.00, NULL)");
    w.sync.generated.changed("public.events");
    const from = w.logged.length;
    gate = null; open();
    await w.until(served(w.logged, from));
    // the commit after the snapshot is not in that run: marked, so the next run brings it
    await w.until((s) => s.state === "current" && (s.lastRun?.rows ?? 0) === 4);
    assert.deepEqual(await ask(w, "SELECT tenant_id, requests FROM counts ORDER BY tenant_id"), [[1, "2"], [2, "2"], [3, "1"], [4, "1"]]);
  }, { onStep: async (s, n) => { if (s === "snapshot" && n === "public.counts" && gate !== null) { blocked = true; await gate; } } });
});

test("a generated table whose name differs from a view of the database only in case is served beside it: a view is no table in the synced data (issue 996)", async () => {
  await withWorld({ Report: COUNTS }, async (w) => {
    w.sync.setViews([{ schema: "public", name: "report", definition: "SELECT id, tenant_id FROM public.events WHERE id < 3", comment: null }]);
    await inner(w).rebuildSchema();
    await w.until(served(w.logged), "public.Report");
    await inner(w).rebuildSchema();
    assert.deepEqual(await ask(w, `SELECT tenant_id, requests FROM "Report" ORDER BY tenant_id`), [[1, "2"], [2, "2"]]);
    assert.deepEqual(await ask(w, "SELECT id, tenant_id FROM report ORDER BY id"), [["1", 1], ["2", 1]]);
  });
});

test("a ledger row whose table is gone, as an earlier Mason left a removed synced table's name: the start lets it go and builds the generated table again (issue 996)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-gone-"));
  try {
    await withWorld({ counts: COUNTS }, async (w) => {
      await w.until(served(w.logged));
      // what `mason remove` of a synced table that held the name left behind: the table dropped, the ledger row kept
      await w.store.writer.run("DROP TABLE public.counts");
    }, { dir });
    await withWorld({}, async (w) => {
      assert.ok(w.logged.includes("public.counts: its table is not in the synced data, so the generated table is built again"), w.logged.join("\n"));
      await w.until(served(w.logged));
      assert.deepEqual(await ask(w, "SELECT tenant_id, requests FROM counts ORDER BY tenant_id"), [[1, "2"], [2, "2"]]);
    }, { dir, again: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("at the start: a synced table and a generated file of one name, then the synced table removed, then added again: refused, then built and served, then refused again (issue 996)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-start-"));
  try {
    // the synced table's first sync, as a copy leaves it
    await withWorld({}, async (w) => {
      await w.store.writer.run("CREATE TABLE public.counts (x INTEGER)");
      await w.store.writer.run("INSERT INTO public.counts VALUES (101), (102), (103)");
      await w.store.writer.run(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.counts', 'copied', 3, 0, 1.0, now(), NULL, '[{"name":"x","type":"integer","notNull":false,"comment":null}]')`);
      await w.store.writer.run(`INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.counts', '100:100:', now(), 'off')`);
    }, { dir });
    await withWorld({ counts: COUNTS }, async (w) => {
      const s = await w.until((x) => x.state === "refused");
      refusedAt(s.refusals, null, /is a table the sources file syncs/);
    }, { dir, again: true, tables: [synced()] });
    // started without it: its synced data dropped by the pass, and the generated table built
    await withWorld({}, async (w) => {
      await removeCounts(w, inner(w).tables.get("public.events")!);
      await w.until(served(w.logged));
      assert.deepEqual(await ask(w, "SELECT tenant_id, requests FROM counts ORDER BY tenant_id"), [[1, "2"], [2, "2"]]);
    }, { dir, again: true, tables: [synced()] });
    // started with it again, its first sync not swapped in yet: the name is held, and the generated table let go
    await withWorld({}, async (w) => {
      const s = await w.until((x) => x.state === "refused");
      refusedAt(s.refusals, null, /is a table the sources file syncs/);
      assert.equal(s.serving, false);
      assert.deepEqual(await w.rows(`SELECT count(*) FROM ${MASON_SCHEMA}.generated_tables`), [[0n]]);
    }, { dir, again: true, tables: [synced()] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a generated file refused at its read keeps what it built only while no synced table holds its name: taken, it is let go, ledger and all (issue 996)", async () => {
  await withWorld({ counts: COUNTS }, async (w) => {
    await w.until(served(w.logged));
    w.write("counts", `${COUNTS}not_a_key: 1\n`);
    await w.until((s) => s.state === "refused");
    assert.equal(w.status().serving, true, "a refused file keeps serving what it was built from");
    await addCounts(w, inner(w).tables.get("public.events")!);
    await w.until((s) => !s.serving);
    assert.deepEqual(await w.rows(`SELECT count(*) FROM ${MASON_SCHEMA}.generated_tables`), [[0n]], "its ledger row is gone");
  });
});

test("a generated file whose name differs from a synced table's only in case is that table's name: refused, and the synced table never dropped (issue 996)", async () => {
  await withWorld({ Counts: COUNTS }, async (w) => {
    await w.store.writer.run("CREATE TABLE public.counts (x INTEGER)");
    await w.store.writer.run("INSERT INTO public.counts VALUES (101), (102), (103)");
    await w.sync.setTables([inner(w).tables.get("public.events")!, synced()]);
    const s = await w.until((x) => x.state === "refused", "public.Counts");
    refusedAt(s.refusals, null, /public\.Counts is a table the sources file syncs/);
    for (let i = 0; i < 10; i++) { await w.sync.generated.review(); await new Promise((r) => setTimeout(r, 20)); }
    assert.ok(!w.reached.includes("swapped"), "nothing is swapped in over the synced table");
    assert.deepEqual(await w.rows("SELECT x FROM public.counts ORDER BY x"), [[101], [102], [103]], "the synced table's rows stay");
  });
});

test("two generated files whose names differ only in case name one table: the second is refused at its read (issue 996)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-case-"));
  try {
    const folder = path.join(dir, "mason"), tables = path.join(folder, "generated_tables");
    fs.mkdirSync(tables, { recursive: true });
    fs.writeFileSync(path.join(tables, "Daily.yml"), COUNTS);
    fs.writeFileSync(path.join(tables, "daily.yml"), COUNTS);
    const read = readGenerated(folder, dir);
    assert.deepEqual(read.definitions.map((d) => d.name), ["public.Daily"]);
    assert.deepEqual(read.refused.map((r) => [r.name, r.refusals[0]!.message]), [["public.daily", "names the table public.daily, as mason/generated_tables/Daily.yml does"]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
