/**
 * A TABLE IS SAID SYNCED ONLY ONCE A QUERY CAN READ IT (issue 920): `Sync.state()` is what `/healthz` counts, what
 * `mason wait` and `mason status` read, and what the web page shows. A first sync records its table "copied" on the
 * writer's turn and rebuilds the catalog after it, so in between `/healthz` said the table was synced while a query of
 * it met 42P01 ("public.items was just synced and joins the catalog as it is rebuilt"). A client or a platform that
 * connects as soon as Mason says ready met that error.
 *
 * The window is caught where it always is: the sync's `full_sync` event is said after the record and before the
 * rebuild, so the test reads `state()` and `schema()` at that moment, never by racing a poll against the rebuild.
 *
 * What it needs: IT_POSTGRES_URL and psql on PATH. It writes only inside a database it creates, `it_served_<random>`,
 * and drops it at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import { phaseCounts } from "../../src/cli/readiness.ts";
import { parseSource } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";
const tag = `it_served_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-served-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const col = (name: string, type: string) => ({ name, type, notNull: false, comment: null });
const ITEMS: AddedTable = { source: "public.items", schema: "public", table: "items", key: ["id"], bytes: 0, rows: 2000, foreignKeys: [], columns: [col("id", "integer"), col("v", "text")] };

test("a table's first sync is said done only once the catalog holds it: /healthz, mason wait and mason status never run ahead of a query", { skip }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  after(() => psql(adminUrl!, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`));
  const u = new URL(adminUrl!);
  u.pathname = `/${tag}`;
  const url = u.toString();
  psql(url, "CREATE TABLE items (id int PRIMARY KEY, v text); INSERT INTO items SELECT g, 'v' || g FROM generate_series(1, 2000) g");

  const parsed = parseSource(url);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "served.db"), (l) => logged.push(l), { memoryLimit: "256MB" });
  // what the run says of items, and whether a query can read it, at the moment its first sync is said done
  let atSynced: { phase: string | undefined; copied: number; inCatalog: boolean } | null = null;
  const inCatalog = (): boolean => sync.schema().tables.some((t) => t.schema === "public" && t.name === "items");
  const sync: Sync = new Sync(store, parsed.source, parsed.source.database, (l) => logged.push(l), 3_600_000, "poll", null, {
    onEvent: (e) => {
      if (e.kind !== "full_sync" || e.table !== "public.items") return;
      atSynced = { phase: sync.state().find((s) => s.source === "public.items")?.phase, copied: phaseCounts(sync.state()).copied, inCatalog: inCatalog() };
    },
  });
  try {
    await sync.open();
    // added while the run is up, as `mason add` adds it: the catalog is rebuilt before it is synced, then after
    await sync.setTables([ITEMS]);
    assert.equal(inCatalog(), false, "items is not in the catalog before its first sync");
    for (const end = Date.now() + 120_000; atSynced === null || sync.state()[0]?.phase !== "copied"; await sleep(20)) {
      if (Date.now() > end) throw new Error(`items' first sync did not end within 120 s\n${logged.slice(-15).join("\n")}`);
    }
    const seen = atSynced as { phase: string | undefined; copied: number; inCatalog: boolean } | null;
    assert.ok(seen !== null);
    assert.equal(seen.inCatalog, false, "the event is said before the catalog is rebuilt: the window the test reads");
    assert.notEqual(seen.phase, "copied", `items was said synced while a query of it met 42P01 (the catalog did not hold it yet)\n${logged.slice(-10).join("\n")}`);
    assert.equal(seen.copied, 0, "/healthz counted items as synced while a query of it met 42P01");
    // and once said synced, the catalog holds it
    assert.equal(inCatalog(), true, "items is in the catalog once it is said synced");
    assert.equal(phaseCounts(sync.state()).copied, 1);
  } finally {
    await sync.stop();
    await store.close();
  }
});
