/**
 * EXPLAIN ON THE DUCKDB PATH (the proposal agreed on PR #517): Postgres's shape, the truth inside.
 * One text column `QUERY PLAN`, a line a row (or Postgres's JSON plan for FORMAT JSON, which pgAdmin, DBeaver and
 * DataGrip draw), in three parts:
 *   1. where the answer comes from: DuckDB's copy of each table it reads, its rows, its last poll;
 *   2. what Mason changed: the DuckDB SQL sent, and what Mason computes after DuckDB (exact numerics) or inside it (its
 *      functions DuckDB calls);
 *   3. DuckDB's plan, its operators under DuckDB's own names (never `Seq Scan`: a Postgres reader would look for a
 *      missing index that would never help here), Postgres's `->` layout, `rows=` DuckDB's estimate and no cost.
 * ANALYZE runs the statement (under its timeout and memory limit, through the same conversion), sends none of its
 * rows, and adds each operator's rows and time and Postgres's two closing lines, each split into where the time went.
 * The statement is the one the statement alone would be: refused with the same error (src/api/postgres/translate.ts
 * `duckTranslate`), planned by the same planner (src/duck/plan.ts), run by the same runner.
 */
import type { ExplainOptions } from "../api/postgres/explain.ts";

type Body = Record<string, unknown>;

// --------------------------------------------------------------------------------------------- DuckDB's plan

/** one operator of DuckDB's plan, from `EXPLAIN (FORMAT JSON)` or the profiler (ANALYZE) */
export interface PlanNode {
  /** DuckDB's operator (`TOP_N`, `HASH_GROUP_BY`) */
  type: string;
  extra: Record<string, string | string[]>;
  /** DuckDB's estimated cardinality */
  estimate: number | null;
  /** ANALYZE: the rows it produced, and its THREAD time with the operators under it, ms — DuckDB's profiler times each
   *  operator summed over the threads that ran it, so a parallel scan's exceeds the statement's elapsed time; never
   *  labelled Postgres's `actual time` (the Fable review of #517) */
  actualRows?: number;
  threadMs?: number;
  children: PlanNode[];
}

/** a node of DuckDB's JSON, either form: `name` (EXPLAIN) or `type` with `intermediate_rows` and `timing` (the profile).
 *  The profile's RESULT_COLLECTOR and EXECUTE are the result's plumbing, not the plan's: their child stands for them */
export function planNodes(json: unknown): PlanNode[] {
  const list = Array.isArray(json) ? json : [json];
  return list.flatMap((n): PlanNode[] => {
    const b = n as Body;
    const type = String(b.name ?? b.type ?? "");
    const children = planNodes((b.children ?? []) as unknown[]);
    if (type === "RESULT_COLLECTOR" || type === "EXECUTE" || type === "EXPLAIN_ANALYZE") return children;
    const extra = { ...(b.extra_info ?? {}) as Record<string, string | string[]> };
    const est = extra["Estimated Cardinality"];
    delete extra["Estimated Cardinality"];
    const node: PlanNode = { type: type === "SEQ_SCAN" ? "TABLE_SCAN" : type, extra, estimate: typeof est === "string" && /^\d+$/.test(est) ? Number(est) : null, children };
    if (typeof b.intermediate_rows === "number") {
      node.actualRows = b.intermediate_rows;
      node.threadMs = Number(b.timing ?? 0) * 1000 + children.reduce((s, c) => s + (c.threadMs ?? 0), 0);
    }
    return [node];
  });
}

/** DuckDB's operator as DuckDB's own plan prints it (`HASH_GROUP_BY` is `Hash Group By`), a scan `Table Scan` as its
 *  profiler names it: DuckDB's EXPLAIN says SEQ_SCAN for the same operator, and Postgres's `Seq Scan` says otherwise */
