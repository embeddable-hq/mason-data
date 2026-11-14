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
import { cstr, decodeBackend, frame, int16, noticeResponse, readyForQuery } from "../src/api/postgres/protocol.ts";
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

/** the catalog's own `debug_print_parse` log of a statement, as Postgres wraps it (the test's view of what the reader reads) */
async function parseLog(sql: string): Promise<string> {
  const q = (s: string): Buffer => frame("Q", cstr(s));
  const reply = await catalog(Buffer.concat([q("SET client_min_messages = log; SET debug_print_parse = on; SET debug_pretty_print = off"),
    frame("P", cstr(""), cstr(sql), int16(0)), frame("S"), q("RESET debug_print_parse; RESET debug_pretty_print; RESET client_min_messages")]));
  const log = decodeBackend(Buffer.from(reply)).find((m) => m.type === "NoticeResponse" && /^\{QUERY :commandType 1 /.test(m.fields.D ?? ""));
  assert.ok(log?.type === "NoticeResponse", sql);
  return log.fields.D!;
}

test("issue 956: every name in the analysed tree is read exactly, with a line break of the log on each of its spaces", async () => {
  await pglite.exec("CREATE TABLE t (id int PRIMARY KEY, j jsonb, x numeric(12,2))");
  const names = ["Unit Price", "meta → n", "a b c d e f g h", "x / 3", "two  spaces", " lead", "trail "];
  // also read exactly, beside them: a name's own line break, parentheses, braces, a backslash, a tab
  const others = ["line\nbreak here", "(paren) {brace} \\back", "tab\there"];
  const escaped = (s: string): string => s.replace(/[ \n\t(){}\\]/g, (c) => `\\${c}`);
  const broken = new Set<string>();
  const wrong: string[] = [];
  // Everything before a name is the same whatever the name holds, so Postgres's lines up to it are too: a prefix of
  // m letters inside each name moves its spaces one byte at a time past the end of a line, so the break lands on each
  for (const outer of [1, 40]) {
    for (let m = 0; m <= 47; m++) {
      const pre = "p".repeat(m);
      const all = [...names.map((n) => pre + n), ...others];
      const sql = `SELECT s.* FROM (SELECT t.id AS ${"o".repeat(outer)}, ${all.map((n, i) => `t.id + ${i} AS ${ident(n)}`).join(", ")} FROM t) s`;
      const log = await parseLog(sql);
      names.forEach((n) => [...n].forEach((ch, k) => {
        if (ch === " " && log.includes([...(pre + n)].map((c, j) => j === m + k ? "\\\n" : escaped(c)).join(""))) broken.add(`${n}@${k}`);
      }));
      const a = await analyze(catalog, sql, [], undefined, writtenNames((await parseSql(sql)).stmts![0]!.stmt));
      if ("refused" in a) { wrong.push(`${sql}: refused ${a.refused.M}`); continue; }
      // the inner SELECT's names, then the outer `*`'s: each as written
      const want = ["o".repeat(outer), ...all];
      const got = resnames(a.tree);
      if (JSON.stringify(got) !== JSON.stringify([...want, ...want])) wrong.push(`${sql}\n  got ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(wrong, []);
  // the sweep did put a line break on every space of every name
  const spaces = names.flatMap((n) => [...n].flatMap((ch, k) => ch === " " ? [`${n}@${k}`] : []));
  assert.deepEqual(spaces.filter((s) => !broken.has(s)), [], "a space of a name the log never broke a line at");
});

/** a column name whose line break can trade places with a wrapped space in it (the log then reads two ways) */
const LB = "line\nbreak here";
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

test("issue 956: a table's column with a line break that the statement does not write is read exactly, told by the catalog's columns", async () => {
  await pglite.exec(`CREATE TABLE lb (id int PRIMARY KEY, ${ident(LB)} int)`);
  for (let n = 1; n <= 80; n++) {
    // the WITH queries come first in the log, so their names move every break across the table's columns; the
    // statement never names the column (read through a `*`, and not read at all)
    const ctes = `WITH "${"p".repeat(Math.min(n, 60))}" AS (SELECT 1), "${"q".repeat(Math.max(1, n - 59))}" AS (SELECT 2)`;
    for (const [sql, last] of [[`${ctes} SELECT t.id AS one, s.* FROM lb t, lb s`, ["one", "id", LB]], [`${ctes} SELECT 1 AS one, s.id FROM lb s`, ["one", "id"]]] as const) {
      const a = await analyze(catalog, sql, [], undefined, writtenNames((await parseSql(sql)).stmts![0]!.stmt));
      assert.ok(!("refused" in a), sql);
      assert.deepEqual(resnames(a.tree).slice(-last.length), last, sql);
    }
  }
});

test("issue 956: a log whose names no reading tells apart is refused by name (Mason gap name-unreadable)", async () => {
  // a column's line break that trades places with a wrapped space, in a log no statement or column names it in
  const name = outToken(LB);
  let detail: string | undefined;
  for (let pad = 1; pad <= 80 && detail === undefined; pad++) {
    const wrapped = formatNodeDump(Buffer.from(`{QUERY :pad ${"z".repeat(pad)} :colnames ("id" "${name}") :x 1}`));
    const { unwrapNodeDump } = await import("../src/duck/pgtree.ts");
    if (unwrapNodeDump(wrapped).length > 1) detail = wrapped.toString("utf8");
  }
  assert.ok(detail !== undefined, "a log that reads two ways");
  // the catalog as analyze talks to it: the analysis's two replies, then the read of the columns' names (none)
  const fake = async (bytes: Uint8Array): Promise<Uint8Array> => Buffer.from(bytes).includes("pg_attribute")
    ? Buffer.concat([frame("C", cstr("SELECT 0")), readyForQuery("I")])
    : Buffer.concat([readyForQuery("I"), noticeResponse({ severity: "LOG", code: "00000", message: "parse tree:", detail }), frame("1"), frame("n"), frame("3"), readyForQuery("I"), readyForQuery("I")]);
  const e = await analyze(fake, "SELECT 1", []).then(() => null, (x: unknown) => x as { fields?: { code?: string; detail?: string } });
  assert.equal(e?.fields?.code, "0A000");
  assert.match(e?.fields?.detail ?? "", /Mason gap name-unreadable/);
});

test("issue 956: many long names of characters Postgres escapes, each broken inside, are read exactly", async () => {
  // four names of 45 escaped characters, each written twice in the tree: eight breaks inside a token or more
  const names = ["(".repeat(45), ")".repeat(45), "{}".repeat(22), "\\".repeat(45)];
  for (let pad = 1; pad <= 40; pad++) {
    const sql = `SELECT s.* FROM (SELECT t.id AS ${"o".repeat(pad)}, ${names.map((n, i) => `t.id + ${i} AS ${ident(n)}`).join(", ")} FROM t) s`;
    const a = await analyze(catalog, sql, [], undefined, writtenNames((await parseSql(sql)).stmts![0]!.stmt));
    assert.ok(!("refused" in a), sql);
    assert.deepEqual(resnames(a.tree), ["o".repeat(pad), ...names, "o".repeat(pad), ...names], sql);
  }
});
