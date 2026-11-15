/**
 * WHICH COLUMN IS WHICH, BY ITS IDENTITY ON THE DATABASE (src/duck/column-identity.ts; issue 1073): a column the sources
 * file leaves out stays out under any other name — a swap of two names, a rename while Mason was stopped, a column
 * renamed to a name `columns:` lists — and its table is held, said with the line to write, until the file places it
 * or the entry is confirmed by `mason add`. tests/integration/cli-column-identity.itest.ts holds the run to it under
 * poll and replication.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type Recorded = { attnum: number; name: string; synced: boolean };
type Record_ = { oid: number; columns: Recorded[] };
type Verdict = { kind: "unknown" } | { kind: "taken"; record: Record_ } | { kind: "held"; why: string; conflicts: Array<{ name: string; was: string }> };
interface Module {
  identityVerdict(t: { source: string; oid?: number; shape?: string; synced: readonly string[]; entry?: { at: string; name: string; columns: readonly string[] | null; exclude: readonly string[] } }, record: Record_ | undefined, confirmed: boolean): Verdict;
  recordOf(oid: unknown, columns: unknown): Record_ | null;
}

// loaded here, not imported: the file loads at a commit without the module, and fails by name there (scripts/fails-without.ts)
async function load(): Promise<Module> {
  try { return await import("../src/duck/column-identity.ts") as Module; }
  catch (e) { return assert.fail(`src/duck/column-identity.ts does not load: ${(e as Error).message}`); }
}

/** a shape as src/cdc/shape.ts reads it: each column's name, type oid, typmod, number and whether it is generated */
const shape = (...cols: Array<[string, number]>): string => JSON.stringify(cols.map(([name, attnum]) => [name, 25, -1, attnum, false]));
const every = (exclude: string[]) => ({ at: "mason/sources/app.yml: tables.t", name: "t", columns: null, exclude });
const listed = (columns: string[]) => ({ at: "mason/sources/app.yml: tables.t", name: "t", columns, exclude: [] });
const OID = 16_400;
const record = (...cols: Array<[number, string, boolean]>): Record_ => ({ oid: OID, columns: cols.map(([attnum, name, synced]) => ({ attnum, name, synced })) });

test("a table the run has no record of is taken by name, and recorded by identity", async () => {
  const { identityVerdict } = await load();
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 3]), synced: ["id", "a"], entry: every(["salary"]) }, undefined, false);
  assert.deepEqual(v, { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "salary", false]) });
  // nothing to go by: a table read without its oid or its shape (a test's), or a shape without numbers
  assert.deepEqual(identityVerdict({ source: "public.t", synced: ["id"] }, undefined, false), { kind: "unknown" });
  assert.deepEqual(identityVerdict({ source: "public.t", oid: OID, shape: JSON.stringify([["id", 23, -1]]), synced: ["id"] }, undefined, false), { kind: "unknown" });
});

test("two names swapped in one transaction: the column left out is never synced under the other's name, and the table is held with the line to write", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "salary", false], [4, "b", true]);
  // salary and a swapped: by name the file syncs a, which is the salary
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["salary", 2], ["a", 3], ["b", 4]), synced: ["id", "a", "b"], entry: every(["salary"]) }, was, false);
  assert.equal(v.kind, "held");
  assert.deepEqual((v as { conflicts: unknown }).conflicts, [{ name: "a", was: "salary" }]);
  assert.equal((v as { why: string }).why,
    "public.t is not synced: its columns were renamed on the database, and a is the column the sources file left out as salary. " +
    "Its entry would sync it under its new name, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write exclude: [salary, a] on mason/sources/app.yml: tables.t, then run mason stop && mason start. " +
    "To sync it under its new name, run mason add t --columns id,a,b while Mason runs");
  // the line written: both out, the table taken; the column left out keeps the name it was left out under
  const fixed = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["salary", 2], ["a", 3], ["b", 4]), synced: ["id", "b"], entry: every(["salary", "a"]) }, was, false);
  assert.deepEqual(fixed, { kind: "taken", record: record([1, "id", true], [2, "salary", false], [3, "salary", false], [4, "b", true]) });
  // or the other way: the column now named salary (a's values) left out, and a still out
  const other = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["salary", 2], ["a", 3], ["b", 4]), synced: ["id", "salary", "b"], entry: every(["a"]) }, was, false);
  assert.deepEqual(other, { kind: "taken", record: record([1, "id", true], [2, "salary", true], [3, "salary", false], [4, "b", true]) });
  // two synced columns swapped: no hold (the copy holds other columns now, so it is synced again whole)
  assert.equal(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["b", 2], ["salary", 3], ["a", 4]), synced: ["id", "a", "b"], entry: every(["salary"]) }, was, false).kind, "taken");
});

