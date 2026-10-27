/**
 * When the oracle's decided differences are stale (tests/integration/oracle/known.ts; the oracle itself,
 * tests/integration/duck-oracle.itest.ts, needs a Postgres): .claude/rules/duckdb.md "No dead entries", and the one
 * class it spares — a decided difference whose truth depends on the machine's math library.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { staleDecisions, type Decided } from "./integration/oracle/known.ts";

const plain: Decided = { sql: /stddev\(f4\)/, kind: "text", gap: "float-last-digit", why: "an accumulation's last digit" };
const libm: Decided = { sql: /sqrt\(abs\(f4\)\)/, kind: "text", gap: "float-last-digit", why: "log10's last digit", libm: true };

test("a decided difference no statement differs by is stale, whether or not a statement matched it", () => {
  assert.deepEqual(staleDecisions([plain], new Set([plain]), new Set([plain])), [], "it differed: not stale");
  assert.deepEqual(staleDecisions([plain], new Set(), new Set([plain])), [`${plain.sql}: no longer differs (${plain.why}) — remove it from KNOWN`]);
  assert.deepEqual(staleDecisions([plain], new Set(), new Set()), [`${plain.sql}: no statement asked matches it (${plain.why}) — remove it from KNOWN`]);
});

test("a decided difference of the machine's math library may agree on this machine, but must still match a statement", () => {
  // CI's Linux runner (run 40547306244): log10's last digit is alike there, and differs with Postgres on Linux and Mason on macOS
  assert.deepEqual(staleDecisions([libm], new Set(), new Set([libm])), [], "matched, agreed: the machine's libm decides, not stale");
  assert.deepEqual(staleDecisions([libm], new Set([libm]), new Set([libm])), [], "matched, differed");
  assert.deepEqual(staleDecisions([libm], new Set(), new Set()), [`${libm.sql}: no statement asked matches it (${libm.why}) — remove it from KNOWN`],
    "a pattern that meets nothing is dead on every machine");
  // the exemption is the entry's own: a plain one beside it is still held
  assert.deepEqual(staleDecisions([plain, libm], new Set(), new Set([plain, libm])), [`${plain.sql}: no longer differs (${plain.why}) — remove it from KNOWN`]);
});
