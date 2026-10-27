/**
 * AN EXPLAIN'S OPTIONS ARE READ AS POSTGRES READS THEM (src/api/postgres/explain.ts `explainOptions`): every option list
 * here is given to PGlite and to Mason, and each refuses it with the same SQLSTATE and the same words, or accepts it —
 * but for what Mason refuses by design (FORMAT XML / YAML, GENERIC_PLAN: 0A000, the gap `explain-option`). The Fable
 * review of #517 found `EXPLAIN (FORMAT)` answered XX000 (a TypeError) where Postgres says "format requires a
 * parameter", and `FORMAT 1` named "" as the value.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import { explainedText, explainOptions } from "../src/api/postgres/explain.ts";
import { Unsupported } from "../src/api/postgres/translate.ts";

const OPTIONS = [
  "FORMAT", "FORMAT 1", "FORMAT 0", "FORMAT 1.5", "FORMAT true", "FORMAT false", "FORMAT 'JSON'", "FORMAT \"JSON\"", "FORMAT json",
  "FORMAT text", "FORMAT 'text'", "FORMAT nosuch",
  "ANALYZE", "ANALYZE 0", "ANALYZE 1", "ANALYZE 2", "ANALYZE off", "ANALYZE 'on'", "ANALYZE 'maybe'", "ANALYZE 1.5",
  "VERBOSE", "COSTS false", "SUMMARY", "BUFFERS", "SETTINGS on", "MEMORY",
  "TIMING", "TIMING off", "ANALYZE, TIMING off", "WAL", "ANALYZE, WAL",
  "ANALYZE, SERIALIZE", "SERIALIZE", "ANALYZE, SERIALIZE text", "ANALYZE, SERIALIZE binary", "ANALYZE, SERIALIZE off",
  "ANALYZE, SERIALIZE none", "ANALYZE, SERIALIZE on", "ANALYZE, SERIALIZE true", "ANALYZE, SERIALIZE 'TEXT'", "ANALYZE, SERIALIZE 1", "ANALYZE, SERIALIZE",
  "NOSUCH", "NOSUCH 1",
];
/** what Mason refuses by design, never Postgres's answer */
const BY_DESIGN = ["FORMAT xml", "FORMAT yaml", "GENERIC_PLAN"];

const pg = await PGlite.create();
after(async () => { await pg.close(); await stopParser(); });

type Verdict = { ok: true } | { code: string; message: string };

async function postgres(options: string): Promise<Verdict> {
  try { await pg.query(`EXPLAIN (${options}) SELECT 1`); return { ok: true }; }
  catch (e) { return { code: (e as { code: string }).code, message: (e as Error).message }; }
}

async function mason(options: string): Promise<Verdict> {
  const stmt = (await parseSql(`EXPLAIN (${options}) SELECT 1`)).stmts![0]!.stmt as { ExplainStmt: { options?: unknown[] } };
  try { explainOptions(stmt.ExplainStmt.options ?? []); return { ok: true }; }
  catch (e) {
    if (!(e instanceof Unsupported)) throw e;   // anything else is the XX000 this test is here to catch: it fails it
    return { code: e.sqlstate, message: e.message };
  }
}

test("every EXPLAIN option list is accepted or refused as Postgres does, in its SQLSTATE and its words", async () => {
  const differ: string[] = [];
  for (const o of OPTIONS) {
    const [want, got] = [await postgres(o), await mason(o)];
    if (JSON.stringify(want) !== JSON.stringify(got)) differ.push(`(${o}): Postgres ${JSON.stringify(want)}, Mason ${JSON.stringify(got)}`);
  }
  assert.deepEqual(differ, []);
});

test("what Mason refuses by design is answered by Postgres, and refused by Mason by name (0A000, explain-option)", async () => {
  for (const o of BY_DESIGN) {
    assert.deepEqual(await postgres(o), { ok: true }, `Postgres answers (${o})`);
    const got = await mason(o);
    assert.ok("code" in got && got.code === "0A000" && /Mason gap explain-option/.test(got.message), `(${o}): ${JSON.stringify(got)}`);
  }
});

test("the statement an EXPLAIN explains is found in its text whatever offsets its tree carries (an IN list's bounds)", async () => {
  // libpg-query writes an IN list's bounds as offsets into the text (`rexpr_list_start`), as it writes `location`:
  // they were once compared, and every EXPLAIN of a statement with `IN (…)` was refused as a Mason gap
  for (const inner of ["SELECT t FROM sp WHERE id IN (1, 5)", "SELECT ARRAY[1, 2] FROM sp", "SELECT t FROM sp WHERE id NOT IN (1) AND t IN ('a', 'b')", "SELECT 1"]) {
    for (const text of [`EXPLAIN ${inner}`, `EXPLAIN (VERBOSE, COSTS off) ${inner}`, `EXPLAIN ANALYZE ${inner}`]) {
      const stmt = (await parseSql(text)).stmts![0]!.stmt as unknown as { ExplainStmt: { query: never } };
      assert.deepEqual(await explainedText(text, stmt.ExplainStmt.query), { text: inner, offset: text.length - inner.length }, text);
    }
  }
});
