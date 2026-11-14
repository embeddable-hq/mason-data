/**
 * `mason start`'s catalog read (src/cli/preflight.ts readSourceFacts) against a real Postgres: a never-analysed table is
 * counted (once per run, never per read), a PARTITIONED table's rows and size are its leaves' — its own `reltuples`
 * and size are -1 / 0 — and an analysed table is read from the catalog without counting. Review of #404: a remote
 * partitioned table was `count(*)`-scanned every 10 s, and a never-analysed one passed the 1M-row rule as "~0 rows".
 * Needs IT_POSTGRES_URL; it creates a database of its own and drops it.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { connectSource, parseSource, readSourceFacts } from "../../src/cli/preflight.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_preflight_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

after(() => {
  if (adminUrl && psql(adminUrl, `SELECT count(*) FROM pg_database WHERE datname = '${tag}'`) === "1") psql(adminUrl, `DROP DATABASE "${tag}" WITH (FORCE)`);
});

test("the catalog read: a partitioned table is its leaves, a never-analysed one is counted once", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  psql(adminUrl!, `CREATE DATABASE "${tag}"`);
  psql(dbUrl, "CREATE TABLE events (id bigint, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at); " +
    "CREATE TABLE events_2026_09 PARTITION OF events FOR VALUES FROM ('2026-09-01') TO ('2026-10-01'); " +
    "CREATE TABLE events_2026_10 PARTITION OF events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01'); " +
    "INSERT INTO events SELECT i, DATE '2026-09-15' + (i % 30) FROM generate_series(1, 3000) i; " +
    "CREATE TABLE items (id int PRIMARY KEY); INSERT INTO items SELECT generate_series(1, 40)");
  const parsed = parseSource(dbUrl);
  assert.ok("source" in parsed, JSON.stringify(parsed));
  const read = async (counted: Map<number, number>) => {
    const c = await connectSource(parsed.source);
    assert.ok("pg" in c, JSON.stringify(c));
    try { return await readSourceFacts(c.pg, counted); } finally { c.pg.close(); }
  };
  const counted = new Map<number, number>();
  const rows = (f: Awaited<ReturnType<typeof read>>, t: string) => f.tables.find((x) => x.source === t)?.rows;
  const first = await read(counted);
  assert.deepEqual(first.tables.map((t) => t.source).sort(), ["public.events", "public.items"], "a partition is not a table of its own");
  assert.equal(rows(first, "public.events"), 3000, "never analysed: counted");
  assert.equal(rows(first, "public.items"), 40);
  assert.ok(first.tables.find((t) => t.source === "public.events")!.bytes > 0, "a partitioned table's size is its leaves'");
  assert.equal(counted.size, 2, "each counted once");
  // the next read takes the count it has, never the table again: a row added since is not counted
  psql(dbUrl, "INSERT INTO items VALUES (41)");
  assert.equal(rows(await read(counted), "public.items"), 40);
  // analysed: the catalog's numbers, a partitioned table's summed over its leaves
  psql(dbUrl, "ANALYZE events; ANALYZE items");
  const analysed = await read(new Map());
  assert.equal(rows(analysed, "public.events"), 3000);
  assert.equal(rows(analysed, "public.items"), 41);
});
