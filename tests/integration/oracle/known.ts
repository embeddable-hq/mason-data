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
import type { ShapeName } from "./shape-names.ts";

/**
 * A decided difference. One without `shape` decides a statement by its own text, and a shape's text as before. One
 * with `shape` decides only that shape (oracle/shape-names.ts) of a statement whose BASE text its pattern matches,
 * never the statement nor another shape; it names an existing `differs` gap, or the `issue` the difference is filed as
 * (in no gap tally). Either must still differ in its kind. A shape may carry one per kind (`shapeDecision`): a class
 * of the base's that a new shape meets is filed once and recorded here in the push that adds the shape, read from that
 * run's differences file, never left to turn the oracle red.
 */
export type Decided = DecidedOf & ({ shape?: undefined; gap: GapId; issue?: undefined } | { shape: ShapeName; gap: GapId; issue?: undefined } | { shape: ShapeName; issue: number; gap?: undefined });
type DecidedOf = {
  sql: RegExp;
  kind: string;
  why: string;
  /** its truth depends on the machine's floating-point arithmetic (its libm, its build's): where the two machines'
   *  last digits agree, it differs nowhere, and that is not stale */
  machineFloat?: true;
  /** its truth depends on the source's collation: it can differ only under a libc locale, or under any but C. Under
   *  another, as a `machineFloat` entry, it may differ nowhere (`collationMet`) */
  collation?: "libc" | "not-c";
  /** what must STILL be alike where the rest differs (SHOW ALL: its fields, and the rows the session sets): a problem
   *  said, or null. With it, the rest may differ in any kind (`kind` says the one expected); without it, in `kind` only */
  holds?: (want: Answered, got: Answered) => string | null;
};

/** a shape decision's pattern over every base: a class the shape meets by its construction, wherever its type is reached */
export const ANY = /[\s\S]/;

/** one decision for each of `shapes`: a class a set of shapes meets alike, said once */
export const shapesDecided = (shapes: readonly ShapeName[], d: Omit<DecidedOf, "sql"> & { sql: RegExp; issue: number }): Decided[] => shapes.map((shape) => ({ ...d, shape }));

/**
 * The decisions a shape's ask meets. Its shape's own entries whose pattern the BASE text matches are each `matched`
 * (decided, for staleDecisions), and the one of the difference's `kind` `decides` it, so one shape may carry a class
 * per kind; with none of its own, the first entry without `shape` that the shape's own `text` matches does both.
 */
export function shapeDecision<K extends { shape?: string | undefined; sql: RegExp; kind: string }>(known: readonly K[], shape: string, base: string, text: string, kind: string | null): { matched: K[]; decides: K | undefined } {
  const own = known.filter((k) => k.shape === shape && k.sql.test(base));
  if (own.length > 0) return { matched: own, decides: own.find((k) => k.kind === kind) };
  const plain = known.find((k) => k.shape === undefined && k.sql.test(text));
  return { matched: plain === undefined ? [] : [plain], decides: plain };
}

/** A decision's key, the one spelling of it: its pattern, or `[<shape>] <pattern>` for a shape's (the oracle's stale
 *  assertion, a leg's report, and scripts/oracle-legs.ts's merge of the legs' decisions) */
export const decisionKey = (k: { sql: RegExp | string; shape?: string | undefined }): string => k.shape === undefined ? String(k.sql) : `[${k.shape}] ${String(k.sql)}`;

/** Whether an entry's `collation` is the run's: `provider` and `collate` as pg_database says them. */
export function collationMet(k: Pick<Decided, "collation">, provider: string, collate: string): boolean {
  // (src/duck/rewrite.ts isLibcCollation's words: CI's last jobs reach this file with no npm ci, so Node's builtins alone)
  const libc = provider !== "b" && provider !== "i" && !/^(C|POSIX)([.].*)?$/i.test(collate);
  return k.collation === undefined || libc || (k.collation === "not-c" && provider === "i");
}

/** an answer with rows, as the oracle reads one */
export type Answered = { names: string[]; oids: number[]; rows: (string | null)[][] };

/**
 * The stale entries of a whole run, each said with the way out: one that differed in none of the statements it decides,
 * unless it is `machineFloat` and some statement asked is decided by it.
 * @param differed — the entries a statement differed by, in the kind decided
 * @param decided — the entries that decided a statement asked (the first whose pattern it matched), differing or not
 * @param unmet — an entry whose `collation` is not this run's: as `machineFloat`
 */
export function staleDecisions<K extends Pick<Decided, "why" | "machineFloat"> & { sql: RegExp | string; shape?: string | undefined }>(known: readonly K[], differed: ReadonlySet<K>, decided: ReadonlySet<K>, unmet: (k: K) => boolean = () => false): string[] {
  return known.filter((k) => !differed.has(k) && !((k.machineFloat === true || unmet(k)) && decided.has(k))).map((k) => decided.has(k)
    ? `${decisionKey(k)}: no longer differs (${k.why}) — remove it from KNOWN`
    : `${decisionKey(k)}: no statement asked matches it (${k.why}) — remove it from KNOWN`);
}
