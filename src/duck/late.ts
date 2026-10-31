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
 * are in no defined order, here as on Postgres.
 *
 * A LIMIT WITH NO ORDER BY is written the same way (a statement with no limit in fact, OFFSET alone or LIMIT ALL, stays
 * as it was: every row comes back, and reading each again saves nothing), for the join's memory, where the last table is
 * on the hash join's build side. Its keys are the row numbers of the tables read ONLY WHERE THE JOIN'S ROWS ARE PROVED
 * BOUNDED (`fanOutBounded`, src/duck/distinct-key.ts: every join equates a whole primary key of a table its side holds
 * once, from the analysis and the catalog's pg_index). That sort is for pages: which rows such a statement answers is
 * defined by no one, but DuckDB's parallel join hands the same statement's rows back in another order each run, and a
 * LIMIT over them overlaps its neighbouring pages (about a third of the rows of a join paged to its end came back twice;
 * one thread, none; a Postgres of one plan, in practice none). The top N on row numbers is a full join where a streaming
 * LIMIT stops early, so its cost grows with the join: over 50 M rows, a narrow `dim LEFT JOIN big LIMIT 100` takes 134 ms
 * against 1 ms, 1332 ms against 10 ms at OFFSET 2,000,000, and that is accepted for stable pages. Its order is total
 * over what is read: two rows of equal row numbers are the same output.
 *
 * WHAT IS GIVEN UP WHERE THE PROOF FAILS: the sort. A join the proof cannot bound may multiply (a self-join on a column
 * of few values, 100 billion joined rows: 74 s sorted, milliseconds not; docs/DESIGN.md "A top N over joined tables"), so
 * its rows are chosen on row numbers with no sort at all, inside or out: wide columns still stay out of the join, and
 * the statement still stops early. ITS PAGES CAN OVERLAP AGAIN, as they could before PR 118: a many-to-many join, a cross
 * join, a key in part, a table with no primary key and a join on an expression all pay this, and a tool that pages one
 * can see rows twice and others never. The rows of each answer are still rows of the join, each as often as the join
 * holds it: the proof decides the cost and the pages, never an answer, so the safe side of a proof that fails is no sort.
 *
 * `afterLimit` still needs a sort: the keys put its rows back, and a list of no key has none.
 *
 * Measured over a 4 M-row join with wide JSON in the last table (a 2 GB
 * limit): 12.9 s and 8.6 GiB spilled before, 0.19 s and none after; LIMIT 10,000 failed for memory before and takes 2.9 s.
 *
 * A row number is read only of a table, so a table with a column named `rowid` in any case, which DuckDB reads instead,
 * stays as it was. A `*` is written out from Postgres's own list of the table's columns, so the tables can be read
 * themselves (a copy's view of its visible columns, src/duck/kept-route.ts, has no row numbers); a whole row is not
 * listed, and stays as it was.
 *
 * EVERY FROM ITEM OF SUCH A JOIN IS ONE OF THREE (issue 134, step 2: a view, a WITH query, a tool's wrapper and a derived
 * side each carried every wide column through the join and the top N: 7.3 GiB spilled to keep 100 rows, or a failure):
 *
 *  - A TABLE, fetched by its row number as above.
 *  - A PLAIN DERIVED READ: a derived table, a view's definition or a WITH query read once and not MATERIALIZED, with
 *    only a projection and a WHERE over one table (`Derived.read`: Postgres's analysis says so, and a tree of that shape
 *    must agree), nothing volatile in it and nothing from outside. It exposes its row number, last so an alias's column
 *    names still fall on its own list, and is fetched by it, in its derived form and without its WHERE (the row
 *    passed it inside):
 *
 *      SELECT <the list as written> FROM (
 *        SELECT a.rowid AS __mason_r1, d.__mason_rid AS __mason_r2, <carried columns>, <sort keys> AS __mason_o<i>
 *        FROM a JOIN (SELECT <the derived list>, t.rowid AS __mason_rid FROM t WHERE …) AS d ON … WHERE … ORDER BY … LIMIT …
 *      ) AS __mason_late
 *      LEFT JOIN a ON a.rowid = __mason_late.__mason_r1
 *      LEFT JOIN (SELECT <the derived list>, t.rowid AS __mason_rid FROM t) AS d ON d.__mason_rid = __mason_late.__mason_r2
 *
 *    THE DERIVED FORM IS WHAT KEEPS A NULLABLE SIDE RIGHT: `LEFT JOIN (SELECT id, 1 AS one …)` must read NULL where nothing
 *    matched, and a NULL row number finds no row, so it does; flattened, it would read 1. DuckDB prunes what the join does
 *    not read from the inner derived list, so it reads the join's columns alone.
 *  - ANYTHING ELSE that is a derived read, CARRIED: an aggregate, a window, DISTINCT, a LIMIT, a set operation, a volatile
 *    function, a LATERAL, a WITH query read twice or MATERIALIZED, a join. No row number exists of it, so each column the
 *    list reads comes through the inner query as `__mason_c<i>`, unchanged, as it did before. A function or a VALUES list
 *    in the FROM is none of the three, and the statement stays as it was.
 *
 * A QUERY WHOSE ONE FROM ITEM IS A PROJECTION AND A WHERE OVER FROM ITEMS IS FOLDED INTO IT FIRST (`fold`: a view of a
 * join, `SELECT * FROM (<join>) t LIMIT 100`, a WITH query over a join, a view of a view), the way Postgres pulls a
 * subquery up: each column of the wrapper read as the expression it is, the WHEREs and'd. Nothing there is volatile, so
 * an expression read twice is one value; a wrapper's own output name or number is read before the folding, so a sort
 * means what it meant. A statement whose form this cannot write stays as it was, never half folded.
 *
 * WHAT IS GIVEN UP: a raising expression of a derived list now runs on the chosen rows alone (`limit-errors`). A role's
 * filtered read (src/duck/row-filter.ts) is no plain read and stays as it was: a statement with one keeps exactly its
 * form here (`tablesOnly`), because its barrier and its statistics wall need a review of their own.
 */
import type { TreeNode, TreeValue } from "./pgtree.ts";
import { fanOutBounded, projectionOnly } from "./distinct-key.ts";
import type { PrimaryKeys } from "./distinct-key.ts";

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

/** `rowWiseStatement`, with what a joined query carries set apart: a derived read beside another FROM item may hold
 *  anything, because its columns pass through unchanged. A wrapper of one item or a set operation's arm has no such side */
function rowWiseAround(tree: TreeValue): boolean {
  const flags = ["hasAggs", "hasWindowFuncs", "hasTargetSRFs", "hasSubLinks"];
  const query = (q: TreeNode): boolean => {
    if (flags.some((f) => q[f] !== "false")) return false;
    const rtable = (Array.isArray(q.rtable) ? q.rtable : []).filter((e): e is TreeNode => isTreeNode(e));
    const beside = q.setOperations === null && rtable.filter((e) => e.rtekind !== RTE_JOIN).length >= 2;
    const inner = [...rtable.flatMap((e) => isTreeNode(e.subquery) ? [e.subquery] : []),
      ...(Array.isArray(q.cteList) ? q.cteList : []).flatMap((c) => isTreeNode(c) && isTreeNode(c.ctequery) ? [c.ctequery] : [])];
    return inner.every((c) => beside || query(c));
  };
  return isTreeNode(tree) && tree._node === "QUERY" && query(tree);
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

/** what the plan knows beside the statement: which of a statement's functions are volatile (the catalog's pg_proc), and
 *  whether it holds a role's filtered reads */
export interface LateContext { volatile: (functions: number[]) => Promise<ReadonlySet<number>>; tablesOnly: boolean }
/** with no catalog to ask, every function is volatile: nothing is read twice */
const UNKNOWN: LateContext = { volatile: async (functions) => new Set(functions), tablesOnly: false };

/**
 * The statement with every sorted, limited SELECT written with its select list computed after its limit (see above),
 * or null where none is. `tree` is the rewrite's DuckDB tree, `analysis` Postgres's of the original, `keys` reads the
 * catalog's primary keys of the tables `fanOutTables` names: only for a statement this may write, so a tool's
 * `SELECT count(*) … JOIN … LIMIT 2000` costs no round trip to the catalog.
 */
export async function selectListAfterLimit(tree: AstNode, analysis: TreeValue, keys: () => Promise<PrimaryKeys>, context: LateContext = UNKNOWN): Promise<AstNode | null> {
  const strict = rowWiseStatement(analysis);
  if (!strict && (context.tablesOnly || !rowWiseAround(analysis))) return null;
  const volatile = context.tablesOnly ? new Set<number>() : await context.volatile(derivedFunctions(analysis));
  const relations = relationsOf(analysis, await keys(), volatile, context.tablesOnly);
  let changed = false;
  const written = (select: AstNode): AstNode | null => joinRows(select, relations, context.tablesOnly) ?? (strict ? afterLimit(select) : null);
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
      const late = written({ SelectStmt: body[arm] });
      if (late !== null) { body[arm] = bodyOf(late); changed = true; }
    }
    const late = written(out);
    if (late === null) return out;
    changed = true;
    return late;
  };
  const result = visit(tree) as AstNode;
  return changed ? result : null;
}

/** a SELECT with a LIMIT, each row one row of its FROM: its list and its sort, which may be none */
function limited(s: Body, withs = false): { targets: AstNode[]; sorts: AstNode[] } | null {
  if (s.op !== undefined && s.op !== "SETOP_NONE") return null;
  if (s.withClause !== undefined && (!withs || (s.withClause as Body).recursive === true)) return null;
  for (const f of ["distinctClause", "groupClause", "havingClause", "windowClause", "lockingClause", "intoClause", "valuesLists"]) {
    if (s[f] !== undefined && !(Array.isArray(s[f]) && (s[f] as unknown[]).length === 0)) return null;
  }
  if (s.limitCount === undefined || (s.limitOption !== undefined && s.limitOption !== "LIMIT_OPTION_COUNT" && s.limitOption !== "LIMIT_OPTION_DEFAULT")) return null;
  const targets = s.targetList as AstNode[] | undefined;
  if (targets === undefined) return null;
  return { targets, sorts: (s.sortClause as AstNode[] | undefined) ?? [] };
}

/** a limited SELECT that sorts: only one the keys alone put back in order may compute its list after the limit */
function sortedLimited(s: Body): { targets: AstNode[]; sorts: AstNode[] } | null {
  const shape = limited(s);
  return shape === null || shape.sorts.length === 0 ? null : shape;
}

/** LIMIT ALL and LIMIT NULL, which limit nothing: the parser's constant NULL, cast or not */
const noLimit = (n: unknown): boolean => kindOf(n) === "A_Const" ? bodyOf(n).isnull === true : kindOf(n) === "TypeCast" && noLimit(bodyOf(n).arg);

/** each sort key as an expression over the FROM clause, or null: an ordinal or an output column's name is that
 *  output's own expression, as Postgres reads it (an output name before an input column's), and a sort by a computed
 *  output computes it for every row anyway: nothing to defer, and a volatile one must stay one value */
function sortKeys(targets: AstNode[], sorts: AstNode[]): AstNode[] | null {
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

/** a table of a query's rtable: the name its columns are read by, and its columns */
interface Table { kind: "table"; alias: string; columns: string[] }
/** a derived table or a WITH query of a query's rtable. `read` is its query where it may be read twice, a projection
 *  and a WHERE with nothing volatile or from outside it; null, its columns are carried. `cte` names a WITH query that
 *  may stand in its place */
interface Derived { kind: "derived"; alias: string; columns: string[]; read: Query | null; cte: string | null }
/** a FROM item; null for one that is neither (a function, a VALUES list) */
type Relation = Table | Derived | null;
const RTE_RELATION = "0", RTE_SUBQUERY = "1", RTE_JOIN = "2", RTE_CTE = "6";
/** Postgres's first OID for an object not of its own (FirstNormalObjectId): below it, a catalog table, no copy */
const FIRST_USER_OID = 16384;
/** ctematerialized: CTEMaterializeAlways */
const MATERIALIZED = "1";

/** a query of the analysed statement: what it reads, FROM item by FROM item (a join itself is no item), whether its rows
 *  are proved bounded by its tables', and whether each of its rows is one row of its FROM */
interface Query { items: Relation[]; bounded: boolean; rowWise: boolean }

function isTreeNode(v: TreeValue | undefined): v is TreeNode { return typeof v === "object" && v !== null && !Array.isArray(v); }
const treeList = (v: TreeValue | undefined): TreeValue[] => Array.isArray(v) ? v : [];

/** every node of an analysed tree, its query's own and its subqueries' */
function walkTree(v: TreeValue | undefined, at: (n: TreeNode) => void): void {
  if (Array.isArray(v)) { for (const x of v) walkTree(x, at); return; }
  if (!isTreeNode(v)) return;
  at(v);
  for (const [k, x] of Object.entries(v)) if (k !== "_node") walkTree(x, at);
}

/** the functions a statement calls, and the operators', by OID, where a query with a LIMIT holds a derived read itself:
 *  none for any other (`SELECT … FROM (SELECT … LIMIT 10) s`), so it asks the catalog nothing */
function derivedFunctions(tree: TreeValue): number[] {
  const out = new Set<number>();
  let derived = false;
  walkTree(tree, (n) => {
    if (n._node === "QUERY" && n.limitCount !== null && n.limitCount !== undefined) {
      derived ||= treeList(n.rtable).some((e) => isTreeNode(e) && (e.rtekind === RTE_SUBQUERY || e.rtekind === RTE_CTE));
    }
    for (const id of [n._node === "FUNCEXPR" ? n.funcid : undefined, ["OPEXPR", "DISTINCTEXPR", "NULLIFEXPR", "SCALARARRAYOPEXPR"].includes(n._node as string) ? n.opfuncid : undefined]) {
      if (typeof id === "string" && Number(id) > 0) out.add(Number(id));
    }
  });
  return derived ? [...out].sort((a, b) => a - b) : [];
}

/** a query that may be read twice: a projection and a WHERE, nothing volatile, nothing of a query outside it */
function readTwice(q: TreeNode, volatile: ReadonlySet<number>): boolean {
  if (!projectionOnly(q)) return false;
  let ok = true;
  walkTree(q, (n) => {
    if (n._node === "VAR" && Number(n.varlevelsup ?? 0) > 0) ok = false;
    if (volatile.has(Number(n.funcid ?? 0)) || volatile.has(Number(n.opfuncid ?? 0))) ok = false;
  });
  return ok;
}

function relationsOf(analysis: TreeValue, keys: PrimaryKeys, volatile: ReadonlySet<number>, tablesOnly: boolean): Query[] {
  const out: Query[] = [];
  const queryOf = (q: TreeNode, enclosing: readonly TreeValue[][]): Query => {
    const scopes = [treeList(q.cteList), ...enclosing];
    const relation = (e: TreeNode): Relation => {
      const ref = e.eref as TreeNode | null;
      if (typeof ref?.aliasname !== "string" || !Array.isArray(ref.colnames)) return null;
      const alias = ref.aliasname, columns = ref.colnames.filter((c): c is string => typeof c === "string");
      if (e.rtekind === RTE_RELATION) return e.relkind === "r" && Number(e.relid) >= FIRST_USER_OID ? { kind: "table", alias, columns } : null;
      if (tablesOnly) return null;
      if (e.rtekind === RTE_SUBQUERY && isTreeNode(e.subquery)) {
        return { kind: "derived", alias, columns, cte: null, read: e.lateral !== "true" && readTwice(e.subquery, volatile) ? queryOf(e.subquery, scopes) : null };
      }
      if (e.rtekind !== RTE_CTE) return null;
      const level = scopes[Number(e.ctelevelsup)] ?? [];
      const cte = level.find((c): c is TreeNode => isTreeNode(c) && c.ctename === e.ctename);
      const once = cte !== undefined && cte.cterefcount === "1" && cte.ctematerialized !== MATERIALIZED && isTreeNode(cte.ctequery) && readTwice(cte.ctequery, volatile);
      return { kind: "derived", alias, columns, cte: once ? e.ctename as string : null, read: once ? queryOf(cte.ctequery as TreeNode, scopes.slice(Number(e.ctelevelsup))) : null };
    };
    const items = treeList(q.rtable).filter((e): e is TreeNode => isTreeNode(e) && e.rtekind !== RTE_JOIN).map(relation);
    return { items, bounded: fanOutBounded(q, keys), rowWise: ["hasAggs", "hasWindowFuncs", "hasTargetSRFs", "hasSubLinks"].every((f) => q[f] === "false") };
  };
  const visit = (v: TreeValue | undefined, enclosing: readonly TreeValue[][]): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x, enclosing); return; }
    if (!isTreeNode(v)) return;
    if (v._node === "QUERY" && Array.isArray(v.rtable)) out.push(queryOf(v, enclosing));
    const inner = v._node === "QUERY" ? [treeList(v.cteList), ...enclosing] : enclosing;
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x, inner);
  };
  visit(analysis, []);
  return out;
}

