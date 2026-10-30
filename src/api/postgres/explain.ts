/**
 * AN EXPLAIN'S OPTIONS AND ITS STATEMENT, as Postgres reads them, for the DuckDB path's EXPLAIN (src/duck/explain.ts says
 * what it answers; the proposal agreed on PR #517). The options first, as Postgres parses them
 * before it analyses the statement, and in its words; then the statement as its own text, so it is classified,
 * planned and refused exactly as it would be alone.
 */
import type { Node } from "libpg-query";
import { parseSql, PostgresSyntaxError } from "./parser.ts";
import { Unsupported } from "./translate.ts";
import { gapMark } from "../../duck/gaps.ts";

export interface ExplainOptions {
  analyze: boolean;
  verbose: boolean;
  costs: boolean;
  timing: boolean;
  summary: boolean;
  format: "text" | "json";
  /** the options Postgres has that mean nothing to DuckDB (BUFFERS …): accepted, and said to be ignored */
  ignored: string[];
}

type Body = Record<string, unknown>;
const bodyOf = (n: unknown): Body => Object.values(n as Body)[0] as Body;

/** Postgres's defGetBoolean: no value is true; true / false / on / off / 1 / 0 */
function booleanOf(name: string, arg: unknown, at: number | null): boolean {
  if (arg === undefined) return true;
  const kind = Object.keys(arg as Body)[0];
  if (kind === "Integer") { const v = Number(bodyOf(arg).ival ?? 0); if (v === 0 || v === 1) return v === 1; }
  if (kind === "String" || kind === "Boolean") {
    const v = kind === "Boolean" ? String(bodyOf(arg).boolval ?? false) : String(bodyOf(arg).sval ?? "").toLowerCase();
    if (["true", "on"].includes(v)) return true;
    if (["false", "off"].includes(v)) return false;
  }
  throw new Unsupported(`${name} requires a Boolean value`, at, "42601");   // defGetBoolean: a syntax error
}

/** Postgres's defGetString: an option's value as its text (an integer's digits, a float's as written, a Boolean's
 *  true / false); no value at all is its 42601. Compared case-sensitively after, as explain.c does (`'JSON'` is not json). */
function stringOf(name: string, arg: unknown, at: number | null): string {
  if (arg === undefined) throw new Unsupported(`${name} requires a parameter`, at, "42601");
  const kind = Object.keys(arg as Body)[0];
  const b = bodyOf(arg);
  if (kind === "Integer") return String(b.ival ?? 0);   // a 0 is no field at all in the parse tree
  if (kind === "Float") return String(b.fval ?? "");
  if (kind === "Boolean") return String(b.boolval ?? false);
  return String(b.sval ?? "");
}

/** an EXPLAIN's options as Postgres reads them (explain.c ParseExplainOptionList), its errors in its words */
export function explainOptions(options: readonly unknown[]): ExplainOptions {
  const o: ExplainOptions = { analyze: false, verbose: false, costs: true, timing: true, summary: false, format: "text", ignored: [] };
  let timingSet = false, summarySet = false, wal = false, serialize = false;
  for (const d of options) {
    const b = bodyOf(d);
    const name = String(b.defname ?? "");
    const at = typeof b.location === "number" ? b.location : null;
    switch (name) {
      case "analyze": o.analyze = booleanOf("analyze", b.arg, at); break;
      case "verbose": o.verbose = booleanOf("verbose", b.arg, at); break;
      case "costs": o.costs = booleanOf("costs", b.arg, at); break;
      case "timing": o.timing = booleanOf("timing", b.arg, at); timingSet = true; break;
      case "summary": o.summary = booleanOf("summary", b.arg, at); summarySet = true; break;
      case "buffers": case "settings": case "memory": if (booleanOf(name, b.arg, at)) o.ignored.push(name.toUpperCase()); break;
      case "wal": wal = booleanOf(name, b.arg, at); if (wal) o.ignored.push("WAL"); break;
      case "serialize": {
        // SERIALIZE alone is TEXT; else OFF, NONE, TEXT or BINARY, and nothing else (no Boolean: Postgres 17 refuses `on`)
        const v = b.arg === undefined ? "text" : stringOf(name, b.arg, at);
        if (!["none", "off", "text", "binary"].includes(v)) throw new Unsupported(`unrecognized value for EXPLAIN option "serialize": "${v}"`, at, "22023");
        serialize = v === "text" || v === "binary";
        if (serialize) o.ignored.push("SERIALIZE");
        break;
      }
      case "generic_plan":
        if (booleanOf(name, b.arg, at)) throw new Unsupported(`EXPLAIN (GENERIC_PLAN) is not supported by Mason (${gapMark("explain-option")})`, at, "0A000", "bind the parameters' values and EXPLAIN that: Mason plans the statement with them", "explain-option");
        break;
      case "format": {
        const v = stringOf(name, b.arg, at);
        if (v === "text" || v === "json") { o.format = v; break; }
        if (v === "xml" || v === "yaml") throw new Unsupported(`EXPLAIN (FORMAT ${v.toUpperCase()}) is not supported by Mason (${gapMark("explain-option")})`, at, "0A000", "write FORMAT TEXT or FORMAT JSON", "explain-option");
        throw new Unsupported(`unrecognized value for EXPLAIN option "format": "${v}"`, at, "22023");
      }
      default: throw new Unsupported(`unrecognized EXPLAIN option "${name}"`, at, "42601");
    }
  }
  if (wal && !o.analyze) throw new Unsupported("EXPLAIN option WAL requires ANALYZE", null, "22023");
  if (timingSet && o.timing && !o.analyze) throw new Unsupported("EXPLAIN option TIMING requires ANALYZE", null, "22023");
  if (serialize && !o.analyze) throw new Unsupported("EXPLAIN option SERIALIZE requires ANALYZE", null, "22023");
  if (!summarySet) o.summary = o.analyze;
  if (!o.analyze) o.timing = false;
  return o;
}

/** a tree without its offsets into the text: every field @pgsql/types declares as one (an IN list's bounds too) */
const OFFSETS = new Set(["location", "name_location", "stmt_location", "stmt_len", "list_start", "list_end", "rexpr_list_start", "rexpr_list_end"]);
const stripped = (n: unknown): string => JSON.stringify(n, (k, v: unknown) => OFFSETS.has(k) ? undefined : v);

/**
 * The statement an EXPLAIN explains, as its own text: the slice of the EXPLAIN's text that parses, alone, to the tree
 * the EXPLAIN holds (its first start that does, tried at each `SELECT`, `WITH`, `VALUES`, `TABLE` or `(` after the
 * keyword) — so it is analysed, planned and refused as the statement itself is. Null where no slice does (a Mason gap:
 * the caller refuses it).
 */
export async function explainedText(text: string, query: Node): Promise<{ text: string; offset: number } | null> {
  const want = stripped(query);
  const start = /^\s*explain\b/i.exec(text.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length)));
  const from = start === null ? 0 : start[0].length;
  for (const m of text.slice(from).matchAll(/\b(select|with|values|table)\b|\(/gi)) {
    const at = from + m.index;
    let parsed;
    try { parsed = await parseSql(text.slice(at)); }
    catch (e) { if (e instanceof PostgresSyntaxError) continue; throw e; }   // a slice that is no statement: the next start
    const stmts = parsed.stmts ?? [];
    if (stmts.length === 1 && stmts[0]?.stmt !== undefined && stripped(stmts[0].stmt) === want) return { text: text.slice(at), offset: at };
  }
  return null;
}
