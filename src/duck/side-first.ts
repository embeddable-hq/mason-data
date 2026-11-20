/**
 * A KEY OF ONE SIDE OF A GROUPED JOIN, COMPUTED ON THAT SIDE BEFORE THE JOIN (issue 1160; docs/DESIGN.md "A key of one
 * side, computed on that side"). In
 *
 *   SELECT date_trunc('month', o.created_at), date_trunc('year', c.created_at), sum(o.amount)
 *   FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY 1, 2
 *
 * the second key reads `customers` alone, yet the engine computes it once a row of the join: once an order, 20 times a
 * customer in the cold benchmark's data. Outside UTC that truncation is the costly part of the query. So a GROUP BY key
 * that reads one table of the join alone is computed in a derived table of that table, and the statement reads its
 * column:
 *
 *   FROM orders o JOIN (SELECT c.<each column the SELECT reads of it>, <the key> AS <own>side0 FROM customers c) AS c
 *   ON … GROUP BY …, c.<own>side0
 *
 * The derived table has the table's FROM name and each column the SELECT reads of it (a hidden one too: a reference's
 * number the join reads, a bucket), so every other read of the table reads as before, and only the key's own places
 * change: the list, the GROUP BY, the HAVING, the ORDER BY, a DISTINCT ON and a named window. Never a `*`, which would
 * list the table's hidden columns (src/duck/kept-route.ts `exposes`). On the finished tree, after the walk and before a
 * time's bucket (src/duck/bucket-group.ts), whose inner query then groups by the column.
 *
 * THE ANSWER STAYS POSTGRES'S. Computed before the join, a key is computed on rows the join then drops, and never on a
 * row an outer join extends with NULLs. So it moves only where both are the same:
 *  - IT CANNOT FAIL (`safe`): every node is one of a short list the engine computes from any value of its bound types
 *    without an error, and none is volatile. A column, a constant, a CASE, AND, OR, NOT, IS NULL, COALESCE, a
 *    comparison with a constant, IN a list of constants; current_setting, lower and upper; date_part and a cast to a
 *    date of a time, a cast to text; date_trunc by a constant unit, isfinite and epoch_us of a timestamp (a date's
 *    truncation is a timestamp, which a date past the engine's last timestamp is not); and the integer arithmetic the
 *    rewrite writes a truncation in (`range`: +, -, *, % and // whose every value is proven to fit 64 bits, the
 *    microseconds of a time a copy can hold), with make_timestamp and make_timestamptz of a value proven a time.
 *    Anything else stays where it is: a Mason function (which may refuse a row), error(), a cast that can fail, a time
 *    zone's conversion (the engine refuses a local time past its last day), arithmetic on a column of a number.
 *  - ON THE SIDE AN OUTER JOIN EXTENDS WITH NULLS, IT IS NULL WHERE ITS COLUMNS ARE (`nullIn`): the derived table's
 *    column is NULL on such a row, where the key over its NULL columns would be computed. A truncation is; a COALESCE
 *    is not.
 *  - IT READS ONE TABLE ALONE (`readOf`: by the name's qualifier, `c.x` or `public.customers.x`, or a bare name by the
 *    FROM item Postgres bound it to). A name that cannot be told, a whole row, a `*`, a row number (src/duck/late.ts),
 *    a subquery, a LATERAL item, USING, NATURAL or a join's own name keep the SELECT as it was, and so does a key
 *    spelled otherwise in the list than in the GROUP BY (`placed`).
 *
 * A TRUNCATION THE BUCKET WOULD GROUP BY MOVES TOO. Grouped by its side's bucket, it is a bucket a joined row and a
 * truncation a bucket; computed on its side, a truncation a row of the side. On the smaller side that is less: a month
 * of the customers' signups over 50 M orders in Asia/Kathmandu, 383 ms by the bucket, 233 ms computed first. A key left
 * in place keeps its mark, which src/duck/bucket-group.ts may still group by, so its side's bucket column is listed.
 *
 * IT IS APPLIED ONLY WHERE IT SAVES WORK (`smallEnough`). Computed on the side, the key is computed once a row of the
 * side; after the join, once a row of the join. That is fewer only where the join has more rows than the side, which the
 * plan can tell only from the tables' sizes (the sync's count of each copy, `rows`): the side's table holds at most half
 * the rows of the biggest other table of the join, and nothing filters the others (a WHERE or ON conjunct that reads
 * another FROM item and is no equality of two columns), which could leave fewer joined rows than the side has. The
 * plan is kept by its text, so a size read once decides until the plan is made again; the answer is the same either way.
 */
