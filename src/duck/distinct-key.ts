/**
 * A COUNT OF DISTINCT KEYS IS A COUNT (docs/DESIGN.md "A count of distinct keys"): a BI tool's "count of entities" is
 * `count(DISTINCT t.id)` with `id` the table's primary key, and DuckDB computes it as a hash aggregate of every id to
 * find the duplicates — over a 197 M-row table grouped by a joined dimension, a two-level hash aggregate that spilled
 * 1.5 GB and took 120 s, where `count(t.id)` took 9 s. Postgres's answer is the same for both when no two of the rows
 * counted can hold one value: the column is the table's KEY and the FROM cannot repeat a row of its table. So the
 * rewrite drops the DISTINCT there (src/duck/rewrite.ts `funcCall`), and only there; this module decides where, from
 * POSTGRES'S ANALYSIS of the statement and the CATALOG Postgres's own pg_index — never by a column's name:
 *
 * - THE KEY, AND ONLY THE PRIMARY KEY: a column that is, alone, the table's PRIMARY KEY in the catalog Postgres
 *   (src/api/postgres/catalog.ts declares the source's primary key, read valid at `mason start` and at `mason add` /
 *   `remove`; a table copied by a sources file's `key:` has none, src/cli/sources.ts `addedTables`) — the key the copy
 *   is WRITTEN by, so the copy never holds it twice (a write by key deletes before it inserts, a batch is folded per
 *   key, the swap checks as many distinct keys as rows). Never a UNIQUE index that is not the key, though the catalog
 *   declares those too: a column the copy is not written by may hold one value twice for a moment the source never
 *   showed (a large transaction applied in pieces, a row refetched as it is now), and the catalog's indexes are the
 *   source's as of the start (a unique constraint dropped since is still declared). A composite key's column is not a
 *   key. The equality is the key's btree family's `=` under its collation (the catalog declares the type's default
 *   opclass and collation, not the source index's: the same equality for a scalar column).
 * - NOT MULTIPLIED: the counted column's table is the FROM's one item, or joined (INNER, LEFT, RIGHT or FULL) only to
 *   base tables each on a conjunction holding an equality of the OTHER table's primary key with a column of the
 *   counted side: each row of that side then meets at most one row of the other, so it is in at most one row of the join
 *   (a row the join leaves unmatched is in exactly one, and a NULL-extended one counts no value). Any other conjunct only
 *   filters. A second FROM item (a comma join), a derived table, a CTE, a function (a LATERAL `jsonb_each`), a VALUES
 *   list, a join of joins on the other side, a condition with an OR at its top, or a key equality whose other side is
 *   an expression: the DISTINCT stays. WHERE, GROUP BY, HAVING and grouping sets only take rows away.
 *
 * Conservative by construction: what this cannot prove keeps its DISTINCT, which costs time; a DISTINCT dropped where
 * two rows hold one value costs an answer. The oracle holds every shape (tests/integration/oracle/bi-shapes.ts, the
 * type matrix's `keyed`), the plan fixture the plans (tests/duck-plans.test.ts), and tests/duck-distinct-key.test.ts
 * the decision.
 *
 * THE SAME KEYS BOUND A JOIN'S ROWS (`fanOutBounded`, for src/duck/late.ts): a join that equates a whole primary key of
 * one side meets each row of the other side at most once, so its rows are at most those of its two sides, and a whole
 * FROM of such joins is linear in its tables. Here a composite key counts, every column of it equated. A PLAIN READ
 * counts as its table (`plainTable`: a derived table, a view's definition or a WITH query with only a projection and a
 * WHERE over one table): it holds each row of the table at most once, and an output that is a bare column is that column.
 */
import type { TreeNode, TreeValue } from "./pgtree.ts";

/** pg_proc's count(any) */
const COUNT_ANY = 2147;
const RTE_RELATION = 0;
const RTE_SUBQUERY = 1;
const RTE_CTE = 6;
const RTE_GROUP = 9;
/** JoinType: INNER, LEFT, FULL, RIGHT (nodes.h); the planner's SEMI / ANTI never reach a parse tree */
const JOINS = new Set([0, 1, 2, 3]);

