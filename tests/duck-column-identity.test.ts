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
type Verdict = { kind: "unknown" } | { kind: "taken"; record: Record_; replaced?: true } | { kind: "held"; why: string; conflicts: Array<{ name: string; was: string; from?: string }>; record?: Record_ };
interface Module {
  identityVerdict(t: { source: string; oid?: number; shape?: string; synced: readonly string[]; entry?: { at: string; name: string; columns: readonly string[] | null; exclude: readonly string[] } }, record: Record_ | undefined, confirmed: boolean, readOnly?: boolean,
    carried?: ReadonlyArray<Record_ & { from: string }>): Verdict;
  recordOf(oid: unknown, columns: unknown): Record_ | null;
  unionOut?(a: readonly Recorded[], b: readonly Recorded[]): Recorded[];
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
    "Its entry would sync it. A column the file left out is synced again only once you confirm it, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write exclude: [salary, a] on mason/sources/app.yml: tables.t, then run mason stop && mason start. " +
    "To sync it, run mason add t --columns id,a,b while Mason runs");
  // the line written: both out, the table taken; each recorded under its name now
  const fixed = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["salary", 2], ["a", 3], ["b", 4]), synced: ["id", "b"], entry: every(["salary", "a"]) }, was, false);
  assert.deepEqual(fixed, { kind: "taken", record: record([1, "id", true], [2, "salary", false], [3, "a", false], [4, "b", true]) });
  // or the other way: the column now named salary (a's values) left out, and a still out
  const other = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["salary", 2], ["a", 3], ["b", 4]), synced: ["id", "salary", "b"], entry: every(["a"]) }, was, false);
  assert.deepEqual(other, { kind: "taken", record: record([1, "id", true], [2, "salary", true], [3, "a", false], [4, "b", true]) });
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

test("a run that left a renamed column out by its own word holds the table when a start from the file as it was would sync it", async () => {
  const { identityVerdict } = await load();
  // the run kept pay2 out (src/cli/dev.ts, a read-only project): the file as the run takes it excludes pay2
  const live = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["pay2", 3]), synced: ["id", "a"], entry: every(["pay2"]) },
    record([1, "id", true], [2, "a", true], [3, "salary", false]), false);
  assert.deepEqual(live, { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "pay2", false]) });
  // restarted from the file never written, a new salary added: pay2 is still the salary, under the name it was kept out under
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["pay2", 3], ["salary", 4]), synced: ["id", "a", "pay2"], entry: every(["salary"]) },
    (live as { record: Record_ }).record, false);
  assert.equal(v.kind, "held");
  assert.match((v as { why: string }).why, /^public\.t is not synced: pay2 is a column the sources file left out\. Its entry would sync it\. /);
  // renamed back to the name it was first left out under, and the file excludes it: out, taken
  const back = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 3]), synced: ["id", "a"], entry: every(["salary"]) },
    (live as { record: Record_ }).record, false);
  assert.equal(back.kind, "taken");
});

// THE REVIEW OF PR 1078: the run writes exclude: itself (issue 977) and takes a name out of it once that name is gone, so
// a name proves nothing. c renamed d (exclude: [d] written), a new c added and synced, then the new c dropped and d
// renamed c: the file, rewritten to {}, syncs c by name — and c is the column it left out
test("a column left out and renamed back under a name the file syncs, after the run took its other name out of exclude:, is held", async () => {
  const { identityVerdict } = await load();
  const step = (shape_: string, synced: string[], exclude: string[], r: Record_): Verdict =>
    identityVerdict({ source: "public.t", oid: OID, shape: shape_, synced, entry: every(exclude) }, r, false);
  const r0 = record([1, "id", true], [2, "a", true], [3, "c", false], [4, "b", true]);
  // 1. c renamed d; the run writes exclude: [d]
  const v1 = step(shape(["id", 1], ["a", 2], ["d", 3], ["b", 4]), ["id", "a", "b"], ["d"], r0);
  assert.equal(v1.kind, "taken");
  // 2. a new c added: synced by name
  const v2 = step(shape(["id", 1], ["a", 2], ["d", 3], ["b", 4], ["c", 5]), ["id", "a", "b", "c"], ["d"], (v1 as { record: Record_ }).record);
  assert.deepEqual(v2, { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "d", false], [4, "b", true], [5, "c", true]) });
  // 3. the new c dropped and d renamed c, in one transaction; the run took d out of exclude: (gone), so the file is {}
  const v3 = step(shape(["id", 1], ["a", 2], ["c", 3], ["b", 4]), ["id", "a", "c", "b"], [], (v2 as { record: Record_ }).record);
  assert.equal(v3.kind, "held");
  assert.deepEqual((v3 as { conflicts: unknown }).conflicts, [{ name: "c", was: "d" }]);
  assert.match((v3 as { why: string }).why, /^public\.t is not synced: its columns were renamed on the database, and c is the column the sources file left out as d\. .*write exclude: \[c\] on mason\/sources\/app\.yml: tables\.t/);
  // the same after the hold's way to sync the new c: the person writes exclude: [d] by hand, then step 3
  const byHand = step(shape(["id", 1], ["a", 2], ["c", 3], ["b", 4]), ["id", "a", "c", "b"], [], (v2 as { record: Record_ }).record);
  assert.equal(byHand.kind, "held");
});

