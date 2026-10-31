/**
 * POSTGRES'S OWN ANALYSIS OF A STATEMENT, READ (docs/DESIGN.md "Postgres decides, DuckDB computes"). The
 * catalog Postgres (src/api/postgres/catalog.ts) holds every copied table under its source types; with
 * `debug_print_parse` on it logs the ANALYSED query tree of a statement it parses — every expression with the type
 * Postgres resolved for it (the operator it chose, the implicit casts it inserted, an aggregate's result type) and the
 * offset into the text it came from. This module reads that tree (Postgres's `outfuncs.c` node format) and indexes it
 * by offset, so the rewrite (src/duck/rewrite.ts) knows, for each node of the RAW parse tree it rewrites, what
 * Postgres made of it: `/` over a `sum(bigint)` is a numeric division, `round(x)` of a double precision is `rint`, a
 * text sort key sorts by the database's collation.
 *
 * The format: `{NODE :field value …}`; a value is a node, a list `( … )` (of nodes or of values; `(b …)` a bitmapset,
 * `(o …)` OIDs, `(i …)` ints), `<>` for NULL, a quoted string, a bare token (outToken backslash-escapes the
 * characters that would end one), or a datum `N [ b b … ]` (a Const's value).
 */

export type TreeValue = TreeNode | TreeValue[] | string | null;
export interface TreeNode { readonly _node: string; readonly [field: string]: TreeValue }

/** Parses one node-format text (outfuncs.c's nodeToString), or throws with the offset where it went wrong. */
export function parseTree(text: string): TreeValue {
  let i = 0;
  const ws = (): void => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const fail = (what: string): never => { throw new Error(`the catalog Postgres's parse tree: ${what} at offset ${i}: ${JSON.stringify(text.slice(i, i + 40))}`); };
  const bare = (): string => {
    let s = "";
    while (i < text.length && !/[\s(){}]/.test(text[i]!)) {
      if (text[i] === "\\" && i + 1 < text.length) { s += text[i + 1]; i += 2; continue; }
      s += text[i++];
    }
    return s;
  };
  const value = (): TreeValue => {
    ws();
    const c = text[i];
    if (c === undefined) return fail("the text ends inside a value");
    if (c === "{") return node();
    if (c === "(") {
      i++;
      const out: TreeValue[] = [];
      for (;;) {
        ws();
        if (text[i] === ")") { i++; return out; }
        if (i >= text.length) return fail("a list is not closed");
        out.push(value());
      }
    }
    if (c === "<" && text[i + 1] === ">") { i += 2; return null; }
    if (c === '"') {
      i++;
      let s = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) { s += text[i + 1]; i += 2; continue; }
        s += text[i++];
      }
      i++;
      return s;
    }
    const tok = bare();
    // a datum: its length, then its bytes in brackets
    const save = i;
    ws();
    if (text[i] === "[") {
      const end = text.indexOf("]", i);
      if (end < 0) return fail("a datum is not closed");
      const datum = `${tok} ${text.slice(i, end + 1)}`;
      i = end + 1;
      return datum;
    }
    i = save;
    return tok;
  };
  const node = (): TreeNode => {
    i++; // {
    ws();
    const name = bare();
    const out: Record<string, TreeValue> = { _node: name };
    for (;;) {
      ws();
      if (text[i] === "}") { i++; return out as TreeNode; }
      if (text[i] !== ":") return fail(`a field of ${name} must start with ':'`);
      i++;
      const field = bare();
      out[field] = value();
    }
  };
  const v = value();
  ws();
  if (i < text.length) fail("text after the tree");
  return v;
}

const isNode = (v: TreeValue): v is TreeNode => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: TreeValue | undefined): number | null => typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;

/** What Postgres made of one expression: its node, its result type (OID) and typmod, its arguments' types, and the
 *  operator, function or aggregate it resolved to. */
