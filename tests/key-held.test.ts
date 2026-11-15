/**
 * WHAT THE SYNC SAYS WHEN THE DATABASE NO LONGER ENFORCES THE KEY A TABLE IS SYNCED BY (src/cdc/key-held.ts, issue 1027):
 * the place in the sources file and the key, what is wrong in the developer's words, and the way out — a unique index
 * the table still has, else what to ask the database's owner. `tests/integration/duck-poll.itest.ts` holds the query
 * against a real Postgres and the poll and the copy it refuses.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type * as KeyHeld from "../src/cdc/key-held.ts";

// imported when the tests run, not at load: the file loads at a commit without the module (scripts/fails-without.ts)
const K = await import("../src/cdc/key-held.ts" as string).catch(() => ({})) as typeof KeyHeld;

const AT = "mason/sources/app.yml: tables.logs";
const own = { source: "public.logs", key: ["tenant_id", "id"], at: AT, own: true };

test("a key the database enforces, or a table gone, is no problem", () => {
  assert.equal(K.keyHeldProblem({ found: true, nullable: "[]", held: true, usable: "[]" }, own), null);
  // its read fails as it always did, in its own words
  assert.equal(K.keyHeldProblem({ found: false, nullable: null, held: false, usable: null }, own), null);
});

test("a key: with no unique index over it names the file, the key, and a unique index the table still has", () => {
  assert.equal(K.keyHeldProblem({ found: true, nullable: "[]", held: false, usable: '[["id"], ["tenant_id", "seq"]]' }, own),
    "mason/sources/app.yml: tables.logs.key: public.logs has no unique index over (tenant_id, id) on the database now, so two of its rows can share a key. " +
    "Mason does not sync it until that is fixed, so that no synced row is lost. " +
    "Name the columns of one of its unique indexes in key: (key: [id] or key: [tenant_id, seq]), or ask the database's owner to add a unique index over the key.");
  assert.equal(K.keyHeldProblem({ found: true, nullable: "[]", held: false, usable: "[]" }, own),
    "mason/sources/app.yml: tables.logs.key: public.logs has no unique index over (tenant_id, id) on the database now, so two of its rows can share a key. " +
    "Mason does not sync it until that is fixed, so that no synced row is lost. Ask the database's owner to add a unique index over NOT NULL columns.");
});

test("a key column that may be NULL now is refused too, as the sources file's check refuses it", () => {
  assert.equal(K.keyHeldProblem({ found: true, nullable: '["id"]', held: true, usable: "[]" }, own),
    "mason/sources/app.yml: tables.logs.key: id can be NULL in public.logs now, and rows with NULL there cannot be told apart. " +
    "Mason does not sync it until that is fixed, so that no synced row is lost. Ask the database's owner to add a unique index over NOT NULL columns.");
});

test("a primary key dropped while Mason runs is said at the entry, with key: as the way out", () => {
  assert.equal(K.keyHeldProblem({ found: true, nullable: "[]", held: false, usable: '[["code"]]' }, { source: "public.orders", key: ["id"], at: "mason/sources/app.yml: tables.orders", own: false }),
    "mason/sources/app.yml: tables.orders: public.orders no longer has its primary key (id) on the database, so two of its rows can share it. " +
    "Mason does not sync it until that is fixed, so that no synced row is lost. " +
    "Name the columns of one of its unique indexes in key: (key: [code]), or ask the database's owner to restore the primary key.");
});

test("the query names the key's columns as literals, so a column of any name is the column it names", () => {
  const sql = K.keyHeldSql("Shop", "o'rders", ["id", "we\"ird"]);
  assert.match(sql, /to_regclass\('"Shop"\."o''rders"'\)/);
  assert.match(sql, /ARRAY\['id', 'we"ird'\]::text\[\]/);
  // a catalog read: never a row of the table, never an ORDER BY of it
  assert.doesNotMatch(sql, /FROM\s+"Shop"/);
});

test("a replicated table's primary key dropped names a poll by a unique index as the way out, never a key: the stream does not apply (issue 1062)", () => {
  const replicated = { source: "public.orders", key: ["id"], at: "mason/sources/app.yml: tables.orders", own: false, replicated: true };
  assert.equal(K.keyHeldProblem({ found: true, nullable: "[]", held: false, usable: '[["code"], ["tenant_id", "seq"]]' }, replicated),
    "mason/sources/app.yml: tables.orders: public.orders no longer has its primary key (id) on the database, so two of its rows can share it. " +
    "Mason does not apply its changes until that is fixed, so that no synced row is lost, and its synced data serves as it was. " +
    "Ask the database's owner to restore the primary key, or poll it by one of its unique indexes: set its entry's sync: to poll <interval> and its key: to [code] or [tenant_id, seq].");
  assert.equal(K.keyHeldProblem({ found: true, nullable: '["id"]', held: false, usable: "[]" }, replicated),
    "mason/sources/app.yml: tables.orders: public.orders no longer has its primary key (id) on the database, so two of its rows can share it. " +
    "id can be NULL in public.orders now, and rows with NULL there cannot be told apart. " +
    "Mason does not apply its changes until that is fixed, so that no synced row is lost, and its synced data serves as it was. Ask the database's owner to restore the primary key.");
  assert.equal(K.keyHeldProblem({ found: true, nullable: "[]", held: true, usable: "[]" }, replicated), null, "a key still held is no problem");
});