import { ENGINE_AGGREGATES } from "./bucket-group.ts";

type Body = Record<string, unknown>;
type AstNode = Record<string, unknown>;

export interface SideContext {
  /** the prefix of every name the rewrite invents (src/duck/own-names.ts) */
  own: string;
  /** a copied table's rows as the sync counted them, by its schema as written (null where none is) and its name; null
   *  where unknown */
  rows: (schema: string | null, name: string) => number | null;
  /** Postgres's type of a column the statement reads (its analysis), null where unknown */
  typeOf: (n: AstNode) => number | null;
  /** the FROM item a bare column name reads, as Postgres bound it (its analysis): its FROM name, null where it is no
   *  column of this query's FROM or cannot be told */
  owner: (n: AstNode) => string | null;
  /** a time's bucket mark's hidden bucket column (src/duck/bucket-group.ts `BucketMark`), null for any other node */
  bucketOf: (n: AstNode) => AstNode | null;
}

const DATE = 1082, TIMESTAMP = 1114, TIMESTAMPTZ = 1184;
/** the microseconds of a time a copy holds: from Postgres's least (4713-11-24 BC) to the engine's greatest
 *  (294247-01-10 04:00:54.775806 UTC) */
const LEAST_US = -210_866_803_200_000_000n, GREATEST_US = 9_223_372_036_854_775_806n;
/** a truncation's start is at most this far before the time (a millennium's, a little over 1,000 years) */
const TRUNCATED_US = 1_100n * 366n * 86_400_000_000n;
const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n, INT32_MIN = -(2n ** 31n), INT32_MAX = 2n ** 31n - 1n;
/** what make_timestamp and make_timestamptz take: every microsecond but the engine's two infinities */
const TIME_MIN_US = INT64_MIN + 2n, TIME_MAX_US = INT64_MAX - 1n;

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const isNode = (v: unknown): v is AstNode => isObject(v) && Object.keys(v).length === 1 && /^[A-Z]/.test(Object.keys(v)[0]!);
const kindOf = (n: AstNode): string => Object.keys(n)[0]!;
const bodyOf = (n: AstNode): Body => n[kindOf(n)] as Body;
const S = (sval: string): AstNode => ({ String: { sval } });
const sval = (n: unknown): string | null => isNode(n) && kindOf(n) === "String" ? String(bodyOf(n).sval ?? "") : null;
const names = (list: unknown): Array<string | null> => Array.isArray(list) ? list.map(sval) : [];
const lower = (x: unknown): string => typeof x === "string" ? x.toLowerCase() : "";
const funcName = (b: Body): string | null => { const n = names(b.funcname); return n.length === 1 ? lower(n[0]) : null; };
const argsOf = (b: Body): unknown[] => (b.args ?? []) as unknown[];
/** a tree's form without its offsets */
const shape = (v: unknown): string => JSON.stringify(v, (k, x: unknown) => k === "location" ? undefined : x);

/** a string constant's text, or null */
function constText(n: unknown): string | null {
  if (!isNode(n) || kindOf(n) !== "A_Const") return null;
  const s = bodyOf(n).sval;
  return isObject(s) && typeof s.sval === "string" ? s.sval : null;
}
/** an integer constant's value, or null */
function constInt(n: unknown): bigint | null {
  if (!isNode(n) || kindOf(n) !== "A_Const") return null;
  const b = bodyOf(n);
  if (isObject(b.ival)) return BigInt(Number(b.ival.ival ?? 0));
  if (isObject(b.fval) && typeof b.fval.fval === "string" && /^-?\d+$/.test(b.fval.fval)) return BigInt(b.fval.fval);
  return null;
}
const castName = (b: Body): string => lower(names((b.typeName as Body | undefined)?.names).at(-1));
/** a constant the engine reads as it binds: a literal, NULL of a type, a literal's text */
const isConst = (n: unknown): boolean => {
  if (!isNode(n)) return false;
  if (kindOf(n) === "A_Const") return true;
  if (kindOf(n) !== "TypeCast" || !isNode(bodyOf(n).arg) || kindOf(bodyOf(n).arg as AstNode) !== "A_Const") return false;
  return bodyOf(bodyOf(n).arg as AstNode).isnull === true || ["text", "varchar"].includes(castName(bodyOf(n)));
};