test("a column left out and renamed while Mason was stopped stays out at the start, a new column of its old name beside it", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "salary", false]);
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["pay2", 3], ["salary", 4]), synced: ["id", "a", "pay2"], entry: every(["salary"]) }, was, false);
  assert.equal(v.kind, "held");
  assert.match((v as { why: string }).why, /pay2 is the column the sources file left out as salary\. .* write exclude: \[salary, pay2\] on mason\/sources\/app\.yml: tables\.t, .* run mason add t --columns id,a,pay2 while Mason runs$/);
});

test("a run that left a renamed column out by its own word records it under the name it was left out under, so a start from the file as it was holds the table", async () => {
  const { identityVerdict } = await load();
  // the run kept pay2 out (src/cli/dev.ts leftOutArrivals, a read-only project): the file as the run takes it excludes pay2
  const live = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["pay2", 3]), synced: ["id", "a"], entry: every(["pay2"]) },
    record([1, "id", true], [2, "a", true], [3, "salary", false]), false);
  assert.deepEqual(live, { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "salary", false]) });
  // restarted from the file never written, a new salary added: pay2 is still the salary
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["pay2", 3], ["salary", 4]), synced: ["id", "a", "pay2"], entry: every(["salary"]) },
    (live as { record: Record_ }).record, false);
  assert.equal(v.kind, "held");
  // renamed back to the name it was left out under: the file decides by that name again
  const back = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 3]), synced: ["id", "a"], entry: every(["salary"]) },
    (live as { record: Record_ }).record, false);
  assert.equal(back.kind, "taken");
});

test("a column renamed to a name columns: lists is not synced under it: held, the line keeping the listed column under its new name", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "amount_total", true], [3, "z", false]);
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["amount_total2", 2], ["amount_total", 3]), synced: ["id", "amount_total"], entry: listed(["id", "amount_total"]) }, was, false);
  assert.equal(v.kind, "held");
  assert.equal((v as { why: string }).why,
    "public.t is not synced: its columns were renamed on the database, and amount_total is the column the sources file left out as z. " +
    "Its entry would sync it under its new name, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write columns: [id, amount_total2] on mason/sources/app.yml: tables.t, then run mason stop && mason start. " +
    "To sync it under its new name, run mason add t --columns id,amount_total2,amount_total while Mason runs");
  // the line written: taken
  assert.equal(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["amount_total2", 2], ["amount_total", 3]), synced: ["id", "amount_total2"], entry: listed(["id", "amount_total2"]) }, was, false).kind, "taken");
});

test("the entry confirmed by mason add, or a table made again under its name, is taken afresh by name", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "salary", false]);
  const swapped = { source: "public.t", shape: shape(["id", 1], ["salary", 2], ["a", 3]), synced: ["id", "a"], entry: every(["salary"]) };
  assert.equal(identityVerdict({ ...swapped, oid: OID }, was, false).kind, "held");
  assert.deepEqual(identityVerdict({ ...swapped, oid: OID }, was, true), { kind: "taken", record: record([1, "id", true], [2, "salary", false], [3, "a", true]) });
  assert.equal(identityVerdict({ ...swapped, oid: OID + 1 }, was, false).kind, "taken");
});

test("what the file says by a name that still means the same column is taken: a column added, a synced one renamed, one left out and synced again", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "salary", false]);
  // a column added, and a synced one renamed
  assert.deepEqual(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a2", 2], ["salary", 3], ["c", 4]), synced: ["id", "a2", "c"], entry: every(["salary"]) }, was, false),
    { kind: "taken", record: record([1, "id", true], [2, "a2", true], [3, "salary", false], [4, "c", true]) });
  // salary taken out of exclude: by the person, its name unchanged: synced
  assert.deepEqual(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 3]), synced: ["id", "a", "salary"], entry: every([]) }, was, false),
    { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "salary", true]) });
  // a column dropped, and an excluded one dropped and added again under its name: a new column, out by the file's name
  assert.deepEqual(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 4]), synced: ["id", "a"], entry: every(["salary"]) }, was, false),
    { kind: "taken", record: record([1, "id", true], [2, "a", true], [4, "salary", false]) });
});

test("a record is read back as it was written, and one this module did not write reads as none", async () => {
  const { recordOf } = await load();
  const r = record([1, "id", true], [3, "salary", false]);
  assert.deepEqual(recordOf(BigInt(OID), JSON.stringify(r.columns)), r);
  assert.equal(recordOf(OID, "not json"), null);
  assert.equal(recordOf(OID, JSON.stringify([{ attnum: "1", name: "id", synced: true }])), null);
  assert.equal(recordOf(OID, JSON.stringify({})), null);
  assert.equal(recordOf("x", "[]"), null);
});
