/**
 * `mason start`'s decisions (src/cli/dev.ts, replication-mode.ts): what a database moved to another server, or swapped
 * for another, means; how the change mode and the replication names are chosen; and what the readiness check refuses.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { sourceMove } from "../src/cli/dev.ts";
import type { ServerFacts } from "../src/cli/replication-checks.ts";

test("the server under the database: recorded at the first start, the same database on a new server read again, another database refused", () => {
  // a database that moves to a different host is the same database
  assert.deepEqual(sourceMove(null, { database: "shop", systemIdentifier: "7" }), { action: "record" });
  assert.deepEqual(sourceMove({ database: "shop", systemIdentifier: "7" }, { database: "shop", systemIdentifier: "7" }), { action: "same" });
  assert.deepEqual(sourceMove({ database: "shop", systemIdentifier: "7" }, { database: "shop", systemIdentifier: "9" }), { action: "reread" });
  assert.deepEqual(sourceMove({ database: "shop", systemIdentifier: null }, { database: "shop", systemIdentifier: "9" }), { action: "same" }, "not readable then: no move to see");
  assert.deepEqual(sourceMove({ database: "shop", systemIdentifier: "7" }, { database: "shop", systemIdentifier: null }), { action: "same" }, "not readable now: never guessed");
  const refused = sourceMove({ database: "shop", systemIdentifier: "7" }, { database: "shop_staging", systemIdentifier: "7" });
  assert.ok("refuse" in refused);
  assert.match(refused.refuse, /copy is of the database shop, and \.mason\/config\.json now names shop_staging\. .*mason destroy \(removes the copy; your files stay\), then mason start copies it/);
});

test("the change mode is the flag, else the project's, else polling; replication's objects are the project's and the source's names", async () => {
  const { changesOf, projectReplication, dropStatements } = await import("../src/cli/replication-mode.ts");
  assert.equal(changesOf(null, undefined), "poll");
  assert.equal(changesOf(null, "replication"), "replication", "kept between starts");
  assert.equal(changesOf("poll", "replication"), "poll", "--poll takes it back");
  assert.deepEqual(projectReplication("my-shop", "app"), { publication: "mason_dev_my_shop_app", slot: "mason_dev_my_shop_app", owned: true });
  assert.equal(projectReplication("shop", "Shop-Dev").slot, "mason_dev_shop_shop_dev", "lower case, as a slot's name must be");
  assert.equal(dropStatements(projectReplication("shop", "app")),
    "SELECT pg_drop_replication_slot('mason_dev_shop_app') FROM pg_replication_slots WHERE slot_name = 'mason_dev_shop_app' AND NOT active; DROP PUBLICATION IF EXISTS mason_dev_shop_app;");
});

test("a slot's name past Postgres's 63 bytes is a readable prefix and a hash of the whole name: never cut, never shared", async () => {
  const { deploymentOf, projectReplication, PG_NAME_BYTES } = await import("../src/cli/replication-mode.ts");
  const p48 = "p".repeat(40) + "_project", s48 = "s".repeat(40) + "_source1";
  // 63 bytes exactly is the readable name itself
  const fits = projectReplication("a".repeat(26), "b".repeat(26)).slot;
  assert.equal(fits, `mason_dev_${"a".repeat(26)}_${"b".repeat(26)}`);
  assert.equal(Buffer.byteLength(fits), 63);
  const long = projectReplication(p48, s48).slot;
  assert.equal(Buffer.byteLength(long), PG_NAME_BYTES);
  assert.match(long, /^mason_dev_p{40}_pro_[0-9a-f]{8}$/);
  assert.equal(projectReplication(p48, s48).slot, long, "stable: the same pair names the same slot at every start");
  // two sources whose names part only past the prefix
  const other = projectReplication(p48, `${"s".repeat(40)}_source2`).slot;
  assert.notEqual(other, long);
  assert.equal(other.slice(0, -8), long.slice(0, -8), "the same readable prefix, told apart by the hash");
  assert.match(deploymentOf(p48, s48), /^[a-z0-9_]+$/, "a valid lower-case identifier");
});

test("what --poll and mason destroy drop is what the start recorded, never the name computed again", async () => {
  const { madeReplication } = await import("../src/cli/replication-mode.ts");
  const recorded = { slot: "mason_dev_shop", publication: "mason_dev_shop", owned: true };
  assert.deepEqual(madeReplication({ name: "shop", publication: null, replication: recorded }, "app"), recorded, "a slot made under another rule is the one dropped");
  assert.deepEqual(madeReplication({ name: "shop", publication: "app_pub", replication: null }, "app"), { publication: "app_pub", slot: "mason_dev_shop_app", owned: false },
    "no record: the names the rule gives now");
});

// a publication the operator names is the database owner's — read as it is, never altered or dropped
test("a named publication is the flag's, else PG_PUBLICATION, else the recorded one; it is never Mason's to drop, and the slot stays the project's", async () => {
  const { namedPublication, projectReplication, dropStatements } = await import("../src/cli/replication-mode.ts");
  assert.deepEqual(namedPublication("app_pub", { PG_PUBLICATION: "env_pub" }, "old_pub"), { name: "app_pub", from: "flag" });
  assert.deepEqual(namedPublication(null, { PG_PUBLICATION: "env_pub" }, "old_pub"), { name: "env_pub", from: "env" });
  assert.deepEqual(namedPublication(null, {}, "old_pub"), { name: "old_pub", from: "recorded" }, "a later start of the same copy reads the one it read");
  assert.equal(namedPublication(null, {}, null), null, "none named: Mason's own");
  const named = projectReplication("shop", "app", "app_pub");
  assert.deepEqual(named, { publication: "app_pub", slot: "mason_dev_shop_app", owned: false });
  assert.equal(dropStatements(named), "SELECT pg_drop_replication_slot('mason_dev_shop_app') FROM pg_replication_slots WHERE slot_name = 'mason_dev_shop_app' AND NOT active;",
    "the slot alone: the publication is its owner's");
  assert.equal(projectReplication("shop", "app", "mason_dev_shop_app").owned, true, "Mason's own name, named, is still Mason's own (replicationNames' rule)");
});

test("the readiness check: REPLICATION, a superuser or RDS's rds_replication may replicate; a read replica needs a named publication", async () => {
  const { readinessVerdict } = await import("../src/cli/replication-mode.ts");
  const facts = (o: Partial<ServerFacts> = {}): ServerFacts => ({
    version: 160004, versionText: "16.4", standby: false, user: "mason", walLevel: "logical", slotWalKeepMb: 8192,
    maxSlots: 10, slotsUsed: 1, maxSenders: 10, sendersUsed: 1, superuser: false, replication: false, rds: null, cloudSql: false,
    hotStandbyFeedback: true, idleInTransactionMs: 0, statementTimeoutMs: 0, walBytesPerSecond: null, ...o,
  });
  const own = { publication: "mason_dev_shop", owned: true }, named = { publication: "app_pub", owned: false };
  const refused = (f: ServerFacts, r: typeof own): string[] => readinessVerdict(f, "mason_dev_shop", null, r).refused.map((c) => c.name);
  // on RDS the user has rolreplication = f and is a member of rds_replication: that is how RDS grants it
  assert.deepEqual(refused(facts({ rds: { member: true } }), own), []);
  assert.deepEqual(refused(facts({ replication: true }), own), []);
  assert.deepEqual(refused(facts({ superuser: true }), own), []);
  assert.deepEqual(refused(facts({ rds: { member: false } }), own), ["replication role"]);
  assert.deepEqual(refused(facts(), own), ["replication role"]);
  // a standby takes no CREATE PUBLICATION: refused before any slot is made unless one is named; a slot is made there (16+)
  const standby = facts({ standby: true, replication: true });
  const v = readinessVerdict(standby, "mason_dev_shop", null, own);
  assert.deepEqual(v.refused.map((c) => c.name), ["publication"]);
  assert.match(v.refused[0]!.detail, /^this database is a read replica, where Mason cannot make its publication mason_dev_shop \(CREATE PUBLICATION is refused on a standby\)\. Create one on the primary for the tables you add, then name it: mason start --replication --publication <name>$/);
  assert.deepEqual(refused(standby, named), []);
  assert.deepEqual(refused(facts({ standby: true, replication: true, version: 150004, versionText: "15.4" }), named), ["standby"], "before 16 a standby decodes nothing");
  // a slot another reader holds: the way out is this project's own stop, and the pid to end when a run crashed
  const held = readinessVerdict(facts({ replication: true }), "mason_dev_shop", { active: true, activePid: 4242, walStatus: "reserved", plugin: "pgoutput" }, own);
  assert.deepEqual(held.refused.map((c) => c.name), ["slot"]);
  assert.match(held.refused[0]!.detail, /is in use by another reader \(pid 4242 on the database\): one slot has one reader\. Stop the other Mason for this project \(mason stop\)\. .*SELECT pg_terminate_backend\(4242\) ends it now$/);
  // an unlimited WAL cap is worth saying, never a reason to refuse a run on a laptop's database
  const uncapped = readinessVerdict(facts({ replication: true, slotWalKeepMb: -1 }), "mason_dev_shop", null, own);
  assert.deepEqual([uncapped.refused, uncapped.warnings.map((c) => c.name)], [[], ["WAL cap"]]);
});

test("mason start says the file's sync once — and LOUDLY when an upgrade stops the polls: no sync: written anywhere over a copy that holds tables", async () => {
  const dev = await import("../src/cli/dev.ts") as unknown as { syncDefaultLine?: (file: unknown, shown: string, replication: boolean, copiedBefore?: number) => string };
  const { parseSourceText } = await import("../src/cli/sources.ts");
  const file = (text: string) => { const f = parseSourceText(text, "app", "/p/mason/sources/app.yml"); assert.ok(!("problems" in f), JSON.stringify(f)); return f; };
  const line = dev.syncDefaultLine!;
  const older = file("kind: postgres\nurl: x\ntables:\n  orders: {}\n  customers: {}\n  events: {}\n");
  // a file an older Mason wrote, over its copy of three tables: they were polled every 5 s, and are off from now
  assert.equal(line(older, "mason/sources/app.yml", false, 3),
    "sync: off (the default): 3 tables are not polled (an older Mason polled every table every 5 s); write `sync: poll 5s` at the top of mason/sources/app.yml to keep them current as before, " +
    "or `mason sync <table>` when you need it");
  assert.match(line(older, "mason/sources/app.yml", false, 1), /^sync: off \(the default\): 1 table is not polled \(an older Mason polled every table every 5 s\); /);
  // a new project (nothing copied yet): the default said, how to change it
  assert.equal(line(older, "mason/sources/app.yml", false, 0),
    "sync: off (the default): after its first copy, a table is read again only by mason sync <table> — sync: poll 5m at the top of mason/sources/app.yml polls every table, or on an entry that one");
  // a sync: written anywhere is a choice made: never the upgrade's warning
  assert.doesNotMatch(line(file("kind: postgres\nurl: x\nsync: off\ntables:\n  orders: {}\n"), "f", false, 3), /are not polled|is not polled/);
  assert.doesNotMatch(line(file("kind: postgres\nurl: x\ntables:\n  orders: { sync: poll 30s }\n  events: {}\n"), "f", false, 3), /are not polled|is not polled/);
  // under replication the stream keeps every table current: nothing stopped
  assert.doesNotMatch(line(older, "f", true, 3), /are not polled|is not polled/);
});