/** a function call with no aggregate's or window's parts, no named or variadic argument */
const plainCall = (b: Body): boolean => b.over === undefined && b.agg_star !== true && b.agg_distinct !== true && b.agg_order === undefined
  && b.agg_filter === undefined && b.agg_within_group !== true && b.func_variadic !== true && argsOf(b).every((a) => isNode(a) && kindOf(a) !== "NamedArgExpr");

type Range = readonly [bigint, bigint];
const fits = (r: Range, lo = INT64_MIN, hi = INT64_MAX): Range | null => r[0] >= lo && r[1] <= hi ? r : null;
const floorDiv = (a: bigint, k: bigint): bigint => { const q = a / k; return a % k !== 0n && (a < 0n) !== (k < 0n) ? q - 1n : q; };

/**
 * THE MICROSECONDS A TIMESTAMP EXPRESSION CAN HOLD, or null where it is no timestamp told here: a column Postgres types
 * as a timestamp or timestamptz (a copy holds Postgres's values, up to the engine's greatest), a truncation of one (at
 * most a millennium before it), a time made of microseconds proven in range.
 */
function timestamp(n: unknown, ctx: SideContext): Range | null {
  if (!isNode(n)) return null;
  const k = kindOf(n), b = bodyOf(n);
  if (k === "ColumnRef") { const t = ctx.typeOf(n); return t === TIMESTAMPTZ || t === TIMESTAMP ? [LEAST_US, GREATEST_US] : null; }
  if (k !== "FuncCall" || !plainCall(b)) return null;
  const name = funcName(b), args = argsOf(b);
  if (name === "date_trunc" && args.length === 2 && constText(args[0]) !== null) {
    const r = timestamp(args[1], ctx);
    return r === null ? null : [r[0] - TRUNCATED_US, r[1]];
  }
  if ((name === "make_timestamp" || name === "make_timestamptz") && args.length === 1) {
    const r = range(args[0], ctx);
    return r !== null && r[0] >= TIME_MIN_US && r[1] <= TIME_MAX_US ? r : null;
  }
  return null;
}

/**
 * THE VALUES AN INTEGER EXPRESSION CAN TAKE, where every step is proven to fit 64 bits (the engine raises on an
 * overflow), or null. Only what the rewrite writes a truncation in: constants, the microseconds of a timestamp, and +, -,
 * *, % and // of them. A column of a number is no such value: arithmetic on it can overflow.
 */
function range(n: unknown, ctx: SideContext): Range | null {
  if (!isNode(n)) return null;
  const k = kindOf(n), b = bodyOf(n);
  const c = constInt(n);
  if (c !== null) return [c, c];
  if (k === "FuncCall") return funcName(b) === "epoch_us" && plainCall(b) && argsOf(b).length === 1 ? timestamp(argsOf(b)[0], ctx) : null;
  if (k === "TypeCast") {
    const r = range(b.arg, ctx), to = castName(b);
    if (r === null) return null;
    if (to === "int8" || to === "bigint") return fits(r);
    if (to === "int4" || to === "integer" || to === "int") return fits(r, INT32_MIN, INT32_MAX);
    return null;
  }
  if (k !== "A_Expr" || b.kind !== "AEXPR_OP") return null;
  const op = names(b.name);
  if (op.length !== 1) return null;
  const l = range(b.lexpr, ctx), r = range(b.rexpr, ctx);
  if (l === null || r === null) return null;
  switch (op[0]) {
    case "+": return fits([l[0] + r[0], l[1] + r[1]]);
    case "-": return fits([l[0] - r[1], l[1] - r[0]]);
    case "*": {
      const p = [l[0] * r[0], l[0] * r[1], l[1] * r[0], l[1] * r[1]];
      return fits([p.reduce((a, x) => x < a ? x : a), p.reduce((a, x) => x > a ? x : a)]);
    }
    // the engine's % takes the dividend's sign: below a positive divisor in magnitude
    case "%": {
      if (r[0] !== r[1] || r[0] <= 0n) return null;
      const m = r[0] - 1n;
      return l[0] >= 0n ? [0n, l[1] < m ? l[1] : m] : l[1] <= 0n ? [l[0] > -m ? l[0] : -m, 0n] : [-m, m];
    }
    case "//": return r[0] === r[1] && r[0] > 0n ? [floorDiv(l[0], r[0]), floorDiv(l[1], r[0])] : null;
    default: return null;
  }
}

