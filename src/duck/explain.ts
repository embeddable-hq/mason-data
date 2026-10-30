/**
 * EXPLAIN ON THE DUCKDB PATH (the proposal agreed on PR #517): Postgres's shape, the truth inside.
 * One text column `QUERY PLAN`, a line a row (or Postgres's JSON plan for FORMAT JSON, which pgAdmin, DBeaver and
 * DataGrip draw), in three parts:
 *   1. where the answer comes from: DuckDB's copy of each table it reads, its rows, and how it is kept current — as
 *      the sync says it to `mason status` (`keptText`; src/duck/sync.ts `KeptCurrent`), never the poll's ledger alone;
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
import type { CopyState, KeptCurrent } from "./sync.ts";
import { agoText, syncText } from "../lib/table-sync.ts";

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

/** a profile DuckDB's profiler wrote (`enable_profiling = 'json'`): the statement it timed, as it names it (`query.sql`,
 *  the text it was given), and its plan. The name is what holds a profile to its statement (src/duck/store.ts
 *  `explained`): the file is the last profiled statement's on the connection, whichever that was */
export function profiled(doc: unknown): { sql: string | null; plan: PlanNode[] } {
  const d = doc as { query?: { sql?: unknown }; operator?: unknown[] };
  return { sql: typeof d.query?.sql === "string" ? d.query.sql : null, plan: planNodes(d.operator ?? []) };
}

/** what EXPLAIN ANALYZE says of a statement DuckDB's profiler timed no operator of */
export const UNPROFILED = "the engine's profiler recorded no operator of this statement: the engine answered it while planning it (as it answers a count(*) of a whole table from the table's row count), so the plan is its EXPLAIN, with the rows it answered";

/** DuckDB's operator as DuckDB's own plan prints it (`HASH_GROUP_BY` is `Hash Group By`), a scan `Table Scan` as its
 *  profiler names it: DuckDB's EXPLAIN says SEQ_SCAN for the same operator, and Postgres's `Seq Scan` says otherwise */