/** a column that is its table's primary key alone, as the catalog Postgres declares it: by `relid.attno` */
export interface UniqueColumn {
  /** the index's collation (0 for a type with none): an equality under another (a COLLATE in the statement) is not its */
  collation: number;
  /** the equality operators of the index's btree operator family (cross-type ones included: int4 = int8) */
  equalities: ReadonlySet<number>;
}
export type UniqueColumns = ReadonlyMap<string, UniqueColumn>;
/** a table's whole primary key as the catalog Postgres declares it, of any number of columns: by relid, then attno */
export type PrimaryKeys = ReadonlyMap<number, ReadonlyMap<number, UniqueColumn>>;
export const columnKey = (relid: number, attno: number): string => `${relid}.${attno}`;

const isNode = (v: TreeValue | undefined): v is TreeNode => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
const num = (v: TreeValue | undefined): number | null => typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;
const list = (v: TreeValue | undefined): TreeValue[] => Array.isArray(v) ? v : [];

/** whether an AGGREF is a count(DISTINCT …) of one argument: the only aggregate this rewrite touches */
const isDistinctCount = (a: TreeNode): boolean => a._node === "AGGREF" && num(a.aggfnoid) === COUNT_ANY && list(a.aggdistinct).length === 1;

/**
 * The tables a statement's count(DISTINCT …) may be decided over: every base table of its queries, by the catalog's
 * OID, when it holds such a count at all (none: the plan asks the catalog nothing). Read before the decision, so the
 * catalog is asked once per statement planned.
 */
export function distinctCountTables(tree: TreeValue): number[] {
  let counts = false;
  const relids = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isNode(v)) return;
    if (isDistinctCount(v)) counts = true;
    if (v._node === "RANGETBLENTRY" && num(v.rtekind) === RTE_RELATION) { const r = num(v.relid); if (r !== null && r > 0) relids.add(r); }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return counts ? [...relids].sort((a, b) => a - b) : [];
}

/**
 * The catalog Postgres's PRIMARY KEYS of `relids` (never another unique index: the module's doc), a row per column of
 * the key, with its collation, the equality operators of its btree family and how many columns the key has. A primary
 * key is valid, unique and over plain columns; the conditions are written out all the same, so the rule is this
 * query's and not a reader's memory.
 */
export function uniqueColumnsSql(relids: readonly number[]): string {
  return "SELECT i.indrelid::text, i.indkey[k.at]::text, i.indcollation[k.at]::text, coalesce(string_agg(o.amopopr::text, ' ' ORDER BY o.amopopr), ''), i.indnkeyatts::text " +
    "FROM pg_index i CROSS JOIN LATERAL generate_series(0, i.indnkeyatts - 1) AS k(at) JOIN pg_opclass c ON c.oid = i.indclass[k.at] JOIN pg_am m ON m.oid = c.opcmethod AND m.amname = 'btree' " +
    "LEFT JOIN pg_amop o ON o.amopfamily = c.opcfamily AND o.amopmethod = c.opcmethod AND o.amopstrategy = 3 " +
    `WHERE i.indrelid IN (${relids.map((r) => String(Math.trunc(r))).join(", ")}) AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indnatts = i.indnkeyatts ` +
    "AND i.indkey[k.at] > 0 AND i.indpred IS NULL AND i.indexprs IS NULL GROUP BY 1, 2, 3, 5";
}

/** `uniqueColumnsSql`'s rows of a key of one column, as the decision reads them (a table has one primary key; the merge
 *  is for a second row of one column, which no catalog writes) */
export function uniqueColumnsOf(rows: ReadonlyArray<ReadonlyArray<string | null>>): Map<string, UniqueColumn> {
  const out = new Map<string, UniqueColumn>();
  for (const [relid, attno, collation, ops, columns] of rows) {
    if (columns !== "1") continue;
    const key = columnKey(Number(relid), Number(attno));
    const equalities = new Set((ops ?? "").split(" ").filter((x) => x !== "").map(Number));
    const had = out.get(key);
    // two rows for one column under two collations (none today): either's equality, under its own collation, is the key's;
    // kept as the first (the decision then asks that one's), which is conservative
    if (had === undefined) out.set(key, { collation: Number(collation ?? 0), equalities });
    else if (had.collation === Number(collation ?? 0)) out.set(key, { collation: had.collation, equalities: new Set([...had.equalities, ...equalities]) });
  }
  return out;
}