/** whether an expression is a time Postgres typed: a timestamp told by `timestamp`, or a column of a date */
const isTime = (n: unknown, ctx: SideContext): boolean => timestamp(n, ctx) !== null || (isNode(n) && kindOf(n) === "ColumnRef" && ctx.typeOf(n) === DATE);

/**
 * WHETHER THE ENGINE COMPUTES AN EXPRESSION FROM ANY VALUE OF ITS BOUND TYPES WITHOUT AN ERROR (the module's header).
 * The statement binds as it is, so each function's types are already the engine's: only what a value can make fail is
 * asked here.
 */
function safe(n: unknown, ctx: SideContext): boolean {
  if (!isNode(n)) return false;
  const k = kindOf(n), b = bodyOf(n);
  switch (k) {
    case "ColumnRef": return ((b.fields ?? []) as unknown[]).every((f) => sval(f) !== null);
    case "A_Const": return true;
    case "TypeCast": {
      if (isConst(n)) return true;
      if (!safe(b.arg, ctx) || (b.typeName as Body | undefined)?.arrayBounds !== undefined) return false;
      const to = castName(b);
      if (to === "text" || to === "varchar") return true;
      if (to === "date") return isTime(b.arg, ctx);
      return range(n, ctx) !== null;
    }
    case "FuncCall": {
      const name = funcName(b), args = argsOf(b);
      if (name === null || !plainCall(b)) return false;
      switch (name) {
        case "date_trunc": case "make_timestamp": case "make_timestamptz": return timestamp(n, ctx) !== null;
        case "isfinite": case "epoch_us": return args.length === 1 && timestamp(args[0], ctx) !== null;
        case "date_part": return args.length === 2 && constText(args[0]) !== null && isTime(args[1], ctx);
        case "lower": case "upper": return args.length === 1 && safe(args[0], ctx);
        case "current_setting": return args.length === 1 && constText(args[0]) !== null;
        default: return false;
      }
    }
    case "A_Expr": {
      const op = names(b.name);
      if (b.kind === "AEXPR_IN") return safe(b.lexpr, ctx) && isNode(b.rexpr) && kindOf(b.rexpr) === "List" && ((bodyOf(b.rexpr).items ?? []) as unknown[]).every(isConst);
      if (b.kind === "AEXPR_OP" && op.length === 1 && ["=", "<>", "<", ">", "<=", ">="].includes(op[0] ?? "")) {
        // a value compared with a constant: the engine casts the constant to the value's type as it binds
        return safe(b.lexpr, ctx) && safe(b.rexpr, ctx) && (isConst(b.lexpr) || isConst(b.rexpr));
      }
      return range(n, ctx) !== null;
    }
    case "CaseExpr": {
      const whens = (b.args ?? []) as unknown[];
      if (b.arg !== undefined && (!safe(b.arg, ctx) || !whens.every((w) => isNode(w) && isConst(bodyOf(w).expr)))) return false;
      return whens.every((w) => isNode(w) && kindOf(w) === "CaseWhen" && safe(bodyOf(w).expr, ctx) && safe(bodyOf(w).result, ctx))
        && (b.defresult === undefined || safe(b.defresult, ctx));
    }
    case "BoolExpr": case "CoalesceExpr": return ((b.args ?? []) as unknown[]).every((a) => safe(a, ctx));
    case "NullTest": case "BooleanTest": return safe(b.arg, ctx);
    default: return false;
  }
}

/** WHETHER AN EXPRESSION IS NULL WHERE EVERY COLUMN IT READS IS (a row an outer join extends with NULLs): each function
 *  `safe` takes but current_setting is strict, so a call is NULL where an argument is; a CASE where each answer is */
