/**
 * `mason start`'s decisions (src/cli/dev.ts, replication-mode.ts): what a database moved to another server, or swapped
 * for another, means; how the change mode and the replication names are chosen; and what the readiness check refuses.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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
  assert.match(refused.refuse, /synced data is of the database shop, and \.mason\/config\.json now names shop_staging\. .*mason destroy \(removes the synced data; your files stay\), then mason start syncs it/);
});

test("replication's objects are the project's and the source's names", async () => {
  const { projectReplication, dropStatements } = await import("../src/cli/replication-mode.ts");
  assert.deepEqual(projectReplication("my-shop", "app"), { publication: "mason_dev_my_shop_app", slot: "mason_dev_my_shop_app", owned: true });
  assert.equal(projectReplication("shop", "Shop-Dev").slot, "mason_dev_shop_shop_dev", "lower case, as a slot's name must be");
  assert.equal(dropStatements(projectReplication("shop", "app")),
    "SELECT pg_drop_replication_slot('mason_dev_shop_app') FROM pg_replication_slots WHERE slot_name = 'mason_dev_shop_app' AND NOT active; DROP PUBLICATION IF EXISTS mason_dev_shop_app;");
});

test("two projects both answering as mason keep a slot each: the slot is the project's name, never the database a tool connects with", async () => {
  const { projectReplication } = await import("../src/cli/replication-mode.ts");
  const { connectDatabase } = await import("../src/lib/database-name.ts");
  assert.equal(connectDatabase({ database: null }, {}, {}), "mason", "the same name to every tool, whatever the project's");
  const [a, b] = ["shop", "billing"].map((name) => projectReplication(name, "app"));
  assert.notEqual(a!.slot, b!.slot, "two projects on one source: a shared slot would hand each the other's changes");
  assert.notEqual(a!.publication, b!.publication);
  // the run gives the slot the project's name and everything a tool reads the other: read from the run's own lines
  const dev = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "cli", "dev.ts"), "utf8");
  assert.match(dev, /projectReplication\(cfg\.name, src\.name,/);
  assert.match(dev, /postgresApiUrl\(pgAddress, database,/);
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

test("what a start replicating no table and mason destroy drop is what the start recorded, never the name computed again", async () => {
  const { madeReplication } = await import("../src/cli/replication-mode.ts");
  const recorded = { slot: "mason_dev_shop", publication: "mason_dev_shop", owned: true };
  assert.deepEqual(madeReplication({ name: "shop", publication: null, replication: recorded }, "app"), recorded, "a slot made under another rule is the one dropped");
  assert.deepEqual(madeReplication({ name: "shop", publication: "app_pub", replication: null }, "app"), { publication: "app_pub", slot: "mason_dev_shop_app", owned: false },
    "no record: the names the rule gives now");
});

// a publication the operator names is the database owner's — read as it is, never altered or dropped
test("a named publication is the sources file's, else PG_PUBLICATION — never the one a start recorded; it is never Mason's to drop, and the slot stays the project's", async () => {
  const { namedPublication, projectReplication, dropStatements } = await import("../src/cli/replication-mode.ts");
  const none = { publicationName: null };
  assert.deepEqual(namedPublication({ publicationName: "file_pub" }, { PG_PUBLICATION: "env_pub" }), { name: "file_pub", from: "file" }, "the file first");
  assert.deepEqual(namedPublication(none, { PG_PUBLICATION: "env_pub" }), { name: "env_pub", from: "env" });
  // a start recorded owners_pub (config.json publication), then publication: was taken out of the file: Mason's own,
  // never the record — the function takes no record to fall back to
  assert.equal(namedPublication(none, {}), null, "none named: Mason's own");
  assert.deepEqual(projectReplication("shop", "app", namedPublication(none, {})?.name ?? null).owned, true, "a file naming none starts owned");
  const named = projectReplication("shop", "app", "app_pub");
  assert.deepEqual(named, { publication: "app_pub", slot: "mason_dev_shop_app", owned: false });
  assert.equal(dropStatements(named), "SELECT pg_drop_replication_slot('mason_dev_shop_app') FROM pg_replication_slots WHERE slot_name = 'mason_dev_shop_app' AND NOT active;",
    "the slot alone: the publication is its owner's");
  assert.equal(projectReplication("shop", "app", "mason_dev_shop_app").owned, true, "Mason's own name, named, is still Mason's own (replicationNames' rule)");
});

test("a lost slot is said as what Mason does: a new slot and one poll per table, never a sync from scratch", async () => {
  const { replicationChecks } = await import("../src/cli/replication-checks.ts");
  const facts = (o: Partial<ServerFacts> = {}): ServerFacts => ({
    version: 160004, versionText: "16.4", standby: false, user: "mason", walLevel: "logical", slotWalKeepMb: 8192,
    maxSlots: 10, slotsUsed: 1, maxSenders: 10, sendersUsed: 1, superuser: false, replication: true, rds: null, cloudSql: false,
    hotStandbyFeedback: true, idleInTransactionMs: 0, statementTimeoutMs: 0, walBytesPerSecond: 1024 ** 3 / 86_400 * 64, ...o,
  });
  const said = "Mason makes a new slot and catches each table up with one poll (a scan of each table on your database), never a full sync";
  const detail = (f: ServerFacts, name: string, slot: Parameters<typeof replicationChecks>[2] = null): string =>
    replicationChecks(f, "mason_dev_shop", slot).find((c) => c.name === name)!.detail;
  const lost = detail(facts(), "slot", { active: false, activePid: null, walStatus: "lost", plugin: "pgoutput" });
  const standby = detail(facts({ standby: true, hotStandbyFeedback: false }), "standby");
  const cap = detail(facts(), "WAL cap");
  assert.equal(lost, `mason_dev_shop exists and Postgres invalidated it (wal_status lost): ${said}`);
  assert.match(standby, /hot_standby_feedback is off: the primary may remove catalog rows the slot still needs, which invalidates it \(Mason makes a new slot and catches each table up with one poll \(a scan of each table on your database\), never a full sync\) — turn it on$/);
  assert.ok(cap.includes(`past it Postgres invalidates the slot rather than fill its disk, and ${said}. A day of this server's WAL is about`), cap);
  assert.ok(cap.endsWith("an outage longer than the cap's worth means that catch-up"), cap);
  for (const text of [lost, standby, cap]) assert.doesNotMatch(text, /from scratch|rebuild/);
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
  assert.match(v.refused[0]!.detail, /^this database is a read replica, where Mason cannot make its publication mason_dev_shop \(CREATE PUBLICATION is refused on a standby\)\. Create one on the primary for the tables whose sync: is replication, then name it: publication: <name> at the top of the sources file$/);
  assert.deepEqual(refused(standby, named), []);
  assert.deepEqual(refused(facts({ standby: true, replication: true, version: 150004, versionText: "15.4" }), named), ["standby"], "before 16 a standby decodes nothing");
  // the way out to polling is the table's sync:, never --poll (gone; a review finding)
  const detail = (f: ServerFacts, name: string): string => readinessVerdict(f, "mason_dev_shop", null, named).refused.find((c) => c.name === name)!.detail;
  assert.match(detail(facts({ replication: true, walLevel: "replica" }), "wal_level"), /Or poll the table instead: give its entry sync: poll <interval> in the sources file \(SELECTs alone, no change log\)$/);
  assert.match(detail(facts({ standby: true, replication: true, version: 150004, versionText: "15.4" }), "standby"), /or poll the table: give its entry sync: poll <interval> in the sources file$/);
  for (const n of ["wal_level", "standby"]) assert.doesNotMatch(detail(facts({ replication: true, walLevel: "replica", standby: true, version: 150004, versionText: "15.4" }), n), /--poll/);
  // a slot another reader holds: the way out is this project's own stop, and the pid to end when a run crashed
  const held = readinessVerdict(facts({ replication: true }), "mason_dev_shop", { active: true, activePid: 4242, walStatus: "reserved", plugin: "pgoutput" }, own);
  assert.deepEqual(held.refused.map((c) => c.name), ["slot"]);
  assert.match(held.refused[0]!.detail, /is in use by another reader \(pid 4242 on the database\): one slot has one reader\. Stop the other Mason for this project \(mason stop\)\. .*SELECT pg_terminate_backend\(4242\) ends it now$/);
  // an unlimited WAL cap is worth saying, never a reason to refuse a run on a laptop's database
  const uncapped = readinessVerdict(facts({ replication: true, slotWalKeepMb: -1 }), "mason_dev_shop", null, own);
  assert.deepEqual([uncapped.refused, uncapped.warnings.map((c) => c.name)], [[], ["WAL cap"]]);
});

test("what the config records and the file does not say is refused, by what the file says: any sync: is a choice, publication: names or declines the recorded one", async () => {
  const { recordRefusal, namedPublication } = await import("../src/cli/replication-mode.ts");
  const { parseSourceText } = await import("../src/cli/sources.ts");
  const shown = "mason/sources/app.yml";
  const file = (text: string, publicationName: string | null = null) => {
    const f = parseSourceText(`kind: postgres\nurl: x\n${text}`, "app", "/p/mason/sources/app.yml");
    assert.ok(!("problems" in f), JSON.stringify(f));
    return { ...f, publicationName };
  };
  // the config a 0.7.0 start wrote (v0.7.0 src/cli/dev.ts: changes, publication, replication), Mason's own and a named one
  const own = { changes: "replication" as const, publication: null, replication: { slot: "mason_dev_shop_app", publication: "mason_dev_shop_app", owned: true } };
  const named = { changes: "replication" as const, publication: "app_pub", replication: { slot: "mason_dev_shop_app", publication: "app_pub", owned: false } };
  const silent = file("tables:\n  orders: {}\n");
  const refused = (cfg: Parameters<typeof recordRefusal>[0], f: Parameters<typeof recordRefusal>[1], env: NodeJS.ProcessEnv = {}) => recordRefusal(cfg, f, env, shown, "mason start");

  assert.deepEqual(refused(own, silent), {
    message: "this project streams, and mason/sources/app.yml does not say so: no sync: at its top or on an entry", code: "refused",
    why: "an older Mason recorded that this project streams every table (changes: replication in .mason/config.json); left unsaid, sync is off, which drops replication slot mason_dev_shop_app and Mason's publication, and streaming again reads every table whole from your database",
    fix: "to keep streaming, write sync: replication at the top of mason/sources/app.yml; to drop replication slot mason_dev_shop_app and Mason's publication, confirm it with sync: off or sync: poll <interval> there",
    next: [["mason start", "once the file says it; nothing was dropped or changed"]] });
  // both at once: the first edit never meets the second refusal, and an owner's publication is never said to be dropped
  const both = refused(named, silent);
  assert.match(both!.fix!, /^to keep streaming, write sync: replication and publication: app_pub at the top of mason\/sources\/app\.yml; to drop replication slot mason_dev_shop_app, confirm/);
  assert.doesNotMatch(both!.why!, /Mason's publication/);
  // 0.7.0's own record of a project that polls, and a project of this release that never streamed, pass
  assert.equal(refused({ changes: "poll", publication: null, replication: null }, silent), null);
  assert.equal(refused({}, silent), null);
  // a sync: anywhere is the file saying so, whichever it says: a project that chose polling has a way through
  for (const text of ["sync: off\ntables:\n  orders: {}\n", "sync: poll 5m\ntables:\n  orders: {}\n", "tables:\n  orders: { sync: off }\n  events: {}\n", "tables:\n  orders: { sync: poll 30s }\n", "sync: off\ntables: {}\n"]) {
    assert.equal(refused(own, file(text)), null, text);
    assert.equal(refused(named, file(text)), null, `${text}: nothing is replicated, so no publication is read`);
  }
  assert.equal(refused(own, file("sync: replication\ntables:\n  orders: {}\n")), null);
  // no sources file (mason serve would write one saying sync: off, no one's choice)
  const noFile = recordRefusal(own, null, {}, "project/sources/<name>.yml", "mason serve")!;
  assert.equal(noFile.message, "this project streams, and it has no sources file to say so");
  assert.equal(noFile.fix, "mount the project folder with its sources file (MASON_PROJECT), or make project/sources/<name>.yml there with kind: postgres, url: ${DATABASE_URL}, tables: and the tables it streams, " +
    "and sync: replication to keep streaming; sync: off or sync: poll <interval> in it instead confirms dropping replication slot mason_dev_shop_app and Mason's publication");
  // THE CLASS: a project of this release, its slot recorded and no `changes`, whose line was taken out
  const current = { publication: null, replication: own.replication };
  const lost = refused(current, silent)!;
  assert.equal(lost.message, "this project streams, and mason/sources/app.yml does not say so: no sync: at its top or on an entry");
  assert.equal(lost.why, ".mason/config.json records that this project streams; left unsaid, sync is off, which drops replication slot mason_dev_shop_app and Mason's publication, and streaming again reads every table whole from your database");
  assert.equal(refused(current, file("sync: off\ntables:\n  orders: {}\n")), null, "the drop confirmed");
  assert.equal(refused(current, file("tables: {}\n")), null, "no table left: nothing to read whole again");
  assert.ok(recordRefusal(current, null, {}, "s", "mason serve"), "no file at all is no decision");
  assert.equal(refused({ replication: null }, silent), null, "no slot: the default");
  assert.deepEqual(recordRefusal(own, null, {}, "project/sources/<name>.yml", "mason serve")!.next, [["mason serve", "once the file says it; nothing was dropped or changed"]]);

  // the recorded publication
  const replicates = file("sync: replication\ntables:\n  orders: {}\n");
  assert.deepEqual(refused(named, replicates), {
    message: "this project reads publication app_pub, and mason/sources/app.yml does not name it", code: "refused",
    why: ".mason/config.json records app_pub, its owner's, named at an earlier start; with no publication: line and no PG_PUBLICATION, Mason would make and read a publication of its own on your database instead",
    fix: "to keep reading it, write publication: app_pub at the top of mason/sources/app.yml; for a publication of Mason's own, write publication: null there",
    next: [["mason start", "once the file says it; nothing was dropped or changed"]] });
  // one entry replicated is enough, and the record alone (`changes` deleted by a later start) too
  assert.ok(refused({ publication: "app_pub" }, file("tables:\n  orders: { sync: replication }\n")));
  // the three ways through: the file names it, the environment names it, the file declines it
  assert.equal(refused(named, file("sync: replication\npublication: app_pub\ntables:\n  orders: {}\n", "app_pub")), null);
  assert.equal(refused(named, replicates, { PG_PUBLICATION: "app_pub" }), null);
  const declined = file("sync: replication\npublication: null\ntables:\n  orders: {}\n");
  assert.equal(refused(named, declined), null);
  assert.equal(namedPublication(declined, { PG_PUBLICATION: "env_pub" }), null, "publication: null is the file's, and the file is first");
  // the two together are a CREATE on the source said by neither: refused, on any project, with a replicated table or not
  assert.deepEqual(refused({}, declined, { PG_PUBLICATION: "env_pub" }), {
    message: "mason/sources/app.yml says publication: null, and PG_PUBLICATION names env_pub", code: "refused",
    why: "one asks Mason to make a publication of its own on your database, the other to read that one, and the file would win by saying nothing of the setting",
    fix: "for Mason's own, unset PG_PUBLICATION; to read env_pub, take publication: null out of mason/sources/app.yml",
    next: [["mason start", "once the file says it; nothing was dropped or changed"]] });
  assert.ok(refused({}, file("sync: off\npublication: null\ntables: {}\n"), { PG_PUBLICATION: "env_pub" }));
  assert.equal(refused({}, declined, { PG_PUBLICATION: "" }), null, "set empty is unset");
  // a project with no record is untouched: Mason's own, as ever
  assert.equal(refused({ publication: null }, replicates), null);
});

test("mason start says the file's sync once — and LOUDLY when an upgrade stops the polls: no sync: written anywhere over a copy that holds tables", async () => {
  const dev = await import("../src/cli/dev.ts") as unknown as { syncDefaultLine?: (file: unknown, shown: string, copiedBefore?: number) => string };
  const { parseSourceText } = await import("../src/cli/sources.ts");
  const file = (text: string) => { const f = parseSourceText(text, "app", "/p/mason/sources/app.yml"); assert.ok(!("problems" in f), JSON.stringify(f)); return f; };
  const line = dev.syncDefaultLine!;
  const older = file("kind: postgres\nurl: x\ntables:\n  orders: {}\n  customers: {}\n  events: {}\n");
  // a file an older Mason wrote, over its copy of three tables: they were polled every 5 s, and are off from now
  assert.equal(line(older, "mason/sources/app.yml", 3),
    "sync: off (the default): 3 tables are not polled (an older Mason polled every table under 1,000,000 rows every 5 s); `sync: poll 5s` at the top of mason/sources/app.yml keeps them current as before, " +
    "but polls the bigger ones too, each poll a full scan on your database: give those `sync: off` on their entry (mason tables shows the rows), or use `mason sync <table>` when you need it");
  assert.match(line(older, "mason/sources/app.yml", 1), /^sync: off \(the default\): 1 table is not polled \(an older Mason polled every table under 1,000,000 rows every 5 s\); /);
  // a new project (nothing copied yet): the default said, how to change it
  assert.equal(line(older, "mason/sources/app.yml", 0),
    "sync: off (the default): after its first sync, a table is read again only by mason sync <table> — sync: poll 5m at the top of mason/sources/app.yml polls every table, or on an entry that one");
  // a sync: written anywhere is a choice made: never the upgrade's warning
  assert.doesNotMatch(line(file("kind: postgres\nurl: x\nsync: off\ntables:\n  orders: {}\n"), "f", 3), /are not polled|is not polled/);
  assert.doesNotMatch(line(file("kind: postgres\nurl: x\ntables:\n  orders: { sync: poll 30s }\n  events: {}\n"), "f", 3), /are not polled|is not polled/);
  // a file whose default is replication: every table without its own sync streamed, said so
  assert.equal(line(file("kind: postgres\nurl: x\nsync: replication\ntables:\n  orders: {}\n"), "f", 3),
    "sync: replication (f): every table without a sync: of its own is kept current from the database's change log");
});

test("what the record names and this start no longer reads is dropped before the record names the new one: a renamed slot with Mason's own publication, Mason's own publication alone once another is named", async () => {
  const R = await import("../src/cli/replication-mode.ts" as string) as Partial<typeof import("../src/cli/replication-mode.ts")>;
  assert.equal(typeof R.staleReplication, "function", "src/cli/replication-mode.ts exports staleReplication");
  const stale = R.staleReplication!;
  const own = { slot: "mason_dev_shop_app", publication: "mason_dev_shop_app", owned: true };
  const named = { slot: "mason_dev_shop_app", publication: "owners_pub", owned: false };
  // a review finding: own → named on the same slot left mason_dev_shop_app on the database, after mason destroy too
  assert.deepEqual(stale(own, named), { drop: own, what: "publication", why: "the replicated tables are read through publication owners_pub now, its owner's" });
  // the slot renamed (the sources file renamed): both go
  assert.deepEqual(stale({ ...own, slot: "mason_dev_shop_old" }, own), { drop: { ...own, slot: "mason_dev_shop_old" }, what: "both", why: "this source's slot is mason_dev_shop_app now" });
  // named → own, the same named one, the same own one, nothing recorded: nothing of Mason's to drop
  assert.equal(stale(named, own), null, "a named one is its owner's: never dropped");
  assert.equal(stale(named, named), null);
  assert.equal(stale(own, own), null);
  assert.equal(stale(null, own), null);
});
