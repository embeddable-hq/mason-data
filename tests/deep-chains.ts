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

/** the depths each `deepShapes` shape climbs, in order: a walk that grows with the expansion fails the bound at the first
 *  depth past it, by name, instead of hanging the file at the deepest (the workflows' deep variant form is at the last) */
export const PLAN_TIME_DEPTHS = [4, 8, 12, 16, 24, 32];
/** measured, min of 3 (issue 264's PR): on main every shape planned in 1–102 ms at depth 32 (laptop, Node 24); at
 *  a0ab4ef, the exponential walk of PR 202 round 14, `a + a - a` nested took 2.3 s at depth 12. 1000 ms is about 3x
 *  CI's likely worst (3x the laptop) and below that */
export const PLAN_TIME_BOUND_MS = 1000;

/**
 * Issue 264: the planner's time, held to a bound over a synthetic table `t (id int PRIMARY KEY, a int, b text,
 * c numeric(10,2), d char(4))` (tests/duck-plan-time.test.ts). Each shape, by name, `depth` levels deep, every level
 * reading the one below three times where the shape allows: `a + a - a` (no int overflow at any depth when executed)
 * and `coalesce(b, b, b)` (no text that grows), never `a + a + a` or `b || b || b`. `sI` is the alias at level I. The
 * numeric c is read nowhere: carried through every level it grows with the cube of the depth, and `c + c - c` is
 * exponential (issue 244, whose fix brings it here).
 */
export function deepShapes(depth: number): Record<string, string> {
  const levels = (start: string, level: (below: string, i: number) => string): string => {
    let s = start;
    for (let i = 1; i <= depth; i++) s = level(s, i);
    return s;
  };
  const ab = "a + a - a AS a, coalesce(b, b, b) AS b";
  const qs = ["q0 AS (SELECT a, b FROM t)"];
  for (let i = 1; i <= depth; i++) qs.push(`q${i} AS (SELECT ${ab} FROM q${i - 1})`);
  // level I's set operation, cycling from UNION at I = 0, each arm parenthesised with a bound of its own
  const setOps = ["UNION", "INTERSECT ALL", "EXCEPT ALL", "UNION ALL"];
  return {
    nested: `${levels("SELECT a, b FROM t", (s, i) => `SELECT ${ab} FROM (${s}) s${i}`)} ORDER BY 1, 2`,
    union: `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s} UNION ALL SELECT a FROM t) s${i}`)} ORDER BY 1`,
    with: `WITH ${qs.join(", ")} SELECT a, b FROM q${depth} ORDER BY 1, 2`,
    where: `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s}) s${i} WHERE a > ${i}`)} ORDER BY 1`,
    "group by": `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s}) s${i} GROUP BY a`)} ORDER BY 1`,
    // this and "union, a bound at every level" at depth 32 are the review's deep variant form (.claude/workflows/pr-loop.js
    // VARIANT_FORMS), which Postgres executes: it never pulls a bounded derived table up into the level above, and without
    // the bound its own pull-up grows 3^depth (depth 10 took 14 s, and 11 brought down a Postgres given 2 GB)
    "order by and limit": levels("SELECT a, b FROM t", (s, i) => `SELECT ${ab} FROM (${s}) s${i} ORDER BY a, b LIMIT 100`),
    "union, a bound at every level": levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM ((${s}) UNION ALL SELECT a FROM t) s${i} ORDER BY a LIMIT 100`),
    distinct: `${levels("SELECT a FROM t", (s, i) => `SELECT DISTINCT a + a - a AS a FROM (${s}) s${i}`)} ORDER BY 1`,
    case: `${levels("SELECT a FROM t", (s, i) => `SELECT CASE WHEN a > 0 THEN a ELSE a - 1 END AS a FROM (${s}) s${i}`)} ORDER BY 1`,
    "left join": `${levels("SELECT id, a FROM t", (s, i) => `SELECT s${i}.id, s${i}.a + s${i}.a - t.a AS a FROM (${s}) s${i} LEFT JOIN t ON t.id = s${i}.id`)} ORDER BY 1, 2`,
    in: `${levels("SELECT a FROM t", (s) => `SELECT a FROM t WHERE a IN (${s})`)} ORDER BY 1`,
    exists: `${levels("SELECT a FROM t", (s, i) => `SELECT a FROM t t${i} WHERE EXISTS (${s})`)} ORDER BY 1`,
    "scalar subquery": levels("SELECT max(a) FROM t", (s) => `SELECT (${s}) + a - a FROM t ORDER BY 1 LIMIT 1`),
    window: `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (SELECT a, row_number() OVER (ORDER BY a) AS r FROM (${s}) w${i}) s${i}`)} ORDER BY 1`,
    "text alone": `${levels("SELECT b FROM t", (s, i) => `SELECT coalesce(b, b, b) AS b FROM (${s}) s${i}`)} ORDER BY 1`,
    "char(4) alone": `${levels("SELECT d FROM t", (s, i) => `SELECT coalesce(d, d, d) AS d FROM (${s}) s${i}`)} ORDER BY 1`,
    "set operations": `${levels("(SELECT a FROM t)", (s, i) => `${i === 1 ? s : `(${s})`} ${setOps[i % 4]} (SELECT a FROM t ORDER BY a LIMIT ${i})`)} ORDER BY 1`,
    "bounded arms": levels("SELECT a FROM t", (s, i) => `SELECT a FROM ((${s}) UNION ALL (SELECT a FROM t ORDER BY a DESC LIMIT ${i})) s${i} ORDER BY a LIMIT 50`),
    "with ties": levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s}) s${i} ORDER BY a FETCH FIRST 50 ROWS WITH TIES`),
    "all but c": `${levels("SELECT id, a, b, d FROM t", (s, i) => `SELECT id, a + a - a AS a, b, d FROM (${s}) s${i}`)} ORDER BY 1`,
  };
}