export interface Typed {
  node: string;
  type: number;
  typmod: number;
  args: Array<{ type: number; typmod: number }>;
  /** OPEXPR's opno, FUNCEXPR's funcid, AGGREF's aggfnoid, WINDOWFUNC's winfnoid */
  oid: number | null;
  /** FUNCEXPR's funcformat: 0 a call, 1 an explicit cast, 2 an implicit cast, 3 SQL syntax (EXTRACT …) */
  format: number | null;
  /** the collation the expression's result carries (0 for none), and the one its inputs were compared under */
  collation: number;
  inputCollation: number;
  /** a VAR's query level: 0 this query's own column, 1 the query around it (a correlated subquery's) */
  levelsUp: number | null;
  /** a CONST's value as Postgres parsed it, its bytes (`constvalue`: `8 [ 0 -48 70 … ]`); null when NULL or not a CONST */
  datum: number[] | null;
  /** a VAR's FROM item by the name the query calls it (`u` in `FROM ua u`), when another FROM item of its query has a
   *  column of the same name but another case (`email` beside `"Email"`), its own or a subquery's it is read from: DuckDB binds names case-insensitively, so
   *  the bare name is ambiguous there and is qualified (src/duck/rewrite.ts) */
  qualifier: string | null;
  /** a VAR's column renamed (`t__mason_3`) where its FROM item — a subquery, a CTE — has another column of the same
   *  name but another case (`"T"` beside `t`), which DuckDB cannot tell apart: the item's columns are renamed alike
   *  (caseTwins) */
  renamed: string | null;
  /** a VAR as DuckDB can name it: the FROM item it is read from and the column's name there (an alias list's); a merged
   *  column of a join by the join's name, or null for that of a join (or a VALUES, a subquery) with none, which only its
   *  bare name reads. A join's name hides what it joins, so a column of a named join is read by that name, and `twin`
   *  says the join has two of that name, which no name tells apart. What a `*` expands to has no text of its own to read
   *  this from. Absent for a set operation's output, which only its arm's column names */
  column?: { owner: string | null; name: string; twin?: true };
  /** a VAR read from a TABLE of its query's FROM (an RTE_RELATION): the catalog's OID of that table and the column's
   *  number in it — what a stored JSON path is found by (src/duck/kept.ts); absent for any other node, and for a column
   *  of a subquery, a CTE, a function or a join */
  relation?: { relid: number; attno: number };
  /** a VAR read from a FUNCTION of its query's FROM (an RTE_FUNCTION): the function's FROM name and the column's name
   *  there. A function of one column that is no row (`jsonb_array_elements(x) e`, its column `value`) is read whole
   *  by its FROM name alone (`e`), which Postgres analyses as that column (makeWholeRowVar): a one-part name that is
   *  not the column's is that whole row (src/duck/rewrite.ts) */
  functionColumn?: { alias: string; column: string };
}

/** a `constvalue`'s bytes: `<length> [ b0 b1 … ]`, each a signed byte */
export function datumBytes(v: TreeValue | undefined): number[] | null {
  if (typeof v !== "string") return null;
  const m = /^\s*\d+\s*\[([-\d\s]*)\]\s*$/.exec(v);
  return m ? m[1]!.trim().split(/\s+/).filter((x) => x !== "").map((x) => Number(x) & 255) : null;
}

