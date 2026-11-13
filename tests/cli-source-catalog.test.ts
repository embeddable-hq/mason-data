/**
 * The database's catalog as a run holds it (src/cli/source-catalog.ts, issue 890): read again only when asked, a read
 * under a minute old reused, one read at a time shared by every asker, a failed read leaving the last in place and said
 * — and nothing read when nobody asks, whatever the time.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { SourceFacts } from "../src/cli/preflight.ts";
// imported when the tests run: at a commit without the module the file still loads, and each test fails by name
const { actRead, CATALOG_FRESH_MS, CATALOG_READ_HEADER, CATALOG_READ_TIMEOUT_MS, catalogFailure, sourceCatalog, stallWatch, statementVerdict, watchedRead } = await import("../src/cli/source-catalog.ts" as string).catch(() => ({})) as typeof import("../src/cli/source-catalog.ts");

const factsOf = (tables: string[]): SourceFacts => ({ version: 160000, versionText: "16", standby: false, systemIdentifier: null,
  tables: tables.map((t) => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], rows: 1, bytes: 8192, comment: null, columns: [], foreignKeys: [] })) });
const names = (f: SourceFacts): string[] => f.tables.map((t) => t.table);

test("nothing is read until asked, however long; an ask reads when the last read is a minute old, and a read under it is reused", async () => {
  assert.equal(CATALOG_FRESH_MS, 60_000);
  let now = 0, reads = 0;
  let database = ["customers"];
  const logged: string[] = [];
  const c = sourceCatalog(factsOf(["customers"]), async () => { reads++; return factsOf(database); }, { log: (m) => logged.push(m), now: () => now });
  now = 3_600_000;
  assert.equal(reads, 0, "an hour with nobody asking: no read");
  assert.deepEqual(names(c.facts()), ["customers"], "facts() never reads");
  assert.equal(reads, 0);
  database = ["customers", "orders"];
  assert.deepEqual(names(await c.fresh()), ["customers", "orders"], "asked: read, and a table made since is there");
  assert.equal(reads, 1);
  assert.deepEqual(names(c.facts()), ["customers", "orders"], "the read is the last one now");
  now += CATALOG_FRESH_MS - 1;
  database = ["customers", "orders", "invoices"];
  assert.deepEqual(names(await c.fresh()), ["customers", "orders"], "under a minute old: reused");
  assert.equal(reads, 1);
  now += 1;
  assert.deepEqual(names(await c.fresh()), ["customers", "orders", "invoices"], "a minute old: read again");
  assert.equal(reads, 2);
  assert.deepEqual(logged, []);
});

test("the read the start made counts as a read: an ask within the minute after it reuses it", async () => {
  let now = 1_000, reads = 0;
  const c = sourceCatalog(factsOf(["a"]), async () => { reads++; return factsOf(["a", "b"]); }, { log: () => undefined, now: () => now });
  now += 30_000;
  assert.deepEqual(names(await c.fresh()), ["a"]);
  assert.equal(reads, 0);
});

test("asks while a read runs share it: one connection however many ask", async () => {
  let now = 0, reads = 0;
  let release: (f: SourceFacts) => void = () => undefined;
  const c = sourceCatalog(factsOf(["a"]), () => { reads++; return new Promise<SourceFacts>((r) => { release = r; }); }, { log: () => undefined, now: () => now });
  now = CATALOG_FRESH_MS;
  const asks = [c.fresh(), c.fresh(), c.fresh()];
  release(factsOf(["a", "b"]));
  for (const f of await Promise.all(asks)) assert.deepEqual(names(f), ["a", "b"]);
  assert.equal(reads, 1);
});

test("a failed read leaves the last one in place, is said in the log, and is not tried again within the minute", async () => {
  let now = 0, reads = 0, fail = true;
  const logged: string[] = [];
  const c = sourceCatalog(factsOf(["a"]), async () => { reads++; if (fail) throw new Error("nothing is listening on db.example.com:5432"); return factsOf(["a", "b"]); },
    { log: (m) => logged.push(m), now: () => now });
  now = CATALOG_FRESH_MS;
  assert.deepEqual(names(await c.fresh()), ["a"], "the last read, kept");
  assert.deepEqual(logged, ["the database's tables could not be read again (nothing is listening on db.example.com:5432): the tables read before are shown until a read succeeds"]);
  fail = false;
  now += 2_000;
  assert.deepEqual(names(await c.fresh()), ["a"], "a database away is not asked again at every poll of a page");
  assert.equal(reads, 1);
  now += CATALOG_FRESH_MS;
  assert.deepEqual(names(await c.fresh()), ["a", "b"], "a minute on, read again");
  assert.equal(reads, 2);
});

// THE REVIEW OF PR 900, B1: a read held by a lock (a migration's ALTER queued behind a long transaction) left /api/state,
// so mason status, mason wait and the page, answering nothing for 30 s
test("an asker that only shows the catalog waits for a read at most waitMs, then has the last one; the read goes on and is taken when it ends", async () => {
  let now = CATALOG_FRESH_MS, release: (f: SourceFacts) => void = () => undefined;
  const c = sourceCatalog(factsOf(["a"]), () => new Promise<SourceFacts>((r) => { release = r; }), { log: () => undefined, now: () => now });
  now += CATALOG_FRESH_MS;
  const began = Date.now();
  assert.deepEqual(names(await c.fresh({ waitMs: 50 })), ["a"], "the last read, answered while the new one waits");
  assert.ok(Date.now() - began < 1_000, "answered within its wait, not the read's");
  release(factsOf(["a", "b"]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(names(c.facts()), ["a", "b"], "taken when it ended");
});

/** A catalog whose reads are each released by hand, counting how many ran and how many ran at once. */
function handCatalog(database: () => string[], o: { now?: () => number } = {}) {
  const releases: Array<(fail?: string) => void> = [];
  const counts = { reads: 0, atOnce: 0, most: 0 };
  const c = sourceCatalog(factsOf(["a"]), () => {
    counts.reads++; counts.atOnce++; counts.most = Math.max(counts.most, counts.atOnce);
    const seen = factsOf(database());
    return new Promise<SourceFacts>((resolve, reject) => {
      releases.push((fail) => { counts.atOnce--; if (fail === undefined) resolve(seen); else reject(new Error(fail)); });
    });
  }, { log: () => undefined, ...(o.now ? { now: o.now } : {}) });
  return { c, releases, counts };
}
const settle = () => new Promise((r) => setImmediate(r));

