/**
 * HEAVY STATEMENTS TAKE A TURN (issue 1132; docs/DESIGN.md "Heavy statements take a turn"). Ten clients that each sent a
 * join of 100 M orders to 5 M customers at once took 659 s, where one took 17.9 s and four at a time 40.7 s: each join
 * holds a hash table of its build side, ten of them did not fit the engine's memory, and the engine spilled 48.7 GB to
 * disk and read most of it back. So a statement whose plan keeps many rows in memory (a join's build side, a group by's
 * groups, a sort's or a window's rows) waits for one of a few turns, and every other statement runs at once.
 *
 * - WHAT IS HEAVY is the engine's own plan (`keptRows`): its EXPLAIN's row estimates, read before the statement runs
 *   (src/duck/store.ts `SessionRunner.weigh`). A scan and filter keeps nothing, however many rows it reads (a lookup by
 *   key over 100 M rows), and a group by into a few groups keeps a few. A statement is heavy when what it keeps would
 *   take more than its share of the memory if `LIGHT_AT_ONCE` statements ran at once (`heavyRowsFor`).
 * - HOW MANY TURNS comes from the memory and the engine's threads (`heavyTurns`): one for each `HEAVY_STATEMENT_BYTES`
 *   of the memory limit, at most one a thread (a heavy statement already uses every thread), at least one.
 *   `MASON_HEAVY_QUERIES` sets it instead (`heavyQueriesOf`).
 * - THE WAIT is on the listener's thread, under the statement's own signal (`Admission.admit`): its cancel and its
 *   statement_timeout end it with 57014, as they end a running statement. Turns are given first come, first served.
 * - THE TURN IS HELD UNTIL THE FIRST ROWS (`heldUntilFirstRows`): the statement's first chunk read, its end, its failure,
 *   or its close, whichever comes first. What a heavy statement keeps is built before its first row: a join's build
 *   side, a group by's groups, a sort's or a window's rows each end a pipeline the rows come out of only once it is
 *   done. What is left is a scan and a probe at the pace the client reads. A client may stop reading for as long as it
 *   likes (a portal suspended by an Execute's row limit, idle past its COMMIT or before a Sync), and its turn must not
 *   wait for it: another session's heavy statement would wait without end (PR 1136's review).
 */
import type { DuckAnswer } from "../api/postgres/server.ts";
import type { PlanNode } from "./explain.ts";
import type { StatementError } from "./statement.ts";

/**
 * THE MEMORY ONE KEPT ROW TAKES, about, in bytes. Measured with DuckDB 2.0 at 4 threads, the peak of `duckdb_memory()`
 * beside one statement (docs/DESIGN.md "Heavy statements take a turn"): a join's build side of 2 M rows of a UUID and a
 * timestamp 110 MB (55 B a row), a sort of 20 M rows of a UUID and a decimal 1,016 MB (53 B a row), and a group by of
 * 2 M groups over 20 M rows 805 MB (400 B a group, a partial table on each of 4 threads). It is the low end on purpose:
 * a group's real cost is higher, and the statement is heavy all the same.
 */
export const KEPT_ROW_BYTES = 64;

/**
 * THE MEMORY ONE HEAVY STATEMENT IS GIVEN, in bytes: the engine's memory limit over this is how many run at once.
 * Measured on 4 CPUs with the engine at 4 GiB, ten joins of 100 M rows to 5 M (a 170 MiB hash table each): four at once
 * took 40.7 s with nothing spilled, about six 41.2 s with 0.5 GB spilled, about eight 519 s with 38 GB spilled, ten
 * 659 s with 48.7 GB. At 1 GiB a turn, 4 GiB gives the four that were fastest.
 */
export const HEAVY_STATEMENT_BYTES = 2 ** 30;

