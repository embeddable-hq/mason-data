/**
 * THE SELECT LIST AFTER THE LIMIT (the Metabase test of #517: a table's preview, `… ORDER BY id LIMIT 2000` with a JSON
 * column's fields and a join, took 188 ms). DuckDB computes a statement's select list BELOW its Top N: every row's JSON
 * is read to keep 2,000 of them. Its own late materialization covers one table's plain columns only, and it takes
 * Mason's functions for cheap. So a statement that sorts and limits a computed select list is written as Postgres
 * plans it through an index — the rows chosen first, the list computed over them:
 *
 *   SELECT <list over __mason_late's columns> FROM (
 *     SELECT <each column the list reads> AS __mason_c<i>, <each sort key> AS __mason_o<i>
 *     FROM … WHERE … ORDER BY <the sort keys> LIMIT … OFFSET …) AS __mason_late
 *   ORDER BY __mason_late.__mason_o<i> …
 *
 * The rows are the same rows (the inner query keeps the statement's FROM, WHERE, ORDER BY, LIMIT and OFFSET, each
 * column read by its own reference in its own scope), each value is the same expression over the same columns, and the
 * outer ORDER BY is the inner one's keys again. What changes is WHICH ROWS the list is computed for: a value that
 * raises (`'x'::int`) in a row the LIMIT leaves out raises in Postgres only when its plan sorts every row (no index
 * gives the order), and never here — the decided difference `limit-errors` (docs/SQL-SUPPORT.md).
 *
 * Every SELECT of the statement so shaped is written so, a derived table's and a WITH query's too (a tool wraps one
 * in another), when Postgres's analysis has no aggregate, window function, set-returning select list or subquery
 * expression anywhere in the statement, and the SELECT itself has no DISTINCT, GROUP BY, HAVING, WINDOW, WITH, set
 * operation, row lock, WITH TIES or `*` in its list.
 */
import type { TreeNode, TreeValue } from "./pgtree.ts";

type Body = Record<string, unknown>;
type AstNode = Record<string, unknown>;

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const kindOf = (n: unknown): string | null => isObject(n) ? Object.keys(n)[0] ?? null : null;
const bodyOf = (n: unknown): Body => (n as Record<string, Body>)[kindOf(n)!]!;
const S = (sval: string): AstNode => ({ String: { sval } });
const ref = (...names: string[]): AstNode => ({ ColumnRef: { fields: names.map(S) } });
const LATE = "__mason_late";

/** what may stand in a select list that is computed after the limit: one value per row, reading its row alone */
const ROW_WISE = new Set(["ColumnRef", "A_Const", "ParamRef", "FuncCall", "TypeCast", "A_Expr", "BoolExpr", "CaseExpr", "CaseWhen",
  "CoalesceExpr", "NullTest", "BooleanTest", "MinMaxExpr", "A_ArrayExpr", "A_Indirection", "A_Indices", "CollateClause", "NamedArgExpr",
  "RowExpr", "SQLValueFunction", "TypeName", "String", "Integer", "Float", "Boolean", "List"]);
/** DuckDB's set-returning functions: a row each would be many */
const SETS = new Set(["unnest", "generate_series", "range", "generate_subscripts", "json_each", "json_tree"]);

/** Postgres's analysis: no query of the statement aggregates, windows, returns sets from its list or holds a subquery
 *  expression — so every row of every SELECT is one row of its FROM, and a select list reads its own row alone */
function rowWiseStatement(tree: TreeValue): boolean {
  let queries = 0, ok = true;
  const visit = (v: TreeValue | undefined): void => {
    if (!ok) return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    if (v._node === "QUERY") {
      queries++;
      for (const f of ["hasAggs", "hasWindowFuncs", "hasTargetSRFs", "hasSubLinks"]) if ((v as TreeNode)[f] !== "false") { ok = false; return; }
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return ok && queries > 0;
}

/** every node of a select-list expression is row-wise, and it computes something (a plain column needs no deferring) */
function rowWise(n: unknown): { ok: boolean; computes: boolean } {
  let ok = true, computes = false;
  const visit = (v: unknown): void => {
    if (!ok) return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isObject(v)) return;
    const k = kindOf(v)!;
    if (/^[A-Z]/.test(k) && isObject(v[k])) {
      if (!ROW_WISE.has(k)) { ok = false; return; }
      const b = bodyOf(v);
      if (k === "FuncCall") {
        const name = (b.funcname as unknown[]).map((x) => (bodyOf(x).sval as string)).join(".").toLowerCase();
        if (b.over !== undefined || b.agg_star === true || b.agg_distinct === true || b.agg_order !== undefined || b.agg_filter !== undefined || SETS.has(name)) { ok = false; return; }
      }
      if (k === "ColumnRef" && (b.fields as unknown[]).some((f) => kindOf(f) === "A_Star")) { ok = false; return; }
      if (k !== "ColumnRef" && k !== "A_Const" && k !== "ParamRef" && k !== "String" && k !== "Integer" && k !== "Float" && k !== "Boolean") computes = true;
      for (const x of Object.values(b)) visit(x);
      return;
    }
    for (const x of Object.values(v)) visit(x);
  };
  visit(n);
  return { ok, computes };
}

/** the same tree with every ColumnRef replaced by `__mason_late.<the column it is read as>` */
function overLate(n: unknown, columns: Map<string, string>): unknown {
  if (Array.isArray(n)) return n.map((x) => overLate(x, columns));
  if (!isObject(n)) return n;
  if (kindOf(n) === "ColumnRef" && isObject(n.ColumnRef)) {
    const key = JSON.stringify(n.ColumnRef.fields);
    let name = columns.get(key);
    if (name === undefined) { name = `__mason_c${columns.size + 1}`; columns.set(key, name); }
    return ref(LATE, name);
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, overLate(v, columns)]));
}

