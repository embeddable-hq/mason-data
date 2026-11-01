/**
 * When the oracle's decided differences are stale (tests/integration/oracle/known.ts; the oracle itself,
 * tests/integration/duck-oracle.itest.ts, needs a Postgres): .claude/rules/duck-rewrite.md "No dead entries", and the one
 * class it spares — a decided difference whose truth depends on the machine's floating-point arithmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANY, decisionKey, shapeDecision, shapesDecided, staleDecisions, type Decided } from "./integration/oracle/known.ts";

test("a shape's decision is keyed by its shape, so its staleness names it apart from a base entry of the same pattern", () => {
  const shaped: Decided = { shape: "integer-arm", sql: /amount \/ 3/, kind: "text", gap: "mixed-scale-numeric", why: "a scale" };
  const filed: Decided = { shape: "numeric-text", sql: /amount \/ 3/, kind: "text", issue: 123, why: "filed" };
  const base: Decided = { sql: /amount \/ 3/, kind: "text", gap: "mixed-scale-numeric", why: "a scale" };
  assert.equal(decisionKey(shaped), "[integer-arm] /amount \\/ 3/");
  assert.equal(decisionKey(base), "/amount \\/ 3/");
  assert.deepEqual(staleDecisions([shaped, base], new Set([base]), new Set([shaped, base])), ["[integer-arm] /amount \\/ 3/: no longer differs (a scale) — remove it from KNOWN"]);
  assert.deepEqual(staleDecisions([filed], new Set(), new Set()), ["[numeric-text] /amount \\/ 3/: no statement asked matches it (filed) — remove it from KNOWN"]);
  // machineFloat and an unmet collation spare a shape's entry as they do a base one's
  const float: Decided = { ...shaped, machineFloat: true };
  assert.deepEqual(staleDecisions([float], new Set(), new Set([float])), [], "machineFloat: matched, agreed, not stale");
  assert.equal(staleDecisions([float], new Set(), new Set()).length, 1, "machineFloat matching nothing is dead");
  assert.deepEqual(staleDecisions([shaped], new Set(), new Set([shaped]), () => true), [], "an unmet collation: matched, agreed, not stale");
});

test("a shape carries one decision per kind: a class of the base's it meets is decided in its kind, and only there", () => {
  // PR 261's first run: char-arm met #247's padding as a value AND as a row Postgres's UNION dedupes; under a WITH TIES
  // base, #265's refusal. Each is its own entry, all over the BASE text.
  const value: Decided[] = shapesDecided(["char-arm", "char-arm-first"], { sql: ANY, kind: "value", issue: 247, why: "padding" });
  const rows: Decided = { shape: "char-arm", sql: ANY, kind: "rows", issue: 247, why: "padding, a row kept" };
  const ties: Decided = { shape: "char-arm", sql: /WITH TIES/, kind: "refused", issue: 265, why: "a star over WITH TIES" };
  const other: Decided = { sql: /UNION SELECT/, kind: "text", gap: "mixed-scale-numeric", why: "a plain entry over the shape's text" };
  const known = [...value, rows, ties, other];
  const base = "SELECT id, name FROM t ORDER BY id", text = `(${base}) UNION SELECT NULL, 'a'::character(3)`;
  assert.deepEqual(value.map((d) => d.shape), ["char-arm", "char-arm-first"]);
  const v = shapeDecision(known, "char-arm", base, text, "value");
  assert.deepEqual(v.matched, [value[0], rows], "every entry of the shape the base matches is decided (for staleness)");
  assert.equal(v.decides, value[0], "the value difference is decided by the value entry");
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
