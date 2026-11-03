/**
 * THE PLANNER'S TIME (issue 264): no review ever timed a statement's plan, so PR 202's walk that copied a followed
 * expression into each column reference (3^depth: 2.3 s at depth 12, the process dead by 16) reached its 14th round
 * before a reviewer happened on it. Every deep shape over a synthetic table is planned with the real allowlist, so its
 * check is inside the timed path, at each depth in climbing order, and held to a bound measured on main: a walk that
 * grows with the expansion fails by name at the first depth past the bound instead of hanging at the deepest.
 *
 * A file of its own, importing only the planner, the catalog's DDL, the parser and the allowlist, so that
 * scripts/fails-without.ts can load it at a0ab4ef (PR 202 before round 14), where the bound is what fails.
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
import { NUMERIC_SHAPES, PLAN_TIME_BOUND_MS, PLAN_TIME_DEPTHS, QUADRATIC_SQL, deepShapes } from "./deep-chains.ts";

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
    for (const depth of PLAN_TIME_DEPTHS) for (const [shape, sql] of Object.entries(deepShapes(depth))) {
      const started = performance.now();
      // planned, not refused: a refusal exits before the rewrite and would bound nothing
      const planned = await plan(sql).catch((e: Error) => assert.fail(`${shape} at depth ${depth} is refused: ${e.message}`));
      const ms = performance.now() - started;
      assert.ok(ms < PLAN_TIME_BOUND_MS, `${shape}: planned in ${ms.toFixed(0)} ms at depth ${depth} (the rewrite ${planned.timing?.rewriteMs.toFixed(0) ?? "?"} ms), past the bound of ${PLAN_TIME_BOUND_MS} ms`);
      if ((NUMERIC_SHAPES as readonly string[]).includes(shape) && (depth === 16 || depth === 32)) {
        const exact = planned.exact ?? [];
        assert.ok(exact.length > 0, `${shape} at depth ${depth}: no exact record, so nothing of #484 is measured`);
        const record = exact.reduce((n, e) => n + JSON.stringify([e.column, e.text, e.cells]).length + programText(e.program).length, 0);
        sizes.set(shape, (sizes.get(shape) ?? new Map()).set(depth, { record, sql: planned.sql.text.length }));
      }
    }
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