/**
 * The statement with every sorted, limited SELECT written with its select list computed after its limit (see above),
 * or null where none is. `tree` is the rewrite's DuckDB tree, `analysis` Postgres's of the original.
 */
export function selectListAfterLimit(tree: AstNode, analysis: TreeValue): AstNode | null {
  if (!rowWiseStatement(analysis)) return null;
  let changed = false;
  // bottom up: a SELECT's derived tables and WITH queries first, then the SELECT (never what it was written as)
  const visit = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(visit);
    if (!isObject(n)) return n;
    const out = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, visit(v)]));
    if (kindOf(out) !== "SelectStmt") return out;
    // a set operation's arms are SELECT bodies of their own (libpg-query writes them unwrapped)
    const body = bodyOf(out);
    for (const arm of ["larg", "rarg"]) {
      if (!isObject(body[arm])) continue;
      const late = afterLimit({ SelectStmt: body[arm] });
      if (late !== null) { body[arm] = bodyOf(late); changed = true; }
    }
    const late = afterLimit(out);
    if (late === null) return out;
    changed = true;
    return late;
  };
  const written = visit(tree) as AstNode;
  return changed ? written : null;
}

/** one SELECT written so, or null where it is not so shaped */
function afterLimit(select: AstNode): AstNode | null {
  const s = bodyOf(select);
  if (s.op !== undefined && s.op !== "SETOP_NONE") return null;
  for (const f of ["withClause", "distinctClause", "groupClause", "havingClause", "windowClause", "lockingClause", "intoClause", "valuesLists"]) {
    if (s[f] !== undefined && !(Array.isArray(s[f]) && (s[f] as unknown[]).length === 0)) return null;
  }
  if (s.limitCount === undefined || (s.limitOption !== undefined && s.limitOption !== "LIMIT_OPTION_COUNT" && s.limitOption !== "LIMIT_OPTION_DEFAULT")) return null;
  const targets = s.targetList as AstNode[] | undefined;
  const sorts = s.sortClause as AstNode[] | undefined;
  if (targets === undefined || sorts === undefined || sorts.length === 0) return null;
  let computes = false;
  for (const t of targets) {
    if (kindOf(t) !== "ResTarget") return null;
    const r = rowWise(bodyOf(t).val);
    if (!r.ok) return null;
    computes ||= r.computes;
  }
  if (!computes) return null;
  // each sort key as an expression over the FROM clause: an ordinal or an output column's name is that output's own
  // expression, as Postgres reads it (an output name before an input column's)
  const outputName = (t: AstNode): string | null => {
    const b = bodyOf(t);
    if (typeof b.name === "string") return b.name;
    const v = b.val;
    if (kindOf(v) === "ColumnRef") { const last = (bodyOf(v).fields as unknown[]).at(-1); return kindOf(last) === "String" ? bodyOf(last).sval as string : null; }
    return null;
  };
  const keys: AstNode[] = [];
  for (const sort of sorts) {
    if (kindOf(sort) !== "SortBy") return null;
    const b = bodyOf(sort);
    if (b.useOp !== undefined) return null;
    const node = b.node;
    let target: AstNode | undefined;
    if (kindOf(node) === "A_Const" && isObject(bodyOf(node).ival)) {
      target = targets[Number((bodyOf(node).ival as Body).ival ?? 0) - 1];
      if (target === undefined) return null;
    } else if (kindOf(node) === "ColumnRef" && (bodyOf(node).fields as unknown[]).length === 1) {
      const name = bodyOf((bodyOf(node).fields as unknown[])[0]).sval;
      const named = targets.filter((t) => outputName(t) === name);
      if (named.length > 1) return null;
      target = named[0];
    }
    if (target !== undefined) {
      // a sort by a computed output computes it for every row anyway: nothing to defer
      if (rowWise(bodyOf(target).val).computes) return null;
      keys.push(structuredClone(bodyOf(target).val as AstNode));
    } else if (kindOf(node) === "A_Const") return null;
    else keys.push(structuredClone(node as AstNode));
  }
  const columns = new Map<string, string>();
  const list = targets.map((t) => ({ ResTarget: { ...bodyOf(t), val: overLate(bodyOf(t).val, columns) } }));
  const inner: Body = { ...s, targetList: [
    ...[...columns].map(([fields, name]) => ({ ResTarget: { name, val: { ColumnRef: { fields: JSON.parse(fields) } } } })),
    ...keys.map((k, i) => ({ ResTarget: { name: `__mason_o${i + 1}`, val: k } })),
  ], sortClause: sorts.map((sort, i) => ({ SortBy: { ...bodyOf(sort), node: keys[i] } })) };
  return { SelectStmt: {
    targetList: list,
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: LATE } } }],
    sortClause: sorts.map((sort, i) => ({ SortBy: { ...bodyOf(sort), node: ref(LATE, `__mason_o${i + 1}`) } })),
    limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
  } };
}
