/**
 * HOW MUCH OF THE ORACLE EACH GAP ACCOUNTS FOR (src/duck/gaps.ts; tests/integration/duck-oracle.itest.ts `meet`): the
 * refusals and decided differences by the gap they name, each count split in two:
 *  - `planted`: a statement of oracle/gap-cases.ts (`group: "gap case"`), there so the registry cannot list a gap the
 *    oracle never saw: it says the gap exists, and nothing about how often it is met;
 *  - `natural`: every other statement of the oracle, written for something else, which met the gap in passing.
 * Two measures, never to be added: `copyPhase`, each of the oracle's statements once, as `tallies.mason` counts them, so
 * its counts sum to that tally; `everyAsk`, the three phases and the shapes. A shape wraps only what was answered alike,
 * so a refused statement is never wrapped: `everyAsk` is its statement three times, and what a wrapper alone refuses.
 * Neither is how often a tool meets a gap: the statements are the oracle's, a cross of every type with every path.
 */
import type { GapId } from "../../../src/duck/gaps.ts";

export type GapCount = { planted: number; natural: number };
export type GapCounts = Partial<Record<GapId, GapCount>>;
export type GapTally = { refused: GapCounts; decided: GapCounts };
/** the two ways a statement is not answered as Postgres answers it and names a gap, as `tallies.mason` calls them */
export type Met = keyof GapTally;

export const emptyTally = (): GapTally => ({ refused: {}, decided: {} });

export function countGap(tally: GapTally, met: Met, gap: GapId, group: string): void {
  const c = tally[met][gap] ??= { planted: 0, natural: 0 };
  c[group === "gap case" ? "planted" : "natural"]++;
}

const entries = (counts: GapCounts): Array<[GapId, GapCount]> => Object.entries(counts) as Array<[GapId, GapCount]>;

export function totalOf(counts: GapCounts): GapCount {
  return entries(counts).reduce((t, [, c]) => ({ planted: t.planted + c.planted, natural: t.natural + c.natural }), { planted: 0, natural: 0 });
}

/** the biggest gap first, by what the oracle met in passing: a planted statement says nothing of how often one is met */
export const rankedGaps = (counts: GapCounts): Array<[GapId, GapCount]> => entries(counts)
  .sort(([a, x], [b, y]) => y.natural - x.natural || y.planted - x.planted || (a < b ? -1 : 1));

/** a run's summary, one line for each measure: `natural+planted`, the biggest gap first */
export function gapSummary(copyPhase: GapTally, statements: number, everyAsk: GapTally, asked: number): string[] {
  const line = (noun: string, met: Met, counts: GapCounts, of: number): string => {
    const t = totalOf(counts);
    return `duck oracle: ${t.natural + t.planted} of ${of} ${noun} ${met}, by gap, natural+planted (${t.natural}+${t.planted}): ` +
      `${rankedGaps(counts).map(([id, c]) => `${id} ${c.natural}+${c.planted}`).join(", ")}`;
  };
  return [line("statements", "refused", copyPhase.refused, statements), line("statements", "decided", copyPhase.decided, statements),
    line("asks", "refused", everyAsk.refused, asked), line("asks", "decided", everyAsk.decided, asked)];
}

const byId = (counts: GapCounts): GapCounts => Object.fromEntries(entries(counts).sort(([a], [b]) => a < b ? -1 : 1));

/** a tally as the fixture keeps it: by id, so a gap that moves is one line of the diff, never a reordered list */
export const fixtureTally = (t: GapTally): GapTally => ({ refused: byId(t.refused), decided: byId(t.decided) });

/** the fixture's text: JSON, each gap's counts on the gap's own line */
export const fixtureText = (fixture: unknown): string =>
  `${JSON.stringify(fixture, null, 2).replace(/\{\s+"planted": (\d+),\s+"natural": (\d+)\s+\}/g, '{ "planted": $1, "natural": $2 }')}\n`;