const BOOL = 16;
/** The type an expression node yields: exprType (nodeFuncs.c), for the nodes a SELECT's expressions are made of. */
export function exprType(n: TreeNode): { type: number; typmod: number } | null {
  const t = (f: string, m?: string): { type: number; typmod: number } | null => {
    const v = num(n[f]);
    return v === null ? null : { type: v, typmod: m === undefined ? -1 : num(n[m]) ?? -1 };
  };
  switch (n._node) {
    case "VAR": return t("vartype", "vartypmod");
    case "CONST": return t("consttype", "consttypmod");
    case "PARAM": return t("paramtype", "paramtypmod");
    case "AGGREF": return t("aggtype");
    case "WINDOWFUNC": return t("wintype");
    case "FUNCEXPR": {
      const r = t("funcresulttype");
      // a length coercion (numeric(p, s), varchar(n)) carries its typmod as its second argument's constant
      if (r && num(n.funcformat) !== 0 && Array.isArray(n.args) && n.args.length >= 2 && isNode(n.args[1]!) && n.args[1]._node === "CONST") {
        const datum = n.args[1].constvalue;
        // the bytes as debug_print_parse wraps them: any whitespace, a line break included (`4 [\n2 0 0 0 ]`)
        const m = typeof datum === "string" ? /\[\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\]/.exec(datum) : null;
        if (m) r.typmod = (Number(m[1]) & 255) | ((Number(m[2]) & 255) << 8) | ((Number(m[3]) & 255) << 16) | ((Number(m[4]) & 255) << 24);
      }
      return r;
    }
    case "OPEXPR": case "DISTINCTEXPR": case "NULLIFEXPR": return n._node === "DISTINCTEXPR" ? { type: BOOL, typmod: -1 } : t("opresulttype");
    case "SCALARARRAYOPEXPR": case "BOOLEXPR": case "NULLTEST": case "BOOLEANTEST": return { type: BOOL, typmod: -1 };
    case "RELABELTYPE": case "COERCEVIAIO": case "ARRAYCOERCEEXPR": case "COERCETODOMAIN": return t("resulttype", "resulttypmod");
    case "CASEEXPR": return t("casetype");
    case "COALESCEEXPR": return t("coalescetype");
    case "MINMAXEXPR": return t("minmaxtype");
    case "SQLVALUEFUNCTION": return t("type", "typmod");
    case "FIELDSELECT": return t("resulttype", "resulttypmod");
    case "SUBSCRIPTINGREF": return t("refrestype", "reftypmod");
    case "ARRAYEXPR": return t("array_typeid");
    case "ROWEXPR": return t("row_typeid");
    case "COLLATEEXPR": return Array.isArray(n.arg) ? null : isNode(n.arg ?? null) ? exprType(n.arg as TreeNode) : null;
    case "SUBLINK": {
      // an EXPR or ARRAY sublink's type is its subselect's first output column's
      const sub = n.subselect;
      if (!isNode(sub ?? null)) return null;
      const tl = (sub as TreeNode).targetList;
      const first = Array.isArray(tl) ? tl.find((e) => isNode(e) && e.resjunk !== "true") as TreeNode | undefined : undefined;
      const st = first && isNode(first.expr ?? null) ? exprType(first.expr as TreeNode) : null;
      const kind = num(n.subLinkType);
      return kind === 4 /* EXPR */ ? st : kind === 5 /* ARRAY */ ? null : { type: BOOL, typmod: -1 };
    }
    default: return null;
  }
}

const argsOf = (n: TreeNode): TreeValue[] => {
  if (Array.isArray(n.args)) return n.args;
  if (isNode(n.arg ?? null)) return [n.arg as TreeNode];
  return [];
};

/**
 * Every typed expression of the analysed tree, by the offset it came from — outermost first where several share one
 * (a cast and the coercion inside it). An implicit cast Postgres inserted has no offset of its own (-1) and is listed
 * only as its parent's argument type. AGGREF's arguments are its TARGETENTRY exprs.
 */
