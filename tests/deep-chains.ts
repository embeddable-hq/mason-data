/**
 * Statements whose every level reads the column below three times (PR 202 round 14): `a + a + a` (or `a || a || a`)
 * over the level below, `depth` levels deep, as nested subqueries, a WITH chain and a UNION ALL chain. Copying a followed
 * expression into each column reference grew 3^depth (depth 12 took 880 ms, 16 about 70 s), so planning one is held to
 * a bound linear in the statement (tests/duck-wire.test.ts, tests/duck-generated-round11-13-14.test.ts "round 14").
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
 * numeric c is read or carried through every level, and a quotient of it, since issue 244's first piece (#483) took a
 * FROM item's exact-numeric decisions once per column (on main `c + 1` took 399 ms and every column with c 1208 ms at
 * depth 32); and read THREE times a level (`numericShapes`) since its second (#484), which made a carried column's
 * program one node its references share, never a copy each (on main `c + c - c`'s record was 492 KB at depth 8, the
 * mixed-scale union chain's SQL 3.6 MB, and its depth 10 failed to deparse).
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
  const qq = ["q0 AS (SELECT c / 3 AS q FROM t)"];
  for (let i = 1; i <= depth; i++) qq.push(`q${i} AS (SELECT q + 1 AS q FROM q${i - 1})`);
  // level I's set operation, cycling from UNION at I = 0, each arm parenthesised with a bound of its own
  const setOps = ["UNION", "INTERSECT ALL", "EXCEPT ALL", "UNION ALL"];
  return {
    nested: `${levels("SELECT a, b FROM t", (s, i) => `SELECT ${ab} FROM (${s}) s${i}`)} ORDER BY 1, 2`,
    union: `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s} UNION ALL SELECT a FROM t) s${i}`)} ORDER BY 1`,
    with: `WITH ${qs.join(", ")} SELECT a, b FROM q${depth} ORDER BY 1, 2`,
    where: `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s}) s${i} WHERE a > ${i}`)} ORDER BY 1`,
    "group by": `${levels("SELECT a FROM t", (s, i) => `SELECT a + a - a AS a FROM (${s}) s${i} GROUP BY a`)} ORDER BY 1`,
    // this and "union, a bound at every level" at depth 32 are the review's deep variant form (pr-loop-slim.js
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
    // the numeric c, read or merely carried through every level (issue 244: each level's exact-numeric decisions about
    // the column below are taken once, never again per reference; 3^depth on main for 1::numeric, tests/duck-wire.test.ts)
    "c + 1": `${levels("SELECT c FROM t", (s, i) => `SELECT c + 1 AS c FROM (${s}) s${i}`)} ORDER BY 1`,
    "c passed through": `${levels("SELECT c FROM t", (s, i) => `SELECT c FROM (${s}) s${i}`)} ORDER BY 1`,
    "every column with c": `${levels("SELECT id, a, b, c, d FROM t", (s, i) => `SELECT id, ${ab}, c, d FROM (${s}) s${i}`)} ORDER BY 1`,
    "a quotient passed through": `${levels("SELECT c / 3 AS q FROM t", (s, i) => `SELECT q FROM (${s}) s${i}`)} ORDER BY 1`,
    "q + 1": `${levels("SELECT c / 3 AS q FROM t", (s, i) => `SELECT q + 1 AS q FROM (${s}) s${i}`)} ORDER BY 1`,
    "q + 1, a WITH chain": `WITH ${qq.join(", ")} SELECT q FROM q${depth} ORDER BY 1`,
    ...numericShapes(depth),
  };
}

/** the shapes of `numericShapes`, by name */
export const NUMERIC_SHAPES = ["344", "numeric union chain", "c + c - c", "q + q - q", "mixed-scale union, nested", "mixed-scale union, a chain",
  "q + q - q, a WITH chain", "q + q - q, a UNION ALL chain of scales"] as const;
/** the numeric shapes whose every level writes a program's text of its own (an ORDER BY key over a quotient: O(level)
 *  distinct nodes at level I), or adds a cell that every level above carries (a UNION ALL's arm number and its own
 *  cell): their SQL holds O(level) at each level, quadratic in the depth, as main's (the cells) or linear in it at each
 *  level (the literal), where the record of every shape stays linear (tests/duck-plan-time.test.ts) */
export const QUADRATIC_SQL: ReadonlySet<string> = new Set(["344", "numeric union chain", "mixed-scale union, nested", "mixed-scale union, a chain", "q + q - q, a UNION ALL chain of scales"]);

/**
 * Issue 244's second piece (#484): a numeric the engine does not hold as Postgres does (a quotient, a union of scales, a
 * numeric whose scale the engine drops) read three times a level, `depth` levels deep, over `deepShapes`' table. "344"
 * is issue 344's statement (a quotient, every level bounded); "mixed-scale" a quotient's arm beside an int and a
 * char(4) (`SELECT a, d`), at the bottom ("nested") or at every level ("a chain").
 */
export function numericShapes(depth: number): Record<(typeof NUMERIC_SHAPES)[number], string> {
  const levels = (start: string, level: (below: string, i: number) => string): string => {
    let s = start;
    for (let i = 1; i <= depth; i++) s = level(s, i);
    return s;
  };
  const ab = "a + a - a AS a, coalesce(b, b, b) AS b";
  const qq = ["q0 AS (SELECT c / 3 AS q FROM t)"];
  for (let i = 1; i <= depth; i++) qq.push(`q${i} AS (SELECT q + q - q AS q FROM q${i - 1})`);
  return {
    "344": levels("SELECT c / 3 AS a, b FROM t", (s, i) => `SELECT ${ab} FROM (${s}) s${i} ORDER BY a, b LIMIT 100`),
    "numeric union chain": deepChains("1::numeric", depth).union!,
    "c + c - c": `${levels("SELECT c FROM t", (s, i) => `SELECT c + c - c AS c FROM (${s}) s${i}`)} ORDER BY 1`,
    "q + q - q": `${levels("SELECT c / 3 AS q FROM t", (s, i) => `SELECT q + q - q AS q FROM (${s}) s${i}`)} ORDER BY 1`,
    "mixed-scale union, nested": levels("SELECT c / 3 AS a, b FROM t UNION ALL SELECT a, d FROM t", (s, i) => `SELECT ${ab} FROM (${s}) s${i} ORDER BY a, b LIMIT 100`),
    "mixed-scale union, a chain": levels("SELECT c / 3 AS a, b FROM t", (s, i) => `SELECT ${ab} FROM ((${s}) UNION ALL SELECT a, d FROM t) s${i} ORDER BY a, b LIMIT 100`),
    "q + q - q, a WITH chain": `WITH ${qq.join(", ")} SELECT q, q::text FROM q${depth} ORDER BY 1`,
    "q + q - q, a UNION ALL chain of scales": `${levels("SELECT c / 3 AS q FROM t", (s, i) => `SELECT q + q - q AS q FROM (${s} UNION ALL SELECT c / 7 FROM t) s${i}`)} ORDER BY 1`,
  };
}
