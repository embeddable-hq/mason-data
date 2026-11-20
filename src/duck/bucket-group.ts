/**
 * A GROUP BY OF A TIME'S UNIT, GROUPED BY ITS 15-MINUTE BUCKET FIRST (issue 1146; docs/DESIGN.md "A time's 15-minute
 * bucket"). `date_trunc('month', created_at)` in the session's zone costs ICU's calendar a row (96.3 s against 39.8 s
 * in UTC for "Revenue by month" at 100 M orders and 10 clients), where the copy holds each value's 15 minutes of UTC
 * (src/duck/bucket-column.ts), and every local hour, day, week, month, quarter and year since 1980 begins on one. So a
 * grouped SELECT the rewrite wrote over such a truncation (src/duck/rewrite.ts marks each, `BucketMark`) is written as
 * two:
 *
 *   SELECT <its list, HAVING, ORDER BY, each aggregate read from its parts, each truncation from its bucket's start>
 *   FROM (SELECT <the bucket>, NULL, <every other key>, <each aggregate's parts>
 *           FROM <its FROM> WHERE <its WHERE> AND <the bucket> IS DISTINCT FROM BUCKET_NONE GROUP BY <all but the parts>
 *         UNION ALL
 *         SELECT NULL, <the row's truncation>, <every other key>, <each aggregate's parts>
 *           FROM <its FROM> WHERE <its WHERE> AND <the bucket> = BUCKET_NONE GROUP BY <all but the parts>) AS <own>bucketed
 *   GROUP BY <its GROUP BY>
 *
 * THE FIRST BRANCH READS THE BUCKET, NEVER THE TIME. The second reads the time of the rows no bucket decides (before
 * 1980, infinite: src/duck/bucket-column.ts `BUCKET_NONE`). On a table that holds none, the engine's statistics of the
 * bucket say the second branch's filter is false, and it plans that branch as empty: a cold query reads the bucket and
 * not the time. The statistics are read as the statement is planned, in its own transaction (a prepared statement is
 * planned again as it runs), so a row added since never meets a plan that left it out. A table that holds one reads
 * the time only in the row groups whose bucket's minimum is BUCKET_NONE. In a zone whose bucket does not decide its
 * units (`offBoundary`, folded to a constant as the statement is bound), the first branch truncates each row instead.
 * The FROM and WHERE are read twice, so the statement is left as it is where they could answer twice differently: a
 * volatile call, a LIMIT inside them, a sample, a LATERAL or a function in the FROM.
 *
 * The inner groups are a finer split of the statement's own: each of its keys is computed from the inner columns (a
 * truncation's from its bucket, which decides it, or from the row's own truncation where the row has no bucket: before
 * 1980, infinite or NULL), so every group of the statement is a union of inner groups, and an aggregate that adds up from
 * parts answers the same: sum (the sum of sums), count (their sum), min, max, first and any_value (of theirs), avg (the
 * sum of sums over the sum of counts), each of a value Postgres types exactly (a sum or an average of a float keeps its
 * plan: added in another order, its last digit may move). Anything else keeps the statement as it was, which is exact: another aggregate
 * (count(DISTINCT), a median, string_agg, arg_min …: `ENGINE_AGGREGATES` names every one the engine has), an ordered
 * aggregate, a window, a subquery, a `*`, a lambda or a JSON arrow outside an aggregate, grouping sets, DISTINCT, and a
 * SELECT a subquery or a LATERAL item may correlate. Nothing is refused.
 *
 * One column's bucket a SELECT, the first key's: grouped by two, the inner groups are pairs, nearly one a row. Every
 * other key is one inner key, computed a row as the statement computes it. The rewrite marks nothing it plans in UTC
 * over a table of fewer than 10 M rows (src/duck/rewrite.ts `UTC_BUCKET_ROWS`, issue 1174), where the instant's
 * arithmetic costs less than a second GROUP BY.
 *
 * On the finished tree, after the walk (src/duck/rewrite.ts `rewrite`), so no rule of the rewrite meets the inner query.
 * A truncation is recognised by its form without offsets (`shape`): the rewrite writes the list's and the GROUP BY's
 * alike, each from its own node.
 */
import { BUCKET_NONE, OFF_BOUNDARY_ZONES } from "./bucket-column.ts";

type Body = Record<string, unknown>;
type AstNode = Record<string, unknown>;

/** a truncation the rewrite wrote of a column whose copy holds its bucket: the hidden column (a reference qualified as
 *  the column's FROM item) and the same truncation of `<placeholder>`, the bucket's start */
