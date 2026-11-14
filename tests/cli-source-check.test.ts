/**
 * WHETHER THE DATABASE CAN SERVE A PROJECT, every problem on one answer (src/cli/source-check.ts, issue 779): the tables
 * against the catalog (missing, unreadable, a column, a key, row-level security), logical replication's refusals, a
 * named publication's gaps with the statement its owner runs, the project's own slot in use passing, and a database
 * that cannot be reached. The catalog read's new facts (schema USAGE, row-level security) against PGlite; the whole
 * check against a real Postgres: tests/integration/cli-source-check.itest.ts.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { TABLES_SQL, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText, type ProjectSource, type SourceFile } from "../src/cli/sources.ts";
import { readinessVerdict } from "../src/cli/replication-mode.ts";
import type { ServerFacts } from "../src/cli/replication-checks.ts";
import { describedOf, namedPublicationVerdict } from "../src/duck/publication.ts";
import { unassignedPort } from "./test-ports.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const check = await import("../src/cli/source-check.ts" as string).catch(() => ({})) as typeof import("../src/cli/source-check.ts");

const table = (source: string, o: Partial<SourceTable> = {}): SourceTable => {
  const [schema, name] = source.split(".") as [string, string];
  return { source, schema, table: name, key: ["id"], rows: 10, bytes: 8192, comment: null, foreignKeys: [], replicaIdentity: "d",
    columns: [{ name: "id", type: "integer", typeKind: "b", notNull: true, comment: null }, { name: "status", type: "text", typeKind: "b", notNull: false, comment: null }], ...o };
};
const fileOf = (text: string, root: string): SourceFile => {
  const file = path.join(root, "sources", "app.yml");
  const p = parseSourceText(text, "app", file);
  if ("problems" in p) throw new Error(p.problems.join("; "));
  return p;
};
const server = (o: Partial<ServerFacts> = {}): ServerFacts => ({
  version: 160004, versionText: "16.4", standby: false, user: "mason", walLevel: "logical", slotWalKeepMb: 8192,
  maxSlots: 10, slotsUsed: 1, maxSenders: 10, sendersUsed: 1, superuser: false, replication: true, rds: null, cloudSql: false,
  hotStandbyFeedback: true, idleInTransactionMs: 0, statementTimeoutMs: 0, walBytesPerSecond: null, ...o,
});

test("the tables: every missing one listed, each table's problem said by its entry, row-level security that hides every row refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-check-"));
  const src = fileOf("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n  ordrs: {}\n  gone: {}\n  items:\n    columns: [id, colour]\n  vault: {}\n", root);
  const facts = { tables: [table("public.orders"), table("public.items"), table("public.vault", { rowSecurityHidesFrom: "mason" })] };
  const r = check.tableCheck(src, facts, "shop", root);
  assert.deepEqual(r.problems.map((p) => [p.code, p.table]), [
    ["missing_table", "public.ordrs"], ["missing_table", "public.gone"], ["table", "public.items"], ["table", "public.vault"]]);
  assert.match(r.problems[0]!.message, /^tables\.ordrs: shop has no table public\.ordrs this user can read — did you mean `orders`\?$/);
  assert.match(r.problems[0]!.fix, /remove tables\.ordrs from sources\/app\.yml.*USAGE on its schema/);
  assert.match(r.problems[2]!.message, /tables\.items\.columns: public\.items has no column colour/);
  assert.equal(r.problems[3]!.message, "tables.vault: row-level security on public.vault hides every row from mason (no SELECT policy for it, and it is not the owner or BYPASSRLS), " +
    "so its synced table would be empty — the table's owner adds a policy for the rows Mason may read (CREATE POLICY mason_read ON public.vault FOR SELECT TO \"mason\" USING (…);), or remove its entry");
  assert.deepEqual(r.added.map((t) => t.source), ["public.orders"], "what passes is what the run would sync");
  for (const p of r.problems) assert.equal(p.sql, null);
});

test("logical replication: each refusal a problem with the statement its owner runs; the project's own slot in use is the serve running now", () => {
  const shown = "sources/app.yml";
  const repl = { publication: "mason_app", owned: true };
  const refused = (f: ServerFacts, slot: Parameters<typeof readinessVerdict>[2] = null) => check.replicationProblems(readinessVerdict(f, "mason_app", slot, repl).refused, shown);
  const all = refused(server({ walLevel: "replica", replication: false, slotsUsed: 10, maxSlots: 10 }));
  assert.deepEqual(all.map((p) => p.message.split(":")[0]), ["wal_level", "replication role", "slot"]);
  assert.equal(all[1]!.sql, "ALTER ROLE mason WITH REPLICATION;");
  assert.match(all[1]!.fix, /^the database's owner runs ALTER ROLE mason WITH REPLICATION; — or give the replicated tables' entries sync: poll <interval> in sources\/app\.yml/);
  assert.match(all[0]!.message, /^wal_level: replica: logical replication needs logical/);
  assert.equal(all[0]!.sql, null);
  assert.deepEqual(refused(server()), [], "a database that can replicate: nothing");
  // the running serve reads the project's slot through one WAL sender, the last one free: neither refuses its deploy
  const inUse = { active: true, activePid: 4242, walStatus: "reserved", plugin: "pgoutput" };
  const full = server({ maxSenders: 3, sendersUsed: 3 });
  assert.deepEqual(refused(full, inUse).map((p) => p.message.split(":")[0]), ["slot", "wal senders"], "as the start reads it");
  const own = check.ownReaderFreed(full, inUse);
  assert.deepEqual(refused(own.server, own.slot), []);
  assert.deepEqual(check.ownReaderFreed(full, null), { server: full, slot: null }, "no slot: nothing to free");
});

test("a named publication: a table it does not carry is one problem naming the ALTER PUBLICATION its owner runs; one that does not exist refuses the whole", () => {
  const shown = "sources/app.yml";
  const tables = [{ source: "public.orders", columns: [{ name: "id" }, { name: "status" }] }, { source: "public.items", columns: [{ name: "id" }] }];
  const described = describedOf({ version: 160000, publication: { all_tables: false, publish: ["insert", "update", "delete", "truncate"] }, others: [],
    tables: [{ t: "public.orders", columns: ["id", "status"], in_publication: false, published: null, row_filter: null },
      { t: "public.items", columns: ["id"], in_publication: true, published: ["id"], row_filter: null }] }, "mason");
  const p = check.publicationProblems(namedPublicationVerdict(described, tables), "mason", shown);
  assert.deepEqual(p.map((x) => [x.code, x.table, x.message, x.sql]), [["publication", "public.orders", "publication mason: missing: public.orders", "ALTER PUBLICATION mason ADD TABLE public.orders;"]]);
  assert.match(p[0]!.fix, /^the database's owner runs ALTER PUBLICATION mason ADD TABLE public\.orders; \(Mason never alters a publication it is given\)/);
  const none = describedOf({ version: 160000, publication: null, others: ["app_pub"], tables: [] }, "mason");
  const whole = check.publicationProblems(namedPublicationVerdict(none, tables), "mason", shown);
  assert.deepEqual(whole.map((x) => [x.table, x.message]), [[null, "publication mason: Found: no publication named mason. Publications on this database: app_pub."]]);
});

test("the catalog read: a table on a schema this user has no USAGE on is not one it can read; row-level security with no policy for it names the user", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE reader; CREATE SCHEMA hidden; CREATE TABLE hidden.t (id int PRIMARY KEY); CREATE TABLE public.open (id int PRIMARY KEY); " +
      "CREATE TABLE public.vault (id int PRIMARY KEY); ALTER TABLE public.vault ENABLE ROW LEVEL SECURITY; " +
      "CREATE TABLE public.shared (id int PRIMARY KEY); ALTER TABLE public.shared ENABLE ROW LEVEL SECURITY; CREATE POLICY everyone ON public.shared FOR SELECT USING (true); " +
      "CREATE TABLE public.mine (id int PRIMARY KEY); ALTER TABLE public.mine ENABLE ROW LEVEL SECURITY; CREATE POLICY readers ON public.mine FOR SELECT TO reader USING (true); " +
      "CREATE TABLE public.writes (id int PRIMARY KEY); ALTER TABLE public.writes ENABLE ROW LEVEL SECURITY; CREATE POLICY ins ON public.writes FOR INSERT TO reader WITH CHECK (true); " +
      "GRANT SELECT ON ALL TABLES IN SCHEMA public, hidden TO reader");
    const read = async (): Promise<Array<{ schema: string; table: string; row_security_hides_from: string | null }>> =>
      JSON.parse(String((await db.query<unknown[]>(TABLES_SQL, [], { rowMode: "array" })).rows[0]![0]));
    // the owner (here a superuser) reads every row: nothing hidden from it
    assert.deepEqual((await read()).filter((t) => t.row_security_hides_from !== null), []);
    await db.exec("SET ROLE reader");
    const asReader = await read();
    assert.deepEqual(asReader.map((t) => `${t.schema}.${t.table}`).sort(), ["public.mine", "public.open", "public.shared", "public.vault", "public.writes"], "hidden.t: no USAGE on hidden");
    assert.deepEqual(asReader.filter((t) => t.row_security_hides_from !== null).map((t) => [t.table, t.row_security_hides_from]), [["vault", "reader"], ["writes", "reader"]],
      "no policy, or none for SELECT: every row hidden; a policy for PUBLIC or for the user reads");
    await db.exec("RESET ROLE; GRANT USAGE ON SCHEMA hidden TO reader; SET ROLE reader");
    assert.ok((await read()).some((t) => t.schema === "hidden"), "USAGE granted: readable");
  } finally { await db.close(); }
});

test("a database that cannot be reached is one problem, the connection's own words, the password never said", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-check-"));
  const port = await unassignedPort();
  const src: ProjectSource = { ...fileOf("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n", root), resolved: `postgres://mason:hunter2-secret@127.0.0.1:${port}/shop`,
    from: "DATABASE_URL in the environment", publicationName: null };
  const r = await check.checkProjectSource(src, { name: "mason", folder: root, root, env: {} });
  assert.deepEqual(r.problems.map((p) => [p.code, p.table, p.message]), [["unreachable", null, `could not connect to postgres://mason:****@127.0.0.1:${port}/shop: nothing is listening on 127.0.0.1:${port}`]]);
  assert.deepEqual([r.tables, r.replicated], [1, 0]);
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
});

test("a table replication cannot carry (no primary key, a key: or not; REPLICA IDENTITY NOTHING) gets its table problem alone: no publication statement names it, the publication there or not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-check-"));
  const facts = { tables: [table("public.orders"), table("public.nokey", { key: [], uniqueKeys: [{ name: "nokey_id", columns: ["id"], constraint: true, nullsNotDistinct: false }] }),
    table("public.keyless", { key: [] }), table("public.ident_nothing", { replicaIdentity: "n" })] };
  const src = fileOf("kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\npublication: pub1\ntables:\n  orders: {}\n  nokey:\n    key: [id]\n  keyless: {}\n  ident_nothing: {}\n", root);
  const r = check.tableCheck(src, facts, "shop", root);
  assert.deepEqual(r.problems.map((p) => p.table), ["public.nokey", "public.keyless", "public.ident_nothing"], "each has its table problem");
  assert.deepEqual(r.streamed.map((t) => t.source), ["public.orders"], "only what replication can carry is held to the publication");
  const unreplicable = /nokey|keyless|ident_nothing/;
  const catalog = [{ t: "public.orders", columns: ["id", "status"], in_publication: false, published: null, row_filter: null }];
  // pub1 there, carrying nothing; pub1 missing: CREATE PUBLICATION … FOR TABLE names the tables held to it alone
  for (const publication of [{ all_tables: false, publish: ["insert", "update", "delete"] }, null]) {
    const v = namedPublicationVerdict(describedOf({ version: 160000, publication, others: [], tables: catalog }, "pub1"), r.streamed);
    const said = check.publicationProblems(v, "pub1", "sources/app.yml");
    assert.equal(said.length, 1);
    assert.match(said[0]!.sql ?? "", publication === null ? /^CREATE PUBLICATION pub1 FOR TABLE public\.orders WITH/ : /^ALTER PUBLICATION pub1 ADD TABLE public\.orders;$/);
    for (const p of said) for (const text of [p.sql ?? "", p.fix, p.message]) assert.doesNotMatch(text, unreplicable);
  }
});
