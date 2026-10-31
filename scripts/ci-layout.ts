/**
 * WHAT scripts/ci-shards.ts AND scripts/oracle-legs.ts BOTH NEED, in a file that imports neither. Each is run as a
 * program with top-level code: when one imported the other in a cycle, `scripts/oracle-legs.ts` ended with Node's exit 13
 * (an unsettled top-level await) and said nothing else. tests/ci-shards.test.ts runs both as processes.
 */

/** The shards of each kind; `.github/workflows/ci.yml`'s matrices say the same (tests/ci-shards.test.ts). */
export const SHARDS = { unit: 3, rest: 2, oracle: 2 } as const;

/** The report an oracle leg writes */
export const reportName = (leg: number): string => `duck-oracle-leg-${leg}.json`;