test("a column renamed to a name columns: lists is not synced under it: held, the line keeping the listed column under its new name", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "amount_total", true], [3, "z", false]);
  const v = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["amount_total2", 2], ["amount_total", 3]), synced: ["id", "amount_total"], entry: listed(["id", "amount_total"]) }, was, false);
  assert.equal(v.kind, "held");
  assert.equal((v as { why: string }).why,
    "public.t is not synced: its columns were renamed on the database, and amount_total is the column the sources file left out as z. " +
    "Its entry would sync it. A column the file left out is synced again only once you confirm it, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write columns: [id, amount_total2] on mason/sources/app.yml: tables.t, then run mason stop && mason start. " +
    "To sync it, run mason add t --columns id,amount_total2,amount_total while Mason runs");
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

test("what the file says of a column added or a synced one is taken; a column left out is synced again only once confirmed", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "salary", false]);
  // a column added, and a synced one renamed
  assert.deepEqual(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a2", 2], ["salary", 3], ["c", 4]), synced: ["id", "a2", "c"], entry: every(["salary"]) }, was, false),
    { kind: "taken", record: record([1, "id", true], [2, "a2", true], [3, "salary", false], [4, "c", true]) });
  // salary taken out of exclude:, its name unchanged: the file alone cannot say who took it out, so the table is held
  const out = { source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 3]), synced: ["id", "a", "salary"], entry: every([]) };
  const held = identityVerdict(out, was, false);
  assert.equal(held.kind, "held");
  assert.equal((held as { why: string }).why,
    "public.t is not synced: salary is a column the sources file left out. " +
    "Its entry would sync it. A column the file left out is synced again only once you confirm it, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write exclude: [salary] on mason/sources/app.yml: tables.t, then run mason stop && mason start. " +
    "To sync it, run mason add t --columns id,a,salary while Mason runs");
  // confirmed by mason add while Mason runs: synced
  assert.deepEqual(identityVerdict(out, was, true), { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "salary", true]) });
  // a column dropped, and an excluded one dropped and added again under its name: a new column, out by the file's name
  assert.deepEqual(identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["salary", 4]), synced: ["id", "a"], entry: every(["salary"]) }, was, false),
    { kind: "taken", record: record([1, "id", true], [2, "a", true], [4, "salary", false]) });
});

// THE RE-CHECK OF PR 1078: a table made again under its name (another oid) is decided again, and a name the table it
// replaced left out stays out; a read-only project's committed file is the owner's word for a column that did not move
test("a table of another oid is decided again by name, a name the table it replaced left out held when the file syncs it", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "c", false], [4, "b", true]);
  const again = { source: "public.t", oid: OID + 7, shape: shape(["id", 1], ["a", 2], ["c", 3], ["b", 4]), entry: every(["c"]) };
  // made again with the same columns, c still excluded: taken, the record its own, its synced data read again whole
  assert.deepEqual(identityVerdict({ ...again, synced: ["id", "a", "b"] }, was, false),
    { kind: "taken", record: { oid: OID + 7, columns: [{ attnum: 1, name: "id", synced: true }, { attnum: 2, name: "a", synced: true }, { attnum: 3, name: "c", synced: false }, { attnum: 4, name: "b", synced: true }] }, replaced: true });
  // the file syncs c, which the table it replaced left out: nothing tells the two apart but the name, so it is held
  const v = identityVerdict({ ...again, synced: ["id", "a", "c", "b"], entry: every([]) }, was, false);
  assert.equal(v.kind, "held");
  assert.match((v as { why: string }).why, /^public\.t is not synced: c is a column the sources file left out\. /);
  // confirmed by mason add: taken by name
  assert.equal(identityVerdict({ ...again, synced: ["id", "a", "c", "b"], entry: every([]) }, was, true).kind, "taken");
});

