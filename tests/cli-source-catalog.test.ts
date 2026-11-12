/**
 * The database's catalog as a run holds it (src/cli/source-catalog.ts, issue 890): read again only when asked, a read
 * under a minute old reused, one read at a time shared by every asker, a failed read leaving the last in place and said
 * — and nothing read when nobody asks, whatever the time.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { SourceFacts } from "../src/cli/preflight.ts";
// imported when the tests run: at a commit without the module the file still loads, and each test fails by name
const { CATALOG_FRESH_MS, sourceCatalog } = await import("../src/cli/source-catalog.ts" as string).catch(() => ({})) as typeof import("../src/cli/source-catalog.ts");

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

test("a read that does not end within readTimeoutMs fails: its connection is closed through the signal, the last read kept and said", async () => {
  let signal: AbortSignal | null = null;
  const logged: string[] = [];
  const c = sourceCatalog(factsOf(["a"]), (s) => { signal = s; return new Promise<SourceFacts>(() => undefined); },
    { log: (m) => logged.push(m), now: () => CATALOG_FRESH_MS * 2, readTimeoutMs: 30 });
  assert.deepEqual(names(await c.fresh({ maxAgeMs: 0 })), ["a"]);
  assert.equal(signal!.aborted, true, "the read is told to close its connection");
  assert.deepEqual(logged, ["the database's tables could not be read again (no answer within 0.03 s): the tables read before are shown until a read succeeds"]);
});

// THE REVIEW OF PR 900, B2: an add was refused a table mason tables had just listed, its run's read up to a minute old
test("an asker that acts on the catalog (maxAgeMs 0) has a read made after it asked: never the last one however young, never one already running", async () => {
  let now = 1_000, reads = 0;
  let database = ["a"];
  const releases: Array<() => void> = [];
  const c = sourceCatalog(factsOf(["a"]), () => { reads++; const seen = factsOf(database); return new Promise<SourceFacts>((r) => { releases.push(() => r(seen)); }); },
    { log: () => undefined, now: () => now });
  // a second after the start's read, a table is made: a shower is answered the start's read, an actor reads
  now += 1_000;
  database = ["a", "newt"];
  assert.deepEqual(names(await c.fresh()), ["a"]);
  assert.equal(reads, 0);
  const acted = c.fresh({ maxAgeMs: 0 });
  assert.equal(reads, 1);
  releases[0]!();
  assert.deepEqual(names(await acted), ["a", "newt"]);
  // a read already running when it asks began before the table it may want: a new one follows it
  now += 1_000;
  const running = c.fresh({ maxAgeMs: 0 });
  now += 1;
  database = ["a", "newt", "later"];
  const actor = c.fresh({ maxAgeMs: 0 });
  releases[1]!();
  assert.deepEqual(names(await running), ["a", "newt"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 3, "the running read, then one begun after the actor asked");
  releases[2]!();
  assert.deepEqual(names(await actor), ["a", "newt", "later"]);
});