/** the FROM clause's items in order, or null where it holds anything but tables and derived tables joined on conditions */
function fromItems(from: unknown): AstNode[] | null {
  const items: AstNode[] = [];
  const walk = (n: unknown): boolean => {
    const k = kindOf(n);
    if (k === "RangeVar" || k === "RangeSubselect") { items.push(n as AstNode); return true; }
    if (k !== "JoinExpr") return false;
    const j = bodyOf(n);
    if (j.isNatural === true || j.usingClause !== undefined || j.alias !== undefined || j.join_using_alias !== undefined) return false;
    return walk(j.larg) && walk(j.rarg);
  };
  return Array.isArray(from) && from.every(walk) ? items : null;
}

/** the FROM clause with each item replaced, by its place in `fromItems`'s order */
function mapFrom(from: unknown[], f: (item: AstNode, at: number) => AstNode): unknown[] {
  let at = 0;
  const walk = (n: unknown): unknown => {
    if (kindOf(n) !== "JoinExpr") return f(n as AstNode, at++);
    const larg = walk(bodyOf(n).larg), rarg = walk(bodyOf(n).rarg);
    return { JoinExpr: { ...bodyOf(n), larg, rarg } };
  };
  return from.map(walk);
}

const aliasOfTable = (t: Body): string => isObject(t.alias) ? String(t.alias.aliasname) : String(t.relname);
const aliasOfItem = (n: AstNode): string | null => {
  const b = bodyOf(n);
  return kindOf(n) === "RangeVar" ? aliasOfTable(b) : isObject(b.alias) ? String(b.alias.aliasname) : null;
};
const rowNumber = (alias: string): AstNode => ref(alias, "rowid");
const ROW_ID = "__mason_rid";