/** `uniqueColumnsSql`'s rows, each table's whole key: a key not read whole is no key */
export function primaryKeysOf(rows: ReadonlyArray<ReadonlyArray<string | null>>): PrimaryKeys {
  const out = new Map<number, Map<number, UniqueColumn>>(), whole = new Map<number, number>();
  for (const [relid, attno, collation, ops, columns] of rows) {
    const key = out.get(Number(relid)) ?? new Map<number, UniqueColumn>();
    key.set(Number(attno), { collation: Number(collation ?? 0), equalities: new Set((ops ?? "").split(" ").filter((x) => x !== "").map(Number)) });
    out.set(Number(relid), key);
    whole.set(Number(relid), Number(columns));
  }
  return new Map([...out].filter(([relid, key]) => key.size === whole.get(relid)));
}

/** a VAR of this query's own FROM (varlevelsup 0), bare or under a binary-compatible relabel (a varchar read as text) */
function ownVar(v: TreeValue | undefined): TreeNode | null {
  if (!isNode(v)) return null;
  if (v._node === "RELABELTYPE") return ownVar(v.arg);
  return v._node === "VAR" && (num(v.varlevelsup) ?? 0) === 0 && (num(v.varattno) ?? 0) >= 1 ? v : null;
}

/** the rtindexes a join tree's node holds (its tables', and its joins' own: a USING join's column is the join's) */
function indexesOf(n: TreeNode): Set<number> {
  const out = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (!isNode(v)) return;
    if (v._node === "RANGETBLREF") { const i = num(v.rtindex); if (i !== null) out.add(i); return; }
    if (v._node === "JOINEXPR") { const i = num(v.rtindex); if (i !== null) out.add(i); visit(v.larg); visit(v.rarg); }
  };
  visit(n);
  return out;
}

/** a conjunction's conjuncts (outfuncs.c writes BOOLEXPR's boolop as `and`, `or`, `not`), or the one condition */
function conjuncts(q: TreeValue | undefined): TreeNode[] {
  if (!isNode(q)) return [];
  if (q._node === "BOOLEXPR" && q.boolop === "and") return list(q.args).flatMap((a) => conjuncts(a));
  return [q];
}

/** the base table a FROM's RANGETBLREF names: its RANGETBLENTRY, when it is one (a relation, not a subquery, a CTE, a
 *  function, VALUES or a join) */
function baseTable(rtable: readonly TreeValue[], ref: TreeValue | undefined): { rtindex: number; relid: number } | null {
  if (!isNode(ref) || ref._node !== "RANGETBLREF") return null;
  const rtindex = num(ref.rtindex);
  const rte = rtindex === null ? undefined : rtable[rtindex - 1];
  if (!isNode(rte) || num(rte.rtekind) !== RTE_RELATION || rte.relkind !== "r") return null;
  const relid = num(rte.relid);
  return rtindex !== null && relid !== null && relid > 0 ? { rtindex, relid } : null;
}

/**
 * The column of the table at `rtindex` a conjunct equates with a column of `side`, both bare, by the operator and under
 * the collation `key` says are that column's own; null where it does not.
 */
function equated(c: TreeNode, side: ReadonlySet<number>, rtindex: number, key: (attno: number) => UniqueColumn | undefined): number | null {
  if (c._node !== "OPEXPR" || list(c.args).length !== 2) return null;
  const [a, b] = list(c.args).map(ownVar);
  if (a == null || b == null) return null;
  for (const [mine, theirs] of [[a, b], [b, a]] as const) {
    if (num(theirs.varno) !== rtindex || !side.has(num(mine.varno) ?? -1)) continue;
    const attno = num(theirs.varattno)!, u = key(attno);
    const collation = num(c.inputcollid) ?? 0;
    if (u !== undefined && u.equalities.has(num(c.opno) ?? -1) && (collation === 0 || collation === u.collation)) return attno;
  }
  return null;
}

