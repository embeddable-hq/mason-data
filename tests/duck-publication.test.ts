/**
 * A PUBLICATION THE OPERATOR NAMED, READ AS IT IS (src/duck/publication.ts): the verdict over a
 * described publication — what refuses the run, what refuses one table while the others stream, what is only said — and
 * every refusal's way out: the publication EXPECTED as the found one plus the gap, in the statements its owner runs on
 * it as it is (`ALTER PUBLICATION … ADD TABLE …`), never a restatement that could drop what the owner published.
 * tests/integration/duck-stream.itest.ts holds the same against a real Postgres, with no ALTER run.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { columnListText, namedPublicationVerdict, type CopiedTable, type DescribedPublication } from "../src/duck/publication.ts";

const COLUMNS: Record<string, string[]> = { "public.items": ["id", "v", "n", "note", "total"], "public.later": ["id", "v"], "public.audit": ["id", "at"] };

/** the catalog as readNamedPublication reads it: `published` per table (null: not in the publication) */
function described(o: { published?: Record<string, string[] | null>; publish?: string[]; exists?: boolean; allTables?: boolean;
  rowFilters?: Record<string, string>; others?: string[]; serverVersion?: number; columnLists?: string[] } = {}): DescribedPublication {
  const published = o.published ?? { "public.items": ["id", "v", "n", "total"], "public.later": ["id", "v"], "public.audit": ["id", "at"] };
  return {
    tables: new Map(Object.entries(COLUMNS).map(([t, cols]) => [t, {
      columns: cols, published: o.exists === false ? null : o.allTables ? cols : published[t] ?? null, rowFilter: o.rowFilters?.[t] ?? null,
      columnList: o.columnLists?.includes(t) ?? false,
    }])),
    serverVersion: o.serverVersion ?? 160004,
    publication: { name: "app_pub", exists: o.exists ?? true, publish: o.publish ?? ["insert", "update", "delete", "truncate"], allTables: o.allTables ?? false, others: o.others ?? [] },
  };
}

/** the copy's columns: items' `total` is generated (not published before Postgres 18; the stream reads it by key) */
const ITEMS: CopiedTable = { source: "public.items", columns: [{ name: "id" }, { name: "v" }, { name: "n" }, { name: "total", generated: true }] };
const LATER: CopiedTable = { source: "public.later", columns: [{ name: "id" }, { name: "v" }] };

test("a publication carrying every synced table and column passes, a generated column and the owner's extra table aside", () => {
  const v = namedPublicationVerdict(described(), [ITEMS, LATER]);
  assert.deepEqual(v, { refused: null, tables: new Map(), noTruncate: false, listsColumns: [] });
});

test("FOR ALL TABLES carries every table", () => {
  const v = namedPublicationVerdict(described({ allTables: true }), [ITEMS, LATER]);
  assert.equal(v.refused, null);
  assert.equal(v.tables.size, 0);
});

test("a table the publication does not carry is refused ON ITS OWN, with the ADD TABLE its owner runs and the publication found", () => {
  const v = namedPublicationVerdict(described({ published: { "public.items": ["id", "v", "n"], "public.later": null, "public.audit": ["id", "at"] } }), [ITEMS, LATER]);
  assert.equal(v.refused, null, "the others stream on");
  assert.deepEqual([...v.tables.keys()], ["public.later"]);
  assert.equal(v.tables.get("public.later"), [
    "publication app_pub does not carry what Mason's synced table holds.",
    "",
    "  missing: public.later (read by Mason's sync)",
    "",
    "Expected (run as the tables' owner, or add it to your migrations):",
    "  ALTER PUBLICATION app_pub ADD TABLE",
    "    public.later;",
    "",
    "Found: publication app_pub (publish = 'insert, update, delete, truncate')",
    "    public.audit (id, at),",
    "    public.items (id, v, n)",
    "",
    "Mason reads a publication it is given as it is, never altering it: once its owner has run that, the next mason start (or mason add) checks it again. " +
      "Or give the table's entry sync: poll <interval> in the sources file, which needs no publication; or write publication: null in it, where Mason makes its own, carrying the replicated tables alone (not on a read replica).",
  ].join("\n"));
});