const hasStarTarget = (t: AstNode): boolean => {
  const val = kindOf(t) === "ResTarget" ? bodyOf(t).val : null;
  return kindOf(val) === "ColumnRef" && kindOf((bodyOf(val).fields as unknown[]).at(-1)) === "A_Star";
};

/** a column's name in a ColumnRef's fields, each field a name; null for a star */
const fieldNames = (b: Body): Array<string | null> => (b.fields as unknown[]).map((f) => kindOf(f) === "String" ? bodyOf(f).sval as string : null);

/** a name no column of a statement has: what a rewrite binds inside an expression (a lambda's parameter) */
const ownName = (name: string): boolean => name.startsWith("__mason_");

/** an item as a select list reads it */
interface Listed { alias: string; columns: string[] }

/** the select list with every `*` written out; the tables it reads by name; null where it reads a whole row, or holds what the list after the limit may not */
function writtenOut(targets: AstNode[], tables: readonly Listed[], tablesAlone = true): { list: AstNode[]; read: Set<string> } | null {
  const aliases = new Set(tables.map((t) => t.alias));
  const read = new Set<string>();
  const list: AstNode[] = [];
  const reads = (n: unknown): boolean => {
    if (Array.isArray(n)) return n.every(reads);
    if (!isObject(n)) return true;
    if (kindOf(n) === "ColumnRef" && isObject(n.ColumnRef)) {
      const names = fieldNames(n.ColumnRef);
      if (names.length === 1) {
        // a bare name: of a table it does not say, unless it is a table's own name, a whole row
        const name = names[0];
        if (name === null || name === undefined || aliases.has(name)) return false;
        const owners = tablesAlone ? [] : tables.filter((t) => t.columns.includes(name));
        for (const t of owners.length > 0 ? owners : tables) read.add(t.alias);
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

/** the name a target is read by from outside its SELECT */
function outputName(t: AstNode): string | null {
  const b = bodyOf(t);
  if (typeof b.name === "string") return b.name;
  if (kindOf(b.val) !== "ColumnRef") return null;
  const last = (bodyOf(b.val).fields as unknown[]).at(-1);
  return kindOf(last) === "String" ? bodyOf(last).sval as string : null;
}

/** a SELECT that is a projection and a WHERE, as the rewrite left it */
function projection(b: Body): boolean {
  if (b.op !== undefined && b.op !== "SETOP_NONE") return false;
  return ["withClause", "distinctClause", "groupClause", "havingClause", "windowClause", "lockingClause", "intoClause", "valuesLists", "sortClause", "limitCount", "limitOffset"]
    .every((f) => b[f] === undefined || (Array.isArray(b[f]) && (b[f] as unknown[]).length === 0));
}

/** the WITH queries of a SELECT, by name; `used` collects the ones that took a read's place */
interface Withs { byName: Map<string, Body>; used: Set<string> }

function withsOf(s: Body): Withs {
  const ctes = isObject(s.withClause) && Array.isArray(s.withClause.ctes) ? s.withClause.ctes as AstNode[] : [];
  return { byName: new Map(ctes.map((c) => [String(bodyOf(c).ctename), bodyOf(c)])), used: new Set() };
}

/** a read of a WITH query, as the derived table it may be: the only reference to it, so it stands in the query's place */
function inlined(item: AstNode, relation: Relation, withs: Withs): AstNode {
  if (kindOf(item) !== "RangeVar" || relation?.kind !== "derived" || relation.cte === null) return item;
  const cte = withs.byName.get(relation.cte), b = bodyOf(item);
  if (cte === undefined || b.schemaname !== undefined || b.relname !== relation.cte || kindOf(cte.ctequery) !== "SelectStmt") return item;
  withs.used.add(relation.cte);
  const named = isObject(b.alias) ? b.alias : { aliasname: relation.cte };
  const columns = named.colnames ?? cte.aliascolnames;
  return { RangeSubselect: { subquery: structuredClone(cte.ctequery), alias: { ...named, ...(columns !== undefined ? { colnames: columns } : {}) } } };
}

/** the conjunction of two WHEREs, either of which may be none, flat as the parser reads it back */
function both(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const args = (n: unknown): unknown[] => kindOf(n) === "BoolExpr" && bodyOf(n).boolop === "AND_EXPR" ? bodyOf(n).args as unknown[] : [n];
  return { BoolExpr: { boolop: "AND_EXPR", args: [...args(a), ...args(b)] } };
}

/** one SELECT of one FROM item, a projection and a WHERE over FROM items, folded into it (see above): each column of the
 *  wrapper read as the expression it is; null where it cannot be */
function fold(s: Body, sub: Body, item: Derived): Body | null {
  const inner = item.read;
  if (inner === null || !projection(sub)) return null;
  const items = inner.items.filter((r): r is Table | Derived => r !== null);
  if (items.length !== inner.items.length) return null;
  const expanded = writtenOut(sub.targetList as AstNode[], items);
  if (expanded === null || expanded.list.length !== item.columns.length) return null;
  const values = expanded.list.map((t) => bodyOf(t).val);
  const byName = new Map<string, unknown>();
  item.columns.forEach((c, i) => byName.set(c, byName.has(c) ? null : values[i]));
  let whole = true;
  const over = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(over);
    if (!isObject(n)) return n;
    if (kindOf(n) === "ColumnRef" && isObject(n.ColumnRef)) {
      const names = fieldNames(n.ColumnRef);
      const column = names.length === 2 && names[0] === item.alias ? names[1] : names.length === 1 ? names[0] : null;
      if (typeof column === "string" && ownName(column)) return n;
      const value = typeof column === "string" ? byName.get(column) : undefined;
      if (value === undefined || value === null) { whole = false; return n; }
      return structuredClone(value);
    }
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, over(v)]));
  };
  const targets: AstNode[] = [];
  for (const t of s.targetList as AstNode[]) {
    if (kindOf(t) !== "ResTarget") return null;
    if (hasStarTarget(t)) {
      const fields = bodyOf(bodyOf(t).val).fields as unknown[];
      if (fields.length > 2 || (fields.length === 2 && bodyOf(fields[0]).sval !== item.alias)) return null;
      item.columns.forEach((c, i) => targets.push({ ResTarget: { name: c, val: structuredClone(values[i]) } }));
      continue;
    }
    const name = outputName(t);
    targets.push({ ResTarget: { ...bodyOf(t), ...(name !== null ? { name } : {}), val: over(bodyOf(t).val) } });
  }
  // an output's number or bare name is read by `sortKeys` from the list; any other key is over the wrapper's columns
  const outputs = new Set(targets.map(outputName));
  const sorts = ((s.sortClause as AstNode[] | undefined) ?? []).map((sort) => {
    const node = bodyOf(sort).node;
    const bare = kindOf(node) === "ColumnRef" && (bodyOf(node).fields as unknown[]).length === 1 ? fieldNames(bodyOf(node))[0] : null;
    return kindOf(node) === "A_Const" || (bare !== null && bare !== undefined && outputs.has(bare)) ? sort : { SortBy: { ...bodyOf(sort), node: over(node) } };
  });
  const where = over(s.whereClause);
  if (!whole) return null;
  const { whereClause: _w, sortClause: _s, ...rest } = s;
  const joined = both(sub.whereClause, where);
  return { ...rest, targetList: targets, fromClause: sub.fromClause, ...(joined !== undefined ? { whereClause: joined } : {}), ...(sorts.length > 0 ? { sortClause: sorts } : {}) };
}