/**
 * Whether a join's condition matches each row of its `side` with at most ONE row of `other`, a base table: a conjunct
 * that is an equality, by the operator of `other`'s single-column primary key and under its collation, of that
 * column (bare) with a column of `side` (bare).
 */
function atMostOne(quals: TreeValue | undefined, side: ReadonlySet<number>, other: { rtindex: number; relid: number }, unique: UniqueColumns): boolean {
  return conjuncts(quals).some((c) => equated(c, side, other.rtindex, (attno) => unique.get(columnKey(other.relid, attno))) !== null);
}

/**
 * Whether the FROM of `query` holds each row of the table at `rtindex` at most once: its one item, that table or a
 * join tree whose every join on the way down to it joins one base table on that table's primary key (`atMostOne`).
 */
export function notMultiplied(query: TreeNode, rtindex: number, unique: UniqueColumns): boolean {
  const jt = query.jointree;
  if (!isNode(jt)) return false;
  const from = list(jt.fromlist);
  if (from.length !== 1) return false;
  const rtable = list(query.rtable);
  const down = (n: TreeValue | undefined): boolean => {
    if (!isNode(n)) return false;
    if (n._node === "RANGETBLREF") return num(n.rtindex) === rtindex;
    if (n._node !== "JOINEXPR" || !JOINS.has(num(n.jointype) ?? -1) || !isNode(n.larg) || !isNode(n.rarg)) return false;
    const left = indexesOf(n.larg);
    const [side, otherRef] = left.has(rtindex) ? [n.larg, n.rarg] : indexesOf(n.rarg).has(rtindex) ? [n.rarg, n.larg] : [null, null];
    if (side === null) return false;
    const other = baseTable(rtable, otherRef);
    return other !== null && atMostOne(n.quals, indexesOf(side), other, unique) && down(side);
  };
  return down(from[0]);
}

/** whether a query is a projection and a WHERE alone: no aggregate, window, set-returning list, subquery expression,
 *  DISTINCT, grouping, sort, limit, set operation, WITH or row lock, so each of its rows is one row of its FROM */
export function projectionOnly(q: TreeNode): boolean {
  for (const f of ["hasAggs", "hasWindowFuncs", "hasTargetSRFs", "hasSubLinks", "hasDistinctOn", "hasRecursive", "hasModifyingCTE", "hasForUpdate"]) if (q[f] !== "false") return false;
  for (const f of ["cteList", "groupClause", "groupingSets", "havingQual", "windowClause", "distinctClause", "sortClause", "limitOffset", "limitCount", "rowMarks", "setOperations"]) {
    if (q[f] !== null && q[f] !== undefined && !(Array.isArray(q[f]) && q[f].length === 0)) return false;
  }
  return true;
}

/** a table a query's FROM reads, and which of its columns each output (by attno) is, where it is a bare column */
export interface PlainTable { relid: number; column: (attno: number) => number | null }

/**
 * THE PLAIN READ: a query that is a projection and a WHERE over ONE table, or over one plain read (a view of a view), so
 * it holds each row of that table at most once; null for anything else. Whether it may also be read twice is the
 * reader's (src/duck/late.ts asks too that nothing in it is volatile): this is about its rows alone.
 */
export function plainTable(q: TreeNode): PlainTable | null {
  if (!projectionOnly(q) || !isNode(q.jointree)) return null;
  const from = list(q.jointree.fromlist);
  const rtable = list(q.rtable);
  if (from.length !== 1) return null;
  const inner = heldTable(q, rtable, from[0]);
  if (inner === null) return null;
  const outputs = list(q.targetList).filter((t): t is TreeNode => isNode(t) && t.resjunk !== "true");
  return { relid: inner.relid, column: (attno) => {
    const v = ownVar(outputs[attno - 1]?.expr);
    return v === null ? null : inner.column(num(v.varattno)!);
  } };
}

