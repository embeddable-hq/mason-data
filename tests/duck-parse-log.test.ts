/**
 * Issue 956: the catalog Postgres's parse tree is read from its `debug_print_parse` log, which Postgres wraps at 78
 * bytes (`format_node_dump`, src/backend/nodes/print.c), breaking at a space, a name's own escaped space (`\ `)
 * included. Every name in the analysed tree must be read exactly, wherever a line break lands: against PGlite (the
 * catalog Postgres itself), and over random trees wrapped by a port of Postgres's own rule. A name with a line break is
 * refused by name before the log is read (Mason gap name-line-break): Postgres writes one just as it writes a wrapped
 * space.
 */
import { test, after, before } from "node:test";
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
before(async () => { await pglite.exec("CREATE TABLE t (id int PRIMARY KEY, j jsonb, x numeric(12,2))"); });
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
  const names = ["Unit Price", "meta → n", "a b c d e f g h", "x / 3", "two  spaces", " lead", "trail "];
  // also read exactly, beside them: parentheses, braces, a backslash, a tab
  const others = ["(paren) {brace} \\back", "tab\there"];
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
  const alphabet = ["a", "b", " ", " ", "→", "é", "(", ")", "{", "}", "\\", "\t", "x", "1", '"', "<"];
  for (let round = 0; round < 600; round++) {
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
      const tree = readParseLog(formatNodeDump(Buffer.from(text)), new Set([name]));
      assert.deepEqual(resnames(tree), [name], text);
      assert.deepEqual(colnames(tree), [name], text);
    }
  }
});

/** the gap a statement is refused by (its DETAIL's `Mason gap …`), or its analysed names */
async function readOf(sql: string): Promise<{ gap: string; message: string } | string[]> {
  const a = await analyze(catalog, sql, [], undefined, writtenNames((await parseSql(sql)).stmts![0]!.stmt)).catch((e: unknown) => e as Error & { fields?: { detail?: string } });
  if (a instanceof Error) return { gap: /Mason gap ([a-z-]+)/.exec(a.fields?.detail ?? "")?.[1] ?? `no gap: ${a.message}`, message: a.message };
  if ("refused" in a) return { gap: `Postgres ${a.refused.C}`, message: a.refused.M ?? "" };
  return resnames(a.tree);
}
/** every statement of `sqls` that is not refused as a name with a line break */
async function notRefusedAsLineBreak(sqls: readonly string[]): Promise<string[]> {
  const wrong: string[] = [];
  for (const sql of sqls) {
    const r = await readOf(sql);
    if (Array.isArray(r) || r.gap !== "name-line-break") wrong.push(`${sql.slice(0, 160)}: ${JSON.stringify(r).slice(0, 160)}`);
  }
  return wrong;
}

test("issue 956: a table's column with a line break is refused by name, read through a * or not read at all, never misread", async () => {
  await pglite.exec(`CREATE TABLE lb (id int PRIMARY KEY, ${ident(LB)} int)`);
  await pglite.exec(`CREATE TABLE lb_swapped (id int PRIMARY KEY, ${ident("line break\nhere")} int)`);
  const sqls: string[] = [];
  for (let n = 1; n <= 80; n += 3) {
    // the WITH queries come first in the log, so their names move every break across the table's columns
    const ctes = `WITH "${"p".repeat(Math.min(n, 60))}" AS (SELECT 1), "${"q".repeat(Math.max(1, n - 59))}" AS (SELECT 2)`;
    sqls.push(`${ctes} SELECT t.id AS one, s.* FROM lb t, lb s`, `${ctes} SELECT 1 AS one, s.id FROM lb s`, `${ctes} SELECT * FROM lb_swapped`);
  }
  assert.deepEqual(await notRefusedAsLineBreak(sqls), []);
  const r = await readOf("SELECT * FROM lb");
  assert.ok(!Array.isArray(r) && r.message.includes(JSON.stringify(LB)), `the refusal names the column: ${JSON.stringify(r)}`);
});