/**
 * HOW MANY STATEMENTS A LIGHT ONE'S SHARE ASSUMES RUN AT ONCE: the size of libuv's pool a run gets by default
 * (src/cli/pool-size.cjs POOL_THREADS, docs/DESIGN.md "The pool"). Not read from UV_THREADPOOL_SIZE: statements are not
 * held to the pool (at a pool of 1, ten joins still ran together and spilled), and a small pool must not make every
 * join light.
 */
export const LIGHT_AT_ONCE = 32;
/** the setting that sets the turns, and its bounds */
export const HEAVY_QUERIES_VARIABLE = "MASON_HEAVY_QUERIES";
export const HEAVY_QUERIES_MAX = 1024;

/** a join's operators: each holds its build side (its last child: DuckDB builds on the right) while it runs */
const JOINS = /(?:^|_)JOIN$|^CROSS_PRODUCT$/;
/** the operators that hold a row for each group */
const AGGREGATES = new Set(["HASH_GROUP_BY", "PERFECT_HASH_GROUP_BY", "PARTITIONED_AGGREGATE", "UNGROUPED_AGGREGATE"]);
/** the operators that hold every row they are given */
const WHOLE = new Set(["ORDER_BY", "WINDOW"]);
/** aggregates that hold every value they are given, whatever the groups: a median, a list, a string of them all — by
 *  the engine's names and Postgres's, read in a plan's Aggregates (`keptRows`) and in a statement's tree (`mayKeepRows`) */
const HOLDS_EVERY_VALUE_NAMES = "median|mode|quantile\\w*|percentile_\\w+|mad|list|array_agg|string_agg|listagg|group_concat|histogram|json_agg|jsonb_agg|json_object_agg|jsonb_object_agg|json_group_array|json_group_object|xmlagg";
const HOLDS_EVERY_VALUE = new RegExp(`\\b(?:${HOLDS_EVERY_VALUE_NAMES})\\(`, "i");
const HOLDS_EVERY_VALUE_NAME = new RegExp(`^(?:${HOLDS_EVERY_VALUE_NAMES})$`, "i");
/** the operators that pass on at most the rows they are given (one child): what they give is never more than that */
const NEVER_MORE = new Set(["PROJECTION", "FILTER", "ORDER_BY", "TOP_N", "LIMIT", "STREAMING_LIMIT", "LIMIT_PERCENT", "WINDOW", "STREAMING_WINDOW", ...AGGREGATES]);

/** the rows a node gives, by DuckDB's estimate, held to what its input bounds */
function rowsOut(n: PlanNode): number {
  const own = n.estimate;
  const child = n.children[0];
  // an operator with no estimate (a cross product) gives what its children do, multiplied
  if (own === null) return n.children.reduce((p, c) => p * rowsOut(c), 1);
  if (NEVER_MORE.has(n.type) && child !== undefined && n.children.length === 1) return Math.min(own, rowsOut(child));
  // DuckDB's late materialization: a table joined back to its own top rows on the row id gives at most those rows (a
  // top N over every column, `ORDER BY x LIMIT 10`, is a semi join of the table to a TOP_N of 10, estimated at every row)
  const conditions = n.extra.Conditions;
  const build = n.children[n.children.length - 1];
  if (JOINS.test(n.type) && build !== undefined && (Array.isArray(conditions) ? conditions : [conditions]).includes("rowid = rowid")) return Math.min(own, rowsOut(build));
  return own;
}

/** what an aggregate's Aggregates say, as one text */
const aggregatesOf = (n: PlanNode): string => { const a = n.extra.Aggregates; return Array.isArray(a) ? a.join(", ") : a ?? ""; };

/**
 * THE ROWS A PLAN KEEPS IN MEMORY AT ONCE, by DuckDB's estimates (its `EXPLAIN (FORMAT JSON)`, explain.ts `planNodes`):
 * each join's build side, each group by's groups (every input row where an aggregate holds every value), each sort's
 * and window's rows, and each materialized CTE's rows, summed — they can be held together. A scan, a filter, a top N
 * and an aggregate of no group keep none.
 */
