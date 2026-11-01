/**
 * What a planned statement is, and how it fails, as the engine and the listener both read them: neither side's own, so
 * the engine (src/duck/) imports them from here and never from the listener (src/api/postgres/server.ts).
 */
import type { ErrorFields } from "../api/postgres/protocol.ts";
import { gapMark, type GapId } from "./gaps.ts";
import type { TreeNode } from "./pgtree.ts";
import type { ResolvedRead } from "./grants.ts";
import type { PlannedSql } from "./plan.ts";
import type { ExactColumn } from "./rewrite.ts";

/** A statement's error as Postgres raises it, from outside the listener (the DuckDB runner's): the fields, and the SQL
 *  its position is in. */
export class StatementError extends Error {
  readonly fields: Omit<ErrorFields, "severity">;
  readonly sql: string;
  /** the registry entry (src/duck/gaps.ts) that refused the statement, as the refusal was built with it (`gapRefusal`,
   *  src/duck/store.ts pgErrorOf): what the request log records as `gap`; null for every other error */
  readonly gap: GapId | null;
  constructor(fields: Omit<ErrorFields, "severity">, sql = "", gap: GapId | null = null) { super(fields.message); this.fields = fields; this.sql = sql; this.gap = gap; }
}

/**
 * A REFUSAL BY A REGISTRY ENTRY (src/duck/gaps.ts), the one way one is built: 0A000, `Mason gap <id>` in its DETAIL (what
 * the oracle and a reader read), followed by `detail` (docs/SQL-SUPPORT.md, or what it names), and the id itself on the
 * error, so the request log records which entry refused it without reading the text back.
 */
export function gapRefusal(gap: GapId, message: string, hint: string, sql = "", detail = " (docs/SQL-SUPPORT.md)"): StatementError {
  return new StatementError({ code: "0A000", message, hint, detail: `${gapMark(gap)}${detail}` }, sql, gap);
}

/** A statement's DuckDB plan (src/duck/plan.ts): Postgres's analysis of it, and the DuckDB SQL that answers it alike. */
export interface DuckPlan {
  sql: PlannedSql;
  /** the parameters' types, Postgres's */
  params: number[];
  /** the result's columns, Postgres's RowDescription (size from pg_type) */
  fields: Array<{ name: string; oid: number; typmod: number; size: number }> | null;
  /** DuckDB answers one column after Postgres's (a WITH TIES rank), not sent */
  dropLast: boolean;
  /** the numeric columns computed as Postgres computes them, from cells DuckDB answers after Postgres's columns */
  exact?: ExactColumn[];
  /** what Postgres resolved the statement to (src/duck/resolved.ts): each one verified, or the statement was refused */
  resolved: readonly string[];
  /** each function it calls with each argument's type (src/duck/resolved.ts `argumentTypes`) */
  argumentTypes?: readonly string[];
  /** each output column's ANALYSED expression, every node with the type Postgres gave it (src/duck/pgtree.ts
   *  `outputExpressions`): what a generated table's refusal reads a value's type from (src/duck/generated-plan.ts) */
  outputs?: ReadonlyArray<TreeNode | null>;
  /** the copied tables' JSON paths it reads by literal steps (src/duck/kept-route.ts readKey): the request log's
   *  `json_reads`, which decide the paths Mason stores (src/duck/kept.ts) */
  jsonReads?: readonly string[];
  /** the positions of the parameters DuckDB reads the transaction's start from, after the statement's own: `parse` the
   *  start as of the Parse (a relative literal, `'now'`, which Postgres reads then), `exec` as of the execution
   *  (now(), CURRENT_DATE …); each an instant the session sends */
  clock?: { parse?: number; exec?: number };
  /** how long Postgres's analysis took (its catalog reads with it) and Mason's rewrite (with its read-back), ms: an
   *  EXPLAIN ANALYZE's Planning Time */
  timing?: { analysisMs: number; rewriteMs: number };
  /** the copied tables and columns Postgres's analysis says it reads (src/duck/grants.ts), where roles exist: what an
   *  Execute is held to under the session's role of that moment */
  reads?: readonly ResolvedRead[];
  /** the tables whose rows the session's role filters that the statement reads (its filtered tables and the parents they
   *  are read through), each with the filter in words: EXPLAIN's per-table line (src/duck/row-filter.ts) */
  rowFilters?: ReadonlyArray<{ table: string; words: string }>;
  /** the row filters it was made under, bound (`rowsKeyOf`): an Execute under others plans it again (executeDuck) */
  rowsKey?: string;
}
