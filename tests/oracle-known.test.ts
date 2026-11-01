/**
 * When the oracle's decided differences are stale (tests/integration/oracle/known.ts; the oracle itself,
 * tests/integration/duck-oracle.itest.ts, needs a Postgres): .claude/rules/duck-rewrite.md "No dead entries", and the one
 * class it spares — a decided difference whose truth depends on the machine's floating-point arithmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANY, decisionKey, shapeDecision, shapesDecided, staleDecisions, type Decided } from "./integration/oracle/known.ts";
import { CHAR_ARMS, NUMERIC_READERS, SET_OPERATION_ARMS, VALUES_ARMS } from "./integration/oracle/shape-names.ts";

test("a shape's decision is keyed by its shape, so its staleness names it apart from a base entry of the same pattern", () => {
  const shaped: Decided = { shape: "integer-arm", sql: /amount \/ 3/, kind: "text", gap: "mixed-scale-numeric", why: "a scale" };
  const filed: Decided = { shape: "numeric-text", sql: /amount \/ 3/, kind: "text", issue: 123, why: "filed" };
  const base: Decided = { sql: /amount \/ 3/, kind: "text", gap: "mixed-scale-numeric", why: "a scale" };
  assert.equal(decisionKey(shaped), "[integer-arm] text /amount \\/ 3/");
  assert.equal(decisionKey(base), "/amount \\/ 3/");
  assert.deepEqual(staleDecisions([shaped, base], new Set([base]), new Set([shaped, base])), ["[integer-arm] text /amount \\/ 3/: no longer differs (a scale) — remove it from KNOWN"]);
  assert.deepEqual(staleDecisions([filed], new Set(), new Set()), ["[numeric-text] text /amount \\/ 3/: no statement asked matches it (filed) — remove it from KNOWN"]);
  // machineFloat and an unmet collation spare a shape's entry as they do a base one's
  const float: Decided = { ...shaped, machineFloat: true };
  assert.deepEqual(staleDecisions([float], new Set(), new Set([float])), [], "machineFloat: matched, agreed, not stale");
  assert.equal(staleDecisions([float], new Set(), new Set()).length, 1, "machineFloat matching nothing is dead");
  assert.deepEqual(staleDecisions([shaped], new Set(), new Set([shaped]), () => true), [], "an unmet collation: matched, agreed, not stale");
});

test("a shape carries one decision per kind: a class of the base's it meets is decided in its kind, and only there", () => {
  // PR 261's first run: char-arm met #247's padding as a value AND as a row Postgres's UNION dedupes; under a WITH TIES
  // base, #265's refusal. Each is its own entry, all over the BASE text.
  const value: Decided = shapesDecided(["char-arm", "char-arm-first"], { sql: ANY, kind: "value", issue: 247, why: "padding" });
  const rows: Decided = { shape: "char-arm", sql: ANY, kind: "rows", issue: 247, why: "padding, a row kept" };
  const ties: Decided = { shape: "char-arm", sql: /WITH TIES/, kind: "refused", issue: 265, why: "a star over WITH TIES" };
  const other: Decided = { sql: /UNION SELECT/, kind: "text", gap: "mixed-scale-numeric", why: "a plain entry over the shape's text" };
  const known = [value, rows, ties, other];
  const base = "SELECT id, name FROM t ORDER BY id", text = `(${base}) UNION SELECT NULL, 'a'::character(3)`;
  assert.deepEqual(value.shape, ["char-arm", "char-arm-first"], "one entry over the group");
  const v = shapeDecision(known, "char-arm", base, text, "value");
  assert.deepEqual(v.matched, [value, rows], "every entry of the shape the base matches is decided (for staleness)");
  assert.equal(v.decides, value, "the value difference is decided by the value entry");
  assert.equal(shapeDecision(known, "char-arm", base, text, "rows").decides, rows, "the rows difference by the rows entry");
  assert.equal(shapeDecision(known, "char-arm", base, text, "text").decides, undefined, "a kind with no entry of the shape stays a difference, and the plain entry is not consulted");
  assert.equal(shapeDecision(known, "char-arm", base, text, null).decides, undefined, "an agreement is decided by none");
  assert.equal(shapeDecision(known, "char-arm", `${base} FETCH FIRST 3 ROWS WITH TIES`, text, "refused").decides, ties, "the pattern reads the BASE text");
  assert.equal(shapeDecision(known, "char-arm", base, text, "refused").decides, undefined);
  // a shape with no entry of its own falls back to the first plain entry its own text matches
  const n = shapeDecision(known, "null-arm", base, text, "text");
  assert.deepEqual([n.matched, n.decides], [[other], other]);
  assert.deepEqual(shapeDecision(known, "null-arm", base, base, "text"), { matched: [], decides: undefined });
});

test("a class is decided over every shape whose construction reaches it, by one entry stale only when none of them differs", () => {
  // PR 261's merged run (CI 41351366200): #252's numeric text was decided for char-arm-first and every other arm, read
  // from a run where char-arm's padding (#247) masked it; main fixed the padding, and char-arm's numeric text was a
  // difference no entry decided. Over its group, every arm is decided by the one entry, whichever run showed it first.
  const numeric = shapesDecided([...SET_OPERATION_ARMS, ...NUMERIC_READERS], { sql: ANY, kind: "text", issue: 252, why: "a numeric's scale" });
  const base = "SELECT o.id, o.big::text AS t, o.amount_raw::numeric(20,1) AS c FROM orders o ORDER BY o.id LIMIT 20";
  for (const shape of [...SET_OPERATION_ARMS, ...NUMERIC_READERS]) assert.equal(shapeDecision([numeric], shape, base, "", "text").decides, numeric, shape);
  assert.ok(SET_OPERATION_ARMS.every((s) => (CHAR_ARMS as readonly string[]).includes(s) || !s.startsWith("char")) && CHAR_ARMS.every((s) => (SET_OPERATION_ARMS as readonly string[]).includes(s)) && VALUES_ARMS.every((s) => (SET_OPERATION_ARMS as readonly string[]).includes(s)), "the char and VALUES arms are set operation arms");
  for (const shape of ["empty", "table", "count-zero"]) assert.equal(shapeDecision([numeric], shape, base, "", "text").decides, undefined, `${shape} is not in the group`);
  // one entry: it differed by any of its shapes, so it is stale only when none does
  assert.deepEqual(staleDecisions([numeric], new Set([numeric]), new Set([numeric])), []);
  assert.deepEqual(staleDecisions([numeric], new Set(), new Set([numeric])), [`[${[...SET_OPERATION_ARMS, ...NUMERIC_READERS].join(", ")}] text /[\\s\\S]/: no longer differs (a numeric's scale) — remove it from KNOWN, and say on #252 that it no longer differs (on this tree: main may have fixed it)`]);
  // two kinds of one group and pattern are two keys, so one cannot hide the other's staleness behind a merge
  const rows = shapesDecided(CHAR_ARMS, { sql: ANY, kind: "rows", issue: 247, why: "a row kept" }), value = shapesDecided(CHAR_ARMS, { sql: ANY, kind: "value", issue: 247, why: "padding" });
  assert.notEqual(decisionKey(rows), decisionKey(value));
  // two classes of one shape and kind over one base (CI run 41353796825: #252's value over every base listed ahead of
  // #267's over json): the narrower decides whatever the order, so neither is stale for the other's being first
  const broad = shapesDecided([...SET_OPERATION_ARMS, ...NUMERIC_READERS], { sql: ANY, kind: "value", issue: 252, why: "a numeric rounded" });
  const narrow = shapesDecided(VALUES_ARMS, { sql: /json|\bip\b|array_agg/, kind: "value", issue: 267, why: "jsonb text" });
  const jsonBase = "SELECT id, j::jsonb FROM typed ORDER BY id";
  assert.equal(shapeDecision([broad, narrow], "values-arm", jsonBase, "", "value").decides, narrow);
  assert.equal(shapeDecision([narrow, broad], "values-arm", jsonBase, "", "value").decides, narrow);
  assert.equal(shapeDecision([broad, narrow], "values-arm", base, "", "value").decides, broad, "a base the narrower misses: the broad one");
  assert.equal(decisionKey({ sql: "/[\\s\\S]/", shape: "char-arm, char-arm-first", kind: "rows" }), decisionKey(rows), "a leg report's decision, its group joined, keys as the entry does");
});

const plain: Decided = { sql: /stddev\(f4\)/, kind: "text", gap: "float-last-digit", why: "an accumulation's last digit" };
const machine: Decided = { sql: /sqrt\(abs\(f4\)\)/, kind: "text", gap: "float-last-digit", why: "log10's last digit", machineFloat: true };

test("a decided difference no statement differs by is stale, whether or not a statement matched it", () => {
  assert.deepEqual(staleDecisions([plain], new Set([plain]), new Set([plain])), [], "it differed: not stale");
  assert.deepEqual(staleDecisions([plain], new Set(), new Set([plain])), [`${plain.sql}: no longer differs (${plain.why}) — remove it from KNOWN`]);
  assert.deepEqual(staleDecisions([plain], new Set(), new Set()), [`${plain.sql}: no statement asked matches it (${plain.why}) — remove it from KNOWN`]);
});

test("a decided difference of the machine's floating point may agree on this machine, but must still match a statement", () => {
  // CI's Linux runner (run 40547306244): log10's last digit is alike there, and differs with Postgres on Linux and Mason on macOS
  assert.deepEqual(staleDecisions([machine], new Set(), new Set([machine])), [], "matched, agreed: the machines' arithmetic decides, not stale");
  assert.deepEqual(staleDecisions([machine], new Set([machine]), new Set([machine])), [], "matched, differed");
  assert.deepEqual(staleDecisions([machine], new Set(), new Set()), [`${machine.sql}: no statement asked matches it (${machine.why}) — remove it from KNOWN`],
    "a pattern that meets nothing is dead on every machine");
  // the exemption is the entry's own: a plain one beside it is still held
  assert.deepEqual(staleDecisions([plain, machine], new Set(), new Set([plain, machine])), [`${plain.sql}: no longer differs (${plain.why}) — remove it from KNOWN`]);
});