/** the table a FROM's RANGETBLREF reads once: a base table, a plain derived read, or a plain read of its query's WITH */
function heldTable(query: TreeNode, rtable: readonly TreeValue[], ref: TreeValue | undefined): PlainTable | null {
  const t = baseTable(rtable, ref);
  if (t !== null) return { relid: t.relid, column: (attno) => attno };
  if (!isNode(ref) || ref._node !== "RANGETBLREF") return null;
  const rte = rtable[(num(ref.rtindex) ?? 0) - 1];
  // a LATERAL read is one per row of what it follows: its rows are no bound by its table's
  if (!isNode(rte) || rte.lateral === "true") return null;
  if (num(rte.rtekind) === RTE_SUBQUERY && isNode(rte.subquery)) return plainTable(rte.subquery);
  if (num(rte.rtekind) !== RTE_CTE || (num(rte.ctelevelsup) ?? -1) !== 0) return null;
  const cte = list(query.cteList).find((c) => isNode(c) && c.ctename === rte.ctename);
  return isNode(cte) && isNode(cte.ctequery) ? plainTable(cte.ctequery) : null;
}

/** a query's FROM so far: the rtindexes it holds, and the tables each of whose rows it holds at most once, by rtindex */
interface Side { indexes: ReadonlySet<number>; once: ReadonlyMap<number, PlainTable> }

/**
 * THE FAN-OUT PROOF: whether every join of `query` equates a whole primary key of a table whose rows its side holds at
 * most once, so the FROM's rows are bounded by the sum of its tables'. A key must be unique IN ITS SIDE, not merely in
 * its table: `a JOIN b ON a.id = b.a_id JOIN c ON a.id = c.a_id` equates a's key twice, and an `a` of a thousand b's and
 * a thousand c's is a million rows, because the first join repeats `a`. So a join passes on, as held at most once, only
 * the tables of a side whose every row it matches at most once.
 *
 * Each key column in an equality, by its btree family's operator and under its collation, with a bare column of the
 * other side (`equated`); conjuncts of the join's top-level AND only, so an OR proves nothing and any other conjunct
 * only filters. INNER, LEFT, RIGHT and FULL alike: a side's unmatched row is one row, and its NULL-extended key
 * equals nothing. A comma's items are inner joins, left to right, on the WHERE's conjuncts. Everything else (a cross
 * join, a key in part, a partial or UNIQUE index, no key, a key equated with an expression or a constant, a FROM item
 * neither a base table nor a plain read of one, a JOIN's condition written in the WHERE) proves nothing.
 *
 * What it decides is what a LIMIT with no ORDER BY costs and whether its pages are stable, never the rows' values, so
 * a key stale in the catalog (the source's as of the start) costs time, not an answer.
 */
export function fanOutBounded(query: TreeNode, keys: PrimaryKeys): boolean {
  const jt = query.jointree;
  if (!isNode(jt)) return false;
  const rtable = list(query.rtable);
  const joined = (left: Side | null, right: Side | null, quals: readonly TreeNode[], indexes: ReadonlySet<number>): Side | null => {
    if (left === null || right === null) return null;
    const matchedOnce = (s: Side, by: Side): boolean => [...s.once].some(([rtindex, table]) => {
      const key = keys.get(table.relid);
      if (key === undefined) return false;
      const keyColumn = (attno: number): UniqueColumn | undefined => { const c = table.column(attno); return c === null ? undefined : key.get(c); };
      const met = new Set(quals.map((c) => { const at = equated(c, by.indexes, rtindex, keyColumn); return at === null ? null : table.column(at); }));
      return [...key.keys()].every((attno) => met.has(attno));
    });
    const leftMatchesOne = matchedOnce(right, left), rightMatchesOne = matchedOnce(left, right);
    if (!leftMatchesOne && !rightMatchesOne) return null;
    return { indexes, once: new Map([...(leftMatchesOne ? left.once : []), ...(rightMatchesOne ? right.once : [])]) };
  };
  const side = (n: TreeValue | undefined): Side | null => {
    if (isNode(n) && n._node === "JOINEXPR" && JOINS.has(num(n.jointype) ?? -1) && isNode(n.larg) && isNode(n.rarg)) return joined(side(n.larg), side(n.rarg), conjuncts(n.quals), indexesOf(n));
    const t = heldTable(query, rtable, n);
    const rtindex = isNode(n) ? num(n.rtindex) : null;
    return t === null || rtindex === null ? null : { indexes: new Set([rtindex]), once: new Map([[rtindex, t]]) };
  };
  const where = conjuncts(jt.quals);
  const items = list(jt.fromlist).map(side);
  if (items.length === 0) return false;
  return items.reduce((l, r) => joined(l, r, where, new Set([...l?.indexes ?? [], ...r?.indexes ?? []]))) !== null;
}