// THE RE-CHECK OF PR 900 (finding 2): an actor was handed a read begun before it asked, and answered "no table" of a
// table made after that read began
test("an actor is never given a read begun before it asked: one that ended, one running, however young", async () => {
  let database = ["a"];
  const { c, releases, counts } = handCatalog(() => database);
  const first = c.ask();
  assert.equal(counts.reads, 1, "no read running: one begins at once");
  releases[0]!();
  const got = await c.wait(first);
  assert.ok(got !== null && "facts" in got);
  // a table made after that read ended: the next actor has a read of its own, never the one that ended a moment ago
  database = ["a", "zz_stale3"];
  const second = c.ask();
  assert.notEqual(second, first);
  assert.equal(counts.reads, 2);
  // a table made while a read runs: the actor asking then is given the NEXT read, which begins after it asked
  database = ["a", "zz_stale3", "made_while_running"];
  const third = c.ask();
  assert.notEqual(third, second, "never the read running, begun before it asked");
  assert.equal(counts.reads, 2, "the next read waits for the one running");
  releases[1]!();
  await settle();
  assert.equal(counts.reads, 3, "and begins once it ends");
  releases[2]!();
  const own = await c.wait(third);
  assert.ok(own !== null && "facts" in own);
  assert.deepEqual(names(own.facts), ["a", "zz_stale3", "made_while_running"]);
});

// THE RE-CHECK OF PR 900 (finding 3): six Columns asks and six adds within a second put eleven reads on the source at once
test("one read at a time on the database: every actor asking while one runs shares the next, whatever their number", async () => {
  const { c, releases, counts } = handCatalog(() => ["a"]);
  c.ask();
  const asked = Array.from({ length: 12 }, () => c.ask());
  assert.equal(new Set(asked).size, 1, "the twelve share one read");
  assert.equal(counts.reads, 1, "beside the one running, none yet");
  void c.fresh();
  assert.equal(counts.reads, 1, "what shows the catalog shares what runs, never a read beside it");
  releases[0]!();
  await settle();
  releases[1]!();
  for (const r of await Promise.all(asked.map((n) => c.wait(n)))) assert.ok(r !== null && "facts" in r);
  assert.deepEqual([counts.reads, counts.most], [2, 1], "two reads in all, never two at once");
});

