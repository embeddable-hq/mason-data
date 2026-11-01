/**
 * Statements whose every level reads the column below three times (PR 202 round 14): `a + a + a` (or `a || a || a`)
 * over the level below, `depth` levels deep, as nested subqueries, a WITH chain and a UNION ALL chain. Copying a followed
 * expression into each column reference grew 3^depth (depth 12 took 880 ms, 16 about 70 s), so planning one is held to
 * a bound linear in the statement (tests/duck-wire.test.ts, tests/duck-generated.test.ts "round 14").
 */
export const DEEP_DEPTH = 16;
/** the depths a test climbs to `DEEP_DEPTH`: a walk that grows with the expansion fails the bound at the first depth past
 *  it (12 took 880 ms), by name, instead of hanging the file at 16 */
export const DEEP_DEPTHS = [4, 8, 12, DEEP_DEPTH];

/** each shape, by name, at `depth` levels over `bottom` (the expression of a value named `a`), each level `a op a op a` */
export function deepChains(bottom: string, depth = DEEP_DEPTH, op = "+"): Record<string, string> {
  const level = `a ${op} a ${op} a`;
  let nested = `SELECT ${bottom} AS a`, union = nested;
  for (let i = 1; i <= depth; i++) {
    nested = `SELECT ${level} AS a FROM (${nested}) s${i}`;
    union = `SELECT ${level} AS a FROM (${union} UNION ALL SELECT ${bottom}) s${i}`;
  }
  const ctes = [`t0 AS (SELECT ${bottom} AS a)`];
  for (let i = 1; i <= depth; i++) ctes.push(`t${i} AS (SELECT ${level} AS a FROM t${i - 1})`);
  return { nested, with: `WITH ${ctes.join(", ")} SELECT ${level} AS a FROM t${depth}`, union };
}