export interface BucketMark { bucket: AstNode; outer: AstNode }

/** every aggregate function the engine has (`duckdb_functions()`, function_type 'aggregate'), and every macro over one
 *  (held to the engine by tests/duck-bucket-zones.test.ts): a call of one is never read as a row's value */
export const ENGINE_AGGREGATES: ReadonlySet<string> = new Set(["any_value", "approx_count_distinct", "approx_quantile", "approx_top_k", "arbitrary",
  "arg_max", "arg_max_null", "arg_max_nulls_last", "arg_min", "arg_min_null", "arg_min_nulls_last", "argmax", "argmin", "array_agg", "avg",
  "bit_and", "bit_or", "bit_xor", "bitstring_agg", "bool_and", "bool_or", "combine_aggr", "corr", "count", "count_if", "count_star", "countif",
  "covar_pop", "covar_samp", "decimal_average", "entropy", "favg", "first", "fsum", "group_concat", "histogram", "histogram_exact",
  "kahan_sum", "kurtosis", "kurtosis_pop", "last", "list", "listagg", "lttb", "mad", "max", "max_by", "mean", "median", "min", "min_by",
  "mode", "product", "quantile", "quantile_cont", "quantile_disc", "regr_avgx", "regr_avgy", "regr_count", "regr_intercept", "regr_r2",
  "regr_slope", "regr_sxx", "regr_sxy", "regr_syy", "reservoir_quantile", "sem", "skewness", "stddev", "stddev_pop", "stddev_samp",
  "string_agg", "sum", "sum_no_overflow", "sumkahan", "var_pop", "var_samp", "variance", "variant_group_object",
  // and its macros over one
  "geomean", "json_group_array", "json_group_object", "variant_group_array", "weighted_avg"]);
/** the aggregates that add up from parts, and how: each part the inner query computes, and the outer read of them */
const MERGED: ReadonlySet<string> = new Set(["sum", "count", "count_star", "min", "max", "first", "any_value", "avg"]);
/** the engine's functions whose every call is a new value */
const VOLATILE: ReadonlySet<string> = new Set(["random", "gen_random_uuid", "uuid", "uuidv4", "uuidv7", "setseed", "nextval", "currval"]);

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const isNode = (v: unknown): v is AstNode => isObject(v) && Object.keys(v).length === 1 && /^[A-Z]/.test(Object.keys(v)[0]!);
const kindOf = (n: AstNode): string => Object.keys(n)[0]!;
const bodyOf = (n: AstNode): Body => n[kindOf(n)] as Body;
const S = (sval: string): AstNode => ({ String: { sval } });
const ref = (...names: string[]): AstNode => ({ ColumnRef: { fields: names.map(S) } });
const sval = (n: unknown): string | null => isNode(n) && kindOf(n) === "String" ? String(bodyOf(n).sval ?? "") : null;
const funcName = (b: Body): string => { const n = (b.funcname ?? []) as unknown[]; return (sval(n[n.length - 1]) ?? "").toLowerCase(); };
const call = (name: string, args: AstNode[], extra: Body = {}): AstNode => ({ FuncCall: { funcname: [S(name)], args, funcformat: "COERCE_EXPLICIT_CALL", ...extra } });
const cast = (arg: AstNode, type: string): AstNode => ({ TypeCast: { arg, typeName: { names: [S(type)], typemod: -1 } } });
const intConst = (n: number): AstNode => ({ A_Const: { ival: n === 0 ? {} : { ival: n } } });
const constInt = (n: unknown): number | null => isNode(n) && kindOf(n) === "A_Const" && bodyOf(n).ival !== undefined ? Number((bodyOf(n).ival as Body).ival ?? 0) : null;
const res = (val: AstNode, name: string): AstNode => ({ ResTarget: { name, val } });

/** a tree's form without its offsets: two nodes the rewrite wrote alike from two places of the statement are one */
export function shape(v: unknown): string {
  return JSON.stringify(v, (k, x: unknown) => k === "location" ? undefined : x);
}

class Bail extends Error {}

/** `Bail` where an expression computed a row in the inner query could not be: a subquery, a window, a `*`, a grouping
 *  function, a JSON arrow or a lambda, a volatile call */