// THE RE-CHECK OF PR 900 (finding 1): an add of a 10,000-table catalog (44 s a read) failed ten times, "still being read",
// its second step beginning a read of its own; and `mason add a b c` cost a read a table
test("a read longer than one request's wait is waited on again by its number, and serves every later step of the act: one read", async () => {
  let now = 0;
  const { c, releases, counts } = handCatalog(() => ["a", "zz_new2"], { now: () => now });
  const read = c.ask();
  now += 20_000;
  const late = await c.wait(read, { waitMs: 20 });
  assert.deepEqual(late, { running: 20 });
  now += 20_000;
  assert.deepEqual(await c.wait(read, { waitMs: 20 }), { running: 40 }, "the same read, still running");
  releases[0]!();
  const done = await c.wait(read, { waitMs: 20 });
  assert.ok(done !== null && "facts" in done);
  assert.deepEqual(names(done.facts), ["a", "zz_new2"]);
  // the add's next steps (one per table) carry the number: answered at once, no read more
  for (let i = 0; i < 3; i++) assert.ok("facts" in (await c.wait(read))!);
  assert.equal(counts.reads, 1);
  // a number never given: null, the actor asks again
  assert.equal(await c.wait(read + 5), null);
  assert.equal(await c.wait(0), null);
});

test("a read that does not end within readTimeoutMs fails: its connection is closed through the signal, the last read kept and said", async () => {
  let signal: AbortSignal | null = null;
  const logged: string[] = [];
  const c = sourceCatalog(factsOf(["a"]), (s) => { signal = s; return new Promise<SourceFacts>(() => undefined); },
    { log: (m) => logged.push(m), readTimeoutMs: 30 });
  assert.deepEqual(await c.wait(c.ask()), { failed: "no answer within 0 s" });
  assert.equal(signal!.aborted, true, "the read is told to close its connection");
  assert.equal(logged.length, 1);
  assert.deepEqual(names(c.facts()), ["a"], "the last read kept for what shows it");
});

test("a read is held to no cap a large catalog can need: the last guard is a quarter of an hour", () => {
  assert.ok(CATALOG_READ_TIMEOUT_MS >= 10 * 60_000, String(CATALOG_READ_TIMEOUT_MS));
});

test("an actor whose read fails has the failure and its reason, never the last read in its place; the next actor reads again", async () => {
  const { c, releases, counts } = handCatalog(() => ["a", "h6_new"]);
  const n = c.ask();
  releases[0]!("canceling statement due to lock timeout");
  const r = await c.wait(n);
  assert.deepEqual(r, { failed: "canceling statement due to lock timeout" });
  assert.deepEqual(catalogFailure(r!, "shop"), { code: "failed", message: "the tables of shop could not be read just now: canceling statement due to lock timeout",
    why: "another session holds a lock on one of its tables (a migration, often), and Mason waits on a lock at most 2 s",
    fix: "run it again once that session's transaction ends", next: [["mason doctor", "checks the machine and the project's database"]] });
  assert.equal(catalogFailure({ running: 21 }, "shop")!.message, "the tables of shop are still being read (for 21 s)");
  c.ask();
  assert.equal(counts.reads, 2, "a new ask after a failure reads again");
});

test("actRead: a carried number is waited on; a number this run never gave is a read of its own; the failure is said", async () => {
  const { c, releases } = handCatalog(() => ["a"]);
  const p = actRead(c, null, "shop", 20);
  const r = await p;
  assert.equal(r.running, true);
  assert.equal(r.failure?.message, "the tables of shop are still being read (for 0 s)");
  releases[0]!();
  const again = await actRead(c, r.read, "shop", 20);
  assert.deepEqual(again, { read: r.read, failure: null, running: false });
  const made = await actRead(c, 999, "shop", 20);
  assert.notEqual(made.read, 999);
});

// THE RE-CHECKS OF PR 900 (finding 4): a connection silent after login held every add for the whole quarter of an hour;
// then a source that stopped answering altogether did the same, its check "couldn't tell" every time
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const watchTimes = { lookMs: 5, quietMs: 40, giveUpMs: 150, checkMs: 20 };