export function typesByLocation(tree: TreeValue): Map<number, Typed[]> {
  const out = new Map<number, Typed[]>();
  // the range tables of the queries around the node being visited, innermost last
  const rtables: TreeNode[][] = [];
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY") {
      rtables.push(Array.isArray(v.rtable) ? v.rtable.filter(isNode) : []);
      try { for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x); } finally { rtables.pop(); }
      return;
    }
    const loc = num(v.location);
    const t = exprType(v);
    if (loc !== null && loc >= 0 && t !== null) {
      const typed = typedOf(v, t, rtables);
      const list = out.get(loc);
      if (list) list.push(typed); else out.set(loc, [typed]);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

/** one expression of a query whose range tables are `rtables`, innermost last, as `Typed` says it */
function typedOf(v: TreeNode, t: { type: number; typmod: number }, rtables: TreeNode[][]): Typed {
  const raw = v._node === "AGGREF" || v._node === "WINDOWFUNC"
    ? argsOf(v).map((a) => isNode(a) && a._node === "TARGETENTRY" ? a.expr ?? null : a)
    : argsOf(v);
  const args = raw.filter(isNode).map((a) => exprType(a) ?? { type: 0, typmod: -1 });
  const typed: Typed = {
    node: v._node, type: t.type, typmod: t.typmod, args,
    oid: num(v.opno ?? v.funcid ?? v.aggfnoid ?? v.winfnoid ?? null),
    format: num(v.funcformat ?? null),
    collation: num(v.opcollid ?? v.funccollid ?? v.aggcollid ?? v.wincollid ?? v.varcollid ?? v.constcollid ?? v.collid ?? null) ?? 0,
    inputCollation: num(v.inputcollid ?? null) ?? 0,
    levelsUp: v._node === "VAR" ? num(v.varlevelsup ?? null) : null,
    datum: v._node === "CONST" && v.constisnull !== "true" ? datumBytes(v.constvalue) : null,
    qualifier: v._node === "VAR" ? qualifierOf(v, rtables) : null,
    renamed: v._node === "VAR" ? renamedOf(v, rtables) : null,
  };
  const relation = v._node === "VAR" ? relationOf(v, rtables) : null;
  if (relation !== null) typed.relation = relation;
  const column = v._node === "VAR" ? columnOf(v, rtables) : null;
  if (column !== null) typed.column = column;
  const fromFunction = v._node === "VAR" ? functionColumnOf(v, rtables) : null;
  if (fromFunction !== null) typed.functionColumn = fromFunction;
  return typed;
}

/** The output columns of one query, as its `targetList` numbers them. */
export interface QueryOutputs {
  /** each output in order: what it reads, a grouped column as the column it groups; null for an expression */
  columns: Array<Typed | null>;
  /** how many columns a `t.*` lists, by the FROM item's name */
  widths: Map<string, number>;
}

/**
 * Each SELECT's outputs, found by any offset its targets hold. THE ORDER OF A `*` IS ITS QUERY'S `targetList`, NEVER THE
 * ORDER ITS VARS ARE MET IN THE TREE: under a GROUP BY (Postgres 17+) a key's output is a VAR of the RTE_GROUP entry at
 * no offset, and the column it groups is in that entry's `groupexprs`, which comes first and in the GROUP BY's order. So
 * the offset of a star says nothing of which of its columns is which; a set operation's own outputs are left out, as
 * they carry its first SELECT's offsets.
 */
export function outputsByLocation(tree: TreeValue): Map<number, QueryOutputs> {
  const found = new Map<number, QueryOutputs>();
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY" && Array.isArray(v.targetList) && !isNode(v.setOperations ?? null)) {
      const rtable = Array.isArray(v.rtable) ? v.rtable.filter(isNode) : [];
      const entries = v.targetList.filter(isNode).filter((t) => t.resjunk !== "true");
      const exprs = entries.map((t) => ungrouped(t.expr ?? null, rtable));
      const widths = new Map<string, number>();
      for (const rte of rtable) {
        const eref = rte.eref ?? null;
        if (isNode(eref) && typeof eref.aliasname === "string" && !widths.has(eref.aliasname)) widths.set(eref.aliasname, strings(eref.colnames).filter((c) => c !== "").length);
      }
      const outputs: QueryOutputs = {
        columns: exprs.map((e) => { const t = isNode(e) && e._node === "VAR" ? exprType(e) : null; return t === null ? null : typedOf(e as TreeNode, t, [rtable]); }),
        widths,
      };
      const offsets = (x: TreeValue): void => {
        if (Array.isArray(x)) { x.forEach(offsets); return; }
        if (!isNode(x)) return;
        const loc = num(x.location);
        if (loc !== null && loc >= 0 && !found.has(loc)) found.set(loc, outputs);
        const inner = ungrouped(x, rtable);
        if (inner !== x) { offsets(inner); return; }
        for (const [k, y] of Object.entries(x)) if (k !== "_node") offsets(y);
      };
      offsets(exprs);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return found;
}

/** an output as what it reads: a VAR of the query's RTE_GROUP is the expression it groups */
function ungrouped(v: TreeValue, rtable: TreeNode[]): TreeValue {
  if (!isNode(v) || v._node !== "VAR") return v;
  const rte = rtable[(num(v.varno ?? null) ?? 0) - 1];
  const exprs = rte !== undefined && num(rte.rtekind ?? null) === RTE_GROUP ? rte.groupexprs : undefined;
  return Array.isArray(exprs) ? exprs[(num(v.varattno ?? null) ?? 0) - 1] ?? v : v;
}

const RTE_JOIN = 2;
const RTE_GROUP = 9;
const RTE_RELATION = 0;
/** the FROM items whose name in the analysis (`unnamed_join`, `*VALUES*`, `unnamed_subquery`) no statement can say:
 *  RTE_SUBQUERY, RTE_JOIN, RTE_VALUES */
const UNNAMED = new Set([1, RTE_JOIN, 5]);

/** Typed.relation: the table a VAR's FROM item is, by the catalog's OID, and the column's number in it */
function relationOf(v: TreeNode, rtables: TreeNode[][]): { relid: number; attno: number } | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  const relid = rte === undefined ? null : num(rte.relid ?? null);
  return rte === undefined || attno === null || attno < 1 || num(rte.rtekind ?? null) !== RTE_RELATION || relid === null || relid === 0 ? null : { relid, attno };
}
/** Typed.column */
function columnOf(v: TreeNode, rtables: TreeNode[][]): NonNullable<Typed["column"]> | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varnosyn ?? null), attno = num(v.varattnosyn ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  if (rte === undefined || attno === null || attno < 1 || !isNode(rte.eref ?? null)) return null;
  const eref = rte.eref as TreeNode;
  const columns = strings(eref.colnames), name = columns[attno - 1];
  if (name === undefined || typeof eref.aliasname !== "string" || /^\*SELECT\* \d+$/.test(eref.aliasname)) return null;
  const kind = num(rte.rtekind ?? null) ?? -1;
  const named = isNode(rte.alias ?? null);
  return { owner: UNNAMED.has(kind) && !named ? null : eref.aliasname, name,
    ...(kind === RTE_JOIN && named && columns.filter((c) => c === name).length > 1 ? { twin: true as const } : {}) };
}
const RTE_FUNCTION = 3;
/** Typed.functionColumn */
function functionColumnOf(v: TreeNode, rtables: TreeNode[][]): { alias: string; column: string } | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  if (rte === undefined || attno === null || attno < 1 || num(rte.rtekind ?? null) !== RTE_FUNCTION || !isNode(rte.eref ?? null)) return null;
  const eref = rte.eref as TreeNode;
  const column = strings(eref.colnames)[attno - 1];
  return typeof eref.aliasname === "string" && column !== undefined ? { alias: eref.aliasname, column } : null;
}
const strings = (v: TreeValue | undefined): string[] => Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : "") : [];
/** Typed.qualifier: the name of a VAR's FROM item when another FROM item of its query has the column in another case,
 *  or when the VAR is an outer query's (a correlated subquery's bare `i4`, which DuckDB binds to the subquery's own
 *  output name `i4` first and refuses, 42703) */
