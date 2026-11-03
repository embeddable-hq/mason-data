/**
 * THE PLANNER'S TIME (issue 264): no review ever timed a statement's plan, so PR 202's walk that copied a followed
 * expression into each column reference (3^depth: 2.3 s at depth 12, the process dead by 16) reached its 14th round
 * before a reviewer happened on it. Every deep shape over a synthetic table is planned with the real allowlist, so its
 * check is inside the timed path, at each depth in climbing order, and held to the bound of its measured cost curve and
 * to a growth check (issue 569, tests/deep-chains.ts `planTimeBound`, `PLAN_GROWTH_HEADROOM`): a walk that grows with
 * the expansion fails by name at the first depth past them instead of hanging at the deepest.
 *
 * A file of its own, importing only the planner, the catalog's DDL, the parser and the allowlist. It no longer loads at
 * a0ab4ef (PR 202 before round 14: no src/duck/collation.ts), so the guard is proved on a stand-in walk instead (the
 * second test), which `scripts/fails-without.ts --paths tests/deep-chains.ts` loads against main's single bound.
 *
 * The numeric c read or merely carried through every level, and a quotient of it, are in since issue 244's first piece
 * (#483: a FROM item's exact-numeric decisions taken once per column; on main `c + 1` took 399 ms and every column with
 * c 1208 ms at depth 32). A numeric read THREE times a level (`numericShapes`) is in since its second (#484: a carried
 * column's program one node its references share, never a copy each; on main `c + c - c`'s record was 492 KB at depth
 * 8, the mixed-scale union chain took 992 ms and sent 3.6 MB at depth 8, failed to deparse at 10 and ran out of memory at
 * 32), and with it the SIZE of what the plan holds: the exact record (each program's one text, `programJson`) linear
 * in the depth for every shape, and the SQL sent linear too where no level writes a program's text of its own or adds
 * a cell the levels above carry (`QUADRATIC_SQL` names the rest, whose SQL holds O(level) at a level: quadratic).
 */
import { test } from "node:test";
import { CollationResolver } from "../src/duck/collation.ts";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { catalogDdl } from "../src/api/postgres/catalog.ts";
import { parseSql } from "../src/api/postgres/parser.ts";
import { planDuck } from "../src/duck/plan.ts";
import { VERIFIED } from "../src/duck/verified.ts";
import * as numeric from "../src/lib/pg-numeric.ts";
import * as chains from "./deep-chains.ts";
const { NUMERIC_SHAPES, PLAN_TIME_DEPTHS, QUADRATIC_SQL, deepShapes } = chains;

/** THE DECISION, read from tests/deep-chains.ts (issue 569: a bound per cost curve, the growth check, the minimum of a
 *  few plans), and main's single bound where the module is main's, so that `scripts/fails-without.ts --paths
 *  tests/deep-chains.ts` loads this file against it (where the stand-in test below fails by name) */
const decided: Partial<typeof chains> = chains;
const boundOf = decided.planTimeBound ?? ((): number => chains.PLAN_TIME_BOUND_MS);
const quadratic = decided.QUADRATIC_PLAN ?? QUADRATIC_SQL;
const headroom = decided.PLAN_GROWTH_HEADROOM ?? Infinity, floor = decided.PLAN_GROWTH_FLOOR_MS ?? Infinity, tries = decided.PLAN_TIME_TRIES ?? 1;

/** a planner as the guard sees it: one plan of `sql`, the shape's at `depth`, and its time (`detail`: where it went) */
type Planner = (shape: string, sql: string, depth: number) => Promise<{ ms: number; detail?: string }>;

/**
 * THE GUARD (issues 264, 569), one function for the real planner and the stand-ins: every `deepShapes` shape at each
 * depth in climbing order, held to its curve's bound (`planTimeBound`) and to the growth check against its time one
 * depth below (`PLAN_GROWTH_HEADROOM` x a quadratic's ratio, once the plan takes `PLAN_GROWTH_FLOOR_MS`), the minimum of
 * up to `PLAN_TIME_TRIES` plans where the first is past either. A walk that grows with the expansion fails by name at the
 * first depth past them, instead of hanging at the deepest. Returns each shape's held times, by depth.
 */
