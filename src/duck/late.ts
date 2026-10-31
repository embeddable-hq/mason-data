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
 *
 * THE ROWS OF A JOIN, CHOSEN BY ROW NUMBER (issue 105: a table preview over three joined tables spilled every row's wide
 * columns to choose 100, and filled the disk). DuckDB's own late materialization stops at a join, and the form above
 * still carries each column the list reads through the join and the top N. So where every FROM item is a copied table
 * and the join names no columns (`joinRows`), the rows are chosen on their row numbers alone, and the columns read for
 * the rows chosen:
 *
 *   SELECT <the list as written> FROM (
 *     SELECT a.rowid AS __mason_r1, b.rowid AS __mason_r2, <each sort key> AS __mason_o<i>
 *     FROM … WHERE … ORDER BY <the sort keys> LIMIT … OFFSET …) AS __mason_late
 *   LEFT JOIN a ON a.rowid = __mason_late.__mason_r1 LEFT JOIN b ON b.rowid = __mason_late.__mason_r2
 *   ORDER BY __mason_late.__mason_o<i> …
 *
 * A row of the join is one row number per table, NULL where an outer join supplied none, and that NULL finds no row, so
 * its columns are NULL as they were: a row the join multiplies is a pair of its own, and a statement of one snapshot
 * reads each row number once. The rows and the order among different keys are the inner query's; rows of EQUAL keys
 * are in no defined order, here as on Postgres. Measured over a 4 M-row join with wide JSON in the last table (a 2 GB
 * limit): 12.9 s and 8.6 GiB spilled before, 0.19 s and none after; LIMIT 10,000 failed for memory before and takes 2.9 s.
 *
 * A row number is read only of a table: a derived table, a view, a WITH query and a role's filtered read (each a
 * subquery by now) stay as they were, and so does a table with a column named `rowid`, which DuckDB reads instead. A `*`
 * is written out from Postgres's own list of the table's columns, so the tables can be read themselves (a copy's view
 * of its visible columns, src/duck/kept-route.ts, has no row numbers); a whole row is not listed, and stays as it was.
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
  const relations = relationsOf(analysis);
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
      const late = joinRows({ SelectStmt: body[arm] }, relations) ?? afterLimit({ SelectStmt: body[arm] });
      if (late !== null) { body[arm] = bodyOf(late); changed = true; }
    }
    const late = joinRows(out, relations) ?? afterLimit(out);
    if (late === null) return out;
    changed = true;
    return late;
  };
  const written = visit(tree) as AstNode;
  return changed ? written : null;
}

/** a SELECT of the shape both forms take: sorted and limited, each row one row of its FROM; its list and its sort */
function sortedLimited(s: Body): { targets: AstNode[]; sorts: AstNode[] } | null {
  if (s.op !== undefined && s.op !== "SETOP_NONE") return null;
  for (const f of ["withClause", "distinctClause", "groupClause", "havingClause", "windowClause", "lockingClause", "intoClause", "valuesLists"]) {
    if (s[f] !== undefined && !(Array.isArray(s[f]) && (s[f] as unknown[]).length === 0)) return null;
  }
  if (s.limitCount === undefined || (s.limitOption !== undefined && s.limitOption !== "LIMIT_OPTION_COUNT" && s.limitOption !== "LIMIT_OPTION_DEFAULT")) return null;
  const targets = s.targetList as AstNode[] | undefined;
  const sorts = s.sortClause as AstNode[] | undefined;
  if (targets === undefined || sorts === undefined || sorts.length === 0) return null;
  return { targets, sorts };
}

/** each sort key as an expression over the FROM clause, or null: an ordinal or an output column's name is that
 *  output's own expression, as Postgres reads it (an output name before an input column's), and a sort by a computed
 *  output computes it for every row anyway: nothing to defer, and a volatile one must stay one value */
