/**
 * When the oracle's decided differences are stale (tests/integration/oracle/known.ts; the oracle itself,
 * tests/integration/duck-oracle.itest.ts, needs a Postgres): .claude/rules/duckdb.md "No dead entries".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { staleDecisions, type Decided } from "./integration/oracle/known.ts";

const plain: Decided = { sql: /stddev\(f4\)/, kind: "text", gap: "float-last-digit", why: "an accumulation's last digit" };

test("a decided difference no statement differs by is stale", () => {
  assert.deepEqual(staleDecisions([plain], new Set([plain])), [], "it differed: not stale");
  assert.deepEqual(staleDecisions([plain], new Set()), [`${plain.sql}: no longer differs (${plain.why}) — remove it from KNOWN`]);
});
