/**
 * A CATALOG READ LEAVES NOTHING ON A POOLED SERVER CONNECTION (the re-check of PR 900 at 6d60906b). Behind a pooler in
 * transaction mode (PgBouncer's `pool_mode = transaction`, Supabase's default pooler URL), one server connection is
 * handed to one client after another, a transaction at a time, and nothing is reset between them. The catalog read ran
 * a session `SET lock_timeout = 2000`, so the application's next connections were given that limit, and a query of
 * theirs waiting on another session's lock failed after 2 s, for as long as the server connection lived (an hour by
 * default).
 *
 * The web page's Live checks for a table's Sync choice ran a session `SET statement_timeout = 10000` the same way
 * (issue 930), so the application's queries could be cancelled after 10 s.
 *
 * Here a pooler of the test's own (tests/tx-pooler.ts), in transaction mode, with ONE server connection. The run's
 * catalog read (`watchedRead`, as src/cli/dev.ts calls it, reading `readSourceFacts`) goes through it, and so do the
 * Live checks (`boundedLiveChecks`, as src/cli/dev.ts calls them). Then come the application's clients: their
 * `lock_timeout` and `statement_timeout` must be the server's own.
 *
 * What it needs: IT_POSTGRES_URL. It writes only inside a database it creates, `it_txpool_<random>`, and drops it.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { transactionPooler } from "../tx-pooler.ts";
import { spawnSync } from "node:child_process";
import { connectSource, parseSource, readSourceFacts } from "../../src/cli/preflight.ts";
import { watchedRead } from "../../src/cli/source-catalog.ts";
import type { PgConnection } from "../../src/cdc/pg-wire.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_txpool_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

const poolers: Array<() => void> = [];
after(() => {
  for (const close of poolers) close();
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

/** The test's database once, and a pooler of its own in front of it: how to connect through it, as Mason connects. */
let made = false;
async function pooled(): Promise<{ connect: () => Promise<PgConnection>; serverConnections: () => number }> {
  if (!made) {
    psql(adminUrl!, `CREATE DATABASE ${tag}`);
    psql(dbUrl, "CREATE TABLE customers (id int PRIMARY KEY, name text)");
    made = true;
  }
  const target = new URL(dbUrl);
  const pooler = await transactionPooler({ host: target.hostname, port: Number(target.port || 5432) });
  poolers.push(pooler.close);
  const viaPooler = new URL(dbUrl);
  viaPooler.hostname = "127.0.0.1";
  viaPooler.port = String(pooler.port);
  viaPooler.searchParams.set("sslmode", "disable");
  const parsed = parseSource(viaPooler.toString());
  assert.ok("source" in parsed);
  const connect = async () => { const c = await connectSource(parsed.source); if ("failure" in c) throw new Error(c.failure.message); return c.pg; };
  return { connect, serverConnections: pooler.serverConnections };
}

/** What the application's next clients see of `setting`, given the same server connection: each must be `expected`. */
async function nextClientsSee(connect: () => Promise<PgConnection>, setting: string, expected: string, after: string): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const app = await connect();
    try {
      const seen = (await app.query(`SELECT current_setting('${setting}')`)).rows[0]![0];
      assert.equal(seen, expected, `client ${i + 1} after ${after}: ${setting} ${seen}, the server's is ${expected}`);
    } finally { app.close(); }
  }
}

test("behind a pooler in transaction mode, the catalog read leaves no setting on the server connection: the next client has the server's own lock_timeout", {
  skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 120_000 }, async () => {
  const { connect, serverConnections } = await pooled();
  const serverDefault = psql(dbUrl, "SHOW lock_timeout");

  // the run's catalog read, as src/cli/dev.ts makes it
  const facts = await watchedRead({ connect, read: (pg) => readSourceFacts(pg, undefined, { collations: false }), signal: new AbortController().signal, log: () => undefined });
  assert.ok(facts.tables.some((t) => t.source === "public.customers"), "the read read the catalog");

  await nextClientsSee(connect, "lock_timeout", serverDefault, "the read");
  assert.equal(serverConnections(), 1, "every client was given the one server connection");
});

test("behind a pooler in transaction mode, the web page's Live checks leave no statement_timeout on the server connection (issue 930)", {
  skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 120_000 }, async () => {
  // loaded here: where this file proves itself (scripts/fails-without.ts) the function may not exist, and this test
  // then fails by name while the others run
  const { boundedLiveChecks } = await import("../../src/cli/sync-choice.ts" as string) as Partial<typeof import("../../src/cli/sync-choice.ts")>;
  assert.equal(typeof boundedLiveChecks, "function", "src/cli/sync-choice.ts exports boundedLiveChecks, the checks as the run reads them");
  const { connect, serverConnections } = await pooled();
  const serverDefault = psql(dbUrl, "SHOW statement_timeout");
  const facts = await watchedRead({ connect, read: (pg) => readSourceFacts(pg, undefined, { collations: false }), signal: new AbortController().signal, log: () => undefined });
  const t = facts.tables.find((x) => x.source === "public.customers")!;

  // the checks as src/cli/dev.ts runs them: one connection, closed after
  const pg = await connect();
  let checks;
  try { checks = await boundedLiveChecks!(pg, t, { repl: { slot: `${tag}_slot`, publication: `${tag}_pub`, owned: false }, streaming: false, columns: ["id", "name"], shown: "mason/sources/app.yml" }, () => undefined); }
  finally { pg.close(); }
  assert.ok(checks.some((c) => c.name === "wal_level"), JSON.stringify(checks));
  assert.ok(checks.some((c) => c.name === "publication" && c.state === "refused"), "the named publication, which does not exist, read and refused");

  await nextClientsSee(connect, "statement_timeout", serverDefault, "the checks");
  assert.equal(serverConnections(), 1, "every client was given the one server connection");
});
