/**
 * THE ORACLE'S DECIDED DIFFERENCES, and when one is stale (tests/integration/duck-oracle.itest.ts `KNOWN`;
 * .claude/rules/duck-rewrite.md "No dead entries"): an entry that no statement still differs by is removed, not left to
 * mislead — except a decided difference whose truth depends on the machine's floating-point arithmetic. A double's
 * last digit is the source machine's in Postgres (its libm's for ln, log10, exp or power; its build's arithmetic for a
 * variance's accumulation) and the machine's under DuckDB in Mason, and the two agree on one pair of machines where they
 * part on another: log10's differs with Postgres in a Linux container and Mason on macOS, and agrees with both on Linux
 * or both on macOS; a float8 variance's differs on CI's x86_64 runner and agrees on aarch64, Linux or macOS. Such an
 * entry declares `machineFloat` and may differ nowhere on this machine. It is still stale when no statement asked is
 * decided by it at all: a pattern that meets nothing is dead on every machine.
 */
import type { GapId } from "../../../src/duck/gaps.ts";

export type Decided = {
  sql: RegExp;
  kind: string;
  gap: GapId;
  why: string;
  /** its truth depends on the machine's floating-point arithmetic (its libm, its build's): where the two machines'
   *  last digits agree, it differs nowhere, and that is not stale */
  machineFloat?: true;
  /** what must STILL be alike where the rest differs (SHOW ALL: its fields, and the rows the session sets): a problem
   *  said, or null. With it, the rest may differ in any kind (`kind` says the one expected); without it, in `kind` only */
  holds?: (want: Answered, got: Answered) => string | null;
};

/** an answer with rows, as the oracle reads one */
export type Answered = { names: string[]; oids: number[]; rows: (string | null)[][] };

/**
 * The stale entries of a whole run, each said with the way out: one that differed in none of the statements it decides,
 * unless it is `machineFloat` and some statement asked is decided by it.
 * @param differed — the entries a statement differed by, in the kind decided
 * @param decided — the entries that decided a statement asked (the first whose pattern it matched), differing or not
 */
export function staleDecisions<K extends Pick<Decided, "why" | "machineFloat"> & { sql: RegExp | string }>(known: readonly K[], differed: ReadonlySet<K>, decided: ReadonlySet<K>): string[] {
  return known.filter((k) => !differed.has(k) && !(k.machineFloat === true && decided.has(k))).map((k) => decided.has(k)
    ? `${k.sql}: no longer differs (${k.why}) — remove it from KNOWN`
    : `${k.sql}: no statement asked matches it (${k.why}) — remove it from KNOWN`);
}