/** a SELECT's FROM read as its query's items: its WITH queries in place of their one read and, while its one item is a
 *  derived read, folded into it; null where the tree and the analysis do not agree or a wrapper does not fold */
function unwrapped(s: Body, query: Query, withs: Withs): { s: Body; query: Query } | null {
  for (let body = s, q = query; ;) {
    const items = fromItems(body.fromClause);
    if (items === null || items.length !== q.items.length || items.some((n, i) => aliasOfItem(n) !== q.items[i]?.alias)) return null;
    const placed = { ...body, fromClause: mapFrom(body.fromClause as unknown[], (n, i) => inlined(n, q.items[i]!, withs)) };
    const one = items.length === 1 ? q.items[0]! : null;
    const item = fromItems(placed.fromClause)![0]!;
    if (one?.kind !== "derived" || one.read === null || kindOf(item) !== "RangeSubselect") return { s: placed, query: q };
    const folded = fold(placed, bodyOf(bodyOf(item).subquery), one);
    if (folded === null) return null;
    body = folded; q = one.read;
  }
}

/** a plain derived read as the join reads it: `body` with `read` as the projection, over its one table */
interface PlainSide { body: Body; table: Body; list: AstNode[] }

/** a derived item that is a plain read of one table in the tree too (the rewrite may have written it otherwise), or null */
function plainSide(item: AstNode, relation: Derived, withs: Withs): PlainSide | null {
  if (relation.read === null || kindOf(item) !== "RangeSubselect") return null;
  const sub = bodyOf(item).subquery;
  if (kindOf(sub) !== "SelectStmt" || bodyOf(item).lateral === true) return null;
  // a WITH query taken only if this read is: one that stays carried reads what it always read
  const trial: Withs = { byName: withs.byName, used: new Set() };
  const opened = unwrapped(bodyOf(sub), relation.read, trial);
  if (opened === null || !projection(opened.s)) return null;
  const [table] = opened.query.items, from = opened.s.fromClause as unknown[];
  if (opened.query.items.length !== 1 || table?.kind !== "table" || from.length !== 1 || kindOf(from[0]) !== "RangeVar") return null;
  if (table.columns.some((c) => c === "" || c.toLowerCase() === "rowid")) return null;
  const written = writtenOut(opened.s.targetList as AstNode[], [table]);
  // a whole row in the WHERE lists what a read of the table itself shows and its view of visible columns does not
  if (written === null || !writtenOut([{ ResTarget: { val: opened.s.whereClause ?? { A_Const: { isnull: true } } } }], [table])) return null;
  for (const name of trial.used) withs.used.add(name);
  return { body: opened.s, table: bodyOf(from[0]), list: written.list };
}