test("issue 956: a table whose columns are each other's wrapped readings is refused by name, never read as another column", async () => {
  // the re-check of a785eb82 (its b26): read through a * beside string constants that hold the other readings, the
  // wrong column was picked; the constants' line breaks are no names, and a statement of them alone is answered
  const cols = ["a\nc ", "a c ", "a c\n", "a\nc\n"];
  await pglite.exec(`CREATE TABLE b26 (id int PRIMARY KEY, ${cols.map((c) => `${ident(c)} text`).join(", ")})`);
  const lits = "E'a c ' <> '' AND E'a c\\n' <> '' AND E'a\\nc\\n' <> ''";
  const sqls: string[] = [];
  for (let pad = 30; pad < 60; pad += 2) {
    const a = "q".repeat(pad);
    sqls.push(`SELECT ${a}.* FROM b26 ${a} WHERE ${lits} ORDER BY 2`, `SELECT DISTINCT ON (3) ${a}.* FROM b26 ${a} WHERE ${lits} ORDER BY 3, 2`,
      `SELECT s.* FROM (SELECT * FROM b26 ${a} WHERE ${lits}) s ORDER BY 2`);
  }
  assert.deepEqual(await notRefusedAsLineBreak(sqls), []);
  assert.deepEqual(await readOf(`SELECT t.id FROM t WHERE ${lits}`), ["id"]);
});