function checked(v: unknown): void {
  if (Array.isArray(v)) { v.forEach(checked); return; }
  if (!isObject(v)) return;
  if (isNode(v)) {
    const k = kindOf(v), b = bodyOf(v);
    if (k === "SubLink" || k === "GroupingFunc" || k === "A_Star" || k === "WindowDef") throw new Bail();
    if (k === "A_Expr") { const op = ((b.name ?? []) as unknown[]).map(sval); if (op.includes("->") || op.includes("->>")) throw new Bail(); }
    if (k === "FuncCall" && (b.over !== undefined || VOLATILE.has(funcName(b)) || ENGINE_AGGREGATES.has(funcName(b)))) throw new Bail();
    Object.values(b).forEach(checked);
    return;
  }
  Object.values(v).forEach(checked);
}

/** whether an expression reads a column anywhere in it */
function readsColumn(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(readsColumn);
  if (!isObject(v)) return false;
  if (isNode(v) && kindOf(v) === "ColumnRef") return true;
  return Object.values(isNode(v) ? bodyOf(v) : v).some(readsColumn);
}

/** `Bail` where a FROM read twice could answer twice differently: anything but a table, a join of them or a subquery */
function repeatableFrom(items: unknown): void {
  const item = (n: unknown): void => {
    if (!isNode(n)) throw new Bail();
    const k = kindOf(n), b = bodyOf(n);
    if (k === "RangeVar") return;
    if (k === "JoinExpr") { item(b.larg); item(b.rarg); repeatable(b.quals); return; }
    if (k === "RangeSubselect" && b.lateral !== true) { repeatable(b.subquery); return; }
    throw new Bail();
  };
  if (!Array.isArray(items)) throw new Bail();
  items.forEach(item);
}

/** `Bail` where an expression or query read twice could answer twice differently: a volatile call, a LIMIT or OFFSET
 *  (which rows it keeps is the engine's choice), a sample, a function in a FROM */
function repeatable(v: unknown): void {
  if (Array.isArray(v)) { v.forEach(repeatable); return; }
  if (!isObject(v)) return;
  if (isNode(v)) {
    const k = kindOf(v), b = bodyOf(v);
    if (k === "FuncCall" && VOLATILE.has(funcName(b))) throw new Bail();
    if (k === "SelectStmt" && (b.limitCount !== undefined || b.limitOffset !== undefined)) throw new Bail();
    if (k === "RangeTableSample" || k === "RangeFunction" || k === "RangeTableFunc") throw new Bail();
    Object.values(b).forEach(repeatable);
    return;
  }
  Object.values(v).forEach(repeatable);
}

/** whether the session's zone, where the statement runs (`current_setting`, which the engine folds to a constant), is one
 *  whose bucket does not decide its units (src/duck/bucket-column.ts `OFF_BOUNDARY_ZONES`) */
const offBoundary = (): AstNode => ({ A_Expr: { kind: "AEXPR_IN", name: [S("=")], lexpr: call("lower", [call("current_setting", [{ A_Const: { sval: { sval: "TimeZone" } } }])]),
  rexpr: { List: { items: OFF_BOUNDARY_ZONES.map((z) => ({ A_Const: { sval: { sval: z } } })) } } } });

/** the bucket's start of an inner bucket column (`b`): an instant, the truncation's argument in its place */
const bucketStart = (b: AstNode): AstNode =>
  call("make_timestamptz", [{ A_Expr: { kind: "AEXPR_OP", name: [S("*")], lexpr: cast(b, "bigint"), rexpr: intConst(900_000_000) } }]);

/** `placeholder` in `outer` (a fresh copy) replaced by `by` */
function placed(outer: AstNode, placeholder: string, by: AstNode): AstNode {
  const at = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(at);
    if (!isObject(v)) return v;
    if (isNode(v) && kindOf(v) === "ColumnRef") {
      const f = (bodyOf(v).fields ?? []) as unknown[];
      if (f.length === 1 && sval(f[0]) === placeholder) return structuredClone(by);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, at(x)]));
  };
  return at(outer) as AstNode;
}

/**
 * Every grouped SELECT of `tree` over a marked truncation written as two (the module's header). `marks` by `shape`;
 * `placeholder` the marks' bucket start; `own` the statement's prefix (src/duck/own-names.ts); `approximate`, whether an
 * aggregate's value is a float as Postgres analysed it.
 */