test("in a read-only project the committed file syncs a column left out that did not move; one that moved is held, its way out one that works there", async () => {
  const { identityVerdict } = await load();
  const was = record([1, "id", true], [2, "a", true], [3, "c", false]);
  // exclude: [c] changed to {} in the committed file, c the same column under the same name: taken, synced
  const same = { source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["c", 3]), synced: ["id", "a", "c"], entry: every([]) };
  assert.deepEqual(identityVerdict(same, was, false, true), { kind: "taken", record: record([1, "id", true], [2, "a", true], [3, "c", true]) });
  // in a writable project the run writes exclude: itself, so its file confirms nothing: held
  assert.equal(identityVerdict(same, was, false, false).kind, "held");
  // c renamed d and a new c added: d moved, so it is held, with a way out a read-only project takes (mason add is refused there)
  const moved = identityVerdict({ source: "public.t", oid: OID, shape: shape(["id", 1], ["a", 2], ["d", 3], ["c", 4]), synced: ["id", "a", "d"], entry: every(["c"]) }, was, false, true);
  assert.equal(moved.kind, "held");
  assert.equal((moved as { why: string }).why,
    "public.t is not synced: its columns were renamed on the database, and d is the column the sources file left out as c. " +
    "Its entry would sync it. A column the file left out is synced again only once you confirm it, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write exclude: [c, d] on mason/sources/app.yml: tables.t in the committed sources file, and start Mason with it. " +
    "To sync it, take the entry out of the committed file and start Mason with it, then put the entry back and start Mason again: the table is synced again whole");
});

test("two tables swapped on the database (issue 1080): the column one entry left out stays out under the entry that names its table now, and that entry is held", async () => {
  const { identityVerdict } = await load();
  const T = OID, U = OID + 1;
  // t: { exclude: [c] } took relation T; u: {} took relation U; then their names were swapped in one transaction
  const tRecord = { oid: T, columns: [{ attnum: 1, name: "id", synced: true }, { attnum: 2, name: "a", synced: true }, { attnum: 3, name: "c", synced: false }] };
  const uRecord = { oid: U, columns: [{ attnum: 1, name: "id", synced: true }, { attnum: 2, name: "a", synced: true }, { attnum: 3, name: "c", synced: true }] };
  const cols = shape(["id", 1], ["a", 2], ["c", 3]);
  const uNow = { source: "public.u", oid: T, shape: cols, synced: ["id", "a", "c"], entry: { at: "mason/sources/app.yml: tables.u", name: "u", columns: null, exclude: [] } };
  // by its own record alone (main, and this PR before the fix) u was a table made again, decided by name: c synced
  const v = identityVerdict(uNow, uRecord, false, false, [{ ...tRecord, from: "public.t" }]);
  assert.equal(v.kind, "held");
  assert.deepEqual((v as { conflicts: unknown }).conflicts, [{ name: "c", was: "c", from: "public.t" }]);
  assert.equal((v as { why: string }).why,
    "public.u is not synced: c is a column the sources file left out of public.t, and public.u is that table now (tables or schemas were renamed on the database). " +
    "Its entry would sync it. A column the file left out is synced again only once you confirm it, so Mason holds the table and serves its synced data as it was. " +
    "To keep it out, write exclude: [c] on mason/sources/app.yml: tables.u, then run mason stop && mason start. " +
    "To sync it, run mason add u --columns id,a,c while Mason runs");
  // what holds it is the record of T, by number: kept so, a restart holds it the same
  assert.deepEqual((v as { record: unknown }).record, { oid: T, columns: [{ attnum: 1, name: "id", synced: true }, { attnum: 2, name: "a", synced: true }, { attnum: 3, name: "c", synced: false }] });
  // a read-only project's committed file confirms only a column of the entry's OWN record: held there too
  assert.equal(identityVerdict(uNow, uRecord, false, true, [{ ...tRecord, from: "public.t" }]).kind, "held");
  // the same under a name the entry never synced before (a table renamed into a new entry's name)
  assert.equal(identityVerdict(uNow, undefined, false, false, [{ ...tRecord, from: "public.t" }]).kind, "held");
  // the entry confirmed against the table as it is now: taken, and read again whole
  assert.deepEqual(identityVerdict(uNow, uRecord, true, false, [{ ...tRecord, from: "public.t" }]), { kind: "taken", record: { oid: T, columns: uRecord.columns }, replaced: true });
  // t, now relation U: no worse off — its column c still out by its own file, taken and read again whole
  const tNow = identityVerdict({ source: "public.t", oid: U, shape: cols, synced: ["id", "a"], entry: every(["c"]) }, tRecord, false, false, [{ ...uRecord, from: "public.u" }]);
  assert.deepEqual(tNow, { kind: "taken", record: { oid: U, columns: tRecord.columns }, replaced: true });
});

test("two records of one relation are one: a column either left out is left out", async () => {
  const { unionOut } = await load();
  assert.ok(unionOut !== undefined, "src/duck/column-identity.ts has no unionOut");
  assert.deepEqual(unionOut([{ attnum: 1, name: "id", synced: true }, { attnum: 3, name: "c", synced: true }], [{ attnum: 3, name: "salary", synced: false }, { attnum: 2, name: "a", synced: true }]),
    [{ attnum: 1, name: "id", synced: true }, { attnum: 2, name: "a", synced: true }, { attnum: 3, name: "salary", synced: false }]);
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
