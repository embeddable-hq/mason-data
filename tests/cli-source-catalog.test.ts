/**
 * The database's catalog as a run holds it (src/cli/source-catalog.ts, issue 890): read again only when asked, a read
 * under a minute old reused, one read at a time shared by every asker, a failed read leaving the last in place and said
 * — and nothing read when nobody asks, whatever the time.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { SourceFacts } from "../src/cli/preflight.ts";
import { CATALOG_FRESH_MS, sourceCatalog } from "../src/cli/source-catalog.ts";

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
