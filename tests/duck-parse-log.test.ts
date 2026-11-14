/**
 * Issue 956: the catalog Postgres's parse tree is read from its `debug_print_parse` log, which Postgres wraps at 78
 * bytes (`format_node_dump`, src/backend/nodes/print.c), breaking at a space, a name's own escaped space (`\ `)
 * included. Every name in the analysed tree must be read exactly, wherever a line break lands: against PGlite (the
 * catalog Postgres itself), and over random trees wrapped by a port of Postgres's own rule. A name with a line break
 * the log cannot tell apart is refused by name (Mason gap name-unreadable).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import * as analyzeModule from "../src/duck/analyze.ts";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import type { TreeValue } from "../src/duck/pgtree.ts";

const { analyze } = analyzeModule;
/** the statement's own names (absent before issue 956: the analysis is then asked without them) */
const writtenNames = (analyzeModule as { writtenNames?: (raw: unknown) => Set<string> }).writtenNames ?? ((): Set<string> => new Set());
const pglite = new PGlite();
const catalog = (b: Uint8Array): Promise<Uint8Array> => pglite.execProtocolRaw(b);
after(async () => { await pglite.close(); await stopParser(); });

/** every TARGETENTRY's resname of the tree, in the order met */
function resnames(tree: TreeValue): string[] {
  const out: string[] = [];
  const visit = (v: TreeValue): void => {
    if (v === null || typeof v === "string") return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v._node === "TARGETENTRY" && typeof v.resname === "string") out.push(v.resname);
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}
const colnames = (tree: TreeValue): TreeValue => (tree as unknown as { colnames: TreeValue }).colnames;
/** a name as a U&"…" identifier, its line breaks and tabs escaped */
const ident = (m: string): string => `U&"${[...m].map((ch) => ch === "\n" ? "\\000A" : ch === "\t" ? "\\0009" : ch === "\\" ? "\\\\" : ch === '"' ? '""' : ch).join("")}"`;

test("issue 956: every name in the analysed tree is read exactly, wherever the log's line breaks land in it", async () => {
  await pglite.exec("CREATE TABLE t (id int PRIMARY KEY, j jsonb, x numeric(12,2))");
  const wrong: string[] = [];
  for (let n = 1; n <= 80; n++) {
    // a name is cut to 63 bytes, so two pads shift the names past one line's length
    const names = ["p".repeat(Math.min(n, 60)), "o".repeat(Math.max(1, n - 59)), "Unit Price", "meta → n", "a b c d e f g h i j", "x / 3", "line\nbreak here", "two  spaces", " lead", "trail ", "(paren) {brace} \\back", "tab\there"];
    const sql = `SELECT s.* FROM (SELECT ${names.map((m, i) => `t.id + ${i} AS ${ident(m)}`).join(", ")} FROM t) s`;
    const a = await analyze(catalog, sql, [], undefined, writtenNames((await parseSql(sql)).stmts![0]!.stmt));
    if ("refused" in a) { wrong.push(`${sql}: refused ${a.refused.M}`); continue; }
    // the inner SELECT's names, then the outer `*`'s: each as written
    const got = resnames(a.tree);
    if (JSON.stringify(got) !== JSON.stringify([...names, ...names])) wrong.push(`${sql}\n  got ${JSON.stringify(got)}`);
  }
  assert.deepEqual(wrong, []);
});