/** a table read itself: a row number is no column of a copy's view, and nothing here lists a column that is not named */
function ownTable(t: Body): AstNode { const { catalogname: _c, ...rest } = t; return { RangeVar: structuredClone(rest) }; }

/** a plain side as a FROM item: the query it was, each row exposing its row number */
function exposed(side: PlainSide, alias: Body, where: boolean): AstNode {
  const { whereClause, ...rest } = side.body;
  return { RangeSubselect: { alias: structuredClone(alias), subquery: { SelectStmt: structuredClone({ ...rest,
    targetList: [...side.list, { ResTarget: { name: ROW_ID, val: rowNumber(aliasOfTable(side.table)) } }],
    fromClause: [ownTable(side.table)],
    ...(where && whereClause !== undefined ? { whereClause } : {}) }) } } };
}

/** the same tree with every column of a carried item replaced by `__mason_late.__mason_c<i>`, which `columns` names */
function overCarried(n: unknown, carried: readonly Listed[], columns: Map<string, { name: string; val: AstNode }>): unknown {
  if (Array.isArray(n)) return n.map((x) => overCarried(x, carried, columns));
  if (!isObject(n)) return n;
  if (kindOf(n) === "ColumnRef" && isObject(n.ColumnRef)) {
    const names = fieldNames(n.ColumnRef);
    const column = names.at(-1);
    const owner = names.length === 1 ? carried.find((c) => c.columns.includes(String(column))) : carried.find((c) => c.alias === names.at(-2));
    if (owner === undefined || typeof column !== "string") return n;
    const key = `${owner.alias}.${column}`;
    let at = columns.get(key);
    if (at === undefined) { at = { name: `__mason_c${columns.size + 1}`, val: ref(owner.alias, column) }; columns.set(key, at); }
    return ref(LATE, at.name);
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, overCarried(v, carried, columns)]));
}

