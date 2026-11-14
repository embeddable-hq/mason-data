/**
 * Live's checks for the web page's Sync choice against a real Postgres (issue 840; src/cli/sync-choice.ts
 * `sourceLiveChecks`): a user without REPLICATION and a named publication that lacks the table are each refused by name
 * with the SQL that fixes it; once fixed on the database, Live passes. Every statement the checks send is recorded: a
 * read of settings and the catalog, never of the table's rows, over the one connection given. Needs IT_POSTGRES_URL with
 * wal_level=logical; it creates a database and a role of its own and drops them.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { connectSource, parseSource, readSourceFacts } from "../../src/cli/preflight.ts";
import type { PgConnection } from "../../src/cdc/pg-wire.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_syncchoice_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const role = `${tag}_reader`;
const password = `pw_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const urlAs = (user: string | null, db: string): string => {
  const u = new URL(adminUrl!);
  u.pathname = `/${db}`;
  if (user !== null) { u.username = user; u.password = password; }
  return u.toString();
};
function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
after(() => {
  if (!adminUrl) return;
  if (psql(adminUrl, `SELECT count(*) FROM pg_database WHERE datname = '${tag}'`) === "1") psql(adminUrl, `DROP DATABASE "${tag}" WITH (FORCE)`);
  if (psql(adminUrl, `SELECT count(*) FROM pg_roles WHERE rolname = '${role}'`) === "1") psql(adminUrl, `DROP ROLE "${role}"`);
});

test("Live's checks name what the database lacks with its fix, pass once fixed, and read no row of the table", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const { sourceLiveChecks } = await import("../../src/cli/sync-choice.ts");
  psql(adminUrl!, `CREATE DATABASE "${tag}"`);
  psql(adminUrl!, `CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  const db = urlAs(null, tag);
  psql(db, `CREATE TABLE orders (id int PRIMARY KEY, status text); CREATE TABLE other (id int PRIMARY KEY); CREATE TABLE orders2 (id int PRIMARY KEY, status text, amount numeric);
    INSERT INTO orders SELECT g, 'new' FROM generate_series(1, 1000) g;
    GRANT SELECT ON orders, other, orders2 TO "${role}"; CREATE PUBLICATION app_pub FOR TABLE other;
    CREATE PUBLICATION narrow_pub FOR TABLE orders2 (id, status)`);
  const parsed = parseSource(urlAs(role, tag));
  assert.ok("source" in parsed);
  const repl = { slot: `${tag}_slot`, publication: "app_pub", owned: false };
  // the catalog as the run read it at its start (its own connection: a table never analysed is counted there, which the
  // checks never do)
  const read = await connectSource(parsed.source);
  assert.ok(!("failure" in read), "failure" in read ? read.failure.message : "");
  const catalog = (await readSourceFacts(read.pg, undefined, { collations: false }).finally(() => read.pg.close())).tables;
  const t = catalog.find((x) => x.source === "public.orders")!;
  const run = async () => {
    const c = await connectSource(parsed.source);
    assert.ok(!("failure" in c), "failure" in c ? c.failure.message : "");
    const sent: string[] = [];
    const pg = { query: (sql: string) => { sent.push(sql); return c.pg.query(sql); } } as unknown as PgConnection;
    try { return { checks: await sourceLiveChecks(pg, t, { repl, streaming: false, columns: t.columns.map((c) => c.name), shown: "mason/sources/app.yml" }), sent }; } finally { c.pg.close(); }
  };
  const scans = () => psql(db, "SELECT seq_scan + coalesce(idx_scan, 0) FROM pg_stat_user_tables WHERE relname = 'orders'");

  await new Promise((r) => setTimeout(r, 1500));
  const atFirst = scans();
  const first = await run();
  const refused = first.checks.filter((c) => c.state === "refused");
  assert.deepEqual(refused.map((c) => c.name), ["replication role", "publication"], JSON.stringify(first.checks));
  assert.equal(refused[0]!.sql, `ALTER ROLE ${role} WITH REPLICATION;`);
  assert.equal(refused[1]!.sql, "ALTER PUBLICATION app_pub ADD TABLE public.orders;");
  for (const sql of first.sent) {
    assert.match(sql.trim(), /^(SELECT|WITH) /, "a read");
    assert.doesNotMatch(sql, /(^|;)\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/i, "nothing written: one statement, a read");
    assert.doesNotMatch(sql, /\bFROM\s+(public\.)?"?orders"?\b/i, `a read of the table's rows: ${sql}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(scans(), atFirst, "no scan of the table: nothing of its rows was read");

  psql(db, `ALTER ROLE "${role}" WITH REPLICATION; ALTER PUBLICATION app_pub ADD TABLE orders`);
  const before = scans();
  const second = await run();
  assert.deepEqual(second.checks.filter((c) => c.state === "refused"), [], JSON.stringify(second.checks));
  assert.ok(second.checks.some((c) => c.name === "publication" && c.state === "ok"));
  // the statistics are flushed when a backend ends: give the checks' connection its moment, then read them
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(scans(), before, "no scan of the table: nothing of its rows was read");
  assert.equal(psql(db, `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${repl.slot}'`), "0", "no slot made");

  // A NAMED PUBLICATION WITH A COLUMN LIST (a review finding): held to the columns the entry syncs, and no more — an entry
  // of id and status passes under `FOR TABLE orders2 (id, status)`; every column would need amount published too
  const t2 = catalog.find((x) => x.source === "public.orders2")!;
  const narrow = async (columns: string[]) => {
    const c = await connectSource(parsed.source);
    assert.ok(!("failure" in c), "failure" in c ? c.failure.message : "");
    try { return (await sourceLiveChecks(c.pg, t2, { repl: { ...repl, publication: "narrow_pub" }, streaming: false, columns, shown: "mason/sources/app.yml" })).find((x) => x.name === "publication")!; }
    finally { c.pg.close(); }
  };
  const two = await narrow(["id", "status"]);
  assert.equal(two.state, "ok", JSON.stringify(two));
  const every = await narrow(["id", "status", "amount"]);
  assert.equal(every.state, "refused", JSON.stringify(every));
  assert.match(every.detail, /amount/);
});