function qualifierOf(v: TreeNode, rtables: TreeNode[][]): string | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rtable = rtables[rtables.length - 1 - up];
  if (rtable === undefined || varno === null || attno === null || attno < 1) return null;
  const rte = rtable[varno - 1];
  const eref = rte !== undefined && isNode(rte.eref ?? null) ? rte.eref as TreeNode : null;
  if (rte === undefined || eref === null || num(rte.rtekind ?? null) === RTE_JOIN) return null;
  const alias = typeof eref.aliasname === "string" ? eref.aliasname : null;
  const column = strings(eref.colnames)[attno - 1];
  // a name the query cannot spell (an unnamed subquery, a VALUES list) cannot qualify anything
  if (alias === null || column === undefined || alias === "unnamed_subquery" || alias === "*VALUES*") return null;
  const lower = column.toLowerCase();
  // a FROM item of its own query, or of a query inside it the VAR is read from (a correlated subquery's, which DuckDB's
  // binder looks in first)
  const clash = rtables.slice(rtables.length - 1 - up).flat().some((other) => other !== rte && num(other.rtekind ?? null) !== RTE_JOIN
    && isNode(other.eref ?? null) && strings((other.eref as TreeNode).colnames).some((c) => c !== column && c.toLowerCase() === lower));
  // an outer column is qualified unless a query inside has a FROM item of the same name (the name would be that one)
  const outer = up > 0 && !rtables.slice(rtables.length - up).flat().some((other) => isNode(other.eref ?? null)
    && String((other.eref as TreeNode).aliasname ?? "").toLowerCase() === alias.toLowerCase());
  return clash || outer ? alias : null;
}