export function bucketGroups(tree: unknown, marks: ReadonlyMap<string, BucketMark>, placeholder: string, own: string, approximate: (n: AstNode) => boolean): unknown {
  if (marks.size === 0) return tree;
  // a WITH query a FROM read twice could read twice: none may answer twice differently
  try { withQueries(tree).forEach(repeatable); } catch (e) { if (e instanceof Bail) return tree; throw e; }
  // a SELECT inside a subquery expression or a LATERAL item may read an outer query's columns, which the inner query
  // could not: left as it is, and so is everything under it
  const visit = (v: unknown, correlated: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => visit(x, correlated));
    if (!isObject(v)) return v;
    if (!isNode(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, correlated)]));
    const k = kindOf(v), b = bodyOf(v);
    const under = correlated || k === "SubLink" || (k === "RangeSubselect" && b.lateral === true) || (k === "RangeFunction" && b.lateral === true);
    const out = { [k]: Object.fromEntries(Object.entries(b).map(([key, x]) => [key, visit(x, under)])) } as AstNode;
    if (k !== "SelectStmt" || correlated) return out;
    try { return { SelectStmt: grouped(bodyOf(out), marks, placeholder, own, approximate) }; } catch (e) { if (e instanceof Bail) return out; throw e; }
  };
  return visit(tree, false);
}

/** every WITH query of `tree`'s, anywhere in it */
function withQueries(tree: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObject(v)) return;
    if (isNode(v) && kindOf(v) === "CommonTableExpr") out.push(bodyOf(v).ctequery);
    Object.values(isNode(v) ? bodyOf(v) : v).forEach(walk);
  };
  walk(tree);
  return out;
}