/** a column name whose line break can trade places with a wrapped space in it (the log then reads two ways) */
const LB = "line\nbreak here";
test("issue 956: a table's column with a line break that the statement does not write is refused by name where the log cannot tell it, and read exactly elsewhere", async () => {
  await pglite.exec(`CREATE TABLE lb (id int PRIMARY KEY, ${ident(LB)} int)`);
  let refused = 0, read = 0;
  for (let n = 1; n <= 80; n++) {
    // the WITH queries come first in the log, so their names move every break across the table's columns
    const sql = `WITH "${"p".repeat(Math.min(n, 60))}" AS (SELECT 1), "${"q".repeat(Math.max(1, n - 59))}" AS (SELECT 2) SELECT t.id AS one, s.* FROM lb t, lb s`;
    const written = writtenNames((await parseSql(sql)).stmts![0]!.stmt);
    const a: Awaited<ReturnType<typeof analyze>> | Error = await analyze(catalog, sql, [], undefined, written).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (a instanceof Error) {
      const err = a as { fields?: { code?: string; detail?: string } };
      assert.equal(err.fields?.code, "0A000", `${sql}: ${String(a)}`);
      assert.match(err.fields?.detail ?? "", /Mason gap name-unreadable/, sql);
      refused++;
    } else {
      assert.ok(!("refused" in a), sql);
      assert.deepEqual(resnames(a.tree).slice(-3), ["one", "id", LB], sql);
      read++;
    }
  }
  assert.ok(refused > 0 && read > 0, `refused ${refused}, read ${read}: the sweep must meet both`);
});

/** Postgres's format_node_dump (src/backend/nodes/print.c), byte for byte */
function formatNodeDump(dump: Buffer): Buffer {
  const out: number[] = [];
  let i = 0, j = 0;
  let line: number[] = [];
  for (;;) {
    line = [];
    for (j = 0; j < 78 && i < dump.length; i++, j++) line.push(dump[i]!);
    if (i >= dump.length) break;
    if (dump[i] === 32) i++;
    else {
      let k = j - 1;
      for (; k > 0; k--) if (line[k] === 32) break;
      if (k > 0) { i -= j - k - 1; j = k; }
    }
    out.push(...line.slice(0, j), 10);
  }
  if (j > 0) out.push(...line.slice(0, j), 10);
  return Buffer.from(out);
}

/** outToken's escaping (src/backend/nodes/outfuncs.c) */
const outToken = (s: string): string => (/^[<"0-9]|^[+-][0-9.]/.test(s) ? "\\" : "") + s.replace(/[ \n\t(){}\\]/g, (c) => `\\${c}`);

test("issue 956: a tree wrapped by Postgres's rule is read back with every name as written", async () => {
  const { readParseLog } = await import("../src/duck/pgtree.ts");
  let seed = 956;
  const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const alphabet = ["a", "b", " ", " ", "→", "é", "\n", "(", ")", "{", "}", "\\", "\t", "x", "1", '"', "<"];
  for (let round = 0; round < 400; round++) {
    const names = Array.from({ length: 1 + rand(8) }, () => Array.from({ length: 1 + rand(63) }, () => alphabet[rand(alphabet.length)]!).join(""));
    const text = `{QUERY :pad ${"z".repeat(1 + rand(80))} :targetList (${names.map((m, i) => `{TARGETENTRY :resno ${i + 1} :resname ${outToken(m)} :location -1}`).join(" ")}) ` +
      `:colnames (${names.map((m) => `"${outToken(m)}"`).join(" ")}) :constvalue 5 [ 20 0 0 0 110 ]}`;
    const tree = readParseLog(formatNodeDump(Buffer.from(text)), new Set(names));
    assert.deepEqual(resnames(tree), names, text);
    assert.deepEqual(colnames(tree), names, text);
  }
});

test("issue 956: a run of 78 bytes or more with no space is broken inside it, and read back whole", async () => {
  const { readParseLog } = await import("../src/duck/pgtree.ts");
  for (const name of ["(".repeat(40), `${"(".repeat(30)}→${")".repeat(20)}`, "{}".repeat(31), `a ${"\\".repeat(45)}`]) {
    for (let pad = 1; pad <= 80; pad++) {
      const text = `{QUERY :pad ${"z".repeat(pad)} :targetList ({TARGETENTRY :resname ${outToken(name)}}) :colnames ("${outToken(name)}")}`;
      const tree = readParseLog(formatNodeDump(Buffer.from(text)));
      assert.deepEqual(resnames(tree), [name], text);
      assert.deepEqual(colnames(tree), [name], text);
    }
  }
});
