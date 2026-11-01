/**
 * FETCH FIRST n ROWS WITH TIES, RANKED (issue 192). DuckDB has no WITH TIES: the rows kept are those whose rank under
 * the ORDER BY is within the offset plus the count, past the offset. The rewrite (src/duck/rewrite.ts `withTies`)
 * leaves each such body marked WITH TIES, its keys written as the sort orders by them and its count and offset coerced
 * to int8 as Postgres coerces them, inside a wrapper that lists Postgres's outputs and orders by `__mason_rank`.
 * src/duck/late.ts ranks a body over joined tables on row numbers and keys alone; every body left is ranked here
 * (`tiesRanked`). Both read the bound from ONE helper, `tiesBound`, as Postgres reads it (its executor's
 * recompute_limits): a NULL count is no limit, a NULL offset is 0, a negative offset raises 2201X and then a negative
 * count 2201W, the offset checked first.
 */

type Body = Record<string, unknown>;
type AstNode = Record<string, unknown>;

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const S = (sval: string): AstNode => ({ String: { sval } });
const ref = (...names: string[]): AstNode => ({ ColumnRef: { fields: names.map(S) } });
const op = (name: string, l: AstNode, r: AstNode): AstNode => ({ A_Expr: { kind: "AEXPR_OP", name: [S(name)], lexpr: l, rexpr: r } });
const call = (name: string, args: AstNode[]): AstNode => ({ FuncCall: { funcname: [S(name)], args, funcformat: "COERCE_EXPLICIT_CALL" } });
const raise = (code: string, message: string): AstNode => call("error", [{ A_Const: { sval: { sval: `mason[${code}]: ${message}` } } }]);
const zero = (): AstNode => ({ A_Const: { ival: {} } });

/** the rank a WITH TIES body's rows are kept by, and their place (read only where there is an offset) */
export const TIES_RANK = "__mason_rank", TIES_ROW = "__mason_row";
const BOUND = "__mason_bound";

/** a body is WITH TIES as libpg-query writes it */
export const isTies = (b: Body): boolean => b.limitOption === "LIMIT_OPTION_WITH_TIES";

/**
 * THE BOUND OF A WITH TIES BODY: a one-row FROM item `(SELECT <offset> AS o, <count> AS n) AS __mason_bound`, and the
 * filter over a ranked row read by `ranked` (its alias). Read from a row of its own, never an OFFSET clause: DuckDB
 * evaluates no OFFSET over no rows, and Postgres raises a negative count over none. Each node is a copy (one place each).
 */