/** one SELECT over joined FROM items written with its rows chosen by row number (see above), or null where it is not so shaped */
function joinRows(select: AstNode, relations: Query[], tablesOnly: boolean): AstNode | null {
  const written0 = bodyOf(select);
  const shape0 = limited(written0, !tablesOnly);
  if (shape0 === null) return null;
  // no sort and in fact no limit: every row comes back, and reading each one again saves nothing
  if (shape0.sorts.length === 0 && noLimit(written0.limitCount)) return null;
  // the rewrite wrote a column number beside a `*` as the column it is (namedThroughStar); one left a number is a computed
  // output, past this list's own numbering
  if (shape0.targets.some((t) => hasStarTarget(t)) && shape0.sorts.some((sort) => kindOf(bodyOf(sort).node) === "A_Const")) return null;
  const items0 = fromItems(written0.fromClause);
  if (items0 === null) return null;
  const aliases0 = items0.map(aliasOfItem);
  // the query of the analysis this SELECT is: its FROM items, in order. Two queries alike must agree, or which is unsure
  const named = relations.filter((q) => q.items.length === aliases0.length && q.items.every((t, i) => t?.alias === aliases0[i]));
  const first = named[0];
  if (first === undefined || named.some((q) => JSON.stringify(q.items) !== JSON.stringify(first.items) || !q.rowWise)) return null;
  const withs = withsOf(written0);
  const opened = unwrapped(written0, first, withs);
  if (opened === null) return null;
  const { s, query } = opened;
  const items = fromItems(s.fromClause)!;
  if (items.length < 2) return null;
  const aliases = items.map(aliasOfItem);
  if (new Set(aliases).size !== aliases.length) return null;
  const relation = query.items as Array<Table | Derived | null>;
  if (relation.some((r) => r === null)) return null;
  const listed = relation as Array<Table | Derived>;
  // DuckDB binds a name without regard to case: "RowId" hides the row number as rowid does
  if (listed.some((t) => t.kind === "table" && t.columns.some((c) => c === "" || c.toLowerCase() === "rowid"))) return null;
  const sides = items.map((n, i) => { const r = listed[i]!; return r.kind === "derived" ? plainSide(n, r, withs) : null; });
  // what a list reads of a derived item is read by name: two of one name (in any case) cannot be told apart
  const carried = listed.filter((r, i) => r.kind === "derived" && sides[i] === null);
  if (listed.some((r) => r.kind === "derived" && new Set(r.columns.map((c) => c.toLowerCase())).size !== r.columns.length)) return null;
  const written = writtenOut(s.targetList as AstNode[], listed, listed.every((r) => r.kind === "table"));
  if (written === null) return null;
  const keys = sortKeys(s.targetList as AstNode[], (s.sortClause as AstNode[] | undefined) ?? []);
  if (keys === null) return null;
  const sorts = (s.sortClause as AstNode[] | undefined) ?? [];
  const isFetched = (i: number): boolean => written.read.has(aliases[i]!) && (listed[i]!.kind === "table" || sides[i] !== null);
  const fetched = items.flatMap((n, i) => isFetched(i) ? [{ node: n, at: i, alias: aliases[i]!, id: listed[i]!.kind === "table" ? rowNumber(aliases[i]!) : ref(aliases[i]!, ROW_ID) }] : []);
  if (fetched.length === 0) return null;
  const columns = new Map<string, { name: string; val: AstNode }>();
  const list = written.list.map((t) => ({ ResTarget: { ...bodyOf(t), val: overCarried(bodyOf(t).val, carried, columns) } }));
  const from = mapFrom(s.fromClause as unknown[], (n, i) => {
    const side = sides[i];
    if (side !== null && side !== undefined) return isFetched(i) ? exposed(side, bodyOf(n).alias as Body, true) : { RangeSubselect: { ...bodyOf(n), subquery: { SelectStmt: side.body } } };
    return kindOf(n) === "RangeVar" && listed[i]!.kind === "table" ? ownTable(bodyOf(n)) : n;
  });
  // no sort of its own: the row numbers are the order where the join is proved bounded, so a page of the statement is
  // one page of one list; otherwise none, or a join that multiplies is run whole. Two queries alike must both be proved.
  // What is carried has no row number, so with one (a keyed WITH query read twice) they would be no total order
  const pagedInOrder = sorts.length === 0 && carried.length === 0 && (query === first ? named.every((q) => q.bounded) : query.bounded);
  const order = (node: AstNode): AstNode => ({ SortBy: { node, sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } });
  const { withClause: _with, ...body } = s;
  const left = isObject(s.withClause) ? (s.withClause.ctes as AstNode[]).filter((c) => !withs.used.has(String(bodyOf(c).ctename))) : [];
  const inner: Body = { ...body, ...(left.length > 0 ? { withClause: { ...s.withClause as Body, ctes: left } } : {}), fromClause: from, targetList: [
    ...fetched.map((t, i) => ({ ResTarget: { name: `__mason_r${i + 1}`, val: t.id } })),
    ...[...columns.values()].map((c) => ({ ResTarget: { name: c.name, val: c.val } })),
    ...keys.map((k, i) => ({ ResTarget: { name: `__mason_o${i + 1}`, val: k } })),
  ],
  ...(sorts.length > 0 ? { sortClause: sorts.map((sort, i) => ({ SortBy: { ...bodyOf(sort), node: keys[i] } })) } : pagedInOrder ? { sortClause: fetched.map((t) => order(structuredClone(t.id))) } : {}) };
  let joined: AstNode = { RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: LATE } } };
  fetched.forEach((t, i) => {
    const side = sides[t.at];
    joined = { JoinExpr: { jointype: "JOIN_LEFT", larg: joined, rarg: side !== null && side !== undefined ? exposed(side, bodyOf(t.node).alias as Body, false) : ownTable(bodyOf(t.node)), quals: { A_Expr: {
      kind: "AEXPR_OP", name: [S("=")], lexpr: structuredClone(t.id), rexpr: ref(LATE, `__mason_r${i + 1}`) } } } };
  });
  return { SelectStmt: {
    targetList: list,
    fromClause: [joined],
    ...(sorts.length > 0 ? { sortClause: sorts.map((sort, i) => ({ SortBy: { ...bodyOf(sort), node: ref(LATE, `__mason_o${i + 1}`) } })) }
      : pagedInOrder ? { sortClause: fetched.map((_t, i) => order(ref(LATE, `__mason_r${i + 1}`))) } : {}),
    limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
  } };
}