test("issue 956: a long name that reads two ways no name tells apart is refused by name (Mason gap name-unreadable)", async () => {
  // a long name of escaped characters broken inside just after a backslash: a wrapped escaped space, or inserted
  const { readParseLog, UnreadableNames } = await import("../src/duck/pgtree.ts");
  let detail: string | undefined;
  for (let k = 0; k < 160 && detail === undefined; k++) {
    const name = outToken(`${"a".repeat(k % 2)}${"(".repeat(41)}`), pad = 1 + Math.floor(k / 2);
    const wrapped = formatNodeDump(Buffer.from(`{QUERY :pad ${"z".repeat(pad)} :targetList ({TARGETENTRY :resname ${name} :location -1}) :x 1}`));
    try { readParseLog(wrapped, new Set()); } catch (e) { if (e instanceof UnreadableNames) detail = wrapped.toString("utf8"); else throw e; }
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

test("issue 956: a name that ends in a line break, holds one or is one is refused by name, through a * and by its name", async () => {
  await pglite.exec(`CREATE TABLE tl (id int PRIMARY KEY, ${ident("note\n")} text, ${ident("\n")} int, ${ident("c\rr")} int, amount numeric(12,2))`);
  const sqls: string[] = [];
  for (let n = 1; n <= 80; n += 5) {
    const ctes = `WITH "${"p".repeat(Math.min(n, 60))}" AS (SELECT 1), "${"q".repeat(Math.max(1, n - 59))}" AS (SELECT 2)`;
    sqls.push(`${ctes} SELECT * FROM tl ORDER BY id`, `${ctes} SELECT tl.* FROM tl ORDER BY 1`, `${ctes} SELECT id, ${ident("note\n")} FROM tl ORDER BY id`, `${ctes} SELECT id, amount FROM tl`);
  }
  for (const count of [1, 2, 14, 39]) {
    for (const shape of [(i: number) => `note${i}\n`, (i: number) => `a${i}\nb`, (i: number) => `c${i}\r`, () => "\n"]) {
      const names = Array.from({ length: count }, (_, i) => shape(i));
      sqls.push(`SELECT s.* FROM (SELECT t.id AS p, ${names.map((x, i) => `t.x / ${i + 3} AS ${ident(x)}`).join(", ")} FROM t) s ORDER BY 1`);
    }
  }
  // a WITH query's column and a VALUES list's, named
  sqls.push(`WITH w(${ident("a\nb")}) AS (SELECT 1) SELECT * FROM w`, `SELECT * FROM (VALUES (1)) v(${ident("x\n")})`);
  assert.deepEqual(await notRefusedAsLineBreak(sqls), []);
});

test("issue 956: names of six line breaks, or of 400 line breaks and spaces, are refused at once, never read for seconds", async () => {
  // the re-checks of PR 974: each six-break name was read 64 ways, and a 1 MB statement held the listener's thread for
  // 558 s; a name with a line break is now refused before the log is read
  const six = ["\n \n \n \n \n \n", "\n\n\n\n\n\n", "a\nb\nc d\ne\nf\ng"];
  const sqls = [
    `SELECT s.* FROM (SELECT ${Array.from({ length: 400 }, (_, i) => `t.id + ${i} AS ${ident(`${"\n ".repeat(30)}${i}`)}`).join(", ")} FROM t) s`,
    `SELECT s.* FROM (SELECT ${Array.from({ length: 300 }, (_, i) => `t.x / ${i + 3} AS ${ident(`${six[i % 3]!}${i}`)}`).join(", ")} FROM t) s`,
  ];
  for (const sql of sqls) {
    const started = performance.now();
    assert.deepEqual(await notRefusedAsLineBreak([sql]), []);
    const took = performance.now() - started;
    assert.ok(took < 3000, `refused in ${Math.round(took)} ms`);
  }
});

/** the analysed names of `sql`, or the refusal's message */
async function namesOf(sql: string): Promise<string[] | string> {
  const r = await readOf(sql);
  return Array.isArray(r) ? r : `refused ${r.gap}: ${r.message}`;
}

test("issue 956: a name of quotes and backslashes in turn is read exactly, alone and beside others", async () => {
  // re-check of PR 974: a break inside it read as a space could split it in two strings, and the name was refused
  const name = (i: number): string => `${"\"\\".repeat(30)}"A${String.fromCharCode(90 - i)}`;
  const wrong: string[] = [];
  for (let count = 1; count <= 4; count++) {
    for (let pad = 1; pad <= 40; pad += 3) {
      const names = Array.from({ length: count }, (_, i) => name(i));
      const sql = `SELECT t.id AS ${"p".repeat(pad)}, ${names.map((n, i) => `t.x / ${i + 3} AS ${ident(n)}`).join(", ")} FROM t ORDER BY 1`;
      const got = await namesOf(sql);
      if (JSON.stringify(got) !== JSON.stringify(["p".repeat(pad), ...names])) wrong.push(`${count} names, pad ${pad}: ${JSON.stringify(got).slice(0, 200)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("issue 956: a long statement of names of quotes and backslashes is read in about the time of a plain one of its size", async () => {
  // re-check of PR 974: the log was parsed again for each way to read it, and a 64 KB statement held the listener's
  // thread 1.56 s where main took 79 ms; the log is now walked once and parsed once
  const list = `WHERE 1 IN (${Array.from({ length: 10730 }, (_, i) => i).join(", ")})`;
  const odd = `SELECT ${Array.from({ length: 4 }, (_, i) => `t.id + ${i} AS ${ident(`${"\"\\".repeat(30)}"A${i}`)}`).join(", ")} FROM t ${list}`;
  const plain = `SELECT ${Array.from({ length: 4 }, (_, i) => `t.id + ${i} AS q${i}`).join(", ")} FROM t ${list}`;
  const timed = async (sql: string): Promise<number> => {
    const written = writtenNames((await parseSql(sql)).stmts![0]!.stmt);
    let best = Infinity;
    for (let r = 0; r < 3; r++) { const t0 = performance.now(); await analyze(catalog, sql, [], undefined, written); best = Math.min(best, performance.now() - t0); }
    return best;
  };
  const p = await timed(plain), q = await timed(odd);
  assert.ok(q < 3 * p + 150, `the names took ${Math.round(q)} ms, a plain statement of the size ${Math.round(p)} ms`);
});