test("a read's watch: while bytes arrive the read progresses, and the database is never asked", async () => {
  let checks = 0;
  const said: string[] = [];
  const stop = stallWatch({ ...watchTimes, lastHeard: () => Date.now(), check: async () => { checks++; return "never"; }, onSilent: (why) => said.push(why) });
  await sleep(250);
  stop();
  assert.deepEqual([checks, said], [0, []]);
});

test("a read's watch: quiet, the database is asked; working on it is a slow read, never cut; not working on it ends the read once", async () => {
  const heard = Date.now();
  const slow: string[] = [];
  let asked = 0;
  const stop = stallWatch({ ...watchTimes, lastHeard: () => heard, check: async () => { asked++; return null; }, onSilent: (why) => slow.push(why) });
  await sleep(300);
  stop();
  assert.ok(asked >= 2, `asked ${asked} times`);
  assert.deepEqual(slow, [], "a long query the database works on is never cut, however long past giveUpMs");
  const said: string[] = [];
  let checks = 0;
  const stop2 = stallWatch({ ...watchTimes, lastHeard: () => heard, check: async () => (++checks === 1 ? null : "its session is gone from the database"), onSilent: (why) => said.push(why) });
  await sleep(200);
  stop2();
  assert.deepEqual(said, ["its session is gone from the database"]);
  assert.equal(checks, 2, "no check after it");
});

test("a read's watch: a source that cannot be asked either ends the read once nothing was heard for giveUpMs, never before", async () => {
  const heard = Date.now();
  const said: Array<{ why: string; at: number }> = [];
  let checks = 0;
  const stop = stallWatch({ ...watchTimes, lastHeard: () => heard, check: async () => { checks++; throw new Error("connect ETIMEDOUT"); }, onSilent: (why) => said.push({ why, at: Date.now() - heard }) });
  await sleep(320);
  stop();
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.ok(said[0]!.at >= watchTimes.giveUpMs, `ended at ${said[0]!.at} ms`);
  assert.match(said[0]!.why, /^nothing came from the database for \d+ s, and it could not be asked whether it still works on the read \(connect ETIMEDOUT\): the connection went silent$/);
  assert.ok(checks >= 2, "looked again while it could not tell");
});

test("a read's watch: a check that never answers is given up at checkMs, its connection told to close, and the watch goes on", async () => {
  const heard = Date.now();
  const signals: AbortSignal[] = [];
  const said: string[] = [];
  const stop = stallWatch({ ...watchTimes, lastHeard: () => heard, check: (signal) => { signals.push(signal); return new Promise<null>(() => undefined); }, onSilent: (why) => said.push(why) });
  await sleep(320);
  stop();
  assert.ok(signals.length >= 2, `asked ${signals.length} times: a hung check never stops the watch`);
  assert.ok(signals.slice(0, -1).every((s) => s.aborted), "each one given up is told to close");
  assert.equal(said.length, 1);
  assert.match(said[0]!, /\(no answer within 0 s\)/);
});