async function climb(plan: Planner): Promise<Map<string, Map<number, number>>> {
  const held = new Map<string, Map<number, number>>();
  for (const depth of PLAN_TIME_DEPTHS) for (const [shape, sql] of Object.entries(deepShapes(depth))) {
    const times = held.get(shape) ?? new Map<number, number>();
    held.set(shape, times);
    const below = PLAN_TIME_DEPTHS.filter((d) => d < depth && times.has(d)).at(-1);
    const bound = boundOf(shape), limit = below === undefined ? Infinity : headroom * (depth / below) ** 2;
    const grew = (ms: number): number => below === undefined || ms < floor ? 0 : ms / times.get(below)!;
    let best = Infinity, detail: string | undefined, made = 0;
    while (made < tries && (made === 0 || best >= bound || grew(best) > limit)) {
      const got = await plan(shape, sql, depth);
      made++;
      if (got.ms < best) { best = got.ms; detail = got.detail; }
    }
    times.set(depth, best);
    const at = `${shape}: planned in ${best.toFixed(0)} ms at depth ${depth}${detail === undefined ? "" : ` (${detail})`}${made > 1 ? `, the least of ${made}` : ""}`;
    assert.ok(best < bound, `${at}, past the bound of ${bound} ms (a ${quadratic.has(shape) ? "quadratic" : "linear"} plan)`);
    assert.ok(grew(best) <= limit, `${at}, ${grew(best).toFixed(1)}x its ${times.get(below!)?.toFixed(0)} ms at depth ${below}, past x${limit.toFixed(1)} (${headroom} x a quadratic's (${depth}/${below})^2): a plan that grows faster than the square of the depth`);
  }
  return held;
}

/** a program as the plan sends it: its one text where the module has one (since #484), else its JSON (before it, so
 *  that scripts/fails-without.ts loads the file at main, where the bound fails first) */
const programText = (p: unknown): string => ((numeric as { programJson?: (p: unknown) => string }).programJson ?? JSON.stringify)(p);

test("planning time (issue 264): every deep shape over a table plans within the bound at every depth to 32", async () => {
  const catalogDb = new PGlite();
  try {
    const ddl = catalogDdl({ database: "app", tables: [{ name: "t", schema: "public", primaryKey: ["id"], joins: [], columns: [
      { name: "id", type: "int4", notNull: true }, { name: "a", type: "int4" }, { name: "b", type: "text" },
      { name: "c", type: "numeric", spelled: "numeric(10,2)" }, { name: "d", type: "text", spelled: "character(4)" }] }] });
    for (const s of ddl) await catalogDb.exec(s);
    const catalog = (b: Uint8Array): Promise<Uint8Array> => catalogDb.execProtocolRaw(b);
    const plan = async (sql: string) => planDuck({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Parameters<typeof planDuck>[0]["stmt"],
      base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collations: CollationResolver.of({ kind: "bytes" }), verified: VERIFIED });
    // a first plan pays the catalog's and the parser's start: untimed
    await plan("SELECT a + a - a AS a, coalesce(b, b, b) AS b, coalesce(d, d, d) AS d FROM t ORDER BY 1");
    // each numeric shape's record and SQL at 16 and 32 (#484)
    const sizes = new Map<string, Map<number, { record: number; sql: number }>>();
    await climb(async (shape, sql, depth) => {
      const started = performance.now();
      // planned, not refused: a refusal exits before the rewrite and would bound nothing
      const planned = await plan(sql).catch((e: Error) => assert.fail(`${shape} at depth ${depth} is refused: ${e.message}`));
      const ms = performance.now() - started;
      if ((NUMERIC_SHAPES as readonly string[]).includes(shape) && (depth === 16 || depth === 32)) {
        const exact = planned.exact ?? [];
        assert.ok(exact.length > 0, `${shape} at depth ${depth}: no exact record, so nothing of #484 is measured`);
        const record = exact.reduce((n, e) => n + JSON.stringify([e.column, e.text, e.cells]).length + programText(e.program).length, 0);
        sizes.set(shape, (sizes.get(shape) ?? new Map()).set(depth, { record, sql: planned.sql.text.length }));
      }
      return { ms, detail: `the rewrite ${planned.timing?.rewriteMs.toFixed(0) ?? "?"} ms` };
    });
    // LINEAR IN THE DEPTH: twice the levels, at most 2.5 times the size (on main, x9 every two levels); a quadratic SQL
    // (`QUADRATIC_SQL`) at most 4.5 times
    for (const shape of NUMERIC_SHAPES) {
      const at16 = sizes.get(shape)!.get(16)!, at32 = sizes.get(shape)!.get(32)!;
      const sqlBound = QUADRATIC_SQL.has(shape) ? 4.5 : 2.5;
      assert.ok(at32.record / at16.record <= 2.5, `${shape}: its exact record is ${at32.record} characters at depth 32, ${at16.record} at 16`);
      assert.ok(at32.sql / at16.sql <= sqlBound, `${shape}: its SQL is ${at32.sql} characters at depth 32, ${at16.sql} at 16 (bound x${sqlBound})`);
    }
  } finally { await catalogDb.close(); }
});