/** the base tables a query reads, at any depth (a wrapper's LIMIT stands over the join inside it) */
function tablesUnder(q: TreeNode): number[] {
  const out: number[] = [];
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isNode(v)) return;
    if (v._node === "RANGETBLENTRY" && num(v.rtekind) === RTE_RELATION) { const r = num(v.relid) ?? 0; if (r > 0) out.push(r); }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(q);
  return out;
}

/** The base tables `fanOutBounded` may be asked about: those under a query with a LIMIT and no sort, at least two of them
 *  (none: the plan asks the catalog nothing). */
export function fanOutTables(tree: TreeValue): number[] {
  const relids = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY" && isNode(v.limitCount) && list(v.sortClause).length === 0) {
      const tables = tablesUnder(v);
      if (tables.length >= 2) for (const r of tables) relids.add(r);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return [...relids].sort((a, b) => a - b);
}

/** a grouped expression's collation where it is a bare column (a VAR's, or a binary-compatible relabel's own) */
const collationOf = (v: TreeValue | undefined): number => !isNode(v) ? 0 : v._node === "RELABELTYPE" ? num(v.resultcollid) ?? 0 : num(v.varcollid) ?? 0;

/**
 * THE KEY-FIRST GROUPING PROOF (issue 134, step 6; src/duck/late.ts `keyFirst`): the base tables of `query` whose WHOLE
 * primary key it groups by, by rtindex, each with its key's columns by attno. A group then holds one row of that table
 * (or none, where an outer join supplied none), so every column of it is decided by the group, and the row can be read
 * by its row number after the limit. Each key column grouped bare (a binary-compatible relabel allowed), by its btree
 * family's equality and under its collation; a grouping set proves nothing (a key reads NULL in its total rows). The
 * key is the primary key, never a UNIQUE index (the module's doc): the copy is written by it. A key the copy holds
 * twice for a moment (a change applied in pieces) is grouped as written, never by a row number, so no group is split.
 * A SELECT DISTINCT that is a grouping on its list (`distinctGrouping`) is read as its GROUP BY: its distinctClause.
 */
export function keyGrouped(query: TreeNode, keys: PrimaryKeys): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (list(query.groupingSets).length > 0) return out;
  const clause = list(query.groupClause).length > 0 ? list(query.groupClause) : distinctGrouping(query) ? list(query.distinctClause) : [];
  const targets = list(query.targetList).filter(isNode);
  const rtable = list(query.rtable);
  const grouped = new Map<number, Set<number>>();
  // a grouped output is a VAR of the query's RTE_GROUP entry (Postgres 17+): the expression grouped is its groupexprs'
  const grouped1 = (e: TreeValue | undefined): TreeValue | undefined => {
    const v = ownVar(e), rte = v === null ? undefined : rtable[(num(v.varno) ?? 0) - 1];
    return isNode(rte) && num(rte.rtekind) === RTE_GROUP ? list(rte.groupexprs)[(num(v!.varattno) ?? 0) - 1] : e;
  };
  for (const g of clause) {
    if (!isNode(g)) continue;
    const t = targets.find((x) => x.ressortgroupref === g.tleSortGroupRef);
    const expr = grouped1(t?.expr);
    const v = ownVar(expr);
    const rtindex = num(v?.varno), attno = num(v?.varattno);
    if (v === null || rtindex === null || attno === null) continue;
    const table = baseTable(rtable, { _node: "RANGETBLREF", rtindex: String(rtindex) });
    const key = table === null ? undefined : keys.get(table.relid)?.get(attno);
    const collation = collationOf(expr);
    if (key === undefined || !key.equalities.has(num(g.eqop) ?? -1) || (collation !== 0 && collation !== key.collation)) continue;
    grouped.set(rtindex, new Set([...grouped.get(rtindex) ?? [], attno]));
  }
  for (const [rtindex, attnos] of grouped) {
    const table = baseTable(rtable, { _node: "RANGETBLREF", rtindex: String(rtindex) })!;
    const key = [...keys.get(table.relid)!.keys()];
    if (key.every((a) => attnos.has(a))) out.set(rtindex, key);
  }
  return out;
}