export const operatorName = (type: string): string => type.toLowerCase().split("_").map((w) => w === "n" ? "N" : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** the copy a scan reads, as Postgres names a table (DuckDB's `<file>.<schema>.<table>`) */
export const scannedTable = (n: PlanNode): string | null => {
  const t = n.extra.Table;
  return typeof t === "string" ? t.split(".").slice(-2).join(".") : null;
};

export function scannedTables(nodes: readonly PlanNode[]): string[] {
  const out: string[] = [];
  const walk = (n: PlanNode): void => { const t = scannedTable(n); if (t !== null && !out.includes(t)) out.push(t); n.children.forEach(walk); };
  nodes.forEach(walk);
  return out;
}

// --------------------------------------------------------------------------------------------- the answer

/** `rows`: DuckDB's estimate of the copy's rows (duckdb_tables().estimated_size), said as one */
export interface Copy { table: string; rows: number | null; polledAt: string | null }

/** what EXPLAIN says: Mason's two sections, DuckDB's plan, ANALYZE's times */
export interface Explained {
  copies: Copy[];
  sql: string;
  /** each column Mason computes after DuckDB, said (`column 2 "total": an exact numeric from 2 of DuckDB's values`) */
  computed: string[];
  /** Mason's functions the DuckDB SQL calls (they run inside DuckDB, on every row they read) */
  functions: string[];
  plan: PlanNode[];
  analyzed?: {
    rows: number;
    planning: { analysisMs: number; rewriteMs: number; duckdbMs: number };
    execution: { duckdbMs: number; masonMs: number };
  };
}

const ms = (x: number): string => x.toFixed(3);
const count = (n: number): string => n.toLocaleString("en-US");
const detail = (v: string | string[]): string => Array.isArray(v) ? v.join(", ") : v;
/** the details a plan line carries without VERBOSE: everything but the projections and filters, which VERBOSE adds */
const VERBOSE_ONLY = new Set(["Projections", "Filters", "Table", "Type"]);

function copyLine(c: Copy): string {
  const rows = c.rows === null ? "rows unknown" : `about ${count(c.rows)} rows`;
  return `${c.table} (${rows}; kept current by polling, ${c.polledAt === null ? "no poll recorded yet" : `last poll ${c.polledAt}`})`;
}

/** EXPLAIN as Postgres's text format: one line a row */
export function explainText(e: Explained, o: ExplainOptions): string[] {
  const lines: string[] = [];
  lines.push(e.copies.length === 0 ? "Mason: answered by DuckDB, reading none of its copies"
    : e.copies.length === 1 ? `Mason: answered by DuckDB from its copy of ${copyLine(e.copies[0]!)}` : "Mason: answered by DuckDB from its copies of");
  if (e.copies.length > 1) for (const c of e.copies) lines.push(`  ${copyLine(c)}`);
  lines.push(`  Sent to DuckDB: ${e.sql}`);
  lines.push(`  Computed by Mason after DuckDB: ${e.computed.length === 0 ? "nothing" : e.computed.join("; ")}`);
  if (e.functions.length > 0) lines.push(`  Mason's functions DuckDB calls: ${e.functions.join(", ")}`);
  for (const name of o.ignored) lines.push(`  Note: ${name} has no DuckDB meaning: ignored`);
  if (e.analyzed !== undefined && o.timing) lines.push("  Note: an operator's thread time is DuckDB's, summed over the threads that ran it and the operators under it: a parallel one's exceeds the Execution Time");
  const walk = (n: PlanNode, depth: number): void => {
    const lead = depth === 0 ? "" : `${" ".repeat(6 * depth - 4)}->  `;
    const on = scannedTable(n);
    const est = o.costs && n.estimate !== null ? `  (rows=${n.estimate})` : "";
    const actual = n.actualRows === undefined ? "" : ` (actual rows=${n.actualRows}${o.timing && n.threadMs !== undefined ? `, thread time=${ms(n.threadMs)} ms` : ""})`;
    lines.push(`${lead}${operatorName(n.type)}${on === null ? "" : ` on ${on}`}${est}${actual}`);
    const pad = " ".repeat(depth === 0 ? 2 : 6 * depth + 2);
    for (const [k, v] of Object.entries(n.extra)) if (o.verbose ? k !== "Table" : !VERBOSE_ONLY.has(k)) lines.push(`${pad}${k}: ${detail(v)}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  e.plan.forEach((n) => walk(n, 0));
  if (e.analyzed !== undefined && o.summary) {
    const p = e.analyzed.planning, x = e.analyzed.execution;
    lines.push(`Planning Time: ${ms(p.analysisMs + p.rewriteMs + p.duckdbMs)} ms (Postgres's analysis ${ms(p.analysisMs)}, Mason's rewrite ${ms(p.rewriteMs)}, DuckDB's planning ${ms(p.duckdbMs)})`);
    lines.push(`Execution Time: ${ms(x.duckdbMs + x.masonMs)} ms (DuckDB ${ms(x.duckdbMs)}, Mason's conversion and exact numerics ${ms(x.masonMs)})`);
  }
  return lines;
}

/** EXPLAIN as Postgres's JSON format: `[{ "Plan": { "Node Type", "Plans", "Plan Rows", "Actual Rows" … } }]` where the
 *  meaning is Postgres's, DuckDB's operator names, and what is DuckDB's own in keys of their own — its thread time is
 *  `DuckDB Thread Time`, never `Actual Total Time`, which a plan viewer draws as elapsed */
export function explainJson(e: Explained, o: ExplainOptions): string {
  const node = (n: PlanNode): Record<string, unknown> => {
    const on = scannedTable(n);
    return {
      "Node Type": operatorName(n.type),
      ...(on === null ? {} : { "Relation Name": on.split(".")[1], Schema: on.split(".")[0] }),
      ...(o.costs && n.estimate !== null ? { "Plan Rows": n.estimate } : {}),
      ...(n.actualRows === undefined ? {} : { "Actual Rows": n.actualRows, "Actual Loops": 1, ...(o.timing && n.threadMs !== undefined ? { "DuckDB Thread Time": Number(ms(n.threadMs)) } : {}) }),
      ...Object.fromEntries(Object.entries(n.extra).filter(([k]) => o.verbose ? k !== "Table" : !VERBOSE_ONLY.has(k)).map(([k, v]) => [`DuckDB ${k}`, v])),
      ...(n.children.length === 0 ? {} : { Plans: n.children.map(node) }),
    };
  };
  // Postgres's plan has one root; DuckDB's has one too (a statement's), kept as a list should it ever have more
  const roots = e.plan.map(node);
  const top: Record<string, unknown> = {
    Plan: roots.length === 1 ? roots[0] : { "Node Type": "DuckDB Plans", Plans: roots },
    Mason: {
      "Answered By": "DuckDB",
      Copies: e.copies.map((c) => ({ Table: c.table, "Estimated Rows": c.rows, "Kept Current By": "polling", "Last Poll": c.polledAt })),
      "Sent To DuckDB": e.sql,
      "Computed After DuckDB": e.computed,
      "Mason Functions DuckDB Calls": e.functions,
      ...(o.ignored.length === 0 ? {} : { Ignored: o.ignored.map((n) => `${n} has no DuckDB meaning`) }),
    },
  };
  if (e.analyzed !== undefined && o.summary) {
    const p = e.analyzed.planning, x = e.analyzed.execution;
    top["Planning Time"] = Number(ms(p.analysisMs + p.rewriteMs + p.duckdbMs));
    top["Execution Time"] = Number(ms(x.duckdbMs + x.masonMs));
    (top.Mason as Body)["Planning"] = { "Postgres Analysis": Number(ms(p.analysisMs)), "Mason Rewrite": Number(ms(p.rewriteMs)), "DuckDB Planning": Number(ms(p.duckdbMs)) };
    (top.Mason as Body)["Execution"] = { DuckDB: Number(ms(x.duckdbMs)), "Mason Conversion": Number(ms(x.masonMs)) };
  }
  return JSON.stringify([top], null, 2);
}