/**
 * THE GUARD'S STAND-IN (issue 569): `climb` over planners whose time is a model, so what it fails and passes is seen
 * without a walk that takes minutes. Every shape on its measured curve (`PLAN_TIME_MEASURED_MS` at depth 32 on the
 * laptop: linear in the depth, or its square for `QUADRATIC_PLAN`), scaled to a runner `x` times the laptop.
 * - A runner twice CI's worst (`CI_SLOWDOWN`) passes at every depth to 32: the bounds have room for the runners.
 * - PR 202's 3^depth walk (2.3 s at depth 12 at a0ab4ef, on the laptop) fails by name at depth 12 on a linear shape
 *   (its bound) and on a quadratic one, whose bound it is under (the growth check); 10x cheaper at 12 too, and 100x
 *   cheaper at 16 (where it crosses the floor), never later, where it is dead.
 */
test("planning time (issue 569): the guard fails a 3^depth walk by name at the first depth past it, on either curve, and passes a runner twice CI's worst", async () => {
  // (main's figures where the module is main's: see `decided`)
  const measured = decided.PLAN_TIME_MEASURED_MS ?? { linear: 42, quadratic: 143 }, slowdown = decided.CI_SLOWDOWN ?? 7.4;
  const onCurve = (shape: string, depth: number, x: number): number =>
    x * (quadratic.has(shape) ? measured.quadratic * (depth / 32) ** 2 : measured.linear * (depth / 32));
  const names = Object.keys(deepShapes(4));
  for (const shape of decided.QUADRATIC_PLAN ?? []) assert.ok(names.includes(shape), `QUADRATIC_PLAN names ${shape}, which is no shape of deepShapes`);

  // a runner twice CI's worst, every plan on its curve
  await climb(async (shape, _sql, depth) => ({ ms: onCurve(shape, depth, 2 * slowdown) }));

  // a 3^depth walk taking `atTwelve` ms at depth 12, on one shape; every other on its curve
  const walk = (walker: string, atTwelve: number): Planner => async (shape, _sql, depth) =>
    ({ ms: shape === walker ? atTwelve * 3 ** (depth - 12) : onCurve(shape, depth, 1) });
  const chain = "mixed-scale union, a chain";
  assert.ok(quadratic.has(chain) && !quadratic.has("with"), "the stand-in walks a linear shape and a quadratic one");
  await assert.rejects(climb(walk("with", 2300)), { message: /^with: planned in 2300 ms at depth 12, the least of \d+, past the bound of \d+ ms \(a linear plan\)$/ });
  for (const [atTwelve, depth] of [[2300, 12], [230, 12], [23, 16]] as const) {
    const ms = atTwelve * 3 ** (depth - 12);
    const message = new RegExp(`^${chain}: planned in ${ms} ms at depth ${depth}, the least of \\d+, 81\\.0x its \\d+ ms at depth ${depth - 4}, past x\\d+\\.\\d .*: a plan that grows faster than the square of the depth$`);
    await assert.rejects(climb(walk(chain, atTwelve)), { message }, `a walk of ${atTwelve} ms at depth 12 on ${chain}`);
  }
});