/** one SELECT written as two, or `Bail` where it keeps its form */
function grouped(s: Body, marks: ReadonlyMap<string, BucketMark>, placeholder: string, own: string, approximate: (n: AstNode) => boolean): Body {
  const groups = s.groupClause;
  if (!Array.isArray(groups) || groups.length === 0) throw new Bail();
  if ((s.op !== undefined && s.op !== "SETOP_NONE") || s.distinctClause !== undefined || s.windowClause !== undefined || s.valuesLists !== undefined
    || s.intoClause !== undefined || s.lockingClause !== undefined || !Array.isArray(s.fromClause) || s.fromClause.length === 0) throw new Bail();
  const targets = (s.targetList ?? []) as AstNode[];
  if (targets.some((t) => kindOf(t) !== "ResTarget" || typeof bodyOf(t).name !== "string")) throw new Bail();
  // a GROUP BY key, an output's number read as that output
  const keyOf = (g: unknown): AstNode => {
    if (!isNode(g) || kindOf(g) === "GroupingSet") throw new Bail();
    const n = constInt(g);
    if (n === null) return g;
    const t = targets[n - 1];
    if (t === undefined) throw new Bail();
    return bodyOf(t).val as AstNode;
  };
  // A CONSTANT KEY KEEPS THE PLAN: a key that reads no column (a literal, a parameter, a cast of one, an expression of
  // them) needs no inner column, and matched by its form it would take the place of every equal literal of the list, the
  // HAVING and the ORDER BY, the engine's type modifiers and EXTRACT's field among them (PR 1149's review)
  if (groups.some((g) => !readsColumn(keyOf(g)))) throw new Bail();
  // one column's bucket a statement: grouped by two, the inner groups are pairs of buckets, nearly a group a row (5 M
  // rows, a month and a week of two columns: 126 ms against 140). The first key's marked column is it, and a mark of
  // another column is a key like any other
  const first = (v: unknown): AstNode | null => {
    if (Array.isArray(v)) { for (const x of v) { const m = first(x); if (m !== null) return m; } return null; }
    if (!isObject(v)) return null;
    const m = isNode(v) ? marks.get(shape(v)) : undefined;
    if (m !== undefined) return m.bucket;
    return first(Object.values(isNode(v) ? bodyOf(v) : v));
  };
  const chosenBucket = (() => { for (const g of groups) { const b = first(keyOf(g)); if (b !== null) return b; } return null; })();
  if (chosenBucket === null) throw new Bail();
  const chosen = shape(chosenBucket);
  // its FROM and WHERE are read by both branches: never where they could answer twice differently
  repeatableFrom(s.fromClause);
  repeatable(s.whereClause);
  const markOf = (v: AstNode): BucketMark | undefined => { const m = marks.get(shape(v)); return m !== undefined && shape(m.bucket) === chosen ? m : undefined; };
  const holdsChosen = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(holdsChosen);
    if (!isObject(v)) return false;
    if (isNode(v) && markOf(v) !== undefined) return true;
    return Object.values(isNode(v) ? bodyOf(v) : v).some(holdsChosen);
  };
  // a key that holds no mark of that column is one inner key, computed a row as the statement computes it: never its
  // columns apart, whose values could be as many as the rows
  const plainKeys = new Set(groups.map(keyOf).filter((k) => !holdsChosen(k)).map((k) => { checked(k); return shape(k); }));

  const derived = `${own}bucketed`;
  const inner: AstNode[] = [];
  // each inner key as the second branch computes it, where it differs (the bucket, NULL; the truncation, the row's)
  const innerNone: AstNode[] = [];
  const parts: AstNode[] = [];
  const columns = new Map<string, string>();
  // THE INNER KEYS ARE THE GROUP BY'S: every one is made as its keys are read (`keysRead`), and the outer query groups by
  // those. An expression of the list, the HAVING or the ORDER BY that needs another is one the outer GROUP BY cannot read
  // (a column no key holds, spelled otherwise or depending on the key): the statement keeps its plan
  let keysRead = false;
  // an inner key: one name per form
  const key = (val: AstNode, prefix: string, none: AstNode = val): AstNode => {
    const sig = `${prefix}:${shape(val)}`;
    let name = columns.get(sig);
    if (name === undefined) {
      if (keysRead) throw new Bail();
      name = `${own}${prefix}${inner.length}`;
      columns.set(sig, name);
      inner.push(res(structuredClone(val), name));
      innerNone.push(res(structuredClone(none), name));
    }
    return ref(derived, name);
  };
  const part = (val: AstNode): AstNode => {
    const name = `${own}p${parts.length}`;
    parts.push(res(val, name));
    return ref(derived, name);
  };
  const outputNames = new Set(targets.map((t) => String(bodyOf(t).name)));

  /** an aggregate read from its parts */
  const merged = (n: AstNode): AstNode => {
    const b = bodyOf(n);
    const name = funcName(b);
    if (!MERGED.has(name) || b.agg_distinct === true || b.agg_order !== undefined || b.agg_within_group === true || b.over !== undefined
      || b.func_variadic === true || (b.funcname as unknown[]).length !== 1) throw new Bail();
    // a sum of doubles added in another order is other doubles: its last digit may move, so it keeps its plan
    if ((name === "sum" || name === "avg") && approximate(n)) throw new Bail();
    switch (name) {
      case "sum": return call("sum", [part(n)]);
      case "count": case "count_star": return cast(call("sum", [part(n)]), "bigint");
      case "min": case "max": case "first": case "any_value": return call(name, [part(n)]);
      default: {
        // avg: the engine's DOUBLE of every argument Postgres averages (an integer, a numeric, a float)
        const sum = part({ FuncCall: { ...structuredClone(b), funcname: [S("sum")] } });
        const count = part({ FuncCall: { ...structuredClone(b), funcname: [S("count")] } });
        return { A_Expr: { kind: "AEXPR_OP", name: [S("/")], lexpr: cast(call("sum", [sum]), "double"), rexpr: call("sum", [count]) } };
      }
    }
  };

  /** an expression of the outer query over the input's columns: each key read from the inner one, each mark from its
   *  bucket, each aggregate from its parts */
  const outer = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => outer(x));
    if (!isObject(v)) return v;
    if (!isNode(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, outer(x)]));
    if (plainKeys.has(shape(v))) return key(v, "g");
    const mark = markOf(v);
    if (mark !== undefined) {
      // the bucket, NULL in a zone it does not decide the units of (the first branch) and for a row no bucket decides (the
      // second); and the truncation of the row, in that zone and for that row alone (NULL elsewhere: no time is read)
      const usable: AstNode = { CaseExpr: { args: [{ CaseWhen: { expr: offBoundary(), result: { A_Const: { isnull: true } } } }], defresult: structuredClone(mark.bucket) } };
      const bucket = key(usable, "b", cast({ A_Const: { isnull: true } }, "integer"));
      const none = key({ CaseExpr: { args: [{ CaseWhen: { expr: offBoundary(), result: v } }] } }, "e", v);
      return { CaseExpr: { args: [{ CaseWhen: { expr: { NullTest: { arg: structuredClone(bucket), nulltesttype: "IS_NULL" } }, result: none } }],
        defresult: placed(mark.outer, placeholder, bucketStart(bucket)) } };
    }
    const k = kindOf(v), b = bodyOf(v);
    switch (k) {
      case "SubLink": case "GroupingFunc": case "A_Star": case "WindowDef": throw new Bail();
      case "A_Expr": {
        // a lambda's parameter is no column; a JSON arrow is left to the plan as it was
        const op = ((b.name ?? []) as unknown[]).map(sval);
        if (op.includes("->") || op.includes("->>")) throw new Bail();
        break;
      }
      case "ColumnRef": {
        const f = (b.fields ?? []) as unknown[];
        if (f.some((x) => isNode(x) && kindOf(x) === "A_Star")) throw new Bail();
        return key(v, "c");
      }
      case "FuncCall": {
        if (b.over !== undefined) throw new Bail();
        const name = funcName(b);
        if (ENGINE_AGGREGATES.has(name)) return merged(v);
        // a volatile value is one a row: read for each inner group instead, it would be other values
        if (VOLATILE.has(name)) throw new Bail();
        if (b.agg_filter !== undefined || b.agg_order !== undefined || b.agg_star === true || b.agg_distinct === true) throw new Bail();
        break;
      }
    }
    return { [k]: Object.fromEntries(Object.entries(b).map(([key, x]) => [key, outer(x)])) };
  };

  // the GROUP BY first: its keys are the inner ones (a key by number, its output's expression: the GROUP BY keeps the
  // number, which reads the outer list's)
  const groupClause = (groups as AstNode[]).map((g) => { const read = outer(keyOf(g)) as AstNode; return constInt(g) !== null ? g : read; });
  keysRead = true;
  const targetList = targets.map((t) => ({ ResTarget: { ...bodyOf(t), val: outer(bodyOf(t).val) } }));
  const havingClause = s.havingClause === undefined ? undefined : outer(s.havingClause);
  // AN ORDER BY ITEM IS WHAT POSTGRES BINDS IT TO (findTargetlistEntrySQL92, then SQL99), never what its form matches:
  // an integer constant alone is the output at that position, and a name alone that is an output's is that output — the
  // outer query has the same list, so each is kept as it is. Anything else is an expression over the input's columns,
  // at any depth (a name inside an expression is never an output), read from the keys like the list
  const sortClause = s.sortClause === undefined ? undefined : (s.sortClause as AstNode[]).map((x) => {
    if (kindOf(x) !== "SortBy") throw new Bail();
    const node = bodyOf(x).node as AstNode;
    const fields = isNode(node) && kindOf(node) === "ColumnRef" ? (bodyOf(node).fields ?? []) as unknown[] : [];
    const output = constInt(node) !== null || (fields.length === 1 && outputNames.has(sval(fields[0]) ?? "\u0000"));
    return { SortBy: { ...bodyOf(x), node: output ? structuredClone(node) : outer(node) } };
  });
  if (inner.length === 0) throw new Bail();
  // the rows a bucket decides, and the rows none does (`BUCKET_NONE`), each grouped
  const branch = (keys: AstNode[], bucketTest: AstNode): Body => {
    // an AND of the WHERE's own: one AND, as its SQL reads back (an AND inside an AND is written as one)
    const w = s.whereClause === undefined ? undefined : structuredClone(s.whereClause) as AstNode;
    const conjuncts = w === undefined ? [] : kindOf(w) === "BoolExpr" && bodyOf(w).boolop === "AND_EXPR" ? bodyOf(w).args as AstNode[] : [w];
    const where = conjuncts.length === 0 ? bucketTest : { BoolExpr: { boolop: "AND_EXPR", args: [...conjuncts, bucketTest] } };
    return { targetList: [...keys, ...parts].map((x) => structuredClone(x)), fromClause: structuredClone(s.fromClause), whereClause: where,
      groupClause: keys.map((_, i) => intConst(i + 1)), limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" };
  };
  const noneConst = (): AstNode => ({ A_Const: { ival: { ival: BUCKET_NONE } } });
  const decided = branch(inner, { A_Expr: { kind: "AEXPR_DISTINCT", name: [S("=")], lexpr: structuredClone(chosenBucket), rexpr: noneConst() } });
  const undecided = branch(innerNone, { A_Expr: { kind: "AEXPR_OP", name: [S("=")], lexpr: structuredClone(chosenBucket), rexpr: noneConst() } });
  const innerSelect: Body = { op: "SETOP_UNION", all: true, larg: decided, rarg: undecided, limitOption: "LIMIT_OPTION_DEFAULT" };
  const out: Body = { ...s, targetList, fromClause: [{ RangeSubselect: { subquery: { SelectStmt: innerSelect }, alias: { aliasname: derived } } }], groupClause };
  delete out.whereClause;
  if (havingClause === undefined) delete out.havingClause; else out.havingClause = havingClause;
  if (sortClause !== undefined) out.sortClause = sortClause;
  return out;
}