/** a FROM item's columns with each one that has a twin in another case renamed `<name>__mason_<n>`; null when none has */
function twinNames(rte: TreeNode): string[] | null {
  if (num(rte.rtekind ?? null) === RTE_JOIN || num(rte.rtekind ?? null) === 0 || !isNode(rte.eref ?? null)) return null;
  const cols = strings((rte.eref as TreeNode).colnames);
  const lower = cols.map((c) => c.toLowerCase());
  const twin = (i: number): boolean => lower.some((l, j) => j !== i && l === lower[i] && cols[j] !== cols[i]);
  return cols.some((_, i) => twin(i)) ? cols.map((c, i) => twin(i) ? `${c}__mason_${i + 1}` : c) : null;
}

/** Typed.renamed */
function renamedOf(v: TreeNode, rtables: TreeNode[][]): string | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  if (rte === undefined || attno === null || attno < 1) return null;
  const names = twinNames(rte);
  const own = isNode(rte.eref ?? null) ? strings((rte.eref as TreeNode).colnames)[attno - 1] : undefined;
  return names !== null && names[attno - 1] !== own ? names[attno - 1] ?? null : null;
}

/** Every subquery or CTE read in FROM whose columns have twins in another case (`"T"` beside `t`), by the name the
 *  query calls it: its columns as DuckDB is to name them (twinNames), every reference renamed alike (Typed.renamed) */
export function caseTwins(tree: TreeValue): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "RANGETBLENTRY" && isNode(v.eref ?? null)) {
      const names = twinNames(v);
      const alias = (v.eref as TreeNode).aliasname;
      if (names !== null && typeof alias === "string") out.set(alias, names);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

/**
 * Whether a JOIN … USING or a NATURAL JOIN of the analysed tree joins on a column of one of `types` (jsonb, jsonb[]):
 * Postgres equates the columns by that type's `=`, which DuckDB's USING would not (it compares the text). The join's
 * condition is Postgres's own (its `quals`), at no offset of the statement, so it is read here, not by the rewrite.
 */
export function joinsUsing(tree: TreeValue, types: ReadonlySet<number>): boolean {
  const compares = (v: TreeValue | undefined): boolean => {
    if (Array.isArray(v)) return v.some(compares);
    if (v === undefined || !isNode(v)) return false;
    if (v._node === "OPEXPR" && Array.isArray(v.args) && v.args.some((a) => isNode(a) && types.has(exprType(a)?.type ?? 0))) return true;
    return Object.entries(v).some(([k, x]) => k !== "_node" && compares(x));
  };
  const visit = (v: TreeValue | undefined): boolean => {
    if (Array.isArray(v)) return v.some(visit);
    if (v === undefined || !isNode(v)) return false;
    if (v._node === "JOINEXPR" && Array.isArray(v.usingClause) && v.usingClause.length > 0 && compares(v.quals)) return true;
    return Object.entries(v).some(([k, x]) => k !== "_node" && visit(x));
  };
  return visit(tree);
}

/** The analysed query's output columns, in order (resjunk ones, which a sort may add, left out): their types. */
export function outputTypes(tree: TreeValue): Array<{ name: string | null; type: number; typmod: number }> | null {
  if (!isNode(tree) || tree._node !== "QUERY" || !Array.isArray(tree.targetList)) return null;
  return tree.targetList.filter((e): e is TreeNode => isNode(e) && e.resjunk !== "true").map((e) => {
    const t = isNode(e.expr ?? null) ? exprType(e.expr as TreeNode) : null;
    return { name: typeof e.resname === "string" ? e.resname : null, type: t?.type ?? 0, typmod: t?.typmod ?? -1 };
  });
}
