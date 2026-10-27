/**
 * THE ORACLE'S DECIDED DIFFERENCES, and when one is stale (tests/integration/duck-oracle.itest.ts `KNOWN`;
 * .claude/rules/duckdb.md "No dead entries"): an entry that no statement still differs by is removed, not left to
 * mislead.
 */
import type { GapId } from "../../../src/duck/gaps.ts";

export type Decided = {
  sql: RegExp;
  kind: string;
  gap: GapId;
  why: string;
};

/**
 * The stale entries of a whole run, each said with the way out: one that differed in none of the statements it decides.
 * @param differed — the entries a statement differed by, in the kind decided
 */
export function staleDecisions(known: readonly Decided[], differed: ReadonlySet<Decided>): string[] {
  return known.filter((k) => !differed.has(k)).map((k) => `${k.sql}: no longer differs (${k.why}) — remove it from KNOWN`);
}