function nullIn(n: unknown): boolean {
  if (!isNode(n)) return false;
  const k = kindOf(n), b = bodyOf(n);
  switch (k) {
    case "ColumnRef": return true;
    case "A_Const": return b.isnull === true;
    case "TypeCast": return nullIn(b.arg);
    case "FuncCall": {
      const name = funcName(b), args = argsOf(b);
      if (name === "date_trunc" || name === "date_part") return nullIn(args[1]);
      return ["isfinite", "lower", "upper", "epoch_us", "make_timestamp", "make_timestamptz"].includes(name ?? "") && nullIn(args[0]);
    }
    case "A_Expr": return b.kind === "AEXPR_IN" ? nullIn(b.lexpr) : b.kind === "AEXPR_OP" && (nullIn(b.lexpr) || nullIn(b.rexpr));
    case "CaseExpr": return ((b.args ?? []) as unknown[]).every((w) => isNode(w) && nullIn(bodyOf(w).result)) && (b.defresult === undefined || nullIn(b.defresult));
    // NULL AND NULL, NULL OR NULL and NOT NULL are NULL
    case "BoolExpr": return ((b.args ?? []) as unknown[]).every(nullIn);
    default: return false;
  }
}

/** a FROM item of a join: its node, its FROM name, and whether an outer join extends it with NULLs */
interface Leaf { node: AstNode; name: string; nullable: boolean }

/** every FROM item of a SELECT, or null where one is read in a way the module leaves (a LATERAL item, USING, NATURAL, a
 *  join's own name) */
function leavesOf(from: unknown[]): Leaf[] | null {
  const out: Leaf[] = [];
  const visit = (n: unknown, nullable: boolean): boolean => {
    if (!isNode(n)) return false;
    const k = kindOf(n), b = bodyOf(n);
    if (k === "JoinExpr") {
      if (b.isNatural === true || b.usingClause !== undefined || b.alias !== undefined || b.join_using_alias !== undefined) return false;
      const t = b.jointype;
      if (t !== "JOIN_INNER" && t !== "JOIN_LEFT" && t !== "JOIN_RIGHT" && t !== "JOIN_FULL") return false;
      return visit(b.larg, nullable || t === "JOIN_RIGHT" || t === "JOIN_FULL") && visit(b.rarg, nullable || t === "JOIN_LEFT" || t === "JOIN_FULL");
    }
    if (b.lateral === true) return false;
    const alias = isObject(b.alias) && typeof b.alias.aliasname === "string" ? b.alias.aliasname : null;
    out.push({ node: n, name: alias ?? (k === "RangeVar" && typeof b.relname === "string" ? b.relname : ""), nullable });
    return true;
  };
  return from.every((f) => visit(f, false)) ? out : null;
}

/** the clauses of a SELECT a key is read in, the places it is replaced (never its FROM or WHERE, which read the columns) */
const KEY_CLAUSES = ["targetList", "groupClause", "havingClause", "sortClause", "distinctClause", "windowClause"];

/** whether a tree holds a node of one of these kinds */
function holds(v: unknown, kinds: readonly string[]): boolean {
  if (Array.isArray(v)) return v.some((x) => holds(x, kinds));
  if (!isObject(v)) return false;
  if (isNode(v) && kinds.includes(kindOf(v))) return true;
  return Object.values(isNode(v) ? bodyOf(v) : v).some((x) => holds(x, kinds));
}

/** every ColumnRef of a tree, never one inside a FROM item (a SELECT's own clauses, its ON conditions included) */
function columnRefs(v: unknown): AstNode[] {
  const out: AstNode[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!isObject(x)) return;
    if (isNode(x)) {
      const k = kindOf(x);
      if (k === "ColumnRef") { out.push(x); return; }
      if (k === "RangeSubselect" || k === "RangeFunction" || k === "RangeVar" || k === "RangeTableSample" || k === "WithClause") return;
      Object.values(bodyOf(x)).forEach(walk);
      return;
    }
    Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
}

/**
 * WHAT A COLUMN REFERENCE OF A SELECT READS: a FROM item's column (by its qualifier, else by the FROM item Postgres bound
 * the name to), an output of the SELECT (a bare name no column holds, which only a GROUP BY or an ORDER BY reads), or
 * null where it cannot be told.
 */