function sortKeys(targets: AstNode[], sorts: AstNode[]): AstNode[] | null {
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
      if (rowWise(bodyOf(target).val).computes) return null;
      keys.push(structuredClone(bodyOf(target).val as AstNode));
    } else if (kindOf(node) === "A_Const") return null;
    else keys.push(structuredClone(node as AstNode));
  }
  return keys;
}

/** one SELECT written so, or null where it is not so shaped */
function afterLimit(select: AstNode): AstNode | null {
  const s = bodyOf(select);
  const shape = sortedLimited(s);
  if (shape === null) return null;
  const { targets, sorts } = shape;
  let computes = false;
  for (const t of targets) {
    if (kindOf(t) !== "ResTarget") return null;
    const r = rowWise(bodyOf(t).val);
    if (!r.ok) return null;
    computes ||= r.computes;
  }
  if (!computes) return null;
  const keys = sortKeys(targets, sorts);
  if (keys === null) return null;
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

/** a table of a query's rtable: the name its columns are read by, and its columns; null for any other FROM item */
type Relation = { alias: string; columns: string[] } | null;
const RTE_RELATION = "0", RTE_JOIN = "2";
/** Postgres's first OID for an object not of its own (FirstNormalObjectId): below it, a catalog table, no copy */
const FIRST_USER_OID = 16384;

/** what each query of the analysed statement reads, FROM item by FROM item (a join itself is no item) */
function relationsOf(analysis: TreeValue): Relation[][] {
  const out: Relation[][] = [];
  const relation = (e: TreeNode): Relation => {
    if (e.rtekind !== RTE_RELATION || e.relkind !== "r" || Number(e.relid) < FIRST_USER_OID) return null;
    const ref = e.eref as TreeNode | null;
    if (typeof ref?.aliasname !== "string" || !Array.isArray(ref.colnames)) return null;
    return { alias: ref.aliasname, columns: ref.colnames.filter((c): c is string => typeof c === "string") };
  };
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    if (v._node === "QUERY" && Array.isArray(v.rtable)) {
      out.push(v.rtable.filter((e): e is TreeNode => typeof e === "object" && e !== null && !Array.isArray(e) && e.rtekind !== RTE_JOIN).map(relation));
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(analysis);
  return out;
}

/** the FROM clause's tables in order, or null where it holds anything but tables joined on conditions */
function joinedTables(from: unknown): Body[] | null {
  const tables: Body[] = [];
  const walk = (n: unknown): boolean => {
    const k = kindOf(n);
    if (k === "RangeVar") { tables.push(bodyOf(n)); return true; }
    if (k !== "JoinExpr") return false;
    const j = bodyOf(n);
    if (j.isNatural === true || j.usingClause !== undefined || j.alias !== undefined || j.join_using_alias !== undefined) return false;
    return walk(j.larg) && walk(j.rarg);
  };
  return Array.isArray(from) && from.every(walk) ? tables : null;
}

const aliasOfTable = (t: Body): string => isObject(t.alias) ? String(t.alias.aliasname) : String(t.relname);
const rowNumber = (alias: string): AstNode => ref(alias, "rowid");

/** the select list with every `*` written out; the tables it reads by name; null where it reads a whole row, or holds what the list after the limit may not */
function writtenOut(targets: AstNode[], tables: ReadonlyArray<{ alias: string; columns: string[] }>): { list: AstNode[]; read: Set<string> } | null {
  const aliases = new Set(tables.map((t) => t.alias));
  const read = new Set<string>();
  const list: AstNode[] = [];
  const reads = (n: unknown): boolean => {
    if (Array.isArray(n)) return n.every(reads);
    if (!isObject(n)) return true;
    if (kindOf(n) === "ColumnRef" && isObject(n.ColumnRef)) {
      const fields = n.ColumnRef.fields as unknown[];
      const names = fields.map((f) => kindOf(f) === "String" ? bodyOf(f).sval as string : null);
      if (names.length === 1) {
        // a bare name: of a table it does not say, unless it is a table's own name, a whole row
        const name = names[0];
        if (name === null || name === undefined || aliases.has(name)) return false;
        for (const a of aliases) read.add(a);
        return true;
      }
      const owner = names.at(-2);
      if (typeof owner !== "string" || !aliases.has(owner)) return false;
      read.add(owner);
      return true;
    }
    return Object.values(n).every(reads);
  };
  for (const t of targets) {
    if (kindOf(t) !== "ResTarget") return null;
    const val = bodyOf(t).val;
    const fields = kindOf(val) === "ColumnRef" ? bodyOf(val).fields as unknown[] : [];
    if (kindOf(fields.at(-1)) === "A_Star") {
      const owner = fields.length >= 2 ? bodyOf(fields.at(-2)).sval as string : null;
      for (const table of tables) {
        if (owner !== null && table.alias !== owner) continue;
        read.add(table.alias);
        for (const c of table.columns) list.push({ ResTarget: { name: c, val: ref(table.alias, c) } });
      }
      continue;
    }
    if (!rowWise(val).ok || !reads(val)) return null;
    list.push(t);
  }
  return { list, read };
}

/** one SELECT over joined tables written with its rows chosen by row number (see above), or null where it is not so shaped */
function joinRows(select: AstNode, relations: Relation[][]): AstNode | null {
  const s = bodyOf(select);
  const shape = sortedLimited(s);
  if (shape === null) return null;
  const { targets, sorts } = shape;
  const from = joinedTables(s.fromClause);
  if (from === null || from.length < 2) return null;
  const aliases = from.map(aliasOfTable);
  if (new Set(aliases).size !== aliases.length) return null;
  // the query of the analysis this SELECT is: its FROM items, in order. Two queries alike must agree, or which is unsure
  const named = relations.filter((r) => r.length === aliases.length && r.every((t, i) => t?.alias === aliases[i]));
  const tables = named[0] as Array<{ alias: string; columns: string[] }> | undefined;
  if (tables === undefined || named.some((r) => JSON.stringify(r) !== JSON.stringify(tables))) return null;
  if (tables.some((t) => t.columns.includes("rowid") || t.columns.includes(""))) return null;
  const written = writtenOut(targets, tables);
  if (written === null || written.read.size === 0) return null;
  const keys = sortKeys(targets, sorts);
  if (keys === null) return null;
  // each table read itself, both times: a row number is no column of a copy's view, and nothing here lists a column
  // that is not named
  const own = (t: Body): Body => { const { catalogname: _c, ...rest } = t; return structuredClone(rest); };
  const bare = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(bare);
    if (!isObject(n)) return n;
    if (kindOf(n) === "RangeVar") return { RangeVar: own(bodyOf(n)) };
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, bare(v)]));
  };
  const fetched = from.filter((t) => written.read.has(aliasOfTable(t)));
  const inner: Body = { ...s, fromClause: bare(s.fromClause), targetList: [
    ...fetched.map((t, i) => ({ ResTarget: { name: `__mason_r${i + 1}`, val: rowNumber(aliasOfTable(t)) } })),
    ...keys.map((k, i) => ({ ResTarget: { name: `__mason_o${i + 1}`, val: k } })),
  ], sortClause: sorts.map((sort, i) => ({ SortBy: { ...bodyOf(sort), node: keys[i] } })) };
  let joined: AstNode = { RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: LATE } } };
  fetched.forEach((t, i) => {
    joined = { JoinExpr: { jointype: "JOIN_LEFT", larg: joined, rarg: { RangeVar: own(t) }, quals: { A_Expr: {
      kind: "AEXPR_OP", name: [S("=")], lexpr: rowNumber(aliasOfTable(t)), rexpr: ref(LATE, `__mason_r${i + 1}`) } } } };
  });
  return { SelectStmt: {
    targetList: written.list,
    fromClause: [joined],
    sortClause: sorts.map((sort, i) => ({ SortBy: { ...bodyOf(sort), node: ref(LATE, `__mason_o${i + 1}`) } })),
    limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
  } };
}
