/**
 * A GROUP BY OF A TIME'S UNIT, GROUPED BY ITS 15-MINUTE BUCKET FIRST (issue 1146; docs/DESIGN.md "A time's 15-minute
 * bucket"). `date_trunc('month', created_at)` in the session's zone costs ICU's calendar a row (96.3 s against 39.8 s
 * in UTC for "Revenue by month" at 100 M orders and 10 clients), where the copy holds each value's 15 minutes of UTC
 * (src/duck/bucket-column.ts), and every local hour, day, week, month, quarter and year since 1980 begins on one. So a
 * grouped SELECT the rewrite wrote over such a truncation (src/duck/rewrite.ts marks each, `BucketMark`) is written as
 * two:
 *
 *   SELECT <its list, HAVING, ORDER BY, each aggregate read from its parts, each truncation from its bucket's start>
 *   FROM (SELECT <the bucket>, <the truncation of a row with no bucket>, <every column read outside an aggregate>,
 *                <each aggregate's parts> FROM <its FROM> WHERE <its WHERE> GROUP BY <all but the parts>) AS <own>bucketed
 *   GROUP BY <its GROUP BY>
 *
 * The inner groups are a finer split of the statement's own: each of its keys is computed from the inner columns (a
 * truncation's from its bucket, which decides it, or from the row's own truncation where the row has no bucket: before
 * 1980, infinite or NULL), so every group of the statement is a union of inner groups, and an aggregate that adds up from
 * parts answers the same: sum (the sum of sums), count (their sum), min, max, first and any_value (of theirs), avg (the
 * sum of sums over the sum of counts). Anything else keeps the statement as it was, which is exact: another aggregate
 * (count(DISTINCT), a median, string_agg, arg_min …: `ENGINE_AGGREGATES` names every one the engine has), an ordered
 * aggregate, a window, a subquery, a `*`, a lambda or a JSON arrow outside an aggregate, grouping sets, DISTINCT, and a
 * SELECT a subquery or a LATERAL item may correlate. Nothing is refused.
 *
 * On the finished tree, after the walk (src/duck/rewrite.ts `rewrite`), so no rule of the rewrite meets the inner query.
 * A truncation is recognised by its form without offsets (`shape`): the rewrite writes the list's and the GROUP BY's
 * alike, each from its own node.
 */
import { OFF_BOUNDARY_ZONES } from "./bucket-column.ts";

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
 * Every grouped SELECT of `tree` over a marked truncation written as two (the module's header), in place. `marks` by
 * `shape`; `placeholder` the marks' bucket start; `own` the statement's prefix (src/duck/own-names.ts).
 */
export function bucketGroups(tree: unknown, marks: ReadonlyMap<string, BucketMark>, placeholder: string, own: string): unknown {
  if (marks.size === 0) return tree;
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
    try { return { SelectStmt: grouped(bodyOf(out), marks, placeholder, own) }; } catch (e) { if (e instanceof Bail) return out; throw e; }
  };
  return visit(tree, false);
}

/** one SELECT written as two, or `Bail` where it keeps its form */
function grouped(s: Body, marks: ReadonlyMap<string, BucketMark>, placeholder: string, own: string): Body {
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
  const holdsMark = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(holdsMark);
    if (!isObject(v)) return false;
    if (isNode(v) && marks.has(shape(v))) return true;
    return Object.values(isNode(v) ? bodyOf(v) : v).some(holdsMark);
  };
  if (!groups.some((g) => holdsMark(keyOf(g)))) throw new Bail();

  const derived = `${own}bucketed`;
  const inner: AstNode[] = [];
  const parts: AstNode[] = [];
  const columns = new Map<string, string>();
  // an inner key: one name per form
  const key = (val: AstNode, prefix: string): AstNode => {
    const sig = `${prefix}:${shape(val)}`;
    let name = columns.get(sig);
    if (name === undefined) {
      name = `${own}${prefix}${inner.length}`;
      columns.set(sig, name);
      inner.push(res(structuredClone(val), name));
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

  /** an expression of the outer query: each column read from the inner one, each mark from its bucket, each aggregate
   *  from its parts. `sorting`: an ORDER BY key, whose bare name of an output is that output */
  const outer = (v: unknown, sorting: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => outer(x, sorting));
    if (!isObject(v)) return v;
    if (!isNode(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, outer(x, sorting)]));
    const mark = marks.get(shape(v));
    if (mark !== undefined) {
      // the bucket, NULL in a zone it does not decide the units of; and the truncation of a row with none (NULL where it
      // has one)
      const usable = (): AstNode => ({ CaseExpr: { args: [{ CaseWhen: { expr: offBoundary(), result: { A_Const: { isnull: true } } } }], defresult: structuredClone(mark.bucket) } });
      const bucket = key(usable(), "b");
      const none = key({ CaseExpr: { args: [{ CaseWhen: { expr: { NullTest: { arg: usable(), nulltesttype: "IS_NULL" } }, result: v } }] } }, "e");
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
        // a bare name of an output in an ORDER BY is that output, in both queries
        if (sorting && f.length === 1 && outputNames.has(sval(f[0]) ?? "\u0000")) return structuredClone(v);
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
    return { [k]: Object.fromEntries(Object.entries(b).map(([key, x]) => [key, outer(x, sorting)])) };
  };

  const targetList = targets.map((t) => ({ ResTarget: { ...bodyOf(t), val: outer(bodyOf(t).val, false) } }));
  const groupClause = (groups as AstNode[]).map((g) => constInt(g) !== null ? g : outer(g, false) as AstNode);
  const havingClause = s.havingClause === undefined ? undefined : outer(s.havingClause, false);
  const sortClause = s.sortClause === undefined ? undefined : (s.sortClause as AstNode[]).map((x) => {
    if (kindOf(x) !== "SortBy") throw new Bail();
    return { SortBy: { ...bodyOf(x), node: outer(bodyOf(x).node, true) } };
  });
  if (inner.length === 0) throw new Bail();
  const innerSelect: Body = {
    targetList: [...inner, ...parts], fromClause: s.fromClause, ...(s.whereClause !== undefined ? { whereClause: s.whereClause } : {}),
    groupClause: inner.map((_, i) => intConst(i + 1)), limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
  };
  const out: Body = { ...s, targetList, fromClause: [{ RangeSubselect: { subquery: { SelectStmt: innerSelect }, alias: { aliasname: derived } } }], groupClause };
  delete out.whereClause;
  if (havingClause === undefined) delete out.havingClause; else out.havingClause = havingClause;
  if (sortClause !== undefined) out.sortClause = sortClause;
  return out;
}