type Read = { leaf: Leaf; column: string } | "output" | null;
function readOf(ref: AstNode, leaves: readonly Leaf[], outputs: ReadonlySet<string>, ctx: SideContext): Read {
  const f = names(bodyOf(ref).fields);
  if (f.length === 0 || f.some((x) => x === null)) return null;
  const column = f.at(-1)!;
  const find = (name: string | null): Leaf | null => name === null ? null : leaves.find((l) => lower(l.name) === lower(name)) ?? null;
  if (f.length === 1) {
    const leaf = find(ctx.owner(ref));
    if (leaf !== null) return { leaf, column };
    return outputs.has(lower(column)) ? "output" : null;
  }
  if (f.length === 2) { const leaf = find(f[0]!); return leaf === null ? null : { leaf, column }; }
  // schema.table.column: a table read by its own name, no alias
  if (f.length !== 3) return null;
  const leaf = leaves.find((l) => kindOf(l.node) === "RangeVar" && !isObject(bodyOf(l.node).alias) && lower(bodyOf(l.node).schemaname) === lower(f[0])
    && lower(bodyOf(l.node).relname) === lower(f[1])) ?? null;
  return leaf === null ? null : { leaf, column };
}

/** each GROUP BY key of a SELECT: an expression, or the output an integer names (null where none is) */
function keysOf(s: Body): Array<AstNode | null> {
  const targets = (s.targetList ?? []) as AstNode[];
  return ((s.groupClause ?? []) as AstNode[]).map((g) => {
    const n = constInt(g);
    if (n === null) return g;
    const t = targets[Number(n) - 1];
    return t === undefined || kindOf(t) !== "ResTarget" || !isNode(bodyOf(t).val) ? null : bodyOf(t).val as AstNode;
  });
}

/** the bucket column of every time's bucket mark in a tree, by its form */
function bucketsIn(v: unknown, ctx: SideContext): Map<string, AstNode> {
  const out = new Map<string, AstNode>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!isObject(x)) return;
    const b = isNode(x) ? ctx.bucketOf(x) : null;
    if (b !== null) { out.set(shape(b), b); return; }
    Object.values(isNode(x) ? bodyOf(x) : x).forEach(walk);
  };
  walk(v);
  return out;
}

/**
 * Every grouped SELECT of `tree` whose keys read one table of its join alone, with those keys computed on that table
 * first (the module's header). The tree is changed in place; true where a SELECT was.
 */
export function sideFirst(tree: unknown, ctx: SideContext): boolean {
  // a WITH query's name: a FROM item of that name may be the WITH query, whose rows the sync never counted
  const ctes = new Set<string>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (!isObject(v)) return;
    if (isNode(v) && kindOf(v) === "CommonTableExpr") ctes.add(lower(bodyOf(v).ctename));
    Object.values(isNode(v) ? bodyOf(v) : v).forEach(collect);
  };
  collect(tree);
  let made = 0;
  const one = (s: Body): boolean => {
    const groups = s.groupClause;
    if (!Array.isArray(groups) || groups.length === 0 || (s.op !== undefined && s.op !== "SETOP_NONE") || !Array.isArray(s.fromClause)) return false;
    if (groups.some((g) => !isNode(g) || kindOf(g) === "GroupingSet")) return false;
    // a subquery may read a column of this SELECT, and a `*` its columns: the SELECT keeps its form
    if (holds(KEY_CLAUSES.map((c) => s[c]).concat([s.whereClause, s.fromClause]), ["SubLink", "A_Star"])) return false;
    const leaves = leavesOf(s.fromClause);
    if (leaves === null || leaves.length < 2 || leaves.some((l) => l.name === "") || new Set(leaves.map((l) => lower(l.name))).size !== leaves.length) return false;
    const outputs = new Set(((s.targetList ?? []) as AstNode[]).map((t) => lower(bodyOf(t).name)));
    const keys = keysOf(s);
    if (keys.some((k) => k === null)) return false;
    // each FROM item's keys to compute first, by their form
    const moved = new Map<number, Map<string, AstNode>>();
    for (const key of keys as AstNode[]) {
      if (kindOf(key) === "ColumnRef" || kindOf(key) === "A_Const") continue;
      const reads = columnRefs(key).map((r) => readOf(r, leaves, new Set(), ctx));
      if (reads.length === 0 || reads.some((r) => r === null || r === "output")) continue;
      const owners = new Set(reads.map((r) => (r as { leaf: Leaf }).leaf));
      const leaf = owners.size === 1 ? [...owners][0]! : null;
      if (leaf === null || kindOf(leaf.node) !== "RangeVar") continue;
      if (!safe(key, ctx) || (leaf.nullable && !nullIn(key))) continue;
      const at = leaves.indexOf(leaf);
      const forms = moved.get(at) ?? new Map<string, AstNode>();
      forms.set(shape(key), key);
      moved.set(at, forms);
    }
    let any = false;
    for (const [at, forms] of moved) {
      if (!smallEnough(at, s, ctx, ctes, outputs)) continue;
      // written on a copy, kept only where the engine can still group every read of the table's columns
      const copy = structuredClone(s);
      const named = [...forms.keys()].map((form, i) => [form, `${ctx.own}side${made + i}`] as const);
      if (!placed(copy, at, named, [...forms.values()], outputs, ctx)) continue;
      made += forms.size;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, copy);
      any = true;
    }
    return any;
  };
  let changed = false;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isObject(v)) return;
    for (const x of Object.values(isNode(v) ? bodyOf(v) : v)) visit(x);
    if (isNode(v) && kindOf(v) === "SelectStmt") {
      const s = bodyOf(v);
      // a set operation's arms are SELECT bodies of their own (libpg-query writes them unwrapped)
      for (const arm of [s.larg, s.rarg]) if (isObject(arm) && one(arm)) changed = true;
      if (one(s)) changed = true;
    }
  };
  visit(tree);
  return changed;
}

