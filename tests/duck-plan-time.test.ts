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
 * Left out, for issue 244 to bring in with its fix: the numeric c read or merely carried through every level, which grows
 * with the cube of the depth on main (`c + 1` 261 ms and c passed through 222 ms at depth 32), and `c + c - c`, which is
 * exponential (still planning when killed at depth 16).
 */
import { test } from "node:test";
import { CollationResolver } from "../src/duck/collation.ts";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { catalogDdl } from "../src/api/postgres/catalog.ts";
import { parseSql } from "../src/api/postgres/parser.ts";
import { planDuck } from "../src/duck/plan.ts";
import { VERIFIED } from "../src/duck/verified.ts";
import { PLAN_TIME_BOUND_MS, PLAN_TIME_DEPTHS, deepShapes } from "./deep-chains.ts";

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
    for (const depth of PLAN_TIME_DEPTHS) for (const [shape, sql] of Object.entries(deepShapes(depth))) {
      const started = performance.now();
      // planned, not refused: a refusal exits before the rewrite and would bound nothing
      const planned = await plan(sql).catch((e: Error) => assert.fail(`${shape} at depth ${depth} is refused: ${e.message}`));
      const ms = performance.now() - started;
      assert.ok(ms < PLAN_TIME_BOUND_MS, `${shape}: planned in ${ms.toFixed(0)} ms at depth ${depth} (the rewrite ${planned.timing?.rewriteMs.toFixed(0) ?? "?"} ms), past the bound of ${PLAN_TIME_BOUND_MS} ms`);
    }
  } finally { await catalogDb.close(); }
});