test("a column list without a copied column: the table dropped and added again WHOLE in one transaction, never a column list", () => {
  // a column list blocks the database's own DROP COLUMN of a listed column: what Mason expects names the table whole,
  // which carries the owner's `note` too (never less than found)
  const v = namedPublicationVerdict(described({ published: { "public.items": ["id", "note"], "public.later": ["id", "v"], "public.audit": ["id", "at"] } }), [ITEMS, LATER]);
  const m = v.tables.get("public.items")!;
  assert.match(m, /^ {2}missing: public\.items columns v, n \(read by Mason's sync\)$/m);
  assert.match(m, /\n {2}BEGIN;\n {2}ALTER PUBLICATION app_pub DROP TABLE public\.items;\n {2}ALTER PUBLICATION app_pub ADD TABLE\n {4}public\.items;\n {2}COMMIT;\n/);
  assert.doesNotMatch(m, /SET TABLE/, "never a restatement of the whole list");
  assert.deepEqual([...v.tables.keys()], ["public.items"]);
});

test("a row filter on a synced table is refused: a filtered row's delete never arrives", () => {
  const v = namedPublicationVerdict(described({ rowFilters: { "public.later": "(v <> 'draft')" } }), [ITEMS, LATER]);
  const m = v.tables.get("public.later")!;
  assert.match(m, /row filter: public\.later is published WHERE \(v <> 'draft'\); a row the filter leaves out never arrives, and neither does its delete/);
  assert.match(m, /BEGIN;\n {2}ALTER PUBLICATION app_pub DROP TABLE public\.later;\n {2}ALTER PUBLICATION app_pub ADD TABLE\n {4}public\.later;\n {2}COMMIT;/);
});

test("a publication without delete refuses the run, naming it, with the publish list widened and what it published kept", () => {
  const v = namedPublicationVerdict(described({ publish: ["insert", "update", "truncate"] }), [ITEMS, LATER]);
  assert.match(v.refused!, /^publication app_pub does not carry what Mason's synced table holds\.\n/);
  assert.match(v.refused!, /it publishes insert, update, truncate; the change reader needs insert, update and delete/);
  assert.match(v.refused!, /\n {2}ALTER PUBLICATION app_pub SET \(publish = 'insert, update, delete, truncate'\);\n/);
  assert.equal(v.tables.size, 0);
});

test("a publication that does not exist refuses the run, listing the database's publications (a typo in the name)", () => {
  const v = namedPublicationVerdict(described({ exists: false, publish: [], others: ["app_pubs", "peerflow"] }), [ITEMS, LATER]);
  assert.match(v.refused!, /Found: no publication named app_pub\. Publications on this database: app_pubs, peerflow\./);
  assert.match(v.refused!, /CREATE PUBLICATION app_pub FOR TABLE\n {4}public\.items,\n {4}public\.later\n {2}WITH \(publish = 'insert, update, delete'\);/);
});

test("truncate not published is allowed and said", () => {
  assert.equal(namedPublicationVerdict(described({ publish: ["insert", "update", "delete"] }), [ITEMS, LATER]).noTruncate, true);
});

// ISSUE 978: a column list blocks the application's own ALTER TABLE … DROP COLUMN on the database. A named one that
// carries every synced column is still accepted (it is its owner's), and what it costs them is said, with the way out
test("a column list carrying every synced column is accepted, and said with the statements that name the table whole", () => {
  const v = namedPublicationVerdict(described({ columnLists: ["public.items", "public.audit"] }), [ITEMS, LATER]);
  assert.equal(v.refused, null);
  assert.equal(v.tables.size, 0, "accepted where it was before");
  assert.deepEqual(v.listsColumns, ["public.items"], "a synced table alone: public.audit is the owner's, not synced");
  assert.equal(columnListText("app_pub", v.listsColumns),
    "publication app_pub lists the columns of public.items. While it does, your database refuses ALTER TABLE … DROP COLUMN of a listed column. " +
    "Mason does not need the list: it drops the columns it does not sync as they arrive. To name the table whole, run as its owner: " +
    "BEGIN; ALTER PUBLICATION app_pub DROP TABLE public.items; ALTER PUBLICATION app_pub ADD TABLE public.items; COMMIT;");
  // a table refused for a gap is said by its refusal, never twice
  const gap = namedPublicationVerdict(described({ published: { "public.items": ["id", "note"], "public.later": ["id", "v"], "public.audit": ["id", "at"] }, columnLists: ["public.items"] }), [ITEMS, LATER]);
  assert.deepEqual(gap.listsColumns, []);
});
