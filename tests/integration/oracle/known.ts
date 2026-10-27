/**
 * THE ORACLE'S DECIDED DIFFERENCES, and when one is stale (tests/integration/duck-oracle.itest.ts `KNOWN`;
 * .claude/rules/duckdb.md "No dead entries"): an entry that no statement still differs by is removed, not left to
 * mislead — except a decided difference whose truth depends on the machine's math library. A double's last digit from
 * ln, log10, exp or power is the source machine's libm's in Postgres and the math library's under DuckDB in Mason, and
 * the two agree on one pair of machines where they part on another (log10's: it differs with Postgres in a Linux
 * container and Mason on macOS, and agrees with both on Linux, as in CI, or both on macOS), so such an entry declares
 * `libm` and may differ nowhere on this machine. It is still stale when no statement asked is decided by it at all: a
 * pattern that meets nothing is dead on every machine.
 */
import type { GapId } from "../../../src/duck/gaps.ts";

export type Decided = {
  sql: RegExp;
  kind: string;
  gap: GapId;
  why: string;
  /** its truth depends on the machine's math library: where libm and DuckDB compute the last digit alike, it differs
   *  nowhere, and that is not stale */
  libm?: true;
};

/**
 * The stale entries of a whole run, each said with the way out: one that differed in none of the statements it decides,
 * unless it is `libm` and some statement asked is decided by it.
 * @param differed — the entries a statement differed by, in the kind decided
 * @param decided — the entries that decided a statement asked (the first whose pattern it matched), differing or not
 */
export function staleDecisions(known: readonly Decided[], differed: ReadonlySet<Decided>, decided: ReadonlySet<Decided>): string[] {
  return known.filter((k) => !differed.has(k) && !(k.libm === true && decided.has(k))).map((k) => decided.has(k)
    ? `${k.sql}: no longer differs (${k.why}) — remove it from KNOWN`
    : `${k.sql}: no statement asked matches it (${k.why}) — remove it from KNOWN`);
}