// THE COMMAND'S SIDE (src/cli/control.ts callRunReading): it asks again carrying the read's number while the read runs,
// and hands the number to its next request
test("a command waits on its read by its number, across requests, and carries it on", async () => {
  const http = await import("node:http");
  const { callRunReading } = await import("../src/cli/control.ts" as string).catch(() => ({})) as typeof import("../src/cli/control.ts");
  const seen: Array<string | undefined> = [];
  let answers = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-mason-catalog-read"] as string | undefined);
    answers++;
    if (answers <= 2) { res.writeHead(503, { "Content-Type": "application/json", "x-mason-catalog-read": "7" }).end(JSON.stringify({ error: "still", catalogRead: 7, failure: { code: "failed", message: "still" } })); return; }
    res.writeHead(200, { "Content-Type": "application/json", "x-mason-catalog-read": "7" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const run = { name: "shop", pid: process.pid, control: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" } } as unknown as Parameters<typeof callRunReading>[0];
    const progress: string[] = [];
    const r = await callRunReading(run, "GET", "/api/state?columns=1&fresh=1", undefined, null, { progress: (said) => progress.push(said) });
    assert.deepEqual([r.status, r.read], [200, 7]);
    assert.deepEqual(seen, [undefined, "7", "7"], "asked again carrying the read's number");
    assert.deepEqual(progress, ["still", "still"], "a person is told, at each ask, that the read goes on");
    const pick = await callRunReading(run, "POST", "/api/pick", { table: "x" }, r.read);
    assert.equal(pick.status, 200);
    assert.equal(seen.at(-1), "7", "the next step carries it");
  } finally { server.close(); }
});

// THE PAGE'S SIDE (src/web/shared.js createAsk): the same, for a Columns or Sync choice, an add or a remove
test("the page asks again carrying the read's number while it runs, with the run's header name", async () => {
  const shared = await import("../src/web/shared.js" as string) as { createAsk: (f: unknown) => (path: string, init?: Record<string, unknown>) => Promise<unknown>; CATALOG_READ_HEADER?: string };
  assert.equal(shared.CATALOG_READ_HEADER, CATALOG_READ_HEADER);
  const seen: Array<unknown> = [];
  let n = 0;
  const ask = shared.createAsk(async (_path: string, init: { headers?: Record<string, string> }) => {
    seen.push(init.headers?.[CATALOG_READ_HEADER]);
    n++;
    return n < 3 ? { ok: false, status: 503, text: async () => JSON.stringify({ error: "still", catalogRead: 4 }) } : { ok: true, status: 200, text: async () => JSON.stringify({ table: "t", columns: [] }) };
  });
  assert.deepEqual(await ask("api/tables/t/columns"), { body: { table: "t", columns: [] } });
  assert.deepEqual(seen, [undefined, "4", "4"]);
});

// THE REVIEW OF PR 900 AT 0d5a63fc, B2: "fresh" counted from when the last read BEGAN, so a read over a minute long was
// stale the moment it ended: the add that had waited on it began a second, and an open page read back to back
test("a read longer than a minute is fresh for a minute after it ENDS: what shows the catalog reuses it, never a read again at once", async () => {
  let now = CATALOG_FRESH_MS, reads = 0;
  let release: (f: SourceFacts) => void = () => undefined;
  const c = sourceCatalog(factsOf(["a"]), () => { reads++; return new Promise<SourceFacts>((r) => { release = r; }); }, { log: () => undefined, now: () => now });
  now += CATALOG_FRESH_MS;
  // an actor's read, 155 s long (the review's throttled catalog)
  const read = c.ask();
  now += 155_000;
  release(factsOf(["a", "b"]));
  const got = await c.wait(read);
  assert.ok(got !== null && "facts" in got);
  assert.equal(reads, 1);
  // the add's next step and an open page's polls, at once and a while after: the read that just ended
  assert.deepEqual(names(await c.fresh({ waitMs: 2_000 })), ["a", "b"]);
  now += CATALOG_FRESH_MS - 1;
  assert.deepEqual(names(await c.fresh({ waitMs: 2_000 })), ["a", "b"]);
  assert.equal(reads, 1, "one read, however long it took");
  // a minute after it ended: read again
  now += 1;
  const again = c.fresh();
  assert.equal(reads, 2);
  release(factsOf(["a", "b", "c"]));
  assert.deepEqual(names(await again), ["a", "b", "c"]);
});

/** A fake connection of a catalog read: each statement recorded; one matching `slow` answers after `slowMs`, or fails
 *  with Postgres's cancel when a CancelRequest is sent first. */
function fakeConnection(o: { slow: RegExp; slowMs: number; events: string[]; statements: string[] }) {
  let cancelPending: ((e: Error) => void) | null = null;
  return {
    lastHeardAt: Date.now(),
    query: (sql: string) => {
      o.statements.push(sql);
      if (!o.slow.test(sql)) return Promise.resolve({ rows: [["x"]] });
      return new Promise<{ rows: Array<Array<string | null>> }>((resolve, reject) => {
        const t = setTimeout(() => resolve({ rows: [["x"]] }), o.slowMs);
        cancelPending = (e) => { clearTimeout(t); reject(e); };
      });
    },
    cancel: async () => { o.events.push("cancel"); cancelPending?.(new Error("canceling statement due to user request")); },
    close: () => { o.events.push("close"); },
  };
}
const quick = { lookMs: 10, quietMs: 30, giveUpMs: 150, checkMs: 100 };

// THE REVIEW OF PR 900 AT 0d5a63fc, B1: the watch asked pg_stat_activity about BackendKeyData's process id, which a
// pooler rewrites to its own: no row, "its session is gone", and every read of a large catalog ended after 15 s
test("a read's session is found by its statement's comment, never by a process id: a statement the database works on is never cut, however long", async () => {
  const events: string[] = [], statements: string[] = [], checks: string[] = [];
  let connects = 0;
  const main = fakeConnection({ slow: /json_agg/, slowMs: 400, events, statements });
  const facts = await watchedRead({
    connect: async () => {
      if (connects++ === 0) return main;
      return { lastHeardAt: Date.now(), cancel: async () => undefined, close: () => undefined,
        query: async (sql: string) => { checks.push(sql); return { rows: [["active", null, "1"]] }; } };
    },
    read: async (pg) => { await pg.query("SELECT version()"); await pg.query("SELECT json_agg(t) FROM t"); return factsOf(["a"]); },
    signal: new AbortController().signal, log: () => undefined, mark: "mason catalog read test1", watch: quick,
  });
  assert.deepEqual(names(facts), ["a"], "read to its end: 400 ms, past the 150 ms a silent one is given");
  assert.deepEqual(statements.map((q) => /^\/\* mason catalog read test1 (\d+) \*\/ /.exec(q)?.[1]), ["1", "2", "3"], "each statement begins with the read's comment and its number");
  assert.ok(checks.length > 0, "the database was asked");
  for (const q of checks) {
    assert.match(q, /WHERE query LIKE '\/\* mason catalog read test1 3 \*\/%'/, "about the statement running now, by its comment");
    assert.doesNotMatch(q, /\bpid\b/, "never by a process id");
  }
  assert.deepEqual(events, ["close"], "never cancelled; closed once");
});

test("a read given up on is cancelled on the database, through its own connection's way, before that connection is closed", async () => {
  const events: string[] = [], statements: string[] = [];
  let connects = 0;
  const main = fakeConnection({ slow: /json_agg/, slowMs: 60_000, events, statements });
  const began = Date.now();
  await assert.rejects(watchedRead({
    connect: async () => {
      if (connects++ === 0) return main;
      // the database: done with the read's statement, whose results never arrived
      return { lastHeardAt: Date.now(), cancel: async () => undefined, close: () => undefined,
        query: async () => ({ rows: [["idle", "ClientRead", "20"]] }) };
    },
    read: async (pg) => { await pg.query("SELECT json_agg(t) FROM t"); return factsOf(["a"]); },
    signal: new AbortController().signal, log: () => undefined, watch: quick,
  }), /the database has had nothing to do for it for 20 s \(its session is idle\): the connection went silent/);
  assert.ok(Date.now() - began < 5_000);
  assert.deepEqual(events, ["cancel", "close"], "the cancel first, then the connection closed");
  // a read past its last guard: the same
  const events2: string[] = [];
  const stop = new AbortController();
  const p = watchedRead({ connect: async () => fakeConnection({ slow: /json_agg/, slowMs: 60_000, events: events2, statements: [] }),
    read: async (pg) => { await pg.query("SELECT json_agg(t) FROM t"); return factsOf(["a"]); }, signal: stop.signal, log: () => undefined });
  await settle();
  stop.abort();
  await assert.rejects(p, /the read ran out of time/);
  assert.deepEqual(events2, ["cancel", "close"]);
});

test("what the database says of the read's statement: working, or why it went silent, or couldn't tell", () => {
  assert.equal(statementVerdict([["active", null, "3"]]), null);
  assert.equal(statementVerdict([["idle", "ClientRead", "40"], ["active", "Lock", "2"]]), null, "the statement working on one session is working");
  assert.match(statementVerdict([["active", "ClientWrite", "30"]])!, /results for it that do not arrive/);
  assert.match(statementVerdict([["idle in transaction", null, "17.4"]])!, /nothing to do for it for 17 s \(its session is idle in transaction\)/);
  assert.throws(() => statementVerdict([]), /runs no statement of the read just now/, "queued in a pooler, or gone: couldn't tell");
  assert.throws(() => statementVerdict([[null, null, null]]), /does not show the read's session/);
});