/**
 * THE KEYS OF ONE FROM ITEM (the `at`-th) COMPUTED IN A DERIVED TABLE OF IT, written into `s` (a copy): each key's form
 * read as its column wherever the SELECT reads a key (`KEY_CLAUSES`), and the item a derived table, under its FROM name,
 * of the keys and of each column of its table the SELECT reads (and the bucket column of each mark of the table's
 * times, which src/duck/bucket-group.ts may group by). A column read as `schema.table.x` is read as `table.x`. False
 * where the result is not one the engine can group the same: a column of the item read outside an aggregate that no
 * GROUP BY key is (a key spelled otherwise in the list than in the GROUP BY), or a read that cannot be told (a bare name
 * of no FROM item Postgres names, the table's row number, its whole row).
 */
function placed(s: Body, at: number, named: ReadonlyArray<readonly [string, string]>, keys: readonly AstNode[], outputs: ReadonlySet<string>, ctx: SideContext): boolean {
  const leaves = leavesOf(s.fromClause as unknown[])!;
  const leaf = leaves[at]!;
  const column = new Map(named.map(([form, name]) => [form, { ColumnRef: { fields: [S(leaf.name), S(name)] } } as AstNode]));
  // an output the key is, with no name of its own: the engine would name it for the column (a query around reads it so)
  if (((s.targetList ?? []) as AstNode[]).some((t) => typeof bodyOf(t).name !== "string" && column.has(shape(bodyOf(t).val)))) return false;
  const place = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(place);
    if (!isObject(v)) return v;
    if (isNode(v)) {
      const c = column.get(shape(v));
      if (c !== undefined) return structuredClone(c);
    }
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, place(x)]));
  };
  for (const clause of KEY_CLAUSES) if (s[clause] !== undefined) s[clause] = place(s[clause]);
  const mine = new Set(named.map(([, name]) => name));
  const ofLeaf = (r: AstNode): string | null => {
    const what = readOf(r, leaves, outputs, ctx);
    return what !== null && what !== "output" && what.leaf === leaf && !mine.has(what.column) ? what.column : null;
  };
  // every other read of the item's columns outside an aggregate is a GROUP BY key itself, or inside one
  const grouped = new Set(keysOf(s).map((k) => shape(k)));
  const ungrouped = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(ungrouped);
    if (!isObject(v)) return false;
    if (!isNode(v)) return Object.values(v).some(ungrouped);
    const k = kindOf(v), b = bodyOf(v);
    if (grouped.has(shape(v))) return false;
    if (k === "FuncCall" && (b.over !== undefined || b.agg_star === true || ENGINE_AGGREGATES.has(lower(names(b.funcname).at(-1))))) return false;
    if (k === "ColumnRef") return ofLeaf(v) !== null;
    return Object.values(b).some(ungrouped);
  };
  const values = ((s.targetList ?? []) as AstNode[]).map((t) => bodyOf(t).val);
  if (ungrouped([values, s.havingClause, s.sortClause, s.distinctClause])) return false;
  // each column the SELECT reads of the item, as its derived table lists it
  const read = new Set<string>();
  const longer: Body[] = [];
  for (const r of columnRefs(Object.entries(s).filter(([k]) => k !== "withClause").map(([, x]) => x))) {
    const f = names(bodyOf(r).fields);
    if (f.length === 1 && lower(f[0]) === lower(leaf.name)) return false;
    if (readOf(r, leaves, outputs, ctx) === null) return false;
    const c = ofLeaf(r);
    if (c === null) continue;
    if (lower(c) === "rowid") return false;
    // two columns of names alike but for case, which the engine cannot tell apart
    if ([...read].some((x) => x !== c && lower(x) === lower(c))) return false;
    read.add(c);
    if (f.length === 3) longer.push(bodyOf(r));
  }
  // and the bucket column of a mark of the table's times, which src/duck/bucket-group.ts may group by
  for (const b of bucketsIn(Object.values(s), ctx).values()) { const c = ofLeaf(b); if (c !== null) read.add(c); }
  const node = leaf.node, table = bodyOf(node);
  node.RangeSubselect = {
    subquery: { SelectStmt: { targetList: [...[...read].map((c) => ({ ResTarget: { val: { ColumnRef: { fields: [S(leaf.name), S(c)] } } } })),
      ...named.map(([, name], i) => ({ ResTarget: { name, val: structuredClone(keys[i]) } }))],
    fromClause: [{ RangeVar: table }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } },
    alias: { aliasname: leaf.name },
  };
  delete node.RangeVar;
  // what read the table as `schema.table.x` reads the derived table as `table.x`
  for (const r of longer) r.fields = ((r.fields ?? []) as unknown[]).slice(1);
  return true;
}