/**
 * Whether a query is a SELECT DISTINCT that is a grouping on its list (issue 134, step 6, task D): a DISTINCT, not a
 * DISTINCT ON (which keeps one row of each set, a different thing), with no GROUP BY beside it, and nothing in its list
 * computed before the DISTINCT that a grouping would compute after it: no aggregate (a DISTINCT over one row), window
 * function, set-returning function or subquery. Such a DISTINCT's rows are its GROUP BY's, its list's equalities the
 * same, so `keyGrouped` reads its distinctClause as it reads a groupClause.
 */
export function distinctGrouping(q: TreeNode): boolean {
  if (list(q.distinctClause).length === 0 || list(q.groupClause).length > 0 || q.hasDistinctOn !== "false") return false;
  return ["hasAggs", "hasWindowFuncs", "hasTargetSRFs", "hasSubLinks"].every((f) => q[f] === "false");
}

/** The base tables `keyGrouped` may be asked about: those of a query that groups, or is a DISTINCT, and has a LIMIT
 *  (none: the plan asks the catalog nothing) */
export function groupedLimitTables(tree: TreeValue): number[] {
  const relids = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY" && isNode(v.limitCount) && (list(v.groupClause).length > 0 || distinctGrouping(v))) {
      for (const e of list(v.rtable)) if (isNode(e) && num(e.rtekind) === RTE_RELATION) { const r = num(e.relid) ?? 0; if (r > 0) relids.add(r); }
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return [...relids].sort((a, b) => a - b);
}

/** Whether this AGGREF of `query` is a count(DISTINCT x) whose DISTINCT changes nothing (the module's doc). */
function distinctOfKey(query: TreeNode, a: TreeNode, unique: UniqueColumns): boolean {
  if (!isDistinctCount(a) || (num(a.agglevelsup) ?? 0) !== 0 || a.aggkind !== "n" || a.aggstar === "true" || list(a.aggorder).length > 0) return false;
  const args = list(a.args);
  const arg = args.length === 1 && isNode(args[0]) && args[0]._node === "TARGETENTRY" ? args[0].expr : undefined;
  // the column itself: a cast or an expression of it need not be unique (`id / 2`, `id::text` under another equality)
  if (!isNode(arg) || arg._node !== "VAR" || (num(arg.varlevelsup) ?? 0) !== 0) return false;
  const varno = num(arg.varno), attno = num(arg.varattno);
  if (varno === null || attno === null || attno < 1) return false;
  const table = baseTable(list(query.rtable), { _node: "RANGETBLREF", rtindex: String(varno) });
  if (table === null) return false;
  const u = unique.get(columnKey(table.relid, attno));
  const distinct = list(a.aggdistinct)[0];
  const collation = num(a.inputcollid) ?? 0;
  if (u === undefined || !isNode(distinct) || !u.equalities.has(num(distinct.eqop) ?? -1) || (collation !== 0 && collation !== u.collation)) return false;
  return notMultiplied(query, varno, unique);
}

/**
 * THE DECISION: the offsets (into the analysed text) of every count(DISTINCT x) of the statement whose DISTINCT may be
 * dropped — each AGGREF decided in the query it belongs to (an outer query's aggregate inside a subquery,
 * agglevelsup > 0, is left as it is).
 */
export function distinctKeyCounts(tree: TreeValue, unique: UniqueColumns): Set<number> {
  const out = new Set<number>();
  if (unique.size === 0) return out;
  const visit = (v: TreeValue | undefined, query: TreeNode | null): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x, query); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY") { for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x, v); return; }
    if (query !== null && v._node === "AGGREF" && distinctOfKey(query, v, unique)) {
      const at = num(v.location);
      if (at !== null && at >= 0) out.add(at);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x, query);
  };
  visit(tree, null);
  return out;
}