export function keptRows(plan: readonly PlanNode[]): number {
  let kept = 0;
  const walk = (n: PlanNode): void => {
    const input = n.children[0] === undefined ? 0 : rowsOut(n.children[0]);
    if (JOINS.test(n.type)) { const build = n.children[n.children.length - 1]; if (build !== undefined && n.children.length > 1) kept += rowsOut(build); }
    else if (AGGREGATES.has(n.type)) kept += HOLDS_EVERY_VALUE.test(aggregatesOf(n)) ? input : n.type === "UNGROUPED_AGGREGATE" ? 0 : rowsOut(n);
    else if (WHOLE.has(n.type)) kept += input;
    // a materialized CTE holds what its first child gives, for the statement that reads it
    else if (n.type === "CTE") kept += input;
    for (const c of n.children) walk(c);
  };
  for (const n of plan) walk(n);
  return kept;
}

/**
 * WHETHER A STATEMENT CAN KEEP ROWS AT ALL, from its tree (the planned DuckDB SQL's, in Postgres's grammar: src/duck/plan.ts
 * PlannedSql `keepsNone`): a join, a FROM of several items, a subquery expression, a WITH, a set operation, a GROUP BY,
 * a DISTINCT, an ORDER BY, a window, or an aggregate that is DISTINCT, ordered or holds every value. One with none of
 * them (a lookup, a filter, a count) only scans and filters: it is light whatever it reads, and never weighed, which
 * saves the engine's EXPLAIN (about 0.5 ms a statement). Every other statement is weighed by its plan (`keptRows`).
 */
export function mayKeepRows(tree: unknown): boolean {
  const walk = (n: unknown): boolean => {
    if (Array.isArray(n)) return n.some(walk);
    if (n === null || typeof n !== "object") return false;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === "JoinExpr" || k === "SubLink" || k === "WithClause" || k === "withClause" || k === "WindowDef") return true;
      if (k === "SelectStmt" || k === "larg" || k === "rarg") {
        const s = v as Record<string, unknown>;
        if ((s.op !== undefined && s.op !== "SETOP_NONE") || ((s.fromClause as unknown[] | undefined)?.length ?? 0) > 1) return true;
        for (const f of ["groupClause", "distinctClause", "sortClause", "windowClause"]) if (s[f] !== undefined) return true;
      }
      if (k === "FuncCall") {
        const f = v as Record<string, unknown>;
        if (f.agg_distinct === true || f.agg_order !== undefined || f.agg_within_group === true || f.over !== undefined) return true;
        const names = (f.funcname as Array<{ String?: { sval?: string } }> | undefined) ?? [];
        if (HOLDS_EVERY_VALUE_NAME.test(names[names.length - 1]?.String?.sval ?? "")) return true;
      }
      if (walk(v)) return true;
    }
    return false;
  };
  return walk(tree);
}

/**
 * THE ROWS KEPT AT WHICH A STATEMENT IS HEAVY: what would take more than its share of the engine's memory if
 * `LIGHT_AT_ONCE` statements kept as much at once. Below it, that many fit together, so a light statement never needs
 * a turn. At 4 GiB, about 2.1 M rows.
 */
export function heavyRowsFor(memoryLimitBytes: number): number {
  return Math.max(1, Math.ceil(memoryLimitBytes / LIGHT_AT_ONCE / KEPT_ROW_BYTES));
}

/**
 * HOW MANY HEAVY STATEMENTS RUN AT ONCE: `set` (MASON_HEAVY_QUERIES) when given, else one for each
 * HEAVY_STATEMENT_BYTES of the engine's memory limit, at most one for each of its threads, at least one.
 */
export function heavyTurns(memoryLimitBytes: number, threads: number, set: number | null): number {
  if (set !== null) return set;
  // a thread count that cannot be read is one: fewer turns, never none
  const t = Number.isFinite(threads) && threads >= 1 ? Math.floor(threads) : 1;
  return Math.max(1, Math.min(t, Math.floor(memoryLimitBytes / HEAVY_STATEMENT_BYTES)));
}