/**
 * WHETHER THE JOIN HAS MORE ROWS THAN THE SIDE (the module's header): its table holds at most half the rows of the
 * biggest other table, every FROM item is a table the sync counted, and no WHERE or ON conjunct filters another item: one
 * that reads another item is an equality of a column of one item and a column of another (the join's).
 */
function smallEnough(at: number, s: Body, ctx: SideContext, ctes: ReadonlySet<string>, outputs: ReadonlySet<string>): boolean {
  const leaves = leavesOf(s.fromClause as unknown[])!;
  const leaf = leaves[at]!;
  const rowsOf = (l: Leaf): number | null => {
    if (kindOf(l.node) !== "RangeVar") return null;
    const b = bodyOf(l.node);
    const schema = typeof b.schemaname === "string" ? b.schemaname : null;
    if (schema === null && ctes.has(lower(b.relname))) return null;
    return ctx.rows(schema, String(b.relname));
  };
  const own = rowsOf(leaf);
  const others = leaves.filter((l) => l !== leaf).map(rowsOf);
  if (own === null || others.some((n) => n === null) || own * 2 > Math.max(...others as number[])) return false;
  const conjuncts: unknown[] = [];
  const split = (q: unknown): void => {
    if (!isNode(q)) return;
    if (kindOf(q) === "BoolExpr" && bodyOf(q).boolop === "AND_EXPR") { ((bodyOf(q).args ?? []) as unknown[]).forEach(split); return; }
    conjuncts.push(q);
  };
  split(s.whereClause);
  const joins = (n: unknown): void => {
    if (!isNode(n) || kindOf(n) !== "JoinExpr") return;
    split(bodyOf(n).quals);
    joins(bodyOf(n).larg); joins(bodyOf(n).rarg);
  };
  (s.fromClause as unknown[]).forEach(joins);
  const leafOf = (r: AstNode): Leaf | null => { const what = readOf(r, leaves, outputs, ctx); return what === null || what === "output" ? null : what.leaf; };
  return conjuncts.every((c) => {
    const read = columnRefs(c).map(leafOf);
    // the side's own filter, which its derived table reads first (or no column: `ON true`)
    if (read.every((l) => l === leaf)) return true;
    // the join's own condition: a column of one item equal to a column of another
    if (!isNode(c) || kindOf(c) !== "A_Expr") return false;
    const b = bodyOf(c);
    if (b.kind !== "AEXPR_OP" || names(b.name).join() !== "=" || !isNode(b.lexpr) || kindOf(b.lexpr) !== "ColumnRef" || !isNode(b.rexpr) || kindOf(b.rexpr) !== "ColumnRef") return false;
    const l = leafOf(b.lexpr), r = leafOf(b.rexpr);
    return l !== null && r !== null && l !== r;
  });
}