export function tiesBound(count: unknown, offset: unknown, ranked: string): { item: AstNode; filter: AstNode; row: boolean } {
  const off = (): AstNode => structuredClone(offset) as AstNode;
  const cnt = (): AstNode => structuredClone(count) as AstNode;
  const negativeOffset = (): AstNode => ({ CaseWhen: { expr: op("<", off(), zero()), result: raise("2201X", "OFFSET must not be negative") } });
  const row = offset !== undefined;
  const o: AstNode = row ? { CaseExpr: { args: [negativeOffset()], defresult: { CoalesceExpr: { args: [off(), zero()] } } } } : zero();
  const n: AstNode = { CaseExpr: { args: [...(row ? [negativeOffset()] : []), { CaseWhen: { expr: op("<", cnt(), zero()), result: raise("2201W", "LIMIT must not be negative") } }], defresult: cnt() } };
  const item: AstNode = { RangeSubselect: { subquery: { SelectStmt: { targetList: [{ ResTarget: { name: "o", val: o } }, { ResTarget: { name: "n", val: n } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } },
    alias: { aliasname: BOUND } } };
  // a row is kept past the offset while its rank is within offset + n; a NULL n keeps every row (rank - o: no overflow)
  const within: AstNode = { CoalesceExpr: { args: [op("<=", op("-", ref(ranked, TIES_RANK), ref(BOUND, "o")), ref(BOUND, "n")), { A_Const: { boolval: { boolval: true } } }] } };
  const filter: AstNode = row ? { BoolExpr: { boolop: "AND_EXPR", args: [op(">", ref(ranked, TIES_ROW), ref(BOUND, "o")), within] } } : within;
  return { item, filter, row };
}

/** a count or offset that is a literal no less than 0 (cast or not), which no bound can refuse */
const literal = (n: unknown): boolean => {
  const k = isObject(n) ? Object.keys(n)[0] : undefined;
  const b = k === undefined ? {} : (n as Record<string, Body>)[k]!;
  if (k === "TypeCast") return literal(b.arg);
  if (k !== "A_Const") return false;
  if (isObject(b.ival)) return Number(b.ival.ival ?? 0) >= 0;
  return isObject(b.fval) && !String(b.fval.fval).startsWith("-");
};

/**
 * THE ROWS KEPT, GUARDED: `filtered` (a SELECT of the rows its bound keeps) read beside a copy of the bound that is
 * always evaluated, `SELECT __mason_kept.* FROM <bound> LEFT JOIN (filtered) AS __mason_kept ON true WHERE
 * __mason_kept.__mason_rank IS NOT NULL OR <bound>.n < 0`: Postgres raises a negative count or offset over no rows, and DuckDB
 * evaluates nothing of a join one side of which is empty. Unguarded where both are literals no less than 0.
 */
export function tiesGuarded(filtered: Body, count: unknown, offset: unknown): Body {
  if (literal(count) && (offset === undefined || literal(offset))) return filtered;
  const guard = tiesBound(count, offset, "__mason_kept").item;
  const kept = "__mason_kept";
  return {
    targetList: [{ ResTarget: { val: { ColumnRef: { fields: [S(kept), { A_Star: {} }] } } } }],
    fromClause: [{ JoinExpr: { jointype: "JOIN_LEFT", larg: guard, rarg: { RangeSubselect: { subquery: { SelectStmt: filtered }, alias: { aliasname: kept } } },
      quals: { A_Const: { boolval: { boolval: true } } } } }],
    // (a row kept, or the bound read: never true, it raises; DuckDB computes no column nothing reads, and drops a filter
    // it can prove false, as `kept.rank IS NOT NULL` over an empty side would be)
    whereClause: { BoolExpr: { boolop: "OR_EXPR", args: [{ NullTest: { arg: ref(kept, TIES_RANK), nulltesttype: "IS_NOT_NULL" } }, op("<", ref(BOUND, "n"), zero())] } },
    limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
  };
}

/** the window the rank (and the row's place) is computed over: the body's keys as written */
export function tiesWindow(name: string, sorts: unknown): AstNode {
  const keys = Array.isArray(sorts) && sorts.length > 0 ? { orderClause: structuredClone(sorts) } : {};
  return { FuncCall: { funcname: [S(name)], over: { ...keys, frameOptions: 1058 }, funcformat: "COERCE_EXPLICIT_CALL" } };
}

const RANKED = "__mason_ranked";

/**
 * EVERY WITH TIES BODY LEFT, RANKED IN PLACE: `SELECT __mason_ranked.* FROM (<the body, no ORDER BY or limit>,
 * rank() OVER (ORDER BY <its keys>)[, row_number() …]) AS __mason_ranked(<every column by its place>), <the bound>
 * WHERE <the filter>`. A body is read only as the rewrite's wrapper reads it (`FROM (<body>) AS __mason_ties(<its
 * columns, the cells, the rank>)`, src/duck/rewrite.ts `withTies`), whose alias names every column by its place: the
 * ranked rows take those names, and the row's place one more, so the rank and the place are read by a name no output of
 * the user's can hold (the class "a rewrite's column read by a name the user can write", PR 233).
 * Throws where one is left, which would be DuckDB's LIMIT (no ties): a report, never another answer.
 */
export function tiesRanked(tree: AstNode): void {
  const rank = (v: Body, colnames: unknown): void => {
    const names = Array.isArray(colnames) ? colnames.map((c) => isObject(c) && isObject(c.String) ? String(c.String.sval) : "") : [];
    if (names.at(-1) !== TIES_RANK) throw new Error("a FETCH … WITH TIES was read other than by Mason's wrapper, which names its rank last: report it, with the statement");
    const { sortClause, limitCount, limitOffset, limitOption: _l, ...rest } = v;
    const bound = tiesBound(limitCount, limitOffset, RANKED);
    const inner: Body = { ...rest, targetList: [...((rest.targetList ?? []) as AstNode[]),
      { ResTarget: { name: TIES_RANK, val: tiesWindow("rank", sortClause) } },
      ...(bound.row ? [{ ResTarget: { name: TIES_ROW, val: tiesWindow("row_number", sortClause) } }] : [])], limitOption: "LIMIT_OPTION_DEFAULT" };
    for (const k of Object.keys(v)) delete v[k];
    Object.assign(v, tiesGuarded({
      targetList: [{ ResTarget: { val: { ColumnRef: { fields: [S(RANKED), { A_Star: {} }] } } } }],
      fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: RANKED, colnames: [...names, ...(bound.row ? [TIES_ROW] : [])].map(S) } } }, bound.item],
      whereClause: bound.filter,
      limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
    }, limitCount, limitOffset));
  };
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isObject(v)) return;
    for (const x of Object.values(v)) visit(x);
    const sub = isObject(v.RangeSubselect) && isObject(v.RangeSubselect.subquery) ? v.RangeSubselect.subquery.SelectStmt : undefined;
    if (isObject(sub) && isTies(sub)) rank(sub, isObject(v.RangeSubselect) && isObject(v.RangeSubselect.alias) ? v.RangeSubselect.alias.colnames : undefined);
  };
  visit(tree);
  const left = (v: unknown): boolean => Array.isArray(v) ? v.some(left) : isObject(v) && (isTies(v) || Object.values(v).some(left));
  if (left(tree)) throw new Error("a FETCH … WITH TIES was left unranked by Mason's rewrite: report it, with the statement");
}