/** MASON_HEAVY_QUERIES as a number of turns; null when unset (derived). Throws, with the way out, on any other value. */
export function heavyQueriesOf(env: Readonly<Record<string, string | undefined>>): number | null {
  const v = env[HEAVY_QUERIES_VARIABLE];
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.trim());
  if (!/^\d+$/.test(v.trim()) || n < 1 || n > HEAVY_QUERIES_MAX) {
    throw new Error(`${HEAVY_QUERIES_VARIABLE}=${JSON.stringify(v)} is not a whole number from 1 to ${HEAVY_QUERIES_MAX}: it is how many heavy queries ` +
      `(a join, a group by or a sort that keeps many rows in memory) run at once, the rest waiting their turn; unset it for one for each GiB of MASON_DUCKDB_MEMORY, at most one for each CPU`);
  }
  return n;
}

/** what a statement's turn is: whether it is heavy, how long it waited for its turn, and the release that hands the
 *  turn on (a no-op for a light one, which takes none) */
export interface Turn { heavy: boolean; waitedMs: number; release(): void }
/** a light statement's: no turn, no wait */
export const LIGHT: Turn = { heavy: false, waitedMs: 0, release: () => undefined };
/** a statement's turn, or why it has none: its cancel or its timeout while it was weighed or waited (57014), or the
 *  engine gone — with how long it had waited */
export type Admitted = Turn | { waitedMs?: number; failure: StatementError };

/**
 * THE TURNS OF ONE ENGINE (a DuckDB instance: its memory limit is what they share). First come, first served: a
 * released turn goes to the longest waiter still waiting.
 */
export class Admission {
  readonly turns: number;
  /** the rows kept at which a statement is heavy (`heavyRowsFor`) */
  readonly heavyRows: number;
  private taken = 0;
  private readonly waiters: Array<() => void> = [];
  /** `turns` at least 1 (Infinity: none waits); `heavyRows` Infinity: nothing is heavy, and nothing is weighed */
  constructor(turns: number, heavyRows: number) {
    if (!(turns >= 1) || !(heavyRows >= 1)) throw new Error(`heavy statements' turns of ${turns}, at ${heavyRows} rows: each must be 1 or more (Mason bug: report it)`);
    this.turns = Math.floor(turns); this.heavyRows = heavyRows;
  }

  /** heavy statements running now, and waiting */
  get running(): number { return this.taken; }
  get waiting(): number { return this.waiters.length; }

  /**
   * A turn: at once when one is free, else once the statements before it have taken theirs and one is released. Null
   * when `signal` aborted first (a cancel, the statement timeout): it waits no longer and takes none. A turn granted is
   * released once (`release` again does nothing).
   */
  admit(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.taken < this.turns && this.waiters.length === 0) { this.taken++; return Promise.resolve(this.releaser()); }
    return new Promise((resolve) => {
      const go = (): void => { signal.removeEventListener("abort", gone); this.taken++; resolve(this.releaser()); };
      const gone = (): void => {
        const at = this.waiters.indexOf(go);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(null);
      };
      this.waiters.push(go);
      signal.addEventListener("abort", gone, { once: true });
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.taken--;
      const next = this.waiters.shift();
      if (next !== undefined) next();
    };
  }
}

/** An answer whose turn is released once its first fetch returns (rows, its end, or its failure), or it is closed:
 *  never held while the answer waits on its client. */
export function heldUntilFirstRows(a: DuckAnswer, release: () => void): DuckAnswer {
  return {
    columns: a.columns,
    fetch: async (formats, session) => {
      try { return await a.fetch(formats, session); }
      finally { release(); }
    },
    close: () => { try { a.close(); } finally { release(); } },
  };
}