export const operatorName = (type: string): string => type.toLowerCase().split("_").map((w) => w === "n" ? "N" : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** a table's schema and name, as the source has them (unquoted): the sync's `source` is `${schema}.${name}` */
export interface TableName { schema: string; name: string }

/** a name as Postgres writes one in a statement: bare when it is lower case letters, digits and `_`, else quoted */
const quotedName = (s: string): string => /^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`;

/**
 * A TABLE AS POSTGRES WRITES IT, each part quoted where it must be (`public.orders`, `public."Clients"`,
 * `public."x; y"`): the ONE way EXPLAIN names a copy (its line, FORMAT JSON's `Mason.Tables[].Table`), which a statement
 * can read back as it is (`mason mcp`'s tables and describe name tables by it too).
 */
export const qualifiedName = (t: TableName): string => `${quotedName(t.schema)}.${quotedName(t.name)}`;

/** DuckDB's `<file>.<schema>.<table>`, each part quoted where DuckDB quotes it (`memory.main."x; drop.t"`), as its last
 *  two parts: a `.` inside a quoted part is the name's */
export function duckTableName(text: string): TableName | null {
  const parts: string[] = [];
  let at = 0;
  while (at <= text.length) {
    if (text[at] === '"') {
      let out = "", end = at + 1;
      for (; end < text.length; end++) {
        if (text[end] === '"') { if (text[end + 1] === '"') { out += '"'; end++; continue; } break; }
        out += text[end];
      }
      parts.push(out);
      at = end + 2;   // past the closing quote and the dot
    } else {
      const dot = text.indexOf(".", at);
      parts.push(text.slice(at, dot < 0 ? undefined : dot));
      at = dot < 0 ? text.length + 1 : dot + 1;
    }
  }
  return parts.length >= 2 ? { schema: parts[parts.length - 2]!, name: parts[parts.length - 1]! } : null;
}

/** the copy a scan reads (DuckDB's `<file>.<schema>.<table>`) */
export const scannedTable = (n: PlanNode): TableName | null => {
  const t = n.extra.Table;
  return typeof t === "string" ? duckTableName(t) : null;
};

export function scannedTables(nodes: readonly PlanNode[]): TableName[] {
  const out: TableName[] = [];
  const walk = (n: PlanNode): void => {
    const t = scannedTable(n);
    if (t !== null && !out.some((o) => o.schema === t.schema && o.name === t.name)) out.push(t);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

// --------------------------------------------------------------------------------------------- the answer

/** what the sync says of a copy (src/duck/sync.ts `Sync.state`, what `mason status` reads): the facts EXPLAIN says of it */
export type CopyFacts = Pick<CopyState, "source" | "phase" | "error" | "rowsSoFar" | "kept">;

/** `rows`: DuckDB's estimate of the copy's rows (duckdb_tables().estimated_size), said as one; `facts`: the sync's
 *  (null: the sync has no record of the table) */
export interface Copy { table: string; rows: number | null; facts: CopyFacts | null;
  /** the rows of it the session's role reads, in words (`filtered by the role tenant: tenant_id = 42`, src/duck/row-filter.ts) */
  filter?: string }

/** the sync's states as EXPLAIN takes them across to the executor's thread (src/api/postgres/server.ts `duckExplain`):
 *  its facts alone, read at the EXPLAIN */
export const copyFacts = (states: readonly CopyState[]): CopyFacts[] =>
  states.map((s) => ({ source: s.source, phase: s.phase, error: s.error, ...(s.rowsSoFar !== undefined ? { rowsSoFar: s.rowsSoFar } : {}), ...(s.kept !== undefined ? { kept: s.kept } : {}) }));

/** an ISO instant as EXPLAIN says one: `2026-10-27 19:58:39 UTC` */
const utc = (iso: string): string => `${iso.slice(0, 19).replace("T", " ")} UTC`;
const UNKNOWN = "how it is kept current is unknown: the sync has no record of it";

/**
 * HOW A COPY IS KEPT CURRENT, in EXPLAIN's words, from the sync's one derivation (src/duck/sync.ts `KeptCurrent`, which
 * `mason status` renders too): a copy not yet copied or whose copy failed says so first; then its sync and its age —
 * `off: last synced 3 days ago (…)` with the command that syncs it, `polled every 30s, last 4 s ago (…)` — or served as
 * copied and skipped by the passes (to be copied again, caught up first), copied again whole, or, in replication mode,
 * its part in the stream, how far the stream has applied and why it is not running. A copy's age is never left out:
 * a BI tool or an agent reading a stale count cannot tell it is one. "kept current" is said only of a copy that is
 * (`keptCurrentBy`).
 */
export function keptText(f: CopyFacts | null, now: number = Date.now()): string {
  if (f === null) return UNKNOWN;
  if (f.phase === "waiting") return "waiting for its first sync to start";
  if (f.phase === "copying") return `being read whole (${count(f.rowsSoFar ?? 0)} rows so far): kept current once synced`;
  if (f.phase === "failed") return `its first sync failed: ${(f.error ?? "mason logs says why").split("\n")[0]}`;
  const k = f.kept;
  if (k === undefined) return UNKNOWN;
  if (k.by === "poll") {
    const synced = k.syncedAt === null ? "never synced" : `last synced ${agoText(k.syncedAt, now)} (${utc(k.syncedAt)})`;
    if (k.pending !== undefined) return `NOT kept current (${synced}): ${k.pending}`;
    if (k.sync.mode === "off") return `off: ${synced}; mason sync ${f.source} syncs it now`;
    return `polled every ${k.sync.every}, ${k.syncedAt === null ? "not polled yet" : `last ${agoText(k.syncedAt, now)} (${utc(k.syncedAt)})`}`;
  }
  if (k.by === "recopy") return `kept current by reading it again whole, ${k.copiedAt === null ? "no sync recorded yet" : `last synced ${utc(k.copiedAt)}`}`;
  const stream = `logical replication (slot ${k.slot})`;
  // the copy's age as status says it (replicated, at <lsn>, <age>), then the newest change it applied
  const synced = k.syncedAt === null ? "not synced yet" : `last synced ${agoText(k.syncedAt, now)} (${utc(k.syncedAt)})`;
  const where = `replicated, at ${k.position}, ${synced}, ${k.lastCommit === null ? "no change applied this run" : `last change committed ${utc(k.lastCommit)}`}`;
  if (k.state === "streamed") return k.notRunning === null ? `kept current by ${stream}, ${where}`
    : `streamed by ${stream}, ${where}; NOT kept current now, the stream is not running: ${k.notRunning}`;
  return k.state === "left-out" ? `NOT kept current: left out of ${stream}: ${k.why ?? ""}`
    : `${stream}, not streamed yet: ${k.why ?? ""}`;
}

/** what keeps a copy current NOW, as FORMAT JSON's `Kept Current By` says it: null for a copy nothing does (not copied
 *  yet, skipped by the passes, its sync off, not streamed, the stream down), so a reader keying on it is
 *  never told of a mode that is not at work on it */
export function keptCurrentBy(f: CopyFacts | null): "polling" | "copying again" | "logical replication" | null {
  const k: KeptCurrent | undefined = f?.phase === "copied" ? f.kept : undefined;
  if (k === undefined) return null;
  if (k.by === "poll") return k.pending === undefined && k.sync.mode === "poll" ? "polling" : null;
  if (k.by === "recopy") return "copying again";
  return k.state === "streamed" && k.notRunning === null ? "logical replication" : null;
}

/** how a copy is kept current, as FORMAT JSON's keys say it (`keptText`'s facts) */
function keptJson(f: CopyFacts | null): Record<string, unknown> {
  const k: KeptCurrent | undefined = f?.phase === "copied" ? f.kept : undefined;
  return {
    "Kept Current By": keptCurrentBy(f), "Kept Current": keptText(f),
    ...(k?.by === "poll" ? { Sync: syncText(k.sync), "Last Synced": k.syncedAt, "Next Poll": k.nextAt } : {}),
    ...(k?.by === "replication" ? { Sync: "replication", Slot: k.slot, "Stream State": k.state, "Applied Through": k.position, "Last Synced": k.syncedAt, "Last Change Committed": k.lastCommit, "Stream Not Running": k.notRunning } : {}),
  };
}

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
    /** the plan is DuckDB's profile of the statement; false: it wrote none (`UNPROFILED`), the plan is its EXPLAIN */
    profiled: boolean;
    planning: { analysisMs: number; rewriteMs: number; duckdbMs: number };
    execution: { duckdbMs: number; masonMs: number };
  };
}

const ms = (x: number): string => x.toFixed(3);
const count = (n: number): string => n.toLocaleString("en-US");
const detail = (v: string | string[]): string => Array.isArray(v) ? v.join(", ") : v;
/** the details a plan line carries without VERBOSE: everything but the projections and filters, which VERBOSE adds */
const VERBOSE_ONLY = new Set(["Projections", "Filters", "Table", "Type"]);

/** a filtered table says no row count: the estimate is every row's, which the role does not read */
function copyLine(c: Copy): string {
  const rows = c.filter !== undefined ? "" : c.rows === null ? "rows unknown; " : `about ${count(c.rows)} rows; `;
  return `${c.table} (${rows}${keptText(c.facts)}${c.filter !== undefined ? `; ${c.filter}` : ""})`;
}

/** EXPLAIN as Postgres's text format: one line a row */
export function explainText(e: Explained, o: ExplainOptions): string[] {
  const lines: string[] = [];
  lines.push(e.copies.length === 0 ? "Mason: answered reading no synced table"
    : e.copies.length === 1 ? `Mason: answered from the synced table ${copyLine(e.copies[0]!)}` : "Mason: answered from the synced tables");
  if (e.copies.length > 1) for (const c of e.copies) lines.push(`  ${copyLine(c)}`);
  lines.push(`  Sent to the engine: ${e.sql}`);
  lines.push(`  Computed by Mason after the engine: ${e.computed.length === 0 ? "nothing" : e.computed.join("; ")}`);
  if (e.functions.length > 0) lines.push(`  Mason's functions the engine calls: ${e.functions.join(", ")}`);
  for (const name of o.ignored) lines.push(`  Note: ${name} has no meaning to the engine: ignored`);
  if (e.analyzed?.profiled === false) lines.push(`  Note: ${UNPROFILED}`);
  else if (e.analyzed !== undefined && o.timing) lines.push("  Note: an operator's thread time is the engine's, summed over the threads that ran it and the operators under it: a parallel one's exceeds the Execution Time");
  const walk = (n: PlanNode, depth: number): void => {
    const lead = depth === 0 ? "" : `${" ".repeat(6 * depth - 4)}->  `;
    const on = scannedTable(n);
    const est = o.costs && n.estimate !== null ? `  (rows=${n.estimate})` : "";
    const actual = n.actualRows === undefined ? "" : ` (actual rows=${n.actualRows}${o.timing && n.threadMs !== undefined ? `, thread time=${ms(n.threadMs)} ms` : ""})`;
    lines.push(`${lead}${operatorName(n.type)}${on === null ? "" : ` on ${qualifiedName(on)}`}${est}${actual}`);
    const pad = " ".repeat(depth === 0 ? 2 : 6 * depth + 2);
    for (const [k, v] of Object.entries(n.extra)) if (o.verbose ? k !== "Table" : !VERBOSE_ONLY.has(k)) lines.push(`${pad}${k}: ${detail(v)}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  e.plan.forEach((n) => walk(n, 0));
  if (e.analyzed !== undefined && o.summary) {
    const p = e.analyzed.planning, x = e.analyzed.execution;
    lines.push(`Planning Time: ${ms(p.analysisMs + p.rewriteMs + p.duckdbMs)} ms (Postgres's analysis ${ms(p.analysisMs)}, Mason's rewrite ${ms(p.rewriteMs)}, the engine's planning ${ms(p.duckdbMs)})`);
    lines.push(`Execution Time: ${ms(x.duckdbMs + x.masonMs)} ms (the engine ${ms(x.duckdbMs)}, Mason's conversion and exact numerics ${ms(x.masonMs)})`);
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
      ...(on === null ? {} : { "Relation Name": on.name, Schema: on.schema }),
      ...(o.costs && n.estimate !== null ? { "Plan Rows": n.estimate } : {}),
      ...(n.actualRows === undefined ? {} : { "Actual Rows": n.actualRows, "Actual Loops": 1, ...(o.timing && n.threadMs !== undefined ? { "Engine Thread Time": Number(ms(n.threadMs)) } : {}) }),
      ...Object.fromEntries(Object.entries(n.extra).filter(([k]) => o.verbose ? k !== "Table" : !VERBOSE_ONLY.has(k)).map(([k, v]) => [`Engine ${k}`, v])),
      ...(n.children.length === 0 ? {} : { Plans: n.children.map(node) }),
    };
  };
  // Postgres's plan has one root; DuckDB's has one too (a statement's), kept as a list should it ever have more
  const roots = e.plan.map(node);
  const top: Record<string, unknown> = {
    Plan: roots.length === 1 ? roots[0] : { "Node Type": "Engine Plans", Plans: roots },
    Mason: {
      "Answered By": "the engine",
      Tables: e.copies.map((c) => ({ Table: c.table, ...(c.filter === undefined ? { "Estimated Rows": c.rows } : {}), ...keptJson(c.facts), ...(c.filter !== undefined ? { "Row Filter": c.filter } : {}) })),
      "Sent To Engine": e.sql,
      "Computed After Engine": e.computed,
      "Mason Functions Engine Calls": e.functions,
      ...(o.ignored.length === 0 ? {} : { Ignored: o.ignored.map((n) => `${n} has no meaning to the engine`) }),
      ...(e.analyzed?.profiled === false ? { Note: UNPROFILED } : {}),
    },
  };
  if (e.analyzed !== undefined && o.summary) {
    const p = e.analyzed.planning, x = e.analyzed.execution;
    top["Planning Time"] = Number(ms(p.analysisMs + p.rewriteMs + p.duckdbMs));
    top["Execution Time"] = Number(ms(x.duckdbMs + x.masonMs));
    (top.Mason as Body)["Planning"] = { "Postgres Analysis": Number(ms(p.analysisMs)), "Mason Rewrite": Number(ms(p.rewriteMs)), "Engine Planning": Number(ms(p.duckdbMs)) };
    (top.Mason as Body)["Execution"] = { Engine: Number(ms(x.duckdbMs)), "Mason Conversion": Number(ms(x.masonMs)) };
  }
  return JSON.stringify([top], null, 2);
}
